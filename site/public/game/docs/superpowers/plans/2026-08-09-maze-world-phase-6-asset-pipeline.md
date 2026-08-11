# Maze World — Phase 6: The Asset Pipeline

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop the maze being made of boxes. Every visible surface in this world today is one of two `BoxGeometry` instances; the spiral staircase is 23 box slabs on a helix. Phase 6 replaces the *visual* layer with authored geometry, real PBR surfaces and an LOD/BatchedMesh budget that survives a 2.4 km, four-level world — **without moving a single collider**, because the collider descriptors are the thing the entire safety argument of Phases 1–5 is proved against.

---

## Architecture

Three facts decide the whole shape of this phase.

**1. There is one contract, and it is not negotiable.** `districtColliders` returns plain-number box descriptors. `MazeChunks.ensure` turns each descriptor into *both* a physics box *and* an instance matrix, in one loop, paired by construction. That single derivation is what lets the enclosure proof, the anti-ladder band scan, the perforation gate and the containment flood-fill run headless in Node with no renderer, and it is why 327 tests can assert on geometry that has never been drawn. Phase 6 therefore adds a **visual layer on top of the descriptors** and changes nothing about them. The collider loop in `ensure` is not touched by any task in this plan. If a task finds itself editing `MazeColliders.js` or `MazeShafts.js` to make art work, the task is wrong.

**2. A descriptor is a box in world space, so a prefab must be authored to fit inside one.** The unlock for this phase is a single rule: **a prefab built for half-extents `(hx, hy, hz)` has a bounding box contained in `[-hx,hx] × [-hy,hy] × [-hz,hz]`, and the instance matrix carries translation only — never scale.** A visual that is a subset of its collider can never create a standable surface the headless gates did not see, so every proof in the repo survives by construction rather than by re-running. The bevels, nosings and mouldings all live *inside* the box, and the flat faces sit exactly on the box planes so abutting hedge segments still meet with no gap.

Dropping the scale from the instance matrix is what makes bevels possible at all. Today `buildBoxInstances` scales a unit cube by `2h`, so a 0.04 m chamfer authored on a unit cube would come out 0.19 m wide on a hedge's long axis and 0.02 m on its thin one. Instead the registry caches **one geometry per (kind, extent class, LOD)**. The maze has very few distinct box sizes — a hedge segment, a floor tile, a tread, a shaft wall — so this is a handful of geometries for the entire world, and that bound is asserted rather than assumed.

**3. Fidelity is paid for by batching, not by budget.** Bevelling a hedge segment takes it from 12 triangles to ~60. At ~800 segments per district × 25 resident districts that is 1.2 M triangles for hedges alone, which is the world's *entire current* triangle count. So `BatchedMesh` and `LOD` — already open item #1 in the outstanding-work memo, absorbed here rather than duplicated — are not a follow-up optimisation. They are the thing that makes the art affordable, and they are also the thing that takes draw calls *down* from today's 214–420 while fidelity goes up. The arithmetic is in Global Constraints and it is the reason the task order is what it is.

### The layer diagram

```
MazeTopology.js ──> MazeColliders.js / MazeShafts.js ──> ColliderDesc[]   (UNCHANGED)
                                                             │
                                    ┌────────────────────────┴────────────────────────┐
                                    │                                                 │
                            physics.addBox(...)                         MazeMeshes.prefabFor(desc, lod)
                            (authoritative)                                           │
                                                                          MazeBatches.addInstance(...)
                                                                                      │
                                                                          MazeMaterials.forKind(kind)
```

Everything new hangs off the right-hand branch. The left-hand branch is frozen.

---

## Tech Stack

Three.js 0.185.1, Vite 8, vanilla ES modules. `node:test` for the suite.

New at runtime, all of it shipped **inside the installed `three` package** so the dependency count does not move:

- `three/examples/jsm/loaders/GLTFLoader.js`
- `three/examples/jsm/loaders/KTX2Loader.js` + the Basis transcoder from `three/examples/jsm/libs/basis/`
- `three/examples/jsm/loaders/DRACOLoader.js` + the decoder from `three/examples/jsm/libs/draco/` (only if a meshopt-free path is needed; prefer `meshopt` via glTF extension if the installed `three` ships the decoder — verify in Task 8 Step 1, do not assume)
- `THREE.BatchedMesh`, `THREE.LOD` — core, zero import cost

New at **build time only**, and only if Stage C is entered: `gltf-transform` or the KTX-Software CLI (`toktx`), run by hand or from `scripts/`, output committed as binaries. These must never reach `dependencies`. Compressing assets is an authoring step, not a runtime one.

---

## Global Constraints

### Which Phase 5 constraints are relaxed, and what replaces them

Phase 5 was written under two rules that Phase 6 exists to revisit. Neither is dropped without a replacement, because both were guarding something real.

| Phase 5 rule | Status | What replaces it as the gate |
|---|---|---|
| *"The shader program count must not grow."* Measured flat at 383–385 across ten entries. | **Relaxed.** PBR maps and vertex colours change a material's program cache key by construction; freezing the count would forbid the phase outright. | **A declared, enumerated budget plus a flatness invariant.** `MAZE_PROGRAM_FAMILIES` in `MazeMaterials.js` lists every distinct material feature-set the maze compiles. A Node test asserts the material set produces no more distinct fingerprints than that list. The browser gate becomes: `renderer.info.programs.length` ≤ **420** at full residency, and **the delta between entry 3 and entry 10 must be exactly 0**. Flatness — not the absolute number — is what actually detects the failure mode (a material or texture allocated per chunk or per re-roll). See Task 3. |
| *"No new npm dependencies. No external texture files."* | **Partly relaxed.** No new npm **runtime** dependencies, still. External *files* become permitted, but only under Stage C, only from `public/assets/maze/`, and only with a licence recorded. | **A manifest and a licence ledger.** `MazeAssets.js` loads only what `assets/maze/manifest.json` declares; a Node test asserts every manifest entry has a `licence` field drawn from an allow-list (`CC0-1.0`, `CC-BY-4.0` with attribution present, or `proprietary-owned`). An asset with no licence line fails the suite. A missing *file* must degrade to the procedural prefab, never throw. |
| *"Materials are built once and cached."* | **Kept, and strengthened.** | The tripwire test in `maze-lighting.test.mjs` stays. It gains a sibling for geometry: `MazeChunks` must not construct a `BufferGeometry` subclass either, since the prefab registry now owns that. |
| *"Foliage is non-collidable."* | **Kept verbatim.** | Unchanged. Dressing prefabs (foliage, ivy, candles, plates) are exempt from the fit contract *because* they never reach the descriptor path — and that exemption is spelled out as `dressing: true` in the registry rather than implied. |
| *"`MazeWorld` keeps its existing gates green."* | **Kept, and it is the phase's revert signal.** | The 327 tests assert on descriptors. Descriptors do not change. Therefore **any** test in the suite going red during Phase 6 means the layer separation has been broken, and the correct response is to revert the task, not to edit the test. |

### Budgets

Measured baseline, and not to be re-derived: ~182 fps, 3.9 ms/frame, 214–420 draw calls, 1.2–2.5 M triangles, 8606 colliders, 385 programs.

**Draw calls — target ≤ 120 standing in a corridor at full residency, ≤ 180 from the top of a tower.** Lower than today, despite the extra geometry. Today's cost is structural: `ensure` builds up to ~14 `InstancedMesh` per district × 25 districts. One `BatchedMesh` per *material family*, with per-district instance ranges, collapses that to roughly one draw per family (Task 6).

**Triangles — target ≤ 3.5 M at ground level, ≤ 5 M from a tower.** The arithmetic that makes this work, and the reason LOD is a task rather than a nicety:

| | tris/instance | instances (25 districts) | total |
|---|---|---|---|
| Hedge, LOD0 bevelled, everywhere | 60 | 20,000 | 1.2 M |
| Hedge, LOD0 within 25 m only (~1 district) | 60 | 800 | 48 k |
| Hedge, LOD1 box + normal map, 25–80 m | 12 | 19,200 | 230 k |
| Stair treads, 23 per shaft × ~4 resident shafts | 200 | 92 | 18 k |

LOD0-everywhere spends the world's entire current budget on hedges. LOD0-where-you-can-see-it spends a fifth of it and looks the same, because a 4 cm chamfer is not resolvable at 30 m. The staircase is the opposite case and that is exactly why it goes first: 23 treads at 200 triangles each is 4,600 triangles for the single worst-looking object in the game — the highest visual payoff per triangle anywhere in this world.

**Texture memory — ≤ 96 MB and ≤ 48 texture objects for the maze's material set**, measured as `renderer.info.memory.textures` (count) and as a byte figure computed from the declared map sizes. 1024² RGBA8 with mips is 5.6 MB; 512² is 1.4 MB. So: 1024² for the hedge and the floor only — the two surfaces a player stands nose-to — and 512² for everything else. `bakeSurface` already packs AO/roughness/metalness into one ORM texture in the glTF convention, so a full PBR family is **two** textures (albedo + ORM) plus a normal, not four.

**Boot cost — the maze material set must build in ≤ 250 ms, or build across frames.** Six 1024² surfaces through `bakeSurface` is ~6 M texel-shader evaluations on the CPU. The perf baseline memo says shader warmup already dominates cold boot; adding a second serial stall on top of it would be a regression the user feels even though every frame counter looks fine. `Textures.js` exports `yieldFrame` for exactly this.

**Colliders — exactly 8606, unchanged.** Any change at all is a failed task.

**Bundle — `npm run build` JS output may grow by ≤ 120 KB across the whole phase.** Loaders are the only JS that grows; binaries live in `public/` and are not bundled.

### Compression, and where files live

Vite serves `public/` verbatim, and this project sets `base: '/game/'`. So authored binaries live at `public/assets/maze/**` and are fetched at `` `${import.meta.env.BASE_URL}assets/maze/...` `` — **not** at a leading-slash absolute path, which works in dev and 404s in the built game. That is the single most likely Stage C bug and it is worth a test that greps `MazeAssets.js` for a hard-coded `'/assets`.

KTX2 (UASTC for normals, ETC1S for albedo) stays compressed on the GPU and is roughly a 3× saving over RGBA8+mips. It applies to **authored, file-backed maps only**. Procedural maps are generated as RGBA at boot and transcoding them at runtime would cost more than it saves, so they are held down by *resolution* instead. Saying this plainly here so nobody spends a day trying to KTX2 the output of `bakeSurface`.

---

## The unresolved question: where does the art come from?

`GLTFLoader` ships with three, so glTF costs no dependency. The **models do not exist**. Four ways to get them, honestly costed.

### Option A — Higher-quality procedural geometry

Real stair treads with risers and a nosing; bevelled hedge and wall profiles; mouldings on the shaft walls; AO baked into vertex colours from the descriptor list itself.

- **Pros:** No licence, no download, no bundle growth, no acquisition lead time. Deterministic, so it re-rolls with the seed like everything else in this world. Composes perfectly with instancing and batching — a handful of prefabs × tens of thousands of instances. Starts *today*. It is also the only option that can fix the staircase without anything arriving from outside.
- **Cons:** A ceiling. Procedural geometry gives clean, well-lit, well-proportioned architecture; it does not give a weathered photoscanned stone gargoyle.
- **Decision: this is the backbone of the phase, and it is where all the early visible improvement comes from.**

### Option B — CC0 asset libraries

Poly Haven (CC0, outstanding PBR texture sets and a growing model library), ambientCG (CC0 PBR materials), Quaternius (CC0, stylised low-poly).

- **Pros:** Poly Haven / ambientCG **textures** are the highest value-per-hour item on this entire list. A real 2K hedge, stone and packed-earth material set would do more for the user's complaint than several days of geometry work. CC0 means no attribution obligation and no downstream licence risk.
- **Cons:** Quaternius models are stylised low-poly — a poor match for a "high-fidelity AAA" ask, though excellent for props. Anything from **Sketchfab is a licence minefield**: most models are CC-BY or worse, some are non-commercial, and per-model attribution has to be tracked. Recommendation is **CC0 only, no exceptions**, recorded in `docs/assets/LICENCES.md`.
- **Decision: adopt for textures early (Stage C, Task 9). Treat models as opportunistic.**

### Option C — AI generation (`game-creator:meshyai`)

- **Pros:** Fills specific gaps on demand — a fountain for the centre, a statue for a dead end, a finial for a shaft newel.
- **Cons:** Output is a one-off mesh: unpredictable topology, unpredictable UVs, needs retopo and a manual UV check before it can be instanced. **Useless for tiling PBR materials**, which is where the fidelity actually lives. Generator terms of use must be recorded like any other licence.
- **Decision: a *prop* source, never a *world* source. Use it after the pipeline exists (Task 8), for hero objects only.**

### Option D — User-supplied

- **Pros:** Perfect fit if it arrives.
- **Cons:** Assuming assets will arrive is how a phase stalls.
- **Decision: never on the critical path.** Provide the drop-in folder and the manifest so that if assets *do* arrive they slot in with no code change, and design `MazeAssets.js` so a missing file falls back to the procedural prefab silently.

### Recommended sequencing

**A (all of it) → B-textures → pipeline proof → C/B-models opportunistically.**

Every later option lands into the same prefab registry that Option A builds, so nothing done early is thrown away. The user sees a real staircase inside the first day or two and a properly surfaced maze well before any external file is downloaded.

---

## File structure

| File | Responsibility |
|---|---|
| `src/worlds/maze/MazeProfiles.js` | **New.** Pure numbers: cross-section outlines, step profiles, bevel widths. No THREE. Testable headless, like `MazeFoliage.js`. |
| `src/worlds/maze/MazeMeshes.js` | **New.** Builds `BufferGeometry` prefabs from those profiles. Owns the `(kind, extent class, LOD) -> geometry` registry and its cache bound. |
| `src/worlds/maze/MazeMaterials.js` | **New.** The cached material set, lifted out of `MazeWorld._ensureMaterials`, plus its map generation and the `MAZE_PROGRAM_FAMILIES` fingerprint. |
| `src/worlds/maze/MazeBatches.js` | **New.** One `BatchedMesh` per material family with a per-district instance allocator — the same packed-slot shape `MazeCanopy` already proves at radius 8. |
| `src/worlds/maze/MazeAssets.js` | **New, Stage C.** Manifest, glTF/KTX2 loading, and the silent fallback to the procedural prefab. |
| `src/worlds/maze/MazeChunks.js` | Modified: draws through the registry and the batches. **The collider loop is untouched.** |
| `src/worlds/MazeWorld.js` | Modified: delegates materials; owns the `art` flag. |
| `public/assets/maze/**` | **New, Stage C.** Authored binaries and `manifest.json`. Unbundled, served under `import.meta.env.BASE_URL`. |
| `docs/assets/LICENCES.md` | **New, Stage C.** One line per external file. |

### Stages, and the rollback story

The phase lands in four stages, each independently revertible, **on `main` or via a branch merged per task — never one long-lived branch**. There is no point in this plan where the game is broken between commits.

- **Stage A — fidelity from geometry and procedure (Tasks 1–5).** No external files, no bundle growth. Ships the staircase fix.
- **Stage B — making it affordable (Tasks 6–7).** BatchedMesh and LOD. Pure performance; visuals unchanged.
- **Stage C — authored assets (Tasks 8–9).** The pipeline, then a hero prop, then bulk textures.
- **Stage D — prove and clean up (Task 10).**

Every task ships behind `?art=v2` (parsed alongside `?dev=1` — read the existing param plumbing in `src/core/Config.js` before adding one) and the box path stays in the tree for the whole phase. `art=box` is a one-line fallback because the registry returns the unit box for any kind with no prefab. The flag flips to default-on per task, once that task's browser measurement is recorded in the ledger.

Code and binaries land in **separate commits**, so reverting one never strands the other.

---

### Task 1: The prefab seam — visuals stop being "the collider box"

**Files:**
- Create: `src/worlds/maze/MazeProfiles.js`
- Create: `src/worlds/maze/MazeMeshes.js`
- Modify: `src/worlds/maze/MazeChunks.js`
- Create: `scripts/tests/maze-prefabs.test.mjs`

**Interfaces:**
- Produces: `prefabFor({ kind, hx, hy, hz, lod }) -> THREE.BufferGeometry` — cached, and translation-only at the call site.
- Produces: `extentClass(hx, hy, hz) -> string` — quantises half-extents so the world's handful of distinct box sizes share geometries.
- Produces: `PREFAB_BUDGET` — the maximum number of distinct geometries the registry may ever hold.

This task changes **nothing visible**. It emits the same boxes through the new seam, and that is the point: the risky structural change is landed and measured on its own, so when Task 2 makes the staircase look different, a regression has exactly one place it can have come from.

The fit contract goes in here, as one assertion, because it is what preserves every headless proof in the repo for free.

- [ ] **Step 1: Write the failing tests**

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MAZE, generateTopology } from '../../src/worlds/maze/MazeTopology.js';
import { districtColliders } from '../../src/worlds/maze/MazeColliders.js';
import { CHUNK_MESH_KINDS } from '../../src/worlds/maze/MazeChunks.js';
import { prefabFor, extentClass, PREFAB_BUDGET } from '../../src/worlds/maze/MazeMeshes.js';

test('THE FIT CONTRACT: a prefab never leaves its own collider box', () => {
  /* This one assertion is why Phase 6 does not have to re-run the enclosure
   * proof, the anti-ladder band scan or the containment flood fill. A visual
   * that is a SUBSET of its descriptor cannot create a standable surface the
   * headless gates never saw. A visual that overhangs - a stair nosing built
   * proud of its tread, say - is a surface the player's eye trusts and the
   * physics denies, and it is also a surface no gate has ever measured. */
  const { cells } = generateTopology(2026);
  const EPS = 1e-6;
  for (const d of districtColliders(cells, 3, 3, 0)) {
    if (!CHUNK_MESH_KINDS.includes(d.kind)) continue;
    for (const lod of [0, 1, 2]) {
      const g = prefabFor({ kind: d.kind, hx: d.hx, hy: d.hy, hz: d.hz, lod });
      g.computeBoundingBox();
      const b = g.boundingBox;
      assert.ok(b.min.x >= -d.hx - EPS && b.max.x <= d.hx + EPS
             && b.min.y >= -d.hy - EPS && b.max.y <= d.hy + EPS
             && b.min.z >= -d.hz - EPS && b.max.z <= d.hz + EPS,
        `prefab ${d.kind}@lod${lod} overhangs its descriptor box`);
    }
  }
});

test('the registry caches by extent CLASS, so geometry count does not grow with the world', () => {
  /* Naively caching per descriptor would allocate one BufferGeometry per hedge
   * segment - ~20,000 at full residency - and `renderer.info.memory.geometries`
   * would climb every time a district streamed in. The maze has very few
   * distinct box sizes; the registry has to exploit that or it is not a
   * registry, it is a leak. */
  const { cells } = generateTopology(2026);
  const classes = new Set();
  for (let dz = 0; dz < 4; dz++) {
    for (let dx = 0; dx < 4; dx++) {
      for (const d of districtColliders(cells, dx, dz, 0)) {
        classes.add(`${d.kind}:${extentClass(d.hx, d.hy, d.hz)}`);
      }
    }
  }
  assert.ok(classes.size <= PREFAB_BUDGET,
    `${classes.size} distinct (kind, extent) classes across 16 districts, budget ${PREFAB_BUDGET} - `
    + 'either a descriptor gained a continuously-varying extent, or the quantiser is too fine');
});

test('MazeChunks builds no geometry of its own', async () => {
  /* Sibling of the material tripwire in maze-lighting.test.mjs, and there for
   * the same reason: the registry owns geometry lifetime now, and a
   * BufferGeometry allocated per chunk is the same class of bug a material
   * allocated per chunk was. */
  const src = await readFile(path.join(root, 'src/worlds/maze/MazeChunks.js'), 'utf8');
  assert.ok(!/new THREE\.\w*Geometry\(/.test(src),
    'MazeChunks constructs a geometry directly - prefabs come from MazeMeshes.js');
});
```

- [ ] **Step 2: Run and watch them fail.** Expected: `MazeMeshes.js` does not exist.

- [ ] **Step 3: Implement the registry, returning boxes.** `prefabFor` builds a `BoxGeometry(2hx, 2hy, 2hz)` for every kind at every LOD, cached on `` `${kind}:${extentClass(...)}:${lod}` ``. `extentClass` quantises to 1 cm. Set `PREFAB_BUDGET` from what the test actually measures, plus headroom — a bound derived from a measurement, not a guess.

- [ ] **Step 4: Rewire `MazeChunks.ensure` to use it.** `buildBoxInstances` takes a `geometryFor(desc)` callback instead of building the unit cube, and composes the matrix with **unit scale** — the extents are in the geometry now. Keep `buildSprigInstances` alone; dressing is exempt.

- [ ] **Step 5: Run the full suite, including `MAZE_SEEDS=1000 npm test`.** Nothing may go red. If something does, the layer separation is already broken and this is the cheapest moment in the phase to find out.

- [ ] **Step 6: Verify in the browser.** `npx vite --port 5199`, `?dev=1&art=v2`. `HARNESS.mazeStats()` — draw calls, triangles and colliders must all be **identical** to the baseline, because nothing has changed yet. `renderer.info.memory.geometries` must be flat across ten entries. That flatness is the actual product of this task.

- [ ] **Step 7: Commit.**

---

### Task 2: A staircase that looks like a staircase

**Files:**
- Modify: `src/worlds/maze/MazeProfiles.js`, `src/worlds/maze/MazeMeshes.js`
- Create: `scripts/tests/maze-stair-prefab.test.mjs`

**Interfaces:**
- Produces: `treadProfile({ hx, hy, hz }) -> { tread, riser, nosing, bevel }` — pure numbers.
- Produces: a `stair` prefab at LOD0 with a real tread slab, a set-back riser, a rounded nosing and chamfered edges.

**This is the task the user asked for, and it is second on purpose.** The spiral staircase is the example they named. It is also the cheapest fidelity in the world — 23 treads per shaft, at most a handful of shafts resident, so ~18 k triangles buys the single most-looked-at object in the maze.

A real tread is: the walking slab at the top of the descriptor box, a **riser set back** below it so the stair reads as carpentry rather than as a stack of slabs, a **bulnose** on the leading edge, and a chamfer on the exposed corners. Every one of those lives **inside** the box: the nosing occupies the box's own front face rather than projecting past it, because a nosing you can see and cannot stand on is worse than no nosing. That constraint is not a compromise — a real tread's nosing overhangs the *riser*, and the riser is what gets set back.

- [ ] **Step 1: Write the failing tests**

```js
test('a stair tread has a walking surface, a riser and a nosing', () => {
  const p = treadProfile({ hx: TREAD_HALF, hy: 0.1875, hz: TREAD_HALF });
  assert.ok(p.riser.setback > 0, 'no riser setback - the stair is still a stack of slabs');
  assert.ok(p.nosing.radius > 0, 'no nosing - the tread edge is a hard 90 degrees');
  /* The nosing projects over the RISER, never over the descriptor box. See the
   * fit contract in maze-prefabs.test.mjs: a visual you can see and cannot
   * stand on is worse than the box it replaced. */
  assert.ok(p.nosing.radius <= p.riser.setback + 1e-9,
    'the nosing reaches past the riser it is supposed to overhang');
});

test('the stair prefab is worth its triangles and no more', () => {
  const g = prefabFor({ kind: 'stair', hx: 0.5, hy: 0.1875, hz: 0.5, lod: 0 });
  const tris = triCount(g);
  assert.ok(tris > 40, `${tris} triangles - that is still a box with opinions`);
  assert.ok(tris <= 260, `${tris} triangles per tread; 23 per shaft is the budget line`);
});

test('a distant tread degrades to the box it always was', () => {
  const near = prefabFor({ kind: 'stair', hx: 0.5, hy: 0.1875, hz: 0.5, lod: 0 });
  const far  = prefabFor({ kind: 'stair', hx: 0.5, hy: 0.1875, hz: 0.5, lod: 2 });
  assert.ok(triCount(far) < triCount(near) / 4, 'LOD2 is not meaningfully cheaper than LOD0');
});
```

- [ ] **Step 2: Run and watch them fail.**

- [ ] **Step 3: Implement `treadProfile` and the stair prefab.** Author the profile as a 2D outline in `MazeProfiles.js` (pure, no THREE) and sweep it in `MazeMeshes.js`. The landing slab is the same kind with different extents, so `extentClass` already gives it its own geometry — check the profile degrades sensibly for a wide, thin landing rather than putting a nosing on all four of its sides.

- [ ] **Step 4: Run the suite.**

- [ ] **Step 5: Look at it. This is the step that decides whether the phase is working.** `?dev=1&art=v2`; `HARNESS.teleport` to a shaft; screenshot the spiral from the bottom of the well and from halfway up. Compare against the same seed and the same spot with `art=box`. If it still reads as a stack of slabs, the profile is wrong and no amount of later PBR work will rescue it — fix it here.

- [ ] **Step 6: Measure.** `mazeStats()` triangles and draw calls. Draw calls must be unchanged (same instanced meshes, different geometry). Programs must be unchanged (same cached material). Triangles rise by roughly `treads × 200 × resident shafts`.

- [ ] **Step 7: Commit, and show the user the screenshot.** They raised this specific object; close the loop on it before starting Stage A's bulk work.

---

### Task 3: `MazeMaterials.js`, and the gate that replaces the frozen 385

**Files:**
- Create: `src/worlds/maze/MazeMaterials.js`
- Modify: `src/worlds/MazeWorld.js`
- Create: `scripts/tests/maze-materials.test.mjs`

**Interfaces:**
- Produces: `buildMazeMaterials() -> { [kind]: THREE.Material }` — the exact set `_ensureMaterials` returns today, moved verbatim.
- Produces: `MAZE_PROGRAM_FAMILIES` — the enumerated list of distinct material feature-sets.
- Produces: `materialFingerprint(mat) -> string` — the subset of a material's state that Three bakes into its program cache key.

`_ensureMaterials` is ~200 lines inside a file that also owns build, dispose, streaming, the minimap binding and the shaft scan. Lifting it out is worth doing anyway, but the reason it happens *now* is that the program gate needs to be testable headlessly, and a test that has to import `MazeWorld.js` to see a material is a test nobody will keep.

**The measurement that sets the budget is Step 5, and it must be done before the budget is written down.** Adding one map to one material does not cost one program — it typically costs the colour program *plus* its depth and distance variants, because point lights cast shadows. So: add exactly one map to exactly one material, measure the delta, and derive the budget from that number times the number of families. A budget guessed in advance is a budget that gets tuned away the first time it fails.

- [ ] **Step 1: Write the failing tests**

```js
test('the maze compiles no more material families than it declares', () => {
  /* Phase 5 froze `renderer.info.programs.length`. That was the right gate when
   * nothing about the materials was allowed to change, and it is the wrong one
   * now: PBR maps change a program cache key by construction. What survives the
   * relaxation is the thing the frozen count was really protecting - that the
   * number of DISTINCT material feature-sets is small, known, and does not grow
   * when a district streams in. That is checkable here, headless, per commit;
   * the absolute program count is only checkable in a browser. */
  const mats = buildMazeMaterials();
  const seen = new Set(Object.values(mats).map(materialFingerprint));
  assert.ok(seen.size <= MAZE_PROGRAM_FAMILIES.length,
    `${seen.size} distinct material families, ${MAZE_PROGRAM_FAMILIES.length} declared: `
    + `${[...seen].filter((f) => !MAZE_PROGRAM_FAMILIES.includes(f)).join(', ')}`);
});

test('two calls hand back the same materials, not two equal sets', () => {
  /* The cached-once rule from Phase 5, now assertable rather than inspectable. */
  const a = buildMazeMaterials(), b = buildMazeMaterials();
  for (const k of Object.keys(a)) assert.equal(a[k], b[k], `material '${k}' was rebuilt`);
});

test('MazeWorld no longer builds materials itself', async () => {
  const src = await readFile(path.join(root, 'src/worlds/MazeWorld.js'), 'utf8');
  assert.ok(!/new THREE\.Mesh\w*Material\(/.test(src),
    'a material literal is back in MazeWorld - the family gate cannot see it there');
});
```

- [ ] **Step 2: Run and watch them fail.**

- [ ] **Step 3: Move `_ensureMaterials` verbatim.** No behavioural change in this step. `MazeWorld._ensureMaterials` becomes a one-line delegate that keeps its `this._materials` cache, so the dispose path (which deliberately keeps materials alive across re-rolls) is untouched.

- [ ] **Step 4: Write `materialFingerprint`.** It must capture what Three actually keys on: material type, and the presence (not the content) of `map`, `normalMap`, `roughnessMap`, `metalnessMap`, `aoMap`, `emissiveMap`, `alphaMap`, plus `vertexColors`, `transparent`, `side`, `flatShading`. Read `WebGLPrograms.getProgramCacheKey` in the installed three before writing this list — do not reconstruct it from memory.

- [ ] **Step 5: MEASURE THE MARGINAL COST OF ONE FAMILY.** In the browser, record `programs` at full residency. Add a `normalMap` to the `footing` material only. Reload, record again. The delta is the true per-family cost including shadow variants. **Write that number into `MazeMaterials.js` as a comment**, then revert the temporary map.

- [ ] **Step 6: Set the budget.** `MAZE_PROGRAM_BUDGET = 385 + (families gaining maps) × (measured delta)`, rounded up. Record it in the ledger alongside the measurement it came from. The plan's headline figure is ≤ 420; if the measurement says otherwise, **the measurement wins and the plan is amended**, not the other way round.

> **AMENDED 2026-08-09, per the rule above.** The measurement was taken (commit `b3b52fb`): baseline 381 programs at full 43-district residency; +`normalMap` on `footing` only → 382. **Marginal cost is +1 program per map-gaining family, not colour+depth+distance.** The prediction in this section's preamble was wrong because three's shadow depth/distance materials key on `displacementMap`/`alphaMap`/`alphaTest` only — `map`/`normalMap`/`roughnessMap`/`metalnessMap` never enter the shadow program key, so Tasks 4–5's families share the existing shadow programs. **`MAZE_PROGRAM_BUDGET = 389`** (385 + 4 × 1), not ≤ 420; the ≤ 420 headline elsewhere in this plan is superseded. Derivation and both readings are recorded on the constant in `MazeMaterials.js`.
>
> **Re-amended at Task 6 (commit `008ce38`): 389 → 394.** Three keys every program on `BATCHING`, so the batched materials compile batched colour + shadow variants — measured at exactly +5, once, flat across ten entries thereafter. Same rule, same enforcement point.

- [ ] **Step 7: Run the suite, ten entries in the browser, confirm flatness. Commit.**

---

### Task 4: Bevelled profiles and baked contact AO

**Files:**
- Modify: `src/worlds/maze/MazeProfiles.js`, `src/worlds/maze/MazeMeshes.js`
- Modify: `src/worlds/maze/MazeMaterials.js`
- Create: `scripts/tests/maze-bevel.test.mjs`

**Interfaces:**
- Produces: LOD0 prefabs for `hedge`, `floor`, `shaftWall`, `gate`, `slideWall`, `footing` with chamfered edges and baked vertex AO.

Two things make a box stop reading as a box, and neither is a texture. The first is that **real edges catch light** — a 4 cm chamfer gives every hedge and every wall a highlight down its corners, which is most of what "high-poly" actually looks like at walking distance. The second is **contact darkening**: the corner where a hedge meets the floor is darker than either surface, and a renderer with no GI will not produce that on its own.

Vertex AO is the right tool here rather than a lightmap. A lightmap needs a second UV set and a texture per district; across 2.4 km × 4 levels that is a texture budget nobody can pay and a bake nobody can re-run on a re-rolled seed. AO baked into the prefab's vertex colours costs one attribute, re-rolls for free, and is *identical* for every instance of an extent class — which is exactly the property that lets it live in a shared, cached geometry.

`vertexColors: true` changes a program cache key, so this task spends part of Task 3's budget. That is what the budget is for; record the actual delta.

- [ ] **Step 1: Write the failing tests**

```js
test('a bevelled prefab still fits its box, and its bevel is world-scaled', () => {
  /* The reason the registry caches by extent class and the instance matrix
   * carries no scale. A 4 cm chamfer authored on a unit cube and then scaled by
   * a hedge segment's half-extents comes out 19 cm on one axis and 2 cm on the
   * other, which reads as a mistake rather than as a bevel. */
  const wide = prefabFor({ kind: 'hedge', hx: 2.4, hy: 2.5, hz: 0.6, lod: 0 });
  const tall = prefabFor({ kind: 'hedge', hx: 0.6, hy: 2.5, hz: 2.4, lod: 0 });
  assert.ok(Math.abs(measuredBevel(wide) - measuredBevel(tall)) < 5e-3,
    'the bevel width depends on the descriptor extents - it is being scaled, not authored');
});

test('a prefab carries baked contact AO on its lower edges', () => {
  const g = prefabFor({ kind: 'hedge', hx: 2.4, hy: 2.5, hz: 0.6, lod: 0 });
  assert.ok(g.attributes.color, 'no colour attribute - nothing is baked');
  const { lowMean, highMean } = meanColourByHeight(g);
  assert.ok(lowMean < highMean * 0.8,
    `AO is not darkening the base: bottom ${lowMean.toFixed(3)} vs top ${highMean.toFixed(3)}`);
});
```

- [ ] **Step 2: Run and watch them fail.**

- [ ] **Step 3: Implement the chamfer and the AO bake** in `MazeMeshes.js`, from outlines in `MazeProfiles.js`. Keep LOD1 as the plain box — the whole triangle argument depends on it.

- [ ] **Step 4: Turn on `vertexColors` for the affected materials** and re-run the family test; it will fail until `MAZE_PROGRAM_FAMILIES` is updated deliberately, which is the point.

- [ ] **Step 5: Measure the program delta against Task 3's budget** and run ten entries for flatness.

- [ ] **Step 6: Screenshot a corridor at ground level, same seed and spot as Phase 5's "before".** Three images: `art=box`, Phase 5, Phase 6. Commit.

---

### Task 5: Real PBR surfaces from real height fields

**Files:**
- Modify: `src/worlds/maze/MazeMaterials.js`
- Create: `scripts/tests/maze-surfaces.test.mjs`

**Interfaces:**
- Consumes: `bakeSurface`, `makeNormalFromHeight` from `src/gfx/Textures.js`.
- Produces: albedo + normal + ORM for `hedge`, `floor`, `stair`/`shaftWall`, `footing`, `tunnel`.

Phase 5 gave the hedge and the floor a colour map and stopped there, and it wrote down exactly why: *"`makeNormalFromHeight` takes a Float32Array HEIGHT FIELD, not a texture, and there is no exported helper that hands one back from `makeNoiseTexture`. Passing the texture would have compiled and produced garbage."* That note was correct and it also named the fix — **`bakeSurface` already emits albedo, height and a packed ORM in one pass**, in the glTF R=AO / G=roughness / B=metalness convention, precisely so this does not cost three separate noise walks.

So this task is not new machinery. It is using the machinery `Textures.js` was built with, which Phase 5 could not reach through the API it happened to call.

- [ ] **Step 1: Write the failing tests**

```js
test('the maze surfaces its principal materials, not just tints them', () => {
  const m = buildMazeMaterials();
  for (const kind of ['hedge', 'floor', 'stair', 'footing']) {
    assert.ok(m[kind].map, `${kind} has no albedo`);
    assert.ok(m[kind].normalMap, `${kind} has no normal map - it will read flat at any distance`);
    assert.ok(m[kind].roughnessMap, `${kind} has no ORM - roughness is uniform across the surface`);
  }
});

test('one ORM texture serves ao, roughness and metalness', () => {
  /* Three separate greyscale maps is three uploads and three samplers for data
   * that packs into one RGB. Textures.js bakes it packed already; wiring it to
   * one slot and generating two more would be paying twice for the same texels. */
  const m = buildMazeMaterials().hedge;
  assert.equal(m.roughnessMap, m.metalnessMap, 'ORM is not shared between roughness and metalness');
  if (m.aoMap) assert.equal(m.aoMap, m.roughnessMap, 'a separate AO texture was generated');
});

test('the texture budget is declared and respected', () => {
  const bytes = declaredTextureBytes();       // from the size table in MazeMaterials.js
  assert.ok(bytes <= 96 * 1024 * 1024, `${(bytes / 1048576).toFixed(1)} MB of maps, budget 96 MB`);
});
```

- [ ] **Step 2: Run and watch them fail.**

- [ ] **Step 3: Replace each `makeNoiseTexture` call with a `bakeSurface` shading callback.** 1024² for `hedge` and `floor` only; 512² elsewhere. Wire the ORM to `roughnessMap` and `metalnessMap` (and `aoMap` only where a UV2 exists — a `BoxGeometry`'s `uv` is not `uv2`, so check before wiring it rather than shipping a silent no-op).

- [ ] **Step 4: Guard the boot cost.** Time `buildMazeMaterials()`. If it exceeds 250 ms, drive it through `yieldFrame` across frames rather than shrinking the maps — the perf baseline says cold boot is already the sensitive path and a second serial stall is what the user would feel.

- [ ] **Step 5: Run the suite, and the program family gate.** Adding maps moves fingerprints; update `MAZE_PROGRAM_FAMILIES` deliberately and re-measure.

- [ ] **Step 6: Browser.** Ten entries, `programs` ≤ budget and **flat**; `renderer.info.memory.textures` ≤ 48 and flat. Screenshot a hedge at 2 m and at 30 m — a normal map that reads as sandpaper up close is worse than none.

- [ ] **Step 7: Commit. Stage A is complete; the user should be shown the result before Stage B starts,** because Stage B is invisible to them and this is the natural checkpoint.

---

### Task 6: `BatchedMesh` — pay for the fidelity

**Files:**
- Create: `src/worlds/maze/MazeBatches.js`
- Modify: `src/worlds/maze/MazeChunks.js`
- Create: `scripts/tests/maze-batches.test.mjs`

**Interfaces:**
- Produces: `MazeBatches` — one `BatchedMesh` per material family; `add(key, descs)` / `drop(key)` mirroring `MazeChunks`'s residency.

Today `ensure` builds up to ~14 `InstancedMesh` per district. At 25 districts that is the 214–420 draw calls in the baseline, and it is why standing on a tower — the moment draw-call pressure is already worst — is the worst case. `MazeCanopy` already solved this exact problem at radius 8 with a single mesh and a packed slot allocator, and its docstring records what the per-district alternative measured. **This is that pattern, applied to the streamed set.**

The key design decision, and it is what avoids `BatchedMesh`'s one real hazard: **geometries are added once and never deleted; only instances are added and removed.** Each family's batch holds a handful of prefabs (`addGeometry`) at construction, and streaming a district in or out is `addInstance` / `deleteInstance`. Geometry fragmentation — the thing that forces `optimize()` and eventually a rebuild — simply cannot occur, because the geometry buffer is written once.

- [ ] **Step 1: Read `node_modules/three/src/objects/BatchedMesh.js` before writing anything.** Confirm, against the installed 0.185.1 and not against memory: multiple instances per geometry id; `deleteInstance` semantics; per-instance visibility; per-geometry bounds for culling; and whether `setGeometryIdAt` exists, since Task 7's LOD depends on it. **Write what you find into the module docstring.** If `setGeometryIdAt` is absent, Task 7 changes shape and it is far cheaper to know that now.

- [ ] **Step 2: Write the failing tests**

```js
test('the batch reserves worst-case capacity from the residency radius, not a literal', () => {
  /* MazeCanopy's own lesson, in its docstring: a pool sized by a hand-written
   * number silently starves the day the radius changes. */
  assert.equal(batchCapacity('hedge'), worstCaseInstances('hedge', RESIDENCY_RADIUS));
});

test('dropping a district releases exactly its own instances', () => {
  const b = new MazeBatches({ materials: stubMaterials(), group: stubGroup() });
  b.add(KEY_A, descsFor(KEY_A));
  const after = b.instanceCount();
  b.add(KEY_B, descsFor(KEY_B));
  b.drop(KEY_B);
  assert.equal(b.instanceCount(), after, 'dropping B did not return B exactly');
});

test('geometries are added once and never deleted', async () => {
  /* The whole reason this design cannot fragment. */
  const src = await readFile(path.join(root, 'src/worlds/maze/MazeBatches.js'), 'utf8');
  assert.ok(!/deleteGeometry/.test(src),
    'a geometry is being deleted from a batch - that is the fragmentation path this design exists to avoid');
});
```

- [ ] **Step 3: Implement `MazeBatches`.** One batch per material family from `MAZE_PROGRAM_FAMILIES`. Capacity derived from the residency radius, as the test demands. Moving kinds (`lift`, `liftDoor`, `gate`, `slideWall`) keep their existing `InstancedMesh` path for now — they are four objects per district and their per-frame matrix rewrite is already correct; moving them into a batch is churn with no payoff and it risks the interlocks the lift and gate safety argument rests on.

- [ ] **Step 4: Run the suite.** `maze-chunks.test.mjs`, `maze-residency.test.mjs` and the leak test in particular — `objectCount()` is an exact equality and its meaning changes when 14 meshes become 1 batch. Update `objectCount`'s docstring to say what it now counts and why.

- [ ] **Step 5: Browser.** Draw calls at full residency, standing in a corridor and standing on a tower. Target ≤ 120 / ≤ 180. Walk a full district cycle and confirm `renderer.info.memory.geometries` is flat — a batch that reallocates on churn shows up here and nowhere else.

- [ ] **Step 6: Commit.**

---

### Task 7: LOD across 2.4 km and four levels

**Files:**
- Modify: `src/worlds/maze/MazeBatches.js`, `src/worlds/maze/MazeMeshes.js`
- Create: `scripts/tests/maze-lod.test.mjs`

**Interfaces:**
- Produces: `lodFor(distance) -> 0 | 1 | 2` — pure, testable, one definition.
- Produces: per-instance geometry swap on residency update.

`THREE.LOD` is the wrong tool here and it is worth saying why, since it is the obvious choice: `LOD` swaps whole `Object3D`s and would mean one scene object per hedge segment, which is the thing instancing exists to avoid. The right mechanism is a **per-instance geometry id** inside the batch, so a level change costs one integer write and no draw calls at all.

LOD is evaluated **per district, not per instance**, on the residency update rather than per frame. A district is 120 m square and the bands are 25 m / 80 m, so per-instance evaluation would matter only for the district the player is standing in — and there, everything is LOD0 anyway. Per-district is one comparison per resident district per update instead of 20,000 per frame.

- [ ] **Step 1: Write the failing tests**

```js
test('the LOD bands are derived from the triangle budget, not chosen', () => {
  /* Every band boundary here is a number the budget table in the plan produced.
   * If a band moves, the budget moves with it, and the test that fails should be
   * this one rather than a frame counter three weeks later. */
  assert.equal(lodFor(0), 0);
  assert.equal(lodFor(LOD0_RANGE - 0.01), 0);
  assert.equal(lodFor(LOD0_RANGE + 0.01), 1);
  assert.equal(lodFor(LOD1_RANGE + 0.01), 2);
});

test('the resident set stays inside the triangle budget at every band', () => {
  /* Counted from prefab triangle counts and real descriptor counts - no
   * renderer needed, which is the same reason the collision gates are headless. */
  const t = trianglesAtFullResidency(2026);
  assert.ok(t.ground <= 3.5e6, `${(t.ground / 1e6).toFixed(2)} M triangles at ground level, budget 3.5 M`);
  assert.ok(t.tower  <= 5.0e6, `${(t.tower  / 1e6).toFixed(2)} M triangles from a tower, budget 5.0 M`);
});

test('a district changing band does not change its instance count', () => {
  /* An LOD swap must be a geometry-id write. If instances are removed and
   * re-added the allocator churns, and churn is what fragments a batch. */
  const b = freshBatches();
  b.add(KEY, descs); const n = b.instanceCount();
  b.setLod(KEY, 1);  assert.equal(b.instanceCount(), n);
  b.setLod(KEY, 2);  assert.equal(b.instanceCount(), n);
});
```

- [ ] **Step 2: Run and watch them fail.**

- [ ] **Step 3: Implement.** Wire `lodFor` into `updateResidency`, and the swap into `MazeBatches.setLod`. If Task 6 Step 1 found no `setGeometryIdAt`, fall back to **one batch per (family, LOD)** and move instances between them on a band change — more allocator work, same draw-call story, and the test above is then relaxed to "instance count summed across the family's batches is unchanged" with a comment saying exactly why.

- [ ] **Step 4: Absorb the outstanding-work item.** Update the outstanding-work memo: item 1 (LOD + BatchedMesh) is delivered for the maze. Say plainly that the other worlds are not yet on this path, so the item narrows rather than closes.

- [ ] **Step 5: Browser.** Walk a straight 500 m corridor and a full lap of a level with `mazeStats()` sampled every few seconds: draw calls, triangles, fps, colliders, geometries. Then climb a shaft to level 3 and look out — the tower view is the worst case for every budget in this phase and it is the one to record.

- [ ] **Step 6: Commit. Stage B complete.** The world should look identical to the end of Stage A and cost meaningfully less.

---

### Task 8: The pipeline, proved by one hero prop

**Files:**
- Create: `src/worlds/maze/MazeAssets.js`
- Create: `public/assets/maze/manifest.json`
- Create: `docs/assets/LICENCES.md`
- Modify: `src/worlds/maze/MazeMeshes.js`
- Create: `scripts/tests/maze-assets.test.mjs`

**Interfaces:**
- Produces: `loadMazeAssets() -> Promise<{ [id]: THREE.BufferGeometry | THREE.Texture }>` — resolves even when files are absent.
- Produces: `manifest.json` entries of `{ id, file, kind, licence, source, tris?, bytes? }`.

**Land the pipeline with exactly one asset in it.** Not a library import, not a bulk download — one prop, end to end, so that every question that only shows up in practice (the `/game/` base path, the KTX2 transcoder location, the fallback when the fetch 404s, the licence line, whether a loaded mesh actually instances) is answered once, cheaply, and before any bulk acquisition commits the project to a direction.

The candidate is the **shaft newel / stair finial** — a small object at the centre of the spiral, seen every time a player climbs, in the one place this phase has already invested. If no external asset is available at this point, generate one via `game-creator:meshyai` or author it procedurally; the task is about the *pipeline*, and it must pass with a procedurally-authored glTF just as well as with a downloaded one.

- [ ] **Step 1: Verify the loader and transcoder paths in the installed package.** `ls node_modules/three/examples/jsm/loaders/` and `node_modules/three/examples/jsm/libs/`. Record what is actually there. Copy the transcoder into `public/vendor/basis/` in its **own commit**, separate from the code.

- [ ] **Step 2: Write the failing tests**

```js
test('every manifest entry declares a licence from the allow-list', () => {
  /* Sketchfab is a licence minefield and CC-BY carries an attribution
   * obligation that is invisible at import time and expensive at ship time.
   * The allow-list is the cheapest possible place to enforce it. */
  const ALLOWED = ['CC0-1.0', 'CC-BY-4.0', 'proprietary-owned', 'generated'];
  for (const e of manifest.assets) {
    assert.ok(ALLOWED.includes(e.licence), `${e.id}: licence '${e.licence}' is not on the allow-list`);
    if (e.licence === 'CC-BY-4.0') {
      assert.ok(attributions().includes(e.id), `${e.id} is CC-BY and has no line in docs/assets/LICENCES.md`);
    }
  }
});

test('asset URLs go through the Vite base, or the built game 404s', async () => {
  /* This project sets base: '/game/'. A leading-slash path works in dev and
   * fails in the build, which is the worst shape of bug: it passes every check
   * a developer runs and fails only for the player. */
  const src = await readFile(path.join(root, 'src/worlds/maze/MazeAssets.js'), 'utf8');
  assert.ok(!/['"`]\/assets\//.test(src), 'a hard-coded absolute asset path');
  assert.ok(/import\.meta\.env\.BASE_URL/.test(src), 'BASE_URL is not used to build asset URLs');
});

test('a missing asset degrades to its procedural prefab', () => {
  /* The user may never supply a model. The world must not care. */
  const g = prefabFor({ kind: 'newel', hx: 0.3, hy: 0.5, hz: 0.3, lod: 0, assets: {} });
  assert.ok(g, 'no fallback geometry when the asset is absent - the world would render a hole');
});
```

- [ ] **Step 3: Implement `MazeAssets.js`.** Load on world build, not on module import — a world that is never entered must cost nothing. Every failure path resolves to the procedural prefab and logs once.

- [ ] **Step 4: Land the newel.** Register it in the registry as a prefab for a new dressing kind, so the fit contract's `dressing` exemption is exercised. Add it to the batch for the stone family.

- [ ] **Step 5: Measure what an authored asset actually costs.** Programs (a glTF material is its own family unless it is remapped to a cached one — **remap it**, and say so in a comment), textures, triangles, bundle size before and after `npm run build`.

- [ ] **Step 6: Browser.** Both `npx vite --port 5199` **and** `npm run build && npm run preview`, because the base-path bug only appears in the second one.

- [ ] **Step 7: Commit — code and binaries in separate commits.**

---

### Task 9: Bulk surfacing from CC0 libraries

**Files:**
- Modify: `public/assets/maze/manifest.json`, `docs/assets/LICENCES.md`, `src/worlds/maze/MazeMaterials.js`

**Interfaces:** no new ones. This task adds data, not code — which is the point, and the measure of whether Task 8 built the right thing.

Poly Haven / ambientCG PBR sets for hedge foliage, weathered stone and packed earth, at 2K, converted to KTX2 offline and committed. This is the single highest value-per-hour item in the phase and it lands *last* only because it needs the pipeline, the budget and the family gate to already exist.

- [ ] **Step 1: Choose ≤ 5 material sets. CC0 only.** Record each in `LICENCES.md` with its source URL on the day it was fetched.

- [ ] **Step 2: Convert offline** to KTX2 — UASTC for normals (an ETC1S normal map is visibly blotchy), ETC1S for albedo and ORM. The tool is a devDependency or an external binary and must not appear in `dependencies`.

- [ ] **Step 3: Re-run the texture budget test.** KTX2 changes the byte accounting; update the size table so the declared figure still matches reality.

- [ ] **Step 4: Swap the procedural maps behind a per-material fallback**, so a missing KTX2 falls back to `bakeSurface` rather than to nothing. That fallback is also the reviewer's A/B: it is how you show whether the authored set is actually better.

- [ ] **Step 5: Browser.** `renderer.info.memory.textures`, GPU memory, cold-boot time. Compare a corridor screenshot against the Stage A result — **if the authored set is not visibly better, keep the procedural one.** It is smaller, it re-rolls, and it carries no licence.

- [ ] **Step 6: Commit.**

---

### Task 10: Prove it, and take the scaffolding down

- [ ] **Step 1: Full measurement sweep.** Ten entries; corridor, dead end, shaft interior, tower top. Record fps, ms, draw calls, triangles, programs, geometries, textures, colliders. Every one against its budget in this document.
- [ ] **Step 2: Confirm colliders are still exactly 8606** and that the anti-ladder, enclosure, containment and perforation gates are green. Art must not have moved a collider — the same closing check Phase 5 ended on, and the reason this phase was safe to attempt at all.
- [ ] **Step 3: `MAZE_SEEDS=1000 npm test`, contract-check, `npm run build`.**
- [ ] **Step 4: Remove the `art=box` path** and the flag, in its own commit, so it can be reverted alone if anything surfaces late.
- [ ] **Step 5: Write the ledger** — `docs/superpowers/specs/2026-08-09-maze-world-phase-6-ledger.md`. It must contain the measured per-family program cost, the final program budget and how it was derived, the before/after screenshots, and the asset-sourcing decision as it actually turned out rather than as this plan predicted.
- [ ] **Step 6: Commit.**

---

## Phase 6 exit criteria

- [ ] `npm test` and `MAZE_SEEDS=1000 npm test` pass; contract-check exits 0; `npm run build` clean.
- [ ] **Colliders exactly 8606.** No descriptor changed. The anti-ladder, enclosure, containment and perforation gates green.
- [ ] **Programs ≤ the budget derived in Task 3, and the entry-3-to-entry-10 delta is exactly 0.**
- [ ] `renderer.info.memory.geometries` and `.textures` flat across a full residency walk.
- [ ] Draw calls ≤ 120 in a corridor, ≤ 180 from a tower — **below** the 214–420 baseline.
- [ ] Triangles ≤ 3.5 M at ground level, ≤ 5 M from a tower.
- [ ] Texture memory ≤ 96 MB, ≤ 48 texture objects.
- [ ] ≥ 120 fps / ≤ 8.3 ms sustained while walking; hard floor 60 fps.
- [ ] Material set builds in ≤ 250 ms, or across frames.
- [ ] Every external file has a licence line in `docs/assets/LICENCES.md`; a missing file degrades to a procedural prefab and never throws.
- [ ] The built game (`npm run preview`) loads every asset correctly under the `/game/` base.
- [ ] **The spiral staircase reads as a staircase.** Side-by-side screenshots, same seed, same spot, in the ledger. This is the criterion the user actually asked for.

## What Phase 6 knowingly does not do

- **No lightmaps.** Baked contact AO goes into vertex colours instead. A real lightmap needs a second UV set and a texture per district; across a 2.4 km × 4-level world that is a texture budget nobody can pay and a bake nobody can re-run when the seed re-rolls. Revisit only if the world ever stops re-rolling.
- **No post-processing.** God-rays and pollen were deferred by Phase 5 and stay deferred. They belong after the surfaces read correctly, and after this phase the surfaces finally will.
- **The other worlds keep their `InstancedMesh` path.** `MazeBatches` is deliberately maze-shaped. Generalising it to the station and the terrain worlds is a phase of its own, and doing it speculatively here would mean designing for four callers while only being able to measure one.
- **Moving parts stay on `InstancedMesh`.** The lift car, its landing door, the one-way gates and the sliding walls are four objects per district with a per-frame matrix rewrite that is already correct and already load-bearing for two safety interlocks. Batching them is churn against the riskiest code in the world file.
- **No engine change.** Settled: Three.js. See `engine-choice-threejs`.
