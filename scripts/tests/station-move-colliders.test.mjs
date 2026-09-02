import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildStation, THREE } from './world-kit.mjs';
import { MapOverlay } from '../../src/systems/MapOverlay.js';

/**
 * WHAT A MOVE WOULD DRAG, PINNED PER NAME.
 *
 * Phase 7's per-release gate asks that "a move of the largest name reports a
 * `colliders` count within one chunk of the previous release". Nothing measured
 * it. `station-overlay-e2e.test.mjs:165` deliberately refuses to - "pinning a
 * number here would pin the world rather than the applier" - which is right for
 * that file and leaves the world side unpinned by anything.
 *
 * This is the world side. For every catalogue name it records what
 * `_moveColliders` WOULD take, without taking it, and diffs the whole table
 * against a fixture. Re-take with:
 *
 *     STATION_MOVE_COLLIDERS_UPDATE=1 node --test scripts/tests/station-move-colliders.test.mjs
 *
 * ── Why an exact table and not a tolerance ────────────────────────────────
 *
 * "Within one chunk" has no meaning on this side: chunks are how structure
 * collision is packed, and what a move drags is a count of collider objects.
 * A table diff says exactly which names changed and by how much, which is what
 * a release note needs; a tolerance would let a name drift every release until
 * it had doubled. The catalogue pin next door works the same way and for the
 * same reason.
 *
 * ── The three outcomes, and the one that is a defect ──────────────────────
 *
 *   n >= 0   the count the applier would move.
 *   -1       refused: nothing owns the name, the geometric guess exceeded the
 *            cap, and the move reports `span`. Nothing moves, the admin is
 *            told. This is a safe outcome and a stable one worth pinning.
 *
 * A name going from a number to -1 means an object that could be dragged no
 * longer can. A name going from -1 to a number means a district-scale drag
 * became possible. Both are release-note material; neither is caught by
 * anything else.
 *
 * ── Re-taken 2026-08-30: two nudges, three names, one collider each ──────
 *
 *   gateway-medieval:plaza    38 -> 37
 *   gateway-medieval:emAmber  90 -> 89
 *   habitat:emGreen           16 -> 15
 *
 * `StationPlan` stopped rasterising its corridors and found three claims
 * standing in a carriageway that the raster could not see. Fixing them moved
 * two pieces of geometry, and this table is where that shows up as drag:
 *
 *   the gateway approach's parked freight moved 2 m perpendicular to avenue 60
 *   (mirrored to 300), which takes one collider out of each of the two
 *   gateway-medieval drag sets it was sitting in;
 *   the habitat terrace's planter ring went 12 m to 11 m, taking one lit
 *   sphere out of the `habitat:emGreen` set.
 *
 * Three names, one collider each, and no name crossed the -1 boundary - which
 * is the outcome this table exists to distinguish a real change from.
 *
 * -- 2026-09-02: three names crossed, and crossed back the same day ------
 *
 *   plaza-props:glassWindow   200 -> -1 -> 200
 *   commercial:emAmber        195 -> -1 -> 195
 *   commercial:panel          184 -> -1 -> 184
 *
 * Kept in the ledger because a name losing its drag is the outcome this file
 * exists to notice, and because the round trip is the evidence for the claim
 * the fixture now makes: the fixture is byte-for-byte the pre-chamfer one
 * again, all 756 rows, so nothing about this system was traded away to get
 * those three back.
 *
 * The cause was never in this system. `StationKit.boxGeo` learned to chamfer
 * boxes at or over a metre in every axis, `StationWorld._solidifyStructure`
 * derives collision from the DRAWN geometry, and the station's collision
 * therefore went 8,763 -> 11,203 chunks and 26,757 -> 29,197 colliders. More
 * collider centres fall inside any given name's bounds, so the geometric guess
 * counted higher for 207 names; three of them were already sitting at 92-100%
 * of the cap (200, 195, 184) and the extra tipped them over.
 *
 * A LOWER CHAMFER WAS NOT THE FIX, and that was measured rather than assumed:
 * at a 1.6 m threshold the table churn halves to 104 names and half the
 * chamfer is lost, and all three still crossed. The fix was to stop colliding
 * the chamfer at all - a chamfer only ever cuts material away from a box's
 * corners, so the square box it came from is a conservative collider for it,
 * and `_collisionSoup` now substitutes that box for the piece's 108 triangles
 * (`StationKit.squareBoxCorners`). Collision is back at 8,763 chunks and
 * 26,757 colliders with the chamfer still drawn, and all 207 counts here
 * followed it back.
 *
 * `MAX_MOVE_COLLIDERS` is therefore still untouched, and the decision it was
 * waiting on is still open rather than answered: it is a deliberate safety
 * envelope for an admin tool - a box holding thousands of collider centres is
 * a district, not a prop - and these three names sit at 92-100% of it on a
 * world nobody chamfered. The next thing that adds collision anywhere near
 * them will take them out again.
 *
 * -- 2026-09-02: 27 names FELL, and all 27 are the same 48 colliders ------
 *
 *   gateway-<six>:trim         16 -> 8      (-8 each, six gateways)
 *   gateway-<six>:plaza        25/42/19/26/38/21 -> -2 each
 *   gateway-<six>:em<accent>   127/92/81/87/89/83 -> -8 each
 *   gateway-<four>:emGate_*    32 -> 31     (-1, the four that carry one)
 *   gateway-<four>:emDim       35/34/35/34 -> -2 each
 *   skyline:emAmber            71 -> 69     (-2)
 *
 * A FALL IS THE OUTCOME THIS FILE WARNS ABOUT - "a wall may be left behind" -
 * so it is worth being exact about what happened, because it is NOT that
 * colliders were removed from around these names.
 *
 * `GATEWAY.TRIM_PROUD` went 0.06 -> 0.005, sinking each approach nosing into
 * the tread box that already collides it, so `_collisionSoup` finds those 266
 * triangles already inside a box and drops them from the soup. The chunker
 * then REPACKS the six gateway neighbourhoods around the hole. Diffed collider
 * by collider between the two builds: 93 chunk boxes gone, 45 new ones in
 * their place, net -48. Every one of the 138 sits between radius 38.5 and
 * 59.2 m and within nine degrees of one of the six gateway bearings; nothing
 * anywhere else on the world changed. Totals 8,763 -> 8,715 chunks and
 * 26,757 -> 26,709 colliders, both pinned in `station-catalogue.test.mjs`.
 *
 * That repack is why the falls are not confined to `trim`. A chunk is a bag of
 * neighbouring triangles, so re-bagging the flight also re-bags the dais and
 * arch geometry standing over it - the vanished boxes run from y 1.02 to 8.59,
 * well above the 2.46 m flight - and any name whose bounds enclose that volume
 * counts the difference. `em<accent>` bounds a whole gateway and sees the full
 * 8; `plaza` and `emDim` bound part of the flight and see 2; an `emGate_*`
 * sees 1; `skyline:emAmber`, a batch whose bounds span the world, catches 2 in
 * passing. `trim` halving, 16 -> 8, is the least alarming of the 27: its box
 * is small and tight around the flight, so 8 was most of what was in it.
 *
 * NO WALL IS LEFT BEHIND. The tread boxes are untouched and are still what a
 * body walks on; what moved is which chunk owns the triangles above them. The
 * walking surface at the foot of every flight went from 0.46 m to 0.40 m,
 * which is the entire point of the change - at 0.46 the step probe refused it
 * on all six bearings - and it is measured on the collision pin next door.
 *
 * No name crossed the -1 boundary in either direction, which is the outcome
 * this table exists to distinguish a real change from.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.join(HERE, 'fixtures', 'station-move-colliders.json');
const UPDATE = process.env.STATION_MOVE_COLLIDERS_UPDATE === '1';

/** Mirrors `_moveColliders`' own cap. Kept local so a change there shows up. */
const CAP = 200;

test('what a move would drag has not changed for any name', async () => {
  const { world, physics } = await buildStation();
  const overlay = new MapOverlay({ physics });
  const box = new THREE.Box3();

  /* Walk the scene rather than the catalogue fixture, so this file does not
   * silently measure whatever the other pin happens to hold. */
  const seen = new Set();
  const now = {};
  world.group.traverse((o) => {
    if (!o.name || seen.has(o.name)) return;
    seen.add(o.name);
    o.updateWorldMatrix(true, false);
    box.setFromObject(o);
    if (box.isEmpty()) return;

    const owned = overlay._collidersOwnedBy(o.name);
    if (owned) { now[o.name] = owned.length; return; }

    /* The geometric guess, replicated rather than called: `_moveColliders`
     * MUTATES what it claims, so the only branch safe to invoke here is the
     * refusal. Everything else is counted the way the applier counts it. */
    let n = 0;
    for (const c of physics.colliders) {
      if (!c || c.type === 'heightfield') continue;
      if (box.containsPoint(c.center)) n++;
      if (n > CAP) break;
    }
    now[o.name] = n > CAP ? -1 : n;
  });

  const count = Object.keys(now).length;
  const owned = Object.values(now).filter((n) => n > 0).length;
  const refused = Object.values(now).filter((n) => n === -1).length;
  console.log(`  ${count} named nodes; ${owned} would move colliders, ${refused} would refuse with span`);

  if (UPDATE || !existsSync(FIXTURE)) {
    writeFileSync(FIXTURE, JSON.stringify(now, null, 1) + '\n');
    console.log(`  WROTE ${path.relative(process.cwd(), FIXTURE)} with ${count} names`);
    if (!UPDATE) assert.fail('fixture did not exist and has been written - re-run to assert against it');
    return;
  }

  const was = JSON.parse(readFileSync(FIXTURE, 'utf8'));
  const changed = [];
  for (const [name, n] of Object.entries(now)) {
    if (!(name in was)) { changed.push(`MINTED  ${name} would move ${n}`); continue; }
    if (was[name] !== n) changed.push(`${name}: ${was[name]} -> ${n}`);
  }
  for (const name of Object.keys(was)) {
    if (!(name in now)) changed.push(`RETIRED ${name} (was ${was[name]})`);
  }
  for (const c of changed) console.log(`  ${c}`);

  assert.deepEqual(changed, [],
    `${changed.length} name(s) changed what a move would drag. A rise means one click now carries more `
    + 'collision than it did; a fall means a wall may be left behind. If intended, re-take the fixture '
    + 'with STATION_MOVE_COLLIDERS_UPDATE=1 and list the deltas in the commit.');
});
