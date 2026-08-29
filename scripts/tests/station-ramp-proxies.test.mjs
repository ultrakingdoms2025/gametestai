import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { forceDrawable } from '../../src/gfx/RehearsalDraw.js';
import { rampProxies } from '../../src/dev/StationAudit.js';
import {
  RAMP_PROXY_FLAG, RAMP_PROXY_NAME, rampProxiesIn, markRampProxy,
} from '../../src/worlds/station/StationKit.js';

/**
 * How the station audit finds the tilted collision proxies it measures C4
 * against, and why it may not use `visible` to do it.
 *
 * ── The defect these pin ─────────────────────────────────────────────────
 * `rampProxies` collected "every invisible, non-instanced DIRECT child of
 * `world.group`", because that is how `StationWorld._ramp` happens to leave
 * them. `visible` is the renderer's, not ours: `gfx/RehearsalDraw.js
 * forceDrawable` clears it across the whole world group for the boot shader
 * rehearsal, and anything that reads the audit inside that window sees a
 * different world.
 *
 * Measured on the running page at 042e753, driving the real `auditStation`:
 *
 *   outside the window   94 flights examined, 94 ramp proxies found, 0 findings
 *   inside  the window   94 flights examined,  0 ramp proxies found,
 *                        94 findings, every one NO_RAMP_COLLIDER, and every
 *                        measurement carrying `treadVsRamp: null` - so the
 *                        tread-versus-collider misalignment C4 exists to detect
 *                        could not fire at all. That is the false negative; the
 *                        94 NO_RAMP_COLLIDER lines are the loud half of it.
 *
 * The reports in output/station-audit*.json are all of them the second kind.
 *
 * These run headlessly because `StationAudit.js` imports nothing but THREE and
 * its own maths - the world it audits cannot be built under Node, but the
 * collection can be handed a scene graph shaped like one.
 */

/**
 * Exactly what `StationWorld._ramp` builds, without needing a StationWorld.
 *
 * Stamped through `markRampProxy` rather than by hand. It sets THREE
 * properties - name, the audit's flag, and the map editor's picker opt-out -
 * and a fixture that set two of them would drift from the thing it claims to
 * be "exactly", silently, the moment a fourth is added. That is the argument
 * the helper's own docstring makes for existing.
 */
function proxy(x, y, z, pitch = 0.53) {
  const m = new THREE.Mesh(new THREE.BoxGeometry(4.6, 0.5, 17));
  m.visible = false;
  markRampProxy(m);
  m.position.set(x, y, z);
  m.rotateX(-pitch);
  m.updateWorldMatrix(true, false);
  return m;
}

/** The collection as it was written, for the comparisons below. */
function oldRampProxies(world) {
  const out = [];
  for (const child of world.group.children) {
    if (!child.isMesh || child.visible || child.isInstancedMesh) continue;
    out.push(child);
  }
  return out;
}

/** A world group with three proxies: two direct children and one nested. */
function fakeWorld() {
  const group = new THREE.Group();
  group.name = 'station';
  group.add(proxy(0, 4.7, 0));
  group.add(proxy(30, 4.7, 0));
  const promenade = new THREE.Group();
  promenade.name = 'promenade';
  promenade.add(proxy(60, 4.7, 0));
  group.add(promenade);
  // ...and some ordinary scenery that is not a proxy, including an invisible
  // mesh that is merely switched off.
  const slab = new THREE.Mesh(new THREE.BoxGeometry(20, 1, 20));
  slab.name = 'deck';
  group.add(slab);
  const hidden = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1));
  hidden.name = 'lod-hidden-prop';
  hidden.visible = false;
  group.add(hidden);
  group.updateMatrixWorld(true);
  return { id: 'station', group };
}

/* ------------------------------------------------------------------ */
/* The collection itself                                               */
/* ------------------------------------------------------------------ */

test('every ramp proxy is found, including one nested in a sub-group', () => {
  const world = fakeWorld();
  assert.equal(rampProxies(world).length, 3);
  assert.equal(
    rampProxies(world).filter((m) => m.parent.name === 'promenade').length, 1,
    'a proxy parented below world.group was missed'
  );
});

test('the old collection could only ever see the direct children', () => {
  // The suite has to be able to fail: this is the second half of the defect.
  const world = fakeWorld();
  assert.equal(oldRampProxies(world).length, 3, 'two proxies plus a switched-off prop');
  assert.ok(
    !oldRampProxies(world).some((m) => m.parent.name === 'promenade'),
    'the old collection somehow reached a nested proxy'
  );
});

test('a mesh that is merely switched off is not mistaken for a proxy', () => {
  const world = fakeWorld();
  assert.ok(!rampProxies(world).some((m) => m.name === 'lod-hidden-prop'));
  // The old one could not tell the difference, which is the other half of why
  // `visible` was the wrong signal: DistanceLod hides meshes for a living.
  assert.ok(oldRampProxies(world).some((m) => m.name === 'lod-hidden-prop'));
});

test('every proxy comes back with a bounding box, which C4 needs to measure it', () => {
  for (const m of rampProxies(fakeWorld())) {
    assert.ok(m.geometry.boundingBox, 'a proxy without a bounding box cannot be measured');
  }
});

/* ------------------------------------------------------------------ */
/* The rehearsal window - the environment the audit actually runs in    */
/* ------------------------------------------------------------------ */

test('the proxies are still found while `visible` is forced true', () => {
  const world = fakeWorld();
  const restore = forceDrawable([world.group]);
  try {
    assert.ok(
      world.group.children.every((c) => c.visible),
      'forceDrawable did not do the thing this test is about'
    );
    assert.equal(rampProxies(world).length, 3, 'the audit went blind inside a rehearsal frame');
  } finally {
    restore();
  }
});

test('...and the old collection went completely blind there', () => {
  const world = fakeWorld();
  const restore = forceDrawable([world.group]);
  try {
    assert.equal(oldRampProxies(world).length, 0,
      'this is the defect, and it should reproduce');
  } finally {
    restore();
  }
});

test('the collection is unchanged after the rehearsal restores `visible`', () => {
  const world = fakeWorld();
  const before = rampProxies(world).length;
  forceDrawable([world.group])();
  assert.equal(rampProxies(world).length, before);
});

/* ------------------------------------------------------------------ */
/* The flag is the contract                                            */
/* ------------------------------------------------------------------ */

test('the flag lives in userData, which nothing in the renderer writes', () => {
  const m = proxy(0, 0, 0);
  assert.equal(m.userData[RAMP_PROXY_FLAG], true);
  // The three things a renderer or an LOD band is entitled to move.
  m.visible = true;
  m.frustumCulled = false;
  m.layers.set(2);
  assert.equal(rampProxiesIn(new THREE.Group().add(m)).length, 1);
});

test('an empty or absent root is an empty list, not a throw', () => {
  assert.deepEqual(rampProxiesIn(null), []);
  assert.deepEqual(rampProxiesIn(undefined), []);
  assert.deepEqual(rampProxiesIn(new THREE.Group()), []);
  assert.deepEqual(rampProxies({}), []);
});
