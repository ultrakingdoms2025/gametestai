/**
 * THE GROUND'S LOD BUDGET.
 *
 * `citadel/TerrainDetail.js` exists because a constant that was solved for one
 * world was about to be copied into another. `medieval/TerrainTiles.js` swaps a
 * half-resolution tile in past 170 m, and that number is a real derivation - it
 * holds the vale's p99 deviation of 39.3 cm to two pixels. Copied to the
 * Citadel it would have been wrong by a factor of four in the direction nobody
 * notices from a screenshot: the same swap on this field is worth 637 m, so
 * every tile in the world would have drawn its lo geometry from everywhere, and
 * the ring's quarry benches and karst faces would have flattened by up to
 * 4.42 m with no distance at which they came back.
 *
 * So the numbers in that file's header are reproduced here, and the exactness
 * claim it makes about its own sampling is checked against a dense oversample
 * rather than argued.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { citadelHeight, HALF } from '../../src/worlds/terrain/CitadelHeight.js';
import {
  loDeviation, swapDistance, PIXELS_PER_RADIAN, PIXEL_BUDGET,
} from '../../src/worlds/citadel/TerrainDetail.js';
import { tileGrid, TILE_LO_STRIDE } from '../../src/worlds/medieval/TerrainTiles.js';
import { CITADEL_LAYOUT } from '../../src/worlds/CitadelWorld.js';

/* ------------------------------------------------------------------ */
/* The field, sampled exactly as the generation worker samples it       */
/* ------------------------------------------------------------------ */

const STEP = CITADEL_LAYOUT.terrainStep;
const SEG = CITADEL_LAYOUT.terrainSeg;
const N = SEG + 1;

/** The whole-map sample grid, in the shape `buildTile` and `loDeviation` read. */
const SRC = (() => {
  const positions = new Float32Array(N * N * 3);
  for (let j = 0; j < N; j++) {
    const z = -HALF + j * STEP;
    for (let i = 0; i < N; i++) {
      const k = (j * N + i) * 3;
      const x = -HALF + i * STEP;
      positions[k] = x;
      positions[k + 1] = citadelHeight(x, z);
      positions[k + 2] = z;
    }
  }
  return { positions, nx: N };
})();

const TILES = tileGrid({ half: HALF, step: STEP, tile: CITADEL_LAYOUT.terrainTile });

/** Height of the grid surface of pitch `p`, inside one cell at (u, v) in [0,1). */
function planar(i0, j0, p, u, v) {
  const y = (i, j) => SRC.positions[(j * N + i) * 3 + 1];
  const h00 = y(i0, j0);
  const hS0 = y(i0 + p, j0);
  const h0S = y(i0, j0 + p);
  const hSS = y(i0 + p, j0 + p);
  /* The 00->11 diagonal, which is what `TerrainJob` emits and what
   * `Collider.sampleHeight` interpolates across. */
  return u < v
    ? h00 + (h0S - h00) * v + (hSS - h0S) * u
    : h00 + (hS0 - h00) * u + (hSS - hS0) * v;
}

/** Quote a floor / achieved / ceiling line the way the rest of this suite does. */
function floorCheck(what, floor, achieved, ceiling, note = '') {
  console.log(`  ${what.padEnd(52)} floor ${String(floor).padStart(8)} | achieved `
    + `${String(achieved).padStart(8)} | ceiling ${String(ceiling).padStart(8)} ${note}`);
}

/* ================================================================== */
/* 1. The sampling is exact, not approximate                           */
/* ================================================================== */

test('FLOOR: the five-point deviation IS the overlay maximum, on every tile', () => {
  /* `loDeviation` samples the skipped fine samples and nothing else, and the
   * file claims that for stride 2 those points are the complete vertex set of
   * the overlay of the two triangulations - so the maximum of a piecewise
   * linear difference has nowhere else to be.
   *
   * A bound in the wrong direction is exactly how an LOD ships a popping
   * silhouette: understate the deviation and every swap distance below comes
   * out too short. So this oversamples 16x16 inside every coarse cell of every
   * tile - 36 tiles x 400 cells x 289 points = 4.16M evaluations - and asserts
   * the cheap figure is not merely close to the dense one but equal to it. */
  const OS = 16;
  let worstRatio = Infinity;
  let worstName = '';
  let exceeded = 0;
  for (const t of TILES) {
    const five = loDeviation(SRC, t, TILE_LO_STRIDE);
    let dense = 0;
    for (let j = t.j0; j + 2 <= t.j0 + t.quads; j += 2) {
      for (let i = t.i0; i + 2 <= t.i0 + t.quads; i += 2) {
        for (let b = 0; b <= OS; b++) {
          for (let a = 0; a <= OS; a++) {
            const u = a / OS;
            const v = b / OS;
            const lo = planar(i, j, 2, u, v);
            const fi = u < 0.5 ? 0 : 1;
            const fj = v < 0.5 ? 0 : 1;
            const hi = planar(i + fi, j + fj, 1, u * 2 - fi, v * 2 - fj);
            const d = Math.abs(hi - lo);
            if (d > dense) dense = d;
          }
        }
      }
    }
    if (dense > five + 1e-6) exceeded++;
    const ratio = dense > 0 ? five / dense : 1;
    if (ratio < worstRatio) { worstRatio = ratio; worstName = `${t.ix},${t.iz}`; }
  }
  /* floor    no tile where the dense oversample beats the five-point figure
   * achieved  0 of 36
   * ceiling   0 - there is nothing better than none */
  assert.equal(exceeded, 0,
    `${exceeded} tiles deviate more than loDeviation reports - the bound is the wrong way round`);
  floorCheck('tiles where a 16x oversample beat the cheap figure', 0, exceeded, 0);
  floorCheck('worst five-point / dense ratio (x1000)', 1000, Math.round(worstRatio * 1000), 1000,
    `(tile ${worstName})`);
});

test('the pixel arithmetic is the one medieval/TerrainTiles.js already uses', () => {
  /* 825, not 704. `lines / fov` and `lines / (2 tan(fov/2))` are both defensible
   * readings of "pixels per radian" and they differ by 17%, which is 17% on
   * every swap distance in two files. They have to be the same reading or the
   * two derivations are not comparable, and the small-angle one is the
   * conservative choice. */
  assert.ok(Math.abs(PIXELS_PER_RADIAN - 825.06) < 0.01,
    `pixels per radian is ${PIXELS_PER_RADIAN.toFixed(2)}, not the 825 the medieval derivation uses`);
  assert.equal(PIXEL_BUDGET, 2);
  // The medieval derivation, reproduced: 39.3 cm to two pixels is 162 m.
  assert.equal(Math.round(swapDistance(0.393)), 162);
  // ..and 1.55 m, its measured maximum, would have been 639 m even there.
  assert.equal(Math.round(swapDistance(1.55)), 639);
});

test('the deviation is a DIFFERENCE, zero on anything the coarse lattice holds', () => {
  /* What this actually protects: that `loDeviation` subtracts the reconstructed
   * coarse surface rather than reporting a height, or a slope, or the wrong
   * term. Anything the half-resolution lattice can represent exactly has to
   * come out at zero, and anything it cannot has to come out at exactly the
   * amount it misses by.
   *
   * It does NOT detect a diagonal disagreement, and an earlier draft of this
   * test claimed it did. A plane is representable across either diagonal, so
   * flipping the split leaves both cases below at zero - checked by mutation,
   * which is why the claim is gone rather than merely softened. */
  const field = (fn) => {
    const positions = new Float32Array(N * N * 3);
    for (let j = 0; j < N; j++) {
      for (let i = 0; i < N; i++) positions[(j * N + i) * 3 + 1] = fn(i, j);
    }
    return { positions, nx: N };
  };
  const t = TILES[0];
  assert.equal(loDeviation(field(() => 7), t, 2), 0, 'a flat sheet has a non-zero lo deviation');
  /* 1e-4, not 0. The grid is `Float32Array` and the ramp reaches ~200 m, where
   * a float's spacing is 1.5e-5 - so an exactly planar surface reconstructs to
   * about 2e-6 and asserting on zero would be asserting on the storage format.
   * 1e-4 m is four orders below the metre-scale deviations that matter and two
   * above the noise. */
  const ramp = loDeviation(field((i, j) => i * 0.4 - j * 0.9), t, 2);
  assert.ok(ramp < 1e-4, `a planar ramp deviates ${ramp} m`);

  /* And the other direction, with an answer known in closed form: one spike on
   * a SKIPPED sample, on ground that is otherwise flat. The coarse lattice does
   * not see that sample at all, so it reconstructs 0 there and the deviation is
   * the spike's whole height. A test that only ever asserts zero passes just as
   * happily on a function that returns zero. */
  const spikeAt = (i0, j0) => field((i, j) => (i === i0 && j === j0 ? 5 : 0));
  assert.equal(loDeviation(spikeAt(t.i0 + 1, t.j0 + 1), t, 2), 5, 'a centre spike is not reported');
  assert.equal(loDeviation(spikeAt(t.i0 + 1, t.j0), t, 2), 5, 'an edge-midpoint spike is not reported');
  /* A spike ON the coarse lattice deviates by exactly HALF its height, and
   * working out why is the clearest statement of what this measures. Both
   * surfaces carry the spike at its own vertex; they disagree at the neighbours,
   * because the fine surface has already come back to zero one sample away
   * while the coarse one is still halfway down a ramp twice as long. Predicted
   * in closed form and asserted as an equality, not a bound - "the answer is
   * about right" is how a sign error survives. */
  assert.equal(loDeviation(spikeAt(t.i0 + 2, t.j0 + 2), t, 2), 2.5,
    'a spike on a KEPT sample no longer deviates by half its height at its neighbours');
});

/* ================================================================== */
/* 2. The field's own numbers, and why the constant does not transfer  */
/* ================================================================== */

test('FLOOR: a single global swap distance is dead on this field', () => {
  /* This is the finding the module exists for, asserted rather than narrated.
   * The reach of a camera in this world is `HALF` from the origin (the value
   * `registerDistricts` and `bandCanFire` default to), so a swap band further
   * away than that plus the tile's own offset can never change state. */
  const all = [];
  for (const t of TILES) {
    for (let j = t.j0; j + 2 <= t.j0 + t.quads; j += 2) {
      for (let i = t.i0; i + 2 <= t.i0 + t.quads; i += 2) {
        const y = (a, b) => SRC.positions[(b * N + a) * 3 + 1];
        const h00 = y(i, j);
        const h20 = y(i + 2, j);
        const h02 = y(i, j + 2);
        const h22 = y(i + 2, j + 2);
        all.push(Math.abs(y(i + 1, j) - (h00 + h20) * 0.5));
        all.push(Math.abs(y(i, j + 1) - (h00 + h02) * 0.5));
        all.push(Math.abs(y(i + 1, j + 2) - (h02 + h22) * 0.5));
        all.push(Math.abs(y(i + 2, j + 1) - (h20 + h22) * 0.5));
        all.push(Math.abs(y(i + 1, j + 1) - (h00 + h22) * 0.5));
      }
    }
  }
  all.sort((a, b) => a - b);
  const q = (p) => all[Math.min(all.length - 1, Math.floor(all.length * p))];
  console.log(`\n    deviation over ${all.length} sample points: p50 ${q(0.5).toFixed(4)} `
    + `p90 ${q(0.9).toFixed(4)} p99 ${q(0.99).toFixed(4)} max ${all[all.length - 1].toFixed(4)} m`);
  console.log(`    a p99-budget global swap would sit at ${swapDistance(q(0.99)).toFixed(0)} m`);

  /* floor    a global p99 swap must be further than a camera can ever be from
   *          the world origin - i.e. it must be provably dead
   * achieved  637 m against a 636 m corner
   * ceiling   170 m, the medieval constant, which is what a copy would have
   *           shipped */
  const corner = HALF * Math.SQRT2;
  const global = swapDistance(q(0.99));
  assert.ok(global > corner,
    `a global p99 swap at ${global.toFixed(0)} m is inside the ${corner.toFixed(0)} m corner - `
    + 'a single constant would work after all and this module is unnecessary');
  floorCheck('global p99 swap distance, metres', Math.round(corner), Math.round(global), 170,
    '(ceiling = the medieval constant a copy would have shipped)');

  /* And the medieval derivation reproduced on this field, to make the size of
   * the mistake explicit: at 170 m the deviation that is allowed is 0.41 m, and
   * this field exceeds that on most of its area. */
  const allowed = (170 * PIXEL_BUDGET) / PIXELS_PER_RADIAN;
  const overAt170 = all.filter((d) => d > allowed).length / all.length;
  const worst = all[all.length - 1];
  /* floor    the field's worst case must be at least 5x the error a 170 m swap
   *          is allowed to introduce
   * achieved  10.7x (4.423 m against a 0.412 m budget), on 3.7% of the field
   * ceiling   1.0x - a field the medieval constant fits, which is the vale */
  assert.ok(worst / allowed >= 5,
    `the worst deviation is only ${(worst / allowed).toFixed(1)}x a 170 m swap's budget`);
  console.log(`    at a 170 m swap the budget is ${allowed.toFixed(3)} m; this field's worst is `
    + `${worst.toFixed(3)} m (${(worst / allowed).toFixed(1)}x) and ${(100 * overAt170).toFixed(1)}% `
    + 'of sample points exceed it');
});

test('FLOOR: per-tile budgets keep most of the map swappable, and refuse the rest', () => {
  /* The trade the module makes, stated as two floors rather than one. Enough
   * tiles must earn a band for the mechanism to be worth having, and the ones
   * that cannot must be REFUSED rather than registered - a band no camera can
   * cross reads exactly like a working optimisation from a frame counter. */
  const reach = HALF;
  const rows = TILES.map((t) => {
    const dev = loDeviation(SRC, t, TILE_LO_STRIDE);
    const d = swapDistance(dev);
    /* The same test `bandCanFire` applies under SURFACE: the furthest a camera
     * can be from the nearest point of a sphere centred at `c` of radius `r` is
     * `reach + |c| - r`. The tile's sphere is centred on the tile. */
    const cx = t.cx;
    const cz = t.cz;
    const r = Math.hypot(CITADEL_LAYOUT.terrainTile * 0.5, CITADEL_LAYOUT.terrainTile * 0.5);
    const furthest = reach + Math.hypot(cx, cz) - r;
    return { t, dev, d, live: d < furthest };
  });
  const live = rows.filter((r) => r.live);
  const dead = rows.filter((r) => !r.live);
  console.log(`\n    ${live.length}/${rows.length} tiles earn a swap band; `
    + `live range ${Math.min(...live.map((r) => r.d)).toFixed(0)}-${Math.max(...live.map((r) => r.d)).toFixed(0)} m, `
    + `refused range ${Math.min(...dead.map((r) => r.d)).toFixed(0)}-${Math.max(...dead.map((r) => r.d)).toFixed(0)} m`);

  /* floor    at least half the tiles swap
   * achieved  23 of 36 (64%)
   * ceiling   36 - every tile, which is what a flat world would give and what
   *           this one gives with the ring relief ablated away */
  assert.ok(live.length >= rows.length / 2,
    `only ${live.length}/${rows.length} tiles earn a swap band; floor half`);
  floorCheck('terrain tiles with a live lo band', Math.ceil(rows.length / 2), live.length, rows.length);

  /* ── The classification is not marginal ─────────────────────────────────
   *
   * Live and refused are separated by a real gap in the deviations, not by a
   * hair either side of a threshold: the worst tile that earns a band deviates
   * 1.533 m and the best tile refused deviates 1.927 m. A world where those two
   * met would be one where a float's worth of terrain noise moved a tile from
   * one class to the other on the next reseed.
   *
   * floor    a >= 0.25 m gap between the worst live tile and the best dead one
   * achieved  0.394 m (1.533 -> 1.927)
   * ceiling   unbounded */
  const worstLive = Math.max(...live.map((r) => r.dev));
  const bestDead = Math.min(...dead.map((r) => r.dev));
  assert.ok(bestDead - worstLive >= 0.25,
    `live tops out at ${worstLive.toFixed(3)} m and refused starts at ${bestDead.toFixed(3)} m - `
    + 'the two classes are touching and a reseed would reshuffle them');
  floorCheck('gap between worst live and best refused, mm', 250,
    Math.round((bestDead - worstLive) * 1000), '-');

  /* And the town's own ground always swaps. Every tile wholly inside the
   * protected core is live, which is what makes the mechanism worth having at
   * all - the core is where the player spends the game, and it is the part of
   * the field with no authored geology in it. */
  const half = CITADEL_LAYOUT.terrainTile * 0.5;
  const core = rows.filter((r) => Math.abs(r.t.cx) + half <= CITADEL_LAYOUT.coreHalf
    && Math.abs(r.t.cz) + half <= CITADEL_LAYOUT.coreHalf);
  assert.ok(core.length >= 4, `only ${core.length} tiles lie wholly inside the protected core`);
  for (const r of core) {
    assert.ok(r.live,
      `core tile ${r.t.ix},${r.t.iz} was refused a swap band at ${r.dev.toFixed(3)} m`);
  }
  floorCheck('protected-core tiles with a live lo band', core.length,
    core.filter((r) => r.live).length, core.length);
});

test('nothing asks for a stride the exactness argument does not cover', () => {
  /* The five-point equality above is a statement about stride 2. It is only a
   * statement about what SHIPS while stride 2 is what ships, and `DistanceLod`
   * has exactly one `lo` slot, so there is no second level to want. */
  assert.equal(TILE_LO_STRIDE, 2);
  const code = readFileSync(new URL('../../src/worlds/CitadelWorld.js', import.meta.url), 'utf8');
  assert.ok(/loDeviation\(src, t, TILE_LO_STRIDE\)/.test(code),
    'CitadelWorld measures a different stride than it builds the lo tile at');
  assert.ok(/buildTile\(src, t, TILE_LO_STRIDE, TILE_SKIRT_DROP\)/.test(code),
    'CitadelWorld builds the lo tile at a different stride than it measured');
});
