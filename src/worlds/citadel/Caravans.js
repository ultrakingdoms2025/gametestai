/**
 * THE TRAFFIC IN THE FLATS: caravan roads, wayside wells, and the people on them.
 *
 * ---------------------------------------------------------------------------
 * THE COMPLAINT THIS ANSWERS, AND THE DEFECT IT IS ONE STEP FROM REPEATING
 *
 * The player walked the finished 900 m Citadel and said: *"all works but it
 * desperately needs npc's in the new areas. In the large open areas between
 * objects/villages/caves we should have npc's leading wandering the areas with
 * herds of camels and maybe 1 or 2 oasis areas"*.
 *
 * He is right and it is measured. `scripts/tests/citadel-traffic.test.mjs`
 * indexes the 160 places this world publishes to some system or other - 109
 * relics, 9 caches, 10 viewpoints, 7 trial venues, 7 region anchors, 6 region
 * centres, 10 cave mouths, the spawn and the portal - and **not one of them
 * stands in the open flats**. 51.0% of the map is more than 30 m from anything
 * built, the emptiest flat point is 152.8 m from the nearest collider, and the
 * longest featureless stretch on an inter-region walk has a median of 108 m and
 * a p90 of 272 m, which at 4.6 m/s is 59 seconds of nothing.
 *
 * The medieval expansion answered the same complaint and got it wrong in a way
 * that passed 29 of 29 assertions: ten wolf and bear packs, every spawn
 * returning bodies, and the player reporting *"i do not see any wolves or bears
 * in the forest areas."* Median pack-to-road was 210 m. Every assertion in that
 * suite was a "not closer than", and a world with zero reachable wildlife
 * satisfies every one of them.
 *
 * So nothing in this file is a clearance. Every site in it was chosen by the
 * encounter measurement above and by nothing else, and the specific inversion
 * of the medieval trap is written down here because it is the likelier mistake:
 * **camels are not predators and they belong ON the corridors**, not held off
 * them. A rule in here that read "keep the caravans away from the player's
 * path" would be this feature's version of the vale's predator cordon, which
 * worked perfectly and against its own brief for a whole build.
 *
 * ---------------------------------------------------------------------------
 * WHY THE CONTENT MOVES
 *
 * Static content in a 900 x 900 m world is content nobody meets. The measured
 * ranking says it plainly: the best single STANDING site in the world is met by
 * 13.7% of inter-region journeys, while the best caravan ROAD carrying three
 * trains is met by 29.8% - and three roads together by 60.7%. A caravan is on
 * the corridor by construction; a herd standing in a field is somewhere the
 * corridor may or may not pass.
 *
 * ---------------------------------------------------------------------------
 * WHY IT STREAMS, AND WHY THE BUDGET GOES DOWN RATHER THAN UP
 *
 * `NPCManager.maxNPCs` is 72 and its `BEAST_CEILING` is 14. This file declares
 * 63 caravan camels, 32 well camels, 9 drovers, 8 herd keepers and 10 lone
 * travellers - 122 bodies, and the world adds 14 more animals at the two oases.
 * None of that is a request to raise a cap.
 *
 * `medieval/Residency.js` records the arithmetic and it is not repeated here:
 * manager-level sweeps are free (0.06 ms/frame at 200 characters), a character
 * costs 30-50 us/frame for its think/steer/integrate step and the four raycasts
 * it carries, and **74.6% of a flat roster sits beyond `RENDER_OUT` at any
 * moment**. So the roster is unbounded and costs a plain object each, and the
 * LIVE cast is small and local: {@link CitadelTraffic} holds at most
 * `maxLiveBeasts` animals and `maxLive` humans, and when a cap binds it binds
 * on the FURTHEST candidate, because the want list is sorted by distance before
 * anything is spawned.
 *
 * The caravans get that for free in a way the vale's hamlets could not. A train
 * is only ever spawned where it currently IS, so a road 800 m long costs
 * nothing at all until its caravan happens to be near you.
 *
 * ---------------------------------------------------------------------------
 * THE ROADS ARE WALKABLE, AND THAT IS NOT THE SAME AS REACHABLE
 *
 * `Serjeant Hale` in Aldermoor Vale had two of four legs running through thin
 * air, and `scripts/tests/npc-routes.test.mjs` exists because of it: every
 * authored waypoint is checked against `Grounding.resolveSurfaceY`, against
 * `Physics.resolveCapsule`, and every leg is sampled at 0.3 m with the ground
 * follower's own probe window.
 *
 * The three roads below were not drawn by hand, and they were not taken off the
 * encounter ranking either. The ranking's top road - "player spawn to aqueduct
 * spine foot", 32.9% - **fails that audit**: two of its waypoints sit 1.45 m
 * and 1.57 m inside the aqueduct's piers and one of its legs crosses 12.0 m of
 * open air, because the reach graph it came out of is a model of a PLAYER, who
 * can leap 7.57 m and drop thirty metres, and a drover cannot. Of the 50
 * candidate roads in the catalogue 27 survive the route audit and 23 do not,
 * and what is here is the greedy union over the 27 that do:
 *
 *   mesa-spine        29.8%   the mule road off the mesa to the spine head
 *   deepworks-spine   23.5%   the ore road in from the Headframe
 *   north-desert      19.7%   the long haul, Caravanserai to Ashfall
 *   union of three    60.7%   against a floor of 40%
 *
 * All three meet at the head of the aqueduct spine, which is what makes them a
 * NETWORK rather than three lines: the spine head is the staging yard, and the
 * fiction - water and dressed stone up from the aqueduct, ore and cut block in
 * from the Deepworks, salt and cloth out to the Caravanserai - is the reason
 * the three roads that scored best are also the three a caravan would use.
 *
 * ---------------------------------------------------------------------------
 * @streamedCast
 *
 * Every name in this file - nine drovers, eight herd keepers, ten travellers -
 * belongs to a character {@link CitadelTraffic} spawns only while the player is
 * inside its stream radius, so not one of them is guaranteed a body. That
 * marker is read by `scripts/quest-vocab.mjs`, which builds the list of NPCs a
 * quest step may name: without it the twenty-seven below were scraped as
 * authored cast, and the citadel reported 31 friendlies against an
 * `authoredCap` of 24 with seven "silently dropped" by a budget that never sees
 * them. Roles are still harvested - a streamed NPC is real and `wanderer` is a
 * reachable target - it is only the NAMES that are not dependable, which is the
 * same line `MedievalResidency` sits on and the reason it needed no marker: its
 * people are named by a seeded planner and appear in no source file at all.
 */

import * as THREE from 'three';
import { resolveSurfaceY } from '../../npc/Grounding.js';

/* ------------------------------------------------------------------ */
/* Constants - every one of them measured, and where                   */
/* ------------------------------------------------------------------ */

/**
 * How fast a laden caravan travels, m/s.
 *
 * The same 1.15 the encounter measurement scores with, so the declaration and
 * the gate cannot drift. It is NOT `CONFIG.npc.walkSpeed` (1.5): a drover on a
 * route walks two to four legs and then stops to look around, so the speed a
 * caravan makes good over a road is below the speed its people walk at.
 *
 * The choice is measured to be nearly free either way. The kit's own
 * sensitivity sweep over the best road at three trains reads 0.80 m/s -> 32.7%,
 * 1.15 -> 32.9%, 1.60 -> 33.1%: **0.4 points across a factor of two**, because
 * what decides coverage is which corridor the road follows and how many trains
 * are on it, not how fast they move along it.
 */
export const CARAVAN_SPEED = 1.15;

/**
 * Metres of road per animal.
 *
 * The measurement models a train as `TRAIN_LEN = 32` m of animals and scores
 * eight of them, which is 4 m each; the same 4 m lays the real herd out along
 * the road, so the animals the player counts and the animals the gate counts
 * stand in the same places. The train shipped here is {@link TRAIN_ANIMALS} of
 * them and so 28 m rather than 32. Sensitivity: a 4 m train (one animal) scores
 * 25.7% where a 32 m train scores 32.9% and a 64 m train 39.5%.
 */
export const TRAIN_GAP = 4;

/**
 * Animals in one train, and it is SEVEN because seven is what will spawn.
 *
 * The encounter measurement's reference placement is eight, and eight is what
 * this file declared first. `NPCManager.spawnBeastGroup` clamps every group to
 * `def.packMax`, and the camel row's is 7 - so the world would have declared 72
 * caravan animals to the gate and put 63 bodies on the ground, which is the
 * medieval defect in the one place a caravan can still commit it: a number in a
 * contract with nothing behind it.
 *
 * MEASURED, the correction cost almost nothing. Three roads of three trains
 * read 60.7% of inter-region journeys meeting a caravan at either size - the
 * phase bins are 1.3 m of arc and 28 m of train covers the same set of them -
 * and the only gate that moved is the count of animals met per crossing, 7.56
 * to 6.83 against a floor of 3.0. The kit's own train-length sweep prices the
 * band it lives in: 4 m of train 25.7%, 32 m 32.9%, 64 m 39.5% on one road.
 *
 * `citadel-traffic-live.test.mjs` asserts the declaration against `packMax`
 * directly, and its `NPCManager` stand-in applies the same clamp, because the
 * first draft's stub did not and reported eight animals arriving out of a
 * manager that would have made seven.
 */
export const TRAIN_ANIMALS = 7;

/**
 * How far a caravan camel will stray from its own slot in the train.
 *
 * Small on purpose. `BeastNPC._roam` re-targets whenever the animal is further
 * than `def.territory` from `home`, and this file moves `home` along the road -
 * so the territory is the LEASH of a walking animal rather than the grazing
 * disc the species' own 16 m is.
 *
 * 2.5 rather than the 5 this file shipped first, and the pair below was chosen
 * by sweeping both against the thing that matters - how far an animal actually
 * ends up from the slot the contract, the gate and the minimap all say it is
 * in. One train followed for 300 s on the Long Haul with the real `BeastNPC`,
 * median-over-time slot error:
 *
 *   roamSpeed 1.15  territory 5.0    48.5 m   (as shipped: unbounded, see below)
 *   roamSpeed 1.75  territory 5.0    13.5 m
 *   roamSpeed 2.20  territory 5.0    13.1 m
 *   roamSpeed 2.20  territory 2.5     8.0 m   p90 12.4   max 15.6
 *   roamSpeed 2.80  territory 2.5     7.9 m
 *   roamSpeed 2.20  territory 1.5     6.1 m
 *
 * Below 2.5 the animal is permanently "strayed", so `_roam` never takes its
 * local 9 m wander and the train reads as a tram; 2.5 buys most of the
 * tightening and keeps the wander.
 */
export const TRAIN_TERRITORY = 2.5;

/**
 * How fast a caravan camel may walk, m/s - and it MUST beat {@link CARAVAN_SPEED}.
 *
 * The camel row's own `roamSpeed` is 1.15, which is exactly `CARAVAN_SPEED`, so
 * the shipped animal's top speed equalled the speed of the anchor it was
 * chasing. `BeastNPC._roam` also pauses on about a third of its re-plans, so
 * the achieved pace was strictly below the anchor's and the error could only
 * grow: measured 0.61 m/s made good against 1.15, with camel-to-slot distance
 * climbing 19 m -> 96 m over three minutes on what was then a 5 m territory.
 * The declared 28 m train was a 100 m straggle inside two minutes.
 *
 * 2.2 is inside the camel's own `pace` band, which `BeastGait` runs to 3.4 m/s,
 * so nothing changes about how the animal is animated - it is the same gait at
 * the same stride-locked cadence, and no foot skates. It is threaded through
 * `NPCManager.spawnBeastGroup` as a per-spawn override exactly as `territory`
 * already was, so the species table is untouched and a wild camel still grazes
 * at 1.15.
 */
export const TRAIN_ROAM_SPEED = 2.2;

/**
 * How far a well camel grazes from the trough.
 *
 * Under the species' own 16 m, which `BeastSpecies` calls a grazing disc rather
 * than a hunting range, so a herd at a trough stays a herd at a trough.
 */
export const WELL_TERRITORY = 14;

/**
 * The stream-in and stream-out radii, and the hysteresis between them.
 *
 * Lifted from `MedievalResidency` unchanged, and its reasoning applies here
 * word for word: 175 is comfortably past `RENDER_OUT = 135`, so a body is built
 * while it is still not drawn and there is no pop, and the 45 m gap is what
 * stops a player standing on one threshold making the whole caravan blink.
 */
export const SPAWN_RADIUS = 175;
export const DESPAWN_RADIUS = 220;

/**
 * How far the declared caravan position may run ahead of its own drover.
 *
 * The arc advances by dead reckoning whether or not anybody is there to see it,
 * because that is what makes the phase honest: a caravan that only moves while
 * you are watching is a caravan that is always where you left it. But a
 * `FriendlyNPC` walking a route takes two to four legs and then pauses, so a
 * resident drover makes good less than 1.15 m/s and the two would separate
 * without a bound.
 *
 * 25 m is that bound: while a train is resident its arc waits for its drover
 * rather than walking off without him. It is a little over three animal slots,
 * so the declared head of the caravan is never further from the drover than the
 * tail of the train is.
 */
export const DROVER_LEASH = 25;

/**
 * How long a train may stand still waiting for its drover before it walks on.
 *
 * The leash is a correction, not a lock, and this is what makes that true. The
 * first cut had neither this nor a leg-aware test, and the two together latched:
 * `here` was the FOLDED one-way arc and `his` the drover's projected one-way
 * arc, so the moment `NPC.routeAhead` turned an open patrol round at the end of
 * the road, `his` fell while `here` was already pinned - and nothing could ever
 * clear it again. Measured on the shipped placement, player glued to the head
 * for 300 s: mesa-spine#1 made good 59 m of 345 and stood still for 249 s of
 * the 300, deepworks-spine#1 35 m and 270 s. Two full minutes of a caravan
 * standing in the desert while the player watches it.
 *
 * With the leg-aware test and a drover whose `patrolDir` is tied to his own
 * caravan's leg the latch cannot form, and this bound exists for the cases
 * neither of those covers - a drover wedged on geometry, one shoved off the
 * road, one killed after the sync that noticed. Twelve seconds is over the 8 s
 * a drover needs to close the whole 25 m leash at his own measured pace, so it
 * never fires in normal running.
 */
export const DROVER_STALL = 12;

/**
 * How much nearer a wanted herd must be than a resident one to take its budget.
 *
 * The animal budget is handed out nearest-first at ACQUIRE and was then never
 * re-allocated: a group that streamed in early held its bodies until it left
 * the 220 m release radius, however far behind the player it fell. Measured on
 * the shipped placement, walking the three roads: 23.5 declared camels sit
 * inside the 175 m stream radius on average and the 12-body cap is over
 * subscribed 79.8% of the time, so this is the common case and not the corner.
 * At the moment a group came within recognition with no body of its own, the
 * furthest animal still holding budget was a median 165 m away.
 *
 * 40 m because the sync throttle only re-runs after 0.4 s or 8 m of player
 * movement: a margin five times the movement threshold cannot chatter, and it
 * is inside the 45 m gap between the stream and release radii so an eviction
 * can never fight the hysteresis.
 */
export const EVICT_MARGIN = 40;

/* ------------------------------------------------------------------ */
/* The three roads                                                     */
/* ------------------------------------------------------------------ */

/**
 * A road, as XZ waypoints with the height they were measured at.
 *
 * `y` is the surface `Grounding.resolveSurfaceY` returned at that column on the
 * built world, quoted so `npc-routes.test.mjs` has an authored level to check
 * against rather than a zero that would pass by accident. {@link roadWaypoints}
 * re-resolves every one of them against the live physics at build time, so a
 * number that goes stale is corrected rather than shipped.
 *
 * The lists are Douglas-Peucker simplifications, at a 3.0 m tolerance, of the
 * shortest walkable path the reach graph found between the two hubs - and 3.0 m
 * is the coarsest tolerance at which all three still pass the route audit,
 * which is the only reason it is 3.0 and not a rounder number.
 */
export const CARAVAN_ROADS = Object.freeze([
  {
    id: 'mesa-spine',
    label: 'The Mesa Road',
    /* 29.8% of inter-region journeys, and the best road in the world that a
     * laden animal can actually walk. Every session starts at (0, 14.3, 104)
     * and this is the road out of it, which is why the spawn gate reads 76.3%
     * with it and 65.0% without: the first minute of a session is the one the
     * player judges the world on, and the vale's nearest wolf pack stood 317 m
     * from its spawn with nothing in a 29-assertion suite noticing. */
    cargo: 'water jars and dressed stone, up from the aqueduct to the souk',
    points: [
      [0.0, 14.00, 102.0], [-6.0, 14.00, 66.0], [-21.9, 14.00, 41.7],
      [-24.0, 14.00, -24.0], [-30.0, 14.00, -30.0], [-30.0, 14.00, -54.0],
      [-36.0, 14.00, -60.0], [-30.0, 14.00, -72.0], [-36.0, 14.00, -78.0],
      [-45.5, 14.00, -108.9], [-18.0, 14.39, -132.0],
    ],
    trains: 3,
    animals: TRAIN_ANIMALS,
    drovers: [
      { name: 'Drover Anwar', persona: 'Walks the mesa road with the water train. Cheerful, weather-beaten, and convinced the gate toll on full jars is a scandal.' },
      { name: 'Drover Sitt Rabab', persona: 'Brings dressed stone up from the aqueduct quarry. Terse, exact about weights, and will tell you which courses of the great tower she carried.' },
      { name: 'Drover Musa', persona: 'Youngest of the mesa drovers and proud of it. Talks non-stop about the beasts by name and knows every cistern between here and the spine.' },
    ],
  },
  {
    id: 'deepworks-spine',
    label: 'The Ore Road',
    /* 23.5%. Comes down off the Headframe at y 25, crosses the desert floor at
     * y 0 between (192, -102) and (138, -126), and climbs back onto the plateau
     * at (96, -90): three levels in one road. It is here rather than the 26.0%
     * Deepworks-to-Ashfall line because that one puts two of its waypoints
     * 0.69 m and 1.26 m inside the Ashfall ward's own walls. */
    cargo: 'ore baskets and cut block, in from the Deepworks headframe',
    points: [
      [286.2, 25.24, -42.6], [276.0, 24.69, -48.0], [258.0, 19.90, -48.0],
      [204.0, 0.15, -102.0], [192.0, 0.00, -102.0], [162.0, 0.00, -120.0],
      [144.0, 0.00, -120.0], [138.0, 0.00, -126.0], [96.0, 13.99, -90.0],
      [84.0, 14.39, -102.0], [30.0, 14.39, -132.0], [6.0, 14.39, -126.0],
      [-18.0, 14.39, -132.0],
    ],
    trains: 3,
    animals: TRAIN_ANIMALS,
    drovers: [
      { name: 'Drover Hakim', persona: 'Brings the ore baskets down from the headframe. Sardonic, watchful of the pit edge, and openly contemptuous of anyone who walks it in the dark.' },
      { name: 'Drover Umm Layth', persona: 'Runs cut block from the Deepworks to the spine yard. Slow-spoken, enormously strong, and keeps a tally-stick nobody else can read.' },
      { name: 'Drover Faysal', persona: 'Works the ore road for the pit master and resents it. Full of grievances about the tally, the toll and the dust.' },
    ],
  },
  {
    id: 'north-desert',
    label: 'The Long Haul',
    /* 19.7% on its own, and the road that breaks the worst walk in the world:
     * the emptiest inter-region journey measured is the Ashfall relic at
     * (-350, 200) to the Caravanserai relic at (333, 320) - 754 m walked, of
     * which 632 m passes nothing at all. This road runs the whole northern
     * desert at y 0.16 from (156, 210) to (-204, 186), 360 m of open flats,
     * which is exactly the ground the player was complaining about. */
    cargo: 'salt, cloth and rope, out to the Caravanserai and back with hides',
    points: [
      [366.0, 12.40, 272.0], [318.0, 14.80, 264.0], [312.0, 14.95, 258.0],
      [258.0, 11.36, 258.0], [234.0, 8.99, 246.0], [192.0, 6.68, 246.0],
      [156.0, 0.34, 210.0], [18.0, 0.16, 210.0], [12.0, 0.03, 204.0],
      [-162.0, 0.14, 204.0], [-168.0, 0.55, 198.0], [-204.0, 0.13, 186.0],
      [-258.0, 27.93, 132.0], [-342.0, 30.26, 132.0], [-352.0, 30.26, 128.0],
    ],
    trains: 3,
    animals: TRAIN_ANIMALS,
    drovers: [
      { name: 'Drover Zahra', persona: 'Master of the long haul to the Caravanserai. Unhurried, reads the dunes like a page, and has opinions about every well between here and Ashfall.' },
      { name: 'Drover Bilal', persona: 'Runs salt west and hides east. Superstitious about the Ashfall ground, and will not camp within sight of the beacon.' },
      { name: 'Drover Naimah', persona: 'Twenty years on the northern road and has buried three beasts on it. Dry, kind, and firmly of the view that the mesa charges too much for water.' },
    ],
  },
]);

/* ------------------------------------------------------------------ */
/* The wayside wells                                                   */
/* ------------------------------------------------------------------ */

/**
 * Eight watering places in the open flats, and why they are not two.
 *
 * The player asked for "maybe 1 or 2 oasis areas" and he gets exactly two - the
 * Palm Well and the Sand Mirror, the two full stepped tanks that
 * `citadel/Oasis.js` builds. **They cannot go where the traffic is.** That kit
 * swept the whole desert at a 10 m pitch and found 18 cells of about 4,900 that
 * can carry a 53.8 x 50.8 m tank, and all eighteen are in the south-west,
 * because the eastern desert is a dune field and a 24 m horizontal water plane
 * cannot be levelled into one without a plinth taller than the tank.
 *
 * Measured, the price of that: two oases on the only ground that will take them
 * are met by **5.2%** of inter-region journeys against a floor of 20%, and they
 * move the "no 150 m of nothing" walk share by 0.0 points off its 63.3%
 * baseline against a floor of 72%. Two of the five gates stay red on the best
 * possible pair of real oases, and no amount of re-siting fixes it, because the
 * constraint is the shape of the ground.
 *
 * So the two tanks are joined by eight WELLS - a kerb, a windlass, a trough and
 * a herd, which needs no level water plane and can therefore stand anywhere.
 * The sites are the top eight of the encounter ranking restricted to the open
 * flats at a minimum separation of 70 m, and with them the same two gates read
 * 42.7% and 80.1%.
 *
 * Restricted to the flats deliberately, and the restriction is priced: the
 * unrestricted ranking's best site scores 16.2% against the flats-only 15.8%,
 * so honouring "in the large open areas between objects/villages/caves" costs
 * four tenths of a point. That is the whole argument for taking the brief
 * literally rather than putting the content where it happens to score.
 *
 * `share` is that measured fraction of the 8,384 inter-region journeys passing
 * within the 15 m recognition distance of the site, quoted per row so a site
 * that is moved has to be re-measured rather than re-argued.
 */
export const WELL_SITES = Object.freeze([
  {
    id: 'mast-road', label: 'The Mast Road Well', x: 230, z: 230, share: 0.080, clear: 82, herd: 4,
    keeper: { name: 'Herder Suhayl', persona: 'Waters his herd at the Mast Road trough every third day. Gentle with the animals, blunt with people, and keeps count of every caravan that passes.' },
  },
  {
    id: 'east-flats', label: 'The East Flats Well', x: 230, z: 20, share: 0.074, clear: 54, herd: 4,
    keeper: { name: 'Herder Nawra', persona: 'Grazes the east flats between the mesa and the pit. Watches the sky constantly and can tell you when the dust will come.' },
  },
  {
    id: 'south-seep', label: 'The Southern Seep', x: 40, z: -240, share: 0.057, clear: 43, herd: 4,
    keeper: { name: 'Herder Ilyas', persona: 'Works the southern seep below the aqueduct. Talks to his camels more readily than to strangers, and knows every fallen arch out here.' },
  },
  {
    id: 'north-trough', label: 'The North Trough', x: 50, z: 220, share: 0.055, clear: 48, herd: 4,
    keeper: { name: 'Herder Sitt Dalal', persona: 'Keeps the north trough for the Caravanserai trains. Brisk, unimpressed by travellers, and charges for water without apology.' },
  },
  {
    id: 'pit-road', label: 'The Pit Road Well', x: 210, z: -120, share: 0.051, clear: 23, herd: 4,
    keeper: { name: 'Herder Marwan', persona: 'Pastures the pit road herd within sight of the Deepworks. Endlessly worried about the noise off the headframe frightening the beasts.' },
  },
  {
    id: 'ashfall-verge', label: 'The Ashfall Verge', x: -250, z: 70, share: 0.047, clear: 52, herd: 4,
    keeper: { name: 'Herder Rukaya', persona: 'Grazes the verge under the Ashfall ridge. Quiet, sun-scoured, and quietly certain the beacon is older than the citadel.' },
  },
  {
    id: 'karst-approach', label: 'The Karst Approach', x: -70, z: -210, share: 0.044, clear: 36, herd: 4,
    keeper: { name: 'Herder Tahir', persona: 'Waters on the approach to the massif. Superstitious about the sinkhole and will walk half a mile around it.' },
  },
  {
    id: 'far-east', label: 'The Far East Standing', x: 330, z: 160, share: 0.038, clear: 104, herd: 4,
    keeper: { name: 'Herder Umm Basma', persona: 'The furthest herd from the mesa and proud of the distance. Hospitable to anyone who reaches her, and full of news off both roads.' },
  },
]);

/* ------------------------------------------------------------------ */
/* Lone travellers                                                     */
/* ------------------------------------------------------------------ */

/**
 * Ten people crossing the flats on their own business.
 *
 * These are NOT scored by any of the five encounter gates - those count camels,
 * and none of these has one - and they are here anyway, because the complaint
 * was about the WALK and not only about the herds. A caravan is an event; a
 * pilgrim on the massif road at dusk is the difference between a world with
 * traffic on it and a world with three scheduled events in it.
 *
 * Each carries a short round rather than a single post, because a character
 * standing perfectly still in open desert reads as a prop. Every round is two
 * legs of 25-40 m over open ground, and every one is audited by
 * `npc-routes.test.mjs` exactly as the three roads are.
 */
export const WANDERERS = Object.freeze([
  {
    id: 'pilgrim-eyrie', name: 'Pilgrim Sulayman',
    persona: 'Walking to the Eyrie on foot because he swore he would. Footsore, radiant about it, and will describe the stair to anyone who slows down.',
    /* NOT the obvious line straight at the Eyrie. (-52, -292) is 2.87 m inside
     * the Sunken Hall's own plinth - the cave the ring builds at (-56, -281) -
     * and the route audit caught it. This round climbs the massif's western
     * skirt instead. */
    legs: [[-70, -270], [-60, -284], [-48, -298]],
  },
  {
    id: 'pilgrim-eyrie-2', name: 'Pilgrim Umm Kulthum',
    persona: 'Second of the massif pilgrims and the practical one. Carries the water for both of them and is frank about how far it still is.',
    legs: [[-96, -244], [-78, -262], [-64, -278]],
  },
  {
    id: 'prospector-pit', name: 'Prospector Idris',
    persona: 'Works the spoil outside the Deepworks looking for what the pit master missed. Guarded, quick-eyed, and will trade a rumour for a coin.',
    legs: [[232, -70], [252, -92], [268, -112]],
  },
  {
    id: 'prospector-pit-2', name: 'Prospector Sabri',
    persona: 'Sifts the pit road tailings and insists there is still ore in them. Talks numbers at you, none of which add up.',
    legs: [[268, -148], [246, -160], [222, -156]],
  },
  {
    id: 'surveyor-aqueduct', name: 'Surveyor Rania',
    persona: 'Measures the aqueduct arches for the master of works. Precise, impatient, and convinced the southern span is settling.',
    legs: [[-30, -186], [-16, -206], [-8, -228]],
  },
  {
    id: 'saltcutter-north', name: 'Salt-cutter Jibril',
    persona: 'Cuts pan salt off the northern flats for the Caravanserai trains. Burnt raw by the glare and cheerfully fatalistic about it.',
    legs: [[96, 232], [124, 216], [152, 224]],
  },
  {
    id: 'saltcutter-north-2', name: 'Salt-cutter Ruqayya',
    persona: 'Works the same pans and undercuts him. Sharp, funny, and keeps a private map of where the good crust is.',
    legs: [[-20, 244], [-46, 232], [-72, 240]],
  },
  {
    id: 'courier-ashfall', name: 'Courier Tamim',
    persona: 'Runs orders between the Ashfall ward and the beacon on foot. Never stops moving, answers in half sentences.',
    legs: [[-206, 118], [-232, 106], [-256, 96]],
  },
  {
    id: 'undercliff-forager', name: 'Forager Habiba',
    persona: 'Gathers scrub and thorn under the Undercliff for the cook fires. Content, watchful, and knows exactly where the shade is at every hour.',
    legs: [[-52, 268], [-30, 284], [-8, 296]],
  },
  {
    id: 'mast-drifter', name: 'Traveller Qais',
    persona: 'Came in on a caravan and has not decided where he is going next. Amiable, evasive about where he is from, full of stories about the other side of the dunes.',
    legs: [[288, 214], [266, 196], [244, 186]],
  },
]);

/* ================================================================== */
/* Road geometry - pure arithmetic over an XZ polyline                 */
/* ================================================================== */

/**
 * Cumulative arc length of a waypoint list, in XZ.
 *
 * XZ and not XYZ deliberately: the animals and the metric both live on the map,
 * and the ore road would otherwise measure 25 m longer than the ground a player
 * walks beside it because of the climb off the Headframe.
 *
 * @param {THREE.Vector3[]} points
 * @returns {Float64Array}
 */
export function roadArcs(points) {
  const arcs = new Float64Array(points.length);
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1];
    const b = points[i];
    arcs[i] = arcs[i - 1] + Math.hypot(b.x - a.x, b.z - a.z);
  }
  return arcs;
}

/** Total XZ length of a road, one way. */
export function roadLength(points) {
  const arcs = roadArcs(points);
  return arcs[arcs.length - 1];
}

/**
 * The point at arc `s` along a road, written into `out`.
 *
 * `s` is CLAMPED rather than wrapped. The wrap belongs to the cycle, which is
 * out and back, and is done by {@link cycleArc} - so a caravan reaching the far
 * end of an open road turns round instead of teleporting to the start. That is
 * also what `NPC.routeAhead` does with an open patrol, so the arithmetic and the
 * drover agree about which way the caravan is facing.
 *
 * @param {THREE.Vector3[]} points
 * @param {Float64Array} arcs
 * @param {number} s
 * @param {THREE.Vector3} out
 */
export function pointAtArc(points, arcs, s, out) {
  const total = arcs[arcs.length - 1];
  const t = s <= 0 ? 0 : (s >= total ? total : s);
  let i = 1;
  while (i < arcs.length - 1 && arcs[i] < t) i++;
  const seg = arcs[i] - arcs[i - 1];
  const u = seg > 1e-6 ? (t - arcs[i - 1]) / seg : 0;
  const a = points[i - 1];
  const b = points[i];
  out.set(a.x + (b.x - a.x) * u, a.y + (b.y - a.y) * u, a.z + (b.z - a.z) * u);
  return out;
}

/**
 * Fold a position on the out-and-back CYCLE onto the one-way road.
 *
 * The cycle is `2 * length` long: `[0, L)` walks out, `[L, 2L)` walks back.
 * This is the same loop `CaravanRoute` in the traffic kit scores against - it
 * mirrors the polyline before measuring - so a phase here and a phase there
 * mean the same thing.
 *
 * @returns {number} arc along the one-way road, in `[0, L]`
 */
export function cycleArc(c, length) {
  const L2 = length * 2;
  let t = c % L2;
  if (t < 0) t += L2;
  return t <= length ? t : L2 - t;
}

/**
 * The one-way arc nearest to a point.
 *
 * Used to keep a caravan's declared position tied to the drover who is actually
 * walking it. Returns the arc along the ONE-WAY road, which is the same space
 * {@link cycleArc} folds into, so the two are directly comparable.
 */
export function projectOnRoad(points, arcs, x, z) {
  let best = 0;
  let bd2 = Infinity;
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1];
    const b = points[i];
    const dx = b.x - a.x;
    const dz = b.z - a.z;
    const len2 = dx * dx + dz * dz;
    let u = len2 > 1e-9 ? ((x - a.x) * dx + (z - a.z) * dz) / len2 : 0;
    if (u < 0) u = 0; else if (u > 1) u = 1;
    const px = a.x + dx * u;
    const pz = a.z + dz * u;
    const d2 = (x - px) ** 2 + (z - pz) ** 2;
    if (d2 < bd2) { bd2 = d2; best = arcs[i - 1] + Math.sqrt(len2) * u; }
  }
  return best;
}

/**
 * Resolve a road's authored waypoints onto the world as built.
 *
 * The authored `y` is a HINT that `npc-routes.test.mjs` checks against the real
 * surface with a 2 m tolerance; this is what turns it into the real surface.
 * Done once at build time rather than at spawn time so that every consumer -
 * the drover's patrol, the camel homes, the published `caravanRoutes` contract
 * and the minimap - reads one list of points and not four.
 *
 * `resolveSurfaceY` and NOT `physics.groundHeight`, and the difference is a
 * defect this file shipped in its first draft. `groundHeight` returns the first
 * surface below the top of its probe window, so the waypoint at (-6, 66)
 * authored at y 14 on the mesa resolved onto a souk ROOF at 18.71 m - and the
 * two legs leaving it then walked off a parapet, 24.0 m and 55.8 m of them with
 * no ground underneath, which is the `Serjeant Hale` defect exactly.
 * `resolveSurfaceY` picks the surface NEAREST the hint out of the whole column,
 * which is what `NPCManager._snapToGround` calls and what
 * `npc-routes.test.mjs` audits against - so the road is now resolved by the
 * same function that judges it.
 *
 * @param {{points:number[][]}} road
 * @param {any} physics
 * @returns {THREE.Vector3[]}
 */
export function roadWaypoints(road, physics) {
  return road.points.map(([x, y, z]) => (
    new THREE.Vector3(x, resolveSurfaceY(physics, x, z, y) ?? y, z)
  ));
}

/**
 * Resolve one authored ground position the same way, for a well or a round.
 *
 * The hint is the TERRAIN height rather than zero, because the desert runs from
 * 0 to 30 m across this world and a hint of zero at the Ashfall verge would
 * pick whichever surface is nearest sea level rather than the sand the herder
 * is standing on.
 *
 * @param {any} physics
 * @param {number} x
 * @param {number} z
 * @param {number} hintY the terrain height at that column
 * @returns {number|null}
 */
export function groundFor(physics, x, z, hintY) {
  return resolveSurfaceY(physics, x, z, hintY);
}

/* ================================================================== */
/* The streaming population                                            */
/* ================================================================== */

const _p = new THREE.Vector3();
const _q = new THREE.Vector3();
/**
 * The spec handed to `spawnBeastGroup` for a TOP-UP, reused every call.
 *
 * A group that arrives short has to be able to ask for the shortfall rather
 * than for its whole count, and `spawnBeastGroup` reads the count off the spec
 * - so the alternative is one object literal per candidate per sync. `sync` is
 * throttled but it is still a loop, and the house rule is no allocation in one.
 * `spawnBeastGroup` reads this object and keeps nothing from it.
 */
const _topUp = {
  position: null, type: 'beast', species: 'camel', name: '',
  count: 0, territory: 0, roamSpeed: undefined, spread: 0,
};

/**
 * Every caravan, herd and traveller in the flats, streamed against the player.
 *
 * WHAT IT DOES NOT OWN. Characters. `NPCManager` owns every character in the
 * game and destroys its whole cast on any world activation without telling
 * anyone, so a held reference is re-checked with `owns()` on every sync rather
 * than trusted - the same hazard `MedievalResidency` and `MazePopulation` both
 * record, and the same reason a maze once shipped with no wanderers in it at
 * all, silently, because every retry saw a non-null `npc` and skipped.
 *
 * WHAT IS AUTHORITATIVE. The arc. Every train's position is dead reckoning at
 * {@link CARAVAN_SPEED} whether or not anybody is there to see it, so the phase
 * the encounter measurement scores is the phase the world actually has. While a
 * train is resident the arc waits for its own drover if he falls more than
 * {@link DROVER_LEASH} behind it - see that constant for why the correction goes
 * this way round and not the other.
 */
export class CitadelTraffic {
  /**
   * @param {object} o
   * @param {() => any} o.npcManager resolved per call, never captured
   * @param {any} o.physics for the ground probes the herd anchors need
   * @param {Array<object>} o.roads `{id, label, cargo, waypoints, trains, animals, drovers}`
   * @param {Array<object>} o.camps `{id, label, position, herd, r, keeper}`
   * @param {Array<object>} [o.wanderers] friendly specs carrying a `patrol`
   * @param {Array<object>} [o.residents] extra friendly specs - the oasis staff
   * @param {number} [o.maxLive] live streamed humans
   * @param {number} [o.maxLiveBeasts] live streamed animals, BODIES not groups
   * @param {number} [o.seed]
   */
  constructor({
    npcManager, physics,
    roads = [], camps = [], wanderers = [], residents = [],
    spawnRadius = SPAWN_RADIUS, despawnRadius = DESPAWN_RADIUS,
    /* Ten streamed humans, and PRICED IN FRAME TIME rather than only in head
     * count, because the head count was the only justification the first cut
     * had and a head count is not a budget.
     *
     * The head count still holds: `spawnForWorld` builds 4 authored friendlies,
     * a lorekeeper, a questmaster, a hub crowd of 6 and 8 hostiles - 20
     * permanent bodies - so ten humans and twelve animals brings the worst case
     * to 42 against `maxNPCs` of 72.
     *
     * The frame time is the number that actually binds, and it is the SUM that
     * has to be quoted: at the manager's own measured 30-50 us per character
     * per frame, `maxLive + maxLiveBeasts` = 22 bodies is 0.66-1.10 ms against
     * a 5.5 ms frame, not the 0.36-0.60 ms the animal cap alone declares. That
     * is 12-20% of the frame and it is deliberately under a quarter of it;
     * `citadel-traffic-live.test.mjs` asserts the combined figure so a later
     * cap cannot be raised on one side without the other side noticing.
     * Headless, driving the real `NPCManager` with a caravan standing on the
     * player, the same bodies measure 6.2 us an animal and 10.2 us a human -
     * lower because nothing here is drawn, which is exactly why the gate is
     * written against the project's in-game figure and not against this one. */
    maxLive = 10,
    /* Twelve BODIES, and the number is a frame-time budget rather than a taste.
     * `NPCManager`'s own ablation measures 30-50 us per character per frame for
     * the think/steer/integrate step and its four raycasts, so twelve animals
     * is 0.36-0.60 ms. It is under the manager's own `BEAST_CEILING` of 14, so
     * a group is never cut in half by a cap it cannot see, and it is enough for
     * one whole eight-animal train plus a four-camel well herd standing at the
     * same crossing. */
    maxLiveBeasts = 12,
    seed = 0x5b1f,
  }) {
    this._npcManager = npcManager;
    this.physics = physics;
    this.spawnRadius = spawnRadius;
    this.despawnRadius = despawnRadius;
    this.maxLive = maxLive;
    this.maxLiveBeasts = maxLiveBeasts;

    /** @type {Array<object>} */
    this.roads = [];
    /** @type {Array<object>} every train in the world, resident or not. */
    this.trains = [];
    for (const road of roads) {
      const points = road.waypoints;
      const arcs = roadArcs(points);
      const length = arcs[arcs.length - 1];
      const entry = { ...road, points, arcs, length };
      this.roads.push(entry);
      const cycle = length * 2;
      for (let k = 0; k < road.trains; k++) {
        /* A rigid `1/n` of the CYCLE apart, plus a PER-TRAIN seeded jitter of
         * up to another `1/n`.
         *
         * The gate models the rigid spacing; this is not it, and the difference
         * is measured rather than argued. Because the jitter is multiplied by
         * `(k + 1)` it is a different offset for every train, so the shipped
         * arcs are not evenly spaced: mesa-spine's three sit 80.3 / 197.0 /
         * 247.5 m apart on a 524.8 m cycle where rigid would be 174.9 each, and
         * the Long Haul's 599.8 / 212.7 / 725.4 on 1537.9. The encounter cost
         * of that mismatch was measured at 46.7% against the model's 46.6% -
         * nil, because what decides coverage is which corridor the road follows
         * and how many trains are on it. It is written down because the first
         * draft of this comment claimed the spacing was rigid and it never was.
         */
        const drover = road.drovers?.[k % Math.max(1, road.drovers?.length ?? 1)] ?? null;
        this.trains.push({
          road: entry,
          index: k,
          cycle,
          /** Seconds this train has spent held by {@link DROVER_LEASH}. */
          stall: 0,
          arc: (cycle * k) / road.trains
            + (((seed * (k + 1) * 2654435761) >>> 0) % 1000) / 1000 * (cycle / road.trains),
          spec: drover
            ? {
              position: new THREE.Vector3(),
              type: 'friendly',
              role: 'wanderer',
              name: drover.name,
              persona: drover.persona,
              patrol: points.map((p) => p.clone()),
              caravan: `${road.id}#${k}`,
            }
            : null,
          npc: null,
          camels: [],
          beastSpec: {
            position: new THREE.Vector3(),
            type: 'beast',
            species: 'camel',
            name: `${road.label} camel`,
            count: road.animals,
            territory: TRAIN_TERRITORY,
            /* A walking animal, not a grazing one. @see TRAIN_ROAM_SPEED. */
            roamSpeed: TRAIN_ROAM_SPEED,
            spread: TRAIN_GAP,
          },
        });
      }
    }

    /** @type {Array<object>} the wayside herds. */
    this.camps = camps.map((c) => ({
      site: c,
      keeper: c.keeper ?? null,
      beastSpec: {
        position: c.position,
        type: 'beast',
        species: 'camel',
        name: `${c.label} camel`,
        count: c.herd,
        territory: WELL_TERRITORY,
        spread: c.r ?? 10,
      },
      npc: null,
      bodies: [],
    }));

    /** @type {Array<object>} lone travellers and the oasis staff. */
    this.folk = [...wanderers, ...residents].map((spec) => ({ spec, npc: null }));

    this._sinceTick = 0;
    this._lastX = Infinity;
    this._lastZ = Infinity;
    /** Counters the headless gates and the report read. */
    this.stats = { syncs: 0, spawned: 0, despawned: 0, refused: 0, leashed: 0, evicted: 0 };
  }

  /** The live NPC manager, or null. Resolved per call, never cached. */
  get npcManager() {
    return this._npcManager?.() ?? null;
  }

  /**
   * Every humanoid spec that carries a round.
   *
   * `npc-routes.test.mjs` reads `world._population?.people` precisely so that a
   * streamed cast cannot become a second, unchecked kind of route - the vale's
   * two mid-air sentries are what that clause is for. Every drover's patrol IS
   * its road, so publishing this publishes the three roads for audit as well.
   */
  get people() {
    const out = [];
    for (const t of this.trains) if (t.spec) out.push(t.spec);
    for (const c of this.camps) if (c.keeper) out.push(c.keeper);
    for (const f of this.folk) out.push(f.spec);
    return out;
  }

  /** Every roster entry, live or not - the number the design is written in. */
  get rosterSize() {
    return this.trains.length + this.camps.length + this.folk.length;
  }

  /** Declared animals, which is what the encounter measurement is scored on. */
  get declaredAnimals() {
    let n = 0;
    for (const t of this.trains) n += t.beastSpec.count;
    for (const c of this.camps) n += c.beastSpec.count;
    return n;
  }

  /** Streamed animals that actually have a body in the world. */
  liveBeastCount() {
    const mgr = this.npcManager;
    let n = 0;
    for (const t of this.trains) for (const b of t.camels) if (mgr?.owns?.(b) !== false) n++;
    for (const c of this.camps) for (const b of c.bodies) if (mgr?.owns?.(b) !== false) n++;
    return n;
  }

  /** Streamed humans that actually have a body in the world. */
  liveCount() {
    const mgr = this.npcManager;
    let n = 0;
    for (const t of this.trains) if (t.npc && mgr?.owns?.(t.npc) !== false) n++;
    for (const c of this.camps) if (c.npc && mgr?.owns?.(c.npc) !== false) n++;
    for (const f of this.folk) if (f.npc && mgr?.owns?.(f.npc) !== false) n++;
    return n;
  }

  /** Where train `t` currently is, written into `out`. */
  headOf(t, out) {
    return pointAtArc(t.road.points, t.road.arcs, cycleArc(t.arc, t.road.length), out);
  }

  /**
   * Per frame. Advances every caravan, then brings the live cast in line with
   * where the player is.
   *
   * The advance is unconditional and the streaming is throttled, which is the
   * whole shape of the class: nine trains times four floats is free and runs
   * every frame, so the world is never caught standing still; while the sync -
   * which sorts and spawns - runs on the same 0.4 s / 8 m throttle
   * `MedievalResidency` uses, because standing still is the common case and a
   * player sprinting at 8.2 m/s cannot cross the 45 m hysteresis gap between
   * two of them.
   *
   * No allocation on the unthrottled path: the advance is arithmetic and
   * `headOf` writes into module scratch. `sync` builds a want list, which is
   * exactly why it is behind the throttle.
   *
   * @param {number} x eye position
   * @param {number} z
   * @param {number} dt
   * @returns {boolean} true when the live cast changed
   */
  update(x, z, dt = 0) {
    const step = CARAVAN_SPEED * dt;
    for (let i = 0; i < this.trains.length; i++) {
      const t = this.trains[i];
      if (t.npc && this._leashed(t)) {
        this.stats.leashed++;
        t.stall += dt;
        /* WAIT FOR HIM, BUT NOT FOR EVER. @see DROVER_STALL for the two
         * minutes of standing still this bound exists to make impossible. */
        if (t.stall < DROVER_STALL) continue;
      } else {
        t.stall = 0;
      }
      t.arc += step;
      if (t.arc >= t.cycle) t.arc -= t.cycle;
    }
    this._sinceTick += dt;
    const moved = Math.abs(x - this._lastX) + Math.abs(z - this._lastZ);
    if (this._sinceTick < 0.4 && moved < 8) return false;
    this._sinceTick = 0;
    this._lastX = x;
    this._lastZ = z;
    return this.sync(x, z);
  }

  /**
   * Is this train's declared position running away from its own drover?
   *
   * Measured along the ROAD rather than as a straight line, because a drover who
   * has stepped three metres aside to get round a rock has not fallen behind.
   *
   * BOTH POSITIONS ARE IN CYCLE SPACE, and that is a fix rather than a detail.
   * The first cut compared the FOLDED one-way arcs, and folding throws away
   * which leg each of them is on: on the way back the train's folded arc
   * DECREASES as its cycle position advances, so `here - his` went negative and
   * the test could never fire. Measured on the shipped placement, a return-leg
   * train followed for 300 s: the drover ended 505.8 m from his own caravan
   * against a declared leash of 25, and was never once held. Three of the nine
   * trains start on the return leg and every train spends half its cycle there.
   *
   * A DEAD DROVER IS NOT AN ANCHOR. `_updateRespawns` walks the hostile roster
   * only, so a friendly never comes back, and the release pass below only drops
   * a reference the manager has stopped owning - so without this guard a corpse
   * stayed a valid leash anchor for as long as the player stood near it.
   * Measured: shoot the drover, and his caravan makes good 25 m in two minutes
   * against an expected 138. Killing a bystander stopped the world in front of
   * you.
   */
  _leashed(t) {
    const npc = t.npc;
    const mgr = this.npcManager;
    if (!npc || npc.isDead || mgr?.owns?.(npc) === false) return false;
    const L = t.road.length;
    const his = projectOnRoad(t.road.points, t.road.arcs, npc.position.x, npc.position.z);
    /* His one-way arc lifted onto the leg the train is on. Continuous across
     * both folds: at the turn `his` and `t.cycle - his` are the same number. */
    const hisCycle = t.arc <= L ? his : t.cycle - his;
    return t.arc - hisCycle > DROVER_LEASH;
  }

  /**
   * Give up the budget held by the furthest resident herd, for a nearer one.
   *
   * The whole point of sorting the want list is that a cap binds on the
   * FURTHEST candidate - but that is only true at the moment a group is
   * acquired. Nothing re-allocated afterwards, so a herd that streamed in at
   * 170 m held its animals until it passed the 220 m release radius, and the
   * train the player was about to walk into got `room = 1`.
   *
   * @param {number} x player
   * @param {number} z
   * @param {number} wantD2 squared distance of the candidate asking for room
   * @returns {number} bodies freed, 0 if nothing may be taken
   */
  _evictFurthest(x, z, wantD2) {
    const mgr = this.npcManager;
    let victim = null;
    let victimIsTrain = false;
    let worst = wantD2;
    for (const t of this.trains) {
      if (!t.camels.length) continue;
      this.headOf(t, _p);
      const d2 = (_p.x - x) ** 2 + (_p.z - z) ** 2;
      if (d2 > worst) { worst = d2; victim = t; victimIsTrain = true; }
    }
    for (const c of this.camps) {
      if (!c.bodies.length) continue;
      const q = c.site.position;
      const d2 = (q.x - x) ** 2 + (q.z - z) ** 2;
      if (d2 > worst) { worst = d2; victim = c; victimIsTrain = false; }
    }
    /* Only for a candidate that is MEANINGFULLY nearer, or a player walking the
     * line between two herds trades them back and forth every sync. */
    if (!victim || Math.sqrt(worst) - Math.sqrt(wantD2) < EVICT_MARGIN) return 0;
    const bodies = victimIsTrain ? victim.camels : victim.bodies;
    const n = bodies.length;
    for (const b of bodies) mgr?.despawn?.(b);
    this.stats.despawned += n;
    this.stats.evicted += n;
    if (victimIsTrain) victim.camels = []; else victim.bodies = [];
    return n;
  }

  /**
   * Release first, then acquire.
   *
   * The order is the one `MazeChunks`, `MazePopulation` and `MedievalResidency`
   * all use, and for the reason the last of them writes down: releasing before
   * loading keeps the peak live count at the size of the wanted set rather than
   * at the size of its union with the previous one, which against a hard cap is
   * the difference between a caravan arriving and a caravan half-arriving
   * because the last one had not let go yet.
   */
  sync(x, z) {
    const mgr = this.npcManager;
    if (!mgr) return false;
    this.stats.syncs++;
    let changed = false;
    const out2 = this.despawnRadius * this.despawnRadius;
    const in2 = this.spawnRadius * this.spawnRadius;

    /* ---- release ---------------------------------------------------- */
    for (const t of this.trains) {
      /* A body the manager no longer owns is a body that is gone - dropped by a
       * world change, or killed and cleaned up. Filtered rather than despawned,
       * or `despawn` would be called on a disposed character. */
      if (t.camels.length) t.camels = t.camels.filter((b) => mgr.owns?.(b) !== false);
      if (t.npc && mgr.owns?.(t.npc) === false) t.npc = null;
      if (!t.npc && !t.camels.length) continue;
      this.headOf(t, _p);
      if ((_p.x - x) ** 2 + (_p.z - z) ** 2 <= out2) continue;
      if (t.npc) { mgr.despawn?.(t.npc); t.npc = null; this.stats.despawned++; }
      for (const b of t.camels) mgr.despawn?.(b);
      this.stats.despawned += t.camels.length;
      t.camels = [];
      changed = true;
    }
    for (const c of this.camps) {
      if (c.bodies.length) c.bodies = c.bodies.filter((b) => mgr.owns?.(b) !== false);
      if (c.npc && mgr.owns?.(c.npc) === false) c.npc = null;
      if (!c.npc && !c.bodies.length) continue;
      const p = c.site.position;
      if ((p.x - x) ** 2 + (p.z - z) ** 2 <= out2) continue;
      if (c.npc) { mgr.despawn?.(c.npc); c.npc = null; this.stats.despawned++; }
      for (const b of c.bodies) mgr.despawn?.(b);
      this.stats.despawned += c.bodies.length;
      c.bodies = [];
      changed = true;
    }
    for (const f of this.folk) {
      if (f.npc && mgr.owns?.(f.npc) === false) f.npc = null;
      if (!f.npc) continue;
      const p = f.spec.position;
      if ((p.x - x) ** 2 + (p.z - z) ** 2 <= out2) continue;
      mgr.despawn?.(f.npc);
      f.npc = null;
      this.stats.despawned++;
      changed = true;
    }

    /* ---- acquire animals, nearest first ------------------------------ */
    let beasts = this.liveBeastCount();
    const wantB = [];
    /* SHORT, not ABSENT. The first cut skipped any group that already had a
     * body, so a herd that arrived while the cap was partly consumed stayed
     * short until the whole group despawned - even after room freed up.
     * Measured over 2,048 resident-group observations on the shipped
     * placement: group sizes seen were 1, 4, 5 and 7, and 1 and 5 are not
     * declared herd sizes anywhere. 443 of those observations were a "caravan"
     * of a single camel. */
    for (const t of this.trains) {
      const short = t.beastSpec.count - t.camels.length;
      if (short <= 0) continue;
      this.headOf(t, _p);
      const d2 = (_p.x - x) ** 2 + (_p.z - z) ** 2;
      if (d2 > in2) continue;
      wantB.push({ train: t, camp: null, d2, short, x: _p.x, y: _p.y, z: _p.z });
    }
    for (const c of this.camps) {
      const short = c.beastSpec.count - c.bodies.length;
      if (short <= 0) continue;
      const p = c.site.position;
      const d2 = (p.x - x) ** 2 + (p.z - z) ** 2;
      if (d2 > in2) continue;
      wantB.push({ train: null, camp: c, d2, short, x: p.x, y: p.y, z: p.z });
    }
    /* THE POINT OF THE WHOLE CLASS. When the cap binds it binds on the FURTHEST
     * candidate, not on whichever spec happened to be written last in the
     * roster. `spawnForWorld` does the opposite, and it is how a construction
     * zone whose own docstring says it "carries the ring's combat" once shipped
     * with zero hostiles in it. */
    wantB.sort((a, b) => a.d2 - b.d2);
    for (const w of wantB) {
      let room = this.maxLiveBeasts - beasts;
      if (room <= 0) {
        /* The list is sorted nearest-first, so if the nearest thing still
         * wanting animals cannot take budget off anybody, nothing behind it
         * can either. @see _evictFurthest. */
        const freed = this._evictFurthest(x, z, w.d2);
        if (!freed) { this.stats.refused++; break; }
        beasts -= freed;
        room = this.maxLiveBeasts - beasts;
      }
      const e = w.train ?? w.camp;
      e.beastSpec.position.set(w.x, w.y, w.z);
      /* `spawnBeastGroup` gives every member of a call the SAME `home`, which
       * is what makes them a herd rather than n animals that happen to be
       * adjacent; a top-up call joins an existing herd at the same anchor, and
       * for a train `driveHerds` re-slots the whole line on the way out of
       * `sync` anyway. */
      _topUp.position = e.beastSpec.position;
      _topUp.species = e.beastSpec.species;
      _topUp.name = e.beastSpec.name;
      _topUp.count = w.short;
      _topUp.territory = e.beastSpec.territory;
      _topUp.roamSpeed = e.beastSpec.roamSpeed;
      _topUp.spread = e.beastSpec.spread;
      const made = mgr.spawnBeastGroup?.(_topUp, room) ?? [];
      if (!made.length) { this.stats.refused++; continue; }
      const held = w.train ? w.train.camels : w.camp.bodies;
      for (const b of made) held.push(b);
      beasts += made.length;
      this.stats.spawned += made.length;
      changed = true;
    }

    /* ---- acquire humans, nearest first ------------------------------- */
    let live = this.liveCount();
    const wantP = [];
    for (const t of this.trains) {
      if (t.npc || !t.spec) continue;
      this.headOf(t, _p);
      const d2 = (_p.x - x) ** 2 + (_p.z - z) ** 2;
      if (d2 > in2) continue;
      /* The drover is put where his caravan IS, not where the road starts. A
       * train that streamed in at its own head and a drover that streamed in at
       * waypoint zero would be a caravan whose leader is 800 m behind it. */
      t.spec.position.set(_p.x, _p.y, _p.z);
      wantP.push({ e: t, spec: t.spec, d2 });
    }
    for (const c of this.camps) {
      if (c.npc || !c.keeper) continue;
      const p = c.site.position;
      const d2 = (p.x - x) ** 2 + (p.z - z) ** 2;
      if (d2 > in2) continue;
      wantP.push({ e: c, spec: c.keeper, d2 });
    }
    for (const f of this.folk) {
      if (f.npc) continue;
      const p = f.spec.position;
      const d2 = (p.x - x) ** 2 + (p.z - z) ** 2;
      if (d2 > in2) continue;
      wantP.push({ e: f, spec: f.spec, d2 });
    }
    wantP.sort((a, b) => a.d2 - b.d2);
    for (const w of wantP) {
      if (live >= this.maxLive) { this.stats.refused++; break; }
      const npc = mgr.spawnOne?.(w.spec) ?? null;
      if (!npc) { this.stats.refused++; continue; }
      w.e.npc = npc;
      live++;
      this.stats.spawned++;
      changed = true;
    }

    /* ---- and walk the herds that are already here -------------------- */
    this.driveHerds();
    return changed;
  }

  /**
   * Turn every drover to face his own caravan's leg, and put every resident
   * caravan camel back in its slot in the train.
   *
   * `BeastPack` steers nothing - every destination a beast picks comes out of
   * `BeastNPC._roam` from `this.home` and `this.nav` - so a herd follows by
   * having its HOME moved, which is the one lever this file owns without
   * editing `BeastNPC`. Each animal gets the point {@link TRAIN_GAP} metres
   * further back down the road than the one in front of it, which is the same
   * 4 m slot the encounter measurement counts animals in.
   *
   * Called from `sync`, so at most every 0.4 s: one ground probe per resident
   * animal, twelve at the cap.
   */
  driveHerds() {
    const mgr = this.npcManager;
    for (const t of this.trains) {
      const L = t.road.length;
      /* THE DROVER WALKS THE LEG HIS CARAVAN IS ON.
       *
       * `NPC.routeAhead` treats an open patrol as out-and-back and reverses at
       * each end on its OWN schedule, with nothing tying it to the train. So
       * for half of every cycle the drover walked one way and his animals the
       * other, and the two separated without bound - measured at 505.8 m on a
       * return-leg train against a declared 25 m leash. `patrolDir` is the one
       * field `routeAhead` reads before it decides, and it re-derives the rest
       * from the waypoint nearest the character, so writing it here is enough
       * to turn him round without touching his path. */
      if (t.npc && !t.npc.isDead && mgr?.owns?.(t.npc) !== false) {
        t.npc.patrolDir = t.arc <= L ? 1 : -1;
      }
      if (!t.camels.length) continue;
      for (let i = 0; i < t.camels.length; i++) {
        const b = t.camels[i];
        if (mgr?.owns?.(b) === false) continue;
        /* Laid out on the CYCLE and then folded, not on the folded arc.
         *
         * Clamping each slot at arc 0 telescoped the whole train onto the head
         * of the road: measured with a mesa-spine train at arc 0, all seven
         * anchors were the single point (0.00, 102.00) - and `world.playerSpawn`
         * is (0, 14.3, 104), two metres away, so a session could begin inside a
         * pile of seven stacked camels. That state occupies 10.7% of the
         * mesa-spine cycle. Folding the slot instead wraps the tail round the
         * turn behind the head, which is where it physically is. */
        pointAtArc(t.road.points, t.road.arcs, cycleArc(t.arc - (i + 1) * TRAIN_GAP, L), _q);
        /* `resolveSurfaceY` and NOT `physics.groundHeight`, for the reason
         * `roadWaypoints` spends a paragraph on 400 lines above and this method
         * then ignored. `groundHeight` returns the first surface below the top
         * of its probe window, so on the mesa it resolves the road onto souk
         * ROOFS: measured at 1 m steps along the three roads, mesa-spine has
         * seven spans totalling 27 m where the two disagree by more than a
         * metre, worst +6.00 m at (-40, -91) - 14.00 m of road answered as
         * 20.00 m of roof. A `home` six metres in the air is permanently
         * outside a 2.5 m territory, so `_roam` re-targets every step,
         * `_wanderNear` probes from the roof and `nav._clearLine` rejects all
         * six candidates - and the animal stops dead. */
        const g = resolveSurfaceY(this.physics, _q.x, _q.z, _q.y);
        b.home.set(_q.x, g ?? _q.y, _q.z);
      }
    }
  }

  /** Release everything. The teardown path. */
  disposeAll() {
    const mgr = this.npcManager;
    const drop = (n) => { if (n && mgr?.owns?.(n) !== false) mgr?.despawn?.(n); };
    for (const t of this.trains) {
      drop(t.npc);
      t.npc = null;
      for (const b of t.camels) drop(b);
      t.camels = [];
    }
    for (const c of this.camps) {
      drop(c.npc);
      c.npc = null;
      for (const b of c.bodies) drop(b);
      c.bodies = [];
    }
    for (const f of this.folk) { drop(f.npc); f.npc = null; }
  }

  /** `World.dispose` walks `_owned` and calls this. */
  dispose() {
    this.disposeAll();
  }
}

/* ================================================================== */
/* The well head itself                                                */
/* ================================================================== */

/** Mud-brick and sun-bleached timber, so a well reads as a well from 40 m. */
const KERB_TINT = 0xb7a37c;
const TIMBER_TINT = 0x8a6a45;
const CANVAS_TINT = 0xd8c9a6;

/**
 * How wide a well's furniture spreads, metres.
 *
 * The kerb, the trough and the awning all sit inside this radius, and it is the
 * same number the herd's `spread` uses, so the animals stand round the water
 * rather than beside a shed. Deliberately small: the smallest measured
 * clearance of the eight sites is 23 m (`pit-road`), so a 5.5 m footprint has
 * seventeen metres of margin at the tightest of them.
 */
export const WELL_R = 5.5;

/**
 * Build one wayside well.
 *
 * ── Why this is not an oasis ──────────────────────────────────────────────
 *
 * `citadel/Oasis.js` opens with the constraint: `Physics` treats a heightfield
 * as solid from its surface down to `baseY`, so a pool cannot be dug, and its
 * answer is a stepped mud-brick tank whose waterline necessarily stands above
 * the desert. That tank is 53.8 x 50.8 m and needs 1.20 m of relief or less
 * over the whole of it, which exists in 18 places in this world and all of them
 * in the south-west.
 *
 * A well needs none of that. There is no open water: a kerb over a shaft, a
 * windlass, a stone trough the water is poured into, and an awning. It levels
 * nothing, so it can stand on the eight sites the ENCOUNTER measurement chose
 * rather than on the eight the terrain allows.
 *
 * ── The cost, and why it is emitted through the host's batch ─────────────
 *
 * 26 boxes into two of the world's existing material buckets and 10 colliders,
 * both counted off the build's own report rather than off this list: 8 kerb
 * blocks, 4 windlass, 5 trough, 6 awning, 1 cloth and 2 crates; colliders are
 * the kerb ring, the trough, two windlass posts, four awning posts and the two
 * crates. The first cut of this comment said 22 and 8.
 * `ctx.box` is `CitadelWorld`'s own `Batch.box`, so a well adds no material and
 * no draw call of its own - it joins the same `stone.cobble` and `wood.beam`
 * merges the souk and the dressing already flush, and `_splitDistricts` then
 * cuts the merged result into leaves under the 130 m sphere ceiling, which is
 * what keeps eight wells spread over 900 m from becoming one uncullable mesh.
 *
 * Colliders are given only to what a player can walk into - the kerb ring as
 * one block, the trough, the four awning posts and the two crates. The windlass
 * beam is 2.1 m up and the awning cloth is 2.5 m up; both are drawn and neither
 * is solid, because a collider a body cannot reach is a broadphase cell for
 * nothing.
 *
 * @param {{box:Function, physics:any, track?:Function}} ctx
 * @param {{id:string,label:string,x:number,z:number}} site
 * @param {number} y ground height at the site, resolved by the caller
 * @param {number} [yaw]
 * @returns {{colliders:any[], boxes:number, spots:Array<{x:number,y:number,z:number}>}}
 */
export function buildWell(ctx, site, y, yaw = 0) {
  const track = ctx.track ?? ((c) => c);
  const colliders = [];
  let boxes = 0;
  const cos = Math.cos(yaw);
  const sin = Math.sin(yaw);
  /** Local (right, forward) -> world, so a whole well rotates with `yaw`. */
  const wx = (lx, lz) => site.x + lx * cos - lz * sin;
  const wz = (lx, lz) => site.z + lx * sin + lz * cos;
  const box = (key, w, h, d, lx, cy, lz, tint, collide) => {
    ctx.box(key, w, h, d, wx(lx, lz), cy, wz(lx, lz), yaw, tint);
    boxes++;
    if (!collide) return;
    colliders.push(track(ctx.physics.addBox(
      wx(lx, lz), cy, wz(lx, lz), w * 0.5, h * 0.5, d * 0.5
    )));
  };

  /* The shaft head: an octagonal kerb 1.5 m across, knee high. Eight arc
   * blocks drawn, ONE collider across the middle of them - a player cannot get
   * inside a ring 1.5 m wide and eight colliders there would be eight
   * broadphase entries for a single obstacle. */
  const kerbR = 0.75;
  for (let i = 0; i < 8; i++) {
    const a = (i / 8) * Math.PI * 2;
    box('stone.cobble', 0.62, 0.62, 0.28,
      Math.cos(a) * kerbR, y + 0.31, Math.sin(a) * kerbR, KERB_TINT, false);
  }
  colliders.push(track(ctx.physics.addBox(site.x, y + 0.31, site.z, 1.05, 0.31, 1.05)));

  /* The windlass over it. Two posts and a beam, and the beam is out of reach. */
  box('wood.beam', 0.16, 2.1, 0.16, 0, y + 1.05, -1.05, TIMBER_TINT, true);
  box('wood.beam', 0.16, 2.1, 0.16, 0, y + 1.05, 1.05, TIMBER_TINT, true);
  box('wood.beam', 0.14, 0.14, 2.3, 0, y + 2.05, 0, TIMBER_TINT, false);
  box('wood.beam', 0.34, 0.34, 0.34, 0, y + 2.05, 0.35, TIMBER_TINT, false);

  /* The trough the water goes into, which is the reason the herd is here.
   * Two sides, two ends and a floor, 3.4 m long: the thing an animal stands at.
   */
  const tX = 3.0;
  box('stone.cobble', 3.4, 0.16, 1.0, tX, y + 0.08, 0, KERB_TINT, false);
  box('stone.cobble', 3.4, 0.44, 0.16, tX, y + 0.30, -0.42, KERB_TINT, false);
  box('stone.cobble', 3.4, 0.44, 0.16, tX, y + 0.30, 0.42, KERB_TINT, false);
  box('stone.cobble', 0.16, 0.44, 0.68, tX - 1.62, y + 0.30, 0, KERB_TINT, false);
  box('stone.cobble', 0.16, 0.44, 0.68, tX + 1.62, y + 0.30, 0, KERB_TINT, false);
  colliders.push(track(ctx.physics.addRotatedBox(
    new THREE.Vector3(wx(tX, 0), y + 0.26, wz(tX, 0)),
    new THREE.Vector3(1.7, 0.26, 0.5), yaw
  )));

  /* The awning: where the keeper sits out the middle of the day. Four posts,
   * a cloth and two cross-beams. */
  const aX = -3.2;
  for (const [px, pz] of [[-1.5, -1.4], [-1.5, 1.4], [1.5, -1.4], [1.5, 1.4]]) {
    box('wood.beam', 0.14, 2.3, 0.14, aX + px, y + 1.15, pz, TIMBER_TINT, true);
  }
  box('wood.beam', 3.3, 0.12, 0.12, aX, y + 2.32, -1.4, TIMBER_TINT, false);
  box('wood.beam', 3.3, 0.12, 0.12, aX, y + 2.32, 1.4, TIMBER_TINT, false);
  /* The cloth is TINTED TIMBER rather than `fabric.banner`, and the reason is a
   * measured one. Eight wells spread over 900 m put one box each into their
   * shared bucket; `splitDistricts` splits by radius but will not keep dividing
   * a leaf that carries almost no geometry, so the eight-box banner bucket came
   * back as four leaves with the worst still 171.9 m across - over the 130 m
   * ceiling, and therefore a mesh the frustum can never reject. The timber
   * bucket carries nine boxes per well and splits to 5 leaves under 40 m. A
   * third material for eight boxes is not worth an uncullable draw call. */
  box('wood.beam', 3.5, 0.06, 3.0, aX, y + 2.42, 0, CANVAS_TINT, false);

  /* Two crates of cargo under it, so the well reads as a stop on a road rather
   * than a well in a field. */
  box('wood.beam', 0.9, 0.7, 0.7, aX + 0.9, y + 0.35, -0.7, TIMBER_TINT, true);
  box('wood.beam', 0.8, 0.6, 0.8, aX - 0.7, y + 0.30, 0.6, TIMBER_TINT, true);

  /* Where a keeper stands and where an animal drinks: published so the world
   * does not have to re-derive the layout to put anybody in it. */
  const spots = [
    { x: wx(aX + 1.6, 0.9), y, z: wz(aX + 1.6, 0.9) },
    { x: wx(tX, -1.8), y, z: wz(tX, -1.8) },
  ];
  return { colliders, boxes, spots };
}
