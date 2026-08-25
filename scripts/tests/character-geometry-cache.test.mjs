import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import {
  CharacterAssets, Humanoid, GEO_FREE_BYTES, GEO_FREE_HARD_BYTES, geometryBytes,
  SIGN_CACHE_BYTES,
} from '../../src/npc/Humanoid.js';
import { SIGN_W, SIGN_H } from '../../src/npc/NPC.js';

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
 * ── And then the bill for (2) ─────────────────────────────────────────────
 *
 * Freeing on the last release means leaving a world frees its whole cast, and
 * re-entering lofts, welds, skins and merges every body again. Measured on the
 * production bundle that is 416 ms of a 1,278 ms station crossing, spent
 * rebuilding forty-eight bodies the player was looking at a moment earlier.
 *
 * So the last release now PARKS the entry in a free list and an acquire revives
 * it. `geoCache` still means "entries with a live holder", which is why (1) and
 * (2) above read exactly as they did - and the free list is BOUNDED, in bytes,
 * because an unbounded one is the original leak with a new name. The bound is
 * not a tuning knob; it is the safety property, and the cases at the end of
 * this file assert it directly rather than trusting the constant.
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

test('the last release evicts from the live cache and parks the buffer', () => {
  const A = new CharacterAssets(null);
  const geo = A.acquireGeometry(KEY, () => new THREE.BoxGeometry(1, 1, 1));
  A.acquireGeometry(KEY, () => new THREE.BoxGeometry(1, 1, 1));
  const seen = watch(geo);

  A.releaseGeometry(KEY);
  assert.equal(A.releaseGeometry(KEY), true, 'last release did not let go of the entry');
  assert.equal(A.geoCache.size, 0, 'cache kept an entry with no holders');
  assert.equal(seen.disposed, false, 'a parked buffer was freed, so a re-entry rebuilds it');
  assert.equal(A.freeBytes, geometryBytes(geo), 'the parked bytes were not counted');
});

test('a parked buffer is REVIVED, not rebuilt - the whole point of parking', () => {
  const A = new CharacterAssets(null);
  let built = 0;
  const make = () => { built++; return new THREE.BoxGeometry(1, 1, 1); };

  const first = A.acquireGeometry(KEY, make);
  fakeHumanoid(A, [KEY]).dispose();          // leave the world
  const again = A.acquireGeometry(KEY, make); // and come back to it

  assert.equal(built, 1, 'the re-entry rebuilt a body it had already welded');
  assert.equal(again, first, 'the revived entry is a different buffer');
  assert.equal(A.freeBytes, 0, 'a revived entry is still counted as parked');
  assert.equal(A.geoCache.get(KEY), first, 'the revived entry is not live');
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

  fakeHumanoid(A, [KEY, 'hair|short|b1']).dispose();

  // Handed back means "no longer live", which is what the leak was about. Where
  // they went - parked, and reclaimable - is the case above.
  assert.equal(A.geoCache.size, 0, 'a key was still held after the character died');
  assert.equal(A._geoRefs.size, 0, 'a holder count outlived its holder');
  assert.equal(A.freeBytes, geometryBytes(body) + geometryBytes(hair));
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

  // A real swap: the dropped style stops being held as soon as nobody wears it.
  const longHair = A.acquireGeometry('hair|long|b1', () => new THREE.BoxGeometry(1, 1, 1));
  h.replaceHeldGeometry('hair|short|b1', 'hair|long|b1');
  assert.equal(A.geoCache.has('hair|short|b1'), false, 'the abandoned style is still held');
  assert.equal(seenShort.disposed, false, 'the abandoned style was freed rather than parked');
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

/* ------------------------------------------------------------------ */
/* The bound, which is the whole design                                */
/* ------------------------------------------------------------------ */

/**
 * A geometry of a stated size, so a budget can be reasoned about in tests.
 *
 * `geometryBytes` counts attribute buffers, so a position attribute of n
 * vertices is 12n bytes and nothing else is guessing.
 */
function sized(bytes) {
  const verts = Math.max(1, Math.round(bytes / 12));
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(verts * 3), 3));
  return g;
}

test('the free list never exceeds its budget, however many casts pass through', () => {
  /* THE LEAK, RE-RUN AGAINST THE NEW POLICY. The case above proves the LIVE
   * cache does not grow; this one proves the thing that replaced disposal does
   * not grow either, which is the only way parking is not the 807 -> 1,177
   * defect wearing a different hat. */
  const A = new CharacterAssets(null);
  const MB = 1024 * 1024;
  let cast = [];
  let worst = 0;
  for (let entry = 0; entry < 40; entry++) {
    for (const h of cast) h.dispose();
    cast = [];
    for (let i = 0; i < 8; i++) {
      const key = `body|w${entry}|n${i}`;
      A.acquireGeometry(key, () => sized(4 * MB));
      cast.push(fakeHumanoid(A, [key]));
    }
    // What NPCManager.spawnForWorld does once the arriving cast is built.
    A.trimGeometry();
    worst = Math.max(worst, A.freeBytes);
  }
  assert.ok(worst <= GEO_FREE_BYTES,
    `the free list reached ${Math.round(worst / MB)} MB against a ${GEO_FREE_BYTES / MB} MB budget`);
  for (const h of cast) h.dispose();
  A.trimGeometry();
  assert.ok(A.freeBytes <= GEO_FREE_BYTES);
});

test('nothing evicts a buffer a live character is still drawing', () => {
  /* The failure that holder counting exists to prevent, asked of the evictor
   * rather than of the release path: a trim that walked `geoCache` instead of
   * the free list would free bodies out from under the cast standing in front
   * of the player, and they would garble rather than crash. */
  const A = new CharacterAssets(null);
  const MB = 1024 * 1024;
  const live = [];
  for (let i = 0; i < 30; i++) {
    const key = `live|${i}`;
    const g = A.acquireGeometry(key, () => sized(8 * MB));
    live.push({ key, g, seen: watch(g) });
  }
  // Far more parked than the budget allows, so the trim has real work to do.
  for (let i = 0; i < 30; i++) {
    const key = `dead|${i}`;
    A.acquireGeometry(key, () => sized(8 * MB));
    fakeHumanoid(A, [key]).dispose();
  }
  A.trimGeometry();

  assert.ok(A.freeBytes <= GEO_FREE_BYTES, 'the trim did not reach its budget');
  for (const l of live) {
    assert.equal(l.seen.disposed, false, `${l.key} was freed while a character held it`);
    assert.equal(A.geoCache.get(l.key), l.g, `${l.key} was evicted while held`);
    assert.ok(l.g.getAttribute('position'), `${l.key} lost its buffer`);
  }
});

test('a trim drops the least recently released first', () => {
  /* Order is not cosmetic. The free list is what a re-entry reads, and the
   * entries released LAST are the world the player just left - which is the
   * world they are most likely to walk back into. */
  const A = new CharacterAssets(null);
  const MB = 1024 * 1024;
  const seen = [];
  for (let i = 0; i < 24; i++) {
    const key = `k${i}`;
    const g = A.acquireGeometry(key, () => sized(4 * MB));
    seen.push({ key, state: watch(g) });
    fakeHumanoid(A, [key]).dispose();
  }
  A.trimGeometry();

  const survivors = seen.filter((s) => !s.state.disposed).map((s) => s.key);
  const gone = seen.filter((s) => s.state.disposed).map((s) => s.key);
  assert.ok(gone.length > 0, 'nothing was evicted, so this proves nothing');
  assert.deepEqual(survivors, seen.slice(seen.length - survivors.length).map((s) => s.key),
    `evicted out of order: kept ${survivors.join(',')} and dropped ${gone.join(',')}`);
});

test('between casts the hard ceiling holds, and it is wide enough for two', () => {
  /* `releaseGeometry` cannot trim to the ordinary budget, because a crossing
   * releases the world it is LEAVING before it acquires the world it is
   * arriving in, and at that instant the list holds both. The ceiling that does
   * apply there has to be loose enough not to throw away the arriving cast and
   * tight enough that a session of respawns cannot run away with memory. */
  const A = new CharacterAssets(null);
  const MB = 1024 * 1024;
  let peak = 0;
  for (let i = 0; i < 200; i++) {
    const key = `churn|${i}`;
    A.acquireGeometry(key, () => sized(2 * MB));
    fakeHumanoid(A, [key]).dispose();
    peak = Math.max(peak, A.freeBytes);
  }
  assert.ok(peak <= GEO_FREE_HARD_BYTES,
    `release-time churn reached ${Math.round(peak / MB)} MB with no world change to trim it`);
  assert.ok(GEO_FREE_HARD_BYTES >= GEO_FREE_BYTES * 2,
    'the between-casts ceiling cannot hold the departing cast and the arriving one');
});

/* ------------------------------------------------------------------ */
/* The lettered boards, which are a texture and a linked program        */
/* ------------------------------------------------------------------ */

/**
 * A stand-in for `makeSignMaterial`, which needs a `<canvas>`.
 *
 * Only the shape matters here: a material with a map whose image has a width
 * and a height, because the cap is written in canvas bytes.
 */
function fakeSign(w = SIGN_W, h = SIGN_H) {
  const map = new THREE.Texture();
  map.image = { width: w, height: h };
  return new THREE.SpriteMaterial({ map });
}

test('two merchants under the same words wear the same board', () => {
  /* A crossing disposed every sign in the world it left and lettered every sign
   * in the world it arrived in: +25 textures and +1 linked program on the frame
   * that receives a world, which was what remained of the crossing's frame gap
   * once its JavaScript was dealt with. */
  const A = new CharacterAssets(null);
  let drawn = 0;
  const make = () => { drawn++; return fakeSign(); };

  const a = A.signMaterial('PROVISIONSRATIONS', make);
  const b = A.signMaterial('PROVISIONSRATIONS', make);

  assert.equal(drawn, 1, 'the same board was lettered twice');
  assert.equal(a, b);
  assert.equal(a.userData.sharedSign, true, 'a cached board is not marked shared, so a death frees it');
});

test('past the cap a board is private, and private means the old behaviour', () => {
  /* Never evicting is only safe because it is never unbounded, and the cap is
   * the whole of that. What it must NOT do at the boundary is start handing out
   * shared boards it did not keep - that would be a character disposing a
   * texture another character is wearing, which is the exact failure the
   * geometry cases above exist for. */
  const A = new CharacterAssets(null);
  const each = SIGN_W * SIGN_H * 4;
  const fits = Math.floor(SIGN_CACHE_BYTES / each);

  const kept = [];
  for (let i = 0; i < fits; i++) kept.push(A.signMaterial(`sign|${i}`, () => fakeSign()));
  for (const m of kept) assert.equal(m.userData.sharedSign, true);
  assert.equal(A._sign.size, fits);

  const over = A.signMaterial('one|too|many', () => fakeSign());
  assert.equal(over.userData.sharedSign, false, 'an uncached board was handed out as a shared one');
  assert.equal(A._sign.size, fits, 'the cap did not hold');
  assert.ok(A._signBytes <= SIGN_CACHE_BYTES,
    `${A._signBytes} bytes of boards against a ${SIGN_CACHE_BYTES} byte cap`);

  // And the cap is wide enough to be worth having: every sign in the game.
  assert.ok(fits >= 64, `the cap holds only ${fits} boards`);
});

test('dispose() frees the boards as well', () => {
  const A = new CharacterAssets(null);
  const m = A.signMaterial('YARD CHANDLERY', () => fakeSign());
  let mapGone = false;
  m.map.addEventListener('dispose', () => { mapGone = true; });

  A.dispose();
  assert.equal(mapGone, true, 'a cached board survived teardown - that is a leak');
  assert.equal(A._signBytes, 0);
});

test('dispose() frees the parked list too', () => {
  const A = new CharacterAssets(null);
  const g = A.acquireGeometry(KEY, () => new THREE.BoxGeometry(1, 1, 1));
  const seen = watch(g);
  fakeHumanoid(A, [KEY]).dispose();
  assert.equal(seen.disposed, false, 'parked already, so far so good');

  A.dispose();
  assert.equal(seen.disposed, true, 'a parked buffer survived teardown - that is the leak');
  assert.equal(A.freeBytes, 0);
});
