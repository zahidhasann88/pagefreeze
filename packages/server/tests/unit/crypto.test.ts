import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  SecretError,
  StaticKeyProvider,
  constantTimeEqual,
  decryptJson,
  decryptString,
  encryptJson,
  encryptString,
  randomTokenHex,
  randomTokenUrl,
  sha256Hex,
} from '../../src/crypto/secrets.js';
import { hashPassword, verifyPassword } from '../../src/crypto/password.js';

const key = () => new StaticKeyProvider(randomBytes(32));

describe('StaticKeyProvider', () => {
  it('requires exactly 32 bytes', () => {
    expect(() => new StaticKeyProvider(randomBytes(16))).toThrow(SecretError);
    expect(() => new StaticKeyProvider(randomBytes(31))).toThrow(SecretError);
    expect(() => new StaticKeyProvider(randomBytes(33))).toThrow(SecretError);
    expect(() => new StaticKeyProvider(randomBytes(32))).not.toThrow();
  });

  it('returns the same key material', () => {
    const material = randomBytes(32);
    expect(new StaticKeyProvider(material).key()).toBe(material);
  });
});

describe('AES-256-GCM round trip', () => {
  it('encrypts and decrypts a string', () => {
    const provider = key();
    const plaintext = 'Bearer super-secret-token';
    const blob = encryptString(plaintext, provider);

    expect(blob).not.toBe(plaintext);
    expect(blob).not.toContain('super-secret');
    expect(decryptString(blob, provider)).toBe(plaintext);
  });

  it('handles unicode, empty strings and long values', () => {
    const provider = key();
    for (const value of ['', 'a', 'héllo wörld — 日本語 🎉', 'x'.repeat(100_000)]) {
      expect(decryptString(encryptString(value, provider), provider)).toBe(value);
    }
  });

  it('round-trips JSON structures', () => {
    const provider = key();
    const headers = { Authorization: 'Bearer abc', 'X-Custom': 'value with "quotes"' };
    const blob = encryptJson(headers, provider);

    expect(blob).not.toContain('Bearer abc');
    expect(decryptJson(blob, provider)).toEqual(headers);
  });

  it('returns null for a null or empty blob', () => {
    const provider = key();
    expect(decryptJson(null, provider)).toBeNull();
    expect(decryptJson(undefined, provider)).toBeNull();
    expect(decryptJson('', provider)).toBeNull();
  });

  it('produces a different ciphertext every time (random IV)', () => {
    const provider = key();
    const a = encryptString('same plaintext', provider);
    const b = encryptString('same plaintext', provider);

    expect(a).not.toBe(b);
    expect(decryptString(a, provider)).toBe('same plaintext');
    expect(decryptString(b, provider)).toBe('same plaintext');
  });

  it('writes the PFZ1 envelope so a wrong key gives a clear error', () => {
    const provider = key();
    const blob = encryptString('value', provider);
    expect(Buffer.from(blob, 'base64').subarray(0, 4).toString('ascii')).toBe('PFZ1');
  });

  it('fails authentication with a different key', () => {
    const blob = encryptString('secret', key());
    expect(() => decryptString(blob, key())).toThrow(SecretError);
    expect(() => decryptString(blob, key())).toThrow(/wrong PAGEFREEZE_SECRET_KEY/);
  });

  it('detects tampering with the ciphertext', () => {
    const provider = key();
    const blob = encryptString('secret value', provider);
    const raw = Buffer.from(blob, 'base64');
    // Flip a bit in the last byte (part of the ciphertext).
    raw[raw.length - 1] = (raw[raw.length - 1] ?? 0) ^ 0x01;
    expect(() => decryptString(raw.toString('base64'), provider)).toThrow(SecretError);
  });

  it('detects tampering with the auth tag', () => {
    const provider = key();
    const raw = Buffer.from(encryptString('secret', provider), 'base64');
    // The tag sits at bytes 16..31 (after the 4-byte magic and 12-byte IV).
    raw[20] = (raw[20] ?? 0) ^ 0xff;
    expect(() => decryptString(raw.toString('base64'), provider)).toThrow(SecretError);
  });

  it('rejects a blob with an unrecognised magic prefix', () => {
    const provider = key();
    const bogus = Buffer.concat([Buffer.from('XXXX'), randomBytes(60)]).toString('base64');
    expect(() => decryptString(bogus, provider)).toThrow(/unrecognised format/);
  });

  it('rejects a truncated blob', () => {
    const provider = key();
    expect(() => decryptString(Buffer.from('PFZ1short').toString('base64'), provider)).toThrow(
      /truncated/,
    );
  });

  it('rejects non-JSON content when decryptJson is used', () => {
    const provider = key();
    const blob = encryptString('not json at all', provider);
    expect(() => decryptJson(blob, provider)).toThrow(/valid JSON/);
  });
});

describe('sha256Hex and constant-time comparison', () => {
  it('hashes deterministically', () => {
    expect(sha256Hex('abc')).toBe(sha256Hex('abc'));
    expect(sha256Hex('abc')).not.toBe(sha256Hex('abd'));
    expect(sha256Hex('abc')).toMatch(/^[0-9a-f]{64}$/);
  });

  it('accepts buffers', () => {
    expect(sha256Hex(Buffer.from('abc'))).toBe(sha256Hex('abc'));
  });

  it('compares equal strings', () => {
    expect(constantTimeEqual('token', 'token')).toBe(true);
  });

  it('rejects different strings of the same length', () => {
    expect(constantTimeEqual('token', 'tokem')).toBe(false);
  });

  it('rejects different lengths without throwing', () => {
    expect(constantTimeEqual('short', 'muchlonger')).toBe(false);
    expect(constantTimeEqual('', 'x')).toBe(false);
  });
});

describe('token generation', () => {
  it('produces url-safe, unique tokens', () => {
    const tokens = new Set(Array.from({ length: 200 }, () => randomTokenUrl(32)));
    expect(tokens.size).toBe(200);
    for (const token of tokens) {
      expect(token).toMatch(/^[A-Za-z0-9_-]+$/);
      expect(token.length).toBeGreaterThan(40);
    }
  });

  it('produces hex tokens of the requested byte length', () => {
    expect(randomTokenHex(16)).toMatch(/^[0-9a-f]{32}$/);
    expect(randomTokenHex(32)).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('scrypt password hashing', () => {
  it('verifies the correct password', async () => {
    const hash = await hashPassword('correct horse battery staple');
    await expect(verifyPassword('correct horse battery staple', hash)).resolves.toBe(true);
  });

  it('rejects the wrong password', async () => {
    const hash = await hashPassword('correct horse battery staple');
    await expect(verifyPassword('wrong password', hash)).resolves.toBe(false);
  });

  it('salts, so the same password hashes differently each time', async () => {
    const a = await hashPassword('same-password');
    const b = await hashPassword('same-password');
    expect(a).not.toBe(b);
    await expect(verifyPassword('same-password', a)).resolves.toBe(true);
    await expect(verifyPassword('same-password', b)).resolves.toBe(true);
  });

  it('stores the algorithm and parameters in the hash', async () => {
    const hash = await hashPassword('x');
    const parts = hash.split('$');
    expect(parts[0]).toBe('scrypt');
    expect(Number.parseInt(parts[1] ?? '', 10)).toBeGreaterThan(1024);
  });

  it('fails closed on malformed stored hashes', async () => {
    for (const malformed of ['', 'nonsense', 'scrypt$1$2', 'bcrypt$abc', 'scrypt$x$y$z$a$b']) {
      await expect(verifyPassword('anything', malformed)).resolves.toBe(false);
    }
  });

  it('handles an empty password without throwing', async () => {
    const hash = await hashPassword('');
    await expect(verifyPassword('', hash)).resolves.toBe(true);
    await expect(verifyPassword('x', hash)).resolves.toBe(false);
  });

  it('handles a long password', async () => {
    const long = 'a'.repeat(2000);
    const hash = await hashPassword(long);
    await expect(verifyPassword(long, hash)).resolves.toBe(true);
  }, 30_000);
});
