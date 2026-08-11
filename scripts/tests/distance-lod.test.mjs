import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import {
  DistanceLod, pastBand, CENTRE, SURFACE, DEFAULT_BAND,
} from '../../src/worlds/lod/DistanceLod.js';

/**
 * The band arithmetic behind the foliage LOD.
 *
 * The load-bearing facts, in order of how much they cost to get wrong:
 *
 *  1. A band edge without hysteresis is a strobe. An object parked exactly on
 *     a threshold flips state every frame, and a canopy alternating between
 *     two tessellations is louder than either tessellation is on its own.
 *  2. The hysteresis is asymmetric on purpose - it is subtracted, never
 *     added - so a distance quoted by a caller is the distance at which the
 *     object is guaranteed still fully drawn. Every measured claim in
 *     MedievalWorld's LOD constants depends on that direction.
 *  3. Distance is measured to the bounding sphere in WORLD space. The grass
 *     zones are 50m squares whose local origin is nowhere near their centre,
 *     so an origin-based measure is off by up to 35m - which is most of a
 *     band.
 */

/** A camera at an exact spot, matrices up to date. */
function cameraAt(x, y, z) {
  const cam = new THREE.PerspectiveCamera(60, 1, 0.1, 1000);
  cam.position.set(x, y, z);
  cam.updateMatrixWorld(true);
  return cam;
}

/** An InstancedMesh of `n` unit boxes laid along +X starting at `x0`. */
function strip(x0, n, step = 10) {
  const geo = new THREE.BoxGeometry(1, 1, 1);
  const mesh = new THREE.InstancedMesh(geo, new THREE.MeshBasicMaterial(), n);
  const o = new THREE.Object3D();
  for (let i = 0; i < n; i++) {
    o.position.set(x0 + i * step, 0, 0);
    o.updateMatrix();
    mesh.setMatrixAt(i, o.matrix);
  }
  mesh.computeBoundingSphere();
  mesh.updateMatrixWorld(true);
  return mesh;
}

test('a band edge only fires outward at the threshold, and back at threshold - band', () => {
  /* The asymmetry is the whole point. Read the four lines as: not yet past,
   * just past, still past on the way back in, finally back. */
  assert.equal(pastBand(false, 85.9, 86, 6), false);
  assert.equal(pastBand(false, 86.1, 86, 6), true);
  assert.equal(pastBand(true, 80.1, 86, 6), true);
  assert.equal(pastBand(true, 79.9, 86, 6), false);
});

test('sitting exactly on the threshold cannot oscillate', () => {
  /* The failure this exists to prevent: `d === threshold` every frame, state
   * flipping every frame. Feed the edge its own output and it has to settle. */
  let state = false;
  const seen = new Set();
  for (let i = 0; i < 20; i++) {
    state = pastBand(state, 86, 86, DEFAULT_BAND);
    seen.add(state);
  }
  assert.deepEqual([...seen], [false]);

  /* And from the other side: an object that got out to 90 and drifted back to
   * exactly 86 stays demoted rather than flickering. */
  state = pastBand(false, 90, 86, DEFAULT_BAND);
  assert.equal(state, true);
  for (let i = 0; i < 20; i++) {
    state = pastBand(state, 86, 86, DEFAULT_BAND);
    seen.add(state);
  }
  assert.equal(state, true);
});

test('a band wider than its threshold cannot invert the edge', () => {
  /* Nothing should be registered like this, but if it is, the near edge
   * clamps at zero rather than going negative and latching the object into
   * the demoted state forever. */
  assert.equal(pastBand(true, 0, 4, 10), false);
  assert.equal(pastBand(true, 0.1, 4, 10), true);
});

test('an omitted threshold disables its edge entirely', () => {
  /* `hideBeyond` is optional: a registration that only swaps geometry must
   * never disappear, at any distance, including silly ones. */
  assert.equal(pastBand(false, 1e9, Infinity, 6), false);
  assert.equal(pastBand(true, 1e9, Infinity, 6), false);
});

test('distance is to the bounding sphere in world space, not to the object origin', () => {
  /* The grass-zone shape: geometry authored around the origin, instances laid
   * out 300m away. Measuring the origin would report 0m for a field that is
   * nowhere near the camera. */
  const mesh = strip(300, 11, 10); // instances at x=300..400, centre x=350
  const lod = new DistanceLod();
  const e = lod.add(mesh, { measure: CENTRE });
  lod.update(cameraAt(0, 0, 0));
  // Bounding sphere centre sits at the middle of the strip, not at x=0.
  assert.ok(Math.abs(lod._distance(e) - 350) < 1.5, `got ${lod._distance(e)}`);
});

test('SURFACE measures the near edge of the sphere, which is what a proof needs', () => {
  /* "Nearest point beyond 86m" is the only form of the claim that lets you
   * say every blade in the zone is beyond 86m. CENTRE cannot say that: on
   * this strip the two answers differ by the full 50m radius. */
  const mesh = strip(300, 11, 10);
  const lod = new DistanceLod();
  const centre = lod.add(mesh, { measure: CENTRE });
  const surface = lod.add(mesh, { measure: SURFACE });
  lod.update(cameraAt(0, 0, 0));
  const dc = lod._distance(centre);
  const ds = lod._distance(surface);
  assert.ok(dc - ds > 48 && dc - ds < 53, `radius gap was ${dc - ds}`);
  // And it never goes negative when the camera is inside the sphere.
  lod.update(cameraAt(350, 0, 0));
  assert.equal(lod._distance(surface), 0);
});

test('hiding is driven by the band and comes back when you walk in', () => {
  const mesh = strip(0, 1); // one box at the origin, radius ~0.87
  const lod = new DistanceLod();
  lod.add(mesh, { hideBeyond: 86, measure: CENTRE, band: 6 });

  lod.update(cameraAt(0, 0, 50));
  assert.equal(mesh.visible, true, 'inside the band');

  lod.update(cameraAt(0, 0, 100));
  assert.equal(mesh.visible, false, 'past the threshold');

  lod.update(cameraAt(0, 0, 82));
  assert.equal(mesh.visible, false, 'inside the hysteresis, still hidden');

  lod.update(cameraAt(0, 0, 79));
  assert.equal(mesh.visible, true, 'past the near edge, back');
});

test('the geometry swap is a geometry write, and reverses exactly', () => {
  /* An LOD change here is one assignment on a mesh that never moves and never
   * leaves the scene. Nothing is removed, re-added or re-allocated - that is
   * what makes it affordable to run every frame over ~100 registrations. */
  const mesh = strip(0, 1);
  const hi = mesh.geometry;
  const lo = new THREE.BoxGeometry(1, 1, 1);
  const lod = new DistanceLod();
  lod.add(mesh, { lo, swapBeyond: 90, measure: CENTRE, band: 6 });

  lod.update(cameraAt(0, 0, 50));
  assert.equal(mesh.geometry, hi);
  lod.update(cameraAt(0, 0, 120));
  assert.equal(mesh.geometry, lo);
  lod.update(cameraAt(0, 0, 86));
  assert.equal(mesh.geometry, lo, 'hysteresis holds it on lo');
  lod.update(cameraAt(0, 0, 83));
  assert.equal(mesh.geometry, hi);
});

test('the measured sphere does not follow the swapped geometry', () => {
  /* A measure read back off `object.geometry` after a swap is a feedback
   * loop: the lo geometry has its own bounding sphere, the distance jumps
   * when the LOD changes, and the band can chase itself. The sphere is fixed
   * at registration. */
  const mesh = strip(300, 11, 10);
  const lo = new THREE.BoxGeometry(1, 1, 1); // radius ~0.87, nothing like the strip
  const lod = new DistanceLod();
  const e = lod.add(mesh, { lo, swapBeyond: 90, measure: SURFACE });
  lod.update(cameraAt(0, 0, 0));
  const before = lod._distance(e);
  assert.equal(mesh.geometry, lo, 'demoted');
  lod.update(cameraAt(0, 0, 0));
  assert.equal(lod._distance(e), before, 'measure unchanged by the swap');
});

test('a custom measure describes shapes a sphere cannot', () => {
  /* Medieval's backdrop treelines are 300m-diameter rings centred on the map.
   * Their bounding sphere covers the whole world, so both sphere measures
   * report ~0 from anywhere inside it and no band would ever fire. The
   * distance that means anything for a ring is the distance to the ring. */
  const mesh = strip(0, 1);
  const lo = new THREE.BoxGeometry(1, 1, 1);
  const ring = (cam) => Math.max(0, Math.abs(Math.hypot(cam.x, cam.z) - 230) - 22);
  const lod = new DistanceLod();
  const e = lod.add(mesh, { lo, swapBeyond: 90, measure: ring, band: 6 });

  lod.update(cameraAt(0, 0, 0));
  assert.equal(mesh.geometry, lo, 'from the map centre the ring is 208m out');
  assert.equal(lod._distance(e), 208);

  // Standing in the ring itself: zero, and full detail.
  lod.update(cameraAt(230, 0, 0));
  assert.equal(lod._distance(e), 0);
  assert.notEqual(mesh.geometry, lo, 'promoted back to hi');
});

test('clear() restores every registration, so dispose cannot orphan a geometry', () => {
  /* dispose() releases the hi and lo geometries together. A mesh left holding
   * the lo one after the world unloads is a reference to freed GPU memory. */
  const a = strip(0, 1);
  const b = strip(0, 1);
  const hi = a.geometry;
  const lo = new THREE.BoxGeometry(1, 1, 1);
  const lod = new DistanceLod();
  lod.add(a, { lo, swapBeyond: 90, measure: CENTRE });
  lod.add(b, { hideBeyond: 86, measure: CENTRE });

  lod.update(cameraAt(0, 0, 400));
  assert.equal(a.geometry, lo);
  assert.equal(b.visible, false);

  lod.clear();
  assert.equal(a.geometry, hi);
  assert.equal(b.visible, true);
  assert.equal(lod.entries.length, 0);
});

test('update over an empty registry is free, and survives being called first', () => {
  /* `update` runs from the world tick, which can fire before the world has
   * finished building and registering anything. */
  const lod = new DistanceLod();
  lod.update(cameraAt(0, 0, 0));
  assert.equal(lod.entries.length, 0);
});
