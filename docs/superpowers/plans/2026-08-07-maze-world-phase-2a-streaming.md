# Maze World — Phase 2a: Chunk Streaming Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop building the whole maze up front — keep only the districts near the player resident, building and dropping them as they walk, so a four-level maze becomes affordable in Phase 2b.

**Architecture:** A chunk manager owns a residency set of districts around the player. Each district's geometry and colliders are built on demand from the topology array and released with `Physics.remove()` when the player leaves. Residency math is pure and lives in `MazeTopology.js`; the THREE-dependent build/drop lives in a new `MazeChunks.js`.

**Tech Stack:** Three.js 0.185.1, Vite 8, vanilla ES modules. Tests use Node's built-in `node:test` runner — **no new dependencies**.

## Global Constraints

From `docs/superpowers/specs/2026-08-07-maze-world-design.md`. Every task's requirements implicitly include this section.

- **Cell pitch 6.0 m. Corridor 4.8 m. Hedge thickness 1.2 m. Hedge height 5.0 m. `LEVEL_HEIGHT` 9.0 m.**
- **District = 20 × 20 cells (120 m × 120 m). 20 × 20 districts per level. 4 levels. 400 × 400 cells per level. 640,000 cells.**
- **Residency is the 5 × 5 district neighbourhood around the player** — at most 25 resident.
- **A hop clears exactly 0.93 m; auto-step is 0.45 m. No collider may present a standable top between 0.45 m and 5.0 m.**
- **`MazeTopology.js` and `MazeColliders.js` stay pure** — no `three`, no DOM. This is what keeps the headless gates running.
- **`MazeChunks.js` must build from collider descriptors**, never derive colliders from built meshes.
- **Materials are reused across re-rolls and across chunks.** Shader compilation dominates cold boot (118 s of 127 s measured). A per-chunk material allocation is a task failure.
- **Portal entry must stay under 3 s.**
- **No new npm dependencies.** `.js` extensions in all import specifiers.

## Scope

Phase 2a keeps **one level** (`generateTopology(seed, { levels: 1 })`). Turning on levels 1–3, the vertical connectors and canopy LOD are Phase 2b. Keeping the level count fixed means any behaviour change in this plan is attributable to streaming alone.

## Why the duplicated walk goes first

`MazeTopology.js` currently has two spanning-tree walks: `buildDistrictGraph` (lines ~183-240) and a near-identical copy inside `generateTopology`'s `levels < MAZE.LEVELS` branch (lines ~388-455). Phase 1's ledger records that both the stale `treeEdges` and the dropped loop edges came from that duplication, and Phase 2b turns `levels` on — editing exactly this code. Collapsing it first removes the class of bug rather than the instances.

---

### Task 1: One spanning-tree walk, not two

**Files:**
- Modify: `src/worlds/maze/MazeTopology.js` — `buildDistrictGraph` (~line 183) and `generateTopology` (~line 374)
- Modify: `scripts/tests/maze-topology.test.mjs` (append)

**Interfaces:**
- Consumes: `MAZE`, `hash32`, `mulberry32`, `districtIndex`, `districtCoords`, `edgeKey`.
- Produces: `buildDistrictGraph(seed, levelLimit = MAZE.LEVELS)` — the single walk. `generateTopology` calls it with the level limit instead of rebuilding.

- [ ] **Step 1: Write the failing test**

Append to `scripts/tests/maze-topology.test.mjs`:

```js
import { generateTopology, reachableCount, solve } from '../../src/worlds/maze/MazeTopology.js';

test('buildDistrictGraph accepts a level limit and spans only those levels', () => {
  const g1 = buildDistrictGraph(4242, 1);
  const perLevel = MAZE.DISTRICTS * MAZE.DISTRICTS; // 400
  assert.equal(g1.treeEdges, perLevel - 1, 'a 1-level tree has 399 edges');

  // No open edge may touch a level at or above the limit.
  for (const key of g1.open) {
    for (const part of key.split('|')) {
      assert.ok(districtCoords(Number(part)).level < 1, `edge ${key} leaves level 0`);
    }
  }
});

test('the level-limited graph is still fully connected', () => {
  for (const limit of [1, 2, 4]) {
    const g = buildDistrictGraph(77, limit);
    const n = limit * MAZE.DISTRICTS * MAZE.DISTRICTS;
    const seen = new Uint8Array(n);
    const stack = [0];
    seen[0] = 1;
    let reached = 1;
    while (stack.length) {
      const cur = stack.pop();
      const { dx, dz, level } = districtCoords(cur);
      const nb = [
        [dx, dz - 1, level], [dx + 1, dz, level], [dx, dz + 1, level], [dx - 1, dz, level],
        [dx, dz, level - 1], [dx, dz, level + 1],
      ];
      for (const [nx, nz, nl] of nb) {
        if (nx < 0 || nz < 0 || nl < 0) continue;
        if (nx >= MAZE.DISTRICTS || nz >= MAZE.DISTRICTS || nl >= limit) continue;
        const i = districtIndex(nx, nz, nl);
        if (seen[i] || !isEdgeOpen(g, cur, i)) continue;
        seen[i] = 1; reached++; stack.push(i);
      }
    }
    assert.equal(reached, n, `limit ${limit} is disconnected`);
  }
});

test('the level-limited graph still gets its loop edges', () => {
  const g = buildDistrictGraph(42, 1);
  // 400 districts => 399 tree edges; loops must be a real fraction on top.
  assert.ok(g.extraEdges >= 18, `too few loops: ${g.extraEdges}`);
  assert.equal(g.open.size, g.treeEdges + g.extraEdges, 'edge accounting must balance');
});

test('reported counts are never stale', () => {
  for (const limit of [1, 2, 4]) {
    const g = buildDistrictGraph(9, limit);
    assert.equal(g.open.size, g.treeEdges + g.extraEdges, `limit ${limit} accounting`);
    assert.ok(g.centre.level < limit, `centre on level ${g.centre.level} outside limit ${limit}`);
  }
});

test('the default call is unchanged', () => {
  const a = buildDistrictGraph(31337);
  const b = buildDistrictGraph(31337, MAZE.LEVELS);
  assert.deepEqual([...a.open].sort(), [...b.open].sort());
  assert.equal(a.treeEdges, MAZE.DISTRICTS * MAZE.DISTRICTS * MAZE.LEVELS - 1);
});

test('generateTopology stays solvable and fully reachable at every level count', () => {
  for (const levels of [1, 2, 4]) {
    for (let seed = 0; seed < 25; seed++) {
      const t = generateTopology(seed, { levels });
      assert.ok(solve(t.cells, t.entranceCell, t.centreCell), `seed ${seed} levels ${levels} unsolvable`);
      assert.equal(
        reachableCount(t.cells, t.entranceCell),
        levels * MAZE.LEVEL_CELLS,
        `seed ${seed} levels ${levels} has unreachable cells`,
      );
    }
  }
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npm test`

Expected: FAIL — `buildDistrictGraph(4242, 1)` ignores the second argument today, so `treeEdges` is 1599 rather than 399.

- [ ] **Step 3: Collapse the two walks into one**

In `src/worlds/maze/MazeTopology.js`, give `buildDistrictGraph` a level limit and make every level-dependent bound respect it. Replace the signature and the two bounds:

```js
/**
 * Build the district connectivity graph for a seed.
 *
 * `levelLimit` restricts the walk to the lowest N levels. This exists because
 * a tree spanning all four levels can route between two level-0 districts *via*
 * level 1 — and if only level 0 is ever carved, that route does not exist and
 * the maze is unsolvable. Phase 1 shipped 25 seeds in 40 with no path to the
 * centre before this was understood. One walk, parameterised, rather than two
 * that have to be kept in step.
 *
 * @param {number} seed
 * @param {number} [levelLimit] lowest N levels to span; defaults to all
 */
export function buildDistrictGraph(seed, levelLimit = MAZE.LEVELS) {
  const levels = Math.max(1, Math.min(MAZE.LEVELS, levelLimit));
  const total = levels * DISTRICTS_PER_LEVEL;
  const rng = mulberry32(hash32(seed, 0x6a11));
  const open = new Set();
  const visited = new Uint8Array(total);
  // ... walk body unchanged, but every `TOTAL_DISTRICTS` becomes `total`
```

`districtNeighbours(index)` must not offer a neighbour above the limit. Give it the same parameter:

```js
function districtNeighbours(index, levels = MAZE.LEVELS) {
  const { dx, dz, level } = districtCoords(index);
  const out = [];
  if (dz > 0) out.push({ i: districtIndex(dx, dz - 1, level), vertical: false });
  if (dx < MAZE.DISTRICTS - 1) out.push({ i: districtIndex(dx + 1, dz, level), vertical: false });
  if (dz < MAZE.DISTRICTS - 1) out.push({ i: districtIndex(dx, dz + 1, level), vertical: false });
  if (dx > 0) out.push({ i: districtIndex(dx - 1, dz, level), vertical: false });
  if (level > 0) out.push({ i: districtIndex(dx, dz, level - 1), vertical: true });
  if (level < levels - 1) out.push({ i: districtIndex(dx, dz, level + 1), vertical: true });
  return out;
}
```

and pass `levels` at both call sites inside `buildDistrictGraph` (the tree walk and the extra-edge pass). The extra-edge loop bound becomes `i < total`.

Finally fold the centre into range, inside `buildDistrictGraph`, so it can never be reported outside the limit:

```js
    centre: {
      dx: 10,
      dz: 10,
      level: hash32(seed, 0xc0ffee) % levels,
    },
```

- [ ] **Step 4: Delete the duplicate walk from `generateTopology`**

Replace the entire `if (levels < MAZE.LEVELS) { ... }` block (~lines 388-455) with the single call, and delete `centreLevel` — `graph.centre.level` is now already correct:

```js
export function generateTopology(seed, opts = {}) {
  const levels = Math.max(1, Math.min(MAZE.LEVELS, opts.levels ?? MAZE.LEVELS));
  const graph = buildDistrictGraph(seed, levels);
  const cells = new Uint8Array(MAZE.TOTAL_CELLS);

  for (let level = 0; level < levels; level++) {
    for (let dz = 0; dz < MAZE.DISTRICTS; dz++) {
      for (let dx = 0; dx < MAZE.DISTRICTS; dx++) {
        carveDistrict(seed, graph, dx, dz, level, cells);
      }
    }
  }
  // ... entrance/centre cell derivation unchanged, using graph.centre.level
```

- [ ] **Step 5: Run the tests**

Run: `npm test`

Expected: PASS. The 4-level path must be unchanged — if `the default call is unchanged` fails, the walk's RNG draw order was altered; compare against `git stash` output rather than adjusting the test.

- [ ] **Step 6: Run the full solvability gate**

Run: `MAZE_SEEDS=1000 npm test`

Expected: PASS. This is the gate that caught the original disconnection bug; it must still be green after restructuring the code it guards.

- [ ] **Step 7: Commit**

```bash
git add src/worlds/maze/MazeTopology.js scripts/tests/maze-topology.test.mjs
git commit -m "Walk the district graph once, not twice

Phase 1 ended with two spanning-tree walks: the real one, and a near-copy
inside generateTopology that rebuilt the tree whenever fewer than four levels
were carved. Both of that phase's late bugs came out of the gap between them -
the copy recomputed extraEdges and forgot treeEdges, and it silently dropped
the ten percent of edges that make the maze loop rather than branch.

One walk with a level limit does the same job. Phase 2 turns levels on, which
means editing exactly this code, so the duplication goes before it can cause a
third bug rather than after."
```

---

### Task 2: Residency maths

**Files:**
- Modify: `src/worlds/maze/MazeTopology.js` (append)
- Create: `scripts/tests/maze-residency.test.mjs`

**Interfaces:**
- Consumes: `MAZE`, `districtIndex`, `districtCoords`.
- Produces:
  - `districtAtWorld(x: number, z: number, level: number): number` — district index containing a world position. Clamped to the grid.
  - `neighbourhoodKeys(centreKey: number, radius: number): number[]` — district indices within `radius` districts on the same level, in-bounds, sorted ascending.
  - `DISTRICT_SPAN` — `MAZE.DISTRICT * MAZE.CELL` (120 m), exported so callers stop recomputing it.

This is pure integer maths and belongs with the other topology-space helpers, so the residency set can be tested without a renderer.

- [ ] **Step 1: Write the failing test**

Create `scripts/tests/maze-residency.test.mjs`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  MAZE, DISTRICT_SPAN, districtIndex, districtCoords,
  districtAtWorld, neighbourhoodKeys,
} from '../../src/worlds/maze/MazeTopology.js';

test('DISTRICT_SPAN is a district edge in metres', () => {
  assert.equal(DISTRICT_SPAN, MAZE.DISTRICT * MAZE.CELL);
  assert.equal(DISTRICT_SPAN, 120);
});

test('districtAtWorld maps a position to its district', () => {
  // Cell 0,0 is at the origin, so district 0 spans roughly -3 .. 117 m.
  assert.equal(districtAtWorld(0, 0, 0), districtIndex(0, 0, 0));
  assert.equal(districtAtWorld(119, 0, 0), districtIndex(0, 0, 0));
  assert.equal(districtAtWorld(121, 0, 0), districtIndex(1, 0, 0));
  assert.equal(districtAtWorld(1260, 60, 0), districtIndex(10, 0, 0));
});

test('districtAtWorld clamps rather than going out of bounds', () => {
  // The forecourt sits in negative z, outside the grid; it must not produce a
  // negative index or the residency set would silently be empty there.
  assert.equal(districtAtWorld(1260, -40, 0), districtIndex(10, 0, 0));
  assert.equal(districtAtWorld(-500, -500, 0), districtIndex(0, 0, 0));
  const last = MAZE.DISTRICTS - 1;
  assert.equal(districtAtWorld(99999, 99999, 0), districtIndex(last, last, 0));
});

test('neighbourhoodKeys returns the 5x5 block for radius 2 in open ground', () => {
  const keys = neighbourhoodKeys(districtIndex(10, 10, 0), 2);
  assert.equal(keys.length, 25);
  for (const k of keys) {
    const c = districtCoords(k);
    assert.equal(c.level, 0);
    assert.ok(Math.abs(c.dx - 10) <= 2 && Math.abs(c.dz - 10) <= 2);
  }
  assert.ok(keys.includes(districtIndex(10, 10, 0)), 'centre must be resident');
});

test('neighbourhoodKeys clips at the grid edge', () => {
  const keys = neighbourhoodKeys(districtIndex(0, 0, 0), 2);
  assert.equal(keys.length, 9, 'a corner sees only 3x3');
  for (const k of keys) {
    const c = districtCoords(k);
    assert.ok(c.dx >= 0 && c.dz >= 0 && c.dx <= 2 && c.dz <= 2);
  }
});

test('neighbourhoodKeys is sorted and duplicate-free', () => {
  const keys = neighbourhoodKeys(districtIndex(5, 7, 0), 2);
  assert.deepEqual(keys, [...keys].sort((a, b) => a - b));
  assert.equal(new Set(keys).size, keys.length);
});

test('neighbourhoodKeys stays on its own level', () => {
  const keys = neighbourhoodKeys(districtIndex(10, 10, 2), 2);
  for (const k of keys) assert.equal(districtCoords(k).level, 2);
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npm test`

Expected: FAIL — `does not provide an export named 'districtAtWorld'`.

- [ ] **Step 3: Write the implementation**

Append to `src/worlds/maze/MazeTopology.js`:

```js
/* ------------------------------------------------------------------ */
/* Residency                                                           */
/*                                                                     */
/* Which districts should be built for a player standing somewhere.    */
/* Pure integer maths, deliberately: the chunk manager that consumes    */
/* this needs THREE, and keeping the decision here means the residency  */
/* set can be tested without a renderer.                                */
/* ------------------------------------------------------------------ */

/** One district edge, in metres. */
export const DISTRICT_SPAN = MAZE.DISTRICT * MAZE.CELL;

/**
 * District containing a world position, clamped to the grid.
 *
 * Clamping matters: the entrance forecourt sits in negative z, outside the
 * cell grid entirely, and a player standing there must still hold the maze's
 * first districts resident rather than an empty set.
 */
export function districtAtWorld(x, z, level) {
  const dx = Math.min(MAZE.DISTRICTS - 1, Math.max(0, Math.floor((x + MAZE.CELL / 2) / DISTRICT_SPAN)));
  const dz = Math.min(MAZE.DISTRICTS - 1, Math.max(0, Math.floor((z + MAZE.CELL / 2) / DISTRICT_SPAN)));
  const lv = Math.min(MAZE.LEVELS - 1, Math.max(0, level | 0));
  return districtIndex(dx, dz, lv);
}

/**
 * District indices within `radius` districts of `centreKey`, same level only.
 * Sorted ascending so two calls with the same argument compare equal.
 */
export function neighbourhoodKeys(centreKey, radius) {
  const { dx, dz, level } = districtCoords(centreKey);
  const out = [];
  for (let z = dz - radius; z <= dz + radius; z++) {
    if (z < 0 || z >= MAZE.DISTRICTS) continue;
    for (let x = dx - radius; x <= dx + radius; x++) {
      if (x < 0 || x >= MAZE.DISTRICTS) continue;
      out.push(districtIndex(x, z, level));
    }
  }
  out.sort((a, b) => a - b);
  return out;
}
```

- [ ] **Step 4: Run the tests**

Run: `npm test`

Expected: PASS — 6 tests in `maze-residency.test.mjs`.

- [ ] **Step 5: Commit**

```bash
git add src/worlds/maze/MazeTopology.js scripts/tests/maze-residency.test.mjs
git commit -m "Work out which districts a player needs, without a renderer

The chunk manager needs THREE; the decision about what to load does not. Keeping
residency here as integer maths means the set can be asserted in a node test
rather than inferred from what happened to get drawn.

districtAtWorld clamps rather than returning a negative index. The entrance
forecourt is in negative z, outside the cell grid altogether, and a player
standing on it must still hold the first districts resident - an unclamped
floor would hand back an empty set at exactly the moment the maze is entered."
```

---

### Task 3: Build and drop a single district

**Files:**
- Create: `src/worlds/maze/MazeChunks.js`
- Create: `scripts/tests/maze-chunks.test.mjs`

**Interfaces:**
- Consumes: `MAZE`, `districtCoords`, `districtAtWorld`, `neighbourhoodKeys` from `MazeTopology.js`; `districtColliders` from `MazeColliders.js`; `Physics.add` / `Physics.remove`.
- Produces:
  - `class MazeChunks` with constructor `{ world, cells, group, materials }`
  - `ensure(key): void` — build the district if absent
  - `drop(key): void` — release it
  - `residentKeys(): number[]` — sorted
  - `colliderCount(): number`
  - `disposeAll(): void`

**The manager takes the `world`, not a `physics` instance, and this is not a style choice.** `WorldManager._runBuild` swaps `world.physics` to a throwaway scratch `Physics` for the duration of `build()`, then restores the real one ([WorldManager.js:245-253](../../../src/worlds/WorldManager.js#L245-L253)):

```js
world.physics = scratch;
try { await world.ensureBuilt(report); }
finally { world.physics = realPhysics; }
```

`MazeChunks` is constructed inside `build()`. A `physics` reference captured there is the **scratch** world, which is discarded seconds later. The initial districts would still work — `WorldManager` harvests them out of scratch into `world.colliders` and re-registers them — but every district streamed in *after arrival* would be added to a dead object, and the player would walk straight through it. Resolve `world.physics` and `world.colliders` at call time, every time.

Splicing `world.colliders` on drop matters for the mirror-image reason: `WorldManager._activate` re-registers every entry of that array into the live physics world, so an evicted collider left in it comes back as an invisible wall.

- [ ] **Step 1: Write the failing test**

Create `scripts/tests/maze-chunks.test.mjs`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { Physics } from '../../src/physics/Physics.js';
import { MAZE, generateTopology, districtIndex } from '../../src/worlds/maze/MazeTopology.js';
import { MazeChunks } from '../../src/worlds/maze/MazeChunks.js';

function harness(seed = 2026) {
  const t = generateTopology(seed, { levels: 1 });
  const physics = new Physics(null);
  const group = new THREE.Group();
  // Stand in for the World: MazeChunks reads `physics` and `colliders` off it
  // on every call, because WorldManager swaps them mid-build.
  const world = { physics, colliders: [] };
  const materials = {
    hedge: new THREE.MeshStandardMaterial(),
    floor: new THREE.MeshStandardMaterial(),
  };
  const chunks = new MazeChunks({ world, cells: t.cells, group, materials });
  return { t, physics, group, world, colliders: world.colliders, chunks, materials };
}

test('chunks follow the world when its physics instance is swapped', () => {
  /* WorldManager builds a world against a scratch Physics and restores the real
   * one afterwards. A MazeChunks that captured `physics` in its constructor
   * would keep streaming into the discarded scratch world, and every district
   * loaded after arrival would be walk-through-able. */
  const { chunks, world } = harness();
  chunks.ensure(districtIndex(1, 1, 0));
  const scratch = world.physics;
  assert.ok(scratch.colliders.length > 0);

  const live = new Physics(null);
  world.physics = live;                       // the swap WorldManager performs
  chunks.ensure(districtIndex(2, 1, 0));

  assert.ok(live.colliders.length > 0, 'new chunk did not reach the live physics world');
  assert.equal(scratch.colliders.length, chunks._resident.get(districtIndex(1, 1, 0)).colliders.length,
    'the old chunk should still be accounted for in the scratch world');
});

test('ensure builds a district exactly once', () => {
  const { physics, chunks } = harness();
  const key = districtIndex(3, 4, 0);
  chunks.ensure(key);
  const after = physics.colliders.length;
  assert.ok(after > 0, 'no colliders registered');
  chunks.ensure(key);
  assert.equal(physics.colliders.length, after, 'second ensure rebuilt the district');
  assert.deepEqual(chunks.residentKeys(), [key]);
});

test('drop releases every collider and mesh it added', () => {
  const { physics, group, colliders, chunks } = harness();
  const key = districtIndex(3, 4, 0);
  chunks.ensure(key);
  assert.ok(physics.colliders.length > 0);
  assert.equal(colliders.length, physics.colliders.length, 'world array out of step');
  chunks.drop(key);
  assert.equal(physics.colliders.length, 0, 'colliders leaked');
  assert.equal(colliders.length, 0, 'world collider array leaked');
  assert.equal(group.children.length, 0, 'meshes leaked');
  assert.deepEqual(chunks.residentKeys(), []);
  assert.equal(physics._grid.size, 0, 'broadphase buckets leaked');
});

test('dropping an absent district is a no-op', () => {
  const { physics, chunks } = harness();
  chunks.drop(districtIndex(9, 9, 0));
  assert.equal(physics.colliders.length, 0);
});

test('add and drop repeatedly does not leak', () => {
  const { physics, group, colliders, chunks } = harness();
  const key = districtIndex(6, 6, 0);
  for (let i = 0; i < 50; i++) { chunks.ensure(key); chunks.drop(key); }
  assert.equal(physics.colliders.length, 0);
  assert.equal(colliders.length, 0);
  assert.equal(group.children.length, 0);
  assert.equal(physics._grid.size, 0);
});

test('chunks share the world material set rather than allocating their own', () => {
  const { group, chunks, materials } = harness();
  chunks.ensure(districtIndex(1, 1, 0));
  chunks.ensure(districtIndex(2, 1, 0));
  const used = new Set();
  group.traverse((o) => { if (o.material) used.add(o.material); });
  for (const m of used) {
    assert.ok(m === materials.hedge || m === materials.floor,
      'a chunk allocated its own material');
  }
});

test('a resident district is solid and has floor', () => {
  const { physics, chunks } = harness();
  chunks.ensure(districtIndex(2, 2, 0));
  // Centre of that district, in world metres.
  const x = (2 * MAZE.DISTRICT + 10) * MAZE.CELL;
  const z = (2 * MAZE.DISTRICT + 10) * MAZE.CELL;
  assert.notEqual(physics.groundHeight(x, z, 5, 12), null, 'no floor in a resident district');
});

test('a dropped district has no floor left behind', () => {
  const { physics, chunks } = harness();
  const key = districtIndex(2, 2, 0);
  chunks.ensure(key);
  const x = (2 * MAZE.DISTRICT + 10) * MAZE.CELL;
  const z = (2 * MAZE.DISTRICT + 10) * MAZE.CELL;
  chunks.drop(key);
  assert.equal(physics.groundHeight(x, z, 5, 12), null, 'floor survived the drop');
});

test('disposeAll clears everything', () => {
  const { physics, group, colliders, chunks } = harness();
  for (const k of [districtIndex(0,0,0), districtIndex(1,0,0), districtIndex(0,1,0)]) chunks.ensure(k);
  chunks.disposeAll();
  assert.equal(physics.colliders.length, 0);
  assert.equal(colliders.length, 0);
  assert.equal(group.children.length, 0);
  assert.deepEqual(chunks.residentKeys(), []);
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npm test`

Expected: FAIL — `Cannot find module .../MazeChunks.js`.

- [ ] **Step 3: Write the implementation**

Create `src/worlds/maze/MazeChunks.js`:

```js
import * as THREE from 'three';
import { districtCoords } from './MazeTopology.js';
import { districtColliders } from './MazeColliders.js';

/**
 * District-level streaming for the maze.
 *
 * A district is 120 m square and about 800 hedge segments. Building all 400 of
 * them up front cost ~176,000 colliders and ~170 MB for a single level, which
 * is affordable exactly once and not at all across four levels. This holds a
 * small resident set instead and releases the rest.
 *
 * Two details are load-bearing:
 *
 * 1. **Colliders come from descriptors, never from meshes.** `districtColliders`
 *    returns plain numbers, and this class turns each descriptor into both a
 *    physics box and an instance matrix. That separation is what lets the
 *    containment gate assemble a collision world under Node with no renderer.
 *
 * 2. **The world's collider array is kept in step.** `WorldManager._activate`
 *    re-registers every entry of `world.colliders` into the live physics world.
 *    A collider evicted from physics but left in that array would be resurrected
 *    on the next activation as an invisible wall.
 */
export class MazeChunks {
  /**
   * @param {{ world: { physics: any, colliders: any[] }, cells: Uint8Array,
   *           group: THREE.Group,
   *           materials: { hedge: THREE.Material, floor: THREE.Material } }} ctx
   */
  constructor({ world, cells, group, materials }) {
    /* The WORLD, not its physics. WorldManager swaps `world.physics` to a
     * throwaway scratch instance for the duration of build() and restores the
     * real one afterwards - and this class is constructed inside build(). A
     * captured reference would be the scratch world, so every district streamed
     * in after arrival would register into a discarded object and the player
     * would walk through it. Resolved per call, deliberately. */
    this.world = world;
    this.cells = cells;
    this.group = group;
    this.materials = materials;
    /** @type {Map<number, { meshes: THREE.InstancedMesh[], colliders: any[] }>} */
    this._resident = new Map();
  }

  /** Live physics world. Never cache this — see the constructor. */
  get physics() {
    return this.world.physics;
  }

  /** The world's own collider array, kept in step so activation cannot resurrect evictions. */
  get worldColliders() {
    return this.world.colliders;
  }

  /** Sorted, so two residency sets compare equal. */
  residentKeys() {
    return [...this._resident.keys()].sort((a, b) => a - b);
  }

  colliderCount() {
    let n = 0;
    for (const c of this._resident.values()) n += c.colliders.length;
    return n;
  }

  /** Build a district if it is not already resident. */
  ensure(key) {
    if (this._resident.has(key)) return;
    const { dx, dz, level } = districtCoords(key);
    const descs = districtColliders(this.cells, dx, dz, level);

    const colliders = [];
    for (const d of descs) {
      const c = this.physics.addBox(d.cx, d.cy, d.cz, d.hx, d.hy, d.hz);
      colliders.push(c);
      this.worldColliders.push(c);
    }

    const meshes = [];
    for (const [kind, material] of [['hedge', this.materials.hedge], ['floor', this.materials.floor]]) {
      const of = descs.filter((d) => d.kind === kind);
      if (of.length === 0) continue;
      meshes.push(this._instance(of, material, `maze:${kind}:${key}`));
    }

    this._resident.set(key, { meshes, colliders });
  }

  /** Release a district. Safe to call for one that is not resident. */
  drop(key) {
    const entry = this._resident.get(key);
    if (!entry) return;

    for (const c of entry.colliders) {
      this.physics.remove(c);
      const at = this.worldColliders.indexOf(c);
      if (at >= 0) this.worldColliders.splice(at, 1);
    }

    for (const m of entry.meshes) {
      this.group.remove(m);
      m.geometry.dispose();
      /* InstancedMesh's instanceMatrix buffer is only released through the
       * mesh's own dispose event - geometry.dispose() alone strands it, at
       * 64 bytes per instance. */
      m.dispose();
    }

    this._resident.delete(key);
  }

  disposeAll() {
    for (const key of [...this._resident.keys()]) this.drop(key);
  }

  /** One InstancedMesh from a list of box descriptors. */
  _instance(descs, material, name) {
    const geo = new THREE.BoxGeometry(1, 1, 1);
    const mesh = new THREE.InstancedMesh(geo, material, descs.length);
    mesh.name = name;
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const pos = new THREE.Vector3();
    const scale = new THREE.Vector3();
    for (let i = 0; i < descs.length; i++) {
      const d = descs[i];
      pos.set(d.cx, d.cy, d.cz);
      scale.set(d.hx * 2, d.hy * 2, d.hz * 2);
      m.compose(pos, q, scale);
      mesh.setMatrixAt(i, m);
    }
    mesh.instanceMatrix.needsUpdate = true;
    this.group.add(mesh);
    return mesh;
  }
}
```

- [ ] **Step 4: Run the tests**

Run: `npm test`

Expected: PASS — 8 tests in `maze-chunks.test.mjs`.

- [ ] **Step 5: Commit**

```bash
git add src/worlds/maze/MazeChunks.js scripts/tests/maze-chunks.test.mjs
git commit -m "Build a district on demand, and give it all back on the way out

Phase 1 built all four hundred districts up front: 176,000 colliders and about
170 MB for a single level. Affordable exactly once, and not at all across four.

Two things here are easy to get subtly wrong and are pinned by tests. Dropping
a chunk splices the world's own collider array as well as the physics world,
because WorldManager re-registers that array on every activation - an eviction
left in it comes back as an invisible wall. And InstancedMesh.dispose() runs
alongside geometry.dispose(), because the instanceMatrix buffer is released
only through the mesh's own dispose event, at 64 bytes per instance."
```

---

### Task 4: Residency in motion

**Files:**
- Modify: `src/worlds/maze/MazeChunks.js` (append a method)
- Modify: `scripts/tests/maze-chunks.test.mjs` (append)

**Interfaces:**
- Consumes: everything from Task 3, plus `districtAtWorld` / `neighbourhoodKeys` from Task 2.
- Produces: `MazeChunks.prototype.updateResidency(x, z, level, radius = 2): boolean` — returns true when the resident set changed.

- [ ] **Step 1: Write the failing test**

Append to `scripts/tests/maze-chunks.test.mjs`:

```js
import { districtAtWorld, neighbourhoodKeys, DISTRICT_SPAN } from '../../src/worlds/maze/MazeTopology.js';

test('updateResidency loads exactly the neighbourhood', () => {
  const { chunks } = harness();
  const x = 10.5 * DISTRICT_SPAN;
  const z = 10.5 * DISTRICT_SPAN;
  chunks.updateResidency(x, z, 0, 2);
  const want = neighbourhoodKeys(districtAtWorld(x, z, 0), 2);
  assert.deepEqual(chunks.residentKeys(), want);
  assert.equal(want.length, 25);
});

test('updateResidency is idempotent and reports no change', () => {
  const { chunks, physics } = harness();
  const x = 10.5 * DISTRICT_SPAN, z = 10.5 * DISTRICT_SPAN;
  assert.equal(chunks.updateResidency(x, z, 0, 2), true, 'first call must load');
  const n = physics.colliders.length;
  assert.equal(chunks.updateResidency(x, z, 0, 2), false, 'second call must be a no-op');
  assert.equal(physics.colliders.length, n);
});

test('walking one district over evicts the trailing column and loads the leading one', () => {
  const { chunks } = harness();
  const z = 10.5 * DISTRICT_SPAN;
  chunks.updateResidency(10.5 * DISTRICT_SPAN, z, 0, 2);
  const before = new Set(chunks.residentKeys());
  chunks.updateResidency(11.5 * DISTRICT_SPAN, z, 0, 2);
  const after = new Set(chunks.residentKeys());
  assert.equal(after.size, 25);
  const added = [...after].filter((k) => !before.has(k));
  const removed = [...before].filter((k) => !after.has(k));
  assert.equal(added.length, 5, `expected one new column, got ${added.length}`);
  assert.equal(removed.length, 5, `expected one dropped column, got ${removed.length}`);
});

test('residency never exceeds the neighbourhood, however far the player walks', () => {
  const { chunks, physics } = harness();
  let peak = 0;
  for (let i = 0; i < 20; i++) {
    chunks.updateResidency((2 + i) * DISTRICT_SPAN, (2 + i * 0.5) * DISTRICT_SPAN, 0, 2);
    peak = Math.max(peak, chunks.residentKeys().length);
    assert.ok(chunks.residentKeys().length <= 25, 'resident set grew past the neighbourhood');
  }
  assert.ok(peak > 0);
  // Physics must hold exactly what the resident chunks hold, nothing stranded.
  assert.equal(physics.colliders.length, chunks.colliderCount());
});

test('a long walk leaves no orphaned colliders or buckets', () => {
  const { chunks, physics, colliders, group } = harness();
  for (let i = 0; i < 30; i++) chunks.updateResidency(i * 0.6 * DISTRICT_SPAN, i * 0.4 * DISTRICT_SPAN, 0, 2);
  assert.equal(physics.colliders.length, chunks.colliderCount());
  assert.equal(colliders.length, physics.colliders.length);
  const meshCount = chunks.residentKeys().length * 2; // hedges + floor per district
  assert.ok(group.children.length <= meshCount, `mesh leak: ${group.children.length}`);
  chunks.disposeAll();
  assert.equal(physics.colliders.length, 0);
  assert.equal(physics._grid.size, 0);
  assert.equal(group.children.length, 0);
});

test('the ground stays continuous while walking across district seams', () => {
  const { chunks, physics } = harness();
  // Walk east along the middle of the grid, sampling under the player.
  for (let x = 3 * DISTRICT_SPAN; x < 8 * DISTRICT_SPAN; x += 5) {
    const z = 5.5 * DISTRICT_SPAN;
    chunks.updateResidency(x, z, 0, 2);
    assert.notEqual(physics.groundHeight(x, z, 5, 12), null, `hole under the player at x=${x}`);
  }
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npm test`

Expected: FAIL — `chunks.updateResidency is not a function`.

- [ ] **Step 3: Write the implementation**

Append to `src/worlds/maze/MazeChunks.js`, inside the class:

```js
  /**
   * Bring the resident set in line with where the player is standing.
   *
   * Drops before it loads, so peak memory is the neighbourhood rather than the
   * neighbourhood plus the column being replaced.
   *
   * @param {number} x world metres
   * @param {number} z world metres
   * @param {number} level
   * @param {number} [radius] districts either side; 2 gives the 5x5 block
   * @returns {boolean} true when the set changed
   */
  updateResidency(x, z, level, radius = 2) {
    const want = neighbourhoodKeys(districtAtWorld(x, z, level), radius);
    const wanted = new Set(want);

    let changed = false;
    for (const key of [...this._resident.keys()]) {
      if (!wanted.has(key)) { this.drop(key); changed = true; }
    }
    for (const key of want) {
      if (!this._resident.has(key)) { this.ensure(key); changed = true; }
    }
    return changed;
  }
```

and extend the import at the top of the file:

```js
import { districtCoords, districtAtWorld, neighbourhoodKeys } from './MazeTopology.js';
```

- [ ] **Step 4: Run the tests**

Run: `npm test`

Expected: PASS — 6 more tests in `maze-chunks.test.mjs`.

- [ ] **Step 5: Commit**

```bash
git add src/worlds/maze/MazeChunks.js scripts/tests/maze-chunks.test.mjs
git commit -m "Follow the player, and hold nothing else

Residency drops before it loads, so the peak is the neighbourhood rather than
the neighbourhood plus whichever column is being replaced.

The test that matters most is the last one: walking five districts east and
sampling the ground under every step. A streamed world's characteristic failure
is not a visible seam, it is a hole that only exists for the frame you cross
it in."
```

---

### Task 5: Wire streaming into the world

**Files:**
- Modify: `src/worlds/MazeWorld.js` — `build()` (~line 231), `update()` (~line 432), `dispose()` (~line 523)
- Modify: `scripts/tests/maze-entrance.test.mjs` (append)

**Interfaces:**
- Consumes: `MazeChunks` from Tasks 3-4.
- Produces: `MazeWorld.prototype.chunks` — the live `MazeChunks` instance, so tests and the dev harness can inspect residency.

**What changes:** `build()` stops iterating all 400 districts. It builds the topology, the forecourt, the centre stack, the tokens and the NPC spawns exactly as now, then creates the chunk manager and loads only the neighbourhood around the spawn. `update()` calls `updateResidency` with the player's position. `dispose()` calls `disposeAll()`.

**What must NOT change:** the forecourt, the entrance corridor carve, the centre stack, the tokens and the NPC spawns are all authored per-build and are not streamed. The forecourt in particular is hand-authored geometry outside the district grid — it must stay resident for the whole visit, or the player falls through the floor they arrived on.

- [ ] **Step 1: Write the failing test**

Append to `scripts/tests/maze-entrance.test.mjs`:

```js
import { MAZE, districtAtWorld, neighbourhoodKeys, DISTRICT_SPAN } from '../../src/worlds/maze/MazeTopology.js';

test('a freshly built maze streams rather than building everything', async () => {
  const { world, physics } = await buildMazeWorld();   // existing helper in this file
  assert.ok(world.chunks, 'MazeWorld exposes no chunk manager');
  const resident = world.chunks.residentKeys().length;
  assert.ok(resident > 0 && resident <= 25, `resident districts out of range: ${resident}`);
  // Phase 1 registered ~161,000 colliders. Streaming must be a fraction of that.
  assert.ok(physics.colliders.length < 40000,
    `still building the whole level: ${physics.colliders.length} colliders`);
});

test('the forecourt is visible, not just solid', async () => {
  /* The forecourt needs meshes as well as colliders. Streaming the districts
   * makes it tempting to drop the instancing along with the district loop,
   * which leaves the player arriving in a void enclosed by invisible walls. */
  const { world } = await buildMazeWorld();
  const names = [];
  world.group.traverse((o) => { if (o.isInstancedMesh) names.push(o.name); });
  assert.ok(names.some((n) => /forecourt/.test(n)), `no forecourt meshes: ${names.join(', ')}`);
});

test('the forecourt survives streaming', async () => {
  const { world, physics } = await buildMazeWorld();
  // Walk far away, then check the arrival point still has floor - the forecourt
  // is authored geometry outside the district grid and must never be evicted.
  world.update(0.016);
  const spec = world.portalSpecs[0];
  const arrivalZ = spec.position.z + 2.6;
  world.chunks.updateResidency(10 * DISTRICT_SPAN, 10 * DISTRICT_SPAN, 0, 2);
  assert.notEqual(
    physics.groundHeight(spec.position.x, arrivalZ, 5, 12), null,
    'the forecourt was evicted',
  );
});

test('walking the maze keeps residency bounded', async () => {
  const { world, physics } = await buildMazeWorld();
  const p = world.ctx.player.position;
  let peak = 0;
  for (let i = 0; i < 15; i++) {
    p.set((2 + i) * DISTRICT_SPAN * 0.7, 0.05, (2 + i) * DISTRICT_SPAN * 0.5);
    world.update(0.016);
    peak = Math.max(peak, world.chunks.residentKeys().length);
  }
  assert.ok(peak <= 25, `residency peaked at ${peak}`);
  assert.ok(physics.colliders.length < 40000, `collider count grew to ${physics.colliders.length}`);
});
```

`scripts/tests/maze-entrance.test.mjs` has **no** such helper today — checked. Add it at the top of the file, and note the ctx must carry a `player`, because `MazeWorld.update()` reads `this.ctx.player?.position` to drive residency:

```js
import * as THREE from 'three';
import { Physics } from '../../src/physics/Physics.js';
import { MazeWorld } from '../../src/worlds/MazeWorld.js';

/** Build a MazeWorld headlessly. The ctx needs a player: update() steers residency from it. */
async function buildMazeWorld() {
  const physics = new Physics(null);
  const world = new MazeWorld({
    scene: new THREE.Scene(),
    engine: null,
    physics,
    bus: null,
    materials: null,
    player: { position: new THREE.Vector3() },
  });
  await world.build(() => {});
  return { world, physics };
}
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npm test`

Expected: FAIL — `MazeWorld exposes no chunk manager`.

- [ ] **Step 3: Replace the up-front district build**

In `src/worlds/MazeWorld.js`, add the import:

```js
import { MazeChunks } from './maze/MazeChunks.js';
```

In `build()`, delete **only** the loop that walks all 400 districts collecting `districtColliders` into `descs`.

**Keep `_addInstanced` and both of its calls.** They now receive the forecourt descriptors alone. This is the trap in this task: the forecourt is authored geometry, not a chunk, and it needs *both* colliders and meshes. Deleting the `_addInstanced` calls along with the district loop would leave the forecourt solid but invisible — the player arrives in an empty void enclosed by walls they cannot see. So `descs` becomes just:

```js
    /* Districts stream (see this.chunks below). The forecourt does not: it is
     * hand-authored, sits outside the cell grid in negative z, and is the floor
     * the player arrives on. It needs meshes as well as colliders. */
    const descs = [];
    for (const d of forecourtColliders(ew.x, e.level)) descs.push(d);

    const hedges = descs.filter((d) => d.kind === 'hedge');
    const floors = descs.filter((d) => d.kind === 'floor');
    this._addInstanced(hedges, mats.hedge, 'maze:forecourt-hedges');
    this._addInstanced(floors, mats.floor, 'maze:forecourt-floor');

    for (const d of descs) {
      this.track(this.physics.addBox(d.cx, d.cy, d.cz, d.hx, d.hy, d.hz));
    }
```

Then, after the spawn is set:

```js
    /* Districts stream; everything else in this world does not. The forecourt,
     * the centre stack, the tokens and the NPC spawns are authored per build and
     * stay for the whole visit - the forecourt especially, since it is the floor
     * the player arrives on and lives outside the district grid entirely. */
    this.chunks = new MazeChunks({
      world: this,          // NOT this.physics — see the note in MazeChunks
      cells: this.cells,
      group: this.group,
      materials: mats,
    });

    const spawn = this.playerSpawn;
    this.chunks.updateResidency(spawn.x, spawn.z, 0, RESIDENCY_RADIUS);
```

with, near the top of the file:

```js
/** Districts either side of the player. 2 gives the 5x5 block the spec calls for. */
const RESIDENCY_RADIUS = 2;
```

- [ ] **Step 4: Drive residency from `update()`**

At the top of `MazeWorld.update(dt)`, before the existing token logic:

```js
    const player = this.ctx.player?.position;
    if (player && this.chunks) {
      this.chunks.updateResidency(player.x, player.z, 0, RESIDENCY_RADIUS);
    }
```

Note `update()` currently returns early when there are no tokens (`if (!this._tokenMesh || this._tokens.length === 0) return;`). Move the residency call **above** that guard, or streaming stops the moment every token is collected.

- [ ] **Step 5: Release chunks on dispose**

In `dispose()`, before the existing traverse:

```js
    this.chunks?.disposeAll();
    this.chunks = null;
```

- [ ] **Step 6: Run the tests and the gates**

Run: `npm test`

Expected: PASS.

Run: `node scripts/contract-check.mjs` — add `src/worlds/maze/MazeChunks.js` to its `CONTRACT` array with exports `['MazeChunks']`.

Run: `npm run build`

- [ ] **Step 7: Commit**

```bash
git add src/worlds/MazeWorld.js src/worlds/maze/MazeChunks.js scripts/contract-check.mjs scripts/tests/maze-entrance.test.mjs
git commit -m "Stream the districts, keep the forecourt

The maze no longer builds four hundred districts to let you stand in one. What
stays authored is everything outside the district grid: the forecourt, the
centre stack, the tokens and the people.

The forecourt is the one that would have been easy to get wrong. It is the
floor the player arrives on, it sits in negative z outside the cell grid, and
if it were ever treated as a chunk the first thing a returning player would do
is fall through it.

The residency call goes above update()'s token guard, not below. Collect every
token and the guard returns early - which would have quietly stopped the world
streaming at the exact moment a player had explored enough to need it."
```

---

### Task 6: Prove it in the browser

**Files:**
- Modify: `src/dev/Harness.js` — add maze views and a residency probe

**Interfaces:**
- Consumes: `MazeWorld.chunks`.
- Produces: `harness.mazeStats()` returning `{ seed, residentDistricts, colliders, programs }`.

Streaming's real gates are performance ones, and they need a real WebGL context. This task adds the probe; the measurement is run by the controller.

- [ ] **Step 1: Add the probe**

In `src/dev/Harness.js`, add to the harness object:

```js
  /** Streaming diagnostics for the maze. Dev-only. */
  mazeStats() {
    const w = this.game.worldManager.active;
    if (w?.id !== 'maze') return { world: w?.id ?? null, note: 'not in the maze' };
    return {
      seed: w.seed,
      residentDistricts: w.chunks?.residentKeys().length ?? 0,
      colliders: this.game.physics.colliders.length,
      programs: this.game.engine.renderer.info.programs.length,
      drawCalls: this.game.engine.renderer.info.render.calls,
    };
  },
```

- [ ] **Step 2: Add maze camera views**

In the same file's `VIEWS` map, add a `maze` entry so visual review has framings that are not guesswork. The entrance forecourt is at `x = 1260`, `z ≈ -10`; the maze grid runs from the origin to 2394 m on both axes:

```js
  maze: [
    { name: 'forecourt', pos: [1260, 4, -16], look: [1260, 2, 20], fov: 75 },
    { name: 'corridor', pos: [1260, 1.7, 40], look: [1260, 1.7, 120], fov: 75 },
    { name: 'above-entrance', pos: [1260, 60, -40], look: [1260, 0, 200], fov: 70 },
  ],
```

- [ ] **Step 3: Verify manually**

Run `npm run dev`, open `http://localhost:5173/game/?dev=1&autostart=1&world=maze`, and in the console:

```js
GAME.harness.mazeStats()
```

Expected: `residentDistricts` at most 25, `colliders` well under 40,000 (Phase 1 was ~161,000).

Then walk with `W` for ten seconds and call it again — `residentDistricts` stays bounded and `colliders` stays flat rather than climbing.

- [ ] **Step 4: Commit**

```bash
git add src/dev/Harness.js
git commit -m "Give the harness a way to see the streaming

Residency and collider count are the two numbers that say whether streaming is
working, and neither is visible from a screenshot. Three maze framings as well,
derived from the world's actual entrance coordinates rather than guessed, so a
visual review looks at the maze instead of at a hedge."
```

---

## Phase 2a exit criteria

- [ ] `npm test` passes; `MAZE_SEEDS=1000 npm test` passes.
- [ ] `node scripts/contract-check.mjs` exits 0; `npm run build` succeeds.
- [ ] `GAME.harness.mazeStats()` reports **at most 25 resident districts** and **under 40,000 colliders** (Phase 1: ~161,000).
- [ ] Walking for 60 s leaves collider count flat, not climbing.
- [ ] Portal entry from the station stays **under 3 s**.
- [ ] `renderer.info.programs.length` does not grow across ten consecutive maze entries — materials are still shared.
- [ ] No hole in the floor anywhere along a 2 km walk.
- [ ] The four other worlds are unaffected.

## What Phase 2a knowingly does not do

- **Still one level.** Levels 1-3, the stairs, tunnels and lifts that reach them, and the canopy LOD are Phase 2b.
- **No distant LOD.** Beyond the resident 5×5 the world simply ends; at ground level the hedges hide it, but from any elevation it will be visible. Phase 2b's canopy fixes this, and it is why the level work and the LOD work belong in the same plan.
- **No async chunk building.** Each district builds synchronously in one frame. Measured at ~400 ms for a full 400-district level in Phase 1, a single district is well under a frame, but this should be re-measured under real load rather than assumed.
