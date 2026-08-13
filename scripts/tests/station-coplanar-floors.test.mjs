import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  stringCourseRuns, STRING_COURSE_T, STRING_COURSE_OUT, WALL_T,
  SIGN_LAYERS,
} from '../../src/worlds/station/Tower.js';
import { seamLift, CoplanarLevels } from '../../src/worlds/station/StationKit.js';

/**
 * "Ground on top of ground": the surfaces this world drew twice on one plane.
 *
 * A raycast sweep of the render geometry over the hub deck and the four zones
 * found 407 pairs of near-horizontal faces less than a millimetre apart - the
 * class the depth buffer cannot order at any distance. 251 of them, over half
 * the world's total, were one line in Tower.js: the string course, drawn as a
 * full-plan box instead of a band, so its top face shared a plane with the
 * floor slab above it at every storey of every tower.
 *
 * None of that can be measured from Node - `buildTower` needs a world, its
 * materials and its physics - so the parts of it that are arithmetic are
 * exported and checked here, the same arrangement `escalatorDeckDrop` uses.
 */

/* Two representative towers: the hub's habitat stacks, and the widest thing
 * this function is asked for. */
const CASES = [[24, 22], [26, 24], [18, 30]];

/** Axis-aligned overlap area of two rectangles given as centre + half-extents. */
function overlapArea(a, b) {
  const ox = Math.min(a.x + a.w / 2, b.x + b.w / 2) - Math.max(a.x - a.w / 2, b.x - b.w / 2);
  const oz = Math.min(a.z + a.d / 2, b.z + b.d / 2) - Math.max(a.z - a.d / 2, b.z - b.d / 2);
  return Math.max(0, ox) * Math.max(0, oz);
}

/* ------------------------------------------------------------------ */
/* The string course                                                   */
/* ------------------------------------------------------------------ */

test('the defect: a full-plan string course covered every floor plate', () => {
  /* What the code did before, restated independently. The band was one box
   * `w + 0.5` by `d + 0.5`; the floor plates fill the interior. If this ever
   * stops being an overlap, the test below has stopped meaning anything. */
  for (const [w, d] of CASES) {
    const oldBox = { x: 0, z: 0, w: w + STRING_COURSE_OUT * 2, d: d + STRING_COURSE_OUT * 2 };
    const interior = { x: 0, z: 0, w: (w / 2 - WALL_T) * 2, d: (d / 2 - WALL_T) * 2 };
    assert.equal(
      overlapArea(oldBox, interior).toFixed(4),
      (interior.w * interior.d).toFixed(4),
      `${w}x${d}: the old band covered the whole plate, which is the defect`
    );
  }
});

test('the band never reaches the interior, so no run shares the plate plane', () => {
  for (const [w, d] of CASES) {
    const interior = { x: 0, z: 0, w: (w / 2 - WALL_T) * 2, d: (d / 2 - WALL_T) * 2 };
    for (const r of stringCourseRuns(w, d)) {
      assert.equal(
        overlapArea(r, interior), 0,
        `${w}x${d}: run at (${r.x}, ${r.z}) overlaps the floor plate`
      );
    }
  }
});

test('the band still covers the whole wall line and overhang', () => {
  // Same silhouette from outside: the four runs tile the perimeter exactly.
  for (const [w, d] of CASES) {
    const runs = stringCourseRuns(w, d);
    const outer = (w + STRING_COURSE_OUT * 2) * (d + STRING_COURSE_OUT * 2);
    const inner = (w - WALL_T * 2) * (d - WALL_T * 2);
    const area = runs.reduce((s, r) => s + r.w * r.d, 0);
    assert.ok(Math.abs(area - (outer - inner)) < 1e-9, `${w}x${d}: band area ${area} != ${outer - inner}`);
  }
});

test('no two runs overlap each other either', () => {
  for (const [w, d] of CASES) {
    const runs = stringCourseRuns(w, d);
    for (let i = 0; i < runs.length; i++) {
      for (let j = i + 1; j < runs.length; j++) {
        assert.equal(overlapArea(runs[i], runs[j]), 0, `${w}x${d}: runs ${i} and ${j} overlap`);
      }
    }
  }
});

test('the band is still 0.22 thick and stands 0.25 proud, as it was drawn', () => {
  assert.equal(STRING_COURSE_T, 0.22);
  assert.equal(STRING_COURSE_OUT, 0.25);
  for (const [w, d] of CASES) {
    const runs = stringCourseRuns(w, d);
    const maxX = Math.max(...runs.map((r) => r.x + r.w / 2));
    const maxZ = Math.max(...runs.map((r) => r.z + r.d / 2));
    assert.ok(Math.abs(maxX - (w / 2 + STRING_COURSE_OUT)) < 1e-9);
    assert.ok(Math.abs(maxZ - (d / 2 + STRING_COURSE_OUT)) < 1e-9);
  }
});

/* ------------------------------------------------------------------ */
/* Ring seams                                                          */
/* ------------------------------------------------------------------ */

test('adjacent segments of a ring never land on the same level', () => {
  /* Every paved ring in the zones oversizes its quads so they overlap their
   * neighbours and hide the joint. Whatever the segment count, the two quads
   * either side of a joint have to be separable - including at the wrap, which
   * is where a plain parity would fail on every odd-segment ring. */
  const STEP = 0.004;
  for (let n = 2; n <= 200; n++) {
    for (let i = 0; i < n; i++) {
      const a = seamLift(i, n, STEP);
      const b = seamLift((i + 1) % n, n, STEP);
      assert.ok(Math.abs(a - b) >= STEP - 1e-12, `n=${n} i=${i}: ${a} vs ${b}`);
    }
  }
});

test('an open run does not pay for a wrap it does not have', () => {
  // A servery apron is an arc, not a ring: its last quad touches nothing.
  for (let n = 2; n <= 50; n++) {
    const levels = new Set(Array.from({ length: n }, (_, i) => seamLift(i, n, 0.004, false)));
    assert.equal(levels.size, 2, `n=${n} used ${levels.size} levels`);
  }
});

test('the ladder is never taller than it needs to be', () => {
  for (let n = 2; n <= 200; n++) {
    for (let i = 0; i < n; i++) assert.ok(seamLift(i, n, 0.004) <= 0.008 + 1e-12);
  }
});

test('a single quad is not lifted at all', () => {
  assert.equal(seamLift(0, 1, 0.004), 0);
  assert.equal(seamLift(0, 0, 0.004), 0);
});

/* ------------------------------------------------------------------ */
/* Scattered patches                                                   */
/* ------------------------------------------------------------------ */

test('overlapping patches are never given the same level', () => {
  /* The construction zone throws ~75 aprons of compacted stone round towers,
   * plots and bays; a tower's is its footprint plus 15 m a side and swallows
   * whatever is beside it. Emission order says nothing about which overlap, so
   * the level has to come from the geometry. */
  let seed = 0x9e3779b9;
  const rnd = () => (((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296));
  const N = 5;
  const levels = new CoplanarLevels(N);
  const placed = [];
  let checked = 0;
  for (let i = 0; i < 400; i++) {
    const cx = (rnd() - 0.5) * 700, cz = (rnd() - 0.5) * 700;
    const hx = 3 + rnd() * 22, hz = 3 + rnd() * 22;
    const l = levels.claim(cx, cz, hx, hz);
    const hits = placed.filter((p) => Math.abs(p.cx - cx) < p.hx + hx && Math.abs(p.cz - cz) < p.hz + hz);
    // The guarantee is "a free level if there is one", not "a free level".
    if (new Set(hits.map((p) => p.l)).size < N) {
      checked++;
      for (const p of hits) assert.notEqual(p.l, l, `patch ${i} shares level ${l} with an overlapping patch`);
    }
    placed.push({ cx, cz, hx, hz, l });
  }
  assert.ok(checked > 350, `only ${checked} of 400 patches had a level to spare`);
});

test('a patch that touches nothing takes the lowest level', () => {
  const levels = new CoplanarLevels(5);
  assert.equal(levels.claim(0, 0, 5, 5), 0);
  assert.equal(levels.claim(100, 100, 5, 5), 0);
  assert.equal(levels.claim(0, 0, 5, 5), 1);      // this one does touch
});

test('the ladder is never grown past its budget', () => {
  // Ten patches on one spot cannot become ten heights; the eleventh surface
  // above this one is not ours to move.
  const levels = new CoplanarLevels(3);
  const used = [];
  for (let i = 0; i < 10; i++) used.push(levels.claim(0, 0, 4, 4));
  assert.ok(Math.max(...used) < 3, `used ${used.join(',')}`);
});

/* ------------------------------------------------------------------ */
/* Floor-number signs: three parallel surfaces on one wall             */
/* ------------------------------------------------------------------ */

/**
 * The new stacked surfaces in this world, and why they get their own case.
 *
 * A floor sign is a wall, a backing plate in front of it, and lit segment bars
 * in front of that: three parallel planes within seven centimetres of each
 * other, which is precisely the shape of the defect this file exists to guard.
 * There are two of these on every storey of every enterable tower - 20 towers
 * at 7 to 9 floors - so getting the stacking wrong would put several hundred
 * coincident pairs back into a world that has just had 323 taken out.
 *
 * The layout is arithmetic and is exported for that reason; `buildTower` itself
 * needs a world, its materials and its physics and cannot be reached from here.
 */
test('a floor sign never puts two surfaces on one plane', () => {
  const { PLATE_T, PLATE_GAP, BAR_T, BAR_GAP } = SIGN_LAYERS;
  // Measured outward from the wall face at 0, which is what `floorSign` does.
  const plateBack = PLATE_GAP;
  const plateFront = PLATE_GAP + PLATE_T;
  const barBack = PLATE_GAP + PLATE_T + BAR_GAP;
  const barFront = barBack + BAR_T;
  const faces = [0, plateBack, plateFront, barBack, barFront];
  for (let i = 0; i < faces.length; i++) {
    for (let j = i + 1; j < faces.length; j++) {
      assert.ok(
        Math.abs(faces[i] - faces[j]) > 0.001,
        `sign faces at ${faces[i]} and ${faces[j]} are within a millimetre`
      );
    }
  }
});

test('the sign layers are ordered, so no layer is buried in the one behind it', () => {
  const { PLATE_T, PLATE_GAP, BAR_T, BAR_GAP } = SIGN_LAYERS;
  assert.ok(PLATE_GAP > 0, 'the plate is flush with the wall');
  assert.ok(BAR_GAP > 0, 'the bars are flush with the plate');
  assert.ok(PLATE_T > 0 && BAR_T > 0);
  // A bar standing proud of its plate by less than the plate is thick still
  // reads as inlaid rather than as a lamp; that is a look, not a defect, so it
  // is asserted only that the whole assembly is shallow enough to be signage.
  assert.ok(PLATE_GAP + PLATE_T + BAR_GAP + BAR_T < 0.2, 'a floor sign is not a bollard');
});
