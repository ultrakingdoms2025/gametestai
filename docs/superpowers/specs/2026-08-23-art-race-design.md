# Art pass: the race world

Phase 9, branch `art-race`. Decision D4: authored `.glb` hero assets, procedural
bulk. Three circuits on one 1.3 km map — Vellum Ridge, Cinder Gorge, Aurora
Rise.

Evidence: `img/2026-08-23-art-race/`.

---

## 1. The architecture, measured before anything was authored

| | measured |
|---|---|
| renderables | **453** |
| materials | **29**, every one named (`race.paint.enamel`, `race.metal.trim`, …) |
| `InstancedMesh` | **129** tiled systems, **5,506** instances |
| shader programs | **241** at the moment measuring began, settled |
| world lights | **0** |
| world triangles | 810,504 in a frame from the start/finish straight |

This is the citadel/dock shape — merged by material per district plus tiled
instancing — not the sports one. **There is no draw-call win available here and
none was attempted.** The roadmap forbids porting the maze's `BatchedMesh`
machinery into a world whose many-meshes-one-material split is deliberate
spatial partitioning for the frustum culler.

An inherited note claimed all of the above plus "1.81 M triangles". The first
three figures reproduce exactly. The triangle figure does not correspond to
anything this instrument produces — world triangles are counted per FRAME.
The crowd is 819 figures, not the 801 claimed.

Race needed no material-naming pass, which three of nine worlds did.

---

## 2. What was authored, and what was refused

### Authored

**The spectator** (`public/assets/race/spectator.glb`, 144 triangles).
819 instances, the second largest object in the world at 102,384 triangles in
one frame — 12.6% of everything drawn. Its defect is not primarily the
silhouette:

> `_spawnCrowd` merged body and head into ONE geometry drawn with
> `vertexColors: false` and handed it ONE `setColorAt` per instance, so **the
> head was painted the shirt colour.** A spectator in a green shirt had a green
> head. All 819 did. `before-grandstand-front.png`.

**The marshal post** (`marshal.glb`, 204 triangles). 29 of them, one every
150 m.

> The hazard band is 3.3 × 0.5 × 0.2 drawn at the centre of a solid
> 3.2 × 2.6 × 2.6. **93% of its surface is inside the crate.** The 7% that
> renders is a 5 cm tab on each END, side-on to the road, so from a car it has
> never been visible. `before-marshal-post-profile.png` shows the sliver;
> `after-marshal-post-three-quarter.png` shows the four-bar band that replaced
> it, and `after-post-slot.png` the recess behind its surround.

### Refused, with the number that refused it

| refused | why |
|---|---|
| A 276-triangle spectator (the inherited draft) | +108,108 world-wide, **+11.9% on a measured frame**, for background crowd. The budget is now the primitive's own 144. |
| Shoes on the spectator | 24 triangles for two, and the figures stand behind a 0.42 m seat plank that hides everything below the knee. The arms they paid for are visible from every angle. |
| Authored tyre stacks | 314 stacks × 3 tyres. A tyre is a surface of revolution, which is what a runtime primitive is *good* at. |
| Conifers, rocks, city, terrain, road ribbon, kerbs, barriers | bulk content over 1.7 km²; exactly what D4 keeps procedural. |
| A second `InstancedMesh` for skin | +3 renderables and +3 draw calls. The head is hair at 0.30 of the shirt instead. |
| LOD for the crowd | 819 figures at full detail with no distance banding is a real cost, and `DistanceLod` is what it is for. It is a systems change, it moves `instancedMeshes`, and it is outside an art pass. **Recorded, not done.** |

---

## 3. The cost rule, and what it actually cost

Neither asset buys a bucket. The spectator's four parts merge into ONE geometry
handed to the `race:crowd` `InstancedMesh` that already exists; the marshal's
three parts are **named for race material keys** and go into the
`trackside.<id>` `Batch` bucket of that key.

Three browser runs on the post-merge harness — two baselines and one after —
four subjects at 7 m, three headings each.

**Noise floor**, same tree twice: world triangles **byte-identical** in all
twelve framings; draw calls identical in eleven and ±1 in one; materials,
renderables, instanced meshes, instances and world lights identical.

`programs` is still **not comparable per framing**: it climbs monotonically
through a run — 241 at the first framing to 441 at the twelfth, on identical
code, in both baselines — because the run walks the player 500 m into material
configurations boot never warmed. The end value agreed exactly (441 both
times), and that is the only program figure below.

| axis | before | after |
|---|---|---|
| draw calls | — | **unchanged, all twelve framings** |
| renderables | 453 | **453** |
| instanced meshes | 129 | **129** |
| instances | 5,506 | **5,506** |
| world lights | 0 | **0** |
| shader programs (end of run) | 441 | **441** |
| materials | 29 | **28 — one fewer** |
| world triangles | — | **+648 … +2,088** |

Every triangle of that is the marshal post at +72 each. The crowd contributes
**zero**: 144 replaces 144. The largest delta is the framing with all 29 posts
in it, and it is +0.23% of that frame.

Materials fall because carrying a per-part shade needs `vertexColors`, and the
crowd's `paint.enamel|novc` clone was the only material in the scene with that
configuration. Giving the head a value of its own means joining the shared
`race.paint.enamel` every batched mesh already uses.

---

## 4. Defects fixed

### 4.1 `Batch.box` aliased the scratch vector its callers were holding — 514 colliders

Two house rules, each correct alone. One scratch vector per module: `_v1`.
A method that computes a point writes it into a caller-supplied vector:
`_roadPoint(co, i, lat, w, out)`. So callers hold their road point in `_v1`
across several placements — and `Batch.box` composed its matrix in `_v1` too.
JavaScript evaluates arguments before the callee runs, so the **first** piece in
every block is right and every one after it is measured from the previous piece,
compounding.

Measured by standing the real builders up against a fake `this` on the real
surveyed circuits, once on the shipped tree and once with the fix:

| system | drawn error | collider error | count |
|---|---|---|---|
| marshal post | lid +1.30 m, band +4.05 m | **+6.35 m** | 29 |
| tyre stack | 2nd tyre +0.21, 3rd +0.84, band +1.89 | **+3.21 m** | 314 |
| chicane block | top +0.28 m | **+1.11 m** | 54 |
| oil drum | lid +0.58 m | **+1.44 m** | ~59 |
| barrier section | top +0.39 m | **+1.07 m** | ~58 |
| wind mast | one blade on the hub, one at the wrong radius | — | aurora |
| lattice pylon | second leg on the centreline instead of 2.6 m out | — | aurora |

**514 colliders** across the three circuits, each the collider of something a
driver is meant to be able to hit, floating 1.07–6.35 m above it with nothing
solid at the object. The tyre stacks on the outside of every fast corner — the
only thing between a car that has lost it and the countryside — were driven
straight through, on all three circuits.

Two inherited claims did **not** hold and are corrected: the gorge cliff blocks
are fine (each iteration re-calls `_roadPoint` before its one box), and the
wind-mast tower collider is correct **by accident**, because three blade offsets
at 120° sum to zero and put `_v1.x` back where it started.

Gated by `scripts/tests/race-trackside-placement.test.mjs`, which fails 5/5 on
the shipped tree and passes 5/5 with the fix.

### 4.2 The head was the shirt colour

Fixed by baking a per-part shade into a vertex-colour attribute at load, which
costs nothing at runtime and takes the material count down by one. The shirt
palette is desaturated to match: 0.30 of a saturated primary is not hair, it is
the same primary in shadow.

### 4.3 The hazard band nobody had ever seen

Four bars standing 0.06 m proud on all four faces instead of one bar buried in a
solid.

### 4.4 The crowd stood on the bench

`y + 0.42` put the figures' feet on TOP of the 0.42 m seat plank, which was
right while they were 1.22 m tall — it put their heads at deck + 1.64, almost
exactly where a standing adult's head belongs. So the head heights were right
and the PEOPLE were 1.2 m. At 1.70 m they stand on the deck, set back 0.45 m,
and the plank does what a bench in front of a standing crowd does.

---

## 5. Two gates that were green over a broken build

Recorded because both are the roadmap's own line arriving from an unexpected
direction: *a gate that measures something the game does not do is worse than no
gate.*

**The inherited manifold gate.** `Quads.check` tallied directed edges across a
whole PART under an exactly-once rule, and its docblock claimed that made
abutting solids each closed. It does not — the marshal's shell and the sill box
against it share a bottom edge in the same direction. Its own gate caught that
on the first run anybody ever gave it, which is also how we learned the
generator had **never been run**. The generator now tallies per solid; the test,
which cannot recover solid boundaries from the bytes, asserts the invariant that
survives abutment: every directed edge appears exactly as often as its reverse.

**`GLTFLoader` deletes the dots.** Node names go through
`PropertyBinding.sanitizeNodeName`, which removes `[].:/` because they are
reserved by the animation track-binding syntax. The marshal's parts are named
for race material keys — the whole contract that keeps them out of a new draw
call — so they arrived as `metalpanel`, `metaltrim`, `hazardstripe`. The loader
matched none, warned once into a console nobody reads, returned null, and the
world drew the boxes it has always drawn. Correctly. Silently. On every load.

**Eighteen assertions were green over it**: the file parses, the names in it
ARE the three material keys, the triangles are the budget, the normals are unit,
the solids are closed, the band stands proud, the world builds both ways with
identical colliders and identical merged meshes. Every one of those reads the
GLB directly. The browser reads it through `GLTFLoader`, and that is a different
string. What caught it was a screenshot of a post that had not changed, beside a
measurement saying 0.59% of pixels differed. Two new tests now parse the real
committed bytes through the real loader.

The spectator was unaffected — `torso`, `head`, `face`, `legs` have no dots — so
that run had one asset live and one dead, which is exactly the state that
produces a confident before/after table with half of it wrong.

---

## 6. Two things measurement stopped me doing

**The crowd is not darker.** The after grandstand read darker to my eye and I
was ready to regrade the palette. Measured on the crowd band of an identical
framing: mean luma 23.43 → 22.53, which is 0.9 of 255, and Sobel edge energy
0.064 → 0.069, which is 7.8% MORE detail. The impression was worth nothing.

**A ray that hits something can be hitting a tree.** `after-post-face.png` is a
framing computed to look straight into the post's new observation slot. It
photographs a conifer standing between the camera and the post. The proposed
framings below are therefore checked on *what* the ray hits, not only on
whether it hits.

---

## 7. Proposed `VIEWS.race`

Six framings, each validated against the real built world's physics: first
collider hit inside `subject × 1.7` and at least `subject × 0.12`, camera and
feet outside every collider, **and** the hit point within 2.5 m of the thing the
framing names.

| name | pos | look | fov | binding | first hit | ratio | miss |
|---|---|---|---|---|---|---|---|
| `start-grid` | `[30, 3.2, 224]` | `[30, 1.6, 150]` | 70 | `clear: 40` | none | — | — |
| `grandstand` | `[12, 4.0, 224]` | `[10, 3.4, 234]` | 62 | `subject: 10` | 8.54 | 85% | 1.67 |
| `marshal-post` | `[465.24, 32.0, 264.5]` | `[465.24, 31.0, 257.1]` | 55 | `subject: 7.4` | 6.99 | 94% | 0.47 |
| `tyre-stack` | `[215.21, 5.75, 163.42]` | `[219.45, 5.04, 167.66]` | 58 | `subject: 6.0` | 5.42 | 90% | 0.62 |
| `chicane-block` | `[-331.44, 2.58, -243.74]` | `[-325.44, 1.86, -243.74]` | 58 | `subject: 5.9` | 5.25 | 89% | 0.80 |
| `gorge-wall` | `[-249.9, 9.0, -306]` | `[-249.9, 8.0, -315]` | 60 | `subject: 9` | 7.27 | 81% | 1.79 |

Five of the six are within 10 m of a specific object, which is the correction
`art-sports` paid for: none of its eight landscape framings came within 25 m of
a figure, and every defect it fixed was invisible in all eight.

A seventh, `aurora-loop`, was **withdrawn**: its ray does hit something at
25.21 m, comfortably inside its declared subject, but 9.0 m from the point the
framing names — so I cannot say what it is looking at without a photograph and I
did not take one. It passes the shipped contract and it should not.

---

## 8. Not done, and why

* **Crowd LOD.** 819 figures drawn at full detail with no distance banding, in a
  world that registers with `DistanceLod`. Real, measured (102,384 triangles in
  one frame), and a systems change that moves `instancedMeshes`. Outside an art
  pass.
* **The marshal post's platform, kick rails and grab rails have no collision.**
  They stand outside the shell the collider is placed on. They were drawn-only
  as boxes too, so this is not a regression, but nothing tests it.
* **`--dist 5` puts the player's own mount in shot.** `after-spectator-close.png`
  is a close spectator framing with a large dark mass and orange panels across
  it — the player's mount, which `freezeAll(true)` neutralises but does not
  hide. `frameValidity()` did not flag it. `src/dev/**` is another branch's
  boundary; recorded, not touched.
* **`--ablate` was not used.** Race's materials are all named, so it would have
  worked, but neither asset owns a material — the crowd shares
  `race.paint.enamel` with 155 other objects and the post's three keys are
  shared with the whole trackside pass. Hiding a material would ablate the
  world, not the asset. The both-ways build test is the A/B instead.
