/**
 * THE QUEST BOARD THAT WORKS WITH THE SERVER DOWN, AND SIGNED OUT.
 *
 * ===========================================================================
 *  THE DEFECT
 * ===========================================================================
 *
 * `QuestSystem._loadQuestsForWorld` had exactly one assignment to the board's
 * contents - `this.worldQuests = data.quests ?? []` - and no fallback of any
 * kind. Its own offline warning said "the board will show what is bundled and
 * nothing else", and NOTHING WAS BUNDLED. So the sentence was true and the
 * board was empty.
 *
 * That is not an edge case, it is the first thirty seconds of the game.
 * `Onboarding.js` records the product decision that first run happens SIGNED
 * OUT, and the game is routinely played against `vite` alone with no Next site
 * behind `/api/game`. Press J in either state and the board said "No quests in
 * this category" for all six worlds - 78 quests, every authored reward, and the
 * only structured thing to do in the game, invisible.
 *
 * `MarketplaceOffline.js` is the same problem solved for the shop, and its
 * header records why it had to be: "every credit the player earns buys
 * nothing". This is the other half - nothing tells the player what to do with
 * the world they are standing in.
 *
 * ===========================================================================
 *  WHY THIS IS A COPY, AND WHAT STOPS IT DRIFTING
 * ===========================================================================
 *
 * The seed content lives in `admin/lib/quests/*.mjs`, which `admin/lib/db.ts`
 * imports as `ALL_QUESTS` and writes to the `quests` table. Those modules are
 * plain data with no dependencies, so the browser bundle COULD import them
 * directly - and deliberately does not. `admin/` is a separate Next
 * application with its own `package.json` and its own deploy; making the game
 * bundle depend on that tree would couple two products that ship apart, for
 * the sake of ~100 KB that has to be in the bundle either way.
 *
 * So it is a copy, and copies rot. This one is pinned:
 *
 *   `scripts/tests/quests-offline.test.mjs` imports `ALL_QUESTS` from the SAME
 *   module the seeder reads, re-derives every row, and asserts field by field -
 *   quest number, world, line, title, reward, duration, prerequisites, and
 *   every step's order/label/type/target/count/world. A quest edited in
 *   `admin/lib/quests/` and not here is a red test, not a board quietly
 *   offering last month's content.
 *
 * `notes` is the one authored field NOT copied. It is a note to the content
 * author ("Opening quest. 2 steps. Teaches nothing explicitly but forces...")
 * and no player-facing surface reads it, so shipping it would be 20 KB of the
 * team talking to itself inside the game bundle.
 *
 * ===========================================================================
 *  WHY `.mjs`, AND THE CONTENT DEFECT THAT MAKES THE DISTINCTION MATTER
 * ===========================================================================
 *
 * The extension is the source modules' own, and it marks this file as MIRRORED
 * CONTENT rather than authored client code. That is not decoration:
 * `scripts/tests/pause-menu.test.mjs` walks `src/**\/*.js` asserting that no UI
 * string advertises a key the Esc hub removed, and it is a gate over strings
 * WE write in components - it has never covered quest text, which is authored
 * in the admin console and served from the database.
 *
 * ⚠ AND THE CONTENT IS CURRENTLY WRONG. Twelve step labels and one title in
 * `admin/lib/quests/*.mjs` still tell the player to "Press F2" (character
 * menu) or name F6 (rebind panel), and the Esc pause hub removed both keys.
 * That is a live defect on the ONLINE board today, not something this mirror
 * introduced, and the fix belongs in the seed modules - which is why this file
 * copies them verbatim rather than quietly correcting them here. Correcting
 * them here would put the offline board and the online board into permanent
 * disagreement and hide the defect from the people who can fix it. The patch
 * list is in the audit handover; when it lands, this note goes with it.
 *
 * ===========================================================================
 *  WHAT THE ROWS ARE
 * ===========================================================================
 *
 * `offlineQuests(worldId)` returns rows in the shape
 * `listActiveQuestsForWorld` returns and `QuestSystem`/`QuestBoard` already
 * read: `id`, `quest_number`, `world`, `quest_line`, `title`, `reward_credits`,
 * `duration_minutes`, `pre_steps`, `steps`, ordered by quest number.
 *
 * Two of those fields are JSON TEXT in the database and JSON text here, which
 * matters: `QuestBoard._parseSteps` and its `pre_steps` reader both call
 * `JSON.parse` directly, so handing them a live array would throw into a
 * `catch` and draw a quest with no steps. The structured form is what this
 * module stores; the stringify happens on the way out, once, in
 * `offlineQuests`.
 *
 * `id` is synthetic. The database column is a `randomUUID()` assigned at seed
 * time and there is no way to know it offline, so the rows carry
 * `offline-quest-<n>` - which cannot collide with a UUID, is stable across
 * sessions so a selected quest survives a re-render, and is recognisable in a
 * log line as "this came from the bundle". An engagement accepted against a
 * real server always carries the server's own `quest_id`, and
 * `_resolveQuestForEngagement` already rebuilds a quest from the engagement
 * row when it cannot find a local match, so the two id spaces never have to
 * agree.
 */

/**
 * Every authored quest, in the seeder's order. 78 rows.
 *
 * Structured, not stringified - see the header. `pre` and `steps` keep their
 * authored shapes and `offlineQuests` converts them.
 */
export const OFFLINE_QUESTS = Object.freeze([
  {
    quest_number: 1,
    world: "station",
    quest_line: "Signal Boost",
    title: "Get the concourse beacon array back on the air",
    reward_credits: 90,
    duration_minutes: 45,
    pre: null,
    steps: [
      { order: 1, label: "Press E on Zara Vex at the concourse work board to take the beacon job", type: "interact", target: "Zara Vex", count: 1, world: "station" },
      { order: 2, label: "The array needs shielding plate — pick up 2 alloy scrap off the plaza decks (walk over it, or press E)", type: "collect", target: "alloy_scrap", count: 2, world: "station" },
    ],
  },
  {
    quest_number: 2,
    world: "station",
    quest_line: "Cargo Manifest",
    title: "Tally the incoming freight and sign the manifest off",
    reward_credits: 150,
    duration_minutes: 90,
    pre: null,
    steps: [
      { order: 1, label: "Press E on Bex Corrado on the hangar deck and ask what came in on the freight lift", type: "talk", target: "Bex Corrado", count: 1, world: "station" },
      { order: 2, label: "Tally the salvage line: recover 3 alloy scrap from the cargo yard", type: "collect", target: "alloy_scrap", count: 3, world: "station" },
      { order: 3, label: "Tally the munitions line: recover 2 bullet drops from the same manifest", type: "collect", target: "bullet", count: 2, world: "station" },
      { order: 4, label: "Press E on Sparrow Nkemdi in the cargo yard and read the finished manifest back to her", type: "talk", target: "Sparrow Nkemdi", count: 1, world: "station" },
    ],
  },
  {
    quest_number: 3,
    world: "station",
    quest_line: "Dock Worker",
    title: "Clear the blocked freight corridor and restore the flow",
    reward_credits: 280,
    duration_minutes: 120,
    pre: ["Signal Boost"],
    steps: [
      { order: 1, label: "Two Breaker Frames have the alley shut. Destroy them — they carry shock batons and will close on you, so do not back into the stacks", type: "kill", target: "Breaker Frame", count: 2, world: "station" },
      { order: 2, label: "Haul the wreck out: collect 3 alloy scrap from the cleared corridor", type: "collect", target: "alloy_scrap", count: 3, world: "station" },
      { order: 3, label: "Press E on 2 of the dock crew to report the lane open", type: "talk", target: "wanderer", count: 2, world: "station" },
    ],
  },
  {
    quest_number: 4,
    world: "station",
    quest_line: "Trade Route Scouting",
    title: "Chart two live trade corridors out of the hub",
    reward_credits: 460,
    duration_minutes: 240,
    pre: ["Cargo Manifest"],
    steps: [
      { order: 1, label: "Press E on Anselm Kade, the freight broker working the plaza with a folding terminal — he knows which corridors are paying", type: "talk", target: "Anselm Kade", count: 1, world: "station" },
      { order: 2, label: "Walk into the Ashfall Reach gateway on the plaza and press E to open the corridor", type: "interact", target: "medieval", count: 1, world: "station" },
      { order: 3, label: "Arrive in Ashfall Reach and log the corridor as live", type: "visit", target: "medieval", count: 1, world: "medieval" },
      { order: 4, label: "Come back to the station and step into the Sunspire Citadel gateway instead", type: "interact", target: "citadel", count: 1, world: "station" },
      { order: 5, label: "Arrive at Sunspire Citadel and log the second corridor", type: "visit", target: "citadel", count: 1, world: "citadel" },
      { order: 6, label: "Return to the station and press E on any trader to file the route pricing", type: "talk", target: "vendor", count: 1, world: "station" },
    ],
  },
  {
    quest_number: 5,
    world: "station",
    quest_line: "Lost Traveller",
    title: "Find out where the Bay 9 envoy went",
    reward_credits: 70,
    duration_minutes: 30,
    pre: null,
    steps: [
      { order: 1, label: "Work the concourse crowd: press E on 3 station locals and ask whether anyone saw the envoy leave Bay 9", type: "talk", target: "wanderer", count: 3, world: "station" },
    ],
  },
  {
    quest_number: 6,
    world: "station",
    quest_line: "Contraband Sweep",
    title: "Sweep the cargo bays for smuggled shard stock",
    reward_credits: 400,
    duration_minutes: 180,
    pre: ["Dock Worker"],
    steps: [
      { order: 1, label: "Press E on Prue Okonkwo, the gateway marshal on the plaza approach — she keeps the tally of who comes back through and who does not, and she has the bay list", type: "talk", target: "Prue Okonkwo", count: 1, world: "station" },
      { order: 2, label: "Turn the bays over: collect 4 alloy scrap from the container stacks", type: "collect", target: "alloy_scrap", count: 4, world: "station" },
      { order: 3, label: "Find the contraband itself — a nexus shard, hidden in a supply cache", type: "collect", target: "nexus_shard", count: 1, world: "station" },
      { order: 4, label: "The smugglers left guards. Destroy 2 Skirmish Drones — fast, jumpy, badly armed", type: "kill", target: "Skirmish Drone", count: 2, world: "station" },
      { order: 5, label: "Press E on Lt. Idris Fane at Traffic Control and hand the seized stock over", type: "talk", target: "Lt. Idris Fane", count: 1, world: "station" },
    ],
  },
  {
    quest_number: 7,
    world: "station",
    quest_line: "Nexus Cartographer",
    title: "Verify all five live gateways out of the hub",
    reward_credits: 1030,
    duration_minutes: 720,
    pre: ["Trade Route Scouting","Contraband Sweep"],
    steps: [
      { order: 1, label: "Every arch has a keeper beside it. Press E on one and ask what is on the far side", type: "talk", target: "lorekeeper", count: 1, world: "station" },
      { order: 2, label: "Verify gateway 1 — step into Ashfall Reach and press E", type: "interact", target: "medieval", count: 1, world: "station" },
      { order: 3, label: "Verify gateway 2 — step into the Meridian Athletic Complex and press E", type: "interact", target: "sports", count: 1, world: "station" },
      { order: 4, label: "Verify gateway 3 — step into Sunspire Citadel and press E", type: "interact", target: "citadel", count: 1, world: "station" },
      { order: 5, label: "Verify gateway 4 — step into Vellum Ridge and press E", type: "interact", target: "race", count: 1, world: "station" },
      { order: 6, label: "Verify gateway 5 — step into the Verdant Coil and press E", type: "interact", target: "maze", count: 1, world: "station" },
      { order: 7, label: "Press E on Zara Vex and file the verified gateway chart", type: "interact", target: "Zara Vex", count: 1, world: "station" },
    ],
  },
  {
    quest_number: 8,
    world: "station",
    quest_line: "Station Saboteur",
    title: "Break the crew turning station security against the decks",
    reward_credits: 1210,
    duration_minutes: 1440,
    pre: ["Nexus Cartographer"],
    steps: [
      { order: 1, label: "Press E on Lt. Idris Fane on the Traffic Control watch — security is compromised and he knows which units stopped answering", type: "talk", target: "Lt. Idris Fane", count: 1, world: "station" },
      { order: 2, label: "Destroy 4 Rogue Security Units — hijacked drones running corrupted enforcement code", type: "kill", target: "Rogue Security Unit", count: 4, world: "station" },
      { order: 3, label: "Destroy 3 Breaker Frames in the container alleys", type: "kill", target: "Breaker Frame", count: 3, world: "station" },
      { order: 4, label: "Destroy 3 Skirmish Drones on the open laydowns", type: "kill", target: "Skirmish Drone", count: 3, world: "station" },
      { order: 5, label: "Destroy 2 Arc Lance Sentries — the lance takes almost a second to charge, so keep moving", type: "kill", target: "Arc Lance Sentry", count: 2, world: "station" },
      { order: 6, label: "Strip the disruptor hardware: collect 4 alloy scrap from the wrecks", type: "collect", target: "alloy_scrap", count: 4, world: "station" },
      { order: 7, label: "Hold the deck for two minutes without taking a hit — sprint with Shift and break line of sight behind the freight", type: "survive", target: "station", count: 4, world: "station" },
      { order: 8, label: "Press E on Zara Vex and close the incident", type: "interact", target: "Zara Vex", count: 1, world: "station" },
    ],
  },
  {
    quest_number: 9,
    world: "station",
    quest_line: "The Aether Compact",
    title: "Broker a trade compact between the hub and two worlds",
    reward_credits: 1510,
    duration_minutes: 2880,
    pre: ["Station Saboteur"],
    steps: [
      { order: 1, label: "Press E on Zara Vex to be given the compact and the hub seal", type: "interact", target: "Zara Vex", count: 1, world: "station" },
      { order: 2, label: "Step into the Ashfall Reach gateway and press E", type: "interact", target: "medieval", count: 1, world: "station" },
      { order: 3, label: "Arrive in Ashfall Reach", type: "visit", target: "medieval", count: 1, world: "medieval" },
      { order: 4, label: "Press E on the keeper beside the Ashfall gateway and put the compact to them", type: "talk", target: "lorekeeper", count: 1, world: "medieval" },
      { order: 5, label: "Ashfall wants payment in its own coin — collect 2 relic coin in Ashfall Reach", type: "collect", target: "relic_coin", count: 2, world: "medieval" },
      { order: 6, label: "Return to the station and step into the Sunspire Citadel gateway", type: "interact", target: "citadel", count: 1, world: "station" },
      { order: 7, label: "Arrive at Sunspire Citadel", type: "visit", target: "citadel", count: 1, world: "citadel" },
      { order: 8, label: "Press E on the keeper beside the Sunspire gateway and secure the second signature", type: "talk", target: "lorekeeper", count: 1, world: "citadel" },
      { order: 9, label: "Come home and press E on Dispatcher Ovie Kanu at the strip work board to lodge the signed compact", type: "interact", target: "Dispatcher Ovie Kanu", count: 1, world: "station" },
    ],
  },
  {
    quest_number: 10,
    world: "station",
    quest_line: "Nexus Council Envoy",
    title: "Carry the hub seat at the founding of the Nexus Council",
    reward_credits: 2320,
    duration_minutes: 5760,
    pre: ["The Aether Compact"],
    steps: [
      { order: 1, label: "Press E on Dispatcher Ovie Kanu at the strip work board — the hub credentials are waiting in her ledger", type: "interact", target: "Dispatcher Ovie Kanu", count: 1, world: "station" },
      { order: 2, label: "Show the credentials in Ashfall Reach — travel there through the plaza gateway", type: "visit", target: "medieval", count: 1, world: "medieval" },
      { order: 3, label: "Show them at the Meridian Athletic Complex", type: "visit", target: "sports", count: 1, world: "sports" },
      { order: 4, label: "Show them at Sunspire Citadel", type: "visit", target: "citadel", count: 1, world: "citadel" },
      { order: 5, label: "Show them at Vellum Ridge", type: "visit", target: "race", count: 1, world: "race" },
      { order: 6, label: "The sixth seat is the Verdant Coil. Step into its gateway on the plaza and press E", type: "interact", target: "maze", count: 1, world: "station" },
      { order: 7, label: "Stay inside the Verdant Coil for two minutes without taking damage — no weapons, no mounts, no map but the one in your head", type: "survive", target: "maze", count: 4, world: "maze" },
      { order: 8, label: "Back on the station, the sabotage attempt comes at the summit. Land 6 hits on Rogue Security Units to break it up", type: "defend", target: "Rogue Security Unit", count: 6, world: "station" },
      { order: 9, label: "Recover the shard the saboteurs were paid with", type: "collect", target: "nexus_shard", count: 1, world: "station" },
      { order: 10, label: "Press E on Zara Vex and take the hub seat", type: "interact", target: "Zara Vex", count: 1, world: "station" },
    ],
  },
  {
    quest_number: 101,
    world: "station",
    quest_line: "Boot Camp: Moving Around",
    title: "Learn to move: walk, sprint, crouch, jump, climb",
    reward_credits: 60,
    duration_minutes: 60,
    pre: null,
    steps: [
      { order: 1, label: "W A S D walks. Hold Shift to sprint — it drains stamina. Run down the concourse and pick up 2 credit drops with E", type: "collect", target: "credits", count: 2, world: "station" },
      { order: 2, label: "C (or Ctrl) crouches, Space jumps. Stay on your feet for one minute without taking a hit — use cover, do not stand in the open", type: "survive", target: "station", count: 2, world: "station" },
      { order: 3, label: "Hold Space at a wall to climb it, and tap Space at a ledge to mantle up. Get onto the upper decks and bring back alloy scrap", type: "collect", target: "alloy_scrap", count: 1, world: "station" },
    ],
  },
  {
    quest_number: 102,
    world: "station",
    quest_line: "The Panel Drill",
    title: "Learn the panels: J, I, the Esc hub, T and E",
    reward_credits: 130,
    duration_minutes: 90,
    pre: ["Boot Camp: Moving Around"],
    steps: [
      { order: 1, label: "J opens the quest board from anywhere, and Esc closes it. You can also walk up to Zara Vex and press E — do that now", type: "interact", target: "Zara Vex", count: 1, world: "station" },
      { order: 2, label: "Open the Esc menu and take Character. Change your outfit to the Jumpsuit", type: "customize", target: "jumpsuit", count: 1, world: "station" },
      { order: 3, label: "Still in Character: change your hair style to Ponytail. The Rebind keys row in the same menu is there if you would rather these keys were somewhere else", type: "customize", target: "ponytail", count: 1, world: "station" },
      { order: 4, label: "I opens your inventory and the 30-slot carry bag. Pick up a medkit and watch where it lands", type: "collect", target: "medkit", count: 1, world: "station" },
      { order: 5, label: "E starts a conversation with anyone friendly; T opens the comms box once you are talking. Press E on 2 station locals", type: "talk", target: "wanderer", count: 2, world: "station" },
    ],
  },
  {
    quest_number: 103,
    world: "station",
    quest_line: "Mount Up",
    title: "Learn the mounts: summon, ride, fly, dismount",
    reward_credits: 190,
    duration_minutes: 90,
    pre: ["Boot Camp: Moving Around"],
    steps: [
      { order: 1, label: "Mounts are bought at the tack shop at the far end of the strip. Press E on Rooke Ilesanmi and let him explain the rig", type: "talk", target: "Rooke Ilesanmi", count: 1, world: "station" },
      { order: 2, label: "Hold M for the mount wheel, aim at the Horse and release — or press 1-6 to pick straight off the wheel. Shift gallops. Ride the plaza and gather 3 credit drops", type: "collect", target: "credits", count: 3, world: "station" },
      { order: 3, label: "Hold M again and take the Dragon or the Eagle. Space climbs, Ctrl descends, the mouse steers. Bring back 2 alloy scrap from the high decks", type: "collect", target: "alloy_scrap", count: 2, world: "station" },
      { order: 4, label: "F dismounts. The Car, Bicycle and Hoverboard are on the same wheel — try them, then spend one minute on foot without taking damage", type: "survive", target: "station", count: 2, world: "station" },
    ],
  },
  {
    quest_number: 104,
    world: "station",
    quest_line: "Weapons Free",
    title: "Learn the weapons: four slots, ammo, aim and reload",
    reward_credits: 280,
    duration_minutes: 120,
    pre: ["Boot Camp: Moving Around"],
    steps: [
      { order: 1, label: "Stand near Ivo Selk at Selk Ordnance on the strip and press B to open the marketplace. Buy a bullet pack — that is where ammo comes from", type: "purchase", target: "bullet", count: 1, world: "station" },
      { order: 2, label: "R reloads, and it pulls from your bag. Keep it stocked: pick up 2 more bullet drops", type: "collect", target: "bullet", count: 2, world: "station" },
      { order: 3, label: "Press 1 for the machine gun. LMB fires, RMB aims down the sight, the mouse wheel cycles weapons. Destroy 2 Skirmish Drones", type: "kill", target: "Skirmish Drone", count: 2, world: "station" },
      { order: 4, label: "Press 2 for the ember caster and HOLD LMB to charge the fireball before you let go. Destroy 2 Rogue Security Units", type: "kill", target: "Rogue Security Unit", count: 2, world: "station" },
      { order: 5, label: "Press 4 for the sword — melee, no ammo, no reload. Let a Breaker Frame come to you and cut it down", type: "kill", target: "Breaker Frame", count: 1, world: "station" },
      { order: 6, label: "Press 3 for the recurve bow. Land 6 hits on Arc Lance Sentries — their lance charges for almost a second, so shoot and move", type: "defend", target: "Arc Lance Sentry", count: 6, world: "station" },
    ],
  },
  {
    quest_number: 105,
    world: "station",
    quest_line: "Talk to Everyone",
    title: "Learn to engage NPCs: who is who on the concourse",
    reward_credits: 220,
    duration_minutes: 120,
    pre: ["The Panel Drill"],
    steps: [
      { order: 1, label: "Traders sell and buy. Press E on 2 vendors — Oyo Tannen at the noodle stall and Anselm Kade on the plaza, Nell Abioye or Rooke Ilesanmi on the strip", type: "talk", target: "vendor", count: 2, world: "station" },
      { order: 2, label: "Not every work board is Zara Vex's. Press E on Dispatcher Ovie Kanu at the strip end of the concourse — quest managers open a board instead of a conversation, and this ring has six of them", type: "interact", target: "Dispatcher Ovie Kanu", count: 1, world: "station" },
      { order: 3, label: "Keepers stand beside the gateways and only talk about what is through their own arch. Press E on one", type: "talk", target: "lorekeeper", count: 1, world: "station" },
      { order: 4, label: "Everyone else is just station crew. Press E on 4 of them and see what they say back", type: "talk", target: "wanderer", count: 4, world: "station" },
      { order: 5, label: "Named people answer to their name. Press E on Marta Vale behind the bar at the Pale Horse", type: "talk", target: "Marta Vale", count: 1, world: "station" },
      { order: 6, label: "And press E on Rooke Ilesanmi at the tack shop", type: "talk", target: "Rooke Ilesanmi", count: 1, world: "station" },
      { order: 7, label: "Now the manager who runs the whole ring. Press E on Zara Vex at the concourse board", type: "interact", target: "Zara Vex", count: 1, world: "station" },
    ],
  },
  {
    quest_number: 106,
    world: "station",
    quest_line: "Merchant Trade",
    title: "Learn the marketplace: buying AND selling",
    reward_credits: 260,
    duration_minutes: 90,
    pre: ["Talk to Everyone"],
    steps: [
      { order: 1, label: "Find a trader and get within a few metres — press E to talk first so you know who you are dealing with", type: "talk", target: "vendor", count: 1, world: "station" },
      { order: 2, label: "Now press B to open the marketplace. Buy the medkit pack from someone who stocks field remedies — Oyo Tannen on the plaza does. You cannot buy what your bag has no room for, so check I first", type: "purchase", target: "medkit", count: 1, world: "station" },
      { order: 3, label: "Salvage is what you SELL. Gather 3 alloy scrap off the decks", type: "collect", target: "alloy_scrap", count: 3, world: "station" },
      { order: 4, label: "Open the marketplace again (B) and switch to the sell side. Sell 2 stacks back — you get less than you paid, that is the spread", type: "purchase", target: "sell", count: 2, world: "station" },
    ],
  },
  {
    quest_number: 107,
    world: "station",
    quest_line: "Bag and Store",
    title: "Learn the inventory: the store, the 30-slot bag, consumables",
    reward_credits: 240,
    duration_minutes: 90,
    pre: ["Merchant Trade"],
    steps: [
      { order: 1, label: "Press I. You have a STORE and a 30-slot carry bag; only what is in the bag is reachable in the field. Buy a bullet pack (B at Ivo Selk on the strip) and watch it split", type: "purchase", target: "bullet", count: 1, world: "station" },
      { order: 2, label: "Ammo you pick up goes to the bag until it is full, then overflows to the store. Collect 3 more bullet drops and watch it happen", type: "collect", target: "bullet", count: 3, world: "station" },
      { order: 3, label: "Consumables are used from the bag — open I and click a medkit to spend it. Pick up a medkit and use it", type: "collect", target: "medkit", count: 1, world: "station" },
      { order: 4, label: "Bulk salvage eats slots fast. Collect 3 alloy scrap and see the bag fill", type: "collect", target: "alloy_scrap", count: 3, world: "station" },
      { order: 5, label: "A full bag refuses pickups. Sell 2 stacks you are not carrying for a reason (B at a trader, sell side) to make room again", type: "purchase", target: "sell", count: 2, world: "station" },
    ],
  },
  {
    quest_number: 108,
    world: "station",
    quest_line: "Gateway Handbook",
    title: "Learn the gateways: how travel between worlds works",
    reward_credits: 420,
    duration_minutes: 240,
    pre: ["The Panel Drill"],
    steps: [
      { order: 1, label: "Six arches ring the plaza and each one has a keeper beside it. Press E on a keeper and ask what is through their arch", type: "talk", target: "lorekeeper", count: 1, world: "station" },
      { order: 2, label: "Walk into the Ashfall Reach arch and press E. The screen warps and you are gone", type: "interact", target: "medieval", count: 1, world: "station" },
      { order: 3, label: "You are in Ashfall Reach. Your quests, bag and credits came with you", type: "visit", target: "medieval", count: 1, world: "medieval" },
      { order: 4, label: "Every world but the hub has exactly ONE gateway and it goes home. Find it and press E", type: "interact", target: "station", count: 1, world: "medieval" },
      { order: 5, label: "Back on Aether Station — the hub is the only place you can change destination", type: "visit", target: "station", count: 1, world: "station" },
      { order: 6, label: "Now take a different arch: step into the Meridian Athletic Complex and press E", type: "interact", target: "sports", count: 1, world: "station" },
      { order: 7, label: "Arrive at the Meridian Athletic Complex", type: "visit", target: "sports", count: 1, world: "sports" },
      { order: 8, label: "Last lesson: some worlds change the rules. Step into the Verdant Coil arch — it allows no weapons and no mounts, and M becomes a map instead of the mount wheel", type: "interact", target: "maze", count: 1, world: "station" },
    ],
  },
  {
    quest_number: 109,
    world: "station",
    quest_line: "Field Medicine",
    title: "Learn to stay alive: cover, stamina and medkits",
    reward_credits: 150,
    duration_minutes: 60,
    pre: ["Boot Camp: Moving Around"],
    steps: [
      { order: 1, label: "Three minutes on the station without taking a single hit — any damage puts the timer back to zero. Sprint (Shift) to break line of sight, crouch (C) behind the freight", type: "survive", target: "station", count: 6, world: "station" },
      { order: 2, label: "Never travel without one. Pick up a medkit, then press I and click it to spend it — your health bar refills immediately", type: "collect", target: "medkit", count: 1, world: "station" },
    ],
  },
  {
    quest_number: 110,
    world: "station",
    quest_line: "Graduation Circuit",
    title: "Graduation: put every lesson together in one run",
    reward_credits: 750,
    duration_minutes: 480,
    pre: ["Boot Camp: Moving Around","The Panel Drill","Mount Up","Weapons Free","Talk to Everyone","Merchant Trade","Bag and Store","Gateway Handbook","Field Medicine"],
    steps: [
      { order: 1, label: "Press E on Zara Vex to sit the assessment", type: "interact", target: "Zara Vex", count: 1, world: "station" },
      { order: 2, label: "Panels: open the Esc menu, take Character, and put the station flight suit back on for the record", type: "customize", target: "flightsuit", count: 1, world: "station" },
      { order: 3, label: "Trade: press B at Oyo Tannen on the plaza and buy a medkit pack", type: "purchase", target: "medkit", count: 1, world: "station" },
      { order: 4, label: "Movement and loot: gather 3 alloy scrap across the decks — mounted (M) if you want it done faster", type: "collect", target: "alloy_scrap", count: 3, world: "station" },
      { order: 5, label: "Combat: destroy 3 Rogue Security Units with any weapon slot you like", type: "kill", target: "Rogue Security Unit", count: 3, world: "station" },
      { order: 6, label: "Survival: two clean minutes afterwards, no damage taken", type: "survive", target: "station", count: 4, world: "station" },
      { order: 7, label: "Travel: step into the Vellum Ridge gateway and press E", type: "interact", target: "race", count: 1, world: "station" },
      { order: 8, label: "Arrive at Vellum Ridge", type: "visit", target: "race", count: 1, world: "race" },
      { order: 9, label: "Come home and press E on Dispatcher Ovie Kanu at the strip work board to be signed off", type: "interact", target: "Dispatcher Ovie Kanu", count: 1, world: "station" },
    ],
  },
  {
    quest_number: 201,
    world: "station",
    quest_line: "Nexus Passport",
    title: "Set foot in every world the Nexus connects",
    reward_credits: 1270,
    duration_minutes: 2880,
    pre: ["Gateway Handbook","Nexus Cartographer"],
    steps: [
      { order: 1, label: "Start where every route starts: be on Aether Station with the passport open", type: "visit", target: "station", count: 1, world: "station" },
      { order: 2, label: "Step into the Ashfall Reach gateway and press E", type: "interact", target: "medieval", count: 1, world: "station" },
      { order: 3, label: "Stamp 1 of 5 — arrive in Ashfall Reach", type: "visit", target: "medieval", count: 1, world: "medieval" },
      { order: 4, label: "Return to the hub and step into the Meridian Athletic Complex gateway", type: "interact", target: "sports", count: 1, world: "station" },
      { order: 5, label: "Stamp 2 of 5 — arrive at the Meridian Athletic Complex", type: "visit", target: "sports", count: 1, world: "sports" },
      { order: 6, label: "Return to the hub and step into the Sunspire Citadel gateway", type: "interact", target: "citadel", count: 1, world: "station" },
      { order: 7, label: "Stamp 3 of 5 — arrive at Sunspire Citadel", type: "visit", target: "citadel", count: 1, world: "citadel" },
      { order: 8, label: "Return to the hub and step into the Vellum Ridge gateway", type: "interact", target: "race", count: 1, world: "station" },
      { order: 9, label: "Stamp 4 of 5 — arrive at Vellum Ridge", type: "visit", target: "race", count: 1, world: "race" },
      { order: 10, label: "Stamp 5 of 5 — the Verdant Coil issues no stamp to anyone who only walks in. Survive two unbroken minutes inside the maze", type: "survive", target: "maze", count: 4, world: "maze" },
    ],
  },
  {
    quest_number: 202,
    world: "station",
    quest_line: "Circuit Crown",
    title: "Race every circuit at Vellum Ridge and win one outright",
    reward_credits: 1720,
    duration_minutes: 4320,
    pre: ["Nexus Passport","Nexus Council Envoy"],
    steps: [
      { order: 1, label: "Step into the Vellum Ridge gateway on the plaza and press E", type: "interact", target: "race", count: 1, world: "station" },
      { order: 2, label: "Circuit 1 of 3 — enter and finish a race on the Vellum Ridge Circuit", type: "race", target: "vellum", count: 1, world: "race" },
      { order: 3, label: "Circuit 2 of 3 — enter and finish a race at Cinder Gorge", type: "race", target: "cinder", count: 1, world: "race" },
      { order: 4, label: "Circuit 3 of 3 — enter and finish a race at Aurora Rise", type: "race", target: "aurora", count: 1, world: "race" },
      { order: 5, label: "Now win one. Cross the line FIRST in any circuit race — a did-not-finish does not count", type: "race", target: "place_1", count: 1, world: "race" },
      { order: 6, label: "Press E on Kai Torres at Vellum Ridge to have the crown recorded", type: "interact", target: "Kai Torres", count: 1, world: "race" },
    ],
  },
  {
    quest_number: 203,
    world: "station",
    quest_line: "Shard Bearer",
    title: "Gather the Nexus tribute from every world that will pay it",
    reward_credits: 2740,
    duration_minutes: 10080,
    pre: ["Nexus Passport","Circuit Crown","The Aether Compact"],
    steps: [
      { order: 1, label: "Station tribute — recover a nexus shard from the station decks and caches", type: "collect", target: "nexus_shard", count: 1, world: "station" },
      { order: 2, label: "Station tribute — strip 5 alloy scrap out of the cargo yard", type: "collect", target: "alloy_scrap", count: 5, world: "station" },
      { order: 3, label: "Ashfall tribute — collect 3 relic coin in Ashfall Reach; they do not circulate anywhere else", type: "collect", target: "relic_coin", count: 3, world: "medieval" },
      { order: 4, label: "Ashfall tribute — find another nexus shard in the Ashfall caches", type: "collect", target: "nexus_shard", count: 1, world: "medieval" },
      { order: 5, label: "Sunspire tribute — collect 3 relic coin at Sunspire Citadel; nothing drops it there, so every one comes out of a cache", type: "collect", target: "relic_coin", count: 3, world: "citadel" },
      { order: 6, label: "Sunspire will not pay a courier who cannot survive the walk. Three unbroken minutes in the citadel without taking a hit", type: "survive", target: "citadel", count: 6, world: "citadel" },
      { order: 7, label: "Carrying that much tribute makes you a target. Break up the ambush on the station: destroy 5 Rogue Security Units", type: "kill", target: "Rogue Security Unit", count: 5, world: "station" },
      { order: 8, label: "Press E on Zara Vex and lay the whole tribute on the hub table", type: "interact", target: "Zara Vex", count: 1, world: "station" },
    ],
  },
  {
    quest_number: 11,
    world: "medieval",
    quest_line: "Vale Arrival",
    title: "Report to the reeve and take the measure of Aldermoor",
    reward_credits: 120,
    duration_minutes: 60,
    pre: null,
    steps: [
      { order: 1, label: "Press E on Edmund Marsh at his parchment-covered stall on the market square to take the vale's standing work", type: "interact", target: "Edmund Marsh", count: 1, world: "medieval" },
      { order: 2, label: "Press E on 3 villagers around the market cross and ask what has been happening in the vale", type: "talk", target: "wanderer", count: 3, world: "medieval" },
    ],
  },
  {
    quest_number: 12,
    world: "medieval",
    quest_line: "Market Day",
    title: "Open an account with the traders of Aldermoor",
    reward_credits: 260,
    duration_minutes: 120,
    pre: ["Vale Arrival"],
    steps: [
      { order: 1, label: "Press E on Goodman Alder at the market cross — he will price every stall on the square for you, unasked", type: "talk", target: "Goodman Alder", count: 1, world: "medieval" },
      { order: 2, label: "Press E on Wilda Sorrel at the herb stall on the north side of the market", type: "talk", target: "Wilda Sorrel", count: 1, world: "medieval" },
      { order: 3, label: "Stand within a few paces of Wilda and press B to open the market. Buy the Trauma Twin-Pack — two medkits in one bag slot", type: "purchase", target: "medkit", count: 1, world: "medieval" },
      { order: 4, label: "Walk down to Bram Tallow at the smithy and press B there. Buy the Arrow Bundle — the vale fights with the bow, and R reloads from your bag", type: "purchase", target: "arrow", count: 1, world: "medieval" },
    ],
  },
  {
    quest_number: 13,
    world: "medieval",
    quest_line: "Smoke on the Aldern Road",
    title: "Reopen the fleece road between the village and the keep",
    reward_credits: 340,
    duration_minutes: 150,
    pre: ["Vale Arrival"],
    steps: [
      { order: 1, label: "Press E on Tibb Marrow, the fleece carter, and let him tell you exactly what is wrong with the road", type: "talk", target: "Tibb Marrow", count: 1, world: "medieval" },
      { order: 2, label: "Dunn Pike's crew has the road shut south of the village. Put Pike down — he is a bowman, so close on him rather than trading shots", type: "kill", target: "Dunn Pike", count: 1, world: "medieval" },
      { order: 3, label: "Recover the shafts: pick up 2 arrow drops off the road (walk over a drop, or press E on it). Bodies and roadside caches both leave them", type: "collect", target: "arrow", count: 2, world: "medieval" },
    ],
  },
  {
    quest_number: 14,
    world: "medieval",
    quest_line: "The Reeve's Ledger",
    title: "Carry Aldermoor's tithe up to the hub and have it entered",
    reward_credits: 620,
    duration_minutes: 300,
    pre: ["Market Day","Trade Route Scouting"],
    steps: [
      { order: 1, label: "Press E on Edmund Marsh and take the tithe ledger and the reeve's seal", type: "interact", target: "Edmund Marsh", count: 1, world: "medieval" },
      { order: 2, label: "The tithe is paid in vale coin. Gather 2 relic coin — marauder bodies carry them and the hidden caches hold whole purses", type: "collect", target: "relic_coin", count: 2, world: "medieval" },
      { order: 3, label: "The hub wants one thing the vale cannot mint. Find a nexus shard — it comes out of a cache, not off a body", type: "collect", target: "nexus_shard", count: 1, world: "medieval" },
      { order: 4, label: "Press E on Captain Osric Vane at the keep gate and have him countersign the ledger", type: "talk", target: "Captain Osric Vane", count: 1, world: "medieval" },
      { order: 5, label: "Walk into the sarsen ring at the stone circle and press E — the gate opens onto Aether Station", type: "interact", target: "station", count: 1, world: "medieval" },
      { order: 6, label: "Arrive on Aether Station and let the ledger be entered against the vale", type: "visit", target: "station", count: 1, world: "station" },
    ],
  },
  {
    quest_number: 15,
    world: "medieval",
    quest_line: "Bread and Blessing",
    title: "Find the almoner somewhere on the castle road",
    reward_credits: 90,
    duration_minutes: 45,
    pre: null,
    steps: [
      { order: 1, label: "Sister Meriet walks the castle road between the shrine and the village all day and never waits for anyone. Catch her up and press E", type: "talk", target: "Sister Meriet", count: 1, world: "medieval" },
    ],
  },
  {
    quest_number: 16,
    world: "medieval",
    quest_line: "The Keep Watch",
    title: "Stand the south curtain with the Aldermoor garrison",
    reward_credits: 780,
    duration_minutes: 300,
    pre: ["Smoke on the Aldern Road"],
    steps: [
      { order: 1, label: "Press E on Captain Osric Vane at the keep gate and ask to be put on the watch roster", type: "talk", target: "Captain Osric Vane", count: 1, world: "medieval" },
      { order: 2, label: "Get up onto the south curtain — hold Space at the wall to climb, tap it at the ledge to mantle — and press E on Serjeant Hale on the western beat", type: "talk", target: "Serjeant Hale", count: 1, world: "medieval" },
      { order: 3, label: "Walk the deck east and press E on Watchman Pell. He will answer about a minute after you ask", type: "talk", target: "Watchman Pell", count: 1, world: "medieval" },
      { order: 4, label: "Sable Ida has been probing the glacis. Land 6 hits on her from the wall or the gate — every hit counts, she does not have to fall", type: "defend", target: "Sable Ida", count: 6, world: "medieval" },
      { order: 5, label: "Finish the watch clean: two unbroken minutes anywhere in the vale without taking a single hit. Any damage puts the timer back to zero", type: "survive", target: "medieval", count: 4, world: "medieval" },
    ],
  },
  {
    quest_number: 17,
    world: "medieval",
    quest_line: "The Broken Company",
    title: "Break the marauder company that has preyed on the vale since the levy",
    reward_credits: 1150,
    duration_minutes: 720,
    pre: ["The Keep Watch","Weapons Free"],
    steps: [
      { order: 1, label: "Press E on Captain Osric Vane and take the writ against the broken company", type: "talk", target: "Captain Osric Vane", count: 1, world: "medieval" },
      { order: 2, label: "Hollow Jack works the far bank east of the river. Ride out (hold M for the mount wheel) and put him down", type: "kill", target: "Hollow Jack", count: 1, world: "medieval" },
      { order: 3, label: "Marret the Crow keeps to the high woods north-east of the ford. Kill her", type: "kill", target: "Marret the Crow", count: 1, world: "medieval" },
      { order: 4, label: "Bregg Ashfoot patrols the western march beyond the parish church. Kill him", type: "kill", target: "Bregg Ashfoot", count: 1, world: "medieval" },
      { order: 5, label: "Thessa Bane holds the southern track below the mill. Kill her and the company has no captains left", type: "kill", target: "Thessa Bane", count: 1, world: "medieval" },
      { order: 6, label: "Take back what they took: recover 3 relic coin from the bodies and their caches", type: "collect", target: "relic_coin", count: 3, world: "medieval" },
      { order: 7, label: "Press E on Edmund Marsh and close the writ against the company", type: "interact", target: "Edmund Marsh", count: 1, world: "medieval" },
    ],
  },
  {
    quest_number: 18,
    world: "medieval",
    quest_line: "Relics of the Stone Circle",
    title: "Learn what the sarsen ring was raised to watch",
    reward_credits: 1330,
    duration_minutes: 1440,
    pre: ["The Reeve's Ledger","Nexus Cartographer"],
    steps: [
      { order: 1, label: "Press E on Corvin Ash, the hooded traveller who will not leave the ruined stone circle, and ask him what the stones were raised to watch", type: "talk", target: "Corvin Ash", count: 1, world: "medieval" },
      { order: 2, label: "Press E on the keeper standing beside the sky-gate itself and get the other half of the story", type: "talk", target: "lorekeeper", count: 1, world: "medieval" },
      { order: 3, label: "The ring answers to shard-stone. Recover a nexus shard from one of the vale's hidden caches", type: "collect", target: "nexus_shard", count: 1, world: "medieval" },
      { order: 4, label: "Old coin was left at the stones as offering and has been dug up since. Gather 3 relic coin", type: "collect", target: "relic_coin", count: 3, world: "medieval" },
      { order: 5, label: "You are not the only one digging. Old Culley is working the barrows west of the vale — kill him", type: "kill", target: "Old Culley", count: 1, world: "medieval" },
      { order: 6, label: "Fen Marlow is his partner in it, north of the ford. Kill him too", type: "kill", target: "Fen Marlow", count: 1, world: "medieval" },
      { order: 7, label: "Keep the vigil at the stones: two unbroken minutes without taking a hit", type: "survive", target: "medieval", count: 4, world: "medieval" },
      { order: 8, label: "Press E on Piety Lark at the Gilded Boar and give her the whole of it — she is composing an epic about the sky-gate and will put you in it", type: "talk", target: "Piety Lark", count: 1, world: "medieval" },
    ],
  },
  {
    quest_number: 19,
    world: "medieval",
    quest_line: "The Coin of Aldermoor",
    title: "Strike a vale coin the hub will accept at face value",
    reward_credits: 1630,
    duration_minutes: 2880,
    pre: ["Relics of the Stone Circle","Merchant Trade"],
    steps: [
      { order: 1, label: "Press E on Edmund Marsh and take the reeve's warrant to strike coin", type: "interact", target: "Edmund Marsh", count: 1, world: "medieval" },
      { order: 2, label: "Press E on Bram Tallow at the smithy — he cuts the dies, and he will charge double because it is decorative", type: "talk", target: "Bram Tallow", count: 1, world: "medieval" },
      { order: 3, label: "Press E on Rook Danby, his apprentice, who has theories about all of this and will not stop talking", type: "talk", target: "Rook Danby", count: 1, world: "medieval" },
      { order: 4, label: "Old coin is the metal. Gather 3 relic coin from bodies and caches to melt down", type: "collect", target: "relic_coin", count: 3, world: "medieval" },
      { order: 5, label: "Hard money to seed the mint: pick up 2 credit drops (every drop in the world carries some)", type: "collect", target: "credits", count: 2, world: "medieval" },
      { order: 6, label: "Raise the rest at market. Press B at any trader, switch to the sell side, and sell 2 stacks back — you get less than you paid, that is the spread", type: "purchase", target: "sell", count: 2, world: "medieval" },
      { order: 7, label: "Buy the mint a medkit pack out of the proceeds (B at Wilda Sorrel's herb stall) — a striker with a burned hand strikes nothing", type: "purchase", target: "medkit", count: 1, world: "medieval" },
      { order: 8, label: "The vale will not take coin from someone dressed like a gate-runner. Open the Esc menu, take Character, and put on the Tunic", type: "customize", target: "tunic", count: 1, world: "medieval" },
      { order: 9, label: "Press E on Goodman Alder at the market cross and have him cry the new rate across the square", type: "talk", target: "Goodman Alder", count: 1, world: "medieval" },
    ],
  },
  {
    quest_number: 20,
    world: "medieval",
    quest_line: "Lord of the Vale",
    title: "Answer for Aldermoor at the hub, and be answered",
    reward_credits: 2260,
    duration_minutes: 5760,
    pre: ["The Broken Company","The Coin of Aldermoor"],
    steps: [
      { order: 1, label: "Press E on Edmund Marsh and be given the vale's answer to carry", type: "interact", target: "Edmund Marsh", count: 1, world: "medieval" },
      { order: 2, label: "Press E on Captain Osric Vane — nothing leaves this valley for the sky-gate without the garrison knowing", type: "talk", target: "Captain Osric Vane", count: 1, world: "medieval" },
      { order: 3, label: "What is left of the company will try to stop it. Kill Rook Gant on the eastern road", type: "kill", target: "Rook Gant", count: 1, world: "medieval" },
      { order: 4, label: "Kill Sable Ida, who has been waiting on the glacis for exactly this", type: "kill", target: "Sable Ida", count: 1, world: "medieval" },
      { order: 5, label: "Wry Tam runs rather than fights. Land 8 hits on him before he gets clear of the woods", type: "defend", target: "Wry Tam", count: 8, world: "medieval" },
      { order: 6, label: "The vale sends tribute with its answer: gather 3 relic coin", type: "collect", target: "relic_coin", count: 3, world: "medieval" },
      { order: 7, label: "And one shard, so the hub knows the stones still work. Find a nexus shard in a cache", type: "collect", target: "nexus_shard", count: 1, world: "medieval" },
      { order: 8, label: "Hold the circle while the gate charges — three unbroken minutes in the vale without taking a hit", type: "survive", target: "medieval", count: 6, world: "medieval" },
      { order: 9, label: "Step into the sarsen ring and press E", type: "interact", target: "station", count: 1, world: "medieval" },
      { order: 10, label: "Arrive on Aether Station carrying the vale's answer, and take Aldermoor's seat at the hub table", type: "visit", target: "station", count: 1, world: "station" },
    ],
  },
  {
    quest_number: 21,
    world: "sports",
    quest_line: "Opening Ceremony",
    title: "Sign in for the season at the Meridian grounds board",
    reward_credits: 90,
    duration_minutes: 45,
    pre: null,
    steps: [
      { order: 1, label: "Arrive at the Meridian Athletic Grounds — the gate desk logs you the moment you set foot on the plaza", type: "visit", target: "sports", count: 1, world: "sports" },
      { order: 2, label: "Walk up the avenue and press E on Petra Vance at the grounds board to sign in for the season", type: "interact", target: "Petra Vance", count: 1, world: "sports" },
    ],
  },
  {
    quest_number: 22,
    world: "sports",
    quest_line: "Groundskeeper's Round",
    title: "Walk the greens and the courts with the groundskeeper",
    reward_credits: 170,
    duration_minutes: 120,
    pre: null,
    steps: [
      { order: 1, label: "Press E on Bernard \"Bernie\" Ashgrove out on the mown greens — forty years of stripes and he wants you to see what got walked over", type: "talk", target: "Bernard \"Bernie\" Ashgrove", count: 1, world: "sports" },
      { order: 2, label: "Someone has been stripping fittings. Recover 2 alloy scrap — the drones drop it, and the supply caches hold it in bulk", type: "collect", target: "alloy_scrap", count: 2, world: "sports" },
      { order: 3, label: "Press E on Deborah Quint-Halloway at the courts and let her tell you which net posts are missing bolts", type: "talk", target: "Deborah Quint-Halloway", count: 1, world: "sports" },
    ],
  },
  {
    quest_number: 23,
    world: "sports",
    quest_line: "Perimeter Sweep",
    title: "Clear the security drones off the car park approach",
    reward_credits: 130,
    duration_minutes: 60,
    pre: null,
    steps: [
      { order: 1, label: "Destroy 3 Rogue Security Units on the car park approach — decommissioned facility drones still running their last patrol order, and they are all over 80 m out from the gate", type: "kill", target: "Rogue Security Unit", count: 3, world: "sports" },
    ],
  },
  {
    quest_number: 24,
    world: "sports",
    quest_line: "Kit Check",
    title: "Stock up at the kit stand and clear the lost-property shelf",
    reward_credits: 340,
    duration_minutes: 180,
    pre: ["Merchant Trade"],
    steps: [
      { order: 1, label: "Find the kit and refreshments stand and press E on the trader behind it before you buy anything", type: "talk", target: "vendor", count: 1, world: "sports" },
      { order: 2, label: "Press B to open the marketplace and buy the medkit twin-pack — you cannot buy what your bag has no room for, so check I first", type: "purchase", target: "medkit", count: 1, world: "sports" },
      { order: 3, label: "Lost property is salvage. Gather 2 alloy scrap off the site", type: "collect", target: "alloy_scrap", count: 2, world: "sports" },
      { order: 4, label: "Open the marketplace again (B) and switch to the sell side. Sell 2 stacks back — you get less than you paid, that is the spread", type: "purchase", target: "sell", count: 2, world: "sports" },
    ],
  },
  {
    quest_number: 25,
    world: "sports",
    quest_line: "Bowl and Piste",
    title: "Earn your stripes in the bowl and beat the ghost on the mound",
    reward_credits: 520,
    duration_minutes: 300,
    pre: ["Opening Ceremony"],
    steps: [
      { order: 1, label: "Press E on Marisol \"Ripgrind\" Vance on the coping — nineteen years of this bowl, and she will not let you drop in without checking your helmet strap", type: "talk", target: "Marisol \"Ripgrind\" Vance", count: 1, world: "sports" },
      { order: 2, label: "Open the Esc menu, take Character, and change into the Sports kit. You are not skating the deep end in a flight suit", type: "customize", target: "sportskit", count: 1, world: "sports" },
      { order: 3, label: "Press E on Kjell Nordvik at the foot of the ski mound and let him talk you down the fall line", type: "talk", target: "Kjell Nordvik", count: 1, world: "sports" },
      { order: 4, label: "Now beat him. Walk up the Meridian Downhill mound and press E to start the slalom — gates down the middle piste against Kjell's ghost time, a missed gate costs 2 seconds, and the win pays 10 credits", type: "minigame", target: "ski_slalom_won", count: 1, world: "sports" },
      { order: 5, label: "Every session ends at the first-aid box. Pick up a medkit from a cache or a wreck", type: "collect", target: "medkit", count: 1, world: "sports" },
    ],
  },
  {
    quest_number: 26,
    world: "sports",
    quest_line: "Deep End Duty",
    title: "Stand a shift on the lido and take the swim record off the lifeguard",
    reward_credits: 660,
    duration_minutes: 360,
    pre: ["Groundskeeper's Round","Gateway Handbook"],
    steps: [
      { order: 1, label: "Press E on Tavius Okonkwo on the lido deck — a lifeguard who has never once had to rescue anybody and is professionally furious about it", type: "talk", target: "Tavius Okonkwo", count: 1, world: "sports" },
      { order: 2, label: "Restock the poolside first-aid box: collect 2 medkits. There is a supply cache on the bottom of the pool if you are willing to dive for it", type: "collect", target: "medkit", count: 2, world: "sports" },
      { order: 3, label: "Win the Lido Swim Challenge — press E on the pool deck to start, then swim two lengths and touch the walls faster than Tavius's pace. The win pays 10 credits", type: "minigame", target: "swim_challenge_won", count: 1, world: "sports" },
      { order: 4, label: "Two drones have drifted in off the perimeter. Destroy 2 Rogue Security Units before they reach the water", type: "kill", target: "Rogue Security Unit", count: 2, world: "sports" },
      { order: 5, label: "Open the Esc menu, take Character, and put on the Peaked cap — nobody takes a bare-headed lifeguard seriously", type: "customize", target: "cap", count: 1, world: "sports" },
      { order: 6, label: "Press E on the keeper standing beside the Aether Station arch and log the shift with the hub", type: "talk", target: "lorekeeper", count: 1, world: "sports" },
    ],
  },
  {
    quest_number: 27,
    world: "sports",
    quest_line: "Car Park Lockdown",
    title: "Take the far car park back off the security drones",
    reward_credits: 1060,
    duration_minutes: 720,
    pre: ["Perimeter Sweep","Weapons Free"],
    steps: [
      { order: 1, label: "Press E on Priya Raghunathan between intervals on the track — she runs the outer loop past the car park and has counted what is out there", type: "talk", target: "Priya Raghunathan", count: 1, world: "sports" },
      { order: 2, label: "Destroy 5 Rogue Security Units. They patrol fixed routes across the car park and the outer perimeter, so pull them one at a time rather than walking into the middle", type: "kill", target: "Rogue Security Unit", count: 5, world: "sports" },
      { order: 3, label: "Land 8 hits on Rogue Security Units — every shot that connects counts, so keep firing while you fall back between the parked rows", type: "defend", target: "Rogue Security Unit", count: 8, world: "sports" },
      { order: 4, label: "Restock as you go: pick up 3 bullet drops off the wrecks", type: "collect", target: "bullet", count: 3, world: "sports" },
      { order: 5, label: "Strip the patrol hardware: recover 2 alloy scrap from the destroyed units", type: "collect", target: "alloy_scrap", count: 2, world: "sports" },
      { order: 6, label: "Hold the car park for two minutes without taking a hit — sprint with Shift and break line of sight behind the parked rows", type: "survive", target: "sports", count: 4, world: "sports" },
      { order: 7, label: "Press E on Petra Vance at the grounds board and report the car park clear", type: "interact", target: "Petra Vance", count: 1, world: "sports" },
    ],
  },
  {
    quest_number: 28,
    world: "sports",
    quest_line: "The Meridian Trials",
    title: "Enter every discipline the grounds run in one afternoon",
    reward_credits: 1210,
    duration_minutes: 1440,
    pre: ["Bowl and Piste","Kit Check"],
    steps: [
      { order: 1, label: "Open the Esc menu, take Character, and change into the Tracksuit — the trials have a dress code and the officials enforce it", type: "customize", target: "tracksuit", count: 1, world: "sports" },
      { order: 2, label: "Discipline 1 of 5 — press E on Marisol \"Ripgrind\" Vance at the skate bowl and enter the bowl session", type: "talk", target: "Marisol \"Ripgrind\" Vance", count: 1, world: "sports" },
      { order: 3, label: "Discipline 2 of 5 — ride the Meridian Downhill: press E on the ski mound to start the slalom and carry it through the finish gate. A finished run counts whatever the clock says; a win pays 10 credits on top", type: "minigame", target: "ski_slalom", count: 1, world: "sports" },
      { order: 4, label: "Discipline 3 of 5 — play a full tennis match against Deborah at the Meridian court: press E courtside to start, F to swing, best of three games. Win or lose, a completed match counts; a win pays 10 credits", type: "minigame", target: "tennis_match", count: 1, world: "sports" },
      { order: 5, label: "Discipline 4 of 5 — swim the Lido Challenge: press E on the pool deck, then two full lengths, wall to wall. Finishing is what counts today; beat the pace and it pays 10 credits", type: "minigame", target: "swim_challenge", count: 1, world: "sports" },
      { order: 6, label: "Discipline 5 of 5 — press E on Priya Raghunathan on the running track and enter the middle distance", type: "talk", target: "Priya Raghunathan", count: 1, world: "sports" },
      { order: 7, label: "Two clean minutes on the grounds with no damage taken — a trial you finish bleeding is a trial you did not finish", type: "survive", target: "sports", count: 4, world: "sports" },
      { order: 8, label: "Press E on Petra Vance and have the five entries signed off as a single card", type: "interact", target: "Petra Vance", count: 1, world: "sports" },
    ],
  },
  {
    quest_number: 29,
    world: "sports",
    quest_line: "Grounds Under Siege",
    title: "Break the drone push before it reaches the plaza",
    reward_credits: 1540,
    duration_minutes: 2880,
    pre: ["Car Park Lockdown","Deep End Duty"],
    steps: [
      { order: 1, label: "Press E on Bernard \"Bernie\" Ashgrove — he saw them come over the boundary and he is more upset about the lawn than about the drones", type: "talk", target: "Bernard \"Bernie\" Ashgrove", count: 1, world: "sports" },
      { order: 2, label: "Destroy 8 Rogue Security Units across the perimeter. They respawn, so this is a sustained fight rather than a single clearance", type: "kill", target: "Rogue Security Unit", count: 8, world: "sports" },
      { order: 3, label: "Land 12 hits on Rogue Security Units — chip them down from cover instead of trading in the open", type: "defend", target: "Rogue Security Unit", count: 12, world: "sports" },
      { order: 4, label: "Strip 3 alloy scrap out of the wreckage for the repair bill", type: "collect", target: "alloy_scrap", count: 3, world: "sports" },
      { order: 5, label: "The club plays on. Win the ladder final at the Meridian tennis court — press E courtside to start, F to swing, best of three games against Deborah, who is not cancelling tennis for a drone incursion. The win pays 10 credits", type: "minigame", target: "tennis_match_won", count: 1, world: "sports" },
      { order: 6, label: "One of them was carrying something it should not have been. Recover a nexus shard — the supply caches hold them too", type: "collect", target: "nexus_shard", count: 1, world: "sports" },
      { order: 7, label: "Restock the first-aid boxes the fight emptied: collect 2 medkits", type: "collect", target: "medkit", count: 2, world: "sports" },
      { order: 8, label: "Hold the grounds for three unbroken minutes without taking a hit — any damage puts the timer back to zero", type: "survive", target: "sports", count: 6, world: "sports" },
      { order: 9, label: "Press E on Petra Vance and close the incident", type: "interact", target: "Petra Vance", count: 1, world: "sports" },
    ],
  },
  {
    quest_number: 30,
    world: "sports",
    quest_line: "Meridian Hall of Fame",
    title: "Be inducted into the Meridian Hall of Fame",
    reward_credits: 2260,
    duration_minutes: 5760,
    pre: ["The Meridian Trials","Grounds Under Siege","Nexus Passport"],
    steps: [
      { order: 1, label: "Press E on Petra Vance at the grounds board to accept the nomination", type: "interact", target: "Petra Vance", count: 1, world: "sports" },
      { order: 2, label: "Open the Esc menu, take Character, and put on the Headband. Every photograph in that corridor has one in it", type: "customize", target: "band", count: 1, world: "sports" },
      { order: 3, label: "Record 1 of 3 — win the Lido Swim Challenge: press E on the pool deck, two lengths, and touch home ahead of Tavius's pace. The win pays 10 credits", type: "minigame", target: "swim_challenge_won", count: 1, world: "sports" },
      { order: 4, label: "Record 2 of 3 — win the Meridian Downhill: press E on the ski mound, make every gate on the middle piste, and beat Kjell's ghost to the line. The win pays 10 credits", type: "minigame", target: "ski_slalom_won", count: 1, world: "sports" },
      { order: 5, label: "Record 3 of 3 — win the tennis match: press E at the Meridian court, F to swing, and take the best of three off Deborah. The win pays 10 credits", type: "minigame", target: "tennis_match_won", count: 1, world: "sports" },
      { order: 6, label: "The drones always come back for a ceremony. Destroy 6 Rogue Security Units before the induction", type: "kill", target: "Rogue Security Unit", count: 6, world: "sports" },
      { order: 7, label: "Recover the nexus shard the last one was carrying", type: "collect", target: "nexus_shard", count: 1, world: "sports" },
      { order: 8, label: "Gather 4 credit drops off the field — the trophy fund pays for itself", type: "collect", target: "credits", count: 4, world: "sports" },
      { order: 9, label: "Three unbroken minutes on the grounds without taking a hit, so the record stands clean", type: "survive", target: "sports", count: 6, world: "sports" },
      { order: 10, label: "Walk into the Aether Station arch on the plaza and press E — the plaque is cast at the hub, and you have to carry the record there yourself", type: "interact", target: "station", count: 1, world: "sports" },
    ],
  },
  {
    quest_number: 31,
    world: "citadel",
    quest_line: "The Cliff Gate",
    title: "Present yourself at the Sunspire gate and walk the lower souk",
    reward_credits: 130,
    duration_minutes: 60,
    pre: null,
    steps: [
      { order: 1, label: "The player spawn is just inside the gate. Walk up the ramp and press E on Aldric Storne of the Citadel garrison to be entered on the roll", type: "interact", target: "Aldric Storne", count: 1, world: "citadel" },
      { order: 2, label: "Press E on all three of the citadel's counters — Rafiq the Keeper, Hafsa the Dyer, Bashir the Ostler — and find out what a stranger is worth here", type: "talk", target: "vendor", count: 3, world: "citadel" },
    ],
  },
  {
    quest_number: 32,
    world: "citadel",
    quest_line: "Cloth and Cordage",
    title: "Open an account at the cloth stall inside the gate",
    reward_credits: 280,
    duration_minutes: 120,
    pre: ["The Cliff Gate"],
    steps: [
      { order: 1, label: "Press E on Hafsa the Dyer at the cloth stall just inside the gate — she knows every roof in the souk and will say so", type: "talk", target: "Hafsa the Dyer", count: 1, world: "citadel" },
      { order: 2, label: "Hafsa deals in cloth and tools, not medicine. Walk twenty paces to Rafiq the Keeper's counter — Archive & Physic — press B and buy the Trauma Twin-Pack. Nothing on this rock heals you for free", type: "purchase", target: "medkit", count: 1, world: "citadel" },
      { order: 3, label: "Sunspire prices in relic coin and nothing here drops it — it sits in the hidden caches on the roofs and terraces. Climb up and recover 1", type: "collect", target: "relic_coin", count: 1, world: "citadel" },
      { order: 4, label: "Press B again, switch to the sell side, and sell a stack back to Hafsa. You get less than you paid; that is the spread", type: "purchase", target: "sell", count: 1, world: "citadel" },
    ],
  },
  {
    quest_number: 33,
    world: "citadel",
    quest_line: "The Ostler's Round",
    title: "Walk the terraces from the horse lines to the great tower",
    reward_credits: 320,
    duration_minutes: 150,
    pre: ["The Cliff Gate"],
    steps: [
      { order: 1, label: "Press E on Bashir the Ostler at the horse lines below the wall — gruff, fond of his animals, and the only man here who will tell you where the ramps are", type: "talk", target: "Bashir the Ostler", count: 1, world: "citadel" },
      { order: 2, label: "Climb the terraces to the inner ward and press E on Yusra the Falconer, who flies the eagles off the great tower and watches everything", type: "talk", target: "Yusra the Falconer", count: 1, world: "citadel" },
      { order: 3, label: "Get back down to the gate without being touched — one unbroken minute on the terraces with no damage taken", type: "survive", target: "citadel", count: 2, world: "citadel" },
    ],
  },
  {
    quest_number: 34,
    world: "citadel",
    quest_line: "Terrace Patrol",
    title: "Clear the sentinel ring off the plateau approaches",
    reward_credits: 700,
    duration_minutes: 300,
    pre: ["The Ostler's Round","Weapons Free"],
    steps: [
      { order: 1, label: "Press E on Aldric Storne and take the patrol order for the plateau approaches", type: "interact", target: "Aldric Storne", count: 1, world: "citadel" },
      { order: 2, label: "The sentinels stand in a ring out on the open rock, well clear of the souk. Destroy 3 of them — there is no cover out there, so keep moving", type: "kill", target: "Sentinel", count: 3, world: "citadel" },
      { order: 3, label: "Strip the wrecks for ammunition: pick up 2 arrow drops", type: "collect", target: "arrow", count: 2, world: "citadel" },
      { order: 4, label: "Take the pay off them too — collect 2 credit drops", type: "collect", target: "credits", count: 2, world: "citadel" },
      { order: 5, label: "Then get off the open ground: one clean minute back inside the walls without taking a hit", type: "survive", target: "citadel", count: 2, world: "citadel" },
      { order: 6, label: "Press E on Hafsa the Dyer and let her patch what the sentinels did to your kit", type: "talk", target: "Hafsa the Dyer", count: 1, world: "citadel" },
    ],
  },
  {
    quest_number: 35,
    world: "citadel",
    quest_line: "The Sunspire Tithe",
    title: "Find the citadel's hidden coin without asking anyone where it is",
    reward_credits: 150,
    duration_minutes: 60,
    pre: null,
    steps: [
      { order: 1, label: "No sentinel on this rock carries relic coin — every piece of it is in a hidden cache, and the caches here are on the roofs, the terraces and the tower tops. Climb (hold Space at a wall, tap it at a ledge) and recover 2", type: "collect", target: "relic_coin", count: 2, world: "citadel" },
    ],
  },
  {
    quest_number: 36,
    world: "citadel",
    quest_line: "Rope Bridge Run",
    title: "Cross the minaret bridges and clear the tower tops",
    reward_credits: 850,
    duration_minutes: 300,
    pre: ["Terrace Patrol"],
    steps: [
      { order: 1, label: "Press E on Yusra the Falconer — she flies the towers and knows which of the rope bridges will still take a person", type: "talk", target: "Yusra the Falconer", count: 1, world: "citadel" },
      { order: 2, label: "Get up onto the bridges and stay up there: two unbroken minutes without taking a hit. You can fall between the planks, so walk them, do not sprint them", type: "survive", target: "citadel", count: 4, world: "citadel" },
      { order: 3, label: "The tower tops are where the richest caches sit. Recover 2 relic coin from up there", type: "collect", target: "relic_coin", count: 2, world: "citadel" },
      { order: 4, label: "Come back down the outside and destroy 2 sentinels on the rock below", type: "kill", target: "Sentinel", count: 2, world: "citadel" },
      { order: 5, label: "Press E on Aldric Storne and report the bridges sound", type: "interact", target: "Aldric Storne", count: 1, world: "citadel" },
    ],
  },
  {
    quest_number: 37,
    world: "citadel",
    quest_line: "The Archive of Rafiq",
    title: "Get into the citadel archive and out again with what it holds",
    reward_credits: 1180,
    duration_minutes: 720,
    pre: ["Rope Bridge Run","Nexus Cartographer"],
    steps: [
      { order: 1, label: "Press E on Rafiq the Keeper at the archive door. He speaks in riddles about the old order and will not simply hand you anything", type: "talk", target: "Rafiq the Keeper", count: 1, world: "citadel" },
      { order: 2, label: "Press E on the keeper standing beside the sky-gate at the cliff edge and get the version the citadel does not tell", type: "talk", target: "lorekeeper", count: 1, world: "citadel" },
      { order: 3, label: "The archive door answers to shard-stone. Find a nexus shard — sentinels drop them rarely, the caches carry them reliably", type: "collect", target: "nexus_shard", count: 1, world: "citadel" },
      { order: 4, label: "Rafiq wants the fee in old coin. Recover 3 relic coin from the roof and terrace caches", type: "collect", target: "relic_coin", count: 3, world: "citadel" },
      { order: 5, label: "The garrison does not want the archive opened. Destroy 4 sentinels as they close on the ward", type: "kill", target: "Sentinel", count: 4, world: "citadel" },
      { order: 6, label: "Nobody walks into that archive dressed as a gate-runner. Open the Esc menu, take Character, and put on the Robe", type: "customize", target: "robe", count: 1, world: "citadel" },
      { order: 7, label: "Press E on Aldric Storne and put the archive's answer in front of him, whether he wanted it or not", type: "interact", target: "Aldric Storne", count: 1, world: "citadel" },
    ],
  },
  {
    quest_number: 38,
    world: "citadel",
    quest_line: "The Sunspire Garrison",
    title: "Break the sentinel ring outright and hold the plateau",
    reward_credits: 1420,
    duration_minutes: 1440,
    pre: ["The Archive of Rafiq","Station Saboteur"],
    steps: [
      { order: 1, label: "Press E on Aldric Storne and take the order to break the ring, not just thin it", type: "interact", target: "Aldric Storne", count: 1, world: "citadel" },
      { order: 2, label: "Destroy 6 sentinels. They stand in a ring at about sixty metres out, which means no two of them are ever in the same fight unless you make them be", type: "kill", target: "Sentinel", count: 6, world: "citadel" },
      { order: 3, label: "Strip the emplacements: collect 3 crown-coin drops off the wrecks — the garrison is paid in old coin like everyone else here", type: "collect", target: "relic_coin", count: 3, world: "citadel" },
      { order: 4, label: "Recover a medkit from the field — you will want it before this is over", type: "collect", target: "medkit", count: 1, world: "citadel" },
      { order: 5, label: "And take the garrison's pay: 3 credit drops", type: "collect", target: "credits", count: 3, world: "citadel" },
      { order: 6, label: "Hold the cleared ground: two unbroken minutes on the plateau without taking a hit", type: "survive", target: "citadel", count: 4, world: "citadel" },
      { order: 7, label: "Press E on Bashir the Ostler and get the horse lines moved back out onto the rock", type: "talk", target: "Bashir the Ostler", count: 1, world: "citadel" },
      { order: 8, label: "Press E on Rafiq the Keeper and have the day entered in the archive, which is the only record this place keeps", type: "talk", target: "Rafiq the Keeper", count: 1, world: "citadel" },
    ],
  },
  {
    quest_number: 39,
    world: "citadel",
    quest_line: "Salt, Cloth and Coin",
    title: "Put a Sunspire trade ledger in front of the hub",
    reward_credits: 1690,
    duration_minutes: 2880,
    pre: ["The Sunspire Garrison","Merchant Trade"],
    steps: [
      { order: 1, label: "Press E on Aldric Storne and take the citadel's trade ledger", type: "interact", target: "Aldric Storne", count: 1, world: "citadel" },
      { order: 2, label: "Press E on Hafsa the Dyer — the cloth stall by the gate is the whole of Sunspire's export trade and she keeps its prices in her head", type: "talk", target: "Hafsa the Dyer", count: 1, world: "citadel" },
      { order: 3, label: "A ledger needs every counter on it. Press B at Rafiq the Keeper's — Archive & Physic — and buy the Trauma Twin-Pack for the health line", type: "purchase", target: "medkit", count: 1, world: "citadel" },
      { order: 4, label: "Then Bashir the Ostler's — Harness & Arms — for the Arrow Bundle. The citadel prices ammunition higher than anywhere in the Nexus and the hub needs to see it", type: "purchase", target: "arrow", count: 1, world: "citadel" },
      { order: 5, label: "Enter the coin line: recover 3 relic coin from the caches, since nothing here drops it", type: "collect", target: "relic_coin", count: 3, world: "citadel" },
      { order: 6, label: "Now the other half of a market. Press B, switch to the sell side, and sell 2 stacks back so the ledger shows the spread", type: "purchase", target: "sell", count: 2, world: "citadel" },
      { order: 7, label: "Press E on Bashir the Ostler and get the freight rate down the cliff road out of him", type: "talk", target: "Bashir the Ostler", count: 1, world: "citadel" },
      { order: 8, label: "Walk into the sky-gate at the cliff edge and press E", type: "interact", target: "station", count: 1, world: "citadel" },
      { order: 9, label: "Arrive on Aether Station and lodge the Sunspire ledger with the hub", type: "visit", target: "station", count: 1, world: "station" },
    ],
  },
  {
    quest_number: 40,
    world: "citadel",
    quest_line: "The Sunspire Compact",
    title: "Bind Sunspire, Aldermoor and the hub into one compact",
    reward_credits: 2560,
    duration_minutes: 7200,
    pre: ["Salt, Cloth and Coin","The Aether Compact","Lord of the Vale"],
    steps: [
      { order: 1, label: "Press E on Aldric Storne and be given the compact and the citadel's seal", type: "interact", target: "Aldric Storne", count: 1, world: "citadel" },
      { order: 2, label: "Press E on Rafiq the Keeper — no compact leaves this rock without the archive knowing its wording", type: "talk", target: "Rafiq the Keeper", count: 1, world: "citadel" },
      { order: 3, label: "Sunspire signs in its own coin. Recover 3 relic coin from the terrace and tower caches", type: "collect", target: "relic_coin", count: 3, world: "citadel" },
      { order: 4, label: "And one nexus shard, so the far end knows the gate here still holds", type: "collect", target: "nexus_shard", count: 1, world: "citadel" },
      { order: 5, label: "Somebody would rather this was not signed. Destroy 5 sentinels on the approaches while the seal is being cut", type: "kill", target: "Sentinel", count: 5, world: "citadel" },
      { order: 6, label: "Hold the ward until it is: three unbroken minutes without taking a hit", type: "survive", target: "citadel", count: 6, world: "citadel" },
      { order: 7, label: "Step into the sky-gate at the cliff edge and press E", type: "interact", target: "station", count: 1, world: "citadel" },
      { order: 8, label: "Take the hub gateway on to Aldermoor Vale and arrive there carrying the compact", type: "visit", target: "medieval", count: 1, world: "medieval" },
      { order: 9, label: "Press E on Edmund Marsh at his stall on the Aldermoor market square and get the vale's mark beside the citadel's", type: "interact", target: "Edmund Marsh", count: 1, world: "medieval" },
      { order: 10, label: "Come the whole way home through the hub, climb to the inner ward and press E on Yusra the Falconer — she will have watched you come up the cliff road", type: "talk", target: "Yusra the Falconer", count: 1, world: "citadel" },
    ],
  },
  {
    quest_number: 131,
    world: "citadel",
    quest_line: "The Outer Road",
    title: "Walk out to the Caravanserai and learn the jump on flat ground",
    reward_credits: 240,
    duration_minutes: 120,
    pre: ["The Cliff Gate"],
    steps: [
      { order: 1, label: "Press E on Aldric Storne and take the survey of the outer road — the garrison has not had a report off the flats in a year", type: "interact", target: "Aldric Storne", count: 1, world: "citadel" },
      { order: 2, label: "Walk out east across the sand to the Caravanserai and run the Caravanserai Round. Every crossing on it is a standing jump: this is where you learn the distance before anything asks you for it", type: "minigame", target: "citadel_serai_circuit", count: 1, world: "citadel" },
      { order: 3, label: "Climb the five-storey mast in the north-east corner and take what is cached at the head of it — 1 relic coin", type: "collect", target: "relic_coin", count: 1, world: "citadel" },
    ],
  },
  {
    quest_number: 132,
    world: "citadel",
    quest_line: "Down the Undercliff",
    title: "Take the terraced town down the shoulder and come back up it",
    reward_credits: 520,
    duration_minutes: 180,
    pre: ["The Outer Road"],
    steps: [
      { order: 1, label: "Press E on Yusra the Falconer in the inner ward. She flies the shoulder and can tell you where the terraces start and where the thatch is", type: "talk", target: "Yusra the Falconer", count: 1, world: "citadel" },
      { order: 2, label: "Go north-west off the mesa and run the Undercliff Terrace, end to end. Sprint jumps the whole way — hold Shift and do not stop at the lips", type: "minigame", target: "citadel_undercliff_run", count: 1, world: "citadel" },
      { order: 3, label: "Then go down the terraces properly. Every terrace change is a ten-metre drop with hay under it — take them, and take 2 relic coin off the terrace cache and whatever else is up there", type: "collect", target: "relic_coin", count: 2, world: "citadel" },
      { order: 4, label: "Get back up to the watchtower without taking a hit: one unbroken minute, and a fall you misjudge counts", type: "survive", target: "citadel", count: 2, world: "citadel" },
    ],
  },
  {
    quest_number: 133,
    world: "citadel",
    quest_line: "The Quarry Adit",
    title: "Go down the gantries into the Deepworks and into the mine",
    reward_credits: 780,
    duration_minutes: 240,
    pre: ["The Outer Road"],
    steps: [
      { order: 1, label: "Press E on Bashir the Ostler at the horse lines. The quarry road is his — nothing came off that pit that a mule did not carry", type: "talk", target: "Bashir the Ostler", count: 1, world: "citadel" },
      { order: 2, label: "Ride or walk east to the Deepworks and run the Deepworks Plunge, rim to pit floor down the seven gantries. Every drop on it is survivable; none of them is comfortable", type: "minigame", target: "citadel_deepworks_plunge", count: 1, world: "citadel" },
      { order: 3, label: "The adit is cut into the pit wall and it is lit. Go in, follow the gallery to the winze and bring out 2 relic coin", type: "collect", target: "relic_coin", count: 2, world: "citadel" },
      { order: 4, label: "There is a field kit on the ledge above the winze. Take it — 1 medkit", type: "collect", target: "medkit", count: 1, world: "citadel" },
      { order: 5, label: "Press E on Aldric Storne and put the pit on the garrison's map, which it has never been", type: "interact", target: "Aldric Storne", count: 1, world: "citadel" },
    ],
  },
  {
    quest_number: 134,
    world: "citadel",
    quest_line: "The Long Water",
    title: "Run the aqueduct from the massif and find what is under it",
    reward_credits: 1120,
    duration_minutes: 360,
    pre: ["Down the Undercliff"],
    steps: [
      { order: 1, label: "Press E on Rafiq the Keeper. The archive has the survey drawings for the water and he will want them back", type: "talk", target: "Rafiq the Keeper", count: 1, world: "citadel" },
      { order: 2, label: "Get out to the karst massif at the far end and run The Long Water back down the spine to the mesa. Four spans are broken and the leap — Shift and Space together — is the only budget that crosses them", type: "minigame", target: "citadel_aqueduct_run", count: 1, world: "citadel" },
      { order: 3, label: "Bring back a nexus shard so the archive can date the stone. The caches carry them reliably; the sentinels almost never do", type: "collect", target: "nexus_shard", count: 1, world: "citadel" },
      { order: 4, label: "There is a hall under the massif at the head of the water. Go in and strip it — 3 relic coin", type: "collect", target: "relic_coin", count: 3, world: "citadel" },
      { order: 5, label: "Two clean minutes getting home along the spine with no damage taken. It stands twenty-five metres over the flats at its worst and there are only four haystacks on it", type: "survive", target: "citadel", count: 4, world: "citadel" },
    ],
  },
  {
    quest_number: 135,
    world: "citadel",
    quest_line: "The Ring of Sunspire",
    title: "Be the runner the whole ring knows",
    reward_credits: 1780,
    duration_minutes: 1440,
    pre: ["The Long Water","The Quarry Adit","Rope Bridge Run"],
    steps: [
      { order: 1, label: "Press E on Aldric Storne. The garrison keeps a book on the roof-runners and you are not in it yet", type: "interact", target: "Aldric Storne", count: 1, world: "citadel" },
      { order: 2, label: "Win three rooftop trials — any three of the seven, mesa or ring. Each one has a pacesetter on it running the silver time, and beating the clock means beating the body in front of you", type: "minigame", target: "rooftop_trial_won", count: 3, world: "citadel" },
      { order: 3, label: "A runner is paid in coin here like everyone else. Recover 4 relic coin from the caches — there is one in every region of the ring now", type: "collect", target: "relic_coin", count: 4, world: "citadel" },
      { order: 4, label: "And take 2 arrow off whatever tries to stop you on the way back in", type: "collect", target: "arrow", count: 2, world: "citadel" },
      { order: 5, label: "Three unbroken minutes anywhere on this rock without taking a hit, to prove the last one was not luck", type: "survive", target: "citadel", count: 6, world: "citadel" },
      { order: 6, label: "Press E on Yusra the Falconer on the great tower. She has watched every one of those runs from up here and is the only person whose opinion of them counts", type: "talk", target: "Yusra the Falconer", count: 1, world: "citadel" },
    ],
  },
  {
    quest_number: 41,
    world: "race",
    quest_line: "Paddock Pass",
    title: "Collect a paddock pass and get your name on the board",
    reward_credits: 80,
    duration_minutes: 45,
    pre: null,
    steps: [
      { order: 1, label: "Arrive at Vellum Ridge — the paddock gate logs you the moment you step off the gantry road", type: "visit", target: "race", count: 1, world: "race" },
      { order: 2, label: "Press E on Kai Torres at the mission board in the paddock and take a pass", type: "interact", target: "Kai Torres", count: 1, world: "race" },
    ],
  },
  {
    quest_number: 42,
    world: "race",
    quest_line: "Green Flag",
    title: "Start a race at Vellum Ridge and take the flag",
    reward_credits: 220,
    duration_minutes: 90,
    pre: null,
    steps: [
      { order: 1, label: "Open the race panel, pick the Vellum Ridge Circuit and finish the race. Abandoning it does not count — you have to take the flag, whatever place you take it in", type: "race", target: "vellum", count: 1, world: "race" },
    ],
  },
  {
    quest_number: 43,
    world: "race",
    quest_line: "Tyre Bay Account",
    title: "Open an account with the tyre bay in garage four",
    reward_credits: 320,
    duration_minutes: 180,
    pre: ["Merchant Trade"],
    steps: [
      { order: 1, label: "Press E on Ines Okonjo in the garage-four tyre bay — she reads a set of worn fronts like a paragraph, and she is the only counter on this site", type: "talk", target: "Ines Okonjo", count: 1, world: "race" },
      { order: 2, label: "Bring her something to weigh in: recover 2 alloy scrap from the supply caches. They sit on the roofs and gantries, so you will need to climb or fly to them", type: "collect", target: "alloy_scrap", count: 2, world: "race" },
      { order: 3, label: "Press B at her counter and switch to the sell side. Sell 2 stacks — the tyre bay buys anything metal, whatever it does not stock", type: "purchase", target: "sell", count: 2, world: "race" },
    ],
  },
  {
    quest_number: 44,
    world: "race",
    quest_line: "Sector Marshals",
    title: "Report to the marshal at every sector on every circuit",
    reward_credits: 420,
    duration_minutes: 240,
    pre: ["Paddock Pass"],
    steps: [
      { order: 1, label: "Press E on Devrim Aslan trackside in the ridge sector — he knows exactly where the circuit bites", type: "talk", target: "Devrim Aslan", count: 1, world: "race" },
      { order: 2, label: "Press E on Halla Brandt up in the timing gantry above the main straight. She speaks in tenths and does not exaggerate", type: "talk", target: "Halla Brandt", count: 1, world: "race" },
      { order: 3, label: "Drive out to Cinder Gorge and press E on Petra Halvorsen at her timing box — she blasted half that quarry herself and knows which bench moves", type: "talk", target: "Petra Halvorsen", count: 1, world: "race" },
      { order: 4, label: "Carry on to Aurora Rise and press E on Tobias Renn below the loop. Four thousand cars over the top and he can pick the ones that will not make it by engine note", type: "talk", target: "Tobias Renn", count: 1, world: "race" },
    ],
  },
  {
    quest_number: 45,
    world: "race",
    quest_line: "Learning the Ridge",
    title: "Put in the laps until the ridge line is muscle memory",
    reward_credits: 560,
    duration_minutes: 300,
    pre: ["Green Flag"],
    steps: [
      { order: 1, label: "Press E on Marek Vaisey in the paddock — thirty years of timing this circuit, and he will tell you where the lap is actually won", type: "talk", target: "Marek Vaisey", count: 1, world: "race" },
      { order: 2, label: "Complete 3 laps of the Vellum Ridge Circuit. Only your own laps count, and they add up across races — you do not have to do all three in one go", type: "race", target: "vellum", count: 3, world: "race" },
      { order: 3, label: "Pick up 2 alloy scrap from the caches on the pit roofs while the tyres cool", type: "collect", target: "alloy_scrap", count: 2, world: "race" },
      { order: 4, label: "Spend one clean minute on site without taking damage — nothing here shoots at you, so this is about not putting it into the barriers", type: "survive", target: "race", count: 2, world: "race" },
      { order: 5, label: "Press E on Kai Torres and have the practice session signed off", type: "interact", target: "Kai Torres", count: 1, world: "race" },
    ],
  },
  {
    quest_number: 46,
    world: "race",
    quest_line: "Three Circuits",
    title: "Finish a race on all three Vellum Ridge circuits",
    reward_credits: 950,
    duration_minutes: 720,
    pre: ["Learning the Ridge","Sector Marshals"],
    steps: [
      { order: 1, label: "Circuit 1 of 3 — finish a race on the Vellum Ridge Circuit: the ridge line, the long descent, and two city blocks with no run-off at all", type: "race", target: "vellum", count: 1, world: "race" },
      { order: 2, label: "Circuit 2 of 3 — finish a race at Cinder Gorge: two chicanes, a hairpin and a crested rim with five metres of run-off. Carry the climb or lose the lap on the descent", type: "race", target: "cinder", count: 1, world: "race" },
      { order: 3, label: "Circuit 3 of 3 — finish a race at Aurora Rise: a climb to the summit, a plunge off the back, and a vertical loop on the west straight that every lap has to go over the top of", type: "race", target: "aurora", count: 1, world: "race" },
      { order: 4, label: "Restock the car's first-aid box: recover a medkit from one of the rooftop caches", type: "collect", target: "medkit", count: 1, world: "race" },
      { order: 5, label: "One clean minute on site between rounds, no damage taken", type: "survive", target: "race", count: 2, world: "race" },
      { order: 6, label: "Press E on Kai Torres and enter all three results on the board", type: "interact", target: "Kai Torres", count: 1, world: "race" },
    ],
  },
  {
    quest_number: 47,
    world: "race",
    quest_line: "City Block",
    title: "Master the street section that runs through the city blocks",
    reward_credits: 1120,
    duration_minutes: 1440,
    pre: ["Three Circuits","Gateway Handbook"],
    steps: [
      { order: 1, label: "Press E on Devrim Aslan in the ridge sector and get the street-section briefing before you drive it in anger", type: "talk", target: "Devrim Aslan", count: 1, world: "race" },
      { order: 2, label: "Open the Esc menu, take Character, and put a Helm on. The city blocks have no run-off — that is not decoration", type: "customize", target: "helm", count: 1, world: "race" },
      { order: 3, label: "The rooftop caches above the blocks are the easiest ones to reach on this circuit. Recover 2 bullet drops from them", type: "collect", target: "bullet", count: 2, world: "race" },
      { order: 4, label: "And 2 alloy scrap from the same roofs", type: "collect", target: "alloy_scrap", count: 2, world: "race" },
      { order: 5, label: "Complete 5 laps of Vellum Ridge — a full standard-difficulty race. The blocks come at the end of the descent, when the tyres are already gone", type: "race", target: "vellum", count: 5, world: "race" },
      { order: 6, label: "Two clean minutes on site without taking a hit, walls included", type: "survive", target: "race", count: 4, world: "race" },
      { order: 7, label: "Walk into the Aether Station arch by the paddock and press E — the street-section notes are filed at the hub", type: "interact", target: "station", count: 1, world: "race" },
    ],
  },
  {
    quest_number: 48,
    world: "race",
    quest_line: "Dragon Line",
    title: "Fly the dragon race and then drive the same road on wheels",
    reward_credits: 1300,
    duration_minutes: 2880,
    pre: ["Three Circuits","Mount Up"],
    steps: [
      { order: 1, label: "Press E on Kai Torres and ask for the dragon entry. It is the same circuit, flown fifteen metres up through a line of rings instead of driven", type: "interact", target: "Kai Torres", count: 1, world: "race" },
      { order: 2, label: "Press E on Halla Brandt in the gantry — she times the flown laps too, and she will tell you how much the rings cost a sloppy line", type: "talk", target: "Halla Brandt", count: 1, world: "race" },
      { order: 3, label: "Pick DRAGON in the race panel and finish a dragon race. Space climbs, Ctrl descends, and every ring on the course is a gate you have to go through", type: "race", target: "dragon", count: 1, world: "race" },
      { order: 4, label: "Now finish a CAR race on the same site. This cannot be the same run as the last step — a race is flown or driven, never both", type: "race", target: "car", count: 1, world: "race" },
      { order: 5, label: "Only a flying mount reaches the highest caches. Recover a nexus shard from one", type: "collect", target: "nexus_shard", count: 1, world: "race" },
      { order: 6, label: "And bring a medkit down with you", type: "collect", target: "medkit", count: 1, world: "race" },
      { order: 7, label: "Two clean minutes on site with no damage — a dragon that clips the ridge takes the hit for you", type: "survive", target: "race", count: 4, world: "race" },
      { order: 8, label: "Press E on Tobias Renn at Aurora Rise and have the flown time countersigned under the loop", type: "talk", target: "Tobias Renn", count: 1, world: "race" },
    ],
  },
  {
    quest_number: 49,
    world: "race",
    quest_line: "Ridge Record",
    title: "Put a full race distance on every circuit in the book",
    reward_credits: 1720,
    duration_minutes: 4320,
    pre: ["City Block","Dragon Line"],
    steps: [
      { order: 1, label: "Press E on Kai Torres and open a record attempt across all three circuits", type: "interact", target: "Kai Torres", count: 1, world: "race" },
      { order: 2, label: "Complete 8 laps of the Vellum Ridge Circuit. They add up across races, so this is more than one full-distance run", type: "race", target: "vellum", count: 8, world: "race" },
      { order: 3, label: "Complete 6 laps of Cinder Gorge — one standard-difficulty race distance in the quarry", type: "race", target: "cinder", count: 6, world: "race" },
      { order: 4, label: "Complete 6 laps of Aurora Rise. Every one of them goes over the top of the loop; the road thirty metres underneath it does not count", type: "race", target: "aurora", count: 6, world: "race" },
      { order: 5, label: "Strip 3 alloy scrap out of the caches to pay for the rebuild", type: "collect", target: "alloy_scrap", count: 3, world: "race" },
      { order: 6, label: "And 2 bullet drops while you are up on the roofs", type: "collect", target: "bullet", count: 2, world: "race" },
      { order: 7, label: "Spend it: press B at Ines Okonjo and buy something off her board. She stocks liveries and mount upgrades and nothing else, so pick a car", type: "purchase", target: "buy", count: 1, world: "race" },
      { order: 8, label: "Three unbroken minutes on site without taking a hit — any damage puts the timer back to zero", type: "survive", target: "race", count: 6, world: "race" },
      { order: 9, label: "Press E on Marek Vaisey and have the distance scrutineered", type: "talk", target: "Marek Vaisey", count: 1, world: "race" },
    ],
  },
  {
    quest_number: 50,
    world: "race",
    quest_line: "Vellum Ridge Legend",
    title: "Win outright at Vellum Ridge and carry the title to the hub",
    reward_credits: 2680,
    duration_minutes: 10080,
    pre: ["Ridge Record","Circuit Crown"],
    steps: [
      { order: 1, label: "Press E on Kai Torres in the paddock and enter the title round", type: "interact", target: "Kai Torres", count: 1, world: "race" },
      { order: 2, label: "Take the flag at the Vellum Ridge Circuit", type: "race", target: "vellum", count: 1, world: "race" },
      { order: 3, label: "Take the flag at Cinder Gorge", type: "race", target: "cinder", count: 1, world: "race" },
      { order: 4, label: "Take the flag at Aurora Rise", type: "race", target: "aurora", count: 1, world: "race" },
      { order: 5, label: "Win one outright. Cross the line FIRST in any race on this site — a did-not-finish does not count, and the same win also clears whichever circuit you took it on", type: "race", target: "place_1", count: 1, world: "race" },
      { order: 6, label: "And take the flag once more on the dragon. Fly it at a circuit you still owe and you clear two steps with one race", type: "race", target: "dragon", count: 1, world: "race" },
      { order: 7, label: "Recover a nexus shard from the highest cache on the site — the title comes with a tribute to the hub", type: "collect", target: "nexus_shard", count: 1, world: "race" },
      { order: 8, label: "Open the Esc menu, take Character, and choose the Slim build. Every kilogram is a tenth of a second, and the record book does not care how you got there", type: "customize", target: "slim", count: 1, world: "race" },
      { order: 9, label: "Three unbroken minutes on site without a scratch, so the title stands clean", type: "survive", target: "race", count: 6, world: "race" },
      { order: 10, label: "Walk into the Aether Station arch by the paddock and press E. The Vellum Ridge title is recorded at the hub or it is not recorded at all", type: "interact", target: "station", count: 1, world: "race" },
    ],
  },
  {
    quest_number: 51,
    world: "dock",
    quest_line: "Sign On",
    title: "Sign on at Lodestar Yard",
    reward_credits: 140,
    duration_minutes: 90,
    pre: null,
    steps: [
      { order: 1, label: "You arrive on the apron facing down the keel line. Selim Bregovic keeps the dispatch board twenty paces to starboard - press E and get your name on the site roll", type: "interact", target: "Dispatcher Selim Bregovic", count: 1, world: "dock" },
      { order: 2, label: "Then press E on Yard Warden Teodora Vasa. She set this site out four times before anyone commissioned it and she will tell you why every hull here looks like it was assembled from a kit, because it was", type: "talk", target: "Yard Warden Teodora Vasa", count: 1, world: "dock" },
    ],
  },
  {
    quest_number: 52,
    world: "dock",
    quest_line: "The Chandlery Row",
    title: "Walk the chandlery row",
    reward_credits: 180,
    duration_minutes: 120,
    pre: ["Sign On"],
    steps: [
      { order: 1, label: "Three counters run down the port side of the keel line, fourteen paces apart, and between them they sell everything in the yard. Press E on all three - Ivo Marek at the chandlery, Suri Vane at the fitting shop, Beck Aldous at Paint & Rope", type: "talk", target: "vendor", count: 3, world: "dock" },
    ],
  },
  {
    quest_number: 53,
    world: "dock",
    quest_line: "Open an Account",
    title: "Open an account with the Chandler",
    reward_credits: 260,
    duration_minutes: 180,
    pre: ["The Chandlery Row"],
    steps: [
      { order: 1, label: "Ivo Marek is the only counter in the yard that stocks medical. Press B at the chandlery and buy a Trauma Twin-Pack - nothing in a shipyard heals you for free", type: "purchase", target: "medkit", count: 1, world: "dock" },
      { order: 2, label: "Now switch to the sell side at any of the three counters and sell something back. Watch what the yard pays for scrap: a place that makes hull plate by the ton does not want yours", type: "purchase", target: "sell", count: 1, world: "dock" },
    ],
  },
  {
    quest_number: 54,
    world: "dock",
    quest_line: "Strip the Trench",
    title: "Strip the service trench",
    reward_credits: 420,
    duration_minutes: 300,
    pre: ["Sign On"],
    steps: [
      { order: 1, label: "The service trench runs under the keel line, two metres down and grated over. Three bays are open - the first is just past berth one - and each one is a ramp. Get down there and bring up 4 alloy scrap", type: "collect", target: "alloy_scrap", count: 4, world: "dock" },
      { order: 2, label: "And 2 hull plate while you are down there. The yard cuts them by the ton and still counts every one, which is why they are worth having", type: "collect", target: "hull_plate", count: 2, world: "dock" },
    ],
  },
  {
    quest_number: 55,
    world: "dock",
    quest_line: "Onto the Gantry",
    title: "Get on the gantry",
    reward_credits: 480,
    duration_minutes: 300,
    pre: ["Strip the Trench"],
    steps: [
      { order: 1, label: "The catwalk runs the whole perimeter at eight metres and there are two ways up: the flight by the apron and the one by the blast door, both on the port wall. Get up there and recover 2 laser cells from the stores boxes", type: "collect", target: "laser_cell", count: 2, world: "dock" },
      { order: 2, label: "Come down at berth three and press E on Fitter Casimir Oyelaran. He is usually up to the elbows in the interceptor and has opinions about every other hull in the yard", type: "talk", target: "Fitter Casimir Oyelaran", count: 1, world: "dock" },
    ],
  },
  {
    quest_number: 56,
    world: "dock",
    quest_line: "One Clean Shift",
    title: "One clean shift",
    reward_credits: 520,
    duration_minutes: 360,
    pre: ["Onto the Gantry"],
    steps: [
      { order: 1, label: "Two minutes on the yard without taking a scratch. The only thing in here that can hurt you is the drop off the gantry, and everybody does it once", type: "survive", target: "dock", count: 4, world: "dock" },
      { order: 2, label: "Then report to Rig-Chief Odalys Prieto on berth two. Twenty years of pinning sections back together and she will tell you how the Dray came through the gateway, in order", type: "talk", target: "Rig-Chief Odalys Prieto", count: 1, world: "dock" },
    ],
  },
  {
    quest_number: 57,
    world: "dock",
    quest_line: "Plate and Coil",
    title: "Plate and coil for berth two",
    reward_credits: 640,
    duration_minutes: 360,
    pre: ["One Clean Shift"],
    steps: [
      { order: 1, label: "Berth two wants plate. Three more from the trench caches or the gantry boxes - Odalys will not start until they are on the cradle", type: "collect", target: "hull_plate", count: 3, world: "dock" },
      { order: 2, label: "A thruster coil is not lying about anywhere in this yard, whatever anyone tells you. Press B at Suri Vane's fitting shop and buy one", type: "purchase", target: "thruster_coil", count: 1, world: "dock" },
      { order: 3, label: "Take it back to Rig-Chief Odalys Prieto on berth two", type: "talk", target: "Rig-Chief Odalys Prieto", count: 1, world: "dock" },
    ],
  },
  {
    quest_number: 58,
    world: "dock",
    quest_line: "Store Ship",
    title: "Store ship for a launch that has not happened",
    reward_credits: 560,
    duration_minutes: 300,
    pre: ["Plate and Coil"],
    steps: [
      { order: 1, label: "A ship needs stores before it needs a pilot. Buy 2 Trauma Twin-Packs off Ivo Marek - they cost more here than anywhere in the Nexus and there is nowhere to buy them where you are going", type: "purchase", target: "medkit", count: 2, world: "dock" },
      { order: 2, label: "The yard keeps its own first-aid boxes at the berths and in the trench. Find 1 more", type: "collect", target: "medkit", count: 1, world: "dock" },
      { order: 3, label: "Press E on Signaller Wren Achebe at the blast-door end. She keeps the launch log. It has one page and nothing written on it", type: "talk", target: "Signaller Wren Achebe", count: 1, world: "dock" },
    ],
  },
  {
    quest_number: 59,
    world: "dock",
    quest_line: "The Crane Cab",
    title: "The crane runs on a cycle",
    reward_credits: 700,
    duration_minutes: 240,
    pre: ["Store Ship"],
    steps: [
      { order: 1, label: "Two minutes clean on the high steel. The crane cab is fifteen metres up: off the port catwalk, up the caged run, along the runway walkway", type: "survive", target: "dock", count: 2, world: "dock" },
      { order: 2, label: "There is one old crown coin in this yard and it is in the trench stash. Nothing here mints them, which is why the chandler pays over the odds for one", type: "collect", target: "relic_coin", count: 1, world: "dock" },
      { order: 3, label: "Tell Yard Warden Teodora Vasa the crane cab is clear", type: "talk", target: "Yard Warden Teodora Vasa", count: 1, world: "dock" },
    ],
  },
  {
    quest_number: 60,
    world: "dock",
    quest_line: "First Launch",
    title: "LAUNCHES: 001",
    reward_credits: 1120,
    duration_minutes: 420,
    pre: ["The Crane Cab"],
    steps: [
      { order: 1, label: "Nobody leaves this yard on an empty rack. Buy a cell rack off Suri Vane at the fitting shop - forty cells, and this is the only counter in the Nexus that racks them because this is the only place that winds them", type: "purchase", target: "pack_laser_cell", count: 1, world: "dock" },
      { order: 2, label: "Then prove the rack. The test-fire butts are down in the service trench, under the grating between the datum and berth four: eight cells to light the plates, six plates in three ranks, forty-five seconds. Put all six down", type: "minigame", target: "test_fire_won", count: 1, world: "dock" },
      { order: 3, label: "Then walk the keel line to the north end. The board over the blast door has read LAUNCHES: 000 since the site was commissioned. Step through and change it", type: "interact", target: "dock->space", count: 1, world: "dock" },
    ],
  },
].map(Object.freeze));

/** Synthetic, stable, and impossible to mistake for a database UUID. */
export function offlineQuestId(questNumber) {
  return `offline-quest-${questNumber}`;
}

/**
 * The quests a board in `worldId` would be served, in the row shape the API
 * returns.
 *
 * @param {string|null} worldId
 * @returns {Array<object>} rows with `steps` and `pre_steps` as JSON text, in
 *   `quest_number` order. An unknown world yields an empty list, which is the
 *   same answer the server gives and the same answer the maze needs.
 */
export function offlineQuests(worldId) {
  const world = String(worldId ?? '').trim().toLowerCase();
  if (!world) return [];
  const out = [];
  for (const q of OFFLINE_QUESTS) {
    if (q.world !== world) continue;
    out.push({
      id: offlineQuestId(q.quest_number),
      quest_number: q.quest_number,
      world: q.world,
      quest_line: q.quest_line,
      title: q.title,
      reward_credits: q.reward_credits,
      duration_minutes: q.duration_minutes,
      pre_steps: q.pre ? JSON.stringify(q.pre) : null,
      steps: JSON.stringify(q.steps),
      is_active: true,
      server_id: null,
      /** Marks a row the API did not serve. The board says so once, at the top. */
      offline: true,
    });
  }
  out.sort((a, b) => a.quest_number - b.quest_number);
  return out;
}

export default OFFLINE_QUESTS;
