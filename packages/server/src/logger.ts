import pino, { type Logger } from 'pino';
import { VERSION } from '@pagefreeze/shared';
import type { AppConfig } from './config.js';

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
    timestamp: pino.stdTimeFunctions.isoTime,
    formatters: {
      level: (label) => ({ level: label }),
    },
  });
}

export function createSilentLogger(): Logger {
  return pino({ level: 'silent' });
}
