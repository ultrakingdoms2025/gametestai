/**
 * The arithmetic behind the station placement audit, with nothing else in it.
 *
 * ── Why this is a separate file ───────────────────────────────────────────
 * `StationAudit.js` needs a live `StationWorld`, and `StationWorld.js` cannot
 * be imported headlessly: it reaches for `document` to paint its textures and
 * for a WebGL context to upload them, and it pulls in the whole `three`
 * renderer on the way. So a unit test that wanted to check whether the overlap
 * threshold is applied to the *smaller* prop's volume would have to boot a
 * browser to find out - which is exactly the kind of test nobody runs.
 *
 * Everything here is therefore plain numbers and plain objects: no THREE, no
 * DOM, no module-scope side effects of any kind. An AABB is
 * `{ min: [x,y,z], max: [x,y,z] }` and nothing more. `scripts/tests/
 * station-audit.test.mjs` imports this file directly under `node --test`.
 *
 * All distances are metres.
 */

/* ------------------------------------------------------------------ */
/* Thresholds - named, in one place, so a test can assert on them      */
/* ------------------------------------------------------------------ */

export const AUDIT_VERSION = 'station-audit/1.0.0';

export const THRESHOLDS = {
  /** A prop whose underside is this far above its support is FLOATing. */
  floatGap: 0.05,
  /** A prop whose underside is this far below its support is SUNK. */
  sunkGap: -0.05,
  /** Overlap volume below this is never worth reporting, whatever the props. */
  overlapMinVolume: 0.02,
  /** ...and neither is one smaller than this fraction of the smaller prop. */
  overlapMinFraction: 0.05,
  /** Uniform spatial-hash cell for the overlap broadphase. */
  overlapCell: 4,
  /** Fraction of the way from an AABB's centre toward each corner to sample. */
  coverageSampleFraction: 0.6,
  /** Anything with its underside above this is airborne on purpose. */
  airborneY: 12,
  /** The player can step over anything shorter than this - CONFIG.player.stepHeight. */
  stepHeight: 0.45,
  /** Escalator surfaces further apart than this are misaligned. */
  escalatorTolerance: 0.02,
  /** A prop this thin on any axis is trim, and is not expected to be solid. */
  solidMinHalfExtent: 0.2,
  /** A prop shorter than this is a kerb or a decal, and is not expected to be solid. */
  solidMinHeight: 0.4,
};

/* ------------------------------------------------------------------ */
/* AABBs                                                               */
/* ------------------------------------------------------------------ */

/** @typedef {{min: number[], max: number[]}} Aabb */

/** @param {Aabb} a */
export function aabbSize(a) {
  return [a.max[0] - a.min[0], a.max[1] - a.min[1], a.max[2] - a.min[2]];
}

/** @param {Aabb} a */
export function aabbVolume(a) {
  const s = aabbSize(a);
  return Math.max(0, s[0]) * Math.max(0, s[1]) * Math.max(0, s[2]);
}

/** @param {Aabb} a */
export function aabbCentre(a) {
  return [(a.min[0] + a.max[0]) / 2, (a.min[1] + a.max[1]) / 2, (a.min[2] + a.max[2]) / 2];
}

/**
 * The box two AABBs share, and its volume.
 *
 * Returns `volume: 0` and `box: null` when they only touch. Touching is not
 * overlapping: a crate resting exactly on the deck shares a zero-thickness
 * plane with it, and reporting that as an intersection would bury every real
 * finding under one per prop in the world.
 *
 * @param {Aabb} a @param {Aabb} b
 * @returns {{volume: number, box: Aabb|null}}
 */
export function aabbIntersection(a, b) {
  const min = [
    Math.max(a.min[0], b.min[0]),
    Math.max(a.min[1], b.min[1]),
    Math.max(a.min[2], b.min[2]),
  ];
  const max = [
    Math.min(a.max[0], b.max[0]),
    Math.min(a.max[1], b.max[1]),
    Math.min(a.max[2], b.max[2]),
  ];
  const dx = max[0] - min[0], dy = max[1] - min[1], dz = max[2] - min[2];
  if (dx <= 0 || dy <= 0 || dz <= 0) return { volume: 0, box: null };
  return { volume: dx * dy * dz, box: { min, max } };
}

/**
 * Is this overlap worth reporting?
 *
 * Two tests, and both are needed. The absolute floor stops a millimetre of
 * z-fighting between two adjacent floor plates being called a defect; the
 * relative one is measured against the SMALLER prop, because a bollard buried
 * in a building is a defect and the same volume shared between two buildings
 * is a shared wall.
 */
export function overlapSignificant(volume, volA, volB, t = THRESHOLDS) {
  if (volume <= 0) return false;
  const smaller = Math.min(volA, volB);
  return volume > Math.max(t.overlapMinVolume, smaller * t.overlapMinFraction);
}

/** Centre plus four points `fraction` of the way toward the horizontal corners. */
export function footprintSamples(box, fraction = THRESHOLDS.coverageSampleFraction) {
  const c = aabbCentre(box);
  const hx = (box.max[0] - box.min[0]) / 2 * fraction;
  const hz = (box.max[2] - box.min[2]) / 2 * fraction;
  const hy = (box.max[1] - box.min[1]) / 2 * fraction;
  return [
    c,
    [c[0] - hx, c[1] - hy, c[2] - hz],
    [c[0] + hx, c[1] - hy, c[2] + hz],
    [c[0] - hx, c[1] + hy, c[2] + hz],
    [c[0] + hx, c[1] + hy, c[2] - hz],
  ];
}

/* ------------------------------------------------------------------ */
/* Grounding                                                           */
/* ------------------------------------------------------------------ */

/**
 * FLOAT / SUNK / OK from the gap between a prop's underside and its support.
 *
 * `null` for `gap` means nothing was found underneath at all, which is a
 * different thing from floating and is reported as its own verdict rather than
 * silently folded into one of the others.
 */
export function classifyGap(gap, t = THRESHOLDS) {
  if (gap === null || gap === undefined || !Number.isFinite(gap)) return 'NO_SUPPORT';
  if (gap > t.floatGap) return 'FLOAT';
  if (gap < t.sunkGap) return 'SUNK';
  return 'OK';
}

/** Should this prop have a collider at all? See THRESHOLDS.solidMin*. */
export function shouldBeSolid(box, t = THRESHOLDS) {
  const [w, h, d] = aabbSize(box);
  if (h < t.solidMinHeight) return false;
  return Math.min(w, d) / 2 >= t.solidMinHalfExtent && h / 2 >= t.solidMinHalfExtent;
}

/* ------------------------------------------------------------------ */
/* Uniform spatial hash                                                */
/* ------------------------------------------------------------------ */

/**
 * A uniform grid over XYZ, used to find candidate overlapping pairs.
 *
 * The station carries about 32,000 audited props. The obvious pairwise sweep is
 * half a billion AABB tests, which in a browser is minutes; the same question
 * asked through a 4 m grid is a few hundred thousand. Cell size is a real
 * tuning decision rather than a detail: too small and a long prop is inserted
 * into hundreds of cells, too large and a dense scatter (the galley seats
 * 18,000 chairs) puts thousands of props in one bucket and the quadratic term
 * comes straight back.
 *
 * Items spanning several cells are inserted into each, so `forEachPair` can
 * hand back the same pair more than once; it dedupes on the ordered index pair.
 */
export class SpatialHash {
  /** @param {number} cell */
  constructor(cell = THRESHOLDS.overlapCell) {
    if (!(cell > 0)) throw new Error('SpatialHash: cell size must be positive');
    this.cell = cell;
    /** @type {Map<string, number[]>} */
    this.cells = new Map();
    this.boxes = [];
  }

  _key(ix, iy, iz) { return `${ix},${iy},${iz}`; }

  /** Cell index range an AABB touches. */
  range(box) {
    const c = this.cell;
    return {
      x0: Math.floor(box.min[0] / c), x1: Math.floor(box.max[0] / c),
      y0: Math.floor(box.min[1] / c), y1: Math.floor(box.max[1] / c),
      z0: Math.floor(box.min[2] / c), z1: Math.floor(box.max[2] / c),
    };
  }

  /** @param {Aabb} box @returns {number} the item's index */
  insert(box) {
    const id = this.boxes.length;
    this.boxes.push(box);
    const r = this.range(box);
    for (let ix = r.x0; ix <= r.x1; ix++) {
      for (let iy = r.y0; iy <= r.y1; iy++) {
        for (let iz = r.z0; iz <= r.z1; iz++) {
          const k = this._key(ix, iy, iz);
          let list = this.cells.get(k);
          if (!list) this.cells.set(k, (list = []));
          list.push(id);
        }
      }
    }
    return id;
  }

  /** Every item index sharing a cell with `box`, deduplicated. */
  candidates(box) {
    const r = this.range(box);
    const out = new Set();
    for (let ix = r.x0; ix <= r.x1; ix++) {
      for (let iy = r.y0; iy <= r.y1; iy++) {
        for (let iz = r.z0; iz <= r.z1; iz++) {
          const list = this.cells.get(this._key(ix, iy, iz));
          if (list) for (const id of list) out.add(id);
        }
      }
    }
    return out;
  }

  /**
   * Call `fn(i, j)` once for every distinct pair sharing a cell, i < j.
   * @param {(i: number, j: number) => void} fn
   * @returns {number} how many distinct pairs were visited
   */
  forEachPair(fn) {
    const seen = new Set();
    let n = 0;
    for (const list of this.cells.values()) {
      for (let a = 0; a < list.length; a++) {
        for (let b = a + 1; b < list.length; b++) {
          const i = Math.min(list[a], list[b]);
          const j = Math.max(list[a], list[b]);
          const key = i * 4294967296 + j;
          if (seen.has(key)) continue;
          seen.add(key);
          n++;
          fn(i, j);
        }
      }
    }
    return n;
  }
}

/* ------------------------------------------------------------------ */
/* Polar layout - the whole station is laid out on radiating avenues   */
/* ------------------------------------------------------------------ */

export const DEG = Math.PI / 180;

/**
 * A point `r` out along bearing `deg`, offset `off` to the left of it.
 * Mirrors `StationKit.roadPos` exactly - the audit has to sample the same
 * points the builders placed geometry at, and re-deriving the convention is
 * how a run-break sampler ends up measuring the wrong side of a kerb.
 */
export function polarPoint(deg, r, off = 0) {
  const t = deg * DEG;
  const c = Math.cos(t), s = Math.sin(t);
  return [c * r - s * off, s * r + c * off];
}

/** Signed smallest angle between two bearings, in degrees, in (-180, 180]. */
export function bearingDelta(a, b) {
  let d = ((b - a) % 360 + 540) % 360 - 180;
  if (d === -180) d = 180;
  return d;
}

/**
 * How far apart, along the arc at radius `r`, two bearings are.
 *
 * This is what decides whether a "crossing" exists at all. The walkway loop's
 * four stair flights sit on 30/150/210/330 and the six avenues on
 * 0/60/.../300, so every flight is 30 degrees off every avenue - which at
 * r = 72 is 37 m of arc, and no amount of sampling will find the flight
 * crossing an avenue kerb that ends 9.45 m from the road's centreline. Saying
 * so with a number beats asserting it in a comment.
 */
export function arcSeparation(degA, degB, r) {
  return Math.abs(bearingDelta(degA, degB)) * DEG * r;
}

/**
 * Does a radial run of half-width `halfW` about bearing `runDeg` reach the
 * band `[offMin, offMax]` beside bearing `laneDeg`, at radius `r`?
 *
 * Used to decide whether a stair flight and an avenue kerb ever meet before
 * either is sampled for obstructions.
 */
export function crossingExists(runDeg, laneDeg, r, halfW, kerbOffset) {
  const sep = arcSeparation(runDeg, laneDeg, r);
  return sep - halfW <= Math.abs(kerbOffset);
}

/**
 * Sample points across a road mouth where a ring crosses it.
 *
 * `n` points spread across the full carriageway (not just its centreline):
 * a kerb ring is a ring, and a gap cut for the road can be cut too narrow as
 * easily as not cut at all. The end points sit just inside the kerbs.
 */
export function roadMouthSamples(deg, ringR, roadW, n = 5) {
  const out = [];
  for (let i = 0; i < n; i++) {
    const t = n === 1 ? 0.5 : i / (n - 1);
    const off = (t - 0.5) * (roadW - 1.2);
    const [x, z] = polarPoint(deg, ringR, off);
    out.push({ x, z, off });
  }
  return out;
}

/**
 * Sample points along a straight kerb line, between two radii on one bearing.
 * `side` is +1 or -1 for which kerb.
 */
export function kerbLineSamples(deg, r0, r1, offset, side, n = 9) {
  const out = [];
  for (let i = 0; i < n; i++) {
    const t = n === 1 ? 0.5 : i / (n - 1);
    const r = r0 + (r1 - r0) * t;
    const [x, z] = polarPoint(deg, r, side * offset);
    out.push({ x, z, r });
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* Triangle helpers - used to read heights straight off drawn geometry */
/* ------------------------------------------------------------------ */

/**
 * Height of a triangle directly above/below (x, z), or null when the column
 * misses it. Barycentric in the XZ plane; a triangle seen edge-on from above
 * has zero area there and is correctly reported as a miss.
 */
export function triangleHeightAt(ax, ay, az, bx, by, bz, cx, cy, cz, x, z) {
  const v0x = cx - ax, v0z = cz - az;
  const v1x = bx - ax, v1z = bz - az;
  const v2x = x - ax, v2z = z - az;
  const den = v0x * v1z - v1x * v0z;
  if (Math.abs(den) < 1e-12) return null;
  const u = (v2x * v1z - v1x * v2z) / den;
  const v = (v0x * v2z - v2x * v0z) / den;
  if (u < -1e-9 || v < -1e-9 || u + v > 1 + 1e-9) return null;
  return ay + u * (cy - ay) + v * (by - ay);
}

/**
 * Verdict for one crossing of a continuous run.
 *
 * `blocked` is "is there anything there at all", which is worth reporting on
 * its own - a 0.18 m kerb lip across a road mouth is a deliberate detail. The
 * DEFECT is the separate, harder test: an obstruction the player cannot step
 * over. Conflating the two is how an audit ends up with 40 findings nobody
 * reads.
 */
export function classifyRunBreak(obstructionHeight, t = THRESHOLDS) {
  if (obstructionHeight === null || obstructionHeight <= 0.02) {
    return { blocked: false, verdict: 'CLEAR' };
  }
  if (obstructionHeight > t.stepHeight) return { blocked: true, verdict: 'BLOCKED' };
  return { blocked: true, verdict: 'STEPPABLE' };
}

/**
 * The three pairwise deltas between an escalator's tread line, its ramp
 * collider and the floor slab it meets, at one end.
 */
export function escalatorDeltas({ treadY, rampY, floorY }) {
  const d = {
    treadVsRamp: round(treadY - rampY),
    treadVsFloor: round(treadY - floorY),
    rampVsFloor: round(rampY - floorY),
  };
  d.worst = Math.max(...Object.values(d).map(Math.abs));
  return d;
}

/** Six decimal places, so a report diff is not noise from float printing. */
export function round(n, places = 4) {
  if (n === null || n === undefined || !Number.isFinite(n)) return n;
  const f = 10 ** places;
  return Math.round(n * f) / f;
}
