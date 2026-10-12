import { createHmac, timingSafeEqual } from 'node:crypto';

export const SIGNATURE_HEADER = 'x-pagefreeze-signature';
export const TIMESTAMP_HEADER = 'x-pagefreeze-timestamp';
export const DELIVERY_HEADER = 'x-pagefreeze-delivery';
export const EVENT_HEADER = 'x-pagefreeze-event';

export const REPLAY_TOLERANCE_SECONDS = 300;
export interface SignedHeaders {
  [SIGNATURE_HEADER]?: string;
  [TIMESTAMP_HEADER]: string;
  [DELIVERY_HEADER]: string;
  [EVENT_HEADER]: string;
  'content-type': string;
  'user-agent': string;
}

export function signPayload(secret: string, timestamp: number, body: string): string {
  return createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex');
}

export function buildSignedHeaders(options: {
  secret: string | null;
  timestamp: number;
  body: string;
  deliveryId: string;
  event: string;
  userAgent: string;
}): SignedHeaders {
  const headers: SignedHeaders = {
    [TIMESTAMP_HEADER]: String(options.timestamp),
    [DELIVERY_HEADER]: options.deliveryId,
    [EVENT_HEADER]: options.event,
    'content-type': 'application/json',
    'user-agent': options.userAgent,
  };

  if (options.secret) {
    headers[SIGNATURE_HEADER] = `sha256=${signPayload(
      options.secret,
      options.timestamp,
      options.body,
    )}`;
  }

  return headers;
}

/**
 * Verify a signature the way a receiver should.
 *
 * Constant-time comparison, and the timestamp is checked against a tolerance window so
 * that an old capture cannot be replayed.
 */
export function verifySignature(options: {
  secret: string;
  timestamp: string | number;
  body: string;
  signatureHeader: string;
  nowSeconds?: number;
  toleranceSeconds?: number;
}): { ok: boolean; reason?: string } {
  const tolerance = options.toleranceSeconds ?? REPLAY_TOLERANCE_SECONDS;
  const now = options.nowSeconds ?? Math.floor(Date.now() / 1000);

  const timestamp =
    typeof options.timestamp === 'number'
      ? options.timestamp
      : Number.parseInt(String(options.timestamp), 10);
  if (!Number.isFinite(timestamp)) return { ok: false, reason: 'invalid-timestamp' };

  if (Math.abs(now - timestamp) > tolerance) {
    return { ok: false, reason: 'timestamp-out-of-tolerance' };
  }

  const provided = options.signatureHeader.trim();
  const [scheme, digest] = provided.split('=');
  if (!scheme || !digest) return { ok: false, reason: 'malformed-signature' };
  if (scheme.toLowerCase() !== 'sha256') return { ok: false, reason: 'unsupported-scheme' };

  const expected = signPayload(options.secret, timestamp, options.body);

  const providedBuf = Buffer.from(digest, 'utf8');
  const expectedBuf = Buffer.from(expected, 'utf8');
  if (providedBuf.length !== expectedBuf.length) return { ok: false, reason: 'signature-mismatch' };
  if (!timingSafeEqual(providedBuf, expectedBuf))
    return { ok: false, reason: 'signature-mismatch' };

  return { ok: true };
}
