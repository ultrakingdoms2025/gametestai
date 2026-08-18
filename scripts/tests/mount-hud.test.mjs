import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HUD } from '../../src/ui/HUD.js';

/**
 * The mount boost meter must not claim boost is unavailable.
 *
 * Every mount's `boost01` is an EFFORT readout - Horse.js returns 1 only while
 * galloping and 0 otherwise, Car.js returns its damped `_boost` - and not one
 * of the six carries a reservoir. `_updateMount` used to read that number as a
 * fuel level, so a horse standing in the plaza reported 0, the bar went red and
 * the tag read RECHARGING. To a player that says "you have no boost, go and buy
 * a boost item", while Shift was in fact galloping the horse the whole time.
 *
 * Driven through the real `HUD.prototype._updateMount`: a full HUD cannot be
 * constructed headlessly, but the method touches nothing but the handful of
 * fields stubbed below, and the defect is a lie told in one string - exactly
 * the class of bug no screenshot review catches, because an empty red bar looks
 * like a correct empty red bar.
 */

/** The two elements and the panel `_updateMount` writes to, and nothing else. */
function stubHud(fields = {}) {
  const classes = new Set();
  const h = Object.create(HUD.prototype);
  h._mountId = 'horse';
  h._mounts = { active: null };
  h._boost = 1;
  h._boostWritten = -1;
  h._boostTagText = null;
  h._boostActive = false;
  h.boostFill = { style: {} };
  h.boostTag = {};
  h.mountPanel = {
    classList: {
      contains: (c) => classes.has(c),
      toggle: (c, on) => { if (on) classes.add(c); else classes.delete(c); },
    },
  };
  Object.assign(h, fields);
  h._classes = classes;
  return h;
}

test('a mount reporting boost01 = 0 reads BOOST, never RECHARGING', () => {
  const h = stubHud({ _mounts: { active: { boost01: 0 } } });
  h._updateMount(1 / 60);
  assert.equal(h.boostTag.textContent, 'BOOST');
  assert.ok(!h._classes.has('empty'), 'a parked mount must not paint the meter empty');
  // The bar still tells the truth about effort: nothing is being spent.
  assert.equal(h.boostFill.style.transform, 'scaleX(0.000)');
});

test('a mount reporting boost01 = 0 still reads BOOST after many idle steps', () => {
  // The old drain/recharge path only reached RECHARGING after a second or two,
  // so a single step would have passed even before the fix.
  const h = stubHud({ _mounts: { active: { boost01: 0 } } });
  for (let i = 0; i < 600; i++) h._updateMount(1 / 60);
  assert.equal(h.boostTag.textContent, 'BOOST');
  assert.ok(!h._classes.has('empty'));
});

test('a mount reporting effort reads BOOSTING while the rider holds Shift', () => {
  // Mid-gallop: effort 1, boost active. And at the start of one, effort still
  // ramping from 0 - the tag follows the rider, not the number.
  const h = stubHud({ _mounts: { active: { boost01: 1 } }, _boostActive: true });
  h._updateMount(1 / 60);
  assert.equal(h.boostTag.textContent, 'BOOSTING');
  assert.equal(h.boostFill.style.transform, 'scaleX(1.000)');

  const g = stubHud({ _mounts: { active: { boost01: 0 } }, _boostActive: true });
  g._updateMount(1 / 60);
  assert.equal(g.boostTag.textContent, 'BOOSTING');
  assert.ok(!g._classes.has('empty'));
});

test('a mount reporting nothing still drains and recharges a simulated reservoir', () => {
  // The meter is not a dead decoration for a mount with no readout at all.
  const h = stubHud({ _mounts: { active: {} }, _boostActive: true });
  for (let i = 0; i < 60 * 4; i++) h._updateMount(1 / 60);
  assert.ok(h._boost < 0.12, `simulated reservoir did not drain (${h._boost.toFixed(3)})`);
  assert.equal(h.boostTag.textContent, 'RECHARGING');
  assert.ok(h._classes.has('empty'), 'a drained simulated reservoir should paint the meter empty');

  h._boostActive = false;
  for (let i = 0; i < 60 * 4; i++) h._updateMount(1 / 60);
  assert.ok(h._boost > 0.12, `simulated reservoir did not recharge (${h._boost.toFixed(3)})`);
  assert.equal(h.boostTag.textContent, 'BOOST');
  assert.ok(!h._classes.has('empty'));
});

test('a mount that ever reports a real boostCharge reservoir keeps the empty state', () => {
  // No mount does today. The branch is kept so that the first one to grow a
  // genuine fuel tank gets an honest RECHARGING rather than inheriting the
  // effort rule that exists because effort is not fuel.
  const h = stubHud({ _mounts: { active: { boostCharge: 0.02 } } });
  h._updateMount(1 / 60);
  assert.equal(h.boostTag.textContent, 'RECHARGING');
  assert.ok(h._classes.has('empty'));

  h._mounts.active.boostCharge = 0.8;
  h._updateMount(1 / 60);
  assert.equal(h.boostTag.textContent, 'BOOST');
  assert.ok(!h._classes.has('empty'));
});

test('_updateMount does nothing at all when the player is not mounted', () => {
  const h = stubHud({ _mountId: null, _mounts: { active: { boost01: 0 } } });
  h._updateMount(1 / 60);
  assert.equal(h.boostTag.textContent, undefined);
  assert.equal(h.boostFill.style.transform, undefined);
});
