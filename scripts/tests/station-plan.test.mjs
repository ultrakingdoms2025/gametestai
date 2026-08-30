import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { buildStation } from './world-kit.mjs';
import { StationPlan, ROLE } from '../../src/worlds/station/StationPlan.js';
import {
  gatewayClearances, ROAD_ANGLES_DEG, PLAZA_R, ROAD_R1, ROAD_EDGE_HALF,
} from '../../src/worlds/station/StationKit.js';

/**
 * THE STATION PLAN, IN SHADOW.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 *  WHAT IS BEING MEASURED, AND WHY IT IS NOT A DEFECT LIST
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * The plan says what the deck is FOR before anything is built on it, and then
 * this phase changes no placement at all. Every solid the world authors is
 * recorded against it and the conflicts are counted; nothing is moved.
 *
 * So the number below is the first answer the station has ever had to "how much
 * of me is standing on my own circulation?", and it is a MEASUREMENT of the
 * world as it is - not a list of things to fix. The conflicts fall into three
 * kinds and only the third is a defect:
 *
 *   deliberate   a gateway dais stands on its own approach corridor, because it
 *                is the destination; the plaza monument stands on the plaza.
 *   proposals    the sightline rule (24 m either side of a gateway bearing,
 *                r 44-100) exists today only inside the dressing scatter loop,
 *                where it was written to keep CRATES out of a portal approach.
 *                Seeding it as a role asks architecture to honour a rule
 *                written for scatter, and the habitat stacks clipping gateway
 *                150's corridor at bearing ~135 are that question being asked
 *                for the first time, not a regression.
 *   marginal     a tower corner reaching the edge of an avenue - one at r 154
 *                on bearing 129.7, about 26 m off the centreline of avenue 120
 *                against a road half-width of 9.9 plus a 16 m half-diagonal.
 *
 * Phase 4 decides each. Phase 3's job is that they can be counted at all.
 */

test('the plan is set out FIRST, and reads nothing it could not know yet', () => {
  const src = readFileSync(new URL('../../src/worlds/StationWorld.js', import.meta.url), 'utf8');

  /* Position is the whole property. A reservation model consulted by builders
   * has to be true for every builder, which is only possible from the front of
   * the build - and it can only BE at the front if it depends on nothing the
   * build produces. */
  const steps = [...src.matchAll(/await step\(([\d.]+), '([^']+)'/g)].map((m) => ({ f: Number(m[1]), label: m[2] }));
  assert.ok(steps.length > 5, 'could not read the build sequence');
  assert.equal(steps[0].label, 'Setting out the plan', `the plan is not the first build step; first is "${steps[0].label}"`);

  /* And it is pure arithmetic. `StationPlan` may not reach for physics, the
   * scene graph or a collider - if it ever does, "build it first" stops being
   * possible and the guarantee above is silently void. */
  /* Comments stripped first: this file's own docstring explains what
   * `_footprintClear` asks `physics.containsPoint`, and a check that read its
   * own prose would fail on the explanation of why it exists. */
  const plan = readFileSync(new URL('../../src/worlds/station/StationPlan.js', import.meta.url), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');
  for (const forbidden of ['physics', 'THREE', 'collider', 'this.group', 'traverse']) {
    assert.ok(!plan.includes(forbidden), `StationPlan reaches for \`${forbidden}\` - it can no longer be built before the world`);
  }
});

test('the seeded circulation agrees with the clearance maths the gateways were placed by', () => {
  /* `gatewayClearances` is the pinned counterfactual that chose the six gateway
   * bearings, and it measures against `avenueClearance`. The plan seeds its
   * carriageways from `ROAD_EDGE_HALF`, which is the width `avenueClearance`
   * itself uses - so if the two ever disagree about where a road is, the plan
   * is wrong and this says so rather than the world quietly drifting. */
  const clear = gatewayClearances();
  assert.ok(clear.avenue > 0, `the pinned gateway placement no longer clears the avenues: ${JSON.stringify(clear)}`);

  const plan = new StationPlan().seedCirculation();

  // A point on an avenue centreline, well outside the plaza, is carriageway.
  for (const deg of ROAD_ANGLES_DEG) {
    const t = (deg * Math.PI) / 180;
    const r = 120;
    assert.equal(plan.roleAt(Math.cos(t) * r, Math.sin(t) * r), ROLE.CARRIAGEWAY, `avenue ${deg} is not seeded at r=${r}`);
  }
  // The plaza centre is plaza, and a point beyond every role is unseeded.
  assert.equal(plan.roleAt(0, 0), ROLE.PLAZA);

  /* Somewhere genuinely unspoken for: bearing 30 at r = 180 is 90 m from the
   * centreline of both neighbouring avenues and past the r = 100 the gateway
   * corridors stop at. (Bearing 30 CLOSER in is a sightline - it is a gateway
   * bearing - which is why the obvious "just outside the plaza, between two
   * avenues" point is not the right probe and this note exists.) */
  const t30 = Math.PI / 6;
  assert.equal(plan.roleAt(Math.cos(t30) * 180, Math.sin(t30) * 180), null, 'this ground should carry no role');
});

test('marking is conservative and testing is true', () => {
  /* The two asymmetries carried over from `Gym.scope()`. A claim must never
   * under-state what it occupies (mark the axis-aligned bound of a rotated
   * rect), and a conflict must not be reported on a corner the rect never
   * really had (test the true rect). Getting these the same way round is what
   * makes the count trustworthy. */
  const plan = new StationPlan().seedCirculation();

  // A tall box squarely on avenue 0 conflicts.
  assert.equal(plan.claim(120, 0, 0, 4, 3, 3, 0, 'probe'), ROLE.CARRIAGEWAY);

  // Floor does not: a kerb on the same spot is something you walk on.
  const before = plan.conflicts.length;
  assert.equal(plan.claim(120, 0, 0, 0.2, 3, 3, 0, 'kerb'), null);
  assert.equal(plan.conflicts.length, before, 'floor should not be recorded as a conflict');

  // Neither does something overhead: a soffit 20 m up reserves no ground.
  assert.equal(plan.claim(120, 0, 19, 21, 3, 3, 0, 'soffit'), null);
});

/**
 * THE TWO WAYS A RASTER GETS THIS WRONG, PINNED AS ONE TEST.
 *
 * The plan used to quantise its corridors to 1.5 m cells and answer every
 * question by asking the grid, and there is no way to ask a 1.5 m grid a
 * sub-metre question that is not wrong in one direction or the other. Both
 * errors were measured on this station, and both are below:
 *
 *   ask whether the claim covers a CELL CENTRE, and a claim smaller than a
 *   cell slips between the centres. The hologram ad mast is 0.5 m square and
 *   was moved OFF one avenue and ONTO another by a sweep that got "clear"
 *   from the raster. Asked at 0.5, two of the six avenues reported no
 *   carriageway anywhere along their own centreline.
 *
 *   ask whether the claim covers a CELL EXTENT, and anything within a cell of
 *   the kerb is a conflict. That version was written, run and reverted: it
 *   took the carriageway count from 4 to 61, and 42 of the 57 it added were
 *   avenue lamp posts standing correctly.
 *
 * A lamp and a mast are 0.25 m and 0.5 m and the whole disagreement is between
 * them, which is why they are the probes. This test is the reason the corridors
 * are kept as shapes; if it ever goes green by being deleted, the reason went
 * with it.
 */
test('a lamp beside a kerb and a mast in a road get opposite answers', () => {
  const plan = new StationPlan().seedCirculation();
  const on = (r, across, h) => plan.roleUnder(r, across, h, h, 0, ROLE.CARRIAGEWAY);

  /* An avenue lamp: `ROAD_W / 2 + 1.6` = 10.6 across, 0.25 m half-extent, so
   * its inner face is at 10.35 against a kerb edge of 9.9. Clear by 0.45 m by
   * arithmetic that needs no instrument - and the cell holding the kerb sample
   * reaches 10.5, which is what made 42 of these read as conflicts. */
  assert.equal(on(120, 10.6, 0.25), null, 'a lamp 0.45 m clear of the kerb is being reported as standing in the road');

  // And a 0.5 m mast on the centreline is in the road, at every radius the
  // avenue is drawn along - not at whichever ones happen to hold a cell centre.
  for (let r = PLAZA_R + 6; r < ROAD_R1 - 2; r += 1.1) {
    assert.equal(on(r, 0, 0.5), ROLE.CARRIAGEWAY, `a 0.5 m mast on the centreline at r=${r.toFixed(1)} is not being seen`);
  }

  /* The kerb itself is the boundary, to the millimetre rather than to the
   * cell: `ROAD_EDGE_HALF` is the last painted metal, so a point-sized claim
   * just inside it is in and one just outside it is out. */
  assert.equal(on(120, ROAD_EDGE_HALF - 0.01, 0.001), ROLE.CARRIAGEWAY);
  assert.equal(on(120, ROAD_EDGE_HALF + 0.01, 0.001), null);
});

test('the station, measured against its own plan', async () => {
  const { world } = await buildStation();
  const s = world.plan.summary();

  console.log(`  ${s.regionsSeeded} corridors reserved, ${s.seededArea.toFixed(0)} m2; `
    + `${s.claims} solids recorded (${s.floorSkipped} floor, ${s.overheadSkipped} overhead)`);
  console.log(`  conflicts: ${s.conflicts} ${JSON.stringify(s.byRole)}`);

  /* Pinned as a measurement, with a band rather than an equality: the point is
   * that it cannot drift far unnoticed, not that 186 is a target. Phase 4 moves
   * it down deliberately and re-takes it; anything that moves it UP is a
   * builder newly standing on the circulation, which is what this exists to
   * catch. If it changes, say which builder and why in the commit.
   *
   * (An earlier draft of this file pinned 89, read off a `tail -18` of the
   * per-builder breakdown - the rows above the fold were never in the total.
   * Left here because it is the cheapest possible reminder that a number read
   * off a truncated console is not a measurement.) */
  /* THE DENOMINATOR IS NO LONGER A CELL COUNT, because the plan no longer has
   * cells to count. It kept a 1.5 m raster of its corridors and threw the
   * corridor shapes away; it now keeps the shapes, so the honest statement of
   * "how much circulation was laid down" is the area of the shapes.
   *
   * This is a better pin than the 17,560 cells it replaces, and not only
   * because it is exact. That number was a rasterisation, so it could only be
   * checked against another rasterisation - the previous note here had to
   * explain a 680-cell fall as "6 avenues x 12 m x 19.8 m over a 1.5 m grid".
   * Written as area it is the closed form of the layout constants themselves,
   * so `ROAD_R1` moving, or `ROAD_EDGE_HALF`, or the plaza radius, fails HERE
   * rather than in an arithmetic sentence somebody has to re-derive.
   *
   * Only the gateway corridor's own numbers are literals, because they are
   * private to `StationPlan` - 24 m either side, r = 44 to 100, the rule the
   * dressing scatter already applied by hand. */
  assert.equal(s.regionsSeeded, 13, 'the plan no longer reserves one plaza, six avenues and six gateway corridors');
  const expectArea = Math.PI * PLAZA_R * PLAZA_R
    + 6 * (ROAD_R1 - PLAZA_R) * (2 * ROAD_EDGE_HALF)
    + 6 * (100 - 44) * (2 * 24);
  assert.equal(+s.seededArea.toFixed(3), +expectArea.toFixed(3), 'the seeded circulation changed shape');
  /* 186 -> 733 on 2026-08-30. `_solid` began claiming into the plan, so the
   * plan finally sees the 1,530 axis-aligned solids it had never been told
   * about. The rise is in what is MEASURED, not in what is built: plaza
   * 77 -> 477, sightline 89 -> 226, carriageway 18 -> 30. A plaza conflict is
   * mostly a monument or a planter standing on its own plaza, which is what a
   * plaza is for; the carriageway count is the one that names defects, and it
   * has its own ratchet in station-plan-conflicts.test.mjs. */
  /* 693 -> 1,390 on 2026-08-30, and THE WORLD DID NOT MOVE. The plan stopped
   * rasterising its corridors to 1.5 m cells and started testing claims against
   * the corridor rectangles themselves, so roughly half of what stands on the
   * station's circulation had been invisible to this number: a claim smaller
   * than a cell could cover no cell centre, and a claim straddling a boundary
   * could cover none of the ones that carried the role.
   *
   * plaza 465 -> 1,017, sightline 224 -> 369, carriageway 4 -> 4. The plaza is
   * most of the rise and it is what a plaza is for - a monument, a planter and
   * a kiosk stand on it by design - and the sightline rise is the same kind of
   * thing one district out. The number that names defects is the carriageway
   * one, it has its own ratchet in station-plan-conflicts.test.mjs, and it is
   * the same 4 it was before: the sharper instrument found three more, all
   * three were real, and all three were fixed in this commit rather than
   * pinned. See that file for what they were.
   *
   * Anything that moves this UP is a builder newly standing on the
   * circulation. If it moves DOWN, re-take it and say what fixed it. */
  assert.ok(s.conflicts <= 1500, `${s.conflicts} conflicts, was 1,390 - something new is standing on the circulation`);
  assert.ok(s.conflicts >= 1250, `${s.conflicts} conflicts, was 1,390 - if this improved, re-take the number and say what fixed it`);

  /* The dome and the promenade loop must contribute nothing. Both cross the
   * circulation by design - the loop is 10 m up and spans every avenue - and
   * both did contribute, 33 and 21, until the ground band was applied. They are
   * the canary for that band: if either reappears, the band is broken and every
   * other number here is noise. */
  /* Re-taken 2 -> 8 on 2026-08-29, and NOT because the band broke.
   *
   * `_rectCovers` - the confirm step behind every conflict - tested the rect
   * MIRRORED, and correcting it moved four of the eight builder groups. The
   * dome went from 2 to 8: six of these were being hidden by the mirror, not
   * prevented by the band. Measured against a real three.js matrix inverse,
   * the old sign disagreed in 7,620 of 200,000 random cases and the new one in
   * none.
   *
   * The canary still works, and 8 is what it reads with a correct instrument.
   * The band is still doing its job - these eight are at r = 247, the outer
   * ring's link mouths where the road runs out at the hull, not the 33 and 21
   * the band was introduced to remove. Whether they are correct as built is
   * open; see station-plan-conflicts.test.mjs. */
  /* Re-taken 8 -> 12 on 2026-08-30, and TWO things are worth knowing.
   *
   * First, what the twelve are. `_solid` began claiming into the plan, and the
   * promenade loop's SUPPORT COLUMNS reach the ground - so they claim it, and
   * they land in gateway sightlines because the loop encircles at r = 72 and
   * crosses every avenue by design. All twelve sit at r = 71.9-72.0, which is
   * the column line to three significant figures. The band is intact: what it
   * exists to stop is the loop DECK ten metres up claiming ground, and that
   * was 21 conflicts when it happened. Twelve columns is not that.
   *
   * Second, and more useful: THE DOME HALF OF THIS CANARY HAS BEEN VACUOUS.
   * It reads 0 and has since the zone/link ownership increment re-scoped
   * world._planOwner, because the eight conflicts the note above describes
   * ("at r = 247, the outer ring's link mouths") are now owned by link:<id>
   * and no longer match /dome/. The regex was pinned against owner strings
   * that stopped existing, and the assertion kept passing on 0 <= 8. Those
   * eight are still measured - by owner, in station-plan-conflicts.test.mjs -
   * so nothing is unwatched, but this half of this canary is not what is
   * watching them. */
  const overhead = world.plan.conflicts.filter((c) => /dome|promenade/i.test(c.owner ?? ''));
  assert.ok(overhead.length <= 12, `overhead structure is claiming ground again: ${JSON.stringify(overhead.slice(0, 4))}`);
  assert.ok(
    overhead.every((c) => Math.hypot(c.x, c.z) > 60),
    'an overhead owner is claiming ground INSIDE the promenade ring - that is the deck, not a column, '
    + 'and it is what the ground band exists to prevent',
  );
});
