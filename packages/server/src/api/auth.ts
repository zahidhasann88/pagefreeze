import { randomBytes, timingSafeEqual } from 'node:crypto';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { Database } from '../db/pool.js';
import * as queries from '../db/queries.js';
import { sha256Hex } from '../crypto/secrets.js';
import { verifyPassword } from '../crypto/password.js';
import { csrfFailed, forbidden, unauthorized } from './errors.js';

export const SESSION_COOKIE = 'pagefreeze_session';
export const CSRF_COOKIE = 'pagefreeze_csrf';
export const CSRF_HEADER = 'x-csrf-token';

export type AuthKind = 'session' | 'token';

export interface AuthContext {
  kind: AuthKind;
  /** Admin username for sessions, token name for API tokens. */
  principal: string;
  sessionId?: string;
  tokenId?: string;
  csrfToken?: string;
}

declare module 'fastify' {
  interface FastifyRequest {
    auth?: AuthContext;
  }
}

export interface AuthOptions {
  db: Database;
  adminUsername: string;
  /** scrypt hash of PAGEFREEZE_ADMIN_PASSWORD, derived once at startup. */
  adminPasswordHash: string;
  secureCookies: boolean;
  sessionTtlHours: number;
  /** Base URL used to build share links. */
  baseUrl: string;
}

const MUTATING_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

export function hashToken(token: string): string {
  return sha256Hex(token);
}

export function generateToken(prefix: string): { token: string; prefix: string; hash: string } {
  const secret = randomBytes(32).toString('base64url');
  const token = `${prefix}_${secret}`;
  return { token, prefix, hash: hashToken(token) };
}

function equalSecret(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

export function cookieOptions(
  secure: boolean,
  maxAgeSeconds?: number,
): {
  path: string;
  httpOnly: boolean;
  secure: boolean;
  sameSite: 'lax';
  maxAge?: number;
} {
  return {
    path: '/',
    httpOnly: true,
    secure,
    sameSite: 'lax',
    ...(maxAgeSeconds !== undefined ? { maxAge: maxAgeSeconds } : {}),
  };
}

/**
 * Verify credentials and create a session row plus its cookies.
 *
 * The password comparison is scrypt-based and constant-time. The session token and the
 * CSRF token are separate 256-bit secrets: only the session token is httpOnly, and only
 * the CSRF token is readable by scripts, which is what makes the double-submit check
 * meaningful.
 */
export async function login(
  options: AuthOptions,
  request: FastifyRequest,
  reply: FastifyReply,
  credentials: { username: string; password: string },
): Promise<{ username: string }> {
  const usernameMatches =
    credentials.username.trim().toLowerCase() === options.adminUsername.trim().toLowerCase();

  // Always run the password check, even when the username is wrong, so that response
  // timing does not reveal which half of the pair was incorrect.
  const passwordOk = await verifyPassword(credentials.password, options.adminPasswordHash);

  if (!usernameMatches || !passwordOk) {
    throw unauthorized('Invalid username or password');
  }

  const sessionToken = randomBytes(32).toString('base64url');
  const csrfToken = randomBytes(32).toString('hex');
  const expiresAt = new Date(Date.now() + options.sessionTtlHours * 3_600_000);

  await queries.createSession(options.db, {
    username: credentials.username.trim(),
    tokenHash: hashToken(sessionToken),
    csrfToken,
    expiresAt,
    userAgent: (request.headers['user-agent'] ?? '').slice(0, 300) || null,
  });

  const maxAge = Math.floor((expiresAt.getTime() - Date.now()) / 1000);

  void reply.setCookie(SESSION_COOKIE, sessionToken, cookieOptions(options.secureCookies, maxAge));
  // The CSRF cookie must be readable by the SPA so it can echo the value in a header.
  void reply.setCookie(CSRF_COOKIE, csrfToken, {
    ...cookieOptions(options.secureCookies, maxAge),
    httpOnly: false,
  });

  return { username: credentials.username.trim() };
}

export async function logout(
  options: AuthOptions,
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  const token = request.cookies?.[SESSION_COOKIE];
  if (token) {
    await queries.deleteSession(options.db, hashToken(token)).catch(() => undefined);
  }
  void reply.clearCookie(SESSION_COOKIE, { path: '/' });
  void reply.clearCookie(CSRF_COOKIE, { path: '/' });
}

/**
 * Resolve the caller from either a session cookie or a bearer API token.
 * Returns null when neither is present or valid.
 */
export async function resolveAuth(
  options: AuthOptions,
  request: FastifyRequest,
): Promise<AuthContext | null> {
  const authorization = request.headers['authorization'];
  if (authorization && authorization.toLowerCase().startsWith('bearer ')) {
    const token = authorization.slice(7).trim();
    if (token.length === 0) return null;

    const row = await queries.findApiTokenByHash(options.db, hashToken(token));
    if (!row) return null;

    // Update last_used_at without awaiting it on the request path.
    void queries.touchApiToken(options.db, row.id).catch(() => undefined);

    return { kind: 'token', principal: row.name, tokenId: row.id };
  }

  const sessionToken = request.cookies?.[SESSION_COOKIE];
  if (!sessionToken) return null;

  const session = await queries.findSessionByHash(options.db, hashToken(sessionToken));
  if (!session) return null;

  void queries.touchSession(options.db, session.id).catch(() => undefined);

  return {
    kind: 'session',
    principal: session.username,
    sessionId: session.id,
    csrfToken: session.csrf_token,
  };
}

/**
 * Require an authenticated caller.
 *
 * Attached as a preHandler on every route except the public ones (login, health, share).
 */
export function requireAuth(options: AuthOptions) {
  return async (request: FastifyRequest): Promise<void> => {
    const auth = await resolveAuth(options, request);
    if (!auth) throw unauthorized();
    request.auth = auth;
  };
}

/**
 * CSRF protection for cookie-authenticated mutating requests.
 *
 * The check is a double submit: the caller must present, in a header that a cross-origin
 * page cannot set, the same CSRF token that is bound to the session row. Requests
 * authenticated with a bearer token are exempt because a token is not an ambient
 * credential and cannot be forged by another origin.
 *
 * `SameSite=Lax` on the session cookie already blocks cross-site POSTs in modern
 * browsers; this is the defence for the ones that do not.
 */
export function requireCsrf(force = false) {
  return async (request: FastifyRequest): Promise<void> => {
    const auth = request.auth;
    if (!auth) throw unauthorized();
    if (auth.kind !== 'session') return;
    if (!force && !MUTATING_METHODS.has(request.method)) return;

    const expected = auth.csrfToken;
    if (!expected) throw csrfFailed('Session is missing a CSRF token');

    const header = request.headers[CSRF_HEADER];
    const fromHeader = Array.isArray(header) ? header[0] : header;
    const fromCookie = request.cookies?.[CSRF_COOKIE];

    if (!fromHeader || !equalSecret(fromHeader, expected)) {
      throw csrfFailed(`Missing or invalid ${CSRF_HEADER} header`);
    }
    if (!fromCookie || !equalSecret(fromCookie, expected)) {
      throw csrfFailed('Missing or invalid CSRF cookie');
    }
  };
}

/** Require authentication *and* CSRF for mutating calls. */
export function requireAuthenticated(options: AuthOptions) {
  const auth = requireAuth(options);
  const csrf = requireCsrf();
  return async (request: FastifyRequest): Promise<void> => {
    await auth(request);
    await csrf(request);
  };
}

export function requirePrincipal(request: FastifyRequest): AuthContext {
  if (!request.auth) throw forbidden('Authentication required');
  return request.auth;
}
