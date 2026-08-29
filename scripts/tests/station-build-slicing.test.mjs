/**
 * The station's long build phases must hand the frame back, and slicing them
 * must not change one collider.
 *
 * ── The defect ─────────────────────────────────────────────────────────────
 * `scheduleBackgroundBuilds` runs after `engine.start()`, so every world built
 * there is generated inside gameplay frames. `StationWorld.build` yields a
 * frame between phases and never inside one, and four of its phases are not
 * frame-sized. Measured on a cold boot with per-phase timing:
 *
 *     _settleDressing    3,175 ms      _buildOuterRing      327 ms
 *     _buildTextures     1,405 ms      _buildPlazaCentre    146 ms
 *     _solidifyStructure   982 ms      _solidifyProps        69 ms
 *
 * Each of the top three is a single frame of that length dropped on the player
 * whenever the station is somebody's background world. The fix is that those
 * phases take a `breathe` and call it as they go, and that
 * `WorldManager._runBuild` decides what a `breathe` does.
 *
 * ── Why these are the assertions ───────────────────────────────────────────
 * Two things can silently undo it and neither would look wrong in review.
 *
 *   1. Someone drops the yield out of a pass, or restores a `traverse`
 *      callback around a loop that used to be able to await inside it.
 *      `traverse` cannot await, so that edit is not a syntax error - it is a
 *      pass that quietly stops slicing.
 *   2. Someone makes the yield unconditional. The entry world builds BEFORE
 *      `engine.start()`, behind the loading screen, where a long frame costs
 *      nothing and a yield costs a whole rAF: doing it there would add seconds
 *      to the boot to protect frames that do not exist.
 *
 * And one thing can break the world rather than the frame rate: `_solidifyProps`
 * BUILDS COLLIDERS, and it reads the collision world it is writing, so a prop
 * resting on another prop is solid ground or thin air depending on what has
 * already been through the loop. If pausing that pass could change what it
 * sees, slicing it would be a placement bug rather than a perf fix. The last
 * test drives the real function twice - once straight through, once yielding
 * on every single call - and demands the same colliders in the same order.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as THREE from 'three';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

/* `WorldManager` reaches for rAF the moment a build yields, and counting those
 * calls is how the tests below tell a real frame handback from a resolved
 * promise. Measuring elapsed wall clock instead is the obvious alternative and
 * a flaky one - a loaded machine takes longer than a frame to resolve an
 * already-resolved promise, and the test then reports a yield that never
 * happened. */
const baseRaf = globalThis.requestAnimationFrame ?? ((cb) => setTimeout(() => cb(Date.now()), 0));
let rafCalls = 0;
globalThis.requestAnimationFrame = (cb) => { rafCalls++; return baseRaf(cb); };

const { WorldManager } = await import('../../src/worlds/WorldManager.js');
const { World } = await import('../../src/worlds/World.js');
const { StationWorld } = await import('../../src/worlds/StationWorld.js');

/* ------------------------------------------------------------------ */
/* 1. The yield exists, and knows which side of the gate it is on      */
/* ------------------------------------------------------------------ */

/**
 * A world that does nothing but report what its slicer did.
 *
 * `calls` is what `report.slice` returned; `yielded` counts the ones that
 * actually gave a frame back, which is the only thing that costs wall clock.
 */
function probeWorld(id, work) {
  return class Probe extends World {
    static id = id;
    static displayName = id;
    async build(onProgress) {
      await work(onProgress);
    }
  };
}

function managerFor(WorldClass, { running }) {
  const bus = { emit() {}, on() {}, off() {} };
  const manager = new WorldManager({
    scene: new THREE.Scene(),
    engine: { running },
    physics: { colliders: [], characters: new Set(), add() {}, clear() {} },
    bus,
    materials: {},
  });
  manager.register(WorldClass);
  return manager;
}

test('the build relay offers a mid-phase yield at all', async () => {
  let slice = null;
  const manager = managerFor(
    probeWorld('probe-exists', async (onProgress) => { slice = onProgress?.slice; }),
    { running: true },
  );
  await manager.build('probe-exists');
  assert.equal(
    typeof slice, 'function',
    'the progress relay handed to a world has no `slice`. Without it the only '
    + 'yield a world can reach is the one between phases, and a phase that is '
    + 'seconds long is seconds of frozen gameplay however often the phases '
    + 'around it yield',
  );
});

test('a background build yields; the same phase behind the loading gate does not', async () => {
  /* Both runs burn the same wall clock in the same shape - a long pass that
   * asks for a yield as it goes. The only difference is whether the engine is
   * running, which is the whole of the entry-world-vs-background distinction. */
  const busy = async (onProgress) => {
    let yields = 0;
    for (let i = 0; i < 12; i++) {
      const t = performance.now();
      while (performance.now() - t < 6) { /* six milliseconds of "work" */ }
      // Only this call can request a frame; nothing else is running.
      const before = rafCalls;
      await onProgress.slice(i / 12, 'slicing');
      if (rafCalls > before) yields++;
    }
    return yields;
  };

  let backgroundYields = 0;
  const bg = managerFor(
    probeWorld('probe-bg', async (p) => { backgroundYields = await busy(p); }),
    { running: true },
  );
  await bg.build('probe-bg');

  let gatedYields = 0;
  const gated = managerFor(
    probeWorld('probe-gated', async (p) => { gatedYields = await busy(p); }),
    { running: false },
  );
  await gated.build('probe-gated');

  assert.ok(
    backgroundYields > 0,
    'a build running after engine.start() never gave a frame back despite '
    + 'asking to. That is the multi-second gameplay stall this exists to remove',
  );
  assert.equal(
    gatedYields, 0,
    `a build running BEFORE engine.start() gave the frame back ${gatedYields} `
    + 'times. There is no frame on screen to protect behind the loading '
    + 'screen, and a rAF round trip is ~8 ms - slicing the entry build adds '
    + 'seconds to the boot and buys nothing anybody can see',
  );
});

/* ------------------------------------------------------------------ */
/* 2. The long phases still ask                                        */
/* ------------------------------------------------------------------ */

test('every phase measured over 100 ms takes a breathe and calls it', async () => {
  const src = (await readFile(path.join(root, 'src/worlds/StationWorld.js'), 'utf8'))
    .replace(/\r\n/g, '\n');

  /** A method body, to the start of the next method at the same indent. */
  const body = (signature) => {
    const from = src.indexOf(signature);
    assert.notEqual(from, -1, `${signature} is gone - the slicing went with it`);
    const rest = src.slice(from + signature.length);
    const next = rest.search(/\n {2}(?:async )?[_a-zA-Z]\w*\(/);
    return next === -1 ? rest : rest.slice(0, next);
  };

  for (const signature of [
    'async _buildTextures(breathe = noBreath) {',
    'async _settleScatter(groups, breathe = noBreath) {',
    'async _solidifyProps(breathe = noBreath) {',
    'async _solidifyStructure(breathe = noBreath) {',
    'async _collisionSoup(',
    /* Widened when collider ownership landed: the drop compacts an owner
     * array in step with the triangles, so a survivor keeps the owner its
     * source had and `_solidifyStructure` can chunk per owner. */
    'async _dropEnclosedTriangles(soup, tol = 0.03, breathe = noBreath, ownerIn = null, ownerOut = null) {',
  ]) {
    assert.match(
      body(signature), /await breathe\(\)/,
      `${signature.trim()} takes a yield and never calls it. Measured, these are `
      + 'the passes that are not frame-sized; a pass that holds the argument '
      + 'and never uses it is the whole defect back with the signature intact',
    );
  }

  /* Both sweeps used to do their work inside a `traverse` callback, which
   * cannot await. They now collect first and walk the array, and that is the
   * half of the change that is easy to undo by accident: folding the work back
   * into the callback is tidier-looking code that silently stops slicing. */
  for (const [signature, loop] of [
    ['async _solidifyProps(breathe = noBreath) {', /for \(const o of meshes\)/],
    ['async _collisionSoup(', /for \(const o of meshes\)/],
    ['async _settleScatter(groups, breathe = noBreath) {', /for \(const o of props\)/],
  ]) {
    assert.match(
      body(signature), loop,
      `${signature.trim()} no longer walks a collected array. If its loop is back `
      + 'inside a traverse callback the pass cannot yield from inside itself, '
      + 'however many `breathe` calls are written in it - a traverse callback '
      + 'cannot await',
    );
  }

  assert.match(
    body('async build(onProgress) {'), /await fn\.call\(this, breathe\(f, label\)\)/,
    'build() no longer awaits its phases with a breathe. An un-awaited async '
    + 'phase runs detached from the build, which is worse than not slicing it: '
    + 'the world would be reported ready while it was still being made',
  );
});

/* ------------------------------------------------------------------ */
/* 3. Slicing the collider sweep cannot change a collider              */
/* ------------------------------------------------------------------ */

/**
 * A collision world just real enough for `_solidifyProps`.
 *
 * `groundHeight` answers from a floor at y=0 plus the top of every box already
 * registered, which is the property the sweep depends on and reasons about:
 * what it can see is what it has already written.
 */
function stubPhysics() {
  const boxes = [];
  return {
    boxes,
    colliders: boxes,
    addRotatedBox(centre, half, yaw) {
      // The caller reuses two module-level vectors for every call, so the
      // values have to be copied out rather than referenced.
      const box = {
        x: centre.x, y: centre.y, z: centre.z,
        hx: half.x, hy: half.y, hz: half.z, yaw,
      };
      boxes.push(box);
      return box;
    },
    groundHeight(x, z, startY, maxDrop) {
      let best = startY >= 0 && startY - maxDrop <= 0 ? 0 : null;   // the deck
      for (const b of boxes) {
        if (Math.abs(x - b.x) > b.hx || Math.abs(z - b.z) > b.hz) continue;
        const top = b.y + b.hy;
        if (top > startY || top < startY - maxDrop) continue;
        if (best === null || top > best) best = top;
      }
      return best;
    },
  };
}

/** One instanced prop family, `at` giving each instance's centre. */
function propMesh(name, size, at) {
  const geo = new THREE.BoxGeometry(size.x, size.y, size.z);
  const mesh = new THREE.InstancedMesh(geo, new THREE.MeshBasicMaterial(), at.length);
  mesh.name = name;
  const m = new THREE.Matrix4();
  at.forEach((p, i) => mesh.setMatrixAt(i, m.makeTranslation(p.x, p.y, p.z)));
  return mesh;
}

/**
 * The fixture, ordered so the sweep has to use its second pass.
 *
 * `perched` is traversed BEFORE the crate holding it up, so on the first pass
 * it finds nothing under it and is parked; the fixed-point rounds afterwards
 * are what stand it up, once the crate below has a collider of its own.
 */
function stationWithProps() {
  const world = Object.create(StationWorld.prototype);
  world.physics = stubPhysics();
  world.colliders = [];
  world.group = new THREE.Group();

  world.group.add(
    propMesh('perched', { x: 1, y: 1, z: 1 }, [{ x: 0, y: 1.5, z: 0 }]),
    propMesh('crates', { x: 1, y: 1, z: 1 }, [
      { x: 0, y: 0.5, z: 0 }, { x: 4, y: 0.5, z: 0 }, { x: 8, y: 0.5, z: 0 },
    ]),
    // Under the 0.4 m bar on one axis: trim, and never collided. It must also
    // never reach the yield, which sits past the cheap rejects on purpose.
    propMesh('trim', { x: 2, y: 0.1, z: 2 }, [{ x: 12, y: 0.05, z: 0 }]),
  );
  world.group.updateMatrixWorld(true);
  return world;
}

test('the prop sweep collides the same props whether or not it yields', async () => {
  const straight = stationWithProps();
  let asked = 0;
  await straight._solidifyProps(() => { asked++; return Promise.resolve(); });

  /* The adversarial run: every single call really does go to the back of the
   * task queue, so any dependence on "nothing happened in between" shows up. */
  const sliced = stationWithProps();
  let yields = 0;
  await sliced._solidifyProps(() => {
    yields++;
    return new Promise((r) => setTimeout(r, 0));
  });

  assert.ok(
    asked > 0,
    '_solidifyProps never asked for a yield. It is the pass that grows with the '
    + 'prop count, and it registers a collider per prop while reading the same '
    + 'collision world back',
  );
  assert.equal(yields, asked, 'the two runs did not take the same path');

  assert.deepEqual(
    sliced.physics.boxes, straight.physics.boxes,
    'yielding changed which props were collided, or where. The sweep reads the '
    + 'collision world it is writing, so its answers depend on the ORDER it '
    + 'visits props in - pausing it must not be the same as reordering it',
  );
  assert.deepEqual(
    sliced.colliders, straight.colliders,
    'the tracked collider list diverged from the physics world. WorldManager '
    + '_activate re-registers world.colliders wholesale, so anything in one and '
    + 'not the other becomes an invisible wall or a hole in the floor',
  );

  // And the fixture really did exercise both halves, or the test above is
  // comparing two runs of nothing.
  assert.equal(straight.physics.boxes.length, 4, 'expected three crates and the perched prop');
  assert.deepEqual(
    straight.physics.boxes.map((b) => `${b.x},${b.y}`),
    ['0,0.5', '4,0.5', '8,0.5', '0,1.5'],
    'the perched prop was not stood up LAST, by the fixed-point rounds. Without '
    + 'that this fixture never reaches the second half of the sweep',
  );
  /* Four candidates in the sweep, plus the perched prop asked again by the
   * fixed-point rounds. `trim` is not in the count and must not be: the yield
   * sits past the cheap size rejects, which cost nothing and which most of a
   * real station's instances fail. */
  assert.equal(
    asked, 5,
    'the sweep is asking for a yield on a different set of props than the four '
    + 'candidates plus the one re-tried round. Either the trim is reaching the '
    + 'yield - it sits past the cheap size rejects on purpose - or the '
    + 'fixed-point rounds have stopped yielding, and those are unbounded: they '
    + 'run until nothing moves',
  );
});
