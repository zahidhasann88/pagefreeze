import type { AppInstance } from '../types.js';
import {
  changeListQuerySchema,
  monitorCreateSchema,
  monitorListQuerySchema,
  monitorUpdateSchema,
  snapshotListQuerySchema,
  type CookieInput,
  type HeadersInput,
} from '@pagefreeze/shared';
import type { AppDeps, PreviewCaptureInput } from '../deps.js';
import { parseOrThrow, parseUuid, sendCreated, sendNoContent, sendPage } from '../http.js';
import { badRequest, notFound } from '../errors.js';
import { requireAuthenticated } from '../auth.js';
import * as queries from '../../db/queries.js';
import { encryptJson } from '../../crypto/secrets.js';
import { HTML_KEY, SCREENSHOT_KEY, TEXT_KEY } from '../../storage/types.js';

interface MonitorBody {
  url?: string;
  headers?: HeadersInput;
  cookies?: CookieInput[];
  channelIds?: string[];
  [key: string]: unknown;
}

/**
 * Split a monitor payload into the columns stored in the clear and the parts that must be
 * encrypted. Header and cookie *values* never reach the database unencrypted, and never
 * appear in a response: only the names are stored alongside the ciphertext so the UI can
 * say which headers are configured.
 */
function splitSecrets(
  deps: AppDeps,
  body: MonitorBody,
): {
  headersEnc?: string;
  cookiesEnc?: string;
  headerNames?: string[];
  cookieNames?: string[];
} {
  const result: {
    headersEnc?: string;
    cookiesEnc?: string;
    headerNames?: string[];
    cookieNames?: string[];
  } = {};

  if (body.headers !== undefined) {
    const headers = body.headers ?? {};
    result.headersEnc = encryptJson(headers, deps.keyProvider);
    result.headerNames = Object.keys(headers);
  }
  if (body.cookies !== undefined) {
    const cookies = body.cookies ?? [];
    result.cookiesEnc = encryptJson(cookies, deps.keyProvider);
    result.cookieNames = cookies.map((cookie) => cookie.name);
  }

  return result;
}

/** Drop the secret-bearing and relational fields before the payload reaches the queries layer. */
function withoutSecrets<T extends MonitorBody>(
  body: T,
): Omit<T, 'headers' | 'cookies' | 'channelIds'> {
  const { headers: _headers, cookies: _cookies, channelIds: _channelIds, ...rest } = body;
  return rest;
}

/**
 * Reject a URL the SSRF guard would refuse at capture time, so an operator gets an
 * immediate, explainable error instead of a monitor that fails on every run.
 */
async function assertUrlAllowed(deps: AppDeps, url: string): Promise<void> {
  const verdict = await deps.guard.checkUrl(url);
  if (!verdict.allowed) {
    throw badRequest(
      `URL is not allowed by the SSRF policy: ${verdict.reason}. ` +
        'Set ALLOW_PRIVATE_TARGETS=true to permit internal addresses.',
    );
  }
}

export async function registerMonitorRoutes(app: AppInstance, deps: AppDeps): Promise<void> {
  const createSchema = monitorCreateSchema(deps.config.minIntervalMinutes);
  const updateSchema = monitorUpdateSchema(deps.config.minIntervalMinutes);

  app.get('/monitors', { preHandler: requireAuthenticated(deps.auth) }, async (request, reply) => {
    const query = parseOrThrow(monitorListQuerySchema, request.query);
    const page = await queries.listMonitors(deps.db, {
      status: query.status,
      ...(query.tag ? { tag: query.tag } : {}),
      ...(query.q ? { q: query.q } : {}),
      limit: query.limit,
      cursor: query.cursor ?? null,
    });
    sendPage(reply, page);
  });

  app.post('/monitors', { preHandler: requireAuthenticated(deps.auth) }, async (request, reply) => {
    const body = parseOrThrow(createSchema, request.body) as MonitorBody;
    await assertUrlAllowed(deps, body.url as string);

    const monitor = await queries.createMonitor(deps.db, {
      ...withoutSecrets(body),
      ...splitSecrets(deps, body),
    } as unknown as queries.MonitorInsert);

    const channelIds = body.channelIds ?? [];
    if (channelIds.length > 0) {
      await queries.setMonitorChannels(deps.db, monitor.id, channelIds);
    }

    await deps.scheduler?.sync().catch(() => undefined);

    const created = await queries.getMonitor(deps.db, monitor.id);
    request.log.info({ monitorId: monitor.id, url: monitor.url }, 'monitor created');
    sendCreated(reply, created);
  });

  /**
   * Preview a capture without persisting anything, so an operator can see the effect of a
   * selector or wait strategy before committing to a schedule.
   *
   * Registered before `/monitors/:id` so that "preview" is not parsed as an id.
   */
  app.post(
    '/monitors/preview',
    { preHandler: requireAuthenticated(deps.auth) },
    async (request) => {
      const body = parseOrThrow(createSchema, request.body) as MonitorBody;
      await assertUrlAllowed(deps, body.url as string);

      return deps.previewCapture({
        url: body.url as string,
        devicePreset: body.devicePreset as 'desktop' | 'tablet' | 'mobile',
        viewportWidth: body.viewportWidth as number,
        viewportHeight: body.viewportHeight as number,
        fullPage: body.fullPage as boolean,
        waitStrategy: body.waitStrategy as 'load' | 'networkidle' | 'selector',
        waitSelector: (body.waitSelector as string | null) ?? null,
        extraDelayMs: body.extraDelayMs as number,
        captureSelector: (body.captureSelector as string | null) ?? null,
        ignoreSelectors: (body.ignoreSelectors as string[]) ?? [],
        userAgent: (body.userAgent as string | null) ?? null,
        headers: (body.headers as Record<string, string>) ?? {},
        cookies: (body.cookies ?? []) as PreviewCaptureInput['cookies'],
      });
    },
  );

  app.get('/monitors/:id', { preHandler: requireAuthenticated(deps.auth) }, async (request) => {
    const { id } = request.params as { id: string };
    const monitor = await queries.getMonitor(deps.db, parseUuid(id));
    if (!monitor) throw notFound('Monitor not found');
    return monitor;
  });

  app.patch('/monitors/:id', { preHandler: requireAuthenticated(deps.auth) }, async (request) => {
    const { id } = request.params as { id: string };
    const monitorId = parseUuid(id);

    const existing = await queries.getMonitor(deps.db, monitorId);
    if (!existing) throw notFound('Monitor not found');

    const body = parseOrThrow(updateSchema, request.body) as MonitorBody;
    if (body.url !== undefined) await assertUrlAllowed(deps, body.url);

    await queries.updateMonitor(deps.db, monitorId, {
      ...withoutSecrets(body),
      ...splitSecrets(deps, body),
    } as unknown as queries.MonitorUpdate);

    if (body.channelIds !== undefined) {
      await queries.setMonitorChannels(deps.db, monitorId, body.channelIds);
    }

    await deps.scheduler?.sync().catch(() => undefined);

    request.log.info({ monitorId }, 'monitor updated');
    return queries.getMonitor(deps.db, monitorId);
  });

  app.delete(
    '/monitors/:id',
    { preHandler: requireAuthenticated(deps.auth) },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const monitorId = parseUuid(id);

      // Delete artefacts first: a failure here leaves files that the orphan sweep can
      // collect later, whereas the reverse would leave rows pointing at nothing.
      const snapshots = await queries.listSnapshots(deps.db, monitorId, {
        status: 'all',
        limit: 1000,
      });
      for (const snapshot of snapshots.data) {
        for (const key of [
          SCREENSHOT_KEY(monitorId, snapshot.id),
          HTML_KEY(monitorId, snapshot.id),
          TEXT_KEY(monitorId, snapshot.id),
        ]) {
          await deps.storage.delete(key).catch(() => undefined);
        }
      }

      if (!(await queries.deleteMonitor(deps.db, monitorId))) {
        throw notFound('Monitor not found');
      }

      await deps.scheduler?.sync().catch(() => undefined);
      request.log.info({ monitorId }, 'monitor deleted');
      sendNoContent(reply);
    },
  );

  app.post(
    '/monitors/:id/capture',
    { preHandler: requireAuthenticated(deps.auth) },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const monitorId = parseUuid(id);

      const monitor = await queries.getMonitor(deps.db, monitorId);
      if (!monitor) throw notFound('Monitor not found');

      const jobId = await deps.scheduler?.enqueueCapture(monitorId, true);

      // Without a scheduler (API-only process, or a test) the capture runs inline. The
      // response is still 202 with the same shape so clients have one code path.
      void reply.status(202).send({
        mode: deps.scheduler ? 'queued' : 'inline',
        jobId: jobId ?? null,
        monitorId,
        queuedAt: new Date().toISOString(),
      });

      if (!deps.scheduler) {
        await deps.executeCapture(monitorId).catch((error: Error) => {
          request.log.error({ monitorId, error: error.message }, 'inline capture failed');
        });
      }
    },
  );

  app.post(
    '/monitors/:id/pause',
    { preHandler: requireAuthenticated(deps.auth) },
    async (request) => {
      const { id } = request.params as { id: string };
      const monitor = await queries.setMonitorPaused(deps.db, parseUuid(id), true);
      if (!monitor) throw notFound('Monitor not found');
      await deps.scheduler?.sync().catch(() => undefined);
      return monitor;
    },
  );

  app.post(
    '/monitors/:id/resume',
    { preHandler: requireAuthenticated(deps.auth) },
    async (request) => {
      const { id } = request.params as { id: string };
      const monitor = await queries.setMonitorPaused(deps.db, parseUuid(id), false);
      if (!monitor) throw notFound('Monitor not found');
      await deps.scheduler?.sync().catch(() => undefined);
      return monitor;
    },
  );

  app.get(
    '/monitors/:id/snapshots',
    { preHandler: requireAuthenticated(deps.auth) },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const monitorId = parseUuid(id);
      const query = parseOrThrow(snapshotListQuerySchema, request.query);

      const page = await queries.listSnapshots(deps.db, monitorId, {
        status: query.status,
        limit: query.limit,
        cursor: query.cursor ?? null,
      });
      sendPage(reply, page);
    },
  );

  app.get(
    '/monitors/:id/changes',
    { preHandler: requireAuthenticated(deps.auth) },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const monitorId = parseUuid(id);
      const query = parseOrThrow(changeListQuerySchema, request.query);

      const page = await queries.listChanges(deps.db, monitorId, {
        significant: query.significant,
        limit: query.limit,
        cursor: query.cursor ?? null,
      });
      sendPage(reply, page);
    },
  );
}
