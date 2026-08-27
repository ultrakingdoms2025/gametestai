# Map editor: graphical map, conflict warnings, select-to-move, remove

**Date:** 2026-08-27
**Status:** Design approved section by section by the owner; awaiting written-spec review.
**Supersedes nothing.** Extends the Phase 8 map editor (`b936fc0`, "The map an admin can move,
without touching a world file").

## 1. What the owner asked for

1. A graphical (top-down) map of each world in `/admin/map`, so an admin can identify an object
   and pick `x, y, z, yaw` by looking rather than by typing numbers into blank fields.
2. A warning when a placement would conflict: something is already there, or the position would be
   underground (or floating).
3. Moving an object by selecting it on the map **and/or** from a dropdown.
4. An option to remove an object.
5. Individual props must be selectable — not only the coarse groups the game names today.

## 2. What exists today (verified against the tree, 2026-08-27)

- `site/components/MapEditorPanel.tsx` is a form: a free-text target name with a `<datalist>`,
  four number inputs (X/Y/Z, yaw in radians). New entries default to `(0,0,0)`.
- The **only** spatial data the site holds is a report the admin's own game posts after applying
  the overlay: `objects[] = {name, position}` for named `Object3D`s, breadth-first, capped at 2000
  (`src/systems/MapOverlay.js#_catalogue`). Stored one row per world in `map_world_reports`.
  `recordWorldReport` strips every other field.
- The overlay (`site/lib/mapOverlaySchema.ts`, schema 1) has `move` and `place` entries. A move
  targets `{name}` and writes an absolute position. There is **no remove**; `hidden: true` hides a
  mesh but leaves its colliders — an invisible wall.
- `MapOverlay` applies entries **after** `world:changed`, by `getObjectByName`, and moves colliders
  whose centre lies in the object's pre-move AABB (`_moveColliders`). Positions are absolute so
  re-applying to a cached world is idempotent.
- Every world merges props for draw-call budgets, through **eight primitives**:
  `GeoBatch` (medieval, station, dock), `Batch` (citadel, race), `instanced` (station kits and
  six other worlds), `_instanced` (sports), `buildPropField` (planets), `_bake` (space dock), and
  `MazeBatches` (maze). ~220 emission sites feed them. A merged prop has no name and cannot be
  addressed by the current overlay at all. Gate comments forbid un-merging (citadel "ceiling of
  150", dock "220-draw budget", maze "<= 120", planets "1,186 draws is three frames' budget").
- Ground height: pure-JS height functions exist for medieval, citadel and the planets; station,
  dock and space are flat decks; the maze re-seeds every visit. None of these know about
  buildings. Only the running game's `Physics.groundHeight(x, z)` knows the true top surface.
- `World` already carries `bounds` (Box3) and `minimapShapes` (`rect | circle | path`, drawn by
  `src/ui/Minimap.js`). Neither leaves the browser today.
- `WorldManager.build(id)` caches built worlds; `volatile` worlds (maze) rebuild per visit.
  `_runBuild` builds against a scratch `Physics` and harvests `world.colliders`.

## 3. Decisions taken with the owner

| Decision | Choice | Why |
|---|---|---|
| Source of map data | **The running game reports it** (bounds, footprints, ground grid) when an admin enters a world | Only the game knows the true top surface (decks, roofs) and what a 12,945-line procedural world built. A checked-in export would go stale and cannot cover the maze. |
| Granularity | **Individual props**, via build-time overlay through the eight primitives (approach B) | Live per-prop mutation inside merged batches was sized at 30–59 agent-days and fights every draw-call gate. Consulting the overlay *while building* keeps merging intact. |
| "Already there" | Footprint AABB overlap | Conventional; the offending id is named so a deliberate overlap can be kept. |
| "Underground" | Below the physics-sampled top surface, not terrain only | Matches what the player collides with. |
| Remove | First-class `remove` kind that also drops colliders | `hidden` leaving invisible walls is the documented trap. |
| Yaw | Degrees in the UI, radians in the document | Existing storage convention; degrees are what a person reads off a map. |
| Live vs reload | Merged-prop edits appear on the **next build** of that world | The existing admin flow is already "save → reload → see it". Named-object moves stay live. |
| Maze | Excluded from prop addressability | Re-seeded per visit; nothing stable to address. Its named lifts/gates keep working via `{name}`. |

## 4. Architecture

```
                 site (Next.js)                          game (browser)
┌──────────────────────────────┐   GET /api/game/map-overlay?world=   ┌──────────────────────────┐
│ overlay versions (JSONB)     │ ───────────────────────────────────▶ │ WorldManager.build(id)   │
│ + world layout (JSONB) NEW   │                                      │   overlay → world.ctx    │
│                              │                                      │   primitives consult it  │
│ /admin/map editor            │                                      │   and fill a REGISTRY    │
│  • canvas map (draws layout) │   POST /api/admin/map/report         │ MapOverlay (post-build)  │
│  • click → select id         │ ◀─────────────────────────────────── │   • colliders for moves/ │
│  • dropdown → select id      │   {registry, bounds, shapes,         │     removes (AABB)       │
│  • x/y/z/yaw, warnings       │    groundGrid, applied, unresolved}  │   • named-object moves   │
│  • save → new version        │                                      │     (as today)           │
└──────────────────────────────┘                                      └──────────────────────────┘
```

1. **The overlay reaches the build.** `WorldManager.build` fetches the world's overlay before
   `world.build()` and puts a lookup object on `world.ctx.overlay`. Fetched for every client (players
   and admins alike), cached per `world + version` for the session. A failed fetch builds the world
   with no overlay and logs once — identical to today's behaviour when the endpoint is down.
   Nothing in `src/worlds/` imports anything from the site; a world sees only `ctx.overlay`.
2. **Primitives consult it and fill a registry** (§6). Merging, budgets, LOD and AO are untouched.
3. **`MapOverlay` post-build** does what it does today (named-object moves, live) plus: collider
   handling for registry-targeted moves and removes, and — admin only — the **layout report** (§7).
4. **The editor draws the layout** and validates every edit against it (§8, §9). The server runs the
   same validation on save: the page is a courtesy, the route is the boundary.

## 5. Overlay schema v2 (`site/lib/mapOverlaySchema.ts`)

`MAP_OVERLAY_SCHEMA` 1 → 2.

```ts
type Target = { name: string } | { id: string };   // named Object3D (live) | registry id (build-time)

interface MoveEntry   { kind: 'move';   id: string; target: Target; position: Vec3; rotationY?: number }
interface RemoveEntry { kind: 'remove'; id: string; target: Target }
interface PlaceEntry  { kind: 'place';  /* unchanged from v1 */ }
type OverlayEntry = MoveEntry | RemoveEntry | PlaceEntry;
```

- `remove` is a first-class kind. For `{name}` targets the applier hides the object **and** drops
  colliders whose centre lies inside its AABB. For `{id}` targets the primitive does not emit the
  prop and `MapOverlay` drops the colliders inside the registry's authored AABB.
- `hidden: true` is retired. The normaliser migrates a v1 `move` with `hidden` to `kind: 'remove'`
  on read, so every stored version and every revert still loads. `position: null` is no longer valid
  on a move (reject reason `position`).
- Registry ids are `family@x,z` with the **authored** position rounded to 0.1 m, and a `#n` suffix
  only when two props of one family share a rounded spot. Keyed on the source position so an art pass
  inserting props elsewhere does not renumber anything. If an art pass moves *that* prop, its id
  disappears and the entry becomes `unresolved` — the semantics a renamed object already has.
- Target ids ≤ 128 chars. Other limits unchanged: 500 entries, |coord| ≤ 20 000 rounded to 3 dp,
  yaw wrapped to (−π, π] at 6 dp, entry ids ≤ 64 chars. `normaliseOverlayEntries` still never
  throws and still returns `rejected[{index, id, reason}]`; new reasons: `target` (bad shape),
  `position` (null on a move).
- A v1 client reading a v2 document treats `remove` and `{id}` targets as `unresolved` — no crash.
- Idempotence is preserved: a build-time move is a lookup, never a delta.

## 6. Game side: `PropRegistry` and the primitives

### 6.1 `src/worlds/PropRegistry.js` (pure JS, no Three.js import; `node --test`)

```js
class PropRegistry {
  constructor(overlay)                 // Map<id, {position?, rotationY?, removed?}> | null
  claim(family, x, z)  → id            // 'family@x,z' ('#n' on collision); stable per build
  resolve(id, matrix)  → matrix | null // null = removed; else the matrix to emit at
  record(id, family, matrix, localAabb)// {id, family, position, yaw, aabb} for the report
  entries()                            // report payload
  consumed()                           // overlay ids hit during this build; the rest are unresolved
}
```

`resolve` composes the overlay's absolute position/yaw into the matrix the primitive already
holds (it replaces translation and Y rotation, keeps scale and any X/Z tilt). `record` stores the
**authored** matrix's world AABB — that is what collider matching uses (§6.3).

`world.registry = new PropRegistry(ctx.overlay)` is created in `World`'s constructor, so every
world has one whether or not its primitives use it yet.

### 6.2 Primitive changes (three lines each, at the point geometry + matrix are already in hand)

| primitive | matrix lives in | move | remove |
|---|---|---|---|
| `GeoBatch.add(geo, matrix)` — medieval, station, dock | the `matrix` argument | swap before `applyMatrix4` | return without adding |
| `Batch.add` — citadel, race | same | same | same |
| `instanced(geo, mat, entries)` / `_instanced(geo, mat, placements)` — station kits, sports, medieval/citadel scatter, race tiles | tuple / placement array | rewrite the tuple | drop it; instance count shrinks by one |
| `buildPropField(spec, ctx)` — planets | `points` array | same | same |
| `_bake(geo, mat, matrix)` — space dock | the `matrix` argument | as `GeoBatch` | as `GeoBatch` |
| `MazeBatches` — maze | per cell | **out of scope** | **out of scope** |

Family key = the material/kit key the primitive already batches by, prefixed by the emission
site's label where one exists (station kits and planets already carry one). Where a primitive only
sees a geometry with the matrix pre-applied (some `GeoBatch.add` callers), the call site passes the
matrix through — that is the only per-site edit, and only where needed.

Post-build derivations run unchanged: station `_settleScatter` / `_solidifyProps`, citadel
`_splitDistricts` and its LOD twin, medieval AO bake. By the time they run the prop is simply
elsewhere or absent. Citadel's shared `mulberry32` stream is unaffected because a remove skips
*emission*, not the random draws that precede it.

### 6.3 Colliders

The 68 `physics.add*` calls in worlds stay as they are. Post-build, `MapOverlay` walks the registry:
for each consumed overlay id it takes the authored AABB from `record` and applies the existing
`_moveColliders` heuristic — shift by the move's delta, or remove for a `remove`. Same code path,
same tests, fed by the registry instead of `setFromObject`. Heightfields never move.

### 6.4 Players

Player clients fetch the overlay at build exactly like admins (they must, to see the same world).
They build no report and sample no grid. Added cost: one cached fetch per world per session.

## 7. Layout report (`POST /api/admin/map/report`, admin client only)

```
{ world, appliedVersion, schema: 2,
  bounds:  { min: Vec3, max: Vec3 },                       // world.bounds
  shapes:  minimapShapes,                                   // rect | circle | path, as Minimap.js draws them
  objects: [...today's named catalogue],                    // unchanged
  props:   [{ id, family, position: Vec3, yaw, aabb: {min, max} }],   // NEW, from registry.entries()
  ground:  { originX, originZ, step: 4, nx, nz, heightsCm: <base64 Int16> },   // NEW
  applied, unresolved }
```

- **Ground grid**: `physics.groundHeight(x, z)` on a 4 m lattice over `bounds`, ≤ 200 rays per
  frame via the existing 12 m broadphase; a ±744 m station (~35 k samples) finishes in a few seconds
  after the loading gate. A missing sample is `INT16_MIN`. Heights in centimetres; ~70 KB for the
  station. If the admin leaves the world before sampling finishes, no report is sent and the previous
  one stands.
- **Storage**: `map_world_reports` gains `layout JSONB NOT NULL DEFAULT '{}'::jsonb` and
  `layout_schema INTEGER NOT NULL DEFAULT 0` via the existing `ensureMapOverlaySchema` DDL
  (`ADD COLUMN IF NOT EXISTS`). `recordWorldReport` validates and clamps every field (props ≤ 20 000,
  grid ≤ 400 × 400, payload ≤ 4 MB) and rejects the rest with 413/400; a rejected report leaves the
  prior layout in place.
- **Read**: `GET /api/admin/map/{world}` returns `layout` alongside `overlay`, `versions`, `report`,
  plus `reportedAt` so the editor can show the layout's age.

## 8. Editor UI (`/admin/map`)

Map-first layout; the version list, notes, save and revert stay as they are.

```
┌─ World: [Station ▾]   Layout: reported 3 min ago ✓  (or: "No layout yet — enter this world in game as admin") ─┐
│ ┌──────────────────────────────────────────────┐ ┌──────────────────────────────────────────┐ │
│ │  TOP-DOWN MAP (canvas, north = −Z)           │ │ SELECTION                                │ │
│ │  · floorplan from shapes                     │ │  [ Search / pick object ▾ ]              │ │
│ │  · props as footprint boxes, named objects   │ │  medieval:house@12.3,-40.1               │ │
│ │    as dots, placements as diamonds           │ │  X [ 12.30] Y [  3.20] Z [ -40.10]       │ │
│ │  · pending edits in accent colour            │ │  Yaw [ 90 ]°   [x] snap Y to ground      │ │
│ │  · hover = tooltip (id, family, y)           │ │  Ground here: 3.18 m   ✓ on surface      │ │
│ │  · click = select; drag = move; wheel = zoom │ │  ⚠ Overlaps medieval:cart@14.0,-41.2     │ │
│ │  · ring handle = rotate                      │ │  [ Move here ] [ Remove ] [ Reset ]      │ │
│ │  · empty click = place (marketplace item)    │ │                                          │ │
│ └──────────────────────────────────────────────┘ └──────────────────────────────────────────┘ │
│ PENDING CHANGES (this version)                                                                │
│  move   medieval:house@12.3,-40.1  → (12.3, 3.2, −40.1) yaw 90°      ⚠ overlap   [undo]      │
│  remove station:crate@-5.0,88.0                                        ✓          [undo]      │
│  place  Loot Crate ×1 → (…)                                            ⚠ underground [undo]   │
│ Note [ … ]                     [ Save version 7 ]  (disabled while any ⛔ error is present)  │
└───────────────────────────────────────────────────────────────────────────────────────────────┘
```

- **Select**: click a footprint/dot on the map **or** pick from the dropdown (grouped by family,
  type-to-filter). Both set one `selected` target; the map pans to and highlights it. The dropdown
  is the keyboard path and the fallback for props too small to click.
- **Move**: drag on the map (x/z) or type. **Y defaults to the ground height under the new x/z**
  ("snap Y to ground", on by default). Yaw is a ring handle on the map and a degrees field.
- **Remove**: adds a `remove` entry; the map draws the prop struck-through until saved. Marketplace
  placements are removed by deleting their entry, as today.
- **Place**: click empty ground → choose an item from the existing marketplace dropdown → a
  `place` entry at that spot with Y from the grid.
- **Warnings** appear beside the selection and in the pending list. **Errors** disable Save;
  **warnings** do not (an overlap with a fence is sometimes intended).
- **Stale layout**: the banner shows the layout's age; edits are validated against whatever the
  last report holds; a target absent from the layout is flagged `unresolved`.
- **Components**: `site/components/MapCanvas.tsx` (drawing + pointer handling; follows
  `fit()` from `painters.ts`, DPR-aware, redraw on resize) over `site/lib/mapProjection.ts` (pure
  world↔screen, pan/zoom, hit-testing — unit-tested). `MapEditorPanel.tsx` keeps document state,
  selection and pending entries; `MapCanvas` receives props and emits `onSelect`, `onMove`,
  `onRotate`, `onPlaceAt`.

## 9. Conflict detection (`site/lib/mapConflicts.ts`)

One pure function, used by the editor live and by the save route authoritatively:
`conflicts(entry, layout, otherPending) → Array<{ level: 'error' | 'warn', code, detail }>`.

| code | level | rule |
|---|---|---|
| `out-of-bounds` | ⛔ | x/z outside `bounds` (5 m margin) or \|coord\| > 20 000 |
| `unresolved-target` | ⛔ | target id/name absent from the current layout |
| `duplicate-target` | ⛔ | two pending entries act on the same target |
| `underground` | ⚠ | y < ground(x, z) − 0.25 m |
| `floating` | ⚠ | y > ground(x, z) + 1.5 m (the grid is the top surface, so a crate on a roof is on the ground there) |
| `no-ground` | ⚠ | no grid sample at (x, z) — water, a hole, off the deck |
| `overlap` | ⚠ | the moved/placed footprint (AABB, translated and yaw-rotated) intersects another prop's AABB, a named object's point ± 1 m, or another pending entry; names the offender |

Ground lookup interpolates the 4 m grid bilinearly; `INT16_MIN` cells count as no sample.
Footprints for `place` entries come from a small per-item size table (default 1 × 1 × 1 m).
On save the route runs the same function; error-level results are returned as
`rejected[{index, id, reason}]` and nothing is written (the existing single-transaction rule with
the audit row holds). A client that skips the check cannot save an invalid document.

## 10. Failure modes

| situation | behaviour |
|---|---|
| overlay fetch fails at build | world builds with no overlay; logged once; editor banner shows "layout: unavailable" after the next report |
| a primitive throws on an entry | caught per entry → `unresolved: {id, reason: 'error'}`; the rest of the world builds |
| id gone after an art pass | `unresolved`; editor flags it; world unaffected |
| admin leaves before the grid finishes | no report sent; previous layout stands; banner shows "layout: sampling…" while in-world |
| v1 client reads a v2 document | unknown kinds/targets → `unresolved`; no crash |
| report too large / malformed | 413/400; prior layout kept; game logs and moves on |
| save with an error-level conflict | 400 with `rejected[]`; nothing written; no audit row |
| `HMAC_SECRET` missing on save | unchanged: save and audit are one transaction; both roll back |

## 11. Testing

Each gate measures what the game actually does (a gate that measures something the game does not
do is worse than no gate — this repository has paid for that nine times).

- `PropRegistry` — `node --test`: id stability under insertion elsewhere, `#n` collisions,
  resolve/remove, `consumed()` → unresolved, matrix composition keeps scale/tilt.
- Per primitive — build one world headlessly (`scripts/tests/_flightrig.mjs` dom harness, no
  WebGL) with an overlay that moves one prop and removes one; assert the registry entry, the
  affected bucket's vertex count, and `physics.colliders` count and centres. Planets first.
- Idempotence — build the same world twice with the same overlay → identical registry and
  collider set.
- `mapConflicts.ts` — vitest table tests for every code; bilinear lookup at cell edges and at
  `INT16_MIN` cells.
- Schema v2 — normaliser round-trip, `hidden` → `remove` migration, mixed name/id targets, every
  new reject reason; extend `mapOverlaySchema.test.ts` and `mapOverlayRoundTrip.test.ts`.
- Report route — size caps, base64 grid validation, layout column round-trip; the admin gate is
  already walked by `adminRouteGuards.test.ts`.
- `mapProjection.ts` — world↔screen round-trip, hit-testing, pan/zoom.
- Editor — Playwright: sign in as admin, seed a layout, load `/admin/map`, click a footprint, assert
  the selection panel, drag, assert the pending entry and its warning, save, assert the version.
- Perf — `frame-gaps.mjs` on station with sampling running shows no new hitch frames;
  `world-shot.mjs` budgets (draws, programs, triangles) unchanged for every world touched.

## 12. Staging

Each stage ships on its own; the editor is useful from stage 1.

1. **Editor + layout report + conflicts** over today's named objects, with `bounds`, `shapes` and
   the ground grid — the map works for every world immediately.
2. **Schema v2 + `remove`** with collider drop for named objects; `hidden` migration.
3. **`PropRegistry` + planets + space dock** (`buildPropField`, `_bake`) — proves the primitive
   pattern end to end.
4. **`instanced` / `_instanced`** — station kits, sports, race tiles, medieval/citadel scatter.
5. **`GeoBatch` / `Batch`** — dock, race, station structures, medieval, citadel; last, largest
   files, coordinated with whichever art branch is open.

Estimate: stages 1–2 ≈ 4–6 agent-days; stages 3–5 ≈ 6–10 agent-days. Maze excluded by design.

## 13. Out of scope

- Live (no-reload) editing of merged props.
- Maze hedges and cells.
- Editing world *source*; the overlay remains the only thing written.
- Multi-user editing; the existing optimistic version check remains the concurrency model.
