/**
 * The one server-side signing secret, and the refusal that makes it mean
 * something.
 *
 * ── What was wrong ─────────────────────────────────────────────────────────
 *
 * Four separate places reached for a secret and each one had its OWN fallback
 * to a constant published in this repository:
 *
 *   lib/auth.ts:11      `?? 'dev-secret-change-me'`  — the NextAuth JWT key
 *   lib/gameLaunch.ts:5 `|| DEV_SECRET`              — the launch-cookie HMAC
 *   lib/entitlement.ts  `DEV_SECRET`                 — the entitlement HMAC
 *   lib/telemetry.ts    `?? 'dev-secret-change-me'`  — the IP-hash salt
 *
 * A deployment missing the variable therefore signed session tokens with a
 * string anybody can read on GitHub — which is not "degraded", it is "anyone
 * can mint a session for any account". `admin/lib/session.ts` already gets this
 * right (`if (pw.length < 32) throw`), and `admin/proxy.ts` records what
 * happened the last time two files disagreed about whether a secret is
 * optional. This is the site's half of that same rule.
 *
 * ── Why it throws at the point of use, not at import ──────────────────────
 *
 * The same argument `admin/proxy.ts` makes: a module-load throw takes the whole
 * app down, including the pages that need no secret at all, and reports it as a
 * blank page. Throwing where the secret is USED fails the affected request
 * closed and puts the reason in the server log.
 *
 * ── The 32-character floor ────────────────────────────────────────────────
 *
 * Matched to `admin/lib/session.ts` deliberately: one number, in two apps, so
 * neither can be the lenient one. It is also what `.env.example` has always
 * told operators to generate (`randomBytes(32)`), so no correctly-configured
 * deployment is affected by the floor arriving.
 */

/** The floor, shared with `admin/lib/session.ts`. */
export const MIN_SECRET_LENGTH = 32;

/**
 * The signing secret, or a throw.
 *
 * `NEXTAUTH_SECRET` first and `APP_SECRET` second, which is the precedence
 * `lib/auth.ts` and `lib/telemetry.ts` already used; `gameLaunch.ts` had them
 * the other way round, so a deployment that set both signed launch cookies with
 * one and sessions with the other. One order, in one place, ends that.
 */
export function appSecret(): string {
  const raw = process.env.NEXTAUTH_SECRET || process.env.APP_SECRET || '';
  if (raw.length < MIN_SECRET_LENGTH) {
    throw new Error(
      'NEXTAUTH_SECRET (or APP_SECRET) is missing or shorter than '
      + `${MIN_SECRET_LENGTH} characters. Refusing to sign with a fallback: a `
      + 'published constant as a signing key means anyone can mint a session, a '
      + 'launch cookie or a purchase for any account. Generate one with: '
      + 'node -e "console.log(require(\'node:crypto\').randomBytes(32).toString(\'base64url\'))"'
    );
  }
  return raw;
}

/**
 * Whether a usable secret is configured, for callers that must decide rather
 * than fail — `hashIp` nulls its column instead of refusing a telemetry batch.
 * Anything that SIGNS must call `appSecret()` and let it throw.
 */
export function appSecretConfigured(): boolean {
  return (process.env.NEXTAUTH_SECRET || process.env.APP_SECRET || '').length >= MIN_SECRET_LENGTH;
}
