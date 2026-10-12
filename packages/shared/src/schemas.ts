import { z } from 'zod';
import {
  CHANNEL_TYPES,
  DEFAULT_CHANGE_THRESHOLD,
  DEFAULT_VIEWPORT,
  DEVICE_PRESET_KEYS,
  INTERVAL_PRESET_KEYS,
  LIMITS,
  MAX_CHANGE_THRESHOLD,
  MIN_CHANGE_THRESHOLD,
  WAIT_STRATEGIES,
} from './constants.js';
import { cronMinGapMinutes, describeCron, isValidCron } from './cron.js';

/**
 * Absolute http(s) URL. Anything else is rejected up front; the SSRF guard in the
 * capture engine performs the real (per-request, DNS-level) check later.
 */
export const httpUrlSchema = z
  .string()
  .trim()
  .min(1)
  .max(LIMITS.urlMax)
  .refine(
    (value) => {
      try {
        const parsed = new URL(value);
        return parsed.protocol === 'http:' || parsed.protocol === 'https:';
      } catch {
        return false;
      }
    },
    { error: 'must be an absolute http(s) URL' },
  );

export const uuidSchema = z.uuid();

export const emailSchema = z
  .string()
  .trim()
  .min(3)
  .max(320)
  .refine((value) => /^[^@\s]+@[^@\s.]+(\.[^@\s.]+)+$/.test(value), {
    error: 'must be a valid email address',
  });

export const cssSelectorSchema = z
  .string()
  .trim()
  .min(1)
  .max(LIMITS.selectorMax)
  .refine((value) => !value.includes('\n') && !value.includes('\r'), {
    error: 'must be a single-line CSS selector',
  });

export const tagSchema = z.string().trim().min(1).max(LIMITS.tagMax);

export const paginationSchema = z.object({
  limit: z.coerce.number().int().min(1).max(LIMITS.pageSizeMax).default(LIMITS.pageSizeDefault),
  cursor: z.string().trim().min(1).max(512).optional(),
});

export type PaginationInput = z.input<typeof paginationSchema>;
export interface Page<T> {
  data: T[];
  nextCursor: string | null;
  hasMore: boolean;
}

export const scheduleKindSchema = z.enum(['preset', 'cron']);
export interface ScheduleValidationOptions {
  minIntervalMinutes?: number;
}

export function validateSchedule(
  scheduleKind: 'preset' | 'cron',
  scheduleValue: string,
  options: ScheduleValidationOptions = {},
): { ok: true } | { ok: false; message: string } {
  if (scheduleKind === 'preset') {
    if (!(INTERVAL_PRESET_KEYS as string[]).includes(scheduleValue)) {
      return { ok: false, message: `unknown interval preset "${scheduleValue}"` };
    }
    return { ok: true };
  }

  if (!isValidCron(scheduleValue)) {
    return { ok: false, message: `"${scheduleValue}" is not a valid cron expression` };
  }

  const minIntervalMinutes = options.minIntervalMinutes ?? 0;
  if (minIntervalMinutes > 0) {
    const gap = cronMinGapMinutes(scheduleValue);

    if (gap !== null && gap < minIntervalMinutes) {
      return {
        ok: false,
        message: `schedule runs every ${gap} minute(s), which is more often than the configured minimum of ${minIntervalMinutes} minute(s)`,
      };
    }
  }

  return { ok: true };
}

export function scheduleToCron(scheduleKind: 'preset' | 'cron', scheduleValue: string): string {
  return scheduleKind === 'cron' ? scheduleValue : presetToCron(scheduleValue);
}

export function presetToCron(preset: string): string {
  switch (preset) {
    case '15m':
      return '*/15 * * * *';
    case '1h':
      return '0 * * * *';
    case '6h':
      return '0 */6 * * *';
    case '24h':
      return '0 0 * * *';
    case '7d':
      return '0 0 * * 0';
    default:
      return '0 0 * * *';
  }
}

export const cookieInputSchema = z.object({
  name: z.string().trim().min(1).max(200),
  value: z.string().max(LIMITS.cookieValueMax),
  domain: z.string().trim().max(253).optional(),
  path: z.string().trim().max(512).default('/'),
  secure: z.boolean().default(false),
  httpOnly: z.boolean().default(false),
  sameSite: z.enum(['Lax', 'Strict', 'None']).default('Lax'),
});

export type CookieInput = z.input<typeof cookieInputSchema>;

export const headersSchema = z
  .record(
    z
      .string()
      .min(1)
      .max(LIMITS.headerNameMax)
      .refine((v) => /^[A-Za-z0-9!#$%&'*+\-.^_`|~]+$/.test(v), { error: 'invalid header name' }),
    z.string().max(LIMITS.headerValueMax),
  )
  .refine((record) => Object.keys(record).length <= LIMITS.headersMax, {
    error: `at most ${LIMITS.headersMax} headers are allowed`,
  });

export type HeadersInput = z.input<typeof headersSchema>;

const monitorFields = {
  name: z.string().trim().min(1).max(LIMITS.nameMax),
  url: httpUrlSchema,
  tags: z.array(tagSchema).max(LIMITS.tagsMax),
  enabled: z.boolean(),
  scheduleKind: scheduleKindSchema,
  scheduleValue: z.string().trim().min(1).max(100),
  devicePreset: z.enum(DEVICE_PRESET_KEYS),
  viewportWidth: z.number().int().min(LIMITS.viewportMin).max(LIMITS.viewportMax),
  viewportHeight: z.number().int().min(LIMITS.viewportMin).max(LIMITS.viewportMax),
  fullPage: z.boolean(),
  waitStrategy: z.enum(WAIT_STRATEGIES),
  waitSelector: cssSelectorSchema.nullable(),
  extraDelayMs: z.number().int().min(0).max(LIMITS.delayMaxMs),
  captureSelector: cssSelectorSchema.nullable(),
  ignoreSelectors: z.array(cssSelectorSchema).max(LIMITS.ignoreSelectorsMax),
  userAgent: z.string().trim().max(LIMITS.userAgentMax).nullable(),
  changeThreshold: z.number().min(MIN_CHANGE_THRESHOLD).max(MAX_CHANGE_THRESHOLD),
  detectText: z.boolean(),
  detectHtml: z.boolean(),
  retentionDays: z.number().int().min(1).max(3650).nullable(),
  headers: headersSchema,
  cookies: z.array(cookieInputSchema).max(LIMITS.cookiesMax),
  channelIds: z.array(uuidSchema).max(50),
};

function refineWaitSelector(
  value: { waitStrategy?: string; waitSelector?: string | null },
  ctx: z.RefinementCtx,
): void {
  if (value.waitStrategy !== 'selector') return;
  const selector = value.waitSelector;
  if (selector === undefined || selector === null || selector.trim() === '') {
    ctx.addIssue({
      code: 'custom',
      path: ['waitSelector'],
      message: 'waitSelector is required when waitStrategy is "selector"',
    });
  }
}

function refineSchedule(minIntervalMinutes: number) {
  return (
    value: { scheduleKind?: 'preset' | 'cron'; scheduleValue?: string },
    ctx: z.RefinementCtx,
  ): void => {
    const kind = value.scheduleKind;
    const cron = value.scheduleValue;

    if (kind === undefined || cron === undefined) {
      if (kind !== undefined || cron !== undefined) {
        ctx.addIssue({
          code: 'custom',
          path: [kind === undefined ? 'scheduleKind' : 'scheduleValue'],
          message: 'scheduleKind and scheduleValue must be updated together',
        });
      }
      return;
    }

    const result = validateSchedule(kind, cron, { minIntervalMinutes });
    if (!result.ok) {
      ctx.addIssue({ code: 'custom', path: ['scheduleValue'], message: result.message });
    }
  };
}

export function monitorCreateSchema(minIntervalMinutes = 0) {
  return z
    .object({
      name: monitorFields.name,
      url: monitorFields.url,
      tags: monitorFields.tags.default([]),
      enabled: monitorFields.enabled.default(true),
      scheduleKind: monitorFields.scheduleKind.default('preset'),
      scheduleValue: monitorFields.scheduleValue.default('24h'),
      devicePreset: monitorFields.devicePreset.default('desktop'),
      viewportWidth: monitorFields.viewportWidth.default(DEFAULT_VIEWPORT.width),
      viewportHeight: monitorFields.viewportHeight.default(DEFAULT_VIEWPORT.height),
      fullPage: monitorFields.fullPage.default(true),
      waitStrategy: monitorFields.waitStrategy.default('load'),
      waitSelector: monitorFields.waitSelector.default(null),
      extraDelayMs: monitorFields.extraDelayMs.default(0),
      captureSelector: monitorFields.captureSelector.default(null),
      ignoreSelectors: monitorFields.ignoreSelectors.default([]),
      userAgent: monitorFields.userAgent.default(null),
      changeThreshold: monitorFields.changeThreshold.default(DEFAULT_CHANGE_THRESHOLD),
      detectText: monitorFields.detectText.default(true),
      detectHtml: monitorFields.detectHtml.default(true),
      retentionDays: monitorFields.retentionDays.default(null),
      headers: monitorFields.headers.default({}),
      cookies: monitorFields.cookies.default([]),
      channelIds: monitorFields.channelIds.optional(),
    })
    .superRefine(refineWaitSelector)
    .superRefine(refineSchedule(minIntervalMinutes));
}

export function monitorUpdateSchema(minIntervalMinutes = 0) {
  return z
    .object({
      name: monitorFields.name.optional(),
      url: monitorFields.url.optional(),
      tags: monitorFields.tags.optional(),
      enabled: monitorFields.enabled.optional(),
      scheduleKind: monitorFields.scheduleKind.optional(),
      scheduleValue: monitorFields.scheduleValue.optional(),
      devicePreset: monitorFields.devicePreset.optional(),
      viewportWidth: monitorFields.viewportWidth.optional(),
      viewportHeight: monitorFields.viewportHeight.optional(),
      fullPage: monitorFields.fullPage.optional(),
      waitStrategy: monitorFields.waitStrategy.optional(),
      waitSelector: monitorFields.waitSelector.optional(),
      extraDelayMs: monitorFields.extraDelayMs.optional(),
      captureSelector: monitorFields.captureSelector.optional(),
      ignoreSelectors: monitorFields.ignoreSelectors.optional(),
      userAgent: monitorFields.userAgent.optional(),
      changeThreshold: monitorFields.changeThreshold.optional(),
      detectText: monitorFields.detectText.optional(),
      detectHtml: monitorFields.detectHtml.optional(),
      retentionDays: monitorFields.retentionDays.optional(),
      headers: monitorFields.headers.optional(),
      cookies: monitorFields.cookies.optional(),
      channelIds: monitorFields.channelIds.optional(),
    })
    .superRefine(refineWaitSelector)
    .superRefine(refineSchedule(minIntervalMinutes));
}

export const monitorDefaults: z.output<ReturnType<typeof monitorCreateSchema>> =
  monitorCreateSchema(0).parse({ name: 'New monitor', url: 'https://example.com' });

export type MonitorDefaults = typeof monitorDefaults;

export const monitorListQuerySchema = paginationSchema.extend({
  status: z.enum(['ok', 'changed', 'failing', 'paused', 'all']).default('all'),
  tag: z.string().trim().min(1).max(LIMITS.tagMax).optional(),
  q: z.string().trim().min(1).max(LIMITS.nameMax).optional(),
});

export type MonitorListQuery = z.output<typeof monitorListQuerySchema>;
export type MonitorCreateInput = z.input<ReturnType<typeof monitorCreateSchema>>;
export type MonitorUpdateInput = z.input<ReturnType<typeof monitorUpdateSchema>>;

const webhookConfigSchema = z.object({
  url: httpUrlSchema,
  secret: z.string().min(8).max(512).optional(),
});

const slackConfigSchema = z.object({
  url: httpUrlSchema,
});

const emailConfigSchema = z.object({
  to: z.array(emailSchema).min(1).max(20),
  subject: z.string().trim().max(300).optional(),
});

export const channelConfigSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('webhook'), config: webhookConfigSchema }),
  z.object({ type: z.literal('slack'), config: slackConfigSchema }),
  z.object({ type: z.literal('email'), config: emailConfigSchema }),
]);

export const channelCreateSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('webhook'),
    name: z.string().trim().min(1).max(LIMITS.nameMax),
    enabled: z.boolean().default(true),
    config: webhookConfigSchema,
  }),
  z.object({
    type: z.literal('slack'),
    name: z.string().trim().min(1).max(LIMITS.nameMax),
    enabled: z.boolean().default(true),
    config: slackConfigSchema,
  }),
  z.object({
    type: z.literal('email'),
    name: z.string().trim().min(1).max(LIMITS.nameMax),
    enabled: z.boolean().default(true),
    config: emailConfigSchema,
  }),
]);

export const channelUpdateSchema = z.object({
  name: z.string().trim().min(1).max(LIMITS.nameMax).optional(),
  enabled: z.boolean().optional(),
  type: z.enum(CHANNEL_TYPES).optional(),
  config: z.union([webhookConfigSchema, slackConfigSchema, emailConfigSchema]).optional(),
});

export const channelTestSchema = z.object({
  message: z.string().trim().max(500).optional(),
});

export type ChannelCreateInput = z.input<typeof channelCreateSchema>;
export type ChannelUpdateInput = z.input<typeof channelUpdateSchema>;

export const loginSchema = z.object({
  username: z.string().trim().min(1).max(200),
  password: z.string().min(1).max(512),
});

export const apiTokenCreateSchema = z.object({
  name: z.string().trim().min(1).max(LIMITS.nameMax),
  expiresInDays: z.number().int().min(1).max(3650).nullable().default(null),
});

export const shareCreateSchema = z.object({
  expiresInHours: z.number().int().min(1).max(8760).nullable().default(null),
});

export const snapshotListQuerySchema = paginationSchema.extend({
  status: z.enum(['success', 'failed', 'all']).default('all'),
});

export const changeListQuerySchema = paginationSchema.extend({
  significant: z.enum(['true', 'false', 'all']).default('all'),
});

export const compareQuerySchema = z.object({
  a: uuidSchema,
  b: uuidSchema,
  store: z.enum(['true', 'false']).default('false'),
});

export type CompareQuery = z.output<typeof compareQuerySchema>;

export function describeSchedule(scheduleKind: 'preset' | 'cron', scheduleValue: string): string {
  if (scheduleKind === 'preset') {
    const labels: Record<string, string> = {
      '15m': 'Every 15 minutes',
      '1h': 'Every hour',
      '6h': 'Every 6 hours',
      '24h': 'Every day at 00:00 UTC',
      '7d': 'Every week on Sunday at 00:00 UTC',
    };
    return labels[scheduleValue] ?? scheduleValue;
  }
  return describeCron(scheduleValue);
}

export const errorResponseSchema = z.object({
  error: z.object({
    code: z.string(),
    message: z.string(),
    details: z.unknown().optional(),
  }),
});

export type ErrorResponseBody = z.output<typeof errorResponseSchema>;
