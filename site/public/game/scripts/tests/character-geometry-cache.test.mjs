import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { CharacterAssets, Humanoid } from '../../src/npc/Humanoid.js';

/* Why this file exists.
 *
 * `CharacterAssets.geoCache` memoises a merged body (and hair shell, and
 * headgear) on the full appearance combination, so two characters who roll the
 * same body, outfit, proportions and face draw the *same* BufferGeometry. That
 * sharing is deliberate and it is why `Humanoid.dispose` must not free its own
 * geometry - doing so frees a buffer other live characters are still rendering,
 * which shows up as vanished or garbled NPCs rather than as a crash.
 *
 * But the old contract - "freed by CharacterAssets" - only came true at
 * teardown, so within a session every world swap dealt a fresh cast, minted new
 * keys, and the cache grew without bound (measured 807 -> 1177 geometries over
 * ten world entries, 279 bodies and 111 hair shells alive and unreachable).
 *
 * The fix is holder counting, and these tests pin both halves of the invariant
 * that makes it safe:
 *
 *   1. a cached geometry with a live holder is NEVER disposed, and
 *   2. the cache actually shrinks when the last holder lets go.
 *
 * Only the cache layer is exercised here: `HumanoidFactory.create` bakes
 * canvas-backed textures and cannot be imported under Node (see smoke.test.mjs
 * for that constraint). What can be tested headlessly is exactly the part where
 * a mistake frees live geometry.
 */

/** Flags a geometry the moment three disposes it. */
function watch(geo) {
  const state = { disposed: false };
  geo.addEventListener('dispose', () => { state.disposed = true; });
  return state;
}

const KEY = 'body|station|rig|b1f0s1.00|f3';

test('two holders of one cached geometry get the same buffer', () => {
  const A = new CharacterAssets(null);
  let built = 0;
  const make = () => { built++; return new THREE.BoxGeometry(1, 1, 1); };
  const a = A.acquireGeometry(KEY, make);
  const b = A.acquireGeometry(KEY, make);
  assert.equal(built, 1, 'the second acquire rebuilt instead of sharing');
  assert.equal(a, b);
  assert.equal(A.geoCache.size, 1);
});

test('releasing one holder never disposes geometry a live mesh still draws', () => {
  const A = new CharacterAssets(null);
  const geo = A.acquireGeometry(KEY, () => new THREE.BoxGeometry(1, 1, 1));
  A.acquireGeometry(KEY, () => new THREE.BoxGeometry(1, 1, 1));
  const seen = watch(geo);

  // Two live characters wearing this body; one of them dies.
  const survivor = new THREE.Mesh(geo, new THREE.MeshBasicMaterial());
  assert.equal(A.releaseGeometry(KEY), false, 'released while a holder was live');

  assert.equal(seen.disposed, false, 'freed a geometry a live mesh is drawing');
  assert.equal(A.geoCache.get(KEY), geo, 'evicted an entry that still has a holder');
  assert.ok(survivor.geometry.getAttribute('position'), 'survivor lost its buffer');
});

test('the last release disposes and evicts, so the cache shrinks', () => {
  const A = new CharacterAssets(null);
  const geo = A.acquireGeometry(KEY, () => new THREE.BoxGeometry(1, 1, 1));
  A.acquireGeometry(KEY, () => new THREE.BoxGeometry(1, 1, 1));
  const seen = watch(geo);

  A.releaseGeometry(KEY);
  assert.equal(A.releaseGeometry(KEY), true, 'last release did not dispose');
  assert.equal(seen.disposed, true);
  assert.equal(A.geoCache.size, 0, 'cache kept an entry with no holders');
});

test('a style with no geometry (bald) is neither cached nor held', () => {
  const A = new CharacterAssets(null);
  assert.equal(A.acquireGeometry('hair|bald|b1', () => null), null);
  assert.equal(A.geoCache.size, 0, 'cached a null into a map dispose() walks');
  assert.equal(A.releaseGeometry('hair|bald|b1'), false);
});

test('session geometry nobody acquired is not freed by a release', () => {
  // The contact disc and the weapon shapes are set into geoCache directly and
  // belong to the session, not to any one character. A stray release must not
  // pull the InstancedMesh's buffer out from under it.
  const A = new CharacterAssets(null);
  const disc = A.contactDiscGeometry();
  const seen = watch(disc);
  assert.equal(A.releaseGeometry('contact.disc'), false);
  assert.equal(seen.disposed, false);
  assert.equal(A.contactDiscGeometry(), disc);
});

/** The minimum a Humanoid needs to be disposed without a renderer. */
function fakeHumanoid(assets, keys) {
  return new Humanoid({
    assets,
    geoKeys: keys,
    skeleton: { dispose() {} },
    root: new THREE.Group(),
  });
}

test('Humanoid.dispose hands back every key it holds', () => {
  const A = new CharacterAssets(null);
  const body = A.acquireGeometry(KEY, () => new THREE.BoxGeometry(1, 1, 1));
  const hair = A.acquireGeometry('hair|short|b1', () => new THREE.BoxGeometry(1, 1, 1));
  const seenBody = watch(body);
  const seenHair = watch(hair);

  fakeHumanoid(A, [KEY, 'hair|short|b1']).dispose();

  assert.equal(seenBody.disposed, true);
  assert.equal(seenHair.disposed, true);
  assert.equal(A.geoCache.size, 0);
});

test('a double dispose cannot free a body another character is wearing', () => {
  // Two NPCs rolled the same appearance. Disposing one of them twice would
  // otherwise hand back two holds for one, and the survivor would render a
  // freed buffer.
  const A = new CharacterAssets(null);
  const geo = A.acquireGeometry(KEY, () => new THREE.BoxGeometry(1, 1, 1));
  A.acquireGeometry(KEY, () => new THREE.BoxGeometry(1, 1, 1));
  const seen = watch(geo);

  const doomed = fakeHumanoid(A, [KEY]);
  doomed.dispose();
  doomed.dispose();

  assert.equal(seen.disposed, false, 'double dispose freed the survivor\'s body');
  assert.equal(A.geoCache.get(KEY), geo);
});

test('replaceHeldGeometry moves a hold without dropping the shell being worn', () => {
  const A = new CharacterAssets(null);
  const shortHair = A.acquireGeometry('hair|short|b1', () => new THREE.BoxGeometry(1, 1, 1));
  const h = fakeHumanoid(A, ['hair|short|b1']);
  h.hairKey = 'hair|short|b1';
  const seenShort = watch(shortHair);

  // Re-selecting the style already worn: acquire then replace, count 1->2->1.
  A.acquireGeometry('hair|short|b1', () => new THREE.BoxGeometry(1, 1, 1));
  h.replaceHeldGeometry('hair|short|b1', 'hair|short|b1');
  assert.equal(seenShort.disposed, false, 'freed the shell the player is wearing');
  assert.deepEqual(h.geoKeys, ['hair|short|b1'], 'key list drifted on a no-op swap');

  // A real swap: the dropped style goes as soon as nobody wears it.
  const longHair = A.acquireGeometry('hair|long|b1', () => new THREE.BoxGeometry(1, 1, 1));
  h.replaceHeldGeometry('hair|short|b1', 'hair|long|b1');
  assert.equal(seenShort.disposed, true, 'the abandoned style was kept forever');
  assert.deepEqual(h.geoKeys, ['hair|long|b1']);
  assert.equal(A.geoCache.get('hair|long|b1'), longHair);

  h.dispose();
  assert.equal(A.geoCache.size, 0);
});

test('the cache does not grow across repeated world swaps', () => {
  // The defect this file exists for: ten world entries, a fresh cast each time,
  // and the cache used to keep every combination that had ever been rolled.
  const A = new CharacterAssets(null);
  const sizes = [];
  let cast = [];
  for (let entry = 0; entry < 10; entry++) {
    // NPCManager.clear() disposes the outgoing cast before the new one spawns.
    for (const h of cast) h.dispose();
    cast = [];
    for (let i = 0; i < 16; i++) {
      // A new appearance combination every time - the worst case for a cache
      // keyed on the combination.
      const key = `body|w${entry}|n${i}`;
      A.acquireGeometry(key, () => new THREE.BoxGeometry(1, 1, 1));
      // Every character in the world shares the four eye geometries.
      for (const eye of ['eye.sclera', 'eye.iris', 'eye.lidUp', 'eye.lidLow']) {
        A.acquireGeometry(eye, () => new THREE.SphereGeometry(0.01, 6, 4));
      }
      cast.push(fakeHumanoid(A, [key, 'eye.sclera', 'eye.iris', 'eye.lidUp', 'eye.lidLow']));
    }
    sizes.push(A.geoCache.size);
  }
  assert.deepEqual(
    sizes,
    new Array(10).fill(20),
    `cache size drifted across world entries: ${sizes.join(', ')}`
  );
  for (const h of cast) h.dispose();
  assert.equal(A.geoCache.size, 0);
});
