import type { AppConfig } from '../config.js';
import type { Database } from '../db/pool.js';
import type { StorageProvider } from '../storage/types.js';
import type { LocalStorageProvider } from '../storage/local.js';
import type { BrowserPool } from '../capture/browserPool.js';
import type { SsrfGuard } from '../capture/ssrf.js';
import type { DiffEngine } from '../diff/engine.js';
import type { KeyProvider } from '../crypto/secrets.js';
import type { Notifier } from '../notify/notifier.js';
import type { MetricsRegistry } from '../metrics/registry.js';
import type { Clock } from '../util/clock.js';
import type { Scheduler } from '../jobs/scheduler.js';
import type { AuthOptions } from './auth.js';
import type { Logger } from '../jobs/captureJob.js';

export interface AppDeps {
  config: AppConfig;
  db: Database;
  storage: StorageProvider;
  localStorage: LocalStorageProvider | null;
  browserPool: BrowserPool | null;
  guard: SsrfGuard;
  diffEngine: DiffEngine;
  keyProvider: KeyProvider;
  notifier: Notifier;
  metrics: MetricsRegistry;
  clock: Clock;
  logger: Logger;
  auth: AuthOptions;
  scheduler: Scheduler | null;
  executeCapture: (monitorId: string) => Promise<{
    monitorId: string;
    snapshotId: string | null;
    changeId: string | null;
    status: 'success' | 'failed' | 'unchanged';
    significant: boolean;
    duplicate: boolean;
    error: string | null;
    durationMs: number;
  }>;
  previewCapture: (input: PreviewCaptureInput) => Promise<PreviewCaptureResult>;
  startedAt: Date;
}
export interface PreviewCaptureInput {
  url: string;
  devicePreset: 'desktop' | 'tablet' | 'mobile';
  viewportWidth: number;
  viewportHeight: number;
  fullPage: boolean;
  waitStrategy: 'load' | 'networkidle' | 'selector';
  waitSelector: string | null;
  extraDelayMs: number;
  captureSelector: string | null;
  ignoreSelectors: string[];
  userAgent: string | null;
  headers: Record<string, string>;
  cookies: Array<{
    name: string;
    value: string;
    domain?: string;
    path?: string;
    secure?: boolean;
    httpOnly?: boolean;
    sameSite?: 'Lax' | 'Strict' | 'None';
  }>;
}
export interface PreviewCaptureResult {
  ok: boolean;
  error: string | null;
  title: string | null;
  finalUrl: string | null;
  httpStatus: number | null;
  loadDurationMs: number | null;
  width: number | null;
  height: number | null;
  bytes: number;
  screenshotBase64: string | null;
  textPreview: string;
  blockedRequests: Array<{ url: string; reason: string }>;
}
