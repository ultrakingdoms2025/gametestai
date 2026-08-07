import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  MAZE, DIR, generateTopology, cellIndex, cellCoords, isOpen, carveEntranceCorridor,
} from '../../src/worlds/maze/MazeTopology.js';
import {
  openDirCount, isDeadEnd, findDeadEnds, pickDeadEndTokens, pickWandererSites, walkPatrol,
} from '../../src/worlds/maze/MazePopulate.js';
import {
  forecourtColliders, cellToWorld,
  FORECOURT_HALF_WIDTH, FORECOURT_NORTH_Z, FORECOURT_PORTAL_Z,
} from '../../src/worlds/maze/MazeColliders.js';
import { Physics } from '../../src/physics/Physics.js';
import { EventBus } from '../../src/core/EventBus.js';
import { MazeWorld } from '../../src/worlds/MazeWorld.js';

/*
 * Coverage for "npcs-and-collectibles": the keeper, the eight lost wanderers
 * and the ~40 dead-end tokens the maze had none of before this work.
 *
 * Two tiers, matching the rest of this directory:
 *
 *  - Pure-topology tests run `MazePopulate.js` directly across many seeds.
 *    This is where the real risk lives (a re-rolled maze putting a token
 *    somewhere it should not be), so it is what gets the seed sweep.
 *  - A handful of full `MazeWorld.build()` integration tests confirm the
 *    world actually wires those pure functions up correctly end to end -
 *    fewer of them because a full build registers ~160k colliders, but a
 *    build only takes a few hundred ms (see the timing note below), so
 *    running several is still cheap.
 */

const SEEDS = 40;

/** Which passage bit, if any, connects two Manhattan-adjacent cells. */
function stepDirBetween(fromIdx, toIdx) {
  const a = cellCoords(fromIdx);
  const b = cellCoords(toIdx);
  const dx = b.x - a.x;
  const dz = b.z - a.z;
  if (Math.abs(dx) + Math.abs(dz) !== 1) return null;
  if (dx === 1) return DIR.E;
  if (dx === -1) return DIR.W;
  if (dz === 1) return DIR.S;
  return DIR.N;
}

/* -------------------------------------------------------------------- */
/* Pure topology: dead-end tokens                                        */
/* -------------------------------------------------------------------- */

test('every token sits in a cell that is genuinely a dead end, across many seeds', () => {
  for (let seed = 0; seed < SEEDS; seed++) {
    const t = generateTopology(seed, { levels: 1 });
    const e = cellCoords(t.entranceCell);
    carveEntranceCorridor(t.cells, e);
    const exclude = new Set([t.entranceCell, t.centreCell]);

    const tokens = pickDeadEndTokens(t.cells, 0, seed, 40, exclude);
    assert.ok(tokens.length > 0, `seed ${seed}: no tokens picked at all`);

    for (const idx of tokens) {
      assert.equal(
        openDirCount(t.cells, idx), 1,
        `seed ${seed}: token at cell ${idx} has ${openDirCount(t.cells, idx)} open passages, not 1`,
      );
      assert.ok(isDeadEnd(t.cells, idx), `seed ${seed}: token at cell ${idx} is not a dead end`);
    }
  }
});

test('no two tokens ever share a cell, across many seeds', () => {
  for (let seed = 0; seed < SEEDS; seed++) {
    const t = generateTopology(seed, { levels: 1 });
    const e = cellCoords(t.entranceCell);
    carveEntranceCorridor(t.cells, e);
    const exclude = new Set([t.entranceCell, t.centreCell]);

    const tokens = pickDeadEndTokens(t.cells, 0, seed, 40, exclude);
    const unique = new Set(tokens);
    assert.equal(unique.size, tokens.length, `seed ${seed}: ${tokens.length - unique.size} duplicate token cell(s)`);
  }
});

test('tokens are spread across the grid, not clustered near the entrance', () => {
  for (let seed = 0; seed < 10; seed++) {
    const t = generateTopology(seed, { levels: 1 });
    const e = cellCoords(t.entranceCell);
    carveEntranceCorridor(t.cells, e);
    const exclude = new Set([t.entranceCell, t.centreCell]);

    const tokens = pickDeadEndTokens(t.cells, 0, seed, 40, exclude);
    const districts = new Set();
    for (const idx of tokens) {
      const c = cellCoords(idx);
      districts.add(`${Math.floor(c.x / MAZE.DISTRICT)},${Math.floor(c.z / MAZE.DISTRICT)}`);
    }
    // 40 tokens bunched into a handful of districts would defeat the point -
    // dead ends worth finding across the whole level, not a pile by the door.
    assert.ok(
      districts.size >= Math.min(15, tokens.length),
      `seed ${seed}: ${tokens.length} tokens landed in only ${districts.size} distinct districts`,
    );
  }
});

test('findDeadEnds agrees with a brute-force scan', () => {
  const t = generateTopology(9, { levels: 1 });
  const found = findDeadEnds(t.cells, 0);
  let bruteForce = 0;
  for (let i = 0; i < MAZE.LEVEL_CELLS; i++) {
    if (openDirCount(t.cells, i) === 1) bruteForce++;
  }
  assert.equal(found.length, bruteForce);
});

/* -------------------------------------------------------------------- */
/* Pure topology: wanderer sites and patrol routes                       */
/* -------------------------------------------------------------------- */

test('every wanderer site sits in an open (reachable) cell, across many seeds', () => {
  for (let seed = 0; seed < SEEDS; seed++) {
    const t = generateTopology(seed, { levels: 1 });
    const e = cellCoords(t.entranceCell);
    carveEntranceCorridor(t.cells, e);
    const exclude = new Set([t.entranceCell, t.centreCell]);

    const sites = pickWandererSites(t.cells, 0, seed, 8, exclude);
    assert.equal(sites.length, 8, `seed ${seed}: expected exactly 8 wanderer sites, got ${sites.length}`);
    for (const idx of sites) {
      assert.ok(openDirCount(t.cells, idx) > 0, `seed ${seed}: wanderer site ${idx} has no open passage at all`);
      assert.ok(!exclude.has(idx), `seed ${seed}: wanderer site landed on an excluded cell`);
    }
  }
});

test('wanderer sites are spread widely, not clustered in one corner', () => {
  for (let seed = 0; seed < 10; seed++) {
    const t = generateTopology(seed, { levels: 1 });
    const e = cellCoords(t.entranceCell);
    carveEntranceCorridor(t.cells, e);
    const exclude = new Set([t.entranceCell, t.centreCell]);
    const sites = pickWandererSites(t.cells, 0, seed, 8, exclude).map((idx) => cellToWorld(cellCoords(idx).x, cellCoords(idx).z, 0));

    let minPairwise = Infinity;
    for (let i = 0; i < sites.length; i++) {
      for (let j = i + 1; j < sites.length; j++) {
        const d = Math.hypot(sites[i].x - sites[j].x, sites[i].z - sites[j].z);
        minPairwise = Math.min(minPairwise, d);
      }
    }
    // A 2.4km level split into a 3x3 region grid puts region centres roughly
    // 800m apart; even the two closest wanderers (diagonal neighbours in the
    // shuffled region order can still be adjacent regions) should clear 100m.
    assert.ok(minPairwise > 100, `seed ${seed}: closest pair of wanderers is only ${minPairwise.toFixed(1)}m apart`);
  }
});

test('walkPatrol only ever steps through an OPEN passage, across many seeds and start points', () => {
  for (let seed = 0; seed < SEEDS; seed++) {
    const t = generateTopology(seed, { levels: 1 });
    const e = cellCoords(t.entranceCell);
    carveEntranceCorridor(t.cells, e);
    const exclude = new Set([t.entranceCell, t.centreCell]);
    const sites = pickWandererSites(t.cells, 0, seed, 8, exclude);

    for (let i = 0; i < sites.length; i++) {
      const route = walkPatrol(t.cells, 0, sites[i], 4, seed * 1000 + i);
      assert.ok(route.length >= 1, `seed ${seed}: patrol route ${i} is empty`);
      assert.equal(route[0], sites[i], `seed ${seed}: patrol route ${i} does not start at its site`);

      for (let k = 1; k < route.length; k++) {
        const from = route[k - 1];
        const to = route[k];
        const dir = stepDirBetween(from, to);
        assert.ok(dir !== null, `seed ${seed}: patrol ${i} step ${k} is not between Manhattan-adjacent cells`);
        assert.ok(
          isOpen(t.cells, from, dir),
          `seed ${seed}: patrol ${i} step ${k} crosses a closed passage (cell ${from} -> ${to})`,
        );
      }
    }
  }
});

/* -------------------------------------------------------------------- */
/* Full MazeWorld.build() integration                                    */
/* -------------------------------------------------------------------- */

/** A fresh, headless MazeWorld - no DOM, no renderer, matching the pattern
 * `Physics` and `EventBus` already prove out for this test tier. */
function buildMazeWorld() {
  const world = new MazeWorld({
    scene: { add() {} },
    engine: null,
    physics: new Physics(null),
    bus: new EventBus(),
    materials: null,
  });
  return world.build().then(() => world);
}

/** Recompute the collider count the way MazeWorld.build() does, directly
 * from the built world's own state, so this is a real comparison and not a
 * restatement of the number MazeWorld happened to produce.
 *
 * Phase 2a streams districts rather than building all 400 up front (see
 * MazeChunks), so "the maze geometry itself" is now the forecourt (authored,
 * always resident) plus whichever districts are currently resident in
 * `world.chunks` - not the full grid. */
function expectedColliderCount(world) {
  let n = world.chunks.colliderCount();
  const e = cellCoords(world.entranceCell);
  const ew = cellToWorld(e.x, e.z, e.level);
  n += forecourtColliders(ew.x, e.level).length;
  return n;
}

test('MazeWorld is constructible and buildable headlessly, with one keeper and eight wanderers', async () => {
  const world = await buildMazeWorld();
  assert.equal(world.npcSpawns.length, 9, `expected 1 keeper + 8 wanderers, got ${world.npcSpawns.length}`);
  const keeper = world.npcSpawns.find((s) => s.role === 'lorekeeper');
  assert.ok(keeper, 'no keeper (role: lorekeeper) among npcSpawns');
  const wanderers = world.npcSpawns.filter((s) => s !== keeper);
  assert.equal(wanderers.length, 8);
  for (const w of wanderers) {
    assert.ok(Array.isArray(w.patrol) && w.patrol.length >= 1, `${w.name} has no patrol route`);
    assert.equal(w.type, 'friendly');
  }
});

test('the keeper stands in the forecourt, clear of the portal plinth', async () => {
  const world = await buildMazeWorld();
  const keeper = world.npcSpawns.find((s) => s.role === 'lorekeeper');
  assert.ok(keeper);

  const e = cellCoords(world.entranceCell);
  const ew = cellToWorld(e.x, e.z, e.level);
  // Inside the forecourt walls.
  assert.ok(Math.abs(keeper.position.x - ew.x) < FORECOURT_HALF_WIDTH, 'keeper is outside the forecourt side walls');
  assert.ok(keeper.position.z > FORECOURT_NORTH_Z && keeper.position.z < 0, 'keeper is outside the forecourt depth');
  // Clear of the plinth - its widest reach (body + approach steps) is ~4.6m.
  const distToPortal = Math.hypot(keeper.position.x - ew.x, keeper.position.z - FORECOURT_PORTAL_Z);
  assert.ok(distToPortal > 4.6, `keeper is only ${distToPortal.toFixed(2)}m from the portal plinth`);
});

test('every NPC spawn and every patrol point sits in an open cell, connected by OPEN passages', async () => {
  for (let i = 0; i < 5; i++) {
    const world = await buildMazeWorld();
    for (const spec of world.npcSpawns) {
      if (spec.role === 'lorekeeper') continue; // the keeper stands in hand-authored forecourt geometry, not the topology
      const route = [spec.position, ...(spec.patrol ?? [])];
      for (const p of route) {
        const cx = Math.round(p.x / MAZE.CELL);
        const cz = Math.round(p.z / MAZE.CELL);
        const idx = cellIndex(cx, cz, 0);
        assert.ok(openDirCount(world.cells, idx) > 0, `${spec.name} has a route point in a sealed cell (${cx},${cz})`);
      }
      if (spec.patrol && spec.patrol.length > 1) {
        for (let k = 1; k < spec.patrol.length; k++) {
          const fromC = spec.patrol[k - 1];
          const toC = spec.patrol[k];
          const fromIdx = cellIndex(Math.round(fromC.x / MAZE.CELL), Math.round(fromC.z / MAZE.CELL), 0);
          const toIdx = cellIndex(Math.round(toC.x / MAZE.CELL), Math.round(toC.z / MAZE.CELL), 0);
          const dir = stepDirBetween(fromIdx, toIdx);
          assert.ok(dir !== null, `${spec.name}'s patrol step ${k} is not between adjacent cells`);
          assert.ok(isOpen(world.cells, fromIdx, dir), `${spec.name}'s patrol step ${k} crosses a closed passage`);
        }
      }
    }
  }
});

test('every token is a genuine dead end and no two share a cell (full build)', async () => {
  for (let i = 0; i < 5; i++) {
    const world = await buildMazeWorld();
    assert.ok(world._tokens.length > 0, 'no tokens were built');
    assert.ok(world._tokens.length <= 40, `expected at most 40 tokens, got ${world._tokens.length}`);

    const cellsSeen = new Set();
    for (const tok of world._tokens) {
      const cx = Math.round(tok.position.x / MAZE.CELL);
      const cz = Math.round(tok.position.z / MAZE.CELL);
      const idx = cellIndex(cx, cz, 0);
      assert.equal(openDirCount(world.cells, idx), 1, `token at (${cx},${cz}) is not a dead end`);
      assert.ok(!cellsSeen.has(idx), `two tokens share cell ${idx}`);
      cellsSeen.add(idx);
    }
  }
});

test('THE NO-NEW-COLLIDER GATE: neither tokens nor NPCs add a single collider', async () => {
  for (let i = 0; i < 3; i++) {
    const world = await buildMazeWorld();
    const expected = expectedColliderCount(world);
    assert.equal(
      world.colliders.length, expected,
      `collider count is ${world.colliders.length}, but hedges+floors+forecourt alone account for ${expected} - `
        + 'something besides the maze geometry itself registered a collider',
    );
  }
});

test('THE NO-STANDABLE-TOKEN GATE: no token or NPC position is inside a collider', async () => {
  const world = await buildMazeWorld();
  for (const tok of world._tokens) {
    assert.equal(
      world.physics.containsPoint(tok.position), false,
      `token at ${tok.position.x},${tok.position.y},${tok.position.z} is embedded in a collider`,
    );
  }
  for (const spec of world.npcSpawns) {
    const feet = spec.position.clone();
    feet.y += 0.05;
    assert.equal(
      world.physics.containsPoint(feet), false,
      `${spec.name}'s spawn point is embedded in a collider`,
    );
  }
});
