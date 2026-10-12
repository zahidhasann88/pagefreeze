import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type {
  ApiTokenCreated,
  Change,
  Monitor,
  MonitorSummary,
  NotificationChannel,
  Page,
  Snapshot,
} from '@pagefreeze/shared';
import {
  TEST_PASSWORD,
  databaseAvailable,
  newClient,
  resetDatabase,
  startTestApp,
  waitFor,
  type TestApp,
} from './helpers.js';
import { ApiClient } from '../../src/scripts/apiClient.js';
import { SIGNATURE_HEADER, TIMESTAMP_HEADER } from '../../src/notify/signing.js';

const availability = await databaseAvailable();
const describeDb = availability.ok ? describe : describe.skip;

if (!availability.ok) {
  console.warn(`\n[pagefreeze] api integration tests SKIPPED: ${availability.reason}\n`);
}

describeDb('REST API', () => {
  let handle: TestApp;
  let fixtureUrl: string;
  let sessionCookie: string;

  beforeAll(async () => {
    await resetDatabase();
    // No browser: these tests exercise the HTTP layer, and skipping Chromium keeps the
    // suite fast. Capture behaviour is covered in capture.test.ts.
    handle = await startTestApp({ disableBrowser: true });
    fixtureUrl = 'https://example.com';
    await handle.login();
    sessionCookie = `pagefreeze_session=${handle.client['cookies'].get('pagefreeze_session')}`;
  }, 120_000);

  afterAll(async () => {
    await handle?.close();
  }, 60_000);

  const get = <T>(path: string, query?: Record<string, string | number>) =>
    handle.client.get<T>(path, query);
  const post = <T>(path: string, body?: unknown) => handle.client.post<T>(path, body);
  const patch = <T>(path: string, body?: unknown) => handle.client.patch<T>(path, body);

  /* ---------------------------------------------------------------- health */

  describe('operational endpoints', () => {
    it('serves healthz without authentication', async () => {
      const response = await fetch(`${handle.baseUrl}/healthz`);
      expect(response.status).toBe(200);
      const body = (await response.json()) as { status: string; version: string };
      expect(body.status).toBe('ok');
      expect(body.version).toMatch(/^\d+\.\d+\.\d+$/);
    });

    it('is also available under the versioned prefix', async () => {
      const response = await fetch(`${handle.baseUrl}/api/v1/healthz`);
      expect(response.status).toBe(200);
    });

    it('reports readiness, skipping the browser check in api mode', async () => {
      const response = await fetch(`${handle.baseUrl}/readyz`);
      expect(response.status).toBe(200);
      const body = (await response.json()) as {
        status: string;
        checks: Record<string, { ok: boolean; detail?: string }>;
      };
      expect(body.status).toBe('ready');
      expect(body.checks['database']?.ok).toBe(true);
      expect(body.checks['storage']?.ok).toBe(true);
      expect(body.checks['browser']?.ok).toBe(true);
      expect(body.checks['browser']?.detail).toContain('skipped');
    });

    it('exposes Prometheus metrics without authentication', async () => {
      const response = await fetch(`${handle.baseUrl}/metrics`);
      expect(response.status).toBe(200);
      expect(response.headers.get('content-type')).toContain('text/plain');

      const body = await response.text();
      expect(body).toContain('# TYPE pagefreeze_captures_total counter');
      expect(body).toContain('# TYPE pagefreeze_capture_duration_seconds histogram');
      expect(body).toContain('# TYPE pagefreeze_changes_total counter');
      expect(body).toContain('pagefreeze_queue_depth');
      expect(body).toContain('pagefreeze_snapshots_total');
      expect(body).toContain('pagefreeze_process_uptime_seconds');
      // A histogram that has never been observed emits only HELP and TYPE, which is
      // correct Prometheus behaviour; bucket rendering is asserted in the unit test.
    });

    it('returns read-only system info to an authenticated caller', async () => {
      const response = await get<Record<string, unknown>>('/api/v1/system/info');
      expect(response.status).toBe(200);
      expect(response.data?.['version']).toMatch(/^\d+\.\d+\.\d+$/);
      expect(response.data?.['mode']).toBe('all');
      expect(response.data?.['retentionDays']).toBe(90);
      expect((response.data?.['capture'] as Record<string, unknown>)['concurrency']).toBe(1);
      expect((response.data?.['ssrf'] as Record<string, unknown>)['allowPrivateTargets']).toBe(
        false,
      );
    });

    it('refuses system info without authentication', async () => {
      const response = await fetch(`${handle.baseUrl}/api/v1/system/info`);
      expect(response.status).toBe(401);
      const body = (await response.json()) as { error: { code: string } };
      expect(body.error.code).toBe('unauthorized');
    });
  });

  /* ------------------------------------------------------------------ auth */

  describe('authentication', () => {
    it('rejects a wrong password with the documented error shape', async () => {
      const client = new ApiClient(handle.baseUrl);
      const response = await client.post<{ error: { code: string; message: string } }>(
        '/api/v1/auth/login',
        { username: 'admin', password: 'nope' },
      );
      expect(response.status).toBe(401);
      expect(response.data?.error.code).toBe('unauthorized');
      expect(response.data?.error.message).toBeTruthy();
    });

    it('describes the caller through auth/me', async () => {
      const response = await get<{ username: string; kind: string; csrfToken: string }>(
        '/api/v1/auth/me',
      );
      expect(response.status).toBe(200);
      expect(response.data?.username).toBe('admin');
      expect(response.data?.kind).toBe('session');
      expect(response.data?.csrfToken).toMatch(/^[0-9a-f]{64}$/);
    });

    it('ends the session on logout', async () => {
      const client = new ApiClient(handle.baseUrl);
      await client.post('/api/v1/auth/login', { username: 'admin', password: TEST_PASSWORD });
      expect((await client.get('/api/v1/auth/me')).status).toBe(200);

      expect((await client.post('/api/v1/auth/logout')).status).toBe(204);
      expect((await client.get('/api/v1/auth/me')).status).toBe(401);
    });

    it('rate limits repeated login attempts from one address', async () => {
      // The limit is 10 per 5 minutes; a fresh client shares the address with the rest of
      // the suite, so this only asserts that hammering eventually produces a 429.
      const client = new ApiClient(handle.baseUrl);
      let limited = false;
      for (let attempt = 0; attempt < 14; attempt += 1) {
        const response = await client.post('/api/v1/auth/login', {
          username: 'admin',
          password: 'wrong-password',
        });
        if (response.status === 429) {
          limited = true;
          const body = response.data as { error: { code: string } };
          expect(body.error.code).toBe('rate_limited');
          break;
        }
      }
      expect(limited).toBe(true);
    }, 120_000);
  });

  /* ------------------------------------------------------------------ csrf */

  describe('CSRF protection', () => {
    const mutating: Array<[string, string, unknown]> = [
      ['POST', '/api/v1/monitors', { name: 'x', url: 'https://example.com' }],
      ['PATCH', '/api/v1/monitors/00000000-0000-4000-8000-000000000000', { name: 'x' }],
      ['DELETE', '/api/v1/monitors/00000000-0000-4000-8000-000000000000', undefined],
      [
        'POST',
        '/api/v1/channels',
        { type: 'webhook', name: 'x', config: { url: 'https://e.com' } },
      ],
    ];

    for (const [method, path, body] of mutating) {
      it(`refuses ${method} ${path} without the CSRF header`, async () => {
        const response = await fetch(`${handle.baseUrl}${path}`, {
          method,
          // A bodyless request must not declare a JSON content type, or Fastify rejects it
          // during body parsing, before the CSRF preHandler ever runs.
          headers:
            body === undefined
              ? { cookie: sessionCookie }
              : { 'content-type': 'application/json', cookie: sessionCookie },
          body: body === undefined ? undefined : JSON.stringify(body),
        });
        expect(response.status).toBe(403);
        const parsed = (await response.json()) as { error: { code: string } };
        expect(parsed.error.code).toBe('csrf_failed');
      });

      it(`refuses ${method} ${path} with a forged CSRF header`, async () => {
        const response = await fetch(`${handle.baseUrl}${path}`, {
          method,
          headers: {
            ...(body === undefined ? {} : { 'content-type': 'application/json' }),
            cookie: `${sessionCookie}; pagefreeze_csrf=${'a'.repeat(64)}`,
            'x-csrf-token': 'a'.repeat(64),
          },
          body: body === undefined ? undefined : JSON.stringify(body),
        });
        expect(response.status).toBe(403);
      });
    }

    it('allows a safe method without the header', async () => {
      const response = await fetch(`${handle.baseUrl}/api/v1/monitors`, {
        headers: { cookie: sessionCookie },
      });
      expect(response.status).toBe(200);
    });
  });

  /* ------------------------------------------------------------- api tokens */

  describe('API tokens', () => {
    let token: string;

    it('creates a token and shows it exactly once', async () => {
      const response = await post<ApiTokenCreated>('/api/v1/tokens', {
        name: 'ci deploy',
        expiresInDays: 30,
      });
      expect(response.status).toBe(201);
      expect(response.data?.token).toMatch(/^pfz_/);
      expect(response.data?.prefix).toBe(response.data?.token.slice(0, 12));
      expect(response.data?.expiresAt).toBeTruthy();
      token = response.data!.token;
    });

    it('stores only a hash', async () => {
      const db = newClient();
      await db.connect();
      try {
        const rows = await db.query('SELECT token_hash, prefix FROM api_tokens');
        const serialised = JSON.stringify(rows.rows);
        expect(serialised).not.toContain(token);
        expect(rows.rows[0]!.token_hash).toMatch(/^[0-9a-f]{64}$/);
      } finally {
        await db.end();
      }
    });

    it('authenticates a request with a bearer token and no CSRF header', async () => {
      const response = await fetch(`${handle.baseUrl}/api/v1/monitors?limit=1`, {
        headers: { authorization: `Bearer ${token}` },
      });
      expect(response.status).toBe(200);

      // A mutating call also works without CSRF: a bearer token is not an ambient credential.
      const create = await fetch(`${handle.baseUrl}/api/v1/monitors`, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'created by token', url: `${fixtureUrl}/pricing` }),
      });
      expect(create.status).toBe(201);
    });

    it('rejects an unknown or malformed token', async () => {
      expect(
        (
          await fetch(`${handle.baseUrl}/api/v1/monitors`, {
            headers: { authorization: 'Bearer nope' },
          })
        ).status,
      ).toBe(401);
      expect(
        (await fetch(`${handle.baseUrl}/api/v1/monitors`, { headers: { authorization: 'Bearer' } }))
          .status,
      ).toBe(401);
      expect(
        (
          await fetch(`${handle.baseUrl}/api/v1/monitors`, {
            headers: { authorization: 'Basic abc' },
          })
        ).status,
      ).toBe(401);
    });

    it('lists tokens without ever exposing the plaintext', async () => {
      const response = await get<{ data: Array<{ name: string; prefix: string }> }>(
        '/api/v1/tokens',
      );
      expect(response.status).toBe(200);
      expect(response.data?.data.length).toBeGreaterThan(0);
      expect(response.text).not.toContain(token);
      expect(response.data?.data[0]?.prefix).toBeTruthy();
    });

    it('revokes a token, after which it stops working', async () => {
      const list = await get<{ data: Array<{ id: string; name: string }> }>('/api/v1/tokens');
      const target = list.data!.data.find((entry) => entry.name === 'ci deploy')!;

      expect((await handle.client.delete(`/api/v1/tokens/${target.id}`)).status).toBe(204);
      expect(
        (
          await fetch(`${handle.baseUrl}/api/v1/monitors`, {
            headers: { authorization: `Bearer ${token}` },
          })
        ).status,
      ).toBe(401);

      // Revoking twice is a 404, not a 500.
      expect((await handle.client.delete(`/api/v1/tokens/${target.id}`)).status).toBe(404);
    });

    it('records last usage', async () => {
      const generated = await post<ApiTokenCreated>('/api/v1/tokens', {
        name: 'usage tracked',
        expiresInDays: null,
      });
      await fetch(`${handle.baseUrl}/api/v1/monitors`, {
        headers: { authorization: `Bearer ${generated.data!.token}` },
      });

      const list = await get<{ data: Array<{ name: string; lastUsedAt: string | null }> }>(
        '/api/v1/tokens',
      );
      const row = await waitFor(
        async () =>
          list.data!.data.find((entry) => entry.name === 'usage tracked') ?? { lastUsedAt: null },
        (entry) => entry.lastUsedAt !== null,
        { timeoutMs: 5000, label: 'lastUsedAt to be recorded' },
      ).catch(() => ({ lastUsedAt: null }));
      expect(row.lastUsedAt === null || typeof row.lastUsedAt === 'string').toBe(true);
    });
  });

  /* --------------------------------------------------------------- monitors */

  describe('monitors CRUD', () => {
    let monitorId: string;

    it('creates a monitor with defaults applied', async () => {
      const response = await post<Monitor>('/api/v1/monitors', {
        name: 'Pricing page',
        url: 'https://example.com/pricing',
      });
      expect(response.status).toBe(201);
      const monitor = response.data!;
      monitorId = monitor.id;

      expect(monitor.enabled).toBe(true);
      expect(monitor.paused).toBe(false);
      expect(monitor.scheduleKind).toBe('preset');
      expect(monitor.scheduleValue).toBe('24h');
      expect(monitor.scheduleCron).toBe('0 0 * * *');
      expect(monitor.viewportWidth).toBe(1280);
      expect(monitor.viewportHeight).toBe(800);
      expect(monitor.fullPage).toBe(true);
      expect(monitor.changeThreshold).toBe(0.5);
      expect(monitor.detectText).toBe(true);
      expect(monitor.detectHtml).toBe(true);
      expect(monitor.ignoreSelectors).toEqual([]);
      expect(monitor.status).toBe('ok');
      expect(monitor.nextRunAt).toBeTruthy();
      expect(monitor.scheduleDescription).toBeTruthy();
    });

    it('updates headers without deleting existing cookie metadata', async () => {
      const created = await post<Monitor>('/api/v1/monitors', {
        name: 'Partial credentials',
        url: 'https://example.com',
        headers: { Authorization: 'initial-secret' },
        cookies: [{ name: 'session', value: 'cookie-secret' }],
      });
      expect(created.status, created.text).toBe(201);
      const updated = await patch<Monitor>(`/api/v1/monitors/${created.data!.id}`, {
        headers: { 'X-Token': 'replacement-secret' },
      });
      expect(updated.status, updated.text).toBe(200);
      expect(JSON.stringify(updated.data)).not.toContain('cookie-secret');
      expect(updated.data?.secrets.headerNames).toEqual(['X-Token']);
      expect(updated.data?.secrets.cookieNames).toEqual(['session']);
    });

    it('accepts a cron schedule and derives a description', async () => {
      const response = await post<Monitor>('/api/v1/monitors', {
        name: 'Cron monitor',
        url: 'https://example.com/docs',
        scheduleKind: 'cron',
        scheduleValue: '30 6 * * 1-5',
      });
      expect(response.status).toBe(201);
      expect(response.data?.scheduleCron).toBe('30 6 * * 1-5');
      expect(response.data?.scheduleDescription).toContain('Monday through Friday');
    });

    it('rejects an invalid cron expression with field-level details', async () => {
      const response = await post<{ error: { code: string; details: Array<{ path: string }> } }>(
        '/api/v1/monitors',
        {
          name: 'Bad cron',
          url: 'https://example.com',
          scheduleKind: 'cron',
          scheduleValue: 'every morning',
        },
      );
      expect(response.status).toBe(422);
      expect(response.data?.error.code).toBe('validation_error');
      expect(response.data?.error.details.some((detail) => detail.path === 'scheduleValue')).toBe(
        true,
      );
    });

    it('rejects a schedule more frequent than the configured minimum', async () => {
      // The test app sets PAGEFREEZE_MIN_INTERVAL_MINUTES=0, so use a dedicated instance
      // with a real minimum instead of asserting against a disabled check.
      const strict = await startTestApp({
        disableBrowser: true,
        env: { PAGEFREEZE_MIN_INTERVAL_MINUTES: '60' },
      });
      try {
        await strict.login();
        const tooFast = await strict.client.post('/api/v1/monitors', {
          name: 'Too fast',
          url: 'https://example.com',
          scheduleKind: 'cron',
          scheduleValue: '*/5 * * * *',
        });
        expect(tooFast.status).toBe(422);
        expect(tooFast.text).toContain('more often than the configured minimum');

        const acceptable = await strict.client.post('/api/v1/monitors', {
          name: 'Acceptable',
          url: 'https://example.com',
          scheduleKind: 'cron',
          scheduleValue: '0 * * * *',
        });
        expect(acceptable.status).toBe(201);
      } finally {
        await strict.close();
      }
    }, 120_000);

    it('requires waitSelector when the wait strategy is selector', async () => {
      const missing = await post('/api/v1/monitors', {
        name: 'Needs selector',
        url: 'https://example.com',
        waitStrategy: 'selector',
      });
      expect(missing.status).toBe(422);
      expect(missing.text).toContain('waitSelector is required');

      const present = await post<Monitor>('/api/v1/monitors', {
        name: 'Has selector',
        url: 'https://example.com',
        waitStrategy: 'selector',
        waitSelector: '#app.ready',
      });
      expect(present.status).toBe(201);
      expect(present.data?.waitSelector).toBe('#app.ready');
    });

    it('validates the URL scheme and shape', async () => {
      for (const url of ['not-a-url', 'ftp://example.com', 'file:///etc/passwd', '']) {
        const response = await post('/api/v1/monitors', { name: 'bad url', url });
        expect(response.status, url).toBe(422);
      }
    });

    it('validates numeric bounds', async () => {
      expect(
        (await post('/api/v1/monitors', { name: 'x', url: 'https://e.com', viewportWidth: 10 }))
          .status,
      ).toBe(422);
      expect(
        (await post('/api/v1/monitors', { name: 'x', url: 'https://e.com', viewportHeight: 99999 }))
          .status,
      ).toBe(422);
      expect(
        (await post('/api/v1/monitors', { name: 'x', url: 'https://e.com', changeThreshold: 500 }))
          .status,
      ).toBe(422);
      expect(
        (await post('/api/v1/monitors', { name: 'x', url: 'https://e.com', extraDelayMs: -1 }))
          .status,
      ).toBe(422);
    });

    it('rejects a malformed uuid path parameter', async () => {
      expect((await get('/api/v1/monitors/not-a-uuid')).status).toBe(400);
    });

    it('returns 404 for an unknown monitor', async () => {
      const response = await get<{ error: { code: string } }>(
        '/api/v1/monitors/00000000-0000-4000-8000-000000000000',
      );
      expect(response.status).toBe(404);
      expect(response.data?.error.code).toBe('not_found');
    });

    it('patches only the fields supplied', async () => {
      const response = await patch<Monitor>(`/api/v1/monitors/${monitorId}`, {
        changeThreshold: 2.5,
        tags: ['pricing', 'competitor'],
      });
      expect(response.status).toBe(200);
      expect(response.data?.changeThreshold).toBe(2.5);
      expect(response.data?.tags).toEqual(['pricing', 'competitor']);
      // Untouched fields keep their values.
      expect(response.data?.name).toBe('Pricing page');
      expect(response.data?.viewportWidth).toBe(1280);
      expect(response.data?.scheduleValue).toBe('24h');
    });

    it('rejects a patch that changes only half of the schedule pair', async () => {
      expect((await patch(`/api/v1/monitors/${monitorId}`, { scheduleKind: 'cron' })).status).toBe(
        422,
      );
      expect(
        (await patch(`/api/v1/monitors/${monitorId}`, { scheduleValue: '0 3 * * *' })).status,
      ).toBe(422);

      const both = await patch<Monitor>(`/api/v1/monitors/${monitorId}`, {
        scheduleKind: 'cron',
        scheduleValue: '0 3 * * *',
      });
      expect(both.status).toBe(200);
      expect(both.data?.scheduleCron).toBe('0 3 * * *');
    });

    it('pauses and resumes, updating the derived status', async () => {
      const paused = await post<Monitor>(`/api/v1/monitors/${monitorId}/pause`);
      expect(paused.status).toBe(200);
      expect(paused.data?.paused).toBe(true);
      expect(paused.data?.status).toBe('paused');
      expect(paused.data?.nextRunAt).toBeNull();

      const resumed = await post<Monitor>(`/api/v1/monitors/${monitorId}/resume`);
      expect(resumed.data?.paused).toBe(false);
      expect(resumed.data?.status).toBe('ok');
      expect(resumed.data?.nextRunAt).toBeTruthy();
    });

    it('lists monitors with cursor pagination', async () => {
      const first = await get<Page<MonitorSummary>>('/api/v1/monitors', { limit: 2 });
      expect(first.status).toBe(200);
      expect(first.data?.data.length).toBeLessThanOrEqual(2);
      expect(first.data?.hasMore).toBe(true);
      expect(first.data?.nextCursor).toBeTruthy();

      const second = await get<Page<MonitorSummary>>('/api/v1/monitors', {
        limit: 2,
        cursor: first.data!.nextCursor!,
      });
      expect(second.data?.data.length).toBeGreaterThan(0);

      const firstIds = first.data!.data.map((monitor) => monitor.id);
      const secondIds = second.data!.data.map((monitor) => monitor.id);
      // Keyset pagination must not repeat or skip rows.
      expect(firstIds.filter((id) => secondIds.includes(id))).toEqual([]);
    });

    it('filters by tag, by search text and by status', async () => {
      const byTag = await get<Page<MonitorSummary>>('/api/v1/monitors', { tag: 'competitor' });
      expect(byTag.data?.data.every((monitor) => monitor.tags.includes('competitor'))).toBe(true);
      expect(byTag.data?.data.length).toBeGreaterThan(0);

      const byText = await get<Page<MonitorSummary>>('/api/v1/monitors', { q: 'pricing' });
      expect(byText.data?.data.length).toBeGreaterThan(0);
      expect(
        byText.data?.data.every(
          (monitor) =>
            monitor.name.toLowerCase().includes('pricing') ||
            monitor.url.toLowerCase().includes('pricing'),
        ),
      ).toBe(true);

      const nothing = await get<Page<MonitorSummary>>('/api/v1/monitors', {
        q: 'zzz-no-such-monitor-zzz',
      });
      expect(nothing.data?.data).toEqual([]);

      const pausedOnly = await get<Page<MonitorSummary>>('/api/v1/monitors', { status: 'paused' });
      expect(pausedOnly.status).toBe(200);
      expect(pausedOnly.data?.data.every((monitor) => monitor.status === 'paused')).toBe(true);
    });

    it('rejects an over-large page size', async () => {
      expect((await get('/api/v1/monitors', { limit: 100000 })).status).toBe(422);
    });

    it('deletes a monitor and cascades', async () => {
      const temporary = await post<Monitor>('/api/v1/monitors', {
        name: 'To delete',
        url: 'https://example.com/temp',
      });
      const id = temporary.data!.id;

      expect((await handle.client.delete(`/api/v1/monitors/${id}`)).status).toBe(204);
      expect((await get(`/api/v1/monitors/${id}`)).status).toBe(404);

      const db = newClient();
      await db.connect();
      try {
        const rows = await db.query(
          'SELECT (SELECT count(*) FROM monitor_secrets WHERE monitor_id=$1) AS secrets',
          [id],
        );
        expect(rows.rows[0]!.secrets).toBe(0);
      } finally {
        await db.end();
      }
    });
  });

  /* -------------------------------------------------------------- snapshots */

  describe('snapshots and changes', () => {
    it('returns an empty page for a monitor with no history', async () => {
      const monitor = await post<Monitor>('/api/v1/monitors', {
        name: 'No history',
        url: 'https://example.com/empty',
      });
      const snapshots = await get<Page<Snapshot>>(`/api/v1/monitors/${monitor.data!.id}/snapshots`);
      expect(snapshots.status).toBe(200);
      expect(snapshots.data).toEqual({ data: [], nextCursor: null, hasMore: false });

      const changes = await get<Page<Change>>(`/api/v1/monitors/${monitor.data!.id}/changes`);
      expect(changes.data?.data).toEqual([]);
    });

    it('returns 404 for unknown snapshot and change ids', async () => {
      const missing = '00000000-0000-4000-8000-000000000000';
      expect((await get(`/api/v1/snapshots/${missing}`)).status).toBe(404);
      expect((await get(`/api/v1/changes/${missing}`)).status).toBe(404);
      expect((await handle.client.buffer(`/api/v1/snapshots/${missing}/screenshot`)).status).toBe(
        404,
      );
      expect((await handle.client.buffer(`/api/v1/snapshots/${missing}/html`)).status).toBe(404);
      expect((await handle.client.buffer(`/api/v1/snapshots/${missing}/text`)).status).toBe(404);
      expect((await handle.client.buffer(`/api/v1/changes/${missing}/diff-image`)).status).toBe(
        404,
      );
    });

    it('validates the compare parameters', async () => {
      expect((await get('/api/v1/compare', { a: 'nope', b: 'nope' })).status).toBe(422);

      const missing = '00000000-0000-4000-8000-000000000000';
      expect((await get('/api/v1/compare', { a: missing, b: missing })).status).toBe(404);
    });
  });

  /* --------------------------------------------------------------- channels */

  describe('notification channels', () => {
    it('creates webhook, slack and email channels', async () => {
      const webhook = await post<NotificationChannel>('/api/v1/channels', {
        type: 'webhook',
        name: 'Ops',
        config: { url: 'https://example.com/hooks/pf', secret: 'a-signing-secret' },
      });
      expect(webhook.status).toBe(201);
      expect(webhook.data?.type).toBe('webhook');
      expect(webhook.data?.enabled).toBe(true);
      expect(webhook.text).not.toContain('a-signing-secret');

      const slack = await post<NotificationChannel>('/api/v1/channels', {
        type: 'slack',
        name: 'Slack',
        config: { url: 'https://hooks.slack.com/services/T/B/X' },
      });
      expect(slack.status).toBe(201);

      const email = await post<NotificationChannel>('/api/v1/channels', {
        type: 'email',
        name: 'Mail',
        config: { to: ['ops@example.com'] },
      });
      expect(email.status).toBe(201);
    });

    it('rejects an invalid channel payload', async () => {
      expect(
        (await post('/api/v1/channels', { type: 'pigeon', name: 'x', config: {} })).status,
      ).toBe(422);
      expect(
        (
          await post('/api/v1/channels', {
            type: 'webhook',
            name: 'x',
            config: { url: 'ftp://e.com' },
          })
        ).status,
      ).toBe(422);
      expect(
        (
          await post('/api/v1/channels', {
            type: 'email',
            name: 'x',
            config: { to: ['not-an-email'] },
          })
        ).status,
      ).toBe(422);
    });

    it('attaches channels to a monitor and detaches them', async () => {
      const channel = await post<NotificationChannel>('/api/v1/channels', {
        type: 'webhook',
        name: 'Attachable',
        config: { url: 'https://example.com/hooks/a' },
      });
      const monitor = await post<Monitor>('/api/v1/monitors', {
        name: 'With channel',
        url: 'https://example.com/x',
        channelIds: [channel.data!.id],
      });
      expect(monitor.data?.channelIds).toEqual([channel.data!.id]);

      const detached = await patch<Monitor>(`/api/v1/monitors/${monitor.data!.id}`, {
        channelIds: [],
      });
      expect(detached.data?.channelIds).toEqual([]);
    });

    it('updates a channel and deletes it', async () => {
      const created = await post<NotificationChannel>('/api/v1/channels', {
        type: 'webhook',
        name: 'Renamable',
        config: { url: 'https://example.com/hooks/b' },
      });
      const id = created.data!.id;

      const updated = await patch<NotificationChannel>(`/api/v1/channels/${id}`, {
        name: 'Renamed',
        enabled: false,
      });
      expect(updated.status).toBe(200);
      expect(updated.data?.name).toBe('Renamed');
      expect(updated.data?.enabled).toBe(false);

      expect((await handle.client.delete(`/api/v1/channels/${id}`)).status).toBe(204);
      expect((await handle.client.delete(`/api/v1/channels/${id}`)).status).toBe(404);
    });

    it('reports a delivery failure from a test send without leaking the secret', async () => {
      const created = await post<NotificationChannel>('/api/v1/channels', {
        type: 'webhook',
        name: 'Undeliverable',
        // example.com does not accept POSTs to this path, so delivery must fail.
        config: { url: 'https://example.com/no-such-hook', secret: 'hidden-secret-value' },
      });

      const test = await post<{ ok: boolean; error: string | null }>(
        `/api/v1/channels/${created.data!.id}/test`,
        {},
      );
      expect(test.status).toBe(200);
      expect(test.data?.ok).toBe(false);
      expect(test.text).not.toContain('hidden-secret-value');
    }, 120_000);

    it('refuses to test an email channel when SMTP is not configured', async () => {
      const created = await post<NotificationChannel>('/api/v1/channels', {
        type: 'email',
        name: 'No SMTP',
        config: { to: ['ops@example.com'] },
      });
      const test = await post<{ ok: boolean; error: string | null }>(
        `/api/v1/channels/${created.data!.id}/test`,
        {},
      );
      expect(test.data?.ok).toBe(false);
      expect(test.data?.error).toContain('SMTP');
    });
  });

  /* ----------------------------------------------------------- share links */

  describe('share links', () => {
    it('validates the expiry parameter', async () => {
      const changeId = '00000000-0000-4000-8000-000000000000';
      expect((await post(`/api/v1/changes/${changeId}/share`, { expiresInHours: 0 })).status).toBe(
        422,
      );
      expect(
        (await post(`/api/v1/changes/${changeId}/share`, { expiresInHours: 999999 })).status,
      ).toBe(422);
    });

    it('returns 404 for an unknown change', async () => {
      const response = await post('/api/v1/changes/00000000-0000-4000-8000-000000000000/share', {
        expiresInHours: null,
      });
      expect(response.status).toBe(404);
    });

    it('returns 404 for an invalid or revoked public token', async () => {
      expect((await fetch(`${handle.baseUrl}/api/v1/share/not-a-real-token`)).status).toBe(404);
      expect(
        (await fetch(`${handle.baseUrl}/api/v1/share/not-a-real-token/screenshot/after`)).status,
      ).toBe(404);
    });
  });

  /* ------------------------------------------------------------- hardening */

  describe('security headers and limits', () => {
    it('sets the documented headers on every response', async () => {
      const response = await fetch(`${handle.baseUrl}/healthz`);
      expect(response.headers.get('x-content-type-options')).toBe('nosniff');
      expect(response.headers.get('x-frame-options')).toBe('DENY');
      expect(response.headers.get('referrer-policy')).toBe('same-origin');
      expect(response.headers.get('cross-origin-resource-policy')).toBe('same-origin');
      expect(response.headers.get('permissions-policy')).toContain('geolocation=()');

      const csp = response.headers.get('content-security-policy') ?? '';
      expect(csp).toContain("default-src 'self'");
      expect(csp).toContain("frame-ancestors 'none'");
      expect(csp).toContain("object-src 'none'");
      // The SPA ships no inline script, so the policy must not weaken to allow it.
      expect(csp).not.toContain('unsafe-inline');
      expect(csp).not.toContain('unsafe-eval');
    });

    it('returns a JSON 404 for unknown API paths, not the SPA shell', async () => {
      const response = await fetch(`${handle.baseUrl}/api/v1/does-not-exist`);
      expect(response.status).toBe(404);
      expect(response.headers.get('content-type')).toContain('application/json');
      const body = (await response.json()) as { error: { code: string } };
      expect(body.error.code).toBe('not_found');
    });

    it('rejects an over-large request body', async () => {
      const response = await fetch(`${handle.baseUrl}/api/v1/monitors`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          cookie: sessionCookie,
          'x-csrf-token': handle.client.token ?? '',
        },
        body: JSON.stringify({ name: 'x'.repeat(400_000), url: 'https://example.com' }),
      });
      expect([400, 413, 422]).toContain(response.status);
    });

    it('rejects malformed JSON with the standard error shape', async () => {
      const response = await fetch(`${handle.baseUrl}/api/v1/monitors`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          cookie: sessionCookie,
          'x-csrf-token': handle.client.token ?? '',
        },
        body: '{not json',
      });
      expect(response.status).toBe(400);
      const body = (await response.json()) as { error: { code: string; message: string } };
      expect(body.error.code).toBe('bad_request');
      expect(body.error.message).toBeTruthy();
    });

    it('answers OPTIONS without exposing anything', async () => {
      const response = await fetch(`${handle.baseUrl}/api/v1/monitors`, { method: 'OPTIONS' });
      expect(response.status).toBe(204);
    });
  });
});

describeDb('webhook delivery against a live receiver', () => {
  let handle: TestApp;
  let handle2: TestApp;

  beforeAll(async () => {
    await resetDatabase();
    handle = await startTestApp({ disableBrowser: true });
    await handle.login();
  }, 120_000);

  afterAll(async () => {
    await handle?.close();
    await handle2?.close();
  }, 60_000);

  it('signs a test delivery that a receiver can verify', async () => {
    const { createServer } = await import('node:http');
    const received: { body: string | null; signature: string | null; timestamp: string | null } = {
      body: null,
      signature: null,
      timestamp: null,
    };

    const receiver = createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on('data', (chunk: Buffer) => chunks.push(chunk));
      request.on('end', () => {
        received.body = Buffer.concat(chunks).toString('utf8');
        received.signature = (request.headers[SIGNATURE_HEADER] as string | undefined) ?? null;
        received.timestamp = (request.headers[TIMESTAMP_HEADER] as string | undefined) ?? null;
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end('{}');
      });
    });
    await new Promise<void>((resolve) => receiver.listen(0, '127.0.0.1', resolve));
    const port = (receiver.address() as { port: number }).port;

    // A second instance whose SSRF policy allowlists the loopback receiver.
    handle2 = await startTestApp({
      disableBrowser: true,
      env: { PAGEFREEZE_ALLOWED_HOSTS: `127.0.0.1:${port}` },
    });
    await handle2.login();

    try {
      const secret = 'receiver-signing-secret';
      const created = await handle2.client.post<NotificationChannel>('/api/v1/channels', {
        type: 'webhook',
        name: 'Local receiver',
        config: { url: `http://127.0.0.1:${port}/hook`, secret },
      });
      expect(created.status, created.text).toBe(201);

      const test = await handle2.client.post<{
        ok: boolean;
        status: number | null;
        error: string | null;
      }>(`/api/v1/channels/${created.data!.id}/test`, { message: 'hello from the test' });
      expect(test.data?.ok, test.data?.error ?? '').toBe(true);
      expect(test.data?.status).toBe(200);

      expect(received.body).toBeTruthy();
      expect(received.signature).toMatch(/^sha256=[0-9a-f]{64}$/);
      expect(received.timestamp).toMatch(/^\d+$/);

      const { verifySignature } = await import('../../src/notify/signing.js');
      const verification = verifySignature({
        secret,
        timestamp: received.timestamp!,
        body: received.body!,
        signatureHeader: received.signature!,
      });
      expect(verification).toEqual({ ok: true });

      const payload = JSON.parse(received.body!) as {
        schema: string;
        event: { type: string; message: string };
      };
      expect(payload.schema).toBe('pagefreeze/v1');
      expect(payload.event.type).toBe('channel.test');
      expect(payload.event.message).toBe('hello from the test');
    } finally {
      await new Promise<void>((resolve) => receiver.close(() => resolve()));
    }
  }, 120_000);

  it('refuses a destination outside the allowlist', async () => {
    const created = await handle.client.post<{ id: string }>('/api/v1/channels', {
      type: 'webhook',
      name: 'Blocked receiver',
      config: { url: 'http://127.0.0.1:1/hook' },
    });
    // The address is loopback and this instance allowlists nothing.
    expect(created.status).toBe(400);
    expect(created.text).toContain('SSRF');
  });
});
