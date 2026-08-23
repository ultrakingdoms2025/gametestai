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

    /* Values. */
    // A best time. The ONLY 'min' in the file, and the reason `mode` exists at
    // all: every other number here grows, and a lap time that grew would be a
    // player's record being deleted by their worse run on another device.
    trial: { shape: 'value', mode: 'min' },
    kills: { shape: 'value', mode: 'max' },
    ore: { shape: 'value', mode: 'max' },
    survey: { shape: 'value', mode: 'max' },
    mining_stat: { shape: 'value', mode: 'max' },
  });

export type ProgressKind = keyof typeof KINDS;

/* Bounds. Generous against real play -- a world holds up to 110 relics and
 * there are six worlds -- and finite, so a forged request cannot ask the
 * database to store a novel. */
const MAX_KEYS_PER_GROUP = 4000;
const MAX_GROUPS = 64;
const MAX_KEY_LEN = 64;
const MAX_SCOPE_LEN = 64;

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
    changed += await unionItems(db, playerId, kind, scope, [...seen]);
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

  return { state: await readProgress(db, playerId), changed, rejected: [...rejected] };
}
