/**
 * REGION SAMPLING: the one thing that decides where anything sits on a planet.
 *
 * Props and minerals both come through here, deliberately. A vent field and the
 * sulfur that grows around it are two records in one descriptor, and if each
 * had its own scatter loop they would drift the first time somebody adjusted a
 * slope ceiling - which is the small version of the bug that put fifteen
 * unenterable buildings in this game behind a green suite.
 *
 * Three properties this module has to have, and they are the whole design:
 *
 *  1. **Deterministic.** Same descriptor, same layout, every session. A planet
 *     that re-rolls its ore between visits is not a place.
 *  2. **Honest about failure.** `scatter` returns `{ placed, requested, tries }`
 *     and NEVER pads the result to `count`. A region that can only fit nine of
 *     the twelve nodes asked for says nine, and the test that cares can fail on
 *     it. Silently returning twelve stacked on top of each other is how a
 *     mineral ends up inside a basalt column.
 *  3. **Filtered against the ground the player will actually walk.** Slope is
 *     measured with the SAME step as the collision heightfield, not with an
 *     analytic derivative. A 3.1 m collision cell cannot express a 60-degree
 *     face that exists only between two samples, so filtering on a derivative
 *     the collider does not have would reject sites that are in fact flat and
 *     accept sites that are in fact a wall.
 *
 * No `three`, no DOM: this runs under `node --test` against the real height
 * function, which is the only way the reachability claims downstream mean
 * anything.
 */

/** Deterministic PRNG. Same one the rest of the project uses. */
export function mulberry32(seed) {
  let s = seed >>> 0 || 1;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const RAD2DEG = 180 / Math.PI;

/**
 * Ground slope in degrees at (x, z), measured over `step` metres.
 *
 * Central differences over the collision cell, for the reason in the header:
 * this must be the slope the capsule solver will meet, not the slope the
 * analytic surface has.
 */
export function slopeDegAt(height, x, z, step) {
  const h = step * 0.5;
  const dx = (height(x + h, z) - height(x - h, z)) / step;
  const dz = (height(x, z + h) - height(x, z - h)) / step;
  return Math.atan(Math.hypot(dx, dz)) * RAD2DEG;
}

/** Distance from (px,pz) to a polyline, allocation-free. */
export function polyDist(px, pz, pts) {
  let best = Infinity;
  for (let i = 0; i + 1 < pts.length; i++) {
    const ax = pts[i][0];
    const az = pts[i][1];
    const bx = pts[i + 1][0];
    const bz = pts[i + 1][1];
    const dx = bx - ax;
    const dz = bz - az;
    const len2 = dx * dx + dz * dz;
    let t = len2 > 0 ? ((px - ax) * dx + (pz - az) * dz) / len2 : 0;
    if (t < 0) t = 0; else if (t > 1) t = 1;
    const qx = ax + dx * t - px;
    const qz = az + dz * t - pz;
    const d2 = qx * qx + qz * qz;
    if (d2 < best) best = d2;
  }
  return Math.sqrt(best);
}

/** Axis-aligned bounds a region can be sampled inside. */
function regionBounds(region, half) {
  switch (region.shape) {
    case 'disc': return [region.x - region.r, region.z - region.r, region.x + region.r, region.z + region.r];
    case 'annulus': return [region.x - region.r1, region.z - region.r1, region.x + region.r1, region.z + region.r1];
    case 'rect': return [Math.min(region.x0, region.x1), Math.min(region.z0, region.z1), Math.max(region.x0, region.x1), Math.max(region.z0, region.z1)];
    case 'corridor': {
      let x0 = Infinity; let z0 = Infinity; let x1 = -Infinity; let z1 = -Infinity;
      for (const p of region.pts) {
        if (p[0] < x0) x0 = p[0];
        if (p[0] > x1) x1 = p[0];
        if (p[1] < z0) z0 = p[1];
        if (p[1] > z1) z1 = p[1];
      }
      return [x0 - region.width, z0 - region.width, x1 + region.width, z1 + region.width];
    }
    default: return [-half, -half, half, half];
  }
}

/**
 * How far INSIDE a region's shape (x, z) lies, in metres. Negative outside.
 *
 * `inRegion` is this predicate thresholded at zero, and it is written this way
 * round rather than the other because a second consumer needs the DISTANCE and
 * not the boolean: `palette.patch` paints ground colour through the same region
 * records the props and the minerals are placed with, and a hard-edged albedo
 * patch is a stencil rather than a ray. Feathering needs an edge to fade from.
 *
 * Two implementations of "is this point in this corridor" would be two things
 * to keep in step, and the first time somebody adjusted a width the bright
 * streak and the chips lying on it would part company - which is the exact
 * failure this module's header opens by refusing.
 *
 * The filters (`yMin`, `slopeMaxDeg`, `clearOfPads`, ...) are NOT here: they
 * are properties of the ground rather than of the shape, and each caller has
 * its own way of measuring them.
 *
 * @returns {number} metres inside the boundary; `Infinity` for `field`.
 */
export function regionDepth(region, x, z) {
  switch (region.shape) {
    case 'disc': {
      const d = Math.hypot(x - region.x, z - region.z);
      const inner = region.rInner ?? 0;
      // A disc with no hole has no inner edge to be near, so do not make one -
      // otherwise a feathered patch would fade out at its own centre.
      return inner > 0 ? Math.min(region.r - d, d - inner) : region.r - d;
    }
    case 'annulus': {
      const d = Math.hypot(x - region.x, z - region.z);
      return Math.min(region.r1 - d, d - region.r0);
    }
    case 'rect': {
      const x0 = Math.min(region.x0, region.x1);
      const x1 = Math.max(region.x0, region.x1);
      const z0 = Math.min(region.z0, region.z1);
      const z1 = Math.max(region.z0, region.z1);
      return Math.min(x - x0, x1 - x, z - z0, z1 - z);
    }
    case 'corridor': {
      const d = polyDist(x, z, region.pts);
      const inner = region.widthInner ?? 0;
      return inner > 0 ? Math.min(region.width - d, d - inner) : region.width - d;
    }
    default: return Infinity;
  }
}

/** Whether (x, z) falls inside a region's SHAPE. Filters are the caller's. */
export function inRegion(region, x, z) {
  return regionDepth(region, x, z) >= 0;
}

/** Horizontal distance to the nearest liquid surface, or Infinity if none. */
export function liquidClearance(liquid, x, z) {
  if (!liquid) return Infinity;
  let best = Infinity;
  for (const b of liquid.bodies) {
    const d = b.shape === 'disc'
      ? Math.hypot(x - b.x, z - b.z) - b.r
      : polyDist(x, z, b.pts) - b.width * 0.5;
    if (d < best) best = d;
  }
  return best;
}

/** Horizontal distance to the nearest landing pad edge, or Infinity if none. */
export function padClearance(landing, x, z) {
  let best = Infinity;
  for (const s of landing) {
    const d = Math.hypot(x - s.x, z - s.z) - s.r;
    if (d < best) best = d;
  }
  return best;
}

/**
 * Scatter `count` points through a region, honouring every filter and a minimum
 * spacing.
 *
 * @param {{
 *   region: object, count: number, spacing?: number, seed: number,
 *   height: (x:number,z:number)=>number, half: number, slopeStep: number,
 *   liquid?: object|null, landing?: object[],
 * }} o
 * @returns {{ points: Array<{x:number,z:number,y:number,slope:number,rnd:number}>,
 *             requested: number, tries: number, rejects: object }}
 */
export function scatter(o) {
  const { region, count, seed, height, half, slopeStep } = o;
  const spacing = o.spacing ?? 0;
  const rnd = mulberry32(seed);
  const [bx0, bz0, bx1, bz1] = regionBounds(region, half);
  const w = bx1 - bx0;
  const d = bz1 - bz0;

  const points = [];
  /* Spacing is enforced through a hash grid rather than an O(n^2) sweep: a
   * boulder field is a thousand instances and the rejection loop runs it forty
   * times over. */
  const cell = Math.max(spacing, 1e-3);
  const grid = new Map();
  const key = (cx, cz) => `${cx},${cz}`;

  const rejects = { region: 0, height: 0, slope: 0, liquid: 0, pad: 0, spacing: 0, bounds: 0 };
  const maxTries = Math.max(400, count * 400);
  let tries = 0;

  while (points.length < count && tries < maxTries) {
    tries++;
    const x = bx0 + rnd() * w;
    const z = bz0 + rnd() * d;
    if (Math.abs(x) > half || Math.abs(z) > half) { rejects.bounds++; continue; }
    if (!inRegion(region, x, z)) { rejects.region++; continue; }

    const y = height(x, z);
    if (region.yMin !== undefined && y < region.yMin) { rejects.height++; continue; }
    if (region.yMax !== undefined && y > region.yMax) { rejects.height++; continue; }

    let slope = 0;
    if (region.slopeMaxDeg !== undefined || region.slopeMinDeg !== undefined) {
      slope = slopeDegAt(height, x, z, slopeStep);
      if (region.slopeMaxDeg !== undefined && slope > region.slopeMaxDeg) { rejects.slope++; continue; }
      if (region.slopeMinDeg !== undefined && slope < region.slopeMinDeg) { rejects.slope++; continue; }
    } else {
      slope = slopeDegAt(height, x, z, slopeStep);
    }

    if (region.clearOfLiquid !== undefined
      && liquidClearance(o.liquid, x, z) < region.clearOfLiquid) { rejects.liquid++; continue; }
    if (region.clearOfPads !== undefined
      && padClearance(o.landing ?? [], x, z) < region.clearOfPads) { rejects.pad++; continue; }

    if (spacing > 0) {
      const cx = Math.floor(x / cell);
      const cz = Math.floor(z / cell);
      let clash = false;
      for (let ax = cx - 1; ax <= cx + 1 && !clash; ax++) {
        for (let az = cz - 1; az <= cz + 1; az++) {
          const list = grid.get(key(ax, az));
          if (!list) continue;
          for (const q of list) {
            if (Math.hypot(q.x - x, q.z - z) < spacing) { clash = true; break; }
          }
          if (clash) break;
        }
      }
      if (clash) { rejects.spacing++; continue; }
      const k = key(cx, cz);
      let list = grid.get(k);
      if (!list) grid.set(k, (list = []));
      list.push({ x, z });
    }

    points.push({ x, z, y, slope, rnd: rnd() });
  }

  return { points, requested: count, tries, rejects };
}
