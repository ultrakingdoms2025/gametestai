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
const RUN = {
  car: { seconds: 12, spawnY: 0, ctrl: (m) => ({ throttle: 1, strafe: 0, up: 0, boost: true, yaw: m.heading, pitch: 0 }) },
  horse: { seconds: 12, spawnY: 0, ctrl: (m) => ({ throttle: 1, strafe: 0, up: 0, boost: true, yaw: m.heading, pitch: 0 }) },
  hoverboard: { seconds: 12, spawnY: 0, ctrl: (m) => ({ throttle: 1, strafe: 0, up: 0, boost: true, yaw: m.heading, pitch: 0 }) },
  bicycle: { seconds: 20, spawnY: 0, ctrl: (m) => ({ throttle: 1, strafe: 0, up: 0, boost: true, yaw: m.heading, pitch: 0 }) },
  // Level flight, beating: steady speed is set by thrust vs v^2 drag. (Eagle.spawn ignores
  // position.y and places the bird at ground + 6.5; altitude does not enter its speed model.)
  eagle: { seconds: 15, spawnY: 250, ctrl: (m) => ({ throttle: 0, strafe: 0, up: 0, boost: true, yaw: m.heading, pitch: 0 }) },
  dragon: { seconds: 15, spawnY: 30, flying: true, ctrl: (m) => ({ throttle: 1, strafe: 0, up: 1, boost: true, yaw: m.heading, pitch: 0 }) },
};

function terminalSpeed(id, C, powers) {
  const spec = RUN[id];
  const m = new C(ctx);
  m.applyPowers(powers);
  m.spawn(new THREE.Vector3(0, spec.spawnY, 0), 0);
  if (spec.flying) { m.state = 'flying'; m.position.y = spec.spawnY; m._groundY = 0; }
  m.onMount?.();
  const steps = Math.round(spec.seconds / STEP);
  for (let i = 0; i < steps; i++) m.fixedUpdate(STEP, i * STEP, spec.ctrl(m));
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
