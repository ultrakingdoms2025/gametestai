// scripts/tests/ground-sampler.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { planGrid, createJob, encodeInt16Base64, NO_SAMPLE, MAX_LAYERS } from '../../src/systems/GroundSampler.js';

/**
 * THE GROUND GRID THE MAP EDITOR DRAWS AND VALIDATES AGAINST.
 *
 * THE CLAIM: from a world's bounds and a downward cast, the sampler produces a
 * grid whose step, extent and cell order are exactly what site/lib/mapLayout.ts
 * decodes (index ((j*nx)+i)*layers+k, layer 0 topmost, NO_SAMPLE padding, cm
 * clamped to ±32767, Int16 LE base64), in slices that stop when a time budget
 * is spent.
 *
 * Not a stub: the cast is a FUNCTION RETURNING KNOWN SURFACES, so every
 * assertion is arithmetic the site will index into; the decode is Node's
 * Buffer.readInt16LE, never the encoder's inverse, so a byte-order mistake
 * cannot cancel out. That the cast peels REAL colliders is map-overlay-layout.test.mjs's claim.
 */

/** Independent decoder: Node's Buffer, little-endian, none of the module's code. */
function decode(b64) {
  const buf = Buffer.from(b64, 'base64');
  const out = new Int16Array(buf.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = buf.readInt16LE(i * 2);
  return out;
}
const box = (x0, y0, z0, x1, y1, z1) => ({ min: { x: x0, y: y0, z: z0 }, max: { x: x1, y: y1, z: z1 } });

test('the station (±744 m) plans a 6 m step and a 249×249 grid; a small world floors at 4 m', () => {
  assert.deepEqual(planGrid(box(-744, -6, -744, 744, 158, 744)),
    { originX: -744, originZ: -744, step: 6, nx: 249, nz: 249 });
  assert.deepEqual(planGrid(box(-40, -5, -40, 40, 30, 40)),
    { originX: -40, originZ: -40, step: 4, nx: 21, nz: 21 });
  assert.equal(planGrid(box(-450, 0, -450, 450, 100, 450)).nx, 226); // 900/256 → 4 m
  // 1300/256 = 5.08: the step is the CEILING (6), never the rounding (5); and
  // 1300/6 = 216.67 samples is 217 cells plus the origin, so the last sample
  // sits at 652, past the edge, not at 646 with a 4 m strip unsampled.
  assert.deepEqual(planGrid(box(-650, 0, -650, 650, 100, 650)),
    { originX: -650, originZ: -650, step: 6, nx: 218, nz: 218 });
  // A rectangle: nx follows x and nz follows z; a swap would read 151×249.
  assert.deepEqual(planGrid(box(0, 0, 0, 1488, 100, 900)),
    { originX: 0, originZ: 0, step: 6, nx: 249, nz: 151 });
  assert.equal(planGrid(null), null);
  assert.equal(planGrid(box(0, 0, 0, 0, 10, 0)), null, 'a degenerate box plans nothing');
  assert.equal(planGrid(box(-Infinity, 0, -Infinity, Infinity, 10, Infinity)), null, 'an infinite extent plans nothing');
});

test('the far edge of the world is inside the last cell, never past it', () => {
  // 10 m at a 4 m step is samples at 0, 4, 8, 12 (ceil), not 0, 4, 8 (floor), which left the strip from 8 to 10
  // reading no-ground. Exact multiples do not change: 80/4 is still 21, the station's 1488/6 still 249.
  assert.deepEqual(planGrid(box(0, 0, 0, 10, 5, 10)), { originX: 0, originZ: 0, step: 4, nx: 4, nz: 4 });
});

test('Int16 little-endian base64 round-trips a hand-built array, extremes included', () => {
  const src = new Int16Array([0, 1, -1, 32767, -32768, 1234, -1234, 256]);
  const b64 = encodeInt16Base64(src);
  assert.match(b64, /^[A-Za-z0-9+/]+=*$/);
  assert.deepEqual([...decode(b64)], [...src]);
  // Byte order pinned by hand: 256 is 0x0100 → bytes 00 01 in LE.
  assert.deepEqual([...Buffer.from(encodeInt16Base64(new Int16Array([256])), 'base64')], [0x00, 0x01]);
});

/* A roof at 20 m over the quadrant x ≥ 0, z < 0 and a floor at 0 everywhere;
 * the cast answers the highest surface AT or below yTop and within maxDrop, so
 * a re-cast from exactly a hit height re-hits it: only the job's 1 cm peel
 * moves on to the next surface, and dropping the peel is visible here. The
 * roof depends on BOTH axes and the plan is rectangular, so a transposed
 * index, a swapped x/z or a swapped nx/nz reads a different cell than it
 * wrote - a square plan with an x-only roof let all three pass. */
const surfacesAt = (x, z) => (x >= 0 && z < 0 ? [20, 0] : [0]);
function fakeCast(x, yTop, z, maxDrop) {
  const below = surfacesAt(x, z).filter((h) => h <= yTop && yTop - h <= maxDrop);
  return below.length ? Math.max(...below) : null;
}
const at = (g, h, i, j, k) => h[((j * g.nx) + i) * g.layers + k];
const PLAN = planGrid(box(-40, -5, -40, 40, 30, 60)); // 21×26, step 4, x = -40 + 4i, z = -40 + 4j
const CELLS = 21 * 26;

test('each cell holds its surfaces top-down in cm, NO_SAMPLE below the last, cell order (j*nx)+i', () => {
  const job = createJob(PLAN, fakeCast, { layers: 4, topY: 40, floorY: -25 });
  assert.equal(job.done, false);
  assert.equal(job.cells, CELLS);
  assert.equal(job.run(1e9, () => 0), true, 'an unbounded budget finishes in one run');
  assert.equal(job.done, true);
  const g = job.result();
  assert.deepEqual([g.originX, g.originZ, g.step, g.nx, g.nz, g.layers], [-40, -40, 4, 21, 26, 4]);
  const h = decode(g.heightsCm);
  assert.equal(h.length, CELLS * 4);
  // (11,9): x = 4, z = -4, under the roof. (9,11): its transpose, x = -4, z = 4, open floor.
  assert.deepEqual([0, 1, 2, 3].map((k) => at(g, h, 11, 9, k)), [2000, 0, NO_SAMPLE, NO_SAMPLE]);
  assert.deepEqual([0, 1].map((k) => at(g, h, 9, 11, k)), [0, NO_SAMPLE]);
  // (0,0): open floor. (20,25): the last cell, x = 40, z = 60, open.
  assert.deepEqual([0, 1, 2, 3].map((k) => at(g, h, 0, 0, k)), [0, NO_SAMPLE, NO_SAMPLE, NO_SAMPLE]);
  assert.deepEqual([0, 1].map((k) => at(g, h, 20, 25, k)), [0, NO_SAMPLE]);
});

test('a 400 m surface clamps to 32767 cm rather than wrapping', () => {
  const job = createJob(planGrid(box(0, 0, 0, 8, 500, 8)), () => 400, { layers: 1, topY: 510, floorY: -20 });
  job.run(1e9, () => 0);
  assert.deepEqual([...decode(job.result().heightsCm)], new Array(9).fill(32767));
});

test('a -400 m surface clamps to -32767 cm, never to the -32768 that means "no sample"', () => {
  const job = createJob(planGrid(box(0, 0, 0, 8, 500, 8)), () => -400, { layers: 1, topY: 0, floorY: -410 });
  job.run(1e9, () => 0);
  assert.deepEqual([...decode(job.result().heightsCm)], new Array(9).fill(-32767));
});

test('a hit at or above the ray start is never stored, so layer 0 is topmost; a cast that keeps doing it ends the cell after a bounded number of re-casts', () => {
  // An honest first hit at 10 m; every re-cast then "finds" a surface 100 m above where it started.
  const job = createJob(PLAN, (x, yTop) => (yTop === 40 ? 10 : yTop + 100), { layers: 4, topY: 40, floorY: -25 });
  job.run(1e9, () => 0);
  const h = decode(job.result().heightsCm);
  assert.deepEqual([...h.subarray(0, 4)], [1000, NO_SAMPLE, NO_SAMPLE, NO_SAMPLE]);
  assert.ok(h.every((v, n) => v === (n % 4 === 0 ? 1000 : NO_SAMPLE)), 'every cell: one layer, then padding');
  // Misbehaving from the first cast: no layer at all, and the cell gives up after one
  // attempt plus four steps down - never one re-cast per frame for ever.
  let casts = 0;
  const bad = createJob(PLAN, (x, yTop) => { casts++; return yTop + 100; }, { layers: 4, topY: 40, floorY: -25 });
  bad.run(1e9, () => 0);
  assert.ok(decode(bad.result().heightsCm).every((v) => v === NO_SAMPLE));
  assert.equal(casts, CELLS * 5, 'one attempt and four skips per cell');
});

test('a float-noise hit at the re-cast origin is skipped, not stored, and the surfaces beneath it are still found', () => {
  // Honest surfaces at 20 and 0. The first re-cast, from 20 - PEEL, answers EXACTLY its own
  // origin: what the physics does when the re-cast starts on the face it just found and the
  // distance rounds to nothing. Under `if (h >= y) break` that ended the cell and the floor
  // beneath was lost - for every column of a world, at ~6% of slab heights.
  const honest = (x, yTop, z, maxDrop) => {
    const below = [20, 0].filter((s) => s <= yTop && yTop - s <= maxDrop);
    return below.length ? Math.max(...below) : null;
  };
  const origins = [];
  const noisy = (x, yTop, z, maxDrop) => { origins.push(yTop); return yTop === 20 - 0.01 ? yTop : honest(x, yTop, z, maxDrop); };
  const job = createJob(PLAN, noisy, { layers: 4, topY: 40, floorY: -25 });
  job.run(1e9, () => 0);
  const h = decode(job.result().heightsCm);
  assert.deepEqual([...h.subarray(0, 4)], [2000, 0, NO_SAMPLE, NO_SAMPLE], 'the roof, then the floor; the noise is not a layer');
  assert.ok(h.every((v, n) => v === [2000, 0, NO_SAMPLE, NO_SAMPLE][n % 4]), 'every cell alike');
  // Cell 0's origins: the top, the noisy re-cast, one centimetre lower, then below the floor.
  assert.equal(origins[0], 40);
  assert.equal(origins[1], 20 - 0.01);
  assert.ok(Math.abs(origins[2] - (20 - 0.02)) < 1e-9, `stepped down one peel from the noise, got ${origins[2]}`);
  assert.equal(origins[3], 0 - 0.01);
});

test('createJob refuses a plan it could not index', () => {
  assert.throws(() => createJob(null, fakeCast), /GroundSampler\.createJob: invalid plan/);
  assert.throws(() => createJob({ ...PLAN, nx: 20.5 }, fakeCast), /invalid plan/);
  assert.throws(() => createJob({ ...PLAN, step: 0 }, fakeCast), /invalid plan/);
  assert.throws(() => createJob({ ...PLAN, originX: NaN }, fakeCast), /invalid plan/);
});

test('result() refuses to pack a grid that is not done', () => {
  const job = createJob(PLAN, fakeCast, { layers: 4, topY: 40, floorY: -25 });
  assert.throws(() => job.result(), /GroundSampler: result\(\) before the job is done \(0\/546\)/);
  job.run(1e9, () => 0);
  assert.doesNotThrow(() => job.result());
});

test('the budget is a clock, not a count: budget 0 samples nothing; slices resume where they stopped', () => {
  let t = 0;
  const cast = (...a) => { t += 1; return fakeCast(...a); };   // one millisecond per cast
  const now = () => t;
  const job = createJob(PLAN, cast, { layers: 4, topY: 40, floorY: -25 });
  assert.equal(job.run(0, now), false);
  assert.equal(job.sampled, 0, 'nothing sampled with no budget');
  job.run(2, now);
  assert.ok(job.sampled >= 1 && job.sampled <= 2, `2 ms at 1 ms/cast is one cell, sampled ${job.sampled}`);
  assert.ok(job.progress > 0 && job.progress < 1);
  for (let runs = 0; !job.done && runs < 10000; runs++) job.run(2, now);
  assert.equal(job.done, true);
  assert.equal(job.sampled, CELLS);
  assert.equal(job.progress, 1);
  assert.equal(MAX_LAYERS, 4);
  // Same grid as the unbudgeted run: slicing changed when, never what.
  const whole = createJob(PLAN, fakeCast, { layers: 4, topY: 40, floorY: -25 });
  whole.run(1e9, () => 0);
  assert.deepEqual([...decode(job.result().heightsCm)], [...decode(whole.result().heightsCm)]);
});
