import type { Page } from 'playwright';

export async function extractVisibleText(page: Page): Promise<string> {
  const text = await page.evaluate(() => {
    const body = document.body;
    if (!body) return '';

    const raw = typeof body.innerText === 'string' ? body.innerText : (body.textContent ?? '');
    return raw;
  });

  return normalizeVisibleText(text);
}

export function normalizeVisibleText(text: string): string {
  return String(text ?? '')
    .replace(/\r\n?/g, '\n')
    .replace(/[\u00a0\u2007\u202f]/g, ' ')
    .replace(/\u200b|\u200c|\u200d|\ufeff/g, '')
    .replace(/\t/g, ' ')
    .replace(/ {2,}/g, ' ')
    .replace(/[ \t]+$/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export async function extractTextFromSelector(
  page: Page,
  selector: string,
): Promise<string | null> {
  const handle = await page.$(selector);
  if (!handle) return null;
  const text = await handle.evaluate((element: HTMLElement) => {
    const raw =
      typeof element.innerText === 'string' ? element.innerText : (element.textContent ?? '');
    return raw;
  });
  await handle.dispose();
  return normalizeVisibleText(text);
}

/** The full serialised document, as Chromium sees it after scripts have run. */
export async function extractHtml(page: Page): Promise<string> {
  return page.content();
}

export async function extractHtmlFromSelector(
  page: Page,
  selector: string,
): Promise<string | null> {
  const handle = await page.$(selector);
  if (!handle) return null;
  const html = await handle.evaluate((element: Element) => element.outerHTML);
  await handle.dispose();
  return html;
}
export interface PageMeta {
  title: string | null;
  finalUrl: string;
  httpStatus: number | null;
  requestCount: number;
}

export async function extractPageMeta(
  page: Page,
  fallback: { responseStatus: number | null; requestCount: number },
): Promise<PageMeta> {
  const title = await page.title().catch(() => null);
  return {
    title: title && title.length > 0 ? title : null,
    finalUrl: page.url(),
    httpStatus: fallback.responseStatus,
    requestCount: fallback.requestCount,
  };
}

export async function resetScroll(page: Page): Promise<void> {
  // String form: see the note on `autoScroll` about serialised functions.
  await page
    .evaluate(
      'window.scrollTo(0, 0); if (document.scrollingElement) { document.scrollingElement.scrollTop = 0; }',
    )
    .catch(() => undefined);
}
