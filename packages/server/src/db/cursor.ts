export function encodeCursor(parts: Array<string | number | null>): string {
  const payload = parts.map((part) => (part === null || part === undefined ? '' : String(part)));
  return Buffer.from(payload.join('\u0000'), 'utf8').toString('base64url');
}

export function decodeCursor(cursor: string | undefined | null): string[] | null {
  if (!cursor) return null;
  try {
    const decoded = Buffer.from(cursor, 'base64url').toString('utf8');
    if (decoded.length === 0) return null;
    return decoded.split('\u0000');
  } catch {
    return null;
  }
}

export function decodeTimeIdCursor(
  cursor: string | undefined | null,
): { at: Date; id: string } | null {
  const parts = decodeCursor(cursor);
  if (!parts || parts.length < 2) return null;
  const [rawTime, id] = parts;
  if (!rawTime || !id) return null;
  const time = Number.parseInt(rawTime, 10);
  if (
    !/^\d+$/.test(rawTime) ||
    !Number.isFinite(time) ||
    !Number.isFinite(new Date(time).getTime())
  )
    return null;
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) return null;
  return { at: new Date(time), id };
}

export function encodeTimeIdCursor(at: Date | string | null, id: string): string {
  const time = at instanceof Date ? at.getTime() : at ? new Date(at).getTime() : 0;
  return encodeCursor([time, id]);
}
