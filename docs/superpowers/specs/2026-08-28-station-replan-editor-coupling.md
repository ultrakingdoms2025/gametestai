# Station placement re-plan × the map editor — coupling, constraints and sequencing

**Status:** design, not yet approved. **Date:** 2026-08-28.
**Origin:** the owner's report — "objects on top of objects, floating fixed people, fixed people without
heads, buildings placed halfway on roads/paths, walls that can be walked through, platforms that go
through other objects" — followed by the constraint that decides the shape of the work:

> "we must also not forget the impact on the map editor; moving, placing, removing objects needs to
> remain functioning."

**Method:** seven parallel source lanes (applier, identity/anchor, ground sampler, site conflicts,
existing reservation fragments, physics, build order + contracts), each adversarially refuted against
the source, then synthesised and attacked by two critics. 17 agents, 885 tool calls. Every claim below
carries a `file:line`; the ones marked **[verified]** were re-opened by hand afterwards.

See also [[station-overhaul-aug-2026]] and [[map-editor-stage1-aug-2026]] (whose stage-2 tail is the
editor as built).

---

## 0. The two things to do before any of this

Both are live today. Neither is caused by the redesign, and one may close a reported symptom outright.

### 0.0 Census run against production, 2026-08-28 — two answers and one new finding

Read-only query against the production Neon database (`.probe/map-census.mjs`, `SELECT` only, gitignored).

**Q1 — does production hold move/remove entries against station names? NO. C1 is forward-risk, not live
data loss.** Exactly one world has an overlay document at all: `station`, v6, schema 2, 9 entries. Across
**all six versions the entry kind census is `place × 27` and nothing else** — zero `move`, zero `remove`,
zero `hidden`, and **zero name-targeted entries in any version of any world**. A `place` entry carries no
target, so the rename in Phase 1 is a **no-op on existing data**: the DB name migration drops from
mandatory-in-the-same-release to *not needed at all*, and the constraint relaxes to "rename before anyone
authors the first move or remove".

**Q2 — the headless-people hypothesis is REFUTED.** No entry targets `StationActors:*` in any version of
any world. The missing heads are a real defect in the game, not an editor edit. §0.1 is kept below for the
record and for the mechanism it documents, which remains a live hazard.

**S13 — RAISED AND THEN REFUTED BY MY OWN MEASUREMENT. Recorded because the refutation is the useful part.**

*What I claimed:* that every `InstancedMesh` anchor is frozen at first observation, on the evidence that all
eleven `StationActors:*` anchors sit within ~30 cm of (−123.1, 0, 5.0) while those meshes hold ~1,900 actors
across a 1,488 m map. I read that clustering as "the box is 30 cm wide".

*What is actually true.* Measured on a headless build: `StationActors:head` holds 1,887 instances, **all
1,887 real** — none identity, none zero — and its box spans **1,111 × 1,235 m**. Bottom-centre of that box is
(−123.25, 0.86, 5.02), which is the production anchor **to three decimal places**. The eleven parts agree to
within 30 cm because they are eleven bottom-centres of eleven boxes with the same map-wide extent, differing
only in their lowest point (a head's lowest head at 0.86, a calf's lowest calf at −0.116) and a few
centimetres of centre. **The anchors were correct all along.** This is the failure mode this repository
documents about itself — deliberate, correct behaviour flagged as a defect — and I reproduced it.

*And the attempted fix was worse than the bug.* I added a `freshenInstanceBounds` helper that nulled the
cache before every measurement, then found `_hideActor` collapses a culled figure with an **all-zero matrix**
(`StationActors.js`, `_mZero`), whose `w` is zero. `Box3.applyMatrix4` through it divides by zero: every axis
becomes **NaN**, `Box3.isEmpty()` returns **false** for a NaN box so `_anchor`'s empty-guard does not catch
it, and `Math.round(NaN * 1000) / 1000` is NaN — which `JSON.stringify` writes into the report as `null`.
Forcing a recompute at any moment when even one actor is culled would have turned eleven catalogue anchors
into nulls in production. **Reverted; nothing of it shipped.**

*What survives, correctly framed.* The cache is real: `computeBoundingBox()` runs once and three never
invalidates it. It is harmless today only because the one measurement happens while every instance matrix is
still real — **correct by timing, not by construction**. Two things follow. The all-zero cull matrix is a
latent NaN source for any future code that measures those meshes mid-session; and Phase 1's
`StationActors:*` catalogue exclusion, already planned for other reasons, removes the exposure entirely.
A cheap assertion that every reported anchor is finite now stands in `station-catalogue.test.mjs` —
it would have caught my own regression.

Other facts worth having: all 18 worlds have reports carrying `ground` and `shapes` at `layout_schema = 1`;
station reports **756 objects**, `applied v6 = built v6`, `unresolved: []`, and all nine placements
`ok: true, colliders: 0`; **all 18 district-scale names are present in the stored catalogue**, confirming
§0.2's hazard against live data.

### 0.1 The headless people — mechanism, now refuted as the cause <span>[REFUTED by the census above]</span>

`StationActors` builds eleven named `InstancedMesh`es, `m.name = \`StationActors:${name}\`` —
`src/worlds/station/StationActors.js:543` — of which **`this._mHead = mk(G.head, skinMat, 'head')`
(:574) holds every fixed actor's head and nothing else**. They hang under the group named `actors`
(`src/worlds/StationWorld.js:10104`), a direct child of `world.group`, so `_catalogue`'s breadth-first
walk reaches them at depth 2 and lists them near the **top of the admin's picker**
(`src/systems/MapOverlay.js:1261-1266). `_applyRemove` resolves by name and sets `target.visible = false`
(:1027, :1044). **[verified]**

The asymmetry that matches the symptom exactly: the *ambient* crowd's heads are created through
`instanced()` (`src/worlds/station/StationKit.js:934`), **which never assigns a name** **[verified]** —
so they are not in the catalogue and cannot be targeted. Fixed people lose their heads; the crowd does not.

Four alternatives are ruled out by construction: the head geometry is 100% procedural (`_headGeo`,
StationActors.js:650-665), all eleven meshes share one instance count and index, `frustumCulled = false`
(:566), and the distance cull writes `_mZero` to all eleven together (:777-781) — hiding whole people,
never heads. The one alternative not fully excluded — the head is the only mesh on `skinMat` — predicts
**white** heads, not absent ones, and would hit the crowd too.

**Confirm in this order, cheapest first:**

1. Enter the station **signed out**. `_onWorldChanged` returns early with no account and reads no
   document at all (`src/systems/MapOverlay.js:342-366`). If the heads come back, it is the overlay.
2. Console: `world.group.getObjectByName('StationActors:head').visible` — `false` means an applied entry.
3. `SELECT` the station's `map_overlays` row at `MAX(version)` and look for a `remove` (or a v1 `move`
   with `hidden: true`) targeting `StationActors:head`.

**The census ran step 3 directly and found no such entry**, so this is not the cause. Two things from it
survive and still matter: the *mechanism* is real and unguarded — `StationActors:head` is selectable today and
a remove of it would decapitate every fixed actor with a green row — and its anchor is the frozen one of S13,
so a **move** of it would translate 1,887 heads by a delta computed from one arbitrary frame's bounding box,
dragging every collider whose centre lies in that box, uncapped. The Phase-1 catalogue exclusion still earns
its place; it just isn't a bug fix.

**Where the missing heads actually are, then.** Not the asset path (`_headGeo` is fully procedural), not an
index mismatch (all eleven meshes share one count and index), not frustum culling (`frustumCulled = false`),
not the distance cull (`_hideActor` writes `_mZero` to all eleven together — whole people, never heads). The
remaining candidate no lane read to the end is the **per-frame pose path**: `_poseActor`
(`StationActors.js:786` onward) writes the head through `chain(_mLeaf, _mTorso, 0, HEAD_OFF_Y, 0, P.headRX,
P.headRY, 0)` then `this._mHead.setMatrixAt(i, _mLeaf)` (:808-809) — the only per-frame write that touches the
head alone. Worth checking whether every code path that writes the other ten also reaches :808, and whether
`instanceMatrix.needsUpdate` is raised for `_mHead` on every path that raises it for the others. Second
candidate: the head is the only mesh on `skinMat` (:574), so anything that leaves `M.skin` null gives three's
default material — but that predicts *white* heads and would hit the ambient crowd too.

### 0.2 Eighteen one-click district drags, with no cap on the move side

There are **18 map-wide named direct children of `world.group`** **[verified: exactly 18]** — `space`,
`hull`, `deck`, `monument`, `gateways`, `promenade`, `commercial`, `hangar`, `habitat`, `residential`,
`control`, `cargo`, `station-enterables`, `skyline`, `canopy`, `dressing`, `lights`, `actors`. Being
shallow, they are the *first rows in the admin's picker*.

And the two collider sweeps are asymmetric **[verified]**:

| | cap | `userData` exclusion | warning |
|---|---|---|---|
| `_collidersInside` (remove), `MapOverlay.js:1086-1095` | yes — `> MAX_REMOVE_COLLIDERS` → `null` → `span` | yes | `WIDE_REMOVE_COLLIDERS = 8` |
| `_moveColliders` (move), `MapOverlay.js:926-929` | **none** | **none** | **none** |

So a single drag on `deck` hauls a district's collision with a green row and no warning. This wants a
move-side mirror of both guards regardless of whether the re-plan ever happens.

---

## 1. Verdict

**The redesign can proceed without breaking the editor — but only in this order, and only with R3
narrowed.** The overlay applies strictly *after* the build, on `world:changed`
(`src/worlds/WorldManager.js:588`, `src/systems/MapOverlay.js:313`), so a build-time reservation model
is insertable in principle. Two couplings decide everything else:

1. **The editor's entire address space is the mesh name `` `${flushLabel}:${materialKey}` `` minted by
   `StationKit.flush` (`src/worlds/station/StationKit.js:1033`).** That string is simultaneously the
   editor's public API (`MapOverlay.js:828`, `:1027`), an input to the collision classifier's fallback
   (`StationWorld.js:3370`), and a pure function of which material buckets a builder happens to emit —
   `if (!list.length) continue;` (StationKit.js:1024). R4 re-authors exactly the builders that mint
   those names, so **re-authoring silently retires addresses**.
2. **R3 rewrites the physics collider set that *is* the editor's ground grid** (`MapOverlay.js:721-723`),
   and there is **no invalidation signal at all** except a deliberate `LAYOUT_SCHEMA` bump.

Freeze the names first, give colliders identity second, and the rest sequences cleanly.

---

## 2. Hard constraints

Ordered by severity. Each states the symptom if violated, because that is what makes it a constraint
rather than a preference.

**C1 — Treat the catalogue names as a public API.** No builder re-author may retire an existing
`` `${flushLabel}:${materialKey}` `` name without either an alias table the applier consults on a `name`
miss, or a DB migration rewriting the saved targets, *in the same release*. A `{name}` miss is pushed as
reason `name` and skipped; nothing versions the name space and nothing tests it. `stale-name` is a
**warning**, not an error (`site/lib/mapConflicts.ts:275`), so a whole document can be authored dead.
*Symptom:* the admin's move comes back after the redeploy; the card says "no object of that name",
which reads as "the object is gone".

**C2 — Never change the geometric content of an existing named node while keeping its name.** A move
lands the object's **anchor** — world bottom-centre of `Box3.setFromObject` (`MapOverlay.js:1233-1240`)
— and the delta is `to − anchorBefore` (:848-851). For a merged batch that box is the union of every
piece of that material key in the district, so adding or dropping the single most extreme piece shifts
the anchor and the same saved entry translates by a different vector than the admin ever dragged.
*Symptom:* silent mis-application — the row stays green and reports applied, while cladding and
colliders land in the wrong place.

**C3 — R3's "declared non-solid" must mean NO COLLIDER IS REGISTERED**, never a collider with
`solid: false`. `Physics.raycast` filters on `layer` alone (`src/physics/Physics.js:1417`) and never
consults `solid` **[verified]**; both the editor's ground grid (`_castDown`, `MapOverlay.js:720-723`)
and every placement snap (`src/systems/Loot.js:710`) go through raycast.
*Correction to the workflow's stated reason:* `solid` is **not** read in only two places. Outside
Physics.js there are at least three more readers — `src/dev/StationAudit.js:346`,
`src/systems/Unstuck.js:717`, `src/worlds/citadel/Caves.js:1011` — and Interiors *writes* it
(`src/systems/Interiors.js:57`, `:453`). The conclusion strengthens: a `solid:false` collider would also
become invisible to the player-rescue sweep and drop out of the audit's index.

**C4 — No parcel id, role tag or solidity flag in `collider.userData`.** Add a new nullable `ownerId`
field beside `layer`/`solid`/`userData` and teach `_collidersInside` **and** `_moveColliders` about it
in the same commit. `_collidersInside` skips every collider whose `userData` is non-null (:1088) — its
"another system owns this" rule — while `_moveColliders` applies no such exclusion (:927-928)
**[verified]**. *Symptom:* every station remove reports `ok: true, colliders: 0` — mesh hidden, wall
still there.

**C5 — Nothing originating from an overlay document may throw at build time.** `_runBuild` awaits
`ensureBuilt` inside a try/finally that restores physics but does not swallow
(`src/worlds/WorldManager.js:356-357`); the applier's per-entry try/catch (`MapOverlay.js:434-435`) is
what guarantees one bad entry never costs the player the world. The plan's overlap invariant may throw
only for build-authored geometry, and only inside `build()` and the headless suite.

**C6 — New applier refusal reasons must be readable by the textual pin.**
`site/lib/mapReasonsContract.test.ts` reads `MapOverlay.js` with a regex anchored on
`unresolved.push({`. *Correction:* the pin reads **two** shapes — the plain literal and a ternary — and
the applier already uses the ternary at `MapOverlay.js:411`. So the constraint is "a quoted literal in
one of the two pinned shapes", not "an inline literal". `APPLIER_REASON_TEXT` and the site's
`toHaveLength(10)` must move in the same commit.

**C7 — Do not change `WORLD_R` / `DOME_APEX` / `world.bounds` in any release that also re-authors
placement.** `planGrid` derives origin/step/nx/nz from `world.bounds` (`GroundSampler.js:84`), so a
bounds change re-projects every stored cell. And `out-of-bounds` is the *only* error-level conflict
(`mapConflicts.ts:295`) and `hasErrors` refuses the **whole document**
(`site/app/api/admin/map/[world]/route.ts:212`). *Symptom:* an admin edits an unrelated crate and gets a
400 on a row they never touched.

**C8 — R3 must not make horizontal geometry above a walkable deck solid.** The grid stores at most four
surfaces per column and the hub is already saturated: **2,084 of 3,505 hub cells (59%) at the cap**, with
a documented column reading dome 171.42 / canopy 62 / 61.5 / 59.3 / deck 0 — five surfaces in four slots
(`GroundSampler.js:24-29`, `:49`). `MAX_LAYERS` is a pinned cross-tree literal.
*Symptom:* one more solid horizontal surface evicts a real mezzanine deck out of the wire format, and
every mezzanine placement reads "floating 61.5 m above the ground" with no way for the admin to fix it.

**C9 — Keep `collideCeilingAt`, the `cy < -2` cut, `_insideSelfCollided` and the `isInstancedMesh` skip
exactly as they are**, and separate `_solidifyPlanting`'s own `wantKey` (`StationWorld.js:3309`) from the
default before touching the default. `collideCeilingAt` returns 62 over the decks, 12 in the links and
`-Infinity` elsewhere — a far stronger determinant of what is solid than the material rule.
*Symptom of dropping it:* the dome and apron gain surfaces over the whole 1,488 m extent.

**C10 — Keep named nodes under 2,000, asserted in a test.** The catalogue is hard-capped on both sides
and truncates breadth-first, so the *deepest* names go first, with no reason, no warning, no unresolved
row (`MapOverlay.js:88`, `:1262`; `site/lib/mapOverlay.ts:126`, `:447`). *Symptom:* objects vanish from
the picker and the footer just reads 2000.

**C11 — Introduce no new named Group whose world AABB spans a district**, and add the move-side mirror
of `WIDE_REMOVE_COLLIDERS`. See §0.2 — the hazard is live today with 18 such names.

**C12 — R3's non-solidity must be data on the object, never a name substring** — and the name-derived
collision key fallback must be deleted or fenced in the same change. `_collisionSoup` derives its
material key from the **object's name** when the material is not in the table
(`StationWorld.js:3370`), despite the docstring 35 lines above claiming the opposite ("Material decides,
not mesh name", :3335). *Correction:* it is latent today not because those meshes are anonymous — they
are all named `label:key` — but because every station and dock flush passes the world material table, so
`keyOf.get(m)` hits. The fallback fires only for materials *outside* `this.mat`. It is also already
wrong for zone batches: `zone:gym:panel` yields `gym`, not `panel`.

**C13 — R2 must be a build-time sweep, and must keep the authored y as a fallback.** Zone builders run
at step 0.955 but structural collision is not registered until 0.97
(`StationWorld.js:1942`, `:1951`), so a `groundHeight` call at actor-placement time sees hand-authored
boxes only — the equivalent was measured and "found 7 of the 74 sunk props and left the rest" (:3696-3701).
And the undo stack records only position, rotation.y, visible and per-collider deltas (:836-840), so a
post-overlay resample could not be undone, giving permanent drift across re-entries.
*Symptom:* R2 appears to work — the deck slabs *are* authored boxes — and leaves floating exactly the
visible ones on grates, plinths and monument steps. This repo's own named disease: a gate that measures
something the game does not do.

---

## 3. What the critics found that the plan had missed

These are additions, not refinements. Three have a blast radius wider than the editor.

**S1 — Relics and viewpoints carry position-derived save ids, and nothing migrates them.**
`idOf(pos)` quantises XZ at 0.5 m (`src/systems/Relics.js:335-338`) and *that is the identity written
into the save ledger* (`_foundIds`, :427, serialised :514-527). Sites come from a dart loop raycasting
`COLLISION_LAYER.WORLD` (:1026) with a `|normal.y| < 0.7` rejection and a 4-sample prominence test
through `groundHeight` (:1037) — all three moved by R3. `src/systems/SaveGame.js:116` states the stake in
the repo's own words: *"a finite collectible that resets is not finite."* `SaveGame.js:1497` groups
`['relics','viewpoints','trials','objectives']`, so viewpoints are very likely the same shape.
**This is the only finding whose blast radius is every existing player's progress rather than one
admin's document.** It needs its own measurement in Phase 6 and in every Phase-7 district release:
enumerate every site's `idOf` before and after, and either hold the accepted set stable or ship a
save-side reconciliation.

**S2 — Minigame venues are derived from the built world and prune silently.** `_publishVenues()` runs
last (`StationWorld.js:1962`); `settlePoints` settles on `physics.groundHeight`, then an upward headroom
raycast, then an 8-sample walk-ring quorum (`src/minigames/VenueGround.js:96`, `:116`, `:127-146`). R3
changes all three, scatter moves change the third. A failing point is dropped and a venue under
`minPoints` is **pruned**, and quest steps naming a pruned venue are "rejected as an invented target"
(`StationWorld.js:10690-10695`). Precedent: rim-c was moved from bearing 255 to 240 because "the 1.5 m
flood out of the freight kiosk stops at the dressing between them" (:10790-10794) — *scatter positions
already broke a venue point once*. `scripts/tests/station-minigames.test.mjs` must be a named gate on
Phases 4, 6 and 7, not merely a harness to copy.

**S3 — `Grounding.MAX_STACK` is the second budget R3 must fit inside.** `src/npc/Grounding.js:73` caps
the surface walk at 24, and :57-68 records why: the hub column at (107.7, 10.9) is dome-plus-nine-ceiling
-members with the deck as the *eleventh* entry, and (88.9, −71.8) is thirteen deep. A cap of 10 "is the
whole of the NPCs-on-the-station-ceiling defect". The plan budgeted R3 only against the editor's
`MAX_LAYERS = 4`. **MAX_STACK governs where people stand, and its failure mode is the owner's own
reported symptom returning through the fix meant to cure it.**

**S4 — Interiors races the overlay and writes absolute collider Y.** `Interiors` registers a
*synchronous* `world:changed` handler (`src/systems/Interiors.js:27`); MapOverlay's is *async* and awaits
`_read` (`MapOverlay.js:315-317`). Interiors always wins, then keeps writing `d.collider.solid = true`
(:57) and `setBoxColliderY(..., l.pos - l.plateThick / 2)` (:65) — an absolute authored Y — for the rest
of the visit. So an overlay move of an enterable translates the lift car and its collider, and the next
lift cycle (:453) snaps the collider back while the car sits elsewhere. An invisible platform, `ok: true`.

**S5 — `StationKit.flush` is shared with DockWorld, which is also an editable overlay world.** DockWorld
mints `yard:<key>` (`src/worlds/DockWorld.js:564`), `ship-${berth.id}:<key>` (:2202), and
`yard-office:<key>` (:2671) through the same call, and `dock` is in `OVERLAY_WORLDS`
(`site/lib/mapOverlaySchema.ts:70`). A flush re-author is a cross-world change to a second world's
address space, with its own catalogue pin and name migration.

**S6 — Renaming a mesh renames its material, retiring `--ablate` identities.** `_nameStrayMaterials`
names every still-anonymous material `mesh:${label(o)}`, where `label` walks up to the first named
ancestor (`StationWorld.js:2921-2945`); the art harness matches on `material.name`
(`src/dev/Harness.js:2157`) and reports unmatched names only as a `missing` list. So a "names only"
release silently invalidates recorded art baselines — on a repo whose memory records that defective
`--ablate` behaviour already misdirected four world branches.

**S7 — `_settleDressing` resolves seven district groups by name and silently drops misses.**
`['dressing','monument','cargo','control','skyline','commercial','hangar'].map(getObjectByName).filter(Boolean)`
(`StationWorld.js:3663-3666`). A rename disables the settle pass for a whole district with no throw and
no test failure, and the catalogue pin would show the rename as an *intended* delta.

**S8 — `LAYOUT_SCHEMA` is global: a bump blanks all 18 editable worlds**, each needing its own admin
walk (`GroundSampler.js:46`, `site/lib/mapLayout.ts:20`, `site/lib/mapOverlay.ts:530`). The targeted
alternative — leave the constant alone and
`UPDATE map_world_reports SET layout_schema = 0 WHERE world_id = 'station'` — scopes the invalidation
correctly and was not considered. Precedent for not bumping at all exists: a previous change to *which*
surfaces are kept deliberately shipped on natural re-sample (`GroundSampler.js:22-29`).

**S9 — NPCs are spawned and grounded before the overlay applies.** `_activate` spawns NPCs and only
then emits `world:changed` (`WorldManager.js:583-588`), so every character is grounded against the
pre-overlay world. Any re-seat hook must cover them too, and unlike the fixed actors they are owned by a
system outside the world.

**S10 — Portals are decoupled from their daises.** `portalSpecs` carries its own absolute `position` and
`rotationY` (`StationWorld.js:6282-6291`), independent of the `gateway-<target>` meshes flushed at :6253.
A remove of a dais leaves a working but invisible door; a move leaves the door behind. Both `ok: true`.

**S11 — The in-game minimap is a third floorplan the overlay never updates.** `src/ui/Minimap.js:265`
rasterises `world.minimapShapes` into a per-world offscreen bake; move and remove touch neither. A
removed building already stays on the player's minimap today.

**S12 — The diorama is safe.** `site/components/diorama/scenes/station.ts` is hand-authored with a fixed
seed (:77), imports no world source, and reads neither `minimapShapes` nor the layout wire format.
Nothing in R1–R4 can reach it. *Stated so the question is closed rather than silently unasked.*

### Corrections to the plan's own claims

- **The Phase-6 window was described backwards.** "Fails closed … nothing is silently wrong" is false.
  `conflictsWith` returns before every position rule when there is no layout
  (`mapConflicts.ts:390`) **[verified]**, and `out-of-bounds` is the only error. So **reads fail closed
  and writes fail open**: an admin can save a placement at x = 50,000 with a green row, and after the
  re-sample that row becomes error-level and `hasErrors` refuses the *whole* document.
- **"Click-to-place snapping is unavailable" is false.** `placementY` returns
  `layersAt(...).at(-1) ?? 0` — i.e. **0**, silently (`site/lib/mapEditorState.ts:427`) **[verified]**.
  Its own docstring promises the conflict pass will say `no-ground`, and in that window the same
  early return suppresses it. Unavailable would have been safe; 0-with-no-verdict is the silent-wrong case.
- **The window loses the floorplan and the bounds too**, not just the ground: `validateLayout` returns
  null for the whole object on a schema mismatch (`site/lib/mapLayout.ts:279`), taking `layout.shapes`
  and `layout.bounds` with it; MapCanvas silently refits to `±FALLBACK_EXTENT`
  (`site/lib/mapProjection.ts:51-55`).
- **`_occupied` does outlive the build.** `src/dev/StationAuditSelfTest.js:65` reads it directly, and
  `scripts/tests/station-audit.test.mjs:19-20` defers its end-to-end coverage to that reader. Replacing
  `_markOccupancy` without porting it silently disarms the injected-defect gate.
- **The anchor pin must record positions, not only names.** `_catalogue` emits `{name, position}`
  (`MapOverlay.js:1266-1274`), so anchor drift is fully observable — a name-only pin is unchanged whether
  the dressing anchors moved a millimetre or thirty metres, which would make the Phase-4 gate vacuous on
  exactly the risk Phase 4 names.

---

## 4. Design rules

1. **Absorb, do not add.** The plan must *replace* `_markOccupancy` / `_footprintClear` / `_occupied`
   and *subsume* `_selfCollided`, `_enterableRoomFootprints` and `_backdropKeepOut` as roles — not stand
   a fifth model beside four. Preserve their deliberate semantics verbatim: span-not-centroid, the
   0.5–6 m band, the `DECK_R + 20` radius clip. Port `StationAuditSelfTest`'s reader.
2. **Record claims as a side effect of the collider call**, never as a second list a builder must
   remember to write. `src/worlds/station/zones/Gym.js:527, 595-600` already contains a complete working
   reservation model — `Object.create(base)` overriding `solid()` — that cannot drift from the geometry
   and touches nothing the editor addresses. Carry over its two asymmetries (`mark()` conservative box,
   `free()` true rotated rect) and its "the floor is not an obstacle" exemption.
3. **Only the hub's nine hand-rolled `roadAngles` loops collapse.** "Four uncoordinated networks" is
   half right: Construction's `ROAD_W = 14` is a haul road *inside a construction site 500 m away in that
   zone's local frame*, not a second definition of the plaza avenue's `ROAD_W = 18`
   (`StationKit.js:94`). Collapsing local frames into one world grid destroys the reason zones are
   authored locally. Leave `gatewayClearances` and its pinned counterfactual as the plan's *verification*.
4. **Give the plan a name-declaration seam** — a named editable unit declared once per parcel,
   independent of which material keys its builder emits — by re-authoring at `flush`, not by re-cutting
   existing labels. Re-cutting would be a rename *plus* an anchor move at once: the worst single change.
   Note S5: that seam reaches DockWorld.
5. **Pick one and state it:** either keep named nodes at `rotation.y === 0` with world-baked geometry, or
   extend the catalogue to report authored yaw and make `rotationY` a *delta*. `rotationY` is an absolute
   assignment (`MapOverlay.js:858`, `:869`) and the catalogue reports only name and position, so the
   editor necessarily treats authored yaw as zero. Colliders translate but never rotate — a real local
   yaw gives a walk-through facade and a wall in open air.
6. **Keep the 1.5 m plan grid internal.** Station bounds are ±744 m, so a 1.5 m grid needs 993 samples an
   axis; `validateGround` refuses over `MAX_GRID_AXIS = 400` and the payload would be ~7.9 MB against
   `MAX_LAYOUT_BYTES = 4,000,000` — **and the refusal is silent** (`layout: null` → `kept-prior`).
7. **If roles reach the editor, they are a WARN code (`reserved`), never an error**, drawn as a tint and
   labelled "as built". `hasErrors` refuses the save, not the row. Tell the admin that a `remove`
   occupies nothing in the editor (`mapConflicts.ts:253`) while the plan still holds its parcel, so a
   carriageway stripe over their own removed building is expected.
8. **Add a build identity beside `builtVersion`** — a hash of the sorted catalogue name set plus
   `world.bounds` — and have the editor say "this grid was sampled from an older build". The three
   existing integers are about the *document* axis only. And `reported_at` lies: it is refreshed by the
   first report of a visit, which carries bounds and shapes but no ground
   (`site/lib/mapOverlay.ts:497`), and `_reportBack` runs before sampling starts
   (`MapOverlay.js:437-441`), so "reported just now" can sit over a weeks-old grid.
9. **Give R2 an `onOverlayApplied(world)` hook** — but note the critic's catch: it runs after collision
   is baked, so **it must carry colliders, not only meshes**, and must record on the undo stack. It must
   also cover the mobile NPCs of S9.
10. **Make `Physics.add` idempotent** before any shared collider exists. `add` does not dedupe
    (`src/physics/Physics.js:511-513`) and `remove` swap-pops by `_index` only, so a double-add becomes a
    permanent unremovable ghost. The belief that the build-time harvest dedupes with a Set is **false**:
    `World.track` pushes into a plain array and `_activate` re-adds every element after `physics.clear()`.
11. **Decide the stage-3 `{id}` scheme now, before R4**, and make it independent of position. The shipped
    schema already accepts an id shape whose text *is* the authored position at 0.1 m precision
    (`site/lib/mapOverlaySchema.ts:98`, `:119`). Do not mint `{id}` targets until R4 has settled positions.

---

## 5. Sequencing

Eight phases. **The editor is functional at the end of every one**, with degradations named. Critic
fixes are folded in and marked ⚠.

### Phase 0 — Measure and pin. No behaviour change. **DELIVERED 2026-08-28** *(see §9)*
~~Census production's station document~~ — **DONE, see §0.0: no name-targeted entries exist, so the rename
is a no-op on stored data and Phase 1 needs no DB migration.** ~~Fix `_anchor`~~ — **not needed and actively
harmful; see S13.** Pin the catalogue as
**`{name, position}` pairs** ⚠ (not names alone — see §3) plus the count under `MAX_CATALOGUE`, using the
harness that already exists at `scripts/tests/station-minigames.test.mjs:100-126`. ⚠ Diff that headless
pin against the `objects` array of a real stored admin report — the harness stubs canvas and resolves
asset loaders to empty maps, so an unproven pin is a pin on the *headless* name set. Add the first
end-to-end overlay test against three real station names; none exists (the applier's whole suite runs
against a synthetic three-object world, `scripts/tests/map-overlay.test.mjs:59-75`). Record baselines:
the structure-collided line (:3266), `_collidersInside` for the ten largest boxes, `gridWrites`, max
casts/skips per column. ⚠ Pin `world.bounds` and `planGrid`'s four integers (744 → step 6, nx = nz = 249,
62,001 cells) to make C7 real. ⚠ Do **not** add `_buildPlan` to the slicing pin here — that ships red for
three phases; move it to Phase 3.
**Gate:** the new tests pass; the census is in the commit; the e2e demonstrably *fails* when a name is
renamed in a scratch branch — prove the gate can fail before trusting it.
**Editor:** byte-identical to today.

### Phase 1 — Names only. *(3–5 days)*
De-coordinate the tower names (`Tower.js:501`, `:1050` bake a rounded world position into the string).
Make `ramp-proxy` unique per owner or excluded, fixed in StationKit so DockWorld is covered. Exclude
`StationActors:*` from `_catalogue`. Delete or fence the name-derived collision key fallback
(`StationWorld.js:3370`) and fix the docstring that denies it. Assert no two nodes share a name.
⚠ **The `map_overlays` name migration is NOT needed** (§0.0): no stored entry in any world, in any version,
targets an object by name — all 27 are `place`, which carries no target. What the census changes is the
*character* of this phase: it is no longer dangerous, it is **urgent**. Every rename is free until the first
move or remove is authored, and permanently expensive afterwards. Do it now, while the cost is zero.
⚠ **Drop the AABB-fraction refusal from this phase.** It is a new applier reason (needs C6's two-file
move, which Phase 1 does not schedule); with no stored move/remove entries the regression risk is gone, but
the reason-pin obligation is not. Move it to Phase 2 with its reason text and pin update.
⚠ Add an ablation-name pin (S6) and an assertion that `_settleDressing` resolves **seven** groups (S7).
**Gate:** the Phase-0 pin shows exactly the intended renames and no others; catalogue count drops by exactly
the eleven `StationActors` meshes plus the ramp-proxy delta; ablation names unchanged; seven settle groups
resolve. (`stale-name` cannot fire — there are no name-targeted entries to stale.)
**Editor:** functional. One bounded window — between deploy and the first admin visit the picker lists the
previous names, because `_catalogue` refreshes only on an admin visit. ⚠ In that window a *new* entry
authored against a retired name saves green and applies to nothing: `nameRules` compares against the same
stale catalogue and the save route has no name rule at all. Land the build-identity banner (rule 8) before
this phase, not after.

### Phase 2 — Collider identity. *(1–1.5 weeks)*
`Collider.ownerId` as a new field. `_collisionSoup` returns triangles grouped by source object;
`_solidifyStructure` chunks each group separately so no chunk mixes owners. Teach both sweeps to match
ownerId first and fall back to the geometric test when null. Add the move-side cap and warning (§0.2).
Make `Physics.add` idempotent. ⚠ **Decide the `MAX_REMOVE_COLLIDERS` exemption here, not inside the
phase** — per-object chunking raises per-object chunk counts, and if the ownerId path is not exempt a
remove that worked yesterday returns `span` and the building comes back. ⚠ Decide whether Interiors' door
and lift colliders carry an ownerId and whether Interiors respects it (S4), in the same commit.
**Gate:** move/remove report a stable `colliders` count that does *not* change when an unrelated builder
is edited (prove by editing one in a scratch branch); a remove of the largest named object drops > 0 and
does not report `span`; chunk count and MB within a stated band; `gridWrites` within budget.
**Editor:** functional and strictly better. Announce that `colliders: N` changes meaning.

### Phase 3 — StationPlan built, consumed by nothing. *(1–2 weeks)*
`_buildPlan` as the first step in `build()`, before `_buildTextures` — pure arithmetic over constants, no
dependency on any collider. Seed carriageway/spoke roles from `ROAD_ANGLES_DEG` and `avenueClearance`;
record parcel claims through a `ZoneContext` proxy in the shape of `Gym.scope()`. Assert overlaps in dev
and the headless suite only. ⚠ Add `_buildPlan` to the slicing pin *in this commit*.
**Gate:** claimed carriageway cells reproduce `gatewayClearances`' pinned counterfactual; the slicing pin
passes; `warmPrograms` unchanged; a headless assertion of zero overlapping claims from build-authored
geometry, or a written allowlist of the deliberate ones.
**Editor:** unchanged.

### Phase 4 — The plan replaces the partial reservation systems. *(1–2 weeks)*
`_footprintClear` and `_markOccupancy` become plan queries. `_selfCollided`,
`_enterableRoomFootprints`, `_backdropKeepOut` become roles published by the builder that raised the
thing. ⚠ Port `StationAuditSelfTest`'s `_occupied` reader.
**Gate:** the **`{name, position}`** pin unchanged except for scatter-derived batches, each named in the
commit ⚠ (a name-only pin makes this vacuous). Triangle and chunk counts in band. A headless count of
props intersecting a claimed carriageway or parcel: zero, where today it is not. ⚠ Run
`station-minigames.test.mjs` as a named gate (S2) — scatter has broken a venue point before. ⚠ Diff every
production placement's resolved snap Y: placements snap unconditionally through a 7.6 m
`groundHeight` window (`Loot.js:708-710`), and moving a crate drops or hangs the pickup on it.
**Editor:** functional; `dressing:*` anchors shift and must be listed in the release note.

### Phase 4 — status, 2026-08-29. **SKIPPED THEN, PART-STARTED NOW.**
Phase 4 was never run: the owner said "ok onto phase 5" and the sequence went straight past it. Two
pieces of it exist now, arrived at from the other end — by chasing a defect the owner reported from
inside the game rather than by working the plan.

**Delivered.** `StationPlan.roleUnder` — the read-only half of `claim`: the same rasterise-and-confirm
scan without the bookkeeping, so a placement loop can ask before it builds instead of being counted
afterwards. It takes an optional role filter, and that filter matters: refusing everything that clips a
*sightline* would delete most of what the gateways are silhouetted against, so only `carriageway` is
enforced today. `_buildSkyline` is the first builder converted, and it nudges rather than skips — see
its note on the shared `rng` stream, which is the trap any further conversion will hit.

**Gate.** `station-plan-conflicts.test.mjs` is the Phase 4 gate written as a **ratchet** rather than the
`=== 0` the plan above asks for. Zero would fail on arrival and be disabled within a day; a ceiling of
20 with a per-builder split cannot, and it names the pass to go and look at. Lower it when you fix one.

**The work list, measured.** 20 claims stand on a carriageway or its kerb (`ROAD_EDGE_HALF` = 9.9 m):
`Opening the commercial strip` 4 (avenue 0, the street the player walks down — and note the strip's
*units* sit 13.5 m off the centreline and are clean, so these four are something else inside that
step); `Stacking the cargo yard` 4; `Erecting Gateway Plaza` 3 (r = 41-42, where the roles necessarily
abut); `Stacking habitat blocks` 3; `Spanning the great dome` 2 and `Raising the pressure hull` 1
(r = 204-247, where the road runs out at the hull — these may be correct as built); `dressing` 2;
`Calibrating Traffic Control` 1.

**Delivered 2026-08-29, increment 2 — collider ownership for hand-authored solids.** `_solidRot` and
`_solid` now pass `this._planOwner` to the collider as well as to the plan. Unowned colliders 1.0%
(281 of 26,771), from most of them. This is listed here rather than under Phase 2 because it is not
about the editor at all — the editor's ownership-first path is unchanged and its gates still pass. It
is about **measurability**, and it is the prerequisite the rest of Phase 4 was silently blocked on:
with no owner there is no way to ask "is this inside something that is not me", and three separate
measurements in one session produced confident, wrong answers because of it (516 of 1,227 lamp posts
"buried", every one detecting its own collider; a 12,918-pair overlap census whose whole top ranking
was floors inside their own buildings).

**Also corrected 2026-08-29 — `_rectCovers` tested every rotated claim MIRRORED.** 7,620 disagreements
in 200,000 cases against a real three.js matrix inverse; zero after. It invented five carriageway
conflicts (habitat ×3, traffic control ×1, pressure hull ×1 — the habitat towers are 4.70 m clear, and
the previous work list implied nudging them) and hid seven (dome 2→8, dressing 2→3). Any number taken
from the plan before this date is suspect.

**Known limit of the ownership increment.** `Spanning the great dome` is one step that raises the whole
outer ring including four zones, so at the ring step-level ownership cannot yet separate "a zone prop
inside the deck the ring built for it" from a defect. Finer owners there are the next increment.

**Delivered 2026-08-29, increment 3 — zone and link ownership.** `OuterRing.js` ran entirely inside one
step ("Spanning the great dome": 12,540 colliders, ~half the station's collision). `world._planOwner` is
now scoped per call to `zone:<id>` / `link:<id>`, matching the group names those builders already create.
Dome 12,540 → 751. It re-diagnosed a whole group in the carriageway gate: eight conflicts read as 2 by
the mirrored rect, then 8 under one label, and finally as **two per link** — every link crossing a
carriageway at its mouth, symmetrically. A pattern, not a pile.

### A NEGATIVE RESULT, recorded so nobody spends another day on it

**Collider overlap cannot find these defects, and three independent attempts died the same way.**

1. *No ownership.* "Is this post buried in a building?" → 516 of 1,227. Every one was the post's own
   collider. Fixed by increment 2 — but the next two survived it.
2. *Construction is overlap.* A 12,918-pair census ranked by any measure puts **floors inside their own
   buildings** at the top. A building IS a set of overlapping boxes; only 45 of 2,482 "prop swallowed by
   structure" involved a prop at all.
3. *Colliders are coarser than what is drawn.* After increments 2 and 3 narrowed it to 398 cross-owner
   cases, the largest legible group — "46 dressing props inside the gateway daises and promenade" —
   turned out to be **crowd figures standing correctly on the steps of a stepped dais whose collision is
   one coarse 29 × 2.4 × 29 box**. Inside the collider, on the geometry.

The through-line: **a box collider is a conservative approximation of drawn geometry, so "inside a
collider" is not "inside the visible object", and no threshold on box overlap separates the two.** The
owner's own screenshots are a strictly better instrument for this defect class, because the defect is
visual — a sign unreadable through its post is not distinguishable from a sign correctly mounted on one
by box overlap. Any future overlap gate must measure DRAWN geometry (as `station-actors.test.mjs`'s seat
check already does, deliberately and at ~5 s a run), not colliders.

**Open question raised in passing:** `_solidifyProps` boxes every instanced mesh in the `dressing` group,
and `_buildCrowd` adds the ambient crowd to that same group — so 204 crowd figures carry solid colliders
a player cannot walk through. Deliberate or accidental has not been established.

### The drawn-geometry gate was built, and it fails for a reason that matters more than the gate

Built 2026-08-29, after collider overlap was shown not to work (above). It enumerates instanced props,
grids the merged batches by the `_settleScatter` recipe, casts three axis rays through each prop and
counts a foreign surface whose HIT POINT is interior on every axis - which correctly rejects the
"floor decal pierced by its own floor" case that a depth threshold alone lets through. It is fast:
2,214 rays, 10.4 s, 451 flagged.

**And it finds none of the five defects the owner found by eye.** Measured at each reported spot:

| what the owner saw | instanced props within 5 m | merged batches covering it |
|---|---|---|
| barrier in planter (23.6, -20.2) | 6 | 65 |
| barrier through block (21.2, 13.6) | 4 | 67 |
| crates through a building corner (26.5, -153.6) | 1 | 27 |
| two signs through their post (106.4, 54.5) | 1 | 38 |
| two buildings half inside each other (-22.8, 147.4) | **0** | 30 |

**THE ROOT CAUSE OF THE ROOT CAUSES.** `GeoBatch` merges geometry per MATERIAL at build time, so the
things a player sees are not things the code can address. A barrier and the planter it stands in are
either two slices of one `hazard` batch or two batches spanning a district each; in neither case is
there an object called "the barrier" to ask a question about. This is the same blindness the map
editor's catalogue already lives with (744 entries that are materials, not objects) and that
`StationAudit` records for `Box3.setFromObject`.

It is also the honest answer to the question this whole spec opened with - debug versus redesign. You
cannot debug what you cannot address. Every automated instrument tried in one day - collider
containment, collider overlap with ownership, drawn-geometry ray piercing - failed on the same wall,
and the owner's screenshots beat all three because a human eye does not need object identity.

**What follows from it.** Either (a) accept that placement defects are found by eye and keep the gates
for the classes that DO have identity (NPC grounding, actor and crowd footing, framings, plan
conflicts - all shipped and all green), or (b) give the geometry identity, which is what Phase 7's
district-by-district rebuild would do and is the only thing that would make an automated placement
gate possible. Not a decision to take from inside Phase 4.

**ANSWERED 2026-08-30: both, in that order — and (b) cost days, not weeks, because identity
is metadata and `GeoBatch.add` has one call site. See §14, which also records what it found on the
first run: a guard in `_buildSkyline` that has been computed and discarded since it was written.**

**Not delivered.** Everything else the phase asks for: `_footprintClear` and `_markOccupancy` becoming
plan queries, `_selfCollided` / `_enterableRoomFootprints` / `_backdropKeepOut` becoming published
roles, the `StationAuditSelfTest` `_occupied` port, and the placement-Y diff against production. A
`_footprintClear` conversion was attempted and reverted the same session: it did not remove the
conflict it was aimed at, and a guard that changes geometry without fixing anything is worse than none.

### Phase 5 — R2, actor surfaces, as a build-time sweep. *(1 week)*
Keep the authored y as an intent hint; add a lift-and-settle sweep in the `_settleDressing` slot with the
authored y as the null fallback. Preserve the lift-only rule and the ring exclusion.
⚠ **Budget the frame cost.** `_settleScatter` is already the longest single frame in the build (3,175 ms)
and its grid acceleration is built over the props pass, not the world's ~328,654 triangles; the gate as
originally written measured correctness only, on a world with a desktop-freeze history.
⚠ Same placement-Y diff as Phase 4.
**Gate:** count of actors whose sampled floor differs from the authored y by > 5 cm, before and after;
zero actors more than 0.15 m off the drawn surface; a stated build-time budget; prove the gate can fail
by displacing one actor.
**Editor:** functional. The eleven `StationActors:*` anchors move, but Phase 1 removed them from the
catalogue.

### Phase 6 — R3, narrowed to an opt-in, with the grid migration. *(1–2 weeks)*
**Not a blanket inversion.** Keep every existing filter (C9). Add an explicit builder-side `solid: true`
opt-in for structural pieces on emissive or glazed materials, expressed as data (C3, C12).
⚠ **Prefer `UPDATE map_world_reports SET layout_schema = 0 WHERE world_id = 'station'` over a global
`LAYOUT_SCHEMA` bump** (S8) — the bump blanks 17 other worlds, each needing its own admin walk. If the
bump is used anyway, deploy the site no later than the game; game-first freezes the old grid via
`kept-prior`.
⚠ **Fix the window's write path before shipping it.** As built, reads fail closed and writes fail open:
`placementY` silently returns 0 and `conflictsWith` suppresses `no-ground`. Either gate the save route on
a present layout, or make the editor refuse to author positions without one.
⚠ Measure `Grounding.MAX_STACK` headroom, not only the editor's four slots (S3). ⚠ Enumerate relic and
viewpoint `idOf` sets before and after (S1). ⚠ Re-run the venue gate (S2). ⚠ Add the sampler's
budget-exhaustion warnings — `MAX_CASTS`/`MAX_SKIPS` are silent `break`s today and the last slot is what
`placementY` reads.
**Gate:** the re-sample POST answered `stored`, not `kept-prior`, verified by reading `nx/nz/step` back
from the API — never by the age line. Hub layer-saturation histogram must not rise from the 2,084/3,505
baseline, or `MAX_LAYERS` rises with it in a two-sided commit. Casts and skips ≥ 2× below their caps.
`_collidersInside` for the ten largest names still under 200. Every production placement's snap Y diffed.
A fresh `warmPrograms` baseline **and a lower bound** — there is none today.
**Editor:** degraded for one bounded window (target < 1 hour: one admin walk of 62,001 cells at 2 ms per
rendered frame). ⚠ There is no manual re-sample button and no server-side job — `?dev=1&layout=sample`
deliberately never posts — so this needs a named owner, and leaving mid-walk cancels silently while still
refreshing the banner.

### Phase 7 — R4, one district per release. Hub first. *(2–4 weeks per district)*
Re-author placement against the plan behind **frozen flush labels**: a builder whose bucket set changes
emits an empty-but-present bucket for every key it previously produced, or ships a rename map plus the
alias table. Re-author `world.minimapShapes` in the same commit as its roads ⚠ and the in-game minimap
bake (S11). ⚠ Keep daises and `portalSpecs` together (S10).
**Gate (per release):** `{name, position}` pin updated with only the intended deltas; zero `stale-name`
and zero `out-of-bounds` over the stored document; a move of the largest name reports a `colliders` count
within one chunk of the previous release; named nodes under 2,000; venue gate green; relic id set stable
or reconciled; `warmPrograms` within margin of a fresh baseline **and above the lower bound** — the
realistic hazard is a *drop*, where a builder quietly stops warming twenty programs and pays the link
cost on the arrival frame.
**Editor:** functional after each release, with the same bounded post-deploy window as Phase 1 — which is
why the build-identity banner must exist before this phase starts.

---

## 6. Decisions the owner has to make

**D1 — What is the named editable unit after R4?**
(a) keep every flush label and bucket set byte-identical, R4 changes geometry within buckets only;
(b) keep existing labels **and** add per-parcel names at a third colon segment that cannot collide with a
material key (`zone:gym:prop:bench` vs `zone:gym:mat:trim`); (c) re-cut the label space entirely with an
alias table and a full name migration.
**Recommend (b).** (a) constrains R4 so tightly it cannot fix "buildings halfway on roads" object by
object, and it does not remove the anchor hazard — changing what is *in* a bucket still moves the anchor.
(c) is a rename plus an anchor move plus a catalogue-cap risk in one change. Budget the added names
against the ~1,244 of headroom and assert it in the Phase-0 pin. ⚠ Note the critic's cost catch:
`_catalogue` pays one `Box3.setFromObject` per named node and "a named node under a named node is walked
twice" (`MapOverlay.js:1251-1253`), on the admin's frame at world entry — so (b) needs a time budget too.

**D2 — What does R3 actually mean?**
(a) narrowed: invert nothing, add an explicit `solid: true` opt-in, keep every filter; (b) invert the
material predicate only; (c) full inversion including the height filter.
**Recommend (a).** The complaint — "walls that can be walked through" — is about *structure* that happens
to be emissive or glazed, not about hoses, floor films, decals and sign faces, which are excluded for
stated measured reasons. `collideCeilingAt` is a far stronger determinant than the material rule.

**D3 — Are plan roles published to the editor?**
(a) never; (b) as an optional base64 raster under `layout` at the ground grid's 6 m step, drawn as a tint
with a `reserved` WARN code; (c) promoted to an error that refuses a save.
**Recommend (b), deferred until after Phase 6.** It is the change that would catch this defect class at
edit time, and it rides the existing shallow JSONB merge. Never (c). Decide also whether the raster is the
*plan* or a post-build re-derivation — if builders can correct a role, the two disagree.

**D4 — Does a move carry the object's dressing and actors?**
(a) accept under-moving; (b) an `onOverlayApplied(world)` hook; (c) re-parent under the district group.
**Recommend (b), with the critic's fix:** the hook must carry **colliders as well as meshes** and record
on the undo stack, and must cover the mobile NPCs of S9. (a) means the owner's original complaint returns
the first time anyone uses the editor. (c) breaks the world-baked-geometry premise the anchor rule rests on.

**D5 — Who owns the post-deploy re-sample walk, and is it enforced or trusted?**
**Recommend enforced** — the build identity of rule 8, with the editor refusing to snap or issue ground
verdicts against a stale grid. Trusting a checklist item is what makes risk 2 unbounded.

---

## 7. What this does not cover

- The station's **art** and architecture, which the Phase 9 pass found strong and which is not the subject.
- A **rebuild**, considered and rejected: see [[station-overhaul-aug-2026]], whose traps a rebuild would
  re-derive.
- The **headless people**, now that the overlay is ruled out (§0.0). The next place to look is the
  per-frame pose path — see the end of §0.1 for the two specific candidates and what to check in each.
- ~~Whether production holds move/remove entries against station names.~~ **Answered: it does not.** See §0.0.

## 9. Phase 0 — as delivered, 2026-08-28

**`src/` is untouched.** Everything below is additive test infrastructure plus one fixture.

### What exists now
- **`scripts/tests/station-world-kit.mjs`** — a real `StationWorld` built headless (~6 s), extracted from
  `station-minigames.test.mjs` and named as a kit so `npm test`'s `*.test.mjs` glob does not run it as a
  suite. Captures the build log, because the baselines are printed there and a baseline read out of the
  world's own reporting cannot drift from what the world did. `buildStation()` memoises for read-only
  callers; `buildStationFresh()` is mandatory for anything that mutates, which every overlay case does.
- **`scripts/tests/station-catalogue.test.mjs`** — 8 cases pinning the editor's address space.
- **`scripts/tests/station-overlay-e2e.test.mjs`** — 5 cases driving the real applier against the real
  station. This did not exist in any form: the applier's whole suite runs against a synthetic three-object
  world named 'station', and would have passed a redesign that renamed everything in the real one.
- **`scripts/tests/fixtures/station-catalogue.json`** — 756 `{name, position}` pairs.

### The headless-vs-production question, answered
The critic's objection was that a pin taken headless might guard a different name set. Diffed against the
stored production report (`.probe/catalogue-diff.mjs`): **756 names in both, none only in one, and not one
anchor differing by more than a millimetre.** The pin is the real address space.

### The gate proves it can fail
Injected two defects at once — renamed the `dressing` group and shifted `monument` by 5 m — and the pin
reported `RETIRED dressing`, `MINTED dressing2`, and the anchor moves. It also caught a **second-order**
effect: `dressing:polish` moved **50 m** and `dressing:hazard` **30 m**, because `_settleDressing` resolves
its seven groups by name and silently dropped the renamed one. **That is S7, reproduced live.** Reverted.

### Baselines (`.probe/phase0-baselines.json`)
| | |
|---|---|
| headless build | 6,107 ms |
| catalogue | 756 names; 37 colon-free; 14 coordinate-baked; 1 `ramp-proxy` row |
| colliders | 26,352; `gridWrites` 234,332 |
| structure collision | 328,702 triangles found, 144,631 already boxed, 184,071 kept in 8,192 chunks (6.3 MB), 1,360 planting proxies |
| bounds / grid | (−744, −6, −744)–(744, 164, 744); origin (−744, −744), step 6, 249 × 249 = **62,001 cells** |
| `monument:trim` | move drags **83** colliders, remove drops **70** |

### The move-side exposure, measured — this is the headline
`_collidersInside` (remove) excludes heightfields and `userData`, requires full containment, and **refuses
past 200** with reason `span`. `_moveColliders` (move) excludes heightfields and **nothing else**, claims on
centre-in-box, and has **no cap, no exclusion and no warning**. Across the 756 catalogue rows:

| colliders a move would drag | names |
|---|---|
| more than 10,000 | **17** |
| more than 200 (where remove refuses) | **247** |
| 1–200 | 424 |
| none | 84 |

`space` drags **all 26,352 colliders in the world**. `dome` 26,234. `dome:trim` 25,845. `actors` 24,682.
These sit near the top of the picker because `_catalogue` is breadth-first. **An object an admin cannot
remove — the applier refuses it as a district — they can still drag, and it takes the world's collision with
it, reporting `ok: true` on a green row.** Pinned as an upper bound so it cannot grow before Phase 2; when
the move-side cap lands, the expectation becomes zero.

### Blocker found, not introduced: main is red
`04bdc55` ("Fix: Snap collectible placed items to ground for pickup collection"), the current `HEAD`, leaves
**two tests failing** in `map-overlay.test.mjs`. It changed `snap: false` to `snap: hasContents` where
`const contents = power ? [{…}] : [{…}]` — a ternary between two single-element array literals, so
`hasContents` is **always true**. Every placement now snaps unconditionally, and the "visual-only items (no
contents) preserve authored height" branch its own comment describes **cannot execute**. A rooftop crate
falls to the deck. This is migration #6's dead branch, shipped. Options in §10.

### Not done, deliberately
`_buildPlan` is **not** added to the build-slicing pin — the critic was right that it would ship a red suite
for three phases. It belongs in Phase 3's commit.

## 10. D6 — `snap` is a field the document carries. **DELIVERED 2026-08-28**

Owner chose (c). `04bdc55`'s complaint was real — placed items were unreachable — but its fix removed the
ability to hold an authored height, and did so through a condition that could never be false.

**Game** (`src/systems/MapOverlay.js`, `_applyPlace`): `snap: entry.snap !== false`. The dead `hasContents`
is gone and the comment now describes what the code does, including what the probe can still do when
snapping *is* wanted — the window is 7.6 m tall, so a surface up to 1.6 m **above** the authored point wins,
and a placement over a void finds nothing and stays put.

**Site** (`lib/mapOverlaySchema.ts`): `snap?: boolean` on `PlaceEntry`, stored **only** when it is the
literal `false`. Anything else — absent, `true`, `null`, `0`, the string `"false"` — leaves the key off and
the game snaps, so a malformed value can never quietly strand a pickup in the air. `normalise` stays
idempotent because `false` round-trips to `false` and everything else round-trips to absent.

**Editor** (`components/MapEditorPanel.tsx`): a "Drop to the ground" checkbox on every place row, mount
upgrades included. Checked is the default and **stores nothing**; unchecking is the only thing that writes.
The help text under "Place a marketplace item" already told admins to "pick another layer for a rooftop" —
which the game then silently undid. It now says to untick the box, and that is true.

**No data migration.** The nine production placements carry no `snap`, so they keep snapping — the
behaviour `04bdc55` gave them and the one the owner wanted.

**Tests.** Two updated (they asserted the old `snap: false` default), five added: an explicit `false`
honoured, an explicit `true`, a malformed-value sweep on the game side; a normaliser narrowness test, a
default/rubbish sweep and an idempotence round-trip on the site side; and a **cross-tree round-trip** case
driving the real applier from a site-normalised document, asserting the authored `y = 12.5` survives. The
`snap: false` case was mutant-proven — hardcoding `snap: true` in the applier fails it and nothing else.

**Gates:** game **3607/3607**, site **930/930**, contract **133/133**, `tsc` clean.

## 11. Phase 1 — as delivered, 2026-08-28

Behaviour-free apart from the name set, and that was measured rather than asserted.

### Names are identities now, not measurements
Tower interiors named themselves `tower-interior-${round(x)}-${round(z)}`, and their merged batches
`tower-int-${round(x)}-${round(z)}:key` — **180 of 756 catalogue names, 24% of the whole address space**,
keyed to where the building happened to stand. (The Phase-0 count of 14 saw only the Groups; the 166 batch
names were the larger half.) Reconciling the two `ROAD_W` values would have renamed nearly all of them.

They are slugged from `spec.label`, which every one of the 14 callers already authored — `Habitat Stack N1`
→ `habitat-stack-n1`. `slugLabel` lives in `StationKit.js`; `buildTower` **throws** on a label that slugs to
nothing, because a tower with the empty id would collide with the next one. The 14 labels produce 14
distinct ids.

### A general opt-out, not a station denylist
`NOT_EDITABLE` (exported from `MapOverlay.js`): `_catalogue` skips a node carrying it but still walks its
subtree. Applied to two kinds that were never objects an admin could mean to move:

- **Ramp proxies** — invisible tilted collision boxes sharing ONE name across the world, so the picker
  showed a single row resolving to whichever the traversal reached first, and moving it separated the thing
  you walk on from the ramp you can see. Fixed via a new `markRampProxy` helper in StationKit, called from
  StationWorld, DockWorld and ShipKit — one rule for all three, rather than three copies of two lines.
- **`StationActors:*`** — the world's whole fixed population in eleven instanced buffers, sitting near the
  **top** of the picker because the walk is breadth-first.

Withheld from the picker is not deleted from the world: the applier resolves by `getObjectByName` and never
consults the catalogue, so an already-saved document still applies. Production holds none.

### The docstring that had been false since it was written
`_collisionSoup` read `keyOf.get(m) ?? (o.name || '').split(':')[1] ?? ''` — the **mesh name** decided the
collision key for any material outside `this.mat` — under a docstring saying "Material decides, not mesh
name". With the editor addressing objects by mesh name, that made the address space and the collision model
one string: the first re-authored builder to name such a mesh with a second segment in `NON_SOLID_KEYS`,
`PROXY_KEYS` or starting `em` would have made it walk-through, silently. It was already wrong on its own
terms — `zone:gym:panel` yields `gym`, not `panel`. Now `keyOf.get(m) ?? ''`.

**Measured, not assumed:** structure collision is byte-identical across the change — 328,702 triangles
found, 144,631 already boxed, 184,071 kept in 8,192 chunks (6.3 MB), 1,360 planting proxies, 26,352
colliders, both sides. The fallback really was unreached.

### Results
| | before | after |
|---|---|---|
| catalogue names | 756 | **744** (−11 actor meshes, −1 ramp-proxy) |
| coordinate-baked names | 180 | **0** |
| names dragging > 200 colliders on a move | 247 | **236** |
| names dragging > 10,000 | 17 | **6** |

The move-side improvement is a side effect of the actor meshes leaving the picker; the sweep still has no
cap of its own, which is Phase 2.

### The two critic-mandated pins, both live
- **S6** — the four `mesh:*` ablation identities are asserted exactly. Renaming a mesh renames its material
  via `_nameStrayMaterials`, and `--ablate` matches on `material.name`, so a "names only" release could
  silently invalidate recorded art baselines.
- **S7** — `_settleDressing`'s group list is **parsed out of the game source** and every name asserted to
  resolve. Phase 0 reproduced this failure live: renaming `dressing` moved `dressing:polish` 50 m.

### Gates
Game **3610/3610**, contract **133/133**, `npm run build` clean (StationKit still code-splits; the new
StationKit → MapOverlay import edge introduces no cycle, since MapOverlay imports nothing from `worlds/`).

### Adversarial review, and what it changed
Four lenses plus a synthesist. Verdict **ready-with-fixes, no blockers**. Two lanes independently rebuilt
the station at HEAD in throwaway worktrees and diffed the catalogue: **192 retired, 180 minted, 0 anchors
moved at any epsilon**, every retired coordinate name pairing 1:1 to a minted one at the identical anchor
and material-key suffix. The no-op claim for the collision fallback was established three independent ways,
one lane instrumenting `_collisionSoup` at both call sites and finding all 80 meshes with a non-table
material are unnamed and under `space`, so `oldKey === newKey === ''` for every mesh that could reach it.

Fixes applied from the review:

- **`NOT_EDITABLE` moved to a leaf module** (`src/systems/mapEditable.js`), re-exported from `MapOverlay`.
  The review found the repo had already extracted `overlayVersion.js` for exactly this reason — "importing
  it from `MapOverlay.js` dragged that file's whole graph into every test that only wanted the manager" —
  and that the import edge falsified `MapOverlay.js:17` ("Nothing in `src/worlds/` knows this file exists").
  **Measured: the lazily-loaded StationKit chunk drops from 70.95 kB to 10.13 kB.** The claim at :17 is true
  again.
- **Tower ids are now enforced unique, not merely non-empty.** `slugLabel` collapses punctuation, so
  `Block D // Handed Over` and `Block-D Handed Over` are one id — and a collision announces itself nowhere:
  `_catalogue` de-duplicates, so the second tower mints nothing and retires nothing, and a count assertion
  only fails if the total happens to change. With 15 labels and one collision the pin would have passed. The
  Set is reset per build so a volatile rebuild does not collide with itself (verified by rebuilding in place).
- **The audit carried the same deleted fallback** at `StationAudit.js:169`, so the instrument and the world
  would have classified by different rules the moment the re-plan created a stray-material mesh with a colon
  name. Removed in both places together.
- **Two docstring clauses were wrong** and are corrected: the dock never runs `_collisionSoup` at all (it is
  defined on StationWorld, not World), and `''` is accepted by the default predicate but **rejected** by
  `_solidifyPlanting`'s own `(k) => PROXY_KEYS.has(k)`.
- **The collision output is now a gate, not a console line a human read.** `structure collided from
  geometry` is parsed and all five figures asserted, plus the collider total — because "byte-identical" was
  exactly the kind of evidence this repo has learned not to trust.
- **Three tests were vacuous or too narrow.** The uniqueness test asserted over `_catalogue`'s output, which
  is unique by construction; it now counts over `world.group.traverse` with `ramp-proxy` allow-listed. The
  coordinate regex only matched a pair at the end of a name; it now matches one anywhere, `-` or `_`
  separated. (The reviewer also correctly refuted a proposed "no digits at all" version — 78 of the 744
  names legitimately carry a digit.) A withheld name now **reserves** its name in `seen`, so a withheld and
  an offered node cannot share one.
- **`station-ramp-proxies.test.mjs` built its fixture by hand**, setting two of the three properties under a
  comment claiming "exactly what `_ramp` builds". It uses `markRampProxy` now.

### The yard had no pin, and the pin found a defect
`dock` is a live editable overlay world that mints its names through StationKit's flush and stamps its ramp
proxies with the same helper — so a change made *for* the station moves the yard's address space, from a
file whose name says "station". It had no catalogue pin. `scripts/tests/dock-catalogue.test.mjs` closes
that, and the kit generalised to `world-kit.mjs` (both worlds, one DOM shim).

It failed on its first run: **four `hatchleaf:*` names each resolved to two nodes.** A hatch has two leaves
and both carried `hatchleaf:${id}`, so the catalogue offered one row, kept the shallowest, and the applier's
depth-first lookup picked whichever it reached first — moving that row moved one leaf and left the other,
reporting `ok: true`. Now `hatchleaf:${id}:a` / `:b`. Yard catalogue 142 → 146.

### Deferred, deliberately
The AABB-fraction refusal on district-scale targets stays out — it needs a new applier reason and its
two-file pin update (C6), and it belongs with Phase 2's move-side cap. The build-identity banner was
specced as a Phase-1 prerequisite; the census removed its urgency here (no name-targeted entries exist to
be orphaned in the post-deploy window) and it is now a **prerequisite for Phase 7**, where district-by-
district re-authoring makes the window real.

## 12. Phase 2 — collider identity, as delivered 2026-08-29

The headline number Phase 0 measured — **236 of 744 named objects could drag more colliders on a move than
a remove is allowed even to consider, and `space` all 26,352 in the world** — is now **zero**.

### `Collider.ownerId`
A new nullable field beside `layer`/`solid`/`userData`. Its value is the **name of the nearest named
ancestor** — the same string the editor addresses the object by, which is why Phase 1 had to come first.
Null means "nobody claimed this; fall back to geometry", not "belongs to nobody".

Who carries one today: the geometry-derived structure soup (chunked per owner) and every instanced prop
(owner = the mesh that drew it). **10,264 of 26,198 colliders across 225 objects.** The remaining ~16k are
hand-authored `solid()` calls with no single named owner, and null is the honest answer there.

### Per-owner chunking cost, measured before it was written
401 owners contribute to the soup. The worry was that per-owner chunking would raise chunk count and smear
AABBs across the broadphase. Measured: **chunks went DOWN, 8,192 → 8,038** — a spatially coherent owner
packs better than an arbitrary median slice, and that more than pays for the ~401 partial chunks. Kept
triangles are **identical to the triangle** (184,071). Colliders track chunks exactly (26,352 → 26,198).
`gridWrites` rose 234,332 → 266,811 (+14%), a build-time index cost; worth watching if frame time ever
regresses, but it buys the identity.

### The cap decision, stated
**Ownership is exempt from `MAX_REMOVE_COLLIDERS`; the geometric guess is not.** The cap exists because
containment is a guess — "200 inside this box" means the box is too big to reason about, not that the
object is large. When the world has said whose the colliders are, the count *is* the answer, and refusing
it would hide a mesh and leave every wall it stands for, which is exactly what `span` exists to prevent.
The editor still warns above `WIDE_REMOVE_COLLIDERS`, which is the right place for "are you sure": a number
the admin can see, not a refusal they cannot override.

### The move side finally has a cap
`MAX_MOVE_COLLIDERS = 200`, mirroring the remove side with the same number and the same reasoning, and
applying **only to the guess**. A refused move reports `span` — the reason the remove side already uses, so
**no new applier reason and no cross-tree pin change** (C6 satisfied by construction) — and **moves
nothing**: a mesh translated away from the collision it stands for is the invisible wall the applier exists
to prevent, and a half-applied move is worse than a refused one.

Outcome across the 744 names: **225 own their colliders, 132 refused as too wide, 386 under the cap, 0
uncapped.**

### `Physics.add` is idempotent
`remove` swap-pops by the `_index` entry, so a collider added twice had ONE index — the duplicate survived
removal with no index at all: permanently solid, unremovable, and reported **absent** by `has()`. The
editor's undo rests on `remove(c) === true` meaning "it was registered here", so a ghost is the one shape of
bug it cannot recover from. Nothing deduped upstream (`World.track` pushes into a plain array and
`_activate` re-adds unconditionally), so one double-`track()` would have re-created it on every world entry.

### The editor learns to warn about moves
`moveWarnings` mirrors `removeWarnings`, which had no counterpart: a move that carried **no** collision is
the same invisible-wall failure a remove-that-dropped-nothing is, and it was silent on a green row. The wide
case is worded as an observation rather than an accusation, because with ownership a large count is the
answer — a hab stack owns hundreds.

### Gates
Game **3618/3618**, site **934/934**, contract **133/133**, `tsc` clean. Both new paths mutant-proven:
disabling ownership fails exactly the two ownership tests, removing the move cap fails exactly the refusal
test. The build-slicing pin caught the widened `_dropEnclosedTriangles` signature and was updated with the
reason.

### Deferred to a later phase
Interiors' door and lift colliders do not carry an `ownerId` (S4). Giving them one is not the hard part —
the hard part is that `Interiors` re-asserts absolute collider Y on every lift cycle and wins the
`world:changed` race against the async applier, so a moved lift car's collider snaps back regardless of
ownership. That is a systems-ordering fix, not an identity one.

## 13. Phase 3 — the plan, in shadow. Delivered 2026-08-29

`StationPlan` is built as the **first** step of `build()` — pure arithmetic over the layout constants, no
collider, no geometry, no scene graph, which is the only reason it *can* be first and therefore true for
every builder after it. 18,240 cells seeded from the same `ROAD_EDGE_HALF` that `avenueClearance` uses, in
18 ms.

**Nothing reads it back.** Every solid is recorded against it as a side effect of the collider call — never
a second list a builder must remember to write — and no placement changes. A reservation model that begins
by moving four thousand props is one whose first bug is indistinguishable from its first correct decision.

### The number that decides Phase 4
**186 conflicts: 20 carriageway, 80 plaza, 86 sightline**, attributed to the build phase that made each.
They are not all defects, and the distinction is the deliverable:

| kind | example |
|---|---|
| deliberate | a gateway dais stands on its own approach — it *is* the destination (26 + 18) |
| a question being asked for the first time | the sightline rule lives only inside the dressing scatter, where it was written to keep **crates** out of a portal approach; asking architecture to honour it is new (habitat stacks clipping gateway 150 at bearing ~135, 25) |
| genuinely marginal | a habitat tower corner at r 154 reaching the edge of avenue 120 — 26 m off centreline against a 9.9 m road half-width plus a 16 m half-diagonal (3) |

### Two things had to be measured before the number meant anything
- **The ground band** (0.45–6 m, the same one `_markOccupancy` documents). Without it the great dome —
  a shallow cap a hundred metres up — reported 33 conflicts, and the promenade loop, which crosses every
  avenue 10 m overhead *by design*, another 21. Fifty-four of the original count was noise burying signal.
- **Attribution.** Setting `_planOwner` from the build step's own label is free and is the difference
  between "186 conflicts" and a work list.

### Gates
Game **3622/3622**, contract **133/133**, build clean. Build time **5,885 / 6,185 ms** against a 6,107 ms
baseline — inside the noise. The slicing pin covers `_buildPlan` (moved here from Phase 0, where the critic
correctly said it would ship a red suite for three phases). The test pins that the plan **is** first and
that `StationPlan` reaches for nothing it could not know yet — if it ever touches physics or the scene
graph, "build it first" stops being possible and the guarantee is silently void.

### One process note worth keeping
The first draft of this test pinned **89** conflicts, read off a `tail -18` of the per-builder breakdown —
the rows above the fold were never in the total. The real number was 186 the whole time. A number read off
a truncated console is not a measurement, and the reminder is left in the test.

## 8. Decisions taken

Owner, 2026-08-28: **D1 (b)** per-parcel names at a third segment; **D2 (a)** narrowed opt-in, invert nothing;
**D3 (b)** roles published as a raster with a `reserved` warning, deferred until after Phase 6;
**D4 (b)** an `onOverlayApplied` hook that carries colliders as well as meshes and records on the undo stack;
**D5 (b)** enforced build identity, with the editor refusing to snap against a stale grid.

Owner, 2026-08-30, on the (a)/(b) question §5 closed with: **both, in that order.** Accept that placement
defects are found by eye and keep the gates for the classes that have identity — *and* give the geometry
identity, then Phase 7. See §14.

---

## 14. Phase 4(b) — the drawn geometry knows what it is. Delivered 2026-08-30

### The assumption that turned out to be wrong

§5 records (b) as "what Phase 7's district-by-district rebuild would do", i.e. weeks. It is not. Identity
does not require re-authoring anything, because **`GeoBatch.add` has exactly one call site in the
repository** — `at`, which `localAt` also funnels through. One choke point covers all ~1,170 authored
placement calls, and ~642 more behind the `ZoneContext.put`/`box`/`floorQuad` wrappers, **with no
call-site edits at all.**

### Identity is metadata, not scene nodes

The load-bearing choice. Naming pieces as real objects would multiply draw calls — the one thing
`GeoBatch` exists to prevent — and would blow both `MAX_CATALOGUE` and the
`Box3.setFromObject`-per-named-node cost D1(b) already flagged. So `flush` writes `userData.parts`:
start/count into the merged index buffer per authored piece, plus the build step, zone or link that
raised it, read from the same ambient `_planOwner` the colliders already use. Nothing changes a vertex, a
draw call, a material or a name.

| | |
|---|---|
| addressable pieces | 617 opaque meshes → **37,923** named pieces (92,727 with the instanced scatter) |
| table memory | 0.43 MB of typed arrays |
| build time | 9,392 ms with, 9,557 ms without — inside a ±350 ms noise band, so **unmeasurable** |
| span invariant | holds on all 617 merged meshes |
| unowned pieces | 0 of 37,923 |
| read-back | 92,727 pieces boxed in 96 ms (`src/dev/GeoParts.js`) |
| suite | 3,635 → 3,641, 0 fail |

`GeoParts` unions the merged and instanced populations behind one address shape. The instanced half always
had identity — mesh plus index — which is why the abandoned drawn-geometry probe could enumerate 2,214
props and still see nothing: it was the merged half it could not name.

### What it found on the first run

The five sites §5 tabulates, asked of the code rather than the eye:

| what the owner saw | before: addressable | now |
|---|---|---|
| crates through a building corner (26.5, −153.6) | 1 prop / 27 batches | **`skyline:panelWarm#5` ∩ scatter instance, 464 m³** |
| barrier in planter (23.6, −20.2) | 6 / 65 | 142 cross-owner pairs, named piece by piece |
| barrier through block (21.2, 13.6) | 4 / 67 | 127 pairs, named |
| two signs through their post (106.4, 54.5) | 1 / 38 | 0 — same owner, needs `_piece` on `_signBoard` |
| two buildings half inside each other (−22.8, 147.4) | **0** / 30 | 0 by overlap; **root-caused by reading the code identity led to** |

### `clash` is computed and never read

`_buildSkyline` computes a `clash` flag under twenty-six lines of comment explaining the defect it removes
— "backdrop may not stand in a building you can walk into" — and **nothing ever reads it.** The drop it
describes has never happened. Measured with per-block labels: **eight blocks stand inside self-collided
interiors**, worst `block:3` at (−40.9, 152.9), **19.9 m inside** a footprint at (−53.5, 144.6). That pair
is what (−22.8, 147.4) looks straight at. Defect 5 is not an overlap between two skyline blocks — those
are clean — it is a skyline block swallowing a building that has its own interior.

### The fix that was tried, measured worse, and reverted

Folding the clash test into the existing bearing sweep is the obvious one-line-ish fix, and the sweep is
already the right shape (it nudges rather than drops, because a `continue` re-rolls the shared `rng` and
was measured to move the skyline from 49,056 to 72,530 collision triangles). It gives **interiors 8 → 4
and creates three block-on-block overlaps that did not exist, `block:2` ending 20.8 m inside `block:14`
(17,598 m³)** — the same defect class, moved. Adding rectangle-accurate block-vs-block avoidance to the
sweep changed nothing, because the r=158 blocks sweep into the space the r=146 block needs before it is
placed, and the sweep silently falls back to the original bearing when nothing clears.

It is a constraint-satisfaction problem over the whole ring, not a guard. **That is Phase 7 work with a
visible art consequence, so the debt is pinned rather than pretended away:**
`scripts/tests/station-skyline-clash.test.mjs` ratchets interiors at 8 (lower it when you fix one) and
asserts block-on-block at **zero** — the assertion the rejected fix fails, so any future attempt has to
pass both.

### Gates, each proven able to fail before being trusted

`geo-batch-parts.test.mjs` (6 cases) — mutation-tested with spans packed in reverse (caught), no table
written (caught), owner frozen at first `add` (caught), and one `new GeoBatch()` without the world, which
is the regression the file exists for: caught, naming the five `dressing` batches it orphaned.
`station-skyline-clash.test.mjs` (2 cases) — ceiling lowered to 7 (caught); the rejected sweep fix
(caught, naming `block:2 x block:14: 17598 m3`).

### Deferred, deliberately

- **`instanced()` carries no owner.** It is a free function with no world to read `_planOwner` from. Costs
  nothing yet — "same thing by construction" for a scatter is same mesh and same index — and is worth
  doing only when a gate asks.
- **`_piece` is set by one builder.** Only `_buildSkyline` labels per block. Every intra-step defect stays
  invisible until its builder does the same: `_signBoard` (which is why the signs-through-post site reads
  zero), the habitat towers, commercial units, cargo stacks. This is D1(b)'s third colon segment arriving
  from the measurement side, and it is the cheapest remaining win.
- **A global placement gate.** `overlappingPairs` runs, but "a building IS a set of overlapping boxes"
  still holds: without finer `_piece` labels the cross-owner filter is the only thing separating
  construction from defect. Per-builder labels first, then the gate.

### Site 4, closed: the pylon signs were threaded through their post

Labelling `_signBoard` per sign — one line in one function, covering all fourteen call sites — turned
(106.4, 54.5) from **0 findings into the defect, addressed to the piece**: `dressing:signs#4` and `#5`
each 2.60 m inside `dressing:panelDark#3`. Photographed, the pylon comes up through the middle of the
artwork and cuts "DOCK 4 // ARRIVALS" in half lengthways.

**Root cause.** `_signBoard` offsets each face by `thickness * 0.55` and defaults `thickness` to 0.18 —
*the sign's own backer*, with no knowledge of what it is mounted on. The avenue-mouth pylons are
`boxGeo(2.0, 12.5, 2.0)`, so the faces landed 0.9 m inside a 1.0 m half-width post. **All three pylons**
([70, 52], [118, 47], [62, −54]) carried it, two signs each, two faces each — twelve buried faces from one
default. Fixed by passing `thickness: 2.2` at the call site, which carries backer and accent out with the
faces so the sign reads as a housing wrapped around the post. Verified by photograph: the sign is legible.

**The measurement lesson, which is the same one §5 recorded about colliders.** Box overlap FOUND this and
cannot CONFIRM it. A sign face is a rotated plane, so its AABB overlaps the post's whether or not the
plane does, and the post's own AABB is 2.8 m because it is a 2.0 m square turned 37°. Both numbers stay
non-zero after a fix that is unarguable in a screenshot. `station-sign-mounting.test.mjs` therefore
measures **distance from the post's axis** — exact for a square post, whatever the yaw — and reads 0.10 m
before, 1.21 m after, against a half-width of 1.0. Proven able to fail by restoring the old default.

**A class, not an instance — and an upper bound, not a count.** A point-in-box sweep of all 191 sign faces
reports **47 candidates** whose centre falls inside some other solid, across `plaza-props`,
`zone:habitation` (21 of them), `zone:gym` and `zone:canteen`. That number must not be quoted as a defect
count: the mounts are rotated wall panels whose AABBs are larger than the panels, so a correctly flush
sign reads as buried — the fixed pylons are still in the list. Separating the two needs the piece's actual
triangles, which the spans make possible and which no instrument has used yet. **That is the next
increment, and it is the one that turns identity into a general placement gate.**

### Increment 3 — exact geometry. This is the gate (b) was for. Delivered 2026-08-30

Identity gave addresses; it did not give a gate. Every measurement above was in bounding boxes, and boxes
lie in both directions — they found the buried signs and could not confirm the fix, and a station-wide
sweep returned 47 candidates that could not be called defects. That is §5's collider lesson one level
down. The spans are what make it answerable, because they can hand back **the actual triangles**.

`trianglesOf(part)` reads a piece's world-space triangles out of the merged buffer; `containsPoint` is ray
parity; `fractionInside(a, b)` samples a's surface against b's solid.

| | boxes | exact |
|---|---|---|
| sign faces vs mounts | 135 candidate pairs | **3 defects**, in ~40 ms |
| across the pylon fix | unusable — non-zero either way | **16 before → 3 after** |

**Two bugs the tests caught before any station number was taken from them**, both of the kind that fails
silently as "no defects found" — the most expensive way for a gate to be wrong:

1. **The specialised ray was wrong on edges.** One axis-aligned ray answered *outside* for the centre of a
   box. `BoxGeometry` splits each face into two triangles and the face centre lies exactly on the shared
   diagonal, so the ray hits an edge and the crossing count is decided by the last bit of a float. It
   passed at the origin and failed at (10, 5, −3) — the signature of an edge case, not a formula error.
   Fixed with three oblique directions, voted: any ray landing on an edge is outvoted by two that do not.
2. **Sampling vertices measured the wrong thing.** A 5 m sign threaded straight through a 2 m post reported
   **0.00** inside, correctly and uselessly: all four corners are outside it, and the buried part is the
   middle. Vertices are the worst possible probe for "is this inside that", because they are by definition
   the extremes. Replaced with fixed interior barycentric samples per triangle — fixed and not random,
   because a gate that returns a different number each run cannot be ratcheted.

**The three that remain, named rather than tuned away.** `dressing:signs#6` 42% inside the lit shopfront
glazing beside the pylon at (118, 47) — present at 50% before the pylon fix, so it is that sign's
placement and not the mounting depth; and `plaza-props:signs#5` 33% and 17% inside two fronds of the
foliage in front of it. `station-sign-mounting.test.mjs` ratchets at 3.

**What this unlocks.** The same three functions answer the question for any pair of pieces, not just signs.
The 20 carriageway conflicts, the crates in the building corner at (26.5, −153.6), and the barrier sites
at (23.6, −20.2) and (21.2, 13.6) are all now measurable exactly rather than as candidate lists — which is
what Phase 7 needs to re-author a district and prove it did not make things worse.

### The backlog was one defect all along: the backdrop stands on the station

With the exact test working, the whole station was swept rather than the five reported spots. 127,278 box
candidates reduce to 1,246 pieces at ≥ 50% genuinely inside another, in 10.2 s — and the ranking is
dominated by one host class. Restricting to the rule that has no legitimate exceptions — **the skyline is
backdrop, it has no interior, nothing may be inside it**:

| block | pieces swallowed | what |
|---|---|---|
| `block:13` | **613** | `Stacking habitat blocks` ×502, scatter ×111 — an entire habitat tower inside scenery |
| `block:3` | 168 | `Stacking habitat blocks` |
| `block:4` | 107 | habitat ×89, scatter ×18 |
| `block:15` | 61 | dressing ×39, traffic control ×17 |
| nine more | 59 | hangar, commercial strip, cargo yard, gateway plaza |
| **total** | **1,008** | across **13 of the 16 blocks** |

**Three separately reported defects are this one cause.** "Two buildings half inside each other" at
(−22.8, 147.4) is `block:3` and its 168 habitat pieces. "Crates through a building corner" at
(26.5, −153.6) is `block:9` standing over the cargo yard — `cargo:instanced#28`, a 13.5 × 2.9 × 11.8
stack, measured **100% inside** `skyline:panelWarm#5`. The eight block/interior clashes ratcheted in
`station-skyline-clash.test.mjs` are the same blocks a third time. And the `clash` guard in
`_buildSkyline` was written to prevent precisely this, and has never been read.

`station-backdrop.test.mjs` ratchets the total at 1,008 — deterministic across runs, proven able to fail
at 1,007. It is the strongest gate in this family because the rule needs no judgement: "is this prop
inside that building" requires knowing what should contain what, and a building genuinely is a set of
overlapping boxes; a backdrop block should contain nothing at all.

**Also learned: exactness does not remove the need for a rule.** The unrestricted sweep's top hosts
include `hull:instanced`, `zone:gym:hullIn` and the zone shells, each "containing" everything inside
them — which is true, and by design. Ray parity answers *is A inside B*, not *should A be inside B*. The
second question is architectural and has to be stated per host class, which is what makes the backdrop
rule worth a gate and a general containment sweep worth only a probe.

### Fixed, 2026-08-30: 1,008 → 16, and how three attempts failed first

**Two structural faults, not one bug.** *A boolean has no gradient* — the sweep took the first bearing off
a carriageway and silently kept the original when nothing cleared; asked "is this clear?" a loop can only
accept or give up, and it gave up thirteen times. *And it only knew about roads* — the skyline builds at
0.92, after every district, so the plan already held every claim and was never asked.

`StationPlan.occupancyUnder` is that question, and it is **Phase 4's `_footprintClear` becomes a plan
query, arrived at from the far end**. It returns a fraction, not a boolean, so a placement loop can choose
the least bad of two hundred candidates. One query replaces knowing about the plaza, the daises, the
promenade, the commercial strip, the hangar, the habitat stacks, the residential terrace, traffic control
and the cargo yard.

**Two passes, because order matters and the rng stream may not move.** Pass 1 solves every block
most-constrained-first; pass 2 draws in spec order, so `_block` is called once per spec in the original
sequence and every block draws exactly the numbers it drew before.

| | before | after |
|---|---|---|
| pieces inside backdrop | 1,008 (13 blocks) | **16** (3 blocks) |
| block/interior clashes | 8 | 2 |
| block-on-block | 0 | **0** |
| kept collision triangles | 197,629 | 198,387 (+0.38%) |
| colliders | 26,771 | 26,771 |
| shader programs | 248 | 246 |

**Three failed attempts, recorded in the tests rather than lost.** Folding the clash test into the sweep
(interiors 8→4, but three new block-on-block overlaps — the same defect class, moved). Adding
circumscribed-circle block avoidance (no effect: the blocks that needed to move were placed before the
ones they hit existed). Using the spec's `w × d` as the block footprint (a drawn block overhangs it by
~2 m a side — `block:1` is authored 20 × 18 and measures 27.9 m across).

**And a measurement trap re-confirmed.** The first before/after showed `programs 184 → 246` and read as a
+62 regression. It was two differently-shaped harness runs being compared: `progs` is cumulative within a
run. Re-measured over the *same twenty-one framings*, the original tree reads **248**, HEAD reads **248**,
and the fix reads **246**. This is the third time in this repository's history that a program counter has
been compared across runs that were not comparable; the rule stands — same views, same order, same run
shape, or the number means nothing.

---

## 15. Phase 7 — started 2026-08-30. The gate first, because half of it did not exist

### The prerequisite is still missing, and it is a live editor hazard

§11 records the build-identity banner as "now a **prerequisite for Phase 7**". **It does not exist.** What
exists is the *document*-version integer (`builtVersion` / `built_version`) and the two version lines in
`MapEditorPanel.tsx`. There is no hash of the catalogue name set or of `world.bounds` anywhere in the
tree, and **the editor does not refuse to snap against a stale grid** — `MapEditorPanel.tsx:343` falls back
to the drag origin's `y` when the grid is missing or undecodable, silently. That is D5 unimplemented, and
it is a hazard today, independent of Phase 7.

### The per-release gate was 3½ of 7. It is now 7½ of 7

| gate item | before | now |
|---|---|---|
| `{name, position}` pin, intended deltas only | ✅ | ✅ |
| named nodes under 2,000 | ✅ | ✅ (744) |
| venue gate green | ✅ | ✅ |
| `warmPrograms` within margin **and above a lower bound** | ⚠️ upper only | ✅ `frame-gaps-program-gate.test.mjs` |
| move of largest name → `colliders` within one chunk | ❌ | ✅ `station-move-colliders.test.mjs` |
| zero `stale-name` / `out-of-bounds` over the stored document | ❌ | ✅ `check-stored-overlays.mjs` + `stored-overlay-judgement.test.mjs` |
| relic id set stable or reconciled | ❌ | ✅ `station-relic-ids.test.mjs` |

**Each gate was watched failing before it was trusted**, and three of them turned out to be unbuildable in
the obvious shape:

- **`warmPrograms` guarded the wrong direction.** Upper bound only, when the spec had already written down
  that "the realistic hazard is a drop". And the reason it had never been unit-tested was structural:
  `frame-gaps.mjs` called `main()` unconditionally, so *importing it launched Chrome*. Entry-guarded, and
  the comparison extracted to `programGateVerdict`.
- **"Within one chunk" has no meaning on the move side.** Chunks pack structure collision; a move drags
  collider *objects*. Pinned as an exact 756-name table instead — 531 would move colliders, 144 would
  refuse with `span`. A tolerance would let a name drift every release until it had doubled.
- **The stored-document check cannot be a `npm test`.** Both codes are properties of database rows, CI has
  no credentials, and a committed snapshot would rot. It is a read-only release step; only its *judgement*
  is unit-tested. Run 2026-08-30: 1 head document, 9 entries, 0 name-targeted, both codes zero.
- **A relic count assertion would have been vacuous.** `want` sits exactly at the `MAX_PER_WORLD` ceiling
  (the clamp binds, not the area term), so 120 candidates are offered to a budget of 110 and `placed`
  stays 110 however many roofs a re-author retires or mints. Only identities can move, so the pin is on
  identities.

### The foundation: the plan could not see half the station

`_solid` — 1,530 hand-authored axis-aligned colliders — had never claimed into the plan; only `_solidRot`
did. Phase 7 re-authors placement *against the plan*, so this was load-bearing. One line:

| | before | after |
|---|---|---|
| claims | 11,429 | 12,959 |
| carriageway conflicts | 18 | **30** |
| pieces inside backdrop blocks | 16 | **9** |

**Twelve conflicts became visible and none of them moved** — habitat blocks ×9, cargo yard ×2, dressing ×1.
The nine habitat claims are the largest single group and are the work to go and do. Two ratchets were
raised, on the one ground that permits it: the measurement got better, not the world worse.

It also exposed that **the dome half of the overhead canary has been vacuous** since the zone/link
ownership increment re-labelled those conflicts to `link:<id>` — the regex was pinned against owner
strings that had stopped existing, and the assertion kept passing on `0 <= 8`.

### The Hub's own defects, now measurable

The two barrier sites resolve to one cause: **the dressing scatter places props inside plaza props.**
`dressing:hazard#27`, a 2.5 m barrier, is 39% inside `plaza-props:trim#189`, a planter rim; a bollard
cluster (`dressing:trimDark#213/214`, `chrome#106/107`) is inside `plaza-props:trim#149`. Now that
`_solid` claims, `occupancyUnder` can see the plaza props — the same query the skyline solve uses.

⚠ **A false-positive class the exact test needs and did not have:** zero-height pieces. Painted floor
decals and shadow blobs lying on a raised rim read as 100% "inside" it — 29 hits at the planter site
collapsed to 6 once thickness was required. This is the same false positive the abandoned drawn-geometry
probe had explicitly handled and that increment 3 re-introduced. `MINH` is in the probe; it belongs in
`GeoParts` before the next gate is built on it.

### Next

Re-author the Hub against the plan, behind the gate above: the dressing-in-plaza-props defects, the nine
habitat carriageway claims, the 16 remaining backdrop pieces and the 3 buried signs. The prerequisite
(build-identity banner, D5) should land before any release that *renames*, which none of the above does.

### Hub triage, 2026-08-30 — two false-positive classes settled by eye, one defect not yet sourced

Sweeping dressing props against authored structure: **57 pieces ≥ 50% inside something**. Filtering to
volumetric props (a plane is excluded whatever its orientation — flat in Y is a floor decal, flat in Z is
a poster on a wall, and neither can be "inside" what it is painted on) leaves **33**.

Of those, **15 are inside `hull:instanced`** — the 17 × 57.8 m hull pillars, 240 triangles each.
Photographed at (57, 1.8, 62.5): the prop is a cargo container standing clear on open deck, with the
striped pillar metres away. Ray parity is right — the pillar's shell encloses the space beneath it — and
the answer is useless. **`hull:*` joins the zone shells and the deck as a designed container.** That is
the third time today that "is A inside B" needed a per-host-class rule to become "should A be inside B",
and it is now clear this is a permanent property of the instrument rather than a gap to be closed: **an
exact containment gate needs a host allow-list, stated per class, or it is noise.**

The remaining 18 are real candidates: `plaza-props:trim` ×7, `trimDark` ×4, `panelDark` ×3,
`commercial` ×3, `residential:panelDark` ×1.

**The reported barrier is confirmed and NOT yet sourced.** `dressing:hazard#27`, a toppled hazard barrier
0.86 × 2.46 × 0.84 at (22.00, 0.34, −22.93), is **39% inside `plaza-props:trim#189`**, the 5 m planter
centred (22.11, −24.50). Photographed: the prop is visibly embedded in the planter's rim.

⚠ **A wrong turn worth recording.** The `barrier()` helper in `_buildNearField` (`StationWorld.js:9631`)
produces exactly this shape at exactly this `yc`, and its only two call sites are `:9766` and `:9773`. I
changed the toppled one and the piece did not move — because `SPAWN_X = −34, SPAWN_Z = 2`
(`StationKit.js:618`), so those two barriers stand at (−18.5, 8.8) and (−17.6, −3.4), nowhere near the
plaza. The edit was reverted; it had moved a hand-composed spawn-view prop for no reason. **Matching a
piece to its author by shape and material is not identification** — the spans give a piece an address and
a build step, and neither of those is a call site. Recording the `at()` call site in the part table would
have answered this in one query, and is the obvious next increment for `GeoParts` if this triage
continues.

### Sourced and fixed, same day: the call-site increment paid for itself immediately

`GeoBatch` can now record **where a piece was authored** — `setTraceCallSites(true)` before a build, and
every part carries the first three frames outside StationKit. Asked about the barrier the section above
could not source, it answered in one query: `StationWorld.js:9633 ← 9831 ← 10387`. **9831 is a scatter
loop dispatching by kind — a third call site the grep that found the other two had missed**, because it
sat outside the line range searched.

Off by default and asserted: a stack capture per authored piece is ~700 ms on a 37,923-piece build, which
a debugging session should pay and a player never should. The default has its own case, because a leaked
`true` would fail nothing else in the suite — the world would build correctly, look identical, and simply
be slower for everyone.

**The fix.** `_buildNearField`'s scatter tested `legal(x, z)` — radius band, gateway bubbles, road
centrelines, all geometry it computed itself — and never what the plaza built at 0.50. Its two sibling
loops in the same pass have always used `_footprintClear`. Real dressing-inside-structure defects
**18 → 10**.

⚠ **And the shared-`rng` trap caught me a second time in one day.** The first attempt used `continue`,
which does not remove one prop — it re-rolls every prop after it. Measured: a crowd figure 0.78 m off its
footing, a prop slid across an avenue legend, two gates failing that have nothing to do with planters, and
73 props lost because the same try budget filled a smaller quota. `_buildSkyline` documents this trap a
few hundred lines away. **Nudge, never skip** is now written at both sites.

One ripple was authored data rather than scatter: a nudged trolley put Wen Halloway's waypoint 2 0.18 m
inside its collider. The waypoint moved, not the trolley — hand-authored data is the safer half to adjust,
and 0.9 m is inside the jitter band that route's own note already claims to survive.

**Still open in the Hub:** 10 real dressing-inside-structure cases (plaza-props ×6, commercial ×3,
residential ×1), the nine habitat carriageway claims, 16 backdrop pieces, 3 buried signs. And the
`hull:*` host class needs adding to a stated allow-list before any of this becomes a gate rather than a
probe.

### The containment gate, and the artefact that inverts the fraction

The probe became a gate (`station-prop-containment.test.mjs`), and the thing that made it one is not the
exact test — it is the **explicit list of designed containers**. `isDesignedContainer` holds two patterns,
`^hull:` and `:hullIn$`, and each is a claim that a host is a VOLUME rather than an OBJECT. Emptying the
list takes the count from 4 straight back to 25 as the hull pillars reappear, which is the mutation that
matters: it shows the list is load-bearing and measured rather than decoration.

**Then the gate was found to be judging people.** Six of its first ten findings were crowd figures. They
were sourced by extending call-site tracing to `instanced()` — the merged half had it, the instanced half
did not, and eight of the ten were instanced — which named `StationWorld.js:9389` / `:9404` in one query.
The ambient crowd is added to the dressing *group*, so its meshes inherit `dressing:instanced` and read as
props. It is excluded by MATERIAL now, not by name, because it has its own footing gate and two gates
judging one population by different rules is how a defect gets argued about instead of fixed. Population
1,180 → 772; the crowd was a third of what the file called "dressing". Ceiling 10 → 4.

⚠ **THE FINDING WORTH CARRYING FORWARD.** A planter rim is an **annulus**, so ray parity calls its hollow
centre "inside" — a figure standing correctly on the planter deck reads at **100%**, while the real defect
this gate was written for, a barrier embedded in the rim, reads at **39%**. In a ring-shaped host a
*higher* fraction is evidence of the hollow-centre artefact rather than of a worse defect. That is the
opposite of the intuition a percentage invites, and any future threshold on this measure has to know it.
It is the same shape of error as the hull pillars, reached from a different direction, and it is now the
fourth time the architectural question — *should* A be inside B — has had to be answered per host class by
hand.

**Still open in the Hub:** 4 props genuinely embedded (63%, 64%, 65%, 92%), the nine habitat carriageway
claims, 16 backdrop pieces, 3 buried signs.

### The nine habitat road claims: one feature, and every fix is a composition call

Sourced in one query now that `instanced()` is traced too. **All nine are the same two lines** —
`StationWorld.js:7911` and `:7912`, a ring of ten planters (a 1.5 m `panelDark` cylinder plus an `emGreen`
sphere, each with its own `_solid`) at radius 12 around the "small green terrace between the blocks — the
only plants on the ring".

Photographed at (−86, 152): **cyan lane dashes and LOAD ZONE paint run straight through the ring.** They
are not decorative kerbing; they are 1.5 m bollards with colliders standing in a lane the player walks
down. The defect is real.

**But every fix that respects the road removes the feature**, and the author's own comment says the
placement is deliberate — *"this disc caps the end of the avenue and so shares its plane with the
carriageway"*. A flat disc on a road is fine. Measured, with the park centre on the avenue centreline and
a carriageway half-width of 9.9 m against a ring radius of 12:

| attempt | carriageway claims | planters surviving (2 parks × 10) |
|---|---|---|
| as built | 9 | 20 |
| refuse occupied bearings | **0** | 2 |
| slide along the ring, ±⅓ of the gap | **0** | 4 |

So the terrace is essentially built *on* the avenue, and the three honest options are (a) accept the
planting is lost and the road reads correctly, (b) accept bollards in a marked lane, or (c) move the park
off the centreline with `roadPos`'s `off` argument — which clears the road and keeps the feature, but
contradicts the stated intent that it caps the avenue. **Reverted pending that decision; it is art, not
correctness.**

One thing this loop did settle: it is the one place in the file where a `continue` is free, because `th` is
`(i / 10) * TAU` and nothing in it draws from `rng`. Both the skyline and the near-field scatter had to
nudge for exactly the opposite reason.

### Resolved: the terrace moved, and the ratchet came DOWN for the first time

Owner chose the offset. `roadPos`'s `off` argument moves the whole terrace 24 m clear of the avenue
centreline — **all ten planters survive, zero carriageway claims, zero planters inside structure.**
Carriageway ratchet **30 → 21**, the first time that number has fallen, and the first fall that is a fix
rather than a measurement improvement.

Direction was measured, not guessed: **+24 m puts the terrace inside the habitat blocks** (photographed,
one planter clipping a structure edge); −24 m is clear.

⚠ **And the visual check nearly defeated the change.** Four framings at the terrace's new centroid came
back as empty deck, while three independent numeric measures said it was there. One of the two instruments
was lying, and shipping before knowing which would have been precisely the failure this whole effort
exists to prevent. Shooting the OLD location settled it in one frame: the carriageway is clean and the
planters are plainly visible off to one side. **The framings had been pointing past them.** Worth
remembering that a subject framing which returns "nothing there" is evidence about the framing at least as
often as about the world.

**Hub state now:** 4 props genuinely embedded (63–92%), 16 backdrop pieces, 3 buried signs. The nine
habitat road claims are closed.

### The QUEUE nudge: 4 → 2, reverted, and the coupling it exposed

Two of the four remaining embedded props were one cause — the `locker` at QUEUE local (−15.525, −24),
whose two base trims sit 64% and 65% inside the 5 m planter `plaza-props:trim#179`. QUEUE is ten
hand-composed offsets applied at **all six gateways**, so editing an offset moves it at the other five;
it needs a per-gateway nudge, never a skip (several kinds draw from `rng`).

Two things were learned before it was reverted:

**A nudge ring must clear the OBSTACLE, not the prop.** The first attempt used a single 2.2 m ring and
changed nothing, because the thing the locker stands in is a 5 m planter and 2.2 m from its middle is
still its middle. Widening to 2.2/4.0/6.0 took the gate 4 → 2.

**And placement passes are coupled through PHYSICS, not just through `rng`.** Moving a QUEUE prop covered
the avenue legend `walk at (−5, −27)` — with props authored by the *near-field scatter*, a different loop
entirely. The mechanism: QUEUE props register colliders, `_footprintClear` consults
`physics.containsPoint`, and the scatter runs afterwards — so moving a QUEUE prop changes where the
scatter nudges **its** props. The rng-stream discipline this document has repeated three times is
necessary and not sufficient; a pass that adds colliders perturbs every later pass that tests against
them.

Reverted: two defects is not worth a legend regression whose fix is not obvious, and floor decals sit
below `_markOccupancy`'s 0.5 m band so `_footprintClear` cannot see them to avoid them. **Ratchet stays at
4.** The honest next step is to make painted decals visible to the clearance test, which would let both
loops nudge without covering lettering.

### Paint made visible, and the QUEUE nudge lands: props inside structure 4 → 2

The blocker was structural. Painted legends sit at y = 0.135 and `_markOccupancy` only marks triangles
reaching above **0.5 m** — deliberately, because the deck is at 0.09 and marking it would make
`_footprintClear` false everywhere. So **paint was invisible to every clearance test in the file**, which
is why the first QUEUE nudge covered `walk at (−5, −27)`.

`_legendSpots` records the 32 legend footprints **where they are authored**, from `decalCells`, because
there the cell is still a number with a name. Recovering it from atlas UVs later — which is what the decal
*test* must do — would be test logic living in the world. `_onLegend` is deliberately separate from
`_footprintClear`: that answers "is this ground free", and paint does not occupy ground. *You can stand on
a legend; you must not be built on one.*

With paint visible the QUEUE loop takes the nudge it needed — **props inside structure 4 → 2, legends
still zero**, kept collision +2 triangles.

⚠ **A nudge ring must clear the OBSTACLE, not the prop.** The first QUEUE attempt used a single 2.2 m ring
and moved nothing: the thing the locker stands in is a **5 m** planter, and 2.2 m from its middle is still
its middle. Sized to the prop rather than to what it was stuck in — an easy and invisible mistake, since
the code looks correct and simply never fires.

**Hub state:** 2 props embedded (both single hand-authored placements — a projector cone at y = 13.8 and a
vent grate — so each needs its own look rather than a rule), 16 backdrop pieces, 3 buried signs.

### The two embedded props were not two of a kind: one was a mast standing in a room

Both remaining findings were sourced in a single traced build. They turned out to belong to different
classes, and only one of them was a defect.

**The projector cone at (110, 13.8, 24) — accepted, photographed.** The hologram ad mast's fourteen
metres are drawn from `y = 0` with no knowledge of what stands there, and this one rises through the
HELIOS OPTICS unit, putting its cone 92 % inside the roof slab. Shot from three headings it reads as *a
projector mast on a shop roof* — which is what it is meant to be — and the unit is not in `OPEN_SHOPS`,
so the volume it crosses is sealed. Left at the honest 92 % rather than tuned away: dropping the bar to
hide a 92 % would blind the file to everything.

**The vent grate was scatter, and the loop was blind.** Fixed by the same rule as the others.

But sweeping *all eight* ad spots — not just the one the gate named — found that **six of the eight cross
structure**, and led to the finding that matters:

#### `[-24, 16, 96]` stood in the middle of a habitat tower

`tower-interior-habitat-stack-s1` spans x −36…−11.7, z 76.9…106.8. The mast ran fourteen metres up
through four storeys of a room the player can walk into, carrying a 1 m square collider and a 9 × 4.5 m
advertising plate with it. The `station-move-colliders` fixture had been recording it all along:
`tower-int-habitat-stack-s1:*` counts fall by one across seven materials now that the mast is gone,
because the editor had been dragging it with the building.

Moved **sixteen degrees round the same ring** rather than to the first clear patch. The eight spots are a
composition spread around the plaza and radius and district are what that composition is made of; swept
from −40° to +40°, (3, 99) is one of only two bearings where the mast column *and* the whole plate volume
are empty.

#### Why nothing caught it: two blind spots pointing at each other

⚠ **A long thin thing dilutes.** `fractionInside` measures the whole prop, so a mast with one metre inside
a wall and thirteen in open air reads about **7 %** and passes a 50 % bar. The containment gate caught one
of the six ad masts, and it caught it by the *cone*. This is the annulus artefact's mirror image: there a
ring-shaped host made a **higher** fraction evidence of a false positive; here a slender prop makes a
**low** fraction no evidence of anything.

⚠ **An empty room contains nothing.** Ray parity works on a host's triangles, and the volume a room
encloses has none. There is no threshold that would have found this.

⚠ **And in the world, `_footprintClear` was blind for the mirror-image reason.** It samples
`physics.containsPoint`, and *the inside of a building is exactly the volume where that is false*. **That
is what a room is.** So three separate scatter passes — avenue lamps, steam vents, ad masts — read the
inside of a habitat tower as prime open deck.

This is now the third variety of the same disease in this pass, and they are worth reading together:

| the test cannot see | because | fix |
|---|---|---|
| painted legends | paint does not occupy ground | `_onLegend`, a separate question |
| the inside of a room | emptiness is what a room *is* | `_inRoom`, a separate question |
| the prop's own claim | `_contact` ran before the test | ask a different question entirely |

The third is new and it is the sharpest. Measured: **all sixty avenue lamp posts read as standing on
non-clear ground**, because `_contact` has already claimed the lamp's own patch by the time the question
is asked. A test the subject has contaminated cannot be a drop criterion — it would have deleted every
street lamp in the station. Exactly one post is inside a tower.

### `_inRoom`, and a gate at zero rather than a ratchet

`buildTower` now records `{x, z, hx, hz, yaw}` where the tower is built, and `_inRoom` rotates the query
into that frame. **`station-tower-interiors.test.mjs` is pinned at zero, not ratcheted** — an *enterable
volume* is the one host class where "should A be inside B" needs no architectural argument, which is the
question `isDesignedContainer` exists to refuse in general. A player can stand in here; nothing scattered
may.

⚠ **An AABB of a yawed building invented a defect — and then hid a different one.** The first probe used
each interior group's bounding box and reported six pieces. Four were one avenue lamp at (−33.8, 79.8),
inside the AABB of a tower yawed 1.05 rad and about two metres *outside the building*: **fourth false
positive of the session from an instrument measuring the wrong thing**, and it nearly got a working street
lamp deleted. A guard was written for it and then removed once the oriented test disagreed — *a fix for a
defect that cannot be demonstrated is worse than none*, because it is an untested branch that fires on a
future re-plan with nobody having ever seen it work. The gate holds the invariant instead.

And the AABB was concealing a real one at the same time: a different lamp, `#20` at (−52.8, 112.7), is
inside the tower's oriented footprint but *outside* the bounding box of its interior geometry, because the
plinth is wider than the rooms it carries. One probe, two errors, in opposite directions.

⚠ **The room is the SHELL, not the plinth.** `w + 0.8` was the first outline written, and that 0.4 m
overhang immediately produced a knife-edge: lamp `#20` sits **eight centimetres** inside it, standing
beside a base you are meant to be able to stand beside. A plinth is a step. Recording `w × d` keeps every
real finding — the mast is 2.6 m from the tower's centre — and drops the knife-edge, which is what a gate
pinned at *zero* needs: no finding may be within a hand's breadth of the boundary, or the pin is noise.

The gate corroborates the registry against the geometry it names (the group must exist, contain the
declared centre, and not be dwarfed by the claimed footprint) and asserts `rooms.length >= 6`, so a
rename or a reset in the wrong order cannot make it pass vacuously. Mutation-tested: restoring
`[-24, 16, 96]` fails it with both the mast and its cone named.

### A vent with nowhere to go is not installed

One of the fourteen steam vents has nowhere legal within **forty-three candidate offsets** — it sits on a
habitat tower's plinth with the whole block built up around it. The ring cannot help: *a six-metre ring
cannot leave a twenty-four-metre building*, and growing it would fling street furniture tens of metres for
obstacles five metres across. Stepping `rr` walks the vent out along its own bearing instead — the axis
the scatter is composed on — and where even that fails the vent is simply **not built**. Thirteen steam
vents look exactly like fourteen.

⚠ **`_inRoom` had to be asked unconditionally, not as a fallback.** Written first as "nudge if the ground
is blocked, then also check the room", it changed nothing: the vent on the tower plinth passed the
clearance test *at the moment that loop runs* and never reached the nudge at all. Two questions, asked
separately.

Every fix in this pass has had the same shape: **the choice may read the world, but it may not move the
stream.** Both vent yaws and the lamp shaft yaw are now drawn before any decision, so dropping something
cannot re-roll what follows.

⚠ **And `console.log` inside a world build goes nowhere.** `world-kit.mjs` captures it. Ten minutes went
into "the loop never runs" before the instrument was pointed at `process.stderr`.

**Hub state:** 1 prop embedded (accepted, photographed), 0 props in rooms, 9 backdrop pieces, 1 buried
sign (accepted), 2 skyline clashes, 21 carriageway conflicts.

### The backdrop skyline: 1,008 → 0, and it was a missing minus sign

The scored search had already taken it from 1,008 to 3. The three were one thing — the observation
promenade's balustrade, inside `block:2` — and `block:2` was the only one of sixteen whose best candidate
anywhere still stood on the station: **13.8 % occupancy, score 87.3**, which fell under the `>= 100`
threshold the code used to decide whether to record a failure at all.

The cause was an asymmetry nobody had looked at: the radial offsets were `[0, 8, 16, 24, 32, -8]` — five
steps outward, one step in. `block:2` had the window sector on one side and the ring's neighbours on the
other, and its only way out was **down** a radius. Adding `-16, -24, -32` took every block to zero
occupancy at placement time, and two others improved as a side effect: `block:1` came back from 58° off
its authored bearing to 6°, `block:10` from 46° to 10°. They had been swinging that far round the ring for
want of a step inward.

Photographed before/after at `hull-outward` and `dome-inside`: the hub silhouette from outside the dome is
unchanged, and inside, a hologram ad that used to float against a hole in the backdrop now reads against
massing — which is the skyline's stated purpose. Draw calls ±3, triangles ±500, **shader programs
identical**.

#### The gate that could be trusted, and the two that could not

Adding the inward steps immediately failed the sibling gate: `block:1 × block:2` at 783 m³ and
`block:10 × block:16` at 3,354 m³ of overlap — the same failure mode as the first attempt at this, which
produced 17,598 m³.

⚠ **Both were AABB artefacts.** Measured exactly: **zero** of 300 `block:1` pieces inside `block:2` and
zero of 367 the other way, from 78 candidate box pairs; zero of 364 and zero of 353 for the second, from
238. At bearings of 39/27 and 325/329 degrees these are corners the boxes clip and the buildings do not.
**Fifth false positive of this pass from a box standing in for a rotated thing** — and this one would have
blocked the fix that cleared 1,008 intrusions. The gate now pre-filters with the box and decides with
`fractionInside`; the defect it was written for survives untouched, because a block 20.8 m inside another
has hundreds of pieces inside it, not corners.

⚠ **And `BLOCK_OVERHANG` is a measured trade, not a margin to maximise.** The drawn block overhangs its
`w × d` spec by 4–5 m a side (block:1 is authored 20 × 18 and measures 28.0 × 27.6), so the honest
separation margin looks like 5. Swept against all three measures:

| overhang | pieces inside blocks | block/interior | block-on-block (AABB) |
|---|---|---|---|
| 2.5 / 3.0 | **0** | 2 | 2 (both artefacts) |
| 3.5 | 10 | 2 | 1 |
| 4.0 | 7 | 2 | 1 |
| 5.0 | 8 | 3 | 0 |

Past ~3 the separation test starts pushing blocks *onto the station*, which is a worse defect than two
boxes clipping corners. Inflating the occupancy and role footprints to the drawn extent as well was tried
and was worse still — blocks scattered up to 50° off their bearings and three kept residual occupancy.

#### The third test is the only one that can be trusted

Both gates above measure the **aftermath**, and the aftermath of a placement cannot be measured cleanly:
ask `occupancyUnder` about a finished block's footprint and it answers **1.000** whatever happened, because
the block's own mass, the canopy above it and the dressing around it have all claimed that ground since.
That is the same contamination the avenue lamps set for `_footprintClear`, one scale up.

`_buildSkyline` now records what the search saw *while it still had a choice* — road, occupancy and clash
per block — and the new test asserts all sixteen are clean. It replaces `_skylineUnplaced`, which kept only
`score >= 100` and **had no reader at all**: the same shape as the `clash` flag this method computed for
twenty-six lines and never consulted. Mutation-tested by restoring the old radial list, which names
`block:2` at 0.138 exactly.

### And a shop is a room

Moving the skyline moved the dressing — placement passes are coupled through physics, the finding this
document already records — and a steam vent landed in the **floor slab of commercial unit -1:3**, one of
the three in `OPEN_SHOPS`. The class was never "towers"; it is *volumes the station encloses*, and the
twelve commercial units are in it now too.

Which promptly overturned an accepted finding. The projector cone at (110, 13.8, 24) had been photographed
from three headings, judged to read as a mast on a shop roof, and accepted because the unit is sealed. But
**the shop shells are built as separate walls specifically so their interiors stay visible through the
glazing** — sealed never meant unseen, and three street framings had photographed the fascia. A pole
through the middle of a lit display is a pole through the middle of a lit display whether or not a door
opens onto it. The mast moved eight degrees round its ring.

⚠ **And the backdrop gate had been counting floor paint since it was written.** Two `polish` deck patches
turned up under `block:1` after the mast moved. `isMarking` — flat in **Y** only, the same test the sign
gate uses — excludes a hidden deck decal while keeping the promenade balustrade's upright glazing, which is
exactly what this gate exists to find. Invisible at a ceiling of 16; only a pin at zero could see it.

### The block/interior ratchet: circles, and a trade that has to be refused

The last skyline gate compared two **circumscribed circles** — the coarsest instrument in the family. A
28 m square block's circle reaches 19.8 m from its centre where the block reaches 14, so it accuses
everything in corners the block does not occupy. Of the two it reported, `block:3` against the habitat
keep-out at (−98.5, 118.6) is **clear by separating axis** with 0.9 m of circle overlap — the sixth
artefact of this pass. `block:13` against (−68.5, 66.7) is real: 4.9 m of genuine rectangle overlap.
Rectangles now, ceiling **2 → 1**.

⚠ **And the remaining one must stay.** Making `clashesAt` reach with the drawn extent instead of the spec's
circle clears *both* interior clashes — and puts **103 pieces of `block:13` inside `block:14`**. Measured
exactly, not by box. That is the same failure the first attempt at this file produced at 17,598 m³, and it
is the trade the whole method is balanced on: freedom spent keeping blocks out of one thing is freedom lost
keeping them out of another. A backdrop block inside another backdrop block reads as one broken building; a
backdrop block clipping a keep-out margin does not. Refused, and recorded at the line.

**Hub state:** props inside structure **0**, props in rooms **0**, backdrop intrusions **0**, block-on-block
**0**, skyline placements on clean ground **16 of 16**, block/interior **1** (was 8). Remaining: 21
carriageway conflicts, 1 buried sign (accepted).

## 16. D5 — build identity, and two silent fallbacks the editor had been shipping

§15 recorded the build-identity banner as a Phase 7 prerequisite that **did not exist**. It does now, and
looking for it turned up something worse than a missing feature: the editor was already answering
questions it could not answer.

### Two `??` operators that authored positions nobody chose

`snappedY` returned `number | null` and did so correctly. Its three callers did not agree about what the
null meant:

| caller | what it did with "no answer" |
|---|---|
| `MapSelectionPanel.setAxis` | left the typed Y alone ✅ |
| `MapSelectionPanel.pickLayer` | did nothing rather than guess ✅ |
| `MapEditorPanel` drag | `?? from.y` — kept the drag **origin's** height |
| `MapEditorPanel` place | `placementY` ends `?? 0` — authored at **y = 0** |

Neither is visible at the call site as anything but a `??`, which is why both survived review. The
selection panel's own comment even says the layer pick "does nothing rather than guess, **as the snap
does**" — of the four callers, the two that guessed were the two that wrote to the document.

⚠ **And zero is the worst available guess.** It is not obviously wrong the way a NaN or a 10,000 would be —
it sits near the station deck, so a placement the editor could not justify looked exactly like one that
worked.

⚠ **The fallback was PINNED.** `it('is 0 with no grid, off the grid, and where the grid has no sample')`
asserted it as intended behaviour. That is the strongest form of this defect: the suite was defending it
against anyone who changed it.

The fix is to make the refusal a **value**: `Snapped = { y, refusal: null } | { y: null, refusal }`. To get
a number out you have to look at `refusal` first. The reasons are named separately —
`no-ground-at-origin` and `no-ground-at-target` mean different things to whoever is holding the mouse:
one is "drag it somewhere else", the other is "this one cannot be dragged at all".

### The identity is the bundle's commit, and both sides read the same file

`builtVersion` is a **document** version. It says nothing about geometry, so a redeploy that re-authors a
district leaves the stored ground grid describing surfaces that are gone while every version number stays
put — and the save route judges positions against that same grid, so it agrees. Phase 7 re-authors a
district per release, which turns this from a hazard into a schedule.

`site/scripts/bundle-game.mjs` already stamps `build.json` with the commit. The game reads it and reports
`buildId`; a `build_id TEXT` column stores it; the editor page reads the *same file* off the deployed
bundle and compares. No clock comparison, no hash both ends must compute identically — the two agree
exactly when nothing has been redeployed since an admin last walked the world.

Chosen over a geometry hash deliberately: commit is **conservative in the safe direction** (two commits
with identical station geometry read as different, and the cost is an admin walking back into the world for
a few seconds) and it is **exact**, because it is one artefact rather than two derivations that must be
kept in step.

⚠ **Four answers, not two.** `ok` / `stale` / `layout-unknown` / `deploy-unknown`. A layout stored before
the column existed, or reported by a checkout with no git history, has *no identity* — and so does a page
that could not fetch the stamp. **An unknown is not evidence of staleness**, and only `stale` stops an
admin working: refusing every edit on every pre-existing row would get the check disabled within a day.
`'unknown'`, which the bundler stamps for a repo with no history, is refused at the store for the same
reason — every such build shares it, so it identifies nothing and would read as a *match*.

Nullable, not `'' NOT NULL`, and replaced **including with null**: keeping a previous build's id when the
current one cannot name itself would let the editor compare the deployed commit against a build that did
not report that row.

### Where the check lives

Staleness and the grid are asked **separately** — the grid can answer perfectly and still be describing a
build that no longer exists. Same shape as `_inRoom` versus `_footprintClear` on the world side: a fallback
would have been wrong, because the stale grid answers.

Only the grid-dependent operations are refused — the drag, the placement, the coordinate field's snap and
the layer picker. A remove, or a typed position, does not consult the ground and still works.

⚠ **And the readouts stay.** The selection panel still shows what the stale grid says under a prop, with
the banner above it naming whose grid it is. Refusing to *display* would hide the only evidence an admin
has for deciding what to do; refusing to *snap* is what stops a wrong number reaching the document. Those
are different acts and only one of them writes.

⚠ **My own completeness test went stale on its first outing.** `every refusal has words` enumerated the
three reasons by hand, so adding `stale-layout` failed it on the literal rather than on the table.
Completeness is the compiler's job — `REFUSAL_TEXT` is a `Record<SnapRefusal, string>` — so the runtime
test now walks whatever is there and asserts only what a type cannot say: no entry blank, no two reasons
giving the admin the same sentence.

**Site: 947 tests, typecheck clean. Game: +5 for the report side.**

## 17. The carriageway ratchet: 21 → 12, and three of them were people

Four groups closed. Three were placement; one was not a placement defect at all.

### Hand-authored coordinates in a road (4)

`Erecting Gateway Plaza` ×3 were three of the six **dropped-freight pallets**, authored by eye around the
plaza before the plan existed. `Scattering set dressing` ×1 was one of the eight **hologram ad masts**.
Each sits on an avenue's carriageway *and* registers a solid there, so the freight was not merely visible
in the road, it blocked it. Each moved the shortest distance `roleUnder` says clears — four metres for the
pallets, eight along its own bearing for the mast. The other three pallets and seven masts were already
clear and are untouched.

### A pipe farm laid across a service road (2)

`Stacking the cargo yard` ×2 were **pressure vessels**. The farm is a row of six at offsets
−50 −30 −10 10 30 50, and a 3.4 m tank at ±10 reaches 6.6 m from the centreline of an 18 m road. This is
the *same defect* the straddle gantry four lines above was fixed for, in the same pass — the row crosses
the road, and the only question was whether it leaves a gap. It does now (±15, by the arithmetic the
gantry's note works through plus the rasterisation margin it learned the hard way), and the pipe runs
between tanks are cut to the spans they actually cross rather than five identical 20 m pipes with two
ending in mid-air. Photographed: the avenue runs clear between the tanks with the pipe bridging over it.

### `dressing` ×3 were people, and there were 202 of them

`_solidifyProps` sweeps **every instanced mesh** in the world and boxes anything at least 0.4 m on each
axis that is standing on something. A crowd figure is 0.78 × 1.62 × 0.48 and is standing on the deck.
**202 of them had a static collider**, three standing in an avenue.

A static box would be wrong even if they stood still — you walk *through* ambient crowd. It is worse than
wrong here: the crowd animates, and `crowdBase` records every figure's spawn position precisely so the
instance matrices can move away from it. Every one of those 202 boxes was a **phantom wall in a public
concourse with nobody standing in it**.

Fixed at the sweep, by a `movingInstances` flag the animator sets rather than a material test in the
sweep: the sweep is world-agnostic and runs over the zones too, and the rule it needs — *instances that
move cannot hold a static collider* — is a fact owned by the thing that moves them.

⚠ **And a negative control had been resting on one of those people.**

`station-minigames.test.mjs` pins a point the hub flood must **not** reach, "so that loosening the flood
fails a test rather than quietly re-admitting the whole class of defect". Bearing 255 at r = 46 became
reachable, without the flood being touched. A/B settled it: restore the crowd colliders and the point is
sealed again; remove them and it is not. One of those figures was standing in the gap of the queue-barrier
line at z = −41 that closed that pocket.

Re-taking a negative control is exactly the move it exists to prevent, and it was done here on the only
ground that permits it — **the wall it depended on was itself a defect, proved by experiment**. The
replacement is drawn from the 596 cells the flood still refuses that pass every local check, and the
assertion message now tells the next person to A/B before touching the line.

### What the pins say

`colliders 26,912 → 26,711` (−201). Triangles **found** is unchanged, which is the check that this removed
colliders and not geometry; 24 moved from *boxed* to *kept* — structure those figures had been standing in
front of — and one extra planting proxy is a plant whose collision column a figure had been sharing.

### What remains, and why it is not a nudge

The twelve left are the two groups this gate has always recorded as design decisions:

- **`Opening the commercial strip` ×4** — the observation promenade's deck and balustrade at r = 158 cross
  bearing 0, and every avenue is drawn as road out to 188. A player walking out avenue 0 meets a
  balustrade. The fix is to stop the avenue at the promenade or open a gap on the axis; both are
  composition choices about the hero window sector.
- **`link:*` ×2 each** — every link crosses a carriageway at its mouth, symmetrically. A link mouth is how
  a player leaves the hub, so something has to cross the avenue there. What is missing is a way for the
  plan to *say* "crossing", not geometry to move.

**Hub state:** props inside structure 0, props in rooms 0, backdrop intrusions 0, block-on-block 0,
skyline placements clean 16/16, block/interior 1, carriageway **12**.

## 18. The eight link-mouth conflicts were a road that isn't there

`station-plan-conflicts` had recorded the four link mouths as an **open design question**: "every link
crosses a carriageway at its mouth, symmetrically… a link mouth is how a player leaves the hub, so
something has to cross the avenue there."

It had a measurement answer, not a composition one.

`_buildDeck` surfaces every avenue to `DECK_R - 12` — the road stops twelve metres short of the deck rim
rather than running off it. `StationPlan` seeded its carriageway role all the way to `DECK_R`. **The links
cross the avenues exactly there, at the rim, in twelve metres of road that has never existed.** 12 → 4,
and the four that remain are the promenade, which really is a composition decision.

A role claimed where nothing is built is not a conservative over-claim. It is a false one, and it had four
builders answering for a road nobody laid. `ROAD_R1` is now a single constant imported by the thing that
draws the surface and the thing that describes it, with `the plan's carriageway ends where the avenue
surface ends` pinning the two behaviourally so a re-derivation can't separate them again. The denominator
moved with it — 18,240 seeded cells to 17,560, and 680 is exactly 6 avenues × 12 m × 19.8 m over a 1.5 m
grid.

### ⚠ And the instrument has a blind spot I walked straight into

`roleUnder` and `claim` both confirm a hit by asking whether the claim's true rotated rectangle covers a
**cell centre**. On a 1.5 m grid, a claim under `OCC_CELL / 2` = 0.75 m of half-extent can sit squarely in
a road and slip between the centres.

I proved it the expensive way. The ad mast claims 0.5 m square. Having moved it *off* an avenue, I moved
it **onto another one** — because the sweep that placed it asked `roleUnder` at the mast's own 0.5 and got
the raster's answer rather than the road's. Asked at 1.2 the picture is uniform carriageway from the plaza
to `ROAD_R1`; asked at 0.5, **two of the six avenues report no carriageway anywhere along their
centreline** and the other four report a patchwork. My own new extent test was written at 0.5 and failed
for that reason, which is the only thing that caught it.

So a zero in that gate would mean *"nothing bigger than a grid cell stands in a road"*, which is not the
same sentence. Recorded at the gate, with the rule that anything measuring against this plan uses
half-extents of at least 0.75 — and the real fix, testing the rect against the cell's **extent** rather
than its centre, noted as something that changes every count in the file and is not to be done in passing.

**Carriageway conflicts: 21 → 4.** Remaining: the observation promenade crossing avenue 0's axis, which
needs the frame in front of you.
