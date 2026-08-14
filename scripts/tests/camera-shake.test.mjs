import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Player } from '../../src/player/Player.js';

/**
 * `camera:shake` used to be a dead event.
 *
 * Eight emitters - Combat (three), Projectiles, Bow, Fireball, Sword (two) -
 * and, grepping the whole tree, not one listener. Every explosion, every sword
 * hit and the player's own death lurch were firing into nothing, in all five
 * worlds, for as long as the event has existed.
 *
 * That is easy to reintroduce, because nothing fails when an event goes
 * unheard. So the first case below reads the source and counts, deliberately,
 * rather than trusting a mock bus: a mock proves the handler works, not that
 * anybody subscribed it. That distinction is the entire bug.
 */

const SRC = (p) => readFileSync(fileURLToPath(new URL(p, import.meta.url)), 'utf8');

test('camera:shake has a real listener, not only emitters', () => {
  const player = SRC('../../src/player/Player.js');
  assert.ok(
    /bus\.on\(\s*['"]camera:shake['"]/.test(player),
    'Player must subscribe to camera:shake - the event was dead before this',
  );
  // And it has to survive teardown, or every world switch leaks a subscription.
  assert.match(player, /_offShake\?\.\(\)/, 'the subscription must be released in dispose()');
});

test('the emitters are still there, still on the scale this maps from', () => {
  const files = [
    '../../src/systems/Combat.js',
    '../../src/systems/Projectiles.js',
    '../../src/weapons/Bow.js',
    '../../src/weapons/Fireball.js',
    '../../src/weapons/Sword.js',
  ];
  let emitters = 0;
  for (const f of files) emitters += (SRC(f).match(/emit\(\s*['"]camera:shake['"]/g) ?? []).length;
  // If this drops, an emitter went away and the mapping below may be tuned for
  // a range nothing produces any more.
  assert.ok(emitters >= 8, `expected the 8 known camera:shake emitters, found ${emitters}`);
});

/** A player reduced to exactly what the shake path reads. */
function stub() {
  const p = Object.create(Player.prototype);
  p._kick = { pitch: 0, yaw: 0, roll: 0, vp: 0, vy: 0, vr: 0 };
  p._shakeParity = 1;
  return p;
}

test('a shake becomes a view kick on the pitch axis', () => {
  const p = stub();
  assert.equal(p.applyShake(0.62), true);
  assert.ok(p._kick.vp > 0, 'the view should kick up');
  // The death lurch is the largest amount any emitter produces: ~20 degrees.
  assert.ok(p._kick.vp > 0.3 && p._kick.vp < 0.4, `death lurch was ${p._kick.vp} rad`);
});

test('a bow draw is a nudge, not a lurch', () => {
  const p = stub();
  p.applyShake(0.03);
  const deg = (p._kick.vp * 180) / Math.PI;
  assert.ok(deg > 0.5 && deg < 2, `bow draw was ${deg} degrees`);
});

test('roll alternates so a burst shudders instead of leaning', () => {
  const p = stub();
  p.applyShake(0.2);
  const first = p._kick.vr;
  p.applyShake(0.2);
  const second = p._kick.vr - first;
  assert.ok(first !== 0, 'the first shake should roll the view');
  assert.equal(Math.sign(second), -Math.sign(first), 'consecutive shakes must roll opposite ways');
});

test('a burst of identical shakes does not accumulate into a lean', () => {
  const p = stub();
  for (let i = 0; i < 8; i++) p.applyShake(0.15);
  // Four each way: the roll impulses cancel, the pitch deliberately does not.
  assert.ok(Math.abs(p._kick.vr) < 1e-9, `roll drifted to ${p._kick.vr}`);
  assert.ok(p._kick.vp > 0, 'pitch should still have accumulated');
});

test('zero and rubbish amounts do nothing', () => {
  const p = stub();
  for (const bad of [0, -1, NaN, undefined, null]) {
    assert.equal(p.applyShake(bad), false, `applyShake(${bad}) should be a no-op`);
  }
  assert.equal(p._kick.vp, 0);
  assert.equal(p._shakeParity, 1, 'a rejected shake must not flip the parity');
});
