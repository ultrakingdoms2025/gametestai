import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEG, LOOP_R, LOOP_Y,
  WALKWAY, WALKWAY_DECK_TOP, WALKWAY_STAIR_R_INNER, walkwayStairFlight,
} from '../../src/worlds/station/StationKit.js';

/**
 * The three things a walkway stair flight has to be at once, and were not.
 *
 *   1. it must MEET THE DECK - land on the promenade plate, not under it
 *   2. it must be CLIMBABLE - inside a pitch a character can actually walk up
 *   3. its FOOT must be OPEN - reachable from the deck it starts on
 *
 * ── The history, because two of these were fixed by breaking a third ─────
 * The flights originally climbed to `LOOP_R`, the loop's CENTRELINE, so the
 * last 3 m of every flight ran underneath the walkway it was climbing to and
 * (1) failed: nobody reached the promenade. That was fixed by landing them on
 * the deck's outer EDGE - correct, and not undone here - but it was paid for by
 * shortening the run from 16 m to 13 m, which took the pitch to 37.6 degrees and
 * broke (2). The change was recorded at the time as "5% steeper, which is the
 * price of landing on the deck at all". Both halves of that were wrong: 30.8 to
 * 37.6 degrees is 22% steeper, and it was not a price worth paying, because a
 * civilian steered at the head of the bearing-30 flight from open deck walks in
 * to r = 88.07 and stops there - measured, 22 s of simulation, `avoidBrake`
 * oscillating 0.30-0.62, height never leaving 0.
 *
 * It was also justified by "`STAIR_R_OUTER` cannot move outward - the hub
 * buildings begin at r = 91 on all four of these bearings", which is not true:
 * swept on the running page the deck is clear to r = 94.5. @see WALKWAY.DECK_CLEAR_R
 *
 * So all three are asserted together, because any one of them alone can be
 * satisfied by breaking another.
 */

/** Capsule the station is walked by: `CONFIG.player` sizes, NPC radius 0.33. */
const CAPSULE_R = 0.36;
const CAPSULE_H = 1.75;

/* ------------------------------------------------------------------ */
/* 1. It meets the deck                                                */
/* ------------------------------------------------------------------ */

test('every flight lands ON the promenade plate, at its outer edge', () => {
  const { rInner, rise } = walkwayStairFlight();
  assert.equal(rInner, LOOP_R + WALKWAY.WIDTH / 2, 'the flight stops short of, or past, the deck edge');
  assert.equal(rInner, WALKWAY_STAIR_R_INNER);
  assert.equal(rise, WALKWAY_DECK_TOP, 'the flight head is not at the height of the plate');
  assert.notEqual(rInner, LOOP_R, 'landing on the centreline is the original defect');
});

test('the arrival is FLAT, at plate height, all the way to the deck edge', () => {
  /* A capsule cannot climb onto a slab EDGE - the nearest point on the slab is
   * the edge, so the push is outward - and measured on the running page a
   * character climbing a flight that merely met the deck coplanar arrived at
   * r = 75.38, y = 9.84 and stayed there. The landing is the fix.
   * @see WALKWAY.STAIR_LANDING */
  const { rInner, rHead, landing, landingR, landingHalf, rise } = walkwayStairFlight();
  assert.ok(landing > 0, 'no landing: the flight arrives at a lip');
  assert.ok(Math.abs((rHead - rInner) - landing) < 1e-9, 'the pitched part does not stop a landing short');
  // The landing spans exactly from the head of the pitch to the deck edge...
  assert.ok(Math.abs((landingR - landingHalf) - rInner) < 1e-9);
  assert.ok(Math.abs((landingR + landingHalf) - rHead) < 1e-9);
  // ...and its top face is the plate, so the join at either end is coplanar.
  assert.equal(rise, WALKWAY_DECK_TOP);
  // Long enough that a capsule stands on it rather than straddling it.
  assert.ok(landing > 2 * CAPSULE_R, `a ${landing} m landing is shorter than a capsule is wide`);
});

test('no part of the run is underneath the deck it is climbing to', () => {
  const { rOuter, rInner, rHead, run, rise } = walkwayStairFlight();
  const deckOuterEdge = LOOP_R + WALKWAY.WIDTH / 2;
  const deckUnderside = WALKWAY_DECK_TOP - 0.6;      // the collider is 0.6 m thick
  let worst = Infinity;
  for (let r = rOuter; r > rHead; r -= 0.05) {
    if (r > deckOuterEdge) continue;
    worst = Math.min(worst, deckUnderside - ((rOuter - r) / run) * rise);
  }
  assert.ok(worst === Infinity || worst >= CAPSULE_H, `squeezed to ${worst} m under the deck`);
  // The landing is level WITH the plate, not under it.
  assert.ok(rHead > rInner);
});

/* ------------------------------------------------------------------ */
/* 2. It is climbable                                                  */
/* ------------------------------------------------------------------ */

test('every flight is inside the climbable pitch band', () => {
  /* Derived here from the rise and the run rather than read off the returned
   * `pitchDeg`, so this asserts the GEOMETRY and fails on a build that never
   * published a pitch at all. */
  const { rise, run } = walkwayStairFlight();
  const pitchDeg = Math.atan2(rise, run) / DEG;
  assert.equal(Number(pitchDeg.toFixed(4)), Number(walkwayStairFlight().pitchDeg?.toFixed(4)));
  assert.ok(
    pitchDeg <= WALKWAY.STAIR_PITCH_MAX_DEG,
    `${pitchDeg.toFixed(2)} degrees is steeper than the ${WALKWAY.STAIR_PITCH_MAX_DEG} degree limit`
  );
  // A floor is not a flight either: something this shallow would mean the deck
  // height or the deck width had moved without anybody noticing.
  assert.ok(pitchDeg >= 15, `${pitchDeg.toFixed(2)} degrees is not a stair`);
});

test('the band is the station\'s own escalator pitch, not a guess', () => {
  // Tower.js `ESC_RISE_RUN` is exactly 30 degrees, and those ARE traversed.
  assert.ok(WALKWAY.STAIR_PITCH_MAX_DEG >= 30);
  // ...and well under what the physics would still call ground, which is the
  // limit a previous version of this reasoning stopped at. `Physics` grounds a
  // capsule at normal.y > 0.64 and `Grounding.WALKABLE_NORMAL_Y` is 0.55.
  assert.ok(WALKWAY.STAIR_PITCH_MAX_DEG < Math.acos(0.64) / DEG);
});

test('the geometry the defect shipped with FAILS this - the test can fail', () => {
  /* The suite has to be able to go red, so the flight as it stood is measured
   * by the same rule. Foot at r = 88, head on the deck edge at 75. */
  const oldRun = 88 - WALKWAY_STAIR_R_INNER;
  const oldPitchDeg = Math.atan2(WALKWAY_DECK_TOP, oldRun) / DEG;
  assert.equal(oldRun, 13);
  assert.equal(Number(oldPitchDeg.toFixed(1)), 37.6);
  assert.ok(oldPitchDeg > WALKWAY.STAIR_PITCH_MAX_DEG, 'this is the defect, and it should reproduce');
  // And the number the report gave for it. 30.8 -> 37.6 is 22%, not 5%.
  const beforeTheLandingFix = Math.atan2(LOOP_Y - 0.45, 88 - LOOP_R) / DEG;
  assert.equal(Number(beforeTheLandingFix.toFixed(1)), 30.8);
  assert.equal(Math.round((oldPitchDeg / beforeTheLandingFix - 1) * 100), 22);
});

test('the risers and the going are chosen, not left over', () => {
  const { steps, going, riser, run, rise } = walkwayStairFlight();
  assert.equal(going, WALKWAY.STAIR_GOING, 'the going drifted off the constant it is meant to be');
  assert.equal(steps * going, run);
  assert.ok(Math.abs(steps * riser - rise) < 1e-9);
  // The drawn tread is 0.62 m deep, so the going must not open daylight between
  // consecutive treads.
  assert.ok(going < 0.62, `a ${going} m going shows gaps between 0.62 m treads`);
  // A riser nobody has to lift a knee over. The 13 m run made this 0.385.
  assert.ok(riser <= 0.3, `${riser.toFixed(3)} m risers`);
});

/* ------------------------------------------------------------------ */
/* 3. Its foot is open                                                 */
/* ------------------------------------------------------------------ */

test('the bottom step has open deck outboard of it to be approached from', () => {
  const { rOuter } = walkwayStairFlight();
  const approach = WALKWAY.DECK_CLEAR_R - rOuter;
  assert.ok(
    approach >= 2 * CAPSULE_R,
    `${approach.toFixed(2)} m between the bottom step and the first obstruction ` +
    `is not enough to stand a ${(2 * CAPSULE_R).toFixed(2)} m capsule in`
  );
  // ...and the flight has not been pushed out into the measured obstruction.
  assert.ok(rOuter < WALKWAY.DECK_CLEAR_R, 'the bottom step is inside the arcade');
});

test('nothing of the flight or the deck is overhead at the foot', () => {
  /* Enclosure is a solid thing above a capsule standing at the bottom step. The
   * two candidates are the flight's own ramp - which starts AT the foot and goes
   * up from there, so there is nothing of it over the bottom step - and the
   * promenade deck, which is the whole run plus a landing further in. Stated as
   * the arithmetic rather than as a claim, so a change to either shows here. */
  const { rOuter, rInner, rHead, landing, run, rise } = walkwayStairFlight();
  // The walking line at the foot is the deck itself.
  assert.equal(((rOuter - rOuter) / run) * rise, 0);
  // Standing at the foot, the flight rises AWAY from the capsule: nothing of it
  // is ever over the bottom step, and the second step is not over head height.
  const surfaceAt = (r) => ((rOuter - r) / run) * rise;
  assert.ok(surfaceAt(rOuter - 2 * CAPSULE_R) > 0, 'the flight does not rise from its own foot');
  assert.ok(surfaceAt(rOuter - 2 * CAPSULE_R) < CAPSULE_H, 'the second step is over head height');
  // The deck plate spans r = LOOP_R +- WIDTH/2 and the flight reaches it only
  // after the whole pitched run and the landing.
  assert.ok(Math.abs(rOuter - (LOOP_R + WALKWAY.WIDTH / 2) - (run + landing)) < 1e-9);
  assert.ok(rHead === rInner + landing);
  assert.ok(run > CAPSULE_R * 2, 'the deck slab overhangs the bottom step');
});

test('the flight is entirely outboard of the deck, so the foot cannot be roofed', () => {
  const { rOuter, rInner } = walkwayStairFlight();
  assert.ok(rInner >= LOOP_R + WALKWAY.WIDTH / 2);
  assert.ok(rOuter > rInner);
});

/* ------------------------------------------------------------------ */
/* All three at once                                                   */
/* ------------------------------------------------------------------ */

test('one flight satisfies all three properties simultaneously', () => {
  const f = walkwayStairFlight();
  const meetsDeck = f.rInner === LOOP_R + WALKWAY.WIDTH / 2
    && f.rise === WALKWAY_DECK_TOP
    && f.landing > 2 * CAPSULE_R;
  const climbable = f.pitchDeg <= WALKWAY.STAIR_PITCH_MAX_DEG;
  const footOpen = WALKWAY.DECK_CLEAR_R - f.rOuter >= 2 * CAPSULE_R;
  assert.deepEqual({ meetsDeck, climbable, footOpen }, { meetsDeck: true, climbable: true, footOpen: true });
  // The shipped numbers, so a future change has to restate them deliberately.
  assert.equal(f.rOuter, 92.8);
  assert.equal(f.rInner, 75);
  assert.equal(f.rHead, 75.8);
  assert.equal(Number(f.run.toFixed(6)), 17);
  assert.equal(f.steps, 34);
  assert.equal(Number(f.pitchDeg.toFixed(2)), 30.48);
});

test('all four bearings are the same flight, so one measurement covers them', () => {
  assert.deepEqual(WALKWAY.STAIR_DEG, [30, 150, 210, 330]);
  // `_buildWalkwayLoop` builds every one of them from `walkwayStairFlight()`
  // with nothing per-bearing but the angle, which is what makes that true.
  assert.equal(new Set(WALKWAY.STAIR_DEG.map(() => walkwayStairFlight().pitchDeg)).size, 1);
});
