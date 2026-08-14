/**
 * Slicing the vale's ground into tiles, and the numbers that decide how.
 *
 * WHY THIS EXISTS
 *
 * The terrain was one mesh. At 400 m that was defensible; at 900 m it is
 * 203,401 vertices and 405,000 triangles behind a SINGLE bounding sphere with
 * a 636 m radius, which means it intersects the frustum from every position
 * and every angle a player can adopt. It was drawn in full, always. Standing
 * in the market square looking at the castle, the renderer was transforming
 * the far side of Blackmarch Bluff.
 *
 * `lod/DistanceLod.js` makes exactly this argument in its own docstring - "a
 * merged field never leaves the frustum and never gets far enough away to
 * hide" - and the grass and the trees were split spatially for precisely this
 * reason. The ground was the last thing that was not.
 *
 * WHAT WAS MEASURED
 *
 * Tile size and swap distance are both measured, over fourteen camera poses:
 * the seven `dev/Harness.js` medieval views plus seven authored on the new
 * ring (each landform site, Reedwater, and the far corner looking back across
 * the whole map, which is the worst case there is). Triangles drawn per view,
 * averaged:
 *
 *   tile   tiles   drawn calls   triangles (swap at 170 m)   worst view
 *    60 m   225        136.4         83,829                 225 calls
 *    90 m   100         63.7         95,320                 100 calls
 *   100 m    81         52.1        108,214                  81 calls
 *   150 m    36         24.8        118,527             168,750 tris
 *
 * against 405,000 triangles and 1 call, always, before. 100 m is the knee:
 * 73% of the triangles gone for 52 draw calls in the average framing, and the
 * curve below it buys ~12% more triangles for 2.6x the calls. It also divides
 * 900 m exactly and keeps the tile an integer number of 2 m quads (50), which
 * the LOD stride below then needs to halve exactly.
 *
 * WHAT THIS DELIBERATELY DOES NOT TOUCH
 *
 * Collision. `MedievalWorld._buildTerrain` still hands `physics.addHeightfield`
 * the one 451x451 sample grid it always did - see the collision comment there,
 * and `Physics.js:418` on why heightfields stay out of the broadphase. Tiling
 * is a RENDERING decomposition of a surface that is still described by one
 * array of numbers, and the tiles are sliced out of that array rather than
 * resampled, so the drawn surface and the walked surface cannot drift.
 *
 * Nothing in this file may import `three` or touch the DOM: it is the geometry
 * arithmetic, and it is tested under `node --test` with no renderer.
 */

/**
 * Tile edge length, metres. See the measurement table above.
 *
 * Must divide the playfield exactly and must be an even multiple of the 2 m
 * terrain step, or the lo stride below cannot halve the tile's quad count
 * without leaving a fractional row. `tileGrid` throws rather than rounding:
 * a tile grid that does not tile is a seam, and a seam is a hole.
 */
export const TILE_METRES = 100;

/**
 * How many source samples the lo geometry skips - 2, i.e. 4 m cells and a
 * quarter of the triangles.
 *
 * Not 4. An 8 m lo cell deviates from the real surface by up to 3.12 m
 * (measured over the whole map) against 1.55 m at 4 m, and the deviation
 * lands where the authored features are - the incised river channel, the moat
 * lip, the Grimscar scarp - which is to say on exactly the silhouettes a
 * player is looking at. One extra level would also need a second `lo` slot,
 * which `DistanceLod` does not have.
 */
export const TILE_LO_STRIDE = 2;

/**
 * Distance past which a tile draws its lo geometry, metres, measured to the
 * NEAREST point of the tile's bounding sphere (`DistanceLod`'s `SURFACE`).
 *
 * Measured, from a pixel budget rather than from taste. The deviation between
 * the 4 m lo edge and the 2 m surface has this distribution over the map:
 *
 *   p50 1.1 cm   p90 3.7 cm   p99 39.3 cm   p99.9 89.8 cm   max 1.55 m
 *
 * At 1080p and a 75-degree vertical field of view there are 825 pixels per
 * radian, so a deviation `s` at distance `D` is `825 s / D` pixels. Holding
 * the p99 deviation to two pixels gives D = 162 m; 170 m is that rounded up.
 * Nearest-point rather than centre distance is what makes the claim provable -
 * "the nearest triangle in this tile is 170 m away" bounds every triangle in
 * it, where a centre measure would be 71 m out on a 100 m tile.
 *
 * The long tail is the reason this is not braver. 99% of the ground would be
 * indistinguishable at 30 m; the 1% that would not is the channel lip and the
 * scarp edge, and those are linear features that read as silhouettes.
 */
export const TILE_SWAP_DISTANCE = 170;

/**
 * How far each tile's edge skirt hangs below the surface, metres.
 *
 * THE CRACK. A tile drawing 4 m cells against a neighbour drawing 2 m cells
 * agrees with it only at the shared samples; between them the coarse edge is a
 * straight chord and the fine edge is not, so the two surfaces separate and
 * the gap between them is a hole straight through to the sky. Measured over
 * every seam sample on the map, the largest separation is 1.55 m at the 4 m
 * stride (3.12 m if an 8 m stride is ever added).
 *
 * A skirt - a vertical apron hanging from the tile border, drawn in the same
 * material - fills that gap with ground-coloured pixels. 3.4 m is 2.2x the
 * measured worst case at the stride actually used, and still covers an 8 m
 * stride if a later phase adds one. It costs 4 x 51 vertices per tile.
 *
 * The alternative - stitching the coarse edge to the fine one with transition
 * triangles - removes the gap instead of hiding it, and needs a tile to know
 * its four neighbours' current LOD and rebuild its index buffer when any of
 * them changes. That is a per-frame index upload to save a skirt that is
 * hidden under the terrain from every camera position above the ground.
 *
 * Deep enough to matter at the playfield rim: the outermost tiles' skirts hang
 * inside the distant skirt sheet, which sits 2.5 cm under the terrain and
 * therefore in front of them from anywhere a player can stand.
 */
export const TILE_SKIRT_DROP = 3.4;

/**
 * The tile layout for a square playfield.
 *
 * @param {{ half: number, step: number, tile?: number }} p
 * @returns {Array<{ix:number, iz:number, i0:number, j0:number, quads:number,
 *                  x0:number, z0:number, cx:number, cz:number}>}
 */
export function tileGrid({ half, step, tile = TILE_METRES }) {
  const size = half * 2;
  const per = size / tile;
  const quads = tile / step;
  if (!Number.isInteger(per)) {
    throw new Error(`[TerrainTiles] ${tile}m tiles do not divide a ${size}m playfield`);
  }
  if (!Number.isInteger(quads) || quads % TILE_LO_STRIDE !== 0) {
    throw new Error(`[TerrainTiles] ${tile}m tiles are not a whole even number of ${step}m quads`);
  }
  const out = [];
  for (let iz = 0; iz < per; iz++) {
    for (let ix = 0; ix < per; ix++) {
      out.push({
        ix, iz, quads,
        i0: ix * quads,
        j0: iz * quads,
        x0: -half + ix * tile,
        z0: -half + iz * tile,
        cx: -half + (ix + 0.5) * tile,
        cz: -half + (iz + 0.5) * tile,
      });
    }
  }
  return out;
}

/**
 * Cut one tile's geometry out of the world-wide sample grid.
 *
 * SLICED, NOT RESAMPLED. Every vertex is a copy of a sample the terrain job
 * already produced, at exactly the coordinate it produced it for, so two
 * tiles sharing an edge share the same numbers and the hi surface is the
 * collision surface. Resampling `medievalHeight` per tile would have been
 * 81 x 2,601 extra evaluations AND a second opinion about where the ground is.
 *
 * UVs are copied too, not regenerated: they run 0..1 across the WHOLE
 * playfield because that is what the macro albedo is painted in. A tile that
 * generated its own 0..1 UVs would draw the entire vale's macro map inside
 * each 100 m square.
 *
 * @param {{positions: Float32Array, uvs: Float32Array, normals: Float32Array, nx: number}} src
 * @param {{i0:number, j0:number, quads:number}} tile
 * @param {number} stride 1 for the full-detail geometry, `TILE_LO_STRIDE` for lo
 * @param {number} skirtDrop metres; 0 builds no skirt
 */
export function buildTile(src, tile, stride = 1, skirtDrop = TILE_SKIRT_DROP) {
  const { positions, uvs, normals, nx } = src;
  const { i0, j0, quads } = tile;
  const q = quads / stride;
  const n = q + 1;
  const skirt = skirtDrop > 0 ? 4 * n : 0;
  const verts = n * n + skirt;
  /* Uint16 indices. The largest index a tile can produce is 51^2 + 4 x 51 - 1
   * = 2,804, comfortably inside 65,535 - so the tiling halves the index memory
   * the single mesh needed (which had 203,401 vertices and no choice but
   * Uint32). Asserted below rather than assumed. */
  if (verts > 65536) throw new Error(`[TerrainTiles] tile needs ${verts} vertices, past Uint16`);

  const position = new Float32Array(verts * 3);
  const uv = new Float32Array(verts * 2);
  const normal = new Float32Array(verts * 3);
  let minY = Infinity;
  let maxY = -Infinity;

  for (let jj = 0; jj < n; jj++) {
    const j = j0 + jj * stride;
    for (let ii = 0; ii < n; ii++) {
      const g = j * nx + (i0 + ii * stride);
      const k = jj * n + ii;
      const y = positions[g * 3 + 1];
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
      position[k * 3] = positions[g * 3];
      position[k * 3 + 1] = y;
      position[k * 3 + 2] = positions[g * 3 + 2];
      uv[k * 2] = uvs[g * 2];
      uv[k * 2 + 1] = uvs[g * 2 + 1];
      normal[k * 3] = normals[g * 3];
      normal[k * 3 + 1] = normals[g * 3 + 1];
      normal[k * 3 + 2] = normals[g * 3 + 2];
    }
  }

  const index = new Uint16Array(q * q * 6 + (skirt ? 4 * q * 6 : 0));
  let t = 0;
  /* The 00->11 diagonal, the same split `TerrainJob` uses and the same one
   * `Collider.sampleHeight` interpolates across. At stride 1 that makes the
   * drawn triangles the collision triangles rather than two approximations of
   * one field. */
  for (let jj = 0; jj < q; jj++) {
    for (let ii = 0; ii < q; ii++) {
      const a = jj * n + ii;
      const b = a + n;
      index[t++] = a; index[t++] = b; index[t++] = b + 1;
      index[t++] = a; index[t++] = b + 1; index[t++] = a + 1;
    }
  }

  if (skirt) {
    /* Four edges, each duplicating its border row and dropping it. The corners
     * are duplicated between adjacent edges - four extra vertices, against the
     * bookkeeping of walking a single ring and getting its corner order right.
     *
     * Winding is per-edge and faces OUTWARD, away from the tile centre. A
     * skirt wound inward is back-face culled by the terrain's `FrontSide`
     * material, which is the failure mode where the crack is still there and
     * the fix looks like it was applied. `terrain-tiles.test.mjs` recomputes
     * every skirt triangle's normal and asserts it points away.
     */
    const edges = [
      { base: n * n, top: (k) => k, flip: true },                    // -Z (row 0)
      { base: n * n + n, top: (k) => (n - 1) * n + k, flip: false }, // +Z (last row)
      { base: n * n + 2 * n, top: (k) => k * n, flip: false },       // -X (column 0)
      { base: n * n + 3 * n, top: (k) => k * n + (n - 1), flip: true }, // +X
    ];
    for (const e of edges) {
      for (let k = 0; k < n; k++) {
        const s = e.base + k;
        const g = e.top(k);
        position[s * 3] = position[g * 3];
        position[s * 3 + 1] = position[g * 3 + 1] - skirtDrop;
        position[s * 3 + 2] = position[g * 3 + 2];
        uv[s * 2] = uv[g * 2];
        uv[s * 2 + 1] = uv[g * 2 + 1];
        // The apron inherits the ground's normal rather than a sideways one.
        // It is meant to read as more of the same ground seen through a gap,
        // not as a wall someone built around every tile.
        normal[s * 3] = normal[g * 3];
        normal[s * 3 + 1] = normal[g * 3 + 1];
        normal[s * 3 + 2] = normal[g * 3 + 2];
      }
      for (let k = 0; k < q; k++) {
        const ta = e.top(k);
        const tb = e.top(k + 1);
        const sa = e.base + k;
        const sb = e.base + k + 1;
        if (e.flip) {
          index[t++] = ta; index[t++] = sb; index[t++] = sa;
          index[t++] = ta; index[t++] = tb; index[t++] = sb;
        } else {
          index[t++] = ta; index[t++] = sa; index[t++] = sb;
          index[t++] = ta; index[t++] = sb; index[t++] = tb;
        }
      }
    }
    minY -= skirtDrop;
  }

  return { position, uv, normal, index, verts, skirt, minY, maxY, tris: index.length / 3 };
}
