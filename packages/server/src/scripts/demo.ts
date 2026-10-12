import { FixtureServer } from '../fixtures/fixtureServer.js';
import { start, type StartedApp } from '../index.js';
import { ApiClient } from './apiClient.js';

/**
 * `pnpm demo`
 *
 * Boots the whole product against a fixture website that mutates on a timer, creates two
 * monitors, and drives real captures so a new user sees working diffs within a minute of
 * cloning the repository.
 *
 * What it starts:
 *   - the fixture site (a fake "Acme Cloud pricing" page) on an ephemeral loopback port
 *   - the Pagefreeze API + scheduler + capture worker in this process
 *
 * Because the fixture is on loopback, the demo sets PAGEFREEZE_ALLOWED_HOSTS for exactly
 * that host:port. That is the documented escape hatch for lab setups; it does not disable
 * the SSRF guard, it exempts one host, and every redirect away from it is still checked.
 */

export interface DemoOptions {
  databaseUrl?: string;
  port?: number;
  adminPassword?: string;
  /** How often the fixture page changes. */
  mutateEveryMs?: number;
  /** Keep the process alive serving the UI. */
  keepRunning?: boolean;
  log?: (message: string) => void;
}

export interface DemoHandle {
  baseUrl: string;
  fixtureUrl: string;
  adminPassword: string;
  monitors: Array<{ id: string; name: string }>;
  stop(): Promise<void>;
}

const DEMO_PASSWORD = 'pagefreeze-demo';

export async function runDemo(options: DemoOptions = {}): Promise<DemoHandle> {
  const log = options.log ?? ((message: string) => process.stdout.write(`${message}\n`));
  const port = options.port ?? Number(process.env['PORT'] ?? 8080);
  const databaseUrl =
    options.databaseUrl ??
    process.env['DATABASE_URL'] ??
    'postgres://pagefreeze:pagefreeze@127.0.0.1:5432/pagefreeze';
  const adminPassword = options.adminPassword ?? DEMO_PASSWORD;

  log('starting fixture site…');
  const fixture = new FixtureServer();
  const { baseUrl: fixtureUrl, port: fixturePort } = await fixture.start();
  fixture.startAutoChange(options.mutateEveryMs ?? 5000);
  log(
    `  fixture site: ${fixtureUrl}/pricing (mutates every ${Math.round((options.mutateEveryMs ?? 5000) / 1000)}s)`,
  );

  log('starting pagefreeze…');
  let started: StartedApp;
  try {
    started = await start({
      env: {
        NODE_ENV: process.env['NODE_ENV'] ?? 'development',
        DATABASE_URL: databaseUrl,
        PORT: String(port),
        HOST: '0.0.0.0',
        PAGEFREEZE_MODE: 'all',
        PAGEFREEZE_ADMIN_PASSWORD: adminPassword,
        PAGEFREEZE_ADMIN_USERNAME: 'admin',
        PAGEFREEZE_ALLOWED_HOSTS: `127.0.0.1:${fixturePort}`,
        PAGEFREEZE_CAPTURE_CONCURRENCY: process.env['PAGEFREEZE_CAPTURE_CONCURRENCY'] ?? '2',
        PAGEFREEZE_MIN_INTERVAL_MINUTES: '1',
        PAGEFREEZE_DATA_DIR: process.env['PAGEFREEZE_DATA_DIR'] ?? './data/demo',
        LOG_LEVEL: process.env['LOG_LEVEL'] ?? 'info',
        PAGEFREEZE_BASE_URL: `http://127.0.0.1:${port}`,
        ...(process.env['PAGEFREEZE_SECRET_KEY']
          ? { PAGEFREEZE_SECRET_KEY: process.env['PAGEFREEZE_SECRET_KEY'] }
          : {}),
      },
    });
  } catch (error) {
    await fixture.stop();
    throw error;
  }

  const baseUrl = started.url ?? `http://127.0.0.1:${port}`;
  const client = new ApiClient(baseUrl);

  log('logging in and seeding monitors…');
  const login = await client.post('/api/v1/auth/login', {
    username: 'admin',
    password: adminPassword,
  });
  if (login.status !== 200) {
    await started.close();
    await fixture.stop();
    throw new Error(`demo login failed with status ${login.status}: ${login.text}`);
  }

  const monitors = await seedDemoMonitors(client, fixtureUrl);

  log('');
  log('────────────────────────────────────────────────────────────');
  log(`  Pagefreeze demo is running`);
  log('');
  log(`  UI:        ${baseUrl}`);
  log(`  Login:     admin / ${adminPassword}`);
  log(`  Fixture:   ${fixtureUrl}/pricing`);
  log(`  Monitors:  ${monitors.map((m) => m.name).join(', ')}`);
  log('');
  log('  The fixture page changes on a timer. Capture the same monitor');
  log('  twice (or wait for the schedule) and open the change viewer to');
  log('  see the visual, text and HTML diffs.');
  log('');
  log('  Stop with Ctrl-C.');
  log('────────────────────────────────────────────────────────────');
  log('');

  const stop = async (): Promise<void> => {
    await started.close();
    await fixture.stop();
  };

  if (options.keepRunning === false) {
    return { baseUrl, fixtureUrl, adminPassword, monitors, stop };
  }

  return { baseUrl, fixtureUrl, adminPassword, monitors, stop };
}

interface MonitorResponse {
  id: string;
  name: string;
}

/**
 * Create the two demo monitors (idempotently) and run a first capture for each so the
 * dashboard is not empty when the user opens it.
 */
export async function seedDemoMonitors(
  client: ApiClient,
  fixtureUrl: string,
): Promise<Array<{ id: string; name: string }>> {
  const existing = await client.get<{ data: MonitorResponse[] }>('/api/v1/monitors?limit=100');
  const byName = new Map((existing.data?.data ?? []).map((m) => [m.name, m]));

  const wanted = [
    {
      name: 'Acme pricing (full page)',
      url: `${fixtureUrl}/pricing`,
      scheduleKind: 'preset' as const,
      scheduleValue: '15m',
      ignoreSelectors: ['#clock', '#banner', '#ad-slot'],
      changeThreshold: 0.1,
      tags: ['demo', 'pricing'],
      fullPage: true,
    },
    {
      name: 'Acme terms (section only)',
      url: `${fixtureUrl}/pricing`,
      scheduleKind: 'cron' as const,
      scheduleValue: '*/5 * * * *',
      captureSelector: '#terms',
      ignoreSelectors: ['#clock', '#banner', '#ad-slot'],
      changeThreshold: 0.05,
      tags: ['demo', 'terms'],
      fullPage: false,
    },
  ];

  const created: Array<{ id: string; name: string }> = [];

  for (const monitor of wanted) {
    const found = byName.get(monitor.name);
    if (found) {
      created.push({ id: found.id, name: found.name });
      continue;
    }
    const response = await client.post<MonitorResponse>('/api/v1/monitors', monitor);
    if (response.status !== 201 || !response.data) {
      throw new Error(`could not create demo monitor "${monitor.name}": ${response.text}`);
    }
    created.push({ id: response.data.id, name: response.data.name });
  }

  // First capture for each, so there is a baseline to compare the next one against.
  for (const monitor of created) {
    await client.post(`/api/v1/monitors/${monitor.id}/capture`);
  }

  return created;
}

const invokedDirectly =
  process.argv[1]?.endsWith('demo.ts') || process.argv[1]?.endsWith('demo.js');

if (invokedDirectly) {
  const handle = await runDemo();

  const shutdown = async (): Promise<void> => {
    process.stdout.write('\nstopping demo…\n');
    await handle.stop();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown());
  process.on('SIGTERM', () => void shutdown());
}
