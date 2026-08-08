# SDD ledger — plan: docs/superpowers/plans/2026-08-08-maze-world-phase-2c-connectors.md

Branch: maze-phase-2c (branched from main at 03442c9)

## Tasks

1. Connector kinds in the topology array
2. Split `MazeShafts.js` out, dispatch on kind
3. Swept descriptors, before any lift exists
4. Prove the lift landing is possible — no geometry
5. The lift, built and switched on
6. The lift moves
7. Prove the tunnel footprint is possible — no geometry
8. Floor perforation for a region, not a cell
9. The tunnel, built and switched on
10. Prove it in the browser

## Baseline

`main` at 03442c9 is **191 tests**, not the 189 the plan says — the plan's figure
was 2b's closing count and four commits landed after that ledger closed
(3a43366, 78118e8, 033ab0c, 9c036e6), which added the render-coverage tests.

## Progress

Task 1: complete (commit 680c3a6). Connector kind rides in bits 6-7 of the cell
  byte. Audited every whole-byte read of `cells` FIRST — four exist, all safe:
  three mask with a direction bit, the fourth asks "is anything carved here"
  and cannot false-positive because connector bits are only ever written
  alongside `DIR.UP`.
  THE CONNECTOR MIX GATE's red observed, not assumed: stubbing `connectorKind`
  to always return stair gives "stair: expected ~0.600, got 1.000 over 932
  links". Recorded in the test itself.
  Carried minor closed: `carveDistrict`'s level bound is now ASSERTED to be
  redundant rather than believed to be.
  196 tests.

Task 1: PROCESS FAILURE, mine, recorded because it cost real work. I ran
  `git checkout main -- .` to measure the baseline test count. That overwrote
  the working tree BEFORE the `git stash push` on the next line, so the stash
  was empty and the `stash pop` restored nothing — the whole of Task 1's
  uncommitted edits were lost and had to be redone from context. No history was
  harmed and nothing was committed at the time. Every task since commits before
  anything else touches the tree.

Task 2: complete (commit b9fc125). `MazeShafts.js` (529 lines) / `MazeColliders.js`
  (317). `cellToWorld` moved to `MazeTopology.js` — `MazeShafts` needs it and
  `MazeColliders` needs the well bounds back, so leaving it put would have made
  the two import each other, the cycle `MazeChunks.js`'s comment records avoiding.
  Behaviour unchanged and ASSERTED so: emitted descriptors are `deepEqual`
  across the split, for stairs and for the not-yet-built kinds.
  Purity widened to all three modules, red observed: adding `import * as THREE`
  to `MazeShafts.js` fails with the intended message.
  contract-check went 44/44 → 45/45.

Task 2: THE PLAN'S TREAD-OVERLAP BAR WAS WRONG, and I wrote it.
  The plan said restore the bar 2b cut, to the capsule diameter (0.70 m). The
  geometry measures **0.364 m**, and `STAIR_RADIUS`'s own REACHABILITY note
  derives 0.311 m as the tightest a spiral satisfying the headroom and
  footprint constraints can be. 0.70 m was never attainable; restoring it
  would have produced a permanently red test, not a guarantee. I asserted a
  bar in the plan without checking it against the derivation the module
  already documents.
  Replaced with two bars, because one is weaker than it looks:
    1. CONSISTENCY, derived from the spiral's own constants. Catches a retuned
       radius/phase/tread-count. Does NOT catch the overlap simply shrinking —
       MEASURED: `TREAD_HALF` 0.46 gives overlap 0.284 against a derived 0.231
       and stays GREEN. A self-scaling bar is a consistency check, not a floor.
    2. AN ABSOLUTE FLOOR at 0.30 m against the measured 0.364 m. Confirmed red
       at 0.284.

Task 3: complete (commit 0cc50ec). `swept: {y0, y1}` on a descriptor, and
  `descriptorTop` as the single definition of "how high does this go",
  imported by both callers (`requiredWallTop` and the anti-ladder band scan)
  rather than written twice — the same discipline `ENTRY_SEAL_FROM` has.
  One of the five tests asserts a PASS: a swept platform with its declaration
  stripped sails through hedge-height walls. That is what a lift looks like to
  a gate reading only `cy`/`hy`, and recording it is what makes `swept`
  load-bearing rather than decorative.
  Reds observed by stubbing `descriptorTop` to ignore the sweep.
  203 tests.

Task 4: complete (no `src/` change — the task ships a decision).

  **THE FINDING THIS TASK EXISTS FOR, CONFIRMED WITH NUMBERS.**
  Candidate 1 (car is the landing, three rails, entry side open — the
  arrangement anyone writes first, and the direct analogue of the staircase's):
  with the car at the bottom, the worst walk-off drop at level N+1 is
  **9.000 m over 3,680 walk-offs**, against the 0.770 m bar the staircase is
  held to. The pit is exactly one level deep, which is what it should be: a
  lift shaft with the car down IS a hole. With the car UP the same measurement
  is **0.000 m**, which proves the failure is about the car's absence and not
  about the opening. REJECTED on property 4.

  Candidate 2 (a landing door driven like the car) fixes property 4 completely
  — 0.000 m worst drop over 3,616 walk-offs with the door closed — and fails
  property 7: the door's top sweeps 0 → 5.0 m relative to level N+1's floor,
  i.e. the whole band, OUTSIDE the sealed shaft. Not theoretical: an unguarded
  door **carried a rider to exactly 14.000 m, the level N+1 hedge top**.
  REJECTED as written.

  **Candidate 3 WINS: candidate 2's geometry plus one behavioural invariant —
  the door never moves while its own footprint is occupied.**
  That converts property 7 from a statement about geometry into one about
  reachability, which is what it always meant: a standable top in the band is
  only a ladder if you can board it AND ride it. Measured:
    - highest grounded ride **9.525 m**
    - against a board ceiling of 10.380 m (`LANDING_Y + HOP + STEP_HEIGHT`) —
      so the door is not carrying anyone
    - reach from the highest ride **10.905 m** against a level N+1 hedge top at
      **14.000 m**. Margin 3.095 m.
  It is the same occupancy predicate the crush guard needs for the car, so one
  mechanism serves two properties rather than being a special case.

  All seven properties verified to hold SIMULTANEOUSLY for candidate 3:
    1. WALK IN — enters from the level-N corridor through the doorway.
    2. RIDE — rider ends at 9.000 m against a 9 m landing, over 8.70 m of travel.
    3. WALK AWAY — crosses level N+1 by the north strip.
    4. NO FALL IN — 0.000 m worst drop, car down, door closed.
    5. NO ESCAPE — grounded rest heights outside the shaft are the single value
       9; nothing at 5.0 (level N canopy) or 14.0 (level N+1 canopy).
    6. THE CAP — nothing the SHAFT emits tops out above `floorN + LEVEL_HEIGHT`.
       Same explicit carve-out the stair has: rails and the door are level N+1's
       own geometry, and the test asserts the door IS above the cap so the
       carve-out cannot become dead reassurance.
    7. NO LADDER — as above.

  Load-bearing negatives, all confirmed red:
    - the unguarded door reaches 14.000 m (proves the halt invariant matters)
    - the well is NOT walkable straight through (proves property 3 does not pass
      for the wrong reason)

Task 4: MY OWN TEST WAS WRONG ONCE, and the geometry was right. Property 3's
  first draft walked a straight line at the well's centre line and failed. The
  rails correctly block that. "Walk away" means a route EXISTS, not that every
  line is clear — the L-shaped strip along the cell's north and west is the
  whole reason `STAIR_WELL_OFFSET` pushes the well into one quadrant, and the
  stair depends on exactly the same thing. Fixed the route and added the
  companion negative so the corrected test cannot pass vacuously.

Task 4: CONSEQUENCE FOR THE PLAN — Tasks 5 and 6 grow. The lift is not just a
  car: it is a car AND a landing door, both driven, both sharing one occupancy
  predicate. `liftColliders` emits the car; the door is level N+1 geometry and
  belongs with the rails in `districtColliders`, exactly as the stair's guard
  walls do. The plan's `liftCarDescriptor` needs a sibling for the door.

Task 5: complete (commit 21c436c). `liftColliders` emits one swept car in the
  same well and the same enclosure a stair gets - `shaftWalls` is now shared
  between them. The landing door and rails moved to `landingColliders`, since
  they stand on level N+1's floor and are its geometry, not the shaft's.

Task 5: THE GATES DID NOT COVER LIFTS, AND PASSED ANYWAY. The plan claimed
  flipping the dispatcher would put every existing real-shaft gate onto lifts
  for free. Measured: THE ENCLOSURE GATE's 3x3 district window held NINE
  STAIRCASES AND ZERO LIFTS. Green on the day lifts landed, having never looked
  at one - 2b's `shaftsChecked === 0` all over again. Window widened to every
  district on the level, kind tally now asserted: 196 stair / 91 tunnel / 51
  lift, all sealed.
  Task 4's proof was a FIXTURE, and 2b's ledger records that trusting a fixture
  is what let 617 unenterable shafts through. The landing property now runs on
  real generated geometry: 4 lifts x 4 seeds, worst walk-off 0.000m over ~1,570
  walk-offs each against the stair's own 0.770m bar. Doorless negative: 8.700m.

Task 5: MY OWN TEST MEASURED THE WRONG THING AND PASSED. It took the tallest
  gap under any shaft wall and called it a doorway - 5.000m. That is not a
  doorway; it is the space under a CLOSED north/west wall, where the cell's own
  hedge already stands contiguously. Corrected to the sides topology actually
  opens: 3.570m, asserted to BE `ENTRY_SEAL_FROM` so the two cannot drift.

Task 6: complete. Lift motion, two interlocks, one shared occupancy predicate.
  Structural fact that shaped it: a lift's car is emitted by the district at
  level N and its DOOR by the district at level N+1, so the halves live in
  different resident districts and evict independently. The registry is keyed
  on the CONNECTOR CELL both descriptors carry, and each half remembers its own
  district key.

Task 6: FOUR BUGS, ALL MINE, ALL FOUND BY THE TESTS RATHER THAN BY READING:
  1. The door's target was computed from where the car IS, not from whether it
     means to stay. A docked car asked to leave held its own door open, so the
     door never shut, so the car could never depart - and had it departed
     anyway, that open door was the pit.
  2. The ride target was re-decided every frame, so the car REVERSED at the
     midpoint: a rider rose 4.523m and came back down. Latched now, and only
     reconsidered on arrival.
  3. THE PIT INTERLOCK HAD A HOLE. `mayMove` allowed motion once the car had
     already left the landing, on the reasoning that only DEPARTING needs a
     shut door. Measured: the car slipped a fraction below the landing, the
     exception then applied, and it rode all 8.700m down with the door open.
     No exception now - leaving the landing at all is the thing prevented.
  4. The riding test inflated the player's footprint by the capsule radius, so
     someone merely standing in the doorway (0.1m outside the well) counted as
     RIDING. That flipped the car's target the instant they stepped up, and it
     MASKED THE DOOR INTERLOCK ENTIRELY - test 3 passed with the guard deleted.
     Riding now tests the player's centre; `_doorOccupied` keeps the generous
     inflated test, because there the conservative answer is the safe one.

Task 6: TWO OF MY TESTS WERE VACUOUS, and only mutation testing found them.
  - The door-interlock test passed with the guard removed (bug 4 above).
  - The pit-interlock test passed with `mayMove = true`, because with one
    player the trigger is hard to reach honestly: a player in the top doorway
    is also a player CALLING the car up, so it never wants to leave.
  Fixed by stubbing `_callLift` in those two tests and asserting the gate
  directly - `_callLift` decides where a lift goes, the interlocks decide
  whether it may move, and they are now tested separately. A third test covers
  the call logic itself, including that the doorway is not the car.
  All three guards MUTATION-VERIFIED: removing the pit interlock reddens test
  5; removing the door interlock reddens 3 and 5; re-inflating the riding
  footprint reddens 7.

  Verified working: a rider is carried to 9.000m, exactly the landing. Churn of
  80 mixed ensure/drop ops over 18 district keys leaves no registered half
  belonging to an evicted district and no registered collider missing from
  physics; `disposeAll` leaves zero.

  230 tests, contract-check 45/45, build clean.

Task 7: complete (no `src/` change — the task ships a decision).

  **THE TUNNEL CAN BE BUILT, and the shape is not the one the plan assumed.**

  The plan expected a 2-flight U across a 2x2 cell block. Measured, a 2-flight
  fold is the wrong shape twice over:
    - 12 treads x 0.75 m = 9.0 m of run, so the body is 10.20 m long inside a
      12 m two-cell region, leaving **0.90 m** of end gap against a 0.70 m
      capsule - 0.10 m of clearance each side. That is the identical razor
      margin 2b flagged on the stair's narrowest tread strip and explicitly
      warned had no headroom.
    - **Four flights over two lanes leaves 3.15 m.** Six treads per flight,
      4.5 m of run, body 5.70 m in the same region. Flight 2 sits above flight
      0 but TWO flights up, so the headroom between them is 2 x flightRise =
      4.5 m, not the 2.25 m a first reading suggests. That mis-derivation is
      what made a 4-flight fold look impossible on the first pass.

  So: **4 flights, 2 lanes, 2x1 cells** - not 2x2. Constraints 1, 2, 3 hold by
  construction; constraint 4 measures 12/12 side pairs reachable.

  WHAT ACTUALLY PRESERVES CONNECTIVITY, and it is not what the plan said.
  The plan assumed a narrow flight was needed so a walkable strip survived
  beside the body. Measured, both mechanisms carry load but the end gaps carry
  most of it: every half-width from 0.5 to 1.0 connects, and only W = 1.2 -
  which closes the side strip to exactly 0.00 m - severs. The width is
  therefore free to be chosen for how the tunnel reads and climbs, and the
  real constraint is that the fold be short enough to leave end gaps at all.

Task 7: FIVE FIXTURE/TEST BUGS, ALL MINE, AND THE GEOMETRY WAS INNOCENT EVERY
  TIME. Recorded because the pattern is now unmistakable.
  1. The body was offset from the west edge by a CHOSEN end gap and the east
     end fell where it may - 0.30 m, with the east door INSIDE the far landing.
     Every route from it began embedded in a collider. Gaps are derived from
     the body's true length and split evenly now.
  2. The router detoured only in x. West-to-east has both doors at z=0, so its
     "detour" walked straight into the body and reported the region severed
     when it was not. Both detour families are tried now.
  3. The first negative closed the end gaps - which a z-strip route does not
     use, so it severed nothing and reported 0/2.
  4. The second negative filled the region wall to wall - which severed only
     2/12, because the doors then start INSIDE the slab and depenetration
     shuffles the capsule out to somewhere that counts as arrival.
  5. Three assertions asserted what I expected rather than what was measured:
     that every width connects (W=1.2 does not), and that a 0.90 m gap is
     under a 0.90 m bar.
  The working negative is W = 1.2: it closes the strip exactly while leaving
  the geometry legitimate, and severs 11 of 12 pairs.

Task 7: CONSEQUENCE FOR TASK 8. The tunnel claims a 2x1 cell region, so
  `connectorHoleBounds` must return a RECTANGLE 2 cells long, and the
  enclosure grouping must cover both cells. Not the 2x2 the plan sized it for.

Task 8: complete. `connectorHoleBounds` dispatches on kind and returns the
  same `{cx,cz,x0,x1,z0,z1}` shape `stairWellBounds` does, so the four-rectangle
  floor tiling - which already handled any axis-aligned rectangle - needed no
  change at all. Only its input widened. `districtColliders` calls that and
  nothing else, so the hole and the geometry inside it cannot disagree.

  `requiredWallTop` and `isEnclosureSound` now take optional `hx`/`hz` on their
  shaft argument, defaulting to a half-cell so every existing caller is
  untouched. That is what lets a tunnel be proven against its REGION's outer
  boundary: the face between two cells of one tunnel is deliberately open, and
  a per-cell check would demand a wall there and fail a legitimate tunnel.
  `connectorRegion` and `regionShaft` express that; both still return a
  single cell until Task 9 sets a tunnel's orientation.

  THE PERFORATION GATE replaces the stair-specific multi-shaft check and is
  stated against `connectorHoleBounds` rather than a hard-coded well, so it
  keeps meaning the right thing when Task 9 lands. 236 holes checked across 2
  seeds - 142 stair, 62 tunnel, 32 lift - with the kind tally asserted, after
  Task 5's lesson about a gate that was green because it never looked at one.

  Both failure directions red-verified, because they are different bugs:
  expecting a 0.5 m WIDER hole reports 87 wrongly-floored points (2b's round-2
  Critical - geometry embedded in the ceiling, which stuck a climber at 6 m),
  and expecting a 0.5 m NARROWER one reports 48 unfloored points (2b's round-3
  Critical - the 9 m pit over every shaft).

  239 tests, MAZE_SEEDS=1000 green in 152s, contract-check 45/45, build clean.

Task 9: tunnel BUILT and switched on. Four flights of six treads over two
  lanes, folded across a 2x1 cell region, surfacing above the cell it started
  under. Orientation is hashed but CONSTRAINED to directions whose second cell
  stays inside the district; `tunnelExitBounds` derives the hole from the
  treads that actually reach the slab rather than writing it down.

Task 9: THE ENCLOSURE PROOF HAD TO BE GENERALISED, and this is the most
  delicate change in the phase. `isEnclosureSound` merges wall pieces
  VERTICALLY but requires a single piece to span a side's full width. A 2-cell
  region's cross-fold face is two 6 m pieces - and it must be two, because the
  two cells can have different topology and so can need different doorway
  heights - so both were rejected and a sealed tunnel read as unsealed.
  Resolution: `sideCovered` extracted from `isEnclosureSound` UNCHANGED, and a
  new `isRegionEnclosureSound` that checks a region CELL BY CELL at each cell's
  own four faces, skipping one thing only - a face shared with another cell OF
  THE SAME CONNECTOR, which is where the fold runs. A two-cell region still has
  six faces and every one must be covered. The bar is the REGION's
  `requiredWallTop`, so a tread high in one cell raises the requirement for
  both.
  MUTATION-VERIFIED, because a widened exemption is exactly where this project
  gets hurt: dropping one region wall reddens two gates, and shortening one
  wall by 1.5 m reddens the same two.

Task 9: five stair-shaped gates had to become connector-shaped, and each was
  widened in the narrowest way that works rather than loosened:
  - "every shaft is climbable" filtered kind:'stair' and reported a tunnel as
    having no steps. Now filters `enclosed` - the property is "nothing you must
    climb exceeds the auto-step", not "there are stair-kinded boxes".
  - the doorway gate demanded a wall on every open face of the cell, including
    the one into the tunnel's own second cell. Now skips a face ONLY when the
    neighbour is part of the same connector - strictly narrower than "skip
    faces with no wall".
  - THE ENCLOSURE GATE and the bound-to-exemption test now prove a connector
    against its region. A group with NO owning connector is still held to the
    strict single-cell test, so the case that gate exists to catch is untouched.
  - THE MULTI-SHAFT GATE asked for a stair well above a tunnel and looked in
    the wrong place. Now asks `connectorHoleBounds`.

Task 9: I BROKE MazeShafts.js WITH STRING SURGERY mid-refactor and restored it
  from the last commit rather than trying to patch the wreckage - the tunnel
  snippet was re-applied from scratch. Committing after every task is what made
  that a two-minute recovery instead of a rewrite.

  239 tests, MAZE_SEEDS=1000 green in 151s, contract-check 45/45, build clean.

Task 9: NOT YET DONE - the six properties are NOT all proven on real tunnel
  geometry. Constraints 1-4 were proven in Task 7 on a fixture and the
  enclosure/perforation/doorway/climb gates now cover real tunnels, but the
  walk-away flood fill, the pit and canopy properties, and property 3's
  dedicated negative are still outstanding for the tunnel specifically. Recorded
  as outstanding rather than claimed.
