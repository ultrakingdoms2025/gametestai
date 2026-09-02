import type { Client, PoolClient } from 'pg';

/**
 * The progress ledger: durable, cross-device player progress that MERGES.
 *
 * ── What this is not ───────────────────────────────────────────────────────
 *
 * It is not the credit ledger and it does not borrow its adversarial framing.
 * Credits are money, so `creditLedger` prices every event server-side and caps
 * what it cannot price. Relics found and best lap times are not money. The
 * server still cannot verify that gameplay happened -- there is no server-side
 * simulation -- and pretending otherwise here would buy nothing.
 *
 * What this file is for is LOSS. Today a player's relics, viewpoints, mined
 * seams, objectives and trial times live in one browser's localStorage. Play on
 * a phone, come back to a PC, and the PC's stale copy overwrites the phone's
 * progress and then pushes itself up as the new truth. Nobody is told.
 *
 * ── Why merge rather than arbitrate ────────────────────────────────────────
 *
 * Almost all of this data is MONOTONE. A relic once found is found forever, a
 * seam once worked out never refills, a best time only improves. Monotone data
 * has a merge that cannot lose: union for sets, LEAST/GREATEST for numbers.
 *
 * That merge is commutative and idempotent, and those two properties are the
 * whole design. Commutative means it does not matter which device syncs first.
 * Idempotent means a retried or replayed request changes nothing. Together they
 * mean NO DEVICE CLOCK IS CONSULTED ANYWHERE IN THIS FILE. Clocks disagree --
 * a phone a few minutes fast would otherwise silently win every conflict and
 * delete the other device's afternoon.
 *
 * ── Where the guarantees actually live ─────────────────────────────────────
 *
 * The union is `UNIQUE (player_id, kind, scope, item_key)` plus `ON CONFLICT DO
 * NOTHING`. The numeric merge is the same constraint plus `DO UPDATE SET value
 * = LEAST(...)`. Both are single statements: there is no prior SELECT for a
 * concurrent request to race against, and no Set in a process that a second
 * lambda would not share. The same argument `creditLedger` makes for its
 * idempotency, for the same reason.
 *
 * **The client never chooses the merge rule.** It sends a kind and a value; the
 * server looks the rule up in `KINDS` below. A client that could ask for
 * GREATEST on a lap time could write itself a world record by asking nicely.
 *
 * Neither guarantee can be demonstrated without a real Postgres, which is why
 * `progressLedger.test.ts` runs against one.
 */

/** Any pg client — a plain Client in tests, a pooled one in a route. */
type Db = Client | PoolClient;

/** How two numbers for the same key reconcile. Server-side knowledge only. */
export type MergeMode = 'max' | 'min';

/**
 * Every kind of progress this ledger accepts, and how it merges.
 *
 * A `set` kind is membership: which relics, which viewpoints, which seams. A
 * `value` kind is a number per key, reconciled by `mode`.
 *
 * An unknown kind is refused rather than stored. A ledger that accepted
 * anything would become a second untyped blob, which is what this replaces.
 */
export const KINDS: Readonly<Record<string, { shape: 'set' } | { shape: 'value'; mode: MergeMode }>> =
  Object.freeze({
    /* Sets. `scope` is the world id where the concept is per-world. */
    relic: { shape: 'set' },
    relic_paid: { shape: 'set' },
    viewpoint: { shape: 'set' },
    chart: { shape: 'set' },
    viewpoint_paid: { shape: 'set' },
    mining: { shape: 'set' },
    wing: { shape: 'set' },
    objective_paid: { shape: 'set' },
    // The mission spine. `charter` is the set of world ids whose record is
    // complete; `deed` is scoped per world and holds the named one-off acts
    // (first trade, first mount, the centre of the Coil) that no other system
    // keeps. Both are unions of ids, which is what this ledger is for.
    //
    // Deliberately NOT here: the learned per-world ROSTERS. They are a record
    // of what a world published, not of what a player did - the same reason
    // `elements` and `wingRoster` stay local (see ProgressSync's header). A
    // roster rebuilds itself the next time the player walks in, and syncing one
    // would let a device running an older build hand another device a
    // denominator its own world no longer has.
    charter: { shape: 'set' },
    deed: { shape: 'set' },
    // The opening sequence, by step id. Small, monotone, and the reason a
    // player who finished the tutorial on a phone is not shown it again on a
    // desktop - which is exactly what signing in is sold on.
    onboarding: { shape: 'set' },
    // The retention loop. `retention` is the set of period ids already claimed
    // ('daily/2026-08-23', 'weekly/2026-W34'); `season` is scoped by season id
    // and holds the worlds whose record was completed inside that window.
    //
    // SETS, deliberately, and not values. The only number the loop has is a run
    // of consecutive days, and there is no honest merge rule for one: MAX would
    // mean "whichever device's clock ran furthest ahead wins". So it is derived
    // on read from the day ids on the device asking, and never travels.
    //
    // Both are unions of ids, which is what this ledger is FOR, and both are
    // grow-only by construction: a missed day is a day absent from the set, and
    // a season turning over adds an id rather than replacing one. Nothing here
    // ever needs to come out, which is what makes a never-subtracting merge the
    // right merge rather than merely a safe one.
    retention: { shape: 'set' },
    season: { shape: 'set' },

    /* Values. */
    // A best time, and the reason `mode` exists at all: every other number here
    // grows, and a lap time that grew would be a player's record being deleted
    // by their worse run on another device. (It was the only 'min' in the file
    // until `race` joined it below, which is the same claim about the same
    // hazard on a different clock.)
    trial: { shape: 'value', mode: 'min' },
    // A circuit best, scoped by world and keyed `circuitId/difficulty`. The
    // SECOND 'min' in the file, and it is one for the same reason `trial` is:
    // a slower run on another device is not news, and a last-write-wins sync
    // would let it delete a personal best. Races persisted nothing at all
    // before the mission drop - not locally and not here.
    race: { shape: 'value', mode: 'min' },
    kills: { shape: 'value', mode: 'max' },
    ore: { shape: 'value', mode: 'max' },
    // 'sighted' and 'landed' encode as 1 and 2, so GREATEST is "the furthest
    // this player ever got with that body" and a sighting cannot un-land it.
    survey: { shape: 'value', mode: 'max' },
    mining_stat: { shape: 'value', mode: 'max' },
    // Ladder rungs already paid - a receipt, like relic_paid, but ordered, so
    // the higher rung subsumes the lower and GREATEST is exactly right.
    tier: { shape: 'value', mode: 'max' },
  });

export type ProgressKind = keyof typeof KINDS;

/* Bounds. Generous against real play -- a world holds up to 110 relics and
 * there are six worlds -- and finite, so a forged request cannot ask the
 * database to store a novel. */
const MAX_KEYS_PER_GROUP = 4000;
const MAX_GROUPS = 64;
const MAX_KEY_LEN = 64;
const MAX_SCOPE_LEN = 64;

/**
 * How many NEW keys one (kind, scope) may gain inside one window.
 *
 * ── The hole this closes ──────────────────────────────────────────────────
 *
 * The bounds above cap the size of ONE request. They cap nothing about the
 * rate, so a single well-formed POST could award every relic, viewpoint,
 * charter and deed in the game at once -- and because this ledger never
 * subtracts and had no revoke path, that forged claim was PERMANENT. Nothing
 * could take it back short of hand-written SQL.
 *
 * The two halves of the answer are here and in `revokeProgressItems` below:
 * bound how fast a claim can arrive, and make a claim that got through
 * reversible by an operator.
 *
 * ── Why the number is what it is ──────────────────────────────────────────
 *
 * A world holds up to 110 relics, so 500 new keys of one kind in one world in
 * one hour is several worlds' worth of discovery at a pace nobody plays at. The
 * failure mode this file names is LOSS, so the cap is set where an honest
 * player cannot reach it and the excess is REPORTED rather than silently
 * dropped -- the caller gets the (kind, scope) pairs that were trimmed, so a
 * client that somehow hits one can say so instead of quietly losing progress.
 */
const MAX_NEW_KEYS_PER_WINDOW = 500;
const DELTA_WINDOW_SECONDS = 3600;

export interface ItemGroup {
  kind: string;
  /** World id, or '' for the kinds that are not per-world. */
  scope?: string;
  keys: string[];
}

export interface ValueEntry {
  kind: string;
  scope?: string;
  key: string;
  value: number;
}

export interface ProgressPayload {
  items?: ItemGroup[];
  values?: ValueEntry[];
}

export interface ProgressState {
  items: Record<string, Record<string, string[]>>;
  values: Record<string, Record<string, Record<string, number>>>;
}

export interface MergeResult {
  /** The merged state, authoritative, for the client to adopt. */
  state: ProgressState;
  /** Rows genuinely added or improved. Zero means the payload told us nothing new. */
  changed: number;
  /** Kinds the payload named that this ledger does not know. Reported, not fatal. */
  rejected: string[];
  /**
   * `kind/scope` pairs whose window budget was exhausted, so some keys in the
   * payload were not stored. Reported rather than silent: a client that hits
   * one has either found a bug or is being throttled, and both are things
   * somebody needs to be able to see.
   */
  capped: string[];
}

export async function ensureProgressSchema(db: Db): Promise<void> {
  await db.query(`
    CREATE TABLE IF NOT EXISTS player_progress_items (
      -- TEXT, not UUID, for the same measured reason credit_events gives:
      -- production's players.id is TEXT and Postgres refuses a UUID -> TEXT
      -- foreign key outright.
      player_id  TEXT NOT NULL REFERENCES players(id) ON DELETE CASCADE,
      kind       TEXT NOT NULL,
      scope      TEXT NOT NULL DEFAULT '',
      item_key   TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  // The union guarantee. Every set merge in this file leans on it.
  await db.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS player_progress_items_idx
      ON player_progress_items (player_id, kind, scope, item_key)
  `);
  /* The index `readFirstReports` runs on.
   *
   * Leading with (kind, scope) because that pair is always an equality in that
   * query, then `item_key` because the answer is grouped by it, then
   * `created_at` because the aggregate is a MIN over it — so the plan is a range
   * scan that finds each key's earliest row at the front of its own run rather
   * than a sort of every relic every member has ever recorded. The existing
   * unique index leads with `player_id`, which that query does not constrain at
   * all, so it could not serve this. */
  await db.query(`
    CREATE INDEX IF NOT EXISTS player_progress_items_first_idx
      ON player_progress_items (kind, scope, item_key, created_at)
  `);

  await db.query(`
    CREATE TABLE IF NOT EXISTS player_progress_values (
      player_id  TEXT NOT NULL REFERENCES players(id) ON DELETE CASCADE,
      kind       TEXT NOT NULL,
      scope      TEXT NOT NULL DEFAULT '',
      item_key   TEXT NOT NULL,
      value      BIGINT NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await db.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS player_progress_values_idx
      ON player_progress_values (player_id, kind, scope, item_key)
  `);

  /* The Phase 7 column, ensured HERE as well as in `leaderboard.ts`.
   *
   * `serverIdMigrations.test.ts` states the rule and the incident behind it: a
   * module that issues SQL against one of these tables and references
   * `server_id` must not depend on another module having run first, because
   * that is exactly how `/api/game/quests` and `/api/marketplace/items`
   * returned 500 to every caller in production. This module gained such a
   * reference when `readFirstReports` joined `server_members`, so it gains the
   * ensure with it. Idempotent, additive, and free the second time.
   *
   * What this ensure CANNOT cover, stated rather than assumed: `server_members`
   * itself, which lives in `customServers.ts` — and `customServers.ts` imports
   * `leaderboard.ts` which imports this file, so importing it back would be a
   * cycle. `readFirstReports` therefore requires its caller to have run
   * `ensureCustomServerSchema` on the same client, which the progress route
   * does immediately before calling it. */
  await db.query(`ALTER TABLE player_progress_items ADD COLUMN IF NOT EXISTS server_id TEXT`);
  await db.query(`ALTER TABLE player_progress_values ADD COLUMN IF NOT EXISTS server_id TEXT`);
}

/* ---------------------------------------------------------------------- */
/* Validation                                                              */
/* ---------------------------------------------------------------------- */

function cleanKey(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const s = raw.trim();
  if (!s || s.length > MAX_KEY_LEN) return null;
  return s;
}

function cleanScope(raw: unknown): string | null {
  if (raw == null) return '';
  if (typeof raw !== 'string') return null;
  const s = raw.trim();
  if (s.length > MAX_SCOPE_LEN) return null;
  return s;
}

/* ---------------------------------------------------------------------- */
/* The merge                                                               */
/* ---------------------------------------------------------------------- */

/**
 * Union a set of keys into one (kind, scope).
 *
 * One statement. `ON CONFLICT DO NOTHING` means a key already present is not an
 * error and not a second row; `RETURNING` counts only what was genuinely new,
 * which is what makes the whole call idempotent rather than merely tolerant.
 */
async function unionItems(
  db: Db,
  playerId: string,
  kind: string,
  scope: string,
  keys: string[]
): Promise<number> {
  if (!keys.length) return 0;
  const r = await db.query(
    `INSERT INTO player_progress_items (player_id, kind, scope, item_key)
     SELECT $1, $2, $3, k FROM unnest($4::text[]) AS k
     ON CONFLICT (player_id, kind, scope, item_key) DO NOTHING
     RETURNING item_key`,
    [playerId, kind, scope, keys]
  );
  return r.rowCount ?? 0;
}

/**
 * Reconcile numbers for one (kind, scope) under the kind's own rule.
 *
 * `IS DISTINCT FROM` in the WHERE of the DO UPDATE is what keeps `changed`
 * honest: without it every row reports as updated even when the incoming value
 * lost the comparison, and an idempotent replay would look like real progress.
 */
async function mergeValues(
  db: Db,
  playerId: string,
  kind: string,
  mode: MergeMode,
  rows: Array<{ scope: string; key: string; value: number }>
): Promise<number> {
  if (!rows.length) return 0;
  const fn = mode === 'min' ? 'LEAST' : 'GREATEST';
  const r = await db.query(
    `INSERT INTO player_progress_values (player_id, kind, scope, item_key, value)
     SELECT $1, $2, s, k, v
       FROM unnest($3::text[], $4::text[], $5::bigint[]) AS t(s, k, v)
     ON CONFLICT (player_id, kind, scope, item_key)
     DO UPDATE SET value = ${fn}(player_progress_values.value, EXCLUDED.value),
                   updated_at = NOW()
     WHERE ${fn}(player_progress_values.value, EXCLUDED.value)
             IS DISTINCT FROM player_progress_values.value
     RETURNING item_key`,
    [playerId, kind, rows.map((x) => x.scope), rows.map((x) => x.key), rows.map((x) => x.value)]
  );
  return r.rowCount ?? 0;
}

/**
 * How many keys of one (kind, scope) this player has gained inside the window.
 *
 * `created_at` is on the row, so this is a count of ARRIVALS rather than of
 * holdings -- which is the right thing to bound. A player who legitimately owns
 * 3,000 relics from months of play is not throttled by having them; only by
 * claiming another 500 in the next hour.
 */
async function recentlyAdded(
  db: Db,
  playerId: string,
  kind: string,
  scope: string
): Promise<number> {
  const r = await db.query(
    `SELECT COUNT(*)::int AS n FROM player_progress_items
      WHERE player_id = $1 AND kind = $2 AND scope = $3
        AND created_at > NOW() - ($4 || ' seconds')::interval`,
    [playerId, kind, scope, String(DELTA_WINDOW_SECONDS)]
  );
  return Number(r.rows[0]?.n ?? 0);
}

/**
 * Take progress away again.
 *
 * ── Why a ledger that "never subtracts" needs this ────────────────────────
 *
 * `mergeProgress` never subtracts, and that rule is right: a payload that omits
 * something is a device that has not seen it yet, not a report that it was
 * lost. But "the merge never subtracts" was quietly doing duty as "nothing ever
 * subtracts", and those are different claims. Progress here is client-declared
 * -- the server cannot witness a relic being found -- so a forged claim was
 * permanent, and the only remedy was hand-written SQL against production.
 *
 * This is the deliberate account correction the header always said was the
 * exception ("the only way progress leaves this ledger is a deliberate account
 * reset"). It is deliberately NOT reachable from `/api/game/progress`: no
 * request a player can make reaches it, because a client that could ask for a
 * deletion could delete somebody's afternoon, which is the failure this whole
 * module exists to prevent. It is for an operator, from the admin app or a
 * console, with a reason.
 *
 * Scoped to one (player, kind, scope) and an explicit key list rather than
 * taking a predicate: a mistyped filter on a bulk delete is exactly how a
 * correction becomes the incident.
 *
 * @returns how many rows were actually removed.
 */
export async function revokeProgressItems(
  db: Db,
  playerId: string,
  kind: string,
  scope: string,
  keys: string[]
): Promise<number> {
  const clean = [...new Set((Array.isArray(keys) ? keys : []).map(cleanKey).filter(Boolean))] as string[];
  if (!clean.length) return 0;
  const r = await db.query(
    `DELETE FROM player_progress_items
      WHERE player_id = $1 AND kind = $2 AND scope = $3 AND item_key = ANY($4::text[])`,
    [playerId, kind, scope ?? '', clean]
  );
  return r.rowCount ?? 0;
}

/** The value-shaped sibling of `revokeProgressItems`. */
export async function revokeProgressValues(
  db: Db,
  playerId: string,
  kind: string,
  scope: string,
  keys: string[]
): Promise<number> {
  const clean = [...new Set((Array.isArray(keys) ? keys : []).map(cleanKey).filter(Boolean))] as string[];
  if (!clean.length) return 0;
  const r = await db.query(
    `DELETE FROM player_progress_values
      WHERE player_id = $1 AND kind = $2 AND scope = $3 AND item_key = ANY($4::text[])`,
    [playerId, kind, scope ?? '', clean]
  );
  return r.rowCount ?? 0;
}

/* ---------------------------------------------------------------------- */
/* First REPORTED — and the word "reported" is the whole contract           */
/* ---------------------------------------------------------------------- */

export interface FirstReport {
  /** The relic / viewpoint / deed id. */
  itemKey: string;
  playerId: string;
  handle: string | null;
  /** When the row arrived HERE. Not when it was found. See below. */
  reportedAt: string;
  self: boolean;
}

/**
 * The exact sentence a caller is allowed to build out of `readFirstReports`.
 *
 * Exported as a constant rather than left to each caller to phrase, because
 * this is the claim the data supports and every UI that renders it must make
 * the same one. A route that wants to say something else has to change this
 * line, where the reason is written down, rather than in a template it is easy
 * to write "first to find" into by accident.
 */
export const FIRST_REPORT_CLAIM = 'first to report';

/**
 * The limitation, in the response, in the source, and in the UI string.
 *
 * `created_at` is the moment the row reached Postgres. `ProgressSync` batches —
 * it pushes on discovery events and on save, not on a timer, and a device with
 * no connection pushes nothing until it has one — so the gap between finding a
 * relic and reporting it is unbounded and entirely invisible from this side.
 *
 * The consequence is not hypothetical and is not a rounding error: a player who
 * plays offline for a week and signs in on Friday will lose a claim to somebody
 * who found the same relic on Thursday and synced immediately. That player
 * genuinely got there first and the ledger genuinely cannot know it.
 *
 * There is no server-side fix available. A client-declared discovery timestamp
 * would be a clock the player controls, and this file's own header refuses to
 * consult a device clock anywhere for exactly that reason — "a phone a few
 * minutes fast would otherwise silently win every conflict". A weaker claim
 * that is true beats a stronger claim that is a lie, so the weaker claim is
 * what ships, and it ships in the words.
 */
export const FIRST_REPORT_CAVEAT =
  'This is the first player to SYNC this find, not necessarily the first to make it. '
  + 'Progress uploads in batches, so a player who was offline can lose a claim they earned.';

/**
 * Who reported each item of one (kind, scope) first, among a server's members.
 *
 * ── DISTINCT ON rather than a GROUP BY and a second query ────────────────
 *
 * Postgres orders by `(item_key, created_at, player_id)` and keeps the first
 * row of each `item_key` run, which is the earliest report and its owner in one
 * pass over the index added in `ensureProgressSchema`. A `MIN(created_at)`
 * GROUP BY would give the time and not the player, and the usual repair — join
 * the aggregate back to the table — reintroduces the tie the ordering already
 * settles.
 *
 * `player_id` is the last ordering term and it is not decoration: two rows CAN
 * share a `created_at`, because `NOW()` in Postgres is the transaction start and
 * a batch insert stamps every row in it identically. Without that term the
 * winner of a tie would be whichever row the plan happened to reach first, so
 * the same query could answer differently on two runs and nobody would be able
 * to say which was wrong. With it, ties resolve to a fixed answer.
 *
 * ── Scoped to members, the same way the time boards are ──────────────────
 *
 * `server_members` is the FROM clause, `state = 'approved'`, so a non-member is
 * not a candidate and there is no visibility filter to forget. `server_id` on
 * the progress row is deliberately NOT consulted: these are platform relics
 * recorded by `ProgressSync`, which stamps nothing, so requiring a stamp would
 * make every answer empty.
 */
export async function readFirstReports(
  db: Db,
  opts: { serverId: string; kind: string; scope?: string; playerId: string; limit?: number }
): Promise<FirstReport[]> {
  const kind = typeof opts?.kind === 'string' ? opts.kind.trim() : '';
  if (!kind || !KINDS[kind] || KINDS[kind].shape !== 'set') return [];
  const serverId = typeof opts?.serverId === 'string' ? opts.serverId.trim() : '';
  if (!serverId) return [];
  const scope = cleanScope(opts?.scope);
  if (scope === null) return [];
  const limit = Math.max(1, Math.min(500, Math.trunc(Number(opts?.limit)) || 200));

  const r = await db.query(
    `SELECT DISTINCT ON (i.item_key)
            i.item_key, i.player_id, i.created_at, pl.handle
       FROM server_members m
       JOIN player_progress_items i
         ON i.player_id = m.player_id
       LEFT JOIN players pl ON pl.id = i.player_id
      WHERE m.server_id = $1
        AND m.state = 'approved'
        AND i.kind = $2
        AND i.scope = $3
      ORDER BY i.item_key, i.created_at, i.player_id
      LIMIT $4`,
    [serverId, kind, scope, limit]
  );

  return r.rows.map((row) => ({
    itemKey: String(row.item_key),
    playerId: String(row.player_id),
    handle: row.handle ?? null,
    reportedAt: String(row.created_at ?? ''),
    self: String(row.player_id) === opts.playerId,
  }));
}

/** Everything this player has, shaped for the client to adopt wholesale. */
export async function readProgress(db: Db, playerId: string): Promise<ProgressState> {
  const state: ProgressState = { items: {}, values: {} };

  const items = await db.query(
    `SELECT kind, scope, item_key FROM player_progress_items
      WHERE player_id = $1 ORDER BY kind, scope, item_key`,
    [playerId]
  );
  for (const row of items.rows) {
    const kind = String(row.kind);
    const scope = String(row.scope ?? '');
    ((state.items[kind] ??= {})[scope] ??= []).push(String(row.item_key));
  }

  const values = await db.query(
    `SELECT kind, scope, item_key, value FROM player_progress_values
      WHERE player_id = $1 ORDER BY kind, scope, item_key`,
    [playerId]
  );
  for (const row of values.rows) {
    const kind = String(row.kind);
    const scope = String(row.scope ?? '');
    ((state.values[kind] ??= {})[scope] ??= {})[String(row.item_key)] = Number(row.value);
  }

  return state;
}

/**
 * Apply a device's progress and hand back the merged truth.
 *
 * Never subtracts. A payload that omits something the server already holds is a
 * device that has not seen it yet, NOT a device reporting it was lost -- which
 * is exactly the inference that makes a last-write-wins sync destroy data. The
 * only way progress leaves this ledger is a deliberate account reset, which is
 * not this function.
 */
export async function mergeProgress(
  db: Db,
  playerId: string,
  payload: ProgressPayload
): Promise<MergeResult> {
  let changed = 0;
  const rejected = new Set<string>();
  const capped = new Set<string>();

  const groups = Array.isArray(payload?.items) ? payload.items.slice(0, MAX_GROUPS) : [];
  for (const group of groups) {
    const kind = typeof group?.kind === 'string' ? group.kind : '';
    const spec = KINDS[kind];
    if (!spec || spec.shape !== 'set') { if (kind) rejected.add(kind); continue; }
    const scope = cleanScope(group.scope);
    if (scope === null || !Array.isArray(group.keys)) continue;

    const seen = new Set<string>();
    for (const raw of group.keys.slice(0, MAX_KEYS_PER_GROUP)) {
      const key = cleanKey(raw);
      if (key) seen.add(key);
    }

    /* The window budget for this (kind, scope).
     *
     * Counted BEFORE the insert and applied to the batch, so the cap cannot be
     * stepped over by one large final group. Keys already held cost nothing --
     * `unionItems` conflicts on them and they were counted when they first
     * arrived -- so a client re-sending its whole set on every boot, which is
     * exactly what `ProgressSync` does, never consumes budget. Only genuinely
     * new keys do, which is what makes this bound a DELTA rather than a size. */
    let toAdd = [...seen];
    if (toAdd.length) {
      const already = await recentlyAdded(db, playerId, kind, scope);
      const room = Math.max(0, MAX_NEW_KEYS_PER_WINDOW - already);
      if (toAdd.length > room) {
        capped.add(`${kind}/${scope}`);
        toAdd = toAdd.slice(0, room);
      }
    }
    if (toAdd.length) changed += await unionItems(db, playerId, kind, scope, toAdd);
  }

  /* Grouped by kind so each kind's rule is applied in one statement, and so a
   * client cannot smuggle a second rule in beside a legitimate one. */
  const byKind = new Map<string, Array<{ scope: string; key: string; value: number }>>();
  const entries = Array.isArray(payload?.values)
    ? payload.values.slice(0, MAX_GROUPS * MAX_KEYS_PER_GROUP)
    : [];
  for (const entry of entries) {
    const kind = typeof entry?.kind === 'string' ? entry.kind : '';
    const spec = KINDS[kind];
    if (!spec || spec.shape !== 'value') { if (kind) rejected.add(kind); continue; }
    const scope = cleanScope(entry.scope);
    const key = cleanKey(entry.key);
    const value = Number(entry.value);
    if (scope === null || !key || !Number.isFinite(value)) continue;
    const rows = byKind.get(kind) ?? [];
    rows.push({ scope, key, value: Math.trunc(value) });
    byKind.set(kind, rows);
  }
  for (const [kind, rows] of byKind) {
    const spec = KINDS[kind];
    if (!spec || spec.shape !== 'value') continue;
    changed += await mergeValues(db, playerId, kind, spec.mode, rows);
  }

  return {
    state: await readProgress(db, playerId),
    changed,
    rejected: [...rejected],
    capped: [...capped],
  };
}
