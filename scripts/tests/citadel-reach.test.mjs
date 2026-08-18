import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';

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
const MAX_FLIGHT_STEPS = 120;

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

const EMPTY = [];

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
function toLocal(b, x, z, out) {
  const dx = x - b.x;
  const dz = z - b.z;
  out[0] = dx * b.cos - dz * b.sin;
  out[1] = dx * b.sin + dz * b.cos;
  return out;
}

/** World point from a box-local `(lx, lz)`. */
function toWorld(b, lx, lz, out) {
  out[0] = b.x + lx * b.cos + lz * b.sin;
  out[1] = b.z - lx * b.sin + lz * b.cos;
  return out;
}

const _l = [0, 0];
const _w = [0, 0];

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

function segPointDist(px, pz, ax, az, bx, bz) {
  const vx = bx - ax;
  const vz = bz - az;
  const len2 = vx * vx + vz * vz;
  let t = len2 > 0 ? ((px - ax) * vx + (pz - az) * vz) / len2 : 0;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  const cx = ax + vx * t;
  const cz = az + vz * t;
  return Math.hypot(px - cx, pz - cz);
}

function projOverlap(cornersA, cornersB, ax, az) {
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
function padPerimeter(pad, spacing = FAN_SPACING) {
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
  let y = a.y;
  for (let i = 1; i <= n; i++) {
    const t = i / n;
    const d = idx.deckAt(a.x + dx * t, a.z + dz * t, { below: y + STEP_UP + 1e-6 });
    if (!d) return false;
    if (Math.abs(d.y - y) > STEP_UP) return false;
    y = d.y;
  }
  return Math.abs(y - b.y) <= STEP_UP;
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
    for (let gx = -33; gx <= 33; gx++) {
      for (let gz = -33; gz <= 33; gz++) {
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
        if (Math.abs(a.y - b.y) > STEP_UP) continue;
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
        if (Math.abs(o.pad.y - n.pad.y) > STEP_UP) continue;
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
function shrink(b, by) {
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
      viewpoint: i < world.viewpoints.length,
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

let _measured = null;
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

const ORDER = ['trivial', 'walk', 'sprint', 'leap', 'impossible'];

function stats(xs) {
  if (!xs.length) return { n: 0, min: NaN, mean: NaN, max: NaN, sd: NaN };
  const n = xs.length;
  let min = Infinity; let max = -Infinity; let sum = 0;
  for (const v of xs) { if (v < min) min = v; if (v > max) max = v; sum += v; }
  const mean = sum / n;
  const sd = Math.sqrt(xs.reduce((a, b) => a + (b - mean) ** 2, 0) / n);
  return { n, min, mean, max, sd };
}
function pearson(xs, ys) {
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
const f = (v, w = 6, d = 2) => (Number.isFinite(v) ? v.toFixed(d) : '-').padStart(w);
const i5 = (v) => String(v).padStart(5);

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
function floorCheck(label, floor, achieved, ceiling, note) {
  console.log(`  ${label.padEnd(52)} floor ${String(floor).padStart(6)} | achieved ${String(achieved).padStart(6)} | ceiling ${String(ceiling).padStart(6)}${note ? '   ' + note : ''}`);
  assert.ok(achieved >= floor, `${label}: achieved ${achieved} is below the floor ${floor}`);
  assert.ok(achieved <= ceiling, `${label}: achieved ${achieved} is above the ablation ceiling ${ceiling} - the ceiling is wrong`);
}

/* ================================================================== */
/* Tests                                                               */
/* ================================================================== */

/**
 * FLOOR. Nothing below this line means anything if this test is red.
 *
 * Six numbers, all measured in a live browser, all reproduced by `flyArc`'s
 * step order alone. The closed form gets the two apexes wrong by 5 cm in the
 * same direction and this is the test that would have caught that.
 */
test('FLOOR: the integrator reproduces the six numbers measured in a browser', () => {
  for (const b of BUDGETS) {
    const ff = freeFlight(b);
    console.log(`  ${b.id.padEnd(7)} flat ${ff.flat.toFixed(3)} m (browser ${b.flat})   apex ${ff.apex.toFixed(3)} m (browser ${b.apex})   ${ff.steps} steps`);
    assert.ok(Math.abs(ff.flat - b.flat) < 0.002, `${b.id} flat: got ${ff.flat.toFixed(4)}, browser ${b.flat}`);
    assert.ok(Math.abs(ff.apex - b.apex) < 0.002, `${b.id} apex: got ${ff.apex.toFixed(4)}, browser ${b.apex}`);
  }
  // And the closed form is wrong, which is why this test exists at all.
  assert.ok(Math.abs((6.4 ** 2) / (2 * 22) - 0.878) > 0.04, 'v^2/2g would have been 0.931');
});

/**
 * FLOOR. `deckAt`, on four columns whose answers are hand-checkable.
 *
 * The launch-beam column is the whole headroom clause in one probe: the crown
 * of the great tower is a perfectly good 13.4 m deck, and 5 cm above it sits
 * the beam a leap of faith launches from. A body cannot stand on the crown
 * there, so `deckAt` must answer the beam - and when the beam is excluded by a
 * ceiling it must answer NOTHING, not the crown.
 */
test('FLOOR: deckAt honours headroom, the ceiling, and merged columns', async () => {
  const { idx, physics } = await measure();
  assert.equal(idx.unhandled.length, 0, 'the column index must represent every collider in the world');
  assert.equal(idx.fields.length, 1, 'citadel registers exactly one heightfield');
  console.log(`  colliders ${physics.colliders.length}, boxes ${idx.boxes.length}, heightfields ${idx.fields.length}, unrepresented ${idx.unhandled.length}`);

  /* The inner-ward slab. (0, -25.5) used to be where the great tower's
   * haystack stood and it answered 20.0; Drop Two widened the tower's rest
   * galleries from 12.5 m to 15.4 m so that a step off the crown is caught
   * 5.32 m down instead of falling 47.60 m onto the ward, and that column is
   * now under the top gallery. The ward itself is two metres further out. */
  assert.equal(idx.deckAt(0, -28).y, 20, 'the ward slab top is 20.0');
  assert.ok(Math.abs(idx.deckAt(0, -25.5).y - 62.28) < 1e-9,
    'the great tower gallery now overhangs its own crown, which is what makes the fall survivable');
  // And the leap-of-faith hay stands ON the ward rather than inside it: 2.0 m
  // of thatch on a 20.0 m slab. It used to be recorded at 16.4, four metres
  // under the surface it was meant to catch a body on.
  assert.equal(idx.deckAt(0, 16.3).y, 22, 'the leap-of-faith haystack is thatch standing on the ward');

  // The launch beam. Column is [-50, 67.6] then [67.65, 68.15]: a 5 cm gap.
  const col = idx.column(0, -13);
  assert.equal(col.length, 2);
  assert.ok(Math.abs(col[0].top - 67.6) < 1e-6 && Math.abs(col[1].bot - 67.65) < 1e-6,
    `crown/beam column is ${JSON.stringify(col.map((c) => [c.bot, c.top]))}`);
  assert.ok(Math.abs(idx.deckAt(0, -13).y - 68.15) < 1e-6, 'deckAt under the beam is the beam');
  assert.equal(idx.deckAt(0, -13, { below: 68 }), null,
    'the crown has 0.05 m of headroom under the beam and is not a landing there');

  // The gatehouse arch. Unrestricted this is the lintel; walking, it is the road.
  assert.equal(idx.deckAt(0, 118).y, 28, 'the gatehouse lintel top is 28.0');
  assert.equal(idx.deckAt(0, 118, { below: 16 }).y, 14, 'under the arch the deck is the road at 14.0');
  assert.equal(idx.deckAt(0, 104).y, 14, 'the spawn deck is the mesa at 14.0');

  /* THE CURTAIN WALL IS A CLOSED RING, and it was not.
   *
   * `_buildCurtainWall` rotated every segment by `mid + pi/2` where the world
   * bearing of a box's local +X is `-t`, so the segments lay along
   * `-(mid + pi/2)` - off the tangent by `2*mid + pi`, which is zero only at
   * multiples of pi/2 and a full right angle at pi/4. Swept with `deckAt`, the
   * wall was a rosette: solid stone reaching in to r = 111.8 at some bearings
   * and open mesa AT r = 118 at others, so four of the six rampart haystacks
   * stood on a wall segment that had swung inland and the town was not walled
   * at all.
   *
   * The sweep is 360 samples at 1 degree, which is finer than the 9.0 m
   * segment pitch by an order of magnitude, so a single missing segment cannot
   * hide between two samples. The gate is the one deliberate opening. */
  /* The gate. `_buildCurtainWall` skips the segments whose mid-bearing is
   * within 0.1 rad of +Z, which is two of the forty, and each segment is
   * 0.083 rad wide - so the deliberate opening runs to 0.15 rad either side of
   * the gate and the gatehouse stands in the middle of it. Swept, the last
   * open bearing is at 0.1396 and 0.157 is wall again. */
  const GATE_HALF = 0.15;
  let open = 0;
  let worst = null;
  for (let i = 0; i < 360; i++) {
    const bearing = (i / 360) * Math.PI * 2;
    if (Math.abs(((bearing - Math.PI * 0.5 + Math.PI) % (Math.PI * 2)) - Math.PI) < GATE_HALF) continue;
    const d = idx.deckAt(Math.cos(bearing) * 118, Math.sin(bearing) * 118);
    // The wall walk is 23.0, a merlon 24.5, a wall tower 32.2, the gatehouse 28.
    if (!d || d.y < 22.9) { open++; if (!worst) worst = { bearing, y: d?.y ?? null }; }
  }
  console.log(`  curtain wall swept at 1 deg: ${open} of 360 bearings with no wall on them`);
  assert.equal(open, 0,
    `the curtain wall must be continuous; ${open} bearings are open mesa, first at ${worst && (worst.bearing * 180 / Math.PI).toFixed(0)} deg answering ${worst && worst.y}`);
  /* And no wall MASONRY may lie inside the pomerium, which is the lane the
   * rampart haystacks stand in. The band checked is the wall walk's own,
   * 20 m to 27 m: a rosette segment answered 23.0 here, which is what buried
   * four of the six haystacks on top of a wall that had swung inland.
   *
   * Masonry, not "anything". The two landfall rope bridges descend across this
   * lane by construction - `_buildRopeBridges` ties them to a wall tower at
   * 32.2 and lands them on an outer-souk roof at 20.5, so they cannot cross
   * r = 111.5 anywhere BUT inside a 20-27 band - and a plank ten metres over
   * the lane is not a wall. Measured, they answer 24.64/25.21 at bearing 247
   * and 24.67/25.24 at bearing 67.
   *
   * > This assertion previously read `deckAt(...)` and compared the single top
   * > answer, and it passed only by coincidence. At bearing 67 the
   * > `minaret-perimeter` long span also crosses that same one-degree column,
   * > at 32.30, and `deckAt` returns the HIGHEST interval - so the landfall
   * > planks underneath it were masked and 32.30 sailed over the 27 ceiling.
   * > At bearing 247 the matching `great-tower-perimeter` plank happens to
   * > land at 248 instead, nothing masked the landfall, and the same geometry
   * > read 25.21 and failed. The comment that stood here recorded the masking
   * > plank ("crossing it at 32.3") as though it were the landfall bridge.
   *
   * So the sweep now walks the WHOLE column rather than its top - which is
   * strictly stronger, because a wall segment hiding under a bridge used to be
   * invisible to it - and exempts planks by shape rather than by height, via
   * the same `isPlank` the graph builds its chains with. The exemption is
   * counted and pinned: four plank intervals on two bearings, which is the two
   * landfall spans and nothing else. A third bridge sagging into the lane, or
   * a wall segment swinging inland under one, both move that count. */
  let planksInBand = 0;
  const bridgedBearings = new Set();
  for (let i = 0; i < 360; i++) {
    const bearing = (i / 360) * Math.PI * 2;
    const deg = (bearing * 180 / Math.PI).toFixed(0);
    for (const iv of idx.column(Math.cos(bearing) * 111.5, Math.sin(bearing) * 111.5)) {
      if (iv.top < 20 || iv.top > 27) continue;
      if (isPlank(iv.owner)) { planksInBand++; bridgedBearings.add(deg); continue; }
      assert.fail(`no wall masonry may stand in the pomerium at r = 111.5; bearing ${deg} deg answers ${iv.top}`);
    }
  }
  console.log(`  pomerium at r = 111.5: ${planksInBand} rope-bridge planks in the 20-27 band, on bearings ${[...bridgedBearings].join(', ')}`);
  assert.deepEqual([...bridgedBearings].sort(), ['247', '67'],
    'only the two landfall spans may cross the pomerium in the wall-walk band');
  assert.equal(planksInBand, 4,
    'two planks per landfall span cross the band; a different count is a bridge that moved');
});

/**
 * FLOOR. The takeoff fan must actually reject the lucky pixel.
 *
 * Design §6 says a gap crossable from one point on one bearing is not a route.
 * That is only worth writing down if it changes an answer, so this re-buckets
 * every souk edge with the rule relaxed to one point and one bearing and
 * insists the two histograms differ. A fan that never rejects anything is a fan
 * that is not being applied.
 */
test('FLOOR: the route rule rejects crossings the single-arc test accepts', async () => {
  const { edges, idx } = await measure();
  let softer = 0;
  const sample = [];
  for (const e of edges) {
    if (e.budget === 'trivial') continue;
    const relaxed = budgetFor(e.pa, e.pb, idx, { minPoints: 1, minPairs: 1 });
    if (ORDER.indexOf(relaxed.id) < ORDER.indexOf(e.up)) {
      softer++;
      if (sample.length < 4) sample.push(`ring ${e.ring} ${e.kind} gap ${e.gap.toFixed(2)} dy ${e.dy.toFixed(2)}: ${relaxed.id} -> ${e.up}`);
    }
  }
  console.log(`  souk edges whose budget is harder under the route rule: ${softer} of ${edges.length}`);
  for (const s of sample) console.log(`    ${s}`);
  floorCheck('edges the route rule makes harder', 1, softer, edges.length);
});

/**
 * FLOOR. Every souk roof is a place a body can stand.
 *
 * `padExposure` is the probe that matters: 30% of these roofs carry a dome
 * collider 3 m tall in the middle of the deck, so "is the roof the top of its
 * own column" is false for 57 of them and means nothing. What means something
 * is whether ANY of the roof is open sky. The worst in the world is 0.36 -
 * a third of the deck - and zero would be a roof swallowed by a neighbour.
 */
test('FLOOR: every souk roof resolves to a pad with open sky over part of it', async () => {
  const { world, idx } = await measure();
  const souk = world._roofs.filter((r) => r.ring !== undefined);
  let resolved = 0; let worst = 1;
  for (const r of souk) {
    const pad = padForAnchor(idx, r.x, r.z, r.y);
    if (!pad?.box || Math.abs(pad.y - r.y) > 0.05) continue;
    const e = padExposure(idx, pad);
    if (e > 0) resolved++;
    worst = Math.min(worst, e);
  }
  console.log(`  souk roofs ${souk.length}, standable ${resolved}, worst open-sky share ${worst.toFixed(2)}`);
  floorCheck('souk roofs that are standable decks', 182, resolved, souk.length);
  // Was 191. `SOUK_RINGS` builds 200 and the processional corridor clears 18.
  assert.equal(souk.length, 182, 'the souk builds 182 roofs after the processional corridor is cleared');
});

/**
 * FLOOR + REPORT. The souk gap spectrum, and the two R2 claims settled.
 *
 * The design predicted "gaps of 2.1 m to 7.1 m about a 4.6 m mean with no
 * relationship to ring index". The measurement pass CONFIRMED the second half
 * (pearson r = 0.1485, per-ring spread 1.34 m) and REFUTED the first (the real
 * deck-to-deck mean was 2.01 m, 34 pairs physically overlapped).
 *
 * Drop Two authored the gradient the file header has always claimed, and this
 * test is now the assertion that it exists rather than the record that it does
 * not. Every number below moved deliberately; the pre-Drop-Two value is quoted
 * beside each one.
 *
 * The mechanism is in `SOUK_RINGS`: the footprint frame was turned to radial so
 * `w` is tangential width at every bearing, the +/-0.03 rad of angular jitter
 * (which was +/-3.1 m of slop at the outer ring) was deleted, and `w` is now
 * SOLVED from a target gap rather than rolled. What is left inside a ring is
 * +/-0.25 m of footprint noise, which shows up as a per-ring standard deviation
 * of 0.07 to 0.12 m against per-ring means 3.61 m apart.
 */
test('FLOOR: the souk gap spectrum is an authored gradient (design §4.2)', async () => {
  const { edges } = await measure();

  for (const kind of ['tangential', 'radial']) {
    for (const excl of [false, true]) {
      const set = edges.filter((e) => e.kind === kind && (!excl || !e.corridor));
      if (excl && set.length === edges.filter((e) => e.kind === kind).length) continue;
      console.log(`\n  -- ${kind}${excl ? ', processional corridor excluded' : ''} (${set.length} edges) --`);
      console.log('  ring |   n |  min |  mean |  max |   sd | trivial  walk sprint  leap  impos | mantle');
      const row = (label, rs) => {
        const s = stats(rs.map((e) => e.gap));
        console.log(`  ${label} |${i5(s.n)} |${f(s.min)} |${f(s.mean, 6)} |${f(s.max)} |${f(s.sd)} |` +
          histogram(rs).map((v) => i5(v) + ' ').join('') + `|${i5(rs.filter(mantled).length)}`);
      };
      for (const r of [...new Set(set.map((e) => e.ring))].sort((a, b) => a - b)) row(` ${String(r).padStart(2)}`, set.filter((e) => e.ring === r));
      row('ALL', set);
      const au = stats(set.map((e) => e.authored));
      console.log(`   authored w x d gap: min ${au.min.toFixed(2)} mean ${au.mean.toFixed(2)} max ${au.max.toFixed(2)}`);
      console.log(`   pearson r(ring, gap) = ${pearson(set.map((e) => e.ring), set.map((e) => e.gap)).toFixed(4)}`);
      const dyS = stats(set.map((e) => Math.abs(e.dy)));
      console.log(`   |dy| between decks: min ${dyS.min.toFixed(2)} mean ${dyS.mean.toFixed(2)} max ${dyS.max.toFixed(2)}`);
    }
  }

  const tan = edges.filter((e) => e.kind === 'tangential');
  const tanNC = tan.filter((e) => !e.corridor);
  const rad = edges.filter((e) => e.kind === 'radial');
  const gTan = stats(tanNC.map((e) => e.gap));
  const gRad = stats(rad.map((e) => e.gap));
  const aTan = stats(tanNC.map((e) => e.authored));

  console.log('\n  all souk edges ' + edges.length);
  console.log('    easier direction  : ' + ORDER.map((b, i) => `${b} ${histogram(edges)[i]}`).join(', '));
  console.log('    harder direction  : ' + ORDER.map((b, i) => `${b} ${histogram(edges, 'hardest')[i]}`).join(', '));
  console.log('    harder + wall grab: ' + ORDER.map((b, i) => `${b} ${histogram(edges, 'hardestWithGrab')[i]}`).join(', '));
  const oneWay = edges.filter((e) => e.hardest === 'impossible' && e.budget !== 'impossible').length;
  console.log(`    one-way (crossable in one direction only): ${oneWay}, of which ${edges.filter(mantled).length} are rescued by a wall grab`);

  /* The ablation ceiling for the histogram: keep the geometry and the drop, drop
   * the obstacles, the landing margin and the fan. Nothing can be easier than
   * this, so it is the ceiling every bucket is checked against. */
  const ablate = (e) => {
    if (e.gap <= 0.6 && Math.abs(e.dy) <= STEP_UP) return 'trivial';
    for (const b of BUDGETS) {
      for (const dy of [e.dy, -e.dy]) {
        if (dy <= b.apex && e.gap <= reachFor(b, Math.min(0, dy))) return b.id;
      }
    }
    return 'impossible';
  };
  const abl = ORDER.map((b) => edges.filter((e) => ablate(e) === b).length);
  console.log('    ABLATION (geometry and drop only, no obstacles, no margin, no fan):');
  console.log('      ' + ORDER.map((b, i) => `${b} ${abl[i]}`).join(', '));

  /* ---- the gradient, which did not exist before this drop ----------- */
  const ringMeans = [0, 1, 2, 3, 4, 5, 6].map((r) => stats(tanNC.filter((e) => e.ring === r).map((e) => e.gap)).mean);
  const ringSds = [0, 1, 2, 3, 4, 5, 6].map((r) => stats(tanNC.filter((e) => e.ring === r).map((e) => e.gap)).sd);
  const spread = Math.max(...ringMeans) - Math.min(...ringMeans);
  const r2 = pearson(tanNC.map((e) => e.ring), tanNC.map((e) => e.gap));
  const rRad = pearson(rad.map((e) => e.ring), rad.map((e) => e.gap));
  console.log(`\n  per-ring tangential means: ${ringMeans.map((v) => v.toFixed(2)).join(', ')}  spread ${spread.toFixed(2)} m, pearson ${r2.toFixed(4)}`);
  console.log(`  per-ring tangential sds:   ${ringSds.map((v) => v.toFixed(3)).join(', ')}`);
  // Was r = 0.1485 with a 1.34 m spread of ring means, which is noise.
  assert.ok(r2 < -0.9, `the tangential gradient must be monotone inward; pearson is ${r2.toFixed(4)} (was +0.1485, no relationship at all)`);
  assert.ok(rRad < -0.9, `the radial gradient must be monotone inward; pearson is ${rRad.toFixed(4)} (was +0.0904)`);
  assert.ok(spread > 3.0, `the spread of per-ring means is the gradient; ${spread.toFixed(2)} m (was 1.34 m)`);
  for (let i = 0; i < 6; i++) {
    assert.ok(ringMeans[i] > ringMeans[i + 1] + 0.3,
      `ring ${i} must be meaningfully wider than ring ${i + 1}: ${ringMeans[i].toFixed(2)} vs ${ringMeans[i + 1].toFixed(2)}`);
  }
  // A designed distribution is one whose within-ring scatter is small compared
  // with its between-ring separation. It was sd 2.03 m on a 1.34 m spread.
  assert.ok(Math.max(...ringSds) < 0.2,
    `within-ring scatter must stay under 0.2 m; worst is ${Math.max(...ringSds).toFixed(3)} (was 2.03 m over the whole souk)`);

  /* ---- the three bands the design asked for ------------------------- */
  console.log(`  tangential (corridor excluded) gap: min ${gTan.min.toFixed(2)} mean ${gTan.mean.toFixed(2)} max ${gTan.max.toFixed(2)} sd ${gTan.sd.toFixed(2)}`);
  console.log(`  authored w x d gap:                 min ${aTan.min.toFixed(2)} mean ${aTan.mean.toFixed(2)} max ${aTan.max.toFixed(2)}`);
  console.log(`  radial gap:                         min ${gRad.min.toFixed(2)} mean ${gRad.mean.toFixed(2)} max ${gRad.max.toFixed(2)}`);
  // Outer three rings: a sprint jump, and never more. Inner four: the leap,
  // and never less. Not one edge in either band falls on the wrong side.
  assert.deepEqual(histogram(tanNC.filter((e) => e.ring >= 4)), [0, 0, 107, 0, 0],
    'rings 6, 5 and 4 are sprint-jump rings, all 107 crossings');
  assert.deepEqual(histogram(tanNC.filter((e) => e.ring <= 3)), [0, 0, 0, 68, 0],
    'rings 3, 2, 1 and 0 require the leap, all 68 crossings');
  assert.ok(gTan.max < 7.17,
    `nothing may exceed the leap's usable reach of 7.17 m; the widest gap is ${gTan.max.toFixed(2)}`);
  assert.ok(gTan.min > 2.2,
    `nothing may be inside a walk jump either, or the outer rings teach nothing; the tightest is ${gTan.min.toFixed(2)}`);

  /* ---- and the mantle, which is the inner rings' whole character ----- */
  const mantleTan = (r) => tanNC.filter((e) => e.ring === r && mantled(e)).length;
  console.log(`  tangential crossings that need a leap AND a mantle, by ring: ${[0, 1, 2, 3, 4, 5, 6].map(mantleTan).join(', ')}`);
  assert.deepEqual([0, 1, 2, 3, 4, 5, 6].map(mantleTan), [10, 15, 0, 0, 0, 0, 0],
    'the saw-toothed inner two rings: every tangential crossing is uphill in one direction and needs a grab');
  assert.equal(edges.filter(mantled).length, 57,
    'the wall grab rescues exactly the uphill halves the gradient authored');

  /* ---- the histogram itself, asserted exactly ------------------------ */
  // Was [191, 149, 340]; the re-authored rings build 182 tangential and 140
  // radial edges over 182 roofs.
  assert.deepEqual([tan.length, rad.length, edges.length], [182, 140, 322], 'souk edge counts');
  assert.deepEqual(histogram(edges), [0, 40, 205, 70, 7], 'easier-direction budget histogram');
  assert.deepEqual(histogram(edges, 'hardest'), [0, 0, 148, 110, 64], 'harder-direction budget histogram');
  assert.deepEqual(histogram(edges, 'hardestWithGrab'), [0, 0, 180, 135, 7], 'harder direction once a wall grab is allowed');
  assert.equal(oneWay, 57, 'edges that only work downhill');
  assert.deepEqual(histogram(tanNC), [0, 0, 107, 68, 0], 'tangential, corridor excluded');
  assert.deepEqual(histogram(rad), [0, 40, 98, 2, 0], 'radial');
  assert.equal(tan.filter((e) => e.corridor).length, 7, 'one processional-corridor edge per ring, and it must stay open');
  // The seven impossible edges are the seven corridor edges and nothing else.
  // If that ever stops being true, something has been closed that should not be.
  assert.equal(edges.filter((e) => e.budget === 'impossible' && !e.corridor).length, 0,
    'the only uncrossable edges in the souk are the processional corridor');
  for (let i = 0; i < ORDER.length; i++) {
    const cum = (h) => h.slice(0, i + 1).reduce((a, b) => a + b, 0);
    assert.ok(cum(histogram(edges)) <= cum(abl), `ablation must dominate at ${ORDER[i]}`);
  }
  floorCheck('souk edges crossable at sprint or cheaper', 245, histogram(edges).slice(0, 3).reduce((a, b) => a + b, 0), abl.slice(0, 3).reduce((a, b) => a + b, 0));
  floorCheck('souk edges that need the leap', 70, histogram(edges)[3], edges.length, '(was 14 of 340, by accident)');
  floorCheck('souk edges that need a leap and a mantle', 57, edges.filter(mantled).length, edges.length, '(was 189, also by accident)');
});

/**
 * FLOOR. R1, asked twice, because before Drop Two the two answers disagreed
 * completely and the second one was the design's actual complaint.
 *
 * With climbing, Citadel was always ONE component - every plaster wall in this
 * world has a window course on it, so a body can get anywhere given stamina.
 * Take the walls away and ask the parkour question instead, and the citadel
 * core used to detach entirely: 32 components, and not one minaret, viewpoint
 * or bridge plank on the same rooftop network as the spawn.
 *
 * Drop Two joined them, and the route it joined them by is the one §1.3 always
 * described: out of the souk, across the pomerium on a landfall span, up onto
 * a wall tower, and 100 m back over the town on the perimeter bridge. The two
 * long spans are the ones `_buildRopeBridges` intended and rejected on the next
 * line for eight months; the two short ones are what make them worth having.
 */
test('FLOOR: the rooftop network reaches the perimeter and the citadel (design §4.1)', async () => {
  const { world, graph, uf, main, spawn, reach } = await measure();
  const kinds = ['tower', 'minaret', 'viewpoint', 'roof', 'souk', 'plank'];
  const wj = graph.components(['walk', 'jump']);
  const table = (label, u) => {
    const comps = u.components();
    const root = u.find(spawn);
    const sizes = [...comps.values()].sort((a, b) => b - a);
    console.log(`\n  ${label}`);
    console.log(`    components ${comps.size}, largest ${sizes[0]}, spawn's ${comps.get(root)}, singletons ${sizes.filter((s) => s === 1).length}`);
    const out = {};
    for (const k of kinds) {
      const ns = graph.nodes.filter((n) => n.kind.has(k));
      out[k] = [ns.length, ns.filter((n) => u.find(n.id) === root).length];
      console.log(`      ${k.padEnd(9)} ${i5(out[k][0])} total ${i5(out[k][1])} with spawn`);
    }
    return { comps, root, out };
  };
  const full = table('walk + climb + jump  (R1 as the design states it)', uf);
  const roof = table('walk + jump only     (the rooftop network, no wall climbs)', wj);
  console.log(`\n    forward-directed reachability from spawn (walk, climb, jump, drop): ${reach.count} / ${graph.nodes.length}`);
  for (const v of world.viewpoints) {
    const id = graph.nodeFor(v.x, v.z, v.y + 1);
    console.log(`      ${v.name.padEnd(16)} node ${String(id).padStart(4)}  R1 ${uf.find(id) === main ? 'yes' : 'NO'}   over the roofs ${wj.find(id) === roof.root ? 'yes' : 'NO'}   forward-reachable ${reach.seen[id] ? 'yes' : 'NO'}`);
  }
  const br = graph.bridges();
  console.log(`\n    rope bridges built: ${br.length}`);
  for (const b of br) console.log(`      ${String(b.planks).padStart(3)} planks, span ${b.span.toFixed(1).padStart(6)} m, y ${b.a.y.toFixed(1).padStart(5)} -> ${b.b.y.toFixed(1).padStart(5)}, max radius ${b.maxRadius.toFixed(1)} m`);

  /* ---- R1 with the walls: a floor, and it held before and holds now -- */
  assert.equal(full.comps.size, 1, 'R1: the jump graph is one connected component');
  for (const k of kinds) floorCheck(`R1  ${k} decks joined to spawn`, full.out[k][0], full.out[k][1], full.out[k][0]);
  assert.equal(reach.count, graph.nodes.length, 'every node is forward-reachable from spawn');

  /* ---- the rooftop network alone: this is what Drop Two moved --------
   *
   * These four are UNDIRECTED counts and the wording says so, because
   * `components` unions a one-way downhill jump as though it were two-way and
   * this world has 57 of those. "Linked to the spawn's rooftop component by
   * walk/jump edges" is the whole claim; it is not "you can walk and jump
   * there from the gate", which over the roofs alone is nobody, because
   * getting onto a roof at all is a climb. The directed statement is the
   * `reach.count` assertion above, which is 100% of the graph with the walls
   * in, and the per-edge directions are pinned exactly by `oneWay` and the
   * `hardest` histograms in the souk-gradient test. */
  // Was: 32 components, minaret 4/0, viewpoint 5/0, plank 88/0, tower 9/5,
  // roof 10/5, souk 191/191.
  assert.equal(roof.comps.size, 9, 'rooftop-only components (was 32)');
  assert.deepEqual(roof.out.minaret, [4, 4], 'every minaret is linked to the souk rooftop component (was 0 of 4)');
  assert.deepEqual(roof.out.viewpoint, [5, 5], 'every viewpoint is linked to it (was 0 of 5)');
  assert.deepEqual(roof.out.plank, [276, 276], 'every bridge plank is linked to it (was 0 of 88)');
  assert.deepEqual(roof.out.souk, [182, 182], 'the souk is one rooftop component, corridor and all');
  /* The six that are not are the wall towers no bridge lands on. Their
   * parapets stand 9.2 m over the wall walk, which is a free climb and not a
   * jump, so they are reachable but not over the roofs - and that is the
   * remaining headroom, quoted rather than hidden. */
  assert.deepEqual(roof.out.tower, [9, 3], 'the great tower and the two bridged wall towers (was 5 of 9)');
  assert.deepEqual(roof.out.roof, [10, 3], 'three of the ten non-souk roof decks');

  /* ---- §1.3, made real ---------------------------------------------- */
  assert.equal(br.length, 8, 'four minaret loops, two perimeter spans, two landfall spans');
  assert.equal(graph.planks.length, 276, 'planks in the world (was 88)');
  const long = br.filter((b) => b.span > 90);
  assert.equal(long.length, 2, 'two spans past the old 90 m rejection, which is why it was raised to 132');
  for (const b of long) {
    assert.ok(Math.abs(b.maxRadius - 118) < 0.5,
      `a perimeter span must actually reach the wall at r = ${118}, got ${b.maxRadius.toFixed(1)}`);
  }
  assert.ok(br.some((b) => Math.abs(b.span - 101.6) < 0.2), 'the great tower has a span at last');
  assert.ok(br.some((b) => Math.abs(b.span - 98.9) < 0.2), 'and the minaret span the comment always promised');

  /* ---- and every span is WALKABLE, measured plank by plank ----------- */
  const wjRoot = roof.root;
  console.log('\n    span                            planks   worst step   ends joined   both ends on the rooftop network');
  for (const b of world.ropeBridges) {
    const ai = graph.nodeFor(b.a.x, b.a.z, b.a.y + 0.5);
    const bi = graph.nodeFor(b.b.x, b.b.z, b.b.y + 0.5);
    const joined = ai !== undefined && bi !== undefined && wj.find(ai) === wj.find(bi);
    const onNet = ai !== undefined && wj.find(ai) === wjRoot && bi !== undefined && wj.find(bi) === wjRoot;
    console.log(`      ${b.id.padEnd(30)} ${String(b.planks).padStart(4)}   ${b.worstStep.toFixed(3).padStart(8)}   ${String(joined).padStart(11)}   ${onNet}`);
    assert.ok(b.worstStep <= STEP_UP,
      `${b.id}: a ${b.worstStep.toFixed(3)} m step between planks is a climb, not a walk (cap ${STEP_UP})`);
    assert.ok(joined, `${b.id}: the two anchors are not walk-connected, so the span is decoration`);
    assert.ok(onNet, `${b.id}: the span does not join the network the spawn is on`);
  }
  assert.equal(world.ropeBridges.length, 8, 'the world publishes every span it built');
});

/**
 * FLOOR. R3, and it is the defect the design opens with.
 *
 * `_buildDressing` placed every haystack with `_groundAt`, which is
 * `terrainH(hypot(x, z))` - pure terrain, blind to every structure ever built
 * on top of it. Eight of eleven stood under a surface they could not catch
 * anything from, and all five viewpoint stacks were inside the inner-ward slab,
 * invisible, with their colliders buried in another solid.
 *
 * Drop Two adds `_deckAt`, which asks the collision world, and leaves
 * `_groundAt` alone for the reason its own docstring now records: two callers
 * use it as the terrain DATUM a physics cast is compared against, and making it
 * a physics query turns both clearance probes into no-ops.
 *
 * The bearing was wrong as well as the height. `atan2(vp.z, vp.x)` is the
 * direction of the viewpoint from the middle of the world, which has nothing to
 * do with the way a player faces when they jump: the great tower's launch beam
 * points at +Z and the rule offset the hay to -Z, 12.5 m behind the jump. Each
 * viewpoint now publishes its own launch point and bearing.
 */
test('FLOOR: all eleven haystacks catch a falling body (design §4.1)', async () => {
  const { world, hay } = await measure();
  console.log('    # | kind      |      x |      z | recorded |  deck T |  h.y-T | catches');
  for (const h of hay) {
    console.log(`   ${String(h.i).padStart(2)} | ${(h.viewpoint ? 'viewpoint' : 'rampart').padEnd(9)} |${f(h.x, 7, 1)} |${f(h.z, 7, 1)} |${f(h.recorded, 9)} |${f(h.deck, 8)} |${f(h.delta, 7)} | ${h.catches ? 'YES' : 'no'}`);
  }
  const catching = hay.filter((h) => h.catches).length;
  /* The ablation: drop the height constraint and keep only "does this hay
   * stand over a surface at all", which is the one thing placement cannot fix
   * afterwards. A hay over a real deck can always be given a catching height;
   * a hay over nothing cannot. (This line used to read
   * `h.deck !== null && 2.4 >= HAY_MIN && 2.4 <= HAY_MAX` - the same count,
   * but written as a comparison of two literals that evaluates the same way
   * against every world there is.) */
  const ceiling = hay.filter((h) => h.deck !== null).length;
  floorCheck('haystacks that catch a falling body', 11, catching, ceiling, '(was 3 of 11)');
  assert.equal(catching, 11, 'every haystack works');
  assert.equal(hay.filter((h) => h.viewpoint && h.catches).length, 5,
    'including all five viewpoint stacks, which used to be inside the inner-ward slab');
  for (const h of hay) {
    assert.ok(h.deck !== null, `haystack ${h.i} stands over nothing at all`);
    /* There used to be an `assert.equal(h.catches, h.delta >= HAY_MIN &&
     * h.delta <= HAY_MAX)` here, restating `haystackReport`'s own definition of
     * `catches` back at it with the `T !== null` half already proved by the
     * line above. Both sides were the same expression, so no world - and no
     * mutation of one - could ever separate them. Deleted; `catching === 11`
     * above already pins the behaviour, and the interval's direction is pinned
     * by the delta band below, which a flipped interval would break. */
    // A hay standing proud on its own surface IS the top of its own column, so
    // the delta is the 0.3-0.4 m between the thatch and its recorded catch
    // height. Anything else means it is buried in something again.
    assert.ok(h.delta > 0 && h.delta < 0.5, `haystack ${h.i} is not standing on its own surface: h.y - T = ${h.delta.toFixed(2)}`);
  }
  assert.equal(world.haystacks.length, 11);

  /* The bearing repair, asserted rather than described. The great tower's hay
   * has to be on the +Z side of the tower, downrange of the beam, not on the
   * -Z side the radial rule put it on. */
  const gt = world.viewpoints.find((v) => v.id === 'great-tower');
  assert.ok(gt, 'the great tower publishes a viewpoint record');
  assert.ok(gt.hay.z > gt.z + 20, `the leap-of-faith hay must be downrange of the beam: hay z ${gt.hay.z.toFixed(1)} vs tower z ${gt.z}`);
  assert.ok(Math.abs(gt.hay.z - 16.3) < 0.01 && Math.abs(gt.hay.x) < 1e-6, 'and it is where the integrator says a leap comes down');
  /* Driven, not derived: a leap leaves the beam top at 68.15 and the ward is
   * 48.15 m below it, which the real stepper crosses in 28.53 m of run. From
   * the beam's root the keep roof gets in the way first at 22.32 m, which is a
   * 26.75 m fall - damage, not death. The hay covers the band between. */
  const drop = gt.launch.y - 20;
  /* 240 steps, not the shared 120. `MAX_FLIGHT_STEPS` is 2 s, which is the
   * right budget for a rooftop gap and is 0.4 s short of a 48 m fall - asked
   * with the default cap this returns 23.29 m and would have placed the hay
   * five metres short. The cap is a property of the probe, not of the body. */
  const run = reachFor(BUDGET.leap, -drop, 240);
  assert.ok(Math.abs(run - 28.53) < 0.02,
    `the run this hay is placed at must be the one the integrator produces: ${run.toFixed(2)}`);
  const land = gt.launch.z + run;
  assert.ok(Math.abs(land - gt.hay.z) <= gt.hay.r + 0.6,
    `a leap from the beam tip lands at z ${land.toFixed(2)} and the hay must catch it`);
});

/**
 * FLOOR. R4 inverted: falling is the mechanic, so the question is not whether
 * an edge drops you but whether the drop has an answer.
 *
 * Every deck perimeter, sampled every 1.5 m and stepped 0.45 m off the edge.
 * Twenty-five of those samples used to be a 47.60 m fall from the great tower's
 * crown onto the inner ward, past `LETHAL_SPEED` 42 m/s, and every single
 * unsurvivable sample in the world was that one edge - the crown overhung its
 * own rest galleries by 0.45 m, so a body stepping off cleared all six of them.
 *
 * The galleries are 2.2 m proud of the shaft now rather than 0.75, which puts
 * them 1.0 m outside the crown: the drop off the crown is caught 5.32 m down,
 * inside the 7.5 m at which fall damage begins at all. The tallest fall left in
 * Citadel is 21.40 m.
 */
test('FLOOR: no roof edge in the world is an unsurvivable fall (design §4.1)', async () => {
  const { falls } = await measure();
  const v = (k) => falls.filter((r) => r.verdict === k).length;
  const s = stats(falls.map((r) => r.fall));
  console.log(`    perimeter samples off real decks: ${falls.length}`);
  console.log(`      safe (<= ${FALL_DAMAGE_M} m)   ${i5(v('safe'))}`);
  console.log(`      caught by hay      ${i5(v('hay'))}`);
  console.log(`      damage             ${i5(v('damage'))}`);
  console.log(`      LETHAL (>= ${FALL_LETHAL_M} m) ${i5(v('lethal'))}`);
  console.log(`      landing unresolved ${i5(falls.filter((r) => r.to === undefined).length)}`);
  console.log(`      fall height: min ${s.min.toFixed(2)} mean ${s.mean.toFixed(2)} max ${s.max.toFixed(2)}`);

  assert.equal(falls.length, 6150, 'roof-edge samples (was 6700 over a wider souk)');
  assert.equal(v('lethal'), 0, 'no roof edge is a silent death (was 25, all of them the great tower crown)');
  assert.equal(v('safe'), 2863);
  assert.equal(v('hay'), 6);
  assert.equal(v('damage'), 3281);
  assert.ok(s.max < FALL_LETHAL_M,
    `the tallest fall off any deck must be survivable: ${s.max.toFixed(2)} m against a lethal ${FALL_LETHAL_M} m`);
  // Nothing lands anywhere it cannot get back from - that half of R4 held
  // before this drop and still holds.
  const stuck = falls.filter((r) => r.to !== undefined && !r.back).length;
  assert.equal(stuck, 0, 'a resolved landing is always back in the main component');
  floorCheck('roof-edge samples with a survivable outcome', falls.length, falls.length - v('lethal'), falls.length,
    '(was 6675 of 6700)');
});

/**
 * FLOOR. R6 and R7: an objective nobody can reach is not content.
 *
 * `Relics._onWorld` and `Caches._onWorld` are the real placers, called here
 * rather than modelled, so these are the exact sites the game will hide. They
 * read `world._towers` and `world._roofs` before they dart at random, which is
 * why the re-authored souk has to keep publishing both.
 *
 * The rooftop-only column is the one with room in it. It was 26 of 30 before
 * this drop, fell to 23 when the citadel core detached from the souk, and the
 * two landfall spans took it back to 26 - the four that are left are the wall
 * towers no bridge lands on, whose parapets stand 9.2 m over the wall walk.
 */
test('FLOOR: every relic and cache site is in the reachable component', async () => {
  const { graph, sites, uf, main, spawn, reach } = await measure();
  const wj = graph.components(['walk', 'jump']);
  const wjRoot = wj.find(spawn);
  const place = (s) => {
    const id = graph.nodeFor(s.x, s.z, s.y + 0.5);
    return {
      id,
      main: id !== undefined && uf.find(id) === main,
      roof: id !== undefined && wj.find(id) === wjRoot,
      reach: id !== undefined && !!reach.seen[id],
    };
  };
  const rp = sites.relics.map(place);
  const cp = sites.caches.map(place);
  const elevated = sites.relics.filter((s) => s.y > 14 + 3).length;
  console.log(`    relics ${sites.relics.length}: ${rp.filter((p) => p.main).length} in R1, ${rp.filter((p) => p.roof).length} on the rooftop-only network, ${rp.filter((p) => p.reach).length} forward-reachable, ${rp.filter((p) => p.id === undefined).length} unresolved`);
  console.log(`    relics more than 3 m above the mesa deck (R7): ${elevated}`);
  for (let i = 0; i < sites.caches.length; i++) {
    const s = sites.caches[i];
    console.log(`      cache ${s.kind} (${s.x.toFixed(1)}, ${s.y.toFixed(1)}, ${s.z.toFixed(1)})  R1 ${cp[i].main}  rooftop ${cp[i].roof}`);
  }
  assert.equal(sites.relics.length, 30, 'thirty relics on a 400 m world');
  assert.equal(sites.caches.length, 3, 'three high caches, no water so no sunken ones');
  floorCheck('R6  relic sites in the reachable component', 30, rp.filter((p) => p.main).length, 30);
  floorCheck('R6  cache sites in the reachable component', 3, cp.filter((p) => p.main).length, 3);
  floorCheck('R7  relic sites genuinely elevated', 30, elevated, 30);
  floorCheck('R6b relic sites on the rooftop-only network', 26, rp.filter((p) => p.roof).length, 30,
    '(ceiling = every relic reachable over the roofs)');
});

/**
 * FLOOR. What the rest of Drop Two consumes, proved to exist and to be true.
 *
 * Three publications, and each of them is a promise to another agent:
 *
 *   `world.minigameVenues`  the trial venues, in the shape
 *                           `MinigameManager._readVenue` (`:480-512`) reads.
 *                           `kind: 'rooftop'` has no factory yet, which that
 *                           file treats as "a published slot, not an error".
 *   `world._roofs` / `_towers`  the authored relic sites `Relics._onWorld`
 *                           (`:329-345`) consults before it darts at random.
 *   `world.viewpoints`      now carrying `launch`, `bearing` and the resolved
 *                           `hay`, which is what makes a leap-of-faith prompt
 *                           possible at all.
 *
 * The assertion that matters is not that the fields exist - it is that every
 * published coordinate stands on a deck that exists and is on the network the
 * player is on. A venue whose start line is 12 cm inside a roof is a venue the
 * swept checkpoint validator never fires, and this is the whole class of defect
 * the medieval expansion shipped four times.
 */
test('FLOOR: the world publishes venues, relic anchors and viewpoints that resolve', async () => {
  const { world, idx, graph, spawn } = await measure();
  const wj = graph.components(['walk', 'jump']);
  const wjRoot = wj.find(spawn);

  /* ---- trial venues -------------------------------------------------- */
  assert.ok(Array.isArray(world.minigameVenues) && world.minigameVenues.length === 3,
    'three rooftop trial venues are published');
  for (const v of world.minigameVenues) {
    const cps = v.config.checkpoints;
    let offDeck = 0;
    let offNet = 0;
    for (const c of cps) {
      const d = idx.deckAt(c.x, c.z, { below: c.y + 1.2 });
      if (!d || Math.abs(d.y - c.y) > 0.2) offDeck++;
      const id = graph.nodeFor(c.x, c.z, c.y + 0.5);
      if (id === undefined || wj.find(id) !== wjRoot) offNet++;
    }
    console.log(`    ${v.id.padEnd(20)} ${String(cps.length).padStart(2)} checkpoints, ${v.config.routeLength.toFixed(1).padStart(6)} m of route, ${offDeck} off their deck, ${offNet} off the rooftop network`);
    // The shape `MinigameManager._readVenue` insists on.
    assert.ok(typeof v.id === 'string' && v.id, `${v.id}: id`);
    assert.ok(typeof v.kind === 'string' && v.kind, `${v.id}: kind`);
    assert.ok(Number.isFinite(v.centre.x) && Number.isFinite(v.centre.z), `${v.id}: centre`);
    assert.ok(Number.isFinite(v.radius) && v.radius > 0, `${v.id}: radius`);
    assert.ok(Number.isFinite(v.yTolerance) && Number.isFinite(v.reward), `${v.id}: tolerance and reward`);
    assert.equal(v.requires, 'parkour', `${v.id}: a parkour contest needs the parkour rule`);
    assert.ok(cps.length >= 3, `${v.id}: a route needs checkpoints`);
    assert.equal(offDeck, 0, `${v.id}: every checkpoint must stand on the deck it names`);
    assert.equal(offNet, 0, `${v.id}: every checkpoint must be on the network the player is on`);
    // The dragon race's 5.2 m torus is wider than most of these roofs.
    assert.ok(v.config.ringRadius < 3, `${v.id}: the checkpoint marker radius must be authored, not inherited`);
    // No guessed medal times. `routeLength` is measured; par is not this
    // file's to invent, and inventing it is how three spec numbers went wrong.
    assert.ok(v.config.par === undefined, `${v.id}: par times must come from measured route times`);
  }
  assert.deepEqual(world.minigameVenues.map((v) => v.id).sort(),
    ['citadel_ascent', 'citadel_skyline', 'citadel_souk_dash']);

  /* ---- authored relic anchors ---------------------------------------- */
  let anchorsOff = 0;
  for (const a of [...world._roofs, ...world._towers]) {
    const b = boxAt(idx, a.x, a.z, a.y);
    if (!b) anchorsOff++;
  }
  console.log(`    authored anchors: ${world._roofs.length} roofs + ${world._towers.length} towers, ${anchorsOff} that no collider owns`);
  assert.equal(anchorsOff, 0, 'every published anchor is the top of a real collider');
  assert.equal(world._roofs.filter((r) => r.ring !== undefined).length, 182, 'souk roofs published');
  assert.equal(world._towers.length, 13, 'eight wall towers, the great tower and four minarets');

  /* ---- viewpoints ----------------------------------------------------- */
  assert.equal(world.viewpoints.length, 5);
  for (const v of world.viewpoints) {
    console.log(`    ${v.id.padEnd(12)} deck ${v.y.toFixed(1).padStart(5)}  launch ${v.launch ? `(${v.launch.x.toFixed(1)}, ${v.launch.y.toFixed(1)}, ${v.launch.z.toFixed(1)})` : '        none        '}  bearing ${((v.bearing * 180) / Math.PI).toFixed(0).padStart(4)} deg  hay (${v.hay.x.toFixed(1)}, ${v.hay.y.toFixed(1)}, ${v.hay.z.toFixed(1)}) r ${v.hay.r}`);
    assert.ok(typeof v.id === 'string' && v.id, 'a viewpoint needs a stable id');
    assert.ok(Number.isFinite(v.bearing), 'and a bearing to lay its haystack on');
    assert.ok(v.hay && Number.isFinite(v.hay.y), 'and a resolved haystack');
    const h = idx.deckAt(v.hay.x, v.hay.z);
    assert.ok(h && Math.abs(h.y - (v.hay.y - 0.4)) < 0.05, `${v.id}: the hay must be the top of its own column`);
    // A launch point is optional - see the leap-of-faith test below for why
    // four of the five withhold it - but a published one is a real surface.
    if (v.launch) {
      const d = idx.deckAt(v.launch.x, v.launch.z);
      assert.ok(d && Math.abs(d.y - v.launch.y) < 0.05, `${v.id}: the launch point must be a deck, got ${d?.y}`);
    }
    // The bearing is NOT the radial one - that was the bug.
    if (v.id === 'great-tower') {
      assert.notEqual(Math.round(v.bearing * 100), Math.round(Math.atan2(v.z, v.x) * 100),
        'the great tower launches along its beam, not along its radius');
    }
  }
});

/**
 * FLOOR. The dev harness's citadel framings, measured against the world they
 * claim to frame.
 *
 * §6 of the design makes `Harness.VIEWS` the mandatory pre-browser instrument,
 * and its own comment block says every framing "was checked against the world
 * as actually built". It was - against the PREVIOUS build. This drop re-sited
 * the souk (outer ring 109 -> 103.0, deck heights with it) and two framings
 * quietly stopped framing anything: `souk-alley` stood at r = 112, which is
 * open pomerium now, with its view ray hitting the town's outer face at 12.3 m
 * of a claimed 28.4; and `souk-roofs` stood at y 25.80 over a ring-5 deck that
 * had dropped from 24.21 to 21.31, floating 4.49 m above it.
 *
 * A stale framing is a screenshot of the wrong thing, and the whole point of
 * the harness is that a critique compares art direction rather than whatever
 * happened to be on screen. So the framings are pinned here, where the build
 * already exists, rather than being re-derived by hand after every re-author.
 */
test('FLOOR: every citadel harness framing still frames its own subject', async () => {
  const { idx, physics } = await measure();
  const { VIEWS } = await import('../../src/dev/Harness.js');
  const views = VIEWS.citadel.filter((v) => Array.isArray(v.pos));
  assert.ok(views.length >= 6, `only ${views.length} positioned citadel framings - the list collapsed`);

  const _p = new THREE.Vector3();
  const _d = new THREE.Vector3();
  const claims = views.filter((v) => Number.isFinite(v.clear));
  assert.ok(claims.length >= 2, 'no citadel framing states a sightline any more - the `clear` field went away');
  let held = 0;
  console.log('    framing           camera            deck   eye above   solid   first hit / view length   claims');
  for (const v of views) {
    const [x, y, z] = v.pos;
    const d = idx.deckAt(x, z);
    const above = d ? y - d.y : NaN;
    const inSolid = physics.containsPoint?.(_p.set(x, y, z)) === true;
    _d.set(v.look[0] - x, v.look[1] - y, v.look[2] - z);
    const len = _d.length();
    _d.normalize();
    const hit = physics.raycast(_p.set(x, y, z), _d, len, undefined);
    const reach = hit ? hit.distance : len;
    if (Number.isFinite(v.clear) && reach >= v.clear) held++;
    console.log(`    ${v.name.padEnd(16)} (${f(x, 7, 1)},${f(y, 6, 1)},${f(z, 7, 1)})${f(d?.y ?? NaN, 8)}${f(above, 12)}   ${inSolid ? 'YES' : ' no'}   ${f(reach, 7, 1)} / ${len.toFixed(1)}   ${Number.isFinite(v.clear) ? `>= ${v.clear.toFixed(1)} m` : '-'}`);

    assert.equal(inSolid, false, `${v.name}: the camera is inside a collider`);
    /* A grounded camera stands on something. 0.2 m is a step, 3.5 m is a
     * first-floor balcony; 4.49 m over its own roof - which is what
     * `souk-roofs` had after the souk was re-authored - is a camera hanging in
     * the air over the subject it names. Below the deck is worse: it is a
     * camera inside the building.
     *
     * `aerial: true` is the two framings that MEAN to hang in the air - the
     * bridge view 42 m over the ward and the desert overview 74 m over the
     * shoulder. The flag is on the data rather than inferred from the height,
     * because inferring it would make the rule say "a camera is grounded when
     * it is near the ground", which is not a rule. */
    if (!v.aerial) {
      assert.ok(above >= 0.2 && above <= 3.5,
        `${v.name}: the camera stands ${above.toFixed(2)} m over the deck at (${x}, ${z}) `
        + `(deck ${d?.y?.toFixed(2)}) - it no longer stands on what it says it stands on`);
    }
    /* ..and where a framing CLAIMS a sightline, the claim is checked.
     *
     * `clear` is that claim moved out of the prose and into the data, because
     * a metre count in a comment is a number nobody can fail. It is not a
     * blanket "the ray must reach its target": `gate-spawn` deliberately lets
     * the keep occlude the tower below y 43 and `ward-centre` looks across the
     * keep facade, so both stop well short by design and neither states a
     * distance. The two that do state one are the two that went stale:
     * `souk-alley` promised 28 m of unbroken street and delivered 12.3 once
     * the souk's outer ring moved in to r = 103, and `souk-roofs` promised the
     * tower's own face. */
    if (Number.isFinite(v.clear)) {
      assert.ok(reach >= v.clear,
        `${v.name}: claims ${v.clear.toFixed(1)} m of clear line of sight and the ray is stopped at `
        + `${reach.toFixed(1)} m - this framing is photographing whatever got in the way`);
    }
  }
  floorCheck('citadel framings whose stated sightline holds', claims.length, held, claims.length);
});

/**
 * FLOOR. ARRIVAL, not placement - the assertion the rest of this file's
 * haystack coverage was missing.
 *
 * `Viewpoints.normaliseViewpoint` treats `launch` + `hay` published together as
 * "this viewpoint HAS a leap of faith" and raises the prompt inside LEAP_R
 * 3.0 m of the launch point. So the world's decision to publish `launch` IS an
 * offer to a player standing there, and the only honest test of an offer is to
 * fly it and see where the body lands.
 *
 * Everything before this asserted the hay was PLACED well - on a real deck, on
 * the launch bearing, downrange of the beam. All of that was true of the four
 * minarets too, and none of the four arrived: measured through the real
 * integrator against the built colliders, minaret 1 landed 16.45 m from its own
 * hay at 40.7 m/s, minarets 2 and 4 hit the ward wall, and minaret 3 landed on
 * the great tower's rest gallery. That is design §1.1's defect at a new height,
 * and a placement test cannot see it.
 *
 * So: every offer is flown, and every viewpoint that does NOT offer is asserted
 * to publish nothing a prompt could attach to.
 */
test('FLOOR: every leap-of-faith offer lands in its own haystack (design §1.1)', async () => {
  const { world, idx } = await measure();
  // Imported here rather than at module scope for the reason `buildCitadel` is:
  // nothing under `src/` may be loaded before `harness()` has run.
  const { normaliseViewpoint } = await import('../../src/systems/Viewpoints.js');
  /* 900 steps, not the shared 120. The drop is 46 m and `MAX_FLIGHT_STEPS` is
   * 2 s of flight; the cap is a property of the probe. */
  const CAP = 900;
  const offers = world.viewpoints.filter((v) => v.launch);
  let arrived = 0;
  console.log('    viewpoint    offer   outcome                   landing         run    fall   to hay   caught');
  for (const v of world.viewpoints) {
    if (!v.launch) {
      console.log(`    ${v.id.padEnd(12)} no      -`);
      // No prompt can attach: `normaliseViewpoint` drops BOTH halves of the
      // pair, which is the mechanism the world relies on.
      const n = normaliseViewpoint(v, 0);
      assert.equal(n.launch, null, `${v.id}: publishes no launch, so it must normalise to none`);
      assert.equal(n.hay, null, `${v.id}: the pair is dropped together or the prompt has half a line`);
      continue;
    }
    const r = flyArc(idx, v.launch, Math.cos(v.bearing), Math.sin(v.bearing), BUDGET.leap, { maxSteps: CAP });
    const run = Math.hypot(r.x - v.launch.x, r.z - v.launch.z);
    const fall = v.launch.y - r.y;
    const toHay = Math.hypot(r.x - v.hay.x, r.z - v.hay.z);
    const caught = hayAt(world, r.x, r.z, r.y) !== null;
    if (caught) arrived++;
    console.log(`    ${v.id.padEnd(12)} yes     ${r.outcome.padEnd(8)} (${f(r.x, 7, 2)},${f(r.y, 7, 2)},${f(r.z, 7, 2)})${f(run, 8)}${f(fall, 8)}${f(toHay, 9)}   ${caught ? 'YES' : 'no'}`);
    assert.equal(r.outcome, 'land', `${v.id}: a published leap must end on a surface, not ${r.outcome}`);
    assert.ok(caught,
      `${v.id}: the leap lands at (${r.x.toFixed(2)}, ${r.y.toFixed(2)}, ${r.z.toFixed(2)}), `
      + `${toHay.toFixed(2)} m from its own hay after a ${fall.toFixed(2)} m fall - `
      + 'either the run is wrong or this viewpoint must stop publishing `launch`');
  }
  floorCheck('leap-of-faith offers that arrive in their hay', offers.length, arrived, offers.length);
  /* The count itself, pinned. A world that quietly stopped offering the leap
   * would satisfy every assertion above vacuously. */
  assert.equal(offers.length, 1,
    'the great tower is the only leap-of-faith platform; a minaret drop is 31.5 m onto the ward');
});
