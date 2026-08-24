import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';

/**
 * EVERY GATEWAY SIGN DREW ITS OWN MIRROR IMAGE ON TOP OF ITSELF.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 *  THE DEFECT
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `PortalSystem._buildSign` paints one canvas and hangs it on TWO plates: a
 * `front`, and a `back` turned through PI so its text reads the right way
 * round from the other side. The material was `side: DoubleSide`, so three
 * drew both plates from both sides - and `blending: AdditiveBlending` summed
 * them, 2 cm apart. Every view of every gateway sign in the game was the text
 * plus a reversed copy of the text.
 *
 * `art-space` measured it rather than eyeballing it: the sign strip came back
 * 9.3% asymmetric against 132% for a same-size control strip of wall. A
 * letterform plus its own mirror is very nearly symmetric, and that is the
 * number. It affects at least citadel, dock, sports, space and medieval.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 *  AND THE OBVIOUS FIX IS THE WRONG ONE
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * "Drop the `back` mesh - `DoubleSide` already draws the reverse" is the
 * natural reading and it is false, which is why this file measures instead of
 * asserting. A double-sided plane seen from its -Z face shows the texture's
 * +u axis to the viewer's LEFT, so the front plate ALONE reads MIRRORED from
 * behind. `back` is what makes a sign legible from behind at all; deleting it
 * would trade a mirrored overlay for mirrored text, and would have looked like
 * a fix in every screenshot taken from the front.
 *
 * `FrontSide` is the repair: both plates kept, each drawn only from its own
 * side. One legible copy per side, no mirror, and half the fill - two additive
 * plates rasterising on top of each other were making the sign twice as bright
 * as it was authored to be.
 *
 * It does NOT save a draw call, and the case at the end of this file pins that
 * so nobody claims it later. Both meshes are still submitted to the render
 * list; back faces are rejected in the rasteriser, not in `projectObject`.
 */

globalThis.window = globalThis.window ?? globalThis;

/** The 2D canvas `_buildSign` paints into, reduced to the calls it makes. */
function canvasStub() {
  const ctx = new Proxy({}, {
    get: (_t, k) => {
      if (k === 'canvas') return null;
      return () => undefined;
    },
    set: () => true,
  });
  return { width: 0, height: 0, getContext: () => ctx };
}
globalThis.document = globalThis.document ?? {};
if (!globalThis.document.createElement) {
  globalThis.document.createElement = (tag) => (tag === 'canvas' ? canvasStub() : { style: {} });
}

const { PortalSystem } = await import('../../src/systems/Portals.js');

/** Build one sign through the real method, with the smallest possible `this`. */
function buildSign() {
  const self = { _signCache: new Map(), _maxAniso: 4 };
  return PortalSystem.prototype._buildSign.call(self, 'Lodestar Yard', 'GATEWAY', new THREE.Color(0x66ccff));
}

/** World direction the texture's +u axis points in. */
function uAxisWorld(mesh) {
  mesh.updateMatrixWorld(true);
  const a = mesh.localToWorld(new THREE.Vector3(0, 0, 0));
  return mesh.localToWorld(new THREE.Vector3(1, 0, 0)).sub(a).normalize();
}

/** The viewer's right hand, looking from `eye` at `at`. */
function viewerRight(eye, at) {
  const f = new THREE.Vector3().subVectors(at, eye).normalize();
  return new THREE.Vector3().crossVectors(f, new THREE.Vector3(0, 1, 0)).normalize();
}

/** Is this mesh's +Z (textured) face turned towards the viewer? */
function facesViewer(mesh, eye) {
  mesh.updateMatrixWorld(true);
  const n = new THREE.Vector3(0, 0, 1).transformDirection(mesh.matrixWorld);
  return n.dot(new THREE.Vector3().subVectors(eye, mesh.getWorldPosition(new THREE.Vector3()))) > 0;
}

/** Does the text run left-to-right for this viewer? */
function readable(mesh, eye, at) {
  return uAxisWorld(mesh).dot(viewerRight(eye, at)) > 0;
}

const CENTRE = new THREE.Vector3(0, 0, 0);
const IN_FRONT = new THREE.Vector3(0, 0, 5);
const BEHIND = new THREE.Vector3(0, 0, -5);

test('the sign is two plates sharing one material and one geometry', () => {
  const g = buildSign();
  const meshes = g.children.filter((o) => o.isMesh);
  assert.equal(meshes.length, 2, 'a front and a back, so the text reads the right way round from either side');
  assert.equal(meshes[0].material, meshes[1].material, 'one material, or the sign cache is buying nothing');
  assert.equal(meshes[0].geometry, meshes[1].geometry);
  assert.equal(g.userData.geometry, meshes[0].geometry,
    'clear() disposes `userData.geometry` exactly once; if it is not the shared plane something leaks');
});

test('exactly ONE plate is drawn from each side, and it is the readable one', () => {
  const g = buildSign();
  const [front, back] = g.children.filter((o) => o.isMesh);

  /* THE DEFECT, stated as the thing that must not be true. With DoubleSide
   * both plates draw from both sides, and the second one is always the
   * mirrored one - which is the 9.3%-symmetric strip that was measured. */
  assert.notEqual(front.material.side, THREE.DoubleSide,
    'DoubleSide draws both plates from both sides, so every view is the text PLUS its own mirror, '
    + 'summed by AdditiveBlending 2 cm apart');
  assert.equal(front.material.side, THREE.FrontSide);

  for (const [where, eye] of [['in front', IN_FRONT], ['behind', BEHIND]]) {
    const drawn = [front, back].filter((m) => facesViewer(m, eye));
    assert.equal(drawn.length, 1, `${where}: exactly one plate may face the viewer`);
    assert.ok(readable(drawn[0], eye, CENTRE),
      `${where}: the plate that is drawn must read left-to-right, not mirrored`);
  }
});

test('deleting the back plate would NOT keep the sign legible from behind', () => {
  /* The repair that suggests itself, refused with a measurement rather than an
   * opinion. This is why the fix is `FrontSide` and not `remove(back)`, and it
   * is a case rather than a comment because a comment does not fail. */
  const g = buildSign();
  const [front] = g.children.filter((o) => o.isMesh);
  assert.ok(readable(front, IN_FRONT, CENTRE), 'the front plate reads correctly from the front');
  assert.equal(readable(front, BEHIND, CENTRE), false,
    'and it reads MIRRORED from behind - a double-sided plane shows its +u axis to the viewer\'s '
    + 'left through its -Z face, so the back plate is what makes a sign readable from behind at all');
});

test('the fix costs no draw call, and does not claim to', () => {
  /* Written down because the saving that was expected is not the saving that
   * exists. `WebGLRenderer.projectObject` puts an object in the render list on
   * `visible`, layers and frustum; facing is decided later, per triangle, in
   * the rasteriser. Both plates are still submitted. What FrontSide actually
   * buys is FILL: two coincident additive plates used to shade the same pixels
   * twice, which is also why the sign was drawing at double brightness. */
  const g = buildSign();
  assert.equal(g.children.filter((o) => o.isMesh).length, 2,
    'still two meshes - a claim of "one fewer draw call per portal" would be false');
  const [front, back] = g.children.filter((o) => o.isMesh);
  assert.equal(front.renderOrder, 5);
  assert.equal(back.renderOrder, 5);
  assert.equal(front.material.transparent, true);
  assert.equal(front.material.depthWrite, false,
    'an additive sign must not write depth, or it punches a hole in whatever is behind it');
});
