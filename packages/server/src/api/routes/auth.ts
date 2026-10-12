import type { AppInstance } from '../types.js';
import { apiTokenCreateSchema, loginSchema } from '@pagefreeze/shared';
import type { AppDeps } from '../deps.js';
import { parseOrThrow, sendCreated, sendNoContent } from '../http.js';
import { notFound } from '../errors.js';
import { generateToken, hashToken, login, logout, requireAuthenticated } from '../auth.js';
import * as queries from '../../db/queries.js';

/** API tokens are shown exactly once; the stored form is a SHA-256 hash. */
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
  /**
   * Login is rate limited per client IP. The limit is deliberately tight: there is one
   * admin account, so a human typing a password slowly is never affected while an online
   * brute-force attempt is throttled hard.
   */
  app.post(
    '/auth/login',
    {
      config: {
        rateLimit: {
          max: 10,
          timeWindow: '5 minutes',
          // Key on the forwarded address when behind a trusted proxy.
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
      // Echoed so the SPA can attach it to mutating requests without a second call.
      csrfToken: auth.kind === 'session' ? (auth.csrfToken ?? null) : null,
      permissions: ['admin'],
    };
  });

  /* ----------------------------- API tokens ------------------------------ */

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

    // The plaintext token is returned once and never stored or logged.
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

  /** Used by the test suite and by operators rotating credentials. */
  app.get('/auth/hash-check', { preHandler: requireAuthenticated(deps.auth) }, async (request) => {
    const auth = request.auth!;
    return {
      kind: auth.kind,
      principal: auth.principal,
      hash: hashToken(auth.principal).slice(0, 8),
    };
  });
}
