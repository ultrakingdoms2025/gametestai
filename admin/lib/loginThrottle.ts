import { sql } from './sql';
import { sha256 } from './hmac';

/**
 * Login throttling and account lockout, in Postgres.
 *
 * ── What this replaces, and why it was not a limit at all ──────────────────
 *
 * `proxy.ts` held a `Map<string, number[]>` of login attempts keyed on
 * `x-forwarded-for`.split(',')[0]. It was the ONLY control in front of admin
 * password + TOTP guessing, and it had two independent bypasses:
 *
 *   1. The Map lives in one serverless instance's memory. Vercel runs many
 *      concurrent instances and recycles them freely, so the counter resets
 *      whenever the platform feels like it and each cold lambda starts a
 *      fresh allowance. Five attempts per minute per instance is not five
 *      attempts per minute.
 *   2. The LEFTMOST element of `x-forwarded-for` is whatever the CLIENT put
 *      there. An attacker who varies that header has an unlimited supply of
 *      distinct buckets and is never limited at all.
 *
 * So the counter moves to the one place every instance shares, and the key
 * stops being a value the caller chooses:
 *
 *   - the IP comes from `x-real-ip` (set by the platform) or, failing that,
 *     the RIGHTMOST `x-forwarded-for` hop, which is the one the proxy nearest
 *     us appended. Prepending is free; appending is not.
 *   - and every attempt is ALSO counted against the USERNAME, so distributing
 *     a guessing run across a botnet still runs into one account's limit.
 *     This is why it lives in the route handler and not in the proxy: the
 *     proxy cannot see the submitted username without reading the body.
 *
 * ── Lockout ────────────────────────────────────────────────────────────────
 *
 * `audit('auth.login_fail', ...)` already recorded every bad password and bad
 * TOTP. Nothing read those rows, so a failure had no consequence beyond the
 * one-minute window. Consecutive failures now lock the account (and the IP)
 * for {@link LOCKOUT_MINUTES}; a successful login clears the count, so a
 * legitimate operator who fat-fingers their TOTP twice is unaffected.
 *
 * A lockout is deliberately NOT permanent and deliberately NOT reported to the
 * caller in detail — the response says "too many attempts" and the reason goes
 * to the audit chain, so the endpoint cannot be used to enumerate which
 * usernames exist.
 */

/* ---------------------------------------------------------------------- */
/* Tuning                                                                  */
/* ---------------------------------------------------------------------- */

/** Rolling window for the attempt counter. */
export const WINDOW_MS = 60_000;

/** Attempts allowed per subject per window. Was 5, per instance, in proxy.ts. */
export const MAX_ATTEMPTS = 5;

/** Consecutive failures — not attempts — before the subject is locked out. */
export const LOCKOUT_AFTER_FAILURES = 10;

/** How long a lockout lasts. */
export const LOCKOUT_MINUTES = 15;

/* ---------------------------------------------------------------------- */
/* Schema                                                                  */
/* ---------------------------------------------------------------------- */

let schemaPromise: Promise<void> | null = null;

/**
 * Build the table if it is not there.
 *
 * Memoised as a promise rather than a boolean, so two concurrent requests on a
 * cold lambda wait instead of racing, and a rejection clears the memo — the
 * same arrangement `lib/accessCodes.ts` uses, and for the same reason:
 * `initSchema` only runs from the setup scripts, so a deployment that has never
 * been re-set-up must not 500 on the first login.
 */
export function ensureLoginThrottleSchema(): Promise<void> {
  if (!schemaPromise) {
    schemaPromise = (async () => {
      await sql`
        CREATE TABLE IF NOT EXISTS admin_login_throttle (
          scope        TEXT        NOT NULL,
          subject      TEXT        NOT NULL,
          window_start TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          attempts     INTEGER     NOT NULL DEFAULT 0,
          failures     INTEGER     NOT NULL DEFAULT 0,
          locked_until TIMESTAMPTZ,
          updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          PRIMARY KEY (scope, subject)
        )
      `;
      /* Housekeeping only. Rows are tiny and self-healing — a stale one is
       * reset by the next attempt — but an index keeps the sweep below cheap
       * once a scanner has created a few thousand of them. */
      await sql`
        CREATE INDEX IF NOT EXISTS admin_login_throttle_updated_idx
          ON admin_login_throttle (updated_at)
      `;
    })().catch((err) => {
      schemaPromise = null;
      throw err;
    });
  }
  return schemaPromise;
}

/* ---------------------------------------------------------------------- */
/* Subjects                                                                */
/* ---------------------------------------------------------------------- */

/**
 * The caller's address, taken from the hop nearest US.
 *
 * `x-forwarded-for` grows left to right, so element 0 is whatever the client
 * sent and the LAST element is what the proxy in front of this app appended.
 * `x-real-ip` is set by the platform outright and is preferred. Neither is
 * perfect, but neither is a value the caller can vary at will — which is the
 * whole difference between a limit and a formality.
 */
export function clientIp(headers: Headers): string {
  const real = headers.get('x-real-ip')?.trim();
  if (real) return real;
  const chain = headers.get('x-forwarded-for')?.split(',').map((p) => p.trim()).filter(Boolean) ?? [];
  return chain[chain.length - 1] ?? 'unknown';
}

/** The two rows an attempt is counted against. IPs are hashed, as `audit` does. */
function subjectsFor(username: string, ip: string): Array<{ scope: string; subject: string }> {
  return [
    { scope: 'user', subject: username.toLowerCase().trim() },
    { scope: 'ip', subject: sha256(ip) },
  ];
}

/* ---------------------------------------------------------------------- */
/* The counter                                                             */
/* ---------------------------------------------------------------------- */

export type ThrottleVerdict =
  | { allowed: true }
  | { allowed: false; retryAfterSeconds: number; reason: 'rate' | 'locked' };

/**
 * Count this attempt and say whether it may proceed.
 *
 * One statement per subject, and the statement both rolls the window and
 * returns the post-increment state, so two lambdas racing on the same subject
 * cannot both read "4" and both decide they are the fifth.
 *
 * The window boundary is computed here and bound as a timestamp rather than
 * written as an `INTERVAL` literal, because the interval would have to be
 * interpolated into the statement text and this file has no business building
 * SQL out of strings.
 */
export async function noteLoginAttempt(username: string, ip: string): Promise<ThrottleVerdict> {
  await ensureLoginThrottleSchema();
  const since = new Date(Date.now() - WINDOW_MS);
  let verdict: ThrottleVerdict = { allowed: true };

  for (const { scope, subject } of subjectsFor(username, ip)) {
    const { rows } = await sql<{ attempts: number; locked_until: string | null }>`
      INSERT INTO admin_login_throttle (scope, subject, window_start, attempts, updated_at)
      VALUES (${scope}, ${subject}, NOW(), 1, NOW())
      ON CONFLICT (scope, subject) DO UPDATE SET
        window_start = CASE WHEN admin_login_throttle.window_start < ${since}
                            THEN NOW() ELSE admin_login_throttle.window_start END,
        attempts     = CASE WHEN admin_login_throttle.window_start < ${since}
                            THEN 1 ELSE admin_login_throttle.attempts + 1 END,
        updated_at   = NOW()
      RETURNING attempts, locked_until
    `;
    const row = rows[0];
    if (!row) continue;

    const lockedUntil = row.locked_until ? new Date(row.locked_until).getTime() : 0;
    if (lockedUntil > Date.now()) {
      const retry = Math.ceil((lockedUntil - Date.now()) / 1000);
      // A lockout outranks a rate limit: report the longer wait.
      if (!verdict.allowed && verdict.retryAfterSeconds >= retry) continue;
      verdict = { allowed: false, retryAfterSeconds: retry, reason: 'locked' };
      continue;
    }
    if (Number(row.attempts) > MAX_ATTEMPTS && verdict.allowed) {
      verdict = {
        allowed: false,
        retryAfterSeconds: Math.ceil(WINDOW_MS / 1000),
        reason: 'rate',
      };
    }
  }

  return verdict;
}

/**
 * Record a failed credential check, and lock the subject once they add up.
 *
 * @returns whether this failure tripped a lockout, so the caller can say so in
 *   the audit chain — the log is where "somebody is grinding this account"
 *   becomes visible, and nothing was writing that fact down before.
 */
export async function recordLoginFailure(username: string, ip: string): Promise<boolean> {
  await ensureLoginThrottleSchema();
  const lockUntil = new Date(Date.now() + LOCKOUT_MINUTES * 60_000);
  let lockedNow = false;

  for (const { scope, subject } of subjectsFor(username, ip)) {
    const { rows } = await sql<{ failures: number; locked: boolean }>`
      INSERT INTO admin_login_throttle (scope, subject, failures, attempts, updated_at)
      VALUES (${scope}, ${subject}, 1, 1, NOW())
      ON CONFLICT (scope, subject) DO UPDATE SET
        failures     = admin_login_throttle.failures + 1,
        locked_until = CASE
          WHEN admin_login_throttle.failures + 1 >= ${LOCKOUT_AFTER_FAILURES} THEN ${lockUntil}
          ELSE admin_login_throttle.locked_until END,
        updated_at   = NOW()
      RETURNING failures, (locked_until IS NOT NULL AND locked_until > NOW()) AS locked
    `;
    if (rows[0]?.locked) lockedNow = true;
  }
  return lockedNow;
}

/**
 * Forget this subject's failures.
 *
 * Called only after a login that passed BOTH the password and the TOTP, so a
 * half-correct guess never resets the count. The row is deleted rather than
 * zeroed, which also keeps the table from growing one row per operator per
 * address forever.
 */
export async function clearLoginFailures(username: string, ip: string): Promise<void> {
  await ensureLoginThrottleSchema();
  for (const { scope, subject } of subjectsFor(username, ip)) {
    await sql`DELETE FROM admin_login_throttle WHERE scope = ${scope} AND subject = ${subject}`;
  }
}
