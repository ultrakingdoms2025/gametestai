# SDD ledger — plan: docs/superpowers/plans/2026-08-09-maze-world-phase-5-art.md

Branch: maze-phase-5-art (branched from maze-phase-4 at ba4d126)

## The finding the phase is built on

`LightRig` owns a FIXED set of slot lights. Every other light in the scene is a
SOURCE: `_walk` runs each frame, hides what it finds, and copies the
best-scoring few into the slots. The counts baked into every shader cache key
are therefore constant however many lights a world authors — the station
authors 65.

**Three commits in Phases 2b and 2c say the opposite.** They claim a per-shaft
lamp is impossible because "a changing light count is what cost 250 s of shader
recompilation", and gave the shafts emissive treads on that basis. That was a
misreading of the file. The emissive treads were still a reasonable answer, but
the REASON was wrong, and it ruled out the fix for the maze's biggest visual
problem: levels 0–2 are roofed by the floor above and were simply dark.

Verified rather than argued: **385 programs, flat across ten warm entries,
growth 0, with 43 light sources of which the rig uses 2 point slots.**

## Progress

Task 1: complete (d16e802, fixed in c7160b5). One authored point light per
  resident district, created HIDDEN — the rig would hide it anyway but not
  until its next walk, and a light visible for one frame is a light that can
  compile. Disposed with its district: a walk across the maze evicts one every
  120 m, and a leaked light is a source the rig scores forever.

Task 1: I COMMITTED WITH A RED TEST. The lantern broke `a long walk leaves no
  orphaned colliders or buckets`, which asserted
  `group.children.length <= residentKeys * 2` — "hedges and a floor per
  district". That bound was already loose once stairs, shaft walls, lifts and
  tunnels gained mesh kinds, and a lantern broke it outright.
  Fixed by making the check EXACT rather than loosening it: `objectCount()` is
  what `MazeChunks` believes it owns, against what it actually put in the
  scene, and a leak is those two disagreeing. Strictly tighter than the bound
  it replaces — which matters, because relaxing a bound to fit new geometry is
  the move this project keeps having to catch.
  Mutation-verified: removing the lantern eviction reddens THREE tests.

Task 2: complete (9c76210). Generated colour maps on the two cached materials,
  built once with the material set.
  COLOUR MAPS ONLY: `makeNormalFromHeight` takes a Float32Array HEIGHT FIELD,
  not a texture, and there is no exported helper that hands one back from
  `makeNoiseTexture`. My first pass fed it a `DataTexture`, which would have
  compiled and produced garbage. Recorded in the code as worth revisiting with
  a real height field rather than quietly dropped.
  Tuned against a screenshot rather than intuition: the first ramp came out
  DARKER than the flat colour it replaced, because a noise ramp's low end sets
  the average. A textured hedge that reads as black is not an improvement.
  I also broke and restored the `stair` material: the slice that replaced the
  map block took `const stair` with it and 17 tests went red with "stair is not
  defined".

Task 3: complete. Foliage sprigs along hedge tops and a weathered stone band at
  every hedge base.
  BOTH ARE MESH ONLY, and the collider count proves it: 8,577 before, 8,626
  after, i.e. unchanged within the noise of which districts happen to be
  resident. Foliage sits in the 0.45–5.0 m band where section 2 permits a prop
  only if it is non-collidable, and THE NON-COLLIDABLE GATE asserts no
  `foliage` or `footing` descriptor ever reaches `districtColliders`.
  The footing matches the hedge footprint exactly rather than standing proud: a
  proud plinth would need its own colliders, and at roughly two per cell that
  is tens of thousands of new colliders for decoration.
  Guard rails do not sprout foliage — they are `hedge`-kinded too and are
  waist-high furniture. Asserted, because a rail with a bush on it reads as a
  bug.

## Browser verification

- **Shader programs 385, FLAT across ten warm entries, growth 0.** The phase's
  central risk, and the thing the whole premise rested on.
- Frame time while walking: **p50 6.7 ms, p95 8.6 ms**.
- Draw calls 244 → 315 with the dressing; colliders unchanged.
- 43 light sources, 2 point slots used. Zero console errors.
- A corridor at ground level now reads as a hedge maze: lit depth, leafy walls,
  a stone band at the base, an earth floor, and a lit opening in the distance.
  Before this phase the same view was near-black flat boxes.

285 tests, MAZE_SEEDS=1000 green in 168 s, contract-check clean, build clean.

## Still open

- §10's god-rays and drifting pollen — post-processing and particles, deferred.
- Ivy on the tower shafts.
- The ~1.2 m² of well-floor daylight per shaft, from 2b's ledger. A geometry
  fix, not an art one.
- Phase 4's gate and sliding-wall GEOMETRY. Placement and the never-strand
  proof are done and mutation-verified (ba4d126); the moving parts are not.
