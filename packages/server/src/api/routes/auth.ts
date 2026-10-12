import type { AppInstance } from '../types.js';
import { apiTokenCreateSchema, loginSchema } from '@pagefreeze/shared';
import type { AppDeps } from '../deps.js';
import { parseOrThrow, sendCreated, sendNoContent } from '../http.js';
import { notFound } from '../errors.js';
import { generateToken, hashToken, login, logout, requireAuthenticated } from '../auth.js';
import * as queries from '../../db/queries.js';

const TOKEN_PREFIX = 'pfz';

function toApiToken(row: queries.ApiTokenRow) {
  return {
    id: row.id,
    name: row.name,
    prefix: row.prefix,
    createdAt: row.created_at.toISOString(),
    expiresAt: row.expires_at?.toISOString() ?? null,
    lastUsedAt: row.last_used_at?.toISOString() ?? null,
    revokedAt: row.revoked_at?.toISOString() ?? null,
  };
}

export async function registerAuthRoutes(app: AppInstance, deps: AppDeps): Promise<void> {
  app.post(
    '/auth/login',
    {
      config: {
        rateLimit: {
          max: 10,
          timeWindow: '5 minutes',

          keyGenerator: (request) =>
            (request.ip ?? request.socket.remoteAddress ?? 'unknown').toString(),
        },
      },
    },
    async (request, reply) => {
      const body = parseOrThrow(loginSchema, request.body);
      const result = await login(deps.auth, request, reply, body);

      request.log.info({ username: result.username }, 'admin login');
      void reply.send({
        username: result.username,
        csrfToken: request.cookies?.['pagefreeze_csrf'] ?? null,
      });
    },
  );

  app.post('/auth/logout', async (request, reply) => {
    await logout(deps.auth, request, reply);
    sendNoContent(reply);
  });

  app.get('/auth/me', { preHandler: requireAuthenticated(deps.auth) }, async (request) => {
    const auth = request.auth!;
    return {
      username: auth.principal,
      kind: auth.kind,

      csrfToken: auth.kind === 'session' ? (auth.csrfToken ?? null) : null,
      permissions: ['admin'],
    };
  });

  app.get('/tokens', { preHandler: requireAuthenticated(deps.auth) }, async () => {
    const rows = await queries.listApiTokens(deps.db);
    return { data: rows.map(toApiToken) };
  });

  app.post('/tokens', { preHandler: requireAuthenticated(deps.auth) }, async (request, reply) => {
    const body = parseOrThrow(apiTokenCreateSchema, request.body);

    const generated = generateToken(TOKEN_PREFIX);
    const expiresAt = body.expiresInDays
      ? new Date(Date.now() + body.expiresInDays * 86_400_000)
      : null;

    const row = await queries.createApiToken(deps.db, {
      name: body.name,
      prefix: generated.token.slice(0, 12),
      tokenHash: generated.hash,
      expiresAt,
    });

    request.log.info({ tokenId: row.id, name: row.name }, 'api token created');

    sendCreated(reply, { ...toApiToken(row), token: generated.token });
  });

  app.delete(
    '/tokens/:id',
    { preHandler: requireAuthenticated(deps.auth) },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const revoked = await queries.revokeApiToken(deps.db, id);
      if (!revoked) throw notFound('Token not found or already revoked');
      sendNoContent(reply);
    },
  );

  app.get('/auth/hash-check', { preHandler: requireAuthenticated(deps.auth) }, async (request) => {
    const auth = request.auth!;
    return {
      kind: auth.kind,
      principal: auth.principal,
      hash: hashToken(auth.principal).slice(0, 8),
    };
  });
}
