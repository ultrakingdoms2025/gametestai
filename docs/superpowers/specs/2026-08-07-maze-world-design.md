# The Verdant Coil — maze world design

**Date:** 2026-08-07
**Status:** approved, ready for planning
**Target:** a sixth world in AETHER NEXUS, reached by portal from the station

---

## 1. Intent

A navigation-and-puzzle world with no combat, no economy loop and no quests. The
player walks into a vast three-dimensional hedge maze, and the only objective is
to reach the centre. The maze re-rolls its layout on every entry, so it cannot be
learned — only read.

Reference points: **The Witness** and **Antichamber** for the posture of the
space (silent, deliberate, unexplained), **Monument Valley** for the mechanical
puzzles, **Temple Run** only for the sense of forward committal — there is no
chase and no fail state.

### Hard constraints

| Constraint | Resolution |
|---|---|
| Maze only — no quest manager, no merchant | World-rules layer, §5 |
| NPCs for chat only | Keeper + wanderers, §9 |
| No weapons, no mounts | World-rules layer, §5 |
| Climbing disabled | `rules.climb = false`, `rules.parkour = false` |
| Player sticks to the path | Anti-exploit rule, §2; containment probe, §12 |
| Re-rolls every load | Volatile world + worker topology, §3, §4 |
| Many hours to walk | 2.4 km × 2.4 km × 4 levels, §2 |
| Credits at the centre | 100 credits, §6 |
| Full map at the start | `M` key, level-local, §7 |
| Minimap as in other worlds | Existing minimap, bitmap plan, §7 |

### Decisions taken during design

- **Scale:** 400×400 cells × 4 levels (the largest option considered).
- **Re-roll timing:** every portal entry.
- **Verticality:** ramps and spiral stairs, tunnels under the hedges, and lifts.
  Tower-to-tower bridges were considered and dropped.
- **Puzzles:** mechanical only. No non-Euclidean or perspective illusions.
- **Map:** carryable, level-local, **no you-are-here marker**.
- **Threat:** none. No chase, no death, no timer.
- **NPCs:** lost wanderers plus a single keeper at the entrance.
- **Centre:** collect, then a return portal opens there.
- **Topology:** mostly perfect maze (spanning tree) with ~10% extra edges.
- **Levels:** four stacked full levels with sparse vertical connections.
- **Art:** overgrown stone garden.
- **Jump:** retained as a hop that clears nothing.
- **Entry budget:** under 3 seconds.
- **Reward:** 100 credits. Final.
- **Abandon:** required from anywhere in the maze.

---

## 2. Dimensions and the anti-exploit rule

Derived from `src/core/Config.js`: `jumpVelocity 6.4`, `gravity -22`, so a hop
apexes at `6.4² / (2 × 22)` = **0.93 m**. `stepHeight 0.45` auto-steps anything
shorter. Because the hop is retained, 0.93 m is a hard constraint on all
geometry.

| Quantity | Value |
|---|---|
| Cell pitch | 6.0 m |
| Corridor width | 4.8 m |
| Hedge thickness | 1.2 m |
| Hedge height | 5.0 m (5.4× hop height) |
| Grid | 400 × 400 cells × 4 levels = 640,000 cells |
| Footprint | 2.4 km × 2.4 km |
| District | 20 × 20 cells = 120 m × 120 m |
| Districts | 20 × 20 per level × 4 levels = 1,600 |

**The anti-exploit rule.** No collidable surface in the maze may present a
standable top between **0.45 m and 5.0 m** within 2 m of any hedge or wall.
Below 0.45 m the capsule auto-steps it and it is harmless; above 5.0 m it is out
of reach even from a hop off another surface. Anything in the band is a ladder
over a hedge.

Props in that band must be one of:
- non-collidable (foliage, decals, hanging ivy),
- sloped steeply enough that the capsule slides off,
- or placed in a dead end at least 2 m clear of every wall.

This is enforced by a static scan, not by review — see §12, prop-ladder probe.

**Corridor safety.** At sprint (8.2 m/s) and a 60 Hz fixed step the player moves
0.137 m per step against a 1.2 m hedge, so tunnelling through a wall is not a
risk from speed alone. Wall colliders overlap slightly at junctions so there is
no seam to squeeze through.

---

## 3. Generation

Topology is cheap and geometry is expensive, and separating them is what makes
the scale and the re-roll compatible.

### Tier 1 — district graph

1,600 nodes (20 × 20 districts × 4 levels). Build a spanning tree over them,
then add extra edges until ~10% of possible edges beyond the tree are open. The
tree guarantees the entrance→centre route exists; the extra edges create loops
and genuine route choice. Vertical edges — stairs, tunnels, lifts — are a
restricted subset, kept sparse so finding the centre is a 3D problem.

Generating 1,600 nodes takes under a millisecond.

### Tier 2 — district interiors

Each district's 400 cells are carved from `hash(seed, dx, dy, level)` alone.
Doorway positions on a shared border derive from the **edge** hash, so two
neighbouring districts agree on their openings without either one having been
generated. That independence is precisely what makes streaming possible.

### The topology array

The full 640,000 cells are generated in a Web Worker as a `Uint8Array` — one
byte of wall bits per cell, **640 KB** total, roughly 300 ms. This array is the
re-roll. It is the single source of truth for:

- the `M` map and the minimap bitmap,
- lift, stair and tunnel placement,
- NPC routing,
- the solvability and reachability probes.

Geometry is never consulted for any of them.

---

## 4. Streaming

The district is the chunk unit.

**Full detail** — geometry and colliders — is built for the 5×5 district
neighbourhood around the player and torn down beyond it. At most 25 districts
resident, roughly 10,000 hedge segments, instanced per chunk.

**Canopy LOD** — flat instanced hedge-tops with no colliders — renders out to
~8 districts when the player is elevated. At ground level, 5 m hedges in 4.8 m
corridors occlude nearly everything, so the visible set is tiny; towers are the
only thing that breaks it, and the canopy is what makes a tower vantage worth
the stairs.

**Budget.** Crossing a district at sprint takes 14.6 s against a sub-second
chunk build, so streaming has ample headroom.

**Entry.** Worker topology (~300 ms) plus the 3×3 districts around the entrance,
then control is handed to the player and the rest streams in. Inside the 3 s
budget.

**Seam safety.** Each district's floor extends half a cell past its border and
overlaps its neighbour. A chunk boundary must never be a hole.

### Two engine changes this forces

**`Physics.remove(collider)`** — does not exist. `src/physics/Physics.js` has
`add()` and `clear()` only. Removal must unhook from the spatial grid
(`_insertToGrid`, ~line 434) as well as the collider array. Streaming is
impossible without it.

**Volatile worlds in `WorldManager`** — worlds are built once and cached
(`build()`, ~line 161), and every non-start world is pre-built and shader-warmed
during boot. `MazeWorld` opts in with `static volatile = true`, which:

- re-runs generation on each activation rather than serving the cache,
- is excluded from `scheduleBackgroundBuilds` (no point pre-building a layout
  that will be thrown away),
- **reuses its material set across re-rolls.** This is not optional. Shader
  compilation already dominates cold boot in this project; a maze that allocated
  fresh materials each entry would re-trigger it on every single entry.

---

## 5. The world-rules layer

No per-world gating exists today. `Loot`, `Caches`, `Relics`, `Contracts`,
`Marketplace`, `QuestSystem`, `Interiors`, `RaceManager` and `MountManager` all
react to `world:changed` unconditionally and would populate the maze.

New `src/worlds/WorldRules.js` defines the defaults. `World` gains a `rules`
object with everything permitted; `MazeWorld` overrides:

```js
rules = {
  weapons: false,   mounts: false,    climb: false,     parkour: false,
  merchants: false, quests: false,    contracts: false, caches: false,
  relics: false,    loot: false,      races: false,     interiors: false,
  hostiles: false,  swim: false,      jump: true,
}
```

`jump: true` is deliberate and worth stating plainly: **the hop is retained**.
Space still works and still lifts the player 0.93 m; it simply never clears
anything, because §2 guarantees nothing standable exists in the band it can
reach. Disabling climbing does not disable jumping.

`swim: false` means `WaterVolumes` does not scan this world. There is no water
in the maze; the flag stops a pointless per-entry geometry sweep.

Retained: sprint and stamina, chat, inventory, character menu, minimap,
cosmetics.

**Enforcement is deliberately boring.** Every one of those systems already has a
`world:changed` handler, so each gets a **one-line early return** against
`world.rules`. A dozen one-line edits are safer and far more traceable than one
central interceptor that fails somewhere nobody can find.

The exact set of gated systems:

| File | Gate |
|---|---|
| `systems/Loot.js` | `rules.loot` |
| `systems/Caches.js` | `rules.caches` |
| `systems/Relics.js` | `rules.relics` |
| `systems/Contracts.js` | `rules.contracts` |
| `systems/Marketplace.js` | `rules.merchants` |
| `systems/QuestSystem.js` | `rules.quests` |
| `systems/Interiors.js` | `rules.interiors` |
| `race/RaceManager.js` | `rules.races` |
| `systems/WaterVolumes.js` | `rules.swim` |
| `npc/NPCManager.js` | `rules.hostiles` (suppresses hostile spawns only) |
| `mounts/MountManager.js` | `rules.mounts` — refuses `summon()`; the mount wheel reports the world as restricted |
| `player/Loadout.js` | `rules.weapons` — hides the viewmodel, refuses selection |
| `player/Player.js` | `rules.climb` / `rules.parkour` — skips `Climb`, `FreeClimb` and `Parkour` entirely |

---

## 6. Entry, exit, abandon and the centre

**Station.** A fifth gateway arch. The station has four today — two on the Z
axis (`StationWorld.js` ~line 5330) and two on X via `_buildAxisGateway`. The
maze takes a diagonal plinth on the gateway deck, with its own accent colour.

**Entrance.** The player arrives in a walled forecourt with the return arch
behind them, the keeper NPC present, and a clear view of the first junction.

**Leaving by walking out.** Walking back through the entrance arch returns the
player to the station and abandons the run.

**Abandoning from anywhere.** A player 4 km deep must not be stranded. Hold `L`
for 2 seconds — a hold, so it cannot be fumbled mid-run — to return to the
station. The pause overlay carries the same action as a confirmed button. The
next entry rolls a fresh maze.

**The centre.** A stack of credits worth **100 credits**, awarded through the
existing `Economy`. On collection a return portal opens at the centre, so the
walk out is not forced. **100 is final** — it is not a placeholder, and the
reward is deliberately not scaled by maze size or completion time.

---

## 7. The map and the minimap

**The map — `src/ui/MazeMap.js`, bound to `M`.** Renders the **current level
only**, drawn from the topology array. 400×400 cells at 2 px/cell is an 800×800
canvas, drawn once per level and cached. Pan and zoom with the mouse.

**No you-are-here marker.** The player gets the shape of the level and must
locate themselves by matching the junction pattern around them against the
drawing. This is the central navigational challenge and the reason the map does
not trivialise a maze this size.

`M` is added to the `BINDINGS` table in `src/core/Input.js` (~line 44) as a
`map` action, which inherits the existing rebinding UI for free.

**The minimap** behaves exactly as in other worlds, with two changes:

- the floorplan comes from a maze-supplied baked bitmap rather than thousands of
  `minimapShapes` entries, which the current model cannot carry;
- `Minimap._bakePlan` caches by `world.id` (~line 205) and must be re-keyed on
  `world.id + seed`, or a re-rolled maze serves the previous run's floorplan.

---

## 8. Puzzles

Mechanical only — real geometry, solvable with the existing physics. Puzzles are
placed on district-graph **edges**, so a puzzle gates passage rather than
decorating a corridor. Density is roughly one per 6–8 districts, weighted onto
the solution path. **Density is a guess until the maze is walkable and is
expected to change.**

| Mechanism | Behaviour |
|---|---|
| Counterweight lift | Carries the player one level up; the primary vertical connector |
| Rotating bridge | A lever turns a span to bridge a different gap |
| Sliding hedge wall | A pressure plate opens a wall elsewhere in sight |
| One-way gate | Shuts behind the player; a committal, not a trap — the graph guarantees an onward route |
| Lever staircase | Assembles a stair from separated treads |

Moving platforms reuse a proven path rather than inventing one:
`Physics.setBoxColliderY` already exists, and the station's travelators and
escalators already carry the player.

**One-way gates must never strand a player.** The district graph is validated
after gate placement to confirm the entrance→centre route and an abandon route
survive every gate closure. Combined with hold-`L` abandon, there is no
reachable stranded state.

---

## 9. NPCs and atmosphere

**One keeper** in the entrance forecourt. Explains the maze, the map and the
abandon control. Chat-only.

**Eight lost wanderers**, capped. Spawned only within loaded districts and
routed along the topology graph. They have been in here a long time. Chat-only.

Both use the existing `NPCManager` and AI chat path. `hostiles: false` means
nothing hunts them or the player.

---

## 10. Art direction

Overgrown stone garden. Five-metre hedges over weathered stone footings, moss,
ivy-clad tower shafts, mossy vaulted tunnels, drifting pollen in god-rays.

Hedge foliage is instanced per chunk with a wind vertex shader. The polygon
budget goes into foliage density and into tower and stair stonework — the
surfaces the player actually reads — and not into geometry buried inside hedge
volumes that can never be seen.

---

## 11. File layout

New:

```
src/worlds/MazeWorld.js              world shell, environment, spawn, portal specs
src/worlds/maze/MazeTopology.js      district graph + interior carve (pure, testable)
src/worlds/maze/maze-worker.js       worker wrapper → Uint8Array
src/worlds/maze/MazeChunks.js        streaming: build/tear districts
src/worlds/maze/MazeGeometry.js      hedge/stone/tunnel/tower/stair instancing
src/worlds/maze/MazeProps.js         lifts, bridges, plates, gates
src/worlds/maze/MazeCanopy.js        distant LOD
src/worlds/WorldRules.js             rule defaults + merge
src/ui/MazeMap.js                    the M-key map
src/ui/maze-map.css                  its styles
src/dev/MazeProbes.js                in-browser probes (entry time, shaders, frame time)
scripts/tests/*.test.mjs             headless correctness probes (node --test)
```

Edited:

```
src/physics/Physics.js               add remove(collider)
src/worlds/WorldManager.js           volatile-world path
src/worlds/World.js                  rules field
src/core/Input.js                    map binding
src/ui/Minimap.js                    cache key + bitmap plan
src/main.js                          register MazeWorld
src/worlds/StationWorld.js           fifth gateway
+ the thirteen one-line rule gates enumerated in §5
```

Two structural requirements that exist to keep §12's headless tier possible, and
which must not be traded away for convenience:

- **`MazeTopology.js` is pure functions over a seed** — no THREE, no DOM. That is
  what lets the solvability probe run a thousand seeds in a second.
- **`MazeChunks.js` emits collider descriptors separately from meshes.** The
  chunk builder produces a plain array of `{ center, halfExtents, rotationY }`
  which the browser turns into physics colliders alongside meshes, and which
  Node consumes on its own to assemble a collision world with no renderer. If
  colliders are only ever derived from built meshes, the containment, seam and
  prop-ladder gates all become browser-bound and slow.

---

## 12. Verification

### Two tiers, and why

This project has no test framework, deliberately: as `scripts/contract-check.mjs`
records, most of the codebase touches `document`, canvas or WebGL at module
scope and cannot be imported under Node.

**`src/physics/Physics.js` is the exception.** It imports only `three`, uses no
DOM API, and both `resolveCapsule` and `groundHeight` run correctly under plain
Node — verified. Since the spec already requires `MazeTopology.js` to be pure,
**every correctness gate can run headless**, with no browser and no flake. Only
the performance and rendering gates need a real WebGL context.

**Tier 1 — headless, `node --test scripts/tests/`.** No new dependency; uses
Node's built-in test runner.

| Probe | What it does | Gate |
|---|---|---|
| Solvability | BFS entrance→centre over 1,000 seeds | 100%, no exceptions |
| Reachability | Flood fill for orphaned regions | 0 orphaned cells, props or NPCs |
| Containment | Drive a capsule through `Physics.resolveCapsule` at sprint speed into every wall, corner, seam and hop apex | 0 escapes in 50,000 attempts |
| Prop ladder | Static scan of emitted collider AABBs for tops in the 0.45–5.0 m band within 2 m of a wall | 0 |
| Seam integrity | `groundHeight` sampled across every district border | never null over walkable cells |
| Gate safety | Re-solve after every one-way gate closure | entrance→centre and abandon routes always survive |

This requires chunk building to **emit collider descriptors separately from
meshes**, so the collision world can be assembled in Node without THREE meshes
or a renderer. That separation is a design requirement, not an implementation
detail.

**Tier 2 — in-browser, via Chrome DevTools MCP against `?dev=1` and the existing
`src/dev/Harness.js`.**

| Probe | What it does | Gate |
|---|---|---|
| Entry time | Portal → playable | < 3 s at p95 |
| Shader reuse | `renderer.info.programs.length` across 10 consecutive entries | no growth |
| Frame time | p95 while walking a 2 km route | within the project's existing budget |
| Visual review | Harness named views, screenshotted | art-direction review |

**Gates are named, not scored.** "0 escapes" and "100% solvable" are pass/fail
and actionable; a blended quality percentage is not. If a probe cannot reach its
gate, that is reported as a named failure with its cause — the bar is not
lowered quietly.

---

## 13. Risks

**Scale.** This is the largest single feature in the project: a new world, plus
a streaming subsystem, plus a chunk manager, plus a world-rules layer. It should
be planned as several phases, not one.

**"Many hours" is a property of exploration, not a guarantee.** The forced route
is roughly 4–8 km — about 25 minutes of walking for someone who knew the way.
The hours come from dead ends and backtracking, which typically multiply that by
15–30×. It will be a very long maze. No specific hour count is promised for a
specific player.

**Shader reuse across re-rolls** is the highest-risk detail. If materials are
reallocated per entry, every entry pays the compilation cost that already
dominates cold boot. The probe exists because this failure would be gradual and
easy to miss.

**Streaming is new to this project.** LOD and streaming were already the
outstanding work here; this feature depends on them rather than deferring them.

**Retained hop widens the exploit surface.** Every prop, every stair tread and
every lift platform is a potential ladder. The prop-ladder probe is a static
scan precisely because human review will not catch all of them.
