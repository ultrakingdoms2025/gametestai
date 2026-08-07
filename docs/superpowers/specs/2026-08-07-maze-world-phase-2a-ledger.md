# SDD ledger — plan: docs/superpowers/plans/2026-08-07-maze-world-phase-2a-streaming.md

Branch: maze-phase-2a (branched from main at 0b68ae2)

## Tasks

1. One spanning-tree walk, not two
2. Residency maths
3. Build and drop a single district
4. Residency in motion
5. Wire streaming into the world
6. Prove it in the browser

## Progress

Pre-flight scan (1 conflict found, fixed in the plan before execution began):
- Task 5 said to delete the district loop AND both _addInstanced calls, while
  also keeping the forecourt. Those contradict: the forecourt would have kept
  its colliders and lost its meshes, so the player arrives in a void enclosed by
  invisible walls. Plan corrected (commit 0b68ae2) to keep _addInstanced for the
  forecourt descriptors alone, plus a test asserting forecourt meshes exist.
- Checked and NOT a conflict: ~10 existing tests call buildDistrictGraph(seed)
  with one argument. Task 1's `levelLimit = MAZE.LEVELS` default keeps them all
  working, so the signature change is backwards compatible.

Carried in from Phase 1's ledger, to be honoured by this plan:
- Task 1 exists precisely because the duplicated walk caused both the stale
  treeEdges and the dropped loop edges.
- MazeChunks must take the WORLD, not a physics instance: WorldManager swaps
  world.physics for a scratch instance during build() and restores it after.

Task 1: complete (commits 0b68ae2..27b87df, review clean)
  Two spanning-tree walks collapsed into one; MazeTopology.js 595 -> 532 lines,
  still zero imports. 4-level output SHA1-identical across 100 seeds vs the
  pre-change baseline. Full MAZE_SEEDS=1000 gate green (221s).
  Reviewer verified independently: level gating airtight for limits 1-3 across
  200 seeds each (no edge escapes the limit); edge accounting balances for
  limits 1-4 across 200 seeds; independent flood fill reached every district for
  limits 1-4 across 60 seeds; centre.level in range across 500 seeds.
Task 1: minor (deferred, pre-existing): carveDistrict's vertical-doorway check
  tests `nl >= MAZE.LEVELS` rather than the active level limit. Harmless today -
  isEdgeOpen already excludes out-of-range edges - but it is a second place the
  bound is expressed rather than derived. Phase 2b turns levels on and should
  fold it in.

Task 2: DONE_WITH_CONCERNS - implementer found my brief self-contradictory and
  was right. The brief's districtAtWorld formula used `+ MAZE.CELL / 2` while the
  brief's own example test asserted districtAtWorld(119) === district 0, and the
  two disagree. They resolved towards the test; the test was the wrong half.
  Measured: 60 mismatching metres across a 2,400m sweep - a 3m band at every
  district boundary where districtAtWorld disagrees with which district actually
  owns those cells (geometry rule: cell = round(x/CELL), district =
  floor(cell/DISTRICT), which is what districtColliders and cellToWorld use).
  No behavioural impact today (3m error against a 240m residency radius) but
  Phase 2b uses districtAtWorld for vertical transitions where a boundary is a
  real decision point.
Task 2: fix round 1/5 dispatched - derive the district from the cell rather than
  from raw metres, fix the example assertions I got wrong, and add the property
  test (agreement with the geometry across a full 2,400m sweep on both axes)
  rather than more examples. Clamping preserved: verified a player at
  x=1260, z=-40 on the forecourt still maps to district (10,0).
Task 2: fix round 1/5 (commits f6980de..3d2add2). Verified independently by me:
  boundary mismatches 60 -> 3 per axis, and all 3 remaining are at x=2397-2399
  wanting district 20, which does not exist - the clamp working correctly at the
  grid's outer edge, not residual drift. Forecourt clamp still maps (1260,-40)
  to district (10,0); far clamp maps 99999 to (19,19).
Task 2: complete (commits 27b87df..3d2add2, review clean)
  Reviewer hand-computed every assertion through the cell rule rather than
  running the code, and confirmed the property test does include the outer-edge
  tail rather than stopping short of it.
Task 2: minor (deferred): the property test's oracle restates districtAtWorld's
  own formula rather than deriving from MazeColliders' conventions. It caught the
  real 60-mismatch regression, but would not catch implementation and test being
  wrong together.
Task 2: minor (deferred): DISTRICT_SPAN is now unused inside MazeTopology.js
  (districtAtWorld works in cells, not metres). Retained because later tasks'
  tests import it.
Task 3: complete (commits 3d2add2..8352a1a, review clean, no findings)
  One district = 401 colliders (400 hedges + 1 floor). 25-district residency is
  ~10,000 vs Phase 1's ~161,000.
  Reviewer verified by measurement, not reasoning: 200 build/drop cycles with
  colliders / grid buckets / world-collider-array / group children ALL returning
  to exactly 0 every cycle, no drift. Splice correctness: built 3 districts
  (1202 colliders), dropped the middle, remaining set an exact match for A+C.
  Collision reality: capsule at sprint travelled 5.0m of a possible 27.3m into a
  resident district, and the full 27.3m after drop. Both load-bearing tests
  proven red-capable (breaking the splice, and capturing physics in the ctor).
Task 4: complete (commits 8352a1a..fa79341, review clean)
  Measured by reviewer: 0 floor holes in 492 straight steps and 696 diagonal
  steps across 8+ districts at 2m granularity; peak residency 25 districts /
  10,028 colliders over a 140-step wander; 0 divergences between
  physics.colliders.length, chunks.colliderCount() and world.colliders.length.
Task 4: minor (deferred): I labelled the seam/ground-continuity test as the
  load-bearing one in the commit message. It is not - it stays GREEN if drop
  stops working entirely, because never-evicting only ever adds floor. The
  bounded-residency test is the real eviction guard. Worth a comment by that
  test saying which regression it does and does not catch.
Task 5: complete (commits fa79341..397362e, review clean)
  Streaming live: build 102ms, 6,015 colliders at spawn (Phase 1: ~161,000),
  15 resident at spawn (grid-edge clip), 25 / 10,027 after walking 1.2km.
  Forecourt meshes present and never evicted; 40 tokens and 9 NPCs intact.
  Reviewer verified across 6 build/dispose cycles: 6 unique seeds, collider count
  oscillating 6012-6015 with no monotonic climb, world.colliders and
  group.children back to 0 every cycle, and _materials the SAME OBJECT identity
  throughout - so shader compilation is still paid once.
  Residency-above-the-token-guard verified at the hardest setting (all tokens
  taken AND _tokens emptied so the guard fires immediately): residency still
  went 15 -> 25.
Task 5: minor (deferred): MazeWorld.dispose() empties this.colliders but never
  calls physics.remove() on the forecourt's own 4 tracked boxes, so they strand
  in a shared Physics. Pre-existing (Phase 1 stranded ~161,000 the same way) and
  masked in production by WorldManager._activate calling physics.clear(). Worth
  making the world self-cleaning rather than caller-dependent.
Task 5: minor (deferred): the reworded comment in maze-populate.test.mjs claims
  full independence, but the district term is now read back from the same manager
  that produced it rather than recomputed. Half-true.
Task 6: complete (commit 397362e..75d3623). mazeStats() probe + 3 maze camera
  framings added to the dev harness.
Task 6: minor (deferred, MY error): the plan's verification snippet says
  `GAME.harness.mazeStats()`. The harness actually installs at `window.HARNESS`,
  so the correct call is `HARNESS.mazeStats()`. Plan text should be corrected.

BROWSER VERIFICATION (controller, Chrome DevTools MCP) - ALL EXIT CRITERIA MET:
  At spawn: 15 resident districts, 6,025 colliders (grid-edge clip).
  12-step traverse across the maze: residency pinned at 25, colliders flat at
  10,035-10,043 - bounded, not climbing. Draw calls 159-191.
  Six station->maze entries: 6 unique seeds, colliders 6021-6026, and shader
  PROGRAM GROWTH ZERO (pinned at 369 across all six) - materials genuinely
  shared, so entry never re-pays compilation.
  Portal entry 189-348 ms against a 3,000 ms budget.
  Gates: <=25 resident (25), <40,000 colliders (10,043), <3s entry (0.35s max).

FULL GATE: MAZE_SEEDS=1000 npm test -> 135/135 pass, 0 fail, 257.7s.
FINAL WHOLE-BRANCH REVIEW: MERGE. No Critical. Four other worlds untouched -
  the branch modifies no shared world/physics file at all.
FINAL FIX WAVE: complete (commit 75d3623..c0e13bb). All 6 items addressed and
  independently re-verified. Re-reviewer measured drop() at 1.55ms mean vs the
  2.957ms baseline (~50% cut, better than the 38-43% claimed) and profiled that
  86.9% of the residual is inside Physics.remove()'s own indexOf over ~9,826
  elements. Collider-array identity verified against survivors after alternating
  drops. Verdict: MERGE.

CARRIED TO PHASE 2B:
- Physics.remove() does a linear indexOf over the shared collider array and is
  now the dominant cost in chunk eviction (86.9%). Phase 2b multiplies collider
  counts by 4. An index/Map in Physics.js would fix it, but that is a SHARED file
  used by all six worlds, so it needs its own change with its own regression pass.
- carveDistrict's vertical-doorway bound still tests MAZE.LEVELS rather than the
  active limit. Unreachable today; 2b edits that loop.
- The residency property test's oracle restates districtAtWorld's own formula.
- The ground-continuity test is a seam guard, not an eviction guard - it stays
  green if drop() stops working. Needs a comment saying so.
