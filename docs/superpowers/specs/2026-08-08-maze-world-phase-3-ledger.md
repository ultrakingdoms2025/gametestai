# SDD ledger — plan: docs/superpowers/plans/2026-08-08-maze-world-phase-3-map-and-exit.md

Branch: maze-phase-3 (branched from maze-phase-2c at f8e5ee4)

## Tasks

1. The plan cache key, and the re-roll bug it hides
2. One `map` action, two consumers
3. `MazeMap.js` — the level you are standing in
4. Hold `L` to leave
5. The centre pays, and opens a way home
6. Prove it in the browser

## Progress

Task 1: complete (e0d53ac). `planCacheKey` asks the world what makes its plan
  unique; `Minimap` no longer knows what a maze is. `MazeWorld` answers with
  seed AND level. `levelSegments` moved the walls-from-cells derivation into a
  pure module so both map surfaces share one definition and it is assertable
  under Node. Two tests in opposite directions, because an off-by-one in the
  ownership rule would pass either alone. Red confirmed by stubbing the key
  back to `world.id`.

Task 2: complete (6e863e3). The owner chose a contextual `M`. I had flagged
  that a context-dependent key is awkward to rebind, so: one `map` action in
  `BINDABLE`, one exported `mapActionOwner` both consumers import. It cannot
  disagree with itself, and it keys off `rules.mounts` rather than a world id.
  `MountWheel` was not rules-gated at all before this - `M` opened a mount
  wheel in the maze whose only possible answer was "restricted here".

Task 3: complete (ac230a9). `MazeMap` bakes one level per seed-and-level and
  pans/zooms it as an image. Two grep tests enforce the no-marker rule (on
  comment-stripped source) and the no-geometry rule.
  `Input.codeFor(action)` added because both consumers own their own keydown
  listener - they must keep working when `Input` has stopped reporting - and
  without it they would hard-code `KeyM` and silently ignore a rebind, making
  Task 2's claim FALSE. A test now asserts both resolve through it.
  Also removed `M` from `KeybindMenu`'s `FIXED_KEYS`: it had become bindable,
  so the panel was about to list it twice and claim it could not be changed.

Task 4: complete (cef985c). `AbandonHold` is pure timing: fires once at two
  seconds, a release resets completely so a fumble cannot be topped up, and a
  fresh hold works after firing so re-entering needs no reload.
  `Input.held(code)` added beside `pressed(code)` - "was it struck this frame"
  is the right question for an action and the wrong one for a hold.
  MY FIRST PASS wired progress to `hud.setHoldProgress`, WHICH DID NOT EXIST;
  the optional call hid it. A two-second hold with no feedback is
  indistinguishable from a dead key, so the indicator is now real.

Task 5: complete (7fd55f7). 100 credits, once, unscaled. The portal OPENS on
  collection rather than existing - a portal at the centre from the start is a
  way to skip the maze for anyone who happens to arrive there, which in a maze
  that re-rolls is what a lucky route is. Guarded on `_centreTaken` because the
  radius is tested every frame. The portal follows the centre's LEVEL, with a
  test that sweeps seeds until it has seen a centre above level 0.

Task 6: complete. BROWSER VERIFICATION, Chrome DevTools MCP against `?dev=1`.

  THE MAP WAS UNREADABLE ON FIRST LOOK, and only looking found it. The spec
  suggested 2 px/cell; a 800 px image in a ~600 px panel puts a cell under
  1.5 px and 160,000 walls merge into green noise. Every test passed - they
  assert the DATA, and the data was right. Now baked at 4 px/cell and opened at
  junction scale (90 cells across) rather than fitted, with zoom-out to the
  whole level as the floor. Confirmed readable: individual corridors,
  junctions, and the district grid visible as longer runs.

  MEASURED:
  - THE RE-ROLL FIX, in the real app rather than only in a unit test: two
    entries gave seeds 2780482684 and 2897909701, plan keys `maze:...:0` that
    differ, and the map's rendered bytes differed - it genuinely redrew.
  - Hold-L: indicator shows during the hold; a 900 ms fumble leaves the player
    in the maze; a full hold returns them to the station.
  - The centre: 0 -> 100 credits, one portal opened at y=18 (its own level 2,
    not the ground floor), stack hidden. Called three times, still 100 and
    still one portal.
  - Shader programs across eight entries WITH the map opened and closed each
    time (a 1600 px bake per open): 383, growth 0.
  - Zero console errors throughout.

Task 6: the centre could not be reached by teleporting 1,200 m in 14 hops -
  streaming cannot keep up and the player falls, is caught by `Unstuck` and
  returned to spawn. That is the Phase 2c `Unstuck` fix working as intended,
  seen from the other side. The radius logic is unit-tested; the browser check
  targeted the `main.js` wiring instead, which is the part only a browser can
  show.
