/**
 * The Citadel mesa's ground.
 *
 * Lifted out of `CitadelWorld.js` so the generation worker can import it
 * without `three`. `CitadelWorld` imports it back, so the visible heightfield,
 * the collision under it and every prop placement still read one function -
 * which is the whole reason this shape is expressed as a function at all. It was
 * previously three separate approximations of the same slope, and where the
 * collision sat lower than the mesh the player walked *underneath* the visible
 * world across 7% of the map.
 *
 * Deliberately free of x/z noise. Dunes are built as real geometry with real
 * colliders instead: noise in here is noise the dune boxes cannot reproduce, and
 * that is the same bug again in a smaller size.
 */

/** Height of the plateau the town sits on, above the surrounding desert. */
export const MESA_Y = 14;
/** Where the plateau edge falls away to the approach road. */
export const MESA_R = 132;
/** Horizontal distance the shoulder takes to fall from the mesa to the desert. */
export const SHOULDER = 46;
/** Playfield half-extent. */
export const HALF = 200;

/** Ground height, as a pure function of distance from the centre. */
export function terrainH(r) {
  if (r < MESA_R) return MESA_Y;
  const t = Math.min(1, (r - MESA_R) / SHOULDER);
  return MESA_Y * (1 - t * t * (3 - 2 * t));
}

/** The same surface, addressed the way every other world's ground is. */
export function citadelHeight(x, z) {
  return terrainH(Math.hypot(x, z));
}
