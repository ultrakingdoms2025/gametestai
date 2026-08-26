import type { Client, PoolClient } from 'pg';

/**
 * Server-scoped credits: 7f's "credits that cannot feed the global balance".
 *
 * ── Cannot, not must not ──────────────────────────────────────────────────
 *
 * The obvious implementation is one balance with a `server_id` column and a
 * filter on every read. That is a gate that can be forgotten — the same shape
 * Phase 7 rejects for leaderboards, and for the same reason.
 *
 * So the money lives in tables of its own. `server_credit_balances` and
 * `server_credit_events` have no column that names `players.credit_balance`,
 * no foreign key into `credit_events`, and no shared idempotency namespace. This
 * module does not import `creditLedger` and issues no statement against
 * `players`. A leak out of a server would not be a missing `WHERE`; it would be
 * a function that does not exist, written by someone who read this paragraph
 * first.
 *
 * `serverCredits.test.ts` pins that two ways without needing a database: it
 * reads this file's source for the forbidden names, and it watches every
 * statement an earn and a spend actually issue.
 *
 * ── What is borrowed from the global ledger, and what is not ──────────────
 *
 * Borrowed, because they are right and were argued for at length there:
 *
 *   - **Idempotency is a UNIQUE constraint**, not a Set in a process. Two
 *     lambdas do not share a Set, and a check-then-act is two requests away
 *     from both passing.
 *   - **Spending holds the row locked** across read-decide-write, so two spends
 *     that would each succeed alone cannot both succeed together.
 *   - **The client names an event, never an amount it has priced.** A kind it
 *     does not recognise is refused rather than stored.
 *
 * Not borrowed: `creditPricing`'s table. A custom server's economy is the
 * owner's, so the AMOUNT comes from the owner's own content — a quest's
 * `reward_credits`, an item's `cost_sell`. What this module keeps is a per-event
 * CEILING, which is the part that stops one event minting a fortune while
 * leaving the owner free to price their own world.
 *
 * ── Why there is no opening balance ───────────────────────────────────────
 *
 * `creditLedger.ensureOpeningBalance` exists because `players.credit_balance`
 * already held real money with no history to derive it from. A server ledger
 * starts at the moment its server is created, so every row in it is a change
 * this module made and `balance_after` is derivable from the first entry
 * onward. Nothing is inherited, so nothing needs declaring.
 */

/** Any pg client — a plain Client in tests, a pooled one in a route. */
type Db = Client | PoolClient;

export interface ServerCreditRateCap {
  readonly maxEvents: number;
  readonly windowSeconds: number;
}

export interface ServerCreditKindSpec {
  readonly id: string;
  readonly label: string;
  /** The most one event of this kind may ever be worth. */
  readonly perEventMax: number;
  /**
   * How often this kind is honoured, per rolling window — absent for kinds the
   * server prices from rows the client cannot write (a quest completion, an
   * owner grant), where a rate cap has nothing to bound and one failure mode:
   * marking real work done and paying zero for it.
   */
  readonly rateCap?: ServerCreditRateCap;
  readonly why: string;
}

const HOUR = 3600;

/**
 * What a server ledger will pay for, and the most it will pay at once.
 *
 * The ceilings are generous against real content and finite against a forged
 * request. They are not a price list: the owner sets the price (or the platform
 * table does, for gameplay reported while scoped), and this says how large a
 * single one may be and how often it is honoured.
 *
 * ── Why the gameplay kinds are here at all ────────────────────────────────
 *
 * While a player is INSIDE a custom server, their in-game earnings are that
 * server's — the platform balance must not move (the owner's explicit
 * instruction; `economySeparation.test.ts` holds both directions). So the
 * whole reported-event vocabulary the platform ledger accepts has to land
 * somewhere here. Each ceiling and rate cap below MIRRORS the platform's own
 * (`creditPricing.ts` PER_EVENT_MAX / CAPS): those numbers were measured
 * against the shipped game, and a scoped session plays the same game — a
 * tighter ceiling here would silently clip a real payout, the exact "my
 * credits feel wrong" theft that module warns against; a looser one would make
 * being scoped the cheaper place to forge.
 */
export const SERVER_CREDIT_KINDS: Readonly<Record<string, ServerCreditKindSpec>> = Object.freeze({
  quest: Object.freeze({
    id: 'quest', label: 'Quest reward', perEventMax: 5_000,
    why: "The owner sets reward_credits; this bounds one payout, not the owner's economy. "
      + 'No rate cap: the completion is gated by an engagement row the client cannot write.',
  }),
  sell: Object.freeze({
    id: 'sell', label: 'Sold to the market', perEventMax: 500_000,
    rateCap: Object.freeze({ maxEvents: 400, windowSeconds: HOUR }),
    why: 'The in-game sell stream (dock sales, market sells) lands here while scoped. '
      + 'Ceiling and rate mirror the platform ledger, which accepts the SAME stream at '
      + '500,000 / 400 per hour — a lower ceiling would clip a real dock sale.',
  }),
  grant: Object.freeze({
    id: 'grant', label: 'Owner grant', perEventMax: 5_000,
    why: 'An owner handing a member credits directly. Audited, and bounded per event.',
  }),
  kill: Object.freeze({
    id: 'kill', label: 'Hostile destroyed', perEventMax: 100,
    rateCap: Object.freeze({ maxEvents: 400, windowSeconds: HOUR }),
    why: 'Server-priced at 5 CR by the platform price table, so the ceiling is a backstop '
      + '20x the price; the rate mirrors CAPS.kill (400/h, far above the 18-hostile station).',
  }),
  loot: Object.freeze({
    id: 'loot', label: 'Loot picked up', perEventMax: 5_000,
    rateCap: Object.freeze({ maxEvents: 600, windowSeconds: HOUR }),
    why: 'Mirrors PER_EVENT_MAX.loot / CAPS.loot: drops are 4..14 in the shipped game, '
      + 'so 5,000 per event never bites honestly and 600/h bounds a forged stream.',
  }),
  race: Object.freeze({
    id: 'race', label: 'Race finish', perEventMax: 10_000,
    rateCap: Object.freeze({ maxEvents: 60, windowSeconds: HOUR }),
    why: 'Mirrors the platform: 10 first place plus up to 128 in pickups, given room; '
      + 'a race takes minutes, so 60/h is unreachable honestly.',
  }),
  minigame: Object.freeze({
    id: 'minigame', label: 'Minigame won', perEventMax: 10_000,
    rateCap: Object.freeze({ maxEvents: 60, windowSeconds: HOUR }),
    why: 'Mirrors the platform: 120 at the yard butts, 10 elsewhere, given room.',
  }),
  relic: Object.freeze({
    id: 'relic', label: 'Relic recovered', perEventMax: 1_000,
    rateCap: Object.freeze({ maxEvents: 60, windowSeconds: HOUR }),
    why: 'Server-priced at 120 (or 500 for a set) by the platform table; relics are a '
      + 'finite identity set, so the rate cap is a backstop, not a budget.',
  }),
  viewpoint: Object.freeze({
    id: 'viewpoint', label: 'Viewpoint synced', perEventMax: 500,
    rateCap: Object.freeze({ maxEvents: 60, windowSeconds: HOUR }),
    why: 'Server-priced at a flat 150; finite and identity-based in game.',
  }),
  maze: Object.freeze({
    id: 'maze', label: 'Maze progress', perEventMax: 500,
    rateCap: Object.freeze({ maxEvents: 40, windowSeconds: HOUR }),
    why: 'Server-priced at 100 (centre) or 6 (token); mirrors CAPS.maze.',
  }),
  objective: Object.freeze({
    id: 'objective', label: 'Space objective', perEventMax: 100_000,
    rateCap: Object.freeze({ maxEvents: 60, windowSeconds: HOUR }),
    why: 'Mirrors PER_EVENT_MAX.objective: the richest shipped tier pays 3,000, given '
      + 'the same headroom the platform gives it.',
  }),
  ore: Object.freeze({
    id: 'ore', label: 'Ore sold at dock', perEventMax: 500_000,
    rateCap: Object.freeze({ maxEvents: 120, windowSeconds: HOUR }),
    why: 'Mirrors PER_EVENT_MAX.ore: a full best-case hold is ~15,000 and hold tiers '
      + 'stack; a dock sale is deliberate and slow, so 120/h never bites honestly.',
  }),
  contract: Object.freeze({
    id: 'contract', label: 'Contract completed', perEventMax: 20_000,
    rateCap: Object.freeze({ maxEvents: 60, windowSeconds: HOUR }),
    why: 'Mirrors PER_EVENT_MAX.contract: shipped rewards top out at 336.',
  }),
  bounty: Object.freeze({
    id: 'bounty', label: 'Bounty collected', perEventMax: 10_000,
    rateCap: Object.freeze({ maxEvents: 400, windowSeconds: HOUR }),
    why: 'Mirrors PER_EVENT_MAX.bounty: an AlienShip lance pays 180; kills-rate window.',
  }),
});

export function serverCreditKind(id: string): ServerCreditKindSpec | null {
  return (Object.prototype.hasOwnProperty.call(SERVER_CREDIT_KINDS, id)
    && SERVER_CREDIT_KINDS[id]) || null;
}

export type ServerLedgerReason =
  | 'ok'
  | 'duplicate'
  | 'unknown_kind'
  | 'too_large'
  /** Over the kind's rate cap: recorded at zero, exactly as the global ledger does. */
  | 'capped'
  | 'insufficient'
  | 'invalid';

export interface ServerLedgerResult {
  applied: boolean;
  delta: number;
  /** The authoritative server balance after this call, whatever the outcome. */
  balance: number;
  reason: ServerLedgerReason;
}

function validKey(key: unknown): key is string {
  return typeof key === 'string' && key.length > 0 && key.length <= 200;
}

function scoped(serverId: string, playerId: string): [string, string] {
  const s = String(serverId ?? '').trim();
  const p = String(playerId ?? '').trim();
  if (!s || !p) throw new Error('serverCredits: a server id and a player id are required.');
  return [s, p];
}

/** This player's balance in this server. Zero when they have never earned. */
export async function serverBalance(
  db: Db,
  serverId: string,
  playerId: string
): Promise<number> {
  const [s, p] = scoped(serverId, playerId);
  const r = await db.query(
    `SELECT balance FROM server_credit_balances WHERE server_id = $1 AND player_id = $2`,
    [s, p]
  );
  return Number(r.rows[0]?.balance ?? 0);
}

async function lockedBalance(db: Db, serverId: string, playerId: string): Promise<number> {
  const r = await db.query(
    `SELECT balance FROM server_credit_balances
      WHERE server_id = $1 AND player_id = $2 FOR UPDATE`,
    [serverId, playerId]
  );
  return Number(r.rows[0]?.balance ?? 0);
}

/**
 * Insert the event, or discover its key has been used.
 *
 * `ON CONFLICT DO NOTHING` returning no row IS the duplicate signal — there is
 * no prior SELECT for a concurrent request to race against.
 */
async function insertEvent(
  db: Db,
  serverId: string,
  playerId: string,
  key: string,
  kind: string,
  detail: string | null,
  delta: number,
  balanceAfter: number
): Promise<boolean> {
  const r = await db.query(
    `INSERT INTO server_credit_events
       (server_id, player_id, event_key, kind, detail, delta, balance_after)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT (server_id, player_id, event_key) DO NOTHING
     RETURNING id`,
    [serverId, playerId, key, kind, detail, delta, balanceAfter]
  );
  return !!r.rows[0];
}

/** How many events of this kind this player has had in this server's window. */
async function countInWindow(
  db: Db,
  serverId: string,
  playerId: string,
  kind: string,
  windowSeconds: number
): Promise<number> {
  const r = await db.query(
    `SELECT COUNT(*)::int AS n FROM server_credit_events
      WHERE server_id = $1 AND player_id = $2 AND kind = $3
        AND created_at > NOW() - ($4 || ' seconds')::interval`,
    [serverId, playerId, kind, String(windowSeconds)]
  );
  return Number(r.rows[0]?.n ?? 0);
}

async function writeBalance(
  db: Db,
  serverId: string,
  playerId: string,
  next: number
): Promise<number> {
  const r = await db.query(
    `INSERT INTO server_credit_balances (server_id, player_id, balance)
     VALUES ($1, $2, $3)
     ON CONFLICT (server_id, player_id)
     DO UPDATE SET balance = EXCLUDED.balance, updated_at = NOW()
     RETURNING balance`,
    [serverId, playerId, next]
  );
  return Number(r.rows[0]?.balance ?? next);
}

export interface ServerEarnRequest {
  kind: keyof typeof SERVER_CREDIT_KINDS | string;
  /** What the owner's own content says this is worth. Bounded, not priced. */
  amount: number;
  detail?: string;
  /** Idempotency key. The same key never pays twice in the same server. */
  eventKey: string;
}

/**
 * Credit a player inside one server.
 *
 * The amount comes from the owner's content and is bounded here. The kind is
 * looked up rather than trusted, so a request naming a kind this module does not
 * know is refused and nothing is recorded — the same answer `applyCreditEvent`
 * gives, for the same reason: nothing about the request is trustworthy enough
 * to record.
 */
export async function earnServerCredits(
  db: Db,
  serverId: string,
  playerId: string,
  request: ServerEarnRequest
): Promise<ServerLedgerResult> {
  const [s, p] = scoped(serverId, playerId);
  const spec = serverCreditKind(String(request?.kind ?? ''));
  if (!spec) {
    return { applied: false, delta: 0, balance: await serverBalance(db, s, p), reason: 'unknown_kind' };
  }
  const amount = Number(request.amount);
  if (!validKey(request.eventKey) || !Number.isInteger(amount) || amount <= 0) {
    return { applied: false, delta: 0, balance: await serverBalance(db, s, p), reason: 'invalid' };
  }
  if (amount > spec.perEventMax) {
    return { applied: false, delta: 0, balance: await serverBalance(db, s, p), reason: 'too_large' };
  }

  await db.query('BEGIN');
  try {
    const balance = await lockedBalance(db, s, p);
    /* The rate cap, where the kind carries one — the same spirit as the global
     * ledger's CAPS: bound the YIELD of a forged stream, and record the capped
     * attempt at zero rather than hiding it, because a capped player is exactly
     * the one worth being able to see afterwards. */
    if (spec.rateCap) {
      const used = await countInWindow(db, s, p, spec.id, spec.rateCap.windowSeconds);
      if (used >= spec.rateCap.maxEvents) {
        const zeroed = await insertEvent(
          db, s, p, request.eventKey, spec.id, request.detail ?? null, 0, balance
        );
        // COMMIT the zero row; a duplicate key is a replay and keeps its answer.
        await db.query(zeroed ? 'COMMIT' : 'ROLLBACK');
        return {
          applied: false, delta: 0, balance,
          reason: zeroed ? 'capped' : 'duplicate',
        };
      }
    }
    const next = balance + amount;
    const fresh = await insertEvent(
      db, s, p, request.eventKey, spec.id, request.detail ?? null, amount, next
    );
    if (!fresh) {
      await db.query('ROLLBACK');
      return { applied: false, delta: 0, balance, reason: 'duplicate' };
    }
    const written = await writeBalance(db, s, p, next);
    await db.query('COMMIT');
    return { applied: true, delta: amount, balance: written, reason: 'ok' };
  } catch (err) {
    await db.query('ROLLBACK').catch(() => {});
    throw err;
  }
}

export interface ServerSpendRequest {
  cost: number;
  detail?: string;
  eventKey: string;
}

/**
 * Debit a player inside a transaction the CALLER owns — the server-ledger
 * mirror of the global ledger's `debitInTransaction`, and it exists for the
 * same reason: a scoped marketplace purchase must debit the credits, decrement
 * the stock and record the sale in ONE transaction, and Postgres has no nested
 * `BEGIN`. Contract, identically: the caller has already issued `BEGIN`, and on
 * any result where `applied` is false the caller must `ROLLBACK`.
 */
export async function spendServerCreditsInTransaction(
  db: Db,
  serverId: string,
  playerId: string,
  request: ServerSpendRequest
): Promise<ServerLedgerResult> {
  const [s, p] = scoped(serverId, playerId);
  const cost = Number(request?.cost);
  if (!validKey(request?.eventKey) || !Number.isInteger(cost) || cost <= 0) {
    return { applied: false, delta: 0, balance: await serverBalance(db, s, p), reason: 'invalid' };
  }

  const balance = await lockedBalance(db, s, p);
  if (balance < cost) {
    return { applied: false, delta: 0, balance, reason: 'insufficient' };
  }
  const next = balance - cost;
  const fresh = await insertEvent(
    db, s, p, request.eventKey, 'spend', request.detail ?? null, -cost, next
  );
  if (!fresh) {
    return { applied: false, delta: 0, balance, reason: 'duplicate' };
  }
  const written = await writeBalance(db, s, p, next);
  return { applied: true, delta: -cost, balance: written, reason: 'ok' };
}

/**
 * Debit a player inside one server, refusing to overdraw.
 *
 * The balance stays locked for the whole read-decide-write, so two purchases
 * that would each succeed alone cannot both succeed together — the property the
 * global ledger states plainly and the marketplace never had before Phase 2.
 *
 * The transaction, and nothing else: the work is `spendServerCreditsInTransaction`,
 * exactly as the global `spendCredits` is `debitInTransaction` plus a
 * transaction. Two copies of "lock, check, insert, write" is one copy that
 * eventually disagrees with the other.
 */
export async function spendServerCredits(
  db: Db,
  serverId: string,
  playerId: string,
  request: ServerSpendRequest
): Promise<ServerLedgerResult> {
  await db.query('BEGIN');
  try {
    const result = await spendServerCreditsInTransaction(db, serverId, playerId, request);
    await db.query(result.applied ? 'COMMIT' : 'ROLLBACK');
    return result;
  } catch (err) {
    await db.query('ROLLBACK').catch(() => {});
    throw err;
  }
}

/**
 * What a prior event with this key did, or null if the key is unused.
 *
 * For the scoped marketplace purchase's replay check: a retried request must
 * REPORT THE ORIGINAL OUTCOME rather than being re-evaluated — re-evaluating
 * sees the already-reduced balance and answers `insufficient` for a purchase
 * that in fact succeeded.
 */
export async function serverLedgerPriorEvent(
  db: Db,
  serverId: string,
  playerId: string,
  eventKey: string
): Promise<{ delta: number } | null> {
  const [s, p] = scoped(serverId, playerId);
  if (!validKey(eventKey)) return null;
  const r = await db.query(
    `SELECT delta FROM server_credit_events
      WHERE server_id = $1 AND player_id = $2 AND event_key = $3`,
    [s, p, eventKey]
  );
  return r.rows[0] ? { delta: Number(r.rows[0].delta) } : null;
}

/** Every server balance this player holds, keyed by server id. */
export async function serverBalancesFor(
  db: Db,
  playerId: string
): Promise<Record<string, number>> {
  const r = await db.query(
    `SELECT server_id, balance FROM server_credit_balances WHERE player_id = $1`,
    [String(playerId)]
  );
  const out: Record<string, number> = {};
  for (const row of r.rows) out[String(row.server_id)] = Number(row.balance ?? 0);
  return out;
}

export interface ServerCreditEntry {
  kind: string;
  detail: string | null;
  delta: number;
  balanceAfter: number;
  createdAt: string;
}

/** Recent movement in one server, newest first. For the owner's dashboard. */
export async function serverCreditHistory(
  db: Db,
  serverId: string,
  playerId: string,
  limit = 50
): Promise<ServerCreditEntry[]> {
  const [s, p] = scoped(serverId, playerId);
  const r = await db.query(
    `SELECT kind, detail, delta, balance_after, created_at
       FROM server_credit_events
      WHERE server_id = $1 AND player_id = $2
      ORDER BY created_at DESC, id DESC
      LIMIT $3`,
    [s, p, Math.max(1, Math.min(200, Math.trunc(limit) || 50))]
  );
  return r.rows.map((row) => ({
    kind: String(row.kind),
    detail: row.detail == null ? null : String(row.detail),
    delta: Number(row.delta),
    balanceAfter: Number(row.balance_after),
    createdAt: String(row.created_at),
  }));
}
