import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  BASE_R, BASE_WALL, BASE_TOP, BASE_SEGS, DOOR_HW, DOOR_H,
  MAST_Y0, MAST_Y1, MAST_R0, MAST_R1, mastRadius,
  CORE_HALF, CORE_X, CORE_WALL, CORE_DOOR_HW, CORE_DOOR_H,
  LEVELS, CAB_GLASS_Y0, CAB_GLASS_Y1, CAB_GLASS_R0, CAB_GLASS_R1,
  LOW_HIDE_R, CAB_HIDE_R, RING_SOLID_LAP,
  ringSegments, gapHalfAngle, discStrips, coreRect, coreWall,
} from '../../src/worlds/station/ControlTower.js';
import { railSpans } from '../../src/worlds/station/Tower.js';
import { DEFAULT_BAND } from '../../src/worlds/lod/DistanceLod.js';

/**
 * Traffic Control, checked as arithmetic.
 *
 * None of the drawing can be reached from Node - `buildControlTower` needs a
 * world, its materials and its physics - so what is asserted here is the
 * arithmetic the drawing is made of, the same arrangement `escalatorDeckDrop`,
 * `stringCourseRuns` and `floorNumeral` already use in this suite.
 *
 * The facts worth pinning are the ones that are invisible when they are wrong:
 * a wall whose collider leaves a notch you can be squeezed through, a lining
 * sized against a cone at the wrong height, a lift core that clears the cavity
 * it runs in but not the wall around it, and a floor plate whose hole does not
 * pass the car.
 */

const near = (a, b, eps, msg) => assert.ok(Math.abs(a - b) < eps, `${msg}: ${a} vs ${b}`);

/* ------------------------------------------------------------------ */
/* The prism wall                                                      */
/* ------------------------------------------------------------------ */

test('a closed ring covers the full circle and its drawn inner corners meet', () => {
  const n = 18, rIn = 11, thick = 0.6;
  const segs = ringSegments(n, rIn, thick);
  assert.equal(segs.length, n);
  const half = Math.PI / n;
  for (let i = 0; i < n; i++) {
    const s = segs[i], t = segs[(i + 1) % n];
    // Inner corner of `s` on its leading side, and of `t` on its trailing side.
    const corner = (seg, sign) => {
      const rMid = rIn + thick / 2;
      // box centre + tangential offset - radial half thickness
      const tx = Math.cos(seg.a), tz = -Math.sin(seg.a);
      const nx = Math.sin(seg.a), nz = Math.cos(seg.a);
      return [
        Math.sin(seg.a) * rMid + sign * (seg.w / 2) * tx - nx * (thick / 2),
        Math.cos(seg.a) * rMid + sign * (seg.w / 2) * tz - nz * (thick / 2),
      ];
    };
    const a = corner(s, 1), b = corner(t, -1);
    near(Math.hypot(a[0] - b[0], a[1] - b[1]), 0, 1e-9,
      `drawn inner corners of segments ${i} and ${i + 1} must meet exactly`);
  }
  near(half * 2 * n, Math.PI * 2, 1e-12, 'the ring closes');
});

test('the collider chord is wide enough that adjacent segments OVERLAP', () => {
  /* The defect this exists to keep out: inner corners that meet exactly leave a
   * V notch opening outward at every joint, and depenetration out of a chord
   * box's end face carries sin(halfSpan) of OUTWARD radial motion - so a capsule
   * in the notch is handed between the two boxes and ratchets through the wall.
   * Measured on the first build of this tower at three separate levels. */
  for (const [n, rIn, thick] of [[18, 11, 0.6], [16, 4.7, 0.22], [16, 10.3, 0.6]]) {
    const half = Math.PI / n;
    const s = ringSegments(n, rIn, thick)[0];
    const outerCornerWidth = 2 * (rIn + thick) * Math.tan(half);
    assert.ok(
      s.wSolid > outerCornerWidth,
      `n=${n} rIn=${rIn}: collider chord ${s.wSolid} must exceed the outer-corner ` +
      `width ${outerCornerWidth} so neighbours overlap through the whole thickness`
    );
    assert.ok(s.wSolid > s.w, 'the collider is wider than the drawn box');
    near(s.wSolid, 2 * (rIn + thick + RING_SOLID_LAP) * Math.tan(half), 1e-12, 'lap');
  }
});

test('the entrance gap is centred on local -Z and is the door width', () => {
  const gap = gapHalfAngle(DOOR_HW, BASE_R);
  const segs = ringSegments(BASE_SEGS, BASE_R, BASE_WALL, gap);
  assert.equal(segs.length, BASE_SEGS);
  // Bearings, normalised into [0, 2pi), must all avoid (PI - gap, PI + gap).
  for (const s of segs) {
    const a = ((s.a % (Math.PI * 2)) + Math.PI * 2) % (Math.PI * 2);
    const d = Math.abs(a - Math.PI);
    assert.ok(d >= gap - 1e-9, `segment at ${a} sits inside the doorway gap`);
  }
  // The clear opening at the inner face is exactly the two door leaves.
  near(2 * BASE_R * Math.sin(gap), DOOR_HW * 2, 1e-9, 'clear opening at the inner face');
  // And the leaves clear the head: the lintel starts at DOOR_H.
  assert.ok(DOOR_H < BASE_TOP, 'the doorway is shorter than the drum it is cut in');
});

/* ------------------------------------------------------------------ */
/* The section against the cone                                        */
/* ------------------------------------------------------------------ */

test('mastRadius interpolates and clamps to the drawn cone', () => {
  near(mastRadius(MAST_Y0), MAST_R0, 1e-12, 'foot');
  near(mastRadius(MAST_Y1), MAST_R1, 1e-12, 'head');
  near(mastRadius(-50), MAST_R0, 1e-12, 'clamped below');
  near(mastRadius(500), MAST_R1, 1e-12, 'clamped above');
  assert.ok(mastRadius(20) > mastRadius(30), 'the mast narrows upward');
});

test('each mast deck lining fits inside the cone at its own CEILING', () => {
  /* The trap: a lining sized against its floor pokes out of the skin by the
   * time it reaches its ceiling, because the mast loses a metre of radius over
   * its height. Corners, not faces - a prism stands proud of its inner radius
   * by 1/cos(pi/n). */
  for (const lv of [LEVELS[1], LEVELS[2]]) {
    const n = 16, thick = 0.22;
    const s = ringSegments(n, lv.r, thick)[0];
    const cornerR = Math.hypot(lv.r + thick, s.w / 2);
    const skin = mastRadius(lv.top);
    assert.ok(cornerR < skin,
      `${lv.name}: lining corner ${cornerR.toFixed(3)} must stay inside the mast ` +
      `skin ${skin.toFixed(3)} at the ceiling (${lv.top} m)`);
    // And the floor plate, drawn 0.3 past the lining, must fit at the FLOOR.
    assert.ok(lv.r + 0.3 < mastRadius(lv.y), `${lv.name}: floor plate fits the cone`);
  }
});

test('the lift core clears the mast, and its WALLS clear each deck lining', () => {
  const cavity = Math.hypot(CORE_X + CORE_HALF, CORE_HALF);
  const withWalls = Math.hypot(CORE_X + CORE_HALF + CORE_WALL, CORE_HALF + CORE_WALL);
  assert.ok(withWalls > cavity, 'the wall is outside the cavity, which is the whole point');
  assert.ok(withWalls < mastRadius(MAST_Y1),
    `core walls (${withWalls.toFixed(3)}) must clear the mast at its narrowest ` +
    `(${mastRadius(MAST_Y1).toFixed(3)})`);
  for (const lv of [LEVELS[1], LEVELS[2]]) {
    assert.ok(withWalls < lv.r,
      `${lv.name}: core walls ${withWalls.toFixed(3)} must clear the lining at ${lv.r}`);
  }
});

test('the cab floor sits where the shell allows and nowhere else', () => {
  const cab = LEVELS[3];
  // The flare's top face is at 42.25 and the glazing starts at 42.10.
  assert.ok(cab.y > CAB_GLASS_Y0, 'the floor is above the bottom of the glass');
  assert.ok(cab.y < CAB_GLASS_Y1 - 2, 'and leaves standing height under the soffit');
  assert.ok(cab.capped === false,
    'the cab takes the roof disc soffit as its ceiling rather than adding a slab ' +
    'a tenth of a metre under it - that pair would be a coincident surface');
  // The glazing rakes outward, so a single collider ring cannot follow it.
  assert.ok(CAB_GLASS_R1 > CAB_GLASS_R0 + 1.0, 'the collar rakes by more than a metre');
});

test('the two interior LOD bands are drawn before anything can see in', () => {
  // The lower batch spans y 0..32.4 about the axis, so its bounding centre is
  // ~16 m up. A player in the doorway is 11 m out and 1.7 m up.
  const inDoorway = Math.hypot(BASE_R + BASE_WALL, 16);
  assert.ok(inDoorway < LOW_HIDE_R - DEFAULT_BAND,
    `standing in the doorway (${inDoorway.toFixed(1)} m from the batch centre) must be ` +
    `inside the fully-drawn band (${LOW_HIDE_R - DEFAULT_BAND} m)`);
  // The cab batch is its own registration, and 42 m of separation is more than
  // its band - which is the reason there are two.
  assert.ok(CAB_HIDE_R + DEFAULT_BAND < LEVELS[3].y - LEVELS[0].y,
    'the cab band must not reach the concourse, or the split buys nothing');
  assert.ok(CAB_HIDE_R > CAB_GLASS_R1, 'the whole cab is inside its own band');
});

/* ------------------------------------------------------------------ */
/* Floor plates                                                        */
/* ------------------------------------------------------------------ */

test('discStrips tile the diameter with no gap and never enter the hole', () => {
  const r = 10.5;
  const hole = coreRect(0.02);
  const strips = discStrips(r, hole, 6);
  assert.ok(strips.length > 4);
  // Z coverage is contiguous over the part of the disc that carries floor.
  const zs = [...new Set(strips.flatMap((s) => [s.z0, s.z1]))].sort((a, b) => a - b);
  for (let i = 0; i < zs.length - 1; i++) {
    const band = strips.filter((s) => s.z0 <= zs[i] + 1e-9 && s.z1 >= zs[i + 1] - 1e-9);
    assert.ok(band.length >= 1, `no strip covers z ${zs[i]}..${zs[i + 1]}`);
  }
  for (const s of strips) {
    assert.ok(s.x1 > s.x0 && s.z1 > s.z0, 'strips are non-degenerate');
    assert.ok(s.z0 >= 0 || s.z1 <= 0, 'no strip straddles the axis');
    const inZ = s.z0 >= hole.z0 - 1e-9 && s.z1 <= hole.z1 + 1e-9;
    if (inZ) {
      assert.ok(s.x1 <= hole.x0 + 1e-9 || s.x0 >= hole.x1 - 1e-9,
        'a strip inside the hole band must stop at the hole, not cross it');
    }
  }
});

test('discStrips OVER-cover to the rim rather than leaving a crescent', () => {
  const r = 10.5;
  for (const s of discStrips(r, null, 6)) {
    const zFar = Math.max(Math.abs(s.z0), Math.abs(s.z1));
    const chordAtFarEdge = Math.sqrt(Math.max(0, r * r - zFar * zFar));
    assert.ok(s.x1 >= chordAtFarEdge - 1e-9,
      'the strip must reach at least the chord at its own far edge, or there is ' +
      'floor drawn with nothing behind it at the window');
  }
});

test('the floor hole passes the lift car', () => {
  const hole = coreRect(0.02);
  const carHalf = CORE_HALF - 0.12;
  assert.ok(hole.x0 < CORE_X - carHalf && hole.x1 > CORE_X + carHalf, 'car clears in X');
  assert.ok(hole.z0 < -carHalf && hole.z1 > carHalf, 'car clears in Z');
  // ... and stops inside the core walls, so the slab meets the wall.
  assert.ok(hole.x0 > CORE_X - CORE_HALF - CORE_WALL, 'the slab reaches into the wall');
  assert.ok(hole.z1 < CORE_HALF + CORE_WALL, 'the slab reaches into the wall');
});

/* ------------------------------------------------------------------ */
/* The lift core                                                       */
/* ------------------------------------------------------------------ */

test('the core is walled on every face for its whole height, except the doors', () => {
  const stops = LEVELS.map((l) => l.y);
  const y0 = 0, y1 = 47;
  const walls = coreWall(stops, y0, y1);
  assert.ok(walls.length >= 3 + stops.length * 3, 'three faces plus bands and jambs');

  const doorX = CORE_X - (CORE_HALF + CORE_WALL / 2);
  const face = walls.filter((w) => Math.abs(w.x - doorX) < 1e-9);
  const others = walls.filter((w) => Math.abs(w.x - doorX) >= 1e-9);
  assert.equal(others.length, 3, 'the three unbroken faces');
  for (const w of others) {
    near(w.y - w.h / 2, y0, 1e-9, 'unbroken face starts at the bottom');
    near(w.y + w.h / 2, y1, 1e-9, 'unbroken face reaches the top');
  }

  // The door face: full-width bands must tile [y0, y1] except the openings.
  const bands = face.filter((w) => Math.abs(w.d - CORE_HALF * 2) < 1e-9)
    .map((w) => [w.y - w.h / 2, w.y + w.h / 2]).sort((a, b) => a[0] - b[0]);
  let cursor = y0;
  for (const sy of stops) {
    // The concourse landing IS the bottom of the core, so the band below it has
    // no height and is not emitted - a zero-height box is not a wall.
    if (sy - cursor > 0.01) {
      const b = bands.shift();
      assert.ok(b, `missing band below the ${sy} m opening`);
      near(b[0], cursor, 1e-9, 'band starts where the last opening ended');
      near(b[1], sy, 1e-9, 'band stops at the landing');
    } else {
      near(sy, cursor, 1e-9, 'a skipped band means the landing is flush with the last');
    }
    cursor = sy + CORE_DOOR_H;
  }
  const last = bands.shift();
  near(last[0], cursor, 1e-9, 'final band starts above the top opening');
  near(last[1], y1, 1e-9, 'final band reaches the lid');
  assert.equal(bands.length, 0, 'no stray bands');

  // Every opening has a jamb on both sides, and they leave the clear width.
  for (const sy of stops) {
    const jambs = face.filter((w) => Math.abs(w.y - (sy + CORE_DOOR_H / 2)) < 1e-9);
    assert.equal(jambs.length, 2, `two jambs at the ${sy} m opening`);
    const inner = Math.min(...jambs.map((j) => Math.abs(j.z) - j.d / 2));
    near(inner, CORE_DOOR_HW, 1e-9, 'the jambs leave exactly the clear width');
  }
});

test('every level is a lift stop, ascending, and the cab is the last', () => {
  const ys = LEVELS.map((l) => l.y);
  for (let i = 1; i < ys.length; i++) assert.ok(ys[i] > ys[i - 1] + 3, 'stops ascend');
  assert.equal(ys[0], 0, 'the concourse floor is the station deck, not a plinth');
  assert.equal(LEVELS.length, 4, 'four numbered floors');
  assert.equal(LEVELS[LEVELS.length - 1].name, 'Operations');
});

/* ------------------------------------------------------------------ */
/* railSpans - the hangar mezzanine's edge protection                  */
/* ------------------------------------------------------------------ */

test('railSpans leaves the stair opening and guards everything else', () => {
  const spans = railSpans(-24, 24, [[18.6, 21.8]]);
  assert.deepEqual(spans, [[-24, 18.6], [21.8, 24]]);
  const guarded = spans.reduce((a, [s, e]) => a + (e - s), 0);
  assert.equal(guarded, 48 - 3.2, 'only the opening is unguarded');
  // A gap that clears an end is not an excuse to drop the whole run.
  assert.deepEqual(railSpans(-24, 24, [[-30, -20]]), [[-20, 24]]);
  // No gaps at all is the run itself.
  assert.deepEqual(railSpans(-24, 24), [[-24, 24]]);
  // Slivers are dropped rather than drawn as 3 cm rails.
  assert.deepEqual(railSpans(0, 10, [[0.02, 9.97]]), []);
});
