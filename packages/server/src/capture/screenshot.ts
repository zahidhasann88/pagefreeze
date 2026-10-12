import { createHash } from 'node:crypto';
export interface PngSize {
  width: number;
  height: number;
}

export function pngSize(buffer: Buffer): PngSize | null {
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

export function contentHash(data: Buffer | string): string {
  return sha256(data);
}
