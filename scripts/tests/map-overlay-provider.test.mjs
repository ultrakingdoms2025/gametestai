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
 * once per outage - a volatile world that fails, answers, then fails again is
 * news twice - and the loader names the wait. One background timeout opens a
 * session breaker: later background builds skip the provider until a lookup
 * answers with a document or a minute has passed - then ONE background build
 * probes again, and a probe that hangs re-opens it from that moment - so a
 * hanging server costs the prefetch chain one fuse a minute, not one per
 * world; a gate timeout never opens it. The provider is read from the
 * MANAGER's ctx, never the per-world copy. The cases that reach this seam
 * through a portal forcing its destination, a WorldPrefetch preparation and a
 * volatile rebuild land with Task 3.6 (`WorldPrefetch` is imported for them).
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

test('a volatile world that fails, answers, then fails again is said twice: the warning is once per OUTAGE, not once for ever', async () => {
  let n = 0;
  const versions = [];
  const warned = await quietly(async () => {
    const { wm } = manager({ provider: async () => { n++; if (n === 2) return { version: 2 }; throw new Error(`outage ${n}`); } });
    wm.register(worldClass('flaky', { volatile: true }));
    for (let i = 0; i < 3; i++) versions.push((await wm.build('flaky')).builtVersion);
  });
  assert.deepEqual(versions, [0, 2, 0], 'a volatile world did not rebuild through the provider each time');
  assert.deepEqual(warned, [
    '[WorldManager] overlay unavailable for "flaky": outage 1; building without it',
    '[WorldManager] overlay unavailable for "flaky": outage 3; building without it',
  ]);
});

test('the loader names the wait: "Reading the map for <world>" while the provider is asked, "Generating" again after it answers, and never without a provider', async () => {
  const labels = [];
  const { wm } = manager({ provider: async () => ({ version: 1 }) });
  wm.register(worldClass('named'));
  await wm.build('named', (_p, label) => labels.push(label));
  const at = labels.indexOf('Reading the map for named');
  assert.ok(at >= 0, `the wait was never named: ${labels}`);
  // A test world labels no phase of its own, so without this the bar would sit on "Reading the map" for the whole build.
  assert.equal(labels[at + 1], 'Generating named', `after the answer: ${labels}`);
  assert.equal(labels[labels.length - 1], 'named ready');

  const seen = [];
  const quiet = manager();
  quiet.wm.register(worldClass('unnamed'));
  await quiet.wm.build('unnamed', (_p, label) => seen.push(label));
  assert.ok(!seen.some((l) => /Reading the map/.test(l)), `a build with no provider named a wait: ${seen}`);
});

test('dispose forgets the outage and closes the breaker: after a teardown the same world is asked again, and a hang is said again', async () => {
  const asked = [];
  const warned = await quietly(async () => {
    const { wm } = manager({ running: true, provider: (id) => { asked.push(id); return never(); } });
    wm.overlayBackgroundMs = 100; // the same fuse, shortened
    wm.register(worldClass('torn'));
    await wm.build('torn'); // times out in the background: said, and the breaker opens
    wm.dispose();
    await wm.build('torn');
  });
  assert.deepEqual(asked, ['torn', 'torn'], 'after dispose the breaker still skipped the provider');
  assert.equal(warned.length, 2, `said ${warned.length} times: ${warned}`);
});

test('one background timeout opens the session breaker: the next background build skips the provider - built at 0, nothing said, no fuse - and a late document from the abandoned lookup closes it', async () => {
  let release;
  const held = new Promise((r) => { release = r; });
  const asked = [];
  const warned = await quietly(async (said) => {
    const { wm } = manager({ running: true, provider: (id) => { asked.push(id); return id === 'slow' ? held : Promise.resolve({ version: 4 }); } });
    for (const id of ['slow', 'next', 'after']) wm.register(worldClass(id));
    assert.equal((await wm.build('slow')).builtVersion, 0); // the real 1500 ms fuse
    assert.deepEqual(asked, ['slow']);
    const t = performance.now();
    const next = await wm.build('next');
    const took = performance.now() - t;
    assert.equal(next.builtVersion, 0);
    assert.ok(took < 100, `a broken session still waited ${took} ms`);
    assert.deepEqual(asked, ['slow'], 'the breaker did not skip the provider');
    assert.equal(said.length, 1, `a skipped build was said: ${said}`);
    release({ version: 2 }); // the server was slow, not dead
    await sleep(0);
    assert.equal((await wm.build('after')).builtVersion, 4);
    assert.deepEqual(asked, ['slow', 'after'], 'a late document did not close the breaker');
  });
  assert.equal(warned.length, 1);
  assert.match(warned[0], /overlay unavailable for "slow": no answer within 1500 ms/);
});

test('a gate build always asks, whatever the breaker says, and its answer closes it for the background builds after', async () => {
  const asked = [];
  let hang = true;
  const { wm, engine } = manager({ running: true, provider: (id) => { asked.push(id); return hang ? never() : Promise.resolve({ version: 3 }); } });
  wm.overlayBackgroundMs = 100; // the same fuse, shortened
  for (const id of ['a', 'b', 'c', 'd']) wm.register(worldClass(id));
  await quietly(async () => {
    assert.equal((await wm.build('a')).builtVersion, 0); // opens the breaker
    assert.equal((await wm.build('b')).builtVersion, 0);
    assert.deepEqual(asked, ['a'], 'the breaker did not skip the provider');
    engine.running = false;
    hang = false;
    assert.equal((await wm.build('c')).builtVersion, 3, 'a gate build did not ask');
    engine.running = true;
    assert.equal((await wm.build('d')).builtVersion, 3, 'the gate answer did not close the breaker');
    assert.deepEqual(asked, ['a', 'c', 'd']);
  });
});

test('the breaker is half-open after a minute: one background build probes again, a probe that hangs re-opens it from THAT moment, and a document closes it', async () => {
  const src = await readCode('src/worlds/WorldManager.js');
  assert.match(src, /^const OVERLAY_BREAKER_RETRY_MS = 60000;/m, 'the probe interval is not one minute');
  let clock = 0;
  let hang = true;
  const asked = [];
  const { wm } = manager({ running: true, provider: (id) => { asked.push(id); return hang ? never() : Promise.resolve({ version: 6 }); } });
  wm.now = () => clock; // the breaker's clock, owned by the test
  wm.overlayBackgroundMs = 100; // the same fuse, shortened
  for (const id of ['a', 'b', 'c', 'd', 'e', 'f', 'g']) wm.register(worldClass(id));
  await quietly(async () => {
    assert.equal((await wm.build('a')).builtVersion, 0); // hangs: the breaker opens at 0 on this clock
    const t = performance.now();
    await wm.build('b');
    assert.ok(performance.now() - t < 100, 'an open breaker still waited on the fuse');
    clock = 59_999;
    await wm.build('c');
    assert.deepEqual(asked, ['a'], 'the breaker probed before the minute was up');
    clock = 60_000;
    await wm.build('d'); // the probe: asked, hangs again, and the breaker re-opens at 60 000
    assert.deepEqual(asked, ['a', 'd'], 'after a minute no background build probed');
    clock = 60_050;
    await wm.build('e');
    assert.deepEqual(asked, ['a', 'd'], 'a probe that hung did not re-open the breaker from its own moment');
    clock = 120_000;
    hang = false;
    assert.equal((await wm.build('f')).builtVersion, 6, 'the second probe did not ask, or its answer was dropped');
    clock = 120_001;
    assert.equal((await wm.build('g')).builtVersion, 6, 'a document did not close the breaker');
    assert.deepEqual(asked, ['a', 'd', 'f', 'g']);
  });
});

test('a gate timeout never opens the breaker: the boot pays its own fuse, and the first background build after it still asks', async () => {
  const asked = [];
  let took = 0;
  const { wm, engine } = manager({ running: false, provider: (id) => { asked.push(id); return never(); } });
  wm.overlayGateMs = 100; // the same fuses, shortened
  wm.overlayBackgroundMs = 100;
  for (const id of ['boot', 'bg']) wm.register(worldClass(id));
  await quietly(async () => {
    assert.equal((await wm.build('boot')).builtVersion, 0); // the gate fuse
    engine.running = true;
    const t = performance.now();
    await wm.build('bg');
    took = performance.now() - t;
  });
  assert.deepEqual(asked, ['boot', 'bg'], 'a gate timeout opened the breaker, so the background build never asked');
  assert.ok(took >= 80, `the background build did not wait on its own fuse (${took} ms)`);
});

test("main.js sets the provider on the manager's ctx, gated on the session, before the entry build, and prefetches the entry world", async () => {
  const src = await readCode('src/main.js');
  const boot = src.slice(src.indexOf('async function boot()'));
  const provider = boot.indexOf('worldManager.ctx.overlayProvider = (id) => accountStatePromise.then((account) => (account ? mapOverlay.lookup(id) : null));');
  const prefetch = boot.indexOf('accountStatePromise.then((account) => { if (account) mapOverlay.prefetch(startWorld); });');
  const build = boot.indexOf('await worldManager.build(startWorld');
  assert.ok(provider > 0, "the provider is not set on worldManager.ctx inside boot(), or is not gated on accountStatePromise - an anonymous boot would wait on a 401");
  assert.ok(prefetch > 0, 'the entry world is not prefetched, so its fetch no longer overlaps the loading gate');
  assert.ok(build > 0 && provider < build && prefetch < build, 'the provider or the prefetch lands after the entry build, which then builds at version 0');
  // Two lines other suites pin must not have moved with this edit.
  assert.match(src, /new MapOverlay\(\{ bus, physics, loot, engine, forceLayout: overrides\.layout === 'sample' \}\)/, 'the MapOverlay constructor line changed');
  assert.match(boot, /if \(overrides\.prefetch === 'all'\) scheduleBackgroundBuilds\(startWorld\);/, 'the eager-chain line changed');
});
