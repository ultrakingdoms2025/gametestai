/**
 * The secrets this app cannot work without, checked once and loudly.
 *
 * ── Why an assertion and not a default ─────────────────────────────────────
 *
 * Because a default is how a secret stops being one. `proxy.ts` used to read
 * `process.env.SESSION_SECRET ?? 'fallback-replace-me-32-chars-!!!'`, so a
 * deployment that had simply forgotten the variable verified admin sessions
 * against a constant published in this repository — while `lib/session.ts`,
 * reading the same variable, correctly threw. Nothing announced the
 * disagreement; the app just worked, wrongly.
 *
 * ── What it does NOT do ────────────────────────────────────────────────────
 *
 * It never prints a value, a prefix, a length or a hash. The message names the
 * variable and the rule it broke, and nothing else: a "helpful" diagnostic that
 * echoes eight characters of a key into a build log is an exfiltration route
 * with good intentions.
 *
 * ── What it cannot check, and who has to ───────────────────────────────────
 *
 * That the values are DIFFERENT per environment. At the time this was written
 * `admin/.env.local`, `admin/.env.production.local` and `site/.env.local` held
 * byte-identical `ENCRYPTION_KEY`, `HMAC_SECRET` and `SESSION_SECRET`, which
 * means a laptop leak forges production admin sessions and decrypts production
 * TOTP secrets. No code can tell one environment's `.env` from another's; the
 * operator has to rotate them, per environment, and the deployment README says
 * so. This file's job is only to make sure a rotation that half-happened fails
 * at once instead of silently downgrading the app.
 */

/** A secret and why 32 characters is the floor for it. */
type Requirement = { name: string; minLength: number; used: string };

/**
 * 32 characters is iron-session's own minimum for the cookie password, and the
 * same floor is applied to the other two so that "long enough to be a key" is
 * one rule rather than three. `ENCRYPTION_KEY` is a base64 32-byte key (44
 * characters) and `HMAC_SECRET` a 64-character hex string, so both clear it
 * comfortably when generated as documented — a value that does not is a value
 * somebody typed.
 */
const REQUIRED: readonly Requirement[] = [
  { name: 'SESSION_SECRET', minLength: 32, used: 'signs and encrypts the admin session cookie' },
  { name: 'ENCRYPTION_KEY', minLength: 32, used: 'encrypts TOTP secrets, player emails and access codes at rest' },
  { name: 'HMAC_SECRET', minLength: 32, used: 'chains the audit log and hashes lookup columns' },
];

/**
 * Throw unless every secret is present and long enough.
 *
 * Returns the list it checked so a caller can log the NAMES it verified —
 * never the values.
 */
export function assertSecrets(): readonly string[] {
  const broken: string[] = [];
  for (const { name, minLength, used } of REQUIRED) {
    const value = process.env[name];
    if (!value) {
      broken.push(`${name} is not set (it ${used})`);
      continue;
    }
    if (value.length < minLength) {
      broken.push(`${name} is shorter than ${minLength} characters (it ${used})`);
    }
  }
  if (broken.length) {
    throw new Error(
      `Refusing to serve with a broken secret configuration:\n  - ${broken.join('\n  - ')}\n`
      + 'Set them per environment — see admin/.env.local.example. Never copy one environment\'s '
      + 'values into another.'
    );
  }
  return REQUIRED.map((r) => r.name);
}

/**
 * The same check, memoised, for hot paths.
 *
 * Deliberately NOT run at module load. A throw at import time takes the whole
 * app down including the pages that could have explained why; thrown at the
 * point of use it fails closed on the protected route and the reason reaches
 * the server log — which is the arrangement `proxy.ts` already settled on for
 * `SESSION_SECRET`.
 */
let checked = false;
export function ensureSecrets(): void {
  if (checked) return;
  assertSecrets();
  checked = true;
}
