# Phase 9 · `art-space` — open space art pass

**Branch:** `art-space` (worktree). **Roadmap:** Phase 9, decision D4 (hybrid).
**Budget gate:** Phase 1's. Draw calls, triangles, materials, renderables, instanced meshes,
world lights and **shader programs** measured before and after, in the same fifteen framings,
by the same script, with the **noise floor established first**.

**Evidence:** `docs/superpowers/specs/img/2026-08-23-art-space/`. The pair that carries this
pass is `before-reach-boulder.jpg` / `after-reach-boulder.jpg`: the largest rock in Halberd
Reach, same camera, same 900 m, same star — **mean luma 4.8 → 41.6 over the rock's own
interior, 100% of its pixels under 48/255 → 51.6%, Sobel edge energy 5.02 → 7.67.**
`mid-reach-boulder-albedo-only.jpg` is the same rock with only the first of the two faults
fixed, and it is in the folder because it is the frame that made the second one visible.

---

## 1. Method, and the order it was done in

The roadmap's line is *"measure the architecture first, then photograph the subject, and only
then author anything"*, and this branch is a straight case for why that ordering is not
optional: **the architecture measurement said there was nothing to win, and the subject
photograph found two faults in one object.**

`scripts/world-shot.mjs`, unchanged: real Chrome over CDP against a real Vite server, all
fifteen `VIEWS.space` framings at 1600×900, `gameplayDriven: true`, hardware GL
(`ANGLE … RTX 5080 … D3D11`), budget taken in the same pass as the picture.

Frame statistics quoted below (mean luma, saturation, clipped %, dark %, Sobel edge energy)
are computed off the PNGs by a scratch tool under `.probe/tools/`, which is gitignored and
deliberately not committed — it reads PNG with `node:zlib` and nothing else.

### 1.1 The noise floor, taken before anything was attributed

`art-citadel`'s rule. The base tree was measured **twice**, on identical code, by stashing the
whole branch and re-running:

| metric | run-to-run swing on unchanged base code |
|---|---|
| `worldTriangles` | **0** in all fifteen framings |
| `materials` | **0** |
| `renderables` | **0** |
| `instancedMeshes` | **0** |
| `worldLights` | **0** |
| `drawCalls` | 0 in fourteen framings, **−3** in one (`bearing-verdigris`) |
| `programs` | **+36, +15, +37, +39, +19, +30, +7, +2, +1** across nine framings — and 423 at the end of both runs |

So: triangles, materials, renderables, instanced meshes and lights are **exact** in this world
and any delta in them is real. Draw calls carry a ±3 band. And the per-framing **program count
is not a measurement at all** — it is the warm-up cache caught mid-ramp, and the only number
worth comparing is the settled one at the end of the run. That is written into the world
header now so the next branch does not re-derive it.

---

## 2. What the measurement said: there is no structural win here

| | base |
|---|---|
| renderables in `world:space` | 44 |
| distinct materials | 43 |
| instanced meshes / instances | 6 / 537 |
| world lights | 1 |
| triangles in the group | 145,412 (bearing) – 166,490 (apron) |
| draw calls, whole frame | 113 – 177 |

**43 materials across 44 renderables.** That is neither the citadel case (merged by material,
nothing to gain) nor the sports case (112 materials for 334 meshes, worth merging) — it is a
world with forty-odd objects in it, each of which is its own thing. There is no batching
opportunity because there is nothing to batch, and the roadmap's warning about porting the
maze's `BatchedMesh` machinery does not even arise. **No structural change was made and none
was needed.**

One thing the architecture pass *did* find, and it is the `art-station` trap: of those 43
materials, **exactly one (`Sky.space`) carried a name.** `--ablate` identifies materials by
name, so every A/B this branch might have wanted to run would have silently addressed a
class-name fallback and reported nonsense. Fixed in §5.4 before any ablation was attempted.

---

## 3. What the before shots showed

Fifteen framings. Whole-frame means ran 5.8–41.0 luma at saturation 0.20–0.63, and
**0.00% clipped pixels in every one of them, before and after.** The first hypothesis on
looking at Erenmark and the lit hangar mouth — "that is a bloom blow-out, like the CC0
roughness map the roadmap warns about" — is wrong and is recorded here as a dead end rather
than acted on. Nothing in this world clips anywhere.

The world's **structure, scale scheme, sky, body shaders and yard exterior are strong** and are
not the subject of this pass. `space/Scale.js`'s proxy placement is exact rather than
approximate; the twelve bodies are shader spheres with real terminators; `DockExterior` has
already had its own documented lighting pass with a measurement behind every number.

**And that is the problem with the fifteen preset framings: they could not have found anything.**
Every one of them is a landscape shot of a body at its designed angular size, or of the yard
from 340 m. Their frame statistics are **unchanged to within a tenth of a luma point by
everything this branch did** (§6.3). The defect was found at 900 m from one rock.

### 3.1 The subject: Halberd Reach, at the distance a pilot actually meets it

`Belt.js`'s own header says what the field is: *"the one thing out here you fly INTO rather
than at."* It is 26 km to port, in the nav list from launch, and it carries an authored hostile
nest — a detour the game gives you a reason to take. `SpaceWorld._buildBelt` registers physics
colliders for the 44 rocks at or above 90 m radius, which is the game stating on the record
that a pilot gets close enough to hit one.

Photographed at 900 m from the largest of them — 336 m radius, a second and a half of cruise:

| | before |
|---|---|
| mean luma over the rock's interior | **4.8 / 255** |
| pixels under 48/255 | **100%** |
| Sobel edge energy | **5.02** |
| brightest facet on the **sunward** side | **8.9 / 255** |

A 670-metre boulder filling 700 pixels of screen, rendering as a near-black twenty-facet die.

---

## 4. Two faults in one object, and the second was invisible until the first was fixed

### 4.1 The albedo was applied twice

```js
const tint = new THREE.Color(spec.tint);            // 0x5d564e
const mat = new THREE.MeshStandardMaterial({ color: tint, … });
…
c.copy(tint); … c.multiplyScalar(0.72 + r2() * 0.55);
this.meshes[m].setColorAt(counters[m]++, c);
```

Three multiplies `vColor` into `diffuseColor`. The field's albedo was therefore **`0x5d564e`
squared** — linear 0.0117 against the 0.108 the tint names, which is charcoal.

It is worth naming the shape of this bug because it is not a typo. **Both halves are
individually correct and each carries a comment explaining itself.** The material comment says
what the tint is; the instance comment says *"per-instance colour, so the field is not one flat
grey"*. Only the product is wrong, nothing renders in a unit test, and at 26 km — which is
every framing the harness has — the field is a few dozen pixels and the error is invisible.

Fixed by making the material white and letting the per-instance colour carry the whole albedo,
which is where the variation already lived. Nothing in the colour loop changed. A/B on three
facets of the same rock in the same framing, taken by flipping `material.color` at runtime
before a line of source was edited:

| facet | before | after |
|---|---|---|
| upper-left | 4.5 | **36.8** |
| upper-centre | 8.4 | **57.8** |
| lower-centre | 8.9 | **56.6** |

### 4.2 Eighty triangles is a die, not a boulder

`IcosahedronGeometry(1, 1)` is 80 triangles. On an 18 m pebble drawn four pixels across that is
generous — and 216 of the field's 260 rocks are that. On the 336 m rock it is one facet per
78 × 78 pixels of unbroken flat shading, and no feature smaller than a facet can exist, which
is to say no craters.

This is the authored-asset case, and it is the only one in open space: twelve of the world's
bodies are raw `ShaderMaterial` spheres and an authored mesh cannot help a shader.

---

## 5. What was authored, and what was left procedural

### 5.1 Authored: one hero boulder — `public/assets/space/reach-boulder.glb`

Through the route proven five times, copied from `make-yard-glb.mjs` and `YardAssets.js`:

- **`scripts/make-belt-glb.mjs`** — a committed generator that reproduces the file byte for
  byte on re-run, asserted with `Buffer.equals` against the committed bytes.
- **`public/assets/space/manifest.json`** — licence `generated`, source, part keys,
  tessellation, 500 triangles, 40,128 bytes, radial envelope.
- **`src/worlds/space/BeltAssets.js`** — lazy loader: manifest, lazy `GLTFLoader`, abort signal,
  one warning per distinct failure, synchronous cache read returning **null** rather than
  throwing.
- **`scripts/tests/belt-assets.test.mjs`** — seventeen tests (§7).
- **glTF material discarded**; the mesh's NAME is the belt's material key and the geometry is
  handed to an `InstancedMesh` that shares the belt's own `MeshStandardMaterial` instance.
- **A row in `docs/assets/LICENCES.md`.**

**The shape:** 500 triangles (`IcosahedronGeometry` detail 4), unit radius, flat-shaded with
per-face vertices. Four octaves of deterministic value noise for the body, **nine crater bowls
with raised ejecta rims**, and **three seeded fracture planes** — because a rock in a *debris*
field is a fragment of something larger, and a shear face is the cheapest possible detail:
flattening costs no triangles at all.

**Which rocks get it is not a number invented in the generator.** It is `Belt.HERO_RADIUS`,
which is the same threshold the collider set uses:

> every rock the flight model can hit is a rock drawn at hero detail.

44 of 260. `belt-assets.test.mjs` asserts the two sets are the *same set*, off a real `Belt`,
rather than asserting that both read the same constant.

### 5.2 Two numbers that had to be measured rather than guessed

Recorded because both first attempts were wrong in a way only a screenshot showed.

- **Fracture-plane depth.** A plane at offset `o` shears a cap of half-angle `acos(o)`. The
  first build put them at 0.58–0.74 on the reasoning that a deep cut makes a convincing flat.
  0.58 is a **55-degree cap — more than a quarter of the whole body** — and three of them left
  a rock whose entire lit hemisphere was one unbroken plane. It read as a smooth disc: *the
  same defect the 80-triangle rock had, arrived at from the other side.* Now 0.86–0.94, a
  20-to-31-degree cap.
- **Noise octaves.** Three octaves at a 0.45 gain put the facet-scale octave at ±3% of radius,
  which is below the shading difference between adjacent facets — so the lit face read as a
  smooth dome. Four octaves at 0.62.

### 5.3 Left procedural, deliberately

The **216 small rocks keep all three procedural silhouettes, unchanged, at 80 triangles.**
`Belt.js`'s header argues for three distinct shapes with a reason — *"the eye locks onto a
repeated silhouette faster than onto a repeated colour"* — and an authored 500-triangle mesh on
an 18 m pebble is detail nobody will ever see at a cost paid 216 times.

Also left alone: every body shader, the ring, the atmosphere shells, the corona, the sky dome,
the yard's geometry and its lighting, the beacon, and the whole `Scale`/`Backdrop` scheme.

### 5.4 Three things fixed that are not the asset

- **Every material in the world now carries a name.** 43 anonymous → 41 named, 0 anonymous.
  `world-shot --ablate` addresses materials by name and reported a class-name fallback before;
  this is the `art-station` trap, closed before it cost anything. The name is not part of
  three's program cache key, so it is free.
- **The belt's three byte-identical materials became one.** Three `MeshStandardMaterial`s with
  identical configuration were always one shader program; they were never three of anything.
  Materials 43 → 41.
- **`space:rim` is created `visible = false`.** `LightRig` demotes claimed lights, but it claims
  on `world:changed`, and the frame between construction and that walk is a frame in which the
  light count changes — which is a full recompile of ~390 programs. `Caves.js` and
  `MazeChunks.js` already do this with tests enforcing it; the roadmap lists 61 sites across 12
  world files that do not, as Phase 1's open item 4. This is the one in this world's file.
  Safe against the rig, which deliberately ignores a light's own `visible` flag when deciding
  whether to claim it.

---

## 6. The budget, before → after, in every framing

`node scripts/world-shot.mjs --world space`, fifteen framings, same machine, same GL.

| framing | draws | triangles | materials | programs | renderables | instanced | lights |
|---|---|---|---|---|---|---|---|
| arrival | 177→179 (+2) | 166490→184970 (+18480) | 43→41 (−2) | 245→245 | 44→45 (+1) | 6→7 (+1) | 1→1 |
| portal-home | 169→171 (+2) | 166466→184946 (+18480) | 43→41 (−2) | 245→245 | 44→45 (+1) | 6→7 (+1) | 1→1 |
| yard-astern | 173→175 (+2) | 166490→184970 (+18480) | 43→41 (−2) | 245→245 | 44→45 (+1) | 6→7 (+1) | 1→1 |
| bearing-cinder | 121→123 (+2) | 145412→163892 (+18480) | 43→41 (−2) | 245→281 (+36) | 44→45 (+1) | 6→7 (+1) | 1→1 |
| bearing-vitrine | 117→119 (+2) | 145732→164212 (+18480) | 43→41 (−2) | 281→296 (+15) | 44→45 (+1) | 6→7 (+1) | 1→1 |
| bearing-ceraunus | 117→119 (+2) | 145732→164212 (+18480) | 43→41 (−2) | 296→296 | 44→45 (+1) | 6→7 (+1) | 1→1 |
| bearing-tessera | 119→121 (+2) | 145412→163892 (+18480) | 43→41 (−2) | 296→296 | 44→45 (+1) | 6→7 (+1) | 1→1 |
| bearing-erenmark | 113→117 (+4) | 145412→163892 (+18480) | 43→41 (−2) | 333→333 | 44→45 (+1) | 6→7 (+1) | 1→1 |
| bearing-sirocco | 121→123 (+2) | 145412→163892 (+18480) | 43→41 (−2) | 365→372 (+7) | 44→45 (+1) | 6→7 (+1) | 1→1 |
| bearing-shoal | 121→123 (+2) | 145412→163892 (+18480) | 43→41 (−2) | 384→384 | 44→45 (+1) | 6→7 (+1) | 1→1 |
| bearing-verdigris | 118→117 (−1) | 149852→168332 (+18480) | 43→41 (−2) | 414→414 | 44→45 (+1) | 6→7 (+1) | 1→1 |
| bearing-lathe | 121→123 (+2) | 154584→173064 (+18480) | 43→41 (−2) | 420→421 (+1) | 44→45 (+1) | 6→7 (+1) | 1→1 |
| bearing-carnelian | 121→123 (+2) | 145412→163892 (+18480) | 43→41 (−2) | 422→422 | 44→45 (+1) | 6→7 (+1) | 1→1 |
| bearing-sallow | 117→119 (+2) | 145412→163892 (+18480) | 43→41 (−2) | 423→423 | 44→45 (+1) | 6→7 (+1) | 1→1 |
| bearing-cathedra | 117→119 (+2) | 145732→164212 (+18480) | 43→41 (−2) | 423→423 | 44→45 (+1) | 6→7 (+1) | 1→1 |

Geometries 332 → 333; textures 219 → 219.

### 6.1 Reading it against the noise floor

- **Shader programs: 423 → 423.** Identical settled value. Every per-framing delta in the table
  (+36, +15, +7, +1) is smaller than or equal to the swing the base tree showed against
  *itself* (+39). **No program family was added, which is the one axis this repository has a
  documented history of losing.**
- **Materials −2, renderables +1, instanced meshes +1, world lights 0.** All exact — the noise
  floor for those four is zero.
- **Draw calls +2 in fourteen of fifteen framings** (`bearing-verdigris` reads −1, inside its
  own ±3 band). One new renderable costs two calls because `renderer.info.render.calls` counts
  the GTAO prepass as well as the main pass.
- **Triangles +18,480 in every framing, exactly.** 44 hero rocks × 500, less the 44 × 80 they
  no longer cost in the procedural buckets. That is **+12.7%** of the world's triangles on a
  bearing framing and +11.1% on the apron.

### 6.2 The one number that went the wrong way, and why it was accepted

**+1 renderable, +1 instanced mesh, +2 draw calls, +18,480 triangles.** The brief says these
should be unchanged, so the reasoning is stated rather than buried.

An `InstancedMesh` carries exactly one geometry. Hero detail for the 44 rocks that need it is
therefore either a fourth bucket, or a silhouette taken away from the 216 that do not. Three
alternatives were costed:

| option | renderables | instanced | draws | triangles | cost |
|---|---|---|---|---|---|
| fourth bucket **(chosen)** | +1 | +1 | +2 | +18,480 | one draw call |
| hero replaces shape 2 | 0 | 0 | 0 | +18,480 | small-rock silhouettes 3 → 2 |
| all three shapes authored at 180 tris | 0 | 0 | 0 | +26,000 | more triangles, hero still too coarse for a crater |
| all three shapes authored at 500 tris | 0 | 0 | 0 | +109,200 | 500 triangles on an 18 m pebble |

The fourth bucket is the only one that does not either damage the field's authored variety or
pay hero detail on gravel. A draw call is the cheap axis in this project and a shader program
is the expensive one; this adds one of the former and none of the latter, and it is partly paid
for by the two materials the same change removes.

### 6.3 What the fifteen preset framings say about the art

Nothing, and that is the finding.

| framing | luma before→after | clipped % | edge before→after |
|---|---|---|---|
| arrival | 37.2 → 37.1 | 0.00 → 0.00 | 27.0 → 27.5 |
| yard-astern | 7.1 → 7.0 | 0.00 → 0.00 | 12.2 → 12.2 |
| bearing-cinder | 12.7 → 12.7 | 0.00 → 0.00 | 14.0 → 14.1 |
| bearing-shoal | 9.4 → 9.6 | 0.00 → 0.00 | 12.5 → 13.0 |
| bearing-erenmark | 6.7 → 6.7 | 0.00 → 0.00 | 7.0 → 6.5 |

Every one of the fifteen is unchanged to within a tenth of a luma point, because in all of them
the belt is 26 km away and a few dozen pixels wide. **A review conducted only on the harness's
own framings would have graded this pass as "no visible change" and both faults would still be
there.** That is the roadmap's "photograph the subject at conversational distance" rule paying
for itself for the fifth time in five branches.

---

## 7. Gates

`npm test` — **3,035 pass, 0 fail**, of which 23 are the two new files.
`node scripts/contract-check.mjs` — 129/129, all contracts satisfied.
`npm run build` — clean.

New: `scripts/tests/belt-assets.test.mjs` (17) and `scripts/tests/space-art.test.mjs` (6).
No existing test was edited.

Worth naming, because the roadmap's line is that a gate measuring something the game does not
do is worse than no gate:

- **The degenerate-triangle gate is read off the committed bytes, not off the generator.** The
  belt's material carries `flatShading: true`, so three ignores the stored normals entirely and
  takes `normalize(cross(dFdx, dFdy))` in the *fragment* shader — a zero-area triangle is a NaN
  pixel, `UnrealBloomPass` smears one NaN over the whole frame, and the symptom is a white
  screen with no error anywhere. The generator refuses one where the triangle is written; the
  test refuses one in the bytes that ship, which is a different claim.
- **Winding is checked twice**, because `art-dock` recorded that a backfacing surface is
  *absent* rather than wrong-looking. Per-face against the outward direction with a −0.35
  threshold (0 would ban crater walls), and globally by signed volume.
- **The belt is built both ways** — with the asset installed and without — and the test asserts
  the field, the radii and the collider set are byte-identical and only the bucket labels and
  the triangles move. The headless suite takes the *degraded* arm, which is the arm that has to
  keep working when the file is missing in production.
- **The white-material assertion is paired with an assertion on the instance colours**, so
  "material is white" cannot be made to pass by whitening the instances too, which would delete
  the field's colour variation instead of fixing the albedo.

---

## 8. What was refused

- **No `BatchedMesh` port.** The roadmap forbids it and the measurement says there is nothing
  to batch: 43 materials over 44 renderables.
- **No bloom or grade change.** 0.00% of pixels clip in all fifteen framings before and after.
  The `bearing-erenmark` disc reads as a blown white core and it is *not clipping* — that is
  a 2.78° star at `sunIntensity` 3.1 through an ACES shoulder, and it is faithful.
- **No change to the ring shadow on Ceraunus.** It reads oddly at first — a hard-edged wedge
  with straight sides cut through the ring bands. Measured against reference: a sphere's shadow
  on a ring plane *is* a straight-sided wedge near the planet, and the edge is hard because the
  source is a point at 245 km. It reads oddly and it is right; it is left alone.
- **No reduction of the halo shells' tessellation.** The eight atmosphere shells are 48,128
  triangles — 33% of the world's total — on a soft rim function that would very likely be
  pixel-identical at 32×24. It would have paid for the hero rocks two and a half times over.
  It is *not done* because it is a change to twelve bodies to buy a number, on a hypothesis
  that has not been photographed, in a branch whose sibling `art-planets` may want to touch the
  same shaders. Recorded here as the best remaining triangle win in this world, with the
  experiment written down: swap the shell geometry, re-shoot the fifteen framings, and diff the
  pixels; adopt only if the diff is under one luma everywhere.
- **No second hero silhouette.** 44 rocks share one shape, mitigated by per-instance
  non-uniform stretch (0.72–1.28 independently per axis) and an arbitrary tumble. A second
  would be a second renderable and a second draw call for a case that needs two 300 m rocks in
  one frame, and at ~1.6 km mean spacing in a 5.5 km field that is rare. Stated as a trade, not
  as a claim that it does not matter.
- **No change to the fifteen framings.** Two of them are arguably mis-aimed — `arrival` looks
  *back into* the hangar, when a player arriving through the portal is turned to face *out*
  down the piers with Vitrine ahead of them, and there is no framing at all for the first frame
  of this world. `src/dev/Harness.js` is outside this branch's file boundary. See §9.

---

## 9. The line against `art-planets`

`art-planets` covers planet SURFACES. This branch stayed on the **space/orbital** side of that
line and touched nothing a descent reaches:

**Touched:** `src/worlds/SpaceWorld.js`, `src/worlds/space/Belt.js`,
`src/worlds/space/BeltAssets.js` (new), `src/worlds/space/DockExterior.js` (material names
only — no geometry, no colour, no light), `public/assets/space/**` (new),
`scripts/make-belt-glb.mjs` (new), two new test files, one additive row in
`docs/assets/LICENCES.md`, this document and its images.

**Not touched, and left for `art-planets`:** `src/worlds/planets/**`, `PlanetWorld.js`,
`src/worlds/terrain/**`, `PlanetDescriptor.js`, and — this is the one worth naming —
**`src/worlds/space/BodyShaders.js`**. The twelve bodies' surface, atmosphere, ring and corona
shaders are the SKY side of the same object a planet branch will look at from the GROUND, and
`Bodies.js` is explicit that a body's `look` block is shared between the two. A palette change
here would land on a surface world's sky. `belt-assets.test.mjs` carries a cheap tripwire on
that line: open space owns exactly one authored asset and it is the belt boulder.

---

## 10. Defects found that nothing tests

### 10.1 Every gateway sign in the game renders its own mirror image on top of itself

**Not fixed — `src/systems/Portals.js` is outside this branch's file boundary and is a shared
system used by at least five worlds.**

`PortalSystem._buildSign` builds a plate whose material is `side: THREE.DoubleSide` with
`AdditiveBlending`, then adds **two** meshes of it — `front`, and `back` with
`rotation.y = Math.PI`. `DoubleSide` already draws the reverse face, so from either side the
viewer gets the correct text *plus its own mirror*, additively.

Measured rather than eyeballed, on `portal-home.png`, as mean `|L − mirror(L)|` over a rect
divided by that rect's mean luma:

| rect | asymmetry |
|---|---|
| the sign's text rows | **9.3%** |
| a same-size strip of hangar wall (control) | 132.2% |
| the whole frame (control — the scene is near-symmetric by construction) | 94.8% |

The sign is 91% horizontally symmetric. Legible text never is. Evidence:
`img/2026-08-23-art-space/defect-portal-sign-mirrored.jpg`.

Affects every portal whose `rotationY` turns its sign away from the approach — at least
`CitadelWorld`, `DockWorld`, `SportsWorld`, `SpaceWorld` (`Math.PI`) and `MedievalWorld`
(`Math.PI * 0.78`). The fix is one word (`side: THREE.FrontSide`, or drop the `back` mesh), it
is a *shared system*, and the roadmap's rule is not to change one on a screenshot read from one
world. **Handed to the orchestrator.**

### 10.2 `SpaceWorld`'s own budget block was stale by a factor of two

It claimed 41 meshes and 72,634 triangles and described "bodies 9 (5 surfaces, 2 halos…)".
Those were Phase 1 numbers; Phase 2 added seven bodies and nobody came back. Measured: 44
meshes and 145,412–166,490 triangles before this branch. Rewritten with the measurement, the
program-count caveat, and a line saying which parts a test now holds and which are a dated
browser reading. Third occurrence of this repository's signature failure — *a document that was
true when it was written and that nothing re-checks.*

---

## 11. For the sibling branches

**`HARNESS.look(..., { movePlayer: false })` produces invalid frames in `space`, and they do
not look invalid.** `world-shot --subject` uses it for two of its three headings.

The sky dome and the whole `Backdrop` are placed against the **player**, one frame behind the
pinned camera. Move the camera without the player and the 1920 m dome de-centres by the
separation: at 792 m off-centre its far side lands beyond the 2000 m far plane and gets
clipped, which renders as **a large soft-edged black ellipse eating the star field**, and every
body whose proxy distance now exceeds 2000 simply disappears. A 227-pixel ice world sitting
dead ahead of the camera was **absent from the frame** for this reason, and the shot looks
perfectly plausible.

Half an hour went into that as a suspected world defect before the diagnostic — dumping the sky
dome's distance from the camera — showed it was exactly the player/camera separation. Recorded
so nobody else spends it.

**The usable escape:** the `profile` heading coincides with the initial `movePlayer: true`
vantage, so it is always valid. With a **negative `--dist`** the camera is placed on the other
side of the subject, which is how the hero boulder was photographed. Near-field geometry
(anything within `NEAR_FIELD` = 1400 m, drawn at true position and scale 1) is correct in all
three headings; only the sky and the distant bodies are not.

Also worth carrying:

- **A material name is free and `--ablate` is useless without one.** Two of five branches have
  now found their world entirely anonymous. It costs one loop over the material table.
- **`programs` per framing is a warm-up ramp, not a measurement.** Establish it against the
  same code twice before reading a delta of ±39 as anything.
- **A bug can be two individually-correct lines with individually-correct comments.** The belt's
  albedo was tinted in the material *and* in the instance colour; grep would never find it, and
  no unit test renders.
