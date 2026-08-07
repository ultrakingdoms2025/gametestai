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
/** Keep clear of the invisible boundary colliders that fence each world. */
const EDGE_INSET = 24;
/** Seconds before a collected cache restocks. */
const RESTOCK = 210;
/** Caches per world, per kind. Small - they should feel like a find. */
const PER_WORLD = { sunken: 3, high: 3 };
/** Placement attempts per cache before giving up on that slot. */
const TRIES = 120;

/* Scratch. One set per method - see the note in physics/Physics.js. */
const _pl = new THREE.Vector3();
const _hi = new THREE.Vector3();
const _dn = new THREE.Vector3(0, -1, 0);

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
  constructor({ bus, physics, player, loot, worldManager, waterVolumes } = {}) {
    this.bus = bus ?? null;
    this.physics = physics ?? null;
    this.player = player ?? null;
    this.loot = loot ?? null;
    this.worldManager = worldManager ?? null;
    this.water = waterVolumes ?? null;

    /** @type {Array<{kind:string, pos:THREE.Vector3, pickup:object|null, restock:number}>} */
    this.sites = [];
    this._worldId = null;

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
    const b = world.bounds;
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
      if (p) this.sites.push({ kind: 'sunken', pos: p, pickup: null, restock: 0 });
    }
    for (let i = 0; i < highWanted; i++) {
      const p = this._findHigh(rnd, minX, maxX, minZ, maxZ);
      if (p) this.sites.push({ kind: 'high', pos: p, pickup: null, restock: 0 });
    }

    for (const s of this.sites) this._stock(s);

    if (this.sites.length) {
      const sunk = this.sites.filter((s) => s.kind === 'sunken').length;
      console.info(
        `[Caches] "${id}": ${sunk} sunken, ${this.sites.length - sunk} high`
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
      _pl.set(x, 320, z);
      const hit = this.physics.raycast(_pl, _dn, 640, COLLISION_LAYER.WORLD);
      if (!hit) continue;
      // Has to be a surface you could stand on, not a wall or a spire.
      if (Math.abs(hit.normal?.y ?? 1) < 0.75) continue;
      const y = hit.point.y;
      // Underwater ledges are the other cache type's job.
      const surface = this.water?.surfaceYAt?.(x, z);
      if (surface !== null && surface !== undefined && surface > y) continue;

      /* Two rings, and both tests matter.
       *
       * A single "is there a long drop all round" ring rejected every roof in
       * the game, because a castle roof is wider than the ring: all eight
       * probes land back on the same roof and report no drop at all. And on its
       * own it would happily accept the top of a grassy hill, which the player
       * can simply walk up.
       *
       * So: the inner ring must come back *level* - this is a platform, not a
       * slope - and the outer ring must mostly fall away. That pair is the
       * signature of a roof, a gantry or a ledge, and nothing else. */
      let sheer = 0;
      for (let i = 0; i < 8; i++) {
        const a = (i / 8) * Math.PI * 2;
        const rx = x + Math.cos(a) * HIGH_PROBE_R;
        const rz = z + Math.sin(a) * HIGH_PROBE_R;
        const ry = this.physics.groundHeight(rx, rz, y + 2, 220);
        // A probe that finds nothing at all is open air - the best drop there is.
        if (ry === null || y - ry >= MIN_HIGH_DROP) sheer++;
      }
      if (sheer < 5) continue;
      if (this._tooClose(x, z, 30)) continue;
      // Physics is not enough on its own: a boundary collider is a real surface
      // with nothing to stand on. Only run this on candidates that already
      // passed - it walks the render tree, which is far too costly per dart.
      if (!this._hasVisibleFloor(x, y, z)) continue;

      // Remember it even if the platform test fails below: a pitched roof with
      // a 10 m drop on every side is still somewhere you have to fly to.
      const score = y + sheer;
      if (score > fallbackScore) {
        fallbackScore = score;
        fallback = new THREE.Vector3(x, y + 0.2, z);
      }

      let flat = 0;
      for (let i = 0; i < 6; i++) {
        const a = (i / 6) * Math.PI * 2;
        const iy = this.physics.groundHeight(x + Math.cos(a) * INNER_R, z + Math.sin(a) * INNER_R, y + 2, 8);
        if (iy !== null && Math.abs(iy - y) < 1.5) flat++;
      }
      if (flat < 5) continue;

      return new THREE.Vector3(x, y + 0.2, z);
    }
    return fallback;
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
    const hits = this._ray.intersectObject(group, true);
    for (const h of hits) {
      if (Math.abs(h.point.y - y) < 1.0) return true;
    }
    return false;
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
    const table = CACHE_TABLES[this._worldId] ?? CACHE_TABLES.station;
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
  }

  _onCollected(e) {
    const p = e?.pickup ?? null;
    for (const s of this.sites) {
      if (s.pickup && (s.pickup === p || !s.pickup.active)) {
        s.pickup = null;
        s.restock = RESTOCK;
        this.bus?.emit('caches:changed', { worldId: this._worldId, sites: this.markers });
      }
    }
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
        // Loot may have released it without an event (world clear, recycle).
        if (!s.pickup.active) {
          s.pickup = null;
          s.restock = RESTOCK;
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
  }
}

export default Caches;
