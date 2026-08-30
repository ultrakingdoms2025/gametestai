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
 * is off by more than 15 cm, and none is sunk. The ambient crowd is the same -
 * 204 figures, worst 0.134 m, NONE over 15 cm (an earlier note here said "four
 * of 135", and a later one "five over 25 cm, worst +1.26 m"; both were
 * measurements taken before the third test below existed, and neither
 * reproduces). A feet-settling sweep would have moved almost
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
 * Not this. All three populations this file reaches are clean on every question
 * it asks. This note used to end "whatever 'floating fixed people' refers to is
 * elsewhere - the mobile NPCs... the next move is a playthrough with real key
 * events, not a third raycast", and that turned out to be exactly right.
 *
 * ANSWERED, 2026-08-29. The owner played it and reported "npc that are part in
 * the ground, feet can not be seen". It was the mobile cast: five spawns and
 * twelve patrol waypoints resolved to a point INSIDE solid geometry - a
 * building shell, a walkway slab, a cargo container, a platform, and a lamp
 * post. `NPCManager._snapToGround` promised a spawn was placed "so nothing ever
 * spawns embedded in geometry", and `Grounding.resolveSpot` under it searched
 * outward when a column had no floor but never when the floor it found was
 * inside something. See `station-npc-grounding.test.mjs`, which is the gate for
 * that population and the fourth this station now carries.
 *
 * The lesson is the one this whole file is about: the defect was never in the
 * population that was easy to measure.
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


/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  AND THE THIRD POPULATION, WHICH THIS FILE USED TO LEAVE OUT
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * The station draws people three different ways and only two of them were
 * gated here: `StationActors`' 1,887 fixed figures, and - until now - not the
 * ambient plaza crowd `_buildCrowd` scatters. A note carried in this file for
 * a while said five of those 204 stood more than 25 cm off their floor, worst
 * +1.26 m at (-19.5, -7.5). Re-measured on 2026-08-29 with the probe below:
 * **worst 0.134 m, none over 15 cm, none with no floor at all.** The five were
 * a measurement, not a defect - almost certainly the probe-from-above-the-head
 * trap the header of this file already describes costing 333 imaginary sunk
 * actors. Probe from the feet.
 *
 * ── Identifying the crowd is the fragile part, so it is asserted ──────────
 * The crowd's meshes carry no name and `StationActors`' eleven do, and both
 * draw on `mat.crowd` - so "unnamed instanced meshes on that material" is the
 * only handle there is. That is exactly the kind of discriminator that stops
 * matching after a refactor and leaves a gate measuring an empty set, so the
 * mesh count and the figure count are pinned next to the result. A version of
 * this probe that filtered on the material alone collected 17,258 "figures"
 * with a suspiciously uniform 1.7 m error, because it had swept up
 * `StationActors:head` and friends - whose instance origin is a head, not a
 * pair of feet.
 */
test('the ambient plaza crowd stands on the floor too', async () => {
  const { world, physics } = await buildStation();
  world.group.updateMatrixWorld(true);

  const meshes = [];
  world.group.traverse((o) => {
    if (o.isInstancedMesh && o.material === world.mat.crowd && !o.name) meshes.push(o);
  });

  const m4 = new THREE.Matrix4();
  const p = new THREE.Vector3();
  const figures = [];
  for (const o of meshes) {
    for (let i = 0; i < o.count; i++) {
      o.getMatrixAt(i, m4);
      figures.push(p.setFromMatrixPosition(m4).applyMatrix4(o.matrixWorld).clone());
    }
  }

  /* The denominator, before the numerator. `_crowdBodyGeo` puts the feet at
   * `FOOT_Y` = 0.04, so an instance's translation IS its feet - but only for
   * these meshes, which is why finding the right ones is asserted first. */
  assert.equal(meshes.length, 4, 'the crowd is no longer four unnamed meshes - this probe is selecting the wrong set');
  assert.equal(figures.length, 204, 'the crowd population changed');

  let worst = 0, over15 = 0, missing = 0;
  for (const f of figures) {
    const g = physics.groundHeight(f.x, f.z, f.y + 0.15, 6);
    if (g === null) { missing++; continue; }
    const d = Math.abs(f.y - g);
    if (d > worst) worst = d;
    if (d > 0.15) over15++;
  }

  console.log(`  ${figures.length} crowd figures: worst foot error ${worst.toFixed(3)} m, ${over15} over 15 cm, ${missing} with no floor`);
  assert.equal(missing, 0, 'a crowd figure has no floor beneath it at all');
  assert.equal(over15, 0, `${over15} crowd figures are more than 15 cm off their floor`);
  assert.ok(worst < 0.25, `a crowd figure stands ${worst.toFixed(2)} m off its floor`);
});
