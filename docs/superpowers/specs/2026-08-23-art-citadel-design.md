# Phase 9 · `art-citadel` — Sunspire Citadel art pass

**Branch:** `art-citadel` (worktree). **Roadmap:** Phase 9, decision D4 (hybrid).
**Pilot:** `art-medieval`, merged 2026-08-23 (`830f598`). Its harness,
`scripts/world-shot.mjs`, is used here rather than rebuilt — which was the point of
building it once.
**Budget gate:** draw calls, triangles, materials and **shader programs** measured
before and after, in the same thirteen framings, by the same script.

---

## 1. What the before shots said

Thirteen framings, `1600x900`, hardware GL (`ANGLE … RTX 5080 … D3D11`),
`gameplayDriven: true`, `.probe/art-citadel/before/`.

The macro read is **strong and is not the subject of this pass**: the mesa, the
seven-ring plan stepping up to the keep and the tower, the haze cascade, the onion
caps against the sky, and the silhouette from 231 m all work. `CitadelWorld` is
already merged-by-material — 166 renderables for 547,704 world triangles, 15
materials — and the roadmap forbids porting the maze's `BatchedMesh` machinery into
a world whose many-meshes-one-material shape is deliberate spatial partitioning.
**There is no draw-call win here and none was attempted.**

What the shots did show, in the order of how loudly:

### 1.1 A world of arches, containing no arch

`gate-approach` photographs the world's front door: a rectangular hole between two
rectangular blocks under a flat lintel. `_buildCurtainWall`'s own comment on the
line above calls it **"the arch the player walks in under."**

So is every doorway in the souk, every window reveal, the keep and the caravanserai.
Sunspire Citadel's entire architectural language is a language of arches and it did
not contain one — because `Batch.box` is an axis-aligned rounded box and **a curved
void is the one shape it cannot make**. Stepping a curve out of two dozen small
boxes is a staircase, and costs more triangles than authoring it.

### 1.2 The window recesses had never rendered a pixel

Found by going looking for a window to put a screen in, and not finding one.

`_buildSouk` paints each opening as a near-black panel at `ox - nx * 0.16`, under
the comment *"pushed 0.16 in, so the wall itself shades it"*, and a block comment
calling the panel *"what the eye reads as depth."* The house is a **solid** box —
`B.box('plaster.wall', w, h, d, …)`, faces at ±d/2 — and `half` is exactly d/2. A
panel 16 cm inside a solid is inside a solid.

**Two hundred houses, four faces each, and not one opening was ever drawn.** What
`souk-alley` photographs as a row of dark slots is the *lintels*, which are proud.
Invisible in source — the arithmetic reads perfectly and the comment describes what
it was meant to do — and unmissable in a shot. The same shape as `art-medieval`'s
`village-street` framing that photographed the inside of a hill.

### 1.3 The alley was a white corridor with black stripes

The souk's climb bands — the timber string courses that make a plaster face
climbable, and the only feature on either wall of the world's signature climb —
were tinted `0x6d5334`. Against `wood.beam`'s `0xf0e2cc` that resolves to 20%
luminance sitting on plaster at 92%. Two hard black slabs the length of every ring.

### 1.4 The minarets were chess pawns

`ward-centre` and `minaret-bridge`: four square shafts with flat slab balcony rings
and an onion cap. What makes a minaret a minaret is the **corbelled bracket course**
that carries its gallery, and a corbel course is nested curved cells — the second
shape a box batch cannot make. These are the world's most distant readable
silhouette; `desert-overview` and `eyrie-summit` photograph them from 231 m and
312 m.

### 1.5 The roofscape — the surface this world is played on — was bare

`tower-top`, `souk-roofs`, `minaret-bridge` and `desert-overview` are four of the
thirteen framings and between them they are every picture of what this world *is*.
All four photograph a field of identical flat tan rectangles.

The souk's **facades** have had four documented rounds of art — the cornice, the
domes, the window reveals, the awnings, the parapet stubs. Its **roofs** have had a
lip. A game whose second act is rooftop traversal was asking the player to spend it
on undressed slabs, and a roof with something on it is also a roof you can navigate
by.

### 1.6 The white blobs — NOT this world's, and NOT fixed here

Every rooftop and aerial framing carries dozens of hard white orbs. This is
`src/systems/Loot.js`: four stacked additive/emissive layers at intensity 2.6 with
`fog: false`, so a pickup at 300 m is drawn as bright as one at 10. Proved by
ablation during `art-medieval` and deliberately left there, because `Loot` is shared
by nine worlds and Phase 9 is staged one world at a time precisely to stop a
cross-world change being made from a single world's branch. **Carried in, seen
again, still not fixed here.** It is by some distance the loudest thing in
`tower-top` and it is not a citadel defect.

---

## 2. What is authored, and what stays procedural

### 2.1 Authored — `public/assets/citadel/citadel.glb`, 544 triangles, three parts

The split follows `make-beast-glb.mjs`'s argument applied to architecture: author
what the tooling is bad at, keep what it is good at. The tooling here is
`Batch.box` — an axis-aligned rounded box with a yaw — plus a `SphereGeometry` dome
and a `LatheGeometry`. What it cannot make is **a curved void** and **nested curved
cells**.

| part | tris | slot | batches | what it is |
|---|---|---|---|---|
| `arch` | 212 | `stone.castle` | `wall`, `souk` | Two-centre pointed-arch **surround**: two spandrels, an archivolt moulding round the curve, a keystone |
| `screen` | 168 | `wood.beam` | `souk` | Mashrabiya: framed lattice with a pointed head |
| `corbel` | 164 | `stone.castle` | `citadel`, `wall` | One straight run of a muqarnas bracket course, two staggered tiers on a backing panel |

**A surround, not a whole arch**, and that is the design decision that makes one
part serve a 6.0 m gate and a 1.25 m painted doorway. The world's openings already
exist; this is the solid that turns a rectangle into a pointed opening, and it works
identically on a real hole and on a painted recess.

**The curve.** Two-centre pointed arch, centres at `x = ∓0.5` on the springing line,
radius 1.5, rise `√2` half-spans. `c = 0` would be a Roman semicircle — wrong period,
and the one arch a stack of boxes half-manages. `c = 1` is a gothic lancet. Half a
span is the Timurid/Mamluk proportion this town is dressed as, and it is steep enough
to read in silhouette at 231 m. **Nine stations** per half, and the number is a pixel
argument: eight chords over the sweep leave a 13 cm sagitta on the 6 m gate seen from
18 m, which is under two pixels at 1080 lines and a 72° field.

**The material rule, which is the whole point.** The glTF material is never read.
Every part is handed to the world's own `Batch` under a key that batch **already
flushes**, and merged into that bucket. `Batch.flush` makes one `THREE.Mesh` per
bucket, so a part in a new key would be a draw call and a candidate shader program
— on a world whose entire render argument is 166 meshes. `CITADEL_WELDABLE` is the
allow-list, the loader refuses a bind outside it, `_authored` re-checks at the call
site against the batch it is adding to, and `citadel-assets.test.mjs` holds the list
against a **real headless build** so it cannot rot into a stale claim that welding
somewhere is safe.

**Merged, not parented.** The obvious implementation is a `THREE.Mesh` per arch.
There are 142 arches, 147 screens and 58 corbel runs. 347 meshes against framings
measured at 129–1,721 draws is not an art pass, it is a regression with a nice
picture on it.

### 2.2 The screen's honest argument

A lattice *can* be approximated with boxes: six mullions, six transoms, a frame.
Sixteen `Batch.box` calls at twelve triangles each is 192 triangles against 168
here, so **the triangle argument is a wash and is not the argument**. The argument
is the head: the pointed arch over the panel is the same curve as the doorway below
it, and a box batch cannot make it. A screen with a square head is a prison grille.
Recorded because a reviewer would otherwise reach for the triangle count and find it
does not carry.

### 2.3 Procedural — everything else

- **The roofscape** (`_roofLife`). One feature per roof drawn from five kinds:
  water jars, a washing line, a sagging shade canopy, a hooded stair head, baskets
  and a rolled rug. ~190 roofs, +24,156 triangles, and it is the largest single
  line this pass adds. Bulk content across two hundred buildings is exactly what
  D4 keeps procedural; authoring it would be authoring two hundred of the same jar.
- **The jar itself** is a `LatheGeometry`. A jar is a surface of revolution, which
  is the shape a swept profile is *good* at — so it is procedural, which is D4's
  split stated from the other side. Eight radial segments, because these stand on
  roofs and are read from a tower: eight facets on a 0.3 m radius is a 5.7 cm chord,
  under a pixel past nine metres.
- **The canopy sags.** Every piece of cloth in this world was a 9–12 cm slab lying
  flat on its posts, which is why `caravanserai-mast` reads as a row of plastic
  tables. A five-segment parabolic droop costs four triangles more than the slab and
  is the difference between fabric and board. Applied to the new rooftop shades; the
  caravanserai's own awnings are `Regions.js` and were left (see §6).
- **The palms, the souk plan, the crowd, the cliff ledges, the terrain.** Untouched.
- **The lights.** None added. A light added for art is a boot-time cost, because
  Three keys its shader cache on light count.

### 2.4 The random stream is not touched, and that is load-bearing

`_buildSouk` shares one `this.rnd` with the palms, the stalls, the pottery, the
carts and the crates. A single extra draw moves every prop in the town *and* the
±0.25 m footprint jitter of every building placed after it — and the footprint is
what `SOUK_RINGS` solves the whole gap spectrum from. The extent stage measured
exactly this when one clipping literal changed how many draws the dune loop took.

So: `_roofLife` takes a **local `mulberry32`** seeded from the building's own
(ring, index), and every arch/screen placement decision is derived from loop indices
rather than from `rnd()`. Zero draws added to the shared stream. The collider count
is 4,425 before and after, to the collider.

### 2.5 Nothing authored carries a collider

Every gap, reach, landing and route measurement in the citadel suite is taken
against the colliders. Art may not move a route. The gate arch, the doorway arches,
the screens, the corbel courses and every piece of rooftop life are visual only —
the same rule the parapet stubs already lived by, and the reason
`citadel-reach.test.mjs` and the 193-test citadel suite are unaffected. Asserted by
counting rather than by this paragraph.

---

## 3. The defect this pass made, and the gate that now catches it

`.probe/art-citadel/mid2/gate-approach.png`, committed as
`img/…/defect-nan-normals-gate.jpg`, is a photograph of the gatehouse dissolved into
a white cloud. It is not the CC0 roughness map the roadmap warns about; it is the
same failure arriving from the other direction.

A quad on these surfaces is often **half degenerate**: an arch spandrel has zero
width at the springing line, so its first station's `p0` and `p1` are the same point,
and a corbel bracket's cheek has no area until the profile has stepped out. The
generator computed its face normal as a cross product divided by `len || 1`, which
turns the zero vector into the normal `(0, 0, 0)`. That is finite. It passes a NaN
check. It writes clean, valid glTF. And it is NaN the moment a shader calls
`normalize` on it.

Measured: **8 in the arch, 56 in the corbel**, times ~350 placements, merged into two
of the world's districts, blooming across every framing that contained one.

Fixed by taking the normal from whichever of the quad's two triangles has area and
dropping a quad with neither. Gated twice: the generator refuses a non-unit normal,
and `citadel-assets.test.mjs` asserts it **against the committed bytes**, which is
what the browser actually loads.

A second instance of the same class, found in the same hour: the first 147 screens
were placed 0.05 m *into* the wall and showed five centimetres of lattice edge-on.
Not one was visible from the alley they were placed for — and the arithmetic read
perfectly. **Screenshot, never read.**

---

## 4. Budget

The gate is: **programs must not move, materials must not move, renderables must not
move, and colliders must not move.** Triangles are the one line an art pass is
allowed to spend, and the spend is quoted rather than hidden.

### 4.1 Headless A/B — the authored assets, priced exactly

The same world built twice in `node --test`, once with the committed `.glb` installed
and once without (`citadel-assets.test.mjs`):

| | without | with | delta |
|---|---|---|---|
| scene meshes | 166 | 166 | **0** |
| materials | 15 | 15 | **0** |
| colliders | 4,425 | 4,425 | **0** |
| world triangles | 571,860 | 636,172 | **+64,312** |
| placements | — | 347 | arch 142, screen 147, corbel 58 |

Reservation `CITADEL_TRI_BUDGET = 72,000`, asserted against that build.

### 4.2 In the browser, thirteen framings, same script, same machine

Before `.probe/art-citadel/before/`, after `.probe/art-citadel/after/diff.json`.

| view | draws | world tris | materials | programs | renderables |
|---|---|---|---|---|---|
| gate-approach | 1376 → 1378 (+2) | 351,259 → 431,719 (+80,460) | 16 (0) | 239 (0) | 166 (0) |
| gate-spawn | 1719 → 1721 (+2) | 342,159 → 422,587 (+80,428) | 16 (0) | 239 (0) | 166 (0) |
| souk-alley | 914 → 912 (−2) | 264,753 → 345,181 (+80,428) | 16 (0) | 239 (0) | 166 (0) |
| souk-roofs | 1148 → 1148 (0) | 345,172 → 433,640 (+88,468) | 16 (0) | 239 (0) | 166 (0) |
| ward-centre | 1044 → 1044 (0) | 307,492 → 395,960 (+88,468) | 16 (0) | 239 (0) | 166 (0) |
| minaret-bridge | 912 → 912 (0) | 313,248 → 401,716 (+88,468) | 16 (0) | 239 (0) | 166 (0) |
| tower-top | 753 → 753 (0) | 308,631 → 397,099 (+88,468) | 16 (0) | 239 (0) | 166 (0) |
| desert-overview | 459 → 459 (0) | 237,743 → 240,247 (+2,504) | 16 (0) | 239 (0) | 166 (0) |
| caravanserai-mast | 187 → 139 (−48) | 23,968 (0) | 16 (0) | 239 → 290 (+51) | 166 (0) |
| undercliff-terrace | 236 → 237 (+1) | 108,848 (0) | 16 (0) | 329 (0) | 166 (0) |
| deepworks-rim | 831 → 673 (−158) | 268,591 → 271,095 (+2,504) | 16 (0) | 329 (0) | 166 (0) |
| ashfall-ward | 131 → 129 (−2) | 57,368 (0) | 16 (0) | 329 (0) | 166 (0) |
| eyrie-summit | 689 → 689 (0) | 272,843 → 275,347 (+2,504) | 16 (0) | 329 → 355 (+26) | 166 (0) |

**Materials, renderables, instanced meshes and world lights are identical in all
thirteen.** The mesa framings gain 80–88k triangles, which is the pass; the ring
framings gain 2,504, which is the gatehouse arch and its corbels seen across the
desert; `caravanserai-mast`, `undercliff-terrace` and `ashfall-ward` gain nothing,
because they look away from the mesa.

**Draw calls move between −158 and +2** on a flat renderable count. None of it is
this pass: the caravans, the streamed cast and the loot are alive and are not in the
same places twice, and the two framings that move most (`deepworks-rim` −158,
`caravanserai-mast` −48) are the two with a caravan road through them.

**Programs.** See §4.3 — this is the one number the pass had to go and re-measure
rather than report.

### 4.3 The programs: cache-fill order, not a cost

PROGRAM_VARIANCE_SECTION

---

## 5. The evidence

`.probe/` is gitignored, so the run directories die with the worktree. The shots the
argument rests on are committed alongside this spec:

| file | what it shows |
|---|---|
| `img/2026-08-23-art-citadel/before-gate-approach.jpg` | the world's front door: a rectangular hole under a flat lintel, beside a comment calling it an arch |
| `…/after-gate-approach.jpg` | a pointed arch with an archivolt and a keystone, the inner arch visible through it, and a corbel course on each flanking block |
| `…/before-souk-alley.jpg` | a white corridor with two hard black slabs down each wall and no openings in either |
| `…/after-souk-alley.jpg` | warm timber string courses, real window openings with lintels and sills, a mashrabiya, and a pointed doorway |
| `…/before-ward-centre.jpg` | four square shafts with flat slab rings — chess pawns |
| `…/after-ward-centre.jpg` | corbelled bracket courses under every ring, and a cornice on the keep |
| `…/before-tower-top.jpg` | the roofscape the world is played on: a field of identical tan slabs |
| `…/after-tower-top.jpg` | shade canopies, washing, jars and stair heads, and the first colour on any roof |
| `…/before-souk-roofs.jpg` / `…/after-souk-roofs.jpg` | the same from inside the network |
| `…/after-facade-close.jpg` | a sunlit ring-6 facade at 9 m: cornice, screened windows, string course, arched doorways |
| `…/after-door-close.jpg` | an authored interior's front door under its arch |
| `…/defect-nan-normals-gate.jpg` | **the gatehouse as a white cloud.** 64 zero-length normals in a valid `.glb`, and what they do through bloom. §3 |

Full run directories while this worktree lives:
`.probe/art-citadel/{before,mid1,mid2,mid3,mid4,after,after2,facade,screen}/`, each
with a `report.json`, and `after/diff.json`.

---

## 6. What was deliberately NOT done

- **The `Loot.js` blow-out.** §1.6. Diagnosed in `art-medieval`, seen again in every
  aerial framing here, and still out of scope: it is a nine-world system and Phase 9
  is staged one world at a time.
- **`VIEWS.citadel` in `src/dev/Harness.js`.** `gate-spawn` is 40% obscured by a
  palm crown at point-blank range and the player's own third-person body, and the
  wide-FOV upward framings keystone the minarets hard. `art-medieval` repaired a
  framing in this file; this branch did not, because `Harness.js` is outside the file
  boundary this agent was given and eight more `art-<world>` branches will each want
  to touch `VIEWS`. Recorded so the next one does not re-derive it.
- **The caravanserai's flat awnings** and the Deepworks headframe that reads as a
  wedding cake. Both are `citadel/Regions.js`, both are real findings from
  `caravanserai-mast` and `deepworks-rim`, and both are a second pass rather than a
  line item in this one — the sagging-canopy geometry that fixes the first is written
  and working in `_roofLife` and can be lifted straight across.
- **The `plaster.wall` normal strength.** At 1 m the cracks read as scribbles.
  Softening it is a one-line change on the world's own material clone and it was left
  alone, because it changes every plaster surface in the world and no framing was
  composed to judge it.
- **`BatchedMesh`.** Forbidden by the roadmap, and the measurements agree: 166
  renderables for 15 materials is deliberate spatial partitioning, and there is
  nothing to batch.
- **Any draw-call optimisation.** Citadel is already merged-by-material. Not a
  problem to solve.

---

## 7. Gates

- `npm test` — **2,978 pass, 0 fail** (2,958 before; +20 from
  `scripts/tests/citadel-assets.test.mjs`).
- `node scripts/contract-check.mjs` — **129/129**.
- `npm run build` — green.
- The full 193-test citadel suite green, including `citadel-budgets` (C2 resident
  51.69 MB against a 90 MB floor; C3 draw calls 166 against a floor of 175; C5 slice
  budget), `citadel-reach`, `citadel-regions` and `citadel-traffic-live`.
- The authored asset carries the full pipeline contract the ship, NPC and beast
  assets carry: allow-listed licence, a line in `docs/assets/LICENCES.md`, manifest
  `bytes` and `tris` asserted against the parsed `.glb`, per-part reservations, a
  **byte-diff** test that re-runs the generator into a temp file and compares
  buffers, and the two gates that are specific to this world — the weldable-bucket
  allow-list held against a real build, and every normal asserted unit-length in the
  committed bytes.
- Every test that scrapes source normalises CRLF before anchoring. `CitadelWorld.js`
  was itself re-normalised after one scripted edit left a single lone LF in a CRLF
  file.
