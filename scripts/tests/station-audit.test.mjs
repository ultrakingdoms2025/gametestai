import { test } from 'node:test';
import assert from 'node:assert/strict';

/**
 * The station audit's arithmetic, checked headlessly.
 *
 * ── Why this imports StationAuditMath and not StationAudit ────────────────
 * `StationAudit.js` needs a built `StationWorld`, and that world cannot be
 * imported under Node at all: it paints its textures onto a `document` canvas
 * and uploads them through a WebGL context, so the import throws before a
 * single function is reachable. Anything that imports it inherits the same
 * problem, which is why every number the audit decides anything with was
 * factored out into `src/dev/StationAuditMath.js` - plain numbers, plain
 * objects, no THREE, no DOM, no module-scope side effects.
 *
 * What is covered here is exactly the part where a wrong answer would be
 * invisible in the report: which operand a threshold is measured against, what
 * counts as touching rather than overlapping, whether the broadphase can drop a
 * pair, and whether the run-break sampler is measuring the geometry it thinks
 * it is. The end-to-end behaviour is covered by the injected-defect gate in
 * `src/dev/StationAuditSelfTest.js`, which needs a browser.
 */

const M = await import('../../src/dev/StationAuditMath.js');

const box = (minX, minY, minZ, maxX, maxY, maxZ) => ({ min: [minX, minY, minZ], max: [maxX, maxY, maxZ] });
const unit = (x = 0, y = 0, z = 0) => box(x, y, z, x + 1, y + 1, z + 1);

/* ------------------------------------------------------------------ */
/* AABB intersection volume                                            */
/* ------------------------------------------------------------------ */

test('aabbIntersection: disjoint boxes share nothing', () => {
  const r = M.aabbIntersection(unit(0, 0, 0), unit(5, 0, 0));
  assert.equal(r.volume, 0);
  assert.equal(r.box, null);
});

test('aabbIntersection: boxes that merely touch are not overlapping', () => {
  // A crate resting exactly on the deck shares a zero-thickness plane with it.
  const r = M.aabbIntersection(box(0, -1, 0, 1, 0, 1), unit(0, 0, 0));
  assert.equal(r.volume, 0, 'a shared face is not an intersection');
  assert.equal(r.box, null);
});

test('aabbIntersection: half-overlapping unit cubes share exactly 0.5 m3', () => {
  const r = M.aabbIntersection(unit(0, 0, 0), unit(0.5, 0, 0));
  assert.equal(M.round(r.volume), 0.5);
  assert.deepEqual(r.box.min, [0.5, 0, 0]);
  assert.deepEqual(r.box.max, [1, 1, 1]);
});

test('aabbIntersection: a contained box yields its own volume', () => {
  const outer = box(0, 0, 0, 10, 10, 10);
  const inner = box(1, 1, 1, 2, 3, 4);
  const r = M.aabbIntersection(outer, inner);
  assert.equal(r.volume, M.aabbVolume(inner));
});

test('aabbIntersection is symmetric', () => {
  const a = box(0, 0, 0, 2, 2, 2), b = box(1, -1, 1, 4, 1, 4);
  assert.equal(M.aabbIntersection(a, b).volume, M.aabbIntersection(b, a).volume);
});

test('aabbVolume / aabbSize / aabbCentre agree with each other', () => {
  const b = box(-1, 2, -3, 3, 4, 1);
  assert.deepEqual(M.aabbSize(b), [4, 2, 4]);
  assert.deepEqual(M.aabbCentre(b), [1, 3, -1]);
  assert.equal(M.aabbVolume(b), 32);
});

/* ------------------------------------------------------------------ */
/* The overlap threshold                                               */
/* ------------------------------------------------------------------ */

test('overlapSignificant: measured against the SMALLER prop, not the larger', () => {
  // 0.6 m3 shared between a 1 m3 bollard and a 1000 m3 building is 60% of the
  // bollard and 0.06% of the building. It is a defect.
  assert.equal(M.overlapSignificant(0.6, 1, 1000), true);
  // The same absolute volume between two buildings is a party wall.
  assert.equal(M.overlapSignificant(0.6, 1000, 1000), false);
});

test('overlapSignificant: the absolute floor stops z-fighting being a finding', () => {
  assert.equal(M.overlapSignificant(0.01, 0.02, 0.02), false, 'under the 0.02 m3 floor');
  assert.equal(M.overlapSignificant(0.03, 0.05, 0.05), true);
});

test('overlapSignificant: exactly at the threshold does not report', () => {
  // 5% of a 4 m3 prop is 0.2 m3, which is also above the absolute floor.
  assert.equal(M.overlapSignificant(0.2, 4, 4), false, 'strictly greater than');
  assert.equal(M.overlapSignificant(0.2001, 4, 4), true);
});

test('overlapSignificant: zero and negative volumes never report', () => {
  assert.equal(M.overlapSignificant(0, 1, 1), false);
  assert.equal(M.overlapSignificant(-1, 1, 1), false);
});

/* ------------------------------------------------------------------ */
/* The spatial hash                                                    */
/* ------------------------------------------------------------------ */

test('SpatialHash: rejects a nonsense cell size rather than hashing everything into one bucket', () => {
  assert.throws(() => new M.SpatialHash(0), /cell size/);
  assert.throws(() => new M.SpatialHash(-4), /cell size/);
});

test('SpatialHash: finds every genuinely overlapping pair a brute-force sweep finds', () => {
  // 300 boxes on a deterministic lattice with deliberate collisions, checked
  // against the O(n^2) answer. This is the property that matters: the hash is
  // an optimisation and is allowed to offer extra candidates, never to miss.
  let seed = 12345;
  const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  const boxes = [];
  for (let i = 0; i < 300; i++) {
    const x = rnd() * 40, y = rnd() * 6, z = rnd() * 40;
    const s = 0.4 + rnd() * 3;
    boxes.push(box(x, y, z, x + s, y + s, z + s));
  }
  const brute = new Set();
  for (let i = 0; i < boxes.length; i++) {
    for (let j = i + 1; j < boxes.length; j++) {
      if (M.aabbIntersection(boxes[i], boxes[j]).volume > 0) brute.add(`${i},${j}`);
    }
  }
  const hash = new M.SpatialHash(4);
  for (const b of boxes) hash.insert(b);
  const found = new Set();
  hash.forEachPair((i, j) => {
    if (M.aabbIntersection(boxes[i], boxes[j]).volume > 0) found.add(`${i},${j}`);
  });
  assert.ok(brute.size > 20, `the fixture needs real overlaps to be a test (had ${brute.size})`);
  assert.deepEqual([...found].sort(), [...brute].sort());
});

test('SpatialHash: a pair spanning several shared cells is reported once', () => {
  const hash = new M.SpatialHash(1);
  hash.insert(box(0, 0, 0, 5, 5, 5));
  hash.insert(box(1, 1, 1, 4, 4, 4));       // shares dozens of cells
  let n = 0;
  const pairs = [];
  hash.forEachPair((i, j) => { n++; pairs.push([i, j]); });
  assert.equal(n, 1);
  assert.deepEqual(pairs, [[0, 1]]);
});

test('SpatialHash: boxes further apart than a cell never become candidates', () => {
  const hash = new M.SpatialHash(4);
  hash.insert(unit(0, 0, 0));
  hash.insert(unit(100, 0, 0));
  let n = 0;
  hash.forEachPair(() => n++);
  assert.equal(n, 0);
});

test('SpatialHash: negative coordinates hash correctly (the station is centred on the origin)', () => {
  const hash = new M.SpatialHash(4);
  const a = hash.insert(box(-10.5, 0, -10.5, -9.5, 1, -9.5));
  const b = hash.insert(box(-10.0, 0, -10.0, -9.0, 1, -9.0));
  const pairs = [];
  hash.forEachPair((i, j) => pairs.push([i, j]));
  assert.deepEqual(pairs, [[a, b]]);
});

test('SpatialHash: candidates() returns the item itself plus its neighbours', () => {
  const hash = new M.SpatialHash(4);
  hash.insert(unit(0, 0, 0));
  hash.insert(unit(0.5, 0, 0));
  hash.insert(unit(50, 0, 0));
  const c = hash.candidates(unit(0, 0, 0));
  assert.ok(c.has(0) && c.has(1));
  assert.ok(!c.has(2));
});

/* ------------------------------------------------------------------ */
/* The gap classifier                                                  */
/* ------------------------------------------------------------------ */

test('classifyGap: the 0.05 m band around zero is OK on both sides', () => {
  assert.equal(M.classifyGap(0), 'OK');
  assert.equal(M.classifyGap(0.05), 'OK', 'exactly at the threshold is not a defect');
  assert.equal(M.classifyGap(-0.05), 'OK');
  assert.equal(M.classifyGap(0.0501), 'FLOAT');
  assert.equal(M.classifyGap(-0.0501), 'SUNK');
});

test('classifyGap: the injected self-test magnitudes land on the right verdicts', () => {
  assert.equal(M.classifyGap(0.50), 'FLOAT');
  assert.equal(M.classifyGap(-0.30), 'SUNK');
});

test('classifyGap: "nothing underneath" is its own verdict, never folded into FLOAT', () => {
  assert.equal(M.classifyGap(null), 'NO_SUPPORT');
  assert.equal(M.classifyGap(undefined), 'NO_SUPPORT');
  assert.equal(M.classifyGap(NaN), 'NO_SUPPORT');
  assert.equal(M.classifyGap(Infinity), 'NO_SUPPORT');
});

test('classifyGap: thresholds are overridable and are actually consulted', () => {
  const loose = { ...M.THRESHOLDS, floatGap: 0.5, sunkGap: -0.5 };
  assert.equal(M.classifyGap(0.3, loose), 'OK');
  assert.equal(M.classifyGap(0.6, loose), 'FLOAT');
});

test('shouldBeSolid: trim and decals are not expected to collide, bollards are', () => {
  assert.equal(M.shouldBeSolid(box(0, 0, 0, 2, 0.1, 2)), false, 'a 10 cm floor decal');
  assert.equal(M.shouldBeSolid(box(0, 0, 0, 0.1, 3, 0.1)), false, 'a cable run');
  assert.equal(M.shouldBeSolid(box(0, 0, 0, 0.44, 1.0, 0.44)), true, 'a service bollard');
});

/* ------------------------------------------------------------------ */
/* Footprint sampling                                                  */
/* ------------------------------------------------------------------ */

test('footprintSamples: five points, the first the centre, the rest inside the box', () => {
  const b = box(0, 0, 0, 2, 4, 6);
  const s = M.footprintSamples(b, 0.6);
  assert.equal(s.length, 5);
  assert.deepEqual(s[0], [1, 2, 3]);
  for (const p of s) {
    assert.ok(p[0] >= b.min[0] && p[0] <= b.max[0]);
    assert.ok(p[1] >= b.min[1] && p[1] <= b.max[1]);
    assert.ok(p[2] >= b.min[2] && p[2] <= b.max[2]);
  }
});

test('footprintSamples: fraction 0 collapses to the centre, 1 reaches the corners', () => {
  const b = box(0, 0, 0, 2, 2, 2);
  for (const p of M.footprintSamples(b, 0)) assert.deepEqual(p, [1, 1, 1]);
  const far = M.footprintSamples(b, 1);
  assert.deepEqual(far[1], [0, 0, 0]);
  assert.deepEqual(far[2], [2, 0, 2]);
});

/* ------------------------------------------------------------------ */
/* The run-break sampler's geometry                                    */
/* ------------------------------------------------------------------ */

test('polarPoint agrees with StationKit.roadPos', () => {
  // roadPos(deg, r, off) = (cos t * r - sin t * off, sin t * r + cos t * off)
  const [x, z] = M.polarPoint(60, 100, 9.45);
  const t = 60 * Math.PI / 180;
  assert.ok(Math.abs(x - (Math.cos(t) * 100 - Math.sin(t) * 9.45)) < 1e-9);
  assert.ok(Math.abs(z - (Math.sin(t) * 100 + Math.cos(t) * 9.45)) < 1e-9);
});

test('polarPoint: bearing 0 runs down +X, and the offset is to its left', () => {
  const [x, z] = M.polarPoint(0, 50, 3);
  assert.ok(Math.abs(x - 50) < 1e-9);
  assert.ok(Math.abs(z - 3) < 1e-9);
});

test('bearingDelta wraps the short way round', () => {
  assert.equal(M.bearingDelta(350, 10), 20);
  assert.equal(M.bearingDelta(10, 350), -20);
  assert.equal(M.bearingDelta(0, 180), 180);
  assert.equal(M.bearingDelta(0, 0), 0);
});

test('arcSeparation: the loop stairs are 37 m of arc from every avenue at r=72', () => {
  // 30 degrees at radius 72 is 37.7 m. This is the number that decides the
  // "does this crossing exist at all" question for the avenue kerbs.
  assert.equal(Math.round(M.arcSeparation(30, 0, 72)), 38);
  assert.equal(Math.round(M.arcSeparation(30, 60, 72)), 38);
  assert.equal(M.arcSeparation(120, 120, 72), 0);
});

test('crossingExists: a loop stair never reaches an avenue kerb, and the ring always does', () => {
  const kerbOffset = 18 / 2 + 0.45;             // ROAD_W/2 + 0.45 = 9.45
  assert.equal(M.crossingExists(30, 0, 72, 2.5, kerbOffset), false, '38 m away, half-width 2.5');
  assert.equal(M.crossingExists(0, 0, 72, 2.5, kerbOffset), true, 'a run down the avenue itself');
});

test('roadMouthSamples: spread across the carriageway, on the ring, inside the kerbs', () => {
  const s = M.roadMouthSamples(0, 40.3, 18, 5);
  assert.equal(s.length, 5);
  for (const p of s) {
    assert.ok(Math.abs(Math.hypot(p.x, p.z) - Math.hypot(40.3, p.off)) < 1e-6, 'sample lies on the ring radius');
    assert.ok(Math.abs(p.off) <= 18 / 2, 'never outside the carriageway');
  }
  assert.ok(Math.abs(s[0].off + s[4].off) < 1e-9, 'symmetric about the centreline');
  assert.equal(M.round(s[2].off), 0, 'the middle sample is the centreline');
});

test('kerbLineSamples: walk the kerb between two radii, at a constant offset', () => {
  const s = M.kerbLineSamples(120, 37, 188, 9.45, -1, 4);
  assert.equal(s.length, 4);
  assert.equal(s[0].r, 37);
  assert.equal(s[3].r, 188);
  for (const p of s) {
    // Distance from the origin to a point r out and 9.45 across is hypot(r, 9.45).
    assert.ok(Math.abs(Math.hypot(p.x, p.z) - Math.hypot(p.r, 9.45)) < 1e-6);
  }
});

test('triangleHeightAt: reads the height of a sloped triangle, and misses cleanly', () => {
  // A 45-degree ramp: y = x over the unit square's lower triangle.
  const h = (x, z) => M.triangleHeightAt(0, 0, 0, 1, 1, 0, 0, 0, 1, x, z);
  assert.equal(M.round(h(0.5, 0.1)), 0.5);
  assert.equal(M.round(h(0.1, 0.1)), 0.1);
  assert.equal(h(5, 5), null, 'outside the triangle');
  assert.equal(h(0.9, 0.9), null, 'past the hypotenuse');
});

test('triangleHeightAt: a triangle seen edge-on from above is a clean miss, not a divide by zero', () => {
  const h = M.triangleHeightAt(0, 0, 0, 0, 5, 0, 0, 0, 1, 0, 0.5);
  assert.equal(h, null);
});

test('classifyRunBreak: the defect is what you cannot step over', () => {
  assert.deepEqual(M.classifyRunBreak(null), { blocked: false, verdict: 'CLEAR' });
  assert.deepEqual(M.classifyRunBreak(0), { blocked: false, verdict: 'CLEAR' });
  // The plaza kerb ring is a 0.18 m inlaid lip. Present, and not a defect.
  assert.deepEqual(M.classifyRunBreak(0.18), { blocked: true, verdict: 'STEPPABLE' });
  assert.deepEqual(M.classifyRunBreak(0.45), { blocked: true, verdict: 'STEPPABLE' }, 'exactly stepHeight is steppable');
  // A 1.2 m railing across a stair arrival is not.
  assert.deepEqual(M.classifyRunBreak(1.2), { blocked: true, verdict: 'BLOCKED' });
});

/* ------------------------------------------------------------------ */
/* Escalator deltas                                                    */
/* ------------------------------------------------------------------ */

test('escalatorDeltas: three pairwise deltas and the worst of them', () => {
  const d = M.escalatorDeltas({ treadY: 8.83, rampY: 8.80, floorY: 8.70 });
  assert.equal(d.treadVsRamp, 0.03);
  assert.equal(d.treadVsFloor, 0.13);
  assert.equal(d.rampVsFloor, 0.10);
  assert.equal(M.round(d.worst), 0.13);
});

test('escalatorDeltas: a perfectly aligned flight has a worst delta of zero', () => {
  const d = M.escalatorDeltas({ treadY: 12.6, rampY: 12.6, floorY: 12.6 });
  assert.equal(d.worst, 0);
  assert.ok(d.worst <= M.THRESHOLDS.escalatorTolerance);
});

test('escalatorDeltas: a 0.10 m nudge moves both tread deltas by 0.10 and leaves the third alone', () => {
  const before = M.escalatorDeltas({ treadY: 8.83, rampY: 8.80, floorY: 8.70 });
  const after = M.escalatorDeltas({ treadY: 8.93, rampY: 8.80, floorY: 8.70 });
  assert.equal(M.round(after.treadVsFloor - before.treadVsFloor), 0.10);
  assert.equal(M.round(after.treadVsRamp - before.treadVsRamp), 0.10);
  assert.equal(after.rampVsFloor, before.rampVsFloor);
});

/* ------------------------------------------------------------------ */
/* Housekeeping                                                        */
/* ------------------------------------------------------------------ */

test('round: stable to four places, and passes null and NaN straight through', () => {
  assert.equal(M.round(1 / 3), 0.3333);
  assert.equal(M.round(-0.05000001), -0.05);
  assert.equal(M.round(null), null);
  assert.ok(Number.isNaN(M.round(NaN)));
});

test('THRESHOLDS carries the values the checks are documented against', () => {
  assert.equal(M.THRESHOLDS.floatGap, 0.05);
  assert.equal(M.THRESHOLDS.sunkGap, -0.05);
  assert.equal(M.THRESHOLDS.overlapMinVolume, 0.02);
  assert.equal(M.THRESHOLDS.overlapMinFraction, 0.05);
  assert.equal(M.THRESHOLDS.overlapCell, 4);
  assert.equal(M.THRESHOLDS.stepHeight, 0.45, 'must match CONFIG.player.stepHeight');
  assert.equal(M.THRESHOLDS.airborneY, 12);
  assert.equal(M.THRESHOLDS.escalatorTolerance, 0.02);
});

test('AUDIT_VERSION is present, so a report can be told from an older one', () => {
  assert.match(M.AUDIT_VERSION, /^station-audit\/\d+\.\d+\.\d+$/);
});
