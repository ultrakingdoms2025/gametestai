/**
 * THE SPATIAL-INDEX GATE.
 *
 * Four queries decide where every prop, tree, bush, rock, sett and blade of
 * grass in the vale is allowed to stand: `_roadDist`, `_inFootprint`,
 * `_isPaved` and `_isOpenGround`. Each of them used to walk its whole feature
 * list, once per scatter candidate - O(candidates x features), with both
 * halves growing with world area, so a 5x wider vale did roughly 25x the work.
 * They are now backed by a uniform grid.
 *
 * A broadphase that returns a slightly different answer is worse than a slow
 * one. `_roadDist` returns a DISTANCE, compared against five different
 * thresholds around the file, so "close enough" is not available: a road query
 * that missed a segment by a centimetre would put a hay bale in a cart track
 * and nothing would report it. So every test here builds both implementations
 * and compares them, on the real road network and on adversarial random data.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { rectDist } from '../../src/worlds/terrain/MedievalHeight.js';
import { PLOTS } from '../../src/worlds/medieval/Settlements.js';
import { GridIndex, segmentDistance } from '../../src/worlds/medieval/GridIndex.js';
import { MedievalWorld } from '../../src/worlds/MedievalWorld.js';

/* ------------------------------------------------------------------ */
/* The linear implementations, as they were before the index           */
/* ------------------------------------------------------------------ */

function roadDistLinear(segs, x, z) {
  let best = 1e9;
  for (let i = 0; i < segs.length; i += 5) {
    const d = segmentDistance(x, z, segs[i], segs[i + 1], segs[i + 2], segs[i + 3], segs[i + 4] * 0.5);
    if (d < best) best = d;
  }
  return best;
}

function inRectsLinear(rects, x, z, margin) {
  for (const f of rects) {
    const dx = x - f.x;
    const dz = z - f.z;
    const c = Math.cos(-f.r);
    const s = Math.sin(-f.r);
    if (rectDist(dx * c - dz * s, dx * s + dz * c, f.hx + margin, f.hz + margin) < 0) return true;
  }
  return false;
}

/** `_isPaved` inverts the rotation the other way round - preserved verbatim. */
function inPavedLinear(rects, x, z, margin) {
  for (const p of rects) {
    const dx = x - p.x;
    const dz = z - p.z;
    const c = Math.cos(p.r);
    const s = Math.sin(p.r);
    if (rectDist(dx * c - dz * s, dx * s + dz * c, p.hx + margin, p.hz + margin) < 0) return true;
  }
  return false;
}

function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * A world with its real road network laid, plus a footprint set built the way
 * `_buildVillage` builds one.
 *
 * The village, the castle and the riverside are not reachable under Node - they
 * need a renderer - so the footprints are synthesised from the same authored
 * plots the real build uses, plus the seven hand-placed ones. Random sets are
 * tested separately; this one exists so the comparison runs over the actual
 * geometry the vale ships with.
 */
function realWorld() {
  const w = new MedievalWorld({});
  w._buildRoadPaths();
  for (const [x, z, ry, wd, d] of PLOTS) {
    w._footprints.push({ x, z, hx: wd / 2 + 1.4, hz: d / 2 + 1.4, r: ry });
  }
  // The hand-placed ones, verbatim from _buildCastle / _buildRiverside /
  // _buildMarket / _buildLandmarks / _buildParishChurch.
  w._footprints.push({ x: -72, z: -58, hx: 58, hz: 51, r: 0 });      // castle
  w._footprints.push({ x: 26, z: 106.8, hx: 6, hz: 16, r: 0 });      // bridge
  w._footprints.push({ x: 66, z: -8, hx: 20, hz: 9, r: 0 });         // St Aldern
  w._footprints.push({ x: -13, z: 95.35, hx: 9, hz: 10, r: 0 });     // water mill
  w._footprints.push({ x: -88, z: -150, hx: 8, hz: 8, r: 0 });       // windmill
  w._footprints.push({ x: 160, z: -20, hx: 9, hz: 9, r: 0 });        // watchtower
  w._footprints.push({ x: -146, z: -30, hx: 6.6, hz: 10.4, r: 0 });  // west parish
  w._footprints.push({ x: -60, z: -136, hx: 6.4, hz: 10, r: 0 });    // south parish
  return w;
}

/* ------------------------------------------------------------------ */
/* GridIndex itself                                                    */
/* ------------------------------------------------------------------ */

test('an empty index answers Infinity and nothing, rather than throwing', () => {
  const g = new GridIndex(8);
  assert.equal(g.size, 0);
  assert.equal(g.nearest(0, 0, () => 0), Infinity);
  assert.deepEqual(g.query(-10, -10, 10, 10), []);
});

test('GridIndex.nearest is EXACT against brute force, on 20k random probes', () => {
  /* The ring search stops as soon as the best distance found is inside the
   * lower bound for the rings it has not scanned yet. If that bound were even
   * slightly wrong it would sometimes stop one ring early, and the error would
   * be invisible - a distance that is merely a bit too large. So: random
   * items, random cell sizes, random probes, and an exact comparison. */
  const rnd = mulberry32(0xbeef01);
  for (const cell of [1, 4, 8, 37]) {
    const items = [];
    const g = new GridIndex(cell);
    for (let i = 0; i < 400; i++) {
      const x = (rnd() - 0.5) * 900;
      const z = (rnd() - 0.5) * 900;
      const r = rnd() * 12;
      items.push({ x, z, r });
      g.insert(i, x - r, z - r, x + r, z + r);
    }
    // Signed: negative inside, which is what a road half-width produces.
    const dist = (i, x, z) => Math.hypot(x - items[i].x, z - items[i].z) - items[i].r;
    for (let t = 0; t < 5000; t++) {
      const x = (rnd() - 0.5) * 1100;
      const z = (rnd() - 0.5) * 1100;
      let best = Infinity;
      for (let i = 0; i < items.length; i++) best = Math.min(best, dist(i, x, z));
      assert.equal(g.nearest(x, z, dist), best,
        `cell ${cell}: nearest wrong at (${x.toFixed(2)}, ${z.toFixed(2)})`);
    }
  }
});

test('GridIndex.query returns every item whose box overlaps, on 20k random probes', () => {
  const rnd = mulberry32(0xbeef02);
  for (const cell of [2, 8, 25]) {
    const boxes = [];
    const g = new GridIndex(cell);
    for (let i = 0; i < 300; i++) {
      const x = (rnd() - 0.5) * 900;
      const z = (rnd() - 0.5) * 900;
      const hx = 0.5 + rnd() * 30;
      const hz = 0.5 + rnd() * 30;
      boxes.push({ minX: x - hx, minZ: z - hz, maxX: x + hx, maxZ: z + hz });
      g.insert(i, x - hx, z - hz, x + hx, z + hz);
    }
    for (let t = 0; t < 7000; t++) {
      const x = (rnd() - 0.5) * 1000;
      const z = (rnd() - 0.5) * 1000;
      const m = rnd() * 6;
      const got = new Set(g.query(x - m, z - m, x + m, z + m));
      for (let i = 0; i < boxes.length; i++) {
        const b = boxes[i];
        const overlaps = x + m >= b.minX && x - m <= b.maxX && z + m >= b.minZ && z - m <= b.maxZ;
        if (overlaps) {
          assert.ok(got.has(i),
            `cell ${cell}: query MISSED box ${i} at (${x.toFixed(2)}, ${z.toFixed(2)}) margin ${m.toFixed(2)}`);
        }
      }
    }
  }
});

/* ------------------------------------------------------------------ */
/* _roadDist                                                           */
/* ------------------------------------------------------------------ */

test('_roadDist is identical to the linear scan over the real road network', () => {
  const w = realWorld();
  const segs = w._roadSegs;
  assert.ok(segs.length / 5 > 200, `only ${segs.length / 5} road segments were laid`);

  const rnd = mulberry32(0x5eed01);
  let onRoad = 0;
  for (let t = 0; t < 60000; t++) {
    // Half uniform over the whole 900m vale, half concentrated on the road
    // network - a uniform sample alone almost never lands near a road at 900m
    // and would prove nothing about the interesting case.
    let x;
    let z;
    if (t & 1) {
      const i = ((rnd() * (segs.length / 5)) | 0) * 5;
      x = segs[i] + (rnd() - 0.5) * 24;
      z = segs[i + 1] + (rnd() - 0.5) * 24;
    } else {
      x = (rnd() - 0.5) * 900;
      z = (rnd() - 0.5) * 900;
    }
    const a = roadDistLinear(segs, x, z);
    const b = w._roadDist(x, z);
    assert.equal(b, a, `_roadDist disagrees at (${x.toFixed(3)}, ${z.toFixed(3)}): ${b} vs ${a}`);
    if (a < 2.2) onRoad++;
  }
  // The thresholds in the file run from 1.0 to 4.4m. A test that never got
  // near one would pass on an index that returned 1e9 for everything.
  assert.ok(onRoad > 2000, `only ${onRoad} probes landed on a road`);
});

test('_roadDist still returns 1e9 when no roads have been laid', () => {
  const w = new MedievalWorld({});
  assert.equal(w._roadDist(0, 0), 1e9);
});

test('_roadDist picks up lanes added after the first query', () => {
  /* The index is invalidated by the segment array's identity and length.
   * `_buildRoadPaths` replaces the array wholesale, so a stale index would
   * answer for the previous world's roads - and the first thing that happens
   * after roads are laid is that the macro painter reads them. */
  const w = new MedievalWorld({});
  w._roadSegs = [0, 0, 10, 0, 4];
  const near = w._roadDist(5, 6);
  w._roadSegs.push(0, 20, 10, 20, 4);
  assert.equal(w._roadDist(5, 18), roadDistLinear(w._roadSegs, 5, 18));
  assert.ok(w._roadDist(5, 18) < near, 'the appended lane was not seen');
});

/* ------------------------------------------------------------------ */
/* _inFootprint / _isPaved / _isOpenGround                             */
/* ------------------------------------------------------------------ */

test('_inFootprint is identical to the linear scan, real footprints', () => {
  const w = realWorld();
  const fps = w._footprints;
  const rnd = mulberry32(0x5eed02);
  let inside = 0;
  for (let t = 0; t < 80000; t++) {
    const f = fps[(rnd() * fps.length) | 0];
    const x = f.x + (rnd() - 0.5) * 60;
    const z = f.z + (rnd() - 0.5) * 60;
    // Every margin the file actually passes, plus the negative one.
    const margin = [0, 0.45, 0.5, 0.6, 0.8, 2.2, -0.6][(rnd() * 7) | 0];
    const a = inRectsLinear(fps, x, z, margin);
    const b = w._inFootprint(x, z, margin);
    assert.equal(b, a, `_inFootprint disagrees at (${x}, ${z}) margin ${margin}`);
    if (a) inside++;
  }
  assert.ok(inside > 5000, `only ${inside} probes landed inside a footprint`);
});

test('_inFootprint is identical to the linear scan, adversarial random footprints', () => {
  /* Rotated rectangles are where a naive AABB index goes wrong: the world box
   * of a rotated rect is bigger than the rect, so an index built from the
   * un-rotated half-extents would miss corners. Long thin rects at 45 degrees
   * are the worst case, so that is what this generates. */
  const rnd = mulberry32(0x5eed03);
  const w = new MedievalWorld({});
  for (let i = 0; i < 120; i++) {
    w._footprints.push({
      x: (rnd() - 0.5) * 400,
      z: (rnd() - 0.5) * 400,
      hx: 0.4 + rnd() * 40,
      hz: 0.4 + rnd() * 3,
      r: rnd() * Math.PI * 2,
    });
  }
  const fps = w._footprints;
  for (let t = 0; t < 120000; t++) {
    const f = fps[(rnd() * fps.length) | 0];
    const x = f.x + (rnd() - 0.5) * (f.hx * 2.6 + 8);
    const z = f.z + (rnd() - 0.5) * (f.hx * 2.6 + 8);
    const margin = (rnd() - 0.25) * 3;
    assert.equal(w._inFootprint(x, z, margin), inRectsLinear(fps, x, z, margin),
      `_inFootprint disagrees at (${x}, ${z}) margin ${margin}`);
  }
});

test('_inFootprint sees footprints appended mid-build', () => {
  /* `_footprints` is pushed to all through the build - the castle, then every
   * house, then the churches, the bridge, the mill and the landmarks - and the
   * dressing passes query it in between. The index tops up incrementally; a
   * version that only built once would place barrels inside the last district
   * to be raised. */
  const w = new MedievalWorld({});
  assert.equal(w._inFootprint(10, 10), false);
  w._footprints.push({ x: 10, z: 10, hx: 3, hz: 3, r: 0 });
  assert.equal(w._inFootprint(10, 10), true, 'a footprint added after the first query is invisible');
  assert.equal(w._inFootprint(40, 40), false);
  w._footprints.push({ x: 40, z: 40, hx: 3, hz: 3, r: 0 });
  assert.equal(w._inFootprint(40, 40), true);
  assert.equal(w._inFootprint(10, 10), true, 'the earlier footprint was lost on the top-up');
});

test('_isPaved is identical to the linear scan over the real yards', () => {
  const w = realWorld();
  const rects = w._pavedRects;
  assert.ok(rects.length > 30, `only ${rects.length} paved yards`);
  const rnd = mulberry32(0x5eed04);
  let inside = 0;
  for (let t = 0; t < 80000; t++) {
    const p = rects[(rnd() * rects.length) | 0];
    const x = p.x + (rnd() - 0.5) * 40;
    const z = p.z + (rnd() - 0.5) * 40;
    const margin = [0, 0.3, 0.35][(rnd() * 3) | 0];
    const a = inPavedLinear(rects, x, z, margin);
    const b = w._isPaved(x, z, margin);
    assert.equal(b, a, `_isPaved disagrees at (${x}, ${z}) margin ${margin}`);
    if (a) inside++;
  }
  assert.ok(inside > 5000, `only ${inside} probes landed on paving`);
});

test('_isOpenGround is identical to a fully linear reference', () => {
  /* `_isOpenGround` is the composite - playfield, water, castle, river,
   * market, roads and footprints - and it is the one every scatter pass
   * actually calls. Its footprint half used to be an inlined copy of
   * `_inFootprint`; this proves collapsing the two changed nothing. */
  const w = realWorld();
  const segs = w._roadSegs;
  const fps = w._footprints;
  const linear = (x, z, margin) => {
    if (!w._inPlayfield(x, z, 2 + Math.max(0, margin))) return false;
    if (w._height(x, z) < 0.85 + 0.5) return false;
    if (rectDist(x + 72, z + 58, 40, 33) < 22) return false;
    if (Math.abs(z - (104 + 20 * Math.sin(x * 0.011) + 7 * Math.sin(x * 0.027 + 1.3))) < 11.5) return false;
    if (rectDist(x - 34, z - 18, 17, 15) < 2) return false;
    if (roadDistLinear(segs, x, z) < 2.2 + margin) return false;
    return !inRectsLinear(fps, x, z, margin);
  };
  const rnd = mulberry32(0x5eed05);
  let open = 0;
  for (let t = 0; t < 80000; t++) {
    const x = (rnd() - 0.5) * 900;
    const z = (rnd() - 0.5) * 900;
    const margin = [-0.6, 0, 0.8, 1, 2.2][(rnd() * 5) | 0];
    const a = linear(x, z, margin);
    const b = w._isOpenGround(x, z, margin);
    assert.equal(b, a, `_isOpenGround disagrees at (${x}, ${z}) margin ${margin}`);
    if (a) open++;
  }
  assert.ok(open > 20000, `only ${open} probes were open ground`);
});

/* ------------------------------------------------------------------ */
/* The point of the exercise                                           */
/* ------------------------------------------------------------------ */

test('the index kills the quadratic: cost stays flat as features multiply', () => {
  /* THE POINT OF THE EXERCISE, stated as the property that actually matters.
   *
   * A raw "is it faster today" check would be a weak claim and a flaky one.
   * Today the vale has 248 road segments in ONE cluster, and against a probe
   * distribution that is uniform over 900x900m almost every query is far from
   * every road - the case a grid helps least. The index is ahead there, but
   * only by about half again.
   *
   * The property Phase A actually needs is the SHAPE of the curve. The linear
   * scan is O(candidates x features) and later phases add settlements, which
   * add roads; the index has to stay flat while the scan grows. Measured over
   * 300k probes: 248 segments 1.5x, 496 segments 1.9x, 1,240 segments 3.7x,
   * 2,480 segments 10x - the indexed time barely moves while the linear time
   * multiplies by eleven.
   */
  const w = realWorld();
  const base = w._roadSegs.slice();
  const rnd = mulberry32(0x5eed06);

  /** The authored network replicated into `copies` clusters across the vale. */
  const spread = (copies) => {
    const out = [];
    const r = mulberry32(99);
    for (let k = 0; k < copies; k++) {
      const ox = k === 0 ? 0 : (r() - 0.5) * 760;
      const oz = k === 0 ? 0 : (r() - 0.5) * 760;
      for (let i = 0; i < base.length; i += 5) {
        out.push(base[i] + ox, base[i + 1] + oz, base[i + 2] + ox, base[i + 3] + oz, base[i + 4]);
      }
    }
    return out;
  };

  const N = 60000;
  const xs = new Float64Array(N);
  const zs = new Float64Array(N);
  for (let i = 0; i < N; i++) {
    xs[i] = (rnd() - 0.5) * 900;
    zs[i] = (rnd() - 0.5) * 900;
  }
  const time = (fn) => {
    let sink = 0;
    for (let i = 0; i < 4000; i++) sink += fn(xs[i], zs[i]);      // warm
    const t0 = performance.now();
    for (let i = 0; i < N; i++) sink += fn(xs[i], zs[i]);
    const ms = performance.now() - t0;
    assert.ok(Number.isFinite(sink));
    return ms;
  };

  const results = [];
  for (const copies of [1, 5]) {
    const segs = spread(copies);
    w._roadSegs = segs;
    // Prove the two still agree at this size before timing either of them.
    for (let i = 0; i < 400; i++) {
      assert.equal(w._roadDist(xs[i], zs[i]), roadDistLinear(segs, xs[i], zs[i]));
    }
    results.push({
      n: segs.length / 5,
      linear: time((x, z) => roadDistLinear(segs, x, z)),
      indexed: time((x, z) => w._roadDist(x, z)),
    });
  }

  const [one, five] = results;
  const report = results.map((r) => `${r.n} segs: linear ${r.linear.toFixed(0)}ms, indexed ${r.indexed.toFixed(0)}ms`).join('; ');
  assert.ok(one.indexed < one.linear, `the index is not ahead even today - ${report}`);
  // The linear scan must have grown roughly with the feature count...
  assert.ok(five.linear > one.linear * 3, `the linear reference did not scale as expected - ${report}`);
  // ...and the index must NOT have. This is the quadratic being killed.
  assert.ok(five.indexed < one.indexed * 2.5, `the index scaled with feature count - ${report}`);
  assert.ok(five.linear / five.indexed > 3, `only ${(five.linear / five.indexed).toFixed(1)}x at 5x the roads - ${report}`);
});

test('the footprint index is flat in the number of buildings', () => {
  /* `_inFootprint` and `_isOpenGround` are the ones that bite hardest, because
   * a bigger vale means more buildings AND more scatter candidates. Measured:
   * 36 footprints 10x, 108 footprints 32x, 180 footprints 55x - the indexed
   * time does not move at all. */
  const rnd = mulberry32(0x5eed07);
  const N = 60000;
  const xs = new Float64Array(N);
  const zs = new Float64Array(N);
  for (let i = 0; i < N; i++) {
    xs[i] = (rnd() - 0.5) * 900;
    zs[i] = (rnd() - 0.5) * 900;
  }
  const time = (fn) => {
    let sink = 0;
    for (let i = 0; i < 4000; i++) sink += fn(xs[i], zs[i]) ? 1 : 0;
    const t0 = performance.now();
    for (let i = 0; i < N; i++) sink += fn(xs[i], zs[i]) ? 1 : 0;
    const ms = performance.now() - t0;
    assert.ok(Number.isFinite(sink));
    return ms;
  };

  const results = [];
  for (const copies of [1, 5]) {
    const w = new MedievalWorld({});
    const r = mulberry32(5);
    for (let k = 0; k < copies; k++) {
      const ox = k === 0 ? 0 : (r() - 0.5) * 760;
      const oz = k === 0 ? 0 : (r() - 0.5) * 760;
      for (const [x, z, ry, wd, d] of PLOTS) {
        w._footprints.push({ x: x + ox, z: z + oz, hx: wd / 2 + 1.4, hz: d / 2 + 1.4, r: ry });
      }
    }
    const fps = w._footprints;
    for (let i = 0; i < 400; i++) {
      assert.equal(w._inFootprint(xs[i], zs[i], 0.5), inRectsLinear(fps, xs[i], zs[i], 0.5));
    }
    results.push({
      n: fps.length,
      linear: time((x, z) => inRectsLinear(fps, x, z, 0.5)),
      indexed: time((x, z) => w._inFootprint(x, z, 0.5)),
    });
  }
  const [one, five] = results;
  const report = results.map((r) => `${r.n} footprints: linear ${r.linear.toFixed(0)}ms, indexed ${r.indexed.toFixed(0)}ms`).join('; ');
  assert.ok(one.linear / one.indexed > 3, `only ${(one.linear / one.indexed).toFixed(1)}x today - ${report}`);
  assert.ok(five.indexed < one.indexed * 2, `the index scaled with building count - ${report}`);
});
