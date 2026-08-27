# Map editor: graphical map, conflict warnings, select-to-move, remove

**Date:** 2026-08-27
**Status:** Design approved section by section by the owner; three reviewer rounds applied (registry timing, layered ground grid, containment collider drop, no-layout save rule). Awaiting owner review of the written spec before planning.
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
  dock), `_instanced` (sports), `buildPropField` (planets), `_bake` (space dock), and
  `MazeBatches` (maze). ~220 emission sites feed them, plus ~31 inline `new THREE.InstancedMesh`
  sites that bypass all of them (§6.2). A merged prop has no name and cannot be
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
│ overlay versions (JSONB)     │ ───────────────────────────────────▶ │ WorldManager._runBuild   │
│ + world layout (JSONB) NEW   │                                      │   ctx.overlayProvider →  │
│                              │                                      │   primitives consult it  │
│ /admin/map editor            │                                      │   fill world.registry    │
│  • canvas map (draws layout) │   POST /api/admin/map/report         │ MapOverlay (post-build)  │
│  • click → select id         │ ◀─────────────────────────────────── │   • colliders for moves/ │
│  • dropdown → select id      │   {registry, bounds, shapes,         │     removes (AABB)       │
│  • x/y/z/yaw, warnings       │    groundGrid, applied, unresolved}  │   • named-object moves   │
│  • save → new version        │                                      │     (as today)           │
└──────────────────────────────┘                                      └──────────────────────────┘
```

1. **The overlay reaches the build.** `WorldManager` has no fetch of its own and gains none.
   `main.js` sets `worldManager.ctx.overlayProvider = (worldId) => Promise<OverlayLookup | null>`
   from `MapOverlay` after constructing it (line ~314, before the entry build at ~1247);
   `_runBuild` reads **the manager's `this.ctx`**, not the per-world copy spread at `getWorld()`.
   `MapOverlay` owns the endpoint, the parsing and a **per-world, per-session cache**
   (it cannot be keyed on a version the client has not fetched yet). `_runBuild` awaits the
   provider before `ensureBuilt` — with **no timeout while `!engine.running`** (the entry world
   builds behind the loading gate, where a wait costs nothing visible and a cold function would
   otherwise leave the station at `builtVersion 0` for the session) and a **1 500 ms race** for
   background builds. On failure or timeout the world builds with no overlay and logs once —
   identical to today's behaviour when the endpoint is down. `main.js` calls
   `mapOverlay.prefetch(startWorld)` before `worldManager.build`, so the entry fetch overlaps
   the gate. The post-build applier's fresh `no-store` document refreshes the provider cache, so
   a volatile rebuild after an in-session save is not against the stale one. Fetched for every
   client, players and admins alike. Nothing in `src/worlds/` imports anything from the site:
   `_runBuild` turns the lookup into `world.registry` (§6.1) and `world.builtVersion`, and
   **those two properties are all a world ever sees**.
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
  its colliders; for `{id}` targets the primitive does not emit the prop and `MapOverlay` drops
  its colliders. **Both use the containment rule of §6.3** (a collider's own AABB inside the
  object's box + 5 cm) — never centre-in-box, which over-removes. The `{name}` box is
  `Box3.setFromObject`, as the mover already computes.
- `hidden: true` is retired. The normaliser migrates a v1 `move` with `hidden` to `kind: 'remove'`
  on read, so every stored version and every revert still loads. `position: null` is no longer valid
  on a move (reject reason `position`).
- Registry ids are `family@x,z` with the **authored** position rounded to 0.1 m, and a `#n` suffix
  only when two props of one family share a rounded spot. Keyed on the source position so an art pass
  inserting props elsewhere does not renumber anything. If an art pass moves *that* prop, its id
  disappears and the entry becomes `unresolved` — the semantics a renamed object already has.
  A family key may carry a namespace, as medieval's `medieval:${key}` batch keys already do —
  which is why the §8 mock shows `medieval:house@12.3,-40.1`.
- Target ids ≤ 128 chars. Other limits unchanged: 500 entries, |coord| ≤ 20 000 rounded to 3 dp,
  yaw wrapped to (−π, π] at 6 dp, entry ids ≤ 64 chars. `normaliseOverlayEntries` still never
  throws and still returns `rejected[{index, id, reason}]`; the existing `target` and `position`
  reasons widen to cover a malformed `{id}` target and a null position on a move.
- A v1 client reading a v2 document does not crash: its applier dispatches only `move`/`place`,
  so a `remove` is **silently skipped** (nothing hidden, nothing reported), and a `move` with an
  `{id}` target lands in `unresolved` with reason `name`. Acceptable for the deploy window, since
  the site and game ship together.
- Idempotence is preserved: a build-time move is a lookup, never a delta.

## 6. Game side: `PropRegistry` and the primitives

### 6.1 `src/worlds/PropRegistry.js` (pure JS, no Three.js import; `node --test`)

```js
class PropRegistry {
  constructor(overlay)                     // Map<id, {position?, rotationY?, removed?}> | null
  claim(family, x, z)  → id                // 'family@x,z' ('#n' on collision); stable per build

  // MATRIX PATH — GeoBatch, Batch, _bake. `matrix` is anything with a 16-element `.elements`
  // (duck-typed, so node --test feeds plain arrays; no Three.js import).
  resolve(id, matrix)  → matrix | null     // null = removed; else the matrix to emit at
  record(id, family, matrix, localAabb)    // authored + effective transform/AABB for the report

  // ARRAY PATH — instanced, _instanced, buildPropField, inline InstancedMesh sites.
  // Filters removed items out, rewrites moved ones in place, records every item (removed too),
  // and preserves the order of untouched items (index-paired collider arrays depend on it).
  instances(family, items, {
    at:    (item) => ({ x, y, z, yaw }),               // read the authored transform
    apply: (item, { position, rotationY }) => item,    // write the effective one
    aabb:  (item) => localAabb,                        // optional; default 1 m cube
  }) → items'

  entries()                                // report payload (§7 props[])
  consumed()                               // overlay ids hit during this build; the rest are unresolved
}
```

`resolve` (matrix path) decomposes to position/quaternion/scale, keeps scale, sets translation
and a pure Y rotation of `yaw` — an authored X/Z tilt is **not** preserved on a matrix-path move
(tilted batched props are rare; the loss is documented rather than hidden behind an Euler-order
guess). `instances` (array path) rewrites only `x, y, z, yaw` through the caller's `apply` and
keeps everything else the item carried.

`record` needs a local AABB. Computing `computeBoundingBox()` per emitted geometry across ~220
sites would be a measurable cost in a 6.5 s station build, so the registry keeps a **per-family
cache keyed on the prototype geometry object** (`WeakMap<BufferGeometry, Box3>`); the first
emission of each geometry pays, the rest look up. Boot timing is a gate in §11.

`record` **always runs — for removed props too.** It stores the **authored** world transform
and AABB (what collider matching uses, §6.3) and the **effective** one (`null` when removed), so
the layout report can show a removed prop as removed and a moved prop where it now stands (§7).

**Creation timing.** `World`'s constructor runs in `WorldManager.getWorld()`, long before any
overlay exists, so the registry is **not** created there. `_runBuild` creates
`world.registry = new PropRegistry(overlay)` after the provider race (§4.1) and immediately
before `ensureBuilt`; `dispose()` nulls it. A volatile world (the maze) therefore starts every
rebuild with a fresh registry and never accumulates `#n` claims across visits. Worlds whose
primitives do not use the registry yet simply leave it empty.

### 6.2 Primitive changes (three lines each, at the point geometry + matrix are already in hand)

| primitive | matrix lives in | move | remove |
|---|---|---|---|
| `GeoBatch.add(geo, matrix)` — medieval, station, dock | the `matrix` argument | swap before `applyMatrix4` | return without adding |
| `Batch.add` — citadel, race | same | same | same |
| `instanced(geo, mat, entries)` — station kits, dock | tuple array | rewrite the tuple | drop it; instance count shrinks by one |
| `_instanced(geo, mat, placements)` — sports | placement array | same | same |
| `buildPropField(spec, ctx)` — planets | `points` array | same | same |
| `_bake(geo, mat, matrix)` — space dock | the `matrix` argument | as `GeoBatch` | as `GeoBatch` |
| **inline `new THREE.InstancedMesh`** — medieval (17 sites: trees, bushes, rocks, reeds, grass, setts, puddles, figures…), citadel + oasis (4), race (3), planets (3), space dock (3), belt (1) | a local array of items turned into matrices in a `setMatrixAt` loop | `registry.instances(family, items, toTransform)` filters/rewrites the array **before** the loop — one line per site, ~31 sites | same call drops the item |
| `MazeBatches` — maze | per cell | **out of scope** | **out of scope** |

**How a primitive reaches the registry.** `Batch`, `_bake` and the inline sites are world
methods and read `this.registry`. `buildPropField` receives an ad-hoc object literal from
`PlanetWorld.js:1833`, not `world.ctx`; that call site adds `registry: this.registry` to the
literal. `GeoBatch` — **two classes**, `src/worlds/MedievalWorld.js:895` and
`src/worlds/station/StationKit.js:978` (dock and the station zones import the latter), both
patched — has a no-arg constructor and `instanced()` is a module function, so both take it
explicitly: `new GeoBatch(registry)` (37 construction sites, mechanical)
and `instanced(geo, mat, entries, { registry, family })` — `instanced` already has an `opts`
argument. Sports' `_instanced(geo, mat, placements, cast = true, receive = true)` keeps its
positional booleans and gains a sixth `opts = {}` for `family` (it is a world method, so the
registry is `this.registry`). A primitive handed no registry behaves exactly as today.

**Family key.** `GeoBatch.add(key, …)` and `Batch.add(key, …)` already take a string key: that is
the family. `instanced`, `_instanced` and `_bake` take **no key** (`_bake` buckets by the
`Material` object), so they gain an optional `opts.family`; absent that, `mat.name`, then
`geo.name`. A prop whose primitive resolves **no** family is still emitted exactly as today but is
not registered (unaddressable), and dev builds log the site once. Stage 4 adds `family` at the
station/dock `instanced` call sites; `buildPropField` and the inline sites name their family at the
call. Where a `GeoBatch.add` caller has already applied the matrix to the geometry, the call site
passes the matrix through — the only other per-site edit, and only where needed.

Post-build derivations run unchanged: station `_settleScatter` / `_solidifyProps`, citadel
`_splitDistricts` and its LOD twin, medieval AO bake. By the time they run the prop is simply
elsewhere or absent. Citadel's shared `mulberry32` stream is unaffected because a remove skips
*emission*, not the random draws that precede it.

### 6.3 Colliders

The ~140 `physics.add*` calls in worlds (`addBox` 65, `addRotatedBox` 60, `addHeightfield` 6,
`addBoxFromObject` 5, `addTriangleSoup` 1, bare `add` 3) stay as they are. Post-build,
`MapOverlay` walks the registry and, for each consumed overlay id, takes the authored AABB from
`record`:

- **Move** — the existing `_moveColliders` heuristic, unchanged: colliders whose **centre** lies
  in the authored box are shifted by the delta. Its documented failure mode is under-moving,
  which is safe.
- **Remove** — that heuristic would invert to **over-removing** (a fence post whose centre sits
  inside a house-sized box would vanish with the house). So a remove drops only colliders whose
  **own AABB is contained** in the authored box expanded by 5 cm. Sites whose colliders are
  index-paired with the item array (inline `InstancedMesh` sites, station `_solidifyProps`) never
  emit the collider for a removed item, so the sweep correctly finds 0 there.

Same code path and tests for the move case, fed by the registry instead of `setFromObject`.
Heightfields never move.

Station is the exception that needs no work: `_solidifyProps` derives its prop colliders from
the instance matrices *after* they have been rewritten, so those colliders are already at the new
spot and `applied[].colliders` reads 0 for such a move. The editor labels that "colliders built in
place" rather than treating 0 as "none came".

### 6.4 Players

Player clients fetch the overlay at build exactly like admins (they must, to see the same world).
They build no report and sample no grid. Added cost: one cached fetch per world per session.

## 7. Layout report (`POST /api/admin/map/report`, admin client only)

```
{ world, appliedVersion, builtVersion, schema: 2,
  bounds:  { min: Vec3, max: Vec3 },                       // world.bounds
  shapes:  minimapShapes,                                   // rect | circle | path, as Minimap.js draws them
  objects: [...today's named catalogue],                    // unchanged
  props:   [{ id, family,                                   // NEW, from registry.entries()
              authored:  { position: Vec3, yaw, aabb: {min, max} },
              effective: { position: Vec3, yaw, aabb: {min, max} } | null }],   // null = removed this build
  ground:  { originX, originZ, step, nx, nz, layers: 4, heightsCm: <base64 Int16> },   // NEW
  applied, unresolved }
```

- **`appliedVersion` vs `builtVersion`.** `MapOverlay` re-fetches on every `world:changed`, but a
  cached world was built against whatever version existed at build time. `builtVersion` says which
  version the `props[]` reflect. An `{id}` entry that exists in the applied document but was not
  `consumed()` by the build is reported `unresolved` with reason **`pending-rebuild`**, not `name`,
  and the editor shows it as "applies on next world load".
- **Ground grid — layered, because roofs collide.** The station's dome is a real collider and
  `bounds.max.y` (164 m) lies under it; planets reach 260 m, above `groundHeight`'s default 200 m
  start. So the probe starts at `bounds.max.y + 10`, and each cell records **up to 4 hits** from the
  top down (re-casting from 1 cm below each hit), padded with `INT16_MIN`. The dome is layer 0 and
  the deck under it is layer 1; the conflict rule (§9) uses the nearest layer at or below the
  candidate y, so a hub-deck placement reads "on surface", not "underground".
- **Resolution.** `step = max(4, ceil(extent / 256))` metres so `nx, nz ≤ 256` — 4 m for a ±450 m
  medieval, 6 m for the ±744 m station. Storage is `nx × nz × 4` Int16 (cm): ≤ 524 KB raw,
  ≤ 700 KB base64, under the caps below.
- **Cost.** Sampling runs on `engine.onFrameUpdate` (so `MapOverlay` is constructed with `engine`
  in addition to `{bus, physics, loot}`), under a **2 ms per frame** time budget rather than a ray
  count. A cell costs 1–4 casts through the 12 m broadphase; the station's ~62 k cells are expected
  to take 10–30 s after the loading gate, during which the editor banner shows "layout: sampling…".
  If the admin leaves the world before sampling finishes, no report is sent and the previous one
  stands. `frame-gaps.mjs` is the gate that this budget holds.
- **`builtVersion`** is stored by `_runBuild` as `world.builtVersion` (0 when no overlay was
  available) — it exists from stage 2, before the registry does.
- **Storage**: `map_world_reports` gains `layout JSONB NOT NULL DEFAULT '{}'::jsonb`,
  `layout_schema INTEGER NOT NULL DEFAULT 0` and `built_version INTEGER NOT NULL DEFAULT 0`.
  `ensureMapOverlaySchema` is documented as additive `CREATE TABLE IF NOT EXISTS` only; this adds
  the first `ALTER TABLE … ADD COLUMN IF NOT EXISTS` statements to it, in the same idempotent
  style. `reported_at` already exists and is returned as `reportedAt`. `recordWorldReport` validates and clamps every field (props ≤ 20 000,
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
  ("snap Y to ground", on by default) — specifically
  `ground(x, z, y_current) + (y_current − ground(x_current, z_current, y_current))`: the nearest
  layer at or below the prop's *current* effective y, **plus the prop's authored sink or lift**,
  so a crate dragged across the station hub stays on the deck rather than jumping onto the dome,
  and a deliberately half-buried rock stays half-buried instead of popping to the surface and
  then tripping `underground`. Yaw is a ring handle on the map and a degrees field.
- **Remove**: adds a `remove` entry; the map draws the prop struck-through until saved. Marketplace
  placements are removed by deleting their entry, as today.
- **Place**: click empty ground → choose an item from the existing marketplace dropdown → a
  `place` entry at that spot with Y from the **lowest** layer under the click. When the cell has
  more than one layer (deck under dome, room under roof) the selection panel shows a layer picker
  ("Deck 2.4 m / Roof 158.0 m") so a rooftop placement is one click, never a guess.
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
`conflicts(entry, layout | null, document) → Array<{ level: 'error' | 'warn', code, detail }>`.

**Occupancy is layout composed with the document.** A prop occupies its `effective` transform
from the layout, **overridden** by the document's own entry for that target when one exists
(moved → at the new spot; removed → occupies nothing). So a `remove` saved last week does not make
its target vanish from the map — it is drawn struck-through from `authored` — and a moved prop is
tested for overlap where it now stands, not where it came from.

| code | level | rule |
|---|---|---|
| `out-of-bounds` | ⛔ | x/z outside `bounds` (5 m margin) or \|coord\| > 20 000 |
| `unresolved-target` | ⛔ / ⚠ for `{id}` | id absent from the layout's **authored** ids. ⛔ when the entry was **added or edited in this session** (a fresh mistake); ⚠ when it was already in the current saved version (inert, and blocking it would make the whole document unsaveable after one art pass). The pending list offers **"drop unresolved"** to clear them in one click. |
| `stale-name` | ⚠ for `{name}` | name absent from `objects[]`. Advisory only: the catalogue is capped at 2 000 and a world with **no layout yet** must still save free-text moves as it does today. |
| `duplicate-target` | ⚠ | two entries act on the same target. v1 allowed this (last wins), so existing versions must stay saveable: the normaliser keeps the **last** entry and reports the dropped one, mirroring the existing entry-id `duplicate` reject. |
| `underground` | ⚠ | footprint bottom < ground(x, z, y) − 0.25 m |
| `floating` | ⚠ | footprint bottom > ground(x, z, y) + 1.5 m |
| `no-ground` | ⚠ | no layer at (x, z) — water, a hole, off the deck |
| `overlap` | ⚠ | the entry's footprint intersects another occupied footprint or another entry's footprint; names the offender |

**Footprints.** `{id}` entries and `props[]` have real AABBs. `{name}` targets and `objects[]`
carry only a position (`_catalogue` reports `{name, position}` and computing a world AABB for
2 000 arbitrary groups is not free), so they are validated **as a point**: "footprint bottom" is
`position.y`, and for overlap a named object is a 1 m-radius disc. `place` entries take a footprint
from a small per-item size table (default 1 × 1 × 1 m).

`ground(x, z, y)`: for each of the cell's four corners pick the nearest layer **at or below** `y`
(a corner with none takes its lowest layer; a corner with no layers at all is *no sample*), then
interpolate bilinearly. Per-corner, because at a dome or roof edge the corners have different layer
counts and "layer k" is not one surface across the cell. Under the station dome this picks the deck,
not the roof. When `layout` is `null`, only `out-of-bounds` (against the ±20 000 limit),
`duplicate-target` and `unresolved-target` for `{id}` apply.
On save the route runs the same function; error-level results are returned as
`rejected[{index, id, reason}]` and nothing is written (the existing single-transaction rule with
the audit row holds). A client that skips the check cannot save an invalid document.

## 10. Failure modes

| situation | behaviour |
|---|---|
| overlay fetch fails at build | world builds with no overlay; logged once; editor banner shows "layout: unavailable" after the next report |
| a primitive throws on an entry | caught per entry → `unresolved: {id, reason: 'error'}`; the rest of the world builds |
| id gone after an art pass | `unresolved`; editor flags it ⚠ (not ⛔ — it was already saved), "drop unresolved" clears it; the rest of the document stays saveable; world unaffected |
| admin leaves before the grid finishes | no report sent; previous layout stands; banner shows "layout: sampling…" while in-world |
| cached world built against an older version than the one just saved | the new `{id}` entry is reported `unresolved: pending-rebuild`; editor shows "applies on next world load"; `builtVersion` in the report says what `props[]` reflect |
| overlay provider times out (1 500 ms) on a **background** build (behind the loading gate there is no timeout) | world builds with no overlay; the post-build applier still applies named-object moves live; the build's `builtVersion` is 0 |
| v1 client reads a v2 document | `remove` silently skipped, `{id}` moves → `unresolved: name`; no crash |
| report too large / malformed | 413/400; prior layout kept; game logs and moves on |
| save with an error-level conflict | 400 with `rejected[]`; nothing written; no audit row |
| `HMAC_SECRET` missing on save | unchanged: save and audit are one transaction; both roll back |

## 11. Testing

Each gate measures what the game actually does (a gate that measures something the game does not
do is worse than no gate — this repository has paid for that nine times).

- `PropRegistry` — `node --test`: id stability under insertion elsewhere, `#n` collisions,
  resolve/remove, `consumed()` → unresolved, matrix composition keeps scale and replaces rotation
  with pure yaw (tilt dropped, per §6.1 — the test asserts the drop, not its preservation).
- Per primitive — build one world headlessly (`scripts/tests/_flightrig.mjs` dom harness, no
  WebGL) with an overlay that moves one prop and removes one; assert the registry entry, the
  affected bucket's vertex count, and `physics.colliders` count and centres. Planets first.
- Idempotence — build the same world twice with the same overlay → identical registry and
  collider set.
- `mapConflicts.ts` — vitest table tests for every code; bilinear lookup at cell edges and at
  `INT16_MIN` cells.
- Schema v2 — normaliser round-trip, `hidden` → `remove` migration, mixed name/id targets, every
  new reject reason; extend `mapOverlaySchema.test.ts` and `mapOverlayRoundTrip.test.ts`.
- Report route — size caps, base64 grid validation, layered-grid decode, layout column
  round-trip, `builtVersion`; extends the POST tests in `mapAdminRoutes.test.ts` (which call the
  real handlers). The admin gate itself is already walked by `adminRouteGuards.test.ts`.
- `mapProjection.ts` — world↔screen round-trip, hit-testing, pan/zoom.
- `PropRegistry.instances` — filters and rewrites an item array without disturbing untouched
  items' order (inline `InstancedMesh` sites depend on index-paired collider arrays).
- Editor — Playwright: sign in as admin, seed a layout, load `/admin/map`, click a footprint, assert
  the selection panel, drag, assert the pending entry and its warning, save, assert the version.
- Perf — `scripts/frame-gaps.mjs` on station **with sampling actually running** shows no new
  hitch frames. Sampling is admin-only and the harness boots with no session, so as-is the gate
  would measure a run in which the sampler never starts — the exact trap §11 opens with. The
  sampler therefore also runs under `?dev=1&layout=sample` (the harness's existing dev switch
  family), discarding the POST; `frame-gaps.mjs` passes it and its `summary.json` records
  `layoutSampled: true` next to the numbers so a run that lost it cannot be read as one that did
  not (`report.json` is `world-shot.mjs`'s file, not frame-gaps'). `scripts/world-shot.mjs` budgets (draws, programs, triangles) and the `[World] built`
  timing stay unchanged for every world touched (the AABB cache in §6.1 is what keeps the build
  time flat).

## 12. Staging

Each stage ships on its own; the editor is useful from stage 1.

1. **Editor + layout report + conflicts** over today's named objects, with `bounds`, `shapes` and
   the layered ground grid — the map works for every world immediately. Ships the
   `layout === null` rule (§9) so a world nobody has visited still saves free-text moves on day
   one, and `MapOverlay` gains `engine` for the sampler. Purely additive: nothing in the build
   path changes.
2. **Schema v2 + `remove`** with the containment collider drop for named objects; `hidden`
   migration; the overlay provider wired into `_runBuild` (§4.1) with `world.builtVersion` and
   `pending-rebuild` reporting — the build-path change lands here, where its first consumer
   (`builtVersion`) is, rather than in stage 1 with none.
3. **`PropRegistry` + planets + space dock** (`buildPropField`, `_bake`, and their inline
   `InstancedMesh` sites) — proves the primitive pattern end to end, including the registry
   creation point in `_runBuild`.
4. **Instancing** — `instanced` (station kits, dock; adds `opts.family` at the call sites),
   `_instanced` (sports), and the ~24 remaining inline `InstancedMesh` sites (medieval, citadel,
   oasis, race, belt).
5. **`GeoBatch` / `Batch`** — dock, race, station structures, medieval, citadel; last, largest
   files, coordinated with whichever art branch is open.

Estimate: stages 1–2 ≈ 4–6 agent-days; stages 3–5 ≈ 7–12 agent-days (the inline sites added
about a day). Maze excluded by design.

## 13. Out of scope

- Live (no-reload) editing of merged props.
- Maze hedges and cells.
- Editing world *source*; the overlay remains the only thing written.
- Multi-user editing; the existing optimistic version check remains the concurrency model.
