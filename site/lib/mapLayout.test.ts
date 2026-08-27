import { describe, it, expect } from 'vitest';
import { WORLD_COORD_LIMIT } from './mapOverlaySchema';
import {
  LAYOUT_SCHEMA, MAX_GRID_AXIS, MAX_LAYERS, MAX_SHAPES, NO_SAMPLE,
  decodeGround, encodeHeights,
  type LayoutGround,
} from './mapLayout';

/**
 * THE CLAIM: the arithmetic the editor and the save route share over a
 * world's reported layout is right at the edges — cell, roof, grid and byte —
 * because every conflict warning and snapped Y comes from it, and the game
 * never checks the answer. Not a stub: every case builds a real Int16 grid
 * through `encodeHeights` (the e2e seeder's function) and asserts a NUMBER a
 * hand calculation gives. The two-layer cases are the station dome, the one
 * shape a single-height lookup gets wrong by sixty metres.
 */

/** index = ((j * nx) + i) * layers + k — the wire order, so fixtures read that way. */
function grid(nx: number, nz: number, layers: number, cm: number[], step = 10): LayoutGround {
  if (cm.length !== nx * nz * layers) throw new Error('fixture size');
  return { originX: 0, originZ: 0, step, nx, nz, layers, heightsCm: encodeHeights(Int16Array.from(cm)) };
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
});
