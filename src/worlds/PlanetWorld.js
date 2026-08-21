import * as THREE from 'three';
import { World } from './World.js';
import { makeRules } from './WorldRules.js';
import { genPool } from '../workers/GenPool.js';
import { createSky } from '../gfx/Sky.js';
import { HEIGHT_FIELDS } from './terrain/index.js';
import { fbm } from './terrain/PlanetHeight.js';
import { scatter } from './planets/Placement.js';
import { buildPropField, buildPlumes } from './planets/PlanetProps.js';
import { createLiquidMaterial, createSkirtMaterial, bodyGeometry } from './planets/PlanetLiquid.js';

/**
 * PLANET SURFACES - one world class, any number of planets.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 *  THE BOUNDARY THIS FILE EXISTS TO HOLD
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * There is no planet in this file. No volcano, no ice, no `if (planet.id ===
 * 'cinder')`, and there must never be one. Everything that distinguishes one
 * world from another arrives as a descriptor: its height field's parameters,
 * its palette, its sky, its liquid, its props, its minerals, its landing sites
 * and its gravity. Ten planets cost ten descriptors.
 *
 * That is not a stylistic preference. The alternative - `VolcanicWorld.js`,
 * then `IceWorld.js`, then `JungleWorld.js` - is how this project ends up with
 * `CitadelWorld.js` at 2,937 lines nine times over, and the ninth one gets the
 * bug the third one fixed. The precedent for doing it the other way is already
 * here: `HEIGHT_FIELDS` is a registry of pure height functions the generation
 * worker samples BY NAME, and Citadel authored six distinct regions out of one
 * landform vocabulary. This is that pattern taken up one level.
 *
 * ── The seam with the worker ──────────────────────────────────────────────
 * `descriptor.terrain` is handed to `genPool.run('terrain', { field: 'planet',
 * params })` and crosses `postMessage` verbatim. It therefore contains no
 * functions, no class instances and no `three` types - `definePlanet` refuses
 * a descriptor that does, because the failure mode is silent: a closure clones
 * to `undefined` and the planet comes back flat with nothing in the console.
 *
 * ── The mesh and the collider are the same grid ───────────────────────────
 * One `sampleTerrain` job produces both the drawn positions and the collision
 * heights, from one evaluation of one function. This is not an optimisation. It
 * is the fix for the defect that shaped Citadel: three separate approximations
 * of one slope were allowed to disagree, and where the collision sat below the
 * mesh the player walked *underneath* the visible world across 7% of the map.
 *
 * ── What a planet publishes ───────────────────────────────────────────────
 *   `this.planet`        the descriptor, frozen
 *   `this.groundAt(x,z)` the one height function, for anything that needs it
 *   `this.landingSites`  [{ id, name, position, radius, yaw, primary }]
 *   `this.mineralNodes`  [{ id, type, name, position, credits, size }]
 *   `this.gravity`       m/s^2, for the flight model when it lands
 * These are the contract with the flight, mining and HUD systems, and they are
 * the same shape for every planet by construction.
 */

/* Module-level scratch. Nothing below allocates inside a loop or a frame. */
const _v = new THREE.Vector3();
const _m4 = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _e = new THREE.Euler();
const _s = new THREE.Vector3();
const _col = new THREE.Color();
const _colB = new THREE.Color();

/** Ash motes drifting past the camera. One `Points`, animated in the shader. */
const ASH_VERT = /* glsl */`
  uniform float uTime;
  uniform vec3 uEye;
  uniform float uBox;
  uniform vec2 uDrift;
  uniform float uSize;
  attribute float aSeed;
  varying float vA;
  void main() {
    /* Every mote lives in a box that follows the camera and wraps with mod(),
     * so a few thousand of them cover an 800 m map without a single one being
     * respawned on the CPU. Fall speed and drift come off the seed. */
    float fall = 1.6 + aSeed * 3.4;
    vec3 p = position;
    p.x = mod(p.x + uTime * uDrift.x - uEye.x + uBox * 0.5, uBox) + uEye.x - uBox * 0.5;
    p.z = mod(p.z + uTime * uDrift.y - uEye.z + uBox * 0.5, uBox) + uEye.z - uBox * 0.5;
    p.y = mod(p.y - uTime * fall - uEye.y + uBox * 0.5, uBox) + uEye.y - uBox * 0.5;
    vec4 mv = modelViewMatrix * vec4(p, 1.0);
    float d = length(mv.xyz);
    vA = clamp(1.0 - d / (uBox * 0.5), 0.0, 1.0);
    gl_PointSize = uSize * (300.0 / max(d, 1.0));
    gl_Position = projectionMatrix * mv;
  }
`;
const ASH_FRAG = /* glsl */`
  uniform vec3 uColor;
  uniform float uOpacity;
  varying float vA;
  void main() {
    vec2 d = gl_PointCoord - 0.5;
    float a = clamp(1.0 - dot(d, d) * 4.0, 0.0, 1.0);
    a *= a * vA * uOpacity;
    if (a < 0.004) discard;
    gl_FragColor = vec4(uColor, a);
  }
`;

export class PlanetWorld extends World {
  static id = 'planet';
  static displayName = 'Planet Surface';
  /** The descriptor this subclass renders. Set by `PlanetWorld.of`. */
  static planet = null;

  /**
   * Stamp a registerable World subclass for one planet.
   *
   * `WorldManager` keys everything on `static id`, so a planet needs a class
   * with its own id - but it does not need its own CODE, and this is the whole
   * difference. The subclass is four static fields.
   *
   * @param {Readonly<object>} descriptor from `definePlanet`
   * @returns {typeof PlanetWorld}
   */
  static of(descriptor) {
    return class extends PlanetWorld {
      static id = descriptor.id;
      static displayName = descriptor.name;
      static planet = descriptor;
    };
  }

  constructor(ctx) {
    super(ctx);
    const P = this.constructor.planet;
    if (!P) throw new Error('[PlanetWorld] use PlanetWorld.of(descriptor) - the base class renders nothing');
    this.planet = P;
    this.gravity = P.gravity;

    /** The one height function. Everything that asks the ground a question
     *  asks this, including the generation worker (by name). */
    this.groundAt = HEIGHT_FIELDS.planet(P.terrain);
    /** Collision cell size. Slope filters are measured over it - see Placement. */
    this.cell = (P.half * 2) / P.seg;

    /** @type {Array<{id:string,name:string,position:THREE.Vector3,radius:number,yaw:number,primary:boolean}>} */
    this.landingSites = [];
    /** @type {Array<{id:string,type:string,name:string,position:THREE.Vector3,credits:number,size:number}>} */
    this.mineralNodes = [];
    /** Build-time census, reported by the tests and the console. */
    this.census = { props: {}, minerals: {}, colliders: 0, drawCalls: 0, triangles: 0 };

    this.rules = makeRules({
      /* A planet surface is a wilderness. Nothing that belongs to a settlement
       * belongs here, and switching them on would have the crowd system fill
       * 640,000 m2 of ash with traders. */
      merchants: false,
      quests: false,
      contracts: false,
      races: false,
      interiors: false,
      crowd: false,
      swim: false,
      /* Caches and relics OFF, and this is a look bug as much as a design one.
       * Both systems scatter their own sites without asking the world where the
       * ground, the lava or the cliffs are, and with them on a review screenshot
       * of the caldera came back with thirty amber pickups strung across the
       * flank like fairy lights. A wilderness has no supply caches and no
       * collectible relics in it: the MINERALS are what is collectible here, and
       * they are placed against the real height field. */
      caches: false,
      relics: false,
      /* Mounts off: a horse on a volcano is a joke the player did not make.
       * The ship is the mount here. */
      mounts: false,
      /* Loot stays ON: it is the drop path a mined node will use. */
    });

    this.bounds = new THREE.Box3(
      new THREE.Vector3(-P.half, -60, -P.half),
      new THREE.Vector3(P.half, 260, P.half)
    );

    const sky = P.sky ?? {};
    const sunDir = new THREE.Vector3(...(sky.sun?.direction ?? [-0.5, 0.4, -0.7])).normalize();
    this.environment = {
      ...this.environment,
      background: new THREE.Color(sky.background ?? 0x101010),
      fogColor: new THREE.Color(sky.fog?.color ?? sky.background ?? 0x101010),
      fogNear: sky.fog?.near ?? 60,
      fogFar: sky.fog?.far ?? 600,
      exposure: sky.exposure ?? 1.0,
      ambientColor: new THREE.Color(sky.ambient?.color ?? 0x404040),
      ambientIntensity: sky.ambient?.intensity ?? 0.5,
      sunColor: new THREE.Color(sky.sun?.color ?? 0xffffff),
      sunIntensity: sky.sun?.intensity ?? 2.2,
      sunDirection: sunDir,
      envMapIntensity: sky.envMapIntensity ?? 1.0,
      bloom: sky.bloom ?? null,
      grade: sky.grade ?? null,
    };

    /** Everything this world owns and must dispose. */
    this._owned = [];
    this._sky = null;
    this._liquidUniforms = null;
    this._plumes = [];
    this._ash = null;
    this._t = 0;
  }

  _own(x) { if (x) this._owned.push(x); return x; }

  /* ================================================================== */
  /* Build                                                              */
  /* ================================================================== */

  async build(onProgress) {
    const P = this.planet;
    onProgress?.(0.04, `Entering ${P.name}`);
    this._buildSky();

    onProgress?.(0.10, 'Sampling the surface');
    await this._buildTerrain();

    onProgress?.(0.52, 'Pouring the flows');
    this._buildLiquid();

    onProgress?.(0.62, 'Scattering');
    this._buildProps();

    onProgress?.(0.82, 'Seeding deposits');
    this._buildMinerals();

    onProgress?.(0.90, 'Marking the pads');
    this._buildLandingSites();

    onProgress?.(0.96, 'Air');
    this._buildAtmosphere();

    this._publish();
    onProgress?.(1, P.name);

    console.info(
      `[PlanetWorld] ${P.id}: ${this.census.triangles.toLocaleString()} tris in `
      + `${this.census.drawCalls} draws, ${this.census.colliders} colliders, `
      + `${this.mineralNodes.length} mineral nodes, ${this.landingSites.length} landing sites`
    );
  }

  /* ------------------------------------------------------------------ */

  /**
   * The dome.
   *
   * `environment.background` is a flat colour, which reads as a void behind a
   * skyline rather than as air - and a planet is looked ACROSS more than
   * anything else in this game. The dome costs one draw call and gives the
   * horizon a haze band for the caldera to stand against.
   */
  _buildSky() {
    const sky = this.planet.sky ?? {};
    const params = { ...(sky.params ?? {}) };
    if (Array.isArray(params.sunDirection)) params.sunDirection = new THREE.Vector3(...params.sunDirection);
    params.radius = params.radius ?? Math.max(1500, this.planet.half * 4);
    /* THE DOME RIDES THE CAMERA, and it could not come from the descriptor.
     *
     * `Sky.update` re-centres the dome on `params.camera` every frame - that is
     * the only thing that makes a dome read as infinitely far away - and
     * `SpaceWorld._buildSky` passes it. This one could not: `definePlanet`
     * rejects class instances, so a live `THREE.Camera` cannot be a field of a
     * frozen planet descriptor. It has to be added here, where the engine is.
     *
     * Without it the dome was pinned wherever the camera happened to be at the
     * frame `activate` resolved - which on the descent seam is the chase camera
     * hundreds of metres up and offset from the pad. Measured: moving the
     * camera 990 m moved the space dome 707.11 m and moved this one 0.00.
     * `VOLCANIC.half` is 400 so the dome is 1600 m in radius, a legal walk to
     * the corner of the playfield is 566 m, and the horizon therefore swung
     * 20.7 degrees while the player walked - with `sky.material.fog === false`
     * so nothing hid it. */
    params.camera = params.camera ?? this.engine?.camera ?? null;
    const built = createSky(sky.kind ?? 'daylight', params);
    built.mesh.name = `planet:sky:${this.planet.id}`;
    this.group.add(built.mesh);
    this._sky = built;
    this.census.drawCalls++;
  }

  /**
   * The ground: one worker job, one mesh, one heightfield collider.
   *
   * The vertex colours are computed here rather than in the job because they
   * are the only part of the surface that needs `three` - and because the job
   * already returns everything they are derived from (heights and normals), so
   * this is a pass over buffers rather than a second evaluation of the height
   * function.
   */
  async _buildTerrain() {
    const P = this.planet;
    const N = P.seg + 1;
    const size = P.half * 2;

    const t = await genPool.run('terrain', {
      field: 'planet',
      params: P.terrain,
      originX: -P.half,
      originZ: -P.half,
      size,
      seg: P.seg,
      uv: 'unit',
      normals: true,
    });

    /* NaN propagates through bloom and blacks out the entire frame - 19 bad
     * pixels took out 921,600 in this repo once. The height function is data
     * driven, so a descriptor with a zero radius or a divide by a taper of 1
     * would reach the shader as NaN rather than as a thrown error. Checked once,
     * over the samples that actually got made. */
    if (!Number.isFinite(t.minY) || !Number.isFinite(t.maxY)) {
      throw new Error(`[PlanetWorld] ${P.id} terrain produced non-finite heights (min ${t.minY}, max ${t.maxY})`);
    }

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(t.positions, 3));
    geo.setAttribute('normal', new THREE.BufferAttribute(t.normals, 3));
    geo.setAttribute('uv', new THREE.BufferAttribute(t.uvs, 2));
    geo.setAttribute('color', new THREE.BufferAttribute(this._terrainColors(t, N), 3));
    geo.setIndex(new THREE.BufferAttribute(t.indices, 1));
    geo.computeBoundingSphere();
    this._own(geo);

    /* Tiled off the library's own key so texel density is the same on the
     * crater wall and the ash plain. Cloned, not shared: the terrain runs with
     * `vertexColors` on and the library material does not. */
    const tile = P.palette.tile ?? 6;
    const repeat = size / tile;
    const mat = this.materials.get(`${P.palette.material}:${repeat}`).clone();
    mat.name = `planet.${P.id}.ground`;
    mat.vertexColors = true;
    mat.color = new THREE.Color(0xffffff);
    this._own(mat);

    const ground = new THREE.Mesh(geo, mat);
    ground.name = `planet:${P.id}:terrain`;
    ground.receiveShadow = true;
    ground.castShadow = false;
    this.group.add(ground);
    this.census.drawCalls++;
    this.census.triangles += t.indices.length / 3;

    /* ONE collider for the whole surface, on the same samples the mesh drew.
     * @see the header: this is the fix for "collision below mesh", made true by
     * construction rather than by rounding upward. */
    this.track(this.physics.addHeightfield({
      heights: t.heights,
      nx: N,
      nz: N,
      originX: -P.half,
      originZ: -P.half,
      stepX: size / P.seg,
      stepZ: size / P.seg,
    }));
    this.census.colliders++;
    this._terrainMinY = t.minY;
    this._terrainMaxY = t.maxY;
  }

  /**
   * Per-vertex ground colour: height bands, a slope override and a mottle.
   *
   * Three terms, and each one is answering a specific way procedural terrain
   * fails to read:
   *
   *   BANDS   give the eye a height cue. Without them a 158 m caldera and a
   *           12 m plain are the same colour and the silhouette disappears
   *           into the haze.
   *   SLOPE   puts bare rock on anything steep. This is what separates a cliff
   *           from a hill at any distance, and it is free here because the job
   *           already returned the normals.
   *   MOTTLE  large-scale drift, so the bands do not print as a contour map.
   *           The one term with no physical justification and the one that does
   *           the most work.
   */
  _terrainColors(t, N) {
    const pal = this.planet.palette;
    const bands = pal.bands;
    const out = new Float32Array(N * N * 3);
    const slope = pal.slope ?? null;
    const mottle = pal.mottle ?? null;
    const mInv = mottle ? 1 / mottle.scale : 0;
    if (mottle) _colB.setHex(mottle.color);
    const slopeFrom = slope ? Math.cos((slope.fromDeg * Math.PI) / 180) : 0;
    const slopeTo = slope ? Math.cos((slope.toDeg * Math.PI) / 180) : 0;

    for (let i = 0; i < N * N; i++) {
      const y = t.heights[i];
      // Bands: find the pair this height falls between and lerp.
      let bi = 0;
      while (bi < bands.length - 1 && y > bands[bi].upTo) bi++;
      const lo = bands[Math.max(0, bi - 1)];
      const hi = bands[bi];
      const span = hi.upTo - (bi > 0 ? lo.upTo : hi.upTo - 1);
      const f = bi > 0 ? Math.max(0, Math.min(1, (y - lo.upTo) / (span || 1))) : 1;
      _col.setHex(lo.color).lerp(_colB.setHex(hi.color), f);

      if (slope) {
        const ny = t.normals[i * 3 + 1];
        // ny falls as the surface steepens: cos(from) down to cos(to).
        const s = Math.max(0, Math.min(1, (slopeFrom - ny) / Math.max(1e-6, slopeFrom - slopeTo)));
        if (s > 0) _col.lerp(_colB.setHex(slope.color), s);
      }
      if (mottle) {
        /* The SAME fbm the ground is made of, not a sine.
         *
         * The first version was `sin(x) + cos(z)`, which is a regular standing
         * wave: on an 800 m ash plain it produced a corduroy nobody could name
         * and the plain read as one flat colour anyway. Three octaves of the
         * height field's own noise gives patches with edges, which is what
         * oxidised ash looks like from eye level - and it costs one call to a
         * function that is already in the module graph. */
        const x = t.positions[i * 3];
        const z = t.positions[i * 3 + 2];
        const n = fbm(x * mInv, z * mInv, 5501, 3);
        _col.lerp(_colB.setHex(mottle.color), n * n * mottle.amount);
      }
      out[i * 3] = _col.r;
      out[i * 3 + 1] = _col.g;
      out[i * 3 + 2] = _col.b;
    }
    return out;
  }

  /** Lava, water, methane - whatever the descriptor pours. */
  _buildLiquid() {
    const L = this.planet.liquid;
    if (!L) return;
    const { material, uniforms } = createLiquidMaterial(L);
    const skirtMat = createSkirtMaterial(L);
    this._own(material);
    this._own(skirtMat);
    this._liquidUniforms = uniforms;

    const g = new THREE.Group();
    g.name = `planet:${this.planet.id}:liquid`;
    this.group.add(g);

    L.bodies.forEach((b, i) => {
      const { surface, skirt } = bodyGeometry(b);
      this._own(surface);
      this._own(skirt);
      const sm = new THREE.Mesh(surface, material);
      sm.name = `liquid:${i}`;
      sm.receiveShadow = false;
      sm.castShadow = false;
      g.add(sm);
      const sk = new THREE.Mesh(skirt, skirtMat);
      sk.name = `liquid:${i}:skirt`;
      sk.castShadow = false;
      sk.receiveShadow = true;
      g.add(sk);
      this.census.drawCalls += 2;
      this.census.triangles += (surface.index ? surface.index.count : surface.attributes.position.count) / 3
        + (skirt.index ? skirt.index.count : skirt.attributes.position.count) / 3;
    });

    /* ONE point light, on the body the descriptor names. `RIG_BUDGET.point` is
     * twelve for the whole game and every one of them is compiled into every
     * shader; a light per lava body would charge the entire boot for a glow the
     * emissive already provides. */
    const gl = L.glowLight;
    if (gl) {
      const b = L.bodies[gl.body ?? 0];
      const light = new THREE.PointLight(gl.color ?? 0xff7a2a, gl.intensity ?? 30, gl.distance ?? 120, 1.8);
      light.castShadow = false;
      light.position.set(b.x ?? b.pts[0][0], (b.y ?? b.y0) + 6, b.z ?? b.pts[0][1]);
      light.name = 'planet:liquid:glow';
      g.add(light);
    }
  }

  /** Every prop field the descriptor asks for. One draw call each. */
  _buildProps() {
    const P = this.planet;
    const rockMat = this._propMaterial();
    let seed = (P.terrain.seed ?? 1) ^ 0x7f4a;
    for (const spec of P.props) {
      seed = (seed * 1664525 + 1013904223) >>> 0;
      const built = buildPropField(spec, {
        height: this.groundAt,
        half: P.half,
        slopeStep: this.cell,
        seed,
        liquid: P.liquid,
        landing: P.landing,
        material: rockMat,
        physics: this.physics,
        group: this.group,
        track: (c) => this.track(c),
      });
      this._own(built.geo);
      this.census.props[spec.id] = { placed: built.placed, requested: built.requested, colliders: built.colliders };
      this.census.colliders += built.colliders;
      this.census.drawCalls++;
      const idx = built.mesh.geometry.index;
      this.census.triangles += ((idx ? idx.count : built.mesh.geometry.attributes.position.count) / 3) * built.placed;

      // Vent fields get their steam. The plume field is driven off the same
      // points, so a vent without a plume is not expressible.
      if (spec.kind === 'vents' && built.points.length) {
        const plumes = buildPlumes(built.points, {
          perVent: 5,
          height: (spec.size?.plumeMax ?? 16),
          /* Grey-brown and thin. A near-white plume at 0.26 was the brightest
           * thing in the frame after the lava and the bloom pass turned each
           * puff into a hard white ball. Steam over ash is dirty. */
          color: P.hazards?.steamColor ?? 0x7d6a5e,
          opacity: 0.15,
        });
        this.group.add(plumes.mesh);
        this._plumes.push(plumes);
        this._own(plumes.geometry);
        this._own(plumes.material);
        this.census.drawCalls++;
      }
    }
  }

  /** Shared rock material for every prop family. One clone, `vertexColors` on
   *  for the per-instance tint. */
  _propMaterial() {
    if (this._propMat) return this._propMat;
    const m = this.materials.get('stone.castle:1.4').clone();
    m.name = `planet.${this.planet.id}.rock`;
    m.vertexColors = true;
    m.color = new THREE.Color(0xffffff);
    this._own(m);
    this._propMat = m;
    return m;
  }

  /**
   * Mineral deposits.
   *
   * Each node is a small cluster of faceted crystals, instanced per mineral
   * type. They do NOT collide: a node is 1.3 m across and the player has to be
   * able to stand on it to work it. A box collider on a thing you are meant to
   * walk up to is the same defect as a door you cannot enter, one size smaller.
   *
   * ── HOW BIG A NODE LOOKS IS NOT HOW MUCH HOLD IT TAKES ──────────────────
   *
   * It used to be. `spec.size` drove BOTH `holdUnitsFor` and the crystal
   * scale, and the descriptor's own value gradient makes the rare ores the
   * SMALL ones - that is the whole point of them, a cubic metre of iridite is
   * 310 credits where three of tephra are 18. So the most valuable object on
   * the planet was also the least visible: iridite's main crystal came out at
   * `0.62 * 0.55 = 0.34 m`, a pebble, and a tester who flew 62 km and
   * descended to get one wrote that "iridite - the rarest element, the payoff
   * for a 60 km flight and a descent - is a plain grey-brown truncated cone.
   * A lampshade, the same colour as the ground, no glow, no glint, no aura."
   *
   * Rarity is now inversely coupled to hold cost and DIRECTLY coupled to
   * presence, which is the way round a player can act on: a rare seam is a
   * bigger, taller, brighter thing standing in the rock that happens to stow
   * small. `size` is untouched, so every hold, price and load figure in
   * `planet-minerals.test.mjs` and `SpaceObjectives` is exactly what it was.
   */
  _buildMinerals() {
    const P = this.planet;
    let seed = (P.terrain.seed ?? 1) ^ 0x1d0e;
    for (const spec of P.minerals) {
      seed = (seed * 1664525 + 1013904223) >>> 0;
      const res = scatter({
        region: spec.region,
        count: spec.count,
        spacing: spec.spacing ?? 0,
        seed,
        height: this.groundAt,
        half: P.half,
        slopeStep: this.cell,
        liquid: P.liquid,
        landing: P.landing,
      });

      const geo = new THREE.IcosahedronGeometry(1, 0);
      this._own(geo);
      const mat = new THREE.MeshStandardMaterial({
        name: `planet.mineral.${spec.id}`,
        color: new THREE.Color(spec.color),
        emissive: new THREE.Color(spec.glow || 0x000000),
        /* 1.6 -> 3.2 on anything that declares a glow. `GRADE_PRESETS`
         * thresholds bloom on scene-linear luminance, and at 1.6 against a
         * daylit ash plain the emissive was inside the diffuse and the ore
         * did not read as lit at all - which is what "no glow, no glint, no
         * aura" describes. Only the two rare tiers declare `glow`, so this
         * lights exactly the ore the value gradient wants found. */
        /* 1.6 -> 2.2. At 1.6, against a daylit ash plain, the emissive sat
         * inside the diffuse and the ore did not read as lit at all - which
         * is what "no glow, no glint, no aura" describes. 3.2 was the first
         * try and overshot: driven in a browser, both rare ores saturated to
         * the same cream and iridite's orange and rheniite's cold teal became
         * indistinguishable at arm's length, which throws away the legibility
         * decision `Volcanic.js` records beside rheniite's own colour. 2.2 is
         * the value at which each keeps its hue and still glows. */
        emissiveIntensity: spec.glow ? 2.2 : 0,
        roughness: spec.glow ? 0.28 : 0.66,
        metalness: 0.15,
        flatShading: true,
      });
      this._own(mat);

      /* HOW BIG IT LOOKS. See the note on this method.
       *
       * A multiplier on the DRAWN scale only. Ordered by `MINERAL_RARITY`, so
       * a descriptor that adds a tier gets a sensible default rather than a
       * silent 1.0.
       *
       * 1.0 to 1.9: enough that a tephra nodule and an iridite seam are
       * different objects at fifty metres, and not so much that the ore
       * becomes scenery. The first try ran to 2.6 and put 1.5 m crystals on
       * a rheniite FLAKE - driven in a browser, one node filled the frame
       * from three metres. At 1.9 iridite's main crystal is 0.65 m against
       * the 0.34 m it was, which is the difference between a pebble you walk
       * past and a seam you walk to. */
      const SHOW = { common: 1.0, uncommon: 1.2, rare: 1.5, exotic: 1.9 };
      const show = spec.size * (SHOW[spec.rarity] ?? 1.0);

      // Four crystals per node, so a deposit is a cluster and not a pebble.
      const PER = 4;
      const mesh = new THREE.InstancedMesh(geo, mat, Math.max(1, res.points.length * PER));
      mesh.name = `planet:mineral:${spec.id}`;
      mesh.count = res.points.length * PER;
      mesh.castShadow = true;
      mesh.receiveShadow = true;

      let k = 0;
      for (const pt of res.points) {
        const roll = pt.rnd;
        const credits = Math.round(spec.credits[0] + roll * (spec.credits[1] - spec.credits[0]));
        this.mineralNodes.push({
          id: `${spec.id}_${this.mineralNodes.length}`,
          type: spec.id,
          name: spec.name,
          position: new THREE.Vector3(pt.x, pt.y, pt.z),
          credits,
          size: spec.size,
          /* WHERE THIS NODE'S CRYSTALS LIVE IN THE INSTANCED DRAW.
           *
           * Published because a node that is mined has to STOP BEING DRAWN, and
           * a consumer holding only a world position has no way to reach four
           * matrices inside an `InstancedMesh` without re-deriving the packing
           * order from this loop - which is the kind of duplicated arithmetic
           * that silently goes wrong the day `PER` changes. `mesh` is the live
           * object and `slot`/`slotCount` are its index range.
           * @see systems/Mining.js */
          mesh,
          slot: k,
          slotCount: PER,
        });
        for (let c = 0; c < PER; c++) {
          const a = (roll * (7 + c * 13.7)) % 1;
          const b = (roll * (31 + c * 5.1)) % 1;
          const ang = (c / PER) * Math.PI * 2 + roll * 6.28;
          const off = c === 0 ? 0 : show * (0.35 + a * 0.5);
          const sc = show * (c === 0 ? 0.55 : 0.24 + b * 0.24);
          _e.set(a * 1.1 - 0.55, b * 6.28, b * 1.1 - 0.55);
          _q.setFromEuler(_e);
          _v.set(pt.x + Math.cos(ang) * off, pt.y + sc * 0.35, pt.z + Math.sin(ang) * off);
          _s.set(sc, sc * (1.1 + a * 0.9), sc);
          _m4.compose(_v, _q, _s);
          mesh.setMatrixAt(k++, _m4);
        }
      }
      mesh.instanceMatrix.needsUpdate = true;
      mesh.computeBoundingSphere();
      this.group.add(mesh);
      this.census.drawCalls++;
      this.census.triangles += 20 * k;
      this.census.minerals[spec.id] = { placed: res.points.length, requested: res.requested, rejects: res.rejects };
    }
  }

  /**
   * Landing sites.
   *
   * A ring on the ground, four corner markers and the published record. The
   * FLATNESS is not created here - it is created by the `pad` landform in the
   * height field, which `definePlanet` refuses to let a site exist without.
   * This is only the paint that says "here".
   */
  _buildLandingSites() {
    const P = this.planet;
    const g = new THREE.Group();
    g.name = `planet:${P.id}:landing`;
    this.group.add(g);

    /**
     * THE OUTER RING IS PAINT, AND THE INNER ONE IS THE ONLY LIGHT.
     *
     * It was one material, emissive `0x64d8ff` at 0.45, on both rings. 0.45 was
     * already a retreat from 1.5 and it was not far enough: from 190 m up the
     * two pad rings were the ONLY high-chroma objects on the whole planet -
     * whole-frame max 112, and most of that was them - and at eye level the
     * outer ring was the dominant object in shot with a visibly stair-stepped
     * inner edge. A cyan doughnut is also the wrong colour for a volcanic
     * world: it belongs to no palette this planet has.
     *
     * So there are two materials now. The outer ring is a light VALUE in the
     * world's own family - a lime-washed circle on ash, which is what a real
     * pad marking is - with no emissive at all, and it reads because it is
     * paler than the ground rather than because it glows. The inner ring keeps
     * an emissive, in the planet's amber rather than in cyan, because
     * something on a pad has to be findable at night and it is 4 m across
     * instead of 34.
     */
    const ringMat = new THREE.MeshStandardMaterial({
      name: `planet.${P.id}.padmark`,
      color: 0xb9a893,
      roughness: 0.82,
    });
    const innerMat = new THREE.MeshStandardMaterial({
      name: `planet.${P.id}.padmark.inner`,
      color: 0x140d09,
      emissive: new THREE.Color(0xffb060),
      emissiveIntensity: 0.5,
      roughness: 0.5,
    });
    const postMat = this.materials.get('metal.trim').clone();
    postMat.name = `planet.${P.id}.padpost`;
    this._own(ringMat);
    this._own(innerMat);
    this._own(postMat);

    for (const s of P.landing) {
      const y = this.groundAt(s.x, s.z);
      const ring = new THREE.Mesh(new THREE.RingGeometry(s.r - 1.4, s.r, 64), ringMat);
      ring.rotation.x = -Math.PI / 2;
      ring.position.set(s.x, y + 0.06, s.z);
      this._own(ring.geometry);
      g.add(ring);
      this.census.drawCalls++;

      const inner = new THREE.Mesh(new THREE.RingGeometry(s.r * 0.32, s.r * 0.32 + 0.9, 48), innerMat);
      inner.rotation.x = -Math.PI / 2;
      inner.position.set(s.x, y + 0.06, s.z);
      this._own(inner.geometry);
      g.add(inner);
      this.census.drawCalls++;

      /* Four mooring posts, on the pad's own radius so they never stand in the
       * ship's way. Real colliders: they are 2.4 m of steel and a player who
       * walks through one has been told the world is not solid. */
      const postGeo = new THREE.BoxGeometry(0.5, 2.4, 0.5);
      this._own(postGeo);
      const posts = new THREE.InstancedMesh(postGeo, postMat, 4);
      posts.castShadow = true;
      for (let i = 0; i < 4; i++) {
        const a = (i / 4) * Math.PI * 2 + Math.PI / 4;
        const px = s.x + Math.cos(a) * (s.r - 1.0);
        const pz = s.z + Math.sin(a) * (s.r - 1.0);
        const py = this.groundAt(px, pz);
        _m4.makeTranslation(px, py + 1.2, pz);
        posts.setMatrixAt(i, _m4);
        this.track(this.physics.addBox(px, py + 1.2, pz, 0.25, 1.2, 0.25));
        this.census.colliders++;
      }
      posts.instanceMatrix.needsUpdate = true;
      posts.computeBoundingSphere();
      g.add(posts);
      this.census.drawCalls++;

      this.landingSites.push({
        id: s.id,
        name: s.name,
        position: new THREE.Vector3(s.x, y, s.z),
        radius: s.r,
        yaw: s.yaw ?? 0,
        primary: !!s.primary,
      });
    }
  }

  /** Ash in the air. One `Points`, wrapped around the camera in the shader. */
  _buildAtmosphere() {
    const h = this.planet.hazards ?? {};
    const density = h.ashfall?.density ?? 0;
    if (density <= 0) return;
    const BOX = 220;
    const COUNT = Math.round(1800 * density);
    const pos = new Float32Array(COUNT * 3);
    const seedA = new Float32Array(COUNT);
    let s = 0x3f19 >>> 0;
    const rnd = () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
    for (let i = 0; i < COUNT; i++) {
      pos[i * 3] = rnd() * BOX;
      pos[i * 3 + 1] = rnd() * BOX;
      pos[i * 3 + 2] = rnd() * BOX;
      seedA[i] = rnd();
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('aSeed', new THREE.BufferAttribute(seedA, 1));
    const mat = new THREE.ShaderMaterial({
      name: 'planet.ash',
      uniforms: {
        uTime: { value: 0 },
        uEye: { value: new THREE.Vector3() },
        uBox: { value: BOX },
        uDrift: { value: new THREE.Vector2(...(h.ashfall?.drift ?? [0.5, 0])) },
        uSize: { value: 1.4 },
        uColor: { value: new THREE.Color(h.ashColor ?? 0x8a7466) },
        uOpacity: { value: 0.5 },
      },
      vertexShader: ASH_VERT,
      fragmentShader: ASH_FRAG,
      transparent: true,
      depthWrite: false,
    });
    const pts = new THREE.Points(geo, mat);
    pts.name = 'planet:ash';
    pts.frustumCulled = false;
    pts.renderOrder = 9;
    this.group.add(pts);
    this._own(geo);
    this._own(mat);
    this._ash = mat;
    this.census.drawCalls++;
  }

  /** Spawn, portals and the minimap. */
  _publish() {
    const P = this.planet;
    const primary = this.landingSites.find((s) => s.primary) ?? this.landingSites[0];
    /* Just outside the pad's centre marker, facing the way the descriptor says.
     * 0.4 m of clearance: the capsule solver seats the feet on the heightfield,
     * and spawning exactly ON it starts the first frame in penetration. */
    this.playerSpawn.set(primary.position.x, primary.position.y + 0.4, primary.position.z + primary.radius * 0.45);
    this.playerSpawnYaw = primary.yaw;

    this.minimapShapes.push({
      kind: 'rect', x: 0, z: 0, w: P.half * 2, d: P.half * 2, rotation: 0,
      fill: 'rgba(24,14,12,0.85)', stroke: 'rgba(200,90,40,0.7)',
    });
    for (const b of (P.liquid?.bodies ?? [])) {
      if (b.shape === 'disc') {
        this.minimapShapes.push({ kind: 'circle', x: b.x, z: b.z, r: b.r, fill: 'rgba(255,110,30,0.55)', stroke: '#ff7a1c' });
      } else {
        this.minimapShapes.push({ kind: 'path', points: b.pts.map(([x, z]) => ({ x, z })), width: b.width, stroke: '#ff7a1c' });
      }
    }
    for (const s of this.landingSites) {
      this.minimapShapes.push({
        kind: 'circle', x: s.position.x, z: s.position.z, r: s.radius,
        fill: 'rgba(100,216,255,0.22)', stroke: '#64d8ff',
      });
    }
  }

  /* ================================================================== */
  /* Frame                                                              */
  /* ================================================================== */

  update(dt, elapsed) {
    this._t = elapsed;
    if (this._sky) this._sky.update(dt);
    if (this._liquidUniforms) this._liquidUniforms.uTime.value = elapsed;
    for (let i = 0; i < this._plumes.length; i++) this._plumes[i].material.uniforms.uTime.value = elapsed;
    if (this._ash) {
      this._ash.uniforms.uTime.value = elapsed;
      // Written into the existing uniform vector, never replaced: this runs
      // every frame and a new Vector3 here is 60 allocations a second.
      const cam = this.engine?.camera;
      if (cam) cam.getWorldPosition(this._ash.uniforms.uEye.value);
    }
  }

  onActivate() {
    super.onActivate();
    // The dome has to ride the camera or the player walks out of the sky.
    if (this._sky && this.engine?.camera) this._sky.mesh.position.copy(this.engine.camera.position);
  }

  dispose() {
    for (const o of this._owned) o.dispose?.();
    this._owned.length = 0;
    this._sky?.dispose?.();
    this._sky = null;
    this._plumes.length = 0;
    this._ash = null;
    this._propMat = null;
    this.mineralNodes.length = 0;
    this.landingSites.length = 0;
    super.dispose();
  }
}
