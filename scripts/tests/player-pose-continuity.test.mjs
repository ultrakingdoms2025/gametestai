import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { PlayerAvatar } from '../../src/player/PlayerAvatar.js';

/**
 * NOTHING ON THE PLAYER'S BODY MAY MOVE IN ONE FRAME.
 *
 * Three transitions on the avatar were cuts rather than blends, and all three
 * were found by sampling bone quaternions per frame in a real browser while
 * driving the game with real key events - not by reading the source, where all
 * three read perfectly:
 *
 *   1. **The aim layer.** `NPCAnimator._poseAimArms` is gated on
 *      `aimWeight > 0.001 && aimTarget`, so `setAimTarget(null)` does not fade
 *      the aim pose out - it stops solving it. Starting a sprint moved
 *      `upperArmR` **150.8 degrees in one 16.7 ms frame** (161.3 at the top of
 *      a jump) against a p50 of 0.7. The fix lowers the WANT and keeps a live
 *      target, so the weight rings out and the two poses blend.
 *   2. **The air pose.** `_applyAirPose` read `velocity.y` raw, and that is a
 *      step function at touchdown - it goes from -6 to 0 in one frame while
 *      `_airWeight` still has two thirds of its authority. 13 degrees of thigh,
 *      every landing.
 *   3. **The idle turn.** A hard dead zone froze the body until the camera
 *      passed 0.6 rad, then turned at the full rate, then stopped dead - so a
 *      single slow look was a stutter, and the turn rate handed to the animator
 *      (which drives its shuffle-step cadence) was a square wave.
 *
 * These tests drive a real `PlayerAvatar` through `update()`, which is the same
 * call the frame loop makes, and measure the bones it actually posed. The
 * humanoid, the animator and the aim solver are all the real ones.
 *
 * ── Why the gate is a SHARE and not just a ceiling ────────────────────────
 *
 * A raised carbine and a running arm swing are about 150 degrees apart at the
 * elbow, and `aimWeight` ramps at 7 nepers a second - so an honest, monotonic,
 * eight-frame blend between them still moves the forearm 15-20 degrees on its
 * busiest frame. An absolute ceiling loose enough to permit that would also
 * permit half a cut. What separates a blend from a cut is not how big the
 * biggest frame is, it is what FRACTION of the whole journey that one frame
 * took: a cut takes essentially all of it, a blend takes a fraction.
 *
 * Measured over these same three drives, worst single frame and its share of
 * that bone's whole travel:
 *
 *   before   176.9 / 169.5 / 171.5 degrees, all of them `foreArmR`, 10-23%
 *   after     24.0 /  24.4 /  23.6 degrees, all of them a LEG, 1.0-1.7%
 *
 * After the change the busiest frame in the whole run is a sprinting thigh
 * doing what a sprinting thigh does. No arm is anywhere near the top.
 */

const matCache = new Map();
const materials = {
  has: () => true,
  get: (k) => { if (!matCache.has(k)) matCache.set(k, new THREE.MeshStandardMaterial()); return matCache.get(k); },
  register: (k, m) => matCache.set(k, m),
  tinted: (k) => materials.get(k),
};
const bus = { on: () => () => {}, off() {}, emit() {} };

/** A player stub with exactly the surface `PlayerAvatar.update` reads. */
function makePlayer() {
  return {
    position: new THREE.Vector3(0, 0, 0),
    velocity: new THREE.Vector3(0, 0, 0),
    yaw: 0,
    pitch: 0,
    grounded: true,
    isDead: false,
    isAiming: false,
    isSprinting: false,
    lastFiredAt: -100,
    crouchAmount: 0,
    movementOverride: null,
    parkour: null,
    swim: null,
    physics: null,
    avatar: null,
    cameraRig: {
      isThird: true,
      boomLength: 4,
      aimPoint: new THREE.Vector3(0, 1.6, -30),
    },
    _harnessFrozen: false,
  };
}

function makeAvatar(player) {
  const scene = new THREE.Scene();
  const a = new PlayerAvatar({ scene, engine: null, materials, player, bus, physics: null });
  a.setVisible(true);
  return a;
}

const DT = 1 / 60;
const BONES = [
  'upperArmR', 'foreArmR', 'upperArmL', 'thighR', 'calfR', 'footR',
  'thighL', 'calfL', 'footL', 'spine02', 'neck', 'head',
];

/**
 * Keep the crosshair where the real rig puts it: 30 m down the player's own
 * facing, moving with them. A fixed world point is not what `CameraRig`
 * produces, and a player who runs past one turns the aim solver through 180
 * degrees - a defect in the fixture, not in the avatar.
 */
function aimAhead(p) {
  p.cameraRig.aimPoint.set(
    p.position.x - Math.sin(p.yaw) * 30,
    p.position.y + 1.6,
    p.position.z - Math.cos(p.yaw) * 30
  );
}

/**
 * Drive the avatar and report, per bone, the biggest single-frame move and what
 * share of that bone's whole travel it was.
 */
function run(avatar, steps, plan) {
  const B = avatar.humanoid.bones;
  const prev = new Map();
  const travel = new Map();
  const scratch = new THREE.Quaternion();
  let worst = 0;
  let worstBone = null;
  let worstAt = -1;
  for (let i = 0; i < steps; i++) {
    plan(i);
    aimAhead(avatar.player);
    avatar.update(DT, i * DT);
    /* WORLD orientation, not the local rotation.
     *
     * A bone's local rotation is measured against its parent, and the aim
     * solver writes the forearm's local as `inverse(blended upper) * solved
     * forearm` - so while the upper arm is blending, the forearm's LOCAL swings
     * hard while the limb it draws barely moves. Measuring the local reported a
     * 150-degree pop on a frame where nothing visible happened. What a player
     * sees is where the bone points in the world, so that is what is measured.
     */
    avatar.humanoid.root.updateMatrixWorld(true);
    for (const name of BONES) {
      const b = B.get(name);
      if (!b) continue;
      b.getWorldQuaternion(scratch);
      const p = prev.get(name);
      if (p) {
        const dot = Math.min(1, Math.abs(p.dot(scratch)));
        const deg = 2 * Math.acos(dot) * (180 / Math.PI);
        travel.set(name, (travel.get(name) ?? 0) + deg);
        if (deg > worst) { worst = deg; worstBone = name; worstAt = i; }
      }
      prev.set(name, scratch.clone());
    }
  }
  const total = travel.get(worstBone) ?? 0;
  return { worst, worstBone, worstAt, share: total > 1 ? worst / total : 0 };
}

/**
 * A cut takes the whole journey in one frame. Ten per cent is a generous
 * ceiling for "spread over frames" - the measured share after the fix is 0.01
 * to 0.03, and before it was 0.87 to 0.94.
 */
const MAX_SHARE = 0.10;
/** And nothing may take half a cut in one frame either, share or no share. */
const MAX_STEP_DEG = 45;

function assertBlended(r, label) {
  const detail = `${label}: ${r.worst.toFixed(1)} deg on ${r.worstBone} at frame ${r.worstAt}`
    + `, ${(r.share * 100).toFixed(1)}% of that bone's whole travel`;
  assert.ok(r.worst < MAX_STEP_DEG, detail);
  assert.ok(r.share < MAX_SHARE, detail);
}

/** Ease the ground speed the way the controller does, not as a step. */
function accel(cur, want) {
  return cur + (want - cur) * (1 - Math.exp(-9 * DT));
}

test('lowering the weapon for a sprint blends the arms instead of cutting them', () => {
  const p = makePlayer();
  const a = makeAvatar(p);
  let speed = 0;
  const r = run(a, 300, (i) => {
    p.isSprinting = i >= 150;
    speed = accel(speed, p.isSprinting ? 8 : 3.2);
    p.velocity.set(0, 0, -speed);
    p.position.z -= speed * DT;
  });
  // Stowed, not released: the arms keep the weapon and the muzzle goes down.
  assert.ok(a._stow > 0.98, `the muzzle did drop (${a._stow.toFixed(3)})`);
  assert.ok(a.animator.aimWeight > 0.9, `and the arms kept hold of it (${a.animator.aimWeight.toFixed(3)})`);
  assertBlended(r, 'sprint start');
  a.dispose();
});

test('raising it again blends the same way', () => {
  const p = makePlayer();
  const a = makeAvatar(p);
  let speed = 0;
  const r = run(a, 400, (i) => {
    p.isSprinting = i >= 100 && i < 250;
    speed = accel(speed, p.isSprinting ? 8 : 3.2);
    p.velocity.set(0, 0, -speed);
    p.position.z -= speed * DT;
  });
  assert.ok(a._stow < 0.02, `the muzzle came back up (${a._stow.toFixed(3)})`);
  assert.ok(a.animator.aimWeight > 0.9, `with the weapon still held (${a.animator.aimWeight.toFixed(3)})`);
  assertBlended(r, 'sprint end');
  a.dispose();
});

test('touching down after a fall does not snap the legs', () => {
  const p = makePlayer();
  const a = makeAvatar(p);
  // Run, leave the ground, fall, and touch down hard: `velocity.y` steps from
  // -9 to 0 between two frames while the air pose still has most of its weight.
  const r = run(a, 300, (i) => {
    p.velocity.x = 0;
    p.velocity.z = -5;
    if (i < 60) { p.grounded = true; p.velocity.y = 0; }
    else if (i < 160) {
      p.grounded = false;
      p.velocity.y = 7 - (i - 60) * 0.16;
      p.position.y = Math.max(0, p.position.y + p.velocity.y * DT);
    } else if (i === 160) {
      p.grounded = true; p.velocity.y = 0; p.position.y = 0;
      a._landAbsorb = 0.9;   // what `player:landed` sets for a hard impact
    } else { p.grounded = true; p.velocity.y = 0; }
    p.position.z -= 5 * DT;
  });
  assertBlended(r, 'touchdown');
  a.dispose();
});

/**
 * The stutter, measured as what it is: how many times the turn stops and
 * starts again inside one continuous camera sweep.
 *
 * `_turnRate` is the number the animator's shuffle-step cadence is driven off,
 * so every extra transition here is a shuffle that begins and is cut off.
 * Measured on the code as it stood before this change, over this exact sweep:
 * **41 separate bursts**.
 */
test('an idle turn-in-place is one turn, not a stutter', () => {
  const p = makePlayer();
  const a = makeAvatar(p);
  p.velocity.set(0, 0, 0);
  const rates = [];
  run(a, 420, (i) => {
    // A slow, continuous look: 0.9 rad/s for four seconds, then hold.
    if (i < 240) p.yaw -= 0.9 * DT;
    rates.push(Math.abs(a._turnRate));
  });
  // `rates` is pushed BEFORE the update, so drop the leading zero.
  const moving = rates.slice(1).map((v) => v > 0.05);
  let bursts = 0;
  for (let i = 1; i < moving.length; i++) if (moving[i] && !moving[i - 1]) bursts++;
  assert.ok(bursts <= 3, `the body turned in ${bursts} separate bursts across one sweep`);
  assert.ok(moving.some(Boolean), 'the body did turn at all');
  // And it caught up: a latch that never releases is its own defect.
  const wrap = (x) => {
    let v = x % (Math.PI * 2);
    if (v > Math.PI) v -= Math.PI * 2;
    if (v < -Math.PI) v += Math.PI * 2;
    return v;
  };
  assert.ok(
    Math.abs(wrap(p.yaw - a._bodyYaw)) < 0.35,
    `the body ended up facing the camera (off by ${Math.abs(wrap(p.yaw - a._bodyYaw)).toFixed(3)} rad)`
  );
  a.dispose();
});

test('the lean layer is off while a mount owns the body, and clears on a snap', () => {
  const p = makePlayer();
  const a = makeAvatar(p);
  run(a, 120, () => { p.velocity.set(0, 0, -8); p.position.z -= 8 * DT; });
  assert.ok(a._leanPitch > 0.02, `a sprint does lean the chest (${a._leanPitch.toFixed(3)})`);

  p.movementOverride = { kind: 'mount' };
  run(a, 120, () => { p.velocity.set(0, 0, -8); });
  assert.ok(
    Math.abs(a._leanPitch) < 0.005,
    `and a mounted body does not (${a._leanPitch.toFixed(3)})`
  );

  p.movementOverride = null;
  run(a, 60, () => { p.velocity.set(0, 0, -8); p.position.z -= 8 * DT; });
  a._snap();
  assert.equal(a._leanPitch, 0, 'a snap clears the damped lean rather than unwinding it');
  assert.equal(a._airRise, 0, 'and the damped air term with it');
  a.dispose();
});
