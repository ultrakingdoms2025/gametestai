# Map editor: graphical map, conflict warnings, select-to-move, remove

**Date:** 2026-08-27
**Status:** Stages 1 and 2 built (§14 records where the tree departs from the sections above); stage 3 (`PropRegistry`, planets, dock) next.
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
| a page still on the previous bundle reads a v2 document (the deploy window; stage 2) | known: every `remove` is skipped unapplied and unreported, `{id}` entries are reported `name`, and the report posts no `builtVersion` (stored 0) — until the page reloads; no crash. The applier's one-release `hidden` arm covers only the reverse, a site rollback under a cached new bundle (§14 stage 2) |
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

## 14. Amendments as built (stage 1, 2026-08-27)

Stage 1 was executed from `docs/superpowers/plans/2026-08-27-map-editor-stage1.md` on two branches (`map-editor-game`, `map-editor-stage1`). Where the tree differs from the sections above, the tree is right and this section records why. Nothing here changes stage 2's scope.

**§7 Layout report.**
- The game sends **two** reports per world entry: an immediate one (`layoutSchema`, `bounds`, `shapes`, catalogue) and a second carrying `ground` once sampling finishes (~15 s at station, under 2 ms per frame). If the admin leaves before sampling finishes, only the **ground** of the previous report stands — `objects`, `bounds`, `shapes` and `reported_at` were already replaced by the immediate report.
- An invalid or mismatched layout is **not** refused with 413/400. The route stores the catalogue, keeps the prior layout, and answers 200 with `{ ok, layout: 'stored' | 'kept-prior' | 'none', warnings }`; the game warns on anything but `stored`. 413 is reserved for bodies over 4 MB (declared or measured); Vercel's own 4.5 MB platform limit sits above that.
- `ground` is a layered grid (up to 4 layers, layer 0 topmost, Int16 centimetres little-endian, base64, index `((j*nx)+i)*layers+k`, `NO_SAMPLE = -32768`, ~2 cm resolution from a 1 cm peel with skip-and-re-cast); `step = max(4, ceil(extent/256))`; `floorY = bounds.min.y - 20`. Trimesh undersides read as layers (no back-face culling in `_raycastCollider`) — a stage-2 item.
- There is no "layout: sampling…" banner state: the site cannot tell sampling from left-early. The banner reads `reported <age> · N shapes · no ground grid yet` until the second report lands; the editor does not poll — reload or switch world to see the grid.
- `?layout=sample` samples but never POSTs, and is honoured only with the dev switch.

**§8 Editor UI.** The canvas emits `onSelect` / `onDrag` / `onPlaceAt`; there is **no ring handle** (yaw is the selection panel's degrees field) and **no prop footprints** (they arrive with `{id}` targets in stage 2). Pixel-drawn marks hit-test with `r: 0`. "[ Remove ]" in the mock is a **Hide** checkbox on the retained `hidden` flag; a loaded hide-only entry cannot be un-hidden from the checkbox (its position is unknown). Place mode: click, or Escape to cancel. The layout reference stays stable across load/save/revert so pan/zoom never resets mid-session.

**§9 Conflicts.** A named object is a **1 m centre-to-centre clearance** (0.5 m radius), not a 1 m-radius disc. Hidden objects **occupy** (the game keeps their colliders — at the new position when one is given). The **last** move per name wins (the game applies in order). Verdicts compare integer millimetres so the panel and the route agree exactly; only `out-of-bounds` (5 m past the reported bounds) is an error; `duplicate-target`, `stale-name`, `underground`, `floating`, `no-ground`, `overlap` warn. When `layout` is null nothing is judged — the normaliser's ±20 000 reject drops such an entry from the save rather than refusing the document. Overlap uses a 4 m bucket grid in `prepare()` (1.4 ms median at 2 000 objects × 500 entries).

**§10/§11.** The save gate refuses with `400 { error: 'conflicts', rejected: [{ index, id, reason }] }` inside the transaction (`ROLLBACK`, no audit row). The e2e is a zero-dependency CDP harness (`site/scripts/map-editor-e2e.mjs`), not Playwright; it signs in through the real form, exits 2 `SKIPPED … NOT a pass` without `MAP_E2E_EMAIL`/`MAP_E2E_PASSWORD`, refuses to seed a non-loopback database without `--allow-shared-db`, and needs `--url` for a 2FA account. DB-backed tests run only where `POSTGRES_TEST_URL` is set (CI has no Postgres; the emitted SQL is gated by fakes). CI's frame-gaps run does NOT pass `--layout-sample`: it was added (`d828053`) and withdrawn the same day after run 33177408325 showed the runner renders 32 frames in a 625 s window — a frame-driven sampler cannot finish there at any fuse. The sampler's cost is evidenced by hand runs (`perf.md`); measuring it in CI needs a runner that renders.

### Stage 2 (2026-08-28)

Stage 2 was executed from `docs/superpowers/plans/2026-08-28-map-editor-stage2.md` on one branch (`map-editor-stage2`, branched at `81fd9ec` — the plan commit over the hotfix `1e020b9`, the last of the collider-leak and late-document hotfixes `8afa2a2` and `9b16768` with their bundles `cfe1320` and `1e020b9`). Where the tree differs from §1–§13, from the plan's shared-interfaces block, or from stage 1's block above, the tree is right and this block records why. Owner decisions A–K are in the plan; the ones the tree bends are named where they land. Counts and the perf record are at the end.

**Chunk 1 — the applier's `remove` (§6.3; decision B).**
- A `{name}` remove hides the object and drops every collider whose world AABB (`Physics.colliderAabb`) lies inside the object's box padded by **0.10 m per axis** (`REMOVE_TOLERANCE`), not §6.3's 5 cm: authored medieval collider boxes overhang their walls by up to 8 cm, so 5 cm found nothing there. Excluded by type: heightfields. Excluded by tag: any collider with non-null `userData` — the inventory at the time is PlanetWorld's floor, liquid barriers and edge walls, Portals' plinths, and Piloting's landed ship hulls; `World.addSolid` and SportsWorld's `_solid` forward `opts.userData`, but no prop call site supplies one. `solid` and `layer` are not consulted (a trigger inside a removed prop belongs to it, as the mover already treats it). More than **200** colliders inside one box (`MAX_REMOVE_COLLIDERS`) refuses with `unresolved: span` and hides nothing. `applied[].colliders` is the count dropped; 0 means "hidden, but nothing dropped — it may still block", which the editor says as a warning, not §6.3's "built in place" (a station/`{id}` rule for stage 3).
- The undo restores `visible` only and re-adds nothing: `WorldManager._activate` rebuilds physics from `world.colliders` before it emits `world:changed`, so on a re-entry every collider is already back, and after a portal the physics belongs to another world. A `dispose()` on a live world would leave the dropped colliders out — nothing calls it at runtime.
- `Physics.colliderAabb` answers an **empty** box for a collider type it does not know, and the sweep tests `isEmpty()` before `containsBox`: three.js holds an empty box inside every box, so without that test any remove would drop every unknown collider in the world.
- **The terrain-tile remove, ruled on 2026-08-28.** A sub-cap container remove — a 100 m `medieval:terrain:ix,iz` tile is a catalogue name — drops every collider fully inside it while staying under 200: the buildings stay visible in their batches with nothing solid left in them, and the report says `{ ok, colliders: 47 }`. The owner ruled that the editor's warning above **8** colliders (`WIDE_REMOVE_COLLIDERS`, a guessed number with no measured per-prop maximum behind it) is sufficient: the applier does not refuse, and decision B stands as written.

**Chunk 2 — schema v2 (§5, §8, §9; decisions A, D, F).**
- `MAP_OVERLAY_SCHEMA = 2` on the site, `OVERLAY_SCHEMA = 2` in the game, pinned equal across the boundary. `remove` is a kind. A v1 `move` carrying `hidden` becomes a `remove` **on read**, its position and rotation discarded (decision A; production held 0 overlay rows when this was decided); one raw entry is one entry or one reject, so `rejected[].index` stays a raw index. A `move` with a null or absent position rejects `position`. A revert is a write — `revertOverlayTo` re-saves through `saveOverlayVersion` — so a reverted v1 document is stored as a v2 document with `remove` entries.
- `{id}` targets are accepted (`family@x,z[#n]`, the family may be namespaced, ≤ 128 characters, refused rather than truncated). The grammar is `TARGET_ID_RE` in `site/lib/mapOverlaySchema.ts`: a family of `[A-Za-z0-9_.-]+`, namespaced with `:` (`sports:goal@1,2`); each coordinate an optional `-`, digits, and at most **one** decimal; an optional `#\d+`. So `house@12.34,5`, `house@1e3,5`, `sports:_instanced/goal@1,2` and a family with a space are all refused — stage 3's registry ids must round to 0.1 m and write one decimal, and a catalogue *name* like `medieval:terrain:3,5` is not an id. A target with both `name` and `id`, or neither, rejects `target` (`readTarget`); the applier's both-is-id reading (`targetId`) is unreachable from a saved document. Nothing resolves an id until stage 3: the game reports an `{id}` entry `pending-rebuild` when the document is newer than the world's build, else `id`; §9's `unresolved-target` is deferred to stage 3 with `props[]`.
- Decision F — the last move-or-remove of a name wins — holds at the **applier**, not only in the editor's verdict: in-order application let a remove win in both orders, so the applier runs a per-name last-action pre-pass (`actionKey`, in separate `id:`/`name:` key spaces so an `{id}` and a `{name}` never collide) and reports each superseded entry `unresolved: superseded` — a tenth reason the plan's list of nine lacked. A v1 hidden move takes part in the pre-pass as a remove.
- §9 conflicts: a removed target **occupies nothing** — reversing stage 1's "hidden objects occupy", which was right for a hidden move (the game kept its colliders) and is wrong for a remove (the game drops them). `{id}` entries are judged for bounds only — never occupants, no name rules — and an `{id}` and a `{name}` on one object cannot warn each other until stage 3 knows which object an id is. The bucket-grid oracle test covers no removes. The normaliser keeps both a move and a remove of one name (both warn `duplicate-target`; §9's "keeps the last" is stale).
- The game keeps reading `hidden: true` as a remove for **one release**, so a site **rollback** under a cached new bundle — this applier reading a raw v1 document from the previous site — does not let hidden objects reappear. It does not cover the other direction: a page still on the previous bundle runs the OLD applier, which no arm in this one can help. That old-bundle window is a **known failure mode** (also in §10): a page still on the previous bundle reading a v2 document skips every `remove` unapplied and unreported (the object stays visible and solid, in neither `applied` nor `unresolved`), reports `{id}` entries as `name`, and posts no `builtVersion` (stored 0) — for one page lifetime, until it reloads; production held 0 overlay rows when this shipped. **Removal date: the release after `4ace9a8`** — delete the `entry.hidden === true` arm of the applier's dispatch and its two tests then.
- The game warns **once per instance** on a document whose schema is newer than it reads (`_schemaWarned`, strictly `>`, never reset), in `_admit`, whichever read path saw the document first.
- Every string the site cuts goes through `cutCodePoints` (eight cut sites: `readName` — every name, a target's included — author, note, config values, the catalogue names, the applied ids, and the unresolved ids and reasons; a target *id* is refused over 128, never cut), so a cut never splits a surrogate pair; `readName`'s trim → cut → trim is a fixed point. The result is also `.toWellFormed()` (added in chunk 4): an already-malformed admin string becomes U+FFFD — what the TEXT columns already did — instead of a 500 at `::jsonb`.
- §8 editor: [Remove] replaces stage 1's Hide checkbox; REMOVE rows take `KIND_COLOUR`; the removed mark is struck through and `draggable: false`; `unresolvedText` is wired into the report card; a hint says a remove is lossy; `removeWarnings` fires on `colliders: 0` and on `> 8`, skipping `!a.ok` rows.

**Chunk 3 — the overlay reaches the build (§4.1, §6.4; decision G).**
- `_runBuild` awaits `this._overlayVersion(world, report)` between `report(0, …)` and `ensureBuilt`: **8 s** behind the loading gate (`OVERLAY_GATE_MS`) — not "no timeout": a hanging fetch must not hold the boot, and would fail frame-gaps as `timedOut` rather than as itself — and **1 500 ms** otherwise (`OVERLAY_BACKGROUND_MS`), where "otherwise" is a portal forcing an unbuilt destination and every `WorldPrefetch` preparation. No provider on ctx: no await, no timer. The loader says `Reading the map for <name>`, then `Generating <name>` (an anonymous boot flashes the label too — cosmetic). `overlayGateMs`, `overlayBackgroundMs` and `now` on the manager, and `lookupAbortMs` on `MapOverlay`, are instance seams for the tests.
- **The session breaker** (absent from the plan). "A stalled provider delays a gateway by at most 1.5 s per world" was wrong at scale: seventeen background builds against a hanging provider would each pay 1.5 s. As built, a **background** timeout opens `_overlayBrokenAt`; a gate timeout never does (the player is already waiting, and the gate's 8 s is the fuse). While it is open, background builds skip the provider and build at 0. After `OVERLAY_BREAKER_RETRY_MS` (60 s) exactly **one** background build probes, re-stamping the breaker from its own start — the latch sits in the same synchronous step as the check, because `report(0)` awaits before the try. Any in-fuse answer, null included, closes it; so does a document landing later from an abandoned lookup, and `dispose()`. The rule now reads: a stalled provider costs **1.5 s once a minute per session; inside the minute a gateway is held for nothing.**
- The manager's warning is once per **outage** per world (`_overlayWarned`, cleared by any in-fuse answer and by `dispose()`), not "once per world id". In production it is reachable only on a timeout: the wired provider never rejects.
- `src/systems/overlayVersion.js` / `versionOf` is a new contract-pinned leaf — `max(0, floor(Number(v) || 0))` — used by `_overlayVersion`, the cache's monotonic write, `_applyDocument` and `_builtVersion`, so no two readers can disagree about which document is newer. `Infinity` passes through by design (unreachable from a JSON number). Contract-check counts **133** files, not the plan's 132.
- `MapOverlay.lookup` / `prefetch`: one cached document per world per session (`_cache`), version-monotonic; admitted documents and their `entries` are frozen (shallow); `_admit` is shared by both read paths. One `_inflight` fetch per world, with an `AbortController` at `LOOKUP_ABORT_MS = 10 000` — pinned longer than the 8 s gate fuse, so a race the manager lost still closes the breaker when the document lands. The entry read has no ceiling of its own and is aborted by `_restore` on leaving (`_visitAbort`); `dispose()` aborts every lookup and clears the cache. An abort is never said by `_read`; a lookup abandoned at the 10 s ceiling is said once per world. §6.4's "one cached fetch per world per session" is, as built, **one lookup per build plus one `no-store` read per entry**; the entry read refreshes the cache, so a volatile rebuild after an in-session save builds against **the last document an entry fetched** — not necessarily what was last saved.
- `main.js` issues `mapOverlay.prefetch(startWorld)` **before** `materials.warmup` (the plan placed it after `const startWorld`, which serialised warm → round trip → build), gated on `accountStatePromise` resolving. Signed out it answers null promptly — no GET, no fuse, no breaker; a signed-out provider that answered slowly would open the breaker on the first background build. The trade: the 10 s abort starts at the prefetch, the 8 s fuse at the build; a warm-up over 10 s costs a second GET; a warm-up over ~2 s against a dead server, once silent, is now said by the lookup ceiling.
- The report carries `builtVersion` beside `appliedVersion` on **both** POSTs of a visit and on `map-overlay:applied` (the no-document publish carries the world's). The `{id}` gate compares `versionOf` on both sides. `pending-rebuild` in stage 2 means only "the document is newer than the build": nothing consumes an `{id}` until stage 3 (decision D's residual), and the editor's label is hedged to say so.
- `_read` says a thrown fetch every time (no dedupe — console noise offline, not a defect). A **refused** read (`!res.ok`) is said once per world for `status >= 500` only (`_readRefused`, cleared when a document for the world is admitted and by `dispose()`); 401 (anyone signed out — an expired admin session is indistinguishable here) and 404 (a host without the route: the frame-gaps static server) stay silent, because the entry read is issued for every player on every world change. One outage can therefore say up to **three** lines in different words — the manager's fuse, the lookup ceiling, the refused read — once each per world.
- `WorldManager.dispose()` does not cancel an in-flight `_overlayVersion` (reuse-after-dispose only).

**Chunk 4 — `built_version` (§7, §8, §10; decision C).**
- `map_world_reports.built_version INTEGER NOT NULL DEFAULT 0` is the **third** additive `ALTER … ADD COLUMN IF NOT EXISTS`. The upsert sets `built_version = EXCLUDED.built_version` **outside** the layout-schema CASE — a report says what its build consumed, and a kept-prior layout still replaces it; `readWorldReport` returns it; the report route forwards it (typed body and named call); `builtVersion` is one of the six fields of the admin GET's annotated `report` literal. **Both** version columns clamp `0..2147483647` (`clampVersion`): a forged 1e300 would otherwise refuse the whole INSERT, catalogue included. The report carries no `schema`; `LAYOUT_SCHEMA` stays 1. The manual Postgres gate ran locally, 41/41 with the column present (`db-run.txt`).
- `versionStatus(applied, built, saved)` has **four** states: current; behind ("enter the world in game" for applied, "reload the world in game" for built); ahead of this page; and, for `built === 0 && applied > 0 && saved > 0`, "(built with no overlay — reload to build against vN)". A built 0 has **five** causes — no session, the gate fuse, the breaker, a refused read, and the ordinary first use where nothing was saved yet — and the card cannot tell them apart, so the line names none (an earlier wording blamed "not signed in"). §10's "layout: unavailable" banner is not built; a build with no overlay is said by the report card's built-version line, which cannot name the cause.
- `unresolvedText` labels all **ten** applier reasons — `name | span | pending-rebuild | id | superseded | error | item | no-loot | position | pool` — from an exported `APPLIER_REASON_TEXT` map, and `site/lib/mapReasonsContract.test.ts` reads `src/systems/MapOverlay.js` textually and holds the two sets equal in both directions. It exists because the applier had reached ten reasons while the card labelled five and the other five printed raw, with every unit test green. `pending-rebuild` reads "newer than the world's build — reload; ids resolve from stage 3".
- The seven `not.toMatch(lone)` assertions on JSON text were vacuous — a well-formed `JSON.stringify` writes a lone surrogate as six ASCII characters — and now match the `\ud8xx` escape, with a self-check proving the instrument bites on the untouched store.
- The game GET serves `schema: MAP_OVERLAY_SCHEMA` (the constant) over row entries the store has already migrated, and 503 over a broken document — both pinned in `mapAdminRoutes.test.ts`.
- The e2e seed carries `builtVersion`; an optional step 7 removes an object, photographs the `colliders: 0` warning (in-page GET for the entry id → POST a report → reload → `[data-e2e="report-remove-warnings"]`) and reads both version lines; steps 6 and 7 wait for the Save label. It has **never been browser-run** — the credentialed run is the owner's.

**Chunk 5 — `planGrid`, and the evidence (decisions H, I).**
- `planGrid` uses `ceil` on both axes: a 1 300 m extent plans 218 samples, so the far-edge band is sampled (station's 1488/6 and medieval's 900/4 are unchanged); `nx`/`nz` are header-carried and `LAYOUT_SCHEMA` is still 1.
- **Perf** — the after-run at `52b182f` (game code `0eaf5d2`, bundled as `56d0068`) against the chunk-3 base taken at `a2ed2cd`, same machine, harness browser and idle set (`perf.md`). Cold boot: `over` 11 / 11 / 11 against 10 / 12 / 11; `worst` 4224.7–4231.9 ms against 4122.1–4229.3 — +2.6 ms over the base max, 0.06 % of a 4.2 s frame whose own base spread was 107 ms; `warm.programs` 142 ×3 on both; counters identical; `pageErrors` none; `[boot] title card up` inside the base spread, so the new session await left no mark. The chain-warmed gate passed 3/3 with `builtBefore: true` on both entries; `entry:medieval` 705.1 / 704.6 ms on re-run against the base 705.2 (the first after-run's 1006.9 was a single-frame one-off). 36 world views (station ×2, medieval, cinder) Δ0 on `worldTriangles` and on terminal `programs`; `drawCalls` jitters ±18 on identical geometry and a mid-sequence `programs` count is a sliced link being sampled — only triangles and terminal programs are assertable. **The `layout` row is unattributed.** With the sampler on (`--layout-sample`, chain-warmed) it reads `over` 1 / 2 / 1 where stage 1 read 0: one 300–400 ms frame at ~46 s of page time with zero program, geometry or texture delta — the same frame appears in sampler-free chain-warmed runs on both trees (2 of 4), and stage 1's 0 is a single number from a different tree with no measured floor here. It is not closed as "within noise" and it is not shown to be a sampler regression; settle it with an alternating A/B on one tree (sampler on / off, counting ≥ 250 ms frames in the 24–52 s window). The sampler itself finished 3/3 (62 001 cells in 34.0–34.5 s). **The signed-in boot cost is reasoned, not measured:** the harness has no session, so every after-run took the anonymous path, whose only new wait is a settled promise; a title-card reading on a signed-in boot is still owed.
- Harness facts learned on the way: carnelian has no framings (`Harness.js` VIEWS), so cinder is the planet comparison; the harness prints no cross-run spread — read `summary.json` by hand; `[map-overlay]` lines are invisible to frame-gaps' console filter (six prefixes); "Reading the map" is a boot-card label, not a console line, so neither harness can see it.

**Counts at the branch tip.** Game `npm test` 3563 (baseline 3503), contract-check 133/133, site vitest 889 across 57 files (baseline 839; two of the 889 are `mapReasonsContract.test.ts`; CI, without the 18 DB-gated cases, reads 871). Every gate green at `52b182f`.

**Out of scope, recorded for stage 3:** `unresolved-target` with `props[]`, and the cross-kind rule for an `{id}` and a `{name}` naming one object; the `{id}` last-wins key must stay the id when ids resolve; the cached document is frozen and must be treated as immutable by every consumer (the stage-3 contract); the composed real-lookup seam (`map-overlay-provider.test.mjs` #22) is the place to extend, not to mock around; the owner's ruling on the terrain-tile remove (given 2026-08-28: the warning above 8 colliders stands, the applier does not refuse); removing the `hidden` arm next release; residual station walls after a remove (trimesh chunks that straddle the box stay); trimesh undersides as layers; deck-edge bilinear Y; a shared `scripts/harness/cdp.mjs`; CI `--layout-sample` (added on main in `d828053`, 2026-08-28); the layout-row A/B; a signed-in title-card reading; a frame-gaps `--overlay-fixture` so the applied path can be measured (today only the no-overlay path is); the credentialed e2e (the owner will verify in production; assumed working for stage 2's close, 2026-08-28).

**Post-release fix (2026-08-28).** The catalogue's `position` is an **anchor**: the world-space bottom-centre of the object's bounds (`Box3.setFromObject`, `{ (min.x+max.x)/2, min.y, (min.z+max.z)/2 }`, 3 dp), falling back to the world position only for a node with nothing to draw (an empty box). A `move` lands that anchor at its `position`: the applier measures the anchor at apply time from the untouched object and translates by the difference, carried through the parent's frame; the colliders move by the same world delta, and the undo still restores the authored transform. Why: the catalogue had reported `getWorldPosition`, and station's named objects are Groups whose geometry is baked in world space and whose own position is the origin - in production 755 of the station's 756 entries read (0, 0, 0), every mark on the map sat on one pixel, and nothing could be selected. The site is unchanged: it draws whatever `position` the catalogue reports, and its ground checks compare that Y with the ground, which for a bottom-centre is exactly "standing on it". Measured on a synthetic tree of 1 000 named Groups (6 000 nodes): 4-8 ms warm, 16.5 ms cold - and cold is what an admin visit pays, once, because rendering computes only the bounding sphere (`StationKit.js:1031`), never the box. `rotationY` turns the object about its anchor: the applier sweeps the colliders first on the untouched box, translates, yaws, measures the anchor again and puts it back at the position given (a rotation-only entry keeps the anchor where it stood); colliders translate but never rotate, for any target. Two shapes a single-point mark cannot help: the station's symmetric ring districts (`hull`, `deck`, `promenade`, `canopy`, `skyline`, `space`, `lights`, `dressing`) anchor at x = z = 0 because their bounds are centred on the axis - inherent to one mark per object, not a regression; and an `InstancedMesh` (`StationActors:*` are named ones) anchors at the union's bottom-centre until stage 3's `{id}` targets address instances. Game code `4ff0e20` (the anchor) and `6935dc6` (yaw about the anchor, the parent-frame test), bundled as `98327ce` and `828d68a`.
### Post-release fix (2026-08-28): the floor under a roof, and the harness's hydration wait

**§7 the ground grid keeps the floor.** The sampler stored the first four surfaces under a cell and stopped, so a column with five lost its lowest. Under the station hub that column reads dome 171.42, canopy 62 / 61.5 / 59.3, deck 0, and the deck was the one dropped: 2 084 of the hub's 3 505 cells (59 %) held four layers with the lowest above 1 m; `placementY` (the lowest stored layer) said "on surface" at 61.5, and the game spawned the placed item on the canopy beam - the pickup at (38.79, 61.5, −38.67) sat on the roof while the player stood on the deck at y 0.08 beneath it. The rule as built (`src/systems/GroundSampler.js`, `d0d14a3`): a cell stores the top L−1 surfaces **and the lowest** - "the top three and the floor" at four layers - because the sampler keeps casting past the cap and every further hit overwrites the last slot. `MAX_LAYERS` stays 4 and `LAYOUT_SCHEMA` stays 1: the grid's shape is unchanged, only which four heights are kept moved, and the site needs no code change (`layersAt` sorts, `groundAt` reads every slot per corner, `placementY` takes the lowest; `MapCanvas` reads slot 0 only - the topmost, which the fix preserves - for its fill, and scans every slot for its range). The cost is bounded by the column - S surfaces cost S hits and one miss, so past the cap a cell pays S − L + 1 extra casts; under the cap nothing changed, the peel still stops at `floorY`, `MAX_SKIPS` still applies, and `MAX_CASTS` (64) is the absolute ceiling a cell can cost, the one constant bound left once the layer cap stopped ending a cell (without it a raycast answering a hair below its origin every time would run ~19 400 casts on station inside one cell, where `run()` never checks its budget). The rule is also pinned through the real `Physics` raycast (`map-overlay-layout.test.mjs`: four slabs at 60 / 40 / 20 / 10 over the deck read `[6000, 4000, 2000, 0]`). **Every world's stored grid is stale until re-sampled: a grid carries floors only after an admin's next visit to that world in game re-samples and re-reports it.** Sampler tests 16 (11 before), layout tests 22 (21 before); game suite 3569; contract-check 133/133.

**§10/§11 the harness types after hydration.** `map-editor-e2e.mjs` typed into `#email` as soon as the selector wait saw it in the SSR HTML. Chrome's input pipeline writes the DOM and `el.value` reads it back, so the typed check passed, but no `onChange` had run: React's state stayed empty, `signIn` posted empty credentials, and step 1 failed deterministically with "sign-in refused". `typeInto` now waits (the harness's `waitFor`, 45 s) until the target carries a React fiber key (`Object.keys(el).some(k => k.startsWith('__react'))`) before it types, which covers `#email`, `#password` and `#code`; the editor's `sel-y` is typed after state-driven waits that only a running React can satisfy, so for it the wait passes at once. The no-env run still exits 2; the credentialed run is still the owner's.

### Post-release (2026-08-28): a placed mount upgrade is a pickup that grants it once

**§6 / §9 what the Place list offers, and what a placed mount upgrade does.** The placeable rule is now: an ammo pack (`grant_ammo` with a string `ammo_item`), an inventory item (`grant_item` with a string `item_id`), a consumable by its marketplace key (`consumableItemFor`, world stamp and all), an item id the key spells, and — new — a mount power (`grant_mount_power` with a string `mount` and `power` and, on the site's side, an integer `tier` of 1 to 3). The nine an admin placed on station (Bicycle Speed I–III, Bicycle Acceleration I–III, Hoverboard Speed I–III) had been refused with `item` and then hidden from the list; they are offered again, and the site and the game flipped in one commit so no bundle offers what the game refuses. `grantForPlacement` resolves such a row to `{ grant: { effect, mount, power, tier, name } }` through the parser a purchase reads (`mountPowerGrantFor`, exported from `Marketplace.js`), and `Loot` spawns a persistent pickup whose contents carry the grant instead of an item id, labelled as the shop labels the row (`Bicycle Speed III`; the catalogue name, else mount + `STAT_META` label + roman tier) in the consumable accent. Three decisions, final: **once per account** — two reads of the same ledger, because one is not enough: `_applyPlace` reads `mounts.getPowers(mount)[power]` at apply time and withholds the pickup from a rider who already holds the tier or a higher one, the entry reported *applied* (the grant is already in force; nothing for the admin to fix, no new field on the wire); but on the ENTRY world that read sees an EMPTY ledger, since boot activates the start world — and so applies its overlay — before `hydrateAccountSession` restores the remote mounts and before the local save's `_restoreMounts` on Continue, and the already-active world gets no second `world:changed`. So `MapOverlay` also listens for `game:started`, which fires after both restores, and sweeps every placed upgrade the restored ledger says the rider owns — `loot.despawn`, silent, no `loot:collected` and no `mount:power:buy` — and forgets it; a still-unowned one stays. The pickup dies on collection, so the next visit finds nothing to spawn. The Place list says so in one line under it ("a rider who already has it, you included, finds nothing there"), and a mount row shows no `×N` and offers no Quantity; **refused on unsellable** — a power the mount does not sell (`!mounts.sellsPower`, Fire on a horse) is refused at apply time with the existing reason `item`, as is a game with no `mounts` to ask, and the reason set is unchanged; **the purchase event reused** — collecting emits `mount:power:buy` with `{ mount, power, tier, catalogId: null, cost: 0 }`, which main.js already routes to `MountManager.grantPower` and persists locally and remotely, so nothing new listens. A tier is not a stack: `quantity` is ignored for a grant. The site still cannot see `sellsPower`, so the game's `item` reason remains the final word and lands on the row; its wording now names mount upgrades, and a verdict from a report of an older version than the one saved says which version it judged (`not applied in v3`). The site's rule is what keeps an UNKNOWN mount from the applier: the game's `sellsPower` answers true for a mount no class declares, so the editor offers only a `mount` in `MOUNT_IDS`, pinned to the keys of `MOUNT_STATS` in `Livery.js`. HUD toast rule: the HUD's `loot:collected` listener ignores an entry with no `itemId` — a grant names itself through its own `hud:notify` (`+Bicycle Speed III`), and without the rule it toasted "+1 salvage" beside it. `MapOverlay` takes `mounts` in its ctx (read-only, as the Marketplace does). Game tests: map-overlay 69 → 76, `loot-grant.test.mjs` new; site: the placeable contract pins the mount route, the round trip places one through the real applier.
