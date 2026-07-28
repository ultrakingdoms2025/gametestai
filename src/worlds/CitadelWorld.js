import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { World } from './World.js';
import { COLLISION_LAYER } from '../physics/Physics.js';

/**
 * CITADEL - "Sunspire Citadel".
 *
 * A cliff-top fortress town under hard afternoon sun, built to be *climbed*
 * rather than walked. Every other world in this game is a floor plan with
 * scenery on it; this one is a vertical playground, and that single intent
 * drives every decision in the file.
 *
 * ── What "designed for climbing" actually means here ──────────────────────
 *
 * 1. **Vertical faces everywhere, and they are boxes.** The free-climb probe
 *    asks the collision world "is there a near-vertical surface in front of
 *    me", so a world that answers yes has to be made of hard-edged geometry,
 *    not smooth heightfield. Almost every structure here is an oriented box.
 *
 * 2. **Nothing is taller than the stamina allows in one run.** Climb stamina
 *    drains on the wall, so a 45 m tower with no interruption is a wall the
 *    player simply falls off. Every tall silhouette is therefore banded with
 *    ledges - string courses, balconies, roof lips - at 6-9 m intervals, which
 *    are rest points, and which is also why real fortifications look like that.
 *
 * 3. **Roofs form a connected network.** The souk is laid out so adjacent roofs
 *    are within a running leap of each other, with the gaps widening as you get
 *    closer to the citadel. That gradient is the difficulty curve: the outer
 *    town teaches, the inner town tests.
 *
 * 4. **Every fall has an answer.** Haystacks sit under the high traversal lines
 *    so a leap of faith is a route rather than a death, and the roll window
 *    covers everything else.
 *
 * ── Layout ────────────────────────────────────────────────────────────────
 *
 *   -Z  cliff edge and the leap-of-faith viewpoint
 *        |
 *   citadel keep + great tower (the high anchor, ~46 m)
 *        |
 *   inner ward, rope bridges between the minarets
 *        |
 *   souk - dense flat-roofed blocks, narrowing alleys
 *        |
 *   curtain wall, gatehouse, and the portal plaza just inside it
 *   +Z
 *
 * Geometry is batched aggressively: everything sharing a material is merged
 * into one mesh per district, because a town of 400 buildings would otherwise
 * be 400 draw calls. Collision is oriented boxes only - a triangle soup would
 * give the climb probe a surface normal per triangle and make ledge detection
 * chatter along every seam.
 */

/* ------------------------------------------------------------------ */
/* Module scratch - never allocate inside a loop or a frame handler.    */
/* ------------------------------------------------------------------ */

const _v1 = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _m1 = new THREE.Matrix4();
const _q1 = new THREE.Quaternion();
const _e1 = new THREE.Euler();
const _color = new THREE.Color();

const TAU = Math.PI * 2;
const DEG = Math.PI / 180;

/** Playfield half-extent. Matches the other worlds so the minimap framing does. */
const HALF = 200;
/** Height of the plateau the town sits on, above the surrounding desert. */
const MESA_Y = 14;
/** Where the plateau edge falls away to the approach road. */
const MESA_R = 132;

/** Deterministic PRNG - a world has to regenerate identically every session. */
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
 * Geometry accumulator.
 *
 * Collects transformed geometries per material key and merges each bucket into
 * a single mesh. Worlds in this project live or die on draw-call count; the
 * souk alone is ~1400 boxes and would be unshippable one mesh at a time.
 */
class Batch {
  constructor() {
    /** @type {Map<string, THREE.BufferGeometry[]>} */
    this.buckets = new Map();
    this._owned = [];
  }

  /**
   * @param {string} key material key
   * @param {THREE.BufferGeometry} geo consumed - do not reuse after this
   * @param {THREE.Matrix4} matrix world transform
   * @param {number} [tint] optional per-vertex tint
   */
  add(key, geo, matrix, tint = null) {
    const g = geo.index ? geo.toNonIndexed() : geo;
    if (g !== geo) geo.dispose();
    // Strip anything the merge cannot reconcile: mergeGeometries returns null
    // if two inputs disagree about which attributes exist.
    for (const k of Object.keys(g.attributes)) {
      if (k !== 'position' && k !== 'normal' && k !== 'uv') g.deleteAttribute(k);
    }
    g.applyMatrix4(matrix);
    /* Always written, white when no tint was asked for.
     *
     * Two reasons it cannot be conditional. `mergeGeometries` returns null the
     * moment two inputs disagree about which attributes exist, so one untinted
     * box would silently drop its whole district. And the materials here run
     * with `vertexColors` on, where a *missing* colour attribute reads as zero
     * rather than as one - the geometry would come out black rather than
     * untinted. */
    _color.set(tint === null ? 0xffffff : tint);
    const n = g.attributes.position.count;
    const col = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) {
      col[i * 3] = _color.r;
      col[i * 3 + 1] = _color.g;
      col[i * 3 + 2] = _color.b;
    }
    g.setAttribute('color', new THREE.BufferAttribute(col, 3));
    let list = this.buckets.get(key);
    if (!list) this.buckets.set(key, (list = []));
    list.push(g);
  }

  /** Convenience for the overwhelmingly common case: an axis-aligned box. */
  box(key, w, h, d, x, y, z, rotY = 0, tint = null) {
    _e1.set(0, rotY, 0);
    _q1.setFromEuler(_e1);
    _v1.set(x, y, z);
    _v2.set(1, 1, 1);
    _m1.compose(_v1, _q1, _v2);
    this.add(key, new THREE.BoxGeometry(w, h, d), _m1, tint);
  }

  /**
   * Merge every bucket into the group.
   * @param {THREE.Group} group
   * @param {(key:string) => THREE.Material} resolve
   * @param {string} name
   * @param {{cast?:boolean, recv?:boolean}} [opts]
   */
  flush(group, resolve, name, { cast = true, recv = true } = {}) {
    const out = [];
    for (const [key, list] of this.buckets) {
      if (!list.length) continue;
      const merged = mergeGeometries(list, false);
      for (const g of list) g.dispose();
      if (!merged) {
        console.warn(`[CitadelWorld] merge failed for "${key}" in ${name}`);
        continue;
      }
      merged.computeBoundingSphere();
      const mesh = new THREE.Mesh(merged, resolve(key));
      mesh.name = `${name}:${key}`;
      mesh.castShadow = cast;
      mesh.receiveShadow = recv;
      group.add(mesh);
      out.push(mesh);
      this._owned.push(merged);
    }
    this.buckets.clear();
    return out;
  }

  dispose() {
    for (const g of this._owned) g.dispose();
    this._owned.length = 0;
  }
}

export class CitadelWorld extends World {
  static id = 'citadel';
  static displayName = 'Sunspire Citadel';

  constructor(ctx) {
    super(ctx);
    this.rnd = mulberry32(0x5175ce);

    /** Roof platforms, so relics and rope bridges can be placed on real surfaces. */
    this._roofs = [];
    /** Tower tops: the anchors for rope bridges and the best relic sites. */
    this._towers = [];
    /** Haystack positions - the landing sites that make a leap of faith survivable. */
    this.haystacks = [];
    /** Viewpoints: high, isolated, and worth the climb. */
    this.viewpoints = [];

    this._owned = [];
    this._time = 0;
    this._banners = [];

    this._configureEnvironment();
  }

  /* ================================================================== */
  /* Environment                                                         */
  /* ================================================================== */

  _configureEnvironment() {
    const env = this.environment;
    // Late afternoon, raking hard across the stone. A low sun is what gives a
    // climbing world its readability: every ledge casts a line.
    env.background = new THREE.Color(0x9fb8d4);
    env.fogColor = new THREE.Color(0xc9c0a8);
    env.fogNear = 90;
    env.fogFar = 520;
    env.exposure = 1.0;
    env.ambientColor = new THREE.Color(0x8a94a8);
    env.ambientIntensity = 0.85;
    env.skyColor = new THREE.Color(0xbcd2ea);
    env.groundColor = new THREE.Color(0xb09a72);
    env.hemiIntensity = 0.9;
    env.sunColor = new THREE.Color(0xffe2b0);
    env.sunIntensity = 5.6;
    env.sunDirection = new THREE.Vector3(0.55, 0.42, 0.72).normalize();
    env.envMapIntensity = 1.0;
    env.bloom = { strength: 0.42, radius: 0.5, threshold: 0.92 };
    env.envMap = this.materials?.getEnvMap?.('daylight') ?? undefined;
  }

  /* ================================================================== */
  /* Build                                                               */
  /* ================================================================== */

  async build(onProgress) {
    const report = onProgress ?? (() => {});

    await report(0.02, 'Hanging the sky');
    this._buildSky();

    await report(0.06, 'Raising the mesa');
    this._buildTerrain();

    await report(0.2, 'Laying the curtain wall');
    this._buildCurtainWall();

    await report(0.4, 'Building the souk');
    this._buildSouk();

    await report(0.62, 'Raising the citadel');
    this._buildCitadel();

    await report(0.76, 'Stringing the rope bridges');
    this._buildRopeBridges();

    await report(0.86, 'Scattering the hay');
    this._buildDressing();

    await report(0.94, 'Opening the gate');
    this._fillSpawns();

    this.group.matrixAutoUpdate = false;
    this.group.updateMatrixWorld(true);
    this.group.visible = this.active;
    await report(1, 'Citadel ready');
  }

  /**
   * A shared-library material, re-tinted for this world.
   *
   * Two things are going on and both are necessary.
   *
   * The library's stone is a cold northern grey, which is right for a keep in
   * the rain and wrong for a citadel baking on a mesa - dropped in unchanged
   * the whole town photographs blue. Each key therefore gets a warm base
   * colour, which costs nothing because a tint is a uniform.
   *
   * And `vertexColors` has to be switched on, or the per-building variation
   * every `Batch.box` call writes is silently discarded: the attribute is in
   * the geometry, the shader never reads it, and four hundred houses come out
   * identical. That was the first version of this world.
   *
   * Cloning is what makes both possible without touching the shared instance
   * the other three worlds are drawn with. Clones share texture storage, so the
   * only real cost is one extra shader program per key.
   */
  _mat(key) {
    this._matCache ??= new Map();
    const hit = this._matCache.get(key);
    if (hit) return hit;

    const base = this.materials.get(key);
    const m = base.clone();
    m.name = `citadel.${key}`;
    m.vertexColors = true;
    // Sun-bleached limestone and mudbrick, per surface family.
    const TINT = {
      'stone.castle': 0xe8dcbe,
      'plaster.wall': 0xf2e6c8,
      'stone.cobble': 0xd8cba9,
      'wood.beam': 0xb9946a,
      'wood.plank': 0xc9a578,
      'roof.tile': 0xd7cdb4,
      'thatch.roof': 0xffe9a8,
      'fabric.banner': 0xffffff,
      'dirt.ground': 0xe0cda3,
    };
    const t = TINT[key.split(':')[0]];
    if (t !== undefined) m.color = new THREE.Color(t);
    this._matCache.set(key, m);
    this._owned.push(m);
    return m;
  }

  /* ------------------------------------------------------------------ */
  /* Sky                                                                 */
  /* ------------------------------------------------------------------ */

  /**
   * Gradient dome.
   *
   * `environment.background` alone is a single flat colour, which reads as a
   * void behind a skyline rather than as air - and this world is looked *out*
   * from more than any other, because half of it is spent on a rooftop. A dome
   * costs one draw call and gives the horizon a haze band for the town to sit
   * against.
   *
   * Unlit, unfogged and drawn behind everything: it is a backdrop, not a
   * surface, and it must never receive the sun or it will band.
   */
  _buildSky() {
    const cv = document.createElement('canvas');
    cv.width = 4;
    cv.height = 256;
    const c = cv.getContext('2d');
    const grd = c.createLinearGradient(0, 0, 0, 256);
    grd.addColorStop(0.0, '#3f74b8');   // zenith
    grd.addColorStop(0.42, '#8fb4d8');
    grd.addColorStop(0.72, '#d8cdb0');  // haze
    grd.addColorStop(1.0, '#e4d2ac');   // dust at the horizon
    c.fillStyle = grd;
    c.fillRect(0, 0, 4, 256);

    const tex = new THREE.CanvasTexture(cv);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.needsUpdate = true;

    const geo = new THREE.SphereGeometry(900, 24, 16);
    const mat = new THREE.MeshBasicMaterial({
      map: tex, side: THREE.BackSide, fog: false, depthWrite: false,
    });
    const dome = new THREE.Mesh(geo, mat);
    dome.name = 'citadel:sky';
    dome.frustumCulled = false;
    dome.renderOrder = -100;
    dome.castShadow = false;
    dome.receiveShadow = false;
    this.group.add(dome);
    this._owned.push(geo, mat, tex);

    // With a dome in place the clear colour only shows through the horizon
    // haze, so match it rather than fighting it.
    this.environment.background = null;
  }

  /* ------------------------------------------------------------------ */
  /* Terrain                                                             */
  /* ------------------------------------------------------------------ */

  /**
   * The mesa.
   *
   * A flat top with a hard rim, not a smooth hill - the rim *is* the cliff the
   * eagle launches from and the leap of faith drops down. Built as a
   * heightfield mesh for looks and a ring of oriented boxes for collision,
   * because a triangle-soup cliff would give the climb probe a different normal
   * on every triangle and make the grip chatter all the way up.
   */
  _buildTerrain() {
    const seg = 96;
    const geo = new THREE.PlaneGeometry(HALF * 2, HALF * 2, seg, seg);
    geo.rotateX(-Math.PI / 2);
    const pos = geo.attributes.position;
    const rnd = this.rnd;

    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i);
      const z = pos.getZ(i);
      const r = Math.hypot(x, z);
      // Plateau, then a steep shoulder, then desert floor.
      let h;
      if (r < MESA_R) {
        h = MESA_Y;
      } else {
        const t = Math.min(1, (r - MESA_R) / 46);
        h = MESA_Y * (1 - t * t * (3 - 2 * t));
      }
      // Dunes on the flat, and a little erosion noise on the shoulder.
      const dune = Math.sin(x * 0.021) * Math.cos(z * 0.017) * 2.4
        + Math.sin(x * 0.06 + z * 0.04) * 0.8;
      h += r < MESA_R ? 0 : dune * Math.min(1, (r - MESA_R) / 30);
      pos.setY(i, h);
    }
    geo.computeVertexNormals();
    geo.computeBoundingSphere();
    this._owned.push(geo);

    // Its own material, not a `_mat` clone: the heightfield carries no colour
    // attribute, and a vertexColors material without one renders black.
    const groundMat = this.materials.get('dirt.ground:60').clone();
    groundMat.name = 'citadel.terrain';
    groundMat.color = new THREE.Color(0xe3d0a6);
    this._owned.push(groundMat);
    const ground = new THREE.Mesh(geo, groundMat);
    ground.name = 'citadel:terrain';
    ground.receiveShadow = true;
    ground.castShadow = false;
    this.group.add(ground);

    // Plateau top as one big collider slab, so walking the town is flat and
    // exact rather than sampling a heightfield.
    this.track(this.physics.addBox(0, MESA_Y - 4, 0, MESA_R + 4, 4, MESA_R + 4));

    /* The cliff ring: boxes stepped down the shoulder. Also the world's biggest
     * climbable face - the whole point of putting the town on a mesa. */
    const B = new Batch();
    const steps = 5;
    for (let s = 0; s < steps; s++) {
      const t0 = s / steps;
      const t1 = (s + 1) / steps;
      const rIn = MESA_R + t0 * 40;
      const y = MESA_Y * (1 - t0 * t0);
      const h = MESA_Y * (1 - t0 * t0) - MESA_Y * (1 - t1 * t1);
      if (h < 0.3) continue;
      const n = 64;
      for (let i = 0; i < n; i++) {
        const a = (i / n) * TAU;
        const jitter = 1 + (rnd() - 0.5) * 0.06;
        const px = Math.cos(a) * rIn * jitter;
        const pz = Math.sin(a) * rIn * jitter;
        const w = (TAU * rIn) / n * 1.25;
        B.box('stone.castle', w, h * 1.6, 7, px, y - h * 0.3, pz, a + Math.PI / 2,
          0xb9a986);
        this.track(this.physics.addRotatedBox(
          _v1.set(px, y - h * 0.3, pz),
          _v2.set(w * 0.5, h * 0.8, 3.5),
          a + Math.PI / 2
        ));
      }
    }
    B.flush(this.group, (k) => this._mat(k), 'cliff', { cast: true, recv: true });
    B.dispose();

    // Desert floor collider, well below, so falling off the mesa lands you
    // somewhere rather than through the world.
    this.track(this.physics.addBox(0, -3, 0, HALF, 3, HALF));

    this.bounds = new THREE.Box3(
      new THREE.Vector3(-HALF, -10, -HALF),
      new THREE.Vector3(HALF, 90, HALF)
    );
  }

  /* ------------------------------------------------------------------ */
  /* Curtain wall                                                        */
  /* ------------------------------------------------------------------ */

  /**
   * Curtain wall with walkable battlements and corner towers.
   *
   * The rampart walk is the town's first traversal line: it circles the whole
   * souk at 9 m, so a player who climbs the gatehouse can run the entire
   * perimeter without touching the ground. The merlons are real boxes rather
   * than a texture, because they are the handholds on the way up.
   */
  _buildCurtainWall() {
    const B = new Batch();
    const R = 118;
    const WALL_H = 9;
    const WALL_T = 2.6;
    const segs = 40;
    const top = MESA_Y + WALL_H;

    for (let i = 0; i < segs; i++) {
      const a0 = (i / segs) * TAU;
      const a1 = ((i + 1) / segs) * TAU;
      const mid = (a0 + a1) * 0.5;
      // Leave the gate open on the +Z side, where the approach road arrives.
      if (Math.abs(((mid - Math.PI * 0.5 + Math.PI) % TAU) - Math.PI) < 0.1) continue;

      const px = Math.cos(mid) * R;
      const pz = Math.sin(mid) * R;
      const len = (TAU * R) / segs * 1.06;

      B.box('stone.castle', len, WALL_H, WALL_T, px, MESA_Y + WALL_H * 0.5, pz, mid + Math.PI / 2, 0xc4b494);
      this.track(this.physics.addRotatedBox(
        _v1.set(px, MESA_Y + WALL_H * 0.5, pz),
        _v2.set(len * 0.5, WALL_H * 0.5, WALL_T * 0.5),
        mid + Math.PI / 2
      ));

      // Merlons: alternating blocks along the parapet.
      const merlons = 5;
      for (let m = 0; m < merlons; m++) {
        if (m % 2) continue;
        const t = (m + 0.5) / merlons - 0.5;
        const mx = px + Math.cos(mid + Math.PI / 2) * len * t;
        const mz = pz + Math.sin(mid + Math.PI / 2) * len * t;
        B.box('stone.castle', len / merlons * 0.86, 1.5, WALL_T * 0.55,
          mx, top + 0.75, mz, mid + Math.PI / 2, 0xbfae8c);
        this.track(this.physics.addRotatedBox(
          _v1.set(mx, top + 0.75, mz),
          _v2.set(len / merlons * 0.43, 0.75, WALL_T * 0.28),
          mid + Math.PI / 2
        ));
      }
    }

    // Corner towers - taller, and each one a rest ledge on a long climb.
    for (let i = 0; i < 8; i++) {
      const a = (i / 8) * TAU + 0.39;
      const px = Math.cos(a) * R;
      const pz = Math.sin(a) * R;
      const h = 17;
      const w = 8.5;
      B.box('stone.castle', w, h, w, px, MESA_Y + h * 0.5, pz, a, 0xcbbb99);
      this.track(this.physics.addRotatedBox(
        _v1.set(px, MESA_Y + h * 0.5, pz), _v2.set(w * 0.5, h * 0.5, w * 0.5), a
      ));
      // String course at mid height: the rest ledge.
      B.box('stone.castle', w + 1.1, 0.5, w + 1.1, px, MESA_Y + h * 0.55, pz, a, 0xb2a084);
      this.track(this.physics.addRotatedBox(
        _v1.set(px, MESA_Y + h * 0.55, pz), _v2.set((w + 1.1) * 0.5, 0.25, (w + 1.1) * 0.5), a
      ));
      // Parapet ring on top.
      B.box('stone.castle', w + 1.4, 1.2, w + 1.4, px, MESA_Y + h + 0.6, pz, a, 0xc0b08e);
      this.track(this.physics.addRotatedBox(
        _v1.set(px, MESA_Y + h + 0.6, pz), _v2.set((w + 1.4) * 0.5, 0.6, (w + 1.4) * 0.5), a
      ));

      this._towers.push({ x: px, y: MESA_Y + h + 1.2, z: pz, r: w * 0.5 });
      this._roofs.push({ x: px, y: MESA_Y + h + 1.2, z: pz, w, d: w });
    }

    /* Gatehouse. Two flanking blocks and a lintel: the arch the player walks in
     * under, and the first climb the game offers - low, wide, forgiving. */
    const gz = R;
    for (const sx of [-6.5, 6.5]) {
      B.box('stone.castle', 7, 14, 9, sx, MESA_Y + 7, gz, 0, 0xcdbd9b);
      this.track(this.physics.addBox(sx, MESA_Y + 7, gz, 3.5, 7, 4.5));
      B.box('stone.castle', 8.2, 0.6, 10.2, sx, MESA_Y + 8.4, gz, 0, 0xb4a286);
      this.track(this.physics.addBox(sx, MESA_Y + 8.4, gz, 4.1, 0.3, 5.1));
    }
    B.box('stone.castle', 20, 3.2, 9, 0, MESA_Y + 12.4, gz, 0, 0xc8b896);
    this.track(this.physics.addBox(0, MESA_Y + 12.4, gz, 10, 1.6, 4.5));
    this._roofs.push({ x: 0, y: MESA_Y + 14, z: gz, w: 20, d: 9 });

    B.flush(this.group, (k) => this._mat(k), 'wall');
    B.dispose();
  }

  /* ------------------------------------------------------------------ */
  /* Souk                                                                */
  /* ------------------------------------------------------------------ */

  /**
   * The lower town: flat-roofed blocks in a rough radial grid.
   *
   * Heights climb toward the citadel, and roof gaps widen with them. That is
   * the whole difficulty curve expressed as geometry: near the gate a player
   * can stroll between roofs, and by the inner ward they are committing to
   * running leaps. Every block gets a door lintel and a window course, which
   * exist to be gripped rather than looked at.
   */
  _buildSouk() {
    const B = new Batch();
    const rnd = this.rnd;
    const rings = 7;

    for (let ring = 0; ring < rings; ring++) {
      const r = 34 + ring * 12.5;
      const count = Math.max(8, Math.round((TAU * r) / 15));
      // Closer to the citadel = taller and further apart.
      const inward = 1 - ring / rings;
      for (let i = 0; i < count; i++) {
        const a = (i / count) * TAU + ring * 0.31 + (rnd() - 0.5) * 0.06;
        /* Keep the whole gate approach clear, at every ring.
         *
         * The first version only cleared the inner four, and the outer two
         * closed the corridor back up right where the player arrives - so the
         * spawn probe found a rooftop and dropped them onto it, staring at a
         * wall, in a world whose entire first impression is meant to be the
         * town rising toward the tower. A processional route has to be
         * processional the whole way in. */
        const towardGate = Math.abs(((a - Math.PI * 0.5 + Math.PI) % TAU) - Math.PI);
        if (towardGate < 0.26) continue;

        const px = Math.cos(a) * r;
        const pz = Math.sin(a) * r;
        const w = 8 + rnd() * 5;
        const d = 8 + rnd() * 5;
        const h = 5 + inward * 9 + rnd() * 3.5;
        const y0 = MESA_Y;
        const tint = 0xd8c9a4 - ((rnd() * 0x18) << 16);

        B.box('plaster.wall', w, h, d, px, y0 + h * 0.5, pz, a, tint);
        this.track(this.physics.addRotatedBox(
          _v1.set(px, y0 + h * 0.5, pz), _v2.set(w * 0.5, h * 0.5, d * 0.5), a
        ));

        // Roof lip - the ledge you actually mantle onto.
        B.box('stone.castle', w + 0.7, 0.55, d + 0.7, px, y0 + h + 0.27, pz, a, 0xbfae8a);
        this.track(this.physics.addRotatedBox(
          _v1.set(px, y0 + h + 0.27, pz), _v2.set((w + 0.7) * 0.5, 0.28, (d + 0.7) * 0.5), a
        ));
        this._roofs.push({ x: px, y: y0 + h + 0.55, z: pz, w, d, ring });

        /* Window course. Two bands of shallow boxes proud of the wall: the
         * handholds that make a plaster face climbable instead of blank. They
         * are colliders, which is the whole point - a decal would look the same
         * and grip nothing. */
        const bands = h > 9 ? 2 : 1;
        for (let bnd = 0; bnd < bands; bnd++) {
          const by = y0 + h * (bnd === 0 ? 0.42 : 0.74);
          B.box('wood.beam', w + 0.5, 0.34, d + 0.5, px, by, pz, a, 0x6d5334);
          this.track(this.physics.addRotatedBox(
            _v1.set(px, by, pz), _v2.set((w + 0.5) * 0.5, 0.17, (d + 0.5) * 0.5), a
          ));
        }

        // Parapet stubs on some roofs, so the skyline is not a flat plane.
        if (rnd() < 0.45) {
          const ph = 0.9 + rnd() * 0.6;
          B.box('plaster.wall', w * 0.9, ph, 0.5, px, y0 + h + 0.55 + ph * 0.5,
            pz + Math.cos(a) * d * 0.45, a, tint);
        }

        // An awning over the alley, and its posts: cover, and a mid-height perch.
        if (rnd() < 0.3) {
          const ax = px + Math.cos(a) * (d * 0.5 + 1.6);
          const az = pz + Math.sin(a) * (d * 0.5 + 1.6);
          B.box('fabric.banner', w * 0.8, 0.12, 3.2, ax, y0 + 3.4, az, a, 0xc2543a);
          this.track(this.physics.addRotatedBox(
            _v1.set(ax, y0 + 3.4, az), _v2.set(w * 0.4, 0.06, 1.6), a
          ));
        }
      }
    }

    B.flush(this.group, (k) => this._mat(k), 'souk');
    B.dispose();
  }

  /* ------------------------------------------------------------------ */
  /* Citadel                                                             */
  /* ------------------------------------------------------------------ */

  /**
   * The keep, the great tower and four minarets.
   *
   * The great tower is the world's high anchor at 46 m, and it is banded every
   * 7 m for exactly the reason set out in the file header: a continuous 46 m
   * face is not a climb, it is a stamina failure with a long fall attached.
   */
  _buildCitadel() {
    const B = new Batch();
    const cy = MESA_Y;

    // Raised inner ward, so the citadel reads as above the town it commands.
    const wardR = 30;
    const wardH = 6;
    B.box('stone.castle', wardR * 2, wardH, wardR * 2, 0, cy + wardH * 0.5, 0, 0, 0xc7b791);
    this.track(this.physics.addBox(0, cy + wardH * 0.5, 0, wardR, wardH * 0.5, wardR));
    const wardTop = cy + wardH;

    /* Stair up from the souk. The ward has to be reachable on foot as well as
     * by climbing - a vertical world that *requires* the vertical mechanic to
     * see its centrepiece is a world that locks out anyone still learning it. */
    for (let s = 0; s < 10; s++) {
      const sy = cy + (s + 0.5) * (wardH / 10);
      const sz = wardR + 6 - s * 0.7;
      B.box('stone.cobble', 9, wardH / 10, 1.6, 0, sy, sz, 0, 0xb6a68a);
      this.track(this.physics.addBox(0, sy, sz, 4.5, wardH / 20, 0.8));
    }

    // Keep.
    const kw = 26;
    const kh = 20;
    B.box('stone.castle', kw, kh, kw * 0.8, 0, wardTop + kh * 0.5, -4, 0, 0xd0c096);
    this.track(this.physics.addBox(0, wardTop + kh * 0.5, -4, kw * 0.5, kh * 0.5, kw * 0.4));
    for (const ly of [0.34, 0.68]) {
      const by = wardTop + kh * ly;
      B.box('stone.castle', kw + 1.2, 0.6, kw * 0.8 + 1.2, 0, by, -4, 0, 0xb5a483);
      this.track(this.physics.addBox(0, by, -4, (kw + 1.2) * 0.5, 0.3, (kw * 0.8 + 1.2) * 0.5));
    }
    B.box('stone.castle', kw + 2, 1.4, kw * 0.8 + 2, 0, wardTop + kh + 0.7, -4, 0, 0xc3b28f);
    this.track(this.physics.addBox(0, wardTop + kh + 0.7, -4, (kw + 2) * 0.5, 0.7, (kw * 0.8 + 2) * 0.5));
    this._roofs.push({ x: 0, y: wardTop + kh + 1.4, z: -4, w: kw, d: kw * 0.8 });

    /* Great tower. The high anchor and the leap-of-faith platform. */
    const tw = 11;
    const th = 46;
    const tx = 0;
    const tz = -18;
    B.box('stone.castle', tw, th, tw, tx, wardTop + th * 0.5, tz, 0, 0xd6c69c);
    this.track(this.physics.addBox(tx, wardTop + th * 0.5, tz, tw * 0.5, th * 0.5, tw * 0.5));
    // Rest ledges every 7 m. Load-bearing for the climb, not decoration.
    for (let y = 7; y < th; y += 7) {
      B.box('stone.castle', tw + 1.5, 0.55, tw + 1.5, tx, wardTop + y, tz, 0, 0xb9a887);
      this.track(this.physics.addBox(tx, wardTop + y, tz, (tw + 1.5) * 0.5, 0.28, (tw + 1.5) * 0.5));
    }
    // Crown and the jutting beam a leap of faith launches from.
    B.box('stone.castle', tw + 2.4, 1.6, tw + 2.4, tx, wardTop + th + 0.8, tz, 0, 0xcabb96);
    this.track(this.physics.addBox(tx, wardTop + th + 0.8, tz, (tw + 2.4) * 0.5, 0.8, (tw + 2.4) * 0.5));
    B.box('wood.beam', 1.1, 0.5, 7, tx, wardTop + th + 1.9, tz + 5, 0, 0x5d462c);
    this.track(this.physics.addBox(tx, wardTop + th + 1.9, tz + 5, 0.55, 0.25, 3.5));

    const towerTopY = wardTop + th + 1.6;
    this._towers.push({ x: tx, y: towerTopY, z: tz, r: tw * 0.5 });
    this.viewpoints.push({ x: tx, y: towerTopY, z: tz, name: 'The Great Tower' });

    /* Minarets: four thin towers, the rope-bridge anchors. Thin is the point -
     * they are the hardest free-climbs in the world because there is no wide
     * face to rest on, only the balcony rings. */
    for (let i = 0; i < 4; i++) {
      const a = (i / 4) * TAU + Math.PI * 0.25;
      const px = Math.cos(a) * 21;
      const pz = Math.sin(a) * 21;
      const mh = 30;
      const mw = 4.4;
      B.box('plaster.wall', mw, mh, mw, px, wardTop + mh * 0.5, pz, a, 0xe0d2ae);
      this.track(this.physics.addRotatedBox(
        _v1.set(px, wardTop + mh * 0.5, pz), _v2.set(mw * 0.5, mh * 0.5, mw * 0.5), a
      ));
      // Balcony rings.
      for (const by of [11, 21]) {
        B.box('wood.beam', mw + 2.2, 0.4, mw + 2.2, px, wardTop + by, pz, a, 0x6a5133);
        this.track(this.physics.addRotatedBox(
          _v1.set(px, wardTop + by, pz), _v2.set((mw + 2.2) * 0.5, 0.2, (mw + 2.2) * 0.5), a
        ));
      }
      B.box('roof.tile', mw + 1.6, 1.5, mw + 1.6, px, wardTop + mh + 0.75, pz, a, 0x8fa2b4);
      this.track(this.physics.addRotatedBox(
        _v1.set(px, wardTop + mh + 0.75, pz), _v2.set((mw + 1.6) * 0.5, 0.75, (mw + 1.6) * 0.5), a
      ));
      this._towers.push({ x: px, y: wardTop + mh + 1.5, z: pz, r: mw * 0.5, minaret: true });
      this.viewpoints.push({ x: px, y: wardTop + mh + 1.5, z: pz, name: `Minaret ${i + 1}` });
    }

    B.flush(this.group, (k) => this._mat(k), 'citadel');
    B.dispose();
  }

  /* ------------------------------------------------------------------ */
  /* Rope bridges                                                        */
  /* ------------------------------------------------------------------ */

  /**
   * Plank bridges strung between the minarets and the great tower.
   *
   * Each plank is its own collider. That is more colliders than a single long
   * box would be, but a bridge you can fall *between* is a bridge the player
   * reads as real, and the broadphase grid makes the cost of a few hundred
   * small boxes negligible.
   */
  _buildRopeBridges() {
    const B = new Batch();
    const minarets = this._towers.filter((t) => t.minaret);
    if (minarets.length < 2) return;

    const links = [];
    for (let i = 0; i < minarets.length; i++) {
      links.push([minarets[i], minarets[(i + 1) % minarets.length]]);
    }
    // And one span from a minaret out to a wall tower, so the network reaches
    // the perimeter rather than looping only around the citadel.
    const outer = this._towers.find((t) => !t.minaret && t.y < MESA_Y + 34);
    if (outer) links.push([minarets[0], outer]);

    for (const [a, b] of links) {
      const dx = b.x - a.x;
      const dz = b.z - a.z;
      const span = Math.hypot(dx, dz);
      if (span < 6 || span > 90) continue;
      const dirY = Math.atan2(dz, dx);
      const steps = Math.max(6, Math.round(span / 1.4));
      const y0 = Math.min(a.y, b.y) - 0.6;

      for (let s = 0; s <= steps; s++) {
        const t = s / steps;
        const px = a.x + dx * t;
        const pz = a.z + dz * t;
        // Catenary sag - a taut bridge reads as a girder, a sagging one as rope.
        const sag = Math.sin(t * Math.PI) * Math.min(3.4, span * 0.055);
        const py = y0 + (b.y - a.y) * t - sag;
        B.box('wood.plank', 1.15, 0.13, 2.2, px, py, pz, dirY, 0x74583a);
        this.track(this.physics.addRotatedBox(
          _v1.set(px, py, pz), _v2.set(0.6, 0.09, 1.1), dirY
        ));
        // Hand ropes either side, as thin rails.
        if (s % 2 === 0) {
          for (const side of [-1, 1]) {
            const ox = Math.cos(dirY + Math.PI / 2) * 1.05 * side;
            const oz = Math.sin(dirY + Math.PI / 2) * 1.05 * side;
            B.box('wood.beam', 1.3, 0.08, 0.08, px + ox, py + 0.95, pz + oz, dirY, 0x4f3d28);
          }
        }
      }
    }

    B.flush(this.group, (k) => this._mat(k), 'bridges', { cast: true, recv: false });
    B.dispose();
  }

  /* ------------------------------------------------------------------ */
  /* Dressing                                                            */
  /* ------------------------------------------------------------------ */

  /**
   * Haystacks, market stalls and banners.
   *
   * The haystacks are the important part and they are placed by rule, not by
   * eye: one under every viewpoint, so a leap of faith always has an answer.
   * `Player` reads `world.haystacks` to know a fall is survivable.
   */
  _buildDressing() {
    const B = new Batch();
    const rnd = this.rnd;

    // A haystack below each viewpoint, offset toward the open side.
    for (const vp of this.viewpoints) {
      const a = Math.atan2(vp.z, vp.x);
      const hx = vp.x + Math.cos(a) * 7.5;
      const hz = vp.z + Math.sin(a) * 7.5;
      const hy = this._groundAt(hx, hz);
      B.box('thatch.roof', 5.2, 2.4, 5.2, hx, hy + 1.2, hz, rnd() * 0.4, 0xd8bd6e);
      this.track(this.physics.addBox(hx, hy + 1.0, hz, 2.6, 1.0, 2.6));
      this.haystacks.push({ x: hx, y: hy + 2.4, z: hz, r: 3.2 });
    }

    // A few more along the rampart, under the traversal line.
    for (let i = 0; i < 6; i++) {
      const a = (i / 6) * TAU + 0.7;
      const hx = Math.cos(a) * 104;
      const hz = Math.sin(a) * 104;
      const hy = this._groundAt(hx, hz);
      B.box('thatch.roof', 4.6, 2.2, 4.6, hx, hy + 1.1, hz, rnd() * 0.5, 0xd2b768);
      this.track(this.physics.addBox(hx, hy + 0.95, hz, 2.3, 0.95, 2.3));
      this.haystacks.push({ x: hx, y: hy + 2.2, z: hz, r: 2.9 });
    }

    // Market stalls in the plaza, and crates that make good first steps.
    for (let i = 0; i < 34; i++) {
      const a = rnd() * TAU;
      const r = 40 + rnd() * 62;
      const px = Math.cos(a) * r;
      const pz = Math.sin(a) * r;
      const py = MESA_Y;
      const w = 1.6 + rnd() * 1.2;
      B.box('wood.plank', w, 1.0, w, px, py + 0.5, pz, rnd() * TAU, 0x7d5f3c);
      this.track(this.physics.addBox(px, py + 0.5, pz, w * 0.5, 0.5, w * 0.5));
      if (rnd() < 0.5) {
        B.box('fabric.banner', w + 1.4, 0.1, w + 1.4, px, py + 2.5, pz, rnd() * TAU,
          rnd() < 0.5 ? 0xb8452f : 0x2f6ba8);
      }
    }

    B.flush(this.group, (k) => this._mat(k), 'dressing');
    B.dispose();

    /* Banners on the keep - the one animated thing in the world, so the town
     * does not read as a still life. Kept to a handful of separate meshes
     * because they need their own per-frame transform. */
    const banner = this._mat('fabric.banner');
    for (let i = 0; i < 6; i++) {
      const a = (i / 6) * TAU;
      const geo = new THREE.PlaneGeometry(2.2, 5.4, 1, 6);
      this._owned.push(geo);
      const m = new THREE.Mesh(geo, banner);
      m.position.set(Math.cos(a) * 14, MESA_Y + 24, Math.sin(a) * 14 - 4);
      m.rotation.y = a + Math.PI / 2;
      m.castShadow = true;
      m.name = 'citadel:banner';
      this.group.add(m);
      this._banners.push({ mesh: m, phase: i * 1.7, geo });
    }
  }

  /** Plateau-aware ground height, without a raycast. */
  _groundAt(x, z) {
    const r = Math.hypot(x, z);
    if (r < MESA_R) return MESA_Y;
    const t = Math.min(1, (r - MESA_R) / 46);
    return MESA_Y * (1 - t * t * (3 - 2 * t));
  }

  /* ------------------------------------------------------------------ */
  /* Spawns, portals, minimap                                            */
  /* ------------------------------------------------------------------ */

  _fillSpawns() {
    /* Just inside the gate, facing the citadel.
     *
     * Yaw 0, not PI: characters look down -Z at yaw 0, and the town is at -Z
     * from here. Facing PI put the player's back to the entire world and their
     * nose against the return portal, which is the exact opposite of the
     * establishing shot this spawn exists to frame - the souk stepping up ring
     * by ring to the great tower. */
    this.playerSpawn.set(0, MESA_Y + 0.3, 104);
    this.playerSpawnYaw = 0;

    this.portalSpecs.push({
      position: new THREE.Vector3(0, MESA_Y + 0.3, 112),
      rotationY: Math.PI,
      target: 'station',
      label: 'Aether Station',
      accent: 0x4de3ff,
    });

    const F = (name, persona, x, z) => ({
      position: new THREE.Vector3(x, MESA_Y + 0.2, z),
      type: 'friendly',
      name,
      persona,
    });
    this.npcSpawns.push(
      F('Rafiq the Keeper', 'Keeper of the citadel archive; speaks in riddles about the old order.', 6, 92),
      F('Hafsa the Dyer', 'Runs the cloth stall by the gate; knows every roof in the souk.', -12, 84),
      F('Bashir the Ostler', 'Tends the horses below the wall; gruff, fond of his animals.', 20, 96),
      F('Yusra the Falconer', 'Flies the eagles from the great tower; watches everything.', -4, 40),
    );
    for (let i = 0; i < 8; i++) {
      const a = (i / 8) * TAU;
      this.npcSpawns.push({
        position: new THREE.Vector3(Math.cos(a) * 62, MESA_Y + 0.2, Math.sin(a) * 62),
        type: 'hostile',
      });
    }

    /* Minimap. The plateau, the wall ring and the citadel - enough to orient by
     * without drawing four hundred houses. */
    this.minimapShapes.push(
      { kind: 'circle', x: 0, z: 0, r: MESA_R + 20, fill: 0x2a2418 },
      { kind: 'circle', x: 0, z: 0, r: MESA_R, fill: 0x4a412c },
      { kind: 'circle', x: 0, z: 0, r: 118, stroke: 0xc8b68e, width: 3 },
      { kind: 'circle', x: 0, z: 0, r: 30, fill: 0x6b5f42 },
      { kind: 'rect', x: 0, z: -18, w: 12, d: 12, fill: 0xd6c69c },
      { kind: 'rect', x: 0, z: 118, w: 22, d: 10, fill: 0xc8b68e }
    );
    for (const t of this._towers) {
      this.minimapShapes.push({ kind: 'circle', x: t.x, z: t.z, r: 3.2, fill: 0xbfae8a });
    }
  }

  /* ------------------------------------------------------------------ */
  /* Frame                                                               */
  /* ------------------------------------------------------------------ */

  update(dt) {
    this._time += dt;
    // Banners only - everything else in this world is static, and it should be:
    // a climbing surface that moves is a climbing surface that betrays you.
    for (const b of this._banners) {
      b.mesh.rotation.z = Math.sin(this._time * 1.6 + b.phase) * 0.09;
    }
  }

  dispose() {
    for (const g of this._owned) g.dispose?.();
    this._owned.length = 0;
    this._banners.length = 0;
    this._roofs.length = 0;
    this._towers.length = 0;
    this.haystacks.length = 0;
    this.viewpoints.length = 0;
    this._matCache?.clear();
    super.dispose();
  }
}

export default CitadelWorld;
