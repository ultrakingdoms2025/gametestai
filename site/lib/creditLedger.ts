import type { Client, PoolClient } from 'pg';
import {
  priceEvent,
  capFor,
  resolveReportedEvent,
  type CreditEvent,
  type CreditEventKind,
} from './creditPricing';

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
  /**
   * Skip the per-kind rate cap. Defaults to false; say why at every call site.
   *
   * The caps in `creditPricing.ts` bound how often a CLAIM is honoured — the
   * client says a hostile died and the server, which has no simulation, cannot
   * refuse a well-formed lie. That argument does not reach a payout the server
   * priced itself off a row the client cannot write. For those, a cap has
   * nothing to bound and one failure mode: it records the event at zero, and the
   * player is told they earned nothing for something they really did. The
   * pricing module's own comment says a ceiling that clips a real payout is
   * silent theft, and this is the shape of it.
   */
  ignoreCap?: boolean;
}

/**
 * The result of a ledger write that runs inside a transaction the CALLER owns.
 *
 * `recorded` is not `applied`. A CAPPED event is deliberately written at zero —
 * "a capped player is exactly the one worth being able to see afterwards" — so
 * it is `applied: false` and `recorded: true`, and a caller that rolled back on
 * `!applied` would throw that row away. The two callers below get this right
 * because the flag says which question they are answering.
 */
export interface TransactionalResult extends LedgerResult {
  /** True when this call WROTE a row. The caller must COMMIT, not ROLLBACK. */
  recorded: boolean;
}

export interface SpendRequest {
  cost: number;
  detail?: string;
  eventKey: string;
  /**
   * What the debit was. Defaults to 'purchase' (a marketplace sale); reported
   * in-game spending arrives as 'spend' so the two are distinguishable in the
   * ledger without reading the detail string.
   */
  kind?: 'purchase' | 'spend';
}

/** Kinds whose amount the caller supplies, because it comes from the database. */
const CALLER_PRICED = new Set<string>([
  'loot',
  'purchase',
  'quest',
  'migration',
  // Declared by the client and bounded rather than priced -- see
  // DECLARED_KINDS and PER_EVENT_MAX in creditPricing.ts.
  'ore',
  'contract',
  'bounty',
  'sell',
  'race',
  'minigame',
  'objective',
]);

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
 * Credit a player inside a transaction the CALLER owns.
 *
 * The exact mirror of `debitInTransaction`, and it exists for the same reason
 * that one does: something has to be atomic with the money.
 *
 * ── What was wrong without it ──────────────────────────────────────────────
 *
 * `completeQuestEngagement` flipped the engagement to 'completed' and added the
 * reward to `players.credit_balance` in one data-modifying CTE — atomic, and
 * with NO `credit_events` row. Measured live on a real database:
 *
 *   event_key        kind       delta  balance_after
 *   migration:…      migration    +90             90
 *   survey-kill-1    kill          +5             95
 *   survey-kill-2    kill          +5            250   <- +155 on a +5 event
 *
 *   SELECT SUM(delta) FROM credit_events -> 100
 *   SELECT credit_balance FROM players   -> 250
 *
 * Row 3's `balance_after` cannot be derived from row 2's plus its own delta. The
 * 150-credit quest reward is invisible to the chain, and every `balance_after`
 * after a player's FIRST quest completion is underivable — which is every
 * player. `ensureOpeningBalance` hides it on a brand-new account, which is
 * exactly the account a smoke test uses.
 *
 * The obvious repair — call `applyCreditEvent` after the CTE — trades one defect
 * for another: `applyCreditEvent` opens its own `BEGIN`, Postgres has no nested
 * transactions, and a crash between the two statements leaves a quest completed
 * and unpaid with no way to tell. So the quest flip and the credit share ONE
 * transaction, and this is the half that can live inside it.
 *
 * ── The contract, and it matters ───────────────────────────────────────────
 *
 * The caller must already have issued `BEGIN`, and must `COMMIT` whenever
 * `recorded` is true — INCLUDING when `applied` is false, which is the capped
 * case, because that row is deliberately written at zero. Roll back only on
 * `recorded === false`.
 */
export async function creditInTransaction(
  db: Db,
  playerId: string,
  request: EarnRequest
): Promise<TransactionalResult> {
  const { kind, detail = null, eventKey, ignoreCap = false } = request;

  const refuse = async (reason: LedgerReason): Promise<TransactionalResult> => ({
    applied: false,
    delta: 0,
    balance: await currentBalance(db, playerId),
    reason,
    recorded: false,
  });

  if (!validKey(eventKey)) return refuse('invalid');

  const priced = priceEvent({ kind, detail: detail ?? undefined } as CreditEvent);
  if (priced === null) {
    // Unknown or forbidden kind — 'cheat' lands here. Nothing is recorded,
    // because nothing about the request is trustworthy enough to record.
    return refuse('unknown_kind');
  }

  let delta = priced;
  if (CALLER_PRICED.has(kind)) {
    const supplied = Number(request.amount);
    if (!Number.isInteger(supplied) || supplied < 0) return refuse('invalid');
    delta = supplied;
  }

  const balance = await readBalanceLocked(db, playerId);
  if (balance === null) {
    return { applied: false, delta: 0, balance: 0, reason: 'invalid', recorded: false };
  }

  const cap = ignoreCap ? null : capFor(kind);
  if (cap) {
    const used = await countInWindow(db, playerId, kind, cap.windowSeconds);
    if (used >= cap.maxEvents) {
      // Record the attempt at zero rather than hiding it: a capped player is
      // exactly the one worth being able to see afterwards.
      await insertEvent(db, playerId, eventKey, kind, detail, 0, balance);
      return { applied: false, delta: 0, balance, reason: 'capped', recorded: true };
    }
  }

  const next = balance + delta;
  const id = await insertEvent(db, playerId, eventKey, kind, detail, delta, next);
  if (!id) {
    return { applied: false, delta: 0, balance, reason: 'duplicate', recorded: false };
  }

  await db.query('UPDATE players SET credit_balance = $1, updated_at = NOW() WHERE id = $2', [
    next,
    playerId,
  ]);
  return { applied: true, delta, balance: next, reason: 'ok', recorded: true };
}

/**
 * Credit a player for something the client says happened.
 *
 * The server cannot know whether it really did — there is no simulation. What it
 * does is price the claim, bound how often it is honoured, and refuse a kind it
 * does not recognise.
 *
 * The transaction, and nothing else: the work is `creditInTransaction`, exactly
 * as `spendCredits` is `debitInTransaction` plus a transaction. Two copies of
 * "read locked, check the cap, insert, update" is one copy that eventually
 * disagrees with the other about what a capped event does.
 */
export async function applyCreditEvent(
  db: Db,
  playerId: string,
  request: EarnRequest
): Promise<LedgerResult> {
  await db.query('BEGIN');
  try {
    const { recorded, ...result } = await creditInTransaction(db, playerId, request);
    // COMMIT on `recorded`, not on `applied` — a capped event writes a zero row
    // and must keep it.
    await db.query(recorded ? 'COMMIT' : 'ROLLBACK');
    return result;
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
  const { cost, detail = null, eventKey, kind = 'purchase' } = request;

  const balance = await readBalanceLocked(db, playerId);
  if (balance === null) return { applied: false, delta: 0, balance: 0, reason: 'invalid' };

  if (!Number.isInteger(cost) || cost <= 0 || !validKey(eventKey)) {
    return { applied: false, delta: 0, balance, reason: 'invalid' };
  }
  if (balance < cost) {
    return { applied: false, delta: 0, balance, reason: 'insufficient' };
  }

  const next = balance - cost;
  const id = await insertEvent(db, playerId, eventKey, kind, detail, -cost, next);
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

// ---------------------------------------------------------------------------
// Reported gameplay events, and the opening balance
// ---------------------------------------------------------------------------

export interface ReportedEvent {
  /** Idempotency key, minted by the client and stable across retries. */
  key: string;
  /** The game's own `credits:changed` reason tag. */
  reason: string;
  /** Signed: positive is an earn, negative is a spend. */
  delta: number;
  /**
   * WHICH CATALOGUE ROW a marketplace debit is for — its id, or its `source_key`
   * for a client shopping the bundled offline catalogue.
   *
   * The event could not express this, and that is what made a marketplace buy
   * client-priced: `{key, reason, delta}` carries no item, so the server had
   * nothing to look `cost_buy` up by even though it holds the row. Absent on a
   * marketplace debit, the event is REFUSED — never priced from `delta`.
   */
  itemId?: string;
}

export type ReportOutcome =
  | LedgerReason
  | 'unknown_source'
  | 'refused'
  | 'too_large'
  /** A marketplace debit that did not say which item. */
  | 'unpriced_purchase'
  /** The catalogue's own refusals, passed through so a client can tell them apart. */
  | 'not_found'
  | 'inactive'
  | 'stock';

export interface ReportResult {
  key: string;
  applied: boolean;
  delta: number;
  balance: number;
  reason: ReportOutcome;
}

/**
 * How a reported catalogue purchase is actually carried out.
 *
 * ── Why this is injected rather than imported ─────────────────────────────
 *
 * The destination is `marketplaceDb.purchaseMarketplaceItem`, and
 * `marketplaceDb` already imports `debitInTransaction` from THIS file. Importing
 * it back would make a cycle — one that works today because both sides are used
 * inside function bodies, and that breaks in a bundler long after whoever
 * created it has stopped looking. The route holds both modules already, so it
 * hands the destination in.
 *
 * ── And it fails CLOSED ───────────────────────────────────────────────────
 *
 * A caller that supplies no handler cannot buy: the event is refused, not paid
 * at the client's number. That is the whole point of the shape. There is no
 * arrangement of these arguments that ends in a browser naming a purchase price.
 */
export interface ReportHandlers {
  buyCatalogueItem?: (request: {
    itemRef: string;
    eventKey: string;
  }) => Promise<{ applied: boolean; delta: number; balance: number; reason: ReportOutcome }>;
}

/**
 * Apply one reported change.
 *
 * The client says what happened and in which direction; `resolveReportedEvent`
 * decides what that is worth and whether it is honoured at all. A refused event
 * is not an error for the caller to retry — it is an answer.
 */
export async function applyReportedEvent(
  db: Db,
  playerId: string,
  event: ReportedEvent,
  handlers: ReportHandlers = {}
): Promise<ReportResult> {
  const key = event?.key;
  if (!validKey(key)) {
    return {
      key: typeof key === 'string' ? key : '',
      applied: false,
      delta: 0,
      balance: await currentBalance(db, playerId),
      reason: 'invalid',
    };
  }

  const resolved = resolveReportedEvent(event.reason, event.delta, event.itemId);
  if (!resolved.ok) {
    return {
      key,
      applied: false,
      delta: 0,
      balance: await currentBalance(db, playerId),
      reason: resolved.reason,
    };
  }

  if (resolved.itemRef !== undefined) {
    /* A catalogue purchase. `resolveReportedEvent` only sets `itemRef` for one,
     * and it discards `delta` entirely when it does — so there is no path from
     * here to a price the browser chose, including when no handler was given. */
    const buy = handlers.buyCatalogueItem;
    if (!buy) {
      return {
        key,
        applied: false,
        delta: 0,
        balance: await currentBalance(db, playerId),
        reason: 'unpriced_purchase',
      };
    }
    const r = await buy({ itemRef: resolved.itemRef, eventKey: key });
    return { key, applied: r.applied, delta: r.delta, balance: r.balance, reason: r.reason };
  }

  if (resolved.kind === 'spend') {
    const r = await spendCredits(db, playerId, {
      cost: resolved.amount ?? 0,
      detail: resolved.detail,
      eventKey: key,
      kind: 'spend',
    });
    return { key, applied: r.applied, delta: r.delta, balance: r.balance, reason: r.reason };
  }

  const r = await applyCreditEvent(db, playerId, {
    kind: resolved.kind,
    detail: resolved.detail,
    eventKey: key,
    // Null for a server-priced kind: applyCreditEvent ignores `amount` unless the
    // kind is caller-priced, so a client cannot talk it into a better rate.
    ...(resolved.amount === null ? {} : { amount: resolved.amount }),
  });
  return { key, applied: r.applied, delta: r.delta, balance: r.balance, reason: r.reason };
}

/**
 * Record where a player's balance started, once.
 *
 * `players.credit_balance` already holds every live player's real total, and
 * there is no history to recompute it from — so the ledger does not try. It
 * opens with one row stating the number it inherited, and every row after that
 * is a change it made itself. Without this the ledger's `balance_after` column
 * would be self-consistent but wrong from its first entry.
 *
 * Idempotent by the same UNIQUE constraint as everything else: the key is fixed
 * per player, so a second call cannot open a second balance.
 */
export async function ensureOpeningBalance(db: Db, playerId: string): Promise<void> {
  const existing = await db.query(
    "SELECT 1 FROM credit_events WHERE player_id = $1 AND kind = 'migration' LIMIT 1",
    [playerId]
  );
  if (existing.rows[0]) return;

  const balance = await currentBalance(db, playerId);
  await db.query(
    `INSERT INTO credit_events (player_id, event_key, kind, detail, delta, balance_after)
     VALUES ($1, $2, 'migration', 'opening balance', $3, $3)
     ON CONFLICT (player_id, event_key) DO NOTHING`,
    [playerId, `migration:${playerId}`, balance]
  );
}
