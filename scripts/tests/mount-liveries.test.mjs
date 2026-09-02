import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
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
import { Marketplace } from '../../src/systems/Marketplace.js';

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

test('deserialize drops slot ids the mount does not declare', () => {
  // A save written when a slot existed (or hand-edited) must not resurrect it:
  // the load path needs the same guard setLivery applies, or the F10 menu ends
  // up showing a slot no mount can paint.
  const { mgr } = manager();
  mgr.deserialize({ liveries: { car: { bogus: { color: 1 }, paint: { color: 0x0a0b0c } } } });
  assert.deepEqual(mgr.getLivery('car'), { paint: { color: 0x0a0b0c } });
});

test('grantPower ignores a stat the mount does not sell', () => {
  const { mgr, emitted } = manager();
  mgr.grantPower('horse', 'fire', 2);
  assert.deepEqual(mgr.getPowers('horse'), {}, 'a horse has no Fire ladder');
  assert.equal(emitted.filter(([n]) => n === 'mount:powers').length, 0, 'and nothing was persisted');
  mgr.grantPower('dragon', 'fire', 2);
  assert.deepEqual(mgr.getPowers('dragon'), { fire: 2 });
  assert.equal(emitted.filter(([n]) => n === 'mount:powers').length, 1);
});

test('deserialize drops a stat the mount does not sell', () => {
  const { mgr } = manager();
  mgr.deserialize({ powers: { horse: { fire: 3, power: 2 } } });
  assert.deepEqual(mgr.getPowers('horse'), { power: 2 });
});

test('deserialize does not persist an empty powers bag when every stat was filtered', () => {
  const { mgr } = manager();
  mgr.deserialize({ powers: { horse: { fire: 3 } } });
  assert.deepEqual(mgr.getPowers('horse'), {});
  // Not merely empty when read - absent, exactly as grantPower would leave it:
  // it never allocates `_powers[mountId]` until a stat actually sticks.
  assert.equal('horse' in mgr.getPowers(), false);
});

test('Marketplace.preview refuses a mount power row the mount does not sell', () => {
  const { mgr } = manager();
  const market = Object.create(Marketplace.prototype);
  Object.assign(market, { economy: { credits: 9999 }, inventory: null, cosmetics: null, mounts: mgr });
  const row = (mount) => ({
    id: 'x',
    quantity: null,
    cost_buy: 100,
    action_config: { effect: 'grant_mount_power', mount, power: 'fire', tier: 1 },
  });
  // A horse sells no Fire ladder - a mis-authored catalog row must be
  // unavailable, not sold and then dropped by grantPower.
  const bad = market.preview(row('horse'));
  assert.equal(bad.ok, false);
  assert.equal(bad.reason, 'unsupported');
  // The dragon does sell it, so the same shape previews fine.
  const good = market.preview(row('dragon'));
  assert.equal(good.ok, true);
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

/**
 * CONTRACT CHANGE, DELIBERATE: `deserialize` returns a boolean now.
 *
 * This test used to pin the opposite - "deserialize still returns undefined
 * (SaveGame relies on the falsy fall-through)" - and the belief it recorded was
 * wrong. `SaveGame._restoreMounts` reads:
 *
 *     if (snap.custom && mounts.deserialize?.(snap.custom)) return true;
 *
 * `undefined` does not "fall through" to anything useful there. It falls
 * through to `snap.active`, which is `undefined` for every save this build
 * writes - `serialize()` puts `active` INSIDE the custom blob - and then to an
 * `else` branch that DISMOUNTS the player. Quit mid-flight on the dragon,
 * reload, and you were standing on the concourse. The old assertion was
 * protecting the bug.
 *
 * So: true when a payload was read, false when there was nothing to read. The
 * return value is the contract every other probe-first `deserialize` in this
 * codebase already keeps, and `SaveGame` now also calls `restorePending()` on
 * the true branch - the deferred summon that had no caller anywhere.
 */
test('deserialize reports whether it read anything, so SaveGame can act on it', () => {
  const { mgr } = manager();
  assert.equal(mgr.deserialize({ unlocked: ['car'] }), true);
  assert.equal(mgr.deserialize(null), false);
  assert.equal(mgr.deserialize(undefined), false);
  assert.equal(mgr.deserialize('not an object'), false);
});

test('the mount that was out is parked by deserialize and summoned by restorePending', () => {
  /* The deferral is real and load-bearing - a mount cannot be placed until the
   * world it goes in is live - but nothing in the entire codebase called the
   * second half, so the id was parked and dropped. */
  const { mgr } = manager();
  const summoned = [];
  mgr.summon = (id) => { summoned.push(id); return true; };

  mgr.deserialize({ unlocked: ['dragon'], active: 'dragon' });
  assert.deepEqual(summoned, [], 'deserialize summoned before the world was up');
  mgr.restorePending();
  assert.deepEqual(summoned, ['dragon'], 'the parked mount was never summoned');
  // Idempotent: it clears its own pending id, so a second call does nothing.
  mgr.restorePending();
  assert.deepEqual(summoned, ['dragon'], 'restorePending summoned twice');
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

import { itemDef, skinItemId, skinIdFromItem, itemIconSVG, KIND_ACCENT, MOUNT_ABBR } from '../../src/systems/ItemDefs.js';

test('every mount skin has a stack-1 kind:skin item and the id helpers round-trip', () => {
  assert.ok(KIND_ACCENT.skin);
  for (const s of MOUNT_SKINS) {
    const iid = skinItemId(s.id);
    assert.equal(iid, `skin_${s.id}`);
    const def = itemDef(iid);
    assert.ok(def, iid);
    assert.equal(def.kind, 'skin');
    assert.equal(def.stack, 1);
    assert.equal(skinIdFromItem(iid), s.id);
    assert.ok(itemIconSVG(iid).includes('<svg'));
  }
  assert.equal(skinIdFromItem('medkit'), null);
  assert.equal(skinIdFromItem('skin_not_a_skin'), null);
});

import { applyMountSkin } from '../../src/systems/MountSkins.js';

function skinDeps({ mounted = 'dragon', owned = [], bag = {}, store = {} } = {}) {
  const liveries = {};
  const unlocked = new Set(owned);
  const mounts = {
    get mounted() { return !!mounted; },
    get active() { return mounted ? { id: mounted } : null; },
    setLivery: (id, patch) => { liveries[id] = { ...(liveries[id] || {}), ...patch }; },
  };
  const cosmetics = { has: (id) => unlocked.has(id), unlock: (id) => { if (unlocked.has(id)) return false; unlocked.add(id); return true; } };
  const inventory = {
    bagCount: (id) => bag[id] ?? 0,
    count: (id) => store[id] ?? 0,
    totalCount: (id) => (bag[id] ?? 0) + (store[id] ?? 0),
    consumeFromBag: (id, n) => { if ((bag[id] ?? 0) < n) return false; bag[id] -= n; return true; },
    remove: (id, n) => { const k = Math.min(n, store[id] ?? 0); store[id] = (store[id] ?? 0) - k; return k; },
  };
  return { deps: { mounts, cosmetics, inventory, bus: { emit() {} } }, liveries, unlocked, bag, store };
}

test('applyMountSkin: unknown / not mounted / wrong mount refuse and consume nothing', () => {
  assert.equal(applyMountSkin(skinDeps().deps, 'nope').reason, 'unknown-skin');
  assert.equal(applyMountSkin(skinDeps({ mounted: null }).deps, 'dragon_frost').reason, 'not-mounted');
  const s = skinDeps({ mounted: 'horse', bag: { skin_dragon_frost: 1 } });
  assert.equal(applyMountSkin(s.deps, 'dragon_frost').reason, 'wrong-mount');
  assert.equal(s.bag.skin_dragon_frost, 1);
});

test('applyMountSkin: owned applies without touching the inventory', () => {
  const s = skinDeps({ owned: ['dragon_frost'], bag: { skin_dragon_frost: 1 } });
  assert.deepEqual(applyMountSkin(s.deps, 'dragon_frost'), { ok: true, consumed: false });
  assert.equal(s.bag.skin_dragon_frost, 1);
  assert.equal(s.liveries.dragon.hide.color, 0xbfe6f2);
});

test('applyMountSkin: in bag consumes exactly one, unlocks, applies', () => {
  const s = skinDeps({ bag: { skin_dragon_frost: 2 } });
  assert.deepEqual(applyMountSkin(s.deps, 'dragon_frost'), { ok: true, consumed: true });
  assert.equal(s.bag.skin_dragon_frost, 1);
  assert.ok(s.unlocked.has('dragon_frost'));
  assert.equal(s.liveries.dragon.saddle.color, 0x1f6fd0);
});

test('applyMountSkin: only in store consumes one from the store', () => {
  const s = skinDeps({ store: { skin_dragon_frost: 1 } });
  assert.deepEqual(applyMountSkin(s.deps, 'dragon_frost'), { ok: true, consumed: true });
  assert.equal(s.store.skin_dragon_frost, 0);
  assert.ok(s.unlocked.has('dragon_frost'));
});

test('applyMountSkin: neither owned nor held refuses with not-owned', () => {
  const s = skinDeps();
  assert.equal(applyMountSkin(s.deps, 'dragon_frost').reason, 'not-owned');
  assert.equal(s.unlocked.size, 0);
});

import { ItemUseSystem } from '../../src/systems/ItemUse.js';

test('ItemUse routes skin items through applyMountSkin and never the generic consume', () => {
  const s = skinDeps({ bag: { skin_dragon_frost: 1 } });
  const notes = [];
  const iu = new ItemUseSystem({ bus: { emit: (n, p) => notes.push([n, p]) }, player: {}, inventory: s.deps.inventory, mounts: s.deps.mounts, cosmetics: s.deps.cosmetics });
  assert.equal(iu.use('skin_dragon_frost').ok, true);
  assert.equal(s.bag.skin_dragon_frost, 0);
  assert.ok(notes.some(([n, p]) => n === 'inventory:item-used' && p.itemId === 'skin_dragon_frost'));
  const s2 = skinDeps({ mounted: null, bag: { skin_dragon_frost: 1 } });
  const notes2 = [];
  const iu2 = new ItemUseSystem({ bus: { emit: (n, p) => notes2.push([n, p]) }, player: {}, inventory: s2.deps.inventory, mounts: s2.deps.mounts, cosmetics: s2.deps.cosmetics });
  assert.equal(iu2.use('skin_dragon_frost').ok, false);
  assert.equal(s2.bag.skin_dragon_frost, 1);
  assert.ok(notes2.some(([n, p]) => n === 'hud:notify' && /Customise mount/.test(p.text)));
});

test('Marketplace.preview refuses a skin item that is already unlocked or already held', () => {
  const held = { skin_bike_chrome: 0 };
  const inventory = { roomFor: () => 30, totalCount: (id) => held[id] ?? 0, count: () => 0, bagCount: () => 0 };
  const cosmetics = { has: (id) => id === 'bike_racing' };
  const m = Object.create(Marketplace.prototype);
  // `credits` is a prototype getter over economy.credits, so this is enough.
  Object.assign(m, { economy: { credits: 9999 }, inventory, cosmetics, mounts: null, bus: null });
  const row = (item) => ({ id: 'x', source_key: 'skin_x', quantity: null, cost_buy: 100, action_config: { effect: 'grant_item', item_id: item } });
  assert.equal(m.preview(row('skin_bike_chrome')).ok, true);
  held.skin_bike_chrome = 1;
  const p = m.preview(row('skin_bike_chrome'));
  assert.equal(p.ok, false); assert.equal(p.reason, 'owned'); assert.equal(p.skin, true);
  const q = m.preview(row('skin_bike_racing'));
  assert.equal(q.ok, false); assert.equal(q.reason, 'owned'); assert.equal(q.skin, true);
  assert.equal(m.preview(row('medkit')).ok, true);
});

test('applyMountSkin: a no-op ledger (cosmetics missing) refuses before consuming anything', () => {
  const s = skinDeps({ bag: { skin_dragon_frost: 1 } });
  const broken = { ...s.deps, cosmetics: null };
  const res = applyMountSkin(broken, 'dragon_frost');
  assert.equal(res.ok, false);
  assert.equal(res.reason, 'unavailable');
  assert.equal(s.bag.skin_dragon_frost, 1, 'nothing was taken from the bag');
});

test('ItemUse: an already-owned skin applies without a player and without emitting inventory:item-used', () => {
  // Skins need inventory/mounts/cosmetics, not the player, so this must work
  // with no `player` at all - and since applyMountSkin reports consumed:false
  // for an already-owned skin, nothing should have been taken from the bag.
  const s = skinDeps({ owned: ['dragon_frost'], bag: { skin_dragon_frost: 1 } });
  const notes = [];
  const iu = new ItemUseSystem({ bus: { emit: (n, p) => notes.push([n, p]) }, inventory: s.deps.inventory, mounts: s.deps.mounts, cosmetics: s.deps.cosmetics });
  const res = iu.use('skin_dragon_frost');
  assert.equal(res.ok, true);
  assert.equal(res.consumed, false);
  assert.equal(s.bag.skin_dragon_frost, 1, 'bag untouched');
  assert.ok(!notes.some(([n]) => n === 'inventory:item-used'), 'nothing was consumed, so nothing was used');
});

test('Marketplace.buy early return forwards skin:true for a held skin', () => {
  const held = { skin_bike_chrome: 1 };
  const inventory = { roomFor: () => 30, totalCount: (id) => held[id] ?? 0, count: () => 0, bagCount: () => 0 };
  const cosmetics = { has: () => false };
  const m = Object.create(Marketplace.prototype);
  Object.assign(m, {
    economy: { credits: 9999, spend: () => { throw new Error('a refused buy must never spend'); } },
    inventory, cosmetics, mounts: null, bus: null,
    _catalog: [{ id: 'x', source_key: 'skin_x', quantity: null, cost_buy: 100, action_config: { effect: 'grant_item', item_id: 'skin_bike_chrome' } }],
  });
  const res = m.buy('x');
  assert.equal(res.ok, false);
  assert.equal(res.reason, 'owned');
  assert.equal(res.skin, true);
  assert.equal(res.power, false);
});

test('Marketplace.buy early return forwards power:true when the tier is already owned', () => {
  const { mgr } = manager();
  mgr.grantPower('dragon', 'fire', 3);
  const m = Object.create(Marketplace.prototype);
  Object.assign(m, {
    economy: { credits: 9999, spend: () => { throw new Error('a refused buy must never spend'); } },
    inventory: null, cosmetics: null, mounts: mgr, bus: null,
    _catalog: [{ id: 'p', quantity: null, cost_buy: 100, action_config: { effect: 'grant_mount_power', mount: 'dragon', power: 'fire', tier: 1 } }],
  });
  const res = m.buy('p');
  assert.equal(res.ok, false);
  assert.equal(res.reason, 'owned');
  assert.equal(res.power, true);
  assert.equal(res.skin, false);
});

test('Marketplace.preview: the owned-skin guard runs before the room check', () => {
  const held = { skin_bike_chrome: 1 };
  const inventory = { roomFor: () => 0, totalCount: (id) => held[id] ?? 0, count: () => 0, bagCount: () => 0 };
  const cosmetics = { has: () => false };
  const m = Object.create(Marketplace.prototype);
  Object.assign(m, { economy: { credits: 9999 }, inventory, cosmetics, mounts: null, bus: null });
  const row = { id: 'x', source_key: 'skin_x', quantity: null, cost_buy: 100, action_config: { effect: 'grant_item', item_id: 'skin_bike_chrome' } };
  const p = m.preview(row);
  assert.equal(p.ok, false);
  assert.equal(p.reason, 'owned');
  assert.equal(p.skin, true);
});

test('deserialize: an empty-after-filter powers bag clears an existing bag for that mount id', () => {
  // Replace semantics: a save that filters to nothing for a mount id must not
  // leave a stale bag in place from an earlier deserialize() call.
  const { mgr } = manager();
  mgr.deserialize({ powers: { dragon: { fire: 2 } } });
  assert.deepEqual(mgr.getPowers('dragon'), { fire: 2 });
  mgr.deserialize({ powers: { dragon: { notARealStat: 9 } } });
  assert.deepEqual(mgr.getPowers('dragon'), {});
  assert.equal('dragon' in mgr.getPowers(), false);
});

test('mount skin bag items prefix `short` with the mount\'s declared MOUNT_ABBR entry', () => {
  const mounts = new Set(MOUNT_SKINS.map((s) => s.mount));
  for (const m of mounts) assert.ok(MOUNT_ABBR[m], `MOUNT_ABBR missing entry for ${m}`);
  for (const s of MOUNT_SKINS) {
    const def = itemDef(skinItemId(s.id));
    assert.equal(def.short, `${MOUNT_ABBR[s.mount]} SKN`, s.id);
  }
});

test('the ItemDefs -> Cosmetics edge stays one-way, and Cosmetics only ever reaches leaves', () => {
  /* ── THIS CASE USED TO SAY `Cosmetics.js` CONTAINS NO IMPORT AT ALL ──────
   *
   * That was a proxy for the thing that actually matters, which is that
   * `ItemDefs` imports `Cosmetics` and the reverse edge must never exist or
   * the catalogue is a cycle. "No imports" is the cheapest way to guarantee
   * that and it held for as long as the wardrobe only knew about characters
   * and mounts.
   *
   * It stopped holding when ship liveries joined the ledger. Their ids live in
   * `ships/ShipStats.js`, beside the eighteen rows they guard and next to the
   * hull tables that give them meaning - that file's own header explains why
   * they cannot move into `mounts/Livery.js`, and moving them into THIS file
   * would be a wardrobe carrying its own copy of a catalogue it does not own,
   * which goes stale the first time a livery is renamed and fails silently
   * when it does.
   *
   * So the proxy is replaced by the invariant it stood for, which is strictly
   * stronger than the old line: `Cosmetics` may not import `ItemDefs`, may not
   * reach into `systems/` at all, and everything it DOES import must itself be
   * import-free - a leaf. A leaf cannot close a cycle, and checking the leaves
   * catches the case the old rule could not: an allowed-looking import that
   * pulls a subtree in behind it. */
  const at = (rel) => fileURLToPath(new URL(`../../src/${rel}`, import.meta.url));
  const importsOf = (src) => [...src.matchAll(/^import\s[^;]*?from\s+'([^']+)'/gm)].map((m) => m[1]);

  const src = readFileSync(at('systems/Cosmetics.js'), 'utf8');
  const specs = importsOf(src);

  assert.ok(!specs.some((s) => /ItemDefs/.test(s)),
    'Cosmetics imports ItemDefs, which closes the cycle this rule exists to prevent');
  assert.ok(!specs.some((s) => s.startsWith('./')),
    `Cosmetics reaches sideways into systems/ (${specs.filter((s) => s.startsWith('./')).join(', ')})`);

  for (const spec of specs) {
    const rel = spec.replace(/^\.\.\//, '');
    const leaf = readFileSync(at(rel), 'utf8');
    assert.deepEqual(importsOf(leaf), [],
      `Cosmetics imports ${spec}, which is not a leaf - it pulls a whole subtree in behind it`);
  }
});
