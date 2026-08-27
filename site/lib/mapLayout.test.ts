import { describe, it, expect } from 'vitest';
import { WORLD_COORD_LIMIT } from './mapOverlaySchema';
import {
  LAYOUT_SCHEMA, MAX_GRID_AXIS, MAX_LAYERS, MAX_SHAPES, NO_SAMPLE,
  decodeGround, encodeHeights, groundAt, layersAt,
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
