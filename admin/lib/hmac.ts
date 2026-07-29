import { createHmac, createHash, timingSafeEqual } from 'node:crypto';

function secret(): string {
  const s = process.env.HMAC_SECRET;
  if (!s) throw new Error('HMAC_SECRET env var is not set');
  return s;
}

/** HMAC-SHA256 hex digest. */
export function sign(data: string): string {
  return createHmac('sha256', secret()).update(data, 'utf8').digest('hex');
}

/** Timing-safe HMAC verification. */
export function verify(data: string, sig: string): boolean {
  try {
    const a = Buffer.from(sign(data), 'hex');
    const b = Buffer.from(sig,        'hex');
    return a.length === b.length && timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

/** SHA-256 hash for searchable-but-private fields (e.g. email lookup). */
export function sha256(input: string): string {
  return createHash('sha256')
    .update(input.toLowerCase().trim())
    .digest('hex');
}

/**
 * HMAC over a single audit entry.
 * Binds sequence number, actor, action, resource, and the previous
 * entry's hash into one unforgeable digest — if any row is edited or
 * deleted, every subsequent hash in the chain breaks.
 */
export function auditHash(
  seq:      number,
  actor:    string,
  action:   string,
  resource: string,
  prevHash: string,
): string {
  return sign([seq, actor, action, resource, prevHash].join('|'));
}