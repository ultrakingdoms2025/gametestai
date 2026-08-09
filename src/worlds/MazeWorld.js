import * as THREE from 'three';
import { World } from './World.js';
import { makeRules } from './WorldRules.js';
import {
  MAZE, DIR, generateTopology, cellCoords, carveEntranceCorridor, hash32, mulberry32,
  cellIndex, isOpen, connectorAt, parentField, buildDistrictGraph, districtIndex, solve,
} from './maze/MazeTopology.js';
import {
  cellToWorld, forecourtColliders, FORECOURT_PORTAL_Z,
} from './maze/MazeColliders.js';
import { tunnelOrientation } from './maze/MazeShafts.js';
import { puzzleCells } from './maze/MazePuzzles.js';
import { pickDeadEndTokens, pickWandererSites, routeToward } from './maze/MazePopulate.js';
import { MazeChunks, buildBoxInstances } from './maze/MazeChunks.js';
import { MazeCanopy } from './maze/MazeCanopy.js';
import { makeNoiseTexture } from '../gfx/Textures.js';
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
 * The eight lost wanderers. Capped at eight per the design doc (section 9) -
 * `WANDERER_CAST.length` is what `_populate` asks `pickWandererSites` for, so
 * adding or removing a character here is the only thing that needs to change
 * to change the count.
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
 * Dead-end tokens across the whole maze, divided evenly between the levels.
 *
 * Was 40. Each level is 160,000 cells, so forty of them across four levels was
 * roughly one per sixteen thousand cells - findable only by accident. The
 * placement is still dead-ends only, so raising this does not put them in
 * corridors; it puts them in more of the dead ends that already exist.
 */
export const TOTAL_TOKENS = 200;

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

// Scratch objects for the per-frame token instance-matrix update, reused
// every call rather than allocated - see the note on MazeWorld.update.
const _tokPos = new THREE.Vector3();
const _tokQuat = new THREE.Quaternion();
const _tokScale = new THREE.Vector3(1, 1, 1);
const _tokZeroScale = new THREE.Vector3(0, 0, 0);
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

    /** @type {Array<{position: THREE.Vector3, taken: boolean, phase: number}>} */
    this._tokens = [];
    /** @type {THREE.InstancedMesh|null} */
    this._tokenMesh = null;
    this._tokenTime = 0;
    /** @type {MazeChunks|null} the district streaming manager, created in build() */
    this.chunks = null;
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
    /* Raised from 0.7. Levels 0-2 are ROOFED by the floor above - inherent to
     * stacking four levels nine metres apart - so almost no sun reaches them
     * and the maze read as very dark. The candles do the local work; this
     * lifts the floor so a corridor between two of them is gloomy rather than
     * black. */
    this.environment.ambientIntensity = 1.25;
    this.environment.sunColor = new THREE.Color(0xfff2d8);
    this.environment.sunIntensity = 2.2;
    this.environment.sunDirection = new THREE.Vector3(-0.3, 0.9, -0.25).normalize();
  }

  /** Reusable material set, built on first use and kept for the session. */
  _ensureMaterials() {
    if (this._materials) return this._materials;

    /* Maps, generated ONCE with the material set - which is once per session,
     * since the set is cached and reused across every re-roll and every
     * streamed chunk. A texture built per chunk would be worse than a material
     * per chunk, and `scripts/tests/maze-lighting.test.mjs` has a tripwire
     * asserting MazeChunks never builds either.
     *
     * Colour maps only, no normal maps: `makeNormalFromHeight` takes a
     * Float32Array HEIGHT FIELD, not a texture, and there is no exported
     * helper that hands one back from `makeNoiseTexture`. Passing the texture
     * would have compiled and produced garbage. Worth revisiting with a real
     * height field; not worth guessing at.
     */
    const hedgeMap = makeNoiseTexture({
      size: 256, frequency: 22, octaves: 5, gain: 0.55, contrast: 1.15, seed: 0x4a1,
      /* The ramp's low end sets the average, and the first pass came out
       * darker than the flat colour it replaced - a textured hedge that
       * reads as black is not an improvement on a flat one. */
      colorA: 0x2c4526, colorB: 0x74a54e,
    });
    hedgeMap.wrapS = THREE.RepeatWrapping;
    hedgeMap.wrapT = THREE.RepeatWrapping;
    hedgeMap.repeat.set(2.5, 1.6);

    /* The floor: packed earth, much coarser than the hedge so the two never
     * read as the same surface down a corridor. */
    const floorMap = makeNoiseTexture({
      size: 256, frequency: 9, octaves: 4, gain: 0.5, contrast: 0.9, seed: 0x77c,
      colorA: 0x5d5446, colorB: 0x9a8e78,
    });
    floorMap.wrapS = THREE.RepeatWrapping;
    floorMap.wrapT = THREE.RepeatWrapping;
    floorMap.repeat.set(8, 8);

    /* Stair treads and landings. Pale stonework, deliberately far from both
     * the dark hedge green and the stone-brown floor - a stair is meant to
     * read as a landmark the instant it comes into view down a corridor, not
     * blend into the hedge that walls it in. Built once and reused across
     * every re-roll for the same reason every other cached material is.
     *
     * The emissive term dates from Phase 2b, when a sealed shaft was pitch
     * black and the reasoning was that a per-shaft lamp was impossible. THAT
     * REASONING WAS WRONG - see `MazeChunks`'s lantern note and LightRig's own
     * header: authored lights are claimed into fixed slots and cost no
     * programs. The emissive is kept because a stair that glows faintly reads
     * as a landmark down a dark corridor, which is a reason that survives the
     * correction; it is no longer load-bearing for visibility.
     *
     * Reused verbatim (not merely colour-matched) for the shaft's own walls
     * below - see `shaftWall`. */
    const stair = new THREE.MeshStandardMaterial({
      color: 0xd8cdb0, roughness: 0.8, metalness: 0,
      emissive: 0x4a4330, emissiveIntensity: 0.45,
    });

    this._materials = {
      /* Textured since Phase 5. Flat colour read as a box at any distance,
       * which is what a hedge maze must not do: the player navigates by
       * telling one corridor from another. */
      /* Textured since Phase 5. Flat colour read as a box at any distance,
       * which is the one thing a hedge maze must not do: the player navigates
       * by telling one corridor from another. */
      hedge: new THREE.MeshStandardMaterial({
        color: 0xffffff, roughness: 0.95, metalness: 0, map: hedgeMap,
      }),
      floor: new THREE.MeshStandardMaterial({
        color: 0xffffff, roughness: 1.0, metalness: 0, map: floorMap,
      }),
      stair,
      /* The shaft's own walls (see shaftColliders) - the exact same cached
       * material as `stair` (not merely colour-matched), so a shaft reads as
       * one continuous piece of pale stonework rather than a tower of one
       * colour wrapped around a staircase of another.
       *
       * This is the fix for a shaft being invisible from outside: its walls
       * rise to LEVEL_HEIGHT (9m), 4m above the 5m hedge line, so a shaft is
       * already geometrically a tower - but `shaftColliders` used to emit
       * those walls with kind:'hedge', so they were drawn in the same dark
       * green as every ordinary hedge and vanished into the canopy.
       * `shaftWall` is its own `CHUNK_MESH_KINDS` entry (see MazeChunks.js)
       * specifically so it gets its own InstancedMesh in this pale material
       * instead - ordinary hedges are untouched. */
      shaftWall: stair,
      /* The lift car. Its own material rather than the stair's, because it is
       * the one surface in a shaft that MOVES and the player needs to read it
       * as a thing rather than as more stonework - a darker metal against the
       * pale stone of the shaft it rides in. Emissive for the same reason the
       * treads are: a shaft is sealed and unlit, and `LightRig.js` pools every
       * light into a fixed slot because Three bakes the light COUNT into each
       * shader's program cache key, so a lamp per lift is the 250 s of
       * recompilation main.js already measured. Built once and cached here
       * like every other entry - a material allocated per chunk or per lift
       * would re-trigger that compilation on every re-roll. */
      lift: new THREE.MeshStandardMaterial({
        color: 0x8a8f99, roughness: 0.45, metalness: 0.65,
        emissive: 0x2b3138, emissiveIntensity: 0.55,
      }),
      /* Tunnel treads. A vaulted descent rather than an open spiral, so a
       * shade warmer and darker than the stair's pale stone - the two must not
       * read as the same structure seen twice, since the whole point of three
       * connectors is that a player learns to tell them apart. Emissive for
       * the same reason everything down here is: a tunnel folds under level
       * N+1's floor and is the darkest space in the maze, and `LightRig.js`
       * bans a lamp per connector because Three bakes the light COUNT into
       * every shader's program cache key. Built once and cached. */
      tunnel: new THREE.MeshStandardMaterial({
        color: 0xb9a488, roughness: 0.85, metalness: 0,
        emissive: 0x4a3c2a, emissiveIntensity: 0.5,
      }),
      /* The landing door. Read as a counterweight slab: the same stone family
       * as the shaft so it belongs to the structure, but darker and plainly
       * a moving part, so that a closed door reads as "the lift is elsewhere"
       * rather than as a dead end. */
      liftDoor: new THREE.MeshStandardMaterial({
        color: 0x9a917c, roughness: 0.7, metalness: 0.15,
        emissive: 0x3a3428, emissiveIntensity: 0.35,
      }),
      credits: new THREE.MeshStandardMaterial({
        color: 0xffd479, roughness: 0.35, metalness: 0.8,
        emissive: 0x6a4a10, emissiveIntensity: 0.6,
      }),
      /* Dead-end tokens. One more cached material, built once here and reused
       * across every re-roll for the same reason the other two are - see the
       * class docstring above. A cool glow reads clearly in a dim dead end
       * without being mistaken for the centre stack's gold. */
      token: new THREE.MeshStandardMaterial({
        color: 0x8fe0c9, roughness: 0.3, metalness: 0.25,
        emissive: 0x2fae86, emissiveIntensity: 1.15,
      }),
      /* Distant hedge-tops beyond the streamed districts - see MazeCanopy. One
       * more cached, built-once entry for the same reason as the others: a flat
       * quad allocated per district or per build would re-trigger the shader
       * compilation that already dominates cold boot. Flat and a shade darker
       * than the hedge material so it reads as distance, not as more maze. */
      /* Weathered stone at each hedge's base - "five-metre hedges over
       * weathered stone footings", section 10. Mesh only; see MazeFoliage.js
       * for why it registers no colliders. */
      footing: new THREE.MeshStandardMaterial({
        color: 0x7d7566, roughness: 1.0, metalness: 0,
      }),
      /* Unkempt growth along the hedge tops. A shade lighter and yellower than
       * the hedge itself so it reads as new growth against clipped body,
       * rather than as noise on the same surface. */
      foliage: new THREE.MeshStandardMaterial({
        color: 0x86ab55, roughness: 1.0, metalness: 0,
      }),
      /* The candle itself - wax, lit from within. Strongly emissive so it
       * reads as a source at a distance even where the rig has spent its
       * twelve point slots elsewhere. */
      candle: new THREE.MeshStandardMaterial({
        color: 0xffe9c0, roughness: 0.6, metalness: 0,
        emissive: 0xffb457, emissiveIntensity: 2.2,
      }),
      /* A one-way gate. Hedge that has been cut and trained over a frame -
       * darker and greyer than a grown hedge, so that a corridor which is
       * about to close behind you does not look like every other corridor. */
      gate: new THREE.MeshStandardMaterial({
        color: 0x3f5a34, roughness: 1.0, metalness: 0,
      }),
      /* A sliding hedge wall. Reads as the same worked hedge as a gate, warmed
       * slightly so the two are distinguishable at a glance without either
       * looking like plain hedge. */
      slideWall: new THREE.MeshStandardMaterial({
        color: 0x4a5b2f, roughness: 1.0, metalness: 0,
      }),
      /* The pressure plate. Worked stone, faintly lit, because a flush pad on
       * a dim corridor floor is invisible otherwise and an invisible trigger
       * is indistinguishable from no trigger. */
      plate: new THREE.MeshStandardMaterial({
        color: 0x9a8f74, roughness: 0.75, metalness: 0,
        emissive: 0x6f5a2a, emissiveIntensity: 0.7,
      }),
      canopy: new THREE.MeshStandardMaterial({ color: 0x24391f, roughness: 1, metalness: 0 }),
    };
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
     * world is volatile, so this is what makes the maze unlearnable. */
    this.seed = (Math.random() * 0xffffffff) >>> 0;

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

    const mats = this._ensureMaterials();
    const ew = cellToWorld(e.x, e.z, e.level);

    /* Districts stream (see this.chunks below). The forecourt does not: it is
     * hand-authored, sits outside the cell grid in negative z, and is the floor
     * the player arrives on. It needs meshes as well as colliders. */
    const descs = [];
    for (const d of forecourtColliders(ew.x, e.level)) descs.push(d);

    const hedges = descs.filter((d) => d.kind === 'hedge');
    const floors = descs.filter((d) => d.kind === 'floor');
    buildBoxInstances(hedges, mats.hedge, 'maze:forecourt:hedge', this.group);
    buildBoxInstances(floors, mats.floor, 'maze:forecourt:floor', this.group);

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

    await onProgress?.(1, 'The Verdant Coil is ready');
  }

  /**
   * Place the keeper, the eight lost wanderers, and the dead-end tokens.
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

    /* EVERY level, not just the entrance's.
     *
     * This used to read `const level = e.level` and populate that one level,
     * which meant all eight wanderers and all forty tokens sat on level 0 and
     * the three levels above them were empty - in a world whose whole point is
     * that there are four of them and stairs between. A player who climbs is
     * owed something up there.
     *
     * The cast is still capped at eight (section 9), so it is divided rather
     * than multiplied: two lost wanderers and ten tokens per level.
     */
    /* The owner asked for a lot more of both. The cast grew from eight to
     * twenty so every wanderer is still a distinct person rather than the same
     * eight repeated with different names - a maze full of duplicated
     * personas reads worse than a maze with fewer people in it. */
    const perLevel = Math.max(1, Math.floor(WANDERER_CAST.length / MAZE.LEVELS));
    const tokensPerLevel = Math.max(1, Math.floor(TOTAL_TOKENS / MAZE.LEVELS));

    /* ONE breadth-first sweep, rooted at the centre, shared by every wanderer
     * on every level - see `parentField`. The field spans all four levels, so
     * a wanderer anywhere walks toward the real centre; `routeToward` is what
     * stops their route at a level change. */
    const toCentre = parentField(this.cells, this.centreCell);

    let castIndex = 0;
    const tokenEntries = [];
    for (let level = 0; level < MAZE.LEVELS; level++) {
      const wandererCells = pickWandererSites(
        this.cells, level, hash32(this.seed, 0x1a7, level), perLevel, exclude,
      );
      for (const startCell of wandererCells) {
        const routeCells = routeToward(toCentre, startCell, PATROL_STEPS);
        const patrol = routeCells.map((idx) => {
          const c = cellCoords(idx);
          const w = cellToWorld(c.x, c.z, c.level);
          return new THREE.Vector3(w.x, w.y + 0.05, w.z);
        });
        const cast = WANDERER_CAST[castIndex % WANDERER_CAST.length];
        castIndex++;
        this.npcSpawns.push({
          position: patrol[0].clone(),
          type: 'friendly',
          name: cast.name,
          persona: cast.persona,
          patrol,
        });
      }

      for (const cell of pickDeadEndTokens(
        this.cells, level, hash32(this.seed, 0x70c, level), tokensPerLevel, exclude,
      )) {
        tokenEntries.push({ cell, level });
      }
    }

    this._buildTokens(tokenEntries, mats.token);
  }

  /**
   * The ~40 dead-end tokens. Deliberately NOT collidable, with no exception -
   * see the same note on `_buildCentreStack`. A dead end puts a hedge corner
   * within 2m on at least two sides by definition, which is exactly the
   * geometry §2 of the design doc calls a ladder if anything standable sits
   * in the 0.45-5.0m band there. These never reach `this.physics.addBox` at
   * all, which is the only way to be sure of that rather than merely careful
   * about it.
   */
  _buildTokens(entries, material) {
    this._tokens = [];
    this._tokenMesh = null;
    if (entries.length === 0) return;

    /* ONE mesh for every level's tokens. It used to take a single level and
     * reset `_tokens` on entry, so calling it per level would have kept only
     * the last - and an instanced mesh holds a world position per instance
     * anyway, so the level is already carried in the matrix. */
    const geo = new THREE.OctahedronGeometry(0.3, 0);
    const mesh = new THREE.InstancedMesh(geo, material, entries.length);
    mesh.name = 'maze:tokens';
    mesh.castShadow = true;
    mesh.receiveShadow = false;
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);

    /* Seeded off the maze's own seed so token placement is visually varied
     * (bob/spin phase) but exactly reproducible for a given re-roll, same as
     * everything else in this world. */
    const rng = mulberry32(hash32(this.seed, 0x704e));
    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const s = new THREE.Vector3(1, 1, 1);

    for (let i = 0; i < entries.length; i++) {
      const c = cellCoords(entries[i].cell);
      const w = cellToWorld(c.x, c.z, entries[i].level);
      const position = new THREE.Vector3(w.x, w.y + 0.6, w.z);
      this._tokens.push({ position, taken: false, phase: rng() * Math.PI * 2 });
      m.compose(position, q, s);
      mesh.setMatrixAt(i, m);
    }
    mesh.instanceMatrix.needsUpdate = true;
    this.group.add(mesh);
    this._tokenMesh = mesh;
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

  update(dt) {
    const player = this.ctx.player?.position;
    if (player && this.chunks) {
      this.chunks.updateResidency(player.x, player.y, player.z, RESIDENCY_RADIUS);
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

    if (!this._tokenMesh || this._tokens.length === 0) return;
    this._tokenTime += dt;
    const t = this._tokenTime;
    const p = this.ctx.player?.position;

    let dirty = false;
    for (let i = 0; i < this._tokens.length; i++) {
      const tok = this._tokens[i];
      if (tok.taken) continue;

      if (p) {
        const dx = p.x - tok.position.x;
        const dy = (p.y + 1.0) - tok.position.y;
        const dz = p.z - tok.position.z;
        if (dx * dx + dy * dy + dz * dz < TOKEN_PICKUP_R2) {
          tok.taken = true;
          // Hide by zero-scaling: an InstancedMesh has no per-instance
          // visibility flag, only a matrix, and shrinking the instance to
          // nothing is cheaper than rebuilding the whole buffer one entry
          // shorter every time a token is found.
          _tokMat.compose(tok.position, _tokQuat, _tokZeroScale);
          this._tokenMesh.setMatrixAt(i, _tokMat);
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
      this._tokenMesh.setMatrixAt(i, _tokMat);
      dirty = true;
    }
    if (dirty) this._tokenMesh.instanceMatrix.needsUpdate = true;
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

    /* The token InstancedMesh and its geometry are freed by the traversal
     * above (it lives in `this.group` like everything else); this just drops
     * the bookkeeping so a stale `_tokenMesh` from the previous roll can
     * never be written to by a straggling update() call between dispose()
     * and the next build(). `npcSpawns` is reset at the top of `_populate`
     * rather than here, matching `portalSpecs`, which build() also
     * reassigns outright instead of clearing in dispose(). */
    this._tokens = [];
    this._tokenMesh = null;

    /* Same reasoning as `_tokenMesh` above: drop the previous roll's shaft
     * markers so a straggling Minimap frame between dispose() and the next
     * build() cannot draw shafts from a layout that no longer exists. */
    this._shaftsByLevel = null;
    this.shaftMarkers = [];
    this._markersLevel = -1;
  }
}
