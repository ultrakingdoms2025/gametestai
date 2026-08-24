import * as THREE from 'three';
import { World } from './World.js';
import { makeRules } from './WorldRules.js';
import { createSky } from '../gfx/Sky.js';

import {
  SPACE_BODIES,
  BELT,
  DOCK_ANCHOR,
  BODY_BY_ID,
  STAR_DIRECTION,
  approachState,
  landableBodies,
  navTargets,
} from './space/Bodies.js';
import { Backdrop } from './space/Backdrop.js';
import { Belt, HERO_RADIUS } from './space/Belt.js';
import { loadBeltAssets } from './space/BeltAssets.js';
import { DockExterior, APRON_Z, APRON_Z1, APRON_HALF_W } from './space/DockExterior.js';
import {
  makeBodyMaterial,
  makeAtmosphereMaterial,
  makeRingMaterial,
  makeCoronaMaterial,
} from './space/BodyShaders.js';
import { screenFraction, NEAR_FIELD } from './space/Scale.js';

/**
 * OPEN SPACE - the volume the ship flies in.
 *
 * ===========================================================================
 *  WHAT THIS WORLD IS
 * ===========================================================================
 *
 * Eight hundred kilometres of navigable volume with six real bodies in it, the
 * yard at the origin, and a debris field to port. It replaces the 60 m holding
 * platform that stood here to prove the registration seam; the seam it proved
 * is unchanged, and the return portal is still one spec pointing at `dock`.
 *
 * The three files it is mostly made of, in the order worth reading them:
 *
 *   space/Scale.js       how 800 km fits inside a 2,000 m far plane. Read this
 *                        first; nothing else makes sense without it.
 *   space/Bodies.js      where everything is, and the interface the planet
 *                        system consumes to run a descent.
 *   space/Backdrop.js    the per-frame driver, and why the depth buffer is
 *                        switched off for planets.
 *
 * ===========================================================================
 *  THE SKY IS TWO THINGS
 * ===========================================================================
 *
 * `gfx/Sky.js` already had a space dome - nebula, galactic band and four
 * layers of spectrally-classed stars - and it is reused verbatim for the
 * INFINITE part of the sky. Its painted planet, moon and sun disc are switched
 * off, because this world draws those as real objects you can fly to.
 *
 * `sunSize` is set to 0.004 rather than 0, and the difference matters. At 0
 * the dome's `smoothstep(cos(uSunSize*1.35), cos(uSunSize*0.85), sd)` gets
 * equal edges, which is a divide by zero in GLSL and produces NaN across the
 * disc. NaN through the bloom blacks out the whole frame - it happened one
 * folder over and cost a day. 0.004 rad is 0.23 degrees, hidden entirely
 * inside Erenmark's real 2.78-degree disc, and it keeps the dome's glare bleed
 * (`pow(sd, 400)` and `pow(sd, 40)`), which is the wide soft halo around the
 * star that the real geometry cannot draw.
 *
 * ===========================================================================
 *  BUDGET
 * ===========================================================================
 *
 * ┌──────────────────────────────────────────────────────────────────────────┐
 * │ THIS BLOCK WAS STALE BY A FACTOR OF TWO AND NOTHING TESTED IT.           │
 * └──────────────────────────────────────────────────────────────────────────┘
 *
 * It said 41 meshes and 72,634 triangles, and described "bodies 9 (5 surfaces,
 * 2 halos...)". Those were Phase 1 numbers. Phase 2 added seven more bodies -
 * seven more 6,016-triangle spheres and their halos - and nobody came back.
 * Re-measured in Chrome at 1600x900 over all fifteen `VIEWS.space` framings by
 * `scripts/world-shot.mjs`, on the Phase 9 tree:
 *
 *   renderables   45   sky 1; bodies 22 (12 surfaces, 8 halo shells, 1 ring,
 *   in the group       1 corona); belt 4; dock 18 including the beacon
 *   triangles     163,892 from a bearing framing, 184,970 standing on the
 *                 apron - the exterior hides its window, lamp and ring detail
 *                 beyond a few kilometres, so the range is LOD and not noise.
 *                 The twelve body spheres and eight halo shells are 120,320 of
 *                 it (one shared 64x48 unit sphere), the belt 39,280, the sky
 *                 dome 3,968, the dock 12,280 at the mouth
 *   drawn/frame   117 down a bearing, 179 on the apron. WHOLE-FRAME counts
 *                 including the HUD, the viewmodel, the GTAO prepass and the
 *                 shared systems every world runs; this world contributes at
 *                 most its 45
 *   materials     41, every one of them NAMED - see `_mat`
 *   programs      423 once the run has settled. This number is the one to
 *                 watch and the one that is hardest to read: it is a CACHE,
 *                 it only grows, and the per-framing value is wherever the
 *                 warm-up happened to have got to. Measured twice on identical
 *                 code, the same framing swung by up to +39 mid-run and landed
 *                 on 423 both times. Compare the settled value; a mid-run
 *                 delta is noise.
 *   point lights  0. The star is the scene directional; everything that looks
 *                 like a lamp is emissive geometry above the bloom threshold.
 *                 `RIG_BUDGET.point` is 12 for the whole game and every one of
 *                 them is compiled into every shader in every world.
 *   world lights  1 - the rim fill in `_buildRim`, created INVISIBLE. See the
 *                 note there; it is not tidiness, it is a recompile.
 *   per frame     0.020 to 0.030 ms for `Backdrop.update` over 7 members PLUS
 *                 all 260 belt placements, averaged over 300-400 frames across
 *                 several runs. No allocation after `build`.
 *
 * The dock was 70 of those meshes before its boxes were batched per material -
 * see the note in DockExterior.js. It is the one structure here that is on
 * screen from nearly every vantage, so it is the one whose draw count is paid
 * continuously rather than occasionally.
 *
 * `scripts/tests/space-art.test.mjs` holds the parts of this block a test can
 * hold - the light count, the light's visibility, the material names. The
 * triangle and draw figures are a browser measurement and live here as a dated
 * record, which is exactly how the numbers above went stale. Re-run
 * `node scripts/world-shot.mjs --world space` before trusting them.
 */

/* Module-level scratch. */
const _UP = new THREE.Vector3(0, 1, 0);
const _axis = new THREE.Vector3();
const _shipPos = new THREE.Vector3();
/* Scratch for the rim fill. Written every frame; nothing here allocates. */
const _rimFwd = new THREE.Vector3();
const _rimRight = new THREE.Vector3();
const _rimAt = new THREE.Vector3();

/** Where the return portal stands, just outside the hangar mouth. */
const PORTAL_Z = -24;

export class SpaceWorld extends World {
  static id = 'space';
  static displayName = 'Open Space';

  constructor(ctx) {
    super(ctx);

    this.rules = makeRules({
      /* Everything that belongs to a place rather than to the player is off.
       * There is no economy in vacuum, no garrison, no caches, nothing to
       * find on foot. Leaving them on would scatter traders and relic spawns
       * across a docking apron. */
      merchants: false,
      quests: false,
      contracts: false,
      caches: false,
      relics: false,
      loot: false,
      races: false,
      interiors: false,
      swim: false,
      crowd: false,
      /* Hostiles ON. Alien craft attacking the player in flight is the
       * headline feature of this volume; the combat agent needs the gate open
       * even while the spawner is still being written. */
      hostiles: true,
      /* Mounts off - a flying mount out here is the flight model, badly. */
      mounts: false,
    });

    /* Bounds frame the MINIMAP, and a minimap of 800 km of empty volume is a
     * blank square. So this is the yard and its piers, which is the only part
     * of this world a floorplan means anything for. A space map wants a
     * different projection entirely - range rings and body bearings - and
     * that belongs to whoever owns the HUD, with `navTargets()` as its input. */
    this.bounds = new THREE.Box3(
      new THREE.Vector3(-300, -120, -320),
      new THREE.Vector3(300, 220, 300)
    );

    /**
     * The single Vector3 every terminator in this world points at. The body
     * shaders, the atmosphere shells, the ring shadow and the scene's own
     * directional light all hold THIS instance, so the star cannot end up
     * lighting one thing from a direction it is not in.
     */
    this.starDirection = new THREE.Vector3(
      STAR_DIRECTION[0], STAR_DIRECTION[1], STAR_DIRECTION[2]
    );

    this.environment = {
      ...this.environment,
      background: new THREE.Color(0x01020a),
      fogColor: new THREE.Color(0x01020a),
      /* No fog. There is no medium out here, and haze between the ship and a
       * planet would read as a dirty lens. Set far beyond anything drawn
       * rather than disabled, so a material that forgets `fog: false` degrades
       * to "no visible fog" instead of to a hard cut. */
      fogNear: 6000,
      fogFar: 60000,
      exposure: 1.02,
      /* Ambient is nearly nothing and slightly blue: the only fill in space is
       * starlight, and the value exists so a hull's night side is a shape
       * rather than a hole. */
      ambientColor: new THREE.Color(0x1b2740),
      /* 0.28, up from 0.16, and it does NOT flatten the planets.
       *
       * That was the objection to raising it and it is wrong about this world:
       * every body out here is a raw `ShaderMaterial` from `BodyShaders.js`
       * with its own `uAmbient` uniform and no `lights: true`, so the scene
       * ambient reaches the SHIP, the belt and the yard's exterior and reaches
       * nothing that has a terminator on it. Measured over the flown Kestrel's
       * own bounding box in the chase view at 0.16: median luma 9/255 with
       * 55.7% of hull pixels under 12, and 2/255 with 72.4% under 12 when
       * flying at the star - which is the framing a player spends the whole
       * space half of the loop looking at. */
      ambientIntensity: 0.28,
      skyColor: new THREE.Color(0x16203a),
      groundColor: new THREE.Color(0x08070c),
      hemiIntensity: 0.22,
      sunColor: new THREE.Color(0xffdcb4),
      sunIntensity: 3.1,
      sunDirection: this.starDirection,
      envMapIntensity: 0.95,
      /* null keeps GRADE_PRESETS.space, whose bloom threshold is 1.60. Every
       * emissive value in this world was chosen against that number: the star
       * at 2.9, the bay mouth at 2.4, the running lights at 2.6, Cinder's
       * fissures up to 4.2. Change the threshold and the sky goes out. */
      bloom: null,
    };

    /** @type {THREE.Material[]} */
    this._mats = [];
    /** @type {THREE.BufferGeometry[]} */
    this._geoms = [];
    /** @type {Array<{body:object, spin:THREE.Object3D}>} */
    this._spinners = [];

    /**
     * WHERE THE FIGHTING IS. Consumed by `ships/SpaceCombat.js`, which arms
     * off this field on `world:changed` exactly as `ShipRegistry` arms off
     * `world.ships` and `Mining` off `world.mineralNodes` - so this world does
     * not know that a combat system exists and a world with no zones simply
     * has none. Filled by `_fillEncounters`; see the reasoning there.
     * @type {Array<object>}
     */
    this.encounters = [];

    this.backdrop = null;
    this.belt = null;
    this.dock = null;
    this._dockMember = null;
    this._sky = null;
    this._corona = null;
  }

  /**
   * Track a material for teardown, and NAME IT.
   *
   * The name is not decoration. `scripts/world-shot.mjs --ablate` - the A/B
   * that answers "which system owns this pixel" - identifies materials BY
   * NAME, and `art-station` found all 225 of its world's materials anonymous
   * and its whole ablation silently useless. Open space was in the same state:
   * 43 materials, of which exactly one (`Sky.space`) had a name.
   *
   * The name is required rather than optional, because the next material
   * somebody adds is the one that would have been left out. It costs nothing:
   * `WebGLPrograms.getProgramCacheKey` never reads it, so the program cache
   * cannot move.
   *
   * @param {string} name
   * @param {THREE.Material} m
   */
  _mat(name, m) {
    if (!name) throw new Error('[SpaceWorld] every material needs a name - see --ablate');
    m.name = name;
    this._mats.push(m);
    return m;
  }

  _geo(g) {
    this._geoms.push(g);
    return g;
  }

  async build(onProgress) {
    onProgress?.(0.06, 'Opening the bay');
    this.backdrop = new Backdrop(this.engine?.camera ?? null);

    this._buildSky();
    onProgress?.(0.24, 'Hanging the stars');

    this._buildBodies();
    onProgress?.(0.56, 'Placing the worlds');

    /* The authored hero boulder, before the belt is built rather than after -
     * `Belt._build` reads the resolved cache synchronously, and an asset that
     * lands one tick later is an asset the field was already built without.
     *
     * `loadBeltAssets` never rejects and resolves to null when the file is
     * absent, which is the arm every head-less build in the suite takes; see
     * the header of `space/BeltAssets.js`. It is awaited between two progress
     * ticks so a slow first fetch reads as a loading bar rather than a stall. */
    await loadBeltAssets();
    this._buildBelt();
    onProgress?.(0.72, 'Scattering Halberd Reach');

    this._buildDock();
    onProgress?.(0.9, 'Lighting the beacon');

    this._buildRim();
    this._fillSpawns();
    this._fillEncounters();

    /* Place everything once, now, against the camera as it currently stands.
     * Without this the first rendered frame has every body sitting at the
     * scene origin at unit scale - five planets stacked inside the dock - and
     * whether the player ever sees it depends on whether the loading screen
     * happens to still be up.
     *
     * Both calls no-op when there is no camera, which is the case for every
     * head-less build in the suite. */
    this.backdrop.update();
    this.belt.update(0);

    onProgress?.(1, 'Open space');
  }

  /* ------------------------------------------------------------------ */
  /* The infinite sky                                                    */
  /* ------------------------------------------------------------------ */

  _buildSky() {
    this._sky = createSky('space', {
      radius: 1920,
      camera: this.engine?.camera ?? null,
      sunDirection: this.starDirection,
      sunColor: 0xffcf9a,
      /* NOT zero. See the header - zero is a divide by zero in the dome's
       * smoothstep and NaN through the bloom is a black frame. */
      sunSize: 0.004,

      /* The painted bodies are off; this world has real ones. */
      planetAngularRadius: 0,
      moonAngularRadius: 0,

      nebulaA: 0x2a1547,
      nebulaB: 0x0b3550,
      nebulaC: 0x6d2352,
      nebulaDensity: 0.5,

      /* THE THING TO NAVIGATE BY.
       *
       * A player in a six-degree world with no ground has no absolute
       * orientation at all, and "which way is up" stops being a question with
       * an answer about four seconds after their first roll. The galactic band
       * is the answer: a bright lane right across the sky, visible from every
       * point in the volume, that does not move when they do.
       *
       * The axis is close to +Y, which lays the band roughly across the XZ
       * plane - so it reads as a horizon. Tilted 18 degrees off vertical so it
       * is not exactly the plane the bodies are laid out in, which would make
       * the two hard to tell apart.
       *
       * Strength up from the preset's 0.11: at 0.11 it is a hint, and a
       * navigation reference has to be legible against a lit planet.
       */
      galaxyAxis: new THREE.Vector3(0.30, 0.90, -0.31),
      galaxyStrength: 0.17,

      starBrightness: 1.15,
      exposure: 1.0,
    });
    this._sky.mesh.name = 'space:sky';
    this.group.add(this._sky.mesh);
  }

  /* ------------------------------------------------------------------ */
  /* The bodies                                                          */
  /* ------------------------------------------------------------------ */

  _buildBodies() {
    /* One sphere geometry, shared by every body. It is a unit sphere; each
     * body's true radius is the scale on its own mesh and the proxy factor is
     * the scale on the group above it, so the two multiply to the drawn
     * radius. 64x48 is 6,144 triangles - at Cinder's landing approach that is
     * one triangle per 340 screen pixels, and the silhouette is smooth.
     * Cheaper is visible: at 32x24 the limb is a visible polygon against the
     * atmosphere halo, which is the one place on a planet the eye is looking. */
    const sphere = this._geo(new THREE.SphereGeometry(1, 64, 48));

    for (const body of SPACE_BODIES) {
      const g = new THREE.Group();
      g.name = `space:body:${body.id}`;
      this.group.add(g);

      /* Axis node: tilts the whole body so its poles are where the descriptor
       * says. The ring hangs off this too, which is what keeps a ring in its
       * planet's equatorial plane rather than in the world's. */
      const axisNode = new THREE.Object3D();
      _axis.set(body.axis[0], body.axis[1], body.axis[2]).normalize();
      axisNode.quaternion.setFromUnitVectors(_UP, _axis);
      g.add(axisNode);

      const spinNode = new THREE.Object3D();
      axisNode.add(spinNode);

      const mat = this._mat(`space:body:${body.id}:surface`, makeBodyMaterial(body, this.starDirection));
      const mesh = new THREE.Mesh(sphere, mat);
      mesh.name = `space:body:${body.id}:surface`;
      mesh.scale.setScalar(body.radius);
      mesh.frustumCulled = false;
      /* Sub-order inside this body's render-order band. The surface is the
       * floor; the ring sits on it, the atmosphere over both, the corona last.
       * See the renderOrder note in Backdrop.js - these are the only things
       * in this world whose relative order the depth buffer does not decide. */
      mesh.userData.backdropSub = 0;
      spinNode.add(mesh);

      if (body.spin) this._spinners.push({ body, spin: spinNode });

      /* Atmosphere, when there is one. Outside the axis node: a haze shell has
       * no poles and spinning it would be spinning nothing.
       *
       * The shell is drawn at `look.haloScale` radii, NOT at `atmosphere`, and
       * the two are deliberately different numbers. `atmosphere` is a GAMEPLAY
       * radius: Cinder carries 1,600 m of air on a 9 km world so a descent has
       * several seconds of entry in it. Drawn at that radius the halo is a
       * band 18% of the planet's radius wide, and that does not read as an
       * atmosphere - it reads as an orange rubber tyre round the planet, which
       * is exactly what the first screenshot showed. A real atmosphere is a
       * percent or two of the radius, and 1.05 is what that looks like. */
      if (body.atmosphere > body.radius && (body.look.atmoStrength ?? 0) > 0) {
        const shell = new THREE.Mesh(sphere, this._mat(
          `space:body:${body.id}:air`, makeAtmosphereMaterial(body, this.starDirection)
        ));
        shell.name = `space:body:${body.id}:air`;
        shell.scale.setScalar(body.radius * (body.look.haloScale ?? 1.05));
        shell.frustumCulled = false;
        shell.userData.backdropSub = 2;
        g.add(shell);
      }

      let ringMat = null;
      let boundRadius = body.radius;
      if (body.ring) {
        /* Built in units of PLANET radii and scaled by the planet radius, so
         * the shader can compare `length(vLocal.xy)` straight against
         * `uInner`/`uOuter` from the descriptor without a conversion nobody
         * would remember to keep in step. */
        const ringGeo = this._geo(
          new THREE.RingGeometry(body.ring.inner, body.ring.outer, 160, 1)
        );
        ringMat = this._mat(`space:body:${body.id}:ring`, makeRingMaterial(body, this.starDirection));
        const ring = new THREE.Mesh(ringGeo, ringMat);
        ring.name = `space:body:${body.id}:ring`;
        ring.rotation.x = -Math.PI / 2;
        ring.scale.setScalar(body.radius);
        ring.frustumCulled = false;
        ring.userData.backdropSub = 1;
        axisNode.add(ring);
        /* The BOUNDING radius, not the body radius, is what the far-limb cap
         * has to work from - otherwise the outer edge of an 87 km ring system
         * is placed beyond the far plane and the rings get their far half
         * sliced off in a perfect straight line. */
        boundRadius = body.radius * body.ring.outer;
      }

      if (body.kind === 'star') {
        const corona = new THREE.Mesh(
          this._geo(new THREE.PlaneGeometry(1, 1)),
          this._mat(`space:body:${body.id}:corona`, makeCoronaMaterial(body))
        );
        corona.name = 'space:body:erenmark:corona';
        corona.scale.setScalar(body.radius * (body.look.coronaScale ?? 3));
        corona.frustumCulled = false;
        corona.userData.backdropSub = 3;
        g.add(corona);
        this._corona = corona;
        boundRadius = Math.max(boundRadius, body.radius * (body.look.coronaScale ?? 3) * 0.5);
      }

      this.backdrop.addBody(g, body.position, boundRadius, {
        name: body.name,
        onPlace: ringMat
          ? (obj, _d, scale) => {
              /* The ring's occlusion and shadow rays are cast in the RENDER
               * frame, so they need the planet's PROXY centre and PROXY
               * radius. Feeding them the true values puts the shadow tens of
               * degrees away from the planet casting it. */
              ringMat.uniforms.uPlanetCenter.value.copy(obj.position);
              ringMat.uniforms.uPlanetRadius.value = body.radius * scale;
            }
          : null,
      });
    }
  }

  /* ------------------------------------------------------------------ */
  /* Halberd Reach                                                       */
  /* ------------------------------------------------------------------ */

  _buildBelt() {
    this.belt = new Belt(BELT, this.engine?.camera ?? null);
    this.group.add(this.belt.group);

    /* Ranked with the bodies so it paints in the right order against them, but
     * NOT transformed: it places its own rocks. See the header of Belt.js. */
    this.backdrop.addStructure(this.belt.group, BELT.position, BELT.extent[0], {
      name: BELT.name,
      transform: false,
    });

    /* Colliders for the rocks big enough to matter, at TRUE positions. Boxes
     * because that is what `Physics` has; the inscribed box of a sphere of
     * radius r has half-extent r*0.62, which under-covers the corners and
     * over-covers nothing - the failure mode is clipping a rock's edge rather
     * than hitting empty space, and of the two that is the one a pilot
     * forgives. `Belt.colliderRocks` publishes the true spheres for whoever
     * writes the real flight collision. */
    let n = 0;
    for (const r of this.belt.colliderRocks) {
      const h = r.r * 0.62;
      this.track(this.physics.addBox(r.x, r.y, r.z, h, h, h));
      n++;
    }
    this.beltColliderCount = n;
  }

  /* ------------------------------------------------------------------ */
  /* The yard                                                            */
  /* ------------------------------------------------------------------ */

  _buildDock() {
    this.dock = new DockExterior(DOCK_ANCHOR, this);
    this.group.add(this.dock.group);
    this._dockMember = this.backdrop.addStructure(
      this.dock.group, DOCK_ANCHOR.position, DOCK_ANCHOR.radius, { name: DOCK_ANCHOR.name }
    );
  }

  /* ------------------------------------------------------------------ */
  /* Spawns, the way home, the map                                       */
  /* ------------------------------------------------------------------ */

  _fillSpawns() {
    /* On the apron, outside the mouth, facing out along the piers. Yaw 0 faces
     * -Z, which is outbound - the first thing a player sees on arriving is the
     * four piers and Vitrine straight ahead beyond them. */
    this.playerSpawn.fromArray(DOCK_ANCHOR.apronSpawn);
    this.playerSpawnYaw = 0;

    /* The way home. ONE spec, targeting `dock`.
     *
     * `rotationY: Math.PI` for the same reason the yard's own gateway carries
     * it: `arrivalFor` puts an arriving player 2.6 m along
     * `(sin rotY, cos rotY)` and turns them further along it, so PI lands them
     * at z -26.6 facing out across the apron rather than at z -21.4 facing the
     * blast door they just came through. */
    this.portalSpecs.push({
      position: new THREE.Vector3(0, 0.4, PORTAL_Z),
      rotationY: Math.PI,
      target: 'dock',
      label: 'Lodestar Yard',
      accent: 0xffb45a,
      style: 'launch',
    });

    /* The apron and the four piers, which is all a floorplan can say here.
     *
     * Both apron numbers are DERIVED, not typed. `APRON_HALF_W` was renamed to
     * `HALL_OUTER_HW - 2` = 88 and this rect stayed at the old `w: 130`, so
     * the map drew a 130 m apron over a 176 m one: a player standing legally
     * at x = ±80 was drawn off the edge of their own deck. The adjacent
     * cross-walk rect (224) had been updated and this one had not, which is
     * exactly what a hand-copied constant does. */
    const apronZ0 = APRON_Z, apronZ1 = APRON_Z1;
    this.minimapShapes.push(
      { kind: 'rect', x: 0, z: (apronZ0 + apronZ1) / 2, w: APRON_HALF_W * 2, d: apronZ1 - apronZ0, rotation: 0,
        fill: 'rgba(18,26,40,0.85)', stroke: 'rgba(255,180,90,0.9)' },
      { kind: 'rect', x: 0, z: -91, w: 224, d: 14, rotation: 0,
        fill: 'rgba(18,26,40,0.85)', stroke: 'rgba(255,180,90,0.7)' },
      { kind: 'circle', x: 0, z: PORTAL_Z, r: 4,
        fill: 'rgba(255,180,90,0.3)', stroke: '#ffb45a' }
    );
    for (const b of DOCK_ANCHOR.berths) {
      const [bx, , bz] = b.position;
      this.minimapShapes.push(
        { kind: 'rect', x: bx, z: (bz - 98) / 2 - 0, w: 9, d: Math.abs(bz - 98) - 10, rotation: 0,
          fill: 'rgba(18,26,40,0.7)', stroke: 'rgba(255,180,90,0.5)' },
        { kind: 'circle', x: bx, z: bz, r: 8,
          fill: 'rgba(255,180,90,0.14)', stroke: 'rgba(255,180,90,0.8)' }
      );
    }
  }

  /* ------------------------------------------------------------------ */
  /* Where the fighting is                                               */
  /* ------------------------------------------------------------------ */

  /**
   * WHERE THE FIGHTING IS: two authored fights, and one picket on every route.
   *
   * ── PLACEMENT IS THE WHOLE PROBLEM ────────────────────────────────────────
   *
   * Citadel shipped a world with zero reachable wildlife and 29 green tests,
   * because the wildlife was placed where nobody walks. Eight hundred
   * kilometres of empty volume is that failure mode with the difficulty turned
   * up: a picket at a random bearing 200 km out would be perfectly built,
   * fully functional, and never once seen by a player.
   *
   * So the zones are not placed in space. They are placed on the ROUTES, and a
   * route is `yard -> landable body` plus the one detour worth taking:
   *
   *   dock -> <body>   every trip in this world is one of these lines or a
   *                    return along it, so a zone astride one is a zone the
   *                    player meets on the way to somewhere they chose to go.
   *   Halberd Reach    26 km to port, in the nav list from the moment you
   *                    launch, and the only thing close enough to be worth a
   *                    detour rather than a destination. A nest there is what
   *                    makes the detour a decision rather than sightseeing.
   *
   * Every position below is DERIVED from `Bodies.js` rather than written out,
   * so if the body layout moves the pickets move with it. A hand-typed
   * coordinate here is a picket left behind in empty space the first time
   * somebody re-tunes the volume.
   *
   * ── PHASE 2: TEN ROUTES, NOT ONE ─────────────────────────────────────────
   *
   * This method used to take `BODY_BY_ID.cinder` by name and build three zones
   * on the one route that existed. Phase 2 made nine more bodies landable and
   * that hard-coded name became a SILENT hole: every new planet was a route
   * with nothing on it, so nine of ten trips out of the yard were an empty
   * volume and a landing. Nothing failed; the world just got quieter the more
   * of it there was.
   *
   * The fix is to sweep `landableBodies()`, which is the same list the nav
   * readout, the survey plot and the descent all read - so a planet cannot be
   * added to the system and be missed here.
   *
   * ── AND THE POPULATION DID NOT GO UP TENFOLD ─────────────────────────────
   *
   *   before   3 zones,  9 hostiles
   *   after   12 zones, 30 hostiles
   *
   * Ten routes with the old three-zone density on each would have been ninety
   * hostiles, which is not a system, it is a shooting gallery. What is held
   * constant is the thing a player actually experiences: ONE fight of two to
   * four hostiles on a trip out, exactly as before. The volume holds more
   * because there is more volume in use; the DENSITY per route went down.
   *
   * ── ...EXCEPT ON THE ONE ROUTE EVERY NEW PLAYER FLIES FIRST ──────────────
   *
   * That paragraph used to end "because the Cinder run keeps two zones and
   * every other run has one", and it said it as though it were a rounding
   * error. It was the most expensive sentence in this file.
   *
   * Flown in a real boot with the encounters live - not in `_flightrig`, which
   * has no `SpaceCombat` in it and once "verified" this leg at 23.5 s - the
   * dock-to-Cinder run timed 67 to 72 seconds, six runs out of six, against
   * Tessera at 87 km in 56.6 s and Shoal at 140 km in 59.6. THE NEAREST PLANET
   * TOOK LONGER THAN THE SECOND-FURTHEST. The trace says exactly why:
   *
   *     t+0.0   Z pressed, drive spools
   *     t+1.9   engaged, 4,211 m/s
   *     t+4.7   the Ashlane picket arms at 16.3 km - drive CUT
   *     t+6.0   two skiffs in the sky, 210 m/s
   *     t+25.1  lock releases (19.1 s), the x8 multiplier ramps back
   *     t+36.6  Cinder's own picket arms - cut AGAIN
   *     t+53.1  lock releases (16.5 s)
   *     t+56.3  atmosphere
   *
   * An interdiction costs about 19 seconds of flying at cruise whether or not
   * you take the fight, and this route was charging it twice. One is content;
   * two on a 62 km leg is thirty-eight seconds of holding W.
   *
   * So the Ashlane picket moved. It did NOT get deleted - see the note on it
   * in `zones` below - because the fix for "the tutorial route has two tolls"
   * is not "the tutorial route has no fight", and its two skiffs are still the
   * ladder's bottom rung. What changed is which lane pays for them, and the
   * wings were swapped with it so that the fight a player meets FIRST is still
   * the smallest one in the system.
   *
   * ── AND THEN THE LATHE LEG WAS FLOWN, WHICH IT HAD NOT BEEN ─────────────
   *
   * The move above was made without flying the route it moved the toll ONTO.
   * Its author said so: "the Lathe leg is now ~19 s longer and I did not fly it
   * end to end; the pigeonhole is forced by the placement test, so the decision
   * was only which lane pays." Flown, in a real boot of the static build with
   * the encounters live, stock Kestrel, all six legs in ONE session so the
   * numbers are comparable:
   *
   *     leg        km   zones   Z pressed once   Z re-pressed   again, clean
   *     cinder     62     1         49.4 s          58.0 s         64.8 s
   *     lathe     185     2        134.8 s          92.8 s         87.9 s
   *     cathedra  288     1         95.0 s          91.3 s         94.9 s
   *
   * (Two independent boots for the right-hand pair, because a leg time is a
   * wall-clock number taken in a browser and one session is an anecdote. They
   * agree within 8%, and in the second the Lathe leg comes in UNDER Cathedra's.)
   *
   * Read the re-pressed columns first, because they are the game working as
   * designed: a pilot who re-engages the drive when the lock clears reaches
   * Lathe in 88-93 s against the longest leg in the system at 91-95. The
   * doubled lane costs what the far edge of the volume costs - the top of the
   * band, not outside it. **Two interdictions on the 185 km run is content, and
   * the placement stands.**
   *
   * ── THE LEFT-HAND COLUMN, AND WHY IT IS NOT A PICKET PROBLEM ─────────────
   *
   * A pilot who presses Z once and never again reaches Lathe in 134.8 s - 42%
   * longer than Cathedra at 288 km, which is precisely the shape of the defect
   * this whole move was made to remove, wearing a different lane.
   *
   * It is tempting to move the toll again, onto the longest lane, and the
   * arithmetic says that makes it WORSE. The doubled zone cannot leave the
   * inner system: `space-objectives.test.mjs` derives `KILL_TIERS` rung 2 from
   * one full sweep of everything inside Cinder's orbit, which is three zones
   * and nine hostiles, so wherever it goes it is an EARLY toll at 45 km. An
   * early toll on a drive that is never re-engaged costs the rest of the leg at
   * the x8 courtesy multiplier's 1,680 m/s instead of the drive's 4,200 - about
   * 0.36 s per remaining kilometre. On Lathe's 185 km lane that is 50 s; on
   * Cathedra's 288 km lane it would be 87 s. Every lane long enough to satisfy
   * the placement test's "doubled route > 2x the shortest" is long enough to
   * invert against Cathedra, and the only lanes that would not are the two
   * shortest, which are the tutorial run and the one after it.
   *
   * SO THERE IS NO PLACEMENT THAT FIXES IT, and the reason is not the picket:
   * it is that the transit drive is a LATCH which nothing ever said had come
   * back. `Piloting.TRANSIT_REASONS.released` is the fix - the lock now says
   * when it breaks - and it is worth 42 seconds on this lane against the ~19
   * the move was weighed on.
   *
   * Flown with that sentence in the build, it fires exactly once on the whole
   * dock-Lathe-Cathedra circuit: on the Lathe outer screen, in open space, where
   * re-engaging is worth about forty-five seconds. The other three locks on that
   * circuit break inside a gravity well, where the drive would refuse the key
   * anyway, and it correctly says nothing.
   *
   * ── THE PICKETS VARY, BECAUSE THE ROUTES ARE NOT THE SAME ROUTE ──────────
   *
   * A lawless belt is not an approach to a body somebody is already working.
   * The wing on each route is authored in `PICKETS` below with a line saying
   * what that route is; the only thing derived is WHERE it sits. Three shapes
   * recur and each says something:
   *
   *   a pair of skiffs      opportunists. The cheap runs - Tessera, Sirocco,
   *                         Verdigris - where the hold coming home is not
   *                         worth a heavy.
   *   skiffs plus a lance   somebody is invested. Cinder, Vitrine, Lathe and
   *                         Cathedra: the four richest holds in the system.
   *   a lance alone         Shoal. Not a wing at all - one heavy sitting on a
   *                         line, which reads as a toll rather than an ambush,
   *                         and it is the only zone in the volume you can lose
   *                         to without ever being outnumbered.
   *
   * ── THE STANDOFF, WHICH IS DERIVED AND WAS NOT ───────────────────────────
   *
   * Cinder's picket used to be typed as "78% of the way out", justified in a
   * comment as clearing Cinder's 10.6 km atmosphere and 9.9 km handoff so the
   * fight can never fire a descent seam underneath itself. That is the right
   * rule and the wrong way to hold it - it is one planet's arithmetic, and the
   * other nine have different air. So the rule is now written down instead:
   *
   *     standoff = max(atmosphere, handoff) + PICKET_R + CLEARANCE
   *
   * which clears the outer of the two shells by the whole trigger sphere plus
   * two kilometres, rather than by the zone's centre only. It is stricter than
   * the number it replaces (Cinder moves from 13.6 km out to 16.8 km) and it
   * is the same rule on an airless moonlet, where `atmosphere === radius` and
   * the handoff is the shell that matters.
   *
   * ── THE OFFSETS, WHICH ARE NOT DECORATION ────────────────────────────────
   *
   * Each zone sits `off` metres to one side of the line, on a perpendicular.
   * Dead centre would mean a player holding a perfect course flies through the
   * exact origin of the trigger sphere and the wing appears symmetrically
   * around them; a few hundred metres off means the encounter has a side. The
   * two zones on the Lathe run are offset in different directions so the outer
   * screen and the ring-shadow picket do not feel like the same fight twice,
   * and the ten approach pickets alternate their side IN DISTANCE ORDER -
   * Cinder to port,
   * Tessera to starboard, Sirocco to port, and so on out to Cathedra - because
   * distance order is the order a player works through them, and two trips in
   * a row should not open the same way. The array itself is in `Bodies.js`
   * order, which is not the same thing; the alternation lives in the authored
   * signs rather than in the loop.
   *
   * ── THE DIFFICULTY LADDER, AND THE ORDER OF THIS ARRAY ───────────────────
   *
   *   Cinder orbit   2 skiffs.            190 integrity, 18 dps if both hold
   *                                       a firing solution, which they will
   *                                       not. Survivable in a stock Kestrel
   *                                       (55 shield + 100 hull at -10%): it
   *                                       takes them about half a minute of
   *                                       unanswered fire, and killing both is
   *                                       about four seconds of yours. THE
   *                                       FIRST FIGHT ANYBODY HAS, which is
   *                                       why it is the smallest one.
   *   Lathe screen   2 skiffs + 1 lance.  450 integrity. Met on the run to the
   *                                       richest ore in the system, which is
   *                                       when you have the most to lose.
   *   Halberd Reach  3 skiffs + 1 lance.  545 integrity, 291 credits of
   *                                       bounty. Optional, off the route, and
   *                                       the reason to buy a Pike.
   *
   * Those three are the whole of the INNER SYSTEM - every zone inside Cinder's
   * own orbit - and that set is what `KILL_TIERS` in
   * `systems/SpaceObjectives.js` spaces its rungs on: nine hostiles and 745
   * credits of bounty, both unchanged by the move above, because the same
   * hulls are still in the same three zones and only two of the zones swapped
   * which wing they hold.
   *
   * THOSE THREE STAY AT THE FRONT OF THE ARRAY and the pickets are APPENDED,
   * for the same reason `SPACE_BODIES` keeps Cinder first. They are the whole
   * of the inner system - everything inside Cinder's orbit - which is the run
   * a player flies before they have bought anything, and `KILL_TIERS` in
   * `systems/SpaceObjectives.js` is built on one full sweep of exactly them.
   * `space-objectives.test.mjs` re-derives that rung from this array by
   * distance, so re-ordering is safe; putting a 288 km fight in front of the
   * tutorial one is not.
   *
   * `rearm` is longer than a round trip to the body in question on purpose:
   * coming home past a picket you have just cleared should be quiet, because
   * the reward for winning a fight is not having to fight it again on the way
   * back. It scales with the leg, which is why Cathedra's is 400 s and
   * Tessera's is 240.
   */
  _fillEncounters() {
    /* Trigger radius of every approach picket: 4,200 m, which is the smallest
     * trigger this file has ever authored and therefore the one that does not
     * turn a near miss into an ambush. Uniform on purpose - a trigger that grew with
     * the planet would make the far routes harder to AVOID as well as harder
     * to survive, and avoiding them is a decision worth leaving to the pilot. */
    const PICKET_R = 4200;
    /* How far the trigger sphere must clear the body's outer shell. Two
     * kilometres is about a second and a half of transit at the speed you
     * arrive on a planet, which is enough that a fight and a descent never
     * begin on the same frame. */
    const CLEARANCE = 2000;
    /* No picket lands nearer the yard than this. Nothing in the current layout
     * comes close - Cinder's, the innermost, sits at 45.2 km - but a body added
     * at 20 km would otherwise put a wing on top of the apron, and
     * `SpaceCombat.SAFE_RADIUS` (9 km) refuses to spawn there, which would be a
     * picket that silently never fires. Pushed out instead of dropped. */
    const MIN_ALONG = 14000;

    /**
     * The frame a route is measured in: the unit vector out to a target and
     * two perpendiculars to offset along.
     * @param {number[]} target `[x,y,z]` in the true frame
     */
    const laneOf = (target) => {
      const line = new THREE.Vector3(target[0], target[1], target[2]);
      const dist = line.length();
      const dir = line.clone().normalize();
      const side = new THREE.Vector3().crossVectors(dir, _UP);
      /* Degenerate only for a body directly overhead or underfoot. Nothing in
       * the layout is - Sallow, at 0.82 of -Y, is the closest anything comes -
       * but the fallback is written rather than argued away, because the
       * failure would be a NaN position and this project has already lost a
       * day to a NaN reaching the bloom pass. */
      if (side.lengthSq() < 1e-8) side.crossVectors(dir, new THREE.Vector3(1, 0, 0));
      side.normalize();
      const lift = new THREE.Vector3().crossVectors(side, dir).normalize();
      return { dist, dir, side, lift };
    };

    /** A point `along` metres out on a lane, offset `off` sideways and `up`. */
    const onLane = (lane, along, off, up) => {
      const p = lane.dir.clone().multiplyScalar(along)
        .addScaledVector(lane.side, off)
        .addScaledVector(lane.lift, up);
      return [p.x, p.y, p.z];
    };

    /**
     * One row per landable body, saying what that route IS. Position and
     * standoff are derived; everything here is a decision about the place.
     *
     * A body with no row gets `DEFAULT_PICKET`, which is the whole point of
     * having a default: the failure this method shipped with was a route with
     * NOTHING on it, and a wrong-flavoured pair of skiffs is a far smaller
     * defect than silence. `space-combat.test.mjs` logs every zone with its
     * wing, so an unauthored route shows up in the run log as "unclaimed
     * lane" the day it appears.
     */
    const DEFAULT_PICKET = {
      name: 'unclaimed lane', off: 700, up: -260, rearm: 280,
      wing: [{ class: 'skiff', count: 2 }],
      warn: 'Unknown transponders - closing',
      blurb: 'Somebody is working this lane and did not file it.',
    };
    const PICKETS = {
      /* The one authored fight of Phase 1, unchanged in everything but where
       * the standoff comes from. Kept because it is the fight the difficulty
       * ladder above was measured on. */
      cinder: {
        name: 'Cinder high orbit', off: -900, up: 380, rearm: 300,
        /* TWO SKIFFS, AND THEY USED TO BE TWO SKIFFS AND A LANCE.
         *
         * The wing swapped with the Ashlane's when the Ashlane moved off this
         * lane (see the header). It has to: with the Ashlane gone this is the
         * FIRST fight anybody has, and the difficulty ladder below was built
         * so the first one is the 190-integrity pair a stock Kestrel can take
         * with 55 shield and 100 hull. Promoting a 450-integrity wing into
         * that slot would have fixed the travel time by making the tutorial
         * harder, which is a trade nobody asked for.
         *
         * The name and the blurb still fit: a pair sitting over the caldera
         * waiting for a laden hull is what this was always about. */
        wing: [{ class: 'skiff', count: 2 }],
        warn: 'Raiders holding over Cinder',
        blurb: 'They wait above the caldera for hulls that come up heavy.',
      },
      /* Airless, close in, and platinum-group ore under a black sky. The
       * shortest run after Cinder's and a hold that is not worth a heavy: two
       * skiffs, sitting in the moonlet's shadow because there is no air to
       * scatter light into it. Vacuum is the only cover in the system. */
      tessera: {
        name: 'the Tessera terminator', off: 640, up: -300, rearm: 240,
        wing: [{ class: 'skiff', count: 2 }],
        warn: 'Two contacts off the terminator',
        blurb: 'They sit in the moonlet\'s own shadow, where nothing lights them.',
      },
      /* Two kilometres of opaque orange air below them. A wing here does not
       * have to be heavy - the planet does half the work, because anything
       * that dives for the deck loses sight of everything including the
       * ground. */
      sirocco: {
        name: 'the Sirocco dust line', off: -720, up: 340, rearm: 260,
        wing: [{ class: 'skiff', count: 2 }],
        warn: 'Contacts above the dust line',
        blurb: 'They hold above the haze and let the planet do the hiding.',
      },
      /* ONE LANCE, ALONE, and it is the only zone in the volume where you are
       * not outnumbered. A single heavy parked on a line reads as a toll: it
       * turns like a barge and cannot chase you, so this is the one fight in
       * the system that is genuinely optional while you are inside it. */
      shoal: {
        name: 'the Shoal toll', off: 810, up: -220, rearm: 300,
        wing: [{ class: 'lance', count: 1 }],
        warn: 'One heavy holding the approach',
        blurb: 'It does not chase. It sits on the line and charges for the crossing.',
      },
      /* The deepest air in the system and a subglacial vault under it - the
       * first genuinely rich hold on a long leg, so the first picket with a
       * lance in it since Cinder. */
      vitrine: {
        name: 'the Vitrine shelf watch', off: -880, up: -310, rearm: 300,
        wing: [{ class: 'skiff', count: 2 }, { class: 'lance', count: 1 }],
        warn: 'Three contacts over the ice',
        blurb: 'Whatever comes up out of the vault, they would rather have it.',
      },
      /* Half-lit from the yard and the only body with anything growing on it.
       * Two skiffs: nobody has bothered to garrison a jungle. */
      verdigris: {
        name: 'the Verdigris crescent', off: 690, up: 360, rearm: 260,
        wing: [{ class: 'skiff', count: 2 }],
        warn: 'Contacts on the terminator',
        blurb: 'They work the crescent, where the canopy stops being visible.',
      },
      /* The richest ore in the system, on a moon that shepherds a ring system.
       * Heavy, and the longest rearm short of Cathedra: this is the run worth
       * defending. */
      lathe: {
        name: 'the Lathe ring shadow', off: -760, up: 400, rearm: 360,
        wing: [{ class: 'skiff', count: 2 }, { class: 'lance', count: 1 }],
        warn: 'Three contacts out of the ring shadow',
        blurb: 'They come out of the ring plane, where the giant hides them.',
      },
      /* Thin air, a short descent, and iron nobody is short of. Three skiffs
       * and no heavy: numerous rather than dangerous, which is the one wing
       * shape a Dray with its span cap can actually farm. */
      carnelian: {
        name: 'the Carnelian scarp picket', off: 830, up: -280, rearm: 280,
        wing: [{ class: 'skiff', count: 3 }],
        warn: 'Three light contacts - closing',
        blurb: 'A scarp-line picket. Cheap hulls, and there are always three.',
      },
      /* Back-lit, dim, and under permanent overcast. One skiff and one lance,
       * which is the least legible wing in the system: you cannot tell from
       * the contact count what is out there until the lance fires. */
      sallow: {
        name: 'the Sallow overcast', off: -700, up: -370, rearm: 320,
        wing: [{ class: 'skiff', count: 1 }, { class: 'lance', count: 1 }],
        warn: 'Two contacts - one heavy',
        blurb: 'Two transponders under the cloud, and they are not the same size.',
      },
      /* 288 km, the longest leg there is and the dearest ore off Lathe. The
       * heaviest picket and the longest rearm: if you clear it, the trip home
       * is quiet, and the trip home is ninety seconds long. */
      cathedra: {
        name: 'the Cathedra spire watch', off: 900, up: 330, rearm: 400,
        wing: [{ class: 'skiff', count: 2 }, { class: 'lance', count: 1 }],
        warn: 'Three contacts among the spires',
        blurb: 'They hold off the spire fields, at the far edge of anything.',
      },
    };

    /* ---- the inner system: the run every player flies first ---------- */

    const latheLane = laneOf(BODY_BY_ID.lathe.position);
    const zones = [
      {
        /* ── THE ZONE THAT MOVED, AND WHY IT MOVED HERE ────────────────────
         *
         * `ashlane` keeps its id and nothing else. The id is save data -
         * `SpaceObjectives._wings` is a set of these and a rename would
         * silently un-break the wing for every existing save - so it is
         * history rather than a place name, exactly as `cinder-orbit`'s is.
         *
         * IT COULD NOT SIMPLY BE DELETED. `space-combat.test.mjs` requires
         * every zone to sit within half its own trigger radius of a route, and
         * the routes are the ten yard-to-body lanes plus the belt: eleven
         * routes for twelve zones, so one lane carries two whatever happens.
         * The only decision available is WHICH, and the measurement in the
         * header answers it - the doubled lane must not be the 62 km one every
         * new player flies before they have bought anything.
         *
         * SO IT IS LATHE'S. 45 km out on a 185 km run, which is:
         *   - 20.9 km clear of the nearest other lane at that range, so no
         *     other route crosses it (the whole table is in
         *     `.probe/tk/lanes.mjs`, which derives it from `Bodies.js`);
         *   - inside Cinder's own orbit, so the kill ladder's "one full sweep
         *     of the inner system" is still nine hostiles and 745 credits and
         *     `space-objectives.test.mjs` still finds exactly three zones
         *     there;
         *   - 128 km short of Lathe's own ring-shadow picket, so the two are
         *     an outer screen and an inner guard rather than one fight twice;
         *   - and on the run the PICKETS table already calls "the run worth
         *     defending", which is where a second toll is content rather than
         *     a tax. Nineteen seconds on a 185 km leg is a fifth of what it
         *     was on a 62 km one - and the leg has since been FLOWN rather
         *     than argued about: 92.8 s with the drive re-engaged, against
         *     the longest leg in the system at 91.3. The table, and what
         *     the left-hand column of it cost, are in the method header.
         *
         * It takes Cinder's old wing with it - see the note on `cinder` in
         * PICKETS - because the heavier of the two belongs on the richer run. */
        id: 'ashlane',
        name: 'the Lathe outer screen',
        position: onLane(latheLane, 45000, 640, -260),
        radius: 4200,
        warn: 'Three contacts across the lane',
        wing: [{ class: 'skiff', count: 2 }, { class: 'lance', count: 1 }],
        rearm: 300,
        blurb: 'They sit on the top of the ring run and let nothing up it unseen.',
      },
      {
        id: 'reach-nest',
        name: 'the Halberd Reach nest',
        position: [BELT.position[0], BELT.position[1], BELT.position[2]],
        radius: 5200,
        warn: 'Nest roused - four contacts',
        wing: [{ class: 'skiff', count: 3 }, { class: 'lance', count: 1 }],
        rearm: 420,
        blurb: 'Whatever lives in the Reach does not want the rocks surveyed.',
      },
    ];

    /* ---- one approach picket per landable body ----------------------- */

    for (const body of landableBodies()) {
      const spec = PICKETS[body.id] ?? DEFAULT_PICKET;
      const lane = laneOf(body.position);
      const standoff = Math.max(body.atmosphere, body.handoff) + PICKET_R + CLEARANCE;
      const along = Math.max(lane.dist - standoff, MIN_ALONG);
      zones.push({
        /* `cinder-orbit` keeps the id it shipped with - it is in save data as
         * a broken-wing marker (`SpaceObjectives._wings` is a set of these) and
         * renaming it would silently un-break it for every existing save. The
         * nine new ones are `<body>-approach`. */
        id: body.id === 'cinder' ? 'cinder-orbit' : `${body.id}-approach`,
        name: spec.name,
        position: onLane(lane, along, spec.off, spec.up),
        radius: PICKET_R,
        warn: spec.warn,
        wing: spec.wing.map((w) => ({ class: w.class, count: w.count })),
        rearm: spec.rearm,
        blurb: spec.blurb,
      });
    }

    /* Cinder's picket belongs in the inner three, ahead of the belt nest: see
     * the note on ordering above. It is the only one of the ten that is inside
     * its own tutorial run, so it is lifted out of the appended block rather
     * than the whole list being sorted - sorting by distance would put the
     * belt nest, which is not on a planet route at all, somewhere arbitrary. */
    const orbit = zones.findIndex((z) => z.id === 'cinder-orbit');
    if (orbit > 1) zones.splice(1, 0, zones.splice(orbit, 1)[0]);

    this.encounters = zones;
  }

  /* ------------------------------------------------------------------ */
  /* Per frame                                                           */
  /* ------------------------------------------------------------------ */

  /**
   * THE HULL'S OWN RIM, AND WHY IT IS A LIGHT RATHER THAN MORE AMBIENT.
   *
   * There is exactly one directional key out here - the star - and the chase
   * camera sits OPPOSITE it whenever the player flies toward it. So flying at
   * the only light in the system is the worst-lit framing, not the best:
   * measured over the flown Kestrel's bounding box, nose on Erenmark with
   * `ahead 0.997`, the hull read median 9/255 with 55.7% of its pixels under
   * 12; turned so the star was behind, 2/255 and 72.4%. It is not a shadow-
   * frustum bug - with the harness pin cleared the sun's target tracks the ship
   * correctly - it is structural.
   *
   * A second directional, carried on the camera and aimed at what the camera is
   * looking at, is the fix a film crew would use and it costs nothing:
   * `LightRig` claims any non-slot light a world adds and ranks it into one of
   * `RIG_BUDGET.dirFill`'s three slots, so the number of lights compiled into
   * every shader does not move and there is no warm-up cost. It is cool and
   * weak - it is a fill, not a key - and it is deliberately off the camera's
   * shoulder rather than on its axis, because a light on the view axis flattens
   * a hull exactly as much as ambient does.
   *
   * It reaches the belt and the yard's exterior too, which is correct: those
   * are the other two things in this world made of plate.
   */
  _buildRim() {
    this._rim = new THREE.DirectionalLight(0x9fc4ff, 0.85);
    this._rim.castShadow = false;
    /**
     * CREATED INVISIBLE, and it is not cosmetic.
     *
     * `LightRig` demotes every world light it claims to `visible = false` and
     * copies it into a fixed slot, so the number of lights compiled into every
     * shader never moves. But it claims on `world:changed`, and the frame
     * between `new THREE.DirectionalLight(...)` and that walk is a frame in
     * which this light COUNTS - and one such frame is a full recompile of
     * roughly 390 programs, which is the single most expensive thing that
     * happens in this game.
     *
     * `Caves.js:859` and `MazeChunks.js:393` already create theirs this way
     * with tests enforcing it; the implementation-brief roadmap lists 61 sites
     * across 12 world files that do not, as Phase 1's open item 4. This is one
     * of them, it is in this world's file, and it is one line.
     *
     * Safe against the rig: `LightRig._walk` deliberately ignores a light's
     * OWN `visible` flag when deciding whether to claim it - "the rig is what
     * set it to false" - and only skips lights under a hidden ANCESTOR. So an
     * invisible source is still claimed and still lights the scene through its
     * slot. `space-yard-exterior.test.mjs` holds the flag.
     */
    this._rim.visible = false;
    this._rim.name = 'space:rim';
    this.group.add(this._rim);
    this.group.add(this._rim.target);
  }

  update(dt, elapsed) {
    /* Order matters and it is not arbitrary:
     *   1. the dome re-centres on the camera
     *   2. bodies spin in their own frames
     *   3. the backdrop places every group against the camera and re-ranks
     *   4. the belt places its rocks
     *   5. the dock reads the scale the backdrop just wrote
     * Run 5 before 3 and the beacon is sized from the previous frame's
     * distance, which is a visible flutter when the ship is moving fast. */
    const camera = this.engine?.camera ?? null;
    this._sky.update(dt);

    for (let i = 0; i < this._spinners.length; i++) {
      const s = this._spinners[i];
      s.spin.rotation.y = elapsed * s.body.spin;
    }

    this.backdrop.update();
    this.belt.update(elapsed);

    if (!camera) return;
    if (this._corona) this._corona.quaternion.copy(camera.quaternion);
    if (this._rim) {
      /* Aim at what the camera is looking at, from over its left shoulder and
       * a little above. 40 m ahead is the chase camera's own boom length plus
       * a hull, so the target sits on the ship rather than behind it - a
       * directional light does not attenuate, but its TARGET is what fixes the
       * direction, and a target on the camera would light the hull edge-on. */
      camera.getWorldDirection(_rimFwd);
      _rimRight.crossVectors(_rimFwd, _UP);
      if (_rimRight.lengthSq() < 1e-6) _rimRight.set(1, 0, 0);
      _rimRight.normalize();
      camera.getWorldPosition(_rimAt);
      _rimAt.addScaledVector(_rimFwd, 40);
      this._rim.target.position.copy(_rimAt);
      this._rim.position.copy(_rimAt)
        .addScaledVector(_rimRight, -70)
        .addScaledVector(_UP, 52)
        .addScaledVector(_rimFwd, -26);
    }
    if (this.dock) {
      this.dock.update(camera, elapsed, this._dockMember.scale, this._dockMember.D);
    }
  }

  /* ------------------------------------------------------------------ */
  /* Published surface                                                   */
  /* ------------------------------------------------------------------ */

  /**
   * Which body the ship is falling towards and how far into the fall.
   * Forwarded from Bodies.js so callers holding the world do not have to
   * import the module as well. See `Bodies.approachState`.
   *
   * @param {THREE.Vector3} [shipPos] defaults to the camera
   */
  approach(shipPos) {
    if (shipPos) return approachState(shipPos);
    this.engine.camera.getWorldPosition(_shipPos);
    return approachState(_shipPos);
  }

  /** Everything worth a HUD marker, as plain data. */
  navTargets() {
    return navTargets();
  }

  /**
   * What the sky actually looks like from where the camera is standing, as
   * numbers. This is the harness's window into the scale scheme: it is how
   * "does a planet grow convincingly" gets checked without a screenshot.
   */
  skyReport() {
    this.engine.camera.getWorldPosition(_shipPos);
    const fov = this.engine.camera.fov;
    const rows = this.backdrop.report();
    for (const r of rows) {
      const body = SPACE_BODIES.find((b) => b.name === r.name);
      r.screenFraction = body
        ? +screenFraction(body.radius, r.trueKm * 1000, fov).toFixed(4)
        : null;
    }
    return {
      camera: [+_shipPos.x.toFixed(1), +_shipPos.y.toFixed(1), +_shipPos.z.toFixed(1)],
      nearField: NEAR_FIELD,
      backdropCostMs: +this.backdrop.lastCostMs.toFixed(3),
      approach: this.approach(_shipPos),
      members: rows,
    };
  }

  dispose() {
    this._sky?.dispose();
    this.belt?.dispose();
    this.dock?.dispose();
    for (const g of this._geoms) g.dispose();
    for (const m of this._mats) m.dispose?.();
    this._geoms.length = 0;
    this._mats.length = 0;
    this._spinners.length = 0;
    this.backdrop = null;
    super.dispose();
  }
}
