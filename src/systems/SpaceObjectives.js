import { SPACE_BODIES, BODY_BY_ID, DOCK_ANCHOR, landableBodies } from '../worlds/space/Bodies.js';
import { ALIEN_CLASSES } from '../npc/AlienShip.js';

/**
 * THE THREE THINGS THE PLAYER ASKED FOR.
 *
 * Verbatim: *"so i have a few objectives, kill spacealiens, reach planets,
 * mine for rare elements"*. All three existed as VERBS before this file - you
 * could shoot a skiff, you could land on Cinder, you could cut a seam - and
 * none of them was an OBJECTIVE: nothing counted them, nothing paid for them,
 * nothing survived a reload, and nothing on screen said how you were doing.
 *
 * ===========================================================================
 *  WHY THIS IS ONE FILE AND NOT THREE
 * ===========================================================================
 *
 * Because they are one ledger with three columns, and the hard parts are
 * shared: the identity-not-count persistence rule, the pay-once rule, the
 * REPLACE-on-load rule, and the single HUD surface. Three files would be three
 * copies of all four.
 *
 * The shape is `Viewpoints.js`'s, deliberately and almost line for line, because
 * that shape works and is the strongest precedent in this repo:
 *
 *   - it consumes what other systems ALREADY emit and defines no new content;
 *   - every prize is paid exactly once and a load never re-pays it;
 *   - `serialize`/`deserialize` are plain JSON through `SaveGame`;
 *   - `deserialize` REPLACES rather than merges, so a load can take progress
 *     AWAY (the rule `MountManager`, `Relics` and `Viewpoints` all record);
 *   - there is no account, no API and no login on any path in this file. Every
 *     one of the three objectives works signed out, because every one of them
 *     is local state over local events.
 *
 * ===========================================================================
 *  IDENTITY, NOT COUNT. THE ONE DEFECT THIS FILE MUST NOT REPEAT
 * ===========================================================================
 *
 * `Relics.serialize` writes `{ found: { citadel: 17 } }` - a COUNT - and
 * `_applyFound` stamps the first seventeen sites in publication order on the
 * way back in. Reload after finding relics 3, 9 and 21 and the map marks 1, 2
 * and 3. The tally is right and every marked thing is wrong.
 *
 * So nothing here persists a bare number that a set could persist instead:
 *
 *   kills    per-CLASS counts, keyed by class id. The total and the bounty are
 *            recomputed from them on load, so the summary can never disagree
 *            with the detail - there is only one authority.
 *   wings    a SET of zone ids. Which named wing you broke, not how many. The
 *            roster of which wings EXIST rides alongside it, learned from the
 *            worlds visited, exactly as the element chart is.
 *   survey   a MAP of body id -> 'sighted' | 'landed'. Which worlds you have
 *            been to, and whether you set down.
 *   ore      per-ELEMENT counts and value, keyed by the element id the mineral
 *            system publishes. The roster of what exists is a second map,
 *            learned from the worlds visited (see `_learnElements`).
 *
 * The one thing stored as a bare number is `tier` on the two ladders: the
 * highest rung already PAID. That is not progress, it is a receipt, and it is
 * the same thing `Viewpoints._setPaid` and `Relics._paid` are.
 *
 * ===========================================================================
 *  EVERY THRESHOLD IN THIS FILE WAS FLOWN
 * ===========================================================================
 *
 * The house rule is that thresholds and rewards are MEASURED from what is
 * achievable, never guessed - "a gold nobody can reach is the same defect as a
 * relic nobody can find". Six probes over the real `_flightrig.mjs` (the real
 * `WorldManager`, the real `Physics`, the real `Flight` integrator, the real
 * `SpaceCombat`) produced every number below. The runs are re-derived in
 * `scripts/tests/space-objectives.test.mjs`, which fails if the world moves out
 * from under them.
 *
 * Nothing in here is a round number that was chosen because it was round.
 */

/* ==================================================================== */
/* 1. SURVEY - reaching the bodies                                       */
/* ==================================================================== */

/**
 * How much of the screen a body must fill before it counts as reached.
 *
 * -- Why a screen fraction and not a distance -------------------------------
 * The bodies are 4.2 km (Tessera) to 38 km (Ceraunus) in radius - a factor of
 * nine - so any single distance is either unreachable for the small ones or
 * free for the big ones. `Bodies.APPROACH_AT_RADII` (6 body radii) is the
 * published alternative and it fails the same way in the other direction: six
 * Ceraunus radii is 228 km, and Ceraunus is only 245 km from the yard, so the
 * gas giant would be "reached" from 17 km outside the hangar door.
 *
 * A screen fraction is size-independent and it is the thing actually being
 * claimed: you went close enough to LOOK at it. It is also the instrument
 * `Bodies.js` already chose its sizes with, at the same 75 degree vertical FOV
 * (`CONFIG.render.fov`), so this file and that one measure with one ruler.
 *
 * -- Why 0.50 and not 0.30 or 0.71 ------------------------------------------
 * Flown, from the launch point outside the hangar mouth, nose already on the
 * target, throttle pinned, through the real command struct - so transit engages
 * exactly as it does for a player. `trip` is how far there is left to cover
 * from the yard once the survey sphere is subtracted.
 *
 *              frac 0.30                 frac 0.50                frac 0.71
 *   body      radius  trip     t       radius  trip     t      radius  trip    t
 *   cinder     46.1km  15.9  21.1 s     28.0km  34.0  36.0 s    20.1  41.9  40.6
 *   tessera    21.5    66.5  56.0       13.0    74.9  60.9       9.4  78.6  63.1
 *   vitrine    76.9    78.1  61.6       46.7   108.3  79.2      33.5 121.5  86.9
 *   ceraunus  194.8    50.2  45.8      118.2   126.8  90.4      84.8 160.2 109.8
 *   erenmark   79.5   560.5 345.5       48.2   591.8 363.7      34.6 605.4 371.6
 *
 * 0.30 is rejected on Ceraunus: a 50 km hop off the pier surveys the largest
 * thing in the sky, and the trip ordering goes wrong - the gas giant becomes
 * cheaper to reach than the moonlet next door. 0.71 buys 20 more seconds per
 * body over 0.50 and changes nothing about which trips are worth making.
 *
 * At 0.50 no survey sphere contains the yard (the nearest, Cinder's, starts
 * 34.0 km out), the five trips run 36 / 61 / 79 / 90 / 364 seconds in the same
 * order as their distances, and the body fills half the screen when it fires -
 * which is unmistakably "I went and looked at it".
 */
export const SURVEY_FRACTION = 0.50;

/**
 * `CONFIG.render.fov`. Duplicated as a literal for the same reason
 * `space-scale.test.mjs` duplicates it: nothing in the survey arithmetic should
 * need the browser config loaded to answer "how far away is that".
 */
export const SURVEY_FOV_DEG = 75;

/**
 * Metres from a body's CENTRE at which it fills {@link SURVEY_FRACTION} of the
 * screen height.
 *
 * The exact inverse of `Scale.screenFraction`, which is
 * `2 * asin(R/D) / fovRad`; solving for D gives `R / sin(f * fovRad / 2)`.
 * At f = 0.50 and fov = 75 that is a constant 3.11097 body radii - but the
 * constant is never written down here, and the test checks this function
 * against `screenFraction` itself so the two cannot drift.
 *
 * @param {number} radius body radius in metres
 * @returns {number} metres from the body centre
 */
export function surveyRange(radius) {
  const fovRad = (SURVEY_FOV_DEG * Math.PI) / 180;
  return radius / Math.sin((SURVEY_FRACTION * fovRad) / 2);
}

/**
 * The pay rate for reaching somewhere, in credits per second of the flight it
 * takes to get there.
 *
 * A flat per-body payment was the first draft and it is the guessed-reward
 * defect in its purest form: Erenmark is a twelve-minute round trip and Cinder
 * is a one-minute hop, and paying them the same makes the far half of the
 * layout content nobody has a reason to visit.
 *
 * 4 cr/s puts a survey sweep of all twelve bodies at 5,650 credits - 471 a
 * body. The band it was set in was written for the five bodies of Phase 1 and
 * has to be restated PER DESTINATION now that there are twelve, because a total
 * that grew by a factor of 2.4 says nothing about whether the rate is right:
 * every body pays at least what walking to a citadel viewpoint pays
 * (`Viewpoints.SYNC_CREDITS`, 150 - and Cinder, the shortest hop in the volume,
 * is exactly that), and the average body pays less than the whole five-viewpoint
 * citadel set (750). The rate itself did not move; only the number of places to
 * spend it on did.
 */
export const SURVEY_CR_PER_SECOND = 4;

/**
 * The outbound leg, as a straight line fitted to five flown trips.
 *
 * `t = LEG_FIXED_S + km * LEG_PER_KM_S` over the frac-0.50 column above:
 *
 *   body       trip km   flown     fit    error
 *   cinder        34.0    36.0 s   36.0 s   0.0
 *   tessera       74.9    60.9     60.0    -0.9
 *   vitrine      108.3    79.2     79.6    +0.4
 *   ceraunus     126.8    90.4     90.5    +0.1
 *   erenmark     591.8   363.7    363.6    -0.1
 *
 * A line rather than a table of five body ids on purpose: a sixth body added to
 * `SPACE_BODIES` gets a payout that is correct for its distance without anybody
 * remembering to come back here, and a payout nobody remembered would be a
 * zero. LEG_PER_KM_S is 0.5875 s/km - an effective 1,702 m/s, which is the
 * cruise ceiling under the x8 transit multiplier net of the spin-up.
 */
export const LEG_FIXED_S = 16.0;
export const LEG_PER_KM_S = 0.5875;

/**
 * The landfall leg, flown: 42.5 s from Cinder's survey sphere to wheels down.
 *
 * 26.2 s from the 28.0 km survey sphere to the seam where the surface world
 * takes the ship, then 16.3 s of pad approach and touchdown at Ashfall Flat.
 *
 * It is a bonus and not a second grade of the survey because of what the player
 * actually said - "reach planets" - and because two of the twelve bodies
 * (Ceraunus and Erenmark) have no `handoff` at all: making the survey itself
 * conditional on landing would leave the star and the gas giant permanently at
 * half credit for a reason that is about them having no ground rather than
 * about the flying.
 *
 * This constant is now the RECORD of the one landing that was flown rather than
 * the payout - see {@link landfallSeconds}, which reproduces it to within half a
 * second from Cinder's own published numbers and then pays the other nine
 * bodies correctly without anybody coming back here.
 */
export const LANDFALL_S = 42.5;

/**
 * Degrees of horizon a pad may lose and still be recommended by {@link
 * SpaceObjectives#richerPad}.
 *
 * `PlanetWorld` marches the height field around each landing disc and
 * publishes `drop: { deg, metres }`. Rimhold Shelf - the richest pad on Cinder
 * by a factor of five - reads 270 degrees and a 66.9 m fall, and it is one of
 * the pads a player can walk off and not climb back onto. 180 is the honest
 * line for "a shelf rather than a clearing": at or under half the horizon
 * there is always a side you came up. It is deliberately not tuned finer than
 * that, because the underlying question is reachability and this is a proxy
 * for it; the day a flood result is published per pad, this reads that instead.
 */
export const PAD_RIM_LIMIT = 180;

/**
 * The in-world half of a descent, in seconds per kilometre of handoff altitude.
 *
 * 16.3 s of the flown leg above was spent BELOW the handoff - inside the
 * surface world, from the 900 m at which `Bodies.js` hands Cinder over
 * (`handoff 9,900` against `radius 9,000`) down onto the pad. 16.3 / 0.9 km is
 * 18.1 s/km, an average 55 m/s, which is what a controlled descent onto a pad
 * looks like as opposed to the 1,700 m/s of the cruise above it.
 *
 * The handoff altitude is not the same on every body - it runs from 700 m
 * (Tessera, Lathe) to 1,400 m (Shoal, Verdigris) - so this is a rate and not a
 * second flat constant. See {@link landfallSeconds} for why air does NOT get a
 * term of its own.
 */
export const LANDFALL_PAD_PER_KM_S = 18.1;

/** Round a payout to something a HUD can print, never below one increment. */
function round25(n) {
  return Math.max(25, Math.round(n / 25) * 25);
}

/**
 * What reaching one body pays, derived from where it is.
 * @param {{position:number[], radius:number}} body
 */
export function surveyReward(body) {
  const d = Math.hypot(
    body.position[0] - DOCK_ANCHOR.position[0],
    body.position[1] - DOCK_ANCHOR.position[1],
    body.position[2] - DOCK_ANCHOR.position[2]
  );
  const tripKm = Math.max(0, d - surveyRange(body.radius)) / 1000;
  return round25(SURVEY_CR_PER_SECOND * (LEG_FIXED_S + tripKm * LEG_PER_KM_S));
}

/**
 * HOW LONG A DESCENT ONTO ONE BODY TAKES, FROM THE BODY'S OWN NUMBERS.
 *
 * The same move `surveyReward` makes and for the same stated reason: a line
 * fitted to a flown leg beats a table of body ids, because "a sixth body added
 * to `SPACE_BODIES` gets a payout that is correct for its distance without
 * anybody remembering to come back here". Phase 2 added seven, and a flat
 * `LANDFALL_CREDITS` paid every one of them Cinder's number.
 *
 * Two segments, because they are flown at two different speeds:
 *
 *   sphere -> handoff   the same cruise line the outbound leg uses
 *                       (`LEG_FIXED_S + km * LEG_PER_KM_S`). This is where the
 *                       transit drive's altitude governor is doing the braking,
 *                       which is exactly the regime the line was fitted in.
 *   handoff -> pad      `LANDFALL_PAD_PER_KM_S` per km of handoff altitude.
 *
 * Checked against the one landing that was flown: Cinder's sphere is 28.0 km
 * and its handoff 9.9 km, so 18.1 km of cruise = 16.0 + 10.6 = 26.6 s against
 * 26.2 s measured; its handoff altitude is 900 m, so 0.9 * 18.1 = 16.3 s
 * against 16.3 s measured. 42.9 s against {@link LANDFALL_S}'s flown 42.5.
 *
 * -- WHAT DRIVES IT IS THE BODY'S SIZE, NOT ITS DISTANCE, AND THAT IS RIGHT ---
 * Cathedra is 288 km out and Cinder 62, and Cathedra's descent is the SHORTER
 * of the two - because the survey sphere scales with radius and Cathedra is a
 * 6.8 km body against Cinder's 9.0. The kilometres between the yard and the
 * planet were already paid for by `surveyReward`; paying for them twice would
 * be paying twice for the same flying. What the landfall pays for is the part
 * of the trip the survey did not cover: the fall from the sphere to the ground.
 *
 * -- AIR DOES NOT GET A TERM, AND HERE IS WHY --------------------------------
 * An airless body does have the shorter descent, and it already comes out that
 * way without a special case: Tessera and Lathe, the two bodies with
 * `atmosphere === radius`, carry the two SHORTEST handoff altitudes in the
 * system (700 m each, against 800-1,400 m for everything with air) and land at
 * the bottom of the payout table at 125 and 150. That is the geometry saying
 * what the airlessness says, from a number `Bodies.js` already publishes for
 * another reason. A separate airless term would be a second copy of the same
 * fact, and - worse - a guessed one: nobody has flown an airless descent to
 * measure how much a vacuum is worth, and this file does not carry numbers
 * nobody flew.
 *
 * @param {{radius:number, handoff:number}|null} body
 * @returns {number} seconds; never negative, never non-finite
 */
export function landfallSeconds(body) {
  const radius = Number(body?.radius);
  const handoff = Number(body?.handoff);
  /* A body with no handoff is not landable, so there is no descent to price.
   * Reachable through `_landfall` if a `pilot:entry` ever names one, and a NaN
   * out of here would become a NaN in the wallet. */
  if (!Number.isFinite(radius) || !Number.isFinite(handoff) || handoff <= radius) {
    return LEG_FIXED_S;
  }
  const cruiseKm = Math.max(0, surveyRange(radius) - handoff) / 1000;
  const padKm = (handoff - radius) / 1000;
  return LEG_FIXED_S + cruiseKm * LEG_PER_KM_S + padKm * LANDFALL_PAD_PER_KM_S;
}

/**
 * What setting down on one body pays, once, on top of the survey.
 * @param {{radius:number, handoff:number}|null} body
 */
export function landfallReward(body) {
  return round25(SURVEY_CR_PER_SECOND * landfallSeconds(body));
}

/**
 * The reference landfall: what the one descent that was actually FLOWN pays.
 *
 * Kept as a constant - `scripts/contract-check.mjs` names it as part of this
 * module's published surface, and it is the number every landfall case in the
 * suite was written against - but it is no longer what "a landing" pays,
 * because there is no longer one answer to that. It is Cinder's row of
 * {@link landfallReward}'s table and nothing else, and it is here so the flown
 * measurement and the law that replaced it can be compared in one line: the law
 * has to still produce 175 for the body it was fitted to.
 */
export const LANDFALL_CREDITS = landfallReward(BODY_BY_ID.cinder ?? landableBodies()[0] ?? null);

/**
 * The bodies a ship can set down on, resolved once.
 *
 * `SPACE_BODIES.length` is the survey denominator and it is RIGHT for the
 * survey: you reach Erenmark by flying at it until it fills half the screen,
 * and the star has no ground to stand on. It is wrong for landfall, which is
 * why landfall now has its own - see {@link SpaceObjectives#landfallTotal}.
 * @type {ReadonlyArray<object>}
 */
const LANDABLE = Object.freeze(landableBodies());

/** The whole set of bodies: a flight suit credits cannot buy. */
export const SURVEY_SET_COSMETIC = 'char_aurora';

/**
 * THE SECOND SET PRIZE, AND WHY THERE ARE NOW TWO.
 *
 * Surveying all twelve bodies is twelve fly-bys. Landing on all ten landable
 * ones is ten fly-bys AND ten descents AND ten climbs back out, two of them
 * onto airless rock - strictly the harder of the two, and a strict superset of
 * the flying. With one set prize the harder thing paid nothing, which is the
 * same shape of defect as a rung nobody can reach: a thing that is built,
 * counted, drawn on the HUD, and worth no more than not doing it.
 *
 * `char_jade` because it is a real, unlocked-once id in `Cosmetics.CHARACTER_SKINS`
 * that no other prize claims - `Cosmetics.unlock` REFUSES an id it does not
 * know, so inventing one would have been a prize that silently never arrived.
 * `char_aurora` (survey), `char_midnight` (Sablebane) and `char_ember` (the ore
 * ladder) are the three already spoken for; `char_jade` and `char_violet` were
 * the two spare.
 *
 * The refit is `hold`, and that completes a four-way mapping this file did not
 * plan and should not break now that it exists: kills pay `fire` (the gun the
 * kills were made with), the wings pay `shield` (what a fight costs you), the
 * survey pays `power` (getting there), and the landings pay `hold` - the room
 * to bring back what ten worlds have in the ground. It is also the only one of
 * the four stats no SET grants; it hangs on an ore RUNG, and
 * `ship-customizer.test.mjs` pins that there is exactly ONE ore rung granting
 * it, which a set prize does not disturb.
 */
export const LANDFALL_SET_COSMETIC = 'char_jade';
export const LANDFALL_SET_POWER = 'hold';

/* ==================================================================== */
/* 2. KILLS - the ladder, and the named wings                            */
/* ==================================================================== */

/**
 * THE KILL LADDER, IN SWEEPS OF THE INNER SYSTEM.
 *
 * `SpaceWorld._fillEncounters` authors TWELVE zones holding thirty hostiles,
 * and the ladder is deliberately NOT built on all of them. Nine of the twelve
 * are approach pickets on runs of 77 to 274 km, so one full sweep of the
 * volume is a fifteen-hundred-kilometre grand tour: a campaign, not a session,
 * and no use at all as a rung.
 *
 * What it is built on is the INNER SYSTEM - everything inside Cinder's orbit,
 * which is three zones holding nine hostiles between them: two skiffs on the
 * Ashlane, two skiffs and a lance over Cinder, three skiffs and a lance in the
 * Reach. **Nine kills is one full sweep of the run every player flies first**,
 * and that is a fact about the content rather than a number somebody liked.
 *
 * Phase 2 did not move it, which is the point of stating it that way: nine
 * more landable worlds put pickets FURTHER OUT rather than more of them closer
 * in, so the inner three are the same three and the flown evidence below still
 * measures the thing the rung is made of. A planet added inside Cinder's orbit
 * WOULD move it, and `space-objectives.test.mjs` re-derives the rung by
 * distance so that it goes red rather than drifting.
 *
 * The rungs above it are rearm-limited, not skill-limited: a cleared zone
 * rearms after 240 s (the Ashlane), 300 s (Cinder orbit) or 420 s (the Reach),
 * so however good a pilot is, the second sweep cannot start until the first
 * zone comes back.
 *
 * -- Flown: twenty minutes of continuous hunting ----------------------------
 * One unbroken 1,200 s flight, stock Kestrel, autopilot steering at the same
 * lead point the HUD pip is drawn at, moving to the next zone whenever the one
 * it was in went quiet. 29 kills, 2,345 credits of bounty, shot down twice on
 * the way.
 *
 *   kill  #3 at   91 s  (1.5 min)   first wing with a lance in it broken
 *   kill  #9 at  148 s  (2.5 min)   every inner-system zone cleared once
 *   kill #18 at  651 s (10.8 min)   second sweep, after waiting out a rearm
 *   kill #27 at 1145 s (19.1 min)   third sweep
 *
 * Those four are the ladder. They are a CEILING - a machine with a perfect
 * firing solution flew them and a human will be slower - which is the right
 * side to err on for a threshold: the claim being made is "this is reachable",
 * and it was reached.
 *
 * Payouts are set against the bounty the same kills already pay. Nine kills is
 * 745 cr of bounty and about 500 more in salvage if the hold has room; the
 * ladder adds 3,250 across all four rungs, so hitting every milestone roughly
 * doubles what a hunter earns rather than replacing it.
 */
export const KILL_TIERS = Object.freeze([
  Object.freeze({ kills: 3, title: 'Blooded', credits: 150, item: 'laser_cell', qty: 20 }),
  Object.freeze({ kills: 9, title: 'Wingbreaker', credits: 400, item: 'laser_cell', qty: 40 }),
  Object.freeze({ kills: 18, title: 'Lanekeeper', credits: 900, item: 'hull_plate', qty: 2 }),
  Object.freeze({
    kills: 27,
    title: 'Sablebane',
    credits: 1800,
    item: 'thruster_coil',
    qty: 2,
    /* The gun the kills were made with. `fire` is "15% laser damage" per tier
     * in `SHIP_STAT_META`, which is the panel's own published copy. */
    power: 'fire',
    cosmetic: 'char_midnight',
  }),
]);

/**
 * What breaking a named wing for the first time pays: **the wing's own bounty,
 * again**.
 *
 * Not a new constant. Every zone already publishes its composition and every
 * class already publishes its bounty, so the first-clear prize is derived from
 * the thing being cleared and escalates by itself - 110 cr for the two skiffs
 * on the Ashlane, 290 over Cinder, 345 in the Reach. A wing that gets a third
 * skiff tomorrow pays more tomorrow, and nobody has to remember this file.
 *
 * It is also why Phase 2's nine approach pickets needed nothing here at all:
 * the Shoal toll's single lance pays 180 and the Cathedra spire watch's three
 * hulls pay 290 because that is what those hulls are worth, and neither number
 * was typed anywhere.
 *
 * @param {{wing?:Array<{class:string,count:number}>}} zone
 */
export function wingBounty(zone) {
  let total = 0;
  for (const w of zone?.wing ?? []) {
    const def = ALIEN_CLASSES[w?.class];
    if (def) total += (Number(w.count) || 0) * def.bounty;
  }
  return total;
}

/**
 * EVERY named wing broken: a shields refit, paid once.
 *
 * "Every", not "all three". The denominator is `wingTotal`, which is LEARNED
 * from whatever the live world authors rather than written down, so Phase 2
 * turned this from a three-wing errand into a twelve-wing one - a sweep of the
 * entire volume, every planet visited - without a line changing here. That
 * escalation is intended: a refit that any pilot completes on their first
 * afternoon is not a reward for finishing the system.
 */
export const WING_SET_POWER = 'shield';

/* ==================================================================== */
/* 3. ORE - the assay chart and the haul                                 */
/* ==================================================================== */

/**
 * ONE MINERAL FIELD, IN CREDITS. The unit the top of the haul ladder is
 * spaced in, and the one number in this section that had to be measured.
 *
 * `sum(unitValue * hold * count)` over Cinder's six minerals: 34 tephra at 18,
 * 26 sulfur at 32, 20 obsidian at 68, 18 ferro-basalt at 104, 12 rheniite at
 * 190 and 9 iridite at 310. 119 nodes, 9,746 credits.
 *
 * -- Why the DESCRIPTOR mid and not the 9,927 the world places ---------------
 * `PlanetWorld` rolls each node's value within the mineral's `spread`, so the
 * field as BUILT is 9,927 credits this seed and something else the next. The
 * descriptor mid is the same field with the dice taken out, it is 181 credits
 * LOWER than the placed one, and low is the side to err on: every rung derived
 * from it is a rung slightly easier than the ore that is really there.
 *
 * -- Why it is written down here rather than imported -----------------------
 * `PLANETS` lives in `src/worlds/planets/index.js`, which imports `PlanetWorld`
 * and therefore `three` and therefore the whole world stack; this file's import
 * graph is two frozen data modules and `space-objectives.test.mjs` asserts
 * exactly that, because these three objectives have to work signed out and
 * offline. So the number is scraped by the TEST instead, which re-derives it
 * from every descriptor `PLANETS` holds and fails if this constant has drifted
 * above what a field actually contains.
 *
 * TO RE-DERIVE:
 *
 *   node -e "import('./src/worlds/planets/index.js').then(({PLANETS})=>{
 *     for (const p of Object.values(PLANETS))
 *       console.log(p.id, p.minerals.reduce((s,m)=>s+m.unitValue*m.hold*m.count,0));
 *   })"
 *
 * and set this to the SMALLEST field the run prints, not the mean - the ladder
 * has to be climbable by a player who picked the poorest ten fields to work.
 *
 * ── RE-DERIVED WHEN THE OTHER NINE LANDED ────────────────────────────────
 * It was 9,746, which was Cinder, because Cinder was the only descriptor there
 * was. The ten now read:
 *
 *     tessera   5,168      cinder     9,746      carnelian 10,200
 *     shoal     7,420      vitrine    9,212      verdigris 11,482
 *     sirocco   8,952                            cathedra  12,208
 *                                                sallow    12,748
 *                                                lathe     13,912
 *
 * so the unit is TESSERA at 5,168, not Cinder. That is not a downgrade: the
 * poorest field is the correct unit precisely because the rung has to be
 * reachable on the planet a player actually chose, and Tessera is the airless
 * moonlet with four ores where every other world has five or six. A ladder
 * spaced in Cinders asks a Tessera prospector for 1.9 fields to make one rung.
 */
export const FIELD_CREDITS = 5168;

/**
 * What the whole system holds. MEASURED, not projected.
 *
 * This used to be `FIELD_CREDITS * LANDABLE.length` - ten landable bodies at one
 * Cinder apiece - and it said out loud that it was a projection because nine of
 * the ten descriptors were being written as it was read. They have landed, so it
 * is a sum now: the ten fields listed above total **101,048 credits**.
 *
 * Keeping the multiply would now be actively wrong in BOTH directions at once.
 * `FIELD_CREDITS` is the POOREST field, so `poorest * 10` under-counts the
 * system by half (51,680 against 101,048) - and it would keep tracking the
 * poorest planet rather than the whole, so authoring one lean world would appear
 * to shrink the system. Two different questions were being answered with one
 * number: "what is a rung worth" (the poorest field) and "how much is out there"
 * (the sum). They are separate constants now.
 *
 * Written down rather than imported for the same reason `FIELD_CREDITS` is:
 * `PLANETS` drags `PlanetWorld` and therefore `three` behind it, and this
 * module's import graph is asserted to be two frozen data modules so the three
 * objectives work signed out and offline. `space-objectives.test.mjs` sums the
 * real descriptors and fails if this has drifted.
 */
export const SYSTEM_ORE_CREDITS = 101048;

/**
 * THE HAUL LADDER, IN CREDITS OF ORE CUT - AND IT IS PACED BY TWO RULERS.
 *
 * The bottom of it is paced by the HOLD: a node takes `round(size * 1.6)` cubic
 * metres, a stock Kestrel holds 10 and a Dray 40, and ore pays nothing until it
 * is sold at the yard. So an early haul target is really a number of ROUND
 * TRIPS, and the first two rungs are spaced on measured loads.
 *
 * The TOP of it is paced by the FIELDS. It used to be paced by one field,
 * because there was one - the old top rung asked for 9,000 of Cinder's 9,927,
 * and Phase 2 turned that into "top out the career without leaving the first
 * planet you land on". A ladder whose last rung is inside a single destination
 * is a ladder that stops being a ladder the moment a second destination exists.
 *
 * -- The four rungs, and which ruler each one is on -------------------------
 *
 *   500 cr    HOLD. The two numbers this line used to quote disprove the
 *             sentence it made of them: it read "more than one Kestrel load
 *             from either easy pad (114, 497)", and 500 against 114 is FOUR
 *             AND A HALF loads, not "more than one". Restated against the
 *             table below rather than around it - a Kestrel load is 114 cr off
 *             Ashfall Flat, 497 off Colonnade Deck and 2,839 off Rimhold
 *             Shelf, so this rung is 4.4 trips, 1.1 trips or ONE depending
 *             entirely on which pad you work. That spread is the rung's whole
 *             content: it is the first thing in the game that pays a player
 *             for noticing that the pads are not equal, which is why `hint()`
 *             now names the richer one instead of leaving it to be discovered
 *             over seventeen minutes of Ashfall. Unchanged: the Kestrel still
 *             holds 10 m3.
 *   2,000 cr  HOLD. More than a full Dray load from either easy pad (1,659,
 *             1,931). Unchanged, and it CANNOT move - `ShipMenuLogic.REFIT_SOURCE`
 *             sells this rung to the player by name and by number ("earned at
 *             Corecutter, 2,000 CR of ore cut") and `ship-customizer.test.mjs`
 *             reddens if the copy and the rung part company.
 *   8,775 cr  ONE FIELD, worked out, with margin. `0.90 * FIELD_CREDITS`. This
 *             is the old top rung at its real value: it was 9,000 against a
 *             placed field of 9,927, and it is 8,775 against a descriptor field
 *             of 9,746 - the same claim, re-derived rather than re-typed.
 *  29,250 cr  THREE FIELDS. `3 * FIELD_CREDITS`, and three because that is what
 *             the kill ladder's top rung asks for as well: `KILL_TIERS[3]` is
 *             three full sweeps of the volume, and this is three full fields of
 *             it. It cannot be reached from one planet, which is the whole
 *             point, and at 30% of `SYSTEM_ORE_CREDITS` it can be reached from
 *             any three of the ten.
 *
 * -- Why the bottom two rungs are NOT scaled by the field --------------------
 * Because nothing about them changed. A Kestrel load is a Kestrel load whether
 * there is one planet or ten; scaling "your first hold home" by the number of
 * worlds in the sky would make the first rung of a mining career cost five
 * round trips for no reason anybody could name.
 *
 * -- Why absolute credits, and why 0.90 and 3.00 rather than "the whole field"
 * The field MOVED while this file was first written: another agent extended the
 * descriptor from 110 nodes and 6,080 credits to 119 and 9,927, and re-sized
 * every kind. That is the ordinary case, not an accident, and it is why the
 * rungs are stated in credits with margin rather than as "the whole field": a
 * rung pinned to an exact total becomes UNREACHABLE the moment somebody trims a
 * mineral, which is the "gold nobody can reach" defect with a pickaxe. Stated
 * this way, a richer field or a richer eleventh planet only ever makes the top
 * rung easier - the right way round for a threshold to fail. The rungs are
 * computed off `FIELD_CREDITS` at module load and are plain credits by the time
 * anything reads them, so that property survives the derivation.
 *
 * -- Measured, on foot, over the real height field --------------------------
 * Greedy nearest-node tour from each pad, path length measured by walking the
 * ground in 2 m steps so a climb out of a fissure costs what it costs,
 * converted at the game's own sustained ground speed (8.2 m/s) plus the 0.85 s
 * of `Mining.MINE_TIME` per node:
 *
 *   pad          a Dray load (40 m3)                a Kestrel load (10 m3)
 *   ashfall       1,659 cr, 20 nodes,   748 m, 108 s   114 cr,  4 nodes,  46 s
 *   rimhold       5,635 cr, 29 nodes, 1,933 m, 260 s 2,839 cr,  9 nodes, 108 s
 *   colonnade     1,931 cr, 20 nodes,   458 m,  73 s   497 cr,  5 nodes,  21 s
 *
 * Rimhold Shelf carries more nodes per load because the two rare kinds are 1 m3
 * each - the crater rim is where the value is AND where the volume is cheapest,
 * which is the descriptor's own gradient doing its job.
 *
 * -- The PRIZES are deliberately unchanged ----------------------------------
 * The top rung asks for three times the work it used to and still pays 3,000
 * and four thruster coils. That is not an oversight: what a coil is worth did
 * not move, the rungs were re-spaced against measured content, and re-pricing
 * four prizes on the back of that would be four guessed numbers standing next
 * to one measured one. If the last rung wants to pay more, somebody should
 * measure what it is worth first.
 *
 * `space-objectives.test.mjs` re-derives `FIELD_CREDITS` from every descriptor
 * `PLANETS` holds every run and asserts the margins, so a trim that ate one
 * fails loudly here rather than quietly in a player's save.
 */
export const ORE_TIERS = Object.freeze([
  Object.freeze({ credits: 500, title: 'Prospector', reward: 200, item: 'nav_chart', qty: 1 }),
  Object.freeze({
    credits: 2000,
    title: 'Corecutter',
    reward: 700,
    item: 'thruster_coil',
    qty: 2,
    /* THE HOLD REFIT, AND IT MOVED DOWN A RUNG. `hold` is "25% mineral
     * capacity" per tier in `SHIP_STAT_META`.
     *
     * It used to sit on Seamwright at 5,000, and that was anti-timed: the
     * prize for filling the hold arrived on the trip that emptied the planet
     * of everything worth carrying. Measured off the built field
     * (`.probe/fix/ore.mjs`, which re-derives from `PLANETS.cinder` rather
     * than quoting this file):
     *
     *   hull                best single load, richest first   rungs cleared
     *   Kestrel, 10 m3      2,980 CR over 10 nodes            Prospector, Corecutter
     *   Dray, 40 m3         6,006 CR over 30 nodes            + SEAMWRIGHT (then 5,000)
     *
     * Seamwright has since moved to 8,775 - one whole field rather than one
     * good load - so a single Dray trip no longer clears it either. The reason
     * the hold refit came DOWN a rung stands unchanged, and is now underwritten
     * twice over.
     *
     * and the Dray is free, boardable from turn one, in the next berth. Worse,
     * the whole rare supply - 9 iridite and 12 rheniite - is 5,070 CR in
     * 21 m3, so ONE Dray trip lifts every valuable node on Cinder and leaves
     * 4,676 CR of 6-to-52 CR/m3 bulk behind. More room, granted at the exact
     * moment there is nothing left worth putting in it.
     *
     * At 2,000 the refit lands after about one stock-Kestrel load or a partial
     * Dray one, with both rare tiers still in the ground - which is when a
     * bigger hold is a decision rather than a souvenir. The rungs themselves
     * are unchanged: they were derived from measured loads and they are still
     * the right ladder; it is only the PRIZE that was hung on the wrong rung.
     */
    power: 'hold',
  }),
  Object.freeze({
    /* ONE FIELD, WORKED OUT, WITH A TENTH OF IT AS MARGIN. 8,775 against a
     * descriptor field of 9,746 and a placed one of 9,927.
     *
     * It was 5,000 - "about one maximal rim load" - and that rung has been
     * eaten from below: the best single Dray load off Cinder measures 6,392 CR
     * today, so 5,000 had stopped being a haul and become a trip. Seamwright
     * now means what its name says, a field's seams worked out, and it stays
     * worked out because `Mining` persists which ones are cut. */
    credits: round25(FIELD_CREDITS * 0.90),
    title: 'Seamwright',
    reward: 1600,
    item: 'hull_plate',
    qty: 3,
  }),
  Object.freeze({
    /* THREE FIELDS. Three because `KILL_TIERS[3]` is three full sweeps of the
     * volume and this is the same claim about the other column: you have been
     * everywhere worth going, more than once.
     *
     * RENAMED. It was 'Cinderwright', which named one planet out of ten - the
     * same mistake `hint()` was making one screen away, and the same one the
     * old 9,000 rung made numerically by asking for exactly that planet's ore.
     * A career title that names your first landing site is a title that stops
     * being true the moment the system has a second one. */
    credits: round25(FIELD_CREDITS * 3),
    title: 'Lodewright',
    reward: 3000,
    item: 'thruster_coil',
    qty: 4,
    cosmetic: 'char_ember',
  }),
]);

/**
 * What assaying an element for the first time pays.
 *
 * The set - one of every element a world publishes - is the identity half of
 * this objective, and it is a real journey: from Ashfall Flat the nearest node
 * of each kind is 43 m (sulfur), 49 m (tephra), 180 m (ferro-basalt), 346 m
 * (obsidian), 428 m (iridite) and 479 m (rheniite, both at the bottom of the
 * crater road). One of everything means crossing the planet, which is what the
 * descriptor's own value gradient was built to make you do.
 *
 * Rheniite is the proof that the roster is learned rather than declared: it did
 * not exist when this file was written. Another agent added it to the volcanic
 * descriptor mid-drop, and the assay chart went from five long to six with no
 * edit here - which is the arrangement `_learnElements` exists for.
 *
 * 250 is under what the cheapest RARE node is worth and above what a common one
 * is - deliberately in the same band as the ore itself rather than above it, so
 * the answer to "should I cut this?" is never "no, it is only worth the
 * first-find bonus".
 */
export const ASSAY_CREDITS = 250;

/* ==================================================================== */

/** Which worlds these objectives are live in, for the HUD's sake. */
function isSpaceSide(worldId) {
  if (worldId === 'space' || worldId === 'dock') return true;
  if (BODY_BY_ID[worldId]) return true;
  return String(worldId ?? '').startsWith('planet:');
}

/** Finite non-negative integer, or 0. */
function count(v) {
  const n = Math.floor(Number(v));
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/**
 * Every body's survey radius and payout, computed once at module load.
 * A flat array so the frame sweep reads it without a lookup and allocates
 * nothing - the house rule about frame handlers.
 * @type {Array<{body:object, r2:number, range:number, reward:number}>}
 */
const SURVEY_SPHERES = SPACE_BODIES.map((body) => {
  const r = surveyRange(body.radius);
  return { body, r2: r * r, range: r, reward: surveyReward(body) };
});

export class SpaceObjectives {
  /**
   * @param {{bus?:any, economy?:any, inventory?:any, cosmetics?:any,
   *          ships?:any, piloting?:any, worldManager?:any}} ctx
   */
  constructor({ bus, economy, inventory, cosmetics, ships, piloting, worldManager } = {}) {
    this.bus = bus ?? null;
    this.economy = economy ?? null;
    this.inventory = inventory ?? null;
    this.cosmetics = cosmetics ?? null;
    this.ships = ships ?? null;
    this.piloting = piloting ?? null;
    this.worldManager = worldManager ?? null;

    /** classId -> kills. Identity, so the total is recomputed from it. */
    this._kills = new Map();
    /** Zone ids whose wing has been broken at least once. */
    this._wings = new Set();
    /**
     * zoneId -> name, for every named wing the player has seen a world author.
     * The DISPLAY denominator; the set prize is decided against the live world
     * instead. See {@link SpaceObjectives#wingTotal} for why those are two
     * different questions.
     */
    this._wingRoster = new Map();
    /** Highest kill rung already paid, as a count of rungs. */
    this._killTier = 0;
    /** Paid once when every authored wing has been broken. */
    this._wingSetPaid = false;

    /** bodyId -> 'sighted' | 'landed'. */
    this._survey = new Map();
    this._surveySetPaid = false;
    /** Paid once when every landable body has been set down on. */
    this._landfallSetPaid = false;

    /** elementId -> { n, credits, name }. */
    this._ore = new Map();
    /**
     * elementId -> display name, for every element the player has SEEN a world
     * publish. The denominator of the assay chart, and the reason this file
     * defines no elements of its own - see `_learnElements`.
     */
    this._elements = new Map();
    this._oreTier = 0;

    this._worldId = this.worldManager?.active?.id ?? null;

    this._offs = [];
    if (this.bus) {
      /* Every channel below already existed and already fired. Nothing in
       * `SpaceCombat`, `Mining` or `Piloting` was changed to make this file
       * work, which is the whole point of arriving late to a working loop. */
      this._offs.push(bus.on('combat:kill', (p) => this._onKill(p)));
      this._offs.push(bus.on('combat:cleared', (p) => this._onZoneCleared(p)));
      this._offs.push(bus.on('mining:node', (p) => this._onOre(p)));
      this._offs.push(bus.on('pilot:entry', (p) => this._onEntry(p)));
      this._offs.push(bus.on('pilot:landed', () => this._onSetDown()));
      this._offs.push(bus.on('world:changed', ({ id, world }) => this._onWorld(id, world)));
    }
    this._learnElements(this.worldManager?.active ?? null);
    this._learnWings(this.worldManager?.active ?? null);
  }

  /* ------------------------------------------------------------------ */
  /* Read surface                                                        */
  /* ------------------------------------------------------------------ */

  /** Total hostiles destroyed, recomputed from the per-class ledger. */
  get killCount() {
    let n = 0;
    for (const v of this._kills.values()) n += v;
    return n;
  }

  /** Bounty those kills were worth, recomputed the same way. */
  get killBounty() {
    let n = 0;
    for (const [id, c] of this._kills) n += (ALIEN_CLASSES[id]?.bounty ?? 0) * c;
    return n;
  }

  /** Named wings broken at least once. */
  get wingCount() {
    return this._wings.size;
  }

  /**
   * How many named wings there are to break.
   *
   * READ OFF THE REMEMBERED ROSTER, NOT THE LIVE WORLD, and the split is
   * deliberate enough to be worth writing down because it looks like a bug.
   *
   * The first version read `worldManager.active.encounters` directly, which is
   * correct in space and is `undefined` everywhere else - so the HUD row went
   * from "Wings 2/3" to nothing the instant the player set down on Cinder, and
   * came back when they launched. A career ledger that forgets what it is
   * counting when you land is a career ledger that looks broken.
   *
   * So the DISPLAY denominator is the roster the player has seen (learned by
   * `_learnWings`, persisted, exactly as the element chart is), while the PRIZE
   * is decided by `_liveWings()` against whatever the live world actually
   * authors. Remembering is safe for a count on a panel; it would not be safe
   * for a set prize, because a zone removed from `SpaceWorld` would leave a
   * ghost in the roster and make the set uncompletable for ever.
   */
  get wingTotal() {
    return this._wingRoster.size;
  }

  /**
   * The wings the LIVE world authors, and how many of them are already broken.
   * The authority for the set prize - see {@link wingTotal}.
   * @returns {{total:number, broken:number}}
   */
  _liveWings() {
    const list = this.worldManager?.active?.encounters;
    if (!Array.isArray(list) || list.length === 0) return { total: 0, broken: 0 };
    let broken = 0;
    for (const z of list) if (this._wings.has(z?.id)) broken++;
    return { total: list.length, broken };
  }

  /** Bodies reached. */
  get surveyCount() {
    return this._survey.size;
  }

  /**
   * Bodies there are to reach - ALL of them, scenery included, on purpose.
   *
   * Reaching is a fly-by: you go close enough that the thing fills half the
   * screen and you have looked at it. Erenmark and Ceraunus have no ground and
   * you can still do that to them, so they belong in this denominator. The
   * denominator they do NOT belong in is the landfall one, which is why that
   * has its own - see {@link landfallTotal}.
   */
  get surveyTotal() {
    return SPACE_BODIES.length;
  }

  /** Bodies set down on. */
  get landfallCount() {
    let n = 0;
    for (const v of this._survey.values()) if (v === 'landed') n++;
    return n;
  }

  /**
   * Bodies there are to set down on.
   *
   * This column had a numerator and no denominator at all, so the HUD could say
   * "4 landed" for ever and never "4 of 10" - a count with nothing to finish,
   * which is the one thing a progress row is for. It is `landableBodies()` and
   * not `SPACE_BODIES.length` because a set that includes the star is a set
   * nobody completes, and a set nobody completes is the reachability defect
   * with a nav marker on it.
   */
  get landfallTotal() {
    return LANDABLE.length;
  }

  /**
   * The nearest landable body that has not been set down on, or null.
   *
   * Measured from the SHIP when there is one under the player and its position
   * is finite, and from the yard otherwise - which is the honest answer on a
   * planet or a deck, where "nearest" can only mean nearest to home. The
   * finiteness check is not decoration: a non-finite position would make every
   * comparison false, the answer silently null and the hint silently wrong,
   * and this world has already lost a day to a NaN travelling somewhere it was
   * not checked for.
   *
   * The world the player is standing on is skipped. A save restored straight
   * onto a surface has not fired `pilot:entry`, so without this the sentence
   * under the counters would tell somebody standing on Cinder to go to Cinder.
   */
  nextLandfall() {
    const p = this.piloting;
    const sp = p?.active ? p.flight?.position : null;
    let ox = DOCK_ANCHOR.position[0];
    let oy = DOCK_ANCHOR.position[1];
    let oz = DOCK_ANCHOR.position[2];
    if (sp && Number.isFinite(sp.x) && Number.isFinite(sp.y) && Number.isFinite(sp.z)) {
      ox = sp.x; oy = sp.y; oz = sp.z;
    }
    let best = null;
    let bestD = Infinity;
    for (let i = 0; i < LANDABLE.length; i++) {
      const b = LANDABLE[i];
      if (this._survey.get(b.id) === 'landed') continue;
      if (b.id === this._worldId || b.surfaceWorld === this._worldId) continue;
      const dx = ox - b.position[0];
      const dy = oy - b.position[1];
      const dz = oz - b.position[2];
      const d = dx * dx + dy * dy + dz * dz;
      if (d < bestD) { bestD = d; best = b; }
    }
    return best;
  }

  /** Elements assayed at least once. */
  get assayCount() {
    return this._ore.size;
  }

  /** Elements known to exist, learned from the worlds visited. */
  get assayTotal() {
    return this._elements.size;
  }

  /** Credits of ore cut, ever. */
  get oreCredits() {
    let n = 0;
    for (const v of this._ore.values()) n += v.credits;
    return n;
  }

  /** Nodes cut, ever. */
  get oreNodes() {
    let n = 0;
    for (const v of this._ore.values()) n += v.n;
    return n;
  }

  /** The highest title earned across both ladders, or null. */
  get rank() {
    const k = this._killTier > 0 ? KILL_TIERS[this._killTier - 1] : null;
    const o = this._oreTier > 0 ? ORE_TIERS[this._oreTier - 1] : null;
    if (k && o) return this._killTier >= this._oreTier ? k.title : o.title;
    return k?.title ?? o?.title ?? null;
  }

  /** True in the worlds these objectives can progress in. */
  get live() {
    return isSpaceSide(this._worldId);
  }

  /** Has this body been reached? @param {string} id */
  reached(id) {
    return this._survey.has(id);
  }

  /**
   * Everything the HUD draws, as one plain object.
   *
   * A fresh object per call, and that is safe because this is read on a
   * `*:changed` event and never per frame - exactly the arrangement
   * `Viewpoints._announce` has with the same panel.
   */
  progress() {
    return {
      live: this.live,
      rank: this.rank,
      kills: this.killCount,
      killNext: KILL_TIERS[this._killTier]?.kills ?? null,
      killTitle: KILL_TIERS[this._killTier]?.title ?? null,
      bounty: this.killBounty,
      wings: this.wingCount,
      wingTotal: this.wingTotal,
      surveyed: this.surveyCount,
      surveyTotal: this.surveyTotal,
      landfalls: this.landfallCount,
      /* Published so the HUD can draw a landfall row with a denominator in it.
       * `HUD._setObjectives` does not read it yet - that file is owned by
       * another drop - and publishing it is the half of the fix this file can
       * make on its own: a number nothing consumes is cheap, and a HUD that
       * cannot ask is a HUD that has to guess. */
      landfallTotal: this.landfallTotal,
      assayed: this.assayCount,
      assayTotal: this.assayTotal,
      ore: this.oreCredits,
      oreNext: ORE_TIERS[this._oreTier]?.credits ?? null,
      oreTitle: ORE_TIERS[this._oreTier]?.title ?? null,
      nodes: this.oreNodes,
      plot: this.plot(),
      hint: this.hint(),
    };
  }

  /**
   * ONE SENTENCE SAYING WHAT TO DO NEXT.
   *
   * The panel arrived reading `Kills 0/3`, `Survey 0/5`, `Ore 0/500 CR` and
   * nothing else, and a tester who played the whole loop cold wrote: "Nothing
   * on arriving in the yard says what to do. No objective text, no waypoint,
   * no 'your ship is on Pier One'." Three counters are a scoreboard, not a
   * brief - and two of the three cannot be started without first finding a
   * blast door at the far end of a 162 m hall.
   *
   * Keyed on WHERE THE PLAYER IS, because that is what makes the sentence
   * actionable: the same ledger state means "go and find the door" in the
   * yard and "hold E at a seam" on a planet. Derived, never authored - every
   * branch reads the same ledger the rows are drawn from, so a sentence can
   * never disagree with the counters above it.
   *
   * Returns null once every ladder is finished, so the line disappears rather
   * than becoming furniture the eye stops reading.
   *
   * @returns {string|null}
   */
  hint() {
    if (!this.live) return null;
    const world = this.worldManager?.active?.id ?? null;

    if (world === 'dock') {
      if (this.oreCredits > 0 || this.killCount > 0) {
        return 'Your hold was sold the moment you docked. Back out through the bay mouth, then F to board.';
      }
      return 'Your hull is berthed outside, on Pier One. Down the keel line and out through the bay mouth at the far end, then F to board.';
    }

    if (world === 'space') {
      if (this.surveyCount === 0) {
        return 'Pick a body off the navigation list, top right, and fly at it. W throttles, X brakes.';
      }
      /* NAMES ONE PLACE, AND IT IS THE PLACE YOU ARE NEAREST TO.
       *
       * This line used to read "Cinder is the one body you can land on", which
       * was true of Phase 1 and is now false of nine tenths of the sky. The
       * repair is not to list the ten - a sentence with ten proper nouns in it
       * is a table, and a player reading a table has not been told what to do.
       * It is to answer the question the counter above it raises: there are ten
       * and you have four, so which one is next? The nearest one you have not
       * been to, measured from where the ship actually is. */
      const next = this.nextLandfall();
      if (next) {
        return this.landfallCount === 0
          ? `${next.name} is the nearest world you can land on. Fly in until the readout says APPROACH, then descend.`
          : `${next.name} is the nearest world you have not set down on - ${this.landfallCount}/${this.landfallTotal} so far.`;
      }
      return 'Fly home to Lodestar Yard when the hold is full - ore pays nothing until it is sold.';
    }

    // A surface. Ten of them now, and the sentence is about mining, not a planet.
    if (this.assayCount === 0) {
      const richer = this.richerPad();
      return 'Walk to a seam and HOLD E to cut it. Every element pays a bonus the first time.'
        + (richer ? ` ${richer.name} carries the richer seams.` : '');
    }
    /* Where to go AFTER the hold is full, which is the only part of a mining
     * brief that changes once there is more than one field to work. */
    const after = this.nextLandfall();
    if (after) {
      return `Hold E at a seam. When the hold is full, lift off, sell at the yard, then try ${after.name}.`;
    }
    return 'Hold E at a seam. When the hold is full, lift off and fly back to the yard to sell.';
  }


  /**
   * THE PAD ON THIS WORLD WORTH FLYING TO INSTEAD, or null when you are on it.
   *
   * ═══════════════════════════════════════════════════════════════════════
   *  SEVENTEEN MINUTES VERSUS FOUR
   * ═══════════════════════════════════════════════════════════════════════
   *
   * Every atmospheric entry lands at the world's `primary` pad, and on Cinder
   * that is Ashfall Flat, which is the POOREST of its three. Measured, per
   * 10 m3 Kestrel load:
   *
   *     ashfall (primary)   114 cr    5 trips to clear the 500 cr rung
   *     colonnade           497 cr    2 trips
   *     rimhold           2,839 cr    1 trip
   *
   * (Those are WALKED loads, from a greedy nearest-node tour. The ranking
   * below is computed from a best-value load instead - 481 / 1,059 / 4,154 -
   * which orders the three pads the same way and needs no walk.)
   *
   * At the flown 45 s out and 90 s back that is about seventeen minutes from
   * Ashfall against four and a half from the rim - for the same objective, on
   * the same planet, decided entirely by a choice the game never mentioned.
   * Ashfall reaches only the two cheapest ores per cubic metre, so the hold
   * fills on bulk and the pad is not a bad pad, it is a THIN one.
   *
   * The fix is one sentence rather than a rebalance: nothing here moves
   * `ORE_TIERS`, the field, the hold or which pad `primary` is. A player who
   * is TOLD that another pad carries the richer seams can fly there; one who
   * is not spends the seventeen minutes finding out.
   *
   * ── IT IS DERIVED, AND THE RIM TEST IS NOT DECORATION ────────────────────
   *
   * Nothing about Cinder is typed here. Every mineral node is assigned to its
   * nearest pad and the credits are summed, which is the same "which pad is
   * this seam for" question a player answers by looking - so an eleventh
   * planet, or a re-cut mineral table, gets a correct sentence with nobody
   * coming back.
   *
   * And a pad is only a candidate if you can get back ONTO it. Seven of the
   * ten worlds have a pad you can walk off and never climb back to, and they
   * are exactly the exotic-seam pads - the rich ones. Sending a new player to
   * one of those would be swapping a slow objective for a stranding, which is
   * a worse trade than the one being fixed. `PlanetWorld` publishes each pad's
   * rim exposure as `drop.deg` for exactly this kind of question, and
   * {@link PAD_RIM_LIMIT} is the line: Rimhold Shelf reads 270 degrees of
   * horizon falling away and is therefore never named, however rich it is.
   *
   * @returns {{id:string,name:string,credits:number}|null}
   */
  richerPad() {
    const w = this.worldManager?.active ?? null;
    const sites = w?.landingSites;
    const nodes = w?.mineralNodes;
    if (!Array.isArray(sites) || sites.length < 2) return null;
    if (!Array.isArray(nodes) || nodes.length === 0) return null;

    /* ── THE UNIT IS A HOLD, NOT A FIELD ──────────────────────────────────
     *
     * Summing the credits lying near each pad is the obvious metric and it is
     * the wrong one, because the thing that limits a trip is VOLUME. Driven on
     * Cinder, the field totals rank rimhold 6,057 / colonnade 2,277 / ashfall
     * 1,593 - a 1.43x spread, and Colonnade would have failed the margin below
     * and this sentence would never have fired at all. What a player
     * experiences is what ONE LOAD is worth: on the same three pads a
     * best-value 10 m3 load is 4,154 / 1,059 / 481, an 8.6x spread, because
     * the rich pads carry ores worth more per cubic metre rather than simply
     * more of them.
     *
     * So each pad is valued at the best load its own nearest seams can fill:
     * sort by credits per m3, take until the hold is full. */
    const hold = Math.max(1, Number(this.piloting?.cargoCapacity) || 10);
    const byPad = new Map();
    for (const n of nodes) {
      let best = null;
      let bestD = Infinity;
      for (const s of sites) {
        const d = n.position.distanceToSquared(s.position);
        if (d < bestD) { bestD = d; best = s; }
      }
      if (!best) continue;
      let list = byPad.get(best.id);
      if (!list) { list = []; byPad.set(best.id, list); }
      list.push(n);
    }
    const worth = new Map();
    for (const [id, list] of byPad) {
      list.sort((a, b) => (b.credits / Math.max(1e-6, b.size)) - (a.credits / Math.max(1e-6, a.size)));
      let room = hold;
      let paid = 0;
      for (const n of list) {
        const v = Number(n.size) || 0;
        if (v > room) continue;
        room -= v;
        paid += Number(n.credits) || 0;
        if (room <= 1e-6) break;
      }
      worth.set(id, paid);
    }

    let pick = null;
    let pickWorth = 0;
    for (const s of sites) {
      /* A pad with no published rim is a pad from a world that predates the
       * measurement, and the safe reading of "unknown" is "allowed" - the
       * alternative is a hint that silently stops existing. */
      if ((s.drop?.deg ?? 0) > PAD_RIM_LIMIT) continue;
      const v = worth.get(s.id) ?? 0;
      if (v > pickWorth) { pickWorth = v; pick = s; }
    }
    if (!pick) return null;

    /* Standing on it already, or it is not worth the flight. The margin is a
     * HALF again rather than any margin at all: two pads within a few percent
     * of each other are the same decision, and a sentence that sent a player
     * across a planet for 4% would be worse than silence. */
    const here = this.piloting?.landedSite?.id ?? null;
    if (pick.id === here) return null;
    const mine = here ? (worth.get(here) ?? 0) : 0;
    if (mine > 0 && pickWorth < mine * 1.5) return null;
    return { id: pick.id, name: pick.name, credits: pickWorth };
  }

  /**
   * THE MAP SURFACE, and the reason it is a strip of tags rather than markers.
   *
   * The brief asks for the bodies to be revealed on whatever map surface
   * exists, and out here there is not one that will take them. `Minimap` is a
   * world-XZ floorplan drawn from a baked canvas - correct for a citadel 240 m
   * across, meaningless for a volume 800 km across - and the nav list in
   * `FlightHUD` is a live range readout owned by another file and only visible
   * from a seat.
   *
   * So this is the plot: every body in publication order, with a three-letter
   * tag and its state, which the HUD draws as one line under the Survey count.
   * Twelve glyphs is the whole system at a glance and it fills in as you go,
   * which is what "revealed on a map" means when the map is the sky.
   *
   * Fresh objects each call. That is safe and deliberate: this is read on a
   * `*:changed` event and never on a frame, the same arrangement
   * `Viewpoints.anchors` has, and a reused array handed to a listener is a
   * footgun for the sake of five allocations per kill.
   */
  plot() {
    return SURVEY_SPHERES.map(({ body }) => ({
      id: body.id,
      name: body.name,
      /* Three letters, upper case. Enough to tell Cinder from Ceraunus and
       * Sirocco from Sallow, short enough that twelve of them fit on one line
       * of a corner panel - which is what set the length back when there were
       * five, and is the reason it still holds at twelve. */
      tag: body.name.slice(0, 3).toUpperCase(),
      landable: body.handoff > 0,
      state: this._survey.get(body.id) ?? null,
    }));
  }

  /**
   * The long form of {@link plot}: every body, the range it plots at, what it
   * pays, where it is and what it is. A menu read, never a frame read.
   *
   * `plot` is what the HUD draws; this is what a nav readout would want if one
   * ever wants it - `position` and `surveyRange` are exactly the two numbers a
   * marker needs, and `reward` is the one a player would want next to it.
   */
  chart() {
    return SURVEY_SPHERES.map(({ body, range, reward }) => ({
      id: body.id,
      name: body.name,
      kind: body.kind,
      blurb: body.blurb,
      position: body.position,
      surveyRange: range,
      reward,
      landable: body.handoff > 0,
      state: this._survey.get(body.id) ?? null,
    }));
  }

  /* ------------------------------------------------------------------ */
  /* Frame - the survey sweep                                            */
  /* ------------------------------------------------------------------ */

  /**
   * Detect arrival at a body. Twelve squared-distance tests against a flat
   * array, no allocation, and it returns on the second line in every world
   * that is not space.
   *
   * Gated on being in the SEAT rather than merely in the space world: there is
   * no floor out there, so the only way to be 40 km from the yard on foot is a
   * bug, and a survey credited to one would be a reward for a bug.
   *
   * @param {number} _dt
   */
  update(_dt) {
    if (this._worldId !== 'space') return;
    const p = this.piloting;
    if (!p?.active) return;
    const pos = p.flight?.position;
    if (!pos) return;
    const x = pos.x;
    const y = pos.y;
    const z = pos.z;
    /* A non-finite ship position would make every squared distance NaN, every
     * comparison false, and the sweep silently dead. It is also the shape of
     * bug that blacked out this world's frame once already, so it is checked
     * rather than assumed. */
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) return;

    for (let i = 0; i < SURVEY_SPHERES.length; i++) {
      const s = SURVEY_SPHERES[i];
      const b = s.body;
      const dx = x - b.position[0];
      const dy = y - b.position[1];
      const dz = z - b.position[2];
      /* `_sight` owns the already-done test and it is the ONLY copy. A second
       * guard here would read as belt and braces and is really a test that
       * cannot fail: with two, deleting either leaves the behaviour correct, so
       * neither can ever be proved load-bearing. `Viewpoints.update` records
       * the same rule for the same loop. */
      if (dx * dx + dy * dy + dz * dz <= s.r2) this._sight(b, s.reward);
    }
  }

  /* ------------------------------------------------------------------ */
  /* Kills                                                               */
  /* ------------------------------------------------------------------ */

  /** @param {{classId?:string, name?:string}} p from `combat:kill` */
  _onKill(p) {
    const id = typeof p?.classId === 'string' ? p.classId : null;
    if (!id) return;
    this._kills.set(id, (this._kills.get(id) ?? 0) + 1);
    this._checkKillTier();
    this._announce();
  }

  /**
   * A named wing broken.
   *
   * `combat:cleared` publishes `bounty` as the SESSION total rather than the
   * zone's, so the prize is derived from the zone's own published composition
   * instead - see {@link wingBounty}. Reading the payload's number would have
   * paid a first clear the whole session's earnings back, and the bug would
   * have grown with the session rather than showing up on the first clear.
   *
   * @param {{zone?:string, name?:string}} p
   */
  _onZoneCleared(p) {
    const id = typeof p?.zone === 'string' ? p.zone : null;
    if (!id || this._wings.has(id)) return;
    const zone = this.worldManager?.active?.encounters?.find((z) => z.id === id) ?? null;
    if (!zone) return;
    this._wings.add(id);
    const prize = wingBounty(zone);
    if (prize > 0) this.economy?.add?.(prize, 'objective:wing');
    this.bus?.emit?.('objective:wing', {
      id,
      name: zone.name ?? p?.name ?? id,
      credits: prize,
      broken: this._wings.size,
      total: this.wingTotal,
    });
    this.bus?.emit?.('hud:notify', {
      text: `${zone.name ?? id} broken - +${prize} CR (${this._wings.size}/${this.wingTotal})`,
      tone: 'good',
    });
    this._checkWingSet();
    this._announce();
  }

  /**
   * Every wing the LIVE world authors, broken: a shields refit, once.
   *
   * Against `_liveWings()` and not against the remembered roster. A roster only
   * ever grows, so a zone deleted from `SpaceWorld` would leave a ghost in it
   * and the set could never be completed again by anybody who had seen the old
   * build - the same ghost `deserialize` refuses to let into the survey plot,
   * and the same defect this project keeps shipping in other costumes.
   */
  _checkWingSet() {
    const live = this._liveWings();
    if (this._wingSetPaid || live.total <= 0 || live.broken < live.total) return;
    const total = live.total;
    this._wingSetPaid = true;
    this._refit(WING_SET_POWER);
    this.bus?.emit?.('objective:wingSet', { total, power: WING_SET_POWER });
    this.bus?.emit?.('hud:notify', {
      text: 'Every wing in the volume broken - yard shields refit',
      tone: 'good',
    });
  }

  _checkKillTier() {
    const kills = this.killCount;
    while (this._killTier < KILL_TIERS.length && kills >= KILL_TIERS[this._killTier].kills) {
      const tier = KILL_TIERS[this._killTier];
      this._killTier++;
      this._payTier(tier, tier.credits, 'objective:kills',
        `${tier.title} - ${tier.kills} hostiles destroyed`);
    }
  }

  /* ------------------------------------------------------------------ */
  /* Survey                                                              */
  /* ------------------------------------------------------------------ */

  /**
   * First arrival at a body.
   * @param {object} body a `SpaceBody`
   * @param {number} reward credits, precomputed from its distance
   */
  _sight(body, reward) {
    if (this._survey.has(body.id)) return;
    this._survey.set(body.id, 'sighted');
    this.economy?.add?.(reward, 'objective:survey');
    this.bus?.emit?.('objective:survey', {
      id: body.id,
      name: body.name,
      kind: body.kind,
      blurb: body.blurb,
      credits: reward,
      surveyed: this._survey.size,
      total: this.surveyTotal,
      landable: body.handoff > 0,
    });
    this.bus?.emit?.('hud:notify', {
      text: `${body.name} surveyed - +${reward} CR (${this._survey.size}/${this.surveyTotal})`,
      tone: 'good',
    });
    this._checkSurveySet();
    this._announce();
  }

  /**
   * The seam fired and a surface world is taking the ship. `pilot:entry` is
   * the only event that carries the body id, because after it the world has
   * changed and the sky is gone.
   * @param {{body?:string}} p
   */
  _onEntry(p) {
    const b = BODY_BY_ID[p?.body];
    if (b) this._landfall(b);
  }

  /**
   * Wheels down. `pilot:landed` carries no body, so the body is resolved from
   * the world that is live - which is sound, because you can only set down on a
   * body whose surface world you are already inside.
   */
  _onSetDown() {
    const wid = this._worldId;
    if (!wid) return;
    for (const b of SPACE_BODIES) {
      if (b.surfaceWorld === wid || b.id === wid) {
        this._landfall(b);
        return;
      }
    }
  }

  /** @param {object} body */
  _landfall(body) {
    /* A descent that somehow skipped the survey sphere still counts as having
     * reached the place - you are standing on it. Reachable in practice by a
     * load that restores a player already on a surface, which is exactly what
     * "quit mid-trip" produces. */
    if (!this._survey.has(body.id)) {
      const s = SURVEY_SPHERES.find((e) => e.body === body);
      this._sight(body, s?.reward ?? round25(SURVEY_CR_PER_SECOND * LEG_FIXED_S));
    }
    if (this._survey.get(body.id) === 'landed') return;
    this._survey.set(body.id, 'landed');
    /* Derived from the body, not from a constant - see `landfallReward`, which
     * owns the whole of the "what if the geometry is unreadable" question and
     * is the ONLY copy of that guard. A second `|| LANDFALL_CREDITS` here would
     * read as belt and braces and would really be a branch that cannot be
     * reached, so deleting either would leave the behaviour correct and neither
     * could ever be proved load-bearing. Same rule `update` records. */
    const reward = landfallReward(body);
    this.economy?.add?.(reward, 'objective:landfall');
    this.bus?.emit?.('objective:landfall', {
      id: body.id,
      name: body.name,
      credits: reward,
      landfalls: this.landfallCount,
      total: this.landfallTotal,
    });
    this.bus?.emit?.('hud:notify', {
      text: `Landfall on ${body.name} - +${reward} CR (${this.landfallCount}/${this.landfallTotal})`,
      tone: 'good',
    });
    this._checkLandfallSet();
    this._announce();
  }

  _checkSurveySet() {
    if (this._surveySetPaid || this._survey.size < this.surveyTotal) return;
    this._surveySetPaid = true;
    const got = this.cosmetics?.unlock?.(SURVEY_SET_COSMETIC) === true;
    this._refit('power');
    this.bus?.emit?.('objective:surveySet', {
      total: this.surveyTotal,
      cosmetic: SURVEY_SET_COSMETIC,
      power: 'power',
    });
    this.bus?.emit?.('hud:notify', {
      text: got
        ? 'Every body in the volume surveyed - Aurora Racer unlocked, yard thrust refit'
        : 'Every body in the volume surveyed - yard thrust refit',
      tone: 'good',
    });
  }

  /**
   * Wheels down on every landable body: a skin and a hold refit, once.
   *
   * Checked against `LANDABLE`, which is resolved from `landableBodies()` at
   * module load and therefore from the live layout - so a body promoted from
   * scenery to a destination (which is exactly what Phase 2 did to Vitrine and
   * Tessera) enlarges the set, and one demoted shrinks it. The wing set's
   * ghost-in-the-roster problem does not arise here for that reason: this
   * denominator is never learned and never remembered, it is read.
   */
  _checkLandfallSet() {
    const total = this.landfallTotal;
    if (this._landfallSetPaid || total <= 0 || this.landfallCount < total) return;
    this._landfallSetPaid = true;
    const got = this.cosmetics?.unlock?.(LANDFALL_SET_COSMETIC) === true;
    this._refit(LANDFALL_SET_POWER);
    this.bus?.emit?.('objective:landfallSet', {
      total,
      cosmetic: LANDFALL_SET_COSMETIC,
      power: LANDFALL_SET_POWER,
    });
    this.bus?.emit?.('hud:notify', {
      text: got
        ? `Every world in the system landed on - Jade Sovereign unlocked, yard hold refit (${total}/${total})`
        : `Every world in the system landed on - yard hold refit (${total}/${total})`,
      tone: 'good',
    });
  }

  /* ------------------------------------------------------------------ */
  /* Ore                                                                 */
  /* ------------------------------------------------------------------ */

  /**
   * A seam worked. `Mining` emits this AFTER `piloting.stow` said yes, so a
   * refused pickup - a full hold - never reaches here and never counts. That
   * ordering is the reason this listens to `mining:node` rather than watching
   * the prompt or the input.
   * @param {{type?:string, name?:string, credits?:number}} p
   */
  _onOre(p) {
    const type = typeof p?.type === 'string' ? p.type : null;
    if (!type) return;
    const credits = Math.max(0, Math.round(Number(p.credits) || 0));
    const name = typeof p.name === 'string' && p.name ? p.name : type;
    let row = this._ore.get(type);
    const first = !row;
    if (!row) {
      row = { n: 0, credits: 0, name };
      this._ore.set(type, row);
    }
    row.n++;
    row.credits += credits;
    /* A world can pay out an element the roster has not learned - a node cut
     * on the same frame a world finished building, or a save restored straight
     * onto a surface. Learning it here as well keeps the chart from ever
     * reading 3/2. */
    if (!this._elements.has(type)) this._elements.set(type, name);

    if (first) {
      this.economy?.add?.(ASSAY_CREDITS, 'objective:assay');
      this.bus?.emit?.('objective:assay', {
        type,
        name,
        credits: ASSAY_CREDITS,
        assayed: this._ore.size,
        total: this.assayTotal,
      });
      this.bus?.emit?.('hud:notify', {
        text: `${name} assayed - +${ASSAY_CREDITS} CR (${this._ore.size}/${this.assayTotal})`,
        tone: 'good',
      });
    }
    this._checkOreTier();
    this._announce();
  }

  _checkOreTier() {
    const cr = this.oreCredits;
    while (this._oreTier < ORE_TIERS.length && cr >= ORE_TIERS[this._oreTier].credits) {
      const tier = ORE_TIERS[this._oreTier];
      this._oreTier++;
      this._payTier(tier, tier.reward, 'objective:ore',
        `${tier.title} - ${tier.credits} CR of ore cut`);
    }
  }

  /* ------------------------------------------------------------------ */
  /* World                                                               */
  /* ------------------------------------------------------------------ */

  _onWorld(id, world) {
    this._worldId = id ?? null;
    this._learnElements(world);
    this._learnWings(world);
    /* A wing set that was already complete but never paid - the same reachable
     * case `Viewpoints._onWorld` handles: a save written before this prize
     * existed, or one written in a build whose zone list was shorter. */
    this._checkWingSet();
    this._announce();
  }

  /**
   * Learn the roster of elements from whatever the live world publishes.
   *
   * -- Why the denominator is learned and not declared ------------------------
   * The brief for this drop is explicit: *"Consume the mineral system another
   * agent is extending concurrently; do not define the elements yourself, count
   * and reward them."* So the assay chart's total is not a constant in this
   * file and not a copy of `Volcanic.js`'s list - it is the set of types the
   * player has watched a world publish. Land on Cinder and the chart becomes
   * five long because Cinder has five kinds of rock in it; a mineral added to
   * that descriptor makes it six the next time you land, with no edit here.
   *
   * It also reads correctly before you have been anywhere: 0/0, which is the
   * truth. You do not know what is down there until you go and look.
   */
  _learnElements(world) {
    const nodes = world?.mineralNodes;
    if (!Array.isArray(nodes)) return;
    for (let i = 0; i < nodes.length; i++) {
      const n = nodes[i];
      const t = typeof n?.type === 'string' ? n.type : null;
      if (t && !this._elements.has(t)) {
        this._elements.set(t, typeof n.name === 'string' && n.name ? n.name : t);
      }
    }
  }

  /**
   * Learn the roster of named wings from whatever the live world authors.
   *
   * The same arrangement as `_learnElements` and for the same reason: this file
   * holds no copy of `SpaceWorld._fillEncounters`, so a zone added there turns
   * up here the next time the player is in space, and the HUD row keeps saying
   * `2/3` while they are standing on a planet instead of collapsing to nothing.
   *
   * Only ever grows. That is safe for a display count and it is NOT safe for
   * the prize, which is why `_checkWingSet` asks `_liveWings()` instead.
   */
  _learnWings(world) {
    const list = world?.encounters;
    if (!Array.isArray(list)) return;
    for (let i = 0; i < list.length; i++) {
      const z = list[i];
      const id = typeof z?.id === 'string' ? z.id : null;
      if (id && !this._wingRoster.has(id)) {
        this._wingRoster.set(id, typeof z.name === 'string' && z.name ? z.name : id);
      }
    }
  }

  /* ------------------------------------------------------------------ */
  /* Prizes                                                              */
  /* ------------------------------------------------------------------ */

  /**
   * Pay one rung of a ladder: credits always, an item when the rung names one,
   * a hull refit when it names a stat, a cosmetic when it names one.
   *
   * `Inventory.acquire` ignores an unknown id, `Cosmetics.unlock` refuses one it
   * does not know and `ShipRegistry.grantPower` drops a stat a hull does not
   * sell - so this file holds no copy of any of the three catalogues, and a
   * catalogue edit can never turn a prize into a crash.
   */
  _payTier(tier, credits, channel, line) {
    if (credits > 0) this.economy?.add?.(credits, channel);
    if (tier.item) this.inventory?.acquire?.(tier.item, tier.qty ?? 1);
    if (tier.power) this._refit(tier.power);
    const got = tier.cosmetic ? this.cosmetics?.unlock?.(tier.cosmetic) === true : false;
    this.bus?.emit?.(channel, {
      title: tier.title,
      credits,
      item: tier.item ?? null,
      qty: tier.qty ?? 0,
      power: tier.power ?? null,
      cosmetic: got ? tier.cosmetic : null,
    });
    this.bus?.emit?.('hud:notify', { text: `${line} - +${credits} CR`, tone: 'good' });
  }

  /**
   * A yard refit: one tier of a stat, on every hull the yard sells.
   *
   * Every hull sells all four stats (`SHIP_STATS`), so this is not a lottery,
   * and `grantPower` only ever RAISES a tier - it takes a `Math.max` - so a
   * refit can never undo a purchase.
   *
   * Applied to all three rather than to the hull in the seat because these
   * prizes are paid for a career and not for a sortie: two of the rungs that
   * carry one are reachable while standing on a planet with the ship parked,
   * and a prize that landed on whichever hull happened to be selected would be
   * a prize the player could miss by walking.
   */
  _refit(stat) {
    const reg = this.ships;
    if (!reg?.grantPower) return;
    for (const id of ['kestrel', 'dray', 'pike']) {
      const cur = reg.getPowers?.(id)?.[stat] ?? 0;
      reg.grantPower(id, stat, cur + 1);
    }
  }

  _announce() {
    this.bus?.emit?.('objectives:changed', this.progress());
  }

  /* ------------------------------------------------------------------ */
  /* Persistence                                                         */
  /* ------------------------------------------------------------------ */

  /**
   * Plain JSON, and identity everywhere identity matters.
   *
   * There is deliberately no `total`, no `bounty` and no `nodes` field: every
   * one of those is recomputed from the maps by the getters above, so a save
   * cannot carry a summary that disagrees with its own detail. The only bare
   * numbers written are the two ladder receipts and the two set receipts.
   */
  serialize() {
    const kills = {};
    for (const [id, n] of this._kills) if (n > 0) kills[id] = n;
    const survey = {};
    for (const [id, state] of this._survey) survey[id] = state;
    const ore = {};
    for (const [type, row] of this._ore) {
      ore[type] = { n: row.n, credits: row.credits, name: row.name };
    }
    const elements = {};
    for (const [type, name] of this._elements) elements[type] = name;
    const wingRoster = {};
    for (const [id, name] of this._wingRoster) wingRoster[id] = name;
    return {
      kills,
      wings: [...this._wings],
      wingRoster,
      killTier: this._killTier,
      wingSet: this._wingSetPaid,
      survey,
      surveySet: this._surveySetPaid,
      landfallSet: this._landfallSetPaid,
      ore,
      elements,
      oreTier: this._oreTier,
    };
  }

  /**
   * Restore. Never pays: the prizes were paid the first time, and a load that
   * re-granted them would be a credit press with a shield refit attached.
   *
   * REPLACE, not merge - the rule `MountManager`, `Relics` and `Viewpoints` all
   * record. A merging restore means a load can never take progress AWAY: kill
   * twenty-seven hostiles, then load a save written before any of them, and the
   * ladder still says Sablebane, the HUD still shows 27, and the receipt still
   * says paid. The player keeps progress the save they loaded does not contain.
   *
   * The two ladder receipts are cleared with the ledgers and for the same
   * reason: if the save says nine kills then in that save the 18-kill rung was
   * never paid, so it must be payable again. `_checkKillTier` is idempotent for
   * the CURRENT state, not across states a load replaced - which is exactly
   * what `Viewpoints.deserialize` says about `_setPaid`.
   *
   * `elements` is restored too. Without it a player who has landed on Cinder,
   * quit from the yard and come back reads `3/0` on the assay chart, because
   * the roster is learned from worlds visited and no world with minerals in it
   * is live. It is a record of what you have SEEN, so it belongs in the save
   * with everything else you have seen.
   *
   * @param {any} data
   * @returns {boolean} true when a well-formed payload was applied
   */
  deserialize(data) {
    if (!data || typeof data !== 'object' || Array.isArray(data)) return false;
    this._kills.clear();
    this._wings.clear();
    this._wingRoster.clear();
    this._survey.clear();
    this._ore.clear();
    this._elements.clear();
    this._killTier = 0;
    this._oreTier = 0;
    this._wingSetPaid = false;
    this._surveySetPaid = false;
    this._landfallSetPaid = false;

    const kills = data.kills;
    if (kills && typeof kills === 'object' && !Array.isArray(kills)) {
      for (const id of Object.keys(kills)) {
        const n = count(kills[id]);
        if (n > 0) this._kills.set(id, n);
      }
    }
    if (Array.isArray(data.wings)) {
      for (const id of data.wings) if (typeof id === 'string' && id) this._wings.add(id);
    }
    const roster = data.wingRoster;
    if (roster && typeof roster === 'object' && !Array.isArray(roster)) {
      for (const id of Object.keys(roster)) {
        const name = roster[id];
        if (typeof name === 'string' && name) this._wingRoster.set(id, name);
      }
    }
    /* A wing broken is a wing seen, so the roster is at least as big as the
     * broken set. Reachable with a save written before the roster existed. */
    for (const id of this._wings) if (!this._wingRoster.has(id)) this._wingRoster.set(id, id);
    const survey = data.survey;
    if (survey && typeof survey === 'object' && !Array.isArray(survey)) {
      for (const id of Object.keys(survey)) {
        /* Only ids that are still bodies. A save from a build with a sixth
         * planet must not leave a ghost in the count - `surveyCount` is read
         * against `SPACE_BODIES.length`, and a ghost would either make the set
         * uncompletable or complete it without the trip. */
        if (!BODY_BY_ID[id]) continue;
        this._survey.set(id, survey[id] === 'landed' ? 'landed' : 'sighted');
      }
    }
    const ore = data.ore;
    if (ore && typeof ore === 'object' && !Array.isArray(ore)) {
      for (const type of Object.keys(ore)) {
        const row = ore[type];
        if (!row || typeof row !== 'object') continue;
        const n = count(row.n);
        if (n <= 0) continue;
        const name = typeof row.name === 'string' && row.name ? row.name : type;
        this._ore.set(type, { n, credits: count(row.credits), name });
        if (!this._elements.has(type)) this._elements.set(type, name);
      }
    }
    const elements = data.elements;
    if (elements && typeof elements === 'object' && !Array.isArray(elements)) {
      for (const type of Object.keys(elements)) {
        const name = elements[type];
        if (typeof name === 'string' && name) this._elements.set(type, name);
      }
    }
    /* Receipts are CLAMPED to the ledger they belong to rather than trusted.
     * A payload claiming `killTier: 4` with two kills in it would silence the
     * whole ladder for ever; clamping means the worst a bad receipt can do is
     * cost the player one payout, and the thing it is clamped against is the
     * identity map, which cannot be faked into agreement with itself. */
    this._killTier = Math.min(count(data.killTier), this._earnedKillTier());
    this._oreTier = Math.min(count(data.oreTier), this._earnedOreTier());

    /* A world can already be live when a load lands - `SaveGame.load` only
     * rebuilds when the payload names a different one - so the roster is
     * re-learned from it here as well as on `world:changed`. */
    this._learnElements(this.worldManager?.active ?? null);
    this._learnWings(this.worldManager?.active ?? null);

    /* THE TWO SET RECEIPTS, CLAMPED - and clamped AFTER the roster is learned,
     * which is the half that was not obvious.
     *
     * `_wingSetPaid` was `data.wingSet === true && this._wings.size > 0`, which
     * is not a clamp at all - it is a presence check. A payload carrying
     * `{wings: ['ashlane'], wingRoster: {three wings}, wingSet: true}`
     * restored it as PAID with one of three broken, and `_checkWingSet`
     * returns early on that flag for ever, so the completed-set prize died
     * silently. Its survey twin one line below was already correct, which is
     * how the asymmetry was found.
     *
     * The ordering matters because `wingTotal` is LEARNED (`_wingRoster.size`)
     * rather than declared. Clamped before the learn, a save with no roster in
     * it compares against a total of zero and every receipt passes - so the
     * clamp has to stand downstream of the thing it clamps against. Belt and
     * braces on `wingTotal > 0`: no wings known means no set to have completed,
     * whatever the receipt says. */
    this._wingSetPaid = data.wingSet === true
      && this.wingTotal > 0 && this._wings.size >= this.wingTotal;
    this._surveySetPaid = data.surveySet === true
      && this.surveyTotal > 0 && this._survey.size >= this.surveyTotal;
    /* And its landfall twin, clamped against the LANDED grades rather than
     * against the plot: a save with twelve sightings and no landings in it must
     * not restore the landfall set as paid, or the ten descents it is the prize
     * for become unpayable for the rest of that save. */
    this._landfallSetPaid = data.landfallSet === true
      && this.landfallTotal > 0 && this.landfallCount >= this.landfallTotal;

    this._announce();
    return true;
  }

  /** Rungs the kill ledger actually justifies. */
  _earnedKillTier() {
    const k = this.killCount;
    let n = 0;
    for (const t of KILL_TIERS) if (k >= t.kills) n++;
    return n;
  }

  /** Rungs the ore ledger actually justifies. */
  _earnedOreTier() {
    const cr = this.oreCredits;
    let n = 0;
    for (const t of ORE_TIERS) if (cr >= t.credits) n++;
    return n;
  }

  dispose() {
    for (const off of this._offs) off?.();
    this._offs.length = 0;
    this._kills.clear();
    this._wings.clear();
    this._wingRoster.clear();
    this._survey.clear();
    this._ore.clear();
    this._elements.clear();
  }
}

export default SpaceObjectives;
