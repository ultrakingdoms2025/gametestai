import { test } from 'node:test';
import assert from 'node:assert/strict';

import { buildStation, THREE } from './world-kit.mjs';

/**
 * THE STATION'S FIXED PEOPLE: ARE THEY STANDING ON ANYTHING?
 *
 * ═══════════════════════════════════════════════════════════════════════════
 *  WHAT THIS FILE IS, AND WHAT IT REPLACED
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * "Floating fixed people" was one of the reported defects, and the plan for it
 * (R2) was a build-time sweep that would settle every actor's FEET onto the
 * surface beneath them, with the authored y as a fallback.
 *
 * Measured first, and the plan did not survive the measurement. Probing all
 * 1,887 fixed actors against the built collision world - from the feet DOWN,
 * which matters: an earlier probe searched from two metres above the head and
 * found the tables people were sitting UNDER, reporting 333 "sunk" actors that
 * were nothing of the kind - the worst foot-height error on the station is
 * **0.21 m**, exactly one actor is off by more than 15 cm, and none is sunk.
 * The ambient crowd is the same: four of 135 off by more than 15 cm.
 *
 * A sweep that settles feet would therefore have moved almost nothing, passed
 * its own gate, and left the visible defect exactly where it was. That is this
 * repository's own named disease - a gate measuring something the game does not
 * do - and the plan for this phase had already warned about it in the abstract:
 * "R2 lands, looks like it works, and leaves floating exactly the visible ones."
 *
 * ═══════════════════════════════════════════════════════════════════════════
 *  WHERE THE FLOATING ACTUALLY IS
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Not in the feet. In the POSE. An actor set to `sit`, `eat` or `row` is drawn
 * with its hips at `seatFrom(amount)` above the floor it stands on - 0.45 m by
 * default, the bench height the zones are built around - and nothing has ever
 * checked that a bench is actually there. 172 of the 834 seated actors are
 * posed sitting on nothing: hips 45-68 cm up, with the highest drawn surface
 * beneath them at 6-8 cm, which is floor plating.
 *
 * All 172 are in the outer zones; the hub has none.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 *  WHY THIS IS A TEST AND NOT A BUILD STEP
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * The check is a raycast against drawn geometry, because that is the only thing
 * that answers the question a player is actually asking - "is that person
 * sitting on something I can see?" Physics cannot answer it: a galley bench may
 * be visible and uncollided, and seventeen of the first twenty-four suspects
 * probed were exactly that - drawn, but with no collider at seat height. Those
 * are a different and much smaller problem.
 *
 * It costs 5.1 s over 834 actors with no acceleration structure, which is fine
 * once in a suite and would not be fine in a build whose longest single frame
 * is already 3,175 ms. So it measures; the fix is authored per zone.
 */

/** Verbatim from `StationActors.seatFrom` - a pose is judged by the rule that draws it. */
const seatFrom = (amount) => (amount === 1 || !(amount > 0.05) ? 0.45 : amount);

/** `ACT_SIT`, `ACT_EAT`, `ACT_ROW` - the three activities drawn with the hips raised. */
const SEATED = new Set([2, 3, 5]);

const _down = new THREE.Vector3(0, -1, 0);

test('an actor is never more than a step above the floor it stands on', async () => {
  const { world, physics } = await buildStation();
  const A = world._actors;
  const n = A._pos.length / 3;

  /* From the feet DOWN. Probing from above the head finds whatever the actor is
   * standing UNDER - a table, a mezzanine, an arcade plate - and reports it as
   * the floor, which is how the first version of this measurement produced 333
   * imaginary defects. `Grounding.js` records the same trap at world scale: its
   * surface walk was capped at 10 and the hub deck is the eleventh entry down a
   * column, "which is the whole of the NPCs-on-the-station-ceiling defect". */
  let worst = 0, over15 = 0, missing = 0;
  for (let i = 0; i < n; i++) {
    const x = A._pos[i * 3], y = A._pos[i * 3 + 1], z = A._pos[i * 3 + 2];
    if (!Number.isFinite(x)) continue;
    const g = physics.groundHeight(x, z, y + 0.15, 4);
    if (g == null) { missing++; continue; }
    const d = Math.abs(y - g);
    if (d > worst) worst = d;
    if (d > 0.15) over15++;
  }

  console.log(`  ${n} actors: worst foot error ${worst.toFixed(2)} m, ${over15} over 15 cm, ${missing} with no floor within 4 m`);
  assert.equal(missing, 0, 'an actor has no floor beneath it at all');
  assert.ok(worst < 0.5, `an actor stands ${worst.toFixed(2)} m off its floor`);
  assert.ok(over15 <= 3, `${over15} actors are more than 15 cm off their floor, was 1`);
});

test('a seated actor has something drawn to sit on', async () => {
  const { world } = await buildStation();
  const A = world._actors;
  const n = A._pos.length / 3;
  world.group.updateMatrixWorld(true);

  const rc = new THREE.Raycaster();
  const onNothing = [];
  let seated = 0;

  for (let i = 0; i < n; i++) {
    if (!SEATED.has(A._act[i])) continue;
    seated++;
    const x = A._pos[i * 3], y = A._pos[i * 3 + 1], z = A._pos[i * 3 + 2];
    const seat = seatFrom(A._amount[i]);

    /* Cast from above the hips, far enough to reach the floor. A hit within
     * 22 cm of seat height is a seat: benches vary, and a stool that reads as
     * one to the eye is not going to be modelled to the centimetre. */
    rc.set(new THREE.Vector3(x, y + seat + 0.5, z), _down);
    rc.far = seat + 0.9;
    const sat = rc.intersectObject(world.group, true).some(
      (h) => h.object.visible && h.object.material && !h.object.material.transparent
        && Math.abs((h.point.y - y) - seat) < 0.22
    );
    if (!sat) onNothing.push({ x: Math.round(x), z: Math.round(z), seat: +seat.toFixed(2) });
  }

  console.log(`  ${seated} seated actors, ${onNothing.length} with nothing drawn at seat height`);
  console.log(`  e.g. ${JSON.stringify(onNothing.slice(0, 3))}`);

  /* Pinned as a MEASUREMENT with a band, the way the plan's conflict count is:
   * the number is the state of the world, not a target, and it exists so that
   * whichever way it is fixed - a bench under them, or the pose changed to
   * `stand` - the fix is measured rather than asserted. Anything that moves it
   * UP is a zone newly seating people on air.
   *
   * All 172 are in the outer zones. The hub has none, which is worth keeping
   * true on its own: it is the world every player starts in. */
  assert.ok(onNothing.length <= 180, `${onNothing.length} actors sit on nothing, was 172 - a zone is seating people on air`);

  const inHub = onNothing.filter((o) => Math.hypot(o.x, o.z) < 220);
  assert.deepEqual(inHub, [], 'the hub - the world every player starts in - now seats someone on nothing');
});
