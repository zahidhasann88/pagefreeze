/**
 * A small, dependency-free 5-field cron parser.
 *
 * Supported syntax (Vixie-style):
 *   field: minute(0-59) hour(0-23) day-of-month(1-31) month(1-12) day-of-week(0-7, 0 and 7 = Sunday)
 *   values: `*`, `n`, `a-b`, `a-b` with step, `*` with step, and comma separated lists
 *   of any of those. Three letter names are accepted for month (`jan`) and
 *   day-of-week (`mon`). `?` is accepted for day-of-month and day-of-week and
 *   behaves like `*`.
 *
 * Day-of-month / day-of-week follow the Vixie rule: when both fields are restricted
 * (i.e. not `*` or `?`) a day matches when *either* field matches; when only one is
 * restricted, only that one is considered.
 *
 * All evaluation is done in UTC. Pagefreeze schedules everything in UTC and the UI
 * renders the resulting timestamps in the viewer's local timezone.
 */

export class CronParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CronParseError';
  }
}

const MONTH_NAMES: Record<string, number> = {
  jan: 1,
  feb: 2,
  mar: 3,
  apr: 4,
  may: 5,
  jun: 6,
  jul: 7,
  aug: 8,
  sep: 9,
  oct: 10,
  nov: 11,
  dec: 12,
};

const DOW_NAMES: Record<string, number> = {
  sun: 0,
  mon: 1,
  tue: 2,
  wed: 3,
  thu: 4,
  fri: 5,
  sat: 6,
};

export interface CronExpression {
  /** Raw, trimmed expression as supplied by the user. */
  readonly raw: string;
  readonly minutes: ReadonlySet<number>;
  readonly hours: ReadonlySet<number>;
  readonly daysOfMonth: ReadonlySet<number>;
  readonly months: ReadonlySet<number>;
  readonly daysOfWeek: ReadonlySet<number>;
  /** True when day-of-month was explicitly restricted (not `*` / `?`). */
  readonly domRestricted: boolean;
  /** True when day-of-week was explicitly restricted (not `*` / `?`). */
  readonly dowRestricted: boolean;
}

const FIELD_COUNT = 5;

/** Cache parse results: the same expression is parsed many times (render, validate, schedule). */
const parseCache = new Map<string, CronExpression>();

function parseField(
  raw: string,
  min: number,
  max: number,
  names: Record<string, number> | null,
  label: string,
): { values: Set<number>; restricted: boolean } {
  const field = raw.trim().toLowerCase();
  if (field.length === 0) {
    throw new CronParseError(`${label} field is empty`);
  }

  const restricted = field !== '*' && field !== '?';
  const values = new Set<number>();

  for (const part of field.split(',')) {
    if (part.length === 0) {
      throw new CronParseError(`${label} field has an empty list element`);
    }
    const [rangePart, stepPart, ...rest] = part.split('/');
    if (rest.length > 0) {
      throw new CronParseError(`${label} field "${part}" is not valid`);
    }

    let step = 1;
    if (stepPart !== undefined) {
      if (!/^\d+$/.test(stepPart)) {
        throw new CronParseError(`${label} field step "${stepPart}" is not a number`);
      }
      step = Number.parseInt(stepPart, 10);
      if (step < 1 || step > max) {
        throw new CronParseError(`${label} field step "${stepPart}" is out of range`);
      }
    }

    let start: number;
    let end: number;

    if (rangePart === '*' || rangePart === '?') {
      start = min;
      end = max;
    } else if (rangePart?.includes('-')) {
      const [left, right, ...extra] = rangePart.split('-');
      if (extra.length > 0 || left === undefined || right === undefined) {
        throw new CronParseError(`${label} field range "${rangePart}" is not valid`);
      }
      start = parseValue(left, min, max, names, label);
      end = parseValue(right, min, max, names, label);
      if (start > end) {
        // Ranges may wrap (e.g. `fri-sun` or `22-2`); expand through the boundary.
        for (let v = start; v <= max; v += step) values.add(v);
        for (let v = min; v <= end; v += step) values.add(v);
        continue;
      }
    } else {
      const single = parseValue(rangePart ?? '', min, max, names, label);
      if (stepPart === undefined) {
        values.add(single);
        continue;
      }
      start = single;
      end = max;
    }

    for (let v = start; v <= end; v += step) values.add(v);
  }

  if (values.size === 0) {
    throw new CronParseError(`${label} field "${raw}" matches nothing`);
  }

  return { values, restricted };
}

function parseValue(
  raw: string,
  min: number,
  max: number,
  names: Record<string, number> | null,
  label: string,
): number {
  const token = raw.trim();
  if (names && token in names) {
    return names[token] as number;
  }
  if (!/^\d+$/.test(token)) {
    throw new CronParseError(`${label} field value "${raw}" is not a number`);
  }
  const value = Number.parseInt(token, 10);
  if (Number.isNaN(value) || value < min || value > max) {
    throw new CronParseError(`${label} field value "${raw}" is out of range (${min}-${max})`);
  }
  return value;
}

/** Parse a cron expression. Throws {@link CronParseError} when invalid. */
export function parseCron(expression: string): CronExpression {
  const key = String(expression ?? '');
  const cached = parseCache.get(key);
  if (cached) return cached;

  const fields = key.trim().split(/\s+/);
  if (fields.length !== FIELD_COUNT) {
    throw new CronParseError(
      `cron expression must have ${FIELD_COUNT} fields (minute hour day-of-month month day-of-week), got ${fields.length}`,
    );
  }

  const [minuteF = '', hourF = '', domF = '', monthF = '', dowF = ''] = fields;

  const minutes = parseField(minuteF, 0, 59, null, 'minute');
  const hours = parseField(hourF, 0, 23, null, 'hour');
  const dom = parseField(domF, 1, 31, null, 'day-of-month');
  const months = parseField(monthF, 1, 12, MONTH_NAMES, 'month');
  const dow = parseField(dowF, 0, 7, DOW_NAMES, 'day-of-week');

  // Normalise day-of-week: 7 means Sunday, same as 0.
  const dowValues = new Set<number>();
  for (const v of dow.values) dowValues.add(v === 7 ? 0 : v);

  const parsed: CronExpression = {
    raw: key.trim(),
    minutes: minutes.values,
    hours: hours.values,
    daysOfMonth: dom.values,
    months: months.values,
    daysOfWeek: dowValues,
    domRestricted: dom.restricted,
    dowRestricted: dow.restricted,
  };

  if (parseCache.size > 500) parseCache.clear();
  parseCache.set(key, parsed);
  return parsed;
}

export function isValidCron(expression: string): boolean {
  try {
    parseCron(expression);
    return true;
  } catch {
    return false;
  }
}

function dayMatches(expr: CronExpression, year: number, month1: number, day: number): boolean {
  const dow = new Date(Date.UTC(year, month1 - 1, day)).getUTCDay();
  const domMatch = expr.daysOfMonth.has(day);
  const dowMatch = expr.daysOfWeek.has(dow);

  if (expr.domRestricted && expr.dowRestricted) return domMatch || dowMatch;
  if (expr.domRestricted) return domMatch;
  if (expr.dowRestricted) return dowMatch;
  return true;
}

/** True when the given instant (whole minute, UTC) satisfies the expression. */
export function cronMatches(expr: CronExpression, at: Date): boolean {
  return (
    expr.months.has(at.getUTCMonth() + 1) &&
    expr.hours.has(at.getUTCHours()) &&
    expr.minutes.has(at.getUTCMinutes()) &&
    dayMatches(expr, at.getUTCFullYear(), at.getUTCMonth() + 1, at.getUTCDate())
  );
}

function firstAtOrAfter(sorted: number[], value: number): number | null {
  for (const v of sorted) {
    if (v >= value) return v;
  }
  return null;
}

const MINUTE_MS = 60_000;

function startOfNextDay(t: number): number {
  return t - (t % 86_400_000) + 86_400_000;
}

/**
 * First run at or after `from`, scanning at most `maxYears` into the future.
 * Returns `null` when nothing matches inside that window.
 */
export function nextRunAfter(expr: CronExpression, from: Date, maxYears = 5): Date | null {
  const minutes = [...expr.minutes].sort((a, b) => a - b);
  const hours = [...expr.hours].sort((a, b) => a - b);
  const months = [...expr.months].sort((a, b) => a - b);

  let t = Math.floor(from.getTime() / MINUTE_MS) * MINUTE_MS + MINUTE_MS;
  const limit = from.getTime() + maxYears * 366 * 86_400_000;

  let guard = 0;
  while (t <= limit) {
    if (guard++ > 2_000_000) return null; // pathological expression, bail out
    const d = new Date(t);
    const y = d.getUTCFullYear();
    const mo = d.getUTCMonth() + 1;
    const day = d.getUTCDate();

    if (!expr.months.has(mo)) {
      const nextMonth = firstAtOrAfter(months, mo + 1) ?? months[0]!;
      const ny = nextMonth <= mo ? y + 1 : y;
      t = Date.UTC(ny, nextMonth - 1, 1, 0, 0, 0, 0);
      continue;
    }

    if (!dayMatches(expr, y, mo, day)) {
      t = startOfNextDay(t);
      continue;
    }

    const hh = d.getUTCHours();
    if (!expr.hours.has(hh)) {
      const nextHour = firstAtOrAfter(hours, hh + 1);
      if (nextHour === null) {
        t = startOfNextDay(t);
      } else {
        t = Date.UTC(y, mo - 1, day, nextHour, minutes[0]!, 0, 0);
      }
      continue;
    }

    const mi = d.getUTCMinutes();
    if (!expr.minutes.has(mi)) {
      const nextMinute = firstAtOrAfter(minutes, mi + 1);
      if (nextMinute === null) {
        t = Date.UTC(y, mo - 1, day, hh, 0, 0, 0) + 3_600_000;
      } else {
        t = Date.UTC(y, mo - 1, day, hh, nextMinute, 0, 0);
      }
      continue;
    }

    return d;
  }

  return null;
}

/** Convenience wrapper that parses first. Returns `null` for invalid expressions. */
export function nextRunAfterExpression(expression: string, from: Date, maxYears = 5): Date | null {
  try {
    return nextRunAfter(parseCron(expression), from, maxYears);
  } catch {
    return null;
  }
}

const minGapCache = new Map<string, number | null>();

/**
 * Smallest gap (in minutes) between two consecutive runs, sampled over the next
 * ~400 days. Returns `null` when fewer than two runs exist in the window (for example
 * `0 0 29 2 *`), in which case a minimum-interval check cannot be applied.
 *
 * Bounded work: at most 200 occurrences are enumerated.
 */
export function cronMinGapMinutes(expression: string): number | null {
  const key = String(expression ?? '');
  if (minGapCache.has(key)) return minGapCache.get(key) ?? null;

  let result: number | null = null;
  try {
    const expr = parseCron(key);
    const start = new Date();
    const windowEnd = start.getTime() + 400 * 86_400_000;
    let cursor = start;
    let previous: number | null = null;
    let min = Number.POSITIVE_INFINITY;
    let count = 0;

    while (count < 200) {
      const next = nextRunAfter(expr, cursor, 2);
      if (!next || next.getTime() > windowEnd) break;
      if (previous !== null) {
        min = Math.min(min, (next.getTime() - previous) / MINUTE_MS);
      }
      previous = next.getTime();
      cursor = next;
      count += 1;
    }

    result = count >= 2 && Number.isFinite(min) ? Math.round(min) : null;
  } catch {
    result = null;
  }

  if (minGapCache.size > 500) minGapCache.clear();
  minGapCache.set(key, result);
  return result;
}

function joinList(items: string[]): string {
  if (items.length === 1) return items[0]!;
  if (items.length === 2) return `${items[0]} and ${items[1]}`;
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
}

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

function describeSet(values: ReadonlySet<number>, unit: string): string {
  const sorted = [...values].sort((a, b) => a - b);
  if (sorted.length === 1) return `${sorted[0]}`;
  // Contiguous?
  let contiguous = true;
  for (let i = 1; i < sorted.length; i += 1) {
    if (sorted[i] !== sorted[i - 1]! + 1) {
      contiguous = false;
      break;
    }
  }
  if (contiguous && sorted.length > 2 && unit !== 'minute') {
    return `${sorted[0]}-${sorted[sorted.length - 1]}`;
  }
  return sorted.join(', ');
}

const MONTH_LABELS = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
];

const DOW_LABELS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

/**
 * Human readable description of a cron expression. Intentionally simple and
 * deterministic; it is used for form feedback and the monitor list.
 */
export function describeCron(expression: string): string {
  let expr: CronExpression;
  try {
    expr = parseCron(expression);
  } catch (error) {
    return `Invalid schedule: ${(error as Error).message}`;
  }

  const everyMinute = expr.minutes.size === 60 && expr.hours.size === 24;
  const allDays = !expr.domRestricted && !expr.dowRestricted;
  const everyMonth = expr.months.size === 12;

  // Time of day, when the expression resolves to a single hour/minute pair.
  const hourList = [...expr.hours].sort((a, b) => a - b);
  const minuteList = [...expr.minutes].sort((a, b) => a - b);
  const singleTime = hourList.length === 1 && minuteList.length === 1;

  const timePart = singleTime ? `${pad2(hourList[0]!)}:${pad2(minuteList[0]!)} UTC` : null;

  // "Every N minutes"
  if (allDays && everyMonth && expr.minutes.size > 1 && expr.hours.size === 24) {
    const step = detectStep(minuteList, 60);
    if (step !== null) return `Every ${step} minutes`;
  }

  // "Every N hours"
  if (allDays && everyMonth && minuteList.length === 1 && expr.hours.size > 1) {
    const step = detectStep(hourList, 24);
    if (step !== null && minuteList[0] === 0) return `Every ${step} hours`;
  }

  if (everyMinute && allDays && everyMonth) return 'Every minute';

  const segments: string[] = [];

  // Day part
  if (allDays) {
    // nothing
  } else if (expr.domRestricted && expr.dowRestricted) {
    const doms = [...expr.daysOfMonth].sort((a, b) => a - b);
    const dows = [...expr.daysOfWeek].sort((a, b) => a - b);
    segments.push(
      `on day ${describeSet(new Set(doms), 'day')} of the month and every ${joinList(
        dows.map((d) => DOW_LABELS[d] ?? String(d)),
      )}`,
    );
  } else if (expr.dowRestricted) {
    const dows = [...expr.daysOfWeek].sort((a, b) => a - b);
    const contiguousDow =
      dows.length > 2 && dows.every((d, i) => i === 0 || d === dows[i - 1]! + 1);
    if (contiguousDow) {
      segments.push(`${DOW_LABELS[dows[0]!]} through ${DOW_LABELS[dows[dows.length - 1]!]}`);
    } else {
      segments.push(joinList(dows.map((d) => DOW_LABELS[d] ?? String(d))));
    }
  } else {
    const doms = [...expr.daysOfMonth].sort((a, b) => a - b);
    segments.push(`on day ${describeSet(new Set(doms), 'day')} of the month`);
  }

  if (!everyMonth) {
    const months = [...expr.months].sort((a, b) => a - b);
    segments.push(`in ${joinList(months.map((m) => MONTH_LABELS[m - 1] ?? String(m)))}`);
  }

  let out: string;
  if (singleTime) {
    out = `At ${timePart}`;
    if (allDays && everyMonth) out += ' every day';
    if (segments.length > 0) out += ` ${segments.join(' ')}`;
    return out;
  }

  const parts: string[] = [];
  if (expr.minutes.size === 60) {
    parts.push('every minute');
  } else if (minuteList.length === 1 && minuteList[0] === 0) {
    parts.push('hourly');
  } else {
    parts.push(`at minute ${describeSet(expr.minutes, 'minute')}`);
  }
  if (expr.hours.size !== 24 && hourList.length === 1) {
    parts.push(`past hour ${pad2(hourList[0]!)}`);
  } else if (expr.hours.size !== 24) {
    parts.push(`during hours ${describeSet(expr.hours, 'hour')}`);
  }
  if (segments.length > 0) parts.push(segments.join(' '));

  out = parts.join(' ');
  return out.charAt(0).toUpperCase() + out.slice(1);
}

function detectStep(sorted: number[], modulus: number): number | null {
  if (sorted.length < 2) return null;
  const step = sorted[1]! - sorted[0]!;
  if (step <= 0) return null;
  for (let i = 1; i < sorted.length; i += 1) {
    if (sorted[i] !== sorted[i - 1]! + step) return null;
  }
  if (sorted[sorted.length - 1]! + step !== modulus) return null;
  return step;
}
