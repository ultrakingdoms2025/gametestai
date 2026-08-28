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
import { MAX_SHAPES, encodeHeights } from './mapLayout';
import { MAP_OVERLAY_SCHEMA } from './mapOverlaySchema';
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
const PLAIN = { appliedVersion: 1, builtVersion: 0, objects: [], applied: [], unresolved: [] };
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
      builtVersion: 0,
      objects: [{ name: 'crate.a', position: { x: 0, y: 0, z: 0 } }],
      applied: [{ id: 'm1', ok: true, colliders: 2 }],
      unresolved: [],
    });
    let report = await readWorldReport(db, WORLD);
    expect(report?.objects).toHaveLength(1);
    expect(report?.appliedVersion).toBe(1);

    await recordWorldReport(db, WORLD, {
      appliedVersion: 2,
      builtVersion: 0,
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
      builtVersion: 0,
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
    expect(cols.rows.map((r) => r.column_name)).toEqual(expect.arrayContaining(['layout', 'layout_schema', 'built_version']));
  });

  it('reads layout null, with a fresh reportedAt, for a world whose reports never carried one', async () => {
    expect(await recordWorldReport(db, WORLD, PLAIN)).toEqual({ layout: 'none', warnings: [] });
    const stored = await readWorldReport(db, WORLD);
    expect(stored?.layout).toBeNull();
    expect(Date.now() - Date.parse(stored!.reportedAt)).toBeLessThan(60_000);
  });

  it('stores a layout and hands it back byte for byte', async () => {
    const shapes = [{ kind: 'rect', x: 0, z: 0, w: 4, d: 4, fill: 0x224466 }];
    expect(await recordWorldReport(db, WORLD, { ...PLAIN, layoutSchema: 1, bounds: BOUNDS, shapes, ground: ground(150) })).toEqual({ layout: 'stored', warnings: [] });
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
    // The answer says the prior was kept, and the row agrees: the same ground as before, not the one that did not decode.
    expect(await recordWorldReport(db, WORLD, { ...PLAIN, layoutSchema: 1, bounds: BOUNDS, shapes: [], ground: { ...ground(999), nx: 4 } }))
      .toEqual({ layout: 'kept-prior', warnings: ['unusable ground; prior kept'] });
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

  it('stores builtVersion, reads it back, and replaces it on every report whatever the layout did', async () => {
    await recordWorldReport(db, WORLD, { ...PLAIN, builtVersion: 3, layoutSchema: 1, bounds: BOUNDS, shapes: [], ground: ground(100) });
    expect((await readWorldReport(db, WORLD))?.builtVersion).toBe(3);
    await recordWorldReport(db, WORLD, { ...PLAIN, builtVersion: 5 });
    const after = await readWorldReport(db, WORLD);
    expect(after?.builtVersion).toBe(5);
    // The layout merge is untouched by it: a layout-less second report keeps the ground the first one stored.
    expect(after?.layout?.ground).toEqual(ground(100));
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

  /**
   * Clamp, never refuse. `applied_version` is INTEGER: a forged 1e300 would refuse the whole INSERT — the catalogue
   * and the layout with it — and the route would 500 on a number nobody can see. The row is written, capped.
   */
  it('clamps appliedVersion into the INTEGER column: 1e300 is stored as 2147483647, a negative or a word as 0', async () => {
    const db = makeFakeDb();
    for (const [raw, clamped] of [[1e300, 2147483647], [2147483648, 2147483647], [-1, 0], ['x', 0], [null, 0], [NaN, 0], [2.9, 2], [7, 7]] as const) {
      db.clear();
      await recordWorldReport(db, 'test-overlay-sql', { ...PLAIN, appliedVersion: raw as unknown as number });
      expect(db.only('INSERT INTO map_world_reports').params[1], String(raw)).toBe(clamped);
    }
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

  /**
   * Truncation is not unreadability, and the two are said apart, each only when it happened. The boundary:
   * MAX_SHAPES readable out of MAX_SHAPES + 1 sent is one unreadable and NOTHING truncated — a check on the
   * lengths alone calls that "kept the first 5000 of 5001" and never prints the line that names the bad shape.
   */
  it('says "kept the first" for what the cap left unread and "dropped" for what it could not read, each only when it happened', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const db = makeFakeDb();
      const rect = { kind: 'rect', x: 0, z: 0, w: 1, d: 1 };
      const good = (n: number) => Array(n).fill(rect);
      const kept = (sent: number) => `[map-report] kept the first ${MAX_SHAPES} of ${sent} shapes for test-overlay-sql`;
      const dropped = '[map-report] dropped 1 unreadable shapes for test-overlay-sql';

      // MAX_SHAPES + 1 readable: one truncated, none unreadable.
      await recordWorldReport(db, 'test-overlay-sql', { ...PLAIN, layoutSchema: 1, bounds: BOUNDS, shapes: good(MAX_SHAPES + 1) });
      expect(patchOf(db).shapes).toHaveLength(MAX_SHAPES);
      expect(warn.mock.calls).toEqual([[kept(MAX_SHAPES + 1)]]);

      // MAX_SHAPES + 1 with one unreadable: MAX_SHAPES readable, so NOTHING was truncated.
      warn.mockClear(); db.clear();
      await recordWorldReport(db, 'test-overlay-sql', { ...PLAIN, layoutSchema: 1, bounds: BOUNDS, shapes: [{ kind: 'hexagon' }, ...good(MAX_SHAPES)] });
      expect(patchOf(db).shapes).toHaveLength(MAX_SHAPES);
      expect(warn.mock.calls).toEqual([[dropped]]);

      // MAX_SHAPES + 2 with one unreadable: both happened, both are said.
      warn.mockClear(); db.clear();
      await recordWorldReport(db, 'test-overlay-sql', { ...PLAIN, layoutSchema: 1, bounds: BOUNDS, shapes: [{ kind: 'hexagon' }, ...good(MAX_SHAPES + 1)] });
      expect(patchOf(db).shapes).toHaveLength(MAX_SHAPES);
      expect(warn).toHaveBeenCalledTimes(2);
      expect(warn).toHaveBeenCalledWith(kept(MAX_SHAPES + 2));
      expect(warn).toHaveBeenCalledWith(dropped);
    } finally {
      warn.mockRestore();
    }
  });

  /** A bounds or ground that arrived and failed leaves the editor with no map, or yesterday's; that must be said somewhere, and absent is not the same as unusable. */
  it('says when bounds or ground it was sent could not be used, and nothing when they were simply not sent', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const db = makeFakeDb();
      await recordWorldReport(db, 'test-overlay-sql', { ...PLAIN, layoutSchema: 1, bounds: { min: 'no' }, shapes: [] });
      expect(warn).toHaveBeenCalledWith('[map-report] unusable bounds for test-overlay-sql; prior bounds and shapes kept');
      warn.mockClear();
      await recordWorldReport(db, 'test-overlay-sql', { ...PLAIN, layoutSchema: 1, bounds: BOUNDS, shapes: [], ground: { ...ground(1), nx: 4 } });
      expect(warn).toHaveBeenCalledWith('[map-report] unusable ground for test-overlay-sql; prior kept');
      warn.mockClear();
      await recordWorldReport(db, 'test-overlay-sql', { ...PLAIN, layoutSchema: 1, bounds: BOUNDS, shapes: [] });
      await recordWorldReport(db, 'test-overlay-sql', { ...PLAIN, layoutSchema: 1, bounds: BOUNDS, shapes: [], ground: null });
      await recordWorldReport(db, 'test-overlay-sql', { ...PLAIN, layoutSchema: 1, bounds: null, shapes: [] });   // null is not sent, for bounds as for ground
      await recordWorldReport(db, 'test-overlay-sql', PLAIN);
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
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});   // the mismatch is said now; its line has its own test below
    try {
      await recordWorldReport(db, 'test-overlay-sql', { ...PLAIN, layoutSchema: 7, bounds: BOUNDS, shapes: [], ground: ground(150) });
    } finally {
      warn.mockRestore();
    }
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

  /**
   * The outcome the route answers with, one case per value. Pinned here, on the recording client, because the outcome
   * is decided from the report alone — a layout that failed never reaches the database, so a database cannot show it.
   */
  it('answers none for a report that carried no layoutSchema, and warns of nothing', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      expect(await recordWorldReport(makeFakeDb(), 'test-overlay-sql', PLAIN)).toEqual({ layout: 'none', warnings: [] });
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });

  it('answers stored when every layout part the report carried was stored: bounds, shapes and ground together, or a ground alone', async () => {
    const db = makeFakeDb();
    expect(await recordWorldReport(db, 'test-overlay-sql', { ...PLAIN, layoutSchema: 1, bounds: BOUNDS, shapes: [], ground: ground(150) })).toEqual({ layout: 'stored', warnings: [] });
    expect(await recordWorldReport(db, 'test-overlay-sql', { ...PLAIN, layoutSchema: 1, ground: ground(150) })).toEqual({ layout: 'stored', warnings: [] });
  });

  it('answers kept-prior, with the reason, when a part it carried was unusable, even beside a part that was stored', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const db = makeFakeDb();
      expect(await recordWorldReport(db, 'test-overlay-sql', { ...PLAIN, layoutSchema: 1, bounds: BOUNDS, shapes: [], ground: { ...ground(1), nx: 4 } }))
        .toEqual({ layout: 'kept-prior', warnings: ['unusable ground; prior kept'] });
      expect(patchOf(db)).toEqual({ schema: 1, bounds: BOUNDS, shapes: [] });   // the bounds still landed
      db.clear();
      expect(await recordWorldReport(db, 'test-overlay-sql', { ...PLAIN, layoutSchema: 1, bounds: { min: 'no' }, shapes: [] }))
        .toEqual({ layout: 'kept-prior', warnings: ['unusable bounds; prior bounds and shapes kept'] });
      db.clear();
      // The empty-Box3 case: the game omits `bounds` and sends its floorplan anyway, and shapes have nowhere to go without bounds.
      expect(await recordWorldReport(db, 'test-overlay-sql', { ...PLAIN, layoutSchema: 1, shapes: [{ kind: 'rect', x: 0, z: 0, w: 1, d: 1 }] }))
        .toEqual({ layout: 'kept-prior', warnings: ['shapes without bounds; not stored, prior kept'] });
      expect(patchOf(db)).toEqual({});
      expect(warn).toHaveBeenCalledWith('[map-report] shapes without bounds for test-overlay-sql; not stored, prior kept');
    } finally {
      warn.mockRestore();
    }
  });

  /** The schema mismatch was the one kept-prior that was silent: `if (report.layoutSchema !== LAYOUT_SCHEMA) return patch;`, and no line at all. */
  it('says on the console, and in its answer, that a layoutSchema it does not read kept the prior layout', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const db = makeFakeDb();
      const outcome = await recordWorldReport(db, 'test-overlay-sql', { ...PLAIN, layoutSchema: 2, bounds: BOUNDS, shapes: [], ground: ground(150) });
      expect(outcome).toEqual({ layout: 'kept-prior', warnings: ['layoutSchema 2 is not 1'] });
      expect(warn.mock.calls).toEqual([['[map-report] layoutSchema 2 is not 1 for test-overlay-sql; prior layout kept']]);
      expect(patchOf(db)).toEqual({});
      expect(db.only('INSERT INTO map_world_reports').params[6]).toBe(0);
    } finally {
      warn.mockRestore();
    }
  });
});

/** The third column, and the SQL that carries it - pinned on the recording client because CI never runs the DDL. */
describe('built_version', () => {
  it('ensure adds built_version with ADD COLUMN IF NOT EXISTS and a default, after the layout columns', async () => {
    resetMapOverlaySchemaMemo();
    const db = makeFakeDb();
    await ensureMapOverlaySchema(db);
    expect(db.matching('ALTER TABLE map_world_reports').map((q) => flat(q.sql))).toEqual([
      "ALTER TABLE map_world_reports ADD COLUMN IF NOT EXISTS layout JSONB NOT NULL DEFAULT '{}'::jsonb",
      'ALTER TABLE map_world_reports ADD COLUMN IF NOT EXISTS layout_schema INTEGER NOT NULL DEFAULT 0',
      'ALTER TABLE map_world_reports ADD COLUMN IF NOT EXISTS built_version INTEGER NOT NULL DEFAULT 0',
    ]);
    resetMapOverlaySchemaMemo();
  });

  it('the upsert binds built_version as the eighth parameter, clamped, and replaces it outright - never under the layout CASE', async () => {
    const db = makeFakeDb();
    await recordWorldReport(db, 'test-overlay-sql', { ...PLAIN, builtVersion: 3.7 });
    const q = db.only('INSERT INTO map_world_reports');
    expect(flat(q.sql)).toContain('layout_schema, built_version, reported_at)');
    expect(flat(q.sql)).toContain('$7, $8, NOW())');
    expect(flat(q.sql)).toContain('built_version = EXCLUDED.built_version,');
    expect(q.params[7]).toBe(3);
    expect(q.params[6]).toBe(0);
    // The same clamp as applied_version: floor 0, cap 2^31 - 1, never refuse (a forged 1e300 would refuse the whole row).
    for (const [raw, clamped] of [[-1, 0], ['x', 0], [undefined, 0], [null, 0], [NaN, 0], [12, 12], [1e300, 2147483647], [2147483648, 2147483647]] as const) {
      db.clear();
      await recordWorldReport(db, 'test-overlay-sql', { ...PLAIN, builtVersion: raw as unknown as number });
      expect(db.only('INSERT INTO map_world_reports').params[7], String(raw)).toBe(clamped);
    }
  });

  it('readWorldReport reads it back, and 0 for a row written before the column', async () => {
    const row = { applied_version: 2, objects: [], applied: [], unresolved: [], layout: {}, layout_schema: 0, reported_at: '2026-08-28T00:00:00.000Z' };
    const five = makeFakeDb((sql) => (sql.startsWith('SELECT applied_version') ? [{ ...row, built_version: 5 }] : undefined));
    expect((await readWorldReport(five, 'w'))?.builtVersion).toBe(5);
    const old = makeFakeDb((sql) => (sql.startsWith('SELECT applied_version') ? [row] : undefined));
    expect((await readWorldReport(old, 'w'))?.builtVersion).toBe(0);
  });
});

/**
 * A revert is a WRITE under the current schema, not a read of the old one:
 * reverting to a version saved before v2 must land a v2 document. Proved on
 * the recording client so it runs on every machine.
 */
describe('revertOverlayTo — writes the migrated document', () => {
  it('reverting to a v1 version that hid an object inserts a schema-2 document holding a remove', async () => {
    const v1 = [{ kind: 'move', id: 'h1', target: { name: 'crate.a' }, position: { x: 4, y: 0, z: 4 }, hidden: true }, MOVE];
    const db = makeFakeDb((sql, params) => {
      if (sql.startsWith('SELECT entries FROM map_overlays')) return [{ entries: v1 }];
      if (sql.startsWith('INSERT INTO map_overlays')) {
        return [{ version: 3, schema: params[1], entries: JSON.parse(String(params[2])), author: params[3], note: params[4], created_at: '2026-08-28T00:00:00.000Z' }];
      }
      return undefined;
    });
    const saved = await revertOverlayTo(db, { worldId: 'test-overlay-sql', version: 1, author: 'owner@example.com' });
    const insert = db.only('INSERT INTO map_overlays');
    expect(insert.params[1]).toBe(MAP_OVERLAY_SCHEMA);
    expect(JSON.parse(String(insert.params[2]))).toEqual([{ kind: 'remove', id: 'h1', target: { name: 'crate.a' } }, MOVE]);
    expect(saved?.schema).toBe(2);
    expect(saved?.entries[0]).toEqual({ kind: 'remove', id: 'h1', target: { name: 'crate.a' } });
    expect(saved?.note).toBe('revert to version 1');
  });
});

/**
 * Every string this store cuts before it becomes JSON in Postgres is cut by
 * CODE POINT. `String.prototype.slice` counts UTF-16 units, so a cut through
 * an astral character leaves a lone surrogate, which `JSON.stringify` writes
 * as `\ud83d` and Postgres refuses — the report route 500s on a name the game
 * itself reported. Pinned on the recording client, per site, as the bytes
 * handed to `db.query`.
 */
describe('what is cut is cut by code point, at every site', () => {
  /** A lone surrogate in a RAW string (author and note are TEXT params, handed over as they are). */
  const lone = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/;
  /**
   * The same defect in JSON TEXT: `JSON.stringify` writes a lone surrogate as the six ASCII characters
   * `\ud83d`, so `lone` can never fire on a jsonb param — it would have to match a backslash. This does.
   * Two false positives: a serializer that escapes astral PAIRS as well (`\ud83d\ude00` for 😀 — the self-check
   * below pins that `JSON.stringify` does not), and a name literally holding the six ASCII characters (unguarded;
   * no fixture here holds one).
   */
  const escaped = /\\ud[89a-f][0-9a-f]{2}/i;
  /** `n` ASCII characters, then an emoji straddling the cut at `n + 1`, then more. */
  const straddle = (n: number) => `${'a'.repeat(n)}😀tail`;
  const whole = (n: number) => `${'a'.repeat(n)}😀`;

  it('the instruments bite: a lone surrogate matches lone raw and escaped once stringified; a pair matches neither', () => {
    expect('\ud83d').toMatch(lone);
    expect(JSON.stringify('\ud83d')).toMatch(escaped);
    expect(JSON.stringify('\ud83d')).not.toMatch(lone);   // the vacuous form this replaces
    expect(JSON.stringify(['x\udc00'])).toMatch(escaped);
    expect('😀').not.toMatch(lone);
    expect(JSON.stringify('😀')).not.toMatch(escaped);
  });

  it('author and note, on the save', async () => {
    const db = makeFakeDb((sql, params) => {
      if (sql.startsWith('INSERT INTO map_overlays')) {
        return [{ version: 1, schema: params[1], entries: [], author: params[3], note: params[4], created_at: '2026-08-28T00:00:00.000Z' }];
      }
      return undefined;
    });
    await saveOverlayVersion(db, { worldId: 'test-overlay-sql', entries: [], author: straddle(199), note: straddle(499) });
    const insert = db.only('INSERT INTO map_overlays');
    expect(insert.params[3]).toBe(whole(199));
    expect(insert.params[4]).toBe(whole(499));
    for (const p of [insert.params[3], insert.params[4]]) expect(p).not.toMatch(lone);
  });

  /**
   * The cut cannot make a lone surrogate, but a JSON body can spell one (`"\ud83d"` is valid JSON text) and the
   * save route parses it into exactly that. The store's cut is `toWellFormed()`, so the value the save route hands
   * `saveOverlayVersion` is stored as U+FFFD — what a TEXT column made of it anyway — and the route answers 200.
   */
  it("the save route's store call: an author or note that arrived already malformed is stored as U+FFFD, not refused", async () => {
    const db = makeFakeDb((sql, params) => {
      if (sql.startsWith('INSERT INTO map_overlays')) {
        return [{ version: 1, schema: params[1], entries: [], author: params[3], note: params[4], created_at: '2026-08-28T00:00:00.000Z' }];
      }
      return undefined;
    });
    const saved = await saveOverlayVersion(db, { worldId: 'test-overlay-sql', entries: [], author: 'own\ud83der@example.com', note: 'moved \udc00 it' });
    const insert = db.only('INSERT INTO map_overlays');
    expect(insert.params[3]).toBe('own\ufffder@example.com');
    expect(insert.params[4]).toBe('moved \ufffd it');
    for (const p of [insert.params[3], insert.params[4]]) expect(p).not.toMatch(lone);
    expect(saved.author).toBe('own\ufffder@example.com');
  });

  /** The report route's store call, where the string lands in a jsonb param: `::jsonb` would have refused `\ud83d`. */
  it("the report route's store call: a reported name that arrived already malformed is stored as U+FFFD inside valid JSON", async () => {
    const db = makeFakeDb();
    await recordWorldReport(db, 'test-overlay-sql', {
      ...PLAIN,
      objects: [{ name: 'cr\ud83date', position: { x: 1, y: 2, z: 3 } }],
      unresolved: [{ id: 'e\udc00', reason: 'na\ud83dme' }],
    });
    const q = db.only('INSERT INTO map_world_reports');
    expect(String(q.params[2])).not.toMatch(escaped);
    expect(String(q.params[4])).not.toMatch(escaped);
    expect(JSON.parse(String(q.params[2]))).toEqual([{ name: 'cr\ufffdate', position: { x: 1, y: 2, z: 3 } }]);
    expect(JSON.parse(String(q.params[4]))).toEqual([{ id: 'e\ufffd', reason: 'na\ufffdme' }]);
  });

  it("a reported object's name", async () => {
    const db = makeFakeDb();
    await recordWorldReport(db, 'test-overlay-sql', { ...PLAIN, objects: [{ name: straddle(199), position: { x: 1, y: 2, z: 3 } }] });
    const objects = String(db.only('INSERT INTO map_world_reports').params[2]);
    expect(objects).not.toMatch(escaped);
    expect(JSON.parse(objects)).toEqual([{ name: whole(199), position: { x: 1, y: 2, z: 3 } }]);
  });

  it("an applied entry's id", async () => {
    const db = makeFakeDb();
    await recordWorldReport(db, 'test-overlay-sql', { ...PLAIN, applied: [{ id: straddle(63), ok: true, colliders: 2 }] });
    const applied = String(db.only('INSERT INTO map_world_reports').params[3]);
    expect(applied).not.toMatch(escaped);
    expect(JSON.parse(applied)).toEqual([{ id: whole(63), ok: true, colliders: 2 }]);
  });

  it("an unresolved entry's id and reason", async () => {
    const db = makeFakeDb();
    await recordWorldReport(db, 'test-overlay-sql', { ...PLAIN, unresolved: [{ id: straddle(63), reason: straddle(63) }] });
    const unresolved = String(db.only('INSERT INTO map_world_reports').params[4]);
    expect(unresolved).not.toMatch(escaped);
    expect(JSON.parse(unresolved)).toEqual([{ id: whole(63), reason: whole(63) }]);
  });
});
