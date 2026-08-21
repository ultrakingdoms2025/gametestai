/**
 * THE CITADEL'S EXTENT GATE.  Design 5.4 C1, design 6 R8.
 *
 * Sunspire went from 400x400 m to 900x900 m by changing one number - `HALF`, in
 * `terrain/CitadelHeight.js`. That only works if every consumer derives from it,
 * and the failure mode when one does not is the worst kind: nothing throws.
 *
 * `medieval-extent.test.mjs` is the model and it catalogues the shapes: a
 * terrain job left at the old size draws a quarter of the ground and the rest
 * is sky; a backdrop authored in absolute metres falls inside the playfield; a
 * skirt with a fixed aspect ratio punches through the terrain. Both of the
 * TOTAL failures it records were hunted for here. What was found instead is a
 * third shape, and a fourth:
 *
 *   - THE SKY DOME. `SphereGeometry(900, 48, 32)`, fixed at the world origin,
 *     never moved. At `HALF = 200` the far corner was 283 m from it and nobody
 *     could tell; at 450 the corner is 636 m, so the dome is 264 m away in one
 *     direction and 1,536 m in the other and the horizon band tilts as you
 *     walk. Fixed by making it ride the camera, which is what Medieval's does.
 *
 *   - THE FOG. 90 / 520 against a 1,273 m diagonal saturates everything past
 *     520 m, which is the outer 60% of the map by area, into one flat colour.
 *
 * And a fifth, which no regex would have caught and which is the reason this
 * file also asserts the CONTENT did not move:
 *
 *   - THE DUNE CLIP. `if (|px| > HALF - 10) continue` made the dune field's
 *     rejection rate a function of the extent, and the accepted branch draws
 *     four more values from the world's shared PRNG than the rejected one. So
 *     widening the map changed how many draws that loop consumed and every
 *     structure built after it moved: the souk's wall-grab rescues went 57 ->
 *     63, the jump graph lost a node, and eight roof-edge samples appeared.
 *     One clipping literal, and the town is not the town any more.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import { HALF, INNER_KEEP, MESA_R, SHOULDER } from '../../src/worlds/terrain/CitadelHeight.js';
import { CITADEL_LAYOUT } from '../../src/worlds/CitadelWorld.js';
import { MAX_DISTRICT_RADIUS } from '../../src/worlds/citadel/Districts.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const read = (p) => readFileSync(path.join(root, p), 'utf8');

/**
 * Source with comments and string/template literals removed.
 *
 * Comments are stripped FIRST and deliberately: they legitimately narrate where
 * a number came from - "it was 520 against a 1,273 m diagonal" is exactly the
 * history worth keeping - and a sweep that forbade them would push that history
 * out of the file. String literals go too, because a material key or a log line
 * containing a digit is not a coordinate.
 */
function codeOnly(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/[^\n]*/g, '')
    .replace(/'(?:\\.|[^'\\\n])*'/g, "''")
    .replace(/"(?:\\.|[^"\\\n])*"/g, '""')
    .replace(/`(?:\\.|[^`\\])*`/g, '``');
}

const WORLD = 'src/worlds/CitadelWorld.js';
const HEIGHT = 'src/worlds/terrain/CitadelHeight.js';
const DISTRICTS = 'src/worlds/citadel/Districts.js';
const DETAIL = 'src/worlds/citadel/TerrainDetail.js';

/* ================================================================== */
/* 1. The authored number, and the object that publishes it            */
/* ================================================================== */

test('HALF is 450, so the playfield is 900 x 900 m', () => {
  assert.equal(HALF, 450);
  assert.equal(CITADEL_LAYOUT.half, HALF);
  assert.equal(CITADEL_LAYOUT.size, HALF * 2);
  // 5.06x the area of the 400 m field this grew out of.
  assert.ok(Math.abs((CITADEL_LAYOUT.size ** 2) / 400 ** 2 - 5.0625) < 1e-9);
});

test('the protected core is the OLD playfield, imported and not copied', () => {
  /* `INNER_KEEP` is the line design 5.1 draws and the line the bit-identity
   * digest in `citadel-height.test.mjs` is taken against. `CitadelWorld` clips
   * its dune apron to it and publishes `contentBounds` from it, and both of
   * those have to be the SAME number as the height field's mask edge or the
   * protection is two numbers that agree today. */
  assert.equal(INNER_KEEP, 200);
  assert.equal(CITADEL_LAYOUT.coreHalf, INNER_KEEP);
  assert.ok(/import \{[^}]*INNER_KEEP[^}]*\} from '\.\/terrain\/CitadelHeight\.js';/.test(read(WORLD)),
    'CitadelWorld no longer imports INNER_KEEP from the height field - it has a copy');
  // The mesa and its whole shoulder are inside it, which is what makes the
  // protection meaningful rather than nominal.
  assert.ok(MESA_R + SHOULDER < INNER_KEEP,
    `the shoulder reaches r = ${MESA_R + SHOULDER}, past the protected core at ${INNER_KEEP}`);

  /* ── AND THE RING MASK'S OUTER EDGE FOLLOWS IT ─────────────────────────
   *
   * `RING_OUT` was the literal `262`, which is `INNER_KEEP + 62` pre-added, and
   * pre-adding defeats every guard at once. The literal sweep below hunts a
   * bare `200` in this file and cannot see one hidden inside a sum. The AABB
   * assertions in `citadel-height.test.mjs` say nothing about a mask edge. And
   * if `INNER_KEEP` ever moved, the authored quantity - the docstring's "62 m
   * of ramp" - would silently become a different length instead of following;
   * push `INNER_KEEP` past 262 and `smoothstep(edge0 > edge1)` inverts the mask
   * outright, so the protected square becomes the only ground with relief and
   * nothing throws.
   *
   * Asserted by source because that is what the claim is: the ramp is written
   * as a length added to the core, not as a number that happens to equal it. */
  const height = codeOnly(read(HEIGHT));
  assert.ok(/const RING_RAMP = \d+(\.\d+)?;/.test(height),
    'the ring mask no longer names its ramp length - RING_OUT is a bare literal again');
  assert.ok(/const RING_OUT = INNER_KEEP \+ RING_RAMP;/.test(height),
    'RING_OUT no longer follows INNER_KEEP - the mask edge and the protected core '
    + 'are two numbers that agree today');
});

/* ================================================================== */
/* 2. The build consumes the layout - the half that is worth anything  */
/* ================================================================== */

test('the terrain job, the fog, the sky and the rim are read from one place', () => {
  /* Publishing `CITADEL_LAYOUT` is worth exactly nothing if the build keeps a
   * second copy: every test below would keep passing on an object nothing
   * reads. Design 5.4 C1 asks for this assertion by name. */
  const raw = read(WORLD);
  const code = codeOnly(raw);
  assert.ok(/genPool\.run\('terrain', CITADEL_LAYOUT\.terrainJob\)/.test(raw),
    '_buildTerrain no longer submits CITADEL_LAYOUT.terrainJob');
  assert.ok(/for \(const w of CITADEL_LAYOUT\.walls\)/.test(code),
    'the rim containment is no longer built from CITADEL_LAYOUT.walls');
  assert.ok(/env\.fogNear = CITADEL_LAYOUT\.fogNear;/.test(code)
    && /env\.fogFar = CITADEL_LAYOUT\.fogFar;/.test(code),
    '_configureEnvironment spells the fog out again instead of reading the layout');
  assert.ok(/new THREE\.SphereGeometry\(CITADEL_LAYOUT\.skyRadius,/.test(code),
    '_buildSky no longer sizes the dome from CITADEL_LAYOUT.skyRadius');
  assert.ok(/const seg = CITADEL_LAYOUT\.terrainSeg;/.test(code),
    '_buildTerrain has its own segment count again');
  assert.ok(/const stepXZ = CITADEL_LAYOUT\.terrainStep;/.test(code),
    'the collision heightfield step no longer comes from the layout');
  assert.ok(/tileGrid\(\{ half: HALF, step: stepXZ, tile: CITADEL_LAYOUT\.terrainTile \}\)/.test(code),
    'the terrain tiling no longer reads the layout');
});

test('the terrain job keeps a 3.75 m grid rather than stretching the cells', () => {
  /* THE SPACING IS THE INVARIANT, not the segment count. The whole
   * "collision can never sit below the mesh" argument in `_buildTerrain` is an
   * argument about how finely the shoulder is sampled, and leaving `seg` at the
   * 96 this world shipped would have taken the cell from 4.167 m to 9.375 m and
   * the 46 m shoulder from 11.04 cells to 4.9 - the same mesh-above-collider
   * failure the file was rebuilt to end, reached by not touching a number. */
  const job = CITADEL_LAYOUT.terrainJob;
  assert.equal(job.field, 'citadel');
  assert.equal(job.size, CITADEL_LAYOUT.size);
  assert.equal(job.originX, -HALF);
  assert.equal(job.originZ, -HALF);
  assert.equal(job.seg, CITADEL_LAYOUT.terrainSeg);
  assert.equal(job.uv, 'unit');
  assert.equal(job.normals, true);

  assert.equal(CITADEL_LAYOUT.terrainStep, 3.75);
  assert.equal(CITADEL_LAYOUT.size / CITADEL_LAYOUT.terrainSeg, CITADEL_LAYOUT.terrainStep);
  const cells = SHOULDER / CITADEL_LAYOUT.terrainStep;
  assert.ok(cells >= 11,
    `the shoulder gets ${cells.toFixed(2)} collision cells; it had 11.04 at the old extent`);
  /* And the resolution `terrain/CitadelHeight.js`'s own header asks for: its
   * quarry benches are a 5 m feature and it records `seg >= 240` as the grade
   * that resolves them. */
  assert.ok(CITADEL_LAYOUT.terrainSeg >= 240,
    `seg ${CITADEL_LAYOUT.terrainSeg} aliases the ring's authored benches away`);
});

test('the terrain tile divides the playfield exactly, at both strides', () => {
  /* `tileGrid` THROWS rather than rounding, and it is right to: a tile grid
   * that does not tile is a seam, and a seam is a hole straight through to the
   * sky. This is the arithmetic it throws on, checked before it can. */
  const per = CITADEL_LAYOUT.size / CITADEL_LAYOUT.terrainTile;
  const quads = CITADEL_LAYOUT.terrainTile / CITADEL_LAYOUT.terrainStep;
  assert.ok(Number.isInteger(per), `${CITADEL_LAYOUT.terrainTile} m tiles do not divide 900 m`);
  assert.ok(Number.isInteger(quads) && quads % 2 === 0,
    `a tile is ${quads} quads - the lo stride cannot halve it`);
  /* Medieval's measured knee is 100 m and it is unavailable here: 100 / 3.75 is
   * 26.67 quads. Recorded so the next reader does not "fix" the tile size back
   * to the number the other world uses. */
  assert.ok(!Number.isInteger(100 / CITADEL_LAYOUT.terrainStep),
    'a 100 m tile now divides the step - reconsider the 150 m tile');
  /* A tile's own bounding sphere has to clear C3's ceiling without any help
   * from the district splitter, or the ground is 36 objects over budget. */
  const flat = Math.hypot(CITADEL_LAYOUT.terrainTile / 2, CITADEL_LAYOUT.terrainTile / 2);
  assert.ok(flat < MAX_DISTRICT_RADIUS,
    `a ${CITADEL_LAYOUT.terrainTile} m tile is ${flat.toFixed(1)} m across the diagonal, `
    + `over the ${MAX_DISTRICT_RADIUS} m district ceiling before any relief is added`);
});

/* ================================================================== */
/* 3. Fog, sky and the rim                                             */
/* ================================================================== */

test('the fog cascade reaches the far rim and holds the near field where it was', () => {
  const { fogNear, fogFar, size } = CITADEL_LAYOUT;
  const haze = (d) => Math.min(1, Math.max(0, (d - fogNear) / (fogFar - fogNear)));

  /* floor    the playfield corner must not be saturated; something has to be
   *          visible from the far side of the map
   * achieved  69.6% at the 636 m corner
   * ceiling   3.3% - the gate approach, the near reference this was solved to
   *           hold fixed */
  const corner = HALF * Math.SQRT2;
  assert.ok(haze(corner) < 0.85,
    `the playfield corner sits at ${(100 * haze(corner)).toFixed(1)}% haze`);
  /* The ablation, and the reason this test exists: the shipped 520 m far edge
   * put that same corner - and the whole outer 60% of the map by area - at
   * 100%. A world you cannot see across is not a world you can navigate. */
  const old = (d) => Math.min(1, Math.max(0, (d - 90) / (520 - 90)));
  assert.equal(old(corner), 1, 'the old ramp did not actually saturate the corner');

  /* The near field is unchanged, which is the point of solving `fogNear` rather
   * than picking it: the gate approach stands 104 m from the great tower and
   * took a 3.256% veil at 90 / 520. */
  const anchor = 104;
  assert.ok(Math.abs(haze(anchor) - old(anchor)) < 0.002,
    `the gate approach moved from ${(100 * old(anchor)).toFixed(2)}% to `
    + `${(100 * haze(anchor)).toFixed(2)}% haze`);
  // ..and the far edge is set by the playfield, not by the backdrop.
  assert.ok(fogFar >= size - 40 && fogFar <= size,
    `fogFar ${fogFar} is not set by the ${size} m playfield`);
  console.log(`    fog ${fogNear} .. ${fogFar}: gate 104 m ${(100 * haze(104)).toFixed(1)}%, `
    + `wall 118 m ${(100 * haze(118)).toFixed(1)}%, corner ${corner.toFixed(0)} m `
    + `${(100 * haze(corner)).toFixed(1)}%, rim ${size} m ${(100 * haze(size)).toFixed(0)}%`);
});

test('the sky dome clears the far plane and rides the camera', () => {
  /* Two separate claims, and the second is the one that was broken. A dome big
   * enough for the origin is not big enough for the corner unless it moves, and
   * this one never moved. */
  assert.ok(CITADEL_LAYOUT.skyRadius >= HALF * Math.SQRT2,
    `a ${CITADEL_LAYOUT.skyRadius} m dome does not contain the ${(HALF * Math.SQRT2).toFixed(0)} m corner`);
  const code = codeOnly(read(WORLD));
  assert.ok(/this\._skyDome\.position\.copy\(cam\.position\)/.test(code),
    'the sky dome no longer rides the camera - it is a fixed sphere again');
});

test('the LOD reach is the corner of the square, not the half-edge', () => {
  /* The same mistake as the sky dome, one aisle over, and it shipped.
   *
   * `bandCanFire(sphere, threshold, measure, reach)` decides whether a distance
   * band can ever fire "from anywhere a camera can stand", by `reach + |c|`.
   * `reach` is the radius of the camera LOCUS - and this locus is a 900 m
   * square, not a 900 m disc, so its furthest point from the origin is
   * `HALF * sqrt(2)` = 636.4 m. Both call sites in `CitadelWorld` passed `HALF`
   * and understated every reach by 186.4 m, which refused two terrain tiles a
   * `lo` band that a camera in the corner does in fact cross:
   *
   *   citadel:terrain:2,5   swapNear 795.1 m   726 m at HALF   912 m at 636.4
   *   citadel:terrain:4,5   swapNear 833.2 m   781 m at HALF   967 m at 636.4
   *
   * Asserted by source rather than by rebuilding the world, for the same reason
   * the sky-dome test above is: this is a claim about which constant is written
   * at the call site, and a behavioural probe would pass just as happily on a
   * hard-coded 636.4 that stops following `HALF`. */
  const code = codeOnly(read(WORLD));
  assert.ok(/const CAMERA_REACH = HALF \* Math\.SQRT2;/.test(code),
    'CAMERA_REACH is no longer the corner of the playfield square');
  const passes = code.match(/bandCanFire\([^)]*\)|reach: [A-Z_]+/g) ?? [];
  assert.ok(passes.length >= 2, `only ${passes.length} reach call sites found - the sweep has gone blind`);
  for (const p of passes) {
    assert.ok(/CAMERA_REACH/.test(p), `a band still measures its reach with the half-edge: "${p}"`);
  }
});

test('the rim is segmented, because the broadphase buckets a box by its sphere', () => {
  /* `Physics._gridRange` uses `collider.boundingRadius` for a box, so a
   * Medieval-style full-length containment slab (2 x 40 x 450) has a 451.8 m
   * radius and claims 75 x 76 cells - four of those smear ~22,500 cells, which
   * is design 5.4 C4's failure in a different shape. This is the arithmetic
   * that decides the segment count, asserted rather than trusted. */
  const walls = CITADEL_LAYOUT.walls;
  assert.ok(walls.length >= 4 && walls.length % 4 === 0,
    `${walls.length} rim boxes is not four whole sides`);
  const CELL = 12;                       // Physics.cellSize
  let worstCells = 0;
  for (const [cx, cy, cz, hx, hy, hz] of walls) {
    const r = Math.hypot(hx, hy, hz);
    const span = Math.ceil((2 * r) / CELL) + 1;
    worstCells = Math.max(worstCells, span * span);
    // Inner face on the playfield edge, exactly, so nothing can stand outside it.
    const inner = Math.max(Math.abs(cx) - hx, Math.abs(cz) - hz);
    assert.ok(Math.abs(inner - HALF) < 1e-9,
      `a rim box's inner face is at ${inner}, not ${HALF}`);
    void cy;
  }
  /* floor    no rim box may touch more than 100 broadphase cells
   * achieved  64 (a 42.7 m radius box)
   * ceiling   5,776 - one full-length slab, which is what four of them would
   *           have cost, and 28,900 for the desert floor this replaced */
  assert.ok(worstCells <= 100,
    `a rim box claims ${worstCells} broadphase cells; floor 100`);
  const slab = Math.hypot(1, 40, HALF);
  const slabCells = (Math.ceil((2 * slab) / CELL) + 1) ** 2;
  console.log(`    ${walls.length} rim boxes, worst ${worstCells} cells each; `
    + `one full-length slab would be ${slabCells}`);
  assert.ok(slabCells > worstCells * 20, 'the segmentation is not buying anything');

  const code = codeOnly(read(WORLD));
  assert.ok(!/addBox\(0, -6, 0, HALF \* 1\.6/.test(code),
    'the desert floor collider is back - it is 28,900 broadphase cells on its own');
});

/* ================================================================== */
/* 4. The literal sweep                                                */
/* ================================================================== */

test('NO 400m-field literal survives anywhere in the citadel source', () => {
  /* Every one of these was a hard-coded extent in the 400 m build: the old
   * half-width and the size, the dune clip's inset, the desert floor's
   * half-extent, the old fog edge, and the fixed sky radius. Any of them
   * reappearing is a number that will not follow `HALF` the next time this
   * world is resized, and every one of them fails silently.
   *
   * `200` carries ONE allowance, and it is named: `export const INNER_KEEP =
   * 200` in the height field, which is the protected core and is deliberately
   * the old extent. It is stripped by its exact declaration rather than by
   * exempting the file, so a second bare 200 anywhere in that file is still
   * caught - and the allowance is asserted to have been used, so deleting the
   * declaration cannot silently disarm this.
   */
  /* `190` is swept out of `CitadelWorld` and the new modules but NOT out of the
   * height field, where it is the z coordinate of the Ashfall plateau's site and
   * has nothing to do with an extent. Narrowing the sweep per file rather than
   * dropping the literal keeps it armed where it can actually fire: `HALF - 10`
   * only ever appeared in the world's dune clip. */
  /* `450` - THE CURRENT EXTENT - is swept too, and it has to be.
   *
   * A sweep that hunts only the PREVIOUS extent's literals is armed for the
   * resize that already happened. `CitadelHeight.DUNES` shipped this drop with
   * `x1: 450, z1: 450` - the playfield rim, written as a number - and this
   * sweep could not see it, because 450 was not on any list. It fails in one
   * direction only, which is the direction that is silent: grow `HALF` and the
   * AABB assertions still pass while the dunes stop short of the new rim.
   *
   * The allowance is `export const HALF = 450;` itself, stripped by its exact
   * declaration exactly as `INNER_KEEP` is, and asserted to have been used. */
  const FORBIDDEN = {
    [WORLD]: ['400', '320', '520', '200', '190', '450'],
    [HEIGHT]: ['400', '320', '520', '200', '450'],
    [DISTRICTS]: ['400', '320', '520', '200', '190', '450'],
    [DETAIL]: ['400', '320', '520', '200', '190', '450'],
  };
  const files = [WORLD, HEIGHT, DISTRICTS, DETAIL];
  const offenders = [];
  let allowanceUsed = false;
  let halfAllowanceUsed = false;
  for (const f of files) {
    const forbidden = FORBIDDEN[f];
    let code = codeOnly(read(f));
    const before = code;
    code = code.replace(/export const INNER_KEEP = 200;/, 'export const INNER_KEEP = KEEP;');
    if (code !== before) allowanceUsed = true;
    const beforeHalf = code;
    code = code.replace(/export const HALF = 450;/, 'export const HALF = SIZE;');
    if (code !== beforeHalf) halfAllowanceUsed = true;
    for (const lit of forbidden) {
      const re = new RegExp(`(?<![\\w.])${lit}(?![\\w.])`, 'g');
      let m;
      while ((m = re.exec(code))) {
        const line = code.slice(0, m.index).split('\n').length;
        offenders.push(`${f}:${line} -> ${lit} in "`
          + `${code.slice(Math.max(0, m.index - 60), m.index + 20).replace(/\s+/g, ' ').trim()}"`);
      }
    }
  }
  assert.ok(allowanceUsed,
    'the INNER_KEEP allowance was never used - either the declaration moved or this sweep is armed wrong');
  assert.ok(halfAllowanceUsed,
    'the HALF allowance was never used - either the declaration moved or this sweep is armed wrong');
  assert.deepEqual(offenders, [], `hard-coded extents:\n${offenders.join('\n')}`);
});

test('the deck probe is not secretly the playfield', () => {
  /* `_deckAt` used to default to `from = 400, dist = 900`, and 900 is also the
   * width of the map - a coincidence that reads as a derivation and would
   * survive the next resize as a bug. Named constants now, and they have to
   * clear the world they are probing rather than merely be large. */
  const code = codeOnly(read(WORLD));
  const top = Number(/const DECK_PROBE_TOP = ([0-9.]+);/.exec(code)?.[1]);
  const len = Number(/const DECK_PROBE_LEN = ([0-9.]+);/.exec(code)?.[1]);
  assert.ok(Number.isFinite(top) && Number.isFinite(len),
    'the deck probe constants have gone - check what _deckAt defaults to now');
  assert.ok(/_deckAt\(x, z, from = DECK_PROBE_TOP, dist = DECK_PROBE_LEN\)/.test(code),
    '_deckAt no longer defaults to the named probe constants');
  assert.ok(top > CITADEL_LAYOUT.ceilY,
    `the probe starts at ${top} m, inside a world whose published ceiling is ${CITADEL_LAYOUT.ceilY} m`);
  assert.ok(top - len < CITADEL_LAYOUT.floorY,
    `the probe reaches ${top - len} m and the published floor is ${CITADEL_LAYOUT.floorY} m`);
});

/* ================================================================== */
/* 5. The content did NOT scale, and did not move either               */
/* ================================================================== */

test('the dune apron is clipped to the core, so the PRNG stream cannot move', () => {
  /* The fifth failure shape, and the one no literal sweep finds. The clip used
   * to be `HALF - 10`; the accepted branch of that loop draws four more values
   * from `this.rnd` than the rejected one, so the extent decided how many draws
   * the loop consumed and everything built afterwards shifted. It is also what
   * the clip MEANS: these dunes are the mesa's own apron, authored at
   * r = 188..280 to break up the plain the town stands on, and the ring beyond
   * the core is the height field's business. */
  const code = codeOnly(read(WORLD));
  assert.ok(/Math\.abs\(px\) > INNER_KEEP - 10 \|\| Math\.abs\(pz\) > INNER_KEEP - 10/.test(code),
    'the dune apron is clipped to something other than the protected core');
  assert.ok(!/HALF - 10/.test(code), 'a HALF-relative clip is back in the build');
});

test('the content radii did not follow HALF, because they must not', () => {
  /* The inverse assertion to the sweep above, and it is not redundant: the
   * failure the sweep catches is a number that SHOULD have scaled and did not,
   * and this is a number that should not have scaled and did. Design 5.1's
   * whole technique is that the mesa stays bit-identical inside a protected
   * box, so a curtain wall that grew with the map would be the expansion
   * eating the thing it was supposed to preserve. */
  const code = codeOnly(read(WORLD));
  const wallR = Number(/const WALL_R = ([0-9.]+);/.exec(code)?.[1]);
  const soukR0 = Number(/const SOUK_R0 = ([0-9.]+);/.exec(code)?.[1]);
  assert.equal(wallR, 118, 'the curtain wall radius moved');
  assert.equal(soukR0, 34, 'the inner souk ring moved');
  for (const r of [wallR, soukR0, MESA_R, MESA_R + SHOULDER]) {
    assert.ok(r < INNER_KEEP,
      `a content radius of ${r} now reaches outside the protected core at ${INNER_KEEP}`);
  }
});
