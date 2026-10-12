import type { Clock } from '../util/clock.js';
import type { BrowserPool } from './browserPool.js';
import {
  buildContextOptions,
  captureInContext,
  type CaptureResult,
  type CaptureSettings,
  emptyCaptureResult,
} from './capture.js';
import { pngSize } from './screenshot.js';
import { SsrfGuard, SsrfProxy, type Resolver } from './ssrf.js';

export interface CaptureRunnerOptions {
  pool: BrowserPool;
  guard: SsrfGuard;
  clock: Clock;
  defaultUserAgent: string;
  /** Attempts after the first. 0 means "no retries". */
  retries: number;
  /** Base delay for exponential backoff. */
  retryBaseMs: number;
  /** Per-capture hard timeout. */
  timeoutMs: number;
  blockMedia: boolean;
  blockThirdParty?: boolean;
  maxScreenshotBytes?: number;
  logger?: {
    info: (obj: unknown, msg?: string) => void;
    warn: (obj: unknown, msg?: string) => void;
    debug: (obj: unknown, msg?: string) => void;
  };
}

export interface AttemptResult extends CaptureResult {
  attempt: number;
  /** Reasons for every failed attempt, including the final one. */
  attempts: Array<{ attempt: number; error: string | null; durationMs: number }>;
  blockedRequests: CaptureResult['blockedRequests'];
}

/** Errors worth retrying: the network or the page misbehaved transiently. */
const RETRYABLE_KINDS = new Set(['timeout', 'navigation', 'unknown']);

/**
 * A capture that was refused by the SSRF guard is not retried: the destination is not
 * going to become reachable, and retrying would only generate load.
 */
export function isRetryable(result: CaptureResult): boolean {
  if (result.ok) return false;
  if (result.errorKind === 'blocked') return false;
  if (result.errorKind === 'render') return false;
  return RETRYABLE_KINDS.has(result.errorKind ?? 'unknown');
}

export function backoffDelayMs(baseMs: number, retryIndex: number): number {
  // 1s, 2s, 4s ... capped at 30s. Deterministic: no jitter, because the tests assert on
  // the exact schedule and a single worker per monitor does not need thundering-herd
  // protection.
  const delay = baseMs * 2 ** retryIndex;
  return Math.min(delay, 30_000);
}

/**
 * Run one capture with retries.
 *
 * Each attempt gets its own browser context and its own SSRF proxy, so a failed attempt
 * cannot leak state into the next one. The proxy is bound to loopback only and closed
 * after every attempt.
 */
export async function runCaptureWithRetries(
  settings: CaptureSettings,
  options: CaptureRunnerOptions,
): Promise<AttemptResult> {
  const maxAttempts = Math.max(1, options.retries + 1);
  const attempts: AttemptResult['attempts'] = [];
  let last: CaptureResult = emptyCaptureResult();

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const started = Date.now();
    const result = await runSingleCapture(settings, options);
    const durationMs = Date.now() - started;

    attempts.push({ attempt, error: result.error, durationMs });
    last = result;

    if (result.ok) {
      return { ...result, attempt, attempts };
    }

    options.logger?.warn(
      { attempt, maxAttempts, error: result.error, kind: result.errorKind, url: settings.url },
      'capture attempt failed',
    );

    if (attempt >= maxAttempts || !isRetryable(result)) break;

    await options.clock.sleep(backoffDelayMs(options.retryBaseMs, attempt - 1));
  }

  return { ...last, attempt: attempts.length, attempts };
}

async function runSingleCapture(
  settings: CaptureSettings,
  options: CaptureRunnerOptions,
): Promise<CaptureResult> {
  const proxy = new SsrfProxy({
    guard: options.guard,
    // Leave headroom over the capture timeout so Playwright's deadline wins and a slow page
    // is reported as a capture timeout rather than as an origin 502.
    upstreamTimeoutMs: options.timeoutMs + 15_000,
    onBlocked: ({ target, reason }) => {
      options.logger?.debug({ target, reason }, 'ssrf: proxy blocked request');
    },
    logger: options.logger,
  });

  let port = 0;
  try {
    port = await proxy.start();
  } catch (error) {
    return {
      ...emptyCaptureResult(),
      error: `failed to start SSRF proxy: ${(error as Error).message}`,
      errorKind: 'unknown',
    };
  }

  try {
    const contextOptions = buildContextOptions(settings, {
      proxyServer: `http://127.0.0.1:${port}`,
      defaultUserAgent: options.defaultUserAgent,
    });

    return await options.pool.withContext(async (context) => {
      let timer: NodeJS.Timeout | undefined;
      const deadline = new Promise<CaptureResult>((resolve) => {
        timer = setTimeout(() => {
          resolve({
            ...emptyCaptureResult(),
            error: 'capture timeout exceeded',
            errorKind: 'timeout',
          });
          void context.close().catch(() => undefined);
        }, options.timeoutMs);
      });
      let result: CaptureResult;
      try {
        result = await Promise.race([
          captureInContext(context, settings, { guard: options.guard, logger: options.logger }),
          deadline,
        ]);
      } finally {
        clearTimeout(timer);
      }
      if (
        result.screenshot &&
        result.screenshot.length > (options.maxScreenshotBytes ?? 25 * 1024 * 1024)
      ) {
        return {
          ...emptyCaptureResult(),
          error: 'screenshot exceeds configured size limit',
          errorKind: 'render',
        };
      }

      if (result.ok && result.screenshot) {
        const size = pngSize(result.screenshot);
        if (size) {
          result.width = size.width;
          result.height = size.height;
        }
      }
      return result;
    }, contextOptions);
  } catch (error) {
    return {
      ...emptyCaptureResult(),
      error: error instanceof Error ? error.message : String(error),
      errorKind: 'unknown',
    };
  } finally {
    await proxy.close().catch(() => undefined);
  }
}

/** Convenience factory used by the worker and by tests. */
export function createSsrfGuard(options: {
  allowPrivateTargets: boolean;
  allowedHosts?: string[];
  resolver?: Resolver;
}): SsrfGuard {
  return new SsrfGuard({
    allowPrivateTargets: options.allowPrivateTargets,
    allowedHosts: options.allowedHosts,
    ...(options.resolver ? { resolver: options.resolver } : {}),
  });
}
