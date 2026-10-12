import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { existsSync, utimesSync } from 'node:fs';
import type { Monitor } from '@pagefreeze/shared';
import {
  databaseAvailable,
  dataDirOf,
  resetDatabase,
  startTestApp,
  type TestApp,
} from './helpers.js';
import { cleanOrphanedFiles, runRetention } from '../../src/jobs/retention.js';
import { createDatabase, type Database } from '../../src/db/pool.js';
import * as queries from '../../src/db/queries.js';
import { LocalStorageProvider } from '../../src/storage/local.js';
import { FakeClock } from '../../src/util/clock.js';
import { HTML_KEY, SCREENSHOT_KEY, TEXT_KEY } from '../../src/storage/types.js';

const availability = await databaseAvailable();
const describeDb = availability.ok ? describe : describe.skip;

if (!availability.ok) {
  console.warn(`\n[pagefreeze] retention tests SKIPPED: ${availability.reason}\n`);
}

const silentLogger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  debug: () => undefined,
};

describeDb('retention', () => {
  let handle: TestApp;
  let db: Database;
  let storage: LocalStorageProvider;
  let clock: FakeClock;

  beforeAll(async () => {
    await resetDatabase();
    handle = await startTestApp({ disableBrowser: true });
    db = createDatabase({
      connectionString:
        process.env['DATABASE_URL_TEST'] ??
        'postgres://pagefreeze:pagefreeze@127.0.0.1:5432/pagefreeze_test',
    });
    storage = new LocalStorageProvider(dataDirOf(handle));
    clock = new FakeClock('2026-06-01T00:00:00Z');
  }, 120_000);

  afterAll(async () => {
    await db?.end();
    await handle?.close();
  }, 60_000);

  async function makeMonitor(name: string, retentionDays: number | null): Promise<string> {
    const monitor = await queries.createMonitor(db, {
      name,
      url: `https://example.com/${encodeURIComponent(name)}`,
      enabled: true,
      scheduleKind: 'preset',
      scheduleValue: '24h',
      devicePreset: 'desktop',
      viewportWidth: 1280,
      viewportHeight: 800,
      fullPage: true,
      waitStrategy: 'load',
      waitSelector: null,
      extraDelayMs: 0,
      captureSelector: null,
      ignoreSelectors: [],
      userAgent: null,
      changeThreshold: 0.5,
      detectText: true,
      detectHtml: true,
      retentionDays,
      tags: [],
      headersEnc: null,
      cookiesEnc: null,
      headerNames: [],
      cookieNames: [],
    });
    return monitor.id;
  }

  /** Insert a snapshot row plus its artefacts, backdated by `ageDays`. */
  async function addSnapshot(
    monitorId: string,
    ageDays: number,
    options: { status?: 'success' | 'failed'; withFiles?: boolean } = {},
  ): Promise<string> {
    const capturedAt = new Date(clock.timestamp() - ageDays * 86_400_000);
    const status = options.status ?? 'success';
    const withFiles = options.withFiles ?? true;

    const snapshot = await queries.insertSnapshot(db, {
      id: randomUUID(),
      monitorId,
      status,
      capturedAt,
      finalUrl: 'https://example.com/',
      httpStatus: status === 'success' ? 200 : null,
      loadDurationMs: 100,
      title: status === 'success' ? 'Example' : null,
      errorMessage: status === 'failed' ? 'boom' : null,
      screenshotKey: null,
      htmlKey: null,
      textKey: null,
      screenshotWidth: 1280,
      screenshotHeight: 800,
      screenshotHash: null,
      htmlHash: null,
      textHash: null,
      duplicateOf: null,
      bytes: 1024,
      requestCount: 5,
      hiddenElementCount: 0,
      blockedRequestCount: 0,
    });

    if (withFiles) {
      await storage.put(SCREENSHOT_KEY(monitorId, snapshot.id), Buffer.alloc(64, 1));
      await storage.put(HTML_KEY(monitorId, snapshot.id), '<html></html>');
      await storage.put(TEXT_KEY(monitorId, snapshot.id), 'example text');

      await db.query(
        `UPDATE snapshots SET screenshot_key=$2, html_key=$3, text_key=$4 WHERE id=$1`,
        [
          snapshot.id,
          SCREENSHOT_KEY(monitorId, snapshot.id),
          HTML_KEY(monitorId, snapshot.id),
          TEXT_KEY(monitorId, snapshot.id),
        ],
      );
    }

    return snapshot.id;
  }

  async function countSnapshots(monitorId: string): Promise<number> {
    const result = await db.query<{ n: number }>(
      'SELECT count(*)::int AS n FROM snapshots WHERE monitor_id=$1',
      [monitorId],
    );
    return result.rows[0]?.n ?? 0;
  }

  function retentionOptions() {
    return {
      db,
      storage,
      clock,
      logger: silentLogger,
      defaultRetentionDays: 90,
    };
  }

  it('deletes snapshots and their files older than the global retention window', async () => {
    const monitorId = await makeMonitor('retention-global', null);

    const old = await addSnapshot(monitorId, 200);
    const middle = await addSnapshot(monitorId, 100);
    const recent = await addSnapshot(monitorId, 5);

    expect(existsSync(storage.resolve(SCREENSHOT_KEY(monitorId, old)))).toBe(true);

    const report = await runRetention(retentionOptions());

    expect(report.snapshotsDeleted).toBeGreaterThanOrEqual(2);
    expect(report.filesDeleted).toBeGreaterThanOrEqual(6);

    // Both expired rows are gone, the recent one survives.
    const remaining = await db.query<{ id: string }>(
      'SELECT id FROM snapshots WHERE monitor_id=$1',
      [monitorId],
    );
    const ids = remaining.rows.map((row) => row.id);
    expect(ids).toContain(recent);
    expect(ids).not.toContain(old);
    expect(ids).not.toContain(middle);

    // Their artefacts went with them.
    expect(existsSync(storage.resolve(SCREENSHOT_KEY(monitorId, old)))).toBe(false);
    expect(existsSync(storage.resolve(HTML_KEY(monitorId, old)))).toBe(false);
    expect(existsSync(storage.resolve(TEXT_KEY(monitorId, old)))).toBe(false);
    expect(existsSync(storage.resolve(SCREENSHOT_KEY(monitorId, recent)))).toBe(true);
  }, 120_000);

  it('honours a per-monitor retention window over the global default', async () => {
    const shortMonitor = await makeMonitor('retention-short', 7);
    const longMonitor = await makeMonitor('retention-long', 365);

    await addSnapshot(shortMonitor, 30);
    const shortRecent = await addSnapshot(shortMonitor, 1);
    const longOld = await addSnapshot(longMonitor, 30);

    await runRetention(retentionOptions());

    // 30 days exceeds the 7-day monitor window, so it is deleted.
    expect(await countSnapshots(shortMonitor)).toBe(1);
    const shortRemaining = await db.query<{ id: string }>(
      'SELECT id FROM snapshots WHERE monitor_id=$1',
      [shortMonitor],
    );
    expect(shortRemaining.rows[0]!.id).toBe(shortRecent);

    // 30 days is inside the 365-day window, so it is kept even though the global default
    // is 90 days.
    const longIds = await db.query<{ id: string }>('SELECT id FROM snapshots WHERE monitor_id=$1', [
      longMonitor,
    ]);
    expect(longIds.rows.map((row) => row.id)).toContain(longOld);
  }, 120_000);

  it('always keeps the newest snapshot, even when it is older than the cutoff', async () => {
    const monitorId = await makeMonitor('retention-keep-newest', null);

    // Every snapshot is far older than the 90-day window: a monitor that has not run in a
    // while must not lose its baseline, or the next capture would have nothing to compare
    // against and every subsequent change would be reported as a first snapshot.
    const only = await addSnapshot(monitorId, 400);

    await runRetention(retentionOptions());

    expect(await countSnapshots(monitorId)).toBe(1);
    expect(existsSync(storage.resolve(SCREENSHOT_KEY(monitorId, only)))).toBe(true);
  }, 120_000);

  it('deletes expired change records and their diff images', async () => {
    const monitorId = await makeMonitor('retention-changes', null);

    const from = await addSnapshot(monitorId, 200);
    const to = await addSnapshot(monitorId, 200);

    const change = await queries.insertChange(db, {
      monitorId,
      fromSnapshotId: from,
      toSnapshotId: to,
      pixelDiffPercent: 1.5,
      changedPixels: 100,
      totalPixels: 10_000,
      sizeChanged: false,
      sizeFrom: { width: 100, height: 100 },
      sizeTo: { width: 100, height: 100 },
      textAdded: 1,
      textRemoved: 0,
      htmlAdded: 1,
      htmlRemoved: 0,
      significant: true,
      summary: 'test change',
      regions: [],
      diffImageKey: null,
      textDiff: null,
      htmlDiff: null,
      truncated: false,
      durationMs: 5,
    });

    const diffKey = `monitors/${monitorId}/changes/${change.id}/diff.png`;
    await storage.put(diffKey, Buffer.alloc(32, 2));

    // created_at defaults to now(); backdate it to match the snapshots it compares,
    // otherwise the row is newer than the cutoff and correctly survives.
    const backdated = new Date(clock.timestamp() - 200 * 86_400_000).toISOString();
    await db.query('UPDATE changes SET diff_image_key=$2, created_at=$3 WHERE id=$1', [
      change.id,
      diffKey,
      backdated,
    ]);

    expect(existsSync(storage.resolve(diffKey))).toBe(true);

    const report = await runRetention(retentionOptions());
    expect(report.changesDeleted).toBeGreaterThanOrEqual(1);

    const remaining = await db.query('SELECT id FROM changes WHERE monitor_id=$1', [monitorId]);
    expect(remaining.rows).toHaveLength(0);
    expect(existsSync(storage.resolve(diffKey))).toBe(false);
  }, 120_000);

  it('keeps reused files when their original snapshot expires', async () => {
    const monitorId = await makeMonitor('retention-dedup', 7);
    const oldId = await addSnapshot(monitorId, 30);
    const newId = await addSnapshot(monitorId, 1);
    const original = await queries.getSnapshotRow(db, oldId);
    await db.query(
      'UPDATE snapshots SET screenshot_key=$2, html_key=$3, text_key=$4, duplicate_of=$5 WHERE id=$1',
      [newId, original!.screenshot_key, original!.html_key, original!.text_key, oldId],
    );
    await runRetention(retentionOptions());
    expect(await queries.getSnapshotRow(db, oldId)).toBeNull();
    expect(await storage.exists(original!.screenshot_key!)).toBe(true);
    expect(await storage.exists(original!.html_key!)).toBe(true);
    expect(await storage.exists(original!.text_key!)).toBe(true);
  });

  it('expires failed snapshots even when there has never been a successful capture', async () => {
    const monitorId = await makeMonitor('retention-only-failures', 7);
    const id = await addSnapshot(monitorId, 30, { status: 'failed', withFiles: false });
    await runRetention(retentionOptions());
    expect(await queries.getSnapshotRow(db, id)).toBeNull();
  });

  it('removes orphaned files that no row references', async () => {
    const monitorId = await makeMonitor('retention-orphans', null);
    await addSnapshot(monitorId, 1);

    // Simulate a crash between writing an artefact and committing its row.
    const orphanKey = `monitors/${monitorId}/snapshots/deadbeef-0000-4000-8000-000000000000/screenshot.png`;
    await storage.put(orphanKey, Buffer.alloc(16, 3));
    expect(existsSync(storage.resolve(orphanKey))).toBe(true);
    expect(await cleanOrphanedFiles({ db, storage, logger: silentLogger })).toBe(0);
    const old = new Date(Date.now() - 7_200_000);
    utimesSync(storage.resolve(orphanKey), old, old);

    const deleted = await cleanOrphanedFiles({ db, storage, logger: silentLogger });
    expect(deleted).toBeGreaterThanOrEqual(1);
    expect(existsSync(storage.resolve(orphanKey))).toBe(false);

    // Files that ARE referenced survive.
    const kept = await db.query<{ screenshot_key: string }>(
      'SELECT screenshot_key FROM snapshots WHERE monitor_id=$1 AND screenshot_key IS NOT NULL LIMIT 1',
      [monitorId],
    );
    if (kept.rows[0]) {
      expect(existsSync(storage.resolve(kept.rows[0].screenshot_key))).toBe(true);
    }
  }, 120_000);

  it('is a no-op when nothing has expired', async () => {
    const monitorId = await makeMonitor('retention-noop', null);
    await addSnapshot(monitorId, 1);

    const before = await countSnapshots(monitorId);
    const report = await runRetention(retentionOptions());

    expect(await countSnapshots(monitorId)).toBe(before);
    expect(report.monitorsScanned).toBeGreaterThan(0);
    expect(report.durationMs).toBeGreaterThanOrEqual(0);
  }, 120_000);

  it('deletes failed snapshots on the same schedule but keeps the newest success', async () => {
    const monitorId = await makeMonitor('retention-failures', null);

    const oldFailure = await addSnapshot(monitorId, 200, { status: 'failed', withFiles: false });
    const newest = await addSnapshot(monitorId, 1);

    await runRetention(retentionOptions());

    const remaining = await db.query<{ id: string; status: string }>(
      'SELECT id, status FROM snapshots WHERE monitor_id=$1',
      [monitorId],
    );
    expect(remaining.rows.map((row) => row.id)).not.toContain(oldFailure);
    expect(remaining.rows.map((row) => row.id)).toContain(newest);
  }, 120_000);

  it('reports what it did', async () => {
    const report = await runRetention(retentionOptions());
    expect(report).toMatchObject({
      monitorsScanned: expect.any(Number),
      snapshotsDeleted: expect.any(Number),
      changesDeleted: expect.any(Number),
      filesDeleted: expect.any(Number),
      orphansDeleted: expect.any(Number),
      durationMs: expect.any(Number),
    });
  }, 60_000);

  it('bounds each run with a batch size', async () => {
    const monitorId = await makeMonitor('retention-batch', null);
    for (let index = 0; index < 4; index += 1) {
      await addSnapshot(monitorId, 200 + index);
    }
    await addSnapshot(monitorId, 1);

    // A batch size of 2 removes at most two snapshots per monitor per run.
    const report = await runRetention({ ...retentionOptions(), batchSize: 2 });
    expect(report.snapshotsDeleted).toBeLessThanOrEqual(8);

    const remaining = await countSnapshots(monitorId);
    expect(remaining).toBeGreaterThan(1);
  }, 120_000);
});

describeDb('retention through the HTTP API', () => {
  let handle: TestApp;

  beforeAll(async () => {
    await resetDatabase();
    handle = await startTestApp({ disableBrowser: true });
    await handle.login();
  }, 120_000);

  afterAll(async () => {
    await handle?.close();
  }, 60_000);

  it('exposes the configured retention window in system info', async () => {
    const response = await handle.client.get<{ retentionDays: number }>('/api/v1/system/info');
    expect(response.status).toBe(200);
    expect(response.data?.retentionDays).toBe(90);
  });

  it('stores a per-monitor retention override', async () => {
    const created = await handle.client.post<Monitor>('/api/v1/monitors', {
      name: 'Short retention',
      url: 'https://example.com/short',
      retentionDays: 14,
    });
    expect(created.status).toBe(201);
    expect(created.data?.retentionDays).toBe(14);

    const cleared = await handle.client.patch<Monitor>(`/api/v1/monitors/${created.data!.id}`, {
      retentionDays: null,
    });
    expect(cleared.data?.retentionDays).toBeNull();
  });

  it('rejects a nonsensical retention window', async () => {
    const response = await handle.client.post('/api/v1/monitors', {
      name: 'Bad retention',
      url: 'https://example.com/bad',
      retentionDays: 0,
    });
    expect(response.status).toBe(422);
  });
});
