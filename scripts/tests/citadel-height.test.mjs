/**
 * THE PROTECTED CORE, and the landforms outside it.
 *
 * Phase 3 took Citadel's `HALF` from 200 to 450 and authored about 57 m of
 * relief into a ring that was previously flat sand at exactly zero. The single
 * way that change can fail catastrophically and silently is by moving the
 * ground inside the ORIGINAL 400 m playfield, because everything in there -
 * the mesa itself, 192 roofs, the curtain wall, the souk rings, eleven
 * haystacks, five viewpoints and every prop placed by sampling this function -
 * was authored against the ground as it was. A shifted terrain does not throw.
 * It floats a haystack or buries a doorway, and this world has already shipped
 * a haystack that did not catch.
 *
 * So the first test in this file is a digest over 530,421 samples, and the
 * value in it is the one the terrain produced BEFORE any of this phase's code
 * was written (`git show HEAD~:src/worlds/terrain/CitadelHeight.js` at the time
 * of writing). If a future edit changes the core by one float ULP, this is
 * where it stops. It is NOT a regression baseline to be refreshed when it goes
 * red: a new digest here is the claim being withdrawn.
 *
 * The rest pins the things the landforms are FOR, and every one of them is a
 * FLOOR with the achieved value and an ablation ceiling quoted beside it,
 * because this project has shipped a world with zero reachable wildlife and 29
 * green tests by asserting "not worse than" with no floor underneath.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { Worker } from 'node:worker_threads';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { readFileSync } from 'node:fs';

import {
  citadelHeight, terrainH, ringMask, ringRelief,
  HALF, INNER_KEEP, MESA_Y, MESA_R, SHOULDER, CITADEL_LANDFORMS,
} from '../../src/worlds/terrain/CitadelHeight.js';
import { HEIGHT_FIELDS } from '../../src/worlds/terrain/index.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const HEIGHT_URL = new URL('../../src/worlds/terrain/CitadelHeight.js', import.meta.url).href;

/**
 * Gradient a player can still walk up.
 *
 * `Treasures.MAX_WALK_SLOPE` is 0.78 in the NORMALISED form `MedievalWorld._slope`
 * produces, which multiplies the raw gradient by 1.15. 0.78 / 1.15 = 0.678 is
 * the raw gradient, and that is what a probe on this height field measures.
 * Reproduced rather than imported because `Treasures.js` imports the medieval
 * height field and this file has no business loading a second world.
 */
const WALK = 0.678;
/** Gradient at which a face becomes something `Climb` can grip: 60 degrees. */
const GRIP = Math.tan((60 * Math.PI) / 180);
/** Drop at which fall damage first appears, measured on the real integrator. */
const HURT = 7.5;

/* ------------------------------------------------------------------ */
/* 1. Bit-identity inside the original 400 m playfield                 */
/* ------------------------------------------------------------------ */

/**
 * The sample set, and it is deliberately not a tidy one.
 *
 *   - a 1 m grid over the whole protected square, which is the bulk of it;
 *   - a 25 cm band along all four of its boundaries, because a leaked mask
 *     leaks THERE first and a 1 m grid can step straight over a 25 cm leak;
 *   - a 25 cm POLAR raster over the mesa shoulder (r 128..182 at 0.25 m, 720
 *     bearings), because the shoulder is the one part of the core that is a
 *     slope rather than a plateau: a change of a millimetre on the flat mesa
 *     top moves nothing, and the same change on the shoulder moves the cliff
 *     ring, the climb faces and the eleven haystacks below them;
 *   - a 25 cm raster over the 8 m band just inside the boundary, which is the
 *     approach corridor under every landform. No landform's support runs from
 *     the protected zone outward - they are all disjoint from the square - so
 *     this band is the strongest available substitute: it is where a support
 *     that DID reach in would arrive.
 */
function coreDigest(height) {
  const K = INNER_KEEP;
  const R0 = MESA_R - 4;
  const RN = Math.round((MESA_R + SHOULDER + 4 - R0) / 0.25);
  const out = [];
  for (let j = 0; j <= 400; j++) {
    const z = -K + j;
    for (let i = 0; i <= 400; i++) out.push(height(-K + i, z));
  }
  for (let t = 0; t <= 1600; t++) {
    const s = -K + t * 0.25;
    out.push(height(s, -K), height(s, K), height(-K, s), height(K, s));
  }
  for (let b = 0; b < 720; b++) {
    const a = (b / 720) * Math.PI * 2;
    const ca = Math.cos(a);
    const sa = Math.sin(a);
    for (let k = 0; k <= RN; k++) {
      const r = R0 + k * 0.25;
      out.push(height(ca * r, sa * r));
    }
  }
  for (let j = 0; j <= 1600; j++) {
    const z = -K + j * 0.25;
    const az = z < 0 ? -z : z;
    for (let i = 0; i <= 1600; i++) {
      const x = -K + i * 0.25;
      const ax = x < 0 ? -x : x;
      if (ax < K - 8 && az < K - 8) continue;
      out.push(height(x, z));
    }
  }
  const buf = new Float64Array(out);
  return { n: out.length, digest: createHash('sha256').update(Buffer.from(buf.buffer)).digest('hex') };
}

test('the ground inside the original 400 m playfield is bit-identical', () => {
  const r = coreDigest(citadelHeight);
  assert.equal(r.n, 530421, 'the sample set changed - the digest below is only about THIS set');
  assert.equal(
    r.digest,
    '70e97b158e3d3282b9ec4c4ff59db2231c492bdd63d03cd13292314d84ae6116',
    'the Citadel core moved. This is not a baseline to refresh: it is the claim '
    + 'that HALF 200 -> 450 did not touch the town, and a new digest here withdraws it.'
  );
});

test('the core is bit-identical because the added term is LITERALLY zero, not merely small', () => {
  /* The digest above would also pass if two errors cancelled, and it says
   * nothing about the mechanism. This says the mechanism: every point of the
   * protected square, on the same four sample sets, has `ringRelief === 0`
   * exactly - so `citadelHeight` is `terrainH(hypot) + 0`, and `v + 0 === v`
   * for every double this function can produce.
   *
   * `assert.equal` on a float is the point here, not a smell. */
  let n = 0;
  for (let z = -INNER_KEEP; z <= INNER_KEEP; z += 1) {
    for (let x = -INNER_KEEP; x <= INNER_KEEP; x += 1) {
      const v = ringRelief(x, z);
      if (v !== 0) assert.fail(`ringRelief(${x}, ${z}) = ${v}, not 0`);
      assert.equal(citadelHeight(x, z), terrainH(Math.hypot(x, z)));
      n++;
    }
  }
  // The boundary itself, at 25 cm, where a `<` for a `<=` would show first.
  for (let t = 0; t <= 1600; t++) {
    const s = -INNER_KEEP + t * 0.25;
    for (const [x, z] of [[s, -INNER_KEEP], [s, INNER_KEEP], [-INNER_KEEP, s], [INNER_KEEP, s]]) {
      if (ringRelief(x, z) !== 0) assert.fail(`ringRelief(${x}, ${z}) is non-zero ON the boundary`);
      n++;
    }
  }
  assert.equal(n, 167_205, 'the zero-set shrank');
});

test('ringMask is exactly 0 at and inside INNER_KEEP, and reaches 1 outside it', () => {
  /* Chebyshev, and clamping. A Euclidean mask would be non-zero at the square's
   * corners - `hypot(200, 200)` is 283 - and an unclamped one would be a small
   * negative rather than a zero, which is the 1e-17 the whole phase is against. */
  for (const [x, z] of [
    [0, 0], [199.75, 199.75], [200, 0], [0, 200], [-200, 200], [200, -200],
    [200, 137.4], [-13.5, -200], [180, 200], [200, 200],
  ]) {
    assert.equal(ringMask(x, z), 0, `ringMask(${x}, ${z}) is not exactly 0`);
  }
  // Non-zero the instant it is outside, or the mask is not a mask.
  assert.ok(ringMask(200.001, 0) > 0, 'the mask never turns on');
  assert.ok(ringMask(200.001, 0) < 1e-6, 'the mask turns on as a step, not a ramp');
  // Full strength well before the first landform's nearest face (z = 203.5 is
  // inside the ramp, so the mask must be finished long before the map edge).
  assert.equal(ringMask(262, 0), 1);
  assert.equal(ringMask(HALF, HALF), 1);
});

test('the mesa constants and the mesa profile itself are untouched', () => {
  assert.equal(MESA_Y, 14);
  assert.equal(MESA_R, 132);
  assert.equal(SHOULDER, 46);
  assert.equal(terrainH(0), 14);
  assert.equal(terrainH(131.999), 14);
  assert.equal(terrainH(MESA_R + SHOULDER), 0);
  assert.equal(terrainH(500), 0);
  // The whole shoulder, so a re-derivation of the smootherstep would be caught.
  assert.equal(terrainH(155), 7);
  assert.equal(citadelHeight(0, 0), 14);
});

/* ------------------------------------------------------------------ */
/* 2. The worker sees the same ground                                  */
/* ------------------------------------------------------------------ */

test('the worker resolves the same function the world does', () => {
  const fn = HEIGHT_FIELDS.citadel();
  for (const [x, z] of [[0, 0], [0, 315], [325, -96], [-40, -326], [-362, 190], [342, 296], [-449, 449]]) {
    assert.equal(fn(x, z), citadelHeight(x, z));
  }
});

test('a FRESH module instance in a real worker agrees, sampled in a different order', async () => {
  /* This module now has state computed at MODULE LOAD - `QUARRY_TOP`,
   * `KARST_BASE`, `ASHFALL_TOP` and `DUNE_PAN_Y` are each a `baseGround` call,
   * and `baseGround` reaches into `MedievalHeight`'s permutation table, which
   * is itself seeded at load. The height field is evaluated on a generation
   * worker as well as on the main thread; a worker gets its own copy of all of
   * it, built in a different order, and the two have to agree EXACTLY or the
   * collision heightfield (worker) and every prop placement (main thread)
   * describe different ground.
   *
   * A real `worker_threads` worker rather than a re-import, because a
   * re-import of the same specifier returns the SAME module instance and would
   * prove nothing at all about module-load state. */
  const pts = [];
  for (let i = 0; i < 700; i++) pts.push([((i * 313.7) % 900) - 450, ((i * 173.3) % 900) - 450]);
  const mine = pts.map(([x, z]) => citadelHeight(x, z));

  const code = `
    const { parentPort, workerData } = require('node:worker_threads');
    import(workerData.url).then((m) => {
      const out = new Array(workerData.pts.length);
      // Backwards, so nothing can memoise in the same order it did here.
      for (let i = workerData.pts.length - 1; i >= 0; i--) {
        out[i] = m.citadelHeight(workerData.pts[i][0], workerData.pts[i][1]);
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
/* 3. The landforms and their supports                                 */
/* ------------------------------------------------------------------ */

test('every landform AABB is disjoint from the protected square', () => {
  assert.equal(CITADEL_LANDFORMS.length, 5);
  for (const L of CITADEL_LANDFORMS) {
    const a = L.aabb;
    const overlaps = a.x0 < INNER_KEEP && a.x1 > -INNER_KEEP
      && a.z0 < INNER_KEEP && a.z1 > -INNER_KEEP;
    assert.equal(overlaps, false,
      `${L.id} declares support [${a.x0},${a.x1}]x[${a.z0},${a.z1}], which reaches into the town`);
    assert.ok(a.x0 >= -HALF && a.x1 <= HALF && a.z0 >= -HALF && a.z1 <= HALF,
      `${L.id} declares support outside the map`);
  }
});

test('the landform supports are pairwise disjoint, so the apply order cannot matter', () => {
  for (let i = 0; i < CITADEL_LANDFORMS.length; i++) {
    for (let j = i + 1; j < CITADEL_LANDFORMS.length; j++) {
      const a = CITADEL_LANDFORMS[i].aabb;
      const b = CITADEL_LANDFORMS[j].aabb;
      const overlaps = a.x0 < b.x1 && a.x1 > b.x0 && a.z0 < b.z1 && a.z1 > b.z0;
      assert.equal(overlaps, false,
        `${CITADEL_LANDFORMS[i].id} and ${CITADEL_LANDFORMS[j].id} share ground; `
        + 'the order `outerRing` applies them in has become load-bearing');
    }
  }
});

test('the height function gates every landform on the EXPORTED aabb', () => {
  /* The disjointness tests above are only worth anything if the aabb in the
   * table is the box the height function actually tests against. Two copies of
   * a bound is one edit away from a landform reaching into the town with its
   * published extent still saying it does not. */
  const src = readFileSync(path.join(root, 'src/worlds/terrain/CitadelHeight.js'), 'utf8');
  const shapes = /const RING_SHAPES = \[([\s\S]*?)\];/.exec(src);
  assert.ok(shapes, 'RING_SHAPES is gone; the gating moved somewhere unpinned');
  for (let i = 0; i < CITADEL_LANDFORMS.length; i++) {
    assert.ok(shapes[1].includes(`CITADEL_LANDFORMS[${i}].aabb`),
      `${CITADEL_LANDFORMS[i].id} is not gated on its own published aabb`);
  }
  assert.ok(/if \(x < a\.x0 \|\| x > a\.x1 \|\| z < a\.z0 \|\| z > a\.z1\) continue;/.test(src),
    'the aabb gate in outerRing changed shape');
  // And the core's own gate, which is what makes bit-identity structural.
  assert.ok(/if \(\(ax > az \? ax : az\) <= INNER_KEEP\) return 0;/.test(src),
    'ringRelief no longer short-circuits to a literal zero inside the square');
});

test('a landform contributes exactly nothing outside its declared AABB', () => {
  /* The AABBs are the whole disjointness argument, so they have to be the real
   * support and not a hopeful annotation. Done by STRADDLING each face: 1 cm
   * inside against 1 cm outside. That distinction is the whole test - Aldermoor's
   * equivalent samples 1 cm outside against 1 m further out, both of them beyond
   * the box, and a mutation that let the quarry's own shape reach 30 m past its
   * declared support survived it, because `outerRing`'s gate clips the leak at
   * the box face and turns it into a 5 m STEP there rather than into anything
   * visible outside. Straddling sees the step.
   *
   * Tolerance 0.05 m across 2 cm: the steepest ambient gradient at any of these
   * faces is about 0.3, i.e. 0.006 m across the straddle, and every one of these
   * landforms moves the ground by metres. */
  for (const L of CITADEL_LANDFORMS) {
    const a = L.aabb;
    for (let x = Math.max(-HALF, a.x0) + 0.5; x <= Math.min(HALF, a.x1) - 0.5; x += 2.5) {
      for (const z of [a.z0, a.z1]) {
        if (z - 0.01 < -HALF || z + 0.01 > HALF) continue;
        assert.ok(Math.abs(citadelHeight(x, z - 0.01) - citadelHeight(x, z + 0.01)) < 0.05,
          `${L.id} steps across its z=${z.toFixed(2)} face at x=${x.toFixed(2)}: `
          + `${citadelHeight(x, z - 0.01).toFixed(3)} vs ${citadelHeight(x, z + 0.01).toFixed(3)}`);
      }
    }
    for (let z = Math.max(-HALF, a.z0) + 0.5; z <= Math.min(HALF, a.z1) - 0.5; z += 2.5) {
      for (const x of [a.x0, a.x1]) {
        if (x - 0.01 < -HALF || x + 0.01 > HALF) continue;
        assert.ok(Math.abs(citadelHeight(x - 0.01, z) - citadelHeight(x + 0.01, z)) < 0.05,
          `${L.id} steps across its x=${x.toFixed(2)} face at z=${z.toFixed(2)}: `
          + `${citadelHeight(x - 0.01, z).toFixed(3)} vs ${citadelHeight(x + 0.01, z).toFixed(3)}`);
      }
    }
  }
});

/* ------------------------------------------------------------------ */
/* 4. The ring is a place, not an extent                               */
/* ------------------------------------------------------------------ */

test('the outer ring is not flat', () => {
  /* The measurement that motivated the whole task, re-measured here rather
   * than asserted from memory. Same ruler Aldermoor's uses (6 m grid, 3 m
   * central difference, 5% slope) so the two numbers are comparable.
   *
   * Before: relief 0.00 m, 100.0% under a 5% slope - `terrainH` is radial and
   * returns 0 past r = 178, so the entire ring was sand at exactly zero.
   * Floor: relief > 40 m and flat share < 25%.
   * Achieved: 56.67 m and 18.8%. (Aldermoor's equivalent went 46.2% -> 17.7%.)
   * Ceiling, by ablating each half in turn and re-measuring:
   *   landforms off, broad relief only:  12.72 m, 20.9% flat
   *   broad relief off, landforms only:  44.00 m, 74.9% flat
   * Which says exactly which term is doing which job, and neither number is
   * reachable by tuning the other: the landforms own the relief and the broad
   * relief owns the slope. A single figure would have hidden that, and hiding
   * it is how a ring gets five dramatic hills in a car park. */
  let lo = Infinity;
  let hi = -Infinity;
  let flat = 0;
  let total = 0;
  for (let z = -HALF; z <= HALF; z += 6) {
    for (let x = -HALF; x <= HALF; x += 6) {
      if (Math.abs(x) <= INNER_KEEP && Math.abs(z) <= INNER_KEEP) continue;
      const h = citadelHeight(x, z);
      if (h < lo) lo = h;
      if (h > hi) hi = h;
      const d = 3;
      const s = Math.hypot(
        citadelHeight(x + d, z) - citadelHeight(x - d, z),
        citadelHeight(x, z + d) - citadelHeight(x, z - d)
      ) / (2 * d);
      total++;
      if (s < 0.05) flat++;
    }
  }
  assert.ok(hi - lo > 40, `only ${(hi - lo).toFixed(2)} m of relief in the ring (was 0.00, floor 40)`);
  assert.ok(flat / total < 0.25,
    `${(100 * flat / total).toFixed(1)}% of the ring reads as flat (was 100.0, floor 25)`);
  // The ring must not have swallowed the mesa: the town is 14 m tall and the
  // point of the citadel is that you can see it.
  assert.ok(hi > 50, `the tallest thing in the ring is ${hi.toFixed(1)} m - no landmark`);
  assert.ok(lo > -6, `the ring digs to ${lo.toFixed(2)} m, below the desert floor collider's top`);
});

test('every landform is a landform and not a field', () => {
  /* Relief within the declared support, and a buildable site. Floors are per
   * landform because a pit and a dune field are not the same promise. The
   * ceiling in each case is the shape's own authored rise, which is what the
   * probe would read with the broad relief ablated. */
  const want = {
    'undercliff-terraces': { minRelief: 24, maxSiteSlope: 0.20, authored: 20 },
    'quarry-deepworks': { minRelief: 22, maxSiteSlope: 0.06, authored: 22 },
    'karst-massif': { minRelief: 40, maxSiteSlope: 0.06, authored: 44 },
    'ashfall-plateau': { minRelief: 24, maxSiteSlope: 0.06, authored: 24 },
    'caravanserai-dunes': { minRelief: 12, maxSiteSlope: 0.06, authored: 9.6 },
  };
  for (const L of CITADEL_LANDFORMS) {
    const w = want[L.id];
    assert.ok(w, `${L.id} has no expectation recorded`);
    const a = L.aabb;
    let lo = Infinity;
    let hi = -Infinity;
    for (let x = a.x0; x <= a.x1; x += 3) {
      for (let z = a.z0; z <= a.z1; z += 3) {
        const h = citadelHeight(x, z);
        if (h < lo) lo = h;
        if (h > hi) hi = h;
      }
    }
    assert.ok(hi - lo >= w.minRelief,
      `${L.id} has only ${(hi - lo).toFixed(1)} m of relief inside its own support `
      + `(floor ${w.minRelief}, authored rise ${w.authored})`);
    const d = 4;
    const s = Math.hypot(
      citadelHeight(L.site.x + d, L.site.z) - citadelHeight(L.site.x - d, L.site.z),
      citadelHeight(L.site.x, L.site.z + d) - citadelHeight(L.site.x, L.site.z - d)
    ) / (2 * d);
    assert.ok(s <= w.maxSiteSlope,
      `${L.id}'s site slopes at ${(s * 100).toFixed(1)}% - nothing can be built on it `
      + `(ceiling ${(w.maxSiteSlope * 100).toFixed(0)}%)`);
  }
});

/* ------------------------------------------------------------------ */
/* 5. The verbs the ground has to teach                                */
/* ------------------------------------------------------------------ */

/** Peak gradient along a ray, probed at 25 cm - the resolution a foot has. */
function peakGradient(x0, z0, dx, dz, r0, r1) {
  let worst = 0;
  let at = 0;
  for (let r = r0; r <= r1; r += 0.25) {
    const g = Math.abs(
      citadelHeight(x0 + dx * (r + 0.25), z0 + dz * (r + 0.25))
      - citadelHeight(x0 + dx * (r - 0.25), z0 + dz * (r - 0.25))
    ) / 0.5;
    if (g > worst) { worst = g; at = r; }
  }
  return { worst, at };
}

test('every district has a walkable way in', () => {
  /* The medieval lesson, restated: a landform whose own table entry names it as
   * where a district wants to stand, that a player cannot walk up, is a map the
   * reachability model is WRONG about rather than strict about. Blackmarch
   * Bluff came out unreachable at a 0.62 limit and the answer was to measure
   * the ramp, not to loosen the limit.
   *
   * Ceiling by ablation: on the OPPOSITE bearing the same landform measures
   * 0.92 (karst) and 2.04 (ashfall), so these ramps are a designed approach and
   * not simply a landform too gentle to fail. */
  const KARST_NECK = Math.atan2(326, 40);
  const ASH_NECK = Math.atan2(-190, 325);
  const cases = [
    ['undercliff approach', 0, 0, 0, 1, 226, 302, 0.547],
    ['karst neck ramp', -40, -326, Math.cos(KARST_NECK), Math.sin(KARST_NECK), 44, 123, 0.577],
    ['ashfall neck ramp', -325, 190, Math.cos(ASH_NECK), Math.sin(ASH_NECK), 50, 140, 0.561],
    ['quarry outer slope', 325, -96, 1, 0, 58, 120, 0.462],
  ];
  for (const [label, x, z, dx, dz, r0, r1, recorded] of cases) {
    const { worst, at } = peakGradient(x, z, dx, dz, r0, r1);
    assert.ok(worst <= WALK,
      `${label} peaks at ${worst.toFixed(3)} (d=${at}), over the ${WALK} walk limit`);
    assert.ok(Math.abs(worst - recorded) < 0.02,
      `${label} measures ${worst.toFixed(3)}, recorded ${recorded} - the comment is stale`);
  }
});

test('every climb face is grippable and inside one stamina bar', () => {
  /* 29.3 m on one bar, measured on the real integrator. A face that needs more
   * strands a player halfway up it, and a face under 1.73 (60 degrees) is not a
   * face at all - `Climb` will not grip it and the player walks up a ramp the
   * design calls a cliff. Both bounds, or the assertion is decoration. */
  const cases = [
    ['karst summit face', -40, -326, 1, 0, 12, 28, citadelHeight(-40, -326) - citadelHeight(-40, -290)],
    ['ashfall back face', -325, 190, -Math.cos(Math.atan2(-190, 325)), -Math.sin(Math.atan2(-190, 325)),
      50, 140, citadelHeight(-362, 190) - citadelHeight(-410, 215)],
  ];
  for (const [label, x, z, dx, dz, r0, r1, rise] of cases) {
    const { worst } = peakGradient(x, z, dx, dz, r0, r1);
    assert.ok(worst >= GRIP,
      `${label} peaks at only ${worst.toFixed(3)}, under the ${GRIP.toFixed(3)} a face needs to be gripped`);
    assert.ok(rise > 18, `${label} rises only ${rise.toFixed(1)} m - it is a step, not a climb`);
    assert.ok(rise <= 29.3,
      `${label} rises ${rise.toFixed(1)} m unbroken, over the 29.3 m one stamina bar sustains`);
  }
});

test('every authored drop is survivable, and is a drop rather than a slope', () => {
  /* The Undercliff terraces and the quarry benches exist to be jumped down.
   * Each riser must be steep enough that a player cannot simply walk it (or the
   * descent is a ramp and the verb is not taught) and short enough that taking
   * it does no damage - fall damage first appears at 7.5 m, measured. */
  const undercliff = peakGradient(0, 0, 0, 1, 302, 430);
  assert.ok(undercliff.worst > WALK,
    `the Undercliff risers peak at ${undercliff.worst.toFixed(3)} - a walk, not a drop`);
  const quarry = peakGradient(325, -96, 1, 0, 18, 54);
  assert.ok(quarry.worst > WALK,
    `the quarry benches peak at ${quarry.worst.toFixed(3)} - a walk, not a drop`);

  // Riser HEIGHTS, read off the treads rather than off the constants.
  const benches = [315, 347, 379, 411].map((r) => citadelHeight(0, r));
  for (let i = 1; i < benches.length; i++) {
    const drop = benches[i - 1] - benches[i];
    assert.ok(drop > 2.5,
      `Undercliff bench ${i} drops only ${drop.toFixed(2)} m - the terrace has flattened out`);
    assert.ok(drop < HURT,
      `Undercliff bench ${i} drops ${drop.toFixed(2)} m, past the ${HURT} m where fall damage starts`);
  }
  const rim = citadelHeight(325 + 56, -96);
  const floor = citadelHeight(325, -96);
  assert.ok(rim - floor >= 19 && rim - floor <= 21,
    `the quarry is ${(rim - floor).toFixed(2)} m deep, not the authored 20`);
  assert.ok((rim - floor) / 3 < HURT,
    'the quarry benches average more than a survivable drop apiece');
  assert.ok(floor > 0,
    `the quarry floor is at ${floor.toFixed(2)} m - it is a hole under the desert, not a pit in a crown`);
});

test('the transition out of the protected square is not a visible terrace', () => {
  /* The mask ramps over 62 m from a square whose ground is exactly 0. If that
   * ramp were short it would read as a step ringing the middle of the map -
   * which is the exact artefact the whole Chebyshev-mask technique risks.
   *
   * Points inside a landform's support are excluded, and only those: the karst
   * massif's foot and the Undercliff's approach both reach into this band on
   * purpose and are measured on their own bearings above. What is being tested
   * here is the CONNECTIVE ground - everywhere the ring has nothing authored on
   * it, which is 69,620 of the band's 115,920 samples. */
  const inside = (x, z) => CITADEL_LANDFORMS.some((L) => {
    const a = L.aabb;
    return x >= a.x0 && x <= a.x1 && z >= a.z0 && z <= a.z1;
  });
  let worst = 0;
  let at = null;
  let n = 0;
  for (let b = 0; b < 720; b++) {
    const a = (b / 720) * Math.PI * 2;
    const ca = Math.cos(a);
    const sa = Math.sin(a);
    for (let r = 195; r <= 275; r += 0.5) {
      const x = ca * r;
      const z = sa * r;
      if (inside(x, z) || inside(ca * (r + 0.5), sa * (r + 0.5))) continue;
      n++;
      const g = Math.abs(citadelHeight(ca * (r + 0.5), sa * (r + 0.5))
        - citadelHeight(ca * (r - 0.5), sa * (r - 0.5))) / 1;
      if (g > worst) { worst = g; at = [x, z]; }
    }
  }
  assert.ok(n > 60_000, `only ${n} samples of connective band survived the landform filter`);
  assert.ok(worst < 0.35,
    `the mask ramp peaks at ${worst.toFixed(3)} near ${at} - that is a terrace, not a transition`);
});
