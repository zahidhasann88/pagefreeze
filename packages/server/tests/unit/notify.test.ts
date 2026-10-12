import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { describe, expect, it } from 'vitest';
import {
  REPLAY_TOLERANCE_SECONDS,
  SIGNATURE_HEADER,
  TIMESTAMP_HEADER,
  buildSignedHeaders,
  signPayload,
  verifySignature,
} from '../../src/notify/signing.js';
import { onFailure, onSuccess, simulateStreak } from '../../src/notify/failures.js';
import {
  buildSlackPayload,
  buildWebhookPayload,
  NotificationService,
  RecordingNotifier,
  type HttpClient,
  type ResolvedChannelConfig,
} from '../../src/notify/notifier.js';
import {
  buildChangeEvent,
  buildFailureEvent,
  buildRecoveryEvent,
  buildTestEvent,
  renderEventText,
} from '../../src/notify/events.js';
import { RecordingMailer } from '../../src/notify/mailer.js';
import { SsrfGuard, type Resolver } from '../../src/capture/ssrf.js';
import { backoffDelayMs, isRetryable } from '../../src/capture/runner.js';
import { FakeClock } from '../../src/util/clock.js';
import type { Change, Monitor } from '@pagefreeze/shared';

const SECRET = 'webhook-signing-secret';

describe('webhook signing', () => {
  it('signs timestamp and body together', () => {
    const signature = signPayload(SECRET, 1_700_000_000, '{"a":1}');
    expect(signature).toMatch(/^[0-9a-f]{64}$/);

    expect(signPayload(SECRET, 1_700_000_001, '{"a":1}')).not.toBe(signature);
    expect(signPayload(SECRET, 1_700_000_000, '{"a":2}')).not.toBe(signature);
    expect(signPayload('other-secret', 1_700_000_000, '{"a":1}')).not.toBe(signature);
  });

  it('builds the documented header set', () => {
    const headers = buildSignedHeaders({
      secret: SECRET,
      timestamp: 1_700_000_000,
      body: '{"a":1}',
      deliveryId: 'delivery-1',
      event: 'change.detected',
      userAgent: 'Pagefreeze/0.1.0',
    });

    expect(headers[SIGNATURE_HEADER]).toMatch(/^sha256=[0-9a-f]{64}$/);
    expect(headers[TIMESTAMP_HEADER]).toBe('1700000000');
    expect(headers['x-pagefreeze-delivery']).toBe('delivery-1');
    expect(headers['x-pagefreeze-event']).toBe('change.detected');
    expect(headers['content-type']).toBe('application/json');
    expect(headers['user-agent']).toBe('Pagefreeze/0.1.0');
  });

  it('omits the signature header when no secret is configured', () => {
    const headers = buildSignedHeaders({
      secret: null,
      timestamp: 1,
      body: '{}',
      deliveryId: 'd',
      event: 'change.detected',
      userAgent: 'ua',
    });
    expect(headers[SIGNATURE_HEADER]).toBeUndefined();

    expect(headers[TIMESTAMP_HEADER]).toBe('1');
  });

  it('verifies a signature it produced', () => {
    const timestamp = Math.floor(Date.now() / 1000);
    const body = '{"schema":"pagefreeze/v1"}';
    const result = verifySignature({
      secret: SECRET,
      timestamp,
      body,
      signatureHeader: `sha256=${signPayload(SECRET, timestamp, body)}`,
      nowSeconds: timestamp,
    });
    expect(result).toEqual({ ok: true });
  });

  it('rejects a wrong secret', () => {
    const timestamp = 1_700_000_000;
    const result = verifySignature({
      secret: SECRET,
      timestamp,
      body: '{}',
      signatureHeader: `sha256=${signPayload('a-different-secret', timestamp, '{}')}`,
      nowSeconds: timestamp,
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('signature-mismatch');
  });

  it('rejects a tampered body', () => {
    const timestamp = 1_700_000_000;
    const result = verifySignature({
      secret: SECRET,
      timestamp,
      body: '{"amount":999}',
      signatureHeader: `sha256=${signPayload(SECRET, timestamp, '{"amount":1}')}`,
      nowSeconds: timestamp,
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('signature-mismatch');
  });

  it('rejects a replayed delivery outside the tolerance window', () => {
    const timestamp = 1_700_000_000;
    const signature = `sha256=${signPayload(SECRET, timestamp, '{}')}`;

    expect(
      verifySignature({
        secret: SECRET,
        timestamp,
        body: '{}',
        signatureHeader: signature,
        nowSeconds: timestamp + REPLAY_TOLERANCE_SECONDS + 1,
      }).ok,
    ).toBe(false);

    expect(
      verifySignature({
        secret: SECRET,
        timestamp,
        body: '{}',
        signatureHeader: signature,
        nowSeconds: timestamp + REPLAY_TOLERANCE_SECONDS - 1,
      }).ok,
    ).toBe(true);
  });

  it('rejects a timestamp from the future beyond tolerance', () => {
    const now = 1_700_000_000;
    expect(
      verifySignature({
        secret: SECRET,
        timestamp: now + REPLAY_TOLERANCE_SECONDS + 60,
        body: '{}',
        signatureHeader: `sha256=${signPayload(SECRET, now + REPLAY_TOLERANCE_SECONDS + 60, '{}')}`,
        nowSeconds: now,
      }).reason,
    ).toBe('timestamp-out-of-tolerance');
  });

  it('rejects malformed signature headers', () => {
    const base = {
      secret: SECRET,
      timestamp: 1_700_000_000,
      body: '{}',
      nowSeconds: 1_700_000_000,
    };
    expect(verifySignature({ ...base, signatureHeader: '' }).reason).toBe('malformed-signature');
    expect(verifySignature({ ...base, signatureHeader: 'deadbeef' }).reason).toBe(
      'malformed-signature',
    );
    expect(verifySignature({ ...base, signatureHeader: 'md5=abc' }).reason).toBe(
      'unsupported-scheme',
    );
    expect(
      verifySignature({ ...base, signatureHeader: 'sha256=abc', timestamp: 'not-a-number' }).reason,
    ).toBe('invalid-timestamp');
  });

  it('rejects a digest of the wrong length without throwing', () => {
    expect(
      verifySignature({
        secret: SECRET,
        timestamp: 1_700_000_000,
        body: '{}',
        signatureHeader: 'sha256=tooshort',
        nowSeconds: 1_700_000_000,
      }).reason,
    ).toBe('signature-mismatch');
  });
});

describe('failure notification policy', () => {
  const policy = { threshold: 3 };
  const fresh = { consecutiveFailures: 0, failureNotified: false };

  it('stays quiet below the threshold', () => {
    expect(onFailure(fresh, policy)).toMatchObject({
      action: 'none',
      state: { consecutiveFailures: 1, failureNotified: false },
    });
    expect(onFailure({ consecutiveFailures: 1, failureNotified: false }, policy).action).toBe(
      'none',
    );
  });

  it('notifies exactly once when the streak reaches the threshold', () => {
    const third = onFailure({ consecutiveFailures: 2, failureNotified: false }, policy);
    expect(third).toMatchObject({
      action: 'notify-failure',
      state: { consecutiveFailures: 3, failureNotified: true },
    });
  });

  it('does not notify again while the streak keeps growing', () => {
    const fourth = onFailure({ consecutiveFailures: 3, failureNotified: true }, policy);
    expect(fourth).toMatchObject({
      action: 'none',
      state: { consecutiveFailures: 4, failureNotified: true },
    });

    const tenth = onFailure({ consecutiveFailures: 9, failureNotified: true }, policy);
    expect(tenth.action).toBe('none');
    expect(tenth.state.consecutiveFailures).toBe(10);
  });

  it('notifies recovery only after a streak that was announced', () => {
    expect(onSuccess({ consecutiveFailures: 5, failureNotified: true }, policy).action).toBe(
      'notify-recovery',
    );

    expect(onSuccess({ consecutiveFailures: 2, failureNotified: false }, policy).action).toBe(
      'none',
    );

    expect(onSuccess(fresh, policy).action).toBe('none');
  });

  it('resets the streak on success', () => {
    expect(onSuccess({ consecutiveFailures: 7, failureNotified: true }, policy).state).toEqual({
      consecutiveFailures: 0,
      failureNotified: false,
    });
  });

  it('replays a realistic sequence with exactly two notifications', () => {
    const events = simulateStreak(
      ['failure', 'failure', 'failure', 'failure', 'failure', 'success', 'failure', 'success'],
      policy,
    );
    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({ index: 2, action: 'notify-failure', streak: 3 });
    expect(events[1]).toMatchObject({ index: 5, action: 'notify-recovery' });
  });

  it('re-arms after a recovery, so a new streak notifies again', () => {
    const events = simulateStreak(
      [
        'failure',
        'failure',
        'failure', // notified at index 2
        'success', // recovery at index 3
        'failure',
        'failure',
        'failure', // notified again at index 6
      ],
      policy,
    );
    expect(events.map((event) => event.action)).toEqual([
      'notify-failure',
      'notify-recovery',
      'notify-failure',
    ]);
    expect(events[2]?.index).toBe(6);
  });

  it('honours a threshold of one', () => {
    const events = simulateStreak(['failure', 'failure', 'success'], { threshold: 1 });
    expect(events.map((event) => event.action)).toEqual(['notify-failure', 'notify-recovery']);
  });

  it('never notifies when nothing fails', () => {
    expect(simulateStreak(['success', 'success', 'success'], policy)).toEqual([]);
  });
});

describe('capture retry policy', () => {
  it('retries timeouts, navigation errors and unknown failures', () => {
    for (const kind of ['timeout', 'navigation', 'unknown'] as const) {
      expect(isRetryable({ ok: false, errorKind: kind } as never)).toBe(true);
    }
  });

  it('does not retry a blocked request', () => {
    expect(isRetryable({ ok: false, errorKind: 'blocked' } as never)).toBe(false);
  });

  it('does not retry a render failure', () => {
    expect(isRetryable({ ok: false, errorKind: 'render' } as never)).toBe(false);
  });

  it('does not retry a success', () => {
    expect(isRetryable({ ok: true } as never)).toBe(false);
  });

  it('treats a missing kind as retryable', () => {
    expect(isRetryable({ ok: false } as never)).toBe(true);
  });

  it('backs off exponentially from the configured base', () => {
    expect(backoffDelayMs(1000, 0)).toBe(1000);
    expect(backoffDelayMs(1000, 1)).toBe(2000);
    expect(backoffDelayMs(1000, 2)).toBe(4000);
    expect(backoffDelayMs(2000, 0)).toBe(2000);
    expect(backoffDelayMs(2000, 1)).toBe(4000);
  });

  it('caps the backoff at 30 seconds', () => {
    expect(backoffDelayMs(2000, 10)).toBe(30_000);
    expect(backoffDelayMs(1000, 20)).toBe(30_000);
  });
});

describe('notification payloads', () => {
  const monitor = {
    id: 'monitor-1',
    name: 'Acme pricing',
    url: 'https://example.com/pricing',
    tags: ['pricing'],
  } as unknown as Monitor;

  const change = {
    id: 'change-1',
    monitorId: 'monitor-1',
    fromSnapshotId: 'snapshot-1',
    toSnapshotId: 'snapshot-2',
    createdAt: '2026-01-02T03:04:05.000Z',
    pixelDiffPercent: 1.5,
    changedPixels: 1500,
    totalPixels: 100_000,
    sizeChanged: true,
    sizeFrom: { width: 100, height: 100 },
    sizeTo: { width: 100, height: 200 },
    textAdded: 3,
    textRemoved: 1,
    htmlAdded: 5,
    htmlRemoved: 2,
    significant: true,
    summary: 'Significant change: 1.50% of pixels changed',
    regions: [],
    hasDiffImage: true,
  } as Change;

  it('builds a change event carrying the monitor and the stats', () => {
    const event = buildChangeEvent(
      monitor,
      change,
      { change: 'https://pfz.local/monitors/m/changes/c', share: null },
      new Date('2026-01-02T03:04:05.000Z'),
    );

    expect(event.type).toBe('change.detected');
    expect(event.monitor?.name).toBe('Acme pricing');
    expect(event.change?.pixelDiffPercent).toBe(1.5);
    expect(event.change?.significant).toBe(true);
    expect(event.links.change).toContain('/changes/c');
    expect(event.occurredAt).toBe('2026-01-02T03:04:05.000Z');
  });

  it('builds failure and recovery events', () => {
    const failure = buildFailureEvent(monitor, 3, 'net::ERR_TIMED_OUT', new Date(0));
    expect(failure.type).toBe('capture.failed');
    expect(failure.failure?.consecutiveFailures).toBe(3);
    expect(failure.message).toContain('ERR_TIMED_OUT');

    const recovery = buildRecoveryEvent(monitor, 5, new Date(0));
    expect(recovery.type).toBe('capture.recovered');
    expect(recovery.message).toContain('5 consecutive failure');
  });

  it('builds a test event with a custom message', () => {
    expect(buildTestEvent('hello', new Date(0)).message).toBe('hello');
    expect(buildTestEvent(null, new Date(0)).message).toContain('Test notification');
  });

  it('renders human-readable text', () => {
    const event = buildChangeEvent(
      monitor,
      change,
      { change: 'https://pfz.local/c', share: 'https://pfz.local/s/abc' },
      new Date(0),
    );
    const text = renderEventText(event);

    expect(text).toContain('Page changed: Acme pricing');
    expect(text).toContain('URL: https://example.com/pricing');
    expect(text).toContain('Pixel diff: 1.50%');
    expect(text).toContain('Text: +3 / -1 lines');
    expect(text).toContain('HTML: +5 / -2 lines');
    expect(text).toContain('Details: https://pfz.local/c');
    expect(text).toContain('Share link: https://pfz.local/s/abc');
  });

  it('never puts secret material into an event', () => {
    const event = buildChangeEvent(monitor, change, { change: null, share: null }, new Date(0));
    const serialised = JSON.stringify(event);
    expect(serialised).not.toContain('Authorization');
    expect(serialised).not.toMatch(/cookie/i);
  });

  it('serialises a webhook payload with a schema version', () => {
    const event = buildTestEvent('hi', new Date(0));
    const payload = JSON.parse(buildWebhookPayload(event)) as { schema: string; event: unknown };
    expect(payload.schema).toBe('pagefreeze/v1');
    expect(payload.event).toEqual(event);
  });

  it('serialises a Slack payload with an attachment and a colour per severity', () => {
    const changeEvent = buildChangeEvent(
      monitor,
      change,
      { change: null, share: null },
      new Date(0),
    );
    const slackPayload = JSON.parse(buildSlackPayload(changeEvent)) as {
      text: string;
      attachments: Array<{ color: string; fields: Array<{ title: string; value: string }> }>;
    };

    expect(slackPayload.text).toContain('Page changed');
    expect(slackPayload.attachments).toHaveLength(1);
    expect(slackPayload.attachments[0]?.color).toBe('#e0a458');
    expect(slackPayload.attachments[0]?.fields.some((field) => field.title === 'Pixel diff')).toBe(
      true,
    );

    const failurePayload = JSON.parse(
      buildSlackPayload(buildFailureEvent(monitor, 3, 'boom', new Date(0))),
    ) as { attachments: Array<{ color: string }> };
    expect(failurePayload.attachments[0]?.color).toBe('#d1495b');
  });
});

describe('NotificationService', () => {
  function guardFor(host: string): SsrfGuard {
    const resolver: Resolver = {
      async lookup() {
        return [{ address: '127.0.0.1', family: 4 }];
      },
    };
    return new SsrfGuard({ resolver, allowedHosts: [host] });
  }

  function recordingHttp(): HttpClient & {
    calls: Array<{ url: string; body: string; headers: Record<string, string> }>;
  } {
    const calls: Array<{ url: string; body: string; headers: Record<string, string> }> = [];
    return {
      calls,
      async post(options) {
        calls.push({ url: options.url, body: options.body, headers: options.headers });
        return { status: 200, body: 'ok' };
      },
    };
  }

  it('delivers a signed webhook and the signature verifies', async () => {
    const http = recordingHttp();
    const service = new NotificationService({
      guard: guardFor('hooks.example.com'),
      http,
      mailer: null,
      userAgent: 'Pagefreeze/test',
      timeoutMs: 1000,
      maxRedirects: 0,
    });

    const config: ResolvedChannelConfig = {
      type: 'webhook',
      url: 'https://hooks.example.com/pagefreeze',
      secret: SECRET,
    };
    const event = buildTestEvent('hello', new Date(0));

    const result = await service.deliver({ id: 'c1', name: 'ops' }, config, event);
    expect(result.ok).toBe(true);
    expect(http.calls).toHaveLength(1);

    const call = http.calls[0]!;
    const verification = verifySignature({
      secret: SECRET,
      timestamp: call.headers[TIMESTAMP_HEADER]!,
      body: call.body,
      signatureHeader: call.headers[SIGNATURE_HEADER]!,
      nowSeconds: Number.parseInt(call.headers[TIMESTAMP_HEADER]!, 10),
      toleranceSeconds: 10 ** 9,
    });
    expect(verification.ok).toBe(true);
  });

  it('reports a non-2xx delivery as a failure', async () => {
    const service = new NotificationService({
      guard: guardFor('hooks.example.com'),
      http: {
        async post() {
          return { status: 500, body: 'boom' };
        },
      },
      mailer: null,
      userAgent: 'ua',
      timeoutMs: 1000,
      maxRedirects: 0,
    });

    const result = await service.deliver(
      { id: 'c1', name: 'ops' },
      { type: 'webhook', url: 'https://hooks.example.com/x' },
      buildTestEvent(null, new Date(0)),
    );
    expect(result.ok).toBe(false);
    expect(result.status).toBe(500);
    expect(result.error).toContain('500');
  });

  it('refuses a destination blocked by the SSRF guard', async () => {
    const http = recordingHttp();
    const service = new NotificationService({
      guard: new SsrfGuard({
        resolver: {
          async lookup() {
            return [{ address: '169.254.169.254', family: 4 }];
          },
        },
      }),
      http,
      mailer: null,
      userAgent: 'ua',
      timeoutMs: 1000,
      maxRedirects: 0,
    });

    const result = await service.deliver(
      { id: 'c1', name: 'evil' },
      { type: 'webhook', url: 'https://metadata.attacker.example/latest' },
      buildTestEvent(null, new Date(0)),
    );

    expect(result.ok).toBe(false);
    expect(result.error).toContain('SSRF');

    expect(http.calls).toHaveLength(0);
  });

  it('sends a Slack payload to a slack channel', async () => {
    const http = recordingHttp();
    const service = new NotificationService({
      guard: guardFor('hooks.slack.example'),
      http,
      mailer: null,
      userAgent: 'ua',
      timeoutMs: 1000,
      maxRedirects: 0,
    });

    await service.deliver(
      { id: 'c1', name: 'slack' },
      { type: 'slack', url: 'https://hooks.slack.example/services/T/B/X' },
      buildTestEvent('hi', new Date(0)),
    );

    const body = JSON.parse(http.calls[0]!.body) as { attachments: unknown[] };
    expect(body.attachments).toHaveLength(1);
  });

  it('sends email through the injected mailer', async () => {
    const mailer = new RecordingMailer();
    const service = new NotificationService({
      guard: guardFor('x'),
      http: recordingHttp(),
      mailer,
      userAgent: 'ua',
      timeoutMs: 1000,
      maxRedirects: 0,
    });

    const result = await service.deliver(
      { id: 'c1', name: 'mail' },
      { type: 'email', to: ['ops@example.com', 'legal@example.com'] },
      buildTestEvent('hello', new Date(0)),
    );

    expect(result.ok).toBe(true);
    expect(mailer.sent).toHaveLength(1);
    expect(mailer.sent[0]?.to).toEqual(['ops@example.com', 'legal@example.com']);
    expect(mailer.sent[0]?.subject).toContain('Pagefreeze');
  });

  it('fails an email channel clearly when SMTP is not configured', async () => {
    const service = new NotificationService({
      guard: guardFor('x'),
      http: recordingHttp(),
      mailer: null,
      userAgent: 'ua',
      timeoutMs: 1000,
      maxRedirects: 0,
    });

    const result = await service.deliver(
      { id: 'c1', name: 'mail' },
      { type: 'email', to: ['ops@example.com'] },
      buildTestEvent(null, new Date(0)),
    );
    expect(result.ok).toBe(false);
    expect(result.error).toContain('SMTP');
  });

  it('fails an email channel with no recipients', async () => {
    const service = new NotificationService({
      guard: guardFor('x'),
      http: recordingHttp(),
      mailer: new RecordingMailer(),
      userAgent: 'ua',
      timeoutMs: 1000,
      maxRedirects: 0,
    });
    const result = await service.deliver(
      { id: 'c1', name: 'mail' },
      { type: 'email', to: [] },
      buildTestEvent(null, new Date(0)),
    );
    expect(result.ok).toBe(false);
    expect(result.error).toContain('recipients');
  });

  it('fails a webhook channel with no url', async () => {
    const service = new NotificationService({
      guard: guardFor('x'),
      http: recordingHttp(),
      mailer: null,
      userAgent: 'ua',
      timeoutMs: 1000,
      maxRedirects: 0,
    });
    const result = await service.deliver(
      { id: 'c1', name: 'hook' },
      { type: 'webhook' },
      buildTestEvent(null, new Date(0)),
    );
    expect(result.ok).toBe(false);
    expect(result.error).toContain('no url');
  });

  it('surfaces a transport exception as a failed delivery rather than throwing', async () => {
    const service = new NotificationService({
      guard: guardFor('hooks.example.com'),
      http: {
        async post() {
          throw new Error('socket hang up');
        },
      },
      mailer: null,
      userAgent: 'ua',
      timeoutMs: 1000,
      maxRedirects: 0,
    });

    const result = await service.deliver(
      { id: 'c1', name: 'ops' },
      { type: 'webhook', url: 'https://hooks.example.com/x' },
      buildTestEvent(null, new Date(0)),
    );
    expect(result.ok).toBe(false);
    expect(result.error).toContain('socket hang up');
  });

  it('RecordingNotifier records instead of sending', async () => {
    const notifier = new RecordingNotifier();
    await notifier.deliver(
      { id: 'c1', name: 'x' },
      { type: 'webhook', url: 'https://example.com' },
      buildTestEvent(null, new Date(0)),
    );
    expect(notifier.deliveries).toHaveLength(1);
    expect(notifier.deliveries[0]?.channelId).toBe('c1');
  });
});

describe('FetchHttpClient against a real local server', () => {
  it('posts and returns the status', async () => {
    const received: { body: string | null; signature: string | null } = {
      body: null,
      signature: null,
    };
    const server: Server = createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on('data', (chunk: Buffer) => chunks.push(chunk));
      request.on('end', () => {
        received.body = Buffer.concat(chunks).toString('utf8');
        received.signature = (request.headers[SIGNATURE_HEADER] as string | undefined) ?? null;
        response.writeHead(204);
        response.end();
      });
    });

    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;

    try {
      const { FetchHttpClient } = await import('../../src/notify/httpClient.js');
      const client = new FetchHttpClient(new SsrfGuard({ allowPrivateTargets: true }));
      const body = JSON.stringify({ hello: 'world' });

      const result = await client.post({
        url: `http://127.0.0.1:${port}/hook`,
        headers: {
          'content-type': 'application/json',
          [SIGNATURE_HEADER]: `sha256=${signPayload(SECRET, 1, body)}`,
        },
        body,
        timeoutMs: 5000,
        redirect: 'error',
      });

      expect(result.status).toBe(204);
      expect(received.body).toBe(body);
      expect(received.signature).toMatch(/^sha256=/);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('times out against a server that never answers', async () => {
    const server = createServer(() => {
      // Never respond.
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;

    try {
      const { FetchHttpClient } = await import('../../src/notify/httpClient.js');
      const client = new FetchHttpClient(new SsrfGuard({ allowPrivateTargets: true }));
      await expect(
        client.post({
          url: `http://127.0.0.1:${port}/`,
          headers: {},
          body: '{}',
          timeoutMs: 200,
          redirect: 'error',
        }),
      ).rejects.toThrow();
    } finally {
      server.closeAllConnections?.();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});

describe('FakeClock', () => {
  it('advances when slept and records the request', async () => {
    const clock = new FakeClock('2026-01-01T00:00:00Z');
    expect(clock.now().toISOString()).toBe('2026-01-01T00:00:00.000Z');

    await clock.sleep(5000);
    expect(clock.sleeps).toEqual([5000]);
    expect(clock.now().toISOString()).toBe('2026-01-01T00:00:05.000Z');

    clock.advance(60_000);
    expect(clock.timestamp()).toBe(new Date('2026-01-01T00:01:05Z').getTime());

    clock.set('2026-06-01T00:00:00Z');
    expect(clock.now().getUTCMonth()).toBe(5);
  });
});
