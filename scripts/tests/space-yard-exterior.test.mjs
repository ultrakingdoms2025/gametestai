import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';

/**
 * DOES THE OUTSIDE OF THE YARD AGREE WITH THE INSIDE OF IT?
 *
 * ═══════════════════════════════════════════════════════════════════════════
 *  THE DEFECTS
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Two, and the first one is the sort that only a screenshot finds.
 *
 * 1. THE LIT BAY MOUTH WAS BACK-FACE CULLED AND HAD NEVER BEEN DRAWN.
 *    `DockExterior._buildMouth` put the bay interior on a `PlaneGeometry`,
 *    whose normal is +Z, in a mouth whose normal is -Z, on a front-side
 *    material. From every vantage outside the station the one thing the whole
 *    approach is meant to aim at rendered as a black rectangle. It had a
 *    comment above it calling it "the second-longest-range cue after the
 *    beacon itself", and it was not on screen at all.
 *
 * 2. THE EXTERIOR AND THE INTERIOR DISAGREED ABOUT EVERY DIMENSION.
 *
 *                          exterior said      YardPlan says
 *        mouth width            70                164
 *        mouth height           30                 23.6
 *        hangar depth           60                162
 *        hall width            150                172
 *
 *    A hundred and sixty-two metres of hall inside a sixty metre box, and a
 *    hundred and sixty-four metre hole drawn seventy metres wide. A player
 *    walked out of one and flew back to look at the other.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 *  WHAT IS PINNED, AND HOW
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Four of the six tests below read BUILT GEOMETRY rather than constants,
 * because the constants agreeing is not the claim - the claim is that the
 * thing that gets drawn agrees. That is this project's signature defect in its
 * general form: content that was BUILT correctly and cannot be REACHED, or in
 * this case an opening that is the right size in the plan and has a girder
 * across it in the model.
 *
 * The aperture probe is the reachability probe for a ship: it marches a grid
 * across the whole 164 x 23.6 opening and through the 7 m front wall, and
 * asserts that not one merged triangle's bounding box contains any of those
 * points. Nothing about that test can pass by accident.
 *
 * MUTATION RECORD. 29 of 29 red: 22 assertion reversals plus 7 deliberate
 * breakages of the geometry itself - a girder parked across the mouth, the
 * mouth narrowed back to 70 m, the hall interior deleted, the hall interior
 * replaced by ONE PLANE FACING AWAY (the original defect, reproduced exactly),
 * the hall's emission zeroed, the habitat ring pushed outside
 * `DOCK_ANCHOR.radius`, and the roof carried on over the launch well.
 *
 * The first draft of this file scored 27 of 28, and the survivor is worth
 * recording because it was the important one: deleting the ENTIRE hall
 * interior left the "you can see something lit through the mouth" test GREEN.
 * That version counted triangles inside the hall volume and their normals, and
 * the crane and the well floodlights live in the same volume - so it was
 * measuring the wrong thing, and a box has faces pointing every way. It is a
 * raycast now, which is the same operation the GPU performs and therefore
 * cannot be fooled by geometry that is present and facing the wrong way.
 */

/* ------------------------------------------------------------------ */
/* Headless canvas, because the exterior paints its own hull plating   */
/* ------------------------------------------------------------------ */

class Img {
  constructor(a, b, c) {
    if (typeof a === 'number') {
      this.width = a; this.height = b; this.data = new Uint8ClampedArray(a * b * 4);
    } else { this.data = a; this.width = b; this.height = c ?? 1; }
  }
}
if (!globalThis.document) {
  const gradient = { addColorStop() {} };
  const context2d = (canvas) => {
    const real = {
      canvas,
      createImageData: (w, h) => new Img(Math.max(1, w | 0), Math.max(1, (h ?? w) | 0)),
      getImageData: (x, y, w, h) => new Img(Math.max(1, w | 0), Math.max(1, h | 0)),
      createLinearGradient: () => gradient,
      createRadialGradient: () => gradient,
      measureText: () => ({ width: 8 }),
      getLineDash: () => [],
    };
    return new Proxy(real, { get: (o, k) => (k in o ? o[k] : () => undefined), set: () => true });
  };
  globalThis.ImageData = Img;
  globalThis.document = {
    createElement(tag) {
      const c = { width: 1, height: 1, style: {}, tagName: tag };
      c.getContext = () => context2d(c);
      return c;
    },
    createElementNS(_ns, tag) { return this.createElement(tag); },
  };
}

const { DockExterior, DOOR_CLEAR, DOOR_FLAT } = await import('../../src/worlds/space/DockExterior.js');
const SHAPE = await import('../../src/worlds/space/DockShape.js');
const YARD = await import('../../src/worlds/dock/YardPlan.js');
const { DOCK_ANCHOR } = await import('../../src/worlds/space/Bodies.js');

/** A host with the two hooks the exterior actually uses. */
function fakeHost() {
  const boxes = [];
  return {
    boxes,
    engine: { maxAnisotropy: 1 },
    physics: { addBox: (x, y, z, hx, hy, hz) => ({ x, y, z, hx, hy, hz }) },
    track(c) { boxes.push(c); return c; },
  };
}

let _built = null;
function yard() {
  if (!_built) _built = new DockExterior(DOCK_ANCHOR, fakeHost());
  return _built;
}

/** Every drawn triangle in the exterior, as world-space vertex triples. */
function triangles(dock) {
  const out = [];
  const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3();
  dock.group.updateMatrixWorld(true);
  dock.group.traverse((o) => {
    if (!o.isMesh || o.isInstancedMesh) return;
    const g = o.geometry;
    const pos = g.attributes?.position;
    if (!pos) return;
    const idx = g.index;
    const n = idx ? idx.count : pos.count;
    for (let i = 0; i < n; i += 3) {
      const i0 = idx ? idx.getX(i) : i;
      const i1 = idx ? idx.getX(i + 1) : i + 1;
      const i2 = idx ? idx.getX(i + 2) : i + 2;
      a.fromBufferAttribute(pos, i0).applyMatrix4(o.matrixWorld);
      b.fromBufferAttribute(pos, i1).applyMatrix4(o.matrixWorld);
      c.fromBufferAttribute(pos, i2).applyMatrix4(o.matrixWorld);
      out.push([a.x, a.y, a.z, b.x, b.y, b.z, c.x, c.y, c.z]);
    }
  });
  return out;
}

/* ================================================================== */
/* 1. The shell is derived, not typed                                  */
/* ================================================================== */

test('the exterior shell is the interior plan, in the space frame', () => {
  const s = SHAPE.shellAgreement();

  // The join. One number, derived from DOCK_ANCHOR and YardPlan.
  assert.equal(s.zOffset, DOCK_ANCHOR.mouth[2] - YARD.MOUTH_Z,
    'the frame offset is not derived from the two published mouths');
  assert.equal(s.mouth.planeZ, DOCK_ANCHOR.mouth[2],
    `the exterior mouth plane is at z ${s.mouth.planeZ}, DOCK_ANCHOR says ${DOCK_ANCHOR.mouth[2]}`);

  // Claim 1: the hole is the same hole.
  assert.equal(s.mouth.width, YARD.MOUTH_HW * 2,
    `the exterior mouth is ${s.mouth.width} m wide and the player walks out of ${YARD.MOUTH_HW * 2}`);
  assert.equal(s.mouth.headY, YARD.MOUTH_Y1,
    `the exterior mouth is ${s.mouth.headY} m tall and the player walks out of ${YARD.MOUTH_Y1}`);
  assert.equal(s.mouth.sillY, YARD.DECK_Y,
    'the sill is not the assembly floor, so there is a step in the doorway');

  // Claim 2: the building contains the room.
  assert.ok(s.hall.innerWidth >= YARD.YARD_X * 2,
    `the shell is ${s.hall.innerWidth} m inside and the floor is ${YARD.YARD_X * 2} m wide`);
  assert.equal(s.hall.depth, YARD.YARD_Z1 - YARD.YARD_Z0,
    `the shell is ${s.hall.depth} m deep and the hall is ${YARD.YARD_Z1 - YARD.YARD_Z0}`);
  assert.ok(s.hall.roofY >= YARD.ROOF_Y,
    `the shell roof is at ${s.hall.roofY} and the interior truss is at ${YARD.ROOF_Y}`);

  // Claim 3: the roof stops where the roof stops.
  assert.equal(s.well.backZ, YARD.ROOF_CUT_Z + s.zOffset,
    'the open well does not start at ROOF_CUT_Z, so the interior sky is a lie');
  assert.equal(s.well.depth, YARD.ROOF_CUT_Z - YARD.MOUTH_Z,
    `the launch well is ${s.well.depth} m and the interior's unroofed run is ` +
    `${YARD.ROOF_CUT_Z - YARD.MOUTH_Z}`);
  assert.ok(s.well.frames >= 5,
    `${s.well.frames} portal frames over a ${s.well.depth} m well on a ${SHAPE.BAY_PITCH} m pitch`);
});

/* ================================================================== */
/* 2. The lit mouth, which is the bug that was actually on screen      */
/* ================================================================== */

test('what you see through the mouth faces OUT, and is lit', () => {
  const dock = yard();
  dock.group.updateMatrixWorld(true);

  /* THE ORIGINAL BUG, PROBED THE WAY THE RENDERER SEES IT.
   *
   * `THREE.Raycaster` honours `material.side`, so a ray fired from outside the
   * station at a `FrontSide` surface whose normal points AWAY misses it
   * completely - which is exactly what the GPU did to the old bay plane, and
   * exactly why the mouth rendered black. So: stand a pilot 120 m off the
   * mouth on the approach axis, fire a grid of rays through the aperture, and
   * require that every one of them lands on something.
   *
   * A first version of this test counted triangles and normals instead, and a
   * mutation run caught it out: deleting the ENTIRE hall interior left it
   * green, because the crane and the well floodlights are inside the same
   * volume and a box has faces pointing every way. Rays do not have that
   * problem - if the room is not there, the ray goes to space. */
  const raycaster = new THREE.Raycaster();
  raycaster.far = 4000;
  const eye = new THREE.Vector3(0, 11, SHAPE.HALL_FRONT_Z - 120);
  const dir = new THREE.Vector3();
  const lit = (m) => (
    (!!m?.emissive && (m.emissiveIntensity ?? 0) > 0 && m.emissive.getHex() > 0) ||
    (!!m?.isMeshBasicMaterial && m.toneMapped === false &&
      Math.max(m.color.r, m.color.g, m.color.b) > 1.6)
  );

  let shots = 0, hits = 0, litHits = 0, throughs = [];
  for (let x = -66; x <= 66; x += 11) {
    for (let y = 2.5; y <= 21; y += 2.5) {
      shots++;
      dir.set(x - eye.x, y - eye.y, SHAPE.HALL_FRONT_Z - eye.z).normalize();
      raycaster.set(eye, dir);
      const hit = raycaster.intersectObject(dock.group, true)[0];
      if (!hit) { throughs.push([x, y]); continue; }
      hits++;
      if (lit(hit.object.material)) litHits++;
    }
  }

  assert.equal(throughs.length, 0,
    `${throughs.length} of ${shots} rays through the aperture hit NOTHING, e.g. ` +
    `${JSON.stringify(throughs.slice(0, 5))} - you can see space through the building. ` +
    'A surface that is there but faces the wrong way is invisible to a front-side ' +
    'raycast for the same reason it is invisible to the GPU, which is the bug this ' +
    'test exists for.');
  /* FLOOR 0.35, ACHIEVED 0.46 (48 of 104), CEILING 1.00.
   *
   * The ceiling is by ablation: every one of the 104 rays lands on SOME
   * interior surface (the assertion above), so if every surface in the hall
   * emitted, the ratio would be 1.00. It is not 1.00 and should not be - the
   * columns, the catwalk, the crane rails and the runway are structure, and a
   * hall in which every surface glows is a lightbox rather than a room. The
   * floor is set below the achieved value with enough headroom that ordinary
   * re-dressing does not trip it, and far enough above zero that the original
   * defect - a mouth with nothing lit behind it at all - cannot come back. */
  assert.ok(litHits / hits > 0.35,
    `only ${litHits} of ${hits} rays through the mouth land on a surface that emits ` +
    `anything (${(litHits / hits).toFixed(2)}, floor 0.35) - the bay is a dark room ` +
    'and the approach has nothing to aim at');

  /* And something in there clears the space grade's 1.60 bloom threshold, so
   * the mouth has a halo at range rather than being merely not-black. */
  let blooming = 0;
  dock.group.traverse((o) => {
    const m = o.isMesh ? o.material : null;
    if (m?.isMeshBasicMaterial && m.toneMapped === false &&
        Math.max(m.color.r, m.color.g, m.color.b) > 1.6) blooming++;
  });
  assert.ok(blooming > 0, 'no fitting clears the 1.60 bloom threshold, so nothing has a halo');
});

/* ================================================================== */
/* 3. Nothing is parked in the doorway                                 */
/* ================================================================== */

test('a ship can fly through the mouth: the aperture is empty', () => {
  const dock = yard();
  const tris = triangles(dock);

  /* Triangle bounding boxes, once. A full point-in-mesh test is not what is
   * wanted here anyway - a girder ACROSS the opening is caught by its bounding
   * box, and a false positive from a box that merely overlaps the volume is a
   * thing worth looking at by hand rather than passing silently. */
  const boxes = [];
  for (const t of tris) {
    const x0 = Math.min(t[0], t[3], t[6]), x1 = Math.max(t[0], t[3], t[6]);
    const y0 = Math.min(t[1], t[4], t[7]), y1 = Math.max(t[1], t[4], t[7]);
    const z0 = Math.min(t[2], t[5], t[8]), z1 = Math.max(t[2], t[5], t[8]);
    if (z1 < SHAPE.HALL_FRONT_Z - SHAPE.MOUTH_HALF_W || z0 > SHAPE.HALL_FRONT_Z + 40) continue;
    boxes.push([x0, x1, y0, y1, z0, z1]);
  }

  const hits = [];
  const HW = SHAPE.MOUTH_HALF_W, TOP = SHAPE.MOUTH_HEAD_Y, FZ = SHAPE.HALL_FRONT_Z;
  for (let x = -HW + 0.5; x <= HW - 0.5; x += 4) {
    for (let y = DOOR_FLAT + 0.1; y <= TOP - 0.2; y += 1.5) {
      for (let z = FZ - DOOR_CLEAR; z <= FZ + DOOR_CLEAR; z += 1) {
        for (const b of boxes) {
          if (x >= b[0] && x <= b[1] && y >= b[2] && y <= b[3] && z >= b[4] && z <= b[5]) {
            hits.push([x.toFixed(1), y.toFixed(1), z.toFixed(1)]);
            break;
          }
        }
      }
    }
  }
  assert.equal(hits.length, 0,
    `${hits.length} of the aperture's sample points are inside drawn geometry, e.g. ` +
    `${JSON.stringify(hits.slice(0, 6))} - something is parked in the doorway`);
});

/* ================================================================== */
/* 4. The opening in the drawn wall is the size the plan says          */
/* ================================================================== */

test('the hole in the built front wall is 164 x 23.6', () => {
  const dock = yard();
  const tris = triangles(dock);

  /* Sweep the front wall plane for the extent of the gap. Take every triangle
   * that straddles the mouth plane and record where it is NOT - the widest and
   * tallest empty run through the middle is the aperture as drawn. */
  const FZ = SHAPE.HALL_FRONT_Z;
  const solid = [];
  for (const t of tris) {
    const z0 = Math.min(t[2], t[5], t[8]), z1 = Math.max(t[2], t[5], t[8]);
    if (z0 > FZ - 1 || z1 < FZ - 1) continue;     // must straddle 1 m outside the plane
    solid.push([
      Math.min(t[0], t[3], t[6]), Math.max(t[0], t[3], t[6]),
      Math.min(t[1], t[4], t[7]), Math.max(t[1], t[4], t[7]),
    ]);
  }
  const blocked = (x, y) => solid.some((b) => x >= b[0] && x <= b[1] && y >= b[2] && y <= b[3]);

  // March out from the centreline at mid-height until the wall starts.
  let halfW = 0;
  for (let x = 0; x < SHAPE.HALL_OUTER_HW + 20; x += 0.25) {
    if (blocked(x, SHAPE.MOUTH_HEAD_Y / 2)) break;
    halfW = x;
  }
  // And up from just above the deck furniture until the lintel starts.
  let top = 0;
  for (let y = DOOR_FLAT + 0.1; y < SHAPE.HALL_TOP_Y + 10; y += 0.1) {
    if (blocked(0, y)) break;
    top = y;
  }

  assert.ok(Math.abs(halfW - SHAPE.MOUTH_HALF_W) < 1.5,
    `the drawn opening is ${(halfW * 2).toFixed(1)} m wide; YardPlan's mouth is ${YARD.MOUTH_HW * 2}`);
  assert.ok(Math.abs(top - SHAPE.MOUTH_HEAD_Y) < 1.0,
    `the drawn opening is ${top.toFixed(1)} m tall; YardPlan's mouth is ${YARD.MOUTH_Y1}`);
});

/* ================================================================== */
/* 5. The whole station fits inside DOCK_ANCHOR.radius                 */
/* ================================================================== */

test('nothing drawn escapes the bounding sphere the far-limb cap is sized on', () => {
  const dock = yard();
  const tris = triangles(dock);
  let worst = 0, at = null;
  for (const t of tris) {
    for (let k = 0; k < 9; k += 3) {
      const d = Math.hypot(t[k], t[k + 1], t[k + 2]);
      if (d > worst) { worst = d; at = [t[k], t[k + 1], t[k + 2]]; }
    }
  }
  assert.ok(worst <= DOCK_ANCHOR.radius,
    `geometry reaches ${worst.toFixed(1)} m at ${JSON.stringify(at?.map((v) => +v.toFixed(1)))}, ` +
    `outside DOCK_ANCHOR.radius ${DOCK_ANCHOR.radius}. Scale.js's far-limb cap uses that radius, ` +
    'so the far side of the station gets sliced off by the far plane at range.');
  /* And it is not absurdly small either - a bound the station does not use is
   * a bound that lets a later change sneak past this test at 200 m. */
  assert.ok(worst > DOCK_ANCHOR.radius * 0.7,
    `the station only reaches ${worst.toFixed(1)} m of its ${DOCK_ANCHOR.radius} m sphere`);
});

/* ================================================================== */
/* 6. The piers, the berths and the draw budget are still intact       */
/* ================================================================== */

test('DOCK_ANCHOR still drives the piers, and the whole yard is under 20 draws', () => {
  const host = fakeHost();
  const dock = new DockExterior(DOCK_ANCHOR, host);

  // A berth pad, a mooring gantry and two edge rails at every published berth.
  const tris = triangles(dock);
  for (const b of DOCK_ANCHOR.berths) {
    const [bx, , bz] = b.position;
    let near = 0;
    for (const t of tris) {
      const cx = (t[0] + t[3] + t[6]) / 3, cy = (t[1] + t[4] + t[7]) / 3, cz = (t[2] + t[5] + t[8]) / 3;
      if (Math.abs(cx - bx) < 14 && Math.abs(cz - bz) < 15 && cy > -3 && cy < 15) near++;
    }
    assert.ok(near > 60, `berth ${b.id} at ${bx},${bz} has only ${near} triangles on it`);
  }
  // Collided, so a player standing on a pier is standing on something.
  assert.ok(host.boxes.length >= 4 * 4,
    `only ${host.boxes.length} colliders - the piers are not solid`);

  /* The draw budget. Every batched material is one mesh; the whole exterior is
   * on screen from almost every vantage in the volume, so this is paid
   * continuously and is worth a ceiling. It was 28 objects before this change
   * and it is fewer now, on twenty times the geometry. */
  let meshes = 0;
  dock.group.traverse((o) => { if (o.isMesh) meshes++; });
  assert.ok(meshes <= 20, `the yard exterior draws ${meshes} meshes; the ceiling is 20`);
  dock.dispose();
});
