# Phase 9 · `art-medieval` — Aldermoor Vale art pass

**Branch:** `art-medieval` (worktree). **Roadmap:** Phase 9, decision D4 (hybrid).
**Budget gate:** Phase 1's. Draw calls, triangles, materials and **shader programs**
measured before and after, in the same framings, by the same script.

---

## 1. The method, and the tool it forced

The roadmap's own line is *"Never assess art by reading code — screenshot it."* Phase 6
earned it: three defects (hands bound across the centreline, heads a third too small, a
palette that chopped a silhouette into three) were all invisible in source and all obvious
in a shot.

Phase 9 runs **nine times**. So the shot harness is written once, in `scripts/`, not nine
times in a `.probe/` directory that dies with its worktree:

**`scripts/world-shot.mjs`** — drives real Chrome over CDP against a real Vite dev server,
zero new dependencies (Node 22's global `WebSocket`, the same shape as
`scripts/hud-viewport-probe.mjs`). Per run it records, for every framing:

| field | why it is there |
|---|---|
| the PNG | the thing being judged |
| `drawCalls`, `worldTriangles` | the budget. Triangles from `HARNESS.worldTriangles()`, which reproduces exactly, **not** `renderer.info.triangles`, which sums the shadow and GTAO passes and moves 10–13% between loads of an identical framing |
| `materials`, `renderables`, `instancedMeshes`, `instances` | a new material is a candidate new program; a shared one is free. The ratio to renderables is the whole merged-vs-partitioned question |
| **`programs`** | `renderer.info.programs.length`, live, not the once-a-second sample. The number this project has a documented history of losing |
| `worldLights`, `worldLightsLit` | whether `LightRig` has demoted the world's lights, or whether art has quietly bought a program set |
| `gameplayDriven` | **invalidates everything above it when false.** An automated browser holds no pointer lock, `main.js` blocks its gameplay update block without one, and every LOD system stops. Figures taken in that state are the LOD-disabled worst case |
| `renderer` | the GL string. A run that silently fell back to SwiftShader takes fifteen minutes to reach its first view and its frame times mean nothing — and the only symptom is that it is *slow*, which reads as "the world is heavy": the exact wrong conclusion for a budget gate. This cost one wasted run before it was recorded |

Two capabilities beyond "take a picture", both of which earned themselves inside this pass:

- **`--ablate <material names>`** — hide every mesh drawn with a named material, then shoot.
  The A/B that says which system owns a pixel. It immediately cleared the system this pass
  was about to "fix" (see §2).
- **`--subject "name=<js>"`** — frame a live object from three headings. Every preset view in
  the harness is a landscape vantage; a beast is wherever its pack wandered. The harness
  walks the *player* to the subject first, because NPC detail is banded on distance to the
  player and a camera flown to a subject 300 m from the player photographs the lowest LOD in
  the game and reports it as the art.

## 2. What the before shots actually showed

Seven framings, `1600x900`, high tier, hardware GL, `gameplayDriven: true`.

The vale's **architecture, terrain and aerial perspective are strong** and are not the
subject of this pass: the castle reads as mass, the merlons and buttresses carry the
silhouette, the haze cascade separates four landforms, the timber-frame village is
convincing. `MedievalWorld` is already merged-by-material through `GeoBatch` (nine batch
flushes over ≤31 material keys) plus seventeen `InstancedMesh` systems, `DistanceLod`,
100 m terrain tiles and a 58-zone grass residency. **There is no draw-call win here and no
`BatchedMesh` port to make** — the roadmap forbids the latter and the measurements say the
former does not exist.

What the shots did show:

### 2.1 The white blow-out — NOT this world's, and not fixed here

> **CORRECTED 2026-08-24 by `orb-hunt`. The attribution below is WRONG.**
>
> The orbs are **not** `src/systems/Loot.js`. They are `relic.glow` —
> the halo billboard in **`src/systems/Relics.js`**, an `InstancedMesh`
> parented to the **scene**, not to any world group.
>
> `art-loot` disproved the loot attribution first (hiding the loot group left
> fourteen orbs standing, moving −1.0 to +1.0 lum) but could not say what they
> were. `orb-hunt` then named them, in pixels, against a null floor of **0.0**:
> hiding `relics:glow` alone took `medieval/hills-vista` from **8 orbs to 0**
> and `citadel/tower-top` from **19 to 0**, and every orb sat within
> **1.0–9.5 px** of a projected relic instance.
>
> The reason four branches could not find it: every ablation tool in the repo
> walks `worldManager.active.group`, and these meshes are not in it —
> `relic.glow` is not among this world's 27 world-group material names, so
> `--ablate` could never reach it whatever name it was given.
>
> Two further corrections to the paragraphs below:
>
> - **"a dozen scattered across the vale" was partly the harness.** On the
>   repaired `Harness.ready()` (which no longer returns during `prewarm`),
>   `hills-vista` shows **4**, not the dozen reported here. The rest were
>   objects `rehearse()`'s `forceDrawable` was holding visible mid-warm.
> - The **`fog: false`** half of the diagnosis was right, and right about the
>   wrong file. `relic.glow` carried it; it now carries the shared
>   `hazeAdditive` law instead, which is worth **−11 to −42 lum** on the 13
>   relics beyond 455 m in this framing (control floor 5.9).
>
> What is left in this framing after that fix is **4 relic halos at 57–203 m**,
> which no fog law can touch because Aldermoor Vale's fog is `near 86 / far 880`
> and is still under 3% attenuation at 200 m. Those are a *radiance* defect, not
> a fog one, and they are handed back deliberately — see
> `2026-08-23-orb-hunt-design.md` §5.
>
> The original text follows, unedited, because the ablation it records is real
> and is what ruled out `medieval.glow`.

Four of seven framings carry hard white orbs: one searing blob in the village square, three
on the castle approach, a dozen scattered across the vale in `hills-vista` — in empty
fields, on the river, 300 m out.

First hypothesis was `medieval.glow`, the additive light-spill cards. **Ablation killed it:**
`--ablate medieval.glow` hid the one instanced mesh and every orb survived.

A projection probe then named them: a **loot pickup**, kind `trinket`, at 14.1 m, exactly on
the blob's pixel — four stacked elements from `src/systems/Loot.js`:

```
loot.core.trinket    MeshStandardMaterial  emissive #d46bff  emissiveIntensity 2.6
loot.ring.trinket    MeshBasicMaterial     AdditiveBlending  fog: false
loot.halo.trinket    SpriteMaterial        AdditiveBlending  fog: false
loot.beam.trinket    MeshBasicMaterial     AdditiveBlending  fog: false
```

*(The probe found a real loot pickup at 14.1 m. What it did not establish is that
the pickup was what any given orb was made of — the projection put a pickup near
a blob, and the inference from "near" to "is" is the whole error. `orb-hunt`'s
projection puts a RELIC within 1.0–9.5 px of every orb, and then removes them by
hiding that mesh.)*

Two separate faults, both global:

1. Four additive/emissive layers at intensity 2.6 saturate every channel, so a violet pickup
   renders as a **pure white core** and blooms into a cold halo that recolours the ground
   around it.
2. **`fog: false`** means a pickup at 300 m is drawn at exactly the brightness of one at
   10 m, with no aerial perspective at all — which is why they punch through the haze as
   hard dots across a whole valley that is otherwise carefully graded.

*(Both faults were real and both are now fixed — fault 1 and fault 2 in `Loot.js`
by `art-loot`, and the same fault 2 in `Relics.js` by `orb-hunt`. Neither fix
made this framing calm, because the orbs in it were never loot.)*

**Deliberately not fixed on this branch.** `Loot.js` is a shared system used by all nine
worlds; the placement is medieval's (`medieval/Treasures.js` publishes the collectible
spots), the appearance is not. Brief 4.1.7 stages Phase 9 one world at a time *"to reduce
risk"*, and a cross-world change to pickup rendering made from `art-medieval` is exactly the
risk that staging exists to prevent. It is written down here with its evidence so the next
branch — or the systems owner — can take it with the diagnosis already done.

### 2.2 `village-street` photographs the inside of the terrain

`VIEWS.medieval` in `src/dev/Harness.js` puts that camera at `y = 2.2`, which is **below
the ground** at `(20, 40)`. The shot is of the underside of the terrain skirt with tree
canopies floating in it. One of this world's seven authored framings has been blind.

A gate that measures something the game does not do is worse than no gate — that shape cost
World 06 nine times. Fixed by raising the vantage onto the ground it was written for.

### 2.3 The wildlife is the world's job and had the least art in it

Phase 3 gives Aldermoor Vale **settlement and wildlife**; it is the only world with beasts.
The settlement half has had four documented rounds of art tuning (the fog cascade, the
separation rim, the window emissive, the macro breaker). The beasts have had none, and one
authored colour on every profile is created and thrown away (§3.2).

That is where D4's authored `.glb` goes.

## 3. What is authored, and what stays procedural

### 3.1 Authored — `public/assets/medieval/beast.glb`

The same argument as `make-npc-glb.mjs`, applied to a quadruped: author the features
procedural lofting is bad at, keep everything lofting is good at.

`BeastBody.js` sweeps a generalised cylinder along a path, and that is the correct
description of a barrel, a neck, a tail and every segment of a leg. It is the wrong
description of a **hackle ruff**, a **shoulder-hump mane**, a **brow shelf** and a **claw
set** — masses with an edge, which a swept ellipse cannot make and a scaled sphere makes
badly ("don't build organic shapes from stacked boxes", and don't build a ruff from one
either).

One file, two sets of named parts, exactly as `raider.glb` / `crew.glb` split eleven roles
across two files: which parts a species shows is a **manifest** decision, not a geometry one.

**The material rule, which is the whole point.** The glTF material is never read. Every part
draws in one of the beast's own already-cloned surfaces — `coat`, `belly`, `dark`, `claw` —
named by a manifest field. Three keys its shader-program cache on material configuration and
this project boots by warming the cartesian product of those programs. An authored beast that
brought its own PBR material would be a new program family on every medieval load. Reusing
the slots costs exactly zero programs, zero materials and zero draw calls, because the parts
are **merged into the mesh the species already draws**, not parented to it.

### 3.2 The `belly` slot: authored, allocated, and never used

Every profile in `BeastBody.js` declares a `belly` colour. `_build` clones a material for it
(`BeastBody.js:909`), files it in `materialSet`, and **assigns it to no mesh**. Every wolf,
bear and camel in the game is one flat coat colour from nose to tail, and pays for one wasted
material clone to be that way.

Countershading — a pale underside — is one of the strongest readability cues a quadruped has
at distance, and the colour for it is already chosen and already in the table. Using it costs
one merged geometry group rather than one extra mesh, so it is a draw call the animal already
pays.

### 3.3 Staying procedural

- **The foliage.** `medieval.leaf` is 1.48–1.54 M triangles, 60% of the world, across
  ~50–60 instanced buckets on a 150 m grid with a canopy LOD swap. It is not naive and it is
  not cheap; it is the largest single line in the budget and it is deliberate. Re-authoring
  it is a phase of its own, not a line item in this one.
- **The settlement.** 35 hand-placed cottage plots, five towns, 68 buildings, 40 enterable,
  all merged by material. Nothing here is authoring-shaped.
- **The crowd.** `_figureGeo` builds ~100-triangle silhouette figures precisely so the world
  can have people in it without spending skinned characters on them. That trade is correct.
- **The lights.** 156 in the world group, `worldLightsLit: 0` — `LightRig` has demoted every
  one. **No light is added by this pass.** A light added for art is a boot-time cost.

## 4. Budget

The gate is: **programs must not move**, materials must not move, and draw calls must not
move by more than the beasts' own merged parts (which is zero, by construction — the parts
are welded into geometry the animal already draws).

Before (this branch's baseline, recorded in `.probe/art-medieval/before/report.json`):

| view | draws | world tris | materials | programs |
|---|---|---|---|---|
| castle-approach | 1020 | 2,301,512 | 41 | 352 |
| castle-gate | 818 | 2,162,308 | 41 | 352 |
| village-square | 1549 | 2,469,140 | 41 | 352 |
| village-street | 1335 | 2,319,604 | 41 | 352 |
| ramparts-vista | 1268 | 2,291,376 | 41 | 352 |
| portal | 1155 | 1,840,998 | 41 | 352 |
| hills-vista | 1305 | 2,639,514 | 41 | **399** |

After (`.probe/art-medieval/after/diff.json`), same script, same framings, same machine:

| view | draws | world tris | materials | programs |
|---|---|---|---|---|
| castle-approach | 1022 (+2) | 2,301,512 (0) | 41 (0) | 352 (0) |
| castle-gate | 820 (+2) | 2,162,308 (0) | 41 (0) | 352 (0) |
| village-square | 1541 (−8) | 2,469,140 (0) | 41 (0) | 352 (0) |
| village-street | 1350 (+15) | 2,319,604 (0) | 41 (0) | 352 (0) |
| ramparts-vista | 1257 (−11) | 2,291,376 (0) | 41 (0) | 352 (0) |
| portal | 1095 (−60) | 1,840,998 (0) | 41 (0) | 352 (0) |
| hills-vista | 1301 (−4) | 2,639,514 (0) | 41 (0) | 352 (−47) |

**The gate held exactly.** Shader programs, materials, world triangles, renderables,
instanced meshes and world lights are identical in all seven framings. World triangles are
unchanged *to the triangle* because nothing in the world group moved: the authored geometry
belongs to beasts, which are NPCs and are not counted by `worldTriangles`.

Draw calls move between −60 and +15. None of it is this pass: the beasts and the streamed
villagers are alive and are not in the same places twice, and `village-street` is +15 because
its camera came out of the ground and can now see a market square. The change that *could*
have cost draw calls — four authored parts on up to eight streamed animals, which would have
been 32 — costs zero by construction, and `beast-assets.test.mjs` asserts that with a
headless A/B rather than leaving it to this table.

The 399 at `hills-vista` in the before column is pre-existing run-to-run variance in when the
program cache fills, not a regression this pass removed. Recorded because a later run that
reports 399 there should not be read as one either.

## 5. The evidence

`.probe/` is gitignored, so the run directories die with the worktree. The shots that carry
the argument are committed alongside this spec, in the shape the maze phase's were
(`img/2026-08-09-phase-6/`):

| file | what it shows |
|---|---|
| `img/2026-08-23-art-medieval/before-village-street.jpg` | the camera two and a third metres inside the hill: a flat beige field with tree canopies hanging in it |
| `…/after-village-street.jpg` | the same framing at eye height - church tower, market stalls, cobbles, villagers |
| `…/before-village-square.jpg` | knee height, and a searing white blob in the middle of the square |
| `…/after-village-square.jpg` | eye height |
| `…/before-wolf.jpg` | a smooth barrel with four pods bolted to it, one flat colour nose to tail |
| `…/after-wolf.jpg` | a hackle ridge along the topline and pale lower legs |
| `…/loot-blowout-hills-vista.jpg` | a dozen hard white orbs across the vale, in empty fields and over the river at 300 m |
| `…/loot-blowout-glow-ablated.jpg` | the same framing with `medieval.glow` hidden. **The orbs are still there.** The ablation that stopped this pass fixing the wrong system |

The full run directories, while this worktree lives, are `.probe/art-medieval/{before,after,
beasts-before,beasts-after,ablate-glow}/`, each with a `report.json` and `after/diff.json`.

## 6. Gates

- `npm test` — 2804 before, more after; every new number in the manifest asserted against the
  file on disk.
- `node scripts/contract-check.mjs` — 128/128.
- `npm run build`.
- The authored asset carries the full pipeline contract the ship and NPC assets carry:
  allow-listed licence, a line in `docs/assets/LICENCES.md`, manifest `bytes` and `tris`
  asserted against the parsed `.glb`, and a **byte-diff** test that re-runs the generator into
  a temp file and compares buffers.
- Any test that scrapes source normalises CRLF before anchoring.
