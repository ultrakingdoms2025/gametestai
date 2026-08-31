import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { MountManager } from '../../src/mounts/MountManager.js';
import { Car } from '../../src/mounts/Car.js';
import { MapOverlay } from '../../src/systems/MapOverlay.js';
import { fittingSwitch, statLine } from '../../src/ui/MountMenuLogic.js';

/**
 * A purchased mount fitting can be switched OFF and back ON, and switching it
 * off may never cost the player the tier they paid for.
 *
 * The trap this file exists to hold shut is the obvious implementation: write
 * the tier down to 0 in `_powers` and put it back later. `_powers` is the
 * OWNERSHIP ledger, and `MapOverlay._ownsGrant` reads it as "this placed pickup
 * has already been collected". A mount that reads as un-owned while switched
 * off makes every placed upgrade for it respawn on the next world build, which
 * turns a UI convenience into an unlimited item source. So the tier is
 * untouched, a second record carries the switch, and the last test in this file
 * is the one that would fail if anyone ever merges the two.
 *
 * The other half is "off" meaning STOCK rather than merely smaller: every
 * `applyPowers` in the tree is `1 + tier * k` over a field that starts at 1, so
 * the effective tier has to be exactly 0 and not, say, tier - 1.
 */

const matCache = new Map();
const materials = {
  has: () => true,
  get: (k) => { if (!matCache.has(k)) matCache.set(k, new THREE.MeshStandardMaterial()); return matCache.get(k); },
  register: (k, m) => matCache.set(k, m),
  tinted: (k) => materials.get(k),
};

/** A manager over stubs, plus the bus traffic it produced. Mirrors mount-liveries.test.mjs. */
function manager() {
  const emitted = [];
  const bus = { on() {}, off() {}, emit: (n, p) => emitted.push([n, p]) };
  const mgr = new MountManager({
    scene: new THREE.Scene(),
    engine: null,
    physics: { groundHeight: () => 0, resolveCapsule: (p) => p, sphereCast: () => null, raycast: () => null, colliders: [] },
    bus,
    materials,
    camera: null,
    player: { position: new THREE.Vector3(), stamina: null },
    cameraRig: null,
    avatar: null,
    npcManager: null,
    worldManager: null,
  });
  const powerEvents = () => emitted.filter(([n]) => n === 'mount:powers').map(([, p]) => p);
  return { mgr, emitted, powerEvents };
}

/**
 * Put a live mount in the manager's map without going through `prebuild`,
 * which also parks roots in the scene and compiles materials. `_applyPowers`
 * only ever reaches a mount through `this._mounts.get(id)`, so this is the
 * whole of what a "the mount is live right now" test needs.
 */
function live(mgr, id, mount) {
  mgr._mounts.set(id, mount);
  return mount;
}

/** A mount that records the tiers `_applyPowers` hands it, and nothing else. */
function spyMount() {
  const seen = [];
  return { seen, applyPowers: (t) => seen.push({ ...t }), last: () => seen[seen.length - 1] };
}

/* ================================================================= state == */

test('switching a fitting off leaves the owned tier exactly where it was', () => {
  const { mgr } = manager();
  mgr.grantPower('car', 'power', 3);
  mgr.grantPower('car', 'strength', 1);

  assert.equal(mgr.setPowerEnabled('car', 'power', false), true);
  assert.deepEqual(mgr.getPowers('car'), { power: 3, strength: 1 },
    'getPowers must keep reporting OWNERSHIP - a switch is not a refund');
  assert.equal(mgr.isPowerEnabled('car', 'power'), false);
  assert.equal(mgr.isPowerEnabled('car', 'strength'), true, 'the switch is per fitting, not a master');

  assert.equal(mgr.setPowerEnabled('car', 'power', true), true);
  assert.deepEqual(mgr.getPowers('car'), { power: 3, strength: 1 }, 'the exact tier comes back');
  assert.equal(mgr.isPowerEnabled('car', 'power'), true);
  assert.deepEqual(mgr.getDisabledPowers('car'), {}, 'and the off-record is emptied, not left as {power:false}');
});

test('a switch that changes nothing is a no-op: no re-apply, no mount:powers', () => {
  const { mgr, powerEvents } = manager();
  mgr.grantPower('car', 'power', 2);
  const spy = live(mgr, 'car', spyMount());
  const before = powerEvents().length;
  const applied = spy.seen.length;

  assert.equal(mgr.setPowerEnabled('car', 'power', true), false, 'already on');
  mgr.setPowerEnabled('car', 'power', false);
  assert.equal(mgr.setPowerEnabled('car', 'power', false), false, 'already off');

  assert.equal(powerEvents().length, before + 1, 'exactly one real change emitted');
  assert.equal(spy.seen.length, applied + 1, 'and exactly one re-apply');
});

test('setPowerEnabled tolerates unknown ids and drops a stat the mount does not sell', () => {
  const { mgr, powerEvents } = manager();
  assert.equal(mgr.setPowerEnabled('horse', 'fire', false), false, 'a horse has no Fire ladder');
  assert.equal(mgr.setPowerEnabled(null, 'power', false), false);
  assert.equal(mgr.setPowerEnabled('car', '', false), false);
  assert.deepEqual(mgr.getDisabledPowers(), {}, 'nothing was stored');
  assert.equal(powerEvents().length, 0, 'and nothing was emitted');
  // The lenient answers, so no caller has to guard before asking.
  assert.equal(mgr.isPowerEnabled('unicorn', 'power'), true);
  assert.equal(mgr.isPowerEnabled('horse', 'fire'), true);
});

test('mount:powers carries the ownership bag and the switch record together', () => {
  const { mgr, powerEvents } = manager();
  mgr.grantPower('dragon', 'fire', 2);
  mgr.setPowerEnabled('dragon', 'fire', false);
  const last = powerEvents().at(-1);
  assert.equal(last.mountId, 'dragon');
  assert.deepEqual(last.powers, { fire: 2 }, 'still the owned tier');
  assert.deepEqual(last.disabled, { fire: true });
});

/* =========================================================== multipliers == */

test('_applyPowers hands a switched-off fitting an effective tier of 0', () => {
  const { mgr } = manager();
  const spy = live(mgr, 'car', spyMount());
  mgr.grantPower('car', 'power', 3);
  mgr.grantPower('car', 'shield', 2);
  assert.deepEqual(spy.last(), { strength: 0, shield: 2, power: 3, fire: 0 });

  mgr.setPowerEnabled('car', 'power', false);
  assert.deepEqual(spy.last(), { strength: 0, shield: 2, power: 0, fire: 0 },
    'off is 0, not tier - 1: every applyPowers is 1 + tier * k over a stock 1');

  mgr.setPowerEnabled('car', 'power', true);
  assert.deepEqual(spy.last(), { strength: 0, shield: 2, power: 3, fire: 0 });
});

test('a real Car goes back to its STOCK multipliers when a fitting is switched off', () => {
  const { mgr } = manager();
  const car = live(mgr, 'car', new Car({
    scene: new THREE.Scene(), engine: null, bus: { on() {}, off() {}, emit() {} }, materials, camera: null,
    physics: { groundHeight: () => 0, resolveCapsule: (p) => p, sphereCast: () => null, raycast: () => null, colliders: [] },
  }));
  // Stock, straight out of the constructor - the numbers "off" has to reach.
  assert.equal(car._powerMul, 1);
  assert.equal(car._accelMul, 1);
  assert.equal(car.shieldTier, 0);

  mgr.grantPower('car', 'power', 3);
  mgr.grantPower('car', 'strength', 2);
  mgr.grantPower('car', 'shield', 1);
  assert.ok(Math.abs(car._powerMul - 1.36) < 1e-9, '+12% a tier');
  assert.ok(Math.abs(car._accelMul - 1.20) < 1e-9, '+10% a tier');
  assert.equal(car.shieldTier, 1);

  mgr.setPowerEnabled('car', 'power', false);
  mgr.setPowerEnabled('car', 'shield', false);
  assert.equal(car._powerMul, 1, 'stock top speed, not a smaller bonus');
  assert.equal(car.shieldTier, 0, 'stock armour');
  assert.ok(Math.abs(car._accelMul - 1.20) < 1e-9, 'and the fitting left ON is untouched');

  mgr.setPowerEnabled('car', 'power', true);
  assert.ok(Math.abs(car._powerMul - 1.36) < 1e-9, 'the tier comes back at full value');
  car.dispose?.();
});

/* =========================================================== persistence == */

test('a save written before the switch existed restores with every fitting ENABLED', () => {
  const { mgr } = manager();
  // Exactly the shape `serialize` produced before this feature: no powersOff.
  mgr.deserialize({ powers: { car: { power: 2, shield: 1 } } });
  assert.deepEqual(mgr.getPowers('car'), { power: 2, shield: 1 });
  assert.equal(mgr.isPowerEnabled('car', 'power'), true);
  assert.equal(mgr.isPowerEnabled('car', 'shield'), true);
  assert.deepEqual(mgr.getDisabledPowers(), {}, 'absent must mean on, or an old save loses every upgrade');
});

test('serialize/deserialize round-trips the switch record', () => {
  const a = manager().mgr;
  a.grantPower('car', 'power', 3);
  a.grantPower('dragon', 'fire', 1);
  a.setPowerEnabled('car', 'power', false);
  const snap = JSON.parse(JSON.stringify(a.serialize()));
  assert.deepEqual(snap.powersOff, { car: { power: true } },
    'and only the off ones - an enabled fitting is absent, never `false`');

  const b = manager().mgr;
  b.deserialize(snap);
  assert.deepEqual(b.getPowers('car'), { power: 3 }, 'ownership survives the trip');
  assert.equal(b.isPowerEnabled('car', 'power'), false);
  assert.equal(b.isPowerEnabled('dragon', 'fire'), true);
});

test('deserialize filters the switch record the way the power bag is filtered', () => {
  const { mgr } = manager();
  mgr.deserialize({
    powersOff: {
      horse: { fire: true, power: true },  // a horse sells no Fire
      car: { power: false, shield: true }, // an explicit false means ON, so it is dropped
      dragon: { fire: false },             // everything filtered out -> no record at all
      bogus: null,
    },
  });
  assert.deepEqual(mgr.getDisabledPowers('horse'), { power: true }, 'the unsold stat is gone');
  assert.deepEqual(mgr.getDisabledPowers('car'), { shield: true });
  assert.deepEqual(mgr.getDisabledPowers('dragon'), {}, 'never an empty {} left behind');
  assert.ok(!('dragon' in mgr.getDisabledPowers()), 'the mount id is dropped entirely');
});

test('deserialize replaces per mount id, and re-applies to a live mount', () => {
  const { mgr } = manager();
  const spy = live(mgr, 'car', spyMount());
  mgr.grantPower('car', 'power', 2);
  mgr.setPowerEnabled('car', 'power', false);
  assert.equal(spy.last().power, 0);

  // A later save says nothing is switched off for the car: the stale record
  // must be cleared, not merged with, and the mount must hear about it.
  mgr.deserialize({ powersOff: { car: {} } });
  assert.deepEqual(mgr.getDisabledPowers('car'), {});
  assert.equal(spy.last().power, 2, 'the live mount got its tier back without a remount');
});

/* ================================================== the farmable-pickup == */

test('a switched-off power still reads as OWNED to MapOverlay._ownsGrant', () => {
  /* The whole reason the switch is a second record.
   *
   * `_ownsGrant` answers "has this placed upgrade already been collected", and
   * it answers it by asking `getPowers`. If switching a fitting off made the
   * mount read as un-owned, the pickup would come back on the next world build
   * - every portal out and back - and could be collected without limit. This
   * test fails the moment anyone implements the switch by zeroing the tier.
   */
  const { mgr } = manager();
  mgr.grantPower('car', 'power', 2);
  mgr.setPowerEnabled('car', 'power', false);

  const overlay = Object.create(MapOverlay.prototype);
  overlay.mounts = mgr;
  overlay.inventory = { totalCount: () => 0 }; // nothing in the bag, so the bag half cannot carry it

  const grant = { mount: 'car', power: 'power', tier: 2 };
  assert.equal(overlay._ownsGrant(grant), true, 'a switched-off upgrade is still collected');
  assert.equal(overlay._ownsGrant({ ...grant, tier: 3 }), false, 'and a HIGHER tier is still on offer');
});

/* ============================================================ F10 logic == */

test('fittingSwitch: an unowned fitting has no switch to press', () => {
  const s = fittingSwitch({ tier: 0, enabled: true });
  assert.equal(s.owned, false);
  assert.equal(s.on, false, 'nothing is running, so the row must not read On');
  assert.equal(s.next, null, 'and pressing it must do nothing at all');
  assert.equal(s.label, '—');
});

test('fittingSwitch: an owned fitting toggles to the other state', () => {
  const on = fittingSwitch({ tier: 2, enabled: true });
  assert.deepEqual({ owned: on.owned, on: on.on, next: on.next, label: on.label, tier: on.tier },
    { owned: true, on: true, next: false, label: 'On', tier: 2 });

  const off = fittingSwitch({ tier: 2, enabled: false });
  assert.deepEqual({ owned: off.owned, on: off.on, next: off.next, label: off.label, tier: off.tier },
    { owned: true, on: false, next: true, label: 'Off', tier: 2 },
    'the pips still show tier 2 while it is off - the player paid for it');
});

test('fittingSwitch: only an explicit false is off', () => {
  // `isPowerEnabled` is called optionally, so a manager without it answers
  // undefined. That has to read as ON, or every badge would draw struck out.
  assert.equal(fittingSwitch({ tier: 1, enabled: undefined }).on, true);
  assert.equal(fittingSwitch({ tier: 1 }).on, true);
  assert.equal(fittingSwitch().owned, false, 'and no argument at all is survivable');
});

test('statLine says a fitting is switched off without hiding what it is worth', () => {
  assert.equal(statLine('power', 2), '+24% top speed', 'the existing two-argument reading is unchanged');
  assert.equal(statLine('power', 2, true), '+24% top speed');
  assert.equal(statLine('power', 2, false), 'Switched off — +24% top speed when on');
  assert.equal(statLine('power', 0, false), 'Not upgraded — buy at market (B)', 'unowned beats the switch');
});
