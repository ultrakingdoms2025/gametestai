/**
 * Who may administer the marketplace catalogue.
 *
 * ── Why this file exists ───────────────────────────────────────────────────
 *
 * The check this replaces lived in `adminAccess.ts` and read:
 *
 *     if (ADMIN_EMAILS.size === 0) return true;   // "bootstrap-safe default"
 *
 * Neither `ADMIN_EMAILS` nor `MARKETPLACE_ADMIN_EMAILS` was set in production,
 * so that branch was the live one: every signed-in user could create, edit and
 * delete catalogue items, including `cost_buy` and `cost_sell` — the prices of
 * the credit economy. A default that GRANTS access is the wrong direction for a
 * bootstrap; an unconfigured deployment should be unusable, not open.
 *
 * ── Two properties worth keeping ───────────────────────────────────────────
 *
 * 1. **It fails closed.** No configuration means no administrators. The caller
 *    logs the reason for the operator; it is never reported to the client,
 *    because "the allowlist is unconfigured" is a fact about the deployment
 *    that an anonymous caller has not earned.
 *
 * 2. **It reads the environment on every call.** The old set was built once at
 *    module scope, so it froze at cold start and a corrected env var did not
 *    take effect until the next deploy — during which the deployment stayed
 *    open. Parsing a short string costs nothing next to the two database round
 *    trips the calling path already makes.
 *
 * This module imports nothing on purpose. `adminAccess.ts` pulls in next-auth
 * and `pg` at module scope, which will not load in the vitest node environment;
 * keeping the decision here means it can be tested directly.
 */

const SEPARATORS = /[,\n;]+/g;

/** Addresses named by either env var, lower-cased and trimmed. Empty when unset. */
export function adminAllowlist(): ReadonlySet<string> {
  const raw = `${process.env.ADMIN_EMAILS ?? ''};${process.env.MARKETPLACE_ADMIN_EMAILS ?? ''}`;
  return new Set(
    raw
      .split(SEPARATORS)
      .map((entry) => entry.trim().toLowerCase())
      .filter(Boolean)
  );
}

/**
 * True only for an address explicitly named in the allowlist.
 *
 * An empty allowlist denies everyone — see the note above. Comparison is exact
 * after trimming and lower-casing, so a lookalike domain
 * (`owner@example.com.evil.net`) and a substring (`notowner@example.com`) both
 * fail.
 */
export function isAllowedAdminEmail(email: string | null | undefined): boolean {
  if (!email) return false;
  const candidate = email.trim().toLowerCase();
  if (!candidate) return false;

  const allowed = adminAllowlist();
  if (allowed.size === 0) return false;

  return allowed.has(candidate);
}
