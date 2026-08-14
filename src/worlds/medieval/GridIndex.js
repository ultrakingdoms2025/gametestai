/**
 * Uniform spatial grid over the XZ plane.
 *
 * Every scatter pass in `MedievalWorld` asks the same four questions per
 * candidate - how far is the nearest road, am I inside a building footprint,
 * am I on a paved yard, is this open ground - and every one of them used to
 * answer by walking the entire feature list. That is O(candidates x features),
 * and both halves grow with world area, so a 5x wider vale did ~25x the work.
 *
 * This is the same broadphase idea `Physics` already uses (see
 * `Physics._cellKey` and `_gridRange`), reduced to two dimensions and to the
 * two queries the world actually issues: "everything whose box is near this
 * box", and "nearest, exactly".
 *
 * Nothing in this file may import `three` or touch the DOM.
 *
 * ------------------------------------------------------------------------
 * WHY NOT A HASH MAP
 *
 * `Physics` buckets colliders in a `Map<number, Collider[]>` and that is the
 * right shape there, where the payoff is measured against ten thousand
 * colliders and a query touches a handful of cells. It is the wrong shape
 * here, and measurably so. The thing being avoided is `segmentDistance` -
 * six multiplies and a square root, about four nanoseconds. A `Map.get` on a
 * packed integer key is roughly ten times that. A Map-backed grid needed ~34
 * lookups to answer a typical grass-scatter probe and came out SLOWER than the
 * 248-segment linear scan it was supposed to replace: 689ms against 315ms over
 * 400,000 probes.
 *
 * So the cells are dense: one contiguous CSR block over the occupied bounding
 * box, built on first query and rebuilt when the contents change. A lookup is
 * an array index. The block covers the extent of what is actually in the
 * index, not the extent of the world, so a 900m vale whose roads occupy a
 * 150x230m patch allocates cells for the patch.
 *
 * ------------------------------------------------------------------------
 * WHY `nearest` IS EXACT
 *
 * `_roadDist` returns a distance, not a boolean, and five call sites compare
 * it against five different thresholds. An approximate answer would move props
 * for no reason and would make an equivalence test impossible to write, so the
 * search below is exact rather than "good enough":
 *
 *   - An item is registered in every cell its (already inflated) box touches.
 *   - After scanning every cell within Chebyshev ring `k` of the query point's
 *     own cell, anything still unseen lies in ring >= k+1, and every point of
 *     such a cell is at least `k * cellSize` from the query point.
 *   - So once the best distance found is <= `k * cellSize`, no unscanned item
 *     can beat it, and the search stops.
 *   - Within a ring, a cell whose own distance already exceeds the best found
 *     is skipped without its items being touched. That is what collapses the
 *     far case, because the ring bound is Chebyshev and only closes at
 *     `k * cellSize` - two hundred metres of slack at a 24m cell.
 *
 * The one obligation this places on the caller is that the box it inserts must
 * be a lower bound on its own metric: if the metric subtracts a road's
 * half-width, the inserted box must already be inflated by that half-width.
 * Inflating a box by `h` never reduces the distance to it by more than `h`, so
 * an inflated box is a valid lower bound for `distance - h`.
 */

export class GridIndex {
  /** @param {number} cellSize metres */
  constructor(cellSize = 8) {
    this.cell = cellSize;
    /** Item boxes, five numbers each (`id, minX, minZ, maxX, maxZ`). */
    this._boxes = [];
    this._count = 0;
    this._minX = Infinity;
    this._minZ = Infinity;
    this._maxX = -Infinity;
    this._maxZ = -Infinity;
    this._dirty = true;
    /* CSR cell contents: `_start[c]`..`_start[c+1]` index into `_items`. */
    this._nx = 0;
    this._nz = 0;
    this._cx0 = 0;
    this._cz0 = 0;
    this._start = null;
    this._items = null;
    /**
     * Reused query result buffer.
     *
     * One per index, so a footprint query and a paving query never share it.
     * A query must be fully consumed before the next one on the SAME index -
     * true of every caller here, because each is a single straight-line loop.
     * @type {number[]}
     */
    this._out = [];
  }

  get size() {
    return this._count;
  }

  /**
   * Register `id` under every cell its box touches.
   *
   * The box must already carry whatever inflation the caller's metric
   * subtracts - see the note at the top of this file. Items may be added after
   * a query has been run; the cells are rebuilt on the next one. `_footprints`
   * in particular is appended to all through the build, interleaved with
   * queries from the dressing passes, and a rebuild there is forty boxes.
   */
  insert(id, minX, minZ, maxX, maxZ) {
    this._boxes.push(id, minX, minZ, maxX, maxZ);
    if (minX < this._minX) this._minX = minX;
    if (minZ < this._minZ) this._minZ = minZ;
    if (maxX > this._maxX) this._maxX = maxX;
    if (maxZ > this._maxZ) this._maxZ = maxZ;
    this._count++;
    this._dirty = true;
  }

  /** Build the CSR cell block: count per cell, prefix-sum, then fill. */
  _build() {
    this._dirty = false;
    const c = this.cell;
    const boxes = this._boxes;
    this._cx0 = Math.floor(this._minX / c);
    this._cz0 = Math.floor(this._minZ / c);
    const nx = Math.floor(this._maxX / c) - this._cx0 + 1;
    const nz = Math.floor(this._maxZ / c) - this._cz0 + 1;
    this._nx = nx;
    this._nz = nz;
    const cells = nx * nz;
    const start = new Int32Array(cells + 1);
    for (let b = 0; b < boxes.length; b += 5) {
      const x0 = Math.floor(boxes[b + 1] / c) - this._cx0;
      const z0 = Math.floor(boxes[b + 2] / c) - this._cz0;
      const x1 = Math.floor(boxes[b + 3] / c) - this._cx0;
      const z1 = Math.floor(boxes[b + 4] / c) - this._cz0;
      for (let cz = z0; cz <= z1; cz++) {
        const row = cz * nx;
        for (let cx = x0; cx <= x1; cx++) start[row + cx + 1]++;
      }
    }
    for (let i = 0; i < cells; i++) start[i + 1] += start[i];
    const items = new Int32Array(start[cells]);
    // A separate cursor, so `start` survives the fill as the real offsets.
    const cursor = start.slice(0, cells);
    for (let b = 0; b < boxes.length; b += 5) {
      const id = boxes[b];
      const x0 = Math.floor(boxes[b + 1] / c) - this._cx0;
      const z0 = Math.floor(boxes[b + 2] / c) - this._cz0;
      const x1 = Math.floor(boxes[b + 3] / c) - this._cx0;
      const z1 = Math.floor(boxes[b + 4] / c) - this._cz0;
      for (let cz = z0; cz <= z1; cz++) {
        const row = cz * nx;
        for (let cx = x0; cx <= x1; cx++) items[cursor[row + cx]++] = id;
      }
    }
    this._start = start;
    this._items = items;
  }

  /**
   * Ids whose box may overlap the query box, in the shared `_out` buffer.
   *
   * An id can appear more than once when its box spans several of the queried
   * cells. Every caller here is running a "does any of these contain the
   * point" test, for which a duplicate is wasted arithmetic and nothing worse.
   * @returns {number[]}
   */
  query(minX, minZ, maxX, maxZ) {
    const out = this._out;
    out.length = 0;
    if (this._count === 0) return out;
    if (this._dirty) this._build();
    const c = this.cell;
    const nx = this._nx;
    let cx0 = Math.floor(minX / c) - this._cx0;
    let cz0 = Math.floor(minZ / c) - this._cz0;
    let cx1 = Math.floor(maxX / c) - this._cx0;
    let cz1 = Math.floor(maxZ / c) - this._cz0;
    if (cx0 < 0) cx0 = 0;
    if (cz0 < 0) cz0 = 0;
    if (cx1 >= nx) cx1 = nx - 1;
    if (cz1 >= this._nz) cz1 = this._nz - 1;
    const start = this._start;
    const items = this._items;
    for (let cz = cz0; cz <= cz1; cz++) {
      const row = cz * nx;
      for (let cx = cx0; cx <= cx1; cx++) {
        const a = start[row + cx];
        const b = start[row + cx + 1];
        for (let i = a; i < b; i++) out.push(items[i]);
      }
    }
    return out;
  }

  /**
   * Smallest `distTo(id, x, z)` over every registered item, exactly.
   *
   * Returns `Infinity` for an empty index. `distTo` may return a NEGATIVE
   * number - a road's half-width is subtracted, so standing on a road gives a
   * negative distance - and the pruning is written to stay sound for that.
   *
   * The search starts at the first ring that can reach an occupied cell rather
   * than at ring zero, which is what stops a probe three hundred metres from
   * the nearest road walking thirty-seven empty rings to get there. Aldermoor
   * is the pathological case: roads occupy a ~150x230m patch and the grass
   * scatter asks this question well over a million times spread across
   * 900x900m, so nineteen probes in twenty are nowhere near a road.
   *
   * The per-cell rejection in `_cell` is sound for the same reason the ring
   * bound is. If the probe is OUTSIDE an item's inserted box then `distTo` for
   * that item is at least the distance to the box, hence at least the distance
   * to any cell the box occupies. If the probe is INSIDE the box - the only
   * case where `distTo` can drop below that - then the item is registered in
   * the probe's own cell, which is scanned first, at which point `best` is
   * still Infinity and nothing is rejected.
   *
   * @param {number} x @param {number} z
   * @param {(id:number, x:number, z:number) => number} distTo
   */
  nearest(x, z, distTo) {
    if (this._count === 0) return Infinity;
    if (this._dirty) this._build();
    const c = this.cell;
    const nx = this._nx;
    const nz = this._nz;
    const qx = Math.floor(x / c) - this._cx0;
    const qz = Math.floor(z / c) - this._cz0;
    // Rings below `k0` cannot reach an occupied cell; rings above `kMax` have
    // covered all of them, so the loop always terminates.
    let k0 = 0;
    if (qx < 0) k0 = -qx;
    else if (qx >= nx) k0 = qx - nx + 1;
    if (qz < 0) { if (-qz > k0) k0 = -qz; }
    else if (qz >= nz) { if (qz - nz + 1 > k0) k0 = qz - nz + 1; }
    const kMax = Math.max(qx, nx - 1 - qx, qz, nz - 1 - qz);
    let best = Infinity;
    for (let k = k0; k <= kMax; k++) {
      const x0 = qx - k;
      const x1 = qx + k;
      const z0 = qz - k;
      const z1 = qz + k;
      const rz0 = z0 > 0 ? z0 : 0;
      const rz1 = z1 < nz - 1 ? z1 : nz - 1;
      for (let cz = rz0; cz <= rz1; cz++) {
        // Ring, not disc: the top and bottom rows are walked across, the rows
        // between them only at their two ends. Rescanning the interior would
        // still be correct, just k^2 work per ring instead of k.
        if (cz === z0 || cz === z1) {
          const rx0 = x0 > 0 ? x0 : 0;
          const rx1 = x1 < nx - 1 ? x1 : nx - 1;
          for (let cx = rx0; cx <= rx1; cx++) best = this._cell(cx, cz, x, z, distTo, best);
        } else {
          if (x0 >= 0 && x0 < nx) best = this._cell(x0, cz, x, z, distTo, best);
          if (x1 !== x0 && x1 >= 0 && x1 < nx) best = this._cell(x1, cz, x, z, distTo, best);
        }
      }
      // Anything not yet scanned sits in ring >= k+1, every point of which is
      // at least k cells away. Once `best` is inside that, nothing can beat it.
      if (best <= k * c) break;
    }
    return best;
  }

  /** One cell of `nearest`: reject on the cell's own distance, then its items. */
  _cell(cx, cz, x, z, distTo, best) {
    const c = this.cell;
    const x0 = (cx + this._cx0) * c;
    const z0 = (cz + this._cz0) * c;
    const dx = x < x0 ? x0 - x : (x > x0 + c ? x - x0 - c : 0);
    const dz = z < z0 ? z0 - z : (z > z0 + c ? z - z0 - c : 0);
    /* Squared, to keep a square root out of the inner loop. `best < 0` rejects
     * outright: a cell's distance is never negative, so nothing a cell holds
     * can beat a negative best - and the one cell that could, the one holding
     * the probe, was scanned at ring zero while best was still Infinity.
     * `Infinity * Infinity` is `Infinity`, so that first cell is never
     * rejected and the invariant holds. */
    if (best < 0 || dx * dx + dz * dz > best * best) return best;
    const row = cz * this._nx + cx;
    const items = this._items;
    const a = this._start[row];
    const b = this._start[row + 1];
    for (let i = a; i < b; i++) {
      const d = distTo(items[i], x, z);
      if (d < best) best = d;
    }
    return best;
  }
}

/**
 * Perpendicular distance from (x, z) to the segment (ax,az)-(bx,bz), minus
 * `halfWidth`. Shared by the road index and by the linear reference the tests
 * compare it against, so the two cannot drift.
 */
export function segmentDistance(x, z, ax, az, bx, bz, halfWidth) {
  const ex = bx - ax;
  const ez = bz - az;
  const len = ex * ex + ez * ez;
  let t = len > 1e-6 ? ((x - ax) * ex + (z - az) * ez) / len : 0;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  const dx = x - (ax + ex * t);
  const dz = z - (az + ez * t);
  return Math.sqrt(dx * dx + dz * dz) - halfWidth;
}
