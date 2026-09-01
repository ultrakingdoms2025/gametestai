import type { Client, PoolClient } from 'pg';
import {
  ACCESS_WINDOW_DAYS,
  hashAccessCode,
  isAccessCodeKind,
  type AccessCodeKind,
} from './accessCodeFormat';
import { grantCompedHosting } from './premium';

/**
 * Access codes: the redemption half.
 *
 * An access code is a string an operator mints in the admin dashboard and hands
 * to a person, which that person redeems for either 30 days of game access or a
 * comped custom-server slot — the same thing they would have got by paying,
 * arrived at by a different route.
 *
 * ── What this file owns ───────────────────────────────────────────────────
 *
 * THE SCHEMA. `ensureAccessCodeSchema` here is the canonical declaration of
 * `access_codes` and `access_code_redemptions`. `admin/lib/accessCodes.ts`
 * carries a copy for the same reason `admin/lib/db.ts` carries a copy of
 * `credit_events`: the admin app must be able to MINT a code on a database the
 * site has never served a request against, and neither app can import the
 * other. Both use `CREATE TABLE IF NOT EXISTS`, so whichever runs first wins
 * and the other is a no-op — and `accessCodes.test.ts` compares the two
 * declarations so they cannot drift apart in silence.
 *
 * ── Why redemption is here and creation is over there ─────────────────────
 *
 * Creating a code is an administrative act, guarded by the admin app's session
 * and written into its HMAC-chained audit log. Redeeming one is a player act on
 * a player's session. They are different surfaces with different threat models,
 * and putting the mint next to the redeem would mean the site app carries the
 * ability to issue itself credentials.
 */

/** Any pg client — a plain Client in tests, a pooled one in a route. */
type Db = Client | PoolClient;

/* ---------------------------------------------------------------------- */
/* Schema                                                                  */
/* ---------------------------------------------------------------------- */

let schemaPromise: Promise<void> | null = null;

/**
 * Build the tables if they are not there.
 *
 * Memoised as a PROMISE rather than a boolean, like every other ensure in this
 * project: two cold lambdas then wait on one statement instead of racing, and a
 * rejection clears the memo so the next request retries rather than inheriting
 * a permanent false "already done".
 *
 * `player_id` is TEXT because `players.id` is TEXT — Postgres refuses a
 * UUID→TEXT foreign key outright, which `creditLedger.ts` records as measured
 * rather than assumed.
 */
export function ensureAccessCodeSchema(db: Db): Promise<void> {
  if (!schemaPromise) {
    schemaPromise = (async () => {
      await db.query(`
        CREATE TABLE IF NOT EXISTS access_codes (
          code_hash    TEXT PRIMARY KEY,
          code_enc     TEXT,
          code_hint    TEXT NOT NULL,
          kind         TEXT NOT NULL,
          days         INTEGER NOT NULL,
          max_uses     INTEGER NOT NULL DEFAULT 1,
          uses         INTEGER NOT NULL DEFAULT 0,
          batch_id     TEXT,
          label        TEXT,
          created_by   TEXT NOT NULL,
          created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          expires_at   TIMESTAMPTZ,
          revoked_at   TIMESTAMPTZ,
          revoked_by   TEXT
        )
      `);
      await db.query(`
        CREATE INDEX IF NOT EXISTS access_codes_created_idx
          ON access_codes (created_at DESC)
      `);
      await db.query(`
        CREATE TABLE IF NOT EXISTS access_code_redemptions (
          code_hash      TEXT NOT NULL REFERENCES access_codes(code_hash) ON DELETE CASCADE,
          player_id      TEXT NOT NULL REFERENCES players(id) ON DELETE CASCADE,
          kind           TEXT NOT NULL,
          days           INTEGER NOT NULL,
          redeemed_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          clawed_back_at TIMESTAMPTZ,
          PRIMARY KEY (code_hash, player_id)
        )
      `);
      await db.query(`
        CREATE INDEX IF NOT EXISTS access_code_redemptions_player_idx
          ON access_code_redemptions (player_id, redeemed_at DESC)
      `);
    })().catch((err) => {
      schemaPromise = null;
      throw err;
    });
  }
  return schemaPromise;
}

/** Test-only: forget the memo so a fresh database can be built again. */
export function resetAccessCodeSchemaMemo(): void {
  schemaPromise = null;
}

/* ---------------------------------------------------------------------- */
/* Redemption                                                              */
/* ---------------------------------------------------------------------- */

export type RedeemRefusal =
  | 'malformed'
  | 'not_found'
  | 'revoked'
  | 'expired'
  | 'exhausted'
  | 'already_redeemed'
  | 'player_locked'
  | 'grant_failed';

export type RedeemOutcome =
  | { ok: true; kind: AccessCodeKind; days: number; label: string | null }
  | { ok: false; reason: RedeemRefusal };

/**
 * What a refusal is safe to say out loud.
 *
 * All of it, deliberately. The instinct to collapse these into one opaque "that
 * code is not valid" is borrowed from sign-in forms, where distinguishing "no
 * such user" from "wrong password" hands an attacker half the credential. It
 * does not transfer: a code is a single 60-bit secret with no username beside
 * it, so learning that some unrelated string is "already used" rather than
 * "unknown" narrows nothing a guesser could act on. What it DOES do is tell the
 * person holding a real code why their real code did not work, which is the
 * difference between them redeeming it and them opening a support ticket.
 */
export const REDEEM_MESSAGES: Record<RedeemRefusal, string> = {
  malformed: 'That does not look like an access code. Check for a missing character.',
  not_found: 'We do not recognise that code.',
  revoked: 'That code has been withdrawn.',
  expired: 'That code has passed its expiry date.',
  exhausted: 'That code has already been claimed by as many people as it allows.',
  already_redeemed: 'You have already redeemed that code on this account.',
  player_locked: 'This account cannot redeem codes. Please contact support.',
  grant_failed: 'Something went wrong applying that code. Please try again.',
};

/**
 * Redeem a code for a player.
 *
 * ── The shape of it, and why it is two phases rather than one ─────────────
 *
 * Phase one is a transaction: lock the code row, insert the redemption, consume
 * a use, and — for a `play` code — move the access window, all or nothing.
 * `SELECT … FOR UPDATE` is what makes `uses < max_uses` mean anything; two
 * people racing the last use of a code otherwise both read `uses = 4`, both
 * pass, and both redeem.
 *
 * Phase two exists only for `server` codes, and only because `writeEntitlement`
 * opens a transaction of its own. Postgres has no nested transactions: its
 * `COMMIT` would commit this function's work early and the subsequent
 * `ROLLBACK` would be a no-op warning, so a failed hosting grant would leave a
 * consumed use behind and no way to tell. Rather than reach inside a module
 * that four other paths depend on, the hosting grant runs after the commit and
 * a failure is COMPENSATED — the redemption row is deleted and the use is given
 * back, restoring the state the player started in so they can simply try again.
 *
 * The compensation is safe to be imprecise about, because
 * `grantCompedHosting` derives its subscription id from the code hash. If the
 * process dies between the entitlement write and the compensation, the retry
 * upserts the same row and mints no second slot — the worst case is one comped
 * slot and an unconsumed use, which an operator can see and a second attempt
 * settles.
 *
 * ── Why `already_redeemed` is decided before `exhausted` ──────────────────
 *
 * The insert is attempted before the use count is checked, so somebody
 * re-typing their own code into a batch that has since been used up is told
 * "you already redeemed this" rather than "it is used up". Both are true; only
 * one of them tells them they already have what they are trying to claim.
 */
export async function redeemAccessCode(
  db: Db,
  input: { code: unknown; playerId: string }
): Promise<RedeemOutcome> {
  const codeHash = hashAccessCode(input?.code);
  if (!codeHash) return { ok: false, reason: 'malformed' };
  const playerId = String(input?.playerId ?? '').trim();
  if (!playerId) return { ok: false, reason: 'not_found' };

  await ensureAccessCodeSchema(db);

  let kind: AccessCodeKind = 'play';
  let days = 0;
  let label: string | null = null;

  await db.query('BEGIN');
  try {
    const found = await db.query(
      `SELECT kind, days, max_uses, uses, label, revoked_at, expires_at
         FROM access_codes
        WHERE code_hash = $1
        FOR UPDATE`,
      [codeHash]
    );
    const row = found.rows[0] as Record<string, unknown> | undefined;
    if (!row) {
      await db.query('ROLLBACK');
      return { ok: false, reason: 'not_found' };
    }
    if (row.revoked_at) {
      await db.query('ROLLBACK');
      return { ok: false, reason: 'revoked' };
    }
    if (row.expires_at && new Date(String(row.expires_at)).getTime() <= Date.now()) {
      await db.query('ROLLBACK');
      return { ok: false, reason: 'expired' };
    }

    /* Whatever the column says, coerced to a kind this code knows how to
     * honour. A row written by hand, or by a later version with a third kind,
     * must not fall through to the `play` branch and silently hand out days. */
    if (!isAccessCodeKind(row.kind)) {
      await db.query('ROLLBACK');
      return { ok: false, reason: 'not_found' };
    }
    kind = row.kind;
    days = Math.max(1, Math.floor(Number(row.days ?? 0)));
    label = row.label == null ? null : String(row.label);

    /* The redemption row is the record that THIS player used THIS code, and
     * its primary key is what makes a second attempt a no-op rather than a
     * second grant. Denormalised `kind` and `days` so a claw-back knows what it
     * is undoing even if the code row has been edited since. */
    const claimed = await db.query(
      `INSERT INTO access_code_redemptions (code_hash, player_id, kind, days)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (code_hash, player_id) DO NOTHING
       RETURNING code_hash`,
      [codeHash, playerId, kind, days]
    );
    if (!claimed.rows[0]) {
      await db.query('ROLLBACK');
      return { ok: false, reason: 'already_redeemed' };
    }

    const maxUses = Math.max(1, Math.floor(Number(row.max_uses ?? 1)));
    const uses = Math.max(0, Math.floor(Number(row.uses ?? 0)));
    if (uses >= maxUses) {
      await db.query('ROLLBACK');
      return { ok: false, reason: 'exhausted' };
    }
    await db.query(
      `UPDATE access_codes SET uses = uses + 1 WHERE code_hash = $1`,
      [codeHash]
    );

    if (kind === 'play') {
      const moved = await extendPlayerAccess(db, playerId, days);
      if (!moved) {
        await db.query('ROLLBACK');
        return { ok: false, reason: 'player_locked' };
      }
    }

    await db.query('COMMIT');
  } catch (err) {
    await db.query('ROLLBACK').catch(() => {});
    throw err;
  }

  if (kind === 'server') {
    try {
      const granted = await grantCompedHosting(db, { playerId, codeHash, days });
      if (!granted.granted) throw new Error(`comped hosting refused: ${granted.reason}`);
    } catch (err) {
      console.error('[accessCodes] comped hosting grant failed; compensating:', err);
      await compensateRedemption(db, codeHash, playerId);
      return { ok: false, reason: 'grant_failed' };
    }
  }

  return { ok: true, kind, days, label };
}

/**
 * Push this player's access expiry out by `days`, from wherever it is now.
 *
 * ── The arithmetic, and why it is done on `access_granted_at` ─────────────
 *
 * There is one access column pair in this schema and one rule over it, stated
 * identically in `playerDb.ts` and `admin/lib/playerAccess.ts`: access runs from
 * `access_granted_at` for a fixed 30 days. There is no "expires_at" to write, so
 * granting an arbitrary number of days means placing `access_granted_at` such
 * that the fixed window lands where it should — which is exactly what the
 * admin dashboard's own `setPlayerAccessDays` already does, and this is the
 * same lever pulled for the same reason rather than a second mechanism.
 *
 * So: the new expiry is `max(now, current expiry) + days`, and the column is
 * set to that minus the window. Two consequences worth being explicit about:
 *
 *   - A player with 12 days left who redeems a 30-day code gets 42, not 30.
 *     Time already paid for is not confiscated by a gift.
 *   - A code longer than the window puts `access_granted_at` in the FUTURE.
 *     That is fine and not a hack: every reader in the codebase computes
 *     `granted + 30 days` and compares it to now, so a future grant reads as
 *     more than 30 days remaining, which is the truth.
 *
 * The window is passed as a parameter, from the constant the format module and
 * both access readers share, so there is no literal `30` in this statement to
 * drift away from them.
 *
 * Returns false when nothing was updated, which means the account is locked —
 * a moderation state that a code is not allowed to lift.
 */
async function extendPlayerAccess(db: Db, playerId: string, days: number): Promise<boolean> {
  const moved = await db.query(
    `UPDATE players
        SET access_granted_at =
              GREATEST(
                NOW(),
                CASE
                  WHEN access_granted_at IS NOT NULL AND access_revoked_at IS NULL
                    THEN access_granted_at + make_interval(days => $3::int)
                  ELSE NOW()
                END
              )
              + make_interval(days => $2::int)
              - make_interval(days => $3::int),
            access_revoked_at = NULL,
            updated_at = NOW()
      WHERE id = $1
        AND (status IS NULL OR LOWER(status) <> 'locked')
      RETURNING id`,
    [playerId, days, ACCESS_WINDOW_DAYS]
  );
  return !!moved.rows[0];
}

/**
 * Undo a redemption whose grant did not land.
 *
 * Deliberately not a transaction over both statements. If the delete succeeds
 * and the decrement does not, the code has lost one use out of its allowance
 * and the player can redeem again — an operator can see the discrepancy in the
 * dashboard and mint another code. The other order round would leave a player
 * unable to retry, which is the failure that generates a support ticket.
 *
 * `uses > 0` on the decrement so a double compensation cannot drive the count
 * negative.
 */
async function compensateRedemption(db: Db, codeHash: string, playerId: string): Promise<void> {
  try {
    await db.query(
      `DELETE FROM access_code_redemptions WHERE code_hash = $1 AND player_id = $2`,
      [codeHash, playerId]
    );
    await db.query(
      `UPDATE access_codes SET uses = uses - 1 WHERE code_hash = $1 AND uses > 0`,
      [codeHash]
    );
  } catch (err) {
    console.error('[accessCodes] compensation failed; a use may be stranded:', err);
  }
}
