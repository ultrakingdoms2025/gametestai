/**
 * SPORTS quest content — 10 quests for the Meridian Athletic Grounds (n 21-30).
 *
 * ─────────────────────────────────────────────────────────────────────────────
 *  READ `QUEST-AUDIT.md` AND `MINIGAMES-AUDIT.md` AT THE REPO ROOT BEFORE YOU
 *  EDIT THIS FILE. `admin/lib/quests/station.mjs` is the reference for shape
 *  and rigour.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * THE CONSTRAINT THIS FILE EXISTS TO HONOUR:
 *
 *   ⚠⚠ THERE ARE NO RACES IN THE SPORTS WORLD, AND THERE NEVER HAVE BEEN. ⚠⚠
 *
 * `RaceManager.arm()` calls `_readTrack(world)` (RaceManager.js:334, :730) and
 * bails to "no race here" unless the world publishes BOTH `trackPath` (an array
 * of 3+ points) and `checkpoints` (3+ gates). `SportsWorld.js` publishes
 * NEITHER — grep it: the strings `trackPath`, `checkpoints`, `startGrid`,
 * `RaceManager` and `raceManager` do not appear anywhere in its 397 KB. So
 * `_readTrack` returns null at RaceManager.js:735, `arm()` returns false at :344,
 * `race:finished` and `race:lap` are never emitted here, and a `race` step
 * scoped to `world:'sports'` can never advance by any player action.
 *
 * The content this file replaces had NINETEEN sports race steps
 * (`100m_dash`, `warmup_track`, `tryout_sprint`, `qualifier_round1`,
 * `championship_final`, …). Every one of them was permanently dead — not
 * "mistargeted", but unreachable even with a perfect target, because the
 * emitter does not exist in this world. `scripts/quest-vocab.mjs` encodes the
 * same rule — `if (!world.rules.races || !world.publishesTrack) break;`
 * — which is scraped from the world itself rather than hard-coded against the id,
 * so giving SportsWorld a real `trackPath` would open race steps up here without
 * anyone having to edit the validator.
 *
 * ⇒ THIS FILE CONTAINS ZERO `race` STEPS. Do not add one.
 *
 * WHAT CHANGED SINCE THAT RULE WAS WRITTEN: the grounds grew three REAL,
 * browser-verified contests — the minigame framework (`src/minigames/`,
 * MINIGAMES-AUDIT.md) — and `QuestSystem._eventTargetCandidates` grew a
 * `minigame` branch. A "competition" beat no longer has to be grounded on
 * combat or conversation; it can be grounded on an actual swim, ski or tennis
 * RESULT, and "WIN it" is now expressible as distinct from "play it". That is
 * what this revision of the file does. The race rule above is still the law.
 *
 * ── THE STEP TYPES THAT WORK IN THIS WORLD ───────────────────────────────────
 *
 *  visit      `world:changed` → `QuestSystem._creditVisit` (QuestSystem.js:517).
 *             target = `sports`. Note `accept()` also credits the current world,
 *             so a `visit sports` step inside a sports quest completes the
 *             moment the quest is taken. That is deliberate where it is used.
 *
 *  minigame   `quest:activity{type:'minigame'}` — MinigameManager.js:679, on
 *             any FINISH, win or loss. An ABORT (quitting, walking off the
 *             venue) emits NOTHING and pays NOTHING, so a "play it" step cannot
 *             be cleared by starting and bailing. SportsWorld publishes three
 *             venues (SportsWorld.js:8852 `minigameVenues`) and `main.js`
 *             registers a module for each kind, so all three arm:
 *
 *               swim_challenge  the lido (venue `lido_pool`) — press E on the
 *                               deck; two lengths against Tavius Okonkwo's pace
 *               ski_slalom      the mound (venue `meridian_slope`, label
 *                               "Meridian Downhill") — press E; gates down the
 *                               middle piste against Kjell's ghost, a missed
 *                               gate costs 2 s
 *               tennis_match    the court (venue `meridian_court`) — press E to
 *                               start, F to swing; best of 3 games against
 *                               Deborah Quint-Halloway
 *
 *             A win pays 10 CR (`MINIGAME_PRIZE`); a loss or an abort pays 0.
 *             TARGETS, exactly as the `minigame` branch of
 *             `_eventTargetCandidates` offers candidates:
 *
 *               <gameId>        any finish — the bare id is never offered as a
 *                               candidate, but it matches the `_won`/`_lost`
 *                               composite as a whole-token run, and exactly one
 *                               composite rides on every finish
 *               <gameId>_won    a WIN, and only a win (exact composite match)
 *               <gameId>_lost   a LOSS, and only a loss
 *               venue label / venue id   any finish
 *               won / lost / place_1 / p1 / first   outcome of ANY game here
 *
 *             ⚠ NEVER pair `X` with `X_won` (or `won` with any `_won`, or a
 *               venue id with its game) inside ONE quest: `_advanceSteps` walks
 *               every step per event, so a single win would advance both at
 *               once and let the player skip whatever was written between them
 *               — the same defect as two Petra interacts in one quest. Every
 *               quest below carries at most ONE minigame target per game.
 *
 *  collect    `loot:collected` (Loot.js:605, :613) → `_onCollect`. `count` is a
 *             number of PICKUPS; the stack `qty` is ignored, so a cache holding
 *             60 rounds advances a `bullet` step by exactly 1.
 *             WHAT IS OBTAINABLE HERE, and from where:
 *               `DROP_TABLES.sports` (Loot.js:83-90) — every hostile kill drops
 *               credits (guaranteed, Loot.js:314) plus up to three rolls of
 *               bullet .50 / arrow .40 / medkit .20 / alloy_scrap .20 /
 *               fireball_charge .18 / nexus_shard .05.
 *               `CACHE_TABLES.sports` (Caches.js:85-90) — medkit 2-3,
 *               nexus_shard 1-2, alloy_scrap 2-5, bullet 30-60, two or three
 *               lines per cache. The grounds get up to 3 "high" caches AND up
 *               to 3 "sunken" ones, because the lido reads as water to
 *               `WaterVolumes` (its material is named `water.pool`, which
 *               matches WATERISH and misses NOT_WATER, WaterVolumes.js:33-38).
 *             ⚠ `relic_coin` does NOT exist here — it is medieval/citadel only.
 *             ⚠ `credits` come ONLY from kill drops; caches carry none.
 *
 *  talk       `quest:activity{type:'talk'}` — HUD.js:1776, on `E` at any
 *             friendly that is not a quest manager. target = an NPC NAME or a
 *             ROLE.
 *
 *  interact   `quest:activity{type:'interact'}` — HUD.js:1773, ONLY on a quest
 *             manager; and Portals.js:2830 + `portal:entering`
 *             (QuestSystem.js:482) for a gateway.
 *             ⚠ The sports world has exactly ONE quest manager, Petra Vance
 *               (NPCManager.js:1386-1392). Nothing in `SportsWorld.js` sets
 *               `isQuestManager`, so there is no second desk to press E on.
 *               The only OTHER interact target here is the gateway home:
 *               `{type:'interact', target:'station', world:'sports'}`. Since
 *               `_advanceSteps` walks EVERY step on each event, a quest that
 *               wants two interact beats must pair Petra with the gateway —
 *               two Petra steps in one quest would both clear on one E press.
 *
 *  kill       `npc:killed`, hostiles only (QuestSystem.js:406-411).
 *  defend     `npc:killed` AND `npc:damaged` — one count per HIT LANDED, so
 *             defend counts are deliberately higher than kill counts.
 *             ⚠ EVERY hostile on the grounds is called `Rogue Security Unit`.
 *               `_buildSpawns` pushes ten of them from one literal
 *               (SportsWorld.js:8940-8948, `name: 'Rogue Security Unit'` at
 *               :8944) and the kill event carries `npc.name`
 *               (QuestSystem.js:648). There is no second archetype to name.
 *               They work the outer perimeter and the car park, all of them
 *               over 80 m from the gate, and they respawn after
 *               `CONFIG.npc.respawnDelay` = 22 s (Config.js:213,
 *               NPCManager.js:1947-1958), so a count above ten is reachable.
 *
 *  purchase   `market:trade` (Marketplace.js:434, 456, 481, 526).
 *             target = the granted item id (`pack_medkit`→`medkit`,
 *             `pack_bullets`→`bullet`, `pack_arrows`→`arrow`,
 *             `pack_embers`→`fireball_charge`) or the trade `kind`, which is
 *             literally `'buy'` or `'sell'`.
 *             ⚠ Buying is gated by `vendorCategories` — but NOT here. No sports
 *               NPC authors any restriction, and `_readVendorCategories`
 *               returns null for a trader without one (Marketplace.js:657-666),
 *               which means the whole catalogue. So any medkit/ammo pack is
 *               buyable at the kit stand. Selling is ungated everywhere
 *               (`Marketplace.sell` has no category check) and emits one event
 *               per sell call, so `count: 2` means two sell actions.
 *
 *  customize  `character:changed` (PlayerAvatar.js:550). The payload is
 *             `{config}` with no field name, so the target must be a config
 *             VALUE: outfit `tracksuit`/`sportskit` (PlayerAvatar.js:182-183),
 *             headgear `cap`/`band` (Humanoid.js:3460).
 *             ⚠ The whole config is offered on every change, so a value the
 *               player already wears completes on ANY edit. Nothing below asks
 *               for a `DEFAULT_CHARACTER` value (PlayerAvatar.js:204-219:
 *               outfit `flightsuit`, hair `crop`, headgear `none`, build 1).
 *
 *  survive    one count per 30 unbroken damage-free seconds (`SURVIVE_TICK_S`,
 *             QuestSystem.js:31), credited in `update()`. Any hit zeroes the
 *             accumulator. target = the world id. count 2 = one clean minute,
 *             count 6 = three.
 *
 * ── NEVER USE THESE. THEY HAVE NO EMITTER AND CAN NEVER COMPLETE ─────────────
 *
 *      investigate    deliver    escort    stealth    craft
 *
 * Plus, in THIS world only: `race`. See the top of this header.
 *
 * ── WHO IS ACTUALLY STANDING ON THE GROUNDS ──────────────────────────────────
 *
 * A name is real because a body carrying it gets a SLOT, not because it is
 * written down. `NPCManager.spawnForWorld` (NPCManager.js:605) walks
 * `world.npcSpawns` in order, stops friendlies at `authoredCap`, adds one
 * lorekeeper per portal, adds the quest manager, and spends what is LEFT of
 * `friendlyBudget` on the generic crowd.
 *
 * SportsWorld sets no `friendlyBudget` and no `hostileBudget`, so the engine
 * defaults apply: `maxFriendlies = max(CONFIG.npc.friendlyCount, 30) = 30`
 * (NPCManager.js:492), `maxHostiles = CONFIG.npc.hostileCount = 10`
 * (Config.js:202), `maxNPCs = 72`. The arithmetic:
 *
 *   authored friendlies   6   SportsWorld.js:8782-8835
 *   authored hostiles    10   SportsWorld.js:8940-8948 (all one name)
 *   friendlyBudget       30   min(72 - 10, 30)
 *   authoredCap           6   max(4, min(6, 30 - CROWD_RESERVE 6))  → all six spawn
 *   lorekeepers           1   one per portalSpec, and there is one portal
 *   crowd slots          23   friendlyBudget - (6 + 1)
 *
 * Twenty-three crowd slots is the OPPOSITE of the station's problem (the hub
 * authors 42 civilians against a budget of 50 and leaves the filler just two
 * slots, which is why most of `ROLE_CAST.station` never appears there). Here
 * the filler has room to spare.
 *
 *  AUTHORED CIVILIANS — guaranteed a slot, and therefore the only names below:
 *    Marisol "Ripgrind" Vance   SportsWorld.js:8786   skate bowl coach
 *    Kjell Nordvik              SportsWorld.js:8798   ski instructor, the mound
 *    Deborah Quint-Halloway     SportsWorld.js:8806   pickleball club secretary
 *    Tavius Okonkwo             SportsWorld.js:8814   lifeguard, the lido
 *    Bernard "Bernie" Ashgrove  SportsWorld.js:8822   groundskeeper, the greens
 *    Priya Raghunathan          SportsWorld.js:8830   middle-distance runner
 *  None of the six declares a `role:`, so every one defaults to
 *  `ROLE.WANDERER` (NPCManager.js:730) — which is what makes
 *  `{type:'talk', target:'wanderer'}` safe here.
 *
 *  THREE OF THE SIX ARE ALSO MINIGAME RIVALS (SportsWorld.js:8852): Tavius is
 *  the lido pace, Kjell is the downhill ghost, Deborah is the tennis opponent —
 *  she is genuinely driven onto the court by the match. Talking to a rival and
 *  playing their contest are DIFFERENT step types (`talk` vs `minigame`), so a
 *  coach chat and their contest can safely share a quest.
 *
 *  QUEST MANAGER: Petra Vance, NPCManager.js:1386-1392, planted at (-8, 0.9,
 *  128) — about seventeen metres up the avenue from the arrival gate at
 *  (0, 0.9, 145). She emits `interact`, never `talk`.
 *
 *  LOREKEEPER: one, beside the Aether Station arch, from `_spawnLorekeepers`
 *  (NPCManager.js:1303-1354, role set at :1342). Its NAME is generated from the
 *  gateway sign, so target the ROLE, never a name.
 *
 *  ROLES THE CROWD FILLER ADDS: `_populateHubs` hands out
 *  `ROLE_ROTATION[nameIdx % 12]` starting at nameIdx 0 (NPCManager.js:1478),
 *  and `ROLE_ROTATION[0]` is `ROLE.VENDOR` (NPCRoles.js:300-301). So the FIRST
 *  crowd body placed in any world is a vendor, by construction — which is what
 *  makes the `vendor` role and the purchase steps below reachable even though
 *  SportsWorld authors no trader of its own. `loiterer`, `guard` and
 *  `spectator` follow at indices 1, 2 and 3.
 *
 *  ⚠ NOT USED, DELIBERATELY: the `ROLE_CAST.sports` names (NPCRoles.js:214-258
 *    — Kit Seller Dana Cruz, Pro Shop Marek, Steward Alina Bosch, Marshal Theo
 *    Vance, Regular Junie Park, Coach Rowan Blake, Skier Ash Delacroix). They
 *    are crowd-filler names, so each one depends on `_findStandingSpot`
 *    succeeding for its particular rotation index. That is exactly the trap the
 *    audit records — four ROLE_CAST station names were handed to a content
 *    agent as "valid" and none of them can ever spawn on the station. The
 *    ROLES are structurally guaranteed; the NAMES are not. Labels below
 *    describe the kit stand without naming whoever is behind it.
 *
 * ── MATCHER NOTES ────────────────────────────────────────────────────────────
 *
 * `QuestSystem._matchesStepTarget` (QuestSystem.js:602) is ANCHORED: exact
 * equality, or the shorter string appearing as a run of WHOLE
 * underscore-separated tokens inside the longer. `station` therefore matches the
 * portal id `sports->station`, and `Bernie Ashgrove` would match
 * `Bernard "Bernie" Ashgrove` — but the full authored literal is used below so
 * the target and the source read the same. Note that `Petra Vance` does NOT
 * match `Marisol "Ripgrind" Vance`: [petra, vance] is not a contiguous run
 * inside [marisol, ripgrind, vance].
 *
 * The token run is also what makes minigame outcome targeting SOUND: on a won
 * tennis match the engine offers `tennis_match_won` and never the bare
 * `tennis_match`, `tennis` or `won` — each of those is a token-subrun of the
 * composite and would have completed a "win it" step on a loss (or a swim win)
 * had it been offered alongside. The bare spellings still work as TARGETS,
 * through the composite. See the `minigame` branch of
 * `_eventTargetCandidates` for the full argument.
 *
 * ⚠ `_advanceSteps` (QuestSystem.js:547) walks EVERY step of the engagement on
 *   each event, so two steps in one quest sharing a type, a target AND a world
 *   both advance from a single action — which lets the player skip whatever was
 *   written between them. No quest below repeats a (type, target) pair, and no
 *   quest pairs a minigame target with a composite it is a token-subrun of.
 *
 * ── EVERY STEP STAYS IN ITS OWN WORLD ────────────────────────────────────────
 *
 * Cross-world linkage is expressed through `pre` (quest_line names, enforced
 * globally on accept by `findMissingPrerequisites`, playerDb.ts:546) and NEVER
 * through a step whose `world` differs from the quest's. A foreign-world step
 * only advances while the player is standing in that world, but the quest is
 * only listed on the sports board — and a page reload in a foreign world
 * restores the engagement with `quest: null` (open audit bug #7). Prerequisites
 * carry the cross-world story with none of that exposure.
 *
 * Station prerequisites used here, all real quest_line names from
 * `admin/lib/quests/station.mjs`: `Merchant Trade`, `Weapons Free`,
 * `Gateway Handbook`, `Nexus Passport`.
 *
 * ── SHAPE ────────────────────────────────────────────────────────────────────
 *
 * Matches `DEFAULT_QUESTS` in `admin/lib/db.ts` exactly:
 *   { n, world, line, title, credits, dur, pre, notes, steps: [...] }
 *   step: { order, label, type, target, count, world }
 *   `pre` holds quest_line NAMES, not numbers. `dur` is duration_minutes and a
 *   too-short timer AUTO-FAILS the quest, so it is generous throughout.
 *
 * Numbering: 21-30. Station owns 1-10 / 101-110 / 201-203, medieval 11-20,
 * citadel 31-40, race 41-50. Never reuse those.
 */

export const SPORTS_QUESTS = [
  /* ══════════════════════════════════════════════════════════════════════════
   * Meridian Athletic Grounds — a public sports park under one sky: the arrival
   * plaza and avenue, a concrete skate bowl, an artificial ski mound with three
   * groomed pistes and a terrain-park kicker, pickleball and tennis courts, an
   * open-air lido, mown greens, a running track, and a car park on the far
   * perimeter where the decommissioned security drones still patrol.
   * Three of those venues now run real contests — see the header.
   * ══════════════════════════════════════════════════════════════════════════ */

  {
    n: 21,
    world: 'sports',
    line: 'Opening Ceremony',
    title: 'Sign in for the season at the Meridian grounds board',
    credits: 90,
    dur: 45,
    pre: null,
    notes:
      'Opening quest, 2 steps. Teaches the two actions every other sports quest needs: arriving through the gateway, and pressing E on the one quest manager this world has. Step 1 completes on accept if the player is already standing here — `accept()` credits the current world through the same `_creditVisit` path (QuestSystem.js:517) — which is correct for a "you are here" beat and is why the label says logged rather than travel.',
    steps: [
      { order: 1, label: 'Arrive at the Meridian Athletic Grounds — the gate desk logs you the moment you set foot on the plaza', type: 'visit', target: 'sports', count: 1, world: 'sports' },
      { order: 2, label: 'Walk up the avenue and press E on Petra Vance at the grounds board to sign in for the season', type: 'interact', target: 'Petra Vance', count: 1, world: 'sports' },
    ],
  },

  {
    n: 22,
    world: 'sports',
    line: "Groundskeeper's Round",
    title: 'Walk the greens and the courts with the groundskeeper',
    credits: 170,
    dur: 120,
    pre: null,
    notes:
      '3 steps. Both named NPCs are authored in `SportsWorld._buildSpawns` and are therefore guaranteed a spawn slot (six authored friendlies against an authoredCap of six). alloy_scrap is a 20% drop off a security drone AND 2-5 a cache in `CACHE_TABLES.sports`, so count 2 is one lucky cache or a handful of kills. Deborah is met here as the club secretary; her tennis court runs a real match later in the set.',
    steps: [
      { order: 1, label: 'Press E on Bernard "Bernie" Ashgrove out on the mown greens — forty years of stripes and he wants you to see what got walked over', type: 'talk', target: 'Bernard "Bernie" Ashgrove', count: 1, world: 'sports' },
      { order: 2, label: 'Someone has been stripping fittings. Recover 2 alloy scrap — the drones drop it, and the supply caches hold it in bulk', type: 'collect', target: 'alloy_scrap', count: 2, world: 'sports' },
      { order: 3, label: 'Press E on Deborah Quint-Halloway at the courts and let her tell you which net posts are missing bolts', type: 'talk', target: 'Deborah Quint-Halloway', count: 1, world: 'sports' },
    ],
  },

  {
    n: 23,
    world: 'sports',
    line: 'Perimeter Sweep',
    title: 'Clear the security drones off the car park approach',
    credits: 130,
    dur: 60,
    pre: null,
    notes:
      'Deliberately a ONE-step quest — the old sports data never went below two, and a single clean bounty is the shortest honest thing this world can ask for. Every hostile here carries the same name, so the target is the only one available; ten are authored and they respawn on a 22 s timer, so three is comfortable.',
    steps: [
      { order: 1, label: 'Destroy 3 Rogue Security Units on the car park approach — decommissioned facility drones still running their last patrol order, and they are all over 80 m out from the gate', type: 'kill', target: 'Rogue Security Unit', count: 3, world: 'sports' },
    ],
  },

  {
    n: 24,
    world: 'sports',
    line: 'Kit Check',
    title: 'Stock up at the kit stand and clear the lost-property shelf',
    credits: 340,
    dur: 180,
    pre: ['Merchant Trade'],
    notes:
      '4 steps. CROSS-WORLD PREREQUISITE: the station education line `Merchant Trade` teaches B, the buy side and the sell side; this is the exam. No sports NPC authors `vendorCategories`, so the kit stand opens the WHOLE catalogue (Marketplace.js:657-666 returns null for an unrestricted trader) and the medkit pack is buyable here. Step 4 targets the trade KIND, which is the only way to prove a SALE rather than a purchase — do not replace it with an item id.',
    steps: [
      { order: 1, label: 'Find the kit and refreshments stand and press E on the trader behind it before you buy anything', type: 'talk', target: 'vendor', count: 1, world: 'sports' },
      { order: 2, label: 'Press B to open the marketplace and buy the medkit twin-pack — you cannot buy what your bag has no room for, so check I first', type: 'purchase', target: 'medkit', count: 1, world: 'sports' },
      { order: 3, label: 'Lost property is salvage. Gather 2 alloy scrap off the site', type: 'collect', target: 'alloy_scrap', count: 2, world: 'sports' },
      { order: 4, label: 'Open the marketplace again (B) and switch to the sell side. Sell 2 stacks back — you get less than you paid, that is the spread', type: 'purchase', target: 'sell', count: 2, world: 'sports' },
    ],
  },

  {
    n: 25,
    world: 'sports',
    line: 'Bowl and Piste',
    title: 'Earn your stripes in the bowl and beat the ghost on the mound',
    credits: 520,
    dur: 300,
    pre: ['Opening Ceremony'],
    notes:
      "5 steps, and the first REAL contest in the set. `ski_slalom_won` is the Meridian Downhill module (SkiRun.js, venue `meridian_slope`) and the composite only ever appears in the candidate list on a WON finish — so step 4 is a genuine beat-the-ghost, not a talk dressed as one, and losing or quitting advances nothing. Kjell is both the coach (step 3, `talk`) and the ghost time (the venue rival), which is why the two steps sit together — different step types, so one E press cannot clear both. `sportskit` is a real change: the default outfit is `flightsuit`.",
    steps: [
      { order: 1, label: 'Press E on Marisol "Ripgrind" Vance on the coping — nineteen years of this bowl, and she will not let you drop in without checking your helmet strap', type: 'talk', target: 'Marisol "Ripgrind" Vance', count: 1, world: 'sports' },
      { order: 2, label: 'Press F2 and change into the Sports kit. You are not skating the deep end in a flight suit', type: 'customize', target: 'sportskit', count: 1, world: 'sports' },
      { order: 3, label: 'Press E on Kjell Nordvik at the foot of the ski mound and let him talk you down the fall line', type: 'talk', target: 'Kjell Nordvik', count: 1, world: 'sports' },
      { order: 4, label: 'Now beat him. Walk up the Meridian Downhill mound and press E to start the slalom — gates down the middle piste against Kjell\'s ghost time, a missed gate costs 2 seconds, and the win pays 10 credits', type: 'minigame', target: 'ski_slalom_won', count: 1, world: 'sports' },
      { order: 5, label: 'Every session ends at the first-aid box. Pick up a medkit from a cache or a wreck', type: 'collect', target: 'medkit', count: 1, world: 'sports' },
    ],
  },

  {
    n: 26,
    world: 'sports',
    line: 'Deep End Duty',
    title: 'Stand a shift on the lido and take the swim record off the lifeguard',
    credits: 660,
    dur: 360,
    pre: ["Groundskeeper's Round", 'Gateway Handbook'],
    notes:
      '6 steps. CROSS-WORLD PREREQUISITE: `Gateway Handbook` is the station education line that teaches how the arches work, and step 6 sends the player to the keeper standing beside this world\'s only arch. Step 3 is the Lido Swim Challenge (SwimChallenge.js, venue `lido_pool`) targeted on `swim_challenge_won` — the ghost is paced off Tavius, so beating "his" time right after talking to him is the story writing itself. The lido is genuine water as far as the engine is concerned — its material is named `water.pool`, so `WaterVolumes` builds a swimmable volume over it (WaterVolumes.js:33) and `Caches._findSunken` can put a cache on the bottom (Caches.js:217). `cap` is a real change: the default headgear is `none`.',
    steps: [
      { order: 1, label: 'Press E on Tavius Okonkwo on the lido deck — a lifeguard who has never once had to rescue anybody and is professionally furious about it', type: 'talk', target: 'Tavius Okonkwo', count: 1, world: 'sports' },
      { order: 2, label: 'Restock the poolside first-aid box: collect 2 medkits. There is a supply cache on the bottom of the pool if you are willing to dive for it', type: 'collect', target: 'medkit', count: 2, world: 'sports' },
      { order: 3, label: 'Win the Lido Swim Challenge — press E on the pool deck to start, then swim two lengths and touch the walls faster than Tavius\'s pace. The win pays 10 credits', type: 'minigame', target: 'swim_challenge_won', count: 1, world: 'sports' },
      { order: 4, label: 'Two drones have drifted in off the perimeter. Destroy 2 Rogue Security Units before they reach the water', type: 'kill', target: 'Rogue Security Unit', count: 2, world: 'sports' },
      { order: 5, label: 'Press F2 and put on the Peaked cap — nobody takes a bare-headed lifeguard seriously', type: 'customize', target: 'cap', count: 1, world: 'sports' },
      { order: 6, label: 'Press E on the keeper standing beside the Aether Station arch and log the shift with the hub', type: 'talk', target: 'lorekeeper', count: 1, world: 'sports' },
    ],
  },

  {
    n: 27,
    world: 'sports',
    line: 'Car Park Lockdown',
    title: 'Take the far car park back off the security drones',
    credits: 1200,
    dur: 720,
    pre: ['Perimeter Sweep', 'Weapons Free'],
    notes:
      '7 steps. CROSS-WORLD PREREQUISITE: `Weapons Free` is the station education line that teaches the four weapon slots, and the car park is where the player needs all of them. `kill` and `defend` both subscribe to `npc:killed`, but they are different STEP TYPES so one death advances each of them once — the defend count is higher because `npc:damaged` credits it per hit landed. Ends on Petra Vance; step 1 is a `talk`, so no single E press can clear both ends.',
    steps: [
      { order: 1, label: 'Press E on Priya Raghunathan between intervals on the track — she runs the outer loop past the car park and has counted what is out there', type: 'talk', target: 'Priya Raghunathan', count: 1, world: 'sports' },
      { order: 2, label: 'Destroy 5 Rogue Security Units. They patrol fixed routes across the car park and the outer perimeter, so pull them one at a time rather than walking into the middle', type: 'kill', target: 'Rogue Security Unit', count: 5, world: 'sports' },
      { order: 3, label: 'Land 8 hits on Rogue Security Units — every shot that connects counts, so keep firing while you fall back between the parked rows', type: 'defend', target: 'Rogue Security Unit', count: 8, world: 'sports' },
      { order: 4, label: 'Restock as you go: pick up 3 bullet drops off the wrecks', type: 'collect', target: 'bullet', count: 3, world: 'sports' },
      { order: 5, label: 'Strip the patrol hardware: recover 2 alloy scrap from the destroyed units', type: 'collect', target: 'alloy_scrap', count: 2, world: 'sports' },
      { order: 6, label: 'Hold the car park for two minutes without taking a hit — sprint with Shift and break line of sight behind the parked rows', type: 'survive', target: 'sports', count: 4, world: 'sports' },
      { order: 7, label: 'Press E on Petra Vance at the grounds board and report the car park clear', type: 'interact', target: 'Petra Vance', count: 1, world: 'sports' },
    ],
  },

  {
    n: 28,
    world: 'sports',
    line: 'The Meridian Trials',
    title: 'Enter every discipline the grounds run in one afternoon',
    credits: 1700,
    dur: 1440,
    pre: ['Bowl and Piste', 'Kit Check'],
    notes:
      '8 steps. This is the quest the old data tried to write as nineteen dead race steps — and three of its five disciplines are now REAL contests. Steps 3-5 use ANY-RESULT targets (`ski_slalom`, `tennis_match`, `swim_challenge`): the bare game id matches its `_won`/`_lost` composite as a token run, exactly one of which rides on every finish, so entering and FINISHING counts whatever the scoreboard says — but an abort still counts for nothing, so the player cannot clear an entry by quitting. The bowl and the running track have no contest modules, so those two disciplines stay grounded on the coaches who run them. No `X`/`X_won` pair shares this quest (the wins live in n25, n26, n29 and n30), and each finish advances exactly one step because the three game ids share no token run.',
    steps: [
      { order: 1, label: 'Press F2 and change into the Tracksuit — the trials have a dress code and the officials enforce it', type: 'customize', target: 'tracksuit', count: 1, world: 'sports' },
      { order: 2, label: 'Discipline 1 of 5 — press E on Marisol "Ripgrind" Vance at the skate bowl and enter the bowl session', type: 'talk', target: 'Marisol "Ripgrind" Vance', count: 1, world: 'sports' },
      { order: 3, label: 'Discipline 2 of 5 — ride the Meridian Downhill: press E on the ski mound to start the slalom and carry it through the finish gate. A finished run counts whatever the clock says; a win pays 10 credits on top', type: 'minigame', target: 'ski_slalom', count: 1, world: 'sports' },
      { order: 4, label: 'Discipline 3 of 5 — play a full tennis match against Deborah at the Meridian court: press E courtside to start, F to swing, best of three games. Win or lose, a completed match counts; a win pays 10 credits', type: 'minigame', target: 'tennis_match', count: 1, world: 'sports' },
      { order: 5, label: 'Discipline 4 of 5 — swim the Lido Challenge: press E on the pool deck, then two full lengths, wall to wall. Finishing is what counts today; beat the pace and it pays 10 credits', type: 'minigame', target: 'swim_challenge', count: 1, world: 'sports' },
      { order: 6, label: 'Discipline 5 of 5 — press E on Priya Raghunathan on the running track and enter the middle distance', type: 'talk', target: 'Priya Raghunathan', count: 1, world: 'sports' },
      { order: 7, label: 'Two clean minutes on the grounds with no damage taken — a trial you finish bleeding is a trial you did not finish', type: 'survive', target: 'sports', count: 4, world: 'sports' },
      { order: 8, label: 'Press E on Petra Vance and have the five entries signed off as a single card', type: 'interact', target: 'Petra Vance', count: 1, world: 'sports' },
    ],
  },

  {
    n: 29,
    world: 'sports',
    line: 'Grounds Under Siege',
    title: 'Break the drone push before it reaches the plaza',
    credits: 2800,
    dur: 2880,
    pre: ['Car Park Lockdown', 'Deep End Duty'],
    notes:
      '9 steps. The big combat quest, with one defiant beat in the middle: step 5 is `tennis_match_won` — the composite is only offered on a won finish, so the ladder final has to actually be WON, mid-siege, not merely played. It cannot collide with The Meridian Trials\' any-result `tennis_match` step because the prerequisite chain retires that quest first (n28 needs Bowl and Piste; this needs Deep End Duty and Car Park Lockdown; n30 needs both lines complete). Counts are sized against the ten authored hostiles and their 22 s respawn: 8 kills and 12 landed hits is roughly two full sweeps of the perimeter. nexus_shard is a 5% kill roll but 1-2 guaranteed in a cache, so step 6 is one cache. Opens on the groundskeeper and closes on Petra Vance; the two ends share no type at all.',
    steps: [
      { order: 1, label: 'Press E on Bernard "Bernie" Ashgrove — he saw them come over the boundary and he is more upset about the lawn than about the drones', type: 'talk', target: 'Bernard "Bernie" Ashgrove', count: 1, world: 'sports' },
      { order: 2, label: 'Destroy 8 Rogue Security Units across the perimeter. They respawn, so this is a sustained fight rather than a single clearance', type: 'kill', target: 'Rogue Security Unit', count: 8, world: 'sports' },
      { order: 3, label: 'Land 12 hits on Rogue Security Units — chip them down from cover instead of trading in the open', type: 'defend', target: 'Rogue Security Unit', count: 12, world: 'sports' },
      { order: 4, label: 'Strip 3 alloy scrap out of the wreckage for the repair bill', type: 'collect', target: 'alloy_scrap', count: 3, world: 'sports' },
      { order: 5, label: 'The club plays on. Win the ladder final at the Meridian tennis court — press E courtside to start, F to swing, best of three games against Deborah, who is not cancelling tennis for a drone incursion. The win pays 10 credits', type: 'minigame', target: 'tennis_match_won', count: 1, world: 'sports' },
      { order: 6, label: 'One of them was carrying something it should not have been. Recover a nexus shard — the supply caches hold them too', type: 'collect', target: 'nexus_shard', count: 1, world: 'sports' },
      { order: 7, label: 'Restock the first-aid boxes the fight emptied: collect 2 medkits', type: 'collect', target: 'medkit', count: 2, world: 'sports' },
      { order: 8, label: 'Hold the grounds for three unbroken minutes without taking a hit — any damage puts the timer back to zero', type: 'survive', target: 'sports', count: 6, world: 'sports' },
      { order: 9, label: 'Press E on Petra Vance and close the incident', type: 'interact', target: 'Petra Vance', count: 1, world: 'sports' },
    ],
  },

  {
    n: 30,
    world: 'sports',
    line: 'Meridian Hall of Fame',
    title: 'Be inducted into the Meridian Hall of Fame',
    credits: 5200,
    dur: 5760,
    pre: ['The Meridian Trials', 'Grounds Under Siege', 'Nexus Passport'],
    notes:
      'Capstone, 10 steps — the longest list in the sports set, and the one the minigames were built for: steps 3-5 require ALL THREE contests WON. The three `_won` composites are mutually exclusive by token arithmetic (no game id is a token run inside another\'s composite), so a swim win advances the swim step and nothing else, and a loss advances none of them. The earlier `_won` steps (n25 ski, n26 swim, n29 tennis) are retired before this quest can be accepted, so no single win double-credits across engagements. CROSS-WORLD PREREQUISITE: `Nexus Passport` is the station global that requires setting foot in every world, because a Meridian record is only a Nexus record once the hub has seen you. Steps 1 and 10 are BOTH `interact` and are deliberately different targets — Petra Vance at the board, and the gateway home — because `_advanceSteps` walks every step on each event and two Petra steps would let the player clear the whole capstone with one E press (the exact defect found in the station set, QUEST-AUDIT.md).',
    steps: [
      { order: 1, label: 'Press E on Petra Vance at the grounds board to accept the nomination', type: 'interact', target: 'Petra Vance', count: 1, world: 'sports' },
      { order: 2, label: 'Press F2 and put on the Headband. Every photograph in that corridor has one in it', type: 'customize', target: 'band', count: 1, world: 'sports' },
      { order: 3, label: 'Record 1 of 3 — win the Lido Swim Challenge: press E on the pool deck, two lengths, and touch home ahead of Tavius\'s pace. The win pays 10 credits', type: 'minigame', target: 'swim_challenge_won', count: 1, world: 'sports' },
      { order: 4, label: 'Record 2 of 3 — win the Meridian Downhill: press E on the ski mound, make every gate on the middle piste, and beat Kjell\'s ghost to the line. The win pays 10 credits', type: 'minigame', target: 'ski_slalom_won', count: 1, world: 'sports' },
      { order: 5, label: 'Record 3 of 3 — win the tennis match: press E at the Meridian court, F to swing, and take the best of three off Deborah. The win pays 10 credits', type: 'minigame', target: 'tennis_match_won', count: 1, world: 'sports' },
      { order: 6, label: 'The drones always come back for a ceremony. Destroy 6 Rogue Security Units before the induction', type: 'kill', target: 'Rogue Security Unit', count: 6, world: 'sports' },
      { order: 7, label: 'Recover the nexus shard the last one was carrying', type: 'collect', target: 'nexus_shard', count: 1, world: 'sports' },
      { order: 8, label: 'Gather 4 credit drops off the field — the trophy fund pays for itself', type: 'collect', target: 'credits', count: 4, world: 'sports' },
      { order: 9, label: 'Three unbroken minutes on the grounds without taking a hit, so the record stands clean', type: 'survive', target: 'sports', count: 6, world: 'sports' },
      { order: 10, label: 'Walk into the Aether Station arch on the plaza and press E — the plaque is cast at the hub, and you have to carry the record there yourself', type: 'interact', target: 'station', count: 1, world: 'sports' },
    ],
  },
];

export default SPORTS_QUESTS;
