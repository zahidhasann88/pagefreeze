import { loadConfig } from '../config.js';
import { createLogger } from '../logger.js';
import { createDatabase } from '../db/pool.js';
import * as queries from '../db/queries.js';
import { encryptJson, randomTokenUrl, sha256Hex } from '../crypto/secrets.js';
import { StaticKeyProvider } from '../crypto/secrets.js';
import { scheduleToCron } from '@pagefreeze/shared';

/**
 * `pnpm seed`
 *
 * Writes a small, self-consistent set of rows straight into the database: two monitors, a
 * webhook channel and an API token. It does not capture anything - use `pnpm demo` for a
 * running system with real snapshots.
 *
 * Useful for frontend work and for checking that a fresh deployment comes up with
 * something on screen.
 */

export interface SeedOptions {
  databaseUrl?: string;
  baseUrl?: string;
  log?: (message: string) => void;
}

export async function seed(options: SeedOptions = {}): Promise<void> {
  const log = options.log ?? ((message: string) => process.stdout.write(`${message}\n`));
  const config = loadConfig();
  const logger = createLogger({ level: 'silent' });
  void logger;

  const db = createDatabase({ connectionString: options.databaseUrl ?? config.databaseUrl });
  const keyProvider = new StaticKeyProvider(config.secretKey);

  try {
    const baseUrl = options.baseUrl ?? 'https://example.com';

    const existing = await queries.listMonitors(db, { limit: 100 });
    if (existing.data.length > 0) {
      log(`database already has ${existing.data.length} monitor(s); leaving them alone`);
    }

    const channel = await queries.createChannel(db, {
      name: 'Ops webhook (demo)',
      type: 'webhook',
      enabled: false,
      config: { url: `${baseUrl}/webhook`, hasSecret: true },
      configEnc: encryptJson(
        { url: `${baseUrl}/webhook`, secret: randomTokenUrl(16) },
        keyProvider,
      ),
    });
    log(`created notification channel ${channel.name} (${channel.id})`);

    const monitors = [
      {
        name: 'Example pricing page',
        url: `${baseUrl}/pricing`,
        scheduleKind: 'preset' as const,
        scheduleValue: '1h',
        tags: ['seed', 'pricing'],
        ignoreSelectors: ['.cookie-banner', '.ad-slot'],
        changeThreshold: 0.5,
      },
      {
        name: 'Example terms of service',
        url: `${baseUrl}/terms`,
        scheduleKind: 'cron' as const,
        scheduleValue: '0 6 * * *',
        tags: ['seed', 'legal'],
        changeThreshold: 0.1,
      },
    ];

    for (const monitor of monitors) {
      const created = await queries.createMonitor(db, {
        name: monitor.name,
        url: monitor.url,
        enabled: true,
        scheduleKind: monitor.scheduleKind,
        scheduleValue: monitor.scheduleValue,
        devicePreset: 'desktop',
        viewportWidth: 1280,
        viewportHeight: 800,
        fullPage: true,
        waitStrategy: 'load',
        waitSelector: null,
        extraDelayMs: 0,
        captureSelector: null,
        ignoreSelectors: monitor.ignoreSelectors ?? [],
        userAgent: null,
        changeThreshold: monitor.changeThreshold,
        detectText: true,
        detectHtml: true,
        retentionDays: null,
        tags: monitor.tags,
        headersEnc: null,
        cookiesEnc: null,
        headerNames: [],
        cookieNames: [],
      });
      await queries.setMonitorChannels(db, created.id, [channel.id]);
      log(
        `created monitor ${created.name} (${created.id}) cron=${scheduleToCron(monitor.scheduleKind, monitor.scheduleValue)}`,
      );
    }

    const token = `pfz_seed_${randomTokenUrl(24)}`;
    await queries.createApiToken(db, {
      name: 'seed token',
      prefix: token.slice(0, 12),
      tokenHash: sha256Hex(token),
      expiresAt: null,
    });
    log('');
    log('seed API token (shown once):');
    log(`  ${token}`);
    log('');
    log('usage:');
    log(`  curl -H "Authorization: Bearer ${token}" ${'${PAGEFREEZE_URL}'}/api/v1/monitors`);
  } finally {
    await db.end();
  }
}

const invokedDirectly =
  process.argv[1]?.endsWith('seed.ts') || process.argv[1]?.endsWith('seed.js');

if (invokedDirectly) {
  seed()
    .then(() => process.exit(0))
    .catch((error: unknown) => {
      process.stderr.write(`seed failed: ${(error as Error).message}\n`);
      process.exit(1);
    });
}
