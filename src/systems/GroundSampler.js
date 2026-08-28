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
 * Resolution: surfaces closer than ~2 cm may merge into one layer, because a
 * re-cast from 1 cm below a hit can start on, or inside, the next surface.
 *
 * THE FLOOR IS ALWAYS KEPT: a cell stores the top L-1 surfaces AND THE LOWEST
 * ("the top three and the floor" at L = 4). Casting keeps going after the cap
 * and every further hit overwrites the last slot, so whatever is lowest ends
 * there. Stopping at four hits, as this once did, dropped the fifth: under
 * the station hub a column reads dome 171.42, canopy 62 / 61.5 / 59.3, deck 0,
 * and the editor - whose `placementY` is the lowest stored layer - said "on
 * surface" at 61.5 and the game spawned the item on the canopy beam above a
 * player standing on the deck (2 084 of the hub's 3 505 cells, 59%, had four
 * layers with the lowest above 1 m). The wire format is unchanged (same L,
 * same LAYOUT_SCHEMA): only WHICH four heights are kept moved, so a world's
 * grid carries its floors after its next visit re-samples it. The cost is
 * bounded by the column: S surfaces cost S hits and one miss, so past the cap
 * a cell pays S - L + 1 extra casts (the S - L hits below the cap, plus the
 * miss the cap once spared); the peel still stops at `floorY`, MAX_SKIPS
 * still applies, and MAX_CASTS (64) is the absolute ceiling a cell can cost -
 * without it a raycast answering a hair below its origin every time would
 * run (topY - floorY) / PEEL casts, ~19 400 on station, inside one cell,
 * where `run()` never checks its budget.
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
/** How far below a hit the next cast starts (spec §7: 1 cm). */
const PEEL = 0.01;
/**
 * How many times a cell may step down past a hit AT its own origin before it
 * gives up. Such a hit is float noise from the face the re-cast started on -
 * the physics rounded the distance to nothing - never a surface below.
 */
const MAX_SKIPS = 4;
/**
 * The most casts one cell may make, honest hits included. L + MAX_SKIPS + a
 * dozen decks with room to spare; the only constant bound on a cell once the
 * layer cap stopped ending it (a cast that keeps answering just below its
 * origin is otherwise bounded by floorY alone: thousands of casts in one cell,
 * and run() checks its budget only between cells).
 */
const MAX_CASTS = 64;

/**
 * Samples run to the first multiple of `step` at or past the far edge, so no
 * strip of the world reads no-ground for want of a sample.
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
  return { originX: min.x, originZ: min.z, step, nx: Math.ceil(w / step) + 1, nz: Math.ceil(d / step) + 1 };
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
  const usable = !!plan
    && Number.isInteger(plan.nx) && plan.nx > 0 && Number.isInteger(plan.nz) && plan.nz > 0
    && Number.isFinite(plan.step) && plan.step > 0
    && Number.isFinite(plan.originX) && Number.isFinite(plan.originZ);
  if (!usable) throw new Error('GroundSampler.createJob: invalid plan');
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
    let skips = 0;
    let k = 0;
    let casts = 0;
    // Not `k < L`: the cast goes on past the cap until it misses, reaches
    // floorY or spends MAX_CASTS, so the LAST slot holds the lowest surface -
    // the floor under a roof - not merely the fourth from the top (see the header).
    for (;;) {
      const drop = y - floorY;
      if (!(drop > 0)) break;
      if (++casts > MAX_CASTS) break;
      const h = cast(x, y, z, drop);
      if (typeof h !== 'number' || !Number.isFinite(h)) break;
      if (h >= y) {
        // A hit at or above where the ray started is not a surface below it.
        // Storing it would repeat a layer; ENDING the cell here - as this once
        // did - lost everything beneath, the floor included, in every column
        // of a world at about 6% of slab heights. Step down and cast again, a
        // bounded number of times, so a cast that always does this cannot spin.
        if (++skips > MAX_SKIPS) break;
        y -= PEEL;
        continue;
      }
      // Stored heights only ever fall: layer 0 is topmost by construction, and
      // once the slots are full each lower hit replaces the last one.
      heights[base + Math.min(k, L - 1)] = toCm(h);
      k++;
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
      return this.done;
    },
    result() {
      if (next < total) throw new Error(`GroundSampler: result() before the job is done (${next}/${total})`);
      return { originX, originZ, step, nx, nz, layers: L, heightsCm: encodeInt16Base64(heights) };
    },
  };
}
