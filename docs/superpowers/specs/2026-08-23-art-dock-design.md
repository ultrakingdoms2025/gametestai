# Phase 9 · `art-dock` — Lodestar Yard art pass

**Branch:** `art-dock` (worktree). **Roadmap:** Phase 9, decision D4 (hybrid).
**Budget gate:** Phase 1's. Draw calls, triangles, materials and **shader programs**
measured before and after, in the same 24 framings, by the same script.

**Evidence:** `docs/superpowers/specs/img/2026-08-23-art-dock/` — `apron-arrival`, `chandlery`,
`keel-line`, `datum` and `yard-wide`, before and after. The pair that carries this pass is
`before-chandlery.jpg` / `after-chandlery.jpg`: the same drum, the same lamp, the same
exposure, 58% more edge energy. The pair beside it is `before-apron-arrival.jpg` /
`after-apron-arrival.jpg`: the first frame a player ever sees of this world, with the cyan
mat taken out of the floor and left in the two brass beads it belongs to.

---

## 1. Method

The roadmap's line is *"Never assess art by reading code — screenshot it."*
`scripts/world-shot.mjs`, written for the `art-medieval` pilot earlier today, is used
unchanged: real Chrome over CDP against a real Vite server, 24 framings at 1600×900,
`gameplayDriven: true`, hardware GL (`ANGLE … RTX 5080 … D3D11`), and the budget taken in the
same pass as the picture.

One thing had to be added before it could be *used* on this world, and it is written up in
§3.1: the yard's materials were anonymous, and `--ablate` identifies materials by name.

Frame statistics quoted below (mean luma, mean saturation, clipped %, dark %) are computed
off the committed PNGs.

---

## 2. What the before shots showed

`.probe/art-dock/before/`, 24 framings. Whole-frame means ran 24.2–122 luma at saturation
0.16–0.35, **0.00% clipped pixels in every framing** — so the first hypothesis on walking
into the `trench` shot ("that is a bloom blow-out, like the CC0 roughness map the roadmap
warns about") was wrong and is recorded here as a dead end rather than acted on. The trench
is warm and hazy; it is not clipping anywhere.

The yard's **structure, lighting and sky are strong** and are not the subject of this pass.
The roof truss carries every wide framing, the pier framings over vacuum with three lit
bodies behind them are the best pictures in the world, the bay mouth reads, and
`DockWorld._buildLights` has already had a documented lighting pass with a measurement
behind every number.

It is also **already merged-by-material**: 86 materials across **166 renderables**, one
`GeoBatch` bucket per material key for the whole yard, plus 17 `InstancedMesh` systems and
762 instances. That is the citadel case, not the sports case. **There is no draw-call win
here and no `BatchedMesh` port to make** — the roadmap forbids the latter and the
measurement says the former does not exist.

Three things the shots did show.

### 2.1 The hull sections — the world's premise, drawn as a black pipe

`DockWorld`'s own header says what this place is:

> *Lodestar Yard does not BUILD ships, it re-assembles them. Nothing bigger than a gateway
> arch has ever come through a gateway, so every hull here arrived in sections narrow enough
> to walk through a portal and was pinned back together on a cradle.*

Those sections are `YardPlan.SECTIONS` — three drums 6.2 to 8.8 m across and 11 to 16 m long,
on jigs in the middle of the floor. They are the **largest props in the yard** and they are in
shot from `chandlery`, `datum`, `yard-wide`, `crane-cab` and `keel-line`.

Measured on the biggest of them in `chandlery` (a 0.24 × 0.20 crop over the drum):

| | mean luma | mean sat | pixels under 48/255 |
|---|---|---|---|
| the drum | **39.1** | **0.193** | **85%** |
| the whole frame | 42.3 | 0.298 | — |

A flat dark mass with a 1.4:1 range across nine metres of diameter. The source says why:

```js
const drum = new THREE.CylinderGeometry(s.r, s.r, s.len, 16, 1, true).rotateX(Math.PI / 2);
put('plate', drum, s.x, cy, s.z, s.yaw);
for (let i = 0; i <= s.frames; i++) put('steel', new THREE.TorusGeometry(s.r + 0.06, 0.13, 6, 20), …);
```

A sixteen-sided smooth tube with doughnuts on it, open at both ends — so backface culling
removes the far wall and you look clean through the object this world is named for. The
"bolted string course at every section joint" its comment claims has never been drawn.

### 2.2 The keel line — the world's own colour script, broken by its own wayfinding

`apron-arrival` is the framing whose comment says *"if this framing is not legible, nothing
else in the yard gets looked at"*. The keel line runs across its near half. Measured inside
the strip:

| | mean luma | mean sat | mean rgb |
|---|---|---|---|
| the keel strip | **66.8** | **0.498** | 43, 72, 86 |
| the whole frame | 46.7 | 0.310 | 42, 47, 55 |

The strip is 1.43× the frame's luma and **1.6× its saturation**, and it is 8 m wide and 160 m
long — a third of the visible floor, not an accent. `YardTextures.buildYardMaterials` states
the rule out loud:

> *Sodium OVER cyan, which is the yard's whole colour script … cyan is reserved for wayfinding
> — the keel line, the berth numbers, the gateway ring — and runs below them so the shed never
> reads as one cyan chord.*

Photographed, the apron half does not read as chalk struck on concrete. It reads as a lit
panel let into the floor.

### 2.3 The white blobs at distance — known, and NOT this branch's

Present here as they are in medieval: hard white orbs in `apron-arrival`, `keel-line`,
`office-inside`, `trench` and `bastion-ribs`. Diagnosed by the `art-medieval` pass by
ablation and projection probe as `src/systems/Loot.js` — four stacked additive/emissive
layers at `emissiveIntensity` 2.6, all `fog: false`. Shared by nine worlds. **Deliberately
not touched**, for the same reason it was not touched there: brief 4.1.7 stages this phase
one world at a time to reduce risk, and a cross-world change to pickup rendering made from a
single world's art branch is precisely the risk staging exists to prevent.

---

## 3. What was done

### 3.1 Every yard material now carries its name

`--ablate` hides meshes **by material name**, and it is the only tool in this repository that
can answer "which system drew this pixel". Run against the yard before this pass it had
exactly one name to offer (`yard.stars`, set by hand in `_buildVoid`), and every report's
`materialNames` read:

```
116  MeshStandardMaterial
 23  ShaderMaterial
 22  MeshBasicMaterial
  4  MeshPhysicalMaterial
  1  yard.stars
```

— a census of the constructor. `buildYardMaterials` now closes with
`for (const [key, m] of Object.entries(M)) m.name = 'yard.' + key;`, and `mat.emPier`, which is
declared outside that function, names itself. Three's program cache key is built from material
type, parameters and defines (plus `customProgramCacheKey`, which the emissive family sets);
`name` is not in it, and the measurement below confirms the program count did not move.

`yard-assets.test.mjs` holds the name to the key, because a material that silently loses its
name does not break the game — it breaks the next art pass, by letting an agent conclude a
system is innocent when the ablation never hid it.

### 3.2 Authored — the three hull sections (D4)

The one object in this world that earns authoring, and the one whose primitive is *right*.

Unlike the Kestrel — whose problem was that a box kit cannot make a hull at all — a hull
section IS a drum. What a runtime primitive kit cannot express is the detail that makes a drum
read as plating pinned to frames:

- **Lapped strakes.** Twenty-four plates round the girth, alternate ones standing 40 mm proud,
  so every strake has two edges down its length. Edges are what a raking sodium lamp catches;
  a smooth tube has two lit bands and nothing between them, which is the 1.4:1 range in §2.1.
  `CylinderGeometry` cannot have an interior edge — its radius is one number.
- **Flanged ring frames instead of doughnuts.** A torus is round in section; a ship frame is a
  flat bar with a web and two corners, and the corners are the read.
- **An interior.** The joined end closes on a transverse bulkhead — which is what the next
  section pins to — and the cut end opens on a collar frame, eight stringers and a lining you
  can see. Today both ends are open and the section is a shell you see through.
- **A bolted string course at every frame line**, eight studs a ring, which the world's own
  comment has claimed since drop one.
- **A cut edge that is cut.** The rim is scalloped by a seeded jitter, so a section separated
  with a cutting frame does not come apart on a perfect circle. Seeded off the section id, so
  the three tear differently and each tears identically every run.
- A pressure hatch with a coaming and two dogs on the starboard flank, and skid pads at the
  keel where the jig's saddles take the weight.

The route is the one proven four times, changed in nothing:

| | |
|---|---|
| generator | `scripts/make-yard-glb.mjs`, committed, `YARD_GLB_SECTION` / `YARD_GLB_OUT` overrides so the byte-diff test can re-run it into a temp file |
| plan | `SECTIONS` is **imported** from `dock/YardPlan.js`, not copied (the `make-beast-glb` pattern, not the older `make-ship-glb` one). Change a radius in the plan and the byte-diff goes red telling you to regenerate |
| manifest | `public/assets/dock/manifest.json` — id, file, kind, licence, source, parts, tris, bytes, plus `sections` |
| loader | `src/worlds/dock/YardAssets.js`, a near-copy of `medieval/BeastAssets.js` **by intent** |
| licence | `generated`, with a line each in `docs/assets/LICENCES.md` |
| test | `scripts/tests/yard-assets.test.mjs`, 22 cases |
| fallback | a missing file degrades to the procedural drum, on the same `cy`, the same collider and the same batch keys |

**The cost rule, and why it is stronger here than anywhere it has been applied before.**
A mesh's NAME is a **yard material key**. `DockWorld` batches the entire yard through one
`GeoBatch` keyed on those same names, so an authored part does not merely reuse a material —
it merges into the single mesh the yard already draws for that bucket:

> no new draw call, no new material, no new shader program, no new scene node.

That is checked three times over, because a bucket with no material behind it is not a wrong
colour: `GeoBatch.flush` ends in `new THREE.Mesh(merged, materials[key])`, and three replaces
an undefined material with a default white `MeshBasicMaterial` — a new draw, a new material
and a new program, silently. The loader's allow-list is the first gate, `DockWorld` re-checks
against the live `this.mat` before it puts anything, and the test reads the material set off a
**real built `DockWorld`** rather than off a constant.

#### The winding gate, which earned itself inside this pass

`Quads.quad` takes an optional `expect` vector: the direction the face is supposed to be seen
from. The normal is computed and the build **throws** if it points the other way.

It exists because the first build of these sections shipped the cut-end collar wound
backwards, and the picture just looked a bit flat. A backfacing quad is not wrong-looking, it
is *absent*, and a surface missing from a 1600×900 shot of a 9 m drum at 20 m is not something
a screenshot review reliably catches. The transverse bulkhead's two faces were also inverted
in depth.

It earned itself a second time immediately: re-deriving the plate laps by hand in a comment
"corrected" twenty-four quads that had been right, and the gate rejected the correction on the
next run. Three lines of cross product in a comment is not a check; a facing you can state is
a facing a machine can check.

### 3.3 The keel line, desaturated

`0x7fd8ef` → `0x9fb4c0`, in one module constant (`KEEL_PAINT`) because the line is struck by
two methods 400 m apart and a keel line that changes colour at the bay mouth is a defect
visible in a single screenshot — `mouth-inside` frames both halves at once.

Saturation-only: **0.469 → 0.171** at the source colour, value held. Dimming it would have
cost the legibility this is defending; a chalk strip *is* lighter than plate. The chroma moves
to the two things meant to carry it — the `emCyan` brass inlay beads down both edges of the
strip, and the pier edge run — both unchanged.

### 3.4 A stale comment about which way the crane cab is open

Not art, found while reading the crane for the `crane-cab` framing, corrected because a wrong
comment is how the next person breaks something. `_buildCrane` said *"the cab's open side
faces -X, out over the bay … and it is the ONLY side without a rail"*, and both halves were
wrong about the geometry immediately above them: the two `railRun`s guard ±Z, so **both** X
faces are open; the walkway spur arrives from `CRANE_WALK.x` = −74.4 at the **−X** face, and
the viewpoint's `launch` is at `CRANE_CAB.x + 1.4` bearing on `SPARES_PILE` at x −64.5, so
**+X** is the open side over the bay. Left as it was, the next person to move a rail would
have railed the launch.

---

## 4. What was deliberately NOT done

| | Why |
|---|---|
| **The `Loot.js` white blobs** | Shared by nine worlds, diagnosed and left by `art-medieval` for the same staging reason. §2.3. |
| **A `BatchedMesh` port** | Forbidden by the roadmap, and the measurement says there is nothing to win: 86 materials over 166 renderables is already merged-by-material. |
| **Anything about bloom or the grade** | `GRADE_PRESETS.dock` is calibrated against this world's measured linear luminance and lives in shared rendering code. The measurement that would have justified touching it — clipped pixels — is **0.00% in all 24 framings**. |
| **Re-lighting the yard** | `_buildLights` has had a documented pass with a measurement behind every lamp, including the flank-bracket fix found by probing a vertical normal. Nothing in these shots contradicts it. |
| **The `crane-cab` framing** | It reads as a camera in a box, and it is not: the dark planes either side are the cab's own back panel and glazing 1.5 m from the lens, which is what a player standing there sees. A framing changed because a reviewer misread it would be a gate measuring something the game does not do. |
| **Authoring the Bastion's ribs, the crane, or the chandlery counters** | D4 says hero assets only. One object in this world is the world's premise; the others are set dressing, and 371 KB of lazily-loaded geometry for the three that matter is the whole hybrid argument. The Bastion is also excluded from `WALKABLE`/`FLYABLE` with `bastion-rib` reserved and unpublished — a hulk is allowed to read as scrap. |
| **The apron half of the keel line being one unbroken field** | Real, visible, and a geometry change rather than a colour one. Recorded here; the desaturation was the measured defect. |

---

## 5. The budget

24 framings, same order, same machine, `gameplayDriven: true`, `ANGLE … RTX 5080 … D3D11`.

### Per-framing deltas — identical in all 24 except triangles

| | before | after | Δ |
|---|---|---|---|
| **materials** | 86 | 86 | **0**, every framing |
| **renderables** | 166 | 166 | **0**, every framing |
| **instancedMeshes** | 17 | 17 | **0**, every framing |
| **worldLights** | 186 | 186 | **0**, every framing |
| **shader programs, terminal** | **490** | **490** | **0** |
| **draw calls** | — | — | 0 in 19 of 24; ±1 to ±15 in the rest |
| **worldTriangles** | 163 282–230 601 | 162 216–230 351 | **−250 in 21 of 24** |

### Triangles went DOWN

The authored sections are **250 triangles cheaper than the drums they replace**, in every
framing, and that is not a rounding — it is the same number every time because
`HARNESS.worldTriangles()` walks the whole world group rather than the frustum:

| | triangles |
|---|---|
| procedural: three open cylinders (16 seg) + 21 `TorusGeometry` frames at 6×20 | 5,376 |
| authored: 1,634 + 1,858 + 1,634 | **5,126** |

Six smooth toruses a section were spending more geometry than the entire authored build. A
`TorusGeometry(r, t, 6, 20)` is 240 triangles for a bar that reads as a bar; sixteen flat
segments with a web and two corners is 96 and reads as a frame.

The three `-in` framings show −1,066 rather than −250. That extra 816 is the ship interiors'
`DistanceLod` in a different band between the two runs; it is run-to-run variance in a system
this branch did not touch, and it is the reason the harness records `gameplayDriven` next to
every figure.

### About the shader-program column

`programs` is `renderer.info.programs.length` — a **cumulative live cache**, so its
per-framing value is a function of the order in which materials first entered a frustum, and
that order is not identical between two runs of a world with streamed NPCs. The intermediate
values do diverge (e.g. `office-inside` 275 → 358). **The terminal count is 490 in both runs
and the maximum is 490 in both runs**, and the material count is 86 in every single framing of
both.

The stronger statement is headless and deterministic:
`yard-assets.test.mjs` builds the real `DockWorld` twice — once with the committed geometry
installed and once without — and asserts the two worlds have **the same mesh names, the same
material set and the same collider count**, with triangles the only thing permitted to move.
A new program can only come from a new material, and there is no new material.

### What the art actually did, measured

Mean luma is the wrong instrument for "does this object have form" — it is the same number
whether a nine-metre drum is a smooth tube or a plated shell. Edge energy is the right one.
Same 0.24 × 0.20 crop over the biggest section in `chandlery`, same exposure:

| | before | after |
|---|---|---|
| mean luma | 39.08 | 38.14 |
| mean gradient magnitude | **3.875** | **6.116** (+58%) |
| sd luma | 27.26 | 25.17 |

The lighting was never the problem, and it did not change. The surface did.

And the keel strip in `apron-arrival`:

| | before | after |
|---|---|---|
| mean saturation | **0.498** | **0.139** |
| mean luma | 66.8 | 55.7 |
| whole-frame saturation | 0.310 | 0.271 |
| the ground, lower third | rgb 49, 58, 65 · sat 0.259 | rgb 54, 52, 55 · sat 0.119 |

Whole-frame means move by under 3% everywhere and by nothing at all (to two decimal places) in
the fourteen framings the keel line is not in — `trench` reads 55.79 / 0.349 in both runs.
Nothing else in this world was touched, and the numbers say so.

---

## 6. Gates

| | |
|---|---|
| `npm test` | **2980 pass, 0 fail** (2958 before; +22 from `yard-assets.test.mjs`) |
| `node scripts/contract-check.mjs` | **129/129 files present, all contracts satisfied** |
| `npm run build` | **green**, 856 ms |
| licence | three `generated` entries, one ledger line each, byte-diff enforced |
| screenshots | `docs/superpowers/specs/img/2026-08-23-art-dock/`, five framings before and after |
