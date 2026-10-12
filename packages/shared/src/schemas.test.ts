import { describe, expect, it } from 'vitest';
import {
  channelCreateSchema,
  compareQuerySchema,
  describeSchedule,
  emailSchema,
  httpUrlSchema,
  loginSchema,
  monitorCreateSchema,
  monitorUpdateSchema,
  paginationSchema,
  shareCreateSchema,
  validateSchedule,
} from './schemas.js';

const validMonitor = {
  name: 'Example pricing',
  url: 'https://example.com/pricing',
};

describe('httpUrlSchema', () => {
  it('accepts http and https', () => {
    expect(httpUrlSchema.parse('https://example.com')).toBe('https://example.com');
    expect(httpUrlSchema.parse('http://example.com:8080/a?b=c')).toBe(
      'http://example.com:8080/a?b=c',
    );
  });

  it('rejects other schemes and relative urls', () => {
    for (const bad of [
      'file:///etc/passwd',
      'ftp://example.com',
      'javascript:alert(1)',
      'data:text/html,hi',
      'chrome://settings',
      'example.com',
      '',
    ]) {
      expect(httpUrlSchema.safeParse(bad).success).toBe(false);
    }
  });
});

describe('loginSchema', () => {
  it('requires a username and password', () => {
    expect(loginSchema.safeParse({ username: 'admin', password: 'x' }).success).toBe(true);
    expect(loginSchema.safeParse({ username: 'admin' }).success).toBe(false);
    expect(loginSchema.safeParse({}).success).toBe(false);
  });
});

describe('paginationSchema', () => {
  it('applies defaults and coerces query strings', () => {
    expect(paginationSchema.parse({})).toEqual({ limit: 20 });
    expect(paginationSchema.parse({ limit: '5' })).toEqual({ limit: 5 });
    expect(paginationSchema.safeParse({ limit: '5000' }).success).toBe(false);
  });
});

describe('monitorCreateSchema', () => {
  it('applies sensible defaults', () => {
    const parsed = monitorCreateSchema(0).parse(validMonitor);
    expect(parsed.name).toBe('Example pricing');
    expect(parsed.enabled).toBe(true);
    expect(parsed.scheduleKind).toBe('preset');
    expect(parsed.scheduleValue).toBe('24h');
    expect(parsed.viewportWidth).toBe(1280);
    expect(parsed.viewportHeight).toBe(800);
    expect(parsed.fullPage).toBe(true);
    expect(parsed.changeThreshold).toBe(0.5);
    expect(parsed.ignoreSelectors).toEqual([]);
    expect(parsed.headers).toEqual({});
    expect(parsed.cookies).toEqual([]);
  });

  it('rejects non-http urls', () => {
    const result = monitorCreateSchema(0).safeParse({ ...validMonitor, url: 'ftp://x/y' });
    expect(result.success).toBe(false);
  });

  it('rejects an unknown interval preset', () => {
    const result = monitorCreateSchema(0).safeParse({
      ...validMonitor,
      scheduleKind: 'preset',
      scheduleValue: '5m',
    });
    expect(result.success).toBe(false);
  });

  it('rejects an invalid cron expression', () => {
    const result = monitorCreateSchema(0).safeParse({
      ...validMonitor,
      scheduleKind: 'cron',
      scheduleValue: 'every hour',
    });
    expect(result.success).toBe(false);
  });

  it('enforces the minimum interval for cron schedules', () => {
    const fast = monitorCreateSchema(60).safeParse({
      ...validMonitor,
      scheduleKind: 'cron',
      scheduleValue: '*/5 * * * *',
    });
    expect(fast.success).toBe(false);

    const slow = monitorCreateSchema(60).safeParse({
      ...validMonitor,
      scheduleKind: 'cron',
      scheduleValue: '0 * * * *',
    });
    expect(slow.success).toBe(true);
  });

  it('requires waitSelector when waitStrategy is selector', () => {
    const missing = monitorCreateSchema(0).safeParse({
      ...validMonitor,
      waitStrategy: 'selector',
    });
    expect(missing.success).toBe(false);

    const ok = monitorCreateSchema(0).safeParse({
      ...validMonitor,
      waitStrategy: 'selector',
      waitSelector: '#app.loaded',
    });
    expect(ok.success).toBe(true);
  });

  it('rejects viewport sizes outside the allowed range', () => {
    expect(monitorCreateSchema(0).safeParse({ ...validMonitor, viewportWidth: 10 }).success).toBe(
      false,
    );
    expect(
      monitorCreateSchema(0).safeParse({ ...validMonitor, viewportHeight: 20000 }).success,
    ).toBe(false);
  });

  it('rejects oversized header/cookie collections', () => {
    const headers: Record<string, string> = {};
    for (let i = 0; i < 51; i += 1) headers[`x-h-${i}`] = 'v';
    expect(monitorCreateSchema(0).safeParse({ ...validMonitor, headers }).success).toBe(false);
  });

  it('rejects invalid header names', () => {
    expect(
      monitorCreateSchema(0).safeParse({ ...validMonitor, headers: { 'bad header': 'v' } }).success,
    ).toBe(false);
  });
});

describe('monitorUpdateSchema', () => {
  it('allows partial updates without resetting defaults', () => {
    const parsed = monitorUpdateSchema(0).parse({ name: 'Renamed' });
    expect(parsed).toEqual({ name: 'Renamed' });
    expect('changeThreshold' in parsed).toBe(false);
  });

  it('still validates the fields it is given', () => {
    expect(monitorUpdateSchema(0).safeParse({ url: 'not-a-url' }).success).toBe(false);
    expect(monitorUpdateSchema(0).safeParse({ scheduleValue: 'nope' }).success).toBe(false);
    expect(monitorUpdateSchema(0).safeParse({ scheduleKind: 'cron' }).success).toBe(false);
    expect(
      monitorUpdateSchema(0).safeParse({ scheduleKind: 'cron', scheduleValue: '0 3 * * *' })
        .success,
    ).toBe(true);
  });
});

describe('validateSchedule', () => {
  it('accepts known presets', () => {
    expect(validateSchedule('preset', '15m')).toEqual({ ok: true });
    expect(validateSchedule('preset', 'nope')).toMatchObject({ ok: false });
  });

  it('accepts valid cron and rejects invalid', () => {
    expect(validateSchedule('cron', '0 3 * * *')).toEqual({ ok: true });
    expect(validateSchedule('cron', 'bogus').ok).toBe(false);
  });
});

describe('channelCreateSchema', () => {
  it('accepts a webhook channel with a secret', () => {
    const parsed = channelCreateSchema.parse({
      type: 'webhook',
      name: 'Ops',
      config: { url: 'https://hooks.example.com/x', secret: 'supersecretvalue' },
    });
    expect(parsed.type).toBe('webhook');
    expect(parsed.enabled).toBe(true);
  });

  it('accepts a slack channel', () => {
    const parsed = channelCreateSchema.parse({
      type: 'slack',
      name: 'Slack',
      config: { url: 'https://hooks.slack.com/services/T/B/XXX' },
    });
    expect(parsed.type).toBe('slack');
  });

  it('accepts an email channel', () => {
    expect(
      channelCreateSchema.safeParse({
        type: 'email',
        name: 'Mail',
        config: { to: ['ops@example.com'] },
      }).success,
    ).toBe(true);
    expect(
      channelCreateSchema.safeParse({
        type: 'email',
        name: 'Mail',
        config: { to: ['not-an-email'] },
      }).success,
    ).toBe(false);
  });

  it('rejects non-http webhook urls', () => {
    expect(
      channelCreateSchema.safeParse({
        type: 'webhook',
        name: 'Bad',
        config: { url: 'file:///etc/passwd' },
      }).success,
    ).toBe(false);
  });
});

describe('emailSchema', () => {
  it('validates addresses', () => {
    expect(emailSchema.safeParse('a@b.co').success).toBe(true);
    expect(emailSchema.safeParse('a@b').success).toBe(false);
    expect(emailSchema.safeParse('nope').success).toBe(false);
  });
});

describe('compareQuerySchema / shareCreateSchema', () => {
  it('requires two uuids', () => {
    const ok = compareQuerySchema.safeParse({
      a: '00000000-0000-4000-8000-000000000000',
      b: '00000000-0000-4000-8000-000000000001',
    });
    expect(ok.success).toBe(true);
    expect(ok.data?.store).toBe('false');
    expect(compareQuerySchema.safeParse({ a: 'nope', b: 'nope' }).success).toBe(false);
  });

  it('defaults share expiry to null', () => {
    expect(shareCreateSchema.parse({})).toEqual({ expiresInHours: null });
    expect(shareCreateSchema.safeParse({ expiresInHours: 0 }).success).toBe(false);
  });
});

describe('describeSchedule', () => {
  it('describes presets and cron expressions', () => {
    expect(describeSchedule('preset', '1h')).toBe('Every hour');
    expect(describeSchedule('cron', '*/15 * * * *')).toBe('Every 15 minutes');
  });
});
