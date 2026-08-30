import { test } from 'node:test';
import assert from 'node:assert/strict';

import { buildStation, THREE } from './world-kit.mjs';
import { collectParts, fractionInside } from '../../src/dev/GeoParts.js';

/**
 * THE SKYLINE'S BACKDROP BLOCKS, AND THE GUARD THAT WAS NEVER WIRED.
 *
 * `_buildSkyline` computes a `clash` flag - "backdrop may not stand in a
 * building you can walk into", under twenty-six lines of comment explaining
 * the defect it removes - and then never reads it. The drop it describes has
 * therefore never happened, and eight blocks stand inside interiors, one of
 * them 19.9 m in. That pair is what the owner reported as "two buildings half
 * inside each other", seen from (-22.8, 147.4).
 *
 * This file could not have been written before the blocks had identity. Every
 * mid-rise in the skyline shares one owner ("Raising the outer skyline"), so
 * until `_piece` labelled them per block, two blocks inside each other were
 * indistinguishable from one block's own walls - which is precisely why three
 * placement instruments found nothing here.
 *
 * ── Why a ratchet and not a zero ──────────────────────────────────────────
 *
 * Fixing it is not a one-line guard. Folding the test into the existing
 * bearing sweep was tried and MEASURED WORSE: interiors 8 -> 4, but the r=158
 * blocks then swept into the space the r=146 block needs, and block 2 ended up
 * 20.8 m inside block 14 - the same defect class, moved. The sweep also falls
 * back to the original bearing when nothing clears, silently keeping the
 * clash. Re-authoring backdrop placement properly is Phase 7 work with a
 * visible art consequence, so this pins the debt instead of pretending to
 * clear it: the count may fall, never rise.
 *
 * ── The third test is the one that can be trusted ────────────────────────
 *
 * The two above measure the AFTERMATH, and the aftermath of a placement is
 * the one thing that cannot be measured cleanly - by the time the world is
 * built, the block's own mass has claimed the ground it stands on, and both
 * of these fall back on bounding boxes to work around it. `_skylinePlacement`
 * records what the search saw while it still had a choice, which is the only
 * moment the question has an answer. That one is at ZERO.
 */

const CEILING = 1;

/** Every skyline block, as the union of the pieces it raised. */
async function blocks() {
  const { world } = await buildStation();
  const map = new Map();
  for (const p of collectParts(world.group)) {
    if (!p.piece?.startsWith('block:')) continue;
    let b = map.get(p.piece);
    if (!b) map.set(p.piece, (b = { piece: p.piece, box: new THREE.Box3() }));
    b.box.union(p.box);
  }
  return { world, list: [...map.values()] };
}

/**
 * ── RECTANGLES, NOT CIRCLES ──────────────────────────────────────────────
 *
 * This compared two CIRCUMSCRIBED CIRCLES, which is the coarsest instrument
 * in the file: a 28 m square block's circle reaches 19.8 m from its centre
 * where the block reaches 14, so it accuses everything in the corners it does
 * not occupy. Of the two it reported, `block:3` against the habitat keep-out
 * at (-98.5, 118.6) clears by separating axis with 0.9 m of circle overlap -
 * an artefact, the sixth of this pass. `block:13` against (-68.5, 66.7) is
 * real and remains: 4.9 m of genuine rectangle overlap with a habitat tower's
 * keep-out.
 *
 * The block's AABB is used as its rectangle, which is exact here because a
 * block's own faces are axis-aligned in the frame its yaw defines and the
 * keep-out carries its own. Ceiling 2 -> 1.
 */
test('no new skyline block stands inside a building you can walk into', async () => {
  const { world, list } = await blocks();
  const c = new THREE.Vector3(), sz = new THREE.Vector3();
  const found = [];
  for (const b of list) {
    b.box.getCenter(c);
    b.box.getSize(sz);
    const hw = sz.x / 2, hd = sz.z / 2;
    for (const f of world._selfCollided ?? []) {
      const dx = f.x - c.x, dz = f.z - c.z;
      const cb = Math.cos(f.yaw ?? 0), sb = Math.sin(f.yaw ?? 0);
      let clear = false;
      let least = Infinity;
      for (const [ux, uz] of [[1, 0], [0, 1], [cb, sb], [-sb, cb]]) {
        const ra = hw * Math.abs(ux) + hd * Math.abs(uz);
        const rb = f.hw * Math.abs(ux * cb + uz * sb) + f.hd * Math.abs(-ux * sb + uz * cb);
        const slack = Math.abs(dx * ux + dz * uz) - (ra + rb);
        if (slack > 0) { clear = true; break; }
        least = Math.min(least, -slack);
      }
      if (!clear) {
        found.push(`${b.piece} overlaps a self-collided footprint at `
          + `${f.x.toFixed(1)},${f.z.toFixed(1)} by ${least.toFixed(1)} m`);
      }
    }
  }
  assert.ok(list.length >= 15, `expected the skyline's blocks to be labelled, got ${list.length}`);
  assert.ok(
    found.length <= CEILING,
    `${found.length} block/interior clashes, ceiling ${CEILING}. Lower the ceiling when you fix one.\n  `
    + found.join('\n  '),
  );
});

/**
 * Zero, and it must stay zero. This is the assertion the first attempt at
 * fixing the interior clash FAILED - it moved blocks off buildings and into
 * one another, 17,598 m3 of overlap. Any future fix has to pass both.
 *
 * ── The bounding box pre-filters; the geometry decides ───────────────────
 *
 * This used to assert on the AABB overlap alone, and that reported two
 * "overlaps" the moment the blocks stopped being axis-aligned: block:1 x
 * block:2 at 783 m3 and block:10 x block:16 at 3,354 m3, at bearings of 39/27
 * and 325/329 degrees. Both are corners the boxes clip and the buildings do
 * not - measured exactly, ZERO of 300 block:1 pieces are inside block:2 and
 * zero of 367 the other way, from 78 candidate box pairs; zero of 364 and
 * zero of 353 for the second, from 238. Fifth false positive of this pass
 * from a box standing in for a rotated thing, and it would have blocked the
 * fix that cleared 1,008 backdrop intrusions.
 *
 * The box is kept as the pre-filter it is good at, and `fractionInside`
 * answers. The defect this file was written for survives that unharmed: a
 * block 20.8 m inside another has hundreds of pieces inside it, not corners.
 */
test('the skyline blocks do not stand inside each other', async () => {
  const { world } = await blocks();
  const byBlock = new Map();
  for (const p of collectParts(world.group)) {
    if (!p.piece?.startsWith('block:') || p.tris < 8) continue;
    let a = byBlock.get(p.piece);
    if (!a) byBlock.set(p.piece, (a = []));
    a.push(p);
  }
  const names = [...byBlock.keys()];
  assert.ok(names.length >= 15, `expected the skyline's blocks to be labelled, got ${names.length}`);

  const hits = [];
  for (let i = 0; i < names.length; i++) {
    for (let j = 0; j < names.length; j++) {
      if (i === j) continue;
      let n = 0;
      for (const p of byBlock.get(names[i])) {
        for (const q of byBlock.get(names[j])) {
          if (!p.box.intersectsBox(q.box)) continue;
          if (fractionInside(p, q) >= 0.5) { n++; break; }
        }
      }
      if (n) hits.push(`${n} pieces of ${names[i]} stand inside ${names[j]}`);
    }
  }
  assert.deepEqual(hits, [], 'two backdrop blocks standing in each other read as one broken building');
});

/**
 * EVERY BLOCK WAS PLACED ON GROUND THE SEARCH KNEW WAS CLEAR.
 *
 * The strongest of the three, because it is the only one asked at a moment
 * when the answer is not already contaminated: `occupancyUnder` over a
 * finished block's footprint returns 1.000 whatever happened, since the block
 * itself, the canopy above it and the dressing around it have all claimed
 * that ground since. `_buildSkyline` records what it saw while choosing.
 *
 * This replaces a record that had no reader - the old `_skylineUnplaced` kept
 * only `score >= 100` and nothing ever looked at it, which is the same shape
 * as the `clash` flag this method computed for twenty-six lines and never
 * consulted. The one block that could not find clean ground scored 87.3 and
 * so was not even recorded.
 */
test('every skyline block was placed on ground the search knew was clear', async () => {
  const { world } = await blocks();
  const recs = world._skylinePlacement ?? [];
  assert.ok(recs.length >= 15, `expected a placement record per block, got ${recs.length}`);
  const bad = recs.filter((r) => r.road || r.occ > 0 || r.clash)
    .map((r) => `block:${r.piece} at ${r.deg} deg (authored ${r.authored}, dr ${r.dr}): `
      + `road=${r.road} occupancy=${r.occ.toFixed(3)} clash=${r.clash}`);
  assert.deepEqual(bad, [], 'a backdrop block was placed on the station');
});
