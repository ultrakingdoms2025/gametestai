// src/systems/GroundSampler.js
/**
 * The map editor's ground grid: where the floor is, every few metres, as the
 * physics sees it.
 *
 * PURE: no Three.js, no Physics import. A `cast(x, yTop, z, maxDrop) → y|null`
 * callback is handed in, so the arithmetic, the layering and the packing are
 * testable against known surfaces; MapOverlay owns the one line that touches
 * `Physics.raycast`.
 *
 * LAYERED, because roofs collide: the station dome is a collider, and one
 * downward cast would call it the hub's floor. Each cell keeps up to four hits
 * top-down, re-cast from a centimetre below the last - a ray that STARTS
 * INSIDE a box does not hit it (`Physics._raycastCollider`, `tmin <= 0`), so
 * the re-cast finds the next surface. Layer 0 is topmost; the rest NO_SAMPLE.
 *
 * RESUMABLE, because 62 000 cells do not fit in a frame: `run(budgetMs, now)`
 * samples until the budget is spent; MapOverlay ticks it every frame.
 *
 * Wire format (site/lib/mapLayout.ts decodes exactly this): heightsCm = base64
 * of Int16 LE, length nx*nz*layers, index ((j*nx)+i)*layers+k, sample (i,j)
 * at (originX+i*step, originZ+j*step).
 */

export const LAYOUT_SCHEMA = 1;
/** Int16 minimum: "no surface in this layer". */
export const NO_SAMPLE = -32768;
export const MAX_LAYERS = 4;
/** Never finer than 4 m, never more than ~256 samples an axis (spec §7). */
const MIN_STEP = 4;
const TARGET_CELLS = 256;
/** How far below a hit the next cast starts. */
const PEEL = 0.01;

/**
 * @param {{min:{x:number,z:number}, max:{x:number,z:number}}|null} bounds
 * @returns {{originX:number, originZ:number, step:number, nx:number, nz:number}|null}
 */
export function planGrid(bounds) {
  const min = bounds?.min;
  const max = bounds?.max;
  if (!min || !max) return null;
  const w = max.x - min.x;
  const d = max.z - min.z;
  if (!(w > 0) || !(d > 0)) return null;
  if (!Number.isFinite(w) || !Number.isFinite(d)) return null;
  const step = Math.max(MIN_STEP, Math.ceil(Math.max(w, d) / TARGET_CELLS));
  return { originX: min.x, originZ: min.z, step, nx: Math.floor(w / step) + 1, nz: Math.floor(d / step) + 1 };
}

/**
 * Int16 → little-endian bytes → base64. Byte order written by hand, not read
 * off the typed array's buffer, so the wire format does not depend on the
 * machine; `btoa` not Buffer, so it runs in the browser.
 * @param {Int16Array} values
 */
export function encodeInt16Base64(values) {
  const n = values.length;
  const bytes = new Uint8Array(n * 2);
  for (let i = 0; i < n; i++) {
    const v = values[i];
    bytes[i * 2] = v & 0xff;
    bytes[i * 2 + 1] = (v >> 8) & 0xff;
  }
  let s = '';
  // fromCharCode takes its arguments on the stack; 8 K at a time is safe everywhere.
  for (let i = 0; i < bytes.length; i += 0x2000) {
    s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x2000));
  }
  return btoa(s);
}

const toCm = (metres) => Math.max(-32767, Math.min(32767, Math.round(metres * 100)));

/**
 * A resumable sampling job over `plan`.
 * @param {{originX:number, originZ:number, step:number, nx:number, nz:number}} plan
 * @param {(x:number, yTop:number, z:number, maxDrop:number) => number|null} cast
 *   The first surface below `yTop` within `maxDrop`, or null.
 * @param {{layers?:number, topY?:number, floorY?:number}} [opts] `topY`: where
 *   each cell's first cast starts (bounds.max.y + 10 - the dome and a 260 m
 *   planet both sit above groundHeight's 200 m default); `floorY`: where it stops.
 */
export function createJob(plan, cast, { layers = MAX_LAYERS, topY = 200, floorY = -200 } = {}) {
  const { originX, originZ, step, nx, nz } = plan;
  const L = Math.max(1, Math.min(MAX_LAYERS, layers | 0));
  const total = nx * nz;
  const heights = new Int16Array(total * L).fill(NO_SAMPLE);
  let next = 0; // cell index j*nx + i; cells are sampled in wire order

  function sampleCell(i, j) {
    const x = originX + i * step;
    const z = originZ + j * step;
    const base = (j * nx + i) * L;
    let y = topY;
    for (let k = 0; k < L; k++) {
      const drop = y - floorY;
      if (!(drop > 0)) break;
      const h = cast(x, y, z, drop);
      if (typeof h !== 'number' || !Number.isFinite(h)) break;
      heights[base + k] = toCm(h);
      y = h - PEEL;
    }
  }

  return {
    plan,
    layers: L,
    cells: total,
    get done() { return next >= total; },
    get sampled() { return next; },
    get progress() { return total ? next / total : 1; },
    /** Sample until `budgetMs` of `now()` has elapsed; checked BEFORE each cell,
     *  so budget 0 samples nothing and a late frame overpays by at most one cell. */
    run(budgetMs, now) {
      const start = now();
      while (next < total && now() - start < budgetMs) {
        const i = next % nx;
        sampleCell(i, (next - i) / nx);
        next++;
      }
      return next >= total;
    },
    result() {
      // The site's decoder throws on a length mismatch; the game must never send one.
      if (heights.length !== nx * nz * L) {
        throw new Error(`GroundSampler: ${heights.length} heights for a ${nx}×${nz}×${L} grid`);
      }
      return { originX, originZ, step, nx, nz, layers: L, heightsCm: encodeInt16Base64(heights) };
    },
  };
}
