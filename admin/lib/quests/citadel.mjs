/**
 * CITADEL quest content — Sunspire Citadel. 10 quests, n 31-40.
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
 *  WHO ACTUALLY STANDS ON THE ROCK — "declared in source" != "spawns in game"
 * ═════════════════════════════════════════════════════════════════════════════
 *
 * The station set shipped with four NPC names that are declared in `ROLE_CAST`
 * and NEVER SPAWN, because the world's friendly budget was already consumed
 * before the crowd filler reached them. Every name below is checked against the
 * arithmetic in `NPCManager.spawnForWorld`, not against a list.
 *
 * THE ARITHMETIC (NPCManager.js:641-771). CitadelWorld declares NO
 * `friendlyBudget` and NO `hostileBudget`, so the engine defaults apply:
 *   friendlyBudget = maxFriendlies = 30                    NPCManager.js:492
 *   CROWD_RESERVE  = 6                                     NPCManager.js:664
 *   authored       = 4          the four friendlies in `npcSpawns`, below
 *   authoredCap    = max(4, min(4, 30 - 6)) = 4            NPCManager.js:685
 *     → ALL FOUR authored friendlies get a slot. None is dropped.
 *   maxHostiles    = CONFIG.npc.hostileCount = 10          Config.js:202
 *     → ALL EIGHT authored hostiles get a slot (NPCManager.js:635).
 *   crowd budget   = 30 - (4 + 1 lorekeeper) = 25          NPCManager.js:771
 *
 * ⚠ THE CROWD IS WEARING THE WRONG CLOTHES AND MUST NOT BE NAMED.
 *   `THEME_BY_WORLD` (NPCManager.js:261) has NO `citadel` entry, so the theme
 *   falls back to `station`. Every one of those 25 crowd slots is therefore
 *   filled from `ROLE_CAST.station` / `CROWD_NAMES.station` (NPCManager.js:1445,
 *   NPCRoles.js:124) — 'Quartermaster Bex', 'Deck Warden Ilse', 'Deck Tech Ruiz'
 *   and the rest, standing in a desert souk. They do spawn, but naming one in a
 *   quest would put a station dockhand in a citadel label. NOT USED. Only the
 *   four authored citadel civilians and Aldric Storne are named below.
 *
 * NAMES USED BY THIS FILE, WITH THE LINE THAT SPAWNS THEM:
 *
 *   Aldric Storne         NPCManager.js:1394  (CAST.citadel, planted by
 *                         `_spawnQuestManagers`, NPCManager.js:1417-1429).
 *                         THE ONLY QUEST MANAGER IN THIS WORLD — CitadelWorld
 *                         sets `isQuestManager` nowhere, so he is the only valid
 *                         `interact` NPC target here. He stands at [8, 14.3, 88],
 *                         which is the inner-ward side of the gate.
 *
 *   Rafiq the Keeper      CitadelWorld.js:2047   ┐ the whole authored cast,
 *   Hafsa the Dyer        CitadelWorld.js:2048   │ pushed into `npcSpawns` at
 *   Bashir the Ostler     CitadelWorld.js:2049   │ CitadelWorld.js:2046
 *   Yusra the Falconer    CitadelWorld.js:2050   ┘
 *   None declares a `role`, so all four default to `wanderer`
 *   (NPCManager.js:730) — which is what makes `talk wanderer` a step backed by
 *   four guaranteed bodies rather than by the crowd filler.
 *
 *   HOSTILES (kill / defend) — eight of them, authored WITHOUT a name in the
 *   ring loop at CitadelWorld.js:2052-2058. An unnamed hostile is auto-named
 *   `Sentinel ${hostileCount + 1}` (NPCManager.js:721), so the eight bodies are
 *   'Sentinel 1' … 'Sentinel 8'. The matcher is a whole-token run
 *   (QuestSystem.js:624), so the target `Sentinel` matches every one of them:
 *   ['sentinel'] appears as a contiguous run in ['sentinel','1'].
 *   ⚠ Do NOT write `Sentinel 3` — that names one body out of eight and would
 *     make a count above 1 depend on the 22 s respawn (Config.js:213).
 *
 *   ROLES. The four above now carry authored roles: Rafiq, Hafsa and Bashir are
 *   `vendor`, and Yusra alone is `wanderer` — which is what all four were by
 *   default before the posts were authored. `lorekeeper` is planted beside the
 *   single gateway by `_spawnLorekeepers` (NPCManager.js:1303) from the one
 *   portalSpec at CitadelWorld.js:2032. `loiterer`, `guard` and `spectator`
 *   reach this world only through the crowd filler (ROLE_ROTATION,
 *   NPCRoles.js:300) and are second choice — an authored NAME is the stronger
 *   guarantee, so only `wanderer` and `lorekeeper` are targeted.
 *   ⚠ Yusra is the world's ONLY `wanderer`, measured on the built world:
 *     vendor 5 · wanderer 1 · quest_manager 1 · guard 2 · spectator 1 ·
 *     loiterer 2. So NOTHING here may target `wanderer` with a count above 1 -
 *     Q31 step 2 asked for three and could only be finished by pressing E on
 *     Yusra three times (`_advanceSteps` passes no `onceKey` for
 *     `quest:activity`, QuestSystem.js:552). It targets `vendor` now, which is
 *     the three counters the label always named.
 *
 * ── WHAT DROPS HERE ──────────────────────────────────────────────────────────
 *
 * `DROP_TABLES.citadel` now exists (Loot.js), so a Sentinel on this rock drops:
 *     relic_coin .44 (2-6) · arrow .66 (6-16) · nexus_shard .05 · medkit .10
 *   plus `credits`, which every pickup carries unconditionally (Loot.js:314).
 * ⚠ THERE IS NO bullet, fireball_charge OR alloy_scrap ANYWHERE IN THIS WORLD.
 *   The citadel used to have no row of its own and fell back to the STATION
 *   table, which is the only reason two steps below ever named bullet and alloy
 *   scrap; both were retargeted when the row landed. Nothing here manufactures
 *   cartridges, ember cores or hull plate, and `CACHE_TABLES.citadel` never
 *   carried them either.
 * `CACHE_TABLES.citadel` (Caches.js:79-84) is the richer source and still the
 *   only one for large stacks: relic_coin 4-10, nexus_shard 1-2, arrow 18-34,
 *   medkit 1-2, two or three lines to a cache (Caches.js:377). A relic_coin
 *   step is now satisfiable from EITHER a cache or a body; no relic_coin count
 *   below exceeds 3 regardless.
 * ⚠ `count` is a number of PICKUPS, not of items. Stack `qty` is ignored, so a
 *   cache holding 10 relic coin advances a relic_coin step by exactly 1.
 * ⚠ Loot only spawns from `npc:killed` (Loot.js:169) and from caches, so every
 *   collect step here is downstream of a fight or of a climb.
 *
 * ── BUYING AND SELLING ───────────────────────────────────────────────────────
 *
 * Buying is gated by the vendor's `vendorCategories`; a vendor that authors none
 * is a general trader and sells the whole catalogue (Marketplace.js:657-666).
 * The citadel now authors THREE counters, each with `role: 'vendor'` and its own
 * `vendorCategories`, so `Marketplace._isVendor` reaches all three by role
 * rather than by the VENDOR_WORDS regex (Marketplace.js:29) that used to match
 * Hafsa's 'cloth stall' and miss the other two entirely:
 *     Rafiq the Keeper    health, spells    'Archive & Physic'
 *     Hafsa the Dyer      cosmetic, tools   'Cloth & Colour'
 *     Bashir the Ostler   mounts, weapons   'Harness & Arms'
 * Between them that is the whole catalogue, which matters because there is one
 * portal off this mesa. ⚠ A buy step must now name a category one of them
 * stocks: Hafsa can no longer sell a medkit, Rafiq can. All three are authored
 * in `npcSpawns` and therefore guaranteed a slot. The packs are seeded for
 * every world (site/lib/marketplaceCatalog.ts BASE_ITEMS — no `worlds`
 * restriction) and `_purchaseGrant` (Marketplace.js:309-312) maps
 * pack_arrows→arrow, pack_medkit→medkit. Selling is UNGATED and emits
 * `kind:'sell'` (Marketplace.js:526), which is the only way to track a sale.
 *
 * ── MATCHER NOTES ────────────────────────────────────────────────────────────
 *
 * `_matchesStepTarget` (QuestSystem.js:602) is ANCHORED: exact equality, or the
 * shorter string appearing as a run of WHOLE underscore-separated tokens inside
 * the longer one. So `station` matches the portal id `citadel->station` and
 * `Sentinel` matches `Sentinel 5`.
 * ⚠ `_advanceSteps` walks EVERY step of an engagement on each event, so two
 *   steps sharing a type, a target AND a world both advance from one action.
 *   No quest below does that. Note also that `_onKill` advances BOTH `kill` and
 *   `defend` steps (QuestSystem.js:409-410), so no quest here pairs a `kill
 *   Sentinel` step with a `defend Sentinel` step — the kill would pay into both.
 * ⚠ `visit` is credited on `accept()` as well as on `world:changed`
 *   (QuestSystem.js:505-511), so a `visit citadel` step inside a CITADEL quest
 *   completes the instant the quest is accepted. There is no such step here.
 *
 * ── SHAPE ────────────────────────────────────────────────────────────────────
 *
 * Matches `DEFAULT_QUESTS` in `admin/lib/db.ts` and `quests/station.mjs`:
 *   { n, world, line, title, credits, dur, pre, notes, steps: [...] }
 *   step: { order, label, type, target, count, world }
 *   `pre` holds quest_line NAMES, not numbers. Cross-world prerequisites name
 *   station lines from `quests/station.mjs` and vale lines from
 *   `quests/medieval.mjs`. `dur` is duration_minutes and a too-short timer
 *   AUTO-FAILS the quest, so it is generous throughout.
 *
 * Numbering: 31-40. Station owns 1-10 / 101-110 / 201-203; medieval owns 11-20.
 * Never reuse those.
 */

export const CITADEL_QUESTS = [
  {
    n: 31,
    world: 'citadel',
    line: 'The Cliff Gate',
    title: 'Present yourself at the Sunspire gate and walk the lower souk',
    credits: 130,
    dur: 60,
    pre: null,
    notes:
      'Opening quest, 2 steps. Teaches the two actions every other citadel quest depends on: pressing E on the garrison\'s quest desk, and pressing E on ordinary people. Step 2 targets `vendor`, NOT `wanderer`, and that is the whole of the repair: Drop Two gave Rafiq, Hafsa and Bashir `role: \'vendor\'`, leaving Yusra the Falconer as the world\'s ONLY wanderer (measured: vendor 5, wanderer 1, quest_manager 1, guard 2, spectator 1, loiterer 2) and `ROLE_ROTATION` never produces another. `HUD.js` emits `quest:activity {type:\'talk\', role:\'vendor\', ...}` for each of the three, so `count: 3` over `vendor` is three different people and a short walk — the three counters stand 19.7 m and 34.2 m apart just inside the gate. Aimed at `wanderer` it was finishable only by pressing E on Yusra three times, since `_advanceSteps` passes no `onceKey` for `quest:activity`.',
    steps: [
      { order: 1, label: 'The player spawn is just inside the gate. Walk up the ramp and press E on Aldric Storne of the Citadel garrison to be entered on the roll', type: 'interact', target: 'Aldric Storne', count: 1, world: 'citadel' },
      { order: 2, label: 'Press E on all three of the citadel\'s counters — Rafiq the Keeper, Hafsa the Dyer, Bashir the Ostler — and find out what a stranger is worth here', type: 'talk', target: 'vendor', count: 3, world: 'citadel' },
    ],
  },

  {
    n: 32,
    world: 'citadel',
    line: 'Cloth and Cordage',
    title: 'Open an account at the cloth stall inside the gate',
    credits: 280,
    dur: 120,
    pre: ['The Cliff Gate'],
    notes:
      '4 steps. The merchant lesson for the citadel. Hafsa is authored in `npcSpawns`, so she is guaranteed a slot — but she is NOT a general trader any more: Drop Two gave her `vendorCategories: [\'cosmetic\', \'tools\']` (CitadelWorld.js), and `Marketplace.refreshCatalog` filters `_catalog` itself by that list, so the Trauma Twin-Pack (`pack_medkit`, category `health`) is simply not in her window. Rafiq the Keeper stocks `health`; he is 19.7 m from her stall, against `VENDOR_RANGE` 7, so step 2 has to name HIS counter and does. Step 4 stays at Hafsa because selling is not category-gated — `Marketplace.sellables` reads the player\'s own bag. Step 3 is a CACHE step on purpose: relic_coin comes from `CACHE_TABLES.citadel` (Caches.js:79) as well as the world\'s own drop table.',
    steps: [
      { order: 1, label: 'Press E on Hafsa the Dyer at the cloth stall just inside the gate — she knows every roof in the souk and will say so', type: 'talk', target: 'Hafsa the Dyer', count: 1, world: 'citadel' },
      { order: 2, label: 'Hafsa deals in cloth and tools, not medicine. Walk twenty paces to Rafiq the Keeper\'s counter — Archive & Physic — press B and buy the Trauma Twin-Pack. Nothing on this rock heals you for free', type: 'purchase', target: 'medkit', count: 1, world: 'citadel' },
      { order: 3, label: 'Sunspire prices in relic coin and nothing here drops it — it sits in the hidden caches on the roofs and terraces. Climb up and recover 1', type: 'collect', target: 'relic_coin', count: 1, world: 'citadel' },
      { order: 4, label: 'Press B again, switch to the sell side, and sell a stack back to Hafsa. You get less than you paid; that is the spread', type: 'purchase', target: 'sell', count: 1, world: 'citadel' },
    ],
  },

  {
    n: 33,
    world: 'citadel',
    line: 'The Ostler\'s Round',
    title: 'Walk the terraces from the horse lines to the great tower',
    credits: 320,
    dur: 150,
    pre: ['The Cliff Gate'],
    notes:
      '3 steps, and a deliberate route: the citadel steps up ring by ring, so this is a climb from the wall lines at (20, 96) to Yusra at (-4, 40) below the great tower. Both are authored in `npcSpawns` (CitadelWorld.js:2049, :2050) and are therefore guaranteed a slot. `survive` credits one count per 30 unbroken damage-free seconds and ANY hit resets the accumulator, so count 2 really is one clean minute with eight Sentinels ringing the plateau at 62 m.',
    steps: [
      { order: 1, label: 'Press E on Bashir the Ostler at the horse lines below the wall — gruff, fond of his animals, and the only man here who will tell you where the ramps are', type: 'talk', target: 'Bashir the Ostler', count: 1, world: 'citadel' },
      { order: 2, label: 'Climb the terraces to the inner ward and press E on Yusra the Falconer, who flies the eagles off the great tower and watches everything', type: 'talk', target: 'Yusra the Falconer', count: 1, world: 'citadel' },
      { order: 3, label: 'Get back down to the gate without being touched — one unbroken minute on the terraces with no damage taken', type: 'survive', target: 'citadel', count: 2, world: 'citadel' },
    ],
  },

  {
    n: 34,
    world: 'citadel',
    line: 'Terrace Patrol',
    title: 'Clear the sentinel ring off the plateau approaches',
    credits: 700,
    dur: 300,
    pre: ['The Ostler\'s Round', 'Weapons Free'],
    notes:
      'CROSS-WORLD PREREQUISITE — requires the station education line "Weapons Free", because this is the first real fight in the citadel. 6 steps. The hostiles here are authored unnamed in a ring at radius 62 (CitadelWorld.js:2052-2058) and are auto-named `Sentinel N` (NPCManager.js:721); the token-run matcher means the target `Sentinel` reaches all eight. Steps 3 and 4 are both fed by the same bodies through DROP_TABLES.citadel (Loot.js), where arrow rolls at .66 and credits are guaranteed on every pickup (Loot.js:314). Step 3 named `bullet` until the citadel got a drop table of its own; there are no cartridges on this rock and there never were.',
    steps: [
      { order: 1, label: 'Press E on Aldric Storne and take the patrol order for the plateau approaches', type: 'interact', target: 'Aldric Storne', count: 1, world: 'citadel' },
      { order: 2, label: 'The sentinels stand in a ring out on the open rock, well clear of the souk. Destroy 3 of them — there is no cover out there, so keep moving', type: 'kill', target: 'Sentinel', count: 3, world: 'citadel' },
      { order: 3, label: 'Strip the wrecks for ammunition: pick up 2 arrow drops', type: 'collect', target: 'arrow', count: 2, world: 'citadel' },
      { order: 4, label: 'Take the pay off them too — collect 2 credit drops', type: 'collect', target: 'credits', count: 2, world: 'citadel' },
      { order: 5, label: 'Then get off the open ground: one clean minute back inside the walls without taking a hit', type: 'survive', target: 'citadel', count: 2, world: 'citadel' },
      { order: 6, label: 'Press E on Hafsa the Dyer and let her patch what the sentinels did to your kit', type: 'talk', target: 'Hafsa the Dyer', count: 1, world: 'citadel' },
    ],
  },

  {
    n: 35,
    world: 'citadel',
    line: 'The Sunspire Tithe',
    title: 'Find the citadel\'s hidden coin without asking anyone where it is',
    credits: 150,
    dur: 60,
    pre: null,
    notes:
      'Deliberately a ONE-step quest — the old data never went below two. It exists to teach the one thing about this world a player will otherwise never work out: relic_coin is NOT in the drop table the citadel uses. `DROP_TABLES` has no citadel entry and falls back to the station table (Loot.js:309), so no sentinel will ever drop one. The only source is `CACHE_TABLES.citadel` (Caches.js:79), and cache sites here are roof and tower platforms, which means the answer is to climb. Count 2 is two PICKUPS; the stack qty of 4-10 a cache holds is ignored (QuestSystem._onCollect advances by exactly one per event).',
    steps: [
      { order: 1, label: 'No sentinel on this rock carries relic coin — every piece of it is in a hidden cache, and the caches here are on the roofs, the terraces and the tower tops. Climb (hold Space at a wall, tap it at a ledge) and recover 2', type: 'collect', target: 'relic_coin', count: 2, world: 'citadel' },
    ],
  },

  {
    n: 36,
    world: 'citadel',
    line: 'Rope Bridge Run',
    title: 'Cross the minaret bridges and clear the tower tops',
    credits: 850,
    dur: 300,
    pre: ['Terrace Patrol'],
    notes:
      '5 steps set on the plank bridges strung between the four minarets and the great tower (CitadelWorld.js:1496 onwards). The bridges sag and you can fall BETWEEN the planks, which is why step 2 is a survive step rather than a movement step — there is no emitter for crossing a bridge, so the objective rides the one verb that proves you were up there and untouched. It opens on Yusra (the bridges are hers to watch) and closes on Aldric Storne, so no single E press can clear both ends.',
    steps: [
      { order: 1, label: 'Press E on Yusra the Falconer — she flies the towers and knows which of the rope bridges will still take a person', type: 'talk', target: 'Yusra the Falconer', count: 1, world: 'citadel' },
      { order: 2, label: 'Get up onto the bridges and stay up there: two unbroken minutes without taking a hit. You can fall between the planks, so walk them, do not sprint them', type: 'survive', target: 'citadel', count: 4, world: 'citadel' },
      { order: 3, label: 'The tower tops are where the richest caches sit. Recover 2 relic coin from up there', type: 'collect', target: 'relic_coin', count: 2, world: 'citadel' },
      { order: 4, label: 'Come back down the outside and destroy 2 sentinels on the rock below', type: 'kill', target: 'Sentinel', count: 2, world: 'citadel' },
      { order: 5, label: 'Press E on Aldric Storne and report the bridges sound', type: 'interact', target: 'Aldric Storne', count: 1, world: 'citadel' },
    ],
  },

  {
    n: 37,
    world: 'citadel',
    line: 'The Archive of Rafiq',
    title: 'Get into the citadel archive and out again with what it holds',
    credits: 1600,
    dur: 720,
    pre: ['Rope Bridge Run', 'Nexus Cartographer'],
    notes:
      'CROSS-WORLD PREREQUISITE — requires the station line "Nexus Cartographer", the quest that verifies every gateway; this is the citadel\'s half of the same question. 7 steps. Rafiq is authored at CitadelWorld.js:2047 and the gateway lorekeeper is planted beside the single portalSpec (CitadelWorld.js:2032) by `_spawnLorekeepers` (NPCManager.js:1303), so both are guaranteed. Step 6 asks for the robe because the player arrives in the station flight suit by default, so it takes a real change in the F2 menu to produce it — and `character:changed` carries config VALUES, never a field name (PlayerAvatar.js:185 OUTFITS).',
    steps: [
      { order: 1, label: 'Press E on Rafiq the Keeper at the archive door. He speaks in riddles about the old order and will not simply hand you anything', type: 'talk', target: 'Rafiq the Keeper', count: 1, world: 'citadel' },
      { order: 2, label: 'Press E on the keeper standing beside the sky-gate at the cliff edge and get the version the citadel does not tell', type: 'talk', target: 'lorekeeper', count: 1, world: 'citadel' },
      { order: 3, label: 'The archive door answers to shard-stone. Find a nexus shard — sentinels drop them rarely, the caches carry them reliably', type: 'collect', target: 'nexus_shard', count: 1, world: 'citadel' },
      { order: 4, label: 'Rafiq wants the fee in old coin. Recover 3 relic coin from the roof and terrace caches', type: 'collect', target: 'relic_coin', count: 3, world: 'citadel' },
      { order: 5, label: 'The garrison does not want the archive opened. Destroy 4 sentinels as they close on the ward', type: 'kill', target: 'Sentinel', count: 4, world: 'citadel' },
      { order: 6, label: 'Nobody walks into that archive dressed as a gate-runner. Press F2 and put on the Robe', type: 'customize', target: 'robe', count: 1, world: 'citadel' },
      { order: 7, label: 'Press E on Aldric Storne and put the archive\'s answer in front of him, whether he wanted it or not', type: 'interact', target: 'Aldric Storne', count: 1, world: 'citadel' },
    ],
  },

  {
    n: 38,
    world: 'citadel',
    line: 'The Sunspire Garrison',
    title: 'Break the sentinel ring outright and hold the plateau',
    credits: 2400,
    dur: 1440,
    pre: ['The Archive of Rafiq', 'Station Saboteur'],
    notes:
      'CROSS-WORLD PREREQUISITE — requires the station line "Station Saboteur", the quest that teaches all four station hostile shapes; this is the same lesson against an emplaced ring on open rock. 8 steps. Count 6 against `Sentinel` is comfortable: eight bodies are authored (CitadelWorld.js:2052) and the hostile budget is the engine default of 10 (Config.js:202), so all eight spawn, and any that fall come back after 22 s (NPCManager.js:1944). Steps 3-5 are all fed by those bodies through DROP_TABLES.citadel (Loot.js): relic_coin .44, medkit .10, credits guaranteed. Step 3 named `alloy_scrap` while this world was still borrowing the station table; there is no foundry within a hundred miles of the mesa and nothing here sheds hull plate.',
    steps: [
      { order: 1, label: 'Press E on Aldric Storne and take the order to break the ring, not just thin it', type: 'interact', target: 'Aldric Storne', count: 1, world: 'citadel' },
      { order: 2, label: 'Destroy 6 sentinels. They stand in a ring at about sixty metres out, which means no two of them are ever in the same fight unless you make them be', type: 'kill', target: 'Sentinel', count: 6, world: 'citadel' },
      { order: 3, label: 'Strip the emplacements: collect 3 crown-coin drops off the wrecks — the garrison is paid in old coin like everyone else here', type: 'collect', target: 'relic_coin', count: 3, world: 'citadel' },
      { order: 4, label: 'Recover a medkit from the field — you will want it before this is over', type: 'collect', target: 'medkit', count: 1, world: 'citadel' },
      { order: 5, label: 'And take the garrison\'s pay: 3 credit drops', type: 'collect', target: 'credits', count: 3, world: 'citadel' },
      { order: 6, label: 'Hold the cleared ground: two unbroken minutes on the plateau without taking a hit', type: 'survive', target: 'citadel', count: 4, world: 'citadel' },
      { order: 7, label: 'Press E on Bashir the Ostler and get the horse lines moved back out onto the rock', type: 'talk', target: 'Bashir the Ostler', count: 1, world: 'citadel' },
      { order: 8, label: 'Press E on Rafiq the Keeper and have the day entered in the archive, which is the only record this place keeps', type: 'talk', target: 'Rafiq the Keeper', count: 1, world: 'citadel' },
    ],
  },

  {
    n: 39,
    world: 'citadel',
    line: 'Salt, Cloth and Coin',
    title: 'Put a Sunspire trade ledger in front of the hub',
    credits: 3300,
    dur: 2880,
    pre: ['The Sunspire Garrison', 'Merchant Trade'],
    notes:
      'CROSS-WORLD PREREQUISITE — requires the station education line "Merchant Trade", because half of this quest is the shop. 9 steps. Steps 3, 4 and 6 are three DIFFERENT purchase targets (two item ids and the trade kind `sell`), so no two of them advance from one action. Each buy step names the counter that actually stocks it: `pack_medkit` is category `health` (Rafiq), `pack_arrows` is `weapons` (Bashir), and Hafsa stocks neither — `Marketplace.refreshCatalog` filters the catalogue by the open vendor\'s `vendorCategories`, and `_findVendor` only sees NPCs inside `VENDOR_RANGE` 7 m, with Rafiq 19.7 m and Bashir 34.2 m from her stall. Step 6 stays with her because selling is not category-gated. Step 8 fires on `portal:entering` (Portals.js:2822) and therefore carries world:citadel — the world being LEFT, because `_worldId` has not changed yet — and step 9 fires on arrival and carries station. Step 1 (interact/Aldric Storne/citadel) and step 8 (interact/station/citadel) share a type and a world but not a target.',
    steps: [
      { order: 1, label: 'Press E on Aldric Storne and take the citadel\'s trade ledger', type: 'interact', target: 'Aldric Storne', count: 1, world: 'citadel' },
      { order: 2, label: 'Press E on Hafsa the Dyer — the cloth stall by the gate is the whole of Sunspire\'s export trade and she keeps its prices in her head', type: 'talk', target: 'Hafsa the Dyer', count: 1, world: 'citadel' },
      { order: 3, label: 'A ledger needs every counter on it. Press B at Rafiq the Keeper\'s — Archive & Physic — and buy the Trauma Twin-Pack for the health line', type: 'purchase', target: 'medkit', count: 1, world: 'citadel' },
      { order: 4, label: 'Then Bashir the Ostler\'s — Harness & Arms — for the Arrow Bundle. The citadel prices ammunition higher than anywhere in the Nexus and the hub needs to see it', type: 'purchase', target: 'arrow', count: 1, world: 'citadel' },
      { order: 5, label: 'Enter the coin line: recover 3 relic coin from the caches, since nothing here drops it', type: 'collect', target: 'relic_coin', count: 3, world: 'citadel' },
      { order: 6, label: 'Now the other half of a market. Press B, switch to the sell side, and sell 2 stacks back so the ledger shows the spread', type: 'purchase', target: 'sell', count: 2, world: 'citadel' },
      { order: 7, label: 'Press E on Bashir the Ostler and get the freight rate down the cliff road out of him', type: 'talk', target: 'Bashir the Ostler', count: 1, world: 'citadel' },
      { order: 8, label: 'Walk into the sky-gate at the cliff edge and press E', type: 'interact', target: 'station', count: 1, world: 'citadel' },
      { order: 9, label: 'Arrive on Aether Station and lodge the Sunspire ledger with the hub', type: 'visit', target: 'station', count: 1, world: 'station' },
    ],
  },

  {
    n: 40,
    world: 'citadel',
    line: 'The Sunspire Compact',
    title: 'Bind Sunspire, Aldermoor and the hub into one compact',
    credits: 6200,
    dur: 7200,
    pre: ['Salt, Cloth and Coin', 'The Aether Compact', 'Lord of the Vale'],
    notes:
      'Capstone, 10 steps, and the only quest in the game gated on all three worlds: it needs the citadel line "Salt, Cloth and Coin", the station line "The Aether Compact" and the MEDIEVAL line "Lord of the Vale" (quests/medieval.mjs n20). 10 steps and a real circuit — citadel, station, Aldermoor Vale, and home. Step 7 fires on `portal:entering` so it carries world:citadel; step 8 is credited on arrival in the vale; step 9 is the vale\'s own quest desk and must be `interact`, because a quest manager NEVER emits `talk` (HUD.js:1772-1776). It deliberately does NOT end on `visit citadel`: `accept()` credits a visit for the world the quest was taken in (QuestSystem.js:505-511), so that step would complete itself the moment the player accepted. It ends on Yusra instead, who watches everything and is the right person to be told it is done.',
    steps: [
      { order: 1, label: 'Press E on Aldric Storne and be given the compact and the citadel\'s seal', type: 'interact', target: 'Aldric Storne', count: 1, world: 'citadel' },
      { order: 2, label: 'Press E on Rafiq the Keeper — no compact leaves this rock without the archive knowing its wording', type: 'talk', target: 'Rafiq the Keeper', count: 1, world: 'citadel' },
      { order: 3, label: 'Sunspire signs in its own coin. Recover 3 relic coin from the terrace and tower caches', type: 'collect', target: 'relic_coin', count: 3, world: 'citadel' },
      { order: 4, label: 'And one nexus shard, so the far end knows the gate here still holds', type: 'collect', target: 'nexus_shard', count: 1, world: 'citadel' },
      { order: 5, label: 'Somebody would rather this was not signed. Destroy 5 sentinels on the approaches while the seal is being cut', type: 'kill', target: 'Sentinel', count: 5, world: 'citadel' },
      { order: 6, label: 'Hold the ward until it is: three unbroken minutes without taking a hit', type: 'survive', target: 'citadel', count: 6, world: 'citadel' },
      { order: 7, label: 'Step into the sky-gate at the cliff edge and press E', type: 'interact', target: 'station', count: 1, world: 'citadel' },
      { order: 8, label: 'Take the hub gateway on to Aldermoor Vale and arrive there carrying the compact', type: 'visit', target: 'medieval', count: 1, world: 'medieval' },
      { order: 9, label: 'Press E on Edmund Marsh at his stall on the Aldermoor market square and get the vale\'s mark beside the citadel\'s', type: 'interact', target: 'Edmund Marsh', count: 1, world: 'medieval' },
      { order: 10, label: 'Come the whole way home through the hub, climb to the inner ward and press E on Yusra the Falconer — she will have watched you come up the cliff road', type: 'talk', target: 'Yusra the Falconer', count: 1, world: 'citadel' },
    ],
  },
];

export default CITADEL_QUESTS;
