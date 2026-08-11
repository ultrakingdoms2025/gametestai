# Maze World — Phase 3: The Map and the Way Out

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the player the two things a 2.4 km re-rolling maze is unplayable without — something to read the level with, and a way out from anywhere — plus the reward that makes reaching the centre mean something.

**Architecture:** Everything here is UI and systems; no new geometry and no new colliders. The maze already owns a `Uint8Array` of every cell, and §3 of the spec makes that array the single source of truth for the map and the minimap, so both read it and neither consults geometry. `MazeWorld` continues to announce facts on the bus and never touches `Economy` or the HUD directly — `main.js` stays the single integration point, exactly as the dead-end tokens already do.

**Tech Stack:** Three.js 0.185.1, Vite 8, vanilla ES modules, 2D canvas for both map surfaces. Tests use Node's built-in `node:test` — **no new dependencies**.

## Global Constraints

- **The topology array is the source of truth.** The map, the minimap and the centre all read `world.cells`. Geometry is never consulted for any of them.
- **`MazeWorld` never touches `Economy` or `HUD`.** It emits on the bus; `src/main.js` owns the award and the notification. See `main.js`'s header and the existing `maze:token-found` handler.
- **The reward is 100 credits. Final.** Not scaled by maze size or completion time.
- **The map has NO you-are-here marker.** This is the central navigational challenge, not an oversight, and it is the one requirement most likely to be "helpfully" undone.
- **A player must never be stranded.** Hold-`L` works from anywhere, at any depth, on any level.
- **No new npm dependencies.** `.js` extensions in all import specifiers.
- **Pure logic is extracted and tested headlessly.** Canvas and DOM cannot be imported under Node, so anything worth asserting goes in a pure function first — the same division that lets the maze's other gates run in seconds.

## The decision this plan encodes

**`M` is contextual**, by the owner's ruling: it opens the maze map where mounts are forbidden, and the mount wheel everywhere else. I flagged that a context-dependent key is awkward to rebind, and the answer here is to make that flag not apply: **one `map` action joins `BINDABLE`**, both consumers read the same bound code, and rebinding it moves both together. The keybind panel gets one honest row rather than two that fight.

## File structure

| File | Responsibility |
|---|---|
| `src/ui/MazeMap.js` | **New.** The `M` map: renders one level from `cells`, pans and zooms. |
| `src/ui/maze-map.css` | **New.** Its styles. |
| `src/worlds/maze/MazePlan.js` | **New.** Pure: cell array → wall segments, and the plan cache key. No DOM, so it is testable and shared by both map surfaces. |
| `src/ui/Minimap.js` | Plan cache keyed by what the world says makes it unique; accepts a world-baked plan. |
| `src/worlds/MazeWorld.js` | `minimapPlanKey`, the abandon hold, the centre pickup, the return portal. |
| `src/core/Input.js` | The `map` action. |
| `src/main.js` | Awards the centre's 100 credits; wires abandon to the world switch. |

---

### Task 1: The plan cache key, and the re-roll bug it hides

**Files:**
- Create: `src/worlds/maze/MazePlan.js`
- Create: `scripts/tests/maze-plan.test.mjs`
- Modify: `src/ui/Minimap.js` — `_bakePlan` (~line 204), `_cache.set` (~line 298)
- Modify: `src/worlds/MazeWorld.js` — add `minimapPlanKey`

**Interfaces:**
- Consumes: `MAZE`, `DIR`, `cellIndex`, `isOpen` from `MazeTopology.js`.
- Produces:
  - `planCacheKey(world) -> string` — `world.minimapPlanKey` when the world declares one, else `world.id`.
  - `levelSegments(cells, level) -> Array<{x0,z0,x1,z1}>` — every hedge segment on one level, in CELL coordinates, for either map surface to draw.

**The bug, stated plainly.** `Minimap._bakePlan` caches on `world.id`. `MazeWorld` is volatile and re-rolls its layout on every entry, so the second visit is drawn with the **first visit's floorplan** — a map of a maze that no longer exists, which is worse than no map at all. The spec calls this out in §7 and it has been latent since Phase 1.

- [ ] **Step 1: Write the failing test**

Create `scripts/tests/maze-plan.test.mjs`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MAZE, DIR, generateTopology, cellIndex, isOpen } from '../../src/worlds/maze/MazeTopology.js';
import { planCacheKey, levelSegments } from '../../src/worlds/maze/MazePlan.js';

test('planCacheKey falls back to world.id for an ordinary world', () => {
  assert.equal(planCacheKey({ id: 'station' }), 'station');
});

test('THE RE-ROLL GATE: two seeds of the same world never share a plan cache key', () => {
  // The bug this whole task exists for: a volatile world cached on `id` alone
  // serves the PREVIOUS run's floorplan, which is a map of a maze that no
  // longer exists.
  const a = { id: 'maze', minimapPlanKey: 'maze:1111:0' };
  const b = { id: 'maze', minimapPlanKey: 'maze:2222:0' };
  assert.notEqual(planCacheKey(a), planCacheKey(b));
});

test('and neither do two levels of the same seed', () => {
  const l0 = { id: 'maze', minimapPlanKey: 'maze:1111:0' };
  const l1 = { id: 'maze', minimapPlanKey: 'maze:1111:1' };
  assert.notEqual(planCacheKey(l0), planCacheKey(l1));
});

test('levelSegments draws a wall wherever the topology has no passage', () => {
  const { cells } = generateTopology(4242);
  const segs = levelSegments(cells, 0);
  assert.ok(segs.length > 1000, `expected a dense level, got ${segs.length} segments`);
  // Every segment must correspond to a CLOSED passage - a segment across an
  // open one would draw a wall the player can walk through, which is the
  // worst possible lie for a navigation aid.
  let checked = 0;
  for (const s of segs.slice(0, 500)) {
    const horizontal = s.z0 === s.z1;
    const x = Math.min(s.x0, s.x1), z = Math.min(s.z0, s.z1);
    if (x >= MAZE.CELLS || z >= MAZE.CELLS) continue;
    const dir = horizontal ? DIR.N : DIR.W;
    assert.equal(isOpen(cells, cellIndex(x, z, 0), dir), false,
      `a segment at ${x},${z} crosses an OPEN passage - the map would draw a wall that is not there`);
    checked++;
  }
  assert.ok(checked > 100, `expected to verify many segments, checked ${checked}`);
});

test('levelSegments reads the level it is asked for', () => {
  const { cells } = generateTopology(4242);
  const a = levelSegments(cells, 0);
  const b = levelSegments(cells, 1);
  assert.notDeepEqual(a, b, 'two levels produced identical walls - the level argument is ignored');
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `node --test scripts/tests/maze-plan.test.mjs`
Expected: FAIL — `Cannot find module '.../MazePlan.js'`.

- [ ] **Step 3: Write `MazePlan.js`**

```js
/**
 * Pure map data - the cell array turned into things a canvas can draw.
 *
 * No DOM and no canvas, deliberately: both map surfaces (the `M` map and the
 * minimap's baked floorplan) need the same walls, and putting the derivation
 * here means it can be asserted under `node --test` instead of only being
 * looked at. Same division that lets the maze's collision gates run headless.
 */
import { MAZE, DIR, cellIndex, isOpen } from './MazeTopology.js';

/**
 * What makes a world's baked floorplan unique.
 *
 * `Minimap` caches baked plans, and cached them on `world.id` alone - which is
 * correct for the five worlds that are built once, and wrong for the maze,
 * which RE-ROLLS on every entry. The second visit was drawn with the first
 * visit's walls: a map of a maze that no longer exists.
 *
 * A world that is more than its id says so by exposing `minimapPlanKey`.
 * Nothing here knows what a maze is.
 */
export function planCacheKey(world) {
  return world?.minimapPlanKey ?? world?.id ?? world?.constructor?.id ?? 'unknown';
}

/**
 * Every hedge segment on one level, in CELL coordinates.
 *
 * A segment is emitted for a cell's north and west faces when that passage is
 * closed, plus the grid's own far edges - the same ownership rule
 * `districtColliders` uses, and for the same reason: emitting all four faces
 * per cell would draw every interior wall twice.
 */
export function levelSegments(cells, level) {
  const out = [];
  const N = MAZE.CELLS;
  for (let z = 0; z < N; z++) {
    for (let x = 0; x < N; x++) {
      const idx = cellIndex(x, z, level);
      if (!isOpen(cells, idx, DIR.N)) out.push({ x0: x, z0: z, x1: x + 1, z1: z });
      if (!isOpen(cells, idx, DIR.W)) out.push({ x0: x, z0: z, x1: x, z1: z + 1 });
      if (z === N - 1 && !isOpen(cells, idx, DIR.S)) out.push({ x0: x, z0: z + 1, x1: x + 1, z1: z + 1 });
      if (x === N - 1 && !isOpen(cells, idx, DIR.E)) out.push({ x0: x + 1, z0: z, x1: x + 1, z1: z + 1 });
    }
  }
  return out;
}
```

- [ ] **Step 4: Run the test**

Run: `node --test scripts/tests/maze-plan.test.mjs`
Expected: PASS.

- [ ] **Step 5: Use the key in `Minimap`**

In `src/ui/Minimap.js`, import `planCacheKey` and replace both cache sites:

```js
    const id = planCacheKey(world);
```

and the matching `this._cache.set(id, plan)`. **Both**, or the plan is looked up under one key and stored under another, which silently disables the cache instead of fixing it.

- [ ] **Step 6: Give `MazeWorld` a plan key**

In `src/worlds/MazeWorld.js`, alongside the existing `shaftMarkers` level tracking in `update()`:

```js
  /**
   * What makes this world's floorplan unique - see `planCacheKey`.
   *
   * Seed AND level. The seed because the maze re-rolls on every entry and a
   * cache keyed on `id` alone serves the previous run's walls; the level
   * because the map draws one level at a time and four of them share this id.
   */
  get minimapPlanKey() {
    return `maze:${this.seed}:${this._markersLevel ?? 0}`;
  }
```

- [ ] **Step 7: Prove the re-roll gate is not vacuous**

Temporarily change `planCacheKey` to `return world?.id ?? 'unknown';`. Run the file.

Expected: `THE RE-ROLL GATE` and the level test both FAIL. **Revert.** Record the failure message in the ledger.

- [ ] **Step 8: Run everything and commit**

```bash
npm test && node scripts/contract-check.mjs && npm run build
git add src/worlds/maze/MazePlan.js src/ui/Minimap.js src/worlds/MazeWorld.js scripts/tests/maze-plan.test.mjs
git commit -m "Key a baked floorplan on what actually makes it unique"
```

---

### Task 2: One `map` action, two consumers

**Files:**
- Modify: `src/core/Input.js` — `BINDABLE` (~line 43)
- Modify: `src/ui/MountWheel.js` — `_key` (~line 228)
- Create: `scripts/tests/maze-map-binding.test.mjs`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `BINDABLE` gains `{ action: 'map', code: 'KeyM', label: 'Map / mount wheel', group: 'Actions' }`.
  - `mapActionOwner(world) -> 'map' | 'mounts'` — exported from `src/worlds/WorldRules.js`. The single predicate both consumers read.

**Why a shared predicate rather than two independent checks.** The owner chose a contextual `M`, and the honest risk in that is two consumers disagreeing about who owns the key — either both opening, or neither. One exported function, imported by both, cannot disagree with itself. `MountWheel` currently is not gated by `rules.mounts` at all, so today `M` opens a mount wheel in the maze that can only report itself restricted.

- [ ] **Step 1: Write the failing test**

Create `scripts/tests/maze-map-binding.test.mjs`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BINDABLE } from '../../src/core/Input.js';
import { makeRules, mapActionOwner } from '../../src/worlds/WorldRules.js';

test('the map action is bindable, so the contextual key can still be rebound', () => {
  const entry = BINDABLE.find((b) => b.action === 'map');
  assert.ok(entry, 'no `map` action in BINDABLE - the key would be unrebindable');
  assert.equal(entry.code, 'KeyM');
});

test('exactly one owner of the map key per world, and it follows rules.mounts', () => {
  assert.equal(mapActionOwner({ rules: makeRules() }), 'mounts');
  assert.equal(mapActionOwner({ rules: makeRules({ mounts: false }) }), 'map');
});

test('a world with no rules at all still gets an answer', () => {
  // Never both, never neither - that is the whole point of one predicate.
  for (const w of [null, undefined, {}, { rules: null }]) {
    assert.ok(['map', 'mounts'].includes(mapActionOwner(w)), `no owner for ${JSON.stringify(w)}`);
  }
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `node --test scripts/tests/maze-map-binding.test.mjs`
Expected: FAIL — `mapActionOwner is not exported`.

- [ ] **Step 3: Add the predicate and the binding**

In `src/worlds/WorldRules.js`:

```js
/**
 * Who owns the `map` key in this world.
 *
 * `M` is contextual by the owner's ruling: the maze's map where mounts are
 * forbidden, the mount wheel everywhere else. The risk in a contextual key is
 * two consumers disagreeing about whose it is - both opening, or neither - so
 * there is ONE predicate and both import it. It cannot disagree with itself.
 *
 * Defaults to `mounts` for anything without rules, because that is what every
 * world did before the maze existed.
 */
export function mapActionOwner(world) {
  return world?.rules?.mounts === false ? 'map' : 'mounts';
}
```

In `src/core/Input.js`'s `BINDABLE`, after the `chat` entry:

```js
  { action: 'map', code: 'KeyM', label: 'Map / mount wheel', group: 'Actions' },
```

The label names both on purpose: one key, two meanings, and the rebinding panel should not pretend otherwise.

- [ ] **Step 4: Gate `MountWheel` on it**

In `MountWheel._key`, immediately after the modifier check:

```js
    /* Not this world's key. `mapActionOwner` is shared with MazeMap so the two
     * can never both claim it, or both ignore it. Before this, `M` opened a
     * mount wheel in the maze whose only possible answer was that mounts are
     * restricted here. */
    if (mapActionOwner(this.worldManager?.active) !== 'mounts') return;
```

`MountWheel`'s constructor takes `{ root, bus, input, mounts }`; add `worldManager` to it and to its construction site.

- [ ] **Step 5: Run the tests, then the suite**

Run: `node --test scripts/tests/maze-map-binding.test.mjs && npm test`
Expected: PASS.

- [ ] **Step 6: Prove the gate is not vacuous**

Temporarily make `mapActionOwner` return `'mounts'` unconditionally and confirm the second test fails. **Revert.**

- [ ] **Step 7: Commit**

```bash
git add src/core/Input.js src/worlds/WorldRules.js src/ui/MountWheel.js scripts/tests/maze-map-binding.test.mjs
git commit -m "One predicate decides who owns M, so both consumers cannot disagree"
```

---

### Task 3: `MazeMap.js` — the level you are standing in

**Files:**
- Create: `src/ui/MazeMap.js`
- Create: `src/ui/maze-map.css`
- Modify: `src/main.js` — construct it, wire the key
- Modify: `scripts/contract-check.mjs` — register the new module

**Interfaces:**
- Consumes: `levelSegments`, `mapActionOwner`.
- Produces: `new MazeMap({ root, bus, input, worldManager })` with `open()`, `close()`, `toggle()`, `isOpen`.

**What it draws.** The player's current level only, from `cells`, at 2 px per cell — an 800 × 800 canvas for a 400 × 400 level. Rendered **once per level and cached**, then panned and zoomed as an image; re-rasterising 160,000 cells per frame would be absurd and the spec says once.

**NO YOU-ARE-HERE MARKER.** The player gets the shape of the level and must locate themselves by matching the junctions around them against the drawing. This is the central navigational challenge and the reason a map does not trivialise a maze this size. It is also the single most likely thing for a future contributor to add "helpfully", so Task 5 ships a test that fails if a player position ever reaches this module.

- [ ] **Step 1: Write the failing test**

Append to `scripts/tests/maze-map-binding.test.mjs`:

```js
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

test('THE NO-MARKER GATE: MazeMap never reads a player position', async () => {
  /* The map deliberately does not say where you are - spec section 7, and the
   * reason the map does not trivialise a 2.4 km maze. It is also exactly the
   * kind of thing someone adds to be helpful, so this asserts the ingredient
   * is absent rather than trusting a comment. */
  const src = await readFile(path.join(root, 'src/ui/MazeMap.js'), 'utf8');
  for (const forbidden = of [/player\s*\.\s*position/, /playerSpawn/, /youAreHere/i, /\bmarker\b/i]) {
    assert.ok(!forbidden.test(src),
      `MazeMap.js mentions ${forbidden} - the map must not show where the player is`);
  }
});
```

Fix that loop header when transcribing — it is `for (const forbidden of [...])`. It is written here as a reminder that this file is transcribed, not generated.

- [ ] **Step 2: Run it and watch it fail**

Expected: FAIL — `ENOENT`, no `MazeMap.js`.

- [ ] **Step 3: Write `MazeMap.js`**

Follow the shape of `src/ui/KeybindMenu.js` for overlay lifecycle and `Minimap.js` for canvas handling. The essentials:

```js
/**
 * The `M` map - the level you are standing in, and nothing else.
 *
 * Drawn from `world.cells` via `levelSegments`, never from geometry: the spec
 * makes the topology array the single source of truth for the map, and the
 * geometry only exists for the districts that happen to be streamed in.
 *
 * NO YOU-ARE-HERE MARKER. See `scripts/tests/maze-map-binding.test.mjs`.
 */
export class MazeMap {
  constructor({ root, bus, input, worldManager }) { /* ... */ }

  /**
   * Rasterise one level once, at MAP_PX_PER_CELL, and keep it.
   *
   * Keyed on seed AND level for the same reason `minimapPlanKey` is: the maze
   * re-rolls, and a cache that ignores the seed draws the previous run.
   */
  _render(level) {
    const w = this.worldManager.active;
    const key = `${w.seed}:${level}`;
    if (this._bakedKey === key) return this._baked;

    const px = MAP_PX_PER_CELL;
    const cv = document.createElement('canvas');
    cv.width = MAZE.CELLS * px;
    cv.height = MAZE.CELLS * px;
    const c = cv.getContext('2d');
    c.fillStyle = MAP_BG;
    c.fillRect(0, 0, cv.width, cv.height);
    c.strokeStyle = MAP_WALL;
    c.lineWidth = Math.max(1, px * 0.5);
    c.lineCap = 'square';
    c.beginPath();
    for (const s of levelSegments(w.cells, level)) {
      c.moveTo(s.x0 * px, s.z0 * px);
      c.lineTo(s.x1 * px, s.z1 * px);
    }
    c.stroke();

    this._baked = cv;
    this._bakedKey = key;
    return this._baked;
  }
}
```

Pan with drag, zoom with the wheel, clamped so the level cannot be lost off-screen. `Escape` and `M` both close.

- [ ] **Step 4: Wire it in `main.js` and register it**

Construct alongside the other UI, and open it when the bound `map` code fires **and** `mapActionOwner(world) === 'map'`. Add `src/ui/MazeMap.js` to `scripts/contract-check.mjs` with its exports.

- [ ] **Step 5: Run everything**

Run: `npm test && node scripts/contract-check.mjs && npm run build`

- [ ] **Step 6: Commit**

```bash
git add src/ui/MazeMap.js src/ui/maze-map.css src/main.js scripts/
git commit -m "Draw the level you are standing in, and refuse to say where you are on it"
```

---

### Task 4: Hold `L` to leave

**Files:**
- Create: `src/worlds/maze/MazeAbandon.js`
- Create: `scripts/tests/maze-abandon.test.mjs`
- Modify: `src/worlds/MazeWorld.js` — drive it from `update(dt)`
- Modify: `src/main.js` — perform the world switch

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `ABANDON_HOLD_S = 2.0`
  - `class AbandonHold` with `update(dt, held) -> { progress: number, fired: boolean }`

**Why a hold and not a press.** The spec: a player 4 km deep must not be stranded, and the control must not be fumbled mid-run. A hold cannot be hit by accident; a press can.

**Why a pure class.** The timing is the only part worth asserting, and it asserts in milliseconds under Node instead of by holding a key in a browser.

- [ ] **Step 1: Write the failing test**

Create `scripts/tests/maze-abandon.test.mjs`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AbandonHold, ABANDON_HOLD_S } from '../../src/worlds/maze/MazeAbandon.js';

const STEP = 1 / 60;

test('a full hold fires exactly once, at the stated time', () => {
  const h = new AbandonHold();
  let fired = 0, elapsed = 0;
  for (let i = 0; i < 300; i++) {
    const r = h.update(STEP, true);
    elapsed += STEP;
    if (r.fired) { fired++; assert.ok(Math.abs(elapsed - ABANDON_HOLD_S) < 0.05, `fired at ${elapsed}s`); }
  }
  assert.equal(fired, 1, 'a held key must fire once, not once per frame');
});

test('releasing early resets, so a fumble costs nothing', () => {
  const h = new AbandonHold();
  for (let i = 0; i < 60; i++) assert.equal(h.update(STEP, true).fired, false);
  assert.equal(h.update(STEP, false).progress, 0, 'progress survived a release');
  for (let i = 0; i < 60; i++) assert.equal(h.update(STEP, true).fired, false,
    'the second hold inherited the first one - a fumble plus a tap would abandon the run');
});

test('progress runs 0 to 1 so the HUD can draw it', () => {
  const h = new AbandonHold();
  const seen = [];
  for (let i = 0; i < 130; i++) seen.push(h.update(STEP, true).progress);
  assert.equal(seen[0] > 0, true);
  assert.ok(Math.max(...seen) <= 1.0001, 'progress exceeded 1');
  for (let i = 1; i < 100; i++) assert.ok(seen[i] >= seen[i - 1], 'progress went backwards while held');
});
```

- [ ] **Step 2: Run it and watch it fail**

Expected: FAIL — module not found.

- [ ] **Step 3: Write `MazeAbandon.js`**

```js
/**
 * Hold-to-abandon, as pure timing.
 *
 * The spec's hard constraint is that a player 4 km deep must never be
 * stranded, and that the control must not be fumbled mid-run - hence a hold
 * rather than a press. Kept free of input and DOM so the timing can be
 * asserted in milliseconds under Node rather than by holding a key.
 */
export const ABANDON_HOLD_S = 2.0;

export class AbandonHold {
  constructor(seconds = ABANDON_HOLD_S) {
    this.seconds = seconds;
    this._t = 0;
    this._fired = false;
  }

  /**
   * @param {number} dt seconds
   * @param {boolean} held is the key down this frame
   * @returns {{progress: number, fired: boolean}} `fired` is true on exactly
   *   the frame the hold completes, never afterwards while still held.
   */
  update(dt, held) {
    if (!held) { this._t = 0; this._fired = false; return { progress: 0, fired: false }; }
    this._t += dt;
    const progress = Math.min(1, this._t / this.seconds);
    const fired = progress >= 1 && !this._fired;
    if (fired) this._fired = true;
    return { progress, fired };
  }
}
```

- [ ] **Step 4: Run the tests**

Expected: PASS.

- [ ] **Step 5: Drive it from the world, act in `main.js`**

In `MazeWorld.update(dt)`, next to the lift stepping:

```js
    const holding = this.ctx.input?.down?.('abandon') === true;
    const { progress, fired } = this._abandon.update(dt, holding);
    if (progress !== this._abandonShown) {
      this._abandonShown = progress;
      this.bus?.emit('maze:abandon-progress', { progress });
    }
    if (fired) this.bus?.emit('maze:abandon', {});
```

Add `{ action: 'abandon', code: 'KeyL', label: 'Hold to leave the maze', group: 'Actions' }` to `BINDABLE`. In `main.js`, `bus.on('maze:abandon', ...)` switches to `station` — the world switch lives there because `main.js` is the single integration point, exactly as `maze:token-found` already is.

- [ ] **Step 6: Run everything and commit**

```bash
npm test && node scripts/contract-check.mjs && npm run build
git add src/worlds/maze/MazeAbandon.js src/worlds/MazeWorld.js src/core/Input.js src/main.js scripts/tests/maze-abandon.test.mjs
git commit -m "Hold L to leave, from anywhere, at any depth"
```

---

### Task 5: The centre pays, and opens a way home

**Files:**
- Modify: `src/worlds/MazeWorld.js` — centre pickup, return portal
- Modify: `src/main.js` — award the credits
- Modify: `scripts/tests/maze-populate.test.mjs` (append)

**Interfaces:**
- Consumes: `this.centreCell`, the existing `_buildCentreStack`.
- Produces:
  - `MAZE_CENTRE_VALUE = 100`
  - `maze:centre-found` on the bus, `{ amount: 100 }`
  - a second entry in `portalSpecs`, at the centre, target `station`

**The reward is 100 and is not scaled.** The spec says so twice, and calls it final rather than a placeholder.

**Why the portal opens rather than existing.** The walk out must not be forced, but a portal standing at the centre from the start would let a player skip the maze entirely by walking to a place they cannot find. It appears on collection.

- [ ] **Step 1: Write the failing test**

Append to `scripts/tests/maze-populate.test.mjs`:

```js
test('the centre is worth exactly 100 credits, and it is not scaled by anything', () => {
  assert.equal(MAZE_CENTRE_VALUE, 100);
});

test('the return portal is not there until the centre is collected', async () => {
  const { world } = await buildMazeWorld();
  assert.equal(world.portalSpecs.length, 1, 'a second portal exists before the centre is taken');
  world._collectCentre();
  assert.equal(world.portalSpecs.length, 2, 'collecting the centre opened no way home');
  const home = world.portalSpecs[1];
  assert.equal(home.target, 'station');
  const c = cellCoords(world.centreCell);
  const w = cellToWorld(c.x, c.z, c.level);
  assert.ok(Math.hypot(home.position.x - w.x, home.position.z - w.z) < MAZE.CELL,
    'the return portal did not open at the centre');
});

test('collecting twice pays once', async () => {
  // A pickup radius is tested every frame, so paying per frame would be 100
  // credits per sixtieth of a second.
  const { world } = await buildMazeWorld();
  let paid = 0;
  world.bus = { emit: (e, p) => { if (e === 'maze:centre-found') paid += p.amount; } };
  world._collectCentre();
  world._collectCentre();
  assert.equal(paid, MAZE_CENTRE_VALUE, `paid ${paid} - the centre is payable more than once`);
  assert.equal(world.portalSpecs.length, 2, 'a second collection opened a second portal');
});
```

- [ ] **Step 2: Run it and watch it fail**

Expected: FAIL — `MAZE_CENTRE_VALUE is not exported`.

- [ ] **Step 3: Implement the pickup and the portal**

In `MazeWorld`, mirror the dead-end token pickup exactly — same radius test, same "announce, never award" rule:

```js
/** The centre's reward. 100, final, not scaled by maze size or time (spec section 6). */
export const MAZE_CENTRE_VALUE = 100;
```

`_collectCentre()` hides the stack, pushes the return portal spec, and emits `maze:centre-found`. Guard on a `_centreTaken` flag so a pickup radius tested every frame pays once.

- [ ] **Step 4: Award it in `main.js`**

```js
bus.on('maze:centre-found', ({ amount }) => {
  economy.add(amount, 'maze-centre');
  hud?.notify?.(`+${amount} CR — the centre`, 'loot');
});
```

- [ ] **Step 5: Run everything and commit**

```bash
npm test && MAZE_SEEDS=1000 npm test && node scripts/contract-check.mjs && npm run build
git add src/worlds/MazeWorld.js src/main.js scripts/tests/maze-populate.test.mjs
git commit -m "Pay the centre, and open a way home from it"
```

---

### Task 6: Prove it in the browser

- [ ] **Step 1:** `mazeStats()` gains `mapOpen`, `centreTaken`, `abandonProgress`.
- [ ] **Step 2:** Drive `?dev=1` via Chrome DevTools MCP: open the map on each of the four levels and screenshot; confirm it redraws after a re-roll rather than serving the previous run's walls (**the bug Task 1 fixes — verify it in the real app, not only in the unit test**).
- [ ] **Step 3:** Hold `L`, confirm the return to the station and that a fumbled hold does nothing.
- [ ] **Step 4:** Teleport to the centre, collect, confirm 100 credits and a working return portal.
- [ ] **Step 5:** Ten entries, programs flat — the same shader gate Phase 2c measured at 383 and unchanged.
- [ ] **Step 6:** Record findings in the ledger and commit.

---

## Phase 3 exit criteria

- [ ] `npm test` and `MAZE_SEEDS=1000 npm test` pass; contract-check exits 0; build succeeds.
- [ ] A re-rolled maze draws its NEW walls on both map surfaces.
- [ ] `M` opens the map in the maze and the mount wheel elsewhere, and rebinding it moves both.
- [ ] The map shows no player position — asserted, not merely intended.
- [ ] Hold-`L` returns the player to the station from any level; a partial hold does nothing.
- [ ] The centre pays exactly 100 once and opens a return portal at the centre.
- [ ] Shader programs still flat across ten entries.

## What Phase 3 knowingly does not do

- **No puzzles.** §8's counterweight lift mechanism exists as a connector; the puzzle framing around it, the rotating bridges, plates and one-way gates are a later phase — including the graph validation that one-way gates require.
- **No art pass.** The deferred well-floor daylight and the general dimness of levels 0–2, which are roofed by the floor above, stay open.
- **No tunnel redesign.** Tunnels remain rare (~5 per maze) for the reason Phase 2c's ledger records.
