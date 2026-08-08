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
