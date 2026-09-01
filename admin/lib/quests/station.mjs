/**
 * STATION quest content — 10 story + 10 education + 3 global mega-quests.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 *  READ `QUEST-AUDIT.md` AT THE REPO ROOT BEFORE YOU EDIT THIS FILE.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * The content this file replaces was 0-for-50: not one of the fifty seeded
 * quests could be completed, because ~150 target ids were invented by the
 * author and none of them existed anywhere in `src/`. A quest step is not
 * prose — it is a SUBSCRIPTION to an event the engine already emits. If the
 * engine never emits the thing you name, the step is dead and the quest that
 * contains it can never be finished by any player, ever.
 *
 * So: every `target` below was checked against the emitter that has to fire it.
 * Do not add a step whose target you have not looked up in the sources listed
 * here. Do not "improve" flavour by renaming a target.
 *
 * ── THE ONLY STEP TYPES WITH A WORKING EMITTER ───────────────────────────────
 *
 *  visit      `world:changed` → `QuestSystem._creditVisit`
 *             target = a world id: station | medieval | sports | citadel | race
 *             ⚠ NOT `maze`. `QuestSystem` bails out of the world:changed handler
 *               when `allows(world,'quests')` is false (QuestSystem.js:84) and
 *               MazeWorld sets `quests:false` (MazeWorld.js:314). A `visit maze`
 *               step can NEVER complete. Use `interact:maze` (the gateway) or
 *               `survive` scoped to `world:'maze'` instead — both still fire.
 *
 *  collect    `loot:collected` — the SINGLE canonical pickup event
 *             (Loot.js:605, :613). `QuestSystem._onCollect` is its only
 *             subscriber and advances the step by exactly ONE per event.
 *             target = a REAL item id from `src/systems/ItemDefs.js`:
 *               credits, bullet, arrow, fireball_charge, medkit,
 *               speed_boost_25/50/75/100, loot_magnet_30s, portal_ping_30s,
 *               npc_pause_5s/10s/30s/60s, shield_5s,
 *               firepower_boost_25/50/75/100, alloy_scrap, nexus_shard,
 *               relic_coin
 *             ⚠ `count` is a number of PICKUPS, not a number of items. The
 *               stack `qty` on the event is ignored, so a cache holding 8
 *               relic coin advances a relic_coin step by 1. Write counts as
 *               "how many times must the player stoop", and keep them small.
 *               (Loot.js used to emit `quest:activity{type:'collect'}` here as
 *               well and QuestSystem subscribed to both, so one pickup counted
 *               TWICE and every count in this file was an even number written
 *               at double value. That emit is gone; the counts are halved.)
 *             ⚠ One pickup emits one event PER ITEM LINE in it, so a cache
 *               with three lines credits three different collect steps at once.
 *             ⚠ Item availability is PER WORLD (`DROP_TABLES` in Loot.js,
 *               `CACHE_TABLES` in Caches.js). `relic_coin` does not drop on the
 *               station — it is medieval/citadel only. `alloy_scrap` is
 *               station/sports. Always scope a collect step with `world`.
 *               NOTE `DROP_TABLES` has no `citadel` entry at all and falls back
 *               to the station table, so in the citadel `relic_coin` comes from
 *               CACHES ONLY (`CACHE_TABLES.citadel`, 4-10 a cache). Keep any
 *               citadel relic_coin count at or below 3.
 *
 *  talk       `quest:activity{type:'talk'}` — HUD.js:1776, fired by `E` on a
 *  interact   friendly; quest managers emit `interact` instead (HUD.js:1773).
 *             target = an NPC NAME or ROLE. Roles: vendor, guard, loiterer,
 *             spectator, wanderer, lorekeeper, quest_manager.
 *             `interact` ALSO fires for portals (Portals.js:2830 and
 *             `QuestSystem._onPortalEntering`) with the destination world id —
 *             so `{type:'interact', target:'medieval', world:'station'}` means
 *             "step into the Ashfall Reach gateway". The step's `world` must be
 *             the world the player is LEAVING: `_worldId` has not changed yet
 *             when `portal:entering` fires.
 *             ⚠ `interact` on an NPC is ONLY valid for a quest manager. On any
 *               other NPC `E` emits `talk`, so `{type:'interact', target:'some
 *               vendor'}` is a dead step. And the converse: a quest manager
 *               NEVER emits `talk`, so `{type:'talk', target:'Zara Vex'}` is
 *               equally dead.
 *
 * ── WHO IS ACTUALLY STANDING ON THE STATION ──────────────────────────────────
 *
 * A name is not real because it is written down somewhere; it is real because
 * a body carrying it gets a slot. `NPCManager.spawnForWorld` walks
 * `world.npcSpawns` in order, stops at `authoredCap`, then spends what is LEFT
 * of `friendlyBudget` on the generic crowd (`_populateHubs`). The station
 * authors 42 civilians and takes 6 more for gateway lorekeepers against a
 * `friendlyBudget` of 50 (StationWorld.js:10466) — so the crowd filler is left
 * with TWO slots, and it fills them from `ROLE_ROTATION` in order.
 *
 *  QUEST MANAGERS (emit `interact`) — six on the station, all authored:
 *    Zara Vex               NPCManager.js:1373  (the per-world manager)
 *    Dispatcher Ovie Kanu   StationWorld.js:10390
 *    Officer Doriane Kest   station/zones/Habitation.js:212
 *    Meret Duhamel          station/zones/Gym.js:2096
 *    Purser Oleander Vance  station/zones/Canteen.js:2663
 *    Planner Imke Solberg   station/zones/Construction.js:3034
 *  Other worlds get exactly one each: Edmund Marsh (medieval), Petra Vance
 *  (sports), Aldric Storne (citadel), Kai Torres (race).
 *
 *  ROLES THAT EXIST HERE: vendor (9 authored), quest_manager (6), lorekeeper
 *  (6, one per gateway), wanderer (~29 — every authored friendly with no
 *  explicit role defaults to it, NPCManager.js:730), loiterer (1, crowd).
 *
 *  ⚠ ROLES THAT DO NOT EXIST HERE: `guard` and `spectator`. NOTHING on the
 *    station authors either (grep `role:` in StationWorld.js and
 *    station/zones/*.js — every one is vendor or quest_manager), and the crowd
 *    filler only reaches ROLE_ROTATION[0]=vendor and [1]=loiterer with its two
 *    slots. `{type:'talk', target:'guard'}` cannot fire on this world.
 *
 *  ⚠ FOR THE SAME REASON most of `ROLE_CAST.station` (NPCRoles.js:123) never
 *    appears. Those names are only ever handed out by the crowd filler, so only
 *    `Quartermaster Bex` (vendor #0) and `Dockhand Priya Kaur` (loiterer #0)
 *    can be spawned at all, and even those two depend on `_findStandingSpot`
 *    succeeding. `Broker Sunil Rai`, `Deck Warden Ilse` and `Warden Cato Reyes`
 *    need crowd slots 6, 3 and 9 and will never be reached. DO NOT TARGET THEM.
 *    Name people from `StationWorld.js` `_fillSpawns` instead — those are
 *    authored, they are first in `npcSpawns`, and they are therefore the only
 *    station civilians guaranteed a slot.
 *
 *  kill       `npc:killed`, hostiles only (QuestSystem.js:408)
 *  defend     `npc:killed` AND `npc:damaged`, hostiles only — one count per HIT
 *             landed, so defend counts are deliberately higher than kill counts.
 *             Station hostiles are four authored archetypes (StationWorld.js:
 *             10175-10196): 'Rogue Security Unit', 'Breaker Frame',
 *             'Skirmish Drone', 'Arc Lance Sentry'.
 *
 *  race       `race:finished` when `count === 1`; `race:lap` when `count > 1`.
 *             ⚠ A place-targeted step MUST use `count: 1` or it silently becomes
 *               a lap counter. target = circuit id (vellum | cinder | aurora,
 *               RaceCircuits.js:390/406/422) or place_1 / p1 / first / 1st.
 *               A DNF is filtered out (QuestSystem.js:435). Sports races are
 *               IMPOSSIBLE — SportsWorld publishes no track, `RaceManager.arm()`
 *               bails — never target them.
 *
 *  purchase   `market:trade` (Marketplace.js:434, 456, 481, 526)
 *             target = the granted item id (`pack_bullets`→`bullet`,
 *             `pack_medkit`→`medkit`, `pack_arrows`→`arrow`,
 *             `pack_embers`→`fireball_charge`), or the trade `kind`, which is
 *             literally `'buy'` or `'sell'` (QuestSystem.js:688 pushes
 *             `event.kind` as a candidate). `target:'sell'` is the ONLY way to
 *             track a sale, which the merchant tutorial needs.
 *             ⚠ BUYING is restricted by the vendor's `vendorCategories`, so a
 *               buy step must name a trader who stocks it: bullets need a
 *               'weapons' vendor (Ivo Selk on the strip), medkits a 'health'
 *               one (Oyo Tannen on the plaza). SELLING is unrestricted
 *               (Marketplace.sell has no category check) and emits one event
 *               per sell call, so `count: 2` means two sell actions.
 *
 *  customize  `character:changed` (PlayerAvatar.js:550)
 *             ⚠ The payload is `{config}` only — there is no `field`. Candidates
 *               are config VALUES, so target a real value, not a field name:
 *               outfit  = flightsuit|jumpsuit|tracksuit|sportskit|tunic|robe
 *                         (PlayerAvatar.js:179 OUTFITS)
 *               hairStyle = short|crop|buzz|ponytail|bun|long|bald
 *                         (PlayerAvatar.js:188 HAIR_STYLE_IDS)
 *               build   = slim|average|heavy (or build_0/1/2)
 *             ⚠ The whole config is offered every time, so targeting a value the
 *               player already wears completes on ANY change. `flightsuit` is
 *               the default outfit — only ask for it after something else has
 *               been put on.
 *
 *  survive    one count per 30 damage-free seconds (`SURVIVE_TICK_S`), credited
 *             in `QuestSystem.update()`, which is NOT rule-gated — so this is
 *             the one verb that still ticks inside the maze. target = world id.
 *             count 2 = one minute, count 6 = three minutes.
 *
 * ── NEVER USE THESE. THEY HAVE NO EMITTER AND CAN NEVER COMPLETE ─────────────
 *
 *      investigate    deliver    escort    stealth    craft
 *
 * There is no crafting system, no delivery mechanic, no escort AI and no stealth
 * meter. 53 of the old 184 steps used these. If a beat you want to write needs
 * one of them, pick the closest REAL trackable proxy and make the `label` honest
 * about the goal — the label is what the player reads, the type/target is only
 * what the engine watches.
 *
 * ── MATCHER NOTES ────────────────────────────────────────────────────────────
 *
 * `QuestSystem._matchesStepTarget` is ANCHORED: exact equality, or the shorter
 * string appearing as a run of WHOLE underscore-separated tokens inside the
 * longer one. So `medieval` matches the portal id `station->medieval`, and
 * `Bex` matches `Quartermaster Bex` — but a bare digit matches nothing. An
 * EMPTY target matches every event of that type; that is a legitimate "anything
 * counts" step, but every step below names something on purpose.
 *
 * ⚠ `_advanceSteps` walks EVERY step of the engagement on each event, so two
 *   steps in the same quest sharing a type, a target AND a world both advance
 *   from one action — which lets the player skip whatever was written between
 *   them. Give the two ends of a quest two different people (this is why the
 *   capstone starts at Ovie Kanu's board and finishes at Zara Vex's), or scope
 *   them to different worlds, which `step.world` already separates.
 *
 * ── KNOWN ENGINE LIMITATION AFFECTING THE GLOBAL QUESTS ──────────────────────
 *
 * Cross-world engagements survive a world change within a session (engagements
 * are held in `QuestSystem.engagements`, independently of `worldQuests`), but a
 * page RELOAD while standing in a foreign world restores the engagement with
 * `quest: null` because `_loadQuestsForWorld` only fetches that world's quests
 * (QuestSystem.js:370). Its steps then parse to `[]` and stop advancing. This is
 * open audit bug #7, not a content bug — the 201/202/203 quests below are
 * written as briefed and will need that fix to be reload-safe.
 *
 * ── SHAPE ────────────────────────────────────────────────────────────────────
 *
 * Matches `DEFAULT_QUESTS` in `admin/lib/db.ts` exactly:
 *   { n, world, line, title, credits, dur, pre, notes, steps: [...] }
 *   step: { order, label, type, target, count, world }
 *   `pre` holds quest_line NAMES, not numbers. `dur` is duration_minutes and a
 *   too-short timer AUTO-FAILS the quest, so it is generous throughout.
 *
 * Numbering: 1-10 story, 101-110 education, 201-203 global. Other worlds own
 * 11-50; never reuse those.
 */

export const STATION_QUESTS = [
  /* ══════════════════════════════════════════════════════════════════════════
   * A. STORY — Aether Station: the orbital hub. Concourse, cargo, gateways.
   * ══════════════════════════════════════════════════════════════════════════ */

  {
    n: 1,
    world: 'station',
    line: 'Signal Boost',
    title: 'Get the concourse beacon array back on the air',
    credits: 90,
    dur: 45,
    pre: null,
    notes:
      'Opening quest. 2 steps. Teaches nothing explicitly but forces the two actions every other station quest depends on: pressing E on the quest manager, and picking loot up off the deck.',
    steps: [
      { order: 1, label: 'Press E on Zara Vex at the concourse work board to take the beacon job', type: 'interact', target: 'Zara Vex', count: 1, world: 'station' },
      { order: 2, label: 'The array needs shielding plate — pick up 2 alloy scrap off the plaza decks (walk over it, or press E)', type: 'collect', target: 'alloy_scrap', count: 2, world: 'station' },
    ],
  },

  {
    n: 2,
    world: 'station',
    line: 'Cargo Manifest',
    title: 'Tally the incoming freight and sign the manifest off',
    credits: 150,
    dur: 90,
    pre: null,
    notes:
      '4 steps. Cargo-yard flavour. Every "count the containers" beat is grounded as a real item pickup, because there is no scanner emitter and never was. Both named NPCs are authored in StationWorld._fillSpawns and are therefore guaranteed a spawn slot — the ROLE_CAST quartermaster this step used to name is not.',
    steps: [
      { order: 1, label: 'Press E on Bex Corrado on the hangar deck and ask what came in on the freight lift', type: 'talk', target: 'Bex Corrado', count: 1, world: 'station' },
      { order: 2, label: 'Tally the salvage line: recover 3 alloy scrap from the cargo yard', type: 'collect', target: 'alloy_scrap', count: 3, world: 'station' },
      { order: 3, label: 'Tally the munitions line: recover 2 bullet drops from the same manifest', type: 'collect', target: 'bullet', count: 2, world: 'station' },
      { order: 4, label: 'Press E on Sparrow Nkemdi in the cargo yard and read the finished manifest back to her', type: 'talk', target: 'Sparrow Nkemdi', count: 1, world: 'station' },
    ],
  },

  {
    n: 3,
    world: 'station',
    line: 'Dock Worker',
    title: 'Clear the blocked freight corridor and restore the flow',
    credits: 280,
    dur: 120,
    pre: ['Signal Boost'],
    notes:
      '3 steps. First combat quest. Breaker Frames work the container alleys, where backing away puts a wall of freight behind you — that is the encounter design, so the label says so. Step 3 targets `wanderer` because the station has no `guard` role at all (see the header).',
    steps: [
      { order: 1, label: 'Two Breaker Frames have the alley shut. Destroy them — they carry shock batons and will close on you, so do not back into the stacks', type: 'kill', target: 'Breaker Frame', count: 2, world: 'station' },
      { order: 2, label: 'Haul the wreck out: collect 3 alloy scrap from the cleared corridor', type: 'collect', target: 'alloy_scrap', count: 3, world: 'station' },
      { order: 3, label: 'Press E on 2 of the dock crew to report the lane open', type: 'talk', target: 'wanderer', count: 2, world: 'station' },
    ],
  },

  {
    n: 4,
    world: 'station',
    line: 'Trade Route Scouting',
    title: 'Chart two live trade corridors out of the hub',
    credits: 460,
    dur: 240,
    pre: ['Cargo Manifest'],
    notes:
      '6 steps, first cross-world quest. Steps 2/4 fire on portal:entering and therefore carry world:station (the origin); steps 3/5 fire on arrival and carry the destination world.',
    steps: [
      { order: 1, label: 'Press E on Anselm Kade, the freight broker working the plaza with a folding terminal — he knows which corridors are paying', type: 'talk', target: 'Anselm Kade', count: 1, world: 'station' },
      { order: 2, label: 'Walk into the Ashfall Reach gateway on the plaza and press E to open the corridor', type: 'interact', target: 'medieval', count: 1, world: 'station' },
      { order: 3, label: 'Arrive in Ashfall Reach and log the corridor as live', type: 'visit', target: 'medieval', count: 1, world: 'medieval' },
      { order: 4, label: 'Come back to the station and step into the Sunspire Citadel gateway instead', type: 'interact', target: 'citadel', count: 1, world: 'station' },
      { order: 5, label: 'Arrive at Sunspire Citadel and log the second corridor', type: 'visit', target: 'citadel', count: 1, world: 'citadel' },
      { order: 6, label: 'Return to the station and press E on any trader to file the route pricing', type: 'talk', target: 'vendor', count: 1, world: 'station' },
    ],
  },

  {
    n: 5,
    world: 'station',
    line: 'Lost Traveller',
    title: 'Find out where the Bay 9 envoy went',
    credits: 70,
    dur: 30,
    pre: null,
    notes:
      'Deliberately a ONE-step quest — the old data never went below two. There is no escort AI, so the missing-envoy beat is grounded as what it actually is: asking people.',
    steps: [
      { order: 1, label: 'Work the concourse crowd: press E on 3 station locals and ask whether anyone saw the envoy leave Bay 9', type: 'talk', target: 'wanderer', count: 3, world: 'station' },
    ],
  },

  {
    n: 6,
    world: 'station',
    line: 'Contraband Sweep',
    title: 'Sweep the cargo bays for smuggled shard stock',
    credits: 400,
    dur: 180,
    pre: ['Dock Worker'],
    notes:
      '5 steps. nexus_shard is a 6% drop on the station table but caches carry 1-2 guaranteed (Caches.js), so one cache clears step 3 — and since the stack qty is ignored, one cache is exactly what count:1 asks for.',
    steps: [
      { order: 1, label: 'Press E on Prue Okonkwo, the gateway marshal on the plaza approach — she keeps the tally of who comes back through and who does not, and she has the bay list', type: 'talk', target: 'Prue Okonkwo', count: 1, world: 'station' },
      { order: 2, label: 'Turn the bays over: collect 4 alloy scrap from the container stacks', type: 'collect', target: 'alloy_scrap', count: 4, world: 'station' },
      { order: 3, label: 'Find the contraband itself — a nexus shard, hidden in a supply cache', type: 'collect', target: 'nexus_shard', count: 1, world: 'station' },
      { order: 4, label: 'The smugglers left guards. Destroy 2 Skirmish Drones — fast, jumpy, badly armed', type: 'kill', target: 'Skirmish Drone', count: 2, world: 'station' },
      { order: 5, label: 'Press E on Lt. Idris Fane at Traffic Control and hand the seized stock over', type: 'talk', target: 'Lt. Idris Fane', count: 1, world: 'station' },
    ],
  },

  {
    n: 7,
    world: 'station',
    line: 'Nexus Cartographer',
    title: 'Verify all five live gateways out of the hub',
    credits: 1030,
    dur: 720,
    pre: ['Trade Route Scouting', 'Contraband Sweep'],
    notes:
      '7 steps. Each gateway must actually be entered — every step fires on portal:entering, so all of them carry world:station. The player has to come home between each one, which is the point.',
    steps: [
      { order: 1, label: 'Every arch has a keeper beside it. Press E on one and ask what is on the far side', type: 'talk', target: 'lorekeeper', count: 1, world: 'station' },
      { order: 2, label: 'Verify gateway 1 — step into Ashfall Reach and press E', type: 'interact', target: 'medieval', count: 1, world: 'station' },
      { order: 3, label: 'Verify gateway 2 — step into the Meridian Athletic Complex and press E', type: 'interact', target: 'sports', count: 1, world: 'station' },
      { order: 4, label: 'Verify gateway 3 — step into Sunspire Citadel and press E', type: 'interact', target: 'citadel', count: 1, world: 'station' },
      { order: 5, label: 'Verify gateway 4 — step into Vellum Ridge and press E', type: 'interact', target: 'race', count: 1, world: 'station' },
      { order: 6, label: 'Verify gateway 5 — step into the Verdant Coil and press E', type: 'interact', target: 'maze', count: 1, world: 'station' },
      { order: 7, label: 'Press E on Zara Vex and file the verified gateway chart', type: 'interact', target: 'Zara Vex', count: 1, world: 'station' },
    ],
  },

  {
    n: 8,
    world: 'station',
    line: 'Station Saboteur',
    title: 'Break the crew turning station security against the decks',
    credits: 1210,
    dur: 1440,
    pre: ['Nexus Cartographer'],
    notes:
      '8 steps. Uses all four authored station hostile archetypes so the player has to fight in four different shapes: rifle at range, baton in the alleys, drone in the open, lance emplacement.',
    steps: [
      { order: 1, label: 'Press E on Lt. Idris Fane on the Traffic Control watch — security is compromised and he knows which units stopped answering', type: 'talk', target: 'Lt. Idris Fane', count: 1, world: 'station' },
      { order: 2, label: 'Destroy 4 Rogue Security Units — hijacked drones running corrupted enforcement code', type: 'kill', target: 'Rogue Security Unit', count: 4, world: 'station' },
      { order: 3, label: 'Destroy 3 Breaker Frames in the container alleys', type: 'kill', target: 'Breaker Frame', count: 3, world: 'station' },
      { order: 4, label: 'Destroy 3 Skirmish Drones on the open laydowns', type: 'kill', target: 'Skirmish Drone', count: 3, world: 'station' },
      { order: 5, label: 'Destroy 2 Arc Lance Sentries — the lance takes almost a second to charge, so keep moving', type: 'kill', target: 'Arc Lance Sentry', count: 2, world: 'station' },
      { order: 6, label: 'Strip the disruptor hardware: collect 4 alloy scrap from the wrecks', type: 'collect', target: 'alloy_scrap', count: 4, world: 'station' },
      { order: 7, label: 'Hold the deck for two minutes without taking a hit — sprint with Shift and break line of sight behind the freight', type: 'survive', target: 'station', count: 4, world: 'station' },
      { order: 8, label: 'Press E on Zara Vex and close the incident', type: 'interact', target: 'Zara Vex', count: 1, world: 'station' },
    ],
  },

  {
    n: 9,
    world: 'station',
    line: 'The Aether Compact',
    title: 'Broker a trade compact between the hub and two worlds',
    credits: 1510,
    dur: 2880,
    pre: ['Station Saboteur'],
    notes:
      '9 steps. Diplomacy has no emitter, so every "negotiate" beat is grounded on the keeper NPCs that actually stand beside each world gateway, plus a real medieval currency pickup as the good-faith payment. Steps 4 and 8 share a type and a target and are separated by their `world` — which is the only thing keeping one E press from clearing both.',
    steps: [
      { order: 1, label: 'Press E on Zara Vex to be given the compact and the hub seal', type: 'interact', target: 'Zara Vex', count: 1, world: 'station' },
      { order: 2, label: 'Step into the Ashfall Reach gateway and press E', type: 'interact', target: 'medieval', count: 1, world: 'station' },
      { order: 3, label: 'Arrive in Ashfall Reach', type: 'visit', target: 'medieval', count: 1, world: 'medieval' },
      { order: 4, label: 'Press E on the keeper beside the Ashfall gateway and put the compact to them', type: 'talk', target: 'lorekeeper', count: 1, world: 'medieval' },
      { order: 5, label: 'Ashfall wants payment in its own coin — collect 2 relic coin in Ashfall Reach', type: 'collect', target: 'relic_coin', count: 2, world: 'medieval' },
      { order: 6, label: 'Return to the station and step into the Sunspire Citadel gateway', type: 'interact', target: 'citadel', count: 1, world: 'station' },
      { order: 7, label: 'Arrive at Sunspire Citadel', type: 'visit', target: 'citadel', count: 1, world: 'citadel' },
      { order: 8, label: 'Press E on the keeper beside the Sunspire gateway and secure the second signature', type: 'talk', target: 'lorekeeper', count: 1, world: 'citadel' },
      { order: 9, label: 'Come home and press E on Dispatcher Ovie Kanu at the strip work board to lodge the signed compact', type: 'interact', target: 'Dispatcher Ovie Kanu', count: 1, world: 'station' },
    ],
  },

  {
    n: 10,
    world: 'station',
    line: 'Nexus Council Envoy',
    title: 'Carry the hub seat at the founding of the Nexus Council',
    credits: 2320,
    dur: 5760,
    pre: ['The Aether Compact'],
    notes:
      'Capstone, 10 steps — the longest step list in the station set. Step 7 is the maze objective: the maze credits NO visit (quests are disabled in it), but survive still ticks there, so the Verdant Coil is proved by surviving it rather than by entering it. The quest opens on Ovie Kanu and closes on Zara Vex; both ends used to name Zara Vex, and because `_advanceSteps` walks every step on each event, one E press cleared step 1 AND step 10 and the whole capstone in between could be skipped.',
    steps: [
      { order: 1, label: 'Press E on Dispatcher Ovie Kanu at the strip work board — the hub credentials are waiting in her ledger', type: 'interact', target: 'Dispatcher Ovie Kanu', count: 1, world: 'station' },
      { order: 2, label: 'Show the credentials in Ashfall Reach — travel there through the plaza gateway', type: 'visit', target: 'medieval', count: 1, world: 'medieval' },
      { order: 3, label: 'Show them at the Meridian Athletic Complex', type: 'visit', target: 'sports', count: 1, world: 'sports' },
      { order: 4, label: 'Show them at Sunspire Citadel', type: 'visit', target: 'citadel', count: 1, world: 'citadel' },
      { order: 5, label: 'Show them at Vellum Ridge', type: 'visit', target: 'race', count: 1, world: 'race' },
      { order: 6, label: 'The sixth seat is the Verdant Coil. Step into its gateway on the plaza and press E', type: 'interact', target: 'maze', count: 1, world: 'station' },
      { order: 7, label: 'Stay inside the Verdant Coil for two minutes without taking damage — no weapons, no mounts, no map but the one in your head', type: 'survive', target: 'maze', count: 4, world: 'maze' },
      { order: 8, label: 'Back on the station, the sabotage attempt comes at the summit. Land 6 hits on Rogue Security Units to break it up', type: 'defend', target: 'Rogue Security Unit', count: 6, world: 'station' },
      { order: 9, label: 'Recover the shard the saboteurs were paid with', type: 'collect', target: 'nexus_shard', count: 1, world: 'station' },
      { order: 10, label: 'Press E on Zara Vex and take the hub seat', type: 'interact', target: 'Zara Vex', count: 1, world: 'station' },
    ],
  },

  /* ══════════════════════════════════════════════════════════════════════════
   * B. EDUCATION — teach the game by doing it.
   *
   * The `label` is the lesson: it must name the KEY and the THING. The
   * type/target is only what the engine can watch. Where a taught action has no
   * emitter at all (summoning a mount, opening a panel, using a consumable) the
   * step rides the closest real proxy and the label stays honest about the goal.
   * ══════════════════════════════════════════════════════════════════════════ */

  {
    n: 101,
    world: 'station',
    line: 'Boot Camp: Moving Around',
    title: 'Learn to move: walk, sprint, crouch, jump, climb',
    credits: 60,
    dur: 60,
    pre: null,
    notes:
      'EDUCATION 1/10 — movement. Movement itself emits nothing, so each step is a pickup or a survival tick that CANNOT be reached without performing the movement named in the label.',
    steps: [
      { order: 1, label: 'W A S D walks. Hold Shift to sprint — it drains stamina. Run down the concourse and pick up 2 credit drops with E', type: 'collect', target: 'credits', count: 2, world: 'station' },
      { order: 2, label: 'C (or Ctrl) crouches, Space jumps. Stay on your feet for one minute without taking a hit — use cover, do not stand in the open', type: 'survive', target: 'station', count: 2, world: 'station' },
      { order: 3, label: 'Hold Space at a wall to climb it, and tap Space at a ledge to mantle up. Get onto the upper decks and bring back alloy scrap', type: 'collect', target: 'alloy_scrap', count: 1, world: 'station' },
    ],
  },

  {
    n: 102,
    world: 'station',
    line: 'The Panel Drill',
    title: 'Learn the panels: J, I, the Esc hub, T and E',
    credits: 130,
    dur: 90,
    pre: ['Boot Camp: Moving Around'],
    notes:
      'EDUCATION 2/10 — the Esc hub and its panels. Panels emit nothing when they OPEN, so steps 2 and 3 are tracked on `character:changed`, which only fires from inside the Character panel. Targets are real config VALUES (PlayerAvatar.js OUTFITS / HAIR_STYLE_IDS) — the payload carries no field name, so a field name would never match. `jumpsuit` is safe to ask for because `flightsuit` is the default, so it takes a real change to produce it.',
    steps: [
      { order: 1, label: 'J opens the quest board from anywhere, and Esc closes it. You can also walk up to Zara Vex and press E — do that now', type: 'interact', target: 'Zara Vex', count: 1, world: 'station' },
      { order: 2, label: 'Open the Esc menu and take Character. Change your outfit to the Jumpsuit', type: 'customize', target: 'jumpsuit', count: 1, world: 'station' },
      { order: 3, label: 'Still in Character: change your hair style to Ponytail. The Rebind keys row in the same menu is there if you would rather these keys were somewhere else', type: 'customize', target: 'ponytail', count: 1, world: 'station' },
      { order: 4, label: 'I opens your inventory and the 30-slot carry bag. Pick up a medkit and watch where it lands', type: 'collect', target: 'medkit', count: 1, world: 'station' },
      { order: 5, label: 'E starts a conversation with anyone friendly; T opens the comms box once you are talking. Press E on 2 station locals', type: 'talk', target: 'wanderer', count: 2, world: 'station' },
    ],
  },

  {
    n: 103,
    world: 'station',
    line: 'Mount Up',
    title: 'Learn the mounts: summon, ride, fly, dismount',
    credits: 190,
    dur: 90,
    pre: ['Boot Camp: Moving Around'],
    notes:
      'EDUCATION 3/10 — mounts. Summoning and mounting emit NOTHING trackable. Each step is therefore a pickup that is far easier mounted than on foot (step 3 is on the high decks, which is an air-mount job), with the wheel instructions in the label. Rooke Ilesanmi is authored in StationWorld._fillSpawns with vendorCategories ["mounts","tools"], so he is both guaranteed to spawn and the right trader for this lesson.',
    steps: [
      { order: 1, label: 'Mounts are bought at the tack shop at the far end of the strip. Press E on Rooke Ilesanmi and let him explain the rig', type: 'talk', target: 'Rooke Ilesanmi', count: 1, world: 'station' },
      { order: 2, label: 'Hold M for the mount wheel, aim at the Horse and release — or press 1-6 to pick straight off the wheel. Shift gallops. Ride the plaza and gather 3 credit drops', type: 'collect', target: 'credits', count: 3, world: 'station' },
      { order: 3, label: 'Hold M again and take the Dragon or the Eagle. Space climbs, Ctrl descends, the mouse steers. Bring back 2 alloy scrap from the high decks', type: 'collect', target: 'alloy_scrap', count: 2, world: 'station' },
      { order: 4, label: 'F dismounts. The Car, Bicycle and Hoverboard are on the same wheel — try them, then spend one minute on foot without taking damage', type: 'survive', target: 'station', count: 2, world: 'station' },
    ],
  },

  {
    n: 104,
    world: 'station',
    line: 'Weapons Free',
    title: 'Learn the weapons: four slots, ammo, aim and reload',
    credits: 280,
    dur: 120,
    pre: ['Boot Camp: Moving Around'],
    notes:
      'EDUCATION 4/10 — weapons and combat. One step per weapon slot, each against the station hostile archetype that weapon is actually good against. The bow step uses `defend` (fires on npc:damaged) so landing hits counts, not only killing. Step 1 names Ivo Selk because a bullet pack is a "weapons" category buy and he is the only plaza-side vendor who stocks it.',
    steps: [
      { order: 1, label: 'Stand near Ivo Selk at Selk Ordnance on the strip and press B to open the marketplace. Buy a bullet pack — that is where ammo comes from', type: 'purchase', target: 'bullet', count: 1, world: 'station' },
      { order: 2, label: 'R reloads, and it pulls from your bag. Keep it stocked: pick up 2 more bullet drops', type: 'collect', target: 'bullet', count: 2, world: 'station' },
      { order: 3, label: 'Press 1 for the machine gun. LMB fires, RMB aims down the sight, the mouse wheel cycles weapons. Destroy 2 Skirmish Drones', type: 'kill', target: 'Skirmish Drone', count: 2, world: 'station' },
      { order: 4, label: 'Press 2 for the ember caster and HOLD LMB to charge the fireball before you let go. Destroy 2 Rogue Security Units', type: 'kill', target: 'Rogue Security Unit', count: 2, world: 'station' },
      { order: 5, label: 'Press 4 for the sword — melee, no ammo, no reload. Let a Breaker Frame come to you and cut it down', type: 'kill', target: 'Breaker Frame', count: 1, world: 'station' },
      { order: 6, label: 'Press 3 for the recurve bow. Land 6 hits on Arc Lance Sentries — their lance charges for almost a second, so shoot and move', type: 'defend', target: 'Arc Lance Sentry', count: 6, world: 'station' },
    ],
  },

  {
    n: 105,
    world: 'station',
    line: 'Talk to Everyone',
    title: 'Learn to engage NPCs: who is who on the concourse',
    credits: 220,
    dur: 120,
    pre: ['The Panel Drill'],
    notes:
      'EDUCATION 5/10 — NPC chat. Mixes ROLE targets with authored NAMES so the player learns that both the job and the person are things a quest can name. Only the roles the station actually spawns are taught: vendor, lorekeeper, wanderer and quest_manager. The old step 2 taught `guard`, which no station NPC has — see the header. Steps 2 and 7 both teach quest managers and use `interact` because that is what E emits on one; they name DIFFERENT managers so a single press cannot clear both.',
    steps: [
      { order: 1, label: 'Traders sell and buy. Press E on 2 vendors — Oyo Tannen at the noodle stall and Anselm Kade on the plaza, Nell Abioye or Rooke Ilesanmi on the strip', type: 'talk', target: 'vendor', count: 2, world: 'station' },
      { order: 2, label: 'Not every work board is Zara Vex\'s. Press E on Dispatcher Ovie Kanu at the strip end of the concourse — quest managers open a board instead of a conversation, and this ring has six of them', type: 'interact', target: 'Dispatcher Ovie Kanu', count: 1, world: 'station' },
      { order: 3, label: 'Keepers stand beside the gateways and only talk about what is through their own arch. Press E on one', type: 'talk', target: 'lorekeeper', count: 1, world: 'station' },
      { order: 4, label: 'Everyone else is just station crew. Press E on 4 of them and see what they say back', type: 'talk', target: 'wanderer', count: 4, world: 'station' },
      { order: 5, label: 'Named people answer to their name. Press E on Marta Vale behind the bar at the Pale Horse', type: 'talk', target: 'Marta Vale', count: 1, world: 'station' },
      { order: 6, label: 'And press E on Rooke Ilesanmi at the tack shop', type: 'talk', target: 'Rooke Ilesanmi', count: 1, world: 'station' },
      { order: 7, label: 'Now the manager who runs the whole ring. Press E on Zara Vex at the concourse board', type: 'interact', target: 'Zara Vex', count: 1, world: 'station' },
    ],
  },

  {
    n: 106,
    world: 'station',
    line: 'Merchant Trade',
    title: 'Learn the marketplace: buying AND selling',
    credits: 260,
    dur: 90,
    pre: ['Talk to Everyone'],
    notes:
      "EDUCATION 6/10 — merchant buy and sell. Step 4 targets the trade KIND ('sell'), which `market:trade` carries and QuestSystem pushes as a candidate — it is the only way to prove a SALE rather than a purchase. Do not replace it with an item id. A medkit pack is a 'health' category buy, so step 2 names a trader who stocks one; selling has no category restriction at all.",
    steps: [
      { order: 1, label: 'Find a trader and get within a few metres — press E to talk first so you know who you are dealing with', type: 'talk', target: 'vendor', count: 1, world: 'station' },
      { order: 2, label: 'Now press B to open the marketplace. Buy the medkit pack from someone who stocks field remedies — Oyo Tannen on the plaza does. You cannot buy what your bag has no room for, so check I first', type: 'purchase', target: 'medkit', count: 1, world: 'station' },
      { order: 3, label: 'Salvage is what you SELL. Gather 3 alloy scrap off the decks', type: 'collect', target: 'alloy_scrap', count: 3, world: 'station' },
      { order: 4, label: 'Open the marketplace again (B) and switch to the sell side. Sell 2 stacks back — you get less than you paid, that is the spread', type: 'purchase', target: 'sell', count: 2, world: 'station' },
    ],
  },

  {
    n: 107,
    world: 'station',
    line: 'Bag and Store',
    title: 'Learn the inventory: the store, the 30-slot bag, consumables',
    credits: 240,
    dur: 90,
    pre: ['Merchant Trade'],
    notes:
      'EDUCATION 7/10 — inventory management. There is no emitter for moving an item between store and bag, nor for using a consumable, so those lessons ride the pickups and the sale that force the player to look at the panel.',
    steps: [
      { order: 1, label: 'Press I. You have a STORE and a 30-slot carry bag; only what is in the bag is reachable in the field. Buy a bullet pack (B at Ivo Selk on the strip) and watch it split', type: 'purchase', target: 'bullet', count: 1, world: 'station' },
      { order: 2, label: 'Ammo you pick up goes to the bag until it is full, then overflows to the store. Collect 3 more bullet drops and watch it happen', type: 'collect', target: 'bullet', count: 3, world: 'station' },
      { order: 3, label: 'Consumables are used from the bag — open I and click a medkit to spend it. Pick up a medkit and use it', type: 'collect', target: 'medkit', count: 1, world: 'station' },
      { order: 4, label: 'Bulk salvage eats slots fast. Collect 3 alloy scrap and see the bag fill', type: 'collect', target: 'alloy_scrap', count: 3, world: 'station' },
      { order: 5, label: 'A full bag refuses pickups. Sell 2 stacks you are not carrying for a reason (B at a trader, sell side) to make room again', type: 'purchase', target: 'sell', count: 2, world: 'station' },
    ],
  },

  {
    n: 108,
    world: 'station',
    line: 'Gateway Handbook',
    title: 'Learn the gateways: how travel between worlds works',
    credits: 420,
    dur: 240,
    pre: ['The Panel Drill'],
    notes:
      'EDUCATION 8/10 — portals and travel. Note which world each step carries: an `interact` on a gateway fires BEFORE the world changes, so it belongs to the world being LEFT (step 4 is world:medieval, not station).',
    steps: [
      { order: 1, label: 'Six arches ring the plaza and each one has a keeper beside it. Press E on a keeper and ask what is through their arch', type: 'talk', target: 'lorekeeper', count: 1, world: 'station' },
      { order: 2, label: 'Walk into the Ashfall Reach arch and press E. The screen warps and you are gone', type: 'interact', target: 'medieval', count: 1, world: 'station' },
      { order: 3, label: 'You are in Ashfall Reach. Your quests, bag and credits came with you', type: 'visit', target: 'medieval', count: 1, world: 'medieval' },
      { order: 4, label: 'Every world but the hub has exactly ONE gateway and it goes home. Find it and press E', type: 'interact', target: 'station', count: 1, world: 'medieval' },
      { order: 5, label: 'Back on Aether Station — the hub is the only place you can change destination', type: 'visit', target: 'station', count: 1, world: 'station' },
      { order: 6, label: 'Now take a different arch: step into the Meridian Athletic Complex and press E', type: 'interact', target: 'sports', count: 1, world: 'station' },
      { order: 7, label: 'Arrive at the Meridian Athletic Complex', type: 'visit', target: 'sports', count: 1, world: 'sports' },
      { order: 8, label: 'Last lesson: some worlds change the rules. Step into the Verdant Coil arch — it allows no weapons and no mounts, and M becomes a map instead of the mount wheel', type: 'interact', target: 'maze', count: 1, world: 'station' },
    ],
  },

  {
    n: 109,
    world: 'station',
    line: 'Field Medicine',
    title: 'Learn to stay alive: cover, stamina and medkits',
    credits: 150,
    dur: 60,
    pre: ['Boot Camp: Moving Around'],
    notes:
      'EDUCATION 9/10 — survival. Short quest, 2 steps. `survive` credits one count per 30 unbroken damage-free seconds and ANY hit resets the accumulator to zero, so count 6 really is three clean minutes.',
    steps: [
      { order: 1, label: 'Three minutes on the station without taking a single hit — any damage puts the timer back to zero. Sprint (Shift) to break line of sight, crouch (C) behind the freight', type: 'survive', target: 'station', count: 6, world: 'station' },
      { order: 2, label: 'Never travel without one. Pick up a medkit, then press I and click it to spend it — your health bar refills immediately', type: 'collect', target: 'medkit', count: 1, world: 'station' },
    ],
  },

  {
    n: 110,
    world: 'station',
    line: 'Graduation Circuit',
    title: 'Graduation: put every lesson together in one run',
    credits: 750,
    dur: 480,
    pre: [
      'Boot Camp: Moving Around',
      'The Panel Drill',
      'Mount Up',
      'Weapons Free',
      'Talk to Everyone',
      'Merchant Trade',
      'Bag and Store',
      'Gateway Handbook',
      'Field Medicine',
    ],
    notes:
      'EDUCATION 10/10 — assessment. Requires all nine other education lines. One step per taught system, in the order they were taught. Step 2 asks for the flight suit specifically because The Panel Drill put the player in a jumpsuit, so this is a real change back rather than a no-op.',
    steps: [
      { order: 1, label: 'Press E on Zara Vex to sit the assessment', type: 'interact', target: 'Zara Vex', count: 1, world: 'station' },
      { order: 2, label: 'Panels: open the Esc menu, take Character, and put the station flight suit back on for the record', type: 'customize', target: 'flightsuit', count: 1, world: 'station' },
      { order: 3, label: 'Trade: press B at Oyo Tannen on the plaza and buy a medkit pack', type: 'purchase', target: 'medkit', count: 1, world: 'station' },
      { order: 4, label: 'Movement and loot: gather 3 alloy scrap across the decks — mounted (M) if you want it done faster', type: 'collect', target: 'alloy_scrap', count: 3, world: 'station' },
      { order: 5, label: 'Combat: destroy 3 Rogue Security Units with any weapon slot you like', type: 'kill', target: 'Rogue Security Unit', count: 3, world: 'station' },
      { order: 6, label: 'Survival: two clean minutes afterwards, no damage taken', type: 'survive', target: 'station', count: 4, world: 'station' },
      { order: 7, label: 'Travel: step into the Vellum Ridge gateway and press E', type: 'interact', target: 'race', count: 1, world: 'station' },
      { order: 8, label: 'Arrive at Vellum Ridge', type: 'visit', target: 'race', count: 1, world: 'race' },
      { order: 9, label: 'Come home and press E on Dispatcher Ovie Kanu at the strip work board to be signed off', type: 'interact', target: 'Dispatcher Ovie Kanu', count: 1, world: 'station' },
    ],
  },

  /* ══════════════════════════════════════════════════════════════════════════
   * C. GLOBAL — multi-hour mega-quests that force travel to every world.
   *
   * Cross-world steps carry their own `world`, which can differ from the
   * quest's. See the reload caveat in the header: these are session-safe today.
   * ══════════════════════════════════════════════════════════════════════════ */

  {
    n: 201,
    world: 'station',
    line: 'Nexus Passport',
    title: 'Set foot in every world the Nexus connects',
    credits: 1270,
    dur: 2880,
    pre: ['Gateway Handbook', 'Nexus Cartographer'],
    notes:
      'GLOBAL 1/3. 10 steps, every world. The maze is the awkward one: it disables quests, so `world:changed` never credits a visit there — step 10 proves it with `survive`, which is the one verb whose tick is not rule-gated.',
    steps: [
      { order: 1, label: 'Start where every route starts: be on Aether Station with the passport open', type: 'visit', target: 'station', count: 1, world: 'station' },
      { order: 2, label: 'Step into the Ashfall Reach gateway and press E', type: 'interact', target: 'medieval', count: 1, world: 'station' },
      { order: 3, label: 'Stamp 1 of 5 — arrive in Ashfall Reach', type: 'visit', target: 'medieval', count: 1, world: 'medieval' },
      { order: 4, label: 'Return to the hub and step into the Meridian Athletic Complex gateway', type: 'interact', target: 'sports', count: 1, world: 'station' },
      { order: 5, label: 'Stamp 2 of 5 — arrive at the Meridian Athletic Complex', type: 'visit', target: 'sports', count: 1, world: 'sports' },
      { order: 6, label: 'Return to the hub and step into the Sunspire Citadel gateway', type: 'interact', target: 'citadel', count: 1, world: 'station' },
      { order: 7, label: 'Stamp 3 of 5 — arrive at Sunspire Citadel', type: 'visit', target: 'citadel', count: 1, world: 'citadel' },
      { order: 8, label: 'Return to the hub and step into the Vellum Ridge gateway', type: 'interact', target: 'race', count: 1, world: 'station' },
      { order: 9, label: 'Stamp 4 of 5 — arrive at Vellum Ridge', type: 'visit', target: 'race', count: 1, world: 'race' },
      { order: 10, label: 'Stamp 5 of 5 — the Verdant Coil issues no stamp to anyone who only walks in. Survive two unbroken minutes inside the maze', type: 'survive', target: 'maze', count: 4, world: 'maze' },
    ],
  },

  {
    n: 202,
    world: 'station',
    line: 'Circuit Crown',
    title: 'Race every circuit at Vellum Ridge and win one outright',
    credits: 1720,
    dur: 4320,
    pre: ['Nexus Passport', 'Nexus Council Envoy'],
    notes:
      'GLOBAL 2/3. 6 steps. Every race step is count:1 ON PURPOSE — QuestSystem routes count>1 race steps to `race:lap` instead of `race:finished`, which would turn step 5 into a lap counter and make the win untrackable. A DNF is filtered out at QuestSystem.js:435 so an abandoned run credits nothing. Sports has no publishable track, so no step here goes near it. Winning on a circuit clears that circuit\'s step and step 5 together — the same finish legitimately satisfies both.',
    steps: [
      { order: 1, label: 'Step into the Vellum Ridge gateway on the plaza and press E', type: 'interact', target: 'race', count: 1, world: 'station' },
      { order: 2, label: 'Circuit 1 of 3 — enter and finish a race on the Vellum Ridge Circuit', type: 'race', target: 'vellum', count: 1, world: 'race' },
      { order: 3, label: 'Circuit 2 of 3 — enter and finish a race at Cinder Gorge', type: 'race', target: 'cinder', count: 1, world: 'race' },
      { order: 4, label: 'Circuit 3 of 3 — enter and finish a race at Aurora Rise', type: 'race', target: 'aurora', count: 1, world: 'race' },
      { order: 5, label: 'Now win one. Cross the line FIRST in any circuit race — a did-not-finish does not count', type: 'race', target: 'place_1', count: 1, world: 'race' },
      { order: 6, label: 'Press E on Kai Torres at Vellum Ridge to have the crown recorded', type: 'interact', target: 'Kai Torres', count: 1, world: 'race' },
    ],
  },

  {
    n: 203,
    world: 'station',
    line: 'Shard Bearer',
    title: 'Gather the Nexus tribute from every world that will pay it',
    credits: 2740,
    dur: 10080,
    pre: ['Nexus Passport', 'Circuit Crown', 'The Aether Compact'],
    notes:
      'GLOBAL 3/3, the longest. 8 steps, a week of duration. Every collect step is world-scoped because the drop tables differ: relic_coin exists ONLY in medieval and citadel, alloy_scrap and nexus_shard on the station. A relic_coin step scoped to station would be uncompletable — that is exactly the class of mistake the audit found. Note that Loot.js has NO citadel drop table and falls back to the station one, so the citadel relic coin in step 5 comes from caches alone (CACHE_TABLES.citadel); count 3 is three cache lines, not three coins. Steps 1/4 and 3/5 pair the same target across two worlds, which `step.world` keeps apart.',
    steps: [
      { order: 1, label: 'Station tribute — recover a nexus shard from the station decks and caches', type: 'collect', target: 'nexus_shard', count: 1, world: 'station' },
      { order: 2, label: 'Station tribute — strip 5 alloy scrap out of the cargo yard', type: 'collect', target: 'alloy_scrap', count: 5, world: 'station' },
      { order: 3, label: 'Ashfall tribute — collect 3 relic coin in Ashfall Reach; they do not circulate anywhere else', type: 'collect', target: 'relic_coin', count: 3, world: 'medieval' },
      { order: 4, label: 'Ashfall tribute — find another nexus shard in the Ashfall caches', type: 'collect', target: 'nexus_shard', count: 1, world: 'medieval' },
      { order: 5, label: 'Sunspire tribute — collect 3 relic coin at Sunspire Citadel; nothing drops it there, so every one comes out of a cache', type: 'collect', target: 'relic_coin', count: 3, world: 'citadel' },
      { order: 6, label: 'Sunspire will not pay a courier who cannot survive the walk. Three unbroken minutes in the citadel without taking a hit', type: 'survive', target: 'citadel', count: 6, world: 'citadel' },
      { order: 7, label: 'Carrying that much tribute makes you a target. Break up the ambush on the station: destroy 5 Rogue Security Units', type: 'kill', target: 'Rogue Security Unit', count: 5, world: 'station' },
      { order: 8, label: 'Press E on Zara Vex and lay the whole tribute on the hub table', type: 'interact', target: 'Zara Vex', count: 1, world: 'station' },
    ],
  },
];

export default STATION_QUESTS;
