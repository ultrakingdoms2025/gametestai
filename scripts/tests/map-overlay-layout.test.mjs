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
 * `?layout=sample` samples with no admin and never posts.
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

function makeFetch(overlay) {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url, method: init?.method ?? 'GET', body: init?.body ? JSON.parse(init.body) : null });
    if ((init?.method ?? 'GET') === 'GET') return { ok: true, status: 200, json: async () => overlay };
    return { ok: true, status: 200, json: async () => ({ ok: true }) };
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
function setup(overlay, { forceLayout = false, clockPerCast = 0 } = {}) {
  const bus = makeBus();
  const physics = new Physics(bus);
  physics.addBox(0, -1, 0, 100, 1, 100);
  physics.addBox(22, 19.5, 0, 20, 0.5, 100);
  let clock = 0;
  let casts = 0;
  const raycast = physics.raycast.bind(physics);
  physics.raycast = (...a) => { casts++; clock += clockPerCast; return raycast(...a); };
  const loot = { spawn: () => null, despawn: () => true };
  const fetchImpl = makeFetch(overlay);
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

test('a world with no bounds still reports, without a bounds field', async () => {
  const rig = setup(doc([], { admin: true }));
  delete rig.world.bounds;
  await enter(rig);
  const body = rig.fetchImpl.posts()[0].body;
  assert.equal(body.layoutSchema, 1);
  assert.equal('bounds' in body, false);
  assert.deepEqual(body.shapes, rig.world.minimapShapes);
});
