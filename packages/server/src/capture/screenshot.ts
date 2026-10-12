import { createHash } from 'node:crypto';

/**
 * Read PNG dimensions straight from the IHDR chunk.
 *
 * Doing this without pngjs keeps the hot path cheap: we already have the bytes, and
 * decoding the whole image just to learn its size would double the memory cost of a
 * full-page screenshot.
 */
export interface PngSize {
  width: number;
  height: number;
}

export function pngSize(buffer: Buffer): PngSize | null {
  // 8-byte signature, then a 4-byte length, 4-byte type ("IHDR"), then the header.
  if (buffer.length < 24) return null;
  if (buffer[0] !== 0x89 || buffer[1] !== 0x50 || buffer[2] !== 0x4e || buffer[3] !== 0x47) {
    return null;
  }
  const type = buffer.subarray(12, 16).toString('ascii');
  if (type !== 'IHDR') return null;

  return {
    width: buffer.readUInt32BE(16),
    height: buffer.readUInt32BE(20),
  };
}

export function sha256(data: Buffer | string): string {
  return createHash('sha256').update(data).digest('hex');
}

/**
 * Content hash used for duplicate detection.
 *
 * The screenshot hash is the primary signal: if two renders produce byte-identical PNGs
 * the page did not change, and no new artefacts need to be stored.
 */
export function contentHash(data: Buffer | string): string {
  return sha256(data);
}
