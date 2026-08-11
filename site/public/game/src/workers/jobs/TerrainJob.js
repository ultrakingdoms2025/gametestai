/**
 * Terrain generation jobs.
 *
 * This module is imported by BOTH the worker and the main-thread fallback, and
 * it must stay free of `three`, of the DOM, and of anything that reaches for a
 * renderer - it runs where none of those exist.
 *
 * The height functions themselves live in `src/worlds/terrain/*.js` and are
 * imported by the worlds too, so there is exactly one definition of each
 * world's ground. That is the whole point: a second copy in here would be a
 * second thing to keep in step, and the day the two drifted the player would
 * start walking through the scenery.
 */

import { HEIGHT_FIELDS } from '../../worlds/terrain/index.js';

/**
 * Sample a height function over a regular grid and build everything downstream
 * of it that is pure arithmetic: the collision heights, and the mesh's
 * positions, UVs, indices and normals.
 *
 * Returning all of it from one job matters. The samples are the expensive part
 * (a Medieval sample is five octaves of simplex plus a river, a causeway and
 * five levelling pads), so computing them here and shipping only the derived
 * buffers means the main thread never evaluates the height function at all for
 * the terrain - it just uploads what it is given.
 *
 * @param {{ field: string, params?: object, originX: number, originZ: number,
 *           size: number, seg: number, uv?: 'unit'|'none', normals?: boolean }} p
 * @returns {{ buffers: object, transfer: ArrayBuffer[] }}
 */
export function sampleTerrain(p) {
  const {
    field, params = {}, originX, originZ, size, seg,
    uv = 'unit', normals = true,
  } = p;

  const fn = HEIGHT_FIELDS[field];
  if (!fn) throw new Error(`[TerrainJob] unknown height field "${field}"`);
  const height = fn(params);

  const N = seg + 1;
  const step = size / seg;
  const count = N * N;

  const heights = new Float32Array(count);
  const positions = new Float32Array(count * 3);
  const uvs = uv === 'none' ? null : new Float32Array(count * 2);

  let minY = Infinity;
  let maxY = -Infinity;
  for (let j = 0; j < N; j++) {
    const z = originZ + j * step;
    for (let i = 0; i < N; i++) {
      const x = originX + i * step;
      const k = j * N + i;
      const y = height(x, z);
      heights[k] = y;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
      positions[k * 3] = x;
      positions[k * 3 + 1] = y;
      positions[k * 3 + 2] = z;
      if (uvs) {
        uvs[k * 2] = (x - originX) / size;
        uvs[k * 2 + 1] = 1 - (z - originZ) / size;
      }
    }
  }

  /* Indices split each quad along its 00->11 diagonal, which is the diagonal
   * `Collider.sampleHeight` interpolates across. Matching them is what makes the
   * collision surface and the drawn surface the same triangles rather than two
   * approximations of the same field. */
  const indices = new Uint32Array(seg * seg * 6);
  let t = 0;
  for (let j = 0; j < seg; j++) {
    for (let i = 0; i < seg; i++) {
      const a = j * N + i;
      const b = a + N;
      indices[t++] = a; indices[t++] = b; indices[t++] = b + 1;
      indices[t++] = a; indices[t++] = b + 1; indices[t++] = a + 1;
    }
  }

  const out = { heights, positions, indices, nx: N, nz: N, step, minY, maxY };
  const transfer = [heights.buffer, positions.buffer, indices.buffer];
  if (uvs) { out.uvs = uvs; transfer.push(uvs.buffer); }
  if (normals) {
    const n = computeNormals(heights, N, step);
    out.normals = n;
    transfer.push(n.buffer);
  }
  return { buffers: out, transfer };
}

/**
 * Per-vertex normals straight from the height grid.
 *
 * Central differences rather than an area-weighted average of adjacent face
 * normals: on a regular grid the two agree to within a rounding error, and this
 * needs neither the index buffer nor a second pass over the triangles.
 */
function computeNormals(heights, N, step) {
  const out = new Float32Array(N * N * 3);
  const inv = 1 / (2 * step);
  for (let j = 0; j < N; j++) {
    const jm = j > 0 ? j - 1 : 0;
    const jp = j < N - 1 ? j + 1 : N - 1;
    // Halve the divisor at the border, where the difference spans one cell.
    const sz = (jp - jm) === 2 ? inv : 1 / step;
    for (let i = 0; i < N; i++) {
      const im = i > 0 ? i - 1 : 0;
      const ip = i < N - 1 ? i + 1 : N - 1;
      const sx = (ip - im) === 2 ? inv : 1 / step;
      const dx = (heights[j * N + ip] - heights[j * N + im]) * sx;
      const dz = (heights[jp * N + i] - heights[jm * N + i]) * sz;
      let nx = -dx;
      let ny = 1;
      let nz = -dz;
      const len = Math.hypot(nx, ny, nz) || 1;
      const k = (j * N + i) * 3;
      out[k] = nx / len;
      out[k + 1] = ny / len;
      out[k + 2] = nz / len;
    }
  }
  return out;
}

/**
 * Sample a height function over an arbitrary rectangle, for collision only.
 * Used where the collision grid is not the mesh grid - the skate bowl and the
 * ski mound are authored at their own resolutions.
 *
 * `holeRects` mark cells whose centre falls inside them as having no surface.
 *
 * @param {{ field: string, params?: object, x0: number, z0: number,
 *           x1: number, z1: number, res: number,
 *           holeRects?: Array<{x0:number,z0:number,x1:number,z1:number}> }} p
 */
export function sampleCollision(p) {
  const { field, params = {}, x0, z0, x1, z1, res, holeRects = null } = p;
  const fn = HEIGHT_FIELDS[field];
  if (!fn) throw new Error(`[TerrainJob] unknown height field "${field}"`);
  const height = fn(params);

  const nqx = Math.max(1, Math.ceil((x1 - x0) / res));
  const nqz = Math.max(1, Math.ceil((z1 - z0) / res));
  const stepX = (x1 - x0) / nqx;
  const stepZ = (z1 - z0) / nqz;
  const nx = nqx + 1;
  const nz = nqz + 1;

  const heights = new Float32Array(nx * nz);
  for (let j = 0; j < nz; j++) {
    const z = z0 + j * stepZ;
    for (let i = 0; i < nx; i++) heights[j * nx + i] = height(x0 + i * stepX, z);
  }

  let holes = null;
  if (holeRects && holeRects.length) {
    holes = new Uint8Array(nqx * nqz);
    for (let j = 0; j < nqz; j++) {
      const cz = z0 + (j + 0.5) * stepZ;
      for (let i = 0; i < nqx; i++) {
        const cx = x0 + (i + 0.5) * stepX;
        for (let r = 0; r < holeRects.length; r++) {
          const h = holeRects[r];
          if (cx > h.x0 && cx < h.x1 && cz > h.z0 && cz < h.z1) {
            holes[j * nqx + i] = 1;
            break;
          }
        }
      }
    }
  }

  const out = { heights, nx, nz, stepX, stepZ, originX: x0, originZ: z0, holes };
  const transfer = [heights.buffer];
  if (holes) transfer.push(holes.buffer);
  return { buffers: out, transfer };
}

/** Job registry. Keys are the `kind` strings `GenPool.run` dispatches on. */
export const JOBS = {
  terrain: sampleTerrain,
  collision: sampleCollision,
};
