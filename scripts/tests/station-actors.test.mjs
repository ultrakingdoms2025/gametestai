import { test } from 'node:test';
import assert from 'node:assert/strict';

import { buildStation, THREE } from './world-kit.mjs';

/**
 * THE STATION'S FIXED PEOPLE: ARE THEY STANDING ON ANYTHING?
 *
 * ═══════════════════════════════════════════════════════════════════════════
 *  BOTH ANSWERS ARE YES, AND GETTING THERE TOOK TWO WRONG MEASUREMENTS
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * "Floating fixed people" was one of the reported defects, and the plan for it
 * (R2) was a build-time sweep settling every actor's FEET onto the surface
 * beneath them. Measured before writing it, and the plan did not survive:
 * across all 1,887 fixed actors the worst foot error is **0.21 m**, exactly one
 * is off by more than 15 cm, and none is sunk. The ambient crowd is the same,
 * four of 135 over 15 cm. A feet-settling sweep would have moved almost
 * nothing, passed its own gate, and left whatever the owner saw exactly where
 * it was. That part stands, and the first test below is what keeps it true.
 *
 * ── The first wrong measurement ───────────────────────────────────────────
 * A probe that searched from two metres ABOVE the head downward, which finds
 * the tables people are sitting under and calls them the floor: 333 imaginary
 * "sunk" actors, up to 1.98 m. `Grounding.js` records the same trap at world
 * scale - its surface walk was capped at 10 while the hub deck is the eleventh
 * entry down a column, "which is the whole of the NPCs-on-the-station-ceiling
 * defect". Probe from the feet.
 *
 * ── The second, which nearly changed the world ────────────────────────────
 * The next probe asked whether a SEATED actor has something drawn at hip
 * height, and reported 172 of 834 sitting on nothing. It was wrong, and the
 * bug was one number:
 *
 *     const SEATED = new Set([2, 3, 5]);   // "sit, eat, row"
 *
 * `ACT_ROW` is 7. **5 is `ACT_WALK`** (StationActors.js, the activity block).
 * So the probe raycast under 127 walking figures asking why there was no bench
 * at their hips, found floor plating, and called every pedestrian in the outer
 * zones a defect. The remedy that nearly shipped was a bench under each of
 * them - planks through walking animations, dropped across the ring corridor
 * and the radial spokes that Habitation's own header says are never built into.
 *
 * With the set corrected: **707 genuinely seated figures, none of them sitting
 * on nothing.** The zone authors had already put the furniture in, and every
 * `sit` site carries an explicit `amount` matching real geometry - 0.62 and
 * 0.68 on the hab bunks, 0.52 on the common-bay benches, 0.48 on the site
 * benches in the works.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 *  SO WHAT DID THE OWNER SEE?
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Not this. Both populations this file can reach are clean on both questions.
 * Whatever "floating fixed people" refers to is elsewhere - the mobile NPCs,
 * which are grounded by `src/npc/Grounding.js` and are not these actors; a
 * world other than the station; or something a downward raycast cannot see.
 * The next move is a playthrough with real key events, not a third raycast.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 *  WHY THE SEAT CHECK IS A TEST AND NOT A BUILD STEP
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * It raycasts DRAWN geometry, because that is the question a player is asking -
 * "is that person sitting on something I can see?" Physics cannot answer it: a
 * bench may be visible and uncollided, which is a different and much smaller
 * problem. It costs about 5 s with no acceleration structure, fine once in a
 * suite and not fine in a build whose longest single frame is already 3,175 ms.
 */

/** Verbatim from `StationActors.seatFrom` - a pose is judged by the rule that draws it. */
const seatFrom = (amount) => (amount === 1 || !(amount > 0.05) ? 0.45 : amount);

/**
 * `ACT_SIT` = 2, `ACT_EAT` = 3, `ACT_ROW` = 7 - the three activities `_pose`
 * routes to `_poseSit`/`_poseRow`, the only two that raise the hips off the
 * floor. NOT 5: that is `ACT_WALK`, whose hips are at walking height and which
 * ignores `amount` entirely. An earlier version of this set said {2, 3, 5} and
 * so asked why there was no bench under 127 pedestrians.
 */
const SEATED = new Set([2, 3, 7]);

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

  /* ZERO, not a band.
   *
   * The band this used to carry (`<= 180, was 172`) was measuring the
   * off-by-two described in the header, and once the set was corrected it would
   * have allowed 180 real regressions through while reading green. A gate whose
   * bound is inherited from a wrong measurement is worse than no gate: it looks
   * like coverage. Every seated figure in this station has furniture under it
   * today, so the honest assertion is that it stays that way. */
  assert.deepEqual(onNothing, [], `${onNothing.length} seated actors have nothing drawn at hip height`);

});
