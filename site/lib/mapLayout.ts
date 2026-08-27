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

/** Throws on a length mismatch or bad base64: a grid that does not fit its own header is not a grid. */
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
