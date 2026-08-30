import { test } from 'node:test';
import assert from 'node:assert/strict';

import { buildStation, THREE } from './world-kit.mjs';
import { collectParts } from '../../src/dev/GeoParts.js';

/**
 * A SIGN IS MOUNTED ON ITS POST, NOT THREADED THROUGH IT.
 *
 * `_signBoard` offsets each face by `thickness * 0.55` and defaults `thickness`
 * to 0.18 - the sign's own backer. That is right for a shopfront fascia and
 * wrong for anything mounted on a column: the three avenue-mouth pylons are
 * 2.0 m square, so the default put both faces 0.9 m INSIDE the post and the
 * column came up through the middle of the artwork. Photographed at
 * (118, 47): "DOCK 4 // ARRIVALS" cut in half lengthways, on all three.
 *
 * ── Why this test measures a distance and not an overlap ──────────────────
 *
 * The box overlap that FOUND the defect cannot confirm the fix. A sign face is
 * a rotated plane, so its axis-aligned bounding box overlaps the post's
 * whether or not the plane does, and the post's own AABB is 2.8 m across
 * because it is a 2.0 m square turned 37 degrees. Both numbers stay stubbornly
 * non-zero after a fix that is obviously correct in a screenshot.
 *
 * The clearance from the post's axis is exact: the post is square and
 * axis-symmetric about (ax, az), so a face centre further out than the post's
 * half-width is outside the post, whatever the yaw. 0.099 m before, 1.21 m
 * after, against a half-width of 1.0 m.
 */

/** The three avenue-mouth pylons, from `_buildDressing`. */
const PYLONS = [[70, 52], [118, 47], [62, -54]];
const POST_HALF = 1.0;        // boxGeo(2.0, 12.5, 2.0)

test('no pylon sign is threaded through its post', async () => {
  const { world } = await buildStation();
  const faces = collectParts(world.group)
    .filter((p) => p.mesh === 'dressing:signs' && !p.instanced);
  assert.ok(faces.length >= 12,
    `expected two two-sided signs on each of three pylons, found ${faces.length} faces`);

  const c = new THREE.Vector3();
  const buried = [];
  for (const f of faces) {
    f.box.getCenter(c);
    for (const [ax, az] of PYLONS) {
      const d = Math.hypot(c.x - ax, c.z - az);
      if (d > 6) continue;                     // not this pylon's sign
      if (d <= POST_HALF) {
        buried.push(`${f.mesh}#${f.index} (${f.piece}) sits ${d.toFixed(2)} m from the`
          + ` pylon axis at (${ax}, ${az}) - inside a post of half-width ${POST_HALF}`);
      }
    }
  }
  assert.deepEqual(buried, [], 'a sign face inside its own post is unreadable from either side');
});
