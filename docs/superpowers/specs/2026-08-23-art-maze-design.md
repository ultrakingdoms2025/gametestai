# Phase 9 · `art-maze` — The Verdant Coil art pass

**Branch:** `art-maze` (worktree). **Roadmap:** Phase 9, decision D4 (hybrid).
**Budget gate:** Phase 1's. Draw calls, triangles, materials, renderables, instanced meshes,
world lights and **shader programs** measured before and after by the same script, in the same
framings — and, in this world only, measured against a **noise floor that had to be established
first**, because the maze re-rolls its own seed on every build.

**Evidence:** `docs/superpowers/specs/img/2026-08-23-art-maze/`.

The pair that carries this pass is `before-sprig-three-quarter.jpg` / `after-sprig-three-quarter.jpg`
— a hedge top at 2.4 m, before and after, +65% edge energy at unchanged luma. The pair beside it
is `before-candle-matched.jpg` / `after-candle-matched.jpg`: the same object in the same corridor
framing, cropped and scaled to the same apparent size, going from a flat cream rectangle to a
tapered wax pillar with a wick. `work-rejected-cone-tuft.jpg` is the authored tuft that was
photographed, rejected and re-cut inside this branch — see §3.1.
`noise-floor-tower-top-second-base-run.jpg` is the same framing as `before-tower-top.jpg`, same
commit, same machine, a different maze — which is §0.

---

## 0. The finding that governs every number in this document

`MazeWorld.build()` opens with:

```js
this.seed = (Math.random() * 0xffffffff) >>> 0;
```

The maze is `static volatile = true` and re-generates on every activation. **Two runs of the
same commit do not photograph the same world.** The unchanged base tree was run through
`scripts/world-shot.mjs` **seven** times on this machine — four before any work started and
three more after it was committed, from the base commit checked out into this same worktree:

| on unchanged code, 7 runs | min | max | spread |
|---|---|---|---|
| `forecourt` worldTriangles | 897,370 | 972,002 | 8% |
| `corridor` worldTriangles | 853,950 | 921,662 | 8% |
| `shaft-up` worldTriangles | 431,766 | 820,408 | **90%** |
| `tower-top` worldTriangles | 822,496 | 1,339,364 | **63%** |
| `forecourt` draw calls | 310 | 338 | 9% |
| materials | 14 | 18 | 4 |
| renderables | 46 | 92 | 46 |
| instanced meshes | 32 | 78 | 46 |
| shader programs | 232 | 233 | 1 |
| world lights, `tower-top` | 675 | 950 | 275 |

`shaft-up` swings **90%** on code that did not change; `tower-top` 63%. Materials move by four,
renderables by forty-six. Every "before → after" below is therefore reported as a **range over
runs**, and every claim that something is *unchanged* is carried by a headless deterministic
test rather than by the browser figure.

`noise-floor-tower-top-second-base-run.jpg` beside `before-tower-top.jpg` is the picture of this:
same commit, same framing, same machine, and not the same maze.

That is the first thing a sibling branch should take from this file: in this world a single
before/after pair is not evidence of anything.

---

## 1. Method

`scripts/world-shot.mjs` unchanged — real Chrome over CDP against a real Vite server, 1600×900,
`gameplayDriven: true`, hardware GL (`ANGLE … RTX 5080 … D3D11`). Five landscape framings
(`VIEWS.maze`) plus subject framings at 2.4 m for the things a player actually stands next to.

**One framing could not be shot at all, and that is a defect — see §5.1.**

**The materials had to be named before the instrument worked at all — see §2.1.**

---

## 2. What the measurement showed

### 2.1 Every material in this world was anonymous, so `--ablate` was blind

`--ablate` hides meshes **by material name**, and it is the only tool in this repository that
can answer "which system drew this pixel". Run against the maze before this pass, every
report's `materialNames` read a census of the constructor:

```
47  MeshStandardMaterial
 6  MeshBasicMaterial
 1  PointsMaterial
```

`buildMazeMaterials` now closes with `for (const [key, m] of Object.entries(_materials)) m.name = 'maze.' + key;`
and the pollen cloud names itself in `MazeWorld._buildPollen`. `--ablate maze.foliage` then
reported **21 meshes hidden** where it had previously thrown *"matched no material"*. Three's
program cache key is built from type, parameters, defines and `customProgramCacheKey`; `name` is
in none of them, and `materialFingerprint` — which the family gate reads — does not read it
either. This is the `art-station` lesson applied here, and it is what made everything below
possible.

### 2.2 Two thirds of this world's triangles were hedge-top boxes

The `byName` breakdown from `world-shot`, in **every single framing**, was fourteen of the same
thing:

```
maze:foliage:430  43,632      maze:foliage:31   43,200
maze:foliage:11   43,308      maze:foliage:32   43,200
maze:foliage:49   43,308      maze:foliage:410  43,200
maze:foliage:28   43,200      …
```

43,200 = **3,600 instances × a 12-triangle `BoxGeometry(0.5, 0.5, 0.5)`**, per district, and 21
districts are resident at the entrance. Against a whole-world total of 888k–1.34M, hedge-top
"unkempt growth" is roughly two thirds of everything this world draws — and none of the batched
structure (hedges, floors, stairs, footings) reaches the top fourteen at all.

`MazeFoliage`'s own header says what those 75,646 boxes are for:

> *The hedge is a box, and the giveaway is its perfectly straight top edge running the length of
> a corridor. Breaking that line is worth more than any amount of detail on the faces.*

### 2.3 …and photographed at conversational distance they were bricks

`before-sprig-three-quarter.jpg`. Flat-topped, hard-edged, axis-aligned yellow-green boxes laid
along a hedge top. Measured on the shot, a sprig's top face against the hedge top face 30 cm
away under the same sun:

| | mean luma | mean rgb |
|---|---|---|
| a sprig's top face | **96.9** | 87, 106, 39 |
| the hedge top beside it | **21.2** | 16, 24, 6 |

**4.6:1.** The first hypothesis was that the flat colour `0x86ab55` had gone stale when Task 9
swapped the procedural hedge bake for the ambientCG *Moss002* albedo. **That hypothesis was
wrong and is recorded as a dead end**: `0x86ab55` is within 6% of the procedural hedge's own
`HEDGE_LIGHT` (`0x74a54e`) — exactly the "shade lighter and yellower" its comment claims. The
colour was never the defect.

A source audit found the real one. `MazeBatches` sets `batch.receiveShadow = true` on **all
seven** families; `buildBoxInstances` sets it on every mover. The sprig instancer was the only
opaque mesh in the world that did not, and its comment justified `castShadow` and said nothing
about receiving. On levels 0–2 the entire maze stands under the floor above and is therefore in
shadow — so the hedge was shadowed and the growth on top of it could not be.

### 2.4 Ivy: thick green bricks standing on the stone

`before-ivy-front.jpg`. A `BoxGeometry` flattened to 4.5 cm on the wall normal is a rectangular
slab, and a strand of them is a stack of them. The shot also *read* as though the leaves floated
clear of the stone — **the arithmetic contradicted that** and it was not acted on: the leaf
centre sits `thin + 0.03` from the panel face with a half-thickness of 0.0225, so it stands
0.75 cm proud of a 10 cm leaf. Just proud of the face is what the code and its test both ask
for. Left alone.

### 2.5 A quarter of the growth was never rendered anywhere anyone could see it

Foliage sank a **flat 0.16 m** into the hedge. A sprig's half-height is `0.25 · s · 1.4 = 0.35 s`
and `s` ranges 0.34–0.84, so every sprig with `s < 0.457` had its entire silhouette below the
hedge top. Counted over nine districts of seed 2026: **7,585 of 32,373 sprigs — 23.4% — were
built, instanced, drawn every frame, and entirely inside an opaque box.** No error, no warning,
and no failing test: `maze-foliage.test.mjs` checks that a sprig sits *at hedge-top height*, and
a buried sprig does.

This is `art-citadel`'s 200 houses with their window recesses painted 16 cm inside a solid box,
in a different world. Looking for it here was the direct result of reading that branch's report.

### 2.6 `SPRIG_OVERHANG` never overhung anything

A hedge is `HEDGE_THICK` 1.2 m, so 0.60 m of half-thickness. The constant allowed ±0.22 m of
offset and the widest a sprig ever was in plan is `0.25 · 0.84 = 0.21` m. 0.43 m against 0.60 m:
in four phases of this world's life not one sprig had ever hung over anything. Renamed
`SPRIG_OFFSET`; no behaviour changed by the rename.

---

## 3. What was done

### 3.1 Authored — `leaf-tuft.glb`, 10 triangles (D4)

One geometry serves **both** the hedge-top sprig and the shaft ivy leaf, because
`buildSprigInstances` scales per instance: the hedge growth takes it at `(s, 1.4s, s)` and reads
as a tuft of shoots, the ivy squashes it to 0.09 on the wall's own normal and a squashed crown
is a ragged leaf with a central rib — which is what the ivy needed and what a squashed box could
never be.

It is authored to **exactly the 0.5 m bounding cube** of the `BoxGeometry(0.5, 0.5, 0.5)` it
replaces, so every scale in `MazeFoliage` keeps its meaning and this commit changes shape and
nothing else.

**Ten triangles, against the box's twelve.** That is not a coincidence and it is not "about the
same": at 75,646 instances in the resident set, the sprig's geometry is the one place in this
world where a triangle is worth 75,000 triangles, so the authored file had to be *cheaper* than
what it replaced or it could not ship at all. `maze-glb.test.mjs` holds it at `<= 12` as a hard
ceiling.

**The shape is a CROWN, and that is a correction made inside this branch.** The first authored
version was the obvious one — an irregular bipyramid, ring at the waist, apex top and bottom. It
was generated, wired, and photographed, and it read as **a row of little green traffic cones**
(`work-cones-sprig-three-quarter.jpg`). Two reasons, both visible only in the shot: a bipyramid
seen from any single angle is a clean triangle; and a sprig is mostly buried, so what a player
sees is not the tuft but its *tip*, and the tip of a bipyramid is the most cone-like part of it.

So the ring moved up to become the silhouette, and its five vertices took wildly different
heights instead of a small zigzag — shoot tips of five different lengths, with the notches
between them falling below the hedge line. The centre vertex sits *below* the mean of the ring,
so the top surface is a shallow irregular rosette rather than a point. Same ten triangles.

### 3.2 Authored — `hedge-candle.glb`, 70 triangles (D4)

Seventy candles per district — about 1,470 in the resident set — at chest height on the hedge
faces. They are the only *object* (as opposed to surface) a maze player ever stands next to and
the brightest thing in every corridor framing, and they were a glowing rectangular slab.

A seven-sided wax pillar with a melted lip and a flame, authored inside the candle descriptor's
own 0.18 × 0.52 × 0.18 dressing box so `buildAssetPrefab` refits it at scale 1.0. Seven, not
eight: an even ring presents a flat face square-on to a corridor that runs on the same axes the
hedges do, which is what the box already looked like.

**Everything is wax, and that is a constraint rather than a choice.** `MazeMaterials.candle` is
one emissive material for the whole prop and a batched prefab cannot carry a second, so an iron
bracket — which is what a wall candle would really have — would be an iron bracket glowing as
brightly as the flame.

**The reservation that would have thrown at boot.** `GEOMETRY_BUDGET.candle` was
`{ prefabs: 8, verts: 24, indices: 36 }` — exactly one box, with no headroom at all.
`BatchedMesh.addGeometry` throws at capacity rather than degrading, so adopting a 210-vertex
prefab against that reservation is not a visual regression, it is a crash in the first district
streamed, at boot. Raised to 256 / 384 and asserted against the real file.

### 3.3 The route, copied exactly

| | |
|---|---|
| generator | `scripts/make-maze-glb.mjs`, committed, `MAZE_GLB_ASSET` / `MAZE_GLB_OUT` overrides so the byte-diff test can re-run it into a temp file |
| manifest | `public/assets/maze/manifest.json` — id, file, kind, licence, source, tris, verts, bytes |
| loader | `src/worlds/maze/MazeAssets.js`, `MAZE_ASSET_PREFABS` gains `sprig` and `candle` |
| registry | `MazeMeshes.sprigGeometry()` / `prefabFor({ kind: 'candle', …, assets })` — glTF materials discarded on load, drawn with the maze's own cached material |
| licence | `generated`, a line each in `docs/assets/LICENCES.md` |
| test | `scripts/tests/maze-glb.test.mjs`, 17 cases |
| fallback | a missing file degrades to the procedural box, on the same descriptor, the same batch key and the same instance transforms |

### 3.4 The three geometry gates, and the one that was WRONG

The generator refuses to write a file that fails them, and `maze-glb.test.mjs` re-asserts all
three **against the committed bytes**.

1. **No degenerate face.** A zero-length normal is finite, valid glTF, and NaN the moment a
   shader normalizes it — `art-citadel` dissolved a gatehouse into a white cloud that way.
2. **Closed and consistently oriented.** Every directed edge, matched by *position* because flat
   shading duplicates vertices, occurs exactly once and its reverse exactly once.
3. **Positive signed volume**, so the orientation is outward rather than inward.

The winding gate started as the obvious one — "does this face's normal point away from the
shape's centre?" — and it **fired on the very first run**, on the candle's flame, whose
underside legitimately faces back down toward the middle. A star-shaped assumption is not true
of a candle. A gate that rejects correct geometry is worse than no gate, so it was replaced by
the three above, which admit exactly one answer and do not care what shape the solid is.

### 3.5 Procedural, corrected rather than replaced

- **`receiveShadow = true` on the sprig instancer.** Matching all seven batch families and every
  mover. This, not the colour constant, is what closed the 4.6:1 (§2.3).
- **A proportional sink.** `SPRIG_SINK` is a fraction of each sprig's *own* half-height, so the
  23.4% burial cannot come back at any scale. Its value (0.15) is set by the authored tuft's own
  outline: the top three shoot tips clear the hedge by 4–25 cm and the bottom two fall below it,
  so the line is broken by a ragged row with notches in it.
- **The full circle of yaw.** Half a turn was right for a box, whose plan repeats every quarter
  turn. The tuft has no symmetry at all, so half the variation was being thrown away.
- **A seeded lean.** Every sprig in this world stood exactly upright until now. **Ivy
  deliberately does not lean** — its whole placement argument is that the leaf's thin axis stays
  on the wall's normal, and a lean is precisely the rotation that takes it off.
- **The candle flame light moved up 5 cm**, from `cd.y + 0.18` to `cd.y + 0.23`, so it sits
  inside the flame instead of 8 cm below the top of what used to be a featureless slab.
  Intensity, colour and range untouched.
- **One geometry instead of twenty-one.** `buildSprigInstances` used to allocate and dispose a
  `new THREE.BoxGeometry(0.5, 0.5, 0.5)` **per resident district**, rebuilt on every residency
  change. It now takes the registry's shared tuft, which `MazeChunks`'s release paths already
  skip. `renderer.info.memory.geometries` fell from 379–404 to 360–377.

---

## 4. The budget

Three runs each way, same machine, same order, `gameplayDriven: true`. Ranges, because §0.

**Seven** base runs and **three** after runs, and the base runs are not a memory: after the work
was committed, the base commit `a7734ed` was checked out into this same worktree and re-run
three more times, the `art-citadel` protocol, so both distributions come from the same machine
under the same conditions.

### 4.1 The lines that must not move

| | before (7 runs) | after (3 runs) | verdict |
|---|---|---|---|
| **materials** | 14–18 | 15–18 | inside the noise floor |
| **renderables** | 46–92 | 50–78 | inside |
| **instancedMeshes** | 32–78 | 36–64 | inside |
| **worldLights** | 525 ground / 675–950 tower | 525 ground / 675 tower | inside |
| **shader programs** | 232–233 | **233**, every framing of every run | inside |
| `renderer.info.memory.geometries` | 373–417 | **361–385** | **down** — one shared sprig geometry instead of one per resident district |

The **program** line is the one this phase is gated on, and it is 233 in all fifteen framings of
the three shipped runs, against a base that reads 232 or 233. One caveat recorded rather than
buried: two INTERMEDIATE runs of this branch — the rejected bipyramid build of §3.1 — reported
**269** and **261** at `tower-top` while reading 233 at every other framing. It was chased. It
did not reproduce: three runs of the shipped build read 233 at `tower-top`, as do all seven base
runs. `programs` is `renderer.info.programs.length`, a cumulative live cache whose value depends
on the order in which materials first entered a frustum, and `tower-top` is the one framing that
teleports the player onto another level and streams a fresh district set of a re-rolled maze.
Nine samples are on the record; two of them are unexplained.

The stronger statement is headless and deterministic, and does not depend on any of the above:
`maze-materials.test.mjs` holds every material in the built set to `MAZE_PROGRAM_FAMILIES` by
name, and that list is **unchanged by this branch**. A new program can only come from a new
feature-set, and there is no new feature-set — both authored assets are drawn with cached
materials that pre-date this work.

### 4.2 Draw calls and triangles, per framing

| framing | draw calls before | after | worldTriangles before | after |
|---|---|---|---|---|
| `forecourt` | 310–338 | 280–364 | 897,370–972,002 | **762,918–806,068** |
| `corridor` | 178–256 | 218–244 | 853,950–921,662 | **726,832–751,046** |
| `above-entrance` | 186–246 | 192–232 | 940,482–1,027,554 | **798,830–842,070** |
| `shaft-up` | 129–165 | 135–145 | 431,766–820,408 | 295,430–474,396 |
| `tower-top` | 153–241 | 155–188 | 822,496–1,339,364 | **727,986–764,100** |

Draw calls overlap everywhere — as they must: nothing here adds or removes a mesh. Triangles are
**cleanly separated** at four of the five framings (the after maximum is below the before
minimum); `shaft-up` overlaps, and `shaft-up` is also the framing whose base range spans 1.9:1
on unchanged code.

### 4.3 The triangle number the browser reports is NOT the triangle number

`src/dev/WorldTriangles.js` counts a `BatchedMesh` as **one** instance:

> *BatchedMesh reports its own per-instance visibility; without walking its internals the honest
> answer is "one geometry's worth per drawn instance", and three exposes no public count, so
> fall back to 1 rather than guess.*

The maze is the only world that uses `BatchedMesh`, and it draws its entire static structure
through seven of them. Worse: `geometryTriangles` honours `drawRange`, and a `BatchedMesh`
publishes its whole **reserved** index buffer — so what the harness reports for a batch is the
size of its `GEOMETRY_BUDGET` reservation. The material naming of §2.1 makes this visible for
the first time, in the `byMaterial` breakdown of an after run:

```
maze.foliage  683,280  (19 objects)   <- real: 19 InstancedMeshes x count x 10
maze.ivy       33,680  (4)            <- real
maze.newel     13,312  (1)            <- the STONE batch's reservation, 26 x 1536 / 3
maze.floor     12,672  (1)            <- the FLOOR batch's reservation
maze.hedge      1,408  (1)            <- the HEDGE batch's reservation
maze.candle     1,024  (1)            <- the CANDLE batch's reservation, 8 x 384 / 3
```

Before this branch that whole table read `MeshStandardMaterial: 888,094 across 40 objects`.

Two consequences, both stated rather than glossed. The candle cost is invisible to the browser
figure — it sees **+928** (the reservation rising from 8×36 to 8×384 indices) where the real cost
is +85,260. And the harness's whole-world triangle number for the maze has never included the
static maze at all.

Both numbers are reported and neither is allowed to stand for the other.

### 4.4 The true delta, computed off the pure modules

21 entrance-resident districts, 8 seeds, means:

| | instances | before | after | Δ |
|---|---|---|---|---|
| hedge sprigs | 75,646 | 907,752 | 756,460 | **−151,292** |
| ivy leaves | 4,476 | 53,712 | 44,760 | **−8,952** |
| candles | 1,470 | 17,640 | 102,900 | **+85,260** |
| **total** | | **979,109** | **904,124** | **−74,985** |

Range across seeds: −82,000 … −69,822. **Triangles went down**, and the sprig's two-triangle
saving is what paid for the candle.

### 4.5 What the art actually did, measured on the pixels

Mean luma is the wrong instrument for "does this object have form" — it is the same number
whether a tuft is a cube or a crown. Edge energy is the right one. Same close-up framing logic,
same 2.4 m subject distance, whole frame:

| `sprig-three-quarter` | before | after |
|---|---|---|
| mean luma | 34.78 | 35.19 |
| mean saturation | 0.504 | 0.535 |
| **mean gradient magnitude** | **2.083** | **3.438 (+65%)** |

The lighting did not change. The surface did.

And the defect of §2.3, on the two surfaces that sit 30 cm apart under the same sun:

| | before | after |
|---|---|---|
| a sprig's face | luma 96.9 | luma 22.4 |
| the hedge top beside it | luma 21.2 | luma 14.9 |
| **ratio** | **4.57 : 1** | **1.50 : 1** |

1.50:1 is what `MazeMaterials.foliage`'s own comment has claimed since Phase 5 — *"a shade
lighter and yellower than the hedge itself so it reads as new growth against clipped body"* —
and it is the first time the world has actually drawn it.

### 4.6 And nothing else moved

Whole-frame statistics, before and after, on the framings this pass did not aim at:

| | before | after |
|---|---|---|
| `above-entrance` luma / saturation | 145.17 / 0.152 | 145.08 / 0.151 |
| `forecourt` luma / sat / gradient | 50.86 / 0.506 / 6.228 | 51.04 / 0.516 / 6.226 |
| **clipped pixels, every framing** | **0.00%** | **0.00%** |

The forecourt is authored geometry with no sprigs and no candles in it, and it reads identically
to three significant figures. Nothing in this pass went near the grade, and nothing clips.

---

## 5. What was deliberately NOT done

### 5.1 `VIEWS.maze`'s `lift-car` framing — a gate that measures something the game does not do

The very first before-shot of this branch **aborted**:

```
Error: harness: could not compute view "lift-car"
```

`Harness._findLiftFraming` scans the resident districts for a cell whose emitted connector is a
lift and returns `null` when there is none — and `world-shot.mjs` then throws before writing
`report.json`, losing the whole four-minute run. Probed headlessly over 40 seeds against the
21 districts the world actually streams at the entrance:

| | mean per resident set |
|---|---|
| cells with an UP link | 5.4 |
| …emitting a staircase | 4.4 |
| …emitting a lift | **0.9** |
| …emitting a tunnel | **0.0** |
| **seeds with no resident lift at all** | **16 of 40 — 40%** |

So the maze's own art-pass evidence harness has a **40% chance of producing no evidence**, and
the framing that does it is second-to-last in the list. **Not fixed: `src/dev/Harness.js` is
outside this branch's file boundary.** It wants either a `null`-tolerant skip in `world-shot`
or a framing that does not depend on a 15%-weighted connector landing inside a 21-district
window. Every run in this document was taken with `--views` naming the other five.

### 5.2 The pollen

`MazeWorld._buildPollen` draws 900 `THREE.Points` with no map, which three renders as **hard
squares**. Its own comment records that brightness and size were already reduced once for
exactly this complaint (*"reads as falling snow — or worse, as sensor noise on the lens"*), and
photographed at 100% they still read as hard cream squares.

**Measured before touching it**, using the ablation the naming in §2.1 made possible: pollen owns
**2,064 px of a 1,440,000 px frame — 0.14%**. That is `art-dock`'s bloom, in a different
costume: a still frame at 100% zoom is the wrong instrument for a system whose own comment says
*"the motion is what sells it"*, and a shape change on `PointsMaterial` is a program-key change
made on a screenshot read for a seventh of a percent of the frame. Refused.

### 5.3 The ivy standoff

See §2.4. The shot read as floating; the arithmetic says 0.75 cm proud of a 10 cm leaf, which is
what the code and its test both ask for. A change here would have been tuning on a misread.

### 5.4 Anything shared

| | Why |
|---|---|
| **`GRADE_PRESETS` / bloom** | Shared rendering code. 0.00% of pixels clip in every framing measured, before and after. |
| **The `Loot.js` white orbs** | Shared by nine worlds; diagnosed and deliberately left by `art-medieval` and `art-dock` for the staging reason brief 4.1.7 gives. |
| **A wider `BatchedMesh` port** | Forbidden by the roadmap, and there is nothing to win: this world is already one batch per material family. |
| **`SPRIGS_PER_HEDGE`** | Nine per segment is a density, and the before-shots say the density was never the problem — the shape and the shadow were. Changing it would have made the triangle table look better while making the hedge line straighter. |
| **The hedge, floor, stair and footing surfaces** | Photographed at 2.6 m (`before-candle-three-quarter.jpg`): the Task 9 KTX2 sets read beautifully and the normal maps are doing real work. Nothing in these shots contradicts them. |

---

## 6. Gates

| | |
|---|---|
| `npm test` | **3034 pass, 0 fail** (3012 before; +22 — 17 in `maze-glb.test.mjs`, 5 in `maze-sprig-placement.test.mjs`) |
| `node scripts/contract-check.mjs` | **129/129 files present, all contracts satisfied** |
| `npm run build` | **green** |
| licence | two `generated` entries, one ledger line each, byte-diff enforced |
| screenshots | `docs/superpowers/specs/img/2026-08-23-art-maze/` |

## 7. For the next branch through here

1. **`--views` must exclude `lift-car`** or the run has a 40% chance of dying at framing four of
   five with nothing written. §5.1.
2. **Take at least three runs each way.** §0. One pair proves nothing in this world.
3. **`worldTriangles` for a batched world is not the frame's triangle count.** §4.3. If any other
   world ever adopts `BatchedMesh`, its triangle budget stops being measurable by this harness on
   the day it does.
4. **Name your world's materials.** It costs nothing, it is not in the program cache key, and it
   is the difference between `--ablate` working and `--ablate` throwing. §2.1.
5. **Check the batch reservations before authoring into a batched world.** A `GEOMETRY_BUDGET`
   entry sized to exactly one box is a boot-time throw waiting for the first `.glb`. §3.2.
6. **Do not use a star-shaped facing gate in a generator.** Use closed-manifold plus signed
   volume — it is exact, it needs no assumption about the solid, and it does not reject correct
   geometry. §3.4.
