import { test } from 'node:test';
import assert from 'node:assert/strict';

import { buildStation, THREE } from './world-kit.mjs';
import { collectParts } from '../../src/dev/GeoParts.js';

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
 */

const CEILING = 2;

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

test('no new skyline block stands inside a building you can walk into', async () => {
  const { world, list } = await blocks();
  const c = new THREE.Vector3(), sz = new THREE.Vector3();
  const found = [];
  for (const b of list) {
    b.box.getCenter(c);
    b.box.getSize(sz);
    const blockR = Math.hypot(sz.x / 2, sz.z / 2);
    for (const f of world._selfCollided ?? []) {
      const gap = Math.hypot(f.x - c.x, f.z - c.z) - (blockR + Math.hypot(f.hw, f.hd));
      if (gap < 0) found.push(`${b.piece} overlaps a self-collided footprint by ${(-gap).toFixed(1)} m`);
    }
  }
  assert.ok(list.length >= 15, `expected the skyline's blocks to be labelled, got ${list.length}`);
  assert.ok(
    found.length <= CEILING,
    `${found.length} block/interior clashes, ceiling ${CEILING}. Lower the ceiling when you fix one.\n  `
    + found.join('\n  '),
  );
});

test('the skyline blocks do not stand inside each other', async () => {
  /* Zero, and it must stay zero. This is the assertion the first attempt at
   * fixing the interior clash FAILED - it moved blocks off buildings and into
   * one another, 17,598 m3 of overlap. Any future fix has to pass both. */
  const { list } = await blocks();
  const hits = [];
  for (let i = 0; i < list.length; i++) {
    for (let j = i + 1; j < list.length; j++) {
      const A = list[i].box, B = list[j].box;
      const ox = Math.min(A.max.x, B.max.x) - Math.max(A.min.x, B.min.x);
      const oy = Math.min(A.max.y, B.max.y) - Math.max(A.min.y, B.min.y);
      const oz = Math.min(A.max.z, B.max.z) - Math.max(A.min.z, B.min.z);
      if (ox > 0.1 && oy > 0.1 && oz > 0.1) {
        hits.push(`${list[i].piece} x ${list[j].piece}: ${(ox * oy * oz).toFixed(0)} m3`);
      }
    }
  }
  assert.deepEqual(hits, [], 'two backdrop blocks standing in each other read as one broken building');
});
