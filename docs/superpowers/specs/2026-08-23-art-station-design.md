# Phase 9 · `art-station` — Aether Nexus Station art pass

**Branch:** `art-station` (worktree). **Roadmap:** Phase 9, decision D4 (hybrid).
**Budget gate:** Phase 1's. Draw calls, triangles, materials and **shader programs**
measured before and after, in the same twenty-one framings, by the same script.

Aether Nexus Station is the **entry world**: the hub, a 744 m dome, and the first thing
every new player sees. That makes this the highest-visibility art pass in the phase and
the one where a boot-time regression hurts most — Three keys its shader cache on light
count and this project boots by warming the cartesian product of those programs, so the
gate below is stricter than the pictures.

---

## 1. Method

`scripts/world-shot.mjs`, committed by the `art-medieval` pilot precisely so the eight
remaining worlds do not each rebuild one. Twenty-one authored framings at 1600x900, high
tier, hardware GL (`ANGLE (NVIDIA … RTX 5080 … D3D11)`), `gameplayDriven: true` in every
one — so none of these figures is the LOD-disabled worst case.

Plus four **subject** framings, three headings each: a standing crowd figure, a seated
one, and two diagnostic probes. The preset views are landscape vantages; a crowd figure
is wherever the placement RNG put it, and — as the medieval pass found with its wolf —
what a population looks like at 3 m is not visible in a shot taken at 60.

> **Never assess art by reading code — screenshot it.** Everything in §2 was invisible in
> source and obvious in a picture, and one of the two conclusions this pass *did not*
> reach was killed by a measurement rather than by an argument (§5).

---

## 2. What the before shots showed

### 2.1 The station's architecture is strong and is not the subject

The hub reads. Gateway 01's arch, the ceiling plate, the avenue chevrons, the sodium/cyan
wayfinding script, the great window and the apron beyond it, the four zone courts under
one shallow dome — all of it has had documented rounds of tuning and it shows. Materials
are 225 across 1,354 renderables and the world is already merged by material through
`GeoBatch` plus 217 `InstancedMesh` systems, 226 world lights of which `LightRig` has
demoted **every single one** (`worldLightsLit: 0` in all twenty-one framings).

**There is no draw-call win here and no `BatchedMesh` port to make.** The roadmap forbids
the latter and the measurements say the former does not exist. That was checked before
anything was authored, exactly as the roadmap's carried finding demands.

### 2.2 The population is a shop-window mannequin

`before-crowd-front.jpg` and `before-crowd-three-quarter.jpg`, taken at 3.4 m:

- **No hands.** Both arms end in the rounded cap of a capsule.
- **No hair.** A bare scaled sphere with a box jaw — one smooth flesh-toned ovoid, lit
  identically all over, because a sphere under a single overhead key has no
  self-occlusion anywhere.
- **No collar.** Capsule over cylinder: one unbroken barrel from neck to waist with a
  single horizontal seam.
- **No shoes.** A 0.12 x 0.07 x 0.26 box.

This is the gap Phase 6 recorded when it finished the eleven named roles: *"the rigid
crowd (~180 instances, 6 draw calls) … is untouched — at plaza distance the population
still reads as the old crowd."* The shots say it is worse than that: at the range the
gateway steps actually put figures in the entry world's hero framings — 3 to 10 m,
visible in `before-portal-medieval.jpg` — they read as bowling pins.

The crowd is **world geometry built by `StationWorld`**, not NPCs. It is the world's own
population and it is this pass's subject.

### 2.3 `--ablate` did not work on this world at all

The baseline reported its material breakdown as `MeshStandardMaterial x1070,
MeshBasicMaterial x244` — the class names, which is what the harness falls back to when
`material.name` is empty. **Not one of the station's 225 materials had a name.**

That matters beyond tidiness. Ablation — hide every mesh drawn with a named material,
shoot again, and the difference is which system owns a pixel — is the tool that stopped
the medieval pass "fixing" the wrong system: the vale's white blow-out looked exactly
like its own light-spill cards and one shot proved it was `src/systems/Loot.js` instead,
averting a cross-world change made from a single world's branch. On the entry world, the
one place a Phase 9 branch is most likely to need that answer, the switch was dead.

Meshes *are* named here (`dome:trimDark`, `hull:hazard`, `skyline:emCyan` — `GeoBatch`
writes `group:materialKey`), which is why the omission survived: the triangle breakdown
looked fine and only the ablation path was broken.

---

## 3. What is authored, and what stays procedural

### 3.1 Authored — `public/assets/station/{standing,seated}.glb`

The same argument as `make-npc-glb.mjs` and `make-beast-glb.mjs`, applied to a crowd:
author the features procedural lofting is bad at, keep everything lofting is good at.

A capsule stack is the correct description of a torso, an upper arm and a thigh at 40 m.
It is the wrong description of a **hand**, a **hair mass**, a **coat collar** and a
**shoe** — four rigid features with edges, which a swept capsule cannot have and a scaled
sphere fakes badly.

| part | slot | why it is on the list |
|---|---|---|
| `hand` | `skin` | a blunt stump where a hand belongs is the loudest "shop dummy" cue a figure carries at 3–10 m |
| `hair` | `body` | a bald ovoid has no self-occlusion under an overhead key; hair is a mass with a fringe edge, a temple line and an occipital bulge |
| `collar` | `body` | the only value break available above the belt; a lapel V is what says "dressed" rather than "moulded" |
| `shoe` | `body` | a toe that projects past the ankle and a heel that does not — that asymmetry is what makes a leg end in a foot rather than a peg |

Two files because there are two poses, not two roles: a seated figure's skull sits 0.38 m
lower and its forearms rest on its thighs at a rake of 0.55 rad, so only the hair is a
rigid translation of the standing set.

**The material rule, which is the whole point.** The glTF material is never read. There
are exactly two surfaces the crowd draws in — `M.crowd` (garment, `vertexColors: true`,
tinted per instance from the coat palette) and `M.skin` (flesh, its own tint pool, no
vertex colours) — and every part names one of them and is **merged into the geometry that
mesh is already built from**. The whole crowd is six draw calls for ~180 people and it
stays six. A third surface would be a new material and a candidate new shader program, on
the world where boot time is measured.

**The constraint that was accepted rather than worked around.** Because there is no third
slot, hair is merged into the *garment* geometry at vertex-colour shade 0.26 — so a
figure's hair is a dark version of its own coat colour, not an independently chosen hair
colour. Every entry in the crowd palette is already a desaturated dark, so the whole pool
lands in a near-black band with a faint hue, which is what dark hair looks like and which
varies person to person for free. Written down because it is a decision, not an accident.

### 3.2 The joint table, and why it moved

`make-crowd-glb.mjs` runs in Node, hours before a world exists, and has to put a hand on
a wrist. The wrist was a literal inside a class method.

So `CROWD` moved to `src/worlds/station/StationKit.js` and `_crowdBodyGeo`,
`_crowdSeatedGeo` and `_crowdHeadGeo` now read it. **The refactor moved nothing**: all six
merged geometries hash identically before and after (`body0 408dfa9c…`, `body1 3115a671…`,
`body2 ec4f78f4…`, `seated 0a694c07…`, `head 280efbb8…`, `headSeated 6a14aea9…`).

A wrist is now `crowdWrist(side)`, derived from the arm's own pivot, length and tilt, and
`crowd-assets.test.mjs` asserts the authored hand actually sits there — the answer
`make-beast-glb.mjs` gave to the defect `make-ship-glb.mjs` paid for, where asserting two
of a plan's fields let a 0.40 m divergence ship unnoticed.

One asymmetry is load-bearing: `FORE_R` and `FORE_L` are **different numbers**. The legs
are offset fore and aft as well as laterally, so the two feet are not mirror images and a
shoe authored once and mirrored would be 16 cm out of place on one side. The test splits
the shoe mesh by side and asserts the two z centres differ.

### 3.3 Material names

Every entry in the material table is named `station.<key>` — the same key the `GeoBatch`
call sites already use, so `--ablate station.foliage` reads the way a builder reads. A
second pass at the end of the build names anything still anonymous after the mesh that
draws it (`mesh:skyline:holoMarker`). The six gateway beacons name themselves at creation
because they are added to the table long after the table pass has run.

A name is metadata; `WebGLPrograms.getProgramCacheKey` does not read it, and the budget
table in §4 is the evidence that it cost nothing.

### 3.4 Staying procedural

- **Placement, palette, poses, variants.** 204 figures distributed down the routes a
  transit hub funnels people along, in three depth bands, a third of them in knots of two
  and three, a third carrying a pack or a hood, each on its own breathing phase. None of
  that is authoring-shaped and all of it is already good.
- **The architecture.** Merged by material through `GeoBatch` across every district.
  Nothing here is authoring-shaped either.
- **The zone actors.** `StationActors` — ~1,900 articulated figures, eleven instanced
  part meshes, posed from a joint chain on the CPU. Phase 6 named them as a remaining
  gap; §5 explains why this pass measured them and left them alone.
- **The lights.** 226 in the world group, `worldLightsLit: 0` — `LightRig` has demoted
  every one. **No light is added by this pass.** A light added for art is a boot-time
  cost, and this is the world where boot time is measured.

---

## 4. Budget

The gate is: **programs must not move**, materials must not move, draw calls must not
move, and world triangles must move by exactly the authored geometry and no more.

Baseline and after are the same script, the same twenty-one framings, the same machine,
the same GL, `gameplayDriven: true` throughout.

| view | draws | world tris | materials | programs | renderables | instanced |
|---|---|---|---|---|---|---|
| plaza-wide | 2771 → 2737 (−34) | 3,040,870 → 3,088,198 (**+47,328**) | 225 → 225 (0) | 357 → 357 (0) | 0 | 0 |
| plaza-centre | 2584 → 2588 (+4) | 3,000,812 → 3,048,140 (**+47,328**) | 225 → 225 (0) | 357 → 357 (0) | 0 | 0 |
| portal-medieval | 1839 → 2202 (+363) | 2,953,922 → 3,001,250 (**+47,328**) | 225 → 225 (0) | 357 → 357 (0) | 0 | 0 |
| portal-sports | 2099 → 2070 (−29) | 2,744,594 → 2,791,922 (**+47,328**) | 225 → 225 (0) | 357 → 357 (0) | 0 | 0 |
| street-level | 2334 → 1975 (−359) | 2,880,964 → 2,928,292 (**+47,328**) | 225 → 225 (0) | 395 → 415 | 0 | 0 |
| district-east | 2800 → 2820 (+20) | 3,147,140 → 3,194,468 (**+47,328**) | 225 → 225 (0) | 433 → 433 (0) | 0 | 0 |
| hull-outward | 1727 → 1747 (+20) | 2,786,914 → 2,830,994 (+44,080) | 225 → 225 (0) | 433 → 433 (0) | 0 | 0 |
| window-apron | 1266 → 1264 (−2) | 2,627,314 → 2,671,394 (+44,080) | 225 → 225 (0) | 433 → 433 (0) | 0 | 0 |
| apron-wide | 2786 → 2820 (+34) | 3,306,496 → 3,353,824 (**+47,328**) | 225 → 225 (0) | 434 → 434 (0) | 0 | 0 |
| dome-inside | 2505 → 2505 (0) | 3,272,342 → 3,319,670 (**+47,328**) | 225 → 225 (0) | 477 → 467 (−10) | 0 | 0 |
| hab-stacks | 1553 → 1261 (−292) | 2,651,312 → 2,691,072 (+39,760) | 225 → 225 (0) | 512 → 504 (−8) | 0 | 0 |
| hab-lobby | 947 → 1208 (+261) | 2,637,302 → 2,677,062 (+39,760) | 225 → 225 (0) | 512 → 512 (0) | 0 | 0 |
| link-galley | 408 → 1048 (+640) | 2,337,798 → 2,337,798 (**0**) | 225 → 225 (0) | 522 → 512 (−10) | 0 | 0 |
| zone-habitation | 356 → 335 (−21) | 2,180,736 → 2,180,736 (**0**) | 225 → 225 (0) | 535 → 512 (−23) | 0 | 0 |
| zone-habitation-court | 1614 → 1622 (+8) | 3,322,754 → 3,370,082 (**+47,328**) | 225 → 225 (0) | 536 → 512 (−24) | 0 | 0 |
| zone-gym | 290 → 290 (0) | 2,156,800 → 2,156,800 (**0**) | 225 → 225 (0) | 564 → 512 (−52) | 0 | 0 |
| zone-gym-court | 324 → 315 (−9) | 2,203,364 → 2,203,364 (**0**) | 225 → 225 (0) | 579 → 512 (−67) | 0 | 0 |
| zone-construction | 667 → 369 (−298) | 2,120,816 → 2,120,816 (**0**) | 225 → 225 (0) | 580 → 522 (−58) | 0 | 0 |
| zone-construction-court | 829 → 836 (+7) | 2,419,360 → 2,419,360 (**0**) | 225 → 225 (0) | 581 → 522 (−59) | 0 | 0 |
| zone-canteen | 609 → 630 (+21) | 2,309,204 → 2,309,204 (**0**) | 225 → 225 (0) | 581 → 522 (−59) | 0 | 0 |
| zone-canteen-court | 2524 → 1380 (−1144) | 3,319,994 → 3,367,322 (**+47,328**) | 225 → 225 (0) | 581 → 536 (−45) | 0 | 0 |

**The gate held.** Read the columns from the right:

- **Renderables, instanced meshes and world lights are identical in all twenty-one
  framings — to the object.** 1,354 / 217 / 226 before and after. Nothing was created.
  That is not a summary of the change, it is the strongest single fact in the table: a
  draw call comes from a renderable, and there are exactly as many as there were.
- **Materials: 225 → 225 everywhere.** Naming a material does not create one.
- **Programs never rise.** They are identical in the first ten framings and *lower* in the
  last eleven; the run's maximum went 581 → 573. The program cache is a running total that
  fills as views change, so the same framing can report a different number in two runs
  depending on when the cache reached it — which is why `street-level`'s 395 → 415 is not a
  regression and `zone-gym-court`'s 579 → 512 is not a win. The claim the gate makes is the
  one the table supports: **nothing here added a shader program.**
- **World triangles: +47,328 wherever the hub crowd is in frustum, +44,080 or +39,760 where
  part of it is culled, and exactly ZERO in the seven zone framings where none of it is.**
  204 figures × 232 authored triangles = 47,328, to the triangle. The change is confined to
  the hub crowd and the number proves it rather than asserting it.
- **Draw calls swing between −1,144 and +640, in both directions, and none of it is this
  pass.** `link-galley` is +640 with *zero* triangle change and `zone-canteen-court` is
  −1,144 with the full +47,328 — the two are uncorrelated because the driver is the zone
  actors' distance cull and the live population at the instant of capture, not the crowd's
  geometry. With renderables identical to the object there is no mechanism by which this
  change could add one.

### Boot-time impact

None measurable, and the reason is structural rather than lucky. Boot cost in this project
is shader-program warm-up — Three keys its cache on material configuration and light count,
and the station warms the cartesian product. This pass adds **no material, no light and no
program**: the authored geometry draws in `M.crowd` and `M.skin`, which the crowd was
already drawing in. What it adds is 36 KB of `.glb` fetched in parallel with the hero
assets that were already being fetched at the same build fraction, and 47,328 triangles of
merged geometry — a build-time merge that was already running.



### 4.1 The triangle cost, stated honestly

Unlike the medieval pass — where the authored geometry belonged to beasts, which are NPCs
and are not counted by `worldTriangles` — **the station crowd is world geometry and this
pass does move the triangle number.** That is the correct place for the cost and it is
reported rather than hidden.

232 triangles per figure (`standing.glb` 232, `seated.glb` 232) against a figure that was
784 (524 body + 260 head), across **204 figures** — 190 standing across three body variants
of 135 / 27 / 28, and 14 seated — in the same **six** instanced meshes as before:

| mesh | instances | tris before | tris after |
|---|---|---|---|
| body variant 0 (plain) | 135 | 524 | 684 |
| body variant 1 (backpack) | 27 | 572 | 732 |
| body variant 2 (hood + satchel) | 28 | 698 | 858 |
| body variant 3 (seated) | 14 | 644 | 804 |
| head, standing | 190 | 260 | 332 |
| head, seated | 14 | 260 | 332 |

+160 on a body geometry (hair, collar, shoes) and +72 on a head geometry (the pair of
hands) — 232 a figure, 47,328 across the crowd. The reservation lives in the generator
(`TRI_BUDGET = 240`), not in a review comment, and it already refused a first draft at
292 — a 36-triangle sphere for a 2 cm thumb, which is thirteen thousand triangles across
the crowd for a rounded edge nobody can resolve.

`crowd-assets.test.mjs` asserts the delta headlessly: it builds all six crowd geometries
with the committed `.glb` installed and without, and requires that the triangle change is
**exactly** the authored triangles for that slot, that the attribute set is unchanged, and
that the merge still returns one geometry per mesh. That last one is not paranoia —
`mergeGeometries` returns `null` on a mismatched attribute set rather than throwing, so a
part in the wrong slot takes out a whole body variant silently, with nothing in the
console and no number moving anywhere.

### 4.2 The defect the after-shot found, and why its gate is arithmetic

The first after-shot showed the whole crowd wearing **black-and-tan striped helmets**.

The hair cap's vertices stood 4.5% off a 105 mm skull, which reads in source as ample
clearance and is not. The cap is **eight** segments around and the head under it is
**twelve**, and a chord of an eight-segment circle sits `1 - cos(pi/8)` = **7.6% of the
radius inside** the arc its vertices lie on. So every flat facet of the cap dipped below
the smooth sphere between its own vertices and the skin striped through the hair in eight
bright wedges radiating off the crown.

Two numbers that each look fine and are wrong together. Invisible in the source, unmissable
in the picture — the fourth time in this project's Phase 6/9 record that a silhouette
defect has had that exact shape.

Fixed by raising the clearance to 13%, and pinned by **arithmetic rather than by another
screenshot**: `crowd-assets.test.mjs` asserts `grow - 1 > (1 - cos(pi/segments)) + 0.02` on
the exported `HAIR_CAP` constants. A screenshot finds this once; a number stops it coming
back when somebody later raises the segment count for smoothness and lowers the clearance
because it now looks too puffy.

### 4.3 The instrument, verified

After the two naming passes, the world reports **225 materials, 225 named, 0 anonymous**.
`--ablate station.foliage`, `--ablate station.crowd`, `--ablate station.emGate_medieval`
and the other 222 now do what they say on the entry world.

---

## 5. What this pass deliberately did not do

### 5.1 The zone actors' triangle budget — measured, written down, not taken

The single largest line in the station's triangle budget is not the architecture. It is
`StationActors`, and it is not close:

| mesh | triangles at `plaza-centre` | objects |
|---|---|---|
| `StationActors:head` | 490,620 | 1 |
| `StationActors:torso` | 415,140 | 1 |
| `StationActors:calfL` / `calfR` | 135,864 each | 1 each |
| `StationActors:foreArmL` / `foreArmR` | 135,864 each | 1 each |
| `StationActors:thighL` / `thighR` | 113,220 each | 1 each |
| `StationActors:upperArmL` / `upperArmR` | 113,220 each | 1 each |
| `StationActors:pelvis` | 75,480 | 1 |

About **2.0 M of the world's 3.0 M triangles**, for ~1,900 figures that live in the four
outer zones half a kilometre from the plaza. The head alone is 490 k — a
`SphereGeometry(0.105, 12, 10)` at 258 triangles, multiplied by the roster. Dropping it to
`(8, 6)` would reclaim roughly 340 k triangles, more than seven times what this pass
spends, at a size no player can resolve from the arcade.

**Not taken here, for two reasons.** The first is scope: `StationActors` is the zones'
articulated cast and Phase 6's line was about characters, which the brief for this branch
is explicit are done. The second is that it is a real risk dressed as a free win — the
canteen and construction courts put actors at 15–30 m, `zone-canteen-court` is a framing
with 2,524 draws in it, and a segment count chosen against the plaza is not obviously the
right one there. It wants its own before/after, which is a pass, not a line item.

It is written here with the measurement already done so that whoever takes it starts from
a number rather than from a hunch.

### 5.2 The planting, which is a real defect and is not the crowd

`before-hab-stacks.jpg` and `before-hab-lobby.jpg` show a row of nine bright mint-green
hemispheres sitting along the habitation avenue — no trunk, no planter, no broken edge.
They are the brightest objects in a dark street and they read as glowing marshmallows.
`before-plaza-centre.jpg` has the same material as a large faceted green boulder at the
frame edge.

The diagnosis is the same shape as §2.2: a smooth dome under an overhead key has no
self-occlusion and no silhouette information, so it renders as the most artificial object
in the frame. `foliageLobe` already displaces its vertices and bakes underside occlusion
into vertex colours — it *tried*, and at avenue scale the picture says it did not work.

Left for a second pass rather than folded into this one. It is a different system with a
different failure and its own before/after, and the roadmap stages Phase 9 one world at a
time to reduce risk — which applies inside a world too when the alternative is two
unrelated art changes sharing one budget table and one set of shots. The evidence is
committed alongside this spec so the diagnosis does not have to be redone.

### 5.3 `plaza-wide` photographs a gateway, not the plaza

`VIEWS.station`'s `plaza-wide` stands at (0, 9, 96) and looks at the origin — but Gateway
02's arch is at z = +54, directly between the two, and fills the frame. The shot is a
second, more distant `portal-sports`.

**Not fixed, and this one is a judgement call worth recording.** The medieval pilot found
a framing photographing the *inside* of the terrain and fixed it, because that framing was
blind — it showed nothing. This one is not blind; it shows a real, well-composed part of
the world, and the plaza monument it was presumably named for is covered by
`plaza-centre`, which does show the spire. Renaming or moving it would also have edited
`src/dev/Harness.js` while three other Phase 9 branches are live in the same file. Logged
instead.

### 5.4 The white blobs at distance

Still `src/systems/Loot.js` — four stacked additive layers at intensity 2.6 with
`fog: false` — as the medieval pass proved by ablation and deliberately left. `Loot` is
shared by nine worlds. Not this branch's, and now not this branch's twice.

---

## 6. The evidence

`.probe/` is gitignored, so the run directories die with the worktree. The shots that
carry the argument are committed alongside this spec, in the shape the maze and medieval
phases' were:

| file | what it shows |
|---|---|
| `img/2026-08-23-art-station/before-crowd-front.jpg` | a crowd figure at 3.4 m: bare ovoid head, arms ending in capsule caps, one unbroken barrel torso |
| `…/after-crowd-front.jpg` | the same figure with hair, hands, a collar and shoes |
| `…/before-crowd-three-quarter.jpg` / `…/after-crowd-three-quarter.jpg` | the same pair from three-quarter, where the hair mass and the lapel do most of their work |
| `…/before-seated-three-quarter.jpg` / `…/after-seated-three-quarter.jpg` | the bench variant, which is the figure a player walks right up to |
| `…/before-portal-medieval.jpg` / `…/after-portal-medieval.jpg` | the entry world's hero framing, with figures on the gateway steps at 3–25 m |
| `…/before-street-level.jpg` / `…/after-street-level.jpg` | the spawn sightline — the first frame of the game |
| `…/before-plaza-centre.jpg` / `…/after-plaza-centre.jpg` | the plaza, the spire and the crowd at 20–60 m |
| `…/before-hab-stacks.jpg` | the planting defect of §5.2: nine mint hemispheres down an avenue |
| `…/before-hab-lobby.jpg` | the same, closer, under a lamp |

Full run directories, while this worktree lives:
`.probe/art-station/{before,after,subjects-before,subjects-after}/`, each with a
`report.json`, and `after/diff.json`.

---

## 7. Gates

- `npm test` — 2,958 before, **2,990** after (23 new in `crowd-assets.test.mjs`, 9 in
  `station-material-names.test.mjs`).
- `node scripts/contract-check.mjs` — 129/129.
- `npm run build`.
- The authored assets carry the full pipeline contract the ship, hero and beast assets
  carry: allow-listed licence, a line in `docs/assets/LICENCES.md`, manifest `bytes` and
  `tris` asserted against the parsed `.glb`, and a **byte-diff** test that re-runs the
  generator into a temp file and compares buffers.
- Any test that scrapes source normalises CRLF before anchoring.
