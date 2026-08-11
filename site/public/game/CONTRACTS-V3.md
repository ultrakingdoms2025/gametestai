# AETHER NEXUS — Feature Contracts v3

Additive to `CONTRACTS.md` and `CONTRACTS-V2.md`. All §0 hard constraints still apply:
Three.js 0.185.1, **zero external assets**, everything procedural, pooled hot paths,
JSDoc on public methods, house comment style (explain *why*).

**Read `CONTRACTS.md` §0–§3 and `CONTRACTS-V2.md` §1–§2 first.**

---

## 0. Scope

| # | Feature | Owner |
|---|---|---|
| 1 | Swim in water (lakes, ponds, moat, pool) | MOVEMENT |
| 2 | Climb objects too high to jump | MOVEMENT |
| 3 | Stamina (drives sprint/swim/climb) | MOVEMENT |
| 4 | Inventory + 30-slot active bag, pick up / drop | INVENTORY |
| 5 | NPC loot drops (credits, bullets, arrows, fireball charges) | INVENTORY |
| 6 | Marketplace: buy/sell packs with credits | INVENTORY |
| 7 | Sword (melee weapon) | WEAPONS |
| 8 | Per-weapon damage values | WEAPONS |
| 9 | Weapon ammo consumed from inventory | WEAPONS |
| 10 | NPC chat decoupled from combat; idle motion; grounding; seated heads | NPC |
| 11 | NPCs randomise weapon + damage against the player | NPC |
| 12 | Car mount | MOUNTS |
| 13 | Help menu | UX |
| 14 | Health + stamina under credits; loading/portal progress UX | UX |

---

## 1. Keybinds (authoritative — additions only)

| Key | Action | Owner |
|---|---|---|
| `I` | toggle inventory / active bag | INVENTORY |
| `B` | toggle marketplace (only near a vendor NPC or terminal) | INVENTORY |
| `F1` | help menu | UX |
| `J` | summon/dismiss car | MOUNTS |
| `4` | select sword | WEAPONS |
| `Space` (in water) | swim up | MOVEMENT |
| `Space` (facing ledge) | climb/mantle | MOVEMENT |
| `E` | pick up loot / talk / enter portal | INVENTORY + NPC |

Existing and unchanged: `WASD` move, `Shift` sprint, `Ctrl/C` crouch, `V` camera,
`1/2/3` weapons, wheel cycle, `R` reload, `T` chat, `K` unstuck, `F5`/`F9` save/load,
`H` hoverboard, `G` dragon, `F` dismount, `[`/`]` minimap zoom, `F3` debug.

Read keys with `input.pressed('KeyI')` — **never edit `src/core/Input.js`**.

---

## 2. New events

| Event | Payload | Emitted by |
|---|---|---|
| `player:swim` | `{swimming, depth}` | MOVEMENT |
| `player:climb` | `{climbing}` | MOVEMENT |
| `stamina:changed` | `{stamina, max}` | MOVEMENT |
| `inventory:changed` | `{items, bag, bagUsed, bagCapacity}` | INVENTORY |
| `inventory:full` | `{itemId}` | INVENTORY |
| `loot:dropped` | `{position, contents}` | INVENTORY |
| `loot:collected` | `{itemId, qty}` | INVENTORY |
| `market:open` / `market:close` | `{}` | INVENTORY |
| `market:trade` | `{itemId, qty, credits, kind:'buy'\|'sell'}` | INVENTORY |
| `weapon:noammo` | `{id, itemId}` | WEAPONS |
| `npc:attack` | `{npc, weaponId, damage}` | NPC |
| `help:open` / `help:close` | `{}` | UX |

---

## 3. Module ownership and required API

### 3.1 MOVEMENT — owns `src/player/Player.js`, `src/player/Swim.js`, `src/player/Climb.js`, `src/systems/Stamina.js`, `src/systems/WaterVolumes.js`

```js
export class WaterVolumes {
  constructor({ bus })
  rebuildFromWorld(world)        // scan world.group for water surfaces
  contains(pointVec3) -> boolean
  surfaceYAt(x, z) -> number|null
  get volumes()                  // [{ box: THREE.Box3, surfaceY }]
}
```
**There is no authored water data.** Do not edit world files. Build volumes by scanning
`world.group` for meshes whose material name matches `/water|pool/i` (medieval has
`medieval.water`, sports has an animated pool surface), take each mesh's world-space
bounding box, and extend it **downward** to form a swimmable volume (the mesh is only the
surface plane). Rebuild on `world:changed`.

**Swim:** on entering a volume — buoyancy toward the surface, damped movement (~2.2 m/s),
no gravity, `Space` ascends and `Ctrl` descends, a surface-bob when at the waterline, and
a distinct swim animation on the avatar. Drains stamina slowly; at zero stamina the player
sinks and takes drowning damage. Exiting shallow water must restore normal walking cleanly
— no oscillation at the edge. Add an underwater post tint via `world.environment` only if
you can do it without touching PostFX.js (you do not own it); otherwise skip and say so.

**Climb:** when a forward probe finds a surface whose top edge is between jump apex and
~2.4 m, and there is clear standing room on top, `Space` mantles the player up with a
smooth animated hoist (not a teleport). Drains stamina. Must not trigger on ordinary
stairs or slopes the step-up already handles. Works in both camera modes.

**Stamina:** `CONFIG.player.maxStamina` (add it), drained by sprint/swim/climb, regenerates
after a short delay. Emits `stamina:changed`. Sprint must be gated on it.

Preserve every existing `Player` getter and `player.movementOverride` (mounts depend on it).

### 3.2 INVENTORY — owns `src/systems/Inventory.js`, `src/systems/ItemDefs.js`, `src/systems/Loot.js`, `src/systems/Marketplace.js`, `src/ui/InventoryUI.js`, `src/ui/MarketplaceUI.js`, `src/ui/inventory.css`

```js
export class Inventory {
  constructor({ bus, economy })
  add(itemId, qty) -> number            // returns qty actually added
  remove(itemId, qty) -> number
  count(itemId) -> number               // store only
  moveToBag(itemId, qty) -> number
  moveToStore(itemId, qty) -> number
  bagCount(itemId) -> number
  consumeFromBag(itemId, qty) -> boolean  // atomic; false if insufficient
  get items() / get bag()
  get bagUsed() / get bagCapacity()     // capacity 30
  serialize() / deserialize(data)
}
```
`ItemDefs.js` exports `ITEMS` keyed by id with `{ id, name, stack, icon, value, kind }`.
Required ids: `bullet`, `arrow`, `fireball_charge`, `credits` (virtual — routes to Economy),
plus at least a medkit and a couple of sellable trinkets.

**Bag capacity is 30 *slots*, not 30 items** — a stack of 60 bullets is one slot. State
that clearly in the UI so it is not confusing.

**Loot:** listen to `npc:killed` with `byPlayer`. Roll a random drop table (credits plus
ammo appropriate to the world), spawn a visible, pooled pickup in the world with a glow
and gentle bob, collected by walking over it or pressing `E` in range. Credits route to
`economy.add`. If the bag is full, route to the store; if both are full, leave the pickup.

**Marketplace:** `B` opens it near a vendor. Sells packs (e.g. 60 bullets, 30 arrows,
10 fireball charges) and buys player items back at a lower rate. Prices in `ItemDefs`.
Must validate affordability and inventory space, and never allow negative credits.

UI: match the existing HUD language exactly (dark glass, clipped corners, cyan/amber
rules, Chakra Petch / Rajdhani). Put your CSS in `src/ui/inventory.css` — **do not edit
`hud.css`**, another agent owns it. Import it from your own module.

### 3.3 WEAPONS — owns `src/weapons/Sword.js`, `src/player/Loadout.js`, `src/systems/Combat.js`, `src/systems/WeaponStats.js`

```js
export const WEAPON_STATS = {
  machinegun: { damage: 18, headshotMul: 2.5, ammoItem: 'bullet',          ... },
  fireball:   { damage: 55, aoeRadius: 4.5, ammoItem: 'fireball_charge',   ... },
  bow:        { damage: 42, headshotMul: 2.0, ammoItem: 'arrow',           ... },
  sword:      { damage: 65, ammoItem: null, range: 2.6, arc: 100,          ... },
};
```
Every weapon's damage now comes from here, not from scattered constants. Combat reads it.

**Sword** (`id:'sword'`, slot `4`): procedurally modelled blade, fuller, crossguard, grip
wrap and pommel, with a real swing animation (wind-up, arc, follow-through, recovery),
a trail ribbon along the edge, and impact sparks. Melee hit detection is an arc sweep in
front of the player — test NPC capsules within `range` and `arc` degrees, hit each target
once per swing. No ammo. Highest single-hit damage, shortest reach.

**Ammo from inventory:** each ranged weapon draws from `inventory.consumeFromBag(ammoItem, n)`
rather than a private counter. `weapon.ammo` reports the bag count. Firing with none emits
`weapon:noammo` and plays a dry click. Reload pulls from the bag. Coordinate through the
Inventory API only — do not reach into its internals.

### 3.4 NPC — owns everything in `src/npc/`

Four defects to fix, all reported by the user and confirmed by measurement:

1. **3 station NPCs are 10–25 m underground** (measured: −10.05, −24.6, −24.6). The
   grounding pass added in an earlier round is not catching them. Find out why — likely
   spawns authored inside or under geometry where the ring probe fails — and guarantee
   every NPC is on a walkable surface in all three worlds.
2. **14 of 24 NPCs per world are fixed-posture and never move.** They read as props. Give
   idle NPCs life: small weight shifts, occasional short walks to a nearby point and back,
   turning to look around, gestures. Seated NPCs should still move their upper body.
3. **Some seated NPCs are missing heads.** Reported by the user. Investigate the seated
   posture path and the LOD/detail-visibility path (`setDetailVisible`) — a hidden head
   mesh is the likely cause. Verify by screenshotting seated NPCs close up.
4. **AI chat is tied to NPCs that also attack.** Decouple them: every *friendly* NPC —
   including stationary and seated ones — must be conversational via `E` and
   `chat:available`. Hostiles must not be chat targets. Give stationary NPCs a purpose:
   vendors (emit something the Marketplace can key on), guards, loiterers, spectators.

**Randomised NPC combat (#11):** hostiles pick a weapon per encounter from a table
(sidearm / rifle / bow / staff), each with its own damage, rate of fire, range and
telegraph. Damage dealt to the player must vary by weapon and include a small random
spread. Emit `npc:attack {npc, weaponId, damage}` so the HUD can show what hit you. Route
player damage through `player.applyDamage` as now. Keep them readable and fair.

### 3.5 MOUNTS — owns `src/mounts/Car.js` and `src/mounts/MountManager.js`

Add a **car** (`id:'car'`, key `J`). Procedurally modelled: body shell, glasshouse, four
wheels that steer and spin, suspension travel per wheel from ground probes, brake lights,
headlights at night. Fast on flat ground (~22 m/s, ~34 boosting), with weight transfer,
body roll, and tyre-mark/dust effects. Must collide properly (no driving through walls)
and handle slopes. The player sits **inside** it — reuse the seated rider approach already
built for the dragon harness, posed at a driving position with hands on a wheel.

Register it alongside hoverboard and dragon, include it in `prebuild()` (main.js warms
mounts at boot — see §4), and make sure dismount restores camera state as the others do.

### 3.6 UX — owns `src/ui/HUD.js`, `src/ui/hud.css`, `src/ui/HelpMenu.js`

1. **Move health under credits.** Credits sit top-left; health goes directly beneath it,
   with a **stamina bar** beneath that (driven by `stamina:changed`). Both always visible.
   Remove the old bottom-left health block. Keep the damage flash and low-health pulse.
2. **Help menu (`F1`)**: a proper panel listing every control grouped by category
   (movement, combat, camera, mounts, inventory, system), plus brief notes on portals,
   credits, the marketplace and swimming/climbing. Pauses nothing; `Esc` or `F1` closes.
   Also add a small persistent "F1 Help" affordance.
3. **Loading and portal progress (important — the user reports Chrome showing "page
   unresponsive")**: replace the boot bar and the portal transition with a proper busy
   state — an animated spinner, a percentage, the current stage name, and a reassuring
   "this can take a moment" line after ~3 s. It must keep animating while the main thread
   is busy, so it should be **CSS-animated** (transform/opacity), never JS-driven per
   frame. Style the classes `main.js` already emits plus any you add; the orchestrator is
   changing `main.js` to report finer-grained stages and to yield more often.
4. HUD additions for the new systems: ammo now reads from inventory, a `weapon:noammo`
   indicator, an `npc:attack` damage readout, and a loot pickup toast.

---

## 4. `main.js` wiring (orchestrator-owned — code against this)

```js
const waterVolumes = new WaterVolumes({ bus });
const stamina      = new Stamina({ bus, player });
const inventory    = new Inventory({ bus, economy });
const loot         = new Loot({ ...ctx, player, inventory, economy, npcManager });
const market       = new Marketplace({ bus, economy, inventory, player, npcManager });
```
Fixed update: `mounts → player → npcManager → combat → projectiles → loot → unstuck → portals`.
Frame update adds `waterVolumes` (on world change only), `inventory/market/help` UI ticks.
`window.GAME` gains: `inventory, loot, market, waterVolumes, stamina`.

Mount prebuild will include `'car'`. Save/load will persist inventory and bag — expose
`serialize()`/`deserialize()` and the orchestrator will wire it into `SaveGame`.

---

## 5. Definition of done

1. `npx vite build` clean; `node scripts/contract-check.mjs` passes.
2. Zero new console errors in all three worlds.
3. **You tested it in the browser and looked at it.** Screenshots for anything visual,
   read back as images.
4. No first-use freeze. Boot-time warmup exists precisely because Three recompiles every
   material when the light count changes — if your feature adds or removes lights at
   runtime, say so in your report so it can be added to the warmup.
5. No regression below ~90 fps at 1080p on a quiet machine.
6. Existing features still work: portals, AI chat, all mounts, save/load, unstuck.
