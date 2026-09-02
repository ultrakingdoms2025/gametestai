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
 * probes again (a build started inside the probe's fuse skips: the probe
 * re-opens it from its own start), and a probe that hangs leaves it
 * re-opened from that moment - so a
 * hanging server costs the prefetch chain one fuse a minute, not one per
 * world; a gate timeout never opens it. The provider is read from the
 * MANAGER's ctx, never the per-world copy. Every other way a world gets built
 * reaches the same seam: a portal forcing its destination (through the real
 * `activate()`), a WorldPrefetch preparation (through the real poller) and a
 * volatile rebuild all take the 1.5 s rule and the breaker with it - so a
 * crossing or a chain inside the minute after a hang is held for nothing and
 * asks nothing, and only the probe pays the fuse.
 *
 * Not a stub: every timing case builds a real World subclass through the real
 * WorldManager over a real Physics and waits on real timers against a
 * provider that really never answers; the two closing cases put the REAL
 * MapOverlay.lookup on the seam and hang its fetch. rAF is counted as
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
const { MapOverlay } = await import('../../src/systems/MapOverlay.js');

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
    assert.ok(took < 750, `a broken session still waited ${took} ms`); // against the real 1500 ms fuse
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

test('the breaker is half-open after a minute: ONE background build probes again (a build started inside the probe window skips), a probe that hangs re-opens it from THAT moment, and a document closes it', async () => {
  const src = await readCode('src/worlds/WorldManager.js');
  assert.match(src, /^const OVERLAY_BREAKER_RETRY_MS = 60000;/m, 'the probe interval is not one minute');
  let clock = 0;
  let hang = true;
  const asked = [];
  const { wm } = manager({ running: true, provider: (id) => { asked.push(id); return hang ? never() : Promise.resolve({ version: 6 }); } });
  wm.now = () => clock; // the breaker's clock, owned by the test
  wm.overlayBackgroundMs = 300; // the same fuse, shortened
  for (const id of ['a', 'b', 'c', 'd', 'd2', 'e', 'f', 'g']) wm.register(worldClass(id));
  await quietly(async () => {
    assert.equal((await wm.build('a')).builtVersion, 0); // hangs: the breaker opens at 0 on this clock
    const t = performance.now();
    await wm.build('b');
    assert.ok(performance.now() - t < 150, 'an open breaker still waited on the fuse');
    clock = 59_999;
    await wm.build('c');
    assert.deepEqual(asked, ['a'], 'the breaker probed before the minute was up');
    clock = 60_000;
    // The probe, and a second background build started inside its fuse - the next world on the prefetch chain.
    // The probe re-opens the breaker from its own START, so the second skips: one probe, not the chain's worth.
    const probe = wm.build('d'); // the probe: asked, hangs again, and the breaker re-opens at 60 000
    const beside = wm.build('d2');
    await Promise.all([probe, beside]);
    assert.equal(asked.includes('d2'), false, 'a build started inside the probe window asked too: the probe re-opened the breaker only at its timeout');
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
  /* The PROPERTY, not the punctuation. This used to `indexOf` the whole
   * statement as one line of text, so it broke the moment a second thing
   * joined that `.then` — `MazeWorld.adoptDailySeed(account)`, which needs the
   * same account and the same "before the entry build" position — even though
   * the prefetch still happens, still inside the session promise, and still
   * ahead of the build. A test that fails when a line is reformatted is
   * measuring the source's shape rather than the program's behaviour, and this
   * file already knows the better spelling: it compares INDICES three lines
   * down. So match the call, then let the ordering assertions below carry the
   * claim the name of this test actually makes. */
  const prefetchCall = /accountStatePromise\.then\(\([^)]*\)\s*=>\s*\{[\s\S]{0,600}?mapOverlay\.prefetch\(startWorld\)/.exec(boot);
  const prefetch = prefetchCall ? prefetchCall.index : -1;
  const build = boot.indexOf('await worldManager.build(startWorld');
  assert.ok(provider > 0, "the provider is not set on worldManager.ctx inside boot(), or is not gated on accountStatePromise - an anonymous boot would wait on a 401");
  assert.ok(prefetch > 0, 'the entry world is not prefetched, so its fetch no longer overlaps the loading gate');
  assert.ok(build > 0 && provider < build && prefetch < build, 'the provider or the prefetch lands after the entry build, which then builds at version 0');
  // Two lines other suites pin must not have moved with this edit.
  assert.match(src, /new MapOverlay\(\{ bus, physics, loot, engine, mounts, inventory, forceLayout: overrides\.layout === 'sample' \}\)/, 'the MapOverlay constructor line changed');
  assert.match(boot, /if \(overrides\.prefetch === 'all'\) scheduleBackgroundBuilds\(startWorld\);/, 'the eager-chain line changed');
});

/* ------------------------------------------------------------------ */
/* The other callers of a build: a portal, a volatile rebuild, WorldPrefetch */
/* ------------------------------------------------------------------ */

/** A portal list the poller can walk: one gateway per target, 5 m apart, all inside PREFETCH_RANGE. */
const gates = (...targets) => ({
  portals: targets.map((target, i) => ({ target, position: { x: 5 + 5 * i, y: 0, z: 0 } })),
  holdPreviews() {},
});

test("a portal forcing an unbuilt destination in the player's frames gets the 1500 ms rule and the crossing still completes; a crossing inside the minute after the hang is held for nothing and asks nothing", async () => {
  const asked = [];
  let took = 0;
  let tookAfter = 0;
  const warned = await quietly(async () => {
    // The entry world is built behind the loading gate, where the provider answers; then the engine starts, and
    // every build after it is a portal's - in the player's frames.
    const { wm, engine } = manager({ running: false, provider: (id) => { asked.push(id); return id === 'here' ? Promise.resolve({ version: 2 }) : never(); } });
    for (const id of ['here', 'there', 'beyond']) wm.register(worldClass(id));
    const here = await wm.activate('here');
    assert.equal(here.builtVersion, 2);
    engine.running = true;
    let t = performance.now();
    const there = await wm.activate('there'); // _activate -> build('there') -> _runBuild, engine.running true
    took = performance.now() - t;
    assert.equal(there.builtVersion, 0);
    assert.equal(there.active, true, 'the crossing did not complete');
    assert.equal(here.active, false);
    assert.deepEqual(asked, ['here', 'there']);
    // That hang opened the session breaker: the next gateway inside the minute is crossed at once and asks
    // nothing - the designed cost of one probe a minute, so a hanging server costs a player one fuse, not one
    // per gateway. (A world already looked up costs nothing either way: MapOverlay's cache answers it.)
    t = performance.now();
    const beyond = await wm.activate('beyond');
    tookAfter = performance.now() - t;
    assert.equal(beyond.builtVersion, 0);
    assert.equal(beyond.active, true);
    assert.deepEqual(asked, ['here', 'there'], 'a crossing inside the minute after a hang asked the provider');
  });
  assert.ok(took >= 1400 && took < 4000, `the crossing took ${took} ms`);
  assert.ok(tookAfter < 750, `the crossing after the hang waited ${tookAfter} ms`); // against the real 1500 ms fuse
  assert.deepEqual(warned, ['[WorldManager] overlay unavailable for "there": no answer within 1500 ms; building without it']);
});

test('a volatile world re-reads the provider on every request, and its builtVersion follows the answer', async () => {
  let version = 1;
  let hold = null;
  const asked = [];
  const { wm } = manager({ provider: async (id) => { asked.push(id); if (hold) await hold; return { version }; } });
  wm.register(worldClass('mazelike', { volatile: true }));
  const maze = await wm.build('mazelike');
  assert.equal(maze.builtVersion, 1);
  version = 2;
  // A rebuild in flight has thrown the last build away - dispose() reset the version with it - and nothing reads
  // it there: MapOverlay reads builtVersion at apply time, after world:changed, which is after the build.
  let release;
  hold = new Promise((r) => { release = r; });
  const rebuilding = wm.build('mazelike');
  await sleep(0);
  assert.equal(maze.builtVersion, 0, 'a rebuild in flight still carried the version of the build it threw away');
  release();
  assert.equal((await rebuilding).builtVersion, 2, 'the rebuilt world kept the version of the build it threw away');
  assert.equal(await rebuilding, maze, 'a volatile rebuild is the same world object');
  assert.deepEqual(asked, ['mazelike', 'mazelike']);
});

test('a preparation started by WorldPrefetch waits on the provider like any background build, and no longer than the fuse', async () => {
  await quietly(async () => {
    let answer;
    const { wm } = manager({ running: true, provider: () => new Promise((r) => { answer = r; }) });
    wm.register(worldClass('near'));
    const pf = new WorldPrefetch({ portals: gates('near'), player: { position: { x: 0, y: 0, z: 0 } }, prepare: (id) => wm.build(id).then(() => undefined), isVolatile: (id) => wm.isVolatile(id) });
    pf.update();
    assert.equal(pf.isPrepared('near'), true, 'the poller did not start the world in range');
    setTimeout(() => answer({ version: 9 }), 200);
    await pf.started.get('near');
    assert.equal(wm.getWorld('near').builtVersion, 9);

    // A stalled provider holds the gateway for the fuse and no longer (memory: "gateways held until prepared").
    const stalled = manager({ running: true, provider: never });
    stalled.wm.register(worldClass('far'));
    const pf2 = new WorldPrefetch({ portals: gates('far'), player: { position: { x: 0, y: 0, z: 0 } }, prepare: (id) => stalled.wm.build(id).then(() => undefined) });
    const t = performance.now();
    pf2.update();
    await pf2.started.get('far');
    const took = performance.now() - t;
    assert.ok(took >= 1400 && took < 4000, `the preparation took ${took} ms`);
    assert.equal(stalled.wm.getWorld('far').builtVersion, 0);
  });
});

test("a chain of gateways against a hanging provider pays the fuse once a minute: the poller's first preparation asks and waits, the rest inside the minute are held for nothing, the probe asks once, and a preparation started inside the probe's own fuse asks nothing", async () => {
  let clock = 0;
  const asked = [];
  const { wm } = manager({ running: true, provider: (id) => { asked.push(id); return never(); } });
  wm.now = () => clock; // the breaker's clock, owned by the test
  wm.overlayBackgroundMs = 300; // the same fuse, shortened - and no shorter, so a loaded box cannot blur a held build into a fused one
  for (const id of ['first', 'second', 'third', 'beside']) wm.register(worldClass(id));
  const pf = new WorldPrefetch({ portals: gates('first', 'second', 'third'), player: { position: { x: 0, y: 0, z: 0 } }, prepare: (id) => wm.build(id).then(() => undefined) });
  const timed = async (id) => { const t = performance.now(); await pf.started.get(id); return performance.now() - t; };
  await quietly(async () => {
    pf.update(); // nearest first
    assert.equal(pf.isPrepared('first'), true);
    assert.ok((await timed('first')) >= 280, 'the first preparation did not wait on the fuse');
    assert.deepEqual(asked, ['first']); // its hang opened the breaker, at 0 on this clock
    pf.update(); // the next gateway on the chain, inside the minute
    assert.equal(pf.isPrepared('second'), true, 'the poller did not move on once the first was prepared');
    assert.ok((await timed('second')) < 150, 'inside the minute the chain still paid the fuse');
    assert.deepEqual(asked, ['first'], 'inside the minute a preparation asked');
    clock = 60_000;
    pf.update(); // the probe
    const beside = pf.request('beside'); // started inside the probe's fuse - a portal claim, say
    assert.equal(pf.isPrepared('third'), true);
    assert.ok((await timed('beside')) < 150, "a preparation inside the probe's fuse waited on a fuse of its own");
    assert.ok((await timed('third')) >= 280, 'the probe did not wait on the fuse');
    assert.deepEqual(asked, ['first', 'third'], 'the chain asked more than once a minute');
    assert.equal(wm.getWorld('third').builtVersion, 0);
    assert.equal(wm.getWorld('beside').builtVersion, 0);
    await beside;
  });
});

/* ------------------------------------------------------------------ */
/* The real provider on the seam: MapOverlay.lookup                    */
/* ------------------------------------------------------------------ */

/**
 * A fetch that hangs until it is aborted, or - when `answer()` says so -
 * resolves a document for the world asked after `delay` ms. Records the
 * world of every call and the signal each was handed.
 */
function overlayFetch({ version = 5, delay = 0 } = {}) {
  const calls = [];
  const signals = [];
  let hang = true;
  let landed = () => {};
  const fn = (url, init) => new Promise((resolve, reject) => {
    const world = new URL(url, 'http://game').searchParams.get('world');
    calls.push(world);
    signals.push(init.signal);
    init.signal.addEventListener('abort', () => reject(new DOMException('This operation was aborted', 'AbortError')));
    if (hang) return;
    setTimeout(() => {
      resolve({ ok: true, status: 200, json: async () => ({ world, schema: 2, version, entries: [], admin: true }) });
      landed();
    }, delay);
  });
  fn.calls = calls;
  fn.signals = signals;
  fn.answer = (yes = true) => { hang = !yes; };
  fn.landing = () => new Promise((r) => { landed = r; });
  return fn;
}

test('a lookup abandoned at its ceiling is said once per world, not per attempt, and is news again after a document for that world was admitted', async () => {
  const fetchImpl = overlayFetch({ version: 3 });
  const bus = new EventBus();
  const overlay = new MapOverlay({ bus, physics: new Physics(bus), fetch: fetchImpl });
  overlay.lookupAbortMs = 40; // the same ceiling, shortened
  const warned = await quietly(async (said) => {
    assert.equal(await overlay.lookup('lost'), null);
    assert.equal(await overlay.lookup('lost'), null);
    assert.equal(fetchImpl.calls.length, 2, 'the second lookup did not ask again');
    assert.deepEqual(said, ['[map-overlay] lookup for "lost" abandoned after 0.04 s'], `two abandoned lookups of one world: ${said}`);
    fetchImpl.answer();
    assert.equal((await overlay.lookup('lost')).version, 3, 'the server came back and the document was not admitted');
    // An admitted document answers every later lookup of its world from the cache, and in the running game only
    // dispose() empties that - which also forgets what was said. Emptied by hand here, so a FURTHER hang can reach
    // the ceiling and the case proves the reset was the admit's own.
    overlay._cache.delete('lost');
    fetchImpl.answer(false);
    assert.equal(await overlay.lookup('lost'), null);
    assert.equal(said.length, 2, `after a document, a further hang of the same world was not news: ${said}`);
    assert.match(said[1], /^\[map-overlay\] lookup for "lost" abandoned after 0\.04 s$/);
  });
  overlay.dispose();
  assert.equal(warned.length, 2);
  assert.equal(fetchImpl.signals.filter((s) => s.aborted).length, 3, 'an abandoned lookup left its socket open');
});

test('composed: WorldManager over the REAL MapOverlay.lookup - a document that lands after the fuse is cached and closes the breaker, and the next build of that world is answered from the cache: 0 ms, no fetch, builtVersion the document\'s', async () => {
  const fetchImpl = overlayFetch({ version: 5, delay: 600 }); // past the fuse, inside the ceiling
  fetchImpl.answer();
  const landing = fetchImpl.landing();
  const { wm, ctx, bus, physics } = manager({ running: true });
  const overlay = new MapOverlay({ bus, physics, fetch: fetchImpl });
  ctx.overlayProvider = (id) => overlay.lookup(id); // main.js's provider, minus the session gate
  wm.overlayBackgroundMs = 300; // the same fuse, shortened
  wm.register(worldClass('seam', { volatile: true })); // volatile, so a second build of it is a real rebuild through the seam
  wm.register(worldClass('bystander'));
  const warned = await quietly(async () => {
    let t = performance.now();
    const seam = await wm.build('seam');
    const took = performance.now() - t;
    assert.equal(seam.builtVersion, 0, 'the build did not lose its fuse');
    assert.ok(took >= 280 && took < 1500, `the first build took ${took} ms`);
    assert.deepEqual(fetchImpl.calls, ['seam']);
    // The lost fuse opened the breaker: a background build of another world asks nothing and is held for nothing.
    t = performance.now();
    assert.equal((await wm.build('bystander')).builtVersion, 0);
    assert.ok(performance.now() - t < 150, 'an open breaker still waited on the fuse');
    assert.deepEqual(fetchImpl.calls, ['seam'], 'an open breaker asked the overlay');

    await landing; // ~600 ms after the first ask: the fetch the manager walked away from answers
    await sleep(0); // _read -> _admit -> the lookup promise -> the manager's late-document .then
    t = performance.now();
    const again = await wm.build('seam');
    const tookAgain = performance.now() - t;
    assert.equal(again, seam, 'a volatile rebuild is the same world object');
    assert.equal(again.builtVersion, 5, 'the rebuild was not answered with the late document (breaker still open, or nothing cached)');
    assert.ok(tookAgain < 150, `a cached document still cost ${tookAgain} ms`);
    assert.deepEqual(fetchImpl.calls, ['seam'], 'the cached document was fetched again');
  });
  overlay.dispose();
  assert.deepEqual(warned, ['[WorldManager] overlay unavailable for "seam": no answer within 300 ms; building without it']);
});
