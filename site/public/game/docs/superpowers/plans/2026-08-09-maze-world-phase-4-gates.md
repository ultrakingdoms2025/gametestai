# Maze World — Phase 4: Puzzles That Gate Passage

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Put the first mechanical puzzles into the maze — a one-way gate that commits you forward and a sliding hedge wall a plate opens — placed on district-graph edges so they gate passage rather than decorate a corridor, and proven never to strand anyone.

**Architecture:** Puzzles are chosen from the district graph, not from geometry: a pure function decides which edges carry one, exactly the way `connectorKind` decides what a vertical link becomes. The one-way gate's safety is a *construction* guarantee rather than a search — a gate is only ever placed along the entrance→centre path and oriented forward, so passing it always brings you closer and closing it can never cut you off. The sliding wall is a moving standable and reuses Phase 2c's swept descriptors and halt-while-occupied invariant unchanged.

**Tech Stack:** Three.js 0.185.1, Vite 8, vanilla ES modules. Tests use Node's built-in `node:test` — **no new dependencies**.

## Global Constraints

- **The topology array and the district graph are the source of truth.** Puzzle placement is decided from them and never from geometry.
- **No collidable surface may present a standable top between 0.45 m and 5.0 m** outside a proven sealed shaft. A sliding wall passes through that band, so it is governed by `swept` and by the halt-while-occupied invariant that made the lift door safe — measured in Phase 2c at 14.000 m when that invariant was removed.
- **One-way gates must never strand a player.** §8. Combined with hold-`L`, there must be no reachable stranded state.
- **`MazeTopology.js`, `MazeColliders.js`, `MazeShafts.js` and `MazePlan.js` stay pure** — no `three`, no DOM. A new `MazePuzzles.js` joins them under the same rule.
- **Materials are cached and reused across re-rolls.** A per-puzzle material allocation is a task failure.
- **`MazeWorld` never touches `Economy` or `HUD`.** It emits on the bus; `main.js` integrates.
- **No new npm dependencies.** `.js` extensions in all import specifiers.

## The safety argument, decided before any code

§8 says the graph is "validated after gate placement to confirm the entrance→centre route and an abandon route survive every gate closure". This plan does something stronger and cheaper, and the difference is worth stating:

- **The abandon route needs no validation at all.** Phase 3 shipped hold-`L`, which works from anywhere at any depth. There is no configuration of gates that can strand a player from *leaving*.
- **The entrance→centre route is guaranteed by construction, not by search.** A gate is placed only on an edge of the district-level entrance→centre path, oriented **forward along that path**. Passing it always moves you closer to the centre, so no closure can put the centre behind a gate you cannot re-open. A validation search would confirm this after the fact; deriving the placement from the path means there is nothing to confirm.

A test still re-solves after every gate closure — not because the construction is in doubt, but because a construction guarantee that nobody checks is exactly how Phase 2b's `enclosed` flag became self-certifying.

## File structure

| File | Responsibility |
|---|---|
| `src/worlds/maze/MazePuzzles.js` | **New.** Pure: the district path, which edges carry a puzzle, and of what kind. |
| `src/worlds/maze/MazeShafts.js` | Gains `gateColliders` and `slidingWallColliders` — moving parts belong with the moving parts. |
| `src/worlds/maze/MazeChunks.js` | Registers gates and sliding walls the way it registers lifts. |
| `src/worlds/MazeWorld.js` | Materials; steps them from `update`. |

---

### Task 1: Which edges carry a puzzle

**Files:**
- Create: `src/worlds/maze/MazePuzzles.js`
- Create: `scripts/tests/maze-puzzles.test.mjs`

**Interfaces:**
- Consumes: `MAZE`, `hash32`, `districtIndex`, `districtCoords`, `edgeKey`, `buildDistrictGraph`, `cellCoords`.
- Produces:
  - `districtPath(graph, fromDistrict, toDistrict) -> number[]` — district indices, entrance to centre, or `[]` if unreachable.
  - `PUZZLE = { NONE: 0, GATE: 1, SLIDE: 2 }`
  - `puzzleOnEdge(seed, a, b) -> 0|1|2` — pure, hashed on the canonical edge.
  - `placePuzzles(seed, graph, entranceDistrict, centreDistrict) -> Map<string, {kind:number, forward:[number,number]}>` — keyed by `edgeKey`, and `forward` is the ordered pair a gate may be passed in.

**Density.** Roughly one per 6–8 districts, weighted onto the solution path — and the spec calls that "a guess until the maze is walkable and is expected to change", so it is a named constant, not a literal.

- [ ] **Step 1: Write the failing test**

Create `scripts/tests/maze-puzzles.test.mjs`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  MAZE, generateTopology, buildDistrictGraph, districtIndex, districtCoords,
  edgeKey, cellCoords, isEdgeOpen,
} from '../../src/worlds/maze/MazeTopology.js';
import { PUZZLE, districtPath, placePuzzles } from '../../src/worlds/maze/MazePuzzles.js';

/** The district a cell sits in. */
function districtOfCell(idx) {
  const c = cellCoords(idx);
  return districtIndex(Math.floor(c.x / MAZE.DISTRICT), Math.floor(c.z / MAZE.DISTRICT), c.level);
}

test('districtPath walks only edges the graph has open', () => {
  const t = generateTopology(2026);
  const graph = buildDistrictGraph(2026);
  const from = districtOfCell(t.entranceCell);
  const to = districtOfCell(t.centreCell);
  const path = districtPath(graph, from, to);
  assert.ok(path.length > 1, `no path from ${from} to ${to}`);
  assert.equal(path[0], from);
  assert.equal(path[path.length - 1], to);
  for (let i = 1; i < path.length; i++) {
    assert.ok(isEdgeOpen(graph, path[i - 1], path[i]),
      `path step ${path[i - 1]} -> ${path[i]} is not an open edge`);
  }
});

test('THE GATE PLACEMENT GATE: every gate sits on the solution path, pointing forward', () => {
  /* The whole safety argument. A gate placed anywhere else, or pointing the
   * other way, could put the centre behind a door that only opens the way you
   * came - which is the "one-way gates must never strand a player" constraint
   * failing by construction rather than by accident. */
  for (const seed of [1, 42, 2026]) {
    const t = generateTopology(seed);
    const graph = buildDistrictGraph(seed);
    const from = districtOfCell(t.entranceCell);
    const to = districtOfCell(t.centreCell);
    const path = districtPath(graph, from, to);
    const order = new Map(path.map((d, i) => [d, i]));
    const placed = placePuzzles(seed, graph, from, to);

    let gates = 0;
    for (const [key, p] of placed) {
      if (p.kind !== PUZZLE.GATE) continue;
      const [a, b] = p.forward;
      assert.equal(edgeKey(a, b), key, 'forward pair does not match the edge it is keyed on');
      assert.ok(order.has(a) && order.has(b), `gate on ${key} is not on the solution path`);
      assert.equal(order.get(b), order.get(a) + 1,
        `gate on ${key} points backwards along the path - passing it would move the player AWAY from the centre`);
      gates++;
    }
    assert.ok(gates > 0, `seed ${seed} placed no gates at all`);
  }
});

test('placement is deterministic and re-rolls with the seed', () => {
  const g1 = buildDistrictGraph(7);
  const a = placePuzzles(7, g1, 0, 500);
  const b = placePuzzles(7, g1, 0, 500);
  assert.deepEqual([...a.keys()].sort(), [...b.keys()].sort());
  const c = placePuzzles(8, buildDistrictGraph(8), 0, 500);
  assert.notDeepEqual([...a.keys()].sort(), [...c.keys()].sort());
});

test('density is roughly one puzzle per 6-8 districts, and is not zero', () => {
  for (const seed of [1, 2026]) {
    const t = generateTopology(seed);
    const graph = buildDistrictGraph(seed);
    const from = districtOfCell(t.entranceCell);
    const to = districtOfCell(t.centreCell);
    const placed = placePuzzles(seed, graph, from, to);
    const districts = MAZE.DISTRICTS * MAZE.DISTRICTS * MAZE.LEVELS;
    const per = districts / Math.max(1, placed.size);
    assert.ok(placed.size > 0, 'no puzzles at all');
    assert.ok(per > 3 && per < 40,
      `one puzzle per ${per.toFixed(1)} districts - the spec asks for roughly one per 6-8, and this is a guess `
      + 'that is expected to change, but not by an order of magnitude');
  }
});

test('a sliding wall is never placed on the solution path', () => {
  /* A gate commits you forward and is safe there. A sliding wall BLOCKS until
   * its plate is found, so one on the only route to the centre is a puzzle
   * that can be failed permanently by not finding a plate - which is a trap,
   * and the spec allows committal but not traps. */
  const t = generateTopology(2026);
  const graph = buildDistrictGraph(2026);
  const from = districtOfCell(t.entranceCell);
  const to = districtOfCell(t.centreCell);
  const path = new Set(districtPath(graph, from, to));
  for (const [key, p] of placePuzzles(2026, graph, from, to)) {
    if (p.kind !== PUZZLE.SLIDE) continue;
    const [a, b] = key.split('|').map(Number);
    assert.ok(!(path.has(a) && path.has(b)),
      `a sliding wall sits on the solution path at ${key}`);
  }
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `node --test scripts/tests/maze-puzzles.test.mjs`
Expected: FAIL — `Cannot find module '.../MazePuzzles.js'`.

- [ ] **Step 3: Write `MazePuzzles.js`**

```js
/**
 * Which district edges carry a puzzle, and of what kind.
 *
 * Pure and decided from the DISTRICT GRAPH, never from geometry - the same
 * discipline `connectorKind` follows, and for the same reason: the map, the
 * solvability gate and the placement all have to agree, and only the topology
 * is available to all three.
 */
import {
  MAZE, hash32, districtIndex, districtCoords, edgeKey, isEdgeOpen,
} from './MazeTopology.js';

export const PUZZLE = Object.freeze({ NONE: 0, GATE: 1, SLIDE: 2 });

/**
 * Roughly one puzzle per this many districts.
 *
 * "Density is a guess until the maze is walkable and is expected to change" -
 * the spec's own words, which is why this is a named constant.
 */
const DISTRICTS_PER_PUZZLE = 7;

/**
 * Six-neighbourhood of a district, in bounds.
 *
 * Mirrors `districtNeighbours` exactly rather than re-deriving its bounds
 * loosely: a puzzle placed on an edge that does not exist is a puzzle nobody
 * can reach, and it would not show up as an error anywhere.
 */
function neighbours(index) {
  const { dx, dz, level } = districtCoords(index);
  const out = [];
  if (dz > 0) out.push(districtIndex(dx, dz - 1, level));
  if (dx < MAZE.DISTRICTS - 1) out.push(districtIndex(dx + 1, dz, level));
  if (dz < MAZE.DISTRICTS - 1) out.push(districtIndex(dx, dz + 1, level));
  if (dx > 0) out.push(districtIndex(dx - 1, dz, level));
  if (level > 0) out.push(districtIndex(dx, dz, level - 1));
  if (level < MAZE.LEVELS - 1) out.push(districtIndex(dx, dz, level + 1));
  return out;
}

/** Breadth-first path over the graph's OPEN edges, or [] if unreachable. */
export function districtPath(graph, from, to) {
  if (from === to) return [from];
  const total = MAZE.DISTRICTS * MAZE.DISTRICTS * MAZE.LEVELS;
  const prev = new Int32Array(total).fill(-1);
  const seen = new Uint8Array(total);
  const queue = new Int32Array(total);
  let head = 0, tail = 0;
  queue[tail++] = from;
  seen[from] = 1;
  while (head < tail) {
    const cur = queue[head++];
    for (const n of neighbours(cur)) {
      if (seen[n] || !isEdgeOpen(graph, cur, n)) continue;
      seen[n] = 1;
      prev[n] = cur;
      if (n === to) {
        const path = [to];
        for (let c = to; prev[c] >= 0; c = prev[c]) path.push(prev[c]);
        return path.reverse();
      }
      queue[tail++] = n;
    }
  }
  return [];
}

/**
 * Choose puzzles.
 *
 * Gates go ONLY on solution-path edges, oriented FORWARD, which is the entire
 * "never strands a player" guarantee - see the plan's safety section. Sliding
 * walls go only OFF the path, because one on the only route is a puzzle that
 * can be failed permanently, which is a trap rather than a committal.
 */
export function placePuzzles(seed, graph, fromDistrict, toDistrict) {
  const out = new Map();
  const path = districtPath(graph, fromDistrict, toDistrict);
  const onPath = new Set(path);
  const total = MAZE.DISTRICTS * MAZE.DISTRICTS * MAZE.LEVELS;
  const want = Math.max(1, Math.round(total / DISTRICTS_PER_PUZZLE));

  /* Gates first, along the path, weighted onto it exactly as the spec asks.
   * Every third path edge, hashed so which third re-rolls with the seed. */
  for (let i = 1; i < path.length; i++) {
    const a = path[i - 1], b = path[i];
    if (hash32(seed, a, b, 0x9e1) % 3 !== 0) continue;
    out.set(edgeKey(a, b), { kind: PUZZLE.GATE, forward: [a, b] });
  }

  /* Sliding walls fill the rest of the budget, off the path. */
  for (const key of graph.open) {
    if (out.size >= want) break;
    if (out.has(key)) continue;
    const [a, b] = key.split('|').map(Number);
    if (onPath.has(a) && onPath.has(b)) continue;
    if (hash32(seed, a, b, 0x3c7) % DISTRICTS_PER_PUZZLE !== 0) continue;
    out.set(key, { kind: PUZZLE.SLIDE, forward: [a, b] });
  }
  return out;
}
```

- [ ] **Step 4: Run the tests**

Expected: PASS.

- [ ] **Step 5: Prove the placement gate is not vacuous**

Temporarily reverse the `forward` pair in `placePuzzles`. Expected: `THE GATE PLACEMENT GATE` FAILS with "points backwards along the path". **Revert**, and record the message.

- [ ] **Step 6: Commit**

```bash
npm test && node scripts/contract-check.mjs
git add src/worlds/maze/MazePuzzles.js scripts/tests/maze-puzzles.test.mjs
git commit -m "Choose where the puzzles go, from the graph and not the geometry"
```

---

### Task 2: The one-way gate

**Files:**
- Modify: `src/worlds/maze/MazeShafts.js` — `gateColliders`
- Modify: `src/worlds/maze/MazeColliders.js` — emit on a puzzle edge
- Modify: `src/worlds/maze/MazeChunks.js` — the gate registry
- Modify: `src/worlds/MazeWorld.js` — the `gate` material
- Modify: `scripts/tests/maze-puzzles.test.mjs` (append)

**Interfaces:**
- Consumes: `placePuzzles`, `PUZZLE`.
- Produces: `gateColliders(cells, x, z, level, dir) -> ColliderDesc[]` with one descriptor of `kind: 'gate'`.

**Behaviour.** A gate stands open until the player passes it in the forward direction, then closes behind them and stays closed for the visit. It is a *committal*, not a trap: the graph guarantees an onward route, and hold-`L` guarantees a way out regardless.

**Its top sits at `HEDGE_HEIGHT` when closed** — exactly on the band's ceiling, like the guard rails and the lift door, and safe for the same reason. Its transit through the band is made safe by the same halt-while-occupied invariant, reused rather than reimplemented.

- [ ] **Step 1: Write the failing test**

```js
test('THE NEVER-STRAND GATE: closing every gate leaves the centre reachable', () => {
  /* The spec's hard constraint, checked by re-solving rather than by trusting
   * the construction - a construction guarantee nobody checks is how Phase
   * 2b's `enclosed` flag became self-certifying. */
  for (const seed of [1, 42, 2026]) {
    const t = generateTopology(seed);
    const graph = buildDistrictGraph(seed);
    const from = districtOfCell(t.entranceCell);
    const to = districtOfCell(t.centreCell);
    const placed = placePuzzles(seed, graph, from, to);

    // Shut every gate: remove its edge from the graph in the BACKWARD
    // direction only, which is what a one-way gate does.
    const closed = new Set(graph.open);
    for (const [key, p] of placed) if (p.kind === PUZZLE.GATE) closed.delete(key);
    const shut = { ...graph, open: closed };

    assert.ok(districtPath(shut, from, to).length > 1,
      `seed ${seed}: with every gate shut, the centre is unreachable - that is a stranded player`);
  }
});
```

Removing the edge entirely is **stricter** than a one-way gate actually is, so a pass here is a stronger statement than the constraint requires. Say so in the test.

- [ ] **Step 2: Run it and watch it fail**, then implement `gateColliders` and the registry, mirroring the lift's `_registerMover`/`stepLifts` structure exactly.

- [ ] **Step 3: Add `'gate'` to `CHUNK_MESH_KINDS` and a cached material in `MazeWorld`.**

The render-coverage test will fail loudly if the kind is emitted and not drawn — that test exists because ~14,800 stair treads once shipped solid, walkable and invisible.

- [ ] **Step 4: Run everything, including `MAZE_SEEDS=1000 npm test`.**

- [ ] **Step 5: Commit.**

---

### Task 3: The sliding hedge wall

**Files:**
- Modify: `src/worlds/maze/MazeShafts.js` — `slidingWallColliders`
- Modify: `src/worlds/maze/MazeChunks.js` — step it
- Modify: `scripts/tests/maze-lift-motion.test.mjs` (append — same machinery, same file)

**Interfaces:**
- Produces: `slidingWallColliders(cells, x, z, level, dir) -> ColliderDesc[]` with one `kind: 'slideWall'` carrying `swept`, and a plate footprint.

**It is the lift door with a different trigger**, and it must reuse that machinery rather than grow a parallel copy: a wall whose top sweeps 0 → 5.0 m outside a sealed shaft is a ladder unless it refuses to move while occupied. Phase 2c measured an unguarded one carrying a rider to 14.000 m.

- [ ] **Step 1: Write the failing tests** — the same three the lift door has, against a sliding wall: it does not move while its footprint is occupied; it does move when clear; and removing the guard lets a rider be carried above what they could reach unaided.

- [ ] **Step 2–5:** implement, run, mutation-verify the guard, commit.

---

### Task 4: Prove it in the browser

- [ ] **Step 1:** `mazeStats()` gains `gatesResident`, `slidesResident`.
- [ ] **Step 2:** A `gate` harness view, resident-scanning and emission-checked like `lift-car`.
- [ ] **Step 3:** Walk a gate forward, confirm it shuts and cannot be re-entered; confirm hold-`L` still works from behind it.
- [ ] **Step 4:** Stand in a sliding wall's footprint and confirm it refuses to move.
- [ ] **Step 5:** Ten entries, programs flat.
- [ ] **Step 6:** Record findings in the ledger and commit.

---

## Phase 4 exit criteria

- [ ] `npm test` and `MAZE_SEEDS=1000 npm test` pass; contract-check exits 0; build succeeds.
- [ ] Every gate sits on the entrance→centre path, oriented forward — asserted, and red-verified.
- [ ] With every gate shut, the centre is still reachable on every seed tested.
- [ ] No sliding wall sits on the solution path.
- [ ] No moving part presents a standable top in the band outside a sealed shaft, at any point in its travel.
- [ ] Shader programs still flat across ten entries.

## What Phase 4 knowingly does not do

- **No rotating bridge and no lever staircase.** Both put *standable* surfaces in the 0.45–5.0 m band as a matter of course — a bridge you walk across, treads you assemble — and each needs its own footprint proof of the kind the lift landing and the tunnel fold both required. Bundling them here would repeat Phase 2c's mistake of building two new shapes in one phase.
- **No counterweight-lift puzzle framing.** The lift mechanism shipped in Phase 2c as a connector; making it a *puzzle* (a counterweight to load, a lever to release) is separate work.
- **No art pass.** Levels 0–2 remain roofed and dim.
