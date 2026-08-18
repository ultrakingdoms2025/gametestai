import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { Car } from '../../src/mounts/Car.js';
import { Dragon } from '../../src/mounts/Dragon.js';
import { Eagle } from '../../src/mounts/Eagle.js';
import { Horse } from '../../src/mounts/Horse.js';
import { Hoverboard } from '../../src/mounts/Hoverboard.js';
import { Bicycle } from '../../src/mounts/Bicycle.js';
import { MOUNT_STATS, FINISH_PROPS } from '../../src/mounts/Livery.js';
import { Player } from '../../src/player/Player.js';
import { CombatSystem } from '../../src/systems/Combat.js';

/**
 * Every mount must expose the same customisation surface, and a bought tier
 * must move the number it claims to move. Checked headlessly: a Speed III that
 * only changed the target but left a hard clamp in place is invisible in play
 * for minutes and shows up here in a second.
 */

const matCache = new Map();
const materials = {
  has: () => true,
  get: (k) => { if (!matCache.has(k)) matCache.set(k, new THREE.MeshStandardMaterial()); return matCache.get(k); },
  register: (k, m) => matCache.set(k, m),
  tinted: (k) => materials.get(k),
};
const bus = { on() {}, off() {}, emit() {} };
const scene = new THREE.Scene();
// raycast: Horse/Bicycle probe the ground ahead once moving (Horse.js:798, Bicycle.js:904).
const physics = { groundHeight: () => 0, resolveCapsule: (p) => p, sphereCast: () => null, raycast: () => null, colliders: [] };
const stamina = { drain() {}, exhausted: false };
const player = { position: new THREE.Vector3(), stamina };
const ctx = { scene, engine: null, physics, bus, materials, camera: null, player };

const CLASSES = { car: Car, dragon: Dragon, eagle: Eagle, horse: Horse, hoverboard: Hoverboard, bicycle: Bicycle };

test('every mount declares CUSTOM_SLOTS, STATS, applyCustomization, applyPowers, shieldTier', () => {
  for (const [id, C] of Object.entries(CLASSES)) {
    assert.ok(Array.isArray(C.CUSTOM_SLOTS) && C.CUSTOM_SLOTS.length >= 2, `${id} slots`);
    for (const s of C.CUSTOM_SLOTS) {
      assert.ok(s.id && s.label && typeof s.finish === 'boolean' && typeof s.defaultColor === 'number' && s.palette, `${id}.${s.id}`);
    }
    assert.deepEqual(C.STATS, MOUNT_STATS[id], `${id} STATS`);
    const m = new C(ctx);
    assert.equal(typeof m.applyCustomization, 'function', `${id} applyCustomization`);
    assert.equal(typeof m.applyPowers, 'function', `${id} applyPowers`);
    assert.ok(m._slotMats && C.CUSTOM_SLOTS.every((s) => Array.isArray(m._slotMats[s.id]) && m._slotMats[s.id].length), `${id} _slotMats covers every slot`);
    m.applyPowers({ shield: 2 });
    assert.equal(m.shieldTier, 2, `${id} shieldTier`);
    m.dispose?.();
  }
});

test('applyCustomization tints the first material of every slot and restores on {}', () => {
  for (const [id, C] of Object.entries(CLASSES)) {
    const m = new C(ctx);
    const livery = {};
    for (const s of C.CUSTOM_SLOTS) livery[s.id] = { color: 0x123456, finish: s.finish ? 'matt' : undefined };
    m.applyCustomization(livery);
    for (const s of C.CUSTOM_SLOTS) {
      const first = m._slotMats[s.id][0];
      const mat = first.mat ?? first;
      // `first.emissive` is only a descriptor FLAG on a wrapped `{mat, emissive:true}`
      // entry - on a raw material (the common case) `.emissive` is the material's own
      // Color property, always a truthy object, so an `if (first.emissive)` check
      // would misread every plain slot as emissive-tracked. `=== true` disambiguates.
      const target = first.emissive === true ? mat.emissive : mat.color;
      assert.equal(target.getHex(), 0x123456, `${id}.${s.id} colour`);
      if (s.finish && 'roughness' in mat) {
        assert.equal(mat.roughness, FINISH_PROPS.matt.roughness, `${id}.${s.id} matt roughness`);
        assert.equal(mat.metalness, FINISH_PROPS.matt.metalness, `${id}.${s.id} matt metalness`);
        assert.equal(mat.envMapIntensity, FINISH_PROPS.matt.envMapIntensity, `${id}.${s.id} matt env`);
      }
    }
    m.applyCustomization({});
    for (const s of C.CUSTOM_SLOTS) {
      const first = m._slotMats[s.id][0];
      const mat = first.mat ?? first;
      const fac = mat.userData.factory;
      const isEmissive = first.emissive === true;
      assert.equal((isEmissive ? mat.emissive : mat.color).getHex(), isEmissive ? fac.emissive : fac.color, `${id}.${s.id} factory colour`);
      // Colour coming back is only half a reset: a restore that forgot the
      // finish leaves the mount permanently glossy and looks fine in a
      // screenshot of the colour swatch.
      if (s.finish && 'roughness' in mat) {
        assert.equal(mat.roughness, fac.roughness, `${id}.${s.id} factory roughness`);
        assert.equal(mat.metalness, fac.metalness, `${id}.${s.id} factory metalness`);
        assert.equal(mat.envMapIntensity, fac.envMapIntensity, `${id}.${s.id} factory env`);
      }
    }
    m.dispose?.();
  }
});

test('tinting a mount never touches a shared library material', () => {
  for (const [id, C] of Object.entries(CLASSES)) {
    // Snapshot before THIS mount is built. `matCache` is shared by every mount
    // in the file, so checking only "no material carries a factory stamp"
    // blames whichever mount happens to run after the guilty one.
    const before = new Map();
    for (const [key, mat] of matCache) before.set(key, mat.userData?.factory);
    const m = new C(ctx);
    const livery = {};
    for (const s of C.CUSTOM_SLOTS ?? []) livery[s.id] = { color: 0xff0000, finish: s.finish ? 'gloss' : undefined };
    m.applyCustomization?.(livery);
    for (const [key, mat] of matCache) {
      assert.equal(mat.userData?.factory, before.get(key), `${id} tinted the shared library material '${key}'`);
      assert.notEqual(mat.color.getHex(), 0xff0000, `${id} repainted the shared library material '${key}'`);
    }
    m.dispose?.();
  }
});

/**
 * Entries in `_slotMats` may be plain materials or `{mat, mix, finish}`
 * descriptors, and the descriptor is the part with no other coverage: the
 * dragon's wing membrane takes 30% of the hide colour and must stay matt when
 * the hide goes gloss, because a glossy membrane reads as wet plastic.
 */
test('a wrapped slot entry mixes toward the colour and can opt out of the finish', () => {
  const d = new Dragon(ctx);
  const hide = d._slotMats.hide[0];
  const entry = d._slotMats.hide.find((e) => typeof e?.mix === 'number');
  assert.ok(entry, 'the dragon hide slot no longer carries a mixed entry');
  assert.equal(entry.mix, 0.3);
  d.applyCustomization({ hide: { color: 0xff0000, finish: 'gloss' } });
  const fac = entry.mat.userData.factory;
  // Built the same way applyLivery builds it - setHex lands in linear space, so
  // a hand-computed sRGB midpoint would be the wrong number.
  const exp = new THREE.Color(fac.color).lerp(new THREE.Color(0xff0000), 0.3);
  assert.equal(entry.mat.color.getHex(), exp.getHex(), 'membrane takes 30% of the hide colour');
  assert.equal(entry.mat.roughness, fac.roughness, 'membrane keeps its factory roughness');
  assert.equal(hide.roughness, FINISH_PROPS.gloss.roughness, 'the hide itself still takes the finish');
  d.dispose();
});

test('every catalogued skin only names slots its mount actually has', async () => {
  const { MOUNT_SKINS } = await import('../../src/systems/Cosmetics.js');
  for (const s of MOUNT_SKINS) {
    const C = CLASSES[s.mount];
    assert.ok(C, `${s.id}: unknown mount ${s.mount}`);
    for (const k in s.livery) {
      assert.ok(C.CUSTOM_SLOTS.some((sl) => sl.id === k), `${s.id}: slot ${k} is not on ${s.mount} (${C.CUSTOM_SLOTS.map((x) => x.id).join(',')})`);
    }
  }
});

test('Dragon has a fire tier and exposes it', () => {
  const d = new Dragon(ctx);
  assert.ok(Dragon.STATS.includes('fire'));
  assert.equal(d.fireTier, 0);
  d.applyPowers({ fire: 3 });
  assert.equal(d.fireTier, 3);
  d.dispose();
});

/**
 * Speed III must *reach* the mount: drive each one flat out for a while at
 * tier 0 and tier 3 and compare terminal speeds. All six measure x1.36 and the
 * thresholds simply bracket that nominal figure; a tier that only touched a
 * clamp the mount never hits reads ~1.0 and fails. If a mount's sim needs a
 * different control to run flat out, fix the RUN table below - never the
 * threshold.
 */
const STEP = 1 / 60;
/**
 * `speedMul` is the rider's consumable buff, the second half of the ladder:
 * `MountManager._gatherControls` copies `Player.speedMultiplier` onto the
 * control block every fixed step and each mount multiplies it into its own
 * purchased tier. Defaulted to 1 so every existing run is bit-identical.
 */
const RUN = {
  car: { seconds: 12, spawnY: 0, ctrl: (m, speedMul = 1) => ({ throttle: 1, strafe: 0, up: 0, boost: true, yaw: m.heading, pitch: 0, speedMul }) },
  horse: { seconds: 12, spawnY: 0, ctrl: (m, speedMul = 1) => ({ throttle: 1, strafe: 0, up: 0, boost: true, yaw: m.heading, pitch: 0, speedMul }) },
  hoverboard: { seconds: 12, spawnY: 0, ctrl: (m, speedMul = 1) => ({ throttle: 1, strafe: 0, up: 0, boost: true, yaw: m.heading, pitch: 0, speedMul }) },
  bicycle: { seconds: 20, spawnY: 0, ctrl: (m, speedMul = 1) => ({ throttle: 1, strafe: 0, up: 0, boost: true, yaw: m.heading, pitch: 0, speedMul }) },
  // Level flight, beating: steady speed is set by thrust vs v^2 drag. (Eagle.spawn ignores
  // position.y and places the bird at ground + 6.5; altitude does not enter its speed model.)
  eagle: { seconds: 15, spawnY: 250, ctrl: (m, speedMul = 1) => ({ throttle: 0, strafe: 0, up: 0, boost: true, yaw: m.heading, pitch: 0, speedMul }) },
  dragon: { seconds: 15, spawnY: 30, flying: true, ctrl: (m, speedMul = 1) => ({ throttle: 1, strafe: 0, up: 1, boost: true, yaw: m.heading, pitch: 0, speedMul }) },
};

function terminalSpeed(id, C, powers, speedMul = 1) {
  const spec = RUN[id];
  const m = new C(ctx);
  m.applyPowers(powers);
  m.spawn(new THREE.Vector3(0, spec.spawnY, 0), 0);
  if (spec.flying) { m.state = 'flying'; m.position.y = spec.spawnY; m._groundY = 0; }
  m.onMount?.();
  const steps = Math.round(spec.seconds / STEP);
  for (let i = 0; i < steps; i++) m.fixedUpdate(STEP, i * STEP, spec.ctrl(m, speedMul));
  const v = Math.abs(m.speed);
  m.dispose?.();
  return v;
}

test('a purchased Speed III reaches every mount (terminal speed rises ~36%)', () => {
  for (const [id, C] of Object.entries(CLASSES)) {
    const stock = terminalSpeed(id, C, { power: 0 });
    const tuned = terminalSpeed(id, C, { power: 3 });
    assert.ok(stock > 3, `${id}: stock terminal speed ${stock.toFixed(2)} - the run table does not drive this mount`);
    const ratio = tuned / stock;
    assert.ok(ratio > 1.30 && ratio < 1.45, `${id}: Speed III gave ${stock.toFixed(2)} -> ${tuned.toFixed(2)} m/s (x${ratio.toFixed(2)})`);
  }
});

/**
 * Speed III must not widen the turning RADIUS.
 *
 * A Speed tier scales the mount's velocity, but what the rider actually meets
 * in a corner is `v / omega`. Every one of these three measured its turn
 * authority against the STOCK top speed, so a bought tier moved the numerator
 * and left the denominator - and on the eagle and the board the authority
 * curve saturates, so `omega` actually FELL and the corner got worse than the
 * raw speed ratio. Dragon.js:1869 documents the same defect and its fix; this
 * is that fix carried to the rest of the fleet.
 *
 * Measured on this rig, r(tier 3) / r(tier 0), before -> after:
 *   horse       1.360 -> 1.000   eagle  1.516 -> 0.973   hoverboard  1.648 -> 1.000
 * The eagle's 3% is the run, not the model: at 8 s the tier-3 bird is still
 * converging on its own higher terminal speed, so it sits a shade further down
 * the authority curve than the stock one. The threshold brackets the nominal
 * 1.0 and is nowhere near any of the pre-fix figures.
 *
 * Each mount is driven with the control that actually turns it, read off its
 * own `fixedUpdate`: the horse steers off `strafe` alone and ignores `yaw`,
 * while the eagle and the board chase `ctrl.yaw`, so those two are held at a
 * constant 0.6 rad of heading error. Never soften the threshold to make this
 * pass - fix the mount, or fix the control in this table.
 */
const TURN = {
  horse: { seconds: 8, ctrl: (m, speedMul = 1) => ({ throttle: 1, strafe: 1, up: 0, boost: true, yaw: m.heading, pitch: 0, speedMul }) },
  eagle: { seconds: 8, ctrl: (m, speedMul = 1) => ({ throttle: 0, strafe: 0, up: 0, boost: true, yaw: m.heading + 0.6, pitch: 0, speedMul }) },
  hoverboard: { seconds: 8, ctrl: (m, speedMul = 1) => ({ throttle: 1, strafe: 0, up: 0, boost: true, yaw: m.heading + 0.6, pitch: 0, speedMul }) },
};

/**
 * Mean turning radius over the last 3 s of the run: total ground distance
 * divided by total heading swept, which is `|v| / |omega|` averaged over the
 * window rather than sampled on one frame. The first seconds are discarded so
 * the spin-up out of a standing start cannot colour the figure.
 */
function turnRadius(id, C, tier, speedMul = 1) {
  const spec = TURN[id];
  const m = new C(ctx);
  m.applyPowers({ power: tier });
  m.spawn(new THREE.Vector3(0, RUN[id].spawnY, 0), 0);
  m.onMount?.();
  const steps = Math.round(spec.seconds / STEP);
  const from = steps - Math.round(3 / STEP);
  let dist = 0;
  let swept = 0;
  for (let i = 0; i < steps; i++) {
    const h0 = m.heading;
    m.fixedUpdate(STEP, i * STEP, spec.ctrl(m, speedMul));
    if (i < from) continue;
    // Shortest-arc difference: heading is free to wrap, and a raw subtraction
    // would book a 2*PI jump as a lap's worth of turning.
    let d = ((m.heading - h0 + Math.PI) % (Math.PI * 2)) - Math.PI;
    if (d < -Math.PI) d += Math.PI * 2;
    swept += Math.abs(d);
    dist += Math.abs(m.speed) * STEP;
  }
  m.dispose?.();
  return { radius: dist / swept, omega: swept / 3, speed: dist / 3 };
}

test('Speed III does not widen the turning radius', () => {
  for (const id of Object.keys(TURN)) {
    const C = CLASSES[id];
    const a = turnRadius(id, C, 0);
    const b = turnRadius(id, C, 3);
    // A mount that never turned reads radius = Infinity or NaN and would sail
    // through the ratio check below on both runs.
    for (const [tier, r] of [[0, a], [3, b]]) {
      assert.ok(r.omega > 0.2, `${id} tier ${tier}: only turned ${r.omega.toFixed(3)} rad/s - the TURN table does not steer this mount`);
      assert.ok(Number.isFinite(r.radius) && r.radius > 1, `${id} tier ${tier}: radius ${r.radius}`);
    }
    const ratio = b.radius / a.radius;
    assert.ok(
      ratio < 1.15,
      `${id}: Speed III turned ${a.radius.toFixed(2)} m (${a.speed.toFixed(1)} m/s, ${a.omega.toFixed(2)} rad/s) into `
      + `${b.radius.toFixed(2)} m (${b.speed.toFixed(1)} m/s, ${b.omega.toFixed(2)} rad/s) - x${ratio.toFixed(3)}, want < 1.15`
    );
  }
});

/**
 * A speed potion must reach the mount.
 *
 * `Player.speedMultiplier` - what ItemUse's `speed_boost_*` items set through
 * `Player.boostSpeed` - was read only by on-foot movement and by Swim, so a
 * potion drunk in the saddle did nothing at all: the player paid for a buff
 * and the horse kept walking at exactly the same speed. It now rides on
 * `ctrl.speedMul` and every mount folds it into the same `pm` its purchased
 * Speed tier uses.
 *
 * x1.5 nominal on all six, including the two whose top speed is a drag
 * balance point rather than a target - the eagle and the bicycle land on 1.5
 * exactly because their air-drag coefficient is divided by pm^2, which moves
 * the balance point by pm. If one of these ever lands outside the bracket,
 * fix the mount; the buff is a plain multiplier and there is nothing here to
 * negotiate.
 */
test('a consumable speed buff multiplies every mount\'s top speed', () => {
  for (const [id, C] of Object.entries(CLASSES)) {
    const stock = terminalSpeed(id, C, {}, 1);
    const buffed = terminalSpeed(id, C, {}, 1.5);
    assert.ok(stock > 3, `${id}: stock terminal speed ${stock.toFixed(2)} - the run table does not drive this mount`);
    const ratio = buffed / stock;
    assert.ok(
      ratio > 1.40 && ratio < 1.60,
      `${id}: a x1.5 buff gave ${stock.toFixed(2)} -> ${buffed.toFixed(2)} m/s (x${ratio.toFixed(3)})`
    );
  }
});

/**
 * The two are independent multipliers and must compound: the wish is baseline
 * boost (free) x purchased Speed tier x active consumable. A buff that
 * REPLACED the tier - `Math.max` of the two, say - would still pass the test
 * above and quietly refund every player who had bought Speed III.
 */
test('a consumable speed buff stacks with a purchased Speed tier', () => {
  for (const [id, C] of Object.entries(CLASSES)) {
    const stock = terminalSpeed(id, C, {}, 1);
    const both = terminalSpeed(id, C, { power: 3 }, 1.5);
    const ratio = both / stock;
    assert.ok(
      Math.abs(ratio - 2.04) < 0.08,
      `${id}: Speed III + x1.5 buff gave ${stock.toFixed(2)} -> ${both.toFixed(2)} m/s (x${ratio.toFixed(3)}, want x1.36 * 1.5 = 2.04)`
    );
  }
});

/**
 * And a potion must not widen the turning RADIUS either. Same rig and the same
 * reasoning as the Speed III case above - v / omega, with the buff in both
 * terms - because the buff multiplies the very same `pm` the tier does, and
 * scaling the speed while leaving the turn authority alone is exactly the
 * defect that fix closed.
 */
test('a consumable speed buff does not widen the turning radius', () => {
  for (const id of Object.keys(TURN)) {
    const C = CLASSES[id];
    const a = turnRadius(id, C, 0, 1);
    const b = turnRadius(id, C, 0, 1.5);
    for (const [what, r] of [['stock', a], ['buffed', b]]) {
      assert.ok(r.omega > 0.2, `${id} ${what}: only turned ${r.omega.toFixed(3)} rad/s - the TURN table does not steer this mount`);
      assert.ok(Number.isFinite(r.radius) && r.radius > 1, `${id} ${what}: radius ${r.radius}`);
    }
    const ratio = b.radius / a.radius;
    assert.ok(
      ratio < 1.15,
      `${id}: a x1.5 buff turned ${a.radius.toFixed(2)} m (${a.speed.toFixed(1)} m/s, ${a.omega.toFixed(2)} rad/s) into `
      + `${b.radius.toFixed(2)} m (${b.speed.toFixed(1)} m/s, ${b.omega.toFixed(2)} rad/s) - x${ratio.toFixed(3)}, want < 1.15`
    );
  }
});

/**
 * The plumbing itself: `_gatherControls` must actually copy the player's live
 * multiplier onto the block the mounts read, and a mount with no rider must
 * not be buffed by a stale field. Driven through the real method on a bare
 * prototype - the manager's constructor builds a scene.
 */
test('MountManager._gatherControls carries the rider speed buff onto the control block', async () => {
  const { MountManager } = await import('../../src/mounts/MountManager.js');
  const mm = Object.create(MountManager.prototype);
  mm._ctrl = { throttle: 0, strafe: 0, yaw: 0, pitch: 0, up: 0, boost: false, speedMul: 1 };
  mm.debugControl = null;
  mm.input = { state: { forward: 1, right: 0, jump: false, crouch: false, sprint: true } };
  mm.player = { yaw: 0, pitch: 0, speedMultiplier: 1.75 };
  assert.equal(mm._gatherControls().speedMul, 1.75);
  // No buff running: `Player.speedMultiplier` reads 1, not 0 or undefined.
  mm.player.speedMultiplier = 1;
  assert.equal(mm._gatherControls().speedMul, 1);
  // A player object that has never heard of the buff must not zero the mounts.
  mm.player = { yaw: 0, pitch: 0 };
  assert.equal(mm._gatherControls().speedMul, 1);
  // The dev harness can drive it, same as every other axis.
  mm.debugControl = { speedMul: 2 };
  assert.equal(mm._gatherControls().speedMul, 2);
});

/**
 * Acceleration is a RAMP-RATE stat, and on a drag-limited mount that is not
 * automatic: scaling the thrust term alone moves the point where thrust
 * balances drag, so both of these were quietly selling top speed under the
 * Acceleration label - measured on this run before the fix, Strength III took
 * the eagle 27.39 -> 31.23 m/s (x1.14) and the bicycle 8.64 -> 9.28 (x1.07).
 * Scaling the whole net acceleration instead leaves the balance point put.
 */
test('Strength does not move terminal speed', () => {
  for (const id of ['eagle', 'bicycle']) {
    const stock = terminalSpeed(id, CLASSES[id], {});
    const strong = terminalSpeed(id, CLASSES[id], { strength: 3 });
    const drift = Math.abs(strong / stock - 1);
    assert.ok(drift < 0.005, `${id}: Strength III moved terminal speed ${stock.toFixed(3)} -> ${strong.toFixed(3)} m/s (${(drift * 100).toFixed(2)}%)`);
  }
  for (const [id, C] of Object.entries(CLASSES)) {
    const m = new C(ctx);
    m.applyPowers({ strength: 3 });
    assert.equal(m._accelMul, 1.3, `${id} _accelMul`);
    m.dispose?.();
  }
});

/**
 * Steps to first reach `target` m/s in the mount's own RUN, starting from a
 * stop. Same rig as `terminalSpeed` but stops the instant the mount crosses
 * the line instead of running the fixed duration, so this is a race rather
 * than a speedometer reading.
 */
function stepsToReach(id, C, powers, target) {
  const spec = RUN[id];
  const m = new C(ctx);
  m.applyPowers(powers);
  m.spawn(new THREE.Vector3(0, spec.spawnY, 0), 0);
  if (spec.flying) { m.state = 'flying'; m.position.y = spec.spawnY; m._groundY = 0; }
  m.onMount?.();
  // Several times the run's own duration: reaching 90% of a terminal that was
  // itself measured at the end of `spec.seconds` must not be starved of steps
  // by using that same budget.
  const maxSteps = Math.round((spec.seconds * 4) / STEP);
  let steps = 0;
  for (; steps < maxSteps; steps++) {
    m.fixedUpdate(STEP, steps * STEP, spec.ctrl(m));
    if (Math.abs(m.speed) >= target) break;
  }
  m.dispose?.();
  return steps;
}

/**
 * R2: Strength is a ramp-rate stat (`_accelMul`, checked above) - its whole
 * visible effect is *how fast* a mount gets up to speed, not how fast it ends
 * up. Stock terminal is the yardstick for both runs, so a mount whose
 * terminal speed Strength happens to leave untouched (every mount but the two
 * covered by the drift check above) still has to show the ramp getting
 * shorter, not just the `_accelMul` field getting set.
 */
test('a purchased Strength III cuts the time to reach 90% of terminal speed, for every mount', () => {
  for (const [id, C] of Object.entries(CLASSES)) {
    const terminal = terminalSpeed(id, C, {});
    const target = 0.9 * terminal;
    const t0 = stepsToReach(id, C, {}, target);
    const t3 = stepsToReach(id, C, { strength: 3 }, target);
    const ratio = t3 / t0;
    assert.ok(
      ratio < 0.95,
      `${id}: Strength III took ${t0} -> ${t3} steps to reach 90% of terminal (x${ratio.toFixed(3)}), want < 0.95`
    );
  }
});

/**
 * The two mounts whose top speed is a hard `clamp`, not a balance point. A
 * Speed tier that raised the target but not the clamp would still read x1.36
 * in the run above (the clamp is never reached from a standing start) and be
 * silently capped the moment a dive or a hill pushed the mount past it.
 */
test('Speed III raises the hard clamp on the eagle and bicycle', () => {
  // Well over the tier-3 clamp, and far enough over that one step of drag
  // cannot bring either mount back under it on its own.
  for (const [id, over] of [['eagle', 200], ['bicycle', 60]]) {
    const C = CLASSES[id];
    const clampedAt = (tier) => {
      const m = new C(ctx);
      m.applyPowers({ power: tier });
      m.spawn(new THREE.Vector3(0, RUN[id].spawnY, 0), 0);
      m.onMount?.();
      m.speed = over;
      m.fixedUpdate(STEP, 0, { throttle: 0, strafe: 0, up: 0, boost: false, yaw: m.heading, pitch: 0 });
      const v = m.speed;
      m.dispose?.();
      return v;
    };
    const s0 = clampedAt(0);
    const s3 = clampedAt(3);
    assert.ok(s0 < over * 0.9, `${id}: ${over} m/s did not land on the tier-0 clamp (${s0.toFixed(2)})`);
    assert.ok(Math.abs(s3 / s0 - 1.36) < 0.01, `${id}: clamp ${s0.toFixed(2)} -> ${s3.toFixed(2)} m/s (x${(s3 / s0).toFixed(3)})`);
  }
});

/**
 * The eagle's Strength tier has a second job: -8% stamina per beat per tier.
 * Summed over a whole level-flight run rather than sampled, because the drain
 * is per-step and a single frame's number rounds to nothing.
 */
test('Strength makes the eagle cheaper to fly (8% less stamina a tier)', () => {
  const drained = (tier) => {
    let total = 0;
    const spec = RUN.eagle;
    const m = new Eagle({ ...ctx, player: { position: new THREE.Vector3(), stamina: { drain(a) { total += a; }, exhausted: false } } });
    m.applyPowers({ strength: tier });
    m.spawn(new THREE.Vector3(0, spec.spawnY, 0), 0);
    m.onMount?.();
    const steps = Math.round(spec.seconds / STEP);
    for (let i = 0; i < steps; i++) m.fixedUpdate(STEP, i * STEP, spec.ctrl(m));
    m.dispose?.();
    return total;
  };
  const stock = drained(0);
  const strong = drained(3);
  assert.ok(stock > 0, 'the level-flight run never beat its wings');
  const ratio = strong / stock;
  assert.ok(Math.abs(ratio / 0.76 - 1) < 0.02, `Strength III drained ${stock.toFixed(1)} -> ${strong.toFixed(1)} (x${ratio.toFixed(3)}, want x0.76)`);
});

test('a mounted rider with Armour tiers takes 10% less damage per tier', () => {
  const p = Object.create(Player.prototype);
  Object.assign(p, { _dead: false, _elapsed: 10, _invulnUntil: 0, _health: 100, _maxHealth: 100, _lastDamageAt: 0, _regenCarry: 0, bus: { emit() {} }, _die() {} });
  p.mounts = { mounted: true, active: { id: 'horse', shieldTier: 2 } };
  assert.equal(p.applyDamage(50), 40);
  p.mounts = { mounted: false, active: null };
  assert.equal(p.applyDamage(50), 50);
  // No mount system at all - the menus and the intro run this way.
  p.mounts = null;
  p._health = 100; // the two hits above left only 10 to take
  assert.equal(p.applyDamage(50), 50);
});

test('Combat.mountFireMul is 1 unless riding a dragon with Fire tiers', () => {
  const c = Object.create(CombatSystem.prototype);
  c.mounts = null;
  assert.equal(c.mountFireMul, 1);
  c.mounts = { mounted: true, active: { id: 'car', fireTier: 3 } };
  assert.equal(c.mountFireMul, 1);
  c.mounts = { mounted: true, active: { id: 'dragon', fireTier: 2 } };
  assert.ok(Math.abs(c.mountFireMul - 1.3) < 1e-9);
});
