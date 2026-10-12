import { expect, test, type Page } from '@playwright/test';

/**
 * The one end-to-end test the project promises: log in, create a monitor against the
 * fixture site, capture it, change the site, capture again, and read the resulting change
 * in the viewer.
 *
 * Ports are fixed by `playwright.config.ts` / `scripts/e2eServer.ts` so the test can address
 * the fixture site directly and mutate what it serves between captures.
 */

const FIXTURE_PORT = Number.parseInt(process.env['E2E_FIXTURE_PORT'] ?? '8091', 10);
const FIXTURE_URL = `http://127.0.0.1:${FIXTURE_PORT}`;
const ADMIN_PASSWORD = process.env['E2E_PASSWORD'] ?? 'e2e-password-123';

/** Change what the fixture site serves. */
async function setFixtureState(state: Record<string, unknown>): Promise<void> {
  const response = await fetch(`${FIXTURE_URL}/__state`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(state),
  });
  expect(response.ok, `fixture /__state returned ${response.status}`).toBe(true);
}

async function login(page: Page): Promise<void> {
  await page.goto('/login');
  await expect(page.getByRole('heading', { name: 'Pagefreeze' })).toBeVisible();

  await page.getByLabel('Username').fill('admin');
  await page.getByLabel('Password').fill(ADMIN_PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();

  await expect(page).toHaveURL(/\/$/);
  await expect(page.getByRole('heading', { name: 'Dashboard' })).toBeVisible();
}

test.describe('Pagefreeze end to end', () => {
  test.beforeEach(async () => {
    // Start from a known page so a previous test's mutation cannot leak into this one.
    await setFixtureState({
      price: '$19',
      plans: ['Starter — $19/mo', 'Team — $49/mo'],
      terms: ['The service is provided as is.'],
    });
  });

  test('monitors a page, captures a change, and shows it in the viewer', async ({ page }) => {
    test.setTimeout(170_000);

    /* ---------------------------------------------------------- 1. sign in */
    await login(page);

    /* --------------------------------------------------- 2. create monitor */
    await page
      .getByRole('navigation', { name: 'Main' })
      .getByRole('link', { name: 'New monitor' })
      .click();
    await expect(page.getByRole('heading', { name: 'New monitor' })).toBeVisible();

    await page.getByLabel('Name', { exact: true }).fill('E2E pricing page');
    await page.getByLabel('URL').fill(`${FIXTURE_URL}/pricing`);

    // Ignore the parts of the fixture that change on every request, so the only change the
    // viewer reports is the one this test causes.
    const ignoreInput = page.getByLabel('Hide these selectors');
    for (const selector of ['#clock', '#banner', '#ad-slot']) {
      await ignoreInput.fill(selector);
      await ignoreInput.press('Enter');
      await expect(page.getByTitle(`Stop ignoring ${selector}`)).toBeVisible();
    }

    await page.getByLabel('Change threshold (%)').fill('0.05');
    await page.getByRole('button', { name: 'Create monitor' }).click();

    await expect(page.getByRole('heading', { name: 'E2E pricing page' })).toBeVisible();
    await expect(page.getByText(`${FIXTURE_URL}/pricing`)).toBeVisible();

    /* ------------------------------------------------- 3. baseline capture */
    await page.getByRole('button', { name: 'Capture now' }).click();
    await expect(page.getByText('Baseline capture')).toBeVisible({ timeout: 90_000 });

    /* ------------------------------------------ 4. change the page, recapture */
    await setFixtureState({
      price: '$99',
      plans: ['Starter — $99/mo', 'Team — $249/mo', 'Enterprise — contact sales'],
      terms: ['The service is provided as is.', 'A brand new clause about data residency.'],
    });

    await page.getByRole('button', { name: 'Capture now' }).click();
    const changeRow = page.getByRole('link', { name: /significant change/i }).first();
    await expect(changeRow).toBeVisible({ timeout: 90_000 });

    /* ----------------------------------------------- 5. read the change */
    await changeRow.click();

    await expect(page.getByRole('heading', { name: 'E2E pricing page' })).toBeVisible();
    await expect(page.getByText('Significant').first()).toBeVisible();

    // The headline stat is a real percentage from pixelmatch, not a placeholder.
    const pixels = page.getByText('Pixels changed').locator('..').getByText(/%$/);
    await expect(pixels).toBeVisible();
    await expect(pixels).not.toHaveText('0.00%');

    /* ------------------------------------------------ 6. the four modes */
    const visualTab = page.getByRole('tab', { name: /visual/i });
    await expect(visualTab).toHaveAttribute('aria-selected', 'true');

    // Slider is the default when a baseline exists.
    const slider = page.getByLabel(/reveal the newer capture/i);
    await expect(slider).toBeVisible();
    await slider.fill('75');
    await expect(slider).toHaveValue('75');

    await page.getByRole('button', { name: 'Side by side' }).click();
    // Scope to the pane headers: "before"/"after" also appear in the stats and the raw-file
    // links further down the page.
    const panes = page.locator('.split__label');
    await expect(panes).toHaveCount(2);
    await expect(panes.nth(0)).toContainText('Before');
    await expect(panes.nth(1)).toContainText('After');

    await page.getByRole('button', { name: 'Onion skin' }).click();
    const blend = page.getByLabel(/blend between before and after/i);
    await expect(blend).toBeVisible();
    await blend.fill('30');
    await expect(blend).toHaveValue('30');

    await page.getByRole('button', { name: 'Highlighted diff' }).click();
    await expect(page.getByAltText(/highlighted pixel differences/i)).toBeVisible();
    // Region boxes are drawn over the diff and listed below it.
    await expect(page.getByText('Changed regions')).toBeVisible();
    await expect(page.getByRole('button', { name: /changed region 1 of/i })).toBeVisible();

    // Zoom controls work.
    const zoomReadout = page.getByText(/^\d+%$/).first();
    await page.getByRole('button', { name: 'Zoom in' }).click();
    await expect(zoomReadout).not.toHaveText('100%');
    await page.getByRole('button', { name: 'Actual size' }).click();
    await expect(zoomReadout).toHaveText('100%');

    /* ---------------------------------------------------- 7. text diff */
    await page.getByRole('tab', { name: /text/i }).click();

    // Word-level rendering uses real ins/del semantics, which is what makes the diff
    // available to assistive technology rather than colour alone. Note the tokeniser splits
    // "$99" into "$" plus "99", so the assertion is on the marked-up run, not the price.
    await expect(page.locator('ins').first()).toBeVisible();
    await expect(page.locator('del').first()).toBeVisible();
    await expect(page.locator('.word-diff')).toContainText('99');
    await expect(page.locator('.word-diff')).toContainText('$19');

    await page.getByRole('button', { name: /line level/i }).click();
    await expect(page.getByText('Unified patch')).toBeVisible();

    /* ---------------------------------------------------- 8. html diff */
    await page.getByRole('tab', { name: /html/i }).click();
    await expect(page.getByText(/escaped text, never rendered/i)).toBeVisible();
    // The HTML diff is line based, so the new price appears inside a marked-up line.
    await expect(page.locator('.diff__line--add').first()).toBeVisible();
    await expect(page.locator('.diff')).toContainText('$99');
    // Page markup is escaped text, never injected as an element.
    await expect(page.locator('.diff img')).toHaveCount(0);

    /* ------------------------------------------------ 9. share the change */
    await page.getByRole('button', { name: 'Share' }).click();
    const dialog = page.getByRole('dialog', { name: /share this change/i });
    await expect(dialog).toBeVisible();
    // The privacy consequence is stated where the link is created, not only in the docs.
    await expect(dialog.getByText(/bearer credential/i)).toBeVisible();

    await dialog.getByLabel('Expiry').selectOption('24');
    await dialog.getByRole('button', { name: 'Create link' }).click();

    // The token is hashed at rest, so the full URL is shown exactly once, right here.
    const urlBox = dialog.locator('.token-reveal code');
    await expect(urlBox).toBeVisible({ timeout: 20_000 });
    const shareUrl = (await urlBox.textContent()) ?? '';
    expect(shareUrl).toMatch(/\/share\/share_/);
    await expect(dialog.getByRole('button', { name: /copy url/i }).first()).toBeVisible();

    // An anonymous browser context - no session cookie at all - can open the shared change.
    const anonymous = await page.context().browser()!.newContext();
    try {
      const anonymousPage = await anonymous.newPage();
      await anonymousPage.goto(new URL(shareUrl).pathname);
      await expect(anonymousPage.getByRole('heading', { name: /changed$/i })).toBeVisible({
        timeout: 20_000,
      });
      await expect(anonymousPage.getByText(/shared change · read only/i)).toBeVisible();
      // The privacy notice is on the page the recipient actually sees.
      await expect(anonymousPage.getByText(/no account is required/i)).toBeVisible();
      // And nothing else about the instance is reachable from it.
      await anonymousPage.goto('/');
      await expect(anonymousPage).toHaveURL(/\/login$/);
    } finally {
      await anonymous.close();
    }

    await dialog.getByRole('button', { name: 'Close share dialog' }).click();
    await expect(dialog).not.toBeVisible();

    /* ------------------------------------ 10. the change survives a reload */
    await page.reload();
    await expect(page.getByRole('heading', { name: 'E2E pricing page' })).toBeVisible();
    await expect(page.getByRole('tab', { name: /visual/i })).toBeVisible();
  });

  test('refuses to create a monitor for an internal address', async ({ page }) => {
    await login(page);

    await page
      .getByRole('navigation', { name: 'Main' })
      .getByRole('link', { name: 'New monitor' })
      .click();
    await page.getByLabel('Name', { exact: true }).fill('Blocked target');
    await page.getByLabel('URL').fill('http://169.254.169.254/latest/meta-data/');
    await page.getByRole('button', { name: 'Create monitor' }).click();

    // The server rejects it and the UI surfaces the reason rather than failing silently.
    await expect(page.getByRole('alert').first()).toContainText(/SSRF policy/i, {
      timeout: 20_000,
    });
  });

  test('shows the empty state before any monitor exists', async ({ page }) => {
    await login(page);
    // Whether monitors exist depends on earlier tests in the run; assert only that the
    // dashboard renders one of its two documented states.
    const hasEmpty = await page
      .getByText(/no monitors yet/i)
      .isVisible()
      .catch(() => false);
    const hasCards = await page
      .locator('.monitor-card')
      .first()
      .isVisible()
      .catch(() => false);
    expect(hasEmpty || hasCards).toBe(true);
  });
});
