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
  const step = Math.max(MIN_STEP, Math.ceil(Math.max(w, d) / TARGET_CELLS));
  return { originX: min.x, originZ: min.z, step, nx: Math.floor(w / step) + 1, nz: Math.floor(d / step) + 1 };
}

/**
 * Int16 → little-endian bytes → base64. Byte order written by hand, not read
 * off the typed array's buffer, so the wire format does not depend on the
 * machine; `btoa` not Buffer, so it runs in the browser.
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

export function createJob() {
  throw new Error('createJob: not implemented yet (Task 2)');
}
