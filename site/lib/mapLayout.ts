import { WORLD_COORD_LIMIT, type Vec3 } from './mapOverlaySchema';

/**
 * The layout a world reports about itself, and the arithmetic over it.
 *
 * Imports one type and one limit, for `mapOverlaySchema.ts`'s reason: pure
 * functions over plain data, so the editor (browser), the save route (lambda)
 * and the tests (node) run the SAME code — hence `atob`/`btoa` over a
 * `DataView`, not `Buffer`; the editor decodes the grid to draw it. The grid is
 * LAYERED because roofs collide: the station dome is a collider above the deck,
 * and one "height at (x, z)" would put every deck placement sixty metres
 * underground. Each sample holds up to four surfaces, top down, as Int16
 * centimetres (±327 m covers every world); `NO_SAMPLE` is the Int16 minimum.
 */

export const LAYOUT_SCHEMA = 1;
export const NO_SAMPLE = -32768;                 // Int16 min = no surface in that layer
export const MAX_GRID_AXIS = 400;
export const MAX_LAYERS = 4;
export const MAX_SHAPES = 5000;
export const MAX_LAYOUT_BYTES = 4_000_000;

export interface LayoutBounds { min: Vec3; max: Vec3 }

export type LayoutShape =
  | { kind: 'rect'; x: number; z: number; w: number; d: number; rotation?: number; fill?: number | string; stroke?: number | string; width?: number }
  | { kind: 'circle'; x: number; z: number; r: number; fill?: number | string; stroke?: number | string; width?: number }
  | { kind: 'path'; points: [number, number][]; stroke?: number | string; width?: number; closed?: boolean };

export interface LayoutGround {
  originX: number; originZ: number;   // world x,z of cell (0,0)
  step: number;                       // metres between samples; = max(4, ceil(extent / 256))
  nx: number; nz: number;             // samples per axis; sample (i,j) is at (originX + i*step, originZ + j*step)
  layers: number;                     // ≤ 4; layer 0 is the TOPMOST surface
  heightsCm: string;                  // base64 of Int16 little-endian, length nx*nz*layers,
                                      // index = ((j * nx) + i) * layers + k; NO_SAMPLE pads; cm clamped to ±32767
}

export interface WorldLayout { schema: 1; bounds: LayoutBounds; shapes: LayoutShape[]; ground: LayoutGround | null }

export interface DecodedGround extends Omit<LayoutGround, 'heightsCm'> { heights: Int16Array }

const CM = 100;

/** base64 of little-endian Int16 — the exact bytes the game's sampler emits. */
export function encodeHeights(h: Int16Array): string {
  const bytes = new Uint8Array(h.length * 2);
  const view = new DataView(bytes.buffer);
  for (let i = 0; i < h.length; i++) view.setInt16(i * 2, h[i], true);
  // `fromCharCode.apply` over a whole 1.3 MB grid blows the argument limit; 8 KB slices do not.
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x2000) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x2000) as unknown as number[]);
  }
  return btoa(binary);
}

/**
 * Throws on a length mismatch or bad base64: a grid that does not fit its own header is not a grid.
 * Header assumed validated (positive integers within MAX_GRID_AXIS / MAX_LAYERS); see `validateGround`
 * (Task 3) — this only checks the byte count.
 */
export function decodeGround(g: LayoutGround): DecodedGround {
  const count = g.nx * g.nz * g.layers;
  const binary = atob(g.heightsCm);
  if (binary.length !== count * 2) {
    throw new Error(`heightsCm is ${binary.length} bytes; ${g.nx}×${g.nz}×${g.layers} Int16 needs ${count * 2}`);
  }
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  const view = new DataView(bytes.buffer);
  const heights = new Int16Array(count);
  for (let i = 0; i < count; i++) heights[i] = view.getInt16(i * 2, true);
  return { originX: g.originX, originZ: g.originZ, step: g.step, nx: g.nx, nz: g.nz, layers: g.layers, heights };
}

/** One corner, in cm: nearest layer at or below `yCm`; else its lowest ("underground" needs a surface to be under); else null. */
function cornerCm(g: DecodedGround, i: number, j: number, yCm: number): number | null {
  const base = (j * g.nx + i) * g.layers;
  let below: number | null = null;
  let lowest: number | null = null;
  for (let k = 0; k < g.layers; k++) {
    const h = g.heights[base + k];
    if (h === NO_SAMPLE) continue;
    if (lowest === null || h < lowest) lowest = h;
    if (h <= yCm && (below === null || h > below)) below = h;
  }
  return below ?? lowest;
}

/** Nearest layer at or below `y`, chosen PER CORNER, then bilinear. A corner with no layer at/below takes its lowest; a corner with no layers is no sample → null. */
export function groundAt(g: DecodedGround | null, x: number, z: number, y: number): number | null {
  if (!Number.isFinite(y)) return null;   // a NaN y would otherwise read every corner's lowest layer, silently
  if (!g || g.nx < 1 || g.nz < 1 || !(g.step > 0)) return null;
  const fx = (x - g.originX) / g.step;
  const fz = (z - g.originZ) / g.step;
  // A positive test, so NaN falls out here rather than inside an index.
  if (!(fx >= 0 && fz >= 0 && fx <= g.nx - 1 && fz <= g.nz - 1)) return null;
  const i0 = Math.min(Math.floor(fx), g.nx - 1);
  const j0 = Math.min(Math.floor(fz), g.nz - 1);
  const i1 = Math.min(i0 + 1, g.nx - 1);
  const j1 = Math.min(j0 + 1, g.nz - 1);
  const tx = fx - i0;
  const tz = fz - j0;
  // Round: 0.57 * 100 is 56.99999999999999 in a double, which would miss the 57 cm layer the value denotes.
  // Half a centimetre is the widest symmetric tolerance that cannot reach a neighbouring layer (the sampler re-casts 1 cm below each hit).
  const yCm = Math.round(y * CM);
  const c00 = cornerCm(g, i0, j0, yCm);
  const c10 = cornerCm(g, i1, j0, yCm);
  const c01 = cornerCm(g, i0, j1, yCm);
  const c11 = cornerCm(g, i1, j1, yCm);
  if (c00 === null || c10 === null || c01 === null || c11 === null) return null;
  const near = c00 + (c10 - c00) * tx;
  const far = c01 + (c11 - c01) * tx;
  return (near + (far - near) * tz) / CM;
}

/** All surfaces at the nearest sample to (x,z), top-down, metres — for the layer picker. */
export function layersAt(g: DecodedGround | null, x: number, z: number): number[] {
  if (!g || g.nx < 1 || g.nz < 1 || !(g.step > 0)) return [];
  const i = Math.round((x - g.originX) / g.step);
  const j = Math.round((z - g.originZ) / g.step);
  if (!(i >= 0 && j >= 0 && i < g.nx && j < g.nz)) return [];
  const base = (j * g.nx + i) * g.layers;
  const out: number[] = [];
  for (let k = 0; k < g.layers; k++) {
    const h = g.heights[base + k];
    if (h !== NO_SAMPLE) out.push(h / CM);
  }
  return out.sort((a, b) => b - a);   // top-down is this function's promise, not the byte producer's
}
