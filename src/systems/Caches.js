import * as THREE from 'three';
import { COLLISION_LAYER } from '../physics/Physics.js';
import { allows } from '../worlds/WorldRules.js';

/**
 * World caches: the reason to dive, and the reason to fly.
 *
 * ── Why this exists ───────────────────────────────────────────────────────
 * The game had three worlds, a swimming system with an oxygen timer, a dragon,
 * a hoverboard and a car - and nothing anywhere that rewarded using any of
 * them. Water was somewhere you fell in by accident; the mounts were a novelty
 * you summoned once; and once a world's hostiles were cleared there was no
 * reason to walk back through its portal. All three are the same missing
 * thing: a payoff attached to a *place*.
 *
 * A cache is that payoff. Each world gets a handful, placed by terrain query
 * rather than by hand so they survive world regeneration, and each sits
 * somewhere that costs the player something to reach:
 *
 *   - **Sunken** caches lie on the bed under at least {@link MIN_DIVE} metres of
 *     water, so collecting one means a real dive against `Swim`'s oxygen timer.
 *   - **High** caches sit on roofs and ledges with a long drop all round, which
 *     is a dragon or hoverboard trip - or a careful climb.
 *
 * They restock on a timer, which is what turns a cleared world into somewhere
 * worth coming back to.
 *
 * ── How it is built ───────────────────────────────────────────────────────
 * Deliberately thin. The pickup, its mesh, the `E` prompt and the collection
 * path are all `Loot`'s, which already does exactly this job well; this class
 * only decides *where* and *when*, and asks Loot for a `persistent` pickup.
 * That is why there is no geometry in this file.
 *
 * Placement is seeded from the world id, so a given world always produces the
 * same set - a player can learn where the moat cache is and go back for it -
 * while nothing has to be authored per world.
 */

/** Minimum water depth for a sunken cache. Deep enough to need a real dive. */
const MIN_DIVE = 1.6;
/** Minimum drop around a ledge before it counts as a "high" site. */
const MIN_HIGH_DROP = 7;
/** How far around a candidate ledge to sample for that drop. */
const HIGH_PROBE_R = 9;
/** Inner ring: the cache has to be standing on something level, not a slope. */
const INNER_R = 3;
/**
 * Minimum separation between two high caches.
 *
 * Was the literal `30` inside `_findHigh`'s dart loop. It is a constant now
 * because the AUTHORED channel has to apply the same rule - two caches thirty
 * metres apart is a find and a bonus, and two caches four metres apart is one
 * find that pays twice.
 */
const HIGH_APART = 30;
/** Keep clear of the invisible boundary colliders that fence each world. */
const EDGE_INSET = 24;
/**
 * Seconds before a collected cache restocks.
 *
 * Exported because it is now a REAL interval rather than a session one, and the
 * cases in `retention.test.mjs` have to wind a clock past it. Until the
 * retention drop this number was decoration: `_onWorld` cleared the site list
 * and re-stocked from scratch, so the actual restock interval was however long
 * it takes to walk through a gateway twice. See `_emptied` below.
 */
export const RESTOCK_SECONDS = 210;
const RESTOCK = RESTOCK_SECONDS;

/**
 * A cache site's identity: where it is, not where it came in the list.
 *
 * ── Why this is not an index ───────────────────────────────────────────────
 *
 * `Relics.serialize` once wrote `{ found: { citadel: 17 } }`, and a reload
 * marked the first seventeen sites in publication order - the tally right and
 * every marked thing wrong. The same trap is open here and it is not hypothetical:
 * placement is seeded, but it is also PROBED against live physics. `_findHigh`
 * darts at a content box whose extent depends on what the world built, and
 * `_highAt` refuses candidates against real colliders. Build a terrace beside a
 * ledge and the dart budget spends differently from that point on, so the site
 * that was index 4 is index 3 - and an index-keyed restock ledger would leave
 * the wrong cache empty.
 *
 * Rounded to whole metres on purpose. A site is a PLACE, and two placements a
 * few centimetres apart because a float came out differently are the same place.
 *
 * @param {string} worldId
 * @param {string} kind 'sunken' or 'high'
 * @param {number} x
 * @param {number} z
 * @returns {string}
 */
export function cacheSiteId(worldId, kind, x, z) {
  return `${worldId}/${kind}/${Math.round(x)}_${Math.round(z)}`;
}
/** Caches per world, per kind. Small - they should feel like a find. */
const PER_WORLD = { sunken: 3, high: 3 };
/** Placement attempts per cache before giving up on that slot. */
const TRIES = 120;

/* Scratch. One set per method - see the note in physics/Physics.js. */
const _pl = new THREE.Vector3();
const _hi = new THREE.Vector3();
const _dn = new THREE.Vector3(0, -1, 0);
const _box = new THREE.Box3();
const _m4 = new THREE.Matrix4();
const _sph = new THREE.Sphere();

/**
 * XZ cell size for the render-tree index {@link Caches#_indexVisible} builds.
 *
 * Twenty-four metres because the query it serves is a vertical line: the cell
 * only has to be small enough that a district's worth of geometry does not all
 * land in one bucket, and large enough that a building does not get filed under
 * a hundred of them. It is not a collision grid and nothing depends on it
 * matching `Physics`'s.
 */
const VIS_CELL = 24;
/** Multiplier that packs a signed (cx, cz) pair into one integer key. */
const VIS_STRIDE = 100003;
/**
 * A leaf spanning more cells than this is kept whole in the `wide` list and
 * tested with its exact box instead of being written into every cell it covers.
 *
 * A merged district plate genuinely does span hundreds of cells; filing it in
 * all of them costs more to build than the box test costs to run, and the box
 * test is exact where the cell is only a bucket.
 */
const VIS_MAX_CELLS = 64;

/**
 * A leaf's world-space bounding box, or null when it cannot be trusted.
 *
 * Null is not a failure: the caller keeps those in a list that is raycast on
 * every query, so an untrustworthy box costs time and never costs correctness.
 *
 * @param {THREE.Object3D} o
 * @returns {THREE.Box3|null} `_box`, reused - copy it before the next call.
 */
function leafBox(o) {
  /* A skinned mesh is posed on the GPU; its geometry box is the bind pose and
   * says nothing about where the thing actually is. */
  if (o.isSkinnedMesh) return null;
  /* Instanced and batched meshes keep their own box across all instances -
   * `geometry.boundingBox` would be one instance's and would be wrong. */
  if (o.isInstancedMesh || o.isBatchedMesh) {
    if (!o.boundingBox) o.computeBoundingBox?.();
    if (!o.boundingBox) return null;
    return _box.copy(o.boundingBox).applyMatrix4(o.matrixWorld);
  }
  const g = o.geometry;
  if (!g) return null;
  if (!g.boundingBox) g.computeBoundingBox?.();
  if (!g.boundingBox) return null;
  return _box.copy(g.boundingBox).applyMatrix4(o.matrixWorld);
}

/**
 * What a cache holds, by world. Deliberately richer than a corpse drop: a
 * cache is a destination, and a destination that pays out like a dead guard is
 * not worth the swim.
 */
const CACHE_TABLES = {
  station: [
    { id: 'alloy_scrap', min: 3, max: 7 },
    { id: 'nexus_shard', min: 1, max: 2 },
    { id: 'bullet', min: 40, max: 80 },
    { id: 'medkit', min: 1, max: 2 },
  ],
  medieval: [
    { id: 'relic_coin', min: 3, max: 8 },
    { id: 'nexus_shard', min: 1, max: 2 },
    { id: 'arrow', min: 15, max: 30 },
    { id: 'medkit', min: 1, max: 2 },
  ],
  citadel: [
    { id: 'relic_coin', min: 4, max: 10 },
    { id: 'nexus_shard', min: 1, max: 2 },
    { id: 'arrow', min: 18, max: 34 },
    { id: 'medkit', min: 1, max: 2 },
  ],
  sports: [
    { id: 'medkit', min: 2, max: 3 },
    { id: 'nexus_shard', min: 1, max: 2 },
    { id: 'alloy_scrap', min: 2, max: 5 },
    { id: 'bullet', min: 30, max: 60 },
  ],
  /* Lodestar Yard. With `hostiles: false` this is the ONLY source of the
   * yard's own goods that is not a shop, so it carries more of the load here
   * than in any other world: the trench and the gantry are the two obvious
   * homes (`PER_WORLD` places three sunken and three high), and a cache is a
   * destination that has to pay out better than a body would. Same four lines
   * as `DROP_TABLES.dock` minus the shard and the coil - a cache is a
   * forgotten stores box, not a stripped drive. */
  dock: [
    { id: 'alloy_scrap', min: 4, max: 9 },
    { id: 'hull_plate', min: 2, max: 4 },
    { id: 'laser_cell', min: 20, max: 50 },
    { id: 'medkit', min: 1, max: 2 },
  ],
  /* Vellum Ridge. This row was missing entirely, and `_roll` falls back to the
   * station table without saying so - so the circuit's caches paid out station
   * bullets, station alloy and station shards, in a world whose whole subject
   * is cars. Nothing errored and nothing looked wrong; the loot was simply from
   * somewhere else.
   *
   * A racing world's forgotten stores box holds what a garage holds. Tyre
   * compound reads as `alloy_scrap` (the salvage line every world shares) and
   * the rest is what a car needs: fuel for the boost, a medkit for the driver.
   * Bullets stay, in smaller number than the station's - there are hostiles
   * here, but shooting is not what anyone came for. */
  race: [
    { id: 'alloy_scrap', min: 3, max: 8 },
    { id: 'nexus_shard', min: 1, max: 2 },
    { id: 'bullet', min: 20, max: 45 },
    { id: 'medkit', min: 1, max: 2 },
  ],
};

/** Deterministic PRNG so a world's caches land in the same places every time. */
function mulberry(seed) {
  let s = seed >>> 0 || 1;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function hashString(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

export class Caches {
  /**
   * @param {{bus:any, physics:any, player:any, loot:any, worldManager:any,
   *          waterVolumes:any}} ctx
   */
  constructor({ bus, physics, player, loot, worldManager, waterVolumes, now } = {}) {
    this.bus = bus ?? null;
    this.physics = physics ?? null;
    this.player = player ?? null;
    this.loot = loot ?? null;
    this.worldManager = worldManager ?? null;
    this.water = waterVolumes ?? null;
    /**
     * Wall clock, injectable.
     *
     * A cache is a feature of the map, so a player who comes back tomorrow
     * should find it stocked - which a play-time counter cannot express. The
     * usual objection to a wall clock is that a browser's date can be moved,
     * and here it buys nothing: winding the clock forward restocks caches,
     * which is exactly what waiting 210 seconds already does for free.
     * @type {() => number}
     */
    this.now = typeof now === 'function' ? now : () => Date.now();

    /** @type {Array<{id:string, kind:string, pos:THREE.Vector3, pickup:object|null, restock:number}>} */
    this.sites = [];
    this._worldId = null;

    /**
     * Site id -> the epoch millisecond it is allowed to restock.
     *
     * ── The faucet this closes ────────────────────────────────────────────
     *
     * `_onWorld` clears `this.sites` and stocks every site from scratch, and
     * before this map existed that was the whole story: step through a gateway
     * and back and every cache in the world you left was full again. The
     * restock timer was decoration and the real interval was two portal
     * transits - an unbounded item faucet, in a game whose economy was measured
     * at 22 credit sources against 5 sinks, and cache loot converts to credits
     * at any market under the already-mapped `market` reason.
     *
     * Keyed by {@link cacheSiteId}, so it survives a world change, a reload and
     * a placement that came out in a different order. Entries whose deadline
     * has passed are dropped on entry and on load, so the map is bounded by the
     * restock window rather than by lifetime play.
     *
     * @type {Map<string, number>}
     */
    this._emptied = new Map();

    /**
     * The render-tree index `_hasVisibleFloor` queries, or null.
     *
     * Non-null only for the duration of one `_onWorld` call - see the note
     * where it is built. Null here so the field exists on a fresh instance and
     * the probe's "no index, walk the tree" branch is the default rather than
     * something that only happens after a crossing has torn one down.
     * @type {{cells:Map<number,number[]>, always:Array<THREE.Object3D>,
     *   leaves:Array<THREE.Object3D>, yMin:number[], yMax:number[]}|null}
     */
    this._vis = null;
    /** @type {Array<THREE.Object3D>|null} */
    this._visOut = null;

    /** @type {Array<() => void>} */
    this._offs = [];
    if (this.bus) {
      this._offs.push(this.bus.on('world:changed', ({ id, world }) => this._onWorld(id, world)));
      // Loot clears its pickups on a world change and again when one is taken;
      // either way the site has to know its pickup is gone so it can restock.
      this._offs.push(this.bus.on('loot:collected', (e) => this._onCollected(e)));
    }
  }

  /** Live sites in the active world. @returns {Array<object>} */
  get all() {
    return this.sites;
  }

  /**
   * Sites for the minimap and HUD: world position plus whether it is currently
   * stocked, which is all a marker needs to know.
   */
  get markers() {
    const out = [];
    for (const s of this.sites) {
      out.push({ kind: s.kind, position: s.pos, stocked: !!s.pickup, restockIn: s.restock });
    }
    return out;
  }

  /* ------------------------------------------------------------------ */
  /* Placement                                                           */
  /* ------------------------------------------------------------------ */

  _onWorld(id, world) {
    this._worldId = id ?? null;
    this.sites.length = 0;
    // No caches to dive for in a hedge maze.
    if (!allows(world, 'caches')) return;
    if (!world || !this.physics || !this.loot) return;

    const rnd = mulberry(hashString(`cache:${id}`));
    /* `contentBounds` where a world draws a line between its playfield and the
     * part of it that has anything in it; `bounds` otherwise. See the same read
     * in `Relics._onWorld`, which owns the reasoning. */
    const b = world.contentBounds ?? world.bounds;
    const minX = b?.min?.x ?? -180;
    const maxX = b?.max?.x ?? 180;
    const minZ = b?.min?.z ?? -180;
    const maxZ = b?.max?.z ?? 180;

    /* High caches scale with the map; sunken ones do not.
     *
     * A high cache is a destination on the skyline, and how many a world wants
     * is a function of how much skyline it has. Three over a 400 m valley is a
     * find; three over the station's 1,488 m dome is three places a player will
     * never happen across, thirty metres apart from each other by luck.
     *
     * Sunken caches stay fixed because they are not bounded by the map at all -
     * `_findSunken` samples the water volumes, and a world either has water to
     * dive in or it does not. The station has none, which is why its cache
     * count has always been "up to three" rather than six.
     */
    const extent = Math.max(maxX - minX, maxZ - minZ, 1);
    const highWanted = Math.min(12, Math.max(PER_WORLD.high, Math.round(PER_WORLD.high * (extent / 400) ** 1.5)));

    for (let i = 0; i < PER_WORLD.sunken; i++) {
      const p = this._findSunken(rnd, minX, maxX, minZ, maxZ);
      if (p) this.sites.push(this._site('sunken', p));
    }
    /* ---- AUTHORED HIGH SITES FIRST, AND WHY THIS CHANNEL EXISTS -------
     *
     * Two separate defects converged on one answer, so they share one channel.
     *
     * THE FIRST IS AREA. `_findHigh` is a UNIFORM DART at the content box, and
     * a uniform dart spends its budget in proportion to AREA, not to content.
     * That was a fair trade while the box and the town were the same 400 m. The
     * citadel's outer ring broke it in the only way that never shows up in a
     * log: the box went to 805 m and the nine caches the area law asks for came
     * out SEVEN on the old mesa and TWO on the aqueduct, with the Undercliff,
     * the Deepworks, Ashfall, the Eyrie and the Caravanserai holding NONE -
     * five authored regions, hundreds of decks, and not one reason to go and
     * stand on any of them. The log said "0 sunken, 9 high" and every one of
     * the nine was real.
     *
     * THE SECOND IS A ROOF. The dart starts above the map and takes the first
     * thing it hits, which under a shed is always the shed. Measured in
     * Lodestar Yard, whose hangar is a flat 172 x 162 m plate at y 26: 400 of
     * 400 darts landed on it at 26.80, all eight ring probes came back on the
     * same continuous plate so `sheer` was 0 every time, and the world placed
     * ZERO caches - silently, because the log line below only prints when
     * something landed. That took the only in-world source of three of that
     * world's items with it, and with them quest 54 step 1.
     *
     * The answer to both is the one `Relics` already uses: let the world
     * nominate places, because a world knows where its high places are and a
     * dart does not.
     *
     * WHAT IS NOT COPIED FROM `Relics` IS BLANKET TRUST, and the split is
     * exactly the roof. A nomination that gives only `x, z` is a HINT ABOUT
     * WHERE TO LOOK: it goes through {@link Caches#_highAt}, the same predicate
     * the dart has to satisfy, against the same real colliders, and a site that
     * stopped being prominent because somebody built a terrace beside it is
     * REFUSED and logged. A nomination that also carries a finite `y` is a
     * DECISION: the world is naming a deck under its own roof, where the probe
     * cannot see and has already been measured returning the roof instead, so
     * the probe is skipped and the height is taken as authored. The one rule
     * that holds either way is separation, because three "finds" thirty metres
     * apart are one find.
     */
    /* COUNTED IN HIGH SITES, NOT IN ALL SITES, and the difference is the bug.
     *
     * The guard was `this.sites.length >= PER_WORLD.sunken + highWanted`, which
     * reserves three slots for sunken caches whether or not any were placed.
     * Citadel had no water when that was written: `_findSunken` placed 0 and
     * the world logged "0 sunken, 9 high" - it now has two oasis tanks, and
     * with `WaterVolumes` wired the same world logs "2 sunken, 9 high", so the
     * shortfall is one rather than three. The bug the guard had is unchanged by
     * that and so is its fix, because a world with no water at all is still the
     * common case: the authored channel was free to run to TWELVE high sites
     * against a `highWanted` of 9 - and because the dart loop below starts at
     * `fromAuthored`, it would then contribute nothing and `placement.darted`
     * would read 0 while `placed` quietly exceeded `want`. */
    let high = 0;
    let fromAuthored = 0;
    /* THE RENDER-TREE INDEX, AND ITS LIFETIME.
     *
     * Every high candidate below - authored or darted - ends in
     * `_hasVisibleFloor`, which raycasts the render tree. Unindexed that was
     * 86 ms a call and 75% of a station crossing; see the block comment on
     * `_indexVisible`. The index is built here, against the same group the
     * probe raycasts, and dropped in the `finally` below.
     *
     * It exists for the length of this method and no longer, ON PURPOSE. A
     * placement index that survived a crossing would be a cache of where the
     * floor used to be, and a cache site placed against a floor that is no
     * longer there is a cache hanging in the sky - which the `[Caches]` log
     * line does not report, because it only prints when something landed. */
    const visGroup = this.worldManager?.active?.group ?? null;
    if (visGroup) this._indexVisible(visGroup);
    try {
      for (const raw of world.cacheSites ?? []) {
        if (high >= highWanted) break;
        const x = Number(raw?.x);
        const z = Number(raw?.z);
        if (!Number.isFinite(x) || !Number.isFinite(z)) continue;
        if (this._tooClose(x, z, HIGH_APART)) continue;
        const y = Number(raw?.y);
        if (Number.isFinite(y)) {
          /* Authored height: a deck under a roof. No probe - see above. */
          this.sites.push(this._site('high', new THREE.Vector3(x, y, z), true));
          high++;
          continue;
        }
        const hit = this._highAt(x, z);
        if (!hit || !hit.strict) {
          console.warn(`[Caches] "${id}": authored site ${raw?.label ?? `(${x}, ${z})`} refused`
            + ` - ${hit ? `sheer ${hit.sheer}/8, level ${hit.flat}/6` : 'no surface'}`);
          continue;
        }
        this.sites.push(this._site('high', hit.pos, true));
        high++;
      }
      fromAuthored = high;

      for (let i = fromAuthored; i < highWanted; i++) {
        const p = this._findHigh(rnd, minX, maxX, minZ, maxZ);
        if (p) this.sites.push(this._site('high', p));
      }
    } finally {
      this._vis = null;
      this._visOut = null;
    }

    /* Not `_stock` unconditionally. A site the player emptied within the last
     * RESTOCK seconds - in this session, in a previous one, or before the world
     * change they just made - stays empty and carries what is left of its own
     * countdown. That is the whole difference between a timer and a portal hop. */
    this._prune();
    for (const s of this.sites) this._restore(s);

    /**
     * Where the high sites came from. See the same field on `Relics`.
     * @type {{want:number, placed:number, authored:number, darted:number,
     *   nominated:number}}
     */
    this.placement = {
      want: highWanted,
      placed: this.sites.filter((s) => s.kind === 'high').length,
      authored: fromAuthored,
      darted: this.sites.filter((s) => s.kind === 'high').length - fromAuthored,
      nominated: (world.cacheSites ?? []).length,
    };

    if (this.sites.length) {
      const sunk = this.sites.filter((s) => s.kind === 'sunken').length;
      console.info(
        `[Caches] "${id}": ${sunk} sunken, ${this.sites.length - sunk} high`
        + ` (${fromAuthored} authored, ${this.placement.darted} darted)`
      );
    }
    this.bus?.emit('caches:changed', { worldId: id, sites: this.markers });
  }

  /**
   * A spot on the bed under real water.
   *
   * Sampled from the water volumes rather than from the map at large: the
   * medieval river is a 22 m ribbon across a 400 m world, so random darts at
   * the whole playfield would almost never land in it.
   */
  _findSunken(rnd) {
    const vols = this.water?.volumes;
    if (!vols?.length) return null;
    for (let t = 0; t < TRIES; t++) {
      const v = vols[Math.floor(rnd() * vols.length)];
      if (!v?.box) continue;
      const x = v.box.min.x + rnd() * (v.box.max.x - v.box.min.x);
      const z = v.box.min.z + rnd() * (v.box.max.z - v.box.min.z);
      const surface = this.water.surfaceYAt(x, z);
      if (surface === null) continue;
      const bed = this.physics.groundHeight(x, z, surface + 1.0, 40);
      if (bed === null) continue;
      const depth = surface - bed;
      if (depth < MIN_DIVE) continue;
      // Keep them apart, or three "finds" end up in the same pool.
      if (this._tooClose(x, z, 22)) continue;
      return new THREE.Vector3(x, bed + 0.25, z);
    }
    return null;
  }

  /**
   * A ledge or roof with a long drop all round.
   *
   * The test is deliberately about the *surroundings*, not about absolute
   * height: a point 40 m up a hillside is not a destination, but a 9 m roof in
   * the middle of a village is. Eight probes on a ring is enough to reject
   * anything you could simply walk onto, and cheap enough to run a few hundred
   * times during a world change.
   */
  _findHigh(rnd, minX, maxX, minZ, maxZ) {
    /* Best-effort fallback.
     *
     * The strict test wants a level platform with a sheer drop, which is a
     * station gantry or a flat roof. The medieval world has neither: its roofs
     * are pitched thatch and its ramparts are narrower than the inner ring, so
     * a strict-only search returned nothing at all there and the world silently
     * lost half its caches. Anything that clears the drop test is remembered,
     * and the highest one is used if nothing better turns up. */
    let fallback = null;
    let fallbackScore = -Infinity;

    /* Inset from the world edge.
     *
     * These worlds are fenced with invisible boundary colliders, and the very
     * first version of this search happily put every medieval cache on top of
     * one: `groundHeight` reported a perfectly good surface 60 m up at x=197,
     * with no renderable geometry anywhere near it. A cache floating in the
     * sky over the map edge is the worst kind of bug - it looks deliberate. */
    const inset = EDGE_INSET;
    const lx = minX + inset;
    const hx = maxX - inset;
    const lz = minZ + inset;
    const hz = maxZ - inset;

    for (let t = 0; t < TRIES; t++) {
      const x = lx + rnd() * (hx - lx);
      const z = lz + rnd() * (hz - lz);
      if (this._tooClose(x, z, HIGH_APART)) continue;
      const hit = this._highAt(x, z);
      if (!hit) continue;

      // Remember it even if the platform test failed: a pitched roof with a
      // 10 m drop on every side is still somewhere you have to fly to.
      const score = hit.pos.y + hit.sheer;
      if (score > fallbackScore) {
        fallbackScore = score;
        fallback = hit.pos;
      }
      if (hit.strict) return hit.pos;
    }
    return fallback;
  }

  /**
   * Is (x, z) a ledge or roof with a long drop all round?
   *
   * Lifted out of `_findHigh` verbatim so the AUTHORED channel in `_onWorld`
   * runs the identical test rather than a second copy of it. Two predicates
   * that are supposed to agree about what a high place is, and do not, is how
   * a nominated site gets placed inside a wall while the dart loop three lines
   * below would have refused the same point.
   *
   * Two rings, and both tests matter:
   *
   * A single "is there a long drop all round" ring rejected every roof in the
   * game, because a castle roof is wider than the ring - all eight probes land
   * back on the same roof and report no drop at all. On its own it would also
   * happily accept the top of a grassy hill, which the player can walk up.
   *
   * So: the inner ring must come back LEVEL (this is a platform, not a slope)
   * and the outer ring must mostly fall away. That pair is the signature of a
   * roof, a gantry or a ledge, and nothing else.
   *
   * @param {number} x
   * @param {number} z
   * @returns {{pos:THREE.Vector3, sheer:number, flat:number, strict:boolean}|null}
   *   null when there is no standable, visible, dry surface there at all;
   *   `strict` false for a surface that drops away but is not level on top.
   */
  _highAt(x, z) {
    _pl.set(x, 320, z);
    const hit = this.physics.raycast(_pl, _dn, 640, COLLISION_LAYER.WORLD);
    if (!hit) return null;
    // Has to be a surface you could stand on, not a wall or a spire.
    if (Math.abs(hit.normal?.y ?? 1) < 0.75) return null;
    const y = hit.point.y;
    // Underwater ledges are the other cache type's job.
    const surface = this.water?.surfaceYAt?.(x, z);
    if (surface !== null && surface !== undefined && surface > y) return null;

    let sheer = 0;
    for (let i = 0; i < 8; i++) {
      const a = (i / 8) * Math.PI * 2;
      const rx = x + Math.cos(a) * HIGH_PROBE_R;
      const rz = z + Math.sin(a) * HIGH_PROBE_R;
      const ry = this.physics.groundHeight(rx, rz, y + 2, 220);
      // A probe that finds nothing at all is open air - the best drop there is.
      if (ry === null || y - ry >= MIN_HIGH_DROP) sheer++;
    }
    if (sheer < 5) return null;
    /* Physics is not enough on its own: a boundary collider is a real surface
     * with nothing to stand on. Only run this on candidates that already
     * passed - it walks the render tree, which is far too costly per dart. */
    if (!this._hasVisibleFloor(x, y, z)) return null;

    let flat = 0;
    for (let i = 0; i < 6; i++) {
      const a = (i / 6) * Math.PI * 2;
      const iy = this.physics.groundHeight(x + Math.cos(a) * INNER_R, z + Math.sin(a) * INNER_R, y + 2, 8);
      if (iy !== null && Math.abs(iy - y) < 1.5) flat++;
    }
    return { pos: new THREE.Vector3(x, y + 0.2, z), sheer, flat, strict: flat >= 5 };
  }

  /**
   * Is there something the player can actually *see* to stand on at (x, y, z)?
   *
   * The collision world contains invisible boundary geometry, and `groundHeight`
   * cannot tell it from a roof. This casts against the render tree instead and
   * insists on a mesh within a metre of where physics claimed the floor was.
   *
   * @param {number} x
   * @param {number} y surface height physics reported
   * @param {number} z
   * @returns {boolean}
   */
  _hasVisibleFloor(x, y, z) {
    const group = this.worldManager?.active?.group;
    if (!group) return true;
    if (!this._ray) this._ray = new THREE.Raycaster();
    this._ray.set(_hi.set(x, y + 3, z), _dn);
    this._ray.near = 0;
    this._ray.far = 8;
    /* No index means this is a direct call from outside a world change - the
     * citadel region tests do exactly that. Answer it the whole-tree way rather
     * than build and throw away an index for one query. */
    const hits = this._vis
      ? this._ray.intersectObjects(this._visibleNear(x, y + 3, y - 5, z), false)
      : this._ray.intersectObject(group, true);
    for (const h of hits) {
      if (Math.abs(h.point.y - y) < 1.0) return true;
    }
    return false;
  }

  /**
   * Bucket every raycastable leaf under `group` by the XZ cells its world-space
   * box covers, so {@link Caches#_hasVisibleFloor} can hand the raycaster a
   * handful of meshes instead of a world.
   *
   * ── Why the whole-tree raycast was costing 86 ms a call ────────────────────
   *
   * `THREE.Mesh.raycast` rejects on the world-space bounding SPHERE, then
   * transforms the ray into local space and rejects on the geometry's bounding
   * BOX - with `Ray.intersectsBox`, which tests the INFINITE ray. `far` is
   * applied afterwards, per candidate triangle. So an eight-metre probe
   * straight down is matched against every mesh the downward line passes at any
   * height whatsoever, and this game batches its geometry by district: "any
   * height whatsoever" means a district's triangles walked for a probe eight
   * metres tall. Eleven of those calls were 952 ms of a 1,278 ms crossing.
   * @see docs/superpowers/specs/2026-08-24-crossing-cost-ledger.md
   *
   * ── Why narrowing cannot change the answer ─────────────────────────────────
   *
   * An intersection lies inside the world-space box of the thing it intersected,
   * and every hit this function can accept lies on an eight-metre segment. A
   * leaf whose box misses that segment therefore cannot produce a hit that was
   * being accepted before. The world box of a rotated local box is LARGER than
   * the rotated box, so the filter errs toward keeping candidates, never toward
   * dropping them.
   *
   * ── Why there is no version of this that goes stale ────────────────────────
   *
   * It is built at the top of one `_onWorld` call and dropped in that call's
   * `finally`. It never survives a crossing, so it cannot describe a world the
   * player is no longer in.
   *
   * Deliberately NOT filtered by `.visible`, despite the name of its caller:
   * `THREE.Raycaster` does not test `visible` either, so a hidden mesh has
   * always counted as a floor here. Excluding them would silently delete cache
   * sites from any world that hides its dressing, which is a placement change
   * wearing a performance change's clothes.
   *
   * @param {THREE.Object3D} group
   */
  _indexVisible(group) {
    /** Every raycastable leaf, once. Entries and `seen` are indexed by this. */
    const leaves = [];
    /** Leaf index by object, so an instanced mesh files many entries as one. */
    const indexOf = new Map();
    /** Cell key -> entry indices. */
    const cells = new Map();
    /** Entries: which leaf, and the height band it covers in its cells. */
    const entLeaf = [];
    const entMinY = [];
    const entMaxY = [];
    /** Boxes too wide to bucket, kept whole and tested exactly. */
    const wide = [];
    /** Leaves with no bound that can be trusted: candidates for every query. */
    const always = [];
    const base = THREE.Object3D.prototype.raycast;
    /** Diagnostics, read by scripts/frame-gaps.mjs. Cheap and worth having. */
    const stats = { instanced: 0, instances: 0, collapsed: 0, wideFromInstances: 0 };

    const leafIndex = (o) => {
      let li = indexOf.get(o);
      if (li === undefined) {
        li = leaves.length;
        leaves.push(o);
        indexOf.set(o, li);
      }
      return li;
    };

    /**
     * File one world-space box against a leaf.
     *
     * A box that would touch more cells than it is worth goes in `wide` with
     * its exact extents instead. That is not a fallback to "candidate
     * everywhere" - it is a tighter test than a cell bucket, just a linear one,
     * and keeping it exact is what stops one awkward mesh from undoing the
     * index for every probe.
     */
    const file = (li, minX, minY, minZ, maxX, maxY, maxZ) => {
      const cx0 = Math.floor(minX / VIS_CELL);
      const cx1 = Math.floor(maxX / VIS_CELL);
      const cz0 = Math.floor(minZ / VIS_CELL);
      const cz1 = Math.floor(maxZ / VIS_CELL);
      if (!Number.isFinite(cx0) || !Number.isFinite(cx1)
        || !Number.isFinite(cz0) || !Number.isFinite(cz1)) return false;
      if ((cx1 - cx0 + 1) * (cz1 - cz0 + 1) > VIS_MAX_CELLS) {
        wide.push({ li, minX, maxX, minZ, maxZ, minY, maxY });
        return true;
      }
      const e = entLeaf.length;
      entLeaf.push(li);
      entMinY.push(minY);
      entMaxY.push(maxY);
      for (let cx = cx0; cx <= cx1; cx++) {
        for (let cz = cz0; cz <= cz1; cz++) {
          const key = cx * VIS_STRIDE + cz;
          let list = cells.get(key);
          if (!list) cells.set(key, (list = []));
          list.push(e);
        }
      }
      return true;
    };

    group.traverse((o) => {
      /* Only things that answer a ray at all. `Object3D.raycast` is a no-op, so
       * an object that has not overridden it can never contribute a hit - and
       * no class in three, or in this repository, returns `false` from
       * `raycast` to stop the traversal, which is what makes flattening the
       * tree equivalent to walking it. */
      if (o.raycast === base) return;

      /* AN INSTANCED MESH IS A THOUSAND THINGS WEARING ONE BOX, AND THAT BOX IS
       * THE MAP.
       *
       * This is where the cost actually was, and it is not what the shape of
       * the code suggests. Measured on the live station, every probe was handed
       * 2,287,006 triangles and 1.9 million of them were the ambient crowd -
       * `StationActors:head` alone is 490,620 - because instanced body parts
       * scattered over a 1,488 m station each bound to a box that covers
       * everything. One box round a thousand people says nothing.
       *
       * So the INSTANCES are filed and not the object: a person-sized sphere
       * each, via `Sphere.applyMatrix4`, which scales the radius by the largest
       * axis scale and so stays conservative under any transform. The object
       * becomes a candidate only where one of its instances actually is. */
      if (o.isInstancedMesh && o.count > 0 && o.instanceMatrix) {
        const g = o.geometry;
        if (g && !g.boundingSphere) g.computeBoundingSphere?.();
        if (g?.boundingSphere) {
          const li = leafIndex(o);
          const arr = o.instanceMatrix.array;
          const n = Math.min(o.count, (arr.length / 16) | 0);
          for (let k = 0; k < n; k++) {
            _m4.fromArray(arr, k * 16).premultiply(o.matrixWorld);
            _sph.copy(g.boundingSphere).applyMatrix4(_m4);
            const r = _sph.radius;
            const c = _sph.center;
            /* A COLLAPSED INSTANCE, AND WHY SKIPPING IT IS NOT A SHORTCUT.
             *
             * `StationActors._hideActor` collapses a distance-culled figure
             * with an ALL-ZERO matrix - deliberately, because a degenerate
             * triangle is rejected at setup where an off-screen one is still
             * transformed and clipped. Its bottom-right element is zero too, so
             * `Vector3.applyMatrix4` divides by w = 0 and the sphere comes back
             * infinite. Most of the station's ~1,900 figures are collapsed at
             * any moment, and treating one such instance as "unboundable" put
             * the whole mesh back in `always` - which is precisely how the
             * first two attempts at this index moved nothing.
             *
             * Skipping it is exactly what three does. `InstancedMesh.raycast`
             * runs the same `Sphere.applyMatrix4` per instance and rejects on
             * `intersectsSphere`, which is false for any non-finite sphere, so
             * a collapsed instance cannot contribute a hit to begin with. */
            if (!Number.isFinite(r) || !Number.isFinite(c.x)
              || !Number.isFinite(c.y) || !Number.isFinite(c.z)) {
              stats.collapsed++;
              continue;
            }
            const before = wide.length;
            file(li, c.x - r, c.y - r, c.z - r, c.x + r, c.y + r, c.z + r);
            if (wide.length > before) stats.wideFromInstances++;
          }
          stats.instanced++;
          stats.instances += n;
          return;
        }
      }

      const b = leafBox(o);
      if (!b) { always.push(o); return; }
      if (!file(leafIndex(o), b.min.x, b.min.y, b.min.z, b.max.x, b.max.y, b.max.z)) {
        always.push(o);
      }
    });

    this._vis = {
      cells, always, wide, leaves, entLeaf, entMinY, entMaxY, stats,
      /* One slot per leaf, holding the id of the query that last took it. An
       * instanced leaf has an entry per instance and a wide one an entry per
       * awkward box, so a single query can reach the same object many times. */
      seen: new Int32Array(leaves.length),
      qid: 0,
    };
    /** Reused query buffer - see `_visibleNear`. */
    this._visOut = [];
  }

  /**
   * The leaves that could put a hit on the vertical segment at (x, z) between
   * `yLo` and `yHi`.
   *
   * The height test is what earns the index: a district's ground plate and the
   * roof forty metres above it share every cell and differ only in `y`.
   *
   * @param {number} x @param {number} yHi @param {number} yLo @param {number} z
   * @returns {THREE.Object3D[]} reused between calls - do not retain it.
   */
  _visibleNear(x, yHi, yLo, z) {
    const v = this._vis;
    const out = this._visOut;
    out.length = 0;
    const qid = ++v.qid;
    for (const o of v.always) out.push(o);
    for (const w of v.wide) {
      if (x < w.minX || x > w.maxX || z < w.minZ || z > w.maxZ) continue;
      if (w.minY > yHi || w.maxY < yLo) continue;
      if (v.seen[w.li] === qid) continue;
      v.seen[w.li] = qid;
      out.push(v.leaves[w.li]);
    }
    const list = v.cells.get(Math.floor(x / VIS_CELL) * VIS_STRIDE + Math.floor(z / VIS_CELL));
    if (list) {
      for (const e of list) {
        if (v.entMinY[e] > yHi || v.entMaxY[e] < yLo) continue;
        const li = v.entLeaf[e];
        if (v.seen[li] === qid) continue;
        v.seen[li] = qid;
        out.push(v.leaves[li]);
      }
    }
    return out;
  }

  _tooClose(x, z, r) {
    const r2 = r * r;
    for (const s of this.sites) {
      const dx = s.pos.x - x;
      const dz = s.pos.z - z;
      if (dx * dx + dz * dz < r2) return true;
    }
    return false;
  }

  /* ------------------------------------------------------------------ */
  /* Stock                                                               */
  /* ------------------------------------------------------------------ */

  _roll(rnd = Math.random) {
    /* The fallback used to be silent, which is how Vellum Ridge spent its whole
     * life paying out station loot without anyone noticing. A world that allows
     * caches and has no table is an authoring omission, so it says so once. */
    let table = CACHE_TABLES[this._worldId];
    if (!table) {
      if (!this._warnedNoTable) {
        this._warnedNoTable = true;
        console.warn(`[Caches] no CACHE_TABLES row for "${this._worldId}"`
          + ' - falling back to the station table. Add a row rather than leaving'
          + ' this world paying out another world\'s goods.');
      }
      table = CACHE_TABLES.station;
    }
    const out = [];
    // Two or three distinct lines, so no two caches read the same.
    const want = 2 + (rnd() < 0.5 ? 1 : 0);
    const pool = table.slice();
    for (let i = 0; i < want && pool.length; i++) {
      const pick = pool.splice(Math.floor(rnd() * pool.length), 1)[0];
      const qty = pick.min + Math.floor(rnd() * (pick.max - pick.min + 1));
      if (qty > 0) out.push({ itemId: pick.id, qty });
    }
    return out;
  }

  /**
   * One site, with its identity attached at birth.
   *
   * Every push in `_onWorld` goes through here so there is exactly one place
   * that decides what a site is called. Four call sites each formatting their
   * own key is four chances for one of them to disagree.
   *
   * @param {string} kind
   * @param {THREE.Vector3} pos
   * @param {boolean} [authored]
   */
  _site(kind, pos, authored = false) {
    return {
      id: cacheSiteId(this._worldId, kind, pos.x, pos.z),
      kind,
      pos,
      pickup: null,
      restock: 0,
      authored,
    };
  }

  /** Forget every deadline that has already passed. Keeps `_emptied` bounded. */
  _prune() {
    const now = this.now();
    for (const [id, at] of this._emptied) if (at <= now) this._emptied.delete(id);
  }

  /**
   * Stock a site on entry, unless the player emptied it recently enough that it
   * is still on its own clock.
   *
   * This is the line that turns the restock timer from decoration into a rule.
   * Before it, entering a world stocked everything, so the interval a player
   * actually experienced was two portal transits.
   */
  _restore(site) {
    const at = this._emptied.get(site.id);
    if (at === undefined) {
      this._stock(site);
      return;
    }
    const left = (at - this.now()) / 1000;
    if (left <= 0) {
      this._emptied.delete(site.id);
      this._stock(site);
      return;
    }
    /* Despawn, not merely forget. `_onWorld` builds fresh sites with no pickup,
     * so the only caller that can reach a STOCKED site here is `deserialize` -
     * a save restored while a world is live - and dropping the reference
     * without releasing it would leave a collectable cache standing in the
     * world with nothing tracking it. `despawn` is deliberately silent, so
     * nothing downstream reads it as a collection. */
    if (site.pickup) this.loot?.despawn?.(site.pickup);
    site.pickup = null;
    site.restock = left;
  }

  _stock(site) {
    if (!this.loot || site.pickup) return;
    const contents = this._roll();
    if (!contents.length) return;
    // `snap:false` because the position is already exactly where it should be -
    // a riverbed or a roof - and Loot's 6 m ground probe would drag a rooftop
    // cache down to the street.
    site.pickup = this.loot.spawn(site.pos, contents, {
      persistent: true,
      snap: false,
      tag: `cache:${site.kind}`,
    });
    site.restock = 0;
    this._emptied.delete(site.id);
  }

  /**
   * Mark a site empty, in the live list AND in the ledger that outlives it.
   *
   * Both writes belong together: `update` and `_onCollected` each used to do
   * only the first, which is precisely how the timer came to mean nothing.
   */
  _empty(site) {
    site.pickup = null;
    site.restock = RESTOCK;
    if (site.id) this._emptied.set(site.id, this.now() + RESTOCK * 1000);
  }

  _onCollected(e) {
    const p = e?.pickup ?? null;
    for (const s of this.sites) {
      if (s.pickup && (s.pickup === p || !s.pickup.active)) {
        this._empty(s);
        this.bus?.emit('caches:changed', { worldId: this._worldId, sites: this.markers });
      }
    }
  }

  /* ------------------------------------------------------------------ */
  /* Consignment - the retention loop's only material reward             */
  /* ------------------------------------------------------------------ */

  /**
   * Release one world's emptied caches so they restock at once.
   *
   * This is what a completed daily pays, and it is deliberately not credits:
   * the economy was measured at 22 sources against 5 sinks with a whole-game
   * faucet over 250,000 CR, and a daily that paid would deepen the hole the
   * mission design says is the problem. What it pays instead is a reason to go
   * back to a place - which is what a cache already is.
   *
   * @param {string} worldId
   * @returns {number} sites released, so a caller can say nothing when there
   *   was nothing to release
   */
  consign(worldId) {
    if (typeof worldId !== 'string' || !worldId) return 0;
    const prefix = `${worldId}/`;
    let n = 0;
    for (const id of [...this._emptied.keys()]) {
      if (id.startsWith(prefix)) { this._emptied.delete(id); n++; }
    }
    if (n && worldId === this._worldId) {
      for (const s of this.sites) if (!s.pickup) this._stock(s);
      this.bus?.emit('caches:changed', { worldId: this._worldId, sites: this.markers });
    }
    return n;
  }

  /* ------------------------------------------------------------------ */
  /* Persistence                                                         */
  /* ------------------------------------------------------------------ */

  /**
   * The restock ledger, keyed by site identity.
   *
   * Deliberately NOT the site list: placement is derived from the world and
   * rebuilds itself on entry, and a saved list of positions would be a second
   * copy of something a world already knows - the same reason `Charters` does
   * not sync its learned rosters.
   */
  serialize() {
    this._prune();
    const emptied = {};
    for (const [id, at] of this._emptied) emptied[id] = at;
    return { emptied };
  }

  /** REPLACE, not merge: a load has to be able to take a deadline away too. */
  deserialize(data) {
    if (!data || typeof data !== 'object') return false;
    this._emptied.clear();
    const rows = data.emptied;
    if (rows && typeof rows === 'object') {
      const now = this.now();
      for (const id of Object.keys(rows)) {
        const at = Number(rows[id]);
        if (!Number.isFinite(at) || at <= now) continue;
        this._emptied.set(id, at);
      }
    }
    for (const s of this.sites) this._restore(s);
    return true;
  }

  /**
   * Tick restock timers. Cheap enough to run every frame; there are six sites.
   * @param {number} dt
   */
  update(dt) {
    if (!this.sites.length) return;
    let changed = false;
    for (const s of this.sites) {
      if (s.pickup) {
        /* Loot may have released it without an event (world clear, recycle).
         *
         * This is a safety net and it must stay one, because it WRITES A
         * DEADLINE: a site emptied here is off the board for RESTOCK seconds
         * whether or not anybody collected it. Three things make it unreachable
         * in the shipped game, and they are worth writing down because two of
         * them are somebody else's file:
         *
         *   - a world change clears Loot FIRST (`Loot` subscribes at
         *     `main.js:303`, `Caches` at `:405`, and the bus fires in
         *     subscription order), and `_onWorld` then rebuilds the site list
         *     from scratch, so no stale pickup ever survives into this loop;
         *   - `_recycleOldest` refuses to evict a `persistent` pickup, which
         *     every cache is;
         *   - a real collection emits `loot:collected` and `_onCollected` has
         *     already nulled the reference before this runs.
         *
         * `retention.test.mjs` pins the first of those, because it is the one
         * that lives in another file and could be reordered by someone who has
         * no reason to look here. */
        if (!s.pickup.active) {
          this._empty(s);
          changed = true;
        }
        continue;
      }
      if (s.restock > 0) {
        s.restock -= dt;
        if (s.restock <= 0) {
          // Never restock a cache the player is standing on: it would pop into
          // existence in their face and read as a glitch rather than a respawn.
          if (this.player && this.player.position.distanceToSquared(s.pos) < 400) {
            s.restock = 8;
            continue;
          }
          this._stock(s);
          changed = true;
        }
      }
    }
    if (changed) this.bus?.emit('caches:changed', { worldId: this._worldId, sites: this.markers });
  }

  dispose() {
    for (const off of this._offs) off?.();
    this._offs.length = 0;
    this.sites.length = 0;
    this._emptied.clear();
  }
}

export default Caches;
