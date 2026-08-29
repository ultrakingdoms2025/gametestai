import { test } from 'node:test';
import assert from 'node:assert/strict';

import { installHeadlessDom, Physics, THREE } from './world-kit.mjs';
installHeadlessDom();

/**
 * A KILLED NPC HAS TO LAND ON SOMETHING.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 *  THE DEFECT
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Reported live: "if i kill them near stairs, they fall down behind the
 * stairs". `NPCAnimator._updateDeath` topples the whole rig about a horizontal
 * axis through the FEET and makes no collision query at all - the animator's
 * only raycast is in `_poseLegs`, and `update()` returns straight after
 * `_updateDeath`, so on a corpse it is unreachable. The one concession to the
 * ground is a flat +0.13 m lift.
 *
 * Driving the real `_updateDeath` to rest: the topple settles at 81-90 degrees
 * in 0.80 s and a point 1.5 m up the standing body ends 1.48-1.50 m out from
 * the feet, having dropped 1.15-1.38 m. On flat ground the 0.13 m is right. On
 * a flight it is not - the tread 1.45 m along is over a metre HIGHER - so a
 * body toppling up-flight ends about a metre inside the staircase.
 *
 * It is the ordinary shot that does it, too. `NPC.applyDamage` builds the
 * impact direction as (npc.position - source.position) and forwards it to
 * `die()`, so a target standing ABOVE the player on a flight always topples
 * INTO the flight. That is the shot a player takes.
 *
 * ── What is NOT the cause, measured before the fix was written ────────────
 * Not the corpse's physics. Driving the real `_integrateDead` against a real
 * stair flight over a dense sweep of starts, the worst divergence between a
 * corpse and a living body was 0.13 m and neither ever ended below the flight.
 * Not `Grounding.pickSurface` either: a vertical column through a flight
 * crosses exactly ONE tread, and the +40 cramped penalty pushes the answer
 * toward the tread rather than under it. The defect is entirely in the pose.
 *
 * ── The instrument that was wrong first, caught by this gate ─────────────
 * The first fix turned the FALL to look for flat ground. A staircase has no
 * flat bearing: across the flight is off the side and a 1.6 m drop, down-
 * flight is a metre below, and the 45 degree compromise it actually chose
 * still put the head 0.80 m inside the steps. A body on stairs does not need a
 * flat spot - it needs to lie ALONG the slope. So the shot direction is left
 * exactly as it was and the fall stops where the body meets the surface.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 *  WHAT THIS GATE MEASURES
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Where the head actually comes to rest, against a real `Physics` holding a
 * real stepped flight, for a body shot from below. The first assertion in the
 * stairs case checks the RIG STILL REPRODUCES THE DEFECT before checking the
 * fix - a gate whose setup has drifted flat would otherwise pass by measuring
 * nothing, which is the failure this repository has hit more than once.
 *
 * It does not re-measure the topple curve. That is `_updateDeath`'s and it did
 * not change; pinning an animation spring in a placement test is how gates
 * start failing for reasons that are not defects.
 */

/** Verbatim from NPCAnimator - the column whose ground decides the landing. */
const DEATH_REACH = 1.45;
/** Feet-to-head. 1.5 m reproduces the measured 1.48 m of horizontal reach. */
const BODY = 1.5;
/** `_updateDeath`'s flat lift, at full fall. */
const LIFT = 0.13;

/** A stepped flight, the shape both `InteriorKit._stairFlight` and
 *  `MedievalWorld._stairs` build: solid boxes, each one tread deep. */
function flight(physics, { steps = 8, rise = 0.4, tread = 0.5, halfW = 1.2 } = {}) {
  for (let i = 0; i < steps; i++) {
    const top = (i + 1) * rise;
    physics.addBox(0, top / 2, i * tread + tread / 2, halfW, top / 2, tread / 2);
  }
  physics.addBox(0, -0.5, -4, 12, 0.5, 12);
  return physics;
}

/** The real animator, with only the rig hierarchy `_deathFallLimit` reads. */
async function animatorAt(physics, x, y, z) {
  const { NPCAnimator } = await import('../../src/npc/NPCAnimator.js');
  const root = new THREE.Group();
  root.position.set(x, y, z);
  const rig = new THREE.Group();
  root.add(rig);
  root.updateMatrixWorld(true);
  const a = Object.create(NPCAnimator.prototype);
  a.physics = physics;
  a.h = { root, rig };
  return a;
}

/** Where the head comes to rest, and what is under it. */
function settle(physics, feet, dir, limit) {
  const hx = feet.x + dir.x * BODY * Math.sin(limit);
  const hz = feet.z + dir.z * BODY * Math.sin(limit);
  const hy = feet.y + BODY * Math.cos(limit) + LIFT;
  const ground = physics.groundHeight(hx, hz, feet.y + 4, 9);
  return { hy, ground, clearance: ground == null ? Infinity : hy - ground };
}

test('a body shot from below a flight is not toppled into it', async () => {
  const physics = new Physics();
  flight(physics);

  const feet = new THREE.Vector3(0, 4 * 0.4, 3 * 0.5 + 0.25);
  const dir = new THREE.Vector3(0, 0, 1); // up-flight, away from a shooter below
  const a = await animatorAt(physics, feet.x, feet.y, feet.z);

  const base = 1.5;
  const before = settle(physics, feet, dir, base);
  const limit = a._deathFallLimit(dir, base);
  const after = settle(physics, feet, dir, limit);

  console.log(`  fall limit ${base.toFixed(2)} -> ${limit.toFixed(2)} rad (${(limit * 57.3).toFixed(0)} deg)`);
  console.log(`  head ${before.hy.toFixed(2)} -> ${after.hy.toFixed(2)} m, ground under it ${after.ground?.toFixed(2)} m`);
  console.log(`  clearance ${before.clearance.toFixed(2)} -> ${after.clearance.toFixed(2)} m`);

  assert.ok(before.clearance < -0.3,
    `the rig no longer reproduces the defect (clearance ${before.clearance.toFixed(2)} m) - this gate is measuring nothing`);
  assert.ok(after.clearance >= -0.1,
    `the head still rests ${(-after.clearance).toFixed(2)} m inside the flight`);
});

test('on open ground the fall is exactly what it always was', async () => {
  const physics = new Physics();
  physics.addBox(0, -0.5, 0, 40, 0.5, 40);
  const a = await animatorAt(physics, 0, 0, 0);
  const dir = new THREE.Vector3(0.6, 0, 0.8).normalize();

  for (const base of [1.42, 1.50, 1.58]) {
    assert.equal(a._deathFallLimit(dir, base), base, `flat ground changed the fall from ${base}`);
  }
});

test('falling ground lets the body lie flatter instead of hanging', async () => {
  const physics = new Physics();
  physics.addBox(0, 1.5, 0, 3, 1.5, 3);     // a plinth
  physics.addBox(0, -0.5, 6, 12, 0.5, 12);  // the floor beyond it
  const a = await animatorAt(physics, 0, 3, 2.5);

  const limit = a._deathFallLimit(new THREE.Vector3(0, 0, 1), 1.42);
  console.log(`  off a 3 m plinth: 1.42 -> ${limit.toFixed(2)} rad`);
  assert.ok(limit > 1.42, 'a body toppling over an edge should lie flatter, not the same');
  assert.ok(limit <= 1.62, 'and never past flat');
});

test('with no physics at all the fall is left alone', async () => {
  const a = await animatorAt(null, 0, 0, 0);
  assert.equal(a._deathFallLimit(new THREE.Vector3(0, 0, -1), 1.42), 1.42);
});
