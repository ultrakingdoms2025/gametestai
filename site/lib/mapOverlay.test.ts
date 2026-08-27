import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from 'pg';
import {
  ensureMapOverlaySchema,
  listOverlayVersions,
  readCurrentOverlay,
  readWorldReport,
  recordWorldReport,
  resetMapOverlaySchemaMemo,
  revertOverlayTo,
  saveOverlayVersion,
} from './mapOverlay';
import { encodeHeights } from './mapLayout';
import { flat, makeFakeDb } from './fakeDb';

/**
 * The overlay store, against a real Postgres.
 *
 * What cannot be proved any other way, and is therefore why this file connects
 * to a database at all:
 *
 *   1. **Two admins saving at once cannot both become version 4.** That is a
 *      UNIQUE constraint plus a retry, and a mock would assert only that I
 *      wrote down what I already believed. It needs two real connections.
 *
 *   2. **Reverting adds a version rather than removing one.** The audit chain
 *      records what an admin did; if reverting could delete the version it
 *      reverted, the record would be editable by doing the thing twice.
 *
 * Runs against `aether_test`, the separate database the credit ledger suite
 * uses, and refuses to run anywhere else. With POSTGRES_TEST_URL absent it
 * skips rather than fails, so CI — which has no database — stays green.
 *
 * World ids here are all prefixed `test-overlay-`, so this suite owns them and
 * nothing else in the parallel vitest run can collide with it. (The reserved
 * player ids do the same job for the ledger suites: ...0001 creditLedger,
 * ...0002 marketplacePurchase, ...0003 creditReport, ...0004 progressLedger,
 * ...0005 leaderboard.)
 */

function testUrl(): string | null {
  if (process.env.POSTGRES_TEST_URL) return process.env.POSTGRES_TEST_URL;
  const here = dirname(fileURLToPath(import.meta.url));
  const envFile = join(here, '..', '.env.test.local');
  if (!existsSync(envFile)) return null;
  const line = readFileSync(envFile, 'utf8')
    .split(/\r?\n/)
    .find((l) => l.startsWith('POSTGRES_TEST_URL='));
  if (!line) return null;
  return line.slice('POSTGRES_TEST_URL='.length).trim().replace(/^["']|["']$/g, '');
}

const URL_ = testUrl();
const suite = URL_ ? describe : describe.skip;

const WORLD = 'test-overlay-alpha';
const OTHER = 'test-overlay-beta';
const PLAIN = { appliedVersion: 1, objects: [], applied: [], unresolved: [] };
const BOUNDS = { min: { x: -20, y: 0, z: -20 }, max: { x: 20, y: 10, z: 20 } };
/** A 3×3 single-layer grid at 20 m, every cell at `cm`. */
function ground(cm: number) {
  return { originX: -20, originZ: -20, step: 20, nx: 3, nz: 3, layers: 1, heightsCm: encodeHeights(new Int16Array(9).fill(cm)) };
}

function connect(): Client {
  return new Client({ connectionString: URL_!, ssl: { rejectUnauthorized: false } });
}

const MOVE = {
  kind: 'move' as const,
  id: 'm1',
  target: { name: 'crate.a' },
  position: { x: 1, y: 2, z: 3 },
};

suite('mapOverlay (integration)', () => {
  let db: Client;

  beforeAll(async () => {
    db = connect();
    await db.connect();

    const which = await db.query('SELECT current_database() AS db');
    if (which.rows[0].db !== 'aether_test') {
      throw new Error(`refusing to run against "${which.rows[0].db}" — expected aether_test`);
    }
    await ensureMapOverlaySchema(db);
  });

  afterAll(async () => {
    if (db) {
      await db.query('DELETE FROM map_overlays WHERE world_id LIKE $1', ['test-overlay-%']);
      await db.query('DELETE FROM map_world_reports WHERE world_id LIKE $1', ['test-overlay-%']);
      await db.end();
    }
  });

  beforeEach(async () => {
    await db.query('DELETE FROM map_overlays WHERE world_id LIKE $1', ['test-overlay-%']);
    await db.query('DELETE FROM map_world_reports WHERE world_id LIKE $1', ['test-overlay-%']);
  });

  it('reports version 0 and no entries for a world nobody has edited', async () => {
    const current = await readCurrentOverlay(db, WORLD);
    expect(current.version).toBe(0);
    expect(current.entries).toEqual([]);
  });

  it('starts at version 1 and increments from there', async () => {
    const a = await saveOverlayVersion(db, {
      worldId: WORLD,
      entries: [MOVE],
      author: 'owner@example.com',
    });
    expect(a.version).toBe(1);

    const b = await saveOverlayVersion(db, {
      worldId: WORLD,
      entries: [MOVE, { ...MOVE, id: 'm2' }],
      author: 'owner@example.com',
    });
    expect(b.version).toBe(2);

    const current = await readCurrentOverlay(db, WORLD);
    expect(current.version).toBe(2);
    expect(current.entries).toHaveLength(2);
  });

  it('normalises on the way in, so a bad entry never reaches the game', async () => {
    const saved = await saveOverlayVersion(db, {
      worldId: WORLD,
      entries: [MOVE, { kind: 'nonsense' }, { kind: 'move', id: 'z', target: { name: 'a' } }],
      author: 'owner@example.com',
    });
    expect(saved.entries).toHaveLength(1);
    expect(saved.rejected).toHaveLength(2);

    const current = await readCurrentOverlay(db, WORLD);
    expect(current.entries).toHaveLength(1);
  });

  it('keeps worlds apart', async () => {
    await saveOverlayVersion(db, { worldId: WORLD, entries: [MOVE], author: 'a@example.com' });
    const other = await readCurrentOverlay(db, OTHER);
    expect(other.version).toBe(0);

    await saveOverlayVersion(db, { worldId: OTHER, entries: [], author: 'a@example.com' });
    expect((await readCurrentOverlay(db, OTHER)).version).toBe(1);
    expect((await readCurrentOverlay(db, WORLD)).version).toBe(1);
  });

  /**
   * Two admins saving at once.
   *
   * ── Why this is staged rather than fired off with Promise.all ────────────
   *
   * `Promise.all` over two connections does NOT reliably produce contention
   * here: node round-trips them in turn, the second statement's snapshot
   * usually already contains the first's committed row, and both saves succeed
   * for the boring reason that they never overlapped. Written that way, the test
   * passed with the retry loop reduced to a single attempt — i.e. it was
   * reporting confidence about a mechanism it had never exercised.
   *
   * So the race is staged deliberately. `first` opens a transaction and inserts
   * version 2 WITHOUT committing. `second` then computes version 2 as well (it
   * cannot see an uncommitted row) and blocks on the unique index. Committing
   * `first` releases it: `ON CONFLICT DO NOTHING` returns no row, the retry runs
   * again, and it lands on 3. Deterministic, and it fails if either the UNIQUE
   * index or the retry is removed.
   */
  it('two admins saving at the same moment get two different versions', async () => {
    await saveOverlayVersion(db, { worldId: WORLD, entries: [], author: 'a@example.com' });

    const [c1, c2] = [connect(), connect()];
    await c1.connect();
    await c2.connect();
    try {
      await c1.query('BEGIN');
      const r1 = await saveOverlayVersion(c1, {
        worldId: WORLD,
        entries: [MOVE],
        author: 'a@example.com',
      });
      expect(r1.version).toBe(2);

      // Not awaited yet: this blocks inside Postgres on the unique index until
      // the transaction above ends.
      const pending = saveOverlayVersion(c2, {
        worldId: WORLD,
        entries: [{ ...MOVE, id: 'm2' }],
        author: 'b@example.com',
      });

      // Give it long enough to actually reach the index and block. If the
      // implementation were racy this is the window in which it would have
      // written a second version 2.
      await new Promise((resolve) => setTimeout(resolve, 250));
      await c1.query('COMMIT');

      const r2 = await pending;
      expect(r2.version).toBe(3);
    } finally {
      await c1.query('ROLLBACK').catch(() => {});
      await c1.end();
      await c2.end();
    }

    const versions = await listOverlayVersions(db, WORLD);
    expect(versions.map((v) => v.version)).toEqual([3, 2, 1]);
  });

  it('reverting writes a NEW version holding the old entries, and deletes nothing', async () => {
    await saveOverlayVersion(db, { worldId: WORLD, entries: [MOVE], author: 'a@example.com' });
    await saveOverlayVersion(db, {
      worldId: WORLD,
      entries: [MOVE, { ...MOVE, id: 'm2' }, { ...MOVE, id: 'm3' }],
      author: 'a@example.com',
    });

    const reverted = await revertOverlayTo(db, {
      worldId: WORLD,
      version: 1,
      author: 'b@example.com',
    });
    expect(reverted).not.toBeNull();
    expect(reverted!.version).toBe(3);
    expect(reverted!.entries).toHaveLength(1);
    expect(reverted!.note).toContain('1');

    const versions = await listOverlayVersions(db, WORLD);
    expect(versions.map((v) => v.version)).toEqual([3, 2, 1]);
    expect((await readCurrentOverlay(db, WORLD)).entries).toHaveLength(1);
  });

  it('refuses to revert to a version that does not exist', async () => {
    await saveOverlayVersion(db, { worldId: WORLD, entries: [MOVE], author: 'a@example.com' });
    const reverted = await revertOverlayTo(db, { worldId: WORLD, version: 9, author: 'b@x.com' });
    expect(reverted).toBeNull();
    expect((await readCurrentOverlay(db, WORLD)).version).toBe(1);
  });

  it('records what the running game reported, replacing the previous report', async () => {
    expect(await readWorldReport(db, WORLD)).toBeNull();

    await recordWorldReport(db, WORLD, {
      appliedVersion: 1,
      objects: [{ name: 'crate.a', position: { x: 0, y: 0, z: 0 } }],
      applied: [{ id: 'm1', ok: true, colliders: 2 }],
      unresolved: [],
    });
    let report = await readWorldReport(db, WORLD);
    expect(report?.objects).toHaveLength(1);
    expect(report?.appliedVersion).toBe(1);

    await recordWorldReport(db, WORLD, {
      appliedVersion: 2,
      objects: [
        { name: 'crate.a', position: { x: 0, y: 0, z: 0 } },
        { name: 'crate.b', position: { x: 1, y: 0, z: 0 } },
      ],
      applied: [],
      unresolved: [{ id: 'm1', reason: 'name' }],
    });
    report = await readWorldReport(db, WORLD);
    expect(report?.objects).toHaveLength(2);
    expect(report?.appliedVersion).toBe(2);
    expect(report?.unresolved).toEqual([{ id: 'm1', reason: 'name' }]);
  });

  it('caps a reported object catalogue rather than storing whatever arrives', async () => {
    const objects = Array.from({ length: 6000 }, (_, i) => ({
      name: `obj.${i}`,
      position: { x: i, y: 0, z: 0 },
    }));
    await recordWorldReport(db, WORLD, {
      appliedVersion: 0,
      objects,
      applied: [],
      unresolved: [],
    });
    const report = await readWorldReport(db, WORLD);
    expect(report!.objects.length).toBeLessThanOrEqual(2000);
  });

  it('adds the layout columns to a table that already existed, and again without complaint', async () => {
    resetMapOverlaySchemaMemo(); await ensureMapOverlaySchema(db);
    resetMapOverlaySchemaMemo(); await ensureMapOverlaySchema(db);
    const cols = await db.query(`SELECT column_name FROM information_schema.columns WHERE table_name = 'map_world_reports'`);
    expect(cols.rows.map((r) => r.column_name)).toEqual(expect.arrayContaining(['layout', 'layout_schema']));
  });

  it('reads layout null, with a fresh reportedAt, for a world whose reports never carried one', async () => {
    await recordWorldReport(db, WORLD, PLAIN);
    const stored = await readWorldReport(db, WORLD);
    expect(stored?.layout).toBeNull();
    expect(Date.now() - Date.parse(stored!.reportedAt)).toBeLessThan(60_000);
  });

  it('stores a layout and hands it back byte for byte', async () => {
    const shapes = [{ kind: 'rect', x: 0, z: 0, w: 4, d: 4, fill: 0x224466 }];
    await recordWorldReport(db, WORLD, { ...PLAIN, layoutSchema: 1, bounds: BOUNDS, shapes, ground: ground(150) });
    expect((await readWorldReport(db, WORLD))?.layout).toEqual({ schema: 1, bounds: BOUNDS, shapes, ground: ground(150) });
  });

  it('keeps the ground when a later report carries bounds and shapes but no ground', async () => {
    await recordWorldReport(db, WORLD, { ...PLAIN, layoutSchema: 1, bounds: BOUNDS, shapes: [], ground: ground(150) });
    const moved = { min: { x: -30, y: 0, z: -30 }, max: { x: 30, y: 10, z: 30 } };
    await recordWorldReport(db, WORLD, { ...PLAIN, appliedVersion: 2, layoutSchema: 1, bounds: moved, shapes: [{ kind: 'circle', x: 1, z: 1, r: 2 }] });
    const stored = await readWorldReport(db, WORLD);
    expect(stored?.appliedVersion).toBe(2);
    expect(stored?.layout?.bounds).toEqual(moved);
    expect(stored?.layout?.shapes).toHaveLength(1);
    expect(stored?.layout?.ground).toEqual(ground(150));
  });

  it('leaves the layout alone for a report with no layout fields, and keeps the prior ground over one that does not decode', async () => {
    await recordWorldReport(db, WORLD, { ...PLAIN, layoutSchema: 1, bounds: BOUNDS, shapes: [], ground: ground(150) });
    await recordWorldReport(db, WORLD, { ...PLAIN, appliedVersion: 3 });
    const stored = await readWorldReport(db, WORLD);
    expect(stored?.appliedVersion).toBe(3);
    expect(stored?.layout).toEqual({ schema: 1, bounds: BOUNDS, shapes: [], ground: ground(150) });
    await recordWorldReport(db, WORLD, { ...PLAIN, layoutSchema: 1, bounds: BOUNDS, shapes: [], ground: { ...ground(999), nx: 4 } });
    expect((await readWorldReport(db, WORLD))?.layout?.ground).toEqual(ground(150));
  });

  it('replaces only the ground for a report that carries a ground and nothing else', async () => {
    const shapes = [{ kind: 'circle', x: 1, z: 1, r: 2 }];
    await recordWorldReport(db, WORLD, { ...PLAIN, layoutSchema: 1, bounds: BOUNDS, shapes, ground: ground(150) });
    await recordWorldReport(db, WORLD, { ...PLAIN, layoutSchema: 1, ground: ground(300) });
    expect((await readWorldReport(db, WORLD))?.layout).toEqual({ schema: 1, bounds: BOUNDS, shapes, ground: ground(300) });
  });

  it('keeps the stored shapes when a later report carries bounds but no shapes', async () => {
    const shapes = [{ kind: 'circle', x: 1, z: 1, r: 2 }];
    await recordWorldReport(db, WORLD, { ...PLAIN, layoutSchema: 1, bounds: BOUNDS, shapes });
    const moved = { min: { x: -30, y: 0, z: -30 }, max: { x: 30, y: 10, z: 30 } };
    await recordWorldReport(db, WORLD, { ...PLAIN, layoutSchema: 1, bounds: moved });
    expect((await readWorldReport(db, WORLD))?.layout).toEqual({ schema: 1, bounds: moved, shapes, ground: null });
  });

  /**
   * Only schema 1 exists, so the older row is staged by hand: a row at schema 0 whose `layout`
   * holds a ground. With a plain `||` that ground would survive under a schema-1 bounds; the
   * CASE replaces the row instead, so a row is never two grid formats at once.
   */
  it('replaces, rather than merges over, a layout left by an older schema', async () => {
    await recordWorldReport(db, WORLD, PLAIN);
    await db.query('UPDATE map_world_reports SET layout = $2::jsonb, layout_schema = 0 WHERE world_id = $1', [WORLD, JSON.stringify({ ground: ground(150) })]);
    await recordWorldReport(db, WORLD, { ...PLAIN, layoutSchema: 1, bounds: BOUNDS, shapes: [] });
    expect((await readWorldReport(db, WORLD))?.layout).toEqual({ schema: 1, bounds: BOUNDS, shapes: [], ground: null });
  });
});

/**
 * The merge rule as EMITTED SQL, on every machine: one shallow jsonb `||` with a patch of the
 * keys that passed. The integration suite proves the consequence; this pins the statement where it cannot run.
 */
describe('recordWorldReport — the SQL it emits', () => {
  const patchOf = (db: ReturnType<typeof makeFakeDb>) => JSON.parse(String(db.only('INSERT INTO map_world_reports').params[5]));

  it('merges the patch over the stored layout rather than replacing it', async () => {
    const db = makeFakeDb();
    await recordWorldReport(db, 'test-overlay-sql', { ...PLAIN, layoutSchema: 1, bounds: BOUNDS, shapes: [] });
    const q = db.only('INSERT INTO map_world_reports');
    // Merge only at the SAME schema; a newer client's patch replaces the row and an older one's is dropped.
    expect(flat(q.sql)).toContain(
      'layout = CASE WHEN map_world_reports.layout_schema < EXCLUDED.layout_schema THEN EXCLUDED.layout' +
        ' WHEN map_world_reports.layout_schema = EXCLUDED.layout_schema THEN map_world_reports.layout || EXCLUDED.layout' +
        ' ELSE map_world_reports.layout END'
    );
    expect(flat(q.sql)).toContain('layout_schema = GREATEST(map_world_reports.layout_schema, EXCLUDED.layout_schema)');
    expect(patchOf(db)).toEqual({ schema: 1, bounds: BOUNDS, shapes: [] });
    expect(q.params[6]).toBe(1);
  });

  it('leaves shapes out of the patch when the report did not carry them', async () => {
    const db = makeFakeDb();
    await recordWorldReport(db, 'test-overlay-sql', { ...PLAIN, layoutSchema: 1, bounds: BOUNDS });
    expect(patchOf(db)).toEqual({ schema: 1, bounds: BOUNDS });
  });

  /** A shape the validator cannot read is a bug in a world file, and a silently thinner map hides it; the log line is the only place the count goes. */
  it('says on the console how many shapes it dropped and for which world, and nothing when it dropped none', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const db = makeFakeDb();
      const rect = { kind: 'rect', x: 0, z: 0, w: 1, d: 1 };
      await recordWorldReport(db, 'test-overlay-sql', { ...PLAIN, layoutSchema: 1, bounds: BOUNDS, shapes: [rect, { kind: 'hexagon' }, 7] });
      expect(patchOf(db).shapes).toEqual([rect]);
      expect(warn).toHaveBeenCalledWith('[map-report] dropped 2 unreadable shapes for test-overlay-sql');
      warn.mockClear();
      await recordWorldReport(db, 'test-overlay-sql', { ...PLAIN, layoutSchema: 1, bounds: BOUNDS, shapes: [rect] });
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });

  it('sends an empty patch and schema 0 for a report with no layout, or one under a schema it does not read', async () => {
    const db = makeFakeDb();
    await recordWorldReport(db, 'test-overlay-sql', PLAIN);
    expect(patchOf(db)).toEqual({});
    expect(db.only('INSERT INTO map_world_reports').params[6]).toBe(0);
    db.clear();
    await recordWorldReport(db, 'test-overlay-sql', { ...PLAIN, layoutSchema: 7, bounds: BOUNDS, shapes: [], ground: ground(150) });
    expect(patchOf(db)).toEqual({});
  });

  it('includes a ground only when it decodes, and keeps the bounds when it does not', async () => {
    const db = makeFakeDb();
    await recordWorldReport(db, 'test-overlay-sql', { ...PLAIN, layoutSchema: 1, bounds: BOUNDS, shapes: [], ground: { ...ground(1), nx: 4 } });
    expect(patchOf(db)).toEqual({ schema: 1, bounds: BOUNDS, shapes: [] });
    db.clear();
    await recordWorldReport(db, 'test-overlay-sql', { ...PLAIN, layoutSchema: 1, bounds: BOUNDS, shapes: [], ground: ground(150) });
    expect(patchOf(db).ground).toEqual(ground(150));
  });
});
