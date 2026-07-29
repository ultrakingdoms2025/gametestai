import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

const ALG     = 'aes-256-gcm';
const KEY_LEN = 32;  // 256 bits
const IV_LEN  = 12;  // 96 bits (GCM standard)

function getKey(): Buffer {
  const raw = process.env.ENCRYPTION_KEY;
  if (!raw) throw new Error('ENCRYPTION_KEY env var is not set');
  const buf = Buffer.from(raw, 'base64');
  if (buf.length !== KEY_LEN)
    throw new Error(`ENCRYPTION_KEY must be exactly ${KEY_LEN} bytes (base64-encoded)`);
  return buf;
}

/**
 * Encrypt plaintext with AES-256-GCM.
 * Returns "iv_hex:ciphertext_hex:tag_hex".
 */
export function encrypt(plaintext: string): string {
  const key = getKey();
  const iv  = randomBytes(IV_LEN);
  const cipher = createCipheriv(ALG, key, iv);
  const ct  = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${iv.toString('hex')}:${ct.toString('hex')}:${tag.toString('hex')}`;
}

/**
 * Decrypt a value produced by encrypt(). Throws on auth failure.
 */
export function decrypt(encoded: string): string {
  const key   = getKey();
  const parts = encoded.split(':');
  if (parts.length !== 3) throw new Error('Invalid encrypted payload format');
  const [ivHex, ctHex, tagHex] = parts;
  const iv  = Buffer.from(ivHex,  'hex');
  const ct  = Buffer.from(ctHex,  'hex');
  const tag = Buffer.from(tagHex, 'hex');
  const decipher = createDecipheriv(ALG, key, iv);
  decipher.setAuthTag(tag);
  return decipher.update(ct) + decipher.final('utf8');
}

export function encryptMaybe(v: string | null | undefined): string | null {
  return v ? encrypt(v) : null;
}

export function decryptMaybe(v: string | null | undefined): string | null {
  if (!v) return null;
  try { return decrypt(v); } catch { return null; }
}