/**
 * The web app consumes the shared types directly, so the API contract exists in exactly
 * one place. Anything UI-only lives in this file.
 */

export type {
  ApiToken,
  ApiTokenCreated,
  Change,
  ChannelType,
  DevicePreset,
  DiffRegion,
  JobRef,
  Monitor,
  MonitorStatus,
  MonitorSummary,
  NotificationChannel,
  Page,
  ShareLink,
  Snapshot,
  SystemInfo,
  WaitStrategy,
} from '@pagefreeze/shared';

import type { Change, Monitor, NotificationChannel, Snapshot } from '@pagefreeze/shared';

/** `/changes/:id` returns the change plus its diff bodies and navigation. */
export interface ChangeDetail extends Omit<Change, 'hasDiffImage'> {
  hasDiffImage: boolean;
  monitor: { id: string; name: string | null; url: string | null };
  navigation: { newer: string | null; older: string | null };
  diffImageUrl: string | null;
  screenshotUrls: { before: string | null; after: string };
  textDiff: TextDiff | null;
  htmlDiff: HtmlDiff | null;
  truncated: boolean;
  durationMs: number | null;
  shares: ShareSummary[];
}

export interface ShareSummary {
  id: string;
  changeId?: string;
  url?: string;
  token?: string;
  createdAt: string;
  expiresAt: string | null;
  revokedAt: string | null;
  viewCount?: number;
  active?: boolean;
}

export interface WordChange {
  value: string;
  added?: boolean;
  removed?: boolean;
}

export interface DiffHunk {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  lines: string[];
}

export interface TextDiff {
  added: number;
  removed: number;
  identical: boolean;
  hunks: DiffHunk[];
  unified: string;
  truncated: boolean;
  wordChanges: WordChange[];
  /**
   * True when the inputs were too large for the quadratic word-level pass, in which case
   * `wordChanges` is empty and the viewer falls back to the line-level hunks.
   */
  wordDiffSkipped: boolean;
}

export interface HtmlDiffLine {
  type: 'add' | 'remove' | 'unchanged';
  text: string;
  oldLine: number | null;
  newLine: number | null;
}

export interface HtmlDiffBlock {
  folded: boolean;
  lines: HtmlDiffLine[];
}

export interface HtmlDiff {
  added: number;
  removed: number;
  identical: boolean;
  blocks: HtmlDiffBlock[];
  oldLineCount: number;
  newLineCount: number;
  truncated: boolean;
}

export interface CompareResult {
  stored: boolean;
  changeId: string | null;
  diff: {
    pixelDiffPercent: number | null;
    changedPixels: number | null;
    totalPixels: number | null;
    sizeChanged: boolean;
    sizeFrom: { width: number; height: number } | null;
    sizeTo: { width: number; height: number } | null;
    regions: Change['regions'];
    text: TextDiff | null;
    html: HtmlDiff | null;
    significant: boolean;
    durationMs: number;
  };
}

export interface PreviewResult {
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

export interface ChannelTestResult {
  ok: boolean;
  status: number | null;
  error: string | null;
  durationMs: number;
}

export interface MeResponse {
  username: string;
  kind: 'session' | 'token';
  csrfToken: string | null;
  permissions: string[];
}

export interface ShareView {
  change: Change;
  monitor: { id: string; name: string | null; url: string | null };
  expiresAt: string | null;
  urls: {
    before: string;
    after: string;
    diff: string | null;
    textBefore: string;
    textAfter: string;
  };
}

/** The subset of a monitor the create/update forms submit. */
export type MonitorFormValues = Pick<
  Monitor,
  | 'name'
  | 'url'
  | 'tags'
  | 'enabled'
  | 'scheduleKind'
  | 'scheduleValue'
  | 'devicePreset'
  | 'viewportWidth'
  | 'viewportHeight'
  | 'fullPage'
  | 'waitStrategy'
  | 'waitSelector'
  | 'extraDelayMs'
  | 'captureSelector'
  | 'ignoreSelectors'
  | 'userAgent'
  | 'changeThreshold'
  | 'detectText'
  | 'detectHtml'
  | 'retentionDays'
> & {
  channelIds: string[];
  headers: Record<string, string>;
  cookies: Array<{ name: string; value: string }>;
};

export type {
  Monitor as MonitorRecord,
  Snapshot as SnapshotRecord,
  NotificationChannel as ChannelRecord,
};
