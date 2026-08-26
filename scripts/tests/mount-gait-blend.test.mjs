import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { Horse } from '../../src/mounts/Horse.js';

/**
 * THE HORSE'S LEGS MUST NOT TELEPORT.
 *
 * `Horse.update` reads a leg's angle out of `(stridePhase + offset) % 1`, and
 * `offset` used to be read straight from a per-gait footfall table. Changing
 * gait therefore changed a leg's POSITION, not just its timing: the worst pair
 * in the table is halt -> walk, where the hind-right offset goes 0 -> 0.75 and
 * three of the four legs jump at once, and that pair fires every single time
 * the animal starts or stops moving.
 *
 * These tests drive a real `Horse` through `fixedUpdate` + `update` - the same
 * two calls `MountManager` makes every frame, with a real control object - and
 * read `leg.upper.rotation.x` off the real leg groups afterwards. They do not
 * inspect the blend state; they measure the thing a player sees, which is
 * where the leg ended up between two consecutive frames.
 */

const matCache = new Map();
const materials = {
  has: () => true,
  get: (k) => { if (!matCache.has(k)) matCache.set(k, new THREE.MeshStandardMaterial()); return matCache.get(k); },
  register: (k, m) => matCache.set(k, m),
  tinted: (k) => materials.get(k),
};
const bus = { on() {}, off() {}, emit() {} };
const physics = {
  groundHeight: () => 0, resolveCapsule: (p) => p, sphereCast: () => null,
  raycast: () => null, colliders: [],
};
const ctx = () => ({
  scene: new THREE.Scene(), engine: null, physics, bus, materials, camera: null,
  player: { position: new THREE.Vector3(), stamina: { drain() {}, exhausted: false } },
});

const DT = 1 / 60;
const ctrl = (throttle, boost = false) => ({ throttle, strafe: 0, boost, speedMul: 1, jump: false });

/**
 * Run the horse and report the worst single-frame move of any leg, in degrees.
 * `plan(step)` returns the control for that step, or null to stand.
 */
function drive(horse, steps, plan) {
  const prev = horse.legs.map((l) => l.upper.rotation.x);
  const all = [];
  let worst = 0;
  let worstAt = null;
  for (let i = 0; i < steps; i++) {
    horse.fixedUpdate(DT, i * DT, plan(i));
    horse.update(DT);
    for (let k = 0; k < horse.legs.length; k++) {
      const now = horse.legs[k].upper.rotation.x;
      const d = Math.abs(now - prev[k]) * (180 / Math.PI);
      all.push(d);
      if (d > worst) { worst = d; worstAt = { step: i, leg: k, speed: +horse.speed.toFixed(2), gait: horse.gait }; }
      prev[k] = now;
    }
  }
  all.sort((a, b) => a - b);
  const p99 = all.length ? all[Math.floor(all.length * 0.99)] : 0;
  return { worst, worstAt, p99, ratio: p99 > 0.05 ? worst / p99 : 0 };
}

/**
 * Both halves of the gate, because either alone is weak.
 *
 * The absolute ceiling catches a jump on a slow gait, where the legitimate
 * motion is small. The outlier ratio catches one at a gallop, where it is not:
 * a galloping horse's leg genuinely moves 14.5 degrees a frame at 60 Hz (2.28
 * cycles a second over a 6.8 m stride, against a swing curve whose steepest
 * slope is 0.85 * pi / 0.4 = 6.68 rad per turn), so an absolute test loose
 * enough to allow that would wave a 19-degree teleport through.
 *
 * Measured on the code as it stood before the cross-fade, over these same four
 * drives: worst 58.4 / 66.1 / 77.0 degrees at ratios of 4 to 6.
 */
function assertNoTeleport(r, label) {
  const detail = `${label}: worst ${r.worst.toFixed(1)} deg, p99 ${r.p99.toFixed(1)}, `
    + `ratio ${r.ratio.toFixed(2)} at ${JSON.stringify(r.worstAt)}`;
  assert.ok(r.worst < MAX_STEP_DEG, detail);
  assert.ok(r.ratio < MAX_OUTLIER, detail);
}

function spawned() {
  const h = new Horse(ctx());
  h.spawn(new THREE.Vector3(0, 0, 0), 0);
  h.onMount();
  // Settle the spawn scale ramp so it is not confused with an animation step.
  for (let i = 0; i < 90; i++) { h.fixedUpdate(DT, i * DT, ctrl(0)); h.update(DT); }
  return h;
}

const MAX_STEP_DEG = 20;
const MAX_OUTLIER = 2.0;

test('starting from a halt does not teleport the legs', () => {
  const h = spawned();
  const r = drive(h, 180, () => ctrl(1));
  assertNoTeleport(r, 'halt -> walk -> trot');
  assert.ok(h.speed > 3, `the horse actually accelerated (speed ${h.speed.toFixed(2)})`);
  h.kill();
});

test('coasting to a halt does not teleport the legs', () => {
  const h = spawned();
  // Up to a canter, then drop the reins entirely and roll to a stop.
  const r = drive(h, 600, (i) => ctrl(i < 220 ? 1 : 0));
  assertNoTeleport(r, 'canter -> halt');
  assert.ok(h.speed < 0.2, `the horse actually stopped (speed ${h.speed.toFixed(3)})`);
  h.kill();
});

test('every gait boundary is crossed without a jump, in both directions', () => {
  const h = spawned();
  // Accelerate to a full gallop and brake back down, twice, so each of the
  // four band edges is crossed up and down twice.
  const r = drive(h, 1400, (i) => (i % 700 < 350 ? ctrl(1, true) : ctrl(0)));
  assertNoTeleport(r, 'all four edges, both ways, twice');
  h.kill();
});

/**
 * A throttle, not an assignment.
 *
 * The first version of this test set `horse.speed` directly and then called
 * `fixedUpdate`, which is the first thing that method overwrites - so it pinned
 * nothing, the horse simply settled at the throttle's own target, and the test
 * passed against the very code it was written to catch. The control input is
 * the real path: `CRUISE_SPEED * throttle` is the speed target, so a throttle
 * oscillating about `2.6 / 8.4` walks the horse back and forth across the
 * walk/trot edge exactly as a rider feathering the reins does.
 */
test('a throttle held on a band edge does not flicker between two gaits', () => {
  const h = spawned();
  const plan = (i) => ctrl((2.6 + Math.sin(i * 0.31) * 0.22) / 8.4);
  // Settle onto the edge first, then watch.
  for (let i = 0; i < 240; i++) { h.fixedUpdate(DT, i * DT, plan(i)); h.update(DT); }
  assert.ok(Math.abs(h.speed - 2.6) < 0.4, `parked on the edge (speed ${h.speed.toFixed(2)})`);

  const names = new Set();
  const r = drive(h, 400, (i) => { names.add(h.gait); return plan(i + 240); });
  assert.equal(names.size, 1, `settled on one gait, saw ${[...names].join(', ')}`);
  assertNoTeleport(r, 'held on the walk/trot edge');
  h.kill();
});

test('the footfall beat still fires, and only on a hoof that went forward', () => {
  const h = new Horse(ctx());
  const beats = [];
  h.bus = { on() {}, off() {}, emit: (name, p) => { if (name === 'mount:footfall') beats.push(p.hard); } };
  h.spawn(new THREE.Vector3(0, 0, 0), 0);
  h.onMount();
  for (let i = 0; i < 600; i++) {
    h.fixedUpdate(DT, i * DT, ctrl(i < 300 ? 1 : 0));
    h.update(DT);
  }
  assert.ok(beats.length > 8, `hooves are still audible (${beats.length} beats over 10 s)`);
  // Four hooves at a canter are roughly 2.5 cycles a second; ten seconds of
  // riding cannot possibly contain hundreds of beats, and a phase that was
  // being dragged backwards across the crossing test would produce exactly
  // that.
  assert.ok(beats.length < 120, `and not double-firing (${beats.length} beats)`);
  h.kill();
});
