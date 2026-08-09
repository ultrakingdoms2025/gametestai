/**
 * Where the unkempt growth goes on a hedge, as instance transforms.
 *
 * Pure - no THREE, no DOM - so the placement can be asserted under `node
 * --test` like everything else in this directory, and so `MazeChunks` is left
 * doing nothing but turning numbers into an `InstancedMesh`.
 *
 * ## Foliage is never a collider
 *
 * Section 2 of the spec permits props in the 0.45-5.0 m band ONLY if they are
 * non-collidable, and names foliage as the example. A sprig sits on top of a
 * five-metre hedge, squarely in the band, so if one ever reached the collider
 * descriptor path it would be a ladder over a hedge and THE ANTI-LADDER GATE
 * would be right to fail. These transforms are consumed for meshes and for
 * nothing else; `scripts/tests/maze-foliage.test.mjs` asserts no `foliage`
 * descriptor ever appears in `districtColliders`.
 *
 * ## What it is for
 *
 * The hedge is a box, and the giveaway is its perfectly straight top edge
 * running the length of a corridor. Breaking that line is worth more than any
 * amount of detail on the faces, which is why the sprigs go on the top edge
 * and the upper corners rather than being scattered evenly.
 */
import { MAZE, hash32 } from './MazeTopology.js';

/** Sprigs per hedge segment. Cheap - one instanced draw per district. */
const SPRIGS_PER_HEDGE = 5;

/** How far a sprig may lean past the hedge's own footprint, metres. */
const SPRIG_OVERHANG = 0.35;

/**
 * Instance transforms for one district's foliage.
 *
 * @param {Array<{cx:number,cy:number,cz:number,hx:number,hy:number,hz:number,kind:string}>} descs
 *   the district's collider descriptors - only `hedge` ones grow anything.
 * @param {number} seedish anything stable per district; mixed into the hash so
 *   two districts with identical hedge layouts do not grow identical foliage.
 * @returns {Array<{x:number,y:number,z:number,ry:number,s:number}>}
 */
export function foliageTransforms(descs, seedish = 0) {
  const out = [];
  for (let i = 0; i < descs.length; i++) {
    const d = descs[i];
    if (d.kind !== 'hedge') continue;
    /* Only full-height hedges grow. The guard rails round a stairwell are
     * `hedge`-kinded too and are waist-high furniture, not shrubbery. */
    if (d.hy * 2 < MAZE.HEDGE_HEIGHT - 0.01) continue;

    const top = d.cy + d.hy;
    /* Along the hedge's LONG axis - the straight top edge is the thing being
     * broken up, so the sprigs have to run along it. */
    const alongX = d.hx > d.hz;
    const half = alongX ? d.hx : d.hz;

    for (let s = 0; s < SPRIGS_PER_HEDGE; s++) {
      const h = hash32(seedish, i, s, 0x5b7);
      const t = ((h & 0xffff) / 0x10000) * 2 - 1;              // -1..1 along
      const lean = (((h >>> 16) & 0xff) / 0xff - 0.5) * 2 * SPRIG_OVERHANG;
      const scale = 0.5 + ((h >>> 24) & 0xff) / 0xff * 0.75;
      const ry = ((h >>> 8) & 0xff) / 0xff * Math.PI;
      out.push({
        x: d.cx + (alongX ? t * half * 0.92 : lean),
        y: top - 0.1,
        z: d.cz + (alongX ? lean : t * half * 0.92),
        ry,
        s: scale,
      });
    }
  }
  return out;
}

/**
 * A stone band at the base of every hedge.
 *
 * "Five-metre hedges over weathered stone footings" - section 10. It is
 * MESH ONLY and exactly as wide as the hedge above it, which is deliberate on
 * both counts: a proud plinth would need its own colliders, and at roughly two
 * per cell that is tens of thousands of new colliders for decoration. Matching
 * the hedge's own footprint means the hedge collider already covers it and
 * nothing new is registered at all.
 *
 * @returns {Array<{x:number,y:number,z:number,hx:number,hy:number,hz:number}>}
 */
export function footingTransforms(descs) {
  const out = [];
  for (const d of descs) {
    if (d.kind !== 'hedge') continue;
    if (d.hy * 2 < MAZE.HEDGE_HEIGHT - 0.01) continue;
    const base = d.cy - d.hy;
    out.push({
      x: d.cx, y: base + FOOTING_HEIGHT / 2, z: d.cz,
      hx: d.hx * 1.02, hy: FOOTING_HEIGHT / 2, hz: d.hz * 1.02,
    });
  }
  return out;
}

/**
 * How tall the stone band is.
 *
 * Under the auto-step, so that even though it is not collidable the player
 * never sees their capsule pass through something they would have expected to
 * step onto - the visual and the collision agree about what is walkable.
 */
export const FOOTING_HEIGHT = MAZE.STEP_HEIGHT * 0.8;
