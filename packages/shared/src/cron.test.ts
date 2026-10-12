import { describe, expect, it } from 'vitest';
import {
  CronParseError,
  cronMatches,
  cronMinGapMinutes,
  describeCron,
  isValidCron,
  nextRunAfter,
  parseCron,
} from './cron.js';

describe('parseCron', () => {
  it('parses the built-in presets', () => {
    expect(isValidCron('*/15 * * * *')).toBe(true);
    expect(isValidCron('0 * * * *')).toBe(true);
    expect(isValidCron('0 */6 * * *')).toBe(true);
    expect(isValidCron('0 0 * * *')).toBe(true);
    expect(isValidCron('0 0 * * 0')).toBe(true);
  });

  it('rejects wrong field counts', () => {
    expect(isValidCron('* * *')).toBe(false);
    expect(isValidCron('* * * * * *')).toBe(false);
    expect(() => parseCron('* * *')).toThrow(CronParseError);
  });

  it('rejects out of range and non numeric values', () => {
    expect(isValidCron('60 * * * *')).toBe(false);
    expect(isValidCron('* 24 * * *')).toBe(false);
    expect(isValidCron('* * 0 * *')).toBe(false);
    expect(isValidCron('* * * 13 *')).toBe(false);
    expect(isValidCron('* * * * 8')).toBe(false);
    expect(isValidCron('a * * * *')).toBe(false);
  });

  it('accepts names, lists, ranges and steps', () => {
    expect([...parseCron('0 0 * jan sun').months]).toEqual([1]);
    expect([...parseCron('0 0 * * mon-fri').daysOfWeek]).toEqual([1, 2, 3, 4, 5]);
    expect([...parseCron('0,15,30 1,2 * * *').minutes]).toEqual([0, 15, 30]);
    expect([...parseCron('0 0 * * *').hours]).toEqual([0]);
    expect(parseCron('*/20 * * * *').minutes.size).toBe(3);
  });

  it('treats 7 as Sunday', () => {
    expect([...parseCron('0 0 * * 7').daysOfWeek]).toEqual([0]);
  });

  it('accepts ? for day-of-month and day-of-week and marks them unrestricted', () => {
    const expr = parseCron('0 0 ? * ?');
    expect(expr.domRestricted).toBe(false);
    expect(expr.dowRestricted).toBe(false);
  });

  it('rejects invalid steps', () => {
    expect(isValidCron('*/0 * * * *')).toBe(false);
    expect(isValidCron('*/x * * * *')).toBe(false);
  });

  it('handles wrapping ranges', () => {
    expect([...parseCron('0 0 * * fri-sun').daysOfWeek].sort()).toEqual([0, 5, 6]);
  });
});

describe('cronMatches / nextRunAfter', () => {
  it('matches a per-minute expression', () => {
    const expr = parseCron('* * * * *');
    expect(cronMatches(expr, new Date('2026-01-01T00:00:00Z'))).toBe(true);
    expect(cronMatches(expr, new Date('2026-01-01T00:01:00Z'))).toBe(true);
  });

  it('finds the next quarter hour', () => {
    const expr = parseCron('*/15 * * * *');
    const next = nextRunAfter(expr, new Date('2026-01-01T00:07:30Z'));
    expect(next?.toISOString()).toBe('2026-01-01T00:15:00.000Z');
  });

  it('rolls over into the next hour', () => {
    const expr = parseCron('*/15 * * * *');
    const next = nextRunAfter(expr, new Date('2026-01-01T00:47:00Z'));
    expect(next?.toISOString()).toBe('2026-01-01T01:00:00.000Z');
  });

  it('finds the next weekday occurrence', () => {
    const expr = parseCron('30 9 * * 1-5');
    // 2026-01-01 is a Thursday.
    const next = nextRunAfter(expr, new Date('2026-01-01T00:00:00Z'));
    expect(next?.toISOString()).toBe('2026-01-01T09:30:00.000Z');
    // 2026-01-03 is a Saturday -> next is Monday 2026-01-05.
    const nextWeekend = nextRunAfter(expr, new Date('2026-01-03T10:00:00Z'));
    expect(nextWeekend?.toISOString()).toBe('2026-01-05T09:30:00.000Z');
  });

  it('handles a monthly expression', () => {
    const expr = parseCron('0 0 1 * *');
    const next = nextRunAfter(expr, new Date('2026-02-15T00:00:00Z'));
    expect(next?.toISOString()).toBe('2026-03-01T00:00:00.000Z');
  });

  it('handles a specific month and day-of-month', () => {
    const expr = parseCron('0 12 25 12 *');
    const next = nextRunAfter(expr, new Date('2026-01-01T00:00:00Z'));
    expect(next?.toISOString()).toBe('2026-12-25T12:00:00.000Z');
  });

  it('applies the Vixie day rule when both dom and dow are restricted', () => {
    const expr = parseCron('0 0 1 * 1');
    // 2026-05-02 is a Saturday: the next Monday (2026-05-04) comes before the first
    // of the next month, which is what the OR rule should produce.
    expect(nextRunAfter(expr, new Date('2026-05-02T00:00:00Z'))?.toISOString()).toBe(
      '2026-05-04T00:00:00.000Z',
    );
    // 2026-06-30 is a Tuesday: the first of July (2026-07-01) comes before the next
    // Monday (2026-07-06), so the day-of-month branch wins.
    expect(nextRunAfter(expr, new Date('2026-06-30T00:00:00Z'))?.toISOString()).toBe(
      '2026-07-01T00:00:00.000Z',
    );
  });

  it('returns null for an expression that never matches', () => {
    const expr = parseCron('0 0 30 2 *'); // 30th of February
    expect(nextRunAfter(expr, new Date('2026-01-01T00:00:00Z'))).toBeNull();
  });

  it('never returns a time in the past or equal to the input minute', () => {
    const expr = parseCron('0 0 * * *');
    const next = nextRunAfter(expr, new Date('2026-06-01T00:00:00Z'));
    expect(next?.toISOString()).toBe('2026-06-02T00:00:00.000Z');
  });
});

describe('cronMinGapMinutes', () => {
  it('computes the gap for step expressions', () => {
    expect(cronMinGapMinutes('*/15 * * * *')).toBe(15);
    expect(cronMinGapMinutes('*/5 * * * *')).toBe(5);
    expect(cronMinGapMinutes('0 * * * *')).toBe(60);
    expect(cronMinGapMinutes('0 */6 * * *')).toBe(360);
    expect(cronMinGapMinutes('0 0 * * *')).toBe(1440);
  });

  it('returns null when fewer than two runs fit in the sample window', () => {
    expect(cronMinGapMinutes('0 0 29 2 *')).toBeNull();
  });

  it('returns null for invalid expressions', () => {
    expect(cronMinGapMinutes('not a cron')).toBeNull();
  });
});

describe('describeCron', () => {
  it('describes the presets', () => {
    expect(describeCron('*/15 * * * *')).toBe('Every 15 minutes');
    expect(describeCron('0 * * * *')).toBe('Every 1 hours');
    expect(describeCron('0 */6 * * *')).toBe('Every 6 hours');
    expect(describeCron('0 0 * * *')).toBe('At 00:00 UTC every day');
    expect(describeCron('0 0 * * 0')).toContain('Sunday');
  });

  it('describes a weekday time', () => {
    expect(describeCron('30 9 * * 1-5')).toContain('Monday through Friday');
    expect(describeCron('30 9 * * 1-5')).toContain('09:30 UTC');
  });

  it('reports invalid expressions', () => {
    expect(describeCron('nope')).toContain('Invalid schedule');
  });
});
