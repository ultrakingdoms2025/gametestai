import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as THREE from 'three';
import { RaceWorld } from '../../src/worlds/RaceWorld.js';
import { RaceCourse, mulberry32 } from '../../src/worlds/RaceTrack.js';
import {
  CIRCUITS, CourseSet, baseTerrain, worldControls,
} from '../../src/worlds/RaceCircuits.js';

/**
 * WHERE THE TRACKSIDE FURNITURE ACTUALLY LANDED.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Two house rules, each correct on its own, are a bug together.
 *
 *   1. One scratch vector per module, never allocate in a loop. `RaceWorld.js`
 *      has `_v1`.
 *   2. A method that computes a point writes it into a vector the CALLER
 *      supplies. `_roadPoint(co, i, lat, w, out)` does.
 *
 * So the callers hold their road point in `_v1` and place several pieces
 * against it:
 *
 *     this._roadPoint(co, i, lat, w, _v1);              // _v1.y = road height
 *     B.box('metal.panel', 3.2, 2.6, 2.6, _v1.x, _v1.y + 1.3, _v1.z, ...);
 *     B.box('metal.trim',  3.6, 0.3, 3.0, _v1.x, _v1.y + 2.75, _v1.z, ...);
 *
 * and `Batch.box` composed its placement matrix in `_v1` too. JavaScript
 * evaluates arguments before the callee runs, so the FIRST line is right and
 * every line after it measures from the previous piece instead of from the
 * ground. Nothing in either line is wrong. Nothing in either comment is wrong.
 * The pair is wrong, and it compounds.
 *
 * ── What it cost, measured on the shipped tree ────────────────────────────
 *
 *   marshal post   lid  +1.30 m   hazard band  +4.05 m   collider  +6.35 m
 *   tyre stack     2nd tyre +0.21, 3rd +0.84, band +1.89, collider  +3.21 m
 *   chicane block  top  +0.28 m                          collider  +1.11 m
 *   oil drum       lid  +0.58 m                          collider  +1.44 m
 *   barrier piece  top  +0.39 m                          collider  +1.07 m
 *   wind mast      one blade at the hub, one at the wrong radius
 *
 * 514 colliders across the three circuits, every one of them the collider of
 * something the player is supposed to be able to hit, floating between 1.07 m
 * and 6.35 m above it with nothing solid at the object itself. The tyre stacks
 * on the outside of every fast corner were driven straight through.
 *
 * ── Why the tests are shaped like this ────────────────────────────────────
 *
 * A merged `Batch` throws away which piece was which - one mesh per material
 * per district - so the bounding box of `metal.trim` on a real circuit is the
 * union of 29 marshal-post lids at 29 different road heights and hides a
 * uniform 1.30 m lift completely. Hence two shapes of test:
 *
 *   * The pieces that get their OWN group (track obstacles, chicanes) are
 *     checked on the real circuits, per piece, against their own drawn box.
 *   * The pieces that are merged are checked on a FLAT synthetic course, where
 *     every instance is at the same height and the merged box is therefore one
 *     instance's box exactly.
 *
 * Every number below is derived from another number in the same run - a lid
 * caps the box beneath it, a band is painted on a face that exists, a rotor is
 * balanced about its own mast. None is a constant transcribed from the world,
 * because a gate whose expected value can be edited to match a regression is
 * not a gate.
 */

const P = RaceWorld.prototype;
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const MAT = new THREE.MeshBasicMaterial();

/* ------------------------------------------------------------------ */
/* A world stood up far enough to place furniture, and no further.      */
/* ------------------------------------------------------------------ */

/**
 * @param {(x:number,z:number)=>number} [ground]
 * @returns {{self:object, colliders:Array}}
 */
function stand(ground = null) {
  const colliders = [];
  const record = (c) => {
    colliders.push(c);
    return c;
  };
  const self = {
    rnd: mulberry32(0x5eed),
    group: new THREE.Group(),
    _owned: [],
    _variantFurniture: [],
    courseSet: { surfaceHeight: ground ?? (() => 0) },
    _roadPoint: P._roadPoint,
    _orientedBox: (c, n, along, hx, hy, hz) =>
      record({ kind: 'oriented', x: c.x, y: c.y, z: c.z, hx, hy, hz }),
    _mat: () => MAT,
    track: (x) => x,
    _flushFence() {},
    _buildVariantFurniture() {},
    _buildTrackObstacles() {},
    setDifficulty() {},
    variant: 'standard',
    physics: {
      addRotatedBox: (c, h) =>
        record({ kind: 'rotated', x: c.x, y: c.y, z: c.z, hx: h.x, hy: h.y, hz: h.z }),
      addBox: (x, y, z, hx, hy, hz) => record({ kind: 'box', x, y, z, hx, hy, hz }),
      add: (col) => {
        const p = new THREE.Vector3().setFromMatrixPosition(col.matrix ?? col.opts.matrix);
        return record({ kind: 'collider', x: p.x, y: p.y, z: p.z });
      },
    },
  };
  return { self, colliders };
}

/** The real, surveyed circuits - the same objects the world builds from. */
function realCircuits() {
  const circuits = CIRCUITS.map((def) => ({
    def,
    id: def.id,
    origin: def.origin ?? { x: 0, z: 0 },
    course: new RaceCourse(worldControls(def), {
      spacing: 2, verge: 11, baseHeight: baseTerrain, maxBankDeg: 5, cornerWiden: 0.2,
    }),
  }));
  return {
    circuits,
    set: new CourseSet(circuits.map((c) => c.course), baseTerrain),
  };
}

/**
 * A dead-level closed circuit. `maxBankDeg: 0` and a flat base height put every
 * sample at y = 0, so anything placed "0.3 m above the road" is at 0.3 m
 * wherever on the lap it landed, and a merged mesh's bounding box is one
 * instance's bounding box.
 *
 * @param {number} R radius; also the corner radius, which decides which
 *   furniture the builders think the circuit deserves.
 */
function flatCircuit(R, dressing, id = 'flat') {
  const cp = [];
  for (let i = 0; i < 16; i++) {
    const a = (i / 16) * Math.PI * 2;
    cp.push({ x: Math.cos(a) * R, z: Math.sin(a) * R, y: 0, w: 9, v: 11 });
  }
  const course = new RaceCourse(cp, {
    spacing: 2, verge: 11, baseHeight: () => 0, maxBankDeg: 0, cornerWiden: 0,
  });
  for (let i = 0; i < course.count; i++) {
    assert.equal(course.y[i], 0, 'the flat course is not flat - the fixture is wrong');
    assert.equal(course.bank[i], 0, 'the flat course is banked - the fixture is wrong');
  }
  return { def: { dressing, fenced: null }, id, origin: { x: 0, z: 0 }, course };
}

/** Bounding box of one merged mesh, by the name `Batch.flush` gave it. */
function meshBox(group, suffix) {
  let hit = null;
  group.traverse((o) => {
    if (o.isMesh && o.name.endsWith(suffix)) {
      assert.equal(hit, null, `two meshes end in "${suffix}"`);
      hit = o;
    }
  });
  assert.ok(hit, `no mesh named "*${suffix}" - the builder did not run`);
  hit.geometry.computeBoundingBox();
  const b = hit.geometry.boundingBox;
  return {
    mesh: hit,
    lo: b.min.clone(),
    hi: b.max.clone(),
    meanX: meanX(hit.geometry),
  };
}

function meanX(geo) {
  const p = geo.attributes.position;
  let s = 0;
  for (let i = 0; i < p.count; i++) s += p.getX(i);
  return s / p.count;
}

/** Union box of every mesh under an object. */
function groupBox(obj) {
  const b = new THREE.Box3();
  let any = false;
  obj.traverse((o) => {
    if (!o.isMesh) return;
    o.geometry.computeBoundingBox();
    b.union(o.geometry.boundingBox);
    any = true;
  });
  return any ? b : null;
}

/* ================================================================== */
/* 1. The pieces that keep their own group                             */
/* ================================================================== */

/**
 * Every track obstacle and every chicane block is built into a `THREE.Group` of
 * its own, with its colliders held beside it in `_variantFurniture` so the
 * difficulty setting can show and hide them together. That pairing is the test:
 * the collider of a thing has to be inside the thing.
 *
 * This one runs on the REAL circuits, because it does not need the heights to
 * agree - each piece is compared against its own geometry.
 */
test('an obstacle\'s collider is inside the obstacle, on all three circuits', () => {
  const { circuits, set } = realCircuits();
  let checked = 0;
  const bad = [];

  for (const which of ['_buildTrackObstacles', '_buildVariantFurniture']) {
    for (const cir of circuits) {
      const { self } = stand();
      self.courseSet = set;
      P[which].call(self, cir);
      assert.ok(self._variantFurniture.length,
        `${which} on ${cir.id} produced no furniture`);

      for (const item of self._variantFurniture) {
        const box = groupBox(item.mesh);
        assert.ok(box, `${item.mesh.name} drew nothing`);
        for (const c of item.colliders) {
          checked++;
          if (c.y < box.min.y || c.y > box.max.y
            || c.x < box.min.x || c.x > box.max.x
            || c.z < box.min.z || c.z > box.max.z) {
            if (bad.length < 4) {
              bad.push(`${item.mesh.name}: collider at y=${c.y.toFixed(2)} but the `
                + `object spans y ${box.min.y.toFixed(2)}..${box.max.y.toFixed(2)} `
                + `(${(c.y - box.max.y).toFixed(2)} m clear of the top of it)`);
            }
          }
        }
      }
    }
  }

  assert.ok(checked >= 150, `only ${checked} colliders reached - the fixture stopped early`);
  assert.deepEqual(bad, [],
    `${bad.length}+ of ${checked} obstacle colliders float outside their own object; `
    + 'a car passes through the drawn obstacle and hits nothing, then hits nothing '
    + 'visible above it');
});

/* ================================================================== */
/* 2. The pieces that are merged away                                  */
/* ================================================================== */

/**
 * The marshal post: a 2.6 m box, a lid on top of it, a hazard band painted
 * across its face, and a collider that is meant to BE the box.
 *
 * A 150 m lap at 2 m spacing is 96 samples and the builder posts one every 96,
 * so exactly one post exists and the merged bounding box is that post.
 */
test('the marshal post is one object: lid on the box, band on its face, collider in it', () => {
  const cir = flatCircuit(24, 'coast');
  const { self, colliders } = stand();
  P._buildTrackside.call(self, cir);

  const panel = meshBox(self.group, ':metal.panel');
  const lid = meshBox(self.group, ':metal.trim');
  const band = meshBox(self.group, ':hazard.stripe');

  assert.equal(colliders.length, 1, 'one post, one collider');
  const c = colliders[0];

  // The post stands ON the road, which on this course is y = 0.
  assert.ok(Math.abs(panel.lo.y) < 0.05,
    `the post is not on the ground: its foot is at ${panel.lo.y.toFixed(2)} m`);

  // A lid caps the thing under it. Bevelled boxes round their corners in, so
  // the lid's underside may sit a couple of centimetres proud - not 1.30 m.
  assert.ok(Math.abs(lid.lo.y - panel.hi.y) < 0.06,
    `the lid floats: its underside is at ${lid.lo.y.toFixed(2)} m and the box it `
    + `caps ends at ${panel.hi.y.toFixed(2)} m - a gap of `
    + `${(lid.lo.y - panel.hi.y).toFixed(2)} m`);

  // A band is painted on a face, so it is inside the box's own height.
  assert.ok(band.lo.y >= panel.lo.y - 0.02 && band.hi.y <= panel.hi.y + 0.02,
    `the hazard band spans ${band.lo.y.toFixed(2)}..${band.hi.y.toFixed(2)} m but the `
    + `post it is painted on spans ${panel.lo.y.toFixed(2)}..${panel.hi.y.toFixed(2)} m`);

  // And the collider is the post.
  assert.ok(c.y >= panel.lo.y && c.y <= panel.hi.y,
    `the post's collider is at ${c.y.toFixed(2)} m, `
    + `${(c.y - panel.hi.y).toFixed(2)} m above the top of the post it belongs to`);
  assert.ok(Math.abs((c.y - c.hy) - panel.lo.y) < 0.06,
    `the collider's foot is at ${(c.y - c.hy).toFixed(2)} m and the post's foot is at `
    + `${panel.lo.y.toFixed(2)} m`);
});

/**
 * The tyre stacks: three tyres and a painted band, on the outside of every
 * corner tight enough to be worth protecting. This is the one that mattered
 * most - they are the only thing between a car that has lost it and the
 * countryside, and every one of them was a hologram.
 *
 * A 24 m radius is 1/24 curvature, comfortably inside the 1/90 the builder
 * asks for, so the whole lap gets stacks; flat, so they are all the same
 * stack.
 */
test('the tyre stack is a stack, and its collider is in it', () => {
  const cir = flatCircuit(24, 'coast');
  const { self, colliders } = stand();
  P._buildBarriers.call(self, cir);

  const tyres = meshBox(self.group, 'tyres.flat:metal.iron');
  const band = meshBox(self.group, 'tyres.flat:paint.enamel');

  const tall = tyres.hi.y - tyres.lo.y;
  // Three tyres, bevel and all, are three tyres tall. The drawn stack cannot
  // be taller than the space three of them occupy unless there are gaps in it.
  const one = 0.42;
  assert.ok(tall <= one * 3 + 0.02,
    `three 0.42 m tyres stand ${tall.toFixed(2)} m tall - `
    + `${(tall - one * 3).toFixed(2)} m of that is air between them`);

  assert.ok(Math.abs(band.lo.y - tyres.hi.y) < 0.06,
    `the painted band is at ${band.lo.y.toFixed(2)} m and the top tyre ends at `
    + `${tyres.hi.y.toFixed(2)} m`);

  const stackCols = colliders.filter((c) => c.hy > 0.6 && c.hy < 0.7);
  assert.ok(stackCols.length > 20,
    `only ${stackCols.length} tyre colliders - the fixture found the wrong ones`);
  for (const c of stackCols) {
    assert.ok(c.y - c.hy >= tyres.lo.y - 0.05 && c.y + c.hy <= tyres.hi.y + 0.05,
      `a tyre stack's collider spans ${(c.y - c.hy).toFixed(2)}..${(c.y + c.hy).toFixed(2)} m `
      + `while the stack it guards spans ${tyres.lo.y.toFixed(2)}..${tyres.hi.y.toFixed(2)} m - `
      + 'a car drives through the tyres and hits nothing');
  }
});

/**
 * The wind mast: a tower and three blades at 120 degrees around a hub.
 *
 * Three evenly spaced blades are BALANCED - the horizontal offsets sum to
 * zero - so the rotor's centre of mass is on the mast. That is a property of
 * the design rather than a number copied out of it, and it is exactly what
 * a compounding offset destroys: the bug put one blade on the hub and one at
 * the wrong radius, which is a rotor no engineer would have shipped.
 */
test('the wind mast\'s rotor is balanced about its own tower', () => {
  const cir = flatCircuit(24, 'highland');
  const { self } = stand();
  P._buildTrackside.call(self, cir);

  const tower = meshBox(self.group, ':metal.rail');
  const blades = meshBox(self.group, ':paint.white');

  assert.ok(Math.abs(blades.meanX - tower.meanX) < 0.05,
    `the rotor's centre of mass is ${(blades.meanX - tower.meanX).toFixed(2)} m off `
    + 'its own mast in X: the blades are not where three evenly spaced blades go');
});

/* ================================================================== */
/* 3. The rule itself                                                  */
/* ================================================================== */

/**
 * The behavioural tests above are the evidence; this is the fence.
 *
 * `Batch` is a placement helper called in the middle of blocks that are holding
 * a point in the module scratch. It cannot share that scratch, and a future
 * edit that "tidies" its private `_bv1` back into the module block would
 * silently reintroduce every defect above. There is no way to express that in
 * the type system, so it is expressed here.
 */
test('Batch composes in its own scratch, never the module scratch its callers hold', () => {
  const src = readFileSync(path.join(root, 'src/worlds/RaceWorld.js'), 'utf8')
    .replace(/\r\n/g, '\n');
  const open = src.indexOf('\nclass Batch {');
  assert.ok(open > 0, 'class Batch has been renamed - update this test');
  // A class body ends at the first `}` in the first column after it opens.
  const close = src.indexOf('\n}\n', open + 1);
  assert.ok(close > open, 'could not find the end of class Batch');
  const body = src.slice(open, close);
  assert.ok(body.includes('  box(key, w, h, d, x, y, z'),
    'the slice did not capture Batch.box - the class shape has changed');
  // Comments are where this rule is EXPLAINED, so they name the scratch they
  // forbid. Strip them, or the fence fires on its own documentation.
  const code = body.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/[^\n]*/g, ' ');

  for (const name of ['_v1', '_v2', '_v3', '_v4', '_n1', '_a1', '_m1', '_q1', '_e1', '_color']) {
    assert.ok(!new RegExp(`\\b${name}\\b`).test(code),
      `Batch touches the module scratch "${name}". Its callers hold their road `
      + 'point in _v1 across several box() calls, so every piece after the first '
      + 'is placed relative to the previous piece. Use Batch\'s own _b* scratch.');
  }
});
