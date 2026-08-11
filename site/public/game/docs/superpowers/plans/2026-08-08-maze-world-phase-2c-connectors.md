# Maze World — Phase 2c: Lifts and Tunnels Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the maze the two vertical connectors Phase 2b deferred — a counterweight lift you call and ride, and a switchback tunnel you climb — so that not every way up is the same spiral staircase.

**Architecture:** The connector's kind is written into the topology array as two spare bits on the cell that carries `DIR.UP`, so geometry, the map, NPC routing and every headless gate read it from the single source of truth without a seed being threaded anywhere. `MazeColliders.js` splits, with all three connector geometries and the shared enclosure machinery moving to a new pure `MazeShafts.js`. The lift is the project's first moving collider inside the maze, and it is made safe by emitting a *swept* descriptor for the static gates while `MazeChunks` builds a real platform for physics.

**Tech Stack:** Three.js 0.185.1, Vite 8, vanilla ES modules. Tests use Node's built-in `node:test` — **no new dependencies**.

## Global Constraints

From `docs/superpowers/specs/2026-08-08-maze-world-phase-2c-design.md` and its parent. Every task's requirements implicitly include this section.

- **Cell pitch 6.0 m. Corridor 4.8 m. Hedge thickness 1.2 m. Hedge height 5.0 m. `LEVEL_HEIGHT` 9.0 m.**
- **District 20 × 20 cells. 20 × 20 districts per level. 4 levels. 640,000 cells.**
- **A hop clears exactly 0.93 m; auto-step is 0.45 m; the real reach above a standable is `HOP + STEP_HEIGHT` = 1.38 m.**
- **`MazeTopology.js`, `MazeColliders.js` and the new `MazeShafts.js` stay pure** — no `three`, no DOM. This is what keeps the headless gates running, and it is asserted textually by a committed test.
- **Materials are reused across re-rolls and across chunks.** A per-connector material allocation is a task failure.
- **No lights may be added.** `LightRig.js` pools lights into fixed slots because Three bakes the light *count* into every shader's program cache key. Emissive materials only.
- **Portal entry stays under 3 s. Residency stays bounded.**
- **No new npm dependencies.** `.js` extensions in all import specifiers.
- **A bar is never lowered quietly.** Where an existing threshold is restated, the restatement is capped at the original so it cannot drift looser.

## The two things this plan front-loads, and why

Phase 2b's Task 3 took four fix rounds. Each round's fix created the next round's Critical, and the eventual root cause was that the geometry first chosen made three requirements *mutually unsatisfiable* — which three rounds of patching could not discover. Round 4 succeeded only when a fresh implementer was handed all six constraints at once with licence to redesign.

So this plan proves two footprints are satisfiable **before** any geometry is written for them:

- **Task 4 — the lift landing.** The spec attributed the footprint risk to the tunnel alone. Working the geometry during planning showed the lift has the same problem in a sharper form: *a lift shaft with the car at the bottom is a nine-metre hole in level N+1's floor.* The staircase's opening is safe because there are treads under every point of it — `THE WALK-ON-IT GATE` measures a worst-case drop of 0.758 m. Under a lift's opening, car down, there is nothing for 9 m. That gate will fail, correctly, on the first lift built without an answer to this.
- **Task 7 — the tunnel footprint.** A 9 m climb needs ~18 m of run, so a U-fold spans a 2×2 cell block on two levels, and its body is wider than the 4.8 m corridor it sits in. Four cells stay walkable on each of two levels, or the tunnel severs the maze.

Both tasks ship a *proof*, not geometry. Both may conclude their footprint is unsatisfiable, and that is a legitimate outcome: the connectors are independent, so the tunnel can be cut without touching the lift.

**Why Tasks 4, 7 and 9 carry less code than the rest, stated plainly.** Every other task here has its implementation written out. Those three do not, because their numbers are the *output* of the proofs rather than an input to them — a plan that wrote down a tread width, a flight length or a landing arrangement would be inventing the answer the task exists to find, and this project's whole history is what happens when a shaft constant is asserted rather than derived. What those tasks do carry is the full constraint set, the fixture scaffolding, the candidate arrangements with their known hazards, and an explicit instruction to stop and report rather than move a bar. Task 9 builds to Task 7's proven parameters exactly; if building reveals they were wrong, it returns to Task 7 rather than adjusting them in place.

## Scope

In: connector kinds in the topology array, the `MazeShafts.js` split, swept descriptors, the lift (geometry and motion), the tunnel (footprint and geometry), multi-cell floor perforation, and three minors carried from the 2a/2b ledgers.

Out: the `M` map, puzzles, the abandon control, the centre reward, and the art pass. Those are Phases 3–5.

## File structure

| File | Responsibility after this phase |
|---|---|
| `src/worlds/maze/MazeTopology.js` | Graph, carve, connector bits and the pure chooser. Gains `cellToWorld`. |
| `src/worlds/maze/MazeShafts.js` | **New.** All three connector geometries plus the shared enclosure machinery (`requiredWallTop`, `isEnclosureSound`, `ENTRY_SEAL_FROM`, well bounds). Pure. |
| `src/worlds/maze/MazeColliders.js` | District hedges, floors, perforation and the forecourt. Pure. Imports connector geometry from `MazeShafts.js`. |
| `src/worlds/maze/MazeChunks.js` | Streaming; the per-district lift registry; mesh kinds. |
| `src/worlds/MazeWorld.js` | Materials; steps live lifts each frame. |

`MazeShafts.js` imports only from `MazeTopology.js`, and `MazeColliders.js` imports from both. There is no cycle, and Task 2 exists partly to guarantee that.

---

### Task 1: Connector kinds live in the topology array

**Files:**
- Modify: `src/worlds/maze/MazeTopology.js` — add `CONNECTOR`, `CONNECTOR_WEIGHTS`, `connectorKind`, `connectorAt`; write the bits in `carveDistrict` (~line 392)
- Modify: `scripts/tests/maze-topology.test.mjs` (append)

**Interfaces:**
- Consumes: `hash32`, `cellIndex`, `MAZE`, `DIR`.
- Produces:
  - `CONNECTOR` — `{ STAIR: 0x00, TUNNEL: 0x40, LIFT: 0x80 }`, the two spare bits of a cell byte.
  - `CONNECTOR_MASK` — `0xc0`.
  - `CONNECTOR_WEIGHTS` — `{ stair: 60, tunnel: 25, lift: 15 }`.
  - `connectorKind(seed, x, z, level) -> 'stair'|'tunnel'|'lift'` — the pure chooser, called only by `carveDistrict`.
  - `connectorAt(cells, x, z, level) -> 'stair'|'tunnel'|'lift'` — the reader every consumer uses.

**Why the bits and not a seed parameter.** `districtColliders(cells, dx, dz, level)` has no seed and must not gain one: `MazeChunks` would have to thread it, and so would every gate that builds descriptors. The parent spec already names the topology array as "the single source of truth for lift, stair and tunnel placement" — this is that sentence implemented. `DIR` occupies bits 0–5; bits 6 and 7 are free, and `isOpen`'s `cells[idx] & dir` never sees them.

**The bits live on the LOWER cell only** — the one carrying `DIR.UP`. The upper cell carries `DIR.DOWN` and its connector bits stay zero. Every reader must resolve a link from its lower end.

- [ ] **Step 1: Confirm no existing code treats a cell byte as a whole**

Run: `grep -rn "cells\[[a-z]*\] *[!=]==\? *0\|cells\[[a-z]*\] *>" src/ scripts/`

Expected: no hit that would misread a cell with bit 6 or 7 set as "carved" when it has no passage bits. If a hit exists, it must be changed to mask with the direction bits before the rest of this task proceeds. Record what you found in the ledger either way.

- [ ] **Step 2: Write the failing tests**

Append to `scripts/tests/maze-topology.test.mjs`:

```js
import {
  CONNECTOR, CONNECTOR_MASK, CONNECTOR_WEIGHTS, connectorKind, connectorAt,
} from '../../src/worlds/maze/MazeTopology.js';

test('connector bits do not collide with the direction bits', () => {
  for (const dir of [DIR.N, DIR.E, DIR.S, DIR.W, DIR.UP, DIR.DOWN]) {
    assert.equal(dir & CONNECTOR_MASK, 0, `direction bit ${dir} overlaps the connector mask`);
  }
  for (const v of Object.values(CONNECTOR)) {
    assert.equal(v & ~CONNECTOR_MASK, 0, `connector value ${v} leaks outside its mask`);
  }
});

test('connectorKind is deterministic and returns only the three kinds', () => {
  const kinds = new Set();
  for (let i = 0; i < 500; i++) {
    const k = connectorKind(99, i % 40, Math.floor(i / 40), i % 3);
    assert.ok(['stair', 'tunnel', 'lift'].includes(k), `unexpected kind ${k}`);
    kinds.add(k);
    assert.equal(connectorKind(99, i % 40, Math.floor(i / 40), i % 3), k, 'not deterministic');
  }
  assert.equal(kinds.size, 3, 'all three kinds must occur');
});

test('THE CONNECTOR MIX GATE: real generated links follow the weights', () => {
  const counts = { stair: 0, tunnel: 0, lift: 0 };
  for (const seed of [1, 2026, 77771]) {
    const { cells } = generateTopology(seed);
    for (let level = 0; level < MAZE.LEVELS - 1; level++) {
      for (let z = 0; z < MAZE.CELLS; z++) {
        for (let x = 0; x < MAZE.CELLS; x++) {
          if (isOpen(cells, cellIndex(x, z, level), DIR.UP)) counts[connectorAt(cells, x, z, level)]++;
        }
      }
    }
  }
  const total = counts.stair + counts.tunnel + counts.lift;
  assert.ok(total > 500, `expected plenty of vertical links, got ${total}`);
  const weightTotal = CONNECTOR_WEIGHTS.stair + CONNECTOR_WEIGHTS.tunnel + CONNECTOR_WEIGHTS.lift;
  for (const kind of ['stair', 'tunnel', 'lift']) {
    const want = CONNECTOR_WEIGHTS[kind] / weightTotal;
    const got = counts[kind] / total;
    // +/- 5 percentage points. Wide enough not to flake on ~900 samples,
    // tight enough that a broken chooser (all one kind, or uniform thirds)
    // cannot pass: uniform would put stair at 0.333 against a 0.55 floor.
    assert.ok(Math.abs(got - want) < 0.05,
      `${kind}: expected ~${want.toFixed(3)}, got ${got.toFixed(3)} over ${total} links`);
  }
});

test('a cell with no UP link reports stair and carries no connector bits', () => {
  const { cells } = generateTopology(4242);
  let checked = 0;
  for (let z = 0; z < 40 && checked < 50; z++) {
    for (let x = 0; x < 40 && checked < 50; x++) {
      const idx = cellIndex(x, z, 0);
      if (isOpen(cells, idx, DIR.UP)) continue;
      assert.equal(cells[idx] & CONNECTOR_MASK, 0, `cell ${x},${z} has connector bits with no UP link`);
      checked++;
    }
  }
  assert.equal(checked, 50, 'expected 50 non-UP cells to sample');
});
```

- [ ] **Step 3: Run the tests and watch them fail**

Run: `node --test scripts/tests/maze-topology.test.mjs`
Expected: FAIL — `CONNECTOR is not exported` or similar.

- [ ] **Step 4: Add the constants and the two functions**

In `src/worlds/maze/MazeTopology.js`, after the `DIR` / `OPPOSITE` / `STEP` block:

```js
/**
 * Which of the three vertical connectors a `DIR.UP` link becomes, stored in
 * the two spare bits of the cell byte that carries the link.
 *
 * `DIR` occupies bits 0-5. Bits 6 and 7 are free, and `isOpen`'s
 * `cells[idx] & dir` can never see them, so a connector kind rides along in
 * the topology array at zero cost. That placement is deliberate and is what
 * the parent spec means by "the topology array is the single source of truth
 * for lift, stair and tunnel placement": `districtColliders` has no seed and
 * must never gain one, the `M` map and NPC routing read topology and never
 * geometry, and every headless gate builds from `cells` alone. A chooser
 * called at geometry time would have to be handed the seed by all of them.
 *
 * The bits live on the LOWER cell only - the one carrying `DIR.UP`. Its
 * partner one level up carries `DIR.DOWN` and keeps its connector bits zero,
 * so a link is always resolved from its lower end. `connectorAt` is the only
 * supported reader.
 */
export const CONNECTOR_MASK = 0xc0;
export const CONNECTOR = Object.freeze({ STAIR: 0x00, TUNNEL: 0x40, LIFT: 0x80 });

/** Kind order, fixed, and the order `connectorKind` walks when weighting. */
const CONNECTOR_ORDER = Object.freeze(['stair', 'tunnel', 'lift']);
const CONNECTOR_VALUE = Object.freeze({
  stair: CONNECTOR.STAIR, tunnel: CONNECTOR.TUNNEL, lift: CONNECTOR.LIFT,
});

/**
 * Relative frequency of each connector.
 *
 * A guess until the maze is walked, and expected to change - the same honesty
 * the parent spec applies to puzzle density. Named rather than inlined so a
 * change is one edit and `THE CONNECTOR MIX GATE` re-derives its expectations
 * from here rather than from a second copy of the numbers.
 */
export const CONNECTOR_WEIGHTS = Object.freeze({ stair: 60, tunnel: 25, lift: 15 });

/**
 * Choose a connector for the link rising out of (x, z, level).
 *
 * Hashed the same way `doorwayOffset` hashes a district edge, so it re-rolls
 * with the seed and is decided without generating a single collider. The
 * trailing constant is a domain separator: without it this would return the
 * same value as any other single-purpose hash over the same four numbers.
 *
 * Called only by `carveDistrict`. Everything downstream reads `connectorAt`.
 */
export function connectorKind(seed, x, z, level) {
  let total = 0;
  for (const k of CONNECTOR_ORDER) total += CONNECTOR_WEIGHTS[k];
  let r = hash32(seed, x, z, level, 0x1f7) % total;
  for (const k of CONNECTOR_ORDER) {
    r -= CONNECTOR_WEIGHTS[k];
    if (r < 0) return k;
  }
  /* Unreachable while the weights are positive, and a deliberate fail-safe
   * rather than a throw: the stair is the one connector proven in Phase 2b,
   * so a weighting bug degrades the maze to all-staircases instead of
   * crashing generation. */
  return 'stair';
}

/**
 * The connector kind for the link rising out of (x, z, level).
 *
 * Returns `'stair'` for a cell with no UP link at all, which is what makes
 * this safe to call unconditionally: a cell with no link has no connector,
 * and the stair is the neutral answer.
 */
export function connectorAt(cells, x, z, level) {
  const bits = cells[cellIndex(x, z, level)] & CONNECTOR_MASK;
  for (const k of CONNECTOR_ORDER) if (CONNECTOR_VALUE[k] === bits) return k;
  return 'stair';
}
```

- [ ] **Step 5: Write the bits in `carveDistrict`**

In `carveDistrict`'s vertical-doorway block (~line 392), the `DIR.UP` branch already computes the landing cell. Set the connector bits alongside the direction bit — and only for `DIR.UP`, never `DIR.DOWN`:

```js
    const target = cellIndex(x0 + lx, z0 + lz, level);
    cells[target] |= dir;
    /* The kind rides on the LOWER cell of the pair (see CONNECTOR). This
     * branch runs once for DIR.UP and once for DIR.DOWN on the same physical
     * link - from the two cells' own levels - so writing the kind on both
     * would put it on the upper cell too and give `connectorAt` two answers
     * for one link. Only the UP end owns it. */
    if (dir === DIR.UP) {
      cells[target] |= CONNECTOR_VALUE[connectorKind(seed, x0 + lx, z0 + lz, level)];
    }
```

- [ ] **Step 6: Run the tests**

Run: `node --test scripts/tests/maze-topology.test.mjs`
Expected: PASS, all four new tests included.

- [ ] **Step 7: Prove the mix gate is not vacuous**

Temporarily change `connectorKind` to `return 'stair';` unconditionally. Run the file again.

Expected: `THE CONNECTOR MIX GATE` FAILS (tunnel at 0.000 against ~0.250) and `connectorKind is deterministic...` FAILS on `kinds.size`. **Revert the change.** Record both observed failure messages in the ledger — a gate whose red has not been seen is not a gate.

- [ ] **Step 8: Prove the existing suite is undisturbed**

Run: `npm test`
Expected: all 189 existing tests still pass. The connector bits change cell *bytes* but no *passage*, so solvability, reachability and every collider gate must be untouched. If any of them moved, the spare bits are not spare — stop and report.

- [ ] **Step 9: Carried minor — `carveDistrict`'s `levels` parameter**

2b's ledger records this as unreachable dead code, since `isEdgeOpen` already excludes out-of-range edges, and calls it "harmless single-source-of-truth insurance". Keep the insurance, but stop *assuming* it is dead. Append:

```js
test('carveDistrict\'s level bound is insurance, not dead code: isEdgeOpen already excludes out-of-range edges', () => {
  // If this ever fails, the bound in carveDistrict is doing real work and
  // must not be removed - which is the whole reason to assert it rather than
  // delete the parameter on the strength of a code read.
  for (const seed of [7, 4242]) {
    const graph = buildDistrictGraph(seed, 2);
    for (const key of graph.open) {
      for (const part of key.split('|')) {
        assert.ok(districtCoords(Number(part)).level < 2,
          `edge ${key} reaches a level the graph was not built for`);
      }
    }
  }
});
```

Add a one-line comment at the parameter's use site naming it as asserted insurance and pointing at this test.

- [ ] **Step 10: Commit**

```bash
git add src/worlds/maze/MazeTopology.js scripts/tests/maze-topology.test.mjs
git commit -m "Give every vertical link a kind, in the topology array itself"
```

---

### Task 2: Split `MazeShafts.js` out, and dispatch on kind

**Files:**
- Create: `src/worlds/maze/MazeShafts.js`
- Modify: `src/worlds/maze/MazeColliders.js` — remove what moves, import it back, re-export `cellToWorld`
- Modify: `src/worlds/maze/MazeTopology.js` — gains `cellToWorld`
- Modify: `scripts/tests/maze-enclosure.test.mjs` — import paths, purity test
- Modify: `scripts/tests/maze-colliders.test.mjs`, `scripts/tests/maze-containment.test.mjs` — import paths

**Interfaces:**
- Consumes: Task 1's `connectorAt`.
- Produces:
  - `MazeTopology.cellToWorld(x, z, level) -> {x, y, z}` — moved, unchanged.
  - `MazeShafts.stairColliders(cells, x, z, level) -> ColliderDesc[]` — today's `shaftColliders` body, renamed.
  - `MazeShafts.shaftColliders(cells, x, z, level) -> ColliderDesc[]` — the dispatcher. Reads `connectorAt` and delegates.
  - `MazeShafts.stairWellBounds`, `ENTRY_SEAL_FROM`, `STAIR_WELL_HALF`, `STAIR_WELL_OFFSET`, `GUARD_HALF_THICK`, `TREAD_HALF`, `requiredWallTop`, `isEnclosureSound` — all moved verbatim.
  - `MazeShafts.SHAFT_STEPS` — newly **exported** (it is a private const today). Tasks 5, 7 and 9 all derive their rise from it, and a second copy of `24` in any of them is the constant-duplication this project keeps being bitten by.
- `MazeColliders.js` keeps `districtColliders`, `forecourtColliders`, and re-exports `cellToWorld` so no existing import breaks.

**This task changes no behaviour.** Every one of the 189 tests must pass before and after, with identical descriptor output. That is the whole point of doing it as its own task: two new geometries land in a focused file, and a reviewer can reject the split without rejecting the lift.

**Why `cellToWorld` moves to `MazeTopology.js`.** `MazeShafts.js` needs it, and `MazeColliders.js` needs `stairWellBounds` from `MazeShafts.js` for its guard rails. Leaving `cellToWorld` where it is makes those two files import each other — the exact cycle `MazeChunks.js`'s own comment records avoiding. `cellToWorld` is pure coordinate math over `MAZE` with no collider knowledge, so topology is where it belonged anyway.

- [ ] **Step 1: Write the failing test — output must be byte-identical across the split**

Append to `scripts/tests/maze-colliders.test.mjs`:

```js
test('the split changes nothing: shaftColliders dispatches stairs identically to stairColliders', () => {
  const { cells } = generateTopology(2026);
  let checked = 0;
  for (let level = 0; level < MAZE.LEVELS - 1 && checked < 12; level++) {
    for (let z = 0; z < 60 && checked < 12; z++) {
      for (let x = 0; x < 60 && checked < 12; x++) {
        if (!isOpen(cells, cellIndex(x, z, level), DIR.UP)) continue;
        if (connectorAt(cells, x, z, level) !== 'stair') continue;
        assert.deepEqual(
          shaftColliders(cells, x, z, level),
          stairColliders(cells, x, z, level),
          `dispatch diverged from the stair builder at ${x},${z},${level}`,
        );
        checked++;
      }
    }
  }
  assert.equal(checked, 12, 'expected 12 stair shafts to compare');
});

test('a lift or tunnel link falls back to stair geometry until its own task lands', () => {
  const { cells } = generateTopology(2026);
  for (let level = 0; level < MAZE.LEVELS - 1; level++) {
    for (let z = 0; z < 80; z++) {
      for (let x = 0; x < 80; x++) {
        if (!isOpen(cells, cellIndex(x, z, level), DIR.UP)) continue;
        if (connectorAt(cells, x, z, level) === 'stair') continue;
        assert.deepEqual(
          shaftColliders(cells, x, z, level),
          stairColliders(cells, x, z, level),
          'the fallback must be the stair, exactly',
        );
        return;
      }
    }
  }
  assert.fail('expected at least one non-stair link in the scanned window');
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `node --test scripts/tests/maze-colliders.test.mjs`
Expected: FAIL — `stairColliders is not exported`.

- [ ] **Step 3: Move `cellToWorld` to `MazeTopology.js`**

Cut `cellToWorld` (MazeColliders.js ~line 250) with its full doc comment into `MazeTopology.js`. In `MazeColliders.js`, replace it with a re-export so every existing import site and the purity test keep working:

```js
/* Moved to MazeTopology.js in Phase 2c so that MazeShafts.js can use it
 * without importing this module, which would make the two import each
 * other. Re-exported here because a dozen call sites and three test files
 * already import it from this path, and a rename adds churn without adding
 * safety. */
export { cellToWorld } from './MazeTopology.js';
```

- [ ] **Step 4: Create `MazeShafts.js` and move the shaft machinery into it**

Create `src/worlds/maze/MazeShafts.js` with this header, then move — **verbatim, comments included** — `SHAFT_STEPS`, `STAIR_RADIUS`, `TREAD_HALF`, `STAIR_TREADS_PER_TURN`, `STAIR_WELL_HALF`, `WELL_EDGE_MARGIN`, `STAIR_WELL_OFFSET`, `GUARD_HALF_THICK`, `stairWellBounds`, `ENTRY_SEAL_MARGIN`, `ENTRY_SEAL_FROM`, `ENCLOSURE_MARGIN`, `requiredWallTop`, `isEnclosureSound`, and the body of `shaftColliders` renamed to `stairColliders`:

```js
/**
 * Vertical connectors and the machinery that proves them safe.
 *
 * Split out of `MazeColliders.js` in Phase 2c, when two more connector shapes
 * arrived and the one file stopped being readable at 793 lines. The division
 * is by responsibility, not by size: everything here is about getting a
 * player between two levels and proving they cannot use that geometry to
 * leave the maze, while `MazeColliders.js` keeps the hedges, floors and
 * forecourt that have nothing to do with either.
 *
 * Pure - no THREE, no DOM, and it imports only `MazeTopology.js`. That is
 * asserted textually by `scripts/tests/maze-enclosure.test.mjs`, because
 * export-name checks alone would not stop a `three` import being added, and
 * this module's purity is what lets the enclosure, containment and
 * anti-ladder gates run headless in seconds.
 */
import {
  MAZE, DIR, cellIndex, isOpen, cellToWorld, connectorAt,
} from './MazeTopology.js';
```

- [ ] **Step 5: Add the dispatcher**

At the end of `MazeShafts.js`:

```js
/**
 * Every collider for the vertical connector rising out of (x, z, level).
 *
 * The single entry point `districtColliders` calls. Which shape gets built is
 * the topology array's decision, not this module's - see `connectorAt` - so
 * no seed is threaded through geometry and the map, NPC routing and the
 * headless gates all resolve a link's kind the same way this does.
 *
 * A cell with no UP link emits nothing, which is what makes this safe to call
 * for any cell.
 */
export function shaftColliders(cells, x, z, level) {
  if (!isOpen(cells, cellIndex(x, z, level), DIR.UP)) return [];
  switch (connectorAt(cells, x, z, level)) {
    case 'lift':   return stairColliders(cells, x, z, level);   // Task 5
    case 'tunnel': return stairColliders(cells, x, z, level);   // Task 9
    default:       return stairColliders(cells, x, z, level);
  }
}
```

The two identical fallbacks are deliberate and temporary. They are written as separate cases, not folded into the default, so that Tasks 5 and 9 each change one line and a reader can see at a glance which connectors are real yet.

- [ ] **Step 6: Update `MazeColliders.js` to import what it lost**

```js
import {
  stairWellBounds, shaftColliders, GUARD_HALF_THICK, TREAD_HALF,
} from './MazeShafts.js';
```

`districtColliders` keeps calling `shaftColliders(cells, x, z, level)` unchanged — it now reaches the dispatcher.

- [ ] **Step 7: Update the three test files' imports, and extend the purity test**

In `scripts/tests/maze-enclosure.test.mjs`, change the assertion at line ~417 to cover all three modules. Rename the test to say so:

```js
test('MazeTopology.js, MazeColliders.js and MazeShafts.js import nothing outside each other', async () => {
  const files = ['MazeTopology.js', 'MazeColliders.js', 'MazeShafts.js'];
  const allowed = new Set(files.map((f) => `./${f}`));
  for (const f of files) {
    const src = await readFile(path.join(root, 'src/worlds/maze', f), 'utf8');
    for (const m of src.matchAll(/^\s*import\s[^;]*?from\s+'([^']+)'/gm)) {
      assert.ok(allowed.has(m[1]),
        `${f} imports ${m[1]} - these three modules must import only each other, or every headless gate becomes browser-bound`);
    }
  }
});
```

- [ ] **Step 8: Run the whole suite**

Run: `npm test`
Expected: PASS — 189 existing tests plus Task 1's four plus this task's two. **Zero test changes beyond import paths and the purity test's widening.** If a behavioural test needed editing, the move was not verbatim; revert and redo it.

- [ ] **Step 9: Carried minor — restore the tread-overlap bar**

2b's ledger: the tread-overlap test's bar was cut from `>= 0.70 m` (the capsule diameter) to `> 0`, and flags it as "a bar removed, and this task's history is made of that move". `THE CLIMB GATE` proves the property physically and is stronger, so the overlap test is now a cheap early warning rather than the guarantee — but a warning that fires at `> 0` warns of nothing.

In `scripts/tests/maze-enclosure.test.mjs`, `'consecutive treads meet: their footprints overlap on both axes'`, restore a real bar. Measure the true minimum first and set the bar at the capsule diameter, capped so it can never be restated looser:

```js
  // Bar restored (Phase 2c). Capped at the capsule diameter so a future
  // restatement cannot drift upward the way THE PIT GATE's once did: this is
  // a CEILING on the bar, not a target.
  const BAR = Math.min(2 * RADIUS, measuredMinOverlap * 0.9);
```

If the measured minimum will not support `2 * RADIUS`, **do not lower the bar silently** — report the measured value as a named finding and leave the bar at the capsule diameter so the test goes red.

- [ ] **Step 10: Commit**

```bash
git add src/worlds/maze/MazeShafts.js src/worlds/maze/MazeColliders.js src/worlds/maze/MazeTopology.js scripts/tests/
git commit -m "Split the shafts out, and let a link's kind choose its shape"
```

---

### Task 3: Swept descriptors, before any lift exists

**Files:**
- Modify: `src/worlds/maze/MazeShafts.js` — the `swept` field, `requiredWallTop`, `isEnclosureSound`
- Modify: `scripts/tests/maze-enclosure.test.mjs` (append)
- Modify: `scripts/tests/maze-colliders.test.mjs` — the anti-ladder gate

**Interfaces:**
- Consumes: nothing new.
- Produces: an extended `ColliderDesc` — `{ ..., enclosed?:boolean, swept?:{ y0:number, y1:number } }`. A descriptor with `swept` declares that its top sweeps every height in `[y0, y1]` over time. `cy`/`hy` continue to describe the *physical* box at its rest position, so anything that builds a collider from a descriptor needs no change at all.

**Why this comes before the lift.** Every gate this project owns reads static descriptors — the anti-ladder scan, `requiredWallTop`, `isEnclosureSound`, the containment sweep. A lift platform is a standable surface moving continuously through the 0.45–5.0 m band, and a snapshot of it is accurate at one instant and wrong at every other. Phase 2b built the enclosure rule in Task 2 before a single stair existed, precisely so the gate was ready to catch the first one that got it wrong. This is that move again.

- [ ] **Step 1: Write the failing tests**

Append to `scripts/tests/maze-enclosure.test.mjs`:

```js
/** A platform resting low, that sweeps up to `y1`. */
function sweptPlatform(y1, restY = 0.15) {
  return {
    cx: 0, cy: restY, cz: 0, hx: 1.35, hy: 0.15, hz: 1.35,
    kind: 'lift', enclosed: true, swept: { y0: 0, y1 },
  };
}

test('requiredWallTop uses a swept descriptor\'s TOP OF TRAVEL, not where it happens to rest', () => {
  const descs = [floorSlab(), ...fullWalls(MAZE.LEVEL_HEIGHT), sweptPlatform(MAZE.LEVEL_HEIGHT)];
  // Resting at 0.30m, the platform's static top. If the gate read that, the
  // bar would be 0.30 + 1.38 = 1.68m and five-metre walls would look ample.
  // Reading the travel gives LEVEL_HEIGHT, capped at LEVEL_HEIGHT.
  assert.equal(requiredWallTop(descs, SHAFT), MAZE.LEVEL_HEIGHT);
});

test('THE SWEPT ENCLOSURE GATE: a lift shaft walled to its landing is sound', () => {
  const descs = [floorSlab(), ...fullWalls(MAZE.LEVEL_HEIGHT), sweptPlatform(MAZE.LEVEL_HEIGHT)];
  assert.equal(isEnclosureSound(descs, SHAFT), true);
});

test('the swept gate is not vacuous: one metre short of the landing is NOT sound', () => {
  const descs = [floorSlab(), ...fullWalls(MAZE.LEVEL_HEIGHT - 1), sweptPlatform(MAZE.LEVEL_HEIGHT)];
  assert.equal(isEnclosureSound(descs, SHAFT), false);
});

test('a swept platform read STATICALLY would pass walls that are far too short - the bug this field exists to stop', () => {
  // Same platform, same short walls, but with the sweep declaration removed.
  // This is exactly what a lift would look like to the old gate, and it
  // passing is what makes the `swept` field load-bearing rather than
  // decorative. If this ever fails, the static read has been fixed some
  // other way and this test should be deleted, not weakened.
  const naive = { ...sweptPlatform(MAZE.LEVEL_HEIGHT) };
  delete naive.swept;
  const descs = [floorSlab(), ...fullWalls(MAZE.HEDGE_HEIGHT), naive];
  assert.equal(isEnclosureSound(descs, SHAFT), true,
    'a statically-read moving platform passes hedge-height walls - hence `swept`');
});
```

- [ ] **Step 2: Run and watch three of the four fail**

Run: `node --test scripts/tests/maze-enclosure.test.mjs`
Expected: the first three FAIL (the bar comes out at 1.68, so short walls pass); the fourth PASSES already, since it describes today's behaviour.

- [ ] **Step 3: Teach `requiredWallTop` about sweeps**

In `MazeShafts.js`, inside the scan loop, replace `const top = d.cy + d.hy;` with:

```js
    /* A swept descriptor is a surface that MOVES - today, a lift platform.
     * Its `cy`/`hy` describe where it physically rests, which is true at one
     * instant and false at every other, so the bar must come from the top of
     * its travel instead. This is the one place in the file where a
     * descriptor's static box is not the whole truth about it, and it is why
     * `swept` exists rather than the lift simply being re-emitted as it
     * moves: a gate that has to be re-run every frame is not a gate. */
    const top = d.swept ? Math.max(d.swept.y1, d.cy + d.hy) : d.cy + d.hy;
```

The `Math.max` is not belt-and-braces: it keeps the bar correct for a descriptor whose rest position is somehow above its declared travel, which is a malformed input the gate should survive conservatively rather than trust.

- [ ] **Step 4: Teach the anti-ladder gate the same thing**

In `scripts/tests/maze-colliders.test.mjs`, the band scan reads `d.cy + d.hy`. A swept descriptor must be judged on its whole travel there too — otherwise a lift resting below 0.45 m looks harmless. Find the top computation and apply the identical rule, with a comment pointing at `requiredWallTop` as the other half of the pair. Then assert the pairing directly:

```js
test('the anti-ladder scan and requiredWallTop agree on what a swept descriptor\'s top is', () => {
  const d = { cx: 0, cy: 0.15, cz: 0, hx: 1, hy: 0.15, hz: 1, kind: 'lift', enclosed: true, swept: { y0: 0, y1: 4.0 } };
  assert.equal(descriptorTop(d), 4.0, 'the band scan must read the travel');
  assert.equal(requiredWallTop([d], SHAFT), 4.0 + MAZE.HOP + MAZE.STEP_HEIGHT + 0.05);
});
```

Export the shared `descriptorTop(d)` helper from `MazeShafts.js` and use it in both places, so the two can never drift — the same single-source discipline `ENTRY_SEAL_FROM` already has.

- [ ] **Step 5: Run the tests**

Run: `node --test scripts/tests/maze-enclosure.test.mjs scripts/tests/maze-colliders.test.mjs`
Expected: PASS.

- [ ] **Step 6: Run the whole suite**

Run: `npm test`
Expected: PASS. Nothing emits `swept` yet, so every existing gate must be unmoved.

- [ ] **Step 7: Commit**

```bash
git add src/worlds/maze/MazeShafts.js scripts/tests/
git commit -m "Teach the gates about a surface that moves, before one exists"
```

---

### Task 4: Prove the lift landing is possible — no geometry

**Files:**
- Create: `scripts/tests/maze-lift-footprint.test.mjs`
- Modify: `docs/superpowers/specs/2026-08-08-maze-world-phase-2c-ledger.md` (create; record the outcome)

**Interfaces:**
- Consumes: `MAZE`, `stairWellBounds`, `STAIR_WELL_HALF`, `Physics`.
- Produces: **a decision**, recorded in the ledger, plus the constants the chosen arrangement needs. No connector geometry ships in this task.

**The problem, stated exactly.** A staircase's opening in level N+1's floor is safe because there are treads under every point of it: `THE WALK-ON-IT GATE` measures a worst-case walk-off drop of 0.758 m against a 0.77 m bar. **Under a lift's opening, with the car at the bottom, there is nothing for nine metres.** Every gate that protects the staircase will fail on a lift built without an answer to this, and they will be right to.

There is no fall damage in this project, so the failure is not lethal — it is a player walking down a level-3 corridor and vanishing into a hole they had no way to see. That is a playability failure of exactly the kind the pitch-black shaft was, and it must not be discovered in a browser.

**Candidate arrangements**, to be evaluated in this order. Each must satisfy **all six** of Phase 2b's properties simultaneously, plus a seventh specific to a moving car:

1. **Car-is-the-landing, three rails and a permanent lip.** Level N+1's floor is perforated by the well; the well's inner quarter carries a fixed lip flush with the floor (exactly as the stair's landing does); three sides railed. The car fills the remaining L when up. *Open question this must answer:* what is under the L when the car is down.
2. **Landing door.** As above, but the entry side carries a collider driven by `Physics.setBoxColliderY` — recessed below the auto-step when the car is present, standing at `HEDGE_HEIGHT` when it is not. *Known hazard this must answer:* while the door is in motion its own top passes through the 0.45–5.0 m band **outside** the shaft, and above `ENTRY_SEAL_FROM` (3.57 m) a player standing on it can hop a hedge. A door that is only safe because it moves quickly is not proven safe.
3. **Sealed upper chamber.** The car rises into a walled chamber whose only exit is a horizontal doorway at car-top height into level N+1's corridor. Moves the problem up a level rather than solving it, unless the chamber's own floor is solid around the car.
4. **Deep car.** The car's underside carries a skirt reaching to the shaft floor, so the shaft is never open — the car and its skirt together always fill the well from floor to car top. Costs a collider the height of a level, and must not become a ladder: the skirt is inside a sealed shaft, so the exemption applies, but it must be proven, not assumed.

- [ ] **Step 1: Write the properties as a test file, against a fixture, with no implementation**

Create `scripts/tests/maze-lift-footprint.test.mjs`. Build each candidate as a plain descriptor fixture — no changes to `MazeShafts.js` — and drive `Physics.resolveCapsule` against it. The seven properties:

```js
/* Phase 2c Task 4. This file proves an ARRANGEMENT before any lift is built,
 * because Phase 2b's Task 3 spent four fix rounds discovering, only at the
 * end, that the geometry it started from could not satisfy its constraints
 * at all. Every candidate below must pass all seven at once. A candidate
 * that passes six is not a near miss; it is a rejected candidate. */

// 1. WALK IN    - from every level-N corridor side the shaft opens onto.
// 2. RIDE       - a capsule standing on the car is carried from floor to landing.
// 3. WALK AWAY  - flood fill level N+1 reaches 400/400 cells of the district.
// 4. NO FALL IN - walk-offs across the shaft cell at level N+1, 16 directions,
//                 walk and sprint, WITH THE CAR AT THE BOTTOM. Worst drop must
//                 stay under the same 0.77 m bar the stair is held to.
// 5. NO ESCAPE  - grounded rest heights outside the shaft footprint never
//                 include 5.0 (level N canopy) or 14.0 (level N+1 canopy).
// 6. THE CAP    - nothing the arrangement emits tops out above floorN + LEVEL_HEIGHT.
// 7. NO LADDER  - no collider top, at ANY point in the car's travel or any
//                 door's travel, sits in 0.45-5.0 m within 2 m of a hedge
//                 unless it is inside the sealed shaft.
```

Property 4 is the one that kills candidate 1 as written, and property 7 is the one that kills candidate 2 as written. Both are written down here so the implementer is not surprised by them at review.

- [ ] **Step 2: Run the seven properties against candidate 1**

Expected: property 4 FAILS with a ~9 m drop. Record the measured number.

- [ ] **Step 3: Work down the candidates until one passes all seven**

For each: build the fixture, run all seven, record which fail and by how much. Do not modify a property's bar to fit a candidate. If a bar seems wrong, stop and escalate — bars are not moved to make geometry pass, and this project's history is largely that mistake.

- [ ] **Step 4: If none of the four passes, design a fifth**

You have licence to redesign rather than patch — that is what worked in 2b's round 4. The constraint set is fixed; the geometry is not. If after a genuine attempt no arrangement satisfies all seven, **say so and stop**: report which properties are mutually unsatisfiable and with what measurements. Cutting the lift is a legitimate outcome and a far better one than shipping a pit. The tunnel does not depend on the lift.

- [ ] **Step 5: Record the decision**

Create `docs/superpowers/specs/2026-08-08-maze-world-phase-2c-ledger.md` if it does not exist and write down: which candidate won, every measurement for all seven properties, and what each rejected candidate failed on. Tasks 5 and 6 build the winner and nothing else.

- [ ] **Step 6: Commit**

```bash
git add scripts/tests/maze-lift-footprint.test.mjs docs/superpowers/specs/2026-08-08-maze-world-phase-2c-ledger.md
git commit -m "Prove a lift landing can exist before building one"
```

---

### Task 5: The lift, built and switched on

**Files:**
- Modify: `src/worlds/maze/MazeShafts.js` — `liftColliders`, the dispatcher's `case 'lift'`
- Modify: `src/worlds/maze/MazeColliders.js` — perforation and rails for a lift cell
- Modify: `src/worlds/maze/MazeChunks.js` — `CHUNK_MESH_KINDS`
- Modify: `src/worlds/MazeWorld.js` — the `lift` material
- Modify: `scripts/tests/maze-enclosure.test.mjs`, `scripts/tests/maze-lift-footprint.test.mjs`

**Interfaces:**
- Consumes: Task 3's `swept`; Task 4's chosen arrangement and its constants.
- Produces:
  - `liftColliders(cells, x, z, level) -> ColliderDesc[]` — including exactly one descriptor of `kind: 'lift'` carrying `swept` and `enclosed: true`, which is the car.
  - `liftCarDescriptor(descs) -> ColliderDesc|null` — finds that one car among a district's descriptors, so Task 6 does not re-derive which box moves.
  - `liftWellBounds(x, z, level) -> {cx, cz, x0, x1, z0, z1}` — the rectangle the lift needs punched out of level N+1's floor, in the same shape `stairWellBounds` returns. Task 8's `connectorHoleBounds` dispatches to it.

**Switching it on is one line** — the dispatcher's `case 'lift'`. The moment it flips, every existing real-shaft gate covers lifts: `THE ENCLOSURE GATE`, `THE ENTRY GATE`, `THE MULTI-SHAFT GATE`, `THE PIT GATE`, `THE WALK-ON-IT GATE`, `THE CANOPY GATE` and the cap check all iterate real generated `DIR.UP` cells and do not care what shape they find. That is the point of the fallback in Task 2, and it is why the geometry lands in real output rather than in fixtures.

- [ ] **Step 1: Write the failing test**

Append to `scripts/tests/maze-enclosure.test.mjs`:

```js
test('every lift in real generation carries exactly one swept car, enclosed and capped', () => {
  let lifts = 0;
  for (const seed of [1, 2026, 77771]) {
    const { cells } = generateTopology(seed);
    for (let level = 0; level < MAZE.LEVELS - 1; level++) {
      for (let z = 0; z < 100; z++) {
        for (let x = 0; x < 100; x++) {
          if (!isOpen(cells, cellIndex(x, z, level), DIR.UP)) continue;
          if (connectorAt(cells, x, z, level) !== 'lift') continue;
          const descs = shaftColliders(cells, x, z, level);
          const cars = descs.filter((d) => d.kind === 'lift');
          assert.equal(cars.length, 1, `lift at ${x},${z},${level} emitted ${cars.length} cars`);
          const car = cars[0];
          assert.ok(car.swept, 'the car must declare its travel');
          assert.equal(car.enclosed, true, 'the car is a standable in the band');
          const floorY = level * MAZE.LEVEL_HEIGHT;
          assert.ok(car.swept.y1 <= floorY + MAZE.LEVEL_HEIGHT + 1e-6,
            `car travel tops out at ${car.swept.y1}, above the cap`);
          assert.ok(car.swept.y0 >= floorY - 1e-6, 'car travel starts below the shaft floor');
          lifts++;
        }
      }
    }
  }
  assert.ok(lifts >= 5, `expected several lifts in the scan window, found ${lifts}`);
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `node --test scripts/tests/maze-enclosure.test.mjs`
Expected: FAIL — `emitted 0 cars`, because the dispatcher still falls back to stairs.

- [ ] **Step 3: Build `liftColliders` from Task 4's winning arrangement**

Write it in `MazeShafts.js`, reusing `stairWellBounds` for the well so the hole, the rails and the car can never disagree — the same single-source rule the stair's own comment sets out. The car:

```js
  const carTopDown = w.y + LIFT_REST_CLEARANCE;          // a step up, under the auto-step
  const carTopUp = w.y + MAZE.LEVEL_HEIGHT;              // flush with level N+1's floor
  out.push({
    cx: well.cx, cy: carTopDown - LIFT_CAR_HALF_THICK, cz: well.cz,
    hx: LIFT_CAR_HALF, hy: LIFT_CAR_HALF_THICK, hz: LIFT_CAR_HALF,
    kind: 'lift',
    enclosed: true,
    /* The whole point of Task 3. `cy`/`hy` above are where the car RESTS -
     * true at one instant. The gates need where it GOES. */
    swept: { y0: carTopDown - 2 * LIFT_CAR_HALF_THICK, y1: carTopUp },
  });
```

Derive `LIFT_REST_CLEARANCE` from `MAZE.STEP_HEIGHT` rather than writing 0.30, so a change to the auto-step cannot silently make the car a step the player has to hop onto. **Both of this project's shaft constants have been wrong when written as literals; derive or fail.**

- [ ] **Step 4: Add the mesh kind and the material**

`CHUNK_MESH_KINDS` gains `'lift'`. `MazeWorld._ensureMaterials` gains a `lift` entry — **built once and cached** like every other, and emissive, because a lift shaft is as dark as a stair shaft and for the same reason. Do not add a light.

The render-coverage test (`maze-render-coverage.test.mjs`) derives both sides programmatically and will fail loudly if the kind is emitted and not drawn. That test exists because ~14,800 stair treads once shipped solid, walkable and completely undrawn while all 189 tests passed. **Do not skip running it.**

- [ ] **Step 5: Flip the dispatcher**

```js
    case 'lift': return liftColliders(cells, x, z, level);
```

- [ ] **Step 6: Run everything**

Run: `npm test`
Expected: PASS, including every existing real-shaft gate now exercising lifts. Any failure here is a real finding about the lift, not a test that needs adjusting.

- [ ] **Step 7: Run the full-seed gate**

Run: `MAZE_SEEDS=1000 npm test`
Expected: PASS. Budget ~260 s.

- [ ] **Step 8: Commit**

```bash
git add src/worlds/maze/ scripts/tests/
git commit -m "Build the lift, and let the gates that guard stairs guard it too"
```

---

### Task 6: The lift moves

**Files:**
- Modify: `src/worlds/maze/MazeChunks.js` — the lift registry, `ensure`, `drop`, `disposeAll`
- Modify: `src/worlds/MazeWorld.js` — `update(dt)`
- Create: `scripts/tests/maze-lift-motion.test.mjs`

**Interfaces:**
- Consumes: `liftCarDescriptor`, `Physics.setBoxColliderY`.
- Produces: `MazeChunks.stepLifts(dt, playerPos)` — advances every resident lift and returns the number that moved.

**State.** Per resident district: `{ collider, y, target, downY, upY, plateDown, plateUp }`. Populated in `ensure`, deleted in `drop` and `disposeAll` alongside the colliders it points at. A lift in an evicted district must leave nothing behind — the canopy pool's churn test is the shape to copy, and 2b's reviewer ran 260 mixed add/drop operations checking bookkeeping after *every* one.

**Plates are not colliders.** A plate is a footprint test against the player's position, flush on the landing floor and below the auto-step, so it is never itself a surface in the band and needs no exemption.

- [ ] **Step 1: Write the failing tests**

Create `scripts/tests/maze-lift-motion.test.mjs`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Physics } from '../../src/physics/Physics.js';
import { MAZE, generateTopology, cellIndex, isOpen, DIR, connectorAt, cellToWorld } from '../../src/worlds/maze/MazeTopology.js';
import { shaftColliders, liftCarDescriptor } from '../../src/worlds/maze/MazeShafts.js';
import { districtColliders } from '../../src/worlds/maze/MazeColliders.js';

const RADIUS = 0.35, HEIGHT = 1.75, STEP = 1 / 60;

/** The first lift in `seed`, as {x, z, level} - or null if the window has none. */
function findLift(cells, scan = 100) {
  for (let level = 0; level < MAZE.LEVELS - 1; level++) {
    for (let z = 0; z < scan; z++) {
      for (let x = 0; x < scan; x++) {
        if (!isOpen(cells, cellIndex(x, z, level), DIR.UP)) continue;
        if (connectorAt(cells, x, z, level) === 'lift') return { x, z, level };
      }
    }
  }
  return null;
}

/** A physics world holding one lift cell's descriptors, and the car's collider. */
function liftWorld(cells, at) {
  const physics = new Physics();
  const descs = shaftColliders(cells, at.x, at.z, at.level);
  const car = liftCarDescriptor(descs);
  let carCollider = null;
  for (const d of descs) {
    const c = physics.addBox(d.cx, d.cy, d.cz, d.hx, d.hy, d.hz);
    if (d === car) carCollider = c;
  }
  return { physics, descs, car, carCollider };
}

test('a capsule standing on the car is carried the full level', () => {
  const { cells } = generateTopology(2026);
  const at = findLift(cells);
  assert.ok(at, 'no lift in the scan window');
  const { physics, car, carCollider } = liftWorld(cells, at);

  const pos = { x: car.cx, y: car.cy + car.hy, z: car.cz };
  const travel = car.swept.y1 - (car.cy + car.hy);
  const speed = 1.2;
  for (let t = 0; t < travel / speed + 1; t += STEP) {
    const y = Math.min(car.swept.y1, car.cy + car.hy + speed * t);
    physics.setBoxColliderY(carCollider, y - car.hy);
    // Gravity pulls the capsule down; the rising box pushes it back out.
    pos.y -= 0.05;
    const r = physics.resolveCapsule(pos, RADIUS, HEIGHT);
    pos.x = r.position ? r.position.x : pos.x;
    pos.y = r.position ? r.position.y : pos.y;
    pos.z = r.position ? r.position.z : pos.z;
  }
  assert.ok(Math.abs(pos.y - car.swept.y1) < 0.01,
    `rider ended at ${pos.y.toFixed(3)}, expected the landing at ${car.swept.y1}`);
});

test('THE STEP-OFF GATE: leaving the car mid-travel always lands on ground, never inside a wall', () => {
  const { cells } = generateTopology(2026);
  const at = findLift(cells);
  const { physics, car, carCollider } = liftWorld(cells, at);
  const floorY = at.level * MAZE.LEVEL_HEIGHT;

  let checked = 0;
  for (let y = car.swept.y0; y <= car.swept.y1; y += 0.25) {
    physics.setBoxColliderY(carCollider, y);
    for (let h = 0; h < 16; h++) {
      const a = (h / 16) * Math.PI * 2;
      const pos = { x: car.cx + Math.cos(a) * 0.6, y: y + car.hy, z: car.cz + Math.sin(a) * 0.6 };
      // Fall for two seconds; the capsule must come to rest somewhere real.
      let grounded = false;
      for (let t = 0; t < 120; t++) {
        pos.y -= 0.1;
        const r = physics.resolveCapsule(pos, RADIUS, HEIGHT);
        if (r.position) { pos.x = r.position.x; pos.y = r.position.y; pos.z = r.position.z; }
        if (r.grounded) { grounded = true; break; }
      }
      assert.ok(grounded, `step-off at y=${y.toFixed(2)} heading ${h} never came to rest`);
      assert.ok(pos.y >= floorY - 0.5,
        `step-off at y=${y.toFixed(2)} heading ${h} ended below the shaft floor at ${pos.y.toFixed(3)} - it fell through`);
      checked++;
    }
  }
  assert.ok(checked > 500, `expected a dense sweep, ran ${checked}`);
});

test('THE CRUSH GATE: the car does not move while a capsule is between it and the ceiling', () => {
  const { cells } = generateTopology(2026);
  const at = findLift(cells);
  const { physics, car, carCollider } = liftWorld(cells, at);

  // A capsule parked just under level N+1's floor, inside the well.
  const rider = { x: car.cx, y: car.swept.y1 - HEIGHT - 0.05, z: car.cz };
  const before = carCollider.center.y;
  const moved = stepLiftsAgainst(physics, carCollider, car, rider, 1.0);
  assert.equal(moved, false, 'the car rose into an occupied space');
  assert.equal(carCollider.center.y, before, 'the car moved despite the guard');
});

test('the crush gate is not vacuous: without the occupancy check the car extrudes the capsule', () => {
  const { cells } = generateTopology(2026);
  const at = findLift(cells);
  const { physics, car, carCollider } = liftWorld(cells, at);
  const rider = { x: car.cx, y: car.swept.y1 - HEIGHT - 0.05, z: car.cz };

  // Drive the car up with no guard at all - this is what the guard prevents.
  for (let y = carCollider.center.y; y <= car.swept.y1; y += 0.05) {
    physics.setBoxColliderY(carCollider, y);
    const r = physics.resolveCapsule(rider, RADIUS, HEIGHT);
    if (r.position) { rider.x = r.position.x; rider.y = r.position.y; rider.z = r.position.z; }
  }
  assert.ok(rider.y > car.swept.y1 - HEIGHT,
    'expected the unguarded car to push the capsule upward - if it did not, this test no longer proves the guard matters');
});

test('a dropped district leaves no lift behind', () => {
  const { cells } = generateTopology(2026);
  const world = { physics: new Physics(), colliders: [] };
  const chunks = new MazeChunks({ world, cells, group: fakeGroup(), materials: fakeMaterials() });

  const keys = [];
  for (let i = 0; i < 30; i++) keys.push(districtIndex(i % 5, Math.floor(i / 5) % 5, i % 3));

  for (let op = 0; op < 60; op++) {
    const key = keys[op % keys.length];
    if (op % 3 === 2) chunks.drop(key); else chunks.ensure(key);

    let expected = 0;
    for (const k of chunks.residentKeys()) {
      const { dx, dz, level } = districtCoords(k);
      if (districtColliders(cells, dx, dz, level).some((d) => d.kind === 'lift')) expected++;
    }
    assert.equal(chunks.liftCount(), expected, `op ${op}: registry holds ${chunks.liftCount()}, ${expected} districts have lifts`);
    for (const entry of chunks.liveLifts()) {
      assert.ok(world.physics.colliders.includes(entry.collider),
        `op ${op}: a registered lift's collider is not in physics`);
    }
  }
});
```

`stepLiftsAgainst`, `fakeGroup` and `fakeMaterials` are local helpers in this
file: the first calls the same occupancy predicate `stepLifts` uses so the gate
tests the real guard rather than a copy of it; the latter two are the minimal
stand-ins `MazeChunks` needs (`{ add(){}, remove(){} }` and an object with one
entry per `CHUNK_MESH_KINDS` name), since `buildBoxInstances` is the only THREE
this path touches.

`MazeChunks` must expose `liftCount()` and `liveLifts()` for this test. They are
one-liners over the registry and are worth having anyway — `mazeStats()` reports
`liftsResident` from `liftCount()` in Task 10.

- [ ] **Step 2: Run and watch them fail**

Run: `node --test scripts/tests/maze-lift-motion.test.mjs`
Expected: FAIL — `stepLifts is not a function`.

- [ ] **Step 3: Implement the registry and `stepLifts`**

In `MazeChunks.ensure`, after building colliders, find the car among `descs` via `liftCarDescriptor`, pair it with the collider built from the same index, and register it. **Pair by index, not by searching the collider array for a matching position** — colliders are built in descriptor order in the same loop, so the index is exact, and a positional search would silently pick the wrong box if two ever coincided.

In `drop` and `disposeAll`, delete the district's registry entry in the same place its colliders are evicted.

`stepLifts(dt, playerPos)` moves each car toward its target at a fixed speed via `physics.setBoxColliderY`, honours the crush guard, and flips the target when the player's footprint is on a plate.

- [ ] **Step 4: Call it from `MazeWorld.update`**

`MazeWorld.update(dt)` already runs each frame and already resolves the player. Add the call next to the existing residency and canopy updates, guarded the same way (`if (player && this.chunks)`).

- [ ] **Step 5: Run the tests**

Run: `node --test scripts/tests/maze-lift-motion.test.mjs`
Expected: PASS.

- [ ] **Step 6: Confirm the crush negative went red**

Re-run step 1's fourth test with the guard bypassed and record the observed extrusion in the ledger. Restore the guard.

- [ ] **Step 7: Run everything**

Run: `npm test && node scripts/contract-check.mjs && npm run build`
Expected: all pass; contract-check 44/44 or higher.

- [ ] **Step 8: Commit**

```bash
git add src/worlds/ scripts/tests/
git commit -m "Let the lift move, and prove it cannot take the player with it"
```

---

### Task 7: Prove the tunnel footprint is possible — no geometry

**Files:**
- Create: `scripts/tests/maze-tunnel-footprint.test.mjs`
- Modify: `docs/superpowers/specs/2026-08-08-maze-world-phase-2c-ledger.md`

**Interfaces:**
- Consumes: `MAZE`, `Physics`.
- Produces: a decision plus the tunnel's footprint constants. No geometry ships in this task.

**The constraint set, all of which must hold at once:**

1. **The climb works.** 24 rises of `LEVEL_HEIGHT / 24` = 0.375 m, each under the 0.45 m auto-step, two flights with a half-landing, arriving flush with level N+1's floor.
2. **It returns to its own column.** The tunnel surfaces at the same cell it started under, so the topology link stays C→C and `solve()`, reachability and the map are untouched.
3. **It stays inside its district.** The U's orientation is hashed but constrained to orientations that fit wholly inside the district; if none fits, the link falls back to a stair. District independence is what makes streaming and the headless gates possible.
4. **Level N stays walkable.** Every passage level N's own topology opens still has a route through all four claimed cells.
5. **Level N+1 stays walkable.** The same, for the perforated cells above.
6. **No pit, no ladder, no canopy escape.** Phase 2b's properties 4, 5 and 6, unchanged.

**Constraint 4 is the one that will bite.** The staircase fits a 2.8 m well into one quadrant of one cell and leaves an L-shaped strip 1.9 m wide, so north–south, east–west and every turn still have a route. A tunnel body wider than the 4.8 m corridor, spanning four cells, has no such luxury. Measure before building.

- [ ] **Step 1: Write the six constraints as a test file against a parameterised fixture**

Parameterise on flight width, half-landing size and the U's orientation, so the search is over a space rather than over one guess:

```js
/**
 * A U-fold tunnel as pure descriptors, for a candidate parameter set.
 * No changes to MazeShafts.js - this is a fixture, and staying a fixture is
 * what lets the search try a dozen shapes without churning the module.
 *
 * `orient` is which way the outbound flight runs: 0=+x, 1=+z, 2=-x, 3=-z.
 * The return flight runs back alongside it, offset by `width + gap`.
 */
function tunnelFixture({ width, halfLanding, orient, flights = 2 }) {
  const rise = MAZE.LEVEL_HEIGHT / SHAFT_STEPS;        // 0.375, fixed by the auto-step
  const treadsPerFlight = SHAFT_STEPS / flights;
  const tread = 0.75;                                   // run per tread
  const flightRun = treadsPerFlight * tread;
  // ... emit treads for each flight, the half-landing between them, the
  // enclosing walls, and the landing flush with level N+1's floor.
  return { descs, bounds, cellsClaimed };
}

/** Every parameter set worth trying, coarse first. */
const CANDIDATES = [];
for (const width of [2.0, 2.4, 2.8]) {
  for (const halfLanding of [1.2, 1.6, 2.0]) {
    for (const flights of [2, 3]) {
      for (const orient of [0, 1, 2, 3]) CANDIDATES.push({ width, halfLanding, orient, flights });
    }
  }
}
```

Then assert the six constraints against each, collecting results rather than failing on the first miss — the point of this task is a table, not a pass.

`tread = 0.75` is the one number here carried over rather than searched: it is what the stair already uses, and changing it changes the climb's feel as well as its footprint. If nothing in the space passes, it becomes the next parameter to open up. **`rise` is not a parameter** — 0.375 m is bounded by the 0.45 m auto-step and is not negotiable.

- [ ] **Step 2: Search the parameter space and record the results**

For each combination: which constraints hold, and by what margin. A table in the ledger, not a prose summary.

- [ ] **Step 3: If no combination satisfies all six, say so and stop**

Report which constraints are mutually unsatisfiable, with measurements. **Cutting the tunnel is a legitimate outcome** — the spec says so explicitly, the connectors are independent, and the lift is already shipped by this point. Shipping a tunnel that severs the maze is not.

If the search shows a near miss, the two parameters most worth relaxing are the flight count (three shorter flights instead of two, folding into a tighter footprint at the cost of a taller stack) and the half-landing size. **The rise must not change** — 0.375 m is bounded by the auto-step, and that is not negotiable.

- [ ] **Step 4: Record the decision and commit**

```bash
git add scripts/tests/maze-tunnel-footprint.test.mjs docs/superpowers/specs/2026-08-08-maze-world-phase-2c-ledger.md
git commit -m "Measure whether a tunnel can fit before drawing one"
```

---

### Task 8: Floor perforation for a region, not a cell

**Files:**
- Modify: `src/worlds/maze/MazeColliders.js` — `districtColliders`'s `hole` scan and floor tiling
- Modify: `scripts/tests/maze-enclosure.test.mjs` — `THE MULTI-SHAFT GATE`

**Interfaces:**
- Consumes: Task 7's tunnel footprint.
- Produces: `districtColliders` punching a hole of arbitrary rectangular extent, and `groupEnclosedByShaft`/`requiredWallTop` grouping over a region rather than a single cell.

**Two rules govern this task, and both come from 2b's ledger:**

> Fix them by tightening the boundary predicate and widening the descriptor window. **NEVER by relaxing the grouping.**

and the graph guarantee that makes the current single-hole scan correct: `buildDistrictGraph` gives each `(dx, dz, level)` node **at most one** UP neighbour, so a district has at most one vertical connector. `THE MULTI-SHAFT GATE` proves this exhaustively across 3 seeds × 3 levels × 400 districts. **This task must not weaken that gate** — it widens what a "hole" may be, not how many there are.

- [ ] **Step 1: Write the failing test**

Extend `THE MULTI-SHAFT GATE` in `scripts/tests/maze-enclosure.test.mjs` so it asserts the hole covers the connector's *whole* footprint, whatever its extent, rather than the stair well specifically:

```js
/**
 * Every point of `bounds` must be free of floor slab, and every point of the
 * cell OUTSIDE `bounds` must be covered by one. Sampled on a 0.2 m lattice -
 * fine enough to catch a half-metre shortfall on any axis, which is the
 * failure this generalisation could introduce.
 */
function perforationMatches(descs, bounds, level) {
  const floorTop = level * MAZE.LEVEL_HEIGHT;
  const slabs = descs.filter((d) => d.kind === 'floor'
    && Math.abs((d.cy + d.hy) - floorTop) < 1e-6);
  const covered = (px, pz) => slabs.some((d) =>
    px >= d.cx - d.hx - 1e-6 && px <= d.cx + d.hx + 1e-6 &&
    pz >= d.cz - d.hz - 1e-6 && pz <= d.cz + d.hz + 1e-6);

  const inside = [], outside = [];
  for (let px = bounds.x0 - 1.0; px <= bounds.x1 + 1.0; px += 0.2) {
    for (let pz = bounds.z0 - 1.0; pz <= bounds.z1 + 1.0; pz += 0.2) {
      const isIn = px > bounds.x0 + 1e-6 && px < bounds.x1 - 1e-6
                && pz > bounds.z0 + 1e-6 && pz < bounds.z1 - 1e-6;
      if (isIn && covered(px, pz)) inside.push([px, pz]);
      if (!isIn && !covered(px, pz)) outside.push([px, pz]);
    }
  }
  return { blocked: inside, missing: outside };
}

test('THE MULTI-SHAFT GATE: the hole above a connector matches its whole footprint, whatever shape that is', () => {
  let checked = 0;
  for (const seed of [1, 2026, 77771]) {
    const { cells } = generateTopology(seed);
    for (let level = 1; level < MAZE.LEVELS; level++) {
      for (let dz = 0; dz < MAZE.DISTRICTS; dz++) {
        for (let dx = 0; dx < MAZE.DISTRICTS; dx++) {
          const descs = districtColliders(cells, dx, dz, level);
          for (let lz = 0; lz < MAZE.DISTRICT; lz++) {
            for (let lx = 0; lx < MAZE.DISTRICT; lx++) {
              const x = dx * MAZE.DISTRICT + lx, z = dz * MAZE.DISTRICT + lz;
              if (!isOpen(cells, cellIndex(x, z, level - 1), DIR.UP)) continue;
              const bounds = connectorHoleBounds(cells, x, z, level - 1);
              const { blocked, missing } = perforationMatches(descs, bounds, level);
              assert.equal(blocked.length, 0,
                `${connectorAt(cells, x, z, level - 1)} at ${x},${z},${level - 1}: ${blocked.length} points of its own footprint are still floored`);
              assert.equal(missing.length, 0,
                `${connectorAt(cells, x, z, level - 1)} at ${x},${z},${level - 1}: ${missing.length} points outside the footprint have no floor - that is a pit`);
              checked++;
            }
          }
        }
      }
    }
  }
  assert.ok(checked > 200, `expected many connectors to check, found ${checked}`);
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `node --test scripts/tests/maze-enclosure.test.mjs`
Expected: FAIL — `connectorHoleBounds is not exported`.

- [ ] **Step 3: Add `connectorHoleBounds` and generalise the tiling**

In `MazeShafts.js`:

```js
/**
 * The rectangle a connector needs punched out of level N+1's floor.
 *
 * One function, dispatching on kind, because the hole and the geometry that
 * climbs through it must come from a single derivation - `stairWellBounds`'s
 * own comment sets that rule out, and this is it extended to three shapes
 * rather than abandoned for them. `districtColliders` calls this and nothing
 * else; it never re-derives a connector's extent itself.
 */
export function connectorHoleBounds(cells, x, z, level) {
  switch (connectorAt(cells, x, z, level)) {
    case 'lift':   return liftWellBounds(x, z, level);
    case 'tunnel': return tunnelWellBounds(cells, x, z, level);
    default:       return stairWellBounds(x, z, level);
  }
}
```

Until Task 9 lands, `tunnelWellBounds` returns `stairWellBounds` — the same explicit-fallback pattern Task 2 established, so a reader can see which connectors are real.

In `districtColliders`, replace `stairWellBounds(hole.x, hole.z, level)` with `connectorHoleBounds(cells, hole.x, hole.z, level - 1)`. **Note the `level - 1`**: the hole is punched in level `level`'s floor for a connector that lives one level *below*, which is how the existing `hole` scan already finds it. Getting this off by one produces a hole in the wrong place with every gate still green, because the geometry and the hole would both be self-consistent and both wrong.

The four-rectangle tiling itself needs no change — west and east strips full-span, north and south strips filling the middle column already covers any axis-aligned rectangle. Only its input widens. Do not rewrite it.

- [ ] **Step 4: Widen the enclosure grouping to a region**

`requiredWallTop` tests a descriptor against a single cell's half-extent (`MAZE.CELL / 2` about `shaft.cx`/`shaft.cz`), and the test file's `groupEnclosedByShaft` groups by single cells. Both need to accept a region.

Widen the **window** — the set of cells a connector's descriptors may legitimately occupy — and leave `overlappingShaftCells`'s inclusive predicate exactly as it is:

```js
  // Widened in Phase 2c from one cell to the connector's own footprint. The
  // ledger's rule for this change, recorded when the spanning exploit was
  // closed: tighten the boundary predicate and widen the descriptor window,
  // NEVER relax the grouping. The grouping is inclusive (>= -EPS) while the
  // footprint tests are exclusive (> +EPS), so grouping stays a strict
  // SUPERSET and no overlapped cell can be missed. That relationship is the
  // whole safety argument; preserve it or the exploit comes back.
```

- [ ] **Step 5: Watch the negative go red, then green**

Shrink the returned bounds by 0.5 m on one axis and re-run. Expected: `THE MULTI-SHAFT GATE` FAILS on `missing` — points outside the shrunk footprint with no floor. Record the count. **Restore.**

Then widen the bounds by 0.5 m and re-run. Expected: FAILS on `blocked`. Record. **Restore.** A gate that only catches one direction of error is half a gate.

- [ ] **Step 5: Run everything, including the full-seed gate**

Run: `npm test && MAZE_SEEDS=1000 npm test`
Expected: PASS. Nothing emits a non-square hole yet, so this task must not move a single existing measurement.

- [ ] **Step 6: Commit**

```bash
git add src/worlds/maze/MazeColliders.js scripts/tests/
git commit -m "Let a connector punch a hole the shape it actually needs"
```

---

### Task 9: The tunnel, built and switched on

**Files:**
- Modify: `src/worlds/maze/MazeShafts.js` — `tunnelColliders`, the dispatcher's `case 'tunnel'`
- Modify: `src/worlds/maze/MazeChunks.js` — `CHUNK_MESH_KINDS`
- Modify: `src/worlds/MazeWorld.js` — the `vault` material
- Modify: `scripts/tests/maze-enclosure.test.mjs`

**Interfaces:**
- Consumes: Task 7's proven footprint, Task 8's region perforation.
- Produces: `tunnelColliders(cells, x, z, level) -> ColliderDesc[]`.

- [ ] **Step 1: Write the failing test — the tunnel's own six properties on real generated output**

Not on fixtures. Task 7 proved the footprint on a fixture; this proves the emitted geometry matches it, on real seeds, which is the gap that let 617 unenterable shafts pass six separate "is it sealed" assertions.

- [ ] **Step 2: Build `tunnelColliders` to Task 7's parameters exactly**

Any deviation from the proven parameters invalidates Task 7. If building reveals the parameters were wrong, **return to Task 7 and re-prove** rather than adjusting here.

- [ ] **Step 3: Add the mesh kind and the cached emissive vault material**

No lights. Run the render-coverage test.

- [ ] **Step 4: Flip the dispatcher**

```js
    case 'tunnel': return tunnelColliders(cells, x, z, level);
```

- [ ] **Step 5: Carried minor — give property 3 a negative**

2b's ledger: "property 3 (walk away) is the only one of the six with no dedicated negative." The tunnel makes that load-bearing, because severing a corridor is its most likely failure. Add a fixture that deliberately walls one flight's outer face across a corridor and confirm the flood fill drops below 400/400.

- [ ] **Step 6: Run everything**

Run: `npm test && MAZE_SEEDS=1000 npm test && node scripts/contract-check.mjs && npm run build`

- [ ] **Step 7: Commit**

```bash
git add src/worlds/ scripts/tests/
git commit -m "Build the tunnel the footprint proof said would fit"
```

---

### Task 10: Prove it in the browser

**Files:**
- Modify: `src/dev/Harness.js` or `src/dev/MazeProbes.js` — `mazeStats()`, named views
- Modify: `docs/superpowers/specs/2026-08-08-maze-world-phase-2c-ledger.md`

**Interfaces:**
- Consumes: everything above.
- Produces: `mazeStats()` extended with `connectorCounts` and `liftsResident`; named views framing a lift and a tunnel.

**Views must be player-aware and dynamically discovered.** 2b's harness scanned from (0,0) and framed unstreamed void three times in four, and its `tower-top` view moved the camera but not the player, so residency and the canopy stayed at the old level and the shot showed only sky. Discover a live lift and a live tunnel by scanning resident cells for `DIR.UP` and the matching connector bits, and teleport the player — not just the camera. Do not teleport them into the well.

- [ ] **Step 1: Extend `mazeStats()` and add the two views**

- [ ] **Step 2: Drive the browser via Chrome DevTools MCP against `?dev=1`**

Record: entry time, `renderer.info.programs.length` across ten consecutive entries (must be flat — this is the highest-risk detail in the whole feature), resident districts, collider count, draw calls, and frame time while walking.

- [ ] **Step 3: Ride a lift and climb a tunnel, in a real session**

The 2b lesson is that colliders being provably correct says nothing about whether the thing is playable, visible or lit. Look at them. Screenshot both. A tunnel that is pitch black is a failed tunnel however green its gates are.

- [ ] **Step 4: Record findings and commit the ledger**

---

## Phase 2c exit criteria

- [ ] `npm test` passes; `MAZE_SEEDS=1000 npm test` passes.
- [ ] `node scripts/contract-check.mjs` exits 0; `npm run build` succeeds.
- [ ] All three connector kinds appear in real generation at their weighted frequencies.
- [ ] Every lift and every tunnel passes the same enclosure gate the stairs pass, on real seeds.
- [ ] A player can ride a lift and climb a tunnel from level 0 to level 3.
- [ ] No collider top sits in the 0.45–5.0 m band outside a proven shaft, **at any point in any moving part's travel**.
- [ ] Portal entry still under 3 s; shader programs still flat across ten entries.
- [ ] Every new gate has had its red observed and recorded.

## What Phase 2c knowingly does not do

- **No map, no puzzles, no abandon control, no centre reward.** Phases 3–5.
- **No art pass.** The ~1.2 m² of open well floor per shaft — daylight visible through the floor from above — stays deferred, and a tunnel may add more of it.
- **No pitched descriptors.** A genuine sloped ramp would change the data structure every headless gate is built on. If the tunnel's stepped run reads badly, that is the art pass's problem or a later phase's, not this one's.
- **The lift is not a puzzle.** §8's counterweight-lift *mechanism* is here; the puzzle framing around it is Phase 3's.
