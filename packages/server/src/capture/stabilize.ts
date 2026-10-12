import type { Page } from 'playwright';

export const STABILIZE_CSS = `
*, *::before, *::after {
  animation: none !important;
  animation-delay: 0s !important;
  animation-duration: 0s !important;
  animation-iteration-count: 1 !important;
  transition: none !important;
  transition-delay: 0s !important;
  transition-duration: 0s !important;
  caret-color: transparent !important;
  scroll-behavior: auto !important;
}
`;

export async function applyIgnoreSelectors(page: Page, selectors: string[]): Promise<number> {
  if (selectors.length === 0) return 0;

  for (const selector of selectors) {
    await page
      .addStyleTag({
        content: `${selector} { display: none !important; visibility: hidden !important; }`,
      })
      .catch(() => undefined);
  }

  return page.evaluate((list: string[]) => {
    let removed = 0;
    for (const selector of list) {
      try {
        const elements = document.querySelectorAll(selector);
        elements.forEach((element) => {
          element.remove();
          removed += 1;
        });
      } catch {
        // An invalid selector must not abort the capture.
      }
    }
    return removed;
  }, selectors);
}

export async function injectStabilizeCss(page: Page): Promise<void> {
  await page.addStyleTag({ content: STABILIZE_CSS }).catch(() => undefined);
}

export async function autoScroll(
  page: Page,
  options: { step?: number; maxSteps?: number; settleMs?: number } = {},
): Promise<void> {
  const step = Math.max(1, Math.trunc(options.step ?? 800));
  const maxSteps = Math.max(1, Math.trunc(options.maxSteps ?? 40));
  const settleMs = Math.max(0, options.settleMs ?? 50);

  const height = await page
    .evaluate('document.body ? document.body.scrollHeight : 0')
    .catch(() => 0);
  if (typeof height !== 'number' || height <= 0) return;

  let scrolled = 0;
  for (let index = 0; index < maxSteps && scrolled < height; index += 1) {
    await page.evaluate(`window.scrollBy(0, ${step})`).catch(() => undefined);
    scrolled += step;
    if (settleMs > 0) await delay(settleMs);
  }

  await page.evaluate('window.scrollTo(0, 0)').catch(() => undefined);
}
export interface WaitOptions {
  strategy: 'load' | 'networkidle' | 'selector';
  selector: string | null;
  timeoutMs: number;
}

export async function waitForStrategy(page: Page, options: WaitOptions): Promise<void> {
  const { strategy, selector, timeoutMs } = options;

  switch (strategy) {
    case 'networkidle':
      await page.waitForLoadState('networkidle', { timeout: timeoutMs }).catch(() => undefined);
      break;
    case 'selector':
      if (selector) {
        await page.waitForSelector(selector, { timeout: timeoutMs, state: 'visible' });
      } else {
        await page.waitForLoadState('load', { timeout: timeoutMs }).catch(() => undefined);
      }
      break;
    case 'load':
    default:
      await page.waitForLoadState('load', { timeout: timeoutMs }).catch(() => undefined);
      break;
  }
}

export async function delay(ms: number): Promise<void> {
  if (ms <= 0) return;
  await new Promise<void>((resolve) => setTimeout(resolve, ms));
}

export const NOISY_RESOURCE_TYPES = new Set(['media', 'font']);

export function shouldBlockResource(
  resourceType: string,
  options: {
    blockMedia: boolean;
    blockThirdParty: boolean;
    origin: string;
    url?: string;
    navigation?: boolean;
  },
): boolean {
  if (options.blockMedia && NOISY_RESOURCE_TYPES.has(resourceType)) return true;
  if (options.blockThirdParty && options.url && !options.navigation) {
    return new URL(options.url).origin !== options.origin;
  }
  return false;
}
