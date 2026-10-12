import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  timingSafeEqual,
} from 'node:crypto';

/**
 * AES-256-GCM envelope encryption for data at rest.
 *
 * Wire format (base64 of): `PFZ1` | iv(12) | tag(16) | ciphertext
 *
 * Limitations (documented in README / docs/security.md):
 *  - There is no key id and therefore no built-in key rotation. Rotating
 *    PAGEFREEZE_SECRET_KEY requires re-encrypting the stored blobs; see
 *    `docs/security.md` for the procedure.
 *  - No additional authenticated data is used, so a blob can in theory be moved
 *    between rows without detection. This is acceptable for the current
 *    single-tenant model.
 */

const MAGIC = Buffer.from('PFZ1', 'ascii');
const IV_LENGTH = 12;
const TAG_LENGTH = 16;

export class SecretError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SecretError';
  }
}
export interface KeyProvider {
  key(): Buffer;
}

export class StaticKeyProvider implements KeyProvider {
  constructor(private readonly keyMaterial: Buffer) {
    if (keyMaterial.length !== 32) {
      throw new SecretError('AES-256-GCM requires a 32 byte key');
    }
  }

  key(): Buffer {
    return this.keyMaterial;
  }
}

export function encryptString(plaintext: string, provider: KeyProvider): string {
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv('aes-256-gcm', provider.key(), iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([MAGIC, iv, tag, ciphertext]).toString('base64');
}

export function decryptString(blob: string, provider: KeyProvider): string {
  let raw: Buffer;
  try {
    raw = Buffer.from(blob, 'base64');
  } catch {
    throw new SecretError('stored secret is not valid base64');
  }

  if (raw.length < MAGIC.length + IV_LENGTH + TAG_LENGTH) {
    throw new SecretError('stored secret is truncated');
  }
  if (!timingSafeEqual(raw.subarray(0, MAGIC.length), MAGIC)) {
    throw new SecretError('stored secret has an unrecognised format');
  }

  const iv = raw.subarray(MAGIC.length, MAGIC.length + IV_LENGTH);
  const tag = raw.subarray(MAGIC.length + IV_LENGTH, MAGIC.length + IV_LENGTH + TAG_LENGTH);
  const ciphertext = raw.subarray(MAGIC.length + IV_LENGTH + TAG_LENGTH);

  const decipher = createDecipheriv('aes-256-gcm', provider.key(), iv);
  decipher.setAuthTag(tag);
  try {
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
  } catch {
    throw new SecretError('stored secret failed authentication (wrong PAGEFREEZE_SECRET_KEY?)');
  }
}

export function encryptJson(value: unknown, provider: KeyProvider): string {
  return encryptString(JSON.stringify(value ?? null), provider);
}

export function decryptJson<T>(blob: string | null | undefined, provider: KeyProvider): T | null {
  if (blob === null || blob === undefined || blob === '') return null;
  const text = decryptString(blob, provider);
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new SecretError('stored secret does not contain valid JSON');
  }
}

export function sha256Hex(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

export function constantTimeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a, 'utf8');
  const bufB = Buffer.from(b, 'utf8');
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

export function randomTokenUrl(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}

export function randomTokenHex(bytes = 32): string {
  return randomBytes(bytes).toString('hex');
}
