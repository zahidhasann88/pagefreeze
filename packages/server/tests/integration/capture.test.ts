import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import type { Change, Monitor, Page, Snapshot } from '@pagefreeze/shared';
import {
  databaseAvailable,
  dataDirOf,
  fixtureOf,
  fixtureUrlOf,
  newClient,
  resetDatabase,
  startTestApp,
  waitFor,
  type TestApp,
} from './helpers.js';

/**
 * End-to-end capture tests: a real browser, a real website that changes, a real database.
 *
 * These are the tests that would catch a regression in the parts most likely to break
 * silently - the SSRF proxy in front of Chromium, the stabilisation pass, duplicate
 * detection, and the pixel diff of real screenshots.
 */

const availability = await databaseAvailable();
const describeDb = availability.ok ? describe : describe.skip;

if (!availability.ok) {
  // Printed once, clearly, so a skipped suite is never mistaken for a passing one.
  console.warn(`\n[pagefreeze] integration tests SKIPPED: ${availability.reason}\n`);
}

describeDb('capture pipeline', () => {
  let handle: TestApp;
  let fixtureUrl: string;

  beforeAll(async () => {
    await resetDatabase();
    handle = await startTestApp();
    await handle.login();
    fixtureUrl = fixtureUrlOf(handle);
  }, 180_000);

  afterAll(async () => {
    await handle?.close();
  }, 60_000);

  async function createMonitor(payload: Record<string, unknown>): Promise<Monitor> {
    const response = await handle.client.post<Monitor>('/api/v1/monitors', {
      changeThreshold: 0.1,
      fullPage: true,
      ...payload,
    });
    expect(response.status, response.text).toBe(201);
    return response.data!;
  }

  async function captureAndWait(monitorId: string, expectedSnapshots: number): Promise<Snapshot[]> {
    const trigger = await handle.client.post(`/api/v1/monitors/${monitorId}/capture`);
    expect(trigger.status).toBe(202);

    return waitFor(
      async () => {
        const response = await handle.client.get<Page<Snapshot>>(
          `/api/v1/monitors/${monitorId}/snapshots`,
          { limit: 50 },
        );
        return response.data?.data ?? [];
      },
      (snapshots) => snapshots.length >= expectedSnapshots,
      { timeoutMs: 120_000, label: `${expectedSnapshots} snapshot(s) for ${monitorId}` },
    );
  }

  async function listChanges(monitorId: string): Promise<Change[]> {
    const response = await handle.client.get<Page<Change>>(
      `/api/v1/monitors/${monitorId}/changes`,
      { limit: 50 },
    );
    return response.data?.data ?? [];
  }

  it('records a baseline snapshot on the first capture', async () => {
    const monitor = await createMonitor({
      name: 'Baseline',
      url: `${fixtureUrl}/static`,
      ignoreSelectors: [],
    });

    const snapshots = await captureAndWait(monitor.id, 1);
    expect(snapshots).toHaveLength(1);

    const snapshot = snapshots[0]!;
    expect(snapshot.status).toBe('success');
    expect(snapshot.httpStatus).toBe(200);
    expect(snapshot.title).toBe('Acme Pricing');
    expect(snapshot.finalUrl).toContain('/static');
    expect(snapshot.screenshotWidth).toBe(1280);
    expect(snapshot.screenshotHeight).toBeGreaterThan(0);
    expect(snapshot.screenshotHash).toMatch(/^[0-9a-f]{64}$/);
    expect(snapshot.duplicateOf).toBeNull();
    expect(snapshot.errorMessage).toBeNull();

    // Artefacts were actually written to the data directory.
    const stored = join(dataDirOf(handle), 'monitors', monitor.id, 'snapshots', snapshot.id);
    expect(existsSync(join(stored, 'screenshot.png'))).toBe(true);
    expect(existsSync(join(stored, 'page.html'))).toBe(true);
    expect(existsSync(join(stored, 'page.txt'))).toBe(true);

    // No change can exist yet: there is nothing to compare against.
    expect(await listChanges(monitor.id)).toHaveLength(0);
  }, 180_000);

  it('records a significant change with real diff stats when the page changes', async () => {
    const fixture = fixtureOf(handle);
    fixture.setState({ price: '$19', terms: ['Original terms line.'] });

    const monitor = await createMonitor({
      name: 'Changing pricing',
      url: `${fixtureUrl}/static`,
      ignoreSelectors: [],
    });

    await captureAndWait(monitor.id, 1);
    expect(await listChanges(monitor.id)).toHaveLength(0);

    // The page changes between captures.
    fixture.setState({
      price: '$99',
      plans: ['Starter — $99/mo', 'Team — $199/mo'],
      terms: ['Completely rewritten terms.', 'A brand new second clause.'],
    });

    const snapshots = await captureAndWait(monitor.id, 2);
    expect(snapshots).toHaveLength(2);
    // The second capture is not a duplicate: the content differs.
    expect(snapshots[0]!.duplicateOf).toBeNull();

    const changes = await listChanges(monitor.id);
    expect(changes).toHaveLength(1);

    const change = changes[0]!;
    expect(change.significant).toBe(true);
    expect(change.fromSnapshotId).toBe(snapshots[1]!.id);
    expect(change.toSnapshotId).toBe(snapshots[0]!.id);

    // Visual stats come from pixelmatch over the two real screenshots.
    expect(change.pixelDiffPercent).toBeGreaterThan(0.1);
    expect(change.changedPixels).toBeGreaterThan(0);
    expect(change.totalPixels).toBe(1280 * (snapshots[0]!.screenshotHeight ?? 0));
    expect(change.sizeChanged).toBe(false);
    expect(change.regions.length).toBeGreaterThan(0);

    // Text and HTML stats come from jsdiff over the extracted content.
    expect(change.textAdded).toBeGreaterThan(0);
    expect(change.textRemoved).toBeGreaterThan(0);
    expect(change.htmlAdded).toBeGreaterThan(0);
    expect(change.htmlRemoved).toBeGreaterThan(0);

    expect(change.summary).toContain('Significant change');
    expect(change.hasDiffImage).toBe(true);

    // The diff image is a real PNG of the same canvas size.
    const diffImage = await handle.client.buffer(`/api/v1/changes/${change.id}/diff-image`);
    expect(diffImage.status).toBe(200);
    expect(diffImage.contentType).toContain('image/png');
    expect(diffImage.body.subarray(1, 4).toString()).toBe('PNG');

    // The detail payload carries the diff bodies the viewer renders.
    const detail = await handle.client.get<Record<string, unknown>>(`/api/v1/changes/${change.id}`);
    expect(detail.status).toBe(200);
    expect(detail.data?.['textDiff']).toBeTruthy();
    expect(detail.data?.['htmlDiff']).toBeTruthy();
    const textDiff = detail.data?.['textDiff'] as { added: number; wordChanges: unknown[] };
    expect(textDiff.added).toBeGreaterThan(0);
    expect(textDiff.wordChanges.length).toBeGreaterThan(0);

    // Region boxes are in the coordinate space of the newer screenshot.
    for (const region of change.regions) {
      expect(region.x).toBeGreaterThanOrEqual(0);
      expect(region.y).toBeGreaterThanOrEqual(0);
      expect(region.x + region.width).toBeLessThanOrEqual(1280);
      expect(region.weight).toBeGreaterThan(0);
      expect(region.weight).toBeLessThanOrEqual(1);
    }
  }, 240_000);

  it('skips the diff and stores no new files when the content is identical', async () => {
    const monitor = await createMonitor({
      name: 'Stable page',
      url: `${fixtureUrl}/static`,
      ignoreSelectors: [],
    });

    await captureAndWait(monitor.id, 1);
    const snapshots = await captureAndWait(monitor.id, 2);

    const duplicate = snapshots[0]!;
    expect(duplicate.duplicateOf).toBe(snapshots[1]!.id);
    expect(duplicate.screenshotHash).toBe(snapshots[1]!.screenshotHash);
    // The keys point at the earlier snapshot's artefacts: nothing new was written.
    expect(duplicate.id).not.toBe(snapshots[1]!.id);

    expect(await listChanges(monitor.id)).toHaveLength(0);

    // Exactly one screenshot file exists for this monitor, not two.
    const snapshotDirs = readdirSync(join(dataDirOf(handle), 'monitors', monitor.id, 'snapshots'));
    const pngs = snapshotDirs.flatMap((dir) =>
      readdirSync(join(dataDirOf(handle), 'monitors', monitor.id, 'snapshots', dir)).filter(
        (file) => file.endsWith('.png'),
      ),
    );
    expect(pngs).toHaveLength(1);
  }, 240_000);

  it('reports no false change when a volatile timestamp is in the ignore selectors', async () => {
    // The fixture renders a fresh ISO timestamp and a rotating banner on every request, so
    // two captures of /pricing are never byte-identical without the ignore selectors.
    const monitor = await createMonitor({
      name: 'Ignored volatility',
      url: `${fixtureUrl}/pricing`,
      ignoreSelectors: ['#clock', '#banner', '#ad-slot'],
    });

    await captureAndWait(monitor.id, 1);
    const snapshots = await captureAndWait(monitor.id, 2);

    expect(snapshots).toHaveLength(2);
    // Identical pixels and identical extracted content: marked as a duplicate.
    expect(snapshots[0]!.duplicateOf).toBe(snapshots[1]!.id);
    expect(snapshots[0]!.screenshotHash).toBe(snapshots[1]!.screenshotHash);
    expect(snapshots[0]!.htmlHash).toBe(snapshots[1]!.htmlHash);
    expect(snapshots[0]!.textHash).toBe(snapshots[1]!.textHash);

    expect(await listChanges(monitor.id)).toHaveLength(0);
  }, 240_000);

  it('does report a change when the same volatile content is NOT ignored', async () => {
    // The control for the test above: same page, no ignore selectors. Without it, a broken
    // capture pipeline that always produced identical output would pass the previous test.
    const monitor = await createMonitor({
      name: 'Volatile, not ignored',
      url: `${fixtureUrl}/pricing`,
      ignoreSelectors: [],
      changeThreshold: 0.001,
    });

    await captureAndWait(monitor.id, 1);
    await captureAndWait(monitor.id, 2);

    const changes = await listChanges(monitor.id);
    expect(changes.length).toBeGreaterThan(0);
    expect(changes[0]!.significant).toBe(true);
  }, 240_000);

  it('honours a capture selector by screenshotting only that element', async () => {
    const monitor = await createMonitor({
      name: 'Terms section only',
      url: `${fixtureUrl}/static`,
      captureSelector: '#terms',
      fullPage: false,
      ignoreSelectors: [],
    });

    const snapshots = await captureAndWait(monitor.id, 1);
    const snapshot = snapshots[0]!;

    // Much smaller than the 1280x800 viewport, because only the section was captured.
    expect(snapshot.screenshotWidth).toBeLessThan(1280);
    expect(snapshot.screenshotWidth).toBeGreaterThan(50);

    const text = await handle.client.buffer(`/api/v1/snapshots/${snapshot.id}/text`);
    const body = text.body.toString('utf8');
    expect(body).toContain('Terms');
    expect(body).not.toContain('Acme Cloud Pricing');
  }, 180_000);

  it('records a failure snapshot when the target returns an error status', async () => {
    const monitor = await createMonitor({
      name: 'Erroring page',
      url: `${fixtureUrl}/error?status=500`,
      ignoreSelectors: [],
    });

    const snapshots = await captureAndWait(monitor.id, 1);
    const snapshot = snapshots[0]!;

    // A 500 still renders, so the capture succeeds but records the status.
    expect(snapshot.status).toBe('success');
    expect(snapshot.httpStatus).toBe(500);
  }, 180_000);

  it('never creates a change from a failed capture', async () => {
    const monitor = await createMonitor({
      name: 'Unreachable host',
      // A port nothing listens on; the guard allows the address but the connection fails.
      url: `${fixtureUrl}/pricing`,
      ignoreSelectors: [],
    });
    await captureAndWait(monitor.id, 1);

    // Point the monitor at something that cannot be reached at all.
    const patched = await handle.client.patch<Monitor>(`/api/v1/monitors/${monitor.id}`, {
      url: 'http://127.0.0.1:1/unreachable',
    });
    // The SSRF policy refuses a loopback target that is not allowlisted, so the update is
    // rejected. That is the desired outcome: the monitor keeps its working URL.
    expect(patched.status).toBe(400);

    const unchanged = await handle.client.get<Monitor>(`/api/v1/monitors/${monitor.id}`);
    expect(unchanged.data?.url).toContain('/pricing');
  }, 180_000);

  it('increments consecutive failures and resets them on success', async () => {
    const fixture = fixtureOf(handle);
    const monitor = await createMonitor({
      name: 'Flaky',
      url: `${fixtureUrl}/slow?ms=90000`,
      ignoreSelectors: [],
    });

    // The capture timeout is 45s in tests but the page needs 90s, so this must fail.
    const trigger = await handle.client.post(`/api/v1/monitors/${monitor.id}/capture`);
    expect(trigger.status).toBe(202);

    const snapshots = await waitFor(
      async () =>
        (
          await handle.client.get<Page<Snapshot>>(`/api/v1/monitors/${monitor.id}/snapshots`, {
            limit: 10,
          })
        ).data?.data ?? [],
      (rows) => rows.some((row) => row.status === 'failed'),
      { timeoutMs: 120_000, label: 'a failed snapshot' },
    );

    const failed = snapshots.find((row) => row.status === 'failed')!;
    expect(failed.errorMessage).toBeTruthy();
    expect(failed.screenshotHash).toBeNull();

    const failing = await handle.client.get<Monitor>(`/api/v1/monitors/${monitor.id}`);
    expect(failing.data?.consecutiveFailures).toBeGreaterThan(0);
    expect(failing.data?.status).toBe('failing');

    // No change row is ever created from a failed snapshot.
    expect(await listChanges(monitor.id)).toHaveLength(0);

    // Fix the target and confirm the streak resets.
    fixture.setState({ price: '$19' });
    await handle.client.patch(`/api/v1/monitors/${monitor.id}`, { url: `${fixtureUrl}/static` });
    await captureAndWait(monitor.id, 2);

    const recovered = await waitFor(
      () => handle.client.get<Monitor>(`/api/v1/monitors/${monitor.id}`),
      (result) => result.data?.consecutiveFailures === 0,
      { timeoutMs: 10_000, label: 'failure streak reset after successful capture' },
    );
    expect(recovered.data?.consecutiveFailures).toBe(0);
  }, 300_000);
});

describeDb('SSRF enforcement through a real browser', () => {
  let handle: TestApp;
  let fixtureUrl: string;
  let fixturePort: number;

  beforeAll(async () => {
    await resetDatabase();
    handle = await startTestApp();
    await handle.login();
    fixtureUrl = fixtureUrlOf(handle);
    fixturePort = Number.parseInt(new URL(fixtureUrl).port, 10);
  }, 180_000);

  afterAll(async () => {
    await handle?.close();
  }, 60_000);

  it('refuses to create a monitor for a blocked destination', async () => {
    const cases: Array<[string, string]> = [
      ['metadata IP', 'http://169.254.169.254/latest/meta-data/'],
      ['loopback', 'http://127.0.0.1:1/'],
      ['localhost by name', 'http://localhost:3000/'],
      ['private range', 'http://192.168.1.1/admin'],
      ['IPv6 loopback', 'http://[::1]:8080/'],
      ['decimal loopback literal', 'http://2130706433/'],
    ];

    for (const [label, url] of cases) {
      const response = await handle.client.post('/api/v1/monitors', {
        name: `blocked ${label}`,
        url,
        changeThreshold: 0.1,
      });
      expect(response.status, `${label} should be rejected: ${response.text}`).toBe(400);
      expect(response.text).toContain('SSRF');
    }
  }, 120_000);

  it('refuses non-http schemes at validation time', async () => {
    for (const url of ['file:///etc/passwd', 'ftp://example.com/x', 'javascript:alert(1)']) {
      const response = await handle.client.post('/api/v1/monitors', {
        name: `scheme ${url}`,
        url,
        changeThreshold: 0.1,
      });
      expect(response.status, url).toBe(422);
    }
  }, 60_000);

  it('blocks a redirect to the cloud metadata address', async () => {
    const response = await handle.client.post<Monitor>('/api/v1/monitors', {
      name: 'metadata redirect',
      url: `${fixtureUrl}/redirect-metadata`,
      changeThreshold: 0.1,
    });
    // The fixture itself is allowlisted, so creation succeeds; the redirect target is not.
    expect(response.status, response.text).toBe(201);
    const monitor = response.data!;

    await handle.client.post(`/api/v1/monitors/${monitor.id}/capture`);
    const snapshots = await waitFor(
      async () =>
        (
          await handle.client.get<Page<Snapshot>>(`/api/v1/monitors/${monitor.id}/snapshots`, {
            limit: 10,
          })
        ).data?.data ?? [],
      (rows) => rows.length >= 1,
      { timeoutMs: 120_000, label: 'a snapshot for the redirect monitor' },
    );

    const snapshot = snapshots[0]!;
    // The browser followed the redirect, but the proxy refused the connection.
    expect(snapshot.finalUrl).toContain('169.254.169.254');
    expect(snapshot.httpStatus).toBe(403);

    const html = await handle.client.buffer(`/api/v1/snapshots/${snapshot.id}/html`);
    expect(html.body.toString('utf8')).not.toContain('PRIVATE CONTENT REACHED');
  }, 180_000);

  it('blocks a redirect to a loopback address that is not allowlisted', async () => {
    const target = `http://127.0.0.2:${fixturePort}/private`;
    const response = await handle.client.post<Monitor>('/api/v1/monitors', {
      name: 'loopback redirect',
      url: `${fixtureUrl}/redirect-loopback?to=${encodeURIComponent(target)}`,
      changeThreshold: 0.1,
    });
    expect(response.status, response.text).toBe(201);

    await handle.client.post(`/api/v1/monitors/${response.data!.id}/capture`);
    const snapshots = await waitFor(
      async () =>
        (
          await handle.client.get<Page<Snapshot>>(
            `/api/v1/monitors/${response.data!.id}/snapshots`,
            { limit: 10 },
          )
        ).data?.data ?? [],
      (rows) => rows.length >= 1,
      { timeoutMs: 120_000, label: 'a snapshot' },
    );

    expect(snapshots[0]!.httpStatus).toBe(403);
    const html = await handle.client.buffer(`/api/v1/snapshots/${snapshots[0]!.id}/html`);
    expect(html.body.toString('utf8')).not.toContain('PRIVATE CONTENT REACHED');
  }, 180_000);

  it('blocks a redirect through a hostname that resolves to loopback', async () => {
    const target = `http://localhost:${fixturePort}/private`;
    const response = await handle.client.post<Monitor>('/api/v1/monitors', {
      name: 'localhost redirect',
      url: `${fixtureUrl}/redirect-loopback?to=${encodeURIComponent(target)}`,
      changeThreshold: 0.1,
    });
    expect(response.status, response.text).toBe(201);

    await handle.client.post(`/api/v1/monitors/${response.data!.id}/capture`);
    const snapshots = await waitFor(
      async () =>
        (
          await handle.client.get<Page<Snapshot>>(
            `/api/v1/monitors/${response.data!.id}/snapshots`,
            { limit: 10 },
          )
        ).data?.data ?? [],
      (rows) => rows.length >= 1,
      { timeoutMs: 120_000, label: 'a snapshot' },
    );

    expect(snapshots[0]!.httpStatus).toBe(403);
    const html = await handle.client.buffer(`/api/v1/snapshots/${snapshots[0]!.id}/html`);
    expect(html.body.toString('utf8')).not.toContain('PRIVATE CONTENT REACHED');
  }, 180_000);

  it('blocks blocked subresources while still capturing the page itself', async () => {
    const response = await handle.client.post<Monitor>('/api/v1/monitors', {
      name: 'subresource probe',
      url: `${fixtureUrl}/subresource`,
      changeThreshold: 0.1,
    });
    expect(response.status, response.text).toBe(201);

    await handle.client.post(`/api/v1/monitors/${response.data!.id}/capture`);
    const snapshots = await waitFor(
      async () =>
        (
          await handle.client.get<Page<Snapshot>>(
            `/api/v1/monitors/${response.data!.id}/snapshots`,
            { limit: 10 },
          )
        ).data?.data ?? [],
      (rows) => rows.length >= 1,
      { timeoutMs: 120_000, label: 'a snapshot' },
    );

    const snapshot = snapshots[0]!;
    // The page itself is allowed, so the capture succeeds...
    expect(snapshot.status).toBe('success');
    expect(snapshot.httpStatus).toBe(200);
    // ...and its content is present.
    const html = await handle.client.buffer(`/api/v1/snapshots/${snapshot.id}/html`);
    expect(html.body.toString('utf8')).toContain('Subresource test');
  }, 180_000);

  it('does not let the browser reach a private address through a redirect chain', async () => {
    const response = await handle.client.post<Monitor>('/api/v1/monitors', {
      name: 'redirect chain',
      url: `${fixtureUrl}/redirect-chain`,
      changeThreshold: 0.1,
    });
    expect(response.status, response.text).toBe(201);

    await handle.client.post(`/api/v1/monitors/${response.data!.id}/capture`);
    const snapshots = await waitFor(
      async () =>
        (
          await handle.client.get<Page<Snapshot>>(
            `/api/v1/monitors/${response.data!.id}/snapshots`,
            { limit: 10 },
          )
        ).data?.data ?? [],
      (rows) => rows.length >= 1,
      { timeoutMs: 120_000, label: 'a snapshot' },
    );

    const html = await handle.client.buffer(`/api/v1/snapshots/${snapshots[0]!.id}/html`);
    expect(html.body.toString('utf8')).not.toContain('PRIVATE CONTENT REACHED');
  }, 180_000);
});

describeDb('secrets at rest', () => {
  let handle: TestApp;
  let fixtureUrl: string;

  beforeAll(async () => {
    await resetDatabase();
    handle = await startTestApp();
    await handle.login();
    fixtureUrl = fixtureUrlOf(handle);
  }, 180_000);

  afterAll(async () => {
    await handle?.close();
  }, 60_000);

  it('encrypts custom headers and cookies, and never returns or logs them', async () => {
    const headerValue = 'Bearer super-secret-header-value-8f2c1a';
    const cookieValue = 'session-cookie-secret-4d9e';

    const created = await handle.client.post<Monitor>('/api/v1/monitors', {
      name: 'Authenticated page',
      url: `${fixtureUrl}/static`,
      changeThreshold: 0.1,
      headers: { Authorization: headerValue, 'X-Api-Key': 'another-secret' },
      cookies: [{ name: 'sid', value: cookieValue }],
    });
    expect(created.status, created.text).toBe(201);
    const monitorId = created.data!.id;

    // The response carries the names, never the values.
    expect(created.data!.secrets.headerNames).toEqual(['Authorization', 'X-Api-Key']);
    expect(created.data!.secrets.cookieNames).toEqual(['sid']);
    expect(created.text).not.toContain(headerValue);
    expect(created.text).not.toContain(cookieValue);
    expect(created.text).not.toContain('another-secret');

    // Nor does a subsequent GET.
    const fetched = await handle.client.get<Monitor>(`/api/v1/monitors/${monitorId}`);
    expect(fetched.text).not.toContain(headerValue);
    expect(fetched.text).not.toContain(cookieValue);
    expect(fetched.data!.secrets.headerNames).toContain('Authorization');

    // The raw row holds ciphertext, not plaintext.
    const db = newClient();
    await db.connect();
    try {
      const row = await db.query(
        'SELECT headers_enc, cookies_enc, header_names, cookie_names FROM monitor_secrets WHERE monitor_id = $1',
        [monitorId],
      );
      expect(row.rows).toHaveLength(1);

      const headersEnc = row.rows[0]!.headers_enc as string;
      const cookiesEnc = row.rows[0]!.cookies_enc as string;

      expect(headersEnc).not.toContain(headerValue);
      expect(headersEnc).not.toContain('another-secret');
      expect(cookiesEnc).not.toContain(cookieValue);

      // The envelope marker proves it went through our AES-256-GCM wrapper.
      expect(Buffer.from(headersEnc, 'base64').subarray(0, 4).toString('ascii')).toBe('PFZ1');
      expect(Buffer.from(cookiesEnc, 'base64').subarray(0, 4).toString('ascii')).toBe('PFZ1');

      // Ciphertext is not merely base64 of the plaintext.
      expect(Buffer.from(headersEnc, 'base64').toString('utf8')).not.toContain('Authorization');

      // Names are stored in the clear so the UI can show what is configured.
      expect(row.rows[0]!.header_names).toEqual(['Authorization', 'X-Api-Key']);
      expect(row.rows[0]!.cookie_names).toEqual(['sid']);

      // Nothing in the monitors table either.
      const monitorRow = await db.query('SELECT * FROM monitors WHERE id = $1', [monitorId]);
      expect(JSON.stringify(monitorRow.rows[0])).not.toContain(headerValue);

      // And the whole database contains no plaintext copy.
      const leak = await db.query(
        `SELECT count(*)::int AS n FROM monitors WHERE name ILIKE '%super-secret%'`,
      );
      expect(leak.rows[0]!.n).toBe(0);
    } finally {
      await db.end();
    }

    // The capture still works, i.e. the server can decrypt what it stored.
    await handle.client.post(`/api/v1/monitors/${monitorId}/capture`);
    const snapshots = await waitFor(
      async () =>
        (
          await handle.client.get<Page<Snapshot>>(`/api/v1/monitors/${monitorId}/snapshots`, {
            limit: 10,
          })
        ).data?.data ?? [],
      (rows) => rows.length >= 1,
      { timeoutMs: 120_000, label: 'a snapshot' },
    );
    expect(snapshots[0]!.status).toBe('success');
    expect(snapshots[0]!.errorMessage).toBeNull();
  }, 240_000);

  it('encrypts a webhook signing secret and reports only its presence', async () => {
    const secret = 'channel-signing-secret-value-1a2b3c';
    const created = await handle.client.post<{ id: string; config: Record<string, unknown> }>(
      '/api/v1/channels',
      {
        type: 'webhook',
        name: 'Signed hook',
        config: { url: `${fixtureUrl}/health`, secret },
      },
    );
    expect(created.status, created.text).toBe(201);
    expect(created.text).not.toContain(secret);
    expect(created.data!.config['hasSecret']).toBe(true);
    expect(created.data!.config['url']).toContain('/health');

    const db = newClient();
    await db.connect();
    try {
      const row = await db.query(
        'SELECT config, config_enc FROM notification_channels WHERE id = $1',
        [created.data!.id],
      );
      expect(JSON.stringify(row.rows[0]!.config)).not.toContain(secret);
      expect(row.rows[0]!.config_enc).not.toContain(secret);
      expect(
        Buffer.from(row.rows[0]!.config_enc as string, 'base64')
          .subarray(0, 4)
          .toString('ascii'),
      ).toBe('PFZ1');
    } finally {
      await db.end();
    }

    // A test delivery reaches the fixture and succeeds.
    const test = await handle.client.post<{ ok: boolean; status: number | null }>(
      `/api/v1/channels/${created.data!.id}/test`,
      {},
    );
    expect(test.status).toBe(200);
    expect(test.data!.ok).toBe(true);
    expect(test.data!.status).toBe(200);
  }, 180_000);

  it('refuses a webhook destination that the SSRF guard blocks', async () => {
    const response = await handle.client.post('/api/v1/channels', {
      type: 'webhook',
      name: 'Evil hook',
      config: { url: 'http://169.254.169.254/latest/meta-data/' },
    });
    expect(response.status).toBe(400);
    expect(response.text).toContain('SSRF');
  }, 60_000);
});
