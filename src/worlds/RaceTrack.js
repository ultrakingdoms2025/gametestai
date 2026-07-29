import * as THREE from 'three';

/**
 * Circuit maths for {@link RaceWorld}: the centreline, the surface it defines,
 * and the strip mesher that draws anything running along it.
 *
 * ── Why the height function lives here and nowhere else ───────────────────
 *
 * CitadelWorld shipped with three separate descriptions of one slope - a
 * smoothstep in the visible mesh, a square slab plus a ring of boxes in the
 * collision, and a third copy in the prop placer. They disagreed, and where the
 * collision sat lower than the mesh the player walked *underneath* the world.
 *
 * A racing world is far more exposed to that failure than a walking world is: a
 * car reads the ground four times per frame, once per wheel, and a wheel that
 * finds nothing droops 2.5 m and pitches the car into a hole that is not there.
 * So this file owns exactly one function - `surfaceHeight(x, z)` - and the
 * terrain mesh, the terrain colliders, the track ribbon, the barriers, the grid
 * boxes, the props and the spawns all read it. There is no second opinion to
 * drift out of sync with, because there is no second opinion.
 *
 * ── The corridor ──────────────────────────────────────────────────────────
 *
 * `surfaceHeight` is the natural terrain everywhere except near the circuit,
 * where it is replaced outright by the track surface and then blended back out
 * over an embankment. The blend length is derived from how far the road is from
 * the hill it crosses, so a road cut into a 20 m hillside gets a 60 m shoulder
 * and a road on the flat gets none - which is both what a real earthwork looks
 * like and what stops the shoulder becoming a wall.
 */

export const TAU = Math.PI * 2;
export const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
export const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
export const lerp = (a, b, t) => a + (b - a) * t;

/** Hermite fade. `x` outside [e0,e1] saturates. */
export function smoothstep(e0, e1, x) {
  const t = clamp01((x - e0) / (e1 - e0 || 1e-6));
  return t * t * (3 - 2 * t);
}

/** Deterministic PRNG - a world has to regenerate identically every session. */
export function mulberry32(seed) {
  let s = seed >>> 0 || 1;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Uniform Catmull-Rom through p1..p2. */
function cr(p0, p1, p2, p3, t) {
  const t2 = t * t;
  const t3 = t2 * t;
  return 0.5 * (
    2 * p1 +
    (-p0 + p2) * t +
    (2 * p0 - 5 * p1 + 4 * p2 - p3) * t2 +
    (-p0 + 3 * p1 - 3 * p2 + p3) * t3
  );
}

/**
 * A closed circuit: evenly spaced centreline samples plus the surface they
 * define.
 *
 * Every sample carries the frame the geometry builders need - direction, the
 * right-hand normal, drivable half-width, cross-fall - so nothing downstream
 * ever has to re-derive a tangent and get a different answer.
 */
export class RaceCourse {
  /**
   * @param {Array<{x:number,z:number,y:number,w:number,v?:number}>} controls
   *   closed loop of control points, in the racing direction. `y` is the road
   *   surface, `w` the drivable half-width, `v` the metres of kerb and run-off
   *   carried either side of it.
   * @param {{ spacing?:number, verge?:number, baseHeight:(x:number,z:number)=>number,
   *           maxBankDeg?:number, cornerWiden?:number }} opts
   */
  constructor(controls, opts) {
    this.spacing = opts.spacing ?? 2;
    /** Default run-off, for control points that do not state one. */
    this.verge = opts.verge ?? 11;
    this.baseHeight = opts.baseHeight;
    this.maxTanBank = Math.tan(((opts.maxBankDeg ?? 5) * Math.PI) / 180);
    this.cornerWiden = opts.cornerWiden ?? 0.2;

    /* Shoulder geometry. `flatPad` keeps the surface dead flat a little beyond
     * the run-off so the outermost collider slab is never sitting on a slope it
     * only half covers. */
    this.flatPad = 2;
    this.blendMin = 16;
    this.blendMax = 30;
    /** Steepest embankment allowed, as a gradient. */
    this.blendGrade = 0.34;

    this._build(controls);
    this._hash();
  }

  /* ------------------------------------------------------------------ */
  /* Centreline                                                          */
  /* ------------------------------------------------------------------ */

  _build(cp) {
    const n = cp.length;
    const SUB = 26;
    const dx = [];
    const dz = [];
    const dy = [];
    const dw = [];
    const dv = [];
    const vg = (p) => p.v ?? this.verge;
    for (let i = 0; i < n; i++) {
      const p0 = cp[(i - 1 + n) % n];
      const p1 = cp[i];
      const p2 = cp[(i + 1) % n];
      const p3 = cp[(i + 2) % n];
      for (let k = 0; k < SUB; k++) {
        const t = k / SUB;
        dx.push(cr(p0.x, p1.x, p2.x, p3.x, t));
        dz.push(cr(p0.z, p1.z, p2.z, p3.z, t));
        dy.push(cr(p0.y, p1.y, p2.y, p3.y, t));
        dw.push(cr(p0.w, p1.w, p2.w, p3.w, t));
        dv.push(cr(vg(p0), vg(p1), vg(p2), vg(p3), t));
      }
    }

    const m = dx.length;
    const cum = new Float64Array(m + 1);
    for (let i = 0; i < m; i++) {
      const j = (i + 1) % m;
      cum[i + 1] = cum[i] + Math.hypot(dx[j] - dx[i], dz[j] - dz[i]);
    }
    const total = cum[m];
    const N = Math.max(96, Math.round(total / this.spacing));
    const step = total / N;
    this.length = total;
    this.step = step;
    this.count = N;

    const X = new Float64Array(N);
    const Z = new Float64Array(N);
    const Y = new Float64Array(N);
    const W = new Float64Array(N);
    const V = new Float64Array(N);
    let seg = 0;
    for (let j = 0; j < N; j++) {
      const s = j * step;
      while (seg < m - 1 && cum[seg + 1] < s) seg++;
      const span = cum[seg + 1] - cum[seg];
      const t = span > 1e-9 ? (s - cum[seg]) / span : 0;
      const a = seg;
      const b = (seg + 1) % m;
      X[j] = lerp(dx[a], dx[b], t);
      Z[j] = lerp(dz[a], dz[b], t);
      Y[j] = lerp(dy[a], dy[b], t);
      W[j] = lerp(dw[a], dw[b], t);
      V[j] = lerp(dv[a], dv[b], t);
    }

    /* Smooth the elevation, not the plan.
     *
     * Control-point elevations are authored at corner-sized intervals, and
     * Catmull-Rom through them produces gradient steps at every control - which
     * a car reads as a bump, because its four wheel probes straddle exactly that
     * distance. A ~30 m moving average removes them without moving the road:
     * the plan view is deliberately left alone, because smoothing x/z pulls the
     * apex out of every corner. */
    const win = Math.max(1, Math.round(15 / step));
    this._smoothWrap(Y, win, 3);
    this._smoothWrap(W, win, 1);
    /* The run-off is smoothed hardest of the three.
     *
     * It goes from 11 m of gravel trap in the hills to 3.5 m of kerb and
     * pavement in the city, and that is a 7 m step in the position of the
     * barrier - which, taken at speed, is a wall appearing out of nowhere. Run
     * over 60 m it becomes the funnel a street section actually has. */
    this._smoothWrap(V, Math.max(1, Math.round(30 / step)), 2);

    /* Frames, curvature, cross-fall. */
    const DX = new Float64Array(N);
    const DZ = new Float64Array(N);
    for (let i = 0; i < N; i++) {
      const a = (i - 1 + N) % N;
      const b = (i + 1) % N;
      let tx = X[b] - X[a];
      let tz = Z[b] - Z[a];
      const l = Math.hypot(tx, tz) || 1;
      DX[i] = tx / l;
      DZ[i] = tz / l;
    }
    // right = forward x up, so +lat is to the driver's right.
    const RX = new Float64Array(N);
    const RZ = new Float64Array(N);
    for (let i = 0; i < N; i++) {
      RX[i] = -DZ[i];
      RZ[i] = DX[i];
    }

    const K = new Float64Array(N);
    for (let i = 0; i < N; i++) {
      const b = (i + 1) % N;
      // Signed by the cross product: positive turns to the driver's right.
      K[i] = (DX[i] * DZ[b] - DZ[i] * DX[b]) / step;
    }
    this._smoothWrap(K, Math.max(1, Math.round(10 / step)), 2);

    /* Cross-fall and corner width, both driven by curvature.
     *
     * Physical banking for these speeds would be 50 degrees, which is a wall of
     * death rather than a circuit, so the angle is capped and merely *appears*
     * where the corner is. The widening is the Mario-Kart half of the brief: a
     * corner is where ten cars are closest together and is exactly where the
     * road should not get narrower. */
    const B = new Float64Array(N);
    for (let i = 0; i < N; i++) {
      const tight = smoothstep(1 / 220, 1 / 45, Math.abs(K[i]));
      B[i] = -Math.sign(K[i]) * this.maxTanBank * tight;
      W[i] *= 1 + this.cornerWiden * tight;
    }
    this._smoothWrap(B, Math.max(1, Math.round(18 / step)), 2);
    this._smoothWrap(W, Math.max(1, Math.round(12 / step)), 1);

    /* Half-width of the sealed slab: tarmac plus run-off, per sample - capped
     * against the corner it is on.
     *
     * ── Why the cap is not optional ───────────────────────────────────────
     *
     * Everything either side of the centreline is an *offset curve*, and an
     * offset curve wider than the radius it is offset from folds through its
     * own centre of curvature and comes out inside-out. The hairpin here is a
     * 20 m radius and the run-off is 11 m on top of a 10 m half-width, so the
     * inner edge of the sealed surface was being asked to sit at a radius of
     * minus half a metre. The drawn ribbon survives that - it is one continuous
     * surface and merely bunches up - but the collision is built as a strip of
     * quads, and inverted quads do not tile: the verification sweep found a
     * scatter of points on the inside of that corner where a car would find the
     * road drawn under its wheels and nothing solid beneath it.
     *
     * Capping the sealed width at 0.6 of the radius keeps the inner edge well
     * clear of the centre and is what a real hairpin looks like anyway - the
     * run-off is on the outside, where cars leave the track, and the inside is
     * kerb and grass. `w` is capped in the same way so the auto-widening
     * cannot re-create the problem on the tarmac itself. */
    const SW = new Float64Array(N);
    for (let i = 0; i < N; i++) {
      const R = 1 / Math.max(Math.abs(K[i]), 1e-6);
      W[i] = Math.min(W[i], Math.max(4, 0.42 * R));
      SW[i] = Math.min(W[i] + V[i], Math.max(W[i] + 1.5, 0.6 * R));
    }
    this._smoothWrap(W, Math.max(1, Math.round(10 / step)), 1);
    this._smoothWrap(SW, Math.max(1, Math.round(14 / step)), 2);

    this.x = X;
    this.z = Z;
    this.y = Y;
    this.w = W;
    this.vg = V;
    this.W = SW;
    this.dx = DX;
    this.dz = DZ;
    this.rx = RX;
    this.rz = RZ;
    this.curv = K;
    this.bank = B;

    let minR = Infinity;
    for (let i = 0; i < N; i++) {
      const r = 1 / Math.max(Math.abs(K[i]), 1e-6);
      if (r < minR) minR = r;
    }
    this.minRadius = minR;
    let maxG = 0;
    for (let i = 0; i < N; i++) {
      const g = Math.abs(Y[(i + 1) % N] - Y[i]) / step;
      if (g > maxG) maxG = g;
    }
    this.maxGrade = maxG;
  }

  /** In-place wrapped box blur, `passes` times. */
  _smoothWrap(arr, win, passes) {
    const n = arr.length;
    const tmp = new Float64Array(n);
    for (let p = 0; p < passes; p++) {
      for (let i = 0; i < n; i++) {
        let sum = 0;
        for (let k = -win; k <= win; k++) sum += arr[(i + k + n * 4) % n];
        tmp[i] = sum / (win * 2 + 1);
      }
      arr.set(tmp);
    }
  }

  /* ------------------------------------------------------------------ */
  /* Spatial lookup                                                      */
  /* ------------------------------------------------------------------ */

  /**
   * Bucket the samples so `nearest` is a ring search rather than a scan over
   * every sample. 31 000 terrain vertices each need an answer; a linear scan
   * would be 30 million segment projections and several seconds of build.
   */
  _hash() {
    this.cell = 16;
    /** @type {Map<number, number[]>} */
    this.buckets = new Map();
    for (let i = 0; i < this.count; i++) {
      const cx = Math.floor(this.x[i] / this.cell);
      const cz = Math.floor(this.z[i] / this.cell);
      const key = ((cx + 4096) << 13) | (cz + 4096);
      let list = this.buckets.get(key);
      if (!list) this.buckets.set(key, (list = []));
      list.push(i);
    }
    /** Rings searched before giving up. cell * maxRing is the guaranteed reach. */
    this.maxRing = 4;
  }

  /**
   * Closest point on the centreline.
   *
   * @returns {null | { i:number, t:number, d:number, lat:number, y:number,
   *                    w:number, W:number, bank:number, s:number }}
   *   `lat` is the signed offset (positive to the driver's right), `d` its
   *   magnitude. Null when nothing is within `cell * maxRing`, which the caller
   *   may treat as "far from the circuit" - the blend has saturated by then.
   */
  nearest(x, z) {
    const cell = this.cell;
    const cx = Math.floor(x / cell);
    const cz = Math.floor(z / cell);
    let bestD = Infinity;
    let bi = -1;
    let bt = 0;
    let blat = 0;

    for (let ring = 0; ring <= this.maxRing; ring++) {
      for (let ox = -ring; ox <= ring; ox++) {
        for (let oz = -ring; oz <= ring; oz++) {
          // Only the newly added shell each pass.
          if (ring > 0 && Math.abs(ox) !== ring && Math.abs(oz) !== ring) continue;
          const list = this.buckets.get(((cx + ox + 4096) << 13) | (cz + oz + 4096));
          if (!list) continue;
          for (let k = 0; k < list.length; k++) {
            const i = list[k];
            const j = (i + 1) % this.count;
            const ax = this.x[i];
            const az = this.z[i];
            const ex = this.x[j] - ax;
            const ez = this.z[j] - az;
            const len2 = ex * ex + ez * ez;
            const px = x - ax;
            const pz = z - az;
            let t = len2 > 1e-9 ? (px * ex + pz * ez) / len2 : 0;
            t = t < 0 ? 0 : t > 1 ? 1 : t;
            const qx = px - ex * t;
            const qz = pz - ez * t;
            const d = Math.hypot(qx, qz);
            if (d < bestD) {
              bestD = d;
              bi = i;
              bt = t;
              // Signed against the sample's right vector.
              blat = px * this.rx[i] + pz * this.rz[i];
            }
          }
        }
      }
      // Anything closer than the shell just cleared would already be in hand.
      if (bi >= 0 && bestD <= ring * cell) break;
    }
    if (bi < 0) return null;

    const j = (bi + 1) % this.count;
    return {
      i: bi,
      t: bt,
      d: bestD,
      lat: blat,
      y: lerp(this.y[bi], this.y[j], bt),
      w: lerp(this.w[bi], this.w[j], bt),
      W: lerp(this.W[bi], this.W[j], bt),
      bank: lerp(this.bank[bi], this.bank[j], bt),
      s: (bi + bt) * this.step,
    };
  }

  /**
   * Road surface at a lateral offset: banked across the drivable width, then
   * flat across the run-off at the height the edge reached.
   */
  crossFall(nr, lat = nr.lat) {
    return nr.y + nr.bank * clamp(lat, -nr.w, nr.w);
  }

  /**
   * THE height function, plus everything a caller would otherwise re-derive.
   *
   * The terrain mesh, the terrain colliders, the road ribbon, the barriers and
   * every prop placement go through here. They also all need to know how far
   * from the circuit they are and how wide the run-off is at that point, and
   * every one of them computing that separately is precisely how the three
   * disagreeing terrains in CitadelWorld came about - so it is returned here
   * rather than left to be worked out again.
   *
   * @returns {{ h:number, d:number, w:number, W:number, road:number, base:number }}
   *   `h` surface height, `d` distance to the centreline, `w` drivable
   *   half-width, `W` half-width of the sealed slab (road + run-off).
   */
  probe(x, z) {
    const base = this.baseHeight(x, z);
    const nr = this.nearest(x, z);
    if (!nr) return { h: base, d: Infinity, w: 0, W: 0, road: base, base };
    const road = this.crossFall(nr);
    const W = nr.W;
    const flat = W + this.flatPad;
    let h = road;
    if (nr.d > flat) {
      const blend = clamp(Math.abs(base - road) / this.blendGrade, this.blendMin, this.blendMax);
      h = lerp(road, base, smoothstep(0, 1, (nr.d - flat) / blend));
    }
    return { h, d: nr.d, w: nr.w, W, road, base };
  }

  /** Convenience wrapper; see {@link probe}. */
  surfaceHeight(x, z) {
    return this.probe(x, z).h;
  }

  /** Sample index nearest an arc length, wrapped. */
  indexAt(s) {
    const n = this.count;
    let i = Math.round(s / this.step) % n;
    if (i < 0) i += n;
    return i;
  }

  /** Centreline point and frame at an arc length. */
  pointAt(s, lat = 0) {
    const i = this.indexAt(s);
    return {
      i,
      x: this.x[i] + this.rx[i] * lat,
      z: this.z[i] + this.rz[i] * lat,
      y: this.y[i] + this.bank[i] * clamp(lat, -this.w[i], this.w[i]),
      dx: this.dx[i],
      dz: this.dz[i],
      w: this.w[i],
      W: this.W[i],
    };
  }
}

/* ------------------------------------------------------------------ */
/* Strip mesher                                                        */
/* ------------------------------------------------------------------ */

/**
 * A quad lattice stitched from rows of equal length.
 *
 * Everything that runs along the circuit - tarmac, kerbs, gravel, grass verge,
 * the barrier wall, the armco - is the same shape: a cross-section extruded
 * along the centreline. One mesher for all of them keeps the road a *surface*
 * rather than a chain of boxes, which matters more here than anywhere else in
 * the game: a car crossing a seam between two boxes gets a bump per seam, and
 * at 30 m/s that is 15 bumps a second.
 *
 * UVs are world-scaled by the caller (u across, v along the arc length), so a
 * strip drawn 40 m wide and 2 km long has the same texel density as one 2 m
 * wide - the mistake CitadelWorld had to re-project its whole town to fix.
 */
export class Lattice {
  /** @param {number} cols vertices per cross-section */
  constructor(cols) {
    this.cols = cols;
    this._pos = [];
    this._uv = [];
    this._col = [];
    this.rows = 0;
  }

  /**
   * @param {Array<{x:number,y:number,z:number,u:number,r:number,g:number,b:number}>} verts
   * @param {number} v texture coordinate along the strip
   */
  addRow(verts, v) {
    for (let i = 0; i < this.cols; i++) {
      const p = verts[i];
      this._pos.push(p.x, p.y, p.z);
      this._uv.push(p.u, v);
      this._col.push(p.r, p.g, p.b);
    }
    this.rows++;
  }

  /**
   * @param {boolean} closed join the last row back to the first
   * @param {boolean} flip reverse the triangle winding
   *
   * ── Which way `flip` goes, and why it has to be stated ────────────────────
   *
   * A row runs across the strip and the rows run along it, so the face normal
   * is `cross(along, across)`. `across` is whichever way the *columns* happen to
   * be ordered, and for a road profile written symmetrically - `s * (w + ...)`
   * for s of -1 and +1 - the two sides are ordered in opposite directions. The
   * two halves of the same road therefore come out with opposite normals, and
   * one half of everything is silently backface-culled.
   *
   * That is not hypothetical: the first build of this world had a complete,
   * correctly placed road that could not be seen at all, because `along x
   * right` is *down* - the tarmac was drawn face-down through the hole cut in
   * the terrain for it, and the sky showed through. Collision was fine
   * throughout, which is the worst version of the bug, because everything
   * drives correctly over a surface that is not there.
   */
  build(closed = true, flip = false) {
    const cols = this.cols;
    const rows = this.rows;
    if (rows < 2) return null;
    const idx = [];
    const last = closed ? rows : rows - 1;
    for (let r = 0; r < last; r++) {
      const r1 = (r + 1) % rows;
      for (let c = 0; c < cols - 1; c++) {
        const a = r * cols + c;
        const b = r * cols + c + 1;
        const cc = r1 * cols + c;
        const d = r1 * cols + c + 1;
        if (flip) idx.push(a, d, cc, a, b, d);
        else idx.push(a, cc, d, a, d, b);
      }
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(this._pos, 3));
    geo.setAttribute('uv', new THREE.Float32BufferAttribute(this._uv, 2));
    geo.setAttribute('color', new THREE.Float32BufferAttribute(this._col, 3));
    geo.setIndex(idx);
    geo.computeVertexNormals();
    geo.computeBoundingSphere();
    return geo;
  }
}

/* ------------------------------------------------------------------ */
/* Oriented slab colliders                                             */
/* ------------------------------------------------------------------ */

const _sx = new THREE.Vector3();
const _sy = new THREE.Vector3();
const _sz = new THREE.Vector3();

/**
 * Build the world matrix for a box whose *top face* is a given plane.
 *
 * `Physics.addRotatedBox` only takes a Y rotation, which is right for a town
 * and useless for a road: a circuit that climbs 21 m and banks into its corners
 * has no axis-aligned surfaces at all, and approximating it with level boxes
 * puts a step at every segment. `Collider` itself accepts an arbitrary matrix,
 * so the slabs here are genuinely tilted and the collision *is* the road
 * surface rather than a staircase under it.
 *
 * @param {THREE.Vector3} origin a point on the top face
 * @param {THREE.Vector3} normal unit up of the face
 * @param {THREE.Vector3} along unit direction of the face's long axis
 * @param {number} thickness half-depth below the face
 * @param {THREE.Matrix4} out
 */
export function slabMatrix(origin, normal, along, thickness, out) {
  _sy.copy(normal).normalize();
  // Orthogonalise the requested long axis against the face normal.
  _sz.copy(along).addScaledVector(_sy, -along.dot(_sy));
  if (_sz.lengthSq() < 1e-8) _sz.set(0, 0, 1).addScaledVector(_sy, -_sy.z);
  _sz.normalize();
  _sx.crossVectors(_sy, _sz).normalize();
  out.makeBasis(_sx, _sy, _sz);
  out.setPosition(
    origin.x - _sy.x * thickness,
    origin.y - _sy.y * thickness,
    origin.z - _sy.z * thickness
  );
  return out;
}
