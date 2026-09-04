import * as THREE from 'three';
import { World } from './World.js';
import { makeRules } from './WorldRules.js';
import {
  MAZE, DIR, generateTopology, cellCoords, carveEntranceCorridor,
  cellIndex, isOpen, connectorAt, parentField, buildDistrictGraph, districtIndex, solve,
} from './maze/MazeTopology.js';
import {
  cellToWorld, forecourtColliders, FORECOURT_PORTAL_Z,
} from './maze/MazeColliders.js';
import { tunnelOrientation } from './maze/MazeShafts.js';
import { puzzleCells } from './maze/MazePuzzles.js';
import { TOKENS_PER_DISTRICT, MAX_LIVE_WANDERERS } from './maze/MazePopulate.js';
import { MazePopulation } from './maze/MazePopulation.js';
import { MazeChunks, buildBoxInstances } from './maze/MazeChunks.js';
import { groupByExtentClass } from './maze/MazeMeshes.js';
import { buildMazeMaterials, buildMazeMaterialsAsync, applyAuthoredSurfaces } from './maze/MazeMaterials.js';
/* Authored assets (Task 8). Loaded on world BUILD, never at module scope - a
 * world nobody enters must cost nothing - and cached for the session inside
 * the module, like the materials. See MazeAssets.js. */
import { loadMazeAssets } from './maze/MazeAssets.js';
import { MazeCanopy } from './maze/MazeCanopy.js';
import { AbandonHold } from './maze/MazeAbandon.js';

/**
 * Yaw that faces down each passage direction, matching `Player.fixedUpdate`'s
 * convention (`fwdX = -sin(yaw), fwdZ = -cos(yaw)`; yaw 0 is -Z, yaw PI is +Z).
 */
const DIR_YAW = Object.freeze({
  [DIR.N]: 0,
  [DIR.S]: Math.PI,
  [DIR.E]: -Math.PI / 2,
  [DIR.W]: Math.PI / 2,
});

/** The keeper explains the maze, the map and the abandon control - chat-only. */
const KEEPER_PERSONA = 'Keeper of the Verdant Coil, posted at the forecourt arch since '
  + 'before anyone currently lost inside can remember. She never enters the maze herself - '
  + 'her post is the threshold, not the corridors - and she explains the same three things to '
  + 'every arrival without ever tiring of it: the hedges never repeat, the M key draws the '
  + 'level you are standing in but never marks where you are on it, and holding L for two '
  + 'seconds walks you home from anywhere, no matter how deep. She says all of this gently, '
  + 'like someone who has watched a great many confident people walk in and a great many '
  + 'humbled ones walk back out.';

/**
 * The written cast of lost wanderers.
 *
 * The list is no longer the population COUNT - it is the identity pool. Since
 * population streams, how many wanderers exist at once is a property of the
 * resident district set, and which of these people a given district holds is
 * `districtCastIndex(key, seed)`: fixed for the run, so walking away from
 * someone and back does not turn them into somebody else. Adding a character
 * here widens the cast without changing the density.
 */
export const WANDERER_CAST = Object.freeze([
  {
    name: 'Corvin Ashe',
    persona: 'A retired cartographer who wandered in to map "just the entrance districts" '
      + 'and lost count of the days somewhere past the ninth journal. He is certain the maze '
      + 'has a pattern - he has three competing theories and will contradict all of them '
      + 'before a conversation is over - and he begs anyone he meets to describe the '
      + 'junctions they passed, which he copies onto scraps of hedge-bark with a stub of '
      + 'charcoal. He is delighted rather than afraid; to him this is the great puzzle of his '
      + 'career, and he is simply not yet willing to admit he might die inside it.',
  },
  {
    name: 'Marta Wren',
    persona: 'The gardener who shaped these hedges by hand, decades before the maze grew '
      + 'past anyone\'s ability to tend it and swallowed her along with the rest. She speaks '
      + 'of individual hedges the way other people speak of old friends, apologises under her '
      + 'breath to the ones she has to push past, and still carries a pair of shears she has '
      + 'long since stopped using - there is nothing left here for one woman to prune. She is '
      + 'not lost, not really; she just cannot bring herself to leave something she grew.',
  },
  {
    name: 'Ossian Drell',
    persona: 'A duelist who took a bet he could reach the centre in a day and has spent what '
      + 'he insists is "more like a season, give or take" proving himself wrong. He has gone '
      + 'half-feral - patched clothes, a forager\'s eye for the maze\'s few edible things, a '
      + 'laugh that comes too easily - but keeps the old-fashioned courtesy of a duelist when '
      + 'he talks, addressing strangers with a formality that sits strangely on someone who '
      + 'has clearly not washed in some time. He will not say who he made the bet with.',
  },
  {
    name: 'Pip',
    persona: 'A child who chased an older brother in through the entrance on a dare and has '
      + 'not stopped looking for him since, though the fear wore down long ago into a '
      + 'stubborn, practical routine - check every junction twice, mark the ones already '
      + 'checked, never cry anywhere it might carry. Pip is fiercely proud of a system of '
      + 'hedge-scratches that makes sense to no one else, insists on being called "nearly '
      + 'eleven," and asks everyone the same question first: "Have you seen a boy, taller '
      + 'than you, loud?"',
  },
  {
    name: 'Rue Calder',
    persona: 'A professional finder of things who took the maze on as a job - someone was '
      + 'paying for whatever sits at the centre - and has been unable to collect a fee from '
      + 'an employer she is no longer sure still exists. Years of a hunt with no one left to '
      + 'answer to have flattened her into something careful and unsentimental; she counts '
      + 'her supplies out loud, trusts nothing that looks too easy, and still appraises '
      + 'everyone she meets, out of sheer habit, for what they might be worth to a job that '
      + 'ended a long time ago.',
  },
  {
    name: 'Isolde Farr',
    persona: 'A painter who came in chasing the exact quality of light the hedges let '
      + 'through at certain hours and simply never left - there was always one more corridor '
      + 'with the light falling a particular way. Her satchel is stuffed with sketches of '
      + 'walls that look identical to anyone else and utterly distinct to her; she can tell '
      + 'you which district you are standing in by the colour of the moss alone. She does not '
      + 'think of herself as lost. She thinks of herself as still working.',
  },
  {
    name: 'Bram Otts',
    persona: 'A courier whose last delivery route somehow led here, and who has kept '
      + 'walking on the theory that a route, once started, is meant to be finished. He still '
      + 'carries the satchel, empty now but for one undeliverable letter he will not open and '
      + 'will not explain, and greets everyone with the same professional cheer he used on '
      + 'his old route, address book long since memorised and now entirely useless. He '
      + 'insists, with total sincerity, that he is not lost - merely between deliveries.',
  },
  {
    name: 'Ansel the Still',
    persona: 'A pilgrim who entered believing the maze was a trial meant to be walked rather '
      + 'than solved, and has kept walking the same loop of corridors for longer than he '
      + 'counts, treating every repeated turn as part of the practice rather than a failure '
      + 'to progress. He speaks slowly, answers questions with questions, and has made a kind '
      + 'of peace with the hedges that unsettles people more than any of the others do - he '
      + 'does not want to be found, only accompanied for a while.',
  },
  {
    name: 'Thea Vance',
    persona: 'A surveyor who came in to measure the maze for a map nobody commissioned and has '
      + 'filled eleven notebooks with corridor lengths that never add up the same way twice. She '
      + 'is convinced the error is hers rather than the hedges, and will ask you to pace out a '
      + 'stretch with her to check. Brisk, precise, and quietly terrified of being wrong.',
  },
  {
    name: 'Old Harrow',
    persona: 'The first person to go in after the hedges outgrew their tenders, by his own '
      + 'account, though he cannot say what year that was. He talks about the maze in the past '
      + 'tense even while standing in it, gives directions with total confidence and no accuracy, '
      + 'and is unfailingly kind to anyone newer than him - which is everyone.',
  },
  {
    name: 'Sable',
    persona: 'A thief who came for the credit stack at the centre and has since decided the real '
      + 'prize is being the only person who knows a way out. She trades directions rather than '
      + 'giving them, drives a hard bargain over nothing in particular, and is far more lost than '
      + 'she lets on. She will not admit to having seen the centre.',
  },
  {
    name: 'Fen Marlow',
    persona: 'A botanist who walked in to take a cutting and stayed for the moss. He can date a '
      + 'stretch of hedge by what is growing on its north face and will happily do so at length '
      + 'while you are trying to ask for directions. Genuinely content here, which the others find '
      + 'either reassuring or unbearable.',
  },
  {
    name: 'Juno Pike',
    persona: 'A runner who treats the maze as a course rather than a trap - she is timing herself '
      + 'between junctions she has named, and is annoyed rather than frightened that the route '
      + 'keeps changing. Fast, impatient, out of breath, and the only person in here who seems to '
      + 'be enjoying the exercise.',
  },
  {
    name: 'Callum Reed',
    persona: 'He came in after someone else and will not say who, only that he is close. He asks '
      + 'everyone the same two questions - how long they have been in, and whether the hedges have '
      + 'moved - and writes the answers on his sleeve. Exhausted, courteous, and unwilling to rest '
      + 'for longer than it takes to have the conversation.',
  },
  {
    name: 'Mother Wren',
    persona: 'No relation to Marta, and tired of being asked. She has set herself up as the '
      + 'unofficial keeper of the lost, remembering everyone she has met and where, and '
      + 'reciting the list to newcomers in case a name means something. She has never tried to '
      + 'reach the centre and does not intend to.',
  },
  {
    name: 'Idris Vale',
    persona: 'A cartographers apprentice who lost his master somewhere past the fourth level '
      + 'and has been retracing what he can remember of their route ever since. He is meticulous, '
      + 'young, and increasingly aware that the map they were making described a maze that no '
      + 'longer exists. He would rather talk about anything else.',
  },
  {
    name: 'Bexley',
    persona: 'Claims to have been born in here, which nobody believes and nobody can disprove. '
      + 'Knows the hedges the way other people know a street - which ones flower, which ones hide '
      + 'a gap - but has no concept of the maze having an outside, so their directions are '
      + 'wonderfully detailed and completely useless for leaving.',
  },
  {
    name: 'Tomasz Ferro',
    persona: 'An engineer who has spent his time in here trying to work out how the lifts are '
      + 'counterweighted, on the grounds that whoever built them must have had a way out. He will '
      + 'explain his current theory whether or not you asked, and abandons each one cheerfully the '
      + 'moment it fails. The maze is a machine to him, and machines can be understood.',
  },
  {
    name: 'Silla',
    persona: 'She stopped walking a long time ago and now waits at junctions on the theory that '
      + 'anyone moving will eventually pass her. It has worked often enough to keep her at it. '
      + 'Watchful, dry, and full of small accurate observations about everyone who has come by - '
      + 'she is the closest thing the maze has to a witness.',
  },
  {
    name: 'Dorran Ash',
    persona: 'A soldier who treats being lost as a siege: rations counted, routes logged, morale '
      + 'maintained by routine. He is the most organised person in the maze and the least willing '
      + 'to admit the organisation has not helped. Offers practical advice, all of it sound, none '
      + 'of it sufficient.',
  },
]);

/**
 * How many tokens and wanderers can be alive at once.
 *
 * Both are properties of the RESIDENT SET rather than of the maze: population
 * streams with the districts that carry it (see `MazePopulation`), so these are
 * derived from the residency radius rather than written down. The widest
 * residency is a full 5x5 block on the player's own level plus a 3x3 ring on
 * each of the levels either side - 43 districts - and every one of those is
 * worth up to `TOKENS_PER_DISTRICT` tokens and at most one wanderer.
 *
 * Exported because that bound is the whole point of the design and the leak
 * gate asserts against it: however far the player walks, this is the ceiling.
 */
export const MAX_RESIDENT_DISTRICTS = 5 * 5 + 3 * 3 + 3 * 3;
export const MAX_LIVE_TOKENS = MAX_RESIDENT_DISTRICTS * TOKENS_PER_DISTRICT;
export { TOKENS_PER_DISTRICT, MAX_LIVE_WANDERERS };

/** Pickup radius for a dead-end token - generous, so you don't have to stand exactly on it. */
const TOKEN_PICKUP_R = 1.6;
const TOKEN_PICKUP_R2 = TOKEN_PICKUP_R * TOKEN_PICKUP_R;
/**
 * Credits per token. Single-digit on purpose - the centre stack is worth 100
 * and is the one reward this world should not let anything else overshadow.
 */
const MAZE_TOKEN_VALUE = 6;
/**
 * The centre's reward.
 *
 * 100, FINAL. The spec says so twice and calls it final rather than a
 * placeholder: it is deliberately not scaled by maze size, by level count or
 * by how long the run took. A player who reaches the centre of a 2.4 km maze
 * that re-rolls every entry gets the same 100 as anyone else who did.
 */
export const MAZE_CENTRE_VALUE = 100;
/**
 * How many cells a wanderer's route runs toward the centre.
 *
 * Was 4 - a 24 m random shuffle, which read as someone pacing rather than
 * someone searching. These are people described as having been lost in here
 * for years and still looking, so they now walk the shortest path toward the
 * centre and back: 28 cells is about 170 m, long enough that you meet one
 * going somewhere rather than milling about, and short enough that they stay
 * spread through the maze instead of piling up at the prize.
 */
const PATROL_STEPS = 28;
/** Districts either side of the player. 2 gives the 5x5 block the spec calls for. */
const RESIDENCY_RADIUS = 2;

/**
 * How long `build` waits for the authored KTX2 surfaces before generating the
 * maze without them.
 *
 * Sized against the deadline it exists to stay inside: the HUD abandons a
 * crossing at 45 s (`ui/HUD.js`), and generation itself has measured between
 * 0.7 s warm and 12.6 s cold. Twelve seconds of download leaves the slowest
 * measured generation room to finish and still arrive well inside that, while
 * being long enough that any link which can serve 17.5 MB at all will make it.
 * The load is raced, never cancelled, so a link that misses this budget still
 * warms the cache for the next entry.
 */
const MAZE_ASSET_BUDGET_MS = 12000;

// Scratch objects for the per-frame token instance-matrix update, reused
// every call rather than allocated - see the note on MazeWorld.update.
const _tokPos = new THREE.Vector3();
const _tokQuat = new THREE.Quaternion();
const _tokScale = new THREE.Vector3(1, 1, 1);
const _tokMat = new THREE.Matrix4();
const _tokUp = new THREE.Vector3(0, 1, 0);

/**
 * The Verdant Coil - a hedge maze that re-rolls its layout on every entry.
 *
 * Phase 1 scope, deliberately: one level, every district built up front, and
 * box geometry rather than foliage. Streaming, the other three levels, the art
 * pass, the puzzles and the map are Phases 2-5. Building the whole level
 * up front is knowingly wrong for the finished world and knowingly right for
 * now - it takes streaming out of the equation while the topology, the rules
 * and the containment work are being proven.
 *
 * @see docs/superpowers/specs/2026-08-07-maze-world-design.md
 */
export class MazeWorld extends World {
  static id = 'maze';
  static displayName = 'The Verdant Coil';

  /**
   * Re-generate on every activation rather than serving a cached build.
   * Read by WorldManager. The maze that cannot be learned is the entire point.
   */
  static volatile = true;

  /**
   * Force the next build's seed, or null for the usual fresh random one.
   *
   * Two writers, and they want it for opposite reasons.
   *
   *   - `src/dev/Harness.js`, under `?dev=1` only, because a review instrument
   *     cannot compare two runs of a world that is different every time.
   *   - `adoptDailySeed`, from `/api/game/session`'s `daily_seed`, so that
   *     everyone signed in shares TODAY's labyrinth. See that method.
   *
   * Still null in a signed-out boot, and null in any boot where the session
   * call failed — the maze re-rolls per entry exactly as it always did. See
   * `build()`.
   *
   * @type {number|null}
   */
  static seedOverride = null;

  /**
   * Take today's shared seed from a `/api/game/session` payload.
   *
   * ── What this makes true, and what it very deliberately does not ────────
   *
   * Every signed-in player in the same server walks the SAME labyrinth today,
   * because both clients derive nothing — they are handed one number the
   * server computed from the server id and the UTC date (`dailySeed` in
   * `site/lib/customServers.ts`). Tomorrow it is a different maze, so the
   * unlearnability this world is built on survives at the granularity that
   * matters.
   *
   * It does NOT make the maze a shared SPACE. Two members in today's maze are
   * in two private copies of one layout; neither can see the other, neither
   * moves anything the other will find, and nothing in this game delivers
   * presence. The word for what they share is the floor plan.
   *
   * ── Why it is a method here rather than three lines in main.js ──────────
   *
   * Validation. The value arrives from an HTTP body, and `seedOverride` is
   * consumed by `generateTopology` with no further checking: a string, a float
   * or a NaN out of a half-deployed endpoint would produce a maze that differs
   * between two clients that both believe they are sharing one — the exact
   * failure the feature exists to remove, wearing a disguise. Anything that is
   * not a whole number inside the range `build()` rolls for itself is refused,
   * and refusing leaves the fresh-random behaviour in place rather than
   * substituting a guess.
   *
   * @param {any} account the parsed `/api/game/session` body, or null
   * @returns {boolean} true when a shared seed was adopted
   */
  static adoptDailySeed(account) {
    const raw = account?.daily_seed;
    if (typeof raw !== 'number' || !Number.isInteger(raw)) return false;
    // The range `build()` generates for itself: an unsigned 32-bit integer.
    if (raw < 0 || raw > 0xffffffff) return false;
    MazeWorld.seedOverride = raw;
    return true;
  }

  /**
   * How many pollen motes ride with the player.
   *
   * One draw call regardless, so the number is chosen for how it looks rather
   * than for cost: 900 in a 26 m box is thin enough to read as motes in the
   * air and not as fog, which is the failure mode at anything denser in
   * corridors this narrow.
   */
  static POLLEN_COUNT = 900;
  static POLLEN_BOX = 26;
  /** Above hedge height, so motes read against the sky on the top level. */
  static POLLEN_HEIGHT = 7.5;

  constructor(ctx) {
    super(ctx);

    this.rules = makeRules({
      weapons: false, mounts: false, climb: false, parkour: false,
      merchants: false, quests: false, contracts: false, caches: false,
      relics: false, loot: false, races: false, interiors: false,
      hostiles: false, swim: false,
      // The keeper and the eight wanderers are the whole cast - see
      // WANDERER_CAST above. The maze's atmosphere is being alone; a
      // manager-added crowd would drown that out.
      crowd: false,
      // jump stays permitted: the geometry makes the hop useless, not the input.
    });

    /** Current run's seed. Re-rolled on every build. */
    this.seed = 0;
    /** @type {Uint8Array|null} */
    this.cells = null;
    this.entranceCell = 0;
    this.centreCell = 0;

    /* Materials are created once and reused across every re-roll. Allocating
     * fresh ones per entry would re-trigger the shader compilation that already
     * dominates cold boot in this project - see the prewarm notes in main.js. */
    this._materials = null;

    /**
     * The tokens that exist RIGHT NOW - one entry per uncollected token in a
     * resident district. Owned by `this.population`; this is the same array
     * object, held here because the pickup loop reads it every frame and
     * because the map and the gates have always asked the world for it.
     * @type {Array<{position: THREE.Vector3, taken: boolean, phase: number,
     *               slot: number, cell: number}>}
     */
    this._tokens = [];
    this._tokenTime = 0;
    /** @type {MazeChunks|null} the district streaming manager, created in build() */
    this.chunks = null;
    /** @type {import('./maze/MazePopulation.js').MazePopulation|null} */
    this.population = null;
    /** @type {MazeCanopy|null} distant hedge-tops beyond the streamed set, created in build() */
    this.canopy = null;
    /* Hold-L to leave from anywhere. Pure timing - see MazeAbandon.js. */
    this._abandon = new AbandonHold();
    this._abandonShown = 0;

    /* Every shaft's world position, grouped by level - computed once per
     * build (see `_computeShaftsByLevel`), not per frame. `Minimap` is
     * world-agnostic: it just plots whatever `world.shaftMarkers` hands it
     * (see the `caches`/`portals` markers it already draws the same way), so
     * the level-filtering happens here, in `update()`, where the maze already
     * knows which level the player is standing on. This is the discoverability
     * fix: the nearest shaft measured up to 1,212m of actual walking with
     * nothing on the minimap to point at it. */
    /** @type {Array<Array<{x:number, z:number}>>|null} */
    this._shaftsByLevel = null;
    /** @type {Array<{x:number, z:number}>} the current level's shafts - what Minimap reads */
    this.shaftMarkers = [];
    this._connectorsByLevel = null;
    this._solution = null;
    this._solutionFrom = -1;
    this._markersLevel = -1;

    const span = MAZE.CELLS * MAZE.CELL;
    this.bounds = new THREE.Box3(
      new THREE.Vector3(-MAZE.CELL, -10, -MAZE.CELL),
      new THREE.Vector3(span, MAZE.LEVEL_HEIGHT * MAZE.LEVELS + 20, span),
    );

    this.environment.background = new THREE.Color(0x9fb8c8);
    this.environment.fogColor = new THREE.Color(0xa8c0ce);
    this.environment.fogNear = 20;
    this.environment.fogFar = 160;
    this.environment.ambientColor = new THREE.Color(0x6f7f68);
    /* 1.25 -> 0.12, AND THE ROOFED LEVELS CAME OUT BRIGHTER, NOT DARKER.
     *
     * The 1.25 was the paint roller the probe below was added to replace: a
     * constant added to every fragment regardless of normal, so a hedge's two
     * faces at a corner sat at the same value and the corner did not read.
     * @see World.js `ambientIntensity` for why that is definitional.
     *
     * BRIGHTNESS-MATCHED A/B, one booted session, same maze seed (3436772362),
     * three uniforms rewritten between shots. Frame mean luma / % of pixels
     * under 12 (the "gone to black" floor):
     *
     *   corridor  (roofed)  base 39.1 / 0.5%   ->  this 39.6 / 0.4%
     *   lift-car  (roofed)  base 39.7 / 1.3%   ->  this 41.2 / 1.1%
     *   above-entrance      base 142.2 / 0%    ->  this 142.2 / 0%
     *
     * So the roofed levels this 1.25 existed for are held or improved, and the
     * open top level does not move at all - up there the sun owns the frame
     * and the fill terms are noise. The naive version of this change, dropping
     * ambient and replacing nothing (a=0.15, hemi and env untouched), IS the
     * trap: corridor 31.9 and lift-car crush 3.5%, which is the pitch-black
     * maze. The energy has to go somewhere, and 0.75 of `envMapIntensity` is
     * where it went.
     *
     * What that buys, and it is the whole point: at equal mean luma the
     * overhanging floor slab in `lift-car` now has a lit top edge and a
     * distinctly darker soffit, and the shaft walls carry a vertical gradient
     * toward the sky. At 1.25 both were one flat tan.
     *
     * Zero shader programs: 107 before and after, all four candidates. */
    this.environment.ambientIntensity = 0.12;
    /* 0.45, and stated rather than inherited. The hedge tops want a little
     * more sky than the floor gets, but the maze's real fill is the probe -
     * a hemisphere term only separates up from down, and a corridor is
     * vertical walls. Measured as the weakest of the three redistributions
     * tried (hemi-heavy h=1.10/e=1.00 came back at corridor 38.3, below base). */
    this.environment.hemiIntensity = 0.45;
    /* ── THE HEMISPHERE PAIR, AND THE VIOLET FLOOR IT FIXES ────────────────
     *
     * These two were never stated, so `applyEnvironment` fell back to
     * `skyColor ?? ambientColor` (the olive 0x6f7f68 above) and
     * `groundColor ?? fogColor` (the blue-grey 0xa8c0ce above). Neither was
     * authored as a bounce colour: one is an ambient tint, the other is fog.
     * Every other world that has thought about its bounce states the pair -
     * `CitadelWorld`, `MedievalWorld`, `RaceWorld`, `SpaceWorld` - and this is
     * the maze doing the same, for the same reason the citadel gives: shade
     * over warm ground has to land BROWN, not violet.
     *
     * WHAT WENT WRONG. Moving the ambient into the probe (0.12 / 1.75, above)
     * put the maze's fill into `ENV_MOODS.daylight`, which is a BLUE SKY, and
     * a roofed candle-lit corridor cannot see the sky at all - three has no
     * occlusion on `scene.environment`, so the floor was lit by a sky that is
     * not there. Measured on the shipped frames (seed 110548205, mean B minus
     * mean R over the frame, and over the lower third where the floor is):
     *
     *   corridor  full  base -11.4  ->  Phase 3  -2.2   (+9.2 toward blue)
     *   corridor  low3  base  -7.4  ->  Phase 3  +9.3   (+16.7)
     *   lift-car  full  base  -1.5  ->  Phase 3  +5.6
     *   tower-top full  base -31.4  ->  Phase 3 -23.1
     *
     * Terracotta dirt under an orange ceiling was reading LILAC. The luma
     * instrument that signed off Phase 3 cannot see this: corridor luma moved
     * 39.5 -> 42.0 and crush 0.90% -> 0.44%, both improvements, while the
     * frame turned violet underneath them. A scalar is blind along every axis
     * it does not measure - which is why the numbers below are RGB.
     *
     * WHY THE HUE AND NOT THE INTENSITY. Dropping `envMapIntensity` was tried
     * first and is the wrong knob twice over: at 1.35 the corridor is still
     * blue (low3 +4.9, barely half way back) and the crush the probe bought
     * goes with it - 0.44% -> 0.96%, WORSE than the 0.90% before Phase 3. The
     * probe's blue is in the picture because the probe is bright, and the only
     * cure by subtraction is to give back the legibility. So the probe keeps
     * its 1.75 and the hemisphere carries warmth instead, which is the
     * citadel's answer to the identical failure.
     *
     * WHAT THIS PAIR IS. `skyColor` is what a maze floor sees looking up: a
     * candle-lit ceiling on the roofed levels. `groundColor` is the terracotta
     * bouncing back up into every soffit and hedge underside, where the fog's
     * blue-grey used to sit. Measured, same seed, the three framings the swing
     * was measured on:
     *
     *                    base        Phase 3      THIS
     *   corridor  full   -11.4         -2.2      -11.1   crush 0.90/0.44/0.36%
     *   corridor  low3    -7.4         +9.3       -9.0
     *   lift-car  full    -1.5         +5.6       +1.4   crush 1.30/0.69/0.58%
     *   tower-top full   -31.4        -23.1      -30.0   crush 0.29/0.16/0.13%
     *
     * All three framings are back inside 3 of the pre-Phase-3 hue and every
     * crush figure is at or below the Phase 3 one, so the legibility Phase 3
     * bought is kept in full. The corridor is 9% brighter than Phase 3 (luma
     * 42.0 -> 46.0): a hemisphere can only ADD, and the probe's blue can only
     * be balanced by adding red, never by removing blue. Trimming that back
     * was tried (the same pair at 0.84 of this luminance) and it costs the
     * lift-car framing its margin - +2.6 against a base of -1.5 - for 1.3 of
     * luma, so it was refused.
     *
     * WHAT IS STILL WRONG, and it is not fixable from this file: the maze
     * wants a WARM env mood, not `daylight` dimmed or counterweighted.
     * `ENV_MOODS` offers `space`, `daylight` and `alpine` - two blue skies and
     * a starfield - and a fourth mood costs a fourth PMREM prefilter in
     * `MaterialLibrary.warmup` for every world, on this project's most
     * sensitive path. If one is ever added for another reason, this world
     * should take it and these two lines should be re-measured against it.
     * @see gfx/Materials.js `ENV_MOODS`
     *
     * Zero shader programs: 128 in every one of the seven runs behind the
     * numbers above, candidates included - both
     * hemisphere colours are uniforms and `gfx/LightRig.js` pools the light
     * COUNT, which is the part of the cache key that could have moved. */
    this.environment.skyColor = new THREE.Color(0xffd6a0);
    this.environment.groundColor = new THREE.Color(0xb07a52);
    this.environment.sunColor = new THREE.Color(0xfff2d8);
    this.environment.sunIntensity = 2.2;
    this.environment.sunDirection = new THREE.Vector3(-0.3, 0.9, -0.25).normalize();
    /* ── The reflection probe ──────────────────────────────────────────────
     *
     * This world published no `envMap` at all, and `applyEnvironment` used to
     * skip the assignment when a world published none - so the maze's stone,
     * its candle brass and its water were lit by WHICHEVER WORLD RAN LAST, or
     * by nothing at all on a cold `?world=maze` boot. Neither is a look
     * anybody authored, and which one you got depended on your route. Same
     * one line, and the same reasoning, as `CitadelWorld`, `RaceWorld` and
     * `DockWorld`.
     *
     * `'daylight'`: the top level is open to the sky, the background is an
     * overcast blue-grey and the sun comes almost straight down. `'space'`
     * would put a starfield in the puddles of a daylit hedge maze.
     *
     * The coordinated retune this note asked for has now happened: the 1.25
     * paint roller above is 0.12 and this probe carries the difference at
     * `envMapIntensity` 1.75. The probe had to exist first, and it did.
     * `?? undefined` in the sibling worlds meant "keep whatever was there",
     * which is the bug; `?? null` is "no probe", which is what a headless
     * build with a stub material library should honestly get.
     * @see gfx/Materials.js `getEnvMap` */
    this.environment.envMap = this.materials?.getEnvMap?.('daylight') ?? null;
    /* 1.0 -> 1.75: the 1.13 of flat ambient removed above, arriving as a term
     * that knows which way a surface faces. See `ambientIntensity` for the
     * brightness-matched measurement that fixed the exchange rate. */
    this.environment.envMapIntensity = 1.75;
  }

  /**
   * Reusable material set, built on first use and kept for the session.
   *
   * The ~200 lines that used to live here are `buildMazeMaterials()` in
   * `maze/MazeMaterials.js`, moved verbatim in Phase 6 Task 3 so the program
   * family gate can see them headlessly. `this._materials` stays as the local
   * cache on purpose: the dispose path leaves it alone (materials survive
   * re-rolls - see dispose()), and keeping the field means that contract
   * remains visible in this file rather than only in the module it delegates
   * to. The module caches too, so even a fresh MazeWorld gets the same
   * objects, never an equal set.
   */
  _ensureMaterials() {
    if (!this._materials) this._materials = buildMazeMaterials();
    return this._materials;
  }

  /**
   * The build path's variant of the same contract: identical cached set,
   * but the first call of a session bakes the Task 5 PBR surfaces one per
   * frame (`buildMazeMaterialsAsync`'s yield loop) instead of stalling one
   * frame for all five - the bake measures well past the 250 ms boot budget
   * in one gulp, and cold boot is this project's sensitive path. Sync
   * callers keep `_ensureMaterials`; only `build()`, which is already
   * async for its progress callback, needs this one.
   */
  async _ensureMaterialsAsync() {
    if (!this._materials) this._materials = await buildMazeMaterialsAsync();
    return this._materials;
  }

  /**
   * Every shaft's world (x, z), grouped by the level its climb starts on.
   *
   * A one-off scan of the full 400x400x4 cell grid (640,000 cells, the same
   * order of work `generateTopology` and `districtColliders`'s district-by-
   * district scan already do), run once per build rather than per frame or
   * per district. There is no cheaper way to answer "where are the shafts on
   * this level" that doesn't depend on which districts happen to be streamed
   * in - and the minimap has to answer it regardless of streaming, since the
   * whole point is telling the player about a shaft they have not walked
   * anywhere near yet.
   *
   * @returns {Array<Array<{x:number, z:number}>>} one array per level
   */
  _computeShaftsByLevel() {
    const perLevel = [];
    for (let level = 0; level < MAZE.LEVELS; level++) {
      const list = [];
      for (let z = 0; z < MAZE.CELLS; z++) {
        for (let x = 0; x < MAZE.CELLS; x++) {
          if (isOpen(this.cells, cellIndex(x, z, level), DIR.UP)) {
            const w = cellToWorld(x, z, level);
            list.push({ x: w.x, z: w.z });
          }
        }
      }
      perLevel.push(list);
    }
    return perLevel;
  }

  async build(onProgress) {
    /* A fresh seed per build. `build()` runs on every activation because this
     * world is volatile, so this is what makes the maze unlearnable.
     *
     * ── THE ONE EXCEPTION, AND WHY IT IS HERE ────────────────────────────
     * Unlearnable is right for a player and ruinous for an instrument. Two
     * runs of the SAME COMMIT photograph two different mazes, so a Phase 9
     * before/after of this world compares two unrelated worlds and any delta
     * it reports is the seed. Measured across 64 seeds at the fixed entrance:
     * the resident set holds 2 to 11 shafts and 0 to 3 lifts, and 30 of the 64
     * have no lift at all - which is also why `VIEWS.maze`'s `lift-car` used to
     * abort a whole run.
     *
     * `src/dev/Harness.js` sets it under `?dev=1` and
     * `scripts/world-shot.mjs --seed` passes it in; both RECORD the seed they
     * used, so a run that did not fix one still says which maze it
     * photographed and any seed can be re-flown.
     *
     * ── AND THE SECOND WRITER, WHICH IS A PLAYER-FACING FEATURE ──────────
     * `MazeWorld.adoptDailySeed` sets it from `/api/game/session`'s
     * `daily_seed`, so a signed-in player's maze is today's SHARED maze
     * rather than a private roll. Re-entering during the same session
     * therefore returns the same layout, which is the point: a route worth
     * telling someone about has to still be there when they walk it. A
     * signed-out boot, or one whose session call failed, leaves the override
     * null and re-rolls exactly as before. See `adoptDailySeed`. */
    this.seed = MazeWorld.seedOverride ?? ((Math.random() * 0xffffffff) >>> 0);

    await onProgress?.(0.05, 'Growing the hedges');

    const topo = generateTopology(this.seed, { levels: MAZE.LEVELS });
    this.cells = topo.cells;
    this.entranceCell = topo.entranceCell;
    this.centreCell = topo.centreCell;

    /* Minimap shaft markers - see `shaftMarkers`'s own doc comment. Depends
     * only on `this.cells`, computed once here rather than re-derived every
     * frame or every time the player's level changes. */
    this._shaftsByLevel = this._computeShaftsByLevel();
    /* Dropped so a re-roll rebuilds it - the maze is volatile and last run's
     * connector positions are last run's maze. */
    this._connectorsByLevel = null;
    this._markersLevel = -1;
    this.shaftMarkers = [];
    /* The Ctrl+M route, dropped for the same reason and missed until now.
     *
     * `solutionPath` caches against the player's CELL, which is the right key
     * while one maze is standing: they are usually moving, so a route cached
     * against the seed alone would draw the way out from wherever they first
     * pressed it. What that key cannot survive is a re-roll - and it never
     * could, because `buildDistrictGraph` fixes the entrance at the centre of
     * district (10,0), so the cell a player stands in when they press Ctrl+M on
     * arrival is IDENTICAL on every run. The cache hit was guaranteed and the
     * answer was the PREVIOUS maze's route, drawn over the current one's
     * hedges: a line through solid stone, confidently.
     *
     * Measured before this line existed: four builds, four distinct seeds, one
     * solution - the same 3,714 steps every time. Reset here rather than in
     * `dispose()` because a re-roll IS a build and the sibling caches above
     * already reset here; splitting that rule across two methods is how the
     * next one gets forgotten as well. */
    this._solution = null;
    this._solutionFrom = -1;

    /* `buildDistrictGraph` fixes the entrance at the *centre* of district
     * (10,0) - ten cells inside the grid's own edge, not on it - so nothing
     * connects it to the outside on its own. Carve a straight corridor from
     * the grid's north boundary out to the entrance and breach that boundary
     * wall. This can only open passage bits, never close any, so it cannot
     * disconnect anything that was already reachable - see
     * MazeTopology.carveEntranceCorridor. */
    const e = cellCoords(this.entranceCell);
    carveEntranceCorridor(this.cells, e);

    await onProgress?.(0.25, 'Laying the paths');

    /* Materials and authored assets together: the asset fetch is network
     * I/O, the material bake is CPU, and neither needs the other - so the
     * fetch hides entirely inside the bake on a cold session. Both resolve
     * from session caches on every later entry. `loadMazeAssets` NEVER
     * rejects; a missing or unparseable file just leaves its id out of the
     * map, and every consumer of the map falls back to the procedural
     * prefab (see MazeAssets.js). */
    /* THE AUTHORED SET IS AN UPGRADE, NOT A DEPENDENCY, SO IT GETS A DEADLINE.
     *
     * 17.5 MB of KTX2 sits behind this await, and the world underneath it is
     * fully playable without a byte of it: `applyAuthoredSurfaces` keeps the
     * procedural bake for every surface whose authored set is missing or
     * incomplete, which is the never-a-hole rule this pipeline has carried
     * since it shipped. Blocking the whole generation on it inverted that -
     * on a slow link the download, not the maze, decided whether the player
     * ever arrived, and overrunning the HUD's 45 s crossing deadline meant
     * they did not arrive at all.
     *
     * So the load is raced, not abandoned: it keeps running, and because the
     * pipeline caches into its module-scope closure the NEXT entry resolves
     * from that cache instantly and dresses the maze in the authored surfaces.
     * The cost of a slow first crossing is one procedural-looking maze, not a
     * maze the player cannot reach. */
    const [mats, assets] = await Promise.all([
      /* Optional-chained: headless tests build worlds with no engine, and
       * loadMazeAssets treats an absent renderer as "skip textures". */
      this._ensureMaterialsAsync(),
      Promise.race([
        loadMazeAssets(this.engine?.renderer).catch(() => ({})),
        new Promise((resolve) => setTimeout(() => resolve({}), MAZE_ASSET_BUDGET_MS)),
      ]),
    ]);
    /* Task 9: dress the principal surfaces in whichever authored KTX2 sets
     * actually loaded - per material, everything else keeps its procedural
     * bake, and `?proc=1` pins the whole world procedural for the A/B. The
     * renderer argument above is what lets KTX2Loader pick the compressed
     * format this GPU can sample. */
    applyAuthoredSurfaces(assets);
    const ew = cellToWorld(e.x, e.z, e.level);

    /* Districts stream (see this.chunks below). The forecourt does not: it is
     * hand-authored, sits outside the cell grid in negative z, and is the floor
     * the player arrives on. It needs meshes as well as colliders. */
    const descs = [];
    for (const d of forecourtColliders(ew.x, e.level)) descs.push(d);

    /* Grouped by extent class before drawing, because the forecourt's hedges
     * run in both directions and a prefab now carries its own size - see
     * `groupByExtentClass`. The alternative, scaling one geometry per
     * instance, is precisely what the prefab seam exists to stop doing. */
    const hedges = descs.filter((d) => d.kind === 'hedge');
    const floors = descs.filter((d) => d.kind === 'floor');
    for (const run of groupByExtentClass(hedges)) {
      buildBoxInstances(run.descs, mats.hedge, `maze:forecourt:hedge:${run.cls}`, this.group);
    }
    for (const run of groupByExtentClass(floors)) {
      buildBoxInstances(run.descs, mats.floor, `maze:forecourt:floor:${run.cls}`, this.group);
    }

    for (const d of descs) {
      this.track(this.physics.addBox(d.cx, d.cy, d.cz, d.hx, d.hy, d.hz));
    }

    /* Spawn the player standing in the entrance cell, facing down whichever
     * passage is actually open. `carveEntranceCorridor` only guarantees DIR.N
     * (back out to the forecourt) - the maze proper, at DIR.S/E/W, is
     * whatever the backtracker happened to open, which is not necessarily
     * south. A hardcoded yaw can and did put a hedge 2.4 m in front of a cold
     * spawn with the one open passage behind the player instead. This is the
     * cold-spawn yaw only; portal arrival is computed separately below from
     * `portalSpecs`/`rotationY` and does not read this field. */
    this.playerSpawn.set(ew.x, ew.y + 0.05, ew.z);
    const openHere = this.cells[this.entranceCell];
    const intoMaze = [DIR.S, DIR.E, DIR.W].find((d) => (openHere & d) !== 0);
    this.playerSpawnYaw = DIR_YAW[intoMaze ?? DIR.N];

    /* Districts stream; everything else in this world does not. The forecourt,
     * the centre stack, the tokens and the NPC spawns are authored per build and
     * stay for the whole visit - the forecourt especially, since it is the floor
     * the player arrives on and lives outside the district grid entirely. */
    /* Where the puzzles are, decided once from the seed and the district graph
     * (see `MazePuzzles`) and handed to the chunk builder as a cell lookup. */
    const graph = buildDistrictGraph(this.seed);
    const districtOf = (idx) => {
      const c = cellCoords(idx);
      return districtIndex(Math.floor(c.x / MAZE.DISTRICT), Math.floor(c.z / MAZE.DISTRICT), c.level);
    };
    this.puzzles = puzzleCells(
      this.seed, graph, districtOf(this.entranceCell), districtOf(this.centreCell),
    );

    this.chunks = new MazeChunks({
      world: this,          // NOT this.physics — see the note in MazeChunks
      cells: this.cells,
      group: this.group,
      materials: mats,
      puzzles: this.puzzles,
      assets,
    });

    const spawn = this.playerSpawn;
    this.chunks.updateResidency(spawn.x, spawn.y, spawn.z, RESIDENCY_RADIUS);

    /* Distant hedge-tops beyond the streamed set - see MazeCanopy's own
     * docstring for why this exists at all. Scenery only: constructed with the
     * cached `canopy` material, never given to physics. */
    this.canopy = new MazeCanopy({ group: this.group, material: mats.canopy });
    this.canopy.update(spawn.x, spawn.z, e.level);

    /* The return arch stands in the middle of the forecourt rather than one
     * cell north of the entrance - that position sat inside the hedge the
     * entrance cell's own (closed, before carveEntranceCorridor) north face
     * put there, and the plinth is far too wide to fit in a maze corridor
     * regardless. `rotationY: 0` keeps `WorldManager.arrivalFor`'s arithmetic
     * (arrival = position + 2.6m along (sin(rotY), cos(rotY)), yaw = rotY +
     * PI) landing the player just south of the portal, facing +z into the
     * corridor - confirmed against `Player.forward`, where yaw=PI is +Z. */
    this.portalSpecs = [{
      position: new THREE.Vector3(ew.x, ew.y, FORECOURT_PORTAL_Z),
      rotationY: 0,
      target: 'station',
      label: 'Aether Station',
      accent: 0x8fd67a,
    }];

    this._buildCentreStack(mats.credits);

    await onProgress?.(0.95, 'Waking the hedges');

    /* The keeper, the eight wanderers, and the dead-end tokens - all derived
     * from `this.cells`, never from a fixed coordinate, because the layout
     * above this line is different on literally every call to build(). */
    this._populate(ew, e, mats);
    /* Pollen last. It is the one thing here not derived from `this.cells` and
     * has nothing to be placed against, so it goes into an otherwise
     * finished group. */
    this._buildPollen();

    await onProgress?.(1, 'The Verdant Coil is ready');
  }

  /**
   * Place the keeper, and stand up the streaming population manager.
   *
   * The keeper is the ONLY entry in `npcSpawns` now. That array is read once,
   * by `NPCManager.spawnForWorld`, at world activation - which is the right
   * shape for a character who stands at the threshold for the whole visit and
   * the wrong shape for people scattered across four kilometre-square levels of
   * maze that has not been built yet. The wanderers stream (see
   * `MazePopulation`); the keeper does not.
   *
   * @param {{x:number, y:number, z:number}} ew world-space entrance column
   * @param {{x:number, z:number, level:number}} e entrance cell coords
   * @param {{hedge:THREE.Material, floor:THREE.Material,
   *          credits:THREE.Material, token:THREE.Material}} mats
   */
  _populate(ew, e, mats) {
    this.npcSpawns = [];

    /* The Keeper. Hand-placed like the return arch itself rather than derived
     * from topology - the forecourt is authored geometry (see
     * MazeColliders.forecourtColliders), not carved maze, so there is no
     * hedge for a fixed offset to land inside here the way there would be
     * further in. 6m east of the portal, level with it: clear of the ~4.6m
     * widest reach of the plinth and its approach steps, and well inside the
     * forecourt's 9m half-width to that side. */
    this.npcSpawns.push({
      position: new THREE.Vector3(ew.x + 6, ew.y + 0.1, FORECOURT_PORTAL_Z),
      type: 'friendly',
      name: 'The Keeper of the Coil',
      role: 'lorekeeper',
      persona: KEEPER_PERSONA,
    });

    /* Neither the entrance nor the centre cell should ever be handed back as
     * a wanderer site or a token - the entrance sits right by the keeper and
     * the centre already holds the credit stack. */
    const exclude = new Set([this.entranceCell, this.centreCell]);

    /* ONE breadth-first sweep, rooted at the centre, shared by every wanderer
     * this run ever spawns - see `parentField`. It spans all four levels, so a
     * wanderer anywhere walks toward the real centre; `routeToward` is what
     * stops their route at a level change. Computed here, once per build,
     * rather than per district: a streamed district must be cheap to bring in,
     * and a 640,000-cell BFS is not.
     *
     * `MazePopulation` keeps a reference to it and to `this.cells`, both of
     * which are replaced wholesale on the next re-roll - which is safe because
     * the population manager is replaced with them. */
    const toCentre = parentField(this.cells, this.centreCell);

    /* Population follows residency, exactly as geometry does.
     *
     * The wanderers and the tokens used to be placed globally at build time:
     * `WANDERER_CAST.length` people and 200 tokens spread over 5.7 km2 of maze,
     * of which only a ~240 m neighbourhood is ever built. Measured live at the
     * entrance that came to TWO tokens within 120 m, FOUR within 240 m, and a
     * nearest wanderer 543 m away in a district that did not exist yet. The
     * fix is not more of them - it is putting them where the player is, which
     * is precisely what the district streamer already answers.
     *
     * `this.puzzles` is passed as blocked ground for the same reason the
     * entrance and centre are excluded: a gate or a sliding hedge wall travels
     * through its doorway cell, so nothing may stand or float in one. */
    this.population = new MazePopulation({
      cells: this.cells,
      seed: this.seed,
      group: this.group,
      material: mats.token,
      parents: toCentre,
      cast: WANDERER_CAST,
      exclude,
      blocked: this.puzzles,
      patrolSteps: PATROL_STEPS,
      capacity: MAX_LIVE_TOKENS,
      /* Resolved per call, NEVER captured, and NEVER before this world is the
       * active one.
       *
       * `ctx.npcManager` is set in `main.js` before any world is constructed, so
       * it is present throughout `build()` - which is precisely the problem this
       * gate exists for. `build()` runs against a throwaway physics world, and
       * `WorldManager._activate` then calls `npcManager.clear()` and
       * `spawnForWorld()`, both of which dispose every character that existed
       * before them. A wanderer spawned during the build is therefore grounded
       * against a floor that is about to be discarded and is then destroyed a
       * few lines later - leaving `MazePopulation` holding a dead reference for
       * a district it believes is populated, which it will never refill. That
       * measured live as ZERO wanderers in the maze.
       *
       * `this.active` is set by `World.onActivate`, which runs after both of
       * those wipes, so gating on it makes the header's claim true rather than
       * merely intended: districts made resident during the build carry a spec
       * and no character, and the first `sync` after activation fills them in.
       * `MazePopulation.sync` re-checks ownership as well, so this is the
       * cheaper of two independent defences rather than the only one. */
      npcManager: () => (this.active ? this.ctx?.npcManager ?? null : null),
    });
    this.population.sync(this.chunks.residentKeys());
    this._tokens = this.population.tokens;

  }

  /**
   * Bob/spin the still-uncollected tokens and check the player's distance to
   * each. Cheap by construction: there are ~40 of these regardless of maze
   * size, so this never scales with the grid the way anything keyed off
   * `this.cells` would.
   */
  /**
   * What makes this world's baked floorplan unique - see `planCacheKey`.
   *
   * Seed AND level. The seed because the maze re-rolls on every entry, and a
   * cache keyed on `id` alone serves the previous run's walls; the level
   * because the map draws one level at a time and all four share this id.
   */
  /**
   * The solution path from the player to the centre, in WORLD metres.
   *
   * The Ctrl+M cheat. Computed on demand and cached against the player's own
   * cell, because it is only correct from where they are standing and they are
   * usually moving - a path cached against the seed alone would draw a route
   * from wherever they first pressed it.
   *
   * Returned as one flat list including the level changes, and the map draws
   * only the segments on the level it is showing. That is deliberate rather
   * than filtering here: a route that vanishes at a staircase and reappears on
   * the level above is exactly what the player needs to see.
   *
   * @param {{x:number,y:number,z:number}} from
   * @returns {Array<{x:number,z:number,level:number}>}
   */
  solutionPath(from) {
    if (!this.cells || !from) return [];
    const lv = Math.max(0, Math.min(MAZE.LEVELS - 1, Math.round(from.y / MAZE.LEVEL_HEIGHT)));
    const x = Math.max(0, Math.min(MAZE.CELLS - 1, Math.round(from.x / MAZE.CELL)));
    const z = Math.max(0, Math.min(MAZE.CELLS - 1, Math.round(from.z / MAZE.CELL)));
    const start = cellIndex(x, z, lv);
    if (this._solutionFrom === start && this._solution) return this._solution;

    const cells = solve(this.cells, start, this.centreCell) ?? [];
    this._solutionFrom = start;
    this._solution = cells.map((idx) => {
      const c = cellCoords(idx);
      const w = cellToWorld(c.x, c.z, c.level);
      return { x: w.x, z: w.z, level: c.level };
    });
    return this._solution;
  }

  /**
   * Everything the `M` map plots on one level, in WORLD metres.
   *
   * Computed here rather than in the map because this is where the topology,
   * the portals, the tokens and the centre all already live - and because a
   * map that scanned 160,000 cells itself would have to be handed the same
   * things anyway. Positions only; the map decides how to draw them.
   *
   * Static things (connectors) are cached per level. Live things (tokens that
   * are still there, portals that have opened) are read fresh each call, since
   * both change during a visit.
   *
   * @param {number} level
   */
  mapMarkers(level) {
    if (!this.cells) return { stair: [], lift: [], tunnel: [], token: [], portal: [], centre: [] };

    if (!this._connectorsByLevel) {
      /* One pass over every cell, once per re-roll. `_computeShaftsByLevel`
       * already walks the same grid for the minimap's shaft dots, but it does
       * not record WHICH connector, and the map needs to tell a lift from a
       * staircase. */
      const per = [];
      for (let lv = 0; lv < MAZE.LEVELS; lv++) {
        const acc = { stair: [], lift: [], tunnel: [] };
        for (let z = 0; z < MAZE.CELLS; z++) {
          for (let x = 0; x < MAZE.CELLS; x++) {
            if (!isOpen(this.cells, cellIndex(x, z, lv), DIR.UP)) continue;
            const w = cellToWorld(x, z, lv);
            /* The kind that gets BUILT, not the kind the topology chose. Most
             * tunnel links fall back to a staircase when no fold orientation
             * keeps the maze walkable (see `tunnelOrientation`), so trusting
             * `connectorAt` alone would mark 32 tunnels on a level that builds
             * about five - and a map that calls a staircase a tunnel is worse
             * than one that says nothing. */
            let kind = connectorAt(this.cells, x, z, lv);
            if (kind === 'tunnel' && !tunnelOrientation(this.cells, x, z, lv)) kind = 'stair';
            acc[kind].push({ x: w.x, z: w.z });
          }
        }
        per.push(acc);
      }
      this._connectorsByLevel = per;
    }

    const lv = Math.max(0, Math.min(MAZE.LEVELS - 1, level));
    const conn = this._connectorsByLevel[lv];
    const onLevel = (y) => Math.round(y / MAZE.LEVEL_HEIGHT) === lv;

    const token = [];
    for (const t of this._tokens) {
      if (t.taken || !onLevel(t.position.y)) continue;
      token.push({ x: t.position.x, z: t.position.z });
    }

    const portal = [];
    for (const ps of this.portalSpecs ?? []) {
      if (!onLevel(ps.position.y)) continue;
      portal.push({ x: ps.position.x, z: ps.position.z });
    }

    const centre = [];
    if (!this._centreTaken && this.centrePosition && onLevel(this.centrePosition.y)) {
      centre.push({ x: this.centrePosition.x, z: this.centrePosition.z });
    }

    return { ...conn, token, portal, centre };
  }

  /**
   * Which level the player is standing on. 0-based, and always a real level.
   *
   * `_markersLevel` starts at -1 as a "not computed yet" sentinel, so the first
   * `update` always re-points `shaftMarkers` rather than comparing against a
   * level the player might genuinely be on. That sentinel is INTERNAL: it
   * leaked once, through a map opened in the same frame the world was entered,
   * which drew its header as "LEVEL 0 OF 4". Everything outside this class asks
   * here instead, and gets the player's own position until the first update
   * has run.
   */
  get playerLevel() {
    if (this._markersLevel >= 0) return this._markersLevel;
    const y = this.ctx?.player?.position?.y ?? 0;
    return Math.min(MAZE.LEVELS - 1, Math.max(0, Math.round(y / MAZE.LEVEL_HEIGHT)));
  }

  get minimapPlanKey() {
    return `maze:${this.seed}:${this.playerLevel}`;
  }

  /**
   * Drifting pollen - section 10's other half, after the god-rays.
   *
   * ## Why it follows the player instead of being placed in the world
   *
   * The maze is 2.4 km square across four levels. Motes scattered through that
   * at any visible density would be millions of points, almost all of them
   * behind a hedge. So there is ONE box of them, `POLLEN_COUNT` strong, which
   * rides with the player and wraps: a mote that drifts out of the box
   * reappears on the opposite face. The player is always in the middle of a
   * cloud that is always the same size, and it costs one draw call anywhere in
   * the world.
   *
   * That wrap is also why the box is a cube rather than a frustum - a mote
   * leaving the left face has to have somewhere to come back in, and biasing
   * the volume toward the view direction would make the return edge visible.
   */
  _buildPollen() {
    const n = MazeWorld.POLLEN_COUNT;
    const pos = new Float32Array(n * 3);
    const drift = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) {
      pos[i * 3] = (Math.random() - 0.5) * MazeWorld.POLLEN_BOX;
      pos[i * 3 + 1] = Math.random() * MazeWorld.POLLEN_HEIGHT;
      pos[i * 3 + 2] = (Math.random() - 0.5) * MazeWorld.POLLEN_BOX;
      /* Mostly a slow fall with a lateral wander. Pollen does not hang still
       * and it does not fall like rain. */
      drift[i * 3] = (Math.random() - 0.5) * 0.22;
      drift[i * 3 + 1] = -0.05 - Math.random() * 0.12;
      drift[i * 3 + 2] = (Math.random() - 0.5) * 0.22;
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    /* Dim, small and warm.
     *
     * Additive blending against corridors this dark is unforgiving: at half
     * opacity and 7.5 cm the motes came out as hard white specks evenly spread
     * over the frame, which reads as falling snow - or worse, as sensor noise
     * on the lens - rather than as something drifting in the air of a garden.
     * Pollen is barely-there and warm, so the fix is to take brightness and
     * size off it and push the colour further from white; the motion is what
     * sells it, and the motion is unchanged. */
    const mat = new THREE.PointsMaterial({
      color: 0xe6d191, size: 0.055, sizeAttenuation: true,
      transparent: true, opacity: 0.3, depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    /* Named for the same reason every material in `MazeMaterials` now is:
     * `world-shot --ablate` identifies a system by its material's NAME, and
     * an anonymous material is a system no A/B can switch off. This one is
     * declared here rather than in `buildMazeMaterials` because the cloud is
     * built per world rather than cached per session, and `maze-materials`'s
     * tripwire only greps MazeWorld for `Mesh*Material` - so it would not
     * have caught a nameless one. */
    mat.name = 'maze.pollen';
    const pts = new THREE.Points(geo, mat);
    pts.name = 'maze:pollen';
    pts.frustumCulled = false;      // it is always around the camera
    pts.renderOrder = 3;
    this.group.add(pts);
    this._pollen = { pts, pos, drift, centre: new THREE.Vector3() };
  }

  /**
   * Advance the motes and wrap them around the player.
   *
   * The positions are stored RELATIVE to the cloud's own object, and the
   * object is moved to the player each frame - which on its own would glue
   * every mote to the player and make the whole cloud slide along with them
   * like a swarm. So each mote first has the player's movement since last
   * frame subtracted out, which cancels the object move exactly and leaves the
   * mote standing still in the world. Only then does it drift, and only then
   * does it wrap back into the box if it has fallen off an edge.
   */
  _stepPollen(dt, player) {
    const p = this._pollen;
    if (!p || !player) return;
    const box = MazeWorld.POLLEN_BOX;
    const half = box / 2;
    const { pos, drift } = p;
    /* The floor of the level the player is on, so motes hang around the ground
     * they are standing on rather than around level 0 four floors down. */
    const base = Math.min(MAZE.LEVELS - 1, Math.max(0, Math.round(player.y / MAZE.LEVEL_HEIGHT)))
      * MAZE.LEVEL_HEIGHT;

    /* How far the anchor is about to move. On the first frame, and on any
     * teleport, this is huge - and the wrap below is a modulo rather than a
     * single shift precisely so that case lands correctly instead of leaving
     * the cloud a kilometre away for a few hundred frames. */
    const mx = player.x - p.centre.x;
    const my = base - p.centre.y;
    const mz = player.z - p.centre.z;

    for (let i = 0; i < pos.length; i += 3) {
      let x = pos[i] - mx + drift[i] * dt;
      let y = pos[i + 1] - my + drift[i + 1] * dt;
      let z = pos[i + 2] - mz + drift[i + 2] * dt;
      x = ((x + half) % box + box) % box - half;
      z = ((z + half) % box + box) % box - half;
      y = ((y % MazeWorld.POLLEN_HEIGHT) + MazeWorld.POLLEN_HEIGHT) % MazeWorld.POLLEN_HEIGHT;
      pos[i] = x; pos[i + 1] = y; pos[i + 2] = z;
    }
    p.pts.geometry.attributes.position.needsUpdate = true;
    p.pts.position.set(player.x, base, player.z);
    p.centre.set(player.x, base, player.z);
  }

  update(dt) {
    const player = this.ctx.player?.position;
    if (player && this.chunks) {
      this.chunks.updateResidency(player.x, player.y, player.z, RESIDENCY_RADIUS);
    }
    /* Population follows the districts, and follows them from THEIR OWN
     * residency map rather than from a second neighbourhood calculation of its
     * own. That is the whole safety argument: a token can never be alive in a
     * district whose floor has been released, because there is only one answer
     * to which districts are live and both readers use it.
     *
     * Unconditional on `player` - `chunks` cannot be resident without having
     * been told where the player is at least once, and a sync with the current
     * key set is a no-op after the first frame. */
    if (this.chunks && this.population) {
      this.population.sync(this.chunks.residentKeys());
    }
    /* Lifts, before this method's token early-return further down - a lift
     * that only moved in districts that happen to have dead-end tokens would
     * be a lift that mostly does not move. */
    if (this.chunks) this.chunks.stepLifts(dt, player ?? null);

    /* The centre. Same radius test as a dead-end token, and the same
     * announce-never-award rule. */
    if (player && !this._centreTaken && this.centrePosition) {
      const dx = player.x - this.centrePosition.x;
      const dy = (player.y + 1.0) - this.centrePosition.y;
      const dz = player.z - this.centrePosition.z;
      if (dx * dx + dy * dy + dz * dz < TOKEN_PICKUP_R2) this._collectCentre();
    }

    /* Hold-L to leave, from anywhere and at any depth. Announced on the bus
     * and never acted on here: `main.js` owns the world switch, the same rule
     * that keeps `maze:token-found` from touching Economy directly. */
    const holding = this.ctx?.input?.held?.('KeyL') === true;
    const { progress, fired } = this._abandon.update(dt, holding);
    if (progress !== this._abandonShown) {
      this._abandonShown = progress;
      this.bus?.emit('maze:abandon-progress', { progress });
    }
    if (fired) this.bus?.emit('maze:abandon', {});
    if (player && this.canopy) {
      const level = Math.min(MAZE.LEVELS - 1, Math.max(0, Math.round(player.y / MAZE.LEVEL_HEIGHT)));
      this.canopy.update(player.x, player.z, level);
    }
    if (player && this._shaftsByLevel) {
      // Only re-point `shaftMarkers` when the player's level actually
      // changes - Minimap reads this reference every frame, so swapping it
      // only on a level change (rather than reassigning the same array every
      // frame) is free the other 99.9% of the time.
      const level = Math.min(MAZE.LEVELS - 1, Math.max(0, Math.round(player.y / MAZE.LEVEL_HEIGHT)));
      if (level !== this._markersLevel) {
        this._markersLevel = level;
        this.shaftMarkers = this._shaftsByLevel[level];
      }
    }

    this._stepPollen(dt, player);

    const mesh = this.population?.mesh;
    const live = this._tokens;
    if (!mesh || live.length === 0) return;
    this._tokenTime += dt;
    const t = this._tokenTime;
    const p = this.ctx.player?.position;

    let dirty = false;
    /* Indexed by the record's own SLOT, not by its position in this array. The
     * array is compacted whenever a district is released, so `i` stops naming
     * the same instance the moment anything streams out - which would animate
     * one token and pick up another. */
    for (let i = 0; i < live.length; i++) {
      const tok = live[i];
      if (tok.taken) continue;

      if (p) {
        const dx = p.x - tok.position.x;
        const dy = (p.y + 1.0) - tok.position.y;
        const dz = p.z - tok.position.z;
        if (dx * dx + dy * dy + dz * dz < TOKEN_PICKUP_R2) {
          /* Recorded against the CELL, not the instance: the district can be
           * released and walked back into, and a token that came back would be
           * a token that pays twice. See MazePopulation.collect. */
          this.population.collect(tok);
          dirty = true;
          /* MazeWorld never touches Economy or HUD directly - main.js is the
           * single integration point (see its header comment) and owns the
           * award and the notification. This only announces the fact. */
          this.bus?.emit('maze:token-found', { amount: MAZE_TOKEN_VALUE });
          continue;
        }
      }

      const bob = Math.sin(t * 1.6 + tok.phase) * 0.12;
      _tokPos.set(tok.position.x, tok.position.y + bob, tok.position.z);
      _tokQuat.setFromAxisAngle(_tokUp, t * 1.1 + tok.phase);
      _tokMat.compose(_tokPos, _tokQuat, _tokScale);
      mesh.setMatrixAt(tok.slot, _tokMat);
      dirty = true;
    }
    if (dirty) mesh.instanceMatrix.needsUpdate = true;
  }

  /** The prize: a stack of credits at the centre, worth 100. */
  _buildCentreStack(material) {
    const c = cellCoords(this.centreCell);
    const w = cellToWorld(c.x, c.z, c.level);
    const stack = new THREE.Group();
    stack.name = 'maze:centre-stack';
    for (let i = 0; i < 7; i++) {
      const coin = new THREE.Mesh(new THREE.CylinderGeometry(0.5, 0.5, 0.08, 20), material);
      coin.position.set(
        (i % 2) * 0.04 - 0.02,
        0.06 + i * 0.09,
        Math.floor(i / 2) * 0.03 - 0.03,
      );
      coin.castShadow = true;
      stack.add(coin);
    }
    stack.position.set(w.x, w.y, w.z);
    this.group.add(stack);

    /* Deliberately NOT collidable. A 0.7m stack sits squarely in the 0.45-5.0m
     * hop band, and the centre cell has hedges on at least three sides - a
     * solid stack there would be a step onto the hedge tops. */
    this.centrePosition = new THREE.Vector3(w.x, w.y, w.z);
    this._centreStack = stack;
    this._centreTaken = false;
  }

  /**
   * Take the centre: pay once, and open a way home from it.
   *
   * Guarded on `_centreTaken` because the pickup radius is tested every frame,
   * and paying per frame would be 100 credits every sixtieth of a second.
   *
   * The portal OPENS rather than existing from the start. The walk out must
   * not be forced (spec section 6), but a portal standing at the centre from
   * the beginning would be a way to skip the maze entirely for anyone who
   * happened to arrive there - which, in a maze that re-rolls, is exactly what
   * a lucky route is.
   *
   * Announces and never awards: `main.js` owns Economy and the HUD, the same
   * rule the dead-end tokens follow.
   */
  _collectCentre() {
    if (this._centreTaken) return;
    this._centreTaken = true;
    if (this._centreStack) this._centreStack.visible = false;

    const c = cellCoords(this.centreCell);
    const w = cellToWorld(c.x, c.z, c.level);
    this.portalSpecs.push({
      position: new THREE.Vector3(w.x, w.y, w.z),
      rotationY: 0,
      target: 'station',
      label: 'Aether Station',
      accent: 0xffd479,
    });
    this.bus?.emit('maze:centre-opened', { position: this.centrePosition.clone() });
    this.bus?.emit('maze:centre-found', { amount: MAZE_CENTRE_VALUE });
  }

  /** Re-generation needs a clean group and collider list each time. */
  dispose() {
    /* Population before geometry, and before the group traversal below: it has
     * live CHARACTERS out on loan to `NPCManager`, which owns them and has to be
     * told to take them back. Nothing else in this teardown can do that - the
     * group traversal only frees what is parented here, and a wanderer's body
     * is parented to the scene. */
    this.population?.disposeAll();
    this.population = null;
    this.chunks?.disposeAll();
    this.chunks = null;
    this.canopy?.disposeAll();
    this.canopy = null;

    this.group.traverse((obj) => {
      if (obj.geometry) obj.geometry.dispose();
      /* InstancedMesh owns an `instanceMatrix` GPU buffer that geometry
       * disposal does not touch - it is released only through the mesh's own
       * dispose event. At ~175,600 hedge instances that is 175,600 * 16 * 4 =
       * ~11.2 MB stranded on every re-roll if this is skipped, and repeated
       * re-rolling is this world's entire premise. */
      if (obj.isInstancedMesh) obj.dispose();
    });
    this.group.clear();
    this.colliders.length = 0;
    this._built = false;
    /* Materials survive on purpose - see _ensureMaterials. */

    /* The token InstancedMesh was released by `population.disposeAll()` above,
     * which also removed it from the group so the traversal cannot double-free
     * it. This drops the last reference to the previous roll's token array, so
     * a straggling update() between dispose() and the next build() iterates
     * nothing rather than writing into a disposed buffer. `npcSpawns` is reset
     * at the top of `_populate` rather than here, matching `portalSpecs`, which
     * build() also reassigns outright instead of clearing in dispose(). */
    this._tokens = [];
    /* Same reasoning: the Points and its geometry are freed by the traversal
     * above, and this drops the bookkeeping so a straggling update() between
     * dispose() and the next build() cannot write into a disposed buffer. */
    this._pollen = null;

    /* Same reasoning as `_tokenMesh` above: drop the previous roll's shaft
     * markers so a straggling Minimap frame between dispose() and the next
     * build() cannot draw shafts from a layout that no longer exists. */
    this._shaftsByLevel = null;
    this.shaftMarkers = [];
    this._markersLevel = -1;
  }
}
