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

**Amended in Phase 2b, with the owner's approval.** Four levels need staircases,
and a staircase is made entirely of surfaces in that band — so the rule as
written forbids the vertical maze this spec asks for. Rather than loosen it, it
is narrowed and given a proof obligation:

> A standable surface may sit in the 0.45–5.0 m band **only inside a sealed
> shaft** — a cell walled on all four sides, from **the height at which leaving
> it would become an exploit**, up to at least **the highest standable surface
> inside it plus 0.93 m plus a margin**.

**Sealing starts partway up, not at the floor.** The first attempt required
walls from the shaft floor, which is stricter than the physics needs and makes
the world unplayable: it left a 0.45 m doorway against a 1.75 m player, so every
staircase was sealed *and unenterable*, and all 617 of them passed the gate.

Leaving a shaft low down is harmless — there is nothing outside to stand on, so
you simply drop back into the corridor. It only becomes an exploit once you are
high enough that a hop and a step-up put you on top of a 5 m hedge. That height
is `HEDGE_HEIGHT − hop − stepHeight` = 5.0 − 0.93 − 0.45 = **3.62 m**, so walls
are required from below that (with margin) upward, and the doorway beneath it is
free. Like the upper bar, this is derived and must not be written as a constant.

**The wall height is derived, never a constant.** The first draft of this
amendment said "to at least hedge height", and that was wrong in a way that
destroyed the guarantee it was written to preserve: `LEVEL_HEIGHT` is 9.0 m, so
a staircase climbing a real level inside 5.0 m walls satisfied the rule while
letting the player walk up the stairs and straight over the wall tops onto the
maze roof. Measured escape height on that geometry: **10.0 m**. A shaft's walls
must clear its own stairs, so the bar is a function of what is inside the shaft
and cannot be written down as a number.

Enclosure is **proven, not declared**, and the proof has three parts:

1. **Geometric** — all four sides walled, from the shaft floor to the derived
   height. Coverage may be assembled from several colliders per side as long as
   they are contiguous; a gap between two pieces fails.
2. **Simulated** — a capsule driven around inside the shaft, hopping only when
   grounded (there is no double jump), seeded not just on the shaft floor but
   **on top of every standable surface inside it**, since the escape a
   staircase enables is from the top step, not from the bottom.
3. **Bound to the exemption** — every descriptor that claims `enclosed` must be
   shown to sit inside a shaft that passed 1 and 2, on real generated seeds.
   Without this the flag is self-certifying: anything can exempt itself from the
   band rule simply by asserting it is enclosed.

A shaft with one wall missing, one wall too short, one wall too narrow, or a
gap between two wall pieces must fail.

The guarantee is unchanged in substance: the player still cannot reach the top
of a hedge. What changed is that the rule now says so directly instead of
approximating it with a blanket ban.

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

**The map — `src/ui/MazeMap.js`, bound to `M`.** Renders ~~the current level
only by default~~ **all four levels at once by default — AMENDED by the owner,
2026-08-09**, drawn from the topology array. 400×400 cells at ~~2 px/cell
is an 800×800 canvas~~ **4 px/cell is a 1600×1600 canvas** — 2 px/cell was
measured unreadable, a cell landing under 1.5 px in the panel and the walls
merging into noise — drawn once per level and cached. All four bakes are now
kept rather than one, because the overview needs them together and because
paging used to re-rasterise 160,000 segments per press.

**All four levels, side by side — `src/ui/MazeMapLayout.js`.** `M` opens a 2×2
grid of floorplans, fitted, one pane per level in the order the tabs and the
`1`–`4` keys already name them. The maze is one connected volume and the
question a player is actually asking — *where does this floor let me up?* — is
one no single floorplan can answer.

2×2 rather than a 1×4 strip because the panel is square (`min(92vw, 92vh)`): a
strip fits each level into a quarter of the panel's edge, a grid into a half,
which is twice the linear scale for the same screen. Side by side and never
superimposed, for the reason the route drawing has always given — flattened,
the floor above reads as a way through this one.

Paging survives: `1`–`4`, the tabs, the brackets and PageUp/PageDown still drop
to a single floor at junction scale (`OPEN_CELLS_ACROSS`), and `0`, the
backquote or the ALL tab comes back. The overview is the index; the single
floor is the page. Coming out of the overview re-centres on the player, because
a sheet-sized pan means nothing on one floorplan. FIND ME now restores the
junction-scale zoom too, since "show me where I am" pressed from a fitted
overview used to land on a fitted floorplan — 400 cells across a panel, which
is a shape and not a place.

The arrangement lives in a pure module so it can be asserted under
`node --test` — no two panes overlap, none escapes the sheet, every level gets
one — which a decision taken inside `_draw` could not be.

**Navigation (owner, 2026-08-09).** The **wheel scrolls** and **Ctrl+wheel
zooms**, rather than the wheel zooming: the map opens showing 90 of 400 cells,
so scrolling is constant and zooming is once. Dragging still pans. **`1`–`4`,
the bracket keys and PageUp/PageDown page between the four levels**, with tabs
in the header; pan is held across a switch, because the levels stack in one
footprint and holding position is what makes comparing them useful. **FIND ME
(or `Home`) snaps back** to the player, on the player's own level.

**Pan is bounded so the grid always covers the panel.** The old bound allowed
panning by half the image, and since the entrance sits ON the edge of the grid,
opening centred on the player left the outside-the-maze void filling half the
panel — it read as a half-drawn map.

**The map closes itself when the world stops being a maze**, rather than
freezing on the last level it baked over a world it has nothing to do with.

**~~No you-are-here marker.~~ REVERSED by the owner, 2026-08-09.** The original
rule was that the player gets the shape of the level and must locate themselves
by matching the junction pattern around them against the drawing — called here
the central navigational challenge and the reason the map does not trivialise a
maze this size. A test enforced it by grepping `MazeMap.js` for a player
position.

The owner reversed it. The map now shows **where you are and which way you
face**, plus markers for staircases, lifts, tunnels, dead-end tokens, the centre
stack and portals, and it opens centred on the player.

Recorded rather than quietly rewritten, because the original argument was about
difficulty and not about correctness — if the maze ever reads as too easy, this
is the first thing to reach for. The enforcing test was replaced rather than
deleted: `THE MARKER GATE` now asserts the marker set is complete, since a
legend naming seven things over a map drawing four is the new failure mode.

**Markers name what is BUILT, not what the topology chose.** Most tunnel links
fall back to a staircase where no fold orientation keeps the maze walkable, and
a map that calls a staircase a tunnel costs a player the walk back.

`M` is added to the `BINDINGS` table in `src/core/Input.js` (~line 44) as a
`map` action, which inherits the existing rebinding UI for free.

**Ctrl+M draws the solution path** from where the player is standing to the
centre — a deliberate cheat, added at the owner's request. It works only while
the map is already open, resets every time the map is opened, and draws only the
segments on the level being shown: a route that vanishes at a staircase and
resumes on the level above is what the player needs to see, where a flattened
one would suggest a way through a floor.

**Over all four levels — AMENDED by the owner, 2026-08-09.** Ctrl+M in the
overview draws the route on every pane it crosses, and joins them: where the
route changes floor, a dashed link runs from that cell in one pane to the same
cell in the other, ringed at both ends. This is the same "never flattened"
rule, extended — the route still stops dead at each floor's edge, and the only
thing that crosses between floors is a link drawn at a cell where the topology
genuinely has one. `THE VERTICAL-LINK GATE` in
`scripts/tests/maze-map-levels.test.mjs` asserts exactly that, against
`isOpen(..., DIR.UP)`.

Ctrl+M goes through `mapActionOwner` and `Input.codeFor('map')` like the plain
press does, and for the same reason as commit 6e863e3: it is the same key, so a
second rule about who owns it would be a second way for the map and the mount
wheel to disagree.

The route itself still comes from `MazeWorld.solutionPath`, which is
`MazeTopology.solve` — the one answer to "is this maze solvable". The map does
not search; a gate asserts it contains no second search.

**The minimap** behaves exactly as in other worlds, with two changes:

- **collectables, connectors and portals are marked** (owner, 2026-08-09) — see
  §7's marker note;
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

**The sliding hedge wall, as built.** It rests **shut**, blocking a district
doorway, and sinks out of the way when the player stands on its plate — which
**latches**, because a plate that only holds the wall open while you stand on it
is a door nobody travelling alone can walk through. Walls go only **off** the
solution path: a gate is a committal you pass and carry on from, whereas a wall
on the only route to the centre could be failed permanently, which is a trap.

It shares `stepGates` with the one-way gate rather than growing a parallel copy.
Its top travels the same 0.45–5.0 m band in the same open corridor, so it needs
the same halt-while-occupied interlock, and the way to guarantee two things
share an invariant is to make them share the loop that enforces it.

**The plate is placed down a straight open run back from the wall** — line of
sight in a hedge maze is a straight corridor and nothing else. Measured over
2,323 candidates across twelve seeds, that run is **zero cells 46% of the time**,
because a maze turns constantly and most doorways are corners; a plate in the
doorway cell sits 3 m from its wall and reads as an automatic door. Those are
**not built at all** — the doorway is simply left open. That leaves ~104 walls
per maze, every one 9–27 m from its plate and in sight of it.

**Moving parts are drawn where they are, not where they were built.** Gates and
sliding walls were absent from `CHUNK_MESH_KINDS` entirely, so a gate was a
solid invisible wall across a corridor. Lifts were worse, because they looked
correct standing still: measured on real geometry, a car's collider rode the
full **8.700 m** to its landing while its mesh sat at **0.150**. The step
functions now carry the instance matrix along with the collider.

**One-way gates must never strand a player.** The district graph is validated
after gate placement to confirm the entrance→centre route and an abandon route
survive every gate closure. Combined with hold-`L` abandon, there is no
reachable stranded state.

---

## 9. NPCs and atmosphere

**One keeper** in the entrance forecourt. Explains the maze, the map and the
abandon control. Chat-only.

**~~Eight lost wanderers, capped.~~ RAISED by the owner, 2026-08-09** to twenty,
five per level. Eight people in 640,000 cells was nobody: a player could cross a
level without meeting one. They walk the shortest path toward the centre rather
than a short random loop, so they read as still searching. Chat-only.

The cap's real point is kept as a test rather than as a number: every wanderer
must be a DISTINCT written character with a real persona, because the way
"more of them" goes wrong is four copies of the same person.

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
