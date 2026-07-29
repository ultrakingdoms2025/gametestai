import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { sweep, blob } from '../gfx/Organic.js';
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
const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
/** Edge round applied to batched boxes, and the size below which it is skipped. */
const BEVEL = 0.075;
const BEVEL_MIN = 0.55;

/** Playfield half-extent. Matches the other worlds so the minimap framing does. */
const HALF = 200;
/** Height of the plateau the town sits on, above the surrounding desert. */
const MESA_Y = 14;
/** Where the plateau edge falls away to the approach road. */
const MESA_R = 132;
/** Horizontal distance the shoulder takes to fall from the mesa to the desert. */
const SHOULDER = 46;

/**
 * Ground height, as a pure function of distance from the centre.
 *
 * The single source of truth for the shape of this world's terrain: the visible
 * heightfield, the collision that backs it, and every prop placement all read
 * it. That is the entire point of it existing.
 *
 * It was previously three separate approximations of the same slope - a
 * smoothstep in the mesh, a square slab plus a sparse ring of boxes in the
 * collision, and a third copy in `_groundAt`. They disagreed, and where the
 * collision sat lower than the mesh the player walked *underneath* the visible
 * world: 7% of sampled positions, by as much as 13 m. Radial and shared, so the
 * three can no longer drift apart.
 *
 * Deliberately free of x/z noise. Dunes are built as real geometry with real
 * colliders instead, because noise in here is noise the box colliders cannot
 * reproduce, and that is the same bug again in a smaller size.
 */
function terrainH(r) {
  if (r < MESA_R) return MESA_Y;
  const t = Math.min(1, (r - MESA_R) / SHOULDER);
  return MESA_Y * (1 - t * t * (3 - 2 * t));
}

/**
 * Limewash and mudbrick. Sampled from sun-bleached North African towns, where
 * the range is narrow in hue and wide in lightness - which is exactly what
 * stops a procedural town looking either monotone or like a paint chart.
 */
const WASH = [
  0xe8dcc0, 0xdfd0ae, 0xd6c49e, 0xcbb68d, 0xe3d2b2,
  0xd8c8a8, 0xc9b489, 0xecdfc4, 0xd2bd97, 0xdcccA6,
  0xc6ae86, 0xe6d8bb, 0xd9c9a2, 0xcfbb92,
];

/** Weathered sandstone, for the cliff the mesa stands on. */
const CLIFF = [0xc0ad86, 0xb6a37c, 0xcab791, 0xac9a73, 0xc4b088, 0xbaa87f];

/** One of `list`, with a small per-pick lightness jitter so no two repeat exactly. */
function pick(rnd, list) {
  const base = list[(rnd() * list.length) | 0];
  const f = 0.9 + rnd() * 0.2;
  const r = Math.min(255, ((base >> 16) & 255) * f) | 0;
  const g = Math.min(255, ((base >> 8) & 255) * f) | 0;
  const b = Math.min(255, (base & 255) * f) | 0;
  return (r << 16) | (g << 8) | b;
}

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
  /**
   * @param {{ao?:number, sky?:number, grime?:number, span?:number}} [shade]
   *   Baked vertex shading applied to every geometry added to this batch.
   *   - `ao`     how dark the foot of a surface goes (0..1)
   *   - `sky`    how much a downward-facing surface loses relative to an
   *              upward-facing one - a one-line hemispheric occlusion term
   *   - `grime`  warm-to-cool shift applied with the AO, so the dark end is
   *              dirt rather than simply less light
   *   - `span`   metres over which the AO fades out from the foot
   */
  constructor(shade = null) {
    /** @type {Map<string, THREE.BufferGeometry[]>} */
    this.buckets = new Map();
    this._owned = [];
    this.shade = shade;
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

    /* Baked vertex shading.
     *
     * Everything in this world is a box, and a box lit by one sun is four flat
     * rectangles - the town reads as cardboard no matter how good the material
     * is. Two cheap per-vertex terms fix that for the whole world at once:
     *
     *   AO    darkens the foot of every surface, so buildings sit *in* the
     *         ground instead of resting on top of it, and alleys gain the
     *         contact shadow that no dynamic light will ever draw for 1400
     *         boxes.
     *   Sky   darkens downward-facing faces against upward-facing ones. It is
     *         a one-line hemispheric occlusion term, and it is what separates
     *         the underside of a lintel from its top.
     *
     * Both are free at runtime - they are just the colour attribute that had to
     * be written anyway - and they survive the merge into a single mesh, which
     * a light never could. */
    const sh = this.shade;
    if (!sh) {
      for (let i = 0; i < n; i++) {
        col[i * 3] = _color.r;
        col[i * 3 + 1] = _color.g;
        col[i * 3 + 2] = _color.b;
      }
    } else {
      const posA = g.attributes.position;
      const nrmA = g.attributes.normal;
      const ao = sh.ao ?? 0;
      const sky = sh.sky ?? 0;
      const grime = sh.grime ?? 0;
      const span = sh.span ?? 2.2;
      // Foot of *this* piece, in world space - so a roof lip is shaded from its
      // own underside, not from the ground 20 m below it.
      let minY = Infinity;
      let maxY = -Infinity;
      for (let i = 0; i < n; i++) {
        const y = posA.getY(i);
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
      /* Never run the gradient over more than the piece is tall.
       *
       * The span is chosen for walls, and a wall is metres high, so the darkest
       * part of the ramp lands at its foot and the rest is clean. Applied
       * unchanged to something thin - a palm frond is 9 cm thick - the whole
       * piece sits inside the first 4% of the ramp and comes out uniformly at
       * the *bottom* of it. The palms rendered as black silhouettes for exactly
       * this reason. Clamping the span to the piece's own height gives thin work
       * a dark underside and a lit top, which is what was wanted from it. */
      const s = Math.min(span, Math.max(maxY - minY, 0.02));

      for (let i = 0; i < n; i++) {
        const t = clamp01((posA.getY(i) - minY) / s);
        // smoothstep, so the gradient has no visible band where it ends
        const rise = t * t * (3 - 2 * t);
        let f = 1 - ao * (1 - rise);
        if (nrmA) {
          const ny = nrmA.getY(i);
          f *= 1 - sky * (1 - (ny * 0.5 + 0.5));
        }
        // Dirt is cooler as well as darker; scaling blue least would *warm* the
        // shadows, which is the opposite of how a shaded wall photographs.
        const d = (1 - f) * grime;
        col[i * 3] = _color.r * f * (1 - d * 0.15);
        col[i * 3 + 1] = _color.g * f * (1 - d * 0.06);
        col[i * 3 + 2] = _color.b * f;
      }
    }
    g.setAttribute('color', new THREE.BufferAttribute(col, 3));
    let list = this.buckets.get(key);
    if (!list) this.buckets.set(key, (list = []));
    list.push(g);
  }

  /**
   * Convenience for the overwhelmingly common case: an axis-aligned box.
   *
   * Bevelled, not square. A hard 90-degree edge returns exactly one shade to
   * the camera, so a town built from plain boxes has no edges in it at all -
   * just flat panels meeting at invisible seams, which is what "blocky" really
   * describes. A few centimetres of round on every edge gives each one a
   * highlight on the sunward side and a dark line away from it, and every
   * silhouette in the world stops being a cut-out.
   *
   * Only the pieces big enough for it to read.
   *
   * A bevelled box costs 108 triangles against a plain one's 12, and this world
   * emits something like twelve thousand of them - the window trim alone is
   * nine thousand. Bevelling all of it cost three million triangles and half the
   * frame rate to round the edges of sills a few centimetres across, which
   * nobody can see. Above the threshold it is walls, roofs, towers and cliff
   * steps: the silhouettes the eye actually reads. Below it, trim stays square
   * and free.
   *
   * The radius is clamped against the smallest dimension regardless, because a
   * bevel wider than the piece it is rounding turns the piece inside out.
   */
  box(key, w, h, d, x, y, z, rotY = 0, tint = null) {
    _e1.set(0, rotY, 0);
    _q1.setFromEuler(_e1);
    _v1.set(x, y, z);
    _v2.set(1, 1, 1);
    _m1.compose(_v1, _q1, _v2);
    const min = Math.min(w, h, d);
    const r = Math.min(BEVEL, w * 0.22, h * 0.22, d * 0.22);
    const geo = min >= BEVEL_MIN && r > 0.02
      ? new RoundedBoxGeometry(w, h, d, 1, r)
      : new THREE.BoxGeometry(w, h, d);
    this.add(key, geo, _m1, tint);
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
    /* Shadow colour is the whole difficulty of a desert scene.
     *
     * The first pass used a cool blue-grey ambient, which is what daylight
     * physically is - and over red-brown ground it rendered every shadow
     * *purple*. Real sun-baked stone bounces a great deal of warm light back
     * into its own shade, so the fill here is warm and the sky term carries the
     * cool. Shadows land brown rather than violet, and the town stops looking
     * like it is lit through a bruise. */
    env.ambientColor = new THREE.Color(0xa8977f);
    env.ambientIntensity = 0.7;
    env.skyColor = new THREE.Color(0xa8c6e6);
    env.groundColor = new THREE.Color(0xc9a173);   // hot sand bouncing upward
    env.hemiIntensity = 1.15;
    env.sunColor = new THREE.Color(0xffddA6);
    env.sunIntensity = 5.9;
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
  /**
   * @param {string} key
   * @param {{vertexColors?:boolean}} [opts] pass `vertexColors: false` for
   *   geometry that carries no colour attribute - notably the instanced trees.
   *   A material with `vertexColors` on and nothing to read renders black,
   *   which is the same trap the batched geometry hit early on.
   */
  _mat(key, opts = {}) {
    const vc = opts.vertexColors !== false;
    this._matCache ??= new Map();
    const cacheKey = vc ? key : `${key}|novc`;
    const hit = this._matCache.get(cacheKey);
    if (hit) return hit;

    const base = this.materials.get(key);
    const m = base.clone();
    m.name = `citadel.${key}`;
    m.vertexColors = vc;
    // Sun-bleached limestone and mudbrick, per surface family.
    /* These multiply the per-box vertex colour, so they have to stay near white.
     *
     * Both ends of this were authored as if they were the only one: `Batch.box`
     * callers pass the actual colour they want the piece to be, and these were
     * written as colours too. Two mid-tones multiplied give a third much darker
     * than either - wood.beam at 0xb9946a against a 0x8a6a45 trunk resolved to
     * 0x3e2712, which is why the palms and every beam in the world came out
     * nearly black. Their job is a warm shift, not a colour. */
    const TINT = {
      'stone.castle': 0xf4ecd8,
      'plaster.wall': 0xf6ecd6,
      'stone.cobble': 0xe8ddc2,
      'wood.beam': 0xf0e2cc,
      'wood.plank': 0xf2e4cc,
      'roof.tile': 0xeae2d0,
      'thatch.roof': 0xffe9a8,
      'fabric.banner': 0xffffff,
      'dirt.ground': 0xe0cda3,
      // Date palm, not meadow: the library's grass is a temperate green and a
      // desert frond is grey-olive. Same material, one tint apart.
      'grass.field': 0xdce8c0,
    };
    const t = TINT[key.split(':')[0]];
    if (t !== undefined) m.color = new THREE.Color(t);
    this._matCache.set(cacheKey, m);
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
    /* Painted equirectangular, not a 1-D ramp.
     *
     * A vertical gradient is the same in every direction, which means the sky
     * has no *place* in it: turn on the spot and nothing changes, and the top
     * third of a world played on rooftops is dead pixels. A sphere's UVs are
     * already equirectangular, so a 2-D canvas costs exactly the same one draw
     * call and buys a sun, its glow, and cloud banding that gives the eye
     * something to measure the horizon against. */
    const W = 1024;
    const H = 512;
    const cv = document.createElement('canvas');
    cv.width = W;
    cv.height = H;
    const c = cv.getContext('2d');

    const grd = c.createLinearGradient(0, 0, 0, H);
    grd.addColorStop(0.0, '#2e63ab');   // zenith
    grd.addColorStop(0.34, '#6fa0cf');
    grd.addColorStop(0.60, '#a8c4d8');
    grd.addColorStop(0.76, '#dbcfb2');  // haze
    grd.addColorStop(1.0, '#e8d6b0');   // dust at the horizon
    c.fillStyle = grd;
    c.fillRect(0, 0, W, H);

    /* The sun, placed where the light actually comes from.
     *
     * `sunDirection` is authored once in `_configureEnvironment`; deriving the
     * disc from it means the glow in the sky and the shadows on the ground can
     * never disagree, which is the sort of mismatch that reads as "wrong"
     * without a player being able to say why. */
    const sd = this.environment.sunDirection;
    const su = ((Math.atan2(-sd.x, -sd.z) / TAU) + 0.75) % 1;
    const sv = clamp01(0.5 - Math.asin(clamp01(sd.y)) / Math.PI);
    const sx = su * W;
    const sy = sv * H;
    // Wrapped: a glow near the seam has to be painted on both sides of it.
    for (const ox of [-W, 0, W]) {
      const glow = c.createRadialGradient(sx + ox, sy, 0, sx + ox, sy, W * 0.30);
      glow.addColorStop(0.00, 'rgba(255,247,225,0.95)');
      glow.addColorStop(0.06, 'rgba(255,236,190,0.55)');
      glow.addColorStop(0.22, 'rgba(255,224,170,0.20)');
      glow.addColorStop(1.00, 'rgba(255,220,165,0)');
      c.fillStyle = glow;
      c.fillRect(sx + ox - W * 0.3, sy - W * 0.3, W * 0.6, W * 0.6);
      const disc = c.createRadialGradient(sx + ox, sy, 0, sx + ox, sy, W * 0.017);
      disc.addColorStop(0, 'rgba(255,253,246,1)');
      disc.addColorStop(1, 'rgba(255,246,222,0)');
      c.fillStyle = disc;
      c.fillRect(sx + ox - W * 0.02, sy - W * 0.02, W * 0.04, W * 0.04);
    }

    /* Cloud banding.
     *
     * Stretched ellipses, squashed harder the nearer the horizon so they
     * foreshorten the way real cloud decks do, and drawn from the world's own
     * PRNG so the sky is identical every session like everything else here. */
    const rnd = this.rnd;
    c.globalCompositeOperation = 'source-over';
    /* A deck between roughly 40 degrees of elevation and the horizon.
     *
     * The band matters as much as the clouds do. On an equirectangular map the
     * rows near v = 0 are the *pole*, where the whole width of the canvas
     * collapses to a point - a cloud painted up there wraps into a hard streak
     * across the zenith, which is exactly what the first attempt produced. Held
     * to the middle of the map it stays a cloud, and dividing the horizontal
     * radius by sin(pi t) undoes what is left of the compression so they read as
     * round overhead and foreshortened toward the horizon, like a real deck. */
    /* Sparse, and spread over a wide band.
     *
     * Once the gradients actually painted, the first honest render was solid
     * overcast: 120 clouds inside a 0.22-wide band overlap into one continuous
     * ring around the sky, which reads as a lid rather than as weather. Fewer,
     * smaller, fainter, and spread nearly twice as far vertically leaves the
     * gaps that make the rest of them look like individual clouds. */
    for (let i = 0; i < 30; i++) {
      // Biased toward the top of the band, not the bottom: an exponent below 1
      // pushes the distribution *up* the range, which piled every cloud into the
      // horizon fade below and made the deck invisible.
      const t = 0.20 + Math.pow(rnd(), 1.5) * 0.26;
      const y = t * H;
      const x = rnd() * W;
      const stretch = 1 / Math.max(0.55, Math.sin(Math.PI * t));
      const rx = (20 + rnd() * 54) * stretch;
      const ry = rx * (0.15 + rnd() * 0.12) / stretch;
      // Faded out near the horizon so the deck meets the haze instead of
      // stopping at a line, but strong enough overhead to actually be weather.
      const a = (0.16 + rnd() * 0.26) * (1 - clamp01((t - 0.38) / 0.08));
      if (a <= 0.005) continue;
      /* Shadowed base first, lit body offset slightly above it.
       *
       * A cloud painted as one soft blob is a smudge; what makes it read as a
       * solid object with weight is a darker underside under a top that catches
       * the sun. Two passes, and the offset between them is the whole trick.
       *
       * Each gradient is built *inside* the transform it is painted under. A
       * canvas gradient lives in user space at fill time, so one created in page
       * coordinates and then filled after `translate`/`scale` has its centre
       * dragged somewhere else entirely and the shape comes out filled with the
       * transparent tail - which is why the first two attempts at this painted a
       * sky with no clouds in it at all. */
      const puff = (cx, cy, stops) => {
        for (const ox of [-W, 0, W]) {
          c.save();
          c.translate(cx + ox, cy);
          c.scale(1, ry / rx);
          const g2 = c.createRadialGradient(0, 0, 0, 0, 0, rx);
          for (const [at, col] of stops) g2.addColorStop(at, col);
          c.fillStyle = g2;
          c.beginPath();
          c.arc(0, 0, rx, 0, TAU);
          c.fill();
          c.restore();
        }
      };

      puff(x, y + ry * 0.55, [
        [0.0, `rgba(146,154,170,${a * 0.5})`],
        [0.6, `rgba(160,168,182,${a * 0.2})`],
        [1.0, 'rgba(160,168,182,0)'],
      ]);
      puff(x, y - ry * 0.35, [
        [0.00, `rgba(255,254,251,${a})`],
        [0.42, `rgba(251,247,240,${a * 0.72})`],
        [0.78, `rgba(246,241,232,${a * 0.26})`],
        [1.00, 'rgba(244,238,228,0)'],
      ]);
    }

    const tex = new THREE.CanvasTexture(cv);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.wrapS = THREE.RepeatWrapping;
    tex.anisotropy = 4;
    tex.needsUpdate = true;

    // More segments than a plain ramp needed: the sun disc is a small feature
    // on a big sphere and a coarse mesh gives it visibly polygonal edges.
    const geo = new THREE.SphereGeometry(900, 48, 32);
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
      pos.setY(i, terrainH(Math.hypot(pos.getX(i), pos.getZ(i))));
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

    /* ---- collision that can never sit below the mesh ------------------- *
     *
     * The rule for every collider below: its top is the height of the *highest*
     * point of the mesh it covers. Then the player is always standing on or a
     * little above what they can see, and never inside or underneath it. A
     * collider that splits the difference looks better on paper and puts the
     * camera under the world at the top of the slope.
     *
     * The plateau used to be a single square slab of half-extent MESA_R + 4.
     * The mesa is a *circle* of radius MESA_R, so the slab's corners projected
     * invisible floor out to r = 192 at full mesa height, while the mesh there
     * had already fallen to the desert - and the reverse gap, mesh above
     * collision, opened all the way round the shoulder. */
    const PIE = 40;
    for (let i = 0; i < PIE; i++) {
      const a = (i / PIE) * TAU;
      // Circumscribed half-width, so neighbouring slices overlap rather than
      // leaving a wedge of nothing between them at the rim.
      const halfW = MESA_R * Math.tan(Math.PI / PIE) * 1.35;
      this.track(this.physics.addRotatedBox(
        _v1.set(Math.cos(a) * MESA_R * 0.5, MESA_Y - 5, Math.sin(a) * MESA_R * 0.5),
        _v2.set(MESA_R * 0.5 + 0.5, 5, halfW),
        -a
      ));
    }

    /* The shoulder, as concentric rings stepping down. Each ring is set to the
     * height of its inner edge - the highest ground it spans - so the staircase
     * is always at or above the slope it approximates. */
    const RINGS = 16;
    const SECT = 48;
    for (let ring = 0; ring < RINGS; ring++) {
      const rIn = MESA_R + (ring / RINGS) * SHOULDER;
      const rOut = MESA_R + ((ring + 1) / RINGS) * SHOULDER;
      const top = terrainH(rIn);
      const mid = (rIn + rOut) * 0.5;
      const depth = (rOut - rIn) * 0.5 + 0.6;          // overlap the next ring
      const halfW = (Math.PI * mid) / SECT * 1.35;     // and the next sector
      for (let s = 0; s < SECT; s++) {
        const a = (s / SECT) * TAU;
        this.track(this.physics.addRotatedBox(
          _v1.set(Math.cos(a) * mid, top - 6, Math.sin(a) * mid),
          _v2.set(depth, 6, halfW),
          -a
        ));
      }
    }

    /* The cliff ring: boxes stepped down the shoulder. Also the world's biggest
     * climbable face - the whole point of putting the town on a mesa. */
    // Long span: a cliff step is metres tall, so the gradient has to run the
    // whole height or it reads as a painted stripe near the base.
    const B = new Batch({ ao: 0.42, sky: 0.3, grime: 0.5, span: 9 });
    const steps = 7;
    for (let s = 0; s < steps; s++) {
      // Read from the shared height function, so the visible rock and the
      // collision rings underneath it step down together instead of each
      // following its own curve.
      const rIn = MESA_R + (s / steps) * SHOULDER;
      const rOut = MESA_R + ((s + 1) / steps) * SHOULDER;
      const y = terrainH(rIn);
      const h = y - terrainH(rOut);
      if (h < 0.25) continue;
      const n = 72;
      for (let i = 0; i < n; i++) {
        const a = (i / n) * TAU;
        const jitter = 1 + (rnd() - 0.5) * 0.05;
        const px = Math.cos(a) * rIn * jitter;
        const pz = Math.sin(a) * rIn * jitter;
        const w = (TAU * rIn) / n * 1.3;
        const d = (rOut - rIn) * 1.15;
        B.box('stone.castle', w, h * 1.9, d, px, y - h * 0.45, pz, a + Math.PI / 2,
          pick(rnd, CLIFF));
        this.track(this.physics.addRotatedBox(
          _v1.set(px, y - h * 0.45, pz),
          _v2.set(w * 0.5, h * 0.95, d * 0.5),
          a + Math.PI / 2
        ));
      }
    }

    /* Dunes, as geometry rather than as noise in the heightfield.
     *
     * The mesh used to carry a sine-based dune field that nothing collided
     * with, so the desert's crests were solid to the eye and empty to the
     * player. Built as real boxes they get real colliders, and the flat mesh
     * underneath them is a floor that agrees with itself. */
    /* Low and wide, in three shallow tiers.
     *
     * The first pass built these nearly 6 m tall in two steps, which in a desert
     * you cross on horseback is not scenery, it is a wall - the test horse
     * spawned against one and could not move at all. Each tier is now a step
     * about half a metre high, which a rider goes over without noticing and
     * which still breaks up a flat plain when the light rakes across it. */
    for (let i = 0; i < 70; i++) {
      const a = rnd() * TAU;
      const r = MESA_R + SHOULDER + 10 + rnd() * 92;
      const px = Math.cos(a) * r;
      const pz = Math.sin(a) * r;
      if (Math.abs(px) > HALF - 10 || Math.abs(pz) > HALF - 10) continue;
      const dw = 20 + rnd() * 34;
      const dd = 10 + rnd() * 16;
      const step = 0.42 + rnd() * 0.3;
      const da = rnd() * TAU;
      for (let k = 0; k < 3; k++) {
        const shrink = 1 - k * 0.28;
        B.box('dirt.ground', dw * shrink, step, dd * shrink,
          px, step * (k + 0.5), pz, da, k === 2 ? 0xf0dfb6 : 0xe8d5aa);
        this.track(this.physics.addRotatedBox(
          _v1.set(px, step * (k + 0.5), pz),
          _v2.set(dw * shrink * 0.5, step * 0.5, dd * shrink * 0.5), da
        ));
      }
    }

    B.flush(this.group, (k) => this._mat(k), 'cliff', { cast: true, recv: true });
    B.dispose();

    // Desert floor collider, its top exactly on the mesh's desert level.
    this.track(this.physics.addBox(0, -6, 0, HALF * 1.6, 6, HALF * 1.6));

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
    const B = new Batch({ ao: 0.4, sky: 0.34, grime: 0.55, span: 5 });
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
    // The strongest of the set. The souk is where the player spends most of
    // their time at eye level, and alley contact shadow is most of what sells
    // a town built entirely from boxes.
    const B = new Batch({ ao: 0.46, sky: 0.34, grime: 0.65, span: 3.4 });
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
        /* Per-building colour, drawn from a real palette.
         *
         * The first version subtracted a small random amount from the *red*
         * channel only, which varies four hundred houses across a range narrower
         * than the eye can see - the town came out one flat sheet of mustard.
         * A hand-picked set of limewash and mudbrick tones, varied a little in
         * lightness per building, is what makes a skyline read as a place where
         * people paint their own houses. */
        const tint = pick(rnd, WASH);

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

        /* Openings.
         *
         * Faked rather than cut: there is no CSG here, so each opening is a
         * near-black panel set a hand's width into the wall face, with a lintel
         * over it and a sill under it. The panel is what the eye reads as depth
         * and the sill is what catches the sun, and together they turn a blank
         * rectangle into a wall of a building. At any distance past a couple of
         * metres it is indistinguishable from a real recess, and it costs three
         * boxes instead of a boolean operation per house.
         *
         * The sills are colliders. Everything on this world's facades is: the
         * whole point of the citadel is that a wall is a route, so a detail the
         * player can see and not grab would be a lie. */
        /* Face directions, derived rather than guessed.
         *
         * A box at `rotY = a` has its local +Z pointing along world
         * (sin a, cos a) and its local +X along (cos a, -sin a) - *not*
         * (cos a, sin a), which is the radial direction the buildings happen to
         * be placed on. Offsetting by the radius instead of by the local axis
         * puts every detail on a building that is not exactly north-south out
         * in the open air beside its own wall. That is what was wrong with the
         * parapets and awnings below, and it is the difference between a facade
         * and a cloud of loose boxes. */
        const faces = [0, Math.PI * 0.5, Math.PI, Math.PI * 1.5];
        for (const fa of faces) {
          const wa = a + fa;
          const nx = Math.sin(wa);
          const nz = Math.cos(wa);
          const tx = Math.cos(wa);     // tangent, for spacing bays along the face
          const tz = -Math.sin(wa);
          // Depth of the wall we are punching into, and its width.
          const onZ = fa === 0 || Math.abs(fa - Math.PI) < 1e-6;
          const half = (onZ ? d : w) * 0.5;
          const along = (onZ ? w : d) * 0.5;
          const rows = h > 9 ? 2 : 1;
          for (let row = 0; row < rows; row++) {
            const wy = y0 + h * (rows === 1 ? 0.58 : row === 0 ? 0.36 : 0.68);
            const cols = along > 5 ? 2 : 1;
            for (let cidx = 0; cidx < cols; cidx++) {
              if (rnd() < 0.22) continue;                 // not every bay
              const off = cols === 1 ? 0 : (cidx - 0.5) * along * 0.95;
              const ox = px + nx * half + tx * off;
              const oz = pz + nz * half + tz * off;
              const ww = 1.05 + rnd() * 0.45;
              const wh = 1.35 + rnd() * 0.5;
              // Recess: pushed 0.16 in, so the wall itself shades it.
              B.box('stone.castle', ww, wh, 0.1, ox - nx * 0.16, wy, oz - nz * 0.16, wa, 0x2b2119);
              // Lintel above, sill below - both proud, both grabbable.
              B.box('wood.beam', ww + 0.34, 0.2, 0.24, ox + nx * 0.05, wy + wh * 0.5 + 0.1, oz + nz * 0.05, wa, 0x6a4f31);
              B.box('stone.castle', ww + 0.42, 0.16, 0.3, ox + nx * 0.07, wy - wh * 0.5 - 0.08, oz + nz * 0.07, wa, 0xcdbb95);
              this.track(this.physics.addRotatedBox(
                _v1.set(ox + nx * 0.07, wy - wh * 0.5 - 0.08, oz + nz * 0.07),
                _v2.set((ww + 0.42) * 0.5, 0.08, 0.15), wa
              ));
            }
          }

          // A doorway on the alley-facing side only, so the ground floor is not
          // ringed with four front doors.
          if (fa === 0 && rnd() < 0.75) {
            const dw = 1.25;
            const dh = 2.3;
            B.box('stone.castle', dw, dh, 0.12, px + nx * (half - 0.14), y0 + dh * 0.5, pz + nz * (half - 0.14), wa, 0x241c15);
            B.box('wood.beam', dw + 0.4, 0.26, 0.28, px + nx * (half + 0.05), y0 + dh + 0.13, pz + nz * (half + 0.05), wa, 0x6a4f31);
          }
        }

        /* Parapet stubs on some roofs, so the skyline is not a flat plane.
         * Offset along the building's own +Z, for the reason set out above -
         * this one used to displace on z only, which slid the parapet clean off
         * the roof of every building on a diagonal. */
        if (rnd() < 0.45) {
          const ph = 0.9 + rnd() * 0.6;
          B.box('plaster.wall', w * 0.9, ph, 0.5,
            px + Math.sin(a) * d * 0.45, y0 + h + 0.55 + ph * 0.5,
            pz + Math.cos(a) * d * 0.45, a, tint);
        }

        // An awning over the alley, and its posts: cover, and a mid-height perch.
        if (rnd() < 0.3) {
          const ax = px + Math.sin(a) * (d * 0.5 + 1.6);
          const az = pz + Math.cos(a) * (d * 0.5 + 1.6);
          B.box('fabric.banner', w * 0.8, 0.12, 3.2, ax, y0 + 3.4, az, a, 0xc2543a);
          this.track(this.physics.addRotatedBox(
            _v1.set(ax, y0 + 3.4, az), _v2.set(w * 0.4, 0.06, 1.6), a
          ));
        }

        /* A cornice under the roof lip, and a domed roof on a few blocks.
         *
         * Every silhouette in the town was a rectangle with a flat top, and a
         * skyline of nothing but rectangles is most of what reads as blocky
         * however well the faces are shaded. The cornice puts a horizontal
         * shadow line under every roof, and the domes break the ridge line with
         * the one shape in the world that has no edges at all. */
        B.box('stone.castle', w + 1.15, 0.28, d + 1.15, px, y0 + h - 0.32, pz, a,
          0xd6c6a0);

        if (rnd() < 0.3) {
          const dr = Math.min(w, d) * 0.42;
          const dome = new THREE.SphereGeometry(dr, 14, 8, 0, TAU, 0, Math.PI * 0.52);
          _e1.set(0, a, 0);
          _q1.setFromEuler(_e1);
          _v1.set(px, y0 + h + 0.55, pz);
          _v2.set(1, 0.82, 1);
          _m1.compose(_v1, _q1, _v2);
          B.add('plaster.wall', dome, _m1, 0xe4d6b4);
          this.track(this.physics.addBox(px, y0 + h + 0.55 + dr * 0.32, pz,
            dr * 0.72, dr * 0.32, dr * 0.72));
          // Finial, so the dome terminates rather than just stopping.
          B.box('wood.beam', 0.16, 0.5, 0.16, px, y0 + h + 0.55 + dr * 0.82 + 0.25, pz, a, 0x8a6a3a);
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
    const B = new Batch({ ao: 0.38, sky: 0.32, grime: 0.45, span: 7 });
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
      // Gallery under the cap - the ring a muezzin would stand on, and the last
      // rest before the top of the hardest climb in the world.
      B.box('stone.castle', mw + 2.6, 0.5, mw + 2.6, px, wardTop + mh - 0.25, pz, a, 0xd8c8a2);
      this.track(this.physics.addRotatedBox(
        _v1.set(px, wardTop + mh - 0.25, pz), _v2.set((mw + 2.6) * 0.5, 0.25, (mw + 2.6) * 0.5), a
      ));
      /* An onion dome instead of a flat slab.
       *
       * A minaret capped with a box is a chimney. This is the world's most
       * distant readable silhouette - four of them stand above everything but
       * the great tower - so it is worth the one sphere each. */
      const capR = mw * 0.92;
      const cap = new THREE.SphereGeometry(capR, 16, 10, 0, TAU, 0, Math.PI * 0.58);
      _e1.set(0, a, 0);
      _q1.setFromEuler(_e1);
      _v1.set(px, wardTop + mh + 0.1, pz);
      _v2.set(1, 1.5, 1);      // stretched tall: an onion, not a hemisphere
      _m1.compose(_v1, _q1, _v2);
      B.add('roof.tile', cap, _m1, 0xbcc8d4);
      B.box('wood.beam', 0.22, 1.5, 0.22, px, wardTop + mh + capR * 1.5 + 0.6, pz, a, 0x8a6a3a);
      this.track(this.physics.addRotatedBox(
        _v1.set(px, wardTop + mh + 0.6, pz), _v2.set(capR * 0.7, 0.9, capR * 0.7), a
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
    // Planks and ropes are seen from above and below in equal measure, so the
    // sky term carries this one and the ground-contact AO is nearly off.
    const B = new Batch({ ao: 0.12, sky: 0.4, grime: 0.2, span: 1.2 });
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
    const B = new Batch({ ao: 0.44, sky: 0.3, grime: 0.6, span: 1.8 });
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

    this._buildTrees();
    this._buildProps();

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

  /**
   * A spot on the mesa that is not inside a building.
   *
   * Rejection sampling against the roof list, which already records every
   * block's footprint. Returns null rather than a bad spot, so a caller that
   * cannot be placed simply is not - a palm growing through a wall is worse
   * than one palm fewer.
   *
   * @returns {{x:number, z:number}|null}
   */
  _openSpot(rnd, rMin, rMax, pad = 3.2) {
    for (let attempt = 0; attempt < 12; attempt++) {
      const a = rnd() * TAU;
      const r = rMin + rnd() * (rMax - rMin);
      const x = Math.cos(a) * r;
      const z = Math.sin(a) * r;
      let ok = true;
      for (const b of this._roofs) {
        const dx = x - b.x;
        const dz = z - b.z;
        const keep = Math.max(b.w, b.d) * 0.5 + pad;
        if (dx * dx + dz * dz < keep * keep) { ok = false; break; }
      }
      if (!ok) continue;

      /* And then ask the collision world, which knows about everything the roof
       * list does not: the curtain wall, the keep, the minarets, the gate
       * towers, the rope bridges. Checking footprints alone put palms inside the
       * curtain wall, because a wall is not a roof and never appears in that
       * list. A downward cast from head height finds anything solid standing on
       * this spot regardless of which builder made it. */
      const g = this._groundAt(x, z);
      const hit = this.physics.groundHeight(x, z, g + 14, 22);
      if (hit !== null && hit > g + 0.6) continue;

      return { x, z };
    }
    return null;
  }

  /**
   * Palms, stalls, pottery and carts.
   *
   * The town was structurally finished long before it was *inhabited*: from the
   * wall the plaza read as a hundred metres of empty brown, because everything
   * built so far is either a wall to climb or a roof to land on. None of this
   * is climbing furniture - it exists so the ground has something on it at the
   * scale a person occupies, which is the difference between a level and a
   * place. Batched into the same handful of draw calls as everything else.
   */
  /**
   * Date palms and cypresses, instanced.
   *
   * ── Why these were rebuilt ────────────────────────────────────────────────
   *
   * The first version was boxes: a stack of cuboid drums for the trunk and flat
   * slabs for the fronds, merged into the props batch and flat-tinted. It read
   * as a broken umbrella on a post, and it was the last thing in this world
   * still made of literal boxes.
   *
   * ── The two things that make a palm a palm ────────────────────────────────
   *
   * 1. **The crown is a fountain, not a disc.** Fronds leave the head at every
   *    angle from near-vertical to hanging below the horizontal, and each one
   *    *arcs* rather than sloping. A ring of straight blades at one pitch is
   *    the single most common way a procedural palm goes wrong.
   * 2. **The trunk is a lattice, not a cylinder.** What is left after old
   *    fronds are shed is a column of diamond-shaped stubs, which the bark
   *    surface carries, over a trunk that leans and bows rather than standing
   *    plumb.
   *
   * Instanced: two draw calls per species regardless of how many are planted,
   * because a desert town wants a lot of them and they are all the same tree.
   */
  _buildTrees() {
    const rnd = this.rnd;

    /* ---- one palm, built once ---- */
    const trunkSecs = [];
    const H = 6.4;
    for (let i = 0; i <= 9; i++) {
      const t = i / 9;
      // Bows away from vertical as it rises, the way a palm carries its head
      // slightly off centre. Straight trunks look like scaffolding poles.
      trunkSecs.push({
        x: Math.sin(t * 1.5) * 0.34 * t,
        y: t * H,
        z: Math.cos(t * 2.1) * 0.16 * t,
        // Slight swell at the base and just under the crown, as a real one has.
        rx: 0.30 - t * 0.11 + Math.exp(-t * 9) * 0.10,
        ry: 0.30 - t * 0.11 + Math.exp(-t * 9) * 0.10,
      });
    }
    const palmTrunk = sweep(trunkSecs, 12, { capStart: false });
    const crownX = trunkSecs[9].x;
    const crownY = trunkSecs[9].y;
    const crownZ = trunkSecs[9].z;

    const fronds = [];
    const NF = 16;
    for (let f = 0; f < NF; f++) {
      const fa = (f / NF) * TAU + rnd() * 0.16;
      /* Pitch runs from nearly upright on the newest fronds to below the
       * horizontal on the oldest, which is what gives the crown its fountain
       * shape. Alternating rather than sequential so the two extremes are never
       * adjacent - a crown sorted by age reads as a shuttlecock. */
      const age = (f % 2 === 0 ? f / NF : 1 - f / NF);
      const pitch = 0.95 - age * 1.75;          // +0.95 rad up .. -0.80 rad down
      const len = 2.9 + rnd() * 0.9;
      const segs = 6;
      let px = crownX;
      let py = crownY;
      let pz = crownZ;
      let ang = pitch;
      for (let s = 0; s < segs; s++) {
        const segLen = len / segs;
        // Curvature accumulates along the frond, so it arcs over instead of
        // running straight out - the arc is most of the silhouette.
        ang -= (0.16 + age * 0.10);
        const nx = px + Math.cos(fa) * Math.cos(ang) * segLen;
        const ny = py + Math.sin(ang) * segLen;
        const nz = pz + Math.sin(fa) * Math.cos(ang) * segLen;
        const t0 = s / segs;
        const t1 = (s + 1) / segs;
        // Widest a third of the way out, tapering to a point.
        const w0 = (0.30 + Math.sin(t0 * Math.PI) * 0.26) * (1 - t0 * 0.35);
        const w1 = (0.30 + Math.sin(t1 * Math.PI) * 0.26) * (1 - t1 * 0.35);
        fronds.push(sweep([
          { x: px, y: py, z: pz, rx: w0, ry: 0.022 },
          { x: nx, y: ny, z: nz, rx: w1, ry: 0.018 },
        ], 4, { capStart: false, capEnd: false }));
        px = nx; py = ny; pz = nz;
      }
    }
    // Date clusters hanging under the crown.
    for (let d = 0; d < 3; d++) {
      const da = (d / 3) * TAU + 0.4;
      fronds.push(blob(0.26, 0.34, 0.26,
        crownX + Math.cos(da) * 0.42, crownY - 0.42, crownZ + Math.sin(da) * 0.42, 8));
    }
    const palmCrown = mergeGeometries(fronds.map(g => g.index ? g.toNonIndexed() : g), false);
    for (const g of fronds) g.dispose();

    /* ---- one cypress ---- */
    const cypTrunk = sweep([
      { y: 0, z: 0, rx: 0.16, ry: 0.16 },
      { y: 1.6, z: 0, rx: 0.11, ry: 0.11 },
      { y: 3.4, z: 0, rx: 0.07, ry: 0.07 },
    ], 8, { capStart: false });
    // A flame, not a cone: cypresses are widest a third up and taper to a point.
    const cypSecs = [];
    for (let i = 0; i <= 10; i++) {
      const t = i / 10;
      const r = Math.sin(Math.pow(t, 0.55) * Math.PI * 0.92) * 0.92;
      cypSecs.push({ y: 0.6 + t * 6.6, z: 0, rx: Math.max(0.03, r), ry: Math.max(0.03, r) });
    }
    const cypCrown = sweep(cypSecs, 12);

    /* ---- plant them ---- */
    const specs = [
      { trunk: palmTrunk, crown: palmCrown, bark: 'bark.palm', leaf: 'foliage.frond',
        count: 46, rMin: 28, rMax: 124, pad: 4.2, scale: [0.82, 1.25] },
      { trunk: cypTrunk, crown: cypCrown, bark: 'wood.beam', leaf: 'foliage.frond',
        count: 22, rMin: 34, rMax: 118, pad: 3.4, scale: [0.75, 1.15] },
    ];
    const m4 = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const e = new THREE.Euler();
    const pos = new THREE.Vector3();
    const scl = new THREE.Vector3();

    for (const sp of specs) {
      const placed = [];
      for (let i = 0; i < sp.count; i++) {
        const s = this._openSpot(rnd, sp.rMin, sp.rMax, sp.pad);
        if (!s) continue;
        const k = sp.scale[0] + rnd() * (sp.scale[1] - sp.scale[0]);
        placed.push({ x: s.x, y: this._groundAt(s.x, s.z), z: s.z, k, yaw: rnd() * TAU });
      }
      if (!placed.length) continue;

      const barkMesh = new THREE.InstancedMesh(
        sp.trunk, this._mat(sp.bark, { vertexColors: false }), placed.length);
      const leafMesh = new THREE.InstancedMesh(
        sp.crown, this._mat(sp.leaf, { vertexColors: false }), placed.length);
      barkMesh.name = `citadel:tree.trunk`;
      leafMesh.name = `citadel:tree.crown`;
      barkMesh.castShadow = true;
      barkMesh.receiveShadow = true;
      leafMesh.castShadow = true;
      // Crowns do not receive: self-shadowing a mass of thin fronds costs a
      // shadow lookup per frond and returns acne, not shade.
      leafMesh.receiveShadow = false;
      for (let i = 0; i < placed.length; i++) {
        const p = placed[i];
        e.set(0, p.yaw, 0);
        q.setFromEuler(e);
        pos.set(p.x, p.y, p.z);
        scl.setScalar(p.k);
        m4.compose(pos, q, scl);
        barkMesh.setMatrixAt(i, m4);
        leafMesh.setMatrixAt(i, m4);
        // A trunk collider, so a palm is something you can take cover behind
        // rather than walk through.
        this.track(this.physics.addBox(p.x, p.y + 1.6 * p.k, p.z, 0.26 * p.k, 1.6 * p.k, 0.26 * p.k));
      }
      barkMesh.instanceMatrix.needsUpdate = true;
      leafMesh.instanceMatrix.needsUpdate = true;
      this.group.add(barkMesh, leafMesh);
      this._owned.push(sp.trunk, sp.crown);
    }
  }

  _buildProps() {
    const B = new Batch({ ao: 0.4, sky: 0.34, grime: 0.5, span: 2.2 });
    const rnd = this.rnd;

    /* Trees moved out to _buildTrees.
     *
     * They were boxes merged into this prop batch. They are instanced now,
     * with real bark and frond surfaces, and neither the geometry nor the
     * material has any business being built alongside the crates. */

    /* ---- market stalls ---- */
    for (let i = 0; i < 22; i++) {
      const s = this._openSpot(rnd, 34, 108, 4.6);
      if (!s) continue;
      const gy = this._groundAt(s.x, s.z);
      const a = rnd() * TAU;
      const sw = 3.2 + rnd() * 1.4;
      const sd = 2.4 + rnd() * 0.9;
      const ph = 2.5;
      const cs = Math.cos(a);
      const sn = Math.sin(a);
      // Four posts at the corners, in the stall's own frame.
      for (const [ox, oz] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) {
        const lx = ox * sw * 0.5;
        const lz = oz * sd * 0.5;
        const wx = s.x + cs * lx + sn * lz;
        const wz = s.z - sn * lx + cs * lz;
        B.box('wood.beam', 0.16, ph, 0.16, wx, gy + ph * 0.5, wz, a, 0x7a5a38);
      }
      /* Striped canopy: alternating bands, because a market awning is the one
       * place in a sand-coloured town where saturated colour belongs, and it is
       * what the eye picks the plaza out by from the rooftops. */
      const bands = 5;
      const c1 = rnd() < 0.5 ? 0xc4472e : 0x2f6ba8;
      const c2 = 0xe8dcc0;
      for (let b = 0; b < bands; b++) {
        const lz = (b / (bands - 1) - 0.5) * sd;
        const wx = s.x + sn * lz;
        const wz = s.z + cs * lz;
        B.box('fabric.banner', sw + 0.7, 0.09, sd / bands, wx, gy + ph + 0.12, wz, a, b % 2 ? c1 : c2);
      }
      this.track(this.physics.addRotatedBox(
        _v1.set(s.x, gy + ph + 0.12, s.z), _v2.set((sw + 0.7) * 0.5, 0.06, sd * 0.5), a
      ));
      // Counter and the goods on it.
      B.box('wood.plank', sw, 0.9, sd * 0.5, s.x, gy + 0.45, s.z, a, 0x8a6842);
      this.track(this.physics.addRotatedBox(
        _v1.set(s.x, gy + 0.45, s.z), _v2.set(sw * 0.5, 0.45, sd * 0.25), a
      ));
      for (let g = 0; g < 3; g++) {
        const lx = (g / 2 - 0.5) * sw * 0.7;
        B.box('fabric.banner', 0.5, 0.32, 0.5, s.x + cs * lx, gy + 1.06, s.z - sn * lx,
          rnd() * TAU, pick(rnd, [0xb8452f, 0xc98a2a, 0x6d8a3a, 0x8a4a7a]));
      }
    }

    /* ---- pottery and sacks against the walls ---- */
    for (let i = 0; i < 40; i++) {
      const s = this._openSpot(rnd, 28, 124, 2.4);
      if (!s) continue;
      const gy = this._groundAt(s.x, s.z);
      const n = 2 + ((rnd() * 3) | 0);
      for (let k = 0; k < n; k++) {
        const ox = (rnd() - 0.5) * 1.8;
        const oz = (rnd() - 0.5) * 1.8;
        const ph = 0.5 + rnd() * 0.5;
        const pw = 0.36 + rnd() * 0.26;
        B.box('roof.tile', pw, ph, pw, s.x + ox, gy + ph * 0.5, s.z + oz, rnd() * TAU,
          pick(rnd, [0x9a6a44, 0xb08050, 0x8a5a3a, 0xc09468]));
      }
    }

    /* ---- carts ---- */
    for (let i = 0; i < 9; i++) {
      const s = this._openSpot(rnd, 38, 112, 5);
      if (!s) continue;
      const gy = this._groundAt(s.x, s.z);
      const a = rnd() * TAU;
      const cs = Math.cos(a);
      const sn = Math.sin(a);
      B.box('wood.plank', 2.8, 0.5, 1.6, s.x, gy + 0.95, s.z, a, 0x7d5f3c);
      this.track(this.physics.addRotatedBox(
        _v1.set(s.x, gy + 0.95, s.z), _v2.set(1.4, 0.25, 0.8), a
      ));
      // Sideboards, so it is a cart and not a plank on legs.
      for (const oz of [-1, 1]) {
        B.box('wood.plank', 2.8, 0.5, 0.12, s.x + sn * oz * 0.8, gy + 1.4, s.z + cs * oz * 0.8, a, 0x6d5133);
      }
      // Wheels, and the shafts a horse would sit between.
      for (const ox of [-1, 1]) {
        const wx = s.x + cs * ox * 0.95;
        const wz = s.z - sn * ox * 0.95;
        for (const oz of [-1, 1]) {
          B.box('wood.beam', 0.14, 1.2, 1.2, wx + sn * oz * 0.86, gy + 0.6, wz + cs * oz * 0.86, a, 0x5d462c);
        }
      }
      B.box('wood.beam', 2.2, 0.12, 0.12, s.x + cs * 2.4, gy + 0.8, s.z - sn * 2.4, a, 0x6d5133);
    }

    B.flush(this.group, (k) => this._mat(k), 'props');
    B.dispose();
  }

  /** Plateau-aware ground height, without a raycast. */
  _groundAt(x, z) {
    return terrainH(Math.hypot(x, z));
  }

  /* ------------------------------------------------------------------ */
  /* Spawns, portals, minimap                                            */
  /* ------------------------------------------------------------------ */

  /**
   * Move a hand-placed point off whatever it landed inside.
   *
   * Every spawn in this world is authored as a literal coordinate - "the keeper
   * stands at 6, 92" - but the souk around those coordinates is generated, and
   * a generated town moves whenever anything upstream of its PRNG changes. It
   * has, twice. The result was NPCs standing inside houses: the audit found
   * Rafiq the Keeper and a sentinel embedded in walls, patrolling on the spot
   * with a roof three metres over their heads.
   *
   * Rather than re-authoring the coordinates against the current layout - which
   * would only survive until the next change - the intent is kept and the point
   * is pushed to the nearest clear ground. A spiral, so a blocked spawn ends up
   * a couple of metres away in the street rather than somewhere unrelated.
   *
   * @param {THREE.Vector3} pos mutated in place
   * @param {number} [pad] clearance wanted around the point
   */
  _nudgeClear(pos, pad = 1.6) {
    const blocked = (x, z) => {
      for (const b of this._roofs) {
        const dx = x - b.x;
        const dz = z - b.z;
        const keep = Math.max(b.w, b.d) * 0.5 + pad;
        if (dx * dx + dz * dz < keep * keep) return true;
      }
      // And anything else solid standing here - walls, towers, the keep.
      const g = this._groundAt(x, z);
      const hit = this.physics.groundHeight(x, z, g + 12, 20);
      return hit !== null && hit > g + 0.6;
    };
    if (!blocked(pos.x, pos.z)) return pos;
    // Golden-angle spiral: even coverage, and it never revisits a direction.
    for (let i = 1; i <= 96; i++) {
      const a = i * 2.399963;
      const r = 1.2 + i * 0.28;
      const x = pos.x + Math.cos(a) * r;
      const z = pos.z + Math.sin(a) * r;
      if (Math.hypot(x, z) > MESA_R - 4) continue;   // stay on the plateau
      if (!blocked(x, z)) {
        pos.x = x;
        pos.z = z;
        pos.y = this._groundAt(x, z) + 0.2;
        return pos;
      }
    }
    return pos;
  }

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

    /* Every spawn, hand-placed or generated, gets pushed clear of the town.
     *
     * Done in one pass at the end rather than at each site so nothing can be
     * added later and quietly skip it - which is exactly how the hostile ring
     * came to be laid down on a fixed radius of 62 m straight through whatever
     * the souk had generated there. */
    for (const s of this.npcSpawns) this._nudgeClear(s.position, 1.8);
    this._nudgeClear(this.playerSpawn, 2.2);
    for (const p of this.portalSpecs) this._nudgeClear(p.position, 2.6);

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
