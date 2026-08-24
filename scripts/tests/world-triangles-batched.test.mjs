import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { walkWorldTriangles } from '../../src/dev/WorldTriangles.js';

/**
 * DOES THE TRIANGLE COUNTER COUNT A BatchedMesh?
 *
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * It did not, and it said so in a comment: "three exposes no public count, so
 * fall back to 1 rather than guess." The comment was honest and the number was
 * still wrong in a way that mattered, because `obj.geometry` on a BatchedMesh
 * is the RESERVED buffer shared by every batched geometry. So the walker
 * reported one copy of the whole reservation — a number related neither to
 * what is drawn nor to how many instances there are.
 *
 * `art-maze` found it: the maze is the world built on this class, and the
 * world's headline triangle number had therefore never included the static
 * maze at all. Its authored candle cost showed up as +928 where the true
 * figure was +85,260.
 *
 * The reason this file exists rather than a spot fix: a framing that measures
 * nothing produces a CONFIDENT WRONG NUMBER inside a table of numbers that all
 * look equally real, and every art branch of Phase 9 makes its keep-or-refuse
 * decisions off exactly this table.
 *
 * The counts here are arithmetic, not observation: a box is 12 triangles, so
 * N visible instances are 12N, and the assertions are written that way so a
 * regression cannot be absorbed by adjusting an expected constant.
 */

const BOX_TRIS = 12;

function camSeeingEverything() {
  const cam = new THREE.PerspectiveCamera(90, 1, 0.1, 10_000);
  cam.position.set(0, 0, 60);
  cam.lookAt(0, 0, 0);
  cam.updateMatrixWorld(true);
  return cam;
}

/** A batch of `n` unit boxes, all at the origin, all visible. */
function batchOf(n) {
  const geo = new THREE.BoxGeometry(1, 1, 1);
  const idx = geo.index ? geo.index.count : geo.attributes.position.count;
  const batch = new THREE.BatchedMesh(n, geo.attributes.position.count * n, idx * n,
    new THREE.MeshBasicMaterial());
  const gid = batch.addGeometry(geo);
  const ids = [];
  for (let i = 0; i < n; i++) ids.push(batch.addInstance(gid));
  batch.frustumCulled = false;
  return { batch, ids, geo };
}

test('a BatchedMesh is counted per visible instance, not as one reservation', () => {
  const root = new THREE.Group();
  const { batch } = batchOf(10);
  root.add(batch);
  root.updateMatrixWorld(true);

  const r = walkWorldTriangles(root, camSeeingEverything(), { breakdown: false });

  assert.equal(r.triangles, BOX_TRIS * 10,
    'ten batched boxes are 120 triangles; a reservation-sized answer means the batch is being read as one geometry');
  assert.equal(r.instances, 10, 'ten live instances are ten submissions');
});

test('hiding instances removes exactly their triangles', () => {
  const root = new THREE.Group();
  const { batch, ids } = batchOf(10);
  root.add(batch);
  root.updateMatrixWorld(true);
  const cam = camSeeingEverything();

  const before = walkWorldTriangles(root, cam, { breakdown: false }).triangles;
  batch.setVisibleAt(ids[0], false);
  batch.setVisibleAt(ids[1], false);
  batch.setVisibleAt(ids[2], false);
  const after = walkWorldTriangles(root, cam, { breakdown: false }).triangles;

  assert.equal(before - after, BOX_TRIS * 3,
    'three hidden boxes are 36 triangles fewer — an invisible instance is not submitted');
});

test('instance ids are sparse after a delete, and the walk survives it', () => {
  /* `deleteInstance` returns the id to a free list, so `instanceCount` is an
   * ACTIVE count and not a high-water mark. A loop that runs 0..instanceCount-1
   * silently stops short of the live instances that sit above the hole. */
  const root = new THREE.Group();
  const { batch, ids } = batchOf(10);
  root.add(batch);
  root.updateMatrixWorld(true);

  batch.deleteInstance(ids[0]);
  batch.deleteInstance(ids[1]);
  root.updateMatrixWorld(true);

  const r = walkWorldTriangles(root, camSeeingEverything(), { breakdown: false });
  assert.equal(r.triangles, BOX_TRIS * 8, 'eight instances survive the two deletes');
  assert.equal(r.instances, 8);
});

test('an ordinary Mesh and an InstancedMesh are unaffected by the batched path', () => {
  const root = new THREE.Group();

  const solo = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshBasicMaterial());
  solo.frustumCulled = false;
  root.add(solo);

  const inst = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshBasicMaterial(), 5);
  inst.frustumCulled = false;
  root.add(inst);
  root.updateMatrixWorld(true);

  const r = walkWorldTriangles(root, camSeeingEverything(), { breakdown: false });
  assert.equal(r.triangles, BOX_TRIS + BOX_TRIS * 5,
    'one box plus five instanced boxes; the BatchedMesh branch must not touch either');
  assert.equal(r.instances, 6);
});
