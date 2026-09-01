/**
 * MEDIEVAL quest content — Aldermoor Vale. 10 quests, n 11-20.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 *  READ `QUEST-AUDIT.md` AT THE REPO ROOT BEFORE YOU EDIT THIS FILE.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * The content this replaces was part of a set that was 0-for-50: not one seeded
 * quest could be completed, because ~150 target ids were invented by the author
 * and none of them existed anywhere in `src/`. A quest step is not prose — it is
 * a SUBSCRIPTION to an event the engine already emits. If the engine never emits
 * the thing you name, the step is dead and the quest that contains it can never
 * be finished by any player, ever.
 *
 * ── THE ONLY STEP TYPES WITH A WORKING EMITTER ───────────────────────────────
 *
 *   visit      `world:changed` → `QuestSystem._creditVisit` (QuestSystem.js:501)
 *   collect    `loot:collected` → `_onCollect` (QuestSystem.js:419; Loot.js:605, :613)
 *   talk       `quest:activity{type:'talk'}` (HUD.js:1776) → `_onActivity`
 *   interact   `quest:activity{type:'interact'}` (HUD.js:1773, quest managers only)
 *              plus `portal:entering` (Portals.js:2822) → `_onPortalEntering`
 *   kill       `npc:killed` → `_onKill`, hostiles only (QuestSystem.js:406)
 *   defend     `npc:killed` AND `npc:damaged` → one count per HIT (QuestSystem.js:413)
 *   race       `race:finished` (count===1) / `race:lap` (count>1) — RACE WORLD ONLY
 *   purchase   `market:trade` → `_onMarketTrade` (QuestSystem.js:493)
 *   customize  `character:changed` → `_onCharacterChanged` (QuestSystem.js:497)
 *   survive    one count per 30 damage-free seconds, credited in `update()`
 *
 * ── NEVER USE THESE. NO EMITTER EXISTS; THEY CAN NEVER COMPLETE ──────────────
 *
 *      investigate    deliver    escort    stealth    craft
 *
 * There is no crafting system, no delivery mechanic, no escort AI and no stealth
 * meter. If a beat needs one, pick the closest REAL trackable proxy and make the
 * `label` honest about the goal — the label is what the player reads, the
 * type/target is only what the engine watches.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 *  WHO ACTUALLY STANDS IN THE VALE — "declared in source" != "spawns in game"
 * ═════════════════════════════════════════════════════════════════════════════
 *
 * The station set shipped with four NPC names that are declared in `ROLE_CAST`
 * and NEVER SPAWN, because the world's friendly budget was already consumed
 * before the crowd filler reached them. Every name below is checked against the
 * arithmetic in `NPCManager.spawnForWorld`, not against a list.
 *
 * THE ARITHMETIC (NPCManager.js:641-771):
 *   friendlyBudget = 22          medieval/Inhabitants.js:85, applied at :250
 *   CROWD_RESERVE  = 6           NPCManager.js:664
 *   authored       = 12          the twelve friendlies in `npcSpawns`, below
 *   authoredCap    = max(4, min(12, 22 - 6)) = 12          NPCManager.js:685
 *     → ALL TWELVE authored friendlies get a slot. None is dropped.
 *   friendlyCount  = 12 + 1 lorekeeper = 13                NPCManager.js:769
 *   crowd budget   = 22 - 13 = 9                           NPCManager.js:771
 *   hostileBudget  = 10          medieval/Inhabitants.js:64, applied at :249
 *     → ALL TEN authored bandits get a slot (NPCManager.js:635 clamps at 24).
 *
 * NAMES USED BY THIS FILE, WITH THE LINE THAT SPAWNS THEM:
 *
 *   Edmund Marsh          NPCManager.js:1380  (CAST.medieval, planted by
 *                         `_spawnQuestManagers`, NPCManager.js:1417-1429).
 *                         THE ONLY PROVABLE QUEST MANAGER IN THIS WORLD, so he
 *                         is the only valid `interact` NPC target here.
 *                         MedievalWorld authors none of its own; the streamed
 *                         settlement reeves (medieval/Population.js:622) DO set
 *                         `isQuestManager`, but their names are hash-derived
 *                         (`nameFor`, Population.js:376) and cannot be written
 *                         down in advance. Do not guess one.
 *
 *   Bram Tallow           MedievalWorld.js:12544   ┐
 *   Wilda Sorrel          MedievalWorld.js:12556   │ the first six, authored
 *   Captain Osric Vane    MedievalWorld.js:12567   │ directly into `npcSpawns`
 *   Piety Lark            MedievalWorld.js:12578   │ at MedievalWorld.js:12540
 *   Nell Harrow           MedievalWorld.js:12589   │
 *   Corvin Ash            MedievalWorld.js:12600   ┘
 *   Goodman Alder         MedievalWorld.js:12681   ┐
 *   Tibb Marrow           MedievalWorld.js:12691   │ the second six, pushed at
 *   Rook Danby            MedievalWorld.js:12701   │ MedievalWorld.js:12677
 *   Serjeant Hale         MedievalWorld.js:12712   │
 *   Watchman Pell         MedievalWorld.js:12723   │
 *   Sister Meriet         MedievalWorld.js:12733   ┘
 *
 *   HOSTILES (kill / defend) — ten named marauders, names array at
 *   MedievalWorld.js:12757, pushed with `type:'hostile'` at MedievalWorld.js:12763:
 *     Hollow Jack, Marret the Crow, Dunn Pike, Sable Ida, Wry Tam,
 *     Bregg Ashfoot, Old Culley, Fen Marlow, Rook Gant, Thessa Bane
 *   ⚠ Each name is UNIQUE — there is no shared archetype the way the station has
 *     four 'Rogue Security Unit's. A killed hostile respawns after
 *     `CONFIG.npc.respawnDelay` = 22 s (Config.js:213, NPCManager.js:1944), so a
 *     count above 1 on one name means waiting for him to come back. Kill counts
 *     here are therefore 1 per name and variety comes from naming MORE bandits;
 *     `defend` (one count per hit landed) is where the larger numbers go.
 *   ⚠ Wolves and bears DO spawn (medieval/Wildlife.js:609, streamed by
 *     `MedievalResidency`) and `kill target:'Wolf'` would fire — but a pack is
 *     placed by a cordon solver and streamed only inside 175 m, so no line in
 *     this file can prove a particular player will meet one. Not used.
 *
 *   ROLES. `wanderer` is the default for any authored friendly with no explicit
 *   role (NPCManager.js:730), so all twelve above carry it — a `talk wanderer`
 *   step is backed by twelve guaranteed bodies plus the streamed road
 *   travellers. `lorekeeper` is planted beside the single stone-circle gateway
 *   (`_spawnLorekeepers`, NPCManager.js:1303; portalSpecs at
 *   MedievalWorld.js:12523). `vendor`, `loiterer`, `guard` and `spectator` all
 *   reach the vale through the nine crowd slots (ROLE_ROTATION, NPCRoles.js:300)
 *   and through the streamed settlement cast, but they are second choice: an
 *   authored NAME is the stronger guarantee and is used wherever possible.
 *
 * ── WHAT DROPS HERE ──────────────────────────────────────────────────────────
 *
 * `DROP_TABLES.medieval` (Loot.js:75-82):
 *     arrow .70 · bullet .24 · relic_coin .32 · fireball_charge .14 ·
 *     medkit .12 · nexus_shard .05
 *   plus `credits`, which every pickup carries unconditionally (Loot.js:314).
 *   ⚠ THERE IS NO `alloy_scrap` IN THE VALE. It is station/sports only. A
 *     collect step naming it here could never complete.
 *   ⚠ Loot only spawns from `npc:killed` (Loot.js:169) and from caches, so every
 *     collect step in this world is downstream of a fight or of a cache find,
 *     and the labels say so.
 * `CACHE_TABLES.medieval` (Caches.js:73-78): relic_coin 3-8, nexus_shard 1-2,
 *   arrow 15-30, medkit 1-2 — two or three lines per cache (Caches.js:377).
 * ⚠ `count` is a number of PICKUPS, not of items. Stack `qty` is ignored, so a
 *   cache holding 8 relic coin advances a relic_coin step by exactly 1. Counts
 *   here are kept at or below 3.
 * ⚠ `Relics._collect` (Relics.js:452) adds a relic_coin straight to the store
 *   and emits NO `loot:collected`, so picking up a relic does NOT advance a
 *   collect step. Only drops and caches do.
 *
 * ── BUYING AND SELLING ───────────────────────────────────────────────────────
 *
 * Buying is gated by the vendor's `vendorCategories`; a vendor that authors none
 * is a general trader and sells the whole catalogue (Marketplace.js:657-666).
 * Neither Bram Tallow nor Wilda Sorrel authors any, and both read as traders to
 * `Marketplace._isVendor` (Marketplace.js:669-676) through VENDOR_WORDS
 * (Marketplace.js:29): 'blacksmith' matches `smith`, 'herb stall … market'
 * matches `stall` and `market`. So both are guaranteed-spawn, unrestricted
 * shops. The packs themselves are seeded for every world
 * (site/lib/marketplaceCatalog.ts BASE_ITEMS — no `worlds` restriction), and
 * `_purchaseGrant` (Marketplace.js:309-312) maps pack_arrows→arrow,
 * pack_medkit→medkit. Selling is UNGATED and emits `kind:'sell'`
 * (Marketplace.js:526), which is the only way to track a sale.
 *
 * ── MATCHER NOTES ────────────────────────────────────────────────────────────
 *
 * `_matchesStepTarget` (QuestSystem.js:602) is ANCHORED: exact equality, or the
 * shorter string appearing as a run of WHOLE underscore-separated tokens inside
 * the longer one. So `station` matches the portal id `medieval->station`.
 * ⚠ `_advanceSteps` walks EVERY step of an engagement on each event, so two
 *   steps sharing a type, a target AND a world both advance from one action.
 *   No quest below does that; where two steps share a type they name different
 *   people, different items, or different worlds.
 * ⚠ `visit` is credited on `accept()` as well as on `world:changed`
 *   (QuestSystem.js:505-511), so a `visit medieval` step inside a MEDIEVAL quest
 *   completes the instant the quest is accepted. There is no such step here; the
 *   only `visit` targets used are `station` and worlds the player has to travel
 *   to.
 *
 * ── SHAPE ────────────────────────────────────────────────────────────────────
 *
 * Matches `DEFAULT_QUESTS` in `admin/lib/db.ts` and `quests/station.mjs`:
 *   { n, world, line, title, credits, dur, pre, notes, steps: [...] }
 *   step: { order, label, type, target, count, world }
 *   `pre` holds quest_line NAMES, not numbers. Cross-world prerequisites name
 *   station lines from `quests/station.mjs`. `dur` is duration_minutes and a
 *   too-short timer AUTO-FAILS the quest, so it is generous throughout.
 *
 * Numbering: 11-20. Station owns 1-10 / 101-110 / 201-203; citadel owns 31-40.
 * Never reuse those.
 */

export const MEDIEVAL_QUESTS = [
  {
    n: 11,
    world: 'medieval',
    line: 'Vale Arrival',
    title: 'Report to the reeve and take the measure of Aldermoor',
    credits: 120,
    dur: 60,
    pre: null,
    notes:
      'Opening quest, 2 steps. Teaches the two actions every other vale quest depends on: pressing E on the reeve, and pressing E on ordinary villagers. `wanderer` is the default role for an authored friendly with no explicit role (NPCManager.js:730), so twelve guaranteed bodies carry it and the six on the market square are all within a short walk of the gate.',
    steps: [
      { order: 1, label: 'Press E on Edmund Marsh at his parchment-covered stall on the market square to take the vale\'s standing work', type: 'interact', target: 'Edmund Marsh', count: 1, world: 'medieval' },
      { order: 2, label: 'Press E on 3 villagers around the market cross and ask what has been happening in the vale', type: 'talk', target: 'wanderer', count: 3, world: 'medieval' },
    ],
  },

  {
    n: 12,
    world: 'medieval',
    line: 'Market Day',
    title: 'Open an account with the traders of Aldermoor',
    credits: 260,
    dur: 120,
    pre: ['Vale Arrival'],
    notes:
      '4 steps. The merchant lesson for the vale. Both traders are authored in `npcSpawns` (guaranteed a slot) and neither declares `vendorCategories`, so both are general traders (Marketplace.js:657-666) and either can sell either pack. Goodman Alder opens it because he is the market cross\'s self-appointed warden and will quote the price of everything unasked.',
    steps: [
      { order: 1, label: 'Press E on Goodman Alder at the market cross — he will price every stall on the square for you, unasked', type: 'talk', target: 'Goodman Alder', count: 1, world: 'medieval' },
      { order: 2, label: 'Press E on Wilda Sorrel at the herb stall on the north side of the market', type: 'talk', target: 'Wilda Sorrel', count: 1, world: 'medieval' },
      { order: 3, label: 'Stand within a few paces of Wilda and press B to open the market. Buy the Trauma Twin-Pack — two medkits in one bag slot', type: 'purchase', target: 'medkit', count: 1, world: 'medieval' },
      { order: 4, label: 'Walk down to Bram Tallow at the smithy and press B there. Buy the Arrow Bundle — the vale fights with the bow, and R reloads from your bag', type: 'purchase', target: 'arrow', count: 1, world: 'medieval' },
    ],
  },

  {
    n: 13,
    world: 'medieval',
    line: 'Smoke on the Aldern Road',
    title: 'Reopen the fleece road between the village and the keep',
    credits: 340,
    dur: 150,
    pre: ['Vale Arrival'],
    notes:
      '3 steps, the first fight. Dunn Pike is one of the ten authored marauders (names array MedievalWorld.js:12757, pushed as hostiles at :12763) and the hostile budget of 10 (Inhabitants.js:64) means every one of them spawns. The collect count is 2 because `count` is a number of PICKUPS and the medieval arrow line rolls at .70 (Loot.js:76) — two or three bodies will do it, and the label says where to look.',
    steps: [
      { order: 1, label: 'Press E on Tibb Marrow, the fleece carter, and let him tell you exactly what is wrong with the road', type: 'talk', target: 'Tibb Marrow', count: 1, world: 'medieval' },
      { order: 2, label: 'Dunn Pike\'s crew has the road shut south of the village. Put Pike down — he is a bowman, so close on him rather than trading shots', type: 'kill', target: 'Dunn Pike', count: 1, world: 'medieval' },
      { order: 3, label: 'Recover the shafts: pick up 2 arrow drops off the road (walk over a drop, or press E on it). Bodies and roadside caches both leave them', type: 'collect', target: 'arrow', count: 2, world: 'medieval' },
    ],
  },

  {
    n: 14,
    world: 'medieval',
    line: 'The Reeve\'s Ledger',
    title: 'Carry Aldermoor\'s tithe up to the hub and have it entered',
    credits: 620,
    dur: 300,
    pre: ['Market Day', 'Trade Route Scouting'],
    notes:
      'CROSS-WORLD PREREQUISITE — requires the station line "Trade Route Scouting", which is the quest that first charts the Aldermoor corridor from the other end. 6 steps. Step 5 fires on `portal:entering` (Portals.js:2822) and therefore carries world:medieval, the world being LEFT; step 6 fires on arrival and carries station. relic_coin drops at .32 in the vale (Loot.js:78) and 3-8 to a cache (Caches.js:74) — count 2 is two PICKUPS, and one cache clears half of it.',
    steps: [
      { order: 1, label: 'Press E on Edmund Marsh and take the tithe ledger and the reeve\'s seal', type: 'interact', target: 'Edmund Marsh', count: 1, world: 'medieval' },
      { order: 2, label: 'The tithe is paid in vale coin. Gather 2 relic coin — marauder bodies carry them and the hidden caches hold whole purses', type: 'collect', target: 'relic_coin', count: 2, world: 'medieval' },
      { order: 3, label: 'The hub wants one thing the vale cannot mint. Find a nexus shard — it comes out of a cache, not off a body', type: 'collect', target: 'nexus_shard', count: 1, world: 'medieval' },
      { order: 4, label: 'Press E on Captain Osric Vane at the keep gate and have him countersign the ledger', type: 'talk', target: 'Captain Osric Vane', count: 1, world: 'medieval' },
      { order: 5, label: 'Walk into the sarsen ring at the stone circle and press E — the gate opens onto Aether Station', type: 'interact', target: 'station', count: 1, world: 'medieval' },
      { order: 6, label: 'Arrive on Aether Station and let the ledger be entered against the vale', type: 'visit', target: 'station', count: 1, world: 'station' },
    ],
  },

  {
    n: 15,
    world: 'medieval',
    line: 'Bread and Blessing',
    title: 'Find the almoner somewhere on the castle road',
    credits: 90,
    dur: 45,
    pre: null,
    notes:
      'Deliberately a ONE-step quest — the old data never went below two. Sister Meriet is authored at MedievalWorld.js:12733 with a five-leg patrol that takes her 45 m from her spawn, further than any other civilian in the vale, so "find her" is a real search across the shrine road rather than a walk to a marker. There is no escort AI, so the beat is what it honestly is: catch up with someone who is walking.',
    steps: [
      { order: 1, label: 'Sister Meriet walks the castle road between the shrine and the village all day and never waits for anyone. Catch her up and press E', type: 'talk', target: 'Sister Meriet', count: 1, world: 'medieval' },
    ],
  },

  {
    n: 16,
    world: 'medieval',
    line: 'The Keep Watch',
    title: 'Stand the south curtain with the Aldermoor garrison',
    credits: 780,
    dur: 300,
    pre: ['Smoke on the Aldern Road'],
    notes:
      '5 steps. Hale and Pell walk the SOUTH CURTAIN wall walk at MedievalWorld.js:12712/:12723 — their beats are on the curtain deck, not in the bailey, so steps 2 and 3 cannot be done from the ground and the labels say to get up there. Step 4 is `defend`, which fires on `npc:damaged` as well as `npc:killed` (QuestSystem.js:413), so it counts HITS LANDED — which is why 6 is reasonable against a single named bandit where a kill count would not be.',
    steps: [
      { order: 1, label: 'Press E on Captain Osric Vane at the keep gate and ask to be put on the watch roster', type: 'talk', target: 'Captain Osric Vane', count: 1, world: 'medieval' },
      { order: 2, label: 'Get up onto the south curtain — hold Space at the wall to climb, tap it at the ledge to mantle — and press E on Serjeant Hale on the western beat', type: 'talk', target: 'Serjeant Hale', count: 1, world: 'medieval' },
      { order: 3, label: 'Walk the deck east and press E on Watchman Pell. He will answer about a minute after you ask', type: 'talk', target: 'Watchman Pell', count: 1, world: 'medieval' },
      { order: 4, label: 'Sable Ida has been probing the glacis. Land 6 hits on her from the wall or the gate — every hit counts, she does not have to fall', type: 'defend', target: 'Sable Ida', count: 6, world: 'medieval' },
      { order: 5, label: 'Finish the watch clean: two unbroken minutes anywhere in the vale without taking a single hit. Any damage puts the timer back to zero', type: 'survive', target: 'medieval', count: 4, world: 'medieval' },
    ],
  },

  {
    n: 17,
    world: 'medieval',
    line: 'The Broken Company',
    title: 'Break the marauder company that has preyed on the vale since the levy',
    credits: 1150,
    dur: 720,
    pre: ['The Keep Watch', 'Weapons Free'],
    notes:
      'CROSS-WORLD PREREQUISITE — requires the station education line "Weapons Free", because this is four separate fights across the woods, the far bank and the outer village. 7 steps. Four DIFFERENT named marauders rather than one name with count 4: every hostile in this world has a unique name (MedievalWorld.js:12757) and a respawn takes 22 s (Config.js:213), so naming four is both honest and better content. Step 6 is deliberately count 3 — three pickups, not three coins.',
    steps: [
      { order: 1, label: 'Press E on Captain Osric Vane and take the writ against the broken company', type: 'talk', target: 'Captain Osric Vane', count: 1, world: 'medieval' },
      { order: 2, label: 'Hollow Jack works the far bank east of the river. Ride out (hold M for the mount wheel) and put him down', type: 'kill', target: 'Hollow Jack', count: 1, world: 'medieval' },
      { order: 3, label: 'Marret the Crow keeps to the high woods north-east of the ford. Kill her', type: 'kill', target: 'Marret the Crow', count: 1, world: 'medieval' },
      { order: 4, label: 'Bregg Ashfoot patrols the western march beyond the parish church. Kill him', type: 'kill', target: 'Bregg Ashfoot', count: 1, world: 'medieval' },
      { order: 5, label: 'Thessa Bane holds the southern track below the mill. Kill her and the company has no captains left', type: 'kill', target: 'Thessa Bane', count: 1, world: 'medieval' },
      { order: 6, label: 'Take back what they took: recover 3 relic coin from the bodies and their caches', type: 'collect', target: 'relic_coin', count: 3, world: 'medieval' },
      { order: 7, label: 'Press E on Edmund Marsh and close the writ against the company', type: 'interact', target: 'Edmund Marsh', count: 1, world: 'medieval' },
    ],
  },

  {
    n: 18,
    world: 'medieval',
    line: 'Relics of the Stone Circle',
    title: 'Learn what the sarsen ring was raised to watch',
    credits: 1330,
    dur: 1440,
    pre: ['The Reeve\'s Ledger', 'Nexus Cartographer'],
    notes:
      'CROSS-WORLD PREREQUISITE — requires the station line "Nexus Cartographer", the quest that verifies every gateway; this is the vale\'s half of the same question. 8 steps. Corvin Ash is authored AT the circle (MedievalWorld.js:12600, patrol around CIRCLE), and the gateway lorekeeper is planted beside the same portal by `_spawnLorekeepers` (NPCManager.js:1303) from the single portalSpec at MedievalWorld.js:12523 — so both people this quest needs stand within thirty metres of the player\'s own spawn pin. It closes on Piety Lark rather than on the reeve so the ballad, not the ledger, is the last word.',
    steps: [
      { order: 1, label: 'Press E on Corvin Ash, the hooded traveller who will not leave the ruined stone circle, and ask him what the stones were raised to watch', type: 'talk', target: 'Corvin Ash', count: 1, world: 'medieval' },
      { order: 2, label: 'Press E on the keeper standing beside the sky-gate itself and get the other half of the story', type: 'talk', target: 'lorekeeper', count: 1, world: 'medieval' },
      { order: 3, label: 'The ring answers to shard-stone. Recover a nexus shard from one of the vale\'s hidden caches', type: 'collect', target: 'nexus_shard', count: 1, world: 'medieval' },
      { order: 4, label: 'Old coin was left at the stones as offering and has been dug up since. Gather 3 relic coin', type: 'collect', target: 'relic_coin', count: 3, world: 'medieval' },
      { order: 5, label: 'You are not the only one digging. Old Culley is working the barrows west of the vale — kill him', type: 'kill', target: 'Old Culley', count: 1, world: 'medieval' },
      { order: 6, label: 'Fen Marlow is his partner in it, north of the ford. Kill him too', type: 'kill', target: 'Fen Marlow', count: 1, world: 'medieval' },
      { order: 7, label: 'Keep the vigil at the stones: two unbroken minutes without taking a hit', type: 'survive', target: 'medieval', count: 4, world: 'medieval' },
      { order: 8, label: 'Press E on Piety Lark at the Gilded Boar and give her the whole of it — she is composing an epic about the sky-gate and will put you in it', type: 'talk', target: 'Piety Lark', count: 1, world: 'medieval' },
    ],
  },

  {
    n: 19,
    world: 'medieval',
    line: 'The Coin of Aldermoor',
    title: 'Strike a vale coin the hub will accept at face value',
    credits: 1630,
    dur: 2880,
    pre: ['Relics of the Stone Circle', 'Merchant Trade'],
    notes:
      'CROSS-WORLD PREREQUISITE — requires the station education line "Merchant Trade", because half of this quest is the shop. 9 steps. Step 6 targets the trade KIND (`sell`), which `market:trade` carries (Marketplace.js:526) and QuestSystem pushes as a candidate — it is the ONLY way to prove a sale rather than a purchase; do not replace it with an item id. Step 8 asks for the tunic because the player arrives in the station flight suit by default (PlayerAvatar.js DEFAULT), so it takes a real change in the Esc menu Character panel to produce it. Opens on Edmund Marsh and closes on Goodman Alder: two different people, so one E press cannot clear both ends.',
    steps: [
      { order: 1, label: 'Press E on Edmund Marsh and take the reeve\'s warrant to strike coin', type: 'interact', target: 'Edmund Marsh', count: 1, world: 'medieval' },
      { order: 2, label: 'Press E on Bram Tallow at the smithy — he cuts the dies, and he will charge double because it is decorative', type: 'talk', target: 'Bram Tallow', count: 1, world: 'medieval' },
      { order: 3, label: 'Press E on Rook Danby, his apprentice, who has theories about all of this and will not stop talking', type: 'talk', target: 'Rook Danby', count: 1, world: 'medieval' },
      { order: 4, label: 'Old coin is the metal. Gather 3 relic coin from bodies and caches to melt down', type: 'collect', target: 'relic_coin', count: 3, world: 'medieval' },
      { order: 5, label: 'Hard money to seed the mint: pick up 2 credit drops (every drop in the world carries some)', type: 'collect', target: 'credits', count: 2, world: 'medieval' },
      { order: 6, label: 'Raise the rest at market. Press B at any trader, switch to the sell side, and sell 2 stacks back — you get less than you paid, that is the spread', type: 'purchase', target: 'sell', count: 2, world: 'medieval' },
      { order: 7, label: 'Buy the mint a medkit pack out of the proceeds (B at Wilda Sorrel\'s herb stall) — a striker with a burned hand strikes nothing', type: 'purchase', target: 'medkit', count: 1, world: 'medieval' },
      { order: 8, label: 'The vale will not take coin from someone dressed like a gate-runner. Open the Esc menu, take Character, and put on the Tunic', type: 'customize', target: 'tunic', count: 1, world: 'medieval' },
      { order: 9, label: 'Press E on Goodman Alder at the market cross and have him cry the new rate across the square', type: 'talk', target: 'Goodman Alder', count: 1, world: 'medieval' },
    ],
  },

  {
    n: 20,
    world: 'medieval',
    line: 'Lord of the Vale',
    title: 'Answer for Aldermoor at the hub, and be answered',
    credits: 2260,
    dur: 5760,
    pre: ['The Broken Company', 'The Coin of Aldermoor'],
    notes:
      'Capstone, 10 steps — the longest list in the vale set, and every earlier thread pays into it. Steps 9 and 10 leave the world: step 9 fires on `portal:entering` and so carries world:medieval (the world being LEFT — `_worldId` has not changed yet), step 10 fires on arrival and carries station. There is deliberately NO `visit medieval` step: `accept()` credits a visit for the world the quest was accepted in (QuestSystem.js:505-511), so such a step would complete itself the moment the player took the quest. Step 1 (interact/Edmund Marsh/medieval) and step 9 (interact/station/medieval) share a type and a world but not a target, so one E press cannot clear both.',
    steps: [
      { order: 1, label: 'Press E on Edmund Marsh and be given the vale\'s answer to carry', type: 'interact', target: 'Edmund Marsh', count: 1, world: 'medieval' },
      { order: 2, label: 'Press E on Captain Osric Vane — nothing leaves this valley for the sky-gate without the garrison knowing', type: 'talk', target: 'Captain Osric Vane', count: 1, world: 'medieval' },
      { order: 3, label: 'What is left of the company will try to stop it. Kill Rook Gant on the eastern road', type: 'kill', target: 'Rook Gant', count: 1, world: 'medieval' },
      { order: 4, label: 'Kill Sable Ida, who has been waiting on the glacis for exactly this', type: 'kill', target: 'Sable Ida', count: 1, world: 'medieval' },
      { order: 5, label: 'Wry Tam runs rather than fights. Land 8 hits on him before he gets clear of the woods', type: 'defend', target: 'Wry Tam', count: 8, world: 'medieval' },
      { order: 6, label: 'The vale sends tribute with its answer: gather 3 relic coin', type: 'collect', target: 'relic_coin', count: 3, world: 'medieval' },
      { order: 7, label: 'And one shard, so the hub knows the stones still work. Find a nexus shard in a cache', type: 'collect', target: 'nexus_shard', count: 1, world: 'medieval' },
      { order: 8, label: 'Hold the circle while the gate charges — three unbroken minutes in the vale without taking a hit', type: 'survive', target: 'medieval', count: 6, world: 'medieval' },
      { order: 9, label: 'Step into the sarsen ring and press E', type: 'interact', target: 'station', count: 1, world: 'medieval' },
      { order: 10, label: 'Arrive on Aether Station carrying the vale\'s answer, and take Aldermoor\'s seat at the hub table', type: 'visit', target: 'station', count: 1, world: 'station' },
    ],
  },
];

export default MEDIEVAL_QUESTS;
