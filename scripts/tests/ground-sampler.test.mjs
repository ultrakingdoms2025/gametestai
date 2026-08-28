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

/* THE FLOOR UNDER A ROOF. Under the station hub one column has FIVE surfaces
 * - dome 171.42, canopy 62 / 61.5 / 59.3, deck 0 - and a cell that stopped
 * after four hits stored the canopy beam at 61.5 as its lowest layer. The
 * editor's `placementY` takes the lowest stored layer, said "on surface",
 * and the game spawned the placed item on the roof while the player stood
 * on the deck at y 0.08 beneath it (2 084 of the hub's 3 505 cells, 59 %,
 * had four layers with the lowest above 1 m). The rule: with L layers the
 * grid keeps the top L-1 surfaces AND THE FLOOR - the lowest hit always
 * lands in the last slot - so the sampler keeps casting after the cap.
 * Columns by x (i = (x + 40) / 4); the plan is 6×2 so each is a cell. */
const STACKS = {
  0: [171.42, 62, 61.5, 59.3, 0],   // the hub column: five surfaces
  1: [100, 80, 60, 40, 20, 0],      // six
  2: [20, 0],                       // two - under the cap
  3: [30, 20, 10, 0],               // exactly four: the floor IS the fourth
  4: [30, 20, 10, 5, 0],            // four above the floor, the floor fifth
  5: [0],                           // open floor
};
const STACK_PLAN = planGrid(box(-40, -5, -40, -20, 200, -36)); // step 4, nx 6, nz 2
const stackIndex = (x) => Math.round((x + 40) / 4);
function stackCast(x, yTop, z, maxDrop) {
  const below = STACKS[stackIndex(x)].filter((h) => h <= yTop && yTop - h <= maxDrop);
  return below.length ? Math.max(...below) : null;
}
function stackGrid(cast = stackCast) {
  const job = createJob(STACK_PLAN, cast, { layers: 4, topY: 200, floorY: -25 });
  job.run(1e9, () => 0);
  const g = job.result();
  const h = decode(g.heightsCm);
  return (i) => [0, 1, 2, 3].map((k) => at(g, h, i, 0, k));
}

test('a column with five surfaces keeps the top three and the floor: the fourth-from-top is the layer dropped', () => {
  const layers = stackGrid();
  assert.deepEqual(layers(0), [17142, 6200, 6150, 0], 'dome, two canopy layers, the DECK - not the 59.3 m beam');
});

test('a column with six surfaces keeps the top three and the floor', () => {
  assert.deepEqual(stackGrid()(1), [10000, 8000, 6000, 0]);
});

test('a column with four or fewer surfaces is stored whole, top-down, as before', () => {
  const layers = stackGrid();
  assert.deepEqual(layers(2), [2000, 0, NO_SAMPLE, NO_SAMPLE]);
  assert.deepEqual(layers(3), [3000, 2000, 1000, 0]);
  assert.deepEqual(layers(5), [0, NO_SAMPLE, NO_SAMPLE, NO_SAMPLE]);
});

test('four surfaces above the floor and the floor fifth: the floor is kept in the last slot; the extra casting is bounded by the column', () => {
  const casts = new Map();
  const counting = (x, yTop, z, maxDrop) => { casts.set(stackIndex(x), (casts.get(stackIndex(x)) ?? 0) + 1); return stackCast(x, yTop, z, maxDrop); };
  const layers = stackGrid(counting);
  assert.deepEqual(layers(4), [3000, 2000, 1000, 0], 'the 5 m surface gives way to the floor');
  // Each column is two cells (nz = 2). A column of S surfaces costs S hits and
  // the one miss that ends it - S + 1 casts a cell - so past the cap the extra
  // is S - L + 1: the S - L hits below the cap, plus the miss the cap once
  // spared. Under the cap nothing changed. (The skips bound still applies on top.)
  assert.equal(casts.get(5) / 2, 2, 'one surface: a hit and a miss, as before');
  assert.equal(casts.get(2) / 2, 3, 'two surfaces: unchanged');
  assert.equal(casts.get(3) / 2, 5, 'exactly four: the miss below the floor is the one extra cast');
  assert.equal(casts.get(4) / 2, 6, 'five: two extra casts');
  assert.equal(casts.get(1) / 2, 7, 'six: three extra casts');
});

test('a cast that always answers a hair below its origin is cut off at MAX_CASTS, never run to the floor', () => {
  // Every cast "finds" a surface 2 cm below where it started. Each hit is honest by the
  // loop's rule (below the origin), so nothing skips, and with the cap gone a column of
  // topY 40 over floorY -25 would take (40 + 25) / 0.03 ≈ 2 167 casts - on station,
  // (topY - floorY) / PEEL is ~19 400 - inside ONE cell, where run() never looks at its
  // budget. The cap is 64: L + MAX_SKIPS + a dozen decks, with room.
  let casts = 0;
  const job = createJob(PLAN, (x, yTop) => { casts++; return yTop - 0.02; }, { layers: 4, topY: 40, floorY: -25 });
  job.run(1e9, () => 0);
  assert.equal(casts, CELLS * 64, 'exactly MAX_CASTS casts a cell');
  const h = decode(job.result().heightsCm);
  // Each cast lands 0.03 below the last (a 2 cm answer, then the 1 cm peel): cast n hits
  // 40.01 - 0.03n, so the first three are 39.98, 39.95, 39.92 and the 64th - the lowest,
  // held in the last slot - is 40.01 - 1.92 = 38.09.
  assert.deepEqual([...h.subarray(0, 4)], [3998, 3995, 3992, 3809]);
  assert.ok(h.every((v, n) => v === [3998, 3995, 3992, 3809][n % 4]), 'every cell alike');
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
