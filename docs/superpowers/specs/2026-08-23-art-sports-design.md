# Phase 9 · `art-sports` — Meridian Athletic Grounds art pass

**Branch:** `art-sports` (worktree). **Roadmap:** Phase 9, decision D4 (hybrid).
**Budget gate:** Phase 1's. Draw calls, triangles, materials, renderables, instanced meshes,
world lights and **shader programs** measured before and after, in the same framings, by the
same script, on the same machine.

**Evidence:** `docs/superpowers/specs/img/2026-08-23-art-sports/`. The pair that carries this
pass is `before-crowdplaza-three-quarter.jpg` / `after-crowdplaza-three-quarter.jpg`: four
metres from the four figures a player meets first, the same light, the same exposure. The
salute is gone, the plank through the hips is a bag on a strap, every head has hair, and every
sleeve and every trouser ends in something. The pair beside it is
`before-crowdseat-three-quarter.jpg` / `after-crowdseat-three-quarter.jpg` — 382 spectators
who were 382 identical bare scalps.

---

## 1. Method, in the order the brief insists on

**Measure the architecture first.** `scripts/world-shot.mjs`, used unchanged, over all eight
`VIEWS.sports` framings at 1600×900, `gameplayDriven: true`, hardware GL
(`ANGLE … RTX 5080 … D3D11`).

The roadmap already knew the answer to the structural question and it was right: **112
materials for 334 meshes is deliberate spatial partitioning, not a batching opportunity.**
That is confirmed, not re-derived, and no `BatchedMesh` was ported. There is no draw-call win
in this world.

What the architecture run gave that the roadmap did not was *where the triangles are* — and
that only became readable after §3.1. See §2.1.

**Then photograph the subject.** The eight named framings are all landscape. The crowd is the
largest system in this world and none of the eight is closer than 25 m to a figure, so three
subject framings were added on the command line (`--views none --subject`, `--dist 4`), three
headings each, at the bowl lip, in the bleachers and on the arrival plaza. Every defect this
pass fixes was invisible in all eight landscape shots and unmissable in the first close-up.

**Then author.** §3.2.

Frame statistics quoted below (mean luma, sd, saturation, clipped %, mean gradient magnitude)
are computed off the committed PNGs.

---

## 2. What the before shots showed

`.probe/art-sports/before/`, eight framings; `.probe/art-sports/before-subj/`, nine.

Whole-frame means ran 55–146 luma at saturation 0.15–0.37 and **0.00% clipped pixels in every
framing**, so there is no blow-out here and nothing about the bloom or the grade was touched.
`SportsWorld`'s environment block already carries a documented lighting and grade pass with a
measurement behind every number, and nothing in these shots contradicts it.

### 2.1 The crowd is 21% of this world, and it is a mannequin

With the materials named (§3.1) the harness's `byMaterial` stops being a census of class names
and becomes an attribution. On the pre-pass tree:

| material | triangles | share of `bowl-interior` |
|---|---|---|
| **`sports.crowd.cloth` + `sports.crowd.skin`** | **149,540** | **21.1%** |
| `sports.concrete.pad` | 85,204 | 12.0% |
| `sports.foliage` | 84,400 | 11.9% |
| `sports.grass.field` | 77,668 | 11.0% |
| `sports.hedge` | 72,960 | 10.3% |

The crowd is the largest system in the world by a factor of 1.75, and its size was not written
down anywhere: `_buildCrowd`'s own docblock said *"Six InstancedMeshes (three poses ×
clothing/skin) carry ~180 human-scale figures"* and had said it since before two poses and four
hundred people were added. The real figure is **ten meshes, five poses, 583 figures**, and it
is derived rather than counted by hand: skin is a flat 104 triangles per figure at every pose,
so 60,632 ÷ 104 = 583, and the five per-pose cloth counts (120, 120, 132, 168, 168) resolve
88,908 to exactly one set of populations — **stand 132, sit 382, lean 42, carry 19, crouch 8**.
Those five numbers are in `sports-crowd-assets.test.mjs` because every triangle figure in §5 is
one of them multiplied by a per-figure count.

Photographed at four metres, a figure was:

- **Bald.** `SphereGeometry(0.108, 8, 6)` and nothing else, on all 583. Under this world's
  single 14.1° key a sphere has no self-occlusion anywhere, so every head is the same smooth
  flesh ovoid balanced on a barrel. Measured on one head in `crowdplaza-three-quarter`: mean
  luma 67.8, sd 41.2 — and the sd is almost entirely the head-against-background edge, not
  anything on the head.
- **Handless.** Every arm ends in the flat six-sided cap of `CylinderGeometry(…, 6)`. Not a
  rounded stump — a visibly *cut hexagon*, which is worse, because a hexagon is a shape the eye
  reads as machined.
- **Shoeless.** Every leg ends in the same cut hexagon, flat on the concrete.
- **One flat colour.** `whiteColor()` writes 1.0 to every vertex, so a single `setColorAt`
  paints shirt, sleeves and trousers the same value. A monochrome body gives the eye no
  landmark anywhere between the shoes and the crown.

### 2.2 The salute and the plank — a defect nothing tests

The nineteen `carry` figures stand on the arrival plaza, which is the first thing a player sees
of this world. Their source says:

```js
// Standing, weight on one hip, kit bag over the shoulder.
cloth.push(limb(0.055, 0.05, 0.5).rotateZ(0.9).translate(-0.24, 1.3, 0.02));
cloth.push(new THREE.BoxGeometry(0.5, 0.24, 0.22).translate(-0.3, 1.02, 0.06));
```

Derived rather than eyeballed, that arm's ends are **(−0.436, 1.455)** and **(−0.044, 1.145)**:
the lower end is at the centre of the chest and the upper end is 44 cm out at shoulder height.
It is an arm raised straight out to the side. And the "kit bag" is a box **half a metre wide
along X** on a figure 0.44 m across, hung at the waist — so it projects 33 cm past one shoulder
and reaches the far hip. `before-crowdplaza-three-quarter.jpg` is nineteen figures giving a
salute with a plank through their hips.

This is the `art-citadel` shape — written once, never looked at, no error, no failing test —
except this one was not invisible. It was the largest single mass on the pose.

It is also a *latent* trap for the pipeline: the generator hangs a hand on a limb's −Y end, and
this was the one limb in the world whose −Y end is not the hand. Left alone it would have
welded a hand into an armpit and nothing anywhere would have said so.

### 2.3 Two of the eight framings measure something the game does not do

**`entrance-portal` photographs the STATION, in a black frame.** Its numbers are 225 materials,
1,354 renderables, 226 world lights and 3,099,100 triangles — none of which are sports'. They
are the station's, and the station's material names (`station.trim`, `station.panelDark`, …)
are what `materialNames` reports for that row. The page log records
`[World] built "station" in 96735ms` in the middle of a sports shoot.

The mechanism: the framing stands at (0, 3.5, 170), **behind** the gateway at (0, 0.42, 150),
and the harness teleports the player there. `Portals._autoEnter` fires on a *side change across
the portal plane* inside `ENTRY_R2`; a teleport from the previous framing's z = 142 to z = 170
at x = 0 is exactly that, so the player walks the gateway without ever having walked. Portal
`activationRange` is 2.0 m, so distance was never the issue — the crossing was.

**`track` photographs the CAR PARK, from off the edge of the world.**
`TRACK = { cx: 105, cz: -100 }`. The framing is `pos [128, 16, 232] look [128, 2, 162]` and the
harness's own comment says *"track (128,162)"*. (128, 162) is the middle of the car park — the
same rectangle `_buildCrowd` scatters six figures into with the comment `// Car park.` The
running track is 265 m away in the opposite direction. `defect-track-framing-is-the-car-park.jpg`
is the shot: the bottom half of the frame is empty fog because the vantage is past the terrain
skirt, and `evidence-the-real-track.jpg` is what is actually at (105, −100).

`harness-framings.test.mjs` cannot catch either. It fires a ray down every framing and fails
when the first thing it meets is further than that framing's declared `subject` distance — and
**not one of the eight sports framings declares a `subject`**, so the assertion is vacuous on
this world.

Both fixes are one line each in `src/dev/Harness.js`, which is outside this branch's file
boundary. **Not done** — see §4.

### 2.4 The white blobs at distance — known, and NOT this branch's

Present here as in medieval and dock: hard white orbs in `skatepark-wide`, `courts`, `pool` and
`track`. Diagnosed by `art-medieval` as `src/systems/Loot.js` — four stacked additive/emissive
layers at `emissiveIntensity` 2.6, all `fog: false`. Shared by nine worlds. **Deliberately not
touched**, for the reason it was not touched there.

---

## 3. What was done

### 3.1 Every sports material now carries its name

`--ablate` hides meshes **by material name**, and it is the only tool in this repository that
can answer "which system drew this pixel". Run against this world before this pass, every
framing's census read:

```
247  MeshStandardMaterial
 77  paint.enamel
  5  MeshBasicMaterial
  4  MeshPhysicalMaterial
  1  ShaderMaterial
```

— the constructor names, which is the harness's fallback when `name` is empty. One label in the
whole world, and it was not even this world's: `paint.enamel` is the shared library surface
`_metal` clones, and `Material.clone` copies `name`, so all 77 of those clones answered to one
name across eleven different systems. Ablating it would have hidden the rails, the goalposts,
the masts, the fencing, the lift towers and the plant at once and reported whichever you were
asking about as guilty.

Now: `_mat` names as it registers (`sports.<key>`, which renames the `_metal` clones to their
own keys); `_nameMaterials()` sweeps the library at the end of `build()`, which catches the
three families that mint one material per instance and register it directly (scoreboards,
kiosks, banners); and `_nameStrayMaterials()` is the backstop, naming anything left after the
nearest **named** ancestor rather than after its class.

`sports-material-names.test.mjs` holds all of it, including that both passes are still *called*
— a naming pass nothing invokes is the failure the unit tests cannot see.

Three's program cache key is built from material type, parameters and defines (plus
`customProgramCacheKey`); `name` is not in it, and §5 confirms the count did not move.

`--ablate sports.crowd.cloth,sports.crowd.skin` **matches** on this world now — it answers
`ablated: sports.crowd.cloth, sports.crowd.skin - 10 mesh(es) hidden`, which is an independent
confirmation of §2.1's "ten meshes, five poses" arrived at from a completely different direction
than the triangle arithmetic, and which before this pass would have been
`--ablate matched no material in "sports"`.

**And then it does nothing, which is worth more than the fix.** See §6.1: the hide is reported
and is not in the frame.

### 3.2 Authored — hair, hands and shoes for all five poses (D4)

The route proven six times, changed in nothing:

| | |
|---|---|
| generator | `scripts/make-sports-crowd-glb.mjs`, committed, `SPORTS_CROWD_GLB_SET` / `SPORTS_CROWD_GLB_OUT` overrides so the byte-diff test can re-run it into a temp file |
| plan | the pose table is **imported** from `src/worlds/sports/CrowdKit.js`, not copied (the `make-beast-glb` pattern). Move a sleeve length and the byte-diff goes red telling you to regenerate |
| manifest | `public/assets/sports/manifest.json` — id, file, kind, licence, source, parts, tris, bytes, plus `bind` and `sets` |
| loader | `src/worlds/sports/SportsCrowdAssets.js`, a near-copy of `station/CrowdAssets.js` **by intent** |
| licence | `generated`, with a line each in `docs/assets/LICENCES.md` |
| test | `scripts/tests/sports-crowd-assets.test.mjs`, 56 cases |
| fallback | a missing file degrades to the procedural figure, on the same materials, the same instance matrices and the same batch keys — and *with its end caps intact*, which is the point of §3.4 |

Three parts, and the reason each is one primitive rather than the station's two:

- **hair** — an 8×2 cap stretched 1.18 in z (the occipital bulge comes out of the scale rather
  than out of a second sphere) plus a fringe bar across the brow. 36 triangles. The fringe is
  the part that cannot be dropped: the cap's lower edge is a smooth circle lying *on* the
  skull, and a smooth circle at a grazing angle has no silhouette. A hard bar gives the hair a
  lower **edge**, and an edge is what a 14° key catches.
- **hand** — one box per side, 24 a figure. What makes a hand a hand at this distance is that
  the outline stops being a hexagon and starts being a rectangle wider than the arm.
- **shoe** — one raked box per side, 24 a figure. What makes a shoe a shoe is a mass that
  projects **forward past the ankle**, which no end cap of a vertical cylinder can do.

84 triangles a set, against the station's 240. The reason is arithmetic, not taste: this world
has **583** figures where the station has ~180, and its crowd is bulk set dressing at 8–60 m
where the station's is on the entry world's hero framings at 3–10 m. 240 here would be 140,000
triangles on a world measured at 511k–781k.

**The proportion decision, stated because it looks wrong written down.** The shoe is 0.19 m
wide. That is enormous for a foot and correct for *this* foot: the leg it caps has `r1 = 0.105`,
so the ankle is 0.21 m across and its hexagonal end face is 0.182 m flat-to-flat. A realistic
0.10 m shoe would leave the leg's own end sticking out either side of it, which is worse than
no shoe. The figure's proportions are the brief, not a human's — and the test asserts the shoe
is wider than the hexagon rather than "near the ankle", because that width is what §3.4 spends.

**Two gates the generator carries.** Every position must be finite and **every normal must be
unit length** — the `art-citadel` trap, where a degenerate quad yields a zero-length normal
that is finite, valid glTF, and NaN the moment a shader normalizes it. Nothing here builds a
quad by hand, but a scale with a zero component is one mistyped number away at all times. The
test re-asserts it **against the committed bytes**, because a gate that only runs in the
generator cannot see a file committed before the gate existed.

**The hair cap's clearance is a relation, not a constant.** The cap is 8 segments round and so
is the head, and both start at phi 0, so there is no sag in azimuth. In theta there is: two
rings over `0.58π` is 52.2° a ring, whose chord lies `1 − cos(26.1°)` = **10.2%** of the radius
inside the arc its vertices are on. `grow` is 1.13. Below 1.102 the skin stripes through the
hair in bands — the striped helmet `make-crowd-glb.mjs` records photographing on the station's
first attempt, invisible in source. The test holds `grow − 1 > sag + 0.02`, so raising the ring
count or lowering the clearance is fine and doing either alone is not.

### 3.3 Procedural — the value bands, the bag, the pose table

D4 is hybrid, and these are the bulk half.

**Value bands.** `BAND` in `CrowdKit.js`: torso 1.0, sleeve 0.90, trouser **0.52**, bag 0.40,
strap 0.34, written per limb as a constant vertex colour. Because `instanceColor` and `vColor`
multiply, a figure's trousers come out as a dark version of *its own* shirt. That is a
constraint accepted rather than an accident — the crowd draws through one instance-tinted
material and an independently chosen trouser colour would be a second material and a candidate
new shader program — and it is the same bargain `make-crowd-glb.mjs` accepted for the station's
hair. It costs **nothing**: same triangles, same material, same draw call.

**The bag.** 0.22 × 0.28 × 0.15 on the left front hip with one strap up across the chest to the
right shoulder, lying at z 0.155 so it sits *on* the 0.168-radius torso rather than inside it.
The raised arm now hangs with 0.10 rad of outward cant so the hand comes to rest against the
bag. The "carrying" read is the bag's job and the bag now does it. `carry` gained 12 triangles
a figure (228 across the pose) and lost a plank.

**The pose table.** The five poses were five hard-coded blocks of
`limb(...).rotateX(...).translate(...)` inside a closure inside `_buildCrowd`. They are data in
`src/worlds/sports/CrowdKit.js` now, and `crowdFigure()` is at module scope and exported. Two
reasons, both load-bearing:

1. the generator has to put a hand on the end of an arm, and two files typing the same 0.58 and
   the same 1.16 is the arrangement `make-beast-glb.mjs` stopped using;
2. a closure inside a method that needs a renderer, a physics world and a live texture library
   is a thing no `node --test` can reach — and lifting it out is what makes the whole budget
   argument in §5 assertable headlessly instead of only in a screenshot.

### 3.4 The caps the authored parts buy back

A `CylinderGeometry(r0, r1, len, 6)` is 24 triangles and **half of them are the two end discs**.
Once a shoe covers a leg's end face and a hand covers a sleeve's, those discs are interior
geometry that can never be seen — so those limbs are built `openEnded` and give twelve
triangles back each.

This is the `art-dock` lesson applied in the other direction: *check what the procedural version
actually costs before assuming authored geometry is more expensive.* Across 583 figures it
returns **25,428** of the 48,972 the authored parts spend.

Which limbs qualify was computed, not eyeballed, and each of them is a hole in the figure if it
is wrong (`openEnded` opens **both** ends, so one visible face disqualifies a limb):

| pose | opened | why the rest are not |
|---|---|---|
| `stand`, `lean`, `carry` | legs, arms | the torso's top face is the shoulder plate and only 46 mm of it is covered by the neck |
| `sit` | shins | its arms' shoulder end sits 0.33 m from the torso axis against a torso radius of 0.155; its thighs' rear cap sits just *below* the torso rather than inside it |
| `crouch` | nothing | its thigh and shin end faces are 30 cm apart in z — the limbs do not meet at all — and its shoulders sit clear of the torso |

**The neck is open at both ends under every condition**, with no authored part involved: its
bottom cap is inside the torso and its top cap is inside the head sphere by construction, at
every pose. That is 12 × 583 = **6,996 triangles that were never visible under any condition**.

**And the saving is gated on the part having actually landed.** `sportsCrowdHas(pose, 'shoe')`
is asked before a leg is opened, per pose. An open-ended leg with no shoe on it is a hollow
tube — strictly worse than the mannequin this pass set out to fix, and exactly the failure a
graceful degradation is supposed to prevent rather than cause. `sports-crowd-assets.test.mjs`
asserts the triangle count in **both** states.

---

## 4. What was deliberately NOT done

| | Why |
|---|---|
| **Fixing the two broken framings** (§2.3) | Both live in `src/dev/Harness.js`, outside this branch's file boundary. `entrance-portal` needs `keepPlayer: true` or a vantage on the park side of the gateway; `track` needs `pos [128, 22, -190] look [105, 2, -100]` or similar, and a `subject` distance so `harness-framings.test.mjs` stops being vacuous on this world. **Not done, recorded here.** |
| **A `BatchedMesh` port** | Forbidden by the roadmap, and the measurement says there is nothing to win. 112 materials over 334 meshes is spatial partitioning so frustum culling has something to cull. |
| **Re-measuring "does sports pay for merging"** | Already measured, in the roadmap. Confirmed, not redone. |
| **Anything about bloom or the grade** | `SportsWorld`'s environment block is calibrated against this world's measured luminance and has a comment per number. The measurement that would have justified touching it — clipped pixels — is **0.00% in all eight framings, before and after**. |
| **Re-lighting** | Same. Nothing in these shots contradicts the documented rig, and the whole-frame means move by under 0.5% in every framing. |
| **The `Loot.js` white blobs** | Shared by nine worlds, diagnosed and left by `art-medieval`. §2.4. |
| **Dropping the head sphere from 8×6 to 8×5** | It would have saved 9,328 triangles (1.3% of a framing) and the hair cap now hides the crown rings. Refused: the head is the one part of a crowd figure a player is guaranteed to look at, the chin and jaw silhouette is the half a hair cap does *not* cover, and "reduce a segment count and hope" is the habit the generator's own budget comment exists to refuse. It is a real saving and it is available to whoever wants to screenshot it. |
| **Raising the hair shade above 0.22** | The close-up reads dark, and I nearly changed it on that read alone — which is the `art-dock` bloom mistake. Measured instead: the hair masses carry sd 19–29 of internal gradient at mean luma 26–55, so they are shaded form and not flat black; whole-frame luma moves by 0.12% in `courts` and 0.10% in `bowl-interior`; and 0.00% of pixels crush in any framing. Hair is dark. Left alone. |
| **Rebuilding the `crouch` pose** | It reads as a pile of logs, and it deserves to be rebuilt: its thigh and shin end faces are 30 cm apart, so the limbs are not joined at all. But it is **8 figures**, it is a pose change rather than an art-asset change, and it would have spent the budget this pass spent on 583. Recorded, not done. |
| **Anything outside the crowd** | The pad, the bowl, the courts, the pool, the track, the ski mound, the lodge and the landscaping are all strong, all already carry documented passes, and none of them is 21% of the frame. D4 says hero assets only. |

---

## 5. The budget

Seven sports framings (the eighth is the station — §2.3), same order, same machine,
`gameplayDriven: true`, `ANGLE … RTX 5080 … D3D11`.

### The noise floor, established first

Two things were measured that could not have changed geometry, so their spread *is* the noise:

1. `named` — the tree with material names added and nothing else. Same geometry as `before`.
2. `after2` — a second run of the `after` tree. `worldTriangles` delta is **0 in all seven**,
   confirming identical geometry.

| framing | programs: before / named / after / after2 | draws: before / after / after2 |
|---|---|---|
| `skatepark-wide` | 435 / 435 / 434 / 435 | 859 / 861 / 861 |
| `skatepark-bowl` | 437 / — / 436 / 437 | 666 / 670 / 670 |
| `bowl-interior` | 438 / 439 / 437 / 438 | 732 / 728 / 734 |
| `ski-slope` | 438 / — / 437 / 438 | 422 / 408 / 408 |
| `courts` | 441 / 441 / 439 / 440 | 851 / 847 / 845 |
| `track` | 447 / — / 445 / **466** | 717 / 709 / 721 |
| `pool` | 447 / 445 / **481** / **503** | 1176 / 1156 / 1156 |

**The program counter swings by +21 and +22 between two runs of identical code.** It is
`renderer.info.programs.length` — a cumulative live cache whose per-framing value is a function
of the order in which materials first entered a frustum, and that order is not identical
between two runs of a world with streamed NPCs and residency systems. Draw calls swing −54 to
+23 on unchanged geometry (`before` → `named`, `courts` 851 → 797).

So: `pool` at 481 is not a regression, it is the same +22 that unchanged code produces, and
the material count is **112 in every one of the 28 framing measurements taken across the four
runs**. A new program can only come from a new material, and there is no new material.

### Per-framing, before → after

| | before | after | Δ |
|---|---|---|---|
| **materials** | 112 | 112 | **0**, every framing |
| **renderables** | 334 | 334 | **0**, every framing |
| **instancedMeshes** | 74 | 74 | **0**, every framing |
| **worldLights** | 4 | 4 | **0**, every framing |
| **shader programs** | 435–447 | 434–481 | −1 to −2 in six of seven; `pool` +34, inside a ±22 noise floor |
| **draw calls** | 422–1176 | 408–1156 | −20 to +4, inside a −54/+23 noise floor |
| **worldTriangles** | 511,596–781,032 | 534,684–804,804 | **+23,772**, identically, in six of seven |

Framing by framing:

| framing | draws | worldTriangles | mats | progs | meshes | inst | lights |
|---|---|---|---|---|---|---|---|
| `skatepark-wide` | 859 → 861 | 701,872 → 725,644 (+23,772) | 112 → 112 | 435 → 434 | 334 → 334 | 74 → 74 | 4 → 4 |
| `skatepark-bowl` | 666 → 670 | 704,554 → 728,326 (+23,772) | 112 → 112 | 437 → 436 | 334 → 334 | 74 → 74 | 4 → 4 |
| `bowl-interior` | 732 → 728 | 707,262 → 731,034 (+23,772) | 112 → 112 | 438 → 437 | 334 → 334 | 74 → 74 | 4 → 4 |
| `ski-slope` | 422 → 408 | 511,596 → 534,684 (**+23,088**) | 112 → 112 | 438 → 437 | 334 → 334 | 74 → 74 | 4 → 4 |
| `courts` | 851 → 847 | 613,774 → 637,546 (+23,772) | 112 → 112 | 441 → 439 | 334 → 334 | 74 → 74 | 4 → 4 |
| `track` | 717 → 709 | 781,032 → 804,804 (+23,772) | 112 → 112 | 447 → 445 | 334 → 334 | 74 → 74 | 4 → 4 |
| `pool` | 1176 → 1156 | 767,134 → 790,906 (+23,772) | 112 → 112 | 447 → 481 | 334 → 334 | 74 → 74 | 4 → 4 |
| `entrance-portal` *(is the station)* | 2548 → 2548 | 3,099,100 → 3,099,100 (0) | 225 → 225 | 630 → 634 | 1354 → 1354 | 217 → 217 | 226 → 226 |

**`ski-slope` is 684 lower than the other six, and the number is exact.** In that run the
19-figure `carry` mesh was not visible in the ski-slope frame, and a `carry` figure's delta is
+36 triangles; 19 × 36 = **684**. It is a residency/visibility system in a different state
between two runs of a system this branch did not touch — the shape `art-dock` recorded for the
ship interiors' `DistanceLod` — and `after2` reproduces 534,684 exactly.

**`entrance-portal` shows a delta of zero because it is the station**, which this branch did not
touch. That row is itself the proof of §2.3.

### Where the 23,772 comes from

| | triangles |
|---|---|
| authored parts (84 a figure × 583) | **+48,972** |
| end caps the shoes and hands make interior | −18,432 |
| the neck, open at both ends under every condition | −6,996 |
| the rebuilt kit bag (a strap, on 19 figures) | +228 |
| **net** | **+23,772** |

Crowd triangles across the world: **149,540 → 173,312** (+15.9% of the crowd, +3.4% of a 707k
framing).

**With no assets installed at all, the figure is 6,768 triangles CHEAPER than before this
branch** — 142,772 against 149,540 — because the open neck and the rebuilt bag are
unconditional. A player who never downloads the `.glb` still gains. That is asserted headlessly
in `sports-crowd-assets.test.mjs`, along with the A/B delta (30,540), both totals, and the fact
that the attribute set and the material set do not move.

### What the art actually did, measured

Mean luma is the wrong instrument for "does this figure read as a person" — and so, here, is
mean gradient, for a reason worth writing down. Replacing a bare bright scalp with dark hair
*reduces* head-against-body contrast, so gradient magnitude over a head crop goes **down**
(19.11 → 16.14 on one head in `crowdplaza-three-quarter`). That is the instrument measuring a
false feature being removed, not form being lost. The hair masses themselves carry sd 19–29 at
mean luma 26–55, which is shaded form rather than a flat silhouette.

The one place edge energy is the right instrument is the ground line, where a shoe adds a
genuinely new edge — same crop, same exposure:

| `crowdplaza-three-quarter`, feet crop | before | after |
|---|---|---|
| mean gradient magnitude | 8.437 | **9.687** (+15%) |
| mean luma | 98.52 | 95.60 |

And the containment check, which is the number that says nothing else moved:

| framing (whole frame) | luma before → after | sat before → after | clipped |
|---|---|---|---|
| `skatepark-wide` | 101.45 → 101.40 | 0.235 → 0.235 | 0.00% → 0.00% |
| `skatepark-bowl` | 88.43 → 88.04 | 0.179 → 0.178 | 0.00% → 0.00% |
| `bowl-interior` | 107.27 → 107.17 | 0.207 → 0.207 | 0.00% → 0.00% |
| `ski-slope` | 134.83 → 134.83 | 0.198 → 0.198 | 0.00% → 0.00% |
| `courts` | 99.58 → 99.46 | 0.268 → 0.268 | 0.00% → 0.00% |
| `track` | 145.82 → 145.83 | 0.147 → 0.147 | 0.00% → 0.00% |
| `pool` | 103.12 → 102.90 | 0.276 → 0.272 | 0.00% → 0.00% |

Under 0.5% everywhere, and identical to two decimal places in the two framings the crowd is
smallest in. Nothing else in this world was touched, and the numbers say so.

---

## 6. Three findings for whoever reads this next

### 6.1 `--ablate` reports meshes hidden and hides nothing — measured

The naming in §3.1 fixed the half of `--ablate` this branch owns: it can now *find* a sports
system by name. The other half does not work on this world, and the failure is silent in the
worst possible way — **the tool prints a success line**.

Two runs, both of them checked against the pixels rather than against the report:

| ablated | reported | whole-frame luma, un-ablated → ablated | the crop it should have emptied |
|---|---|---|---|
| `sports.crowd.cloth,sports.crowd.skin` | `10 mesh(es) hidden` | 99.46 → 99.46 | the stand's seat band: 55.98 → **56.01** |
| `sports.grass.field` (77,668 tris, the whole lawn) | `2 mesh(es) hidden` | 99.46 → 99.38 | the foreground lawn: 44.93 → **44.93** |

2.26% of pixels differ between the ablated and un-ablated frames, and that 2.26% is the NPCs
and the banners moving between two runs — it is the same figure for both ablations, including
the one that switched off the entire lawn. `worldTriangles` agrees: `byMaterial` still reports
`sports.grass.field` at 77,668 across 2 objects **after** the ablation claimed to have hidden
both of them, and `walkWorldTriangles` starts with `if (!obj.visible) return;`.

So something sets `visible` back to `true` between `--ablate` and the first framing. The first
place to look is `forceDrawable` in `src/gfx/RehearsalDraw.js`: it walks the world setting
`visible = true` and `frustumCulled = false`, hands back a restore closure built from the
snapshot it took **before** it ran, and this world's boot log shows the shader rehearsal and
prewarm still running 139 s in — well past the point `HARNESS.ready()` resolves. A restore that
lands after an ablation would put every `visible` back to the value it had before the ablation.
That is a hypothesis, not a finding; the finding is the table above.

**Not fixed here**: `world-shot.mjs` and `src/gfx/**` are both outside this branch's boundary,
and this is not a sports defect — it is a defect in the tool three sibling branches are using
right now, and two finished branches cite as decisive. `art-station` and `art-dock` may have
been luckier with timing, or may not have been. Until somebody checks: **an ablation that
reports N meshes hidden is not evidence that N meshes were hidden. Diff the pixels.**

Exhibit: `defect-ablate-reports-10-hidden-and-hides-nothing.jpg`.

### 6.2 Two of eight framings photograph something else

§2.3. `entrance-portal` is the station, in a black transition frame; `track` is the car park,
from a vantage past the edge of the terrain. `harness-framings.test.mjs` cannot see either
because no sports framing declares a `subject` distance, which makes its ray assertion vacuous
on this world.

### 6.3 The crowd's own docblock was wrong about its size by 3.2×

It claimed six meshes, three poses and ~180 figures. It is ten, five and 583, and the system is
21% of every triangle this world draws. Nothing failed; the comment simply stopped being true
when two poses and four hundred people were added. A stale comment about a system's SIZE is how
the next person under-budgets a change to it.

---

## 7. Gates

| | |
|---|---|
| `npm test` | **3079 pass, 0 fail** (3012 before; +67 from `sports-crowd-assets.test.mjs` and `sports-material-names.test.mjs`) |
| `node scripts/contract-check.mjs` | **129/129 files present, all contracts satisfied** |
| `npm run build` | **green**, 778 ms |
| licence | five `generated` entries, one ledger line each, byte-diff enforced |
| screenshots | `docs/superpowers/specs/img/2026-08-23-art-sports/`, six before/after pairs and four defect/evidence exhibits |

---

## 8. For the sibling branches

- **Check whether your world's framings photograph your world.** Two of eight did not here, and
  both had been wrong for as long as they had existed. The cheap test is to read
  `materialNames` in `report.json`: if the names are not your world's prefix, you are measuring
  somebody else's world. The second cheap test is to look at the shot.
- **A framing that stands on the far side of a gateway teleports the player through it.**
  `Portals._autoEnter` fires on a plane-side change inside `ENTRY_R2`, and a harness teleport is
  a plane-side change. Any world with a portal is exposed. `keepPlayer: true` is the fix.
- **Name your materials before you measure anything.** It costs twenty lines and it turns
  `byMaterial` from a class-name census into an attribution. It is what found that the crowd was
  21% of this world; nothing in the source says so, and the docblock that claimed to said 180
  figures when there were 583.
- **`_metal`-style clones inherit the source material's name.** Renaming them to their own key
  is what makes an ablation answer the question you asked.
- **Authored geometry can pay for itself.** A part that covers a primitive's end face lets that
  primitive go `openEnded`. Half of a six-sided cylinder's triangles are its two caps. Gate the
  saving on the asset having landed, or a 404 is a hole.
- **Derive the attachment point from the limb, in the limb's frame, and assert which end is the
  far end.** That single check caught a pose whose "hand" end was in the middle of the chest.
- **Both of this world's crowd materials are `vertexColors: true`**, unlike the station's — so
  every authored part needs a colour attribute, not just the garment ones. A part without one is
  drawn black, and `mergeGeometries` returns `null` rather than throwing on a mismatch, which
  reverts a whole pose in silence.
