# What a world crossing costs, measured

*perf-collider-rebuild, 24 Aug 2026. Every number here is from the PRODUCTION
bundle — `node scripts/frame-gaps.mjs --serve prod`, the hashed assets the site
serves.*

## The brief, and why it was wrong

This branch was handed one failing criterion — *"in production, no frame gap
over 250 ms on … repeated entry/exit"* — and one diagnosis:

> Repeated entry/exit still fails, and no longer for shader reasons — 0–1
> programs per crossing and **~1,617 ms of collider-rebuild JavaScript**:
> `physics.clear()` followed by re-adding every collider. The station has
> **26,345 colliders**.

The collider count is right. The attribution is wrong by two orders of
magnitude. Entering the station from medieval, on the production bundle:

| step | ms |
| --- | ---: |
| `changing` (the `world:changing` emit) | 0.2 |
| `teardown` (portals, NPCs, old group out) | 1.3 |
| `physicsClear` | **0.0** |
| `physicsAdd` — 26,345 `add()` calls, 234,341 broadphase writes | **7.8** |
| `sceneIn` | 0.3 |
| `portals` | 0.9 |
| `arrival` | 0.0 |
| `npcs` | **420.2** |
| `changed` (the `world:changed` fan-out) | **844.6** |
| **total** | **1275.3** |

`physics.clear()` plus re-adding every collider is **0.6% of the crossing**.

This is the same shape of error the previous branch disproved for itself —
"the citadel's 350 geometry uploads cost 5 ms of a 783 ms frame" — except that
this time the hypothesis arrived as a premise rather than as a hunch.

## How the numbers were made stable

Wall clock on this machine is not trustworthy: the chain's own notes record
identical work measured at 700 ms and at 14,733 ms, and a run in this branch
produced an 11,183 ms "gap" whose 4 ms heartbeat ticked 2,750 times through it
— the main thread was free and the compositor simply stopped, which
`[harness] no animation frame for 10000ms` says in the log. So two instruments,
one exact and one timed:

**`Physics.gridWrites`** — one increment per (collider, cell) pair pushed into
the broadphase, for the lifetime of the instance. Across every crossing
measured, in four separate runs:

```
into station    234,341 writes    every time
into medieval    33,992 writes    every time
```

Exactly reproducible. The work is identical on every crossing, so the 7.8 ms is
not a lucky sample — there is no larger number hiding behind timing noise.

**`WorldManager.activationCost`** — the crossing broken into named steps. The
labels are string constants, so they survive minification and can be read off
the shipping bundle, which a CPU profile cannot: the production profile's table
reads `ya`, `wU`, `mt`. Its `total` accounts for the whole rAF gap the gate
records (1,204 ms recorded against the 1,366 ms gap that also contains the
frame's own render).

A third instrument, `--listeners`, times each `world:changed` closure. Property
names survive minification even though locals do not, so a minified handler
still reads `({id:e,world:t})=>this._onWorld(e,t)` and names its own subsystem.

**Do not use `--profile` on the production bundle to size anything.** The
sampling profiler inflates the crossing it measures: the profiled repeat pair
recorded 6,050 ms and 11,450 ms blocked gaps where the unprofiled pair right
after it recorded 450 ms and 1,366 ms, and its table charged 15.5 seconds to
`getProgramInfoLog` and `getShaderInfoLog` in a window whose `dPrograms` was 0.
It is useful for the SHAPE of the work and worthless for its size.

## Where the 1,275 ms actually goes

`--listeners` says one closure spends 2,786.7 ms of the 2,814 ms of
`world:changed` across six crossings. Five subsystems register the identical
shape, so the subsystem autopsy calls each rebuild again by name, on the live
station, and times it:

| what | ms |
| --- | ---: |
| `caches._onWorld` | **813.8** |
| `npcManager.spawnForWorld` | **421.2** |
| `relics._onWorld` | 1.4 |
| `waterVolumes.rebuildFromWorld` | 0.7 |
| `loot._onWorld` | 0.1 |
| the collider rebuild | 7.8 |

Two subsystems are 97% of the crossing.

### `Caches._onWorld` — 813.8 ms, and eleven raycasts of it

`src/systems/Caches.js`. The station's content box is 1,488 m across, so
`highWanted` saturates at 12, and each of the twelve is found by darting:
`TRIES = 120` uniform darts at the box, each dart running `_highAt` — a 640 m
vertical `Physics.raycast`, then eight ring probes at 220 m, then
`_hasVisibleFloor`, which is a `THREE.Raycaster` against the ENTIRE world
group, then six more probes.

Wrapping both probe kinds separately splits it cleanly, and the split is not
where anyone would have guessed:

| | ms | calls | each |
| --- | ---: | ---: | ---: |
| `Physics.raycast` (this repository's broadphase) | **43.4** | 12,256 | 3.5 µs |
| `Caches._hasVisibleFloor` (`THREE.Raycaster`) | **766.6** | **11** | **69.7 ms** |

Twelve thousand physics raycasts cost 43 ms. **Eleven** render-tree raycasts
cost 766 ms — 60% of the whole crossing. `THREE.Raycaster.intersectObject`
has no spatial index: each call walks every mesh under the station's group,
and the station is the biggest render tree in the game.

The collision side of this file is not the problem and neither is the dart
budget. One call is 70 ms.

Worse, the placement is seeded — `mulberry(hashString('cache:' + id))` — and
probed against colliders that did not change, so **every crossing recomputes
the same answer**. This is exactly the shape the brief predicted for colliders
— a world already visited rebuilding from nothing — landed one subsystem over.

### `NPCManager.spawnForWorld` — 421 ms

`src/npc/`. `CharacterAssets.geoCache` is holder-counted: the last release of a
key disposes the geometry. Leaving a world disposes its whole cast, so
re-entering lofts, welds, skins and merges every body again. The counting is
deliberate and correct — `scripts/tests/character-geometry-cache.test.mjs`
records that the previous unbounded cache grew 807 → 1,177 geometries over ten
world entries — but "correct" here means "frees everything", and freeing
everything is what a re-entry pays for.

## What was and was not done

**Not taken: the retained collider set.** It would save 7.8 ms of 1,275, at the
cost of a structure that can go stale in the two ways that matter — a collider
that outlives its world is an invisible wall, one that is dropped is a hole in
the floor — in a repository with four shipped defects of exactly that class. It
is not worth the risk it carries, and it does not move the criterion.

`scripts/tests/world-crossing.test.mjs` is the gate that keeps that refusal
honest. It asserts what must be true after entering a world twice, against the
capsule and the ground probe rather than against an array length, and both
directions of staleness were injected to prove it bites: never releasing the
departed set fails 4 of 8 including *"a wall that stopped the player before the
crossing stops them after it"*; losing one collider in seven fails 2 of 8
including *"the floor is still under the player on re-entry"*.

**Not taken here, and what they would cost.** Both live outside this branch's
file boundary (`src/physics/**`, `src/worlds/WorldManager.js`, `src/gfx/**`,
`scripts/**`), and both are worth dispatching:

*Stop re-darting the caches* — `src/systems/Caches.js`, worth ~814 ms of the
station crossing and the same again on first entry. Two independent fixes, and
the cheaper one is bigger:

  1. `_hasVisibleFloor` at 69.7 ms a call is the whole cost. It raycasts
     `worldManager.active.group` with `far = 8` from three metres above a point
     physics has already resolved, purely to tell a real deck from an invisible
     boundary collider. Anything that narrows the tree it walks — a dedicated
     `THREE.Layer` on visible floor geometry, a broadphase-backed test, or
     simply not asking the question a second time for a world already resolved
     — takes 766 ms out of the crossing without touching the placement rules.
  2. The placement is deterministic per world id. Keeping the resolved site
     list across a crossing removes the remaining 47 ms and the 12,256 physics
     raycasts with it. It has to be invalidated when the world is rebuilt
     (volatile worlds) and when its colliders move (the map editor's
     `_moveColliders`).

  The correctness risk on (2) is the one the file's own comments are full of: a
  stale site is a cache floating in the sky or sealed under a roof, and the
  `[Caches]` log line only prints when something landed, so a wrong answer is
  silent. A gate would have to assert reachability, not placement.

*Retain character geometry across a crossing* — `src/npc/Humanoid.js`, worth
~421 ms. The change is an eviction policy where today there is none: a bounded
cache of released-but-unfreed keys instead of dispose-on-last-release. The risk
is the leak that holder counting was introduced to fix, so the bound is the
whole design and it needs a memory gate, not just a timing one.

*Slice the crossing across frames* — considered and refused on an ordering
hazard rather than on cost. The criterion is about frame GAPS, so yielding
between the expensive steps would satisfy it without making anything faster.
But no rendered frame may fall between `scene.add(world.group)` and the
`world:changed` handler that runs `lightRig.claim` and `applyEnvironment`: the
first would put dozens of world lights into `projectObject` and the second
would compile the arriving world under the DEPARTING world's fog and
environment, both of which re-link the program set this phase has spent three
branches driving to zero. Slicing therefore requires splitting `world:changed`
into an environment half and a rest half — a change to the event catalogue in
CONTRACTS.md, not a change to `WorldManager`.

## What the criterion would read if both were taken

1,275 − 814 − 421 = **40 ms**, against a 250 ms budget, with the collider
rebuild's 7.8 ms still in it and still not worth removing.

## Reading it yourself

```
node scripts/frame-gaps.mjs --serve prod --events repeat                  # the gate
node scripts/frame-gaps.mjs --serve prod --events repeat --listeners      # + per-listener and the autopsy
```

`activationCost` is on `window.GAME.worldManager.activationCost` after any
crossing, on any build. `warm.programs` is 151 before and after everything in
this branch.
