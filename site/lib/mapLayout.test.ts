import { describe, it, expect } from 'vitest';
import { WORLD_COORD_LIMIT } from './mapOverlaySchema';
import {
  LAYOUT_SCHEMA, MAX_GRID_AXIS, MAX_LAYERS, MAX_SHAPES, NO_SAMPLE,
  auditShapes, decodeGround, encodeHeights, groundAt, layersAt, validateGround, validateLayout, validateShapes,
  type LayoutGround,
} from './mapLayout';

/**
 * THE CLAIM: the arithmetic the editor and the save route share over a
 * world's reported layout is right at the edges — cell, roof, grid and byte —
 * because every conflict warning and snapped Y comes from it, and the game
 * never checks the answer. Not a stub: every case builds a real Int16 grid
 * through `encodeHeights` (the e2e seeder's function) and asserts a NUMBER a
 * hand calculation gives. The byte edge is the codec, its 8 KB slice boundary,
 * and the largest grid the limits allow. The roof edge is `groundAt`: the
 * station dome, the one shape a single-height lookup gets wrong by sixty
 * metres, and the roof's EDGE, where the four corners hold different layer
 * counts and any per-cell "layer k" reads a hole or the roof instead of the
 * floor. `layersAt` is the picker's list at the nearest sample.
 * `validateGround` / `validateLayout` are the boundary: a browser sent the
 * layout, and the report route must never hand `decodeGround` an unvalidated
 * header — so each rejection fixture below is one that would DECODE if its
 * check were gone (byte counts chosen to fit the nonsense header), never one
 * decode would refuse anyway.
 */

/** index = ((j * nx) + i) * layers + k — the wire order, so fixtures read that way. */
function grid(nx: number, nz: number, layers: number, cm: ArrayLike<number>, step = 10): LayoutGround {
  if (cm.length !== nx * nz * layers) throw new Error('fixture size');
  return { originX: 0, originZ: 0, step, nx, nz, layers, heightsCm: encodeHeights(Int16Array.from(cm)) };
}

/** A full-range, non-repeating fill: 7919 is prime, so no two nearby cells share a value. */
function fill(count: number): Int16Array {
  const h = new Int16Array(count);
  for (let i = 0; i < count; i++) h[i] = ((i * 7919) % 65536) - 32768;
  return h;
}

/** Index of the first differing element, or -1 — element-wise without a 640 000-entry diff on failure. */
function firstMismatch(a: Int16Array, b: Int16Array): number {
  if (a.length !== b.length) return Math.min(a.length, b.length);
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return i;
  return -1;
}

describe('the Int16 codec', () => {
  it('round-trips signed centimetres little-endian, pad included, under the pinned limits', () => {
    expect([LAYOUT_SCHEMA, NO_SAMPLE, MAX_GRID_AXIS, MAX_LAYERS, MAX_SHAPES]).toEqual([1, -32768, 400, 4, 5000]);
    const cm = [0, 150, -32768, 32767, -1, 12345];
    const g = decodeGround(grid(3, 2, 1, cm));
    expect(Array.from(g.heights)).toEqual(cm);
    expect([g.nx, g.nz, g.layers, g.step]).toEqual([3, 2, 1, 10]);
  });

  it('encodes 150 cm as the bytes 96 00, not 00 96', () => {
    expect(encodeHeights(Int16Array.from([150]))).toBe('lgA=');
  });

  it('throws when the bytes do not fit the grid, rather than reading past the end', () => {
    expect(() => decodeGround({ ...grid(2, 2, 1, [1, 2, 3, 4]), nx: 3 })).toThrow(/8 bytes/);
  });

  it('round-trips a grid that crosses the 8 KB fromCharCode slice boundary', () => {
    // 0x2000 bytes = 4096 samples per slice; 4097 puts exactly one sample in a second slice.
    const src = fill(4097);
    const g = decodeGround(grid(4097, 1, 1, src));
    expect(g.heights.length).toBe(4097);
    expect(firstMismatch(g.heights, src)).toBe(-1);
  });

  it('round-trips the maximum grid the limits allow, 400 x 400 x 4, exactly', () => {
    const src = fill(MAX_GRID_AXIS * MAX_GRID_AXIS * MAX_LAYERS);
    const g = decodeGround(grid(MAX_GRID_AXIS, MAX_GRID_AXIS, MAX_LAYERS, src));
    expect(g.heights.length).toBe(640_000);
    expect(firstMismatch(g.heights, src)).toBe(-1);
  });
});

describe('groundAt', () => {
  // Two 10 m cells per axis; the floor rises 10 m across x. Corners (i,j): (0,0),(1,0),(0,1),(1,1).
  const slope = decodeGround(grid(2, 2, 1, [0, 1000, 0, 1000]));

  it('interpolates a flat single layer exactly', () => {
    expect(groundAt(slope, 5, 3, 50)).toBe(5);
    expect(groundAt(slope, 0, 0, 50)).toBe(0);
    expect(groundAt(slope, 10, 10, 50)).toBe(10);
    expect(groundAt(slope, 2.5, 7, 50)).toBe(2.5);
  });

  it('under a 20 m roof over a 0 m floor, y=1 reads the floor and y=25 reads the roof', () => {
    const dome = decodeGround(grid(2, 2, 2, [2000, 0, 2000, 0, 2000, 0, 2000, 0]));
    expect(groundAt(dome, 5, 5, 1)).toBe(0);
    expect(groundAt(dome, 5, 5, 25)).toBe(20);
    expect(groundAt(dome, 5, 5, 20)).toBe(20);   // "at or below" includes "at"
    // A corner with no layer at or below y takes its lowest: roof 20 m, floor 5 m, y = 1.
    const raised = decodeGround(grid(2, 2, 2, [2000, 500, 2000, 500, 2000, 500, 2000, 500]));
    expect(groundAt(raised, 5, 5, 1)).toBe(5);
  });

  it('a cell with a NO_SAMPLE corner is no sample, whatever its other corners hold', () => {
    expect(groundAt(decodeGround(grid(2, 2, 1, [0, 0, 0, NO_SAMPLE])), 5, 5, 50)).toBeNull();
    const edge = decodeGround(grid(2, 2, 2, [0, 0, 0, 0, 0, 0, NO_SAMPLE, NO_SAMPLE]));
    expect(groundAt(edge, 5, 5, 50)).toBeNull();
  });

  it('at a roof edge picks the layer PER CORNER — the case that separates this rule from per-cell layer k', () => {
    // Near corners: roof 20 m over floor 0; far corners: floor only. y = 1 → every corner picks 0. Per-cell "layer 1" is null (NO_SAMPLE far); per-cell "layer 0" is 10.
    const edge = decodeGround(grid(2, 2, 2, [2000, 0, 2000, 0, 0, NO_SAMPLE, 0, NO_SAMPLE]));
    expect(groundAt(edge, 5, 5, 1)).toBe(0);
    expect(groundAt(edge, 5, 5, 25)).toBe(10);   // above the roof: near corners roof, far corners floor, blended
  });

  it('reads the layer a two-decimal metre denotes, not the one below it', () => {
    // 0.57 * 100 is 56.99999999999999 in a double; "at or below" must still find the 57 cm mezzanine, not the -5 m floor.
    const mezzanine = decodeGround(grid(2, 2, 3, [2000, 57, -500, 2000, 57, -500, 2000, 57, -500, 2000, 57, -500]));
    expect(groundAt(mezzanine, 5, 5, 0.57)).toBe(0.57);
  });

  it('is null for a NaN y rather than silently reading the lowest layer', () => {
    expect(groundAt(slope, 5, 3, NaN)).toBeNull();
  });

  it('is null outside the grid, for NaN, and without a grid; honours the origin', () => {
    expect(groundAt(slope, -0.01, 5, 50)).toBeNull();
    expect(groundAt(slope, 10.01, 5, 50)).toBeNull();
    expect(groundAt(slope, 5, 11, 50)).toBeNull();
    expect(groundAt(slope, NaN, 5, 50)).toBeNull();
    expect(groundAt(null, 5, 5, 50)).toBeNull();
    const moved = { ...slope, originX: -100, originZ: 40 };
    expect(groundAt(moved, -95, 45, 50)).toBe(5);
    expect(groundAt(moved, 5, 45, 50)).toBeNull();
  });
});

describe('layersAt', () => {
  const dome = decodeGround(grid(2, 2, 3, [2000, 0, NO_SAMPLE, 2000, 0, NO_SAMPLE, 500, NO_SAMPLE, NO_SAMPLE, NO_SAMPLE, NO_SAMPLE, NO_SAMPLE]));

  it('lists the surfaces at the nearest sample in metres, top first, pads removed', () => {
    expect(layersAt(dome, 1, 2)).toEqual([20, 0]);   // nearest sample is (0,0)
    expect(layersAt(dome, 3, 8)).toEqual([5]);       // (0,1)
    expect(layersAt(dome, 9, 9)).toEqual([]);        // (1,1): no surface
  });

  it('orders top-down itself when the bytes arrive bottom-up', () => {
    expect(layersAt(decodeGround(grid(1, 1, 3, [0, 2000, NO_SAMPLE])), 0, 0)).toEqual([20, 0]);
  });

  it('is empty outside the grid or without one', () => {
    expect(layersAt(dome, 16, 0)).toEqual([]);
    expect(layersAt(dome, -6, 0)).toEqual([]);
    expect(layersAt(null, 0, 0)).toEqual([]);
  });
});

const GOOD_GROUND = grid(3, 3, 1, new Array(9).fill(150));
const BOUNDS = { min: { x: -50, y: 0, z: -50 }, max: { x: 50, y: 20, z: 50 } };
const GOOD_LAYOUT = { layoutSchema: 1, bounds: BOUNDS, shapes: [{ kind: 'rect', x: 0, z: 0, w: 4, d: 4, fill: 0x224466 }], ground: GOOD_GROUND };

describe('validateGround', () => {
  // Every header fixture keeps nx*nz*layers equal to the samples sent (nine, or a count named beside it):
  // take away the check under test and `decodeGround` would accept the grid, so a null here proves the check.
  it.each([
    ['nx over the cap', { ...GOOD_GROUND, nx: MAX_GRID_AXIS + 1, nz: 1, heightsCm: encodeHeights(new Int16Array(MAX_GRID_AXIS + 1)) }],
    ['nz below one', { ...GOOD_GROUND, nz: 0, heightsCm: '' }],
    ['a negative axis', { ...GOOD_GROUND, nx: -3, nz: -3 }],                        // (-3)(-3)(1) = 9
    ['a fractional axis', { ...GOOD_GROUND, nx: 1.5, nz: 6 }],                      // 1.5 * 6 = 9
    ['an axis sent as a string', { ...GOOD_GROUND, nx: '3' }],                       // '3' * 3 * 1 coerces to 9
    ['layers over the cap', { ...GOOD_GROUND, layers: MAX_LAYERS + 1, heightsCm: encodeHeights(new Int16Array(9 * (MAX_LAYERS + 1))) }],
    ['layers below one', { ...GOOD_GROUND, layers: 0, heightsCm: '' }],
    ['a fractional layer count', { ...GOOD_GROUND, nx: 2, nz: 3, layers: 1.5 }],    // 2 * 3 * 1.5 = 9
    ['heights that do not fit the grid', { ...GOOD_GROUND, heightsCm: encodeHeights(new Int16Array(8)) }],
    ['heights that are not base64', { ...GOOD_GROUND, heightsCm: '***' }],
    ['heights that are not a string', { ...GOOD_GROUND, heightsCm: [GOOD_GROUND.heightsCm] }],   // atob would coerce the array to its one string
    ['heights longer than the header could need', { ...GOOD_GROUND, heightsCm: 'A'.repeat(1_000_000) }],   // refused by length, before any decode
    ['a NaN origin', { ...GOOD_GROUND, originX: NaN }],
    ['an origin sent as a string', { ...GOOD_GROUND, originZ: '0' }],
    ['an origin past the coordinate limit', { ...GOOD_GROUND, originZ: WORLD_COORD_LIMIT + 1 }],
    ['a zero step', { ...GOOD_GROUND, step: 0 }],
    ['a negative step', { ...GOOD_GROUND, step: -10 }],
    ['an infinite step', { ...GOOD_GROUND, step: Infinity }],
    ['a step that rounds to zero at millimetre precision', { ...GOOD_GROUND, step: 0.0001 }],
    ['not an object', 'ground'],
    ['an array', []],
    ['null', null],
  ])('rejects %s', (_, input) => {
    expect(validateGround(input)).toBeNull();
  });

  it('keeps a well-formed grid byte for byte, coordinates rounded to millimetres, nothing else carried over', () => {
    expect(validateGround({ ...GOOD_GROUND, originX: 1.23456, extra: 'dropped' })).toEqual({ ...GOOD_GROUND, originX: 1.235 });
  });

  it('accepts the largest grid the caps allow, byte for byte', () => {
    // The base64 bound is exact equality; a one-off there would refuse every real full-size grid in production with nothing red.
    const max = grid(MAX_GRID_AXIS, MAX_GRID_AXIS, MAX_LAYERS, fill(MAX_GRID_AXIS * MAX_GRID_AXIS * MAX_LAYERS));
    expect(validateGround(max)).toEqual(max);
  });
});

describe('validateLayout', () => {
  it.each([
    ['no bounds', { layoutSchema: 1, shapes: [] }],
    ['bounds that are not an object', { layoutSchema: 1, bounds: 'wide' }],
    ['bounds with min above max', { layoutSchema: 1, bounds: { min: BOUNDS.max, max: BOUNDS.min } }],
    ['bounds with a NaN', { layoutSchema: 1, bounds: { min: { x: NaN, y: 0, z: 0 }, max: BOUNDS.max } }],
    ['a schema this reader does not know', { ...GOOD_LAYOUT, layoutSchema: 2 }],
    ['a schema sent as a string', { ...GOOD_LAYOUT, layoutSchema: '1' }],
    ['no schema at all', { bounds: BOUNDS }],
    ['garbage', 'layout'],
    ['an array', []],
    ['null', null],
  ])('is null for %s', (_, input) => {
    expect(validateLayout(input)).toBeNull();
  });

  it('accepts a full layout under either schema key; keeps bounds when the ground is missing or unusable', () => {
    const a = validateLayout(GOOD_LAYOUT)!;
    expect(validateLayout({ ...GOOD_LAYOUT, layoutSchema: undefined, schema: 1 })).toEqual(a);
    expect(a).toMatchObject({ schema: 1, bounds: BOUNDS, shapes: GOOD_LAYOUT.shapes, ground: GOOD_GROUND });
    expect(validateLayout({ ...GOOD_LAYOUT, ground: undefined })!.ground).toBeNull();
    expect(validateLayout({ ...GOOD_LAYOUT, ground: { ...GOOD_GROUND, nx: 99 } })!.ground).toBeNull();
    expect(validateLayout({ ...GOOD_LAYOUT, shapes: 'no' })!.shapes).toEqual([]);
    const wide = validateLayout({ ...GOOD_LAYOUT, bounds: { min: { x: -50.0004, y: 0, z: -50 }, max: BOUNDS.max } })!;
    expect(wide.bounds.min.x).toBe(-50);   // the overlay schema's millimetre rule
  });

  it('drops unknown kinds and bad coordinates, keeps numeric and string colours as sent, caps at MAX_SHAPES', () => {
    const l = validateLayout({
      ...GOOD_LAYOUT,
      shapes: [
        { kind: 'rect', x: 0, z: 0, w: 4, d: 4, fill: 0x224466, stroke: '#fff', width: 2, rotation: 0.5 },
        { kind: 'circle', x: 1, z: 1, r: 3, fill: 'rgba(0,0,0,.5)', stroke: 0xffffff },
        { kind: 'path', points: [[0, 0], [1, 1], [NaN, 2]], closed: true },
        { kind: 'triangle', x: 0, z: 0 },
        { kind: 'rect', x: 1e9, z: 0, w: 1, d: 1 },
        { kind: 'path', points: [[0, 0]] },
        { kind: 'path', points: 'not an array' },
        { kind: 'circle', x: 0, z: 0, r: 1, fill: 'x'.repeat(33), width: -1 },   // a 33-char colour and a negative width go; the circle stays
        { kind: 'circle', x: 2, z: 2, r: 1, fill: 0x1000000, stroke: 1.5 },      // a numeric colour is an 0xrrggbb integer or nothing
        { kind: 'circle', x: 3, z: 3, r: 1, fill: -1, width: -0.0004 },          // a negative colour goes; a width that rounds to -0 is stored as the 0 it means
        'not a shape',
        null,
      ],
    })!;
    expect(l.shapes).toEqual([
      { kind: 'rect', x: 0, z: 0, w: 4, d: 4, rotation: 0.5, fill: 0x224466, stroke: '#fff', width: 2 },
      { kind: 'circle', x: 1, z: 1, r: 3, fill: 'rgba(0,0,0,.5)', stroke: 0xffffff },
      { kind: 'path', points: [[0, 0], [1, 1]], closed: true },
      { kind: 'circle', x: 0, z: 0, r: 1 },
      { kind: 'circle', x: 2, z: 2, r: 1 },
      { kind: 'circle', x: 3, z: 3, r: 1, width: 0 },   // `toEqual` tells -0 from 0, and -0 is what `round(-0.0004, 3)` returns
    ]);
    const many = Array.from({ length: MAX_SHAPES + 7 }, (_, i) => ({ kind: 'circle', x: i, z: 0, r: 1 }));
    expect(validateLayout({ ...GOOD_LAYOUT, shapes: many })!.shapes).toHaveLength(MAX_SHAPES);
    const long = validateLayout({ ...GOOD_LAYOUT, shapes: [{ kind: 'path', points: Array.from({ length: 4001 }, (_, i) => [i, 0]) }] })!.shapes[0];
    expect(long.kind === 'path' ? long.points.length : -1).toBe(4000);   // a path is cut at 4000 vertices, not refused
  });

  it('wraps a rotation into (-π, π] and drops a stroke width outside [0, 64], so neither reaches JSONB as Infinity', () => {
    // 1e303 rounded to six places is Infinity; JSON.stringify writes that as null, and the editor would read a null rotation.
    const l = validateLayout({ ...GOOD_LAYOUT, shapes: [
      { kind: 'rect', x: 0, z: 0, w: 1, d: 1, rotation: 4, width: 64 },
      { kind: 'rect', x: 0, z: 0, w: 1, d: 1, rotation: 1e303, width: 1e306 },
      { kind: 'path', points: [[0, 0], [1, 1]], width: 64.001 },
    ] })!;
    expect(l.shapes[0]).toEqual({ kind: 'rect', x: 0, z: 0, w: 1, d: 1, rotation: -2.283185, width: 64 });   // 4 - 2π, the overlay schema's readAngle
    const huge = l.shapes[1];
    expect(huge.kind === 'rect' && Number.isFinite(huge.rotation) && Math.abs(huge.rotation!) <= Math.PI).toBe(true);
    expect(huge).not.toHaveProperty('width');
    expect(l.shapes[2]).toEqual({ kind: 'path', points: [[0, 0], [1, 1]] });
    expect(JSON.parse(JSON.stringify(l.shapes))).toEqual(l.shapes);   // what Postgres stores is what was validated
  });
});

describe('auditShapes', () => {
  const rect = { kind: 'rect', x: 0, z: 0, w: 1, d: 1 };
  const good = (n: number) => Array(n).fill(rect);

  /**
   * The two counts are independent: `truncated` is what the cap stopped it READING, `unreadable` is what it read
   * and could not use. The boundary is MAX_SHAPES readable out of MAX_SHAPES + 1 sent — one unreadable, nothing
   * truncated — which a check on lengths alone reports as the reverse, and then never names the shape it could not read.
   */
  it('counts what the cap left unread apart from what it read and could not use', () => {
    expect(auditShapes(good(MAX_SHAPES + 1))).toMatchObject({ unreadable: 0, truncated: 1 });
    expect(auditShapes([{ kind: 'hexagon' }, ...good(MAX_SHAPES)])).toMatchObject({ unreadable: 1, truncated: 0 });
    expect(auditShapes([{ kind: 'hexagon' }, ...good(MAX_SHAPES + 1)])).toMatchObject({ unreadable: 1, truncated: 1 });
    expect(auditShapes(good(MAX_SHAPES + 1)).shapes).toHaveLength(MAX_SHAPES);
    expect(auditShapes(good(3))).toEqual({ shapes: good(3), unreadable: 0, truncated: 0 });
    expect(auditShapes('no')).toEqual({ shapes: [], unreadable: 0, truncated: 0 });
  });

  it('is what validateShapes returns, so validateLayout is unchanged by the audit', () => {
    const mixed = [rect, { kind: 'hexagon' }, ...good(MAX_SHAPES)];
    expect(validateShapes(mixed)).toEqual(auditShapes(mixed).shapes);
    expect(validateShapes('no')).toEqual([]);
  });
});

describe('auditShapes', () => {
  const rect = { kind: 'rect', x: 0, z: 0, w: 1, d: 1 };
  const good = (n: number) => Array(n).fill(rect);

  /**
   * The two counts are independent: `truncated` is what the cap stopped it READING, `unreadable` is what it read
   * and could not use. The boundary is MAX_SHAPES readable out of MAX_SHAPES + 1 sent — one unreadable, nothing
   * truncated — which a check on lengths alone reports as the reverse, and then never names the shape it could not read.
   */
  it('counts what the cap left unread apart from what it read and could not use', () => {
    expect(auditShapes(good(MAX_SHAPES + 1))).toMatchObject({ unreadable: 0, truncated: 1 });
    expect(auditShapes([{ kind: 'hexagon' }, ...good(MAX_SHAPES)])).toMatchObject({ unreadable: 1, truncated: 0 });
    expect(auditShapes([{ kind: 'hexagon' }, ...good(MAX_SHAPES + 1)])).toMatchObject({ unreadable: 1, truncated: 1 });
    expect(auditShapes(good(MAX_SHAPES + 1)).shapes).toHaveLength(MAX_SHAPES);
    expect(auditShapes(good(3))).toEqual({ shapes: good(3), unreadable: 0, truncated: 0 });
    expect(auditShapes('no')).toEqual({ shapes: [], unreadable: 0, truncated: 0 });
  });

  it('is what validateShapes returns, so validateLayout is unchanged by the audit', () => {
    const mixed = [rect, { kind: 'hexagon' }, ...good(MAX_SHAPES)];
    expect(validateShapes(mixed)).toEqual(auditShapes(mixed).shapes);
    expect(validateShapes('no')).toEqual([]);
  });
});
