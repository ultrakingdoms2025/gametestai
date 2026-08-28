import type { Client, PoolClient } from 'pg';
import {
  MAP_OVERLAY_SCHEMA,
  cutCodePoints,
  normaliseOverlayEntries,
  type OverlayEntry,
  type RejectedEntry,
} from './mapOverlaySchema';
import { LAYOUT_SCHEMA, MAX_SHAPES, auditShapes, validateBounds, validateGround, validateLayout, type WorldLayout } from './mapLayout';

/**
 * Where a world's placement overlay is kept.
 *
 * ── Append-only, and why that is the whole design ──────────────────────────
 *
 * Nothing here is ever UPDATEd or DELETEd. Saving writes version N+1. Reverting
 * to version K writes version N+1 holding a COPY of K's entries. So:
 *
 *   - "revertible" means every state the map has ever been in is still readable,
 *     not that the last change can be undone once;
 *   - the audit chain in `audit_log` stays worth something, because an admin
 *     cannot edit away the record of what they did by doing it again;
 *   - a reader never has to lock anything. The current overlay is `MAX(version)`,
 *     and a row, once written, does not change under it.
 *
 * ── Conventions taken from `creditLedger.ts`, each for its recorded reason ──
 *
 *   - `(db: Db, ...)` signatures, so the ROUTE owns the connection. A module
 *     that opens its own connection cannot be made to share a transaction, and
 *     Postgres has no nested BEGIN to paper over it later.
 *   - Additive DDL only: `CREATE TABLE IF NOT EXISTS`, and — since the layout
 *     columns — `ALTER TABLE … ADD COLUMN IF NOT EXISTS` with a DEFAULT, so a
 *     row written before the column reads as "no layout", never as NULL.
 *     Whichever app runs first wins and the other is a no-op.
 *   - The ensure is memoised as a **promise**, not a boolean. A boolean set
 *     before the awaited DDL finishes lets a second concurrent caller straight
 *     past a half-built schema — the bug is invisible until two requests land
 *     on a cold lambda at the same moment.
 *
 * ── What this module deliberately does not check ───────────────────────────
 *
 * That `worldId` names a world the game has. That belongs to the route, where a
 * human named it (`isKnownOverlayWorld`). Keeping it out of here is what lets
 * the integration suite own a private set of world ids and stay out of the way
 * of everything else in the parallel vitest run.
 */

type Db = Client | PoolClient;

export interface OverlayVersionRow {
  version: number;
  author: string;
  note: string | null;
  entryCount: number;
  createdAt: string;
}

export interface CurrentOverlay {
  worldId: string;
  version: number;
  schema: number;
  entries: OverlayEntry[];
  author: string | null;
  note: string | null;
  createdAt: string | null;
}

export interface SavedOverlay extends CurrentOverlay {
  rejected: RejectedEntry[];
}

export interface AppliedOutcome {
  id: string;
  ok: boolean;
  colliders?: number;
}

export interface UnresolvedOutcome {
  id: string;
  reason: string;
}

export interface CatalogueObject {
  name: string;
  position: { x: number; y: number; z: number };
}

export interface WorldReport {
  appliedVersion: number;
  objects: CatalogueObject[];
  applied: AppliedOutcome[];
  unresolved: UnresolvedOutcome[];
  reportedAt?: string;
}

/** Layout fields a report may carry, typed `unknown` because they are validated HERE, not in the route; a failed layout still records the catalogue and keeps the prior layout. */
export interface ReportedLayoutFields { layoutSchema?: unknown; bounds?: unknown; shapes?: unknown; ground?: unknown }

export interface StoredWorldReport extends WorldReport { reportedAt: string; layout: WorldLayout | null }

/**
 * What became of the layout a report carried — the answer the report route hands back to the game.
 *
 *   `stored`      the report carried `layoutSchema` and every layout part it carried (bounds and shapes; ground when
 *                 present) was stored. `warnings` may still name shapes that were dropped or cut: a thinner map, not a kept one.
 *   `kept-prior`  the report carried `layoutSchema` but its schema is not this one, or a part it carried was unusable
 *                 (bounds that do not read, a ground that does not decode, shapes with no bounds to hang them on). The
 *                 prior stayed for that part; parts that passed were stored. Always said on the console too.
 *   `none`        the report said nothing about the layout: no `layoutSchema`, or a schema with no bounds and no ground.
 *
 * `warnings` are the human reasons, world-agnostic, for the game's console: `layoutSchema 2 is not 1`, `unusable ground; prior kept`.
 */
export type LayoutOutcome = 'stored' | 'kept-prior' | 'none';
export interface ReportOutcome { layout: LayoutOutcome; warnings: string[] }

/**
 * How many named objects one world may report.
 *
 * A world's group holds tens of thousands of nodes; the catalogue exists to
 * populate a picker, not to mirror the scene graph into Postgres. The client
 * already sends only named, non-duplicate roots — this is the backstop for the
 * day it stops doing that.
 */
export const MAX_CATALOGUE_OBJECTS = 2000;

let ensured: Promise<void> | null = null;

/** Create the two tables and add the layout columns to the reports table. Memoised as a promise — see the note above. */
export function ensureMapOverlaySchema(db: Db): Promise<void> {
  if (!ensured) {
    ensured = (async () => {
      await db.query(`
        CREATE TABLE IF NOT EXISTS map_overlays (
          id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          -- TEXT and no foreign key: worlds are CODE, not rows. There is
          -- nothing in this database for a world id to reference.
          world_id    TEXT NOT NULL,
          version     INTEGER NOT NULL,
          schema      INTEGER NOT NULL DEFAULT 1,
          entries     JSONB NOT NULL DEFAULT '[]'::jsonb,
          author      TEXT NOT NULL,
          note        TEXT,
          created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
      `);
      // The whole concurrency story. Two admins racing to save both compute the
      // same next version; this refuses the loser, who retries and gets N+2.
      await db.query(`
        CREATE UNIQUE INDEX IF NOT EXISTS map_overlays_world_version_idx
          ON map_overlays (world_id, version)
      `);
      await db.query(`
        CREATE TABLE IF NOT EXISTS map_world_reports (
          world_id        TEXT PRIMARY KEY,
          applied_version INTEGER NOT NULL DEFAULT 0,
          objects         JSONB NOT NULL DEFAULT '[]'::jsonb,
          applied         JSONB NOT NULL DEFAULT '[]'::jsonb,
          unresolved      JSONB NOT NULL DEFAULT '[]'::jsonb,
          reported_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
      `);
      // These columns arrived after the table was live: ADD COLUMN IF NOT EXISTS
      // is the additive form, and the DEFAULTs let an old row read as "no layout yet".
      await db.query(`
        ALTER TABLE map_world_reports
          ADD COLUMN IF NOT EXISTS layout JSONB NOT NULL DEFAULT '{}'::jsonb
      `);
      await db.query(`
        ALTER TABLE map_world_reports
          ADD COLUMN IF NOT EXISTS layout_schema INTEGER NOT NULL DEFAULT 0
      `);
    })().catch((err) => {
      // A failed ensure must not be remembered as done, or every later request
      // on this instance skips the DDL and fails on a missing table instead.
      ensured = null;
      throw err;
    });
  }
  return ensured;
}

/** Test seam: forget the memoised ensure. Not used by the app. */
export function resetMapOverlaySchemaMemo(): void {
  ensured = null;
}

function rowEntries(raw: unknown): OverlayEntry[] {
  // JSONB comes back parsed; normalise again so a row written by an older
  // schema version, or edited by hand in psql, still cannot reach the game.
  return normaliseOverlayEntries(raw).entries;
}

export async function readCurrentOverlay(db: Db, worldId: string): Promise<CurrentOverlay> {
  await ensureMapOverlaySchema(db);
  const r = await db.query(
    `SELECT version, schema, entries, author, note, created_at
       FROM map_overlays
      WHERE world_id = $1
      ORDER BY version DESC
      LIMIT 1`,
    [worldId]
  );
  const row = r.rows[0];
  if (!row) {
    return {
      worldId,
      version: 0,
      schema: MAP_OVERLAY_SCHEMA,
      entries: [],
      author: null,
      note: null,
      createdAt: null,
    };
  }
  return {
    worldId,
    version: Number(row.version),
    schema: Number(row.schema ?? MAP_OVERLAY_SCHEMA),
    entries: rowEntries(row.entries),
    author: row.author ?? null,
    note: row.note ?? null,
    createdAt: row.created_at ? new Date(row.created_at).toISOString() : null,
  };
}

export async function listOverlayVersions(
  db: Db,
  worldId: string,
  limit = 50
): Promise<OverlayVersionRow[]> {
  await ensureMapOverlaySchema(db);
  const r = await db.query(
    `SELECT version, author, note, created_at,
            COALESCE(jsonb_array_length(entries), 0) AS entry_count
       FROM map_overlays
      WHERE world_id = $1
      ORDER BY version DESC
      LIMIT $2`,
    [worldId, Math.max(1, Math.min(200, Math.floor(limit)))]
  );
  return r.rows.map((row) => ({
    version: Number(row.version),
    author: String(row.author ?? ''),
    note: row.note ?? null,
    entryCount: Number(row.entry_count ?? 0),
    createdAt: new Date(row.created_at).toISOString(),
  }));
}

/**
 * How many times a save may lose the version race before giving up.
 *
 * Two admins is one retry. Five is a number that only a broken clock or a
 * genuinely hot loop could reach, and failing loudly there is better than
 * spinning.
 */
const SAVE_ATTEMPTS = 5;

/**
 * Write a new version.
 *
 * `INSERT ... SELECT MAX(version)+1 ... ON CONFLICT DO NOTHING` in one
 * statement: the subselect and the insert see the same snapshot, and the UNIQUE
 * index refuses a duplicate rather than letting two admins both become
 * version 4. No row is returned when that happens, which IS the signal to retry.
 */
export async function saveOverlayVersion(
  db: Db,
  input: { worldId: string; entries: unknown; author: string; note?: string | null }
): Promise<SavedOverlay> {
  await ensureMapOverlaySchema(db);
  const { entries, rejected } = normaliseOverlayEntries(input.entries);
  // Cut by code point, like every string on its way into a jsonb or text column (see `cutCodePoints`).
  const author = cutCodePoints(String(input.author ?? ''), 200);
  const note = input.note ? cutCodePoints(String(input.note), 500) : null;

  for (let attempt = 0; attempt < SAVE_ATTEMPTS; attempt++) {
    const r = await db.query(
      `INSERT INTO map_overlays (world_id, version, schema, entries, author, note)
       SELECT $1,
              COALESCE((SELECT MAX(version) FROM map_overlays WHERE world_id = $1), 0) + 1,
              $2, $3::jsonb, $4, $5
       ON CONFLICT (world_id, version) DO NOTHING
       RETURNING version, schema, entries, author, note, created_at`,
      [input.worldId, MAP_OVERLAY_SCHEMA, JSON.stringify(entries), author, note]
    );
    const row = r.rows[0];
    if (row) {
      return {
        worldId: input.worldId,
        version: Number(row.version),
        schema: Number(row.schema),
        entries: rowEntries(row.entries),
        author: row.author ?? null,
        note: row.note ?? null,
        createdAt: new Date(row.created_at).toISOString(),
        rejected,
      };
    }
  }
  throw new Error(`could not allocate an overlay version for "${input.worldId}"`);
}

/**
 * Revert by moving FORWARD: copy an old version's entries into a new one.
 *
 * Returns null when the named version does not exist, rather than inventing an
 * empty overlay — "revert to a version that was never saved" is a mistake worth
 * telling the admin about, and quietly clearing their map is not the answer to it.
 */
export async function revertOverlayTo(
  db: Db,
  input: { worldId: string; version: number; author: string }
): Promise<SavedOverlay | null> {
  await ensureMapOverlaySchema(db);
  const r = await db.query(
    'SELECT entries FROM map_overlays WHERE world_id = $1 AND version = $2',
    [input.worldId, Math.floor(input.version)]
  );
  if (!r.rows[0]) return null;

  return saveOverlayVersion(db, {
    worldId: input.worldId,
    entries: r.rows[0].entries,
    author: input.author,
    note: `revert to version ${Math.floor(input.version)}`,
  });
}

function clampNumber(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) ? Math.round(n * 1000) / 1000 : 0;
}

/**
 * A version on its way into an INTEGER column: floored at 0 and capped at
 * 2^31 − 1. Clamp, never refuse: without the cap a forged 1e300 would refuse
 * the whole INSERT — the catalogue and the layout with it — and the report
 * route would 500 on a number nobody can see. Infinity arrives as JSON null
 * and reads as 0.
 */
function clampVersion(value: unknown): number {
  return Math.min(2147483647, Math.max(0, Math.floor(Number(value) || 0)));
}

/**
 * Only the keys that arrived AND passed. `bounds`/`shapes` travel on every report, `ground`
 * only when sampling finished; jsonb `||` is shallow, so bounds without ground keeps
 * yesterday's ground, and nothing keeps everything.
 *
 * Every way a layout comes back thinner, or not at all, is said on the console here, where it
 * is first known, AND handed back as a `ReportOutcome` for the route to answer with. `saveOverlayVersion`
 * hands `rejected` back for the editor to show; a report's only reader is the game that sent it, and
 * until the outcome travelled back a quietly kept map — the schema mismatch was not even logged — hid
 * a world file's bug, or a stale client, behind `{ ok: true }`. Absent is not unusable: a field that
 * was not sent is the keep-the-prior rule working, and says nothing.
 */
function layoutPatch(worldId: string, report: ReportedLayoutFields): { patch: Partial<WorldLayout>; outcome: ReportOutcome } {
  const patch: Partial<WorldLayout> = {};
  const warnings: string[] = [];
  // `== null`: undefined and null are both "not sent", the rule `bounds` and `ground` follow below.
  if (report.layoutSchema == null) {
    if (report.bounds != null || report.ground != null || (Array.isArray(report.shapes) && report.shapes.length > 0)) {
      // An old or odd client: layout fields with no schema to read them under. Dropped, but not quietly.
      warnings.push('layout fields sent without layoutSchema; ignored');
      console.warn(`[map-report] layout fields sent without layoutSchema for ${worldId}; ignored`);
    }
    return { patch, outcome: { layout: 'none', warnings } };
  }
  if (report.layoutSchema !== LAYOUT_SCHEMA) {
    // The one kept-prior that was silent before the whole-branch review: a newer client's report vanished into `{ ok: true }`.
    const reason = `layoutSchema ${JSON.stringify(report.layoutSchema)} is not ${LAYOUT_SCHEMA}`;
    console.warn(`[map-report] ${reason} for ${worldId}; prior layout kept`);
    return { patch, outcome: { layout: 'kept-prior', warnings: [reason] } };
  }
  let keptPrior = false;
  const bounds = validateBounds(report.bounds);
  if (bounds) {
    patch.schema = LAYOUT_SCHEMA;
    patch.bounds = bounds;
    // Present means replace, absent means keep — the same rule as `ground`, so a report of bounds alone cannot erase the shapes.
    if (Array.isArray(report.shapes)) {
      const audit = auditShapes(report.shapes);
      patch.shapes = audit.shapes;
      // Two lines from two counts, each only when it happened. Truncation is not unreadability: the cap keeps
      // the first MAX_SHAPES readable and never reads the rest, and calling those "unreadable" would send
      // someone hunting a bug a world file does not have — while the shape it really could not read went unsaid.
      // Neither keeps the prior: the map is stored, thinner, so they are warnings under `stored`.
      if (audit.truncated > 0) {
        warnings.push(`kept the first ${MAX_SHAPES} of ${report.shapes.length} shapes`);
        console.warn(`[map-report] kept the first ${MAX_SHAPES} of ${report.shapes.length} shapes for ${worldId}`);
      }
      if (audit.unreadable > 0) {
        warnings.push(`dropped ${audit.unreadable} unreadable shapes`);
        console.warn(`[map-report] dropped ${audit.unreadable} unreadable shapes for ${worldId}`);
      }
    }
  } else if (report.bounds != null) {
    // `!= null` as for `ground` below: null means not sent, for both, and says nothing.
    keptPrior = true;
    warnings.push('unusable bounds; prior bounds and shapes kept');
    console.warn(`[map-report] unusable bounds for ${worldId}; prior bounds and shapes kept`);
  } else if (Array.isArray(report.shapes) && report.shapes.length > 0) {
    // Shapes are stored under bounds (the branch above), so shapes with no bounds have nowhere to go — the case of a
    // world whose Box3 is empty: the game omits `bounds` and sends its floorplan anyway.
    keptPrior = true;
    warnings.push('shapes without bounds; not stored, prior kept');
    console.warn(`[map-report] shapes without bounds for ${worldId}; not stored, prior kept`);
  }
  const ground = report.ground == null ? null : validateGround(report.ground);
  if (ground) {
    patch.schema = LAYOUT_SCHEMA;
    patch.ground = ground;
  } else if (report.ground != null) {
    keptPrior = true;
    warnings.push('unusable ground; prior kept');
    console.warn(`[map-report] unusable ground for ${worldId}; prior kept`);
  }
  // A valid ground under invalid bounds stores { schema, ground }: readWorldReport answers `layout: null` until bounds arrive, and the ground is already there when they do. Self-healing, not a bug.
  // `kept-prior` wins over a part stored beside it: the game's one console line is for what did NOT land.
  const stored = patch.bounds !== undefined || patch.ground !== undefined;
  const layout: LayoutOutcome = keptPrior ? 'kept-prior' : stored ? 'stored' : 'none';
  return { patch, outcome: { layout, warnings } };
}

/**
 * Record what the running game found and did: one row per world, a cache of the last report, not a history (that is
 * `map_overlays`). The layout is the one part that MERGES — see `layoutPatch` — and the one part whose fate is
 * answered: the objects, applied and unresolved lists are always stored, so the route answers 200 whatever the layout
 * did, and the returned `ReportOutcome` is how the game learns that its map did not land.
 */
export async function recordWorldReport(
  db: Db,
  worldId: string,
  report: WorldReport & ReportedLayoutFields
): Promise<ReportOutcome> {
  await ensureMapOverlaySchema(db);

  const objects = (Array.isArray(report.objects) ? report.objects : [])
    .slice(0, MAX_CATALOGUE_OBJECTS)
    .map((o) => ({
      name: cutCodePoints(String((o as CatalogueObject)?.name ?? ''), 200),
      position: {
        x: clampNumber((o as CatalogueObject)?.position?.x),
        y: clampNumber((o as CatalogueObject)?.position?.y),
        z: clampNumber((o as CatalogueObject)?.position?.z),
      },
    }))
    .filter((o) => o.name.length > 0);

  const applied = (Array.isArray(report.applied) ? report.applied : [])
    .slice(0, MAX_CATALOGUE_OBJECTS)
    .map((a) => ({
      id: cutCodePoints(String((a as AppliedOutcome)?.id ?? ''), 64),
      ok: Boolean((a as AppliedOutcome)?.ok),
      colliders: Math.max(0, Math.floor(Number((a as AppliedOutcome)?.colliders ?? 0)) || 0),
    }));

  const unresolved = (Array.isArray(report.unresolved) ? report.unresolved : [])
    .slice(0, MAX_CATALOGUE_OBJECTS)
    .map((u) => ({
      id: cutCodePoints(String((u as UnresolvedOutcome)?.id ?? ''), 64),
      reason: cutCodePoints(String((u as UnresolvedOutcome)?.reason ?? ''), 64),
    }));

  const { patch, outcome } = layoutPatch(worldId, report);

  await db.query(
    `INSERT INTO map_world_reports
       (world_id, applied_version, objects, applied, unresolved, layout, layout_schema, reported_at)
     VALUES ($1, $2, $3::jsonb, $4::jsonb, $5::jsonb, $6::jsonb, $7, NOW())
     ON CONFLICT (world_id) DO UPDATE
       SET applied_version = EXCLUDED.applied_version,
           objects         = EXCLUDED.objects,
           applied         = EXCLUDED.applied,
           unresolved      = EXCLUDED.unresolved,
           -- A row is always ONE schema. A patch from a newer client replaces the row outright
           -- (its ground is not a v1 ground with a v2 bounds merged over it); a patch from the
           -- same schema merges; one from an older client is dropped rather than merged under a
           -- newer row. Today only schema 1 exists, and a report with no layout is schema 0 with
           -- an empty patch, which the ELSE keeps as it is.
           layout          = CASE
                               WHEN map_world_reports.layout_schema < EXCLUDED.layout_schema THEN EXCLUDED.layout
                               WHEN map_world_reports.layout_schema = EXCLUDED.layout_schema THEN map_world_reports.layout || EXCLUDED.layout
                               ELSE map_world_reports.layout
                             END,
           layout_schema   = GREATEST(map_world_reports.layout_schema, EXCLUDED.layout_schema),
           reported_at     = NOW()`,
    [
      worldId,
      clampVersion(report.appliedVersion),
      JSON.stringify(objects),
      JSON.stringify(applied),
      JSON.stringify(unresolved),
      JSON.stringify(patch),
      patch.schema === LAYOUT_SCHEMA ? LAYOUT_SCHEMA : 0,
    ]
  );
  return outcome;
}

export async function readWorldReport(db: Db, worldId: string): Promise<StoredWorldReport | null> {
  await ensureMapOverlaySchema(db);
  const r = await db.query(
    `SELECT applied_version, objects, applied, unresolved, layout, layout_schema, reported_at
       FROM map_world_reports WHERE world_id = $1`,
    [worldId]
  );
  const row = r.rows[0];
  if (!row) return null;
  return {
    appliedVersion: Number(row.applied_version ?? 0),
    objects: Array.isArray(row.objects) ? (row.objects as CatalogueObject[]) : [],
    applied: Array.isArray(row.applied) ? (row.applied as AppliedOutcome[]) : [],
    unresolved: Array.isArray(row.unresolved) ? (row.unresolved as UnresolvedOutcome[]) : [],
    // Validated again on the way out, like `rowEntries`: a row edited in psql reaches the editor as "no layout", not a canvas crash.
    // `>=` and not `===`: the upsert's CASE guarantees a row holds ONE schema, so a row at a newer schema is that schema's
    // layout whole, and `validateLayout` — which reads only the schema it knows — is the one that says whether this build can use it.
    layout: Number(row.layout_schema ?? 0) >= LAYOUT_SCHEMA ? validateLayout(row.layout) : null,
    reportedAt: new Date(row.reported_at).toISOString(),
  };
}
