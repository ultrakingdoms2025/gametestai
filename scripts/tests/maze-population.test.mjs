import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  MAZE, DIR, generateTopology, carveEntranceCorridor, cellCoords, cellIndex,
  districtIndex, districtCoords, districtAtWorld, neighbourhoodKeys,
} from '../../src/worlds/maze/MazeTopology.js';
import {
  TOKENS_PER_DISTRICT, WANDERER_CHANCE, MAX_LIVE_WANDERERS,
  districtTokenCells, pickDistrictTokens, pickDistrictWanderer, districtCastIndex,
  openDirCount,
} from '../../src/worlds/maze/MazePopulate.js';
import { cellToWorld } from '../../src/worlds/maze/MazeColliders.js';
import { Physics } from '../../src/physics/Physics.js';
import { EventBus } from '../../src/core/EventBus.js';
import {
  MazeWorld, WANDERER_CAST, MAX_LIVE_TOKENS, MAX_RESIDENT_DISTRICTS,
} from '../../src/worlds/MazeWorld.js';
import { NPCManager } from '../../src/npc/NPCManager.js';

/*
 * POPULATION FOLLOWS RESIDENCY.
 *
 * Measured live in the browser before this work, standing at the maze entrance
 * (x=1260, z=60, seed 448071848):
 *
 *   tokens: 200 in the world, 2 within 120 m, 4 within 240 m
 *   npcs:   21 in the world, 1 within 120 m, nearest WANDERER 543 m away
 *
 * The maze is 2394 m square across four levels and only a ~240 m neighbourhood
 * is ever streamed in, so a flat global count is a population the player meets
 * by accident. These tests hold the replacement to three things:
 *
 *   1. A district's population exists exactly while that district is resident,
 *      keyed on `MazeChunks`'s own residency and never on a second calculation.
 *   2. Nothing leaks across a walk, and the live count is bounded by the
 *      residency radius rather than by the size of the maze.
 *   3. Placement is deterministic in (seed, district), so leaving and coming
 *      back finds the same tokens and the same person.
 *
 * The density figures at the bottom are the actual point of the exercise and
 * are asserted against the measured before-numbers, not against a round number.
 */

const RESIDENCY_RADIUS = 2;

/** A carved four-level topology, the same one `MazeWorld.build()` produces. */
function topology(seed) {
  const t = generateTopology(seed, { levels: MAZE.LEVELS });
  carveEntranceCorridor(t.cells, cellCoords(t.entranceCell));
  return t;
}

function buildMazeWorld(ctxExtra = null) {
  const world = new MazeWorld({
    scene: { add() {} },
    engine: null,
    physics: new Physics(null),
    bus: new EventBus(),
    materials: null,
    ...ctxExtra,
  });
  return world.build().then(() => world);
}

/**
 * The slice of `NPCManager` that `MazePopulation` is allowed to depend on.
 *
 * A stub rather than the real manager because the real one builds skinned
 * meshes, and because the thing under test is the CONTRACT: ask to spawn, hold
 * the reference, and find out later whether the manager still has it. The real
 * implementation of `owns` is pinned separately, below.
 */
class StubNPCManager {
  constructor(cap = 44) {
    this._npcs = [];
    this.cap = cap;
    /** Every `spawnOne` that produced a character, ever - build included. */
    this.spawns = 0;
  }

  spawnOne(spec) {
    if (!spec?.position) return null;
    if (spec.type === 'hostile') return null;
    if (this._npcs.length >= this.cap) return null;
    const npc = { spec, name: spec.name, role: 'wanderer' };
    this._npcs.push(npc);
    this.spawns++;
    return npc;
  }

  despawn(npc) {
    const i = this._npcs.indexOf(npc);
    if (i < 0) return false;
    this._npcs.splice(i, 1);
    return true;
  }

  owns(npc) {
    return !!npc && this._npcs.indexOf(npc) >= 0;
  }

  /** What `NPCManager.clear()` and `spawnForWorld()` do, from a caller's view. */
  clear() {
    this._npcs.length = 0;
  }
}

/** The residency set a player standing at (x, z) on `level` would hold. */
function residencyAt(x, z, level) {
  const want = new Set(neighbourhoodKeys(districtAtWorld(x, z, level), RESIDENCY_RADIUS));
  for (const dl of [-1, 1]) {
    const near = level + dl;
    if (near < 0 || near >= MAZE.LEVELS) continue;
    for (const k of neighbourhoodKeys(districtAtWorld(x, z, near), 1)) want.add(k);
  }
  return [...want].sort((a, b) => a - b);
}

/** Which district a world position falls in, from the position alone. */
function districtOfPosition(p) {
  const level = Math.round(p.y / MAZE.LEVEL_HEIGHT);
  return districtAtWorld(p.x, p.z, level);
}

/* -------------------------------------------------------------------- */
/* Pure placement: tokens                                                */
/* -------------------------------------------------------------------- */

test('every district token is a genuine dead end inside that district, across many seeds', () => {
  for (let seed = 0; seed < 12; seed++) {
    const t = topology(seed);
    const exclude = new Set([t.entranceCell, t.centreCell]);
    for (const key of [districtIndex(3, 4, 0), districtIndex(11, 9, 1), districtIndex(17, 2, 3)]) {
      const { dx, dz, level } = districtCoords(key);
      for (const idx of pickDistrictTokens(t.cells, key, seed, TOKENS_PER_DISTRICT, exclude)) {
        const c = cellCoords(idx);
        assert.equal(c.level, level, `seed ${seed}: token on the wrong level`);
        assert.ok(Math.floor(c.x / MAZE.DISTRICT) === dx && Math.floor(c.z / MAZE.DISTRICT) === dz,
          `seed ${seed}: token at (${c.x},${c.z}) is outside district ${key}`);
        assert.equal(openDirCount(t.cells, idx), 1,
          `seed ${seed}: token cell ${idx} has ${openDirCount(t.cells, idx)} open passages, not 1`);
      }
    }
  }
});

test('THE NO-CONNECTOR-CELL GATE: no token or wanderer is ever placed in a shaft cell', () => {
  /* A dead end that is ALSO a staircase, a lift well or a tunnel mouth has
   * treads, a car or a fold in it, so a token 0.6 m off its floor is a token
   * inside a collider. The whole-level picker this replaced got away with
   * ignoring it because 195 of its 200 tokens sat in districts that were never
   * built; every token now placed is in a district that IS built. */
  for (let seed = 0; seed < 8; seed++) {
    const t = topology(seed);
    let checkedConnectors = 0;
    for (let d = 0; d < 60; d++) {
      const key = districtIndex(d % MAZE.DISTRICTS, (d * 7) % MAZE.DISTRICTS, d % MAZE.LEVELS);
      for (const idx of pickDistrictTokens(t.cells, key, seed)) {
        assert.equal(t.cells[idx] & (DIR.UP | DIR.DOWN), 0,
          `seed ${seed}: token in cell ${idx}, which carries a vertical connector`);
      }
      const site = pickDistrictWanderer(t.cells, key, seed);
      if (site >= 0) {
        assert.equal(t.cells[site] & (DIR.UP | DIR.DOWN), 0,
          `seed ${seed}: wanderer standing in cell ${site}, which carries a vertical connector`);
        checkedConnectors++;
      }
    }
    assert.ok(checkedConnectors > 0, `seed ${seed}: no wanderers rolled at all across 60 districts`);
  }
});

test('district token placement is deterministic in (seed, district) and independent of call order', () => {
  const t = topology(31337);
  const keys = [districtIndex(2, 2, 0), districtIndex(9, 14, 2), districtIndex(19, 0, 1)];
  const first = keys.map((k) => pickDistrictTokens(t.cells, k, 31337).join(','));
  // Ask again in the opposite order - a shared RNG would give a different answer.
  const again = [...keys].reverse().map((k) => pickDistrictTokens(t.cells, k, 31337).join(',')).reverse();
  assert.deepEqual(again, first, 'token placement depends on the order districts are asked about');
  // A different seed must actually move them, or "deterministic" is just "fixed".
  const other = keys.map((k) => pickDistrictTokens(t.cells, k, 31338).join(','));
  assert.notDeepEqual(other, first, 'the seed does not affect token placement at all');
});

test('a district never yields more than TOKENS_PER_DISTRICT, and never a duplicate', () => {
  const t = topology(5);
  for (let d = 0; d < 80; d++) {
    const key = districtIndex(d % MAZE.DISTRICTS, (d * 3) % MAZE.DISTRICTS, d % MAZE.LEVELS);
    const picked = pickDistrictTokens(t.cells, key, 5);
    assert.ok(picked.length <= TOKENS_PER_DISTRICT, `district ${key} yielded ${picked.length} tokens`);
    assert.equal(new Set(picked).size, picked.length, `district ${key} yielded a duplicate cell`);
  }
});

test('an excluded cell is never chosen, as a token or as a wanderer site', () => {
  const t = topology(88);
  const key = districtIndex(6, 6, 0);
  const all = districtTokenCells(t.cells, key, null);
  assert.ok(all.length > 3, 'district 6,6 has too few dead ends to make this test mean anything');
  // Forbid every dead end it has; the picker must then return nothing at all
  // rather than fall back to one of them.
  const exclude = new Set(all);
  assert.deepEqual(pickDistrictTokens(t.cells, key, 88, TOKENS_PER_DISTRICT, exclude), []);
});

/* -------------------------------------------------------------------- */
/* Pure placement: wanderers                                             */
/* -------------------------------------------------------------------- */

test('a wanderer site is a junction, never a dead end - they are walking, not pacing', () => {
  const t = topology(404);
  let found = 0;
  for (let d = 0; d < 120; d++) {
    const key = districtIndex(d % MAZE.DISTRICTS, (d * 11) % MAZE.DISTRICTS, d % MAZE.LEVELS);
    const site = pickDistrictWanderer(t.cells, key, 404);
    if (site < 0) continue;
    found++;
    assert.ok(openDirCount(t.cells, site) >= 2,
      `wanderer in district ${key} stands in a dead end (${openDirCount(t.cells, site)} open passages)`);
  }
  assert.ok(found > 10, `only ${found} wanderers over 120 districts - the roll is broken`);
});

test('wanderer density lands near WANDERER_CHANCE rather than at 0 or 1', () => {
  /* The bound the whole design rests on: if every district held someone the
   * NPC budget would be gone in one neighbourhood, and if almost none did we
   * would be back to a nearest wanderer 543 m away. */
  const t = topology(2026);
  let held = 0;
  const N = 800;
  for (let d = 0; d < N; d++) {
    const key = districtIndex(d % MAZE.DISTRICTS, Math.floor(d / MAZE.DISTRICTS) % MAZE.DISTRICTS, d % MAZE.LEVELS);
    if (pickDistrictWanderer(t.cells, key, 2026) >= 0) held++;
  }
  const rate = held / N;
  assert.ok(Math.abs(rate - WANDERER_CHANCE) < 0.06,
    `${(rate * 100).toFixed(1)}% of districts hold a wanderer, expected about ${WANDERER_CHANCE * 100}%`);
});

test("a district's wanderer is always the same person for a given seed", () => {
  const key = districtIndex(12, 5, 1);
  const a = districtCastIndex(key, 777, WANDERER_CAST.length);
  const b = districtCastIndex(key, 777, WANDERER_CAST.length);
  assert.equal(a, b, 'the cast index is not stable - walking away and back would change who you met');
  assert.ok(a >= 0 && a < WANDERER_CAST.length);
  // Different districts must not all be the same character.
  const spread = new Set();
  for (let d = 0; d < 60; d++) spread.add(districtCastIndex(d, 777, WANDERER_CAST.length));
  assert.ok(spread.size > 5, `60 districts drew only ${spread.size} distinct characters`);
});

/* -------------------------------------------------------------------- */
/* Streaming: in, out, and nothing left behind                           */
/* -------------------------------------------------------------------- */

test('a district that streams in gains its population; one that streams out loses it', async () => {
  const world = await buildMazeWorld();
  const pop = world.population;

  // A district well away from the entrance neighbourhood, chosen so it is not
  // already resident.
  const resident = new Set(pop.residentKeys());
  let key = -1;
  for (let d = 0; d < MAZE.DISTRICTS * MAZE.DISTRICTS; d++) {
    if (resident.has(d)) continue;
    if (pickDistrictTokens(world.cells, d, world.seed).length === 0) continue;
    key = d;
    break;
  }
  assert.ok(key >= 0, 'no non-resident district on level 0 has any tokens at all');

  const before = pop.tokens.length;
  pop.ensure(key);
  const after = pop.tokens.length;
  assert.ok(after > before, `streaming district ${key} in added no tokens`);
  assert.ok(pop.residentKeys().includes(key));
  for (const tok of pop.tokens.slice(before)) {
    assert.equal(districtOfPosition(tok.position), key, 'a token landed outside the district that built it');
  }

  pop.drop(key);
  assert.equal(pop.tokens.length, before, `dropping district ${key} left ${pop.tokens.length - before} token(s) behind`);
  assert.ok(!pop.residentKeys().includes(key));
});

test('THE NO-LEAK GATE: a long walk never grows the live population', async () => {
  const world = await buildMazeWorld();
  const pop = world.population;
  const capacity = pop.capacity;

  let peakTokens = 0;
  let peakWanderers = 0;
  // ~2 km east and then a level up, in district-sized strides, which is the
  // motion that actually churns residency.
  for (let step = 0; step < 24; step++) {
    const x = 60 + step * 100;
    const z = 60 + (step % 3) * 120;
    const level = step > 16 ? 1 : 0;
    const keys = residencyAt(x, z, level);
    pop.sync(keys);

    assert.deepEqual(pop.residentKeys(), keys, `step ${step}: population residency drifted from the district set`);

    // The slot ledger must balance exactly: every instance is either in use by
    // a live token or sitting on the free list. Anything else is a leak that
    // would eventually stop new tokens appearing at all.
    assert.equal(pop.tokens.length + pop._free.length, capacity,
      `step ${step}: ${capacity - pop.tokens.length - pop._free.length} instance slot(s) leaked`);
    assert.equal(new Set(pop.tokens.map((t) => t.slot)).size, pop.tokens.length,
      `step ${step}: two live tokens share an instance slot`);

    for (const tok of pop.tokens) {
      assert.ok(keys.includes(districtOfPosition(tok.position)),
        `step ${step}: a token is alive in a district that is not resident`);
    }
    for (const spec of pop.wandererSpecs()) {
      assert.ok(keys.includes(spec.district),
        `step ${step}: a wanderer is alive in a district that is not resident`);
    }

    peakTokens = Math.max(peakTokens, pop.tokens.length);
    peakWanderers = Math.max(peakWanderers, pop.wandererCount());
  }

  assert.ok(peakTokens <= MAX_LIVE_TOKENS,
    `peak live tokens ${peakTokens} exceeds the residency bound ${MAX_LIVE_TOKENS}`);
  assert.ok(peakWanderers <= MAX_LIVE_WANDERERS,
    `peak live wanderers ${peakWanderers} exceeds the cap ${MAX_LIVE_WANDERERS}`);
  assert.ok(peakTokens > 20, `peak live tokens was only ${peakTokens} - the walk populated almost nothing`);
});

test('the live bound is a property of residency, not of maze size', () => {
  /* The number this design is actually buying. `MAX_RESIDENT_DISTRICTS` is the
   * widest set `MazeChunks.updateResidency` can hold: a full 5x5 block on the
   * player's own level plus a 3x3 ring on each of the levels either side. */
  let widest = 0;
  for (const level of [0, 1, 2, 3]) {
    for (const [x, z] of [[1200, 1200], [60, 60], [2340, 60], [1200, 60]]) {
      widest = Math.max(widest, residencyAt(x, z, level).length);
    }
  }
  assert.ok(widest <= MAX_RESIDENT_DISTRICTS,
    `residency can hold ${widest} districts but the bound assumes ${MAX_RESIDENT_DISTRICTS}`);
  assert.equal(MAX_LIVE_TOKENS, MAX_RESIDENT_DISTRICTS * TOKENS_PER_DISTRICT);
});

test('streaming a district out and back finds the same tokens and the same person', async () => {
  const world = await buildMazeWorld();
  const pop = world.population;
  const key = pop.residentKeys().find((k) => {
    const e = pop._resident.get(k);
    return e.tokens.length > 0;
  });
  assert.ok(key !== undefined, 'no resident district has any tokens');

  const cellsBefore = pop._resident.get(key).tokens.map((t) => t.cell).sort((a, b) => a - b);
  const whoBefore = pop._resident.get(key).spec?.name ?? null;

  pop.drop(key);
  pop.ensure(key);

  const cellsAfter = pop._resident.get(key).tokens.map((t) => t.cell).sort((a, b) => a - b);
  assert.deepEqual(cellsAfter, cellsBefore, 'the tokens moved when the district was re-entered');
  assert.equal(pop._resident.get(key).spec?.name ?? null, whoBefore,
    'the wanderer changed identity when the district was re-entered');
});

test('a collected token does not come back when its district is re-entered', async () => {
  const world = await buildMazeWorld();
  const pop = world.population;
  const key = pop.residentKeys().find((k) => pop._resident.get(k).tokens.length > 0);
  assert.ok(key !== undefined);

  const rec = pop._resident.get(key).tokens[0];
  const cell = rec.cell;
  const had = pop._resident.get(key).tokens.length;
  assert.equal(pop.collect(rec), true);
  assert.equal(pop.collect(rec), false, 'collecting the same token twice paid twice');

  pop.drop(key);
  pop.ensure(key);
  const now = pop._resident.get(key).tokens;
  assert.equal(now.length, had - 1, 'a collected token respawned with its district');
  assert.ok(!now.some((t) => t.cell === cell), 'the collected token is back');
  // ...and the slot it was using came back to the pool rather than leaking.
  assert.equal(pop.tokens.length + pop._free.length, pop.capacity);
});

test('population residency tracks the chunk streamer key for key, over a real walk', async () => {
  /* The single-source-of-truth guarantee. If these two ever disagree, a token
   * is floating in a district whose floor has been released. */
  const world = await buildMazeWorld();
  const spawn = world.playerSpawn;
  for (let step = 0; step < 6; step++) {
    const x = spawn.x + step * 130;
    world.chunks.updateResidency(x, spawn.y, spawn.z + step * 90, RESIDENCY_RADIUS);
    world.population.sync(world.chunks.residentKeys());
    assert.deepEqual(world.population.residentKeys(), world.chunks.residentKeys(),
      `step ${step}: the population and the geometry disagree about which districts are live`);
  }
});

test('disposeAll releases every token and forgets what was collected', async () => {
  const world = await buildMazeWorld();
  const pop = world.population;
  assert.ok(pop.tokens.length > 0);
  pop.disposeAll();
  assert.equal(pop.tokens.length, 0);
  assert.equal(pop.residentKeys().length, 0);
  assert.equal(pop.wandererCount(), 0);
  assert.equal(pop.mesh, null, 'the token InstancedMesh was not released');
});

/* -------------------------------------------------------------------- */
/* THE DENSITY GATE - the measurement this work exists for               */
/* -------------------------------------------------------------------- */

test('THE DENSITY GATE: tokens and wanderers near the player, not scattered over 2.4 km', async () => {
  /* Measured before this work at the entrance, seed 448071848:
   *     2 tokens within 120 m, 4 within 240 m, 0 wanderers within 120 m,
   *     nearest wanderer 543 m.
   * Those are the numbers to beat, and the thresholds below are set well
   * above them rather than at a round number, so a regression that quietly
   * halves the density still fails. */
  let worstNear = Infinity;
  let worstFar = Infinity;
  let worstWanderer = Infinity;

  for (let i = 0; i < 4; i++) {
    const world = await buildMazeWorld();
    const p = world.playerSpawn;
    const near = world._tokens.filter((t) => t.position.distanceTo(p) <= 120).length;
    const far = world._tokens.filter((t) => t.position.distanceTo(p) <= 240).length;
    worstNear = Math.min(worstNear, near);
    worstFar = Math.min(worstFar, far);

    let nearest = Infinity;
    for (const spec of world.population.wandererSpecs()) {
      nearest = Math.min(nearest, spec.position.distanceTo(p));
    }
    worstWanderer = Math.min(worstWanderer, nearest);
  }

  assert.ok(worstNear >= 8,
    `only ${worstNear} tokens within 120 m of the entrance - it was 2 before, this is not enough better`);
  assert.ok(worstFar >= 25,
    `only ${worstFar} tokens within 240 m of the entrance - it was 4 before`);
  assert.ok(worstWanderer < 300,
    `the nearest wanderer is ${worstWanderer.toFixed(0)} m away - it was 543 m before`);
});

test('THE PATROL-GROUND GATE: no waypoint is ever in a stairwell or a puzzle doorway', async () => {
  /* The spawn SITE avoided connector cells from the start; the route did not,
   * and a shortest path to the centre crosses them regularly - measured on a
   * full build as a wanderer whose patrol ran into a staircase, caught by the
   * no-standable gate only intermittently because it depends on the seed. */
  for (let i = 0; i < 4; i++) {
    const world = await buildMazeWorld();
    let waypoints = 0;
    for (const spec of world.population.wandererSpecs()) {
      for (const p of spec.patrol) {
        const lv = Math.round(p.y / MAZE.LEVEL_HEIGHT);
        const idx = cellIndex(Math.round(p.x / MAZE.CELL), Math.round(p.z / MAZE.CELL), lv);
        assert.equal(world.cells[idx] & (DIR.UP | DIR.DOWN), 0,
          `${spec.name} is asked to walk into cell ${idx}, which carries a connector`);
        assert.equal(world.puzzles.has(idx), false,
          `${spec.name} is asked to walk into cell ${idx}, a puzzle doorway`);
        assert.equal(world.physics.containsPoint(p), false,
          `${spec.name} has a waypoint inside a collider`);
        waypoints++;
      }
    }
    assert.ok(waypoints > 0, 'no patrol waypoints to check at all');
  }
});

/* -------------------------------------------------------------------- */
/* THE WANDERERS ARE ACTUALLY THERE                                       */
/*                                                                        */
/* Every gate above this line asks the population for SPECS, and specs    */
/* are cheap: they are produced by pure functions that never touch the    */
/* NPC manager. The maze shipped with 21 resident districts, seven live   */
/* wanderer specs and NOT ONE wanderer in the world, and the whole suite  */
/* passed - because nothing here had ever asked whether a spec became a   */
/* character. These do.                                                   */
/* -------------------------------------------------------------------- */

test('THE WANDERER-DENSITY GATE: a RESIDENT-sized district set holds a sane number of them', () => {
  /* Deliberately sampled over the districts a player actually holds resident
   * rather than over the whole maze. Residency is a contiguous block of keys,
   * so a picker whose roll correlated across neighbouring keys - an off-by-one
   * in the hash inputs, a seed that stopped being threaded through - would
   * measure perfectly at 30% across all 32,000 districts and still leave the
   * neighbourhood the player is standing in empty. That is exactly the shape of
   * failure this file's global density test cannot see. */
  for (const seed of [7, 99, 165064288, 2107331574, 448071848, 31337]) {
    const t = topology(seed);
    const exclude = new Set([t.entranceCell, t.centreCell]);

    const keys = new Set();
    for (let step = 0; keys.size < 100; step++) {
      for (const k of residencyAt(60 + step * 120, 60 + (step % 4) * 130, step % MAZE.LEVELS)) keys.add(k);
    }
    const sample = [...keys];

    let held = 0;
    for (const k of sample) if (pickDistrictWanderer(t.cells, k, seed, exclude) >= 0) held++;

    assert.ok(held > 0,
      `seed ${seed}: not one of ${sample.length} resident districts holds a wanderer`);
    assert.ok(held < sample.length,
      `seed ${seed}: every one of ${sample.length} resident districts holds a wanderer`);
    /* Four standard deviations of a binomial - wide enough that a legitimately
     * unlucky seed never fails, narrow enough that "always -1" and "always a
     * site" both do. */
    const mean = sample.length * WANDERER_CHANCE;
    const sigma = Math.sqrt(sample.length * WANDERER_CHANCE * (1 - WANDERER_CHANCE));
    assert.ok(Math.abs(held - mean) <= 4 * sigma,
      `seed ${seed}: ${held} of ${sample.length} resident districts hold a wanderer, ` +
      `expected about ${mean.toFixed(1)} (+/- ${(4 * sigma).toFixed(1)})`);
  }
});

test('THE LIVE-WANDERER GATE: a resident district produces a CHARACTER, not just a spec', async () => {
  const mgr = new StubNPCManager();
  let world = null;
  /* The seed is re-rolled on every build and a neighbourhood that rolls nobody
   * at all is legitimate (0.7^21, about one build in fifteen hundred), so the
   * gate retries rather than being flaky about it. */
  for (let attempt = 0; attempt < 3 && !world; attempt++) {
    const w = await buildMazeWorld({ npcManager: mgr });
    /* Not one character may exist yet. `build()` registers into a throwaway
     * physics world and `WorldManager._activate` wipes the cast twice after it,
     * so anything spawned here is grounded against a floor that is about to be
     * discarded and is then destroyed - which is precisely how the maze ended
     * up with specs and no people. */
    assert.equal(mgr.spawns, 0,
      'characters were built during build(), before the world was ever activated');
    if (w.population.wandererCount() > 0) world = w;
  }
  assert.ok(world, 'three builds in a row picked no wanderer anywhere in the entrance neighbourhood');

  world.onActivate();
  world.population.sync(world.chunks.residentKeys());

  const specs = world.population.wandererCount();
  assert.equal(world.population.spawnedWandererCount(), specs,
    `${specs} district(s) hold a wanderer but only ` +
    `${world.population.spawnedWandererCount()} of them became a character`);
  assert.equal(mgr._npcs.length, specs, 'the manager was not asked for every wanderer');
  for (const npc of mgr._npcs) {
    assert.equal(npc.spec.type, 'friendly');
    assert.ok(npc.spec.patrol.length > 0, `${npc.name} was spawned with no patrol route`);
  }
});

test('THE CAST-WIPE GATE: a wanderer the manager destroyed behind our back comes back', async () => {
  /* THE regression. `NPCManager.clear()` and `spawnForWorld()` dispose the whole
   * cast on every world activation and tell nobody which specs went with it, so
   * the population is left holding disposed characters. Treating a non-null
   * reference as "this district is done" made the retry in `sync` skip every one
   * of them forever: 21 resident districts, seven wanderer specs, zero people in
   * the maze, no console error, and a green suite. */
  const mgr = new StubNPCManager();
  let world = null;
  for (let attempt = 0; attempt < 3 && !world; attempt++) {
    const w = await buildMazeWorld({ npcManager: mgr });
    if (w.population.wandererCount() > 0) world = w;
  }
  assert.ok(world, 'three builds in a row picked no wanderer anywhere in the entrance neighbourhood');

  world.onActivate();
  const keys = world.chunks.residentKeys();
  world.population.sync(keys);
  const before = world.population.spawnedWandererCount();
  assert.ok(before > 0, 'no wanderer was spawned in the first place');

  mgr.clear();
  assert.equal(world.population.spawnedWandererCount(), 0,
    'the population still believes in characters the manager has destroyed');

  // Same residency: nothing streamed in or out, so only the ownership re-check
  // can bring them back.
  world.population.sync(keys);
  assert.equal(world.population.spawnedWandererCount(), before,
    'the wanderers never came back after the cast was wiped');
  assert.equal(mgr._npcs.length, before);
});

test('a wanderer refused by a full NPC budget is retried, not given up on', async () => {
  /* The other half of the retry, and the reason the ownership check must not
   * simply respawn everything: a refusal is a temporary state of the budget. */
  const mgr = new StubNPCManager(0);
  let world = null;
  for (let attempt = 0; attempt < 3 && !world; attempt++) {
    const w = await buildMazeWorld({ npcManager: mgr });
    if (w.population.wandererCount() > 0) world = w;
  }
  assert.ok(world);

  world.onActivate();
  const keys = world.chunks.residentKeys();
  world.population.sync(keys);
  assert.equal(world.population.spawnedWandererCount(), 0, 'a zero budget spawned somebody');
  const specs = world.population.wandererCount();
  assert.ok(specs > 0, 'the specs were discarded along with the refusal');

  mgr.cap = 44;
  world.population.sync(keys);
  assert.equal(world.population.spawnedWandererCount(), specs,
    'the districts refused by a full budget were never retried');
});

test('NPCManager.owns tracks a streamed character through spawn, despawn and clear', () => {
  /* The stub above is only honest if the real manager answers the same way.
   * `owns` is the entire basis on which the population decides a district still
   * has somebody in it. */
  const mgr = new NPCManager({
    scene: { add() {}, remove() {} },
    physics: new Physics(null),
    bus: new EventBus(),
    player: null,
  });
  const character = { root: { removeFromParent() {} }, dispose() {} };

  assert.equal(mgr.owns(null), false);
  assert.equal(mgr.owns(character), false, 'a character it never had is reported as owned');

  mgr._npcs.push(character);
  assert.equal(mgr.owns(character), true);

  mgr.despawn(character);
  assert.equal(mgr.owns(character), false, 'a despawned character is still reported as owned');

  mgr._npcs.push(character);
  mgr.clear();
  assert.equal(mgr.owns(character), false, 'clear() left a destroyed character reported as owned');
});

test('the shared world context carries the NPC manager - streaming has no other route to it', async () => {
  /* `MazePopulation` reaches the manager through `world.ctx.npcManager`, and
   * `WorldManager.getWorld` hands each world a SPREAD COPY of the shared
   * context - so the assignment has to happen in `main.js` before any world is
   * constructed. Delete that one line and every gate in this file still passes
   * while the maze contains nobody. */
  const src = await readFile(new URL('../../src/main.js', import.meta.url), 'utf8');
  assert.match(src, /ctx\.npcManager\s*=\s*npcManager/,
    'main.js no longer puts the NPC manager on the shared world context');
});

test('every live token stands on the floor of the level it belongs to', async () => {
  const world = await buildMazeWorld();
  for (const t of world._tokens) {
    const lv = Math.round(t.position.y / MAZE.LEVEL_HEIGHT);
    assert.ok(Math.abs(t.position.y - (lv * MAZE.LEVEL_HEIGHT + 0.6)) < 1e-6,
      `a token sits at y=${t.position.y} on level ${lv}`);
    const c = cellCoords(cellIndex(
      Math.round(t.position.x / MAZE.CELL), Math.round(t.position.z / MAZE.CELL), lv,
    ));
    const w = cellToWorld(c.x, c.z, c.level);
    assert.ok(Math.hypot(t.position.x - w.x, t.position.z - w.z) < 1e-6,
      'a token is not on a cell centre');
  }
});
