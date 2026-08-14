/**
 * THE FOREST GATE.
 *
 * The bug this file exists for is the quietest kind there is: a constant that
 * used to be a function.
 *
 * `_buildNature` placed an ABSOLUTE 520 playfield trees and an absolute 264
 * ridge conifers over a mask thresholded at `> 0.02`. Both numbers were tuned
 * against a 400 m vale. The vale is now 900 m, so the same 520 trees cover
 * 5.06x the ground and what used to be woodland became 0.6 trees per hectare -
 * an orchard with the trees taken out. Nothing reported it. A sparse forest
 * renders perfectly; it just looks like a forest somebody authored sparse.
 *
 * So the tests here are about the SHAPE of the answer rather than its value:
 *
 *   - the count is derived from a density and the mask's own integral, so it
 *     follows the extent instead of needing to be remembered;
 *   - the stand field has an interior, a readable edge and clearings, which a
 *     threshold cannot produce;
 *   - the buckets are small enough that the canopy LOD can actually fire,
 *     which the map-quadrant buckets never could;
 *   - and the enclosure a wolf pack needs comes from the understorey, because
 *     buying it with crowns costs a thousand times more triangles.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import { HALF, fbm2, smoothstep } from '../../src/worlds/terrain/MedievalHeight.js';
import {
  WOOD_FREQ, woodMask, standAt, isWoodEdge, EDGE_LO, EDGE_HI,
  STAND_AREA, TREE_DENSITY, PLAYFIELD_TREES, UNDERSTOREY, BRACKEN,
  TREE_BUCKET_M, TREE_BUCKETS, STAND_SPECIES, standSpecies,
  NAMED_WOODS, woodAt, DEADFALL_PER_WOOD,
} from '../../src/worlds/medieval/Woodland.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const WORLD_SRC = readFileSync(path.join(root, 'src/worlds/MedievalWorld.js'), 'utf8');

/* ------------------------------------------------------------------ */
/* 1. The budget is derived, not authored                              */
/* ------------------------------------------------------------------ */

test('the tree count is a function of the mask and the extent', () => {
  // The relationship, not the number: this is what makes it survive a resize.
  assert.equal(PLAYFIELD_TREES, Math.round(STAND_AREA * TREE_DENSITY));
  assert.equal(UNDERSTOREY, Math.round(STAND_AREA * 0.0320));
  assert.equal(BRACKEN, Math.round(STAND_AREA * 0.0360));
  // And the integral really is an integral of the field the scatter uses.
  let sum = 0;
  let n = 0;
  for (let z = -HALF; z < HALF; z += 4) {
    for (let x = -HALF; x < HALF; x += 4) { sum += standAt(x, z); n++; }
  }
  const mine = (sum / n) * (HALF * 2) * (HALF * 2);
  assert.ok(Math.abs(mine - STAND_AREA) < 1, `STAND_AREA is ${STAND_AREA}, the field integrates to ${mine}`);
  /* The vale shipped with 520 trees over 810,000 m2. Whatever the density is
   * tuned to, the answer has to be a real forest's worth - and it has to be
   * bounded, because a crown is 2,880-4,560 triangles. */
  assert.ok(PLAYFIELD_TREES > 900, `${PLAYFIELD_TREES} trees is still not a forest`);
  assert.ok(PLAYFIELD_TREES < 1800, `${PLAYFIELD_TREES} trees will not fit in the triangle budget`);
});

test('_buildNature consumes the derived budget rather than a literal', () => {
  const code = WORLD_SRC.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
  assert.ok(/const total = PLAYFIELD_TREES;/.test(code),
    'the tree scatter no longer reads PLAYFIELD_TREES');
  assert.equal(/const total = \d+;/.test(code), false,
    'the tree scatter has an absolute count again');
  assert.ok(/UNDERSTOREY \+ BRACKEN/.test(code), 'the understorey budget is not being consumed');
  // The old threshold gate must be gone: it is the thing with no edge.
  assert.equal(/wood < 0\.02/.test(code), false, 'the binary woodland threshold is back');
  assert.ok(/rnd\(\) < stand/.test(code), 'the scatter no longer samples the stand field');
  // ...and the mask frequency has exactly one definition.
  assert.equal(new RegExp(`fbm2\\(x \\* ${WOOD_FREQ}`).test(code), false,
    'MedievalWorld spells the woodland mask out a second time');
});

/* ------------------------------------------------------------------ */
/* 2. The field has a shape                                            */
/* ------------------------------------------------------------------ */

test('the stand field has an interior, an edge and clearings', () => {
  let interior = 0;
  let fringe = 0;
  let open = 0;
  let n = 0;
  for (let z = -HALF; z < HALF; z += 3) {
    for (let x = -HALF; x < HALF; x += 3) {
      const s = standAt(x, z);
      assert.ok(s >= 0 && s <= 1, `stand ${s} at (${x}, ${z})`);
      if (s > 0.9) interior++;
      else if (s > 0.12) fringe++;
      else open++;
      n++;
    }
  }
  /* All three have to exist in quantity. A field that is 90% open is the old
   * sparse world; one with no fringe is a threshold; one with no interior is
   * scrub. The percentages are the shape of a landscape with real woods in
   * it, not a wooded landscape. */
  assert.ok(interior / n > 0.05, `only ${(interior / n * 100).toFixed(1)}% of the map is closed canopy`);
  assert.ok(interior / n < 0.22, `${(interior / n * 100).toFixed(1)}% closed canopy is a jungle`);
  assert.ok(fringe / n > 0.10, `only ${(fringe / n * 100).toFixed(1)}% of the map is woodland fringe`);
  assert.ok(open / n > 0.55, `only ${(open / n * 100).toFixed(1)}% of the map is open ground`);
});

test('walking into a wood crosses a real edge, not a step', () => {
  /* The property a threshold cannot have, stated as a bound on the field's own
   * derivative rather than as a transect measurement.
   *
   * A transect was the first attempt and it is the wrong instrument: the mask
   * is noise, so "the outermost metre where stand > 0.12" and "the outermost
   * metre where stand > 0.9" can be one metre apart on a single spike without
   * the field having a step in it anywhere. What actually distinguishes a ramp
   * from a threshold is that a ramp CANNOT change by much in a metre - and
   * that is a property of every point, not of a lucky ray.
   *
   * `> 0.02` moves 0 to 1 in whatever distance the mask takes to cross 0.02,
   * which at this frequency is centimetres. The ramped field spends 0.15 of
   * mask on the transition, which is 30-70 m of ground. */
  const fringe = (x, z) => smoothstep(EDGE_LO, EDGE_HI, woodMask(x, z));
  let worst = 0;
  let where = null;
  let ramped = 0;
  let n = 0;
  for (let z = -HALF; z < HALF; z += 7) {
    for (let x = -HALF; x < HALF; x += 7) {
      const a = fringe(x, z);
      for (const [dx, dz] of [[1, 0], [0, 1]]) {
        const d = Math.abs(fringe(x + dx, z + dz) - a);
        if (d > worst) { worst = d; where = [x, z]; }
        if (a > 0.05 && a < 0.95) { n++; if (d < 0.1) ramped++; }
      }
    }
  }
  /* The CANOPY edge, not the glade edge. The glade term is deliberately
   * sharper - a felled coup or a coppice block has a hard boundary and
   * should - so this bounds the term that models the outside of a wood.
   * A `> 0.02` threshold moves 0 to 1 in the distance the mask takes to
   * cross 0.02, which at this frequency is centimetres. */
  assert.ok(worst < 0.30,
    `the canopy edge jumps ${worst.toFixed(3)} in one metre at (${where}) - that is a step`);
  assert.ok(n > 4000, `only ${n} samples fell in the fringe at all`);
  assert.ok(ramped / n > 0.97,
    `${((1 - ramped / n) * 100).toFixed(1)}% of the fringe moves faster than a ramp`);

  // ...and the transition is WIDE: the mask's own edge span converted to
  // ground. 0.15 of mask at this frequency is tens of metres, measured.
  let widths = 0;
  let found = 0;
  for (const w of NAMED_WOODS) {
    for (let a = 0; a < 16; a++) {
      const th = (a / 16) * Math.PI * 2;
      let outer = null;
      let inner = null;
      for (let r = w.r + 70; r >= 0; r -= 1) {
        const m = woodMask(w.x + Math.cos(th) * r, w.z + Math.sin(th) * r);
        if (outer === null && m > EDGE_LO) outer = r;
        if (outer !== null && inner === null && m > EDGE_HI) inner = r;
      }
      if (outer === null || inner === null) continue;
      widths += outer - inner;
      found++;
    }
  }
  assert.ok(found >= 30, `only ${found} transects crossed a canopy edge`);
  assert.ok(widths / found > 12,
    `the average fringe is ${(widths / found).toFixed(1)} m wide - a wood with no approach`);
});

test('every named wood is on a real peak of the mask, and has an interior', () => {
  assert.ok(NAMED_WOODS.length >= 5);
  for (const w of NAMED_WOODS) {
    assert.ok(standAt(w.x, w.z) > 0.5, `${w.id}'s centre is at stand ${standAt(w.x, w.z).toFixed(2)}`);
    let sum = 0;
    let n = 0;
    let closed = 0;
    for (let dz = -w.r; dz <= w.r; dz += 5) {
      for (let dx = -w.r; dx <= w.r; dx += 5) {
        if (dx * dx + dz * dz > w.r * w.r) continue;
        const s = standAt(w.x + dx, w.z + dz);
        sum += s;
        if (s > 0.9) closed++;
        n++;
      }
    }
    assert.ok(sum / n > 0.28, `${w.id} averages stand ${(sum / n).toFixed(2)} - it is not a wood`);
    assert.ok(closed / n > 0.15, `${w.id} has only ${(closed / n * 100).toFixed(0)}% closed canopy`);
    assert.ok(['vale', 'far'].includes(w.bank));
    assert.equal(woodAt(w.x, w.z).id, w.id);
  }
  // Named woods must not sit on top of one another.
  for (let i = 0; i < NAMED_WOODS.length; i++) {
    for (let j = i + 1; j < NAMED_WOODS.length; j++) {
      const a = NAMED_WOODS[i];
      const b = NAMED_WOODS[j];
      assert.ok(Math.hypot(a.x - b.x, a.z - b.z) > (a.r + b.r) * 0.6,
        `${a.id} and ${b.id} are the same wood`);
    }
  }
  assert.equal(woodAt(0, 0), null, 'the market square is in a wood');
});

test('the mask itself is untouched - the woods are where they always were', () => {
  // Density and edges changed; the PLACES did not. A player who has walked the
  // old build must find the same woods.
  assert.equal(WOOD_FREQ, 0.0062);
  for (let i = 0; i < 500; i++) {
    const x = ((i * 97) % 900) - HALF;
    const z = ((i * 173) % 900) - HALF;
    assert.equal(woodMask(x, z), fbm2(x * 0.0062, z * 0.0062, 3));
  }
  assert.ok(EDGE_LO < EDGE_HI);
  assert.ok(EDGE_LO > 0.02, 'the canopy still starts at the old binary threshold');
});

test('isWoodEdge selects the belt between open ground and closed canopy', () => {
  for (let i = 0; i < 4000; i++) {
    const x = ((i * 211) % 900) - HALF;
    const z = ((i * 331) % 900) - HALF;
    const s = standAt(x, z);
    assert.equal(isWoodEdge(x, z), s > 0.12 && s < 0.72);
  }
});

/* ------------------------------------------------------------------ */
/* 3. The buckets can actually LOD                                     */
/* ------------------------------------------------------------------ */

test('tree buckets are small enough for the 90 m canopy swap to fire', () => {
  const swap = Number(/const CANOPY_LO_DISTANCE = (\d+)/.exec(WORLD_SRC)[1]);
  assert.equal(swap, 90);
  assert.equal(TREE_BUCKETS, Math.round((HALF * 2) / TREE_BUCKET_M));
  /* The argument, as arithmetic. A cell's bounding sphere is its half-diagonal
   * plus the tallest crown; the swap uses a NEAREST-POINT measure, so it fires
   * once the camera is `swap + radius` from the cell centre. That distance has
   * to be well inside the map or the band never fires anywhere - which is
   * exactly what the map-quadrant buckets did: a 450 m quadrant has a 318 m
   * sphere, and 408 m from a cell centre is off the edge of the world. */
  const CROWN = 8;
  /**
   * Average fraction of BUCKETS demoted, over camera positions across the
   * map. The honest form of the question: what matters is not whether one
   * bucket can ever demote, it is how much of the wood is drawing cheap
   * geometry from where a player actually stands.
   */
  const demotedFraction = (cell) => {
    const per = Math.round((HALF * 2) / cell);
    const radius = (cell * Math.SQRT2) / 2 + CROWN;
    const need = swap + radius;
    const centres = [];
    for (let bz = 0; bz < per; bz++) {
      for (let bx = 0; bx < per; bx++) {
        centres.push([-HALF + (bx + 0.5) * cell, -HALF + (bz + 0.5) * cell]);
      }
    }
    let sum = 0;
    let n = 0;
    for (let cz = -HALF + 25; cz < HALF; cz += 50) {
      for (let cx = -HALF + 25; cx < HALF; cx += 50) {
        let past = 0;
        for (const [x, z] of centres) if (Math.hypot(x - cx, z - cz) > need) past++;
        sum += past / centres.length;
        n++;
      }
    }
    return sum / n;
  };
  const mine = demotedFraction(TREE_BUCKET_M);
  const quadrant = demotedFraction(HALF);
  /* This is the whole argument for taking the extra draw calls. The 150 m
   * cell demotes most of the wood from a typical standpoint; the 450 m
   * quadrant it replaces demotes a fraction of it, which is what the
   * `CANOPY_LO_DISTANCE` docstring already said in words. */
  assert.ok(mine > 0.80,
    `a ${TREE_BUCKET_M} m bucket demotes only ${(mine * 100).toFixed(0)}% of the wood on average`);
  assert.ok(quadrant < 0.62,
    `a ${HALF} m quadrant already demoted ${(quadrant * 100).toFixed(0)}% - it did not need replacing`);
  /* Measured: 87% against 54%. Read the other way round, which is the way that
   * matters, the share of the wood still drawing 80-face crown lumps falls
   * from 46% to 13% - a 3.5x cut in hi-detail canopy, bought with 30-odd extra
   * instanced meshes. */
  assert.ok(1 - mine < (1 - quadrant) / 2.5,
    `hi-detail canopy only fell from ${((1 - quadrant) * 100).toFixed(0)}% to ${((1 - mine) * 100).toFixed(0)}%`);
  // ...and the draw-call bill it buys has to stay bounded.
  assert.equal(STAND_SPECIES, 2);
  assert.ok(TREE_BUCKETS * TREE_BUCKETS * STAND_SPECIES * 2 <= 160,
    `${TREE_BUCKETS}x${TREE_BUCKETS} buckets could cost ${TREE_BUCKETS * TREE_BUCKETS * STAND_SPECIES * 2} meshes`);
});

test('a stand is planted with two species, stably and never with willow', () => {
  const used = new Set();
  for (let bz = 0; bz < TREE_BUCKETS; bz++) {
    for (let bx = 0; bx < TREE_BUCKETS; bx++) {
      const cx = -HALF + (bx + 0.5) * TREE_BUCKET_M;
      const cz = -HALF + (bz + 0.5) * TREE_BUCKET_M;
      const m = woodMask(cx, cz);
      const pair = standSpecies(bx, bz, m);
      assert.equal(pair.length, STAND_SPECIES);
      assert.notEqual(pair[0], pair[1], `bucket ${bx},${bz} is planted with one species twice`);
      for (const s of pair) {
        assert.ok(s >= 0 && s <= 2,
          `bucket ${bx},${bz} plants archetype ${s} - willow is a bankside tree, not a stand species`);
        used.add(s);
      }
      // Stable: the same bucket must give the same answer every call, or the
      // world is not deterministic across reloads.
      assert.deepEqual(standSpecies(bx, bz, m), pair);
    }
  }
  assert.equal(used.size, 3, 'the stands do not use all three woodland species');
});

test('deadfall is bucketed per wood, so a wood is a district', () => {
  assert.ok(DEADFALL_PER_WOOD >= 15);
  const code = WORLD_SRC.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
  assert.ok(/for \(const wood of NAMED_WOODS\) \{\s*const WB = new GeoBatch\(\)/.test(code),
    'the deadfall is no longer merged per named wood - one batch would span the map');
});

/* ------------------------------------------------------------------ */
/* 4. Enclosure                                                        */
/* ------------------------------------------------------------------ */

test('the understorey outnumbers the trees, because that is what closes a wood', () => {
  /* The trade this whole design rests on. A crown is 2,880-4,560 triangles and
   * sits four to eleven metres up, where it blocks the sky; a thicket is
   * TWELVE and stands between a player's eye and a wolf's. If the understorey
   * were ever cut to "save triangles" the wood would open up for a saving of
   * about half a percent, so the relationship is pinned rather than assumed. */
  assert.ok(UNDERSTOREY > PLAYFIELD_TREES,
    `${UNDERSTOREY} thickets against ${PLAYFIELD_TREES} trees - the wood will be see-through`);
  assert.ok(BRACKEN > UNDERSTOREY, 'there is more shrub than there is ground cover');
  const CARD_TRIS = 6;
  const CROWN_TRIS = 2880;
  const understoreyCost = (UNDERSTOREY + BRACKEN) * CARD_TRIS;
  const treeCost = PLAYFIELD_TREES * CROWN_TRIS;
  assert.ok(understoreyCost < treeCost * 0.02,
    `the understorey costs ${understoreyCost} triangles against the canopy's ${treeCost}`);
});

test('a wolf in a wood has cover: the interior is not a lawn with trees on it', () => {
  /* Enclosure, measured. Walk 40 m rays through the middle of each named wood
   * and count how many are broken by something at eye height. The scatter is
   * random, so this checks the DENSITY that makes cover likely rather than any
   * particular tree - trunk spacing under closed canopy, plus the understorey
   * that occupies the same ground. */
  for (const w of NAMED_WOODS) {
    let closed = 0;
    let n = 0;
    for (let dz = -40; dz <= 40; dz += 4) {
      for (let dx = -40; dx <= 40; dx += 4) {
        if (dx * dx + dz * dz > 1600) continue;
        if (standAt(w.x + dx, w.z + dz) > 0.75) closed++;
        n++;
      }
    }
    const frac = closed / n;
    assert.ok(frac > 0.3,
      `${w.id}'s heart is only ${(frac * 100).toFixed(0)}% closed - a pack would be visible from the edge`);
    /* Expected occupancy along a 40 m sightline through that: trees at the
     * derived density plus thickets at theirs, each ~1.5 m wide. Under 1 and
     * the wood does not conceal anything. */
    const perM2 = (PLAYFIELD_TREES + UNDERSTOREY) / STAND_AREA;
    const expected = perM2 * frac * 40 * 1.5;
    assert.ok(expected > 1.0,
      `${w.id}: a 40 m sightline crosses only ${expected.toFixed(2)} stems`);
  }
});

test('the backdrop treelines scale with their own circumference', () => {
  const code = WORLD_SRC.replace(/\/\/[^\n]*/g, '');
  assert.ok(/const wanted = Math\.round\(\(104 - ri \* 16\) \* \(HALF \/ 300\)\)/.test(code),
    'the ridge stands are back to an absolute count and will thin as the map grows');
  /* And they draw no trunks. A fir trunk is 468 triangles - 27% of a ridge
   * tree once the canopy LOD has fired - these meshes are in frustum from
   * every vantage in the world, and the stands are set 1.5 m into the slope
   * precisely so the boles never show. */
  assert.equal(/new THREE\.InstancedMesh\(pine\.geo\.trunk/.test(code), false,
    'the backdrop rings are drawing trunks again - 222,000 triangles a frame that cannot be seen');
});
