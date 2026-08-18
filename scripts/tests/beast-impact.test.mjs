import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { CONFIG } from '../../src/core/Config.js';
import { Player } from '../../src/player/Player.js';
import { BEASTS } from '../../src/npc/BeastSpecies.js';

/**
 * What a maul does TO the player: the knockback, the view kick and the bleed.
 *
 * ── The one that actually matters ─────────────────────────────────────────
 * There was no impulse API in this game before this work - grepped, the only
 * thing in `src/player/` with "impulse" in its name is the weapon viewmodel's
 * spring - so the shape of the new one was a decision, and the decision has a
 * failure mode: a knockback that writes `position` puts the player wherever the
 * shove pointed, walls included, and `resolveCapsule` then ejects them along
 * the SHORTEST axis out of whatever they landed in, which wedged into a corner
 * is frequently straight through to the far side.
 *
 * So the impulse goes into VELOCITY and is integrated by the same `_move` that
 * every other metre of player travel goes through. The test below drives the
 * real `_move` against a wall and asserts the player never ends up on the far
 * side of it - and, so the test can fail, asserts that with the wall removed
 * the same shove carries them several metres. A knockback that quietly did
 * nothing would pass the first half and fail the second.
 *
 * Everything here drives the SHIPPED methods off `Player.prototype` against a
 * stub world. There is no renderer and no DOM, which is the house pattern for
 * render-adjacent code (see npc-sim-lod.test.mjs).
 */

const P = CONFIG.player;
const DT = 1 / 60;

/**
 * A player standing on flat ground, optionally with a wall at x = `wallX`.
 * Only the fields `applyImpulse`, `_applyFriction`, `_move` and `_tickBleed`
 * actually read are present, which keeps what is under test unambiguous.
 */
function stubPlayer({ wallX = null } = {}) {
  const events = [];
  const p = Object.create(Player.prototype);
  p._position = new THREE.Vector3(0, 0, 0);
  p._velocity = new THREE.Vector3(0, 0, 0);
  p._capsuleHeight = P.height;
  p._grounded = true;
  p._wasGrounded = true;
  p._groundNormal = new THREE.Vector3(0, 1, 0);
  p._coyote = 0;
  p._jumpBuffer = 0;
  p._stepSmooth = 0;
  p._impulseTime = 0;
  p._dead = false;
  p._elapsed = 10;
  p._invulnUntil = 0;
  p._lastDamageAt = -999;
  p._regenCarry = 0;
  p._health = P.maxHealth;
  p._maxHealth = P.maxHealth;
  p._bleedRate = 0;
  p._bleedTime = 0;
  p._bleedCarry = 0;
  p._bleedSource = null;
  p._kick = { pitch: 0, yaw: 0, roll: 0, vp: 0, vy: 0, vr: 0 };
  p.movementOverride = false;
  p._selfOverride = false;
  p.events = events;
  p.bus = { emit: (type, e) => events.push({ type, e }) };
  // Only what `_die` reaches for, so a bleed that kills can run to the end.
  p.swim = { cancel() {} };
  p.climb = { cancel() {} };
  p.parkour = { cancel() {} };
  p._weapon = { setEnabled() {}, setAim() {} };
  p._releaseMovement = () => {};

  /* A solid half-space at x >= wallX, and a floor at y = 0. The depenetration
   * is deliberately the naive "push out along x" a real solver would do. */
  p.physics = {
    resolveCapsule(pos, radius) {
      let grounded = false;
      if (pos.y <= 0) { pos.y = 0; grounded = true; }
      if (wallX !== null && pos.x > wallX - radius) pos.x = wallX - radius;
      return { grounded, groundNormal: new THREE.Vector3(0, 1, 0) };
    },
    groundHeight: () => 0,
    raycast: () => null,
  };
  return p;
}

/** Integrate `steps` fixed steps of ground movement with no input. */
function coast(p, steps) {
  for (let i = 0; i < steps; i++) {
    p._impulseTime = Math.max(0, p._impulseTime - DT);
    if (p._grounded) p._applyFriction(DT);
    if (!p._grounded) p._velocity.y += P.gravity * DT;
    else if (p._velocity.y <= 0) p._velocity.y = -2.2;
    Player.prototype._move.call(p, DT);
  }
}

/* ---------------------------------------------------------------- */
/* Knockback                                                         */
/* ---------------------------------------------------------------- */

test('an impulse actually moves the player several metres', () => {
  /* The control case, and the reason the wall test below can fail: a knockback
   * that is silently eaten by friction in three frames would pass "did not go
   * through the wall" trivially. A bear's shove is 9 m/s. */
  const p = stubPlayer();
  const bear = BEASTS.bear;
  assert.equal(p.applyImpulse({ x: bear.knockback, y: bear.knockUp, z: 0 }), true);
  coast(p, 90);
  assert.ok(p._position.x > 2.0,
    `a ${bear.knockback} m/s shove carried the player only ${p._position.x.toFixed(2)} m`);
  assert.ok(p._position.x < 12, `the shove never stopped: ${p._position.x.toFixed(2)} m`);
});

test('knockback resolves against collision instead of tunnelling through it', () => {
  /* A wall 2 m to the player's right, shoved straight at it hard enough to
   * cross it in a single step if the impulse were applied to `position`
   * (14 m/s x 1/60 s = 0.23 m per step, and the whole 2 m in a third of a
   * second). The capsule must finish - and stay - on the near side, every step
   * of the way. */
  const wallX = 2;
  const p = stubPlayer({ wallX });
  p.applyImpulse({ x: 14, y: 0, z: 0 });
  const limit = wallX - P.radius + 1e-6;
  for (let i = 0; i < 120; i++) {
    coast(p, 1);
    assert.ok(p._position.x <= limit,
      `step ${i}: the player is at x=${p._position.x.toFixed(3)}, past the wall face at ${limit.toFixed(3)}`);
  }
  assert.ok(p._position.x > wallX - P.radius - 0.05,
    'the player never reached the wall at all - the impulse did nothing');
});

test('a shove cannot launch the player, however many land at once', () => {
  const p = stubPlayer();
  for (let i = 0; i < 8; i++) p.applyImpulse({ x: 9, y: 3.2, z: 0 });
  assert.ok(p._velocity.y <= 3.2 + 1e-9,
    `eight bear hits stacked into ${p._velocity.y.toFixed(2)} m/s upward`);
  assert.ok(Math.hypot(p._velocity.x, p._velocity.z) <= 14 + 1e-9,
    `horizontal speed reached ${Math.hypot(p._velocity.x, p._velocity.z).toFixed(2)} m/s`);
});

test('an upward shove takes the ground away, so the stagger is airborne', () => {
  const p = stubPlayer();
  p.applyImpulse({ x: 0, y: 3.2, z: 0 });
  assert.equal(p._grounded, false);
  assert.equal(p._coyote, 0, 'coyote time survived being thrown, so the player can still jump off nothing');
});

test('a dead player and a mounted player are not shoved', () => {
  const dead = stubPlayer();
  dead._dead = true;
  assert.equal(dead.applyImpulse({ x: 9, y: 0, z: 0 }), false);
  assert.equal(dead._velocity.x, 0);

  const rider = stubPlayer();
  rider.movementOverride = true;
  assert.equal(rider.applyImpulse({ x: 9, y: 0, z: 0 }), false,
    'a bear shoved somebody off the horse they were sitting on');
});

test('the impulse is announced, so audio and the avatar can react to it', () => {
  const p = stubPlayer();
  p.applyImpulse({ x: 4.5, y: 1.6, z: 0 });
  assert.ok(p.events.some((e) => e.type === 'player:impulse'));
});

/* ---------------------------------------------------------------- */
/* View kick                                                         */
/* ---------------------------------------------------------------- */

test('the view kick springs back to rest and stays there', () => {
  const p = stubPlayer();
  p.applyViewKick(BEASTS.bear.viewKick * 2.6, 0.1, 0.3);
  let peak = 0;
  for (let i = 0; i < 240; i++) {
    p._tickViewKick(DT);
    peak = Math.max(peak, Math.abs(p._kick.pitch));
  }
  assert.ok(peak > 0.02, `the kick never moved the view (peak ${peak})`);
  assert.equal(p._kick.pitch, 0, `the view is still pitched by ${p._kick.pitch} after four seconds`);
  assert.equal(p._kick.yaw, 0);
  assert.equal(p._kick.roll, 0);
});

test('the kick never sends the view further than a player can recover from', () => {
  const p = stubPlayer();
  // Four bear hits inside one second, which is more than the AI can ever
  // deliver - the cooldown is 2.4 s and only one bear is ever spawned.
  let peak = 0;
  for (let i = 0; i < 240; i++) {
    if (i % 15 === 0 && i < 60) p.applyViewKick(BEASTS.bear.viewKick * 2.6, 0.11, 0.31);
    p._tickViewKick(DT);
    peak = Math.max(peak, Math.abs(p._kick.pitch));
  }
  assert.ok(peak < 0.5, `the view pitched ${(peak * 57.3).toFixed(1)} degrees - that is a blackout, not a kick`);
});

/* ---------------------------------------------------------------- */
/* Bleed                                                             */
/* ---------------------------------------------------------------- */

test('a bleed expires, and pays out roughly what it promised', () => {
  const p = stubPlayer();
  const wolf = BEASTS.wolf;
  assert.equal(p.applyBleed(wolf.bleedRate, wolf.bleedTime, 'wolf-1'), true);
  assert.equal(p.isBleeding, true);

  const before = p._health;
  // Run for twice the duration: it must stop of its own accord, not because
  // the clock ran out on the loop.
  for (let i = 0; i < Math.ceil(wolf.bleedTime * 2 * 60); i++) p._tickBleed(DT);

  assert.equal(p.isBleeding, false, 'the bleed never closed');
  assert.equal(p._bleedRate, 0);
  const lost = before - p._health;
  const expected = wolf.bleedRate * wolf.bleedTime;
  assert.ok(Math.abs(lost - expected) <= 1,
    `a ${wolf.bleedRate}/s bleed for ${wolf.bleedTime}s took ${lost}, not about ${expected}`);
});

test('bleeds refresh rather than stack, which is what keeps a pack survivable', () => {
  /* Four wolves biting inside a second must not compound into 12 health a
   * second. The harsher rate and the longer clock win; nothing multiplies. */
  const p = stubPlayer();
  p.applyBleed(3, 3, 'a');
  p.applyBleed(3, 3, 'b');
  p.applyBleed(3, 3, 'c');
  p.applyBleed(5, 4, 'd');
  assert.equal(p._bleedRate, 5, 'four bleeds compounded into a rate no single beast deals');
  assert.equal(p._bleedTime, 4);

  const before = p._health;
  for (let i = 0; i < 60 * 6; i++) p._tickBleed(DT);
  assert.ok(before - p._health <= 21, `four overlapping bleeds took ${before - p._health} health`);
});

test('the bleed is delivered through applyDamage, so the HUD sees it as damage', () => {
  /* The requirement is "HUD feedback consistent with how player:damaged is
   * already presented", and the cheapest way to be consistent with something is
   * to be it. No HUD change was needed for this; if a future refactor starts
   * decrementing `_health` directly the flash, the direction marker and the
   * regeneration delay all silently stop working. */
  const p = stubPlayer();
  p.applyBleed(6, 2, 'bear-1');
  for (let i = 0; i < 60; i++) p._tickBleed(DT);
  const damaged = p.events.filter((e) => e.type === 'player:damaged');
  assert.ok(damaged.length >= 3, `one second of a 6/s bleed raised ${damaged.length} damage events`);
  for (const d of damaged) {
    assert.ok(d.e.amount >= 1, 'a bleed tick raised a fractional damage event');
    assert.ok(Number.isFinite(d.e.health) && Number.isFinite(d.e.maxHealth));
  }
  assert.equal(p._lastDamageAt, p._elapsed, 'a bleeding player is still regenerating health');
});

test('a bleed cannot outlive the player, and closes on respawn or a portal', () => {
  const p = stubPlayer();
  p.applyBleed(90, 5, 'bear-1');
  for (let i = 0; i < 200 && !p._dead; i++) p._tickBleed(DT);
  assert.ok(p._dead, 'a 90/s bleed did not kill anybody');
  p._tickBleed(DT);
  assert.equal(p.isBleeding, false, 'a corpse is still bleeding');

  const q = stubPlayer();
  q.applyBleed(5, 8, 'bear-1');
  assert.equal(q.clearBleed(), true);
  assert.equal(q.isBleeding, false);
  assert.equal(q.clearBleed(), false, 'clearing a closed wound reported a change');
});

test('a bleed is announced once when it opens and once when it closes', () => {
  const p = stubPlayer();
  p.applyBleed(3, 1, 'wolf-1');
  p.applyBleed(3, 1, 'wolf-2');
  for (let i = 0; i < 120; i++) p._tickBleed(DT);
  const notes = p.events.filter((e) => e.type === 'player:bleed');
  assert.equal(notes.length, 2, `the bleed raised ${notes.length} state changes`);
  assert.equal(notes[0].e.active, true);
  assert.equal(notes[1].e.active, false);
});
