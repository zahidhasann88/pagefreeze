import pino, { type Logger } from 'pino';
import { VERSION } from '@pagefreeze/shared';
import type { AppConfig } from './config.js';

/**
 * Redaction list.
 *
 * These paths are removed from every log line. Monitor headers and cookies are encrypted
 * at rest, but they exist in plaintext in memory while a capture runs, and a stray
 * `logger.debug({ settings })` would write them to disk in the clear. Redaction is the
 * backstop that makes that mistake non-catastrophic.
 */
const REDACT_PATHS = [
  'req.headers.authorization',
  'req.headers.cookie',
  'req.headers["x-csrf-token"]',
  'res.headers["set-cookie"]',
  '*.password',
  '*.secret',
  '*.secretKey',
  '*.headersEnc',
  '*.cookiesEnc',
  '*.configEnc',
  '*.tokenHash',
  '*.csrfToken',
  '*.settings.headers',
  '*.settings.cookies',
  '*.headers',
  '*.cookies',
  '*.config.secret',
  'databaseUrl',
  'adminPassword',
  'smtpPass',
];

export interface CreateLoggerOptions {
  level: AppConfig['logLevel'];
  pretty?: boolean;
  name?: string;
  base?: Record<string, unknown>;
}

export function createLogger(options: CreateLoggerOptions): Logger {
  return pino({
    level: options.level,
    name: options.name ?? 'pagefreeze',
    base: { version: VERSION, ...(options.base ?? {}) },
    redact: { paths: REDACT_PATHS, censor: '[redacted]' },
    // ISO timestamps are easier to correlate with Postgres logs than epoch seconds.
    timestamp: pino.stdTimeFunctions.isoTime,
    formatters: {
      level: (label) => ({ level: label }),
    },
  });
}

/** A logger that discards everything. Used by tests that assert on behaviour, not output. */
export function createSilentLogger(): Logger {
  return pino({ level: 'silent' });
}
