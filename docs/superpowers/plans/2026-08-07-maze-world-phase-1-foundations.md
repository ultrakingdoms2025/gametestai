# Maze World — Phase 1: Foundations Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Portal from the station into a real, re-rolling, walkable single-level maze with a credit stack at its centre — ugly but correct, and guarded by headless tests that prove it is always solvable and that the player can never leave the path.

**Architecture:** Maze topology is generated as a pure, seeded `Uint8Array` of wall bits with no THREE and no DOM, which makes it unit-testable under Node. Geometry and physics colliders are derived from that array; collider *descriptors* are emitted separately from meshes so a collision world can be assembled headlessly and driven through `Physics.resolveCapsule` for containment testing. A new world-rules layer gates the dozen systems that would otherwise populate the maze with loot, merchants and quests.

**Tech Stack:** Three.js 0.185.1, Vite 8, vanilla ES modules. Tests use Node's built-in `node:test` runner — **no new dependencies**.

## Global Constraints

Copied verbatim from `docs/superpowers/specs/2026-08-07-maze-world-design.md`. Every task's requirements implicitly include this section.

- **Cell pitch 6.0 m. Corridor width 4.8 m. Hedge thickness 1.2 m. Hedge height 5.0 m.**
- **District = 20 × 20 cells. 20 × 20 districts per level. 4 levels. 400 × 400 cells per level. 640,000 cells total. Footprint 2.4 km × 2.4 km.**
- **A hop clears exactly 0.93 m** (`jumpVelocity 6.4`, `gravity -22`). `stepHeight` is `0.45`.
- **The anti-exploit rule:** no collidable surface may present a standable top between **0.45 m and 5.0 m** within **2 m** of any hedge or wall.
- **Jump is retained.** `rules.jump = true`. Disabling climbing does not disable jumping.
- **The centre reward is 100 credits. Final.** Not scaled by maze size or completion time.
- **`MazeTopology.js` must stay pure** — no THREE, no DOM, no browser API. This is what makes the headless gates possible.
- **`MazeChunks.js` must emit collider descriptors separately from meshes.** Colliders must never be derivable only from built meshes.
- **Materials must be reused across re-rolls.** Reallocating materials per entry re-triggers shader compilation, which already dominates cold boot in this project.
- **No new npm dependencies.**
- Node's ESM loader runs these files directly; use `.js` extensions in all import specifiers.

## Scope: this is Phase 1 of 5

This plan delivers a walkable maze. It deliberately does **not** deliver streaming, four levels, the art pass, puzzles, or the map UI. Those are Phases 2–5, planned separately once Phase 1's interfaces are real rather than predicted.

Phase 1 builds **one level (level 0 only)** and builds **all 400 of its districts up front**. That is knowingly wrong for the final product and knowingly right for now: it removes streaming from the equation while the topology, rules and containment work is proven. Phase 2 replaces the up-front build with the chunk streamer and turns on levels 1–3.

---

### Task 1: Test infrastructure

**Files:**
- Create: `scripts/tests/smoke.test.mjs`
- Modify: `package.json` (scripts block, lines 7-13)

**Interfaces:**
- Consumes: nothing.
- Produces: `npm test` runs every `scripts/tests/*.test.mjs` under `node --test`. All later tasks depend on this command existing.

- [ ] **Step 1: Write the failing test**

Create `scripts/tests/smoke.test.mjs`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Physics } from '../../src/physics/Physics.js';

/* This project has no test framework by design: most of it touches document,
 * canvas or WebGL at module scope and cannot be imported under Node. Physics is
 * the exception - it imports only `three` and uses no DOM API - and the maze
 * spec requires MazeTopology to be pure for the same reason. This smoke test
 * pins that property, so if someone later adds a DOM import to Physics the
 * whole headless test tier fails loudly here rather than mysteriously
 * everywhere. */
test('Physics is importable and usable under Node', () => {
  const p = new Physics(null);
  p.addBox(0, 0, 0, 1, 1, 1);
  assert.equal(p.colliders.length, 1);
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npm test`

Expected: FAIL — `npm error Missing script: "test"`.

- [ ] **Step 3: Add the test script**

In `package.json`, inside `"scripts"`, add after `"preview"`:

```json
    "test": "node --test scripts/tests/",
    "test:watch": "node --test --watch scripts/tests/"
```

Remember the comma on the preceding `"preview"` line.

- [ ] **Step 4: Run it to verify it passes**

Run: `npm test`

Expected: PASS — `# pass 1`, `# fail 0`.

- [ ] **Step 5: Commit**

```bash
git add package.json scripts/tests/smoke.test.mjs
git commit -m "Give the project somewhere to put a test

No framework, no dependency: node --test was already in the runtime. The smoke
test exists to pin the one property the whole headless tier rests on - that
Physics can still be imported under Node - so that breaking it fails here
rather than everywhere."
```

---

### Task 2: Topology constants, indexing and hashing

**Files:**
- Create: `src/worlds/maze/MazeTopology.js`
- Create: `scripts/tests/maze-topology.test.mjs`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `MAZE` — frozen constants object.
  - `DIR` — `{ N:1, E:2, S:4, W:8, UP:16, DOWN:32 }`. A set bit means **passage open**, not wall present.
  - `OPPOSITE` — `{[dir:number]: number}`.
  - `STEP` — `{[dir:number]: [dx:number, dz:number]}` for the four horizontal directions.
  - `hash32(...ints: number[]): number` — deterministic uint32.
  - `mulberry32(seed: number): () => number` — RNG returning `[0,1)`.
  - `cellIndex(x: number, z: number, level: number): number`
  - `cellCoords(index: number): { x: number, z: number, level: number }`
  - `isOpen(cells: Uint8Array, index: number, dir: number): boolean`

- [ ] **Step 1: Write the failing test**

Create `scripts/tests/maze-topology.test.mjs`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  MAZE, DIR, OPPOSITE, STEP,
  hash32, mulberry32, cellIndex, cellCoords, isOpen,
} from '../../src/worlds/maze/MazeTopology.js';

test('constants match the spec', () => {
  assert.equal(MAZE.CELL, 6.0);
  assert.equal(MAZE.CORRIDOR, 4.8);
  assert.equal(MAZE.HEDGE_THICK, 1.2);
  assert.equal(MAZE.HEDGE_HEIGHT, 5.0);
  assert.equal(MAZE.DISTRICT, 20);
  assert.equal(MAZE.DISTRICTS, 20);
  assert.equal(MAZE.LEVELS, 4);
  // Corridor plus hedge must equal exactly one cell pitch, or the grid drifts.
  assert.equal(MAZE.CORRIDOR + MAZE.HEDGE_THICK, MAZE.CELL);
  assert.equal(MAZE.CELLS, MAZE.DISTRICT * MAZE.DISTRICTS);
  assert.equal(MAZE.LEVEL_CELLS, MAZE.CELLS * MAZE.CELLS);
  assert.equal(MAZE.TOTAL_CELLS, MAZE.LEVEL_CELLS * MAZE.LEVELS);
  assert.equal(MAZE.TOTAL_CELLS, 640000);
});

test('direction bits are distinct and opposites pair up', () => {
  const all = [DIR.N, DIR.E, DIR.S, DIR.W, DIR.UP, DIR.DOWN];
  assert.equal(new Set(all).size, 6);
  for (const d of all) assert.equal(OPPOSITE[OPPOSITE[d]], d);
  assert.equal(OPPOSITE[DIR.N], DIR.S);
  assert.equal(OPPOSITE[DIR.E], DIR.W);
  assert.equal(OPPOSITE[DIR.UP], DIR.DOWN);
});

test('N is -z and S is +z, E is +x and W is -x', () => {
  assert.deepEqual(STEP[DIR.N], [0, -1]);
  assert.deepEqual(STEP[DIR.S], [0, 1]);
  assert.deepEqual(STEP[DIR.E], [1, 0]);
  assert.deepEqual(STEP[DIR.W], [-1, 0]);
});

test('hash32 is deterministic, order-sensitive and unsigned', () => {
  assert.equal(hash32(1, 2, 3), hash32(1, 2, 3));
  assert.notEqual(hash32(1, 2, 3), hash32(3, 2, 1));
  for (let i = 0; i < 500; i++) {
    const h = hash32(i, i * 7, 99);
    assert.ok(h >= 0 && h <= 0xffffffff, `hash out of range: ${h}`);
    assert.ok(Number.isInteger(h));
  }
});

test('mulberry32 is deterministic and stays in [0,1)', () => {
  const a = mulberry32(12345);
  const b = mulberry32(12345);
  for (let i = 0; i < 200; i++) {
    const v = a();
    assert.equal(v, b());
    assert.ok(v >= 0 && v < 1, `rng out of range: ${v}`);
  }
});

test('mulberry32 is reasonably uniform', () => {
  const rng = mulberry32(999);
  const buckets = new Array(10).fill(0);
  for (let i = 0; i < 100000; i++) buckets[Math.floor(rng() * 10)]++;
  // 10k expected per bucket; allow +-15%.
  for (const b of buckets) assert.ok(b > 8500 && b < 11500, `skewed bucket: ${b}`);
});

test('cellIndex and cellCoords round-trip', () => {
  const cases = [
    { x: 0, z: 0, level: 0 },
    { x: 399, z: 399, level: 3 },
    { x: 17, z: 240, level: 2 },
  ];
  for (const c of cases) {
    const i = cellIndex(c.x, c.z, c.level);
    assert.ok(i >= 0 && i < MAZE.TOTAL_CELLS);
    assert.deepEqual(cellCoords(i), c);
  }
});

test('cellIndex is unique across a whole level', () => {
  const seen = new Set();
  for (let z = 0; z < MAZE.CELLS; z++) {
    for (let x = 0; x < MAZE.CELLS; x++) seen.add(cellIndex(x, z, 0));
  }
  assert.equal(seen.size, MAZE.LEVEL_CELLS);
});

test('isOpen reads passage bits', () => {
  const cells = new Uint8Array(4);
  cells[1] = DIR.N | DIR.W;
  assert.equal(isOpen(cells, 1, DIR.N), true);
  assert.equal(isOpen(cells, 1, DIR.W), true);
  assert.equal(isOpen(cells, 1, DIR.E), false);
  assert.equal(isOpen(cells, 0, DIR.N), false);
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npm test`

Expected: FAIL — `Cannot find module .../src/worlds/maze/MazeTopology.js`.

- [ ] **Step 3: Write the implementation**

Create `src/worlds/maze/MazeTopology.js`:

```js
/**
 * Maze topology - pure, seeded, and deliberately free of THREE and the DOM.
 *
 * That purity is not tidiness. It is what lets the solvability, reachability
 * and containment gates run under `node --test` in seconds instead of inside a
 * browser, in a project where almost nothing else can be imported by Node at
 * all. Nothing in this file may import a renderer, touch `document`, or reach
 * for `performance` - see docs/superpowers/specs/2026-08-07-maze-world-design.md
 * section 12.
 *
 * A cell is one byte. A SET bit means the passage is OPEN, not that a wall is
 * present - the array starts as solid rock and carving turns bits on.
 */

export const MAZE = Object.freeze({
  /** Grid pitch, metres. Corridor + hedge thickness must equal this exactly. */
  CELL: 6.0,
  CORRIDOR: 4.8,
  HEDGE_THICK: 1.2,
  HEDGE_HEIGHT: 5.0,
  /** Cells along one district edge. */
  DISTRICT: 20,
  /** Districts along one level edge. */
  DISTRICTS: 20,
  LEVELS: 4,
  /** Cells along one level edge = DISTRICT * DISTRICTS. */
  CELLS: 400,
  LEVEL_CELLS: 160000,
  TOTAL_CELLS: 640000,
  /** Vertical spacing between levels, metres. Clears a 5 m hedge plus headroom. */
  LEVEL_HEIGHT: 9.0,
});

/** Passage bits. N is -z, S is +z, E is +x, W is -x. */
export const DIR = Object.freeze({ N: 1, E: 2, S: 4, W: 8, UP: 16, DOWN: 32 });

export const OPPOSITE = Object.freeze({
  [DIR.N]: DIR.S, [DIR.S]: DIR.N,
  [DIR.E]: DIR.W, [DIR.W]: DIR.E,
  [DIR.UP]: DIR.DOWN, [DIR.DOWN]: DIR.UP,
});

/** Horizontal steps only. Vertical movement changes level, not x/z. */
export const STEP = Object.freeze({
  [DIR.N]: [0, -1],
  [DIR.E]: [1, 0],
  [DIR.S]: [0, 1],
  [DIR.W]: [-1, 0],
});

/** The four horizontal directions, in a fixed order. */
export const HORIZONTAL = Object.freeze([DIR.N, DIR.E, DIR.S, DIR.W]);

/**
 * FNV-1a over the bytes of each argument, finished with an avalanche mix.
 * Order-sensitive on purpose: hash32(a,b) must differ from hash32(b,a) so that
 * a district's seed cannot collide with its neighbour's.
 * @param {...number} ints
 * @returns {number} uint32
 */
export function hash32(...ints) {
  let h = 0x811c9dc5;
  for (let i = 0; i < ints.length; i++) {
    const v = ints[i] | 0;
    h ^= v & 0xff;          h = Math.imul(h, 0x01000193);
    h ^= (v >>> 8) & 0xff;  h = Math.imul(h, 0x01000193);
    h ^= (v >>> 16) & 0xff; h = Math.imul(h, 0x01000193);
    h ^= (v >>> 24) & 0xff; h = Math.imul(h, 0x01000193);
  }
  h ^= h >>> 16; h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13; h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return h >>> 0;
}

/**
 * Mulberry32. Small, fast, and good enough for level layout.
 * @param {number} seed
 * @returns {() => number} values in [0, 1)
 */
export function mulberry32(seed) {
  let s = seed >>> 0;
  return function next() {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), 1 | t);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** @returns {number} index into the cells array */
export function cellIndex(x, z, level) {
  return level * MAZE.LEVEL_CELLS + z * MAZE.CELLS + x;
}

/** @returns {{x:number, z:number, level:number}} */
export function cellCoords(index) {
  const level = Math.floor(index / MAZE.LEVEL_CELLS);
  const rem = index - level * MAZE.LEVEL_CELLS;
  const z = Math.floor(rem / MAZE.CELLS);
  return { x: rem - z * MAZE.CELLS, z, level };
}

/** True when x,z lie inside a level. */
export function inBounds(x, z) {
  return x >= 0 && z >= 0 && x < MAZE.CELLS && z < MAZE.CELLS;
}

/** True when the passage out of `index` in direction `dir` is open. */
export function isOpen(cells, index, dir) {
  return (cells[index] & dir) !== 0;
}
```

- [ ] **Step 4: Run it to verify it passes**

Run: `npm test`

Expected: PASS — 8 tests in `maze-topology.test.mjs`, plus the smoke test.

- [ ] **Step 5: Commit**

```bash
git add src/worlds/maze/MazeTopology.js scripts/tests/maze-topology.test.mjs
git commit -m "Lay out the maze grid, and pin what a set bit means

A set bit is an OPEN passage, not a wall - the array starts as solid rock and
carving turns bits on. Worth being explicit about, because the opposite
convention is just as natural and every function downstream would be quietly
inverted.

The corridor-plus-hedge-equals-one-cell assertion is not pedantry either: those
three numbers came from three different places in the spec, and if they ever
stop summing the whole grid drifts against the geometry by 20cm a cell."
```

---

### Task 3: The district graph

**Files:**
- Modify: `src/worlds/maze/MazeTopology.js` (append)
- Modify: `scripts/tests/maze-topology.test.mjs` (append)

**Interfaces:**
- Consumes: `MAZE`, `hash32`, `mulberry32` from Task 2.
- Produces:
  - `districtIndex(dx: number, dz: number, level: number): number`
  - `districtCoords(index: number): { dx: number, dz: number, level: number }`
  - `edgeKey(a: number, b: number): string` — canonical, `min|max`.
  - `buildDistrictGraph(seed: number): { open: Set<string>, entrance: {dx,dz,level}, centre: {dx,dz,level}, treeEdges: number, extraEdges: number }`
  - `isEdgeOpen(graph, aIndex: number, bIndex: number): boolean`

**Why a spanning tree.** Connectivity is *guaranteed by construction*, not discovered by testing. A depth-first spanning tree over the 6-neighbour district graph reaches every one of the 1,600 districts, so an entrance→centre route always exists before a single cell is carved. The tests verify the implementation, not the premise.

- [ ] **Step 1: Write the failing test**

Append to `scripts/tests/maze-topology.test.mjs`:

```js
import {
  districtIndex, districtCoords, edgeKey, buildDistrictGraph, isEdgeOpen,
} from '../../src/worlds/maze/MazeTopology.js';

const TOTAL_DISTRICTS = MAZE.DISTRICTS * MAZE.DISTRICTS * MAZE.LEVELS; // 1600

test('districtIndex round-trips and is unique', () => {
  const seen = new Set();
  for (let level = 0; level < MAZE.LEVELS; level++) {
    for (let dz = 0; dz < MAZE.DISTRICTS; dz++) {
      for (let dx = 0; dx < MAZE.DISTRICTS; dx++) {
        const i = districtIndex(dx, dz, level);
        seen.add(i);
        assert.deepEqual(districtCoords(i), { dx, dz, level });
      }
    }
  }
  assert.equal(seen.size, TOTAL_DISTRICTS);
});

test('edgeKey is canonical regardless of argument order', () => {
  assert.equal(edgeKey(5, 9), edgeKey(9, 5));
  assert.notEqual(edgeKey(5, 9), edgeKey(5, 10));
});

test('the district graph connects every district', () => {
  const graph = buildDistrictGraph(4242);
  // Flood fill the open edges from district 0 and demand we reach all 1600.
  const seen = new Uint8Array(TOTAL_DISTRICTS);
  const stack = [0];
  seen[0] = 1;
  let reached = 1;
  while (stack.length) {
    const cur = stack.pop();
    const { dx, dz, level } = districtCoords(cur);
    const neighbours = [
      [dx, dz - 1, level], [dx + 1, dz, level],
      [dx, dz + 1, level], [dx - 1, dz, level],
      [dx, dz, level - 1], [dx, dz, level + 1],
    ];
    for (const [nx, nz, nl] of neighbours) {
      if (nx < 0 || nz < 0 || nl < 0) continue;
      if (nx >= MAZE.DISTRICTS || nz >= MAZE.DISTRICTS || nl >= MAZE.LEVELS) continue;
      const n = districtIndex(nx, nz, nl);
      if (seen[n]) continue;
      if (!isEdgeOpen(graph, cur, n)) continue;
      seen[n] = 1;
      reached++;
      stack.push(n);
    }
  }
  assert.equal(reached, TOTAL_DISTRICTS, 'district graph is disconnected');
});

test('the graph is mostly a tree, with roughly 10% extra edges', () => {
  const graph = buildDistrictGraph(7);
  assert.equal(graph.treeEdges, TOTAL_DISTRICTS - 1, 'spanning tree must have n-1 edges');
  // ~10% of the *remaining* candidate edges. Loose bounds - this is a
  // character check, not an exact count.
  assert.ok(graph.extraEdges > 100, `too few loops: ${graph.extraEdges}`);
  assert.ok(graph.extraEdges < 700, `too many loops: ${graph.extraEdges}`);
});

test('entrance is fixed and centre is on a seed-chosen level', () => {
  const levels = new Set();
  for (let s = 0; s < 200; s++) {
    const g = buildDistrictGraph(s);
    assert.deepEqual(g.entrance, { dx: 10, dz: 0, level: 0 });
    assert.equal(g.centre.dx, 10);
    assert.equal(g.centre.dz, 10);
    levels.add(g.centre.level);
  }
  // The player must not be able to learn which level the prize is on.
  assert.ok(levels.size >= 3, `centre level barely varies: ${[...levels]}`);
});

test('the same seed always builds the same graph', () => {
  const a = buildDistrictGraph(31337);
  const b = buildDistrictGraph(31337);
  assert.deepEqual([...a.open].sort(), [...b.open].sort());
  const c = buildDistrictGraph(31338);
  assert.notDeepEqual([...a.open].sort(), [...c.open].sort());
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npm test`

Expected: FAIL — `The requested module ... does not provide an export named 'buildDistrictGraph'`.

- [ ] **Step 3: Write the implementation**

Append to `src/worlds/maze/MazeTopology.js`:

```js
/* ------------------------------------------------------------------ */
/* District graph                                                      */
/*                                                                     */
/* The maze is 640,000 cells, which is far too many to reason about as */
/* one connected structure every time it is generated. Instead the     */
/* 1,600 districts are connected first, by a spanning tree, and that   */
/* tree is what *guarantees* an entrance-to-centre route exists. The   */
/* cells inside each district are carved afterwards and independently. */
/* ------------------------------------------------------------------ */

const DISTRICTS_PER_LEVEL = MAZE.DISTRICTS * MAZE.DISTRICTS;
const TOTAL_DISTRICTS = DISTRICTS_PER_LEVEL * MAZE.LEVELS;

/** Fraction of non-tree candidate edges opened, to create loops. */
const EXTRA_EDGE_FRACTION = 0.10;

/**
 * How often a vertical neighbour is even considered during the walk.
 *
 * Vertical connections must be rare or the four levels read as one soup, but
 * they cannot be forbidden or the upper levels would be unreachable. Biasing
 * the *order* rather than pruning the edge keeps the graph connected by
 * construction: the walk still takes a vertical edge whenever a level has no
 * unvisited horizontal neighbours left, which is exactly when it must.
 */
const VERTICAL_BIAS = 0.12;

export function districtIndex(dx, dz, level) {
  return level * DISTRICTS_PER_LEVEL + dz * MAZE.DISTRICTS + dx;
}

export function districtCoords(index) {
  const level = Math.floor(index / DISTRICTS_PER_LEVEL);
  const rem = index - level * DISTRICTS_PER_LEVEL;
  const dz = Math.floor(rem / MAZE.DISTRICTS);
  return { dx: rem - dz * MAZE.DISTRICTS, dz, level };
}

/** Canonical undirected edge key. */
export function edgeKey(a, b) {
  return a < b ? `${a}|${b}` : `${b}|${a}`;
}

export function isEdgeOpen(graph, aIndex, bIndex) {
  return graph.open.has(edgeKey(aIndex, bIndex));
}

/** Six-neighbourhood of a district, in-bounds only. */
function districtNeighbours(index) {
  const { dx, dz, level } = districtCoords(index);
  const out = [];
  if (dz > 0) out.push({ i: districtIndex(dx, dz - 1, level), vertical: false });
  if (dx < MAZE.DISTRICTS - 1) out.push({ i: districtIndex(dx + 1, dz, level), vertical: false });
  if (dz < MAZE.DISTRICTS - 1) out.push({ i: districtIndex(dx, dz + 1, level), vertical: false });
  if (dx > 0) out.push({ i: districtIndex(dx - 1, dz, level), vertical: false });
  if (level > 0) out.push({ i: districtIndex(dx, dz, level - 1), vertical: true });
  if (level < MAZE.LEVELS - 1) out.push({ i: districtIndex(dx, dz, level + 1), vertical: true });
  return out;
}

/**
 * Build the district connectivity graph for a seed.
 *
 * @param {number} seed
 * @returns {{ open: Set<string>, entrance: {dx:number,dz:number,level:number},
 *             centre: {dx:number,dz:number,level:number},
 *             treeEdges: number, extraEdges: number }}
 */
export function buildDistrictGraph(seed) {
  const rng = mulberry32(hash32(seed, 0x6a11));
  const open = new Set();
  const visited = new Uint8Array(TOTAL_DISTRICTS);

  /* Iterative DFS. Recursion would blow the stack at 1,600 deep on some
   * engines, and this has to run on every entry. */
  const stack = [0];
  visited[0] = 1;
  let treeEdges = 0;

  while (stack.length) {
    const cur = stack[stack.length - 1];
    const candidates = districtNeighbours(cur).filter((n) => !visited[n.i]);
    if (candidates.length === 0) {
      stack.pop();
      continue;
    }
    // Horizontal first unless the bias roll says otherwise; vertical edges stay
    // rare without ever being unavailable.
    const horizontal = candidates.filter((c) => !c.vertical);
    const vertical = candidates.filter((c) => c.vertical);
    let pick;
    if (horizontal.length && (vertical.length === 0 || rng() > VERTICAL_BIAS)) {
      pick = horizontal[Math.floor(rng() * horizontal.length)];
    } else {
      pick = vertical[Math.floor(rng() * vertical.length)];
    }
    open.add(edgeKey(cur, pick.i));
    treeEdges++;
    visited[pick.i] = 1;
    stack.push(pick.i);
  }

  /* Loops. Walk every candidate edge once and open a fraction of the ones the
   * tree did not already use. Deterministic order, so the seed fully
   * determines the result. */
  let extraEdges = 0;
  for (let i = 0; i < TOTAL_DISTRICTS; i++) {
    for (const n of districtNeighbours(i)) {
      if (n.i < i) continue; // consider each undirected edge once
      const key = edgeKey(i, n.i);
      if (open.has(key)) continue;
      if (rng() < EXTRA_EDGE_FRACTION) {
        open.add(key);
        extraEdges++;
      }
    }
  }

  return {
    open,
    treeEdges,
    extraEdges,
    /* Fixed, so the forecourt is always in the same place and the return arch
     * can be authored rather than discovered. */
    entrance: { dx: 10, dz: 0, level: 0 },
    /* Horizontally central, but on a level the seed chooses - so not even
     * which floor the prize is on can be learned between runs. */
    centre: { dx: 10, dz: 10, level: hash32(seed, 0xc0ffee) % MAZE.LEVELS },
  };
}
```

- [ ] **Step 4: Run it to verify it passes**

Run: `npm test`

Expected: PASS — all `maze-topology.test.mjs` tests green.

- [ ] **Step 5: Commit**

```bash
git add src/worlds/maze/MazeTopology.js scripts/tests/maze-topology.test.mjs
git commit -m "Connect the 1,600 districts before carving a single cell

Solvability is guaranteed by construction here, not discovered by testing
later: a spanning tree over the district graph reaches every district, so an
entrance-to-centre route exists before any geometry is decided. The tests check
the implementation, not the premise.

Vertical links are made rare by biasing the walk order rather than by pruning
the edges. Pruning would have been the obvious move and would have silently
orphaned upper levels whenever a level's horizontal frontier ran out; biasing
still takes the vertical edge at exactly the moment it becomes necessary.

The centre's level comes from the seed, so a returning player cannot even learn
which floor the prize is on."
```

---

### Task 4: Carving district interiors

**Files:**
- Modify: `src/worlds/maze/MazeTopology.js` (append)
- Create: `scripts/tests/maze-carve.test.mjs`

**Interfaces:**
- Consumes: everything from Tasks 2 and 3.
- Produces:
  - `doorwayOffset(seed: number, aIndex: number, bIndex: number, span: number): number` — deterministic position along a shared border.
  - `carveDistrict(seed: number, graph: object, dx: number, dz: number, level: number, cells: Uint8Array): void` — writes only cells belonging to this district.

**The border-agreement trick.** Two neighbouring districts must agree on where their shared doorway sits, without either having seen the other. Both derive it from `hash32(seed, ...edgeKey)` — the *edge*, not the district — so each computes the same offset independently. That independence is what makes Phase 2's streaming possible at all.

- [ ] **Step 1: Write the failing test**

Create `scripts/tests/maze-carve.test.mjs`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  MAZE, DIR, STEP, HORIZONTAL, cellIndex, isOpen,
  districtIndex, buildDistrictGraph, isEdgeOpen,
  doorwayOffset, carveDistrict,
} from '../../src/worlds/maze/MazeTopology.js';

/** Flood fill within one district's 20x20 block; returns cells reached. */
function fillWithinDistrict(cells, dx, dz, level) {
  const x0 = dx * MAZE.DISTRICT;
  const z0 = dz * MAZE.DISTRICT;
  const seen = new Set();
  const start = cellIndex(x0, z0, level);
  const stack = [[x0, z0]];
  seen.add(start);
  while (stack.length) {
    const [x, z] = stack.pop();
    const idx = cellIndex(x, z, level);
    for (const dir of HORIZONTAL) {
      if (!isOpen(cells, idx, dir)) continue;
      const [sx, sz] = STEP[dir];
      const nx = x + sx;
      const nz = z + sz;
      // stay inside this district
      if (nx < x0 || nz < z0 || nx >= x0 + MAZE.DISTRICT || nz >= z0 + MAZE.DISTRICT) continue;
      const n = cellIndex(nx, nz, level);
      if (seen.has(n)) continue;
      seen.add(n);
      stack.push([nx, nz]);
    }
  }
  return seen.size;
}

test('doorwayOffset agrees regardless of argument order', () => {
  for (let i = 0; i < 100; i++) {
    const a = 17 + i;
    const b = 400 + i;
    assert.equal(doorwayOffset(5, a, b, 20), doorwayOffset(5, b, a, 20));
  }
});

test('doorwayOffset stays inside the span', () => {
  for (let i = 0; i < 500; i++) {
    const o = doorwayOffset(9, i, i + 1, MAZE.DISTRICT);
    assert.ok(o >= 0 && o < MAZE.DISTRICT, `offset out of range: ${o}`);
  }
});

test('a carved district is internally fully connected', () => {
  const graph = buildDistrictGraph(1234);
  const cells = new Uint8Array(MAZE.TOTAL_CELLS);
  carveDistrict(1234, graph, 3, 4, 0, cells);
  assert.equal(
    fillWithinDistrict(cells, 3, 4, 0),
    MAZE.DISTRICT * MAZE.DISTRICT,
    'district has unreachable cells',
  );
});

test('carving a district writes no cell outside it', () => {
  const graph = buildDistrictGraph(88);
  const cells = new Uint8Array(MAZE.TOTAL_CELLS);
  carveDistrict(88, graph, 5, 5, 0, cells);
  for (let z = 0; z < MAZE.CELLS; z++) {
    for (let x = 0; x < MAZE.CELLS; x++) {
      const inside = x >= 100 && x < 120 && z >= 100 && z < 120;
      if (inside) continue;
      assert.equal(cells[cellIndex(x, z, 0)], 0, `wrote outside district at ${x},${z}`);
    }
  }
});

test('neighbouring districts open the same doorway from both sides', () => {
  const seed = 555;
  const graph = buildDistrictGraph(seed);
  const cells = new Uint8Array(MAZE.TOTAL_CELLS);

  // Find an open east-west district edge on level 0.
  let found = null;
  for (let dz = 0; dz < MAZE.DISTRICTS && !found; dz++) {
    for (let dx = 0; dx < MAZE.DISTRICTS - 1; dx++) {
      const a = districtIndex(dx, dz, 0);
      const b = districtIndex(dx + 1, dz, 0);
      if (isEdgeOpen(graph, a, b)) { found = { dx, dz }; break; }
    }
  }
  assert.ok(found, 'no open east-west edge on level 0');

  carveDistrict(seed, graph, found.dx, found.dz, 0, cells);
  carveDistrict(seed, graph, found.dx + 1, found.dz, 0, cells);

  const border = found.dx * MAZE.DISTRICT + MAZE.DISTRICT - 1; // last column of left district
  let pairs = 0;
  for (let z = found.dz * MAZE.DISTRICT; z < found.dz * MAZE.DISTRICT + MAZE.DISTRICT; z++) {
    const left = cellIndex(border, z, 0);
    const right = cellIndex(border + 1, z, 0);
    const lOpen = isOpen(cells, left, DIR.E);
    const rOpen = isOpen(cells, right, DIR.W);
    assert.equal(lOpen, rOpen, `border disagrees at z=${z}`);
    if (lOpen) pairs++;
  }
  assert.equal(pairs, 1, `expected exactly one doorway, got ${pairs}`);
});

test('a closed district edge leaves a solid border', () => {
  const seed = 202;
  const graph = buildDistrictGraph(seed);
  const cells = new Uint8Array(MAZE.TOTAL_CELLS);

  let found = null;
  for (let dz = 0; dz < MAZE.DISTRICTS && !found; dz++) {
    for (let dx = 0; dx < MAZE.DISTRICTS - 1; dx++) {
      const a = districtIndex(dx, dz, 0);
      const b = districtIndex(dx + 1, dz, 0);
      if (!isEdgeOpen(graph, a, b)) { found = { dx, dz }; break; }
    }
  }
  assert.ok(found, 'no closed east-west edge on level 0');

  carveDistrict(seed, graph, found.dx, found.dz, 0, cells);
  const border = found.dx * MAZE.DISTRICT + MAZE.DISTRICT - 1;
  for (let z = found.dz * MAZE.DISTRICT; z < found.dz * MAZE.DISTRICT + MAZE.DISTRICT; z++) {
    assert.equal(isOpen(cells, cellIndex(border, z, 0), DIR.E), false, `leak at z=${z}`);
  }
});

test('carving is deterministic for a seed', () => {
  const g = buildDistrictGraph(64);
  const a = new Uint8Array(MAZE.TOTAL_CELLS);
  const b = new Uint8Array(MAZE.TOTAL_CELLS);
  carveDistrict(64, g, 2, 2, 0, a);
  carveDistrict(64, g, 2, 2, 0, b);
  assert.deepEqual(a, b);
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npm test`

Expected: FAIL — `does not provide an export named 'carveDistrict'`.

- [ ] **Step 3: Write the implementation**

Append to `src/worlds/maze/MazeTopology.js`:

```js
/* ------------------------------------------------------------------ */
/* District interiors                                                  */
/*                                                                     */
/* Each district is carved from its own seed and knows nothing about   */
/* its neighbours. The only shared information is where the doorway on */
/* a border sits, and both sides derive that from the *edge* rather    */
/* than from either district - so they agree without ever meeting.     */
/* That independence is what makes chunk streaming possible.           */
/* ------------------------------------------------------------------ */

/**
 * Where along a shared border the doorway sits.
 * Canonical in a/b, so both districts compute the same answer.
 * @returns {number} 0..span-1
 */
export function doorwayOffset(seed, aIndex, bIndex, span) {
  const lo = Math.min(aIndex, bIndex);
  const hi = Math.max(aIndex, bIndex);
  return hash32(seed, lo, hi, 0xd00r) % span;
}

/**
 * Carve one district's 20x20 cells, plus its open border doorways.
 *
 * Writes only cells belonging to this district: the far side of each doorway is
 * opened by the neighbouring district's own call, which derives the same offset.
 *
 * @param {number} seed
 * @param {ReturnType<typeof buildDistrictGraph>} graph
 * @param {number} dx
 * @param {number} dz
 * @param {number} level
 * @param {Uint8Array} cells mutated in place
 */
export function carveDistrict(seed, graph, dx, dz, level, cells) {
  const D = MAZE.DISTRICT;
  const x0 = dx * D;
  const z0 = dz * D;
  const rng = mulberry32(hash32(seed, dx, dz, level, 0x5eed));

  /* Recursive backtracker over the district's own cells, iteratively. Produces
   * a perfect maze inside the district: every cell reachable, no loops. Loops
   * in the finished maze come from the district graph's extra edges, not from
   * here. */
  const visited = new Uint8Array(D * D);
  const local = (lx, lz) => lz * D + lx;
  const stack = [[0, 0]];
  visited[0] = 1;

  while (stack.length) {
    const [lx, lz] = stack[stack.length - 1];
    const options = [];
    for (const dir of HORIZONTAL) {
      const [sx, sz] = STEP[dir];
      const nx = lx + sx;
      const nz = lz + sz;
      if (nx < 0 || nz < 0 || nx >= D || nz >= D) continue;
      if (visited[local(nx, nz)]) continue;
      options.push({ dir, nx, nz });
    }
    if (options.length === 0) {
      stack.pop();
      continue;
    }
    const pick = options[Math.floor(rng() * options.length)];
    const here = cellIndex(x0 + lx, z0 + lz, level);
    const there = cellIndex(x0 + pick.nx, z0 + pick.nz, level);
    cells[here] |= pick.dir;
    cells[there] |= OPPOSITE[pick.dir];
    visited[local(pick.nx, pick.nz)] = 1;
    stack.push([pick.nx, pick.nz]);
  }

  /* Border doorways. Only the near side is opened here. */
  const self = districtIndex(dx, dz, level);

  const borders = [
    { dir: DIR.N, ddx: 0, ddz: -1 },
    { dir: DIR.E, ddx: 1, ddz: 0 },
    { dir: DIR.S, ddx: 0, ddz: 1 },
    { dir: DIR.W, ddx: -1, ddz: 0 },
  ];

  for (const b of borders) {
    const ndx = dx + b.ddx;
    const ndz = dz + b.ddz;
    if (ndx < 0 || ndz < 0 || ndx >= MAZE.DISTRICTS || ndz >= MAZE.DISTRICTS) continue;
    const other = districtIndex(ndx, ndz, level);
    if (!isEdgeOpen(graph, self, other)) continue;

    const off = doorwayOffset(seed, self, other, D);
    let cx;
    let cz;
    if (b.dir === DIR.N) { cx = x0 + off; cz = z0; }
    else if (b.dir === DIR.S) { cx = x0 + off; cz = z0 + D - 1; }
    else if (b.dir === DIR.W) { cx = x0; cz = z0 + off; }
    else { cx = x0 + D - 1; cz = z0 + off; }
    cells[cellIndex(cx, cz, level)] |= b.dir;
  }

  /* Vertical doorways. The offset indexes the district's whole 20x20 block, so
   * a stair or lift can land anywhere inside it rather than only on a border. */
  for (const [dir, dl] of [[DIR.UP, 1], [DIR.DOWN, -1]]) {
    const nl = level + dl;
    if (nl < 0 || nl >= MAZE.LEVELS) continue;
    const other = districtIndex(dx, dz, nl);
    if (!isEdgeOpen(graph, self, other)) continue;
    const off = doorwayOffset(seed, self, other, D * D);
    const lx = off % D;
    const lz = Math.floor(off / D);
    cells[cellIndex(x0 + lx, z0 + lz, level)] |= dir;
  }
}
```

- [ ] **Step 4: Run it to verify it passes**

Run: `npm test`

Expected: PASS — 7 tests in `maze-carve.test.mjs`.

- [ ] **Step 5: Commit**

```bash
git add src/worlds/maze/MazeTopology.js scripts/tests/maze-carve.test.mjs
git commit -m "Carve districts that agree on their borders without meeting

Two neighbouring districts have to put their shared doorway in the same place,
and neither is allowed to look at the other - that is the whole constraint that
makes streaming possible later. Both derive the offset from the edge key rather
than from either district, so they independently compute the same answer.

The test that a carve writes no cell outside its own district is the one that
matters most here. Without it a stray write would still produce a working maze
today and a corrupted one the moment districts start being built and torn down
in arbitrary order."
```

---

### Task 5: Whole-maze generation, solvability and reachability

**Files:**
- Modify: `src/worlds/maze/MazeTopology.js` (append)
- Create: `scripts/tests/maze-solvable.test.mjs`

**Interfaces:**
- Consumes: everything above.
- Produces:
  - `generateTopology(seed: number, opts?: { levels?: number }): { seed, cells: Uint8Array, graph, entranceCell: number, centreCell: number }`
  - `solve(cells: Uint8Array, from: number, to: number): number[] | null` — cell indices, inclusive of both ends.
  - `reachableCount(cells: Uint8Array, from: number): number`

`opts.levels` exists so Phase 1 can generate level 0 alone while Phase 2 turns on all four without an API change. It defaults to `MAZE.LEVELS`.

- [ ] **Step 1: Write the failing test**

Create `scripts/tests/maze-solvable.test.mjs`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  MAZE, generateTopology, solve, reachableCount, cellCoords,
} from '../../src/worlds/maze/MazeTopology.js';

test('a generated maze has the expected shape', () => {
  const t = generateTopology(1);
  assert.equal(t.cells.length, MAZE.TOTAL_CELLS);
  assert.equal(t.seed, 1);
  assert.ok(t.entranceCell >= 0 && t.entranceCell < MAZE.TOTAL_CELLS);
  assert.ok(t.centreCell >= 0 && t.centreCell < MAZE.TOTAL_CELLS);
});

test('every cell on a generated level is reachable from the entrance', () => {
  const t = generateTopology(2026);
  // The whole maze is one connected component: spanning tree over districts,
  // perfect maze within each. Anything less means a player can be walled into
  // a pocket, or a prize can be placed somewhere nobody can stand.
  assert.equal(reachableCount(t.cells, t.entranceCell), MAZE.TOTAL_CELLS);
});

test('THE GATE: entrance reaches centre for 1000 consecutive seeds', () => {
  for (let seed = 0; seed < 1000; seed++) {
    const t = generateTopology(seed);
    const path = solve(t.cells, t.entranceCell, t.centreCell);
    assert.ok(path, `seed ${seed} is unsolvable`);
    assert.equal(path[0], t.entranceCell);
    assert.equal(path[path.length - 1], t.centreCell);
  }
});

test('the forced route is long enough to be worth the walk', () => {
  let total = 0;
  const runs = 40;
  for (let seed = 0; seed < runs; seed++) {
    const t = generateTopology(seed);
    total += solve(t.cells, t.entranceCell, t.centreCell).length;
  }
  const meanCells = total / runs;
  const meanMetres = meanCells * MAZE.CELL;
  // The spec claims a 4-8km forced route. Assert the floor generously; this is
  // a regression guard against a change that quietly shortens the maze, not a
  // precise measurement.
  assert.ok(meanMetres > 1500, `forced route too short: ${Math.round(meanMetres)}m`);
});

test('different seeds produce genuinely different mazes', () => {
  const a = generateTopology(11);
  const b = generateTopology(12);
  let differing = 0;
  for (let i = 0; i < MAZE.TOTAL_CELLS; i++) if (a.cells[i] !== b.cells[i]) differing++;
  const ratio = differing / MAZE.TOTAL_CELLS;
  assert.ok(ratio > 0.5, `mazes too similar: only ${Math.round(ratio * 100)}% of cells differ`);
});

test('the same seed reproduces the maze exactly', () => {
  assert.deepEqual(generateTopology(77).cells, generateTopology(77).cells);
});

test('levels option limits generation to the requested levels', () => {
  const t = generateTopology(5, { levels: 1 });
  assert.equal(cellCoords(t.entranceCell).level, 0);
  assert.equal(cellCoords(t.centreCell).level, 0);
  // Nothing above level 0 should be carved.
  for (let i = MAZE.LEVEL_CELLS; i < MAZE.TOTAL_CELLS; i++) {
    assert.equal(t.cells[i], 0, `carved above level 0 at index ${i}`);
  }
});

test('single-level generation is still fully solvable', () => {
  for (let seed = 0; seed < 200; seed++) {
    const t = generateTopology(seed, { levels: 1 });
    assert.ok(solve(t.cells, t.entranceCell, t.centreCell), `seed ${seed} unsolvable`);
    assert.equal(reachableCount(t.cells, t.entranceCell), MAZE.LEVEL_CELLS);
  }
});

test('generation is fast enough for a sub-3-second entry', () => {
  const t0 = process.hrtime.bigint();
  generateTopology(4242);
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  // The spec budgets ~300ms for topology inside a 3s entry. Node is not the
  // browser, so allow generous headroom - this catches an accidental O(n^2),
  // not a 20% regression.
  assert.ok(ms < 2000, `topology took ${Math.round(ms)}ms`);
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npm test`

Expected: FAIL — `does not provide an export named 'generateTopology'`.

- [ ] **Step 3: Write the implementation**

Append to `src/worlds/maze/MazeTopology.js`:

```js
/* ------------------------------------------------------------------ */
/* Whole-maze generation and search                                    */
/* ------------------------------------------------------------------ */

/**
 * Generate a complete maze topology.
 *
 * @param {number} seed
 * @param {{ levels?: number }} [opts] `levels` limits generation to the lowest
 *   N levels. Phase 1 passes 1; the default builds all four.
 * @returns {{ seed:number, cells:Uint8Array,
 *             graph:ReturnType<typeof buildDistrictGraph>,
 *             entranceCell:number, centreCell:number }}
 */
export function generateTopology(seed, opts = {}) {
  const levels = Math.max(1, Math.min(MAZE.LEVELS, opts.levels ?? MAZE.LEVELS));
  const graph = buildDistrictGraph(seed);
  const cells = new Uint8Array(MAZE.TOTAL_CELLS);

  for (let level = 0; level < levels; level++) {
    for (let dz = 0; dz < MAZE.DISTRICTS; dz++) {
      for (let dx = 0; dx < MAZE.DISTRICTS; dx++) {
        carveDistrict(seed, graph, dx, dz, level, cells);
      }
    }
  }

  /* When generation is limited to fewer levels than the graph knows about, the
   * centre may have been placed on a level that was never carved. Fold it down
   * rather than leaving an unreachable prize. */
  const centreLevel = graph.centre.level < levels ? graph.centre.level : 0;

  const cellOf = (d, lvl) =>
    cellIndex(
      d.dx * MAZE.DISTRICT + Math.floor(MAZE.DISTRICT / 2),
      d.dz * MAZE.DISTRICT + Math.floor(MAZE.DISTRICT / 2),
      lvl,
    );

  return {
    seed,
    cells,
    graph,
    entranceCell: cellOf(graph.entrance, graph.entrance.level),
    centreCell: cellOf(graph.centre, centreLevel),
  };
}

/** Neighbour cell index across `dir`, or -1 if it leaves the grid. */
function neighbourOf(index, dir) {
  const { x, z, level } = cellCoords(index);
  if (dir === DIR.UP) return level + 1 < MAZE.LEVELS ? cellIndex(x, z, level + 1) : -1;
  if (dir === DIR.DOWN) return level > 0 ? cellIndex(x, z, level - 1) : -1;
  const [sx, sz] = STEP[dir];
  const nx = x + sx;
  const nz = z + sz;
  return inBounds(nx, nz) ? cellIndex(nx, nz, level) : -1;
}

const ALL_DIRS = [DIR.N, DIR.E, DIR.S, DIR.W, DIR.UP, DIR.DOWN];

/**
 * Breadth-first shortest route between two cells.
 * @returns {number[]|null} cell indices from `from` to `to`, or null
 */
export function solve(cells, from, to) {
  if (from === to) return [from];
  const prev = new Int32Array(MAZE.TOTAL_CELLS).fill(-1);
  const seen = new Uint8Array(MAZE.TOTAL_CELLS);
  /* A plain array used as a queue with a head cursor. Array.shift() on a
   * 640,000-entry queue is O(n) per call and turns this into minutes. */
  const queue = new Int32Array(MAZE.TOTAL_CELLS);
  let head = 0;
  let tail = 0;
  queue[tail++] = from;
  seen[from] = 1;

  while (head < tail) {
    const cur = queue[head++];
    for (const dir of ALL_DIRS) {
      if ((cells[cur] & dir) === 0) continue;
      const n = neighbourOf(cur, dir);
      if (n < 0 || seen[n]) continue;
      seen[n] = 1;
      prev[n] = cur;
      if (n === to) {
        const path = [to];
        let step = cur;
        while (step !== from) { path.push(step); step = prev[step]; }
        path.push(from);
        return path.reverse();
      }
      queue[tail++] = n;
    }
  }
  return null;
}

/** How many cells are reachable from `from`. Used to prove there are no pockets. */
export function reachableCount(cells, from) {
  const seen = new Uint8Array(MAZE.TOTAL_CELLS);
  const queue = new Int32Array(MAZE.TOTAL_CELLS);
  let head = 0;
  let tail = 0;
  queue[tail++] = from;
  seen[from] = 1;
  let count = 1;
  while (head < tail) {
    const cur = queue[head++];
    for (const dir of ALL_DIRS) {
      if ((cells[cur] & dir) === 0) continue;
      const n = neighbourOf(cur, dir);
      if (n < 0 || seen[n]) continue;
      seen[n] = 1;
      count++;
      queue[tail++] = n;
    }
  }
  return count;
}
```

- [ ] **Step 4: Run it to verify it passes**

Run: `npm test`

Expected: PASS — 9 tests in `maze-solvable.test.mjs`. The 1000-seed gate takes a few seconds.

- [ ] **Step 5: Commit**

```bash
git add src/worlds/maze/MazeTopology.js scripts/tests/maze-solvable.test.mjs
git commit -m "Prove the maze is solvable, a thousand seeds at a time

This is the gate the spec names first: entrance reaches centre for 1000
consecutive seeds, no exceptions. It runs in seconds because the topology is
pure and needs no browser - which is the entire reason that constraint was
written into the spec.

The BFS queue is a typed array with a head cursor rather than Array.shift().
That is not premature optimisation: shift() on a 640,000-entry queue is O(n)
per call and turns a two-second gate into a several-minute one."
```

---

### Task 6: `Physics.remove()`

**Files:**
- Modify: `src/physics/Physics.js` — add `remove()` immediately after `add()` (currently ends at line 474)
- Create: `scripts/tests/physics-remove.test.mjs`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `Physics.prototype.remove(collider): boolean` — true if the collider was present and removed.

**Why now.** Phase 2's streaming cannot exist without it, and it is far easier to get right in isolation with real tests than while debugging a chunk streamer. `_insertToGrid` recomputes a collider's cell range from its own centre and radius, so `remove()` can recompute the identical range and splice from just those lists — no scan of the whole grid.

- [ ] **Step 1: Write the failing test**

Create `scripts/tests/physics-remove.test.mjs`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { Physics } from '../../src/physics/Physics.js';

test('remove drops a collider from the array', () => {
  const p = new Physics(null);
  const a = p.addBox(0, 0, 0, 1, 1, 1);
  const b = p.addBox(50, 0, 0, 1, 1, 1);
  assert.equal(p.remove(a), true);
  assert.equal(p.colliders.length, 1);
  assert.equal(p.colliders[0], b);
});

test('remove returns false for a collider that was never added', () => {
  const p = new Physics(null);
  const a = p.addBox(0, 0, 0, 1, 1, 1);
  p.remove(a);
  assert.equal(p.remove(a), false);
});

test('a removed collider no longer blocks a capsule', () => {
  const p = new Physics(null);
  p.addBox(0, -0.5, 0, 40, 0.5, 40);          // floor
  const wall = p.addBox(3, 2.5, 0, 0.6, 2.5, 20); // wall at x=3

  const pos = new THREE.Vector3(0, 1, 0);
  for (let i = 0; i < 120; i++) { pos.x += 8.2 / 60; p.resolveCapsule(pos, 0.35, 1.75); }
  assert.ok(pos.x < 2.5, `wall did not stop the capsule: x=${pos.x}`);

  p.remove(wall);
  const pos2 = new THREE.Vector3(0, 1, 0);
  for (let i = 0; i < 120; i++) { pos2.x += 8.2 / 60; p.resolveCapsule(pos2, 0.35, 1.75); }
  assert.ok(pos2.x > 5, `removed wall still blocks: x=${pos2.x}`);
});

test('a removed collider no longer answers queries', () => {
  const p = new Physics(null);
  const box = p.addBox(0, 0, 0, 2, 2, 2);
  assert.ok(p.query(new THREE.Vector3(0, 0, 0), 5).includes(box));
  p.remove(box);
  assert.ok(!p.query(new THREE.Vector3(0, 0, 0), 5).includes(box));
});

test('removing one collider leaves its grid-cell neighbours intact', () => {
  const p = new Physics(null);
  // Both land in overlapping broadphase cells (cellSize is 12).
  const a = p.addBox(0, 0, 0, 2, 2, 2);
  const b = p.addBox(3, 0, 0, 2, 2, 2);
  p.remove(a);
  const hits = p.query(new THREE.Vector3(3, 0, 0), 5);
  assert.ok(hits.includes(b), 'neighbour was collaterally removed');
  assert.ok(!hits.includes(a));
});

test('remove handles heightfields', () => {
  const p = new Physics(null);
  const hf = p.addHeightfield({
    heights: new Float32Array(16), nx: 4, nz: 4,
    originX: 0, originZ: 0, stepX: 1,
  });
  assert.equal(p.heightfields.length, 1);
  assert.equal(p.remove(hf), true);
  assert.equal(p.heightfields.length, 0);
  assert.equal(p.colliders.length, 0);
});

test('add then remove repeatedly does not leak grid entries', () => {
  const p = new Physics(null);
  for (let i = 0; i < 500; i++) {
    const c = p.addBox(0, 0, 0, 1, 1, 1);
    p.remove(c);
  }
  assert.equal(p.colliders.length, 0);
  assert.equal(p.query(new THREE.Vector3(0, 0, 0), 5).length, 0);
  // Every emptied bucket must be dropped, or the grid grows without bound.
  assert.equal(p._grid.size, 0, `leaked ${p._grid.size} grid buckets`);
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npm test`

Expected: FAIL — `p.remove is not a function`.

- [ ] **Step 3: Write the implementation**

In `src/physics/Physics.js`, insert immediately after the `add(collider)` method:

```js
  /**
   * Unregister a collider.
   *
   * The counterpart to `add`, and the thing that makes streaming possible: a
   * world that builds and tears down chunks as the player walks needs to drop
   * geometry without wiping everyone else's. Until this existed the only tool
   * was `clear()`, which takes the whole world with it.
   *
   * The broadphase cell range is recomputed exactly as `_insertToGrid` derived
   * it, so this touches only the buckets the collider actually occupies rather
   * than scanning the grid. Emptied buckets are deleted outright - a streaming
   * world adds and removes continuously, and leaving empty arrays behind grows
   * the map without bound.
   *
   * @param {Collider} collider
   * @returns {boolean} true if it was registered and has now been removed
   */
  remove(collider) {
    if (!collider) return false;
    const at = this.colliders.indexOf(collider);
    if (at < 0) return false;
    this.colliders.splice(at, 1);

    if (collider.type === 'heightfield') {
      const h = this.heightfields.indexOf(collider);
      if (h >= 0) this.heightfields.splice(h, 1);
      return true;
    }

    // Mirror _insertToGrid's footprint derivation exactly, or removal misses
    // buckets that insertion wrote to.
    const r = collider.boundingRadius;
    const c = collider.center;
    let loX = c.x - r, hiX = c.x + r, loZ = c.z - r, hiZ = c.z + r;
    if (collider.type === 'mesh') {
      const b = collider.bounds;
      loX = b.min.x; hiX = b.max.x;
      loZ = b.min.z; hiZ = b.max.z;
    }

    const minX = Math.floor(loX / this.cellSize);
    const maxX = Math.floor(hiX / this.cellSize);
    const minZ = Math.floor(loZ / this.cellSize);
    const maxZ = Math.floor(hiZ / this.cellSize);
    for (let x = minX; x <= maxX; x++) {
      for (let z = minZ; z <= maxZ; z++) {
        const key = this._cellKey(x, z);
        const list = this._grid.get(key);
        if (!list) continue;
        const i = list.indexOf(collider);
        if (i >= 0) list.splice(i, 1);
        if (list.length === 0) this._grid.delete(key);
      }
    }
    return true;
  }
```

- [ ] **Step 4: Run it to verify it passes**

Run: `npm test`

Expected: PASS — 7 tests in `physics-remove.test.mjs`.

- [ ] **Step 5: Verify nothing else broke**

Run: `node scripts/contract-check.mjs`

Expected: exits 0, same output as before this task.

- [ ] **Step 6: Commit**

```bash
git add src/physics/Physics.js scripts/tests/physics-remove.test.mjs
git commit -m "Let a collider be removed without clearing the world

The only tool for un-registering geometry was clear(), which takes everything
with it - fine when worlds were built once and swapped whole, useless for a
maze that builds and drops chunks as you walk.

Removal recomputes the broadphase footprint exactly the way _insertToGrid
derived it rather than scanning the grid, and deletes emptied buckets. The
bucket deletion is what the 500-cycle test is really guarding: a streaming
world adds and removes continuously, and leaving empty arrays behind grows the
map forever."
```

---

### Task 7: The world-rules layer

**Files:**
- Create: `src/worlds/WorldRules.js`
- Modify: `src/worlds/World.js` — add `rules` in the constructor, after `minimapShapes` (line 71)
- Create: `scripts/tests/world-rules.test.mjs`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `DEFAULT_RULES` — frozen object, everything permitted.
  - `makeRules(overrides?: object): object` — frozen merge onto the defaults; throws on an unknown key.
  - `World.prototype.rules` — a `DEFAULT_RULES` instance on the base class.

**Why `makeRules` throws on unknown keys.** A typo like `merchant: false` instead of `merchants: false` would otherwise silently permit merchants in the maze, and the failure would show up as an unexplained trader standing in a hedge months later.

- [ ] **Step 1: Write the failing test**

Create `scripts/tests/world-rules.test.mjs`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_RULES, makeRules } from '../../src/worlds/WorldRules.js';

const GATED = [
  'weapons', 'mounts', 'climb', 'parkour', 'merchants', 'quests',
  'contracts', 'caches', 'relics', 'loot', 'races', 'interiors',
  'hostiles', 'swim', 'jump',
];

test('every gated capability has a default and defaults to permitted', () => {
  for (const key of GATED) {
    assert.ok(key in DEFAULT_RULES, `missing rule: ${key}`);
    assert.equal(DEFAULT_RULES[key], true, `${key} should default to permitted`);
  }
});

test('defaults are frozen', () => {
  assert.throws(() => { DEFAULT_RULES.weapons = false; }, TypeError);
});

test('makeRules merges over the defaults', () => {
  const r = makeRules({ weapons: false, mounts: false });
  assert.equal(r.weapons, false);
  assert.equal(r.mounts, false);
  assert.equal(r.loot, true);
});

test('makeRules result is frozen', () => {
  const r = makeRules({ weapons: false });
  assert.throws(() => { r.weapons = true; }, TypeError);
});

test('makeRules rejects an unknown key', () => {
  // A typo here would silently permit the thing it meant to forbid.
  assert.throws(() => makeRules({ merchant: false }), /unknown world rule: merchant/);
});

test('makeRules with no argument returns the permissive defaults', () => {
  assert.deepEqual({ ...makeRules() }, { ...DEFAULT_RULES });
});

test('the maze rule set forbids exactly what the spec says', () => {
  const maze = makeRules({
    weapons: false, mounts: false, climb: false, parkour: false,
    merchants: false, quests: false, contracts: false, caches: false,
    relics: false, loot: false, races: false, interiors: false,
    hostiles: false, swim: false,
  });
  // Jump is retained on purpose: disabling climbing does not disable jumping.
  assert.equal(maze.jump, true);
  for (const key of GATED) {
    if (key === 'jump') continue;
    assert.equal(maze[key], false, `${key} should be forbidden in the maze`);
  }
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npm test`

Expected: FAIL — `Cannot find module .../src/worlds/WorldRules.js`.

- [ ] **Step 3: Write the implementation**

Create `src/worlds/WorldRules.js`:

```js
/**
 * Per-world capability rules.
 *
 * Until the maze there was no such thing: every system reacted to
 * `world:changed` unconditionally, so any new world got loot, merchants,
 * quests, caches, relics and mounts whether it wanted them or not. The maze
 * wants almost none of it.
 *
 * Enforcement is deliberately dull. Each system keeps its own `world:changed`
 * handler and gains a one-line early return against these flags. A dozen
 * one-line edits are traceable; one clever central interceptor is not, and when
 * it misfires nobody can find out why a trader is standing in a hedge.
 *
 * Everything defaults to permitted, so existing worlds keep behaving exactly as
 * they did without being touched.
 */

/** @type {Readonly<Record<string, boolean>>} */
export const DEFAULT_RULES = Object.freeze({
  /** Weapon selection and the viewmodel. */
  weapons: true,
  /** Summoning any mount. */
  mounts: true,
  /** One-shot ledge mantling. */
  climb: true,
  /** Sustained wall climbing and parkour. */
  parkour: true,
  /** Marketplace traders. */
  merchants: true,
  /** Quest system and quest-manager NPCs. */
  quests: true,
  /** Standing contracts from named NPCs. */
  contracts: true,
  /** Hidden supply caches. */
  caches: true,
  /** Collectible relics. */
  relics: true,
  /** World pickups and drops. */
  loot: true,
  /** Race circuits. */
  races: true,
  /** Enterable building interiors. */
  interiors: true,
  /** Hostile NPC spawns. */
  hostiles: true,
  /** Water volume scanning and swimming. */
  swim: true,
  /**
   * Jumping. Retained in the maze on purpose - disabling climbing does not
   * disable jumping, and the maze's geometry is what makes the hop useless
   * rather than the input being taken away.
   */
  jump: true,
});

/**
 * Build a rule set from the permissive defaults.
 *
 * Throws on an unknown key. A typo (`merchant` for `merchants`) would otherwise
 * permit the very thing it was written to forbid, and would surface months
 * later as inexplicable content in a world that should be empty.
 *
 * @param {Partial<Record<keyof typeof DEFAULT_RULES, boolean>>} [overrides]
 * @returns {Readonly<Record<string, boolean>>}
 */
export function makeRules(overrides = {}) {
  for (const key of Object.keys(overrides)) {
    if (!(key in DEFAULT_RULES)) throw new Error(`unknown world rule: ${key}`);
  }
  return Object.freeze({ ...DEFAULT_RULES, ...overrides });
}
```

- [ ] **Step 4: Wire it onto the base World class**

In `src/worlds/World.js`, add the import at the top, after the THREE import:

```js
import { DEFAULT_RULES } from './WorldRules.js';
```

Then in the constructor, immediately after the `minimapShapes` assignment:

```js
    /**
     * Per-world capability gates. Everything is permitted by default, so an
     * existing world behaves exactly as it did before rules existed.
     * @see ./WorldRules.js
     */
    this.rules = DEFAULT_RULES;
```

- [ ] **Step 5: Run tests and the contract check**

Run: `npm test && node scripts/contract-check.mjs`

Expected: PASS — 7 tests in `world-rules.test.mjs`; contract check exits 0.

- [ ] **Step 6: Commit**

```bash
git add src/worlds/WorldRules.js src/worlds/World.js scripts/tests/world-rules.test.mjs
git commit -m "Give a world the ability to say what it does not want

Every system reacted to world:changed unconditionally, so a new world got loot,
merchants, quests, caches, relics and mounts whether or not it had any use for
them. The maze wants almost none of it.

Everything defaults to permitted, so no existing world changes behaviour.

makeRules throws on an unknown key, which is the only interesting decision
here: 'merchant' for 'merchants' would otherwise quietly permit exactly what it
was written to forbid, and would surface much later as a trader standing in a
hedge with no way to trace how they got there."
```

---

### Task 8: Applying the rules to the twelve systems

**Files:**
- Modify: `src/systems/Loot.js`, `src/systems/Caches.js`, `src/systems/Relics.js`, `src/systems/Contracts.js`, `src/systems/Marketplace.js`, `src/systems/QuestSystem.js`, `src/systems/Interiors.js`, `src/systems/WaterVolumes.js`, `src/race/RaceManager.js`, `src/npc/NPCManager.js`, `src/mounts/MountManager.js`, `src/player/Loadout.js`, `src/player/Player.js`
- Create: `scripts/tests/rules-applied.test.mjs`

**Interfaces:**
- Consumes: `DEFAULT_RULES` from Task 7.
- Produces: `allows(world, flag): boolean`, added to `src/worlds/WorldRules.js` in Step 3 below. Every listed system honours `world.rules` on `world:changed`.

**Verified before writing this task:** all nine population systems do have a `world:changed` handler. `MountManager` has `this.worldManager`; `Player` and `Loadout` have `this.bus`. **`Loadout` has no `worldManager`** — it must track the active world off the bus.

**Method.** These are browser-side modules that Node cannot import, so the test is *textual* — exactly the technique `scripts/contract-check.mjs` already uses and for exactly the same reason. It asserts each file both imports nothing new and mentions the rule flag it is supposed to honour. This catches the common failure of adding the gate to eleven files and forgetting the twelfth.

- [ ] **Step 1: Write the failing test**

Create `scripts/tests/rules-applied.test.mjs`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

/* Textual, not behavioural: these modules touch document/canvas/WebGL at module
 * scope and cannot be imported under Node - the same reason
 * scripts/contract-check.mjs verifies the API surface by reading source. What
 * this guards is the boring failure that actually happens: the gate gets added
 * to eleven files and forgotten in the twelfth. */
const GATES = [
  ['src/systems/Loot.js', 'rules.loot'],
  ['src/systems/Caches.js', 'rules.caches'],
  ['src/systems/Relics.js', 'rules.relics'],
  ['src/systems/Contracts.js', 'rules.contracts'],
  ['src/systems/Marketplace.js', 'rules.merchants'],
  ['src/systems/QuestSystem.js', 'rules.quests'],
  ['src/systems/Interiors.js', 'rules.interiors'],
  ['src/systems/WaterVolumes.js', 'rules.swim'],
  ['src/race/RaceManager.js', 'rules.races'],
  ['src/npc/NPCManager.js', 'rules.hostiles'],
  ['src/mounts/MountManager.js', 'rules.mounts'],
  ['src/player/Loadout.js', 'rules.weapons'],
  ['src/player/Player.js', 'rules.climb'],
];

for (const [file, flag] of GATES) {
  test(`${file} honours ${flag}`, async () => {
    const src = await readFile(path.join(root, file), 'utf8');
    assert.ok(src.includes(flag), `${file} never mentions ${flag}`);
  });
}

test('Player also gates parkour', async () => {
  const src = await readFile(path.join(root, 'src/player/Player.js'), 'utf8');
  assert.ok(src.includes('rules.parkour'), 'Player never mentions rules.parkour');
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npm test`

Expected: FAIL — 13 failures, one per file, each `... never mentions rules.<flag>`.

- [ ] **Step 3: Add a rules accessor the systems can share**

Every gated system already holds either `worldManager` or receives the world on the `world:changed` event. Add this helper to `src/worlds/WorldRules.js`:

```js
/**
 * Read a capability flag off a world, defaulting to permitted.
 *
 * Systems receive the world in different ways - some from the `world:changed`
 * payload, some by asking the world manager - and some run before any world is
 * active. Missing information must mean "permitted", or a system that
 * initialises early would silently disable itself everywhere.
 *
 * @param {{rules?: Record<string, boolean>}|null|undefined} world
 * @param {keyof typeof DEFAULT_RULES} flag
 * @returns {boolean}
 */
export function allows(world, flag) {
  const rules = world?.rules;
  if (!rules || !(flag in rules)) return true;
  return rules[flag] !== false;
}
```

- [ ] **Step 4: Gate the eight world-population systems**

Each of these has a `world:changed` (or `world:changing`) handler that populates the world. In each file, add the import:

```js
import { allows } from '../worlds/WorldRules.js';
```

(`src/race/RaceManager.js` also uses `'../worlds/WorldRules.js'`; `src/npc/NPCManager.js`, `src/mounts/MountManager.js` and `src/player/*.js` likewise — all are one directory below `src/`.)

Then, as the **first statement inside the `world:changed` handler, after any existing `clear()` call**, add the early return. For `src/systems/Loot.js`:

```js
      // The maze wants no pickups. Clear first, then decline to populate.
      if (!allows(world, 'loot')) return;
```

Apply the identical shape to each, changing only the flag and the comment:

| File | Flag | Comment |
|---|---|---|
| `src/systems/Loot.js` | `loot` | `// The maze wants no pickups.` |
| `src/systems/Caches.js` | `caches` | `// No caches to dive for in a hedge maze.` |
| `src/systems/Relics.js` | `relics` | `// No relics: the only collectible is the stack at the centre.` |
| `src/systems/Contracts.js` | `contracts` | `// The maze's NPCs are for talking to, not for hiring.` |
| `src/systems/Marketplace.js` | `merchants` | `// Nothing to buy inside the maze.` |
| `src/systems/QuestSystem.js` | `quests` | `// The maze is its own objective.` |
| `src/systems/Interiors.js` | `interiors` | `// Towers and tunnels are world geometry, not enterable interiors.` |
| `src/systems/WaterVolumes.js` | `swim` | `// No water here; skip the full-geometry scan entirely.` |
| `src/race/RaceManager.js` | `races` | `// No circuits, and no mounts to drive them.` |

**Important for `WaterVolumes.js`:** the gate must sit before the geometry scan, not after. Scanning 400 districts of hedges for water surfaces on every entry is precisely the cost this avoids.

- [ ] **Step 5: Gate hostiles in NPCManager**

In `src/npc/NPCManager.js`, inside `spawnForWorld(world)` (line 343), after `this.theme = ...` is set, add:

```js
    /* A world may forbid hostiles outright - the maze has NPCs purely to talk
     * to. Zeroing the budget is enough: every hostile path downstream is driven
     * by this count. */
    const hostilesAllowed = allows(world, 'hostiles');
    const maxHostiles = hostilesAllowed ? this.maxHostiles : 0;
```

Then replace uses of `this.maxHostiles` **within `spawnForWorld` only** with `maxHostiles`, and skip any spawn whose descriptor `type === 'hostile'` when `!hostilesAllowed`.

- [ ] **Step 6: Gate mounts, weapons and climbing**

In `src/mounts/MountManager.js`, at the top of `summon(id)`:

```js
    // Some worlds are walked, not ridden.
    if (!allows(this.worldManager?.active, 'mounts')) return false;
```

`Loadout` has **no** `worldManager` — checked. It has `this.bus` (set at line 78) and an `on()` helper at line 170 that registers into `this._offs` for teardown. Track the world through that. In the constructor, after the existing `const on = (type, fn) => ...` helper and its other subscriptions:

```js
    /** Active world, tracked for capability rules. @see ../worlds/WorldRules.js */
    this._world = null;
    on('world:changed', ({ world }) => { this._world = world; });
```

Then at the top of `select(id)`:

```js
    // A world with no weapons has no viewmodel and no selection.
    if (!allows(this._world, 'weapons')) return false;
```

In `src/player/Player.js`, in `fixedUpdate`, guard the two climb entry points. Replace the mantle attempt at line 650:

```js
    if (jumpEdge && allows(this._world, 'climb') && this.climb.tryStart(elapsed, { inWater: false })) {
```

and the parkour tick at line 558:

```js
    if (allows(this._world, 'parkour')) this.parkour.fixedUpdate(dt);
```

`Player` tracks the active world the same way — add to its constructor:

```js
    /** Active world, tracked for capability rules. @see ../worlds/WorldRules.js */
    this._world = null;
    this.bus?.on('world:changed', ({ world }) => { this._world = world; });
```

- [ ] **Step 7: Run tests and the contract check**

Run: `npm test && node scripts/contract-check.mjs`

Expected: PASS — 14 tests in `rules-applied.test.mjs`; contract check exits 0.

- [ ] **Step 8: Verify existing worlds are unaffected in the browser**

Run: `npm run dev`, open `http://localhost:5173/?dev=1`, and check that in the station you can still: select a weapon, summon a mount, see loot and caches on the minimap, and mantle a ledge. Every rule defaults to permitted, so nothing should have changed.

- [ ] **Step 9: Commit**

```bash
git add src/systems src/race src/npc src/mounts src/player src/worlds/WorldRules.js scripts/tests/rules-applied.test.mjs
git commit -m "Teach thirteen systems to take no for an answer

One early return each, against a flag that defaults to permitted, so every
existing world behaves exactly as before.

The test is textual rather than behavioural because these modules touch
document and WebGL at module scope and cannot be imported under Node - the same
constraint, and the same technique, as contract-check.mjs. It is not checking
that the gates work; it is checking that all thirteen exist, because the
failure that actually happens is adding twelve and forgetting one.

The WaterVolumes gate has to sit before its geometry scan rather than after.
Scanning four hundred districts of hedge for water surfaces on every single
entry is the entire cost it exists to avoid."
```

---

### Task 9: Collider descriptors for a district

**Files:**
- Create: `src/worlds/maze/MazeColliders.js`
- Create: `scripts/tests/maze-colliders.test.mjs`

**Interfaces:**
- Consumes: `MAZE`, `DIR`, `cellIndex`, `isOpen` from Task 2.
- Produces:
  - `districtColliders(cells: Uint8Array, dx: number, dz: number, level: number): ColliderDesc[]`
  - `ColliderDesc` = `{ cx: number, cy: number, cz: number, hx: number, hy: number, hz: number, kind: 'hedge'|'floor' }` — centre and half-extents, axis-aligned, world metres.
  - `cellToWorld(x: number, z: number, level: number): { x: number, y: number, z: number }` — centre of a cell's floor.

**This is the file that keeps the headless gates alive.** It emits plain numbers, not meshes. The browser turns descriptors into `physics.addBox` calls *and* into instanced meshes; Node turns the same descriptors into a collision world with no renderer. If colliders were ever derived from built meshes instead, containment testing would become browser-bound.

- [ ] **Step 1: Write the failing test**

Create `scripts/tests/maze-colliders.test.mjs`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MAZE, generateTopology, cellIndex } from '../../src/worlds/maze/MazeTopology.js';
import { districtColliders, cellToWorld } from '../../src/worlds/maze/MazeColliders.js';

test('cellToWorld places cell 0,0 at the origin corner and steps by the pitch', () => {
  const a = cellToWorld(0, 0, 0);
  const b = cellToWorld(1, 0, 0);
  const c = cellToWorld(0, 1, 0);
  assert.equal(b.x - a.x, MAZE.CELL);
  assert.equal(c.z - a.z, MAZE.CELL);
  assert.equal(a.y, 0);
});

test('levels are stacked by LEVEL_HEIGHT', () => {
  assert.equal(cellToWorld(0, 0, 1).y - cellToWorld(0, 0, 0).y, MAZE.LEVEL_HEIGHT);
});

test('a district emits a floor and some hedges', () => {
  const t = generateTopology(3, { levels: 1 });
  const descs = districtColliders(t.cells, 2, 2, 0);
  assert.ok(descs.length > 0);
  assert.ok(descs.some((d) => d.kind === 'floor'), 'no floor emitted');
  assert.ok(descs.some((d) => d.kind === 'hedge'), 'no hedges emitted');
});

test('THE ANTI-LADDER GATE: no collider top sits in the hop band', () => {
  const t = generateTopology(99, { levels: 1 });
  for (let dz = 0; dz < 4; dz++) {
    for (let dx = 0; dx < 4; dx++) {
      for (const d of districtColliders(t.cells, dx, dz, 0)) {
        const top = d.cy + d.hy;
        const relative = top - cellToWorld(0, 0, 0).y;
        const inBand = relative > 0.45 && relative < 5.0;
        assert.ok(!inBand, `collider top at ${relative.toFixed(2)}m is a ladder over a hedge`);
      }
    }
  }
});

test('hedge colliders are the specified thickness and height', () => {
  const t = generateTopology(4, { levels: 1 });
  const hedges = districtColliders(t.cells, 1, 1, 0).filter((d) => d.kind === 'hedge');
  assert.ok(hedges.length > 0);
  for (const h of hedges) {
    assert.equal(h.hy * 2, MAZE.HEDGE_HEIGHT);
    const thin = Math.min(h.hx, h.hz) * 2;
    assert.ok(
      Math.abs(thin - MAZE.HEDGE_THICK) < 1e-9,
      `hedge thickness is ${thin}, expected ${MAZE.HEDGE_THICK}`,
    );
  }
});

test('the floor covers the district with a half-cell overlap on every side', () => {
  const t = generateTopology(6, { levels: 1 });
  const floor = districtColliders(t.cells, 3, 3, 0).find((d) => d.kind === 'floor');
  assert.ok(floor);
  const span = MAZE.DISTRICT * MAZE.CELL + MAZE.CELL; // district plus half a cell each side
  assert.ok(Math.abs(floor.hx * 2 - span) < 1e-9, `floor x span ${floor.hx * 2}, expected ${span}`);
  assert.ok(Math.abs(floor.hz * 2 - span) < 1e-9, `floor z span ${floor.hz * 2}, expected ${span}`);
});

test('an open passage has no hedge across it', () => {
  const t = generateTopology(8, { levels: 1 });
  const descs = districtColliders(t.cells, 0, 0, 0);
  // Find a cell with an open east passage and assert nothing solid sits in the
  // gap between it and its neighbour.
  let checked = 0;
  for (let z = 0; z < MAZE.DISTRICT; z++) {
    for (let x = 0; x < MAZE.DISTRICT - 1; x++) {
      const idx = cellIndex(x, z, 0);
      if ((t.cells[idx] & 4 /* DIR.S */) === 0 && (t.cells[idx] & 2 /* DIR.E */) === 0) continue;
      if ((t.cells[idx] & 2) === 0) continue;
      const here = cellToWorld(x, z, 0);
      const gapX = here.x + MAZE.CELL / 2;
      const blocking = descs.filter(
        (d) => d.kind === 'hedge'
          && Math.abs(d.cx - gapX) < d.hx
          && Math.abs(d.cz - here.z) < d.hz,
      );
      assert.equal(blocking.length, 0, `open passage at ${x},${z} is blocked`);
      checked++;
      if (checked > 50) return;
    }
  }
  assert.ok(checked > 0, 'found no open east passages to check');
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npm test`

Expected: FAIL — `Cannot find module .../MazeColliders.js`.

- [ ] **Step 3: Write the implementation**

Create `src/worlds/maze/MazeColliders.js`:

```js
/**
 * Collision descriptors for a district - plain numbers, no THREE, no meshes.
 *
 * This separation is a spec requirement, not a style choice. The browser turns
 * these into `physics.addBox` calls *and* into instanced meshes; Node turns the
 * same descriptors into a collision world with no renderer at all, which is
 * what lets the containment, seam and prop-ladder gates run headless in
 * seconds. Derive colliders from built meshes instead and every one of those
 * gates becomes browser-bound.
 *
 * @typedef {{ cx:number, cy:number, cz:number,
 *             hx:number, hy:number, hz:number,
 *             kind:'hedge'|'floor' }} ColliderDesc
 */

import { MAZE, DIR, cellIndex, isOpen } from './MazeTopology.js';

/**
 * Centre of a cell's floor, in world metres.
 * Cell 0,0 sits at the origin; the grid extends into +x/+z.
 */
export function cellToWorld(x, z, level) {
  return {
    x: x * MAZE.CELL,
    y: level * MAZE.LEVEL_HEIGHT,
    z: z * MAZE.CELL,
  };
}

/**
 * Every collider for one district.
 *
 * A hedge is emitted on a cell's north and west sides only, plus on the south
 * and east sides of the district's last row and column. Emitting all four sides
 * per cell would double every interior wall - two coincident colliders in the
 * same place, each answering every query.
 *
 * @param {Uint8Array} cells
 * @param {number} dx
 * @param {number} dz
 * @param {number} level
 * @returns {ColliderDesc[]}
 */
export function districtColliders(cells, dx, dz, level) {
  const D = MAZE.DISTRICT;
  const x0 = dx * D;
  const z0 = dz * D;
  const baseY = level * MAZE.LEVEL_HEIGHT;
  /** @type {ColliderDesc[]} */
  const out = [];

  /* One floor slab per district, extended half a cell past every border so it
   * overlaps its neighbours. A chunk boundary must never be a hole to fall
   * through, and an overlap is the cheapest possible guarantee of that. */
  const half = (D * MAZE.CELL + MAZE.CELL) / 2;
  const originX = x0 * MAZE.CELL;
  const originZ = z0 * MAZE.CELL;
  out.push({
    cx: originX + (D - 1) * MAZE.CELL / 2,
    cy: baseY - 0.5,
    cz: originZ + (D - 1) * MAZE.CELL / 2,
    hx: half,
    hy: 0.5,
    hz: half,
    kind: 'floor',
  });

  const HH = MAZE.HEDGE_HEIGHT / 2;
  const HT = MAZE.HEDGE_THICK / 2;
  const HALF_CELL = MAZE.CELL / 2;

  /** Wall spanning a full cell edge, thickness across the passage direction. */
  const pushHedge = (cx, cz, axis) => {
    out.push({
      cx,
      cy: baseY + HH,
      cz,
      hx: axis === 'x' ? HT : HALF_CELL,
      hy: HH,
      hz: axis === 'x' ? HALF_CELL : HT,
      kind: 'hedge',
    });
  };

  for (let lz = 0; lz < D; lz++) {
    for (let lx = 0; lx < D; lx++) {
      const x = x0 + lx;
      const z = z0 + lz;
      const idx = cellIndex(x, z, level);
      const w = cellToWorld(x, z, level);

      // North face (-z). Owned by this cell.
      if (!isOpen(cells, idx, DIR.N)) pushHedge(w.x, w.z - HALF_CELL, 'z');
      // West face (-x). Owned by this cell.
      if (!isOpen(cells, idx, DIR.W)) pushHedge(w.x - HALF_CELL, w.z, 'x');
      // South and east only on the district's far edges, where no further cell
      // exists to own them.
      if (lz === D - 1 && !isOpen(cells, idx, DIR.S)) pushHedge(w.x, w.z + HALF_CELL, 'z');
      if (lx === D - 1 && !isOpen(cells, idx, DIR.E)) pushHedge(w.x + HALF_CELL, w.z, 'x');
    }
  }

  return out;
}
```

- [ ] **Step 4: Run it to verify it passes**

Run: `npm test`

Expected: PASS — 7 tests in `maze-colliders.test.mjs`.

- [ ] **Step 5: Commit**

```bash
git add src/worlds/maze/MazeColliders.js scripts/tests/maze-colliders.test.mjs
git commit -m "Emit collision as numbers, so the gates can run without a browser

The browser turns these descriptors into physics boxes and into instanced
meshes; Node turns the same descriptors into a collision world with no renderer
at all. That is the whole reason containment can be tested headlessly, and it
is why this file must never start deriving colliders from built meshes.

Hedges are emitted on each cell's north and west faces only, with south and
east reserved for the district's far edges. Emitting all four per cell is the
obvious implementation and silently doubles every interior wall - two
coincident colliders in the same place, both answering every query.

The floor slab overhangs its district by half a cell on every side. A chunk
boundary must never be a hole to fall through and an overlap is the cheapest
guarantee there is."
```

---

### Task 10: The containment gate

**Files:**
- Create: `scripts/tests/maze-containment.test.mjs`

**Interfaces:**
- Consumes: `generateTopology`, `districtColliders`, `cellToWorld`, `Physics`.
- Produces: no exports. This task is purely the gate the spec names second.

**What this proves.** A capsule driven at sprint speed into every wall of a real generated maze, from many angles and at hop apex, never ends up inside a wall cell and never leaves the floor. This is the "player sticks to the path" requirement, made checkable.

- [ ] **Step 1: Write the test**

Create `scripts/tests/maze-containment.test.mjs`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { Physics } from '../../src/physics/Physics.js';
import {
  MAZE, generateTopology, cellIndex, mulberry32,
} from '../../src/worlds/maze/MazeTopology.js';
import { districtColliders, cellToWorld } from '../../src/worlds/maze/MazeColliders.js';

const RADIUS = 0.35;      // CONFIG.player.radius
const HEIGHT = 1.75;      // CONFIG.player.height
const SPRINT = 8.2;       // CONFIG.player.sprintSpeed
const HOP = 0.93;         // jumpVelocity 6.4, gravity -22
const STEP = 1 / 60;      // fixed timestep

/** Build a physics world from a block of districts. */
function buildWorld(cells, dxs, dzs, level) {
  const p = new Physics(null);
  for (const dz of dzs) {
    for (const dx of dxs) {
      for (const d of districtColliders(cells, dx, dz, level)) {
        p.addBox(d.cx, d.cy, d.cz, d.hx, d.hy, d.hz);
      }
    }
  }
  return p;
}

/** Which cell a world position falls in. */
function cellAt(pos) {
  return {
    x: Math.round(pos.x / MAZE.CELL),
    z: Math.round(pos.z / MAZE.CELL),
  };
}

test('THE CONTAINMENT GATE: 50,000 escape attempts, zero escapes', () => {
  const t = generateTopology(2026, { levels: 1 });
  const dxs = [0, 1, 2];
  const dzs = [0, 1, 2];
  const physics = buildWorld(t.cells, dxs, dzs, 0);

  const rng = mulberry32(4242);
  const pos = new THREE.Vector3();
  const maxX = 3 * MAZE.DISTRICT * MAZE.CELL;
  let escapes = 0;
  let attempts = 0;

  // 500 launch points x 100 steps each = 50,000 resolved attempts.
  for (let launch = 0; launch < 500; launch++) {
    // Start standing in a random open cell inside the built block.
    const cx = Math.floor(rng() * (3 * MAZE.DISTRICT));
    const cz = Math.floor(rng() * (3 * MAZE.DISTRICT));
    const start = cellToWorld(cx, cz, 0);
    // Hop apex half the time, so the sweep includes airborne contact.
    const y = start.y + (rng() < 0.5 ? 0.05 : HOP);
    pos.set(start.x, y + 0.01, start.z);

    const angle = rng() * Math.PI * 2;
    const vx = Math.cos(angle) * SPRINT;
    const vz = Math.sin(angle) * SPRINT;

    for (let step = 0; step < 100; step++) {
      pos.x += vx * STEP;
      pos.z += vz * STEP;
      physics.resolveCapsule(pos, RADIUS, HEIGHT);
      attempts++;

      // Escape 1: pushed outside the built block entirely.
      if (pos.x < -MAZE.CELL || pos.z < -MAZE.CELL || pos.x > maxX || pos.z > maxX) {
        escapes++;
        break;
      }
      // Escape 2: ended up above hedge height, i.e. on top of the maze.
      if (pos.y > start.y + MAZE.HEDGE_HEIGHT) {
        escapes++;
        break;
      }
      // Escape 3: fell through the floor.
      if (pos.y < start.y - 2) {
        escapes++;
        break;
      }
    }
  }

  assert.ok(attempts >= 50000 || escapes > 0, `only ran ${attempts} attempts`);
  assert.equal(escapes, 0, `${escapes} escapes out of ${attempts} attempts`);
});

test('a capsule cannot squeeze through a hedge corner', () => {
  const t = generateTopology(7, { levels: 1 });
  const physics = buildWorld(t.cells, [0, 1], [0, 1], 0);
  const rng = mulberry32(11);
  const pos = new THREE.Vector3();

  for (let i = 0; i < 2000; i++) {
    // Aim diagonally at a cell corner - the classic gap in grid collision.
    const cx = 1 + Math.floor(rng() * 30);
    const cz = 1 + Math.floor(rng() * 30);
    const w = cellToWorld(cx, cz, 0);
    pos.set(w.x, w.y + 0.9, w.z);
    const corner = new THREE.Vector3(
      w.x + MAZE.CELL / 2,
      w.y,
      w.z + MAZE.CELL / 2,
    );
    const dir = corner.clone().sub(pos).setY(0).normalize();
    for (let s = 0; s < 40; s++) {
      pos.addScaledVector(dir, SPRINT * STEP);
      physics.resolveCapsule(pos, RADIUS, HEIGHT);
    }
    // Wherever it ends up, it must still be standing on the floor.
    const ground = physics.groundHeight(pos.x, pos.z, pos.y + 1.2, 12);
    assert.notEqual(ground, null, `no floor beneath ${pos.x},${pos.z}`);
  }
});

test('THE SEAM GATE: every district border has floor beneath it', () => {
  const t = generateTopology(1234, { levels: 1 });
  const physics = buildWorld(t.cells, [0, 1, 2], [0, 1, 2], 0);

  // Sample densely across the two internal borders of the 3x3 block.
  for (const borderCell of [MAZE.DISTRICT, MAZE.DISTRICT * 2]) {
    const bx = borderCell * MAZE.CELL - MAZE.CELL / 2;
    for (let z = 0; z < 3 * MAZE.DISTRICT * MAZE.CELL; z += 0.5) {
      const ground = physics.groundHeight(bx, z, 5, 12);
      assert.notEqual(ground, null, `hole at district seam x=${bx} z=${z}`);
    }
  }
});
```

- [ ] **Step 2: Run it**

Run: `npm test`

Expected: PASS. If the containment gate reports escapes, **do not weaken the gate** — the failure is real. The likely causes, in order: hedge colliders not overlapping at junctions; the floor slab not overhanging far enough; or a passage opened on one side only (which Task 4's border test should already have caught).

- [ ] **Step 3: Commit**

```bash
git add scripts/tests/maze-containment.test.mjs
git commit -m "Try fifty thousand times to get out of the maze, and fail

'The player has to stick to the path' was the hardest requirement in the spec to
make checkable, and this is it: a capsule driven at sprint speed into a real
generated maze from five hundred launch points and every angle, half of them at
hop apex, never once ends up outside the block, on top of a hedge, or through
the floor.

The corner test is separate because diagonal approaches to a cell corner are the
classic way through grid collision, and a sweep that only ever runs along the
axes will not find it.

This runs in seconds and needs no browser. If it ever reports an escape the
gate is right and the maze is wrong."
```

---

### Task 11: The maze world, wired end to end

**Files:**
- Create: `src/worlds/MazeWorld.js`
- Modify: `src/worlds/WorldManager.js` — volatile-world support in `build()` (line 161) and `_activate()` (line 277)
- Modify: `src/main.js` — import and register (lines 14, 109)
- Modify: `src/worlds/StationWorld.js` — a fifth gateway
- Modify: `scripts/contract-check.mjs` — add the new files to `CONTRACT`

**Interfaces:**
- Consumes: everything above.
- Produces:
  - `MazeWorld` — `static id = 'maze'`, `static displayName = 'The Verdant Coil'`, `static volatile = true`.
  - `MazeWorld.prototype.seed` — the current run's seed.
  - `WorldManager.prototype.isVolatile(id): boolean`, and `build(id)` re-generates when it is true.

**Measured before committing to this approach.** One level is about **176,000 colliders**, which `Physics.add` registers in **134 ms** using roughly **170 MB** — so building the whole level up front genuinely works, and Phase 1 does not need streaming to be playable. It is also exactly why Phase 2 does: four levels would be ~700,000 colliders and most of a gigabyte, against a 25-district resident set that costs about 6% of one level.

- [ ] **Step 1: Write the failing test**

Append to `scripts/tests/rules-applied.test.mjs`:

```js
test('MazeWorld declares itself volatile and forbids the right things', async () => {
  const src = await readFile(path.join(root, 'src/worlds/MazeWorld.js'), 'utf8');
  assert.ok(src.includes('static volatile = true'), 'MazeWorld must be volatile');
  assert.ok(src.includes("static id = 'maze'"), 'MazeWorld needs its id');
  for (const flag of ['weapons', 'mounts', 'climb', 'parkour', 'merchants', 'quests',
                      'contracts', 'caches', 'relics', 'loot', 'races', 'interiors',
                      'hostiles', 'swim']) {
    assert.ok(new RegExp(`${flag}:\\s*false`).test(src), `MazeWorld does not forbid ${flag}`);
  }
  // Jump must NOT be forbidden - the geometry makes it useless, not the input.
  assert.ok(!/jump:\s*false/.test(src), 'MazeWorld must not disable jumping');
});

test('WorldManager honours volatile worlds', async () => {
  const src = await readFile(path.join(root, 'src/worlds/WorldManager.js'), 'utf8');
  assert.ok(src.includes('volatile'), 'WorldManager never mentions volatile');
});

test('the station offers a portal to the maze', async () => {
  const src = await readFile(path.join(root, 'src/worlds/StationWorld.js'), 'utf8');
  assert.ok(src.includes("target: 'maze'"), 'no station gateway to the maze');
});

test('main.js registers the maze world', async () => {
  const src = await readFile(path.join(root, 'src/main.js'), 'utf8');
  assert.ok(src.includes('MazeWorld'), 'MazeWorld is not registered');
});

test('the signage atlas has exactly one cell per sign', async () => {
  /* paintSignAtlas loops i < SIGN_COLS * SIGN_ROWS and destructures SIGNS[i]
   * unconditionally. One entry short throws "Cannot destructure" at boot; one
   * entry long is silently dropped and the sign it belonged to never appears.
   * Both are easy to cause when adding a gateway and neither is easy to spot,
   * so the invariant is asserted rather than remembered. */
  const kit = await readFile(path.join(root, 'src/worlds/station/StationKit.js'), 'utf8');
  const cols = Number(kit.match(/SIGN_COLS\s*=\s*(\d+)/)[1]);
  const rows = Number(kit.match(/SIGN_ROWS\s*=\s*(\d+)/)[1]);

  const station = await readFile(path.join(root, 'src/worlds/StationWorld.js'), 'utf8');
  const body = station.match(/const SIGNS = \[([\s\S]*?)\n\];/)[1];
  const entries = (body.match(/^\s*\['/gm) ?? []).length;

  assert.equal(entries, cols * rows,
    `SIGNS has ${entries} entries but the atlas has ${cols * rows} cells`);
});

test('every SIGN_ROLE points at a real sign', async () => {
  const station = await readFile(path.join(root, 'src/worlds/StationWorld.js'), 'utf8');
  const body = station.match(/const SIGNS = \[([\s\S]*?)\n\];/)[1];
  const entries = (body.match(/^\s*\['/gm) ?? []).length;
  const roles = station.match(/const SIGN_ROLE = \{([\s\S]*?)\n\};/)[1];
  for (const m of roles.matchAll(/(\w+):\s*(\d+)/g)) {
    assert.ok(Number(m[2]) < entries, `SIGN_ROLE.${m[1]} = ${m[2]} is past the end of SIGNS`);
  }
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npm test`

Expected: FAIL — 4 failures, starting with `ENOENT ... MazeWorld.js`.

- [ ] **Step 3: Write MazeWorld**

Create `src/worlds/MazeWorld.js`:

```js
import * as THREE from 'three';
import { World } from './World.js';
import { makeRules } from './WorldRules.js';
import {
  MAZE, generateTopology, cellCoords,
} from './maze/MazeTopology.js';
import { districtColliders, cellToWorld } from './maze/MazeColliders.js';

/**
 * The Verdant Coil - a hedge maze that re-rolls its layout on every entry.
 *
 * Phase 1 scope, deliberately: one level, every district built up front, and
 * box geometry rather than foliage. Streaming, the other three levels, the art
 * pass, the puzzles and the map are Phases 2-5. Building the whole level
 * up front is knowingly wrong for the finished world and knowingly right for
 * now - it takes streaming out of the equation while the topology, the rules
 * and the containment work are being proven.
 *
 * @see docs/superpowers/specs/2026-08-07-maze-world-design.md
 */
export class MazeWorld extends World {
  static id = 'maze';
  static displayName = 'The Verdant Coil';

  /**
   * Re-generate on every activation rather than serving a cached build.
   * Read by WorldManager. The maze that cannot be learned is the entire point.
   */
  static volatile = true;

  constructor(ctx) {
    super(ctx);

    this.rules = makeRules({
      weapons: false, mounts: false, climb: false, parkour: false,
      merchants: false, quests: false, contracts: false, caches: false,
      relics: false, loot: false, races: false, interiors: false,
      hostiles: false, swim: false,
      // jump stays permitted: the geometry makes the hop useless, not the input.
    });

    /** Current run's seed. Re-rolled on every build. */
    this.seed = 0;
    /** @type {Uint8Array|null} */
    this.cells = null;
    this.entranceCell = 0;
    this.centreCell = 0;

    /* Materials are created once and reused across every re-roll. Allocating
     * fresh ones per entry would re-trigger the shader compilation that already
     * dominates cold boot in this project - see the prewarm notes in main.js. */
    this._materials = null;

    const span = MAZE.CELLS * MAZE.CELL;
    this.bounds = new THREE.Box3(
      new THREE.Vector3(-MAZE.CELL, -10, -MAZE.CELL),
      new THREE.Vector3(span, MAZE.LEVEL_HEIGHT * MAZE.LEVELS + 20, span),
    );

    this.environment.background = new THREE.Color(0x9fb8c8);
    this.environment.fogColor = new THREE.Color(0xa8c0ce);
    this.environment.fogNear = 20;
    this.environment.fogFar = 160;
    this.environment.ambientColor = new THREE.Color(0x6f7f68);
    this.environment.ambientIntensity = 0.7;
    this.environment.sunColor = new THREE.Color(0xfff2d8);
    this.environment.sunIntensity = 2.2;
    this.environment.sunDirection = new THREE.Vector3(-0.3, 0.9, -0.25).normalize();
  }

  /** Reusable material set, built on first use and kept for the session. */
  _ensureMaterials() {
    if (this._materials) return this._materials;
    this._materials = {
      hedge: new THREE.MeshStandardMaterial({ color: 0x2f4a2a, roughness: 0.95, metalness: 0 }),
      floor: new THREE.MeshStandardMaterial({ color: 0x6b6357, roughness: 1.0, metalness: 0 }),
      credits: new THREE.MeshStandardMaterial({
        color: 0xffd479, roughness: 0.35, metalness: 0.8,
        emissive: 0x6a4a10, emissiveIntensity: 0.6,
      }),
    };
    return this._materials;
  }

  async build(onProgress) {
    /* A fresh seed per build. `build()` runs on every activation because this
     * world is volatile, so this is what makes the maze unlearnable. */
    this.seed = (Math.random() * 0xffffffff) >>> 0;

    await onProgress?.(0.05, 'Growing the hedges');

    const topo = generateTopology(this.seed, { levels: 1 });
    this.cells = topo.cells;
    this.entranceCell = topo.entranceCell;
    this.centreCell = topo.centreCell;

    await onProgress?.(0.25, 'Laying the paths');

    const mats = this._ensureMaterials();

    /* One InstancedMesh for hedges and one for floors across the whole level.
     * Phase 2 replaces this with per-district chunks; for now a single pair of
     * draw calls is both simplest and fastest. */
    const descs = [];
    for (let dz = 0; dz < MAZE.DISTRICTS; dz++) {
      for (let dx = 0; dx < MAZE.DISTRICTS; dx++) {
        for (const d of districtColliders(this.cells, dx, dz, 0)) descs.push(d);
      }
      if (dz % 4 === 0) {
        await onProgress?.(0.25 + 0.55 * (dz / MAZE.DISTRICTS), 'Laying the paths');
      }
    }

    const hedges = descs.filter((d) => d.kind === 'hedge');
    const floors = descs.filter((d) => d.kind === 'floor');

    this._addInstanced(hedges, mats.hedge, 'maze:hedges');
    this._addInstanced(floors, mats.floor, 'maze:floors');

    await onProgress?.(0.85, 'Registering collision');

    for (const d of descs) {
      this.track(this.physics.addBox(d.cx, d.cy, d.cz, d.hx, d.hy, d.hz));
    }

    /* Spawn the player standing in the entrance cell, facing into the maze
     * (south, +z). */
    const e = cellCoords(this.entranceCell);
    const ew = cellToWorld(e.x, e.z, e.level);
    this.playerSpawn.set(ew.x, ew.y + 0.05, ew.z);
    this.playerSpawnYaw = Math.PI;

    /* The return arch sits behind the player at the entrance. Walking back
     * through it leaves the maze. */
    this.portalSpecs = [{
      position: new THREE.Vector3(ew.x, ew.y, ew.z - MAZE.CELL),
      rotationY: 0,
      target: 'station',
      label: 'Aether Station',
      accent: 0x8fd67a,
    }];

    this._buildCentreStack(mats.credits);

    await onProgress?.(1, 'The Verdant Coil is ready');
  }

  /** Build one InstancedMesh from a list of box descriptors. */
  _addInstanced(descs, material, name) {
    if (descs.length === 0) return;
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
  }

  /** The prize: a stack of credits at the centre, worth 100. */
  _buildCentreStack(material) {
    const c = cellCoords(this.centreCell);
    const w = cellToWorld(c.x, c.z, c.level);
    const stack = new THREE.Group();
    stack.name = 'maze:centre-stack';
    for (let i = 0; i < 7; i++) {
      const coin = new THREE.Mesh(new THREE.CylinderGeometry(0.5, 0.5, 0.08, 20), material);
      coin.position.set(
        (i % 2) * 0.04 - 0.02,
        0.06 + i * 0.09,
        Math.floor(i / 2) * 0.03 - 0.03,
      );
      coin.castShadow = true;
      stack.add(coin);
    }
    stack.position.set(w.x, w.y, w.z);
    this.group.add(stack);

    /* Deliberately NOT collidable. A 0.7m stack sits squarely in the 0.45-5.0m
     * hop band, and the centre cell has hedges on at least three sides - a
     * solid stack there would be a step onto the hedge tops. */
    this.centrePosition = new THREE.Vector3(w.x, w.y, w.z);
  }

  /** Re-generation needs a clean group and collider list each time. */
  dispose() {
    this.group.traverse((obj) => {
      if (obj.geometry) obj.geometry.dispose();
    });
    this.group.clear();
    this.colliders.length = 0;
    this._built = false;
    /* Materials survive on purpose - see _ensureMaterials. */
  }
}
```

- [ ] **Step 4: Add volatile support to WorldManager**

In `src/worlds/WorldManager.js`, in `build(id)`, replace the early-return:

```js
    const world = this.getWorld(id);
    if (world._built) {
```

with:

```js
    const world = this.getWorld(id);
    /* A volatile world re-generates on every request rather than serving its
     * cached build. The maze uses this: a layout that survived the last visit
     * would be a layout the player could learn. */
    const volatile = this._classes.get(id)?.volatile === true;
    if (world._built && volatile) {
      world.dispose();
    }
    if (world._built) {
```

Then in `scheduleBackgroundBuilds` in `src/main.js`, skip volatile worlds — pre-building a layout that will be thrown away wastes the idle time it costs:

```js
function scheduleBackgroundBuilds(startWorld) {
  const rest = worldManager.ids.filter(
    (id) => id !== startWorld && !worldManager.isVolatile(id),
  );
```

And add the accessor to `WorldManager`, next to `isBuilt`:

```js
  /** True when this world re-generates on every activation. */
  isVolatile(id) {
    return this._classes.get(id)?.volatile === true;
  }
```

- [ ] **Step 5: Register the world**

In `src/main.js`, after the `CitadelWorld` import (line 13):

```js
import { MazeWorld } from './worlds/MazeWorld.js';
```

and after `worldManager.register(RaceWorld);` (line 109):

```js
worldManager.register(MazeWorld);
```

- [ ] **Step 5a: Make the signage atlas one row bigger**

**Read Steps 5a–5d before starting any of them.** The station's four gateways sit at `±PORTAL_R` on the two axes, and the signage atlas is exactly full. A fifth arch touches both. `SIGN_COLS = 4` and `SIGN_ROWS = 9` in `src/worlds/station/StationKit.js:269-270` give 36 cells, and `SIGNS` in `StationWorld.js:996` has exactly 36 entries. `paintSignAtlas` loops `i < SIGN_COLS * SIGN_ROWS` and destructures `SIGNS[i]` unconditionally, so **the array must have exactly as many entries as the grid has cells** — a short array throws `Cannot destructure`, and a long one is silently ignored.

In `src/worlds/station/StationKit.js`, line 270:

```js
export const SIGN_ROWS = 10;
```

That takes the atlas to 40 cells and the texture to 3072 × 3840. Now append exactly four entries to the end of `SIGNS` in `StationWorld.js`, keeping the existing 36 untouched so no role index shifts:

```js
  // --- Gateway 05: the maze. Appended, never inserted - SIGN_ROLE indexes
  //     this array positionally and inserting would re-label every sign after
  //     the insertion point.
  ['GATEWAY 05', 'THE VERDANT COIL', '#8fd67a'],
  ['THE VERDANT COIL', 'GATEWAY 05 AHEAD', '#8fd67a'],
  ['NO WAY BACK BUT THROUGH', 'HEDGE MAZE // NO EQUIPMENT', '#8fd67a'],
  ['LOST PROPERTY', 'ENQUIRE AT GATEWAY 05', '#8fe6c8'],
```

Then add the roles to `SIGN_ROLE` (after `galleyStall: 32`, continuing the numbering):

```js
  gatewayMaze: 36,
  approachMaze: 37,
  mazeWarning: 38,
  lostProperty: 39,
```

- [ ] **Step 5b: Let an axis gateway sit off-axis**

In `_buildAxisGateway` (line 5637), replace line 5641:

```js
    const cz = spec.offsetZ ?? 0;
```

Every placement in that function already reads `cz` **except two**, at lines 5754-5755, which hardcode the ramp-edge markers:

```js
      B.at(em, boxGeo(0.5, 0.14, 0.5, 1), sx, D + 0.1, cz - 6);
      B.at(em, boxGeo(0.5, 0.14, 0.5, 1), sx, D + 0.1, cz + 6);
```

The batch name at the `B.flush` near line 5760 is hardcoded to `'gateway-citadel'`; three gateways sharing one batch name will collide. Change it to:

```js
    B.flush(g, M, `gateway-${spec.target}`, { cast: true, recv: true });
```

And the sign role at line 5695 branches on two targets only. Replace it with a lookup:

```js
      spec.signRole ?? SIGN_ROLE.gatewayRace,
```

so each caller states its own, and update the two existing calls (Step 5c) to pass theirs.

- [ ] **Step 5c: Add the fifth gateway**

In `src/worlds/StationWorld.js`, the two existing calls at lines 5601-5606 gain explicit sign roles, and a third is added:

```js
    this._buildAxisGateway(g, {
      side: -1, target: 'citadel', label: 'Sunspire Citadel', accent: 0xffc46b,
      signRole: SIGN_ROLE.gatewayCitadel,
    });
    this._buildAxisGateway(g, {
      side: 1, target: 'race', label: 'Vellum Ridge', accent: 0xff5a3c,
      signRole: SIGN_ROLE.gatewayRace,
    });
    /* The fifth arch. The other four occupy the two axes at +-PORTAL_R, so this
     * one is offset along Z to keep an 11 m dais clear of the citadel's. */
    this._buildAxisGateway(g, {
      side: -1, target: 'maze', label: 'The Verdant Coil', accent: 0x8fd67a,
      signRole: SIGN_ROLE.gatewayMaze, offsetZ: 128,
    });
```

- [ ] **Step 5d: Verify the atlas did not break**

Run: `npm run dev` and open `http://localhost:5173/?dev=1`. Walk the gateway deck and confirm: five arches, each with a **different, correctly-named** placard, and no blank or duplicated signs anywhere on the station. A wrong `SIGN_ROWS`/`SIGNS` count shows up as either a boot exception or signs reading the wrong text — both obvious immediately.

- [ ] **Step 6: Update the contract check**

In `scripts/contract-check.mjs`, add to the `CONTRACT` array:

```js
  { file: 'src/worlds/WorldRules.js', exports: ['DEFAULT_RULES', 'makeRules', 'allows'] },
  {
    file: 'src/worlds/maze/MazeTopology.js',
    exports: ['MAZE', 'DIR', 'generateTopology', 'solve', 'reachableCount',
              'buildDistrictGraph', 'carveDistrict', 'cellIndex', 'cellCoords'],
  },
  { file: 'src/worlds/maze/MazeColliders.js', exports: ['districtColliders', 'cellToWorld'] },
  { file: 'src/worlds/MazeWorld.js', exports: ['MazeWorld'], methods: ['build', 'dispose'] },
```

- [ ] **Step 7: Run everything**

Run: `npm test && node scripts/contract-check.mjs`

Expected: PASS on both.

- [ ] **Step 8: Walk it**

Run: `npm run dev`, open `http://localhost:5173/?dev=1&world=maze`.

Verify by hand:
1. You spawn in a corridor with hedges around you.
2. `W` walks; you cannot pass through a hedge.
3. `Space` hops and clears nothing.
4. No weapon viewmodel; `1`–`4` select nothing.
5. `G`/`H`/`J` summon no mount.
6. No loot, caches, relics or traders on the minimap.
7. The return arch is behind the spawn; walking into it and pressing `E` returns you to the station.
8. Portalling back into the maze gives a **different layout**.

In the console, confirm the maze is genuinely re-rolling:

```js
GAME.worldManager.getWorld('maze').seed
```

Note the value, portal out, portal back, and read it again. It must differ.

- [ ] **Step 9: Commit**

```bash
git add src/worlds/MazeWorld.js src/worlds/WorldManager.js src/main.js src/worlds/StationWorld.js scripts/contract-check.mjs scripts/tests/rules-applied.test.mjs
git commit -m "Open a gateway into a maze that is different every time

Walk through the fifth arch on the gateway deck and you are in a hedge maze
that has never existed before and will not exist again - a fresh seed on every
build, and the world manager now knows to throw away a volatile world's cached
build rather than serving the layout you already learned.

Phase 1 scope on purpose: one level, every district built up front, boxes
instead of foliage. Streaming and the other three levels are Phase 2, and
building the whole level at once takes streaming out of the equation while the
topology and containment work is being proven.

Two things here look like oversights and are not. The material set is created
once and deliberately survives dispose(), because reallocating it per entry
would re-trigger the shader compilation that already dominates cold boot. And
the credit stack at the centre has no collider at all: it is 0.7m tall, which
sits squarely in the hop band, and the centre cell has hedges on three sides -
a solid stack there is a step onto the hedge tops."
```

---

## Phase 1 exit criteria

All must hold before Phase 2 is planned:

- [ ] `npm test` passes, including the 1000-seed solvability gate, the 50,000-attempt containment gate, the seam gate and the anti-ladder gate.
- [ ] `node scripts/contract-check.mjs` exits 0.
- [ ] The station's fifth arch leads to the maze, and the maze's arch leads back.
- [ ] Two consecutive entries produce two different seeds and two visibly different layouts.
- [ ] In the maze: no weapons, no mounts, no loot, no caches, no relics, no traders, no quests, no climbing.
- [ ] In the station: all of the above still work exactly as before.
- [ ] A hop clears no hedge anywhere.

## What Phase 1 knowingly does not do

Listed so nobody mistakes them for bugs:

- **One level only.** Levels 1–3 are generated by the graph but not carved or built. No stairs, tunnels or lifts exist yet.
- **No streaming.** The whole level is built up front, which will not meet the 3-second entry budget at four levels.
- **No art.** Hedges are green boxes. No foliage, no stone, no wind, no towers.
- **No puzzles.** No lifts, rotating bridges, pressure plates, one-way gates or lever staircases.
- **No map.** `M` does nothing; the minimap has no maze floorplan yet.
- **No NPCs.** No keeper, no wanderers.
- **No abandon control.** `L` does nothing — you leave by walking back to the entrance arch.
- **The centre pays nothing.** The stack is scenery; collecting it and the return portal are Phase 4.
