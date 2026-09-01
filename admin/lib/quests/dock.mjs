/**
 * DOCK quest content — Lodestar Yard. 10 quests, n 51-60.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 *  READ `QUEST-AUDIT.md` AT THE REPO ROOT BEFORE YOU EDIT THIS FILE.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * A quest step is not prose. It is a SUBSCRIPTION to an event the engine
 * already emits, in the world it names, and if the engine never emits that
 * thing the step is dead and the quest containing it can never be finished by
 * anybody. The set this file is written against was 0-for-50 before the audit
 * for exactly that reason. Every target below was checked with
 * `candidateValues(type, 'dock')` out of `scripts/quest-vocab.mjs` — the same
 * function `scripts/tests/quest-content.test.mjs` judges it with — and nothing
 * here was written from the design document without being checked first.
 *
 * ── `line`, not `title`, is what a prerequisite names ────────────────────────
 * `pre` is matched against `quest_line`, so every quest here carries a line of
 * its own rather than sharing one with the two beside it. Grouping three
 * quests under "Commissioning" and then naming that group as a prerequisite
 * would mean "complete ANY of them", which is not what a chain is; the citadel
 * set already made one line per quest for the same reason. The arc still reads
 * as four movements - signing on, the yard-rat work, fitting out, and the
 * launch - it is just that the movements live in the titles.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 *  WHAT LODESTAR YARD CANNOT DO, AND WHY
 * ═════════════════════════════════════════════════════════════════════════════
 *
 * Four whole verbs are unavailable here, and each is unavailable for a reason
 * in the world rather than a gap in this file:
 *
 *   kill / defend   `DockWorld` sets `rules.hostiles: false`. It is a civilian
 *                   worksite; the space-invaders fantasy lives on the far side
 *                   of the blast door. `candidatesFor` returns nothing for
 *                   either verb in a world with the rule off.
 *   race            no `trackPath`, and `rules.races: false`.
 *   race            (see above) — and the SECOND thing this file used to say
 *                   was unavailable, `minigame`, IS available now: `DockWorld`
 *                   publishes one venue, `yard_butts`, and `main.js` registers
 *                   a factory for its kind against `minigames/TestFire.js`.
 *                   `candidateValues('minigame', 'dock')` answers with seven
 *                   values now instead of none, and Q60 uses one of them.
 *
 *                   The hull-cutting bench the design also asks for is STILL
 *                   not published, for the reason the empty array used to
 *                   carry: an unregistered `kind` is SILENTLY INERT
 *                   (`MinigameManager.arm`), so a `hullcut` venue with no
 *                   module behind it is a prompt in the world that does
 *                   nothing — and worse, it is invisible to any test that
 *                   reads the venue array rather than the factory map.
 *   customize       bound to `character:changed`, whose candidates are
 *                   CHARACTER config values. "Paint your ship" cannot use it,
 *                   and faking it by emitting `character:changed` would be a
 *                   lie in the save file. When ship liveries exist they arrive
 *                   as `purchase` of the skin item, which emits `market:trade`
 *                   for real.
 *
 * And five step types have no emitter ANYWHERE in `src/`:
 *
 *      investigate    deliver    escort    stealth    craft
 *
 * A shipyard writes itself into all five — "deliver the coolant to Bay 3",
 * "craft a thruster coil", "escort the Chandler to the trench", "investigate
 * the sealed hull". Every one of those is authorable and permanently
 * uncompletable, and 53 of the old 184 steps used them. Rule 1 of
 * `quest-content.test.mjs` rejects them; do not fight it.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 *  WHO ACTUALLY STANDS IN THE YARD
 * ═════════════════════════════════════════════════════════════════════════════
 *
 * THE ARITHMETIC (`NPCManager.spawnForWorld`). `DockWorld` declares no
 * `friendlyBudget`, so the engine defaults apply:
 *   friendlyBudget = maxFriendlies = 30
 *   CROWD_RESERVE  = 6
 *   authored       = 7    (the warden, three counters, three yard hands)
 *   authoredCap    = max(7, min(7, 30 - 6)) = 7   → all seven get a slot
 *   maxHostiles    = irrelevant; `rules.hostiles` is false and none are authored
 *   crowd budget   = 30 - (7 + 2 lorekeepers) = 21
 *
 * TWO lorekeepers, not one: the yard has two gateways (station and space) and
 * `lorekeeperScope` gives a keeper the DESTINATION's scope whenever a world's
 * portals name more than one place. So neither of them recites the yard, which
 * is why the Yard Warden is authored by hand and is the only character here
 * who speaks `DEFAULT_LORE.dock`.
 *
 * The crowd wears the RIGHT clothes, unlike the citadel's: `THEME_BY_WORLD.dock`
 * is `'dock'` and `Humanoid.js` carries a dock costume set in all four of its
 * tables. Crowd members are still NOT named in any step below, for the older
 * reason: they come out of `ROLE_CAST.dock` in `ROLE_ROTATION` order against a
 * budget, so which of them exists on any given visit is arithmetic rather than
 * authorship. Only the seven authored characters and the quest desk are named.
 *
 * NAMES USED BY THIS FILE, WITH THE LINE THAT SPAWNS THEM:
 *
 *   Dispatcher Selim Bregovic   NPCManager `_spawnQuestManagers` CAST.dock.
 *                               THE ONLY QUEST DESK IN THIS WORLD, and
 *                               therefore the only valid `interact` NPC target.
 *                               He stands on the apron at (10, 0.2, 40).
 *   Yard Warden Teodora Vasa    DockWorld `_publish` — authored, patrols the
 *                               apron end of the keel line.
 *   Ivo Marek                   DockWorld `_publish` — Yard Chandlery,
 *   Suri Vane                   Fitting Shop,
 *   Beck Aldous                 Paint & Rope. All three `role: 'vendor'`,
 *                               anchored, 14 m apart down the chandlery row.
 *   Rig-Chief Odalys Prieto     DockWorld `_publish` — berth two.
 *   Fitter Casimir Oyelaran     DockWorld `_publish` — berth three.
 *   Signaller Wren Achebe       DockWorld `_publish` — the blast-door end.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 *  WHAT CAN BE COLLECTED HERE, AND WHAT CANNOT
 * ═════════════════════════════════════════════════════════════════════════════
 *
 * `candidateValues('collect', 'dock')` returns exactly five:
 *
 *      alloy_scrap   hull_plate   laser_cell   medkit   relic_coin
 *
 * The first four are `CACHE_TABLES.dock` (three sunken caches in the trench,
 * three high ones on the gantry — `Caches.PER_WORLD`); `relic_coin` is the
 * `rare` spot in the trench stash `DockWorld` publishes as a doorless
 * enterable. NOTHING comes off a body, because there are no bodies.
 *
 * `thruster_coil` is deliberately NOT collectable and is not named in a
 * `collect` step anywhere below, even though it is in `DROP_TABLES.dock`: with
 * `hostiles: false` that table never rolls, so a coil can only be bought. That
 * distinction is the whole reason the drop table and the cache table are
 * separate lists, and it is exactly the trap two shipped citadel steps fell
 * into by asking for ammunition the fallback made "technically obtainable".
 *
 * ═════════════════════════════════════════════════════════════════════════════
 *  THREE FURTHER TRAPS, SPECIFIC TO THIS WORLD
 * ═════════════════════════════════════════════════════════════════════════════
 *
 * 1. A `visit dock` step inside a dock quest COMPLETES ON ACCEPT.
 *    `_creditVisit` runs from `accept()` and from `_loadQuestsForWorld`, not
 *    only from `world:changed`. It is free padding and is used nowhere here.
 *
 * 2. `survive` is the ONE verb that is not rule-gated — it ticks in a
 *    `quests: false` world — and it counts one per 30 damage-free seconds
 *    (`SURVIVE_TICK_S`). Four counts is two minutes of wall clock, so `dur`
 *    has to comfortably exceed it or `update()` auto-fails the engagement
 *    before the last tick lands. Q56 asks four and allows 360 s; Q59 asks two
 *    and allows 240 s.
 *
 * 3. Matching is anchored token-run, and `_advanceSteps` walks EVERY step per
 *    event with no `onceKey` for `quest:activity`. So `talk / vendor / 3` is
 *    satisfied by pressing E on the same counter three times as readily as by
 *    walking the row — the label is what tells the player which was meant, and
 *    the three counters are 14 m apart precisely so walking it is the easier
 *    of the two.
 */

export const DOCK_QUESTS = [
  {
    n: 51,
    world: 'dock',
    line: 'Sign On',
    title: 'Sign on at Lodestar Yard',
    credits: 140,
    dur: 90,
    pre: null,
    notes:
      'Opening quest, 2 steps, and it teaches the only two NPC verbs this world has: E on the quest desk (which emits `interact` and opens the board) and E on anybody else (which emits `talk`). Selim is the ONLY quest desk in the yard - `DockWorld` sets `isQuestManager` nowhere - so he is the only legal `interact` NPC target here. Teodora is authored in `npcSpawns` and therefore guaranteed a slot; she is also the only character in the world who recites `DEFAULT_LORE.dock`, because both automatic lorekeepers took a gateway destination instead.',
    steps: [
      { order: 1, label: 'You arrive on the apron facing down the keel line. Selim Bregovic keeps the dispatch board twenty paces to starboard - press E and get your name on the site roll', type: 'interact', target: 'Dispatcher Selim Bregovic', count: 1, world: 'dock' },
      { order: 2, label: 'Then press E on Yard Warden Teodora Vasa. She set this site out four times before anyone commissioned it and she will tell you why every hull here looks like it was assembled from a kit, because it was', type: 'talk', target: 'Yard Warden Teodora Vasa', count: 1, world: 'dock' },
    ],
  },

  {
    n: 52,
    world: 'dock',
    line: 'The Chandlery Row',
    title: 'Walk the chandlery row',
    credits: 180,
    dur: 120,
    pre: ['Sign On'],
    notes:
      '1 step, and it is a walk rather than a fetch. The three counters stand at z +20, +6 and -8 on the port side of the keel corridor, 14 m apart, and they split the catalogue three ways: Ivo Marek has tools and health, Suri Vane has ships and weapons, Beck Aldous has cosmetic, mounts and spells. `Marketplace.refreshCatalog` filters the window by the open vendor\'s `vendorCategories`, so a player who only ever finds one of them can buy a third of the game. Targets `vendor` rather than the three names: `HUD.js` emits `quest:activity {type:\'talk\', role:\'vendor\'}` for each of them, and the role is what makes the step read as "the row" instead of a list of strangers.',
    steps: [
      { order: 1, label: 'Three counters run down the port side of the keel line, fourteen paces apart, and between them they sell everything in the yard. Press E on all three - Ivo Marek at the chandlery, Suri Vane at the fitting shop, Beck Aldous at Paint & Rope', type: 'talk', target: 'vendor', count: 3, world: 'dock' },
    ],
  },

  {
    n: 53,
    world: 'dock',
    line: 'Open an Account',
    title: 'Open an account with the Chandler',
    credits: 260,
    dur: 180,
    pre: ['The Chandlery Row'],
    notes:
      '2 steps, the merchant lesson. `pack_medkit` is category `health` and Ivo Marek is the only counter in the yard that stocks `health`, so step 1 names his stall and means it. Step 2 is a SELL, which is not category-gated at all - `Marketplace.sellables` reads the player\'s own bag - so it can be done at any of the three, and the label says so. `WORLD_MARKETS.dock` pays 0.85 for a trinket and 0.6 for alloy scrap, the lowest price paid for scrap anywhere in the Nexus: this is the world where selling salvage is a bad idea, and finding that out for 40 credits is the point of the step.',
    steps: [
      { order: 1, label: 'Ivo Marek is the only counter in the yard that stocks medical. Press B at the chandlery and buy a Trauma Twin-Pack - nothing in a shipyard heals you for free', type: 'purchase', target: 'medkit', count: 1, world: 'dock' },
      { order: 2, label: 'Now switch to the sell side at any of the three counters and sell something back. Watch what the yard pays for scrap: a place that makes hull plate by the ton does not want yours', type: 'purchase', target: 'sell', count: 1, world: 'dock' },
    ],
  },

  {
    n: 54,
    world: 'dock',
    line: 'Strip the Trench',
    title: 'Strip the service trench',
    credits: 420,
    dur: 300,
    pre: ['Sign On'],
    notes:
      '2 steps, both fed by `CACHE_TABLES.dock` (`alloy_scrap` 4-9, `hull_plate` 2-4) and by the four-spot stash `DockWorld` publishes as the doorless enterable `yard-trench`. `Caches.PER_WORLD` places three SUNKEN caches, and the trench - 2.2 m under the keel line, 84 m long, grated over except at three ramped bays - is the sunken ground in this world. There is no fall damage in a 2.2 m drop and every bay is a ramp, so this is a route rather than a hole; the label points at the bay nearest the apron so a first-timer does not go looking for a ladder.',
    steps: [
      { order: 1, label: 'The service trench runs under the keel line, two metres down and grated over. Three bays are open - the first is just past berth one - and each one is a ramp. Get down there and bring up 4 alloy scrap', type: 'collect', target: 'alloy_scrap', count: 4, world: 'dock' },
      { order: 2, label: 'And 2 hull plate while you are down there. The yard cuts them by the ton and still counts every one, which is why they are worth having', type: 'collect', target: 'hull_plate', count: 2, world: 'dock' },
    ],
  },

  {
    n: 55,
    world: 'dock',
    line: 'Onto the Gantry',
    title: 'Get on the gantry',
    credits: 480,
    dur: 300,
    pre: ['Strip the Trench'],
    notes:
      '2 steps and a climb. `Caches.PER_WORLD` places three HIGH caches - the rule is a 7 m drop within 9 m of the site - and in this world the only ground that qualifies is the 8 m perimeter catwalk, its two crossings and the crane runway at 15.4 m. So `laser_cell` up there is a real errand with a real route: two stairs at the apron and blast-door ends of the port run, or up a hull once the ships are on the cradles. Casimir works berth three, directly under the port catwalk, which is where you come down.',
    steps: [
      { order: 1, label: 'The catwalk runs the whole perimeter at eight metres and there are two ways up: the flight by the apron and the one by the blast door, both on the port wall. Get up there and recover 2 laser cells from the stores boxes', type: 'collect', target: 'laser_cell', count: 2, world: 'dock' },
      { order: 2, label: 'Come down at berth three and press E on Fitter Casimir Oyelaran. He is usually up to the elbows in the interceptor and has opinions about every other hull in the yard', type: 'talk', target: 'Fitter Casimir Oyelaran', count: 1, world: 'dock' },
    ],
  },

  {
    n: 56,
    world: 'dock',
    line: 'One Clean Shift',
    title: 'One clean shift',
    credits: 520,
    dur: 360,
    pre: ['Onto the Gantry'],
    notes:
      '2 steps. `survive` credits one count per 30 unbroken damage-free seconds and ANY damage resets the accumulator, so four counts is two minutes of not falling off anything. `dur` is 360 rather than 120: the counter only ticks in `update()` and a quest whose duration equals its own requirement auto-fails on the last tick. In a world with `hostiles: false` the only thing that can hurt you here is the ground - the catwalk is eight metres up, the crane cab is fifteen, and fall damage starts at 7.5 m - which is precisely what makes this a shift rather than a wait.',
    steps: [
      { order: 1, label: 'Two minutes on the yard without taking a scratch. The only thing in here that can hurt you is the drop off the gantry, and everybody does it once', type: 'survive', target: 'dock', count: 4, world: 'dock' },
      { order: 2, label: 'Then report to Rig-Chief Odalys Prieto on berth two. Twenty years of pinning sections back together and she will tell you how the Dray came through the gateway, in order', type: 'talk', target: 'Rig-Chief Odalys Prieto', count: 1, world: 'dock' },
    ],
  },

  {
    n: 57,
    world: 'dock',
    line: 'Plate and Coil',
    title: 'Plate and coil for berth two',
    credits: 640,
    dur: 360,
    pre: ['One Clean Shift'],
    notes:
      '3 steps, and the one place in the yard the economy points somewhere. `thruster_coil` is in `DROP_TABLES.dock` and NOT in `CACHE_TABLES.dock`, and with `hostiles: false` the drop table never rolls - so a coil cannot be collected in this world at any price and this step is a `purchase`, deliberately. Suri Vane stocks `ships` and `weapons` and is the counter that sells them. Step 1 is collect and step 3 is purchase against the same fitting-out job, which is the honest shape of the yard: the cheap parts are lying about and the expensive one is behind a counter.',
    steps: [
      { order: 1, label: 'Berth two wants plate. Three more from the trench caches or the gantry boxes - Odalys will not start until they are on the cradle', type: 'collect', target: 'hull_plate', count: 3, world: 'dock' },
      { order: 2, label: 'A thruster coil is not lying about anywhere in this yard, whatever anyone tells you. Press B at Suri Vane\'s fitting shop and buy one', type: 'purchase', target: 'thruster_coil', count: 1, world: 'dock' },
      { order: 3, label: 'Take it back to Rig-Chief Odalys Prieto on berth two', type: 'talk', target: 'Rig-Chief Odalys Prieto', count: 1, world: 'dock' },
    ],
  },

  {
    n: 58,
    world: 'dock',
    line: 'Store Ship',
    title: 'Store ship for a launch that has not happened',
    credits: 560,
    dur: 300,
    pre: ['Plate and Coil'],
    notes:
      '3 steps. `WORLD_MARKETS.dock` charges 1.1 for a consumable and 0.8 for ammunition, which is the whole shopping lesson of this world in two numbers: stock up on cells here and buy your medicine anywhere else. The `medkit` collect is fed by `CACHE_TABLES.dock` (1-2 per cache) at 0.18 per body-equivalent, the second-highest medicine rate in the game after the sports ground, because an industrial site has a first-aid point at every berth.',
    steps: [
      { order: 1, label: 'A ship needs stores before it needs a pilot. Buy 2 Trauma Twin-Packs off Ivo Marek - they cost more here than anywhere in the Nexus and there is nowhere to buy them where you are going', type: 'purchase', target: 'medkit', count: 2, world: 'dock' },
      { order: 2, label: 'The yard keeps its own first-aid boxes at the berths and in the trench. Find 1 more', type: 'collect', target: 'medkit', count: 1, world: 'dock' },
      { order: 3, label: 'Press E on Signaller Wren Achebe at the blast-door end. She keeps the launch log. It has one page and nothing written on it', type: 'talk', target: 'Signaller Wren Achebe', count: 1, world: 'dock' },
    ],
  },

  {
    n: 59,
    world: 'dock',
    line: 'The Crane Cab',
    title: 'The crane runs on a cycle',
    credits: 700,
    dur: 240,
    pre: ['Store Ship'],
    notes:
      '3 steps, and the reason to go all the way up. The crane cab sits at 15.4 m at the port end of its bridge, reached by a caged run off the port catwalk and a runway walkway - it is a published `viewpoint` with a `launch` point and a haystack under it, so synchronising it pays 150 credits and three crown coins through `Viewpoints`, which is an ACCOUNT-FREE layer that works signed out. This quest is the signed-in half of the same climb. The `relic_coin` is the `rare` spot in the trench stash, the only relic coin in the yard: nothing here mints one, which is why `WORLD_MARKETS.dock` pays 1.7 for it.',
    steps: [
      { order: 1, label: 'Two minutes clean on the high steel. The crane cab is fifteen metres up: off the port catwalk, up the caged run, along the runway walkway', type: 'survive', target: 'dock', count: 2, world: 'dock' },
      { order: 2, label: 'There is one old crown coin in this yard and it is in the trench stash. Nothing here mints them, which is why the chandler pays over the odds for one', type: 'collect', target: 'relic_coin', count: 1, world: 'dock' },
      { order: 3, label: 'Tell Yard Warden Teodora Vasa the crane cab is clear', type: 'talk', target: 'Yard Warden Teodora Vasa', count: 1, world: 'dock' },
    ],
  },

  {
    n: 60,
    world: 'dock',
    line: 'First Launch',
    title: 'LAUNCHES: 001',
    credits: 1120,
    dur: 420,
    pre: ['The Crane Cab'],
    notes:
      'THE HOOK THE FLIGHT DROP LANDS ON, and every step of it works today. `PortalSystem.enter` emits `quest:activity {type:\'interact\', target: portal.id}` where `id` is `${worldId}->${target}` - so `dock->space` is a real, checked, completable target the moment a player walks through the blast-door portal, and it costs this file nothing. When the cockpit seat exists it calls `portals.enterById(\'dock->space\')` and emits the SAME event from inside a ship, so this quest does not change. The launch portal is on the DECK in front of the blast door and not in a cockpit, because `arrivalFor` looks a return portal up by target and takes the first match: one spec serves both legs, and a spec inside a 3 m cockpit would put a returning pilot through the far bulkhead. '
      + 'Step 1 changed target from the bare trade-kind `buy` to `pack_laser_cell`, which is now a real catalogue row: `BASE_ITEMS` carries it with `worlds: [\'dock\']` and `category: \'weapons\'`, and Suri Vane is the counter that stocks weapons. Its old label also claimed cells were "cheaper here than anywhere in the Nexus", which was FALSE arithmetic - `WORLD_PRICE_MULTIPLIERS` charges 0.9x at the yard against the station\'s 0.8x, so the station would have been cheaper if it had stocked them. It does not: the rack is a yard-only row, which is the claim the label makes now. '
      + 'Step 2 is the only `minigame` step in this world and it is the reason the cells in step 1 are not decoration: `TestFire` burns 8 of them to light the plates. `test_fire_won` is the COMPOSITE `QuestSystem` pushes only on a win - the bare `test_fire` would sit inside `test_fire_lost` as a whole-token run and complete this on a miss.',
    steps: [
      { order: 1, label: 'Nobody leaves this yard on an empty rack. Buy a cell rack off Suri Vane at the fitting shop - forty cells, and this is the only counter in the Nexus that racks them because this is the only place that winds them', type: 'purchase', target: 'pack_laser_cell', count: 1, world: 'dock' },
      { order: 2, label: 'Then prove the rack. The test-fire butts are down in the service trench, under the grating between the datum and berth four: eight cells to light the plates, six plates in three ranks, forty-five seconds. Put all six down', type: 'minigame', target: 'test_fire_won', count: 1, world: 'dock' },
      { order: 3, label: 'Then walk the keel line to the north end. The board over the blast door has read LAUNCHES: 000 since the site was commissioned. Step through and change it', type: 'interact', target: 'dock->space', count: 1, world: 'dock' },
    ],
  },
];

export default DOCK_QUESTS;
