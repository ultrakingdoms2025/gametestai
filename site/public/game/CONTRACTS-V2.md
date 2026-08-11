# AETHER NEXUS — Feature Contracts v2

Additive to `CONTRACTS.md` (all §0 hard constraints still apply: Three.js 0.185.1, no
external assets, everything procedural, 60fps budget, JSDoc, house style).

**Read `CONTRACTS.md` §0–§3 first.** This document only covers the six new features.

---

## 0. What we are building

1. **Unstuck / reset** — recover when the player is trapped in geometry.
2. **Camera modes** — toggle first-person ↔ **third-person** (camera behind an actual
   visible player character). The user wrote "second person"; they mean the over-the-
   shoulder view, i.e. third-person.
3. **Weapons** — machine gun (exists) + **fireball** + **bow & arrow**, with selection.
4. **Credits** — +5 per NPC killed by the player.
5. **Save / load** — persist position, world, credits, loadout and mounts across sessions.
6. **Mounts** — **hoverboard** (fast ground travel, boost, smooth lean animation) and
   **dragon** (ridden, free flight over the map).

---

## 1. Keybinds (authoritative — do not invent your own)

| Key | Action | Owner |
|---|---|---|
| `V` | toggle first/third person | CAMERA |
| `1` `2` `3` | select machine gun / fireball / bow | WEAPONS |
| mouse wheel | cycle weapons | WEAPONS |
| `[` `]` | minimap zoom out/in (**moved off the wheel**) | HUD |
| `K` | unstuck / reset position | PROGRESSION |
| `F5` / `F9` | save / load | PROGRESSION |
| `H` | summon/dismiss hoverboard | MOUNTS |
| `G` | summon/dismiss dragon | MOUNTS |
| `F` | dismount (either mount) | MOUNTS |
| `Shift` | boost (while mounted) | MOUNTS |
| `Space` / `Ctrl` | ascend / descend (dragon only) | MOUNTS |

`Input` already supports any key via the edge-triggered `input.pressed('KeyV')` and the
held state via its internal key set. **Do not edit `src/core/Input.js`** — `pressed()`
records every keydown, so no change is needed. Wheel: `input.consumeWheel()`.

---

## 2. New events

| Event | Payload | Emitted by |
|---|---|---|
| `camera:mode` | `{mode:'first'\|'third'}` | CameraRig |
| `weapon:switched` | `{id, name, index}` | Loadout |
| `weapon:charging` | `{id, charge01}` | Fireball/Bow |
| `projectile:hit` | `{kind, point, normal, npc\|null, damage}` | ProjectileSystem |
| `credits:changed` | `{credits, delta, reason}` | Economy |
| `save:written` | `{at}` | SaveGame |
| `save:loaded` | `{at}` | SaveGame |
| `save:error` | `{message}` | SaveGame |
| `player:unstuck` | `{from, to, reason}` | UnstuckSystem |
| `mount:summoned` | `{id}` | MountManager |
| `mount:mounted` | `{id}` | MountManager |
| `mount:dismounted` | `{id}` | MountManager |
| `mount:boost` | `{id, active}` | MountManager |

---

## 3. Module ownership and required API

### 3.1 CAMERA — owns `src/player/Player.js`, `src/player/CameraRig.js`, `src/player/PlayerAvatar.js`

```js
export class CameraRig {
  constructor({ engine, camera, player, input, bus, physics })
  update(dt, elapsed)          // called by Player.update AFTER movement resolves
  get mode()                   // 'first' | 'third'
  setMode(mode)                // emits camera:mode
  toggle()
  get isThird()
}

export class PlayerAvatar {
  constructor({ scene, engine, materials, player, bus })
  update(dt, elapsed)
  setVisible(v)
  get root()                   // THREE.Object3D
  dispose()
}
```

- **Third-person camera:** spring-arm boom behind and slightly above the player, with a
  collision sweep (`physics.raycast`, or a small sphere cast) so the camera never clips
  into walls — it pulls in smoothly and pushes back out. Over-the-shoulder offset so the
  crosshair is not occluded by the body. Aiming (RMB) tightens the boom and moves closer.
- **Aim correctness is mandatory:** in third-person the weapon must still hit where the
  crosshair points. Resolve by raycasting from the *camera* through screen centre to find
  the aim point, then firing from the muzzle toward that point. Emit `weapon:fired` with
  that corrected direction — Combat already consumes it.
- **PlayerAvatar:** build the body with `HumanoidFactory` from `src/npc/Humanoid.js` and
  animate with `NPCAnimator` from `src/npc/NPCAnimator.js` (both exported). Drive its
  locomotion from `player.velocity` / `player.grounded` / crouch / sprint state.
  In first-person, hide the body but **keep it casting shadows** (`castShadow` on,
  material visible false is wrong — use `object.visible=false` only for the render and
  rely on a shadow-only proxy, or simply hide only the head/torso when the camera is
  inside the body). Pick an approach that avoids the player seeing the inside of their
  own head, and say which you chose.
- Player.js already exposes `position`, `velocity`, `yaw`, `pitch`, `grounded`,
  `isCrouching`, `isSprinting`, `eyePosition`, `forward`, `teleport()`, `respawn()`.
  Keep all of them working — other systems depend on them.
- `player._harnessFrozen` must keep working (the screenshot harness sets it).

### 3.2 WEAPONS — owns `src/player/Weapon.js`, `src/player/Loadout.js`, `src/weapons/Fireball.js`, `src/weapons/Bow.js`, `src/systems/Projectiles.js`, `src/systems/Combat.js`

```js
export class Loadout {
  constructor({ scene, camera, engine, physics, bus, materials, input, player, npcManager, projectiles })
  update(dt, elapsed)
  fixedUpdate(dt, elapsed)
  select(indexOrId)
  next() / prev()
  get current()                // active weapon instance
  get weapons()                // [{ id, name, ammo, reserve, icon }] for the HUD
  dispose()
}
```

Every weapon implements the same interface so `Loadout` can hold them uniformly:
`update(dt, elapsed)`, `tryFire(elapsed) -> boolean`, `releaseFire()`, `reload()`,
`onSelect()`, `onDeselect()`, `dispose()`, and getters `id name ammo reserve magazine
isReloading spread chargeLevel`.

- **Machine gun** — existing `Weapon.js`. Refactor it to satisfy the interface above.
  Keep the current viewmodel quality; it took several rounds to get right.
- **Fireball** (`id:'fireball'`) — hold LMB to charge (emits `weapon:charging`), release
  to launch. Procedural staff/gauntlet viewmodel with a glowing core that grows while
  charging. Projectile is a bright emissive sphere with a particle trail, point light,
  and heat distortion if cheap. On impact: radial explosion, AoE damage falling off with
  distance, scorch decal, embers. Ammo is a regenerating mana pool, not magazines.
- **Bow** (`id:'bow'`) — hold LMB to draw (string and arms flex, camera FOV tightens
  slightly, `weapon:charging`), release to loose. Arrow is a real projectile with gravity
  and an arc, rotating to face its velocity. Damage scales with draw. Arrows stick into
  whatever they hit and fade out on a pool. Quiver ammo with a reserve.
- **ProjectileSystem** — pooled, zero per-shot allocation, fixed-step integration with
  swept collision (`physics.raycast` along each step so fast projectiles never tunnel),
  and NPC hits via `npcManager.raycastNPCs`. Emits `projectile:hit` and applies damage
  through the same path `Combat` uses so kills raise `npc:killed` exactly once.

```js
export class ProjectileSystem {
  constructor({ scene, engine, physics, bus, materials, player, npcManager, combat })
  spawn({ kind, origin, direction, speed, damage, gravity, radius, aoe, owner })
  fixedUpdate(dt, elapsed)
  update(dt, elapsed)
  clear()
}
```

- **Combat.js**: keep hitscan for the machine gun. Add a public
  `combat.applyNPCDamage(npc, amount, { isHeadshot, sourcePosition, weaponId })` that both
  hitscan and projectiles route through, so `npc:damaged` / `npc:killed` stay single-sourced.
  **`npc:killed` must carry `{ npc, byPlayer, weaponId }`** — Economy keys credits off it.

### 3.3 MOUNTS — owns `src/mounts/MountManager.js`, `src/mounts/Hoverboard.js`, `src/mounts/Dragon.js`

```js
export class MountManager {
  constructor({ scene, engine, physics, bus, materials, input, player, camera, cameraRig })
  update(dt, elapsed)
  fixedUpdate(dt, elapsed)
  summon(id)                   // 'hoverboard' | 'dragon'
  dismount()
  get active()                 // mount instance or null
  get mounted()                // boolean
  dispose()
}
```

- While mounted, the mount **owns movement**: `MountManager.fixedUpdate` runs before
  `player.fixedUpdate` and sets a flag the player respects. Coordinate with the CAMERA
  agent via `player.movementOverride = true|false` — CAMERA must honour it (documented
  here so both sides agree). Mounted movement still resolves against `physics` so you
  cannot ride through walls.
- Mounting **forces third-person** (`cameraRig.setMode('third')`) and restores the prior
  mode on dismount. The player avatar must be posed on the mount — standing on the
  hoverboard, seated astride the dragon.
- **Hoverboard** — hovers ~0.4 m above the ground following terrain normals, fast
  (~14 m/s, ~24 boosting), leans into turns, pitches on slopes, trails thruster particles
  and a ground glow. `Shift` boosts with a visible thruster flare, FOV kick and speed
  lines. Smooth acceleration and a satisfying carve; it must feel good, not twitchy.
- **Dragon** — large procedurally modelled creature: articulated neck, wings with membrane,
  tail, legs. Wings flap on a cycle that slows into a glide, neck and tail sway, and it
  banks into turns. Free 3D flight: `Space` climbs, `Ctrl` descends, mouse steers, `Shift`
  boosts. Must be able to fly high over the whole map and land smoothly. Keep the player
  seated correctly on its back throughout.
- Both mounts are summoned procedurally with a spawn effect and dismissed cleanly.

### 3.4 PROGRESSION — owns `src/systems/Economy.js`, `src/systems/SaveGame.js`, `src/systems/Unstuck.js`

```js
export class Economy {
  constructor({ bus })
  get credits()
  add(amount, reason)          // emits credits:changed
  spend(amount, reason) -> boolean
  serialize() / deserialize(data)
}
```
Listens for `npc:killed` and awards **5 credits** when `byPlayer` is true. Ignores
non-player kills. Guard against double-award for the same NPC id.

```js
export class SaveGame {
  constructor({ bus, player, worldManager, economy, loadout, mounts })
  save() -> boolean
  load() -> Promise<boolean>   // may need to build/activate a world first
  hasSave() -> boolean
  clear()
  enableAutosave(seconds)      // default 30s; also save on world change and on unload
}
```
Persist to `localStorage` under a versioned key (`aether-nexus:save:v1`) with a schema
version so a future change can migrate rather than crash. Store: world id, player
position + yaw, health, credits, selected weapon, per-weapon ammo/reserve, unlocked and
active mount. `load()` must switch to the saved world (`worldManager.build` then
`activate`) before teleporting the player, and must fail safe — a corrupt or foreign save
must log and reset, never throw into the frame loop.

```js
export class UnstuckSystem {
  constructor({ bus, player, physics, worldManager, input })
  fixedUpdate(dt, elapsed)
  unstuck(reason)              // emits player:unstuck
  get isStuck()
}
```
- Manual: `K` always works.
- Automatic detection: player is grounded-or-not but has moved < ~0.15 m while holding a
  movement input for ~1.5 s, **or** the capsule reports penetration every frame, **or**
  the player is below the world bounds / falling for more than ~6 s.
- Resolution ladder, cheapest first: (1) nudge straight up to clear a floor penetration;
  (2) search outward on a widening ring for a clear standing spot using
  `physics.groundHeightOrFallback` plus a capsule clearance test; (3) fall back to
  `world.playerSpawn`. Never leave the player inside geometry, and preserve yaw.
- Show a HUD confirmation via `hud:notify`.

### 3.5 HUD — owns `src/ui/HUD.js`, `src/ui/hud.css`, `src/ui/WeaponWheel.js`

- **Weapon selector**: bottom-centre or bottom-right slot strip showing all three weapons
  with procedurally drawn icons, ammo, the active slot highlighted, and a switch
  animation. Respond to `weapon:switched`.
- **Charge meter** for fireball/bow (`weapon:charging`), drawn around the crosshair.
- **Credits**: persistent counter (top-left under the world name) with a `+5` floating
  increment animation on `credits:changed`.
- **Mount indicator**: shows active mount, boost meter, and `[F] Dismount`.
- **Save/load feedback**: toast on `save:written` / `save:loaded`, error toast on
  `save:error`. Show a subtle autosave pip.
- **Unstuck**: on `player:unstuck` show a confirmation; if `UnstuckSystem` reports stuck,
  surface a `[K] Unstuck` prompt.
- **Minimap zoom moves to `[` and `]`** — the wheel now belongs to weapon switching. Do
  not consume the wheel.
- Keep the existing HUD quality and visual language. Everything new must match it.

---

## 4. `main.js` wiring (orchestrator-owned — code against this)

```js
const economy     = new Economy({ bus });
const projectiles = new ProjectileSystem({ ...ctx, player, npcManager, combat });
const loadout     = new Loadout({ ...ctx, camera, player, npcManager, projectiles });
const cameraRig   = new CameraRig({ engine, camera, player, input, bus, physics });
const avatar      = new PlayerAvatar({ ...ctx, player });
const mounts      = new MountManager({ ...ctx, player, camera, cameraRig });
const unstuck     = new UnstuckSystem({ bus, player, physics, worldManager, input });
const save        = new SaveGame({ bus, player, worldManager, economy, loadout, mounts });
```
Fixed update order: `mounts → player → npcManager → combat → projectiles → unstuck → portals`.
Frame update order: `materials → player → cameraRig → avatar → mounts → npcManager →
projectiles → loadout → portals → combat → world → hud`.

`window.GAME` gains: `economy, loadout, projectiles, cameraRig, avatar, mounts, unstuck, save`.

---

## 5. Definition of done

1. `npx vite build` clean and `node scripts/contract-check.mjs` passes.
2. Zero new console errors at runtime, in all three worlds.
3. You tested your feature **in the browser** and looked at it. Screenshots for anything
   visual, read back as images.
4. No regression below ~90 fps at 1080p on a quiet machine.
5. Existing features still work: portals, AI chat, hitscan combat, minimap, health.
