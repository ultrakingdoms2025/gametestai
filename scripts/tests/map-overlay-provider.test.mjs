// scripts/tests/map-overlay-provider.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as THREE from 'three';

/**
 * THE OVERLAY REACHES THE BUILD, THROUGH THE REAL WorldManager.
 *
 * THE CLAIM (spec §4.1, owner decision G): `_runBuild` asks `ctx.overlayProvider`
 * for the world's document before the world builds and stores its version as
 * `world.builtVersion`; with nothing on ctx it awaits nothing and starts no
 * timer; in the player's frames it waits at most 1500 ms, behind the loading
 * gate at most 8000 ms; a failure or a timeout is a world built at 0, said
 * once. A portal forcing its destination, a WorldPrefetch preparation and a
 * volatile rebuild all go through the same seam, and the provider is read from
 * the MANAGER's ctx, never the per-world copy.
 *
 * Not a stub: every case builds a real World subclass through the real
 * WorldManager over a real Physics, and the timing cases wait on real timers
 * against a provider that really never answers. rAF is counted as
 * station-build-slicing counts it, because a frame handed back is the one
 * thing a "no await" claim can be measured by.
 */

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const read = async (p) => (await readFile(path.join(root, p), 'utf8')).replace(/\r\n/g, '\n');
const readCode = async (p) => (await read(p)).replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/.*$/gm, '$1');

const baseRaf = globalThis.requestAnimationFrame ?? ((cb) => setTimeout(() => cb(Date.now()), 0));
let rafCalls = 0;
globalThis.requestAnimationFrame = (cb) => { rafCalls++; return baseRaf(cb); };

const { EventBus } = await import('../../src/core/EventBus.js');
const { Physics } = await import('../../src/physics/Physics.js');
const { World } = await import('../../src/worlds/World.js');
const { WorldManager } = await import('../../src/worlds/WorldManager.js');
const { WorldPrefetch } = await import('../../src/systems/WorldPrefetch.js');

/** A world of one floor box. `volatile` opts in to the maze's rebuild-on-every-request rule. */
function worldClass(id, { volatile = false } = {}) {
  return class extends World {
    static id = id;
    static displayName = id;
    static volatile = volatile;
    async build() {
      this.track(this.physics.addBox(0, -0.5, 0, 20, 0.5, 20));
      this.playerSpawn.set(0, 1, 0);
    }
  };
}

function manager({ running = false, provider } = {}) {
  const bus = new EventBus();
  const physics = new Physics(bus);
  const engine = { running };
  const ctx = { scene: new THREE.Scene(), engine, physics, bus, materials: {} };
  if (provider) ctx.overlayProvider = provider;
  const wm = new WorldManager(ctx);
  return { wm, engine, bus, physics, ctx };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const never = () => new Promise(() => {});
const quietly = async (fn) => {
  const warned = [];
  const warn = console.warn;
  console.warn = (...a) => warned.push(a.join(' '));
  try { await fn(warned); } finally { console.warn = warn; }
  return warned;
};

test('a world declares builtVersion 0 before it is built, and dispose resets it', async () => {
  const { wm } = manager();
  wm.register(worldClass('fresh'));
  const world = wm.getWorld('fresh');
  assert.equal(world.builtVersion, 0);
  world.builtVersion = 9;
  world.dispose();
  assert.equal(world.builtVersion, 0);
});

test('no provider on ctx: the build waits on nothing, hands no frame back for it, and the world is built at 0', async () => {
  const { wm } = manager();
  wm.register(worldClass('none'));
  const before = rafCalls;
  const t = performance.now();
  const world = await wm.build('none');
  assert.equal(world.builtVersion, 0);
  // At most the coarse `report(1)` yield a slow machine can trip (>24 ms since report(0)); never a timer's worth.
  assert.ok(rafCalls - before <= 1, `a build with nothing to wait for handed ${rafCalls - before} frames back`);
  assert.ok(performance.now() - t < 200, 'a build with no provider waited on something');
});

test('a provider that answers {version: 7} leaves the world built at 7, asked once with the world id', async () => {
  const asked = [];
  const { wm } = manager({ provider: async (id) => { asked.push(id); return { version: 7, entries: [], admin: false }; } });
  wm.register(worldClass('seven'));
  assert.equal((await wm.build('seven')).builtVersion, 7);
  assert.deepEqual(asked, ['seven']);
  assert.equal((await wm.build('seven')).builtVersion, 7, 'a second build of a cached world is the same world');
  assert.deepEqual(asked, ['seven'], 'a cached world was built again');
});

test('a provider that rejects builds the world at 0 and says so once; a null answer (signed out) says nothing', async () => {
  const warned = await quietly(async () => {
    const { wm } = manager({ provider: async () => { throw new Error('offline'); } });
    wm.register(worldClass('down'));
    assert.equal((await wm.build('down')).builtVersion, 0);
    const quiet = manager({ provider: async () => null });
    quiet.wm.register(worldClass('anon'));
    assert.equal((await quiet.wm.build('anon')).builtVersion, 0);
  });
  assert.deepEqual(warned, ['[WorldManager] overlay unavailable for "down": offline; building without it']);
});

test("in the player's frames a provider that never answers costs a build at most 1500 ms, then 0", async () => {
  let took = 0;
  let world;
  const warned = await quietly(async () => {
    const { wm } = manager({ running: true, provider: never });
    wm.register(worldClass('bg'));
    const t = performance.now();
    world = await wm.build('bg');
    took = performance.now() - t;
  });
  assert.equal(world.builtVersion, 0);
  assert.ok(took >= 1400 && took < 4000, `waited ${took} ms`);
  assert.match(warned[0], /overlay unavailable for "bg": no answer within 1500 ms/);
});

test('behind the loading gate the build waits past 1500 ms for a slow answer, and takes it', async () => {
  const { wm } = manager({ running: false, provider: () => sleep(2200).then(() => ({ version: 5 })) });
  wm.register(worldClass('gated'));
  assert.equal((await wm.build('gated')).builtVersion, 5);
});

test('behind the gate the ceiling is 8 s, not for ever: a hanging provider cannot hold the boot', async () => {
  const src = await readCode('src/worlds/WorldManager.js');
  assert.match(src, /^const OVERLAY_GATE_MS = 8000;/m, 'the gate ceiling is not 8000 ms (owner decision G)');
  assert.match(src, /^const OVERLAY_BACKGROUND_MS = 1500;/m, 'the background race is not 1500 ms (spec §4.1)');
  let took = 0;
  let world;
  const warned = await quietly(async () => {
    const { wm } = manager({ running: false, provider: never });
    wm.overlayGateMs = 300; // the same fuse, shortened so the test does not wait 8 s
    wm.register(worldClass('hang'));
    const t = performance.now();
    world = await wm.build('hang');
    took = performance.now() - t;
  });
  assert.equal(world.builtVersion, 0);
  assert.ok(took >= 280, `resolved after ${took} ms`);
  assert.match(warned[0], /no answer within 300 ms/);
});

test("the provider is read from the manager's ctx, so one set after a world was constructed still reaches its build", async () => {
  const { wm, ctx } = manager();
  wm.register(worldClass('late'));
  wm.getWorld('late'); // its ctx copy was spread before any provider existed
  ctx.overlayProvider = async () => ({ version: 3 });
  assert.equal((await wm.build('late')).builtVersion, 3);
});
