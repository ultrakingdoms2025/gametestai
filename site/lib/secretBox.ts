import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

/**
 * AES-256-GCM for secrets at rest, in the same wire format the admin app uses
 * (`iv:ciphertext:tag`, all hex) so one key opens both.
 *
 * ── Why this exists ───────────────────────────────────────────────────────
 *
 * `admin/lib/db.ts` opens with "All sensitive columns (email, Stripe IDs) are
 * encrypted at rest." That was true of the columns it owns and untrue of the
 * database as a whole: `site_users.totp_secret` sat beside them in cleartext,
 * in the same Postgres, and a TOTP secret is worth more than an email address
 * -- it is the second factor itself, so anyone reading it can mint valid codes
 * indefinitely and 2FA stops meaning anything for that account.
 *
 * ── Reading what is already there ─────────────────────────────────────────
 *
 * `open()` accepts plaintext. Every secret written before this file existed is
 * stored raw, and refusing those would silently lock every current 2FA user out
 * of their own account at the next sign-in - trading a confidentiality problem
 * for an availability one, which is a bad trade and an extremely visible one.
 * They are re-sealed on the next write.
 */

const FORMAT = /^[0-9a-f]{24}:[0-9a-f]*:[0-9a-f]{32}$/i;

function key(): Buffer {
  const raw = process.env.ENCRYPTION_KEY;
  if (!raw) throw new Error('ENCRYPTION_KEY env var is not set');
  const buf = Buffer.from(raw, 'base64');
  if (buf.length !== 32) throw new Error('ENCRYPTION_KEY must decode to 32 bytes');
  return buf;
}

/** Seal a value. Null in, null out. */
export function seal(value: string | null | undefined): string | null {
  if (!value) return null;
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key(), iv);
  const ct = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
  return `${iv.toString('hex')}:${ct.toString('hex')}:${cipher.getAuthTag().toString('hex')}`;
}

/**
 * Open a sealed value, or pass through one written before sealing existed.
 *
 * A value that LOOKS sealed but will not open is a real error and is allowed to
 * throw: that is a wrong key or a tampered row, and silently treating the
 * ciphertext as a plaintext secret would be worse than failing.
 */
export function open(stored: string | null | undefined): string | null {
  if (!stored) return null;
  if (!FORMAT.test(stored)) return stored;   // legacy plaintext
  const [ivHex, ctHex, tagHex] = stored.split(':');
  const decipher = createDecipheriv('aes-256-gcm', key(), Buffer.from(ivHex, 'hex'));
  decipher.setAuthTag(Buffer.from(tagHex, 'hex'));
  return Buffer.concat([
    decipher.update(Buffer.from(ctHex, 'hex')),
    decipher.final(),
  ]).toString('utf8');
}

/** True when this value is already sealed, for callers deciding to re-seal. */
export function isSealed(stored: string | null | undefined): boolean {
  return !!stored && FORMAT.test(stored);
}
