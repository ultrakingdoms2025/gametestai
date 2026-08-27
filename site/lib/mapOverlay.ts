import type { Client, PoolClient } from 'pg';
import {
  MAP_OVERLAY_SCHEMA,
  normaliseOverlayEntries,
  type OverlayEntry,
  type RejectedEntry,
} from './mapOverlaySchema';
import { LAYOUT_SCHEMA, validateBounds, validateGround, validateLayout, validateShapes, type WorldLayout } from './mapLayout';

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
  const author = String(input.author ?? '').slice(0, 200);
  const note = input.note ? String(input.note).slice(0, 500) : null;

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
 * Only the keys that arrived AND passed. `bounds`/`shapes` travel on every report, `ground`
 * only when sampling finished; jsonb `||` is shallow, so bounds without ground keeps
 * yesterday's ground, and nothing keeps everything.
 */
function layoutPatch(report: ReportedLayoutFields): Partial<WorldLayout> {
  const patch: Partial<WorldLayout> = {};
  if (report.layoutSchema !== LAYOUT_SCHEMA) return patch;
  const bounds = validateBounds(report.bounds);
  if (bounds) {
    patch.schema = LAYOUT_SCHEMA;
    patch.bounds = bounds;
    // Present means replace, absent means keep — the same rule as `ground`, so a report of bounds alone cannot erase the shapes.
    if (Array.isArray(report.shapes)) patch.shapes = validateShapes(report.shapes);
  }
  const ground = report.ground === undefined || report.ground === null ? null : validateGround(report.ground);
  if (ground) {
    patch.schema = LAYOUT_SCHEMA;
    patch.ground = ground;
  }
  // A valid ground under invalid bounds stores { schema, ground }: readWorldReport answers `layout: null` until bounds arrive, and the ground is already there when they do. Self-healing, not a bug.
  return patch;
}

/** Record what the running game found and did: one row per world, a cache of the last report, not a history (that is `map_overlays`). The layout is the one part that MERGES — see `layoutPatch`. */
export async function recordWorldReport(
  db: Db,
  worldId: string,
  report: WorldReport & ReportedLayoutFields
): Promise<void> {
  await ensureMapOverlaySchema(db);

  const objects = (Array.isArray(report.objects) ? report.objects : [])
    .slice(0, MAX_CATALOGUE_OBJECTS)
    .map((o) => ({
      name: String((o as CatalogueObject)?.name ?? '').slice(0, 200),
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
      id: String((a as AppliedOutcome)?.id ?? '').slice(0, 64),
      ok: Boolean((a as AppliedOutcome)?.ok),
      colliders: Math.max(0, Math.floor(Number((a as AppliedOutcome)?.colliders ?? 0)) || 0),
    }));

  const unresolved = (Array.isArray(report.unresolved) ? report.unresolved : [])
    .slice(0, MAX_CATALOGUE_OBJECTS)
    .map((u) => ({
      id: String((u as UnresolvedOutcome)?.id ?? '').slice(0, 64),
      reason: String((u as UnresolvedOutcome)?.reason ?? '').slice(0, 64),
    }));

  const patch = layoutPatch(report);
  // `saveOverlayVersion` hands `rejected` back for the editor to show; a report has no one to
  // show it to, and a shape the validator could not read is a world file's bug that a quietly
  // thinner map would hide. So the count goes to the log, here, where it is first known.
  if (Array.isArray(report.shapes) && patch.shapes && patch.shapes.length < report.shapes.length) {
    console.warn(`[map-report] dropped ${report.shapes.length - patch.shapes.length} unreadable shapes for ${worldId}`);
  }

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
      Math.max(0, Math.floor(Number(report.appliedVersion) || 0)),
      JSON.stringify(objects),
      JSON.stringify(applied),
      JSON.stringify(unresolved),
      JSON.stringify(patch),
      patch.schema === LAYOUT_SCHEMA ? LAYOUT_SCHEMA : 0,
    ]
  );
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
