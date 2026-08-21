# BUILD BRIEF — WORLD 06: THE SPACE DOCK (Drop One of two)

Worktree `e:/markc/gametestai/space-worktree`, branch `space-dock`. Nothing in this brief has been implemented; no file was modified producing it.

---

## 1. THE WORLD IN ONE PARAGRAPH

**`static id = 'dock'` · `static displayName = 'Lodestar Yard'` · lore scope `dock` · keeper sign_label `Yard Warden`.**

Survey Site 06 got commissioned. The levelled pad behind gateway 06 — a datum, a setting-out grid, eighty marker stakes and no decision (`src/content/Lore.js:69-78`) — is now a working shipyard, and the surveyors' brass datum plate is still bolted to the floor at the centre of the assembly bay with every berth in the yard dimensioned off it. Lodestar Yard does not *build* ships; it re-assembles them. Nothing bigger than a gateway arch has ever come through a gateway, so every hull here arrived as sections narrow enough to walk through a portal and was pinned back together on a cradle — which is why the ships are slab-sided, ribbed and segmented rather than smooth, why every hull carries a bolted string course at each section joint, and why a yard rat can climb one like a wall. That is not decoration: **the lore exists to justify the collision constraint in §3.** The yard has fitted out four hulls and launched none of them. There is a blast door at the north end with a strip of unweathered floor behind it and a countdown board that has read `LAUNCHES: 000` since the site was commissioned. The player is the first launch. Keep that in the copy everywhere — the signage, the keeper, the quest line, the chandler's small talk — because it is the single line that makes a hangar into a place, and it is the setup the flight drop pays off.

Tone against its neighbours: Aether Nexus Station is civic and lit for a public; Ashfall Reach is lived-in; Sunspire Citadel is a wall you climb. Lodestar Yard is **industrial, cold, half-finished and loud** — sodium worklights over cyan wayfinding, tarps, scaffold, chalk lines on the floor, section numbers stencilled on everything, and one immaculate ship under a clean tarp that nobody is allowed to touch.

---

## 2. THE REGISTRATION CHECKLIST

Work top to bottom. **SILENT** means a miss produces a world that boots, looks right and behaves as the station.

### 2a. Retire SurveyWorld (it is the placeholder being replaced)

`SurveyWorld.js` is 514 lines, `static id = 'survey'` (`src/worlds/SurveyWorld.js:54`). Do **not** keep the id — `id` appears in every log line, every save key, every `world:changed`, the DB `world` column on quests and marketplace rows, and the drop/cache table keys. Change it, and pay these eight edits, seven of which fail loudly:

| # | Edit | Fails how |
|---|---|---|
| 1 | delete `import SurveyWorld` + `register` at `src/main.js:17`, `:131`; add `DockWorld` | module resolution error |
| 2 | `src/worlds/StationWorld.js:6208` gateway row 5 → `{ target:'dock', label:'Lodestar Yard', accent:<new>, em:'emAmber', signRole:SIGN_ROLE.gatewayDock }` | length check `:6210-6215` throws if you remove the row; the bearing list stays at six (`station/StationKit.js:1176`) so **no seventh bearing is needed** |
| 3 | rename the four `SIGNS` rows at `StationWorld.js:1084-1104` and the four `SIGN_ROLE` indices `:1141-1145`; `RESERVED_ROLES = 44` in `scripts/tests/station-floor-numbers.test.mjs:35` stays 44 | short row crashes `paintSignAtlas` `:1093-1098` at boot |
| 4 | `scripts/contract-check.mjs:338` survey entry → dock entry | "MISSING FILES", exit 1 |
| 5 | `scripts/tests/npc-routes.test.mjs:214` WORLDS + `:398` `withRoutes` deepEqual | test fails |
| 6 | `scripts/tests/lorekeeper-scope.test.mjs:33,45` | test fails |
| 7 | `scripts/tests/flight-ceiling.test.mjs:27` ROOFLESS | test fails |
| 8 | `src/content/Lore.js:1` LORE_ORDER + `:69-78` survey entry | **SILENT** — keeper recites the Chronicle |

Keep and reuse from SurveyWorld: the datum pillar and brass plate (`:259-267`), the `_board()` canvas signage helper (`:346-376`), the `_mats`-tracked-and-disposed pattern (`:115,505-513`), and the `rotationY: Math.PI` reasoning at `:461-467`. Bin the deck, the grid, the stakes.

### 2b. Register the dock

| # | File:line | Row | Silent? |
|---|---|---|---|
| 1 | `src/main.js:11-17`, `:122-131` | import + `worldManager.register(DockWorld)` | no |
| 2 | the class | `static id='dock'`, `static displayName='Lodestar Yard'`; **no** `static volatile` | no (`WorldManager.js:75-77` throws) |
| 3 | `src/worlds/StationWorld.js:6208` | gateway table row (2a #2) | no |
| 4 | `StationWorld.js:1015`,`:1110-1146` | 4 SIGNS rows + 4 SIGN_ROLE indices | partly |
| 5 | `src/npc/NPCManager.js:269-272` | `THEME_BY_WORLD.dock = 'dock'` | **SILENT** → station costumes |
| 6 | `NPCManager.js:282-303` | `FALLBACK_NAMES.dock` | **TypeError** at `:774` on the first unnamed friendly — `names[nameIndex++ % names.length]` has no `??` |
| 7 | `NPCManager.js:306`, `:339` | `CROWD_NAMES.dock`, `CROWD_PERSONAS.dock` | **SILENT** (`?? .station`, `:1473-1474`) |
| 8 | `src/npc/NPCWeapons.js:177-197` | `WEAPON_TABLES.dock` | **SILENT** |
| 9 | `src/npc/NPCRoles.js:123-350` | `ROLE_CAST.dock` | **SILENT** (`?? .station`, `NPCRoles.js:375`) |
| 10 | `src/npc/Humanoid.js:3908`,`:3930`,`:3978`,`:504` | `THEME_VARIANTS` / `PALETTES` / `CLOTH_KIND` / `THEME_RIM` for `'dock'` | **SILENT** (`:4668` → `'station'`). **These four still have only station/medieval/sports** — citadel and maze are already broken here. Do not add a seventh broken theme; author the costume set or explicitly reuse `'station'` in `THEME_BY_WORLD` and write down why |
| 11 | `NPCManager.js:274-280` | `MERCHANT_SIGN_WORLD.dock` | **SILENT** — sign reads `DOCK` |
| 12 | `src/systems/Loot.js:72-133` | `DROP_TABLES.dock` | **SILENT** (`:349`) — see §6 |
| 13 | `src/systems/Caches.js:66-92` | `CACHE_TABLES.dock` | **SILENT** (`:374`) |
| 14 | `src/systems/Contracts.js:43-48` | `SUPPLY_WANTS.dock` | **SILENT** (`:181`) — else the yard asks you for `alloy_scrap` and `nexus_shard` |
| 15 | `src/systems/ItemDefs.js:337-385` | `WORLD_MARKETS.dock` | **SILENT** — flat pricing (`:397-400`) |
| 16 | `src/gfx/PostFX.js:564+` | `GRADE_PRESETS.dock` | **SILENT** — auto-selected by world id at `:1099`; only station/medieval/sports exist today |
| 17 | `src/audio/Music.js:45` | `SCORES.dock` | **SILENT — total silence** (`setWorld` `:239` sets `score = null`) |
| 18 | `src/content/Lore.js:1`,`:3-79` | `LORE_ORDER` + `DEFAULT_LORE.dock` (+ `DEFAULT_LORE.space`, §8) | **SILENT** |
| 19 | `src/content/Lore.js:93` | the hardcoded "Canonical game facts" sentence — currently *"six worlds … Aether Station is the hub and has five outbound portals"*. Verified stale prose; without this edit the keeper **denies the yard exists** | **SILENT** |
| 20 | `admin/lib/db.ts:21-71` | `DEFAULT_LORE_ROWS` (7 scopes today, already missing maze+survey) | **SILENT** |
| 21 | `admin/app/dashboard/lore/page.tsx:8` | its own stale `LORE_ORDER` | cosmetic |
| 22 | `site/lib/lore.ts:28-42` | `FALLBACK_LORE` | site-only |
| 23 | `site/lib/worlds.ts:1-38` | `WorldId` + `WORLDS` (`loreScope`, `accent`, `painterKey`, `scene`) | type error |
| 24 | `site/lib/marketplaceCatalog.ts:6` | `MARKETPLACE_WORLDS += 'dock'` | `normalizeWorld` **throws** on the whole listing (`marketplaceDb.ts:176-193`, `rowToItem :214-221`) |
| 25 | `site/lib/marketplaceCatalog.ts:321-333` | `WORLD_PRICE_MULTIPLIERS.dock` | `Record<MarketplaceWorld,…>` type error |
| 26 | `site/lib/marketplaceCatalog.test.ts:42` | row count `BASE_ITEMS.length * MARKETPLACE_WORLDS.length` → ×6 | test fails |
| 27 | `admin/lib/quests/dock.mjs` + `index.mjs:29-44` | `DOCK_QUESTS`, numbers **51-60** (next free block; station 1-10/101-110/201-203, medieval 11-20, sports 21-30, citadel 31-40, race 41-50 — verified `admin/lib/quests/index.mjs:15-20`) | **SILENT** — no quests |
| 28 | `scripts/tests/quest-content.test.mjs:317` | `>= 7 worlds` assertion | test fails |
| 29 | `scripts/tests/quest-content.test.mjs:528` | `restricted` map `{ citadel, station, race }` += `dock: 'DockWorld.js'` | **SILENT** — purchase steps go unchecked |
| 30 | `scripts/contract-check.mjs:113-338` | CONTRACT entry with `fields:` — see §10 | **SILENT** |
| 31 | `src/dev/Harness.js:48-246` | `VIEWS.dock` | optional (`?? []`) but do it |
| 32 | `scripts/tests/flight-ceiling.test.mjs:27` | ROOFLESS membership — the yard **has a roof**, so it is *not* roofless; state that decision | test-only |
| 33 | `src/systems/Marketplace.js:37` + `site/lib/marketplaceCatalog.ts:3` | `ALL_CATEGORIES` / `MARKETPLACE_CATEGORIES` += `'ships'` — **both** (§6) | half-done = counter silently becomes a general trader (`_readVendorCategories :665-678`) |

Auto-discovering, needs nothing: `scripts/quest-vocab.mjs:buildWorlds()` scrapes `src/worlds/*.js` for `static id`; `RaceManager`, `MinigameManager`, `Viewpoints`, `WaterVolumes`, `Relics`, `Caches`, `Interiors` all arm off published fields.

---

## 3. LAYOUT

### The numbers

```
DECK_Y      0            assembly floor datum (the brass plate is at 0,0)
GANTRY_Y    8.0          catwalk level, runs the full perimeter
CRANE_Y     15.4         crane rail — visual only, NOT walkable
ROOF_Y      26.0         truss underside
YARD_X      ±86          floor half-width
YARD_Z      -104 .. +58  floor extent; +58 is the gateway apron, -104 the blast door
bounds      Box3(-110,-8,-118) .. (110, 34, 74)
```

Compact on purpose: the station is 1,440 m across and pays 3,175 ms in `_settleDressing` for it (`StationWorld.js:1865-1871`). A 172 × 162 m yard read from a gantry is a whole world.

### Section, north-looking

```
 26 ─────────────── roof truss, emissive strip runs, no collider ─────────────
 15.4  ══ crane rail ══════ gantry crane bridge (dressing, DistanceLod) ══════
  8.0  ▐catwalk▌     ▐catwalk over berth 2▌            ▐catwalk▌   ← railRect
                 ╱hull spine  ╱hull spine
  3.2 ──── ship string course / rest ledge ────  (every hull, every hull)
  0.0 ═════ assembly floor ═══ cradles ═══ chalk grid ═══ datum plate ═══════
 -2.2  service trench under the keel line (drops, no fall damage, one ladder-ramp out)
```

### Plan

- **Arrival apron, z = +52.** The return portal to the station sits at `(0, 0.3, +52)`, `rotationY: Math.PI`, exactly the SurveyWorld reasoning (`SurveyWorld.js:461-474`): `arrivalFor` (`WorldManager.js:419-470`) places you 2.6 m along `(sin rotY, cos rotY)` and faces you further along it, so PI lands you at z 49.4 facing **down the yard** with the whole thing in front of you. At 0 you arrive facing the wall. The first thing the player sees, framed by the apron mouth, is the keel line receding to the blast door with three ships on cradles either side of it and the crane bridge overhead.
- **The keel line** — a 4 m-wide chalk-and-brass strip on the floor from the apron to the blast door, the yard's only piece of wayfinding, done as one vertex-coloured `route`-style material sampling the deck's own maps so it is 1 draw call (`StationWorld.js:2462-2466`).
- **Berths.** Four, off the keel line: B1 and B3 to port, B2 and B4 to starboard, staggered so no two ships occlude each other from the apron. Each berth is a 5-sided box in plan — cradle, service stair, tool wall, one merchant counter, one wall-mounted board.
- **Merchant row, z = +20 to -10 under the port catwalk.** Three counters, all on the floor, all within 7 m of the keel line (`VENDOR_RANGE = 7`, `Marketplace.js:23`).
- **The gantry.** A continuous 2.4 m catwalk at y 8.0 round the whole perimeter plus two crossings over the keel line. Reached by **two** stairs (apron end, blast-door end) and by free-climbing any hull. Guarded with `railRect` from `station/Tower.js:1140` with `gaps` cut where the stair heads arrive — do not drop a whole run (`Tower.js:1108-1160`). Stairs are drawn treads over **one hidden `_ramp` proxy** (`StationWorld.js:3763`), 20 risers at 0.395 m / 35°, riser under `CONFIG.player.stepHeight = 0.45` (`Config.js:174`). The capsule solver resolves slopes and does not step up (`Tower.js:527`).
- **The trench,** y −2.2, under the keel line, 3 m wide, running B1→B4. Cache spawns, one interior stash, and the only place in the yard you cannot see the roof from. Exit is a ramped ladder run, not a box stack.
- **Blast door / launch bay, z = −96.** Sealed this drop, with the countdown board. §8.

### The climb constraint, stated plainly

The player free-climbs any face within **30° of vertical** (`|hit.normal.y| ≤ WALL_NORMAL_Y = 0.5`, `src/player/FreeClimb.js:73,207`), probed by three rays at `yaw ± 0.26` rad, length `0.35 + 0.62 = 0.97 m`, at eye height × 0.72 = **1.166 m** (`FreeClimb.js:50,71,101,228`). Mantling needs a top face with `normal.y ≥ 0.7`, a rise in [0.25, 2.4] m arriving from a climb, **1.55 m** of headroom, and a `resolveCapsule` that reports grounded **0.77 m inboard** of the edge (`src/player/Climb.js:51,47,238,250-262`).

Therefore, and this is not negotiable:

1. **Every climbable hull collides as oriented boxes** (`physics.addRotatedBox`), never `addTriangleSoup`/`addTriangleMesh`. `CitadelWorld.js:71-74` records why: *"a triangle soup would give the climb probe a surface normal per triangle and make ledge detection chatter along every seam."* Visual and collision decouple — draw whatever swept form you like, collide a stack of yawed boxes.
2. **Band every hull.** `DRAIN_UP = 5.4`/s against a 100 bar at 2.05 m/s is ~13.7 m of continuous climb (`FreeClimb.js:80-92`). Section joints at **y 3.2 and 6.4** are rest ledges on every hull — which is exactly what the "shipped in sections" lore buys you.
3. **Every grabbable detail carries a collider.** `CitadelWorld.js:1495`: *"a detail the player can see and not grab would be a lie."* Handrails, tie-down rings, panel lips.
4. **Every hull has a flat dorsal spine** ≥ 1.8 m wide with `normal.y ≥ 0.7`, so the final mantle can complete. A rounded upper hull lets the climb run to the top and then *refuse to finish* — the ugliest failure in this class.
5. Hull spine → gantry at 8.0 m is a deliberate mantle: spine tops at 6.6-7.2 m, gantry edge at 8.0, rise 0.8-1.4 m, inside `[0.25, 2.4]`.

---

## 4. THE SHIPS

Four hulls. Three fully walkable this drop, one dressing. They differ in **silhouette, interior programme, stat ladder and slot palette** — never only in colour.

| # | Class | Berth | Length | What it is FOR | Stat bias (§5) | This drop |
|---|---|---|---|---|---|---|
| 1 | **Kestrel** courier | B1 | 14 m | fast, fragile, cheap; the starter and the ship the tutorial line hands you | power 3 / shield 1 / fire 1 / hold 1 | **walkable** |
| 2 | **Dray** ore tender | B2 | 28 m | the mining ship — big hold, slow, tough; the reason planets are orbital scan-and-mine | power 1 / shield 3 / fire 1 / hold 4 | **walkable** |
| 3 | **Pike** interceptor | B3 | 18 m | the space-invaders ship: guns, no room, no cargo | power 2 / shield 2 / fire 4 / hold 0 | **walkable** |
| 4 | **Bastion** frigate hulk | B4 | 44 m | scale-setter and Drop Three's ship: ribs open to the air, engine bell on a stand beside it | — | **dressing, climbable, no interior** |

### Interior programme, room by room

| Ship | Cockpit | Other spaces | Vertical |
|---|---|---|---|
| Kestrel | 1-seat, 2.6 × 2.2 × 2.0 m, canopy forward | one 2.4 × 3.0 m cabin aft (bunk, locker, `prize` spot) | boarding ramp 4.2 m @ 22°, no internal stair |
| Dray | 2-seat, 3.4 × 2.8 × 2.1 m | **hold** 9 × 6 × 3.4 m (walk-in, crates, 2 `common` spots), **engine room** 5 × 4 × 2.6 m aft of a bulkhead hatch (`rare` spot) | ramp to hold floor, then one 6-step flight hold→cockpit (rise 0.4, tread 0.5), one hatch hold→engine room |
| Pike | 1-seat, 2.4 × 1.9 × 1.9 m, canopy over | **gun bay** 3.0 × 1.6 × 1.5 m — crouch-only, reached by a floor hatch from the cockpit | dorsal ladder-ramp from the deck straight onto the spine, hatch down into the cockpit |
| Bastion | — | open ribs you walk *through* at deck level; the engine bell is a climbable cylinder | none |

Ceiling heights are deliberate and none is domestic: 2.0-2.1 m in cockpits, 3.4 m in the Dray hold, 1.5 m crouch in the gun bay. `medieval-towns.test.mjs:192-207` is the warning here — a 34 m nave built to a domestic storey height was a 2.85 m corridor.

### Construction: what InteriorKit can and cannot do

`src/worlds/InteriorKit.js` (864 lines, zero world dependencies) is **not usable as-is for a ship**, for five reasons that are all structural:

1. **No rotation.** Header `:13-14`: *"Everything is built axis-aligned in world space, so every collider is an exact `physics.addBox`."* `cbox` calls `addBox`, never `addRotatedBox`. Every ship in the yard is on a cradle at a yaw, because four ships all facing the same way is a car park.
2. **No small rooms.** `buildHouse` floors at `INT = max(2.6, …)` → 5.2 m minimum square (`:444`). Kestrel's cabin is 2.4 m.
3. **`_deckWithHoles` is hard-coded `N = 10` panels regardless of size** (`:672`) — on a 3 m deck that is 30 cm panels and **100 colliders**, multiplied per deck per ship.
4. **No ladders, no half-levels.** Stairs at ≤ 0.45 rise means a 3 m gap costs 4 m of run, which will not fit in a 14 m hull.
5. **Palette is stone/plaster/plank/beam/slate/iron** (`:103-140`).

**Do this instead.** Write `src/worlds/dock/ShipKit.js`, modelled on `station/Tower.js:425 buildTower` and `station/ZoneContext.js:39`, borrowing InteriorKit's *shapes* rather than its code:

- Every ship is authored in **its own local frame** — `+Z` is nose, `+X` starboard, origin at the cradle-top keel point — exactly `ZoneContext`'s rationale (`ZoneContext.js:36`). One `P(lx,ly,lz)`, one `put()` → `GeoBatch.localAt`, one `solid()` → `world._solidRot`, and `_localPoint` must match `GeoBatch.localAt` exactly so a collider cannot drift from its geometry (`Tower.js:425+`).
- **Rotated-box collision throughout.** The pattern exists at `CitadelWorld.js:1441` and `MedievalWorld.js:6435`; lift it into `ShipKit.cboxRot(cx,cy,cz, hx,hy,hz, yaw)`.
- **Hull shell = separate wall boxes, never one solid box** — a single box fills the interior. Five segments plus a lintel per opening, as `InteriorKit.js:361-373`.
- **Publish a `footprint: {x, z, yaw, hw, hd, top}` per ship** and skip it in `_collisionSoup`, exactly as `station/Tower.js:1070-1084` and `StationWorld.js:6725-6728` (`_selfCollided`). Without it the derived-collision pass collides the cockpit seat and the engine-room pipework and *"a rider stopped dead two thirds of the way up a flight by a soffit that exists only as a decoration."*
- **Interiors go into a second `GeoBatch`**, flushed per ship into its own group and registered with `DistanceLod` (`hideBeyond: 40`, `measure: CENTRE`) — `Tower.js:501-521`. What stays in the district batch: hull plating, spine, ramp, cradle, canopy glass. **Colliders are never split** (`Tower.js` same block) — `solid()` registers everything regardless of LOD.
- **Doors.** Hatches are `InteriorKit`-shaped door records (`{id, leaves:[{pivot, closed, open}], collider, position, open:false, anim:0}`, `InteriorKit.js:657-669`) because `Interiors._onWorld` (`src/systems/Interiors.js:55-62`) only understands `leaves[].pivot.rotation.y`. **A sliding airlock needs its own descriptor shape**; the vertical-slide pattern is `Physics.setBoxColliderY` as used by `maze/MazeChunks.js:912`, and `Interiors` cannot drive it. Recommendation: **hinged hatches only in Drop One.** One new door verb is not worth a new descriptor contract.
- **The `dy ≤ 2.6` gate.** `Interiors.js:374`: a door is only interactive when `|player.y − door.position.y| ≤ 2.6` and horizontal `< 3.0` (`:376`). Publish every hatch's `position` at the height the player's feet are when standing at it — **on the ramp, not at the hull origin.** This is precisely the medieval winding-house defect (sill 2.03 m over the street, prompt never appeared, `medieval-approach.test.mjs:335-337`).
- **Collectible spots** are 3-D-distance streamed at 46 m spawn / 64 m despawn with `snap:false`, so authored Y is kept exactly (`Interiors.js:108-141`, `Loot.js:396-400`). A spot in a cockpit 5 m up is legal.
- **`label` must be unique per enterable** — the collected tag is `` `interior:dock:${e.label}#${i}` `` (`Interiors.js:91`). Two ships labelled `'ship'` share tags and one loses its loot.
- **Doorless descriptors are legal and useful** (`medieval/Treasures.js:556-566`) — the Bastion gets `{label:'bastion-ribs', doors:[], lifts:[], collectibleSpots:[…]}` and buys the whole streaming path with no interior at all.
- **`world._autoInteriors` stays FALSE.** `Interiors._ensureRollout` (`:149-155`) would stamp generic untextured shells over the hulls.
- **`rules.interiors` must be `true`** — SurveyWorld sets it false (`SurveyWorld.js:73`).

### The full-plan-box rule — this would be the fourth occurrence

`MedievalWorld.js:6838-6864`. Stringers, ribs, cable runs and deck beams are *exactly* the shape of member that gets authored as one box the size of the whole compartment. On a shed it is invisible; in the Dray's hold it is six slabs of dark boarding stacked through the room. The measured version: raycast up from the Marcher Hall's ground floor and the first thing over your head was plank at **1.66 m**, not the ceiling at 2.85. Nothing caught it because those members have no colliders and the headroom test probes colliders.

**Do it the fixed way from day one:** four members per course, one per hull face, each inset by the wall thickness so the inner face lands *inside* the plating — buried, never coplanar, identical from outside (`MedievalWorld.js:6862-6884`). And write the geometry-clearance test (§10) before the second ship, not after the fourth.

### Two things not to copy

- **`M.room` / `paintRoomGlow`** (`StationWorld.js:926-1001`) — the painted lit-interior billboard behind glass. Correct at far field, explicitly wrong up close: the hangar mezzanine's was *deleted, not turned round* (`:7268`) — *"the room behind the glass is real now and a painted one in front of it would be hiding it."* **No ship canopy in this yard gets a room quad.** The cockpit behind it is the feature.
- **`_settleDressing` as an architecture** (3,175 ms, the station's single most expensive phase, `StationWorld.js:1865`) — a repair pass for props authored without a ground datum. Every prop in the yard sits on a known surface: deck 0, catwalk 8.0, cradle top, hull spine. Author to the datum and neither `_settleDressing` nor the fixed-point `_solidifyProps` loop is needed.

---

## 5. CUSTOMIZATION

### Verdict on `src/mounts/Livery.js` — **reuse directly, five of seven exports unchanged.**

`FINISH_PROPS` (`:28-31`), `normColor` (`:60-68`), `applyLivery` (`:97-133`), `liveryMatches` (`:139-149`), `cloneLivery` (`:152-165`) and the `factoryOf` snapshot behind them (`:71-83`) contain no reference to the word "mount". They take `(livery, slots, slotMats)` and write uniforms. The file imports nothing from three (`:15-17`), so it stays headless-testable. **Import it from the ship code as-is.**

Mount-shaped, must be paralleled in a new `src/ships/ShipStats.js`:
- `MOUNT_STATS` (`Livery.js:38-45`) — six mount ids. **Do not widen it with ship ids**: `scripts/tests/mount-catalog.test.mjs:32-41` uses it as the authority for validating every `grant_mount_power` catalogue row, and a ship id in there makes a mount-power row for a ship pass.
- `STAT_META` (`Livery.js:48-53`) — Speed 12/tier, Acceleration 10, Armour 10, Fire 15. Ship copy is different.

### Verdict on `src/ui/MountMenu.js` — **parallel implementation; copy the skeleton line-for-line and port four traps verbatim.**

Already generic: the `CUSTOM_SLOTS`/`STATS`-driven section build (`:113-150` — *"a seventh mount needs no menu code"*), `_syncers` + the re-entrantly saved `_liveryCache` (`:52`, `:319-327`), the rAF-coalesced colour picker (`:304-317`), the event-driven resync set (`:62-66`), `quantise = v & 0xfcfcfc` (`:31`), the deferred 140 ms pointer relock (`:367-372`), `_section`/`el`.

Hard-wired to mounts and unavoidably rewritten: the `this.mounts.mounted/active` gate (**a dock ship is selected, not ridden** — different precondition, different lifecycle), `skinsForMount` + `applyMountSkin`, the four `mount:*` bus names, `STAT_META`, `PALETTES`, the third-person camera preview, the `.mm-` CSS namespace.

**Preferred shape:** extract the drawer once as `src/ui/CustomizerPanel.js` taking `{slots, stats, statMeta, palettes, skins, entity, adapter}`; `MountMenu` becomes a ~40-line adapter and the ship menu is the same file. If that refactor is out of scope, copy to `src/ui/ShipMenu.js` + `ShipMenuLogic.js` and **port these four commented traps verbatim, each a bug found in play**: `:116-117` pending-patch cancel on entity change, `:189` the factory-swatch no-op, `:320-326` re-entrant cache save/restore, `:367-372` relock delay.

Clone `MountManager`'s livery/powers half (`:629-765`, `:1727-1785`) most faithfully into a `ShipRegistry`: `_liveries`/`_powers` maps, mid-migration-tolerant `_knownSlot`/`_knownStat` (`if (!slots) return true`), a public `sellsPower` twin (`:686`) so the marketplace **refuses instead of taking money**, no-op-patch suppression (`:704`), empty-bag deletion on write and on deserialize (`:1777`).

### THE ORM-MULTIPLIER TRAP

`standardFromBake` (`Hoverboard.js:483-515`) sets `roughnessMap = metalnessMap = aoMap = s.ormMap` with **scalar `roughness = 1, metalness = 1`** (`:500-501`) and `color: opts.color ?? 0xffffff` (`:493`). On a baked material those scalars are *multipliers over the map* and `.color` is a *white multiplier over the albedo map*. Ships built on `standardFromBake` inherit this exactly.

Three defences, all required:
1. `FINISH_PROPS.matt.roughness = 1.0` is **the identity multiplier**, not "quite rough" — matt can never come out glossier than factory on an ORM material. `gloss` at 0.22/0.35 scales the bake down hard (`Livery.js:19-31`).
2. `factoryOf` snapshots `{color, emissive, roughness, metalness, envMapIntensity}` the first time the module touches a material, so clearing a finish restores the *recorded* multipliers (`:71-83`, `:113`, `:125`).
3. **The factory-swatch no-op**, which a ship menu will hit verbatim (`MountMenu.js:189`):
   ```js
   if (c === slot.defaultColor && this._livery()[slot.id]?.color == null) return;
   ```
   *Writing the swatch hex multiplies the map by itself and the part visibly darkens — the button that means "put it back" made it worse.*
   Pinned by `mount-menu.test.mjs:15-28`: every `CUSTOM_SLOTS.defaultColor` must be a member of its own `PALETTES[palette]`. **Write the ship equivalent of that test.**

Also: bind slots to **cloned** materials only (`Car.js:859-861` — the shared singletons feed the AI race grid), and never touch `needsUpdate` (`Livery.js:130` sets it false explicitly — a mid-frame program link is the exact stall the station work spent weeks removing).

### The ship slots and stats

```js
// src/ships/ShipStats.js
export const SHIP_SLOTS_COMMON = Object.freeze([
  { id:'hull',     label:'Hull plating', finish:true,  defaultColor:0x8d97a4, palette:'shipHull' },
  { id:'trim',     label:'Trim & stripes', finish:true, defaultColor:0xd2762f, palette:'shipTrim' },
  { id:'canopy',   label:'Canopy tint',  finish:false, defaultColor:0x2c3f52, palette:'shipGlass' },
  { id:'thruster', label:'Thruster glow',finish:false, defaultColor:0x4fe3ff, palette:'glow' },  // entries {mat, emissive:true}
]);

export const SHIP_STATS = {
  kestrel:  ['power','shield','fire','hold'],
  dray:     ['power','shield','fire','hold'],
  pike:     ['power','shield','fire','hold'],
};

export const SHIP_STAT_META = {
  power:  { label:'Thrust',    perTier:12, unit:'top speed'      },
  shield: { label:'Shields',   perTier:10, unit:'less hull damage' },
  fire:   { label:'Firepower', perTier:15, unit:'laser damage'   },
  hold:   { label:'Hold',      perTier:25, unit:'mineral capacity' },
};
```

`hold` is the fourth stat and the reason the Dray is not the Kestrel in a different colour. It is the only one with an **effect in Drop One** (hold capacity gates what the yard's chandler will buy from you); `power`/`shield`/`fire` are banked, persisted, shown in the HUD and applied by the flight drop.

**And that is a recorded hazard, not a shrug.** `Dragon.js:2470-2475` records that the dragon's `applyPowers` hook did not exist for a while, so tiers were *banked, persisted, re-emitted and applied to nothing*. Mitigation: ship `Ship.applyPowers()` in Drop One writing `_powerMul / _accelMul / _shieldTier / _fireTier` even though nothing reads them yet, and surface them in the HUD badges (`HUD.js:51-52`, `:1662`) — *"a purchase whose entire effect is a slightly earlier lap time is indistinguishable from a purchase that did nothing"* (`Dragon.js:2499-2503`).

**Carry the two mount arithmetic lessons into the flight drop's spec now, in writing, so it is not rediscovered:**
- **Speed tiers widen the turning radius** unless you divide by the *tiered* top speed inside the falloff curve **and** multiply the turn rate/cap/gain by `pm`. Measured: eagle 29.5 → 44.8 m (×1.52), hoverboard 11.6 → 19.1 m (×1.65), horse 18.2 → 24.8 m (×1.36) before the fix (`Eagle.js:552-570`, `Hoverboard.js:1029-1052`, `Horse.js:736-754`). *"It all saturates, so a tier is visually safe" is not true on its own, and was wrong twice* (`Dragon.js:2485-2497`).
- **On a drag-limited craft, Acceleration leaks into top speed** unless you scale the *net* — `speed += (thrust − drag) * accelMul * dt`, not `thrust * accelMul` (`Eagle.js:582-594`, `Bicycle.js:841-846`). A six-DOF arcade flight model with an assist is drag-limited by construction.

### Ship skins

Mirror the mount arrangement exactly, since it costs 20 data rows for 20 skins: `SHIP_SKINS` array → auto-generated bag items in `ItemDefs.js` (the mount loop is `:294-311`, `MOUNT_ABBR` at `:287` with a `slice(0,3).toUpperCase()` fallback) → generated `BaseSeedRow`s with `action_config:{effect:'grant_item', item_id:'shipskin_<id>'}` → a `kind === 'shipskin'` dispatch **at the top of `ItemUse.use`, before the player check** (`src/systems/ItemUse.js:36`) → an `applyShipSkin` modelled on `src/systems/MountSkins.js:17-44`, keeping its ordering exactly: **refuse with `'unavailable'` if the ledger cannot receive it, before anything is consumed** (`:26-28` — *"a purchase must never be consumed with nowhere for it to land"*), then bag-then-store (`:37-38`), then unlock, then apply → a `KNOWN_SHIP_SKIN_IDS` guard in the ledger → `SaveGame` wiring.

---

## 6. MERCHANTS, ITEMS AND ECONOMY

### The `ships` category — add it

`MARKETPLACE_CATEGORIES` is `['cosmetic','weapons','tools','health','spells','mounts']` (`site/lib/marketplaceCatalog.ts:3`) and `ALL_CATEGORIES` in `src/systems/Marketplace.js:37` is an explicit mirror. Ship hull upgrades under `mounts` and ship liveries under `cosmetic` would work and would be a lie in the UI tabs. **Add `'ships'` to both.** The failure mode is loud (`normalizeCategory` throws, `marketplaceDb.ts:176-193`) which is what you want; the silent half is `_readVendorCategories` (`Marketplace.js:665-678`) dropping an unknown category so a `vendorCategories:['ships']` counter becomes a **general trader stocking everything** rather than an empty one. Both edits or neither.

### End-to-end registration for one new bag item

Nine steps. Skipping 2-4 destroys the unit; skipping 7 makes the purchase return `unsupported`.

1. `src/systems/ItemDefs.js:39` `ITEMS` — `{id, name, short, stack, icon, value, kind, desc}`; `kind ∈ ammo|consumable|trinket|currency|skin` (`:20`). Missing ⇒ inventory refuses; `Marketplace.sell` returns `unavailable`.
2. `src/systems/ItemUse.js:69-106` `_effectFor` — id → `{type, …}`. Missing ⇒ `use()` returns `unsupported` (`:41`).
3. `ItemUse.js:108-127` `_canApply` — a case. The `default` returns `!!itemId`, so a **new effect type silently reads as always-applicable**.
4. `ItemUse.js:129-177` `_apply` — a case. Missing ⇒ `default: return null`, and **the item was already consumed at `:43`**. The unit is destroyed for nothing.
5. `site/lib/marketplaceCatalog.ts:42` `MARKETPLACE_ACTIONS` if the `game_action` id is new.
6. `marketplaceCatalog.ts` `BASE_ITEMS` row — `{source_key, name, description, category, image_label, image_color, game_action, action_config, quantity, cost_buy, cost_sell, pricing_kind, sort_order}`.
7. `src/systems/Marketplace.js:40-56` `MARKETPLACE_CONSUMABLE_ITEMS` — **`source_key` must be the bare mapping key**; `consumableItemFor` (`:77-86`) probes the exact key then retries once with `:<world>` stripped. A prettier prefixed key that is not in the map resolves to nothing and every purchase returns `unsupported` — the exact defect recorded at `:605-613`. *Or* skip 7 by using generic `action_config: {effect:'grant_ammo'|'grant_item', …}`, read by `_purchaseGrant` (`:307-329`).
8. **Vendor reach.** `refreshCatalog` filters `_catalog` by the open vendor's `vendorCategories` (`:280-282`) and `_findVendor` only sees NPCs within `VENDOR_RANGE = 7` m (`:23`, `:645-657`). A category no counter stocks is an item nobody in the world can buy.
9. **Quest reach** if a quest names it: `quest-content.test.mjs:528` restricted map, and `resolveTarget('purchase', …)` requires `world.rules.merchants && roles.includes('vendor')` (`quest-vocab.mjs:1754-1762`).

### New items

| id | kind | stack | Why it exists in Drop One |
|---|---|---|---|
| `laser_cell` | ammo | 240 | the flight drop's laser ammo — **and the plasma-cutter charge consumed by the hull-cutting minigame (§9), so it is not an item you cannot use.** Never ship a buyable with no Drop-One effect |
| `hull_plate` | trinket | 20 | yard currency-in-kind; feeds the shield tier rows and the chandler's buy list |
| `thruster_coil` | trinket | 10 | the Kestrel/Pike thrust upgrade component; also the `supply` contract want |
| `nav_chart` | consumable | 5 | reveals a viewpoint on the minimap without climbing to it (Drop One effect: `Viewpoints` reveal at `REVEAL_R = 70` m); in the flight drop it seeds a planet |
| `shipskin_*` | skin | 1 | auto-generated per `SHIP_SKINS` row (§5) |

### Vendors — three counters, whole catalogue between them

Copy the citadel's `F()` factory shape (`CitadelWorld.js:2694-2711`); the third argument is the `extra` bag read by `NPCManager._createNPC` (`:1301-1310`).

```
Ivo Marek, "the Chandler"   role:'vendor'  vendorCategories:['tools','health']      vendorTitle:'Yard Chandlery'
Suri Vane, "the Fitter"     role:'vendor'  vendorCategories:['ships','weapons']     vendorTitle:'Fitting Shop'
Beck Aldous, "Paint & Rope" role:'vendor'  vendorCategories:['cosmetic','mounts','spells']  vendorTitle:'Paint & Rope'
```
All three within 7 m of the keel line and inside a 15-bearing approach probe (§10). `_isVendor` (`:682-689`) would catch them by name regex anyway, but set `role` explicitly.

### Regional pricing — `WORLD_MARKETS.dock`

The yard is the only place in the Nexus that *makes* things, and it has no relic culture at all. Model it as the inverse of the citadel (`ItemDefs.js:357-365`):

```js
dock: {
  label: 'Lodestar Yard',
  buy:  { trinket: 0.85, ammo: 0.9,  consumable: 0.95 },   // what a vendor PAYS you
  sell: { ammo: 0.8,  consumable: 1.1 },                    // what it CHARGES you
  itemBuy:  { alloy_scrap: 0.6, hull_plate: 0.7, thruster_coil: 0.75, relic_coin: 1.7, nexus_shard: 1.6 },
  itemSell: { pack_laser_cell: 0.75 },
  note: 'A yard makes hull plate and coil by the ton and cannot get a relic for love nor money.',
},
```
Then the **second, independent** table `WORLD_PRICE_MULTIPLIERS` in `site/lib/marketplaceCatalog.ts:321-333` must be hand-matched: `{ammoBuy: 0.9, ammoSell: 0.8, consumableBuy: 0.95, consumableSell: 1.1}`. Nothing enforces the correspondence between the two — put it in the registration test (§10).

Unknown world ⇒ `activeMarket = null` and flat pricing, **silently** (`ItemDefs.js:397-400`). `setMarketWorld` is called on every `world:changed` *before* the merchants rule check (`Marketplace.js:135`), deliberately.

### Loot and caches

**`rules.hostiles = false` this drop.** The yard is a civilian worksite; the space-invaders fantasy lives in space, and a hostile inside a walkable hangar puts the interior work and the combat work in each other's way for no gain.

Author `DROP_TABLES.dock` **anyway** (`src/systems/Loot.js:72-133`). Reason: the rule can flip, the fallback at `:349` is silent, and `quest-vocab` will happily validate a quest step naming a station item that the fallback makes "technically obtainable" — which is exactly how *two shipped citadel steps* asked the player to collect `bullet` and `alloy_scrap` on a mesa that manufactures neither (`Loot.js:91-93`).

```js
dock:  { laser_cell .62/10-30 · hull_plate .40/1-3 · alloy_scrap .48/2-5 · thruster_coil .16/1 · medkit .12 · nexus_shard .05 }
```
(`credits` 4-14 is pushed unconditionally on every corpse before the table rolls, `Loot.js:352-353`.)

`CACHE_TABLES.dock` (`src/systems/Caches.js:66-92`, **not exported** — const): `alloy_scrap 4-9 · hull_plate 2-4 · laser_cell 20-50 · medkit 1-2`. `_roll` picks 2 or 3 distinct lines (`:373-385`); `PER_WORLD = {sunken:3, high:3}` (`:51`) — the trench and the gantry are the two obvious homes.

`SUPPLY_WANTS.dock` (`src/systems/Contracts.js:43-48`): `['hull_plate','thruster_coil','alloy_scrap']`. Without it the yard asks you for `nexus_shard` off the station row (`:181`).

---

## 7. LORE AND QUESTS

### Lore

Add scope `dock` to `LORE_ORDER` and `DEFAULT_LORE` (`src/content/Lore.js:1`, `:3-79`), `DEFAULT_LORE_ROWS` (`admin/lib/db.ts:21-71`), `FALLBACK_LORE` (`site/lib/lore.ts:28-42`). `sign_label: 'Yard Warden'` — it becomes the keeper NPC's on-screen name (uppercased, `NPCManager._spawnLorekeepers :1329-1385`).

Body, roughly: *Lodestar Yard was Survey Site 06 until the ring commissioned it. Nothing here was built here. Every hull came through the gateway in sections narrower than the arch and was pinned back together on a cradle, which is why they look the way they do. The datum the surveyors left is still the origin of every measurement in the yard. Four hulls are fitted out. The board on the blast door reads LAUNCHES: 000.*

**Edit `buildLorePersona`'s canonical-facts sentence** (`Lore.js:93`, verbatim today: *"the Nexus has six worlds … Aether Station is the hub and has five outbound portals"*). Left alone, the Yard Warden tells the player the yard does not exist.

The keeper's scope: `lorekeeperScope` (`NPCManager.js:447-453`) gives each keeper its own `spec.target` when a world's portals name more than one distinct destination. **The dock will have two** (station, space, §8) — so the dock gets two keepers reciting two scopes, which means `DEFAULT_LORE.space` must exist too. `rules.crowd` must stay `true` or there are no keepers at all (`:1334`).

### The quest arc — "Commissioning", n 51-60

Ten quests. **Zero of them can use `kill`, `defend` or `race`** (no hostiles, no `trackPath`). The verbs that work here are `interact`, `talk`, `collect`, `purchase`, `survive`, `visit`, `minigame`.

| n | line | title | verbs |
|---|---|---|---|
| 51 | Commissioning | Report to the Yard Warden and sign the site on | `interact` ×1, `talk` ×2 |
| 52 | Commissioning | Walk the keel line: sync the four yard datums | `minigame`/viewpoint sync ×4 |
| 53 | Commissioning | Open an account with the Chandler | `purchase` ×2 |
| 54 | Yard Rat | Strip the trench: 6 salvage pickups | `collect` ×6 |
| 55 | Yard Rat | Get on the gantry the hard way — up the Dray's flank | `minigame` (climb venue), `collect` ×2 |
| 56 | Fitting Out | Board all three fitted hulls and check the cockpit seals | `interact` ×3 (one hatch each) |
| 57 | Fitting Out | Cut and fit a hull plate on the Bastion | `minigame` win, `collect` ×1 |
| 58 | Fitting Out | Take a ship's colours: buy and apply a livery | `purchase` ×1 (see the trap below) |
| 59 | Night Shift | One clean shift in the yard — the crane runs on a cycle | `survive` ×4 (120 s), `talk` ×1 |
| 60 | First Launch | Stand at the blast door with a fitted ship and a full cell rack | `purchase` ×1, `interact` ×1 (the launch portal) — **the hook the flight drop lands on** |

### STEP TYPES WITH NO EMITTER — the ones this world will beg you to use

`quest-vocab.mjs:269-271` `DEAD_STEP_TYPES`: **`investigate`, `deliver`, `escort`, `stealth`, `craft`**. There is no crafting, delivery, escort AI or stealth meter in this engine. A shipyard brief writes itself into all five — *"deliver the coolant to Bay 3"*, *"craft a thruster coil"*, *"escort the Chandler to the trench"*, *"investigate the sealed hull"*. **Every one of those is authorable and permanently uncompletable.** 53 of the old 184 steps used them and that is what made the pre-audit quest set 0-for-50. `quest-content.test.mjs` rule 1 now rejects them; do not fight it.

### Three further emitter traps specific to this world

1. **`customize` is bound to `character:changed`** (`QuestSystem.js:560`), and its candidates are *character config values*. **A "paint your ship" step cannot use `customize`.** Options: (a) express it as `purchase` of the skin item, which does emit `market:trade` (`Marketplace.js:447`) — recommended for Drop One; (b) add a `ship:livery` → `quest:activity` bridge, which is one line in `QuestSystem` plus one row in `quest-vocab.mjs:215-257` `STEP_TYPE_EMITTERS` plus candidate derivation. Do not fake it by emitting `character:changed`.
2. **A `visit dock` step inside a dock quest completes on accept** — `_creditVisit` runs from `accept()` (`:307`) and `_loadQuestsForWorld` (`:389`), not only from `world:changed`. It is free padding, so do not use it as step 1.
3. **`survive` is not rule-gated** — it is the only verb that ticks in a `quests:false` world, `SURVIVE_TICK_S = 30` (`QuestSystem.js:30`, `:158-166`). Four counts is two minutes; `dur` must comfortably exceed it or `update()` auto-fails the engagement (`:135-141`).

Matching is anchored token-run (`_tokenRunMatch :693`): `target: 'Kestrel'` reaches `Kestrel 1..N`; **empty target matches every event of that type**; a bare digit matches nothing. `_advanceSteps` walks every step per event (`:610-649`), so two steps sharing type+target+world both advance from one action, and `quest:activity` passes no `onceKey` — pressing E on the same NPC N times satisfies `count: N`.

### Signed out

`accept()` is blocked at `QuestSystem.js:238` (`'Sign in to accept quests'`) and 401s server-side (`site/app/api/game/quests/route.ts:34-36`). The board still loads and reads (`GET` returns `{quests, engagements: [], player_id: null}`). So **a signed-out player in the yard gets nothing from §7 at all** — which is why the world-local layer in §9 is not optional decoration. `Viewpoints`, `Relics` and `Contracts` have no `fetch` and no `_playerId` on any path (`Viewpoints.js:42-45`) and persist through `SaveGame` (`:115-117`, `:424-425`, `:537`, `:542`).

---

## 8. THE LAUNCH SEAM

**Build it now, end to end, against a stub. This is the single highest-leverage decision in the drop.**

### Register `SpaceWorld` in this drop

~200 lines: a starfield sphere, a 60 m lit platform, one return `portalSpec` to `dock`, `rules` with everything off except `weapons`/`jump`, a `DEFAULT_LORE.space` row, and its rows in every silent table from §2. Nothing else.

Why, concretely: it exercises `scheduleBackgroundBuilds` (`main.js:1343-1387`), `warmWorld` + `lightRig.claim` (`:1459`), `portals.holdPreviews`/`warmPortalPreviews`, `arrivalFor` return-portal lookup (`WorldManager.js:419-470`), `PostFX.setWorldGrade` auto-selection (`PostFX.js:1099`), `Music.setWorld`, `lorekeeperScope`'s two-target branch, and the whole registration checklist — **in a drop where the answers are cheap to change.** Doing it in the flight drop means discovering all of it while also writing a flight model.

And it makes the launch real on day one: the countdown board can go to `LAUNCHES: 001`.

### The portal spec, and the trap in it

One spec, on the dock:
```js
{ position: new THREE.Vector3(0, 0.3, -92), rotationY: 0, target: 'space',
  label: 'Open Space', accent: 0x9fd8ff }
```

**`arrivalFor` looks up the return portal by target and takes the first match (`WorldManager.js:427`), so outbound and inbound share one spec.** That forbids the obvious design. If you put the launch portal *inside the cockpit*, then coming back from space, `arrivalFor` places the player 2.6 m along `(sin rotY, cos rotY)` and faces them further along — inside a 3 m cockpit that is the far bulkhead, or through it. So:

> **The dock↔space portal lives on the deck at the blast door, not in a cockpit. Full stop.**

### How the cockpit still launches you

`PortalSystem.enter(portal)` is already public (`src/systems/Portals.js:2779`) and takes the built record, whose `id` is `` `${worldId}->${target}` `` = `dock->space` (`:1111`). So the pilot seat is a normal interaction that calls it:

1. Cockpit seat publishes a prompt (an `enterables` `collectibleSpots`-adjacent interaction, or a `minigameVenues`-style proximity trigger — either is a published field, no new system).
2. On press: play the strap-in beat, then `portals.enter(rec)` where `rec` is the `dock->space` record. Add one 3-line public `enterById(id)` next to `enter()` so callers do not reach into `_portals`.
3. Everything downstream is free: the warp of `CONFIG.portal.transitionDuration`, input disable, `portal:entering {from,to,duration,target,id,portal}` (`:2822`), `quest:activity {type:'interact', target:'dock->space'}` (`:2830`), destination pre-build (`:2801-2805`) and post-activate compile (`:2843-2860`). Quest 60's final step is `interact / dock->space`, and it costs nothing.

### The frame must not be a gateway arch

`_kit(target)` branches **only on target** (`Portals.js:1215-1237`): medieval style for `{medieval, citadel}`, sports for `sports`, **station for everything else**. Left alone, the launch bay grows a ceremonial arch with three approach steps and two jambs. Add a `'launch'` style: no arch, no steps, no jambs — a blast-door aperture ring concentric with `PORTAL_DISC_OFFSET_Y` (exported at `:61` precisely so a world can align to it), a floor pool, and the plinth colliders replaced by flush deck. Budget it at ~60 lines in `_kit` plus a branch in `_createPortal`'s collider block (`:1064-1109`), and note that the plinth colliders are *the ground under the arrival point* — `buildForWorld` runs after the physics rebuild and before the player is placed for exactly that reason (`WorldManager.js:371-378`). If you delete the plinth, the deck under `z = -92` must be solid at y 0.42 or the returning player falls.

Also: `ARM_DELAY = 0.9 s` (`Portals.js:166`, set at `:901`) means nothing auto-enters on arrival — you can stand a returning pilot on the disc safely.

---

## 9. ENGAGEMENT BEYOND THE BRIEF

Five, each justified by a system that already exists and is armed off a published field.

1. **Yard viewpoints and a leap of faith.** Publish `world.viewpoints = [{id,name,x,y,z,r,launch?,bearing?,hay?}]` — the whole contract is `id` plus finite `x/y/z` (`src/systems/Viewpoints.js:14-21`). Four: crane cab (15.4 m), Bastion's dorsal rib, the blast-door signal post, the gantry's north crossing. Each pays `SYNC_CREDITS = 150` + `relic_coin ×3`, reveals the minimap within 70 m and registers a fast-travel anchor (`:92-118`). The full set pays a cosmetic and a mount power (`:99-101`, `:534-535`). Publish `haystacks = [{x,y,z,r}]` (y is the **top** of the stack, `Parkour._softLandingAt :704-717`) under the crane — a tarp-covered spares pile — and the crane cab gets `launch: true`. **Why this one first: it is entirely account-free, works signed out, and costs four array entries.**
2. **The hull-cutting bench** — a `minigameVenues` entry (`{id, kind, label, centre, radius, yTolerance, reward, requires, config}`, `MinigameManager._readVenue :503-552`) at the Bastion's flank. A timed panel-alignment / cut-line game consuming `laser_cell`, which is what stops `laser_cell` being a Drop-One item with no use. Registered kinds are looked up at `registerGame` (`MinigameManager.js:196`) and an **unregistered kind is silently inert** — so this needs one new game module.
3. **The test-fire range**, a second venue in the trench: static targets, your existing carried weapons, three difficulty rows. It teaches the aiming feel before space combat exists, it reuses `rules.weapons` and the existing viewmodel, and it gives quest line "Fitting Out" a non-fetch objective. Emits `quest:activity {type:'minigame'}` on any finish (`:702`).
4. **The spec board.** One canvas-painted board per berth showing that hull's four stat bars, its slot swatches and its price — readable from the floor without opening a menu. Cheap (the `_board()` helper already exists, `SurveyWorld.js:346-376`), and it makes "the ships differ in more than colour" *legible* rather than merely true. The comparison is the shopping, and shopping is the loop of this world.
5. **Ship ownership as a `Relics`-style finite set.** Three hulls, three ways to get one: buy the Kestrel, earn the Dray through the Yard Rat line, and unlock the Pike with the relic/viewpoint set. Uses only existing grant paths (`cosmetics.unlock`, `grantPower`, `grant_item`).

**Rejected, explicitly:**
- **A crane or turntable that carries the player.** `Physics.setBoxColliderY` (`:658-666`) is the *entire* dynamic collider API and is Y-only — safe only because the broadphase is XZ-indexed (`:648-656`). Horizontal motion means `remove` + re-add per frame, which fragments the broadphase and requires keeping `world.colliders` in step or the next world switch re-adds a ghost. And a moving surface must **assign** the rider's height, not increment it — a 5 mm/frame increment is inside the solver's own correction and gets cancelled (`StationWorld.js:11002-11031`; riders reached 2.84 m of 4.80 twice before that was understood). A vertical service lift is legal and is the version to build.
- **A zero-g maintenance bay.** There is no per-volume gravity system. `WaterVolumes` is the only volume system in the engine and repurposing swim physics as zero-g would be a lie that leaks into `rules.swim`, buoyancy and the HUD.
- **NPC crew who assemble a ship over the session.** No scheduling, no build-state animation, no persistence hook for it. It would be four NPCs miming next to static geometry.
- **A second walkable exterior (EVA on the yard's outer hull).** It needs the flight drop's frame of reference and doubles the reachability surface for a view you get free from the crane cab.

---

## 10. BUDGETS AND TEST STRATEGY

### Numeric budgets

| Budget | Value | Basis |
|---|---|---|
| Total `build()` | **≤ 900 ms** | station is 6.5 s over 1,440 m; the yard is ~1/8 the area with more interior |
| `_buildTextures` | **≤ 400 ms** | station 1,405 ms (`StationWorld.js:1865`) |
| Sign atlas | **≤ 1024 × 1536** (4 cols × 4 rows of 256×384) | station's 3072×4224 is costed in-comment at **28 MB** for 28 signs (`:2005-2015`). `SIGN_COLS/ROWS` is a per-world number |
| Tiled surfaces | **8 keys at 1024 px**, normal strength ≤ 1.6 | `:1975-1994`; a 512 tile with a strong normal repeated 20× boils at grazing angles |
| Worst single non-yielding frame | **≤ 340 ms** | the station chunker's, `:3124` |
| Draw calls, worst framing | **≤ 220** | measured with `renderer.info.render.calls` (`Harness.js:889`) |
| Triangles drawn | **≤ 900 k** | measured with `src/dev/WorldTriangles.js`, **not** `renderer.info` — that moves 10-13% between loads of the same framing because the shadow pass follows the player |
| Programs | **no increase over station baseline** | `renderer.info.programs.length` (`Harness.js:1117`) |
| `RIG_BUDGET` | **unchanged**: point 12, spot 2, dirShadow 2, dirFill 3 (`src/gfx/LightRig.js:62`) | 42 point lights = 59.8 s of compile vs 6 = 13.0 s; each slot removed is ~5% of the entire cold shader warm |
| Authored point lights | **≤ 10 motivated practicals**, all `castShadow:false`, hung at **9 m not 5 m**, all LightRig *sources* | `StationWorld.js:9731`; 1050 cd at 5 m is 8× the bloom threshold |
| Emissive | does the rest, via the distance-graded `emissive()` factory (`:2382`) | `mix(0.30, 1.0, smoothstep(120.0, 46.0, dist))`, never to zero |
| Ambient + hemi combined | **< 1.0** | stated rule at `:10530`; shipped 0.20 + 0.36 |
| Colliders total | **≤ 1,400** | |
| Triangle-soup chunks | **≤ 1,500** at `CHUNK_TRIS = 32`, re-split with `chunkTrianglesBySpan(soup, 32, 4)` | `StationKit.js:948`, `:1047`. `PLANTING_SPAN = 4`: a count is not a size budget — sixty scattered objects were one chunk whose box measured **250 × 301 m** and sealed a fifth of the map |
| `resolveCapsule` | **≤ 40 µs** median | station holds 34 µs over 4,096 chunks / 108,010 triangles (`:3104`) |
| Interior LOD | every ship interior in its own `GeoBatch`, `DistanceLod` `hideBeyond: 40`, `measure: CENTRE`, `band: 6` | `Tower.js:501-521`, `lod/DistanceLod.js:111`. **Re-decide, do not inherit:** the station's "no LOD outside interiors" is a reasoned trade for one continuous deck; a yard of walk-in hulls is the tower case |
| Mean frame luma inside every walkable interior | **≥ 40 / 255** | the two "dark" medieval rooms measured 28.0 and 23.4; after the *geometry* fix, with no lighting change, 50.9 and 41.7 (`medieval-approach.test.mjs:612-616`) |

Slicing: follow `StationWorld.js:1881-1890` exactly — `const slice = onProgress?.slice; const breathe = (f,l) => slice ? () => slice(f,l) : noBreath;` with `step(f,label,fn)` yielding a frame before each phase. `slice` is a **no-op behind the loading screen** (`WorldManager.js:277`) because `engine.running` is false; that is deliberate and pinned by `station-build-slicing.test.mjs`, which counts rAF calls and drives the prop pass twice — straight through and yielding on every call — demanding identical colliders in identical order.

Phase order is asserted and matters: `_buildStructure → _dress → _solidifyProps → _solidifyStructure` (mirrors `StationWorld.js:1922-1929`); the structure pass reads the boxes the prop pass wrote in order to discard enclosed triangles.

### Reachability invariants — this project's signature defect

Fifteen of fifty-four medieval enterables could not be entered past a 1,074-test suite, because *"every existing test asks whether a thing was BUILT correctly, and no test asked whether a player standing outside it could reach it"* (`medieval-approach.test.mjs:1-32`). The station shipped a hangar mezzanine that was built, glazed, railed and unreachable (`StationWorld.js:7268`).

Six new test files. The first is worth more than the other five combined.

**`scripts/tests/dock-registration.test.mjs`** — one assertion per silent row in §2: `DROP_TABLES.dock`, `CACHE_TABLES.dock`, `SUPPLY_WANTS.dock`, `WORLD_MARKETS.dock`, `THEME_BY_WORLD.dock`, `FALLBACK_NAMES[theme]` non-empty, `CROWD_NAMES`/`CROWD_PERSONAS`/`WEAPON_TABLES`/`ROLE_CAST` for the theme, a costume set in all four `Humanoid.js` tables *or* an explicit documented reuse, `MERCHANT_SIGN_WORLD.dock`, `GRADE_PRESETS.dock`, `SCORES.dock`, `DEFAULT_LORE.dock` and `.space`, `LORE_ORDER` membership, `'dock' ∈ MARKETPLACE_WORLDS`, `WORLD_PRICE_MULTIPLIERS.dock` **numerically equal to** `WORLD_MARKETS.dock`'s corresponding multipliers (nothing else enforces that), and the canonical-facts sentence in `buildLorePersona` mentioning the yard. **This converts fourteen silent defects into a red suite.** Model it on `quest-content.test.mjs:554-587`, which pins `DROP_TABLES.citadel` with the message *"the station fallback is back"*.

**`dock-reach.test.mjs`** — headless capsule marches, the `medieval-approach.test.mjs:292-341` pattern. For every door, derive the outward normal from `door.position − origin`, march in from **15 bearings, −70° to +70°**, at three start radii: head-on must work for **every** door, and ≥ 6 of 15 bearings must be usable, with every step ≤ `stepHeight = 0.45`. Targets: spawn → each of 3 vendor counters → each ship's ramp foot → each hatch → each cockpit seat → each cargo hold → **and back out**. Plus: spawn → both gantry stairs → the full catwalk loop; spawn → trench → out; spawn → blast-door portal disc, grounded. Assert `|player.y − door.position.y| ≤ 2.6` at the standing point of every hatch (`Interiors.js:374`) — the winding-house defect.

**`dock-interiors-clear.test.mjs`** — the full-plan-box rule, ported from `medieval-approach.test.mjs:595-668`. Rebuild each ship interior **at the origin and unrotated** (an AABB of a yawed box is not the box, `:653`), flag any part where `foot ≥ area × 0.5` **and** `maxY > floorY + 0.15` **and** `minY < ceilY − 0.06` **and** `maxY < ceilY` (that last clause exempts the hull crown, which spans the plan and carries on up). Assert zero. The medieval run found 130 slabs.

**`dock-climb.test.mjs`** — for every hull advertised climbable: at 1.166 m, the three-ray fan finds a face with `|n.y| ≤ 0.5`; rest ledges no more than 9 m apart vertically; and a mantle target with `normal.y ≥ 0.7`, ≥ 0.77 m of flat inboard, 1.55 m headroom, and a `resolveCapsule` reporting grounded within `[topY − 0.35, topY + 0.3]` and sliding < 0.2 m. Then a full chain spine → gantry. Also assert **no `addTriangleSoup`/`addTriangleMesh` collider intersects any ship footprint.**

**`dock-interior-light.test.mjs`** — the paired measurement, both halves, because *"neither alone would have found the defect"* (`medieval-approach.test.mjs:510-521`): floor illuminance from the descriptor's declared `lights` (asserted off the descriptor, not by walking the scene — *"a stray point light forty metres away in the street would satisfy a proximity test while lighting nothing"*, `:396-399`), **and** mean frame luma ≥ 40/255 rendered inside each space.

**`ship-catalog.test.mjs`** — mirror of `mount-catalog.test.mjs`: esbuild-bundle the TS catalogue, assert every ship row's stat against `SHIP_STATS`, every skin id against `KNOWN_SHIP_SKIN_IDS`, unique `source_key`s, and `cost_buy > cost_sell` on every row so buy→sell→buy cannot print credits. Plus `mount-menu.test.mjs:15-28`'s rule for ships: every `defaultColor` is a member of its own palette.

Plus: extend `scripts/contract-check.mjs` with a `dock` entry whose `fields:` pins `['enterables','viewpoints','haystacks','minigameVenues','_roofs','_towers','shipSpecs','portalSpecs','npcSpawns','minimapShapes']` — `fields` (`:390-405`) is the **only** mechanism in the repo that pins a published array name, and every one of those is read via optional-chain so a typo is silent.

---

## 11. THE FIVE BIGGEST RISKS

**1. A ship you can see into and cannot get into.**
This world is four buildings and the entire feature is their insides. The medieval suite passed 1,074 tests over fifteen unenterable buildings; the station glazed and railed a mezzanine nothing could reach (`StationWorld.js:7268`).
*Measurement that settles it:* `dock-reach.test.mjs`. Head-on approach succeeds for 100% of hatches and counters; ≥ 6 of 15 off-axis bearings succeed for each; every step ≤ 0.45 m; and a return march out. Report it as a table of `(target, bearings_passed/15)` in CI output, not a boolean — a 6/15 that used to be 14/15 is a regression you want to see.

**2. Shader compile blow-up from a new material set plus hangar lighting.**
42 point lights measured **59.8 s** of compile against 12's 19.4 s on the same 207 programs (`LightRig.js:16-33`); the station once recompiled everything in one blocking frame when a portal was entered, measured at **83 s**. A yard is the exact brief that invites forty practicals.
*Measurement:* `renderer.info.programs.length` and cold warm-to-first-frame before and after, on the same machine, plus an assertion that **no authored PointLight in `world.group` is ever `visible === true`** — every one is a LightRig source, and `lightRig.claim(world.group)` runs the instant `build()` returns (`main.js:1459`, `LightRig.js:262`). If `RIG_BUDGET.point` is ever raised from 12 to 16, that is ~28% of the cold shader warm **across the whole game**, and it must be a separate, measured, argued change.

**3. The compartments are full of the structure that describes them.**
Fourth occurrence of the full-plan-box family (medieval plank courses, medieval string course, medieval bressumer, station tower string course — 251 of 407 z-fighting hits and a sealed atrium). Ship interiors are made of exactly the members that trigger it: frames, stringers, deck beams, cable trays. And **it will not be caught by a headroom probe**, because these members have no colliders — the medieval headroom test correctly reported 2.85 m of clear height above a room you could not see across (`MedievalWorld.js:6858-6861`).
*Measurement:* `dock-interiors-clear.test.mjs` (geometry, not colliders) paired with the two-part light measurement. Both halves. The medieval rooms that were "too dark" were *ahead* of the controls on floor illuminance — 5.17 and 4.59 against 3.10 and 3.29 — while measuring 28.0 and 23.4 mean luma, and the geometry fix alone took them to 50.9 and 41.7 with **no change to any light in the game**.

**4. The world boots, looks correct, and is quietly the station.**
Fourteen silent rows in §2. The precedent is not hypothetical: citadel's twenty-five crowd slots wore station dockhand costumes; a desert garrison dropped 6 mm caseless because `DROP_TABLES` fell back; two shipped quest steps asked for ammunition that world does not manufacture and **passed validation** because the fallback made them technically obtainable; citadel/race/maze/survey still have no PostFX grade; survey has no music at all.
*Measurement:* `dock-registration.test.mjs`, run in CI before any content lands. A world that boots into silence with a station cast and station drop tables is not a bug you notice in playtest — it is a world that feels vaguely wrong for a week.

**5. The launch seam gets rebuilt in the flight drop.**
Three concrete ways it goes wrong: the portal is authored inside a cockpit and `arrivalFor`'s 2.6 m offset puts the returning pilot in a bulkhead (`WorldManager.js:422-423`); a second spec is added for the return leg and `arrivalFor`'s first-match-by-target lookup (`:427`) picks the wrong one; or `_kit()` (`Portals.js:1215`) is never branched and the blast door grows a ceremonial arch with three approach steps.
*Measurement:* a headless round trip **in this drop**, against the stub `SpaceWorld` — `dock → space → dock`, asserting the arrival position on each leg lies inside the intended footprint (blast-door apron on the return; space platform on the outbound), that `resolveCapsule` reports grounded at both, and that `dock.portalSpecs.filter(s => s.target === 'space').length === 1`. If that test is green at the end of Drop One, the flight drop plugs in; if it does not exist, the flight drop starts by rewriting the dock.