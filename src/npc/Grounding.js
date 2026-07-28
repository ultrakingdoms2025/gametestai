import * as THREE from 'three';
import { COLLISION_LAYER } from '../physics/Physics.js';

/**
 * Surface resolution for character placement.
 *
 * `physics.groundHeight` answers "what is the first thing below this point",
 * and `physics.groundHeightOrFallback` answers "what is the *topmost* thing at
 * this column". Neither is the question a spawner actually asks, which is:
 * *which of the several surfaces stacked at this column is a person supposed to
 * be standing on?* A station deck under a 24 m gantry has three surfaces in the
 * column; a keep has four. Picking the top one drops civilians on rooftops,
 * picking the first one below an authored height drops them into basements, and
 * a single ring probe cannot tell either case apart.
 *
 * So this module walks the whole stack, keeps only the surfaces that are
 * genuinely walkable (flat enough, with head clearance up to the next surface
 * above), and returns the one closest to where the author meant. Everything
 * that places or repairs a character goes through here.
 *
 * All of it is spawn-time or watchdog-rate work - never per-frame - so the
 * raycasts and the small result array are affordable.
 */

/** Below this the surface is a wall or a steep roof, not a floor. */
const WALKABLE_NORMAL_Y = 0.55;
/** A person needs this much clear air above a surface to stand on it. */
const STANDING_HEADROOM = 1.85;
/** Nudge the next cast below the surface we just found, to avoid re-hitting it. */
const STACK_EPSILON = 0.02;
/** Hard cap on stacked surfaces per column. Nothing in these worlds needs more. */
const MAX_STACK = 10;

/** surfaceStack() owns these two exclusively. */
const _ssOrigin = new THREE.Vector3();
const _ssDown = new THREE.Vector3(0, -1, 0);

/**
 * Every walkable-or-not surface in the column at (x, z), highest first.
 *
 * @param {any} physics
 * @param {number} x
 * @param {number} z
 * @param {number} [topY] height to start casting from
 * @param {number} [bottomY] stop once we drop past this
 * @returns {Array<{y:number, normalY:number, walkable:boolean, headroom:number}>}
 */
export function surfaceStack(physics, x, z, topY = 400, bottomY = -80) {
  const out = [];
  let y = topY;
  for (let i = 0; i < MAX_STACK; i++) {
    _ssOrigin.set(x, y, z);
    const hit = physics.raycast(_ssOrigin, _ssDown, y - bottomY, COLLISION_LAYER.WORLD);
    if (!hit) break;
    const ny = Math.abs(hit.normal?.y ?? 1);
    const sy = hit.point.y;
    out.push({ y: sy, normalY: ny, walkable: ny >= WALKABLE_NORMAL_Y, headroom: Infinity });
    y = sy - STACK_EPSILON;
    if (y <= bottomY) break;
  }
  // Headroom is the gap up to the underside of whatever is stacked above. Using
  // the stack rather than an upward raycast is deliberate: world geometry is
  // single-sided, so a ray fired up from under a deck passes straight through
  // it and reports infinite clearance.
  for (let i = 0; i < out.length; i++) {
    out[i].headroom = i === 0 ? Infinity : out[i - 1].y - out[i].y;
  }
  return out;
}

/**
 * Pick the surface a character should stand on at (x, z).
 *
 * Preference order: walkable, has standing headroom, and then nearest to
 * `hintY` - the height the author (or the character's own current position)
 * implies. That is what keeps a civilian authored under a gantry on the deck
 * instead of on the gantry, and keeps one authored on a rampart on the rampart.
 *
 * @param {any} physics
 * @param {number} x
 * @param {number} z
 * @param {number} hintY intended height
 * @returns {number|null} surface height, or null if the column has no floor
 */
export function resolveSurfaceY(physics, x, z, hintY) {
  const stack = surfaceStack(physics, x, z, Math.max(hintY + 300, 400));
  if (stack.length === 0) return null;
  let best = null;
  let bestScore = Infinity;
  for (const s of stack) {
    if (!s.walkable) continue;
    // A surface with a ceiling closer than a person is tall is a crawlspace, not
    // a floor. It is still better than nothing, so it is scored rather than
    // rejected outright.
    const cramped = s.headroom < STANDING_HEADROOM ? 40 : 0;
    const score = Math.abs(s.y - hintY) + cramped;
    if (score < bestScore) {
      bestScore = score;
      best = s;
    }
  }
  if (best) return best.y;
  // No walkable surface at all: a steep roof still beats falling forever.
  let fallback = stack[0];
  for (const s of stack) if (Math.abs(s.y - hintY) < Math.abs(fallback.y - hintY)) fallback = s;
  return fallback.y;
}

/**
 * Resolve an authored spawn onto a real, standable surface, searching outward
 * if the exact column has no floor at all.
 *
 * @param {any} physics
 * @param {THREE.Vector3} p authored point (`p.y` is the hint)
 * @param {THREE.Vector3} [out]
 * @returns {THREE.Vector3|null} null only when the whole neighbourhood is empty
 */
export function resolveSpot(physics, p, out) {
  if (!p) return null;
  const v = out ?? new THREE.Vector3();
  const direct = resolveSurfaceY(physics, p.x, p.z, p.y);
  if (direct !== null) return v.set(p.x, direct, p.z);
  for (const r of [1.5, 3, 6, 12]) {
    for (let i = 0; i < 8; i++) {
      const a = (i / 8) * Math.PI * 2;
      const x = p.x + Math.cos(a) * r;
      const z = p.z + Math.sin(a) * r;
      const y = resolveSurfaceY(physics, x, z, p.y);
      if (y !== null) return v.set(x, y, z);
    }
  }
  return null;
}

/**
 * Is this character standing somewhere a person could actually stand?
 *
 * Used by the spawn validator and by the runtime watchdog. "Underground" is not
 * "there is something above me" - a deck under a gantry is fine - it is "there
 * is no floor at my feet", or "the floor I should be on is well above me".
 *
 * @param {any} physics
 * @param {THREE.Vector3} position feet position
 * @param {number} hintY the height this character is supposed to be near
 * @returns {{ok:boolean, surfaceY:number|null, drop:number}}
 */
export function auditStanding(physics, position, hintY) {
  const y = resolveSurfaceY(physics, position.x, position.z, hintY);
  if (y === null) return { ok: false, surfaceY: null, drop: Infinity };
  const drop = y - position.y;
  // Tolerance is asymmetric on purpose: a few centimetres of float is a stale
  // ground sample and harmless, but being *below* the resolved floor at all
  // means the character is inside geometry.
  return { ok: drop < 0.35 && drop > -1.2, surfaceY: y, drop };
}

/**
 * How deep a character will wade before water counts as impassable.
 *
 * Knee-deep is a puddle you walk through; waist-deep is a river you go around.
 * Characters have no swimming animation and no buoyancy - only the player does -
 * so anything past this is somewhere they simply must not be.
 */
export const WADE_DEPTH = 0.75;

/**
 * Depth of standing water over the column at (x, z), in metres. 0 when dry.
 *
 * `WaterVolumes` knows where the *surface* is; the bed is collision geometry,
 * which it deliberately does not own - so the depth is the gap between the two.
 * That matters: the medieval river is 1.5 m in the channel and a few
 * centimetres at the margins, and a character should be free to walk the
 * margins.
 *
 * Cost is one grid lookup, and a raycast *only* where there is water overhead -
 * so away from the river this is a hash miss and nothing else, which is what
 * makes it affordable to call from steering every frame.
 *
 * @param {any} physics
 * @param {{surfaceYAt:(x:number,z:number)=>number|null}|null} water
 * @param {number} x
 * @param {number} z
 * @returns {number} depth in metres, 0 if dry, Infinity if the bed is missing
 */
export function waterDepthAt(physics, water, x, z) {
  if (!water) return 0;
  const surfaceY = water.surfaceYAt(x, z);
  if (surfaceY === null) return 0;
  const bedY = physics.groundHeight(x, z, surfaceY + 1.0, 40);
  // Water over a hole in the collision mesh: no bed to stand on at all, so this
  // is as impassable as it gets.
  if (bedY === null) return Infinity;
  const d = surfaceY - bedY;
  return d > 0 ? d : 0;
}

/**
 * Is this column too deep to stand in?
 * @returns {boolean}
 */
export function isDeepWater(physics, water, x, z) {
  return waterDepthAt(physics, water, x, z) > WADE_DEPTH;
}

/**
 * Nearest dry-enough spot to `p`, searching outward in rings.
 *
 * Used to keep spawns and repairs out of the river. Returns the original point
 * when it is already dry, and null when the whole neighbourhood is water - the
 * caller decides whether that is fatal.
 *
 * @param {any} physics
 * @param {any} water
 * @param {THREE.Vector3} p
 * @param {THREE.Vector3} [out]
 * @returns {THREE.Vector3|null}
 */
export function nearestDrySpot(physics, water, p, out) {
  const v = out ?? new THREE.Vector3();
  if (!water || !isDeepWater(physics, water, p.x, p.z)) return v.copy(p);
  for (const r of [2, 4, 7, 11, 16, 22, 30]) {
    for (let i = 0; i < 10; i++) {
      const a = (i / 10) * Math.PI * 2;
      const x = p.x + Math.cos(a) * r;
      const z = p.z + Math.sin(a) * r;
      if (isDeepWater(physics, water, x, z)) continue;
      const y = resolveSurfaceY(physics, x, z, p.y);
      if (y === null) continue;
      return v.set(x, y, z);
    }
  }
  return null;
}

/** seatSurfaceAt() owns these exclusively. */
const _seatRing = new THREE.Vector3();

/**
 * Look for something bench-height to sit on at (x, z).
 *
 * A seat reads as a *narrow* raised surface: 0.34-0.68 m above the floor around
 * it, with that floor still present a short step away in most directions. That
 * signature catches benches, planter rims, low walls and bleacher treads, and
 * rejects tables, crates the size of a room, and the tops of buildings - all
 * without any authored seat data, which none of these worlds have.
 *
 * @param {any} physics
 * @param {number} x
 * @param {number} z
 * @param {number} floorY height of the surrounding floor
 * @returns {number|null} seat height
 */
export function seatSurfaceAt(physics, x, z, floorY) {
  const stack = surfaceStack(physics, x, z, floorY + 12);
  let seat = null;
  for (const s of stack) {
    const h = s.y - floorY;
    if (h >= 0.34 && h <= 0.68 && s.walkable && s.headroom > 1.0) {
      seat = s.y;
      break;
    }
  }
  if (seat === null) return null;
  // Confirm the floor comes back around it, so we are sitting on a bench rather
  // than on the edge of a mezzanine.
  let openSides = 0;
  for (let i = 0; i < 4; i++) {
    const a = (i / 4) * Math.PI * 2;
    _seatRing.set(x + Math.cos(a) * 0.95, floorY + 0.9, z + Math.sin(a) * 0.95);
    const y = resolveSurfaceY(physics, _seatRing.x, _seatRing.z, floorY);
    if (y !== null && Math.abs(y - floorY) < 0.3) openSides++;
  }
  return openSides >= 2 ? seat : null;
}

export { WALKABLE_NORMAL_Y, STANDING_HEADROOM };
