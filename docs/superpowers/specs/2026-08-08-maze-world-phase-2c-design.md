# Maze World — Phase 2c: lifts and tunnels

**Date:** 2026-08-08
**Status:** approved, ready for planning
**Parent spec:** `docs/superpowers/specs/2026-08-07-maze-world-design.md`
**Follows:** Phase 2a (streaming), Phase 2b (four levels and stairs) — both merged

---

## 1. Intent

Phase 2b's plan closed with a deferral, verbatim:

> **No lifts or tunnels yet.** Every vertical link is a staircase. Lifts need
> moving-platform support wired to `Physics.setBoxColliderY`, and tunnels need a
> distinct enclosed-descent shape; both are worth their own task once stairs are
> proven.

Stairs are proven — 617 shafts, six properties verified simultaneously, four
levels walkable. This phase builds the other two connectors.

### Not in scope

The `M` map, puzzles, the abandon control, the centre reward and the art pass
remain Phases 3–5. This phase adds no new topology semantics, no new UI and no
new world rules.

### Already done, and therefore dropped from scope

**Shaft lighting.** Commits `033ab0c` and `9c036e6` landed after Phase 2b's
ledger closed and resolved the "pitch black staircase" finding: treads carry a
modest emissive term, the shaft's own walls became a distinct `shaftWall` kind
in pale stone so a shaft reads as a tower above the hedge line, and the minimap
plots a marker per shaft on the player's level.

What remains is only the lighting the *new* spaces need, and the tunnel needs it
most — see §4.

---

## 2. Connector selection

A new pure function joins `MazeTopology.js`:

```js
connectorKind(seed, cellA, cellB) -> 'stair' | 'tunnel' | 'lift'
```

It hashes the link exactly the way `doorwayOffset` already hashes a district
edge, so it is deterministic, re-rolls with the seed, and is decided without
generating a single collider.

**Weights start at 60% stair / 25% tunnel / 15% lift**, as a named constant, not
a literal. The mix is a guess until the maze is walked and is expected to change
— the same honesty the parent spec applies to puzzle density.

**Why it lives in `MazeTopology.js`, not `MazeColliders.js`.** The `M` map, NPC
routing and the solvability gate all read topology, and the parent spec is
explicit that geometry is never consulted for any of them. A map that eventually
draws a lift differently from a staircase must be able to ask what kind a link
is without importing the collider module. Both files stay pure — no `three`, no
DOM — and the committed import-purity test covers the new function for free.

**`DIR.UP` keeps its meaning.** A vertical link is a link; the kind is a
decoration on it. `solve()`, `reachableCount()`, `carveDistrict()` and the
1,000-seed BFS gate are untouched by this phase. That is a deliberate constraint,
not a happy accident: it is what keeps the blast radius of two new geometries
out of the property the very first phase's disconnection bug was about.

---

## 3. The lift

### Behaviour

Call-and-ride. The platform rests at whichever landing it was last left at. A
pressure plate at either landing calls it; standing on the platform sends it to
the other level. No prompt and no UI, which fits the silent, unexplained posture
the parent spec asks for.

A plate sits flush on the landing floor, below the 0.45 m auto-step, so it is
never itself a standable surface in the band and needs no exemption. Its trigger
is a footprint test against the player position, not a collider.

The player is carried by the ordinary capsule pushout. `Physics.setBoxColliderY`
already exists and already documents itself as safe for exactly this: the
broadphase grid is indexed on the XZ plane only, so a Y-only translation never
changes which grid cells a collider belongs to.

State is a per-district registry, populated in `MazeChunks.build()` and cleared
in `drop()`, stepped from `MazeWorld.update(dt)` which already runs each frame.
A lift in an evicted district must leave nothing behind — the same bookkeeping
discipline the canopy pool needed, and the same churn test shape applies.

### The real problem: every gate this project has is static

The anti-ladder scan, the enclosure proof and the containment sweep all read
emitted collider descriptors — fixed boxes at fixed heights. **A lift platform is
a standable surface that sweeps continuously through the 0.45–5.0 m band**, which
is the exact band the entire safety argument is about. A descriptor snapshot of a
moving platform is accurate at one instant and wrong at every other.

**Resolution: the lift emits a swept descriptor, and it is built before the
platform ever moves.**

- The descriptor carries the platform's full vertical travel, flagged
  (`swept: true`) so it is unmistakable.
- **The headless gates read the swept extent** and reason about the worst case
  rather than a sampled instant.
- **`MazeChunks` builds the real platform collider from it** — a single box at
  the platform's current rest height, not a 9 m block. The swept form is for
  proof; the physical form is for physics. Nothing may derive one from a built
  mesh, per the parent spec's §11 separation requirement.

### What the enclosure gate already gives us

`requiredWallTop()` derives a shaft's wall bar from the highest `enclosed`
standable inside its footprint, plus `MAZE.HOP` plus `ENCLOSURE_MARGIN`, then
caps it at `floorY + LEVEL_HEIGHT`. The lift's highest rest position is its
landing, flush with level N+1's floor at `LEVEL_HEIGHT` — **exactly where the
staircase's top landing already sits**. So a lift shaft's derived bar is the same
9.0 m bar a stair shaft already satisfies, and every intermediate platform height
is strictly below it and therefore covered.

This is the outcome to want, and it is not a coincidence: it is the enclosure
rule behaving as designed on a new shape. It is recorded here so nobody
rediscovers it as a surprise — and so that if a future lift is ever given a rest
position *above* the landing, it is obvious that the bar moves with it.

The doorway rule carries over unchanged. `ENTRY_SEAL_FROM` is
`HEDGE_HEIGHT − HOP − STEP_HEIGHT − 0.05` = 3.57 m; below it, walking out of a
shaft is harmless because there is nothing outside to stand on. A platform
passing below 3.57 m sits at an open doorway, and a player stepping out drops
into the corridor. That is correct behaviour, not a leak.

### Two guards, both needing red-verified negatives

1. **Step-off mid-travel.** A capsule leaving the platform at any height must
   land on ground, never resolve inside a shaft wall, and never be left standing
   on air.
2. **Never crush.** A platform must not move while a capsule is between it and
   the ceiling above it.

---

## 4. The tunnel

### Shape

Two flights of twelve 0.375 m rises — the same rise the stairs already use, and
comfortably under the 0.45 m auto-step — with a half-landing between them,
folded into a U so the tunnel arrives at level N+1 **directly above where it
started**.

That fold is the whole reason for the shape. A 9 m climb at 0.375 m per tread
needs 24 treads, roughly 18 m of run, which is three cells; a straight run would
therefore surface three cells away and the topology link would no longer be
C→C. Displaced vertical links would mean changing `neighbourCell()`,
`carveDistrict()`, `solve()`, reachability and the map, and a 3-cell run can
cross a district boundary — which breaks the district independence that makes
streaming and the headless gates possible. The U keeps all of that intact and
pays for it in footprint instead.

Descriptors stay axis-aligned boxes. The parent spec's §11 sketch mentioned a
`rotationY`, but the implemented `ColliderDesc` has no rotation at all, and every
headless gate reads AABB tops. **This phase does not add a pitch to the
descriptor format.** A genuine sloped ramp would change the one data structure
all of those gates are built on, and would do it in the same phase that
introduces a moving collider. That is one risk too many for one phase.

### The footprint is the risk

A 9 m flight is a cell and a half long, so a U needs roughly 9 m × 8.4 m — a 2×2
cell block, on two levels. The staircase got away with a 2.8 m well pushed into
one quadrant of one cell, leaving an L-shaped strip 1.9 m wide so that
north–south, east–west and every turn between them still had a route through the
cell. **A tunnel has four cells to keep walkable on each of two levels, and its
body is wider than the 4.8 m corridor it sits in.**

This is the same class of problem that took the staircase four fix rounds, where
each round's fix created the next round's Critical, and where the eventual root
cause was that three requirements were mutually unsatisfiable at the geometry
first chosen. So:

> **The tunnel's footprint is designed and proven before any geometry is built**,
> against all six properties simultaneously — walk in, climb, **walk away**, no
> fall in, no canopy escape, nothing above the cap. Property 3 (walk away) is the
> one that produced round 3's Critical, and it is strictly harder here than it
> was for the stair.

### Two consequences that are not optional

**Floor perforation generalises from a cell to a region.** Phase 2b's final fix
wave already had to make the perforation loop handle every `DIR.UP` cell in a
district rather than only the first — flagged at the time precisely because
"lifts are the next vertical link". Multi-cell holes are the next step, and the
enclosure grouping (`overlappingShaftCells`, and `requiredWallTop`'s single-cell
footprint test) widens with it.

That widening must be done the way Phase 2b's ledger demands and no other way:

> Fix them by tightening the boundary predicate and widening the descriptor
> window. **NEVER by relaxing the grouping.**

**A tunnel must not straddle a district boundary.** District independence is what
lets two neighbours agree on their openings without either having been generated,
and it is what makes both streaming and the headless gates work. The U's
orientation is hashed like everything else, but **constrained to the orientations
that fit wholly inside the district**. A cell near a district edge has fewer
orientations available, not a tunnel that reaches across one. If no orientation
fits, the link falls back to a staircase.

### Lighting

Levels 0–2 are already roofed interiors — every district emits a full-footprint
floor slab per level — and a tunnel runs enclosed beneath one. It will be the
darkest space in the maze.

Emissive treads as the stairs already use, plus an emissive vault material, both
cached and reused across re-rolls like every other material in `MazeWorld`.

**No lights.** `LightRig.js` pools every light into fixed slots because Three
bakes the light *count* into each shader's program cache key; a per-tunnel lamp
is exactly the changing light count that `main.js` measured at 250 s of shader
recompilation. This is settled, and it is settled the same way it was settled for
the shaft.

---

## 5. Verification

Phase 1's two tiers are unchanged. Tier 1 is headless `node --test`; Tier 2 is
in-browser via the `?dev=1` harness. New gates, each of which must have a
red-verified negative:

| Gate | What it does | Bar |
|---|---|---|
| Connector mix | Enumerate kinds over 1,000 seeds | All three kinds appear; weights hold within tolerance |
| Swept lift enclosure | Enclosure proof against the lift's swept descriptor | Sound at the highest rest position; a shaft one metre short **fails** |
| Lift step-off | Capsule leaves the platform at sampled heights | Always lands on ground; never resolves inside a wall |
| Lift crush | Platform moves with a capsule above it | Never moves through an occupied capsule |
| Tunnel six-property | The stair's six properties, on tunnel geometry | All six hold **simultaneously** |
| Tunnel walk-away | Flood fill both levels of every tunnel-bearing district | 400/400 cells |
| District containment | No tunnel's footprint leaves its district | 0, over 1,000 seeds |
| Lift/tunnel churn | Build/drop districts containing each | 0 bookkeeping mismatches, collider delta 0 |

Render coverage needs no new gate: `maze-render-coverage.test.mjs`, added in
`78118e8`, derives both sides programmatically, so the new `lift` and `tunnel`
descriptor kinds are covered the moment they are emitted. That test exists
because ~14,800 treads once shipped solid, walkable, provably correct and
completely undrawn while all 189 tests passed.

**Gates are named, not scored.** A gate that cannot reach its bar is reported as
a named failure with its cause. The bar is not lowered quietly — and where a bar
is legitimately restated, the restatement is capped at the original so it cannot
drift looser, as `THE PIT GATE` now is.

### Folded in from the 2a and 2b ledgers

- `carveDistrict`'s `levels` parameter is unreachable dead code — `isEdgeOpen`
  already excludes out-of-range edges.
- The tread-overlap test's bar was cut from `>= 0.70 m` (capsule diameter) to
  `> 0`. Defensible at the time because the climb gate proves the property
  physically, but it is a bar removed.
- Property 3 (walk away) is the only one of the stair's six with no dedicated
  negative. The tunnel makes that load-bearing.

---

## 6. Files

New:

```
src/worlds/maze/MazeShafts.js     stair, lift and tunnel geometry plus the
                                  shared enclosure machinery, split out of
                                  MazeColliders.js — pure, same as its parent
```

Edited:

```
src/worlds/maze/MazeTopology.js   connectorKind() + its weights
src/worlds/maze/MazeColliders.js  district/hedge/floor geometry only after
                                  the split; multi-cell perforation
src/worlds/maze/MazeChunks.js     lift + tunnel mesh kinds, per-district lift
                                  registry, build/drop bookkeeping
src/worlds/MazeWorld.js           lift stepping in update(), vault material
scripts/tests/*.test.mjs          the gates in §5
```

`MazeColliders.js` is 793 lines before this phase and will not survive it at one
file. Splitting the shaft geometry out from the district/hedge/floor geometry is
in scope, because this phase is the one that makes it necessary — the three
connector shapes and their shared enclosure machinery are a coherent unit with a
clear boundary, and the purity constraint applies identically to both halves.
No other refactoring.

---

## 7. Risks

**The tunnel footprint is the phase.** Everything else here is an extension of a
proven mechanism. The tunnel is a genuinely new geometric problem with four
simultaneous constraints on two levels, and the staircase's history says such
problems are not found by patching — they are found by proving the footprint
first and discovering that some requirement set is unsatisfiable before any
geometry exists.

**A moving collider is new to this world.** Not to the project — the station's
travelators and escalators already carry the player — but every safety gate the
maze has assumes stillness. The swept descriptor is the bridge, and if it is
wrong it will be wrong silently, because a static gate reading a static
descriptor will happily pass.

**Two new shapes in one phase.** They are independent — no shared geometry beyond
the enclosure machinery — so they can be built and gated separately, and the
tunnel can be cut without touching the lift if its footprint proves
unsatisfiable.
