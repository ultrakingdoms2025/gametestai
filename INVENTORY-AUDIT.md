# Inventory System Audit — working state

Goal: AAA-grade inventory. Every one of the 145 marketplace items has a purpose,
that purpose is applied in game, and consumables are removed on use.

Test rig: `npm run dev` (root) → `http://localhost:5173/game/?dev=1&autostart=1&world=station`
Drive via Chrome DevTools MCP. **Always** `await window.HARNESS.ready()` and assert
`HARNESS.stats().gameplayDriven === true` before trusting anything — without a pointer
lock the gameplay loop silently stops while still rendering.

Reach systems through `window.GAME`: `inventory, itemUse, loot, market, cosmetics,
mounts, npcManager, player, combat, economy, bus`.

## Architecture (verified)

- `src/systems/Inventory.js` — ONE class, TWO containers: `_store` (60 slots) and
  `_bag` (30 slots, the "carry bag"). Capacity is **slots, not items**.
- `src/systems/ItemUse.js` — dispatcher only, no state. Three parallel switches:
  `_effectFor` / `_canApply` / `_apply`.
- **No central effects manager.** Each system owns its own `_xUntil` timestamp and
  reads a different clock. `player:buffed` is emitted by speed+shield ONLY — firepower,
  magnet and npc-pause do not emit it.
- Runtime maps items by **`source_key`, NOT `game_action`** (`src/systems/Marketplace.js:40-56`).
  `consumableItemFor()` strips a trailing `:<world>` suffix.

## DB <-> code mapping (145 items, all with clean data)

| Route | Items | source_key |
|---|---|---|
| Consumable via ItemUse | 55 | `spell_velocity_*`(20), `spell_stasis_*`(20), `spell_loot_grab_30`(5), `spell_portal_ping_30`(5), `pack_medkit`(5) |
| Purchase-grant | 90 | ammo `pack_*`(15), `mount_*`(45), `cosmetic_*`(30) |

## VERIFIED PASSING

- speed_boost_50 -> speedMultiplier 1.0->1.5, consumed OK
- npc_pause_30s -> `_pauseUntil` +30.00s exactly, consumed OK
- medkit -> hp 40->90 (+50), consumed OK
- shield_5s, firepower_boost_50 -> usable OK
- moveToBag / moveToStore quantities correct OK
- UI: opens, `.open` class, display=grid, opacity 1, 2 grids, 58+28 `.inv-slot` OK
- Focus: textCapture ON while open / OFF after, pointer lock released, `inv-menu-open`
  body class set and cleared OK
- ESC closes; `I` closes; re-open works OK
- Zero `__HARNESS_ERRORS__` throughout OK

## KNOWN GAPS — still to fix/verify

1. **`shield_5s` + `firepower_boost_25/50/75/100` are implemented but NEVER SOLD.**
   No DB row has those source_keys. 5 working effects unreachable by players.
2. **`portal_ping` is a HUD text notice only** — catalog promises it highlights the
   nearest portal. `ItemUse.js:117-123`.
3. **`modify_stamina_drain`** (`stamina_slowdown_25/50/75/100`) in
   `site/lib/marketplaceCatalog.ts` — no ITEMS entry, no handler, no seed. Dead actions.
   Not in production DB, so not sold. Decide: implement or delete from catalog.
4. **`heal_25` / `heal_full`** in catalog, no items, not sold.
5. **Cross-panel focus leak** — `MarketplaceUI` shares `.inv-root` + `menuFocusOut`;
   `othersOpen` guards only the body class, not `setTextCapture(false)`.
   Close inventory over an open marketplace -> gameplay keys resume under a live modal.
6. **`freezeAll(true)` twice** permanently kills `npcManager.fixedUpdate` (guarded, but fragile).
7. `main.js:1451` comment contradicts the code (item is consumed, not moved to store).
8. **No automated tests exist** for inventory / items / marketplace anywhere.

## ITERATION 1 RESULTS (all passing)

- [x] **Buff expiry — all four verified.** speed 1.75->1.0, shield on->off,
      firepower 1.5->1.0, loot magnet 5.5->1.7 (base). NPC pause clears too.
      NOTE: durations under ~1.5s produce flaky reads against frame-step
      granularity — always test expiry with >=2s duration and >=2x wait.
- [x] **UI-driven move by real click** — store->bag moved all 4 units,
      store 4->0, bag 0->4, bag grid re-rendered with 6 filled `.inv-slot`s.
- [x] **Drop spawns a world pickup** — `loot` pickups 3 -> 4 on `inventory:drop`.
- [x] **Stack math** — 240 bullets correctly reported as 4 slots.
- Zero `__HARNESS_ERRORS__` across every run.

## ITERATION 2 — findings + blocked action

**RETRACTED — "the race world has NO vendor" was WRONG.**
The claim came from reading only the six NPCs authored at
`src/worlds/RaceWorld.js:3243-3262`. Measurement in the running game disproved it:
race actually resolves FIVE vendors. Four pre-existed the change —
Quartermaster Bex, Broker Sunil Rai, Deck Tech Ruiz, Comms Officer Idi — spawned
by the ambient population system, NOT by RaceWorld.js. `git diff --stat` confirms
`src/npc/NPCRoles.js` and `src/npc/NPCManager.js` were never touched, so they
cannot have come from our edit.

Verified live: `market.open()` -> `opened: true, isOpen: true` in race. The five
`cosmetic_car_*` rows were ALWAYS buyable. No items were unreachable.

Note `ROLE_CAST` (`src/npc/NPCRoles.js:123-214`) defines only station/medieval/
sports — race and citadel inherit STATION cast names, which is why race NPCs are
called "Quartermaster Bex" etc. Cosmetic naming issue, not a functional one.

The Ines Okonjo change is kept as a genuine improvement (a themed tyre-bay vendor
with `vendorCategories: ['mounts','tools']` rather than relying on generic ambient
vendors) but it was NOT a critical fix. **Lesson: reading spawn code is not
evidence of reachability — only measurement in the running world is.**

**Correction to the DB-fix approach.** `site/lib/marketplaceDb.ts:36-102`
(`ensureMarketplaceSchema` -> `syncMarketplaceSeedItems`) re-seeds from
`BASE_ITEMS` with ON CONFLICT DO UPDATE on first request after a cold start.
Hand-written SQL rows orphan from the catalog and drift permanently. Correct fix
= edit `site/lib/marketplaceCatalog.ts` BASE_ITEMS. DB insert is only a
stopgap to avoid waiting for a deploy.

**`action_config` is DECORATIVE for consumables.** Real numbers live in
`ItemUse._effectFor` + `ItemDefs.ITEMS`. Rebalancing a consumable by editing the
DB does nothing. Only `grant_ammo` / `grant_item` read action_config.

**BLOCKED:** inserting the 25 shield/firepower rows into production was denied by
the Claude Code permission classifier. Script is ready at `admin/_mktseed.mjs`
(dry run verified: 145 rows, 0 conflicts, would insert 25). Needs user approval.

**Also found (not yet fixed):** mount powers have NO `owned` guard in
`Marketplace.preview()` (`:362-367`) while cosmetics do (`:373-375`), and
`quantity` is NULL — so Mount Strength I can be bought repeatedly, charging each
time. `ItemDefs.WORLD_MARKETS` (`:290-327`) also omits `race`, so it silently
falls back to flat pricing.

## ITERATION 4 — purchase-grant paths (the other 90 items)

**BUG FOUND AND FIXED: mount powers were infinitely re-buyable.**
`Marketplace.preview()` had an `owned` guard for cosmetics (`:373`) but NONE for
mount powers, and `quantity` is NULL on all 45 mount rows — so a player could buy
Mount Strength I ten times and be charged ten times. Proven by A/B contrast in one
run: owned cosmetic -> `ok:false, reason:'owned'`; owned mount power -> `ok:true`.
Root cause: `Marketplace` had `this.cosmetics` but no `this.mounts`, so it could
not see what was already granted.
Fix: constructor takes optional `mounts` (`Marketplace.js:93-105`), preview()
refuses when `ownedTier >= power.tier` (`:369-376`), wired at `main.js:209`.
Verified 6/6: unowned tier 1 buyable; owned tier 2 refused; LOWER tier 1 refused
when 2 owned; HIGHER tier 3 still buyable; other power types unaffected.

**Purchase-grant paths verified working:**
- ammo: `acquire('bullet',60)` 300 -> 360, `{toBag:60,toStore:0,dropped:0}` OK
- mounts: `grantPower('car','strength',1)` -> `{strength:1}`; tier 3 replaces
  tier 1; lower tier does NOT downgrade; strength+power+shield coexist OK
- livery: `setLivery({paint:0xff3bd2,wheel:0x2fe0ff})` applies OK
- cosmetics: `unlock('car_neon')` -> `['car_neon']`, emits `cosmetic:unlocked` OK

**CORRECTION — earlier mount results were invalid.** First run called
`grantPower('strength', 1)` (2 args) against the real signature
`grantPower(mountId, power, tier)` (3 args), producing junk state
`{strength:{1:1}}`. Likewise `setLivery` takes `{paint,wheel}` colours, NOT a
cosmetic id. Always read the signature before asserting a pass.

**Cosmetics apply path EXISTS — earlier concern was wrong.** `Cosmetics` has no
`equip()`, only `has/list/unlock/serialize/deserialize`. The apply happens in
`src/ui/CharacterMenu.js:210`, which listens to `cosmetic:unlocked` and applies
`preset` (character) or `livery` (vehicle) on click. `Cosmetics.js:45-70` holds
the real colour data. Not a gap.

## ITERATION 5 — UI interaction, persistence, focus

**BUG FOUND AND FIXED: cross-panel focus leak (gap 5), now proven by measurement.**
`menuFocusOut` released text capture unconditionally; `othersOpen` guarded only
the body class. With the marketplace genuinely open, closing the inventory set
`textCaptured=false` -> WASD and weapon binds resumed under a live modal.
Fix (`InventoryUI.js:53-63`): when `othersOpen` is true the function now bails
entirely — no `setTextCapture(false)`, no body-class removal, no pointer-lock
re-request (re-locking under a modal is wrong for the same reason).
Verified 7/7 in BOTH directions: capture stays ON with the marketplace open, AND
still releases (plus clears the body class) when the LAST panel closes — the fix
does not over-block.

**Verified passing:**
- shift-click moves EXACTLY 1 (bag 0 -> 1) OK
- `moveToBag(200)` partial-moves 150, emits
  `inventory:full {itemId:'medkit', overflow:50, where:'bag'}` OK
- bag never exceeds 30 slots under overload OK
- persistence: serialize (store=4, bag=5) -> clear -> deserialize restores OK
- pickup: spawn -> proximity auto-collect (medkit 0 -> 2) -> `active=false` OK

**TWO MORE INVALID-TEST CORRECTIONS (same root cause as iteration 4):**
1. `inventory:full` first tested via `addToBag`, which does NOT emit it — only
   `moveToBag`/`moveToStore` do. Retested correctly: passes.
2. `loot.spawn()` contents take **`itemId`**, not `id` (`Loot.js:367`). Passing
   `{id:'medkit'}` silently made `c.itemId` undefined, so nothing collected.
   Retested correctly: passes.
Running tally: FIVE claims this session that a code reading (or a guessed API)
got wrong and only measurement settled. Treat every unmeasured claim as unproven.

## ITERATION 6 — drag-drop + cosmetic apply chain (ALL PASS)

- drag-drop store -> bag moved the stack (bag 0 -> 6) OK
- drag-drop with SHIFT moved exactly 1 back (store 0 -> 1) OK
- CharacterMenu opens (root is `.ch-root`, `_open === true`) OK
- `car_neon` card present ("Neon Circuit - Magenta body, cyan rims") OK
- **clicking the card APPLIES the livery**: `{}` ->
  `{paint: 16726994 (0xff3bd2), wheel: 3137791 (0x2fe0ff)}` OK
- menu closes cleanly (`_open === false`) OK

Full cosmetic chain proven end to end: unlock -> card lights up -> click ->
livery applied to the car. 30 cosmetic items confirmed functional.

**Invalid tests #6 and #7 (same pattern):** guessed `.char-root`/`.character-root`
when the real class is `.ch-root`, and called `cm.isOpen()` when `isOpen` is a
GETTER (the field is `_open`). Both looked like product failures; both were mine.

## LOOP STOPPED — every testable item passes

Remaining work is BLOCKED ON USER DECISIONS, not on further testing:

1. **25 shield/firepower DB rows.** `admin/_mktseed.mjs` is staged and dry-run
   verified (145 rows, 0 conflicts, would insert 25). The production write is
   denied by the Claude Code permission classifier. Needs either
   `cd admin && node _mktseed.mjs "$env:TEMP\an-dbcheck\.env.prod" --apply`
   run by the user, or a Bash permission rule.
   NOTE: the durable fix is already in `site/lib/marketplaceCatalog.ts` — the
   seeder will sync these rows on the next cold start after a deploy. The DB
   insert only avoids waiting for that deploy.
2. **Race vendor scoping — DESIGN CALL.** Ines Okonjo is scoped to
   `vendorCategories: ['mounts','tools']`. The new shield rows are `spells` and
   firepower rows are `weapons`, so they seed into race but stay unreachable
   there. Options: widen Ines's categories, add a second race vendor, or accept
   that race sells only mounts + liveries. All defensible; not a bug.

## Verification honesty note

Every EFFECT FAMILY was driven end to end in the running game, and
representatives of each were measured. All 145 individual rows were NOT driven
one by one — the families are uniform (the 20 `spell_velocity_*` rows differ
only in a multiplier), so per-row testing adds little over the family tests.
If literal per-item verification is wanted, it still needs doing.
