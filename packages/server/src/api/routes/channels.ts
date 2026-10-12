import type { AppInstance } from '../types.js';
import { channelCreateSchema, channelTestSchema, channelUpdateSchema } from '@pagefreeze/shared';
import type { AppDeps } from '../deps.js';
import { parseOrThrow, parseUuid, sendCreated, sendNoContent } from '../http.js';
import { badRequest, notFound } from '../errors.js';
import { requireAuthenticated } from '../auth.js';
import * as queries from '../../db/queries.js';
import { encryptJson } from '../../crypto/secrets.js';
import { buildTestEvent } from '../../notify/events.js';
import { resolveChannelConfig } from '../../jobs/captureJob.js';

/**
 * Notification channels.
 *
 * The `config` column stores only the non-secret view (webhook URL, recipients); the full
 * config including any HMAC signing secret is stored encrypted in `config_enc`. Only the
 * non-secret view is ever returned, so a signing key cannot be read back out of the API
 * once the channel exists.
 */
function sanitizeConfig(type: string, config: Record<string, unknown>): Record<string, unknown> {
  if (type === 'email') {
    return {
      to: config['to'] ?? [],
      ...(typeof config['subject'] === 'string' ? { subject: config['subject'] } : {}),
    };
  }
  // webhook and slack: keep the url, record whether a secret exists but never its value.
  return {
    url: config['url'] ?? '',
    hasSecret: Boolean(config['secret']),
  };
}

export async function registerChannelRoutes(app: AppInstance, deps: AppDeps): Promise<void> {
  app.get('/channels', { preHandler: requireAuthenticated(deps.auth) }, async () => {
    return { data: await queries.listChannels(deps.db) };
  });

  app.post('/channels', { preHandler: requireAuthenticated(deps.auth) }, async (request, reply) => {
    const body = parseOrThrow(channelCreateSchema, request.body);

    if ('url' in body.config) {
      const verdict = await deps.guard.checkUrl(body.config.url as string);
      if (!verdict.allowed) {
        throw badRequest(
          `Webhook destination is not allowed by the SSRF policy: ${verdict.reason}`,
        );
      }
    }

    const channel = await queries.createChannel(deps.db, {
      name: body.name,
      type: body.type,
      enabled: body.enabled,
      config: sanitizeConfig(body.type, body.config as Record<string, unknown>),
      configEnc: encryptJson(body.config, deps.keyProvider),
    });

    request.log.info({ channelId: channel.id, type: channel.type }, 'notification channel created');
    sendCreated(reply, channel);
  });

  app.patch('/channels/:id', { preHandler: requireAuthenticated(deps.auth) }, async (request) => {
    const { id } = request.params as { id: string };
    const channelId = parseUuid(id);

    const existing = await queries.getChannelRow(deps.db, channelId);
    if (!existing) throw notFound('Channel not found');

    const body = parseOrThrow(channelUpdateSchema, request.body);
    const type = body.type ?? existing.type;

    if (body.config && 'url' in body.config) {
      const verdict = await deps.guard.checkUrl(body.config.url as string);
      if (!verdict.allowed) {
        throw badRequest(
          `Webhook destination is not allowed by the SSRF policy: ${verdict.reason}`,
        );
      }
    }

    const updated = await queries.updateChannel(deps.db, channelId, {
      ...(body.name !== undefined ? { name: body.name } : {}),
      ...(body.enabled !== undefined ? { enabled: body.enabled } : {}),
      ...(body.type !== undefined ? { type } : {}),
      ...(body.config
        ? {
            config: sanitizeConfig(type, body.config as Record<string, unknown>),
            configEnc: encryptJson(body.config, deps.keyProvider),
          }
        : {}),
    });

    return updated;
  });

  app.delete(
    '/channels/:id',
    { preHandler: requireAuthenticated(deps.auth) },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      if (!(await queries.deleteChannel(deps.db, parseUuid(id)))) {
        throw notFound('Channel not found');
      }
      sendNoContent(reply);
    },
  );

  /**
   * Send a test notification through the channel and report the delivery result.
   * This is the only endpoint that surfaces a delivery error string to the client, and
   * it never includes the destination secret.
   */
  app.post(
    '/channels/:id/test',
    { preHandler: requireAuthenticated(deps.auth) },
    async (request) => {
      const { id } = request.params as { id: string };
      const channelId = parseUuid(id);

      const row = await queries.getChannelRow(deps.db, channelId);
      if (!row) throw notFound('Channel not found');

      const body = parseOrThrow(channelTestSchema, request.body ?? {});
      const config = await resolveChannelConfig(row, deps.keyProvider, deps.logger);
      const event = buildTestEvent(body.message ?? null, deps.clock.now());

      const result = await deps.notifier.deliver({ id: row.id, name: row.name }, config, event);
      await queries.recordChannelDelivery(
        deps.db,
        channelId,
        result.ok ? null : (result.error ?? `status ${result.status ?? 'unknown'}`),
      );

      return {
        ok: result.ok,
        status: result.status ?? null,
        error: result.ok ? null : (result.error ?? null),
        durationMs: result.durationMs,
      };
    },
  );
}
