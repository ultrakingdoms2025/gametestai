/**
 * RACE quest content — 10 quests for Vellum Ridge (n 41-50).
 *
 * ─────────────────────────────────────────────────────────────────────────────
 *  READ `QUEST-AUDIT.md` AT THE REPO ROOT BEFORE YOU EDIT THIS FILE.
 *  `admin/lib/quests/station.mjs` is the reference for shape and rigour.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * THE TWO CONSTRAINTS THIS FILE EXISTS TO HONOUR:
 *
 *   ⚠⚠ 1. THERE ARE NO HOSTILES AT VELLUM RIDGE. ⚠⚠
 *
 * `RaceWorld.js` contains the string `hostile` exactly zero times. Its
 * `_buildSpawns` pushes six friendlies through one factory (RaceWorld.js:3250-
 * 3283) and nothing else; there is no `type: 'hostile'` entry, no beast group,
 * and `NPCManager.spawnForWorld` only ever creates a hostile from an
 * `npcSpawns` descriptor (NPCManager.js:714). `_populateHubs` makes friendlies
 * only. So `npc:killed` and `npc:damaged` never fire in this world, and a
 * `kill` or `defend` step scoped to `world:'race'` can never advance.
 *
 *   ⇒ THIS FILE CONTAINS ZERO `kill` AND ZERO `defend` STEPS.
 *
 *     `scripts/quest-vocab.mjs` USED TO ACCEPT ONE — it added the fallback name
 *     `sentinel` for every world whose `hostiles` rule was true, and RaceWorld
 *     overrides no rules, so the validator waved through a hostile the world
 *     could legally have and does not have. THAT BLIND SPOT IS NOW CLOSED:
 *     quest-vocab.mjs:1595 adds `sentinel` only where the world actually
 *     authors a NAMELESS hostile (`world.unnamedHostiles`), which is the
 *     citadel's ring of eight and nowhere else. `kill:sentinel` scoped to
 *     `race` is now rejected as `no-candidates` — race contributes no hostile
 *     names and no nameless ones, so the candidate set for `kill` is empty.
 *     The rule above still stands on its own merits; the validator now enforces
 *     it rather than leaving it to this comment.
 *
 *   ⚠⚠ 2. NOTHING DROPS LOOT HERE. CACHES ARE THE ONLY SOURCE. ⚠⚠
 *
 * There are exactly three ways `loot:collected` can fire, and only one of them
 * exists in this world:
 *   - `Loot._dropFor` on a kill (Loot.js:306) — needs a hostile. None here.
 *   - `Caches._stock` → `Loot.spawn` (Caches.js:394) — THIS is the one.
 *   - `inventory:drop` from the player's own bag (main.js:1465) — dropping and
 *     re-taking your own kit, which is not something content should ask for.
 * The circuit's own gold pickups are NOT loot: `Pickups.claim` emits
 * `race:pickup` (Pickups.js:187), which `QuestSystem` does not subscribe to,
 * and they pay credits at the flag rather than entering the bag at all.
 *
 * `DROP_TABLES` has no `race` entry and `CACHE_TABLES` has no `race` entry;
 * both fall back to their station table (Loot.js:309, Caches.js:374). The drop
 * table is therefore moot — nothing dies — and the cache table is what matters:
 *   CACHE_TABLES.station = alloy_scrap 3-7, nexus_shard 1-2, bullet 40-80,
 *   medkit 1-2 — two or three of those four lines per cache (Caches.js:66-72,
 *   :377).
 * ⇒ The ONLY collectable ids in this world are `alloy_scrap`, `nexus_shard`,
 *   `bullet` and `medkit`. There are NO `credits` in a cache (credits are added
 *   only by `Loot._dropFor`, Loot.js:314), and no `arrow`, `relic_coin` or
 *   `fireball_charge` anywhere. A `collect credits` step here would be dead.
 *
 * The site count: `Caches._onWorld` wants `PER_WORLD.sunken` = 3 and up to 12
 * `high` ones, scaled by world extent (Caches.js:52, :188). RaceWorld's bounds
 * are +/-660 (RaceWorld.js:1090, `HALF = 660` in RaceCircuits.js:55), so the
 * high count saturates at 12 — but there is no water anywhere in the world, so
 * `_findSunken` returns null every time and the sunken three are lost. Twelve
 * rooftop and gantry caches, restocking every 210 s, is the whole supply. Every
 * `collect` count below is therefore SMALL: 3 is the largest in the file.
 *
 * ── THE STEP TYPES THAT WORK IN THIS WORLD ───────────────────────────────────
 *
 *  visit      `world:changed` → `QuestSystem._creditVisit` (QuestSystem.js:517).
 *             target = `race`. `accept()` credits the current world through the
 *             same path, so a `visit race` step inside a race quest completes on
 *             accept. Used once, as an arrival beat, and the label says so.
 *
 *  collect    see the second constraint above. `count` is a number of PICKUPS —
 *             the stack `qty` is ignored, so a cache holding 80 rounds advances
 *             a `bullet` step by exactly 1.
 *
 *  talk       `quest:activity{type:'talk'}` — HUD.js:1776, on `E` at any
 *             friendly that is not a quest manager. target = NPC NAME or ROLE.
 *
 *  interact   HUD.js:1773 (quest managers ONLY) and Portals.js:2830 +
 *             `portal:entering` (QuestSystem.js:482) for the gateway.
 *             ⚠ This world has exactly ONE quest manager, Kai Torres
 *               (NPCManager.js:1400-1406). Nothing in `RaceWorld.js` sets
 *               `isQuestManager`. The only OTHER interact target is the gateway
 *               home: `{type:'interact', target:'station', world:'race'}`.
 *               A quest wanting two interact beats must pair the two.
 *
 *  race       `race:finished` when `count === 1`; `race:lap` when `count > 1`
 *             (QuestSystem.js:437, :447).
 *             ⚠ A step about a RESULT must use `count: 1`. `count > 1` routes to
 *               `race:lap` and silently becomes a lap counter — the old data's
 *               `champ_main_race` mistake in a different costume.
 *             VALID TARGETS, and only these:
 *               circuit id    `vellum` | `cinder` | `aurora`
 *                             (RaceCircuits.js:390, :406, :422)
 *               circuit name  `Vellum Ridge Circuit` | `Cinder Gorge` |
 *                             `Aurora Rise` — same lines
 *               race type     `car` | `dragon` (RACE_TYPES,
 *                             RaceManager.js:59; pushed as a candidate at
 *                             QuestSystem.js:664, carried on both
 *                             `race:finished` (:1287) and `race:lap` (:1159))
 *               placing       `place_1` | `p1` | `1st` | `first`
 *                             (QuestSystem.js:676-680) — namespaced, never the
 *                             bare integer, and only offered when place > 0, so
 *                             a DNF cannot satisfy one.
 *             ⚠ A DNF is filtered out at QuestSystem.js:435, so an abandoned run
 *               credits nothing at all.
 *             ⚠ ONE FINISH SATISFIES EVERY MATCHING STEP. The payload carries
 *               the circuit id, the race type AND the placing at once, so a
 *               dragon race won at Cinder Gorge advances a `cinder` step, a
 *               `dragon` step and a `place_1` step together. That is used on
 *               purpose below and the labels say so. Where two steps must NOT
 *               collapse into one race, they are `car` against `dragon` — a run
 *               is one or the other and can never be both.
 *             ⚠ RINGS ARE NOT A QUEST OBJECTIVE. `race:ring`
 *               (RaceManager.js:1130) fires for the dragon race's gates, but
 *               `QuestSystem` has no subscription to it and `_onActivity` only
 *               forwards `quest:activity`. A "fly through N rings" step cannot
 *               be written. Ask for a dragon FINISH instead and describe the
 *               rings in the label, which is what quest 48 does.
 *
 *  purchase   `market:trade` (Marketplace.js:434, 456, 481, 526).
 *             ⚠ BUYING IS GATED. This world's only trader is Ines Okonjo in the
 *               garage-four tyre bay, authored with
 *               `vendorCategories: ['mounts', 'tools']` (RaceWorld.js:3260-3266)
 *               and `Marketplace._readVendorCategories` narrows the shop to
 *               exactly that (Marketplace.js:657-666). There is not a single
 *               `tools` item in the catalogue, so the shop here is the `mounts`
 *               category alone: the five race-only car liveries
 *               (`cosmetic_car_*`, marketplaceCatalog.ts:667-745, `worlds:
 *               ['race']`) and the mount strength/shield/power tiers, cheapest
 *               260 CR. There are NO ammo packs, NO medkit packs and NO spells
 *               on sale at Vellum Ridge.
 *             ⇒ A buy step here targets the trade KIND `'buy'`
 *               (QuestSystem.js:688 pushes `event.kind`), never `bullet` or
 *               `medkit` — those are not stocked and the step would be dead.
 *               `'sell'` is safe: `Marketplace.sell` has no category check at
 *               all, and emits one event per sell call.
 *
 *  customize  `character:changed` (PlayerAvatar.js:550). Payload is `{config}`
 *             with no field name, so the target is a config VALUE: headgear
 *             `helm` (Humanoid.js:3460), build `slim`/`heavy`
 *             (QuestSystem.js:704). Neither is a `DEFAULT_CHARACTER` value
 *             (PlayerAvatar.js:204-219: headgear `none`, build 1 = average), so
 *             each one takes a real edit rather than completing on any change.
 *
 *  survive    one count per 30 unbroken damage-free seconds (`SURVIVE_TICK_S`,
 *             QuestSystem.js:31), credited in `update()`. Nothing here shoots at
 *             the player, so a survive step at Vellum Ridge is really about not
 *             putting the car into the barriers — which is exactly what the
 *             labels say. count 2 = one clean minute, count 6 = three.
 *
 * ── NEVER USE THESE. THEY HAVE NO EMITTER AND CAN NEVER COMPLETE ─────────────
 *
 *      investigate    deliver    escort    stealth    craft
 *
 * Plus, in THIS world only: `kill` and `defend`. See the top of this header.
 *
 * ── WHO IS ACTUALLY STANDING AT VELLUM RIDGE ─────────────────────────────────
 *
 * `NPCManager.spawnForWorld` (NPCManager.js:605) walks `world.npcSpawns` in
 * order, stops friendlies at `authoredCap`, adds one lorekeeper per portal,
 * adds the quest manager, then spends what is LEFT of `friendlyBudget` on the
 * crowd. RaceWorld sets no budgets, so the engine defaults apply:
 * `maxFriendlies = max(CONFIG.npc.friendlyCount, 30) = 30` (NPCManager.js:492),
 * `maxNPCs = 72`.
 *
 *   authored friendlies   6   RaceWorld.js:3250-3283
 *   authored hostiles     0   there are none — see the first constraint
 *   friendlyBudget       30   min(72 - 10, 30)
 *   authoredCap           6   max(4, min(6, 30 - CROWD_RESERVE 6))  → all six spawn
 *   lorekeepers           1   one per portalSpec, and there is one portal
 *   crowd slots          23   friendlyBudget - (6 + 1)
 *
 *  AUTHORED CIVILIANS — guaranteed a slot, and therefore the only names below:
 *    Marek Vaisey      RaceWorld.js:3251   chief scrutineer, paddock
 *    Ines Okonjo       RaceWorld.js:3260   tyre bay, garage four — role
 *                                          `vendor`, the world's ONLY trader
 *    Devrim Aslan      RaceWorld.js:3267   track marshal, ridge sector
 *    Halla Brandt      RaceWorld.js:3268   timekeeper, the gantry
 *    Petra Halvorsen   RaceWorld.js:3275   runs Cinder Gorge
 *    Tobias Renn       RaceWorld.js:3280   loop marshal, Aurora Rise
 *  Only Ines declares a `role:`; the other five default to `ROLE.WANDERER`
 *  (NPCManager.js:730). Petra Halvorsen and Tobias Renn are authored inside
 *  `if (gorge)` / `if (rise)` guards, but both circuits are unconditional
 *  entries in `CIRCUITS` (RaceCircuits.js:406, :422) so both lookups resolve.
 *
 *  QUEST MANAGER: Kai Torres, NPCManager.js:1400-1406, planted at (30, 0.2, 20)
 *  — in the paddock, a short walk from the grid. Emits `interact`, never `talk`.
 *
 *  LOREKEEPER: one, beside the Aether Station arch, from `_spawnLorekeepers`
 *  (NPCManager.js:1303-1354, role set at :1342). Its NAME is generated from the
 *  gateway sign, so target the ROLE, never a name.
 *
 *  ⚠ THE STATION CAST SPAWNS HERE, AND IT IS STILL NOT USED. `ROLE_CAST` has NO
 *    `race` key and `THEME_BY_WORLD` has no `race` key either
 *    (NPCRoles.js:123-291, NPCManager.js:261-263), so `this.theme` falls back to
 *    `'station'` and the crowd filler hands out station names —
 *    `Quartermaster Bex`, `Dockhand Priya Kaur`, `Deck Warden Ilse` and the
 *    rest. With 23 crowd slots here (against the station's own two) most of
 *    them really do appear, which is why an earlier inventory audit found
 *    Quartermaster Bex standing at a race circuit. They are STILL not targeted
 *    below: a crowd name depends on `_findStandingSpot` succeeding for its
 *    particular rotation index, whereas an authored name is walked before the
 *    filler runs at all. Six authored people and two roles are enough.
 *
 *  ROLES THAT ARE SAFE HERE: `wanderer` (five authored bodies), `vendor` (Ines,
 *  authored, plus the crowd's rotation-index-0 vendor), `lorekeeper` (one),
 *  `quest_manager` (Kai Torres). `guard` and `spectator` exist only if the
 *  crowd filler reaches rotation indices 2 and 3, so they are not used.
 *
 * ── MATCHER NOTES ────────────────────────────────────────────────────────────
 *
 * `QuestSystem._matchesStepTarget` (QuestSystem.js:602) is ANCHORED: exact
 * equality, or the shorter string appearing as a run of WHOLE
 * underscore-separated tokens inside the longer. `station` therefore matches
 * the portal id `race->station`, and `vellum` matches `Vellum Ridge Circuit`.
 * A bare digit matches nothing, which is why placings are `place_1` and not `1`.
 *
 * ⚠ `_advanceSteps` (QuestSystem.js:547) walks EVERY step of the engagement on
 *   each event. No quest below repeats a (type, target) pair, and the two
 *   `interact` ends of a quest are always Kai Torres at one end and the gateway
 *   at the other.
 *
 * ⚠ `Petra Halvorsen` here and `Petra Vance` in sports do not collide:
 *   [petra, halvorsen] is not a contiguous run inside [petra, vance] or the
 *   other way round, and the two are in different worlds regardless.
 *
 * ── EVERY STEP STAYS IN ITS OWN WORLD ────────────────────────────────────────
 *
 * Cross-world linkage is expressed through `pre` (quest_line names, enforced
 * globally on accept by `findMissingPrerequisites`, playerDb.ts:546) and NEVER
 * through a step whose `world` differs from the quest's. A foreign-world step
 * only advances while the player is standing in that world, but the quest is
 * only listed on the race board — and a page reload in a foreign world restores
 * the engagement with `quest: null` (open audit bug #7).
 *
 * Station prerequisites used here, all real quest_line names from
 * `admin/lib/quests/station.mjs`: `Merchant Trade`, `Mount Up`,
 * `Gateway Handbook`, `Circuit Crown`.
 *
 * ── SHAPE ────────────────────────────────────────────────────────────────────
 *
 * Matches `DEFAULT_QUESTS` in `admin/lib/db.ts` exactly:
 *   { n, world, line, title, credits, dur, pre, notes, steps: [...] }
 *   step: { order, label, type, target, count, world }
 *   `pre` holds quest_line NAMES, not numbers. `dur` is duration_minutes and a
 *   too-short timer AUTO-FAILS the quest, so it is generous throughout — a
 *   race is a five-lap commitment plus the drive to the circuit.
 *
 * Numbering: 41-50. Station owns 1-10 / 101-110 / 201-203, medieval 11-20,
 * sports 21-30, citadel 31-40. Never reuse those.
 */

export const RACE_QUESTS = [
  /* ══════════════════════════════════════════════════════════════════════════
   * Vellum Ridge — one landscape carrying three circuits you can drive between.
   *   vellum  Vellum Ridge Circuit, coastal: a ridge line, a long descent and
   *           two city blocks with no run-off. 3/5/10 laps by difficulty.
   *   cinder  Cinder Gorge, quarry: two chicanes, a hairpin and a crested rim
   *           with five metres of run-off. The tightest of the three.
   *   aurora  Aurora Rise, highland: a climb to the summit, a plunge off the
   *           back of it, and a vertical loop on the west straight that every
   *           lap has to go over the top of.
   * The paddock, the pit lane and the timing gantry are all on Vellum's main
   * straight; the other two circuits have a timing box and a marshal each.
   * ══════════════════════════════════════════════════════════════════════════ */

  {
    n: 41,
    world: 'race',
    line: 'Paddock Pass',
    title: 'Collect a paddock pass and get your name on the board',
    credits: 80,
    dur: 45,
    pre: null,
    notes:
      'Opening quest, 2 steps. Teaches the two actions every other race quest needs: arriving through the gateway, and pressing E on the one quest manager this world has. Step 1 completes on accept if the player is already standing here — `accept()` credits the current world through the same `_creditVisit` path (QuestSystem.js:517) — which is correct for an "you are here" beat, so the label says logged rather than travel.',
    steps: [
      { order: 1, label: 'Arrive at Vellum Ridge — the paddock gate logs you the moment you step off the gantry road', type: 'visit', target: 'race', count: 1, world: 'race' },
      { order: 2, label: 'Press E on Kai Torres at the mission board in the paddock and take a pass', type: 'interact', target: 'Kai Torres', count: 1, world: 'race' },
    ],
  },

  {
    n: 42,
    world: 'race',
    line: 'Green Flag',
    title: 'Start a race at Vellum Ridge and take the flag',
    credits: 220,
    dur: 90,
    pre: null,
    notes:
      'Deliberately a ONE-step quest — the old race data never went below two, and a single finished race is the shortest honest thing this world can ask for. `count: 1` is mandatory here: `_onRaceFinished` only looks at steps with count 1 (QuestSystem.js:437), and a count above 1 would silently become a lap counter instead. A DNF is filtered out at QuestSystem.js:435, so the player has to actually see the flag.',
    steps: [
      { order: 1, label: 'Open the race panel, pick the Vellum Ridge Circuit and finish the race. Abandoning it does not count — you have to take the flag, whatever place you take it in', type: 'race', target: 'vellum', count: 1, world: 'race' },
    ],
  },

  {
    n: 43,
    world: 'race',
    line: 'Tyre Bay Account',
    title: 'Open an account with the tyre bay in garage four',
    credits: 320,
    dur: 180,
    pre: ['Merchant Trade'],
    notes:
      '3 steps. CROSS-WORLD PREREQUISITE: the station education line `Merchant Trade` teaches B, the buy side and the sell side. Ines Okonjo is the ONLY trader in this world and she is scoped to `mounts` + `tools` (RaceWorld.js:3263) — and the catalogue has no `tools` items at all, so her stock is liveries and mount upgrades, cheapest 260 CR. This quest therefore teaches the SELL side, which is ungated (`Marketplace.sell` has no category check) and is how a driver funds a livery. The buy is held back to quest 49, by which point the player can afford one.',
    steps: [
      { order: 1, label: 'Press E on Ines Okonjo in the garage-four tyre bay — she reads a set of worn fronts like a paragraph, and she is the only counter on this site', type: 'talk', target: 'Ines Okonjo', count: 1, world: 'race' },
      { order: 2, label: 'Bring her something to weigh in: recover 2 alloy scrap from the supply caches. They sit on the roofs and gantries, so you will need to climb or fly to them', type: 'collect', target: 'alloy_scrap', count: 2, world: 'race' },
      { order: 3, label: 'Press B at her counter and switch to the sell side. Sell 2 stacks — the tyre bay buys anything metal, whatever it does not stock', type: 'purchase', target: 'sell', count: 2, world: 'race' },
    ],
  },

  {
    n: 44,
    world: 'race',
    line: 'Sector Marshals',
    title: 'Report to the marshal at every sector on every circuit',
    credits: 420,
    dur: 240,
    pre: ['Paddock Pass'],
    notes:
      '4 steps, and the quest that makes the player learn the MAP rather than one lap of it. All three circuits stand in the world at once, 500 m apart, and you drive between them (RaceWorld.js class header) — so four named marshals at four posts is four separate journeys. Every name is authored in `_buildSpawns` and therefore guaranteed a slot; each is a different literal, so one E press advances exactly one step.',
    steps: [
      { order: 1, label: 'Press E on Devrim Aslan trackside in the ridge sector — he knows exactly where the circuit bites', type: 'talk', target: 'Devrim Aslan', count: 1, world: 'race' },
      { order: 2, label: 'Press E on Halla Brandt up in the timing gantry above the main straight. She speaks in tenths and does not exaggerate', type: 'talk', target: 'Halla Brandt', count: 1, world: 'race' },
      { order: 3, label: 'Drive out to Cinder Gorge and press E on Petra Halvorsen at her timing box — she blasted half that quarry herself and knows which bench moves', type: 'talk', target: 'Petra Halvorsen', count: 1, world: 'race' },
      { order: 4, label: 'Carry on to Aurora Rise and press E on Tobias Renn below the loop. Four thousand cars over the top and he can pick the ones that will not make it by engine note', type: 'talk', target: 'Tobias Renn', count: 1, world: 'race' },
    ],
  },

  {
    n: 45,
    world: 'race',
    line: 'Learning the Ridge',
    title: 'Put in the laps until the ridge line is muscle memory',
    credits: 560,
    dur: 300,
    pre: ['Green Flag'],
    notes:
      '5 steps. Step 2 is the file\'s first deliberate `count > 1` race step: above 1 the engine routes it to `race:lap` (QuestSystem.js:447) and counts LAPS, which is exactly what a practice objective wants. `race:lap` is guarded on `isPlayer` (:446) so a nine-car field no longer credits nine laps for one of the player\'s. Vellum runs 3 laps on easy and 5 on standard (RaceCircuits.js:397), so three laps is one race at any setting.',
    steps: [
      { order: 1, label: 'Press E on Marek Vaisey in the paddock — thirty years of timing this circuit, and he will tell you where the lap is actually won', type: 'talk', target: 'Marek Vaisey', count: 1, world: 'race' },
      { order: 2, label: 'Complete 3 laps of the Vellum Ridge Circuit. Only your own laps count, and they add up across races — you do not have to do all three in one go', type: 'race', target: 'vellum', count: 3, world: 'race' },
      { order: 3, label: 'Pick up 2 alloy scrap from the caches on the pit roofs while the tyres cool', type: 'collect', target: 'alloy_scrap', count: 2, world: 'race' },
      { order: 4, label: 'Spend one clean minute on site without taking damage — nothing here shoots at you, so this is about not putting it into the barriers', type: 'survive', target: 'race', count: 2, world: 'race' },
      { order: 5, label: 'Press E on Kai Torres and have the practice session signed off', type: 'interact', target: 'Kai Torres', count: 1, world: 'race' },
    ],
  },

  {
    n: 46,
    world: 'race',
    line: 'Three Circuits',
    title: 'Finish a race on all three Vellum Ridge circuits',
    credits: 950,
    dur: 720,
    pre: ['Learning the Ridge', 'Sector Marshals'],
    notes:
      '6 steps. Steps 1-3 are all `count: 1` ON PURPOSE — count > 1 would route them to `race:lap` and a "finish a race here" objective would silently become a lap counter. Each names a different circuit id and `race:finished` carries exactly one `circuitId` (RaceManager.js:1285), so a finish at Cinder cannot advance the Aurora step. A DNF is filtered out at QuestSystem.js:435, so all three have to be seen through to the flag.',
    steps: [
      { order: 1, label: 'Circuit 1 of 3 — finish a race on the Vellum Ridge Circuit: the ridge line, the long descent, and two city blocks with no run-off at all', type: 'race', target: 'vellum', count: 1, world: 'race' },
      { order: 2, label: 'Circuit 2 of 3 — finish a race at Cinder Gorge: two chicanes, a hairpin and a crested rim with five metres of run-off. Carry the climb or lose the lap on the descent', type: 'race', target: 'cinder', count: 1, world: 'race' },
      { order: 3, label: 'Circuit 3 of 3 — finish a race at Aurora Rise: a climb to the summit, a plunge off the back, and a vertical loop on the west straight that every lap has to go over the top of', type: 'race', target: 'aurora', count: 1, world: 'race' },
      { order: 4, label: 'Restock the car\'s first-aid box: recover a medkit from one of the rooftop caches', type: 'collect', target: 'medkit', count: 1, world: 'race' },
      { order: 5, label: 'One clean minute on site between rounds, no damage taken', type: 'survive', target: 'race', count: 2, world: 'race' },
      { order: 6, label: 'Press E on Kai Torres and enter all three results on the board', type: 'interact', target: 'Kai Torres', count: 1, world: 'race' },
    ],
  },

  {
    n: 47,
    world: 'race',
    line: 'City Block',
    title: 'Master the street section that runs through the city blocks',
    credits: 1120,
    dur: 1440,
    pre: ['Three Circuits', 'Gateway Handbook'],
    notes:
      '7 steps. CROSS-WORLD PREREQUISITE: `Gateway Handbook` is the station education line that teaches how the arches work, and step 7 sends the player back through this world\'s only arch. Step 5 is a five-lap `count > 1` step, which is a full standard-difficulty race at Vellum (RaceCircuits.js:397). Steps 1 and 7 are both about people but only step 7 is an `interact` — the gateway, not Kai Torres — so nothing here can be cleared twice by one press. `helm` is a real change: the default headgear is `none`.',
    steps: [
      { order: 1, label: 'Press E on Devrim Aslan in the ridge sector and get the street-section briefing before you drive it in anger', type: 'talk', target: 'Devrim Aslan', count: 1, world: 'race' },
      { order: 2, label: 'Open the Esc menu, take Character, and put a Helm on. The city blocks have no run-off — that is not decoration', type: 'customize', target: 'helm', count: 1, world: 'race' },
      { order: 3, label: 'The rooftop caches above the blocks are the easiest ones to reach on this circuit. Recover 2 bullet drops from them', type: 'collect', target: 'bullet', count: 2, world: 'race' },
      { order: 4, label: 'And 2 alloy scrap from the same roofs', type: 'collect', target: 'alloy_scrap', count: 2, world: 'race' },
      { order: 5, label: 'Complete 5 laps of Vellum Ridge — a full standard-difficulty race. The blocks come at the end of the descent, when the tyres are already gone', type: 'race', target: 'vellum', count: 5, world: 'race' },
      { order: 6, label: 'Two clean minutes on site without taking a hit, walls included', type: 'survive', target: 'race', count: 4, world: 'race' },
      { order: 7, label: 'Walk into the Aether Station arch by the paddock and press E — the street-section notes are filed at the hub', type: 'interact', target: 'station', count: 1, world: 'race' },
    ],
  },

  {
    n: 48,
    world: 'race',
    line: 'Dragon Line',
    title: 'Fly the dragon race and then drive the same road on wheels',
    credits: 1300,
    dur: 2880,
    pre: ['Three Circuits', 'Mount Up'],
    notes:
      '8 steps. CROSS-WORLD PREREQUISITE: `Mount Up` is the station education line that teaches the mount wheel and flight, and a dragon race is that lesson under a clock. Steps 3 and 4 target the RACE TYPE rather than a circuit, which `race:finished` carries as `raceType` (RaceManager.js:1287) and `_eventTargetCandidates` pushes at QuestSystem.js:664. They are the one pair in this file that provably CANNOT be satisfied by a single race: a run is `car` or `dragon`, never both (RaceManager.js:315). RINGS DELIBERATELY ARE NOT AN OBJECTIVE — `race:ring` (RaceManager.js:1130) has no subscriber in QuestSystem, so a ring count could never advance; the label describes them instead.',
    steps: [
      { order: 1, label: 'Press E on Kai Torres and ask for the dragon entry. It is the same circuit, flown fifteen metres up through a line of rings instead of driven', type: 'interact', target: 'Kai Torres', count: 1, world: 'race' },
      { order: 2, label: 'Press E on Halla Brandt in the gantry — she times the flown laps too, and she will tell you how much the rings cost a sloppy line', type: 'talk', target: 'Halla Brandt', count: 1, world: 'race' },
      { order: 3, label: 'Pick DRAGON in the race panel and finish a dragon race. Space climbs, Ctrl descends, and every ring on the course is a gate you have to go through', type: 'race', target: 'dragon', count: 1, world: 'race' },
      { order: 4, label: 'Now finish a CAR race on the same site. This cannot be the same run as the last step — a race is flown or driven, never both', type: 'race', target: 'car', count: 1, world: 'race' },
      { order: 5, label: 'Only a flying mount reaches the highest caches. Recover a nexus shard from one', type: 'collect', target: 'nexus_shard', count: 1, world: 'race' },
      { order: 6, label: 'And bring a medkit down with you', type: 'collect', target: 'medkit', count: 1, world: 'race' },
      { order: 7, label: 'Two clean minutes on site with no damage — a dragon that clips the ridge takes the hit for you', type: 'survive', target: 'race', count: 4, world: 'race' },
      { order: 8, label: 'Press E on Tobias Renn at Aurora Rise and have the flown time countersigned under the loop', type: 'talk', target: 'Tobias Renn', count: 1, world: 'race' },
    ],
  },

  {
    n: 49,
    world: 'race',
    line: 'Ridge Record',
    title: 'Put a full race distance on every circuit in the book',
    credits: 1720,
    dur: 4320,
    pre: ['City Block', 'Dragon Line'],
    notes:
      '9 steps. The endurance quest. Steps 2-4 are `count > 1` lap counters on three different circuits — `race:lap` carries the same `circuitId` as `race:finished` (RaceManager.js:1157), so a lap at Cinder cannot credit the Aurora step, and laps accumulate across races so this is a session rather than a single heat. The counts are one standard-difficulty race distance each plus a little: Vellum 5, Cinder 6, Aurora 6 (RaceCircuits.js:397, :413, :429). Step 7 is the buy the tyre-bay account was opened for — by here the player can afford the 260 CR floor of her stock.',
    steps: [
      { order: 1, label: 'Press E on Kai Torres and open a record attempt across all three circuits', type: 'interact', target: 'Kai Torres', count: 1, world: 'race' },
      { order: 2, label: 'Complete 8 laps of the Vellum Ridge Circuit. They add up across races, so this is more than one full-distance run', type: 'race', target: 'vellum', count: 8, world: 'race' },
      { order: 3, label: 'Complete 6 laps of Cinder Gorge — one standard-difficulty race distance in the quarry', type: 'race', target: 'cinder', count: 6, world: 'race' },
      { order: 4, label: 'Complete 6 laps of Aurora Rise. Every one of them goes over the top of the loop; the road thirty metres underneath it does not count', type: 'race', target: 'aurora', count: 6, world: 'race' },
      { order: 5, label: 'Strip 3 alloy scrap out of the caches to pay for the rebuild', type: 'collect', target: 'alloy_scrap', count: 3, world: 'race' },
      { order: 6, label: 'And 2 bullet drops while you are up on the roofs', type: 'collect', target: 'bullet', count: 2, world: 'race' },
      { order: 7, label: 'Spend it: press B at Ines Okonjo and buy something off her board. She stocks liveries and mount upgrades and nothing else, so pick a car', type: 'purchase', target: 'buy', count: 1, world: 'race' },
      { order: 8, label: 'Three unbroken minutes on site without taking a hit — any damage puts the timer back to zero', type: 'survive', target: 'race', count: 6, world: 'race' },
      { order: 9, label: 'Press E on Marek Vaisey and have the distance scrutineered', type: 'talk', target: 'Marek Vaisey', count: 1, world: 'race' },
    ],
  },

  {
    n: 50,
    world: 'race',
    line: 'Vellum Ridge Legend',
    title: 'Win outright at Vellum Ridge and carry the title to the hub',
    credits: 2680,
    dur: 10080,
    pre: ['Ridge Record', 'Circuit Crown'],
    notes:
      'Capstone, 10 steps — the longest list in the race set. CROSS-WORLD PREREQUISITE: `Circuit Crown` is the station global that already asks for a race on each circuit and one outright win, so this is the rematch with the whole world watching. Steps 2-6 are all `count: 1` race steps and they OVERLAP ON PURPOSE: `race:finished` carries the circuit id, the race type and the placing together (RaceManager.js:1285-1288), so a dragon race won at Aurora clears steps 4, 5 and 6 in one flag. That is the intended reward for a good run, not a bug — but a DNF clears none of them (QuestSystem.js:435) and steps 2 and 3 still need their own circuits. Steps 1 and 10 are both `interact` and are deliberately different targets — Kai Torres in the paddock, and the gateway home — because `_advanceSteps` walks every step on each event and two Kai steps would let one E press clear the whole capstone (the exact defect found in the station set, QUEST-AUDIT.md).',
    steps: [
      { order: 1, label: 'Press E on Kai Torres in the paddock and enter the title round', type: 'interact', target: 'Kai Torres', count: 1, world: 'race' },
      { order: 2, label: 'Take the flag at the Vellum Ridge Circuit', type: 'race', target: 'vellum', count: 1, world: 'race' },
      { order: 3, label: 'Take the flag at Cinder Gorge', type: 'race', target: 'cinder', count: 1, world: 'race' },
      { order: 4, label: 'Take the flag at Aurora Rise', type: 'race', target: 'aurora', count: 1, world: 'race' },
      { order: 5, label: 'Win one outright. Cross the line FIRST in any race on this site — a did-not-finish does not count, and the same win also clears whichever circuit you took it on', type: 'race', target: 'place_1', count: 1, world: 'race' },
      { order: 6, label: 'And take the flag once more on the dragon. Fly it at a circuit you still owe and you clear two steps with one race', type: 'race', target: 'dragon', count: 1, world: 'race' },
      { order: 7, label: 'Recover a nexus shard from the highest cache on the site — the title comes with a tribute to the hub', type: 'collect', target: 'nexus_shard', count: 1, world: 'race' },
      { order: 8, label: 'Open the Esc menu, take Character, and choose the Slim build. Every kilogram is a tenth of a second, and the record book does not care how you got there', type: 'customize', target: 'slim', count: 1, world: 'race' },
      { order: 9, label: 'Three unbroken minutes on site without a scratch, so the title stands clean', type: 'survive', target: 'race', count: 6, world: 'race' },
      { order: 10, label: 'Walk into the Aether Station arch by the paddock and press E. The Vellum Ridge title is recorded at the hub or it is not recorded at all', type: 'interact', target: 'station', count: 1, world: 'race' },
    ],
  },
];

export default RACE_QUESTS;
