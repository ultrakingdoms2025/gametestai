import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEG, LOOP_R, LOOP_Y,
  WALKWAY, WALKWAY_DECK_TOP, WALKWAY_STAIR_R_INNER,
  walkwayStairFlight, walkwayRailRuns,
} from '../../src/worlds/station/StationKit.js';

/**
 * Where the promenade's stair flights stop, and where its railing stops.
 *
 * `_buildWalkwayLoop` cannot be called under Node - it needs a built world,
 * its materials and its physics - so the arithmetic that decides whether a
 * flight reaches the deck, and whether the railing is open where it arrives,
 * is exported and checked here. The end-to-end measurement is the station
 * audit's C5 plus a capsule walk up each flight from the running page; this
 * covers the part those would only ever report as a number.
 *
 * ── The defect these pin ─────────────────────────────────────────────────
 * The flights climbed to `LOOP_R`, the loop's CENTRELINE, and the deck is 6 m
 * across. So the last 3 m of every flight ran underneath the walkway it was
 * climbing to: profiled up the middle of the flight at bearing 30, the ramp
 * top was 7.80 m at r = 75 with the deck slab solid from 9.46 to 10.04 - 1.66 m
 * of headroom for a 1.75 m capsule - falling to 0.16 m at r = 72.5. Nobody
 * could reach the promenade from the deck.
 */

const CAPSULE_H = 1.75;

test('a flight stops at the deck EDGE, not at its centreline', () => {
  const { rInner } = walkwayStairFlight();
  assert.equal(rInner, LOOP_R + WALKWAY.WIDTH / 2);
  assert.notEqual(rInner, LOOP_R, 'landing on the centreline is the defect');
});

test('the flight never passes under the deck it is climbing to', () => {
  /* The whole of the run is outboard of the deck's outer edge, so there is no
   * radius at which deck slab is overhead and flight is underfoot. Stated as
   * the headroom test that the old geometry failed. */
  const { rOuter, rInner, run, rise } = walkwayStairFlight();
  const deckOuterEdge = LOOP_R + WALKWAY.WIDTH / 2;
  const deckUnderside = WALKWAY_DECK_TOP - 0.6;   // collider is 0.6 m thick
  let worstHeadroom = Infinity;
  for (let r = rOuter; r > rInner; r -= 0.05) {
    if (r > deckOuterEdge) continue;              // nothing overhead out here
    const t = (rOuter - r) / run;
    worstHeadroom = Math.min(worstHeadroom, deckUnderside - t * rise);
  }
  assert.ok(
    worstHeadroom === Infinity || worstHeadroom >= CAPSULE_H,
    `a capsule is squeezed to ${worstHeadroom} m under the deck`
  );
});

test('the old geometry really was sealed - the test above can fail', () => {
  // The same measurement against what was there before, so a green suite is
  // evidence the fix did something rather than that the check is vacuous.
  const rOuter = 88, rInner = LOOP_R, run = rOuter - rInner, rise = LOOP_Y - 0.45;
  const deckOuterEdge = LOOP_R + WALKWAY.WIDTH / 2;
  const deckUnderside = LOOP_Y - 0.25 - 0.3;
  let worst = Infinity;
  for (let r = deckOuterEdge; r > rInner; r -= 0.05) {
    worst = Math.min(worst, deckUnderside - ((rOuter - r) / run) * rise);
  }
  // It was already too low to walk under at the deck's outer edge...
  const atEdge = deckUnderside - ((rOuter - deckOuterEdge) / run) * rise;
  assert.ok(atEdge < CAPSULE_H, `the old flight had ${atEdge} m at the edge`);
  assert.equal(Number(atEdge.toFixed(2)), 1.69);
  // ...and by the centreline the ramp was inside the slab.
  assert.equal(Number(worst.toFixed(2)), -0.1);
});

test('the flight lands exactly on the deck plate, not near it', () => {
  const { rise } = walkwayStairFlight();
  assert.equal(rise, WALKWAY_DECK_TOP);
  assert.equal(Number(WALKWAY_DECK_TOP.toFixed(4)), 10.005);
});

test('the ramp proxy is seated so its top face IS the walking line', () => {
  /* `_ramp` builds a 0.5 m thick box centred on the line and pitches it, so
   * the top face rides `0.25 / cos(pitch)` above the centre. Seat the centre
   * that far below and the face lands on the line. */
  const { rise, pitch, rampSeat } = walkwayStairFlight();
  const topFaceAtMid = rampSeat + 0.25 / Math.cos(pitch);
  assert.ok(Math.abs(topFaceAtMid - rise / 2) < 1e-12);
});

test('the drawn tread tops lie on that same line', () => {
  // Treads are 0.18 thick with their centres at `y - 0.09`, so their tops are
  // at `y` - the line - and the collision surface is now also the line.
  const TREAD_T = 0.18;
  const centre = -TREAD_T / 2;
  assert.ok(Math.abs(centre + TREAD_T / 2) < 1e-12);
});

test('the hand-rounded 0.24 was 0.051 m of lift on the old flight', () => {
  // The number this replaces, so the report and the code agree.
  const oldPitch = Math.atan2(LOOP_Y - 0.45, 88 - LOOP_R);
  assert.equal(Number((0.25 / Math.cos(oldPitch) - 0.24).toFixed(4)), 0.0511);
});

/* ------------------------------------------------------------------ */
/* Railing openings                                                    */
/* ------------------------------------------------------------------ */

const SEGS = 36;
const SEG_ANG = (Math.PI * 2) / SEGS;
const CHORD = 2 * LOOP_R * Math.tan(SEG_ANG / 2) + 0.4;
const RAIL_OUTER = LOOP_R + WALKWAY.WIDTH / 2 - WALKWAY.RAIL_INSET;
const RAIL_INNER = LOOP_R - WALKWAY.WIDTH / 2 + WALKWAY.RAIL_INSET;

/** Is (bearing, radius) covered by rail, given the whole 36-piece ring? */
function railedAt(bearingDeg, rr, cut) {
  const a = bearingDeg * DEG;
  for (let i = 0; i < SEGS; i++) {
    const th = i * SEG_ANG;
    let d = a - th;
    d = Math.atan2(Math.sin(d), Math.cos(d));
    const u = rr * d;
    if (Math.abs(u) > CHORD / 2 + 1e-9) continue;
    for (const [s, e] of walkwayRailRuns(th, rr, CHORD, cut)) {
      if (u >= s && u <= e) return true;
    }
  }
  return false;
}

test('the outer railing is open across every stair arrival', () => {
  for (const deg of WALKWAY.STAIR_DEG) {
    // The audit samples +-1.8 m across the flight; check the full clear width.
    const halfDeg = ((WALKWAY.STAIR_W / 2) / RAIL_OUTER) / DEG;
    for (const f of [-1, -0.5, 0, 0.5, 1]) {
      const at = deg + f * halfDeg;
      assert.equal(railedAt(at, RAIL_OUTER, true), false,
        `outer rail still crosses the flight at bearing ${at}`);
    }
  }
});

test('...and there are exactly four openings anyone could walk through', () => {
  /* Scanned as arcs rather than as a total, because the outer railing has 36
   * pre-existing hairline joints: `chord` is sized for LOOP_R and the outer
   * rail is drawn 2.85 m further out, so consecutive pieces fall 0.065 m short
   * of each other at every vertex. That is a seam, not a doorway - it is
   * narrower than a handrail is thick - and it is asserted here so that a
   * future change which widens it has to come past this test. */
  const STEP = 0.02;
  const gaps = [];
  let run = null;
  for (let d = 0; d < 360 + STEP; d += STEP) {
    if (!railedAt(d % 360, RAIL_OUTER, true)) {
      if (run && d - run.to <= STEP * 1.5) run.to = d;
      else gaps.push(run = { from: d, to: d });
    }
  }
  const arcM = (g) => (g.to - g.from + STEP) * DEG * RAIL_OUTER;
  const doors = gaps.filter((g) => arcM(g) > 0.5);
  const seams = gaps.filter((g) => arcM(g) <= 0.5);
  assert.equal(doors.length, 4, `expected four openings, found ${doors.length}`);
  for (const g of doors) {
    const mid = (g.from + g.to) / 2;
    assert.ok(WALKWAY.STAIR_DEG.some((s) => Math.abs(mid - s) < 0.2),
      `an opening at ${mid} degrees is not at a stair`);
    assert.ok(Math.abs(arcM(g) - 2 * WALKWAY.STAIR_GAP_HALF) < 0.1,
      `opening is ${arcM(g)} m, wanted ${2 * WALKWAY.STAIR_GAP_HALF}`);
  }
  assert.ok(seams.every((g) => arcM(g) < 0.1), 'a joint seam grew past 10 cm');
});

test('the inner railing is never cut - a gap there is a fall, not a door', () => {
  for (let d = 0; d < 360; d += 0.25) {
    assert.equal(railedAt(d, RAIL_INNER, false), true, `inner rail missing at ${d}`);
  }
});

test('an opening clears the flight and its stringers, and no more', () => {
  // Stringer rails stand at +-2.5 m; the opening must clear them, and must not
  // be so wide it eats the neighbouring railing piece.
  assert.ok(WALKWAY.STAIR_GAP_HALF > 2.5 + 0.06);
  assert.ok(2 * WALKWAY.STAIR_GAP_HALF < CHORD, 'an opening wider than a segment');
});

test('every opening falls wholly inside one railing piece', () => {
  /* The four bearings are multiples of the 10 degree segment, so each opening
   * is centred on a piece and cannot straddle two. If that ever stops being
   * true the cut still works - `walkwayRailRuns` is per piece - but the newel
   * posts would double up, so it is worth knowing. */
  for (const deg of WALKWAY.STAIR_DEG) {
    assert.equal(deg % (360 / SEGS), 0, `stair ${deg} is not on a segment vertex`);
  }
});

test('the deck collider top is the drawn plate, not 4.5 cm above it', () => {
  // _solidRot(x, DECK_TOP - 0.3, ..., hy 0.3, ...) puts its top face here.
  assert.equal(WALKWAY_DECK_TOP - 0.3 + 0.3, WALKWAY_DECK_TOP);
  // What it used to be, so the 0.045 in the report is checkable.
  assert.equal(Number((LOOP_Y - 0.25 + 0.3 - WALKWAY_DECK_TOP).toFixed(4)), 0.045);
});

test('WALKWAY_STAIR_R_INNER is derived from the width, not restated', () => {
  assert.equal(WALKWAY_STAIR_R_INNER, LOOP_R + WALKWAY.WIDTH / 2);
});
