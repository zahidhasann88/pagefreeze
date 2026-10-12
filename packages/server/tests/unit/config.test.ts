import { randomBytes } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  isDefaultAdminPassword,
  loadConfig,
  redactDatabaseUrl,
  redactedConfig,
} from '../../src/config.js';
import { LocalStorageProvider } from '../../src/storage/local.js';
import { DIFF_IMAGE_KEY, HTML_KEY, SCREENSHOT_KEY, TEXT_KEY } from '../../src/storage/types.js';
import {
  decodeCursor,
  decodeTimeIdCursor,
  encodeCursor,
  encodeTimeIdCursor,
} from '../../src/db/cursor.js';

const KEY = randomBytes(32).toString('base64');

const baseEnv = {
  NODE_ENV: 'development',
  DATABASE_URL: 'postgres://user:pass@127.0.0.1:5432/pagefreeze',
  PAGEFREEZE_SECRET_KEY: KEY,
  PAGEFREEZE_ADMIN_PASSWORD: 'a-strong-unique-password',
};

const tempDirs: string[] = [];
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'pagefreeze-config-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

describe('loadConfig', () => {
  it('applies documented defaults', () => {
    const config = loadConfig({ overrides: baseEnv, skipSecretPersistence: true });

    expect(config.mode).toBe('all');
    expect(config.host).toBe('0.0.0.0');
    expect(config.port).toBe(8080);
    expect(config.captureConcurrency).toBe(2);
    expect(config.captureTimeoutMs).toBe(60_000);
    expect(config.captureRetries).toBe(2);
    expect(config.minIntervalMinutes).toBe(15);
    expect(config.failureNotifyThreshold).toBe(3);
    expect(config.retentionDays).toBe(90);
    expect(config.diffPixelThreshold).toBe(0.1);
    expect(config.allowPrivateTargets).toBe(false);
    expect(config.blockMedia).toBe(true);
    expect(config.userAgent).toMatch(/^Pagefreeze\//);
    expect(config.secretKey).toHaveLength(32);
  });

  it('reads every override', () => {
    const config = loadConfig({
      overrides: {
        ...baseEnv,
        PAGEFREEZE_MODE: 'worker',
        PORT: '9090',
        HOST: '127.0.0.1',
        PAGEFREEZE_CAPTURE_CONCURRENCY: '4',
        PAGEFREEZE_CAPTURE_TIMEOUT_MS: '30000',
        PAGEFREEZE_CAPTURE_RETRIES: '0',
        PAGEFREEZE_MIN_INTERVAL_MINUTES: '60',
        PAGEFREEZE_FAILURE_NOTIFY_THRESHOLD: '5',
        PAGEFREEZE_RETENTION_DAYS: '30',
        PAGEFREEZE_DIFF_PIXEL_THRESHOLD: '0.25',
        PAGEFREEZE_DIFF_WORKER: 'false',
        ALLOW_PRIVATE_TARGETS: 'true',
        PAGEFREEZE_BLOCK_MEDIA: 'false',
        PAGEFREEZE_ALLOWED_HOSTS: 'a.example.com, b.example.com:8080 ,,c.example.com',
        LOG_LEVEL: 'debug',
        PAGEFREEZE_USER_AGENT: 'CustomAgent/1.0',
        SMTP_HOST: 'smtp.example.com',
        SMTP_PORT: '465',
        SMTP_SECURE: 'true',
      },
      skipSecretPersistence: true,
    });

    expect(config.mode).toBe('worker');
    expect(config.port).toBe(9090);
    expect(config.host).toBe('127.0.0.1');
    expect(config.captureConcurrency).toBe(4);
    expect(config.captureTimeoutMs).toBe(30_000);
    expect(config.captureRetries).toBe(0);
    expect(config.minIntervalMinutes).toBe(60);
    expect(config.failureNotifyThreshold).toBe(5);
    expect(config.retentionDays).toBe(30);
    expect(config.diffPixelThreshold).toBe(0.25);
    expect(config.diffUseWorker).toBe(false);
    expect(config.allowPrivateTargets).toBe(true);
    expect(config.blockMedia).toBe(false);
    expect(config.allowedHosts).toEqual(['a.example.com', 'b.example.com:8080', 'c.example.com']);
    expect(config.logLevel).toBe('debug');
    expect(config.userAgent).toBe('CustomAgent/1.0');
    expect(config.smtpHost).toBe('smtp.example.com');
    expect(config.smtpPort).toBe(465);
    expect(config.smtpSecure).toBe(true);
  });

  it('accepts the documented boolean spellings', () => {
    for (const value of ['true', '1', 'yes']) {
      const config = loadConfig({
        overrides: { ...baseEnv, ALLOW_PRIVATE_TARGETS: value },
        skipSecretPersistence: true,
      });
      expect(config.allowPrivateTargets, value).toBe(true);
    }
    for (const value of ['false', '0', 'no']) {
      const config = loadConfig({
        overrides: { ...baseEnv, ALLOW_PRIVATE_TARGETS: value },
        skipSecretPersistence: true,
      });
      expect(config.allowPrivateTargets, value).toBe(false);
    }
  });

  it('rejects a secret key that is not 32 bytes', () => {
    expect(() =>
      loadConfig({
        overrides: { ...baseEnv, PAGEFREEZE_SECRET_KEY: randomBytes(16).toString('base64') },
        skipSecretPersistence: true,
      }),
    ).toThrow(/exactly 32 bytes/);
  });

  it('requires a secret key in production', () => {
    expect(() =>
      loadConfig({
        overrides: { ...baseEnv, NODE_ENV: 'production', PAGEFREEZE_SECRET_KEY: undefined },
        skipSecretPersistence: true,
      }),
    ).toThrow(/PAGEFREEZE_SECRET_KEY is required in production/);
  });

  it('refuses to start in production with an empty admin password', () => {
    expect(() =>
      loadConfig({
        overrides: { ...baseEnv, NODE_ENV: 'production', PAGEFREEZE_ADMIN_PASSWORD: '' },
        skipSecretPersistence: true,
      }),
    ).toThrow(/PAGEFREEZE_ADMIN_PASSWORD must be set/);
  });

  it('refuses to start in production with the default admin password', () => {
    for (const password of ['changeme', 'admin', 'password', 'pagefreeze']) {
      expect(
        () =>
          loadConfig({
            overrides: { ...baseEnv, NODE_ENV: 'production', PAGEFREEZE_ADMIN_PASSWORD: password },
            skipSecretPersistence: true,
          }),
        password,
      ).toThrow(/still the default value/);
    }
  });

  it('allows a development instance to run with the fallback password', () => {
    const config = loadConfig({
      overrides: { ...baseEnv, PAGEFREEZE_ADMIN_PASSWORD: '' },
      skipSecretPersistence: true,
    });
    expect(config.adminPassword).toBe('pagefreeze');
  });

  it('rejects an unknown mode and out-of-range numbers', () => {
    expect(() =>
      loadConfig({
        overrides: { ...baseEnv, PAGEFREEZE_MODE: 'sideways' },
        skipSecretPersistence: true,
      }),
    ).toThrow(/Invalid configuration/);
    expect(() =>
      loadConfig({ overrides: { ...baseEnv, PORT: '999999' }, skipSecretPersistence: true }),
    ).toThrow(/Invalid configuration/);
    expect(() =>
      loadConfig({
        overrides: { ...baseEnv, PAGEFREEZE_CAPTURE_CONCURRENCY: '0' },
        skipSecretPersistence: true,
      }),
    ).toThrow(/Invalid configuration/);
  });

  it('generates and persists a development key when none is supplied', () => {
    const dir = tempDir();
    const first = loadConfig({
      overrides: { ...baseEnv, PAGEFREEZE_SECRET_KEY: undefined, PAGEFREEZE_DATA_DIR: dir },
    });
    expect(first.secretKey).toHaveLength(32);

    const keyFile = join(dir, '.dev-secret-key');
    expect(readFileSync(keyFile, 'utf8').trim()).toBe(first.secretKey.toString('base64'));

    const second = loadConfig({
      overrides: { ...baseEnv, PAGEFREEZE_SECRET_KEY: undefined, PAGEFREEZE_DATA_DIR: dir },
    });
    expect(second.secretKey.equals(first.secretKey)).toBe(true);
  });

  it('regenerates when the persisted key file is corrupt', () => {
    const dir = tempDir();
    writeFileSync(join(dir, '.dev-secret-key'), 'not base64 of 32 bytes');
    const config = loadConfig({
      overrides: { ...baseEnv, PAGEFREEZE_SECRET_KEY: undefined, PAGEFREEZE_DATA_DIR: dir },
    });
    expect(config.secretKey).toHaveLength(32);
  });
});

describe('isDefaultAdminPassword', () => {
  it('recognises the usual defaults, case and space insensitively', () => {
    expect(isDefaultAdminPassword('changeme')).toBe(true);
    expect(isDefaultAdminPassword('  ChangeMe  ')).toBe(true);
    expect(isDefaultAdminPassword('ADMIN123')).toBe(true);
  });

  it('accepts a real password', () => {
    expect(isDefaultAdminPassword('k7Xp2#mvQ9rL')).toBe(false);
  });
});

describe('redaction', () => {
  it('never exposes secrets in the logged configuration', () => {
    const config = loadConfig({
      overrides: { ...baseEnv, SMTP_PASS: 'smtp-secret', PAGEFREEZE_ADMIN_USERNAME: 'root' },
      skipSecretPersistence: true,
    });

    const redacted = redactedConfig(config);
    const serialised = JSON.stringify(redacted);

    expect(serialised).not.toContain(KEY);
    expect(serialised).not.toContain('a-strong-unique-password');
    expect(serialised).not.toContain('smtp-secret');
    expect(serialised).not.toContain('pass');
    expect(redacted['secretKey']).toContain('32 bytes');
    expect(redacted['adminPassword']).toBe('***');
  });

  it('redacts a database password from a connection string', () => {
    expect(redactDatabaseUrl('postgres://user:s3cret@host:5432/db')).toBe(
      'postgres://user:***@host:5432/db',
    );
    expect(redactDatabaseUrl('postgres://user@host/db')).toBe('postgres://user@host/db');
    expect(redactDatabaseUrl('not a url')).toBe('(unparseable)');
  });
});

describe('LocalStorageProvider', () => {
  it('writes, reads, checks existence and deletes', async () => {
    const storage = new LocalStorageProvider(tempDir());
    const key = 'monitors/m1/snapshots/s1/screenshot.png';

    expect(await storage.exists(key)).toBe(false);
    expect(await storage.get(key)).toBeNull();

    await storage.put(key, Buffer.from('png-bytes'));
    expect(await storage.exists(key)).toBe(true);
    expect((await storage.get(key))?.toString()).toBe('png-bytes');

    await storage.delete(key);
    expect(await storage.exists(key)).toBe(false);
  });

  it('writes strings as utf8', async () => {
    const storage = new LocalStorageProvider(tempDir());
    await storage.put('a/b.txt', 'héllo');
    expect((await storage.get('a/b.txt'))?.toString('utf8')).toBe('héllo');
  });

  it('lists recursively under a prefix with sizes and mtimes', async () => {
    const root = tempDir();
    const storage = new LocalStorageProvider(root);
    await storage.put('monitors/m1/snapshots/s1/screenshot.png', Buffer.alloc(10));
    await storage.put('monitors/m1/snapshots/s1/page.html', 'x'.repeat(20));
    await storage.put('monitors/m2/snapshots/s2/screenshot.png', Buffer.alloc(5));

    const all = await storage.list('monitors/');
    expect(all).toHaveLength(3);
    expect(all.every((object) => object.key.startsWith('monitors/'))).toBe(true);

    const m1 = await storage.list('monitors/m1');
    expect(m1).toHaveLength(2);
    expect(await storage.sizeOf('monitors/m1')).toBe(30);
    expect(await storage.sizeOf('monitors/')).toBe(35);

    expect(await storage.list('monitors/nope')).toEqual([]);
  });

  it('uses forward slashes in keys regardless of platform', async () => {
    const storage = new LocalStorageProvider(tempDir());
    await storage.put('a/b/c.txt', 'x');
    const listed = await storage.list('a');
    expect(listed[0]?.key).toBe('a/b/c.txt');
    expect(listed[0]?.key).not.toContain('\\');
  });

  it('refuses a key that escapes the data directory', async () => {
    const storage = new LocalStorageProvider(tempDir());
    for (const key of ['../escape.txt', 'a/../../escape.txt', '..\\..\\escape.txt']) {
      await expect(storage.put(key, 'x'), key).rejects.toThrow(/escapes the data directory/);
      await expect(storage.get(key), key).rejects.toThrow(/escapes the data directory/);
      expect(() => storage.resolve(key), key).toThrow(/escapes the data directory/);
    }
  });

  it('treats an absolute-looking key as relative to the root, never as a filesystem path', () => {
    const root = tempDir();
    const storage = new LocalStorageProvider(root);

    expect(storage.resolve('/etc/passwd')).toBe(join(root, 'etc/passwd'));
    expect(storage.resolve('./x.txt')).toBe(join(root, 'x.txt'));
  });

  it('refuses an empty key', async () => {
    const storage = new LocalStorageProvider(tempDir());
    await expect(storage.put('', 'x')).rejects.toThrow(/must not be empty/);
  });

  it('prunes directories that become empty', async () => {
    const root = tempDir();
    const storage = new LocalStorageProvider(root);
    await storage.put('monitors/m1/snapshots/s1/page.html', 'x');
    expect(await storage.list('monitors/')).toHaveLength(1);

    await storage.delete('monitors/m1/snapshots/s1/page.html');
    expect(await storage.list('monitors/')).toEqual([]);

    expect(storage.getRoot()).toBe(root);
  });

  it('streams a file for reading', async () => {
    const storage = new LocalStorageProvider(tempDir());
    await storage.put('a/b.png', Buffer.from('streamed'));
    const stream = storage.createReadStream('a/b.png');
    expect(stream).not.toBeNull();

    const chunks: Buffer[] = [];
    for await (const chunk of stream!) chunks.push(chunk as Buffer);
    expect(Buffer.concat(chunks).toString()).toBe('streamed');

    expect(storage.createReadStream('missing.png')).toBeNull();
  });

  it('resolves a key to an absolute path inside the root', () => {
    const root = tempDir();
    const storage = new LocalStorageProvider(root);
    expect(storage.resolve('a/b.png')).toBe(join(root, 'a/b.png'));
    expect(storage.name).toBe('local');
  });

  it('closes without error', async () => {
    await expect(new LocalStorageProvider(tempDir()).close()).resolves.toBeUndefined();
  });
});

describe('storage key builders', () => {
  it('produces stable, monitor-scoped paths', () => {
    expect(SCREENSHOT_KEY('m1', 's1')).toBe('monitors/m1/snapshots/s1/screenshot.png');
    expect(HTML_KEY('m1', 's1')).toBe('monitors/m1/snapshots/s1/page.html');
    expect(TEXT_KEY('m1', 's1')).toBe('monitors/m1/snapshots/s1/page.txt');
    expect(DIFF_IMAGE_KEY('m1', 'c1')).toBe('monitors/m1/changes/c1/diff.png');
  });
});

describe('cursors', () => {
  it('round-trips arbitrary parts', () => {
    const cursor = encodeCursor(['a', 42, null]);
    expect(decodeCursor(cursor)).toEqual(['a', '42', '']);
  });

  it('is opaque base64url', () => {
    const cursor = encodeCursor(['2026-01-01', 'id']);
    expect(cursor).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(cursor).not.toContain('2026-01-01');
  });

  it('round-trips a time+id cursor', () => {
    const at = new Date('2026-03-04T05:06:07.000Z');
    const cursor = encodeTimeIdCursor(at, '12345678-1234-1234-1234-123456789abc');
    expect(decodeTimeIdCursor(cursor)).toEqual({ at, id: '12345678-1234-1234-1234-123456789abc' });
  });

  it('accepts a string timestamp', () => {
    const cursor = encodeTimeIdCursor(
      '2026-03-04T05:06:07.000Z',
      '12345678-1234-1234-1234-123456789abc',
    );
    expect(decodeTimeIdCursor(cursor)?.at.toISOString()).toBe('2026-03-04T05:06:07.000Z');
  });

  it('returns null for a missing or malformed cursor', () => {
    expect(decodeTimeIdCursor(undefined)).toBeNull();
    expect(decodeTimeIdCursor(null)).toBeNull();
    expect(decodeTimeIdCursor('')).toBeNull();
    expect(decodeTimeIdCursor('not-base64!!!')).toBeNull();
    expect(decodeTimeIdCursor(encodeCursor(['only-one-part']))).toBeNull();
    expect(decodeTimeIdCursor(encodeCursor(['not-a-time', 'id']))).toBeNull();
    expect(decodeTimeIdCursor(encodeCursor(['0', 'invalid-uuid']))).toBeNull();
    expect(
      decodeTimeIdCursor(
        encodeCursor(['999999999999999999999', '12345678-1234-1234-1234-123456789abc']),
      ),
    ).toBeNull();
  });

  it('treats a null timestamp as the epoch', () => {
    expect(
      decodeTimeIdCursor(
        encodeTimeIdCursor(null, '12345678-1234-1234-1234-123456789abc'),
      )?.at.getTime(),
    ).toBe(0);
  });
});
