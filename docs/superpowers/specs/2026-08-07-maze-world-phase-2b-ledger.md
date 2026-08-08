# SDD ledger — plan: docs/superpowers/plans/2026-08-07-maze-world-phase-2b-levels.md

Branch: maze-phase-2b (branched from main at 2467d4b)

## Tasks

1. Make Physics.remove() O(1)
2. Enclosure — a narrower anti-ladder rule with a proof obligation
3. Stair shafts
4. Four levels
5. The canopy
6. Prove it in the browser

## Progress

Pre-flight scan (1 conflict, escalated to the owner and RULED ON before execution):
- The plan amends `scripts/tests/maze-colliders.test.mjs`'s anti-ladder gate to
  exempt `enclosed` descriptors. A reviewer would rightly treat weakening a
  safety test as a regression, and this one enforces a guarantee the owner asked
  for in the original brief ("the character has to stick to the path, so no
  jumping through hedges, walls").
  RULING (owner): narrow the rule and add a proof obligation. Steps are allowed
  in the 0.45-5.0m band ONLY inside a sealed shaft; enclosure is proven per
  shaft per seed, geometrically AND by a capsule sweep from 32 angles that fails
  if it reaches hedge-top height outside the shaft. A shaft missing one wall
  must fail the gate. The spec has been amended to record this
  (docs/superpowers/specs/2026-08-07-maze-world-design.md), so the narrowed rule
  is the spec's rule, not a plan-local exception.
- Owner also confirmed continuing in the current session rather than resuming
  fresh.

Carried in from 2a's ledger, to be folded in:
- Physics.remove() is 86.9% of district eviction cost (Task 1 fixes it; SHARED
  file, needs its own per-world regression pass).
- carveDistrict's vertical-doorway bound tests MAZE.LEVELS not the active limit
  (Task 4 touches that code).
- The residency property test's oracle restates districtAtWorld's own formula.
- The ground-continuity test is a seam guard, not an eviction guard - it stays
  green if drop() stops working. Needs a comment saying so.

Task 1: complete (commits 2396f50..fa196f8, review clean after 1 fix round)
  Physics.remove() now O(1) via a collider->index Map plus swap-remove.
  Measured by me: 8x colliders = 20x time, 32x = 61x (old linear scan would have
  been 64x and 1024x). Implementer drove all six worlds in a browser after the
  shared-file change: station 25221, medieval 1455, sports 388, citadel 3505,
  race 8180, maze 6025 colliders, all walkable and stable.
  Reviewer independently stress-tested the swap-remove invariant over 5,000
  colliders in shuffled order, asserting _index.size === colliders.length and
  colliders[_index.get(c)] === c after EVERY removal, plus heightfields mixed in.
  Confirmed by grep that nothing depends on collider array order (the only direct
  reader is StationWorld._dropEnclosedTriangles, which is order-independent).
Task 1: fix round 1/5 (commits b9cd007..fa196f8) - MY perf test was too tight:
  threshold 24 against measurements swinging 4.6x-20.1x on identical code. It
  would have flaked, and a partial regression could have slipped under it.
  Rewritten to compare 2,000 vs 64,000 (32x work), assert under 200 (linear
  ~1024x, O(1) ~30-60x), min-of-3 trials, with both bounds named in a comment.
  Eight observed ratios across implementer and reviewer: 39.5-51.8, tight band,
  nowhere near 200. Implementation untouched (+22/-7 in the test file only).

Task 2: review NOT APPROVED. Two Critical, two Important. The Criticals are in
  MY SPEC AMENDMENT, faithfully implemented.
  - CRITICAL: the wall-height bar was the constant HEDGE_HEIGHT (5.0m), unrelated
    to the LEVEL_HEIGHT (9.0m) that a staircase climbs, and isEnclosureSound
    skips `enclosed` descriptors entirely so nothing tied the two together. A
    24-tread stair climbing 9m inside four sealed 5m walls was reported SOUND.
    Measured escape height with a real capsule: 10.0m - the player walks up the
    stairs and over the wall tops onto the maze roof. This is exactly what the
    gate was written to prevent, and I wrote the hole into the spec.
    Spec corrected: the bar is now derived - max(top of every enclosed standable
    in the shaft) + 0.93 hop + margin - and explicitly must not be a constant.
  - CRITICAL: `enclosed` is self-certifying end to end. isEnclosureSound has no
    caller outside its own fixture file; nothing enumerates emitted descriptors
    and binds the band exemption to a proven shaft. Any collider could exempt
    itself by asserting it was enclosed.
  - Important: escapeHeight seeds only on the shaft floor and drives straight
    lines, so it can never find the escape a staircase enables, which is from the
    TOP STEP. It returned -Infinity on the failing fixture. Both halves of the
    "two checks" missed the same shape, which is how the Critical survived.
  - Important: coverage demands ONE collider spanning floor to top, so contiguous
    stacked wall pieces are rejected. Conservative not dangerous, but it will
    reject legitimate geometry once walls are pieced.
  Reviewer confirmed as already correct and not to be disturbed: a wall marked
  enclosed:true is correctly excluded from counting as its own coverage; offset,
  narrow, and gapped-stack walls are all correctly rejected; the grounded hop
  gating did not weaken lateral detection (missing-wall escape still found at
  2.5m). The implementer's two fixes to my brief were both real and correct.
Task 2: fix round 1/5 dispatched.
Task 2: fix round 1/5 (commits cc165a0..e1e9b0f). F1, F3, F4, F5 all FIXED and
  verified adversarially. Verified by me directly against isEnclosureSound:
  9m stairs in 5m walls now UNSOUND (was SOUND, escape 10.0m); 9m in 9.93m
  (bare hop, no margin) UNSOUND; 9m in 14m (what Task 3 emits) SOUND; 4.5m in 5m
  UNSOUND; plain cell with no stairs in 5m walls SOUND; contiguous stack SOUND;
  gapped stack UNSOUND.
  Reviewer additionally confirmed: the derived bar falls the SAFE way one
  millimetre below threshold; the sweep finds a real 10.86m escape on bare-hop
  walls, so the margin is load-bearing not decorative; tread-top seeding causes
  no false depenetration failures even with an overhanging slab; interval
  merging survives reversed, shuffled, overlapping and nested pieces.
Task 2: fix round 2/5 dispatched. Reviewer found a WORKING EXPLOIT plus 3 more:
  - CRITICAL: groupEnclosedByShaft groups by descriptor CENTRE while
    requiredWallTop and launchPoints decide relevance by footprint OVERLAP. A
    stair centred in sealed cell A with hx:3.0 spans into open cell B, clearing
    A's east wall, leaving 0.8m of standable top at 2.0m inside B. Granted the
    exemption via A; B is unsound and never checked. Fix: group by every cell the
    footprint overlaps.
  - Important: the enumeration test asserts shaftsChecked === 0, so it runs ZERO
    real assertions today. Its window is 3 seeds x districts (4,4)-(5,5) x level
    0 x levels:1. Staircases will appear across all districts and all 4 levels,
    so the tripwire will not fire and the test will pass while checking nothing.
  - Important: ENCLOSURE_MARGIN 0.5 is documented as float slop, but Player.js's
    step-up reaches stepHeight (0.45) BEYOND the hop, so the true bar is 1.38 and
    0.5 leaves ~5cm of real slack. Raise stepHeight past 0.5 and the gate goes
    silently unsafe. Derive it, or assert MARGIN > stepHeight.
  - Minor: contract-check asserts export names only, so nothing stops a `three`
    import being added to MazeColliders.js - and that purity is what makes these
    gates headless.
Task 2: fix round 2/5 (commits e1e9b0f..a80f842). All 4 findings FIXED and
  MUTATION-VERIFIED by the reviewer, not merely inspected:
  - The spanning exploit is closed. overlappingShaftCells attacked directly with
    3-cell spans, negative coords, a descriptor larger than a district (1681
    cells, no truncation), and a 1mm reach into a neighbour - all grouped and
    checked. Grouping's predicate is inclusive (>= -EPS) while requiredWallTop
    and launchPoints are exclusive (> +EPS), so grouping is a strict SUPERSET and
    no overlapped cell can be missed.
  - The enumeration test fires: reviewer patched districtColliders to emit an
    enclosed descriptor and got a real failure, then placed it at level 3,
    district (17,3) - outside the OLD window - and it still failed.
  - ENCLOSURE_MARGIN is genuinely derived: MAZE.STEP_HEIGHT + 0.05, with
    MAZE.STEP_HEIGHT pinned to CONFIG.player.stepHeight by a test. Reviewer set
    stepHeight to 0.62 in Config and the build broke, as intended.
  - Import purity now asserted textually for both maze modules.
Task 2: complete (commits fa196f8..a80f842, review clean)

Task 2: PARKED, and MUST be carried into Task 3 - three residuals, all fail-safe:
  1. `climb: false` is an UNSTATED PREMISE of the whole derived bar. Climb.js
     mantles up to MAX_RISE 2.4m, which is 1.7x the hop+stepHeight bar, and is
     only unreachable because MazeWorld sets rules.climb=false. That gate lives
     in rules-applied.test.mjs, a different tier, and neither maze module
     mentions the dependency. If the maze ever regains climb, this gate goes
     silently unsafe. (Player.js:590's in-water mantle is not climb-gated at all;
     moot only because swim:false.) Name the premise in the margin's comment.
  2. Boundary-touch grouping pulls in DIAGONAL cells: a tread built flush to the
     cell pitch (hx=hz=3.0) groups into all 9 cells, including four it touches
     only at a corner point, and the exemption is denied even for a shaft walled
     to 12m. Fail-safe but it REJECTS LEGITIMATE flush stairs. Corridors are
     4.8m so hx <= 2.4 stays clean.
  3. districtColliders returns ONE district's descriptors, but a cell in the last
     column/row has its east/south wall emitted by the NEIGHBOURING district
     (faces are owned N/W per cell). Any shaft on a district seam will report
     unsound SPURIOUSLY in the enumeration test.
  Reviewer's warning, recorded verbatim in spirit: (2) and (3) will produce false
  failures the day staircases land, and the fix pressure will point straight back
  at loosening which cells get checked - which is exactly where the exploit was.
  Fix them by tightening the boundary predicate and widening the descriptor
  window. NEVER by relaxing the grouping.

Task 3: stairs built (commit 0ec3f63) - 617 real shafts, enumeration test now
  proves them across 2 seeds x 4 levels x 400 districts, 0 failures. Traps 1 and
  3 handled (tread half-extents 0.75, climb:false premise documented); trap 2
  did not manifest.
Task 3: DONE_WITH_CONCERNS escalated to a FATAL finding by me.
  The implementer flagged that the entry gap "may be too short". I measured it on
  a real shaft (seed 2026, cell 69,4): both open sides have their wall base at
  0.45m above the floor. The player capsule is 1.75m. NO PLAYER CAN ENTER ANY OF
  THE 617 SHAFTS. Levels 1-3 unreachable, in a phase whose entire purpose is
  reaching them - and the gate reported all 617 SOUND, because a sealed box is
  genuinely sound; it just cannot be walked into.
  This is my rule's fault. Requiring walls from the shaft FLOOR is stricter than
  the physics needs. Leaving a shaft low down is harmless: nothing is outside to
  stand on, so you drop into the corridor. It only becomes an exploit once a hop
  plus a step-up reaches a 5m hedge top, at HEDGE_HEIGHT - HOP - STEP_HEIGHT =
  3.62m. Spec amended: seal from below that upward, doorway beneath is free,
  and DERIVE it - both of my constants have now been wrong.
Task 3: fix round 1/5 dispatched. Also requires the test that was missing and
  would have caught this: "can a player physically get in", derived from
  CONFIG.player.height. "Is it sealed" was asserted six ways; "can anyone enter"
  was asserted nowhere.
Task 3: fix round 1/5 (commits 0ec3f63..41e03ec). Verified independently by me:
  38 shafts across 3 seeds, smallest doorway 3.570m vs a 1.75m player - PASSABLE.
  And the looser bound did NOT open a hole: entry wall from 3.0m SOUND, from
  3.5m SOUND, from 4.5m UNSOUND, from 6.0m UNSOUND. ENTRY_SEAL_FROM is a single
  derived constant shared by both the geometry and the gate, so they cannot drift.
  Implementer honestly reported repositioning one Task 2 fixture whose 0.5m gap
  fell entirely below the new legitimately-harmless threshold, and re-verified
  "gapped walls still fail" against a gap that straddles the bound instead.
Task 3: review NOT APPROVED after fix round 1. Reviewer confirmed a player CAN
  now climb (8.99m of 9.0, from the corridor in through the doorway, 3 shafts
  across 3 seeds) - then ran the same climb WITH LEVEL 1'S FLOOR SLAB PRESENT:
  - CRITICAL: level N+1's floor slab spans y 8.00-9.00 and covers the shaft cell
    with NO HOLE. The top 3 treads are embedded in it. With level 1 resident the
    capsule is hard stuck at 5.99m - the step-up probe pushes its crown into the
    8.0m underside. Invisible today only because MazeWorld hardcodes level 0 in
    updateResidency and neighbourhoodKeys is same-level-only, so nothing above
    level 0 ever loads and the stairs climb into empty air. TASK 4 TURNS ON
    MULTI-LEVEL STREAMING, at which point all 617 shafts block at ~6m.
  - Important: the spec's SIMULATED proof (escapeHeight) never runs on real
    shaftColliders output - only synthetic fixtures. The real-shaft story rests
    on the geometric check alone. Same class of gap that let 617 unenterable
    shafts pass six different "is it sealed" assertions.
  - Important: the anti-ladder gate runs at levels:1, which by construction has
    no shafts, so it cannot regress-detect anything this task added.
  - Minor: closed shaft sides emit a 14m wall coincident with the existing 5m
    hedge - ~4 duplicates per shaft, ~2,468 total.
  - Minor: narrowest exposed tread strip 0.616m vs a 0.70m capsule. Works, but no
    headroom if tread extents or capsule radius change.
  Reviewer also ran the spec's part-2 simulated proof by hand on a REAL shaft:
  25 launch points x 32 headings, highest outside 1.820m - contained.
Task 3: fix round 2/5 dispatched.
Task 3: fix round 2/5 (commits 41e03ec..876ce0c). F2-F5 RESOLVED. Reviewer
  independently reached 9.00m on 3 seeds using a faithful port of Player.js's
  collide-and-step-up with a groundHeight raycast gate (the gate is what makes
  ratcheting impossible), and confirmed a capsule walking level 1 over a shaft
  never drops through the hole. Perforation verified: 4,800 district-levels
  across 4 seeds, 0 UP cells left covered, never more than one hole per
  district-level.
  MY OWN VERIFICATION FAILED TWICE HERE and produced noise in both directions -
  a step-up probe that ratcheted to 1,800m with nothing to stand on, then a
  heading sweep that circled in place at 0.06m. Hand-rolling an approximation of
  Player.js is exactly the unreliable thing I keep warning about. Relying on the
  committed tests (which include a NEGATIVE: an unperforated-floor fixture that
  genuinely sticks at 6m, proving the ceiling gate is not vacuous) plus the
  reviewer's port, and deferring the definitive check to the browser at Task 6.
Task 3: review NOT APPROVED - THIRD Critical, the mirror of the doorway bug.
  - CRITICAL: shaft walls run to LEVEL_HEIGHT + HEDGE_HEIGHT = 14m, so at level 1
    they span y 9->14 on ALL FOUR SIDES, including sides level 1's own topology
    marks OPEN. The player climbs 9m and is trapped in a 6x6 box (furthest reach
    2.05m from centre against a 3.0m cell half-width). The same walls sever
    level 1's corridors: per-district flood fill cut off up to 397 of 399 cells.
    Both THE CEILING GATE and the fall-through test pass, because they ask only
    whether the climb REACHES 9m and whether you can fall DOWN. Neither asks
    whether you can walk AWAY. Same failure shape as the doorway: proving one
    half of a journey.
    Fix: cap shaft walls at floorN + LEVEL_HEIGHT. Above that the cell is a
    level N+1 cell and its own topology governs. Teach the gate that a tread at
    or above the landing is a LANDING, not a hazard.
  - Minor: the in-code comment claims a 2.4m tread half-extent ceiling; at the
    spiral radius actually used the real ceiling is 1.1m, so 0.9m leaves 0.200m
    of margin, not 1.5m. Overstates headroom by 6x.
Task 3: fix round 3/5 dispatched.
Task 3: fix round 3/5 (commits 876ce0c..b4cd3e8) capped the walls at the landing -
  which then left an open 9m pit over every shaft: I measured 427/529 sample
  points (81% of the cell) dropping 9.00m. FOURTH Critical, each created by
  fixing the previous. The round-3 fix retired the "cannot fall through" test
  because its MECHANISM had become obsolete; its PROPERTY had not, and that is
  how the pit shipped.
Task 3: fix round 4/5 - ESCALATED to a fresh implementer on a more capable model
  per the skill's rounds-4-5 rule, given all six constraints at once and licence
  to redesign rather than patch (commit e1decd1).
  Root cause they identified: a 1.90m-radius 1.5-turn spiral needs a hole nearly
  the size of the whole cell, so "climb through the floor" and "do not sever the
  corridors" and "do not leave a pit" were MUTUALLY UNSATISFIABLE. The geometry
  was never going to work; three rounds of patching could not have found that.
  Redesign: a 2.8m stair well in ONE QUADRANT of the cell, spiral r=0.90m,
  8 treads/turn, 3 turns, landing flush with level N+1's floor, guard walls only
  where a fall is otherwise possible.
Task 3: complete (commits a80f842..e1decd1, review APPROVED, no Critical/Important)
  All six properties verified to hold SIMULTANEOUSLY by the reviewer:
  1. Walk in: 12 shafts x 3 seeds, every open side, walk AND sprint.
  2. Climb: 9 shafts x 3 seeds reach exactly 9.000m; rise 0.375m uniform.
  3. Walk away: flood fill 400/400 cells on all three districts.
  4. No fall in: ~4,600 walk-offs x 16 directions x 2 speeds, worst drop 0.758m
     (walk) / 0.762m (sprint) against a 0.77m bar. The 1cm margin is acceptable
     because shaft geometry is SEED-INVARIANT and the worst case is at an
     identical cell-relative point on every seed - not a sampling margin another
     seed could beat. Fails safe: a flaky red, never a missed pit.
  5. No canopy escape: 10,368 sweeps per shaft; grounded-rest heights outside the
     footprint form a TWO-VALUE histogram, 0.0m and 9.0m only. Nothing at 5.0
     (level N canopy) or 14.0 (level N+1). Decisive.
  6. Nothing above the cap: 532 descriptors, max top exactly 9.000, zero over.
  Both load-bearing negatives broken and confirmed red (canopy gate, pit gate).
  My own level-1 pit re-measurement on the identical grid: 132/529 (25%) is the
  stairwell OPENING by design, with 0 points having no ground at all - down from
  427/529 (81%).
Task 3: minor (deferred): the tread-overlap test's bar was cut from >= 0.70m
  (capsule diameter) to > 0. Defensible - THE CLIMB GATE now proves the property
  physically and is red-verified, which is stronger - but it is a bar removed,
  and this task's history is made of that move.
Task 3: minor (deferred, FOR THE ART PASS): the "17 sliver points" understates
  it - the real figure is ~1.2 m^2 of genuinely open well floor per shaft, in
  strips 0.264m wide x up to 0.9m long, 9m deep. Colliders are fine (a 0.35m
  capsule always overlaps a tread edge; 40k+ walk-offs found no entry) but a
  visual pass WILL see daylight through the floor.
Task 3: minor (deferred): THE PIT GATE asserts fraction < 0.25 and measures 13%,
  but my independent measurement of the same property was 24.95% - the threshold
  sits on a metric-dependent number. The substantive protection is THE
  WALK-ON-IT GATE.
Task 3: minor (deferred): property 3 (walk away) is the only one of the six with
  no dedicated negative. It did go red under the property-4 break.
Task 3: minor (deferred): guard walls DO live above floorN + LEVEL_HEIGHT;
  property 6 stays literally true only because districtColliders emits them
  rather than shaftColliders. The real assurance is the 400/400 flood fill.
Task 4: complete (commits e1decd1..dbce14f, review APPROVED, no findings)
  Four levels live. Verified by me: all 640,000 cells reachable on 3 seeds;
  ~100 UP links per level with 0 on the top level; centre lands on varying
  levels; solution paths cross levels 0-3 (seed 1's route goes UP AND BACK DOWN
  even though the centre is on level 1 - genuinely 3D).
  Full MAZE_SEEDS=1000 gate green at ~274s, exercising four-level solvability
  for the first time - the property the very first phase's disconnection bug was
  about.
  Reviewer verified independently: y=4.5 (exactly between levels) keeps BOTH
  sides resident, so someone halfway up a shaft has both ends built; 80-update
  wander with frequent level changes peaked at 43 districts / 17,672 colliders
  with 0 bookkeeping mismatches; 20 alternating level-0<->level-3 transitions
  return to the EXACT same counts every time, no drift; levels 1/2/3 limits all
  100% reachable (9/9); and - importantly given this project's history - all
  three changed test assertions are STRICTLY TIGHTER reimplementations of the
  new contract, not loosened bounds.
Task 4: minor (deferred): carveDistrict's `levels` param is currently unreachable
  dead code (isEdgeOpen already excludes out-of-range edges). Harmless
  single-source-of-truth insurance.
Task 5: complete (commits dbce14f..adbc4ee, review clean after 1 fix round)
  Canopy added, then pooled: 289 InstancedMesh objects each holding ONE instance
  (289 draw calls, against 71 meshes for the entire rest of the maze) became
  1 mesh / 289 instances / 1 draw call. I found the draw-call issue by measuring
  rather than reading the diff.
  Verified by me under churn: 1 mesh throughout 40 moves incl. level changes,
  mesh.count tracked residentKeys() exactly (0 mismatches), collider delta 0,
  clean dispose.
  Reviewer ran a 260-op mixed add/drop churn checking after EVERY op that each
  live district's matrix at its mapped slot decodes to its true world position:
  0 mismatches. Swap-on-drop correctly repoints the swapped-in district's map
  entry. Overflow fails LOUD (throws "pool exhausted") rather than silently
  dropping, which would have left undetectable holes in the horizon.
Task 5: PARKED (ruling: real defect, genuinely unreachable, defer):
  MazeCanopy.disposeAll() disposes _mesh but never nulls or rebuilds it, and
  _add/update have no lazy-rebuild guard. Calling update() after disposeAll() on
  the same instance silently "succeeds" - internal state becomes consistent and
  positions verify correct - but group.children stays empty, so the canopy
  renders NOTHING, permanently, with no error. Unreachable today because
  MazeWorld.dispose() sets this.canopy = null immediately after and build()
  always constructs a fresh MazeCanopy. Contrast MazeChunks, which builds a new
  mesh per district and so survives the same sequence by construction.
  RULING: two-line fix, no live call site can reach it, not worth a round of its
  own. Flagged for the final whole-branch review to triage.
Task 6: complete (commit adbc4ee..0c17178). mazeStats() extended with levels /
  canopyDistricts / playerLevel; two new views. Shaft framing uses DYNAMIC
  discovery (scans live cells for DIR.UP) rather than a hardcoded coordinate,
  which is correct for a world that re-rolls every entry.

BROWSER VERIFICATION (controller, Chrome DevTools MCP):
  Four levels live. At spawn: 21 resident districts, 2 levels resident, 153
  canopy districts, playerLevel 0, 8,582 colliders, 193 draw calls.
  On level 3: 34 districts, 289 canopy districts in ONE mesh, playerLevel 3,
  13,761 colliders, 254 draw calls.
  Canopy CONFIRMED WORKING: fills the horizon with fog blending, exactly what it
  was built for - the void beyond the streamed set is gone.
  Ground probe inside a real shaft cell read 9.0 / 8.625 / 7.5 / 6.75 at
  different offsets - treads at descending heights, a spiral stair seen from
  above, landing at exactly LEVEL_HEIGHT.

BROWSER FINDINGS:
  1. PLAYABILITY (record for the art/lighting pass): the shaft interior is
     PITCH BLACK. Looking up from inside, all that is visible is a bright
     L-shaped patch of sky through the stairwell opening. Geometrically correct -
     it is a sealed shaft, so no light gets in - but a black staircase is
     unplayable regardless of how correct its colliders are. Needs light, an
     emissive material, or an open side above hedge height.
  2. Minor: the `tower-top` view moves the CAMERA but not the PLAYER, so
     residency and the canopy stay at the player's old level and the framing
     shows only sky. The view does not demonstrate the thing it exists for.
     Either teleport the player as part of the view, or derive the framing from
     the player's current level.

FULL GATE: MAZE_SEEDS=1000 npm test at FOUR LEVELS -> 188/188 pass, 255.5s.
FINAL WHOLE-BRANCH REVIEW: MERGE, no Critical. Physics.js confirmed safe for all
  six worlds (every reader of physics.colliders checked individually - none
  indexes into it or depends on order). Maze module purity holds, enforced by a
  committed test.
FINAL FIX WAVE (commits 0c17178..70c005b): 5 findings + 2 the implementer found
  themselves while browser-verifying.
  - Important: districtColliders punched a hole only over the FIRST DIR.UP cell
    per district. Correct today, but LIFTS ARE THE NEXT VERTICAL LINK and a
    second one would silently re-embed its stairs in the ceiling above,
    resurrecting Task 3's round-2 Critical with every gate still green. Now
    tested exhaustively (3 seeds x 3 UP-bearing levels x 400 districts, every UP
    cell), red-checked by forcing a second doorway.
  - Important: the harness's shaft view scanned from (0,0) and framed unstreamed
    void ~3 times in 4; tower-top moved the camera but not the player. Both now
    player-aware.
  - Self-found while verifying: a `x*CELL + CELL/2` double-count (cellToWorld
    already returns the centre) offsetting every computed view by 3m; and a
    teleport landing the player INSIDE the stairwell hole on a guard rail.
  - Minors: canopy disposeAll reusability, pit-gate bar restated, test title.
  Re-review caught that the restated pit-gate bar landed 0.0444 points LOOSER
  than the original 0.25 - the exact failure mode this project keeps producing.
  Now capped: Math.min(0.25, WELL_FRACTION * 1.15) = 0.25 exactly, with the
  original bar documented as a CEILING so it can never drift upward again.

PHASE 2B COMPLETE. 189 tests, contract-check 44/44, build clean.
