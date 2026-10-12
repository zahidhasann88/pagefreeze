import { randomUUID } from 'node:crypto';
import type { Change, Monitor } from '@pagefreeze/shared';
import type { Database } from '../db/pool.js';
import * as queries from '../db/queries.js';
import type { StorageProvider } from '../storage/types.js';
import { DIFF_IMAGE_KEY, HTML_KEY, SCREENSHOT_KEY, TEXT_KEY } from '../storage/types.js';
import { isSignificant, summarizeChange, type DiffRequest } from '../diff/types.js';
import type { DiffEngine } from '../diff/engine.js';
import type { CaptureSettings, CaptureCookie } from '../capture/capture.js';
import {
  runCaptureWithRetries,
  type AttemptResult,
  type CaptureRunnerOptions,
} from '../capture/runner.js';
import { contentHash } from '../capture/screenshot.js';
import type { KeyProvider } from '../crypto/secrets.js';
import { decryptJson } from '../crypto/secrets.js';
import { onFailure, onSuccess } from '../notify/failures.js';
import { buildChangeEvent, buildFailureEvent, buildRecoveryEvent } from '../notify/events.js';
import type { Notifier } from '../notify/notifier.js';
import type { Clock } from '../util/clock.js';

export interface Logger {
  info: (obj: unknown, msg?: string) => void;
  warn: (obj: unknown, msg?: string) => void;
  error: (obj: unknown, msg?: string) => void;
  debug: (obj: unknown, msg?: string) => void;
}

export interface CaptureJobDeps {
  db: Database;
  storage: StorageProvider;
  diffEngine: DiffEngine;
  notifier: Notifier;
  clock: Clock;
  keyProvider: KeyProvider;
  capture: CaptureRunnerOptions;
  logger: Logger;
  /** Options forwarded to the diff engine. */
  diffOptions: DiffRequest['options'];
  /** Notify after a streak of this many consecutive failures. */
  failureNotifyThreshold: number;
  /** Build an absolute link for notifications. Returns null when no base URL is known. */
  buildLink: (path: string) => string | null;
  metrics?: CaptureMetrics;
}

export interface CaptureMetrics {
  captureTotal(status: 'success' | 'failed'): void;
  captureDuration(seconds: number): void;
  changesTotal(significant: boolean): void;
  notificationsTotal(status: 'ok' | 'failed'): void;
}

export interface CaptureOutcome {
  monitorId: string;
  snapshotId: string | null;
  changeId: string | null;
  status: 'success' | 'failed' | 'unchanged';
  significant: boolean;
  duplicate: boolean;
  error: string | null;
  durationMs: number;
  attempt: AttemptResult | null;
}

/**
 * Execute one capture of one monitor, end to end.
 *
 * This is the single place where a snapshot becomes a change: capture, hash, de-duplicate,
 * store, compare, record and notify. It is called by the scheduled job, by the manual
 * `POST /monitors/:id/capture` endpoint and by the test-capture preview path.
 */
export async function executeCapture(
  monitorId: string,
  deps: CaptureJobDeps,
): Promise<CaptureOutcome> {
  const startedAt = Date.now();

  const monitor = await queries.getMonitor(deps.db, monitorId);
  if (!monitor) {
    return {
      monitorId,
      snapshotId: null,
      changeId: null,
      status: 'failed',
      significant: false,
      duplicate: false,
      error: 'monitor not found',
      durationMs: Date.now() - startedAt,
      attempt: null,
    };
  }

  const settings = await buildCaptureSettings(monitor, deps);
  const attempt = await runCaptureWithRetries(settings, deps.capture);

  deps.metrics?.captureDuration((Date.now() - startedAt) / 1000);

  if (!attempt.ok || !attempt.screenshot) {
    return handleFailure(monitor, attempt, deps, startedAt);
  }

  return handleSuccess(monitor, attempt, deps, startedAt);
}

/** Build capture settings, decrypting headers and cookies just-in-time. */
export async function buildCaptureSettings(
  monitor: Monitor,
  deps: Pick<CaptureJobDeps, 'db' | 'keyProvider' | 'capture' | 'logger'>,
): Promise<CaptureSettings> {
  const secrets = await queries.getMonitorSecrets(deps.db, monitor.id);

  let headers: Record<string, string> = {};
  let cookies: CaptureCookie[] = [];

  if (secrets?.headersEnc) {
    try {
      headers = decryptJson<Record<string, string>>(secrets.headersEnc, deps.keyProvider) ?? {};
    } catch (error) {
      // A wrong PAGEFREEZE_SECRET_KEY must not silently capture an unauthenticated page
      // and report a bogus change: fail loudly instead.
      deps.logger.error(
        { monitorId: monitor.id, error: (error as Error).message },
        'failed to decrypt monitor headers',
      );
      throw new Error('could not decrypt stored headers; PAGEFREEZE_SECRET_KEY may have changed');
    }
  }
  if (secrets?.cookiesEnc) {
    try {
      cookies = decryptJson<CaptureCookie[]>(secrets.cookiesEnc, deps.keyProvider) ?? [];
    } catch (error) {
      deps.logger.error(
        { monitorId: monitor.id, error: (error as Error).message },
        'failed to decrypt monitor cookies',
      );
      throw new Error('could not decrypt stored cookies; PAGEFREEZE_SECRET_KEY may have changed');
    }
  }

  return {
    url: monitor.url,
    devicePreset: monitor.devicePreset,
    viewportWidth: monitor.viewportWidth,
    viewportHeight: monitor.viewportHeight,
    fullPage: monitor.fullPage,
    waitStrategy: monitor.waitStrategy,
    waitSelector: monitor.waitSelector,
    extraDelayMs: monitor.extraDelayMs,
    captureSelector: monitor.captureSelector,
    ignoreSelectors: monitor.ignoreSelectors,
    userAgent: monitor.userAgent,
    headers,
    cookies,
    timeoutMs: deps.capture.timeoutMs,
    blockMedia: deps.capture.blockMedia,
    blockThirdParty: deps.capture.blockThirdParty ?? false,
  };
}

async function handleFailure(
  monitor: Monitor,
  attempt: AttemptResult,
  deps: CaptureJobDeps,
  startedAt: number,
): Promise<CaptureOutcome> {
  deps.metrics?.captureTotal('failed');

  const capturedAt = deps.clock.now();

  const snapshot = await queries.insertSnapshot(deps.db, {
    id: randomUUID(),
    monitorId: monitor.id,
    status: 'failed',
    capturedAt,
    finalUrl: attempt.finalUrl,
    httpStatus: attempt.httpStatus,
    loadDurationMs: attempt.loadDurationMs,
    title: attempt.title,
    errorMessage: truncate(attempt.error ?? 'unknown error', 2000),
    screenshotKey: null,
    htmlKey: null,
    textKey: null,
    screenshotWidth: null,
    screenshotHeight: null,
    screenshotHash: null,
    htmlHash: null,
    textHash: null,
    duplicateOf: null,
    bytes: null,
    requestCount: attempt.requestCount,
    hiddenElementCount: attempt.hiddenElementCount,
    blockedRequestCount: attempt.blockedRequests.length,
  });

  const streak = await queries.incrementConsecutiveFailures(deps.db, monitor.id);

  const decision = onFailure(
    {
      // `incrementConsecutiveFailures` already applied the increment.
      consecutiveFailures: streak.consecutiveFailures - 1,
      failureNotified: streak.failureNotified,
    },
    { threshold: deps.failureNotifyThreshold },
  );

  if (decision.action === 'notify-failure') {
    await queries.markFailureNotified(deps.db, monitor.id);
    await dispatch(
      deps,
      monitor,
      buildFailureEvent(monitor, streak.consecutiveFailures, attempt.error, capturedAt),
    );
  }

  deps.logger.warn(
    {
      monitorId: monitor.id,
      snapshotId: snapshot.id,
      error: attempt.error,
      kind: attempt.errorKind,
      attempts: attempt.attempts.length,
      blocked: attempt.blockedRequests.length,
    },
    'capture failed',
  );

  return {
    monitorId: monitor.id,
    snapshotId: snapshot.id,
    changeId: null,
    status: 'failed',
    significant: false,
    duplicate: false,
    error: attempt.error,
    durationMs: Date.now() - startedAt,
    attempt,
  };
}

async function handleSuccess(
  monitor: Monitor,
  attempt: AttemptResult,
  deps: CaptureJobDeps,
  startedAt: number,
): Promise<CaptureOutcome> {
  deps.metrics?.captureTotal('success');

  const capturedAt = deps.clock.now();
  const screenshot = attempt.screenshot!;
  const html = attempt.html ?? '';
  const text = attempt.text ?? '';

  const screenshotHash = contentHash(screenshot);
  const htmlHash = contentHash(html);
  const textHash = contentHash(text);

  const previous = await queries.getPreviousSuccessfulSnapshot(deps.db, monitor.id, capturedAt);

  // ---------------------------------------------------------------------------
  // Duplicate detection.
  //
  // When the rendered pixels are byte-identical to the previous capture there is no
  // change to report and no reason to write another copy of a multi-megabyte PNG: the
  // new snapshot references the existing artefacts and is marked `duplicate_of`.
  // HTML and text are still written when *they* differ, because a page can change
  // invisible markup without moving a single pixel.
  // ---------------------------------------------------------------------------
  const screenshotDuplicate =
    previous !== null &&
    previous.screenshot_hash === screenshotHash &&
    previous.screenshot_key !== null;
  const htmlDuplicate =
    previous !== null && previous.html_hash === htmlHash && previous.html_key !== null;
  const textDuplicate =
    previous !== null && previous.text_hash === textHash && previous.text_key !== null;
  const fullyDuplicate = screenshotDuplicate && htmlDuplicate && textDuplicate;

  const snapshotId = randomUUID();

  // Artefacts are keyed by snapshot id so their location is stable. When a part is
  // unchanged we reuse the previous key instead of writing a second copy.
  const finalScreenshotKey = screenshotDuplicate
    ? previous!.screenshot_key!
    : SCREENSHOT_KEY(monitor.id, snapshotId);
  const finalHtmlKey = htmlDuplicate ? previous!.html_key! : HTML_KEY(monitor.id, snapshotId);
  const finalTextKey = textDuplicate ? previous!.text_key! : TEXT_KEY(monitor.id, snapshotId);

  if (!screenshotDuplicate) {
    await deps.storage.put(finalScreenshotKey, screenshot);
  }
  if (!htmlDuplicate) {
    await deps.storage.put(finalHtmlKey, html);
  }
  if (!textDuplicate) {
    await deps.storage.put(finalTextKey, text);
  }

  const snapshot = await queries.insertSnapshot(deps.db, {
    id: snapshotId,
    monitorId: monitor.id,
    status: 'success',
    capturedAt,
    finalUrl: attempt.finalUrl,
    httpStatus: attempt.httpStatus,
    loadDurationMs: attempt.loadDurationMs,
    title: attempt.title,
    errorMessage: null,
    screenshotKey: finalScreenshotKey,
    htmlKey: finalHtmlKey,
    textKey: finalTextKey,
    screenshotWidth: attempt.width,
    screenshotHeight: attempt.height,
    screenshotHash,
    htmlHash,
    textHash,
    duplicateOf: fullyDuplicate ? previous!.id : null,
    bytes: attempt.bytes,
    requestCount: attempt.requestCount,
    hiddenElementCount: attempt.hiddenElementCount,
    blockedRequestCount: attempt.blockedRequests.length,
  });

  await queries.touchMonitorSnapshot(deps.db, monitor.id, capturedAt);

  // A successful capture ends any failure streak (and may trigger a recovery notice).
  const recovery = onSuccess(
    {
      consecutiveFailures: monitor.consecutiveFailures,
      failureNotified: monitor.failureNotified,
    },
    { threshold: deps.failureNotifyThreshold },
  );
  if (recovery.action === 'notify-recovery') {
    await queries.resetConsecutiveFailures(deps.db, monitor.id);
    await dispatch(
      deps,
      monitor,
      buildRecoveryEvent(monitor, monitor.consecutiveFailures, capturedAt),
    );
  } else if (monitor.consecutiveFailures > 0) {
    await queries.resetConsecutiveFailures(deps.db, monitor.id);
  }

  if (!previous) {
    deps.logger.info(
      { monitorId: monitor.id, snapshotId: snapshot.id },
      'first snapshot for monitor; no comparison performed',
    );
    return {
      monitorId: monitor.id,
      snapshotId: snapshot.id,
      changeId: null,
      status: fullyDuplicate ? 'unchanged' : 'success',
      significant: false,
      duplicate: fullyDuplicate,
      error: null,
      durationMs: Date.now() - startedAt,
      attempt,
    };
  }

  if (fullyDuplicate) {
    deps.logger.debug(
      { monitorId: monitor.id, snapshotId: snapshot.id, previousId: previous.id },
      'snapshot identical to previous; skipping diff',
    );
    return {
      monitorId: monitor.id,
      snapshotId: snapshot.id,
      changeId: null,
      status: 'unchanged',
      significant: false,
      duplicate: true,
      error: null,
      durationMs: Date.now() - startedAt,
      attempt,
    };
  }

  // ---------------------------------------------------------------------------
  // Compare. Never create a Change from a failed snapshot: `previous` is by
  // construction a successful one, and so is the current capture.
  // ---------------------------------------------------------------------------
  const previousScreenshot = await deps.storage.get(previous.screenshot_key ?? '');
  const previousHtml = await deps.storage.get(previous.html_key ?? '');
  const previousText = await deps.storage.get(previous.text_key ?? '');

  const diffRequest: DiffRequest = {
    beforeScreenshot: previousScreenshot,
    afterScreenshot: screenshot,
    beforeText: previousText?.toString('utf8') ?? null,
    afterText: text,
    beforeHtml: previousHtml?.toString('utf8') ?? null,
    afterHtml: html,
    options: {
      ...deps.diffOptions,
      computeText: monitor.detectText,
      computeHtml: monitor.detectHtml,
    },
  };

  const diff = await deps.diffEngine.diff(diffRequest);

  const significant = isSignificant(
    diff,
    monitor.changeThreshold,
    monitor.detectText,
    monitor.detectHtml,
  );

  const summary = summarizeChange(diff, { significant, sizeChanged: diff.sizeChanged });

  const diffImageKey = DIFF_IMAGE_KEY(monitor.id, snapshot.id);
  if (diff.diffImage) {
    await deps.storage.put(diffImageKey, diff.diffImage);
  }

  const truncated = Boolean(diff.text?.truncated || diff.html?.truncated);

  const change = await queries.insertChange(deps.db, {
    monitorId: monitor.id,
    fromSnapshotId: previous.id,
    toSnapshotId: snapshot.id,
    pixelDiffPercent: diff.pixelDiffPercent,
    changedPixels: diff.changedPixels,
    totalPixels: diff.totalPixels,
    sizeChanged: diff.sizeChanged,
    sizeFrom: diff.sizeFrom,
    sizeTo: diff.sizeTo,
    textAdded: diff.text?.added ?? null,
    textRemoved: diff.text?.removed ?? null,
    htmlAdded: diff.html?.added ?? null,
    htmlRemoved: diff.html?.removed ?? null,
    significant,
    summary,
    regions: diff.regions,
    diffImageKey: diff.diffImage ? diffImageKey : null,
    textDiff: diff.text,
    htmlDiff: diff.html,
    truncated,
    durationMs: diff.durationMs,
  });

  await queries.touchMonitorChange(deps.db, monitor.id, capturedAt);
  deps.metrics?.changesTotal(significant);

  deps.logger.info(
    {
      monitorId: monitor.id,
      snapshotId: snapshot.id,
      changeId: change.id,
      significant,
      pixelDiffPercent: diff.pixelDiffPercent,
      sizeChanged: diff.sizeChanged,
      diffMs: diff.durationMs,
    },
    'change recorded',
  );

  if (significant) {
    await dispatch(
      deps,
      monitor,
      buildChangeEvent(monitor, change, buildChangeLinks(change, deps), capturedAt),
    );
  }

  return {
    monitorId: monitor.id,
    snapshotId: snapshot.id,
    changeId: change.id,
    status: 'success',
    significant,
    duplicate: false,
    error: null,
    durationMs: Date.now() - startedAt,
    attempt,
  };
}

function buildChangeLinks(
  change: Change,
  deps: CaptureJobDeps,
): { change: string | null; share: string | null } {
  return {
    change: deps.buildLink(`/monitors/${change.monitorId}/changes/${change.id}`),
    share: null,
  };
}

async function dispatch(
  deps: CaptureJobDeps,
  monitor: Monitor,
  event: Parameters<Notifier['deliver']>[2],
): Promise<void> {
  const channels = await queries.getChannelsForMonitor(deps.db, monitor.id);
  if (channels.length === 0) return;

  for (const channel of channels) {
    const config = await resolveChannelConfig(channel, deps.keyProvider, deps.logger);
    const result = await deps.notifier.deliver(
      { id: channel.id, name: channel.name },
      config,
      event,
    );
    deps.metrics?.notificationsTotal(result.ok ? 'ok' : 'failed');
    await queries.recordChannelDelivery(
      deps.db,
      channel.id,
      result.ok ? null : (result.error ?? `status ${result.status ?? 'unknown'}`),
    );
  }
}

/**
 * Turn a stored channel row into the delivery config, decrypting the webhook secret.
 * The plaintext secret exists only inside this function's return value and the delivery
 * call; it is never logged.
 */
export async function resolveChannelConfig(
  channel: { config_enc: string | null; config: Record<string, unknown>; type: string },
  keyProvider: KeyProvider,
  logger: Logger,
): Promise<{
  type: 'webhook' | 'slack' | 'email';
  url?: string;
  secret?: string | null;
  to?: string[];
  subject?: string;
}> {
  const type = channel.type as 'webhook' | 'slack' | 'email';
  const plain = (channel.config ?? {}) as Record<string, unknown>;

  let full: Record<string, unknown> = plain;
  if (channel.config_enc) {
    try {
      full = decryptJson<Record<string, unknown>>(channel.config_enc, keyProvider) ?? plain;
    } catch (error) {
      logger.error(
        { error: (error as Error).message },
        'failed to decrypt channel config; sending without the signing secret',
      );
      full = plain;
    }
  }

  return {
    type,
    ...(typeof full['url'] === 'string' ? { url: full['url'] } : {}),
    ...(typeof full['secret'] === 'string' ? { secret: full['secret'] } : { secret: null }),
    ...(Array.isArray(full['to']) ? { to: full['to'] as string[] } : {}),
    ...(typeof full['subject'] === 'string' ? { subject: full['subject'] } : {}),
  };
}

function truncate(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max)}…` : value;
}
