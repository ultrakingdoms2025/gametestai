# AETHER NEXUS — Build Contracts

**Read this fully before writing code.** Every module below is owned by exactly one agent.
Do not create, edit, rename, or delete a file you do not own. If you need something from
another module, use the API defined here — it is guaranteed to exist.

---

## 0. Hard constraints

- **Stack:** Vite 8.1.5 + Three.js **0.185.1**. No other runtime dependencies. No React.
- **Imports:** `import * as THREE from 'three'` and `import { X } from 'three/addons/<path>.js'`.
  The `three/addons/*` export map is valid in 0.185.
- **No external assets whatsoever.** No CDN textures, no GLTF downloads, no fonts inside WebGL.
  Every texture, normal map, roughness map and mesh is generated procedurally at runtime
  (canvas2d, noise, or buffer geometry). This is non-negotiable — the game must run offline.
- **Units:** metres. **Y is up.** Characters face **-Z** at yaw 0. 1 world unit = 1 metre.
- **Colour:** author all colours in sRGB via `new THREE.Color(0xrrggbb)`. Renderer output
  colour space and ACES tone mapping are already configured in `Engine`. Do **not** change
  renderer-level settings from inside a subsystem.
- **Performance budget:** 60 fps at 1080p on a mid-range GPU. Keep draw calls under ~900 per
  world. Use `InstancedMesh` for anything repeated more than ~12 times. Share materials.
- **Disposal:** anything you `new` that holds GPU memory must be disposable.
- Write JSDoc on public methods. Comment *why*, not *what*. Match the house style already
  visible in `src/core/Engine.js` and `src/physics/Physics.js`.

---

## 1. Existing foundation (DO NOT EDIT — read only)

| File | Exports | Notes |
|---|---|---|
| `src/core/Config.js` | `CONFIG`, `applyUrlOverrides()` | All tunables. Add new keys if you own a subsystem that needs them. |
| `src/core/EventBus.js` | `EventBus`, `bus` | `on/once/off/emit/emitDeferred/flush` |
| `src/core/Engine.js` | `Engine` | `.renderer .scene .camera .clock .elapsed .stats`, `onFixedUpdate(fn)`, `onFrameUpdate(fn)`, `resize()`, `start()` |
| `src/core/Input.js` | `Input` | `.state {forward,right,jump,sprint,crouch,fire,aim,reload,interact}`, `pressed(code)`, `consumeLook()`, `consumeWheel()`, `setTextCapture(bool)`, `requestLock()`, `exitLock()`, `.locked` |
| `src/physics/Physics.js` | `Physics`, `Collider`, `COLLISION_LAYER` | see §2 |
| `src/worlds/World.js` | `World` | base class, see §5 |
| `src/main.js` | — | integration point. **Owned by the orchestrator.** If you need a wiring change, say so in your report; do not edit it. |

### The shared context object

Every subsystem constructor receives an object containing at least:

```js
{ scene, engine, physics, bus, materials, input }
```

plus subsystem-specific extras listed below. Destructure what you need; ignore the rest.

---

## 2. Physics API (already implemented)

```js
physics.addBox(cx, cy, cz, halfX, halfY, halfZ, opts) -> Collider
physics.addRotatedBox(centerVec3, halfExtentsVec3, rotationY, opts) -> Collider
physics.addBoxFromObject(mesh, opts) -> Collider          // derives OBB from geometry + world matrix
physics.addTriangleMesh(mesh, opts) -> Collider           // bakes to world space; use for terrain/ramps
physics.resolveCapsule(positionVec3, radius, height) -> { grounded, groundNormal, hitCount }
physics.raycast(origin, dirNormalized, maxDistance, layerMask) -> { distance, point, normal, collider } | null
physics.groundHeight(x, z, startY, maxDrop) -> number | null
physics.query(centerVec3, radius, outArray) -> Collider[]
```

`opts` = `{ layer, userData, solid }`. `COLLISION_LAYER` = `WORLD | PLAYER | NPC | PROJECTILE | TRIGGER | ALL`.
`resolveCapsule` mutates `position` in place (position is the **feet**, not the centre).

---

## 3. Event catalogue (authoritative)

Emit and listen only to these. Adding an event is fine — document it in your report.

| Event | Payload | Emitted by |
|---|---|---|
| `game:started` | — | main |
| `engine:resize` | `{width, height}` | Engine |
| `engine:stats` | `{fps, frameMs, drawCalls, triangles}` | Engine |
| `input:lockchange` | `{locked}` | Input |
| `world:changing` | `{from, to}` | WorldManager |
| `world:changed` | `{id, world}` | WorldManager |
| `world:ready` | `{id}` | main |
| `worlds:all-ready` | — | main |
| `map-overlay:applied` | `{world, version, builtVersion, applied, unresolved, objects}` | MapOverlay |
| `map-overlay:layout` | `{world, cells, layers, sampledMs}` | MapOverlay |
| `player:spawned` | `{position}` | Player |
| `player:damaged` | `{amount, health, maxHealth, sourcePosition}` | Combat |
| `player:healed` | `{amount, health, maxHealth}` | Player |
| `player:died` | `{killerId}` | Combat |
| `player:respawned` | — | Player |
| `weapon:fired` | `{origin, direction, spread, ammo}` | Weapon |
| `weapon:reload-start` | `{duration}` | Weapon |
| `weapon:reload-end` | `{ammo, reserve}` | Weapon |
| `weapon:ammo` | `{ammo, reserve, magazine}` | Weapon |
| `weapon:hit` | `{point, normal, isNPC, isHeadshot, damage}` | Combat |
| `npc:spawned` | `{npc}` | NPCManager |
| `npc:damaged` | `{npc, amount, health, isHeadshot}` | Combat |
| `npc:killed` | `{npc, byPlayer}` | Combat |
| `npc:despawned` | `{npc}` | NPCManager |
| `chat:available` | `{npc}` or `{npc:null}` | NPCManager (proximity) |
| `chat:open` | `{npc}` | HUD |
| `chat:close` | — | HUD |
| `chat:player-message` | `{npc, text}` | HUD |
| `chat:npc-message` | `{npc, text, streaming}` | ChatClient |
| `chat:error` | `{npc, message}` | ChatClient |
| `portal:near` | `{portal}` or `{portal:null}` | PortalSystem |
| `portal:entering` | `{from, to, duration}` | PortalSystem |
| `hud:notify` | `{text, tone}` where tone ∈ `info \| warn \| kill \| lore` | anyone |

**Overlay provider (map editor stage 2).** `main.js` sets `worldManager.ctx.overlayProvider = (worldId) => Promise<{version, entries, admin} | null>` on the manager's own ctx before the entry build, gated on a signed-in session (`accountStatePromise`). `WorldManager._runBuild` awaits it before `ensureBuilt` (no provider: no await; 8 s behind the loading gate, 1.5 s otherwise; after one background timeout, background builds skip the provider for a minute, then one probes) and stores `world.builtVersion` (0 when none). The provider is `MapOverlay.lookup` (contract-pinned, with `prefetch`): one cached document per world per session, shared by everyone asking, each fetch aborted at 10 s (`LOOKUP_ABORT_MS`, said once per world); `mapOverlay.prefetch(startWorld)` runs before `materials.warmup` so the entry world's GET overlaps the warm. The report POST carries `builtVersion` beside `appliedVersion`; it carries no `schema`.

**Applier reasons (game → site).** `unresolved[].reason` on `map-overlay:applied` and on the report POST is one of `name | span | pending-rebuild | id | superseded | error | item | no-loot | position | pool` (`src/systems/MapOverlay.js`; the editor's `unresolvedText` labels all ten).

---

## 4. Module ownership and required API

### 4.1 `src/gfx/Textures.js` + `src/gfx/Materials.js` — **Agent: MATERIALS**

```js
export class MaterialLibrary {
  constructor(renderer)
  async warmup()                       // generate + upload shared textures, resolve when ready
  get(key)                             // -> THREE.Material (cached, shared)
  has(key)
  register(key, material)
  dispose()
}
```

Required material keys (worlds rely on these existing; you may add more):
`metal.hull`, `metal.panel`, `metal.grate`, `metal.trim`, `concrete.road`, `concrete.wall`,
`glass.tinted`, `glass.window`, `emissive.cyan`, `emissive.magenta`, `emissive.amber`,
`stone.castle`, `stone.cobble`, `wood.plank`, `wood.beam`, `thatch.roof`, `dirt.ground`,
`grass.field`, `fabric.banner`, `asphalt.court`, `concrete.skatepark`, `snow.piste`,
`rubber.track`, `plastic.court`, `water.pool`.

Also export texture generators from `Textures.js` so worlds can produce variants:
`makeNoiseTexture`, `makeNormalFromHeight`, `makeTilingPattern`, `makeGradientTexture`,
`makeRoughnessMap`, `makeDetailNormal`. All return `THREE.Texture` / `THREE.DataTexture`
with correct `colorSpace` (albedo = `SRGBColorSpace`, data maps = `NoColorSpace`) and
`wrapS/wrapT = RepeatWrapping`, `anisotropy = renderer.capabilities.getMaxAnisotropy()`.

Quality bar: every surface needs albedo + normal + roughness at minimum. Flat untextured
`MeshStandardMaterial` colours are an automatic fail.

### 4.2 `src/gfx/PostFX.js` + `src/gfx/Sky.js` — **Agent: POSTFX**

```js
export function createPostFX(engine) {
  return { render(dt), setSize(width, height), setWorldGrade(environment), composer, setEnabled(bool) };
}
```

Chain: RenderPass → GTAO/SSAO → Bloom (selective/threshold) → custom grade
(tone curve, vignette, chromatic aberration, film grain, subtle lens distortion) → SMAA → Output.
`setWorldGrade(env)` retunes bloom/exposure/colour balance per world from
`world.environment.bloom` and `world.environment.grade`.
`Sky.js` exports `createSky(kind, params)` returning `{ mesh, sunDirection, update(dt), dispose() }`
for `kind` ∈ `'space' | 'daylight' | 'alpine'`. Space = starfield + nebula + planet;
daylight = physical atmospheric scattering; alpine = high-altitude haze.

### 4.3 `src/player/Player.js` + `src/player/Weapon.js` — **Agent: PLAYER**

```js
export class Player {
  constructor({ scene, engine, physics, bus, materials, input, camera })
  fixedUpdate(dt, elapsed)
  update(dt, elapsed)
  get position()            // THREE.Vector3, feet, live reference
  get yaw()                 // radians
  get health() / get maxHealth()
  get isDead()
  applyDamage(amount, sourcePosition, sourceId)
  heal(amount)
  teleport(positionVec3, yaw)
  respawn()
  get weapon()              // -> Weapon
  get eyePosition()         // THREE.Vector3 (new each call is fine)
  get forward()             // THREE.Vector3
}
```

Movement: acceleration-based with ground friction and air control, crouch, sprint,
step-up over `CONFIG.player.stepHeight`, coyote time, head-bob, landing camera dip,
FOV kick on sprint. Must feel like a modern shooter, not a demo.

```js
export class Weapon {
  constructor({ scene, camera, bus, materials, engine, input })
  update(dt, elapsed)
  tryFire(elapsed) -> boolean   // respects fire rate; emits weapon:fired
  reload()
  get ammo() / get reserve() / get magazine() / get isReloading()
  get spread()
  addRecoil() / getRecoilOffset()
  dispose()
}
```

Viewmodel: a procedurally modelled machine gun rendered on a **separate camera layer**
(layer 1) with its own near plane so it never clips into walls. Needs: idle sway, walk
bob, ADS transition, recoil kick + recovery, animated bolt/charging handle, muzzle flash
(light + billboard), shell ejection, barrel heat glow, and a reload animation.
Weapon stats come from `CONFIG.weapon.machinegun`.

### 4.4 `src/npc/*` — **Agent: NPC**

Files you own: `Humanoid.js`, `NPCAnimator.js`, `NPC.js`, `FriendlyNPC.js`, `HostileNPC.js`,
`NPCManager.js`, `Navigation.js`.

```js
export class NPCManager {
  constructor({ scene, engine, physics, bus, materials, player })
  spawnForWorld(world)      // reads world.npcSpawns, builds NPCs
  clear()                   // despawn all, free GPU resources
  fixedUpdate(dt, elapsed)
  update(dt, elapsed)
  get npcs()                // NPC[]
  get hostiles() / get friendlies()
  nearestFriendly(position, maxRange) -> NPC | null
  raycastNPCs(origin, direction, maxDistance) -> { npc, point, distance, isHeadshot } | null
}
```

Each NPC exposes: `.id .type ('friendly'|'hostile') .name .persona .position .health
.maxHealth .isDead .root (THREE.Object3D) .applyDamage(amount, isHeadshot, source)`.

**Humanoid quality bar:** a real skinned character — skeleton with pelvis, spine×3, neck,
head, clavicles, upper/lower arms, hands, thighs, calves, feet. Body built from lofted
`BufferGeometry` with proper skin weights, not a stack of boxes. Clothing/armour varies by
world (station = techwear/EVA, medieval = tunics/mail, sports = athletic wear). Faces need
geometry (brow, nose, jaw), eyes that blink and track the player, and varied skin tones,
heights and builds.

**Animation:** procedural, driven by `NPCAnimator` — walk/run cycles with weight shift,
arm counter-swing, foot IK to ground normals, idle breathing and weight-shift, turn-in-place,
aim pose blending, flinch on hit, and physically plausible death ragdoll-ish collapse.
No T-poses, no sliding feet.

**AI:** hostiles patrol → detect (FOV cone + LOS raycast) → chase → strafe/take cover →
fire in bursts with `CONFIG.npc.accuracy` → reposition. Friendlies wander waypoints, idle
in groups, turn to face and greet the player within `CONFIG.npc.chatRange`, and emit
`chat:available`. Steering avoids walls (probe raycasts) and other NPCs.

### 4.5 `src/ui/*` — **Agent: HUD**

Files you own: `HUD.js`, `Minimap.js`, `ChatBox.js`, `hud.css`, `src/ai/ChatClient.js`.

```js
export class HUD {
  constructor({ bus, engine, input, root, player, worldManager, npcManager, portals })
  update(dt, elapsed)
  get chatOpen()            // boolean — main.js reads this on pointer unlock
  showPauseOverlay(bool)
  setDebugVisible(bool)
  notify(text, tone)
  dispose()
}
```

Required HUD elements, all DOM/CSS + one canvas for the minimap:
1. **Minimap** (canvas, top-right): player arrow at centre with rotation, world floorplan
   from `world.minimapShapes`, portal markers colour-coded by destination, hostile NPCs (red),
   friendly NPCs (cyan), off-screen edge indicators, range ring, zoom on mouse wheel.
2. **Chat box** (bottom-left): message log with speaker names, input field opened with `T`
   or `E` near a friendly. Must call `input.setTextCapture(true/false)` and release/re-request
   pointer lock. Streaming NPC replies render token-by-token.
3. **Health** (bottom-left above chat): numeric + bar, damage flash, low-health vignette
   pulse, regen shimmer.
4. Ammo counter (bottom-right), crosshair that opens with spread and shows hitmarkers,
   damage direction indicators, kill feed, interaction prompt ("[E] Talk to …"),
   world-transition wipe, debug stats panel.

Visual bar: this is a AAA sci-fi HUD. Chakra Petch / Rajdhani are loaded in `index.html`.
Use them. Subtle animation, glass-morphism, glow, scanlines — no default browser styling.

```js
export class ChatClient {
  constructor(bus)
  async send(npc, text, { onToken, signal }) -> string   // POSTs /api/chat
  history(npcId) -> Array<{role, content}>
  reset(npcId)
}
```

`/api/chat` request: `{ npcId, npcName, persona, world, playerMessage, history }`.
Response: SSE stream of `{type:'delta', text}` then `{type:'done'}`, or `{type:'error', message}`.
If the backend is unreachable or has no API key, fall back to a local persona-driven
response generator so the feature always visibly works — surface a single subtle
"offline persona" badge rather than an error spam.

### 4.6 `server/chat-server.js` — **Agent: HUD** (same agent, small file)

Node 22, zero-framework `node:http` server on port 8787. Reads `ANTHROPIC_API_KEY` from
env (support `.env` via a tiny parser — no dotenv dependency). Uses `@anthropic-ai/sdk`
(devDependency, already installed) with model **`claude-sonnet-5`**, streaming.
System prompt built from the NPC persona + world context, capped at ~120 output tokens so
replies feel like in-game barks. Rate-limit per IP. If no key is present, respond
`{type:'error', message:'no-key'}` immediately so the client falls back cleanly.

### 4.7 `src/worlds/WorldManager.js` + `src/systems/Portals.js` — **Agent: PORTAL**

```js
export class WorldManager {
  constructor(ctx)
  register(WorldClass)
  get ids()                          // string[]
  get active()                       // World | null
  getWorld(id)
  async build(id, onProgress)        // idempotent; onProgress(0..1, label)
  async activate(id, { fromPortal } = {})
  isBuilt(id)
}
```

`activate` must: emit `world:changing`, deactivate the old world (hide group, clear its
colliders from physics), reset `physics`, register the new world's colliders, move the
player to the spawn (or the matching return portal if `fromPortal` is given), respawn NPCs
via `npcManager`, rebuild portals, then emit `world:changed`.

**Important:** `Physics` currently has `clear()` which wipes everything. Worlds keep their
`colliders` array — on activation, re-add them to a clean physics world. Add a
`physics.addExisting(collider)` path if needed and note it in your report.

```js
export class PortalSystem {
  constructor({ scene, engine, physics, bus, materials, player, worldManager })
  buildForWorld(world)      // reads world.portalSpecs
  fixedUpdate(dt, elapsed)
  update(dt, elapsed)
  get portals()             // [{ position, target, label, accent, mesh }]
  clear()
}
```

Portal visuals must be the set-piece of the game: a rippling volumetric event horizon
(custom shader — swirling refraction, fresnel rim, parallax depth, chromatic edge),
an ornate frame that matches the *destination* world's style, particles drawn inward,
light spill onto nearby geometry, and a **live preview of the destination world** rendered
to a render target inside the portal disc. Approaching within `CONFIG.portal.activationRange`
shows the prompt; entering triggers a full-screen transition (radial warp + white flash +
audio-less shockwave) and swaps worlds.

### 4.8 `src/systems/Combat.js` — **Agent: COMBAT**

```js
export class CombatSystem {
  constructor({ scene, engine, physics, bus, materials, player, npcManager })
  fixedUpdate(dt, elapsed)
  update(dt, elapsed)
}
```

Hitscan resolution for the player's machine gun (raycast vs NPCs *and* world, nearest wins),
headshot detection, damage falloff over distance, NPC return fire against the player with
LOS checks, and all combat VFX: tracers, impact sparks/decals per surface type, blood hits,
muzzle smoke, bullet-hole decals with a pooled ring buffer, and screen-shake on damage taken.
Pool every particle system — zero per-shot allocations in the hot path.

### 4.9 The three worlds

All three extend `World` (§5). Each is a **large, walkable, open** space — not a corridor demo.
Target ~400×400 m of interesting, navigable terrain with clear landmarks and sightlines.

- `src/worlds/StationWorld.js` — **Agent: WORLD-STATION**. `static id = 'station'`.
  Orbital space station interior/exterior: wide plated roads with painted markings, modular
  habitat and commercial buildings with interiors visible through glass, gantries, catwalks,
  hazard stripes, holographic signage, docking arms, antenna arrays, and a vast starfield +
  planet + distant ships beyond the hull glass. Cyan/amber industrial palette. **Contains
  all three portals** (one is the return-to-self anchor — instead give it two outbound
  portals to medieval and sports, placed at opposite ends of a central plaza).
- `src/worlds/MedievalWorld.js` — **Agent: WORLD-MEDIEVAL**. `static id = 'medieval'`.
  Castle + village: keep with towers and battlements, timber-framed houses, thatch, market
  square with stalls and banners, cobbled streets, a river with a stone bridge, rolling
  grass hills with instanced trees and grass, a courtyard, and warm late-afternoon light.
  One portal back to the station.
- `src/worlds/SportsWorld.js` — **Agent: WORLD-SPORTS**. `static id = 'sports'`.
  Sports complex: concrete skate park (bowls, quarter pipes, rails, ledges — all skateable
  geometry with correct collision), a snow slope with piste markers/moguls/chairlift, floodlit
  pickleball and tennis courts with nets and fencing, a running track, a swimming pool, and
  bleachers. Bright midday light, saturated sport-surface colours. One portal back to the station.

---

## 5. `World` subclass contract

```js
export class MyWorld extends World {
  static id = 'myworld';
  static displayName = 'My World';

  async build(onProgress) {
    // 1. Build geometry into this.group
    // 2. Register colliders via this.physics.* and this.track(collider)
    //    (or this.addSolid(mesh) which does both)
    // 3. Fill this.playerSpawn / this.playerSpawnYaw
    // 4. Fill this.npcSpawns  -> [{position, type, persona, name, patrol}]
    // 5. Fill this.portalSpecs -> [{position, rotationY, target, label, accent}]
    // 6. Fill this.bounds and this.minimapShapes
    // 7. Configure this.environment
    // Call onProgress?.(0..1, 'label') between heavy stages and `await yieldFrame()`
    //    so the loading bar animates.
  }
  update(dt, elapsed) { /* animated world elements only */ }
}
```

`minimapShapes` entries:
```js
{ kind:'rect', x, z, w, d, rotation, fill, stroke }
{ kind:'circle', x, z, r, fill, stroke }
{ kind:'path', points:[[x,z],...], stroke, width, closed }
```

`npcSpawns[].persona` is a 1–3 sentence character brief sent to the AI backend.
Give friendlies **distinct names and personalities** appropriate to their world.

---

## 6. Definition of done (each agent self-checks before reporting)

1. `npx vite build` succeeds with no errors from your files.
2. No `console.error` from your module at runtime.
3. Every public method in your contract exists with the right signature.
4. Nothing you own allocates per-frame in a hot loop (reuse vectors — see the `_v1` pattern).
5. Your visuals would survive a harsh AAA art-direction review. Flat colours, obvious
   primitives, z-fighting, missing shadows, or default material settings are failures.
6. Report back: what you built, any API you added, anything you need from another module,
   and anything you deliberately left out.
