/**
 * THE CITADEL REACH KIT - the apparatus, split out of the test that grew it.
 *
 * Every symbol here was written in `citadel-reach.test.mjs` and lived there
 * happily while it was the only file that measured this world. The outer ring
 * needed a second one (`citadel-regions.test.mjs`), and importing a
 * `*.test.mjs` file re-registers its tests in the importer's run: twelve extra
 * cases in a second file's report, and a suite total that counts them twice.
 *
 * So the apparatus moved here - `citadel-reach.test.mjs` re-exports every
 * symbol unchanged, which is what keeps every existing import path working -
 * and the file is deliberately NOT named `*.test.mjs`, because `npm test`
 * globs `scripts/tests/*.test.mjs` and a kit is not a suite.
 *
 * Nothing else changed in the move. If a number in here ever disagrees with the
 * game, it is the game or this file that is wrong, not the split.
 */
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { MAX_WALK_SLOPE } from '../../src/worlds/medieval/Treasures.js';

/**
 * CAN A BODY GET THERE? THE CITADEL, MEASURED.
 *
 * ── Why this file exists ──────────────────────────────────────────────────
 * Every world test in this repo asks whether a thing was BUILT. None of them
 * asks whether a player can REACH it. That gap shipped four defects during the
 * medieval expansion and it is about to ship more here, because Citadel is a
 * *vertical* world: the edge that kills you is a gap, not a step, and a
 * clearance suite cannot see a gap at all.
 *
 * So the medieval probes are substituted wholesale (design §6):
 *
 *   `surfaceAt`      -> `deckAt(x, z)`     highest collider top over the column,
 *                                          with a HEADROOM clause, because a
 *                                          roof under an awning is not a landing.
 *   `worstStep`      -> `arcClears(a, b)`  the REAL integrator, flown at each of
 *                                          the three movement budgets, checked
 *                                          for apex clearance over everything in
 *                                          between AND for landing inside the
 *                                          target deck with >= 0.4 m to spare.
 *   the bearing fan  -> `takeoffFan(...)`  perimeter samples every 1.0 m, launch
 *                                          heading +/-60 deg in 10 deg steps. A
 *                                          gap crossable from exactly one point
 *                                          on exactly one bearing is a fluke,
 *                                          not a route.
 *
 * ── Derive nothing ────────────────────────────────────────────────────────
 * Three separate figures in the design document were wrong, all in the same
 * direction, all because they were computed rather than driven. `Player.
 * fixedUpdate` applies gravity BEFORE `_move` integrates, so the first step of
 * every rise is taken at `v0 + g*dt` and the whole trajectory permanently loses
 * |g|dt^2/2. The closed form `v^2/2g` gives 0.93 m for a jump apex; the body
 * gets 0.878 m. Five centimetres is a ledge band a leap does not clear.
 *
 * `flyArc()` below therefore reproduces `Player.fixedUpdate`'s ORDER, not its
 * arithmetic, and the first test in the file proves it against the six numbers
 * measured live in a browser. If that test ever goes red, every other number
 * here is void - which is why it is first.
 *
 * ── What is measured, and what is asserted ────────────────────────────────
 * Every test here is a FLOOR: a property the world must keep, quoted
 * floor / achieved / ceiling with the ceiling computed by ablation, so a
 * regression shows up as a number sliding toward its floor rather than a
 * boolean flipping.
 *
 * The file was drafted with a second kind - TODAY, an exact measurement of the
 * broken state, to be flipped deliberately rather than discovered - and none
 * survive: Drop Two fixed every one of them and each was rewritten as the floor
 * of the property that fixed it. If a TODAY test ever reappears here it is a
 * note to a later drop, not a permanent resident.
 *
 * ── Cost ──────────────────────────────────────────────────────────────────
 * One headless world build and one graph pass, shared by every test through
 * `measure()`. The build template is `npc-routes.test.mjs:147-243`.
 */

/* ================================================================== */
/* The movement envelope. Measured in a browser; do NOT recompute.     */
/* ================================================================== */

/** `Player.fixedUpdate`'s tick. */
export const DT = 1 / 60;
/** `Config.player.gravity`. */
export const GRAVITY = -22;

/**
 * The three budgets a body can leave a roof with.
 *
 * `v` is the vertical velocity written into `_velocity.y` on the jump step and
 * `h` is the horizontal speed carried into it. `flat` and `apex` are what the
 * real integrator produces from that pair, measured live; they are recorded
 * here so the integrator can be PROVED against them rather than trusted.
 *
 *  - walk   `jumpVelocity` 6.4 with `walkSpeed` 4.6
 *  - sprint `jumpVelocity` 6.4 with the grounded sprint cap 8.2
 *           (`acceleration / friction`, NOT `sprintWishSpeed` 11.2)
 *  - leap   `Parkour` LEAP_LIFT 1.12 x 6.4 = 7.168, LEAP_BOOST 1.42 x 8.2
 */
export const BUDGETS = Object.freeze([
  Object.freeze({ id: 'walk', v: 6.4, h: 4.6, flat: 2.607, apex: 0.878 }),
  Object.freeze({ id: 'sprint', v: 6.4, h: 8.2, flat: 4.647, apex: 0.878 }),
  Object.freeze({ id: 'leap', v: 6.4 * 1.12, h: 8.2 * 1.42, flat: 7.569, apex: 1.109 }),
]);
export const BUDGET = Object.freeze(Object.fromEntries(BUDGETS.map((b) => [b.id, b])));

/** Drop at which fall damage first appears. Driven off a real ledge, not `v^2/2g`. */
export const FALL_DAMAGE_M = 7.5;
/** Drop that kills from full health. Also driven, also not the closed form. */
export const FALL_LETHAL_M = 40.0;
/** Continuous ascent one stamina bar buys: 14.29 s at `SPEED_UP` 2.05 m/s. */
export const CLIMB_SUSTAIN_M = 29.3;

/**
 * `Parkour._softLandingAt` accepts a haystack when `pos.y - h.y` lies in
 * `[-3.5, +1.5]`. Written the way a world author thinks about it - the hay's
 * recorded `y` relative to the surface `T` the body actually lands on - that is
 * `h.y - T` in `[-1.5, +3.5]`, INCLUSIVE.
 *
 * An earlier spec draft had this interval the other way round. A test written
 * from it would have failed all eleven correctly placed haystacks and passed
 * some buried ones, which is worse than having no test at all.
 */
export const HAY_MIN = -1.5;
export const HAY_MAX = 3.5;

/**
 * Clear air a surface needs above it before it counts as a deck.
 *
 * The player capsule is 1.75 m. 1.8 is that plus five centimetres, which is
 * what separates "a roof" from "the underside of a rope bridge".
 */
export const HEADROOM = 1.8;

/**
 * How far inside the target deck the feet must come down.
 *
 * 0.4 m, from design §6. The arc is flown as a POINT - it carries no capsule
 * radius - so this margin also stands in for the 0.33 m the body is wide. A
 * landing 0.1 m inside a roof lip is a fall, not an arrival.
 */
export const LANDING_MARGIN = 0.4;

/** How far the landed surface may sit from the target deck and still be it. */
export const DECK_Y_TOL = 0.35;

/** `NPC.GROUND_PROBE_UP`: the tallest step a walk absorbs without a jump. */
export const STEP_UP = 0.95;

/**
 * The steepest GROUND a body walks up, as a plain gradient.
 *
 * A step and a slope are two different things and this file conflated them
 * until the outer ring was authored. `STEP_UP` is a step: the riser a stride
 * absorbs in one go. A slope is not a step, and gating a 6 m lattice hop on
 * `STEP_UP` says the steepest walkable ground in the world is a gradient of
 * 0.158 - one in six. Measured against that rule, the mesa's own shoulder
 * (0.30), the quarry crown's outer slope (0.35), Ashfall's cart ramp (0.53)
 * and the karst massif's approach (0.56) are all cliffs, and three of the six
 * regions came out forward-unreachable from spawn while every one of them is a
 * walk in the game.
 *
 * The ruler is `Treasures.MAX_WALK_SLOPE`, imported rather than copied,
 * because it is the predicate the medieval expansion's own reachability proof
 * is built on and two files that disagree about whether a hill is climbable
 * make both proofs worthless. It is a NORMALISED slope - `slopeAt` multiplies
 * the gradient by 1.15 - so the gradient is 0.78 / 1.15 = 0.678, which is
 * exactly the number `terrain/CitadelHeight.js` authored every approach ramp
 * in the ring against.
 *
 * It is also conservative against the engine, deliberately. `Physics`
 * grounds a capsule to n.y > 0.64 (a gradient of 1.19) and `Player._move`'s
 * step-up ladder measurably carries a player up 59 degrees; this model refuses
 * everything past 34. A reachability proof is allowed to under-claim.
 */
export const WALK_GRADIENT = MAX_WALK_SLOPE / 1.15;

/** Spacing of the terrain lattice, design §6. */
export const LATTICE = 6.0;

/** Takeoff fan: perimeter sample spacing, half-width, and step. Design §6. */
export const FAN_SPACING = 1.0;
export const FAN_HALF_DEG = 60;
export const FAN_STEP_DEG = 10;

/**
 * What makes a crossing a ROUTE rather than a fluke.
 *
 * Design §6: "A gap crossable from exactly one point on one bearing is not a
 * route." Two distinct takeoff points, and three successful (point, bearing)
 * pairs in total, is the cheapest reading of that which still rejects the
 * single-pixel case. Every `budgetFor` call in this file uses it.
 */
export const ROUTE_MIN_POINTS = 2;
export const ROUTE_MIN_PAIRS = 3;

/** Longest flight `flyArc` will follow before giving up. 2 s at 60 Hz. */
export const MAX_FLIGHT_STEPS = 120;

/* ================================================================== */
/* A world, built without a browser                                    */
/* ================================================================== */

/**
 * Install the least DOM and WebGL a world build touches.
 *
 * Lifted from `npc-routes.test.mjs:147-243`: every stub returns the SHAPE the
 * caller needs and never a plausible value, so a world that came to depend on a
 * pixel it painted reads zero rather than something that looks like a texture.
 * Nothing here is used by a collider, and colliders are all this file measures.
 */
export function harness() {
  if (globalThis.__citadelReachHarness) return;
  globalThis.__citadelReachHarness = true;

  class Img {
    constructor(a, b, c) {
      if (typeof a === 'number') {
        this.width = a; this.height = b;
        this.data = new Uint8ClampedArray(a * b * 4);
      } else {
        this.data = a; this.width = b; this.height = c ?? 1;
      }
    }
  }
  const gradient = { addColorStop() {} };
  const context2d = (canvas) => {
    const real = {
      canvas,
      createImageData: (w, h) => new Img(Math.max(1, w | 0), Math.max(1, (h ?? w) | 0)),
      getImageData: (x, y, w, h) => new Img(Math.max(1, w | 0), Math.max(1, h | 0)),
      createLinearGradient: () => gradient,
      createRadialGradient: () => gradient,
      createConicGradient: () => gradient,
      createPattern: () => null,
      measureText: () => ({ width: 8 }),
      getLineDash: () => [],
    };
    return new Proxy(real, { get: (o, k) => (k in o ? o[k] : () => undefined), set: () => true });
  };
  globalThis.ImageData = Img;
  globalThis.requestAnimationFrame = (fn) => setTimeout(() => fn(Date.now()), 0);
  globalThis.document = {
    createElement(tag) {
      const c = { width: 1, height: 1, style: {}, tagName: tag };
      c.getContext = () => context2d(c);
      return c;
    },
    createElementNS(_ns, tag) { return this.createElement(tag); },
  };
  globalThis.window = globalThis;
  globalThis.OffscreenCanvas = class {
    constructor(w, h) { this.width = w; this.height = h; }
    getContext() { return context2d(this); }
  };
  const dead = () => ({ texture: null, dispose() {} });
  THREE.PMREMGenerator.prototype.fromEquirectangular = dead;
  THREE.PMREMGenerator.prototype.fromScene = dead;
  THREE.PMREMGenerator.prototype.compileEquirectangularShader = () => {};
}

harness();
const { Physics, COLLISION_LAYER } = await import('../../src/physics/Physics.js');

/** Build Citadel with its real physics. One call; everything else reads it. */
export async function buildCitadel() {
  const { CitadelWorld } = await import('../../src/worlds/CitadelWorld.js');
  const physics = new Physics();
  const renderer = {
    capabilities: { getMaxAnisotropy: () => 4, isWebGL2: true },
    initTexture() {}, getContext: () => ({}),
    getRenderTarget: () => null, setRenderTarget() {}, render() {}, clear() {},
  };
  const scene = new THREE.Scene();
  const world = new CitadelWorld({
    physics,
    scene,
    bus: { on: () => () => {}, emit() {} },
    engine: { renderer, onFrameUpdate: () => () => {}, onResize: () => () => {} },
    materials: { get: () => new THREE.MeshStandardMaterial(), dispose() {} },
  });
  world.physics = physics;
  await world.build(() => {});
  return { world, physics, scene };
}

/* ================================================================== */
/* deckAt - the column probe                                           */
/* ================================================================== */

export const EMPTY = [];

/**
 * Every solid interval standing over a column, and the highest one a body
 * could be put on.
 *
 * Built as its own XZ index rather than by leaning on `Physics.raycast`, for
 * one reason: a downward ray answers "what is the first thing under me", and
 * the two questions this file lives on are "what is the first thing under me
 * BELOW this height" - which is what walking under the gatehouse arch means -
 * and "how much air is over it", which is the awning clause. Both need the
 * whole column, and pulling a whole column out of a raycast means casting
 * repeatedly and stitching the answers back together.
 *
 * Intervals are MERGED before anything is asked of them. A souk house is a
 * solid box, a roof lip overlapping its top by a centimetre, and two window
 * courses buried in its middle; unmerged that is four "decks", three of them
 * inside the masonry. Merged it is one interval whose top is the roof, owned by
 * the roof-lip collider - which is exactly the pad a jump has to land on.
 *
 * Merge tolerance is 0.02 m, and the slack matters both ways. The great
 * tower's launch beam sits 0.05 m above its crown; that 5 cm survives the
 * merge, so `deckAt` under the beam correctly answers the beam, and correctly
 * reports the crown as having no headroom there.
 */
export class ColumnIndex {
  /** @param {import('../../src/physics/Physics.js').Physics} physics */
  constructor(physics) {
    this.cell = 8;
    /** @type {Map<number, Array<object>>} */
    this.grid = new Map();
    /** @type {Array<object>} */
    this.boxes = [];
    /** @type {Array<object>} */
    this.fields = [];
    /** Anything this index cannot represent. Asserted empty by a test below. */
    this.unhandled = [];

    for (const c of physics.colliders) {
      if (!c.solid) continue;
      if ((c.layer & COLLISION_LAYER.WORLD) === 0) continue;
      if (c.type === 'heightfield') { this.fields.push(c); continue; }
      if (c.type !== 'box') { this.unhandled.push(c); continue; }
      const m = c.matrix.elements;
      /* Rotation about Y only. `Matrix4.makeRotationY(a)` puts the local +X
       * axis at world (cos a, -sin a) and local +Z at (sin a, cos a); reading
       * the axes out of the matrix rather than storing the angle means a world
       * that starts composing rotations does not silently get mis-measured. */
      const cos = m[0];
      const sin = -m[2];
      const b = {
        col: c, index: this.boxes.length,
        x: m[12], y: m[13], z: m[14],
        hx: c.halfExtents.x, hy: c.halfExtents.y, hz: c.halfExtents.z,
        cos, sin,
        top: m[13] + c.halfExtents.y,
        bot: m[13] - c.halfExtents.y,
      };
      // Axis-aligned XZ span of the rotated footprint. Broadphase only.
      b.ax = Math.abs(cos) * b.hx + Math.abs(sin) * b.hz;
      b.az = Math.abs(sin) * b.hx + Math.abs(cos) * b.hz;
      b.area = 4 * b.hx * b.hz;
      this.boxes.push(b);
      this._insert(b);
    }
  }

  _key(cx, cz) { return ((cx + 4096) << 13) | (cz + 4096); }

  _insert(b) {
    const x0 = Math.floor((b.x - b.ax) / this.cell);
    const x1 = Math.floor((b.x + b.ax) / this.cell);
    const z0 = Math.floor((b.z - b.az) / this.cell);
    const z1 = Math.floor((b.z + b.az) / this.cell);
    for (let cx = x0; cx <= x1; cx++) {
      for (let cz = z0; cz <= z1; cz++) {
        const k = this._key(cx, cz);
        let list = this.grid.get(k);
        if (!list) this.grid.set(k, (list = []));
        list.push(b);
      }
    }
  }

  /** Boxes whose footprint could contain this column. */
  candidates(x, z) {
    return this.grid.get(this._key(Math.floor(x / this.cell), Math.floor(z / this.cell))) ?? EMPTY;
  }

  /**
   * Merged solid intervals over `(x, z)`, ascending.
   * @returns {Array<{bot:number, top:number, owner:object|null, field:object|null}>}
   */
  column(x, z) {
    const raw = [];
    for (const f of this.fields) {
      if (!f.containsColumn(x, z)) continue;
      const h = f.sampleHeight(x, z);
      if (h === null) continue;
      raw.push({ bot: f.baseY, top: h, owner: null, field: f });
    }
    for (const b of this.candidates(x, z)) {
      const dx = x - b.x;
      const dz = z - b.z;
      const lx = dx * b.cos - dz * b.sin;
      const lz = dx * b.sin + dz * b.cos;
      if (Math.abs(lx) > b.hx || Math.abs(lz) > b.hz) continue;
      raw.push({ bot: b.bot, top: b.top, owner: b, field: null });
    }
    raw.sort((a, b) => a.bot - b.bot);

    const merged = [];
    for (const iv of raw) {
      const last = merged[merged.length - 1];
      if (last && iv.bot <= last.top + 0.02) {
        if (iv.top > last.top) { last.top = iv.top; last.owner = iv.owner; last.field = iv.field; }
      } else {
        merged.push({ bot: iv.bot, top: iv.top, owner: iv.owner, field: iv.field });
      }
    }
    return merged;
  }

  /**
   * The highest surface at `(x, z)` a body could stand on.
   *
   * @param {number} x
   * @param {number} z
   * @param {{below?:number, headroom?:number}} [opts] `below` caps the answer,
   *   which is what turns this from "what is the roof" into "what am I walking
   *   on"; without it a step through the gatehouse arch reads as a 14 m climb
   *   onto the lintel.
   * @returns {{y:number, bot:number, headroom:number, owner:object|null,
   *            field:object|null}|null}
   */
  deckAt(x, z, opts) {
    const below = opts?.below ?? Infinity;
    const need = opts?.headroom ?? HEADROOM;
    const col = this.column(x, z);
    for (let i = col.length - 1; i >= 0; i--) {
      const iv = col[i];
      if (iv.top > below) continue;
      const above = col[i + 1];
      const head = above ? above.bot - iv.top : Infinity;
      if (head < need) continue;
      return { y: iv.top, bot: iv.bot, headroom: head, owner: iv.owner ?? null, field: iv.field ?? null };
    }
    return null;
  }
}

/**
 * `deckAt(x, z)` as a free function, which is how design §6 names it.
 *
 * The index has to be built once from a `Physics` before anything can be asked
 * of a column, so the state lives on `ColumnIndex`; this is the spelling the
 * design uses and the one a caller reaches for.
 *
 * @param {ColumnIndex} idx
 * @param {number} x
 * @param {number} z
 * @param {{below?:number, headroom?:number}} [opts]
 */
export function deckAt(idx, x, z, opts) {
  return idx.deckAt(x, z, opts);
}

/**
 * Is this indexed box a rope-bridge plank?
 *
 * Every plank `_buildRopeBridges` lays is `addRotatedBox(_, (0.6, 0.09, 1.1),
 * _)` and nothing else in the world is that shape, so the shape IS the
 * identity. Recomputing the spans from `_towers` to recognise one would be a
 * second copy of the generator, which is the mistake this project has already
 * made twice.
 *
 * Shared by `ReachGraph`, which walks the chains, and by the pomerium sweep,
 * which has to tell a bridge crossing overhead from a wall that has swung
 * inland - two questions that must never drift apart on a magic number.
 *
 * @param {{hx:number, hy:number, hz:number}|null|undefined} b
 */
export function isPlank(b) {
  return !!b && Math.abs(b.hx - 0.6) < 1e-6 && Math.abs(b.hy - 0.09) < 1e-6 && Math.abs(b.hz - 1.1) < 1e-6;
}

/* ================================================================== */
/* Oriented-box footprints in 2D                                       */
/* ================================================================== */

/** Local-frame offset of `(x, z)` inside an indexed box. */
export function toLocal(b, x, z, out) {
  const dx = x - b.x;
  const dz = z - b.z;
  out[0] = dx * b.cos - dz * b.sin;
  out[1] = dx * b.sin + dz * b.cos;
  return out;
}

/** World point from a box-local `(lx, lz)`. */
export function toWorld(b, lx, lz, out) {
  out[0] = b.x + lx * b.cos + lz * b.sin;
  out[1] = b.z - lx * b.sin + lz * b.cos;
  return out;
}

export const _l = [0, 0];
export const _w = [0, 0];

/**
 * How far inside a box's footprint `(x, z)` sits. Negative outside.
 * This is the number `LANDING_MARGIN` is compared against.
 */
export function footprintMargin(b, x, z) {
  toLocal(b, x, z, _l);
  return Math.min(b.hx - Math.abs(_l[0]), b.hz - Math.abs(_l[1]));
}

/**
 * The four XZ corners of a box footprint, wound so consecutive pairs are
 * edges. Memoised on the box: the gap histogram asks for these hundreds of
 * thousands of times and colliders never move.
 */
export function footprintCorners(b) {
  if (b.corners) return b.corners;
  const out = new Array(8);
  let i = 0;
  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) {
      toWorld(b, sx * b.hx, sz * b.hz, _w);
      out[i++] = _w[0]; out[i++] = _w[1];
    }
  }
  const wound = [out[0], out[1], out[2], out[3], out[6], out[7], out[4], out[5]];
  b.corners = wound;
  return wound;
}

/**
 * The collider whose top sits at `y` over this column.
 *
 * `deckAt` cannot answer this, and deliberately: it merges, so a souk roof with
 * a dome sitting on it reports the DOME's top and swallows the roof lip
 * entirely. When an authored anchor already names the height it means - a
 * `_roofs` entry, a `_towers` top - the lip is what has to be found, because
 * the lip is the pad the feet land on and the dome is a thing standing on it.
 */
export function boxAt(idx, x, z, y, tol = 0.05) {
  let best = null;
  for (const b of idx.candidates(x, z)) {
    if (Math.abs(b.top - y) > tol) continue;
    if (footprintMargin(b, x, z) < 0) continue;
    if (!best || b.area < best.area) best = b;
  }
  return best;
}

export function segPointDist(px, pz, ax, az, bx, bz) {
  const vx = bx - ax;
  const vz = bz - az;
  const len2 = vx * vx + vz * vz;
  let t = len2 > 0 ? ((px - ax) * vx + (pz - az) * vz) / len2 : 0;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  const cx = ax + vx * t;
  const cz = az + vz * t;
  return Math.hypot(px - cx, pz - cz);
}

export function projOverlap(cornersA, cornersB, ax, az) {
  let a0 = Infinity; let a1 = -Infinity; let b0 = Infinity; let b1 = -Infinity;
  for (let i = 0; i < 8; i += 2) {
    const pa = cornersA[i] * ax + cornersA[i + 1] * az;
    if (pa < a0) a0 = pa; if (pa > a1) a1 = pa;
    const pb = cornersB[i] * ax + cornersB[i + 1] * az;
    if (pb < b0) b0 = pb; if (pb > b1) b1 = pb;
  }
  return Math.min(a1, b1) - Math.max(a0, b0);
}

/**
 * Edge-to-edge XZ distance between two box footprints. Zero when they overlap.
 *
 * SAT on the four box axes decides overlap exactly for a pair of OBBs; the
 * separated case falls back to the 32 vertex-edge distances, which is exact for
 * convex quads and cheap enough at this scale. This is THE number the gap
 * histogram is built from, so it is worth being exact rather than sampling.
 */
export function footprintGap(a, b) {
  const ca = footprintCorners(a);
  const cb = footprintCorners(b);
  const axes = [[a.cos, -a.sin], [a.sin, a.cos], [b.cos, -b.sin], [b.sin, b.cos]];
  let overlap = true;
  for (const [ax, az] of axes) {
    if (projOverlap(ca, cb, ax, az) <= 0) { overlap = false; break; }
  }
  if (overlap) return 0;
  let best = Infinity;
  for (let i = 0; i < 8; i += 2) {
    for (let j = 0; j < 8; j += 2) {
      const j2 = (j + 2) % 8;
      best = Math.min(best, segPointDist(ca[i], ca[i + 1], cb[j], cb[j + 1], cb[j2], cb[j2 + 1]));
      best = Math.min(best, segPointDist(cb[i], cb[i + 1], ca[j], ca[j + 1], ca[j2], ca[j2 + 1]));
    }
  }
  return best;
}

/**
 * Points around a footprint's edge, every `spacing` metres, each with the
 * outward normal of the edge it sits on.
 *
 * `inset` pulls them a few centimetres inboard so the launch column is
 * unambiguously ON the deck: a sample exactly on the boundary is a coin toss
 * between this roof and the alley below it.
 */
export function perimeterSamples(b, spacing = FAN_SPACING, inset = 0.05) {
  const hx = Math.max(0.02, b.hx - inset);
  const hz = Math.max(0.02, b.hz - inset);
  const out = [];
  const edge = (lx0, lz0, lx1, lz1, nlx, nlz) => {
    const len = Math.hypot(lx1 - lx0, lz1 - lz0);
    const n = Math.max(1, Math.round(len / spacing));
    for (let i = 0; i <= n; i++) {
      const t = i / n;
      toWorld(b, lx0 + (lx1 - lx0) * t, lz0 + (lz1 - lz0) * t, _w);
      const wx = _w[0]; const wz = _w[1];
      toWorld(b, nlx, nlz, _w);
      out.push({ x: wx, z: wz, nx: _w[0] - b.x, nz: _w[1] - b.z });
    }
  };
  edge(-hx, -hz, hx, -hz, 0, -1);
  edge(hx, -hz, hx, hz, 1, 0);
  edge(hx, hz, -hx, hz, 0, 1);
  edge(-hx, hz, -hx, -hz, -1, 0);
  return out;
}

/* ================================================================== */
/* The real integrator                                                 */
/* ================================================================== */

/**
 * Fly one arc and report where the body ends up.
 *
 * The ORDER is the whole point and it is copied from `Player.fixedUpdate`
 * (`Player.js:860-889`), not from a textbook:
 *
 *   1. the jump step writes `_velocity.y = jumpVelocity` and clears `_grounded`
 *   2. `if (!this._grounded) this._velocity.y += P.gravity * dt`  <- gravity
 *   3. `this._move(dt)`                                           <- then move
 *
 * So the FIRST step of the rise is already taken at `v0 + g*dt`. The closed
 * form integrates from `v0` and overstates every apex by |g|dt^2/2 = 3.06 mm
 * per step, 5 cm over a jump. Horizontal speed is held constant, which is what
 * the live measurements show a forward-held jump actually does: 4.6 x 34/60 =
 * 2.607 m, and 2.607 m is what the browser reported.
 *
 * Collision is evaluated on the column at each new step:
 *   - the feet crossing DOWN through an interval top is a landing on it;
 *   - the feet arriving INSIDE an interval, having come at it sideways, is a
 *     wall - `blocked`, and it wins over a landing lower down in the same
 *     column because the body would be stopped before it got there.
 * Intervals are merged, so a wall standing on the ground is one interval and
 * the two cases can never both fire on the same solid.
 *
 * @param {ColumnIndex} idx
 * @param {{x:number,y:number,z:number}} from launch point, feet on the deck
 * @param {number} dirX unit heading
 * @param {number} dirZ unit heading
 * @param {{v:number,h:number}} budget
 * `maxSteps` is a property of the PROBE, not of the body: `MAX_FLIGHT_STEPS`
 * is 2 s, the right budget for a rooftop gap and 0.4 s short of the 46 m fall
 * a leap of faith actually makes. Asked with the default cap the great tower's
 * arc returns `timeout` at 23.29 m of run and the hay looks five metres
 * misplaced. `reachFor` already takes the same parameter for the same reason.
 *
 * @param {{maxDrop?:number, maxSteps?:number}} [opts]
 */
export function flyArc(idx, from, dirX, dirZ, budget, opts) {
  const steps = opts?.maxSteps ?? MAX_FLIGHT_STEPS;
  const floorY = from.y - (opts?.maxDrop ?? 120);
  let x = from.x; let z = from.z; let y = from.y;
  let vy = budget.v;
  let apex = y;
  let minClear = Infinity;

  for (let n = 1; n <= steps; n++) {
    vy += GRAVITY * DT;
    if (vy < -60) vy = -60;              // `Player`'s terminal velocity
    const nx = x + dirX * budget.h * DT;
    const nz = z + dirZ * budget.h * DT;
    const ny = y + vy * DT;

    const col = idx.column(nx, nz);
    let landTop = -Infinity; let landOwner = null;
    let blockTop = -Infinity; let blockOwner = null;
    let underTop = -Infinity;
    for (const iv of col) {
      if (iv.top <= ny) { if (iv.top > underTop) underTop = iv.top; }
      if (y >= iv.top - 1e-9 && ny <= iv.top) {
        if (iv.top > landTop) { landTop = iv.top; landOwner = iv.owner; }
      } else if (ny > iv.bot && ny < iv.top) {
        if (iv.top > blockTop) { blockTop = iv.top; blockOwner = iv.owner; }
      }
    }
    if (underTop > -Infinity) minClear = Math.min(minClear, ny - underTop);

    if (blockTop > landTop) {
      return { outcome: 'blocked', x: nx, y: ny, z: nz, top: blockTop, owner: blockOwner, steps: n, apex, minClear, vy };
    }
    if (landTop > -Infinity) {
      return { outcome: 'land', x: nx, y: landTop, z: nz, top: landTop, owner: landOwner, steps: n, apex, minClear, vy };
    }

    x = nx; z = nz; y = ny;
    if (y > apex) apex = y;
    if (y < floorY) return { outcome: 'fell', x, y, z, top: null, owner: null, steps: n, apex, minClear, vy };
  }
  return { outcome: 'timeout', x, y, z, top: null, owner: null, steps, apex, minClear, vy };
}

/**
 * Flat-ground reach and apex of a budget, with nothing in the way.
 *
 * Used only to prove the integrator against the six browser numbers. The world
 * is not consulted: this is the pure trajectory.
 */
export function freeFlight(budget) {
  let y = 0; let vy = budget.v; let dist = 0; let apex = 0;
  for (let n = 1; n <= MAX_FLIGHT_STEPS; n++) {
    vy += GRAVITY * DT;
    y += vy * DT;
    dist += budget.h * DT;
    if (y > apex) apex = y;
    if (y <= 0) return { flat: dist, apex, steps: n };
  }
  return { flat: dist, apex, steps: MAX_FLIGHT_STEPS };
}

/* ================================================================== */
/* Pads, arcs and the takeoff fan                                      */
/* ================================================================== */

/**
 * A place a body can stand: a height, and a footprint to land inside of.
 *
 * `box` is the collider that owns the deck top, so its footprint IS the pad -
 * for a souk house that is the roof lip, which overhangs the wall by 0.35 m and
 * is genuinely the thing you land on. Where the deck is terrain, or a slab too
 * big to be a single destination, there is no box and the pad is a disc of
 * radius `r` around the sample point instead.
 */
export function padAt(idx, x, z, opts) {
  const d = idx.deckAt(x, z, opts);
  if (!d) return null;
  const big = !d.owner || d.owner.area > 900;
  return {
    x, y: d.y, z,
    box: big ? null : d.owner,
    owner: d.owner,
    r: opts?.r ?? LATTICE * 0.5,
    headroom: d.headroom,
  };
}

/**
 * The pad an AUTHORED anchor names.
 *
 * `padAt` asks "what is the deck here"; this asks "what is the deck the author
 * said was here", which is a different question the moment anything is standing
 * on it. Used for `_roofs`, `_towers` and `viewpoints`, all of which publish
 * the exact height of the lip they mean. `buried` records the case where the
 * authored deck is not the top of its own column at all - a roof swallowed by a
 * taller neighbour - because that is a defect, not a pad.
 */
export function padForAnchor(idx, x, z, y) {
  const b = boxAt(idx, x, z, y);
  if (!b) return padAt(idx, x, z, { below: y + 0.8 });
  const above = idx.deckAt(x, z);
  return {
    x, y: b.top, z,
    box: b.area > 900 ? null : b,
    owner: b,
    r: LATTICE * 0.5,
    headroom: Infinity,
    buried: !!above && above.y > b.top + 0.05,
  };
}

/** Where the pad's own launch points are: its edge, or a ring at `r`. */
export function padPerimeter(pad, spacing = FAN_SPACING) {
  if (pad.box) return perimeterSamples(pad.box, spacing, 0.05);
  const out = [];
  const n = Math.max(8, Math.round((2 * Math.PI * pad.r) / spacing));
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2;
    out.push({ x: pad.x + Math.cos(a) * (pad.r - 0.05), z: pad.z + Math.sin(a) * (pad.r - 0.05), nx: Math.cos(a), nz: Math.sin(a) });
  }
  return out;
}

/**
 * What share of a pad is actually open sky.
 *
 * A souk roof with a dome on it is still a deck - you stand on the ring around
 * the dome - but a roof swallowed by a taller neighbour is not a deck at all,
 * and at the CENTRE those two look identical: `deckAt` answers something higher
 * than the lip in both cases. Sampling the interior separates them. Zero
 * exposure is a defect; anything above zero is furniture.
 */
export function padExposure(idx, pad, n = 5) {
  if (!pad.box) return 1;
  let open = 0; let total = 0;
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      const lx = ((i + 0.5) / n * 2 - 1) * (pad.box.hx - 0.05);
      const lz = ((j + 0.5) / n * 2 - 1) * (pad.box.hz - 0.05);
      const x = pad.box.x + lx * pad.box.cos + lz * pad.box.sin;
      const z = pad.box.z - lx * pad.box.sin + lz * pad.box.cos;
      total++;
      const d = idx.deckAt(x, z);
      if (d && Math.abs(d.y - pad.y) <= 0.05) open++;
    }
  }
  return total ? open / total : 0;
}

/** How far inside a pad a landing fell. Negative outside. */
export function padMargin(pad, x, z) {
  if (pad.box) return footprintMargin(pad.box, x, z);
  return pad.r - Math.hypot(x - pad.x, z - pad.z);
}

/**
 * Did this one arc, launched from this one point on this one bearing, land on
 * the target deck?
 *
 * Both halves of design §6's substitution for `worstStep` are here: the flight
 * itself refuses anything it hits on the way (apex clearance over every
 * intervening collider), and the arrival has to be `LANDING_MARGIN` inside the
 * target rather than merely at the right height, because the deck the arc came
 * down onto is only the target deck if the collider that owns it is the target
 * deck's collider.
 *
 * @param {{x:number,y:number,z:number}} from launch point, feet on the deck
 * @param {object} to target pad
 * @param {{v:number,h:number}} budget
 * @param {ColumnIndex} idx
 * @param {{heading?:number}} [opts] absolute heading in radians; defaults to
 *   the bearing from `from` to the pad centre.
 */
export function arcClears(from, to, budget, idx, opts) {
  let dirX; let dirZ;
  if (opts?.heading != null) {
    dirX = Math.cos(opts.heading); dirZ = Math.sin(opts.heading);
  } else {
    const dx = to.x - from.x; const dz = to.z - from.z;
    const len = Math.hypot(dx, dz) || 1;
    dirX = dx / len; dirZ = dz / len;
  }
  const flight = flyArc(idx, from, dirX, dirZ, budget);
  if (flight.outcome !== 'land') {
    /* The wall grab, and it is not a courtesy: `Player.fixedUpdate` offers
     * `freeClimb.tryAttach()` before the jump every frame Space is held with
     * forward pressed, and `Player.js:840` calls a running jump into a wall
     * "the interaction the citadel is built around". An arc that ends buried in
     * the TARGET deck's own wall, with that deck's top overhead, is a body
     * hanging off the target - so it is offered as a separate, weaker outcome
     * rather than folded into the landing, because Drop Two's gradient needs to
     * know which crossings are jumps and which are jumps that end in a climb.
     * `Climb.MAX_RISE` is 2.4 m for a one-shot mantle; a sustained grab is
     * bounded by the stamina bar instead. */
    if (opts?.grab && flight.outcome === 'blocked') {
      const wallTop = flight.top;
      const onTarget = to.box
        ? (flight.owner === to.box
          || (footprintMargin(to.box, flight.x, flight.z) >= -0.6
            && wallTop >= to.y - DECK_Y_TOL && wallTop <= to.y + 4.5))
        : Math.abs(wallTop - to.y) <= DECK_Y_TOL;
      const rise = wallTop - flight.y;
      if (onTarget && rise > 0 && rise <= CLIMB_SUSTAIN_M) {
        return { ok: true, reason: 'grab', via: 'grab', rise, flight, margin: NaN };
      }
    }
    return { ok: false, reason: flight.outcome, flight, margin: -Infinity };
  }
  const margin = padMargin(to, flight.x, flight.z);
  /* The pad is the collider that owns the deck top, so the usual test is
   * identity. The one loosening is for things STANDING on the pad: 30% of souk
   * roofs carry a dome whose collider is 3 m of box in the middle of the roof,
   * and an arc that comes down on it has still crossed the gap and arrived on
   * that building. Bounded above by 4.5 m and required to be `LANDING_MARGIN`
   * inside the pad's own footprint, which is tight enough that the only things
   * it can be are that roof's own dome and its own parapet. */
  const rightDeck = to.box
    ? (flight.owner === to.box
      || (footprintMargin(to.box, flight.x, flight.z) >= LANDING_MARGIN
        && flight.y >= to.y - DECK_Y_TOL && flight.y <= to.y + 4.5))
    : Math.abs(flight.y - to.y) <= DECK_Y_TOL;
  if (!rightDeck) return { ok: false, reason: 'wrong-deck', flight, margin };
  if (margin < LANDING_MARGIN) return { ok: false, reason: 'margin', flight, margin };
  return { ok: true, reason: 'ok', via: 'land', flight, margin };
}

/**
 * The takeoff fan: is this gap a ROUTE, or one lucky pixel?
 *
 * Perimeter samples every `FAN_SPACING` metres, each fanned +/-60 deg in 10 deg
 * steps about the bearing to the target. Samples that could not reach the
 * target even on a perfect flat arc are dropped before any simulation, which is
 * what keeps this affordable over three hundred souk edges.
 *
 * Returns the count of distinct takeoff POINTS that worked and the total count
 * of (point, bearing) PAIRS, because those are two different questions: one
 * point that works on eleven bearings is a corner you have to stand on.
 */
export function takeoffFan(src, dst, budget, idx, opts) {
  const spacing = opts?.spacing ?? FAN_SPACING;
  const halfDeg = opts?.halfDeg ?? FAN_HALF_DEG;
  const stepDeg = opts?.stepDeg ?? FAN_STEP_DEG;
  const minPoints = opts?.minPoints ?? ROUTE_MIN_POINTS;
  const minPairs = opts?.minPairs ?? ROUTE_MIN_PAIRS;

  let points = 0; let pairs = 0; let grabs = 0; let best = null;
  const reach = budget.flat + 2.0;
  for (const s of padPerimeter(src, spacing)) {
    // Cheapest possible rejection first: a launch point further from the pad
    // than a flat arc can travel cannot reach it however it is aimed.
    const near = padMargin(dst, s.x, s.z);
    const centre = Math.hypot(dst.x - s.x, dst.z - s.z);
    if (near < 0 && centre - (dst.box ? Math.hypot(dst.box.hx, dst.box.hz) : dst.r) > reach) continue;
    const base = Math.atan2(dst.z - s.z, dst.x - s.x);
    const from = { x: s.x, y: src.y, z: s.z };
    let hit = 0;
    for (let d = -halfDeg; d <= halfDeg + 1e-9; d += stepDeg) {
      const r = arcClears(from, dst, budget, idx, { heading: base + (d * Math.PI) / 180, grab: opts?.grab });
      if (!r.ok) continue;
      hit++; pairs++;
      if (r.via === 'grab') grabs++;
      if (!best || (r.margin || -1) > (best.margin || -1)) best = { margin: r.margin, via: r.via, from, deg: d, flight: r.flight };
    }
    if (hit > 0) points++;
    if (points >= minPoints && pairs >= minPairs) break;
  }
  return { points, pairs, grabs, route: points >= minPoints && pairs >= minPairs, best };
}

/**
 * The cheapest budget that makes this crossing a route, or null.
 *
 * `trivial` comes first and is not a jump at all: footprints within 0.6 m with
 * a step of at most `STEP_UP` between them is a stride, and calling that a
 * "walk jump" would inflate every histogram in the report.
 */
export function budgetFor(src, dst, idx, opts) {
  const gap = src.box && dst.box ? footprintGap(src.box, dst.box) : Math.hypot(dst.x - src.x, dst.z - src.z) - src.r - dst.r;
  if (gap <= 0.6 && Math.abs(dst.y - src.y) <= STEP_UP) return { id: 'trivial', gap, fan: null };
  for (const b of BUDGETS) {
    const fan = takeoffFan(src, dst, b, idx, opts);
    if (fan.route) return { id: b.id, gap, fan, grab: fan.grabs === fan.pairs };
  }
  return { id: 'impossible', gap, fan: null, grab: false };
}

/* ================================================================== */
/* Union-find                                                          */
/* ================================================================== */

export class UnionFind {
  constructor(n) { this.p = new Int32Array(n); for (let i = 0; i < n; i++) this.p[i] = i; this.n = n; }
  find(a) { let r = a; while (this.p[r] !== r) r = this.p[r]; while (this.p[a] !== r) { const nx = this.p[a]; this.p[a] = r; a = nx; } return r; }
  union(a, b) { const ra = this.find(a); const rb = this.find(b); if (ra === rb) return false; this.p[ra] = rb; return true; }
  components() { const m = new Map(); for (let i = 0; i < this.n; i++) { const r = this.find(i); m.set(r, (m.get(r) ?? 0) + 1); } return m; }
}

/* ================================================================== */
/* The jump graph                                                      */
/* ================================================================== */

/** Distance from `(x, z)` to a footprint. Zero inside it. */
export function footprintPointDist(b, x, z) {
  const m = footprintMargin(b, x, z);
  if (m >= 0) return 0;
  const c = footprintCorners(b);
  let best = Infinity;
  for (let i = 0; i < 8; i += 2) {
    const j = (i + 2) % 8;
    best = Math.min(best, segPointDist(x, z, c[i], c[i + 1], c[j], c[j + 1]));
  }
  return best;
}

/** Edge-to-edge XZ separation of two pads, whatever shape they are. */
export function padSeparation(a, b) {
  if (a.box && b.box) return footprintGap(a.box, b.box);
  if (a.box) return Math.max(0, footprintPointDist(a.box, b.x, b.z) - b.r);
  if (b.box) return Math.max(0, footprintPointDist(b.box, a.x, a.z) - a.r);
  return Math.max(0, Math.hypot(a.x - b.x, a.z - b.z) - a.r - b.r);
}

/**
 * Horizontal reach of a budget onto a deck `dy` metres below the launch.
 *
 * Simulated, never solved. A leap that lands 8 m down travels 14.4 m, nearly
 * twice its flat 7.57, and a prune written against the flat number alone would
 * silently declare half the descents in this world impossible.
 */
export function reachFor(budget, dy, maxSteps = MAX_FLIGHT_STEPS) {
  let y = 0; let vy = budget.v; let dist = 0;
  for (let n = 1; n <= maxSteps; n++) {
    vy += GRAVITY * DT;
    if (vy < -60) vy = -60;
    y += vy * DT;
    dist += budget.h * DT;
    if (y <= dy) return dist;
  }
  return dist;
}

/**
 * Can a body walk from `a` to `b` without a jump?
 *
 * Sampled every metre with `deckAt(x, z, {below: y + STEP_UP})`, which is the
 * whole reason `deckAt` takes a ceiling: without it the walk under the
 * gatehouse arch reads as a 14 m step onto the lintel, and every route through
 * the gate disappears.
 */
export function walkClear(idx, a, b) {
  const dx = b.x - a.x; const dz = b.z - a.z;
  const len = Math.hypot(dx, dz);
  const n = Math.max(1, Math.ceil(len / 1.0));
  const step = len / n;
  let y = a.y;
  let wasGround = !a.box && !a.owner;
  for (let i = 1; i <= n; i++) {
    const t = i / n;
    const d = idx.deckAt(a.x + dx * t, a.z + dz * t, { below: y + STEP_UP + 1e-6 });
    if (!d) return false;
    /* Ground to ground is a SLOPE and is held to `WALK_GRADIENT`; anything
     * with a collider at either end is a STEP and gets `STEP_UP`. Without the
     * split, a smooth 0.9-gradient hillside sampled every metre reads as a
     * staircase of legal 0.9 m risers - which is how a probe ends up claiming
     * a body can walk up something `Treasures.walkableAt` calls a cliff. */
    const onGround = !d.owner;
    const limit = (wasGround && onGround) ? WALK_GRADIENT * step : STEP_UP;
    if (Math.abs(d.y - y) > limit) return false;
    y = d.y;
    wasGround = onGround;
  }
  return Math.abs(y - b.y) <= STEP_UP;
}

/**
 * The tallest height difference a walk crosses between two pads this far
 * apart: a step if either end is built, a slope if both ends are ground.
 */
export function walkRise(a, b) {
  if (a.box || b.box || a.owner || b.owner) return STEP_UP;
  return Math.max(STEP_UP, WALK_GRADIENT * Math.hypot(b.x - a.x, b.z - a.z));
}

/**
 * Build the node set and every edge between the nodes.
 *
 * Nodes come from five places, exactly as design §6 lists them: `world._roofs`,
 * `world._towers` tops, the bridge planks, `world.viewpoints`, and a 6 m
 * eight-connected terrain lattice. They are keyed by the COLLIDER that owns the
 * deck top wherever that collider is small enough to be one destination, so a
 * lattice point that lands on a souk roof becomes the same node as the roof
 * rather than a second one floating on top of it.
 *
 * Four kinds of edge, and the direction of each is recorded because union-find
 * is blind to it:
 *   walk  - both ways, a stride with at most `STEP_UP` between decks
 *   jump  - one way, measured by `takeoffFan` at the cheapest budget that works
 *   climb - both ways, a wall with rest ledges no more than 29.3 m apart
 *   drop  - one way, off an edge onto whatever is underneath
 *
 * `components()` unions walk, climb and jump-in-either-direction, which is R1's
 * question. `reachableFrom()` walks the directed set, which is the honest one:
 * a 30 m drop is not a route back up.
 */
export class ReachGraph {
  constructor(world, idx) {
    this.world = world;
    this.idx = idx;
    this.nodes = [];
    this.byKey = new Map();
    this.lattice = new Map();
    this.edges = [];
    this.adj = [];
    this._build();
  }

  _key(pad) {
    if (pad.box) return `b${pad.box.index}`;
    return `c${Math.round(pad.x / LATTICE)},${Math.round(pad.z / LATTICE)},${Math.round(pad.y / 4)}`;
  }

  _add(pad, kind, label) {
    const key = this._key(pad);
    let id = this.byKey.get(key);
    if (id === undefined) {
      id = this.nodes.length;
      this.byKey.set(key, id);
      this.nodes.push({ id, key, kind: new Set([kind]), labels: [], pad });
      this.adj.push([]);
    }
    const n = this.nodes[id];
    n.kind.add(kind);
    if (label) n.labels.push(label);
    // A pad found from an authored anchor is a better centre than a lattice
    // dart that happened to clip the same roof.
    if (kind !== 'lattice' && n.pad.__lattice) { n.pad = pad; }
    if (kind === 'lattice') pad.__lattice = true;
    return id;
  }

  _link(a, b, kind, detail) {
    if (a === b) return;
    const e = { a, b, kind, detail };
    this.edges.push(e);
    this.adj[a].push(b);
    if (kind === 'walk' || kind === 'climb') this.adj[b].push(a);
  }

  _build() {
    const { world, idx } = this;

    /* ---- nodes -------------------------------------------------------- */
    /* The lattice covers the world's own CONTENT BOX, not a literal.
     *
     * It was `-33..33`, i.e. +-198 m, which was the whole playfield when this
     * file was written and is now the protected core alone. Every relic,
     * cache, viewpoint and venue the outer ring publishes would have resolved
     * to `undefined` in `nodeFor` and R6 would have gone green on a world
     * three quarters of which the probe could not see. `contentBounds` is the
     * box the world says it put things in, and it is the same box `Relics`
     * and `Caches` budget off, so the two can never disagree.
     */
    const cb = world.contentBounds ?? world.bounds;
    const gx0 = Math.floor(cb.min.x / LATTICE) - 1;
    const gx1 = Math.ceil(cb.max.x / LATTICE) + 1;
    const gz0 = Math.floor(cb.min.z / LATTICE) - 1;
    const gz1 = Math.ceil(cb.max.z / LATTICE) + 1;
    this.latticeSpan = { gx0, gx1, gz0, gz1 };
    for (let gx = gx0; gx <= gx1; gx++) {
      for (let gz = gz0; gz <= gz1; gz++) {
        const x = gx * LATTICE; const z = gz * LATTICE;
        const pad = padAt(idx, x, z);
        if (!pad) continue;
        const id = this._add(pad, 'lattice');
        this.lattice.set(`${gx},${gz}`, id);
      }
    }
    /* Authored anchors resolve through `padForAnchor`, not `padAt`. 30% of souk
     * roofs carry a dome collider standing 3 m proud of the middle of the deck,
     * which `deckAt` merges into the roof and then reports as the top of the
     * column - so `padAt` at the roof centre answers "the dome" and, once the
     * `below` cap excludes it, answers nothing at all. 44 of 191 souk roofs
     * vanished from the graph that way on the first pass. */
    for (const r of world._roofs) {
      const pad = padForAnchor(idx, r.x, r.z, r.y);
      if (pad) this._add(pad, r.ring === undefined ? 'roof' : 'souk');
    }
    for (const t of world._towers) {
      const pad = padForAnchor(idx, t.x, t.z, t.y);
      if (pad) this._add(pad, t.minaret ? 'minaret' : 'tower');
    }
    /* Stair treads, from `world._steps`.
     *
     * A tread is 1.3 m of run and the lattice darts every 6 m, so a flight is
     * either invisible or represented by two nodes several metres of height
     * apart with no edge between them. Either way the graph reports a one-way
     * world where the game has a staircase. The world publishes them for the
     * same reason it publishes its roofs: a probe that has to guess where the
     * stairs are is a probe that will get it wrong. */
    for (const t of world._steps ?? []) {
      const pad = padForAnchor(idx, t.x, t.z, t.y);
      if (pad) this._add(pad, 'step');
    }
    for (const v of world.viewpoints) {
      const pad = padForAnchor(idx, v.x, v.z, v.y);
      if (pad) this._add(pad, 'viewpoint', v.name);
    }
    // Bridge planks are not published anywhere, so they are DETECTED by their
    // collider shape; `isPlank` owns that shape for the whole file.
    this.planks = idx.boxes.filter(isPlank);
    for (const p of this.planks) {
      this._add({ x: p.x, y: p.top, z: p.z, box: p, owner: p, r: 1.1, headroom: Infinity }, 'plank');
    }

    /* ---- walk edges --------------------------------------------------- */
    // The lattice, eight-connected.
    for (const [gk, id] of this.lattice) {
      const [gx, gz] = gk.split(',').map(Number);
      for (const [dx, dz] of [[1, 0], [0, 1], [1, 1], [1, -1]]) {
        const other = this.lattice.get(`${gx + dx},${gz + dz}`);
        if (other === undefined || other === id) continue;
        const a = this.nodes[id].pad; const b = this.nodes[other].pad;
        if (Math.abs(a.y - b.y) > walkRise(a, b)) continue;
        if (!walkClear(this.idx, a, b)) continue;
        this._link(id, other, 'walk', null);
      }
    }
    // Everything else that is simply standing next to something else.
    const grid = new Map();
    const gk = (x, z) => `${Math.floor(x / 12)},${Math.floor(z / 12)}`;
    for (const n of this.nodes) {
      const k = gk(n.pad.x, n.pad.z);
      let l = grid.get(k); if (!l) grid.set(k, (l = [])); l.push(n.id);
    }
    this._grid = grid;
    const near = (n, radius) => {
      const out = [];
      const cx = Math.floor(n.pad.x / 12); const cz = Math.floor(n.pad.z / 12);
      const span = Math.ceil(radius / 12);
      for (let ix = cx - span; ix <= cx + span; ix++) {
        for (let iz = cz - span; iz <= cz + span; iz++) {
          for (const id of grid.get(`${ix},${iz}`) ?? EMPTY) {
            if (id <= n.id) continue;
            const o = this.nodes[id];
            if (Math.hypot(o.pad.x - n.pad.x, o.pad.z - n.pad.z) > radius) continue;
            out.push(o);
          }
        }
      }
      return out;
    };
    this._near = near;

    for (const n of this.nodes) {
      for (const o of near(n, 16)) {
        if (Math.abs(o.pad.y - n.pad.y) > walkRise(n.pad, o.pad)) continue;
        if (padSeparation(n.pad, o.pad) > 1.2) continue;
        if (!walkClear(this.idx, n.pad, o.pad)) continue;
        this._link(n.id, o.id, 'walk', null);
      }
    }

    /* ---- jump edges --------------------------------------------------- */
    /* Two prunes, and both are needed to make this affordable rather than
     * merely correct.
     *
     * The first is the walk components. Four fifths of the nodes here are
     * lattice points on flat mesa or flat desert, every one already strolling
     * distance from its eight neighbours; a jump edge between two nodes that
     * are ALREADY mutually walkable cannot change a component or a
     * reachability, so it is not worth simulating. Testing them anyway is what
     * made the first pass take 100 seconds.
     *
     * The second is the drop cap. A leap that lands 14 m down travels 18 m, so
     * "within jumping distance" over a rooftop world would mean a 42 m search
     * radius and a quarter of a million candidate pairs, nearly all of them a
     * roof and the street below it. Past -8 m the verb is not a jump, it is a
     * fall with a run-up, and `drops` already covers that with the
     * survivability question attached.
     */
    const walkUF = new UnionFind(this.nodes.length);
    for (const e of this.edges) if (e.kind === 'walk') walkUF.union(e.a, e.b);
    const JUMP_DROP_CAP = -8;
    const searchR = reachFor(BUDGET.leap, JUMP_DROP_CAP) + 12;
    for (const n of this.nodes) {
      for (const o of near(n, searchR)) {
        if (walkUF.find(n.id) === walkUF.find(o.id)) continue;
        const sep = padSeparation(n.pad, o.pad);
        for (const [src, dst] of [[n, o], [o, n]]) {
          const dy = dst.pad.y - src.pad.y;
          if (dy > BUDGET.leap.apex) continue;         // no budget gains more
          if (dy < JUMP_DROP_CAP) continue;            // that is a drop, not a jump
          if (sep > reachFor(BUDGET.leap, Math.min(0, dy)) + 1.0) continue;
          const b = budgetFor(src.pad, dst.pad, this.idx);
          if (b.id === 'impossible') continue;
          this._link(src.id, dst.id, b.id === 'trivial' ? 'walk' : 'jump', b);
        }
      }
    }

    /* ---- climb and drop edges ----------------------------------------- */
    this.drops = [];
    this.climbs = [];
    for (const n of this.nodes) {
      if (!n.pad.box) continue;
      if (n.kind.has('plank')) continue;
      const seen = new Set();
      for (const s of perimeterSamples(n.pad.box, 1.5, -0.45)) {
        const col = this.idx.column(s.x, s.z);
        const tops = col.map((c) => c.top).filter((t) => t <= n.pad.y - 0.5).sort((a, b) => b - a);
        // Drop: straight off the edge onto the first thing underneath.
        const below = this.idx.deckAt(s.x, s.z, { below: n.pad.y - 0.5 });
        if (below) {
          const target = this._nodeAt(s.x, s.z, below.y);
          const fall = n.pad.y - below.y;
          this.drops.push({ from: n.id, to: target, x: s.x, z: s.z, fall, y: below.y });
          if (target !== undefined && target !== n.id) this._link(n.id, target, 'drop', { fall });
        }
        // Climb: the ascent is broken by every ledge in this same column, so
        // the ladder is the column itself. R5's 29.3 m is the rung spacing.
        let prev = n.pad.y;
        let ok = true;
        let land = null;
        for (const t of tops) {
          if (prev - t > CLIMB_SUSTAIN_M) { ok = false; break; }
          prev = t; land = t;
        }
        if (ok && land !== null) {
          const target = this._nodeAt(s.x, s.z, land);
          if (target !== undefined && target !== n.id && !seen.has(target)) {
            seen.add(target);
            this.climbs.push({ from: target, to: n.id, rise: n.pad.y - land });
            this._link(target, n.id, 'climb', { rise: n.pad.y - land });
          }
        }
      }
    }
  }

  /**
   * The node whose pad covers `(x, z)` at height `y`, if there is one.
   *
   * The slack is `LATTICE * 0.75` rather than nothing, because a body that
   * lands on open terrain lands between lattice darts: at 6 m spacing the
   * furthest a point can be from every node centre is 4.24 m, and a tighter
   * tolerance reported half of every fall in the world as "landed nowhere".
   */
  _nodeAt(x, z, y, slack = LATTICE * 0.75) {
    let best; let bestD = Infinity;
    const cx = Math.floor(x / 12); const cz = Math.floor(z / 12);
    for (let ix = cx - 1; ix <= cx + 1; ix++) {
      for (let iz = cz - 1; iz <= cz + 1; iz++) {
        for (const id of this._grid.get(`${ix},${iz}`) ?? EMPTY) {
          const p = this.nodes[id].pad;
          if (Math.abs(p.y - y) > 0.4) continue;
          const d = -padMargin(p, x, z);
          if (d > slack || d >= bestD) continue;
          bestD = d; best = id;
        }
      }
    }
    return best;
  }

  /**
   * The rope bridges, recovered from their planks.
   *
   * Planks within 2.5 m of each other are one span. This exists to check §1.3
   * without trusting the generator: `_buildRopeBridges` INTENDS a span out to
   * the perimeter and then rejects it silently with `span > 90`, so the only
   * honest way to know how many bridges shipped is to count the ones that did.
   */
  bridges() {
    /* Grouped by HEADING, not by proximity. The four minaret spans meet at
     * their anchors, so a proximity cluster is one 88-plank ring and says
     * nothing; each span is laid at a single `dirY` and no two of the four
     * share one. */
    const groups = new Map();
    for (const p of this.planks) {
      const k = `${p.cos.toFixed(4)},${p.sin.toFixed(4)}`;
      let g = groups.get(k); if (!g) groups.set(k, (g = []));
      g.push(p);
    }
    const out = [];
    for (const g of groups.values()) {
      let span = 0; let a = g[0]; let b = g[0];
      for (const p of g) {
        for (const q of g) {
          const d = Math.hypot(p.x - q.x, p.z - q.z);
          if (d > span) { span = d; a = p; b = q; }
        }
      }
      out.push({
        planks: g.length, span,
        a: { x: a.x, y: a.top, z: a.z }, b: { x: b.x, y: b.top, z: b.z },
        maxRadius: Math.max(...g.map((p) => Math.hypot(p.x, p.z))),
      });
    }
    return out.sort((p, q) => q.span - p.span);
  }

  /**
   * Union-find over a chosen set of edge kinds. UNDIRECTED - say so.
   *
   * `_link` records a jump in `adj[a]` alone, so the graph knows perfectly well
   * that 57 of the souk's edges only work downhill. This method throws that
   * away: it unions both ends of every selected edge, so what it answers is
   * "are these decks linked by walk/jump edges in AT LEAST ONE direction",
   * which is a weaker sentence than "you can get there".
   *
   * That is the right question for the two things it is used for - the kinds
   * are the filter, and dropping `climb` is what separates "the rooftop network
   * joins up" from "a body with stamina can go anywhere" - but it must not be
   * read as reachability. The DIRECTED question is `reachableFrom(spawn)`,
   * which follows `adj` and therefore respects one-way jumps and drops; the
   * per-edge direction itself is pinned exactly by the `oneWay` count and the
   * `hardest` / `hardestWithGrab` histograms in the souk-gradient test.
   *
   * @param {string[]} [kinds] default walk + climb + jump, which is R1's
   *   question; `['walk', 'jump']` is the rooftop network without the walls.
   */
  components(kinds = ['walk', 'climb', 'jump']) {
    const want = new Set(kinds);
    const uf = new UnionFind(this.nodes.length);
    for (const e of this.edges) if (want.has(e.kind)) uf.union(e.a, e.b);
    return uf;
  }

  /** Forward-directed reachability. Drops count; climbing back up may not. */
  reachableFrom(start) {
    const seen = new Uint8Array(this.nodes.length);
    const stack = [start];
    seen[start] = 1;
    let n = 1;
    while (stack.length) {
      const a = stack.pop();
      for (const b of this.adj[a]) if (!seen[b]) { seen[b] = 1; n++; stack.push(b); }
    }
    return { seen, count: n };
  }

  /**
   * The node a world position stands on.
   *
   * Three attempts, loosening each time, because an objective site is a point
   * some unrelated system chose: it can sit on a dome, half over a parapet, or
   * 0.55 m above its own deck. The pad key, then any pad covering the column at
   * that height, then the nearest node within 4 m and 2 m.
   */
  nodeFor(x, z, y) {
    const pad = padAt(this.idx, x, z, y === undefined ? undefined : { below: y + 1.0 });
    if (pad) {
      const id = this.byKey.get(this._key(pad));
      if (id !== undefined) return id;
      const at = this._nodeAt(x, z, pad.y);
      if (at !== undefined) return at;
    }
    const target = pad ? pad.y : y;
    let best; let bestD = Infinity;
    const cx = Math.floor(x / 12); const cz = Math.floor(z / 12);
    for (let ix = cx - 1; ix <= cx + 1; ix++) {
      for (let iz = cz - 1; iz <= cz + 1; iz++) {
        for (const id of this._grid.get(`${ix},${iz}`) ?? EMPTY) {
          const p = this.nodes[id].pad;
          if (target !== undefined && Math.abs(p.y - target) > 2.0) continue;
          const d = Math.hypot(p.x - x, p.z - z) - Math.max(0, padMargin(p, x, z));
          if (d > 4 || d >= bestD) continue;
          bestD = d; best = id;
        }
      }
    }
    return best;
  }
}

/* ================================================================== */
/* The measurement                                                     */
/* ================================================================== */

/** A box footprint shrunk on all four sides. Used for the authored-vs-real gap. */
export function shrink(b, by) {
  return { x: b.x, z: b.z, cos: b.cos, sin: b.sin, hx: Math.max(0.01, b.hx - by), hz: Math.max(0.01, b.hz - by) };
}

/**
 * Every tangential and radial edge of the built souk, measured.
 *
 * Tangential edges join angular neighbours within a ring; radial edges join
 * each building to the nearest building one ring out. Both are measured
 * edge-to-edge between the ROOF LIP footprints, because the lip is the deck -
 * it overhangs the wall by 0.35 m on every side and it is what the feet land
 * on. The authored `w x d` gap is recorded alongside it, since that is the
 * figure the design's 2.1-7.1 m prediction was derived from.
 *
 * `corridor` marks the pair that straddles the processional route the generator
 * deliberately clears at every ring (`_buildSouk`, 0.26 rad about the gate
 * bearing). It is a real edge and it is in the histogram, but it is flagged,
 * because an implementer chasing connectivity must not close it.
 */
export function soukEdges(world, idx) {
  const rings = new Map();
  for (const r of world._roofs) {
    if (r.ring === undefined) continue;
    const pad = padForAnchor(idx, r.x, r.z, r.y);
    if (!pad?.box) continue;
    const list = rings.get(r.ring) ?? [];
    list.push({ ring: r.ring, roof: r, pad, ang: Math.atan2(r.z, r.x), buried: padExposure(idx, pad) === 0 });
    rings.set(r.ring, list);
  }
  for (const list of rings.values()) list.sort((a, b) => a.ang - b.ang);

  const edges = [];
  const push = (a, b, kind, corridor) => {
    const gap = footprintGap(a.pad.box, b.pad.box);
    const authored = footprintGap(shrink(a.pad.box, 0.35), shrink(b.pad.box, 0.35));
    const ab = budgetFor(a.pad, b.pad, idx);
    const ba = budgetFor(b.pad, a.pad, idx);
    const order = ['trivial', 'walk', 'sprint', 'leap', 'impossible'];
    const easy = order.indexOf(ab.id) <= order.indexOf(ba.id) ? ab.id : ba.id;
    const hard = order.indexOf(ab.id) >= order.indexOf(ba.id) ? ab.id : ba.id;
    /* Second opinion with the wall grab allowed. The uphill direction of a
     * souk edge is almost never a landing - `h = 5 + inward*9 + rnd*3.5` puts
     * 3.5 m of height noise inside every ring and a jump gains 1.109 m - but a
     * running jump into the taller neighbour's wall is a grab, and the design's
     * §4.2 gradient is meant to be authored in terms of "leap plus a mantle".
     * Measuring both is the only way to say which of the two it is. */
    const abG = ab.id === 'impossible' ? budgetFor(a.pad, b.pad, idx, { grab: true }) : ab;
    const baG = ba.id === 'impossible' ? budgetFor(b.pad, a.pad, idx, { grab: true }) : ba;
    const hardG = order.indexOf(abG.id) >= order.indexOf(baG.id) ? abG.id : baG.id;
    edges.push({
      kind, corridor: !!corridor, ring: a.ring, ringB: b.ring,
      buried: a.buried || b.buried,
      gap, authored, dy: b.pad.y - a.pad.y, pa: a.pad, pb: b.pad,
      a: { x: a.pad.x, y: a.pad.y, z: a.pad.z }, b: { x: b.pad.x, y: b.pad.y, z: b.pad.z },
      up: ab.id, down: ba.id, budget: easy, hardest: hard, hardestWithGrab: hardG,
    });
  };

  for (const [, list] of [...rings].sort((p, q) => p[0] - q[0])) {
    const n = list.length;
    // Nominal angular pitch of this ring; anything much wider is the corridor.
    const pitch = (Math.PI * 2) / n;
    for (let i = 0; i < n; i++) {
      const a = list[i]; const b = list[(i + 1) % n];
      let d = b.ang - a.ang; if (d < 0) d += Math.PI * 2;
      push(a, b, 'tangential', d > pitch * 1.6);
    }
  }
  const ringIds = [...rings.keys()].sort((p, q) => p - q);
  for (let k = 0; k < ringIds.length - 1; k++) {
    const inner = rings.get(ringIds[k]);
    const outer = rings.get(ringIds[k + 1]);
    const done = new Set();
    for (const a of inner) {
      let best = null; let bestD = Infinity;
      for (const b of outer) {
        const d = Math.hypot(b.pad.x - a.pad.x, b.pad.z - a.pad.z);
        if (d < bestD) { bestD = d; best = b; }
      }
      if (!best) continue;
      const key = `${a.pad.x.toFixed(2)}|${best.pad.x.toFixed(2)}`;
      if (done.has(key)) continue;
      done.add(key);
      push(a, best, 'radial', false);
    }
  }
  return edges;
}

/**
 * Every haystack, against the surface a falling body actually lands on.
 *
 * `T` is `deckAt` at the hay's own column, which for a hay standing proud on
 * the ground IS the hay - its collider is the top of that column - and for a
 * hay buried inside the inner-ward slab is the slab, 4 m over its head.
 * Acceptance is `h.y - T` in `[-1.5, +3.5]` inclusive, which is
 * `Parkour._softLandingAt`'s `dy > 1.5 || dy < -3.5` rejection read the right
 * way round.
 */
export function haystackReport(world, idx) {
  const out = [];
  for (let i = 0; i < world.haystacks.length; i++) {
    const h = world.haystacks[i];
    const d = idx.deckAt(h.x, h.z);
    const T = d ? d.y : null;
    const delta = T === null ? NaN : h.y - T;
    out.push({
      i, x: h.x, z: h.z, r: h.r, recorded: h.y, deck: T, delta,
      catches: T !== null && delta >= HAY_MIN && delta <= HAY_MAX,
      /* IDENTITY, not an index range. This read `i < world.viewpoints.length`,
       * which was true while the only haystacks built before the ramparts'
       * were the five viewpoints'. The outer ring interleaves them - each
       * region lays its terrace and span hay alongside its viewpoint's - so the
       * index says nothing, and the resolved `hay` object each viewpoint
       * publishes says it exactly. */
      viewpoint: world.viewpoints.some((v) => v.hay === h),
    });
  }
  return out;
}

/** Is a haystack close enough to `(x, z)` at deck height `y` to catch a body? */
export function hayAt(world, x, z, y) {
  for (const h of world.haystacks) {
    const dy = y - h.y;
    if (dy > 1.5 || dy < -3.5) continue;
    const r = (h.r ?? 3) + 0.6;
    if ((x - h.x) ** 2 + (z - h.z) ** 2 <= r * r) return h;
  }
  return null;
}

/**
 * Every roof edge, and what happens to a body that walks off it.
 *
 * `ReachGraph` already samples every deck perimeter every 1.5 m and resolves
 * what is underneath; this classifies the answers. R4 inverted: falling IS the
 * mechanic here, so the assertion is not "no edge drops you", it is "no edge
 * drops you somewhere you cannot survive and cannot get back from".
 */
export function fallReport(world, graph) {
  const rows = [];
  const uf = graph.components();
  for (const d of graph.drops) {
    const n = graph.nodes[d.from];
    if (n.kind.has('lattice') && n.kind.size === 1) continue;   // ground is not a roof edge
    if (n.kind.has('plank')) continue;
    const hay = hayAt(world, d.x, d.z, d.y);
    const to = d.to ?? graph.nodeFor(d.x, d.z, d.y + 0.5);
    const back = to !== undefined && uf.find(to) === uf.find(d.from);
    let verdict;
    if (d.fall <= FALL_DAMAGE_M) verdict = 'safe';
    else if (hay) verdict = 'hay';
    else if (d.fall < FALL_LETHAL_M) verdict = 'damage';
    else verdict = 'lethal';
    rows.push({ ...d, to, hay: !!hay, back, verdict, kinds: [...n.kind].join('+') });
  }
  return rows;
}

/** Relic and cache sites, placed by the systems that really place them. */
export async function objectiveSites(world, physics, scene) {
  const { Relics } = await import('../../src/systems/Relics.js');
  const { Caches } = await import('../../src/systems/Caches.js');
  const relics = new Relics({ scene, bus: null, physics, player: null, economy: null, worldManager: null });
  relics._onWorld('citadel', world);
  const caches = new Caches({
    bus: null, physics, player: null,
    loot: { spawn: () => ({ active: true }) },
    worldManager: { active: world }, waterVolumes: null,
  });
  caches._onWorld('citadel', world);
  return {
    relics: relics.sites.map((s) => ({ x: s.pos.x, y: s.pos.y, z: s.pos.z })),
    caches: caches.sites.map((s) => ({ kind: s.kind, x: s.pos.x, y: s.pos.y, z: s.pos.z })),
  };
}

/* ------------------------------------------------------------------ */
/* One pass, shared by every test                                      */
/* ------------------------------------------------------------------ */

export let _measured = null;
export function measure() {
  if (_measured) return _measured;
  _measured = (async () => {
    const t0 = Date.now();
    const { world, physics, scene } = await buildCitadel();
    const idx = new ColumnIndex(physics);
    const tBuild = Date.now();
    const graph = new ReachGraph(world, idx);
    const tGraph = Date.now();
    const edges = soukEdges(world, idx);
    const tEdges = Date.now();
    const hay = haystackReport(world, idx);
    const falls = fallReport(world, graph);
    const sites = await objectiveSites(world, physics, scene);

    const uf = graph.components();
    const spawn = graph.nodeFor(world.playerSpawn.x, world.playerSpawn.z, world.playerSpawn.y + 2);
    const main = spawn === undefined ? -1 : uf.find(spawn);
    const reach = spawn === undefined ? { seen: new Uint8Array(graph.nodes.length), count: 0 } : graph.reachableFrom(spawn);

    return {
      world, physics, scene, idx, graph, edges, hay, falls, sites, uf, spawn, main, reach,
      ms: { build: tBuild - t0, graph: tGraph - tBuild, edges: tEdges - tGraph, total: Date.now() - t0 },
    };
  })();
  return _measured;
}

/* ================================================================== */
/* Report helpers                                                      */
/* ================================================================== */

export const ORDER = ['trivial', 'walk', 'sprint', 'leap', 'impossible'];

export function stats(xs) {
  if (!xs.length) return { n: 0, min: NaN, mean: NaN, max: NaN, sd: NaN };
  const n = xs.length;
  let min = Infinity; let max = -Infinity; let sum = 0;
  for (const v of xs) { if (v < min) min = v; if (v > max) max = v; sum += v; }
  const mean = sum / n;
  const sd = Math.sqrt(xs.reduce((a, b) => a + (b - mean) ** 2, 0) / n);
  return { n, min, mean, max, sd };
}
export function pearson(xs, ys) {
  const mx = xs.reduce((a, b) => a + b, 0) / xs.length;
  const my = ys.reduce((a, b) => a + b, 0) / ys.length;
  let num = 0; let dx = 0; let dy = 0;
  for (let i = 0; i < xs.length; i++) { num += (xs[i] - mx) * (ys[i] - my); dx += (xs[i] - mx) ** 2; dy += (ys[i] - my) ** 2; }
  return num / Math.sqrt(dx * dy);
}
/** Counts of each bucket, in `ORDER`. */
export function histogram(rows, key = 'budget') {
  return ORDER.map((b) => rows.filter((e) => e[key] === b).length);
}
/**
 * Is this edge's HARD direction a jump that ends in a wall rather than on a
 * deck - a leap plus a mantle?
 *
 * `hardest` is measured with landings only; `hardestWithGrab` re-runs the fan
 * with `freeClimb.tryAttach` modelled. An edge that is impossible one way
 * without the grab and possible with it is exactly design §4.2's "a leap plus a
 * mantle or a short climb", and on the inner two rings it is authored: the
 * saw-tooth puts 1.6 m or 1.2 m of step between tangential neighbours against a
 * leap apex of 1.109 m.
 */
export const mantled = (e) => e.hardest === 'impossible' && e.hardestWithGrab !== 'impossible';
export const f = (v, w = 6, d = 2) => (Number.isFinite(v) ? v.toFixed(d) : '-').padStart(w);
export const i5 = (v) => String(v).padStart(5);

/**
 * Floor / achieved / ceiling, printed and then asserted.
 *
 * Every quantitative claim in this file goes through here, because a bare
 * `assert.ok(n >= 3)` tells the next reader nothing about how much room the
 * world has left. The ceiling is always computed by ablation - remove one
 * constraint, re-measure - so "3 of 11 haystacks" reads as "3, floor 3, and 11
 * if they were placed against a real surface", which is the sentence Drop Two
 * needs.
 */
export function floorCheck(label, floor, achieved, ceiling, note) {
  console.log(`  ${label.padEnd(52)} floor ${String(floor).padStart(6)} | achieved ${String(achieved).padStart(6)} | ceiling ${String(ceiling).padStart(6)}${note ? '   ' + note : ''}`);
  assert.ok(achieved >= floor, `${label}: achieved ${achieved} is below the floor ${floor}`);
  assert.ok(achieved <= ceiling, `${label}: achieved ${achieved} is above the ablation ceiling ${ceiling} - the ceiling is wrong`);
}

/* ================================================================== */
/* Tests                                                               */
/* ================================================================== */

