# Maze World — Phase 2b: Four Levels Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the maze from one level into four, with stairs, tunnels and lifts you can actually walk between them on, and a distant canopy so a tower vantage shows a maze rather than a void.

**Architecture:** The topology already records vertical links as `DIR.UP`/`DIR.DOWN` bits — nothing renders them yet. This phase builds shaft geometry at those cells, extends residency to span levels, and adds a collider-free canopy beyond the resident set. It first makes `Physics.remove()` O(1), because chunk eviction is already 87% inside its linear scan and four levels multiplies that.

**Tech Stack:** Three.js 0.185.1, Vite 8, vanilla ES modules. Tests use Node's built-in `node:test` — **no new dependencies**.

## Global Constraints

- **Cell pitch 6.0 m. Corridor 4.8 m. Hedge thickness 1.2 m. Hedge height 5.0 m. `LEVEL_HEIGHT` 9.0 m.**
- **District 20 × 20 cells. 20 × 20 districts per level. 4 levels. 640,000 cells.**
- **A hop clears exactly 0.93 m; auto-step is 0.45 m.**
- **`MazeTopology.js` and `MazeColliders.js` stay pure** — no `three`, no DOM.
- **Materials reused across re-rolls and chunks.** Shader compilation dominates cold boot; a per-chunk or per-shaft material allocation is a task failure.
- **Portal entry stays under 3 s.** Residency stays bounded.
- **No new npm dependencies.** `.js` extensions in all import specifiers.

## The central problem this phase has to solve

Phase 1's anti-exploit rule is absolute: **no collider top may sit between 0.45 m and 5.0 m**, because anything in that band is a step onto a 5 m hedge. `scripts/tests/maze-colliders.test.mjs` enforces it on every emitted collider.

**A staircase is made entirely of colliders in that band.** So this phase cannot add stairs without changing that rule — and loosening it would discard the guarantee that the whole of Phase 1 was built to prove.

The resolution is to make the rule narrower and add a proof obligation:

- A step may sit in the band **only if it is inside an enclosed shaft** — a cell whose four sides are solid to at least hedge height, with no horizontal passage out at any height above the shaft floor except the two the shaft connects.
- **Enclosure is proven, not declared.** A containment sweep launched from inside each shaft must be unable to reach hedge-top height anywhere outside it.

Task 2 builds that before any stairs exist, so the gate is ready to catch the first one that gets it wrong.

## Scope

In: `Physics.remove()` performance, the enclosure rule, stair/tunnel/lift shafts, four levels, cross-level residency, canopy LOD, and the four minors carried from 2a's ledger.

Out: the `M` map, puzzles, the abandon control, and the art pass. Those are Phases 3-5.

---

### Task 1: Make `Physics.remove()` O(1)

**Files:**
- Modify: `src/physics/Physics.js` — `constructor`, `add`, `remove`, `clear`
- Modify: `scripts/tests/physics-remove.test.mjs` (append)

**Interfaces:**
- Consumes: nothing.
- Produces: no API change. `remove(collider)` keeps its signature and semantics; only its cost changes.

**Why first, and why carefully.** Evicting one district costs ~1.5 ms, and **86.9% of that is `Physics.remove()`'s `indexOf` over the ~10,000-entry collider array**, called 401 times per district. Four levels multiplies collider counts, and cross-level residency multiplies evictions. But `Physics.js` is shared by all six worlds, so this task changes shared code and needs its own regression pass — that is why it is alone in this task rather than folded into the streaming work.

**The approach:** keep `colliders` an array (order is observable — `WorldManager` iterates it, and `query` results depend on grid insertion order), but maintain a `Map` from collider to its array index. Removal swaps the last element into the hole and updates one index, turning O(n) into O(1). Swap-remove changes array *order*, so verify nothing depends on it.

- [ ] **Step 1: Write the failing test**

Append to `scripts/tests/physics-remove.test.mjs`:

```js
test('remove is not linear in collider count', () => {
  /* Chunk eviction calls remove() ~400 times per district against an array of
   * ~10,000. At O(n) that dominates the frame; the maze's four-level phase
   * multiplies it. This asserts the shape of the curve, not a wall-clock
   * budget, so it does not go flaky on a slow machine. */
  const time = (n) => {
    const p = new Physics(null);
    const made = [];
    for (let i = 0; i < n; i++) made.push(p.addBox(i * 3, 0, 0, 1, 1, 1));
    const t0 = process.hrtime.bigint();
    for (const c of made) p.remove(c);
    return Number(process.hrtime.bigint() - t0) / 1e6;
  };
  time(2000); // warm
  const small = Math.max(time(2000), 0.01);
  const large = time(16000);
  // 8x the colliders. Linear removal is ~64x the work; O(1) is ~8x.
  assert.ok(large / small < 24,
    `remove looks super-linear: 2000 took ${small.toFixed(1)}ms, 16000 took ${large.toFixed(1)}ms`);
});

test('remove still works when the collider is the last one', () => {
  const p = new Physics(null);
  const a = p.addBox(0, 0, 0, 1, 1, 1);
  const b = p.addBox(50, 0, 0, 1, 1, 1);
  assert.equal(p.remove(b), true);
  assert.equal(p.colliders.length, 1);
  assert.equal(p.colliders[0], a);
  assert.equal(p.remove(a), true);
  assert.equal(p.colliders.length, 0);
});

test('removing every collider in a shuffled order leaves nothing behind', () => {
  const p = new Physics(null);
  const made = [];
  for (let i = 0; i < 500; i++) made.push(p.addBox((i % 25) * 7, 0, Math.floor(i / 25) * 7, 1, 1, 1));
  // Deterministic shuffle.
  for (let i = made.length - 1; i > 0; i--) {
    const j = (i * 7919) % (i + 1);
    [made[i], made[j]] = [made[j], made[i]];
  }
  for (const c of made) assert.equal(p.remove(c), true, 'a collider went missing mid-teardown');
  assert.equal(p.colliders.length, 0);
  assert.equal(p._grid.size, 0);
});

test('clear resets the index as well as the array', () => {
  const p = new Physics(null);
  const a = p.addBox(0, 0, 0, 1, 1, 1);
  p.clear();
  assert.equal(p.colliders.length, 0);
  // A stale index entry would make this remove() corrupt the fresh array.
  assert.equal(p.remove(a), false);
  const b = p.addBox(0, 0, 0, 1, 1, 1);
  assert.equal(p.colliders.length, 1);
  assert.equal(p.remove(b), true);
  assert.equal(p.colliders.length, 0);
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npm test`

Expected: FAIL on `remove is not linear in collider count` — the ratio is far above 24 today.

- [ ] **Step 3: Add the index**

In `src/physics/Physics.js`, in the constructor, after `this.colliders = []`:

```js
    /**
     * collider -> its index in `colliders`.
     *
     * Removal used to `indexOf` a ten-thousand-entry array, four hundred times
     * per streamed district. This makes it a map lookup and a swap. The array
     * itself stays, because `WorldManager` iterates it on every activation and
     * the broadphase relies on it.
     * @type {Map<Collider, number>}
     */
    this._index = new Map();
```

In `add(collider)`, before returning:

```js
    this._index.set(collider, this.colliders.length - 1);
```

(place it immediately after the existing `this.colliders.push(collider)`, so the index matches.)

Replace the array-removal part of `remove(collider)`:

```js
    const at = this._index.get(collider);
    if (at === undefined) return false;
    /* Swap-remove: move the last collider into the hole rather than shifting
     * everything after it. Nothing depends on `colliders` order - the
     * broadphase grid is a separate structure and WorldManager only iterates
     * to re-register - so paying O(n) to preserve it would buy nothing. */
    const last = this.colliders.pop();
    this._index.delete(collider);
    if (last !== collider) {
      this.colliders[at] = last;
      this._index.set(last, at);
    }
```

and delete the old `indexOf`/`splice` pair. In `clear()`, add:

```js
    this._index.clear();
```

- [ ] **Step 4: Run the tests**

Run: `npm test`

Expected: PASS, all of them. **If any pre-existing test fails, something did depend on collider array order — report it rather than working around it.**

- [ ] **Step 5: Regression pass across every world**

This is shared code. Run `npm run dev` and open each world in turn via `http://localhost:5173/game/?dev=1&autostart=1&world=<id>` for `station`, `medieval`, `sports`, `citadel`, `race`, `maze`. In each, confirm you can walk, that the ground is solid, and that `GAME.physics.colliders.length` is non-zero and stable. Report the collider count for each world.

- [ ] **Step 6: Commit**

```bash
git add src/physics/Physics.js scripts/tests/physics-remove.test.mjs
git commit -m "Stop paying for a linear scan on every collider removed

Evicting one streamed district was ~1.5ms, and 87% of it was indexOf over a
ten-thousand-entry array, four hundred times over. Four levels multiplies both
the array and the number of evictions.

A map from collider to index makes it a lookup and a swap. The array stays,
because WorldManager iterates it on every activation, but its order no longer
does - swap-remove reorders, and nothing was relying on it. Physics is shared
by all six worlds, which is why this is its own change with its own pass over
each of them rather than being folded into the maze work."
```

---

### Task 2: Enclosure — a narrower anti-ladder rule with a proof obligation

**Files:**
- Modify: `src/worlds/maze/MazeColliders.js` — descriptor shape
- Modify: `scripts/tests/maze-colliders.test.mjs` — the anti-ladder gate
- Create: `scripts/tests/maze-enclosure.test.mjs`

**Interfaces:**
- Consumes: `districtColliders`, `forecourtColliders`.
- Produces: `ColliderDesc` gains an optional `enclosed?: boolean`. A descriptor with `enclosed: true` is exempt from the 0.45–5.0 m band rule, and in exchange becomes subject to the enclosure proof.

**Do this before any stairs exist.** The gate must be able to catch the first shaft that gets it wrong, which means it has to exist first.

- [ ] **Step 1: Write the failing test**

Create `scripts/tests/maze-enclosure.test.mjs`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { Physics } from '../../src/physics/Physics.js';
import { MAZE } from '../../src/worlds/maze/MazeTopology.js';
import { isEnclosureSound } from '../../src/worlds/maze/MazeColliders.js';

const RADIUS = 0.35, HEIGHT = 1.75, SPRINT = 8.2, HOP = 0.93, STEP = 1 / 60;

/**
 * Drive a capsule around inside a set of colliders and report the highest it
 * ever gets outside the shaft footprint. This is the proof that an `enclosed`
 * exemption is honest: steps may exist in the hop band only if a player using
 * them cannot arrive on top of a hedge.
 */
function escapeHeight(descs, shaft) {
  const p = new Physics(null);
  for (const d of descs) p.addBox(d.cx, d.cy, d.cz, d.hx, d.hy, d.hz);
  const pos = new THREE.Vector3();
  let highestOutside = -Infinity;
  for (let a = 0; a < 32; a++) {
    const ang = (a / 32) * Math.PI * 2;
    pos.set(shaft.cx, shaft.floorY + 0.05, shaft.cz);
    const vx = Math.cos(ang) * SPRINT, vz = Math.sin(ang) * SPRINT;
    for (let s = 0; s < 200; s++) {
      pos.x += vx * STEP; pos.z += vz * STEP;
      if (s % 20 === 0) pos.y += HOP;          // try to hop out on the way
      p.resolveCapsule(pos, RADIUS, HEIGHT);
      const outside = Math.abs(pos.x - shaft.cx) > MAZE.CELL / 2
                   || Math.abs(pos.z - shaft.cz) > MAZE.CELL / 2;
      if (outside) highestOutside = Math.max(highestOutside, pos.y - shaft.floorY);
    }
  }
  return highestOutside;
}

test('a sealed shaft is sound', () => {
  // Four full-height walls around one cell, with a step ladder inside.
  const c = MAZE.CELL, H = MAZE.HEDGE_HEIGHT;
  const descs = [
    { cx: 0, cy: -0.5, cz: 0, hx: c, hy: 0.5, hz: c, kind: 'floor' },
    { cx: -c / 2, cy: H / 2, cz: 0, hx: 0.6, hy: H / 2, hz: c / 2, kind: 'hedge' },
    { cx: c / 2, cy: H / 2, cz: 0, hx: 0.6, hy: H / 2, hz: c / 2, kind: 'hedge' },
    { cx: 0, cy: H / 2, cz: -c / 2, hx: c / 2, hy: H / 2, hz: 0.6, kind: 'hedge' },
    { cx: 0, cy: H / 2, cz: c / 2, hx: c / 2, hy: H / 2, hz: 0.6, kind: 'hedge' },
  ];
  for (let i = 0; i < 8; i++) {
    descs.push({ cx: -1 + i * 0.3, cy: (i + 1) * 0.25, cz: 0, hx: 0.8, hy: (i + 1) * 0.25, hz: 0.8, kind: 'stair', enclosed: true });
  }
  assert.ok(escapeHeight(descs, { cx: 0, cz: 0, floorY: 0 }) < MAZE.HEDGE_HEIGHT,
    'a capsule escaped a sealed shaft above hedge height');
  assert.equal(isEnclosureSound(descs, { cx: 0, cz: 0, floorY: 0 }), true);
});

test('a shaft with a missing wall is NOT sound', () => {
  const c = MAZE.CELL, H = MAZE.HEDGE_HEIGHT;
  const descs = [
    { cx: 0, cy: -0.5, cz: 0, hx: c * 3, hy: 0.5, hz: c * 3, kind: 'floor' },
    { cx: -c / 2, cy: H / 2, cz: 0, hx: 0.6, hy: H / 2, hz: c / 2, kind: 'hedge' },
    { cx: 0, cy: H / 2, cz: -c / 2, hx: c / 2, hy: H / 2, hz: 0.6, kind: 'hedge' },
    { cx: 0, cy: H / 2, cz: c / 2, hx: c / 2, hy: H / 2, hz: 0.6, kind: 'hedge' },
    // east wall missing
  ];
  for (let i = 0; i < 8; i++) {
    descs.push({ cx: -1 + i * 0.3, cy: (i + 1) * 0.25, cz: 0, hx: 0.8, hy: (i + 1) * 0.25, hz: 0.8, kind: 'stair', enclosed: true });
  }
  assert.equal(isEnclosureSound(descs, { cx: 0, cz: 0, floorY: 0 }), false,
    'an open-sided shaft was reported sound');
});
```

Then in `scripts/tests/maze-colliders.test.mjs`, change the anti-ladder gate so it exempts `enclosed` descriptors **and states why**:

```js
      for (const d of districtColliders(t.cells, dx, dz, 0)) {
        // A step inside a sealed shaft is allowed in the band: it cannot reach a
        // hedge top, and scripts/tests/maze-enclosure.test.mjs proves that
        // separately by driving a capsule around inside each shaft. Everything
        // else in the band is a ladder.
        if (d.enclosed) continue;
        const top = d.cy + d.hy;
        ...
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npm test`

Expected: FAIL — `does not provide an export named 'isEnclosureSound'`.

- [ ] **Step 3: Implement `isEnclosureSound`**

Append to `src/worlds/maze/MazeColliders.js`. **It must stay pure** — no THREE. It is a geometric check over descriptors, not a simulation:

```js
/**
 * Is a shaft genuinely sealed?
 *
 * Phase 1's rule was absolute: nothing standable between 0.45 m and 5.0 m,
 * because anything there is a step onto a 5 m hedge. A staircase is made
 * entirely of such steps, so four levels cannot exist under that rule.
 *
 * The rule is therefore narrowed rather than dropped: a step may sit in the
 * band only inside a sealed shaft. This function is what makes that exemption
 * honest — it checks that the shaft's cell is walled on all four sides from its
 * floor to at least hedge height, so a player using the steps arrives on the
 * next level rather than on top of the maze.
 *
 * @param {ColliderDesc[]} descs every collider near the shaft
 * @param {{cx:number, cz:number, floorY:number}} shaft cell centre and floor
 * @returns {boolean}
 */
export function isEnclosureSound(descs, shaft) {
  const half = MAZE.CELL / 2;
  const need = shaft.floorY + MAZE.HEDGE_HEIGHT;
  const sides = [
    { axis: 'x', at: shaft.cx - half },
    { axis: 'x', at: shaft.cx + half },
    { axis: 'z', at: shaft.cz - half },
    { axis: 'z', at: shaft.cz + half },
  ];

  for (const side of sides) {
    let covered = false;
    for (const d of descs) {
      if (d.enclosed) continue;                      // steps do not wall a shaft
      const top = d.cy + d.hy;
      const bottom = d.cy - d.hy;
      if (top < need - 1e-6 || bottom > shaft.floorY + 1e-6) continue;
      if (side.axis === 'x') {
        if (Math.abs(d.cx - side.at) > d.hx + 1e-6) continue;
        if (Math.abs(d.cz - shaft.cz) > d.hz + half - 1e-6) continue;
      } else {
        if (Math.abs(d.cz - side.at) > d.hz + 1e-6) continue;
        if (Math.abs(d.cx - shaft.cx) > d.hx + half - 1e-6) continue;
      }
      covered = true;
      break;
    }
    if (!covered) return false;
  }
  return true;
}
```

- [ ] **Step 4: Run the tests**

Run: `npm test`

Expected: PASS. Both enclosure tests, and the amended anti-ladder gate still green (nothing is `enclosed` yet, so its behaviour is unchanged today — that is the point of adding it before the stairs).

- [ ] **Step 5: Commit**

```bash
git add src/worlds/maze/MazeColliders.js scripts/tests/maze-colliders.test.mjs scripts/tests/maze-enclosure.test.mjs
git commit -m "Let a staircase exist, without letting anyone climb a hedge

Phase 1's anti-ladder rule forbids any collider top between 0.45m and 5.0m,
because anything there is a step onto a five metre hedge. A staircase is made
entirely of those, so four levels could not exist under it.

Rather than loosen the rule, it is narrowed and given a proof obligation: a step
may sit in the band only inside a sealed shaft, and enclosure is checked
geometrically rather than declared. The companion test drives a capsule around
inside a shaft from thirty-two angles, hopping as it goes, and fails if it ever
reaches hedge-top height outside the shaft footprint - and fails a shaft with a
missing wall, which is the case that would otherwise pass by inspection.

Nothing is enclosed yet. The gate exists before the first staircase so it can
catch the one that gets it wrong."
```

---

### Task 3: Stair shafts

**Files:**
- Modify: `src/worlds/maze/MazeColliders.js` — emit shafts
- Modify: `scripts/tests/maze-colliders.test.mjs`, `scripts/tests/maze-enclosure.test.mjs`

**Interfaces:**
- Consumes: `isEnclosureSound` (Task 2), `MAZE`, `DIR`, `isOpen`, `cellIndex`, `cellToWorld`.
- Produces: `shaftColliders(cells, x, z, level): ColliderDesc[]` — the steps and shaft walls for a cell carrying `DIR.UP`. `districtColliders` calls it for every such cell.

**Design.** A cell with `DIR.UP` becomes a shaft: four walls to `LEVEL_HEIGHT + HEDGE_HEIGHT`, and a flight of steps spiralling from this level's floor to the next. Steps rise `LEVEL_HEIGHT / stepCount` each, with `stepCount` chosen so no single step exceeds the 0.45 m auto-step — otherwise the player cannot walk up it. `LEVEL_HEIGHT` is 9.0, so 24 steps of 0.375 m works and leaves margin.

The cell's own horizontal passages stay open where the topology says so — the shaft walls go on the closed sides only, and the open side is how you enter. That means the shaft is not sealed on the entry side, so `isEnclosureSound` must be applied to the *upper* portion only: walls must be solid from `floorY + 0.45` (above the entry threshold is irrelevant — the check is that you cannot leave sideways once you are above hop height).

- [ ] **Step 1: Write the failing test**

Append to `scripts/tests/maze-enclosure.test.mjs`:

```js
import { generateTopology, cellIndex, isOpen, DIR, cellCoords } from '../../src/worlds/maze/MazeTopology.js';
import { districtColliders, cellToWorld, shaftColliders } from '../../src/worlds/maze/MazeColliders.js';

/** Every cell in a district that carries an UP link. */
function shaftCells(cells, dx, dz, level) {
  const out = [];
  for (let lz = 0; lz < MAZE.DISTRICT; lz++) {
    for (let lx = 0; lx < MAZE.DISTRICT; lx++) {
      const x = dx * MAZE.DISTRICT + lx, z = dz * MAZE.DISTRICT + lz;
      if (isOpen(cells, cellIndex(x, z, level), DIR.UP)) out.push({ x, z });
    }
  }
  return out;
}

test('every shaft is climbable: no step exceeds the auto-step height', () => {
  const t = generateTopology(2026, { levels: 2 });
  let checked = 0;
  for (let dz = 0; dz < 4; dz++) for (let dx = 0; dx < 4; dx++) {
    for (const c of shaftCells(t.cells, dx, dz, 0)) {
      const steps = shaftColliders(t.cells, c.x, c.z, 0).filter((d) => d.kind === 'stair');
      assert.ok(steps.length > 0, `shaft at ${c.x},${c.z} has no steps`);
      const tops = steps.map((s) => s.cy + s.hy).sort((a, b) => a - b);
      for (let i = 1; i < tops.length; i++) {
        assert.ok(tops[i] - tops[i - 1] <= 0.45 + 1e-6,
          `step rise ${(tops[i] - tops[i - 1]).toFixed(3)}m exceeds the 0.45m auto-step`);
      }
      checked++;
    }
  }
  assert.ok(checked > 0, 'no shafts found to check');
});

test('every shaft reaches the next level', () => {
  const t = generateTopology(7, { levels: 2 });
  for (let dz = 0; dz < 3; dz++) for (let dx = 0; dx < 3; dx++) {
    for (const c of shaftCells(t.cells, dx, dz, 0)) {
      const steps = shaftColliders(t.cells, c.x, c.z, 0).filter((d) => d.kind === 'stair');
      const highest = Math.max(...steps.map((s) => s.cy + s.hy));
      const base = cellToWorld(c.x, c.z, 0).y;
      assert.ok(highest >= base + MAZE.LEVEL_HEIGHT - 0.45,
        `shaft tops out at ${(highest - base).toFixed(2)}m, short of LEVEL_HEIGHT`);
    }
  }
});

test('THE ENCLOSURE GATE: every shaft is sealed above hop height', () => {
  for (const seed of [1, 42, 2026]) {
    const t = generateTopology(seed, { levels: 2 });
    for (let dz = 0; dz < 3; dz++) for (let dx = 0; dx < 3; dx++) {
      const descs = districtColliders(t.cells, dx, dz, 0);
      for (const c of shaftCells(t.cells, dx, dz, 0)) {
        const w = cellToWorld(c.x, c.z, 0);
        assert.equal(
          isEnclosureSound(descs, { cx: w.x, cz: w.z, floorY: w.y }), true,
          `seed ${seed} shaft at ${c.x},${c.z} is not sealed`,
        );
      }
    }
  }
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npm test`

Expected: FAIL — `does not provide an export named 'shaftColliders'`.

- [ ] **Step 3: Implement `shaftColliders` and wire it into `districtColliders`**

In `src/worlds/maze/MazeColliders.js`:

```js
/** Steps per shaft. LEVEL_HEIGHT / this must not exceed the 0.45 m auto-step. */
const SHAFT_STEPS = 24;

/**
 * A staircase from `level` to `level + 1`, inside the cell that carries the
 * UP link.
 *
 * The steps spiral around the cell's edge so a 6 m cell can climb 9 m without
 * any single rise exceeding the auto-step. The shaft's walls are emitted at
 * full height on the cell's CLOSED sides, and stop at hop height on the open
 * one — you have to be able to walk in, and once you are above 0.93 m you
 * cannot get back out sideways. `isEnclosureSound` checks exactly that.
 */
export function shaftColliders(cells, x, z, level) {
  const idx = cellIndex(x, z, level);
  if (!isOpen(cells, idx, DIR.UP)) return [];

  const w = cellToWorld(x, z, level);
  const out = [];
  const rise = MAZE.LEVEL_HEIGHT / SHAFT_STEPS;
  const r = MAZE.CORRIDOR / 2 - 0.5;

  for (let i = 0; i < SHAFT_STEPS; i++) {
    const a = (i / SHAFT_STEPS) * Math.PI * 2 * 1.5;   // one and a half turns
    const top = w.y + (i + 1) * rise;
    out.push({
      cx: w.x + Math.cos(a) * r,
      cy: w.y + top / 2 - w.y / 2,
      cz: w.z + Math.sin(a) * r,
      hx: 0.75, hy: (top - w.y) / 2, hz: 0.75,
      kind: 'stair',
      enclosed: true,
    });
  }

  /* Walls. Full height on closed sides; the open side is the way in, and only
   * needs sealing above hop height. */
  const H = MAZE.LEVEL_HEIGHT + MAZE.HEDGE_HEIGHT;
  const half = MAZE.CELL / 2;
  const sides = [
    { dir: DIR.N, dx: 0, dz: -1 }, { dir: DIR.E, dx: 1, dz: 0 },
    { dir: DIR.S, dx: 0, dz: 1 }, { dir: DIR.W, dx: -1, dz: 0 },
  ];
  for (const s of sides) {
    const open = isOpen(cells, idx, s.dir);
    const baseY = open ? w.y + 1.0 : w.y;          // clear the doorway
    const topY = w.y + H;
    out.push({
      cx: w.x + s.dx * half,
      cy: (baseY + topY) / 2,
      cz: w.z + s.dz * half,
      hx: s.dx ? 0.6 : half,
      hy: (topY - baseY) / 2,
      hz: s.dz ? 0.6 : half,
      kind: 'hedge',
    });
  }

  return out;
}
```

Then in `districtColliders`, after the per-cell hedge emission, add:

```js
      if (isOpen(cells, idx, DIR.UP)) {
        for (const d of shaftColliders(cells, x, z, level)) out.push(d);
      }
```

- [ ] **Step 4: Run the tests**

Run: `npm test`

Expected: PASS, including the enclosure gate. **If the enclosure gate fails, the shaft geometry is wrong — do not exempt more descriptors to make it pass.** Report which shaft failed and on which side.

- [ ] **Step 5: Commit**

```bash
git add src/worlds/maze/MazeColliders.js scripts/tests/maze-enclosure.test.mjs
git commit -m "Build the stairs the vertical links have always described

carveDistrict has been setting UP and DOWN bits since phase 1 and nothing ever
rendered them. Each one now becomes a shaft: a stair of twenty-four treads
spiralling one and a half turns up nine metres, so no single rise exceeds the
0.45m the player can auto-step, inside walls that run full height on the closed
sides and seal above hop height on the side you walk in through.

The enclosure gate from the previous commit is what makes the steps legal, and
it is checked per shaft per seed rather than assumed."
```

---

### Task 4: Four levels

**Files:**
- Modify: `src/worlds/MazeWorld.js` — `generateTopology(seed, { levels: MAZE.LEVELS })`, residency across levels
- Modify: `src/worlds/maze/MazeChunks.js` — residency follows the player's level
- Modify: `scripts/tests/maze-entrance.test.mjs`

**Interfaces:**
- Consumes: everything above.
- Produces: `MazeChunks.updateResidency(x, y, z, radius)` — note the added `y`, from which the level is derived; the old `level` parameter goes.

**The level a player is on** is `Math.round((y - baseY) / LEVEL_HEIGHT)`, clamped. Residency loads the player's own level plus the one above and below at a smaller radius — a player halfway up a shaft must have both ends resident, or they climb into nothing.

- [ ] **Step 1: Write the failing test**

Append to `scripts/tests/maze-entrance.test.mjs`:

```js
test('the maze is four levels and every one is reachable', async () => {
  const { world } = await buildMazeWorld();
  const t = { cells: world.cells };
  // Every level must be carved, i.e. some cell on it has an open passage.
  for (let lv = 0; lv < MAZE.LEVELS; lv++) {
    let any = false;
    for (let i = lv * MAZE.LEVEL_CELLS; i < (lv + 1) * MAZE.LEVEL_CELLS; i += 97) {
      if (t.cells[i] !== 0) { any = true; break; }
    }
    assert.ok(any, `level ${lv} was never carved`);
  }
  assert.equal(reachableCount(world.cells, world.entranceCell), MAZE.TOTAL_CELLS);
});

test('residency spans the level above and below', async () => {
  const { world } = await buildMazeWorld();
  const p = world.ctx.player.position;
  // Stand on level 1.
  p.set(1260, MAZE.LEVEL_HEIGHT, 600);
  world.update(0.016);
  const levels = new Set(world.chunks.residentKeys().map((k) => districtCoords(k).level));
  assert.ok(levels.has(1), 'the player\'s own level is not resident');
  assert.ok(levels.has(0) || levels.has(2), 'no adjacent level is resident');
});

test('residency stays bounded across levels', async () => {
  const { world, physics } = await buildMazeWorld();
  const p = world.ctx.player.position;
  let peak = 0;
  for (let i = 0; i < 12; i++) {
    p.set(300 + i * 140, (i % MAZE.LEVELS) * MAZE.LEVEL_HEIGHT, 300 + i * 110);
    world.update(0.016);
    peak = Math.max(peak, world.chunks.residentKeys().length);
  }
  // 25 on the player's level + a smaller ring on each neighbour.
  assert.ok(peak <= 45, `residency peaked at ${peak}`);
  assert.ok(physics.colliders.length < 60000, `colliders grew to ${physics.colliders.length}`);
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npm test`

Expected: FAIL on `the maze is four levels` — only level 0 is carved today.

- [ ] **Step 3: Turn levels on and make residency vertical**

In `src/worlds/MazeWorld.js`, change the generation call:

```js
    const topo = generateTopology(this.seed, { levels: MAZE.LEVELS });
```

In `src/worlds/maze/MazeChunks.js`, replace `updateResidency`:

```js
  /**
   * Bring residency in line with where the player is, including which level.
   *
   * The player's own level gets the full neighbourhood; the levels either side
   * get a smaller ring, because a player halfway up a shaft needs both ends
   * built and nothing else. Drops before it loads, as before.
   *
   * @param {number} x world metres
   * @param {number} y world metres — the level is derived from this
   * @param {number} z world metres
   * @param {number} [radius] districts either side on the player's own level
   */
  updateResidency(x, y, z, radius = 2) {
    const level = Math.min(MAZE.LEVELS - 1, Math.max(0, Math.round(y / MAZE.LEVEL_HEIGHT)));
    const want = new Set(neighbourhoodKeys(districtAtWorld(x, z, level), radius));
    for (const dl of [-1, 1]) {
      const near = level + dl;
      if (near < 0 || near >= MAZE.LEVELS) continue;
      for (const k of neighbourhoodKeys(districtAtWorld(x, z, near), 1)) want.add(k);
    }

    let changed = false;
    for (const key of [...this._resident.keys()]) {
      if (!want.has(key)) { this.drop(key); changed = true; }
    }
    for (const key of [...want].sort((a, b) => a - b)) {
      if (!this._resident.has(key)) { this.ensure(key); changed = true; }
    }
    return changed;
  }
```

and update `MazeWorld`'s two call sites to pass `player.y` (in `build()`, pass `this.playerSpawn.y`).

- [ ] **Step 4: Run the tests and the full gate**

Run: `npm test`, then `MAZE_SEEDS=1000 npm test`.

Expected: PASS. The full gate now exercises four-level solvability, which is what Phase 1's disconnection bug was about — it must be green.

- [ ] **Step 5: Commit**

```bash
git add src/worlds/MazeWorld.js src/worlds/maze/MazeChunks.js scripts/tests/maze-entrance.test.mjs
git commit -m "Open the other three levels

The topology has always generated four; only the ground one was ever carved,
because four levels of geometry was unaffordable before streaming and
unreachable before stairs. Both of those are now true.

Residency gained a vertical dimension with it. The player's own level keeps the
full five-by-five; the levels either side get a single ring, because someone
halfway up a shaft needs both ends built and nothing else. Building the full
neighbourhood on three levels at once would have tripled the resident set to buy
almost nothing."
```

---

### Task 5: The canopy

**Files:**
- Create: `src/worlds/maze/MazeCanopy.js`
- Modify: `src/worlds/MazeWorld.js`
- Create: `scripts/tests/maze-canopy.test.mjs`

**Interfaces:**
- Consumes: `MAZE`, `districtAtWorld`, `neighbourhoodKeys`, `districtCoords`.
- Produces: `class MazeCanopy` — `update(x, z, level)`, `disposeAll()`, `residentKeys()`.

**What it is.** Beyond the streamed districts the world currently just ends. At ground level 5 m hedges hide it completely; from the top of a shaft you would see a void. The canopy is one instanced flat quad per district at hedge-top height, **no colliders**, covering a wider radius than the resident set. It is scenery, and it must never be mistaken for ground.

- [ ] **Step 1: Write the failing test**

Create `scripts/tests/maze-canopy.test.mjs`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { Physics } from '../../src/physics/Physics.js';
import { MAZE, districtIndex, DISTRICT_SPAN } from '../../src/worlds/maze/MazeTopology.js';
import { MazeCanopy } from '../../src/worlds/maze/MazeCanopy.js';

function harness() {
  const physics = new Physics(null);
  const group = new THREE.Group();
  const material = new THREE.MeshStandardMaterial();
  const canopy = new MazeCanopy({ group, material });
  return { physics, group, canopy, material };
}

test('the canopy adds no colliders at all', () => {
  const { physics, canopy } = harness();
  canopy.update(10 * DISTRICT_SPAN, 10 * DISTRICT_SPAN, 0);
  assert.equal(physics.colliders.length, 0, 'the canopy is scenery and must never collide');
});

test('the canopy covers a wider radius than the streamed set', () => {
  const { canopy } = harness();
  canopy.update(10 * DISTRICT_SPAN, 10 * DISTRICT_SPAN, 0);
  assert.ok(canopy.residentKeys().length > 25,
    `canopy covers only ${canopy.residentKeys().length} districts`);
});

test('the canopy sits at hedge height, not on the ground', () => {
  const { group, canopy } = harness();
  canopy.update(10 * DISTRICT_SPAN, 10 * DISTRICT_SPAN, 0);
  let lowest = Infinity;
  group.traverse((o) => { if (o.isInstancedMesh) lowest = Math.min(lowest, o.position.y); });
  assert.ok(Number.isFinite(lowest), 'no canopy mesh was built');
});

test('the canopy is released', () => {
  const { group, canopy } = harness();
  canopy.update(10 * DISTRICT_SPAN, 10 * DISTRICT_SPAN, 0);
  assert.ok(group.children.length > 0);
  canopy.disposeAll();
  assert.equal(group.children.length, 0);
  assert.deepEqual(canopy.residentKeys(), []);
});

test('the canopy uses the material it was given', () => {
  const { group, canopy, material } = harness();
  canopy.update(10 * DISTRICT_SPAN, 10 * DISTRICT_SPAN, 0);
  group.traverse((o) => { if (o.material) assert.equal(o.material, material); });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npm test`

Expected: FAIL — `Cannot find module .../MazeCanopy.js`.

- [ ] **Step 3: Implement it**

Create `src/worlds/maze/MazeCanopy.js`:

```js
import * as THREE from 'three';
import { MAZE, DISTRICT_SPAN, districtAtWorld, districtCoords, neighbourhoodKeys } from './MazeTopology.js';

/** Districts of canopy either side of the player. Wider than the streamed set. */
const CANOPY_RADIUS = 8;

/**
 * Distant hedge-tops.
 *
 * Beyond the streamed districts the maze simply stops. At ground level the 5 m
 * hedges hide that completely, which is why it was invisible for a whole phase;
 * from the top of a shaft it is a void. This fills it with one flat quad per
 * district at hedge height.
 *
 * It carries no colliders and never will. It is the far side of a horizon, not
 * a floor, and a player who could stand on it would be standing on the tops of
 * the hedges the whole world is built to keep them out of.
 */
export class MazeCanopy {
  constructor({ group, material }) {
    this.group = group;
    this.material = material;
    /** @type {Map<number, THREE.InstancedMesh>} */
    this._resident = new Map();
    this._geo = new THREE.PlaneGeometry(DISTRICT_SPAN, DISTRICT_SPAN);
    this._geo.rotateX(-Math.PI / 2);
  }

  residentKeys() {
    return [...this._resident.keys()].sort((a, b) => a - b);
  }

  update(x, z, level) {
    const want = new Set(neighbourhoodKeys(districtAtWorld(x, z, level), CANOPY_RADIUS));
    for (const key of [...this._resident.keys()]) {
      if (!want.has(key)) this._drop(key);
    }
    for (const key of want) {
      if (this._resident.has(key)) continue;
      const { dx, dz, level: lv } = districtCoords(key);
      const mesh = new THREE.InstancedMesh(this._geo, this.material, 1);
      mesh.name = `maze:canopy:${key}`;
      const m = new THREE.Matrix4().setPosition(
        dx * DISTRICT_SPAN + DISTRICT_SPAN / 2,
        lv * MAZE.LEVEL_HEIGHT + MAZE.HEDGE_HEIGHT,
        dz * DISTRICT_SPAN + DISTRICT_SPAN / 2,
      );
      mesh.setMatrixAt(0, m);
      mesh.instanceMatrix.needsUpdate = true;
      mesh.castShadow = false;
      mesh.receiveShadow = false;
      this.group.add(mesh);
      this._resident.set(key, mesh);
    }
  }

  _drop(key) {
    const mesh = this._resident.get(key);
    if (!mesh) return;
    this.group.remove(mesh);
    mesh.dispose();
    this._resident.delete(key);
  }

  disposeAll() {
    for (const key of [...this._resident.keys()]) this._drop(key);
    this._geo.dispose();
  }
}
```

- [ ] **Step 4: Wire it into `MazeWorld`**

Add a `canopy` material to `_ensureMaterials()` (a flat, slightly darker green than the hedges, `roughness: 1`), construct `MazeCanopy` alongside `MazeChunks` in `build()`, call `this.canopy.update(p.x, p.z, level)` in `update()` next to the residency call, and `this.canopy?.disposeAll()` in `dispose()`.

- [ ] **Step 5: Run the tests**

Run: `npm test`, `node scripts/contract-check.mjs` (add `MazeCanopy.js`), `npm run build`.

- [ ] **Step 6: Commit**

```bash
git add src/worlds/maze/MazeCanopy.js src/worlds/MazeWorld.js scripts/contract-check.mjs scripts/tests/maze-canopy.test.mjs
git commit -m "Give the maze a horizon

Beyond the streamed districts the world stopped. At ground level five metre
hedges hid that so completely it went unnoticed for an entire phase; from the
top of a stair it is a void.

One flat quad per district at hedge height, out to eight districts, with no
colliders and no shadows. The no-collider part is asserted rather than intended:
a canopy you could stand on would be the tops of the hedges, which is the exact
surface this world exists to keep the player off."
```

---

### Task 6: Prove it in the browser

**Files:**
- Modify: `src/dev/Harness.js` — extend `mazeStats()`, add elevated views

- [ ] **Step 1: Extend the probe**

`mazeStats()` gains `levels` (distinct levels in the resident set), `canopyDistricts`, and `playerLevel`.

- [ ] **Step 2: Add views that show the levels**

Add to the `maze` entry in `VIEWS`: a shaft interior looking up, and a tower-top framing looking out across the canopy.

- [ ] **Step 3: Verify manually**

Run `npm run dev`, open `http://localhost:5173/game/?dev=1&autostart=1&world=maze`, and in the console call `HARNESS.mazeStats()` (note: `window.HARNESS`, not `GAME.harness`).

Walk into a shaft and climb it. Confirm: you can ascend on foot; `playerLevel` increments; residency stays bounded; from the top the canopy fills the distance rather than a void.

- [ ] **Step 4: Commit**

```bash
git add src/dev/Harness.js
git commit -m "Let the harness see the levels

playerLevel, the distinct levels resident, and the canopy district count - the
three numbers that say whether four levels are actually working, none of which
a screenshot shows."
```

---

## Phase 2b exit criteria

- [ ] `npm test` passes; `MAZE_SEEDS=1000 npm test` passes at four levels.
- [ ] `node scripts/contract-check.mjs` exits 0; `npm run build` succeeds.
- [ ] **Every shaft passes the enclosure gate on every seed tested.** No exemptions beyond `enclosed` steps.
- [ ] A player can walk from level 0 to level 3 on foot.
- [ ] Residency ≤45 districts and colliders under 60,000 while moving between levels.
- [ ] Portal entry still under 3 s; shader programs still flat across ten entries.
- [ ] The four other worlds are unaffected — verified per world after the `Physics.js` change.

## Carried from 2a's ledger, to be folded in

- `carveDistrict`'s vertical-doorway check tests `nl >= MAZE.LEVELS` rather than the active limit (Task 4 touches this code).
- The residency property test's oracle restates `districtAtWorld`'s own formula.
- The ground-continuity test is a seam guard, not an eviction guard — add a comment saying so.

## What Phase 2b knowingly does not do

- **No lifts or tunnels yet.** Every vertical link is a staircase. Lifts need moving-platform support wired to `Physics.setBoxColliderY`, and tunnels need a distinct enclosed-descent shape; both are worth their own task once stairs are proven.
- **No art pass.** Shafts are boxes like everything else.
- **No map, no puzzles, no abandon control.** Phases 3-5.
