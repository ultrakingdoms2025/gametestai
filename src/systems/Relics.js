import * as THREE from 'three';
import { COLLISION_LAYER } from '../physics/Physics.js';
import { allows } from '../worlds/WorldRules.js';

/**
 * Hidden relics - the collectible that pays.
 *
 * ── Why this is not just another cache ────────────────────────────────────
 * `Caches` answers "is there a reason to dive and to fly": a handful of
 * destinations, each a visible glowing pickup, restocking on a timer. Relics
 * answer a different question - "is there a reason to look at the *architecture*"
 * - and that changes every design decision:
 *
 *   - **Many, not few.** Thirty per world rather than six. A collectible you
 *     find twice an hour is a destination; one you find every couple of minutes
 *     is a reason to keep your eyes up while you travel.
 *   - **They pay credits directly.** No inventory slot, no carrying decision,
 *     no trip back to a vendor. Picking one up is the whole loop.
 *   - **They never come back.** A restocking collectible is a farm; a finite
 *     one is a map you are gradually completing. The count is the progress bar.
 *   - **They are hidden by *placement*, not by stealth.** Every one sits on a
 *     ledge, a rooftop, a parapet or a beam - somewhere you have to climb to,
 *     which is what ties them to the parkour rather than to a search.
 *
 * ── Finding somewhere to hide one ─────────────────────────────────────────
 * The world publishes `_roofs` and `_towers` if it has them, and those are used
 * first because a hand-placed roof is a better hiding place than anything a
 * random probe will find. Beyond that the search is the same shape as the one
 * in `Caches`: dart at the map, cast down, and keep the hit if it is a flat
 * surface that is meaningfully above its surroundings.
 *
 * ── Rendering ─────────────────────────────────────────────────────────────
 * One InstancedMesh for every relic in the world, plus one for their glows.
 * Thirty separate meshes with thirty separate materials would be thirty draw
 * calls for what is visually a single repeated object.
 */

/**
 * How many to hide per world, on a 400 m world.
 *
 * Scaled by playable area from there, in `_onWorld`. Thirty relics over the
 * medieval valley is one every 5,300 m², which is a find every couple of
 * minutes; the same thirty over the station's five decks is one every 74,000 m²,
 * which is a mechanic the player never notices exists.
 */
const PER_WORLD = 30;
/** The extent `PER_WORLD` and `TRIES` are calibrated against. */
const BASE_EXTENT = 400;
/**
 * Ceiling on the scaled count.
 *
 * This is also the capacity of the two InstancedMeshes below, and that is the
 * reason it exists rather than letting the area scale run free: an instanced
 * mesh is allocated once at construction and silently ignores any instance past
 * its count, so a world that wanted more relics than this would place them,
 * count them, and draw only the first hundred and ten.
 */
const MAX_PER_WORLD = 110;
/** Credits each is worth. */
const VALUE = 120;
/** Pickup radius. Generous - you should not have to stand exactly on it. */
const PICKUP_R = 2.0;
/** Minimum separation, so a rooftop never gets two. */
const MIN_APART = 14;
/** How high above its surroundings a spot must be to count as hidden. */
const MIN_PROMINENCE = 2.5;
/** Placement attempts per relic. */
const TRIES = 90;
/** Keep clear of the invisible boundary colliders that fence each world. */
const EDGE_INSET = 22;

const _rv = new THREE.Vector3();
const _rq = new THREE.Quaternion();
const _rs = new THREE.Vector3(1, 1, 1);
const _rm = new THREE.Matrix4();
const _down = new THREE.Vector3(0, -1, 0);

function mulberry32(seed) {
  let s = seed >>> 0 || 1;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * The halo's alpha, as a function of distance from the middle of its quad.
 *
 * ── The defect ─────────────────────────────────────────────────────────────
 * `relics:glow` was an untextured `PlaneGeometry` with a flat additive colour
 * on it, which is not a glow, it is a card: a bright square with a hard
 * boundary all the way round, obvious the moment you walked up to one and -
 * with bloom off - reading as dozens of plain white rectangles scattered over
 * the landscape. Nothing was wrong with the blending or the placement. There
 * was simply no falloff anywhere in the material, so every texel of the quad
 * was as bright as the middle and the edge of the quad was the edge of the
 * light.
 *
 * ── The shape ──────────────────────────────────────────────────────────────
 * Smoothstep on the radius with a little gain, so there is a saturated core
 * out to about a quarter of the quad and a long tail from there. Two
 * properties matter and both are asserted in `relic-glow.test.mjs`:
 *
 *   - it reaches EXACTLY zero at d = 1 and stays there, so the quad's own
 *     edge and its corners (d = 1.41) contribute nothing at all. That is what
 *     removes the boundary; a falloff that still had 2% left at the rim would
 *     leave a faint square in bloom, which is the same defect quieter.
 *   - it never increases. A ramp with a bump in it reads as a ring.
 *
 * A function rather than a literal texture so it can be checked without a GPU,
 * and a texture rather than a shader patch so the material stays a stock
 * `MeshBasicMaterial` - see `_build` for why that matters to the program count.
 *
 * @param {number} d distance from the centre in half-widths: 0 at the middle,
 *   1 at the edge of the quad, 1.41 at a corner.
 */
export function glowFalloff(d) {
  const t = Math.max(0, Math.min(1, 1 - d));
  return Math.min(1, 1.35 * t * t * (3 - 2 * t));
}

/** Edge of the halo texture, in texels. Small: it is a smooth ramp. */
const GLOW_TEX = 64;
/**
 * How much wider the halo's QUAD is than the card it replaces.
 *
 * The old card was uniformly bright, so its quad and its halo were the same
 * thing. `glowFalloff` is past half strength by d = 0.6, so at the same quad
 * size the thing a player spots at range would be a little over half as wide
 * as before. 1.7 puts the bright core back where it was and spends the rest on
 * the tail. It costs nothing per frame: the same one instanced draw, the same
 * instance count, a few more fragments each - all of them additive and most of
 * them nearly transparent.
 */
const GLOW_SPREAD = 1.7;

/**
 * The halo texture: white, with `glowFalloff` in its alpha.
 *
 * A `DataTexture` rather than a canvas one because this file is imported by
 * tests under Node, where there is no `document` to make a canvas with, and
 * because a 64 px ramp written by hand is smaller than the code that would
 * draw it. White RGB throughout: the colour is the material's, in HDR, and
 * multiplying it by a ramp as well would darken the core toward the tail
 * instead of just thinning it.
 */
function makeGlowTexture() {
  const n = GLOW_TEX;
  const data = new Uint8Array(n * n * 4);
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      const dx = ((x + 0.5) / n) * 2 - 1;
      const dy = ((y + 0.5) / n) * 2 - 1;
      const i = (y * n + x) * 4;
      data[i] = 255; data[i + 1] = 255; data[i + 2] = 255;
      data[i + 3] = Math.round(glowFalloff(Math.hypot(dx, dy)) * 255);
    }
  }
  const tex = new THREE.DataTexture(data, n, n, THREE.RGBAFormat);
  tex.name = 'relic.glow.falloff';
  /* Mipmaps and a linear filter are not optional here: a relic is spotted at
   * a hundred metres, where this quad is a few pixels across, and a nearest
   * sampled ramp at that size twinkles as the camera moves. */
  tex.generateMipmaps = true;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.wrapS = THREE.ClampToEdgeWrapping;
  tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.needsUpdate = true;
  return tex;
}

function hashString(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

export class Relics {
  /**
   * @param {{scene:THREE.Scene, bus:any, physics:any, player:any,
   *          economy:any, inventory?:any, worldManager:any}} ctx
   */
  constructor({ scene, bus, physics, player, economy, inventory, worldManager } = {}) {
    this.scene = scene;
    this.bus = bus ?? null;
    this.physics = physics ?? null;
    this.player = player ?? null;
    this.economy = economy ?? null;
    this.inventory = inventory ?? null;
    this.worldManager = worldManager ?? null;

    /** @type {Array<{pos:THREE.Vector3, taken:boolean, phase:number}>} */
    this.sites = [];
    this._worldId = null;
    this._time = 0;
    /** Per-world tally, so a returning player is not told to find them twice. */
    this._found = new Map();

    this._build();

    this._offs = [];
    if (this.bus) {
      this._offs.push(this.bus.on('world:changed', ({ id, world }) => this._onWorld(id, world)));
    }
  }

  /** Relics still hidden in the active world. */
  get remaining() {
    return this.sites.reduce((n, s) => n + (s.taken ? 0 : 1), 0);
  }

  /** Total placed in the active world. */
  get total() {
    return this.sites.length;
  }

  /** Positions for the minimap - only the ones already found, as a record. */
  get markers() {
    const out = [];
    for (const s of this.sites) if (!s.taken) out.push(s.pos);
    return out;
  }

  /* ------------------------------------------------------------------ */
  /* Rendering                                                           */
  /* ------------------------------------------------------------------ */

  _build() {
    /* The relic itself: an octahedron, which reads as "cut gem" at any size and
     * needs no texture to do it. */
    const geo = new THREE.OctahedronGeometry(0.32, 0);
    const mat = new THREE.MeshStandardMaterial({
      name: 'relic.body',
      color: new THREE.Color(0xffd98a),
      emissive: new THREE.Color(0xff9c2e),
      emissiveIntensity: 1.5,
      metalness: 0.85,
      roughness: 0.28,
    });
    this.mesh = new THREE.InstancedMesh(geo, mat, MAX_PER_WORLD);
    this.mesh.name = 'relics';
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.mesh.castShadow = false;
    this.mesh.receiveShadow = false;
    this.mesh.frustumCulled = false;
    this.mesh.count = 0;
    this.scene.add(this.mesh);

    /* Halo: an additive billboard, authored in HDR for the same reason the
     * arrow tracer is - a relic on a sunlit parapet has to out-contrast the
     * stone behind it or it is invisible at the range you spot it from.
     *
     * The falloff is a `map`, and that choice is the cheap one on purpose. The
     * alternative was an `onBeforeCompile` patch computing the ramp from `vUv`,
     * which would have made this the only `MeshBasicMaterial` in the game with
     * a custom program cache key, for a ramp that is four instructions and
     * eight bytes of texture per texel. As a stock material with a map it is
     * still ONE draw call for every relic in the world, still one material, and
     * the program it compiles is a variant three already builds for every other
     * mapped basic material in the scene. */
    const gGeo = new THREE.PlaneGeometry(1, 1);
    const gTex = makeGlowTexture();
    const gMat = new THREE.MeshBasicMaterial({
      name: 'relic.glow',
      color: new THREE.Color(3.2, 1.9, 0.7),
      map: gTex,
      transparent: true,
      opacity: 0.9,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      toneMapped: false,
      fog: false,
    });
    this.glow = new THREE.InstancedMesh(gGeo, gMat, MAX_PER_WORLD);
    this.glow.name = 'relics:glow';
    this.glow.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.glow.frustumCulled = false;
    this.glow.renderOrder = 7;
    this.glow.count = 0;
    this.scene.add(this.glow);

    this._disposables = [geo, mat, gGeo, gMat, gTex];
  }

  /* ------------------------------------------------------------------ */
  /* Placement                                                           */
  /* ------------------------------------------------------------------ */

  _onWorld(id, world) {
    this._worldId = id ?? null;
    this.sites.length = 0;
    this.mesh.count = 0;
    this.glow.count = 0;
    // No relics: the only collectible is the stack at the centre.
    if (!allows(world, 'relics')) return;
    if (!world || !this.physics) return;

    const rnd = mulberry32(hashString(`relic:${id}`));
    const b = world.bounds;
    const minX = (b?.min?.x ?? -180) + EDGE_INSET;
    const maxX = (b?.max?.x ?? 180) - EDGE_INSET;
    const minZ = (b?.min?.z ?? -180) + EDGE_INSET;
    const maxZ = (b?.max?.z ?? 180) - EDGE_INSET;

    /* Budget by area, not by a constant.
     *
     * Both numbers below were tuned against a 400 m world and neither survives
     * a bigger one. The count is the obvious half; the dart budget is the half
     * that bites hardest, because `TRIES` is a *total*, not per relic, and the
     * probability that a dart lands somewhere prominent falls with area. Ninety
     * darts into the station's box would have placed a handful and then given
     * up, and the log line would have said so to nobody.
     */
    const extent = Math.max(maxX - minX, maxZ - minZ, 1);
    const areaScale = Math.min(MAX_PER_WORLD / PER_WORLD, (extent / BASE_EXTENT) ** 2);
    const want = Math.round(PER_WORLD * Math.max(1, areaScale));
    const tries = Math.round(TRIES * Math.max(1, areaScale));

    /* Authored surfaces first. A world that publishes its roofs and towers -
     * the citadel does - knows better than any random probe where a relic
     * belongs, and using them means the citadel's relics sit on the skyline
     * rather than wherever a dart happened to land. */
    const authored = [];
    for (const t of world._towers ?? []) authored.push({ x: t.x, y: t.y, z: t.z });
    for (const r of world._roofs ?? []) authored.push({ x: r.x, y: r.y, z: r.z });
    // Shuffle deterministically so the same subset is not used every time.
    for (let i = authored.length - 1; i > 0; i--) {
      const j = Math.floor(rnd() * (i + 1));
      [authored[i], authored[j]] = [authored[j], authored[i]];
    }

    for (const a of authored) {
      if (this.sites.length >= want) break;
      if (this._tooClose(a.x, a.z)) continue;
      this.sites.push({ pos: new THREE.Vector3(a.x, a.y + 0.55, a.z), taken: false, phase: rnd() * 6.283 });
    }

    // Then probe for anything else prominent enough to be worth a climb.
    for (let t = 0; t < tries && this.sites.length < want; t++) {
      const x = minX + rnd() * (maxX - minX);
      const z = minZ + rnd() * (maxZ - minZ);
      _rv.set(x, 400, z);
      const hit = this.physics.raycast(_rv, _down, 800, COLLISION_LAYER.WORLD);
      if (!hit) continue;
      if (Math.abs(hit.normal?.y ?? 1) < 0.7) continue;
      const y = hit.point.y;
      if (this._tooClose(x, z)) continue;

      // Prominence: meaningfully above what is around it, or it is just a spot
      // on the floor and finding it is not an achievement.
      let low = Infinity;
      for (let i = 0; i < 4; i++) {
        const a = (i / 4) * Math.PI * 2;
        const ry = this.physics.groundHeight(x + Math.cos(a) * 4, z + Math.sin(a) * 4, y + 1, 200);
        low = Math.min(low, ry === null ? -Infinity : ry);
      }
      if (y - low < MIN_PROMINENCE) continue;

      this.sites.push({ pos: new THREE.Vector3(x, y + 0.55, z), taken: false, phase: rnd() * 6.283 });
    }

    const already = this._found.get(id) ?? 0;
    // Mark the first N as already taken, so a returning player does not
    // re-collect a world they have already stripped.
    for (let i = 0; i < already && i < this.sites.length; i++) this.sites[i].taken = true;

    if (this.sites.length) {
      console.info(`[Relics] "${id}": ${this.remaining}/${this.sites.length} hidden`);
    }
    this._announce();
  }

  _tooClose(x, z) {
    const r2 = MIN_APART * MIN_APART;
    for (const s of this.sites) {
      const dx = s.pos.x - x;
      const dz = s.pos.z - z;
      if (dx * dx + dz * dz < r2) return true;
    }
    return false;
  }

  /* ------------------------------------------------------------------ */
  /* Frame                                                               */
  /* ------------------------------------------------------------------ */

  /**
   * Spin, bob, and check for a pickup.
   * @param {number} dt
   */
  update(dt) {
    if (!this.sites.length) return;
    this._time += dt;
    const t = this._time;
    const p = this.player?.position;
    const cam = this.player?.camera ?? null;

    let n = 0;
    let g = 0;
    for (const s of this.sites) {
      if (s.taken) continue;
      const bob = Math.sin(t * 1.6 + s.phase) * 0.16;
      _rv.set(s.pos.x, s.pos.y + bob, s.pos.z);

      _rq.setFromAxisAngle(new THREE.Vector3(0, 1, 0), t * 1.1 + s.phase);
      _rs.setScalar(1);
      _rm.compose(_rv, _rq, _rs);
      this.mesh.setMatrixAt(n++, _rm);

      if (cam) {
        /* Camera-facing, distance-scaled: the halo is what you spot from the
         * far side of the souk, so it must not shrink to nothing.
         *
         * `GLOW_SPREAD` is what pays for the falloff. The card used to be
         * bright to its own edge, so the quad's width WAS the halo's width;
         * with a ramp on it the visible core is about half that, and a relic
         * would have gone quieter at exactly the range it exists to be seen
         * from. The quad grows, the core stays about the size it always was,
         * and what is new is the soft tail around it. */
        const d = _rv.distanceTo(cam.position);
        const gs = Math.min(2.6, 0.5 + d * 0.045) * GLOW_SPREAD;
        _rm.copy(cam.matrixWorld);
        _rm.setPosition(_rv);
        _rm.scale(_rs.set(gs, gs, gs));
        this.glow.setMatrixAt(g++, _rm);
      }

      if (p && !s.taken) {
        const dx = p.x - s.pos.x;
        const dy = p.y + 1.0 - s.pos.y;
        const dz = p.z - s.pos.z;
        if (dx * dx + dy * dy + dz * dz < PICKUP_R * PICKUP_R) this._collect(s);
      }
    }
    this.mesh.count = n;
    this.glow.count = g;
    if (n > 0) this.mesh.instanceMatrix.needsUpdate = true;
    if (g > 0) this.glow.instanceMatrix.needsUpdate = true;
  }

  _collect(site) {
    site.taken = true;
    this._found.set(this._worldId, (this._found.get(this._worldId) ?? 0) + 1);
    this.economy?.add?.(VALUE, 'relic');
    // Also add a relic_coin to the store so it shows up in the inventory panel.
    this.inventory?.add?.('relic_coin', 1);
    const left = this.remaining;
    this.bus?.emit('relic:found', { value: VALUE, remaining: left, total: this.total });
    this.bus?.emit('hud:notify', {
      text: left > 0
        ? `Relic recovered — +${VALUE} CR (${left} left)`
        : `Relic recovered — +${VALUE} CR. That was the last one.`,
      tone: 'good',
    });
    this._announce();
  }

  _announce() {
    this.bus?.emit('relics:changed', {
      worldId: this._worldId, remaining: this.remaining, total: this.total,
    });
  }

  dispose() {
    for (const off of this._offs) off?.();
    this._offs.length = 0;
    this.mesh?.removeFromParent();
    this.glow?.removeFromParent();
    for (const d of this._disposables) d?.dispose?.();
    this.sites.length = 0;
  }
}

export default Relics;
