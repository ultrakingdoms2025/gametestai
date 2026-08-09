# Maze World — Phase 5: The Art Pass

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn flat dark-green boxes into the overgrown stone garden §10 describes — lit, textured, foliaged and footed in weathered stone — without adding a single shader program.

**Architecture:** Everything hangs off two facts. First, `LightRig` claims every light in the scene each frame and copies the best few into **fixed slots**, so authored lights are free and the maze can finally be lit. Second, materials are built once in `MazeWorld._ensureMaterials` and reused across every re-roll and every streamed chunk — so texture and wind go onto those cached materials via `onBeforeCompile`, never into per-chunk allocations.

**Tech Stack:** Three.js 0.185.1, Vite 8, vanilla ES modules. Procedural textures via the project's own `src/gfx/Textures.js`. Tests use Node's built-in `node:test` — **no new dependencies**.

## Global Constraints

- **The shader program count must not grow.** Measured flat at 383–385 across ten entries in Phases 2c and 3, and it is the highest-risk detail in the whole feature per §13.
- **Materials are built once and cached.** A per-chunk or per-re-roll material allocation is a task failure — it re-triggers the compilation that already dominates cold boot.
- **Foliage is non-collidable.** §2 permits props in the 0.45–5.0 m band only if non-collidable, and foliage is the example it gives. Foliage is **mesh only** and must never reach the collider descriptor path.
- **No new npm dependencies. No external texture files.** Textures are generated, like the rest of the project's.
- **`MazeWorld` keeps its existing gates green:** the anti-ladder scan, the enclosure proof, the perforation gate. Art must not move a collider.

## The finding this phase is built on, and the three comments it corrects

`src/gfx/LightRig.js` owns a **fixed** set of slot lights. Every other light in the scene is a *source*: `_walk` runs each frame, sets `visible = false` on any light it finds, and copies the best-scoring few into the slots. The counts baked into every shader cache key are therefore constant no matter how many lights a world authors — the station authors 65.

Three commits in Phases 2b and 2c say the opposite. They claim a per-shaft lamp is impossible because "a changing light count is what cost 250 s of shader recompilation", and on that basis the shafts got emissive materials instead of light. **That was a misreading of this file.** The emissive treads were still a reasonable answer, but the reason given for them was wrong, and it ruled out the fix for the maze's biggest visual problem — levels 0–2 are roofed by the floor above and are simply dark.

**One nuance that is real:** a light is only claimed on the next `_walk`. A light created `visible = true` inside a streamed chunk would be counted for one frame and could trigger a compile. So **every light this phase creates starts `visible = false`.** The rig picks it up as a source regardless; it just never has a frame where it counts.

## File structure

| File | Responsibility |
|---|---|
| `src/worlds/maze/MazeFoliage.js` | **New.** Pure-ish: where sprigs go on a hedge, as instance transforms. No THREE. |
| `src/worlds/maze/MazeChunks.js` | Builds foliage and lantern instances per district; disposes them with the chunk. |
| `src/worlds/MazeWorld.js` | The cached materials, their textures, the wind shader hook. |
| `src/gfx/Textures.js` | Reused as-is for the hedge and stone maps. |

---

### Task 1: Light the maze

**Files:**
- Modify: `src/worlds/maze/MazeChunks.js` — a lantern per district
- Modify: `src/worlds/MazeWorld.js` — the lantern material
- Create: `scripts/tests/maze-lighting.test.mjs`

**Interfaces:**
- Produces: `MazeChunks` adds one `THREE.PointLight` per resident district, created `visible = false`, disposed with the chunk.

**Why one per district and not one per cell.** A district is 120 m square; the rig scores by delivered light near the camera and only the nearest few ever occupy a slot. One authored light per district is ~25 sources at full residency, of which the rig uses its budget — the station proves the pattern at 65.

- [ ] **Step 1: Write the failing test**

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

test('every light the maze creates starts hidden, so it never counts for a frame', async () => {
  /* LightRig claims lights on its next `_walk` and the count in every shader
   * cache key is fixed - but a light created VISIBLE inside a streamed chunk
   * is counted for the frame between its creation and that walk, which is
   * enough to compile. Creating them hidden costs nothing: the rig takes them
   * as sources either way. */
  const src = await readFile(path.join(root, 'src/worlds/maze/MazeChunks.js'), 'utf8');
  const lights = [...src.matchAll(/new THREE\.\w*Light\(/g)];
  assert.ok(lights.length > 0, 'MazeChunks creates no lights at all');
  assert.ok(/visible\s*=\s*false/.test(src),
    'MazeChunks creates a light without setting visible = false - it will be counted for one frame');
});

test('the maze disposes its lights with the chunk that owns them', async () => {
  const src = await readFile(path.join(root, 'src/worlds/maze/MazeChunks.js'), 'utf8');
  assert.ok(/lantern[\s\S]{0,400}remove\(/.test(src) || /remove\([\s\S]{0,80}lantern/.test(src),
    'no path removes a district lantern - 25 resident districts would leak lights across a walk');
});
```

- [ ] **Step 2: Run and watch it fail.** Expected: "creates no lights at all".

- [ ] **Step 3: Add a lantern per district in `ensure()`**

Position it at the district's centre, at hedge height, `distance` bounded to the district so the rig's scoring is meaningful:

```js
    /* One authored light per district. LightRig claims it on the next frame
     * and only the nearest few ever occupy a slot, so the shader light count
     * is unchanged - see this file's header note and LightRig's own. Created
     * HIDDEN: the rig would hide it anyway, but not until its next walk, and a
     * light that is visible for one frame is a light that can compile. */
    const lantern = new THREE.PointLight(LANTERN_COLOUR, LANTERN_INTENSITY, LANTERN_RANGE);
    lantern.visible = false;
    lantern.position.set(cx, baseY + MAZE.HEDGE_HEIGHT * 0.8, cz);
    this.group.add(lantern);
```

Store it on the resident entry and `group.remove` it in `drop`/`disposeAll` beside the meshes.

- [ ] **Step 4: Run the tests, then the suite.**

- [ ] **Step 5: Measure in the browser — this is the step that matters.**

Ten entries via `?dev=1`; `renderer.info.programs.length` must be **flat**. If it grows, the lantern is being counted and the whole premise of this task is wrong — report it rather than tuning it away.

- [ ] **Step 6: Commit.**

---

### Task 2: A hedge that looks like a hedge

**Files:**
- Modify: `src/worlds/MazeWorld.js` — `_ensureMaterials`

**Interfaces:**
- Consumes: `makeNoiseTexture` from `src/gfx/Textures.js`.
- Produces: the cached `hedge` material gains a colour map, a normal map and per-instance colour variation.

**The one rule.** These textures are generated **once**, in `_ensureMaterials`, which is already the cache. Generating a texture per chunk would be worse than a material per chunk.

- [ ] **Step 1: Write the failing test**

```js
test('the maze generates its textures once, not per chunk or per re-roll', async () => {
  const chunks = await readFile(path.join(root, 'src/worlds/maze/MazeChunks.js'), 'utf8');
  for (const forbidden of [/makeNoiseTexture/, /new THREE\.\w*Texture\(/, /new THREE\.Mesh\w*Material\(/]) {
    assert.ok(!forbidden.test(chunks),
      `MazeChunks builds ${forbidden} per chunk - textures and materials are cached in MazeWorld._ensureMaterials`);
  }
});
```

- [ ] **Step 2: Run it** — it should PASS already, and that is the point: it is a tripwire against this task's most likely mistake, not a red-then-green.

State that in the test so nobody deletes it as trivial.

- [ ] **Step 3: Give the hedge material maps**

In `_ensureMaterials`, before the material literals, build the maps once and reuse:

```js
    /* Generated once per material set - which is once per session, since the
     * set is cached and reused across every re-roll. See the class docstring:
     * a texture allocated per chunk would be worse than a material per chunk. */
    const hedgeMap = makeNoiseTexture({ size: 256, scale: 5.5, contrast: 1.35, name: 'maze.hedge' });
    hedgeMap.wrapS = hedgeMap.wrapT = THREE.RepeatWrapping;
    hedgeMap.repeat.set(3, 2);
```

Apply as `map` on `hedge`, and a second, coarser one on `floor`.

- [ ] **Step 4: Look at it in the browser.** A texture that reads as noise rather than foliage at 4 m is a fail; adjust scale and contrast against a screenshot, not against intuition.

- [ ] **Step 5: Commit.**

---

### Task 3: Foliage, and stone footings

**Files:**
- Create: `src/worlds/maze/MazeFoliage.js`
- Modify: `src/worlds/maze/MazeChunks.js`
- Modify: `src/worlds/MazeWorld.js`
- Create: `scripts/tests/maze-foliage.test.mjs`

**Interfaces:**
- Produces:
  - `foliageTransforms(cells, dx, dz, level) -> Array<{x,y,z,ry,s}>` — pure, hashed, one entry per sprig.
  - `MazeChunks` builds them as a single `InstancedMesh` per district on the cached `foliage` material.

**Foliage never becomes a collider.** §2 allows props in the band only if non-collidable, and this is the example it names. The test asserts the descriptor path never sees it.

**Stone footings** are the one piece of new *collidable* geometry, and they are deliberately **below the auto-step**: a 0.3 m plinth at a hedge's base is walked over, not climbed, so it cannot enter the band.

- [ ] **Step 1: Write the failing tests**

```js
test('foliage never reaches the collider path', () => {
  /* Section 2 permits props in the 0.45-5.0m band only if non-collidable, and
   * names foliage as the example. If a sprig ever became a descriptor it would
   * be a ladder over a hedge, and THE ANTI-LADDER GATE would be right to fail. */
  const { cells } = generateTopology(2026);
  for (const d of districtColliders(cells, 3, 3, 0)) {
    assert.notEqual(d.kind, 'foliage', 'a foliage descriptor reached districtColliders');
  }
});

test('a stone footing is below the auto-step, so it is walked over and not climbed', () => {
  const { cells } = generateTopology(2026);
  const footings = districtColliders(cells, 3, 3, 0).filter((d) => d.kind === 'footing');
  assert.ok(footings.length > 0, 'no footings emitted');
  const floorY = 0;
  for (const f of footings) {
    const top = (f.cy + f.hy) - floorY;
    assert.ok(top <= MAZE.STEP_HEIGHT + 1e-6,
      `a footing tops out at ${top.toFixed(3)}m, above the ${MAZE.STEP_HEIGHT}m auto-step - it is a step, `
      + 'and a step at a hedge base is the first rung of a ladder');
  }
});

test('foliage is deterministic and re-rolls with the seed', () => {
  const a = foliageTransforms(generateTopology(7).cells, 2, 2, 0);
  const b = foliageTransforms(generateTopology(7).cells, 2, 2, 0);
  const c = foliageTransforms(generateTopology(8).cells, 2, 2, 0);
  assert.deepEqual(a, b);
  assert.notDeepEqual(a, c);
  assert.ok(a.length > 50, `only ${a.length} sprigs in a district - too sparse to read as overgrown`);
});
```

- [ ] **Step 2: Run and watch them fail.**

- [ ] **Step 3: Implement `foliageTransforms`, the footing descriptors, and the instanced build.**

Sprigs sit on hedge tops and along their sides, hashed per cell so they re-roll. One `InstancedMesh` per district on the cached material, disposed with the chunk exactly as the hedge instances are.

- [ ] **Step 4: Add the wind, on the cached material**

`onBeforeCompile` on the **cached** foliage material, driven by one shared uniform updated per frame. Not a `ShaderMaterial` per chunk, and not a material per district — either would undo Task 2's whole premise.

- [ ] **Step 5: Run everything, including `MAZE_SEEDS=1000 npm test`.**

- [ ] **Step 6: Commit.**

---

### Task 4: Prove it in the browser

- [ ] **Step 1:** Screenshot a corridor at ground level, before and after, on the same seed.
- [ ] **Step 2:** Ten entries, `programs.length` flat. **This is the gate the whole phase risks.**
- [ ] **Step 3:** Frame rate while walking, against the project's existing budget.
- [ ] **Step 4:** Confirm the anti-ladder, enclosure and perforation gates are still green — art must not have moved a collider.
- [ ] **Step 5:** Record findings in the ledger, including the LightRig correction, and commit.

---

## Phase 5 exit criteria

- [ ] `npm test` and `MAZE_SEEDS=1000 npm test` pass; contract-check exits 0; build succeeds.
- [ ] **Shader programs flat across ten entries** — the phase's central risk.
- [ ] No material or texture is allocated per chunk or per re-roll.
- [ ] Foliage never appears in a collider descriptor.
- [ ] Every footing is below the auto-step.
- [ ] A corridor at ground level reads as an overgrown stone garden rather than as boxes.

## What Phase 5 knowingly does not do

- **No god-rays and no drifting pollen.** §10 asks for both; both are post-processing and particle work that belongs after the surfaces read correctly.
- **No ivy on the tower shafts.** The shafts got their pale stone and emissive treads in Phase 2b; dressing them further is worth its own pass.
- **The well-floor daylight stays open.** ~1.2 m² of visible gap per shaft, recorded in 2b's ledger — it is a geometry fix, not an art one.
