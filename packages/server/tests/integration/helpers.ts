import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import pg from 'pg';
import { createLogger } from '../../src/logger.js';
import { loadConfig } from '../../src/config.js';
import { createContext, type AppContext } from '../../src/context.js';
import { buildApp, type BuildAppOptions } from '../../src/api/app.js';
import { runMigrations } from '../../src/scripts/migrate.js';
import { FixtureServer } from '../../src/fixtures/fixtureServer.js';
import { ApiClient } from '../../src/scripts/apiClient.js';

/**
 * Integration harness.
 *
 * These tests use a real PostgreSQL and a real Chromium against a local fixture site, so
 * they exercise the paths that matter most and cannot be faked meaningfully: the SSRF proxy
 * in front of a live browser, pixel diffing of actual screenshots, and the SQL.
 *
 * When PostgreSQL is unavailable the suite skips itself with an explanation rather than
 * failing, so `pnpm test` is usable on a laptop without a database. Set DATABASE_URL_TEST
 * to point at a scratch database; it is wiped and re-migrated on every run.
 */

export const TEST_DATABASE_URL =
  process.env['DATABASE_URL_TEST'] ??
  'postgres://pagefreeze:pagefreeze@127.0.0.1:5432/pagefreeze_test';

export const TEST_PASSWORD = 'integration-test-password';

export async function databaseAvailable(): Promise<{ ok: boolean; reason?: string }> {
  const client = new pg.Client({
    connectionString: TEST_DATABASE_URL,
    connectionTimeoutMillis: 4000,
  });
  try {
    await client.connect();
    await client.query('SELECT 1');
    return { ok: true };
  } catch (error) {
    return {
      ok: false,
      reason:
        `PostgreSQL is not reachable at ${TEST_DATABASE_URL.replace(/:[^:@/]*@/, ':***@')} ` +
        `(${(error as Error).message}). Start it and re-run, or set DATABASE_URL_TEST.`,
    };
  } finally {
    await client.end().catch(() => undefined);
  }
}

/** Wipe the schema and re-run every migration, so each file starts from a known state. */
export async function resetDatabase(): Promise<void> {
  const client = new pg.Client({ connectionString: TEST_DATABASE_URL });
  await client.connect();
  try {
    await client.query('DROP SCHEMA public CASCADE');
    await client.query('CREATE SCHEMA public');
    await client.query('DROP SCHEMA IF EXISTS pgboss CASCADE');
  } finally {
    await client.end();
  }
  await runMigrations({ databaseUrl: TEST_DATABASE_URL, log: () => undefined });
}

export function newClient(): pg.Client {
  return new pg.Client({ connectionString: TEST_DATABASE_URL });
}

export interface TestApp {
  context: AppContext;
  app: BuildAppOptions extends never ? never : Awaited<ReturnType<typeof buildApp>>;
  client: ApiClient;
  baseUrl: string;
  /** Log in and return the CSRF token; throws when login fails. */
  login(): Promise<string>;
  close(): Promise<void>;
}

export interface TestAppOptions {
  /** Skip launching Chromium (API-only tests run much faster). */
  disableBrowser?: boolean;
  disableScheduler?: boolean;
  fixturePort?: number;
  env?: Record<string, string>;
  port?: number;
}

let nextPort = 8300;

/**
 * Boot the whole application against the test database, plus a fixture website and a
 * logged-in API client.
 */
export async function startTestApp(options: TestAppOptions = {}): Promise<TestApp> {
  const port = options.port ?? nextPort++;
  const dataDir = mkdtempSync(join(tmpdir(), 'pagefreeze-it-'));

  let fixture: FixtureServer | null = null;
  let fixtureUrl = 'http://127.0.0.1:1';
  let allowedHosts = '';

  if (!options.disableBrowser) {
    fixture = new FixtureServer();
    const started = await fixture.start();
    fixtureUrl = started.baseUrl;
    allowedHosts = `127.0.0.1:${started.port}`;
  }

  const config = loadConfig({
    overrides: {
      NODE_ENV: 'test',
      DATABASE_URL: TEST_DATABASE_URL,
      PORT: String(port),
      HOST: '127.0.0.1',
      PAGEFREEZE_MODE: 'all',
      PAGEFREEZE_ADMIN_PASSWORD: TEST_PASSWORD,
      PAGEFREEZE_ADMIN_USERNAME: 'admin',
      PAGEFREEZE_SECRET_KEY: randomBytes(32).toString('base64'),
      PAGEFREEZE_DATA_DIR: dataDir,
      LOG_LEVEL: 'silent',
      PAGEFREEZE_ALLOWED_HOSTS: allowedHosts,
      PAGEFREEZE_MIN_INTERVAL_MINUTES: '0',
      PAGEFREEZE_CAPTURE_CONCURRENCY: '1',
      PAGEFREEZE_CAPTURE_RETRIES: '0',
      PAGEFREEZE_CAPTURE_TIMEOUT_MS: '45000',
      PAGEFREEZE_BASE_URL: `http://127.0.0.1:${port}`,
      PAGEFREEZE_SECURE_COOKIES: 'false',
      PAGEFREEZE_DIFF_WORKER: 'false',
      ...(options.env ?? {}),
    },
  });

  const logger = createLogger({ level: 'silent' });

  const context = await createContext({
    config,
    logger,
    ...(options.disableBrowser ? { disableBrowser: true } : {}),
    ...(options.disableScheduler === false ? {} : { disableScheduler: true }),
  });

  const app = await buildApp({ deps: context.deps, logger, webDist: null });
  const baseUrl = await app.listen({ host: '127.0.0.1', port });

  const client = new ApiClient(baseUrl);

  const handle: TestApp = {
    context,
    app,
    client,
    baseUrl,
    async login() {
      const result = await client.post<{ csrfToken: string | null }>('/api/v1/auth/login', {
        username: 'admin',
        password: TEST_PASSWORD,
      });
      if (result.status !== 200) {
        throw new Error(`test login failed (${result.status}): ${result.text}`);
      }
      return client.token ?? '';
    },
    async close() {
      await app.close().catch(() => undefined);
      await context.shutdown().catch(() => undefined);
      if (fixture) await fixture.stop().catch(() => undefined);
      rmSync(dataDir, { recursive: true, force: true });
    },
  };

  // Expose the fixture through the handle so tests can mutate the page between captures.
  (handle as unknown as { fixture: FixtureServer | null }).fixture = fixture;
  (handle as unknown as { fixtureUrl: string }).fixtureUrl = fixtureUrl;
  (handle as unknown as { dataDir: string }).dataDir = dataDir;

  return handle;
}

export function fixtureOf(handle: TestApp): FixtureServer {
  const fixture = (handle as unknown as { fixture: FixtureServer | null }).fixture;
  if (!fixture) throw new Error('this test app was started without a fixture site');
  return fixture;
}

export function fixtureUrlOf(handle: TestApp): string {
  return (handle as unknown as { fixtureUrl: string }).fixtureUrl;
}

export function dataDirOf(handle: TestApp): string {
  return (handle as unknown as { dataDir: string }).dataDir;
}

/** Poll until `predicate` holds, or fail with the last observed value. */
export async function waitFor<T>(
  fn: () => Promise<T>,
  predicate: (value: T) => boolean,
  options: { timeoutMs?: number; intervalMs?: number; label?: string } = {},
): Promise<T> {
  const timeoutMs = options.timeoutMs ?? 60_000;
  const intervalMs = options.intervalMs ?? 250;
  const deadline = Date.now() + timeoutMs;
  let last: T | undefined;

  while (Date.now() < deadline) {
    last = await fn();
    if (predicate(last)) return last;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }

  throw new Error(
    `timed out after ${timeoutMs}ms waiting for ${options.label ?? 'condition'}; last value: ${JSON.stringify(last)?.slice(0, 400)}`,
  );
}
