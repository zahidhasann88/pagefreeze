import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { z } from 'zod';
import { VERSION } from '@pagefreeze/shared';

export type ServerMode = 'all' | 'api' | 'worker';

const booleanish = z
  .union([z.boolean(), z.enum(['true', 'false', '1', '0', 'yes', 'no'])])
  .transform((value) =>
    typeof value === 'boolean' ? value : ['true', '1', 'yes'].includes(value),
  );

const numberish = z.coerce.number();

const configSchema = z.object({
  nodeEnv: z.enum(['development', 'production', 'test']).default('development'),
  mode: z.enum(['all', 'api', 'worker']).default('all'),
  host: z.string().min(1).default('0.0.0.0'),
  port: numberish.int().min(1).max(65535).default(8080),

  databaseUrl: z.string().min(1),
  databasePoolMax: numberish.int().min(1).max(100).default(10),
  databaseSsl: booleanish.default(false),

  secretKey: z.instanceof(Buffer).refine((b) => b.length === 32, {
    error: 'secretKey must decode to exactly 32 bytes',
  }),

  adminUsername: z.string().min(1).max(200).default('admin'),
  adminPassword: z.string().min(1).max(512),

  dataDir: z.string().min(1).default('./data'),
  logLevel: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),

  baseUrl: z.string().default(''),

  captureConcurrency: numberish.int().min(1).max(32).default(2),
  captureTimeoutMs: numberish.int().min(5_000).max(600_000).default(60_000),
  captureRetries: numberish.int().min(0).max(10).default(2),
  captureRetryBaseMs: numberish.int().min(100).max(60_000).default(2_000),
  blockMedia: booleanish.default(true),
  blockThirdParty: booleanish.default(false),
  allowPrivateTargets: booleanish.default(false),
  /** Hosts (optionally host:port) exempt from the SSRF address checks. */
  allowedHosts: z
    .string()
    .default('')
    .transform((value) =>
      value
        .split(',')
        .map((entry) => entry.trim().toLowerCase())
        .filter((entry) => entry.length > 0),
    ),
  chromiumArgs: z.string().default(''),
  disableChromiumSandbox: booleanish.default(false),
  maxScreenshotBytes: numberish
    .int()
    .min(1024)
    .max(200 * 1024 * 1024)
    .default(25 * 1024 * 1024),

  minIntervalMinutes: numberish.int().min(0).max(100_000).default(15),
  failureNotifyThreshold: numberish.int().min(1).max(100).default(3),

  diffPixelThreshold: numberish.min(0).max(1).default(0.1),
  diffUseWorker: booleanish.default(true),
  diffRegionPadding: numberish.int().min(0).max(100).default(12),
  diffRegionMinArea: numberish.int().min(1).max(100_000).default(24),

  retentionDays: numberish.int().min(1).max(3650).default(90),
  retentionIntervalHours: numberish.int().min(1).max(720).default(12),

  bodyLimitBytes: numberish
    .int()
    .min(1024)
    .max(10 * 1024 * 1024)
    .default(256 * 1024),
  sessionTtlHours: numberish.int().min(1).max(8760).default(168),
  secureCookies: booleanish.default(false),
  trustProxy: booleanish.default(false),
  corsOrigin: z.string().default(''),

  webhookTimeoutMs: numberish.int().min(500).max(60_000).default(10_000),
  webhookMaxRedirects: numberish.int().min(0).max(5).default(0),

  smtpHost: z.string().default(''),
  smtpPort: numberish.int().min(1).max(65535).default(587),
  smtpSecure: booleanish.default(false),
  smtpUser: z.string().default(''),
  smtpPass: z.string().default(''),
  smtpFrom: z.string().default(''),

  userAgent: z.string().min(1).max(512).default(`Pagefreeze/${VERSION} (+self-hosted)`),

  shutdownGraceMs: numberish.int().min(0).max(600_000).default(30_000),
});

export type AppConfig = z.output<typeof configSchema>;
export interface LoadConfigOptions {
  overrides?: Record<string, string | undefined>;
  skipSecretPersistence?: boolean;
}

/**
 * Reads a base64 encoded 32 byte key. Outside production a missing key is generated
 * once and persisted under the data directory so that secrets encrypted during
 * development and demos survive a restart.
 */
function resolveSecretKey(
  env: Record<string, string | undefined>,
  dataDir: string,
  nodeEnv: string,
  skipPersistence: boolean,
): Buffer {
  const raw = env.PAGEFREEZE_SECRET_KEY?.trim();
  if (raw) {
    let decoded: Buffer;
    try {
      decoded = Buffer.from(raw, 'base64');
    } catch {
      throw new Error('PAGEFREEZE_SECRET_KEY is not valid base64');
    }
    if (decoded.length !== 32) {
      throw new Error(
        `PAGEFREEZE_SECRET_KEY must decode to exactly 32 bytes, got ${decoded.length}. Generate one with: openssl rand -base64 32`,
      );
    }
    return decoded;
  }

  if (nodeEnv === 'production') {
    throw new Error(
      'PAGEFREEZE_SECRET_KEY is required in production. Generate one with: openssl rand -base64 32',
    );
  }

  if (skipPersistence) {
    return randomBytes(32);
  }

  const keyFile = join(dataDir, '.dev-secret-key');
  try {
    if (existsSync(keyFile)) {
      const existing = Buffer.from(readFileSync(keyFile, 'utf8').trim(), 'base64');
      if (existing.length === 32) return existing;
    }
  } catch {
    // fall through and generate a new key
  }

  const generated = randomBytes(32);
  try {
    mkdirSync(dirname(keyFile), { recursive: true });
    writeFileSync(keyFile, generated.toString('base64'), { mode: 0o600 });
  } catch {
    // Non-fatal: the key simply will not survive a restart.
  }
  return generated;
}

export function loadConfig(options: LoadConfigOptions = {}): AppConfig {
  const env: Record<string, string | undefined> = { ...process.env, ...(options.overrides ?? {}) };
  const nodeEnv = (env.NODE_ENV ?? 'development').toLowerCase();
  const isProduction = nodeEnv === 'production';

  const dataDir = env.PAGEFREEZE_DATA_DIR?.trim() || './data';
  const adminPassword = env.PAGEFREEZE_ADMIN_PASSWORD ?? '';

  if (isProduction) {
    if (adminPassword.length === 0) {
      throw new Error('PAGEFREEZE_ADMIN_PASSWORD must be set in production');
    }
    if (isDefaultAdminPassword(adminPassword)) {
      throw new Error(
        'PAGEFREEZE_ADMIN_PASSWORD is still the default value; choose a unique password before starting in production',
      );
    }
  }

  const secretKey = resolveSecretKey(env, dataDir, nodeEnv, options.skipSecretPersistence ?? false);

  const parsed = configSchema.safeParse({
    nodeEnv,
    mode: env.PAGEFREEZE_MODE ?? 'all',
    host: env.HOST ?? '0.0.0.0',
    port: env.PORT ?? '8080',

    databaseUrl: env.DATABASE_URL ?? '',
    databasePoolMax: env.PAGEFREEZE_DB_POOL_MAX ?? '10',
    databaseSsl: env.PAGEFREEZE_DB_SSL ?? 'false',

    secretKey,

    adminUsername: env.PAGEFREEZE_ADMIN_USERNAME ?? 'admin',
    adminPassword: adminPassword.length > 0 ? adminPassword : 'pagefreeze',

    dataDir,
    logLevel: env.LOG_LEVEL ?? 'info',
    baseUrl: env.PAGEFREEZE_BASE_URL ?? '',

    captureConcurrency: env.PAGEFREEZE_CAPTURE_CONCURRENCY ?? '2',
    captureTimeoutMs: env.PAGEFREEZE_CAPTURE_TIMEOUT_MS ?? '60000',
    captureRetries: env.PAGEFREEZE_CAPTURE_RETRIES ?? '2',
    captureRetryBaseMs: env.PAGEFREEZE_CAPTURE_RETRY_BASE_MS ?? '2000',
    blockMedia: env.PAGEFREEZE_BLOCK_MEDIA ?? 'true',
    blockThirdParty: env.PAGEFREEZE_BLOCK_THIRD_PARTY ?? 'false',
    allowPrivateTargets: env.ALLOW_PRIVATE_TARGETS ?? 'false',
    allowedHosts: env.PAGEFREEZE_ALLOWED_HOSTS ?? '',
    chromiumArgs: env.PAGEFREEZE_CHROMIUM_ARGS ?? '',
    disableChromiumSandbox: env.PAGEFREEZE_DISABLE_CHROMIUM_SANDBOX ?? 'false',
    maxScreenshotBytes: env.PAGEFREEZE_MAX_SCREENSHOT_BYTES ?? String(25 * 1024 * 1024),

    minIntervalMinutes: env.PAGEFREEZE_MIN_INTERVAL_MINUTES ?? '15',
    failureNotifyThreshold: env.PAGEFREEZE_FAILURE_NOTIFY_THRESHOLD ?? '3',

    diffPixelThreshold: env.PAGEFREEZE_DIFF_PIXEL_THRESHOLD ?? '0.1',
    diffUseWorker: env.PAGEFREEZE_DIFF_WORKER ?? 'true',
    diffRegionPadding: env.PAGEFREEZE_DIFF_REGION_PADDING ?? '12',
    diffRegionMinArea: env.PAGEFREEZE_DIFF_REGION_MIN_AREA ?? '24',

    retentionDays: env.PAGEFREEZE_RETENTION_DAYS ?? '90',
    retentionIntervalHours: env.PAGEFREEZE_RETENTION_INTERVAL_HOURS ?? '12',

    bodyLimitBytes: env.PAGEFREEZE_BODY_LIMIT ?? String(256 * 1024),
    sessionTtlHours: env.PAGEFREEZE_SESSION_TTL_HOURS ?? '168',
    secureCookies: env.PAGEFREEZE_SECURE_COOKIES ?? (isProduction ? 'true' : 'false'),
    trustProxy: env.PAGEFREEZE_TRUST_PROXY ?? 'false',
    corsOrigin: env.PAGEFREEZE_CORS_ORIGIN ?? '',

    webhookTimeoutMs: env.PAGEFREEZE_WEBHOOK_TIMEOUT_MS ?? '10000',
    webhookMaxRedirects: env.PAGEFREEZE_WEBHOOK_MAX_REDIRECTS ?? '0',

    smtpHost: env.SMTP_HOST ?? '',
    smtpPort: env.SMTP_PORT ?? '587',
    smtpSecure: env.SMTP_SECURE ?? 'false',
    smtpUser: env.SMTP_USER ?? '',
    smtpPass: env.SMTP_PASS ?? '',
    smtpFrom: env.SMTP_FROM ?? '',

    userAgent:
      env.PAGEFREEZE_USER_AGENT ??
      `Pagefreeze/${VERSION} (+https://github.com/zahidhasann88/pagefreeze)`,

    shutdownGraceMs: env.PAGEFREEZE_SHUTDOWN_GRACE_MS ?? '30000',
  });

  if (!parsed.success) {
    const details = parsed.error.issues
      .map((issue) => `  - ${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('\n');
    throw new Error(`Invalid configuration:\n${details}`);
  }

  return parsed.data;
}

const DEFAULT_PASSWORDS = new Set([
  'changeme',
  'change-me',
  'password',
  'admin',
  'admin123',
  'pagefreeze',
  'secret',
  'letmein',
]);

export function isDefaultAdminPassword(password: string): boolean {
  return DEFAULT_PASSWORDS.has(password.trim().toLowerCase());
}

/** Configuration values that are safe to log. Never includes secrets. */
export function redactedConfig(config: AppConfig): Record<string, unknown> {
  const clone: Record<string, unknown> = { ...config };
  clone['secretKey'] = `***(${config.secretKey.length} bytes)`;
  clone['adminPassword'] = '***';
  clone['smtpPass'] = config.smtpPass ? '***' : '';
  clone['databaseUrl'] = redactDatabaseUrl(config.databaseUrl);
  return clone;
}

export function redactDatabaseUrl(url: string): string {
  try {
    const parsed = new URL(url);
    if (parsed.password) parsed.password = '***';
    return parsed.toString();
  } catch {
    return '(unparseable)';
  }
}
