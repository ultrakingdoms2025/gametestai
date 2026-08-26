/**
 * Telemetry ingest — the events table and everything that writes it.
 *
 * ── What this is, and what it is refused permission to become ─────────────
 *
 * Brief 5.7 asks for product KPIs and the tree had NO analytics of any kind:
 * no package, no event table, nothing posting a gameplay event anywhere. The
 * only KPI surface was four business counters on the admin dashboard. This
 * module is the missing layer: a write-only firehose of small gameplay facts,
 * read back only by the admin KPI page.
 *
 * WRITE-ONLY is a design rule, not a description. Telemetry never touches
 * balances, never joins the credit ledger, never feeds anything back into the
 * game. The economy separation is sacred: `credits_delta` events here are
 * OBSERVATIONS of `Economy`'s bus traffic (the measurement brief 5.5 was
 * explicitly deferred pending — see `src/systems/Charters.js:109-114`), and an
 * observation that could move a balance would be a second credit ledger with
 * none of the ledger's guarantees. Nothing in this file reads or writes
 * `players.credit_balance` or `credit_events`.
 *
 * ── The allowlist, and the free-text lesson ───────────────────────────────
 *
 * `kind` is a closed set. The marketplace's `game_action` free-text column is
 * the precedent: free text written today is a 500 tomorrow, because a reader
 * eventually branches on values nobody controls. An unknown kind is refused
 * per-event (the rest of the batch still lands), so a client shipping a new
 * event name fails VISIBLY in the ingest counts rather than silently seeding
 * a vocabulary no query can enumerate. Adding a kind is a two-line change:
 * here, and in the client map in `src/systems/Telemetry.js`.
 *
 * ── Schema ownership and the `server_id` lesson ───────────────────────────
 *
 * This module owns `telemetry_events` and ensures it inline, per repo
 * convention (no migration framework). The admin KPI reader
 * (`admin/lib/kpi.ts`) ensures the SAME schema before its first read, because
 * an ALTER living in a module a read path never calls has already shipped two
 * production 500s in this repo. If you add a column here, add it there.
 *
 * `player_id` is TEXT to match `players.id` (TEXT holding UUID-shaped
 * strings — see the stand-in note in creditLedger.test.ts) and is DELIBERATELY
 * not a foreign key: telemetry must never fail an insert because a player row
 * is missing, and must never couple the firehose to the tables the economy
 * owns.
 *
 * ── Retention ─────────────────────────────────────────────────────────────
 *
 * Events are kept for 90 days. There is no scheduler in this stack, so the
 * pruning story is a documented statement rather than a cron:
 *
 *     DELETE FROM telemetry_events WHERE server_ts < NOW() - interval '90 days';
 *
 * `pruneTelemetryEvents` below runs exactly that. Until someone wires it to a
 * Vercel cron or runs it from a maintenance session, the table grows — at the
 * ingest caps below that is bounded by rate limits, not by time, and the KPI
 * queries all window on `server_ts` so an unpruned table costs disk, not
 * correctness.
 *
 * ── Rate limits (decided here, enforced in `ingestTelemetryBatch`) ────────
 *
 * Signed-in:  3600 events / rolling hour / player. The busiest legitimate
 *             session is combat-heavy: the credit ledger caps kills at 400/h,
 *             and each kill can produce a kill event plus a credits_delta,
 *             so ~1000/h is a realistic ceiling; 3600 is generous headroom
 *             without letting one client write millions of rows.
 * Anonymous:  600 events / rolling hour / IP (keyed hash — see `hashIp`).
 *             Anonymous sessions can mint a fresh session_id per request, so
 *             the session id is NOT the limit key; the IP hash is, with the
 *             session_id as fallback when no address is resolvable.
 * Per batch:  100 events (mirrors /api/game/credits), body ≤ 256 KB.
 *
 * A rate-limited batch is refused whole with `rate_limited` — the client
 * drops silently; telemetry is lossy by design and must never block gameplay.
 */

import type { Client, PoolClient } from 'pg';
import { createHmac } from 'node:crypto';

type Db = Client | PoolClient;

/* ────────────────────────────────────────────────────────────────────────── */
/* Vocabulary                                                                 */
/* ────────────────────────────────────────────────────────────────────────── */

/**
 * The closed event vocabulary. Every name maps 1:1 to a REAL bus event the
 * game already emits (verified by grep, not aspiration — the world-06 lesson:
 * a gate that measures something the game does not do is worse than no gate).
 *
 *   session_start     ← game:started            one per boot, marks the session
 *   world_enter       ← world:changed           world popularity
 *   quest_completed   ← quests:quest:complete   quest completions/day
 *   minigame_started  ← minigame:started        plays
 *   minigame_finished ← minigame:finished       plays, replays, win rate
 *   race_finished     ← race:finished           circuit engagement
 *   onboarding_step   ← onboarding:step         the onboarding funnel
 *   market_trade      ← market:trade            vendor buy/sell volume
 *   npc_killed        ← npc:killed              combat engagement
 *   player_died       ← player:died             difficulty / death loops
 *   player_respawned  ← player:respawned        death-loop closure
 *   credits_delta     ← credits:changed         brief 5.5's deferred economy
 *                                               measurement: reason + delta of
 *                                               every add/spend, never `set`,
 *                                               never a balance
 */
export const TELEMETRY_KINDS = [
  'session_start',
  'world_enter',
  'quest_completed',
  'minigame_started',
  'minigame_finished',
  'race_finished',
  'onboarding_step',
  'market_trade',
  'npc_killed',
  'player_died',
  'player_respawned',
  'credits_delta',
] as const;

export type TelemetryKind = (typeof TELEMETRY_KINDS)[number];

const KIND_SET: ReadonlySet<string> = new Set(TELEMETRY_KINDS);

/* ────────────────────────────────────────────────────────────────────────── */
/* Limits — decided once, written down, used by route and tests alike         */
/* ────────────────────────────────────────────────────────────────────────── */

export const TELEMETRY_LIMITS = {
  /** Events per request. Mirrors /api/game/credits' MAX_EVENTS. */
  maxEventsPerBatch: 100,
  /** Raw request body ceiling, before JSON.parse ever runs. */
  maxBodyBytes: 256 * 1024,
  /** Serialized `detail` ceiling per event, in bytes of JSON. */
  maxDetailBytes: 1024,
  /** `world` / `kind` string length ceiling. */
  maxNameChars: 64,
  /** `session_id` accepted length band. */
  sessionIdMin: 8,
  sessionIdMax: 64,
  /** Rolling-hour event caps. */
  signedInPerHour: 3600,
  anonymousPerHour: 600,
  /** client_ts sanity window around NOW, either direction. */
  clientTsSkewMs: 48 * 60 * 60 * 1000,
  /** Retention, in days. The documented DELETE below uses the same number. */
  retentionDays: 90,
} as const;

/* ────────────────────────────────────────────────────────────────────────── */
/* Schema                                                                     */
/* ────────────────────────────────────────────────────────────────────────── */

let schemaEnsured = false;

/**
 * Idempotent, memoised per process (like site/lib/db.ts's ensureSchema —
 * telemetry ingest must be cheap, and a warm lambda should not re-run six
 * DDL statements per flush). Cold lambdas pay once.
 */
export async function ensureTelemetrySchema(db: Db): Promise<void> {
  if (schemaEnsured) return;
  await db.query(`
    CREATE TABLE IF NOT EXISTS telemetry_events (
      id         BIGSERIAL PRIMARY KEY,
      player_id  TEXT,
      session_id TEXT NOT NULL,
      kind       TEXT NOT NULL,
      world      TEXT,
      detail     JSONB NOT NULL DEFAULT '{}'::jsonb,
      client_ts  TIMESTAMPTZ,
      server_ts  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      ip_hash    TEXT
    )
  `);
  // Serves session length / sessions-per-day (group by session, window by time).
  await db.query(`
    CREATE INDEX IF NOT EXISTS telemetry_events_session_ts_idx
      ON telemetry_events (session_id, server_ts)
  `);
  // Serves the signed-in rate limit and D1/D7 (per-player, time-windowed).
  await db.query(`
    CREATE INDEX IF NOT EXISTS telemetry_events_player_ts_idx
      ON telemetry_events (player_id, server_ts) WHERE player_id IS NOT NULL
  `);
  // Serves every per-kind KPI window (quest completions/day, funnel, ...).
  await db.query(`
    CREATE INDEX IF NOT EXISTS telemetry_events_kind_ts_idx
      ON telemetry_events (kind, server_ts)
  `);
  // Serves the anonymous rate limit.
  await db.query(`
    CREATE INDEX IF NOT EXISTS telemetry_events_ip_ts_idx
      ON telemetry_events (ip_hash, server_ts) WHERE ip_hash IS NOT NULL
  `);
  schemaEnsured = true;
}

/** Test hook: forget that the schema was ensured (fresh databases per suite). */
export function _resetTelemetrySchemaMemo(): void {
  schemaEnsured = false;
}

/**
 * The retention statement, verbatim, so a maintenance session can copy it.
 * `pruneTelemetryEvents` executes the same thing with the same default.
 */
export const PRUNE_TELEMETRY_SQL = `DELETE FROM telemetry_events WHERE server_ts < NOW() - make_interval(days => $1)`;

export async function pruneTelemetryEvents(
  db: Db,
  days: number = TELEMETRY_LIMITS.retentionDays
): Promise<number> {
  const d = Math.max(1, Math.trunc(days) || TELEMETRY_LIMITS.retentionDays);
  const res = await db.query(PRUNE_TELEMETRY_SQL, [d]);
  return res.rowCount ?? 0;
}

/* ────────────────────────────────────────────────────────────────────────── */
/* Per-event validation                                                       */
/* ────────────────────────────────────────────────────────────────────────── */

export type TelemetryRefusal =
  | 'not_an_object'
  | 'unknown_kind'
  | 'detail_too_large'
  | 'bad_world';

export type CleanTelemetryEvent = {
  kind: TelemetryKind;
  world: string | null;
  /** Serialized once, here, so the insert never re-stringifies. */
  detailJson: string;
  /** Null when absent, unparsable, or outside the skew window. */
  clientTs: Date | null;
};

export type SanitizeResult =
  | { ok: true; event: CleanTelemetryEvent }
  | { ok: false; reason: TelemetryRefusal };

const SESSION_ID_RE = /^[A-Za-z0-9:_-]+$/;

export function isValidSessionId(v: unknown): v is string {
  return (
    typeof v === 'string' &&
    v.length >= TELEMETRY_LIMITS.sessionIdMin &&
    v.length <= TELEMETRY_LIMITS.sessionIdMax &&
    SESSION_ID_RE.test(v)
  );
}

/**
 * Refuse individual bad events, accept the rest — never throw. Every branch
 * here answers with a reason the ingest response can count, because "never
 * 500 on garbage" is a contract, and garbage is the expected input of any
 * endpoint the open internet can POST to.
 */
export function sanitizeTelemetryEvent(raw: unknown, now: Date = new Date()): SanitizeResult {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return { ok: false, reason: 'not_an_object' };
  }
  const e = raw as Record<string, unknown>;

  const kind = e.kind;
  if (typeof kind !== 'string' || !KIND_SET.has(kind)) {
    return { ok: false, reason: 'unknown_kind' };
  }

  let world: string | null = null;
  if (e.world !== undefined && e.world !== null) {
    if (typeof e.world !== 'string' || e.world.length > TELEMETRY_LIMITS.maxNameChars) {
      return { ok: false, reason: 'bad_world' };
    }
    world = e.world || null;
  }

  // `detail` must be a small plain object. Anything else (missing, primitive,
  // array) collapses to {} rather than being refused — the kind alone is still
  // a countable fact — but an OVERSIZED object is refused, because truncating
  // JSON produces JSON nobody can parse and accepting it unbounded is how a
  // detail column becomes a blob store.
  let detailJson = '{}';
  const d = e.detail;
  if (typeof d === 'object' && d !== null && !Array.isArray(d)) {
    let s: string;
    try {
      s = JSON.stringify(d);
    } catch {
      return { ok: false, reason: 'detail_too_large' }; // circular = hostile; refuse
    }
    if (typeof s !== 'string') s = '{}';
    if (Buffer.byteLength(s, 'utf8') > TELEMETRY_LIMITS.maxDetailBytes) {
      return { ok: false, reason: 'detail_too_large' };
    }
    detailJson = s;
  }

  // client_ts: epoch milliseconds. The server's clock is the authority for
  // every KPI; the client's is kept only as a debugging aid, and only when it
  // is sane. A skewed clock nulls the field rather than refusing the event.
  let clientTs: Date | null = null;
  const ts = Number(e.client_ts);
  if (Number.isFinite(ts)) {
    const skew = Math.abs(ts - now.getTime());
    if (skew <= TELEMETRY_LIMITS.clientTsSkewMs) clientTs = new Date(ts);
  }

  return { ok: true, event: { kind: kind as TelemetryKind, world, detailJson, clientTs } };
}

/* ────────────────────────────────────────────────────────────────────────── */
/* Anonymous identity for rate limiting                                       */
/* ────────────────────────────────────────────────────────────────────────── */

/**
 * A keyed hash of the caller's address — never the raw IP. Stored only on
 * anonymous rows (signed-in rows are keyed by player_id and carry NULL here),
 * pruned with everything else at 90 days. Keyed with the app secret so the
 * column is useless as a rainbow-table target.
 */
export function hashIp(ip: string | null | undefined): string | null {
  const v = (ip ?? '').trim();
  if (!v) return null;
  const secret =
    process.env.NEXTAUTH_SECRET ?? process.env.APP_SECRET ?? 'dev-secret-change-me';
  return createHmac('sha256', secret).update(v).digest('hex').slice(0, 32);
}

/* ────────────────────────────────────────────────────────────────────────── */
/* Ingest                                                                     */
/* ────────────────────────────────────────────────────────────────────────── */

export type IngestInput = {
  sessionId: string;
  /** From the session, NEVER the body. Null for anonymous callers. */
  playerId: string | null;
  /** Anonymous rate-limit key (hashIp output). Ignored when playerId is set. */
  ipHash: string | null;
  events: unknown[];
  now?: Date;
};

export type IngestOutcome = {
  ok: boolean;
  /** Set when the whole batch was refused. */
  refusedBatch?: 'rate_limited';
  accepted: number;
  refused: number;
  /** Refusal tallies by reason, only for reasons that occurred. */
  reasons: Partial<Record<TelemetryRefusal, number>>;
};

/**
 * Validate, rate-limit, and land a batch in ONE multi-row INSERT.
 *
 * The rate check is a single indexed COUNT over the rolling hour — the same
 * shape the credit ledger's caps use, and the cheapest thing that survives
 * two lambdas (an in-process bucket would not). It counts rows already
 * LANDED plus the size of this batch, so a caller cannot creep past the cap
 * in 100-event slices.
 */
export async function ingestTelemetryBatch(db: Db, input: IngestInput): Promise<IngestOutcome> {
  const now = input.now ?? new Date();
  await ensureTelemetrySchema(db);

  // ── Rate limit ──────────────────────────────────────────────────────────
  const signedIn = !!input.playerId;
  const cap = signedIn
    ? TELEMETRY_LIMITS.signedInPerHour
    : TELEMETRY_LIMITS.anonymousPerHour;

  let used = 0;
  if (signedIn) {
    const r = await db.query(
      `SELECT COUNT(*)::int AS n FROM telemetry_events
        WHERE player_id = $1 AND server_ts > NOW() - interval '1 hour'`,
      [input.playerId]
    );
    used = Number(r.rows[0]?.n ?? 0);
  } else if (input.ipHash) {
    const r = await db.query(
      `SELECT COUNT(*)::int AS n FROM telemetry_events
        WHERE ip_hash = $1 AND server_ts > NOW() - interval '1 hour'`,
      [input.ipHash]
    );
    used = Number(r.rows[0]?.n ?? 0);
  } else {
    // No address resolvable: fall back to the session id. Weaker (an
    // anonymous client can mint session ids) but never weaker than nothing,
    // and the per-batch cap still bounds each request.
    const r = await db.query(
      `SELECT COUNT(*)::int AS n FROM telemetry_events
        WHERE session_id = $1 AND server_ts > NOW() - interval '1 hour'`,
      [input.sessionId]
    );
    used = Number(r.rows[0]?.n ?? 0);
  }

  if (used + input.events.length > cap) {
    return {
      ok: false,
      refusedBatch: 'rate_limited',
      accepted: 0,
      refused: input.events.length,
      reasons: {},
    };
  }

  // ── Per-event validation ────────────────────────────────────────────────
  const clean: CleanTelemetryEvent[] = [];
  const reasons: Partial<Record<TelemetryRefusal, number>> = {};
  for (const raw of input.events) {
    const res = sanitizeTelemetryEvent(raw, now);
    if (res.ok) clean.push(res.event);
    else reasons[res.reason] = (reasons[res.reason] ?? 0) + 1;
  }

  // ── One INSERT for the whole accepted set ───────────────────────────────
  if (clean.length) {
    const cols = 7; // player_id, session_id, kind, world, detail, client_ts, ip_hash
    const values: unknown[] = [];
    const tuples: string[] = [];
    clean.forEach((e, i) => {
      const b = i * cols;
      tuples.push(
        `($${b + 1}, $${b + 2}, $${b + 3}, $${b + 4}, $${b + 5}::jsonb, $${b + 6}, $${b + 7})`
      );
      values.push(
        input.playerId,
        input.sessionId,
        e.kind,
        e.world,
        e.detailJson,
        e.clientTs,
        // ip_hash rides only on anonymous rows: signed-in rows are keyed and
        // rate-limited by player_id, and storing the address hash alongside a
        // durable identity would be retention of a thing nothing reads.
        signedIn ? null : input.ipHash
      );
    });
    await db.query(
      `INSERT INTO telemetry_events
         (player_id, session_id, kind, world, detail, client_ts, ip_hash)
       VALUES ${tuples.join(', ')}`,
      values
    );
  }

  return {
    ok: true,
    accepted: clean.length,
    refused: input.events.length - clean.length,
    reasons,
  };
}
