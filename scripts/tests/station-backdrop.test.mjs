import { test } from 'node:test';
import assert from 'node:assert/strict';

import { buildStation, THREE } from './world-kit.mjs';
import { collectParts, fractionInside } from '../../src/dev/GeoParts.js';

/**
 * NOTHING MAY BE INSIDE A BACKDROP BLOCK.
 *
 * The skyline is backdrop massing at r = 114-158. It exists so the gateways
 * never silhouette against void. It is not a place, it has no interior, and
 * nothing the player can reach should ever be inside one.
 *
 * That is why this rule is worth a gate when "is this prop inside that
 * building" is not: a building IS a set of overlapping boxes and needs
 * judgement about what should contain what, but a backdrop block should
 * contain NOTHING, and the rule has no legitimate exceptions.
 *
 * ── What it found ─────────────────────────────────────────────────────────
 *
 * 1,008 pieces, across 13 of the 16 blocks. `block:13` alone swallows 613 -
 * 502 of them "Stacking habitat blocks", which is an entire habitat tower
 * standing inside a piece of scenery.
 *
 * This is ONE root cause for several separately reported defects: "two
 * buildings half inside each other" at (-22.8, 147.4) is block:3 and its 168
 * habitat pieces; "crates through a building corner" at (26.5, -153.6) is
 * block:9 over the cargo yard; and the eight block/interior clashes that
 * `station-skyline-clash.test.mjs` ratchets are the same blocks again. The
 * `clash` guard in `_buildSkyline` was written to prevent exactly this and has
 * never been read.
 *
 * ── Why a ratchet ─────────────────────────────────────────────────────────
 *
 * Fixing it is a constraint solve over the whole ring, not a guard - folding
 * the test into the existing bearing sweep was measured and made things worse
 * (see `station-skyline-clash.test.mjs`). Until that is done this counts the
 * debt and stops it growing.
 */

const CEILING = 16;

test('the backdrop skyline does not stand on top of the station', async () => {
  const { world } = await buildStation();
  const all = collectParts(world.group);
  const size = new THREE.Vector3();

  const blocks = all.filter((p) => p.piece?.startsWith('block:') && p.tris >= 8);
  const others = all.filter((p) => !p.piece?.startsWith('block:'));
  assert.ok(blocks.length > 1000, `expected the skyline's pieces to be labelled, got ${blocks.length}`);

  const byBlock = new Map();
  let total = 0;
  for (const b of blocks) {
    for (const o of others) {
      if (!o.box.intersectsBox(b.box)) continue;
      o.box.getSize(size);
      /* Floors, hull rings and dome beams span districts; they are not things
       * a 25 m block can be said to swallow. */
      if (Math.max(size.x, size.z) > 30) continue;
      if (fractionInside(o, b) < 0.5) continue;
      total++;
      byBlock.set(b.piece, (byBlock.get(b.piece) ?? 0) + 1);
    }
  }

  const worst = [...byBlock].sort((a, b) => b[1] - a[1]).slice(0, 6)
    .map(([k, v]) => `${k} x${v}`).join(', ');
  assert.ok(total <= CEILING,
    `${total} pieces stand inside backdrop blocks, ceiling ${CEILING}. Worst: ${worst}.\n`
    + 'Lower the ceiling when you fix one. A rise means new geometry was authored under the skyline, '
    + 'or a block moved onto something.');
});
