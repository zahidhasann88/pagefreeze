import type { AppInstance } from '../types.js';
import type { AppDeps } from '../deps.js';
import { notFound } from '../errors.js';
import * as queries from '../../db/queries.js';
import { mapChange } from '../../db/rows.js';
import { SCREENSHOT_KEY } from '../../storage/types.js';
import { hashToken } from '../auth.js';
import { sendPng } from './snapshots.js';
import { RAW_CONTENT_CSP } from '../security.js';
import { textResponse } from '../http.js';

type ShareWhich = 'before' | 'after' | 'diff';

async function resolveShare(deps: AppDeps, token: string) {
  const link = await queries.findShareLinkByHash(deps.db, hashToken(token));
  if (!link) return null;

  const changeRow = await queries.getChange(deps.db, link.change_id);
  if (!changeRow) return null;

  return { link, changeRow, change: mapChange(changeRow) };
}

export async function registerShareRoutes(app: AppInstance, deps: AppDeps): Promise<void> {
  app.get('/share/:token', async (request) => {
    const { token } = request.params as { token: string };
    const resolved = await resolveShare(deps, token);
    if (!resolved) throw notFound('Share link is invalid, expired or revoked');

    await queries.incrementShareView(deps.db, resolved.link.id);

    const monitor = await queries.getMonitor(deps.db, resolved.change.monitorId);

    return {
      change: resolved.change,
      monitor: monitor
        ? { id: monitor.id, name: monitor.name, url: monitor.url }
        : { id: resolved.change.monitorId, name: null, url: null },
      expiresAt: resolved.link.expires_at?.toISOString() ?? null,
      urls: {
        before: `/api/v1/share/${token}/screenshot/before`,
        after: `/api/v1/share/${token}/screenshot/after`,
        diff: resolved.change.hasDiffImage ? `/api/v1/share/${token}/screenshot/diff` : null,
        textBefore: `/api/v1/share/${token}/text/before`,
        textAfter: `/api/v1/share/${token}/text/after`,
      },
    };
  });

  app.get('/share/:token/screenshot/:which', async (request, reply) => {
    const { token, which } = request.params as { token: string; which: string };
    if (which !== 'before' && which !== 'after' && which !== 'diff') {
      throw notFound('Unknown artefact');
    }

    const resolved = await resolveShare(deps, token);
    if (!resolved) throw notFound('Share link is invalid, expired or revoked');

    const key = await artefactKey(deps, resolved.change, which as ShareWhich);
    if (!key) throw notFound('Artefact is not available');

    const data = await deps.storage.get(key);
    if (!data) throw notFound('Artefact is missing from storage');

    sendPng(reply, data, false);
  });

  app.get('/share/:token/text/:which', async (request, reply) => {
    const { token, which } = request.params as { token: string; which: string };
    if (which !== 'before' && which !== 'after') throw notFound('Unknown artefact');

    const resolved = await resolveShare(deps, token);
    if (!resolved) throw notFound('Share link is invalid, expired or revoked');

    const snapshotId =
      which === 'before' ? resolved.change.fromSnapshotId : resolved.change.toSnapshotId;
    if (!snapshotId) throw notFound('Artefact is not available');

    const snapshot = await queries.getSnapshotRow(deps.db, snapshotId);
    if (!snapshot?.text_key) throw notFound('Artefact is not available');

    const data = await deps.storage.get(snapshot.text_key);
    if (!data) throw notFound('Artefact is missing from storage');

    void reply.header('content-security-policy', RAW_CONTENT_CSP);
    textResponse(reply, data.toString('utf8'), 'text/plain');
  });
}

async function artefactKey(
  deps: AppDeps,
  change: ReturnType<typeof mapChange>,
  which: ShareWhich,
): Promise<string | null> {
  if (which === 'diff') {
    const row = await queries.getChange(deps.db, change.id);
    return row?.diff_image_key ?? null;
  }

  const snapshotId = which === 'before' ? change.fromSnapshotId : change.toSnapshotId;
  if (!snapshotId) return null;

  const snapshot = await queries.getSnapshotRow(deps.db, snapshotId);
  if (!snapshot) return null;

  return snapshot.screenshot_key ?? SCREENSHOT_KEY(change.monitorId, snapshotId);
}
