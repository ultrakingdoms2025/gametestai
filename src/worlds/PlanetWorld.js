import * as THREE from 'three';
import { World } from './World.js';
import { makeRules, worldGravityRatio } from './WorldRules.js';
import { genPool } from '../workers/GenPool.js';
import { createSky } from '../gfx/Sky.js';
import { HEIGHT_FIELDS } from './terrain/index.js';
import { fbm } from './terrain/PlanetHeight.js';
import { scatter } from './planets/Placement.js';
import { buildPropField, buildPlumes } from './planets/PlanetProps.js';
import {
  createLiquidMaterial, createSkirtMaterial, bodyGeometry,
  liquidCellMask, liquidContour, liquidWalls, liquidDepth, liquidKind, bodySurfaceAt,
} from './planets/PlanetLiquid.js';

/**
 * THE SHORE WALL: a run of square posts standing ON the waterline.
 *
 * ── Why posts, and why none of them is rotated ───────────────────────────
 * EVERY REACH PROBE IN THIS REPO MODELS A COLLIDER BY ITS AXIS-ALIGNED BOUNDS.
 * `planet-minerals.test.mjs`'s `boxIndex` is the pattern and the others copy
 * it. That was exact while every planet collider was cell-aligned, and it is a
 * gross over-estimate for anything turned: a 13 m wall panel following a
 * shoreline at 76 degrees has a 14 x 6 m bounding box, so a probe sees three
 * metres of blocked bank on each side of a wall that is three metres thick in
 * total. Measured on Verdigris: oriented panels placed correctly IN the water
 * still cost eleven of twenty malachite nodes when flooded, because the flood
 * could not see them as anything but their bounds.
 *
 * A square, axis-aligned post IS its own bounding box. The measurement and the
 * engine agree by construction, which is the same principle the terrain mesh
 * and its collider are built on one grid for.
 *
 * ── The numbers ──────────────────────────────────────────────────────────
 * `POST_HALF` 1.1 m, dropped along the waterline every `POST_SPAN` 1.3 m so
 * consecutive posts always overlap (any spacing under 2 x POST_HALF does, in
 * any direction). Each post is pushed `POST_HALF - WALL_BIAS` INTO the water,
 * so it reaches only `WALL_BIAS` onto the bank - and the bank is where
 * `terrain: 'channel'` and `terrain: 'shore'` ore is deliberately placed.
 *
 * `WALL_BIAS` also absorbs the contour's own error: `liquidWalls` lets the true
 * waterline wander 0.35 m from the straight run that replaces it, so a face
 * placed exactly on the run would leave a band that wide where a body could
 * stand inside the drawn liquid. Measured on Cinder before the bias existed:
 * one approach in 136 ended 1.06 m under the lava at the lake rim.
 *
 * `WALL_SUB` subdivides each terrain cell when the contour is marched. 2 puts
 * the waterline within about 0.8 m of the truth on a 3.1 m cell for four times
 * the field evaluations; 1 was visibly coarse on a river 20 m wide.
 */
const POST_HALF = 1.1;
const POST_SPAN = 1.3;
const WALL_BIAS = 0.35;
const WALL_SUB = 2;

/* ══════════════════════════════════════════════════════════════════════════
 *  HOW TALL THE SHORE WALL HAS TO BE, AND WHAT IT IS MEASURED FROM
 * ══════════════════════════════════════════════════════════════════════════
 *
 * THE DATUM WAS WRONG. The parapet was `run.surf + parapet` - measured from the
 * WATER - and the player does not stand on the water, they stand on the bank
 * beside it. Measured on Shoal in a real boot: sea level 6.0, the bank at the
 * waterline 7.3-7.4, a parapet of 2.0 m putting the post top at 8.0, and a
 * running leap whose apex is 1.18 m. 7.4 + 1.18 = 8.6 against a top of 8.0, so
 * the effective gate was NEGATIVE. Seven of eight bearings out of the Glassflat
 * pad went straight over it into 14 m of water; walking held on all eight,
 * which is exactly why 2,500 green tests could not see it.
 *
 * THE HEIGHT WAS WRONG TWICE OVER, and the second one nobody had measured at
 * all: at 2.0 m above the ground a post top is a LEDGE. `Climb.MAX_RISE` is
 * 2.4 m and `_minRiseGround` is at most 2.0, so a 2.0 m wall standing on ground
 * level with the water sits inside the mantle band and can simply be climbed.
 *
 * ── AND THE TWO NUMBERS ADD UP, WHICH IS THE PART THAT WAS MEASURED LAST ──
 * The first fix here sized the wall at `max(leapApex + 0.9, MAX_RISE + 0.3)` -
 * 2.70 m - and driving it in a browser still crossed six of eight bearings out
 * of Shoal's Glassflat pad. The trajectories say why, and they are unambiguous:
 * the body's peak y on every crossing is the POST TOP plus exactly one standing
 * jump. It never went over the wall. It got ON it.
 *
 * `Player` offers the mantle ON THE JUMP PRESS, and the press does not have to
 * come from the ground: `Climb._probe` measures the rise from the FEET, and feet
 * that are one leap up are one leap closer to the lip. So the two reaches
 * COMPOSE - jump, press jump again at the top of the arc, mantle - and the real
 * reach of a body at a wall is
 *
 *      leap apex  +  MAX_RISE
 *
 * Measured on Shoal: ground 6.78, post top 9.48, standing rise 2.70 - refused,
 * over MAX_RISE. Jump to 7.72 and the rise is 1.76, inside the 1.0-2.4 band, and
 * the mantle fires. That is not an exotic input; it is holding sprint and
 * tapping jump twice.
 *
 * So the wall is sized from the ground a body could LEAP FROM, and it has to
 * out-top the sum:
 *
 *   leap apex   `Player#jumpApex` times {@link LEAP_LIFT} squared. The apex
 *               scales as `ratio^(-1/3)` because `Player.setWorldGravity` scales
 *               the take-off velocity as `ratio^(1/3)` - a low-gravity world
 *               gets a bigger jump, not the same one in slow motion. The OLD
 *               expression used the unscaled 6.4 m/s against the scaled gravity,
 *               which is not any jump the player has: on Tessera it over-stated
 *               the apex by 3.3x and on Shoal it under-stated the LEAP by 19%.
 *   mantle      `Climb.MAX_RISE`, which does not scale - it is how far a pair of
 *               arms reaches, not how hard the world pulls.
 *
 * The posts are 2.2 m square, so their tops ARE standing room and the mantle has
 * somewhere to land. That is not incidental: the yard's mouth screen is 0.5 m
 * deep and holds at 2.70 m against the same input, because there is nowhere on
 * top of it to put a body. A fat wall has to be taller than a thin one.
 *
 * @see ../player/Player.js `setWorldGravity`, and the mantle offered on `jumpEdge`
 * @see ../player/Parkour.js `LEAP_LIFT`
 * @see ../player/Climb.js `MAX_RISE`
 */
/** `Parkour.LEAP_LIFT`: the multiplier a running leap puts on take-off speed.
 *  Duplicated rather than imported because `Parkour` exports it to nobody;
 *  `planet-liquid.test.mjs` reads both files and asserts they agree. */
const LEAP_LIFT = 1.12;
/** `Climb.MAX_RISE`: the tallest ledge a mantle can take. Does not scale. */
const MANTLE_MAX = 2.4;
/** Head-room over the leap-plus-mantle reach. A gate held by centimetres is not
 *  a gate, and this one is held over ten planets whose apexes span 1.16-1.26 m. */
const GATE_MARGIN = 0.35;
/**
 * How far from a post the wall looks for the ground a body would leap FROM, in
 * metres.
 *
 * A running leap reaches its apex about 3 m into the jump at walking-to-sprint
 * speeds, so ground further out than this is ground the player is already
 * descending from by the time they reach the wall. Sampling 8 m inland instead
 * would wall off every beach that has a dune behind it.
 *
 * ── ALL EIGHT BEARINGS, NOT JUST THE LANDWARD NORMAL ──────────────────────
 * The first version marched only along `-n`, the run's averaged inward normal.
 * That is the correct DIRECTION and it is not the only one: `n` is averaged over
 * a run up to 14 m long, so at a concave corner of the shoreline the higher
 * ground beside a post sits on a different bearing entirely. Measured on
 * Cinder, at (-235, -188): the landward march found a bank at 24.4 m, a ring
 * march found 25.1 m seven-tenths of a metre away, and the gate there was 1.97 m
 * - clear of the 1.23 m leap and INSIDE the 2.4 m mantle band. One post, and it
 * is a post you can climb.
 *
 * So the whole ring is sampled. On the water side this finds the bed, which is
 * lower and changes nothing; it only bites in a channel narrow enough that the
 * far bank is within reach, where a taller post is the right answer anyway.
 */
const LAND_PROBE = [1.4, 2.8, 4.2, 5.4];
const LAND_BEARINGS = 8;
/**
 * Ceiling on how far a post may stand above the water, in metres.
 *
 * A backstop and not a design number. The bank is sampled within 5.4 m of the
 * waterline, so this can only bind where the ground goes near-vertical straight
 * out of the sea, and a post that answered a 100 m sea cliff literally would be
 * a 100 m invisible column standing in open water.
 *
 * The first value tried was 14, and it bound on 97 of Shoal's 3,122 posts and
 * took the worst gate on the planet down to 1.24 m - inside the mantle band,
 * which is the same class of hole this whole change is closing. At 30 nothing
 * clamps anywhere: the tallest post on any of the five liquid planets stands
 * 15.5 m over its water (Shoal), and every one of the 6,029 posts in the system
 * carries the full 2.7 m gate. `clampedPosts` in the census is how that stays
 * true - a planet whose shores get steeper reports it rather than quietly
 * shipping a hurdle.
 */
const WALL_MAX = 30;

/**
 * PLANET SURFACES - one world class, any number of planets.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 *  THE BOUNDARY THIS FILE EXISTS TO HOLD
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * There is no planet in this file. No volcano, no ice, no `if (planet.id ===
 * 'cinder')`, and there must never be one. Everything that distinguishes one
 * world from another arrives as a descriptor: its height field's parameters,
 * its palette, its sky, its liquid, its props, its minerals, its landing sites
 * and its gravity. Ten planets cost ten descriptors.
 *
 * That is not a stylistic preference. The alternative - `VolcanicWorld.js`,
 * then `IceWorld.js`, then `JungleWorld.js` - is how this project ends up with
 * `CitadelWorld.js` at 2,937 lines nine times over, and the ninth one gets the
 * bug the third one fixed. The precedent for doing it the other way is already
 * here: `HEIGHT_FIELDS` is a registry of pure height functions the generation
 * worker samples BY NAME, and Citadel authored six distinct regions out of one
 * landform vocabulary. This is that pattern taken up one level.
 *
 * ── The seam with the worker ──────────────────────────────────────────────
 * `descriptor.terrain` is handed to `genPool.run('terrain', { field: 'planet',
 * params })` and crosses `postMessage` verbatim. It therefore contains no
 * functions, no class instances and no `three` types - `definePlanet` refuses
 * a descriptor that does, because the failure mode is silent: a closure clones
 * to `undefined` and the planet comes back flat with nothing in the console.
 *
 * ── The mesh and the collider are the same grid ───────────────────────────
 * One `sampleTerrain` job produces both the drawn positions and the collision
 * heights, from one evaluation of one function. This is not an optimisation. It
 * is the fix for the defect that shaped Citadel: three separate approximations
 * of one slope were allowed to disagree, and where the collision sat below the
 * mesh the player walked *underneath* the visible world across 7% of the map.
 *
 * ── What a planet publishes ───────────────────────────────────────────────
 *   `this.planet`        the descriptor, frozen
 *   `this.groundAt(x,z)` the one height function, for anything that needs it
 *   `this.landingSites`  [{ id, name, position, radius, yaw, primary }]
 *   `this.mineralNodes`  [{ id, type, name, position, credits, size }]
 *   `this.gravity`       m/s^2, for the flight model when it lands
 * These are the contract with the flight, mining and HUD systems, and they are
 * the same shape for every planet by construction.
 */

/* Module-level scratch. Nothing below allocates inside a loop or a frame. */
const _v = new THREE.Vector3();
const _m4 = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _e = new THREE.Euler();
const _s = new THREE.Vector3();
const _col = new THREE.Color();
const _colB = new THREE.Color();

/** `0xrrggbb` -> `[r, g, b]` sRGB bytes. @see PlanetWorld._rgba */
const rgb8 = (hex) => [((hex ?? 0) >> 16) & 255, ((hex ?? 0) >> 8) & 255, (hex ?? 0) & 255];
/** Linear blend of two sRGB byte triples. */
const mix8 = (a, b, t) => [
  Math.round(a[0] + (b[0] - a[0]) * t),
  Math.round(a[1] + (b[1] - a[1]) * t),
  Math.round(a[2] + (b[2] - a[2]) * t),
];

/**
 * THE BRIGHTEST AN ORE SWATCH IS ALLOWED TO BE, AS AN sRGB CHANNEL.
 *
 * ── THE DEFECT ─────────────────────────────────────────────────────────────
 * A Sulfur Crust node was reported as "a flat, unshaded, fully saturated yellow
 * polyhedron with no shading variation at all... untextured placeholder
 * geometry", sitting in a scene that was otherwise correctly lit. It was neither
 * unshaded nor untextured: it was BLEACHED. Cinder's sun is a directional at
 * intensity 6.4 and the frame is graded through ACES at exposure 1.22, and
 * sulfur's swatch (`0xd9c341`, brightest channel 0.851) puts every facet of the
 * node so far up the tone curve's shoulder that a facet at full incidence and
 * one at half incidence resolve to the same pixel.
 *
 * ── MEASURED, WITH A CONTROL ───────────────────────────────────────────────
 * `.probe/mineral-sweep.mjs` stands at a real node, masks the ore's exact
 * pixels by hiding the mesh and differencing the frame, and reports the ratio
 * of the 75th to the 25th percentile of luminance across them - "how much
 * lighter is a lit facet than a shaded one", which is precisely the complaint.
 * TEPHRA IS THE CONTROL: it is the ore in the same screenshot that already read
 * as a lit solid, and it measures x1.55.
 *
 *      ore          shipped            with this ceiling
 *      sulfur       x1.22  sat 0.61    x1.50  sat 0.73     <- the report
 *      rheniite     x1.09  sat 0.04    x1.15  sat 0.20     <- was rendering WHITE
 *      iridite      x1.26  sat 0.56    x1.29  sat 0.61
 *      tephra       x1.55  sat 0.46    x1.55  sat 0.46     <- untouched
 *      obsidian     x1.20  sat 0.65    x1.19  sat 0.65     <- untouched
 *      ferrobasalt  x2.25  sat 0.18    x2.23  sat 0.18     <- untouched
 *
 * 0.48 is the value at which the reported ore's facet spread reaches the ore
 * that already worked. It is not a guess and it is not a taste: it is one
 * measurement against one control.
 *
 * ── WHY A CEILING AND NOT A MULTIPLY ───────────────────────────────────────
 * Because three of the six swatches are already dark. Tephra's brightest
 * channel is 0.29 and obsidian's is 0.125; a blanket multiply would take the
 * one ore that reads correctly and the one that is deliberately near-black and
 * push both into mud. A ceiling is a no-op on everything below it - which is
 * exactly the three rows above that do not move - and only pulls down the
 * swatches that were never going to survive the grade.
 *
 * ── THE PER-ORE COLOURS STILL DO THEIR JOB. BETTER, IN FACT. ───────────────
 * Scaling all three channels by one factor leaves the hue and the channel
 * ratios untouched, so an ore is still identified by its colour - and because
 * ACES desaturates as it clips toward white, taking the value DOWN takes the
 * chroma UP: sulfur's measured saturation goes 0.61 -> 0.73 and rheniite's, the
 * one that was rendering as a white blob with no hue at all, goes 0.04 -> 0.20.
 * The rendered node ends up NEARER the swatch the descriptor wrote, not further
 * from it. `spec.color` and `spec.glow` are read exactly as before and the
 * emissive is untouched, so the glow tiers still glow.
 */
const ORE_ALBEDO_CEIL = 0.48;

/**
 * A mineral swatch, capped for the grade. @see ORE_ALBEDO_CEIL
 *
 * The scale is applied in sRGB, which is the space the descriptor's hex was
 * written in, so "half as bright" means what an author looking at the swatch
 * would expect it to mean.
 *
 * @param {number} hex the descriptor's `0xrrggbb`
 * @returns {THREE.Color} a colour in the renderer's working space
 */
function oreAlbedo(hex) {
  const [r, g, b] = rgb8(hex).map((v) => v / 255);
  const mx = Math.max(r, g, b);
  /* `mx > 0` guards a pure-black swatch: 0/0 is NaN, and a NaN albedo is the
   * failure this project has already paid for once - 19 NaN pixels through the
   * bloom pass blacked out a whole frame. */
  const k = mx > ORE_ALBEDO_CEIL ? ORE_ALBEDO_CEIL / mx : 1;
  return new THREE.Color().setRGB(r * k, g * k, b * k, THREE.SRGBColorSpace);
}

/** Ash motes drifting past the camera. One `Points`, animated in the shader. */
const ASH_VERT = /* glsl */`
  uniform float uTime;
  uniform vec3 uEye;
  uniform float uBox;
  uniform vec2 uDrift;
  uniform float uSize;
  attribute float aSeed;
  varying float vA;
  void main() {
    /* Every mote lives in a box that follows the camera and wraps with mod(),
     * so a few thousand of them cover an 800 m map without a single one being
     * respawned on the CPU. Fall speed and drift come off the seed. */
    float fall = 1.6 + aSeed * 3.4;
    vec3 p = position;
    p.x = mod(p.x + uTime * uDrift.x - uEye.x + uBox * 0.5, uBox) + uEye.x - uBox * 0.5;
    p.z = mod(p.z + uTime * uDrift.y - uEye.z + uBox * 0.5, uBox) + uEye.z - uBox * 0.5;
    p.y = mod(p.y - uTime * fall - uEye.y + uBox * 0.5, uBox) + uEye.y - uBox * 0.5;
    vec4 mv = modelViewMatrix * vec4(p, 1.0);
    float d = length(mv.xyz);
    vA = clamp(1.0 - d / (uBox * 0.5), 0.0, 1.0);
    gl_PointSize = uSize * (300.0 / max(d, 1.0));
    gl_Position = projectionMatrix * mv;
  }
`;
const ASH_FRAG = /* glsl */`
  uniform vec3 uColor;
  uniform float uOpacity;
  varying float vA;
  void main() {
    vec2 d = gl_PointCoord - 0.5;
    float a = clamp(1.0 - dot(d, d) * 4.0, 0.0, 1.0);
    a *= a * vA * uOpacity;
    if (a < 0.004) discard;
    gl_FragColor = vec4(uColor, a);
  }
`;

export class PlanetWorld extends World {
  static id = 'planet';
  static displayName = 'Planet Surface';
  /** The descriptor this subclass renders. Set by `PlanetWorld.of`. */
  static planet = null;

  /**
   * Stamp a registerable World subclass for one planet.
   *
   * `WorldManager` keys everything on `static id`, so a planet needs a class
   * with its own id - but it does not need its own CODE, and this is the whole
   * difference. The subclass is four static fields.
   *
   * @param {Readonly<object>} descriptor from `definePlanet`
   * @returns {typeof PlanetWorld}
   */
  static of(descriptor) {
    return class extends PlanetWorld {
      static id = descriptor.id;
      static displayName = descriptor.name;
      static planet = descriptor;
    };
  }

  constructor(ctx) {
    super(ctx);
    const P = this.constructor.planet;
    if (!P) throw new Error('[PlanetWorld] use PlanetWorld.of(descriptor) - the base class renders nothing');
    this.planet = P;
    this.gravity = P.gravity;

    /** The one height function. Everything that asks the ground a question
     *  asks this, including the generation worker (by name). */
    this.groundAt = HEIGHT_FIELDS.planet(P.terrain);
    /** Collision cell size. Slope filters are measured over it - see Placement. */
    this.cell = (P.half * 2) / P.seg;

    /** @type {Array<{id:string,name:string,position:THREE.Vector3,radius:number,yaw:number,primary:boolean}>} */
    this.landingSites = [];
    /** @type {Array<{id:string,type:string,name:string,position:THREE.Vector3,credits:number,size:number}>} */
    this.mineralNodes = [];
    /** Build-time census, reported by the tests and the console. */
    this.census = { props: {}, minerals: {}, colliders: 0, drawCalls: 0, triangles: 0 };

    this.rules = makeRules({
      /* A planet surface is a wilderness. Nothing that belongs to a settlement
       * belongs here, and switching them on would have the crowd system fill
       * 640,000 m2 of ash with traders. */
      merchants: false,
      quests: false,
      contracts: false,
      races: false,
      interiors: false,
      crowd: false,
      swim: false,
      /* Caches and relics OFF, and this is a look bug as much as a design one.
       * Both systems scatter their own sites without asking the world where the
       * ground, the lava or the cliffs are, and with them on a review screenshot
       * of the caldera came back with thirty amber pickups strung across the
       * flank like fairy lights. A wilderness has no supply caches and no
       * collectible relics in it: the MINERALS are what is collectible here, and
       * they are placed against the real height field. */
      caches: false,
      relics: false,
      /* Mounts off: a horse on a volcano is a joke the player did not make.
       * The ship is the mount here. */
      mounts: false,
      /* Loot stays ON: it is the drop path a mined node will use. */
    });

    this.bounds = new THREE.Box3(
      new THREE.Vector3(-P.half, -60, -P.half),
      new THREE.Vector3(P.half, 260, P.half)
    );

    const sky = P.sky ?? {};
    const sunDir = new THREE.Vector3(...(sky.sun?.direction ?? [-0.5, 0.4, -0.7])).normalize();
    this.environment = {
      ...this.environment,
      background: new THREE.Color(sky.background ?? 0x101010),
      fogColor: new THREE.Color(sky.fog?.color ?? sky.background ?? 0x101010),
      fogNear: sky.fog?.near ?? 60,
      fogFar: sky.fog?.far ?? 600,
      exposure: sky.exposure ?? 1.0,
      ambientColor: new THREE.Color(sky.ambient?.color ?? 0x404040),
      ambientIntensity: sky.ambient?.intensity ?? 0.5,
      sunColor: new THREE.Color(sky.sun?.color ?? 0xffffff),
      sunIntensity: sky.sun?.intensity ?? 2.2,
      sunDirection: sunDir,
      envMapIntensity: sky.envMapIntensity ?? 1.0,
      bloom: sky.bloom ?? null,
      grade: sky.grade ?? null,
    };

    /** Everything this world owns and must dispose. */
    this._owned = [];
    this._sky = null;
    this._liquidUniforms = null;
    this._plumes = [];
    this._ash = null;
    this._t = 0;
  }

  _own(x) { if (x) this._owned.push(x); return x; }

  /* ================================================================== */
  /* Build                                                              */
  /* ================================================================== */

  async build(onProgress) {
    const P = this.planet;
    onProgress?.(0.04, `Entering ${P.name}`);
    this._buildSky();

    onProgress?.(0.10, 'Sampling the surface');
    await this._buildTerrain();

    onProgress?.(0.52, 'Pouring the flows');
    this._buildLiquid();

    onProgress?.(0.62, 'Scattering');
    this._buildProps();

    onProgress?.(0.82, 'Seeding deposits');
    this._buildMinerals();

    onProgress?.(0.90, 'Marking the pads');
    this._buildLandingSites();

    onProgress?.(0.96, 'Air');
    this._buildAtmosphere();

    this._publish();
    onProgress?.(1, P.name);

    console.info(
      `[PlanetWorld] ${P.id}: ${this.census.triangles.toLocaleString()} tris in `
      + `${this.census.drawCalls} draws, ${this.census.colliders} colliders, `
      + `${this.mineralNodes.length} mineral nodes, ${this.landingSites.length} landing sites`
      + (this.census.liquid
        ? `, ${this.census.liquid.kind} over ${this.census.liquid.wetCells}/${this.census.liquid.cells} cells `
          + `walled by ${this.census.liquid.barrierPosts} posts on ${this.census.liquid.barrierRuns} runs, `
          + `${this.census.liquid.parapet} m over the bank (leap apex ${this.census.liquid.leapApex} m), `
          + `worst gate ${this.census.liquid.worstGate} m, tallest +${this.census.liquid.tallestAboveWater} m over the water`
          + (this.census.liquid.clampedPosts ? `, ${this.census.liquid.clampedPosts} clamped at ${WALL_MAX} m` : '')
          + (this.census.liquid.lethal ? ' (lethal)' : '')
        : '')
    );
  }

  /* ------------------------------------------------------------------ */

  /**
   * The dome.
   *
   * `environment.background` is a flat colour, which reads as a void behind a
   * skyline rather than as air - and a planet is looked ACROSS more than
   * anything else in this game. The dome costs one draw call and gives the
   * horizon a haze band for the caldera to stand against.
   */
  _buildSky() {
    const sky = this.planet.sky ?? {};
    const params = { ...(sky.params ?? {}) };
    if (Array.isArray(params.sunDirection)) params.sunDirection = new THREE.Vector3(...params.sunDirection);
    params.radius = params.radius ?? Math.max(1500, this.planet.half * 4);
    /* THE DOME RIDES THE CAMERA, and it could not come from the descriptor.
     *
     * `Sky.update` re-centres the dome on `params.camera` every frame - that is
     * the only thing that makes a dome read as infinitely far away - and
     * `SpaceWorld._buildSky` passes it. This one could not: `definePlanet`
     * rejects class instances, so a live `THREE.Camera` cannot be a field of a
     * frozen planet descriptor. It has to be added here, where the engine is.
     *
     * Without it the dome was pinned wherever the camera happened to be at the
     * frame `activate` resolved - which on the descent seam is the chase camera
     * hundreds of metres up and offset from the pad. Measured: moving the
     * camera 990 m moved the space dome 707.11 m and moved this one 0.00.
     * `VOLCANIC.half` is 400 so the dome is 1600 m in radius, a legal walk to
     * the corner of the playfield is 566 m, and the horizon therefore swung
     * 20.7 degrees while the player walked - with `sky.material.fog === false`
     * so nothing hid it. */
    params.camera = params.camera ?? this.engine?.camera ?? null;
    const built = createSky(sky.kind ?? 'daylight', params);
    built.mesh.name = `planet:sky:${this.planet.id}`;
    this.group.add(built.mesh);
    this._sky = built;
    this.census.drawCalls++;
  }

  /**
   * The ground: one worker job, one mesh, one heightfield collider.
   *
   * The vertex colours are computed here rather than in the job because they
   * are the only part of the surface that needs `three` - and because the job
   * already returns everything they are derived from (heights and normals), so
   * this is a pass over buffers rather than a second evaluation of the height
   * function.
   */
  async _buildTerrain() {
    const P = this.planet;
    const N = P.seg + 1;
    const size = P.half * 2;

    const t = await genPool.run('terrain', {
      field: 'planet',
      params: P.terrain,
      originX: -P.half,
      originZ: -P.half,
      size,
      seg: P.seg,
      uv: 'unit',
      normals: true,
    });

    /* NaN propagates through bloom and blacks out the entire frame - 19 bad
     * pixels took out 921,600 in this repo once. The height function is data
     * driven, so a descriptor with a zero radius or a divide by a taper of 1
     * would reach the shader as NaN rather than as a thrown error. Checked once,
     * over the samples that actually got made. */
    if (!Number.isFinite(t.minY) || !Number.isFinite(t.maxY)) {
      throw new Error(`[PlanetWorld] ${P.id} terrain produced non-finite heights (min ${t.minY}, max ${t.maxY})`);
    }

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(t.positions, 3));
    geo.setAttribute('normal', new THREE.BufferAttribute(t.normals, 3));
    geo.setAttribute('uv', new THREE.BufferAttribute(t.uvs, 2));
    geo.setAttribute('color', new THREE.BufferAttribute(this._terrainColors(t, N), 3));
    geo.setIndex(new THREE.BufferAttribute(t.indices, 1));
    geo.computeBoundingSphere();
    this._own(geo);

    /* Tiled off the library's own key so texel density is the same on the
     * crater wall and the ash plain. Cloned, not shared: the terrain runs with
     * `vertexColors` on and the library material does not. */
    const tile = P.palette.tile ?? 6;
    const repeat = size / tile;
    const mat = this.materials.get(`${P.palette.material}:${repeat}`).clone();
    mat.name = `planet.${P.id}.ground`;
    mat.vertexColors = true;
    mat.color = new THREE.Color(0xffffff);
    this._own(mat);

    const ground = new THREE.Mesh(geo, mat);
    ground.name = `planet:${P.id}:terrain`;
    ground.receiveShadow = true;
    ground.castShadow = false;
    this.group.add(ground);
    this.census.drawCalls++;
    this.census.triangles += t.indices.length / 3;

    /* ONE collider for the whole surface, on the same samples the mesh drew.
     * @see the header: this is the fix for "collision below mesh", made true by
     * construction rather than by rounding upward. */
    this.track(this.physics.addHeightfield({
      heights: t.heights,
      nx: N,
      nz: N,
      originX: -P.half,
      originZ: -P.half,
      stepX: size / P.seg,
      stepZ: size / P.seg,
    }));
    this.census.colliders++;
    this._terrainMinY = t.minY;
    this._terrainMaxY = t.maxY;

    /* THE BED, kept for the liquid.
     *
     * The same `t.heights` the mesh was drawn from and the collider registered
     * with - not a re-evaluation. Everything downstream that asks "how deep is
     * the water here" or "is this cell under the water" reads this, so the
     * shader's depth term, the shore barrier and the minimap's land are all
     * measuring the same surface the player stands on. */
    this._bed = {
      heights: t.heights,
      nx: N,
      nz: N,
      originX: -P.half,
      originZ: -P.half,
      stepX: size / P.seg,
      stepZ: size / P.seg,
    };
  }

  /**
   * The terrain height field as a texture the liquid shader can read.
   *
   * One channel, half-float, nearest-to-linear filtered, no mipmaps. Half
   * rather than full float because linear filtering of a 32-bit texture is an
   * extension in WebGL2 and of a 16-bit one is not - and because at the
   * magnitudes a planet's terrain reaches (Shoal's bed runs -60 to 76) a half
   * float resolves better than 6 cm, which is far finer than a colour ramp can
   * show.
   *
   * NON-FINITE IS FATAL HERE, not clamped. A single NaN in this texture is a
   * NaN depth, a NaN `mix`, and 19 such pixels have already taken out a
   * 921,600-pixel frame in this project by way of the bloom pass. The terrain
   * job's own min/max check upstream would not catch it: `Math.min` with a NaN
   * argument does not necessarily propagate.
   */
  _bedTexture() {
    const bed = this._bed;
    if (!bed) return null;
    if (!(bed.stepX > 0) || !(bed.stepZ > 0)) {
      throw new Error(`[PlanetWorld] ${this.planet.id} bed step must be positive (${bed.stepX} x ${bed.stepZ})`);
    }
    const h = bed.heights;
    const data = new Uint16Array(h.length);
    for (let i = 0; i < h.length; i++) {
      const v = h[i];
      if (!Number.isFinite(v)) {
        throw new Error(`[PlanetWorld] ${this.planet.id} bed sample ${i} is ${v} - a non-finite depth reaches the shader as a NaN pixel`);
      }
      data[i] = THREE.DataUtils.toHalfFloat(v);
    }
    const tex = new THREE.DataTexture(data, bed.nx, bed.nz, THREE.RedFormat, THREE.HalfFloatType);
    tex.name = `planet.${this.planet.id}.bed`;
    tex.minFilter = THREE.LinearFilter;
    tex.magFilter = THREE.LinearFilter;
    tex.wrapS = THREE.ClampToEdgeWrapping;
    tex.wrapT = THREE.ClampToEdgeWrapping;
    tex.generateMipmaps = false;
    tex.needsUpdate = true;
    this._own(tex);
    return { texture: tex, ...bed };
  }

  /**
   * Per-vertex ground colour: height bands, a slope override and a mottle.
   *
   * Three terms, and each one is answering a specific way procedural terrain
   * fails to read:
   *
   *   BANDS   give the eye a height cue. Without them a 158 m caldera and a
   *           12 m plain are the same colour and the silhouette disappears
   *           into the haze.
   *   SLOPE   puts bare rock on anything steep. This is what separates a cliff
   *           from a hill at any distance, and it is free here because the job
   *           already returned the normals.
   *   MOTTLE  large-scale drift, so the bands do not print as a contour map.
   *           The one term with no physical justification and the one that does
   *           the most work.
   */
  _terrainColors(t, N) {
    const pal = this.planet.palette;
    const bands = pal.bands;
    const out = new Float32Array(N * N * 3);
    const slope = pal.slope ?? null;
    const mottle = pal.mottle ?? null;
    const mInv = mottle ? 1 / mottle.scale : 0;
    if (mottle) _colB.setHex(mottle.color);
    const slopeFrom = slope ? Math.cos((slope.fromDeg * Math.PI) / 180) : 0;
    const slopeTo = slope ? Math.cos((slope.toDeg * Math.PI) / 180) : 0;

    for (let i = 0; i < N * N; i++) {
      const y = t.heights[i];
      // Bands: find the pair this height falls between and lerp.
      let bi = 0;
      while (bi < bands.length - 1 && y > bands[bi].upTo) bi++;
      const lo = bands[Math.max(0, bi - 1)];
      const hi = bands[bi];
      const span = hi.upTo - (bi > 0 ? lo.upTo : hi.upTo - 1);
      const f = bi > 0 ? Math.max(0, Math.min(1, (y - lo.upTo) / (span || 1))) : 1;
      _col.setHex(lo.color).lerp(_colB.setHex(hi.color), f);

      if (slope) {
        const ny = t.normals[i * 3 + 1];
        // ny falls as the surface steepens: cos(from) down to cos(to).
        const s = Math.max(0, Math.min(1, (slopeFrom - ny) / Math.max(1e-6, slopeFrom - slopeTo)));
        if (s > 0) _col.lerp(_colB.setHex(slope.color), s);
      }
      if (mottle) {
        /* The SAME fbm the ground is made of, not a sine.
         *
         * The first version was `sin(x) + cos(z)`, which is a regular standing
         * wave: on an 800 m ash plain it produced a corduroy nobody could name
         * and the plain read as one flat colour anyway. Three octaves of the
         * height field's own noise gives patches with edges, which is what
         * oxidised ash looks like from eye level - and it costs one call to a
         * function that is already in the module graph. */
        const x = t.positions[i * 3];
        const z = t.positions[i * 3 + 2];
        const n = fbm(x * mInv, z * mInv, 5501, 3);
        _col.lerp(_colB.setHex(mottle.color), n * n * mottle.amount);
      }
      out[i * 3] = _col.r;
      out[i * 3 + 1] = _col.g;
      out[i * 3 + 2] = _col.b;
    }
    return out;
  }

  /** Lava, water, methane - whatever the descriptor pours. */
  _buildLiquid() {
    const L = this.planet.liquid;
    if (!L) return;
    /* The bed texture is built only when the depth term will use it, so a lava
     * planet allocates nothing. `liquidDepth` decides; see `PlanetLiquid`. */
    const wantsDepth = liquidDepth(L).amount > 0;
    const bed = wantsDepth ? this._bedTexture() : null;
    const { material, uniforms, depth } = createLiquidMaterial(L, bed);
    this._liquidDepth = depth;
    const skirtMat = createSkirtMaterial(L);
    this._own(material);
    this._own(skirtMat);
    this._liquidUniforms = uniforms;

    const g = new THREE.Group();
    g.name = `planet:${this.planet.id}:liquid`;
    this.group.add(g);

    L.bodies.forEach((b, i) => {
      const { surface, skirt } = bodyGeometry(b);
      this._own(surface);
      this._own(skirt);
      const sm = new THREE.Mesh(surface, material);
      sm.name = `liquid:${i}`;
      sm.receiveShadow = false;
      sm.castShadow = false;
      g.add(sm);
      const sk = new THREE.Mesh(skirt, skirtMat);
      sk.name = `liquid:${i}:skirt`;
      sk.castShadow = false;
      sk.receiveShadow = true;
      g.add(sk);
      this.census.drawCalls += 2;
      this.census.triangles += (surface.index ? surface.index.count : surface.attributes.position.count) / 3
        + (skirt.index ? skirt.index.count : skirt.attributes.position.count) / 3;
    });

    /* ONE point light, on the body the descriptor names. `RIG_BUDGET.point` is
     * twelve for the whole game and every one of them is compiled into every
     * shader; a light per lava body would charge the entire boot for a glow the
     * emissive already provides. */
    const gl = L.glowLight;
    if (gl) {
      const b = L.bodies[gl.body ?? 0];
      const light = new THREE.PointLight(gl.color ?? 0xff7a2a, gl.intensity ?? 30, gl.distance ?? 120, 1.8);
      light.castShadow = false;
      light.position.set(b.x ?? b.pts[0][0], (b.y ?? b.y0) + 6, b.z ?? b.pts[0][1]);
      light.name = 'planet:liquid:glow';
      g.add(light);
    }

    this._buildLiquidBarrier(L);
  }

  /**
   * THE SHORE BARRIER - the thing that makes the liquid real.
   *
   * ═══════════════════════════════════════════════════════════════════════
   *  WHAT WAS WRONG
   * ═══════════════════════════════════════════════════════════════════════
   * `_buildLiquid` drew meshes and never touched `this.physics`. `swim` is
   * false, and `WaterVolumes` never saw planet liquid either - the material
   * name `planet.liquid` misses its `WATERISH` regex, and its scan is gated on
   * `allows(world, 'swim')` anyway. So a planet's liquid was neither swimmable
   * nor solid: the shipped game let a player walk down the beach and along the
   * SEA BED, under an opaque ceiling, in full daylight.
   *
   * Every reachability probe in this repo models liquid as a wall
   * (`planet-reach.test.mjs`'s `lavaMask`, `planet-minerals.test.mjs`). The
   * renderer did not. That gap is this project's signature defect class -
   * "tested that it was BUILT, never that a player can REACH it" - running
   * backwards: the test was right and the world was wrong.
   *
   * ═══════════════════════════════════════════════════════════════════════
   *  WHY A FENCE AT THE WATERLINE AND NOT THE OTHER TWO OPTIONS
   * ═══════════════════════════════════════════════════════════════════════
   *
   * SWIMMING was refused first, and not on taste. Wiring planet liquid into
   * `WaterVolumes` needs `swim: true`, and the probes that model liquid as a
   * wall would then all be wrong - `Shoal.js` is designed around the walkable
   * world being exactly the ground above its sea, with one island severed on
   * purpose so it can only be flown to. Making the sea swimmable makes every
   * one of those decisions false, and there is no reading of "the probes and
   * the renderer must agree" where the renderer wins that argument.
   *
   * A SOLID SURFACE AT THE LIQUID PLANE - the obvious reading of "make it
   * solid" - is what the geometry actually refuses. Fill a body from its bed up
   * to its surface and a beach becomes a ramp onto a dead-flat floor at the
   * waterline: the player is not stopped at the shore, they walk out onto the
   * sea. On Cinder they would walk onto the lava. Anything that stops a body at
   * the water's edge has to stand ABOVE the water, which is a wall.
   *
   * LETHAL is the right long-term answer for lava and it is not available:
   * `liquid.lethal` is in the schema, the descriptor docs say it is there "so
   * the day it turns true nothing has to be re-plumbed", and NOTHING IN THE
   * BUILD READS IT - not this file, not `Placement`, not a system. It is false
   * on every descriptor, a world has no reference to the player to damage, and
   * both are outside this change. It is reported rather than faked.
   *
   * ═══════════════════════════════════════════════════════════════════════
   *  HOW IT IS BUILT
   * ═══════════════════════════════════════════════════════════════════════
   * `liquidCellMask` marks every terrain cell whose ground sits below its
   * liquid surface plus `LIQUID_EDGE` - the SAME 0.6 m the probes use, so the
   * two agree by construction rather than by coincidence. `liquidShoreCells`
   * keeps the wet cells that touch dry ground; runs of them along a row are
   * merged into one box, which roughly halves the count on a diagonal shore.
   *
   * BOXES, not a second heightfield. A heightfield is solid from its surface
   * DOWN and `Physics._closestPoint` recovers anything under it by pushing
   * straight up, so a raised field at the waterline would launch the player on
   * top of its own parapet - the fence would be a staircase. A box projects to
   * its nearest face instead, which for a tall thin one is sideways: the player
   * is pushed back the way they came, which is what "stopped at the shore"
   * means.
   *
   * THE PARAPET SCALES WITH GRAVITY. `jumpVelocity` is 6.4 and the player's
   * gravity on a planet is `22 * (planet.gravity / 9.81)`, so the apex is
   * 0.93 m on Cinder and 5.6 m on a moon. A fixed 2 m wall would be a hurdle
   * on half of Phase 2's planets.
   */
  _buildLiquidBarrier(L) {
    const bed = this._bed;
    if (!bed || !L?.bodies?.length) return;
    const P = this.planet;

    const segments = liquidContour({ liquid: L, ...bed, sub: WALL_SUB });
    const runs = liquidWalls(segments);
    const mask = liquidCellMask({ liquid: L, ...bed });
    if (!runs.length) return;

    /* THE GROUND THE COLLIDER IS, not the ground the descriptor describes.
     *
     * `this.groundAt` is the analytic height field; `bed.heights` is the buffer
     * the collision heightfield was actually built from, and `liquidContour`
     * marches the waterline over exactly this interpolation. Sampling the buffer
     * keeps the wall, the contour and the surface the player stands on on one
     * set of numbers - and it is an array read rather than an fbm evaluation,
     * which matters at 32 samples on each of Shoal's 3,122 posts. */
    const bedAt = (x, z) => {
      const fx = (x - bed.originX) / bed.stepX;
      const fz = (z - bed.originZ) / bed.stepZ;
      const i = Math.max(0, Math.min(bed.nx - 2, Math.floor(fx)));
      const j = Math.max(0, Math.min(bed.nz - 2, Math.floor(fz)));
      const tx = Math.max(0, Math.min(1, fx - i));
      const tz = Math.max(0, Math.min(1, fz - j));
      const h = bed.heights;
      const a = h[j * bed.nx + i];
      const b = h[j * bed.nx + i + 1];
      const c = h[(j + 1) * bed.nx + i];
      const d = h[(j + 1) * bed.nx + i + 1];
      return (a + (b - a) * tx) * (1 - tz) + (c + (d - c) * tx) * tz;
    };

    /* THE CLEARANCE IS SIZED FROM THIS PLANET'S OWN RUNNING LEAP, and the
     * clearance is what makes the wall a gate rather than a hurdle. It is the
     * height above the ground A BODY STANDS ON, not above the water.
     * @see the design block on LEAP_LIFT at the top of this file
     * @see scripts/tests/planet-envelope.test.mjs SLOPE */
    const ratio = worldGravityRatio(P) ?? 1;
    /* `Player`'s closed form, with `Player`'s scaling: jumpVelocity scales as
     * `ratio^(1/3)` and gravity as `ratio`, so the apex goes as `ratio^(-1/3)`. */
    const apexStand = ((6.4 * 6.4) / (2 * 22)) * Math.pow(Math.max(1e-3, ratio), -1 / 3);
    const apexLeap = apexStand * LEAP_LIFT * LEAP_LIFT;
    /* THE TWO REACHES ADD. See the design block: the mantle is offered on the
     * jump press and measures its rise from the feet, so a body that jumps first
     * mantles a ledge one apex higher than a body that does not. */
    const clearance = apexLeap + MANTLE_MAX + GATE_MARGIN;
    const inset = POST_HALF - WALL_BIAS;

    let posts = 0;
    let tallest = 0;
    let clamped = 0;
    let minGate = Infinity;
    for (const run of runs) {
      /* Down past the ground the post stands on, so nothing steps under it,
       * and no further: on a cliff shore the bed is tens of metres down and an
       * unclamped post would be a column of invisible solid in open water. */
      const bottom = Math.max(run.surf - 40, Math.min(run.ground, run.surf) - 2.5);

      const n = Math.max(1, Math.ceil(run.len / POST_SPAN));
      for (let k = 0; k < n; k++) {
        /* Posts sit at the midpoints of `n` equal parts of the run, so the end
         * ones are half a span inside it and consecutive runs meet without a
         * post landing twice on the same join. */
        const t = (k + 0.5) / n - 0.5;
        const px = run.cx + run.ux * run.len * t + run.nx * inset;
        const pz = run.cz + run.uz * run.len * t + run.nz * inset;

        /* THE LAUNCH PAD, per post rather than per run. `run.ground` is the
         * LOWEST ground the run spans AT THE CONTOUR, which is the right number
         * for the post's footing and the wrong one for its top: a 14 m run can
         * have a beach at one end and a bank two metres higher at the other, and
         * the leap comes off whichever is higher. */
        let bank = run.surf;
        for (let bi = 0; bi < LAND_BEARINGS; bi++) {
          const a = (bi / LAND_BEARINGS) * Math.PI * 2;
          const ca = Math.cos(a);
          const sa = Math.sin(a);
          for (const back of LAND_PROBE) {
            const g = bedAt(px + ca * back, pz + sa * back);
            if (Number.isFinite(g) && g > bank) bank = g;
          }
        }
        const stand = Math.max(run.surf, bank);
        const wanted = stand + clearance;
        const top = Math.min(wanted, run.surf + WALL_MAX);
        if (top < wanted - 1e-6) clamped++;
        if (!(top > bottom)) continue;
        const gate = top - stand;
        if (gate < minGate) minGate = gate;
        if (top - run.surf > tallest) tallest = top - run.surf;

        const hy = (top - bottom) * 0.5;
        const cy = (top + bottom) * 0.5;
        this.track(this.physics.addBox(px, cy, pz, POST_HALF, hy, POST_HALF, {
          /* TAGGED, so an ablation can take the barrier out of a build without
           * rebuilding it. "The barrier costs N ore nodes" is a claim only a
           * flood with and without these boxes can make, and the first version
           * of it cost eleven of Verdigris's twenty malachite.
           * @see .probe/planet-flood.mjs */
          userData: { planetLiquidBarrier: true },
        }));
        posts++;
      }
    }

    this.census.colliders += posts;
    this.census.liquid = {
      kind: liquidKind(L),
      wetCells: mask.wetCount,
      cells: mask.cx * mask.cz,
      contourSegments: segments.length,
      barrierRuns: runs.length,
      barrierPosts: posts,
      /* `parapet` KEEPS ITS NAME AND CHANGES ITS MEANING, deliberately: it is
       * now the clearance over the ground a body leaps from rather than over the
       * water, which is the number that decides whether the wall holds. The two
       * extra rows are what the old single number hid - how far the wall stands
       * proud of the water at its tallest, and the WORST gate anywhere on it,
       * which is the one a test should assert on. */
      parapet: Number(clearance.toFixed(2)),
      leapApex: Number(apexLeap.toFixed(3)),
      tallestAboveWater: Number(tallest.toFixed(2)),
      worstGate: Number.isFinite(minGate) ? Number(minGate.toFixed(2)) : null,
      clampedPosts: clamped,
      /* Reported because nothing reads `liquid.lethal` yet and a false that
       * nobody can see is how a flag stays dormant for another nine planets. */
      lethal: !!L.lethal,
    };
  }

  /** Every prop field the descriptor asks for. One draw call each. */
  _buildProps() {
    const P = this.planet;
    const rockMat = this._propMaterial();
    let seed = (P.terrain.seed ?? 1) ^ 0x7f4a;
    for (const spec of P.props) {
      seed = (seed * 1664525 + 1013904223) >>> 0;
      const built = buildPropField(spec, {
        height: this.groundAt,
        half: P.half,
        slopeStep: this.cell,
        seed,
        liquid: P.liquid,
        landing: P.landing,
        material: rockMat,
        physics: this.physics,
        group: this.group,
        track: (c) => this.track(c),
      });
      this._own(built.geo);
      /* A field with a `glow` builds its own material off the shared rock (see
       * `PlanetProps.buildPropField`); the shared one is already owned, so own
       * only the clone or the planet leaks one material per visit. */
      if (built.material !== rockMat) this._own(built.material);
      this.census.props[spec.id] = { placed: built.placed, requested: built.requested, colliders: built.colliders };
      this.census.colliders += built.colliders;
      this.census.drawCalls++;
      const idx = built.mesh.geometry.index;
      this.census.triangles += ((idx ? idx.count : built.mesh.geometry.attributes.position.count) / 3) * built.placed;

      // Vent fields get their steam. The plume field is driven off the same
      // points, so a vent without a plume is not expressible.
      if (spec.kind === 'vents' && built.points.length) {
        const plumes = buildPlumes(built.points, {
          perVent: 5,
          height: (spec.size?.plumeMax ?? 16),
          /* Grey-brown and thin. A near-white plume at 0.26 was the brightest
           * thing in the frame after the lava and the bloom pass turned each
           * puff into a hard white ball. Steam over ash is dirty. */
          color: P.hazards?.steamColor ?? 0x7d6a5e,
          opacity: 0.15,
        });
        this.group.add(plumes.mesh);
        this._plumes.push(plumes);
        this._own(plumes.geometry);
        this._own(plumes.material);
        this.census.drawCalls++;
      }
    }
  }

  /** Shared rock material for every prop family. One clone, `vertexColors` on
   *  for the per-instance tint. */
  _propMaterial() {
    if (this._propMat) return this._propMat;
    const m = this.materials.get('stone.castle:1.4').clone();
    m.name = `planet.${this.planet.id}.rock`;
    m.vertexColors = true;
    m.color = new THREE.Color(0xffffff);
    this._own(m);
    this._propMat = m;
    return m;
  }

  /**
   * Mineral deposits.
   *
   * Each node is a small cluster of faceted crystals, instanced per mineral
   * type. They do NOT collide: a node is 1.3 m across and the player has to be
   * able to stand on it to work it. A box collider on a thing you are meant to
   * walk up to is the same defect as a door you cannot enter, one size smaller.
   *
   * ── HOW BIG A NODE LOOKS IS NOT HOW MUCH HOLD IT TAKES ──────────────────
   *
   * It used to be. `spec.size` drove BOTH `holdUnitsFor` and the crystal
   * scale, and the descriptor's own value gradient makes the rare ores the
   * SMALL ones - that is the whole point of them, a cubic metre of iridite is
   * 310 credits where three of tephra are 18. So the most valuable object on
   * the planet was also the least visible: iridite's main crystal came out at
   * `0.62 * 0.55 = 0.34 m`, a pebble, and a tester who flew 62 km and
   * descended to get one wrote that "iridite - the rarest element, the payoff
   * for a 60 km flight and a descent - is a plain grey-brown truncated cone.
   * A lampshade, the same colour as the ground, no glow, no glint, no aura."
   *
   * Rarity is now inversely coupled to hold cost and DIRECTLY coupled to
   * presence, which is the way round a player can act on: a rare seam is a
   * bigger, taller, brighter thing standing in the rock that happens to stow
   * small. `size` is untouched, so every hold, price and load figure in
   * `planet-minerals.test.mjs` and `SpaceObjectives` is exactly what it was.
   */
  _buildMinerals() {
    const P = this.planet;
    let seed = (P.terrain.seed ?? 1) ^ 0x1d0e;
    for (const spec of P.minerals) {
      seed = (seed * 1664525 + 1013904223) >>> 0;
      const res = scatter({
        region: spec.region,
        count: spec.count,
        spacing: spec.spacing ?? 0,
        seed,
        height: this.groundAt,
        half: P.half,
        slopeStep: this.cell,
        liquid: P.liquid,
        landing: P.landing,
      });

      const geo = new THREE.IcosahedronGeometry(1, 0);
      this._own(geo);
      const mat = new THREE.MeshStandardMaterial({
        name: `planet.mineral.${spec.id}`,
        color: oreAlbedo(spec.color),
        emissive: new THREE.Color(spec.glow || 0x000000),
        /* 1.6 -> 3.2 on anything that declares a glow. `GRADE_PRESETS`
         * thresholds bloom on scene-linear luminance, and at 1.6 against a
         * daylit ash plain the emissive was inside the diffuse and the ore
         * did not read as lit at all - which is what "no glow, no glint, no
         * aura" describes. Only the two rare tiers declare `glow`, so this
         * lights exactly the ore the value gradient wants found.
         *
         * ── THAT LAST SENTENCE IS NOT TRUE OF THE SHIPPED DESCRIPTORS ──────
         * Cinder alone declares `glow` on four of six: sulfur (`0x201a04`) and
         * obsidian (`0x2a1038`) as well as iridite and rheniite. So this branch
         * fires on a common ore and an uncommon one too. MEASURED before acting
         * on it (`.probe/mineral-sweep.mjs`): turning sulfur's emissive off
         * moves its facet spread from x1.22 to x1.23 - nothing - so the flat
         * sulfur node was never this line's doing, and it is left alone.
         * Obsidian is the reason it MUST be left alone: its swatch is
         * near-black and its emissive is what carries its colour, so killing it
         * drops obsidian's measured saturation from 0.65 to 0.28.
         * @see ORE_ALBEDO_CEIL for what the flat node actually was. */
        /* 1.6 -> 2.2. At 1.6, against a daylit ash plain, the emissive sat
         * inside the diffuse and the ore did not read as lit at all - which
         * is what "no glow, no glint, no aura" describes. 3.2 was the first
         * try and overshot: driven in a browser, both rare ores saturated to
         * the same cream and iridite's orange and rheniite's cold teal became
         * indistinguishable at arm's length, which throws away the legibility
         * decision `Volcanic.js` records beside rheniite's own colour. 2.2 is
         * the value at which each keeps its hue and still glows. */
        emissiveIntensity: spec.glow ? 2.2 : 0,
        roughness: spec.glow ? 0.28 : 0.66,
        metalness: 0.15,
        flatShading: true,
      });
      this._own(mat);

      /* HOW BIG IT LOOKS. See the note on this method.
       *
       * A multiplier on the DRAWN scale only. Ordered by `MINERAL_RARITY`, so
       * a descriptor that adds a tier gets a sensible default rather than a
       * silent 1.0.
       *
       * 1.0 to 1.9: enough that a tephra nodule and an iridite seam are
       * different objects at fifty metres, and not so much that the ore
       * becomes scenery. The first try ran to 2.6 and put 1.5 m crystals on
       * a rheniite FLAKE - driven in a browser, one node filled the frame
       * from three metres. At 1.9 iridite's main crystal is 0.65 m against
       * the 0.34 m it was, which is the difference between a pebble you walk
       * past and a seam you walk to. */
      const SHOW = { common: 1.0, uncommon: 1.2, rare: 1.5, exotic: 1.9 };
      const show = spec.size * (SHOW[spec.rarity] ?? 1.0);

      // Four crystals per node, so a deposit is a cluster and not a pebble.
      const PER = 4;
      const mesh = new THREE.InstancedMesh(geo, mat, Math.max(1, res.points.length * PER));
      mesh.name = `planet:mineral:${spec.id}`;
      mesh.count = res.points.length * PER;
      mesh.castShadow = true;
      mesh.receiveShadow = true;

      let k = 0;
      for (const pt of res.points) {
        const roll = pt.rnd;
        const credits = Math.round(spec.credits[0] + roll * (spec.credits[1] - spec.credits[0]));
        this.mineralNodes.push({
          id: `${spec.id}_${this.mineralNodes.length}`,
          type: spec.id,
          name: spec.name,
          position: new THREE.Vector3(pt.x, pt.y, pt.z),
          credits,
          size: spec.size,
          /* WHERE THIS NODE'S CRYSTALS LIVE IN THE INSTANCED DRAW.
           *
           * Published because a node that is mined has to STOP BEING DRAWN, and
           * a consumer holding only a world position has no way to reach four
           * matrices inside an `InstancedMesh` without re-deriving the packing
           * order from this loop - which is the kind of duplicated arithmetic
           * that silently goes wrong the day `PER` changes. `mesh` is the live
           * object and `slot`/`slotCount` are its index range.
           * @see systems/Mining.js */
          mesh,
          slot: k,
          slotCount: PER,
        });
        for (let c = 0; c < PER; c++) {
          const a = (roll * (7 + c * 13.7)) % 1;
          const b = (roll * (31 + c * 5.1)) % 1;
          const ang = (c / PER) * Math.PI * 2 + roll * 6.28;
          const off = c === 0 ? 0 : show * (0.35 + a * 0.5);
          const sc = show * (c === 0 ? 0.55 : 0.24 + b * 0.24);
          _e.set(a * 1.1 - 0.55, b * 6.28, b * 1.1 - 0.55);
          _q.setFromEuler(_e);
          _v.set(pt.x + Math.cos(ang) * off, pt.y + sc * 0.35, pt.z + Math.sin(ang) * off);
          _s.set(sc, sc * (1.1 + a * 0.9), sc);
          _m4.compose(_v, _q, _s);
          mesh.setMatrixAt(k++, _m4);
        }
      }
      mesh.instanceMatrix.needsUpdate = true;
      mesh.computeBoundingSphere();
      this.group.add(mesh);
      this.census.drawCalls++;
      this.census.triangles += 20 * k;
      this.census.minerals[spec.id] = { placed: res.points.length, requested: res.requested, rejects: res.rejects };
    }
  }

  /**
   * Landing sites.
   *
   * A ring on the ground, four corner markers and the published record. The
   * FLATNESS is not created here - it is created by the `pad` landform in the
   * height field, which `definePlanet` refuses to let a site exist without.
   * This is only the paint that says "here".
   */
  _buildLandingSites() {
    const P = this.planet;
    const g = new THREE.Group();
    g.name = `planet:${P.id}:landing`;
    this.group.add(g);

    /**
     * THE OUTER RING IS PAINT, AND THE INNER ONE IS THE ONLY LIGHT.
     *
     * It was one material, emissive `0x64d8ff` at 0.45, on both rings. 0.45 was
     * already a retreat from 1.5 and it was not far enough: from 190 m up the
     * two pad rings were the ONLY high-chroma objects on the whole planet -
     * whole-frame max 112, and most of that was them - and at eye level the
     * outer ring was the dominant object in shot with a visibly stair-stepped
     * inner edge. A cyan doughnut is also the wrong colour for a volcanic
     * world: it belongs to no palette this planet has.
     *
     * So there are two materials now. The outer ring is a light VALUE in the
     * world's own family - a lime-washed circle on ash, which is what a real
     * pad marking is - with no emissive at all, and it reads because it is
     * paler than the ground rather than because it glows. The inner ring keeps
     * an emissive, in the planet's amber rather than in cyan, because
     * something on a pad has to be findable at night and it is 4 m across
     * instead of 34.
     */
    const ringMat = new THREE.MeshStandardMaterial({
      name: `planet.${P.id}.padmark`,
      color: 0xb9a893,
      roughness: 0.82,
    });
    const innerMat = new THREE.MeshStandardMaterial({
      name: `planet.${P.id}.padmark.inner`,
      color: 0x140d09,
      emissive: new THREE.Color(0xffb060),
      emissiveIntensity: 0.5,
      roughness: 0.5,
    });
    const postMat = this.materials.get('metal.trim').clone();
    postMat.name = `planet.${P.id}.padpost`;
    /**
     * THE EDGE MARKING, and why a pad needs one at all.
     *
     * Measured across all ten planets: seven of them have a pad you can walk
     * off and never walk back onto. Cinder's Rimhold Shelf floods 13,000 m2 on
     * foot and a body that steps off it can end up anywhere on 468,000 m2, of
     * which 97.3% cannot walk back. That isolation is DESIGN - it is what makes
     * the exotic seam cost a second landing, and `planet-reach` asserts it - but
     * nothing on the ground said so. A player who lands on a 20 m disc notched
     * into a crater rim and walks north sees ash, then more ash, then a slope,
     * and finds out what they have done forty seconds later.
     *
     * So the drop is measured (`_padDrop`) and PAINTED, on the bearings it is
     * on. Amber-black hazard blocks around the rim of the disc where the ground
     * falls away: the same language a lift shaft and a pier edge use elsewhere
     * in this project, and the only one available on a wilderness pad with no
     * signage system anywhere near it. No collider - the marking says where the
     * edge is, it does not stop you leaving.
     */
    const edgeMat = new THREE.MeshStandardMaterial({
      name: `planet.${P.id}.padedge`,
      color: 0xd8912a,
      emissive: new THREE.Color(0xff7a12),
      emissiveIntensity: 0.35,
      roughness: 0.62,
    });
    this._own(ringMat);
    this._own(innerMat);
    this._own(postMat);
    this._own(edgeMat);

    for (const s of P.landing) {
      const y = this.groundAt(s.x, s.z);
      const ring = new THREE.Mesh(new THREE.RingGeometry(s.r - 1.4, s.r, 64), ringMat);
      ring.rotation.x = -Math.PI / 2;
      ring.position.set(s.x, y + 0.06, s.z);
      this._own(ring.geometry);
      g.add(ring);
      this.census.drawCalls++;

      const drop = this._padDrop(s, y);
      if (drop.bearings.length) {
        const blockGeo = new THREE.BoxGeometry(1.6, 0.34, 0.9);
        this._own(blockGeo);
        const blocks = new THREE.InstancedMesh(blockGeo, edgeMat, drop.bearings.length);
        blocks.name = `planet:${P.id}:padedge:${s.id}`;
        for (let i = 0; i < drop.bearings.length; i++) {
          const a = drop.bearings[i];
          const bx = s.x + Math.cos(a) * (s.r - 0.7);
          const bz = s.z + Math.sin(a) * (s.r - 0.7);
          _e.set(0, -a, 0);
          _q.setFromEuler(_e);
          _v.set(bx, this.groundAt(bx, bz) + 0.17, bz);
          _s.set(1, 1, 1);
          _m4.compose(_v, _q, _s);
          blocks.setMatrixAt(i, _m4);
        }
        blocks.instanceMatrix.needsUpdate = true;
        blocks.computeBoundingSphere();
        g.add(blocks);
        this.census.drawCalls++;
        this.census.triangles += 12 * drop.bearings.length;
      }

      const inner = new THREE.Mesh(new THREE.RingGeometry(s.r * 0.32, s.r * 0.32 + 0.9, 48), innerMat);
      inner.rotation.x = -Math.PI / 2;
      inner.position.set(s.x, y + 0.06, s.z);
      this._own(inner.geometry);
      g.add(inner);
      this.census.drawCalls++;

      /* Four mooring posts, on the pad's own radius so they never stand in the
       * ship's way. Real colliders: they are 2.4 m of steel and a player who
       * walks through one has been told the world is not solid. */
      const postGeo = new THREE.BoxGeometry(0.5, 2.4, 0.5);
      this._own(postGeo);
      const posts = new THREE.InstancedMesh(postGeo, postMat, 4);
      posts.castShadow = true;
      for (let i = 0; i < 4; i++) {
        const a = (i / 4) * Math.PI * 2 + Math.PI / 4;
        const px = s.x + Math.cos(a) * (s.r - 1.0);
        const pz = s.z + Math.sin(a) * (s.r - 1.0);
        const py = this.groundAt(px, pz);
        _m4.makeTranslation(px, py + 1.2, pz);
        posts.setMatrixAt(i, _m4);
        this.track(this.physics.addBox(px, py + 1.2, pz, 0.25, 1.2, 0.25));
        this.census.colliders++;
      }
      posts.instanceMatrix.needsUpdate = true;
      posts.computeBoundingSphere();
      g.add(posts);
      this.census.drawCalls++;

      this.landingSites.push({
        id: s.id,
        name: s.name,
        position: new THREE.Vector3(s.x, y, s.z),
        radius: s.r,
        yaw: s.yaw ?? 0,
        primary: !!s.primary,
        /* PUBLISHED, so a HUD, a test or a rescue can ask how exposed a pad is
         * without re-deriving it from the height field. `deg` is how much of the
         * horizon around the disc falls away, `metres` how far it falls. */
        drop: { deg: drop.deg, metres: Number(drop.worst.toFixed(1)) },
      });
      this.census.pads = this.census.pads ?? {};
      this.census.pads[s.id] = { deg: drop.deg, metres: Number(drop.worst.toFixed(1)) };
    }
  }

  /**
   * HOW MUCH OF THE HORIZON AROUND A PAD FALLS AWAY, and by how far.
   *
   * Marched over the height field the player stands on, not over the
   * descriptor's intentions: 48 bearings, each stepped out to `REACH` metres
   * past the disc, keeping the lowest ground it finds. A bearing counts as a
   * drop when the ground falls more than `SILL` below the pad within that
   * distance - deeper than any authored ramp grade would take it, so a road
   * leaving the pad is not reported as a cliff.
   *
   * `SILL` is 8 m: over the 6.3 m a fall starts costing health, and well over
   * the 3 m the reach probes allow a walk to descend, so a bearing that trips it
   * is a bearing you cannot simply walk back up.
   *
   * @param {{x:number,z:number,r:number}} s the descriptor's landing record
   * @param {number} padY the pad's own height
   */
  _padDrop(s, padY) {
    const BEARINGS = 48;
    const REACH = 46;
    const STEP = 4;
    const SILL = 8;
    const bearings = [];
    let worst = 0;
    for (let i = 0; i < BEARINGS; i++) {
      const a = (i / BEARINGS) * Math.PI * 2;
      let low = padY;
      for (let d = s.r + 2; d <= s.r + REACH; d += STEP) {
        const g = this.groundAt(s.x + Math.cos(a) * d, s.z + Math.sin(a) * d);
        if (Number.isFinite(g) && g < low) low = g;
      }
      const fall = padY - low;
      if (fall > worst) worst = fall;
      if (fall > SILL) bearings.push(a);
    }
    return { bearings, worst, deg: Math.round((bearings.length / BEARINGS) * 360) };
  }

  /** Ash in the air. One `Points`, wrapped around the camera in the shader. */
  _buildAtmosphere() {
    const h = this.planet.hazards ?? {};
    const density = h.ashfall?.density ?? 0;
    if (density <= 0) return;
    const BOX = 220;
    const COUNT = Math.round(1800 * density);
    const pos = new Float32Array(COUNT * 3);
    const seedA = new Float32Array(COUNT);
    let s = 0x3f19 >>> 0;
    const rnd = () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
    for (let i = 0; i < COUNT; i++) {
      pos[i * 3] = rnd() * BOX;
      pos[i * 3 + 1] = rnd() * BOX;
      pos[i * 3 + 2] = rnd() * BOX;
      seedA[i] = rnd();
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('aSeed', new THREE.BufferAttribute(seedA, 1));
    const mat = new THREE.ShaderMaterial({
      name: 'planet.ash',
      uniforms: {
        uTime: { value: 0 },
        uEye: { value: new THREE.Vector3() },
        uBox: { value: BOX },
        uDrift: { value: new THREE.Vector2(...(h.ashfall?.drift ?? [0.5, 0])) },
        uSize: { value: 1.4 },
        uColor: { value: new THREE.Color(h.ashColor ?? 0x8a7466) },
        uOpacity: { value: 0.5 },
      },
      vertexShader: ASH_VERT,
      fragmentShader: ASH_FRAG,
      transparent: true,
      depthWrite: false,
    });
    const pts = new THREE.Points(geo, mat);
    pts.name = 'planet:ash';
    pts.frustumCulled = false;
    pts.renderOrder = 9;
    this.group.add(pts);
    this._own(geo);
    this._own(mat);
    this._ash = mat;
    this.census.drawCalls++;
  }

  /** Spawn, portals and the minimap. */
  _publish() {
    const P = this.planet;
    const primary = this.landingSites.find((s) => s.primary) ?? this.landingSites[0];
    /* Just outside the pad's centre marker, facing the way the descriptor says.
     * 0.4 m of clearance: the capsule solver seats the feet on the heightfield,
     * and spawning exactly ON it starts the first frame in penetration. */
    this.playerSpawn.set(primary.position.x, primary.position.y + 0.4, primary.position.z + primary.radius * 0.45);
    this.playerSpawnYaw = primary.yaw;

    this._publishMinimap();
  }

  /**
   * THE FLOORPLAN.
   *
   * `Minimap._bakePlan` rasterises `minimapShapes` IN ORDER, so this method is
   * really a painter's-algorithm stack: ground, then liquid, then the pads.
   *
   * ── Three things were hard-coded to lava and wrong for water ────────────
   *
   * 1. THE LIQUID FILL was the literal string `rgba(255,110,30,0.55)`. Correct
   *    for Cinder and catastrophic for Shoal, whose sea is a single 2,700 m
   *    disc covering the entire playfield: the map came out a FULL-SCREEN
   *    ORANGE WASH with the land indistinguishable from the sea. Not merely
   *    wrong - useless. The colour now comes off the descriptor's own channels
   *    through `_liquidInk`.
   *
   * 2. A BODY BIGGER THAN THE MAP IS THE BACKGROUND, not a shape drawn over
   *    it. Painting a disc that contains all four corners of the playfield can
   *    only ever cover everything under it, so such a body becomes the base
   *    rect's fill and the LAND is drawn on top of it - as run-merged rects off
   *    the same wet/dry mask the shore barrier is built from, which is why the
   *    coastline on the map is the coastline the player is stopped at. Runs
   *    keep it cheap: Shoal's islands cost a few hundred rects, not 78,400.
   *
   * 3. THE GROUND RECT was `rgba(24,14,12,0.85)` with an orange stroke - ash,
   *    on every planet. It comes from `palette.bands` now.
   *
   * ── And one silent bug ──────────────────────────────────────────────────
   * The ribbon case emitted `points: [{x, z}, ...]` while `Minimap._bakePlan`
   * reads `p[0]`/`p[1]`, as every other world in the repo supplies. `moveTo`
   * with two `undefined`s is a NaN path segment: Cinder's 340 m outlet gorge -
   * the biggest liquid feature on the planet - HAS NEVER BEEN ON THE MINIMAP.
   * It draws now, which is a deliberate and visible change to Cinder's map.
   */
  _publishMinimap() {
    const P = this.planet;
    const bands = P.palette?.bands ?? [];
    const bodies = P.liquid?.bodies ?? [];
    const ink = P.liquid ? this._liquidInk(P.liquid) : null;

    /* THE BACKDROP IS THE WHOLE PALETTE, DARKENED.
     *
     * Not one band: `bands[mid]` picked Cinder's #45505c and turned a volcanic
     * planet's map slate blue, which is a worse answer than the ash-coloured
     * literal it replaced. The mean of every band is the planet's own colour,
     * and 0.45 of it keeps the map recessive so the liquid, the roads and the
     * pads are what the eye finds - which is what the old rgba(24,14,12,0.85)
     * was doing by hand. Cinder lands on rgb(48,42,36): the same dark warm
     * brown, a shade lighter, and a deliberate change.
     *
     * LAND drawn ON a sea is the opposite job and gets the opposite treatment:
     * the mean of the bands ABOVE the waterline, undarkened, because it has to
     * separate from the water rather than recede into it. Those are literally
     * the colours of the ground that is not underwater. */
    const mean = (list) => {
      if (!list.length) return [24, 14, 12];
      let r = 0; let g = 0; let b = 0;
      for (const c of list) { const p8 = rgb8(c.color); r += p8[0]; g += p8[1]; b += p8[2]; }
      return [Math.round(r / list.length), Math.round(g / list.length), Math.round(b / list.length)];
    };
    const all = mean(bands);
    const backdropFill = `rgba(${mix8([0, 0, 0], all, 0.45).join(',')},0.85)`;
    const groundStroke = bands.length
      ? this._rgba(bands[bands.length - 1].color, 0.7)
      : 'rgba(200,90,40,0.7)';
    /* "Covers the playfield" is asked of the drawn outline, not of the nominal
     * radius: `bodySurfaceAt` is the same wobbly shoreline the mesh has. All
     * four corners inside means nothing on the map is ever outside it. */
    const covers = bodies.filter((b) => this._coversPlayfield(b));

    this.minimapShapes.push({
      kind: 'rect', x: 0, z: 0, w: P.half * 2, d: P.half * 2, rotation: 0,
      fill: covers.length && ink ? ink.fillSolid : backdropFill,
      stroke: groundStroke,
    });

    if (covers.length && this._bed) {
      const waterline = covers[0].shape === 'disc' ? covers[0].y : Math.max(covers[0].y0, covers[0].y1);
      const above = bands.filter((b) => b.upTo > waterline);
      const landFill = `rgb(${mean(above.length ? above : bands).join(',')})`;
      for (const r of this._landRects()) {
        this.minimapShapes.push({ kind: 'rect', x: r.x, z: r.z, w: r.w, d: r.d, rotation: 0, fill: landFill });
      }
    }

    for (const b of bodies) {
      if (covers.includes(b)) continue;
      if (b.shape === 'disc') {
        this.minimapShapes.push({ kind: 'circle', x: b.x, z: b.z, r: b.r, fill: ink.fill, stroke: ink.stroke });
      } else {
        this.minimapShapes.push({
          kind: 'path', points: b.pts.map(([x, z]) => [x, z]), width: b.width, stroke: ink.stroke,
        });
      }
    }

    for (const s of this.landingSites) {
      this.minimapShapes.push({
        kind: 'circle', x: s.position.x, z: s.position.z, r: s.radius,
        fill: 'rgba(100,216,255,0.22)', stroke: '#64d8ff',
      });
    }
  }

  /**
   * `0xrrggbb` -> `rgba(r,g,b,a)`, and the mixing that feeds it, in sRGB BYTES.
   *
   * Not through `THREE.Color`, and that is the point. `setHex` converts to the
   * renderer's working colour space, so `color.r * 255` is a LINEAR value - the
   * first version of this went out at rgb(235,46,3) for a lava fill that had
   * been rgb(255,110,30), a visibly darker, more saturated orange, because the
   * conversion was never undone. The minimap is a 2D canvas: it wants sRGB, and
   * lerping in sRGB is exactly what the hard-coded literals it replaces were.
   */
  _rgba(hex, a) {
    const c = rgb8(hex);
    return `rgba(${c[0]},${c[1]},${c[2]},${a})`;
  }

  /**
   * What this liquid looks like FROM ABOVE, from the descriptor's own channels.
   *
   * The map is a plan view of the material, so it is derived the way the
   * material mixes: `crust` and `color` average to the body colour, and the
   * incandescence rides on top in proportion to `emissive`. Cinder's
   * `emissive: 2.1` saturates the weight and lands on rgb(238,113,26) against
   * the rgb(255,110,30) that was hard-coded - a deliberate, near-invisible
   * shift. Shoal's `emissive: 0.16` contributes almost nothing and its sea
   * comes out the deep blue it is.
   *
   * The stroke is the same mix pushed further toward `hot`: a molten rim on
   * lava, a surf line on water. Both are the map's brightest edge, which is
   * what a shoreline should be.
   */
  _liquidInk(L) {
    const hot = rgb8(L.hot ?? 0xff7a1c);
    const base = mix8(rgb8(L.crust ?? 0x140b0a), rgb8(L.color ?? 0x3d0a04), 0.45);
    const w = Math.min(0.92, Math.max(0, (L.emissive ?? 0) * 0.45));
    const fill = mix8(base, hot, w);
    const stroke = mix8(base, hot, Math.max(w, 0.5));
    const px = (c) => `${c[0]},${c[1]},${c[2]}`;
    return {
      fill: `rgba(${px(fill)},0.55)`,
      /* Opaque where the body IS the map: a 55% wash over a black canvas is a
       * muddy sea, and there is nothing underneath it to show through. */
      fillSolid: `rgb(${px(fill)})`,
      stroke: `rgb(${px(stroke)})`,
    };
  }

  /** True when this body's outline contains every corner of the playfield. */
  _coversPlayfield(b) {
    const h = this.planet.half;
    for (const [x, z] of [[-h, -h], [h, -h], [h, h], [-h, h]]) {
      if (bodySurfaceAt(b, x, z) === null) return false;
    }
    return true;
  }

  /**
   * The land, as horizontal runs of dry cells.
   *
   * Off the SAME mask the shore barrier stands on, so the island the map draws
   * and the island the player can stand on are one island. One rect per run
   * rather than per cell: Shoal is 280x280 cells and its coastline resolves to
   * a few hundred rects.
   */
  _landRects() {
    const bed = this._bed;
    const mask = liquidCellMask({ liquid: this.planet.liquid, ...bed });
    const { wet, cx, cz } = mask;
    const out = [];
    for (let j = 0; j < cz; j++) {
      let i = 0;
      while (i < cx) {
        if (wet[j * cx + i]) { i++; continue; }
        let i1 = i;
        while (i1 + 1 < cx && !wet[j * cx + i1 + 1]) i1++;
        const w = (i1 - i + 1) * bed.stepX;
        out.push({
          x: bed.originX + (i + i1 + 2) * 0.5 * bed.stepX,
          z: bed.originZ + (j + 0.5) * bed.stepZ,
          /* Overlapped by a quarter of a cell, which at the rasteriser's
           * 2.4 px/m is about two pixels. A 4% overlap was under a third of a
           * pixel and the canvas anti-aliased every row edge against the sea
           * behind it, so the islands came out striped. The fill is opaque, so
           * overlapping costs nothing. */
          w: w + bed.stepX * 0.25,
          d: bed.stepZ * 1.25,
        });
        i = i1 + 1;
      }
    }
    return out;
  }

  /* ================================================================== */
  /* Frame                                                              */
  /* ================================================================== */

  update(dt, elapsed) {
    this._t = elapsed;
    if (this._sky) this._sky.update(dt);
    if (this._liquidUniforms) this._liquidUniforms.uTime.value = elapsed;
    for (let i = 0; i < this._plumes.length; i++) this._plumes[i].material.uniforms.uTime.value = elapsed;
    if (this._ash) {
      this._ash.uniforms.uTime.value = elapsed;
      // Written into the existing uniform vector, never replaced: this runs
      // every frame and a new Vector3 here is 60 allocations a second.
      const cam = this.engine?.camera;
      if (cam) cam.getWorldPosition(this._ash.uniforms.uEye.value);
    }
  }

  onActivate() {
    super.onActivate();
    // The dome has to ride the camera or the player walks out of the sky.
    if (this._sky && this.engine?.camera) this._sky.mesh.position.copy(this.engine.camera.position);
  }

  dispose() {
    for (const o of this._owned) o.dispose?.();
    this._owned.length = 0;
    this._sky?.dispose?.();
    this._sky = null;
    this._plumes.length = 0;
    this._ash = null;
    this._propMat = null;
    /* The bed is the terrain's own height buffer and the whole liquid depth
     * texture is derived from it; a planet revisited must not keep the last
     * visit's ground alive behind the new one. */
    this._bed = null;
    this._liquidDepth = null;
    this.mineralNodes.length = 0;
    this.landingSites.length = 0;
    super.dispose();
  }
}
