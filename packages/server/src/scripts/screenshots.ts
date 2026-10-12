import pg from 'pg';
import { chromium, type Page } from 'playwright';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { FixtureServer } from '../fixtures/fixtureServer.js';
import { start, type StartedApp } from '../index.js';
import { ApiClient } from './apiClient.js';
import type { Change, Monitor, Page as ApiPage, Snapshot } from '@pagefreeze/shared';

const PORT = Number.parseInt(process.env['SHOTS_PORT'] ?? '8155', 10);
const DB =
  process.env['DATABASE_URL_TEST'] ??
  'postgres://pagefreeze:pagefreeze@127.0.0.1:5432/pagefreeze_test';
const PASSWORD = 'screenshot-password-123';
const DATA_DIR = '/tmp/pfz-shots-data';
const OUT_DIR = resolve(process.cwd(), '../../docs/images');

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function waitForSnapshots(client: ApiClient, monitorId: string, count: number) {
  const deadline = Date.now() + 180_000;
  while (Date.now() < deadline) {
    const response = await client.get<ApiPage<Snapshot>>(
      `/api/v1/monitors/${monitorId}/snapshots`,
      { limit: 50 },
    );
    const rows = response.data?.data ?? [];
    if (rows.length >= count) return rows;
    await wait(1000);
  }
  throw new Error(`timed out waiting for ${count} snapshots`);
}

async function main(): Promise<void> {
  mkdirSync(OUT_DIR, { recursive: true });

  const fixture = new FixtureServer({ port: 8156 });
  const { baseUrl: fixtureUrl, port: fixturePort } = await fixture.start();

  let started: StartedApp | null = null;
  let browser = null as Awaited<ReturnType<typeof chromium.launch>> | null;

  try {
    started = await start({
      env: {
        NODE_ENV: 'production',
        DATABASE_URL: DB,
        PORT: String(PORT),
        HOST: '127.0.0.1',
        PAGEFREEZE_MODE: 'all',
        PAGEFREEZE_ADMIN_PASSWORD: PASSWORD,
        PAGEFREEZE_SECRET_KEY: Buffer.alloc(32, 21).toString('base64'),
        PAGEFREEZE_DATA_DIR: DATA_DIR,
        LOG_LEVEL: 'warn',
        PAGEFREEZE_ALLOWED_HOSTS: `127.0.0.1:${fixturePort}`,
        PAGEFREEZE_MIN_INTERVAL_MINUTES: '0',
        PAGEFREEZE_BASE_URL: `http://127.0.0.1:${PORT}`,
        PAGEFREEZE_CAPTURE_CONCURRENCY: '2',
        PAGEFREEZE_CAPTURE_RETRIES: '0',
        PAGEFREEZE_DISABLE_CHROMIUM_SANDBOX: 'true',
      },
    });

    const baseUrl = `http://127.0.0.1:${PORT}`;
    const client = new ApiClient(baseUrl);
    const loginResponse = await client.post('/api/v1/auth/login', {
      username: 'admin',
      password: PASSWORD,
    });
    if (loginResponse.status !== 200) {
      throw new Error(`screenshot login failed (${loginResponse.status}): ${loginResponse.text}`);
    }

    // One session, reused by every context. Login is rate limited to 10 attempts per 5

    // script partway through its 14 screenshots.
    const jar = (client as unknown as { cookies: Map<string, string> }).cookies;
    const storageState = {
      cookies: [...jar.entries()].map(([name, value]) => ({
        name,
        value,
        domain: '127.0.0.1',
        path: '/',
        expires: Math.floor(Date.now() / 1000) + 3600,
        httpOnly: name === 'pagefreeze_session',
        secure: false,
        sameSite: 'Lax' as const,
      })),
      origins: [],
    };

    fixture.setState({
      price: '$19',
      plans: ['Starter — $19/mo', 'Team — $49/mo', 'Enterprise — contact us'],
      terms: [
        'The service is provided as is, without warranty of any kind.',
        'You may cancel at any time; access continues to the end of the billing period.',
      ],
    });

    const monitors: Monitor[] = [];
    for (const spec of [
      {
        name: 'Acme Cloud pricing',
        url: `${fixtureUrl}/pricing`,
        tags: ['competitor', 'pricing'],
        ignoreSelectors: ['#clock', '#banner', '#ad-slot'],
        changeThreshold: 0.1,
        scheduleValue: '1h',
      },
      {
        name: 'Acme terms of service',
        url: `${fixtureUrl}/pricing`,
        tags: ['legal'],
        captureSelector: '#terms',
        ignoreSelectors: ['#clock', '#banner', '#ad-slot'],
        changeThreshold: 0.05,
        scheduleValue: '24h',
        fullPage: false,
      },
      {
        name: 'Acme docs home',
        url: `${fixtureUrl}/static`,
        tags: ['docs'],
        ignoreSelectors: ['#clock', '#banner', '#ad-slot'],
        changeThreshold: 0.5,
        scheduleValue: '6h',
      },
    ]) {
      const created = await client.post<Monitor>('/api/v1/monitors', {
        scheduleKind: 'preset',
        fullPage: true,
        ...spec,
      });
      if (!created.data) throw new Error(`could not create ${spec.name}: ${created.text}`);
      monitors.push(created.data);
    }

    for (const monitor of monitors) {
      await client.post(`/api/v1/monitors/${monitor.id}/capture`);
    }
    for (const monitor of monitors) {
      await waitForSnapshots(client, monitor.id, 1);
    }

    fixture.setState({
      price: '$29',
      plans: ['Starter — $29/mo', 'Team — $79/mo', 'Enterprise — contact us', 'Scale — contact us'],
      terms: [
        'The service is provided as is, without warranty of any kind.',
        'You may cancel at any time; access continues to the end of the billing period.',
        'Data is stored in the region you select at signup.',
      ],
    });

    for (const monitor of monitors) {
      await client.post(`/api/v1/monitors/${monitor.id}/capture`);
    }
    for (const monitor of monitors) {
      await waitForSnapshots(client, monitor.id, 2);
    }

    fixture.setState({ price: '$24' });
    await client.post(`/api/v1/monitors/${monitors[0]!.id}/capture`);
    await waitForSnapshots(client, monitors[0]!.id, 3);

    const failing = await client.post<Monitor>('/api/v1/monitors', {
      name: 'Legacy status page',
      url: `${fixtureUrl}/error?status=503`,
      scheduleKind: 'preset',
      scheduleValue: '15m',
      tags: ['internal'],
      changeThreshold: 0.5,
    });
    if (failing.data) {
      const seed = new pg.Client({ connectionString: DB });
      await seed.connect();
      try {
        await seed.query(
          `UPDATE monitors SET consecutive_failures = 3, failure_notified = true WHERE id = $1`,
          [failing.data.id],
        );
        await seed.query(
          `INSERT INTO snapshots (
             id, monitor_id, status, captured_at, final_url, http_status, error_message
           ) VALUES (gen_random_uuid(), $1, 'failed', now() - interval '20 minutes', $2, 503,
                     'page.goto: Timeout 60000ms exceeded.')`,
          [failing.data.id, `${fixtureUrl}/error?status=503`],
        );
        await seed.query(
          `INSERT INTO snapshots (
             id, monitor_id, status, captured_at, final_url, http_status, error_message
           ) VALUES (gen_random_uuid(), $1, 'failed', now() - interval '80 minutes', $2, null,
                     'net::ERR_CONNECTION_REFUSED')`,
          [failing.data.id, `${fixtureUrl}/error?status=503`],
        );
      } finally {
        await seed.end();
      }
    }

    const paused = await client.post<Monitor>('/api/v1/monitors', {
      name: 'Holiday campaign page',
      url: `${fixtureUrl}/static`,
      scheduleKind: 'preset',
      scheduleValue: '7d',
      tags: ['marketing'],
      changeThreshold: 0.5,
    });
    if (paused.data) {
      await client.post(`/api/v1/monitors/${paused.data.id}/capture`);
      await waitForSnapshots(client, paused.data.id, 1);
      await client.post(`/api/v1/monitors/${paused.data.id}/pause`);
    }

    await client.post('/api/v1/channels', {
      type: 'webhook',
      name: 'Ops webhook',
      config: { url: 'https://hooks.example.com/pagefreeze', secret: 'a-signing-secret' },
    });
    await client.post('/api/v1/channels', {
      type: 'slack',
      name: '#release-notes',
      config: { url: 'https://hooks.slack.com/services/T00/B00/XXXX' },
    });
    await client.post('/api/v1/tokens', { name: 'ci deploy check', expiresInDays: 90 });

    browser = await chromium.launch({
      chromiumSandbox: false,
      args: ['--force-color-profile=srgb', '--font-render-hinting=none', '--hide-scrollbars'],
    });

    const shots: Array<[string, (page: Page) => Promise<void>, number, number]> = [];

    shots.push([
      'login',
      async (page) => {
        await page.context().clearCookies();
        await page.goto(`${baseUrl}/login`, { waitUntil: 'networkidle' });
        await page.waitForSelector('.login-card', { timeout: 30_000 });
      },
      1280,
      800,
    ]);

    const login = async (page: Page): Promise<void> => {
      await page.goto(`${baseUrl}/`, { waitUntil: 'networkidle' });
      await page.waitForSelector('.topbar', { timeout: 30_000 });
    };

    shots.push([
      'dashboard',
      async (page) => {
        await login(page);
        await page.waitForSelector('.monitor-card', { timeout: 30_000 });
        await page.waitForLoadState('networkidle');
        await wait(2500);
      },
      1440,
      1000,
    ]);

    shots.push([
      'monitor-detail',
      async (page) => {
        await login(page);
        await page.goto(`${baseUrl}/monitors/${monitors[0]!.id}`, { waitUntil: 'networkidle' });
        await page.waitForSelector('.timeline__row', { timeout: 30_000 });
        await wait(1200);
      },
      1440,
      1000,
    ]);

    const changeResponse = await client.get<ApiPage<Change>>(
      `/api/v1/monitors/${monitors[0]!.id}/changes`,
      { limit: 10 },
    );
    const changes = changeResponse.data?.data ?? [];
    const significant =
      [...changes].sort((a, b) => b.regions.length - a.regions.length)[0] ?? changes[0];

    if (significant) {
      const viewerPath = `/monitors/${monitors[0]!.id}/changes/${significant.id}`;

      const openViewer = async (page: Page): Promise<void> => {
        await login(page);
        await page.goto(`${baseUrl}${viewerPath}`, { waitUntil: 'networkidle' });
        await page.waitForSelector('.canvas-viewport, .split', { timeout: 30_000 });
        await wait(2000);
      };

      shots.push([
        'change-viewer-slider',
        async (page) => {
          await openViewer(page);
          await page.getByRole('button', { name: 'Slider' }).click();
          await page.getByLabel(/reveal the newer capture/i).fill('42');
          await wait(600);
        },
        1440,
        1100,
      ]);

      shots.push([
        'change-viewer-side-by-side',
        async (page) => {
          await openViewer(page);
          await page.getByRole('button', { name: 'Side by side' }).click();
          await wait(900);
        },
        1440,
        1100,
      ]);

      shots.push([
        'change-viewer-onion',
        async (page) => {
          await openViewer(page);
          await page.getByRole('button', { name: 'Onion skin' }).click();
          await page.getByLabel(/blend between before and after/i).fill('55');
          await wait(600);
        },
        1440,
        1100,
      ]);

      shots.push([
        'change-viewer-diff',
        async (page) => {
          await openViewer(page);
          await page.getByRole('button', { name: 'Highlighted diff' }).click();
          await wait(900);
          await page.evaluate(() => window.scrollTo(0, 0));
          await wait(400);
        },
        1440,
        1500,
      ]);

      shots.push([
        'change-viewer-text',
        async (page) => {
          await openViewer(page);
          await page.getByRole('tab', { name: /text/i }).click();
          await wait(800);
        },
        1440,
        1100,
      ]);

      shots.push([
        'change-viewer-html',
        async (page) => {
          await openViewer(page);
          await page.getByRole('tab', { name: /html/i }).click();
          await wait(800);
        },
        1440,
        1100,
      ]);
    }

    shots.push([
      'monitor-form',
      async (page) => {
        await login(page);
        await page.goto(`${baseUrl}/monitors/new`, { waitUntil: 'networkidle' });
        await page.getByLabel('Name', { exact: true }).fill('Acme Cloud pricing');
        await page.getByLabel('URL').fill(`${fixtureUrl}/pricing`);
        const ignore = page.getByLabel('Hide these selectors');
        for (const selector of ['#clock', '#banner', '#ad-slot']) {
          await ignore.fill(selector);
          await ignore.press('Enter');
        }
        await page.getByRole('radio', { name: /cron expression/i }).click();
        await wait(400);
        await page.getByRole('button', { name: /test capture now/i }).click();
        await page
          .getByAltText(/preview of the captured page/i)
          .waitFor({ timeout: 90_000 })
          .catch(() => undefined);
        await wait(1200);
      },
      1440,
      1400,
    ]);

    shots.push([
      'settings',
      async (page) => {
        await login(page);
        await page.goto(`${baseUrl}/settings`, { waitUntil: 'networkidle' });
        await wait(1500);
      },
      1440,
      1200,
    ]);

    const snapshotRows = (
      await client.get<ApiPage<Snapshot>>(`/api/v1/monitors/${monitors[0]!.id}/snapshots`, {
        limit: 10,
      })
    ).data?.data.filter((row) => row.status === 'success');
    if (snapshotRows && snapshotRows.length >= 2) {
      shots.push([
        'compare',
        async (page) => {
          await login(page);
          await page.goto(
            `${baseUrl}/monitors/${monitors[0]!.id}/compare?a=${snapshotRows[snapshotRows.length - 1]!.id}&b=${snapshotRows[0]!.id}`,
            { waitUntil: 'networkidle' },
          );
          await page
            .waitForSelector('.canvas-viewport, .split', { timeout: 30_000 })
            .catch(() => undefined);
          await wait(2500);
        },
        1440,
        1100,
      ]);
    }

    if (significant) {
      const share = await client.post<{ url: string }>(`/api/v1/changes/${significant.id}/share`, {
        expiresInHours: 168,
      });
      if (share.data?.url) {
        const sharePath = new URL(share.data.url).pathname;
        shots.push([
          'share',
          async (page) => {
            await page.goto(`${baseUrl}${sharePath}`, { waitUntil: 'networkidle' });
            await page
              .waitForSelector('.canvas-viewport, .split', { timeout: 30_000 })
              .catch(() => undefined);
            await wait(2500);
          },
          1280,
          1100,
        ]);
      }
    }

    for (const [name, path] of [
      ['dashboard-dark', '/'],
      [
        'change-viewer-diff-dark',
        significant ? `/monitors/${monitors[0]!.id}/changes/${significant.id}` : '/',
      ],
    ] as Array<[string, string]>) {
      shots.push([
        name,
        async (page) => {
          await page.emulateMedia({ colorScheme: 'dark' });
          await login(page);
          await page.goto(`${baseUrl}${path}`, { waitUntil: 'networkidle' });
          if (path.includes('/changes/')) {
            await page
              .getByRole('button', { name: 'Highlighted diff' })
              .click()
              .catch(() => undefined);
            await page.evaluate(() => window.scrollTo(0, 0));
          }
          await page
            .waitForSelector('.monitor-card, .canvas-viewport, .split', { timeout: 30_000 })
            .catch(() => undefined);
          await wait(2500);
        },
        1440,
        1100,
      ]);
    }

    shots.push([
      'dashboard-mobile',
      async (page) => {
        await login(page);
        await page.waitForSelector('.monitor-card', { timeout: 30_000 });
        await wait(2000);
      },
      390,
      844,
    ]);

    for (const [name, action, width, height] of shots) {
      const anonymous = name === 'share';
      const context = await browser.newContext({
        viewport: { width, height },
        deviceScaleFactor: 2,
        ...(anonymous ? {} : { storageState }),
      });
      const page = await context.newPage();
      try {
        await action(page);
        const target = resolve(OUT_DIR, `${name}.png`);
        await page.screenshot({ path: target, fullPage: name === 'monitor-form' });
        process.stdout.write(`wrote docs/images/${name}.png\n`);
      } catch (error) {
        process.stdout.write(`FAILED ${name}: ${(error as Error).message}\n`);
      } finally {
        await context.close();
      }
    }
  } finally {
    await browser?.close();
    await started?.close();
    await fixture.stop();
  }
}

main()
  .then(() => process.exit(0))
  .catch((error: unknown) => {
    process.stderr.write(`screenshot run failed: ${(error as Error).stack ?? error}\n`);
    process.exit(1);
  });
