import type { AppInstance } from '../types.js';
import { VERSION } from '@pagefreeze/shared';
import type { AppDeps } from '../deps.js';
import * as queries from '../../db/queries.js';
import { requireAuthenticated } from '../auth.js';

/**
 * Operational endpoints.
 *
 * `/healthz` is a liveness probe: it answers from the process alone, so a database outage
 * does not cause an orchestrator to restart a perfectly healthy container.
 * `/readyz` is a readiness probe: it verifies the dependencies the app cannot work
 * without, and is what a load balancer or `docker compose` healthcheck should use.
 */
export async function registerSystemRoutes(app: AppInstance, deps: AppDeps): Promise<void> {
  app.get('/healthz', async () => {
    return {
      status: 'ok',
      version: VERSION,
      uptimeSeconds: Math.round((Date.now() - deps.startedAt.getTime()) / 1000),
    };
  });

  app.get('/readyz', async (_request, reply) => {
    const checks: Record<string, { ok: boolean; detail?: string; durationMs: number }> = {};

    const dbStart = Date.now();
    try {
      await deps.db.ping();
      checks['database'] = { ok: true, durationMs: Date.now() - dbStart };
    } catch (error) {
      checks['database'] = {
        ok: false,
        detail: (error as Error).message,
        durationMs: Date.now() - dbStart,
      };
    }

    const storageStart = Date.now();
    try {
      // A write plus a delete proves the data directory is usable, not merely present.
      const probeKey = `.readyz/${Date.now()}`;
      await deps.storage.put(probeKey, 'ok');
      await deps.storage.delete(probeKey);
      checks['storage'] = { ok: true, durationMs: Date.now() - storageStart };
    } catch (error) {
      checks['storage'] = {
        ok: false,
        detail: (error as Error).message,
        durationMs: Date.now() - storageStart,
      };
    }

    // Only meaningful in modes that capture. An API-only process reports it as skipped
    // rather than failing, otherwise readiness would depend on a browser it never uses.
    if (deps.browserPool) {
      const browserStart = Date.now();
      const ok = await deps.browserPool.healthCheck();
      checks['browser'] = {
        ok,
        ...(ok ? {} : { detail: 'chromium could not be launched' }),
        durationMs: Date.now() - browserStart,
      };
    } else {
      checks['browser'] = { ok: true, detail: 'skipped (api-only mode)', durationMs: 0 };
    }

    const ready = Object.values(checks).every((check) => check.ok);
    void reply.status(ready ? 200 : 503).send({ status: ready ? 'ready' : 'not-ready', checks });
  });

  app.get('/metrics', async (_request, reply) => {
    // Refresh the gauges that describe stored state on each scrape. They are cheap
    // (three COUNTs) and scraping is infrequent relative to their cost.
    try {
      const stats = await queries.getStorageStats(deps.db);
      deps.metrics.snapshotsTotal.set(stats.snapshots);
      deps.metrics.monitorsTotal.set(stats.monitors, { state: 'all' });

      const depth = await deps.scheduler?.queueDepth();
      if (depth !== undefined) deps.metrics.queueDepth.set(depth, { queue: 'capture' });
      if (deps.browserPool) {
        deps.metrics.capturesInFlight.set(deps.browserPool.activeCount);
      }
      const bytes = await deps.storage.sizeOf('monitors/');
      deps.metrics.storageBytes.set(bytes);
    } catch (error) {
      deps.logger.warn({ error: (error as Error).message }, 'could not refresh metrics');
    }

    deps.metrics.processUptime.set((Date.now() - deps.startedAt.getTime()) / 1000);

    const { body, contentType } = deps.metrics.expose();
    void reply.header('content-type', contentType).send(body);
  });

  /** Read-only system information for the Settings screen. */
  app.get('/system/info', { preHandler: requireAuthenticated(deps.auth) }, async () => {
    const [database, stats] = await Promise.all([
      queries.getDatabaseInfo(deps.db).catch(() => ({ version: null, sizeBytes: null })),
      queries.getStorageStats(deps.db).catch(() => ({ monitors: 0, snapshots: 0, changes: 0 })),
    ]);

    const bytes = await deps.storage.sizeOf('monitors/').catch(() => 0);

    return {
      version: VERSION,
      node: process.version,
      platform: `${process.platform}/${process.arch}`,
      mode: deps.config.mode,
      uptimeSeconds: Math.round((Date.now() - deps.startedAt.getTime()) / 1000),
      database: { version: database.version, sizeBytes: database.sizeBytes },
      storage: { driver: deps.storage.name, snapshots: stats.snapshots, bytes },
      capture: {
        concurrency: deps.config.captureConcurrency,
        timeoutMs: deps.config.captureTimeoutMs,
        retries: deps.config.captureRetries,
        browserRunning: deps.browserPool?.isRunning() ?? false,
      },
      retentionDays: deps.config.retentionDays,
      minIntervalMinutes: deps.config.minIntervalMinutes,
      ssrf: {
        allowPrivateTargets: deps.config.allowPrivateTargets,
        allowedHosts: deps.config.allowedHosts,
      },
      counts: stats,
      scheduler: {
        enabled: deps.scheduler !== null,
        queueDepth: (await deps.scheduler?.queueDepth().catch(() => 0)) ?? 0,
      },
    };
  });
}
