import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

/**
 * AI competitors.
 *
 * ── Why these are not vehicles ────────────────────────────────────────────────
 *
 * The player's car (mounts/Car.js) is a contact-patch simulation: four ground
 * probes, a rate-limited ride spring, three collision capsules and a grip budget
 * that decides the corner radius. Nine more of those would cost 36 ground probes
 * and 27 capsule resolutions every fixed step, and would buy nothing - nobody
 * watches an opponent's suspension. What a rival has to do is arrive at the
 * right place at the right speed, lean into the corner, and be beatable.
 *
 * So a racer here is a *kinematic follower*: it owns a distance along the
 * centreline and a lateral offset from it, and integrates a speed rather than a
 * force. That has three consequences worth stating, because they are the whole
 * reason this is the right trade:
 *
 *   - It cannot leave the track, so it cannot drive into the scenery, and no
 *     collision work is needed to guarantee that. The track *is* the constraint.
 *   - Overtaking is a lateral-offset negotiation rather than an emergent
 *     collision outcome, which means it can be tuned to look deliberate.
 *   - One ground probe per racer per step is enough, because the only thing
 *     height is used for is standing the body on the road.
 *
 * ── Why the field has to be uneven ───────────────────────────────────────────
 *
 * A field of identical cars is a procession: they leave the grid in grid order,
 * hold station for the whole race and finish in grid order. Every racer
 * therefore draws its own top speed, cornering budget, acceleration, racing-line
 * bias and mistake rate, and *difficulty scales the whole field* rather than
 * replacing it - so "easy" is a slower, sloppier version of the same spread of
 * personalities rather than a different set of cars.
 *
 * Bodies reuse the car's registered material keys on purpose. Three keys its
 * shader program cache on material configuration, so a tinted clone of
 * `mount.carpaint` costs no new program - which is what lets nine cars appear
 * mid-session without the compile stall that a fresh material would cause. See
 * the note on the headlight in mounts/Car.js for the same argument at length.
 */

/* ---- module scratch. One block per function - sharing them has cost this
 * project two aliasing bugs already. ---- */
const _sm = { x: 0, y: 0, z: 0, width: 12, tx: 0, tz: -1 };
const _sm2 = { x: 0, y: 0, z: 0, width: 12, tx: 0, tz: -1 };
/* The driving loop gets its own pair, and nothing else may touch them.
 *
 * `_sm` is the default `sample` output *and* is used inside `curvature`, so a
 * lookahead parked in it is destroyed by the next call that samples anything -
 * which is what made every rival drive sideways: `wantHeading` ended up
 * measuring the vector from the car to its own centreline point, which is
 * perpendicular to the track by construction. */
const _smAhead = { x: 0, y: 0, z: 0, width: 12, tx: 0, tz: -1 };
const _smHere = { x: 0, y: 0, z: 0, width: 12, tx: 0, tz: -1 };

const clamp = THREE.MathUtils.clamp;
const damp = THREE.MathUtils.damp;

/* ---- proportions, metres. Deliberately close to the player's car so the
 * field reads as one class of machine. ---- */
const WHEEL_R = 0.34;
const WHEEL_W = 0.24;
const AXLE_Z = 1.30;
const HALF_TRACK = 0.80;
const AI_DRAGON_FLIGHT = 10;

/** Nine liveries, spaced round the wheel so no two rivals read as the same car. */
const LIVERIES = [
  { name: 'VANTA', color: 0xd8452f },
  { name: 'KESTREL', color: 0xf0a51e },
  { name: 'MERIDIAN', color: 0x8ee03a },
  { name: 'HALCYON', color: 0x2fbf78 },
  { name: 'OBSIDIAN', color: 0x38b6e0 },
  { name: 'ZEPHYR', color: 0x6d6ef0 },
  { name: 'RAMPART', color: 0xc257d8 },
  { name: 'CINDER', color: 0xf05a95 },
  { name: 'TALON', color: 0xb9c4cf },
];

/**
 * Difficulty scales the whole field at once.
 *
 * `pace` is a fraction of the reference top speed and is deliberately below,
 * at, and just above the player's boosted 34 m/s: on easy the player wins by
 * driving competently, on expert they have to hold a line. `spread` is how
 * unequal the field is - a wide spread on easy means the tail-enders fall away
 * and there is always someone to catch.
 */
export const DIFFICULTIES = {
  easy: { label: 'ROOKIE', pace: 0.74, spread: 0.17, grip: 0.78, mistakes: 2.2 },
  standard: { label: 'CONTENDER', pace: 0.88, spread: 0.12, grip: 0.92, mistakes: 1.0 },
  expert: { label: 'APEX', pace: 1.0, spread: 0.075, grip: 1.06, mistakes: 0.4 },
};

/** Reference top speed, m/s. The player's car boosts to 34. */
const REF_TOP = 33.5;
/** Reference lateral grip budget, m/s^2 - the same currency Car.js uses. */
const REF_LAT = 15.0;

/** Deterministic RNG, so a seed reproduces a field exactly. */
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/* ================================================================== */
/* Centreline                                                          */
/* ================================================================== */

/**
 * An arc-length parameterised closed centreline.
 *
 * Everything downstream works in *distance round the lap* rather than in sample
 * indices, because a racer's lookahead, its corner-speed probe and its gap to
 * the car in front are all distances - and a world is free to sample its
 * centreline unevenly.
 */
export class TrackPath {
  /** @param {Array<{x:number,y:number,z:number,width:number}>} samples ordered, closing implicitly */
  constructor(samples) {
    const pts = [];
    for (const s of samples ?? []) {
      const x = Number(s?.x);
      const z = Number(s?.z);
      if (!Number.isFinite(x) || !Number.isFinite(z)) continue;
      pts.push({
        x,
        y: Number.isFinite(Number(s.y)) ? Number(s.y) : 0,
        z,
        width: Math.max(4, Number(s.width) || 12),
      });
    }
    this.points = pts;
    this.n = pts.length;
    if (this.n < 3) {
      this.length = 0;
      this.cum = new Float32Array(1);
      return;
    }

    // cum[i] is the distance from sample 0 to sample i; cum[n] closes the loop.
    this.cum = new Float32Array(this.n + 1);
    for (let i = 0; i < this.n; i++) {
      const a = pts[i];
      const b = pts[(i + 1) % this.n];
      this.cum[i + 1] = this.cum[i] + Math.hypot(b.x - a.x, b.z - a.z);
    }
    this.length = this.cum[this.n];
  }

  get valid() {
    return this.n >= 3 && this.length > 1;
  }

  /** Wrap a lap distance into [0, length). */
  wrap(s) {
    const L = this.length;
    if (!(L > 0)) return 0;
    let v = s % L;
    if (v < 0) v += L;
    return v;
  }

  /**
   * Signed shortest difference `a - b` round the lap, in metres. Used for gaps
   * and for "is this car ahead of me" without a wrap-around special case at the
   * start/finish line.
   */
  delta(a, b) {
    const L = this.length;
    let d = (a - b) % L;
    if (d > L * 0.5) d -= L;
    if (d < -L * 0.5) d += L;
    return d;
  }

  /** Segment index containing lap distance `s`. Binary search over `cum`. */
  indexAt(s) {
    let lo = 0;
    let hi = this.n;
    while (lo < hi - 1) {
      const mid = (lo + hi) >> 1;
      if (this.cum[mid] <= s) lo = mid;
      else hi = mid;
    }
    return lo;
  }

  /**
   * Position, width and unit tangent at lap distance `s`.
   * @param {number} s
   * @param {object} [out] reused; never allocate in the drive loop
   */
  sample(s, out = _sm) {
    if (!this.valid) return out;
    const d = this.wrap(s);
    const i = this.indexAt(d);
    const a = this.points[i];
    const b = this.points[(i + 1) % this.n];
    const segLen = this.cum[i + 1] - this.cum[i];
    const t = segLen > 1e-4 ? (d - this.cum[i]) / segLen : 0;
    out.x = a.x + (b.x - a.x) * t;
    out.y = a.y + (b.y - a.y) * t;
    out.z = a.z + (b.z - a.z) * t;
    out.width = a.width + (b.width - a.width) * t;
    const dx = b.x - a.x;
    const dz = b.z - a.z;
    const len = Math.hypot(dx, dz) || 1;
    out.tx = dx / len;
    out.tz = dz / len;
    return out;
  }

  /**
   * Nearest lap distance to a world point.
   *
   * `hint` turns this from an O(n) scan into an O(1) window search, which is
   * what makes it affordable to call for ten racers every fixed step. A racer
   * always knows roughly where it was last step; only the initial placement and
   * the player - who can drive backwards, spin, or leave the road entirely -
   * pay for the full scan.
   */
  project(x, z, hint = -1) {
    if (!this.valid) return 0;
    let lo = 0;
    let hi = this.n;
    if (hint >= 0) {
      const i = this.indexAt(this.wrap(hint));
      lo = i - 6;
      hi = i + 14;
    }
    let best = 0;
    let bestD = Infinity;
    for (let k = lo; k < hi; k++) {
      const i = ((k % this.n) + this.n) % this.n;
      const a = this.points[i];
      const b = this.points[(i + 1) % this.n];
      const ex = b.x - a.x;
      const ez = b.z - a.z;
      const e2 = ex * ex + ez * ez;
      let t = e2 > 1e-6 ? ((x - a.x) * ex + (z - a.z) * ez) / e2 : 0;
      t = t < 0 ? 0 : t > 1 ? 1 : t;
      const px = a.x + ex * t;
      const pz = a.z + ez * t;
      const dd = (x - px) * (x - px) + (z - pz) * (z - pz);
      if (dd < bestD) {
        bestD = dd;
        best = this.cum[i] + (this.cum[i + 1] - this.cum[i]) * t;
      }
    }
    return this.wrap(best);
  }

  /**
   * Signed perpendicular offset of a point from the centreline at `s`, positive
   * to the right of travel.
   *
   * The right vector is `(-tz, tx)`, not `(tz, -tx)`: characters here face -Z
   * at yaw 0, so a tangent `t` corresponds to `yaw = atan2(-tx, -tz)` and the
   * right vector `(cos yaw, -sin yaw)` falls out as `(-tz, tx)`. Getting this
   * backwards mirrors every racing line in the field, which is invisible on a
   * symmetrical test circle and obvious on a real one.
   */
  lateralOf(x, z, s) {
    this.sample(s, _sm2);
    return (z - _sm2.z) * _sm2.tx - (x - _sm2.x) * _sm2.tz;
  }

  /**
   * Mean curvature (1/radius) over the next `span` metres from `s`.
   *
   * Sampled as a heading change rather than a second derivative: a world is
   * allowed to hand over a polyline, and differentiating a polyline twice gives
   * spikes at every vertex where a racer would brake for nothing.
   */
  curvature(s, span) {
    if (!this.valid) return 0;
    const a = this.sample(s, _sm);
    const ax = a.tx;
    const az = a.tz;
    const b = this.sample(s + span, _sm2);
    let dot = ax * b.tx + az * b.tz;
    dot = dot < -1 ? -1 : dot > 1 ? 1 : dot;
    return Math.acos(dot) / Math.max(1, span);
  }
}

/**
 * A circular test circuit.
 *
 * Kept in the shipping source rather than in a test file because it is what
 * makes this module verifiable *without* the race world: every lap-counting,
 * placement and payout path can be exercised against a synthetic track in any
 * world, which is how all of it was developed before the real circuit existed.
 *
 * @param {{ centre?:{x:number,y:number,z:number}, radius?:number, width?:number,
 *           samples?:number, checkpoints?:number, laps?:number }} [opts]
 */
export function makeTestCircuit(opts = {}) {
  const cx = opts.centre?.x ?? 0;
  const cy = opts.centre?.y ?? 0;
  const cz = opts.centre?.z ?? 0;
  const r = opts.radius ?? 55;
  const width = opts.width ?? 14;
  const n = Math.max(64, opts.samples ?? 240);
  const nCp = Math.max(4, opts.checkpoints ?? 12);

  const trackPath = [];
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2;
    trackPath.push({ x: cx + Math.cos(a) * r, y: cy, z: cz + Math.sin(a) * r, width });
  }
  const checkpoints = [];
  for (let i = 0; i < nCp; i++) {
    const a = (i / nCp) * Math.PI * 2;
    checkpoints.push({
      x: cx + Math.cos(a) * r,
      y: cy,
      z: cz + Math.sin(a) * r,
      radius: width * 0.75,
    });
  }
  // Grid: two columns behind the line, staggered like a real starting grid.
  const startGrid = [];
  for (let i = 0; i < 10; i++) {
    const back = 6 + Math.floor(i / 2) * 8;
    const a = -back / r; // arc behind the line, in radians
    const col = (i % 2 === 0 ? -1 : 1) * width * 0.22;
    const rr = r + col;
    startGrid.push({
      x: cx + Math.cos(a) * rr,
      y: cy,
      z: cz + Math.sin(a) * rr,
      // Travel is +a, so the tangent is (-sin a, cos a); forward is -Z at yaw 0,
      // which makes yaw = atan2(-tx, -tz).
      yaw: Math.atan2(Math.sin(a), -Math.cos(a)),
    });
  }
  return {
    trackPath,
    checkpoints,
    startGrid,
    lapCount: opts.laps ?? 3,
    difficulties: ['easy', 'standard', 'expert'],
    synthetic: true,
  };
}

/* ================================================================== */
/* Body                                                                */
/* ================================================================== */

/** Superellipse ring sample - the same trick the player's car uses for its shoulder. */
function superPoint(t, a, b, n, out) {
  const c = Math.cos(t);
  const s = Math.sin(t);
  const e = 2 / n;
  out.x = a * Math.sign(c) * Math.pow(Math.abs(c), e);
  out.y = b * Math.sign(s) * Math.pow(Math.abs(s), e);
  return out;
}

const _lf = { x: 0, y: 0 };

/** Loft a capped tube through cross sections ordered by z. */
function loftClosed(sections, R) {
  const S = sections.length;
  const pos = new Float32Array((S * R + 2) * 3);
  const uv = new Float32Array((S * R + 2) * 2);
  const idx = [];
  const z0 = sections[0].z;
  const zSpan = sections[S - 1].z - z0 || 1;

  for (let s = 0; s < S; s++) {
    const sec = sections[s];
    for (let i = 0; i < R; i++) {
      const t = (i / R) * Math.PI * 2;
      const upper = Math.sin(t) >= 0;
      superPoint(t, sec.hw, upper ? sec.top - sec.bl : sec.bl - sec.bot, upper ? 3.4 : 3.0, _lf);
      const k = (s * R + i) * 3;
      pos[k] = _lf.x;
      pos[k + 1] = sec.bl + _lf.y;
      pos[k + 2] = sec.z;
      const k2 = (s * R + i) * 2;
      uv[k2] = i / R;
      uv[k2 + 1] = (sec.z - z0) / zSpan;
    }
  }
  for (let s = 0; s < S - 1; s++) {
    for (let i = 0; i < R; i++) {
      const i2 = (i + 1) % R;
      idx.push(s * R + i, s * R + i2, (s + 1) * R + i);
      idx.push(s * R + i2, (s + 1) * R + i2, (s + 1) * R + i);
    }
  }
  const nose = S * R;
  const tail = nose + 1;
  pos[nose * 3 + 1] = sections[0].bl;
  pos[nose * 3 + 2] = sections[0].z;
  pos[tail * 3 + 1] = sections[S - 1].bl;
  pos[tail * 3 + 2] = sections[S - 1].z;
  uv[nose * 2] = 0.5;
  uv[tail * 2] = 0.5;
  uv[tail * 2 + 1] = 1;
  for (let i = 0; i < R; i++) {
    const i2 = (i + 1) % R;
    idx.push(nose, i2, i);
    idx.push(tail, (S - 1) * R + i, (S - 1) * R + i2);
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  geo.setIndex(idx);
  geo.computeVertexNormals();
  geo.computeBoundingSphere();
  return geo;
}

/** Loft the upper half only - the glasshouse, left open at the beltline. */
function loftShell(sections, R) {
  const S = sections.length;
  const pos = new Float32Array(S * R * 3);
  const uv = new Float32Array(S * R * 2);
  const idx = [];
  for (let s = 0; s < S; s++) {
    const sec = sections[s];
    for (let i = 0; i < R; i++) {
      const t = (i / (R - 1)) * Math.PI;
      superPoint(t, sec.hw, sec.top - sec.bl, 2.5, _lf);
      const k = (s * R + i) * 3;
      pos[k] = _lf.x;
      pos[k + 1] = sec.bl + _lf.y;
      pos[k + 2] = sec.z;
      const k2 = (s * R + i) * 2;
      uv[k2] = i / (R - 1);
      uv[k2 + 1] = s / (S - 1);
    }
  }
  for (let s = 0; s < S - 1; s++) {
    for (let i = 0; i < R - 1; i++) {
      idx.push(s * R + i, s * R + i + 1, (s + 1) * R + i);
      idx.push(s * R + i + 1, (s + 1) * R + i + 1, (s + 1) * R + i);
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  geo.setIndex(idx);
  geo.computeVertexNormals();
  geo.computeBoundingSphere();
  return geo;
}

const BODY_SECTIONS = [
  { z: -2.08, hw: 0.36, top: 0.70, bl: 0.55, bot: 0.34 },
  { z: -1.62, hw: 0.86, top: 0.79, bl: 0.60, bot: 0.24 },
  { z: -1.02, hw: 0.93, top: 0.86, bl: 0.68, bot: 0.22 },
  { z: -0.24, hw: 0.955, top: 0.92, bl: 0.75, bot: 0.21 },
  { z: 0.52, hw: 0.955, top: 0.93, bl: 0.76, bot: 0.21 },
  { z: 1.24, hw: 0.93, top: 0.90, bl: 0.73, bot: 0.23 },
  { z: 1.80, hw: 0.83, top: 0.85, bl: 0.66, bot: 0.29 },
  { z: 2.12, hw: 0.42, top: 0.77, bl: 0.58, bot: 0.38 },
];

const CANOPY_SECTIONS = [
  { z: -0.86, hw: 0.58, top: 0.94, bl: 0.90 },
  { z: -0.44, hw: 0.73, top: 1.19, bl: 0.915 },
  { z: 0.06, hw: 0.78, top: 1.30, bl: 0.925 },
  { z: 0.62, hw: 0.765, top: 1.26, bl: 0.92 },
  { z: 1.16, hw: 0.66, top: 1.06, bl: 0.905 },
  { z: 1.44, hw: 0.50, top: 0.94, bl: 0.90 },
];

/**
 * Every mesh the whole field shares.
 *
 * Built once and handed to nine cars: the geometry is identical, only the paint
 * colour differs, so nine copies would be nine times the memory for no visible
 * gain. `dispose` is refcount-free because the field owns it for the session.
 */
class RacerAssets {
  constructor(materials) {
    this.body = loftClosed(BODY_SECTIONS, 26);
    this.canopy = loftShell(CANOPY_SECTIONS, 14);

    const tyre = new THREE.CylinderGeometry(WHEEL_R, WHEEL_R, WHEEL_W, 16);
    tyre.rotateZ(Math.PI / 2);
    const hub = new THREE.CylinderGeometry(0.20, 0.20, WHEEL_W + 0.012, 12);
    hub.rotateZ(Math.PI / 2);
    this.tyre = tyre;
    this.hub = hub;

    // Dress: splitter, sills, rear wing and a diffuser, merged to one draw.
    const parts = [];
    const splitter = new THREE.BoxGeometry(1.80, 0.05, 0.34);
    splitter.translate(0, 0.22, -1.92);
    parts.push(splitter);
    for (const side of [-1, 1]) {
      const sill = new THREE.BoxGeometry(0.10, 0.10, 1.70);
      sill.translate(side * 0.92, 0.27, 0.16);
      parts.push(sill);
      const stay = new THREE.BoxGeometry(0.05, 0.28, 0.12);
      stay.translate(side * 0.52, 1.02, 1.92);
      parts.push(stay);
    }
    const wing = new THREE.BoxGeometry(1.44, 0.05, 0.30);
    wing.translate(0, 1.17, 1.94);
    parts.push(wing);
    const diffuser = new THREE.BoxGeometry(1.50, 0.06, 0.38);
    diffuser.translate(0, 0.25, 1.94);
    parts.push(diffuser);
    this.dress = mergeGeometries(parts, false);

    // Tail bar. Emissive-ish basic material, so it reads at 200 m without a light.
    this.tail = new THREE.BoxGeometry(1.30, 0.07, 0.05);
    this.tail.translate(0, 0.80, 2.10);

    this.dragonBody = new THREE.SphereGeometry(1, 18, 10);
    this.dragonHead = new THREE.SphereGeometry(1, 14, 8);
    this.dragonWing = new THREE.BufferGeometry();
    this.dragonWing.setAttribute('position', new THREE.Float32BufferAttribute([0, 0, -0.4, 3.2, 0, 0.8, 0.4, 0, 1.6], 3));
    this.dragonWing.setIndex([0, 1, 2]);
    this.dragonWing.computeVertexNormals();
    this.dragonTail = new THREE.ConeGeometry(0.34, 2.6, 10);
    this.dragonTail.rotateX(Math.PI / 2);
    this.dragonTail.translate(0, 0, 1.8);

    this.tyreMat = materials?.has?.('mount.tyre')
      ? materials.get('mount.tyre')
      : new THREE.MeshStandardMaterial({ color: 0x141416, roughness: 0.95, metalness: 0 });
    this.alloyMat = materials?.has?.('mount.alloy')
      ? materials.get('mount.alloy')
      : new THREE.MeshStandardMaterial({ color: 0x8e97a4, roughness: 0.3, metalness: 0.9 });
    this.glassMat = materials?.has?.('mount.carglass')
      ? materials.get('mount.carglass')
      : new THREE.MeshPhysicalMaterial({ color: 0x223642, transparent: true, opacity: 0.34, roughness: 0.08 });
    this.trimMat = materials?.has?.('mount.cartrim')
      ? materials.get('mount.cartrim')
      : new THREE.MeshStandardMaterial({ color: 0x121417, roughness: 0.8, metalness: 0.05 });
    this.tailMat = new THREE.MeshBasicMaterial({ color: 0xff3b26, toneMapped: false });
    this._materials = materials ?? null;
  }

  /** Livery paint. `tinted` caches by colour and shares every texture. */
  paint(color) {
    if (this._materials?.has?.('mount.carpaint')) {
      return this._materials.tinted('mount.carpaint', color, `race.paint#${color.toString(16)}`);
    }
    return new THREE.MeshStandardMaterial({ color, roughness: 0.25, metalness: 0.8 });
  }

  dispose() {
    for (const g of [this.body, this.canopy, this.tyre, this.hub, this.dress, this.tail, this.dragonBody, this.dragonHead, this.dragonWing, this.dragonTail]) g?.dispose?.();
    this.tailMat.dispose();
  }
}

/* ================================================================== */
/* Racer                                                               */
/* ================================================================== */

export class RacerAI {
  /**
   * @param {{ scene:THREE.Scene, physics:any, assets:RacerAssets, path:TrackPath,
   *           index:number, livery:{name:string,color:number}, rand:() => number }} ctx
   */
  constructor({ scene, physics, assets, path, index, livery, rand }) {
    this.id = `ai${index}`;
    this.index = index;
    this.name = livery.name;
    this.color = livery.color;
    this.scene = scene;
    this.physics = physics;
    this.path = path;
    this.isPlayer = false;

    /* ---- personality, before difficulty is applied ---------------------
     * Drawn once per race and kept, so a rival that was quick out of the
     * corners in lap one still is in lap five - a field whose character is
     * re-rolled every step reads as noise rather than as opponents. */
    this._r = {
      top: rand(),
      grip: rand(),
      accel: rand(),
      mistake: rand(),
      line: rand() * 2 - 1,
    };

    this.position = new THREE.Vector3();
    this.heading = 0;
    this.speed = 0;
    /** Lap distance along the centreline - the racer's real state. */
    this.s = 0;
    /** Signed offset from the centreline, metres. Positive is right of travel. */
    this.lateral = 0;
    this._lateralTarget = 0;
    /** Last step's lateral, for the direction-of-travel slip term. */
    this._prevLateral = 0;
    this._mistakeIn = 6;
    this._mistakeFor = 0;
    /** Accumulated contact damage, 0..1. Trims pace for the rest of the race. */
    this.damage = 0;
    /** Seconds left of the sharp pace loss that follows a hard hit. */
    this._stunFor = 0;
    /** Seconds before this car can score another impact. See Contacts.js. */
    this._hitCool = 0;
    this._roll = 0;
    this._pitch = 0;
    this._wheelSpin = 0;
    this._groundY = 0;
    this.mode = 'car';

    this._build(assets);
  }

  _build(assets) {
    this.root = new THREE.Group();
    this.root.name = `racer-${this.id}`;
    this.tilt = new THREE.Group();
    this.tilt.position.y = 0.45;
    this.root.add(this.tilt);
    const body = new THREE.Group();
    body.position.y = -0.45;
    this.tilt.add(body);
    this.body = body;

    // Only the shell casts. A car's shadow is one blob at any distance you ever
    // see a rival from, and the shell's footprint already contains the wheels
    // and the bodykit - so five extra shadow draws per car buy nothing. Nine
    // cars is 45 draw calls, measured, which is the difference between the
    // field being free and the field being noticeable.
    const shell = new THREE.Mesh(assets.body, assets.paint(this.color));
    shell.castShadow = true;
    shell.receiveShadow = true;
    body.add(shell);

    const canopy = new THREE.Mesh(assets.canopy, assets.glassMat);
    canopy.renderOrder = 8;
    body.add(canopy);

    const dress = new THREE.Mesh(assets.dress, assets.trimMat);
    body.add(dress);

    const tail = new THREE.Mesh(assets.tail, assets.tailMat);
    body.add(tail);

    this.wheels = [];
    for (let i = 0; i < 4; i++) {
      const front = i < 2;
      const sx = i % 2 === 0 ? -1 : 1;
      const spin = new THREE.Group();
      spin.position.set(sx * HALF_TRACK, WHEEL_R, front ? -AXLE_Z : AXLE_Z);
      const t = new THREE.Mesh(assets.tyre, assets.tyreMat);
      spin.add(t);
      const h = new THREE.Mesh(assets.hub, assets.alloyMat);
      spin.add(h);
      this.root.add(spin);
      this.wheels.push(spin);
    }

    this.dragon = new THREE.Group();
    this.dragon.visible = false;
    this.dragon.position.y = 0.2;
    const dragonMat = assets.paint(this.color);
    const bellyMat = new THREE.MeshStandardMaterial({ color: 0x2b1840, roughness: 0.7, metalness: 0.05 });
    const dBody = new THREE.Mesh(assets.dragonBody, dragonMat);
    dBody.scale.set(0.72, 0.42, 1.7);
    dBody.castShadow = true;
    this.dragon.add(dBody);
    const dHead = new THREE.Mesh(assets.dragonHead, dragonMat);
    dHead.position.set(0, 0.18, -1.72);
    dHead.scale.set(0.45, 0.36, 0.58);
    dHead.castShadow = true;
    this.dragon.add(dHead);
    const dTail = new THREE.Mesh(assets.dragonTail, dragonMat);
    dTail.castShadow = true;
    this.dragon.add(dTail);
    for (const side of [-1, 1]) {
      const wing = new THREE.Mesh(assets.dragonWing, bellyMat);
      wing.scale.x = side;
      wing.position.y = 0.12;
      wing.castShadow = true;
      this.dragon.add(wing);
    }
    this.root.add(this.dragon);

    this.carVisible = [this.tilt, ...this.wheels];
    this.root.visible = false;
    this.scene.add(this.root);
  }

  /**
   * Apply a difficulty band and put the car on its grid slot.
   * @param {{pace:number,spread:number,grip:number,mistakes:number}} band
   * @param {{x:number,y:number,z:number,yaw:number}} slot
   */
  reset(band, slot, mode = 'car') {
    this.mode = mode === 'dragon' ? 'dragon' : 'car';
    // Difficulty moves the whole field; the personality decides where in it.
    const vary = (r, spread) => 1 + (r - 0.5) * 2 * spread;
    this.topSpeed = REF_TOP * band.pace * vary(this._r.top, band.spread);
    this.latGrip = REF_LAT * band.grip * vary(this._r.grip, band.spread * 0.8);
    this.accel = (5.2 + this._r.accel * 3.4) * band.pace;
    this.mistakeRate = (0.4 + this._r.mistake * 1.1) * band.mistakes;
    // A racing line that is not the centreline is most of what makes two cars
    // in the same corner look like they are racing rather than queueing.
    this.lineBias = this._r.line * 0.30;

    this.position.set(slot.x, slot.y + (this.mode === 'dragon' ? AI_DRAGON_FLIGHT : 0), slot.z);
    this.heading = slot.yaw ?? 0;
    this.speed = 0;
    this.s = this.path.project(slot.x, slot.z, -1);
    this.lateral = this.path.lateralOf(slot.x, slot.z, this.s);
    this._lateralTarget = this.lateral;
    this._prevLateral = this.lateral;
    this._mistakeIn = 4 + this._r.mistake * 8;
    this._mistakeFor = 0;
    this.damage = 0;
    this._stunFor = 0;
    this._hitCool = 0;
    this._roll = 0;
    this._pitch = 0;
    this._groundY = slot.y;
    for (const part of this.carVisible) part.visible = this.mode !== 'dragon';
    this.dragon.visible = this.mode === 'dragon';
    this.root.visible = true;
    this._writeTransform();
  }

  setVisible(v) {
    this.root.visible = v;
  }

  /**
   * One fixed step of driving.
   *
   * @param {number} dt
   * @param {Array<{position:THREE.Vector3, s:number, lateral:number, speed:number}>} field
   *        every racer including the player, for the separation pass
   * @param {boolean} running false during the countdown and after the flag
   */
  fixedUpdate(dt, field, running) {
    if (!this.path.valid) return;

    if (!running) {
      this.speed = damp(this.speed, 0, 8, dt);
      this._writeTransform();
      return;
    }

    /* ---- where am I going -------------------------------------------- */
    // Lookahead scales with speed: a fixed distance either understeers wide at
    // 30 m/s or weaves at 8.
    const lookahead = clamp(6 + this.speed * 0.55, 8, 26);
    const ahead = this.path.sample(this.s + lookahead, _smAhead);

    /* ---- how fast may I take what is coming --------------------------- */
    // Probe further than the lookahead: braking has to start before the corner
    // is the thing being steered at.
    const brakeSpan = clamp(14 + this.speed * 1.5, 20, 70);
    const k = this.path.curvature(this.s, brakeSpan);
    // v = sqrt(a_lat / curvature) is the textbook cornering limit, and it is the
    // same grip budget the player's car spends - so a rival's corner speed is
    // directly comparable to what the player can carry.
    const cornerLimit = k > 1e-4 ? Math.sqrt(this.latGrip / k) : Infinity;
    let target = Math.min(this.topSpeed, cornerLimit);

    /* ---- mistakes ----------------------------------------------------- */
    this._mistakeIn -= dt * this.mistakeRate;
    if (this._mistakeIn <= 0) {
      this._mistakeIn = 5 + this._r.mistake * 9;
      this._mistakeFor = 0.5 + this._r.grip * 1.1;
    }
    if (this._mistakeFor > 0) {
      this._mistakeFor -= dt;
      // A mistake is a lift and a wide line, not a teleport: it costs a few
      // tenths and can be recovered from, which is what makes the field churn
      // instead of shuffling once and settling.
      target *= 0.68;
      this._lateralTarget += (this._r.line > 0 ? 1 : -1) * dt * 2.2;
    }

    /* ---- separation ---------------------------------------------------- */
    // Only cars within a car-length or two matter, and only their lateral
    // position does: the follower moves off line and lifts, exactly as it would
    // if it were about to run into the back of someone.
    let avoid = 0;
    let blocked = 0;
    for (let i = 0; i < field.length; i++) {
      const o = field[i];
      if (o === this) continue;
      const ds = this.path.delta(o.s, this.s);
      if (ds < -1 || ds > 16) continue;
      const dl = o.lateral - this.lateral;
      if (Math.abs(dl) > 3.2) continue;
      const close = 1 - clamp(ds / 16, 0, 1);
      avoid -= Math.sign(dl || (this.lineBias >= 0 ? 1 : -1)) * close * 3.4;
      if (ds < 7 && Math.abs(dl) < 2.0) blocked = Math.max(blocked, close);
    }
    // Lifting behind a car that cannot be passed is what stops the field
    // telescoping into one pile at the first hairpin.
    target *= 1 - blocked * 0.28;

    /* ---- contact damage ------------------------------------------------ */
    // A shunt has to cost the rival something the player can see, or hitting
    // one is indistinguishable from driving past it. The stun is the moment of
    // being knocked out of shape; the damage is what it carries to the flag.
    if (this._stunFor > 0) {
      this._stunFor -= dt;
      target *= 0.55;
    }
    if (this.damage > 0) target *= 1 - this.damage * 0.22;

    /* ---- lateral placement ------------------------------------------- */
    const halfRoad = Math.max(1.6, ahead.width * 0.5 - 1.3);
    this._lateralTarget = damp(this._lateralTarget, this.lineBias * halfRoad + avoid, 2.0, dt);
    this._lateralTarget = clamp(this._lateralTarget, -halfRoad, halfRoad);
    this.lateral = damp(this.lateral, this._lateralTarget, 3.2, dt);

    /* ---- longitudinal -------------------------------------------------- */
    // Braking is stronger than acceleration, as it is in any vehicle: a car
    // that decelerates at its accel rate arrives at every corner far too fast.
    const rate = target > this.speed ? this.accel : this.accel * 2.4;
    this.speed = this.speed + clamp(target - this.speed, -rate * dt, rate * dt);
    this.speed = Math.max(0, this.speed);

    /* ---- integrate along the track ------------------------------------ */
    this.s = this.path.wrap(this.s + this.speed * dt);
    const here = this.path.sample(this.s, _smHere);
    // Right of travel - see `lateralOf` for why it is this way round.
    const nx = -here.tz;
    const nz = here.tx;
    this.position.x = here.x + nx * this.lateral;
    this.position.z = here.z + nz * this.lateral;

    if (this.mode === 'dragon') {
      const bob = Math.sin(this.s * 0.035 + this.index * 1.7) * 1.15;
      this._groundY = here.y;
      this.position.y = here.y + AI_DRAGON_FLIGHT + bob;
    } else {
      // Height comes from the world, not from the centreline: the track may be
      // banked or crest, and a car floating 40 cm over a rise is the first thing
      // anyone notices.
      const g = this.physics?.groundHeight?.(this.position.x, this.position.z, here.y + 3.5, 9);
      const wantY = g === null || g === undefined ? here.y : g;
      // Damped rather than snapped, so a probe that misses for one step (a kerb,
      // a seam between two colliders) does not drop the car through the road.
      this._groundY = damp(this._groundY, wantY, 12, dt);
      this.position.y = this._groundY;
    }

    /* ---- presentation -------------------------------------------------- */
    /* Point the body along the direction it is actually travelling.
     *
     * The lookahead is the right input for *deciding* where to go, and the
     * wrong one for deciding which way the car faces: aiming the body at a
     * point up to 26 m down the road makes it sit visibly inside its own path
     * all the way through a corner - measured at a median of 8.5 degrees and a
     * worst of 18, where a real car runs a slip angle of two or three.
     *
     * Direction of travel is the tangent here plus however fast the lateral
     * offset is changing, which is the exact derivative of the position this
     * car is integrating. A small share of the lookahead aim is blended back in
     * so it still turns in *slightly* early, the way something with a driver in
     * it does. */
    const latRate = (this.lateral - this._prevLateral) / Math.max(dt, 1e-4);
    this._prevLateral = this.lateral;
    const slip = clamp(latRate / Math.max(Math.abs(this.speed), 5), -0.45, 0.45);
    const aimX = ahead.x + -ahead.tz * this._lateralTarget - this.position.x;
    const aimZ = ahead.z + ahead.tx * this._lateralTarget - this.position.z;
    const aimLen = Math.hypot(aimX, aimZ) || 1;
    const LEAD = 0.14;
    const dirX = here.tx + nx * slip + (aimX / aimLen) * LEAD;
    const dirZ = here.tz + nz * slip + (aimZ / aimLen) * LEAD;
    const wantHeading = Math.atan2(-dirX, -dirZ);
    let diff = ((wantHeading - this.heading + Math.PI) % (Math.PI * 2)) - Math.PI;
    if (diff < -Math.PI) diff += Math.PI * 2;
    const turn = clamp(diff, -3.0 * dt, 3.0 * dt);
    this.heading += turn;

    /* Roll from the turn actually being made, not from the corner's curvature
     * with a sign borrowed from the heading error. Lateral acceleration is
     * `v * yawRate`, so this leans out of the corner by as much as the car is
     * really turning - and it stays still on a straight instead of twitching
     * with the sign of a near-zero number. */
    const yawRate = turn / Math.max(dt, 1e-4);
    this._roll = damp(this._roll, clamp(-yawRate * this.speed * 0.0042, -0.11, 0.11), 5, dt);
    this._pitch = damp(this._pitch, clamp((target - this.speed) * -0.006, -0.05, 0.05), 5, dt);
    if (this.mode === 'dragon') {
      this._pitch = damp(this._pitch, clamp((target - this.speed) * -0.012, -0.18, 0.18), 4, dt);
      this._roll = damp(this._roll, clamp(-yawRate * this.speed * 0.009, -0.42, 0.42), 4, dt);
    }
    this._wheelSpin += (this.speed / WHEEL_R) * dt;

    this._writeTransform();
  }

  _writeTransform() {
    this.root.position.copy(this.position);
    this.root.rotation.y = this.heading;
    this.tilt.rotation.set(this._pitch, 0, this._roll);
    if (this.mode !== 'dragon') for (let i = 0; i < 4; i++) this.wheels[i].rotation.x = this._wheelSpin;
    else if (this.dragon) {
      const flap = Math.sin(this._wheelSpin * 0.18 + this.index);
      for (let i = 0; i < this.dragon.children.length; i++) {
        const child = this.dragon.children[i];
        if (child.geometry?.type === 'BufferGeometry') child.rotation.z = (child.scale.x < 0 ? -1 : 1) * (0.15 + flap * 0.18);
      }
    }
  }

  dispose() {
    this.root.removeFromParent();
  }
}

/* ================================================================== */
/* Field                                                               */
/* ================================================================== */

/**
 * The nine rivals, as one object.
 *
 * Racers are built once per world and reused across races: the geometry is
 * shared, but the scene-graph nodes and the material bindings are not free, and
 * rebuilding them on every restart would hitch the frame the flag drops on.
 */
export class RacerField {
  /** @param {{scene:THREE.Scene, physics:any, materials:any}} ctx */
  constructor({ scene, physics, materials }) {
    this.scene = scene;
    this.physics = physics;
    this.materials = materials;
    this.assets = null;
    /** @type {RacerAI[]} */
    this.racers = [];
    this.path = null;
  }

  /**
   * (Re)build the field for a track.
   * @param {TrackPath} path
   * @param {number} count how many AI cars, capped at the livery count
   * @param {number} seed
   */
  build(path, count, seed = 1, mode = 'car') {
    this.mode = mode === 'dragon' ? 'dragon' : 'car';
    this.path = path;
    if (!this.assets) this.assets = new RacerAssets(this.materials);
    const want = Math.min(Math.max(0, count | 0), LIVERIES.length);
    // Racers survive between races; only the count and the path change.
    while (this.racers.length > want) this.racers.pop().dispose();
    const rand = mulberry32(seed);
    for (const r of this.racers) r.path = path;
    while (this.racers.length < want) {
      const i = this.racers.length;
      this.racers.push(new RacerAI({
        scene: this.scene,
        physics: this.physics,
        assets: this.assets,
        path,
        index: i,
        livery: LIVERIES[i],
        rand,
      }));
    }
    // Re-roll the personalities of the cars that already existed, or a restart
    // would reproduce the same finishing order every time.
    for (const r of this.racers) {
      r.path = path;
      r._r = { top: rand(), grip: rand(), accel: rand(), mistake: rand(), line: rand() * 2 - 1 };
    }
    return this.racers;
  }

  /** @param {string} difficulty @param {Array<object>} slots one grid slot per racer */
  reset(difficulty, slots, mode = this.mode ?? 'car') {
    this.mode = mode === 'dragon' ? 'dragon' : 'car';
    const band = DIFFICULTIES[difficulty] ?? DIFFICULTIES.standard;
    for (let i = 0; i < this.racers.length; i++) {
      this.racers[i].reset(band, slots[i] ?? { x: 0, y: 0, z: 0, yaw: 0 }, this.mode);
    }
  }

  fixedUpdate(dt, field, running) {
    for (let i = 0; i < this.racers.length; i++) this.racers[i].fixedUpdate(dt, field, running);
  }

  setVisible(v) {
    for (const r of this.racers) r.setVisible(v);
  }

  clear() {
    for (const r of this.racers) r.dispose();
    this.racers.length = 0;
  }

  dispose() {
    this.clear();
    this.assets?.dispose();
    this.assets = null;
  }
}
