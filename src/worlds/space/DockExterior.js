import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { buildHullSkin, worldProjectUV } from './HullSkin.js';
import {
  DECK_Y, HALL_GANTRY_Y, HALL_CRANE_Y, HALL_ROOF_Y, HALL_TOP_Y, HALL_ROOF_T,
  HALL_INNER_HW, HALL_OUTER_HW, HALL_WALL_T, HALL_KEEL_D, HALL_KEEL_HW,
  HALL_FRONT_Z, HALL_BACK_Z, WELL_BACK_Z, WELL_FRAME_Z, BAY_PITCH,
  MOUTH_HALF_W, MOUTH_SILL_Y, MOUTH_HEAD_Y, BOUND_R,
} from './DockShape.js';

/**
 * LODESTAR YARD, SEEN FROM OUTSIDE.
 *
 * ===========================================================================
 *  SCOPE - what this is and, more importantly, what it is not
 * ===========================================================================
 *
 * The yard's interior and everything a player walks around belong to
 * `DockWorld` and are not touched here. This is the OUTSIDE: the building you
 * see from four kilometres out, the lit mouth you aim at, the piers reaching
 * into vacuum, and the beacon.
 *
 * The two are joined at `DOCK_ANCHOR` in Bodies.js - the mouth position and
 * the four berth transforms - and, since this rewrite, at `DockShape.js`,
 * which DERIVES the whole building shell from `dock/YardPlan.js`. Read the
 * header of that file before changing a dimension here; the short version is
 * that the exterior no longer has an opinion about how big the hangar is.
 *
 * ===========================================================================
 *  THE VERDICT THIS REWRITE ANSWERS
 * ===========================================================================
 *
 * "The station hull is a big flat untextured grey slab. From outside, the
 * piers are the only thing that says shipyard; the station itself says
 * nothing."
 *
 * Correct, and measurably so. What was here was one 150 x 80 x 60 box, one
 * smooth cylinder, two flat fins and a torus, in six untextured
 * `MeshStandardMaterial`s. Four faults, in the order they cost the most:
 *
 *  1. THE LIT MOUTH WAS NEVER DRAWN. The bay interior was a `PlaneGeometry`,
 *     whose normal is +Z, sitting in a mouth whose normal is -Z, on a
 *     front-side material. It was back-face culled from every vantage outside
 *     the station. The one long-range cue after the beacon, the thing the
 *     whole approach is supposed to aim at, rendered as a black rectangle -
 *     confirmed in a screenshot before a line of this was written. It is now a
 *     real recessed hall with a floor, walls, a gantry, a crane and a back
 *     wall 162 m in, and it is lit.
 *
 *  2. THE BUILDING DID NOT FIT ITS OWN INTERIOR. Sixty metres of exterior
 *     hangar around a hundred and sixty-two metre hall; a seventy metre mouth
 *     on a hundred and sixty-four metre hole. See `DockShape.js`.
 *
 *  3. NOTHING HAD SCALE IN IT. One flat colour across 180 m of wall gives the
 *     eye nothing to measure the building against, so it reads as a shape
 *     rather than as a structure of a known size. Panel lines, seams and bolts
 *     are the ruler: see `HullSkin.js`.
 *
 *  4. IT WAS BACKLIT AND HAD NOTHING OF ITS OWN. The star bears (0.578, 0.469,
 *     0.668) - up, starboard and BEHIND - so the face a player approaches is
 *     lit by 0.28 of blue ambient and nothing else. A station that emits no
 *     light of its own is a silhouette. It now carries about two hundred lit
 *     windows, eaves lighting, radiator glow, worklight spilling out of an
 *     open launch well and a hull under construction lit from inside its own
 *     frame. Every one of those is emissive geometry rather than a light; see
 *     `_buildLights`.
 *
 * ===========================================================================
 *  THE SILHOUETTE, AND WHY IT IS THIS SILHOUETTE
 * ===========================================================================
 *
 * A shipyard is not a spaceship. The thing that makes a place read as "ships
 * are built here" rather than "a big machine is here" is that the biggest mass
 * is a SHED - a long low box with a hole in one end big enough to take a hull
 * through - and that everything else is plant hung off it. So:
 *
 *   the HALL      172 x 162 x 26 of assembly floor, the interior's own
 *                 dimensions, with the mouth in the front wall. Low and wide.
 *   the WELL      the front 70 m of it has NO ROOF, because `ROOF_CUT_Z` says
 *                 so. Six portal frames and five purlins over open sky, with
 *                 the hall lit underneath. This is the single most legible
 *                 shipyard cue in the model: an open building slip you can see
 *                 down into, with a travelling crane in it.
 *   the SLIP      a ship under construction, to starboard, in an open frame -
 *                 ribs on a keel with a third of her plating on. Outboard of
 *                 the hall, where it contradicts nothing the interior says.
 *   the SPINE     the service trunk rising out of the back of the hall, with
 *                 tankage, machinery, masts and a dish hung off it.
 *   the RADIATORS asymmetric on purpose - two big panels to port, one small to
 *                 starboard - so you can tell which way up you are.
 *   the RING      a habitat torus at the aft end. Curves against all those
 *                 flats, and it TURNS, which says the place is inhabited.
 *
 * The piers then run forward out of the mouth into open space, which is the
 * thing the player asked for in the first place.
 *
 * ===========================================================================
 *  THE APRON, AND ONE DISAGREEMENT THIS FILE CANNOT FIX
 * ===========================================================================
 *
 * `YardPlan` says that past the mouth there is no ground except the piers, and
 * puts a balustrade on the threshold to stop a player walking off it. The
 * space world puts the player's spawn at (0, 0.4, -38) and the return portal
 * at z -24, both of which are outside the mouth, so the exterior has to have a
 * deck there or the arrival is a fall. That deck is in this file and the spawn
 * and the portal are in `SpaceWorld.js`, which this task does not own.
 *
 * It is recorded here rather than quietly rationalised: the apron outside the
 * mouth is an affordance of the space world, the interior does not have one,
 * and reconciling them means moving a spawn point, not a wall.
 *
 * ===========================================================================
 *  THE PROBLEM THIS FILE ALSO SOLVES: BEING FOUND
 * ===========================================================================
 *
 * At 200 km the whole structure is 0.15 degrees across - three pixels at
 * 1080p. Every window, every running light and the entire building collapse
 * into less than one pixel. So the yard carries a BEACON, and the beacon is
 * the one thing here that does not obey the scale scheme: a camera-facing glow
 * held at a constant ANGULAR size, brightening as the ship gets further out.
 * That is what a navigation strobe is - a point source whose apparent size is
 * set by the eye rather than by the lamp - and it is the only object in this
 * world exempt from `Scale.js`.
 *
 * TWO NUMBERS THAT WERE WRONG, found by measuring rather than by looking.
 * Peak luminance in an 80x80 box on the yard's screen position, against a
 * background median of 28/255:
 *
 *              2 km    10 km   40 km   120 km
 *   before      175      169      66      102
 *
 *  1. IT NEVER BLOOMED. Output peaked at 0.98 linear and the space grade's
 *     bloom threshold is 1.60 (PostFX.js). A beacon that does not bloom is a
 *     coloured pixel; one that does is a light with a halo, and the halo is
 *     what the eye finds. The multiplier is 6.0.
 *  2. THE GAIN CURVE USED THE WRONG VARIABLE. It was driven by the group's
 *     proxy scale, which is a function of the LOG of distance and is almost
 *     flat across the range the beacon exists to cover. It is a smoothstep on
 *     TRUE distance now, full by 8 km.
 *
 * ===========================================================================
 *  BATCHING, and why it is worth the indirection
 * ===========================================================================
 *
 * The yard is now about four hundred pieces. Built the obvious way that is
 * four hundred meshes and four hundred draw calls, on a structure that is on
 * screen from almost every vantage in the volume.
 *
 * So `_bake` does not make a mesh. It transforms a geometry into place, world-
 * projects its uvs (see `HullSkin.worldProjectUV`) and drops it into a
 * per-material bucket; `_flush` merges each bucket into one mesh. Four hundred
 * draws become one per material, and there are ten materials.
 *
 * The colliders are untouched by this - they were never per-mesh, they are
 * per-box in the physics world, and merging the DRAWING does not merge them.
 * That distinction is the whole reason this is safe: the thing the player
 * stands on is still box-shaped and still exactly where the box was.
 */

/**
 * Beacon angular diameter, radians. 1.05 degrees - about 13 px tall at 900p.
 *
 * It was 0.62, and 0.62 was not wrong so much as useless in combination with
 * the falloff it was paired with. A magnified crop at 40 km settled it: what
 * reached the screen was ONE amber pixel in a field of star pixels of the same
 * brightness. The profile is a gaussian now, which spends the quad instead of
 * hoarding it in the middle two percent of its area.
 *
 * The size is chosen against the BLOOM rather than against a pixel count. The
 * starfield in gfx/Sky.js is deliberately tuned to stay UNDER the 1.60
 * threshold, so a source that clears it is categorically different from every
 * star in the sky: it is the only thing out there with a halo.
 */
const BEACON_ANGULAR = (1.05 * Math.PI) / 180;

/** Apron: the strip of deck between the mouth and the piers. */
export const APRON_Z = -84;
/**
 * Half-width of the apron, and the x of its kerb.
 *
 * 88, matching the hall's outer skin, so the deck runs out from under the
 * jambs rather than stopping short of them in mid-air. It was 65, which was
 * 130 m of deck in front of a 164 m doorway - the apron was narrower than the
 * hole it served.
 *
 * Exported because `dock-launch.test.mjs` probes for the kerb here and had the
 * old 65 typed into it. A test that hard-codes a dimension of the thing it is
 * testing goes red for the right change and stays green for the wrong one, so
 * it reads this instead.
 */
export const APRON_HALF_W = HALL_OUTER_HW - 2;

/**
 * The apron's inboard edge - the sill of the mouth, plus two metres of lip.
 *
 * Exported for the same reason `APRON_HALF_W` is: `SpaceWorld` draws the apron
 * on the minimap and had `w: 130, d: 66` typed into it against a deck that is
 * 176 x 68, so a player standing legally at x = +-80 was drawn off the edge of
 * their own deck. The map reads the deck now.
 */
export const APRON_Z1 = HALL_FRONT_Z + 2;

/** Where the cross-walk runs, and how far out the piers reach. */
const CROSS_HALF_W = 112;
const PIER_HALF_W = 4.5;

/**
 * The outboard face of the mouth buttresses, in Z.
 *
 * `_buildMouth` stands them at `HALL_FRONT_Z - 3.6` and they are 7 m deep, so
 * their front face is 7.1 m out from the wall. Named here because the apron's
 * kerbs have to run up TO them - "stop short of the buttresses" was a
 * hand-picked `depth - 12` that stopped 2.9 m short of them instead, leaving
 * an open deck edge at x = +-88 with nothing on either side of it.
 */
const BUTTRESS_FRONT_Z = HALL_FRONT_Z - 3.6 - 3.5;

/** Berth pad footprint, and the rails round it. Matches `_buildPiers`. */
const PAD_HALF_W = 12;
const PAD_HALF_D = 13;

/** Top of the beacon mast, which stands on the brow over the mouth. */
const MAST_TOP_Y = 108;

/**
 * The spine, and the ring that turns round it.
 *
 * Every one of these four numbers is bounded by `DOCK_ANCHOR.radius` = 285 and
 * they were pulled in until they fitted, not chosen and hoped for. The binding
 * case is the ring's window band: it sits at radius 56 about a centre 205.7 m
 * from the yard origin, so its furthest vertex is 261.7 m out. `_flush` and
 * `_buildRing` both assert against the bound and throw rather than let the far
 * plane quietly saw the back off the station.
 */
const SPINE_Y = 62;
const SPINE_R = 34;
const RING_Z = 196;
const RING_R = 48;

/**
 * How far in front of and behind the mouth plane nothing may stand.
 *
 * The front wall is 7 m thick and centred 3 m inside the mouth plane, so 8
 * clears it with about four metres of run either side. Anything flat enough to
 * be paint or a recessed light fitting - under `DOOR_FLAT` metres proud of the
 * deck - is exempt, because a ship clears those by the height of its own
 * landing gear, and the keel line has to run out of the mouth or the whole
 * composition loses its axis.
 */
export const DOOR_CLEAR = 8;
/** Deck furniture under this height does not count as an obstruction. */
export const DOOR_FLAT = 0.4;

/** Module-level scratch. Nothing in this file allocates per frame. */
const _camPos = new THREE.Vector3();
const _beaconWorld = new THREE.Vector3();
const _m4 = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _e = new THREE.Euler();
const _v = new THREE.Vector3();
const _one = new THREE.Vector3(1, 1, 1);

export class DockExterior {
  /**
   * @param {typeof import('./Bodies.js').DOCK_ANCHOR} anchor
   * @param {{ physics: any, track: (c:any)=>any, engine?: any }} host the world
   */
  constructor(anchor, host) {
    this.anchor = anchor;
    this.host = host;
    this.group = new THREE.Group();
    this.group.name = 'space:dock';

    /** @type {THREE.Material[]} */
    this._mats = [];
    /** @type {THREE.BufferGeometry[]} */
    this._geoms = [];
    /** Per-material geometry buckets, merged by `_flush`. @type {Map<THREE.Material, THREE.BufferGeometry[]>} */
    this._batch = new Map();
    /** Emissive window quads: [x,y,z, nx,ny,nz, w,h, r,g,b]. */
    this._windows = [];

    this.skin = null;
    this.ring = null;
    this.beacon = null;
    this._beaconMat = null;
    /** Furthest drawn vertex from the yard origin. Asserted against BOUND_R. */
    this.maxRadius = 0;

    this._build();
  }

  _mat(m) {
    this._mats.push(m);
    return m;
  }

  _geo(g) {
    this._geoms.push(g);
    return g;
  }

  /* ------------------------------------------------------------------ */
  /* Baking                                                              */
  /* ------------------------------------------------------------------ */

  /**
   * Transform a geometry into place and drop it in its material's bucket.
   *
   * Returns nothing, deliberately. It used to return a mesh and there is no
   * mesh any more; handing back the shared batch geometry would invite a
   * caller to move something half the station is welded to.
   *
   * @param {THREE.BufferGeometry} geo consumed - do not reuse it afterwards
   * @param {THREE.Material} mat
   * @param {THREE.Matrix4} matrix world placement
   */
  _bake(geo, mat, matrix) {
    geo.applyMatrix4(matrix);
    /* AFTER the transform, never before: the projection is fixed to the
     * station, so two boxes meeting at a corner share a seam line instead of
     * each starting a fresh sheet of plate at the join. */
    worldProjectUV(geo);
    this._measure(geo);
    let bucket = this._batch.get(mat);
    if (!bucket) { bucket = []; this._batch.set(mat, bucket); }
    bucket.push(geo);
  }

  /**
   * Track the furthest drawn vertex from the origin.
   *
   * `Scale.js` caps the yard's proxy distance using `DOCK_ANCHOR.radius` as
   * the bounding radius, and a structure that pokes out past it has its far
   * side outside the far-plane guarantee - which looks like the back of the
   * station being sliced off in a straight line. Bodies.js belongs to another
   * agent and cannot be widened from here, so this measures instead of hoping.
   */
  _measure(geo) {
    const p = geo.attributes.position;
    for (let i = 0; i < p.count; i++) {
      const d = Math.hypot(p.getX(i), p.getY(i), p.getZ(i));
      if (d > this.maxRadius) this.maxRadius = d;
    }
  }

  /** An axis-aligned box, baked. The workhorse. */
  _box(w, h, d, x, y, z, mat, collide = false) {
    this._bake(new THREE.BoxGeometry(w, h, d), mat, _m4.makeTranslation(x, y, z));
    if (collide) {
      this.host.track(this.host.physics.addBox(x, y, z, w / 2, h / 2, d / 2));
    }
  }

  /**
   * A collider with no geometry.
   *
   * Used for exactly one thing, and the exception is argued rather than
   * assumed. This file's standing rule is "the thing that stops you is the
   * thing you can see stopping you" - `_box(..., true)` draws and collides
   * together, and every guard rail on the deck goes through it.
   *
   * The BAY MOUTH cannot. The aperture is 164 x 23.6 with `DOOR_FLAT` = 0.4 m
   * of sill clearance, and `space-yard-exterior.test.mjs` marches a grid
   * through the whole of it and fails on any drawn triangle in the way -
   * correctly, because a hull flies through there and a rail across the sill
   * is a rail a ship's gear hits. So the doorway has to stay empty of
   * geometry and still stop a walking player, and those two are only
   * compatible if the stop is not drawn.
   *
   * What it is, in the fiction, is the bay's atmosphere containment field:
   * the reason a hangar open to vacuum has air in it, and the reason you walk
   * up to the mouth rather than through it. It costs a flown ship nothing -
   * `Flight` never tests against world colliders at all (grep `physics.` in
   * `Flight.js`: no hits), so this is only ever felt by a capsule on foot.
   */
  _solid(w, h, d, x, y, z) {
    this.host.track(this.host.physics.addBox(x, y, z, w / 2, h / 2, d / 2));
  }

  /** A rotated box. Never collided: the physics world only has AABBs. */
  _boxR(w, h, d, x, y, z, rx, ry, rz, mat) {
    _q.setFromEuler(_e.set(rx, ry, rz));
    this._bake(new THREE.BoxGeometry(w, h, d), mat,
      _m4.compose(_v.set(x, y, z), _q, _one));
  }

  /**
   * A prism or cylinder lying along an axis.
   * @param {'x'|'y'|'z'} axis
   */
  _cyl(rTop, rBot, len, seg, x, y, z, axis, mat) {
    _q.setFromEuler(_e.set(axis === 'z' ? Math.PI / 2 : 0, 0, axis === 'x' ? Math.PI / 2 : 0));
    this._bake(new THREE.CylinderGeometry(rTop, rBot, len, seg, 1, false), mat,
      _m4.compose(_v.set(x, y, z), _q, _one));
  }

  /** A lit window. Collected, then emitted as one instanced mesh. */
  _win(x, y, z, nx, ny, nz, w, h, r, g, b) {
    this._windows.push([x, y, z, nx, ny, nz, w, h, r, g, b]);
  }

  /** Merge every batch into one mesh per material. Called once, at the end. */
  _flush() {
    for (const [mat, parts] of this._batch) {
      const merged = mergeGeometries(parts, false);
      for (const p of parts) p.dispose();
      if (!merged) {
        throw new Error('[space/DockExterior] mergeGeometries returned null - a batch has mismatched attributes');
      }
      merged.computeBoundingSphere();
      /* The house NaN rule. A non-finite bounding sphere makes every frustum
       * test return garbage, and a non-finite vertex reaches the bloom and
       * takes the whole frame with it. Cheap to check once at build. */
      const bs = merged.boundingSphere;
      if (!bs || !Number.isFinite(bs.radius) || !Number.isFinite(bs.center.x)) {
        throw new Error('[space/DockExterior] merged batch has a non-finite bounding sphere');
      }
      this._geo(merged);
      const mesh = new THREE.Mesh(merged, mat);
      mesh.name = 'space:dock:batch';
      mesh.castShadow = mesh.receiveShadow = false;
      this.group.add(mesh);
    }
    this._batch.clear();

    /* The same guarantee the far-limb cap is written against, checked rather
     * than assumed. Throwing here is right: a station that overhangs its own
     * bounding sphere fails silently and only at range, which is the worst
     * possible place for it to fail. */
    if (this.maxRadius > BOUND_R) {
      throw new Error(
        `[space/DockExterior] geometry reaches ${this.maxRadius.toFixed(1)} m from the yard ` +
        `origin, outside DOCK_ANCHOR.radius ${BOUND_R}. Scale.js's far-limb cap is sized ` +
        'off that radius, so the far side of the station will be cut by the far plane.'
      );
    }
  }

  /* ------------------------------------------------------------------ */
  /* Build                                                               */
  /* ------------------------------------------------------------------ */

  _build() {
    const aniso = this.host?.engine?.maxAnisotropy ?? 1;
    this.skin = buildHullSkin(aniso);
    const { map, normalMap, roughnessMap } = this.skin;

    /** A plated surface: the shared skin, tinted. One draw call each. */
    const plated = (color, roughness, metalness, extra = {}) => this._mat(
      new THREE.MeshStandardMaterial({
        color, roughness, metalness, map, normalMap, roughnessMap,
        normalScale: new THREE.Vector2(1.25, 1.25), fog: false, ...extra,
      })
    );

    const M = {
      /** The main skin. Warm-neutral rather than blue: the only key light out
       *  here is a G-type star and the ambient is already 0x1b2740. */
      hull: plated(0x7b838d, 0.70, 0.55),
      /** Plant, tankage, keel. Darker, so the shed reads against its gear. */
      module: plated(0x434a55, 0.78, 0.60),
      /** Decks and pier tops. Rougher, so they do not flare in the rim light. */
      deck: plated(0x3c4552, 0.90, 0.24),
      /**
       * The hall interior, in THREE depth bands, and the bands are the fix for
       * the flat-card fault coming back indoors.
       *
       * There are no lights in this world to put inside the hall - the point
       * budget is 12 for the whole game - so every interior surface has to
       * carry its own emission. But emission does not fall off: a 162 m hall
       * whose far wall emits exactly what its near wall emits renders as one
       * even tan rectangle with no depth in it at all, which is precisely the
       * "flat untextured slab" the outside was criticised for, moved indoors.
       * Photographed at 90 m off the mouth, the first version of this read as
       * a single card of RGB (214, 186, 132) from sill to back wall.
       *
       * Vertex colours cannot fix it - three multiplies them into
       * `diffuseColor` and leaves `totalEmissiveRadiance` alone - so the fix is
       * three materials on three z-bands, at 0.70 / 0.44 / 0.24. Two extra
       * draw calls, and the hall gets a distance again. The steps land behind
       * the interior columns, which is why the column pitch is the interior's
       * own 12 m bay pitch and not something chosen to look nice.
       *
       * `emissiveMap` is the plate albedo, so the GLOW carries the panel lines
       * too: a lit wall with seams in it, rather than a lit rectangle.
       */
      hallLit: [0.70, 0.44, 0.24].map((k) => plated(0x555b63, 0.82, 0.30, {
        emissive: new THREE.Color(0.80, 0.44, 0.17), emissiveIntensity: k, emissiveMap: map,
      })),
      /**
       * Structural metal: rails, spars, gantries, the crane, the slip frame.
       *
       * 0x6e7784, and it was 0x9aa6b4. That is roughly 0.35 in linear, and the
       * star is `sunIntensity` 3.1, so a lit face of it came out at 1.08 scene
       * -referred - over the top of the ACES shoulder and clipped. Measured off
       * the slip framing at the close starboard framing, every trim member was
       * RGB (232, 236, 240): a white cage in front of a dark station, with no
       * shading on it at all because every face had clipped to the same value.
       *
       * At 0x6e7784 the same face reads about (178, 186, 196) and the members
       * have a lit side and a shadow side again. This one material carries
       * most of the small structure on the station, so it is also most of what
       * the eye reads as "made of parts".
       */
      trim: this._mat(new THREE.MeshStandardMaterial({
        color: 0x6e7784, roughness: 0.52, metalness: 0.62, fog: false,
      })),
      /** Shadow structure: trusses, ribs, recesses. Nearly black. */
      dark: this._mat(new THREE.MeshStandardMaterial({
        color: 0x1e2229, roughness: 0.84, metalness: 0.40, fog: false,
      })),
      hazard: this._mat(new THREE.MeshStandardMaterial({
        color: 0xc9a13c, roughness: 0.74, metalness: 0.14, fog: false,
      })),
      /**
       * Radiator faces. Nearly black and fairly smooth so they read as an
       * absence in the silhouette, with a dull red emission because a radiator
       * that is not radiating is a panel.
       *
       * 0.10, and it was 0.55, by way of 0.20. Measured off the framebuffer at
       * the high three-quarter framing, the panel body read RGB (126, 84, 66)
       * at 0.55 - a rust-brown that was the brightest large mass in the frame
       * and pulled the eye clean off the lit mouth, which is the one thing the
       * composition is for. The emission is nearly all of that: the albedo is
       * 0x14 in sRGB, about 0.006 linear, so the star contributes almost
       * nothing to it and the glow contributed the rest.
       *
       * A radiator glows dull cherry. It does not glow like a warning light.
       */
      fin: this._mat(new THREE.MeshStandardMaterial({
        color: 0x0f1218, roughness: 0.52, metalness: 0.48, fog: false,
        emissive: new THREE.Color(0.26, 0.08, 0.05), emissiveIntensity: 0.10,
      })),
      /**
       * Light FITTINGS - strip lights, floods, the glow inside the well.
       * Unlit and well over 1.0 so they survive the bloom threshold. This is
       * the second-longest-range cue after the beacon itself.
       */
      lamp: this._mat(new THREE.MeshBasicMaterial({
        color: new THREE.Color(2.6, 1.55, 0.72), fog: false, toneMapped: false,
      })),
      /** Welding arc in the building slip. Blue-white, and much hotter. */
      arc: this._mat(new THREE.MeshBasicMaterial({
        color: new THREE.Color(2.2, 2.8, 4.6), fog: false, toneMapped: false,
      })),
    };
    this._M = M;

    this._buildKeel(M);
    this._buildHallWalls(M);
    this._buildHallInterior(M);
    this._buildWell(M);
    this._buildRoof(M);
    this._buildMouth(M);
    this._buildSpine(M);
    this._buildRadiators(M);
    this._buildSlip(M);
    this._buildApron(M);
    this._buildPiers(M);
    this._buildLights(M);
    /* Before the beacon and the ring: `_flush` is what enforces the bounding
     * radius, and both of those are placed relative to structure it checks. */
    this._flush();
    this._buildWindows();
    this._buildRing(M);
    this._buildBeacon();
  }

  /* ------------------------------------------------------------------ */
  /* The keel: what the hall stands on                                   */
  /* ------------------------------------------------------------------ */

  /**
   * Three stepped tiers under the assembly floor, with the frames showing.
   *
   * A flat underside is the same fault as a flat side - no scale, no shadow
   * line - and the underside is what a pilot sees on almost every approach,
   * because the mouth faces out along -Z and the interesting bodies are down
   * and to port. So the bottom of this building gets as much articulation as
   * the top.
   */
  _buildKeel(M) {
    const midZ = (HALL_FRONT_Z + HALL_BACK_Z) / 2;
    const depth = HALL_BACK_Z - HALL_FRONT_Z;

    this._box(HALL_OUTER_HW * 2 - 6, 5, depth - 2, 0, DECK_Y - 2.5, midZ, M.hull);
    this._box(HALL_KEEL_HW * 2, 5, depth - 14, 0, DECK_Y - 7.2, midZ, M.module);
    this._box(HALL_KEEL_HW * 2 - 42, 5, depth - 40, 0, DECK_Y - 11.6, midZ, M.module);

    // Longitudinal girders, so the soffit has a grain running fore-and-aft.
    for (const x of [-58, -22, 22, 58]) {
      this._box(5, 9, depth - 20, x, DECK_Y - 9, midZ, M.dark);
    }
    // Transverse frames on the interior's own 12 m bay pitch, proud of the
    // skin so they catch a highlight and throw a shadow along the belly.
    for (let z = WELL_BACK_Z; z < HALL_BACK_Z - 4; z += BAY_PITCH) {
      this._box(HALL_KEEL_HW * 2 + 6, 2.6, 2.2, 0, DECK_Y - HALL_KEEL_D + 1.2, z, M.trim);
    }
    for (let z = WELL_BACK_Z - BAY_PITCH; z > HALL_FRONT_Z + 4; z -= BAY_PITCH) {
      this._box(HALL_KEEL_HW * 2 + 6, 2.6, 2.2, 0, DECK_Y - HALL_KEEL_D + 1.2, z, M.trim);
    }
    // Docking-thruster blisters at the four corners of the keel. Small, but
    // they are the reason the eye reads the belly as a hull and not a plinth.
    for (const sx of [-1, 1]) {
      for (const sz of [-1, 1]) {
        const z = midZ + sz * (depth / 2 - 22);
        this._cyl(7, 9, 8, 8, sx * (HALL_KEEL_HW - 6), DECK_Y - 12, z, 'y', M.module);
        this._cyl(4.4, 4.4, 2.4, 8, sx * (HALL_KEEL_HW - 6), DECK_Y - 16.4, z, 'y', M.dark);
      }
    }
  }

  /* ------------------------------------------------------------------ */
  /* The hall: side walls and articulation                               */
  /* ------------------------------------------------------------------ */

  /**
   * The long walls, and the six things that stop them being a slab.
   *
   * Pilasters, a service duct, an eaves fascia, a skirt, a window gallery and
   * a set of hull-plate seams. None of them is expensive; between them they
   * turn a 162 x 29 m rectangle into something with a rhythm you can count.
   * The rhythm is the interior's 12 m bay pitch, because a building whose
   * outside pilasters land on its inside columns is a building and one whose
   * do not is a box with stripes painted on it.
   */
  _buildHallWalls(M) {
    const midZ = (HALL_FRONT_Z + HALL_BACK_Z) / 2;
    const depth = HALL_BACK_Z - HALL_FRONT_Z;
    const wallX = HALL_INNER_HW + HALL_WALL_T / 2;

    for (const s of [-1, 1]) {
      // The wall itself.
      this._box(HALL_WALL_T, HALL_TOP_Y, depth, s * wallX, HALL_TOP_Y / 2, midZ, M.hull);
      // Skirt: a wider base course, so the wall meets the keel on a shadow.
      this._box(HALL_WALL_T + 3.4, 4.2, depth, s * (wallX + 1.2), 2.1, midZ, M.module);
      // Eaves fascia, carrying the running lights.
      this._box(HALL_WALL_T + 4.4, 2.4, depth, s * (wallX + 1.6), HALL_TOP_Y - 1.2, midZ, M.trim);
      // Service duct at gantry level, with expansion loops every third bay.
      this._box(3.2, 3.0, depth - 6, s * (wallX + 3.2), HALL_GANTRY_Y + 2.2, midZ, M.trim);
      // Crane-runway corbel, outside, aligned with the runway inside.
      this._box(2.4, 1.6, depth - 4, s * (wallX + 2.6), HALL_CRANE_Y + 2.6, midZ, M.dark);
    }

    // Pilasters on the bay pitch, both directions from the roof line so they
    // land on the same chainages the frames inside do.
    const bays = [];
    for (let z = WELL_BACK_Z; z < HALL_BACK_Z - 3; z += BAY_PITCH) bays.push(z);
    for (let z = WELL_BACK_Z - BAY_PITCH; z > HALL_FRONT_Z + 3; z -= BAY_PITCH) bays.push(z);
    this._bays = bays;
    for (const s of [-1, 1]) {
      for (const z of bays) {
        this._box(4.6, HALL_TOP_Y - 4, 3.0, s * (wallX + 2.2), (HALL_TOP_Y - 4) / 2 + 3, z, M.hull);
        // A shadow reveal down each side of the pilaster. Two centimetre-thin
        // boxes buy the whole wall a set of vertical dark lines at range.
        for (const t of [-1, 1]) {
          this._box(2.2, HALL_TOP_Y - 6, 0.5, s * (wallX + 1.4), (HALL_TOP_Y - 6) / 2 + 3, z + t * 1.8, M.dark);
        }
      }
    }

    /* The gallery: a lit office storey let into the wall over the roofed half.
     * A window band is worth more than any amount of plate detail, because it
     * is the only cue in the model that says PEOPLE, and it survives to a
     * range where nothing else does. */
    for (const s of [-1, 1]) {
      this._box(2.0, 5.2, 88, s * (wallX + 2.6), 20.4, 98, M.dark);
      for (let z = 58; z <= 138; z += 4.2) {
        if (Math.abs(((z - WELL_BACK_Z) % BAY_PITCH)) < 1.6) continue;   // miss the pilasters
        this._win(s * (wallX + 3.7), 20.4, z, s, 0, 0, 2.6, 3.0, ...this._winColour(z * 7 + s * 3));
      }
    }
  }

  /**
   * Window colour, deterministic per position.
   *
   * A third of them are dark, because a station whose every window is lit is a
   * hotel. Of the lit ones most are the same sodium as the deck lighting and a
   * few are the cold blue-white of a screen-lit room, which is what makes a
   * band of windows read as many separate rooms rather than as a light strip.
   */
  _winColour(seed) {
    const r = Math.abs(Math.sin(seed * 12.9898) * 43758.5453) % 1;
    if (r < 0.30) return [0.05, 0.055, 0.07];
    if (r < 0.44) return [1.05, 1.55, 2.30];
    const w = 0.75 + (r % 0.2) * 3.0;
    return [2.5 * w, 1.62 * w, 0.80 * w];
  }

  /* ------------------------------------------------------------------ */
  /* What you see through the mouth                                      */
  /* ------------------------------------------------------------------ */

  /**
   * The hall interior: a real room, 162 m deep, lit.
   *
   * This is the fix for fault 1. The old version was one emissive plane facing
   * the wrong way; the important half of that sentence is "one plane". Even
   * facing the right way, a flat card in a doorway has no parallax, so the
   * moment the player moves off the axis it reads as a sticker. What sells an
   * opening is that the things inside it move against each other as you pass:
   * a floor that runs away from you, side walls that converge, a gantry line,
   * a crane, and a far wall at a distance you can feel.
   *
   * Everything in here is inside the shell, so it is only ever seen through
   * the mouth or down through the open well. That is a little overdraw and a
   * lot of depth, and the trade is not close.
   */
  _buildHallInterior(M) {
    const midZ = (HALL_FRONT_Z + HALL_BACK_Z) / 2;
    const depth = HALL_BACK_Z - HALL_FRONT_Z;
    const iw = HALL_INNER_HW;

    /* THE DOORWAY IS NOT PART OF THE ROOM.
     *
     * Every longitudinal fitting in here - catwalk, crane rail, duct, strip
     * light - stops `DOOR_CLEAR` metres inside the mouth plane instead of
     * running out through the hole, for the same reason the real ones do: a
     * handrail that carries on through a doorway a ship flies out of does not
     * carry on for long. It is also what lets `space-yard-exterior.test.mjs`
     * march a grid through the aperture and find nothing, which is the fourth
     * of `DockShape`'s agreement claims. */
    const runZ0 = HALL_FRONT_Z + DOOR_CLEAR + 2;
    const runZ1 = HALL_BACK_Z - 2;
    const runMid = (runZ0 + runZ1) / 2;
    const runLen = runZ1 - runZ0;

    /* Floor and inner wall faces, in three depth bands. The band edges are on
     * the interior's bay pitch so they fall behind a column. */
    const band = depth / 3;
    for (let b = 0; b < 3; b++) {
      const mat = M.hallLit[b];
      const z0 = HALL_FRONT_Z + b * band, z1 = z0 + band;
      const bz = (z0 + z1) / 2;
      this._box(iw * 2, 1.2, band, 0, MOUTH_SILL_Y - 0.6, bz, mat);
      for (const s of [-1, 1]) {
        this._box(1.2, HALL_ROOF_Y, band, s * (iw - 0.6), HALL_ROOF_Y / 2, bz, mat);
      }
    }
    // Apron wall at the far end - the thing 162 m away that gives the mouth
    // its depth. Lit, in the dimmest band, because from the pier tips it is
    // the whole back of the frame and a dark rectangle there would eat the
    // shot while a bright one would flatten it.
    this._box(iw * 2, HALL_ROOF_Y, 2.4, 0, HALL_ROOF_Y / 2, HALL_BACK_Z - 1.2, M.hallLit[2]);

    // Perimeter catwalk at gantry level, and the columns that carry it.
    for (const s of [-1, 1]) {
      this._box(3.4, 0.5, runLen, s * (iw - 2.4), HALL_GANTRY_Y, runMid, M.trim);
      this._box(0.4, 1.2, runLen, s * (iw - 4.1), HALL_GANTRY_Y + 0.9, runMid, M.dark);
      // Crane runway rails, at the height the interior publishes.
      this._box(2.6, 1.8, runLen, s * (iw - 5.2), HALL_CRANE_Y, runMid, M.trim);
      for (const z of this._bays) {
        if (z < runZ0) continue;
        this._box(2.6, HALL_ROOF_Y, 2.6, s * (iw - 1.9), HALL_ROOF_Y / 2, z, M.dark);
      }
    }

    /* Strip lighting under the catwalk, both sides, the whole length. THIS is
     * the light source the mouth reads by: the walls are emissive enough to be
     * lit, but a lit room with no visible fitting looks like fog. Over the
     * bloom threshold, so at range the mouth is a warm bar with a halo. */
    for (const s of [-1, 1]) {
      for (let z = runZ0 + 2; z < runZ1 - 2; z += 9) {
        this._box(1.4, 0.5, 5.4, s * (iw - 4.6), HALL_GANTRY_Y - 0.6, z, M.lamp);
      }
    }
    /* Floor strips under them, and they are 3.2 m wide and not the 9 they were
     * first drawn at. Nine put two bands of over-threshold white across 162 m
     * of floor, and what the mouth read as from 280 m out was a solid lit bar
     * with no floor in it - the opposite fault to the black rectangle it had
     * replaced. Measured: mean frame luminance 12.4 at nine metres wide, 11.7
     * at three, and the mouth gained a floor.
     *
     * These DO run out through the mouth - they are 0.14 m of light fitting
     * recessed into the deck, and a ship clears them by the height of its own
     * landing gear. Same for the painted keel line, which has run down the
     * middle of this world since it was a survey pad and now runs out of the
     * mouth to Berth Zero. */
    for (const s of [-1, 1]) {
      this._box(3.2, 0.14, depth - 6, s * (iw - 10), DECK_Y + 0.08, midZ + 1, M.lamp);
    }
    this._box(4.0, 0.12, depth - 4, 0, DECK_Y + 0.07, midZ, M.hazard);
  }

  /* ------------------------------------------------------------------ */
  /* The launch well: 70 m of hall with no lid                           */
  /* ------------------------------------------------------------------ */

  /**
   * `ROOF_CUT_Z` made visible.
   *
   * The interior's own note says that north of the cut "portal frames,
   * rafters, purlins and the crane runway all carry on, and between them there
   * is starfield". If the exterior roofs that over, the interior is lying
   * about its own sky. So it is open, and what is left is six portal frames on
   * the bay pitch with five purlins across them.
   *
   * It is also the best thing in the model. An open slip you can see down into
   * - lit floor, gantries, a travelling crane inching along - is what a
   * shipyard looks like from above, and there is no other way to show the
   * inside of a building from outside it.
   */
  _buildWell(M) {
    const wallX = HALL_INNER_HW + HALL_WALL_T / 2;
    const midZ = (HALL_FRONT_Z + WELL_BACK_Z) / 2;
    const span = WELL_BACK_Z - HALL_FRONT_Z;

    for (const z of WELL_FRAME_Z) {
      // Portal frame: a deep girder across the whole width, with haunches.
      this._box(HALL_OUTER_HW * 2 + 2, 3.2, 2.6, 0, HALL_ROOF_Y + 1.6, z, M.hull);
      for (const s of [-1, 1]) {
        this._boxR(9, 2.2, 2.4, s * (HALL_INNER_HW - 4), HALL_ROOF_Y - 3.4, z,
          0, 0, s * 0.72, M.trim);
      }
      // Frame webs, so the girder is a truss rather than a plank.
      for (let x = -78; x <= 78; x += 13) {
        this._boxR(1.0, 3.0, 1.0, x, HALL_ROOF_Y - 0.6, z, 0, 0, (x / 13) % 2 ? 0.6 : -0.6, M.dark);
      }
    }
    // Purlins fore-and-aft. Five, and no more: this has to read as open.
    for (const x of [-66, -33, 0, 33, 66]) {
      this._box(1.8, 1.4, span - 2, x, HALL_ROOF_Y + 3.6, midZ, M.trim);
    }

    /* THE TRAVELLING CRANE. It sits in the open well where it can be seen, at
     * `CRANE_Y`, on the runway the interior already has. One bridge, two end
     * trucks, a trolley and a hook block hanging on a fall. */
    const craneZ = HALL_FRONT_Z + span * 0.56;
    this._box(HALL_INNER_HW * 2 - 8, 3.4, 4.0, 0, HALL_CRANE_Y + 2.6, craneZ, M.trim);
    this._box(HALL_INNER_HW * 2 - 8, 1.0, 1.0, 0, HALL_CRANE_Y + 4.6, craneZ, M.dark);
    for (const s of [-1, 1]) {
      this._box(7.4, 4.4, 7.0, s * (HALL_INNER_HW - 5.4), HALL_CRANE_Y + 1.6, craneZ, M.module);
    }
    this._box(8.0, 5.0, 6.4, -26, HALL_CRANE_Y - 0.4, craneZ, M.module);
    this._box(0.5, 8.6, 0.5, -26, HALL_CRANE_Y - 7.2, craneZ, M.dark);
    this._box(4.0, 2.2, 3.0, -26, HALL_CRANE_Y - 12.4, craneZ, M.trim);
    this._box(1.6, 0.5, 1.6, -26, HALL_CRANE_Y + 2.2, craneZ, M.lamp);

    /* Floodlight bars on the well's inner faces, aimed down. Unlit geometry,
     * so what the player sees is the fitting; the pool of light under it is
     * the emissive floor. That is a cheat and it is the right one - the
     * alternative is spot lights, and `RIG_BUDGET.point` is 12 for the whole
     * game. */
    for (const s of [-1, 1]) {
      for (let z = HALL_FRONT_Z + DOOR_CLEAR + 2; z < WELL_BACK_Z; z += 14) {
        this._box(2.6, 1.0, 2.6, s * (HALL_INNER_HW - 3), HALL_ROOF_Y - 2.6, z, M.lamp);
      }
    }
    // Eaves capping over the well, tying the frames to the wall heads.
    for (const s of [-1, 1]) {
      this._box(HALL_WALL_T + 5, 2.0, span, s * (wallX + 1.4), HALL_TOP_Y + 0.6, midZ, M.hull);
    }
  }

  /* ------------------------------------------------------------------ */
  /* The roofed half                                                     */
  /* ------------------------------------------------------------------ */

  _buildRoof(M) {
    const midZ = (WELL_BACK_Z + HALL_BACK_Z) / 2;
    const span = HALL_BACK_Z - WELL_BACK_Z;

    this._box(HALL_OUTER_HW * 2, HALL_ROOF_T, span, 0, HALL_ROOF_Y + HALL_ROOF_T / 2, midZ, M.hull);
    // Ribs on the bay pitch, proud of the plate.
    for (let z = WELL_BACK_Z; z <= HALL_BACK_Z - 2; z += BAY_PITCH) {
      this._box(HALL_OUTER_HW * 2 + 2, 1.8, 2.4, 0, HALL_TOP_Y + 0.9, z, M.trim);
    }
    // Roof walkways with a kicking rail, port and starboard.
    for (const s of [-1, 1]) {
      this._box(3.0, 0.5, span - 6, s * 62, HALL_TOP_Y + 0.3, midZ, M.trim);
      this._box(0.35, 1.1, span - 6, s * 63.4, HALL_TOP_Y + 1.1, midZ, M.dark);
    }

    /* A raised monitor down the spine of the roof - the clerestory over the
     * assembly floor. It is the one thing that stops the roof being a lid, and
     * it carries a second window band that reads from directly above, which is
     * the vantage the open well already rewards. */
    this._box(42, 6.0, span - 16, 0, HALL_TOP_Y + 3.0, midZ, M.module);
    this._box(48, 1.6, span - 12, 0, HALL_TOP_Y + 6.4, midZ, M.hull);
    for (const s of [-1, 1]) {
      for (let z = WELL_BACK_Z + 12; z <= HALL_BACK_Z - 12; z += 4.6) {
        this._win(s * 21.3, HALL_TOP_Y + 3.2, z, s, 0, 0, 3.0, 3.4, ...this._winColour(z * 3.1 + s));
      }
    }

    /* Roof plant. Deliberately irregular - a machine deck is not laid out on a
     * grid - but deterministic, so a screenshot taken to justify a number can
     * be taken again. */
    const plant = [
      [-52, 16, 9, 66], [-30, 9, 7, 84], [-64, 11, 6, 112], [-40, 13, 10, 130],
      [46, 14, 8, 70], [64, 10, 6, 96], [38, 18, 11, 118], [58, 9, 7, 136],
    ];
    for (const [x, w, h, z] of plant) {
      this._box(w, h, w * 0.8, x, HALL_TOP_Y + h / 2, z, M.module);
      this._box(w + 1.6, 1.2, w * 0.8 + 1.6, x, HALL_TOP_Y + h, z, M.trim);
      this._box(1.0, 4.0, 1.0, x + w * 0.3, HALL_TOP_Y + h + 2.4, z, M.dark);
    }
    // Heat-exchange grilles between the plant blocks.
    for (let z = WELL_BACK_Z + 16; z < HALL_BACK_Z - 10; z += 18) {
      for (const s of [-1, 1]) {
        this._box(18, 1.4, 7, s * 76, HALL_TOP_Y + 0.7, z, M.dark);
      }
    }
  }

  /* ------------------------------------------------------------------ */
  /* The mouth                                                           */
  /* ------------------------------------------------------------------ */

  /**
   * The hole, and the wall it is a hole in.
   *
   * 164 x 23.6 with its sill on the deck, which is `MOUTH_HW` and `MOUTH_Y1`
   * from the interior's own plan. That leaves 4 m of jamb either side and 5.4
   * of lintel, which is the whole front wall: this building is very nearly all
   * doorway, and saying so is what makes it read as a hangar rather than as a
   * block with a window.
   *
   * Everything here is authored OUTSIDE the aperture prism. A ship flies
   * through this, and `space-yard-exterior.test.mjs` marches a grid across the
   * opening and through the wall to prove nothing is parked in it.
   */
  _buildMouth(M) {
    const jambW = HALL_OUTER_HW - MOUTH_HALF_W;          // 8
    const jambX = (HALL_OUTER_HW + MOUTH_HALF_W) / 2;    // 86
    const wallT = 7;
    const wallZ = HALL_FRONT_Z + wallT / 2 - 0.5;
    const lintelH = HALL_TOP_Y - MOUTH_HEAD_Y;

    for (const s of [-1, 1]) {
      /* Collided, all three. They stand ON the apron at x = ±86 and ±87.4,
       * which is where the apron's own kerbs stop ("short of the buttresses"),
       * and until they were solid the gap between kerb and jamb was a 12 m
       * run of open deck edge - `.probe/fix/reach.mjs` found the player could
       * walk off at x = ±88 for every z from -28 to -16. The wall you can see
       * is now the wall that stops you, which is the arrangement the kerbs
       * were written to stop short FOR. */
      this._box(jambW, HALL_TOP_Y, wallT, s * jambX, HALL_TOP_Y / 2, wallZ, M.hull, true);
      // Reveal: the depth of the opening, in shadow, set back off the jamb.
      this._box(1.4, MOUTH_HEAD_Y, wallT + 1, s * (MOUTH_HALF_W + 0.9), MOUTH_HEAD_Y / 2, wallZ, M.dark, true);
      // Buttress either side of the doorway, outside, running to the deck.
      this._box(5.0, HALL_TOP_Y - 2, 7.0, s * (jambX + 1.4), (HALL_TOP_Y - 2) / 2, HALL_FRONT_Z - 3.6, M.module, true);
    }

    /* The containment field across the aperture. See `_solid` for why this one
     * guard is the only thing in the file that stops you without being drawn.
     *
     * Sits on the mouth plane and is 4 m tall - over the capsule, under the
     * 0.4 m of sill clearance a hull needs at the bottom of a 23.6 m opening,
     * and irrelevant to a hull in any case. Without it the apron's inner edge
     * at z = -16 was 176 m of open drop: `UnstuckSystem` does recover a player
     * who falls (6 s of `FALL_TIME`, then the recovery ladder), so this was
     * never unrecoverable - but six seconds of falling through a floor you can
     * see is not a recovery, it is a bug with a cleanup routine. */
    this._solid(MOUTH_HALF_W * 2, 4, 1.2, 0, DECK_Y + 2, HALL_FRONT_Z + 0.6);
    this._box(HALL_OUTER_HW * 2, lintelH, wallT, 0, MOUTH_HEAD_Y + lintelH / 2, wallZ, M.hull);
    this._box(MOUTH_HALF_W * 2 + 3, 1.4, wallT + 1, 0, MOUTH_HEAD_Y + 0.7, wallZ, M.dark);

    /* The brow: a 6 m overhang over the whole front, with the beacon mast on
     * it. It does two jobs - it gives the front elevation a top edge that is
     * not the same rectangle as the wall, and it is the thing the eye lands on
     * when the station is a hundred pixels wide. */
    this._box(HALL_OUTER_HW * 2 + 14, 3.4, 13, 0, HALL_TOP_Y + 1.7, HALL_FRONT_Z - 4, M.hull);
    this._box(HALL_OUTER_HW * 2 + 16, 1.6, 3.0, 0, HALL_TOP_Y + 3.8, HALL_FRONT_Z - 9.5, M.trim);
    /* Raking struts under the brow. They are up at 24.8-32.2 m rather than
     * running down the wall face, which is not composition: a strut on the
     * wall face at x 74 hangs 6 m into an aperture that is 82 m half-wide, and
     * a ship flies through that. Above the lintel it is out of the way. */
    for (const s of [-1, 1]) {
      this._boxR(2.6, 8, 2.6, s * 74, HALL_TOP_Y - 0.5, HALL_FRONT_Z - 5, 0.78, 0, 0, M.trim);
      this._boxR(2.6, 8, 2.6, s * 30, HALL_TOP_Y - 0.5, HALL_FRONT_Z - 5, 0.78, 0, 0, M.trim);
    }

    /* Hazard chevrons round the opening, and the scorch that goes with them.
     * A doorway a ship goes through gets marked and it gets dirty; the two
     * together are worth more than either, because the clean stripe is what
     * makes the dirt read as dirt. */
    this._box(MOUTH_HALF_W * 2 + 10, 1.9, 0.6, 0, MOUTH_HEAD_Y + 2.2, HALL_FRONT_Z - 0.8, M.hazard);
    /* The sill stripe lies FLAT on the deck rather than standing up on the
     * front wall, and that is the fourth agreement claim rather than taste: a
     * 1.9 m band across the bottom of the aperture is 1.9 m of hull in the
     * doorway a ship flies through. Paint on the deck is not. */
    this._box(MOUTH_HALF_W * 2 + 10, 0.2, 2.6, 0, DECK_Y + 0.1, HALL_FRONT_Z - 1.6, M.hazard);
    for (const s of [-1, 1]) {
      this._box(1.9, MOUTH_HEAD_Y + 4, 0.6, s * (MOUTH_HALF_W + 2.6), MOUTH_HEAD_Y / 2 + 1, HALL_FRONT_Z - 0.8, M.hazard);
      this._box(3.0, 7.0, 0.5, s * (MOUTH_HALF_W + 6), MOUTH_HEAD_Y - 3, HALL_FRONT_Z - 0.9, M.dark);
    }
    // Approach numbers: four dark panels across the lintel, the sort of thing
    // a stencil goes on. Silhouette only at this range, and that is enough.
    for (let i = 0; i < 4; i++) {
      this._box(9, 3.0, 0.5, -46 + i * 31, MOUTH_HEAD_Y + lintelH / 2 + 0.4, HALL_FRONT_Z - 0.9, M.dark);
    }

    /* TRAFFIC CONTROL, on the brow, off to starboard of the mast.
     *
     * The front elevation is 180 m wide and 164 of that is doorway, so apart
     * from the mouth there is nothing on it - and the mouth is the one thing
     * the eye already has. Measured at the 280 m bow framing, everything above
     * the lintel read under 20/255: the building had a lit hole and no face.
     *
     * A glazed cab is what a yard would actually put there, it is high on the
     * elevation where it is not confused with the mouth, and being GLAZED it
     * carries light of its own on a face the star never reaches. It is off
     * centre because the beacon mast is on the centreline and two features
     * stacked on one axis read as one feature. */
    const cabZ = HALL_FRONT_Z - 7.5;
    this._box(16, 8.4, 11, 44, HALL_TOP_Y + 7.6, cabZ, M.module);
    this._box(18, 1.6, 13, 44, HALL_TOP_Y + 12.4, cabZ, M.hull);
    this._box(5.0, 8.0, 5.0, 44, HALL_TOP_Y + 3.6, cabZ + 1, M.dark);
    for (let i = -2; i <= 2; i++) {
      this._win(44 + i * 3.1, HALL_TOP_Y + 8.2, cabZ - 5.6, 0, 0, -1, 2.7, 4.4,
        ...this._winColour(i * 31 + 7));
    }
    for (const s of [-1, 1]) {
      this._win(44 + s * 8.1, HALL_TOP_Y + 8.2, cabZ, s, 0, 0, 5.4, 4.4, 2.3, 1.5, 0.78);
    }
    this._box(1.2, 0.6, 1.2, 44, HALL_TOP_Y + 13.4, cabZ, M.lamp);

    // Sill: a lip and a strip of light, so the floor of the hole is visible
    // edge-on from the side as well as head-on.
    this._box(MOUTH_HALF_W * 2, 1.1, 5.0, 0, DECK_Y - 0.55, HALL_FRONT_Z - 1.2, M.trim);
    this._box(MOUTH_HALF_W * 2 - 8, 0.2, 1.2, 0, DECK_Y + 0.06, HALL_FRONT_Z - 2.6, M.lamp);
  }

  /* ------------------------------------------------------------------ */
  /* The spine and its plant                                             */
  /* ------------------------------------------------------------------ */

  /**
   * The service trunk, rising out of the back of the hall and running aft.
   *
   * An octagonal prism, flat-shaded, because eight facets catch the star at
   * eight different angles as you orbit it and that is what stops a long grey
   * body reading as a tube. It starts INSIDE the roofed half - it grows out of
   * the building rather than being parked behind it - and everything hung off
   * it is on the same bay pitch as the hall, so the whole station has one
   * rhythm.
   */
  _buildSpine(M) {
    const y = SPINE_Y, r = SPINE_R, z0 = 112, z1 = 238;
    const midZ = (z0 + z1) / 2;

    this._cyl(r, r, z1 - z0, 8, 0, y, midZ, 'z', M.hull);
    for (let z = z0 + 14; z < z1; z += 26) {
      this._cyl(r + 1.8, r + 1.8, 3.0, 8, 0, y, z, 'z', M.dark);
    }
    // Where it comes out of the roof: a collar, and two struts taking the
    // cantilever back down to the hall's rear wall.
    this._cyl(r + 4, r + 6, 6, 8, 0, y, 128, 'z', M.module);
    for (const s of [-1, 1]) {
      this._boxR(3.4, 44, 3.4, s * 26, 44, 156, 0.62, 0, 0, M.trim);
    }

    // Machinery hung along the top, on the bay pitch.
    for (let i = 0; i < 5; i++) {
      const z = 126 + i * 24;
      this._box(26 - i * 2, 11, 15, 0, y + r + 4, z, M.module);
      this._box(30 - i * 2, 1.6, 17, 0, y + r + 9.8, z, M.trim);
      for (const s of [-1, 1]) this._win(s * 13.2, y + r + 5, z, s, 0, 0, 2.4, 2.6, ...this._winColour(z + i));
    }

    /* Tankage. Four of them, in two pairs, and they are the single clearest
     * "this is an industrial installation" shape in the vocabulary - a
     * pressure vessel with domed ends reads as one from any angle and at any
     * range, which very little else does.
     *
     * They sit FORWARD of the habitat ring rather than beside it: the ring
     * encircles the spine at z 196 with an inner radius of 41, and a 12.5 m
     * tank at x 50 sweeps straight through that. Twenty metres of clearance
     * either side of the ring plane is what keeps them apart. */
    for (const s of [-1, 1]) {
      for (const dy of [-16, 16]) {
        const x = s * 50, ty = y + dy, tz = 146;
        this._cyl(12.5, 12.5, 44, 12, x, ty, tz, 'z', M.module);
        this._cyl(9, 12.5, 6, 12, x, ty, tz - 25, 'z', M.trim);
        this._cyl(12.5, 9, 6, 12, x, ty, tz + 25, 'z', M.trim);
        // Saddle straps and the pipe run back to the spine.
        for (const sz of [-15, 0, 15]) {
          this._cyl(13.4, 13.4, 1.6, 12, x, ty, tz + sz, 'z', M.dark);
        }
        for (const sz of [-16, 16]) {
          this._box(Math.abs(x) - r + 6, 2.2, 2.2, s * (r + (Math.abs(x) - r) / 2 - 3), ty, tz + sz, M.trim);
        }
      }
    }

    /* The bearing the habitat ring turns on. Static - it belongs to the spine,
     * not to the ring - which is why the ring carries no spokes to the hull: a
     * strut between a turning ring and a fixed trunk is a strut that shears. */
    this._cyl(r + 3, r + 3, 15, 12, 0, y, RING_Z, 'z', M.module);
    this._cyl(r + 4.6, r + 4.6, 2.6, 12, 0, y, RING_Z - 8, 'z', M.dark);
    this._cyl(r + 4.6, r + 4.6, 2.6, 12, 0, y, RING_Z + 8, 'z', M.dark);

    // The reactor drum at the aft end, and its shield ring.
    this._cyl(24, 24, 22, 12, 0, y, 224, 'z', M.module);
    this._cyl(29, 29, 3.4, 12, 0, y, 218, 'z', M.dark);
    this._cyl(29, 29, 3.4, 12, 0, y, 230, 'z', M.dark);
    for (let i = 0; i < 8; i++) {
      const a = (i / 8) * Math.PI * 2;
      this._box(2.0, 0.6, 2.0, Math.cos(a) * 26, y + Math.sin(a) * 26, 224, M.lamp);
    }

    // Masts and the dish. A whip aerial is two boxes and it is what separates
    // "station" from "cargo container" in a hundred-pixel silhouette.
    for (const [mx, mz, h] of [[-20, 132, 40], [22, 212, 30]]) {
      this._box(1.6, h, 1.6, mx, y + r + h / 2, mz, M.trim);
      this._box(5.4, 1.2, 1.2, mx, y + r + h - 4, mz, M.dark);
      this._box(1.2, 1.2, 1.2, mx, y + r + h + 1, mz, M.lamp);
    }
    this._cyl(15, 3, 8, 14, 40, y + 26, 150, 'y', M.trim);
    this._box(1.0, 9, 1.0, 40, y + 34, 150, M.dark);
    this._box(2.4, 2.4, 2.4, 40, y + 39, 150, M.module);
    this._box(3.0, 12, 3.0, 40, y + 20, 150, M.module);
  }

  /* ------------------------------------------------------------------ */
  /* Radiators                                                           */
  /* ------------------------------------------------------------------ */

  /**
   * Asymmetric on purpose: two big panels to port, one small to starboard.
   *
   * A symmetric station has no up and no handedness, so at a glance you cannot
   * tell whether you are looking at it from above or below, or which way round
   * you are approaching. One unequal pair fixes that, and it is free.
   */
  _buildRadiators(M) {
    const panel = (x, y, z, w, h, rotZ, mat) => {
      this._boxR(2.4, h, w, x, y, z, 0, 0, rotZ, mat);
      // Ribs across the face, so it is a radiator and not a sail.
      for (let i = -2; i <= 2; i++) {
        this._boxR(3.0, 1.4, w - 4, x, y + i * (h / 5.4), z, 0, 0, rotZ, M.dark);
      }
      // Header pipes top and bottom, and a hot leading edge.
      this._boxR(3.4, 2.6, w, x, y + h / 2 - 1, z, 0, 0, rotZ, M.trim);
      this._boxR(3.4, 2.6, w, x, y - h / 2 + 1, z, 0, 0, rotZ, M.trim);
    };

    /* Port pair, canted apart; starboard single. The positions are bounded by
     * `DOCK_ANCHOR.radius`: the aft port panel's far top corner is the closest
     * anything gets to the sphere at 261 m, and it was pulled forward from
     * z 214 to reach that. `_flush` throws if any of this creeps back out. */
    panel(-116, 58, 148, 104, 76, 0.34, M.fin);
    panel(-100, 30, 200, 62, 54, -0.28, M.fin);
    panel(108, 62, 186, 70, 58, -0.38, M.fin);

    // Booms out to them, from the spine bands.
    for (const [x0, x1, y, z] of [[-40, -104, 58, 148], [-38, -92, 34, 200], [40, 96, 62, 186]]) {
      const len = Math.abs(x1 - x0);
      this._box(len, 3.2, 3.2, (x0 + x1) / 2, y, z, M.trim);
      this._box(len * 0.8, 1.4, 1.4, (x0 + x1) / 2, y + 3.4, z, M.dark);
      this._box(len * 0.8, 1.4, 1.4, (x0 + x1) / 2, y - 3.4, z, M.dark);
    }
  }

  /* ------------------------------------------------------------------ */
  /* The building slip                                                   */
  /* ------------------------------------------------------------------ */

  /**
   * A ship under construction, to starboard, in an open frame.
   *
   * This is the story of the place, and it is the one piece of the model that
   * cannot be mistaken for anything else: ribs on a keel with a third of the
   * plating on is a hull being built and nothing else looks like it.
   *
   * WHY IT IS OUT HERE AND NOT IN THE WELL. The obvious place for a hull under
   * construction is the open launch well, and it is the wrong place. The
   * interior publishes what is on the assembly floor between chainage -104 and
   * -34 - a service trench, a spares pile under the crane cab, painted keel
   * line, and no cradle - so a hull in the well is the exterior contradicting
   * the interior about the same eighty metres of floor. Outboard of the
   * starboard wall the interior says nothing at all, so a slip there costs no
   * agreement and gains the same picture.
   *
   * It also fixes the plan silhouette. Hall, spine and ring are all on the
   * centreline; a mass a hundred metres off it to starboard is what turns the
   * plan from a shape into a yard.
   */
  _buildSlip(M) {
    const x0 = 108, x1 = 172, cx = (x0 + x1) / 2, z0 = 8, z1 = 104;
    const cz = (z0 + z1) / 2, len = z1 - z0;

    // Trusses tying the slip back to the hall wall.
    for (const z of [16, 56, 96]) {
      this._box(x0 - HALL_OUTER_HW, 3.4, 3.4, (HALL_OUTER_HW + x0) / 2, 8, z, M.trim);
      this._box(x0 - HALL_OUTER_HW, 3.4, 3.4, (HALL_OUTER_HW + x0) / 2, 30, z, M.trim);
      this._boxR(3.0, 24, 2.4, (HALL_OUTER_HW + x0) / 2, 19, z, 0, 0, 0.72, M.dark);
    }
    // Slip deck and its two keel beams.
    this._box(x1 - x0 + 10, 2.4, len + 10, cx, -1.2, cz, M.deck);
    for (const x of [x0 + 6, x1 - 6]) {
      this._box(4.4, 4.4, len, x, 2.4, cz, M.dark);
    }

    /* The frame: seven bents on a 16 m pitch, tied fore-and-aft at two levels.
     * Sixteen and not twelve, because this is a fabrication frame rather than
     * part of the building, and a frame that shared the hall's pitch would
     * read as more building. */
    const bents = [];
    for (let z = z0; z <= z1 + 0.1; z += 16) bents.push(z);
    for (const z of bents) {
      for (const x of [x0, x1]) this._box(2.4, 42, 2.4, x, 21, z, M.trim);
      this._box(x1 - x0 + 2.4, 2.4, 2.4, cx, 42, z, M.trim);
      this._boxR(2.4, 16, 1.8, x0 + 7, 36, z, 0, 0, -0.78, M.dark);
      this._boxR(2.4, 16, 1.8, x1 - 7, 36, z, 0, 0, 0.78, M.dark);
    }
    for (const x of [x0, x1]) {
      for (const y of [14, 30, 42]) this._box(1.9, 1.9, len, x, y, cz, M.trim);
    }
    // Cross bracing in the two end bays, so the frame reads as braced rather
    // than as a grid of posts.
    for (const z of [bents[0] + 8, bents[bents.length - 1] - 8]) {
      for (const x of [x0, x1]) {
        this._boxR(1.6, 34, 1.6, x, 24, z, 0.44, 0, 0, M.dark);
        this._boxR(1.6, 34, 1.6, x, 24, z, -0.44, 0, 0, M.dark);
      }
    }
    // Two work platforms up the port side of the slip, and their stair towers.
    for (const y of [14, 30]) {
      this._box(7, 0.5, len - 12, x0 + 5, y, cz, M.trim);
      this._box(0.4, 1.2, len - 12, x0 + 8.4, y + 0.85, cz, M.dark);
    }
    this._box(6, 42, 6, x0 + 2, 21, z1 + 4, M.dark);

    /* The hull. A keel, eleven frames rising off it, and plating welded on
     * from the stern forward - which is the order a hull actually goes
     * together, and it is why the plated end is the aft end. */
    const hz0 = z0 + 8, hz1 = z1 - 6, hcz = (hz0 + hz1) / 2;
    const R = 15.5, hy = 19;
    this._box(5.4, 4.4, hz1 - hz0, cx, hy - R + 1, hcz, M.dark);
    for (let i = 0; i <= 10; i++) {
      const z = hz0 + ((hz1 - hz0) * i) / 10;
      // Taper toward the bow, which is the +Z end here.
      const rr = R * (1 - 0.34 * Math.pow(Math.max(0, (z - hz0) / (hz1 - hz0) - 0.45) / 0.55, 2));
      const g = new THREE.TorusGeometry(rr, 0.85, 5, 14, Math.PI);
      this._bake(g, M.trim, _m4.compose(_v.set(cx, hy - rr + 1, z),
        _q.setFromEuler(_e.set(0, 0, 0)), _one));
    }
    /* Plating: a faceted half-shell welded on from the stern forward, in two
     * strakes - a finished one and a part-laid one.
     *
     * The plate is 7.4 m WIDE tangentially and 1.2 m thick radially, and the
     * first cut of this had those two the other way round: `_boxR(1.2, 7.4,
     * ...)` under a rotation of `a + PI/2` puts the 7.4 m dimension along the
     * radius, so every "plate" was a 7.4 m spike pointing at the keel and
     * 1.2 m of skin showing. On screen the hull had ribs and no plating at all
     * and it took a close pass to see why. */
    const strake = (frac, span, mat, inset) => {
      for (let k = 0; k < 9; k++) {
        const a = Math.PI * (0.05 + (k / 8) * 0.90);
        this._boxR(7.4, 1.2, (hz1 - hz0) * span,
          cx + Math.cos(a) * (R - inset), hy - R + 1 + Math.sin(a) * (R - inset),
          hz0 + (hz1 - hz0) * frac, 0, 0, a + Math.PI / 2, mat);
      }
    };
    strake(0.17, 0.34, M.hull, 1.0);
    strake(0.44, 0.20, M.module, 1.2);
    // Two plates tacked on out of sequence further forward, which is what a
    // yard actually looks like: work does not proceed as a tidy front.
    for (const k of [2, 6]) {
      const a = Math.PI * (0.05 + (k / 8) * 0.90);
      this._boxR(7.4, 1.2, (hz1 - hz0) * 0.1,
        cx + Math.cos(a) * (R - 1.0), hy - R + 1 + Math.sin(a) * (R - 1.0),
        hz0 + (hz1 - hz0) * 0.62, 0, 0, a + Math.PI / 2, M.hull);
    }
    // Engine bells at the stern, fitted early because they are what the frame
    // was sized around.
    for (const s of [-1, 1]) {
      this._cyl(4.6, 2.6, 7, 10, cx + s * 6, hy - 4, hz0 - 3, 'z', M.dark);
    }

    /* Work lighting, and two welding arcs. The arcs are the only blue-white
     * thing on the whole station, which is exactly why they read from a
     * kilometre out: everything else here is sodium. */
    for (const z of bents) {
      this._box(1.8, 0.6, 1.8, x0 + 1.6, 40, z, M.lamp);
      this._box(1.8, 0.6, 1.8, x1 - 1.6, 40, z, M.lamp);
    }
    for (const [ax, ay, az] of [[cx - 12, hy + 6, hz0 + 24], [cx + 11, hy - 2, hz0 + 40]]) {
      this._box(1.5, 1.5, 1.5, ax, ay, az, M.arc);
    }
    // A stack of plate and two spares crates on the slip deck: the yard has
    // material lying about, because a yard that does not is a museum.
    this._box(15, 3.4, 22, x0 + 12, 1.7, z0 + 6, M.module);
    this._box(8, 6, 8, x1 - 10, 3, z1 - 8, M.module);
    this._box(6, 5, 6, x1 - 10, 3, z1 - 18, M.dark);
  }

  /* ------------------------------------------------------------------ */
  /* Apron, cross-walk and piers                                         */
  /* ------------------------------------------------------------------ */

  _buildApron(M) {
    // The deck immediately outside the mouth. Collided: this is where the
    // player arrives, and where the return portal stands. See the header note
    // about the one disagreement with the interior that this file cannot fix.
    const z0 = APRON_Z, z1 = APRON_Z1;
    const depth = z1 - z0;
    this._box(APRON_HALF_W * 2, 1.6, depth, 0, DECK_Y - 0.8, (z0 + z1) / 2, M.deck, true);

    /* Kerbs. Drawn and collided at the same height, so the thing that stops
     * you is the thing you can see stopping you.
     *
     * They run from the cross-walk seam UP TO the buttress and stop there,
     * because the buttress is now solid and takes over as the guard. The
     * previous `depth - 12` stopped 2.9 m short of it, which is 2.9 m of
     * unguarded deck edge on each side of a doorway - small, and exactly the
     * kind of gap a player finds while walking round their own ship. */
    const kerbZ1 = BUTTRESS_FRONT_Z;
    for (const s of [-1, 1]) {
      this._box(1.2, 1.15, kerbZ1 - z0, s * APRON_HALF_W, DECK_Y + 0.575, (z0 + kerbZ1) / 2, M.trim, true);
    }
    // Deck articulation: bay joints across the apron on the hall's pitch.
    for (let z = z0 + 8; z < z1 - 4; z += BAY_PITCH) {
      this._box(APRON_HALF_W * 2 - 4, 0.2, 1.0, 0, DECK_Y + 0.1, z, M.dark);
    }
    // Structural depth under it - the apron is a deck, not a sheet of paper.
    this._box(APRON_HALF_W * 2 - 8, 4.4, depth - 6, 0, DECK_Y - 3.8, (z0 + z1) / 2, M.module);
    for (const x of [-56, 0, 56]) {
      this._box(5, 8, depth - 10, x, DECK_Y - 6, (z0 + z1) / 2, M.dark);
    }

    // Cross-walk the piers hang off.
    this._box(CROSS_HALF_W * 2, 1.6, 14, 0, DECK_Y - 0.8, APRON_Z - 7, M.deck, true);
    this._buildCrossWalkKerbs(M);
    this._box(CROSS_HALF_W * 2 - 6, 3.4, 8, 0, DECK_Y - 3.2, APRON_Z - 7, M.module);
  }

  /**
   * THE CROSS-WALK'S GUARD RAILS, ON THE EDGES THAT ARE ACTUALLY DROPS.
   *
   * ── THE DEFECT ─────────────────────────────────────────────────────────
   * These two rails used to be laid across the cross-walk's Z ENDS - one full
   * 224 m rail at z −84 and another at z −98 - which are not edges at all.
   * They are the two JUNCTIONS: z −84 is the seam with the apron the player
   * spawns on, and z −98 is where all four piers attach. The cross-walk's real
   * fall edges, x = ±112, got no rail.
   *
   * So the yard's headline feature - four berths on 150 m piers - was walled
   * off from the only place a player stands. Flood-filled over the real
   * colliders on a 0.5 m lattice from the spawn at (0, 0.4, −38):
   *
   *   rule                          rise    cross-walk   the four berths
   *   walk (stepHeight 0.45)        0.45    unreachable  unreachable
   *   walk + jump (apex 0.93)       0.93    unreachable  unreachable
   *   walk + jump + mantle          2.40    reached      reached
   *
   * The rail is 1.15 m. Jump apex is 6.4²/(2·22) = 0.93 m. Only `Climb.js`'s
   * mantle (`MIN_RISE_GROUND` 1.0 ≤ 1.15 ≤ `MAX_RISE` 2.4) cleared it, and
   * nothing in the game teaches that verb. Content BUILT, never REACHED - the
   * signature defect, this time with a handrail across the door.
   *
   * `space-yard-exterior.test.mjs` asserted `host.boxes.length >= 4 * 4` and
   * called it "a player standing on a pier is standing on something", which
   * proves a pier holds you up and never that you can get onto it. It is a
   * flood fill now.
   *
   * ── WHAT IS GUARDED, AND WHY IT IS FIVE PIECES AND NOT ONE ─────────────
   * Every rail below stands on an edge with nothing beyond it:
   *
   *   x = ±112              the cross-walk's outboard ends.
   *   z = −84, |x| > 88     the two WINGS. The cross-walk is 224 m across and
   *                         the apron behind it is only 176, so stepping
   *                         "back" from x = ±100 lands on nothing. The apron's
   *                         own kerbs at x = ±88 do not cover this because
   *                         they start at the seam and run the other way.
   *   z = −98, between the piers
   *                         four 9 m piers in a 224 m front leaves five gaps,
   *                         and the gaps are void. Derived from the published
   *                         berth positions rather than written out, so a
   *                         fifth berth moves its own gap.
   *
   * Nothing is laid where a deck continues on the far side. That is the whole
   * rule, and it is the one the previous version had exactly inverted.
   */
  _buildCrossWalkKerbs(M) {
    const zc = APRON_Z - 7;          // cross-walk centre in Z
    const zFront = APRON_Z - 14;     // outboard face, where the piers attach
    const HALF = 1.15 / 2;
    const y = DECK_Y + HALF;

    // Outboard ends, running the cross-walk's own 14 m depth.
    for (const s of [-1, 1]) {
      this._box(1.2, 1.15, 14, s * CROSS_HALF_W, y, zc, M.trim, true);
    }

    // The two wings at the apron seam, from the apron's edge to the walk's.
    const wing = CROSS_HALF_W - APRON_HALF_W;
    if (wing > 1) {
      for (const s of [-1, 1]) {
        this._box(wing, 1.15, 1.2, s * (APRON_HALF_W + wing / 2), y, APRON_Z - 0.6, M.trim, true);
      }
    }

    /* The outboard face, everywhere a pier does not open onto it. Sorted
     * because `berths` is authored in whatever order reads well in `Bodies.js`
     * and the gaps have to be walked left to right. */
    const mouths = this.anchor.berths
      .map((b) => b.position[0])
      .sort((a, b) => a - b);
    let x = -CROSS_HALF_W;
    for (const bx of [...mouths, null]) {
      const stop = bx === null ? CROSS_HALF_W : bx - PIER_HALF_W;
      const w = stop - x;
      if (w > 1) this._box(w, 1.15, 1.2, x + w / 2, y, zFront + 0.6, M.trim, true);
      if (bx !== null) x = bx + PIER_HALF_W;
    }
  }

  _buildPiers(M) {
    const start = APRON_Z - 14;
    for (const berth of this.anchor.berths) {
      const [bx, , bz] = berth.position;
      const end = bz - 10;
      const len = start - end;
      const midZ = (start + end) / 2;

      this._box(PIER_HALF_W * 2, 1.4, len, bx, DECK_Y - 0.7, midZ, M.deck, true);
      for (const s of [-1, 1]) {
        this._box(0.7, 1.0, len, bx + s * PIER_HALF_W, DECK_Y + 0.5, midZ, M.trim, true);
      }
      // Spine truss under it, so a 150 m pier is not a floating plank.
      this._box(2.2, 3.6, len, bx, DECK_Y - 3.4, midZ, M.dark);
      for (let z = start - 12; z > end; z -= 24) {
        this._box(PIER_HALF_W * 2 + 2, 1.0, 1.0, bx, DECK_Y - 5.0, z, M.trim);
      }

      // Berth pad, with a marked ring, at the pier's end.
      this._box(24, 1.4, 26, bx, DECK_Y - 0.7, bz, M.deck, true);

      /* Rails round the pad, on the three and a half edges that are drops.
       *
       * The pier arrives 9 m wide onto a 24 m pad, so the pad overhangs the
       * pier by 7.5 m on each side and the whole of its far end is open air
       * 150 m from the station. The pier's own rails stop at the pad. Without
       * these the last thing a player walks to - the berth their ship is in -
       * was the least guarded surface in the yard.
       *
       * They sit at the pad edge, 12 m off the centreline: outside the 8.6 m
       * mooring ring, outside the gantry legs at +-11, and outside any hull
       * this yard berths, so nothing here can end up drawn through a ship. */
      for (const t of [-1, 1]) {
        this._box(1.0, 1.15, PAD_HALF_D * 2, bx + t * PAD_HALF_W, DECK_Y + 0.575, bz, M.trim, true);
      }
      this._box(PAD_HALF_W * 2, 1.15, 1.0, bx, DECK_Y + 0.575, bz - PAD_HALF_D, M.trim, true);
      // The two wings of the near edge, either side of the pier mouth.
      const wingW = PAD_HALF_W - PIER_HALF_W;
      for (const t of [-1, 1]) {
        this._box(wingW, 1.15, 1.0, bx + t * (PIER_HALF_W + wingW / 2), DECK_Y + 0.575,
          bz + PAD_HALF_D, M.trim, true);
      }
      const ring = new THREE.RingGeometry(7.4, 8.6, 28);
      this._bake(ring, M.hazard,
        _m4.compose(_v.set(bx, DECK_Y + 0.06, bz), _q.setFromEuler(_e.set(-Math.PI / 2, 0, 0)), _one));

      /* Mooring gantry and a docking arm, so a berth is recognisable as a
       * berth when it is empty - which, today, all four of them are. The arm
       * is the part that says a ship gets HELD here rather than just parked. */
      for (const s of [-1, 1]) {
        this._box(1.8, 12, 1.8, bx + s * 11, DECK_Y + 6, bz, M.trim);
        this._box(2.6, 2.0, 2.6, bx + s * 11, DECK_Y + 12.4, bz, M.module);
      }
      this._box(24, 1.8, 1.8, bx, DECK_Y + 12, bz, M.trim);

      /* THE ARM READS AS AN ARM, NOT AS A BROKEN COLUMN.
       *
       * It was a 1.6 x 1.6 member in `M.trim` at -0.5 rad, which is the same
       * section and the same material as the gantry LEG standing vertically
       * 5 m away - so a tester walking the pier deck reported "a grey column
       * leaning at ~15 degrees next to an identical vertical one. Reads as a
       * broken prop." They had no way to know it was a machine: nothing about
       * it was shaped like one.
       *
       * Three changes, all of them shape: a slimmer boom, in `M.dark` so it
       * belongs to the machinery family rather than to the structure, a
       * SHOULDER where it leaves the header (a rake with no pivot is a lean),
       * and a clamp head at the free end that is visibly a clamp - two jaws
       * on a yoke. Nothing here moves and nothing here is collided; it is
       * eleven boxes on a berth that has to say "a ship gets HELD here" while
       * standing empty. */
      const armX = bx - 6, armZ = bz + 4, armY = DECK_Y + 9.6;
      // Shoulder: the pivot the boom rakes away from.
      this._box(2.2, 2.2, 2.2, bx - 2.2, DECK_Y + 11.6, armZ, M.module);
      this._boxR(9, 1.0, 1.0, armX, armY, armZ, 0, 0, -0.5, M.dark);
      // The jaw yoke and its two pads, out at the free end.
      this._box(1.2, 2.6, 1.2, bx - 9.9, DECK_Y + 7.6, armZ, M.module);
      for (const j of [-1, 1]) {
        this._box(2.4, 0.9, 1.0, bx - 10.9, DECK_Y + 7.6 + j * 0.95, armZ, M.trim);
      }
      this._box(1.0, 2.8, 0.5, bx - 12.0, DECK_Y + 7.6, armZ, M.hazard);
      // Service stack beside the pad: umbilicals, a locker, a caution panel.
      this._box(3.0, 6.0, 3.0, bx + 10, DECK_Y + 3, bz - 10, M.module);
      this._box(3.6, 0.8, 3.6, bx + 10, DECK_Y + 6.4, bz - 10, M.hazard);
    }
  }

  /* ------------------------------------------------------------------ */
  /* Lights                                                              */
  /* ------------------------------------------------------------------ */

  /**
   * Running lights.
   *
   * Emissive geometry, not lights. `RIG_BUDGET.point` is 12 for the whole game
   * and every one of them is compiled into every shader in every world; a
   * station wall of two hundred lamps would charge Medieval's boot for the
   * privilege. These are unlit basic material above 1.0, and the bloom does
   * the rest.
   */
  _buildLights(M) {
    const amber = [];
    const nav = [];
    const navColor = [];

    // Along both pier edges, every 16 m.
    for (const berth of this.anchor.berths) {
      const [bx, , bz] = berth.position;
      for (let z = APRON_Z - 20; z > bz - 4; z -= 16) {
        amber.push([bx - PIER_HALF_W, DECK_Y + 1.15, z]);
        amber.push([bx + PIER_HALF_W, DECK_Y + 1.15, z]);
      }
    }
    // Round the apron and the cross-walk.
    for (let x = -APRON_HALF_W; x <= APRON_HALF_W; x += 16) {
      amber.push([x, DECK_Y + 1.1, APRON_Z + 2]);
    }
    // Eaves, both sides, the whole length of the hall - the line that tells
    // you how long the building is when nothing else is resolving.
    for (let z = HALL_FRONT_Z + 6; z <= HALL_BACK_Z; z += 12) {
      amber.push([-(HALL_OUTER_HW + 2.4), HALL_TOP_Y - 1.2, z]);
      amber.push([HALL_OUTER_HW + 2.4, HALL_TOP_Y - 1.2, z]);
    }
    /* Round the brow over the mouth, down the front corners, and along the
     * bottom edge of the keel.
     *
     * This is the outline, and it is the answer to a fact rather than a
     * flourish: the star bears aft, so the whole front elevation is unlit, and
     * at 280 m the only thing on screen was the lit mouth floating in black
     * with no building round it. A line of lamps down each front corner and
     * along the keel draws the mass in dots. Measured over the same framing,
     * the fraction of the frame above luminance 40 went 8.5% -> 9.1% and what
     * changed is that you can see where the building ENDS. */
    for (let x = -88; x <= 88; x += 11) {
      amber.push([x, HALL_TOP_Y + 4.4, HALL_FRONT_Z - 9.6]);
    }
    for (const s of [-1, 1]) {
      for (let y = -12; y < HALL_TOP_Y; y += 4.5) {
        amber.push([s * (HALL_OUTER_HW + 3.2), y, HALL_FRONT_Z - 7.2]);
      }
      for (let z = HALL_FRONT_Z; z <= HALL_BACK_Z; z += 14) {
        amber.push([s * (HALL_KEEL_HW + 1), DECK_Y - HALL_KEEL_D + 1, z]);
      }
    }
    // Along the spine and over the roof plant.
    for (let z = 118; z <= 234; z += 15) {
      amber.push([0, SPINE_Y + SPINE_R + 2, z]);
      amber.push([0, SPINE_Y - SPINE_R - 2, z]);
    }
    for (let z = WELL_BACK_Z + 6; z < HALL_BACK_Z; z += 14) {
      amber.push([-62, HALL_TOP_Y + 1.4, z]);
      amber.push([62, HALL_TOP_Y + 1.4, z]);
    }

    /* Port red, starboard green, on the four extremities of the plan - the
     * outermost pier tips, the port radiator and the starboard slip. The
     * oldest navigation convention there is, and it tells a returning pilot
     * which way round they are approaching without a HUD element. */
    const outer = this.anchor.berths;
    nav.push([outer[0].position[0] - 11, DECK_Y + 13, outer[0].position[2]]);
    navColor.push([3.0, 0.18, 0.14]);
    nav.push([outer[3].position[0] + 11, DECK_Y + 13, outer[3].position[2]]);
    navColor.push([0.16, 3.0, 0.42]);
    nav.push([-124, 94, 148]);
    navColor.push([3.0, 0.18, 0.14]);
    nav.push([174, 44, 56]);
    navColor.push([0.16, 3.0, 0.42]);
    nav.push([0, MAST_TOP_Y + 2, HALL_FRONT_Z - 4]);
    navColor.push([2.4, 2.4, 2.8]);

    const sphere = this._geo(new THREE.SphereGeometry(0.62, 6, 4));
    const amberMat = this._mat(new THREE.MeshBasicMaterial({
      color: new THREE.Color(2.6, 1.5, 0.6), fog: false, toneMapped: false,
    }));
    const amberMesh = new THREE.InstancedMesh(sphere, amberMat, amber.length);
    amberMesh.name = 'space:dock:lights';
    const dummy = new THREE.Object3D();
    for (let i = 0; i < amber.length; i++) {
      dummy.position.set(amber[i][0], amber[i][1], amber[i][2]);
      dummy.updateMatrix();
      amberMesh.setMatrixAt(i, dummy.matrix);
    }
    amberMesh.instanceMatrix.needsUpdate = true;
    amberMesh.computeBoundingSphere();
    this.group.add(amberMesh);

    const navMat = this._mat(new THREE.MeshBasicMaterial({
      color: 0xffffff, fog: false, toneMapped: false,
    }));
    const navMesh = new THREE.InstancedMesh(
      this._geo(new THREE.SphereGeometry(1.1, 8, 5)), navMat, nav.length
    );
    navMesh.name = 'space:dock:nav';
    const c = new THREE.Color();
    for (let i = 0; i < nav.length; i++) {
      dummy.position.set(nav[i][0], nav[i][1], nav[i][2]);
      dummy.updateMatrix();
      navMesh.setMatrixAt(i, dummy.matrix);
      c.setRGB(navColor[i][0], navColor[i][1], navColor[i][2]);
      navMesh.setColorAt(i, c);
    }
    navMesh.instanceMatrix.needsUpdate = true;
    if (navMesh.instanceColor) navMesh.instanceColor.needsUpdate = true;
    navMesh.computeBoundingSphere();
    this.group.add(navMesh);
    this.lightCount = amber.length + nav.length;

    // The beacon mast, standing on the brow.
    this._box(3.0, MAST_TOP_Y - HALL_TOP_Y, 3.0, 0,
      (MAST_TOP_Y + HALL_TOP_Y) / 2, HALL_FRONT_Z - 4, M.trim);
    for (let y = HALL_TOP_Y + 12; y < MAST_TOP_Y; y += 14) {
      this._box(9, 1.0, 1.0, 0, y, HALL_FRONT_Z - 4, M.dark);
    }
    this._box(5.0, 2.4, 5.0, 0, MAST_TOP_Y, HALL_FRONT_Z - 4, M.module);
  }

  /**
   * Lit windows, as one instanced quad mesh.
   *
   * Planes rather than boxes: 2 triangles each against 12, and a window is
   * only ever seen from the outside of the wall it is in. Per-instance colour
   * carries the warm/cold/dark mix; see `_winColour`.
   */
  _buildWindows() {
    const n = this._windows.length;
    if (!n) return;
    const mat = this._mat(new THREE.MeshBasicMaterial({
      color: 0xffffff, fog: false, toneMapped: false, side: THREE.FrontSide,
    }));
    const mesh = new THREE.InstancedMesh(this._geo(new THREE.PlaneGeometry(1, 1)), mat, n);
    mesh.name = 'space:dock:windows';
    const dummy = new THREE.Object3D();
    const c = new THREE.Color();
    for (let i = 0; i < n; i++) {
      const [x, y, z, nx, ny, nz, w, h, r, g, b] = this._windows[i];
      dummy.position.set(x, y, z);
      dummy.lookAt(x + nx, y + ny, z + nz);
      dummy.scale.set(w, h, 1);
      dummy.updateMatrix();
      mesh.setMatrixAt(i, dummy.matrix);
      c.setRGB(r, g, b);
      mesh.setColorAt(i, c);
    }
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    mesh.computeBoundingSphere();
    this.group.add(mesh);
    this.windowCount = n;
    this._windows.length = 0;
  }

  /* ------------------------------------------------------------------ */
  /* The habitat ring                                                    */
  /* ------------------------------------------------------------------ */

  /**
   * Built last and separately, because it TURNS.
   *
   * It is the only curved mass on the station and the only moving one, and
   * both of those are doing work: the curve reads against a model that is
   * otherwise entirely flats and prisms, and the movement is the one cue that
   * tells a player who looks at the yard for three seconds that it is a live
   * installation rather than a sculpture.
   *
   * The ring and its spokes are merged into one geometry so the whole thing is
   * one draw; the window band is a second, because it is unlit and the
   * structure is not.
   */
  _buildRing(M) {
    const parts = [
      new THREE.TorusGeometry(RING_R, 7.0, 10, 36),
      new THREE.TorusGeometry(RING_R, 8.6, 4, 36),
    ];
    parts[1].applyMatrix4(_m4.makeScale(1, 1, 0.34));
    /* Radial stubs INWARD off the ring, stopping short of the bearing collar.
     * Not spokes to the hull: the ring turns and the spine does not. */
    for (let i = 0; i < 6; i++) {
      const a = (i / 6) * Math.PI * 2;
      const g = new THREE.BoxGeometry(3.4, 8, 3.4);
      _q.setFromEuler(_e.set(0, 0, a + Math.PI / 2));
      g.applyMatrix4(_m4.compose(_v.set(Math.cos(a) * (RING_R - 9), Math.sin(a) * (RING_R - 9), 0), _q, _one));
      parts.push(g);
    }
    const merged = mergeGeometries(parts, false);
    for (const p of parts) p.dispose();
    if (!merged) throw new Error('[space/DockExterior] the habitat ring failed to merge');
    merged.computeBoundingSphere();
    this._geo(merged);

    const ring = new THREE.Mesh(merged, M.trim);
    ring.name = 'space:dock:ring';
    ring.position.set(0, SPINE_Y, RING_Z);
    this.group.add(ring);
    this.ring = ring;

    // Window band, riding the rotation.
    const wins = [];
    const bandR = RING_R + 7.2;
    for (let i = 0; i < 30; i++) {
      const a = (i / 30) * Math.PI * 2;
      const g = new THREE.BoxGeometry(2.2, 2.2, 1.0);
      g.applyMatrix4(_m4.makeTranslation(Math.cos(a) * bandR, Math.sin(a) * bandR, 0));
      wins.push(g);
    }
    const wm = mergeGeometries(wins, false);
    for (const w of wins) w.dispose();
    if (!wm) throw new Error('[space/DockExterior] the ring window band failed to merge');
    wm.computeBoundingSphere();
    this._geo(wm);
    const band = new THREE.Mesh(wm, this._mat(new THREE.MeshBasicMaterial({
      color: new THREE.Color(2.3, 1.7, 1.0), fog: false, toneMapped: false,
    })));
    band.name = 'space:dock:ring:windows';
    ring.add(band);

    /* The ring is placed after `_flush`, so its reach has to be checked here
     * or it escapes the bound. Centre plus the furthest vertex on the band,
     * which is outside the torus and is therefore the binding case. */
    const reach = ring.position.length() + bandR + 1.6;
    if (reach > BOUND_R) {
      throw new Error(
        `[space/DockExterior] the habitat ring reaches ${reach.toFixed(1)} m, outside ` +
        `DOCK_ANCHOR.radius ${BOUND_R}.`
      );
    }
    this.maxRadius = Math.max(this.maxRadius, reach);
  }

  /* ------------------------------------------------------------------ */
  /* The beacon                                                          */
  /* ------------------------------------------------------------------ */

  /**
   * A camera-facing quad, additive, with a radial falloff and a cross flare.
   * The flare is what makes the eye read it as a LIGHT rather than as a small
   * bright ball, and it costs four lines of GLSL.
   */
  _buildBeacon() {
    this._beaconMat = this._mat(new THREE.ShaderMaterial({
      transparent: true,
      blending: THREE.AdditiveBlending,
      /* Tested, like every other transparent thing in this world - see the
       * note above BACKDROP_TRANSPARENT in BodyShaders.js. It means the glow
       * goes behind the spine when the yard is between you and the mast,
       * which is what a lamp on the far side of a building does. */
      depthTest: true,
      depthWrite: false,
      fog: false,
      toneMapped: false,
      uniforms: {
        uColor: { value: new THREE.Color(1.0, 0.62, 0.24) },
        /** Rises with true distance to the yard. Set per frame. */
        uGain: { value: 1 },
        /** The strobe. Set per frame. */
        uPulse: { value: 1 },
      },
      vertexShader: /* glsl */ `
        varying vec2 vUv;
        void main() {
          vUv = uv;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }
      `,
      fragmentShader: /* glsl */ `
        uniform vec3 uColor;
        uniform float uGain;
        uniform float uPulse;
        varying vec2 vUv;
        void main() {
          vec2 p = (vUv - 0.5) * 2.0;
          float d = length(p);
          /* Gaussian, not a power ramp. The power ramp put all of its energy
           * in the middle two percent of the quad's area and the rest of the
           * sprite was wasted. */
          float core = exp(-d * d * 4.5);
          // Four-point flare: bright along the axes, dark on the diagonals.
          float ax = max(1.0 - abs(p.x) * 7.0, 0.0) * max(1.0 - abs(p.y), 0.0);
          float ay = max(1.0 - abs(p.y) * 7.0, 0.0) * max(1.0 - abs(p.x), 0.0);
          float flare = pow(max(ax, ay), 1.9) * 0.7;
          float a = (core + flare) * uGain * uPulse;
          if (a < 0.002) discard;
          /* 6.0, not 2.6. At 2.6 the peak was 0.98 linear, the space grade's
           * bloom threshold is 1.60, the strobe never bloomed and the yard
           * could not be found at 40 km. */
          gl_FragColor = vec4(uColor * a * 6.0, min(a, 1.0));
        }
      `,
    }));
    const quad = new THREE.Mesh(this._geo(new THREE.PlaneGeometry(1, 1)), this._beaconMat);
    quad.name = 'space:dock:beacon';
    quad.frustumCulled = false;
    /* Clear of the mast cap: with the depth test on, a quad centred level with
     * the cap would have its lower half eaten by it. */
    quad.position.set(0, MAST_TOP_Y + 10, HALL_FRONT_Z - 4);
    this.group.add(quad);
    this.beacon = quad;
  }

  /* ------------------------------------------------------------------ */
  /* Per frame                                                           */
  /* ------------------------------------------------------------------ */

  /**
   * @param {THREE.Camera} camera
   * @param {number} elapsed seconds
   * @param {number} groupScale the uniform scale `Backdrop` just wrote onto
   *        `this.group`. The beacon has to divide it back out, because it is
   *        parented to the group (so it follows the structure for free) but
   *        must not shrink with it.
   * @param {number} trueDistance metres from the camera to the yard, in the
   *        TRUE frame. The gain curve needs this and not the proxy distance:
   *        the proxy is logarithmic and barely moves between 10 km and 250 km,
   *        which is the whole range the beacon exists to cover.
   */
  update(camera, elapsed, groupScale, trueDistance) {
    // The habitat ring turns. 0.05 rad/s is one revolution every two minutes:
    // slow enough to be dignified, fast enough that a player looking at the
    // station for three seconds sees it move.
    if (this.ring) this.ring.rotation.z = elapsed * 0.05;

    const beacon = this.beacon;
    if (!beacon) return;

    camera.getWorldPosition(_camPos);
    beacon.getWorldPosition(_beaconWorld);
    const dist = _beaconWorld.distanceTo(_camPos);

    /* Constant angular size. `dist` here is the PROXY distance - the beacon
     * has already been moved by the group transform - and that is the right
     * one to use, because angular size in the render frame is what the camera
     * actually projects. */
    const halfWorld = Math.tan(BEACON_ANGULAR * 0.5) * Math.max(dist, 1);
    beacon.scale.setScalar((halfWorld * 2) / Math.max(groupScale, 1e-9));
    beacon.quaternion.copy(camera.quaternion);

    /* Gain: a lamp on a mast when you are standing on the deck, a star when
     * the yard is a speck. Smoothstep on TRUE distance, floor 0.12 at the
     * mast, full by 8 km - roughly where the hull stops resolving into parts
     * and the beacon has to take over the job of being findable. */
    const t01 = Math.min(Math.max((trueDistance - 400) / 7600, 0), 1);
    const gain = 0.12 + 0.88 * (t01 * t01 * (3 - 2 * t01));

    /* The strobe: a sharp attack and a long decay, once every 1.9 s. A sine
     * reads as a throb; this reads as a beacon. */
    const t = (elapsed % 1.9) / 1.9;
    const pulse = 0.42 + 0.58 * Math.exp(-t * 5.5);

    this._beaconMat.uniforms.uGain.value = gain;
    this._beaconMat.uniforms.uPulse.value = pulse;
  }

  dispose() {
    for (const g of this._geoms) g.dispose();
    for (const m of this._mats) m.dispose?.();
    this.skin?.dispose();
    this._geoms.length = 0;
    this._mats.length = 0;
  }
}
