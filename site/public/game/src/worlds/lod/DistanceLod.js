import * as THREE from 'three';

/**
 * Distance LOD for renderables that never move.
 *
 * This exists because frustum culling and distance culling solve different
 * halves of the same problem and a world needs both. Medieval already splits
 * its foliage spatially - grass into an 8x8 grid of 50m zones, trees into
 * quadrant buckets - precisely so that each piece gets its own bounding sphere
 * and can leave the frustum on its own. What none of that does is notice that
 * a zone is *in front of you but a quarter of a kilometre away*, still paying
 * full triangle cost for something that covers four pixels. That is what this
 * is for.
 *
 * The deliberate non-goal: this never merges or re-buckets anything. The
 * spatial split is the thing that makes both culls work, and a smaller draw
 * call count bought by widening bounding spheres is a bad trade - a merged
 * field never leaves the frustum and never gets far enough away to hide.
 *
 * Two independent bands per registration, either of which may be omitted:
 *
 *   hideBeyond   past this distance the object stops drawing entirely. Only
 *                honest when the object genuinely contributes no pixels out
 *                there - Medieval's grass qualifies because its vertex shader
 *                has already collapsed every blade to zero height by then.
 *   lo/swapBeyond  past this distance the mesh draws a cheaper geometry. The
 *                right tool for anything that still reads at range: a treeline
 *                must not vanish, but it does not need 80-face crown lumps.
 *
 * Both bands have hysteresis, because a band edge without it is a bug waiting
 * for a player to stand still on it: an object whose distance dithers by
 * millimetres around the threshold flips state every frame, and a canopy
 * strobing between two tessellations is far more visible than either one.
 *
 * Registrations are assumed static. The world-space bounding sphere is
 * recomputed from `matrixWorld` every frame (cheap - one sphere transform)
 * so a world group that gets repositioned still works, but an object that
 * moves relative to its own bounding sphere is not what this is for.
 */

/* ------------------------------------------------------------------ */
/* Module scratch. `update` runs over every registration every frame, so
 * nothing below this line may allocate. */
/* ------------------------------------------------------------------ */
const _cam = new THREE.Vector3();
const _sph = new THREE.Sphere();

/**
 * Distance is measured to the bounding sphere's world-space CENTRE.
 *
 * The correct default for a small object, and wrong for a large one: a 50m
 * grass zone's centre is up to 35m nearer or further than its own near corner,
 * so a threshold tuned against the centre hides blades that are still 35m
 * inside the visible range. Use it when the object is small relative to the
 * band, or when you want the band to move with the object's middle.
 */
export const CENTRE = 'centre';

/**
 * Distance is measured to the NEAREST POINT of the bounding sphere, i.e.
 * centre distance minus radius, clamped at zero.
 *
 * The conservative measure, and the one to reach for by default. "Nearest
 * point beyond D" means every triangle in the object is at least D away,
 * which is the only form of the statement you can actually prove a visual
 * claim about. Its cost is that a large bucket rarely qualifies - a
 * quadrant-sized tree bucket has a 140m radius, so its nearest point is
 * almost always underfoot and it almost never demotes. That is a true
 * statement about the bucket, not a flaw in the measure.
 */
export const SURFACE = 'surface';

/**
 * Hysteresis width in metres.
 *
 * Six metres, not sixty centimetres: the thing being suppressed is not float
 * noise, it is a player walking slowly back and forth across a threshold, and
 * at 3 m/s a one-metre band still flips twice a second. Six metres is two
 * seconds of walking and is small enough that no band edge below needs its
 * near boundary re-justified separately.
 */
export const DEFAULT_BAND = 6;

/**
 * One hysteretic band edge, and the only piece of state logic in the module.
 *
 * The threshold is the OUT edge and the band is subtracted to make the IN
 * edge, so the asymmetry always errs toward the expensive-but-correct side:
 * an object is demoted only once it is genuinely past `threshold`, and is
 * promoted again slightly early, at `threshold - band`. Every distance quoted
 * by a caller is therefore the distance at which the object is guaranteed
 * still to be fully drawn.
 *
 * @param {boolean} wasPast previous state for this edge
 * @param {number} distance metres
 * @param {number} threshold metres; `Infinity` disables the edge
 * @param {number} band hysteresis width in metres
 * @returns {boolean} the new state
 */
export function pastBand(wasPast, distance, threshold, band) {
  if (!Number.isFinite(threshold)) return false;
  if (wasPast) return distance > Math.max(0, threshold - band);
  return distance > threshold;
}

export class DistanceLod {
  constructor() {
    /** @type {Array<object>} */
    this.entries = [];
  }

  /**
   * Register a renderable.
   *
   * @param {THREE.Mesh|THREE.InstancedMesh} object
   * @param {{ hideBeyond?: number, lo?: THREE.BufferGeometry, swapBeyond?: number,
   *           measure?: string|((camPos: THREE.Vector3) => number),
   *           band?: number }} opts
   *   measure may be `CENTRE`, `SURFACE`, or a function returning metres.
   *   The function form exists for shapes a sphere cannot describe: Medieval's
   *   backdrop treelines are 300m-diameter *rings*, and their bounding sphere
   *   covers the whole map, so a sphere-based measure reports every ring as
   *   underfoot from anywhere and no band ever fires.
   */
  add(object, opts = {}) {
    const hi = object.geometry;
    /* Which sphere to measure against is fixed at registration, not read back
     * off the mesh each frame: after a swap `object.geometry.boundingSphere`
     * is the LO geometry's, and a measure that changes when the LOD changes
     * is a feedback loop. InstancedMesh keeps its own sphere on the object
     * (it has to - it spans all instances) and is unaffected by the swap. */
    let source = null;
    if (object.isInstancedMesh) {
      if (!object.boundingSphere) object.computeBoundingSphere();
      source = object.boundingSphere;
    } else if (hi) {
      if (!hi.boundingSphere) hi.computeBoundingSphere();
      source = hi.boundingSphere;
    }
    const e = {
      object,
      source,
      measure: opts.measure ?? SURFACE,
      hideBeyond: opts.hideBeyond ?? Infinity,
      hi,
      lo: opts.lo ?? null,
      swapBeyond: opts.lo ? (opts.swapBeyond ?? Infinity) : Infinity,
      band: opts.band ?? DEFAULT_BAND,
      hidden: false,
      swapped: false,
    };
    this.entries.push(e);
    return e;
  }

  /** Metres from the camera to one registration, by its chosen measure. */
  _distance(e) {
    if (typeof e.measure === 'function') return e.measure(_cam);
    if (!e.source) return 0;
    _sph.copy(e.source).applyMatrix4(e.object.matrixWorld);
    const d = _cam.distanceTo(_sph.center);
    return e.measure === SURFACE ? Math.max(0, d - _sph.radius) : d;
  }

  /**
   * Per-frame. Call from the world's `update`, which the world manager only
   * runs while the world is active - so a backgrounded world costs nothing.
   */
  update(camera) {
    const list = this.entries;
    if (!list.length) return;
    camera.getWorldPosition(_cam);
    for (let i = 0; i < list.length; i++) {
      const e = list[i];
      const d = this._distance(e);
      const hidden = pastBand(e.hidden, d, e.hideBeyond, e.band);
      if (hidden !== e.hidden) {
        e.hidden = hidden;
        e.object.visible = !hidden;
      }
      /* A hidden object still gets its swap evaluated. Deciding the geometry
       * only while visible means the frame it reappears on draws whichever
       * LOD it happened to be wearing when it went away, which is a pop with
       * a several-second fuse and no obvious cause. */
      if (e.lo) {
        const swapped = pastBand(e.swapped, d, e.swapBeyond, e.band);
        if (swapped !== e.swapped) {
          e.swapped = swapped;
          e.object.geometry = swapped ? e.lo : e.hi;
        }
      }
    }
  }

  /** Put every registration back to visible and hi-detail, and forget it. */
  clear() {
    for (const e of this.entries) {
      e.object.visible = true;
      if (e.lo && e.swapped) e.object.geometry = e.hi;
      e.hidden = false;
      e.swapped = false;
    }
    this.entries.length = 0;
  }
}
