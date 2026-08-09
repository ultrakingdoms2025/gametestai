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
const SPRIGS_PER_HEDGE = 9;

/** How far a sprig may lean past the hedge's own footprint, metres. */
const SPRIG_OVERHANG = 0.22;

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
      const scale = 0.34 + ((h >>> 24) & 0xff) / 0xff * 0.5;
      const ry = ((h >>> 8) & 0xff) / 0xff * Math.PI;
      out.push({
        x: d.cx + (alongX ? t * half * 0.92 : lean),
        y: top - 0.16,
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


/* ------------------------------------------------------------------ */
/* Hedge candles                                                       */
/* ------------------------------------------------------------------ */

/**
 * How many candles a district gets.
 *
 * Levels 0 to 2 are roofed by the floor above - that is inherent to stacking
 * four levels 9 m apart - so almost no sun reaches them and the maze read as
 * very dark. Candles are the fix the owner asked for, and they are two things
 * at once:
 *
 *  - a MESH each, emissive, instanced, costing one draw call per district.
 *    These are what you actually see, and there are many.
 *  - a LIGHT on some of them. `LightRig` renders only the nearest twelve point
 *    lights in the whole scene (RIG_BUDGET), so more than a handful per
 *    district buys nothing on screen and still costs the rig a per-frame scan.
 *    So the lights are sparse and the candles are dense.
 */
export const CANDLES_PER_DISTRICT = 70;

/** How many of those also carry a real point light. */
export const LIT_CANDLES_PER_DISTRICT = 24;

/** Candle height above the floor - chest height, on the hedge face. */
const CANDLE_Y = 1.35;

/**
 * Candle placements for one district, in world metres.
 *
 * Set against the hedge faces rather than floating mid-corridor, and derived
 * from the district's own hedge descriptors so they can never end up inside a
 * wall or out in a cell that has none.
 *
 * `lit` marks the ones that get a real light. It is the FIRST few rather than a
 * second hash, so a caller can slice instead of filter and the two lists can
 * never disagree about which candle a light belongs to.
 *
 * @returns {Array<{x:number,y:number,z:number,lit:boolean}>}
 */
export function candlePlacements(descs, seedish = 0) {
  const walls = [];
  for (const d of descs) {
    if (d.kind !== 'hedge') continue;
    if (d.hy * 2 < MAZE.HEDGE_HEIGHT - 0.01) continue;
    walls.push(d);
  }
  if (walls.length === 0) return [];

  const out = [];
  const want = Math.min(CANDLES_PER_DISTRICT, walls.length);
  for (let i = 0; i < want; i++) {
    /* Spread across the district's walls rather than clustering: stepping by a
     * hashed stride over the wall list gives an even scatter without sorting
     * or rejection sampling. */
    const h = hash32(seedish, i, 0x0c4);
    /* Stride by a prime through the wall list so the scatter stays even as
     * the count rises - at 26 they were sparse enough that a player could
     * stand in a corridor with only two lights within thirty metres, which is
     * ambient light with extra steps. */
    const w = walls[(i * 31 + (h % 7)) % walls.length];
    const base = w.cy - w.hy;
    /* Offset onto the FACE of the hedge, on the side the corridor is. A hedge
     * is thin on one axis; the candle sits just proud of that face. */
    const thinX = w.hx < w.hz;
    const push = (h & 1) ? 1 : -1;
    out.push({
      x: w.cx + (thinX ? push * (w.hx + 0.12) : ((h >>> 8 & 0xff) / 255 - 0.5) * w.hx * 1.6),
      y: base + CANDLE_Y,
      z: w.cz + (thinX ? ((h >>> 8 & 0xff) / 255 - 0.5) * w.hz * 1.6 : push * (w.hz + 0.12)),
      lit: i < LIT_CANDLES_PER_DISTRICT,
    });
  }
  return out;
}
