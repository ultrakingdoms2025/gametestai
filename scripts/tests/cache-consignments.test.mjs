import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';

/**
 * CONSIGNMENTS: the ninth charter column.
 *
 * ── What was missing ──────────────────────────────────────────────────────
 *
 * `Caches` placed six sites a world, gave each a deterministic identity
 * (`cacheSiteId`), and remembered exactly one thing about them: `_emptied`, a
 * map of restock deadlines that `_prune` DELETES the moment they pass. That is
 * the right structure for a timer and it is not a record: three minutes after
 * a player found the last cache in a world, nothing anywhere said they had
 * found any of them.
 *
 * Meanwhile every planet's charter record was ONE column (`seams`) and
 * Medieval's was one (`relics`) - fourteen worlds with a single fraction each -
 * and `Retention` draws its dailies from unfinished charter columns, so it was
 * also fourteen worlds with a single kind of daily.
 *
 * The fix is a grow-only `found` set beside the expiring one, and a learned
 * denominator over it. Nothing is authored: the numerator is an identity set
 * `Caches` owns, and the denominator is what the world actually placed, which
 * `Caches` already announces.
 *
 * ── The proof each gate can fail ──────────────────────────────────────────
 *
 * Against the pre-change tree:
 *   'the find record outlives the restock clock'   - `foundIds` did not exist
 *   'caches:changed carries what a record needs'   - payload had no total/found
 *   'the record survives a save round trip'        - `serialize` had no `found`
 *   'a world with caches gains a ninth column'     - no such column
 *   'the consignment numerator is the id set'      - same
 */

const { Caches, cacheSiteId, RESTOCK_SECONDS } = await import('../../src/systems/Caches.js');
const { Charters, CHARTER_COLUMNS } = await import('../../src/systems/Charters.js');
const { EventBus } = await import('../../src/core/EventBus.js');

/* ====================================================================== */
/* Rigs - the shape `retention.test.mjs` established, and why              */
/* ====================================================================== */

/**
 * A world that nominates its own cache sites, each with a finite `y`.
 *
 * The authored channel with a height is the one path through
 * `Caches._onWorld` that consults no physics at all, which is what lets these
 * cases drive the REAL placement code against a stub that answers nothing.
 */
function fakeWorld(id, sites) {
  return {
    id,
    cacheSites: sites,
    contentBounds: {
      min: new THREE.Vector3(-180, 0, -180),
      max: new THREE.Vector3(180, 60, 180),
    },
  };
}

function fakeLoot() {
  return {
    spawn(pos, contents, opts) {
      return { active: true, contents, pos: pos.clone(), tag: opts?.tag ?? null };
    },
    despawn(p) { if (!p?.active) return false; p.active = false; return true; },
  };
}

const deadPhysics = { raycast: () => null, groundHeight: () => null };

/** Three authored high sites, far enough apart to clear `HIGH_APART`. */
const SITES = [
  { x: 0, y: 30, z: 0, label: 'a' },
  { x: 90, y: 30, z: 0, label: 'b' },
  { x: 0, y: 30, z: 90, label: 'c' },
];

function cacheRig({ at = 0 } = {}) {
  const bus = new EventBus();
  const loot = fakeLoot();
  let clock = at;
  const announced = [];
  bus.on('caches:changed', (p) => announced.push(p));
  const caches = new Caches({
    bus, physics: deadPhysics, loot, worldManager: null, now: () => clock,
  });
  return {
    bus,
    caches,
    announced,
    advance(seconds) { clock += seconds * 1000; },
    enter(id, sites = SITES) { bus.emit('world:changed', { id, world: fakeWorld(id, sites) }); },
    /** Collect the nth live site, through the channel `Loot` really emits on. */
    collect(n = 0) {
      const site = caches.sites.filter((s) => s.pickup)[n];
      assert.ok(site, 'there was no stocked site to collect');
      site.pickup.active = false;
      bus.emit('loot:collected', { pickup: site.pickup });
      return site;
    },
  };
}

/* ====================================================================== */
/* 1. A record that does not expire                                        */
/* ====================================================================== */

test('the find record outlives the restock clock', () => {
  const r = cacheRig();
  r.enter('medieval');
  assert.equal(r.caches.sites.length, 3, 'the authored sites did not place');
  assert.equal(r.caches.foundCount('medieval'), 0);

  const site = r.collect(0);
  assert.equal(r.caches.foundCount('medieval'), 1);
  assert.ok(r.caches.foundIds.includes(site.id));

  /* THE WHOLE POINT. Wind past the restock window: `_emptied` prunes itself
   * empty by design, and the record must not go with it. Before the find set
   * existed, this is the moment the game forgot the player had ever been
   * there. */
  r.advance(RESTOCK_SECONDS + 60);
  r.caches._prune();
  assert.equal(r.caches._emptied.size, 0, 'the restock clock did not expire');
  assert.equal(r.caches.foundCount('medieval'), 1,
    'the find record expired with the restock deadline');

  // ..and re-entering the world restocks the site without un-finding it.
  r.enter('medieval');
  assert.equal(r.caches.sites.filter((s) => s.pickup).length, 3);
  assert.equal(r.caches.foundCount('medieval'), 1);
});

test('the record is per world and matched on an exact prefix', () => {
  const r = cacheRig();
  r.enter('medieval');
  r.collect(0);
  r.enter('citadel');
  r.collect(0);
  r.collect(0);
  assert.equal(r.caches.foundCount('medieval'), 1);
  assert.equal(r.caches.foundCount('citadel'), 2);
  assert.equal(r.caches.foundCount('space'), 0);
  /* `cacheSiteId` is `worldId/kind/x_z`, so the slash is what stops one world
   * id from being read as the prefix of another. */
  for (const id of r.caches.foundIds) assert.match(id, /^(medieval|citadel)\/high\//);
  assert.equal(cacheSiteId('space', 'high', 1, 2), 'space/high/1_2');
});

test('a cache Loot released without a collection is not a find', () => {
  const r = cacheRig();
  r.enter('medieval');
  /* `update`'s safety net empties a site whose pickup went inactive with no
   * event - a world clear, a recycle. It writes a restock deadline, and it
   * must NOT write a find: nobody collected anything. */
  const site = r.caches.sites.find((s) => s.pickup);
  site.pickup.active = false;
  r.caches.update(1 / 60);
  assert.equal(r.caches._emptied.has(site.id), true, 'the safety net stopped writing a deadline');
  assert.equal(r.caches.foundCount('medieval'), 0,
    'a cache nobody collected was credited as a consignment');
});

/* ====================================================================== */
/* 2. The announcement a record can be learned from                        */
/* ====================================================================== */

test('caches:changed carries what a record needs, and keeps what a map needs', () => {
  const r = cacheRig();
  r.enter('medieval');
  const first = r.announced.at(-1);
  assert.equal(first.worldId, 'medieval');
  assert.equal(first.total, 3, 'the announcement does not say how many sites there are');
  assert.equal(first.found, 0);
  assert.ok(Array.isArray(first.sites), 'the marker list the minimap reads is gone');
  assert.equal(first.sites.length, 3);

  r.collect(0);
  const after = r.announced.at(-1);
  assert.equal(after.found, 1, 'a collection did not move the announced numerator');
  assert.equal(after.total, 3);
});

test('a world that allows no caches announces nothing to learn', () => {
  const r = cacheRig();
  r.enter('medieval');
  /* The Coil: `WorldRules` refuses caches outright, so `_onWorld` returns
   * early. It must still announce, or `Charters` keeps a denominator for a
   * world that has stopped publishing one - the shrink rule its header
   * states. */
  r.bus.emit('world:changed', { id: 'maze', world: { id: 'maze', rules: { caches: false } } });
  const last = r.announced.at(-1);
  assert.equal(last.worldId, 'maze');
  assert.equal(last.total, 0, 'a world with no caches announced a denominator');
});

/* ====================================================================== */
/* 3. Persistence                                                          */
/* ====================================================================== */

test('the record survives a save round trip, and a restore REPLACES', () => {
  const r = cacheRig();
  r.enter('medieval');
  const site = r.collect(0);
  const snap = r.caches.serialize();
  assert.ok(Array.isArray(snap.found), 'the save carries no find record');
  assert.ok(snap.found.includes(site.id));
  assert.ok(snap.emptied, 'the restock ledger went missing');

  const b = cacheRig();
  b.enter('medieval');
  b.caches.deserialize(snap);
  assert.equal(b.caches.foundCount('medieval'), 1);

  /* REPLACE, not merge: a load has to be able to take progress away, which is
   * the rule `Relics`, `Viewpoints` and `Charters` all record. */
  b.caches.deserialize({ emptied: {}, found: [] });
  assert.equal(b.caches.foundCount('medieval'), 0,
    'a load could only ever add, so a player kept progress the save lacked');

  /* A save written before this key existed. Absence is valid. */
  b.caches.deserialize({ emptied: {} });
  assert.equal(b.caches.foundCount('medieval'), 0);
  assert.equal(b.caches.foundIds.length, 0);
});

test('a restore announces, because it moved the record', () => {
  const r = cacheRig();
  r.enter('medieval');
  const before = r.announced.length;
  r.caches.deserialize({ emptied: {}, found: [r.caches.sites[0].id] });
  assert.ok(r.announced.length > before, 'a load left the board showing the old session');
  assert.equal(r.announced.at(-1).found, 1);
});

/* ====================================================================== */
/* 4. The column                                                           */
/* ====================================================================== */

const worldManager = { ids: ['medieval', 'citadel', 'maze'], displayNameOf: (id) => id };

test('Consignments is a column of the board, in the order it is drawn', () => {
  const spec = CHARTER_COLUMNS.find((c) => c.key === 'caches');
  assert.ok(spec, 'the board has no consignment column');
  assert.equal(spec.label, 'Consignments');
  assert.equal(spec.noun, 'consignments');
  /* Beside the seams, both being material the world placed. The order is what
   * `_hint` walks to name the next thing to do, so it is worth pinning. */
  const keys = CHARTER_COLUMNS.map((c) => c.key);
  assert.equal(keys.indexOf('caches'), keys.indexOf('seams') + 1);
});

test('a world with caches gains a ninth column, learned from the announcement', () => {
  const r = cacheRig();
  const charters = new Charters({ bus: r.bus, worldManager, caches: r.caches });
  r.enter('medieval');

  const rec = charters.record('medieval');
  const col = rec.columns.find((c) => c.key === 'caches');
  assert.ok(col, 'the world published three caches and the record has no column for them');
  assert.equal(col.need, 3, 'the denominator is not what the world actually placed');
  assert.equal(col.have, 0);

  /* The numerator is the identity set, read live. Nothing is stored here - the
   * rule the whole file turns on. */
  r.collect(0);
  assert.equal(charters.record('medieval').columns.find((c) => c.key === 'caches').have, 1);
  assert.equal(charters.serialize().rosters.medieval.caches, 3,
    'the learned denominator is not persisted with the other eight');
});

test('the consignment numerator is the id set, and a shrinking world sheds it', () => {
  const r = cacheRig();
  const charters = new Charters({ bus: r.bus, worldManager, caches: r.caches });
  r.enter('medieval');
  r.collect(0);
  r.collect(0);
  assert.equal(charters.record('medieval').columns.find((c) => c.key === 'caches').have, 2);

  /* The world rebuilt with one site. The denominator follows the world down,
   * and the numerator is CLAMPED so a stale find cannot read 2/1. */
  r.enter('medieval', [SITES[0]]);
  const col = charters.record('medieval').columns.find((c) => c.key === 'caches');
  assert.equal(col.need, 1);
  assert.ok(col.have <= col.need, `a numerator of ${col.have} ran past its denominator`);
});

test('a build with no caches system wired keeps the eight columns it had', () => {
  /* The gate on `this.caches`. `caches:changed` fires whether or not this file
   * was handed a handle, and learning a denominator whose numerator can only
   * read zero would paint every world 0/6 for ever. */
  const r = cacheRig();
  const charters = new Charters({ bus: r.bus, worldManager });
  r.enter('medieval');
  const rec = charters.record('medieval');
  assert.equal(rec.columns.find((c) => c.key === 'caches'), undefined,
    'a column was drawn whose numerator can never move');
  assert.equal(rec.known, false, 'an unlearnable column made an unvisited world known');
});

test('a completed consignment run counts toward the charter like any other column', () => {
  const r = cacheRig();
  const charters = new Charters({ bus: r.bus, worldManager, caches: r.caches });
  const restored = [];
  r.bus.on('charter:restored', (p) => restored.push(p.id));
  r.enter('medieval');
  r.collect(0);
  r.collect(0);
  r.collect(0);
  const rec = charters.record('medieval');
  assert.equal(rec.have, 3);
  assert.equal(rec.need, 3);
  assert.equal(rec.complete, true);
  assert.deepEqual(restored, ['medieval'],
    'a world whose only column is consignments never restored its charter');
});
