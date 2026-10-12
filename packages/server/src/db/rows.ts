import type {
  Change,
  DiffRegion,
  Monitor,
  MonitorStatus,
  MonitorSummary,
  NotificationChannel,
  Snapshot,
} from '@pagefreeze/shared';
import type { HtmlDiffResult } from '../diff/html.js';
import type { TextDiffResult } from '../diff/text.js';
export interface MonitorRow {
  id: string;
  name: string;
  url: string;
  enabled: boolean;
  paused: boolean;
  schedule_kind: 'preset' | 'cron';
  schedule_value: string;
  schedule_cron: string;
  device_preset: 'desktop' | 'tablet' | 'mobile';
  viewport_width: number;
  viewport_height: number;
  full_page: boolean;
  wait_strategy: 'load' | 'networkidle' | 'selector';
  wait_selector: string | null;
  extra_delay_ms: number;
  capture_selector: string | null;
  ignore_selectors: string[];
  user_agent: string | null;
  change_threshold: number;
  detect_text: boolean;
  detect_html: boolean;
  retention_days: number | null;
  tags: string[];
  consecutive_failures: number;
  failure_notified: boolean;
  last_run_at: Date | null;
  last_snapshot_at: Date | null;
  last_change_at: Date | null;
  created_at: Date;
  updated_at: Date;
}
export interface MonitorSecretsRow {
  monitor_id: string;
  headers_enc: string | null;
  cookies_enc: string | null;
  header_names: string[];
  cookie_names: string[];
  updated_at: Date;
}

export function deriveMonitorStatus(row: {
  enabled: boolean;
  paused: boolean;
  consecutive_failures: number;
}): MonitorStatus {
  if (!row.enabled || row.paused) return 'paused';
  if (row.consecutive_failures > 0) return 'failing';
  return 'ok';
}

function iso(value: Date | string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}
export interface MonitorMappingInput {
  row: MonitorRow;
  secrets: MonitorSecretsRow | null;
  channelIds: string[];
}

export function mapMonitor({ row, secrets, channelIds }: MonitorMappingInput): Monitor {
  return {
    id: row.id,
    name: row.name,
    url: row.url,
    enabled: row.enabled,
    paused: row.paused,
    scheduleKind: row.schedule_kind,
    scheduleValue: row.schedule_value,
    scheduleCron: row.schedule_cron,
    scheduleDescription: '',
    nextRunAt: null,
    devicePreset: row.device_preset,
    viewportWidth: row.viewport_width,
    viewportHeight: row.viewport_height,
    fullPage: row.full_page,
    waitStrategy: row.wait_strategy,
    waitSelector: row.wait_selector,
    extraDelayMs: row.extra_delay_ms,
    captureSelector: row.capture_selector,
    ignoreSelectors: row.ignore_selectors ?? [],
    userAgent: row.user_agent,
    changeThreshold: row.change_threshold,
    detectText: row.detect_text,
    detectHtml: row.detect_html,
    retentionDays: row.retention_days,
    tags: row.tags ?? [],
    secrets: {
      headerNames: secrets?.header_names ?? [],
      cookieNames: secrets?.cookie_names ?? [],
    },
    channelIds,
    consecutiveFailures: row.consecutive_failures,
    failureNotified: row.failure_notified,
    status: deriveMonitorStatus(row),
    lastRunAt: iso(row.last_run_at),
    lastSnapshotAt: iso(row.last_snapshot_at),
    lastChangeAt: iso(row.last_change_at),
    createdAt: iso(row.created_at) ?? '',
    updatedAt: iso(row.updated_at) ?? '',
  };
}
export interface SnapshotRow {
  id: string;
  monitor_id: string;
  status: 'success' | 'failed';
  captured_at: Date;
  final_url: string | null;
  http_status: number | null;
  load_duration_ms: number | null;
  title: string | null;
  error_message: string | null;
  screenshot_key: string | null;
  html_key: string | null;
  text_key: string | null;
  screenshot_width: number | null;
  screenshot_height: number | null;
  screenshot_hash: string | null;
  html_hash: string | null;
  text_hash: string | null;
  duplicate_of: string | null;
  bytes: number | null;
  request_count: number | null;
  hidden_element_count: number | null;
  blocked_request_count: number;
  change_id?: string | null;
}

export function mapSnapshot(row: SnapshotRow): Snapshot {
  return {
    id: row.id,
    monitorId: row.monitor_id,
    status: row.status,
    capturedAt: iso(row.captured_at) ?? '',
    finalUrl: row.final_url,
    httpStatus: row.http_status,
    loadDurationMs: row.load_duration_ms,
    title: row.title,
    errorMessage: row.error_message,
    screenshotWidth: row.screenshot_width,
    screenshotHeight: row.screenshot_height,
    screenshotHash: row.screenshot_hash,
    htmlHash: row.html_hash,
    textHash: row.text_hash,
    duplicateOf: row.duplicate_of,
    bytes: row.bytes,
    changeId: row.change_id ?? null,
  };
}
export interface ChangeRow {
  id: string;
  monitor_id: string;
  from_snapshot_id: string | null;
  to_snapshot_id: string;
  created_at: Date;
  pixel_diff_percent: number | null;
  changed_pixels: number | null;
  total_pixels: number | null;
  size_changed: boolean;
  size_from_width: number | null;
  size_from_height: number | null;
  size_to_width: number | null;
  size_to_height: number | null;
  text_added: number | null;
  text_removed: number | null;
  html_added: number | null;
  html_removed: number | null;
  significant: boolean;
  summary: string;
  regions: DiffRegion[] | null;
  diff_image_key: string | null;
  text_diff: TextDiffResult | null;
  html_diff: HtmlDiffResult | null;
  truncated: boolean;
  duration_ms: number | null;
  monitor_name?: string;
  monitor_url?: string;
}

export function mapChange(row: ChangeRow): Change {
  return {
    id: row.id,
    monitorId: row.monitor_id,
    fromSnapshotId: row.from_snapshot_id,
    toSnapshotId: row.to_snapshot_id,
    createdAt: iso(row.created_at) ?? '',
    pixelDiffPercent: row.pixel_diff_percent,
    changedPixels: row.changed_pixels,
    totalPixels: row.total_pixels,
    sizeChanged: row.size_changed,
    sizeFrom:
      row.size_from_width !== null && row.size_from_height !== null
        ? { width: row.size_from_width, height: row.size_from_height }
        : null,
    sizeTo:
      row.size_to_width !== null && row.size_to_height !== null
        ? { width: row.size_to_width, height: row.size_to_height }
        : null,
    textAdded: row.text_added,
    textRemoved: row.text_removed,
    htmlAdded: row.html_added,
    htmlRemoved: row.html_removed,
    significant: row.significant,
    summary: row.summary,
    regions: row.regions ?? [],
    hasDiffImage: row.diff_image_key !== null,
  };
}
export interface MonitorSummaryRow {
  id: string;
  name: string;
  url: string;
  enabled: boolean;
  paused: boolean;
  tags: string[];
  schedule_cron: string;
  last_run_at: Date | null;
  last_change_at: Date | null;
  consecutive_failures: number;
  change_threshold: number;
  latest_snapshot_id: string | null;
  latest_screenshot_key: string | null;
  latest_captured_at: Date | null;
  recent_change_count: number;
  pending_change_count: number;
  created_at: Date;
}

export function mapMonitorSummary(
  row: MonitorSummaryRow,
  options: { nextRunAt: string | null; scheduleDescription: string; sparkline: number[] },
): MonitorSummary {
  const status: MonitorStatus =
    row.consecutive_failures > 0
      ? deriveMonitorStatus(row)
      : row.pending_change_count > 0
        ? 'changed'
        : deriveMonitorStatus(row);

  return {
    id: row.id,
    name: row.name,
    url: row.url,
    enabled: row.enabled,
    paused: row.paused,
    status,
    tags: row.tags ?? [],
    scheduleDescription: options.scheduleDescription,
    nextRunAt: options.nextRunAt,
    lastRunAt: iso(row.last_run_at),
    lastCheckedAt: iso(row.latest_captured_at),
    lastChangeAt: iso(row.last_change_at),
    latestScreenshotUrl: row.latest_screenshot_key
      ? `/api/v1/snapshots/${row.latest_snapshot_id}/screenshot`
      : null,
    latestSnapshotId: row.latest_snapshot_id,
    recentChangeCount: row.recent_change_count,
    changeSparkline: options.sparkline,
    consecutiveFailures: row.consecutive_failures,
    changeThreshold: row.change_threshold,
  };
}
export interface ChannelRow {
  id: string;
  name: string;
  type: 'webhook' | 'slack' | 'email';
  enabled: boolean;
  config: Record<string, unknown>;
  config_enc: string | null;
  last_notified_at: Date | null;
  last_error: string | null;
  created_at: Date;
  updated_at: Date;
}

export function mapChannel(row: ChannelRow): NotificationChannel {
  return {
    id: row.id,
    name: row.name,
    type: row.type,
    enabled: row.enabled,
    config: row.config ?? {},
    createdAt: iso(row.created_at) ?? '',
    updatedAt: iso(row.updated_at) ?? '',
  };
}
