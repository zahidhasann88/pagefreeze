import type { ChannelType, DevicePreset, MonitorStatus, WaitStrategy } from './constants.js';

/** A clustered rectangle of changed pixels, in CSS pixels of the "after" screenshot. */
export interface DiffRegion {
  x: number;
  y: number;
  width: number;
  height: number;
  /** Share of the total changed pixels inside this rectangle (0-1). */
  weight: number;
}

export interface ChangeDiffStats {
  linesAdded: number;
  linesRemoved: number;
}

export interface SizeInfo {
  width: number;
  height: number;
}

export interface MonitorSecretsMeta {
  headerNames: string[];
  cookieNames: string[];
}

export interface Monitor {
  id: string;
  name: string;
  url: string;
  enabled: boolean;
  paused: boolean;
  scheduleKind: 'preset' | 'cron';
  scheduleValue: string;
  scheduleCron: string;
  scheduleDescription: string;
  nextRunAt: string | null;
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
  changeThreshold: number;
  detectText: boolean;
  detectHtml: boolean;
  retentionDays: number | null;
  tags: string[];
  /** Names only: header and cookie *values* are encrypted and never leave the server. */
  secrets: MonitorSecretsMeta;
  channelIds: string[];
  consecutiveFailures: number;
  failureNotified: boolean;
  status: MonitorStatus;
  lastRunAt: string | null;
  lastSnapshotAt: string | null;
  lastChangeAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface MonitorSummary {
  id: string;
  name: string;
  url: string;
  enabled: boolean;
  paused: boolean;
  status: MonitorStatus;
  tags: string[];
  scheduleDescription: string;
  nextRunAt: string | null;
  lastRunAt: string | null;
  lastCheckedAt: string | null;
  lastChangeAt: string | null;
  /** Relative URL of the newest successful screenshot, or null. */
  latestScreenshotUrl: string | null;
  latestSnapshotId: string | null;
  recentChangeCount: number;
  /** Sparkline of daily change counts, oldest first (14 buckets). */
  changeSparkline: number[];
  consecutiveFailures: number;
  changeThreshold: number;
}

export interface Snapshot {
  id: string;
  monitorId: string;
  status: 'success' | 'failed';
  capturedAt: string;
  finalUrl: string | null;
  httpStatus: number | null;
  loadDurationMs: number | null;
  title: string | null;
  errorMessage: string | null;
  screenshotWidth: number | null;
  screenshotHeight: number | null;
  screenshotHash: string | null;
  htmlHash: string | null;
  textHash: string | null;
  /** Set when the content was identical to an earlier snapshot (no new files stored). */
  duplicateOf: string | null;
  bytes: number | null;
  changeId: string | null;
}

export interface Change {
  id: string;
  monitorId: string;
  fromSnapshotId: string | null;
  toSnapshotId: string;
  createdAt: string;
  pixelDiffPercent: number | null;
  changedPixels: number | null;
  totalPixels: number | null;
  sizeChanged: boolean;
  sizeFrom: SizeInfo | null;
  sizeTo: SizeInfo | null;
  textAdded: number | null;
  textRemoved: number | null;
  htmlAdded: number | null;
  htmlRemoved: number | null;
  significant: boolean;
  summary: string;
  regions: DiffRegion[];
  hasDiffImage: boolean;
}

export interface NotificationChannel {
  id: string;
  name: string;
  type: ChannelType;
  enabled: boolean;
  /** Secret values (webhook signing secret) are never returned; only their presence. */
  config: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export interface ApiToken {
  id: string;
  name: string;
  prefix: string;
  createdAt: string;
  expiresAt: string | null;
  lastUsedAt: string | null;
  revokedAt: string | null;
}

export interface ApiTokenCreated extends ApiToken {
  /** Returned exactly once, at creation time. */
  token: string;
}

export interface ShareLink {
  id: string;
  changeId: string;
  url: string;
  createdAt: string;
  expiresAt: string | null;
  revokedAt: string | null;
}

/** The read-only payload of `GET /api/v1/system/info`. */
export interface SystemInfo {
  version: string;
  node: string;
  platform: string;
  mode: 'all' | 'api' | 'worker';
  uptimeSeconds: number;
  database: { version: string | null; sizeBytes: number | null };
  storage: { driver: string; snapshots: number; bytes: number };
  capture: {
    concurrency: number;
    timeoutMs: number;
    retries: number;
    browserRunning: boolean;
  };
  retentionDays: number;
  minIntervalMinutes: number;
  ssrf: { allowPrivateTargets: boolean; allowedHosts: string[] };
  counts: { monitors: number; snapshots: number; changes: number };
  scheduler: { enabled: boolean; queueDepth: number };
}

export interface JobRef {
  id: string;
  monitorId: string;
  queuedAt: string;
  status: 'queued';
}
