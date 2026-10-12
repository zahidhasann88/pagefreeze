import { FixtureServer } from '../fixtures/fixtureServer.js';
import { start, type StartedApp } from '../index.js';

/**
 * Boots a deterministic stack for the Playwright end-to-end test:
 *
 *   - the fixture website on a fixed port, mutating on demand rather than on a timer
 *   - the Pagefreeze API + UI on a fixed port, with the fixture host allowlisted
 *
 * Both ports are fixed so the Playwright config can point at them without parsing output.
 * The script prints `E2E_READY` once /readyz passes, which is what the config waits for.
 */

const FIXTURE_PORT = Number.parseInt(process.env['E2E_FIXTURE_PORT'] ?? '8091', 10);
const APP_PORT = Number.parseInt(process.env['E2E_PORT'] ?? '8092', 10);
const DATABASE_URL =
  process.env['DATABASE_URL_TEST'] ??
  'postgres://pagefreeze:pagefreeze@127.0.0.1:5432/pagefreeze_test';
const ADMIN_PASSWORD = process.env['E2E_PASSWORD'] ?? 'e2e-password-123';
const DATA_DIR = process.env['E2E_DATA_DIR'] ?? '/tmp/pagefreeze-e2e-data';

async function main(): Promise<void> {
  const fixture = new FixtureServer({ port: FIXTURE_PORT });
  const { baseUrl: fixtureUrl } = await fixture.start();

  let started: StartedApp | null = null;
  try {
    started = await start({
      env: {
        NODE_ENV: 'test',
        DATABASE_URL,
        PORT: String(APP_PORT),
        HOST: '127.0.0.1',
        PAGEFREEZE_MODE: 'all',
        PAGEFREEZE_ADMIN_PASSWORD: ADMIN_PASSWORD,
        PAGEFREEZE_ADMIN_USERNAME: 'admin',
        PAGEFREEZE_SECRET_KEY: Buffer.alloc(32, 11).toString('base64'),
        PAGEFREEZE_DATA_DIR: DATA_DIR,
        LOG_LEVEL: process.env['E2E_LOG_LEVEL'] ?? 'warn',
        PAGEFREEZE_ALLOWED_HOSTS: `127.0.0.1:${FIXTURE_PORT}`,
        PAGEFREEZE_MIN_INTERVAL_MINUTES: '0',
        PAGEFREEZE_CAPTURE_CONCURRENCY: '1',
        PAGEFREEZE_CAPTURE_RETRIES: '0',
        PAGEFREEZE_DIFF_WORKER: 'false',
        PAGEFREEZE_BASE_URL: `http://127.0.0.1:${APP_PORT}`,
      },
    });
  } catch (error) {
    await fixture.stop();
    throw error;
  }

  // Wait until the app really answers, so Playwright does not race the first navigation.
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${APP_PORT}/readyz`);
      if (response.ok) break;
    } catch {
      // not up yet
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }

  process.stdout.write(
    JSON.stringify({
      marker: 'E2E_READY',
      appUrl: `http://127.0.0.1:${APP_PORT}`,
      fixtureUrl,
      adminPassword: ADMIN_PASSWORD,
    }) + '\n',
  );
  process.stdout.write('E2E_READY\n');

  const shutdown = async (): Promise<void> => {
    await started?.close();
    await fixture.stop();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown());
  process.on('SIGTERM', () => void shutdown());
}

main().catch((error: unknown) => {
  process.stderr.write(`e2e server failed: ${(error as Error).stack ?? error}\n`);
  process.exit(1);
});
