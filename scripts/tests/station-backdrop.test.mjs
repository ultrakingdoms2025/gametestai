import { test } from 'node:test';
import assert from 'node:assert/strict';

import { buildStation, THREE } from './world-kit.mjs';
import { collectParts, fractionInside, isMarking } from '../../src/dev/GeoParts.js';

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
 * ── 1,008 to ZERO, and the last one was a missing minus sign ─────────────
 *
 * The scored search took it to 3 - the observation promenade's balustrade,
 * inside `block:2`. That block was the only one of sixteen whose best
 * candidate anywhere still stood on the station, and the reason was an
 * asymmetric radial range: five steps outward and one step in. It had the
 * window sector on one side and the ring's neighbours on the other, and the
 * only way out was DOWN a radius. Adding -16, -24, -32 took the whole skyline
 * to zero occupancy at placement time and, as a side effect, brought two
 * other blocks back towards their authored bearings from 58 and 46 degrees
 * off to 6 and 10.
 *
 * So this is a PIN now, not a ratchet. It stays a useful gate because it is
 * the only one of the four that measures the real geometry of the real
 * intrusion - `station-skyline-clash.test.mjs`'s third test asks the search
 * what it decided, which is stronger, but this one would still catch a
 * district authored later underneath a block that was placed correctly.
 */

const CEILING = 0;

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
      /* PAINT ON THE DECK IS NOT SOMETHING A BLOCK SWALLOWS.
       *
       * `isMarking` is flat in Y only, which is the distinction that matters
       * here and the reason the sign gate uses the same test: a worn-smooth
       * deck patch under a backdrop block is hidden and harmless, while the
       * observation promenade's balustrade GLAZING is an upright plane and is
       * exactly the kind of thing this file was written to find. Both are
       * planes; only one of them is a surface the player meets.
       *
       * Added when two `polish` deck patches turned up under `block:1` after
       * an unrelated move - the gate had been counting floor decals since it
       * was written, and only noticed once the ceiling reached zero. */
      if (isMarking(o)) continue;
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
