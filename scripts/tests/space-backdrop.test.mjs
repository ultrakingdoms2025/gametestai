import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';

import { Backdrop } from '../../src/worlds/space/Backdrop.js';
import { Belt } from '../../src/worlds/space/Belt.js';
import { BELT, SPACE_BODIES, DOCK_ANCHOR } from '../../src/worlds/space/Bodies.js';
import { NEAR_FIELD, FAR_SAFE, angularRadius } from '../../src/worlds/space/Scale.js';

/**
 * The per-frame driver, tested against the two bugs that actually shipped into
 * a screenshot and had to be found in a browser.
 *
 *  1. renderOrder written on a GROUP does nothing - three reads it off each
 *     renderable object, and a Group is not one. The symptom was a planet
 *     painted flat over a handrail four metres from the camera.
 *  2. The audit fired on the asteroid field on the first frame, because it
 *     was checking a distance that a `transform: false` member never uses.
 *
 * Neither is visible in a passing "does it place things" test, so both are
 * pinned directly.
 */

/** A member shaped like a real one: a group with leaf meshes under it. */
function makeMember(name, subs = [0]) {
  const g = new THREE.Group();
  g.name = name;
  for (const sub of subs) {
    const m = new THREE.Mesh(new THREE.BufferGeometry(), new THREE.Material());
    m.userData.backdropSub = sub;
    g.add(m);
  }
  return g;
}

function cameraAt(x, y, z) {
  const cam = new THREE.PerspectiveCamera(75, 16 / 9, 0.1, 2000);
  cam.position.set(x, y, z);
  cam.updateMatrixWorld(true);
  return cam;
}

test('renderOrder lands on the LEAF meshes, never only on the group', () => {
  /* The bug, pinned. If a future refactor goes back to writing the order on
   * the group, the leaves stay at 0, three falls back to its own sorting, and
   * because backdrop bodies have no depth test the last one drawn wins. */
  const cam = cameraAt(0, 0, 0);
  const bd = new Backdrop(cam);
  const near = makeMember('near');
  const far = makeMember('far');
  bd.addBody(near, [0, 0, -20000], 100);
  bd.addBody(far, [0, 0, -200000], 100);
  bd.update();

  const nearRO = near.children[0].renderOrder;
  const farRO = far.children[0].renderOrder;
  assert.notEqual(nearRO, 0, 'leaf mesh never received a render order');
  assert.notEqual(farRO, 0, 'leaf mesh never received a render order');
  assert.ok(farRO < nearRO, `far (${farRO}) must be drawn before near (${nearRO})`);
  assert.ok(nearRO < 0, 'the backdrop must stay below render order 0');
});

test('a member sorts its own parts inside its band, in the declared order', () => {
  const bd = new Backdrop(cameraAt(0, 0, 0));
  const body = makeMember('body', [0, 1, 2, 3]); // surface, ring, halo, corona
  bd.addBody(body, [0, 0, -50000], 9000);
  bd.update();
  const ro = body.children.map((c) => c.renderOrder);
  for (let i = 1; i < ro.length; i++) {
    assert.ok(ro[i] > ro[i - 1], `part ${i} (${ro[i]}) must draw after part ${i - 1} (${ro[i - 1]})`);
  }
  // ...and the whole band must stay inside this member's slot, not bleed into
  // the next member's.
  assert.ok(ro[ro.length - 1] - ro[0] < 8, 'a member overflowed its render-order band');
});

test('the painter order is by TRUE distance, not by proxy distance', () => {
  /* The far-limb cap inverts the proxy distances of the shipped bodies - see
   * space-scale.test.mjs. The ranking must ignore that entirely. */
  const cam = cameraAt(0, 0, 0);
  const bd = new Backdrop(cam);
  const groups = SPACE_BODIES.map((b) => {
    const g = makeMember(b.name);
    const bound = b.ring ? b.radius * b.ring.outer : b.radius;
    bd.addBody(g, b.position, bound, { name: b.name });
    return { b, g };
  });
  bd.update();

  const ranked = groups
    .map(({ b, g }) => ({
      name: b.name,
      D: Math.hypot(...b.position),
      ro: g.children[0].renderOrder,
    }))
    .sort((a, x) => a.ro - x.ro);

  for (let i = 1; i < ranked.length; i++) {
    assert.ok(
      ranked[i].D < ranked[i - 1].D,
      `drawn ${ranked[i].name} (${(ranked[i].D / 1000).toFixed(0)} km) after ` +
        `${ranked[i - 1].name} (${(ranked[i - 1].D / 1000).toFixed(0)} km) - ` +
        `the order is not by true distance`
    );
  }
});

test('a member is placed at its exact angular position and size', () => {
  const cam = cameraAt(1000, -200, 4000);
  const bd = new Backdrop(cam);
  const g = makeMember('cinder');
  const pos = [-13600, -24800, -55200];
  const R = 9000;
  bd.addBody(g, pos, R);
  bd.update();

  const camP = new THREE.Vector3(1000, -200, 4000);
  const truth = new THREE.Vector3(...pos).sub(camP);
  const drawn = g.position.clone().sub(camP);

  // Same bearing, to floating-point.
  const cos = truth.clone().normalize().dot(drawn.clone().normalize());
  assert.ok(1 - cos < 1e-12, `bearing drifted: cos=${cos}`);
  // Same angular size, to floating-point.
  const trueAng = angularRadius(R, truth.length());
  const drawnAng = angularRadius(R * g.scale.x, drawn.length());
  assert.ok(Math.abs(trueAng - drawnAng) < 1e-12, `angular size drifted by ${trueAng - drawnAng}`);
  // Inside the far plane.
  assert.ok(drawn.length() * (1 + g.scale.x * R / drawn.length()) <= FAR_SAFE + 1e-9);
});

test('a member inside the near field is left exactly where it is', () => {
  const bd = new Backdrop(cameraAt(0, 0, 0));
  const g = makeMember('dock');
  bd.addBody(g, [0, 0, -300], 285);
  bd.update();
  assert.equal(g.position.z, -300, 'the near field must be the identity');
  assert.equal(g.scale.x, 1);
});

test('transform:false ranks a member without moving it', () => {
  const bd = new Backdrop(cameraAt(0, 0, 0));
  const g = makeMember('belt');
  g.position.set(7, 8, 9);
  g.scale.setScalar(3);
  bd.addStructure(g, [0, 0, -26000], 5500, { transform: false });
  bd.update();
  assert.deepEqual(g.position.toArray(), [7, 8, 9], 'a transform:false member was moved');
  assert.equal(g.scale.x, 3, 'a transform:false member was rescaled');
  assert.ok(g.children[0].renderOrder < 0, 'but it must still be ranked');
});

test('the audit stays quiet for the shipped set, from the dock and from inside the belt', () => {
  /* It did not. On the first frame in a browser it reported the asteroid
   * field as unsafe, because the check was reading the group's capped proxy
   * distance - a number a `transform: false` member never uses for anything.
   * A warning that is always wrong trains you to ignore the one that is not. */
  const warnings = [];
  const realWarn = console.warn;
  console.warn = (...a) => warnings.push(a.join(' '));
  try {
    for (const camPos of [[0, 0, 0], BELT.position, [-19000, 700, -8600]]) {
      const bd = new Backdrop(cameraAt(...camPos));
      bd.addStructure(makeMember('Halberd Reach'), BELT.position, BELT.extent[0],
        { name: 'Halberd Reach', transform: false });
      bd.addStructure(makeMember('Lodestar Yard'), DOCK_ANCHOR.position, DOCK_ANCHOR.radius,
        { name: 'Lodestar Yard' });
      for (const b of SPACE_BODIES) {
        bd.addBody(makeMember(b.name), b.position, b.ring ? b.radius * b.ring.outer : b.radius,
          { name: b.name });
      }
      bd.update();
    }
  } finally {
    console.warn = realWarn;
  }
  assert.deepEqual(warnings, [], `audit fired: ${warnings.join(' | ')}`);
});

test('the audit DOES fire for a transforming structure the cap has caught', () => {
  /* The other half: a check that never fires is not a check. A big structure
   * that is transformed as a rigid group and is close enough for the cap to
   * bind really is unordered against the bodies, and must be reported. */
  const warnings = [];
  const realWarn = console.warn;
  console.warn = (...a) => warnings.push(a.join(' '));
  try {
    const bd = new Backdrop(cameraAt(0, 0, 0));
    // 6 km bounding radius seen from 9 km: q = 0.67, cap binds hard.
    bd.addStructure(makeMember('slab'), [0, 0, -9000], 6000, { name: 'slab' });
    bd.update();
  } finally {
    console.warn = realWarn;
  }
  assert.equal(warnings.length, 1, 'the audit did not fire on a genuinely unsafe structure');
  assert.match(warnings[0], /angularly large/);
});

test('a member with no drawable mesh is rejected at registration', () => {
  const bd = new Backdrop(cameraAt(0, 0, 0));
  assert.throws(
    () => bd.addBody(new THREE.Group(), [0, 0, -1000], 10, { name: 'empty' }),
    /no drawable meshes/
  );
});

test('a non-finite position or radius is rejected at registration', () => {
  const bd = new Backdrop(cameraAt(0, 0, 0));
  assert.throws(() => bd.addBody(makeMember('a'), [0, NaN, -1000], 10), /non-finite position/);
  assert.throws(() => bd.addBody(makeMember('b'), [0, 0, -1000], NaN), /radius/);
});

/* ------------------------------------------------------------------ */
/* The belt                                                            */
/* ------------------------------------------------------------------ */

test('the belt places every rock at its exact bearing, near field and far alike', () => {
  const cam = cameraAt(BELT.position[0] - 3000, BELT.position[1], BELT.position[2]);
  const belt = new Belt(BELT, cam);
  belt.update(0);

  const camP = cam.position.clone();
  const m = new THREE.Matrix4();
  const p = new THREE.Vector3();
  const q = new THREE.Quaternion();
  const s = new THREE.Vector3();

  let worstBearing = 0;
  let worstAngular = 0;
  let identityCount = 0;
  for (let i = 0; i < belt.count; i++) {
    belt.meshes[belt.mesh[i]].getMatrixAt(belt.slot[i], m);
    m.decompose(p, q, s);
    const truth = new THREE.Vector3(belt.trueX[i], belt.trueY[i], belt.trueZ[i]).sub(camP);
    const drawn = p.clone().sub(camP);
    const cos = Math.min(1, truth.clone().normalize().dot(drawn.clone().normalize()));
    worstBearing = Math.max(worstBearing, 1 - cos);
    // The instance scale carries the rock radius times the proxy factor times
    // its own stretch; compare the mean radius against the true one.
    const drawnR = (s.x / belt.sx[i] + s.y / belt.sy[i] + s.z / belt.sz[i]) / 3;
    const a = Math.abs(angularRadius(drawnR, drawn.length()) - angularRadius(belt.radius[i], truth.length()));
    worstAngular = Math.max(worstAngular, a);
    if (truth.length() <= NEAR_FIELD) identityCount++;
  }
  /* Tolerances set by the STORAGE, not by the maths. Instance transforms live
   * in an InstancedMesh's Float32Array, so a position of order 10^4 metres
   * round-trips with about 10^-3 m of error and the angular size that comes
   * back out carries ~4e-8 rad of it. That is 1e-5 of a pixel at 1080p. The
   * placement arithmetic itself is exact to double precision and is asserted
   * as such in space-scale.test.mjs; this checks the pipeline that carries it. */
  assert.ok(worstBearing < 1e-10, `worst bearing error ${worstBearing}`);
  assert.ok(worstAngular < 5e-7, `worst angular-size error ${worstAngular} rad`);
  assert.ok(identityCount > 0, 'no rock was inside the near field - the identity path went untested');
  console.log(`   ${belt.count} rocks, ${identityCount} at identity, worst angular error ${worstAngular.toExponential(2)} rad`);
  belt.dispose();
});

test('a rock inside the near field is drawn at its TRUE position', () => {
  /* The reason each rock is placed individually instead of the field being
   * scaled as one group: a rock the ship can hit has to be drawn where its
   * collider is. Put the camera in the middle of the field and check the
   * nearest rock has not moved. */
  const cam = cameraAt(...BELT.position);
  const belt = new Belt(BELT, cam);
  belt.update(0);
  const camP = cam.position.clone();
  const m = new THREE.Matrix4(), p = new THREE.Vector3(), q = new THREE.Quaternion(), s = new THREE.Vector3();

  let nearest = -1, nearestD = Infinity;
  for (let i = 0; i < belt.count; i++) {
    const d = new THREE.Vector3(belt.trueX[i], belt.trueY[i], belt.trueZ[i]).distanceTo(camP);
    if (d < nearestD) { nearestD = d; nearest = i; }
  }
  assert.ok(nearestD < NEAR_FIELD, `nearest rock is ${nearestD.toFixed(0)} m away - outside the identity zone`);

  belt.meshes[belt.mesh[nearest]].getMatrixAt(belt.slot[nearest], m);
  m.decompose(p, q, s);
  const drift = p.distanceTo(new THREE.Vector3(belt.trueX[nearest], belt.trueY[nearest], belt.trueZ[nearest]));
  assert.ok(drift < 1e-6, `a rock ${nearestD.toFixed(0)} m from the ship was drawn ${drift.toFixed(3)} m from its collider`);
  belt.dispose();
});

test('the belt has a real size distribution, not a size range', () => {
  const belt = new Belt(BELT, cameraAt(0, 0, 0));
  const r = Array.from(belt.radius).sort((a, b) => a - b);
  const median = r[Math.floor(r.length / 2)];
  const big = r.filter((x) => x > 200).length;
  /* Floors and a ceiling. A uniform draw over [18, 340] would put the median
   * near 179 and give ~120 rocks over 200 m, which is a field of identical
   * lumps. The cubic bias has to be visible in the numbers. */
  assert.ok(median < 90, `median rock radius ${median.toFixed(1)} m - the distribution is too flat`);
  assert.ok(median > 18, `median ${median.toFixed(1)} m is at the floor - everything is gravel`);
  assert.ok(big >= 2, `only ${big} rocks over 200 m - nothing to give the field a scale`);
  assert.ok(big <= 40, `${big} rocks over 200 m - too many landmarks`);
  console.log(`   median ${median.toFixed(1)} m, ${big} over 200 m, largest ${r[r.length - 1].toFixed(0)} m`);
  belt.dispose();
});

test('the belt is flattened and hollow, and its colliders are the big rocks', () => {
  const belt = new Belt(BELT, cameraAt(0, 0, 0));
  let maxY = 0, maxXZ = 0, minR = Infinity;
  for (let i = 0; i < belt.count; i++) {
    const dx = belt.trueX[i] - BELT.position[0];
    const dy = belt.trueY[i] - BELT.position[1];
    const dz = belt.trueZ[i] - BELT.position[2];
    maxY = Math.max(maxY, Math.abs(dy));
    maxXZ = Math.max(maxXZ, Math.hypot(dx, dz));
    minR = Math.min(minR, Math.hypot(dx / BELT.extent[0], dy / BELT.extent[1], dz / BELT.extent[2]));
  }
  assert.ok(maxY < maxXZ * 0.45, `not flattened: ${maxY.toFixed(0)} m thick against ${maxXZ.toFixed(0)} m wide`);
  assert.ok(minR > BELT.hollow * 0.95, `a rock landed inside the hollow centre (r=${minR.toFixed(3)})`);
  assert.ok(maxXZ <= BELT.extent[0] * 1.001, 'a rock escaped the declared extent');

  assert.ok(belt.colliderRocks.length > 0, 'nothing in the field is solid');
  for (const c of belt.colliderRocks) {
    assert.ok(c.r >= 90, 'a rock too small to matter was given a collider');
    assert.ok(Number.isFinite(c.x) && Number.isFinite(c.y) && Number.isFinite(c.z));
  }
  console.log(`   ${belt.colliderRocks.length} collidable rocks of ${belt.count}`);
  belt.dispose();
});

test('the belt is deterministic - the same field every visit', () => {
  const a = new Belt(BELT, cameraAt(0, 0, 0));
  const b = new Belt(BELT, cameraAt(0, 0, 0));
  assert.deepEqual(Array.from(a.trueX), Array.from(b.trueX));
  assert.deepEqual(Array.from(a.radius), Array.from(b.radius));
  a.dispose();
  b.dispose();
});

test('no rock geometry has a non-finite vertex - the NaN gate', () => {
  /* A single NaN vertex propagates through the bloom and blacks out the whole
   * frame. The rock geometry is built by displacing an icosahedron per hashed
   * vertex position, which is exactly the kind of code that produces one. */
  const belt = new Belt(BELT, cameraAt(0, 0, 0));
  for (const g of belt._geoms) {
    const p = g.attributes.position.array;
    for (let i = 0; i < p.length; i++) assert.ok(Number.isFinite(p[i]), `non-finite vertex at ${i}`);
    assert.ok(g.boundingSphere && Number.isFinite(g.boundingSphere.radius));
  }
  belt.update(1.234);
  const m = new THREE.Matrix4();
  for (let i = 0; i < belt.count; i++) {
    belt.meshes[belt.mesh[i]].getMatrixAt(belt.slot[i], m);
    for (const v of m.elements) assert.ok(Number.isFinite(v), `non-finite matrix for rock ${i}`);
  }
  belt.dispose();
});
