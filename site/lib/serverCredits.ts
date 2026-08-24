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

export interface ServerCreditKindSpec {
  readonly id: string;
  readonly label: string;
  /** The most one event of this kind may ever be worth. */
  readonly perEventMax: number;
  readonly why: string;
}

/**
 * What a server ledger will pay for, and the most it will pay at once.
 *
 * The ceilings are generous against real owner content and finite against a
 * forged request. They are not a price list: the owner sets the price, and this
 * says how large a single one may be.
 */
export const SERVER_CREDIT_KINDS: Readonly<Record<string, ServerCreditKindSpec>> = Object.freeze({
  quest: Object.freeze({
    id: 'quest', label: 'Quest reward', perEventMax: 5_000,
    why: "The owner sets reward_credits; this bounds one payout, not the owner's economy.",
  }),
  sell: Object.freeze({
    id: 'sell', label: 'Sold to the market', perEventMax: 5_000,
    why: 'Bounded by the same reasoning as a quest reward.',
  }),
  grant: Object.freeze({
    id: 'grant', label: 'Owner grant', perEventMax: 5_000,
    why: 'An owner handing a member credits directly. Audited, and bounded per event.',
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
 * Debit a player inside one server, refusing to overdraw.
 *
 * The balance stays locked for the whole read-decide-write, so two purchases
 * that would each succeed alone cannot both succeed together — the property the
 * global ledger states plainly and the marketplace never had before Phase 2.
 */
export async function spendServerCredits(
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

  await db.query('BEGIN');
  try {
    const balance = await lockedBalance(db, s, p);
    if (balance < cost) {
      await db.query('ROLLBACK');
      return { applied: false, delta: 0, balance, reason: 'insufficient' };
    }
    const next = balance - cost;
    const fresh = await insertEvent(
      db, s, p, request.eventKey, 'spend', request.detail ?? null, -cost, next
    );
    if (!fresh) {
      await db.query('ROLLBACK');
      return { applied: false, delta: 0, balance, reason: 'duplicate' };
    }
    const written = await writeBalance(db, s, p, next);
    await db.query('COMMIT');
    return { applied: true, delta: -cost, balance: written, reason: 'ok' };
  } catch (err) {
    await db.query('ROLLBACK').catch(() => {});
    throw err;
  }
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
