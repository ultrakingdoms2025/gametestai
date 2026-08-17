import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import {
  FINISH_PROPS, MOUNT_STATS, normColor, applyLivery, liveryMatches,
} from '../../src/mounts/Livery.js';

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
