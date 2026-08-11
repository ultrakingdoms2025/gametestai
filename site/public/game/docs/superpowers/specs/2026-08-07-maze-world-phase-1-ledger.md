# SDD ledger — plan: docs/superpowers/plans/2026-08-07-maze-world-phase-1-foundations.md

Branch: maze-world (branched from main at 1e0d408)
Workspace: .superpowers/sdd/2026-08-07-maze-world-phase-1-foundations/

## Tasks

1. Test infrastructure (node:test + npm scripts)
2. Topology constants, indexing and hashing
3. The district graph
4. Carving district interiors
5. Whole-maze generation, solvability and reachability
6. Physics.remove()
7. The world-rules layer
8. Applying the rules to the twelve systems
9. Collider descriptors for a district
10. The containment gate
11. The maze world, wired end to end

## Progress

Pre-flight scan (2 conflicts found, both adjudicated by human before execution):
- Task 6 mandated copying _insertToGrid's footprint maths into remove().
  RULING: extract a shared `_gridRange(collider)` helper used by both. Rationale:
  if the two copies drift, remove() misses buckets and colliders become
  un-removable ghosts. Plan text is superseded for this point.
- Tasks 8/11 use textual source-string tests. RULING: keep. These 13 modules
  cannot be imported under Node (document/canvas/WebGL at module scope), the
  same constraint that made contract-check.mjs textual.

Task 1: complete (commits 1e0d408..6be5f1f, review clean)
Task 1: minor (deferred): test script uses `node --test scripts/tests/*.test.mjs`
  (glob) not the brief's directory form; relies on Node >=20 native glob in the
  test runner and package.json declares no `engines` floor.
Task 2: complete (commits 6be5f1f..7f572ab, review clean)
Task 2: minor (deferred): MAZE.CELLS/LEVEL_CELLS/TOTAL_CELLS are hand-written
  literals rather than computed; tests cross-assert the relationships so drift
  is caught, but the constants do not self-propagate.
Task 3: complete (commits 7f572ab..53e1c75, review clean, no findings)
Task 4: complete (commits 53e1c75..2df61a6, review clean, no findings)
Task 4: PLAN DEFECT found and fixed by implementer: brief specified salt `0xd00r`,
  which is not valid hex. Corrected to `0xd00d` in code; plan doc also corrected.
  Reviewer confirmed the salt appears in exactly one function so it cannot drift.
  Reviewer proved border agreement empirically: 50 seeds x ~319,200 adjacent cell
  pairs, 0 mismatches.

Task 5: MAJOR PLAN DEFECT found by implementer, confirmed by reviewer.
  buildDistrictGraph builds its spanning tree over all 4 levels including
  vertical edges. generateTopology(seed, {levels:1}) - which is what Phase 1
  SHIPS - then carves only level 0, so any tree path that ran up through level 1
  and back down is severed. Reviewer measured against the brief's code:
  level-0 graph disconnected in 300/300 seeds; 25 of 40 seeds had NO
  entrance->centre path; worst case 1,601 of 160,000 cells reachable (1%).
  Implementer's fix rebuilds a spanning tree over the restricted subgraph
  (constructs, does not filter) - verified correct, 300/300 seeds fully
  reachable and solvable, 4-level path byte-identical to before on 100/100 seeds.

Task 5: fix round 1/5 dispatched (3 findings):
  - Important: single-level rebuild discards the 10% extra edges, so Phase 1
    would ship a strictly perfect maze with zero loops, contrary to the approved
    spec. Restore the extra-edge pass over restricted candidates.
  - Important: `!nc.vertical` is a dead condition - districtCoords returns
    {dx,dz,level}, no `vertical` field. Always undefined, so the horizontal-only
    filter never ran; 146 vertical edges present at {levels:2}. Correct at
    levels:1 only by accident. Should be `!n.vertical`.
  - Owner decision: 1,000-seed gate made opt-in via MAZE_SEEDS env var
    (default 200, ~30s) because the full gate costs 142s of a 164s suite and
    tasks 6-11 run it repeatedly. Full gate required before Phase 1 exit.
  Minors folded in: dead `const candidates = []`; no-op vertical-door-stripping
  loop whose comment overstates what it does.
Task 5: fix round 1/5 (4 addressed, 0 open; commits 8a7877b..c3a3783)
  Re-review verified: extra-edge pass restored (9.86% measured, 33 real cycles at
  seed 42); horizontal-only filter removed in favour of VERTICAL_BIAS ordering
  (NOT the literal `!n.vertical` fix I asked for - reviewer confirms a literal
  fix would have left level 1 unconnected and made {levels:2} unsolvable, so the
  implementer's judgement was better than my instruction); MAZE_SEEDS gate;
  dead code removed. 4-level output byte-identical for 50/50 seeds.
  Suite now 34 pass in 39s (was 171s).
Task 5: complete (commits 1cfefff..c3a3783, review clean)
Task 5: minor (deferred): generateTopology({levels:N}).graph.treeEdges is stale -
  reports 1599 (the 4-level tree) when the level-0 tree has 399. Nothing in
  Phase 1 reads it, but it is a wrong number in a public field.
Task 5: minor (deferred): unused `expectedExtraEdgesPerLevel` in
  maze-solvable.test.mjs:95.
Task 5: minor (deferred): two unreachable guards in MazeTopology.js (~line 391
  and ~423) left over from the rebuild.
Task 5: minor (deferred, FLAG FOR FINAL REVIEW): the loop-density test asserts
  only `open.size > 399`, so it would pass with a single extra edge. It does not
  pin the ~10% density it is named for - and zero-loops is a bug we already had
  to fix once in this task.
Task 6: complete (commits c3a3783..a15b01a, review clean)
  Owner's pre-flight ruling honoured: `_gridRange(collider)` extracted and shared
  by _insertToGrid and remove(); reviewer confirmed no residual duplicated maths.
  Stress-verified: 2,000 box + 2,000 mesh colliders, half removed at random,
  0 ghosts and 0 missing survivors. contract-check 38/38, exit 0.
Task 7: complete (commits a15b01a..2ad57e6, review clean, no findings)

Task 8: review NOT APPROVED. Six findings.
  - CRITICAL: all 14 tests vacuous, 13/13 files. Brief's test asserted literal
    `rules.<flag>` but the gates are written `allows(world, 'flag')`, which never
    produces that substring. Implementer resolved it by putting `(rules.X)` in a
    COMMENT above each gate, so the tests pass on comment text. Deleting all
    thirteen gates leaves npm test green - precisely the failure the test existed
    to catch. This is a PLAN DEFECT (my test string) compounded by the wrong
    resolution.
  - Important: Marketplace gate sits above setMarketWorld(id), its only caller in
    the repo, so with merchants:false the maze inherits the PREVIOUS world's
    regional pricing and catalog stock.
  - Important: RaceManager._teardown() never clears _source, so selectTrack() from
    inside the maze re-arms the previous world's circuits.
  - Important: Player.js:255 leaks its world:changed subscription - dispose()
    unsubscribes six handlers but not this one. PLAN DEFECT: my brief's snippet
    had this flaw; Loadout got it right via its own on()/_offs helper.
  - Minor: Loot gate is the last statement of its handler, provably a no-op, so
    rules.loot currently means nothing.
  - Minor: Interiors._ensureRollout() runs before the gate.
  Reviewer verified as already correct (do not disturb): WaterVolumes placement
  before the scan, NPCManager hostiles-only scope, Loadout subscription teardown,
  allows() defaulting to permitted for a null world.
Task 8: fix round 1/5 dispatched.
Task 8: fix round 1/5 (6 addressed, 0 open; commits 1cd0145..c390238)
  Red-check verified TWICE: by the implementer on Caches.js, and independently by
  me on Relics.js (neutralising the gate -> "not ok 3 ... honours relics",
  13 pass / 1 fail). Test is no longer vacuous.
Task 8: complete (commits 2ad57e6..c390238, review clean)
Task 8: minor (deferred): Marketplace decline branch clears _catalog but does not
  bump _catalogSeq, so a refreshCatalog() in flight from the previous world can
  write its stock back after the portal. Fix is `++this._catalogSeq;` before the
  clear. Narrow (needs a portal mid-fetch) but not durable.
Task 8: minor (deferred): stripComments() does not strip string literals, so a
  future `allows(...)` inside a quoted string could satisfy the gate test. No
  such occurrence exists today (verified: exactly one allows( per file).
Task 8: minor (deferred, DECISION NEEDED BEFORE MAZE SHIPS): `inventory:drop`
  (main.js:804) calls loot.spawn() directly and is NOT gated by rules.loot, so a
  player can still drop items in the maze. Probably desirable - flag to owner.
Task 8: minor (deferred): the textual test cannot distinguish a live gate from a
  syntactically-present but dead one. Inherent to the technique.

Task 9: review NOT APPROVED. Two findings.
  - CRITICAL (PLAN DEFECT, mine): the north/west-only hedge emission rule keys its
    south/east fallback on the DISTRICT-local last row/column (lz===D-1), which
    breaks at district seams: district A's last cell and district B's first cell
    both emit a hedge at the identical world position. Reviewer measured a 3x3
    block at seed 1234: 3,953 hedges, 233 exact positional duplicates (5.9%).
    361 internal seam lines per level are affected. Fix: key on the GLOBAL grid
    edge (x/z === MAZE.CELLS-1), not the district-local one.
  - Important: the "open passage has no hedge across it" test has a dead guard,
    only ever exercises East passages (never South), and only looks at district
    (0,0) - so it could never have seen the seam bug. Fix requested plus a NEW
    zero-duplicates test across a multi-district block, with red-then-green
    evidence required.
  Reviewer verified as correct (do not disturb): floor half-cell overhang is a
  genuine 6m overlap between neighbouring districts; hedge half-extents correct;
  cellToWorld consistent with hedge placement; anti-ladder rule holds.
Task 9: fix round 1/5 dispatched.
Task 9: fix round 1/5 (3 addressed, 0 open; commits f77c185..8459108)
  Duplicates 233 -> 0. Verified independently by me on a 6x6 block across 4 seeds:
  0 duplicates in 57,611 hedges. Re-reviewer cross-checked every one of 7,080
  interior cell edges against the topology: 0 missing walls, 0 spurious walls,
  and the true outer boundary still sealed.
Task 9: complete (commits c390238..8459108, review clean)

Task 10: DONE_WITH_CONCERNS - containment gate failed with 8 real escapes.
  Root cause is a PLAN DEFECT in my test harness, NOT a maze defect. MazeColliders
  emits north/west faces only, so a cell's east wall is owned by the cell east of
  it. Building only districts 0..2 leaves the block's far east/south faces owned
  by district 3, which the harness never built - so the fixture is legitimately
  open on two sides and "left the block" is not an escape.
  Implementer root-caused it correctly, proved it by rebuilding with a buffer
  district (0 escapes on the identical seed/maze), and REFUSED to weaken the gate.
  That was the right call and is exactly what the instruction asked for.
  Red-check already banked: breaking the floor overhang turned the SEAM GATE red
  ("hole at district seam x=117 z=357.5"), restored via git checkout.
Task 10: fix round 1/5 dispatched - build a 4x4 district block, launch only from
  the inner 2x2 (cells 20..59). Margin is provable: 100 steps at 8.2 m/s on a
  1/60 timestep = max 13.7 m travel, nearest unowned edge is 120 m away (~9x).
  Also required: a red-check on the CONTAINMENT gate specifically (shrink hedge
  half-extents so walls no longer meet), since a gate that cannot be made to fail
  proves nothing.
Task 10: fix round 1/5 (harness buffer ring; commits f0a2412..da6d55d) - escapes
  went 8 -> 0, BUT the implementer then proved the gate had become VACUOUS: with
  hedges functionally deleted (HALF_CELL=0.01) it still reported zero escapes.
  Cause is my design: all three escape conditions test "did the capsule leave the
  world" (envelope / above hedge / through floor), and the 120m safety margin I
  asked for makes the envelope permanently unreachable. The requirement is "did
  the capsule pass through a wall", which none of them asks.
  Evidence the signal exists: 86/500 launches reached near-max unobstructed
  travel with real hedges vs 469/500 with hedges removed.
  This is the same failure class as Task 8's comment-satisfied tests - a test
  that cannot fail - and it was introduced by MY fix instruction, not by the
  implementer.
Task 10: fix round 2/5 dispatched - add illegal-cell-transition detection as the
  PRIMARY escape condition: on every step, a change of occupied cell must be
  through an OPEN passage bit, Manhattan distance <= 1, no diagonal double-change.
  Soundness argument to be commented in the test: a closed passage puts a 1.2m
  hedge from 2.4m to 3.6m off the cell centre, so a 0.35m-radius capsule resolved
  against it cannot get its centre past 2.05m, which still rounds to the original
  cell - so a cell change across a closed passage is unambiguously a phase-through
  and never a rounding artefact.
  Required: red-check must now BITE (two independent breaks), or the gate is still
  not load-bearing.
Task 10: fix round 2/5 (commits da6d55d..5900a23) - fourth escape condition added.
  Gate now bites: 442/500 escapes with hedges deleted, 224/500 with hedges
  shortened; 0 with correct geometry. Implementer also reported a NEGATIVE result
  honestly (thin-but-full-length walls produce 0 escapes, correct - a discrete
  closest-point solver cannot tunnel 0.137m/step through a 1.2m box).
  Independently verified by me with a harness sharing no code with the committed
  test: 0 illegal transitions on intact geometry, 357/400 with hedges removed.
Task 10: task review APPROVED with one Important finding. Reviewer confirmed the
  soundness argument against Physics.resolveCapsule's actual solver, that the
  previous-cell only advances on a legal transition (so nothing can be masked),
  Manhattan>1 and diagonal double-changes are both escapes, and sampling reaches
  808 distinct cells with a ~50/50 hop/ground split. No production code leaked
  into the commits (git diff -- src/ is empty).
Task 10: fix round 3/5 dispatched - the CORNER-SQUEEZE test is still vacuous: it
  only asserts groundHeight() != null, which the floor slab satisfies with or
  without hedges, so it survives HALF_CELL=0.01. Third instance of the same
  can't-fail failure class (after Task 8's comment-satisfied gates and this
  task's own round-2 envelope conditions). Fix: apply the illegal-transition
  tracking to it too, keep groundHeight as a secondary condition, red-check it.
Task 10: fix round 3/5 (2 addressed, 0 open; commits 5900a23..90bca1c)
  Corner test now carries the same illegal-transition tracking; reviewer ran an
  INDEPENDENT red-check (HALF_CELL=0.01) and observed 1,749 phase-throughs,
  matching the implementer's number exactly, then restored clean. Previous-cell
  confirmed to advance only on a legal transition in BOTH blocks. Seam gate
  deliberately left as a groundHeight check - correct for its narrower purpose
  and already red-checked in round 1; reviewer agreed.
Task 10: complete (commits 8459108..90bca1c, review clean)
Task 10: minor (deferred): with HALF_CELL broken the main gate reports
  "23436 !== 50000 attempts" before reporting escapes - the coverage assertion
  fires first and slightly obscures the more informative escape count.

Task 11: review NOT APPROVED. One Critical, two Important, three Minor.
  - CRITICAL: the player arrives INSIDE a hedge collider. graph.entrance is
    {dx:10,dz:0} and cellOf takes the district centre, so the entrance cell is
    (210,10) - ten cells inside the north edge, not on it - and its N face is
    CLOSED. The portal was placed at ew.z - CELL (z=54), on the far side of the
    hedge at z=57 (box spans 56.4-57.6). arrivalFor then stands the player 2.6m
    in front of the portal at z=56.6, inside that box. Portalling in from the
    station would have materialised the player embedded in a hedge with the exit
    wall-locked behind them. PLAN DEFECT: my MazeWorld snippet assumed the
    entrance cell sat on the maze boundary with an open north face.
  - Important: the portal plinth is an ~8m octagon (PLINTH_TIERS[0].r = 4.15)
    plus ~4.6m approach steps, dropped into a 6m cell with a 4.8m corridor -
    it intersects the surrounding hedges and their colliders.
  - Important: ~11.2 MB VRAM leaked per re-roll. dispose() frees geometry but
    never calls InstancedMesh.dispose(), and in three 0.185.1 the instanceMatrix
    GPU buffer is released only via that dispose event. 175,600 instances x 16
    x 4 bytes, stranded on every entry - and repeated entry is the whole premise.
  - Minor: first entry generates the level twice (Portals.enter builds, then
    _activate's build() sees volatile && _built and regenerates).
  - Minor: build() would gut a live volatile world (disposes unconditionally
    while _activate early-returns on previous === world) -> invisible walls.
    Not reachable today; guard before Phase 2.
  - Minor: crowd exclusion lists do not cover the new gateway at (-54,128).
  Reviewer CONFIRMED correct: atlas is 4x10=40 with 40 entries, original 36
  byte-identical and in order, every pre-existing SIGN_ROLE unchanged; materials
  survive dispose(); jump permitted; centre stack has no collider; the four
  existing gateways render identically (offsetZ ?? 0); scheduleBackgroundBuilds
  skips volatile; Physics.remove() still unused in src/.
Task 11: fix round 1/5 dispatched - build the walled forecourt the spec always
  called for (carve a corridor from the north boundary to the entrance cell,
  18x18m walled forecourt in negative z, portal in the middle with clearance for
  the plinth), which fixes Critical and Important #1 together; plus the
  InstancedMesh dispose leak and a new arrival-point-not-inside-a-collider test.
Task 11: fix round 1/5 (6 addressed, 0 open; commits 772b84a..838caef)
  Forecourt built and verified sealed: 400-launch sprint sweep from inside = 0
  escapes, 0 groundless; 0.5m probe grid over the forecourt and its seam = 0 floor
  holes; forecourt floor (z<=+3) genuinely overlaps district (10,0)'s slab (z=-6).
  Carve opens BOTH sides of every passage - 0 mismatched bits across 5 seeds,
  exactly 1 north-boundary breach per seed, reachability 160,000/160,000,
  entrance->centre solves on all 5 (paths 1331-5915).
  I independently verified the arrival point across 3 re-rolls: portal (1260,-10),
  arrival (1260,-7.4), ground at y=0, containsPoint false at feet AND head, yaw=PI
  (facing +z into the maze), different seed each build.
  InstancedMesh.dispose() now called on both meshes; _materials still survives.
  MAZE_GATEWAY_OFFSET_Z shared by GATEWAY_CENTRES and the gateway spec; both crowd
  checks read it, no hardcoded four-entry array survives.
Task 11: complete (commits 90bca1c..838caef, review clean)
Task 11: minor (deferred): forecourt side walls extend 3m past the boundary hedge
  line, narrowing one in-maze passage from ~4.8m to ~2.4m where that cell face is
  open. Passable at radius 0.35, reads as a hedge stub. Cosmetic.
Task 11: minor (deferred, FLAG FOR FINAL REVIEW): neither the anti-ladder test nor
  the containment gate covers the FORECOURT - both only iterate districtColliders,
  never forecourtColliders. Hand-checked clean today (tops at 0.00 and 5.00), but
  nothing would catch a future regression there.
Task 11: minor (deferred): dropping the pre-emptive build kick means generation
  now starts at 45% of the portal transition, lengthening the first-entry white-out.

FULL GATE: MAZE_SEEDS=1000 npm test -> 82/82 pass, 0 fail, 199.8s. Solvability
  confirmed across 1,000 consecutive seeds as the spec requires.

BROWSER VERIFICATION (controller, Chrome DevTools MCP)
  Maze boots and is walkable: hedges, corridors, path, sky all render correctly.
  Seed 542351615, 161,190 colliders, different seed every re-roll.
  Forecourt + return arch confirmed good: arch renders with a live station
  preview, 16.8m clearance for the 8m plinth, arrival point clear of colliders.
  Gating confirmed live: loot 0, caches 0, relics 0, hostiles 0, vendors 0,
  mounts.summon('horse') -> false, loadout.select() -> false.
  1000-seed gate: 82/82 pass, 199.8s.

  DEFECT FOUND (invisible to the entire headless suite): rules.weapons=false but
  the player still visibly carried a machine gun - viewmodel drawn and weapon
  bar + ammo panel on screen. The gate stopped weapon SWITCHING, not CARRYING.
  My Task 8 plan text said Loadout should "hide the viewmodel and refuse weapon
  selection"; only the second half landed, and every test I wrote checked logic.
  Fixed in 474e3c2. Implementer also corrected MY misidentification of the HUD
  element: I reported class `attack-weapon` off a loose [class*="weapon"]
  selector; the real weapon bar is WeaponWheel's `wstrip`.

  Re-verified after fix - REAL PLAYER PATH IS CORRECT:
    boot station -> ['machinegun'] | portal to maze -> [] | back to station ->
    ['machinegun']. Reversibility holds.
  Residual (dev path only): booting directly with ?world=maze leaves fireball,
  bow and sword visible, because main.js prewarm's restore `loadout.select(sel)`
  is defeated by the gate, and the corrupted state then follows the player into
  other worlds. Fix dispatched: make the forbidden state authoritative over ALL
  instances rather than just `current`, and stop the prewarm restore being
  silently defeated.
  Weapons residual FIXED (671fe31). Re-verified by me in the browser on the dev
  path: boot ?world=maze -> [], activate station -> ['machinegun'], back to maze
  -> []. Implementer chose "the gate's early return also hides everything" over a
  prewarm bypass, and correctly DECLINED to add a regression test - they verified
  (not assumed) that constructing a real Loadout throws "document is not defined"
  under Node via Weapon's canvas material setup, so the scene-graph defect is
  unreachable from a Node test and a textual test would have passed against the
  insufficient code too. Right call, honestly reported.
  Screenshot confirms a clean maze: no viewmodel, no weapon bar, hedges/corridor/
  path/sky all correct.
  Remaining cosmetic: one unplanned LOREKEEPER NPC in the maze (NPCs are Phase 4).

FINAL WHOLE-BRANCH REVIEW: MERGE AFTER FIXES. Nothing Critical. No spec violation,
  no regression to the four existing worlds (each risky edit checked individually,
  not inherited from per-task reviews).
FINAL FIX WAVE: complete (commit 4a8ea17). All 7 items addressed and independently
  re-verified. 85/85 tests, contract-check 42/42, build clean. Verdict: MERGE.

PARKED (not fixed, ruling recorded):
- The loop-density threshold `open.size > 419` is deterministic today because the
  test hardcodes seed 42 (which yields 432, margin 13). But across 200 seeds the
  real extra-edge range is 18-52, and seed 1 alone yields 417 - BELOW the
  threshold. So the comment's justification (citing 26/32/33/37) undersells the
  variance, and the test would fail spuriously if anyone changed the seed.
  RULING: not load-bearing - the test is deterministic as written and it does now
  catch the near-zero-loops regression it exists for. Parked rather than opening a
  second fix wave. Phase 2 should either loop several seeds and assert a floor
  across all of them, or assert a ratio of non-tree candidates rather than an
  absolute count. Flagged to the owner.

CARRIED TO PHASE 2 (from the final review's cross-cutting section):
- Important: MazeTopology's `levels < MAZE.LEVELS` path re-implements the DFS and
  the extra-edge pass with a level filter bolted on - ~50 near-identical lines,
  two RNG draw orders that must stay in lockstep, two different districtNeighbours
  iteration conventions. Both `treeEdges` and the loop-density bugs were direct
  consequences. Phase 2 turns `levels` on and edits exactly this code; it should
  first collapse both walks into one parameterised by a levelLimit.
- rules.jump is declared and documented but has no consumer (grep finds only the
  keybind). Harmless - always true - but nothing enforces it.
