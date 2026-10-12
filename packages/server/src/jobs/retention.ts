import type { Database } from '../db/pool.js';
import * as queries from '../db/queries.js';
import type { StorageProvider } from '../storage/types.js';
import type { Clock } from '../util/clock.js';
import type { Logger } from './captureJob.js';
export interface RetentionOptions {
  db: Database;
  storage: StorageProvider;
  clock: Clock;
  logger: Logger;
  defaultRetentionDays: number;
  batchSize?: number;
}
export interface RetentionReport {
  monitorsScanned: number;
  snapshotsDeleted: number;
  changesDeleted: number;
  filesDeleted: number;
  orphansDeleted: number;
  durationMs: number;
}

export async function runRetention(options: RetentionOptions): Promise<RetentionReport> {
  const startedAt = Date.now();
  const batchSize = options.batchSize ?? 500;

  const targets = await queries.listRetentionTargets(options.db, options.defaultRetentionDays);

  let snapshotsDeleted = 0;
  let changesDeleted = 0;
  const filesToDelete = new Set<string>();

  for (const target of targets) {
    const cutoff = new Date(options.clock.timestamp() - target.retentionDays * 86_400_000);

    const expiredChanges = await queries.deleteExpiredChanges(
      options.db,
      target.monitorId,
      cutoff,
      batchSize,
    );
    if (expiredChanges.length > 0) {
      for (const change of expiredChanges) {
        if (change.diff_image_key) filesToDelete.add(change.diff_image_key);
      }
      changesDeleted += await queries.deleteChangesByIds(
        options.db,
        expiredChanges.map((change) => change.id),
      );
    }

    const expiredSnapshots = await queries.listExpiredSnapshotIds(
      options.db,
      target.monitorId,
      cutoff,
      batchSize,
    );

    if (expiredSnapshots.length > 0) {
      const keys = await queries.deleteSnapshotFiles(options.db, expiredSnapshots);
      for (const key of keys) filesToDelete.add(key);
      snapshotsDeleted += await queries.deleteSnapshots(options.db, expiredSnapshots);
    }
  }

  const stillReferenced = await queries.listReferencedKeys(options.db);
  let filesDeleted = 0;
  for (const key of filesToDelete) {
    if (stillReferenced.has(key)) continue;
    try {
      await options.storage.delete(key);
      filesDeleted += 1;
    } catch (error) {
      options.logger.warn(
        { key, error: (error as Error).message },
        'retention: could not delete artefact',
      );
    }
  }

  const orphansDeleted = await cleanOrphanedFiles(options);

  const report: RetentionReport = {
    monitorsScanned: targets.length,
    snapshotsDeleted,
    changesDeleted,
    filesDeleted,
    orphansDeleted,
    durationMs: Date.now() - startedAt,
  };

  options.logger.info(report, 'retention run complete');
  return report;
}

export async function cleanOrphanedFiles(
  options: Pick<RetentionOptions, 'db' | 'storage' | 'logger'>,
  maxKeys = 20_000,
): Promise<number> {
  const referenced = await queries.listReferencedKeys(options.db);
  const stored = await options.storage.list('monitors/');

  let deleted = 0;
  for (const object of stored.slice(0, maxKeys)) {
    if (referenced.has(object.key)) continue;

    if (object.lastModified.getTime() > Date.now() - 3_600_000) continue;
    try {
      await options.storage.delete(object.key);
      deleted += 1;
    } catch (error) {
      options.logger.warn(
        { key: object.key, error: (error as Error).message },
        'retention: could not delete orphan',
      );
    }
  }

  if (deleted > 0) {
    options.logger.info({ deleted, scanned: stored.length }, 'removed orphaned artefacts');
  }
  return deleted;
}
