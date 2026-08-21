import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';

import { buildPropField } from '../../src/worlds/planets/PlanetProps.js';
import { definePlanet, PROP_KINDS } from '../../src/worlds/planets/PlanetDescriptor.js';
import { VOLCANIC } from '../../src/worlds/planets/Volcanic.js';

/**
 * THE PROP FAMILIES: IS IT VARIED, IS IT FINITE, AND CAN YOU WALK BETWEEN IT?
 *
 * ═══════════════════════════════════════════════════════════════════════════
 *  WHY THIS FILE EXISTS
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Three defects this project has actually paid for meet in `PlanetProps.js`,
 * and there is one block below for each of them.
 *
 * 1. **A NaN in a mesh.** Nineteen non-finite pixels went through the bloom
 *    pass and blacked out all 921,600 of them. A prop field is 1,100 instance
 *    matrices built out of descriptor arithmetic, which is the widest surface
 *    in the renderer for a division by zero to get in through. So every
 *    instance matrix of every family is DECOMPOSED here and its position,
 *    quaternion and scale are each proved finite - and the degenerate size
 *    records that could produce one are proved to THROW rather than to build.
 *
 * 2. **"They look like they are made of square blocks."** Rejected three times
 *    on the ship hulls. The lesson recorded was that the primitive is the
 *    problem - but a correct primitive stamped N times at one size is the same
 *    failure wearing a better hat, and it is a failure NOBODY CAN SEE FROM THE
 *    CODE. So the field is measured: heights, half-widths, headings and tilts
 *    all have to have a real spread, and the instances have to be individually
 *    non-uniform, or a stand of forty reads as one object at forty addresses.
 *
 * 3. **Built but not reachable.** Fifteen medieval enterables, a station
 *    mezzanine, a colonnade with an ore seam trapped inside it. A collider is
 *    the cheapest way to ship it again: a full-height box round a needle closes
 *    every lane in a spire field, and a box round a canopy is a ceiling over a
 *    jungle. Each family's collider is measured against the geometry it stands
 *    for and has to be the UNDER-side of it.
 *
 * Nothing here needs a renderer, a canvas or a GL context: `buildPropField`
 * takes a height function, a material and a physics sink, and every claim below
 * is read back out of the `InstancedMesh` it returns.
 */

/* ================================================================== */
/* A field, built without a browser                                    */
/* ================================================================== */

const HALF = 200;

/** Gentle rolling ground. Not flat: a flat height function would hide a sink
 *  bug by making every instance's Y the same number. */
const HEIGHT = (x, z) => Math.sin(x * 0.011) * 2.4 + Math.cos(z * 0.013) * 1.7;

/** A physics sink that records what shape each family actually asked for. */
function sink() {
  return {
    boxes: [],
    rotated: [],
    addBox(x, y, z, hx, hy, hz) {
      const c = { x, y, z, hx, hy, hz, yaw: 0 };
      this.boxes.push(c);
      return c;
    },
    addRotatedBox(centre, half, yaw) {
      const c = { x: centre.x, y: centre.y, z: centre.z, hx: half.x, hy: half.y, hz: half.z, yaw };
      this.rotated.push(c);
      return c;
    },
  };
}

/** The size record and palettes each new family is exercised with. */
const FAMILY = {
  spires: {
    spec: {
      size: { h: [3, 11], base: [0.4, 1.4], lean: 0.22, facets: 5 },
      tint: [0x9fd8ff, 0x7fb8e8, 0xc4e6ff],
      spacing: 4,
    },
    ranges: ['h', 'base'],
    knobs: ['lean', 'facets'],
  },
  growth: {
    spec: {
      size: { trunk: [0.18, 0.42], h: [4, 9], canopy: [1.6, 3.4], droop: 0.5 },
      tint: [0x4f7a3a, 0x35602c, 0x63894a],
      trunkTint: [0x5a4632, 0x473526],
      spacing: 5,
    },
    ranges: ['trunk', 'h', 'canopy'],
    knobs: ['droop'],
  },
  slabs: {
    spec: {
      size: { w: [1.5, 4.0], d: [1.2, 3.2], t: [0.15, 0.5], tilt: 0.6 },
      tint: [0xb9c6cc, 0x93a4ac, 0xd4dee2],
      spacing: 4,
    },
    ranges: ['w', 'd', 't'],
    knobs: ['tilt'],
  },
};

const NEW_KINDS = Object.keys(FAMILY);
const COUNT = 120;

/**
 * Build one field and read every instance back out of the mesh.
 *
 * The region is the whole playfield with NO filters, so `scatter` rejects
 * nothing but a spacing clash and `placed` is a statement about this module
 * rather than about a slope ceiling.
 */
function field(kind, over = {}, seed = 0x51ce) {
  const base = FAMILY[kind] ? FAMILY[kind].spec : {};
  const phys = sink();
  const group = new THREE.Group();
  const material = new THREE.MeshStandardMaterial({ name: 'planet.test.rock', vertexColors: true });
  const spec = {
    id: `${kind}_field`,
    kind,
    region: { shape: 'field' },
    count: COUNT,
    collide: true,
    ...base,
    ...over,
    size: { ...(base.size ?? {}), ...(over.size ?? {}) },
  };
  const built = buildPropField(spec, {
    height: HEIGHT,
    half: HALF,
    slopeStep: 3.125,
    seed,
    liquid: null,
    landing: [],
    material,
    physics: phys,
    group,
    track: (c) => c,
  });

  const m = new THREE.Matrix4();
  const inst = [];
  for (let i = 0; i < built.placed; i++) {
    const p = new THREE.Vector3();
    const q = new THREE.Quaternion();
    const s = new THREE.Vector3();
    built.mesh.getMatrixAt(i, m);
    m.decompose(p, q, s);
    const up = new THREE.Vector3(0, 1, 0).applyQuaternion(q);
    const fwd = new THREE.Vector3(1, 0, 0).applyQuaternion(q);
    inst.push({
      p,
      q,
      s,
      tilt: Math.acos(Math.min(1, Math.max(-1, up.y))),
      heading: Math.atan2(fwd.z, fwd.x),
    });
  }
  return { spec, built, inst, phys, group, material };
}

const finite = (...v) => v.every((n) => Number.isFinite(n));
const spread = (v) => Math.max(...v) / Math.max(1e-9, Math.min(...v));
const distinct = (v) => new Set(v.map((n) => n.toFixed(5))).size;

/* ================================================================== */
/* 1. IS IT THERE, AND IS IT ONE DRAW CALL                             */
/* ================================================================== */

for (const kind of NEW_KINDS) {
  test(`${kind}: every instance asked for is placed, in one mesh`, () => {
    const { built, group } = field(kind);
    /* No region filter and no liquid, so the ONLY thing that may reduce the
     * count is a spacing clash - and `scatter` reports that rather than padding
     * the array, which is the property the whole placement module exists for. */
    const short = built.requested - built.placed;
    assert.equal(built.requested, COUNT);
    assert.equal(short, built.rejects.spacing > 0 ? short : 0);
    assert.equal(built.placed, COUNT,
      `${kind} placed ${built.placed} of ${COUNT}; rejects ${JSON.stringify(built.rejects)}`);
    assert.equal(built.points.length, built.placed);

    // One InstancedMesh, one geometry, one material: one draw call.
    assert.equal(group.children.length, 1);
    const mesh = group.children[0];
    assert.ok(mesh.isInstancedMesh, `${kind} is not instanced - that is ${COUNT} draw calls`);
    assert.equal(mesh.count, built.placed);
    assert.equal(mesh, built.mesh);
    assert.ok(mesh.instanceColor, `${kind} wrote no per-instance tint`);
  });
}

test('a prop family is affordable: triangles per instance stay in the low tens', () => {
  /* The budget this file is really guarding is the DRAW CALL, and the block
   * above pins that. This one keeps the geometry honest so a thousand-instance
   * field is not a million triangles: reported, and floored only loosely. */
  const rows = NEW_KINDS.map((kind) => {
    const { built } = field(kind, { count: 1 });
    const g = built.geo;
    const tris = (g.index ? g.index.count : g.attributes.position.count) / 3;
    return { kind, tris };
  });
  for (const r of rows) {
    assert.ok(r.tris >= 8, `${r.kind} is ${r.tris} triangles - too few to be a shape`);
    assert.ok(r.tris <= 160, `${r.kind} is ${r.tris} triangles per instance; 1,100 of them is ${r.tris * 1100}`);
  }
  console.log(`     per instance: ${rows.map((r) => `${r.kind} ${r.tris} tris`).join(', ')}`
    + ` - a 1,100-instance ejecta-sized field of the dearest is`
    + ` ${Math.max(...rows.map((r) => r.tris)) * 1100} triangles in ONE call`);
});

/* ================================================================== */
/* 2. IS IT FINITE                                                     */
/* ================================================================== */

for (const kind of NEW_KINDS) {
  test(`${kind}: every instance matrix decomposes to finite position, rotation and scale`, () => {
    const { inst, built } = field(kind);
    assert.ok(inst.length > 0);
    for (let i = 0; i < inst.length; i++) {
      const { p, q, s } = inst[i];
      assert.ok(finite(p.x, p.y, p.z), `${kind}[${i}] position ${p.toArray()}`);
      assert.ok(finite(q.x, q.y, q.z, q.w), `${kind}[${i}] quaternion ${q.toArray()}`);
      assert.ok(finite(s.x, s.y, s.z), `${kind}[${i}] scale ${s.toArray()}`);
      /* A zero scale is the NaN factory itself: `Matrix4.decompose` divides the
       * basis by the scale to recover the rotation, so a zero anywhere here
       * would already have shown up as a NaN quaternion above. Asserted
       * separately so the failure names the cause and not the symptom. */
      assert.ok(s.x > 0 && s.y > 0 && s.z > 0, `${kind}[${i}] has a zero scale axis ${s.toArray()}`);
      assert.ok(Math.abs(q.length() - 1) < 1e-5, `${kind}[${i}] quaternion is not unit`);
    }
    // And the buffer itself, not just what decompose gave back.
    for (const n of built.mesh.instanceMatrix.array) assert.ok(Number.isFinite(n), 'raw instance matrix holds a non-finite');
    for (const n of built.mesh.instanceColor.array) assert.ok(Number.isFinite(n) && n >= 0, 'instance colour holds a non-finite');
    for (const n of built.geo.attributes.position.array) assert.ok(Number.isFinite(n), `${kind} geometry holds a non-finite position`);
    for (const n of built.geo.attributes.normal.array) assert.ok(Number.isFinite(n), `${kind} geometry holds a non-finite normal`);
  });
}

test('the four families that were already here are still finite', () => {
  /* A regression guard, and a cheap one: the three new kinds share the instance
   * loop with the old four, and the switch they were added to used to fall
   * THROUGH to vents on its default arm. */
  const old = [
    ['columns', { rMin: 0.9, rMax: 2.3, hMin: 3.5, hMax: 13, sides: 6 }],
    ['shards', { wMin: 0.45, wMax: 1.7, hMin: 1.1, hMax: 4.6 }],
    ['boulders', { rMin: 0.65, rMax: 3.3 }],
    ['vents', { rMin: 0.8, rMax: 2.6 }],
  ];
  for (const [kind, size] of old) {
    const { inst } = field(kind, { size, spacing: 6, tint: [0x2b2726] });
    assert.equal(inst.length, COUNT, `${kind} lost instances`);
    for (const { p, q, s } of inst) {
      assert.ok(finite(p.x, p.y, p.z, q.x, q.y, q.z, q.w, s.x, s.y, s.z), `${kind} is non-finite`);
      assert.ok(s.x > 0 && s.y > 0 && s.z > 0);
    }
  }
});

test('the shipped planet still builds every field it declares', () => {
  for (const spec of VOLCANIC.props) {
    const { built, inst } = field(spec.kind, { ...spec, count: Math.min(spec.count, 200) });
    assert.ok(built.placed > 0, `${spec.id} placed nothing`);
    for (const { p, q, s } of inst) {
      assert.ok(finite(p.x, p.y, p.z, q.x, q.y, q.z, q.w, s.x, s.y, s.z), `${spec.id} is non-finite`);
    }
  }
});

/* ================================================================== */
/* 3. IS IT VARIED, OR IS IT ONE OBJECT AT N ADDRESSES                 */
/* ================================================================== */

for (const kind of NEW_KINDS) {
  test(`${kind}: the field is varied - heights, widths, headings and tilts all move`, () => {
    const { inst } = field(kind);
    const n = inst.length;
    const sy = inst.map((i) => i.s.y);
    const sx = inst.map((i) => i.s.x);
    const sz = inst.map((i) => i.s.z);

    /* Size. Both a SPREAD (the field has big ones and small ones) and a COUNT
     * of distinct values (they are not three sizes repeated forty times). */
    assert.ok(spread(sy) > 1.4, `${kind} heights span only ${spread(sy).toFixed(2)}x`);
    assert.ok(spread(sx) > 1.4, `${kind} widths span only ${spread(sx).toFixed(2)}x`);
    assert.ok(distinct(sy) > n * 0.8, `${kind} has ${distinct(sy)} distinct heights across ${n} instances`);
    assert.ok(distinct(sx) > n * 0.8, `${kind} has ${distinct(sx)} distinct widths across ${n} instances`);

    /* Non-uniform PER INSTANCE. This is the one that separates "forty different
     * sizes of the same object" from "forty different objects": if x and z
     * always match, every instance is a solid of revolution and the yaw below
     * is rotating a symmetry, which is the same as doing nothing. */
    const aniso = inst.filter((i) => Math.abs(i.s.x - i.s.z) / Math.max(i.s.x, i.s.z) > 0.02).length;
    assert.ok(aniso > n * 0.8, `${kind}: only ${aniso}/${n} instances are non-uniform in x vs z`);

    /* Heading. A full turn, spent, not a favourite quarter. */
    const heads = inst.map((i) => i.heading);
    assert.ok(Math.max(...heads) - Math.min(...heads) > 5.5,
      `${kind} headings only span ${(Math.max(...heads) - Math.min(...heads)).toFixed(2)} rad`);
    assert.ok(distinct(heads) > n * 0.8, `${kind} has ${distinct(heads)} distinct headings across ${n}`);

    /* Tilt off vertical. Spires lean, slabs are tilted plates, growth stands
     * nearly plumb - so the floor is read off the family's own knob rather than
     * hard-coded, and every family still has to USE most of the band it asks
     * for or the knob is decoration. */
    const knob = FAMILY[kind].spec.size.lean ?? FAMILY[kind].spec.size.tilt ?? 0.05;
    const tilts = inst.map((i) => i.tilt);
    assert.ok(Math.max(...tilts) > knob * 0.5,
      `${kind} never tilts past ${Math.max(...tilts).toFixed(3)} rad against a knob of ${knob}`);
    assert.ok(distinct(tilts) > n * 0.8, `${kind} has ${distinct(tilts)} distinct tilts across ${n}`);

    /* And the whole point, stated once: no two instances are the same object. */
    const shapes = new Set(inst.map((i) => `${i.s.x.toFixed(4)}|${i.s.y.toFixed(4)}|${i.s.z.toFixed(4)}`
      + `|${i.q.x.toFixed(4)}|${i.q.y.toFixed(4)}|${i.q.z.toFixed(4)}|${i.q.w.toFixed(4)}`));
    assert.equal(shapes.size, n, `${kind}: ${n - shapes.size} instances are an exact duplicate of another`);

    console.log(`     ${kind.padEnd(7)} h ${Math.min(...sy).toFixed(2)}-${Math.max(...sy).toFixed(2)} m,`
      + ` w ${Math.min(...sx).toFixed(2)}-${Math.max(...sx).toFixed(2)} m,`
      + ` z/x ${(Math.min(...sz) / Math.max(...sx)).toFixed(2)}-${(Math.max(...sz) / Math.min(...sx)).toFixed(2)},`
      + ` tilt to ${(Math.max(...tilts) * 180 / Math.PI).toFixed(1)} deg, ${shapes.size}/${n} unique`);
  });
}

test('growth carries TWO tints per instance, and they differ', () => {
  const { built, spec } = field('growth');
  const gd = built.geo.userData.growth;
  assert.ok(gd && gd.trunkVerts > 0, 'growth geometry did not publish its trunk vertex range');

  const col = built.geo.attributes.color;
  assert.ok(col, 'growth geometry has no colour attribute - the trunk cannot differ from the canopy');
  const trunk = [col.getX(0), col.getY(0), col.getZ(0)];
  const canopy = [col.getX(gd.trunkVerts), col.getY(gd.trunkVerts), col.getZ(gd.trunkVerts)];
  assert.ok(finite(...trunk, ...canopy), 'the trunk/canopy ratio is non-finite');
  assert.deepEqual(canopy.map((v) => Math.round(v * 1e4)), [1e4, 1e4, 1e4],
    'the canopy must carry the instance colour unchanged');
  assert.ok(trunk.some((v, i) => Math.abs(v - canopy[i]) > 0.05),
    `the trunk shade ${trunk} is the same as the canopy - that is ONE tint wearing two names`);

  // Every trunk vertex the same shade, every canopy vertex white: the split is
  // clean, so a future canopy edit cannot silently repaint the trunk.
  for (let v = 0; v < col.count; v++) {
    const want = v < gd.trunkVerts ? trunk : canopy;
    for (let k = 0; k < 3; k++) {
      assert.ok(Math.abs(col.getComponent(v, k) - want[k]) < 1e-6, `vertex ${v} channel ${k} is off its side of the split`);
    }
  }

  // And the instance colour - the canopy's own - still varies instance to instance.
  const tints = new Set();
  for (let i = 0; i < built.placed; i++) {
    tints.add([0, 1, 2].map((k) => built.mesh.instanceColor.getComponent(i, k).toFixed(4)).join(','));
  }
  assert.ok(tints.size > built.placed * 0.5, `only ${tints.size} distinct canopy tints across ${built.placed}`);
  assert.ok(Array.isArray(spec.trunkTint) && spec.trunkTint.length > 0);
});

test('a field is the same field every session', () => {
  /* Determinism is the property the whole placement module is built around: a
   * planet that re-rolls its props between visits is not a place. */
  for (const kind of NEW_KINDS) {
    const a = field(kind, {}, 0x9001);
    const b = field(kind, {}, 0x9001);
    assert.deepEqual(
      Array.from(a.built.mesh.instanceMatrix.array),
      Array.from(b.built.mesh.instanceMatrix.array),
      `${kind} built differently from the same seed`,
    );
  }
});

/* ================================================================== */
/* 4. DEGENERATE SIZE RECORDS THROW, THEY DO NOT BUILD                 */
/* ================================================================== */

for (const kind of NEW_KINDS) {
  test(`${kind}: a degenerate size range throws rather than emitting NaN`, () => {
    for (const key of FAMILY[kind].ranges) {
      const cases = [
        [[9, 1], /max is below min/],
        [[0, 4], /zero or negative/],
        [[-2, 4], /zero or negative/],
        [[NaN, 4], /non-finite/],
        [[4, Infinity], /non-finite/],
        [[4], /\[min, max\] pair/],
        [4, /\[min, max\] pair/],
        [undefined, /\[min, max\] pair/],
      ];
      for (const [value, re] of cases) {
        assert.throws(
          () => field(kind, { size: { [key]: value } }),
          re,
          `${kind}.size.${key} = ${JSON.stringify(value) ?? String(value)} did not throw`,
        );
      }
    }
    for (const key of FAMILY[kind].knobs) {
      assert.throws(() => field(kind, { size: { [key]: NaN } }), /must be a finite number/,
        `${kind}.size.${key} = NaN did not throw`);
      assert.throws(() => field(kind, { size: { [key]: Infinity } }), /must be a finite number/);
    }
  });

  test(`${kind}: min === max is allowed and is still finite`, () => {
    /* Deliberately NOT a throw. A dimension that does not vary is a legitimate
     * thing to author - nothing divides by the width of a range - and refusing
     * it would be refusing the honest case in the name of the dishonest one.
     * What has to hold is that it produces numbers and not NaNs. */
    const flat = {};
    for (const key of FAMILY[kind].ranges) flat[key] = [2, 2];
    const { inst } = field(kind, { size: flat });
    assert.equal(inst.length, COUNT);
    for (const { p, q, s } of inst) {
      assert.ok(finite(p.x, p.y, p.z, q.x, q.y, q.z, q.w, s.x, s.y, s.z), `${kind} went non-finite on a flat range`);
      assert.ok(s.x > 0 && s.y > 0 && s.z > 0);
    }
    // The other channels still carry the field: yaw at minimum.
    assert.ok(distinct(inst.map((i) => i.heading)) > COUNT * 0.8,
      `${kind} with one size is one object stamped ${COUNT} times`);
  });
}

test('an unknown kind throws instead of quietly building a vent', () => {
  assert.throws(() => field('coral', { size: {} }), /unknown prop kind "coral"/);
});

/* ================================================================== */
/* 5. THE COLLIDERS - THE UNDER-SIDE OF WHAT YOU CAN SEE               */
/* ================================================================== */

test('a spire collides at its FOOT, so a field of them still has lanes', () => {
  const { inst, phys, built } = field('spires');
  assert.equal(phys.boxes.length, built.placed);
  assert.equal(phys.rotated.length, 0);
  assert.equal(built.colliders, built.placed);

  for (let i = 0; i < inst.length; i++) {
    const c = phys.boxes[i];
    const s = inst[i].s;
    assert.ok(finite(c.x, c.y, c.z, c.hx, c.hy, c.hz), `spire collider ${i} is non-finite`);
    // Not full height: the needle above the stub is walk-past scenery.
    assert.ok(c.hy * 2 < s.y * 0.5, `spire ${i} collides over ${(c.hy * 2 / s.y * 100).toFixed(0)}% of its height`);
    // Narrower than the base it stands on - the under-side, never an invisible wall.
    assert.ok(c.hx < s.x, `spire ${i} collider half-width ${c.hx.toFixed(2)} exceeds its base ${s.x.toFixed(2)}`);
    assert.ok(c.hz < s.z);
  }
  const worst = Math.max(...inst.map((v, i) => phys.boxes[i].hx / v.s.x));
  console.log(`     spire collider: ${(Math.max(...inst.map((v, i) => phys.boxes[i].hy * 2 / v.s.y)) * 100).toFixed(0)}%`
    + ` of the height at worst, ${(worst * 100).toFixed(0)}% of the base half-width`
    + ` - at 4 m spacing that leaves the lanes the geometry leaves`);
});

test('growth collides at its TRUNK, so you can walk under the canopy', () => {
  const { inst, phys, built } = field('growth');
  const gd = built.geo.userData.growth;
  assert.equal(phys.boxes.length, built.placed);
  assert.equal(phys.rotated.length, 0);

  for (let i = 0; i < inst.length; i++) {
    const c = phys.boxes[i];
    const s = inst[i].s;
    assert.ok(finite(c.x, c.y, c.z, c.hx, c.hy, c.hz), `growth collider ${i} is non-finite`);
    const canopyR = s.x * gd.canopyR;
    assert.ok(c.hx < canopyR * 0.3,
      `growth ${i} collides over ${(c.hx / canopyR * 100).toFixed(0)}% of its canopy radius - that is a ceiling, not a trunk`);
    assert.ok(c.hx <= s.x * gd.trunkR + 1e-9, `growth ${i} collider is wider than its own trunk`);
    // And it stops at the trunk: the crown is standing room.
    assert.ok(c.y + c.hy <= inst[i].p.y + gd.trunkTop * s.y + 1e-6,
      `growth ${i} collider reaches into the canopy`);
  }
  const ratio = Math.max(...inst.map((v, i) => phys.boxes[i].hx / (v.s.x * gd.canopyR)));
  console.log(`     growth collider: at worst ${(ratio * 100).toFixed(0)}% of the canopy radius,`
    + ` stopping at ${(gd.trunkTop * 100).toFixed(0)}% of the plant's height`);
});

test('a slab collides as a yawed step, never as a cube round a sheet', () => {
  const { inst, phys, built } = field('slabs');
  assert.equal(phys.rotated.length, built.placed, 'slabs must use a rotated box - an AABB round a yawed plate is an invisible wall');
  assert.equal(phys.boxes.length, 0);

  const yaws = new Set();
  const heights = [];
  let fill = 0;
  const rot = new THREE.Matrix4();
  for (let i = 0; i < inst.length; i++) {
    const c = phys.rotated[i];
    const s = inst[i].s;
    assert.ok(finite(c.x, c.y, c.z, c.hx, c.hy, c.hz, c.yaw), `slab collider ${i} is non-finite`);
    yaws.add(c.yaw.toFixed(5));
    heights.push(c.hy);
    // The footprint is the plate's own, under-sided.
    assert.ok(c.hx < s.x * 0.5, `slab ${i} collider is wider than the plate`);
    assert.ok(c.hz < s.z * 0.5);
    /* And it fits INSIDE the plate's own bounding box vertically - measured off
     * the instance's real rotation rather than off the module's formula, so the
     * two cannot be wrong together. A collider taller than the sheet it stands
     * for is the invisible wall, which is the worse of the two errors. */
    rot.makeRotationFromQuaternion(inst[i].q);
    const e = rot.elements;
    const vHalf = 0.5 * (s.x * Math.abs(e[1]) + s.y * Math.abs(e[5]) + s.z * Math.abs(e[9]));
    assert.ok(c.hy < vHalf,
      `slab ${i} collider half-height ${c.hy.toFixed(2)} exceeds the plate's own ${vHalf.toFixed(2)}`);
    fill += (c.hx * c.hy * c.hz) / (0.5 * s.x * vHalf * 0.5 * s.z);
  }
  assert.ok(yaws.size > inst.length * 0.8, `only ${yaws.size} distinct collider yaws across ${inst.length} slabs`);
  assert.ok(distinct(heights) > inst.length * 0.8,
    `only ${distinct(heights)} distinct collider heights across ${inst.length} slabs - the thickness is not varying`);
  console.log(`     slab collider: a yawed box filling ${(fill / inst.length * 100).toFixed(0)}%`
    + ` of the plate's own oriented bounding box - a step you walk onto, not a cube round a sheet`);
});

test('collide: false places no colliders at all', () => {
  for (const kind of NEW_KINDS) {
    const { phys, built } = field(kind, { collide: false });
    assert.equal(built.colliders, 0, `${kind} registered colliders it was not asked for`);
    assert.equal(phys.boxes.length + phys.rotated.length, 0);
  }
});

/* ================================================================== */
/* 6. THE EMISSIVE TINT, AND THE SCHEMA                                */
/* ================================================================== */

test('a glowing field gets its own material and still costs one draw call', () => {
  const plain = field('spires');
  assert.equal(plain.built.material, plain.material, 'a field with no glow must reuse the shared rock material');

  const lit = field('spires', { glow: 0x2f8fff, glowStrength: 2.1 });
  assert.notEqual(lit.built.material, lit.material, 'a glowing field must not repaint the shared material');
  assert.equal(lit.built.material.emissive.getHex(), new THREE.Color(0x2f8fff).getHex());
  assert.equal(lit.built.material.emissiveIntensity, 2.1);
  assert.equal(lit.material.emissive.getHex(), new THREE.Color(0x000000).getHex(),
    'the shared material was mutated - every other prop family on the planet now glows');
  // Still one mesh, still one call, and the per-instance diffuse tint survives.
  assert.equal(lit.group.children.length, 1);
  assert.equal(lit.built.material.vertexColors, true);
  assert.ok(lit.built.mesh.instanceColor);

  assert.throws(() => field('spires', { glow: NaN }), /must be a finite number/);
});

test('the descriptor knows the three new families', () => {
  for (const kind of NEW_KINDS) assert.ok(PROP_KINDS.has(kind), `PROP_KINDS is missing ${kind}`);
  for (const kind of ['columns', 'shards', 'boulders', 'vents']) assert.ok(PROP_KINDS.has(kind));
  assert.equal(PROP_KINDS.size, 7);
});

test('definePlanet accepts a planet built out of the new families, and refuses a typo', () => {
  const make = (props) => definePlanet({
    id: 'test_glacier',
    name: 'Test Glacier',
    half: 400,
    seg: 128,
    gravity: 6.1,
    terrain: {
      seed: 7,
      baseY: 0,
      landforms: [{ kind: 'pad', x: 0, z: 0, r: 30 }],
    },
    palette: { bands: [{ upTo: 0, color: 0x203040 }, { upTo: 40, color: 0xd8e8f0 }] },
    props,
    minerals: [{
      id: 'rime_salt',
      item: 'rime_salt',
      name: 'Rime Salt',
      rarity: 'common',
      terrain: 'shelf',
      place: 'The Cirque',
      unitValue: 6,
      size: 1,
      count: 20,
      region: { shape: 'disc', x: 60, z: 60, r: 80 },
    }],
    landing: [{ id: 'cirque', name: 'Cirque', x: 0, z: 0, r: 24, primary: true }],
  });

  const p = make(NEW_KINDS.map((kind) => ({
    id: `${kind}_a`,
    kind,
    region: { shape: 'disc', x: 0, z: 120, r: 90 },
    count: 60,
    size: FAMILY[kind].spec.size,
    tint: FAMILY[kind].spec.tint,
    collide: kind !== 'slabs',
  })));
  assert.equal(p.props.length, 3);
  assert.deepEqual(p.props.map((r) => r.kind), NEW_KINDS);

  assert.throws(
    () => make([{ id: 'x', kind: 'spire', region: { shape: 'field' }, count: 4 }]),
    /kind "spire" unknown/,
  );
});
