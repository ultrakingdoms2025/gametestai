import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * TOTP (RFC 6238), no external dependency.
 *
 * ── Why this is a module and not a helper inside a route ──────────────────
 *
 * It used to live entirely inside `app/api/auth/setup-2fa/route.ts`, unexported.
 * The consequence was not a style problem. `authorize()` in `lib/auth.ts` had no
 * way to reach `verifyTotp`, so it never checked a second factor at all: it
 * verified the password and returned the user. Meanwhile the account page
 * rendered "✓ 2FA is enabled on your account" and the setup flow reported
 * "Two-factor authentication is now enabled."
 *
 * So every user who turned 2FA on was told they had a second factor and did not
 * have one. That is worse than not offering it, because someone may reuse a
 * password on the strength of the assurance.
 *
 * Setup and sign-in have to share one implementation for the feature to mean
 * anything, which is what this file is for.
 */

const CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function base32Encode(buf: Buffer): string {
  let bits = 0, value = 0, output = '';
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      output += CHARS[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) output += CHARS[(value << (5 - bits)) & 31];
  return output;
}

export function base32Decode(input: string): Buffer {
  let bits = 0, value = 0;
  const output: number[] = [];
  for (const char of input.toUpperCase().replace(/=+$/, '')) {
    const idx = CHARS.indexOf(char);
    if (idx === -1) continue;
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) { output.push((value >>> (bits - 8)) & 255); bits -= 8; }
  }
  return Buffer.from(output);
}

/** The code for the current 30-second step, offset by `window` steps. */
export function totp(secret: string, window = 0): string {
  const key = base32Decode(secret);
  const counter = Math.floor(Date.now() / 30000) + window;
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64BE(BigInt(counter));
  const hmac = createHmac('sha1', key).update(buf).digest();
  const offset = hmac[hmac.length - 1] & 0x0f;
  const code =
    ((hmac[offset] & 0x7f) << 24
      | hmac[offset + 1] << 16
      | hmac[offset + 2] << 8
      | hmac[offset + 3]) % 1000000;
  return code.toString().padStart(6, '0');
}

/**
 * Accept a code from the previous, current or next step.
 *
 * One step either side absorbs ordinary clock drift between the phone and the
 * server. Comparison is constant-time: a code is a shared secret for thirty
 * seconds, and an early-exit compare leaks how much of a guess was right.
 */
export function verifyTotp(secret: string, token: string): boolean {
  const given = String(token ?? '').trim();
  if (!/^\d{6}$/.test(given) || !secret) return false;
  const gb = Buffer.from(given, 'utf8');
  let ok = false;
  for (let w = -1; w <= 1; w++) {
    const eb = Buffer.from(totp(secret, w), 'utf8');
    // No early return: every window is compared, so the time taken says nothing
    // about which one matched.
    if (eb.length === gb.length && timingSafeEqual(eb, gb)) ok = true;
  }
  return ok;
}

export function generateTotpSecret(): string {
  return base32Encode(randomBytes(20));
}
