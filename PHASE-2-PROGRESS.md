# World 06 Phase 2 — running progress

Original instruction (2026-08-21): *"continue the next phase of world 6 read the
world 06 memory note first. I will be gone for next few days, so carry on with all
phases uninterrupted until completed then merge to main and push to production.
The cost spent does not matter just keep going till all phases are complete"*

Design: `docs/superpowers/specs/2026-08-21-world-06-phase-2-planets.md`
Authoring brief: `docs/superpowers/specs/2026-08-21-planet-authoring-brief.md`

---

## Done

- [x] **Merged `main` into `space-dock`** (commit `63aa38c`). Ten commits of Citadel
      work. Two conflicts, both the same disagreement — main and this branch had
      each invented a channel for a world to nominate its own high cache sites.
      Resolved to ONE channel, `world.cacheSites`: an entry with only `x, z` is a
      hint and is still probed by `_highAt`; an entry carrying a finite `y` is a
      decision by a world that knows it has a roof, and the probe (measured
      returning that roof 400 times out of 400) is skipped. 2355 green, 98/98
      contracts.
- [x] **The travel defect found and scoped.** `Bodies.js` was laid out against an
      assumed "cruise 260 m/s, boost 1600 m/s". The shipped model cruises at
      **120 m/s** (`thrust/drag` = 78/0.65), caps at 260, and has 3.33 s of boost —
      so Cinder at 62 km was an **8.6-minute flight** and Cathedra would have been
      forty. Fixed by a Transit Drive whose speed is governed by altitude above the
      nearest body.
- [x] **41 ore rows** spliced into `src/systems/ItemDefs.js`. Value climbs with the
      leg; `stack` and `icon` derived from value so the dear ore cannot accidentally
      be the plentiful one.
- [x] **Body layout**: 12 bodies, 10 landable. Vitrine and Tessera promoted from
      scenery; Sirocco, Shoal, Verdigris, Lathe, Carnelian, Sallow, Cathedra added.
      All four geometry constraints verified numerically (disc ≥ 0.02 screen height,
      surfaces > 2·(rA+rB) apart, front-lit dot < 0.35, air band).
- [x] **Airless landable bodies** are now a tested category rather than an
      exemption — `space-scale.test.mjs` splits the two cases and asserts each.
- [x] **Landform vocabulary**: `crater`, `dunes`, `scarp` added to `PlanetHeight.js`.

## Landed since the first pass

- [x] **All ten descriptors authored and registered.** `index.js` is generated from
      a list by a script that re-runs `quest-vocab`'s regex scrape and refuses to
      write a file the scrape cannot read. 18 worlds in the vocabulary.
- [x] **Transit drive.** dock→Cinder **23.5 s** against 247.5 s ablated; Cathedra
      (288 km) 69.4 s. Speed governed by `clamp(altitude * 0.20, cruiseTop, 5000)`,
      so closing on a body decelerates you automatically and arrival is 320 m/s at
      the atmosphere shell, 129 at the handoff. Taking a hit drops you out. It also
      found a pre-existing `_transitFactor` ×8 displacement multiplier and made the
      drive supersede it, with a test that they never compound.
- [x] **Per-world player gravity**, as a RATIO of the −22 default, with apex ∝ r^−⅓
      and hang ∝ r^−⅔ and air control scaled so the mid-air Δv one jump buys is
      invariant — a floaty jump is a COMMITTED one, not an easier one. Tessera
      1.67 m / 1.88 s against a default 0.88 / 0.53. Non-regression proved by
      hashing a 30 s input tape against `Player.js` at HEAD: `e70852dc` both ways.
- [x] **The silent rows.** Nine `SCORES` (a planet with no row boots into TOTAL
      SILENCE), fifteen missing `WORLD_NAMES`, thirteen missing `WORLD_BLURB` in
      each of two copies, the canonical-facts sentence, and encounters generalised
      from 3 zones/9 hostiles to 12/30 while HOLDING one fight of 1–4 per trip.
- [x] **contract-check**: 98 → 114 files. It also proved the `methods` check was
      giving a FALSE GREEN — `PlanetWorld.of` reported present against a file with
      `of` deleted, because `for (const b of (…))` supplies the `(` the regex wants.
      A new `statics` kind fixes it.
- [x] **Ore ladder re-derived.** `FIELD_CREDITS` 9,746 (Cinder) → **5,168**
      (Tessera, the poorest), because the unit has to be reachable on the planet a
      player actually chose. `SYSTEM_ORE_CREDITS` split off as a measured sum
      (100,348) — `poorest × 10` answered two questions with one number and
      under-counted by half. Top rung 15,500, above the richest single field, so a
      career cannot be finished on one planet.
- [x] **Layout re-solved** under four simultaneous constraints; minimum sky
      separation 27.7°. Carnelian could not be "hard right" — every bearing that
      separated it from Tessera back-lit it — so the identity moved, not the rule.
- [x] **Lore corrected.** The dock lore still asserted the hulls were "slab-sided
      and ribbed so a yard rat can climb one like a wall", which is verbatim the
      premise the user REJECTED. Lore that argues for a rejected design is how the
      rejected design comes back.

## Suite: 2475 of 2477

One real failure (`planet-liquid.test.mjs`, being fixed) and one **load-sensitive
flake** (`citadel-caves` "what a cave actually costs" — green in isolation, red
only under the loaded parallel run; reported independently by three agents as
pre-existing). The flake should be made deterministic before anyone trusts a red
build: a timing assertion that depends on machine load is a test that cries wolf.

## THE PLAYTHROUGH — 12 defects a 2500-test suite could not see

A cold playthrough agent flew the loop six times with **real OS-level key events**
and found four loop-blockers. Keep using one. The suite was 2500 pass / 0 fail
throughout, which is precisely why this matters.

**Loop-blocking**
1. **Take-off from a planet pad kills you and deletes your hold**, 3 of 3. Throttle
   + lift (what the loading card teaches) → 2 s later "Hard landing. Hull holds."
   immediately followed by "SHOT DOWN — Cargo lost: 10 m³, 99 CR unsold." The
   reassurance and the death notice are one frame apart. And **a landed hull will
   not rotate** — 180 frames of nose-up mouse moved pitch 0° → 0° — so "pitch up
   first" is not available to the player.
2. **Permanent stranding, and the rescue key lies.** Step off Cinder's Rimhold
   pad (y 108): four directions all drop ~95 m, four climbs back all stall at
   y 62–66. **K moved the player 1 cm and said "Position reset • clear of
   geometry"** — `_tryNudgeUp` succeeds on rung 1 because they are standing on
   *valid ground*; the ladder never escalates. A recovery key that reports success
   while failing is worse than none.
3. **Ceraunus is a hologram.** Flew 4.5 minutes and passed through the centre of a
   38 km gas giant — 298 m from its middle, integrity 100, no collision, no seam,
   empty starfield on screen while the readout said "ALT 0 m · ATMOSPHERE".
4. **The transit drive is dead on the first route anyone flies.** dock→Cinder
   measured **66.7–67.7 s over six runs** against a rig-measured 23.5 s, because
   the Ashlone picket sits on the transit exit and drops the drive at t≈4. The
   nearest planet takes longer than the second-furthest.

**Spoiling**
5. Sprint+jump clears the Shoal shore barrier in **7 of 8 directions** — the
   parapet is 2.0 m above the WATER but the beach beside it is 1.8 m above the
   water and the leap apex is 1.12 m, so the effective gate is **20 cm**. Wrong
   datum. Beyond it: a dry grey plain under open sky while the minimap is solid
   blue.
6. Same key clears the yard mouth rail at **8 of 10 positions**; recovery then
   drops you on the hangar ROOF, you fall through the roof cut for 69 damage —
   and get a Viewpoint discovery and 150 credits for it.
7. The boot controls card never mentions **Z**, the transit drive.
8. The nav row carrying the ETA badge — *the target you are pointed at* — loses
   its planet name: `.eta { flex-basis: 100% }` inside a `nowrap` flex row.
9. Two stale texts: a "blast door" that no longer exists, and "sell at a yard
   counter" when docking auto-sells.

**Two measurement lessons, both mine**
- The 23.5 s transit figure came from `_flightrig`, **which has no encounters in
  it**. The rig measured a game that does not exist.
- The "no one-way pads" audit measured *seam* reachability, not *land → walk away
  → return*. Right method, wrong question.

**Good, do not regress:** the save survives a reload (verified with two sessions
on one Chrome profile — a genuine F5); death costs something and says so exactly;
combat is visible and winnable (hostile held screen-centre through a 50 s
dogfight); Tessera measurably feels different (24.9 m running leap against Shoal's
7.6 m); mining is the best-communicated system in the build.

## Open, decided but not applied

- **Cinder's primary pad is the poorest on the planet, by 25×.** `Piloting.js:1400`
  aims EVERY atmospheric entry at `landingSites.find(s => s.primary)`, which on
  Cinder is Ashfall Flat: **114 cr per 10 m³ load**, against Colonnade's 497 and
  Rimhold's 2,839. With the measured 67 s out / 90 s back, the same first
  objective is **~17 minutes from Ashfall and ~4.4 from Rimhold**. Ashfall's
  reachable mix is `ferrobasalt ×14` plus tephra — the two cheapest ores per cubic
  metre, filling the hold on bulk. Handed to the pad-audit agent, because moving
  `primary` changes the pad every guarantee is measured *from*. Deliberately NOT
  fixed by re-tuning `ORE_TIERS`, `FIELD_CREDITS` or the Kestrel's hold: the 500
  rung is 1.0 Colonnade loads, and the base hold is the Corecutter prize, placed
  at rung 2 on purpose so more room arrives while the rare tiers are still in the
  ground.
- **`ORE_TIERS`' own note contains an arithmetic slip:** it says 500 cr is "more
  than one Kestrel load from either easy pad (114, 497)". 500 is **4.4** loads
  from 114. The two numbers it quotes disprove the sentence between them.
- **Rheniite renders much paler than its swatch intends** — the ore-albedo ceiling
  took it from hueless (saturation 0.043) to readable (0.20), but `0xb8ccd6` plus
  `0x2e6a7a @ 2.2` is over-bright by descriptor design.
- **Mineral nodes are blobs, not crystals** — `IcosahedronGeometry(1, 0)` at
  near-uniform scale. Geometry, not material.

## Two instrument warnings for whoever runs this next

1. **`npm test` reports ~45 failures if a headless Chrome and a preview server are
   live** — all in the heavy ship/planet sim files, all green in isolation.
   Contention, not regression. Kill the browser before taking a suite reading.
2. **Headless Chrome stops delivering `requestAnimationFrame` ~1.5 s after boot**
   unless something keeps the compositor busy (start a screencast). Without it the
   world silently freezes and every input looks ignored — and any FPS number from
   a SwiftShader run means nothing.

## The terrain albedo trap — the one only a picture could find

**Every planet set `palette.material: 'dirt.ground'`.** `_buildTerrain` writes
`palette.bands` as VERTEX COLOURS, and vertex colours MULTIPLY into the material's
albedo map — and `dirt.ground`'s baked albedo measures linear **R:G:B =
1.79 : 1 : 0.49**. That is a brown filter over every band any descriptor will ever
author. Cinder and Sirocco looked right because they are meant to be brown; the
ICE WORLD rendered as tan moorland.

**Every automated gate passed.** `planet-atmosphere.test.mjs` measured Vitrine at
176° of hue spread and 72 points of saturation, and its bands were fine. *A
numeric gate on the DESCRIPTOR cannot see what the descriptor gets multiplied by.*

Verdigris's author diagnosed the identical mechanism from the other side — it
rejected `grass.field` because "`shadeGrass` bakes green into the albedo map and
the vertex bands multiply into it" — and nobody generalised it.

Fixed with a hue-free `rock.neutral` (luminance-only albedo, computed in LINEAR
light and re-encoded, because a greyscale on the sRGB bytes is ~4% off what the
renderer multiplies) and a purpose-built `ice.sheet` for Vitrine. Height,
roughness and normals come out bit-identical to `dirt.ground`, so exactly one
variable moved. Cinder stays on `dirt.ground` and is the control: **five of its
six frames are identical to one decimal place after the change**, which is what
makes every other planet's movement attributable.

The schema docblock now says `material` MUST be a hue-free key, with the measured
1.79 : 1 : 0.49 in it.

## The three "confidence without verification" defects

Three separate gates were found this phase to be measuring something the game does
not do. They are worth recording together because they are one failure shape, and
every one of them produced confident, well-documented, *measured* numbers:

1. **The reach probes flood at 38°; a standing capsule holds 56.6°.** Resolution
   is better than "fix the number": 38° is correct for a MOVING capsule
   (`Physics.resolveCapsule` degrades past ~44°) and 56.63° for a STANDING one.
   Neither was wrong; they were never distinguished. Both are now named and
   exported as `SLOPE.LEGACY` / `SLOPE.REAL` in `planet-envelope.test.mjs`, with a
   case that reads the other probes textually and fails if a third bare degree
   figure appears. **The rule: a GATE has to hold at the ceiling; a ROUTE has to
   work at the floor.**
2. **`contract-check`'s `methods` regex reported a false green.** `PlanetWorld.of`
   passed against a file with `of` DELETED, because `for (const b of (…))`
   supplies the `(` the regex looks for. A new `statics` check kind fixes it.
3. **The headless flight rig flies the wrong ship.** `Piloting.board` finds no
   `_shipRecord`, so `Flight.setShip` takes its `powerMul: 1` fallback and the
   rig's Kestrel cruises at 120 m/s instead of ~210 — slower than a skiff. Every
   number measured through that rig is suspect in a known direction, including the
   transit drive's safety ceiling, whose derivation assumed "the slowest hull
   boosts at 325 m/s". Being re-derived.

## In flight (agents)

| work | files | state |
|---|---|---|
| Prop kinds `spires` / `growth` / `slabs` | `PlanetProps.js`, `PlanetDescriptor.js` | running |
| Transit Drive | `Flight.js`, `Piloting.js`, `FlightHUD.js`, `ship-transit.test.mjs` | running |
| Silent per-world rows | `Music.js` SCORES, `ChatClient.js`, `api/chat.js`, `server/chat-server.js`, `Lore.js`, `SpaceWorld.js` encounters, lore chain | running |
| contract-check planet gap | `contract-check.mjs`, `quest-vocab.mjs` | running |
| Objectives retune | `SpaceObjectives.js`, `Mining.js`, `space-objectives.test.mjs` | running |
| Planet: **Tessera** | `planets/Tessera.js` | running |
| Planet: **Sirocco** | `planets/Sirocco.js` | running |
| Planet: **Shoal** | `planets/Shoal.js` | running |
| Planet: **Vitrine** | `planets/Vitrine.js` | running |
| Planet: **Verdigris** | `planets/Verdigris.js` | running |

## Not started

- [ ] Planets **Lathe, Carnelian, Sallow, Cathedra** (wave 2)
- [ ] Wire `src/worlds/planets/index.js` — nine registry entries. **Must keep the
      `[BINDING.id]: BINDING` computed-key form and a relative single-segment
      import**, or `scripts/quest-vocab.mjs`'s regex scrape silently drops the
      planet from `VOCAB.worlds` and it stops being checked anywhere.
- [ ] `src/dev/Harness.js` `VIEWS` framings — ≥5 per planet, each with
      `subject`/`clear`. Needed by `harness-framings.test.mjs` and by the
      screenshot pass.
- [ ] Per-planet headless probe + **screenshots**. Art is never assessed by reading
      code (see rejection 2).
- [ ] Playthrough agent — cold, real input, harsh. It found four shipped defects
      last time that every other agent reported green past.
- [ ] Full suite + contract-check green.
- [ ] Merge to `main`, **`cd site && npm run bundle-game`**, commit the bundle, push.
      The site serves a COMMITTED bundle from `site/public/game`; a merge without
      that rebuild ships nothing.

## Decisions taken

- **Ten landable planets, not more.** The registry cost is one descriptor each; the
  real cost is that every one must be verified reachable and must not look like a
  recoloured Cinder.
- **Ceraunus stays unlandable.** "Gas giant, no surface" is true, and the answer to
  a player who flies out to it is **Lathe**, a shepherd moon at 2.85 body radii
  carrying the richest ore in the system.
- **Lathe is 5.2 km, not the 2.6 km a shepherd moon would be.** At 185 km, 2.6 km
  is nine pixels — a star, and this system's rule is that every body is a disc.
  Legibility overrules physics, stated out loud rather than fudged.
- **Value climbs with distance.** Otherwise the far planets are scenery with a
  mining prompt on them.
- **The exotic ore on every planet is a SECOND LANDING, not a longer walk.** Copied
  from Cinder, where iridite is 0-of-9 reachable from the primary pad at any
  distance and needs the rim pad and the spiral road.

## THE BIG ONE: the reach probes measured something the game does not do

Found by Lathe's author, confirmed, and it invalidated the central design
guarantee of all ten planets at once.

- The reach probes flood at a **38°** slope limit
  (`planet-minerals.test.mjs:356`, `MAX_SLOPE_TAN = tan(38°)`).
- The game stands on `WALKABLE_NORMAL_Y = 0.55` (`src/npc/Grounding.js:49`),
  which is **acos(0.55) = 56.6°**.

So ~18.6° of slope that every probe treats as a wall is ground the shipped game
walks straight up. Every planet is designed so the rarest ore is a SECOND LANDING
— unreachable on foot from the primary pad at any distance — and every author
verified that with the 38° probe. Lathe measured the difference: at its original
rim (58°) the flood said **0 of 6** exotic nodes reachable from the wrong pad; the
real envelope said **all six, at 839 m**. The rim went to 66.6° to hold the gate
at 38°, at 56.6°, and at 56.6° *with a jump*.

Compounding it: per-world player gravity has now landed, so jump apex varies by
planet (Lathe measures 1.61 m apex, 1.74 s hang at 1.90 m/s²). A big jump reaches
ledges a walk cannot.

**A probe that measures something the game does not do is worse than no probe,
because it reports confidence.** Re-validation of all ten at the real envelope is
in flight.

## Architectural limits the descriptor agents found (real, not bugs to fix now)

These came out of authoring nine planets against one renderer. Recording them
because each is the kind of thing that gets rediscovered expensively.

1. **There are no caves. There cannot be.** `PlanetWorld` draws a HEIGHTFIELD —
   one Y per (x,z) — so no roof is expressible by any landform or prop. Vitrine
   and Cathedra both wanted a vault; both built a *collapsed* one instead (a deep
   basin behind a cliff, with `spires` as surviving columns and colliding `slabs`
   as fallen roof). `MINERAL_TERRAINS` still has `cave` and the tables still use
   it, because the word describes the PLACE honestly — but a player standing
   there sees sky. Do not let a future descriptor claim a roof.
2. **Planet liquid is neither swimmable nor solid.** `_buildLiquid` adds meshes
   and never touches `this.physics`; `swim` is false and `WaterVolumes` never sees
   it. You can walk down the beach and along the sea bed under an opaque ceiling.
   Every reach probe in the repo models liquid as a wall; the renderer does not.
   **Being fixed.**
3. **The minimap paints every liquid lava-orange** — `_publish` hard-codes
   `rgba(255,110,30,0.55)`. Shoal's sea is one 2,700 m disc, so its map is a
   full-screen orange wash. **Being fixed.**
4. **`clearOfLiquid` is unusable on an ocean world.** It is a *horizontal*
   distance minimised over all bodies, so a sea covering the playfield makes it
   ≈ −2,100 everywhere: measured, `{clearOfLiquid: 2}` placed 0 of 50 with 15,745
   liquid rejections, while `{yMin: 6.6}` placed 50 of 50. Use `yMin` against the
   water plane instead — it asks the stronger question.
5. **No radial/azimuthal albedo term.** Tessera's crater rays are prop corridors
   of bright chips, which is physically what a ray IS, but the albedo streak a ray
   system reads as from the rim is not representable. A `ray` region shape or a
   radial palette term is the missing vocabulary.
6. **`hazards.heatShimmer` is authored on Cinder and read by nothing.** Dead data.
   `PlanetWorld` reads only `ashfall.density` and `steamColor`.
7. **Airless worlds break `planet-atmosphere`'s fog ceiling.** That test asserts
   `fog.far < CONFIG.render.far` (2000). Tessera's fog far is 3960 — deliberate,
   per the airless rule (4× the diagonal, so the world dissolves into the
   starfield rather than into soup), and safe because the furthest ground from any
   legal camera is ~1,024 m. **When that test is generalised across the registry
   it needs an airless branch, not a change to the planet.**

## Phase 1 residuals — decided rather than left open

The memory note left four things "open for the user". The user is away for several
days and asked for the work to be carried through, so each is decided here and the
reasoning is written down so it can be overruled cheaply.

1. **Combat is invisible at range** (a 4.2 m skiff at 1.1 km is ~6 px).
   *Decision:* bring the ENGAGEMENT DISTANCE in rather than inflate the ships. A
   skiff you can see because it is the size of a house is a worse lie than a fight
   that happens at 300 m. Pending.
2. **The Kestrel reads as a compact shuttle, not a lean courier**, because a 6.8 m
   walk-in cabin forces 7.8 m of parallel body.
   *Decision:* keep the interior; fix the RATIO by adding LENGTH. "Lean" is long
   for its beam, not narrow — so extend nose and engine section and taper both
   ends, leaving the cabin as a bulge amidships. Walking around inside your own
   ship is not a feature you trade for a silhouette. **In flight.**
3. **`DOCK_ANCHOR` has four berths; `YardPlan` has five piers.** Pending.
4. **`SpaceWorld` puts the spawn and the return portal where `YardPlan` says there
   is no deck.** Reconciling means moving a spawn, not a wall. Pending.

## Traps carried forward from Phase 1 — do not re-earn these

1. **If a world renders dark, look for NaN before touching a light.** Four meshes
   with `tile = 0` gave NaN uvs; a weighted sum containing NaN is NaN, and 19 NaN
   pixels through `UnrealBloomPass` blacked out 921,600. Flooding ambient 27× moved
   the mean by 0.07 because there was no image to brighten.
2. **The primitive is the problem.** 197 stacked boxes made a barge, and three art
   passes on box stacks produced three box stacks. **Never assess art by reading
   code — screenshot it and look.**
3. **Shape for looks; climbing is opportunistic.** The "slab-sided so it is
   climbable" premise was invented to justify a collision constraint and the user
   rejected it.
