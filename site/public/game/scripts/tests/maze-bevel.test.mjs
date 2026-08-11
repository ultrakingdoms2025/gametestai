import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MAZE, generateTopology } from '../../src/worlds/maze/MazeTopology.js';
import { districtColliders } from '../../src/worlds/maze/MazeColliders.js';
import { footingTransforms } from '../../src/worlds/maze/MazeFoliage.js';
import { prefabFor, extentClass } from '../../src/worlds/maze/MazeMeshes.js';
import { CHAMFER, chamferFor, contactShade, CONTACT_AO } from '../../src/worlds/maze/MazeProfiles.js';
import { BATCH_FAMILIES, GEOMETRY_BUDGET } from '../../src/worlds/maze/MazeBatches.js';
import { buildMazeMaterials } from '../../src/worlds/maze/MazeMaterials.js';

/**
 * Task 4's gate: bevelled profiles and baked contact AO on the box kinds.
 *
 * Two properties carry everything here. The bevel is authored in WORLD UNITS,
 * so it is the same 4 cm on a hedge's long axis and its thin one - which is
 * the entire reason Task 1 moved the extents out of the instance matrix and
 * into the geometry. And the AO lives in a VERTEX COLOUR attribute, so it
 * ships inside the shared cached prefab, re-rolls for free, and never needs a
 * second UV set or a texture per district the way a lightmap would.
 */

const triCount = (g) => g.index.count / 3;

/**
 * The chamfer width as the geometry actually carries it: how far the top
 * face's rim stands in from the prefab's own widest x. Measured rather than
 * read from a constant, because the failure this test exists to catch is the
 * constant being applied in the wrong FRAME (scaled by extents), and a
 * scaled bevel still matches its constant in the frame it was scaled in.
 */
function measuredBevel(g) {
  const pos = g.attributes.position;
  let maxX = 0;
  let maxY = -Infinity;
  for (let i = 0; i < pos.count; i++) {
    maxX = Math.max(maxX, Math.abs(pos.getX(i)));
    maxY = Math.max(maxY, pos.getY(i));
  }
  let topX = 0;
  for (let i = 0; i < pos.count; i++) {
    if (pos.getY(i) > maxY - 1e-6) topX = Math.max(topX, Math.abs(pos.getX(i)));
  }
  return maxX - topX;
}

/** Mean of the red channel over the lowest and highest quarter of the prefab. */
function meanColourByHeight(g) {
  const pos = g.attributes.position;
  const col = g.attributes.color;
  let minY = Infinity;
  let maxY = -Infinity;
  for (let i = 0; i < pos.count; i++) {
    const y = pos.getY(i);
    minY = Math.min(minY, y);
    maxY = Math.max(maxY, y);
  }
  const band = (maxY - minY) * 0.25;
  let lowSum = 0; let lowN = 0; let highSum = 0; let highN = 0;
  for (let i = 0; i < pos.count; i++) {
    const y = pos.getY(i);
    if (y <= minY + band) { lowSum += col.getX(i); lowN++; }
    if (y >= maxY - band) { highSum += col.getX(i); highN++; }
  }
  assert.ok(lowN > 0 && highN > 0, 'a height band contains no vertices to average');
  return { lowMean: lowSum / lowN, highMean: highSum / highN };
}

test('a bevelled prefab still fits its box, and its bevel is world-scaled', () => {
  /* The reason the registry caches by extent class and the instance matrix
   * carries no scale. A 4 cm chamfer authored on a unit cube and then scaled by
   * a wall segment's half-extents comes out 19 cm on one axis and 2 cm on the
   * other, which reads as a mistake rather than as a bevel.
   *
   * Runs against `hedge`, as the plan wrote it. Between Tasks 4 and 7 it ran
   * against `slideWall` because the hedge's bevel was deferred to the LOD
   * swap by measurement; Task 7 landed the swap and the hedge rejoined. */
  const wide = prefabFor({ kind: 'hedge', hx: 2.4, hy: 2.5, hz: 0.6, lod: 0 });
  const tall = prefabFor({ kind: 'hedge', hx: 0.6, hy: 2.5, hz: 2.4, lod: 0 });
  assert.ok(Math.abs(measuredBevel(wide) - measuredBevel(tall)) < 5e-3,
    'the bevel width depends on the descriptor extents - it is being scaled, not authored');
  assert.ok(Math.abs(measuredBevel(wide) - CHAMFER) < 5e-3,
    `the bevel measures ${measuredBevel(wide).toFixed(4)} m against an authored ${CHAMFER} m`);
});

test('a prefab carries baked contact AO on its lower edges', () => {
  const g = prefabFor({ kind: 'hedge', hx: 2.4, hy: 2.5, hz: 0.6, lod: 0 });
  assert.ok(g.attributes.color, 'no colour attribute - nothing is baked');
  const { lowMean, highMean } = meanColourByHeight(g);
  assert.ok(lowMean < highMean * 0.8,
    `AO is not darkening the base: bottom ${lowMean.toFixed(3)} vs top ${highMean.toFixed(3)}`);
});

test('the bevel spends triangles at LOD0 only; LOD1 and LOD2 stay the box', () => {
  /* The whole triangle argument of the phase depends on this: a 4 cm chamfer
   * is not resolvable at 30 m, so Task 7's LOD swap must have a 12-triangle
   * box to swap TO. A bevelled LOD1 would silently spend the saving - and
   * with hedge and footing back in the set (Task 7 delivered the swap their
   * Task 4 deferral was waiting on), the saving is now ~35,000 instances
   * deep at the tower worst case. */
  for (const kind of ['hedge', 'footing', 'floor', 'shaftWall', 'gate', 'slideWall']) {
    const near = prefabFor({ kind, hx: 0.6, hy: 2.5, hz: 3, lod: 0 });
    assert.ok(triCount(near) > 12 && triCount(near) <= 90,
      `${kind} LOD0 is ${triCount(near)} triangles - expected a bevelled box, not a box or a sculpture`);
    for (const lod of [1, 2]) {
      const far = prefabFor({ kind, hx: 0.6, hy: 2.5, hz: 3, lod });
      assert.equal(triCount(far), 12, `${kind} LOD${lod} is not the plain box`);
    }
  }
});

test('every geometry drawn with a vertexColors material carries a colour attribute', () => {
  /* The failure mode this guards is silent and total: a mesh with no colour
   * attribute under a vertexColors material renders BLACK in three. The kinds
   * here are every kind whose material gains the flag, at every LOD -
   * including the movers (gate, slideWall ride an InstancedMesh, not the
   * batches) and `stair`, which never grows a bevel of its own but shares the
   * shaftWall material object and so inherits its program family. */
  const mats = buildMazeMaterials();
  /* `newel` joined in Task 8: it aliases the stair material (see
   * MazeMaterials.js), and both its prefab variants - the authored .glb via
   * buildAssetPrefab and the procedural finial - bake the colour attribute,
   * which maze-assets.test.mjs asserts for each. */
  for (const kind of ['hedge', 'floor', 'shaftWall', 'stair', 'gate', 'slideWall', 'footing', 'newel']) {
    assert.equal(mats[kind].vertexColors, true, `'${kind}' material does not read vertex colours`);
    for (const lod of [0, 1, 2]) {
      const g = prefabFor({ kind, hx: 0.6, hy: 2.5, hz: 3, lod });
      assert.ok(g.attributes.color,
        `'${kind}' at LOD${lod} has no colour attribute and would render black`);
    }
  }
  /* And the inverse: any kind whose material did NOT gain the flag must not
   * need one. Sweep the whole set so a future flag flip cannot dodge this. */
  for (const [kind, mat] of Object.entries(mats)) {
    if (!mat.vertexColors) continue;
    assert.ok(['hedge', 'floor', 'shaftWall', 'stair', 'gate', 'slideWall', 'footing', 'newel'].includes(kind),
      `'${kind}' gained vertexColors but this suite does not know its geometry carries colour`);
  }
});

test('the chamfer clamps on thin extents instead of eating the prefab', () => {
  /* A footing is 0.15 m tall; an unclamped 4 cm chamfer is fine there, but
   * the clamp is what keeps this true for every kind that ever gets thinner.
   * The pure function is asserted directly so the property is visible without
   * reverse-engineering a geometry. */
  assert.equal(chamferFor({ hx: 3, hy: 2.5, hz: 0.6 }), CHAMFER);
  const thin = chamferFor({ hx: 3, hy: 0.03, hz: 0.6 });
  assert.ok(thin < 0.03 && thin > 0, `a 3 cm slab got a ${thin} m chamfer`);
});

test('contact shade darkens the base and nothing above the contact band', () => {
  const hy = 2.5;
  assert.ok(contactShade(-hy, hy) <= CONTACT_AO.dark + 1e-9, 'the base is not fully darkened');
  assert.equal(contactShade(hy, hy), 1, 'the top of a hedge is being darkened for no reason');
  assert.equal(contactShade(0, hy), 1, 'mid-height is inside the contact band - the band is too tall');
});

test('the bevelled prefabs fit the batch geometry reservations for a real world', () => {
  /* Task 6 sized the batch buffers for 24-vertex boxes; a bevelled box is 96.
   * `addGeometry` throws at boot if a reservation is short, so this is the
   * headless version of that throw: walk one seed's whole descriptor stream,
   * build the actual prefabs for every class a family can hold, and check
   * the fattest one against the family's per-prefab reservation and the
   * GEOMETRY count against its prefab count. Since Task 7 the count is not
   * the class count: `MazeBatches.add` registers BOTH LOD tiers per class
   * (near prefab and far box), so this walk registers what the batch would -
   * distinct geometry OBJECTS across lod 0 and lod 2, which the registry's
   * lod collapse keeps at two per class at most and one where the tiers
   * coincide. One seed suffices - the vocabulary of sizes saturates (see
   * maze-prefabs.test.mjs) - and the instance-capacity side is already
   * covered by maze-batches.test.mjs. */
  const kindFamily = {};
  for (const [name, fam] of Object.entries(BATCH_FAMILIES)) {
    for (const k of fam.kinds) kindFamily[k] = name;
  }
  const { cells } = generateTopology(2026);
  const classes = new Map(); // family -> Set of extent classes
  const note = (kind, hx, hy, hz) => {
    const family = kindFamily[kind];
    if (!family) return;
    let set = classes.get(family);
    if (!set) { set = new Set(); classes.set(family, set); }
    set.add(`${kind}:${extentClass(hx, hy, hz)}:${hx}:${hy}:${hz}`);
  };
  for (let level = 0; level < MAZE.LEVELS; level++) {
    for (let dz = 0; dz < MAZE.DISTRICTS; dz++) {
      for (let dx = 0; dx < MAZE.DISTRICTS; dx++) {
        const descs = districtColliders(cells, dx, dz, level);
        for (const d of descs) note(d.kind, d.hx, d.hy, d.hz);
        for (const f of footingTransforms(descs)) note('footing', f.hx, f.hy, f.hz);
      }
    }
  }
  for (const [family, set] of classes) {
    const budget = GEOMETRY_BUDGET[family];
    /* Distinct geometry OBJECTS per family across both tiers - identity, not
     * class name, because identity is what MazeBatches keys addGeometry on. */
    const seen = new Set();
    const geometries = new Set();
    let worstVerts = 0; let worstIndices = 0;
    for (const entry of set) {
      const [kind, cls, hx, hy, hz] = entry.split(':');
      if (seen.has(`${kind}:${cls}`)) continue;
      seen.add(`${kind}:${cls}`);
      for (const lod of [0, 2]) {
        const g = prefabFor({ kind, hx: Number(hx), hy: Number(hy), hz: Number(hz), lod });
        geometries.add(g);
        worstVerts = Math.max(worstVerts, g.attributes.position.count);
        worstIndices = Math.max(worstIndices, g.index.count);
      }
    }
    assert.ok(geometries.size <= budget.prefabs,
      `family '${family}' can register ${geometries.size} geometries across both LOD tiers, `
      + `reservation ${budget.prefabs}`);
    assert.ok(worstVerts <= budget.verts,
      `family '${family}' holds a ${worstVerts}-vertex prefab, reservation ${budget.verts} - addGeometry will throw at boot`);
    assert.ok(worstIndices <= budget.indices,
      `family '${family}' holds a ${worstIndices}-index prefab, reservation ${budget.indices} - addGeometry will throw at boot`);
  }
});
