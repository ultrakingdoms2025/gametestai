import { test } from 'node:test';
import assert from 'node:assert/strict';

import { installHeadlessDom, THREE } from './world-kit.mjs';
installHeadlessDom();
const { GeoBatch } = await import('../../src/worlds/station/StationKit.js');
const { collectParts, containsPoint, trianglesOf, fractionInside, isMarking } =
  await import('../../src/dev/GeoParts.js');

/**
 * THE EXACT TEST, TESTED.
 *
 * `containsPoint` is a Möller-Trumbore ray/triangle intersection specialised to
 * the +X direction and counted for parity. Specialising it means hand-deriving
 * a cross product and two sign flips, and a sign error there does not crash -
 * it quietly answers "outside" for everything, which reads as "no defects
 * found" and is the most expensive possible failure for a gate. So the
 * primitive is tested against shapes whose answers are known by construction,
 * before any station number is taken from it.
 */

const MATS = { shell: new THREE.MeshBasicMaterial() };

/** One piece, from a geometry placed at (x,y,z) with yaw. */
function piece(geo, x = 0, y = 0, z = 0, yaw = 0) {
  const B = new GeoBatch();
  B.at('shell', geo, x, y, z, yaw);
  const parent = new THREE.Group();
  B.flush(parent, MATS, 'probe');
  return collectParts(parent)[0];
}

test('a point inside a box is inside, and one outside is outside', () => {
  const box = piece(new THREE.BoxGeometry(2, 2, 2), 10, 5, -3);
  const tris = trianglesOf(box);
  assert.equal(tris.length / 9, 12, 'a box is twelve triangles');
  assert.equal(containsPoint(tris, 10, 5, -3), true, 'the centre is inside');
  assert.equal(containsPoint(tris, 10.9, 5.9, -3.9), true, 'just inside a corner');
  assert.equal(containsPoint(tris, 11.1, 5, -3), false, 'just outside the +X face');
  assert.equal(containsPoint(tris, 10, 6.1, -3), false, 'above it');
  assert.equal(containsPoint(tris, 10, 5, -1.5), false, 'beside it');
  assert.equal(containsPoint(tris, -50, 5, -3), false,
    'far behind on the ray axis - the ray only counts crossings AHEAD of the point');
});

test('rotation does not fool it, which is the whole point', () => {
  /* The box sweep's false positives all come from rotated mounts: a 2 m square
   * turned 37 degrees has a 2.8 m bounding box, and the 0.8 m of difference is
   * where a correctly mounted sign sits. */
  const yaw = 37 * Math.PI / 180;
  const box = piece(new THREE.BoxGeometry(2, 4, 2), 0, 0, 0, yaw);
  const tris = trianglesOf(box);
  assert.equal(containsPoint(tris, 0, 0, 0), true, 'centre');
  /* A corner of the AABB: inside the box's bounding box, outside the box. */
  assert.equal(box.box.max.x > 1.35, true, `AABB widened to ${box.box.max.x.toFixed(2)} by the yaw`);
  assert.equal(containsPoint(tris, 1.35, 0, 1.35), false,
    'inside the bounding box, outside the solid - the case boxes get wrong');
});

test('nothing is inside a plane', () => {
  /* A sign face is a single quad. Parity against an open surface is
   * meaningless, so `fractionInside` refuses anything too small to be a solid
   * rather than returning a number that looks like an answer. */
  const plane = piece(new THREE.PlaneGeometry(4, 3), 0, 0, 0);
  const box = piece(new THREE.BoxGeometry(1, 1, 1), 0, 0, 0);
  assert.equal(fractionInside(box, plane), 0, 'a plane contains nothing');
});

test('a sign threaded through a post reads as buried; one mounted on it does not', () => {
  /* The defect and its fix, reduced to their geometry. The post is 2 m square
   * and rotated; the sign is a 5 m plane. Threaded through the middle, most of
   * its span is inside. Mounted at 1.21 m, none of it is. */
  const yaw = 37 * Math.PI / 180;
  const post = piece(new THREE.BoxGeometry(2, 12, 2), 0, 0, 0, yaw);

  const through = piece(new THREE.PlaneGeometry(5, 2.6), 0.1 * Math.sin(yaw), 0, 0.1 * Math.cos(yaw), yaw);
  const mounted = piece(new THREE.PlaneGeometry(5, 2.6), 1.21 * Math.sin(yaw), 0, 1.21 * Math.cos(yaw), yaw);

  const bad = fractionInside(through, post);
  const good = fractionInside(mounted, post);
  assert.ok(bad > 0.25, `a sign through the post should read buried, got ${bad.toFixed(2)}`);
  assert.equal(good, 0, `a sign mounted on the post should read clear, got ${good.toFixed(2)}`);
});

test('paint is not an object, but an upright plane is', () => {
  /* THE FALSE POSITIVE THAT COST TWO ROUNDS. A floor decal lying on a raised
   * planter rim is geometrically inside it, so exact containment reports 100%
   * and is right and useless. At the planter site the owner reported,
   * (23.6, -20.2), 29 pieces read as >= 25% inside another and 23 were paint.
   *
   * The discriminator is HEIGHT and not the smallest dimension, because a sign
   * face is a plane too - and an upright one is an object. Getting that wrong
   * in the other direction would blind the buried-sign gate completely. */
  const decal = piece(new THREE.PlaneGeometry(2, 2).rotateX(-Math.PI / 2), 0, 0.05, 0);
  assert.equal(isMarking(decal), true, 'a flat quad lying on the floor is paint');

  const signFace = piece(new THREE.PlaneGeometry(5, 2.6), 0, 3, 0);
  assert.equal(isMarking(signFace), false, 'an upright plane 2.6 m tall is an object');

  const kerb = piece(new THREE.BoxGeometry(4, 0.2, 1), 0, 0.1, 0);
  assert.equal(isMarking(kerb), false, 'a 20 cm kerb is thin, and is still a thing you trip on');
});
