import type { FastifyReply } from 'fastify';
import type { AppInstance } from '../types.js';
import type { AppDeps } from '../deps.js';
import { parseUuid, textResponse } from '../http.js';
import { notFound } from '../errors.js';
import { requireAuthenticated } from '../auth.js';
import * as queries from '../../db/queries.js';
import { RAW_CONTENT_CSP } from '../security.js';

/**
 * Snapshot artefact endpoints.
 *
 * Security note: stored HTML and text are captured from third-party pages and may contain
 * anything, including markup that would be dangerous if executed. They are therefore
 * served as `text/plain` with `nosniff` and a `default-src 'none'; sandbox` CSP, and the
 * UI renders them as escaped text. They are never served as `text/html` from this origin.
 */
export async function registerSnapshotRoutes(app: AppInstance, deps: AppDeps): Promise<void> {
  app.get('/snapshots/:id', { preHandler: requireAuthenticated(deps.auth) }, async (request) => {
    const { id } = request.params as { id: string };
    const snapshot = await queries.getSnapshot(deps.db, parseUuid(id));
    if (!snapshot) throw notFound('Snapshot not found');
    return snapshot;
  });

  app.get(
    '/snapshots/:id/screenshot',
    { preHandler: requireAuthenticated(deps.auth) },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const row = await queries.getSnapshotRow(deps.db, parseUuid(id));
      if (!row) throw notFound('Snapshot not found');

      const key = row.screenshot_key;
      if (!key) throw notFound('Snapshot has no screenshot');

      const data = await deps.storage.get(key);
      if (!data) throw notFound('Screenshot file is missing from storage');

      // Screenshots are immutable once written, so they can be cached hard. The UI shows
      // hundreds of thumbnails and re-fetching them on every navigation would be wasteful.
      void reply
        .header('content-type', 'image/png')
        .header('cache-control', 'private, max-age=31536000, immutable')
        .header('content-length', String(data.length))
        .send(data);
    },
  );

  app.get(
    '/snapshots/:id/html',
    { preHandler: requireAuthenticated(deps.auth) },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const row = await queries.getSnapshotRow(deps.db, parseUuid(id));
      if (!row) throw notFound('Snapshot not found');

      const key = row.html_key;
      if (!key) throw notFound('Snapshot has no stored HTML');

      const data = await deps.storage.get(key);
      if (!data) throw notFound('HTML file is missing from storage');

      void reply.header('content-security-policy', RAW_CONTENT_CSP);
      void reply.header('content-disposition', `inline; filename="snapshot-${row.id}.html.txt"`);
      textResponse(reply, data.toString('utf8'), 'text/plain');
    },
  );

  app.get(
    '/snapshots/:id/text',
    { preHandler: requireAuthenticated(deps.auth) },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const row = await queries.getSnapshotRow(deps.db, parseUuid(id));
      if (!row) throw notFound('Snapshot not found');

      const key = row.text_key;
      if (!key) throw notFound('Snapshot has no stored text');

      const data = await deps.storage.get(key);
      if (!data) throw notFound('Text file is missing from storage');

      void reply.header('content-security-policy', RAW_CONTENT_CSP);
      textResponse(reply, data.toString('utf8'), 'text/plain');
    },
  );
}

/** Shared helper for streaming a stored PNG (also used by the change diff endpoint). */
export function sendPng(reply: FastifyReply, data: Buffer, cacheable = true): void {
  void reply
    .header('content-type', 'image/png')
    .header('content-length', String(data.length))
    .header('cache-control', cacheable ? 'private, max-age=31536000, immutable' : 'no-store')
    .send(data);
}
