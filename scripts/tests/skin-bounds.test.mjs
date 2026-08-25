import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { useBindPoseBounds, SKIN_BOUND_PAD } from '../../src/gfx/SkinBounds.js';
import { HumanoidFactory, createSkeleton } from '../../src/npc/Humanoid.js';

/* Why this file exists.
 *
 * `THREE.Frustum.intersectsObject` prefers `object.boundingSphere` over
 * `object.geometry.boundingSphere`, and `SkinnedMesh` declares one and leaves it
 * null. So the first time the culler looks at a character it calls
 * `SkinnedMesh.computeBoundingSphere()`, which walks every vertex of the body
 * through four bone matrices. A world crossing builds a whole new cast, so that
 * is paid once per character on the frame the world arrives:
 *
 *     x.skinBound   123.6 ms   x27      the frame the station arrives on
 *     x.frustum       0.4 ms   x4145    every other frame in the same run
 *
 * `gfx/SkinBounds.js` hands the culler the padded bind-pose sphere the geometry
 * has carried all along. The risk that buys is a sphere too SMALL - a character
 * culled while it is on screen - so these cases are about containment, and the
 * timing is not what they check.
 *
 * The browser half lives in `frame-gaps.mjs --frames`, which walks a real cast
 * after it has been animating and reports the worst containment ratio measured
 * against three's own value. This half pins the rule that makes that possible
 * and the two ways it can silently do nothing.
 */

/**
 * A skinned mesh on a real humanoid skeleton, shaped the way a real body is.
 *
 * Every bone in the spec carries its own cluster of vertices, sitting at that
 * bone's bind position - which is what makes the bind-pose sphere the BODY
 * ENVELOPE rather than one long lever arm, and is the only version of this rig
 * that asks the question the game asks. The first draft weighted every vertex
 * to a single bone, which made bending the lower spine swing the entire mesh
 * about the pelvis; it failed a pad the real geometry never needs, and it would
 * have had this file demanding a margin to fix a body no character has.
 */
function humanoidRig(opts = {}) {
  const F = new HumanoidFactory({});
  const P = F._proportions(opts.build ?? 'average', opts.frame ?? 1, 1, 0);
  const spec = F._spec(P);
  const { skeleton, byName, root: boneRoot } = createSkeleton(spec);
  boneRoot.updateMatrixWorld(true);

  const bones = skeleton.bones;
  const PER = 6;
  const R = opts.limbRadius ?? 0.11;
  const pos = new Float32Array(bones.length * PER * 3);
  const si = new Uint16Array(bones.length * PER * 4);
  const sw = new Float32Array(bones.length * PER * 4);
  const at = new THREE.Vector3();
  let v = 0;
  for (let b = 0; b < bones.length; b++) {
    at.setFromMatrixPosition(bones[b].matrixWorld);
    for (let k = 0; k < PER; k++, v++) {
      pos[v * 3] = at.x + R * Math.cos((k / PER) * Math.PI * 2);
      pos[v * 3 + 1] = at.y + R * (k % 2 ? 1 : -1);
      pos[v * 3 + 2] = at.z + R * Math.sin((k / PER) * Math.PI * 2);
      si[v * 4] = b;
      sw[v * 4] = 1;
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('skinIndex', new THREE.BufferAttribute(si, 4));
  geo.setAttribute('skinWeight', new THREE.BufferAttribute(sw, 4));
  geo.computeBoundingSphere();
  // What `mergeParts` does to every real body, and the whole reason a bind-pose
  // sphere is usable as an animated one.
  geo.boundingSphere.radius *= 1.5;

  const mesh = new THREE.SkinnedMesh(geo, new THREE.MeshBasicMaterial());
  const rig = new THREE.Object3D();
  rig.add(boneRoot);
  rig.add(mesh);
  const root = new THREE.Group();
  root.add(rig);
  root.updateMatrixWorld(true);
  mesh.bind(skeleton, new THREE.Matrix4());
  return { mesh, geo, root, skeleton, byName };
}

/** (centre offset + true radius) / assigned radius. At or under 1 is contained. */
function containment(mesh) {
  const assigned = mesh.boundingSphere.clone();
  mesh.boundingSphere = null;
  mesh.computeBoundingSphere();
  const truth = mesh.boundingSphere;
  const ratio = (assigned.center.distanceTo(truth.center) + truth.radius) / assigned.radius;
  mesh.boundingSphere = assigned;
  return ratio;
}

test('the culler is handed a sphere instead of being made to skin the body', () => {
  const { mesh, geo } = humanoidRig();
  assert.equal(mesh.boundingSphere, null, 'three no longer starts a SkinnedMesh with a null sphere');
  assert.equal(useBindPoseBounds(mesh), true);
  assert.ok(mesh.boundingSphere, 'no sphere was installed');
  assert.equal(mesh.boundingSphere.radius, geo.boundingSphere.radius * SKIN_BOUND_PAD);
  assert.deepEqual(mesh.boundingSphere.center.toArray(), geo.boundingSphere.center.toArray());
  // A copy, not the geometry's own: the geometry is SHARED between every
  // character wearing this body, and a sphere aliased into it would let one
  // character's pad follow all of them.
  assert.notEqual(mesh.boundingSphere, geo.boundingSphere);
});

test('a bound is installed before anything can render, not on first sight', () => {
  const { mesh } = humanoidRig();
  useBindPoseBounds(mesh);
  let skinned = 0;
  const orig = mesh.computeBoundingSphere.bind(mesh);
  mesh.computeBoundingSphere = () => { skinned++; return orig(); };
  const frustum = new THREE.Frustum().setFromProjectionMatrix(
    new THREE.PerspectiveCamera(60, 1, 0.1, 100).projectionMatrix
  );
  frustum.intersectsObject(mesh);
  frustum.intersectsObject(mesh);
  assert.equal(skinned, 0, 'the frustum test still CPU-skinned the body');
});

test('the assigned sphere contains the posed one across the skeleton', () => {
  // Every joint the rig has, driven past any gait the game plays - 1.5 rad is
  // 86 degrees, on each axis, in both directions, one joint at a time and then
  // all of them at once.
  const { mesh, root, byName } = humanoidRig();
  useBindPoseBounds(mesh);
  const joints = [...byName.keys()];
  let worst = 0;
  let worstAt = null;
  const check = (label) => {
    root.updateMatrixWorld(true);
    const ratio = containment(mesh);
    if (ratio > worst) { worst = ratio; worstAt = label; }
  };
  for (const name of joints) {
    const bone = byName.get(name);
    for (const axis of ['x', 'y', 'z']) {
      for (const angle of [-1.5, -0.8, 0.8, 1.5]) {
        bone.rotation.set(0, 0, 0);
        bone.rotation[axis] = angle;
        check(`${name}.${axis} ${angle}`);
      }
    }
    bone.rotation.set(0, 0, 0);
  }
  // And the poses no animation produces: every joint bent at once.
  for (const name of joints) byName.get(name).rotation.set(0.7, 0.7, 0.7);
  check('every joint at 0.7 rad');
  for (const name of joints) byName.get(name).rotation.set(-1.2, 0, 1.2);
  check('every joint at -1.2/0/1.2 rad');

  assert.ok(worst <= 1, `a posed body escapes its bound at ${worstAt}: ratio ${worst.toFixed(3)}`);
});

test('the bound moves with the character rather than being frozen in world space', () => {
  // The failure this rules out is the one that would be invisible: a sphere in
  // the wrong space is still a sphere, and the character it culls is a
  // character that silently is not drawn.
  const { mesh, root } = humanoidRig();
  useBindPoseBounds(mesh);
  const local = mesh.boundingSphere.clone();
  for (const at of [[0, 0, 0], [120, 0, 0], [700, 12, -300]]) {
    root.position.set(...at);
    root.updateMatrixWorld(true);
    const tested = mesh.boundingSphere.clone().applyMatrix4(mesh.matrixWorld);
    assert.ok(
      tested.center.distanceTo(new THREE.Vector3(...at)) < local.radius + 1e-3,
      `the sphere the frustum tests is not on the character at ${at}`
    );
    assert.equal(mesh.boundingSphere.center.distanceTo(local.center), 0, 'the stored sphere moved');
  }
});

test('a sphere that cannot be derived is left to three rather than faked', () => {
  // Both directions of "did nothing", because doing nothing here is CORRECT -
  // three's lazy path still applies - and doing nothing while REPORTING success
  // is what would hide a character with no bound at all.
  const bare = new THREE.SkinnedMesh(new THREE.BufferGeometry(), new THREE.MeshBasicMaterial());
  assert.equal(useBindPoseBounds(bare), false, 'claimed a bound for a geometry with no positions');
  assert.equal(bare.boundingSphere, null, 'installed a sphere that describes nothing');

  const noGeo = new THREE.Object3D();
  assert.equal(useBindPoseBounds(noGeo), false);

  // A NaN vertex makes `computeBoundingSphere` produce radius NaN, and a NaN
  // radius fails every frustum comparison - which is a character that is never
  // drawn anywhere.
  const nan = new THREE.SkinnedMesh(new THREE.BufferGeometry(), new THREE.MeshBasicMaterial());
  nan.geometry.setAttribute('position', new THREE.Float32BufferAttribute([0, 0, 0, NaN, 1, 0], 3));
  assert.equal(useBindPoseBounds(nan), false, 'accepted a non-finite radius');
  assert.equal(nan.boundingSphere, null);
});

test('the pad is load-bearing: shrink it and the cases above bite', () => {
  // The constant is the whole safety margin, so it is confirmed by injection
  // rather than trusted. A pad that undoes `mergeParts`' own 1.5 leaves a sphere
  // a raised arm escapes - which is the defect this change could introduce, and
  // it is why the pad is a named constant rather than an absent multiply.
  const { mesh, root, byName } = humanoidRig();
  useBindPoseBounds(mesh, 1 / 1.5);
  byName.get('upperArmL').rotation.set(0, 0, 1.5);
  byName.get('foreArmL').rotation.set(0, 0, 1.2);
  root.updateMatrixWorld(true);
  assert.ok(
    containment(mesh) > 1,
    'an unpadded sphere contained a raised arm, so the pad proves nothing'
  );
});
