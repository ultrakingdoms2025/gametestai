import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import * as THREE from 'three';

import { Physics, COLLISION_LAYER } from '../../src/physics/Physics.js';
import { MapOverlay } from '../../src/systems/MapOverlay.js';

/**
 * THE PLACEMENT OVERLAY, APPLIED TO A WORLD THE GAME ACTUALLY BUILT.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 *  WHY THIS FILE EXISTS
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Worlds are procedural code and one of them is 12,945 lines, so an admin map
 * editor cannot write world source without colliding head-on with the art
 * passes editing those same files. It writes a separate document, and this
 * system applies it after the world has finished building.
 *
 * The case that would otherwise ship broken, and is therefore the point of half
 * this file: **a world's visuals and its collision are separate structures.**
 * `Physics` stores baked world-space geometry with no back-reference to the
 * `Object3D` it came from. Move the mesh and nothing else, and there is an
 * invisible wall where the building used to be — a change that looks right in
 * every screenshot and is wrong to walk into. So the colliders move too, and
 * the terrain heightfield deliberately does not.
 *
 * These tests use the REAL `Physics` and real `THREE` objects. A fake physics
 * would only confirm that I called the methods I meant to call; the thing worth
 * knowing is whether the broadphase still answers correctly afterwards.
 */

/* ------------------------------------------------------------------ */
/* Rig                                                                 */
/* ------------------------------------------------------------------ */

function makeBus() {
  const handlers = new Map();
  const emitted = [];
  return {
    on(name, fn) {
      if (!handlers.has(name)) handlers.set(name, new Set());
      handlers.get(name).add(fn);
      return () => handlers.get(name)?.delete(fn);
    },
    emit(name, payload) {
      emitted.push({ name, payload });
      for (const fn of handlers.get(name) ?? []) fn(payload);
    },
    emitted,
  };
}

/** A world whose group holds one named crate at the origin-ish. */
function makeWorld(id = 'station') {
  const group = new THREE.Group();
  group.name = `world:${id}`;

  const crate = new THREE.Mesh(new THREE.BoxGeometry(2, 2, 2));
  crate.name = 'crate.alpha';
  crate.position.set(10, 0, 10);

  const barn = new THREE.Mesh(new THREE.BoxGeometry(4, 4, 4));
  barn.name = 'barn.main';
  barn.position.set(-30, 0, 0);

  const unnamed = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1));
  unnamed.position.set(50, 0, 50);

  group.add(crate, barn, unnamed);
  group.updateMatrixWorld(true);
  return { id, group, crate, barn };
}

/**
 * A fetch stand-in. `overlay` is what the GET answers; every POST is recorded.
 */
function makeFetch(overlay, { fail = false } = {}) {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url, method: init?.method ?? 'GET', body: init?.body ? JSON.parse(init.body) : null });
    if (fail) throw new Error('offline');
    if ((init?.method ?? 'GET') === 'GET') {
      return { ok: true, status: 200, json: async () => overlay };
    }
    return { ok: true, status: 200, json: async () => ({ ok: true }) };
  };
  fn.calls = calls;
  return fn;
}

/** Records what was spawned without needing the real pooled Loot. */
function makeLoot() {
  const spawned = [];
  const despawned = [];
  return {
    spawn(position, contents, opts) {
      const p = { position: position.clone ? position.clone() : { ...position }, contents, opts, active: true };
      spawned.push(p);
      return p;
    },
    despawn(p) {
      despawned.push(p);
      p.active = false;
      return true;
    },
    spawned,
    despawned,
  };
}

function doc(entries, { version = 1, admin = false, world = 'station' } = {}) {
  return { world, schema: 1, version, entries, admin };
}

function setup(overlay, { world = makeWorld(), fail = false } = {}) {
  const bus = makeBus();
  const physics = new Physics(bus);
  const loot = makeLoot();
  // `overlay` is handed out by reference, so a test can edit it in place to
  // stand for "the admin saved a new version" without the system needing a
  // test-only setter on it.
  const fetchImpl = makeFetch(overlay, { fail });
  const system = new MapOverlay({ bus, physics, loot, fetch: fetchImpl });
  return { bus, physics, loot, fetchImpl, system, world, doc: overlay };
}

async function enter({ bus, system, world }) {
  bus.emit('world:changed', { id: world.id, world });
  await system.applying;
}

/* ------------------------------------------------------------------ */
/* Fetching                                                            */
/* ------------------------------------------------------------------ */

test('asks the server for the overlay of the world that was just entered', async () => {
  const rig = setup(doc([]));
  await enter(rig);
  assert.equal(rig.fetchImpl.calls.length, 1);
  assert.match(rig.fetchImpl.calls[0].url, /\/api\/game\/map-overlay\?world=station/);
});

test('a failed fetch leaves the world exactly as it was built, and does not throw', async () => {
  const rig = setup(doc([]), { fail: true });
  const before = rig.world.crate.position.clone();
  await enter(rig);
  assert.deepEqual(rig.world.crate.position.toArray(), before.toArray());
  assert.equal(rig.loot.spawned.length, 0);
});

test('a malformed document applies nothing rather than half of it', async () => {
  for (const bad of [null, {}, { entries: 'no' }, { entries: [null, 7, 'x'] }]) {
    const rig = setup(bad);
    const before = rig.world.crate.position.clone();
    await enter(rig);
    assert.deepEqual(rig.world.crate.position.toArray(), before.toArray());
  }
});

/* ------------------------------------------------------------------ */
/* Moving                                                              */
/* ------------------------------------------------------------------ */

const moveCrate = {
  kind: 'move',
  id: 'm1',
  target: { name: 'crate.alpha' },
  position: { x: 40, y: 3, z: -20 },
};

test('a move resolves by name and sets the ABSOLUTE position it was given', async () => {
  const rig = setup(doc([moveCrate]));
  await enter(rig);
  assert.deepEqual(rig.world.crate.position.toArray(), [40, 3, -20]);
});

test('applying twice lands in the same place: the position is absolute, not a delta', async () => {
  const rig = setup(doc([moveCrate]));
  await enter(rig);
  await enter(rig);
  assert.deepEqual(rig.world.crate.position.toArray(), [40, 3, -20]);
});

test('a move takes the box collider that sat inside the object with it', async () => {
  const rig = setup(doc([moveCrate]));
  // The crate's own collider, built from the mesh exactly as a world would.
  const own = rig.physics.addBoxFromObject(rig.world.crate);
  // Somebody else's, well outside the crate, which must not be dragged along.
  const other = rig.physics.addBox(-100, 0, -100, 1, 1, 1);
  const otherCentre = other.center.clone();

  await enter(rig);

  assert.deepEqual(
    own.center.toArray().map((n) => Math.round(n * 1000) / 1000),
    [40, 3, -20]
  );
  assert.deepEqual(other.center.toArray(), otherCentre.toArray());
});

test('the moved collider is still findable by the broadphase at its NEW position', async () => {
  const rig = setup(doc([moveCrate]));
  const own = rig.physics.addBoxFromObject(rig.world.crate);
  await enter(rig);

  const near = rig.physics.queryNearby
    ? rig.physics.queryNearby(new THREE.Vector3(40, 3, -20), 4)
    : null;
  if (near) assert.ok([...near].includes(own), 'collider missing from its new grid cell');

  // Whatever the query helper is called, the ground under the new position must
  // now be the crate's top, and the ground under the OLD position must not be.
  const hereY = rig.physics.groundHeight(40, -20, 12, 20);
  const thereY = rig.physics.groundHeight(10, 10, 12, 20);
  assert.ok(hereY !== null && hereY > 3, `expected ground at the new position, got ${hereY}`);
  assert.ok(thereY === null || thereY < 1.5, `crate collider left behind at the old position (${thereY})`);
});

/**
 * The terrain exclusion, exercised rather than assumed.
 *
 * The heightfield's footprint is centred ON the crate here, deliberately: its
 * `center` therefore lies INSIDE the crate's world AABB and it is a genuine
 * candidate for the "collider belongs to this object" test. Written the obvious
 * way — a field off to one side — this test passed with the heightfield guard
 * deleted, because the field was never a candidate in the first place. That is
 * a gate reporting confidence about something it never touched.
 */
test('a move NEVER drags the terrain heightfield with it', async () => {
  const rig = setup(doc([moveCrate], { admin: true }));
  const crateCollider = rig.physics.addBoxFromObject(rig.world.crate);
  const heights = new Float32Array(9).fill(0);
  const field = rig.physics.addHeightfield({
    heights,
    nx: 3,
    nz: 3,
    // Spans 0..20 on both axes, so its centre is (10, 0, 10) — the crate's own
    // position, and inside the crate's bounding box.
    originX: 0,
    originZ: 0,
    stepX: 10,
  });
  const before = field.center.clone();
  assert.ok(
    new THREE.Box3().setFromObject(rig.world.crate).containsPoint(field.center),
    'the field must be a candidate, or this test proves nothing'
  );

  await enter(rig);

  assert.deepEqual(field.center.toArray(), before.toArray());
  assert.equal(rig.physics.heightfields.length, 1);
  // Still registered as terrain, still the only terrain, and — the number the
  // admin actually reads — NOT counted among the colliders that moved. One box
  // moved; the ground did not.
  assert.ok(rig.physics.heightfields.includes(field));
  assert.equal(rig.system.report.applied.find((a) => a.id === 'm1').colliders, 1);
  assert.equal(crateCollider.center.x, 40);
});

test('a move reports how many colliders came with it, so "none" is visible', async () => {
  const rig = setup(doc([moveCrate], { admin: true }));
  rig.physics.addBoxFromObject(rig.world.crate);
  await enter(rig);
  const outcome = rig.system.report.applied.find((a) => a.id === 'm1');
  assert.equal(outcome.ok, true);
  assert.equal(outcome.colliders, 1);
});

test('a name nothing answers to is reported unresolved, and the rest still applies', async () => {
  const ghost = { kind: 'move', id: 'gone', target: { name: 'no.such.thing' }, position: { x: 1, y: 1, z: 1 } };
  const rig = setup(doc([ghost, moveCrate]));
  await enter(rig);

  assert.deepEqual(rig.world.crate.position.toArray(), [40, 3, -20]);
  assert.deepEqual(rig.system.report.unresolved, [{ id: 'gone', reason: 'name' }]);
});

test('hidden takes an object out of the world without touching world source', async () => {
  const rig = setup(doc([{ kind: 'move', id: 'h1', target: { name: 'barn.main' }, position: null, hidden: true }]));
  await enter(rig);
  assert.equal(rig.world.barn.visible, false);
});

test('a rotation is applied about Y and nothing else', async () => {
  const rig = setup(doc([{ ...moveCrate, rotationY: 1.25 }]));
  await enter(rig);
  assert.ok(Math.abs(rig.world.crate.rotation.y - 1.25) < 1e-6);
  assert.equal(rig.world.crate.rotation.x, 0);
  assert.equal(rig.world.crate.rotation.z, 0);
});

/* ------------------------------------------------------------------ */
/* Reverting                                                           */
/* ------------------------------------------------------------------ */

test('an entry dropped from the overlay puts its object back where the world built it', async () => {
  const rig = setup(doc([moveCrate]));
  const original = rig.world.crate.position.clone();
  await enter(rig);
  assert.notDeepEqual(rig.world.crate.position.toArray(), original.toArray());

  // The admin removed that entry and saved again.
  rig.doc.entries = [];
  rig.doc.version = 2;
  await enter(rig);
  assert.deepEqual(rig.world.crate.position.toArray(), original.toArray());
});

test('leaving a world restores what the overlay moved in it', async () => {
  const rig = setup(doc([moveCrate]));
  const original = rig.world.crate.position.clone();
  await enter(rig);

  const elsewhere = makeWorld('medieval');
  rig.bus.emit('world:changed', { id: elsewhere.id, world: elsewhere });
  await rig.system.applying;

  assert.deepEqual(rig.world.crate.position.toArray(), original.toArray());
});

/* ------------------------------------------------------------------ */
/* Placing                                                             */
/* ------------------------------------------------------------------ */

const placeAmmo = {
  kind: 'place',
  id: 'p1',
  item: {
    source_key: 'pack_bullets',
    name: 'Rifle Round Pack',
    config: { effect: 'grant_ammo', ammo_item: 'bullet', amount: 60 },
  },
  position: { x: 5, y: 1, z: 5 },
  quantity: 2,
};

test('a placement spawns a persistent pickup holding the item the catalogue grants', async () => {
  const rig = setup(doc([placeAmmo]));
  await enter(rig);

  assert.equal(rig.loot.spawned.length, 1);
  const p = rig.loot.spawned[0];
  assert.deepEqual(p.contents, [{ itemId: 'bullet', qty: 120 }]);
  assert.equal(p.opts.persistent, true);
  assert.equal(p.opts.snap, false);
  assert.equal(p.position.x, 5);
  assert.equal(p.position.z, 5);
});

test('a placement resolves a spell by its marketplace source key', async () => {
  const rig = setup(
    doc([
      {
        kind: 'place',
        id: 'p2',
        item: { source_key: 'spell_stasis_10s:station', name: 'Stasis Rune', config: {} },
        position: { x: 0, y: 0, z: 0 },
        quantity: 1,
      },
    ])
  );
  await enter(rig);
  assert.deepEqual(rig.loot.spawned[0].contents, [{ itemId: 'npc_pause_10s', qty: 1 }]);
});

test('a source key the game cannot turn into an item places NOTHING and says so', async () => {
  const rig = setup(
    doc([
      {
        kind: 'place',
        id: 'p3',
        item: { source_key: 'skin_something_unknown', name: 'Mystery', config: {} },
        position: { x: 0, y: 0, z: 0 },
        quantity: 1,
      },
    ])
  );
  await enter(rig);
  assert.equal(rig.loot.spawned.length, 0);
  assert.deepEqual(rig.system.report.unresolved, [{ id: 'p3', reason: 'item' }]);
});

test('re-applying an overlay does not stack duplicate pickups', async () => {
  const rig = setup(doc([placeAmmo]));
  await enter(rig);
  await enter(rig);
  assert.equal(rig.loot.despawned.length, 1);
  assert.equal(rig.loot.spawned.filter((p) => p.active).length, 1);
});

test('credits are never placeable, however the catalogue is authored', async () => {
  const rig = setup(
    doc([
      {
        kind: 'place',
        id: 'p4',
        item: { source_key: 'credits', name: 'Credits', config: { effect: 'grant_item', item_id: 'credits', amount: 5000 } },
        position: { x: 0, y: 0, z: 0 },
        quantity: 99,
      },
    ])
  );
  await enter(rig);
  assert.equal(rig.loot.spawned.length, 0);
  assert.deepEqual(rig.system.report.unresolved, [{ id: 'p4', reason: 'item' }]);
});

/* ------------------------------------------------------------------ */
/* Reporting back                                                      */
/* ------------------------------------------------------------------ */

test('an admin client reports the world catalogue back so the editor can offer real names', async () => {
  const rig = setup(doc([moveCrate], { admin: true }));
  await enter(rig);

  const post = rig.fetchImpl.calls.find((c) => c.method === 'POST');
  assert.ok(post, 'expected a report POST');
  assert.match(post.url, /\/api\/admin\/map\/report/);
  assert.equal(post.body.world, 'station');
  assert.equal(post.body.appliedVersion, 1);
  const names = post.body.objects.map((o) => o.name);
  assert.ok(names.includes('crate.alpha'));
  assert.ok(names.includes('barn.main'));
});

test('a normal player never posts to an admin route', async () => {
  const rig = setup(doc([moveCrate], { admin: false }));
  await enter(rig);
  assert.equal(rig.fetchImpl.calls.filter((c) => c.method === 'POST').length, 0);
});

test('the applied report is published on the bus for the HUD and the dev harness', async () => {
  const rig = setup(doc([moveCrate]));
  await enter(rig);
  const event = rig.bus.emitted.find((e) => e.name === 'map-overlay:applied');
  assert.ok(event, 'expected map-overlay:applied');
  assert.equal(event.payload.world, 'station');
  assert.equal(event.payload.version, 1);
  assert.equal(event.payload.applied.length, 1);
});

/* ------------------------------------------------------------------ */
/* The two ends of the contract agree                                  */
/* ------------------------------------------------------------------ */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');

/** CRLF-normalised. This has been paid for three times in this repo. */
function read(rel) {
  return readFileSync(path.join(ROOT, rel), 'utf8').replace(/\r\n/g, '\n');
}

test('the world list the editor offers is the world list the game has', () => {
  const schema = read('site/lib/mapOverlaySchema.ts');
  const block = schema.match(/export const OVERLAY_WORLDS = \[([\s\S]*?)\] as const;/);
  assert.ok(block, 'OVERLAY_WORLDS not found in site/lib/mapOverlaySchema.ts');
  const offered = new Set([...block[1].matchAll(/'([a-z0-9_-]+)'/g)].map((m) => m[1]));

  const gameIds = new Set();
  for (const file of [
    'src/worlds/StationWorld.js',
    'src/worlds/MedievalWorld.js',
    'src/worlds/SportsWorld.js',
    'src/worlds/CitadelWorld.js',
    'src/worlds/RaceWorld.js',
    'src/worlds/DockWorld.js',
    'src/worlds/MazeWorld.js',
    'src/worlds/SpaceWorld.js',
  ]) {
    const m = read(file).match(/^\s*static id = '([a-z0-9_-]+)';/m);
    assert.ok(m, `no static id in ${file}`);
    gameIds.add(m[1]);
  }
  for (const planet of [
    'Carnelian', 'Cathedra', 'Lathe', 'Sallow', 'Shoal',
    'Sirocco', 'Tessera', 'Verdigris', 'Vitrine', 'Volcanic',
  ]) {
    const m = read(`src/worlds/planets/${planet}.js`).match(/^\s{2}id: '([a-z0-9_-]+)',$/m);
    assert.ok(m, `no descriptor id in ${planet}.js`);
    gameIds.add(m[1]);
  }

  const missing = [...gameIds].filter((id) => !offered.has(id));
  const extra = [...offered].filter((id) => !gameIds.has(id));
  assert.deepEqual(missing, [], `worlds the game has but the editor cannot edit: ${missing}`);
  assert.deepEqual(extra, [], `worlds the editor offers but the game does not have: ${extra}`);
});

test('the entry kinds the editor writes are the entry kinds the game reads', () => {
  const schema = read('site/lib/mapOverlaySchema.ts');
  const system = read('src/systems/MapOverlay.js');
  for (const kind of ["'move'", "'place'"]) {
    assert.ok(schema.includes(`kind: ${kind}`), `schema is missing ${kind}`);
    assert.ok(system.includes(kind), `MapOverlay.js never mentions ${kind}`);
  }
  // Field names the applier indexes into. A rename on either side is a silent
  // no-op at runtime — the overlay applies zero entries and says nothing.
  for (const field of ['source_key', 'rotationY', 'hidden', 'quantity', 'position']) {
    assert.ok(schema.includes(field), `schema is missing ${field}`);
    assert.ok(system.includes(field), `MapOverlay.js is missing ${field}`);
  }
});

test('the layer a moved collider keeps is the layer it had', async () => {
  const rig = setup(doc([moveCrate]));
  const own = rig.physics.addBoxFromObject(rig.world.crate, {
    layer: COLLISION_LAYER.WORLD,
    userData: { tag: 'crate' },
  });
  await enter(rig);
  assert.equal(own.layer, COLLISION_LAYER.WORLD);
  assert.deepEqual(own.userData, { tag: 'crate' });
});
