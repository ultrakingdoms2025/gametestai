import { test } from 'node:test';
import assert from 'node:assert/strict';

import { buildStation } from './world-kit.mjs';
import { ROAD_R1 } from '../../src/worlds/station/StationKit.js';

/**
 * WHAT STILL STANDS IN A ROAD — A RATCHET, NOT A CLEAN BILL.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 *  WHY THIS IS A CEILING AND NOT `=== 0`
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Phase 4's gate in the spec is "a headless count of props intersecting a
 * claimed carriageway or parcel: zero, where today it is not". Today it is
 * still not, and asserting zero would fail on arrival and be disabled within a
 * day - which is how a gate becomes decoration.
 *
 * So it is a ratchet. The number may fall and it may never rise. Each builder
 * converted to ask `StationPlan.roleUnder` before it places lowers the bound
 * in the same commit; anything that raises it is a new building in a road, and
 * that is exactly the defect the owner has now reported twice from inside the
 * game ("buildings that are placed halfway on roads/paths", and later "a large
 * multi storey building that goes halfway into the road", from 40.4,-77.2).
 *
 * ── What a conflict actually means here ──────────────────────────────────
 * `StationPlan.claim` tests the claim's TRUE rotated rectangle against the
 * corridor's true rotated rectangle, so a conflict is neither a bounding-box
 * artefact nor a grid one. The corridor is built from `ROAD_EDGE_HALF` = 9.9 m,
 * the 18 m carriageway plus its two 0.45 m kerb strips - so a conflict is
 * geometry standing on the road or its kerb, not merely near it, to the
 * millimetre rather than to the nearest 1.5 m.
 *
 * ── THE BLIND SPOT THIS GATE USED TO HAVE, AND HOW IT CLOSED ────────────
 *
 * Until 2026-08-30 the plan rasterised its corridors to 1.5 m cells at seeding
 * time and threw the corridor shapes away, so every question here was really a
 * question about a grid. That was wrong in two directions at once and this file
 * recorded both:
 *
 *   a hit was confirmed by asking whether the claim covered a CELL CENTRE, so
 *   a claim under `OCC_CELL / 2` = 0.75 m of half-extent could sit squarely in
 *   a road and slip between the centres. The 0.5 m hologram ad mast was moved
 *   OFF one avenue and ONTO another by a sweep that asked at the mast's own
 *   size and got the raster's answer. Every caller was under instruction to
 *   pad its query to at least 1.2, which is a rule that only makes sense if
 *   the instrument is wrong.
 *
 *   the obvious repair - testing the cell's EXTENT - was written, run and
 *   reverted, because it took this count from 4 to 61 and 42 of the 57 it
 *   added were avenue lamp posts standing correctly, each 0.45 m clear of a
 *   kerb whose cell reaches 0.6 m past it.
 *
 * The cell was never the road. It was a quantisation of the road to 1.5 m, and
 * both errors were that 1.5 m being asked a sub-metre question - so the fix was
 * to stop asking it. `StationPlan` keeps its corridors as a plaza disc and
 * twelve rotated strips, and `claim`, `roleUnder` and `roleAt` test against
 * those. `station-plan.test.mjs` pins the lamp and the mast getting opposite
 * answers, which is the whole disagreement in one test.
 *
 * ── WHAT THAT COST, AND WHY THE CEILING DID NOT MOVE ────────────────────
 *
 * The rewrite roughly doubled the plan's total conflict count (693 -> 1,390)
 * without a single thing in the world moving, and it found THREE more claims
 * standing in a carriageway that no instrument here had ever been able to see.
 * All three were real and all three were fixed in the same commit, so this
 * ceiling reads the same 4 it did the day before - but 4 now means "nothing
 * stands in a road", where before it meant "nothing bigger than a grid cell
 * stands in a road, unless it straddles a kerb".
 *
 * ── The by-owner list is the work list ───────────────────────────────────
 * It is asserted, not just printed, because the useful regression is not "the
 * total moved" but "a builder that was clean stopped being clean". The owner
 * string is the build step's own label, which is what makes the failure
 * message name the pass to go and look at.
 */

/**
 * Measured 2026-08-29, after the gateway flanks were nudged off the avenues
 * and the cargo straddle gantry's legs were moved outboard of the kerb.
 *
 * 20 -> 17 -> 16, and then UP to 18 - not because anything regressed, but
 * because the instrument was wrong. `StationPlan._rectCovers`, the confirm
 * step behind every conflict and every `roleUnder` query, tested the rect
 * MIRRORED. Corrected, it invented five conflicts that were never real and
 * hid seven that were. The count a broken instrument produces is not a
 * baseline, so this one is re-taken rather than defended.
 */
/* 18 -> 30 on 2026-08-30, and NOT because anything moved into a road.
 *
 * `_solid` - the hand-authored axis-aligned collider call - had never claimed
 * into the plan; only `_solidRot` did. The plan was therefore blind to 1,530
 * solids, and the twelve conflicts below were standing in avenues the whole
 * time with no instrument able to see them:
 *
 *    Stacking habitat blocks  9
 *    Stacking the cargo yard  2
 *    Scattering set dressing  1
 *
 * The other eighteen are unchanged and still break down exactly as before:
 * Gateway Plaza 3, commercial strip 4, dressing 3, and two per link across all
 * four links - the symmetric pattern each link makes where it meets a
 * carriageway at its mouth.
 *
 * Raising a ratchet is normally forbidden and it is being done here on the one
 * ground that permits it: the measurement got better, not the world worse. The
 * nine habitat claims are the largest single group and are the work to go and
 * do. Lower it when you fix one; never raise it for any other reason. */
/* 30 -> 21 on 2026-08-30, and this one is a FIX rather than a measurement
 * change. All nine "Stacking habitat blocks" claims were a single feature: a
 * ring of ten 1.5 m planters, each with its own collider, around the terrace
 * at r = 172 - and photographed, the cyan lane dashes and LOAD ZONE paint ran
 * straight through them. The terrace moved 24 m off the avenue centreline, so
 * it is now a garden beside the road rather than bollards in it. All ten
 * planters survive; refusing the occupied bearings would have left two. */
/* 21 -> 12 on 2026-08-30. Nine in four groups, and one of them was not a
 * placement defect at all.
 *
 * `Erecting Gateway Plaza` 3 and `Scattering set dressing` 1 were hand-authored
 * coordinates: three of the six dropped-freight pallets, and one of the eight
 * hologram ad masts, standing on an avenue's carriageway. Each moved the
 * shortest distance that `roleUnder` says clears - four metres for the pallets,
 * eight along its own bearing for the mast.
 *
 * `Stacking the cargo yard` 2 were pressure vessels. The pipe farm is a row of
 * six laid ACROSS a service road at offsets -50 -30 -10 10 30 50, and a 3.4 m
 * tank at +-10 reaches 6.6 m from the centreline of an 18 m road - the same
 * defect the straddle gantry above it was fixed for, in the same pass, four
 * lines apart. The row leaves the avenue a gap now, and the pipe runs between
 * the tanks are cut to the spans they actually cross.
 *
 * `dressing` 3 WERE PEOPLE. `_solidifyProps` sweeps every instanced mesh and
 * boxes anything at least 0.4 m on each axis that is standing on something,
 * and a crowd figure is - 202 of them had a static collider, three of those
 * standing in an avenue. The crowd ANIMATES, so every one of those boxes was a
 * phantom wall in a public concourse with nobody in it. Fixed at the sweep, by
 * a `movingInstances` flag the animator sets: the rule is "instances that move
 * cannot hold a static collider", which is a fact the thing that moves them
 * owns, and this sweep runs over every world.
 *
 * The twelve that remain are the two groups this file has always said are
 * design decisions rather than nudges - the promenade across the window
 * sector's axis, and the four link mouths. Lower it when one of those is
 * decided; never raise it. */
/* 12 -> 4 on 2026-08-30, and this one is an INSTRUMENT correction, which is
 * the second time this file has had to record one.
 *
 * The eight `link:*` conflicts were never real. Every avenue is SURFACED to
 * `DECK_R - 12` - twelve metres short of the deck rim, so the road stops before
 * the edge rather than running off it - and this plan seeded its carriageway
 * role all the way to `DECK_R`. The links cross the avenues exactly there, at
 * the rim, in twelve metres of road that has never existed.
 *
 * So the open design question this file recorded - "a link mouth is how a
 * player leaves the hub, so something has to cross the avenue there" - had a
 * measurement answer rather than a composition one: they do not cross a road.
 * A role claimed where nothing is built is not a conservative over-claim, it is
 * a false one, and it had been making four builders answer for a road nobody
 * laid. `ROAD_R1` is now one constant imported by the builder that draws the
 * surface and the plan that describes it, and `the plan's road ends where the
 * road ends` below pins the two together behaviourally so a re-derivation
 * cannot separate them again.
 *
 * The denominator moved with it - 18,240 seeded cells to 17,560 - which is the
 * check that this removed the right cells and not a swathe of the hub. */
/* 4 -> 7 -> 4 on 2026-08-30, in one commit, and the round trip is the point.
 *
 * `StationPlan` stopped rasterising its corridors and started testing claims
 * against the corridor rectangles themselves. That raised this count to 7
 * WITHOUT ANYTHING MOVING, which is the one ground on which a ratchet may rise:
 * the measurement got better, not the world worse. The three it found:
 *
 *    Erecting Gateway Plaza  2  parked apron freight at (24, +-62). A 2.42 m
 *      crate stack at 2.4 rad whose CENTRE is 10.2 m across avenue 60 - clear,
 *      if a box were a point - reaching 1.2 m past the kerb. It straddles the
 *      kerb without covering a cell centre, so the raster saw nothing. Moved
 *      2 m perpendicular to the avenue, to `[22.3, -13]`; 0.77 m clear at the
 *      worse of the two gateways.
 *    Stacking habitat blocks 1  the terrace garden's nearest planter,
 *      overhanging the kerb by NINETEEN MILLIMETRES. The note beside it
 *      claimed 36 m of clearance and had read the far side of the ring; the
 *      near planter sits at -12.07 and a 1.6 m axis-aligned box on a
 *      120-degree avenue reaches 2.19 m, not 1.6. The garden moved one more
 *      metre off the centreline: 0.98 m clear.
 *
 * Both were fixed rather than pinned, so the ceiling is back to 4 and the four
 * are the same four this file has photographed and left. Lower it when the
 * promenade is decided; never raise it for anything but a better instrument,
 * and say so here when you do. */
/* 4 -> 0 on 2026-09-01. The design decision this file has been waiting for got
 * made: the promenade's two avenue-0 segments are NOT BUILT. Both the raised
 * deck and its balustrade are skipped at any bearing where the segment's own
 * rotated footprint answers `roleUnder(..., 'carriageway')` - the same question
 * asked of the same shapes this gate asks - so the hub's own axis runs out to
 * the glass and the promenade wraps it in two arms. The centre telescope and
 * bench went with them; they are placed only where `onPromenade` says there is
 * deck, so a future re-plan cannot leave them floating either.
 *
 * That leaves NOTHING standing on a carriageway anywhere in the station, which
 * is where the spec's Phase 4 gate wanted to be. `=== 0` is now what the
 * ceiling means; keep it there. */
const CEILING = 0;

/**
 * Conflicts by the build step that caused them.
 *
 * TRACED, 2026-08-29, by monkey-patching `claim` to keep a stack whenever it
 * returns 'carriageway'. Then RE-TRACED after the mirror bug was fixed, which
 * moved four of the eight groups. The numbers below are the corrected ones.
 *
 * `link:*` 2 each, 8 in total - the outer ring's link mouths, one pair per
 *   link. These were reported as 2 by the mirrored `_rectCovers`, and then as
 *   8 under the single label `Spanning the great dome` once that was fixed.
 *   Scoping ownership to the zone and link builders resolved them into the
 *   pattern they actually are: EVERY link crosses a carriageway at its mouth,
 *   symmetrically, two claims each. That is a far more useful thing to know
 *   than "the dome has eight", and it is what the ownership increment bought.
 *   Whether it is correct as built is still open - a link mouth is how a
 *   player leaves the hub, so something has to cross the avenue there.
 *
 * `Opening the commercial strip` 4 - StationWorld.js:7378 and :7384, the
 *   window promenade's raised deck and its balustrade. NOT a misplaced
 *   building: the promenade is an arc from r = 158 to 190 spanning +-48
 *   degrees, bearing 0 is inside that arc, and every avenue including bearing
 *   0 is DRAWN as road out to `DECK_R - 12` = 188. So a player walking out
 *   avenue 0 meets a balustrade and a 2 m deck at r = 158. The fix is a design
 *   decision about the hero window sector - stop the avenue at the promenade,
 *   or open a gap on the axis - not a nudge.
 *
 * `Erecting Gateway Plaza` 3 - StationWorld.js:6028, at r = 41-42, where the
 *   plaza and the avenues meet.
 *
 * `dressing` 3 - StationWorld.js:3114, `_solidifyProps` boxing scattered
 *   props. One appeared the moment the skyline flank stopped occupying that
 *   patch of avenue: the scatter had always been willing to put a crate there
 *   and the building was what stopped it.
 *
 * GONE, and they were never real: `Stacking habitat blocks` 3, `Calibrating
 * Traffic Control` 1 and `Raising the pressure hull` 1 were all artefacts of
 * the mirrored rect. The habitat towers measure 4.70 m clear of the kerb.
 * Nudging them - which is what the previous list implied - would have moved
 * correct geometry to satisfy a broken instrument.
 *
 * `Stacking the cargo yard` and `Raising the outer skyline` are absent because
 * this session moved them, and both were real by simple arithmetic as well as
 * by the plan: gantry legs at 7 m across an 18 m road, and a skyline flank
 * five degrees off an avenue with 13 m of reach at 9.94 m of offset.
 */
/* The three entries below the fold are the newly VISIBLE ones, not new ones -
 * see the note on CEILING. Everything above them is byte-identical to the
 * split this file has pinned since the link ownership increment. */
const BY_OWNER = {};

test('nothing new stands in a carriageway', async () => {
  const { world } = await buildStation();
  const plan = world.plan;
  assert.ok(plan, 'the station no longer builds a plan - this gate cannot see anything');

  const road = plan.conflicts.filter((c) => c.role === 'carriageway');
  const byOwner = {};
  for (const c of road) byOwner[c.owner ?? '(unowned)'] = (byOwner[c.owner ?? '(unowned)'] ?? 0) + 1;

  console.log(`  ${road.length} claims stand on a carriageway or its kerb (ceiling ${CEILING})`);
  for (const [k, v] of Object.entries(byOwner).sort()) console.log(`    ${String(v).padStart(2)}  ${k}`);

  assert.ok(road.length <= CEILING,
    `${road.length} claims stand in a road, up from ${CEILING}. A builder started placing into an avenue - `
    + `the owner counts above name which. Lower the ceiling when you fix one; never raise it.`);

  assert.deepEqual(byOwner, BY_OWNER,
    'the per-builder split changed - a builder that was clean is no longer clean, or one you fixed is not in the list');
});

/**
 * THE PLAN'S ROAD ENDS WHERE THE ROAD ENDS.
 *
 * The two used to be written twice - `_buildDeck` surfaced the avenues to
 * `DECK_R - 12` and this plan seeded them to `DECK_R` - and twelve metres of
 * carriageway that nobody had ever laid were counted as road by every conflict
 * query in the file above. Eight of the twenty-one conflicts were geometry
 * crossing it.
 *
 * They share `ROAD_R1` now, so this is a behavioural pin rather than a second
 * copy of the number: carriageway just inside the end, none just outside it,
 * on every avenue. A re-derivation on either side fails here rather than
 * quietly inventing road again.
 */
test(`the plan's carriageway ends where the avenue surface ends`, async () => {
  const { world } = await buildStation();
  const plan = world.plan;
  for (const deg of world.roadAngles) {
    const t = (deg * Math.PI) / 180;
    /* 0.05, and the size is now part of what this test says.
     *
     * It was written at 0.5, failed, and was raised to 1.2 - because the old
     * raster reported a role only where the query covered a CELL CENTRE, so a
     * footprint under `OCC_CELL / 2` = 0.75 answered about the grid rather than
     * the road. At 0.5 it read avenues 0 and 180 as having no carriageway
     * ANYWHERE and the other four as a patchwork.
     *
     * A padded query is now a wrong query, and 5 cm proves the padding is gone:
     * this probe is smaller than a thirtieth of the cell it used to have to
     * hit. If a size floor ever comes back, this fails first. */
    const on = (r) => plan.roleUnder(Math.cos(t) * r, Math.sin(t) * r, 0.05, 0.05, 0, 'carriageway');
    assert.ok(on(ROAD_R1 - 4), `avenue ${deg} has no carriageway 4 m inside its own end`);
    assert.ok(!on(ROAD_R1 + 6), `avenue ${deg} claims carriageway 6 m PAST the surface it is drawn on`);
  }
});

test('the plan still sees the whole station, so a zero would mean something', async () => {
  const { world } = await buildStation();
  const s = world.plan.summary();

  /* The trap this exists for: if `claim` ever stopped being called - a
   * refactor that drops `_planOwner`, a builder that stops going through
   * `_solidRot` - every conflict count above would read zero and the gate
   * would pass by measuring nothing. That shape has cost this repository
   * real defects, so the denominator is pinned alongside the numerator. */
  console.log(`  ${s.claims} claims, ${s.regionsSeeded} corridors over ${s.seededArea.toFixed(0)} m2, ${s.conflicts} conflicts`);
  assert.ok(s.claims > 10000, `only ${s.claims} claims reached the plan - it is no longer seeing the build`);
  /* Was `cellsSeeded > 15000`. The plan keeps shapes rather than cells now, so
   * the denominator is their area - and the same trap it guards applies to the
   * new form: a `seedCirculation` that quietly stopped laying corridors would
   * take every count above to zero and pass this gate by measuring nothing. */
  assert.ok(s.regionsSeeded >= 13, `only ${s.regionsSeeded} corridors seeded - circulation is no longer being laid down`);
  assert.ok(s.seededArea > 30000, `only ${s.seededArea.toFixed(0)} m2 of circulation reserved - the corridors have shrunk`);
});
