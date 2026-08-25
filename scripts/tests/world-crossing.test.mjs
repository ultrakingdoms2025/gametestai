import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { EventBus } from '../../src/core/EventBus.js';
import { Physics } from '../../src/physics/Physics.js';
import { World } from '../../src/worlds/World.js';
import { WorldManager } from '../../src/worlds/WorldManager.js';

/**
 * WHAT A CROSSING MUST STILL BE TRUE OF, AND WHAT IT COSTS.
 *
 * `WorldManager._activate` wipes the collision world and re-registers the
 * arriving world's colliders one at a time. That loop was handed to this branch
 * as "~1,617 ms of collider-rebuild JavaScript" over the station's 26,345
 * colliders, and the fix proposed for it was to retain a built collider set per
 * world instead of rebuilding from nothing.
 *
 * Measured on the production bundle it is 7.5 ms of a 1,274 ms crossing - 0.6%
 * - so the retained set was refused. @see
 * docs/superpowers/specs/2026-08-24-crossing-cost-ledger.md
 *
 * These cases exist because the refusal is the kind that gets revisited. A
 * retained or cached collider set is a perfectly reasonable idea to have again,
 * and the way it goes wrong is not that it is slow: it is that the set goes
 * STALE. A collider that survives a crossing it should not have survived is an
 * invisible wall; one that is dropped is a hole in the floor. This repository
 * has four separate shipped defects where a test proved a thing was BUILT and
 * never that a player could REACH it, so the assertions below are written
 * against the capsule and the query rather than against the array length.
 *
 * They pass on today's rebuild-from-nothing. They are here so that they have to
 * go on passing for whatever replaces it.
 */

/* `_runBuild` yields a frame when a build phase runs long. The worlds here are
 * a few hundred boxes and never reach it, but a shim costs nothing and keeps a
 * slow machine from turning this file into a ReferenceError. */
if (typeof globalThis.requestAnimationFrame !== 'function') {
  globalThis.requestAnimationFrame = (fn) => setTimeout(() => fn(performance.now()), 0);
}

/** A world that is a floor, a wall the player must not walk through, and dressing. */
function makeWorld(id, { wallX, props = 200 }) {
  return class extends World {
    static id = id;
    static displayName = id;

    async build() {
      // Floor.
      this.track(this.physics.addBox(0, -0.5, 0, 60, 0.5, 60));
      // The wall this world is identified by.
      this.track(this.physics.addBox(wallX, 2.5, 0, 0.6, 2.5, 20));
      // Dressing, so the broadphase has real work to do and real cells to fill.
      for (let i = 0; i < props; i++) {
        const a = (i / props) * Math.PI * 2;
        this.track(this.physics.addBox(
          Math.cos(a) * (12 + (i % 17)), 0.6, Math.sin(a) * (12 + (i % 23)),
          0.5, 0.6, 0.5,
        ));
      }
      this.playerSpawn.set(0, 1, 0);
    }
  };
}

/** Walk a capsule from the origin toward +x and report where it ended up. */
function walkEast(physics, metres = 8.2) {
  const pos = new THREE.Vector3(0, 1, 0);
  for (let i = 0; i < 120; i++) {
    pos.x += metres / 60;
    physics.resolveCapsule(pos, 0.35, 1.75);
  }
  return pos.x;
}

function makeManager() {
  const bus = new EventBus();
  const scene = new THREE.Scene();
  const physics = new Physics(bus);
  const manager = new WorldManager({
    scene, engine: { running: false }, physics, bus, materials: {},
  });
  manager.register(makeWorld('alpha', { wallX: 3 }));
  manager.register(makeWorld('beta', { wallX: 40, props: 60 }));
  return { manager, physics, bus, scene };
}

/* ------------------------------------------------------------------ */
/* The crossing is complete                                            */
/* ------------------------------------------------------------------ */

test('re-entering a world registers every one of its colliders, exactly once', async () => {
  const { manager, physics } = makeManager();

  await manager.activate('alpha');
  const alpha = manager.getWorld('alpha');
  const first = new Set(physics.colliders);
  assert.equal(first.size, alpha.colliders.length,
    'the first entry did not register the world it was given');

  await manager.activate('beta');
  await manager.activate('alpha');

  const again = new Set(physics.colliders);
  assert.equal(physics.colliders.length, again.size,
    'a collider was registered twice - the second copy answers every query the first does');
  assert.deepEqual([...again].sort(), [...first].sort(),
    're-entry did not restore exactly the set the world authored');
});

test('the departed world is gone, not merely hidden', async () => {
  const { manager, physics } = makeManager();

  await manager.activate('alpha');
  const alpha = manager.getWorld('alpha');
  await manager.activate('beta');

  const live = new Set(physics.colliders);
  for (const c of alpha.colliders) {
    assert.ok(!live.has(c), 'a collider from the world we LEFT is still solid - an invisible wall');
  }
});

test('a broadphase cell never lists the same collider twice after a crossing', async () => {
  const { manager, physics } = makeManager();

  await manager.activate('alpha');
  await manager.activate('beta');
  await manager.activate('alpha');

  for (const [key, list] of physics._grid) {
    assert.equal(new Set(list).size, list.length,
      `broadphase cell ${key} holds a duplicate; every query through it does double the work`);
  }
});

/* ------------------------------------------------------------------ */
/* ... and the player can still not walk through it                    */
/* ------------------------------------------------------------------ */

test('a wall that stopped the player before the crossing stops them after it', async () => {
  const { manager, physics } = makeManager();

  await manager.activate('alpha');
  const before = walkEast(physics);
  assert.ok(before < 2.5, `alpha's wall did not stop the capsule on first entry: x=${before}`);

  await manager.activate('beta');
  const inBeta = walkEast(physics);
  assert.ok(inBeta > 5, `alpha's wall is still solid in beta: x=${inBeta}`);

  await manager.activate('alpha');
  const after = walkEast(physics);
  assert.ok(after < 2.5, `alpha's wall stopped being solid on RE-entry: x=${after}`);
});

test('the floor is still under the player on re-entry', async () => {
  const { manager, physics } = makeManager();

  await manager.activate('alpha');
  const first = physics.groundHeight(0, 0, 5, 20);
  await manager.activate('beta');
  await manager.activate('alpha');
  const again = physics.groundHeight(0, 0, 5, 20);

  assert.notEqual(first, null, 'no floor on first entry');
  assert.equal(again, first, 'the floor moved, or went missing, on re-entry');
});

/* ------------------------------------------------------------------ */
/* The instrument                                                      */
/* ------------------------------------------------------------------ */

test('a crossing records what each of its steps cost', async () => {
  const { manager, physics } = makeManager();

  await manager.activate('alpha');
  await manager.activate('beta');

  const cost = manager.activationCost;
  assert.ok(cost, 'no activationCost recorded - the production-bundle instrument is gone');
  assert.equal(cost.world, 'beta');
  assert.equal(cost.from, 'alpha');
  for (const step of ['changing', 'teardown', 'physicsClear', 'physicsAdd',
    'sceneIn', 'portals', 'arrival', 'npcs', 'changed', 'total']) {
    assert.equal(typeof cost[step], 'number', `activationCost.${step} is missing`);
  }
  assert.equal(cost.colliders, manager.getWorld('beta').colliders.length);
  assert.equal(cost.gridWrites, physics.gridWrites);
});

test('gridWrites counts one write per collider per broadphase cell it occupies', async () => {
  const p = new Physics(null);
  assert.equal(p.gridWrites, 0);

  // cellSize is 12; a half-metre box at the origin lands in exactly one cell.
  p.addBox(6, 0, 6, 0.5, 0.5, 0.5);
  assert.equal(p.gridWrites, 1);

  let entries = 0;
  for (const list of p._grid.values()) entries += list.length;
  assert.equal(entries, p.gridWrites, 'the counter and the grid disagree');

  /* Exactly reproducible, which is the whole reason it exists: wall clock on
   * the machine this was measured on reported identical work as 700 ms and as
   * 14,700 ms, so a timing that moves is not on its own evidence that the work
   * moved. */
  const q = new Physics(null);
  q.addBox(6, 0, 6, 0.5, 0.5, 0.5);
  assert.equal(q.gridWrites, p.gridWrites);
});

test('clearing and re-adding restores the identical broadphase', async () => {
  const p = new Physics(null);
  const boxes = [];
  for (let i = 0; i < 300; i++) {
    boxes.push(p.addBox((i % 20) * 3 - 30, 1, Math.floor(i / 20) * 3 - 20, 0.8, 1, 0.8));
  }
  const writes = p.gridWrites;
  const cells = p._grid.size;

  p.clear();
  assert.equal(p._grid.size, 0);
  assert.equal(p.colliders.length, 0);

  for (const b of boxes) p.add(b);
  assert.equal(p.gridWrites, writes * 2, 'the re-add did not do the same work');
  assert.equal(p._grid.size, cells, 'the rebuilt broadphase has a different shape');
});
