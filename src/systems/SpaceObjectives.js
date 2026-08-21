import { SPACE_BODIES, BODY_BY_ID, DOCK_ANCHOR } from '../worlds/space/Bodies.js';
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
 * 4 cr/s puts a survey sweep of all five bodies at 2,525 credits, which sits
 * between what the five citadel viewpoints pay (750) and what the thirty
 * citadel relics pay (3,600) - the right band for five destinations.
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
 * The landfall leg: survey radius down to wheels on a pad, flown.
 *
 * 26.2 s from the 28.0 km survey sphere to the atmosphere seam, then 16.3 s of
 * pad approach and touchdown at Ashfall Flat. 42.5 s total, so the landfall
 * bonus is 4 * 42.5 = 170, rounded to 175.
 *
 * It is a bonus and not a second grade of the survey because of what the player
 * actually said - "reach planets" - and because Cinder is the only body with a
 * `handoff` this phase: making the survey itself conditional on landing would
 * leave four of the five bodies permanently at half credit for a reason that is
 * about the build schedule rather than about the flying.
 */
export const LANDFALL_S = 42.5;

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

/** What setting down on a landable body pays, once, on top of the survey. */
export const LANDFALL_CREDITS = round25(SURVEY_CR_PER_SECOND * LANDFALL_S);

/** The whole set of bodies: a flight suit credits cannot buy. */
export const SURVEY_SET_COSMETIC = 'char_aurora';

/* ==================================================================== */
/* 2. KILLS - the ladder, and the named wings                            */
/* ==================================================================== */

/**
 * THE KILL LADDER, IN SWEEPS.
 *
 * `SpaceWorld._fillEncounters` authors exactly three zones and they hold nine
 * hostiles between them - two skiffs on the Ashlane, two skiffs and a lance
 * over Cinder, three skiffs and a lance in the Reach. **Nine kills is one full
 * sweep of the system**, and that is a fact about the content rather than a
 * number somebody liked, so it is the rung the ladder is built on.
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
 *   kill  #9 at  148 s  (2.5 min)   every authored zone cleared once
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

/** All three wings broken: a shields refit, paid once. */
export const WING_SET_POWER = 'shield';

/* ==================================================================== */
/* 3. ORE - the assay chart and the haul                                 */
/* ==================================================================== */

/**
 * THE HAUL LADDER, IN CREDITS OF ORE CUT - AND IT IS PACED BY THE HOLD.
 *
 * Measured against the one mineral field that exists. Cinder places **119 nodes
 * worth 9,927 credits** in six kinds: 34 tephra, 26 sulfur, 20 obsidian, 18
 * ferro-basalt, 12 rheniite and 9 iridite. What sets the pace is not the credits
 * but the HOLD: a node takes `round(size * 1.6)` cubic metres, a stock Kestrel
 * holds 10 and a Dray 40, and ore pays nothing until it is sold at the yard. So
 * a haul target is really a number of ROUND TRIPS, and the rungs are spaced on
 * loads rather than on round numbers.
 *
 * -- Flown, on foot, over the real height field -----------------------------
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
 * which is the descriptor's own gradient doing its job. So the rungs:
 *
 *   500 cr    more than one Kestrel load from either easy pad (114, 497) and
 *             one from the crater rim. You fly home and come back, or you land
 *             somewhere harder.
 *   2,000 cr  more than a full Dray load from either easy pad (1,659, 1,931).
 *   5,000 cr  about one maximal rim load (5,635), or three loads off the flats.
 *   9,000 cr  90.7% of the field. Cinder mined out - and it stays mined out,
 *             because `Mining` persists which seams are worked.
 *
 * -- Why absolute credits, and why 90.7% and not 100% ----------------------
 * The field MOVED while this file was being written: another agent extended the
 * descriptor from 110 nodes and 6,080 credits to 119 and 9,927, and re-sized
 * every kind. That is the ordinary case, not an accident, and it is why the top
 * rung is stated in credits with 927 of margin rather than as "the whole field":
 * a rung pinned to the exact total becomes UNREACHABLE the moment somebody
 * trims a mineral, which is the "gold nobody can reach" defect with a pickaxe.
 * Stated this way, a richer field or a second planet only ever makes the top
 * rung easier - the right way round for a threshold to fail.
 *
 * `space-objectives.test.mjs` re-derives the field total from `PlanetWorld`
 * every run and asserts the margin, so a trim that ate it fails loudly here
 * rather than quietly in a player's save.
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
     *   Dray, 40 m3         6,006 CR over 30 nodes            + SEAMWRIGHT
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
    credits: 5000,
    title: 'Seamwright',
    reward: 1600,
    item: 'hull_plate',
    qty: 3,
  }),
  Object.freeze({
    credits: 9000,
    title: 'Cinderwright',
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

  /** Bodies there are to reach. */
  get surveyTotal() {
    return SPACE_BODIES.length;
  }

  /** Bodies set down on. */
  get landfallCount() {
    let n = 0;
    for (const v of this._survey.values()) if (v === 'landed') n++;
    return n;
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
        return 'Sell your hold at a yard counter, then out through the blast door again.';
      }
      return 'Your hull is berthed outside. Through the blast door at the far end, then F to board.';
    }

    if (world === 'space') {
      if (this.surveyCount === 0) {
        return 'Pick a body off the navigation list, top right, and fly at it. W throttles, X brakes.';
      }
      if (this.landfallCount === 0) {
        return 'Cinder is the one body you can land on. Fly in until the readout says APPROACH, then descend.';
      }
      return 'Fly home to Lodestar Yard when the hold is full - ore pays nothing until it is sold.';
    }

    // A surface. Only Cinder today, but the sentence is about mining, not Cinder.
    if (this.assayCount === 0) return 'Walk to a seam and HOLD E to cut it. Every element pays a bonus the first time.';
    return 'Hold E at a seam. When the hold is full, lift off and fly back to the yard to sell.';
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
   * Five glyphs is the whole system at a glance and it fills in as you go,
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
      /* Three letters, upper case. Enough to tell Cinder from Ceraunus, short
       * enough that five of them fit on one line of a corner panel. */
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
   * Detect arrival at a body. Five squared-distance tests against a flat
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
    this.economy?.add?.(LANDFALL_CREDITS, 'objective:landfall');
    this.bus?.emit?.('objective:landfall', {
      id: body.id,
      name: body.name,
      credits: LANDFALL_CREDITS,
      landfalls: this.landfallCount,
    });
    this.bus?.emit?.('hud:notify', {
      text: `Landfall on ${body.name} - +${LANDFALL_CREDITS} CR`,
      tone: 'good',
    });
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
