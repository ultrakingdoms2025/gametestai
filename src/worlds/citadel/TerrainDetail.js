/**
 * How far away a half-resolution terrain tile may be swapped in, per tile.
 *
 * ── Why this is not a constant ───────────────────────────────────────────
 *
 * `medieval/TerrainTiles.js` publishes `TILE_SWAP_DISTANCE = 170`, solved from
 * a pixel budget: the stride-2 tile deviates from the stride-1 surface by
 * p99 39.3 cm over the vale, there are 825 pixels per radian at 1080 lines and
 * a 75-degree field of view, so holding that deviation to two pixels puts the
 * swap at 162 m and 170 is that rounded up.
 *
 * That derivation does not transfer to the Citadel, and the failure is not
 * subtle. Measured over the whole 900 m field at a 3.75 m step (72,000 sample
 * points, `citadel-terrain-detail.test.mjs` reproduces every number here):
 *
 *                       p50      p90      p99      max
 *   medieval, 2 m      1.1 cm   3.7 cm   39.3 cm  1.55 m
 *   citadel, 3.75 m    1.8 cm  13.5 cm   1.544 m  4.423 m
 *
 * Holding the citadel's p99 to two pixels puts the swap at **637 m**, on a map
 * whose longest sightline is 900 m and whose far corner is 636 m from the
 * origin. A single global constant is therefore either a dead band or a visible
 * one. Two reasons for the difference, both structural: the step is 1.875x
 * coarser, so halving it lands on 7.5 m cells; and the ring is authored
 * geology - quarry benches, karst faces, terrace risers - where the vale is
 * fbm hills, and a bench edge is exactly the feature that does not survive
 * dropping every other sample.
 *
 * ── What replaces it ─────────────────────────────────────────────────────
 *
 * Deviation is a property of a PATCH of ground, not of a world, and the tiles
 * already partition the world into patches. Each tile gets its own budget from
 * its own measured worst case, and `citadel/Districts.js:bandCanFire` refuses
 * the ones that cannot fire from anywhere a camera can stand rather than
 * registering a band that reads as a working optimisation and is not.
 *
 * Measured over the 36 tiles of the shipped field: 23 can swap on a MAX-
 * deviation budget (33 m to 224 m), and the 13 that cannot are the landform
 * tiles, where the worst case runs 3.1-4.4 m and the honest swap distance is
 * 1,287-1,825 m. Those 13 draw at full resolution always, which is the correct
 * answer rather than a missing one.
 *
 * `max`, not `p99`. A p99 budget is a promise that 1% of the surface may pop,
 * and on this field that 1% is the bench edges - the only part of the ring a
 * player is looking at. It costs 5 tiles (28 could swap on p99 against 23 on
 * max) and buys a guarantee.
 *
 * Nothing in this file may import `three`: it is arithmetic over the sample
 * grid the generation worker already produced, and it is tested with no
 * renderer.
 */

/**
 * Pixels per radian, the small-angle reading `medieval/TerrainTiles.js` uses.
 *
 * `lines / fov`, not `lines / (2 tan(fov/2))`. The tangent form gives 703.7 at
 * these settings against 825.1, i.e. a 17% larger swap distance for the same
 * deviation, so the two files must agree on which one they mean or their
 * numbers are not comparable. The small-angle form is the conservative one -
 * it over-states the pixel density, and so under-states how far away a
 * deviation becomes invisible.
 */
export const PIXELS_PER_RADIAN = 1080 / (75 * Math.PI / 180);

/** How many pixels of error the swap is allowed to introduce. */
export const PIXEL_BUDGET = 2;

/**
 * Worst-case vertical deviation between a stride-`n` tile and the full-
 * resolution surface, in metres.
 *
 * ── What is sampled, and what that bounds ────────────────────────────────
 *
 * The lo tile keeps every `stride`-th sample and triangulates across the same
 * 00->11 diagonal, so both surfaces are piecewise linear and they AGREE at
 * every kept sample by construction. The deviation is therefore zero on the
 * coarse lattice and non-zero in between, and the points where it is largest
 * are vertices of the overlay of the two triangulations - the skipped fine
 * samples, plus the crossings of fine edges with coarse edges.
 *
 * This samples the skipped fine samples: for `stride = 2` that is the four edge
 * midpoints and the centre of each coarse quad, five points where the coarse
 * surface is a known linear blend of the corners.
 *
 * For stride 2 that sample set is not an approximation of the maximum, it IS
 * the maximum, and the reason is that both triangulations split on the same
 * 00->11 diagonal: the fine diagonals either lie along a coarse diagonal or run
 * parallel to it, so a fine edge meets a coarse edge only at a fine sample. The
 * overlay of the two triangulations therefore has no vertices except the fine
 * samples, and a piecewise-linear difference attains its maximum at a vertex.
 * Checked rather than argued - `citadel-terrain-detail.test.mjs` oversamples the
 * overlay 16x16 inside every coarse cell of all 36 tiles and finds the
 * five-point figure exactly equal to it, to the last bit, on every one.
 *
 * At stride > 2 the interior lattice is walked as well, and there the claim
 * weakens to a bound: fine edges can cross coarse edges between samples. No
 * caller uses a stride above 2 - `TILE_LO_STRIDE` is 2 and `DistanceLod` has
 * one `lo` slot - and the test pins that too, so the exactness above is a
 * statement about what ships.
 *
 * @param {{positions: Float32Array, nx: number}} src the whole-map sample grid
 * @param {{i0:number, j0:number, quads:number}} tile from `tileGrid`
 * @param {number} [stride]
 * @returns {number} metres
 */
export function loDeviation(src, tile, stride = 2) {
  const { positions, nx } = src;
  const { i0, j0, quads } = tile;
  const y = (i, j) => positions[(j * nx + i) * 3 + 1];
  let worst = 0;
  const track = (v) => { const a = v < 0 ? -v : v; if (a > worst) worst = a; };
  for (let j = j0; j + stride <= j0 + quads; j += stride) {
    for (let i = i0; i + stride <= i0 + quads; i += stride) {
      const h00 = y(i, j);
      const hS0 = y(i + stride, j);
      const h0S = y(i, j + stride);
      const hSS = y(i + stride, j + stride);
      for (let b = 1; b < stride; b++) {
        const t = b / stride;
        track(y(i + b, j) - (h00 + (hS0 - h00) * t));
        track(y(i, j + b) - (h00 + (h0S - h00) * t));
        track(y(i + b, j + stride) - (h0S + (hSS - h0S) * t));
        track(y(i + stride, j + b) - (hS0 + (hSS - hS0) * t));
      }
      /* Interior. Both triangulations split on the 00->11 diagonal, so a point
       * on that diagonal at parameter t is `h00 + (hSS - h00) * t` on the
       * coarse surface; off it, the coarse triangle is the plane through three
       * of the four corners. Walking the whole interior lattice rather than
       * only the centre is what makes this hold for stride > 2. */
      for (let bj = 1; bj < stride; bj++) {
        for (let bi = 1; bi < stride; bi++) {
          const u = bi / stride;
          const v = bj / stride;
          // Lower triangle is (00, 0S, SS); upper is (00, SS, S0). The 00->11
          // diagonal in grid terms runs from (i,j) to (i+stride,j+stride).
          const coarse = u < v
            ? h00 + (h0S - h00) * v + (hSS - h0S) * u
            : h00 + (hS0 - h00) * u + (hSS - hS0) * v;
          track(y(i + bi, j + bj) - coarse);
        }
      }
    }
  }
  return worst;
}

/**
 * How far away a deviation of `metres` becomes smaller than the pixel budget.
 *
 * @param {number} metres
 * @param {{pixels?:number, budget?:number}} [opts]
 * @returns {number} metres; `0` for a tile that deviates not at all
 */
export function swapDistance(metres, opts = {}) {
  const px = opts.pixels ?? PIXELS_PER_RADIAN;
  const budget = opts.budget ?? PIXEL_BUDGET;
  return (px * metres) / budget;
}
