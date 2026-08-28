/**
 * THE CLAIM: the editor's map is a faithful, invertible picture of world XZ.
 *
 * Not a stub because every case is a NUMBER the canvas will actually use:
 * a 200×100 m world fitted into 400×400 px lands at exactly 1.76 px/m with
 * 24 px padding, zooming about a cursor leaves the metre under it where it
 * was to within 1e-9, and a hit 9 px from a dot with 8 px tolerance is a miss.
 * If `createView` silently flipped an axis, the north test fails; if
 * `zoomAt` zoomed about the origin instead of the cursor, the fixed-point
 * test fails by tens of pixels.
 */
import { describe, expect, it } from 'vitest';
import {
  MAX_SCALE,
  MIN_SCALE,
  createView,
  cssColour,
  hitTest,
  pan,
  rectCorners,
  resizeView,
  toScreen,
  toWorld,
  zoomAt,
  type MapView,
} from './mapProjection';

const bounds = { min: { x: -100, y: 0, z: -50 }, max: { x: 100, y: 10, z: 50 } };

describe('createView', () => {
  it('fits the bounds into the canvas with padding, preserving aspect', () => {
    const v = createView(bounds, 400, 400, 24);
    // inner box is 352×352; world is 200×100 → limited by x: 352/200 = 1.76
    expect(v.scale).toBeCloseTo(1.76, 10);
    // the world's centre (0,0) sits at the canvas centre
    expect(toScreen(v, 0, 0)).toEqual({ sx: 200, sy: 200 });
    // the west edge lands exactly on the padding line
    expect(toScreen(v, -100, 0).sx).toBeCloseTo(24, 10);
    expect(v.w).toBe(400);
    expect(v.h).toBe(400);
  });

  it('puts north (−Z) at the top: a point further north has a smaller screen y', () => {
    const v = createView(bounds, 400, 400);
    expect(toScreen(v, 0, -40).sy).toBeLessThan(toScreen(v, 0, 40).sy);
    // and east (+X) is to the right
    expect(toScreen(v, 40, 0).sx).toBeGreaterThan(toScreen(v, -40, 0).sx);
  });

  it('falls back to a ±100 m square when a world has no bounds yet', () => {
    const v = createView(null, 300, 300, 0);
    expect(v.scale).toBeCloseTo(1.5, 10);
    expect(toScreen(v, -100, -100)).toEqual({ sx: 0, sy: 0 });
  });

  it('never produces a degenerate scale', () => {
    const flat = { min: { x: 5, y: 0, z: 5 }, max: { x: 5, y: 0, z: 5 } };
    const v = createView(flat, 100, 100);
    expect(v.scale).toBeLessThanOrEqual(MAX_SCALE);
    expect(v.scale).toBeGreaterThanOrEqual(MIN_SCALE);
    expect(Number.isFinite(v.ox)).toBe(true);
  });

  it('stays finite on a canvas smaller than its own padding', () => {
    // 30 px minus 2×24 px padding is negative; the inner box floors at 1 px
    const v = createView(bounds, 30, 30);
    expect(Number.isFinite(v.scale)).toBe(true);
    expect(v.scale).toBeGreaterThanOrEqual(MIN_SCALE);
    expect(Number.isFinite(v.ox)).toBe(true);
    expect(Number.isFinite(v.oy)).toBe(true);
  });
});

describe('toScreen / toWorld', () => {
  it('round-trips', () => {
    const v = createView(bounds, 640, 480);
    for (const [x, z] of [[0, 0], [-99.5, 49.25], [12.3, -40.1]]) {
      const s = toScreen(v, x, z);
      const w = toWorld(v, s.sx, s.sy);
      expect(w.x).toBeCloseTo(x, 9);
      expect(w.z).toBeCloseTo(z, 9);
    }
  });
});

describe('zoomAt', () => {
  it('keeps the world point under the cursor fixed', () => {
    const v = createView(bounds, 640, 480);
    const cursor = { sx: 500, sy: 100 };
    const before = toWorld(v, cursor.sx, cursor.sy);
    const z1 = zoomAt(v, cursor.sx, cursor.sy, 2);
    const after = toWorld(z1, cursor.sx, cursor.sy);
    expect(after.x).toBeCloseTo(before.x, 9);
    expect(after.z).toBeCloseTo(before.z, 9);
    expect(z1.scale).toBeCloseTo(v.scale * 2, 10);
    // and a point elsewhere moved away from the cursor
    const far = toScreen(z1, before.x + 10, before.z);
    expect(far.sx - cursor.sx).toBeCloseTo(10 * z1.scale, 9);
  });

  it('clamps the scale', () => {
    const v = createView(bounds, 640, 480);
    expect(zoomAt(v, 0, 0, 1e9).scale).toBe(MAX_SCALE);
    expect(zoomAt(v, 0, 0, 1e-9).scale).toBe(MIN_SCALE);
  });

  it('keeps the cursor point fixed even when the clamp bites', () => {
    // The ratio applied to the origin must be clamped/scale, not the requested
    // factor: a factor-based origin would fling the metre under the cursor
    // ~1e9 px away the moment the clamp engaged.
    const v = createView(bounds, 640, 480);
    const cursor = { sx: 500, sy: 100 };
    const before = toWorld(v, cursor.sx, cursor.sy);
    const z = zoomAt(v, cursor.sx, cursor.sy, 1e9);
    expect(z.scale).toBe(MAX_SCALE);
    const after = toWorld(z, cursor.sx, cursor.sy);
    expect(after.x).toBeCloseTo(before.x, 9);
    expect(after.z).toBeCloseTo(before.z, 9);
  });
});

describe('pan and resize', () => {
  it('pan shifts every point by the same screen delta', () => {
    const v = createView(bounds, 640, 480);
    const p = pan(v, 30, -12);
    const a = toScreen(v, 7, 9);
    const b = toScreen(p, 7, 9);
    expect(b.sx - a.sx).toBe(30);
    expect(b.sy - a.sy).toBe(-12);
  });

  it('resize keeps the world point at the canvas centre at the new centre', () => {
    const v = pan(createView(bounds, 640, 480), 55, 20);
    const centreBefore = toWorld(v, 320, 240);
    const r = resizeView(v, 800, 300);
    const centreAfter = toWorld(r, 400, 150);
    expect(centreAfter.x).toBeCloseTo(centreBefore.x, 9);
    expect(centreAfter.z).toBeCloseTo(centreBefore.z, 9);
    expect(r.scale).toBe(v.scale);
  });
});

describe('hitTest', () => {
  const v = createView(bounds, 400, 400, 24); // 1.76 px/m
  const cands = [
    { key: 'a', x: 0, z: 0 },
    { key: 'b', x: 10, z: 0 },          // 17.6 px east of a
    { key: 'big', x: 0, z: 30, r: 5 },  // 5 m radius → 8.8 px reach on top of tolerance
  ];
  it('returns the nearest candidate within tolerance', () => {
    const s = toScreen(v, 3, 0); // 5.28 px from a, 12.32 px from b
    expect(hitTest(v, cands, s.sx, s.sy, 8)?.key).toBe('a');
  });
  it('is the NEAREST, not the first listed, when two are in reach', () => {
    const s = toScreen(v, 7, 0); // 12.32 px from a (listed first), 5.28 px from b
    expect(hitTest(v, cands, s.sx, s.sy, 20)?.key).toBe('b');
  });
  it('an exact tie goes to the first listed', () => {
    // Integer view so both distances are exactly 10 px, not 10 ± an ulp.
    const tv: MapView = { scale: 2, ox: 100, oy: 100, w: 200, h: 200 };
    const pair = [{ key: 'first', x: 0, z: 0 }, { key: 'second', x: 10, z: 0 }];
    expect(hitTest(tv, pair, 110, 100, 12)?.key).toBe('first');
    expect(hitTest(tv, [pair[1], pair[0]], 110, 100, 12)?.key).toBe('second');
  });
  it('misses when nothing is within tolerance', () => {
    const s = toScreen(v, 5, 0); // 8.8 px from both a and b
    expect(hitTest(v, cands, s.sx, s.sy, 8)).toBeNull();
  });
  it('adds a candidate radius, in metres, to the tolerance', () => {
    const s = toScreen(v, 6, 30); // 10.56 px from big's centre; reach = 8 + 8.8
    expect(hitTest(v, cands, s.sx, s.sy, 8)?.key).toBe('big');
  });
  it('returns null for an empty list', () => {
    expect(hitTest(v, [], 0, 0, 8)).toBeNull();
  });
});

describe('rectCorners', () => {
  it('matches Minimap.js: px = x + lx·cos − lz·sin, pz = z + lx·sin + lz·cos', () => {
    const c = rectCorners({ x: 10, z: 20, w: 4, d: 2, rotation: Math.PI / 2 });
    // local (−2,−1) rotated 90°: (1, −2) → (11, 18)
    expect(c[0][0]).toBeCloseTo(11, 9);
    expect(c[0][1]).toBeCloseTo(18, 9);
    expect(c).toHaveLength(4);
  });
  it('is the plain axis-aligned box with no rotation', () => {
    expect(rectCorners({ x: 0, z: 0, w: 4, d: 2 })).toEqual([[-2, -1], [2, -1], [2, 1], [-2, 1]]);
  });
});

describe('cssColour', () => {
  it('turns a numeric colour into a six-digit hex string', () => {
    expect(cssColour(0x0000ff, 'x')).toBe('#0000ff');
    expect(cssColour(0x52e9ff, 'x')).toBe('#52e9ff');
  });
  it('passes strings through and falls back otherwise', () => {
    expect(cssColour('rgba(1,2,3,0.5)', 'x')).toBe('rgba(1,2,3,0.5)');
    expect(cssColour(undefined, 'x')).toBe('x');
    expect(cssColour('', 'x')).toBe('x');
  });
});
