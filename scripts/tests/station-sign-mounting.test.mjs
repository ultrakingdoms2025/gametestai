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

/* ─────────────────────────────────────────────────────────────────────────
 * AND THE SAME QUESTION, ASKED OF EVERY SIGN IN THE STATION, EXACTLY.
 * ───────────────────────────────────────────────────────────────────────── */

const { collectParts: parts2, fractionInside } = await import('../../src/dev/GeoParts.js');

/** Fraction of a face's sampled surface that must be inside to count. */
const BURIED = 0.15;
/** Exact buried faces today. Lower it when you clear one. */
const CEILING = 3;

test('no sign face is buried in the thing it is mounted on', async () => {
  /* THIS IS THE GATE THE IDENTITY WORK WAS FOR.
   *
   * The same sweep in bounding boxes returns 135 candidate pairs and cannot
   * say which are defects: a mount is usually a rotated wall panel, and a
   * rotated panel's box is bigger than the panel, so a correctly flush sign
   * reads exactly like a buried one. Sampling the face's actual surface
   * against the mount's actual triangles - which the GeoBatch spans made
   * possible - takes those 135 to 3, in about 40 ms.
   *
   * Measured across the pylon fix: 16 buried faces before, 3 after.
   *
   * The three that remain are real and named below rather than tuned away:
   *   dressing:signs#6    42%  the concourse sign clips the lit shopfront
   *                            glazing beside the pylon at (118, 47). Present
   *                            before the pylon fix at 50%, so it is that
   *                            sign's placement, not the mounting depth.
   *   plaza-props:signs#5 33%  and 17% in a second frond - a plaza sign
   *                            standing inside the foliage in front of it.
   */
  const { world } = await buildStation();
  const all = parts2(world.group);
  const size = new THREE.Vector3();
  const solids = all.filter((p) => {
    if (p.instanced || p.mesh.endsWith(':signs')) return false;
    p.box.getSize(size);
    /* Floors, hull rings and dome beams contain everything and are not what a
     * sign is mounted on. Four triangles is the minimum that can enclose a
     * volume, below which ray parity is meaningless. */
    return Math.max(size.x, size.z) <= 12 && size.y >= 0.5 && p.tris >= 4;
  });
  const faces = all.filter((p) => p.mesh.endsWith(':signs') && !p.instanced);
  assert.ok(faces.length > 150, `expected the station's sign faces, found ${faces.length}`);

  const buried = [];
  for (const f of faces) {
    for (const s of solids) {
      if (s.piece !== null && s.piece === f.piece) continue;   // its own housing
      if (!f.box.intersectsBox(s.box)) continue;
      const frac = fractionInside(f, s);
      if (frac > BURIED) {
        f.box.getCenter(size);
        buried.push(`${(frac * 100).toFixed(0)}% of ${f.mesh}#${f.index} (${f.piece}) is inside `
          + `${s.mesh}#${s.index} at ${size.x.toFixed(0)},${size.y.toFixed(1)},${size.z.toFixed(0)}`);
      }
    }
  }
  assert.ok(buried.length <= CEILING,
    `${buried.length} buried sign faces, ceiling ${CEILING}. Lower it when you clear one.\n  `
    + buried.join('\n  '));
});
