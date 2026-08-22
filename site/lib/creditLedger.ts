import type { Client, PoolClient } from 'pg';
import { priceEvent, capFor, type CreditEvent, type CreditEventKind } from './creditPricing';

/**
 * The credit ledger: the only thing allowed to move `players.credit_balance`.
 *
 * ── What this replaces ─────────────────────────────────────────────────────
 *
 * `POST /api/game/state` took a `credits` number from the browser and wrote it
 * straight to the balance. Here the client supplies an *event*; the amount comes
 * from `creditPricing`, and every change leaves a row saying what happened.
 *
 * ── Why a transaction and not a clever CTE ─────────────────────────────────
 *
 * `completeQuestEngagement` does its job in one data-modifying CTE, and for a
 * single guarded UPDATE that is exactly right. Spending needs more: read the
 * balance, refuse if it will not cover the cost, then debit — and that sequence
 * is only safe if the row stays locked throughout. `SELECT … FOR UPDATE` inside
 * a transaction says so plainly. A CTE expressing the same thing would be
 * shorter and much harder to be sure about, and this is the one surface where
 * being sure matters more than being brief.
 *
 * ── Where the guarantees actually live ─────────────────────────────────────
 *
 * Idempotency is `UNIQUE (player_id, event_key)`. Not a Set in a process, which
 * would not survive two lambdas, and not a check-then-act, which two concurrent
 * requests both pass. The database refuses the second write and this module
 * reports that it did.
 *
 * Neither guarantee can be demonstrated without a real Postgres, which is why
 * `creditLedger.test.ts` runs against one.
 */

/** Any pg client — a plain Client in tests, a pooled one in a route. */
type Db = Client | PoolClient;

export type LedgerReason =
  | 'ok'
  | 'duplicate'
  | 'unknown_kind'
  | 'capped'
  | 'insufficient'
  | 'invalid';

export interface LedgerResult {
  applied: boolean;
  /** Credits actually moved. Zero whenever `applied` is false. */
  delta: number;
  /** The authoritative balance after this call, whatever the outcome. */
  balance: number;
  reason: LedgerReason;
}

export interface EarnRequest {
  kind: CreditEventKind;
  detail?: string;
  /** Idempotency key. The same key never pays twice. */
  eventKey: string;
  /**
   * For kinds the pricing module cannot value alone — a loot stack, a quest
   * reward, the opening migration row. Ignored for kinds it can price, so a
   * caller cannot talk the server into a better rate for a kill.
   */
  amount?: number;
}

export interface SpendRequest {
  cost: number;
  detail?: string;
  eventKey: string;
}

/** Kinds whose amount the caller supplies, because it comes from the database. */
const CALLER_PRICED = new Set<string>(['loot', 'purchase', 'quest', 'migration']);

export async function ensureCreditSchema(db: Db): Promise<void> {
  await db.query(`
    CREATE TABLE IF NOT EXISTS credit_events (
      id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      -- TEXT, not UUID. Production's players.id is TEXT (admin/lib/db.ts:130)
      -- holding UUID-shaped strings, and Postgres refuses a UUID -> TEXT foreign
      -- key outright: "constraint credit_events_player_id_fkey cannot be
      -- implemented". Declared UUID here, this table could never be created on
      -- production -- measured, not guessed.
      player_id     TEXT NOT NULL REFERENCES players(id) ON DELETE CASCADE,
      event_key     TEXT NOT NULL,
      kind          TEXT NOT NULL,
      detail        TEXT,
      delta         INTEGER NOT NULL,
      balance_after INTEGER NOT NULL,
      created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  // The idempotency guarantee. Everything else in this file leans on it.
  await db.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS credit_events_player_key_idx
      ON credit_events (player_id, event_key)
  `);
  // Serves the cap query, which counts one kind within a window.
  await db.query(`
    CREATE INDEX IF NOT EXISTS credit_events_player_kind_time_idx
      ON credit_events (player_id, kind, created_at DESC)
  `);
}

async function currentBalance(db: Db, playerId: string): Promise<number> {
  const r = await db.query('SELECT credit_balance FROM players WHERE id = $1', [playerId]);
  return Number(r.rows[0]?.credit_balance ?? 0);
}

async function readBalanceLocked(db: Db, playerId: string): Promise<number | null> {
  const r = await db.query('SELECT credit_balance FROM players WHERE id = $1 FOR UPDATE', [
    playerId,
  ]);
  return r.rows[0] ? Number(r.rows[0].credit_balance) : null;
}

/**
 * Insert the event, or discover that its key has already been used.
 *
 * `ON CONFLICT DO NOTHING` returning no row IS the duplicate signal. There is no
 * prior SELECT for a concurrent request to race against.
 */
async function insertEvent(
  db: Db,
  playerId: string,
  key: string,
  kind: string,
  detail: string | null,
  delta: number,
  balanceAfter: number
): Promise<string | null> {
  const r = await db.query(
    `INSERT INTO credit_events (player_id, event_key, kind, detail, delta, balance_after)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (player_id, event_key) DO NOTHING
     RETURNING id`,
    [playerId, key, kind, detail, delta, balanceAfter]
  );
  return r.rows[0]?.id ?? null;
}

/** How many events of this kind the player has had inside the cap window. */
async function countInWindow(
  db: Db,
  playerId: string,
  kind: string,
  windowSeconds: number
): Promise<number> {
  const r = await db.query(
    `SELECT COUNT(*)::int AS n FROM credit_events
      WHERE player_id = $1 AND kind = $2
        AND created_at > NOW() - ($3 || ' seconds')::interval`,
    [playerId, kind, String(windowSeconds)]
  );
  return Number(r.rows[0]?.n ?? 0);
}

function validKey(key: unknown): key is string {
  return typeof key === 'string' && key.length > 0 && key.length <= 200;
}

/**
 * Credit a player for something the client says happened.
 *
 * The server cannot know whether it really did — there is no simulation. What it
 * does is price the claim, bound how often it is honoured, and refuse a kind it
 * does not recognise.
 */
export async function applyCreditEvent(
  db: Db,
  playerId: string,
  request: EarnRequest
): Promise<LedgerResult> {
  const { kind, detail = null, eventKey } = request;

  if (!validKey(eventKey)) {
    return { applied: false, delta: 0, balance: await currentBalance(db, playerId), reason: 'invalid' };
  }

  const priced = priceEvent({ kind, detail: detail ?? undefined } as CreditEvent);
  if (priced === null) {
    // Unknown or forbidden kind — 'cheat' lands here. Nothing is recorded,
    // because nothing about the request is trustworthy enough to record.
    return {
      applied: false,
      delta: 0,
      balance: await currentBalance(db, playerId),
      reason: 'unknown_kind',
    };
  }

  let delta = priced;
  if (CALLER_PRICED.has(kind)) {
    const supplied = Number(request.amount);
    if (!Number.isInteger(supplied) || supplied < 0) {
      return {
        applied: false,
        delta: 0,
        balance: await currentBalance(db, playerId),
        reason: 'invalid',
      };
    }
    delta = supplied;
  }

  await db.query('BEGIN');
  try {
    const balance = await readBalanceLocked(db, playerId);
    if (balance === null) {
      await db.query('ROLLBACK');
      return { applied: false, delta: 0, balance: 0, reason: 'invalid' };
    }

    const cap = capFor(kind);
    if (cap) {
      const used = await countInWindow(db, playerId, kind, cap.windowSeconds);
      if (used >= cap.maxEvents) {
        // Record the attempt at zero rather than hiding it: a capped player is
        // exactly the one worth being able to see afterwards.
        await insertEvent(db, playerId, eventKey, kind, detail, 0, balance);
        await db.query('COMMIT');
        return { applied: false, delta: 0, balance, reason: 'capped' };
      }
    }

    const next = balance + delta;
    const id = await insertEvent(db, playerId, eventKey, kind, detail, delta, next);
    if (!id) {
      await db.query('ROLLBACK');
      return { applied: false, delta: 0, balance, reason: 'duplicate' };
    }

    await db.query('UPDATE players SET credit_balance = $1, updated_at = NOW() WHERE id = $2', [
      next,
      playerId,
    ]);
    await db.query('COMMIT');
    return { applied: true, delta, balance: next, reason: 'ok' };
  } catch (err) {
    await db.query('ROLLBACK').catch(() => {});
    throw err;
  }
}

/**
 * Debit a player inside a transaction the CALLER owns.
 *
 * Split out of `spendCredits` so a marketplace purchase can debit the credits,
 * decrement the stock and record the sale in ONE transaction. Postgres has no
 * nested `BEGIN` — an inner `COMMIT` would commit the outer transaction too — so
 * anything that must be atomic with a debit has to SHARE the debit's transaction
 * rather than call something that opens its own.
 *
 * Contract, and it matters: the caller must already have issued `BEGIN`, and on
 * any result where `applied` is false the caller must `ROLLBACK`. This function
 * deliberately does neither, because it cannot know what else the caller has
 * written into the same transaction.
 *
 * The balance is re-read under `FOR UPDATE` rather than passed in. By then the
 * row is usually already locked, so it costs a primary-key lookup — and it makes
 * the helper impossible to hand a stale number, which is the one mistake that
 * would silently reintroduce the overdraw this whole phase exists to stop.
 */
export async function debitInTransaction(
  db: Db,
  playerId: string,
  request: SpendRequest
): Promise<LedgerResult> {
  const { cost, detail = null, eventKey } = request;

  const balance = await readBalanceLocked(db, playerId);
  if (balance === null) return { applied: false, delta: 0, balance: 0, reason: 'invalid' };

  if (!Number.isInteger(cost) || cost <= 0 || !validKey(eventKey)) {
    return { applied: false, delta: 0, balance, reason: 'invalid' };
  }
  if (balance < cost) {
    return { applied: false, delta: 0, balance, reason: 'insufficient' };
  }

  const next = balance - cost;
  const id = await insertEvent(db, playerId, eventKey, 'purchase', detail, -cost, next);
  if (!id) return { applied: false, delta: 0, balance, reason: 'duplicate' };

  await db.query('UPDATE players SET credit_balance = $1, updated_at = NOW() WHERE id = $2', [
    next,
    playerId,
  ]);
  return { applied: true, delta: -cost, balance: next, reason: 'ok' };
}

/**
 * Debit a player, refusing to overdraw.
 *
 * The balance stays locked for the whole read-decide-write, so two purchases
 * that would each succeed alone cannot both succeed together. `marketplaceDb.ts`
 * has never had this — buying is client-side arithmetic today.
 */
export async function spendCredits(
  db: Db,
  playerId: string,
  request: SpendRequest
): Promise<LedgerResult> {
  await db.query('BEGIN');
  try {
    const result = await debitInTransaction(db, playerId, request);
    if (!result.applied) {
      await db.query('ROLLBACK');
      return result;
    }
    await db.query('COMMIT');
    return result;
  } catch (err) {
    await db.query('ROLLBACK').catch(() => {});
    throw err;
  }
}
