import type { AppInstance } from '../types.js';
import { compareQuerySchema, shareCreateSchema } from '@pagefreeze/shared';
import type { AppDeps } from '../deps.js';
import { parseOrThrow, parseUuid, sendCreated } from '../http.js';
import { badRequest, notFound } from '../errors.js';
import { requireAuthenticated, requireCsrf } from '../auth.js';
import * as queries from '../../db/queries.js';
import { DIFF_IMAGE_KEY } from '../../storage/types.js';
import { runDiffInProcess } from '../../diff/runDiff.js';
import { isSignificant, summarizeChange, type DiffRequest } from '../../diff/types.js';
import { generateToken } from '../auth.js';
import { sendPng } from './snapshots.js';

/**
 * Change endpoints: the diff viewer's data source, on-demand comparison of any two
 * snapshots, and public share links.
 */
export async function registerChangeRoutes(app: AppInstance, deps: AppDeps): Promise<void> {
  app.get('/changes/:id', { preHandler: requireAuthenticated(deps.auth) }, async (request) => {
    const { id } = request.params as { id: string };
    const row = await queries.getChange(deps.db, parseUuid(id));
    if (!row) throw notFound('Change not found');

    const neighbours = await queries.getNeighbouringChangeIds(deps.db, row.monitor_id, row.id);

    return {
      ...row,
      pixelDiffPercent: row.pixel_diff_percent,
      monitor: { id: row.monitor_id, name: row.monitor_name ?? null, url: row.monitor_url ?? null },
      navigation: neighbours,
      createdAt: row.created_at.toISOString(),
      fromSnapshotId: row.from_snapshot_id,
      toSnapshotId: row.to_snapshot_id,
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
      hasDiffImage: row.diff_image_key !== null,
      textDiff: row.text_diff ?? null,
      htmlDiff: row.html_diff ?? null,
      truncated: row.truncated,
      durationMs: row.duration_ms,
      diffImageUrl: row.diff_image_key ? `/api/v1/changes/${row.id}/diff-image` : null,
      screenshotUrls: {
        before: row.from_snapshot_id
          ? `/api/v1/snapshots/${row.from_snapshot_id}/screenshot`
          : null,
        after: `/api/v1/snapshots/${row.to_snapshot_id}/screenshot`,
      },
      shares: (await queries.listShareLinksForChange(deps.db, row.id)).map((share) => ({
        id: share.id,
        createdAt: share.created_at.toISOString(),
        expiresAt: share.expires_at?.toISOString() ?? null,
        revokedAt: share.revoked_at?.toISOString() ?? null,
        viewCount: share.view_count,
      })),
    };
  });

  app.get(
    '/changes/:id/diff-image',
    { preHandler: requireAuthenticated(deps.auth) },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const row = await queries.getChange(deps.db, parseUuid(id));
      if (!row) throw notFound('Change not found');
      if (!row.diff_image_key) throw notFound('Change has no diff image');

      const data = await deps.storage.get(row.diff_image_key);
      if (!data) throw notFound('Diff image is missing from storage');

      sendPng(reply, data);
    },
  );

  /**
   * Compare any two snapshots of the same monitor on demand.
   *
   * With `store=false` (the default) the comparison is computed and returned but nothing
   * is written, so an operator can explore history without polluting the change list.
   */
  app.get('/compare', { preHandler: requireAuthenticated(deps.auth) }, async (request) => {
    const query = parseOrThrow(compareQuerySchema, request.query);
    if (query.store === 'true') await requireCsrf(true)(request);

    const [a, b] = await Promise.all([
      queries.getSnapshotRow(deps.db, query.a),
      queries.getSnapshotRow(deps.db, query.b),
    ]);

    if (!a || !b) throw notFound('One of the snapshots was not found');
    if (a.monitor_id !== b.monitor_id) {
      throw badRequest('Both snapshots must belong to the same monitor');
    }
    if (a.status !== 'success' || b.status !== 'success') {
      throw badRequest('Failed snapshots cannot be compared');
    }

    // Order the pair chronologically so "before" is always the older capture.
    const older = a.captured_at <= b.captured_at ? a : b;
    const newer = a.captured_at <= b.captured_at ? b : a;

    const monitor = await queries.getMonitor(deps.db, older.monitor_id);
    if (!monitor) throw notFound('Monitor not found');

    const request_ = await buildDiffRequest(
      deps,
      older,
      newer,
      monitor.detectText,
      monitor.detectHtml,
    );
    request_.options.produceDiffImage = query.store === 'true';
    const diff = await deps.diffEngine.diff(request_);

    const significant = isSignificant(
      diff,
      monitor.changeThreshold,
      monitor.detectText,
      monitor.detectHtml,
    );

    if (query.store === 'true') {
      const diffImageKey = DIFF_IMAGE_KEY(monitor.id, newer.id);
      if (diff.diffImage) await deps.storage.put(diffImageKey, diff.diffImage);

      const change = await queries.insertChange(deps.db, {
        monitorId: monitor.id,
        fromSnapshotId: older.id,
        toSnapshotId: newer.id,
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
        summary: summarizeChange(diff, { significant, sizeChanged: diff.sizeChanged }),
        regions: diff.regions,
        diffImageKey: diff.diffImage ? diffImageKey : null,
        textDiff: diff.text,
        htmlDiff: diff.html,
        truncated: Boolean(diff.text?.truncated || diff.html?.truncated),
        durationMs: diff.durationMs,
      });

      return { stored: true, changeId: change.id, diff: serializableDiff(diff, significant) };
    }

    return { stored: false, changeId: null, diff: serializableDiff(diff, significant) };
  });

  /* ------------------------------ share links ----------------------------- */

  app.post(
    '/changes/:id/share',
    { preHandler: requireAuthenticated(deps.auth) },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const changeId = parseUuid(id);
      const body = parseOrThrow(shareCreateSchema, request.body ?? {});

      const change = await queries.getChange(deps.db, changeId);
      if (!change) throw notFound('Change not found');
      const generated = generateToken('share');
      const expiresAt = body.expiresInHours
        ? new Date(Date.now() + body.expiresInHours * 3_600_000)
        : null;

      const link = await queries.createShareLink(deps.db, {
        changeId,
        tokenHash: generated.hash,
        expiresAt,
      });

      const base = resolveBaseUrl(deps, request);
      request.log.info({ changeId, shareId: link.id }, 'share link created');

      sendCreated(reply, {
        // The share link's own id, which is what DELETE /shares/:id needs. Returning the
        // change id here would make every created link impossible to revoke.
        id: link.id,
        changeId,
        url: `${base}/share/${generated.token}`,
        token: generated.token,
        createdAt: new Date().toISOString(),
        expiresAt: expiresAt?.toISOString() ?? null,
        revokedAt: null,
      });
    },
  );

  app.get(
    '/changes/:id/shares',
    { preHandler: requireAuthenticated(deps.auth) },
    async (request) => {
      const { id } = request.params as { id: string };
      const changeId = parseUuid(id);
      const rows = await queries.listShareLinksForChange(deps.db, changeId);
      return {
        data: rows.map((row) => ({
          id: row.id,
          changeId: row.change_id,
          createdAt: row.created_at.toISOString(),
          expiresAt: row.expires_at?.toISOString() ?? null,
          revokedAt: row.revoked_at?.toISOString() ?? null,
          viewCount: row.view_count,
          active:
            row.revoked_at === null && (row.expires_at === null || row.expires_at > new Date()),
        })),
      };
    },
  );

  app.delete(
    '/shares/:id',
    { preHandler: requireAuthenticated(deps.auth) },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const revoked = await queries.revokeShareLink(deps.db, parseUuid(id));
      if (!revoked) throw notFound('Share link not found or already revoked');
      void reply.status(204).send();
    },
  );
}

export function resolveBaseUrl(
  deps: AppDeps,
  request: { headers: Record<string, unknown> },
): string {
  if (deps.config.baseUrl) return deps.config.baseUrl.replace(/\/+$/, '');
  const host = request.headers['host'];
  if (typeof host === 'string' && host.length > 0) {
    const secure = deps.config.secureCookies || request.headers['x-forwarded-proto'] === 'https';
    return `${secure ? 'https' : 'http'}://${host}`;
  }
  return '';
}

async function buildDiffRequest(
  deps: AppDeps,
  older: Awaited<ReturnType<typeof queries.getSnapshotRow>> & object,
  newer: Awaited<ReturnType<typeof queries.getSnapshotRow>> & object,
  detectText: boolean,
  detectHtml: boolean,
): Promise<DiffRequest> {
  const [beforeImage, afterImage, beforeText, afterText, beforeHtml, afterHtml] = await Promise.all(
    [
      older.screenshot_key ? deps.storage.get(older.screenshot_key) : Promise.resolve(null),
      newer.screenshot_key ? deps.storage.get(newer.screenshot_key) : Promise.resolve(null),
      older.text_key ? deps.storage.get(older.text_key) : Promise.resolve(null),
      newer.text_key ? deps.storage.get(newer.text_key) : Promise.resolve(null),
      older.html_key ? deps.storage.get(older.html_key) : Promise.resolve(null),
      newer.html_key ? deps.storage.get(newer.html_key) : Promise.resolve(null),
    ],
  );

  return {
    beforeScreenshot: beforeImage,
    afterScreenshot: afterImage,
    beforeText: beforeText?.toString('utf8') ?? null,
    afterText: afterText?.toString('utf8') ?? null,
    beforeHtml: beforeHtml?.toString('utf8') ?? null,
    afterHtml: afterHtml?.toString('utf8') ?? null,
    options: {
      pixelThreshold: deps.config.diffPixelThreshold,
      includeAA: false,
      regionPadding: deps.config.diffRegionPadding,
      regionMinArea: deps.config.diffRegionMinArea,
      computeText: detectText,
      computeHtml: detectHtml,
      computeVisual: true,
      // An on-demand comparison is displayed, not stored, so no diff PNG is built.
      produceDiffImage: false,
    },
  };
}

/** Strip Buffers so the payload is JSON serialisable. */
function serializableDiff(
  diff: ReturnType<typeof runDiffInProcess>,
  significant: boolean,
): Record<string, unknown> {
  return {
    pixelDiffPercent: diff.pixelDiffPercent,
    changedPixels: diff.changedPixels,
    totalPixels: diff.totalPixels,
    sizeChanged: diff.sizeChanged,
    sizeFrom: diff.sizeFrom,
    sizeTo: diff.sizeTo,
    regions: diff.regions,
    text: diff.text,
    html: diff.html,
    significant,
    durationMs: diff.durationMs,
  };
}
