import type { BrowserContext, Page, Response } from 'playwright';
import { DEVICE_PRESETS, type DevicePreset, type WaitStrategy } from '@pagefreeze/shared';
import type { SsrfGuard } from './ssrf.js';
import { shouldBlockResource } from './stabilize.js';
import {
  applyIgnoreSelectors,
  autoScroll,
  delay,
  injectStabilizeCss,
  waitForStrategy,
} from './stabilize.js';
import {
  extractHtml,
  extractHtmlFromSelector,
  extractTextFromSelector,
  extractVisibleText,
  resetScroll,
} from './extract.js';

export interface CaptureCookie {
  name: string;
  value: string;
  domain?: string;
  path?: string;
  secure?: boolean;
  httpOnly?: boolean;
  sameSite?: 'Lax' | 'Strict' | 'None';
}

export interface CaptureSettings {
  url: string;
  devicePreset: DevicePreset;
  viewportWidth: number;
  viewportHeight: number;
  fullPage: boolean;
  waitStrategy: WaitStrategy;
  waitSelector: string | null;
  extraDelayMs: number;
  captureSelector: string | null;
  ignoreSelectors: string[];
  userAgent: string | null;
  headers: Record<string, string>;
  cookies: CaptureCookie[];
  timeoutMs: number;
  blockMedia: boolean;
  blockThirdParty?: boolean;
}

export type CaptureErrorKind = 'timeout' | 'blocked' | 'navigation' | 'render' | 'unknown';

export interface BlockedRequest {
  url: string;
  reason: string;
}

export interface CaptureResult {
  ok: boolean;
  screenshot: Buffer | null;
  width: number | null;
  height: number | null;
  html: string | null;
  text: string | null;
  title: string | null;
  finalUrl: string | null;
  httpStatus: number | null;
  loadDurationMs: number | null;
  requestCount: number;
  bytes: number;
  error: string | null;
  errorKind: CaptureErrorKind | null;
  blockedRequests: BlockedRequest[];
  hiddenElementCount: number;
}

export interface CaptureDeps {
  guard: SsrfGuard;
  logger?: {
    debug: (obj: unknown, msg?: string) => void;
    warn: (obj: unknown, msg?: string) => void;
  };
}

function errorKindOf(error: unknown): CaptureErrorKind {
  const message = error instanceof Error ? error.message : String(error);
  if (/timeout/i.test(message) || /exceeded/i.test(message)) return 'timeout';
  if (/blocked by pagefreeze|ssrf|blockedbyclient/i.test(message)) return 'blocked';
  if (/net::|navigation|ERR_/i.test(message)) return 'navigation';
  if (/screenshot|render|element/i.test(message)) return 'render';
  return 'unknown';
}

function messageOf(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

/**
 * Build the browser context options for one capture.
 *
 * Hardening applied here:
 *  - a fresh, non-persistent context per capture (no shared cookies/storage/cache)
 *  - every sensitive permission denied
 *  - downloads disabled
 *  - a loopback-only SSRF proxy, so the socket to the target is opened by us to an
 *    address the guard already validated (this is what defeats DNS rebinding)
 *  - the polite default User-Agent unless the monitor overrides it
 */
export function buildContextOptions(
  settings: CaptureSettings,
  options: { proxyServer?: string; defaultUserAgent: string },
): Parameters<import('playwright').Browser['newContext']>[0] {
  const preset = DEVICE_PRESETS[settings.devicePreset] ?? DEVICE_PRESETS.desktop;

  return {
    viewport: { width: settings.viewportWidth, height: settings.viewportHeight },
    deviceScaleFactor: preset.deviceScaleFactor,
    isMobile: preset.isMobile,
    hasTouch: preset.hasTouch,
    userAgent: settings.userAgent?.trim() || options.defaultUserAgent,
    locale: 'en-US',
    timezoneId: 'UTC',
    colorScheme: 'light',
    reducedMotion: 'reduce',
    forcedColors: 'none',
    acceptDownloads: false,
    serviceWorkers: 'block',
    javaScriptEnabled: true,
    bypassCSP: false,
    ignoreHTTPSErrors: false,
    ...(options.proxyServer ? { proxy: { server: options.proxyServer } } : {}),
    ...(Object.keys(settings.headers).length > 0 ? { extraHTTPHeaders: settings.headers } : {}),
  };
}

/**
 * Attach the request-time SSRF check to a context.
 *
 * Registering a route on the context fires for the main frame, redirects, subframes,
 * XHR/fetch and every subresource, so no request the page initiates escapes the check.
 * Anything the guard refuses is aborted before a socket is opened.
 */
export async function attachSsrfRouting(
  context: BrowserContext,
  guard: SsrfGuard,
  settings: CaptureSettings,
  onBlocked: (entry: BlockedRequest) => void,
  logger?: CaptureDeps['logger'],
): Promise<void> {
  await context.route('**/*', async (route) => {
    const request = route.request();
    const url = request.url();

    // Non-http(s) schemes (file:, chrome:, data:, blob:, about:) are never allowed.
    let schemeOk = false;
    try {
      const parsed = new URL(url);
      schemeOk = parsed.protocol === 'http:' || parsed.protocol === 'https:';
    } catch {
      schemeOk = false;
    }
    if (!schemeOk) {
      onBlocked({ url, reason: 'scheme-not-allowed' });
      logger?.debug({ url, reason: 'scheme-not-allowed' }, 'capture: request blocked');
      await route.abort('blockedbyclient').catch(() => undefined);
      return;
    }

    const verdict = await guard.checkUrl(url);
    if (!verdict.allowed) {
      onBlocked({ url, reason: verdict.reason ?? 'blocked' });
      logger?.debug({ url, reason: verdict.reason }, 'capture: request blocked');
      await route.abort('blockedbyclient').catch(() => undefined);
      return;
    }

    if (
      shouldBlockResource(request.resourceType(), {
        blockMedia: settings.blockMedia,
        blockThirdParty: settings.blockThirdParty ?? false,
        origin: new URL(settings.url).origin,
        url,
        navigation: request.isNavigationRequest(),
      })
    ) {
      await route.abort('blockedbyclient').catch(() => undefined);
      return;
    }

    await route.continue().catch(() => undefined);
  });
}

async function applyCookies(context: BrowserContext, settings: CaptureSettings): Promise<void> {
  if (settings.cookies.length === 0) return;

  let origin: URL;
  try {
    origin = new URL(settings.url);
  } catch {
    return;
  }

  const cookies = settings.cookies.map((cookie) => ({
    name: cookie.name,
    value: cookie.value,
    domain: cookie.domain || origin.hostname,
    path: cookie.path || '/',
    secure: cookie.secure ?? origin.protocol === 'https:',
    httpOnly: cookie.httpOnly ?? false,
    sameSite: cookie.sameSite ?? ('Lax' as const),
  }));

  await context.addCookies(cookies).catch(() => undefined);
}

/**
 * Perform one capture inside an already-created, isolated context.
 */
export async function captureInContext(
  context: BrowserContext,
  settings: CaptureSettings,
  deps: CaptureDeps,
): Promise<CaptureResult> {
  const blockedRequests: BlockedRequest[] = [];
  let requestCount = 0;
  let httpStatus: number | null = null;
  let hiddenElementCount = 0;

  await attachSsrfRouting(
    context,
    deps.guard,
    settings,
    (entry) => {
      blockedRequests.push(entry);
    },
    deps.logger,
  );

  // Playwright denies every permission by default for a fresh context; clearing again
  // makes the intent explicit and guards against a future default changing.
  await context.clearPermissions().catch(() => undefined);

  const page: Page = await context.newPage();

  page.on('request', () => {
    requestCount += 1;
  });

  await applyCookies(context, settings);

  const startedAt = Date.now();
  let response: Response | null = null;

  try {
    response = await page.goto(settings.url, {
      waitUntil: 'domcontentloaded',
      timeout: settings.timeoutMs,
    });
    httpStatus = response ? response.status() : null;
  } catch (error) {
    return {
      ok: false,
      screenshot: null,
      width: null,
      height: null,
      html: null,
      text: null,
      title: null,
      finalUrl: page.url() || null,
      httpStatus,
      loadDurationMs: Date.now() - startedAt,
      requestCount,
      bytes: 0,
      error: messageOf(error),
      errorKind: errorKindOf(error),
      blockedRequests,
      hiddenElementCount,
    };
  }

  try {
    await waitForStrategy(page, {
      strategy: settings.waitStrategy,
      selector: settings.waitSelector,
      timeoutMs: settings.timeoutMs,
    });

    // Remove noisy elements *before* the stabilisation pass and before extraction, so
    // their absence is reflected in the screenshot, the text and the HTML alike.
    hiddenElementCount = await applyIgnoreSelectors(page, settings.ignoreSelectors);

    await injectStabilizeCss(page);
    await autoScroll(page);
    await resetScroll(page);

    if (settings.extraDelayMs > 0) {
      await delay(settings.extraDelayMs);
    }

    // Lazy images may still be decoding after scrolling; settle them before hashing pixels.
    await page.evaluate(`Promise.race([
      Promise.all([document.fonts.ready, ...Array.from(document.images, image => {
        image.loading = 'eager';
        return image.decode().catch(() => undefined);
      })]),
      new Promise(resolve => setTimeout(resolve, 2000))
    ]).then(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))`);

    const screenshotOptions = {
      type: 'png' as const,
      fullPage: settings.captureSelector ? false : settings.fullPage,
      animations: 'disabled' as const,
      caret: 'hide' as const,
      scale: 'css' as const,
      timeout: settings.timeoutMs,
    };

    let screenshot: Buffer;
    if (settings.captureSelector) {
      const handle = await page.waitForSelector(settings.captureSelector, {
        timeout: settings.timeoutMs,
        state: 'visible',
      });
      screenshot = await handle.screenshot(screenshotOptions);
      await handle.dispose();
    } else {
      screenshot = await page.screenshot(screenshotOptions);
    }

    const text = settings.captureSelector
      ? ((await extractTextFromSelector(page, settings.captureSelector)) ??
        (await extractVisibleText(page)))
      : await extractVisibleText(page);

    const html = settings.captureSelector
      ? ((await extractHtmlFromSelector(page, settings.captureSelector)) ??
        (await extractHtml(page)))
      : await extractHtml(page);

    const title = await page.title().catch(() => null);

    return {
      ok: true,
      screenshot,
      width: null, // resolved by the caller from the PNG header
      height: null,
      html,
      text,
      title: title && title.length > 0 ? title : null,
      finalUrl: page.url(),
      httpStatus,
      loadDurationMs: Date.now() - startedAt,
      requestCount,
      bytes: screenshot.length,
      error: null,
      errorKind: null,
      blockedRequests,
      hiddenElementCount,
    };
  } catch (error) {
    return {
      ok: false,
      screenshot: null,
      width: null,
      height: null,
      html: null,
      text: null,
      title: null,
      finalUrl: page.url() || null,
      httpStatus,
      loadDurationMs: Date.now() - startedAt,
      requestCount,
      bytes: 0,
      error: messageOf(error),
      errorKind: errorKindOf(error),
      blockedRequests,
      hiddenElementCount,
    };
  } finally {
    await page.close().catch(() => undefined);
  }
}

export function emptyCaptureResult(): CaptureResult {
  return {
    ok: false,
    screenshot: null,
    width: null,
    height: null,
    html: null,
    text: null,
    title: null,
    finalUrl: null,
    httpStatus: null,
    loadDurationMs: null,
    requestCount: 0,
    bytes: 0,
    error: null,
    errorKind: null,
    blockedRequests: [],
    hiddenElementCount: 0,
  };
}
