import { describe, expect, it, vi } from 'vitest';
import {
  CSRF_COOKIE,
  CSRF_HEADER,
  SESSION_COOKIE,
  cookieOptions,
  generateToken,
  hashToken,
  login,
  logout,
  requireAuth,
  requireCsrf,
  type AuthOptions,
} from '../../src/api/auth.js';
import { hashPassword } from '../../src/crypto/password.js';
import type { Database } from '../../src/db/pool.js';
import { AppError } from '../../src/api/errors.js';

/**
 * A Database double that stores sessions and tokens in memory, so the auth flow can be
 * exercised end to end without PostgreSQL. The real database path is covered by the
 * integration suite.
 */
function fakeDb() {
  const sessions = new Map<string, Record<string, unknown>>();
  const tokens = new Map<string, Record<string, unknown>>();

  const db = {
    query: vi.fn(async (text: string, params: unknown[] = []) => {
      const sql = text.replace(/\s+/g, ' ').trim();

      if (sql.startsWith('INSERT INTO sessions')) {
        const row = {
          id: `session-${sessions.size + 1}`,
          username: params[0],
          token_hash: params[1],
          csrf_token: params[2],
          expires_at: new Date(params[3] as string),
          created_at: new Date(),
          last_seen_at: new Date(),
          user_agent: params[4],
        };
        sessions.set(row.token_hash as string, row);
        return { rows: [row], rowCount: 1 };
      }

      if (sql.startsWith('SELECT * FROM sessions')) {
        const row = sessions.get(params[0] as string);
        const valid = row && (row['expires_at'] as Date).getTime() > Date.now();
        return { rows: valid ? [row] : [], rowCount: valid ? 1 : 0 };
      }

      if (sql.startsWith('DELETE FROM sessions')) {
        sessions.delete(params[0] as string);
        return { rows: [], rowCount: 1 };
      }

      if (sql.startsWith('UPDATE sessions')) {
        return { rows: [], rowCount: 1 };
      }

      if (sql.startsWith('SELECT * FROM api_tokens')) {
        const row = tokens.get(params[0] as string);
        return { rows: row ? [row] : [], rowCount: row ? 1 : 0 };
      }

      if (sql.startsWith('UPDATE api_tokens')) {
        return { rows: [], rowCount: 1 };
      }

      return { rows: [], rowCount: 0 };
    }),
    transaction: vi.fn(),
    end: vi.fn(),
    ping: vi.fn(),
    raw: vi.fn(),
  } as unknown as Database;

  return { db, sessions, tokens, queryMock: db.query as unknown as ReturnType<typeof vi.fn> };
}

interface FakeRequest {
  headers: Record<string, string | undefined>;
  cookies: Record<string, string | undefined>;
  method: string;
  auth?: unknown;
}

function makeRequest(overrides: Partial<FakeRequest> = {}): FakeRequest {
  return {
    headers: {},
    cookies: {},
    method: 'GET',
    ...overrides,
  } as FakeRequest;
}

function makeReply() {
  const cookies = new Map<string, { value: string; options: Record<string, unknown> }>();
  const cleared: string[] = [];
  return {
    cookies,
    cleared,
    setCookie(name: string, value: string, options: Record<string, unknown>) {
      cookies.set(name, { value, options });
      return this;
    },
    clearCookie(name: string) {
      cleared.push(name);
      return this;
    },
  };
}

interface TestAuthOptions extends AuthOptions {
  queryMock: ReturnType<typeof vi.fn>;
}

async function makeAuthOptions(password = 'a-strong-password'): Promise<TestAuthOptions> {
  const { db, queryMock } = fakeDb();
  return {
    db,
    queryMock,
    adminUsername: 'admin',
    adminPasswordHash: await hashPassword(password),
    secureCookies: false,
    sessionTtlHours: 24,
    baseUrl: '',
  };
}

describe('hashToken', () => {
  it('is a stable sha256 hex digest', () => {
    expect(hashToken('abc')).toMatch(/^[0-9a-f]{64}$/);
    expect(hashToken('abc')).toBe(hashToken('abc'));
    expect(hashToken('abc')).not.toBe(hashToken('abd'));
  });
});

describe('generateToken', () => {
  it('produces a prefixed token and its hash', () => {
    const generated = generateToken('pfz');
    expect(generated.token.startsWith('pfz_')).toBe(true);
    expect(generated.prefix).toBe('pfz');
    expect(generated.hash).toBe(hashToken(generated.token));
  });

  it('produces unique tokens', () => {
    const tokens = new Set(Array.from({ length: 100 }, () => generateToken('pfz').token));
    expect(tokens.size).toBe(100);
  });
});

describe('cookieOptions', () => {
  it('is httpOnly, SameSite=Lax and path-scoped', () => {
    const options = cookieOptions(false);
    expect(options).toMatchObject({ path: '/', httpOnly: true, secure: false, sameSite: 'lax' });
    expect(options.maxAge).toBeUndefined();
  });

  it('sets Secure when the deployment is HTTPS', () => {
    expect(cookieOptions(true).secure).toBe(true);
  });

  it('carries maxAge when given', () => {
    expect(cookieOptions(false, 3600).maxAge).toBe(3600);
  });
});

describe('login', () => {
  it('creates a session and sets both cookies on success', async () => {
    const options = await makeAuthOptions('hunter2-correct');
    const reply = makeReply();

    const result = await login(
      options,
      makeRequest({ headers: { 'user-agent': 'test-agent' } }) as never,
      reply as never,
      { username: 'admin', password: 'hunter2-correct' },
    );

    expect(result.username).toBe('admin');

    const session = reply.cookies.get(SESSION_COOKIE);
    expect(session).toBeDefined();
    expect(session?.options.httpOnly).toBe(true);
    expect(session?.options.sameSite).toBe('lax');
    expect(session?.options.maxAge).toBeGreaterThan(0);

    // The CSRF cookie must be readable by scripts for the double-submit check to work.
    const csrf = reply.cookies.get(CSRF_COOKIE);
    expect(csrf).toBeDefined();
    expect(csrf?.options.httpOnly).toBe(false);
    expect(csrf?.value).not.toBe(session?.value);
  });

  it('stores only a hash of the session token', async () => {
    const options = await makeAuthOptions('hunter2-correct');
    const reply = makeReply();
    await login(options, makeRequest() as never, reply as never, {
      username: 'admin',
      password: 'hunter2-correct',
    });

    const plaintext = reply.cookies.get(SESSION_COOKIE)!.value;
    const stored = options.queryMock.mock.calls
      .map((call: unknown[]) => call[1] as unknown[])
      .find((params: unknown[]) => Array.isArray(params) && params.length === 5);

    expect(stored?.[1]).toBe(hashToken(plaintext));
    expect(stored?.[1]).not.toBe(plaintext);
  });

  it('rejects a wrong password', async () => {
    const options = await makeAuthOptions('hunter2-correct');
    await expect(
      login(options, makeRequest() as never, makeReply() as never, {
        username: 'admin',
        password: 'wrong',
      }),
    ).rejects.toMatchObject({ status: 401, code: 'unauthorized' });
  });

  it('rejects a wrong username', async () => {
    const options = await makeAuthOptions('hunter2-correct');
    await expect(
      login(options, makeRequest() as never, makeReply() as never, {
        username: 'root',
        password: 'hunter2-correct',
      }),
    ).rejects.toMatchObject({ status: 401 });
  });

  it('matches the username case-insensitively but trims it', async () => {
    const options = await makeAuthOptions('hunter2-correct');
    const result = await login(options, makeRequest() as never, makeReply() as never, {
      username: '  ADMIN  ',
      password: 'hunter2-correct',
    });
    expect(result.username).toBe('ADMIN');
  });

  it('returns the same error for a wrong username and a wrong password', async () => {
    const options = await makeAuthOptions('hunter2-correct');
    const badUser = await login(options, makeRequest() as never, makeReply() as never, {
      username: 'nobody',
      password: 'hunter2-correct',
    }).catch((error: AppError) => error.message);
    const badPassword = await login(options, makeRequest() as never, makeReply() as never, {
      username: 'admin',
      password: 'nope',
    }).catch((error: AppError) => error.message);

    expect(badUser).toBe(badPassword);
  });
});

describe('logout', () => {
  it('deletes the session row and clears both cookies', async () => {
    const options = await makeAuthOptions('hunter2-correct');
    const reply = makeReply();
    await login(options, makeRequest() as never, reply as never, {
      username: 'admin',
      password: 'hunter2-correct',
    });

    const token = reply.cookies.get(SESSION_COOKIE)!.value;
    const logoutReply = makeReply();
    await logout(
      options,
      makeRequest({ cookies: { [SESSION_COOKIE]: token } }) as never,
      logoutReply as never,
    );

    expect(logoutReply.cleared).toContain(SESSION_COOKIE);
    expect(logoutReply.cleared).toContain(CSRF_COOKIE);

    // The token no longer resolves.
    await expect(
      requireAuth(options)(makeRequest({ cookies: { [SESSION_COOKIE]: token } }) as never),
    ).rejects.toMatchObject({
      status: 401,
    });
  });

  it('is a no-op when there is no session cookie', async () => {
    const options = await makeAuthOptions();
    const reply = makeReply();
    await expect(logout(options, makeRequest() as never, reply as never)).resolves.toBeUndefined();
    expect(reply.cleared).toContain(SESSION_COOKIE);
  });
});

describe('requireAuth', () => {
  it('accepts a valid session cookie', async () => {
    const options = await makeAuthOptions('hunter2-correct');
    const reply = makeReply();
    await login(options, makeRequest() as never, reply as never, {
      username: 'admin',
      password: 'hunter2-correct',
    });
    const token = reply.cookies.get(SESSION_COOKIE)!.value;

    const request = makeRequest({ cookies: { [SESSION_COOKIE]: token } });
    await expect(requireAuth(options)(request as never)).resolves.toBeUndefined();
    expect((request.auth as { kind: string }).kind).toBe('session');
    expect((request.auth as { principal: string }).principal).toBe('admin');
  });

  it('rejects a missing cookie', async () => {
    const options = await makeAuthOptions();
    await expect(requireAuth(options)(makeRequest() as never)).rejects.toMatchObject({
      status: 401,
      code: 'unauthorized',
    });
  });

  it('rejects a forged cookie', async () => {
    const options = await makeAuthOptions();
    const request = makeRequest({ cookies: { [SESSION_COOKIE]: 'forged-token-value' } });
    await expect(requireAuth(options)(request as never)).rejects.toMatchObject({ status: 401 });
  });

  it('rejects an empty bearer token', async () => {
    const options = await makeAuthOptions();
    const request = makeRequest({ headers: { authorization: 'Bearer ' } });
    await expect(requireAuth(options)(request as never)).rejects.toMatchObject({ status: 401 });
  });

  it('accepts a valid bearer token without a CSRF check', async () => {
    const options = await makeAuthOptions();
    const generated = generateToken('pfz');

    // Seed the token store the way createApiToken would.
    options.queryMock.mockImplementationOnce(
      async () =>
        ({
          rows: [
            {
              id: 'token-1',
              name: 'ci',
              prefix: generated.prefix,
              token_hash: generated.hash,
              created_at: new Date(),
              expires_at: null,
              last_used_at: null,
              revoked_at: null,
            },
          ],
          rowCount: 1,
        }) as never,
    );

    const request = makeRequest({
      method: 'POST',
      headers: { authorization: `Bearer ${generated.token}` },
    });
    await expect(requireAuth(options)(request as never)).resolves.toBeUndefined();
    expect((request.auth as { kind: string }).kind).toBe('token');

    // CSRF is a cookie-session concern only.
    await expect(requireCsrf()(request as never)).resolves.toBeUndefined();
  });
});

describe('requireCsrf', () => {
  async function withSession(method: string) {
    const options = await makeAuthOptions('hunter2-correct');
    const reply = makeReply();
    await login(options, makeRequest() as never, reply as never, {
      username: 'admin',
      password: 'hunter2-correct',
    });
    const csrf = reply.cookies.get(CSRF_COOKIE)!.value;
    const session = reply.cookies.get(SESSION_COOKIE)!.value;
    const request = makeRequest({
      method,
      cookies: { [SESSION_COOKIE]: session, [CSRF_COOKIE]: csrf },
    });
    await requireAuth(options)(request as never);
    return { request, csrf };
  }

  it('passes a GET regardless of the header', async () => {
    const { request } = await withSession('GET');
    await expect(requireCsrf()(request as never)).resolves.toBeUndefined();
  });

  for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
    it(`requires the header for ${method}`, async () => {
      const { request } = await withSession(method);
      await expect(requireCsrf()(request as never)).rejects.toMatchObject({
        status: 403,
        code: 'csrf_failed',
      });
    });

    it(`accepts ${method} with a matching header and cookie`, async () => {
      const { request, csrf } = await withSession(method);
      request.headers[CSRF_HEADER] = csrf;
      await expect(requireCsrf()(request as never)).resolves.toBeUndefined();
    });
  }

  it('rejects a header that does not match the session', async () => {
    const { request } = await withSession('POST');
    request.headers[CSRF_HEADER] = 'a'.repeat(64);
    await expect(requireCsrf()(request as never)).rejects.toMatchObject({ code: 'csrf_failed' });
  });

  it('rejects when the header matches but the cookie is missing', async () => {
    const { request, csrf } = await withSession('POST');
    request.headers[CSRF_HEADER] = csrf;
    delete request.cookies[CSRF_COOKIE];
    await expect(requireCsrf()(request as never)).rejects.toMatchObject({ code: 'csrf_failed' });
  });

  it('rejects when the cookie matches but the header is missing', async () => {
    const { request } = await withSession('POST');
    await expect(requireCsrf()(request as never)).rejects.toMatchObject({ code: 'csrf_failed' });
  });

  it('rejects an unauthenticated request before checking anything else', async () => {
    await expect(requireCsrf()(makeRequest({ method: 'POST' }) as never)).rejects.toMatchObject({
      status: 401,
    });
  });

  it('handles the header arriving as an array', async () => {
    const { request, csrf } = await withSession('POST');
    (request.headers as Record<string, unknown>)[CSRF_HEADER] = [csrf, 'other'];
    await expect(requireCsrf()(request as never)).resolves.toBeUndefined();
  });
});
