import type { Page } from 'playwright';

/**
 * Page stabilisation.
 *
 * A capture is only comparable with the next one if the render is deterministic, so
 * animations, transitions, lazy loading and known-noisy elements are all neutralised
 * before the screenshot is taken.
 */

/**
 * CSS that freezes motion. Injected into the page as a style tag with the highest
 * specificity we can get without `!important` wars: a `*` selector plus `!important`.
 *
 * Caret animations and scroll behaviour are included because both cause pixel drift on
 * pages that autofocus an input.
 */
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

/**
 * Apply the monitor's ignore selectors.
 *
 * Two mechanisms, because one is not enough:
 *
 *   1. A `<style>` tag per selector, hiding anything that matches — including nodes a
 *      script inserts *after* this runs. One tag per selector so a single invalid
 *      selector cannot invalidate the others (CSS drops a whole rule containing an
 *      unparseable selector).
 *   2. Removing the currently matched nodes from the DOM.
 *
 * Removal is what makes the setting actually work. Hiding alone leaves the volatile markup
 * in `page.content()` and in `body.innerText`, so a rotating timestamp would still produce
 * an HTML and text change even though not one pixel moved. If an element is not worth
 * looking at, it should not be extracted either.
 *
 * Each capture runs in a throwaway context, so mutating the DOM has no lasting effect.
 */
export async function applyIgnoreSelectors(page: Page, selectors: string[]): Promise<number> {
  if (selectors.length === 0) return 0;

  for (const selector of selectors) {
    // `content` is a CSS string, not evaluated JS, so an invalid selector simply fails to
    // apply rather than throwing into the capture.
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

/**
 * Scroll through the page so lazily loaded images and infinite-scroll content get a
 * chance to render, then return to the top so the screenshot starts at a stable offset.
 *
 * Every injected expression here is passed to `page.evaluate` as a *string* rather than a
 * function. Function arguments are serialised by source text, and a bundler that renames
 * or wraps inner functions (esbuild's `keepNames` inserts a `__name` helper) produces
 * source that references identifiers which do not exist inside the page. Strings have no
 * such hazard, and they keep the scroll loop under our control in Node where it can be
 * timed and bounded.
 */
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
  /** Hard deadline for the whole wait phase. */
  timeoutMs: number;
}

/**
 * Wait according to the monitor's strategy.
 *
 * `load` waits for the load event (Playwright's default and the most deterministic).
 * `networkidle` additionally waits for the network to settle - useful for SPAs but it
 * can hang on pages with polling, which is why it is opt-in.
 * `selector` waits for an element that signals "the page is ready".
 */
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

/**
 * Resource types that add noise (animated media, font swaps) without adding content.
 * Blocking them is configurable: it makes captures faster and more stable, at the cost
 * of not reflecting what a real visitor sees.
 */
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
