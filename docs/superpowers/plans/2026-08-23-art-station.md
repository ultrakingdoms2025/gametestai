# Phase 9 · `art-station` — implementation plan

Spec: `docs/superpowers/specs/2026-08-23-art-station-design.md`.

The station is the **entry world**. Every task below is ordered so that the thing most
likely to regress boot time is the thing measured most.

---

## Task 1 — baseline, with the harness the pilot committed

`scripts/world-shot.mjs --world station --out .probe/art-station/before`. Twenty-one
authored framings. **Change nothing first.**

**Done when** `report.json` carries `gameplayDriven: true` and a hardware GL string in
every framing. It did: `ANGLE (NVIDIA … RTX 5080 … D3D11)`.

## Task 2 — close-ups, because a population is not visible in a landscape framing

`--views none --subject "crowd=<js>" --subject "seated=<js>"`, three headings each, at
3.4 m. The expression walks `_anim.crowdBase` for the nearest standing / seated figure to
the spawn, so the subject is one a player actually meets rather than one over the horizon.

This is the step that decided the pass. The landscape framings say "the crowd is a bit
plasticky"; the close-up says it is a shop-window mannequin with no hands.

## Task 3 — diagnose, and find out that the diagnostic tool is broken here

`--ablate` matches `material.name`. The baseline's material breakdown came back as
`MeshStandardMaterial x1070` — the class-name fallback. **None of the station's 225
materials had a name**, so the A/B that saved the medieval pass from fixing the wrong
system was unavailable on the entry world.

Fixed before anything else, because it is the instrument:

- `_nameMaterials()` at the end of `_buildMaterials` → every table entry becomes
  `station.<key>`, guarded on `!m.name` so a clone cannot inherit its source's name.
- `_nameStrayMaterials()` at the end of `build()` → anything still anonymous is named
  after the mesh that draws it.
- The six `emGate_<target>` beacons name themselves at creation, because they join the
  table after the table pass has run.

**Done when** `station-material-names.test.mjs` is green, including the two scrapes that
assert both passes are actually *called* — the failure a unit test cannot see.

## Task 4 — move the crowd's joints into a table both readers can see

`make-crowd-glb.mjs` runs in Node and has to put a hand on a wrist; the wrist was a
literal inside a class method. `CROWD` + `crowdWrist()` + `crowdSeatedWrist()` +
`crowdFore()` move to `station/StationKit.js`; `_crowdBodyGeo`, `_crowdSeatedGeo` and
`_crowdHeadGeo` read them.

**Done when** all six merged crowd geometries hash **identically** before and after the
refactor. They do — the extraction was proved to move nothing before a single authored
triangle was added to it.

## Task 5 — the authored `.glb` (D4)

`scripts/make-crowd-glb.mjs` → `public/assets/station/{standing,seated}.glb`, four parts
each: `hand` (slot `skin`), `hair`, `collar`, `shoe` (slot `body`).

Rules the generator enforces on itself, at write time, not in review:

- a part must bind to a slot the crowd already draws (`body` or `skin`) — there is no
  third material and adding one would be a candidate shader program;
- a `body` part must carry a shade, because `M.crowd` is `vertexColors: true`;
- a `skin` part must **not**, because `M.skin` is not;
- the set must come in under `TRI_BUDGET`. It refused the first draft at 292 tris.

## Task 6 — the loader, on the route proven four times

`src/worlds/station/CrowdAssets.js`, a near-copy of `medieval/BeastAssets.js`: manifest,
lazy `GLTFLoader`, parallel fetches with an abort signal, per-asset `try`/`catch`, one
warning per distinct failure, synchronous cache read returning null.

Two things it bakes that the `.glb` deliberately does not carry — uv density and the
vertex-colour shade — done **once at load**, because `_crowdBodyGeo` is called per variant
and mutating a shared cached geometry at the merge site would uv-scale it three times.

`await` sits beside `loadHeroAssets()` at build fraction 0.18, for the reason that call
already records: the read at 0.95 is synchronous, and a fetch merely *started* is a race
whose losing side is silent.

## Task 7 — merge, with the three rules that are each silently wrong if broken

`_mergeCrowd(own, set, slot)`, one helper for all four call sites:

1. authored geometries are cached and shared — merge them, never dispose them;
2. attribute sets must match, or `mergeGeometries` returns **null** rather than throwing;
3. the fallback merge runs *before* anything is disposed, or it merges freed buffers.

## Task 8 — the tests

`scripts/tests/crowd-assets.test.mjs` (23) — the full pipeline contract (licence
allow-list, ledger line, manifest bytes and tris against the parsed `.glb`, byte-diff
re-run of the generator), both directions of the manifest's cross-references, the slot
vocabulary agreeing across generator / loader / manifest, and:

- **the derivation** — the authored hand spans both derived wrists and straddles the
  centreline; the seated wrist is 0.195 m from the standing one; the hair moves with the
  seated head by exactly `SEAT_HEAD_DY`; the two shoes are at *different* z, because the
  crowd's stance is not a mirror;
- **the budget A/B** — build all six crowd geometries with the committed `.glb` installed
  and without, and require the triangle delta to be *exactly* the authored triangles for
  that slot, the attribute set unchanged, and one geometry still returned per mesh;
- **the fallback** — with nothing installed the figure is exactly the 524/260 triangles
  every other test in the suite has always measured;
- **the refusal** — a part in an unknown slot is dropped, not guessed at.

`scripts/tests/station-material-names.test.mjs` (9) — the naming passes, the clone guard,
the walk up to the nearest *named* ancestor, and that both passes are wired in.

**Verified in the browser, not just in unit tests:** the built world reports **225
materials, 225 named, 0 anonymous**, and the harness's own breakdown now reads
`station.trim x132, station.panelDark x115, station.emCyan x76 …` instead of
`MeshStandardMaterial x1070`.

## Task 9 — after, same script, same framings, same machine

`--out .probe/art-station/after --compare .probe/art-station/before`, plus the same
subject framings. Table into the spec §4.

**One defect this step found and the source could not.** The first after-shot showed the
crowd wearing black-and-tan striped helmets. The hair cap's vertices stood 4.5% off the
skull, which reads as ample — but the cap is eight segments around and a chord of an
eight-segment circle sits 7.6% of the radius *inside* the arc its vertices are on, so
every facet dipped below the smooth twelve-segment head and the skin striped through.
Fixed by raising the clearance to 13%, and pinned by an **arithmetic** test on the
relation between clearance and segment count rather than by another screenshot — a
screenshot finds this once, a number stops it coming back.

## Task 10 — evidence

`.probe/` is gitignored. The shots the argument rests on are re-encoded to JPEG (quality
82) and committed to `docs/superpowers/specs/img/2026-08-23-art-station/`, in the shape
`img/2026-08-09-phase-6/` and `img/2026-08-23-art-medieval/` established.

---

## Gates

- `npm test` — 2,958 before, **2,990** after.
- `node scripts/contract-check.mjs` — 129/129.
- `npm run build`.

## Deliberately not done

See spec §5. In order of how much they cost to walk away from:

1. **`StationActors`' triangle budget** — 2.0 M of the world's 3.0 M triangles, the head
   mesh alone 490 k. Measured, tabulated, left: it is the zones' articulated cast, the
   brief for this branch says characters are done, and the courts put actors at 15–30 m
   where a plaza-chosen segment count is not obviously right. It wants its own
   before/after.
2. **The avenue planting** — nine mint hemispheres down the habitation avenue, with no
   trunk, no planter and no broken edge. A real defect with the same diagnosis as the
   crowd, a different system, and its own shots.
3. **`plaza-wide`** — photographs Gateway 02's arch, not the plaza. Not blind, unlike the
   medieval framing that was fixed, and `plaza-centre` already covers the spire. Editing
   `src/dev/Harness.js` with three other Phase 9 branches live in it was not worth it for
   a duplicate framing.
4. **The white blobs at distance** — still `src/systems/Loot.js`, still shared by nine
   worlds, still not this branch's.
