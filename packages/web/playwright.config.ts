import { defineConfig, devices } from '@playwright/test';

/**
 * End-to-end configuration.
 *
 * Playwright starts the whole stack itself (fixture site, database-backed server, built
 * SPA) through `pnpm --filter @pagefreeze/server e2e-server`, waits for the readiness
 * probe, runs the specs against a real browser, and tears it down afterwards.
 *
 * Requirements: a reachable PostgreSQL (DATABASE_URL_TEST) and the Chromium build that
 * `playwright install chromium` provides.
 */

const APP_PORT = Number.parseInt(process.env['E2E_PORT'] ?? '8092', 10);
const BASE_URL = process.env['E2E_BASE_URL'] ?? `http://127.0.0.1:${APP_PORT}`;

export default defineConfig({
  testDir: './e2e',
  fullyParallel: false,
  workers: 1,
  forbidOnly: Boolean(process.env['CI']),
  retries: process.env['CI'] ? 1 : 0,
  reporter: process.env['CI'] ? [['github'], ['list']] : [['list']],
  timeout: 180_000,
  expect: { timeout: 20_000 },

  use: {
    baseURL: BASE_URL,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
    // The app is same-origin and cookie based; never send credentials cross-origin.
    ignoreHTTPSErrors: false,
  },

  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],

  webServer: {
    command: 'pnpm --filter @pagefreeze/server e2e-server',
    cwd: '../..',
    url: `${BASE_URL}/readyz`,
    reuseExistingServer: !process.env['CI'],
    timeout: 240_000,
    stdout: 'pipe',
    stderr: 'pipe',
  },
});
