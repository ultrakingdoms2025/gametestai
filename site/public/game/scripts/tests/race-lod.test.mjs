import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { RaceWorld } from '../../src/worlds/RaceWorld.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

/**
 * Race's conifer LOD, and the two ways it can silently stop being invisible.
 *
 * The swap happens under a moving camera with nothing to cover it, so the two
 * tessellations have to agree about everything except triangle count. Two
 * properties carry that, and both are the kind that survive a review and then
 * get broken a month later by an innocuous edit to the tree:
 *
 *  1. Same volume, same axis. If the cheap crown is shorter, taller or offset
 *     the swap reads as the tree twitching, which is far louder than either
 *     tessellation is on its own.
 *  2. Same silhouette width. A lower-tessellation ring inscribed in the same
 *     circle is narrower, so the far treeline thins as it demotes unless the
 *     radii are corrected - and over-correcting fattens it just as visibly.
 *     `CONIFER_LO_INFLATE` is that correction and it is a measured number, so
 *     it needs a test that fails if the thing it was measured against moves.
 *
 * `_conifer` reads nothing off `this`, so it can be called against the
 * prototype without standing a world up - which is the only reason any of this
 * is testable outside a browser.
 */

const conifer = (lod) => RaceWorld.prototype._conifer.call(null, lod);
const tris = (g) => (g.index ? g.index.count : g.attributes.position.count) / 3;

/** Axis-aligned extent of a geometry, from its own vertices. */
function extent(geo) {
  const p = geo.attributes.position;
  const lo = [Infinity, Infinity, Infinity];
  const hi = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < p.count; i++) {
    const v = [p.getX(i), p.getY(i), p.getZ(i)];
    for (let k = 0; k < 3; k++) {
      if (v[k] < lo[k]) lo[k] = v[k];
      if (v[k] > hi[k]) hi[k] = v[k];
    }
  }
  return { lo, hi };
}

/** Mean vertex position: where the shape sits, independent of its facet count. */
function centroid(geo) {
  const p = geo.attributes.position;
  let x = 0;
  let y = 0;
  let z = 0;
  for (let i = 0; i < p.count; i++) {
    x += p.getX(i);
    y += p.getY(i);
    z += p.getZ(i);
  }
  return [x / p.count, y / p.count, z / p.count];
}

/**
 * Silhouette half-width seen from yaw `t`: the largest horizontal offset any
 * vertex has perpendicular to the view direction. This is what a treeline is
 * made of at a quarter of a kilometre - not the facet count.
 */
function silhouette(geo, t) {
  const p = geo.attributes.position;
  const nx = -Math.sin(t);
  const nz = Math.cos(t);
  let m = 0;
  for (let i = 0; i < p.count; i++) {
    const d = Math.abs(p.getX(i) * nx + p.getZ(i) * nz);
    if (d > m) m = d;
  }
  return m;
}

test('the cheap conifer is worth swapping to at all', () => {
  const hi = conifer('hi');
  const lo = conifer('lo');
  // 432 -> 120 and 104 -> 28 as built. The gate is deliberately loose: what
  // must not happen is the lo geometry quietly drifting back up toward the hi
  // one until the band stops paying for the second buffer it costs.
  assert.ok(tris(lo.canopy) <= tris(hi.canopy) * 0.45,
    `lo crown is ${tris(lo.canopy)} triangles against ${tris(hi.canopy)} - not worth a second geometry`);
  assert.ok(tris(lo.trunk) <= tris(hi.trunk) * 0.45,
    `lo trunk is ${tris(lo.trunk)} triangles against ${tris(hi.trunk)}`);
});

test('both tessellations stand at the same height on the same axis', () => {
  for (const part of ['trunk', 'canopy']) {
    const a = extent(conifer('hi')[part]);
    const b = extent(conifer('lo')[part]);
    /* Vertical extent to the millimetre. The station heights are the same
     * numbers in both lods and only the count of rings between them changes,
     * so this is exact for the crown; the trunk's end rings are perpendicular
     * to a tangent taken by central difference over a different spacing, which
     * tilts them by a fraction of a millimetre. A tree that changes height as
     * it demotes reads as the tree twitching, and the tolerance is well below
     * anything that could. */
    assert.ok(Math.abs(b.lo[1] - a.lo[1]) < 0.002, `${part}: base moved ${(b.lo[1] - a.lo[1]).toFixed(4)}m`);
    assert.ok(Math.abs(b.hi[1] - a.hi[1]) < 0.002, `${part}: apex moved ${(b.hi[1] - a.hi[1]).toFixed(4)}m`);
    /* And centred on the same axis, measured as the mean vertex position -
     * NOT off the bounding box. A 5-gon and a 9-gon put their vertices at
     * different angles, so their boxes are differently lopsided about the same
     * axis (0.2 m on a 3 m skirt) even though neither shape has moved. For the
     * same reason width is not asserted here at all; the silhouette an
     * observer actually sees is the next test's job. */
    const ca = centroid(conifer('hi')[part]);
    const cb = centroid(conifer('lo')[part]);
    for (const k of [0, 2]) {
      assert.ok(Math.abs(cb[k] - ca[k]) < 0.05, `${part}: axis ${k} centre moved ${(cb[k] - ca[k]).toFixed(3)}m`);
    }
  }
});

test('the cheap crown keeps the expensive one\'s silhouette at every yaw', () => {
  const hi = conifer('hi').canopy;
  const lo = conifer('lo').canopy;
  let worst = 0;
  let sum = 0;
  const N = 72;
  for (let i = 0; i < N; i++) {
    const t = (i / N) * Math.PI * 2;
    const rel = (silhouette(lo, t) - silhouette(hi, t)) / silhouette(hi, t);
    sum += rel;
    if (Math.abs(rel) > Math.abs(worst)) worst = rel;
  }
  const mean = sum / N;
  /* Measured at CONIFER_LO_INFLATE = 1.011: -3.0% to +2.6%, mean +0.0%.
   *
   * The mean is the one that matters and it is the one an uncorrected swap
   * gets wrong - at inflate 1.0 the mean is -1.1% and at the 1.07 that naive
   * even-N arithmetic suggests it is +5.9%, a treeline that visibly thickens
   * as it demotes. The per-yaw bound is looser because a 5-gon against a 9-gon
   * genuinely wobbles; it is there to catch a radial count dropped further. */
  assert.ok(Math.abs(mean) < 0.015,
    `cheap crown is ${(100 * mean).toFixed(2)}% wider on average - re-measure CONIFER_LO_INFLATE`);
  assert.ok(Math.abs(worst) < 0.05,
    `cheap crown silhouette swings ${(100 * worst).toFixed(2)}% at some yaw`);
});

test('every tiled scenery prototype that has a cheap geometry actually registers it', async () => {
  /* Textual, because `_instance` needs a built world, a physics world and a
   * material library to run at all. What is being guarded is a wiring mistake
   * that costs nothing at build time and everything at runtime: a lo geometry
   * that is constructed, owned and disposed but never handed to the LOD, so
   * the world pays for two buffers and draws the expensive one forever. */
  const src = await readFile(path.join(root, 'src/worlds/RaceWorld.js'), 'utf8');
  for (const name of ['race:tree.trunk', 'race:tree.crown']) {
    const at = src.indexOf(`'${name}'`);
    assert.ok(at > 0, `no _instance call for ${name}`);
    assert.ok(/swapBeyond:\s*CONIFER_LO_DISTANCE/.test(src.slice(at, at + 220)),
      `${name} is instanced without a distance band`);
  }
  const rock = src.indexOf('`race:rock${v}`');
  assert.ok(rock > 0, 'no _instance call for the rock outcrops');
  assert.ok(/swapBeyond:\s*ROCK_LO_DISTANCE/.test(src.slice(rock, rock + 220)),
    'the rock outcrops are instanced without a distance band');
});

test('the LOD is ticked every frame and released before its geometries are', async () => {
  const src = await readFile(path.join(root, 'src/worlds/RaceWorld.js'), 'utf8');
  // `lastIndexOf`, because `Batch` in the same file has its own `dispose()`
  // and it comes first - a first-match search silently tests the wrong class.
  const update = src.lastIndexOf('\n  update(dt) {');
  assert.ok(update > 0, 'RaceWorld.update is gone');
  assert.ok(/this\._lod\.update\(/.test(src.slice(update, update + 400)),
    'RaceWorld.update no longer drives the LOD - every band is dead');

  /* Order, not presence. `World.dispose` walks the group disposing whatever
   * geometry each mesh is WEARING, and a mesh parked on its lo geometry is
   * wearing a buffer that `_owned` will dispose again a moment later. Clearing
   * first puts every registration back on its hi geometry, so each buffer is
   * disposed once by exactly one owner. */
  const dispose = src.lastIndexOf('\n  dispose() {');
  assert.ok(dispose > 0, 'RaceWorld.dispose is gone');
  const body = src.slice(dispose, dispose + 900);
  const clear = body.indexOf('this._lod.clear()');
  const owned = body.indexOf('for (const g of this._owned)');
  assert.ok(clear > 0, 'dispose no longer clears the LOD');
  assert.ok(owned > 0, 'dispose no longer disposes _owned');
  assert.ok(clear < owned,
    'the LOD is cleared AFTER the geometries are disposed - a swapped mesh double-disposes its buffer');
});
