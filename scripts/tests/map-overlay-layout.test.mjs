// scripts/tests/map-overlay-layout.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as THREE from 'three';

import { Physics } from '../../src/physics/Physics.js';
import { MapOverlay } from '../../src/systems/MapOverlay.js';
import { NO_SAMPLE } from '../../src/systems/GroundSampler.js';

/**
 * THE LAYOUT AN ADMIN'S OWN CLIENT REPORTS TO THE MAP EDITOR.
 *
 * THE CLAIM: entering a world as admin posts its bounds and floorplan shapes
 * at once, then samples the ground through the REAL Physics under a per-frame
 * budget and posts a second report whose layered grid has two surfaces under
 * a roof and one over open floor; leaving mid-sample sends nothing;
 * `?layout=sample` samples with no admin and never posts, and only beside
 * `dev=1`; a 200 in which the editor kept the prior layout is said once.
 *
 * Not a stub: the colliders are real `Physics.addBox` slabs and the cast is
 * `Physics.raycast`, so two-layers-under-the-roof is the real collider code's
 * peel (a ray starting inside a box misses it), not a fake's. The grid is
 * decoded with Buffer, never the game's encoder. Only bus, fetch and engine
 * are fakes, and each records what it was handed.
 */

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const read = async (p) => (await readFile(path.join(root, p), 'utf8')).replace(/\r\n/g, '\n');
const readCode = async (p) => (await read(p))
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/(^|[^:'"`])\/\/.*$/gm, '$1');

/* ---------------------------------------------------------------- rig -- */

function makeBus() {
  const handlers = new Map();
  const emitted = [];
  return {
    on(name, fn) {
      if (!handlers.has(name)) handlers.set(name, new Set());
      handlers.get(name).add(fn);
      return () => handlers.get(name).delete(fn);
    },
    emit(name, payload) { emitted.push({ name, payload }); for (const fn of handlers.get(name) ?? []) fn(payload); },
    emitted,
  };
}

/** A named crate, a world box of ±40 m, and two floorplan shapes. */
function makeWorld(id = 'station') {
  const group = new THREE.Group();
  group.name = `world:${id}`;
  const crate = new THREE.Mesh(new THREE.BoxGeometry(2, 2, 2));
  crate.name = 'crate.alpha';
  crate.position.set(10, 0, 10);
  group.add(crate);
  group.updateMatrixWorld(true);
  const bounds = new THREE.Box3(new THREE.Vector3(-40, -5, -40), new THREE.Vector3(40, 30, 40));
  const minimapShapes = [{ kind: 'rect', x: 0, z: 0, w: 10, d: 10, fill: 0x2f2a1d },
    { kind: 'path', points: [[-40, -40], [40, 40]], stroke: 0xffffff, width: 2 }];
  return { id, group, crate, bounds, minimapShapes };
}

/**
 * `overlay` is the GET's answer, or a function of the world id that returns
 * (or resolves) one. `refuseGround`: the site answers 413 to a layout report
 * over its cap - a refusal, never a throw.
 */
function makeFetch(overlay, { refuseGround = false, answer = { ok: true } } = {}) {
  const calls = [];
  const fn = async (url, init) => {
    const body = init?.body ? JSON.parse(init.body) : null;
    calls.push({ url, method: init?.method ?? 'GET', body });
    if ((init?.method ?? 'GET') === 'GET') {
      const worldId = new URL(url, 'http://game').searchParams.get('world');
      const answer = typeof overlay === 'function' ? await overlay(worldId) : overlay;
      return { ok: true, status: 200, json: async () => answer };
    }
    if (refuseGround && body?.ground) return { ok: false, status: 413, json: async () => ({ error: 'too large' }) };
    // `answer`: the site's 200 body for a POST (an Error: a body that does not parse).
    return { ok: true, status: 200, json: async () => { if (answer instanceof Error) throw answer; return answer; } };
  };
  fn.calls = calls;
  fn.posts = () => calls.filter((c) => c.method === 'POST');
  return fn;
}

function makeEngine() {
  const updaters = new Set();
  return { updaters, onFrameUpdate(fn) { updaters.add(fn); return () => updaters.delete(fn); },
    tick(dt = 1 / 60) { for (const fn of updaters) fn(dt, 0); } };
}

const doc = (entries, { version = 1, admin = false, world = 'station' } = {}) =>
  ({ world, schema: 1, version, entries, admin });

/**
 * A floor at y=0 across the world and a roof slab whose top is y=20 over
 * x ∈ [2, 42], so grid cell x=4 is under it and x=0 is not. `clockPerCast`
 * advances the injected clock per REAL raycast: a deterministic frame.
 */
function setup(overlay, { forceLayout = false, clockPerCast = 0, refuseGround = false, answer = { ok: true } } = {}) {
  const bus = makeBus();
  const physics = new Physics(bus);
  physics.addBox(0, -1, 0, 100, 1, 100);
  physics.addBox(22, 19.5, 0, 20, 0.5, 100);
  let clock = 0;
  let casts = 0;
  const raycast = physics.raycast.bind(physics);
  physics.raycast = (...a) => { casts++; clock += clockPerCast; return raycast(...a); };
  const loot = { spawn: () => null, despawn: () => true };
  const fetchImpl = makeFetch(overlay, { refuseGround, answer });
  const engine = makeEngine();
  const world = makeWorld();
  const system = new MapOverlay({ bus, physics, loot, engine, fetch: fetchImpl, forceLayout, now: () => clock });
  return { bus, physics, fetchImpl, engine, world, system, casts: () => casts };
}

async function enter({ bus, system, world }) {
  bus.emit('world:changed', { id: world.id, world });
  await system.applying;
}

/** Tick frames until the current world's sampling completes, then await its POST. */
async function finish(rig) {
  for (let n = 0; n < 100000 && !rig.system.layoutSampled; n++) rig.engine.tick();
  assert.equal(rig.system.layoutSampled, true, 'sampling did not complete within 100000 frames');
  return rig.system.sampling;
}

function decode(ground) {
  const buf = Buffer.from(ground.heightsCm, 'base64');
  const h = new Int16Array(buf.length / 2);
  for (let i = 0; i < h.length; i++) h[i] = buf.readInt16LE(i * 2);
  return h;
}
const at = (g, h, i, j, k) => h[((j * g.nx) + i) * g.layers + k];
const BOUNDS = { min: { x: -40, y: -5, z: -40 }, max: { x: 40, y: 30, z: 40 } };

/* ------------------------------------------------- the immediate report -- */

test('(a) the immediate admin report carries layoutSchema, bounds and shapes, and no ground', async () => {
  const rig = setup(doc([], { admin: true }));
  await enter(rig);
  const posts = rig.fetchImpl.posts();
  assert.equal(posts.length, 1, 'one POST before any frame has ticked');
  const body = posts[0].body;
  assert.equal(body.world, 'station');
  assert.equal(body.appliedVersion, 1);
  assert.equal(body.layoutSchema, 1);
  assert.deepEqual(body.bounds, BOUNDS);
  assert.deepEqual(body.shapes, rig.world.minimapShapes);
  assert.equal(body.ground, undefined);
  assert.ok(body.objects.some((o) => o.name === 'crate.alpha'));
});

test('a world with no bounds still reports, without a bounds field, and says once why nothing is sampled', async () => {
  const rig = setup(doc([], { admin: true }));
  delete rig.world.bounds;
  const warned = [];
  const warn = console.warn;
  console.warn = (...a) => warned.push(a.join(' '));
  try {
    await enter(rig);
    for (let n = 0; n < 20; n++) rig.engine.tick();
  } finally {
    console.warn = warn;
  }
  const body = rig.fetchImpl.posts()[0].body;
  assert.equal(body.layoutSchema, 1);
  assert.equal('bounds' in body, false);
  assert.deepEqual(body.shapes, rig.world.minimapShapes);
  assert.equal(warned.filter((w) => /\[map-overlay\] ground not sampled/.test(w)).length, 1, `one warning: ${warned}`);
  assert.equal(warned.length, 1, `nothing else was said: ${warned}`);
});

test('an empty Box3 (±Infinity) sends no bounds field and starts no sampling, even after a good sample', async () => {
  const rig = setup(doc([], { admin: true }));
  await enter(rig);
  assert.equal((await finish(rig)).cells, 441, 'a complete station sample first');
  const cast = rig.casts();
  rig.world.bounds = new THREE.Box3(); // makeEmpty: min = +Infinity, max = -Infinity
  const warned = [];
  const warn = console.warn;
  console.warn = (...a) => warned.push(a.join(' '));
  try {
    await enter(rig); // re-entry: the report, then nothing to sample
    for (let n = 0; n < 10; n++) rig.engine.tick();
  } finally {
    console.warn = warn;
  }
  const body = rig.fetchImpl.posts()[2].body;
  assert.equal('bounds' in body, false, 'JSON writes Infinity as null, and a present bounds key is "replace" to the server');
  assert.equal(rig.casts(), cast, 'no grid can be planned from an empty box');
  assert.equal(warned.length, 1, `one warning: ${warned}`);
  assert.equal(await rig.system.sampling, null, 'not the previous visit\'s summary');
  assert.equal(rig.system.layoutSampled, false);
});

/* ---------------------------------------------------- the layout report -- */

test('(b) after sampling, a second POST carries a grid with two layers under the roof and one elsewhere', async () => {
  const rig = setup(doc([], { admin: true }));
  await enter(rig);
  const summary = await finish(rig);
  const posts = rig.fetchImpl.posts();
  assert.equal(posts.length, 2, 'immediate report, then the layout report');
  const body = posts[1].body;
  assert.equal(body.world, 'station');
  assert.equal(body.appliedVersion, 1);
  assert.equal(body.layoutSchema, 1);
  assert.deepEqual(body.bounds, BOUNDS);
  const g = body.ground;
  assert.deepEqual([g.originX, g.originZ, g.step, g.nx, g.nz, g.layers], [-40, -40, 4, 21, 21, 4]);
  const h = decode(g);
  assert.equal(h.length, 21 * 21 * 4);
  // x = 4, z = 0: roof top at 20 m, the floor at 0, then nothing. x = 0: the roof starts at 2.
  assert.deepEqual([0, 1, 2, 3].map((k) => at(g, h, 11, 10, k)), [2000, 0, NO_SAMPLE, NO_SAMPLE]);
  assert.deepEqual([0, 1].map((k) => at(g, h, 10, 10, k)), [0, NO_SAMPLE]);
  assert.deepEqual([0, 1].map((k) => at(g, h, 0, 0, k)), [0, NO_SAMPLE]);
  assert.equal(rig.system.layoutSampled, true);
  assert.deepEqual([summary.world, summary.cells, summary.layers], ['station', 441, 4]);
  const ev = rig.bus.emitted.find((e) => e.name === 'map-overlay:layout');
  assert.ok(ev, 'map-overlay:layout was emitted');
  assert.equal(ev.payload.cells, 441);
  assert.equal(typeof ev.payload.sampledMs, 'number');
  assert.ok(Number.isFinite(summary.sampledMs), `sampledMs is a duration, got ${summary.sampledMs}`);
});

test('builtVersion rides on BOTH reports of a visit, and neither report carries a schema field', async () => {
  const rig = setup(doc([], { admin: true }));
  rig.world.builtVersion = 6;
  await enter(rig);
  await finish(rig);
  const posts = rig.fetchImpl.posts();
  assert.equal(posts.length, 2);
  assert.deepEqual(posts.map((p) => p.body.builtVersion), [6, 6]);
  assert.deepEqual(posts.map((p) => 'schema' in p.body), [false, false], 'the report has no schema: the layout axis is layoutSchema and a bump there erases every stored grid');
  assert.equal(posts[1].body.layoutSchema, 1);
});

test('(c) one frame samples about one cell at 1 ms per cast, and the job resumes on the next', async () => {
  const rig = setup(doc([], { admin: true }), { clockPerCast: 1 });
  await enter(rig);
  assert.equal(rig.casts(), 0, 'applying the overlay casts nothing');
  rig.engine.tick(0.016);
  assert.ok(rig.casts() >= 1 && rig.casts() <= 3, `one 2 ms frame cast ${rig.casts()} rays`);
  assert.equal(rig.system.layoutSampled, false);
  assert.equal(rig.fetchImpl.posts().length, 1, 'no layout POST mid-job');
  const summary = await finish(rig);
  assert.equal(rig.fetchImpl.posts().length, 2);
  assert.ok(rig.casts() >= 441 * 2, `every cell cast at least twice, got ${rig.casts()}`);
  assert.ok(summary.sampledMs >= 441 * 2, `the clock advanced 1 ms per cast: sampledMs ${summary.sampledMs}`);
});

test('(d) leaving the world mid-job posts no layout for it, and the promise resolves null', async () => {
  const rig = setup(doc([], { admin: true }), { clockPerCast: 1 });
  await enter(rig);
  rig.engine.tick();
  rig.engine.tick();
  assert.equal(rig.system.layoutSampled, false, 'two frames is two cells of 441');
  const first = rig.system.sampling;
  // A portal (the GET answers the station document, not this world's: no new job), then enough frames
  // to FINISH the old job if alive - ticked BEFORE the await, so a broken cancel is red, never a hang.
  rig.bus.emit('world:changed', { id: 'elsewhere', world: makeWorld('elsewhere') });
  await rig.system.applying;
  for (let n = 0; n < 2000; n++) rig.engine.tick();
  assert.equal(await first, null, 'the abandoned job resolves null');
  assert.equal(rig.fetchImpl.posts().filter((p) => p.body.ground).length, 0, 'no layout POST for a world we left');
  assert.equal(rig.system.layoutSampled, false);
  assert.ok(rig.casts() < 441 * 2, 'the old job did not keep casting after we left');
});

test('(e) forceLayout samples without an admin, emits the event, and never posts', async () => {
  const rig = setup(doc([], { admin: false }), { forceLayout: true });
  await enter(rig);
  const summary = await finish(rig);
  assert.equal(rig.system.layoutSampled, true);
  assert.equal(summary.cells, 441);
  assert.ok(rig.bus.emitted.some((e) => e.name === 'map-overlay:layout'));
  assert.equal(rig.fetchImpl.posts().length, 0, 'no admin session, so nothing to accept a POST');
});

test('a player who is neither admin nor forcing the switch never casts a ray', async () => {
  const rig = setup(doc([], { admin: false }));
  await enter(rig);
  for (let n = 0; n < 50; n++) rig.engine.tick();
  assert.equal(rig.casts(), 0);
  assert.equal(await rig.system.sampling, null);
});

test('dispose drops the frame subscription and the job', async () => {
  const rig = setup(doc([], { admin: true }), { clockPerCast: 1 });
  await enter(rig);
  rig.engine.tick();
  assert.equal(rig.engine.updaters.size, 1);
  const pending = rig.system.sampling;
  rig.system.dispose();
  assert.equal(rig.engine.updaters.size, 0);
  assert.equal(await pending, null);
});

test('bounds with a NaN height start no job: nothing is posted over the last good grid, and one warning says why', async () => {
  const rig = setup(doc([], { admin: true }));
  rig.world.bounds.max.y = NaN;
  const warned = [];
  const warn = console.warn;
  console.warn = (...a) => warned.push(a.join(' '));
  try {
    await enter(rig);
    for (let n = 0; n < 20; n++) rig.engine.tick();
  } finally {
    console.warn = warn;
  }
  assert.equal('bounds' in rig.fetchImpl.posts()[0].body, false);
  assert.equal(rig.fetchImpl.posts().length, 1, 'no layout POST: an all-NO_SAMPLE grid would replace the last good one');
  assert.equal(rig.casts(), 0);
  assert.equal(await rig.system.sampling, null);
  assert.equal(warned.length, 1, `one warning: ${warned}`);
  assert.match(warned[0], /\[map-overlay\] ground not sampled/);
});

test('a cast that throws abandons the job on that frame: one warning, null, and no further casts', async () => {
  const rig = setup(doc([], { admin: true }));
  await enter(rig);
  let threw = 0;
  rig.physics.raycast = () => { threw++; throw new Error('broadphase on fire'); };
  const warned = [];
  const warn = console.warn;
  console.warn = (...a) => warned.push(a.join(' '));
  try {
    // The frame that throws, then four that must find no job. Were the exception to escape
    // update(), tick() would throw here and the test would fail on it.
    for (let n = 0; n < 5; n++) rig.engine.tick();
  } finally {
    console.warn = warn;
  }
  assert.equal(threw, 1, 'a job whose cast throws is dropped, not resumed one cell per frame forever');
  assert.equal(warned.filter((w) => w.includes('ground sampling abandoned')).length, 1, `warned once: ${warned}`);
  assert.equal(await rig.system.sampling, null);
  assert.equal(rig.system.layoutSampled, false);
  assert.equal(rig.fetchImpl.posts().length, 1, 'the immediate report only');
});

test('a layout report the editor refuses is said so once, and sampling still resolves', async () => {
  const rig = setup(doc([], { admin: true }), { refuseGround: true });
  const warned = [];
  const warn = console.warn;
  console.warn = (...a) => warned.push(a.join(' '));
  let summary;
  try {
    await enter(rig);
    summary = await finish(rig);
  } finally {
    console.warn = warn;
  }
  assert.equal(summary.cells, 441, 'the promise resolved with the summary');
  assert.equal(rig.fetchImpl.posts().length, 2, 'the layout POST was made once: no retry');
  assert.equal(warned.length, 1, `one warning: ${warned}`);
  assert.match(warned[0], /\[map-overlay\] the editor refused the report.*413/);
});

test("the editor's 200 that kept the prior layout is said once, with its reasons", async () => {
  const rig = setup(doc([], { admin: true }), { answer: { ok: true, layout: 'kept-prior', warnings: ['layoutSchema 2 is not 1'] } });
  const warned = [];
  const warn = console.warn;
  console.warn = (...a) => warned.push(a.join(' '));
  try {
    await enter(rig);   // the immediate report: one POST, one answer
  } finally {
    console.warn = warn;
  }
  assert.equal(rig.fetchImpl.posts().length, 1);
  assert.deepEqual(warned, ['[map-overlay] layout kept-prior: layoutSchema 2 is not 1']);
});

test('a 200 that stored the layout, an older site that says nothing about it, and a body that does not parse are all silent', async () => {
  for (const answer of [{ ok: true, layout: 'stored' }, { ok: true }, new Error('not JSON')]) {
    const rig = setup(doc([], { admin: true }), { answer });
    const warned = [];
    const warn = console.warn;
    console.warn = (...a) => warned.push(a.join(' '));
    try {
      await enter(rig);
      await finish(rig);   // both reports of the visit
    } finally {
      console.warn = warn;
    }
    assert.equal(rig.fetchImpl.posts().length, 2);
    assert.deepEqual(warned, [], `answer ${answer instanceof Error ? 'unparseable' : JSON.stringify(answer)}: ${warned}`);
  }
});

test('a stale document for the world before lands after a portal: it is dropped, and the layout POST names the world sampled', async () => {
  // The station GET is held until released; elsewhere answers at once, as admin.
  let release;
  const held = new Promise((r) => { release = r; });
  const overlays = { station: doc([], { admin: true }), elsewhere: doc([], { admin: true, world: 'elsewhere' }) };
  const rig = setup(async (worldId) => { if (worldId === 'station') await held; return overlays[worldId]; }, { clockPerCast: 1 });
  rig.bus.emit('world:changed', { id: 'station', world: rig.world });
  rig.bus.emit('world:changed', { id: 'elsewhere', world: makeWorld('elsewhere') });
  await rig.system.applying;
  rig.engine.tick(); // elsewhere's job is in flight
  release();
  await new Promise((r) => setTimeout(r, 0)); // the station continuation runs to its end
  // The station's document arrived after the portal. It is not applied and not
  // reported: the report stays the world the player is in, and no POST ever
  // names the station. (This test once pinned the opposite as a precondition,
  // to show the sampler's POST survived the overwrite; the overwrite is gone.)
  assert.equal(rig.system.report.world, 'elsewhere', 'the stale document republished over the world the player is in');
  assert.equal(rig.fetchImpl.posts().some((p) => p.body.world === 'station'), false, 'the stale document was reported back');
  const summary = await finish(rig);
  assert.equal(summary.world, 'elsewhere');
  const layout = rig.fetchImpl.posts().find((p) => p.body.ground);
  assert.equal(layout.body.world, 'elsewhere', 'the ground is posted for the world it was sampled in');
  assert.equal(layout.body.appliedVersion, 1);
});

/* ------------------------------------------------------------ the peel -- */

test('two surfaces 2 cm apart are two layers: the peel re-casts from below the last hit', async () => {
  const rig = setup(doc([], { admin: true }));
  // Two 1 cm slabs over x ∈ [-38, -22] with tops at 10.00 and 9.98 and 1 cm of air between
  // them. The re-cast starts PEEL (1 cm) below the first top: on the first slab's underside
  // (missed - a ray on a face has tmin 0) and above the second top. Note the boundary this
  // pins from the outside: a top EXACTLY 1 cm down sits on the re-cast origin and is usually
  // missed, so the game resolves surfaces MORE than 1 cm apart, while the site's grid is cm.
  rig.physics.addBox(-30, 9.995, 0, 8, 0.005, 100);
  rig.physics.addBox(-30, 9.975, 0, 8, 0.005, 100);
  await enter(rig);
  await finish(rig);
  const g = rig.fetchImpl.posts()[1].body.ground;
  const h = decode(g);
  // cell (1, 10) is x = -36, z = 0.
  assert.deepEqual([0, 1, 2, 3].map((k) => at(g, h, 1, 10, k)), [1000, 998, 0, NO_SAMPLE]);
});

test('a top exactly 1 cm below the last hit never loses the floor beneath it: six slab heights on offset grids', async () => {
  // Two 1 cm slabs over the whole world, tops T and T - 0.01, over the floor at 0. The re-cast
  // from T - 0.01 starts ON the lower top, and the physics answers one of three things by
  // T's rounding alone: null (a ray on a face has tmin 0: the slab merges), a hit a few ulp
  // below (kept), or a hit that rounds back to EXACTLY the origin. That last one, under the
  // old `if (h >= y) break`, ended the cell and lost every column's floor: T = 13.05, 9.3
  // and 8.27 do it; 20 and 10 merge the lower slab; 7.77 keeps it. Grids offset by fractions.
  const PLACEMENTS = [[13.05, 0.42, 0.43], [9.3, 0.31, 0.86], [8.27, 0.19, 0.48], [20, 0, 0], [10, 0.5, 0.25], [7.77, 0.37, 0.61]];
  for (const [T, fx, fz] of PLACEMENTS) {
    const rig = setup(doc([], { admin: true }));
    rig.world.bounds = new THREE.Box3(new THREE.Vector3(-40 + fx, -5, -40 + fz), new THREE.Vector3(40 + fx, 30, 40 + fz));
    rig.physics.addBox(0, T - 0.005, 0, 100, 0.005, 100);
    rig.physics.addBox(0, T - 0.015, 0, 100, 0.005, 100);
    await enter(rig);
    await finish(rig);
    const g = rig.fetchImpl.posts()[1].body.ground;
    const h = decode(g);
    const top = Math.round(T * 100);
    // Every column west of the rig's roof (x < 2): i <= 9 is x <= -4 + fx.
    for (let j = 0; j < g.nz; j++) {
      for (let i = 0; i <= 9; i++) {
        const col = [0, 1, 2, 3].map((k) => at(g, h, i, j, k)).filter((v) => v !== NO_SAMPLE);
        assert.equal(col[0], top, `T=${T} cell (${i},${j}): layer 0 is the top slab`);
        assert.ok(col.length >= 2 && col[col.length - 1] === 0, `T=${T} cell (${i},${j}) ends on the floor, got [${col}]`);
      }
    }
  }
});

test('five surfaces through the real raycast keep the top three and the floor: four slabs over the deck', async () => {
  // The station hub's shape - a dome, canopy layers, the deck - as four 1 m slabs over
  // x ∈ [-38, -22] with tops at 60, 40, 20 and 10 over the rig's floor at 0. The bounds
  // reach 70 so the first cast (bounds.max.y + 10) starts above the highest slab. Each
  // re-cast starts 1 cm below a top, inside that slab, which the real collider code
  // misses (a ray starting inside a box has tmin <= 0), so the next slab down is the
  // next hit. With four layers the fourth slab (10 m) gives way to the deck: a cell that
  // stopped at four hits stored [6000, 4000, 2000, 1000] and called the 10 m slab the
  // floor - the very shape that put a placed item on the hub's canopy beam.
  const rig = setup(doc([], { admin: true }));
  rig.world.bounds = new THREE.Box3(new THREE.Vector3(-40, -5, -40), new THREE.Vector3(40, 70, 40));
  for (const top of [60, 40, 20, 10]) rig.physics.addBox(-30, top - 0.5, 0, 8, 0.5, 100);
  await enter(rig);
  await finish(rig);
  const g = rig.fetchImpl.posts()[1].body.ground;
  const h = decode(g);
  // cell (1, 10) is x = -36, z = 0: under all four slabs.
  assert.deepEqual([0, 1, 2, 3].map((k) => at(g, h, 1, 10, k)), [6000, 4000, 2000, 0]);
  // cell (0, 10) is x = -40: open floor beside them.
  assert.deepEqual([0, 1, 2, 3].map((k) => at(g, h, 0, 10, k)), [0, NO_SAMPLE, NO_SAMPLE, NO_SAMPLE]);
});

/* ------------------------------------------------------ the dev switch -- */

test('?layout=sample reaches applyUrlOverrides as layout: "sample" beside dev=1 only; its absence, and a URL without dev=1, read null', async () => {
  const { applyUrlOverrides } = await import('../../src/core/Config.js');
  const saved = globalThis.location;
  try {
    globalThis.location = { search: '?dev=1&layout=sample' };
    assert.equal(applyUrlOverrides().layout, 'sample');
    globalThis.location = { search: '?dev=1' };
    assert.equal(applyUrlOverrides().layout, null);
    // The dev-switch family: a player's URL cannot start the sampler.
    globalThis.location = { search: '?layout=sample' };
    assert.equal(applyUrlOverrides().layout, null, 'honoured without dev=1');
    globalThis.location = { search: '?dev=0&layout=sample' };
    assert.equal(applyUrlOverrides().layout, null, 'honoured under dev=0');
  } finally {
    globalThis.location = saved;
  }
});

test('main.js hands the engine and the switch to MapOverlay', async () => {
  const main = await readCode('src/main.js');
  assert.match(main, /new MapOverlay\(\{ bus, physics, loot, engine, mounts, forceLayout: overrides\.layout === 'sample' \}\)/,
    'MapOverlay is constructed without the engine, the mounts, or the ?layout=sample switch');
});

test('frame-gaps can switch the sampler on, waits for it, records whether it finished, and gates on that', async () => {
  const fg = await readCode('scripts/frame-gaps.mjs');
  assert.match(fg, /a === '--layout-sample'/, 'no --layout-sample flag');
  assert.match(fg, /a === '--layout-timeout'/, 'no --layout-timeout flag');
  assert.match(fg, /Number\.isFinite\(args\.layoutTimeoutMs\)/,
    'a --layout-timeout left without a value is NaN - an instant timeout - and nothing refuses it');
  assert.match(fg, /args\.layoutSample \? '&layout=sample' : ''/, 'the flag never reaches the page URL');
  assert.match(fg, /`\?dev=1&autostart=1/, 'the page URL does not carry dev=1, and layout=sample is honoured only beside it');
  assert.match(fg, /mapOverlay\?\.layoutSampled === true/, 'the run never asks the game whether sampling finished');
  assert.match(fg, /bus\.on\('map-overlay:layout'/, "the sampler's completion event is not latched on the page clock");
  assert.match(fg, /finished inside boot/, 'a layout row that measured nothing is never said so');
  assert.match(fg, /layoutSampled: run\.layoutSampled === true/, 'summary.json runs[] do not record layoutSampled');
  assert.match(fg, /layoutSampled: args\.layoutSample && runs\.length > 0 && runs\.every\(\(r\) => r\.layoutSampled === true\)/,
    'summary.layoutSampled can read true on zero runs ([].every() is true) or on a run that never finished');
  const gate = fg.slice(fg.indexOf('function gateRun'));
  assert.ok(/args\.layoutSample && run\.layoutSampled !== true/.test(gate),
    'the gate does not fail a --layout-sample run whose sampler never finished');
  assert.ok(/run\.layoutWorld !== args\.entryWorld/.test(gate),
    'the gate does not fail a run whose sampler finished on some other world');
  assert.ok(/const notes = \[\.\.\.\(run\.notes \?\? \[\]\)\]/.test(gate),
    'the gate never prints what the run itself noted - a timeout, a row that measured nothing');
});
