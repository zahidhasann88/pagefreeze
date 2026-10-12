import { describeCron, nextRunAfterExpression, scheduleToCron } from '@pagefreeze/shared';
import type { Database } from './pool.js';
import { decodeTimeIdCursor, encodeTimeIdCursor } from './cursor.js';
import {
  mapChange,
  mapChannel,
  mapMonitor,
  mapMonitorSummary,
  mapSnapshot,
  type ChangeRow,
  type ChannelRow,
  type MonitorRow,
  type MonitorSecretsRow,
  type MonitorSummaryRow,
  type SnapshotRow,
} from './rows.js';
import type {
  Change,
  Monitor,
  MonitorSummary,
  NotificationChannel,
  Snapshot,
} from '@pagefreeze/shared';
import type { HtmlDiffResult } from '../diff/html.js';
import type { TextDiffResult } from '../diff/text.js';
import type { DiffRegion } from '@pagefreeze/shared';

/**
 * All SQL in the application lives in this module. Route handlers and jobs never build
 * queries themselves, which keeps the storage shape changeable in one place.
 */

const MONITOR_COLUMNS = `
  id, name, url, enabled, paused, schedule_kind, schedule_value, schedule_cron,
  device_preset, viewport_width, viewport_height, full_page, wait_strategy, wait_selector,
  extra_delay_ms, capture_selector, ignore_selectors, user_agent, change_threshold,
  detect_text, detect_html, retention_days, tags, consecutive_failures, failure_notified,
  last_run_at, last_snapshot_at, last_change_at, created_at, updated_at
`;

export interface MonitorInsert {
  name: string;
  url: string;
  enabled: boolean;
  scheduleKind: 'preset' | 'cron';
  scheduleValue: string;
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
  changeThreshold: number;
  detectText: boolean;
  detectHtml: boolean;
  retentionDays: number | null;
  tags: string[];
  headersEnc: string | null;
  cookiesEnc: string | null;
  headerNames: string[];
  cookieNames: string[];
}

export interface MonitorUpdate extends Partial<MonitorInsert> {
  paused?: boolean;
}

/* -------------------------------------------------------------------------- */
/* Monitors                                                                    */
/* -------------------------------------------------------------------------- */

async function loadSecrets(db: Database, monitorId: string): Promise<MonitorSecretsRow | null> {
  const result = await db.query<MonitorSecretsRow>(
    `SELECT monitor_id, headers_enc, cookies_enc, header_names, cookie_names, updated_at
       FROM monitor_secrets WHERE monitor_id = $1`,
    [monitorId],
  );
  return result.rows[0] ?? null;
}

async function loadChannelIds(db: Database, monitorIds: string[]): Promise<Map<string, string[]>> {
  const map = new Map<string, string[]>();
  for (const id of monitorIds) map.set(id, []);
  if (monitorIds.length === 0) return map;

  const result = await db.query<{ monitor_id: string; channel_id: string }>(
    `SELECT monitor_id, channel_id FROM monitor_channels WHERE monitor_id = ANY($1::uuid[])`,
    [monitorIds],
  );
  for (const row of result.rows) {
    const list = map.get(row.monitor_id) ?? [];
    list.push(row.channel_id);
    map.set(row.monitor_id, list);
  }
  return map;
}

export async function getMonitor(db: Database, id: string): Promise<Monitor | null> {
  const result = await db.query<MonitorRow>(
    `SELECT ${MONITOR_COLUMNS} FROM monitors WHERE id = $1`,
    [id],
  );
  const row = result.rows[0];
  if (!row) return null;

  const [secrets, channelMap] = await Promise.all([loadSecrets(db, id), loadChannelIds(db, [id])]);

  const monitor = mapMonitor({ row, secrets, channelIds: channelMap.get(id) ?? [] });
  return withScheduleInfo(monitor);
}

/** Fill in the derived schedule fields that are not stored as columns. */
export function withScheduleInfo(monitor: Monitor): Monitor {
  return {
    ...monitor,
    scheduleDescription:
      monitor.scheduleKind === 'cron'
        ? describeCron(monitor.scheduleValue)
        : describeCron(scheduleToCron(monitor.scheduleKind, monitor.scheduleValue)),
    nextRunAt:
      monitor.enabled && !monitor.paused
        ? (nextRunAfterExpression(monitor.scheduleCron, new Date())?.toISOString() ?? null)
        : null,
  };
}

export interface MonitorListFilters {
  status?: 'ok' | 'changed' | 'failing' | 'paused' | 'all';
  tag?: string;
  q?: string;
  limit: number;
  cursor?: string | null;
}

export async function listMonitors(
  db: Database,
  filters: MonitorListFilters,
): Promise<{ data: MonitorSummary[]; nextCursor: string | null }> {
  const where: string[] = [];
  const params: unknown[] = [];

  if (filters.tag) {
    params.push(filters.tag);
    where.push(`m.tags @> ARRAY[$${params.length}]::text[]`);
  }
  if (filters.q) {
    params.push(`%${filters.q}%`);
    where.push(`(m.name ILIKE $${params.length} OR m.url ILIKE $${params.length})`);
  }
  if (filters.status === 'paused') {
    where.push('(m.enabled = false OR m.paused = true)');
  } else if (filters.status === 'failing') {
    where.push('m.consecutive_failures > 0 AND m.enabled = true AND m.paused = false');
  } else if (filters.status === 'ok' || filters.status === 'changed') {
    where.push('m.consecutive_failures = 0 AND m.enabled = true AND m.paused = false');
  }

  const decoded = decodeTimeIdCursor(filters.cursor);
  if (decoded) {
    params.push(decoded.at.toISOString(), decoded.id);
    where.push(
      `(m.created_at, m.id) < ($${params.length - 1}::timestamptz, $${params.length}::uuid)`,
    );
  }

  params.push(filters.limit + 1);
  const limitParam = params.length;

  const whereSql = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';

  const result = await db.query<MonitorSummaryRow>(
    `SELECT
       m.id, m.name, m.url, m.enabled, m.paused, m.tags, m.schedule_cron,
       m.last_run_at, m.last_change_at, m.consecutive_failures, m.change_threshold,
       m.created_at,
       ls.id                AS latest_snapshot_id,
       ls.screenshot_key    AS latest_screenshot_key,
       ls.captured_at       AS latest_captured_at,
       COALESCE(rc.cnt, 0)  AS recent_change_count,
       COALESCE(pc.cnt, 0)  AS pending_change_count
     FROM monitors m
     LEFT JOIN LATERAL (
       SELECT s.id, s.screenshot_key, s.captured_at
         FROM snapshots s
        WHERE s.monitor_id = m.id AND s.status = 'success'
        ORDER BY s.captured_at DESC
        LIMIT 1
     ) ls ON true
     LEFT JOIN LATERAL (
       SELECT count(*)::int AS cnt FROM changes c
        WHERE c.monitor_id = m.id AND c.created_at > now() - interval '30 days'
     ) rc ON true
     LEFT JOIN LATERAL (
       SELECT count(*)::int AS cnt FROM changes c
        WHERE c.monitor_id = m.id AND c.significant = true
          AND c.created_at > now() - interval '7 days'
     ) pc ON true
     ${whereSql}
     ORDER BY m.created_at DESC, m.id DESC
     LIMIT $${limitParam}`,
    params,
  );

  const rows = result.rows;
  const hasMore = rows.length > filters.limit;
  const pageRows = hasMore ? rows.slice(0, filters.limit) : rows;

  const sparklines = await loadSparklines(
    db,
    pageRows.map((row) => row.id),
  );

  const data = pageRows.map((row) =>
    mapMonitorSummary(row, {
      nextRunAt:
        row.enabled && !row.paused
          ? (nextRunAfterExpression(row.schedule_cron, new Date())?.toISOString() ?? null)
          : null,
      scheduleDescription: describeCron(row.schedule_cron),
      sparkline: sparklines.get(row.id) ?? new Array<number>(14).fill(0),
    }),
  );

  const last = pageRows[pageRows.length - 1];
  const nextCursor = hasMore && last ? encodeTimeIdCursor(last.created_at, last.id) : null;

  return { data, nextCursor };
}

/** Change counts per monitor per day for the last 14 days, oldest bucket first. */
async function loadSparklines(db: Database, monitorIds: string[]): Promise<Map<string, number[]>> {
  const map = new Map<string, number[]>();
  if (monitorIds.length === 0) return map;

  const result = await db.query<{ monitor_id: string; day: number; cnt: number }>(
    `SELECT monitor_id,
            floor(extract(epoch from (date_trunc('day', now()) - date_trunc('day', created_at))) / 86400)::int AS day,
            count(*)::int AS cnt
       FROM changes
      WHERE monitor_id = ANY($1::uuid[])
        AND created_at > date_trunc('day', now()) - interval '13 days'
      GROUP BY monitor_id, day`,
    [monitorIds],
  );

  for (const id of monitorIds) map.set(id, new Array<number>(14).fill(0));
  for (const row of result.rows) {
    const bucket = map.get(row.monitor_id);
    if (!bucket) continue;
    // day 0 = today -> last slot
    const index = 13 - row.day;
    if (index >= 0 && index < 14) bucket[index] = row.cnt;
  }
  return map;
}

export async function createMonitor(db: Database, input: MonitorInsert): Promise<Monitor> {
  const cron = scheduleToCron(input.scheduleKind, input.scheduleValue);

  return db.transaction(async (client) => {
    const inserted = await client.query<MonitorRow>(
      `INSERT INTO monitors (
         name, url, enabled, schedule_kind, schedule_value, schedule_cron, device_preset,
         viewport_width, viewport_height, full_page, wait_strategy, wait_selector,
         extra_delay_ms, capture_selector, ignore_selectors, user_agent, change_threshold,
         detect_text, detect_html, retention_days, tags
       ) VALUES (
         $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21
       ) RETURNING ${MONITOR_COLUMNS}`,
      [
        input.name,
        input.url,
        input.enabled,
        input.scheduleKind,
        input.scheduleValue,
        cron,
        input.devicePreset,
        input.viewportWidth,
        input.viewportHeight,
        input.fullPage,
        input.waitStrategy,
        input.waitSelector,
        input.extraDelayMs,
        input.captureSelector,
        input.ignoreSelectors,
        input.userAgent,
        input.changeThreshold,
        input.detectText,
        input.detectHtml,
        input.retentionDays,
        input.tags,
      ],
    );

    const row = inserted.rows[0]!;

    await client.query(
      `INSERT INTO monitor_secrets (monitor_id, headers_enc, cookies_enc, header_names, cookie_names)
       VALUES ($1,$2,$3,$4,$5)`,
      [row.id, input.headersEnc, input.cookiesEnc, input.headerNames, input.cookieNames],
    );

    return withScheduleInfo(mapMonitor({ row, secrets: null, channelIds: [] }));
  });
}

const MONITOR_FIELD_COLUMNS: Record<string, string> = {
  name: 'name',
  url: 'url',
  enabled: 'enabled',
  devicePreset: 'device_preset',
  viewportWidth: 'viewport_width',
  viewportHeight: 'viewport_height',
  fullPage: 'full_page',
  waitStrategy: 'wait_strategy',
  waitSelector: 'wait_selector',
  extraDelayMs: 'extra_delay_ms',
  captureSelector: 'capture_selector',
  ignoreSelectors: 'ignore_selectors',
  userAgent: 'user_agent',
  changeThreshold: 'change_threshold',
  detectText: 'detect_text',
  detectHtml: 'detect_html',
  retentionDays: 'retention_days',
  tags: 'tags',
  paused: 'paused',
};

export async function updateMonitor(
  db: Database,
  id: string,
  input: MonitorUpdate,
): Promise<Monitor | null> {
  const sets: string[] = [];
  const params: unknown[] = [];

  const push = (column: string, value: unknown): void => {
    params.push(value);
    sets.push(`${column} = $${params.length}`);
  };

  for (const [key, column] of Object.entries(MONITOR_FIELD_COLUMNS)) {
    const value = (input as Record<string, unknown>)[key];
    if (value !== undefined) push(column, value);
  }

  if (input.scheduleKind !== undefined && input.scheduleValue !== undefined) {
    push('schedule_kind', input.scheduleKind);
    push('schedule_value', input.scheduleValue);
    push('schedule_cron', scheduleToCron(input.scheduleKind, input.scheduleValue));
  }

  const secretsChanged =
    input.headersEnc !== undefined ||
    input.cookiesEnc !== undefined ||
    input.headerNames !== undefined ||
    input.cookieNames !== undefined;

  if (sets.length === 0 && !secretsChanged) {
    return getMonitor(db, id);
  }

  return db.transaction(async (client) => {
    if (sets.length > 0) {
      params.push(id);
      const updated = await client.query<MonitorRow>(
        `UPDATE monitors SET ${sets.join(', ')}, updated_at = now()
          WHERE id = $${params.length}
        RETURNING ${MONITOR_COLUMNS}`,
        params,
      );
      if (updated.rows[0] === undefined) return null;
    }

    if (secretsChanged) {
      await client.query(
        `INSERT INTO monitor_secrets (monitor_id, headers_enc, cookies_enc, header_names, cookie_names)
         VALUES ($1,$2,$3,COALESCE($4::text[], '{}'),COALESCE($5::text[], '{}'))
         ON CONFLICT (monitor_id) DO UPDATE SET
           headers_enc = COALESCE(EXCLUDED.headers_enc, monitor_secrets.headers_enc),
           cookies_enc = COALESCE(EXCLUDED.cookies_enc, monitor_secrets.cookies_enc),
           header_names = COALESCE($4::text[], monitor_secrets.header_names),
           cookie_names = COALESCE($5::text[], monitor_secrets.cookie_names),
           updated_at = now()`,
        [
          id,
          input.headersEnc ?? null,
          input.cookiesEnc ?? null,
          input.headerNames ?? null,
          input.cookieNames ?? null,
        ],
      );
    }

    const result = await client.query<MonitorRow>(
      `SELECT ${MONITOR_COLUMNS} FROM monitors WHERE id = $1`,
      [id],
    );
    const row = result.rows[0];
    if (!row) return null;

    const secretsResult = await client.query<MonitorSecretsRow>(
      `SELECT monitor_id, headers_enc, cookies_enc, header_names, cookie_names, updated_at
         FROM monitor_secrets WHERE monitor_id = $1`,
      [id],
    );
    const channelResult = await client.query<{ channel_id: string }>(
      `SELECT channel_id FROM monitor_channels WHERE monitor_id = $1`,
      [id],
    );

    return withScheduleInfo(
      mapMonitor({
        row,
        secrets: secretsResult.rows[0] ?? null,
        channelIds: channelResult.rows.map((r) => r.channel_id),
      }),
    );
  });
}

export async function deleteMonitor(db: Database, id: string): Promise<boolean> {
  const result = await db.query('DELETE FROM monitors WHERE id = $1', [id]);
  return (result.rowCount ?? 0) > 0;
}

export async function setMonitorPaused(
  db: Database,
  id: string,
  paused: boolean,
): Promise<Monitor | null> {
  return updateMonitor(db, id, { paused });
}

export async function setMonitorChannels(
  db: Database,
  monitorId: string,
  channelIds: string[],
): Promise<void> {
  await db.transaction(async (client) => {
    await client.query('DELETE FROM monitor_channels WHERE monitor_id = $1', [monitorId]);
    if (channelIds.length === 0) return;
    const unique = [...new Set(channelIds)];
    await client.query(
      `INSERT INTO monitor_channels (monitor_id, channel_id)
       SELECT $1, unnest($2::uuid[])
       ON CONFLICT DO NOTHING`,
      [monitorId, unique],
    );
  });
}

export async function listEnabledMonitorIds(db: Database): Promise<string[]> {
  const result = await db.query<{ id: string }>(
    `SELECT id FROM monitors WHERE enabled = true AND paused = false`,
  );
  return result.rows.map((row) => row.id);
}

export async function listAllMonitorsForScheduling(
  db: Database,
): Promise<Array<Pick<Monitor, 'id' | 'enabled' | 'paused'> & { scheduleCron: string }>> {
  const result = await db.query<{
    id: string;
    enabled: boolean;
    paused: boolean;
    schedule_cron: string;
  }>(`SELECT id, enabled, paused, schedule_cron FROM monitors`);
  return result.rows.map((row) => ({
    id: row.id,
    enabled: row.enabled,
    paused: row.paused,
    scheduleCron: row.schedule_cron,
  }));
}

export async function recordMonitorRun(db: Database, id: string, at: Date): Promise<void> {
  await db.query(`UPDATE monitors SET last_run_at = $2 WHERE id = $1`, [id, at.toISOString()]);
}

export async function incrementConsecutiveFailures(
  db: Database,
  id: string,
): Promise<{ consecutiveFailures: number; failureNotified: boolean }> {
  const result = await db.query<{ consecutive_failures: number; failure_notified: boolean }>(
    `UPDATE monitors
        SET consecutive_failures = consecutive_failures + 1,
            last_run_at = now(),
            updated_at = now()
      WHERE id = $1
      RETURNING consecutive_failures, failure_notified`,
    [id],
  );
  const row = result.rows[0];
  return {
    consecutiveFailures: row?.consecutive_failures ?? 0,
    failureNotified: row?.failure_notified ?? false,
  };
}

/**
 * Clear the failure streak after a successful capture and report what the streak was,
 * so the caller can decide whether a recovery notification is due.
 *
 * The CTE reads the old values in the same statement as the update: a separate SELECT
 * would already see the reset row.
 */
export async function resetConsecutiveFailures(
  db: Database,
  id: string,
): Promise<{ previousFailures: number; wasNotified: boolean }> {
  const result = await db.query<{ previous_failures: number; was_notified: boolean }>(
    `WITH previous AS (
       SELECT consecutive_failures AS previous_failures, failure_notified AS was_notified
         FROM monitors WHERE id = $1
     ), updated AS (
       UPDATE monitors
          SET consecutive_failures = 0,
              failure_notified = false,
              last_run_at = now(),
              last_snapshot_at = now(),
              updated_at = now()
        WHERE id = $1
       RETURNING id
     )
     SELECT previous_failures, was_notified FROM previous WHERE EXISTS (SELECT 1 FROM updated)`,
    [id],
  );
  const row = result.rows[0];
  return {
    previousFailures: row?.previous_failures ?? 0,
    wasNotified: row?.was_notified ?? false,
  };
}

export async function markFailureNotified(db: Database, id: string): Promise<void> {
  await db.query(`UPDATE monitors SET failure_notified = true WHERE id = $1`, [id]);
}

export async function touchMonitorSnapshot(db: Database, id: string, at: Date): Promise<void> {
  await db.query(
    `UPDATE monitors SET last_snapshot_at = $2, last_run_at = $2, updated_at = now() WHERE id = $1`,
    [id, at.toISOString()],
  );
}

export async function touchMonitorChange(db: Database, id: string, at: Date): Promise<void> {
  await db.query(
    `UPDATE monitors SET last_change_at = $2, last_snapshot_at = $2, updated_at = now() WHERE id = $1`,
    [id, at.toISOString()],
  );
}

/** Read the encrypted secret blobs for a monitor (capture path only). */
export async function getMonitorSecrets(
  db: Database,
  monitorId: string,
): Promise<{ headersEnc: string | null; cookiesEnc: string | null } | null> {
  const result = await loadSecrets(db, monitorId);
  if (!result) return null;
  return { headersEnc: result.headers_enc, cookiesEnc: result.cookies_enc };
}

/* -------------------------------------------------------------------------- */
/* Snapshots                                                                   */
/* -------------------------------------------------------------------------- */

export interface SnapshotInsert {
  /**
   * Supplied by the caller so the row id matches the storage keys derived from it. Letting
   * Postgres mint the id would leave artefacts on disk under a path that no row points at.
   */
  id: string;
  monitorId: string;
  status: 'success' | 'failed';
  capturedAt: Date;
  finalUrl: string | null;
  httpStatus: number | null;
  loadDurationMs: number | null;
  title: string | null;
  errorMessage: string | null;
  screenshotKey: string | null;
  htmlKey: string | null;
  textKey: string | null;
  screenshotWidth: number | null;
  screenshotHeight: number | null;
  screenshotHash: string | null;
  htmlHash: string | null;
  textHash: string | null;
  duplicateOf: string | null;
  bytes: number | null;
  requestCount: number | null;
  hiddenElementCount: number | null;
  blockedRequestCount: number;
}

export async function insertSnapshot(db: Database, input: SnapshotInsert): Promise<Snapshot> {
  const result = await db.query<SnapshotRow>(
    `INSERT INTO snapshots (
       id, monitor_id, status, captured_at, final_url, http_status, load_duration_ms, title,
       error_message, screenshot_key, html_key, text_key, screenshot_width, screenshot_height,
       screenshot_hash, html_hash, text_hash, duplicate_of, bytes, request_count,
       hidden_element_count, blocked_request_count
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22)
     RETURNING *`,
    [
      input.id,
      input.monitorId,
      input.status,
      input.capturedAt.toISOString(),
      input.finalUrl,
      input.httpStatus,
      input.loadDurationMs,
      input.title,
      input.errorMessage,
      input.screenshotKey,
      input.htmlKey,
      input.textKey,
      input.screenshotWidth,
      input.screenshotHeight,
      input.screenshotHash,
      input.htmlHash,
      input.textHash,
      input.duplicateOf,
      input.bytes,
      input.requestCount,
      input.hiddenElementCount,
      input.blockedRequestCount,
    ],
  );
  return mapSnapshot(result.rows[0]!);
}

export interface SnapshotListFilters {
  status?: 'success' | 'failed' | 'all';
  limit: number;
  cursor?: string | null;
}

export async function listSnapshots(
  db: Database,
  monitorId: string,
  filters: SnapshotListFilters,
): Promise<{ data: Snapshot[]; nextCursor: string | null }> {
  const where: string[] = ['s.monitor_id = $1'];
  const params: unknown[] = [monitorId];

  if (filters.status && filters.status !== 'all') {
    params.push(filters.status);
    where.push(`s.status = $${params.length}`);
  }

  const decoded = decodeTimeIdCursor(filters.cursor);
  if (decoded) {
    params.push(decoded.at.toISOString(), decoded.id);
    where.push(
      `(s.captured_at, s.id) < ($${params.length - 1}::timestamptz, $${params.length}::uuid)`,
    );
  }

  params.push(filters.limit + 1);

  const result = await db.query<SnapshotRow>(
    `SELECT s.*, c.id AS change_id
       FROM snapshots s
       LEFT JOIN changes c ON c.to_snapshot_id = s.id
      WHERE ${where.join(' AND ')}
      ORDER BY s.captured_at DESC, s.id DESC
      LIMIT $${params.length}`,
    params,
  );

  const rows = result.rows;
  const hasMore = rows.length > filters.limit;
  const pageRows = hasMore ? rows.slice(0, filters.limit) : rows;
  const last = pageRows[pageRows.length - 1];

  return {
    data: pageRows.map(mapSnapshot),
    nextCursor: hasMore && last ? encodeTimeIdCursor(last.captured_at, last.id) : null,
  };
}

export async function getSnapshot(db: Database, id: string): Promise<Snapshot | null> {
  const result = await db.query<SnapshotRow>(
    `SELECT s.*, c.id AS change_id FROM snapshots s
       LEFT JOIN changes c ON c.to_snapshot_id = s.id
      WHERE s.id = $1`,
    [id],
  );
  const row = result.rows[0];
  return row ? mapSnapshot(row) : null;
}

export interface SnapshotRowWithKeys extends SnapshotRow {
  monitor_url?: string;
  monitor_name?: string;
}

export async function getSnapshotRow(
  db: Database,
  id: string,
): Promise<SnapshotRowWithKeys | null> {
  const result = await db.query<SnapshotRowWithKeys>(
    `SELECT s.*, m.url AS monitor_url, m.name AS monitor_name
       FROM snapshots s JOIN monitors m ON m.id = s.monitor_id
      WHERE s.id = $1`,
    [id],
  );
  return result.rows[0] ?? null;
}

/**
 * The most recent successful snapshot *before* the given one. This is the baseline a
 * new capture is compared against; failed snapshots are never a baseline.
 */
export async function getPreviousSuccessfulSnapshot(
  db: Database,
  monitorId: string,
  beforeCapturedAt: Date,
  excludeId?: string,
): Promise<SnapshotRowWithKeys | null> {
  const params: unknown[] = [monitorId, beforeCapturedAt.toISOString()];
  let extra = '';
  if (excludeId) {
    params.push(excludeId);
    extra = `AND s.id <> $${params.length}`;
  }

  const result = await db.query<SnapshotRowWithKeys>(
    `SELECT s.*, m.url AS monitor_url, m.name AS monitor_name
       FROM snapshots s JOIN monitors m ON m.id = s.monitor_id
      WHERE s.monitor_id = $1
        AND s.status = 'success'
        AND s.captured_at < $2::timestamptz
        ${extra}
      ORDER BY s.captured_at DESC, s.id DESC
      LIMIT 1`,
    params,
  );
  return result.rows[0] ?? null;
}

export async function getLatestSuccessfulSnapshot(
  db: Database,
  monitorId: string,
): Promise<SnapshotRowWithKeys | null> {
  const result = await db.query<SnapshotRowWithKeys>(
    `SELECT s.*, m.url AS monitor_url, m.name AS monitor_name
       FROM snapshots s JOIN monitors m ON m.id = s.monitor_id
      WHERE s.monitor_id = $1 AND s.status = 'success'
      ORDER BY s.captured_at DESC, s.id DESC
      LIMIT 1`,
    [monitorId],
  );
  return result.rows[0] ?? null;
}

/** Find an earlier snapshot whose screenshot hash matches, for duplicate skipping. */
export async function findSnapshotByScreenshotHash(
  db: Database,
  monitorId: string,
  hash: string,
): Promise<SnapshotRow | null> {
  const result = await db.query<SnapshotRow>(
    `SELECT * FROM snapshots
      WHERE monitor_id = $1 AND screenshot_hash = $2 AND status = 'success'
      ORDER BY captured_at DESC LIMIT 1`,
    [monitorId, hash],
  );
  return result.rows[0] ?? null;
}

export async function deleteSnapshotFiles(db: Database, ids: string[]): Promise<string[]> {
  if (ids.length === 0) return [];
  const result = await db.query<{ key: string }>(
    `SELECT unnest(ARRAY[screenshot_key, html_key, text_key]) AS key
       FROM snapshots WHERE id = ANY($1::uuid[])`,
    [ids],
  );
  return result.rows.map((row) => row.key).filter((key): key is string => Boolean(key));
}

/* -------------------------------------------------------------------------- */
/* Changes                                                                     */
/* -------------------------------------------------------------------------- */

export interface ChangeInsert {
  monitorId: string;
  fromSnapshotId: string | null;
  toSnapshotId: string;
  pixelDiffPercent: number | null;
  changedPixels: number | null;
  totalPixels: number | null;
  sizeChanged: boolean;
  sizeFrom: { width: number; height: number } | null;
  sizeTo: { width: number; height: number } | null;
  textAdded: number | null;
  textRemoved: number | null;
  htmlAdded: number | null;
  htmlRemoved: number | null;
  significant: boolean;
  summary: string;
  regions: DiffRegion[];
  diffImageKey: string | null;
  textDiff: TextDiffResult | null;
  htmlDiff: HtmlDiffResult | null;
  truncated: boolean;
  durationMs: number | null;
}

export async function insertChange(db: Database, input: ChangeInsert): Promise<Change> {
  const result = await db.query<ChangeRow>(
    `INSERT INTO changes (
       monitor_id, from_snapshot_id, to_snapshot_id, pixel_diff_percent, changed_pixels,
       total_pixels, size_changed, size_from_width, size_from_height, size_to_width,
       size_to_height, text_added, text_removed, html_added, html_removed, significant,
       summary, regions, diff_image_key, text_diff, html_diff, truncated, duration_ms
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23)
     ON CONFLICT (to_snapshot_id) DO UPDATE SET
       from_snapshot_id = EXCLUDED.from_snapshot_id,
       pixel_diff_percent = EXCLUDED.pixel_diff_percent,
       changed_pixels = EXCLUDED.changed_pixels,
       total_pixels = EXCLUDED.total_pixels,
       size_changed = EXCLUDED.size_changed,
       size_from_width = EXCLUDED.size_from_width,
       size_from_height = EXCLUDED.size_from_height,
       size_to_width = EXCLUDED.size_to_width,
       size_to_height = EXCLUDED.size_to_height,
       text_added = EXCLUDED.text_added,
       text_removed = EXCLUDED.text_removed,
       html_added = EXCLUDED.html_added,
       html_removed = EXCLUDED.html_removed,
       significant = EXCLUDED.significant,
       summary = EXCLUDED.summary,
       regions = EXCLUDED.regions,
       diff_image_key = EXCLUDED.diff_image_key,
       text_diff = EXCLUDED.text_diff,
       html_diff = EXCLUDED.html_diff,
       truncated = EXCLUDED.truncated,
       duration_ms = EXCLUDED.duration_ms
     RETURNING *`,
    [
      input.monitorId,
      input.fromSnapshotId,
      input.toSnapshotId,
      input.pixelDiffPercent,
      input.changedPixels,
      input.totalPixels,
      input.sizeChanged,
      input.sizeFrom?.width ?? null,
      input.sizeFrom?.height ?? null,
      input.sizeTo?.width ?? null,
      input.sizeTo?.height ?? null,
      input.textAdded,
      input.textRemoved,
      input.htmlAdded,
      input.htmlRemoved,
      input.significant,
      input.summary,
      JSON.stringify(input.regions),
      input.diffImageKey,
      input.textDiff ? JSON.stringify(input.textDiff) : null,
      input.htmlDiff ? JSON.stringify(input.htmlDiff) : null,
      input.truncated,
      input.durationMs,
    ],
  );
  return mapChange(result.rows[0]!);
}

export async function getChange(db: Database, id: string): Promise<ChangeRow | null> {
  const result = await db.query<ChangeRow>(
    `SELECT c.*, m.name AS monitor_name, m.url AS monitor_url
       FROM changes c JOIN monitors m ON m.id = c.monitor_id
      WHERE c.id = $1`,
    [id],
  );
  return result.rows[0] ?? null;
}

export async function getChangeById(db: Database, id: string): Promise<Change | null> {
  const row = await getChange(db, id);
  return row ? mapChange(row) : null;
}

export interface ChangeListFilters {
  significant?: 'true' | 'false' | 'all';
  limit: number;
  cursor?: string | null;
}

export async function listChanges(
  db: Database,
  monitorId: string,
  filters: ChangeListFilters,
): Promise<{ data: Change[]; nextCursor: string | null }> {
  const where: string[] = ['c.monitor_id = $1'];
  const params: unknown[] = [monitorId];

  if (filters.significant === 'true') where.push('c.significant = true');
  else if (filters.significant === 'false') where.push('c.significant = false');

  const decoded = decodeTimeIdCursor(filters.cursor);
  if (decoded) {
    params.push(decoded.at.toISOString(), decoded.id);
    where.push(
      `(c.created_at, c.id) < ($${params.length - 1}::timestamptz, $${params.length}::uuid)`,
    );
  }

  params.push(filters.limit + 1);

  // text_diff / html_diff are deliberately excluded from lists: they are large and the
  // list view only needs the stats.
  const result = await db.query<ChangeRow>(
    `SELECT c.id, c.monitor_id, c.from_snapshot_id, c.to_snapshot_id, c.created_at,
            c.pixel_diff_percent, c.changed_pixels, c.total_pixels, c.size_changed,
            c.size_from_width, c.size_from_height, c.size_to_width, c.size_to_height,
            c.text_added, c.text_removed, c.html_added, c.html_removed, c.significant,
            c.summary, c.regions, c.diff_image_key, c.truncated, c.duration_ms,
            NULL::jsonb AS text_diff, NULL::jsonb AS html_diff
       FROM changes c
      WHERE ${where.join(' AND ')}
      ORDER BY c.created_at DESC, c.id DESC
      LIMIT $${params.length}`,
    params,
  );

  const rows = result.rows;
  const hasMore = rows.length > filters.limit;
  const pageRows = hasMore ? rows.slice(0, filters.limit) : rows;
  const last = pageRows[pageRows.length - 1];

  return {
    data: pageRows.map(mapChange),
    nextCursor: hasMore && last ? encodeTimeIdCursor(last.created_at, last.id) : null,
  };
}

/** The change that follows `id` for the same monitor (older direction), for prev/next nav. */
export async function getNeighbouringChangeIds(
  db: Database,
  monitorId: string,
  changeId: string,
): Promise<{ newer: string | null; older: string | null }> {
  const current = await db.query<{ created_at: Date }>(
    `SELECT created_at FROM changes WHERE id = $1`,
    [changeId],
  );
  const at = current.rows[0]?.created_at;
  if (!at) return { newer: null, older: null };

  const [newer, older] = await Promise.all([
    db.query<{ id: string }>(
      `SELECT id FROM changes
        WHERE monitor_id = $1 AND (created_at, id) > ($2::timestamptz, $3::uuid)
        ORDER BY created_at ASC, id ASC LIMIT 1`,
      [monitorId, at.toISOString(), changeId],
    ),
    db.query<{ id: string }>(
      `SELECT id FROM changes
        WHERE monitor_id = $1 AND (created_at, id) < ($2::timestamptz, $3::uuid)
        ORDER BY created_at DESC, id DESC LIMIT 1`,
      [monitorId, at.toISOString(), changeId],
    ),
  ]);

  return {
    newer: newer.rows[0]?.id ?? null,
    older: older.rows[0]?.id ?? null,
  };
}

export async function getLatestChangeForMonitor(
  db: Database,
  monitorId: string,
): Promise<Change | null> {
  const result = await db.query<ChangeRow>(
    `SELECT c.*, NULL::jsonb AS text_diff, NULL::jsonb AS html_diff
       FROM changes c WHERE c.monitor_id = $1
      ORDER BY c.created_at DESC LIMIT 1`,
    [monitorId],
  );
  const row = result.rows[0];
  return row ? mapChange(row) : null;
}

/* -------------------------------------------------------------------------- */
/* Notification channels                                                       */
/* -------------------------------------------------------------------------- */

export interface ChannelInsert {
  name: string;
  type: 'webhook' | 'slack' | 'email';
  enabled: boolean;
  config: Record<string, unknown>;
  configEnc: string | null;
}

export async function createChannel(
  db: Database,
  input: ChannelInsert,
): Promise<NotificationChannel> {
  const result = await db.query<ChannelRow>(
    `INSERT INTO notification_channels (name, type, enabled, config, config_enc)
     VALUES ($1,$2,$3,$4,$5) RETURNING *`,
    [input.name, input.type, input.enabled, JSON.stringify(input.config), input.configEnc],
  );
  return mapChannel(result.rows[0]!);
}

export async function updateChannel(
  db: Database,
  id: string,
  input: Partial<ChannelInsert>,
): Promise<NotificationChannel | null> {
  const sets: string[] = [];
  const params: unknown[] = [];

  if (input.name !== undefined) {
    params.push(input.name);
    sets.push(`name = $${params.length}`);
  }
  if (input.type !== undefined) {
    params.push(input.type);
    sets.push(`type = $${params.length}`);
  }
  if (input.enabled !== undefined) {
    params.push(input.enabled);
    sets.push(`enabled = $${params.length}`);
  }
  if (input.config !== undefined) {
    params.push(JSON.stringify(input.config));
    sets.push(`config = $${params.length}`);
  }
  if (input.configEnc !== undefined) {
    params.push(input.configEnc);
    sets.push(`config_enc = $${params.length}`);
  }

  if (sets.length === 0) return getChannel(db, id);

  params.push(id);
  const result = await db.query<ChannelRow>(
    `UPDATE notification_channels SET ${sets.join(', ')}, updated_at = now()
      WHERE id = $${params.length} RETURNING *`,
    params,
  );
  const row = result.rows[0];
  return row ? mapChannel(row) : null;
}

export async function getChannel(db: Database, id: string): Promise<NotificationChannel | null> {
  const result = await db.query<ChannelRow>(`SELECT * FROM notification_channels WHERE id = $1`, [
    id,
  ]);
  const row = result.rows[0];
  return row ? mapChannel(row) : null;
}

export async function getChannelRow(db: Database, id: string): Promise<ChannelRow | null> {
  const result = await db.query<ChannelRow>(`SELECT * FROM notification_channels WHERE id = $1`, [
    id,
  ]);
  return result.rows[0] ?? null;
}

export async function listChannels(db: Database): Promise<NotificationChannel[]> {
  const result = await db.query<ChannelRow>(
    `SELECT * FROM notification_channels ORDER BY created_at DESC, id DESC`,
  );
  return result.rows.map(mapChannel);
}

export async function getChannelsForMonitor(
  db: Database,
  monitorId: string,
): Promise<ChannelRow[]> {
  const result = await db.query<ChannelRow>(
    `SELECT nc.* FROM notification_channels nc
       JOIN monitor_channels mc ON mc.channel_id = nc.id
      WHERE mc.monitor_id = $1 AND nc.enabled = true
      ORDER BY nc.created_at ASC`,
    [monitorId],
  );
  return result.rows;
}

export async function deleteChannel(db: Database, id: string): Promise<boolean> {
  const result = await db.query('DELETE FROM notification_channels WHERE id = $1', [id]);
  return (result.rowCount ?? 0) > 0;
}

export async function recordChannelDelivery(
  db: Database,
  id: string,
  error: string | null,
): Promise<void> {
  await db.query(
    `UPDATE notification_channels SET last_notified_at = now(), last_error = $2 WHERE id = $1`,
    [id, error],
  );
}

/* -------------------------------------------------------------------------- */
/* API tokens                                                                  */
/* -------------------------------------------------------------------------- */

export interface ApiTokenRow {
  id: string;
  name: string;
  prefix: string;
  token_hash: string;
  created_at: Date;
  expires_at: Date | null;
  last_used_at: Date | null;
  revoked_at: Date | null;
}

export async function createApiToken(
  db: Database,
  input: { name: string; prefix: string; tokenHash: string; expiresAt: Date | null },
): Promise<ApiTokenRow> {
  const result = await db.query<ApiTokenRow>(
    `INSERT INTO api_tokens (name, prefix, token_hash, expires_at)
     VALUES ($1,$2,$3,$4) RETURNING *`,
    [input.name, input.prefix, input.tokenHash, input.expiresAt?.toISOString() ?? null],
  );
  return result.rows[0]!;
}

export async function listApiTokens(db: Database): Promise<ApiTokenRow[]> {
  const result = await db.query<ApiTokenRow>(
    `SELECT * FROM api_tokens ORDER BY created_at DESC, id DESC`,
  );
  return result.rows;
}

export async function findApiTokenByHash(
  db: Database,
  tokenHash: string,
): Promise<ApiTokenRow | null> {
  const result = await db.query<ApiTokenRow>(
    `SELECT * FROM api_tokens
      WHERE token_hash = $1 AND revoked_at IS NULL
        AND (expires_at IS NULL OR expires_at > now())`,
    [tokenHash],
  );
  return result.rows[0] ?? null;
}

export async function touchApiToken(db: Database, id: string): Promise<void> {
  await db.query(`UPDATE api_tokens SET last_used_at = now() WHERE id = $1`, [id]);
}

export async function revokeApiToken(db: Database, id: string): Promise<boolean> {
  const result = await db.query(
    `UPDATE api_tokens SET revoked_at = now() WHERE id = $1 AND revoked_at IS NULL`,
    [id],
  );
  return (result.rowCount ?? 0) > 0;
}

/* -------------------------------------------------------------------------- */
/* Sessions                                                                    */
/* -------------------------------------------------------------------------- */

export interface SessionRow {
  id: string;
  username: string;
  token_hash: string;
  csrf_token: string;
  created_at: Date;
  expires_at: Date;
  last_seen_at: Date;
  user_agent: string | null;
}

export async function createSession(
  db: Database,
  input: {
    username: string;
    tokenHash: string;
    csrfToken: string;
    expiresAt: Date;
    userAgent: string | null;
  },
): Promise<SessionRow> {
  const result = await db.query<SessionRow>(
    `INSERT INTO sessions (username, token_hash, csrf_token, expires_at, user_agent)
     VALUES ($1,$2,$3,$4,$5) RETURNING *`,
    [
      input.username,
      input.tokenHash,
      input.csrfToken,
      input.expiresAt.toISOString(),
      input.userAgent,
    ],
  );
  return result.rows[0]!;
}

export async function findSessionByHash(
  db: Database,
  tokenHash: string,
): Promise<SessionRow | null> {
  const result = await db.query<SessionRow>(
    `SELECT * FROM sessions WHERE token_hash = $1 AND expires_at > now()`,
    [tokenHash],
  );
  return result.rows[0] ?? null;
}

export async function touchSession(db: Database, id: string): Promise<void> {
  await db.query(`UPDATE sessions SET last_seen_at = now() WHERE id = $1`, [id]);
}

export async function deleteSession(db: Database, tokenHash: string): Promise<void> {
  await db.query(`DELETE FROM sessions WHERE token_hash = $1`, [tokenHash]);
}

export async function deleteExpiredSessions(db: Database): Promise<number> {
  const result = await db.query(`DELETE FROM sessions WHERE expires_at <= now()`);
  return result.rowCount ?? 0;
}

/* -------------------------------------------------------------------------- */
/* Share links                                                                 */
/* -------------------------------------------------------------------------- */

export interface ShareLinkRow {
  id: string;
  change_id: string;
  token_hash: string;
  created_at: Date;
  expires_at: Date | null;
  revoked_at: Date | null;
  view_count: number;
}

export async function createShareLink(
  db: Database,
  input: { changeId: string; tokenHash: string; expiresAt: Date | null },
): Promise<ShareLinkRow> {
  const result = await db.query<ShareLinkRow>(
    `INSERT INTO share_links (change_id, token_hash, expires_at)
     VALUES ($1,$2,$3) RETURNING *`,
    [input.changeId, input.tokenHash, input.expiresAt?.toISOString() ?? null],
  );
  return result.rows[0]!;
}

export async function findShareLinkByHash(
  db: Database,
  tokenHash: string,
): Promise<ShareLinkRow | null> {
  const result = await db.query<ShareLinkRow>(
    `SELECT * FROM share_links
      WHERE token_hash = $1 AND revoked_at IS NULL
        AND (expires_at IS NULL OR expires_at > now())`,
    [tokenHash],
  );
  return result.rows[0] ?? null;
}

export async function listShareLinksForChange(
  db: Database,
  changeId: string,
): Promise<ShareLinkRow[]> {
  const result = await db.query<ShareLinkRow>(
    `SELECT * FROM share_links WHERE change_id = $1 ORDER BY created_at DESC`,
    [changeId],
  );
  return result.rows;
}

export async function revokeShareLink(db: Database, id: string): Promise<boolean> {
  const result = await db.query(
    `UPDATE share_links SET revoked_at = now() WHERE id = $1 AND revoked_at IS NULL`,
    [id],
  );
  return (result.rowCount ?? 0) > 0;
}

export async function incrementShareView(db: Database, id: string): Promise<void> {
  await db.query(`UPDATE share_links SET view_count = view_count + 1 WHERE id = $1`, [id]);
}

/* -------------------------------------------------------------------------- */
/* Retention and housekeeping                                                  */
/* -------------------------------------------------------------------------- */

export interface RetentionTarget {
  id: string;
  monitorId: string;
  retentionDays: number;
}

/**
 * Monitors with snapshots older than their retention window. Per-monitor retention wins
 * over the global default.
 */
export async function listRetentionTargets(
  db: Database,
  defaultRetentionDays: number,
): Promise<RetentionTarget[]> {
  const result = await db.query<{ id: string; retention_days: number | null }>(
    `SELECT id, retention_days FROM monitors`,
  );
  return result.rows.map((row) => ({
    id: row.id,
    monitorId: row.id,
    retentionDays: row.retention_days ?? defaultRetentionDays,
  }));
}

/**
 * Snapshot ids that are older than the cutoff. The newest successful snapshot is always
 * kept, even when it is older than the cutoff, so a monitor never loses its baseline.
 */
export async function listExpiredSnapshotIds(
  db: Database,
  monitorId: string,
  cutoff: Date,
  limit = 500,
): Promise<string[]> {
  const result = await db.query<{ id: string }>(
    `SELECT s.id FROM snapshots s
      WHERE s.monitor_id = $1
        AND s.captured_at < $2::timestamptz
        AND s.id IS DISTINCT FROM (
          SELECT newest.id FROM snapshots newest
           WHERE newest.monitor_id = s.monitor_id AND newest.status = 'success'
           ORDER BY newest.captured_at DESC, newest.id DESC LIMIT 1
        )
      ORDER BY s.captured_at ASC
      LIMIT $3`,
    [monitorId, cutoff.toISOString(), limit],
  );
  return result.rows.map((row) => row.id);
}

export async function deleteSnapshots(db: Database, ids: string[]): Promise<number> {
  if (ids.length === 0) return 0;
  // changes referencing these snapshots cascade via to_snapshot_id ON DELETE CASCADE;
  // from_snapshot_id is SET NULL so the neighbouring change keeps its stats.
  const result = await db.query('DELETE FROM snapshots WHERE id = ANY($1::uuid[])', [ids]);
  return result.rowCount ?? 0;
}

export async function deleteExpiredChanges(
  db: Database,
  monitorId: string,
  cutoff: Date,
  limit = 500,
): Promise<Array<{ id: string; diff_image_key: string | null }>> {
  const result = await db.query<{ id: string; diff_image_key: string | null }>(
    `SELECT id, diff_image_key FROM changes
      WHERE monitor_id = $1 AND created_at < $2::timestamptz
      ORDER BY created_at ASC LIMIT $3`,
    [monitorId, cutoff.toISOString(), limit],
  );
  return result.rows;
}

export async function deleteChangesByIds(db: Database, ids: string[]): Promise<number> {
  if (ids.length === 0) return 0;
  const result = await db.query('DELETE FROM changes WHERE id = ANY($1::uuid[])', [ids]);
  return result.rowCount ?? 0;
}

/** Every artefact key currently referenced by the database, for orphan cleanup. */
export async function listReferencedKeys(db: Database): Promise<Set<string>> {
  const keys = new Set<string>();

  const snapshots = await db.query<{ key: string }>(
    `SELECT unnest(ARRAY[screenshot_key, html_key, text_key]) AS key FROM snapshots`,
  );
  for (const row of snapshots.rows) if (row.key) keys.add(row.key);

  const changes = await db.query<{ diff_image_key: string | null }>(
    `SELECT diff_image_key FROM changes WHERE diff_image_key IS NOT NULL`,
  );
  for (const row of changes.rows) if (row.diff_image_key) keys.add(row.diff_image_key);

  return keys;
}

export interface StorageStats {
  snapshots: number;
  changes: number;
  monitors: number;
}

export async function getStorageStats(db: Database): Promise<StorageStats> {
  const result = await db.query<{ monitors: number; snapshots: number; changes: number }>(
    `SELECT
       (SELECT count(*)::int FROM monitors) AS monitors,
       (SELECT count(*)::int FROM snapshots) AS snapshots,
       (SELECT count(*)::int FROM changes) AS changes`,
  );
  const row = result.rows[0];
  return {
    monitors: row?.monitors ?? 0,
    snapshots: row?.snapshots ?? 0,
    changes: row?.changes ?? 0,
  };
}

export async function getDatabaseInfo(
  db: Database,
): Promise<{ version: string | null; sizeBytes: number | null }> {
  try {
    const result = await db.query<{ version: string; size: number }>(
      `SELECT current_setting('server_version') AS version,
              pg_database_size(current_database())::bigint AS size`,
    );
    const row = result.rows[0];
    return { version: row?.version ?? null, sizeBytes: row?.size ?? null };
  } catch {
    return { version: null, sizeBytes: null };
  }
}

/* -------------------------------------------------------------------------- */
/* Dashboard                                                                   */
/* -------------------------------------------------------------------------- */

export async function getDashboardCounts(db: Database): Promise<{
  monitors: number;
  enabled: number;
  failing: number;
  changedLast7d: number;
  snapshots: number;
}> {
  const result = await db.query<{
    monitors: number;
    enabled: number;
    failing: number;
    changed_last7d: number;
    snapshots: number;
  }>(
    `SELECT
       (SELECT count(*)::int FROM monitors) AS monitors,
       (SELECT count(*)::int FROM monitors WHERE enabled AND NOT paused) AS enabled,
       (SELECT count(*)::int FROM monitors WHERE consecutive_failures > 0) AS failing,
       (SELECT count(*)::int FROM changes WHERE significant AND created_at > now() - interval '7 days') AS changed_last7d,
       (SELECT count(*)::int FROM snapshots) AS snapshots`,
  );
  const row = result.rows[0];
  return {
    monitors: row?.monitors ?? 0,
    enabled: row?.enabled ?? 0,
    failing: row?.failing ?? 0,
    changedLast7d: row?.changed_last7d ?? 0,
    snapshots: row?.snapshots ?? 0,
  };
}
