import { finiteCoord, readAngle, readVec3, round, type Vec3 } from './mapOverlaySchema';

/**
 * The layout a world reports about itself, and the arithmetic over it.
 *
 * Imports one type and the coordinate readers, for `mapOverlaySchema.ts`'s reason: pure
 * functions over plain data, so the editor (browser), the save route (lambda)
 * and the tests (node) run the SAME code — hence `atob`/`btoa` over a
 * `DataView`, not `Buffer`; the editor decodes the grid to draw it. The grid is
 * LAYERED because roofs collide: the station dome is a collider above the deck,
 * and one "height at (x, z)" would put every deck placement sixty metres
 * underground. Each sample holds up to four surfaces, top down, as Int16
 * centimetres (±327 m covers every world); `NO_SAMPLE` is the Int16 minimum.
 * A column with more surfaces than layers keeps the top three AND the lowest
 * (the sampler's floor-keeping rule, `src/systems/GroundSampler.js`): the last
 * stored layer is the floor under a roof, never the fourth surface from the
 * top - nothing here reads a slot by index, so no decoder changed for it.
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
 * — this only checks the byte count.
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

/**
 * Nearest layer at or below `y`, chosen PER CORNER, then bilinear. A corner with no layer at/below takes its lowest; a corner with no layers is no sample → null.
 * `y` must be finite, else null — to get the lowest layer under a point use `layersAt(...).at(-1)`.
 */
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

/** An integer in [min, max]; else null. */
function integer(raw: unknown, min: number, max: number): number | null {
  return typeof raw === 'number' && Number.isInteger(raw) && raw >= min && raw <= max ? raw : null;
}

const MAX_STROKE_WIDTH = 64;   // the widest stroke any minimap draws today is 19

/** A stroke width in [0, MAX_STROKE_WIDTH] to the millimetre; else absent. Bounded, not merely finite: 1e306 rounds to Infinity, which JSONB stores as null. */
function strokeWidth(raw: unknown): number | undefined {
  if (typeof raw !== 'number' || !Number.isFinite(raw)) return undefined;
  const w = round(raw, 3) + 0;   // -0.0004 rounds to -0, which passes `>= 0`; adding 0 makes it the 0 it means
  return w >= 0 && w <= MAX_STROKE_WIDTH ? w : undefined;
}

/** Minimap colours arrive as a Three hex number (an 0xrrggbb integer) or a CSS string; a well-formed one is kept as sent, anything else is absent. */
function colour(raw: unknown): number | string | undefined {
  if (typeof raw === 'number') return Number.isInteger(raw) && raw >= 0 && raw <= 0xffffff ? raw : undefined;
  return typeof raw === 'string' && raw.length > 0 && raw.length <= 32 ? raw : undefined;
}

type Style = { fill?: number | string; stroke?: number | string; width?: number };

function style(r: Record<string, unknown>): Style {
  const s: Style = {};
  const fill = colour(r.fill), stroke = colour(r.stroke), width = strokeWidth(r.width);
  if (fill !== undefined) s.fill = fill;
  if (stroke !== undefined) s.stroke = stroke;
  if (width !== undefined) s.width = width;
  return s;
}

const MAX_PATH_POINTS = 4000;   // the longest minimap path today is a few hundred points

function validateShape(raw: unknown): LayoutShape | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  const s = style(r);
  if (r.kind === 'rect') {
    const x = finiteCoord(r.x), z = finiteCoord(r.z), w = finiteCoord(r.w), d = finiteCoord(r.d);
    if (x === null || z === null || w === null || d === null) return null;
    const rotation = readAngle(r.rotation);   // wrapped into (-π, π] like an overlay entry's yaw, so 1e303 cannot round to Infinity
    return { kind: 'rect', x, z, w, d, ...(rotation !== undefined ? { rotation } : {}), ...s };
  }
  if (r.kind === 'circle') {
    const x = finiteCoord(r.x), z = finiteCoord(r.z), rad = finiteCoord(r.r);
    if (x === null || z === null || rad === null) return null;
    return { kind: 'circle', x, z, r: rad, ...s };
  }
  if (r.kind === 'path' && Array.isArray(r.points)) {
    const points: [number, number][] = [];
    for (const p of r.points.slice(0, MAX_PATH_POINTS)) {
      const px = Array.isArray(p) ? finiteCoord(p[0]) : null;
      const pz = Array.isArray(p) ? finiteCoord(p[1]) : null;
      if (px !== null && pz !== null) points.push([px, pz]);   // one bad vertex does not lose the wall
    }
    if (points.length < 2) return null;
    return {
      kind: 'path',
      points,
      ...(s.stroke !== undefined ? { stroke: s.stroke } : {}),
      ...(s.width !== undefined ? { width: s.width } : {}),
      ...(r.closed === true ? { closed: true } : {}),
    };
  }
  return null;
}

export function validateBounds(raw: unknown): LayoutBounds | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const min = readVec3(r.min), max = readVec3(r.max);
  if (!min || !max || min.x > max.x || min.y > max.y || min.z > max.z) return null;
  return { min, max };
}

export interface ShapeAudit {
  shapes: LayoutShape[];
  /** Read and could not be used. */
  unreadable: number;
  /** Never read: the cap was reached first. */
  truncated: number;
}

/**
 * Unknown kinds and unusable shapes are dropped one at a time, never the whole list: a map with one bad wall is
 * still a map. The two counts are kept apart because neither follows from the lengths: MAX_SHAPES readable out of
 * MAX_SHAPES + 1 sent is one unreadable and NOTHING truncated, and a caller comparing lengths would say the reverse.
 */
export function auditShapes(raw: unknown): ShapeAudit {
  if (!Array.isArray(raw)) return { shapes: [], unreadable: 0, truncated: 0 };
  const shapes: LayoutShape[] = [];
  let unreadable = 0;
  let i = 0;
  for (; i < raw.length && shapes.length < MAX_SHAPES; i++) {
    const shape = validateShape(raw[i]);
    if (shape) shapes.push(shape);
    else unreadable++;
  }
  return { shapes, unreadable, truncated: raw.length - i };
}

export function validateShapes(raw: unknown): LayoutShape[] {
  return auditShapes(raw).shapes;
}

export function validateGround(input: unknown): LayoutGround | null {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
  const r = input as Record<string, unknown>;
  const originX = finiteCoord(r.originX), originZ = finiteCoord(r.originZ);
  const step = finiteCoord(r.step);   // checked for > 0 AFTER rounding: a 0.1 mm step would otherwise pass as 0
  const nx = integer(r.nx, 1, MAX_GRID_AXIS), nz = integer(r.nz, 1, MAX_GRID_AXIS), layers = integer(r.layers, 1, MAX_LAYERS);
  if (originX === null || originZ === null || step === null || step <= 0 || nx === null || nz === null || layers === null) return null;
  // The length of `btoa`'s output for THIS header, exactly — so a string carrying whitespace, extra padding or more bytes than the grid holds is over the bound and refused before atob touches it. (The max-grid test holds the boundary.)
  if (typeof r.heightsCm !== 'string' || r.heightsCm.length > 4 * Math.ceil((nx * nz * layers * 2) / 3)) return null;
  const ground: LayoutGround = { originX, originZ, step, nx, nz, layers, heightsCm: r.heightsCm };
  try {
    decodeGround(ground);   // the only way to know the bytes fit the header is to look
  } catch {
    return null;
  }
  return ground;
}

/**
 * Validate an untrusted layout; returns null when unusable. Reads the wire key `layoutSchema` or the stored key `schema`.
 *
 * The policy, so the route and the editor agree on it:
 * - A coordinate that is not finite or lies outside ±WORLD_COORD_LIMIT is REFUSED, never clamped (the overlay schema's
 *   rule): in the bounds it refuses the layout, in a shape it drops that shape, in the ground header it drops the ground.
 * - Shape and vertex lists are cut at MAX_SHAPES / MAX_PATH_POINTS; an unreadable shape or vertex is dropped, not the layout.
 * - Rotation is wrapped into (-π, π]; a stroke width outside [0, MAX_STROKE_WIDTH] or a colour that is neither an
 *   0xrrggbb integer nor a 1-32 character string is dropped from its shape, which is otherwise kept.
 * - `ground: null` in the result means ABSENT OR INVALID. The report route must treat it as keep-prior, never as clear.
 * - Never throws for JSON-shaped input. A throwing getter is outside that contract, so there is deliberately no
 *   try/catch around the body: it would hide a bug as "no layout".
 */
export function validateLayout(input: unknown): WorldLayout | null {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
  const r = input as Record<string, unknown>;
  if ((r.schema ?? r.layoutSchema) !== LAYOUT_SCHEMA) return null;
  const bounds = validateBounds(r.bounds);
  if (!bounds) return null;
  const ground = r.ground === undefined || r.ground === null ? null : validateGround(r.ground);
  return { schema: LAYOUT_SCHEMA, bounds, shapes: validateShapes(r.shapes), ground };
}
