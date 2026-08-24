import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
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
  revertOverlayTo,
  saveOverlayVersion,
} from './mapOverlay';

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
});
