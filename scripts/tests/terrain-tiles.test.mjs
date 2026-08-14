/**
 * THE CRACK GATE.
 *
 * Splitting a terrain into tiles and giving the distant ones a coarser mesh is
 * the standard trade and it has exactly one standard failure: the seam. A tile
 * drawing 4 m cells against a neighbour drawing 2 m cells agrees with it only
 * at the samples they share; between them one draws a straight chord and the
 * other does not, and the daylight between the two surfaces is a hole through
 * the world. It appears only when a specific pair of tiles happens to be at
 * different LOD levels, which is to say when the player is standing in one
 * particular place, which is to say not in any screenshot anyone took.
 *
 * So the seam is tested exhaustively rather than sampled: every internal seam
 * on the map, in both axes, at all four combinations of the two LOD levels,
 * against the skirt that has to bridge it.
 *
 * The second failure this file exists for is quieter. The point of tiling is
 * that each tile gets its own bounding sphere and can leave the frustum on its
 * own; a tile whose sphere spans the map is a tile that never culls, and the
 * whole exercise silently buys nothing. That is what `DistanceLod`'s docstring
 * is about, and it is checked here as an explicit bound rather than assumed
 * from the fact that we cut the mesh up.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import { MEDIEVAL_LAYOUT } from '../../src/worlds/MedievalWorld.js';
import { sampleTerrain } from '../../src/workers/jobs/TerrainJob.js';
import { medievalHeight, HALF } from '../../src/worlds/terrain/MedievalHeight.js';
import {
  tileGrid, buildTile,
  TILE_METRES, TILE_LO_STRIDE, TILE_SWAP_DISTANCE, TILE_SKIRT_DROP,
} from '../../src/worlds/medieval/TerrainTiles.js';

/* One sample of the real playfield, shared by every test below - it is the
 * same job `_buildTerrain` submits, so these tests run on the ground that
 * ships rather than on a synthetic field. */
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const { buffers } = sampleTerrain(MEDIEVAL_LAYOUT.terrainJob);
const SRC = {
  positions: buffers.positions, uvs: buffers.uvs, normals: buffers.normals, nx: buffers.nx,
};
const TILES = tileGrid({ half: MEDIEVAL_LAYOUT.half, step: MEDIEVAL_LAYOUT.terrainStep });
const PER_SIDE = MEDIEVAL_LAYOUT.size / TILE_METRES;
const QUADS = TILE_METRES / MEDIEVAL_LAYOUT.terrainStep;

/** Height of a tile's surface along one edge, at a fractional position. */
function edgeHeight(geo, n, along, index) {
  // `index` selects which of the four borders; `along` is 0..1 across it.
  const t = along * (n - 1);
  const i = Math.min(n - 2, Math.floor(t));
  const f = t - i;
  const at = (k) => {
    const v = index === 0 ? k
      : index === 1 ? (n - 1) * n + k
        : index === 2 ? k * n
          : k * n + (n - 1);
    return geo.position[v * 3 + 1];
  };
  return at(i) * (1 - f) + at(i + 1) * f;
}

/* ------------------------------------------------------------------ */
/* The layout                                                          */
/* ------------------------------------------------------------------ */

test('the tiles tile: every square metre of the playfield, exactly once', () => {
  assert.equal(TILES.length, PER_SIDE * PER_SIDE);
  assert.equal(TILES.length, 81);
  const seen = new Set();
  for (const t of TILES) {
    assert.equal(seen.has(`${t.ix},${t.iz}`), false, 'duplicate tile');
    seen.add(`${t.ix},${t.iz}`);
    assert.equal(t.quads, QUADS);
    assert.equal(t.x0, -HALF + t.ix * TILE_METRES);
    assert.equal(t.z0, -HALF + t.iz * TILE_METRES);
    // The sample range must land inside the grid, and the last tile must
    // finish exactly on the far edge rather than one row short of it.
    assert.ok(t.i0 + t.quads <= buffers.nx - 1);
    assert.ok(t.j0 + t.quads <= buffers.nz - 1);
  }
  const last = TILES[TILES.length - 1];
  assert.equal(last.i0 + last.quads, buffers.nx - 1);
  assert.equal(last.j0 + last.quads, buffers.nz - 1);
});

test('a tile size that does not tile throws instead of rounding', () => {
  /* Silent rounding here is a strip of missing world down two edges of the
   * map, which nothing else in the build would notice. */
  assert.throws(() => tileGrid({ half: 450, step: 2, tile: 120 }), /do not divide/);
  assert.throws(() => tileGrid({ half: 450, step: 2, tile: 75 }), /whole even number/);
});

test('tile vertices are the terrain job\'s own samples, not a resample', () => {
  /* The collision heightfield is built from the same `heights` array these
   * positions come out of. If a tile ever resampled `medievalHeight` itself -
   * even correctly - the drawn surface and the walked surface would become two
   * opinions rather than one, and they would drift the first time either grew
   * a rounding difference. */
  for (const t of [TILES[0], TILES[40], TILES[80]]) {
    const g = buildTile(SRC, t, 1, 0);
    const n = t.quads + 1;
    for (const [ii, jj] of [[0, 0], [n - 1, 0], [0, n - 1], [n - 1, n - 1], [17, 33]]) {
      const k = jj * n + ii;
      const gx = (t.j0 + jj) * buffers.nx + (t.i0 + ii);
      assert.equal(g.position[k * 3], buffers.positions[gx * 3]);
      assert.equal(g.position[k * 3 + 1], buffers.positions[gx * 3 + 1]);
      assert.equal(g.position[k * 3 + 2], buffers.positions[gx * 3 + 2]);
      assert.equal(g.position[k * 3 + 1], Math.fround(medievalHeight(g.position[k * 3], g.position[k * 3 + 2])));
    }
  }
});

test('UVs stay global, so the macro map is not repeated once per tile', () => {
  /* The playfield's albedo is painted in 0..1 over the WHOLE vale. A tile that
   * generated its own 0..1 UVs would draw the entire village, castle and river
   * inside each 100 m square - 81 times over. */
  const a = buildTile(SRC, TILES[0], 1, 0);
  const b = buildTile(SRC, TILES[TILES.length - 1], 1, 0);
  assert.ok(a.uv[0] < 0.02 && a.uv[1] > 0.98, `first tile corner uv ${a.uv[0]}, ${a.uv[1]}`);
  const n = QUADS + 1;
  const far = (n * n - 1) * 2;
  assert.ok(b.uv[far] > 0.98 && b.uv[far + 1] < 0.02, `last tile corner uv ${b.uv[far]}, ${b.uv[far + 1]}`);
});

/* ------------------------------------------------------------------ */
/* Bounding spheres                                                    */
/* ------------------------------------------------------------------ */

test('each tile is genuinely local - its sphere is a fraction of the map\'s', () => {
  /* The number that makes tiling worth doing. One mesh had a single sphere
   * around a 900 m square: 636 m of radius plus the relief, which intersects
   * the frustum from every position and orientation a player can adopt, so the
   * ground was drawn in full, always. */
  const bound = (verts) => {
    let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity, z0 = Infinity, z1 = -Infinity;
    for (let i = 0; i < verts.length; i += 3) {
      if (verts[i] < x0) x0 = verts[i];
      if (verts[i] > x1) x1 = verts[i];
      if (verts[i + 1] < y0) y0 = verts[i + 1];
      if (verts[i + 1] > y1) y1 = verts[i + 1];
      if (verts[i + 2] < z0) z0 = verts[i + 2];
      if (verts[i + 2] > z1) z1 = verts[i + 2];
    }
    return 0.5 * Math.hypot(x1 - x0, y1 - y0, z1 - z0);
  };
  const whole = bound(buffers.positions);
  assert.ok(whole > 600, `the single-mesh radius was ${whole.toFixed(0)} m`);
  let worst = 0;
  for (const t of TILES) {
    const r = bound(buildTile(SRC, t, 1).position);
    if (r > worst) worst = r;
    assert.ok(r < TILE_METRES, `tile ${t.ix},${t.iz} has a ${r.toFixed(1)} m radius`);
  }
  assert.ok(whole / worst > 6,
    `the worst tile is only ${(whole / worst).toFixed(1)}x smaller than the whole mesh`);
});

test('the LOD swap distance is provable against the tile radius', () => {
  /* `DistanceLod`'s SURFACE measure subtracts the radius, so "beyond 170 m"
   * means the NEAREST triangle is 170 m away. That is the form the pixel
   * budget in `TerrainTiles` was computed in, and it only holds while the
   * radius is a bounded fraction of the distance - a tile with a 200 m radius
   * would be demoting ground that is 30 m from the lens. */
  const maxR = Math.hypot(TILE_METRES / 2, TILE_METRES / 2) + TILE_SKIRT_DROP;
  assert.ok(TILE_SWAP_DISTANCE > 2 * maxR,
    `a ${TILE_METRES} m tile's ${maxR.toFixed(0)} m radius is not small against a ${TILE_SWAP_DISTANCE} m band`);
});

/* ------------------------------------------------------------------ */
/* THE CRACK                                                           */
/* ------------------------------------------------------------------ */

test('two tiles at the SAME LOD have no seam at all', () => {
  for (const stride of [1, TILE_LO_STRIDE]) {
    for (const t of TILES) {
      if (t.ix + 1 >= PER_SIDE) continue;
      const a = buildTile(SRC, t, stride, 0);
      const b = buildTile(SRC, TILES.find((q) => q.ix === t.ix + 1 && q.iz === t.iz), stride, 0);
      const n = t.quads / stride + 1;
      for (let k = 0; k < n; k++) {
        // A's +X border against B's -X border, vertex for vertex.
        const ai = (k * n + (n - 1)) * 3;
        const bi = (k * n) * 3;
        assert.equal(a.position[ai], b.position[bi]);
        assert.equal(a.position[ai + 1], b.position[bi + 1]);
        assert.equal(a.position[ai + 2], b.position[bi + 2]);
      }
    }
  }
});

test('NO CRACK at any LOD boundary combination, anywhere on the map', () => {
  /* Every internal seam, both axes, all four LOD pairs, sampled at 1/8 of a
   * lo-cell so the worst point of every chord is hit. The assertion is the one
   * the skirt actually makes true: the two surfaces may disagree, but never by
   * more than the apron hanging off whichever of them is higher.
   *
   * Both directions matter and are checked by taking the absolute value: it is
   * the HIGHER surface's skirt that covers the gap, and which of the two is
   * higher changes along the seam.
   */
  const strides = [1, TILE_LO_STRIDE];
  const SAMPLES = QUADS * TILE_LO_STRIDE * 8;
  let worst = 0;
  let worstAt = null;
  let seams = 0;
  for (const t of TILES) {
    for (const axis of [0, 1]) {
      const nb = TILES.find((q) => (axis === 0
        ? q.ix === t.ix + 1 && q.iz === t.iz
        : q.ix === t.ix && q.iz === t.iz + 1));
      if (!nb) continue;
      seams++;
      for (const sa of strides) {
        for (const sb of strides) {
          const a = buildTile(SRC, t, sa);
          const b = buildTile(SRC, nb, sb);
          const na = t.quads / sa + 1;
          const nbn = nb.quads / sb + 1;
          // axis 0: A's +X border (3) against B's -X border (2).
          // axis 1: A's +Z border (1) against B's -Z border (0).
          const ia = axis === 0 ? 3 : 1;
          const ib = axis === 0 ? 2 : 0;
          for (let s = 0; s <= SAMPLES; s++) {
            const u = s / SAMPLES;
            const ha = edgeHeight(a, na, u, ia);
            const hb = edgeHeight(b, nbn, u, ib);
            const gap = Math.abs(ha - hb);
            if (gap > worst) { worst = gap; worstAt = [t.ix, t.iz, axis, sa, sb, u]; }
            assert.ok(gap < TILE_SKIRT_DROP,
              `a ${gap.toFixed(3)} m crack at tile ${t.ix},${t.iz} axis ${axis} `
              + `strides ${sa}/${sb} at u=${u.toFixed(3)}; the skirt only hangs ${TILE_SKIRT_DROP} m`);
            /* Where BOTH tiles have a real vertex - every multiple of the
             * coarser stride - the gap must be zero, not merely small. That is
             * the difference between two tiles cut from one grid and two tiles
             * that each sampled the height function and nearly agreed. */
            const coarse = t.quads / Math.max(sa, sb);
            if (Number.isInteger(u * coarse)) {
              assert.equal(gap, 0, `tiles disagree by ${gap} m at a SHARED sample, u=${u}`);
            }
          }
        }
      }
    }
  }
  assert.equal(seams, 2 * PER_SIDE * (PER_SIDE - 1), 'not every internal seam was walked');
  /* Recorded rather than merely passed: the margin is the whole reason the
   * skirt depth is what it is, and a future landform with a sharper edge would
   * eat into it long before it broke through. */
  assert.ok(worst < TILE_SKIRT_DROP * 0.75,
    `the worst crack is ${worst.toFixed(3)} m at ${worstAt} - under the ${TILE_SKIRT_DROP} m skirt, `
    + 'but with under 25% of margin left');
});

test('the skirt exists on both LOD levels and hangs the full depth', () => {
  for (const stride of [1, TILE_LO_STRIDE]) {
    const t = TILES[40];
    const g = buildTile(SRC, t, stride);
    const n = t.quads / stride + 1;
    assert.equal(g.skirt, 4 * n);
    assert.equal(g.verts, n * n + 4 * n);
    const tops = [
      (k) => k, (k) => (n - 1) * n + k, (k) => k * n, (k) => k * n + (n - 1),
    ];
    for (let e = 0; e < 4; e++) {
      for (let k = 0; k < n; k++) {
        const s = n * n + e * n + k;
        const top = tops[e](k);
        assert.equal(g.position[s * 3], g.position[top * 3]);
        assert.equal(g.position[s * 3 + 2], g.position[top * 3 + 2]);
        assert.ok(Math.abs((g.position[top * 3 + 1] - g.position[s * 3 + 1]) - TILE_SKIRT_DROP) < 1e-4);
      }
    }
  }
});

test('every skirt triangle faces OUTWARD, or the skirt is invisible', () => {
  /* The failure that looks exactly like success. The terrain material is
   * FrontSide; a skirt wound inward is back-face culled, so the crack is still
   * there, the geometry cost has been paid, and every visual check passes
   * except the one nobody runs. */
  let checked = 0;
  for (const stride of [1, TILE_LO_STRIDE]) {
    for (const t of TILES) {
      const g = buildTile(SRC, t, stride);
      const nTop = (t.quads / stride + 1) ** 2;
      for (let i = 0; i < g.index.length; i += 3) {
        const a = g.index[i];
        const b = g.index[i + 1];
        const c = g.index[i + 2];
        const P = (k) => [g.position[k * 3], g.position[k * 3 + 1], g.position[k * 3 + 2]];
        const [p0, p1, p2] = [P(a), P(b), P(c)];
        const e1 = [p1[0] - p0[0], p1[1] - p0[1], p1[2] - p0[2]];
        const e2 = [p2[0] - p0[0], p2[1] - p0[1], p2[2] - p0[2]];
        const nx = e1[1] * e2[2] - e1[2] * e2[1];
        const ny = e1[2] * e2[0] - e1[0] * e2[2];
        const nz = e1[0] * e2[1] - e1[1] * e2[0];
        if (a < nTop && b < nTop && c < nTop) {
          assert.ok(ny > 0, `a surface triangle in tile ${t.ix},${t.iz} faces down`);
          continue;
        }
        checked++;
        const mx = (p0[0] + p1[0] + p2[0]) / 3 - t.cx;
        const mz = (p0[2] + p1[2] + p2[2]) / 3 - t.cz;
        assert.ok(nx * mx + nz * mz > 0,
          `a skirt triangle in tile ${t.ix},${t.iz} faces into the tile`);
      }
    }
  }
  assert.ok(checked > 40000, `only ${checked} skirt triangles were checked`);
});

/* ------------------------------------------------------------------ */
/* Cost                                                                */
/* ------------------------------------------------------------------ */

test('tiling does not cost index memory, because tiles fit in Uint16', () => {
  const g = buildTile(SRC, TILES[0], 1);
  assert.equal(g.index.constructor, Uint16Array);
  let max = 0;
  for (let i = 0; i < g.index.length; i++) if (g.index[i] > max) max = g.index[i];
  assert.ok(max < 65536);
  assert.ok(max === g.verts - 1 || max < g.verts, 'a tile index points past its own vertices');

  /* The single mesh had 203,401 vertices and no choice but Uint32. Border rows
   * are duplicated between neighbours and every tile gains a skirt, so the
   * vertex count goes UP - the index halving is what pays for it. */
  let bytes = 0;
  let tris = 0;
  for (const t of TILES) {
    for (const stride of [1, TILE_LO_STRIDE]) {
      const q = buildTile(SRC, t, stride);
      bytes += q.position.byteLength + q.uv.byteLength + q.normal.byteLength + q.index.byteLength;
      if (stride === 1) tris += q.tris;
    }
  }
  const before = buffers.positions.byteLength + buffers.uvs.byteLength
    + buffers.normals.byteLength + buffers.indices.byteLength;
  assert.ok(bytes < before * 1.15,
    `tiles cost ${(bytes / 1048576).toFixed(2)} MB against ${(before / 1048576).toFixed(2)} MB `
    + 'for the single mesh - the lo level and the skirts were supposed to be roughly free');
  assert.ok(tris < 405000 * 1.15 && tris > 405000,
    `the hi tiles draw ${tris} triangles against the single mesh's 405,000`);
});

test('the world builds tiles, and registers each one for LOD', () => {
  /* This module is only worth anything if the build consumes it. A
   * `_buildTerrain` that quietly went back to one mesh would leave every test
   * above passing on geometry nothing renders. */
  const src = readFileSync(path.join(root, 'src/worlds/MedievalWorld.js'), 'utf8');
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*/g, '');
  assert.ok(/tileGrid\(\{ half: HALF, step: step, tile: TILE_METRES \}\)/.test(code),
    '_buildTerrain no longer lays out its tiles from tileGrid');
  assert.ok(/buildTile\(src, t, 1, TILE_SKIRT_DROP\)/.test(code)
    && /buildTile\(src, t, TILE_LO_STRIDE, TILE_SKIRT_DROP\)/.test(code),
    'the hi and lo tile geometries are no longer both built with skirts');
  assert.ok(/_lod\.add\(tile, \{ lo, swapBeyond: TILE_SWAP_DISTANCE, measure: SURFACE \}\)/.test(code),
    'terrain tiles are no longer registered for distance LOD');
  // And the collision heightfield is still ONE field over the whole playfield.
  assert.ok(/physics\.addHeightfield\(\{[\s\S]{0,260}nx: SEG \+ 1/.test(code),
    'the collision heightfield stopped being one field over the whole grid');
  assert.equal((code.match(/addHeightfield\(/g) || []).length, 1,
    'more than one heightfield - see the collision comment and Physics.js:418');
  assert.equal(TILE_METRES % MEDIEVAL_LAYOUT.terrainStep, 0);
  assert.equal(MEDIEVAL_LAYOUT.size % TILE_METRES, 0);
});
