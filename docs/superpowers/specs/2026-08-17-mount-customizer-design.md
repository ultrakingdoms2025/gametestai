# Mount Customizer (F10) — Design

**Date:** 2026-08-17
**Status:** Approved in brainstorming; awaiting spec review
**Scope:** One feature: a per-mount customisation menu (skins + upgrades) for the six mounts, the data model behind it, and the marketplace/inventory flow that feeds it.

## 1. Problem

Only the car can be customised today, and only from F2 (paint + wheel colour, plus five limited-edition liveries held as permanent unlocks in `Cosmetics`). Marketplace "Mount Power / Strength / Shield" tiers exist but all nine catalog rows target the car, no UI shows what a player owns, and the Shield tier is written by `Car`/`Dragon.applyPowers` yet **read by nothing** — it does nothing in play. Dragon, eagle, horse, hoverboard and bicycle have no customisation surface at all.

The player wants: a dedicated mount customiser (like F2 for the character) that is appropriate to each mount — car body/wheel skins and speed/hit protection, dragon fire power and saddle skin, similar for eagle and horse, skins for hoverboard and bike. Default options are plain matt and gloss finishes; a skin bought at the marketplace sits in the inventory bag, appears as an option, and is removed from the bag when used.

## 2. Decisions (from brainstorming)

| Decision | Choice |
|---|---|
| Skin ownership | **Consumable, then burned in.** A bought skin is a bag item; applying it consumes it and permanently unlocks that skin for that mount (existing `Cosmetics` ledger). The five existing car liveries convert to this model; already-unlocked ids remain valid. |
| Stats | **Show owned tiers + sell tiers for every mount.** Grants stay permanent and auto-applied (existing `grant_mount_power`); the menu is read-only for stats and links to the market. |
| Dragon fire | Fire I–III boosts the rider's **fireball** damage while riding the dragon (+15 %/tier) and nudges the breath VFX. No new attack. |
| Key | **F10.** Reserved (un-rebindable). |
| F2 | Car livery section **moves out of F2** into F10. F2 becomes character-only. |
| Preview / selection | **Only while mounted.** F10 edits the mount you are riding, previewed live in third person. On foot: HUD notify "Mount up first (M) to customise it". Dismounting closes the menu. |
| Approach | Generalise the existing car livery/powers pattern across all mounts (Approach A). Mount knowledge stays in each mount file; the menu is generic. |
| Discoverability | Update F1 help, F6 keybind list, HUD boot/pause key hints, `Input.js` reserved keys, MarketplaceUI hints. |

## 3. Customisation surface

### 3.1 Slots

Each mount class declares `static CUSTOM_SLOTS: Array<{ id, label, finish: boolean, defaultColor: number, palette: 'paint'|'wheel'|'natural'|'glow' }>`. A slot is a colour target; `finish: true` means it also takes a Matt/Gloss finish. Plain defaults are the free swatch palette (as the car has today: ~14 paint colours + hex picker; ~12 wheel/rim colours; a 'natural' set of hide/feather browns and greys; a 'glow' set of saturated emissives) × finish. Purchased skins are presets over the same slots.

| Mount | Slot A | Slot B | Build change |
|---|---|---|---|
| Car | `paint` Body paint (colour + finish) | `wheel` Wheels (colour + finish) | none — already clones `carpaint`/`alloy` |
| Dragon | `hide` Hide (colour + finish; wing membrane tinted 30 % toward it) | `saddle` Saddle & tack (colour + finish) | clone `dragon.hide`, `dragon.membrane`, `dragon.leather`, `dragon.tack` at build |
| Eagle | `plumage` Plumage (body + flight feathers; colour only, matt) | `harness` Harness (colour + finish) | promote local `_mat` clones to fields |
| Horse | `coat` Coat (colour only, matt) | `saddle` Saddle & tack (colour + finish) | promote local clones to fields; mane/tail unchanged |
| Hoverboard | `deck` Deck (colour + finish) | `glow` Underglow (emissive colour, no finish) | clone `mount.grip`/`mount.carbon`; glow mats already owned |
| Bicycle | `frame` Frame (colour + finish) | `rims` Rims (colour + finish) | promote local clones to fields |

**Finish** touches only `roughness`, `metalness`, `envMapIntensity` (Matt: 0.85 / 0.05 / 0.6; Gloss: 0.22 / 0.35 / 1.0). No clearcoat, no define changes — **no shader recompiles** (see the station-perf memory: compile does not block, but a program relink during play does). Materials are cloned once at build; menu edits set uniforms only. Colours are quantised as F2 does (`v & 0xfcfcfc`) because material caches never evict.

### 3.2 Stat ladders

All permanent marketplace grants, tiers I–III, auto-applied through `MountManager._applyPowers` exactly as today.

| Stat id | Label | Effect / tier | Mounts |
|---|---|---|---|
| `power` | Speed | +12 % top speed | all six |
| `strength` | Acceleration | +10 % accel (Eagle: also −8 % beat stamina) | all six |
| `shield` | Armour | −10 % damage taken by the rider while mounted | all six |
| `fire` | Fire | +15 % fireball damage while riding | dragon only |

Each mount declares `static STATS = ['power','strength','shield'(,'fire')]`; the menu renders exactly that list.

## 4. Data model & persistence

### 4.1 `MountManager` (src/mounts/MountManager.js)

- `_livery: {paint,wheel}` (car-only) → `_liveries: { [mountId]: { [slotId]: { color:number, finish?:'matt'|'gloss' } } }`.
- `setLivery(mountId, patch)` merges a slot patch, calls `this._mounts.get(mountId)?.applyCustomization(liveries[mountId])`, emits `mount:livery { mountId, livery }`.
- `getLivery(mountId)` → deep copy. `resetLivery(mountId)` → clears and re-applies mount defaults.
- `_create(id)` (currently `if (id === 'car') …applyCustomization`) → `mount.applyCustomization?.(this._liveries[id])` for any mount, then `_applyPowers` as now.
- `serialize()` writes `liveries` (drops `livery`). `deserialize()` accepts both: legacy `livery:{paint,wheel}` numbers migrate to `liveries.car = { paint:{color}, wheel:{color} }` so existing saves keep their car colours. Returns `true` when it consumed anything (fixes the falsy-return fall-through in `SaveGame._restoreMounts`).
- New `applySkin(skinId) → {ok, reason?, consumed?}` — the single "wear a skin" entry point (§5.3). `MountManager` receives `cosmetics` and `inventory` references for this (constructor options; both already exist in `main.js`).
- Persistence hooks in `main.js` (`bus.on('mount:livery')` → local + remote persist) need no change beyond reading the new event payload.

### 4.2 Mount classes (src/mounts/*.js)

Each mount gains:
- `static CUSTOM_SLOTS`, `static STATS`, `static DISPLAY_NAME`.
- `applyCustomization(livery)` — safe pre/post-build (store, apply if built), sets `.color` per slot and finish uniforms where `finish` applies. Car keeps its current method but reads the new nested shape.
- `applyPowers({strength, shield, power, fire})` — Car/Dragon already have it; Horse, Eagle, Hoverboard, Bicycle get the same shape (`_powerMul`, `_accelMul`, `_shieldTier`; Dragon adds `_fireTier`). Getters `shieldTier`, `fireTier` (dragon).
- The one or two sites where each mount reads its speed cap / accel constant multiply by `_powerMul` / `_accelMul`, following the clamping notes already documented in `Dragon.js:2432-2469`.

### 4.3 `Cosmetics` (src/systems/Cosmetics.js)

- `VEHICLE_SKINS` → `MOUNT_SKINS: Array<{ id, mount, name, blurb, livery: { [slotId]: {color, finish?} } }>`. The five car ids (`car_neon`, `car_inferno`, `car_phantom`, `car_toxic`, `car_azure`) are kept verbatim; 15 new skins (3 per other mount) are added. `MOUNT_SKINS_BY_ID`, `skinsForMount(mountId)`.
- Ledger semantics unchanged (`has/unlock/list/serialize/deserialize`, event `cosmetic:unlocked`); it now means "burned in".
- `CHARACTER_SKINS` and `unlock_cosmetic` are untouched.

### 4.4 `ItemDefs` (src/systems/ItemDefs.js)

- New `ItemKind` `'skin'` with a `KIND_ACCENT`.
- One entry per mount skin: `{ id: 'skin_<skinId>', name, short, stack: 1, kind: 'skin', value, desc }` and a procedural icon (two-colour swatch chip drawn from the skin's slot colours) in `itemIconSVG`.
- Helpers `skinItemId(skinId)` / `skinIdFromItem(itemId)`.

### 4.5 Marketplace catalog (site/lib/marketplaceCatalog.ts)

- Skin rows: the five car liveries switch from `unlock_cosmetic` to `grant_item { item_id: 'skin_car_neon' … }`; 15 new skin rows (`category: 'cosmetic'`).
- Stat rows: 48 new `grant_mount_power` rows — `mount ∈ {dragon, eagle, horse, hoverboard, bicycle}` × `power ∈ {power, strength, shield}` × tier 1–3, plus dragon `fire` 1–3. `MARKETPLACE_ACTIONS` union extended accordingly; images through the existing generator; per-world pricing as the existing car rows.
- Rows re-seed on the deployed site's cold start as today (INVENTORY-AUDIT.md: catalog is the source of truth, never hand SQL).

## 5. Flows

### 5.1 Buying a skin

`Marketplace.preview/buy` already route `grant_item` into the bag. One extra guard in `preview`: if the item is a skin (`ItemDefs.kind === 'skin'`) and `cosmetics.has(skinIdFromItem(id))` → `{ ok:false, reason:'owned' }` (no pointless repurchase; mirrors the existing cosmetic branch). MarketplaceUI's `owned` message becomes "Already unlocked — apply it from the Mount menu (F10) while riding".

### 5.2 Buying an upgrade

Unchanged: `mount:power:buy` → `MountManager.grantPower(mount, power, tier)`. Works for any mount id already; the menu just displays it.

### 5.3 Applying a skin — `MountManager.applySkin(skinId)`

1. Resolve skin; unknown id → `{ok:false, reason:'unknown-skin'}`. If its `mount` ≠ the active mount id → `{ok:false, reason:'wrong-mount'}`.
2. If `cosmetics.has(skinId)` → `setLivery(mount, skin.livery)` → `{ok:true, consumed:false}`.
3. Else if `inventory.bagCount(skinItemId) > 0` → `inventory.consumeFromBag(itemId, 1)`; if that returns false → `{ok:false, reason:'not-owned'}`; else `cosmetics.unlock(skinId)`, `setLivery(...)` → `{ok:true, consumed:true}`. (`cosmetic:unlocked` and `mount:livery` both fire, so both persist paths run.)
4. Else → `{ok:false, reason:'not-owned'}`.

Callers: the F10 skin card, and `ItemUse.use()` for `kind === 'skin'` items (InventoryUI **Use**): `ItemUse` checks `itemDef(id).kind === 'skin'` before its literal-id switch and delegates to `mounts.applySkin`; on `wrong-mount`/not mounted it emits a HUD notify "Mount your <name> and press F10 to apply this skin" and the item is **not** consumed.

### 5.4 Opening the menu

F10 (capture-phase `keydown`, like F2): if `!mounts.mounted` → HUD notify, no open. Else `input.setTextCapture(true)`, `input.exitLock()`, force third-person camera (restore on close), body class `mm-open`, emit `mount:menu:open`. Close on F10/Escape/dismount (`mount:dismount` or equivalent existing event): reverse, re-request pointer lock after 140 ms, emit `mount:menu:close`. `main.js` adds these two events to the same gameplay-block gating as `character:open/close`.

## 6. UI — `src/ui/MountMenu.js` + `src/ui/mount-menu.css` (`.mm-` prefix)

Structural clone of `CharacterMenu` (right-side drawer, `_section`, `_swatches`, `_syncers`, rAF-coalesced hex-picker writes). Constructed in `main.js` with `{ root, bus, input, mounts, cosmetics, inventory, player }`. Built **generically** from the active mount's `CUSTOM_SLOTS`, `STATS`, and `skinsForMount(id)` — no per-mount branches. The panel body is rebuilt on open (the active mount can differ each time); events only resync.

Panel, top to bottom:
1. **Header** — `DISPLAY_NAME` + "F10 close" chip.
2. **One section per slot** — swatch row (palette by slot `palette`), hex picker, Matt/Gloss chips (omitted when `finish:false`). Section summary (right-aligned) shows the current hex + finish.
3. **Skins** — one card per skin. States: **Equipped** (livery equals skin), **Owned** (click → apply), **In bag — Apply** (click → `applySkin`, consumes; card flips to Owned/Equipped), **🔒 Market** (click → HUD notify "Buy it at the market (B)"). Bag state from `inventory.bagCount`; re-synced on `inventory:changed`, `cosmetic:unlocked`, `mount:livery`.
4. **Upgrades** — one row per stat in `STATS`: label, three tier pips lit to the owned tier (`mounts.getPowers(id)`), effect line ("+24 % top speed" computed from tier), locked pips read "Buy at market (B)". Read-only; re-synced on `mount:powers`.
5. **Footer** — "Reset to factory" → `mounts.resetLivery(id)`.

**F2 `CharacterMenu`** loses the Vehicle livery section, `_livery*` methods, `CAR_PAINT_COLORS`/`CAR_WHEEL_COLORS` (moved to MountMenu), the `mounts` constructor dep, and the vehicle branch of `_skinCards`. `main.js` construction updated.

**Discoverability updates**
- `HelpMenu.js` (F1) table: `F10 — Customise your mount`.
- `KeybindMenu.js` (F6) fixed-key list: `F10 — Customise mount`; explanatory string mentions it.
- `HUD.js` boot key hints and pause-overlay hints: add F10.
- `Input.js` reserved list: add `'F10'`.
- `MarketplaceUI.js` hint strings: F2 → F10 wording (skins) and, for upgrades, "see your tiers in the Mount menu (F10)".
- `ChatClient.js` NPC line about F2 gains a mount equivalent ("F10 while riding").

## 7. Runtime effects

- **Armour**: `Player.applyDamage(amount, …)` multiplies `amount` by `1 − 0.10 × (mounts.active?.shieldTier ?? 0)` when `mounts.mounted`, for every damage source. Player gets a `mounts` reference (set from `main.js` after both exist, e.g. `player.mounts = mounts`) if it does not already hold one.
- **Speed / Accel**: per-mount multipliers at the read sites (§4.2).
- **Dragon Fire**: `Combat` gains `mountFireMul` = `1 + 0.15 × (mounts.active?.fireTier ?? 0)` applied at the same place as `_playerDamageMul` (`Combat.js:425`) but only when the damage is from a **fireball** projectile and the active mount is the dragon (`mounts.active?.id === 'dragon'`). If the fireball hit path does not already carry a weapon id into Combat, the plan adds it from `Projectiles`. Dragon `_emitBreath` scales particle size/brightness by `1 + 0.1 × fireTier` (uniform only).

## 8. Error handling & edge cases

- Legacy save with flat `livery` → migrated; unknown slot ids in a saved livery are ignored; unknown skin ids in the ledger are ignored (existing `KNOWN_SKIN_IDS` guard extended).
- Skin item in bag whose skin id is unknown (catalog drift) → `applySkin` refuses with `reason:'unknown-skin'`, item untouched, HUD warn.
- `applySkin` while not mounted / wrong mount → refuse, nothing consumed.
- Bag consumption and ledger unlock happen in that order; if `consumeFromBag` returns false, no unlock and no livery change.
- Menu open + world change: `MountManager.clear()` on `world:changing` dismounts → menu closes via the dismount hook.
- Menu open + `mount:powers` / `inventory:changed` events → resync only (no rebuild).
- Colour picker spam → rAF-coalesced, one uniform write per frame; no material allocation at edit time.
- Marketplace `preview` for an owned skin → `reason:'owned'`, consistent with existing cosmetic behaviour.

## 9. Testing

Headless `node --test` in `scripts/tests/` (house style, see `flight-ceiling.test.mjs`):

- **`mount-liveries.test.mjs`** — legacy `{livery:{paint,wheel}}` migrates to `liveries.car.*.color`; `serialize/deserialize` round-trip; `applySkin`: owned → applies, bag untouched; in bag → consumes exactly 1, unlocks, applies; neither → refuses; wrong mount → refuses; every `MOUNT_SKINS` entry has a `skin_*` ItemDef and its livery keys ⊆ that mount's `CUSTOM_SLOTS`.
- **`mount-powers.test.mjs`** — every mount class has `applyPowers`, `CUSTOM_SLOTS`, `STATS`; speed multiplier reaches the mount's effective top speed (instantiate headless where the class permits, else assert on exported multipliers); `Player.applyDamage` reduces by shield tier when mounted and not otherwise; Combat fireball multiplier applies only for the dragon.
- **`mount-catalog.test.mjs`** — every `grant_mount_power` row's `(mount, power)` is declared by that mount's `STATS`; every skin `grant_item` row's `item_id` resolves in `ItemDefs` and to a `MOUNT_SKINS` id (guards catalog/ledger drift, the failure class INVENTORY-AUDIT.md documents). Reads `site/lib/marketplaceCatalog.ts` via a small TS-stripping import (or a JSON export of `BASE_ITEMS`) — whichever the plan finds simplest.
- **Browser smoke (Playwright, manual)** — mount each of the six → F10 → change colour + finish → dismount/resummon → change persists; F5 save / Shift+F9 load; buy a skin at B → card shows "In bag" → Apply consumes → "Owned"; on-foot F10 → notify; F1/F6/boot hints list F10; F2 no longer shows the car section.

## 10. Out of scope

- A new dragon breath attack; new mount geometry; per-mount summon preview from the menu; making stat upgrades consumable; changes to character skins or the character customiser beyond removing the car section.
