import type { BrowserPool } from './browserPool.js';
import { buildContextOptions, captureInContext } from './capture.js';
import type { CaptureSettings } from './capture.js';
import { pngSize } from './screenshot.js';
import { SsrfProxy } from './ssrf.js';
import type { SsrfGuard } from './ssrf.js';
import type { PreviewCaptureInput, PreviewCaptureResult } from '../api/deps.js';
import type { Logger } from '../jobs/captureJob.js';

const PREVIEW_TIMEOUT_MS = 45_000;

const MAX_PREVIEW_BYTES = 6 * 1024 * 1024;
const TEXT_PREVIEW_CHARS = 2_000;
export interface PreviewDeps {
  pool: BrowserPool;
  guard: SsrfGuard;
  defaultUserAgent: string;
  logger: Logger;
}

export async function previewCapture(
  input: PreviewCaptureInput,
  deps: PreviewDeps,
): Promise<PreviewCaptureResult> {
  const settings: CaptureSettings = {
    url: input.url,
    devicePreset: input.devicePreset,
    viewportWidth: input.viewportWidth,
    viewportHeight: input.viewportHeight,
    fullPage: input.fullPage,
    waitStrategy: input.waitStrategy,
    waitSelector: input.waitSelector,
    extraDelayMs: input.extraDelayMs,
    captureSelector: input.captureSelector,
    ignoreSelectors: input.ignoreSelectors,
    userAgent: input.userAgent,
    headers: input.headers,
    cookies: input.cookies,
    timeoutMs: PREVIEW_TIMEOUT_MS,
    blockMedia: true,
  };

  const proxy = new SsrfProxy({ guard: deps.guard });
  let port = 0;
  try {
    port = await proxy.start();
  } catch (error) {
    return failure(`could not start the SSRF proxy: ${(error as Error).message}`);
  }

  try {
    const contextOptions = buildContextOptions(settings, {
      proxyServer: `http://127.0.0.1:${port}`,
      defaultUserAgent: deps.defaultUserAgent,
    });

    const result = await deps.pool.withContext(
      async (context) => captureInContext(context, settings, { guard: deps.guard }),
      contextOptions,
    );

    if (!result.ok || !result.screenshot) {
      return {
        ok: false,
        error: result.error ?? 'capture failed',
        title: result.title,
        finalUrl: result.finalUrl,
        httpStatus: result.httpStatus,
        loadDurationMs: result.loadDurationMs,
        width: null,
        height: null,
        bytes: 0,
        screenshotBase64: null,
        textPreview: '',
        blockedRequests: result.blockedRequests,
      };
    }

    const size = pngSize(result.screenshot);
    const tooLarge = result.screenshot.length > MAX_PREVIEW_BYTES;

    return {
      ok: true,
      error: null,
      title: result.title,
      finalUrl: result.finalUrl,
      httpStatus: result.httpStatus,
      loadDurationMs: result.loadDurationMs,
      width: size?.width ?? null,
      height: size?.height ?? null,
      bytes: result.screenshot.length,
      screenshotBase64: tooLarge ? null : result.screenshot.toString('base64'),
      textPreview: (result.text ?? '').slice(0, TEXT_PREVIEW_CHARS),
      blockedRequests: result.blockedRequests,
    };
  } catch (error) {
    return failure((error as Error).message);
  } finally {
    await proxy.close().catch(() => undefined);
  }
}

function failure(message: string): PreviewCaptureResult {
  return {
    ok: false,
    error: message,
    title: null,
    finalUrl: null,
    httpStatus: null,
    loadDurationMs: null,
    width: null,
    height: null,
    bytes: 0,
    screenshotBase64: null,
    textPreview: '',
    blockedRequests: [],
  };
}
