import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Change, Monitor, Page, Snapshot } from '@pagefreeze/shared';
import {
  databaseAvailable,
  fixtureOf,
  fixtureUrlOf,
  resetDatabase,
  startTestApp,
  waitFor,
  type TestApp,
} from './helpers.js';

const availability = await databaseAvailable();
const describeDb = availability.ok ? describe : describe.skip;

if (!availability.ok) {
  console.warn(`\n[pagefreeze] share/compare tests SKIPPED: ${availability.reason}\n`);
}

describeDb('share links and comparison', () => {
  let handle: TestApp;
  let monitor: Monitor;
  let change: Change;
  let snapshots: Snapshot[];

  beforeAll(async () => {
    await resetDatabase();
    handle = await startTestApp();
    await handle.login();

    const fixtureUrl = fixtureUrlOf(handle);
    const fixture = fixtureOf(handle);
    fixture.setState({ price: '$19', terms: ['Original terms.'] });

    const created = await handle.client.post<Monitor>('/api/v1/monitors', {
      name: 'Shareable',
      url: `${fixtureUrl}/static`,
      changeThreshold: 0.05,
      ignoreSelectors: [],
    });
    expect(created.status, created.text).toBe(201);
    monitor = created.data!;

    for (const round of [0, 1]) {
      if (round === 1) {
        fixture.setState({ price: '$59', terms: ['Rewritten terms.', 'A new clause.'] });
      }
      await handle.client.post(`/api/v1/monitors/${monitor.id}/capture`);
      await waitFor(
        async () =>
          (
            await handle.client.get<Page<Snapshot>>(`/api/v1/monitors/${monitor.id}/snapshots`, {
              limit: 10,
            })
          ).data?.data ?? [],
        (rows) => rows.length >= round + 1,
        { timeoutMs: 120_000, label: `snapshot ${round + 1}` },
      );
    }

    const changes = await handle.client.get<Page<Change>>(
      `/api/v1/monitors/${monitor.id}/changes`,
      { limit: 10 },
    );
    expect(changes.data?.data.length).toBeGreaterThan(0);
    change = changes.data!.data[0]!;

    snapshots = (
      await handle.client.get<Page<Snapshot>>(`/api/v1/monitors/${monitor.id}/snapshots`, {
        limit: 10,
      })
    ).data!.data;
  }, 240_000);

  afterAll(async () => {
    await handle?.close();
  }, 60_000);

  describe('public share links', () => {
    let shareUrl: string;
    let token: string;
    let shareId: string;

    it('creates a link with an unguessable token', async () => {
      const response = await handle.client.post<{
        id: string;
        url: string;
        token: string;
        expiresAt: string | null;
      }>(`/api/v1/changes/${change.id}/share`, { expiresInHours: 24 });

      expect(response.status).toBe(201);
      expect(response.data?.url).toContain('/share/');
      expect(response.data?.expiresAt).toBeTruthy();
      shareUrl = response.data!.url;
      token = response.data!.token;
      shareId = response.data!.id;

      expect(token.length).toBeGreaterThan(40);
      expect(token).toMatch(/^[A-Za-z0-9_-]+$/);
    });

    it('stores only a hash of the token', async () => {
      const { newClient } = await import('./helpers.js');
      const db = newClient();
      await db.connect();
      try {
        const rows = await db.query('SELECT token_hash FROM share_links');
        expect(JSON.stringify(rows.rows)).not.toContain(token);
        expect(rows.rows[0]!.token_hash).toMatch(/^[0-9a-f]{64}$/);
      } finally {
        await db.end();
      }
    });

    it('is readable without any credentials', async () => {
      const path = new URL(shareUrl).pathname.replace('/share', '/api/v1/share');
      const response = await fetch(`${handle.baseUrl}${path}`);
      expect(response.status).toBe(200);

      const body = (await response.json()) as {
        change: Change;
        monitor: { name: string | null; url: string | null };
        urls: Record<string, string | null>;
      };
      expect(body.change.id).toBe(change.id);
      expect(body.monitor.name).toBe('Shareable');
      expect(body.urls.after).toContain('/screenshot/after');
    });

    it('serves the artefacts through token-scoped routes', async () => {
      const base = `${handle.baseUrl}/api/v1/share/${token}`;

      const after = await fetch(`${base}/screenshot/after`);
      expect(after.status).toBe(200);
      expect(after.headers.get('content-type')).toContain('image/png');

      expect(after.headers.get('cache-control')).toContain('no-store');

      if (change.hasDiffImage) {
        const diff = await fetch(`${base}/screenshot/diff`);
        expect(diff.status).toBe(200);
        expect(diff.headers.get('content-type')).toContain('image/png');
      }
      const before = await fetch(`${base}/screenshot/before`);
      expect(before.status).toBe(200);

      const text = await fetch(`${base}/text/after`);
      expect(text.status).toBe(200);
      expect(text.headers.get('content-type')).toContain('text/plain');
      expect(await text.text()).toContain('$59');
    });

    it('rejects an unknown artefact name', async () => {
      const response = await fetch(`${handle.baseUrl}/api/v1/share/${token}/screenshot/sideways`);
      expect(response.status).toBe(404);
    });

    it('counts views', async () => {
      const path = `/api/v1/share/${token}`;
      await fetch(`${handle.baseUrl}${path}`);
      await fetch(`${handle.baseUrl}${path}`);

      const list = await handle.client.get<{
        data: Array<{ id: string; viewCount: number; active: boolean }>;
      }>(`/api/v1/changes/${change.id}/shares`);
      const row = list.data?.data.find((entry) => entry.id === shareId);
      expect(row?.viewCount).toBeGreaterThanOrEqual(2);
      expect(row?.active).toBe(true);
    });

    it('grants nothing beyond the shared change', async () => {
      expect((await fetch(`${handle.baseUrl}/api/v1/monitors`)).status).toBe(401);
      expect(
        (await fetch(`${handle.baseUrl}/api/v1/snapshots/${snapshots[0]!.id}/screenshot`)).status,
      ).toBe(401);

      expect(
        (await fetch(`${handle.baseUrl}/api/v1/share/${token}/screenshot/diff`)).status === 200 ||
          (await fetch(`${handle.baseUrl}/api/v1/share/${token}/screenshot/diff`)).status === 404,
      ).toBe(true);
    });

    it('can be revoked, after which it stops working', async () => {
      const revoked = await handle.client.delete(`/api/v1/shares/${shareId}`);
      expect(revoked.status).toBe(204);

      expect((await fetch(`${handle.baseUrl}/api/v1/share/${token}`)).status).toBe(404);
      expect((await fetch(`${handle.baseUrl}/api/v1/share/${token}/screenshot/after`)).status).toBe(
        404,
      );

      expect((await handle.client.delete(`/api/v1/shares/${shareId}`)).status).toBe(404);
    });

    it('expires when the window passes', async () => {
      const created = await handle.client.post<{ token: string; url: string }>(
        `/api/v1/changes/${change.id}/share`,
        { expiresInHours: 1 },
      );
      expect(created.status).toBe(201);

      const { newClient } = await import('./helpers.js');
      const db = newClient();
      await db.connect();
      try {
        await db.query(
          `UPDATE share_links SET expires_at = now() - interval '1 hour'
            WHERE token_hash = (SELECT token_hash FROM share_links ORDER BY created_at DESC LIMIT 1)`,
        );
      } finally {
        await db.end();
      }

      expect((await fetch(`${handle.baseUrl}/api/v1/share/${created.data!.token}`)).status).toBe(
        404,
      );
    });

    it('creates a never-expiring link when asked', async () => {
      const response = await handle.client.post<{ expiresAt: string | null; token: string }>(
        `/api/v1/changes/${change.id}/share`,
        { expiresInHours: null },
      );
      expect(response.status).toBe(201);
      expect(response.data?.expiresAt).toBeNull();
      expect((await fetch(`${handle.baseUrl}/api/v1/share/${response.data!.token}`)).status).toBe(
        200,
      );
    });
  });

  describe('on-demand comparison', () => {
    it('compares two snapshots without storing anything', async () => {
      const [older, newer] = [snapshots[snapshots.length - 1]!, snapshots[0]!];

      const response = await handle.client.get<{
        stored: boolean;
        changeId: string | null;
        diff: Record<string, unknown>;
      }>('/api/v1/compare', { a: older.id, b: newer.id });

      expect(response.status).toBe(200);
      expect(response.data?.stored).toBe(false);
      expect(response.data?.changeId).toBeNull();
      expect(response.data?.diff['pixelDiffPercent']).toBeGreaterThan(0);
      expect(response.data?.diff['significant']).toBe(true);
    });

    it('orders the pair chronologically whichever way round they are given', async () => {
      const [older, newer] = [snapshots[snapshots.length - 1]!, snapshots[0]!];

      const forwards = await handle.client.get<{ diff: { changedPixels: number } }>(
        '/api/v1/compare',
        { a: older.id, b: newer.id },
      );
      const backwards = await handle.client.get<{ diff: { changedPixels: number } }>(
        '/api/v1/compare',
        { a: newer.id, b: older.id },
      );

      expect(forwards.data?.diff['changedPixels']).toBe(backwards.data?.diff['changedPixels']);
    });

    it('stores the result when asked, and upserts rather than duplicating', async () => {
      const [older, newer] = [snapshots[snapshots.length - 1]!, snapshots[0]!];

      const first = await handle.client.get<{ stored: boolean; changeId: string | null }>(
        '/api/v1/compare',
        { a: older.id, b: newer.id, store: 'true' },
      );
      expect(first.data?.stored).toBe(true);
      expect(first.data?.changeId).toBeTruthy();

      const second = await handle.client.get<{ changeId: string | null }>('/api/v1/compare', {
        a: older.id,
        b: newer.id,
        store: 'true',
      });

      expect(second.data?.changeId).toBe(first.data?.changeId);
    });

    it('refuses snapshots from different monitors', async () => {
      const other = await handle.client.post<Monitor>('/api/v1/monitors', {
        name: 'Other monitor',
        url: `${fixtureUrlOf(handle)}/static`,
      });

      await handle.client.post(`/api/v1/monitors/${other.data!.id}/capture`);
      const otherSnapshots = await waitFor(
        async () =>
          (
            await handle.client.get<Page<Snapshot>>(
              `/api/v1/monitors/${other.data!.id}/snapshots`,
              { limit: 5 },
            )
          ).data?.data ?? [],
        (rows) => rows.length >= 1,
        { timeoutMs: 120_000, label: 'a snapshot for the other monitor' },
      );

      const cross = await handle.client.get<{ error: { message: string } }>('/api/v1/compare', {
        a: snapshots[0]!.id,
        b: otherSnapshots[0]!.id,
      });
      expect(cross.status).toBe(400);
      expect(cross.data?.error.message).toContain('same monitor');
    }, 180_000);

    it('reports a size change when the two captures differ in dimensions', async () => {
      const fixture = fixtureOf(handle);
      fixture.setState({ bodyHeight: 600 });

      const tall = await handle.client.post<Monitor>('/api/v1/monitors', {
        name: 'Tall page',
        url: `${fixtureUrlOf(handle)}/static`,
        changeThreshold: 0.05,
      });

      await handle.client.post(`/api/v1/monitors/${tall.data!.id}/capture`);
      const tallSnapshots = await waitFor(
        async () =>
          (
            await handle.client.get<Page<Snapshot>>(`/api/v1/monitors/${tall.data!.id}/snapshots`, {
              limit: 5,
            })
          ).data?.data ?? [],
        (rows) => rows.length >= 1,
        { timeoutMs: 120_000, label: 'the tall snapshot' },
      );

      fixture.setState({ bodyHeight: 0 });
      await handle.client.post(`/api/v1/monitors/${tall.data!.id}/capture`);
      const shortSnapshots = await waitFor(
        async () =>
          (
            await handle.client.get<Page<Snapshot>>(`/api/v1/monitors/${tall.data!.id}/snapshots`, {
              limit: 5,
            })
          ).data?.data ?? [],
        (rows) => rows.length >= 2,
        { timeoutMs: 120_000, label: 'the short snapshot' },
      );

      const tallSnapshot = tallSnapshots[0]!;
      const shortSnapshot = shortSnapshots[0]!;
      expect(tallSnapshot.screenshotHeight).not.toBe(shortSnapshot.screenshotHeight);

      const response = await handle.client.get<{
        diff: { sizeChanged: boolean; sizeFrom: unknown; sizeTo: unknown };
      }>('/api/v1/compare', { a: tallSnapshot.id, b: shortSnapshot.id });

      expect(response.data?.diff.sizeChanged).toBe(true);
      expect(response.data?.diff.sizeFrom).toBeTruthy();
      expect(response.data?.diff.sizeTo).toBeTruthy();

      const changes = await handle.client.get<Page<Change>>(
        `/api/v1/monitors/${tall.data!.id}/changes`,
        { limit: 5 },
      );
      const recorded = changes.data?.data.find((row) => row.sizeChanged);
      expect(recorded?.summary).toContain('page size changed');
    }, 240_000);
  });

  describe('snapshot artefact endpoints', () => {
    it('serves the screenshot as an immutable PNG', async () => {
      const response = await handle.client.buffer(
        `/api/v1/snapshots/${snapshots[0]!.id}/screenshot`,
      );
      expect(response.status).toBe(200);
      expect(response.contentType).toContain('image/png');
      expect(response.body.subarray(1, 4).toString()).toBe('PNG');
    });

    it('caches artefacts hard, because they never change once written', async () => {
      const raw = await fetch(`${handle.baseUrl}/api/v1/snapshots/${snapshots[0]!.id}/screenshot`, {
        headers: {
          cookie: `pagefreeze_session=${handle.client['cookies'].get('pagefreeze_session')}`,
        },
      });
      expect(raw.headers.get('cache-control')).toContain('immutable');
    });

    it('serves stored HTML as text/plain with a locked-down CSP', async () => {
      const raw = await fetch(`${handle.baseUrl}/api/v1/snapshots/${snapshots[0]!.id}/html`, {
        headers: {
          cookie: `pagefreeze_session=${handle.client['cookies'].get('pagefreeze_session')}`,
        },
      });
      expect(raw.status).toBe(200);
      expect(raw.headers.get('content-type')).toContain('text/plain');
      expect(raw.headers.get('content-security-policy')).toContain("default-src 'none'");
      expect(raw.headers.get('content-security-policy')).toContain('sandbox');
      expect(raw.headers.get('x-content-type-options')).toBe('nosniff');
    });

    it('serves the extracted text', async () => {
      const response = await handle.client.buffer(`/api/v1/snapshots/${snapshots[0]!.id}/text`);
      expect(response.status).toBe(200);
      expect(response.body.toString('utf8')).toContain('$59');
    });

    it('requires authentication for every artefact', async () => {
      for (const path of ['screenshot', 'html', 'text']) {
        const response = await fetch(
          `${handle.baseUrl}/api/v1/snapshots/${snapshots[0]!.id}/${path}`,
        );
        expect(response.status, path).toBe(401);
      }
    });
  });
});
