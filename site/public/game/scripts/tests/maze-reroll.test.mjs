/**
 * What must not survive a re-roll.
 *
 * The maze is `volatile`: `WorldManager.build()` disposes and regenerates it on
 * every entry, and that is the whole premise of the world - a layout that
 * survived the last visit is a layout the player could learn. But the world
 * INSTANCE is reused across those rolls, so every field on it is a candidate
 * for outliving the maze it describes.
 *
 * That is not hypothetical. The owner reported the Ctrl+M solution being
 * identical on every entry, and it was: `solutionPath` caches against the
 * player's CELL, which is the correct key while one maze is standing, but
 * `buildDistrictGraph` fixes the entrance at the centre of district (10,0) - so
 * the cell a player occupies when they press Ctrl+M on arrival is the same
 * every run, the cache hit was guaranteed, and the route drawn was the previous
 * maze's, through the current maze's hedges. Four builds, four distinct seeds,
 * one solution: the same 3,714 steps every time.
 *
 * These tests drive the real `WorldManager` rather than calling
 * `MazeWorld.build()` directly, because the re-roll does not live in the world
 * - it lives in the manager's volatile branch, and a test that skipped it would
 * have passed throughout the period the bug was live.
 */

/* `WorldManager` yields a frame between build phases so the loading bar can
 * paint. Under Node there is no compositor, so a macrotask is the honest
 * equivalent: it preserves the await points without reordering them. */
globalThis.requestAnimationFrame ??= (fn) => setTimeout(() => fn(Date.now()), 0);

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { WorldManager } from '../../src/worlds/WorldManager.js';
import { MazeWorld } from '../../src/worlds/MazeWorld.js';
import { Physics } from '../../src/physics/Physics.js';
import { EventBus } from '../../src/core/EventBus.js';

/** A manager with the maze registered, and nothing else it does not need. */
function manager() {
  const wm = new WorldManager({
    scene: { add() {}, remove() {} },
    engine: null,
    physics: new Physics(null),
    bus: new EventBus(),
    materials: null,
  });
  wm.register(MazeWorld);
  return wm;
}

/**
 * `build()` N times through the manager, as re-entering through the portal
 * does, collecting whatever the caller wants from each roll.
 *
 * `_active` is deliberately left null: the manager only re-rolls a volatile
 * world when it is NOT the live one, which is exactly the state a player is in
 * while standing in the station about to step through.
 */
async function rolls(n, pick) {
  const wm = manager();
  const out = [];
  for (let i = 0; i < n; i++) out.push(pick(await wm.build(MazeWorld.id)));
  return out;
}

test('the maze is registered volatile - everything below is vacuous otherwise', () => {
  assert.equal(MazeWorld.volatile, true,
    'MazeWorld lost `static volatile = true`, so WorldManager will serve one cached maze forever');
  assert.equal(manager().isVolatile(MazeWorld.id), true,
    'the manager does not agree the maze is volatile - check how register() stores the class');
});

test('every entry re-rolls the seed', async () => {
  const seeds = await rolls(4, (w) => w.seed);
  assert.equal(new Set(seeds).size, 4, `four entries produced seeds ${seeds.join(', ')}`);
});

test('THE STALE-ROUTE GATE: the Ctrl+M solution belongs to the maze on screen', async () => {
  /* Asked from `playerSpawn`, not from an arbitrary cell, because the spawn is
   * the one position guaranteed to repeat across rolls - and therefore the one
   * that made the cache lie. A test that sampled a random cell would have
   * missed this bug entirely. */
  const routes = await rolls(4, (w) => JSON.stringify(w.solutionPath(w.playerSpawn)));
  assert.equal(new Set(routes).size, 4,
    'the solution repeated across re-rolls - a route cached from a maze that no longer exists');
});

test('a re-rolled solution is a route through the CURRENT maze, not merely a different one', async () => {
  /* Distinctness alone would pass if the cache were keyed on anything that
   * merely changes, so this checks the route is actually walkable in the maze
   * it was asked of: consecutive steps must be neighbouring cells on one level,
   * or a level change at the same footprint (a connector). */
  const wm = manager();
  for (let roll = 0; roll < 3; roll++) {
    const w = await wm.build(MazeWorld.id);
    const route = w.solutionPath(w.playerSpawn);
    assert.ok(route.length > 1, `roll ${roll}: solution has ${route.length} steps`);
    for (let i = 1; i < route.length; i++) {
      const a = route[i - 1], b = route[i];
      const dx = Math.abs(a.x - b.x), dz = Math.abs(a.z - b.z);
      const sameColumn = dx < 1e-6 && dz < 1e-6;
      const stepped = (dx <= 6.001 && dz < 1e-6) || (dz <= 6.001 && dx < 1e-6);
      assert.ok(
        (a.level === b.level && stepped) || (a.level !== b.level && sameColumn),
        `roll ${roll} step ${i}: ${JSON.stringify(a)} -> ${JSON.stringify(b)} is neither a `
        + "move to a neighbouring cell nor a level change in place - the route is not this maze's",
      );
    }
  }
});

test('the per-level caches the map reads are dropped too', async () => {
  /* Siblings of the same bug class. `_connectorsByLevel` and `_markersLevel`
   * are both derived from `cells` and both already reset in build() - this pins
   * that, so a future edit which moves one of them out of build() fails here
   * rather than shipping another map of somewhere else. */
  const wm = manager();
  const a = await wm.build(MazeWorld.id);
  a.mapMarkers?.(0);
  const before = a.seed;
  const b = await wm.build(MazeWorld.id);
  assert.notEqual(b.seed, before, 'precondition: the second build did not re-roll');
  assert.equal(b._markersLevel, -1,
    "_markersLevel survived a re-roll, so mapMarkers() will serve the previous maze's markers");
  assert.equal(b._connectorsByLevel, null,
    '_connectorsByLevel survived a re-roll - stairs and lifts drawn where the last maze had them');
});
