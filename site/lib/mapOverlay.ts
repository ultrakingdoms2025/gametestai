import type { Client, PoolClient } from 'pg';
import {
  MAP_OVERLAY_SCHEMA,
  normaliseOverlayEntries,
  type OverlayEntry,
  type RejectedEntry,
} from './mapOverlaySchema';

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
 *   - Additive `CREATE TABLE IF NOT EXISTS` only. Whichever app runs first wins
 *     and the other is a no-op; no deployment is ever stranded mid-migration.
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

/** Create the two tables. Memoised as a promise — see the note above. */
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
 * Record what the running game found and did.
 *
 * One row per world, replaced each time: this is a cache of the last report,
 * not a history. The history that matters is `map_overlays`, and it is
 * append-only.
 */
export async function recordWorldReport(
  db: Db,
  worldId: string,
  report: WorldReport
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

  await db.query(
    `INSERT INTO map_world_reports (world_id, applied_version, objects, applied, unresolved, reported_at)
     VALUES ($1, $2, $3::jsonb, $4::jsonb, $5::jsonb, NOW())
     ON CONFLICT (world_id) DO UPDATE
       SET applied_version = EXCLUDED.applied_version,
           objects         = EXCLUDED.objects,
           applied         = EXCLUDED.applied,
           unresolved      = EXCLUDED.unresolved,
           reported_at     = NOW()`,
    [
      worldId,
      Math.max(0, Math.floor(Number(report.appliedVersion) || 0)),
      JSON.stringify(objects),
      JSON.stringify(applied),
      JSON.stringify(unresolved),
    ]
  );
}

export async function readWorldReport(db: Db, worldId: string): Promise<WorldReport | null> {
  await ensureMapOverlaySchema(db);
  const r = await db.query(
    `SELECT applied_version, objects, applied, unresolved, reported_at
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
    reportedAt: row.reported_at ? new Date(row.reported_at).toISOString() : undefined,
  };
}
