import type { Logger } from 'pino';
import type { AppConfig } from './config.js';
import { createDatabase, type Database } from './db/pool.js';
import { LocalStorageProvider } from './storage/local.js';
import { BrowserPool } from './capture/browserPool.js';
import { SsrfGuard } from './capture/ssrf.js';
import { createDiffEngine, type DiffEngine } from './diff/engine.js';
import { StaticKeyProvider, type KeyProvider } from './crypto/secrets.js';
import { hashPassword } from './crypto/password.js';
import { globalRegistry, type MetricsRegistry } from './metrics/registry.js';
import { systemClock, type Clock } from './util/clock.js';
import { PgBossQueue } from './jobs/pgBossQueue.js';
import { Scheduler } from './jobs/scheduler.js';
import { runRetention } from './jobs/retention.js';
import { executeCapture, type CaptureJobDeps } from './jobs/captureJob.js';
import { NotificationService } from './notify/notifier.js';
import { createHttpClient } from './notify/httpClient.js';
import { createMailer } from './notify/mailer.js';
import { previewCapture } from './capture/preview.js';
import type { AppDeps } from './api/deps.js';
import type { AuthOptions } from './api/auth.js';

export interface AppContext {
  config: AppConfig;
  logger: Logger;
  deps: AppDeps;
  db: Database;
  scheduler: Scheduler | null;
  browserPool: BrowserPool | null;
  diffEngine: DiffEngine;
  metrics: MetricsRegistry;
  /** Stop background work, close the browser, the queue and the pool. */
  shutdown(): Promise<void>;
}

export interface CreateContextOptions {
  config: AppConfig;
  logger: Logger;
  /** Injected by tests. */
  db?: Database;
  clock?: Clock;
  metrics?: MetricsRegistry;
  /** Skip starting pg-boss (API-only mode, or tests that drive captures directly). */
  disableScheduler?: boolean;
  /** Skip launching Chromium (tests that only exercise the HTTP layer). */
  disableBrowser?: boolean;
  keyProvider?: KeyProvider;
  diffEngine?: DiffEngine;
  storage?: LocalStorageProvider;
}

/**
 * Wire the whole application together.
 *
 * Everything is constructed against an interface (Database, StorageProvider, BrowserPool,
 * DiffEngine, Notifier, Clock) so a test can substitute any one of them without touching
 * the rest.
 */
export async function createContext(options: CreateContextOptions): Promise<AppContext> {
  const config = options.config;
  const logger = options.logger;
  const clock = options.clock ?? systemClock;
  const metrics = options.metrics ?? globalRegistry;

  const db =
    options.db ??
    createDatabase({
      connectionString: config.databaseUrl,
      max: config.databasePoolMax,
      ssl: config.databaseSsl,
    });

  const storage = options.storage ?? new LocalStorageProvider(config.dataDir);

  const keyProvider = options.keyProvider ?? new StaticKeyProvider(config.secretKey);

  const guard = new SsrfGuard({
    allowPrivateTargets: config.allowPrivateTargets,
    allowedHosts: config.allowedHosts,
  });

  const chromiumArgs = config.chromiumArgs
    .split(/\s+/)
    .map((arg) => arg.trim())
    .filter((arg) => arg.length > 0);

  const browserPool = options.disableBrowser
    ? null
    : new BrowserPool({
        concurrency: config.captureConcurrency,
        launchOptions: {
          // Chromium's own sandbox needs user namespaces; in an unprivileged container
          // that is often unavailable, hence the escape hatch.
          chromiumSandbox: !config.disableChromiumSandbox,
          args: [
            '--no-first-run',
            '--no-default-browser-check',
            '--disable-dev-shm-usage',
            '--disable-gpu',
            '--hide-scrollbars',
            '--mute-audio',
            '--force-color-profile=srgb',
            '--font-render-hinting=none',
            '--disable-background-timer-throttling',
            ...chromiumArgs,
          ],
        },
        logger,
      });

  const diffEngine = options.diffEngine ?? createDiffEngine(config.diffUseWorker);

  const mailer = createMailer({
    host: config.smtpHost,
    port: config.smtpPort,
    secure: config.smtpSecure,
    user: config.smtpUser,
    pass: config.smtpPass,
    from: config.smtpFrom,
  });

  const notifier = new NotificationService({
    guard,
    http: createHttpClient(guard),
    mailer,
    userAgent: config.userAgent,
    timeoutMs: config.webhookTimeoutMs,
    maxRedirects: config.webhookMaxRedirects,
    logger,
  });

  const adminPasswordHash = await hashPassword(config.adminPassword);

  const auth: AuthOptions = {
    db,
    adminUsername: config.adminUsername,
    adminPasswordHash,
    secureCookies: config.secureCookies,
    sessionTtlHours: config.sessionTtlHours,
    baseUrl: config.baseUrl,
  };

  const startedAt = clock.now();

  const captureJobDeps: CaptureJobDeps = {
    db,
    storage,
    diffEngine,
    notifier,
    clock,
    keyProvider,
    capture: {
      pool: browserPool as unknown as BrowserPool,
      guard,
      clock,
      defaultUserAgent: config.userAgent,
      retries: config.captureRetries,
      retryBaseMs: config.captureRetryBaseMs,
      timeoutMs: config.captureTimeoutMs,
      blockMedia: config.blockMedia,
      blockThirdParty: config.blockThirdParty,
      maxScreenshotBytes: config.maxScreenshotBytes,
      logger,
    },
    logger,
    diffOptions: {
      pixelThreshold: config.diffPixelThreshold,
      includeAA: false,
      regionPadding: config.diffRegionPadding,
      regionMinArea: config.diffRegionMinArea,
      computeText: true,
      computeHtml: true,
      computeVisual: true,
      produceDiffImage: true,
    },
    failureNotifyThreshold: config.failureNotifyThreshold,
    buildLink: (path) => {
      const base = config.baseUrl.replace(/\/+$/, '');
      return base ? `${base}${path}` : null;
    },
    metrics: {
      captureTotal: (status) => metrics.capturesTotal.inc({ status }),
      captureDuration: (seconds) => metrics.captureDuration.observe(seconds, { status: 'total' }),
      changesTotal: (significant) =>
        metrics.changesTotal.inc({ significant: significant ? 'true' : 'false' }),
      notificationsTotal: (status) => metrics.notificationsTotal.inc({ status }),
    },
  };

  // ---------------------------------------------------------------------------
  // Scheduler. Only the `worker` and `all` modes own schedules: two API replicas
  // registering the same cron would be harmless (pg-boss de-duplicates) but wasteful.
  // ---------------------------------------------------------------------------
  const shouldSchedule =
    !options.disableScheduler && (config.mode === 'all' || config.mode === 'worker');

  let scheduler: Scheduler | null = null;

  if (shouldSchedule) {
    const queue = new PgBossQueue({
      connectionString: config.databaseUrl,
      logger,
    });

    scheduler = new Scheduler({
      db,
      queue,
      logger,
      pollingIntervalSeconds: 5,
      singletonSeconds: Math.max(60, config.minIntervalMinutes * 60),
      retentionCron: '17 * * * *',
      retentionIntervalHours: config.retentionIntervalHours,
      onCapture: async (monitorId) => {
        await executeCapture(monitorId, captureJobDeps);
      },
      onRetention: async () => {
        await runRetention({
          db,
          storage,
          clock,
          logger,
          defaultRetentionDays: config.retentionDays,
        });
      },
    });
  }

  const deps: AppDeps = {
    config,
    db,
    storage,
    localStorage: storage instanceof LocalStorageProvider ? storage : null,
    browserPool,
    guard,
    diffEngine,
    keyProvider,
    notifier,
    metrics,
    clock,
    logger,
    auth,
    scheduler,
    startedAt,
    executeCapture: async (monitorId) => {
      const outcome = await executeCapture(monitorId, captureJobDeps);
      const { attempt: _attempt, ...rest } = outcome;
      return rest;
    },
    previewCapture: async (input) => {
      if (!browserPool) {
        return {
          ok: false,
          error: 'Captures are disabled in this process (no browser available)',
          title: null,
          finalUrl: null,
          httpStatus: null,
          loadDurationMs: null,
          width: null,
          height: null,
          bytes: 0,
          screenshotBase64: null,
          textPreview: '',
          blockedRequests: [],
        };
      }
      return previewCapture(input, {
        pool: browserPool,
        guard,
        defaultUserAgent: config.userAgent,
        logger,
      });
    },
  };

  const shutdown = async (): Promise<void> => {
    const steps: Array<[string, () => Promise<unknown>]> = [
      [
        'scheduler',
        () => scheduler?.stop({ timeoutMs: config.shutdownGraceMs }) ?? Promise.resolve(),
      ],
      ['diff-engine', () => diffEngine.close()],
      ['browser', () => browserPool?.close() ?? Promise.resolve()],
      ['storage', () => storage.close()],
      ['database', () => db.end()],
    ];

    for (const [name, step] of steps) {
      try {
        await step();
      } catch (error) {
        logger.warn({ step: name, error: (error as Error).message }, 'shutdown step failed');
      }
    }
  };

  return { config, logger, deps, db, scheduler, browserPool, diffEngine, metrics, shutdown };
}
