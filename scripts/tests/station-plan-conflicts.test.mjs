import { test } from 'node:test';
import assert from 'node:assert/strict';

import { buildStation } from './world-kit.mjs';

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
 * `StationPlan.claim` rasterises the claim's axis-aligned bound but confirms a
 * hit with `_rectCovers`, the TRUE rotated rectangle, so a conflict is not a
 * bounding-box artefact. The corridor it tests against is seeded from
 * `ROAD_EDGE_HALF` = 9.9 m, which is the 18 m carriageway plus its two 0.45 m
 * kerb strips - so a conflict is geometry standing on the road or its kerb,
 * not merely near it.
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
const CEILING = 18;

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
const BY_OWNER = {
  'Erecting Gateway Plaza': 3,
  'Opening the commercial strip': 4,
  dressing: 3,
  'link:canteen': 2,
  'link:construction': 2,
  'link:gym': 2,
  'link:habitation': 2,
};

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

test('the plan still sees the whole station, so a zero would mean something', async () => {
  const { world } = await buildStation();
  const s = world.plan.summary();

  /* The trap this exists for: if `claim` ever stopped being called - a
   * refactor that drops `_planOwner`, a builder that stops going through
   * `_solidRot` - every conflict count above would read zero and the gate
   * would pass by measuring nothing. That shape has cost this repository
   * real defects, so the denominator is pinned alongside the numerator. */
  console.log(`  ${s.claims} claims, ${s.cellsSeeded} cells seeded, ${s.conflicts} conflicts`);
  assert.ok(s.claims > 10000, `only ${s.claims} claims reached the plan - it is no longer seeing the build`);
  assert.ok(s.cellsSeeded > 15000, `only ${s.cellsSeeded} cells seeded - circulation is no longer being laid down`);
});
