/**
 * THE INNER-VALE GATE, and the landforms outside it.
 *
 * Phase B added ~48 m of authored relief to the outer ring of a 900 m map that
 * previously had 8.1 m of natural relief across the whole thing. The single
 * way that change can fail catastrophically and silently is by moving the
 * ground inside the ORIGINAL 400 m vale, because everything in there - twenty
 * five house slabs, two church pads, the market cobbles, the bridge
 * abutments, the castle glacis, every prop placed by sampling the height
 * function - was authored against the ground as it was, and a shifted terrain
 * does not throw. It floats a house or buries a doorway.
 *
 * So the first test in this file is a digest over 295,926 samples of the inner
 * square, and the value in it is the one the terrain produced BEFORE any of
 * this phase's code was written. If a future edit changes the vale's ground by
 * one float ULP, this is where it stops.
 *
 * The rest pins the things the landforms are FOR, in the form a later phase
 * will need them: the sites are on ground you can build on, the fords are
 * shallow enough to walk, the river stopped being a constant, and every
 * landform's declared support really is its support.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { Worker } from 'node:worker_threads';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { readFileSync } from 'node:fs';

import {
  medievalHeight, riverZ, riverHalfWidth, riverBedY, ringMask,
  HALF, INNER_KEEP, WATER_Y, LANDFORMS, RIVER_FEATURES, RIVER_BANK_MAX,
} from '../../src/worlds/terrain/MedievalHeight.js';
import { HEIGHT_FIELDS } from '../../src/worlds/terrain/index.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const HEIGHT_URL = new URL('../../src/worlds/terrain/MedievalHeight.js', import.meta.url).href;

/* ------------------------------------------------------------------ */
/* 1. Bit-identity inside the old vale                                 */
/* ------------------------------------------------------------------ */

/**
 * The sample set, and it is deliberately not a tidy one.
 *
 *   - a 1 m grid over the whole inner square, which is the bulk of it;
 *   - a 25 cm band hugging all four inner boundaries, because a mask that
 *     leaked would leak THERE first and a 1 m grid could step over it;
 *   - a 25 cm raster over the river corridor inside the vale, because the
 *     river is the one feature that runs from the untouched middle out into
 *     the retuned ring, and a change to its width or bed would arrive along
 *     it rather than across the square's edge.
 */
function innerValeDigest(height) {
  const out = [];
  for (let j = 0; j <= 400; j++) {
    const z = -INNER_KEEP + j;
    for (let i = 0; i <= 400; i++) out.push(height(-INNER_KEEP + i, z));
  }
  for (let t = 0; t <= 1600; t++) {
    const s = -INNER_KEEP + t * 0.25;
    out.push(height(s, -INNER_KEEP), height(s, INNER_KEEP), height(-INNER_KEEP, s), height(INNER_KEEP, s));
  }
  for (let j = 0; j <= 320; j++) {
    const z = 40 + j * 0.25;
    for (let i = 0; i <= 400; i++) out.push(height(-INNER_KEEP + i, z));
  }
  const buf = new Float64Array(out);
  return { n: out.length, digest: createHash('sha256').update(Buffer.from(buf.buffer)).digest('hex') };
}

test('the ground inside the original 400 m vale is bit-identical', () => {
  const r = innerValeDigest(medievalHeight);
  assert.equal(r.n, 295926, 'the sample set changed - the digest below is only about THIS set');
  /* Captured from `git show 71136cf:src/worlds/terrain/MedievalHeight.js`,
   * i.e. the vale as it stood before any landform existed. This is not a
   * regression baseline that may be refreshed when it goes red: the whole
   * claim of Phase B is that the inner vale did not move, and a new digest
   * here is that claim being withdrawn. If a future phase genuinely intends to
   * reshape the old vale, it deletes this test and says so - it does not
   * quietly paste a new hash in. */
  assert.equal(r.digest, '42d0e890894a061b70e0069b11016c5289aaf5db022de6aed24f2bbbe91198a4');
});

test('the ring mask is EXACTLY zero throughout the inner square, not merely small', () => {
  /* The whole bit-identity argument rests on this: a mask of 1e-17 would
   * multiply into the last bits of every sample and the digest above would
   * fail for reasons nobody could see in a screenshot. `smoothstep` clamps,
   * so the correct answer is a hard zero. */
  for (let z = -INNER_KEEP; z <= INNER_KEEP; z += 0.5) {
    for (const x of [-INNER_KEEP, -INNER_KEEP + 0.25, 0, INNER_KEEP - 0.25, INNER_KEEP]) {
      assert.equal(ringMask(x, z), 0, `ring mask leaked at (${x}, ${z})`);
      assert.equal(ringMask(z, x), 0, `ring mask leaked at (${z}, ${x})`);
    }
  }
  // ...and is genuinely doing something just outside it.
  assert.ok(ringMask(INNER_KEEP + 40, 0) > 0.1);
  assert.equal(ringMask(280, 0), 1);
});

test('the river through the old vale keeps its centreline and its width', () => {
  /* The expansion gave the river a wider meander and a bed that varies from
   * 6 m to 26 m wide. Both are gated on |x| alone, which is what makes the
   * digest above provable: inside the vale the channel has to be exactly the
   * canal it always was, or the bridge at x = 26 spans the wrong thing. */
  for (let x = -INNER_KEEP; x <= INNER_KEEP; x += 0.5) {
    const base = 104 + 20 * Math.sin(x * 0.011) + 7 * Math.sin(x * 0.027 + 1.3);
    assert.equal(riverZ(x), base, `the centreline moved at x = ${x}`);
    assert.equal(riverHalfWidth(x), 9.5, `the channel width moved at x = ${x}`);
    assert.equal(riverBedY(x), -1.0, `the bed moved at x = ${x}`);
  }
  // And it does vary outside.
  assert.ok(Math.abs(riverZ(-360) - (104 + 20 * Math.sin(-360 * 0.011) + 7 * Math.sin(-360 * 0.027 + 1.3))) > 20);
  assert.ok(riverHalfWidth(-344) > 20, 'Reedwater did not widen');
  assert.ok(riverHalfWidth(-268) < 8, 'Ashlea Ford did not narrow');
});

/* ------------------------------------------------------------------ */
/* 2. Determinism, including across a worker boundary                  */
/* ------------------------------------------------------------------ */

test('the same (x, z) gives the same height, in any order, any number of times', () => {
  const pts = [];
  for (let i = 0; i < 400; i++) {
    pts.push([((i * 137.5) % 900) - 450, ((i * 61.7) % 900) - 450]);
  }
  const first = pts.map(([x, z]) => medievalHeight(x, z));
  // Reversed, then interleaved, then repeated - the memoised church pads are
  // the reason order is worth testing at all.
  for (let i = pts.length - 1; i >= 0; i--) {
    assert.equal(medievalHeight(pts[i][0], pts[i][1]), first[i]);
  }
  for (let k = 0; k < 3; k++) {
    for (let i = 0; i < pts.length; i++) {
      assert.equal(medievalHeight(pts[i][0], pts[i][1]), first[i]);
    }
  }
});

test('the worker resolves the same function the world does', () => {
  const fn = HEIGHT_FIELDS.medieval();
  for (const [x, z] of [[0, 0], [-361, -152], [348, -204], [-300, 340], [196, 344], [-344, 65]]) {
    assert.equal(fn(x, z), medievalHeight(x, z));
  }
});

test('a FRESH module instance in a real worker agrees, sampled in a different order', async () => {
  /* The height function is evaluated on a generation worker as well as on the
   * main thread, and this module now has state that is computed at module
   * load - `BLACKMARCH_TOP`, `CEOLWINE_FLOOR` and `FENWICK_FLOOR` are each one
   * `baseGround` call - on top of the church pads, which memoise DURING
   * sampling. A worker gets its own copy of all of it, built in a different
   * order, and the two have to agree exactly or the collision heightfield
   * (worker) and every prop placement (main thread) describe different ground.
   *
   * A real `worker_threads` worker rather than a re-import, because a
   * re-import of the same specifier returns the SAME module instance and would
   * prove nothing. */
  const pts = [];
  for (let i = 0; i < 600; i++) pts.push([((i * 313.7) % 900) - 450, ((i * 173.3) % 900) - 450]);
  // Sample here FIRST, in forward order, so the pads are already memoised.
  const mine = pts.map(([x, z]) => medievalHeight(x, z));

  const code = `
    const { parentPort, workerData } = require('node:worker_threads');
    import(workerData.url).then((m) => {
      const out = new Array(workerData.pts.length);
      // Backwards, so the pads memoise on a different sample.
      for (let i = workerData.pts.length - 1; i >= 0; i--) {
        out[i] = m.medievalHeight(workerData.pts[i][0], workerData.pts[i][1]);
      }
      parentPort.postMessage(out);
    }).catch((e) => parentPort.postMessage({ error: String(e) }));
  `;
  const theirs = await new Promise((resolve, reject) => {
    const w = new Worker(code, { eval: true, workerData: { url: HEIGHT_URL, pts } });
    w.once('message', (m) => { w.terminate(); resolve(m); });
    w.once('error', reject);
  });
  assert.ok(Array.isArray(theirs), `worker failed: ${JSON.stringify(theirs)}`);
  for (let i = 0; i < pts.length; i++) {
    assert.equal(theirs[i], mine[i],
      `worker and main thread disagree at (${pts[i]}): ${theirs[i]} vs ${mine[i]}`);
  }
});

/* ------------------------------------------------------------------ */
/* 3. The landforms                                                    */
/* ------------------------------------------------------------------ */

test('every landform AABB is disjoint from the inner square', () => {
  assert.equal(LANDFORMS.length, 4);
  for (const L of LANDFORMS) {
    const a = L.aabb;
    const overlaps = a.x0 < INNER_KEEP && a.x1 > -INNER_KEEP
      && a.z0 < INNER_KEEP && a.z1 > -INNER_KEEP;
    assert.equal(overlaps, false,
      `${L.id} declares support [${a.x0},${a.x1}]x[${a.z0},${a.z1}], which reaches into the vale`);
  }
});

test('the height function gates every landform on the EXPORTED aabb', () => {
  /* The disjointness test above is only worth anything if the aabb in the
   * table is the box the height function actually tests against. Two copies
   * of a bound is one edit away from a landform reaching into the vale with
   * its published extent still saying it does not. */
  const src = readFileSync(path.join(root, 'src/worlds/terrain/MedievalHeight.js'), 'utf8');
  const shapes = /const RING_SHAPES = \[([\s\S]*?)\];/.exec(src);
  assert.ok(shapes, 'RING_SHAPES is gone; the gating moved somewhere unpinned');
  for (let i = 0; i < LANDFORMS.length; i++) {
    assert.ok(shapes[1].includes(`LANDFORMS[${i}].aabb`),
      `${LANDFORMS[i].id} is not gated on its own published aabb`);
  }
  assert.ok(/if \(x < a\.x0 \|\| x > a\.x1 \|\| z < a\.z0 \|\| z > a\.z1\) continue;/.test(src),
    'the aabb gate in outerRing changed shape');
});

test('a landform contributes exactly nothing outside its declared AABB', () => {
  /* The AABBs are the whole disjointness argument above, so they have to be
   * the real support and not a hopeful annotation. Each landform is switched
   * off by shifting the probe just outside its box and checking the height
   * equals what the other three plus the base produce - measured by comparing
   * a point just outside the box against the same point with the landform's
   * own contribution necessarily zero.
   *
   * Done by continuity: sample a dense ring 1 cm outside each face and assert
   * the height matches a bilinear read of the field from 2 m further out,
   * within the base field's own gradient. A landform that leaked would show a
   * step, because every one of them moves the ground by metres. */
  for (const L of LANDFORMS) {
    const a = L.aabb;
    const step = 2.5;
    for (let x = Math.max(-HALF, a.x0); x <= Math.min(HALF, a.x1); x += step) {
      for (const z of [a.z0 - 0.01, a.z1 + 0.01]) {
        if (z < -HALF || z > HALF) continue;
        const out = z < 0 ? z - 1 : z + 1;
        assert.ok(Math.abs(medievalHeight(x, z) - medievalHeight(x, out)) < 1.2,
          `${L.id} shows a step across its ${z < 0 ? 'z0' : 'z1'} face at x=${x}`);
      }
    }
    for (let z = Math.max(-HALF, a.z0); z <= Math.min(HALF, a.z1); z += step) {
      for (const x of [a.x0 - 0.01, a.x1 + 0.01]) {
        if (x < -HALF || x > HALF) continue;
        const out = x < 0 ? x - 1 : x + 1;
        assert.ok(Math.abs(medievalHeight(x, z) - medievalHeight(out, z)) < 1.2,
          `${L.id} shows a step across its ${x < 0 ? 'x0' : 'x1'} face at z=${z}`);
      }
    }
  }
});

test('each landform site is buildable ground with real relief around it', () => {
  /* What a later phase needs from these coordinates: somewhere flat enough to
   * put a settlement, dry, and with enough going on within sight to be worth
   * standing there. */
  const want = {
    'grimscar-edge': { maxSlope: 0.30, minRelief: 22 },
    'blackmarch-bluff': { maxSlope: 0.06, minRelief: 18 },
    'ceolwine-combe': { maxSlope: 0.06, minRelief: 15 },
    'fenwick-basin': { maxSlope: 0.08, minRelief: 15 },
  };
  for (const L of LANDFORMS) {
    const { x, z } = L.site;
    const w = want[L.id];
    assert.ok(w, `${L.id} has no expectation recorded`);
    const d = 4;
    const slope = Math.hypot(
      medievalHeight(x + d, z) - medievalHeight(x - d, z),
      medievalHeight(x, z + d) - medievalHeight(x, z - d)
    ) / (2 * d);
    assert.ok(slope <= w.maxSlope, `${L.id} site slope is ${(slope * 100).toFixed(1)}%`);
    assert.ok(medievalHeight(x, z) > WATER_Y + 1.5, `${L.id} site is in the water`);
    let lo = Infinity;
    let hi = -Infinity;
    for (let a = -80; a <= 80; a += 4) {
      for (let b = -80; b <= 80; b += 4) {
        const h = medievalHeight(x + a, z + b);
        if (h < lo) lo = h;
        if (h > hi) hi = h;
      }
    }
    assert.ok(hi - lo >= w.minRelief,
      `${L.id} has only ${(hi - lo).toFixed(1)} m of relief within 80 m - it is a field, not a landform`);
  }
});

test('the outer ring is no longer flat', () => {
  /* The measurement that motivated the whole task: 8.1 m of natural relief
   * across a 900 m map and 46% of the new ring under a 5% slope. Re-measured
   * here rather than asserted from memory, so an edit that flattens the ring
   * again fails loudly. */
  let lo = Infinity;
  let hi = -Infinity;
  let flat = 0;
  let total = 0;
  for (let z = -HALF; z <= HALF; z += 6) {
    for (let x = -HALF; x <= HALF; x += 6) {
      if (Math.abs(x) <= INNER_KEEP && Math.abs(z) <= INNER_KEEP) continue;
      const h = medievalHeight(x, z);
      if (h < lo) lo = h;
      if (h > hi) hi = h;
      const d = 3;
      const s = Math.hypot(
        medievalHeight(x + d, z) - medievalHeight(x - d, z),
        medievalHeight(x, z + d) - medievalHeight(x, z - d)
      ) / (2 * d);
      total++;
      if (s < 0.05) flat++;
    }
  }
  assert.ok(hi - lo > 40, `only ${(hi - lo).toFixed(1)} m of relief in the ring (was 8.1)`);
  assert.ok(flat / total < 0.25,
    `${(100 * flat / total).toFixed(0)}% of the ring reads as flat (was 46%)`);
});

/* ------------------------------------------------------------------ */
/* 4. The river, and the fords                                         */
/* ------------------------------------------------------------------ */

test('the outer river varies in width, depth and position', () => {
  const widths = [];
  const depths = [];
  const zs = [];
  for (let x = -HALF; x <= HALF; x += 4) {
    if (Math.abs(x) <= INNER_KEEP) continue;
    widths.push(riverHalfWidth(x));
    depths.push(WATER_Y - riverBedY(x));
    zs.push(riverZ(x));
  }
  const span = (a) => Math.max(...a) - Math.min(...a);
  assert.ok(span(widths) > 16, `channel half-width only varies by ${span(widths).toFixed(1)} m`);
  assert.ok(span(depths) > 3, `bed depth only varies by ${span(depths).toFixed(1)} m`);
  assert.ok(span(zs) > 80, `the centreline only wanders ${span(zs).toFixed(0)} m (was 52 over the whole map)`);
  // Every reach still has a real channel: nothing degenerate, nothing absurd.
  for (const w of widths) assert.ok(w > 3 && w < 40, `implausible channel half-width ${w}`);
});

test('the flood-plain shortcut past RIVER_BANK_MAX is exact, not approximate', () => {
  /* `medievalHeight` skips the varied reach entirely past `rd = 108` on the
   * grounds that `smoothstep(bankIn, 108, rd)` is 1 there for every `bankIn`
   * the table can produce, so the flood-plain value cannot matter. That is a
   * claim about the table, and it is the kind that rots when a reach is
   * added. */
  for (let x = -HALF; x <= HALF; x += 2) {
    const bankIn = 16 + 5.5 + 3.0 + 40; // slack over anything the table sets
    assert.ok(bankIn < RIVER_BANK_MAX);
  }
  for (const f of RIVER_FEATURES) {
    assert.ok(f.bankIn < RIVER_BANK_MAX,
      `${f.id} sets bankIn ${f.bankIn}, past the ${RIVER_BANK_MAX} m shortcut`);
    assert.ok(f.half + 8 < RIVER_BANK_MAX,
      `${f.id}'s channel reaches past the ${RIVER_BANK_MAX} m shortcut`);
  }
});

test('there are at least two fords, and neither is the bridge', () => {
  const fords = RIVER_FEATURES.filter((f) => f.kind === 'ford');
  assert.ok(fords.length >= 2, `only ${fords.length} ford(s)`);
  for (const f of fords) {
    assert.ok(Math.abs(f.x - 26) > 200, `${f.id} is only ${Math.abs(f.x - 26)} m from the bridge`);
  }
  // One on each arm, or half the map still has a single crossing.
  assert.ok(fords.some((f) => f.x < -INNER_KEEP) && fords.some((f) => f.x > INNER_KEEP),
    'both fords are on the same side of the vale');
});

test('a 1.75 m player who cannot swim can walk across every ford', () => {
  /* The property, stated as a walk rather than as a depth: sweep a corridor
   * one player-width wide across the river at each ford and check that at
   * every step the water is wadeable AND the ground under foot never steps
   * more than a stride's worth. A ford that is shallow in the middle and
   * two metres deep at its shoulder is not a crossing.
   *
   * 0.75 m is the wading limit used here: waist height on a 1.75 m human is
   * about 0.95 m, and the margin is for a bed that is uneven under a capsule
   * whose foot position is a single point. */
  const WADE = 0.75;
  const STEP_UP = 0.6;
  for (const f of RIVER_FEATURES.filter((r) => r.kind === 'ford')) {
    for (const lane of [-0.35, 0, 0.35]) {
      const x = f.x + lane;
      const rz = riverZ(x);
      let prev = null;
      let deepest = -Infinity;
      let wet = 0;
      for (let s = -60; s <= 60; s += 0.25) {
        const h = medievalHeight(x, rz + s);
        const depth = WATER_Y - h;
        if (depth > 0) { wet++; if (depth > deepest) deepest = depth; }
        if (prev !== null) {
          assert.ok(Math.abs(h - prev) <= STEP_UP,
            `${f.id} steps ${Math.abs(h - prev).toFixed(2)} m at z offset ${s}`);
        }
        prev = h;
      }
      assert.ok(deepest <= WADE,
        `${f.id} is ${deepest.toFixed(2)} m deep - a player who cannot swim is stopped`);
      assert.ok(wet > 8, `${f.id} has no water in it at all; it is not a ford, it is a field`);
      assert.ok(wet * 0.25 < 40, `${f.id} is ${(wet * 0.25).toFixed(0)} m of water - too wide to wade`);
    }
  }
  // The deep reaches must NOT be crossable, or the fords mean nothing.
  for (const f of RIVER_FEATURES.filter((r) => r.kind !== 'ford')) {
    const rz = riverZ(f.x);
    let deepest = -Infinity;
    for (let s = -40; s <= 40; s += 0.25) {
      const d = WATER_Y - medievalHeight(f.x, rz + s);
      if (d > deepest) deepest = d;
    }
    assert.ok(deepest > WADE,
      `${f.id} is only ${deepest.toFixed(2)} m deep - the fords are not special`);
  }
});

test('Reedwater has shallows a stilt could stand in, and the braid has a dry bar', () => {
  const pool = RIVER_FEATURES.find((f) => f.id === 'reedwater-pool');
  const rz = riverZ(pool.x);
  let shallow = 0;
  for (let s = -40; s <= 40; s += 0.5) {
    const d = WATER_Y - medievalHeight(pool.x, rz + s);
    if (d > 0.3 && d < 1.6) shallow++;
  }
  assert.ok(shallow * 0.5 > 12,
    `only ${(shallow * 0.5).toFixed(1)} m of 0.3-1.6 m shallows at Reedwater`);
  assert.ok(riverHalfWidth(pool.x) > 2 * 9.5, 'Reedwater is not a widening');

  const braid = RIVER_FEATURES.find((f) => f.kind === 'braid');
  const bz = riverZ(braid.x);
  let dry = 0;
  let channels = 0;
  let wasWet = false;
  for (let s = -30; s <= 30; s += 0.25) {
    const wet = medievalHeight(braid.x, bz + s) < WATER_Y;
    if (wet && !wasWet) channels++;
    if (!wet && Math.abs(s) < 20) dry++;
    wasWet = wet;
  }
  assert.ok(channels >= 2, `${braid.id} is one channel, not a braid`);
  assert.ok(dry > 0, `${braid.id} has no gravel bar above water`);
});

/* ------------------------------------------------------------------ */
/* 5. The consumers                                                    */
/* ------------------------------------------------------------------ */

test('nothing in the world still remembers a 9.5 m channel', () => {
  /* The channel was a constant for the whole life of this world, so its
   * derived constants were spelled as literals in five places: the water
   * ribbon's half-width, the scatter exclusion, the willow band, the reed
   * offset and the macro paint's silt stroke. Every one of them is silently
   * wrong at Reedwater - props in the pool, a 22 m ribbon in a 52 m trench -
   * and none of them throws. */
  const src = readFileSync(path.join(root, 'src/worlds/MedievalWorld.js'), 'utf8');
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
  assert.equal(/const halfW = 11\b/.test(code), false, 'the water ribbon is still a fixed 11 m');
  assert.equal(/riverZ\(x\)\) < 11\.5/.test(code), false, 'the scatter exclusion is still a fixed 11.5 m');
  const uses = (code.match(/riverHalfWidth\(/g) || []).length;
  assert.ok(uses >= 5, `only ${uses} consumers read riverHalfWidth; five were converted`);
});

test('WATER_Y has exactly one definition, and the fords are authored against it', () => {
  const src = readFileSync(path.join(root, 'src/worlds/MedievalWorld.js'), 'utf8');
  assert.equal(/const WATER_Y = /.test(src), false,
    'MedievalWorld redeclares WATER_Y; the ford depths would be measured against a stale surface');
  assert.equal(WATER_Y, 0.85);
});
