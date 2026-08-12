import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { forceDrawable } from '../../src/gfx/RehearsalDraw.js';

/* Why this file exists.
 *
 * `forceDrawable` is the primitive behind the boot-time shader rehearsal: it
 * shoves a subtree in front of the renderer for a frame so every program it
 * needs is linked *and used* behind the loading screen, then puts the subtree
 * back. The whole feature is only acceptable because the "puts it back" half is
 * exact - a sword trail, a bow string or a loot beam left visible would be a
 * visual bug the player sees for the rest of the session, and a mount root left
 * unculled would draw every frame forever.
 *
 * Two properties are pinned here, and they are the two that can go wrong:
 *   1. every touched object comes back to the exact flags it had, including the
 *      ones that were *already* drawable and so were never recorded, and
 *   2. lights are never made visible, because three folds the light counts into
 *      every shader program's cache key - the exact failure the rehearsal
 *      exists to avoid, not to cause.
 */

/** A subtree with a deliberate mix of hidden/visible and culled/unculled. */
function scene() {
  const root = new THREE.Group();
  root.name = 'root';
  root.visible = false;

  const shownMesh = new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshBasicMaterial());
  shownMesh.name = 'shown';

  const hiddenMesh = new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshBasicMaterial());
  hiddenMesh.name = 'hidden';
  hiddenMesh.visible = false;

  // Already fully drawable: the function must skip recording it and must not
  // change it, which is the case a naive "record everything" version gets wrong
  // only in cost - but a naive "restore everything to false" version corrupts.
  const alreadyDrawable = new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshBasicMaterial());
  alreadyDrawable.name = 'already';
  alreadyDrawable.frustumCulled = false;

  const nested = new THREE.Group();
  nested.name = 'nested';
  nested.visible = false;
  const deep = new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshBasicMaterial());
  deep.name = 'deep';
  deep.visible = false;
  deep.frustumCulled = false;
  nested.add(deep);

  const light = new THREE.PointLight(0xffffff, 1);
  light.name = 'light';
  light.visible = false;

  root.add(shownMesh, hiddenMesh, alreadyDrawable, nested, light);
  return { root, shownMesh, hiddenMesh, alreadyDrawable, nested, deep, light };
}

/** Snapshot of the flags `forceDrawable` is allowed to move. */
function flags(root) {
  const out = [];
  root.traverse((o) => out.push([o.name, o.visible, o.frustumCulled]));
  return out;
}

test('forceDrawable makes every non-light node drawable', () => {
  const s = scene();
  forceDrawable([s.root]);
  for (const o of [s.root, s.shownMesh, s.hiddenMesh, s.alreadyDrawable, s.nested, s.deep]) {
    assert.equal(o.visible, true, `${o.name} should be visible`);
    assert.equal(o.frustumCulled, false, `${o.name} should be unculled`);
  }
});

test('forceDrawable never makes a light visible', () => {
  const s = scene();
  forceDrawable([s.root]);
  assert.equal(s.light.visible, false, 'a light exposed to the renderer changes the program cache key');
  assert.equal(s.light.frustumCulled, true, 'the light was not touched at all');
});

test('restore puts every flag back exactly', () => {
  const s = scene();
  const before = flags(s.root);
  const restore = forceDrawable([s.root]);
  assert.notDeepEqual(flags(s.root), before, 'the test is worthless if nothing changed');
  restore();
  assert.deepEqual(flags(s.root), before);
});

test('restore is idempotent, so a double teardown cannot corrupt state', () => {
  const s = scene();
  const before = flags(s.root);
  const restore = forceDrawable([s.root]);
  restore();
  // Something else hides the mesh again, the way a subsystem's update would.
  s.shownMesh.visible = false;
  restore();
  assert.equal(s.shownMesh.visible, false, 'a second restore must not resurrect old state');
  assert.deepEqual(
    flags(s.root).filter(([n]) => n !== 'shown'),
    before.filter(([n]) => n !== 'shown'),
  );
});

test('overlapping roots are each visited once and restore cleanly', () => {
  const s = scene();
  const before = flags(s.root);
  // `nested` is a descendant of `root`; passing both must not double-record it
  // with the already-forced value, which would restore it as visible.
  const restore = forceDrawable([s.root, s.nested, s.deep]);
  assert.equal(s.deep.visible, true);
  restore();
  assert.deepEqual(flags(s.root), before);
});

test('a null or unwalkable root is skipped rather than thrown on', () => {
  const s = scene();
  const before = flags(s.root);
  const restore = forceDrawable([null, undefined, {}, s.root]);
  assert.equal(s.hiddenMesh.visible, true, 'the good root was still processed');
  restore();
  assert.deepEqual(flags(s.root), before);
  assert.doesNotThrow(() => forceDrawable(undefined)());
});
