import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { buildStation, THREE } from './world-kit.mjs';

/**
 * DOES THE CAMERA STAND SOMEWHERE IT CAN SEE FROM?
 *
 * ═══════════════════════════════════════════════════════════════════════════
 *  WHY A FRAMING IS WORTH GATING AT ALL
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `scripts/world-shot.mjs` is this project's evidence harness, and Phase 9's
 * method line is "never assess art by reading code - screenshot it". A framing
 * whose camera sits inside a wall does not fail; it returns a picture, and the
 * picture is of the inside of a wall, or of the near-clip plane cutting a slab
 * in half. That has already misled this work once: a "colossal moss rock
 * through the plaza" was reported from such a shot and turned out to be a
 * camera standing inside a planter, with the "hard cut face" being the near
 * plane. An unreadable shot is worse than a missing one, because somebody
 * writes a defect report from it.
 *
 * ── What the earlier count got wrong ─────────────────────────────────────
 * A note carried on the open list said "5 of 21 framings shoot from inside
 * geometry, `street-level` at 0.05 m". Measured here: **one**, and
 * `street-level` has 1.62 m of clearance. The five came from a probe that
 * pulled every `name:/pos:` pair out of the whole `VIEWS` object with a
 * regex - so it tested the medieval, sports and dock framings against the
 * STATION's physics, where a sports pool at (46, 7, 142) is of course inside
 * something. This file slices the `station:` array by bracket matching and
 * asserts its length, so it cannot quietly start measuring the wrong world.
 *
 * ── Station only, and why that is honest rather than lazy ────────────────
 * `world-kit` can build a station and a dock without a browser; the medieval,
 * citadel and race worlds need construction arguments it does not have. So
 * this gate covers the 21 framings it can actually stand a camera in, and says
 * so rather than implying coverage it does not have.
 */

/** Read the `station:` array out of `Harness.js` by matching brackets. */
function stationViews() {
  const src = readFileSync(new URL('../../src/dev/Harness.js', import.meta.url), 'utf8');
  const i = src.indexOf('  station: [');
  assert.ok(i > 0, 'Harness.js no longer has a `station:` view array');
  let depth = 0, end = src.indexOf('[', i);
  for (let k = end; k < src.length; k++) {
    if (src[k] === '[') depth++;
    else if (src[k] === ']' && --depth === 0) { end = k; break; }
  }
  const block = src.slice(i, end + 1);
  return [...block.matchAll(/name:\s*'([^']+)'[^}]*?pos:\s*\[\s*([-\d.]+)\s*,\s*([-\d.]+)\s*,\s*([-\d.]+)\s*\]/g)]
    .map((m) => ({ name: m[1], x: +m[2], y: +m[3], z: +m[4] }));
}

test('no station framing puts its camera inside the world', async () => {
  const { physics } = await buildStation();
  const views = stationViews();

  /* The denominator. A regex that stops matching returns an empty list and a
   * gate over nothing passes - which is the failure mode this whole file is
   * about, one level up. */
  assert.equal(views.length, 21, `parsed ${views.length} station framings, expected 21`);

  const p = new THREE.Vector3();
  const bad = [];
  for (const v of views) {
    const inside = physics.containsPoint(p.set(v.x, v.y, v.z));
    const floor = physics.groundHeight(v.x, v.z, v.y + 1, 60);
    const clear = floor === null ? Infinity : v.y - floor;
    if (inside) bad.push(`${v.name} is INSIDE solid geometry at (${v.x}, ${v.y}, ${v.z})`);
    // Sitting exactly on a surface is a near-plane shot of the floor.
    else if (clear < 0.4) bad.push(`${v.name} stands ${clear.toFixed(2)} m above its floor - the near plane will cut it`);
  }

  console.log(`  ${views.length} station framings, ${bad.length} unusable`);
  for (const b of bad) console.log(`    ${b}`);

  assert.deepEqual(bad, [], 'a framing shoots from somewhere it cannot see');
});
