import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { totp, verifyTotp, generateTotpSecret, base32Decode, base32Encode } from './totp';

/**
 * TWO-FACTOR AUTHENTICATION THAT ACTUALLY HAPPENS.
 *
 * ── The defect ────────────────────────────────────────────────────────────
 * `authorize()` in `lib/auth.ts` checked the email and the password and
 * returned the user. It never read `totp_enabled` or `totp_secret` - it could
 * not, because `verifyTotp` was a private function inside
 * `app/api/auth/setup-2fa/route.ts` with no export.
 *
 * Meanwhile the setup flow reported "Two-factor authentication is now enabled"
 * and the account page rendered "✓ 2FA is enabled on your account". So every
 * user who turned it on was told they had a second factor and had exactly one
 * factor, their password. A security control that reports success and does
 * nothing is worse than one that is absent: somebody may reuse a password on
 * the strength of it.
 *
 * ── What is asserted here ─────────────────────────────────────────────────
 * The algorithm, and - because the algorithm was never the broken part - a
 * scrape proving the sign-in path actually consults it. A unit test of
 * `verifyTotp` would have passed happily throughout the entire period the
 * feature did nothing.
 */

describe('totp', () => {
  it('round-trips base32', () => {
    const buf = Buffer.from('the quick brown fox', 'utf8');
    expect(base32Decode(base32Encode(buf)).toString('utf8')).toBe('the quick brown fox');
  });

  it('generates a usable secret', () => {
    const secret = generateTotpSecret();
    expect(secret).toMatch(/^[A-Z2-7]+$/);
    expect(verifyTotp(secret, totp(secret))).toBe(true);
  });

  it('accepts one step either side, for clock drift', () => {
    const secret = generateTotpSecret();
    expect(verifyTotp(secret, totp(secret, -1))).toBe(true);
    expect(verifyTotp(secret, totp(secret, 0))).toBe(true);
    expect(verifyTotp(secret, totp(secret, 1))).toBe(true);
  });

  it('refuses a code from further away', () => {
    const secret = generateTotpSecret();
    expect(verifyTotp(secret, totp(secret, 5))).toBe(false);
    expect(verifyTotp(secret, totp(secret, -5))).toBe(false);
  });

  it('refuses junk without throwing', () => {
    const secret = generateTotpSecret();
    for (const bad of ['', '   ', 'abcdef', '12345', '1234567', '  123456  ']) {
      expect(verifyTotp(secret, bad), `accepted ${JSON.stringify(bad)}`).toBe(false);
    }
    expect(verifyTotp('', '123456')).toBe(false);
  });

  it('two secrets do not accept each other', () => {
    const a = generateTotpSecret();
    const b = generateTotpSecret();
    expect(verifyTotp(a, totp(b))).toBe(false);
  });
});

describe('the sign-in path enforces it', () => {
  const authSrc = () =>
    readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'auth.ts'), 'utf8');

  it('authorize() checks the second factor', () => {
    /* The assertion that would have caught the original defect. Everything in
     * the block above passed for as long as the feature was decorative. */
    const src = authSrc();
    const start = src.indexOf('async authorize(');
    expect(start, 'the credentials authorize() has been renamed').toBeGreaterThan(0);
    const body = src.slice(start, src.indexOf('\n    }),', start));

    expect(body).toMatch(/totp_enabled/);
    expect(body).toMatch(/verifyTotp\(/);
  });

  it('the credentials provider accepts a code field', () => {
    /* Enforcing without somewhere to type it locks out every 2FA user - the
     * opposite failure, and a worse one. */
    expect(authSrc()).toMatch(/code:\s*\{\s*label:/);
  });

  it('the login form sends the code', () => {
    const login = readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), '..', 'app', 'login', 'page.tsx'),
      'utf8'
    );
    const call = login.slice(login.indexOf("signIn('credentials'"));
    expect(call.slice(0, 200)).toMatch(/\bcode,/);
    expect(login).toMatch(/id="code"/);
  });

  it('the failure message does not say which part was wrong', () => {
    /* Distinguishing a bad code from a bad password tells an attacker when they
     * have guessed the password. */
    const login = readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), '..', 'app', 'login', 'page.tsx'),
      'utf8'
    );
    expect(login).not.toMatch(/setError\('Invalid (code|authenticator)/i);
  });
});
