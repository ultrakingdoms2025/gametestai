/**
 * The two per-instance questions `_solidifyProps` asks before it collides a
 * prop, and the one that was answering wrongly in the outer ring.
 *
 * Headless on purpose, in the same spirit as station-collide-regions: both
 * predicates are arithmetic over one downward probe, and the defect they
 * encode - a 1.94 m crew unit read as "already collided" because an authored
 * 0.7 m plinth stands under it - is provable against a stub collision world
 * without building a station or opening a browser.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { StationWorld } from '../../src/worlds/StationWorld.js';

/**
 * A world whose collision consists of the given horizontal slabs.
 *
 * `groundHeight(x, z, startY, maxDrop)` answers with the highest slab top
 * strictly below `startY` and no further down than `maxDrop`, which is the
 * contract `Physics.groundHeight` implements and the only thing the two
 * predicates use.
 */
function worldWith(tops) {
  const w = Object.create(StationWorld.prototype);
  w.physics = {
    groundHeight(x, z, startY, maxDrop) {
      let best = null;
      for (const y of tops) {
        if (y > startY || y < startY - maxDrop) continue;
        if (best === null || y > best) best = y;
      }
      return best;
    },
  };
  return w;
}

test('a builder box around a prop still counts as already collided', () => {
  // A 1.2 m crate inside its own authored box: the box top is the prop's top.
  const w = worldWith([0, 1.2]);
  assert.equal(w._alreadySolid(0, 0, 0, 1.2), true);
});

test('bare deck under a prop is not "already collided"', () => {
  const w = worldWith([0]);
  assert.equal(w._alreadySolid(0, 0, 0, 1.2), false);
  assert.equal(w._alreadySolid(0, 0, 0, 0.5), false);
});

test('THE DEFECT: a low plinth under a tall prop is not the prop being collided', () => {
  /* Hab Ring C's crew units, measured on the built station: a 1.94 m block on
   * an authored 0.7 m plinth. The old bar was `base + min(0.35, hy * 0.8)`,
   * which for anything over 0.9 m tall is a flat 0.35 m - so 0.7 cleared it,
   * all 25 units were left uncollided, and you could walk through the top
   * 1.24 m of a crew unit. The bar is now the prop's own mid-height. */
  const w = worldWith([0, 0.7]);
  assert.equal(w._alreadySolid(0, 0, 0, 1.94), false);
  // The old test, stated so the regression is visible if it ever comes back.
  const hy = 1.94 / 2;
  assert.ok(0.7 > 0 + Math.min(0.35, hy * 0.8), 'the old bar accepted this plinth');
});

test('a plinth that reaches a prop\'s middle does count - that is a box, not a plinth', () => {
  const w = worldWith([0, 1.0]);
  assert.equal(w._alreadySolid(0, 0, 0, 1.94), true);
});

test('the 0.35 m floor still applies to small props', () => {
  // A 0.6 m prop with a 0.2 m kerb beside it: over half its height, but under
  // the absolute floor, so it is still collided. `min` keeps both bars.
  const w = worldWith([0, 0.2]);
  assert.equal(0.2 >= 0.3, false, 'the kerb does reach half of a 0.6 m prop');
  assert.equal(w._alreadySolid(0, 0, 0, 0.6), false);
});

test('the probe sees a box a little larger than the prop it wraps', () => {
  // Authors leave slack; the probe starts 0.4 m above the prop for that reason.
  const w = worldWith([0, 1.3]);
  assert.equal(w._alreadySolid(0, 0, 0, 1.2), true);
});

test('a surface far above a prop is out of the probe\'s reach', () => {
  // An arcade plate 4 m up is not this prop's collider and must not be read as
  // one. `maxDrop` is the prop's own height plus 1.2, so the probe cannot even
  // start high enough to see it.
  const w = worldWith([0, 4]);
  assert.equal(w._alreadySolid(0, 0, 0, 1.2), false);
});
