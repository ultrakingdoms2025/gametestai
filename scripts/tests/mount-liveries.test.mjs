import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import {
  FINISH_PROPS, MOUNT_STATS, normColor, applyLivery, liveryMatches, cloneLivery,
} from '../../src/mounts/Livery.js';

const matCache = new Map();
const materials = {
  has: () => true,
  get: (k) => { if (!matCache.has(k)) matCache.set(k, new THREE.MeshStandardMaterial()); return matCache.get(k); },
  register: (k, m) => matCache.set(k, m),
  tinted: (k) => materials.get(k),
};
const bus = { on() {}, off() {}, emit() {} };
const scene = new THREE.Scene();
const ctx = { scene, engine: null, physics: { groundHeight: () => 0, resolveCapsule: (p) => p, sphereCast: () => null, raycast: () => null, colliders: [] }, bus, materials, camera: null };

/**
 * The livery helper is the one place colour and finish are written onto a
 * mount's materials, so it is checked headlessly: a factory restore that
 * forgot roughness would ship a permanently glossy horse without any test
 * noticing in play.
 */

const SLOTS = [
  { id: 'body', label: 'Body', finish: true, defaultColor: 0x112233, palette: 'paint' },
  { id: 'glow', label: 'Glow', finish: false, defaultColor: 0x00ffff, palette: 'glow' },
];

function fresh() {
  const body = new THREE.MeshStandardMaterial({ color: 0x112233, roughness: 0.5, metalness: 0.2 });
  body.envMapIntensity = 0.8;
  const skirt = new THREE.MeshStandardMaterial({ color: 0x445566, roughness: 0.5, metalness: 0.2 });
  const glow = new THREE.MeshBasicMaterial({ color: 0x00ffff });
  const lit = new THREE.MeshStandardMaterial({ color: 0x00ffff, emissive: 0x00ffff });
  return { body, skirt, glow, lit, mats: { body: [body, { mat: skirt, mix: 0.5 }], glow: [glow, { mat: lit, emissive: true }] } };
}

test('normColor accepts numbers and #hex strings', () => {
  assert.equal(normColor(0xff0000), 0xff0000);
  assert.equal(normColor('#00ff00'), 0x00ff00);
  assert.equal(normColor('0000ff'), 0x0000ff);
  assert.equal(normColor('nope'), null);
  assert.equal(normColor(null), null);
});

test('applyLivery tints, mixes, sets emissive, and applies a finish', () => {
  const f = fresh();
  applyLivery({ body: { color: 0xff0000, finish: 'matt' }, glow: { color: 0xff00ff } }, SLOTS, f.mats);
  assert.equal(f.body.color.getHex(), 0xff0000);
  assert.equal(f.body.roughness, FINISH_PROPS.matt.roughness);
  assert.equal(f.body.metalness, FINISH_PROPS.matt.metalness);
  assert.equal(f.body.envMapIntensity, FINISH_PROPS.matt.envMapIntensity);
  // 50% mix from factory 0x445566 toward 0xff0000. Three's ColorManagement is
  // on, so setHex() lands in linear space and lerp() blends linear values -
  // build the expectation the same way rather than hand-computing an sRGB midpoint.
  const exp = new THREE.Color(0x445566).lerp(new THREE.Color(0xff0000), 0.5);
  assert.equal(f.skirt.color.getHex(), exp.getHex());
  assert.equal(f.glow.color.getHex(), 0xff00ff);
  assert.equal(f.lit.emissive.getHex(), 0xff00ff);
});

test('applyLivery with an empty livery restores factory colour and finish', () => {
  const f = fresh();
  applyLivery({ body: { color: 0xff0000, finish: 'gloss' } }, SLOTS, f.mats);
  applyLivery({}, SLOTS, f.mats);
  assert.equal(f.body.color.getHex(), 0x112233);
  assert.equal(f.body.roughness, 0.5);
  assert.equal(f.body.metalness, 0.2);
  assert.equal(f.body.envMapIntensity, 0.8);
  assert.equal(f.skirt.color.getHex(), 0x445566);
});

test('a slot with finish:false ignores a finish request', () => {
  const f = fresh();
  applyLivery({ glow: { color: 0x123456, finish: 'matt' } }, SLOTS, f.mats);
  const stock = new THREE.MeshStandardMaterial();
  assert.equal(f.lit.roughness, stock.roughness);
  assert.equal(f.lit.metalness, stock.metalness);
  assert.equal(f.lit.envMapIntensity, stock.envMapIntensity);
});

test('liveryMatches compares colour, and finish only when the skin sets one', () => {
  const skin = { body: { color: 0xff0000, finish: 'gloss' }, glow: { color: 0x00ff00 } };
  assert.equal(liveryMatches({ body: { color: 0xff0000, finish: 'gloss' }, glow: { color: 0x00ff00, finish: 'matt' } }, skin), true);
  assert.equal(liveryMatches({ body: { color: 0xff0000 }, glow: { color: 0x00ff00 } }, skin), false);
  assert.equal(liveryMatches({ body: { color: 0xff0001, finish: 'gloss' }, glow: { color: 0x00ff00 } }, skin), false);
  assert.equal(liveryMatches({}, skin), false);
});

test('MOUNT_STATS lists the ladder for all six mounts, fire only on the dragon', () => {
  for (const id of ['car', 'dragon', 'eagle', 'horse', 'hoverboard', 'bicycle']) {
    assert.ok(Array.isArray(MOUNT_STATS[id]), id);
    for (const s of ['power', 'strength', 'shield']) assert.ok(MOUNT_STATS[id].includes(s), `${id} ${s}`);
    assert.equal(MOUNT_STATS[id].includes('fire'), id === 'dragon', `${id} fire`);
  }
});

test('cloneLivery sanitises: drops junk slots, normalises hex strings, rejects unknown finishes', () => {
  const out = cloneLivery({ a: { color: '#ff0000', finish: 'gloss' }, b: { color: 'nope', finish: 'shiny' }, c: null, d: 'x', e: { color: 0x123456, finish: 'matt' } });
  assert.deepEqual(out, { a: { color: 0xff0000, finish: 'gloss' }, e: { color: 0x123456, finish: 'matt' } });
  assert.deepEqual(cloneLivery(null), {});
});
test('normColor rejects out-of-range numbers', () => {
  assert.equal(normColor(-1), null);
  assert.equal(normColor(0x1000000), null);
  assert.equal(normColor(1.5), null);
});

import { MountManager } from '../../src/mounts/MountManager.js';

const stubPlayer = { position: new THREE.Vector3(), stamina: null };
function manager() {
  const emitted = [];
  const mbus = { on() {}, off() {}, emit: (n, p) => emitted.push([n, p]) };
  const mgr = new MountManager({
    scene: new THREE.Scene(), engine: null, physics: { groundHeight: () => 0, resolveCapsule: (p) => p, sphereCast: () => null, colliders: [] },
    bus: mbus, materials, camera: null, player: stubPlayer, cameraRig: null, avatar: null, npcManager: null, worldManager: null,
  });
  return { mgr, emitted };
}

test('setLivery is per mount, normalises colours, and emits mount:livery with the mount id', () => {
  const { mgr, emitted } = manager();
  mgr.setLivery('horse', { coat: { color: '#ff0000', finish: 'matt' } });
  mgr.setLivery('car', { paint: { color: 0x00ff00 } });
  assert.deepEqual(mgr.getLivery('horse'), { coat: { color: 0xff0000, finish: 'matt' } });
  assert.deepEqual(mgr.getLivery('car'), { paint: { color: 0x00ff00 } });
  assert.deepEqual(mgr.getLivery('dragon'), {});
  const ev = emitted.filter(([n]) => n === 'mount:livery');
  assert.equal(ev.length, 2);
  assert.equal(ev[0][1].mountId, 'horse');
  assert.deepEqual(ev[0][1].livery, { coat: { color: 0xff0000, finish: 'matt' } });
  // getLivery is a copy
  mgr.getLivery('horse').coat.color = 1;
  assert.equal(mgr.getLivery('horse').coat.color, 0xff0000);
});

test('setLivery with finish:null clears the finish; resetLivery clears the mount', () => {
  const { mgr } = manager();
  mgr.setLivery('bicycle', { frame: { color: 0x123456, finish: 'gloss' } });
  mgr.setLivery('bicycle', { frame: { finish: null } });
  assert.deepEqual(mgr.getLivery('bicycle'), { frame: { color: 0x123456 } });
  mgr.resetLivery('bicycle');
  assert.deepEqual(mgr.getLivery('bicycle'), {});
});

test('setLivery ignores slot ids the mount does not declare', () => {
  const { mgr, emitted } = manager();
  mgr.setLivery('car', { bogus: { color: 0x010203 }, paint: { color: 0x0a0b0c } });
  assert.deepEqual(mgr.getLivery('car'), { paint: { color: 0x0a0b0c } });
  const n = emitted.filter(([e]) => e === 'mount:livery').length;
  mgr.setLivery('car', { bogus: { color: 0x010203 } });
  assert.equal(emitted.filter(([e]) => e === 'mount:livery').length, n, 'an all-unknown patch is a no-op');
});

test('serialize writes liveries and deserialize round-trips them', () => {
  const { mgr } = manager();
  mgr.setLivery('eagle', { plumage: { color: 0xabcdef }, harness: { color: 0x010203, finish: 'gloss' } });
  const snap = JSON.parse(JSON.stringify(mgr.serialize()));
  assert.ok(snap.liveries, 'liveries key');
  assert.equal('livery' in snap, false, 'legacy livery key is gone');
  const { mgr: m2 } = manager();
  m2.deserialize(snap);
  assert.deepEqual(m2.getLivery('eagle'), { plumage: { color: 0xabcdef }, harness: { color: 0x010203, finish: 'gloss' } });
});

test('a legacy flat car livery migrates into liveries.car', () => {
  const { mgr } = manager();
  mgr.deserialize({ unlocked: ['car'], livery: { paint: 0xc21f2f, wheel: 0xe0b23a }, powers: {} });
  assert.deepEqual(mgr.getLivery('car'), { paint: { color: 0xc21f2f }, wheel: { color: 0xe0b23a } });
});

test('deserialize still returns undefined (SaveGame relies on the falsy fall-through)', () => {
  const { mgr } = manager();
  assert.equal(mgr.deserialize({ unlocked: ['car'] }), undefined);
});

test('setLivery hands the mount its livery in the nested shape, and no-op patches do not emit', () => {
  const { mgr, emitted } = manager();
  const calls = [];
  mgr._mounts.set('car', { applyCustomization: (l) => calls.push(JSON.parse(JSON.stringify(l))) });
  mgr.setLivery('car', { paint: { color: 0xc21f2f } });
  assert.deepEqual(calls.at(-1), { paint: { color: 0xc21f2f } });
  const before = emitted.filter(([n]) => n === 'mount:livery').length;
  mgr.setLivery('car', {});
  mgr.setLivery('car', { paint: { color: 'not-a-colour' } });
  mgr.resetLivery('horse');
  assert.equal(emitted.filter(([n]) => n === 'mount:livery').length, before, 'no-ops must not persist');
  assert.equal(calls.length, 1);
});

import { Car } from '../../src/mounts/Car.js';

test('Car declares slots/stats and tints its cloned paint and wheel materials', () => {
  assert.deepEqual(Car.CUSTOM_SLOTS.map((s) => s.id), ['paint', 'wheel']);
  assert.deepEqual(Car.STATS, MOUNT_STATS.car);
  const car = new Car(ctx);
  car.applyCustomization({ paint: { color: 0xff3bd2, finish: 'matt' }, wheel: { color: 0x2fe0ff } });
  assert.equal(car._slotMats.paint[0].color.getHex(), 0xff3bd2);
  assert.equal(car._slotMats.paint[0].roughness, FINISH_PROPS.matt.roughness);
  assert.equal(car._slotMats.paint[0].metalness, FINISH_PROPS.matt.metalness);
  assert.equal(car._slotMats.wheel[0].color.getHex(), 0x2fe0ff);
  car.applyCustomization({});
  assert.equal(car._slotMats.paint[0].roughness, car._slotMats.paint[0].userData.factory.roughness);
  car.dispose();
});

import { MOUNT_SKINS, MOUNT_SKINS_BY_ID, skinsForMount, Cosmetics } from '../../src/systems/Cosmetics.js';

test('MOUNT_SKINS: 20 skins, 5 car ids preserved, 3 per other mount, unique ids', () => {
  assert.equal(MOUNT_SKINS.length, 20);
  for (const id of ['car_neon', 'car_inferno', 'car_phantom', 'car_toxic', 'car_azure']) {
    assert.equal(MOUNT_SKINS_BY_ID.get(id)?.mount, 'car', id);
  }
  for (const m of ['dragon', 'eagle', 'horse', 'hoverboard', 'bicycle']) assert.equal(skinsForMount(m).length, 3, m);
  assert.equal(new Set(MOUNT_SKINS.map((s) => s.id)).size, 20);
  for (const s of MOUNT_SKINS) {
    assert.ok(s.name && s.blurb && s.livery && typeof s.livery === 'object', s.id);
    for (const slot in s.livery) assert.equal(typeof s.livery[slot].color, 'number', `${s.id}.${slot}`);
  }
});

test('Cosmetics.unlock accepts every mount skin id', () => {
  const c = new Cosmetics({ bus: null });
  for (const s of MOUNT_SKINS) assert.equal(c.unlock(s.id), true, s.id);
});
