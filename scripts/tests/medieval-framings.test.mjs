import { test } from 'node:test';
import assert from 'node:assert/strict';

import { medievalHeight } from '../../src/worlds/terrain/MedievalHeight.js';

/**
 * IS THE VALE'S CAMERA ABOVE THE GROUND?
 *
 * ═══════════════════════════════════════════════════════════════════════════
 *  WHY THIS FILE EXISTS
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * The Phase 9 art pass for this world photographed all seven of its authored
 * framings and one of them - `village-street` - came back as a flat beige
 * field with tree canopies hanging in it. The camera was at y = 2.2 and
 * `medievalHeight(20, 40)` is 4.58: it had been standing two and a third
 * metres inside the hill, looking at the back of the terrain. `village-square`
 * was not underground but sat 0.6 m over it, which is a worm's-eye view of a
 * market square.
 *
 * Nothing noticed, because nothing asked. `harness-framings.test.mjs` asks
 * whether a framing LOOKS AT anything - a ray down the view axis meeting a
 * collider - and a camera buried in terrain passes that trivially: it is
 * looking at a great deal of terrain. What no gate asked was whether the eye
 * was somewhere a person could stand.
 *
 * That is the failure shape this repository has paid for repeatedly and which
 * `world-06` recorded nine times over: **a gate that measures something the
 * game does not do is worse than no gate.** A screenshot harness whose framing
 * is inside the ground does not produce a bad picture, it produces a confident
 * wrong one, in a set of pictures that all look equally real.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 *  WHAT IT ASSERTS, AND WHY IT IS THE HEIGHT FUNCTION AND NOT A BUILD
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `medievalHeight` is the pure function the world's terrain, its road net, its
 * settlement placement and its wildlife planner are all built from - it is
 * imported by nine files under `src/worlds/medieval/` and by
 * `MedievalWorld._height`. Asserting against it rather than against a built
 * world is not a shortcut: it is the same number the terrain mesh is generated
 * from, and it costs no world build, so this gate runs in `npm test` on every
 * push rather than only when somebody remembers to open a browser.
 *
 * Two clearances, and both are set by what the framing is FOR:
 *
 *   - Every framing must clear the ground by at least `MIN_CLEARANCE`. Under
 *     that a camera is either inside the terrain or lying on it, and neither
 *     photographs the world.
 *   - The look TARGET must also clear it. A camera at eye height aimed at a
 *     point under the hill is pointed into the hill, which is half of what was
 *     wrong with `village-street`: the position and the target were both bad
 *     and fixing only one would have produced a different wrong picture.
 *
 * The vista framings are deliberately not capped from above. `hills-vista` is
 * 29 m over the valley floor and is supposed to be.
 */

/**
 * Minimum metres between a framing's eye and the ground under it.
 *
 * 1.2, not 1.62. The player's eye height is 1.62 m and a street framing should
 * be about there, but a framing is allowed to be a crouch, a doorway or a
 * step, and a gate that pinned the exact eye height would be asserting a
 * composition choice rather than a defect. 1.2 m is the line below which a
 * camera is no longer standing anywhere - it is the number that separates
 * "the author chose a low angle" from "the author did not know where the
 * ground was".
 */
const MIN_CLEARANCE = 1.2;

const domHarness = () => {
  /* `Harness.js` reaches for `window` at module scope to install its error
   * hooks. Nothing here drives a browser, so the two globals it needs are
   * stubbed and torn down rather than importing a whole DOM. */
  if (typeof globalThis.window === 'undefined') {
    globalThis.window = { addEventListener() {}, removeEventListener() {} };
  }
  if (typeof globalThis.document === 'undefined') {
    globalThis.document = { getElementById: () => null, querySelector: () => null };
  }
};

domHarness();
const { VIEWS } = await import('../../src/dev/Harness.js');

const MEDIEVAL = VIEWS.medieval;

test('the vale has framings at all', () => {
  assert.ok(Array.isArray(MEDIEVAL) && MEDIEVAL.length >= 7,
    'VIEWS.medieval is missing or has shrunk - the art pass photographs these');
});

for (const v of MEDIEVAL) {
  test(`${v.name}: the eye is above the ground it stands on`, () => {
    const ground = medievalHeight(v.pos[0], v.pos[2]);
    const clearance = v.pos[1] - ground;
    assert.ok(
      clearance >= MIN_CLEARANCE,
      `${v.name} eye is at y=${v.pos[1]} and the terrain at (${v.pos[0]}, ${v.pos[2]}) is `
      + `${ground.toFixed(2)} - a clearance of ${clearance.toFixed(2)} m. `
      + (clearance < 0
        ? 'The camera is INSIDE the terrain and photographs the underside of it.'
        : `Under ${MIN_CLEARANCE} m nothing is standing there.`)
    );
  });

  test(`${v.name}: the framing does not point into the hill`, () => {
    const ground = medievalHeight(v.look[0], v.look[2]);
    assert.ok(
      v.look[1] >= ground - 0.5,
      `${v.name} looks at y=${v.look[1]} where the terrain at (${v.look[0]}, ${v.look[2]}) is `
      + `${ground.toFixed(2)} - the target is ${(ground - v.look[1]).toFixed(2)} m underground, `
      + 'so the framing is aimed into the terrain rather than across it'
    );
  });
}

test('the two street framings are at something like eye height', () => {
  /* The specific regression, named. These two are the ones that broke, they
   * are the ones a player walks, and "above ground" alone would let one drift
   * back to a knee-height 0.6 m clearance and still pass the gate above. */
  for (const name of ['village-square', 'village-street']) {
    const v = MEDIEVAL.find((x) => x.name === name);
    assert.ok(v, `${name} has gone from VIEWS.medieval`);
    const clearance = v.pos[1] - medievalHeight(v.pos[0], v.pos[2]);
    assert.ok(clearance > 1.3 && clearance < 2.4,
      `${name} stands ${clearance.toFixed(2)} m off the ground - a street framing is a person's eye, `
      + 'not a crouch and not a drone');
  }
});
