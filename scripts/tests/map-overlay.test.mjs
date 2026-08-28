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
 * A fetch stand-in. `overlay` is what the GET answers - a document, or a
 * function of the world id asked for, which may hold its answer; every POST
 * is recorded.
 */
function makeFetch(overlay, { fail = false } = {}) {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url, method: init?.method ?? 'GET', body: init?.body ? JSON.parse(init.body) : null });
    if (fail) throw new Error('offline');
    if ((init?.method ?? 'GET') === 'GET') {
      const worldId = new URL(url, 'http://game').searchParams.get('world');
      const answer = typeof overlay === 'function' ? await overlay(worldId) : overlay;
      return { ok: true, status: 200, json: async () => answer };
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
  // `overlay` may be a function of the world id, so a test can serve a NEW
  // document to stand for "the admin saved a new version": an admitted
  // document is frozen, so editing one in place is a TypeError, not a save.
  const fetchImpl = makeFetch(overlay, { fail });
  const system = new MapOverlay({ bus, physics, loot, fetch: fetchImpl });
  return { bus, physics, loot, fetchImpl, system, world, doc: overlay };
}

async function enter({ bus, system, world }) {
  bus.emit('world:changed', { id: world.id, world });
  await system.applying;
}

/**
 * Give a world the colliders a built one has - one under its crate, one under
 * its barn - kept on `world.colliders` the way `World.track` keeps them, so
 * `activate` below can re-add the same objects the way WorldManager does.
 */
function solid(physics, world) {
  world.colliders = [physics.addBoxFromObject(world.crate), physics.addBoxFromObject(world.barn)];
  return world;
}

/**
 * What `WorldManager._activate` does before it emits `world:changed`: the
 * collision world is rebuilt from scratch so that only the entered world is
 * solid, and the entered world's own colliders are re-added. `enter` skips
 * this, which is exactly why the tests below could not be written with it.
 */
async function activate({ bus, physics, system }, world, { settle = true } = {}) {
  physics.clear();
  for (const c of world.colliders) physics.add(c);
  bus.emit('world:changed', { id: world.id, world });
  if (settle) await system.applying;   // `settle: false` when the read is being held
}

/** Where each registered collider sits in `world.colliders` (-1: not this world's). */
const registeredAs = (physics, world) => physics.colliders.map((c) => world.colliders.indexOf(c)).sort();

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

/**
 * Both sides of the "newer than" gate are measured, on the SAME broad pattern:
 * a schema-3 document warns exactly once over two enters, and a schema-1
 * document (older than this build, the shape every other rig here serves)
 * never warns. A filter on the exact "schema 3" text would pass with the
 * comparison mutated to `!==`, which warns on the older side too.
 */
test('a document newer than this build reads is said once, and still applied; an older one is never said', async () => {
  const SCHEMA_WARN = /\[map-overlay\] document schema/;
  const capture = async (rig) => {
    const warned = [];
    const warn = console.warn;
    console.warn = (...a) => warned.push(a.join(' '));
    try {
      await enter(rig);
      await enter(rig);
    } finally {
      console.warn = warn;
    }
    return warned.filter((w) => SCHEMA_WARN.test(w));
  };

  const newer = setup({ ...doc([moveCrate]), schema: 3 });
  const said = await capture(newer);
  assert.deepEqual(newer.world.crate.position.toArray(), [40, 3, -20]);
  assert.equal(said.length, 1, `${said}`);
  assert.match(said[0], /document schema 3 is newer than 2/);

  const older = setup(doc([moveCrate]));
  assert.equal(older.doc.schema, 1, 'precondition: the rig serves schema 1');
  const unsaid = await capture(older);
  assert.deepEqual(older.world.crate.position.toArray(), [40, 3, -20]);
  assert.equal(unsaid.length, 0, `an older document warned: ${unsaid}`);
});

/* ------------------------------------------------------------------ */
/* The document a build consults                                       */
/* ------------------------------------------------------------------ */

test('lookup fetches a world once and answers from the cache after that; an entry refreshes the cache', async () => {
  // A function overlay, so the second GET serves a NEW document object: `setup(doc(...))` hands one object out
  // by reference and `makeFetch` returns that same object, so mutating its `version` would pass the refresh
  // assertion below whether or not `_read` ever wrote the cache.
  let current = doc([moveCrate]);
  const rig = setup(() => current);
  const a = await rig.system.lookup('station');
  const b = await rig.system.lookup('station');
  assert.equal(a.version, 1);
  assert.equal(b, a);
  assert.equal(rig.fetchImpl.calls.length, 1);
  // The admin saved; the player enters. The entry's no-store read is what a volatile rebuild must see next.
  current = doc([moveCrate], { version: 2 });
  await enter(rig);
  assert.equal(rig.fetchImpl.calls.length, 2, 'an entry still reads afresh, once');
  assert.equal((await rig.system.lookup('station')).version, 2, 'a rebuild after a save would build against the stale document');
  assert.equal(rig.fetchImpl.calls.length, 2);
});

test('two lookups in flight share one GET, and prefetch is a lookup nobody awaits', async () => {
  const rig = setup(doc([]));
  rig.system.prefetch('station');
  const [a, b] = await Promise.all([rig.system.lookup('station'), rig.system.lookup('station')]);
  assert.equal(a, b);
  assert.equal(rig.fetchImpl.calls.length, 1);
});

test('a failed lookup answers null and caches nothing, so the next one asks again', async () => {
  const rig = setup(doc([]), { fail: true });
  const warn = console.warn;
  console.warn = () => {};
  try {
    assert.equal(await rig.system.lookup('station'), null);
    assert.equal(await rig.system.lookup('station'), null);
  } finally {
    console.warn = warn;
  }
  assert.equal(rig.fetchImpl.calls.length, 2);
});

test('a late read answering an OLDER version than the cache holds does not overwrite it: the cache is version-monotonic', async () => {
  // 9b16768's race, seen from the cache: the station's FIRST GET (v1) is held; the player portals away and back;
  // the return visit's GET (v2) answers at once and is cached; then v1 lands. The applier drops it by visit number,
  // but `_read` writes the cache BEFORE that guard runs - so the write itself must refuse to go backwards, or a
  // later build of this world (the maze's every entry) would consult v1 and report builtVersion 1 against an
  // applied v2, and every {id} entry would read pending-rebuild after a reload that changed nothing.
  let release;
  const held = new Promise((r) => { release = r; });
  let stationGets = 0;
  const v1 = doc([moveCrate], { version: 1 });
  const v2 = doc([{ ...moveCrate, position: { x: -50, y: 1, z: 8 } }], { version: 2 });
  const rig = setup(async (worldId) => {
    if (worldId !== 'station') return doc([], { world: worldId });
    if (++stationGets === 1) { await held; return v1; }
    return v2;
  });
  const station = solid(rig.physics, rig.world);
  const medieval = solid(rig.physics, makeWorld('medieval'));

  await activate(rig, station, { settle: false }); // GET #1 is held in flight
  await activate(rig, medieval);
  await activate(rig, station);
  assert.equal((await rig.system.lookup('station')).version, 2, 'precondition: the return visit cached v2');

  release();
  await new Promise((r) => setTimeout(r, 0)); // GET #1's continuation runs to its end

  assert.equal((await rig.system.lookup('station')).version, 2, 'the stale v1 overwrote v2 in the cache');
  assert.equal(rig.fetchImpl.calls.filter((c) => c.method === 'GET' && /world=station/.test(c.url)).length, 2, 'lookup did not answer from the cache');
});

/**
 * A fetch that never answers and settles only by being aborted - rejecting
 * as the real one does, with an AbortError - recording every signal it was
 * handed in `signals`.
 */
function heldFetch(signals) {
  return (_url, init) => new Promise((_resolve, reject) => {
    signals.push(init.signal);
    init.signal.addEventListener('abort', () => reject(new DOMException('This operation was aborted', 'AbortError')));
  });
}

/** Run `fn` with console.warn captured; answers what was said. */
async function saying(fn) {
  const warned = [];
  const warn = console.warn;
  console.warn = (...a) => warned.push(a.join(' '));
  try {
    await fn();
  } finally {
    console.warn = warn;
  }
  return warned;
}

/**
 * The manager races a lookup against a fuse and walks away when the fuse
 * wins; the fetch it walked away from must not stay open on a dead
 * connection until the tab closes, one per world. Measured on the signal the
 * fetch was handed, with a fetch that only ever settles by being aborted.
 * The abort is this system's own decision, so it is not said: the manager
 * has already said the outage once, and a second line ten seconds later
 * saying "This operation was aborted" would be the same outage twice.
 */
test('a lookup whose fetch never answers is abandoned at its ceiling: the signal aborts, nothing is cached or said, the in-flight entry clears, and the next lookup asks again', async () => {
  const signals = [];
  const system = new MapOverlay({ bus: makeBus(), physics: new Physics(makeBus()), fetch: heldFetch(signals) });
  system.lookupAbortMs = 40; // the same ceiling, shortened
  let took = 0;
  const warned = await saying(async () => {
    const t = performance.now();
    assert.equal(await system.lookup('station'), null);
    took = performance.now() - t;
    assert.equal(await system.lookup('station'), null, 'the second lookup did not ask again');
  });
  assert.deepEqual(warned, [], `the abort was said: ${warned}`);
  assert.ok(took >= 30 && took < 1000, `abandoned after ${took} ms`);
  assert.equal(signals.length, 2, 'the in-flight entry did not clear, so the second lookup joined a dead fetch');
  assert.equal(signals[0].aborted, true, 'the race was lost but the fetch was never told');
  assert.equal(system._inflight.size, 0);
  assert.equal(system._cache.size, 0, 'a timed-out lookup cached something');
  system.dispose();

  // The ceiling outlasts the manager's longest fuse: the manager decides how long a BUILD waits, and an abort
  // inside its gate fuse would turn a slow answer the gate was still willing to take into a failure.
  const abortMs = Number(code('src/systems/MapOverlay.js').match(/^const LOOKUP_ABORT_MS = (\d+);/m)?.[1]);
  const gateMs = Number(code('src/worlds/WorldManager.js').match(/^const OVERLAY_GATE_MS = (\d+);/m)?.[1]);
  assert.ok(abortMs > gateMs, `LOOKUP_ABORT_MS ${abortMs} does not exceed OVERLAY_GATE_MS ${gateMs}`);
});

test('a 200 whose body is not a document is admitted nowhere: lookup answers null and caches nothing, so no build ever consults nonsense', async () => {
  // `_admit` is the one judge for both paths (the malformed-document case above is the entry's side of this).
  // The route's shape is `{ world, entries }`; the wrong world is a stale reply that landed after a portal.
  for (const body of [{ error: 'nonsense' }, { world: 'station' }, { world: 'station', entries: 'no' }, { world: 'elsewhere', entries: [] }, ['station'], 'station']) {
    const rig = setup(body);
    assert.equal(await rig.system.lookup('station'), null, `admitted: ${JSON.stringify(body)}`);
    assert.equal(rig.system._cache.size, 0, `cached: ${JSON.stringify(body)}`);
    assert.equal(rig.fetchImpl.calls.length, 1);
  }
  const rig = setup(doc([moveCrate]));
  const admitted = await rig.system.lookup('station');
  assert.equal(admitted?.version, 1, "precondition: a document of the route's shape is admitted");
  // The build, the applier and every later lookup read ONE object; nobody may edit it under the others.
  assert.ok(Object.isFrozen(admitted) && Object.isFrozen(admitted.entries), 'an admitted document is not frozen');
});

/**
 * An entry's read carries the VISIT's abort. During an outage every portal
 * crossing would otherwise leave a hung GET open until the tab closes - and
 * a browser holds six connections per host, so the sixth crossing would
 * starve every other fetch the game makes.
 */
test('leaving a world aborts the read its entry started, and the abort is not said: an outage does not leave one hung GET per crossing', async () => {
  const signals = [];
  const bus = makeBus();
  const system = new MapOverlay({ bus, physics: new Physics(bus), fetch: heldFetch(signals) });
  const warned = await saying(async () => {
    bus.emit('world:changed', { id: 'station', world: makeWorld('station') });
    const first = system.applying;
    assert.equal(signals.length, 1, 'the entry did not read');
    assert.equal(signals[0].aborted, false, 'the read was aborted before the player left');
    bus.emit('world:changed', { id: 'medieval', world: makeWorld('medieval') });
    assert.equal(signals[0].aborted, true, 'the crossing left the station read open');
    assert.equal(signals[1].aborted, false, 'the crossing aborted its own read');
    await first; // the abandoned visit ends: nothing applied, nothing published
    assert.equal(system.report.world, null, 'an aborted read published a report');
    system.dispose();
    assert.equal(signals[1].aborted, true, 'dispose left the entry read open');
    await system.applying;
  });
  assert.deepEqual(warned, [], `the abort was said: ${warned}`);
});

test('dispose aborts a lookup still in flight, which answers null without a word', async () => {
  const signals = [];
  const system = new MapOverlay({ bus: makeBus(), physics: new Physics(makeBus()), fetch: heldFetch(signals) });
  const warned = await saying(async () => {
    const pending = system.lookup('station');
    assert.equal(signals[0].aborted, false);
    system.dispose();
    assert.equal(signals[0].aborted, true, 'dispose left the lookup open');
    assert.equal(await pending, null);
  });
  assert.deepEqual(warned, [], `the abort was said: ${warned}`);
});

test('a newer document reached through lookup and then through an entry is said once in total: both paths judge a document in one place', async () => {
  const SCHEMA_WARN = /\[map-overlay\] document schema/;
  const rig = setup({ ...doc([moveCrate]), schema: 3 });
  const warned = [];
  const warn = console.warn;
  console.warn = (...a) => warned.push(a.join(' '));
  try {
    assert.equal((await rig.system.lookup('station')).schema, 3);
    await enter(rig);
  } finally {
    console.warn = warn;
  }
  assert.deepEqual(rig.world.crate.position.toArray(), [40, 3, -20], 'the newer document was not applied');
  const said = warned.filter((w) => SCHEMA_WARN.test(w));
  assert.equal(said.length, 1, `${warned}`);
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
  let current = doc([moveCrate]);
  const rig = setup(() => current);
  const original = rig.world.crate.position.clone();
  await enter(rig);
  assert.notDeepEqual(rig.world.crate.position.toArray(), original.toArray());

  // The admin removed that entry and saved again.
  current = doc([], { version: 2 });
  await enter(rig);
  assert.deepEqual(rig.world.crate.position.toArray(), original.toArray());
});

test('a move undone by leaving the world does not plant the collider in the world entered', async () => {
  const rig = setup(doc([moveCrate]));
  const station = solid(rig.physics, rig.world);
  const medieval = solid(rig.physics, makeWorld('medieval'));
  const [crateCollider] = station.colliders;
  const authored = crateCollider.center.clone();

  await activate(rig, station);
  assert.deepEqual(crateCollider.center.toArray(), [40, 3, -20], 'precondition: the move took the collider');

  // The player portals on. WorldManager has already rebuilt physics for the
  // medieval world by the time this system hears about it.
  await activate(rig, medieval);

  // The station's collider is put back where the station built it, for the next visit...
  assert.deepEqual(crateCollider.center.toArray(), authored.toArray());
  // ...but the medieval world's physics holds the medieval world's colliders, exactly, and nothing of the station's.
  assert.deepEqual(registeredAs(rig.physics, medieval), [0, 1], 'the physics of the world entered holds something that is not its own');
  assert.equal(rig.physics.has(crateCollider), false, 'the station crate is solid in the medieval world');
});

test('re-entering a world after its entry was dropped leaves each collider registered once, where it was built', async () => {
  let current = doc([moveCrate]);
  const rig = setup(() => current);
  const station = solid(rig.physics, rig.world);
  const medieval = solid(rig.physics, makeWorld('medieval'));
  const [crateCollider] = station.colliders;
  const authored = crateCollider.center.clone();

  await activate(rig, station);
  await activate(rig, medieval);

  // The admin dropped the move; the player walks back.
  current = doc([], { version: 2 });
  await activate(rig, station);

  assert.deepEqual(registeredAs(rig.physics, station), [0, 1], 'a collider is registered more than once, or is foreign');
  assert.deepEqual(crateCollider.center.toArray(), authored.toArray());
  assert.deepEqual(rig.world.crate.position.toArray(), authored.toArray());
});

test('a same-world re-entry after the entry was dropped leaves each collider registered once, where it was built', async () => {
  let current = doc([moveCrate]);
  const rig = setup(() => current);
  const station = solid(rig.physics, rig.world);
  const [crateCollider] = station.colliders;
  const authored = crateCollider.center.clone();

  await activate(rig, station);
  assert.deepEqual(crateCollider.center.toArray(), [40, 3, -20], 'precondition: the move took the collider');

  current = doc([], { version: 2 });
  await activate(rig, station);

  assert.deepEqual(registeredAs(rig.physics, station), [0, 1], 'a collider is registered more than once, or is foreign');
  assert.deepEqual(crateCollider.center.toArray(), authored.toArray());
});

test('a document that arrives after the player has portalled on is dropped, not applied to the world they left', async () => {
  // The station's GET is held until released; the medieval one answers at once.
  let release;
  const held = new Promise((r) => { release = r; });
  const overlays = { station: doc([moveCrate]), medieval: doc([moveCrate], { world: 'medieval' }) };
  const rig = setup(async (worldId) => { if (worldId === 'station') await held; return overlays[worldId]; });
  const station = rig.world;
  const medieval = makeWorld('medieval');
  const authored = station.crate.position.clone();

  rig.bus.emit('world:changed', { id: station.id, world: station });
  rig.bus.emit('world:changed', { id: medieval.id, world: medieval });
  await rig.system.applying;
  assert.deepEqual(medieval.crate.position.toArray(), [40, 3, -20], "the medieval world's own document applied");

  release();
  await new Promise((r) => setTimeout(r, 0)); // the station continuation runs to its end

  assert.deepEqual(station.crate.position.toArray(), authored.toArray(), 'the stale document moved the crate in the world the player left');
  assert.equal(rig.system.report.world, 'medieval', 'the stale document republished over the world the player is in');
});

test('a document from a FIRST visit that lands during a return visit is dropped: the visit, not the world object, is what it belongs to', async () => {
  // WorldManager.build hands out the same cached world object on every visit,
  // so "is this still the world I was asked about" cannot tell a return visit
  // from the visit that asked. The station's FIRST GET is held; the player
  // portals to the medieval world and straight back, the second GET answers
  // at once, and then the first lands.
  let release;
  const held = new Promise((r) => { release = r; });
  let stationGets = 0;
  const overlays = { station: doc([moveCrate, placeAmmo]), medieval: doc([], { world: 'medieval' }) };
  const rig = setup(async (worldId) => {
    if (worldId === 'station' && ++stationGets === 1) await held;
    return overlays[worldId];
  });
  const station = solid(rig.physics, rig.world);
  const medieval = solid(rig.physics, makeWorld('medieval'));

  await activate(rig, station, { settle: false });   // GET #1 is held in flight
  await activate(rig, medieval);
  await activate(rig, station);   // GET #2 answers at once: the move and the pickup are in
  const applied = () => rig.bus.emitted.filter((e) => e.name === 'map-overlay:applied' && e.payload.world === 'station').length;
  assert.equal(applied(), 1, 'precondition: the return visit applied once');

  release();
  await new Promise((r) => setTimeout(r, 0)); // GET #1's continuation runs to its end

  assert.equal(rig.loot.spawned.filter((p) => p.active).length, 1, 'the stale document placed the pickup a second time');
  assert.equal(applied(), 1, 'the stale document applied and published on top of the return visit');
  assert.deepEqual(registeredAs(rig.physics, station), [0, 1]);
});

test('a slow first read that answers an OLDER version than the return visit applied does not win', async () => {
  // The admin saved v2 between the two reads: v1 (crate to 40,3,-20) answers
  // late, v2 (crate to -50,1,8) answered the return visit at once.
  let release;
  const held = new Promise((r) => { release = r; });
  let stationGets = 0;
  const v1 = doc([moveCrate], { version: 1 });
  const v2 = doc([{ ...moveCrate, position: { x: -50, y: 1, z: 8 } }], { version: 2 });
  const rig = setup(async (worldId) => {
    if (worldId !== 'station') return doc([], { world: worldId });
    if (++stationGets === 1) { await held; return v1; }
    return v2;
  });
  const station = solid(rig.physics, rig.world);
  const medieval = solid(rig.physics, makeWorld('medieval'));
  const [crateCollider] = station.colliders;

  await activate(rig, station, { settle: false });   // GET #1 is held in flight
  await activate(rig, medieval);
  await activate(rig, station);
  assert.equal(rig.system.report.version, 2, 'precondition: the return visit applied v2');

  release();
  await new Promise((r) => setTimeout(r, 0));

  assert.equal(rig.system.report.version, 2, 'the stale v1 republished over v2');
  assert.deepEqual(station.crate.position.toArray(), [-50, 1, 8]);
  assert.deepEqual(crateCollider.center.toArray().map((n) => Math.round(n * 1000) / 1000), [-50, 1, 8]);
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
/* Removing                                                            */
/* ------------------------------------------------------------------ */

/**
 * A remove hides the object AND drops the colliders it CONTAINS - each
 * collider's own world AABB inside the object's box grown by 0.10 m, never
 * centre-in-box, which would take the fence post beside the house. Terrain
 * is excluded by type; a collider another system tagged with `userData` is
 * excluded by that tag. Collider `userData` in this tree (verified 2026-08-28):
 * src/worlds/PlanetWorld.js :1165 {planetFloor}, :1687/:1694
 * {planetLiquidBarrier, barrierCap}, :1800 {planetEdgeWall};
 * src/systems/Portals.js :1140/:1159/:1174 {portal}; src/ships/Piloting.js
 * :2961 {kind:'ship', shipId}. `World.addSolid` (World.js:206) and
 * SportsWorld's `_solid` (SportsWorld.js:1860) forward `opts.userData`, but
 * no call site supplies one - so today the tag means exactly "a volume
 * another system owns and rebuilds before the overlay applies", and a future
 * `addSolid(mesh, { userData })` or `_solid(mesh, { userData })` on a prop
 * would silently exempt that prop. `solid` and `layer` are NOT consulted: a
 * trigger inside a removed prop belongs to the prop, as `_moveColliders`
 * moves it.
 */

const removeBarn = { kind: 'remove', id: 'r1', target: { name: 'barn.main' } };

test('a remove hides the object and drops the collider inside it; the broadphase no longer answers with it', async () => {
  const rig = setup(doc([removeBarn], { admin: true }));
  const own = rig.physics.addBoxFromObject(rig.world.barn);
  const other = rig.physics.addBox(-100, 0, -100, 1, 1, 1);
  await enter(rig);

  assert.equal(rig.world.barn.visible, false);
  assert.equal(rig.physics.has(own), false, 'the barn collider is still registered');
  assert.equal(rig.physics.has(other), true);
  assert.ok(!rig.physics.query(rig.world.barn.position, 6).includes(own), 'the broadphase still lists the dropped collider');
  assert.equal(rig.physics.groundHeight(-30, 0, 12, 20), null, 'an invisible wall stands where the barn was');
  assert.deepEqual(rig.system.report.applied, [{ id: 'r1', ok: true, colliders: 1 }]);
});

test('a remove never drops the terrain heightfield, even one whose footprint lies inside the box', async () => {
  const rig = setup(doc([removeBarn], { admin: true }));
  // A 1 m field entirely inside the barn's 4 m box - a genuine candidate, so
  // the TYPE exclusion is what this test measures.
  const field = rig.physics.addHeightfield({ heights: new Float32Array(4).fill(0), nx: 2, nz: 2, originX: -30.5, originZ: -0.5, stepX: 1 });
  const box = new THREE.Box3().setFromObject(rig.world.barn).expandByScalar(0.1);
  assert.ok(box.containsBox(rig.physics.colliderAabb(field)), 'the field must be a candidate, or this test proves nothing');
  await enter(rig);
  assert.equal(rig.physics.heightfields.length, 1);
  assert.equal(rig.physics.has(field), true);
  assert.equal(rig.system.report.applied[0].colliders, 0);
});

test('the tolerance is 0.10 m per axis: an authored +0.08 overhang is dropped, +0.12 is not and reads colliders: 0', async () => {
  for (const [pad, dropped] of [[0.08, 1], [0.12, 0]]) {
    const rig = setup(doc([removeBarn], { admin: true }));
    const c = rig.physics.addBox(-30, 0, 0, 2 + pad, 2 + pad, 2 + pad);
    await enter(rig);
    assert.equal(rig.physics.has(c), dropped === 0, `pad ${pad}`);
    assert.equal(rig.system.report.applied[0].colliders, dropped, `pad ${pad}`);
    assert.equal(rig.world.barn.visible, false, 'hidden either way');
  }
});

test('a Group target drops the colliders of every child inside its union box', async () => {
  const rig = setup(doc([{ kind: 'remove', id: 'r2', target: { name: 'shed' } }], { admin: true }));
  const shed = new THREE.Group();
  shed.name = 'shed';
  const wall = new THREE.Mesh(new THREE.BoxGeometry(1, 2, 4));
  const roof = new THREE.Mesh(new THREE.BoxGeometry(3, 0.5, 4));
  roof.position.y = 2;
  shed.add(wall, roof);
  shed.position.set(60, 0, 60);
  rig.world.group.add(shed);
  rig.world.group.updateMatrixWorld(true);
  const a = rig.physics.addBoxFromObject(wall);
  const b = rig.physics.addBoxFromObject(roof);
  await enter(rig);
  assert.equal(rig.physics.has(a), false);
  assert.equal(rig.physics.has(b), false);
  assert.equal(rig.system.report.applied[0].colliders, 2);
});

test('a mesh chunk straddling the box survives; one fully inside is dropped', async () => {
  const rig = setup(doc([removeBarn], { admin: true }));
  const inside = rig.physics.addTriangleSoup(new Float32Array([-31, 0, -1, -29, 0, -1, -30, 1, 1]));
  const straddling = rig.physics.addTriangleSoup(new Float32Array([-31, 0, -1, -20, 0, -1, -30, 1, 1]));
  await enter(rig);
  assert.equal(rig.physics.has(inside), false);
  assert.equal(rig.physics.has(straddling), true);
  assert.equal(rig.system.report.applied[0].colliders, 1);
});

test('a userData-tagged collider inside the box is left alone; an untagged non-solid one goes with the object', async () => {
  const rig = setup(doc([removeBarn], { admin: true }));
  const plinth = rig.physics.addBox(-30, 0, 0, 0.5, 0.5, 0.5, { userData: { portal: 'medieval' } });
  const trigger = rig.physics.addBox(-30, 1, 0, 0.5, 0.5, 0.5, { solid: false });
  await enter(rig);
  assert.equal(rig.physics.has(plinth), true, 'a portal plinth was dropped with the barn');
  assert.equal(rig.physics.has(trigger), false, 'a trigger inside the barn stayed behind');
  assert.equal(rig.system.report.applied[0].colliders, 1);
});

test('a remove that would drop more than 200 colliders is refused with reason span, and hides nothing', async () => {
  const rig = setup(doc([removeBarn], { admin: true }));
  for (let i = 0; i < 201; i++) {
    rig.physics.addBox(-31.5 + (i % 20) * 0.15, -1 + Math.floor(i / 20) * 0.2, 0, 0.05, 0.05, 0.05);
  }
  const before = rig.physics.colliders.length;
  await enter(rig);
  assert.equal(rig.world.barn.visible, true);
  assert.equal(rig.physics.colliders.length, before);
  assert.deepEqual(rig.system.report.unresolved, [{ id: 'r1', reason: 'span' }]);
  assert.deepEqual(rig.system.report.applied, []);
});

test('exactly 200 colliders inside the box is within the cap: all dropped, nothing unresolved', async () => {
  const rig = setup(doc([removeBarn], { admin: true }));
  for (let i = 0; i < 200; i++) {
    rig.physics.addBox(-31.5 + (i % 20) * 0.15, -1 + Math.floor(i / 20) * 0.2, 0, 0.05, 0.05, 0.05);
  }
  await enter(rig);
  assert.equal(rig.world.barn.visible, false);
  assert.equal(rig.physics.colliders.length, 0);
  assert.deepEqual(rig.system.report.unresolved, []);
  assert.equal(rig.system.report.applied[0].colliders, 200);
});

test('a v1 hidden move is applied as a remove for one release: hidden, colliders dropped, its position ignored', async () => {
  const rig = setup(doc([{ kind: 'move', id: 'h1', target: { name: 'barn.main' }, position: { x: 40, y: 3, z: -20 }, hidden: true }], { admin: true }));
  const own = rig.physics.addBoxFromObject(rig.world.barn);
  const authored = rig.world.barn.position.clone();
  await enter(rig);
  assert.equal(rig.world.barn.visible, false);
  assert.deepEqual(rig.world.barn.position.toArray(), authored.toArray(), 'the position of a hidden move is discarded (decision A)');
  assert.equal(rig.physics.has(own), false);
  assert.equal(rig.physics.groundHeight(40, -20, 12, 20), null, 'the collider was moved instead of dropped');
  assert.equal(rig.system.report.applied[0].colliders, 1);
});

test('a v1 hidden move with no position (the hide-only shape) is a remove too: hidden, and its collider dropped', async () => {
  const rig = setup(doc([{ kind: 'move', id: 'h1', target: { name: 'barn.main' }, position: null, hidden: true }], { admin: true }));
  const own = rig.physics.addBoxFromObject(rig.world.barn);
  await enter(rig);
  assert.equal(rig.world.barn.visible, false);
  assert.equal(rig.physics.has(own), false, 'the collider of a hide-only move stayed registered');
  assert.deepEqual(rig.system.report.applied, [{ id: 'h1', ok: true, colliders: 1 }]);
});

/**
 * Owner decision F: the LAST action on a name in document order wins. The
 * applier runs entries in order, which alone is not enough - a remove drops
 * the colliders, and a move after it would find nothing to take along, so
 * "remove then move" would leave the object hidden AND moved with its
 * colliders gone. So every action a later one supersedes is skipped whole
 * and reported `superseded`, and only the winner touches the world.
 */
const moveBarn = { kind: 'move', id: 'm2', target: { name: 'barn.main' }, position: { x: 40, y: 3, z: -20 } };
const r3 = (n) => Math.round(n * 1000) / 1000;

test('remove then move of one name: the move wins, the remove is superseded, and the collider moves with the object', async () => {
  const rig = setup(doc([removeBarn, moveBarn], { admin: true }));
  const own = rig.physics.addBoxFromObject(rig.world.barn);
  await enter(rig);
  assert.equal(rig.world.barn.visible, true, 'the superseded remove still hid the barn');
  assert.deepEqual(rig.world.barn.position.toArray(), [40, 3, -20]);
  assert.deepEqual(own.center.toArray().map(r3), [40, 3, -20], 'the collider did not move with the barn');
  assert.equal(rig.physics.has(own), true, 'the superseded remove still dropped the collider');
  assert.deepEqual(rig.system.report.unresolved, [{ id: 'r1', reason: 'superseded' }]);
  assert.deepEqual(rig.system.report.applied, [{ id: 'm2', ok: true, colliders: 1 }]);
});

test('move then remove of one name: the remove wins, the move is superseded, and the collider is dropped where it was built', async () => {
  const rig = setup(doc([moveBarn, removeBarn], { admin: true }));
  const own = rig.physics.addBoxFromObject(rig.world.barn);
  const authored = rig.world.barn.position.clone();
  await enter(rig);
  assert.equal(rig.world.barn.visible, false);
  assert.deepEqual(rig.world.barn.position.toArray(), authored.toArray(), 'the superseded move still moved the barn');
  assert.equal(rig.physics.has(own), false);
  assert.deepEqual(rig.system.report.unresolved, [{ id: 'm2', reason: 'superseded' }]);
  assert.deepEqual(rig.system.report.applied, [{ id: 'r1', ok: true, colliders: 1 }]);
});

test('two moves of one name: only the last applies; the first is superseded rather than applied and overwritten', async () => {
  const first = { kind: 'move', id: 'first', target: { name: 'crate.alpha' }, position: { x: 1, y: 1, z: 1 } };
  const rig = setup(doc([first, moveCrate], { admin: true }));
  const own = rig.physics.addBoxFromObject(rig.world.crate);
  await enter(rig);
  assert.deepEqual(rig.world.crate.position.toArray(), [40, 3, -20]);
  assert.deepEqual(own.center.toArray().map(r3), [40, 3, -20]);
  assert.deepEqual(rig.system.report.applied, [{ id: 'm1', ok: true, colliders: 1 }], 'both moves applied');
  assert.deepEqual(rig.system.report.unresolved, [{ id: 'first', reason: 'superseded' }]);
});

test('a v1 hidden move then a move of one name: the move wins and the hidden one is superseded, not applied as a remove first', async () => {
  // The v1 shape is dispatched as a remove (decision A), so it must be keyed
  // into the last-wins pre-pass like one: were it exempt, it would hide the
  // barn and drop its collider BEFORE the move ran, and the move would then
  // find nothing to take along.
  const hiddenBarn = { kind: 'move', id: 'h1', target: { name: 'barn.main' }, position: { x: 40, y: 3, z: -20 }, hidden: true };
  const rig = setup(doc([hiddenBarn, moveBarn], { admin: true }));
  const own = rig.physics.addBoxFromObject(rig.world.barn);
  await enter(rig);
  assert.equal(rig.world.barn.visible, true, 'the superseded hidden move still hid the barn');
  assert.deepEqual(rig.world.barn.position.toArray(), [40, 3, -20]);
  assert.deepEqual(own.center.toArray().map(r3), [40, 3, -20], 'the collider did not move with the barn');
  assert.equal(rig.physics.has(own), true, 'the superseded hidden move still dropped the collider');
  assert.deepEqual(rig.system.report.unresolved, [{ id: 'h1', reason: 'superseded' }]);
  assert.deepEqual(rig.system.report.applied, [{ id: 'm2', ok: true, colliders: 1 }]);
});

test('re-entering after the remove was dropped from the document registers the collider once, where it was built', async () => {
  let current = doc([removeBarn]);
  const rig = setup(() => current);
  const station = solid(rig.physics, rig.world);
  const [, barnCollider] = station.colliders;
  await activate(rig, station);
  assert.equal(rig.physics.has(barnCollider), false, 'precondition: the remove dropped it');

  current = doc([], { version: 2 });
  await activate(rig, station);
  assert.equal(rig.world.barn.visible, true);
  assert.deepEqual(registeredAs(rig.physics, station), [0, 1], 'a collider is registered more than once, or is foreign');
});

// SHAPE GUARD on the undo: passes red and green alike, and goes red only if the undo ever `physics.add`s.
test('leaving for another world after a remove plants nothing of the removed object in the world entered', async () => {
  const rig = setup(doc([removeBarn]));
  const station = solid(rig.physics, rig.world);
  const medieval = solid(rig.physics, makeWorld('medieval'));
  const [, barnCollider] = station.colliders;
  await activate(rig, station);
  await activate(rig, medieval);
  assert.equal(rig.world.barn.visible, true, 'the mesh is put back for the next visit');
  assert.deepEqual(registeredAs(rig.physics, medieval), [0, 1], 'the physics of the world entered holds something that is not its own');
  assert.equal(rig.physics.has(barnCollider), false);
});

test('returning to a world whose document still holds the remove drops the collider again, and only it', async () => {
  const rig = setup(doc([removeBarn]));
  const station = solid(rig.physics, rig.world);
  const medieval = solid(rig.physics, makeWorld('medieval'));
  const [, barnCollider] = station.colliders;
  await activate(rig, station);
  await activate(rig, medieval);
  await activate(rig, station);
  assert.equal(rig.world.barn.visible, false, 'the return visit did not re-apply the remove');
  assert.equal(rig.physics.has(barnCollider), false, "_activate's re-add outlived the second drop");
  assert.deepEqual(registeredAs(rig.physics, station), [0], 'the station holds something other than its own crate');
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

/** Comments stripped, so a pin cannot be satisfied by prose about the thing. The two regexes map-overlay-layout.test.mjs uses. */
const code = (rel) => read(rel).replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/.*$/gm, '$1');

test('the entry kinds the editor writes are the kinds the game dispatches on, and both sides carry schema 2', () => {
  const schema = code('site/lib/mapOverlaySchema.ts');
  const system = code('src/systems/MapOverlay.js');
  for (const kind of ['move', 'remove', 'place']) {
    assert.match(schema, new RegExp(`kind: '${kind}'`), `schema never writes kind '${kind}'`);
    assert.match(system, new RegExp(`entry\\.kind === '${kind}'`), `MapOverlay.js never dispatches on kind '${kind}'`);
  }
  assert.match(schema, /^export const MAP_OVERLAY_SCHEMA = 2;/m, 'the site writes a schema number other than 2');
  assert.match(system, /^const OVERLAY_SCHEMA = 2;/m, 'the game reads a schema number other than the one the site writes');
  // Field names the applier indexes into, as CODE on both sides where a bare word could match anything
  // (`includes('id')` is true of every identifier with 'id' in it): a rename is a silent no-op at runtime.
  for (const [field, pattern, schemaPattern] of [
    ['position', /entry\.position\b/, /position: Vec3;/], ['rotationY', /entry\.rotationY\b/, /rotationY\?: number;/],
    ['quantity', /entry\.quantity\b/, /quantity: number;/], ['source_key', /source_key/, /source_key: string;/],
    ['name', /target\?\.name\b/, /\{ name: string \}/],
  ]) {
    assert.match(schema, schemaPattern, `schema no longer declares ${field} as code`);
    assert.match(system, pattern, `MapOverlay.js never reads ${field}`);
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
