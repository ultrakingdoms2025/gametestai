/**
 * Which grass zones are worth holding in memory right now.
 *
 * THE MEASUREMENT THAT FORCED THIS
 *
 * Widening the vale to 900 m turned an 8x8 grid of 50 m grass zones into an
 * 18x18 one. The 50 m cell and the 720-clump density are both correct and both
 * load-bearing - the cell is what lets a zone be proved past the 86 m blade
 * fade as a unit, the density is what stops a bigger vale being a thinner
 * meadow - so the instance count went up with the area, to 1,594,413 blades
 * across 324 `InstancedMesh`es. At 64 bytes of `instanceMatrix` and 12 of
 * `instanceColor` that is 115 MB of buffers, uploaded at build and held for
 * the life of the world.
 *
 * The draw cost was never the problem: each zone frustum-culls, and each zone
 * hides itself past 86 m because `windPatch` has already collapsed its blades
 * to zero height by then. That second fact is also the whole argument here.
 *
 * THE ARGUMENT
 *
 * The player is in ONE place. A zone whose nearest blade is past 86 m draws
 * nothing, and a zone that draws nothing does not need to exist. At any
 * instant fewer than fifty of the 324 zones can possibly contribute a pixel,
 * so 324 zones' worth of buffers is not a meadow - it is 275 zones of memory
 * spent on ground the player is not standing near. This decides which ones to
 * hold; `MedievalWorld` builds and frees them.
 *
 * The trade accepted, stated plainly: rebuilding a zone costs its placement
 * pass again (a few milliseconds), so the world now does that work while the
 * player walks instead of all of it at load. Amortised at one zone per frame
 * it is invisible - the frontier advances by roughly one zone per second at a
 * sprint - and it makes the initial build ~6x cheaper as a side effect. What
 * it is NOT allowed to cost is a hole in the meadow, which is why the build
 * radius has 33 m of lead on the distance at which a zone can first show a
 * blade, and why the release radius is 40 m further out again.
 *
 * DETERMINISM. A zone that is freed and rebuilt has to come back identical, so
 * `MedievalWorld` seeds each zone from its own coordinates rather than from a
 * stream shared with the other scatter passes. That is a requirement of this
 * design, not an incidental tidy-up: with a shared stream a zone's contents
 * would depend on how many zones happened to be built before it, and the
 * meadow would reshuffle every time the player walked away and back.
 *
 * Nothing in this file may import `three` or touch the DOM.
 */

/**
 * Rect distance at which a zone is BUILT, metres, measured from the player to
 * the nearest point of the zone's 50 m footprint.
 *
 * Derived from the visibility distance, not chosen. A zone hides itself when
 * the nearest point of its bounding SPHERE is past 86 m
 * (`GRASS_HIDE_DISTANCE`). That sphere has a ~36 m radius against a 25 m
 * half-cell, so face-on - the worst case - the sphere's nearest point is
 * about 11 m closer than the footprint's: a zone can first draw a blade at a
 * footprint distance of ~97 m. 130 m therefore leads visibility by 33 m,
 * which is four seconds at a sprint and a hundred frames of slack for a
 * one-zone-per-frame build rate.
 */
export const GRASS_BUILD_DISTANCE = 130;

/**
 * Rect distance at which a zone is FREED, metres.
 *
 * 40 m of hysteresis on the build radius, for the same reason `DistanceLod`
 * has any: a player pacing across the build edge would otherwise free and
 * rebuild the same zone every few frames, and rebuilding is the expensive
 * direction. 40 rather than `DistanceLod`'s 6 m because the cost of being
 * wrong here is a placement pass, not a geometry pointer swap.
 */
export const GRASS_RELEASE_DISTANCE = 170;

/**
 * Hard cap on resident zones.
 *
 * Not a tuning knob - it is the memory bound, and it has to be at least the
 * largest set the release radius can hold, or the cap would evict a zone the
 * release rule still wants and the two would fight over the same zone every
 * frame. Swept over every player position on the map at 2.5 m: 37 zones
 * within the build radius, 54 within the release radius. 58 is the larger of
 * those with headroom, and the test re-runs the sweep rather than trusting it.
 *
 * 58 zones x 6,480 instances (720 clumps x the 9-blade maximum) x 76 bytes is
 * a 27.2 MB worst case; at the measured 4,921 instances per zone a full
 * resident set is 20.7 MB and the steady state is nearer 16 MB, against
 * 115.6 MB before.
 */
export const GRASS_ZONE_BUDGET = 58;

/** Bytes of `instanceMatrix` (16 floats) plus `instanceColor` (3) per blade. */
export const GRASS_BYTES_PER_INSTANCE = 16 * 4 + 3 * 4;

/**
 * Squared-free rect distance from a point to an axis-aligned cell.
 * Zero inside the cell.
 */
export function cellDistance(x, z, x0, z0, span) {
  const dx = x < x0 ? x0 - x : x > x0 + span ? x - (x0 + span) : 0;
  const dz = z < z0 ? z0 - z : z > z0 + span ? z - (z0 + span) : 0;
  return dx === 0 ? dz : dz === 0 ? dx : Math.sqrt(dx * dx + dz * dz);
}

/**
 * The residency policy: a pure function of the player's XZ position and the
 * set currently held.
 *
 * XZ only, deliberately. The real visibility test is a 3D sphere distance and
 * this is a 2D footprint distance, which is always the SMALLER of the two - so
 * every error this makes is in the direction of building a zone slightly
 * early. A policy that can only be early is one that cannot leave a hole.
 */
export class GrassResidency {
  /**
   * @param {{zones:number, zoneMetres:number, half:number,
   *          build?:number, release?:number, budget?:number}} p
   */
  constructor({
    zones, zoneMetres, half,
    build = GRASS_BUILD_DISTANCE,
    release = GRASS_RELEASE_DISTANCE,
    budget = GRASS_ZONE_BUDGET,
  }) {
    if (release <= build) throw new Error('[GrassResidency] release must exceed build');
    this.zones = zones;
    this.span = zoneMetres;
    this.half = half;
    this.build = build;
    this.release = release;
    this.budget = budget;
    /** Zone key -> anything the owner wants to hang off it. */
    this.resident = new Map();
    /* Scratch, reused every tick. `decide` runs from `update`, so nothing here
     * may allocate per frame. */
    this._wanted = [];
    this._drop = [];
  }

  /** Stable key for a zone. Row-major, so it doubles as an array index. */
  key(zx, zz) { return zz * this.zones + zx; }
  zoneX(key) { return key % this.zones; }
  zoneZ(key) { return (key / this.zones) | 0; }
  /** World-space south-west corner of a zone. */
  originX(zx) { return -this.half + zx * this.span; }
  originZ(zz) { return -this.half + zz * this.span; }

  /** Footprint distance from a point to a zone, metres. */
  distance(key, x, z) {
    return cellDistance(x, z, this.originX(this.zoneX(key)), this.originZ(this.zoneZ(key)), this.span);
  }

  /**
   * What to build and what to free for a player at (x, z).
   *
   * `build` is ordered nearest-first and capped at `limit`, so a caller that
   * amortises one zone per frame always spends that frame on the zone the
   * player is closest to - which is the one that will show a hole first.
   *
   * @returns {{build: number[], free: number[]}} arrays reused between calls
   */
  decide(x, z, limit = 1) {
    const build = this._wanted;
    const free = this._drop;
    build.length = 0;
    free.length = 0;

    for (const key of this.resident.keys()) {
      if (this.distance(key, x, z) > this.release) free.push(key);
    }
    /* Only scan the band of zones the build radius can possibly reach. At 50 m
     * cells and 130 m that is 7x7 of the 18x18 grid, so this is 49 distance
     * tests a frame rather than 324. */
    const reach = Math.ceil(this.build / this.span) + 1;
    const px = Math.floor((x + this.half) / this.span);
    const pz = Math.floor((z + this.half) / this.span);
    const room = this.budget - (this.resident.size - free.length);
    if (room > 0) {
      for (let zz = Math.max(0, pz - reach); zz <= Math.min(this.zones - 1, pz + reach); zz++) {
        for (let zx = Math.max(0, px - reach); zx <= Math.min(this.zones - 1, px + reach); zx++) {
          const key = this.key(zx, zz);
          if (this.resident.has(key)) continue;
          const d = this.distance(key, x, z);
          if (d <= this.build) build.push(key);
        }
      }
      build.sort((a, b) => this.distance(a, x, z) - this.distance(b, x, z));
      if (build.length > room) build.length = room;
      if (build.length > limit) build.length = limit;
    } else {
      build.length = 0;
    }
    return { build, free };
  }

  /** The zones a player at (x, z) should already have, nearest first. */
  initial(x, z) {
    const out = [];
    for (let zz = 0; zz < this.zones; zz++) {
      for (let zx = 0; zx < this.zones; zx++) {
        const key = this.key(zx, zz);
        if (this.distance(key, x, z) <= this.build) out.push(key);
      }
    }
    out.sort((a, b) => this.distance(a, x, z) - this.distance(b, x, z));
    if (out.length > this.budget) out.length = this.budget;
    return out;
  }
}
