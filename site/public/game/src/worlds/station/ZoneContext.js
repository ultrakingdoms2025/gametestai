import * as THREE from 'three';
import {
  DEG, ZONE_R, ZONE_CENTRE_R, domeHeightAt,
  GeoBatch, boxGeo, uvScale, zoneCentre, zoneLocal, zoneYaw,
} from './StationKit.js';

const _v = new THREE.Vector3();

/**
 * The handle a zone builder is given, and the only thing it is allowed to touch.
 *
 * ── Why zones are authored in their own frame ─────────────────────────────
 * The four outer zones hang off four different avenues, so in world space no two
 * of them share an axis, an origin or a sign of anything. Authored that way,
 * "the servery runs along the north wall" would mean four different sets of
 * numbers and the first person to copy a table layout between two zones would
 * get it mirrored.
 *
 * So every builder works in the same local frame instead:
 *
 *     +Z  points back down the corridor, toward the hub
 *     -Z  points away from the hub, to the far wall
 *     +X  is to the right of somebody walking out of the corridor
 *      0  is the centre of the zone deck
 *
 * `lz = +ZONE_R` is therefore always the corridor mouth and `lz = -ZONE_R` is
 * always the far wall, in every zone. `P()` and `put()` do the transform; a
 * builder never sees a world coordinate unless it asks for one.
 *
 * ── Why the collider calls are separate from the geometry calls ───────────
 * The station derives most of its collision from the triangles it actually
 * draws (see `_solidifyStructure`), which is what stopped the two drifting
 * apart. But that pass has a ceiling and a triangle budget, and it cannot know
 * that the inside of a shell is meant to be hollow. So structure that a player
 * stands on, walks into or shelters under still declares itself explicitly, and
 * `solid()` / `ramp()` are how. The rule: if you would be annoyed to fall
 * through it, call `solid()`.
 */
export class ZoneContext {
  /**
   * @param {object} o
   * @param {import('../StationWorld.js').StationWorld} o.world
   * @param {object} o.spec         one entry from `ZONES`
   * @param {THREE.Group} o.group   already parented to `world.group`
   * @param {GeoBatch} o.B          flushed by the caller once the builder returns
   * @param {import('./StationActors.js').StationActors} o.actors
   * @param {() => number} o.rng
   */
  constructor({ world, spec, group, B, actors, rng }) {
    this.world = world;
    this.spec = spec;
    this.group = group;
    this.B = B;
    this.M = world.mat;
    this.actors = actors;
    this.rng = rng;

    /** Zone deck centre in world space. */
    this.centre = zoneCentre(spec.deg);
    /** World yaw of zone-local heading 0. */
    this.yaw = zoneYaw(spec.deg);
    /** Radius of the walkable deck. */
    this.radius = ZONE_R;
    /** Emissive material key for this zone's district accent. */
    this.accent = spec.accent;

    /** Collectable spots this zone wants, consumed by the world after the build. */
    this.relicSpots = [];
    /** Enterable descriptors (doors + lifts + collectibles) for the Interiors system. */
    this.enterables = [];
    /** NPC spawn descriptors appended to `world.npcSpawns`. */
    this.npcSpawns = [];
    /** Rooftops published for the relic placer, as {x,y,z}. */
    this.roofs = [];
  }

  /* ---------------------------------------------------------------- */
  /* Frame                                                             */
  /* ---------------------------------------------------------------- */

  /** Zone-local -> world. Allocates; build-time only. */
  P(lx, ly, lz) {
    return zoneLocal(this.spec.deg, lx, ly, lz);
  }

  /** World yaw for a zone-local heading. */
  yawOf(localYaw = 0) {
    return zoneYaw(this.spec.deg, localYaw);
  }

  /** Distance of a zone-local point from the zone's own centre. */
  r(lx, lz) {
    return Math.hypot(lx, lz);
  }

  /**
   * True if a zone-local point is on the deck with `pad` metres to spare.
   * Every scatter loop should reject against this rather than trusting its own
   * arithmetic - a prop past the rim is a prop standing in vacuum.
   */
  onDeck(lx, lz, pad = 4) {
    return Math.hypot(lx, lz) <= ZONE_R - pad;
  }

  /** Height of the dome roof above a zone-local point, for anything hung. */
  ceilingAt(lx, lz) {
    const w = this.P(lx, 0, lz);
    return domeHeightAt(Math.hypot(w.x, w.z));
  }

  /* ---------------------------------------------------------------- */
  /* Geometry                                                          */
  /* ---------------------------------------------------------------- */

  /**
   * Push a geometry into the zone batch, positioned in the zone frame.
   * The batch owns the geometry from here - do not reuse it, `clone()` first.
   */
  put(key, geo, lx, ly, lz, localYaw = 0, rx = 0, rz = 0) {
    return this.B.localAt(key, geo, this.centre.x, 0, this.centre.z, this.yaw, lx, ly, lz, localYaw, rx, rz);
  }

  /** A UV-corrected box, pushed in one call. The common case. */
  box(key, w, h, d, lx, ly, lz, localYaw = 0, tile = 2) {
    return this.put(key, boxGeo(w, h, d, tile), lx, ly, lz, localYaw);
  }

  /** A flat quad lying on the deck - floor inlays, painted bays, spill decals. */
  floorQuad(key, w, d, lx, lz, localYaw = 0, y = 0.09, tile = 6) {
    const q = new THREE.PlaneGeometry(w, d);
    q.rotateX(-Math.PI / 2);
    uvScale(q, w / tile, d / tile);
    return this.put(key, q, lx, y, lz, localYaw);
  }

  /* ---------------------------------------------------------------- */
  /* Collision                                                         */
  /* ---------------------------------------------------------------- */

  /** A Y-rotated solid box, in the zone frame. `lx/ly/lz` is its CENTRE. */
  solid(lx, ly, lz, hx, hy, hz, localYaw = 0) {
    const p = this.P(lx, ly, lz);
    return this.world._solidRot(p.x, p.y, p.z, hx, hy, hz, this.yawOf(localYaw));
  }

  /**
   * A walkable slope. `run` is along local -Z by default (away from the hub),
   * `rise` is the height gained over that run.
   */
  ramp(lx, ly, lz, width, run, rise, localYaw = 0) {
    const p = this.P(lx, ly, lz);
    return this.world._ramp(p.x, p.y, p.z, width, run, rise, this.yawOf(localYaw));
  }

  /* ---------------------------------------------------------------- */
  /* Dressing + registration                                           */
  /* ---------------------------------------------------------------- */

  /** Contact-occlusion patch on the deck under a prop. */
  contact(lx, lz, size, y = 0.055) {
    const p = this.P(lx, 0, lz);
    this.world._contact(p.x, p.z, size, y);
  }

  /** Minimap rectangle, in the zone frame. */
  mmRect(lx, lz, w, d, localYaw, fill, stroke) {
    const p = this.P(lx, 0, lz);
    this.world._mmRect(p.x, p.z, w, d, this.yawOf(localYaw), fill, stroke);
  }

  mmCircle(lx, lz, r, fill, stroke) {
    const p = this.P(lx, 0, lz);
    this.world._mmCircle(p.x, p.z, r, fill, stroke);
  }

  /** Minimap polyline from zone-local [lx, lz] pairs. */
  mmPath(points, stroke, width, closed) {
    this.world._mmPath(
      points.map(([lx, lz]) => { const p = this.P(lx, 0, lz); return [p.x, p.z]; }),
      stroke, width, closed
    );
  }

  /** An atlas sign board, correctly wound so its copy is never mirrored. */
  sign(cell, w, h, lx, ly, lz, localYaw = 0, opts = {}) {
    const p = this.P(lx, ly, lz);
    this.world._signBoard(this.B, cell, w, h, p.x, p.y, p.z, this.yawOf(localYaw), opts);
  }

  /**
   * An actor. `activity` is one of the StationActors verbs; `ly` is the FLOOR
   * the figure stands or sits on, not its hip height.
   */
  actor(lx, ly, lz, opts = {}) {
    const p = this.P(lx, ly, lz);
    return this.actors.add({
      x: p.x, y: p.y, z: p.z,
      yaw: this.yawOf(opts.localYaw ?? 0),
      ...opts,
    });
  }

  /** A hidden collectable. Tier is 'common' | 'rare' | 'prize'. */
  relic(lx, ly, lz, tier = 'common') {
    this.relicSpots.push({ position: this.P(lx, ly, lz), tier });
  }

  /**
   * Publish a rooftop so the relic placer has an authored, reachable site
   * rather than a random dart. See `Relics._onWorld`.
   */
  roof(lx, ly, lz) {
    const p = this.P(lx, ly, lz);
    this.roofs.push({ x: p.x, y: p.y, z: p.z });
  }

  /** A named, conversational NPC. `lx/lz` in the zone frame. */
  npc(lx, lz, o) {
    this.npcSpawns.push({
      position: this.P(lx, 0.2, lz),
      type: o.type ?? 'friendly',
      ...o,
      patrol: o.patrol
        ? o.patrol.map(([px, pz]) => this.P(px, 0.2, pz))
        : undefined,
    });
  }
}
