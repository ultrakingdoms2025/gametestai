import * as THREE from 'three';
import { World } from './World.js';
import { makeRules } from './WorldRules.js';
import { GeoBatch, boxGeo, uvScale, instanced, RAMP_PROXY_FLAG, RAMP_PROXY_NAME } from './station/StationKit.js';
import { DistanceLod, CENTRE } from './lod/DistanceLod.js';
import { buildLorePersona } from '../content/Lore.js';
import { buildYardTextures, buildYardMaterials, YARD_SIGN, yardSignUV } from './dock/YardTextures.js';
import { railRun, stairTreads, signBoard, paintQuad, workLight } from './dock/YardKit.js';
import { ShipBuild, shipMaterials, fitOut } from './dock/ShipKit.js';
import { buildKestrel, buildDray, buildPike, buildBastion } from './dock/Hulls.js';
import { HULLS, WALKABLE, BROW, boardSide } from './dock/HullPlan.js';
import { Ship } from '../ships/Ship.js';
import { loadShipAssets } from '../ships/ShipAssets.js';
import { SHIP_TINTS, SHIP_CLASSES, SHIP_BASE_STATS, SHIP_STATS } from '../ships/ShipStats.js';
import {
  DECK_Y, GANTRY_Y, CRANE_Y, ROOF_Y, TRENCH_Y,
  YARD_X, YARD_Z0, YARD_Z1, WALK_W, GANTRY_X, GANTRY_Z0, GANTRY_Z1, KEEL_HW,
  PORTAL_STATION_Z, PORTAL_SPACE_Z,
  TRENCH_HW, DATUM_ISLAND_HZ, TRENCH_RUNS, TRENCH_BAYS,
  BUTTS_FIRE_Z, BUTTS_WALL_X, BUTTS_PLATES, BUTTS_RANKS,
  BUTTS_CELL_COST, BUTTS_SECONDS, BUTTS_REWARD,
  STAIR_RISERS, STAIR_RUN, STAIR_W, STAIRS, CROSSINGS, CROSSING_COLUMN_X,
  BERTHS, SECTIONS, COUNTER_X, COUNTERS, APRON_Z, OFFICE, CRANE_CAB, CRANE_RUN, CRANE_WALK,
  SIGNAL_POST, SIGNAL_POST_HD, SIGNAL_RUN, SPARES_PILE, FLOOR_AREA,
  MOUTH_Z, MOUTH_HW, MOUTH_Y1, MOUTH_KERB_H, ROOF_CUT_Z,
  PIERS, PIER_HW, PIER_T, PIER_GATE_HW, pierPad, pierOf,
  STAR_SHELL, BODIES,
} from './dock/YardPlan.js';
import { STAR_DIRECTION } from './space/Bodies.js';
/* Module-level scratch for `_buildVoid`. Build-time only, but the rule is the
 * rule: nothing in this file allocates a vector inside a loop. */
const _UP_Y = new THREE.Vector3(0, 1, 0);
const _bodyAxis = new THREE.Vector3();
import {
  makeBodyMaterial, makeAtmosphereMaterial, makeRingMaterial, makeCoronaMaterial,
} from './space/BodyShaders.js';

/**
 * WORLD 06 — LODESTAR YARD, the shipyard behind gateway six.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 *  WHAT THIS PLACE IS
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Survey Site 06 got commissioned. The levelled pad `SurveyWorld` stood on —
 * a datum, a setting-out grid, eighty marker stakes and no decision — is a
 * working yard now, and the surveyors' brass benchmark is still bolted to the
 * floor at the origin with every berth in the place dimensioned off it.
 *
 * Lodestar Yard does not BUILD ships, it re-assembles them. Nothing bigger
 * than a gateway arch has ever come through a gateway, so every hull here
 * arrived in sections narrow enough to walk through a portal and was pinned
 * back together on a cradle. That is not flavour text: it is the reason the
 * hulls the next drop hangs on these cradles are slab-sided, ribbed and
 * segmented with a bolted string course at every section joint — which is
 * exactly the collision shape a free-climbing player needs, and exactly what
 * `physics.addRotatedBox` can express and `addTriangleSoup` cannot.
 *
 * The yard has fitted out four hulls and launched none of them. The board over
 * the blast door has read LAUNCHES: 000 since the site was commissioned. The
 * player is the first launch, and §8's seam is built so that stays true.
 *
 * ── Tone, against its neighbours ──────────────────────────────────────────
 * Aether Nexus Station is civic and lit for a public. Ashfall Reach is
 * lived-in. Sunspire Citadel is a wall you climb. Lodestar Yard is industrial,
 * cold and half finished: sodium worklights OVER cyan wayfinding (the inverse
 * of the station's colour script, see `YardTextures.buildYardMaterials`),
 * tarps, scaffold, chalk ghosts on the floor and section numbers stencilled on
 * everything.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 *  WHAT THIS DROP OWNS, AND WHAT IT DELIBERATELY DOES NOT
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * This is the YARD. The four hulls are the next stage's, and the only thing
 * this file says about them is `shipSpecs` — the berth anchors: a cradle
 * centre, a yaw, a bearing height, a footprint half-extent and the point on
 * the keel-line side where a boarding ramp foot lands. Every one of those is
 * probed by `scripts/tests/dock-reach.test.mjs`, so a berth whose apron cannot
 * be walked to is red before a hull is ever drawn on it.
 *
 * ── Reachability, from the first commit ───────────────────────────────────
 * Content that was BUILT and cannot be REACHED is this project's signature
 * defect: fifteen unenterable medieval buildings shipped past a 1,074-test
 * suite, and the station glazed and railed a hangar mezzanine nothing could
 * get to. So the arrangement here is deliberate and the test is a probe, not
 * an assertion:
 *
 *   deck 0      the whole floor, one continuous surface
 *   gantry 8.0  TWO stairs (apron end, blast-door end), both drawn as treads
 *               over ONE hidden ramp proxy, because the capsule solver
 *               resolves slopes and does not step up
 *   crane 15.4  a caged run off the north crossing to the CAB — the cab is
 *               walkable, the rail it hangs off is not
 *   trench -2.2 three ramped bays, each an entrance AND an exit
 *
 * and `dock-reach.test.mjs` floods the real colliders from the real arrival
 * point, forward and backward, so "and back out" is proved rather than
 * assumed.
 *
 * ── The roof is collided, and the brief said not to ───────────────────────
 * The design said "roof truss, no collider". Measured against
 * `mounts/FlightCeiling.js`: `flightCeilingAt` returns `null` for every world
 * that is not the station, so with no roof collider a summoned eagle leaves
 * the shed through the truss and flies to `bounds.max.y`. One box collider
 * under the roof plate costs one collider of a 1,400 budget and closes it. The
 * TRUSS is still uncollided — it is decoration hanging under a solid plate.
 */

/* ------------------------------------------------------------------ */
/* Module scratch. Nothing below allocates in `update`.                */
/* ------------------------------------------------------------------ */
const _v1 = new THREE.Vector3();
const _v2 = new THREE.Vector3();

const RESOLVED = Promise.resolve();
const noBreath = () => RESOLVED;
function yieldFrame() {
  return new Promise((r) => requestAnimationFrame(() => r()));
}

/** Floor slab thickness. Deep enough that the trench is a recess in it. */
const FLOOR_T = 2.8;
/** Perimeter wall thickness. */
const WALL_T = 1.2;
/** Catwalk deck thickness. */
const DECK_T = 0.14;
/** Grating over the service trench: the top face is the deck, y 0. */
const GRATE_T = 0.1;
/** Structural bay pitch — the shed's portal frames and the chalk grid share it. */
const BAY = 12;

export class DockWorld extends World {
  static id = 'dock';
  static displayName = 'Lodestar Yard';
  /* No `static volatile`. The yard is a place with a state — a countdown board
   * that will read 001, cradles a ship stage hangs hulls on, caches and relics
   * placed off its own geometry — and a world that re-rolled that on every
   * entry would be throwing all of it away. */

  constructor(ctx) {
    super(ctx);

    this.rules = makeRules({
      /* A civilian worksite. `hostiles: false` is the one rule worth arguing:
       * the space-invaders fantasy lives in space, and putting a firefight
       * inside a hangar full of walk-in hulls puts the interior work and the
       * combat work in each other's way for no gain. `DROP_TABLES.dock` is
       * authored anyway — the rule can flip, the fallback is silent, and a
       * quest step naming a station item that the fallback makes "technically
       * obtainable" is exactly how two citadel steps shipped asking for
       * ammunition a mesa does not manufacture. */
      hostiles: false,
      /* No circuit, no `trackPath`, so `RaceManager` would arm off nothing
       * anyway; said out loud so it is a decision rather than an omission. */
      races: false,
      /* Nothing here holds water. Leaving `swim` on would have `WaterVolumes`
       * scan a shed every world change for volumes that do not exist. */
      swim: false,
      /* Everything else is ON, and each of those is load-bearing:
       *   interiors  the site office is a real enterable, and every ship the
       *              next stage hangs here is another (`SurveyWorld` set this
       *              false, which is the first thing that had to change)
       *   merchants  three counters, and the whole catalogue between them
       *   crowd      `_spawnLorekeepers` returns immediately without it, and
       *              the yard would have no keeper at either gateway
       *   caches/relics/loot/contracts/quests as authored in §6 and §7 */
    });

    /* 172 x 162 m of floor inside a 26 m shed. Compact on purpose: the station
     * is 1,440 m across and pays 3,175 ms in `_settleDressing` for it. A yard
     * this size read from a gantry is a whole world, and every prop in it
     * stands on a known datum — deck 0, catwalk 8.0, a cradle top — so neither
     * a dressing settle nor a fixed-point prop solidify pass is needed. */
    /* The bay is 172 x 162 m; the piers add 76 m of structure past its north
     * lip and Berth Zero's pad reaches z -180. `min.y` is the void floor
     * `Unstuck` rescues a body below (`Unstuck.js:460`), and it is the reason
     * a player who gets over a pier rail is recovered rather than lost. */
    this.bounds = new THREE.Box3(
      new THREE.Vector3(-115, -8, -196),
      new THREE.Vector3(115, 34, 74)
    );

    this.environment = {
      ...this.environment,
      /* ── The light was the complaint, and this is half the answer ───────
       * Measured on the sealed shed: min framing luminance 9.7, median 10.0.
       * A lighting pass took those to 17.0 and 24.5 and the verdict was still
       * "too dark", so this goes further, at the level that moves EVERY pixel
       * rather than the ones near a lamp.
       *
       *   ambient   0.22 -> 0.42     hemi 0.34 -> 0.54   (0.96, under the
       *   sun       1.35 -> 2.05     stated < 1.0 rule for the pair)
       *   exposure  1.00 -> 1.14
       *
       * The ambient rule is `StationWorld.js:10530` and 0.96 is still inside
       * it. It is spent here because the yard's problem was never contrast in
       * the pools — it was that everything BETWEEN them was black, which is
       * exactly what ambient owns.
       *
       * The background is very nearly black now and that is not a regression:
       * behind the mouth there is a real starfield with three lit bodies in
       * it, so the clear colour is only ever seen through the field haze. */
      background: new THREE.Color(0x05070c),
      fogColor: new THREE.Color(0x1a2331),
      /* Fog pushed out from 44/240 to 90/1100. The old pair was written for a
       * closed shed 162 m deep; with the mouth open, the far pier tip is
       * 240 m from the arrival point and at fogFar 240 it was 100% fog — the
       * piers this world exists to show would have been a grey smear. Vacuum
       * has no haze anyway; the bay does, and 90 m of clear air before it
       * starts is the whole hall. */
      fogNear: 90,
      fogFar: 1100,
      /* 1.20. The last stop, and the smallest of the three levers used here —
       * exposure scales the whole frame including the starfield, so it is the
       * one that turns a lit void back into a grey one if it is leaned on. The
       * work was done by the lamps and by the pier deck material; this is the
       * trim. Measured across all 35 framings at 1.14 and again at 1.20 in
       * `dock-light.test.mjs`'s note. */
      /* 1.20, and it STAYS 1.20 - see `dock-light.test.mjs`'s last case.
       *
       * The bay measures a mean frame luminance of 31-43 out of 255 across the
       * framings a player stands in and the verdict on that was "a big dark
       * room", which is this world's own second rejection verbatim. Exposure is
       * the control a screenshot makes you reach for, and it is the wrong one
       * here twice over: `GRADE_PRESETS.dock` picks its bloom threshold (2.40)
       * against this world's measured LINEAR luminance and exposure scales that
       * before tone mapping, so moving it silently re-points the bloom; and the
       * complaint is not that the lit parts are dim, it is that everything
       * between them is black, which is the shadow END of the curve.
       *
       * The two levers taken instead are the ones that act where the problem
       * is: `sunIntensity` and `envMapIntensity` below (the hulls and walls are
       * the darkest large surfaces in the bay, and the environment is what
       * separates a plated flank from a silhouette), and `toeLift` in the dock
       * grade, which raises the shadow floor without touching where bloom
       * starts. */
      exposure: 1.20,
      ambientColor: new THREE.Color(0x4d5b74),
      ambientIntensity: 0.42,
      hemiIntensity: 0.54,
      /* The "sun" is the bank of high bay lamps in the truss AND the distant
       * primary the planets are lit by, so it comes from almost overhead and
       * slightly down the yard, and it is warm. */
      sunColor: new THREE.Color(0xffd8ae),
      sunIntensity: 2.9,
      sunDirection: new THREE.Vector3(-0.18, 0.94, 0.29).normalize(),
      /* 0.85 -> 1.05. The hulls are the darkest large surfaces in the bay and
       * they are `MeshStandardMaterial` with low roughness in places, so the
       * environment is what separates a plated flank from a black shape. */
      envMapIntensity: 1.05,
      /* Bloom is owned by `GRADE_PRESETS.dock`, which is selected by world id
       * (`PostFX.js:1099`) and whose threshold is calibrated against this
       * world's own measured linear luminance. A value here would be in the
       * wrong units. */
      bloom: null,
    };

    /* ---------------------------------------------------------------- */
    /* Published fields. Every one of these is read through an optional  */
    /* chain by a system that names no world, so a typo is silent — which */
    /* is why `scripts/contract-check.mjs` pins the NAMES.               */
    /* ---------------------------------------------------------------- */

    /** Enterable interiors for `systems/Interiors.js`. */
    this.enterables = [];
    /** Vantage points for `systems/Viewpoints.js`. */
    this.viewpoints = [];
    /** Soft landings for `player/Parkour.js`. `y` is the TOP of the pile. */
    this.haystacks = [];
    /** Minigame venues for `minigames/MinigameManager.js`. See `_publish`. */
    this.minigameVenues = [];
    /** Authored relic sites at deck level and above, for `systems/Relics.js`. */
    this._roofs = [];
    /** Authored high relic sites — the crane cab, the signal post, the corners. */
    this._towers = [];
    /**
     * Authored cache sites for `systems/Caches.js`.
     *
     * A roofed world cannot find its own: the placement dart starts above the
     * map and takes the first thing it hits, which under a shed is always the
     * shed. See `_publish`.
     */
    this._caches = [];
    /**
     * THE BERTH ANCHORS. The contract between the yard and the hulls on it.
     * @type {Array<object>}
     */
    this.shipSpecs = [];
    /**
     * The fitted hulls, for `ships/ShipRegistry.js`.
     *
     * Published as a plain array off the world, exactly as `viewpoints`,
     * `haystacks` and `minigameVenues` are, so the customiser arms off a field
     * and this file knows nothing about the registry, the panel or the save.
     * The Bastion is NOT in here: she is a hulk with her frames open to the
     * shed, she sells no slots and no stats, and a hull in the customiser with
     * nothing to customise is a tab that does nothing.
     * @type {Array<Ship>}
     */
    this.ships = [];

    /* Owned resources, tracked so `dispose` is not guesswork. The base class
     * traverses meshes, and the canvas textures below are owned by materials
     * shared between merged meshes, so it cannot see them. */
    this._mats = [];
    this._textures = [];
    /**
     * Materials owned outright by the void and the containment field: the star
     * points, the three bodies, the ring, the field scrim. Kept apart from
     * `_mats` because that loop disposes `map`/`normalMap`/`roughnessMap` and
     * these have none — a separate list is cheaper than a guard per material.
     */
    this._voidMats = [];
    /** Backdrop materials with a `uTime` uniform: the gas churn and the star. */
    this._voidTime = [];
    /** The star's corona billboard, turned to face the camera every frame. */
    this._voidCorona = null;
    /** The containment field's time uniform. Ticked in `update`, never allocated. */
    this._fieldTime = null;
    /**
     * Per-hull material CLONES. Tracked apart from `_mats` because they share
     * their parents' maps: disposing a clone must free the material and never
     * the texture, which `_textures` already owns and would otherwise be
     * disposed once per hull that borrowed it.
     */
    this._shipMats = [];
    this.mat = {};

    /**
     * Distance LOD for interiors, and only interiors.
     *
     * Re-decided rather than inherited. The station's "no LOD outside
     * interiors" is a reasoned trade for one continuous deck where everything
     * is meant to be legible from across it, and the yard's floor is the same
     * case. Its INTERIORS are not: the site office fit-out is visible from
     * inside the office and nowhere else, and every hull the next stage hangs
     * here is the same shape of problem — which is the tower case, not the
     * deck case. Colliders are never split; `_solid` registers everything
     * regardless of what is drawn.
     */
    this._lod = new DistanceLod();
  }

  /* ================================================================== */
  /* Build                                                               */
  /* ================================================================== */

  /**
   * @param {(fraction:number, label:string)=>void} [onProgress]
   *
   * Sliced exactly the way `StationWorld.build` is, and for the same reason:
   * `scheduleBackgroundBuilds` runs after `engine.start()`, so a world built
   * there is generated inside the player's frames. `slice` is a NO-OP behind
   * the loading screen (`WorldManager._runBuild` only yields while
   * `engine.running`), which is deliberate — a yield there is a whole rAF
   * added to a boot with no frame to protect.
   *
   * Only one phase here is not frame-sized, and it is the one that paints nine
   * canvases; the rest of the yard is under 40 ms a phase because there is no
   * derived-collision pass and no dressing settle to pay for.
   */
  async build(onProgress) {
    const slice = onProgress?.slice;
    const breathe = (f, label) => (slice ? () => slice(f, label) : noBreath);
    const step = async (f, label, fn) => {
      onProgress?.(f, label);
      await yieldFrame();
      await fn.call(this, breathe(f, label));
    };

    onProgress?.(0.03, 'Printing hull plating');
    await yieldFrame();
    this._tex = await buildYardTextures({
      aniso: this.engine?.renderer?.capabilities?.getMaxAnisotropy?.() ?? 8,
      keep: this._textures,
      breathe: breathe(0.03, 'Printing hull plating'),
    });

    onProgress?.(0.30, 'Fabricating materials');
    await yieldFrame();
    this.mat = buildYardMaterials(this._tex);
    /* The pier edge run. `YardTextures` owns the yard's emissive family and
     * every member of it grades to 30% past 140 m, which is right for a strip
     * light on a wall and wrong for the only thing marking the edge of a
     * walkway suspended over nothing 240 m from where the player is standing.
     * One ungraded material, authored here because it is a property of the
     * PIERS rather than of the yard's palette. */
    this.mat.emPier = new THREE.MeshStandardMaterial({
      color: 0x05070a,
      emissive: new THREE.Color(0x6fe6ff),
      emissiveIntensity: 2.2,
      metalness: 0.1,
      roughness: 0.35,
      toneMapped: true,
    });
    for (const m of Object.values(this.mat)) this._mats.push(m);

    /* One batch for the whole yard. A district of forty buildings collapses to
     * ~6 draw calls this way; the yard collapses to one mesh per material key,
     * which is what keeps the worst framing inside the 220-draw budget with
     * the portal system, the NPCs and the HUD still to pay for. */
    this._B = new GeoBatch();
    this._group = new THREE.Group();
    this._group.name = 'yard';
    this.group.add(this._group);

    await step(0.34, 'Hanging the stars', this._buildVoid);
    await step(0.38, 'Casting the assembly floor', this._buildFloor);
    await step(0.46, 'Raising the shed', this._buildShell);
    await step(0.52, 'Running the piers out', this._buildPiers);
    await step(0.58, 'Cutting the service trench', this._buildTrench);
    await step(0.66, 'Hanging the gantry', this._buildGantry);
    await step(0.74, 'Setting the cradles', this._buildBerths);
    /* THE AUTHORED HULL SKINS, FETCHED BEFORE ANY HULL IS BUILT.
     *
     * `_buildShips` calls the hull builders synchronously — it has to, the
     * yard bakes its berth transform into every vertex — so an asset awaited
     * inside a builder is an asset that arrives after the hull is already
     * merged. It is awaited here instead, and `ShipAssets.shipParts` is then a
     * synchronous read of a warm cache.
     *
     * This is also what makes the FLOWN hull work without a second await:
     * `Piloting._yardMaterials` already depends on the yard having been built
     * before any ship is flown (a flown hull is cloned from the yard's live
     * material set), so the cache this warms is the cache `ShipModel` reads.
     *
     * Never rejects. A missing file resolves to an empty map and every hull
     * builds procedurally, which is the hull the whole test suite measures. */
    onProgress?.(0.78, 'Unpacking the hull skins');
    await loadShipAssets();
    await step(0.80, 'Pinning the hulls together', this._buildShips);
    await step(0.86, 'Fitting out the site office', this._buildOffice);
    await step(0.88, 'Opening the chandlery', this._buildChandlery);
    await step(0.90, 'Striking the containment field', this._buildMouth);
    await step(0.92, 'Rigging the gantry crane', this._buildCrane);
    await step(0.935, 'Running the services', this._buildServices);
    await step(0.938, 'Setting up the section jigs', this._buildSections);
    await step(0.94, 'Scattering set dressing', this._buildDressing);
    await step(0.96, 'Striking the worklights', this._buildLights);

    onProgress?.(0.98, 'Signing the yard on');
    await yieldFrame();
    this._flushBatch();
    this._publish();

    onProgress?.(1, 'Lodestar Yard ready');
  }

  /* ---------------------------------------------------------------- */
  /* Primitives                                                        */
  /* ---------------------------------------------------------------- */

  /** Push geometry into the yard batch. Signature matches `GeoBatch.at`. */
  _put = (key, geo, x, y, z, ry = 0, rx = 0, rz = 0) =>
    this._B.at(key, geo, x, y, z, ry, rx, rz);

  /** An axis-aligned solid volume. */
  _solid(cx, cy, cz, hx, hy, hz) {
    return this.track(this.physics.addBox(cx, cy, cz, hx, hy, hz));
  }

  /** A Y-rotated solid volume — cradles, counters, anything on a berth yaw. */
  _solidRot(cx, cy, cz, hx, hy, hz, ry) {
    return this.track(
      this.physics.addRotatedBox(_v1.set(cx, cy, cz), _v2.set(hx, hy, hz), ry)
    );
  }

  /**
   * A walkable flight: treads drawn, collision a single hidden ramp proxy.
   *
   * ── Why the proxy sits LOW ────────────────────────────────────────────────
   * `_ramp`'s proxy is a 0.5 m-thick box whose CENTRE lies on the slope, so
   * its walkable top surface is `0.25 / cos(pitch)` above that plane — 0.305 m
   * at 35 degrees. Placed on the centreline the flight therefore lands a third
   * of a metre proud of the deck it is supposed to meet, at both ends. That is
   * under `stepHeight` so nobody falls, and it is also a visible lip on every
   * stair in the world. Dropping the proxy by exactly that amount makes the
   * top surface pass through the foot and the head, which is where the treads
   * are drawn.
   *
   * @param {'x'|'z'} axis   which way the flight travels
   * @param {number} x0,z0   the FOOT, on the lower deck
   * @param {number} y0      height of the lower deck
   * @param {number} run     signed horizontal travel to the head
   * @param {number} rise    height gained
   */
  _flight(axis, x0, z0, y0, run, rise, width, risers, opts = {}) {
    stairTreads(this._put, { axis, x0, z0, y0, run, rise, width, risers, ...opts });
    const len = Math.hypot(run, rise);
    const pitch = Math.atan2(rise, Math.abs(run));
    // Local +Z of the proxy must point up the slope.
    const yaw = axis === 'x' ? (run > 0 ? Math.PI / 2 : -Math.PI / 2) : (run > 0 ? 0 : Math.PI);
    const cx = axis === 'x' ? x0 + run / 2 : x0;
    const cz = axis === 'z' ? z0 + run / 2 : z0;
    const cy = y0 + rise / 2 - 0.25 / Math.cos(pitch);
    const proxy = new THREE.Mesh(new THREE.BoxGeometry(width, 0.5, len));
    proxy.visible = false;
    /* NAMED and FLAGGED, not merely invisible. `visible` belongs to the
     * renderer — the boot shader rehearsal clears it across a whole world
     * group for three frames — so anything that identifies a ramp proxy by
     * `visible === false` reports none at all inside that window. */
    proxy.name = RAMP_PROXY_NAME;
    proxy.userData[RAMP_PROXY_FLAG] = true;
    proxy.position.set(cx, cy, cz);
    proxy.rotation.set(0, yaw, 0, 'YXZ');
    proxy.rotateX(-pitch);
    proxy.updateWorldMatrix(true, false);
    this.group.add(proxy);
    this.track(this.physics.addBoxFromObject(proxy));
    return proxy;
  }

  _mmRect(x, z, w, d, rotation, fill, stroke) {
    this.minimapShapes.push({ kind: 'rect', x, z, w, d, rotation: rotation || 0, fill, stroke });
  }

  _mmPath(points, stroke, width, closed) {
    this.minimapShapes.push({ kind: 'path', points, stroke, width, closed: !!closed });
  }

  _mmCircle(x, z, r, fill, stroke) {
    this.minimapShapes.push({ kind: 'circle', x, z, r, fill, stroke });
  }

  /** Merge every bucket into one mesh and park it under the yard group. */
  _flushBatch() {
    const meshes = this._B.flush(this._group, this.mat, 'yard', {
      // The floor and the roof plate never cast; everything else does.
      floor: { cast: false, recv: true },
      apron: { cast: false, recv: true },
      paint: { cast: false, recv: true },
      paintApron: { cast: false, recv: true },
      roof: { cast: false, recv: true },
      signs: { cast: false, recv: true },
      glass: { cast: false, recv: false },
      emSodium: { cast: false, recv: false },
      emAmber: { cast: false, recv: false },
      emCyan: { cast: false, recv: false },
      emRed: { cast: false, recv: false },
      emGreen: { cast: false, recv: false },
      emLaunch: { cast: false, recv: false },
      /* The pier edge lighting. Its own bucket rather than `emCyan` because it
       * must NOT grade off with distance: a pier tip 240 m from the apron is
       * the thing the whole world points at, and `emCyan`'s fade takes it to
       * 30% exactly where it has to read. */
      emPier: { cast: false, recv: false },
    });
    this._batchMeshes = meshes;
  }

  /* ---------------------------------------------------------------- */
  /* The void the bay opens onto                                       */
  /* ---------------------------------------------------------------- */

  /**
   * A starfield and the five real bodies — built FIRST, because everything
   * else in this world is now read against it.
   *
   * ── Why the yard draws its own sky at all ─────────────────────────────────
   * `SpaceWorld` places every distant object against the camera EVERY FRAME
   * through `space/Backdrop.js`, which is what makes 800 km fit inside a
   * 2,000 m far plane. Nothing in this world moves more than 214 m, so the
   * yard does the same contraction ONCE, at build time: `YardPlan.BODIES`
   * scales each body's true position and its radius by the same factor, which
   * is the same arithmetic `Scale.proxyPlacement` does per frame and gives the
   * same bearing and the same angular size.
   *
   * The three invented bodies this replaced - EMBER, CALDER, LODESTONE, with
   * hand-painted canvas skins - are what made the sky change identity,
   * direction and count the moment the player crossed the mouth. See the note
   * on `YardPlan.BODIES` for the measured bearing table.
   *
   * ── Every material here is `fog: false` ───────────────────────────────────
   * The bay's fog runs to 1100 m. A planet at 1 km rendered with fog on is a
   * disc of `fogColor`, which is to say a grey hole in the starfield — the
   * exact bug that made the first draft of this look like a fault rather than
   * a sky. Nothing on the shell is collided either: `bounds.max` is 34 m and
   * the nearest body is 900 m out.
   */
  _buildVoid() {
    const gr = new THREE.Group();
    gr.name = 'yard:void';
    /* On `this.group`, not `this._group`. The batch group is flushed and LOD-
     * managed; the sky is neither, and a starfield that faded at 40 m would be
     * a starfield. */
    this.group.add(gr);
    this._void = gr;

    const keep = (m) => { this._voidMats.push(m); return m; };

    /* ── The field ────────────────────────────────────────────────────────
     * 4,200 points on the `STAR_SHELL`, deterministic, colour-spread by
     * temperature. Twice `SpaceWorld`'s count because they are seen through an
     * aperture that crops 80% of the sphere — the visible wedge has to carry
     * the same density the whole sphere does out there.
     *
     * The half of the shell BEHIND the bay is not culled away, and that is
     * deliberate rather than lazy: the mouth is not the only hole in this
     * world's north end any more, the header truss and the pier soffits are
     * seen against sky from the gantry, and `frustumCulled = false` on one
     * `Points` costs one draw call. */
    /* ── AND THEY ARE ROUND, AND THEY ARE NOT ALL THE SAME STAR ──────────
     *
     * This was `PointsMaterial` with no `map`, which draws a SOLID SQUARE
     * QUAD, at one `size` for all 4,200 of them, with a saturation of up to
     * 0.70 on every single one. A tester who played the whole campaign wrote:
     * "the star field at close range is a dense field of white square dots
     * that reads as dirt on the lens, not as stars", and the capture through
     * the launch well is exactly that - four thousand identical hard-edged
     * two-pixel blocks, a surprising number of them fully saturated blue or
     * orange.
     *
     * Three things were wrong and none of them is the count:
     *
     *   ROUND. An untextured point sprite is a square. `gl_PointCoord` gives
     *   the position within the sprite, so a smooth radial falloff costs two
     *   lines and no texture - and because it never reaches a hard edge, a
     *   sub-pixel star antialiases into a point of light instead of stamping
     *   a block.
     *
     *   MAGNITUDE. `PointsMaterial` has ONE size, so every star was the same
     *   star. A per-point `aMag` attribute drives both the sprite size and
     *   its brightness on a fourth-power curve: a handful you could name, and
     *   a wash you cannot resolve. That hierarchy is what a real sky is made
     *   of and it was entirely absent.
     *
     *   COLOUR AT THE THRESHOLD. The eye has no colour vision at the limit of
     *   detection - faint stars are grey to a real observer. Saturation is
     *   scaled by magnitude, so only the bright ones keep their class and the
     *   scatter of saturated pixels that read as sensor dust is gone.
     *
     * Still one draw call, still no texture, still deterministic. The same
     * three corrections are applied to `gfx/Sky.js`'s `starLayer`, which is
     * what draws the sky in `space` - the two fields have to agree or the sky
     * changes identity at the blast door, which is the defect the BODIES in
     * this world were rebuilt to fix. */
    const COUNT = 4200;
    const pos = new Float32Array(COUNT * 3);
    const col = new Float32Array(COUNT * 3);
    const mag = new Float32Array(COUNT);
    let s = 0x10de57 >>> 0;
    const rnd = () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
    const c = new THREE.Color();
    for (let i = 0; i < COUNT; i++) {
      const u = rnd() * 2 - 1;
      const th = rnd() * Math.PI * 2;
      const r = Math.sqrt(Math.max(0, 1 - u * u));
      pos[i * 3] = Math.cos(th) * r * STAR_SHELL;
      pos[i * 3 + 1] = u * STAR_SHELL;
      pos[i * 3 + 2] = Math.sin(th) * r * STAR_SHELL;
      /* CUBE of a uniform roll. A plain roll puts half the field over 0.5,
       * which is the flat sky this replaces; a FOURTH power was the first
       * try and took it too far the other way - measured, it left a sky you
       * could count the stars in. A cube is the spread that reads as a sky:
       * a handful bright enough to name, a great many faint. */
      const m0 = rnd();
      const m = m0 * m0 * m0;
      mag[i] = m;
      const t = rnd();
      c.setHSL(t < 0.68 ? 0.58 : 0.09, (0.30 + rnd() * 0.4) * (0.18 + 0.82 * m), 0.58 + rnd() * 0.42);
      col[i * 3] = c.r; col[i * 3 + 1] = c.g; col[i * 3 + 2] = c.b;
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
    geo.setAttribute('aMag', new THREE.BufferAttribute(mag, 1));
    const stars = new THREE.Points(geo, keep(new THREE.ShaderMaterial({
      name: 'yard.stars',
      uniforms: { uScale: { value: 340 } },
      vertexShader: `
        attribute float aMag;
        varying vec3 vCol;
        varying float vMag;
        uniform float uScale;
        void main() {
          vCol = color;
          vMag = aMag;
          vec4 mv = modelViewMatrix * vec4(position, 1.0);
          /* Size attenuation by hand, same rule PointsMaterial uses, so the
             field keeps its apparent density as the camera moves down the
             hall. 2.2 px floor: under that a point disappears entirely rather
             than becoming faint, which is what makes a sky look moth-eaten. */
          gl_PointSize = max(2.2, uScale * (0.45 + 1.9 * aMag) / -mv.z);
          gl_Position = projectionMatrix * mv;
        }`,
      fragmentShader: `
        varying vec3 vCol;
        varying float vMag;
        void main() {
          /* Round, and soft to the edge. gl_PointCoord is 0..1 across the
             sprite; the falloff never reaches a hard boundary, so a star
             antialiases instead of stamping a square. */
          float d = length(gl_PointCoord - vec2(0.5));
          float core = exp(-d * d * 26.0);
          float halo = exp(-d * 7.0) * 0.16;
          float a = (core + halo) * (0.30 + 1.9 * vMag);
          if (a < 0.004) discard;
          /* Alpha 1.0, brightness in the COLOUR. THREE.AdditiveBlending is
             (SRC_ALPHA, ONE), so writing the same falloff into both channels
             multiplies it in twice and the whole field goes out - measured,
             the first version of this shader left a sky with about a dozen
             visible stars in it. */
          gl_FragColor = vec4(vCol * a, 1.0);
        }`,
      vertexColors: true,
      transparent: true,
      depthWrite: false,
      fog: false,
      blending: THREE.AdditiveBlending,
    })));
    stars.renderOrder = -1000;
    stars.frustumCulled = false;
    gr.add(stars);

    /* ── The bodies ───────────────────────────────────────────────────────
     * THE SAME FIVE BODIES, THE SAME SHADERS, THE SAME STAR - as `space`.
     *
     * They used to be three invented spheres with hand-painted canvas skins.
     * `YardPlan.BODIES`' own note carries the measured bearing table showing
     * what that cost; the short version is that the sky changed identity,
     * direction and count the moment the player crossed the mouth.
     *
     * `space/BodyShaders.js` already draws every one of these analytically
     * from its own descriptor, with a real terminator against `STAR_DIRECTION`,
     * a fresnel limb halo and a self-shadowing ring. Calling it from here is
     * cheaper than the canvases it replaces (no 512 x 256 bakes at boot, no
     * textures to free) and it is the only thing that makes the two skies the
     * same sky rather than two skies that agree by hand.
     *
     * Each body is a group at `plan.scale` - the uniform contraction that puts
     * the true position on the void shell AND gives the true angular size, one
     * number doing both jobs. Inside it the mesh scales are the body's REAL
     * radii, exactly as `SpaceWorld._buildBodies` writes them, so the two
     * builders differ only in whether the placement is per-frame.
     *
     * Render order is by true distance: the furthest body paints first. The
     * opaque surfaces have the depth test OFF (`BACKDROP_STATE`) so order is
     * the only thing sorting them, and everything the yard itself draws is at
     * renderOrder 0 and paints over all of it.
     */
    const sphere = new THREE.SphereGeometry(1, 48, 32);
    const star = new THREE.Vector3(STAR_DIRECTION[0], STAR_DIRECTION[1], STAR_DIRECTION[2]);
    /* Bands of 4 so a body can sort its own parts - surface, ring, air, corona
     * - inside its own slot. Same shape as `Backdrop`'s `SLOTS`, and the whole
     * set stays inside [-960, -900) which is below the starfield's -1000 only
     * in the sense that the starfield is further out: -1000 paints first. */
    const ORDER0 = -960;
    for (const plan of BODIES) {
      const body = plan.body;
      const g = new THREE.Group();
      g.name = `yard:void:${body.id}`;
      /* The contraction. Position and scale are the SAME factor, which is what
       * makes the drawn angular radius equal the true one. */
      g.position.set(plan.x, plan.y, plan.z);
      g.scale.setScalar(plan.scale);
      /* Furthest first: rank 0 is nearest, so it takes the highest band. */
      const base = ORDER0 + (BODIES.length - 1 - plan.rank) * 4;
      gr.add(g);

      const axisNode = new THREE.Object3D();
      _bodyAxis.set(body.axis[0], body.axis[1], body.axis[2]).normalize();
      axisNode.quaternion.setFromUnitVectors(_UP_Y, _bodyAxis);
      g.add(axisNode);

      const surface = new THREE.Mesh(sphere, keep(makeBodyMaterial(body, star)));
      surface.name = `yard:void:${body.id}:surface`;
      surface.scale.setScalar(body.radius);
      surface.renderOrder = base;
      surface.frustumCulled = false;
      surface.castShadow = surface.receiveShadow = false;
      axisNode.add(surface);
      this._voidTime.push(surface.material);

      if (body.ring) {
        const ring = new THREE.Mesh(
          new THREE.RingGeometry(body.ring.inner, body.ring.outer, 128, 1),
          keep(makeRingMaterial(body, star))
        );
        ring.name = `yard:void:${body.id}:ring`;
        ring.rotation.x = -Math.PI / 2;
        ring.scale.setScalar(body.radius);
        ring.renderOrder = base + 1;
        ring.frustumCulled = false;
        axisNode.add(ring);
        /* The ring's occlusion and shadow rays are cast in the RENDER frame,
         * so they are handed the PROXY centre and PROXY radius - which here are
         * constants, because nothing in this world moves the sky. */
        const u = ring.material.uniforms;
        if (u.uPlanetCenter) u.uPlanetCenter.value.set(plan.x, plan.y, plan.z);
        if (u.uPlanetRadius) u.uPlanetRadius.value = plan.r;
      }

      if (body.atmosphere > body.radius && (body.look.atmoStrength ?? 0) > 0) {
        const air = new THREE.Mesh(sphere, keep(makeAtmosphereMaterial(body, star)));
        air.name = `yard:void:${body.id}:air`;
        air.scale.setScalar(body.radius * (body.look.haloScale ?? 1.05));
        air.renderOrder = base + 2;
        air.frustumCulled = false;
        g.add(air);
      }

      if (body.kind === 'star') {
        const corona = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), keep(makeCoronaMaterial(body)));
        corona.name = `yard:void:${body.id}:corona`;
        corona.scale.setScalar(body.radius * (body.look.coronaScale ?? 3));
        corona.renderOrder = base + 3;
        corona.frustumCulled = false;
        g.add(corona);
        this._voidCorona = corona;
        this._voidTime.push(corona.material);
      }
    }
  }

  /* ---------------------------------------------------------------- */
  /* The assembly floor                                                */
  /* ---------------------------------------------------------------- */

  /**
   * The floor, its markings and the datum.
   *
   * Five slabs, not one, because the service trench is a slot cut through the
   * middle of it and a single box would fill the slot back in. The slot's own
   * sides ARE the slab faces — no separate trench walls, no chance of the two
   * disagreeing by a centimetre and leaving a crack the capsule can catch on.
   */
  _buildFloor() {
    const put = this._put;
    const slab = (x0, x1, z0, z1, key = 'floor') => {
      const w = x1 - x0, d = z1 - z0;
      const cx = (x0 + x1) / 2, cz = (z0 + z1) / 2;
      const g = boxGeo(w, FLOOR_T, d, 8);
      put(key, g, cx, DECK_Y - FLOOR_T / 2, cz);
      this._solid(cx, DECK_Y - FLOOR_T / 2, cz, w / 2, FLOOR_T / 2, d / 2);
    };

    // Port and starboard, full length.
    slab(-YARD_X, -TRENCH_HW, YARD_Z0, YARD_Z1);
    slab(TRENCH_HW, YARD_X, YARD_Z0, YARD_Z1);
    // The centre strip, wherever the trench does not run.
    slab(-TRENCH_HW, TRENCH_HW, TRENCH_RUNS[0][1], YARD_Z1);       // +14 .. +58
    slab(-TRENCH_HW, TRENCH_HW, -DATUM_ISLAND_HZ, DATUM_ISLAND_HZ); // the datum island
    slab(-TRENCH_HW, TRENCH_HW, YARD_Z0, TRENCH_RUNS[1][0]);       // -104 .. -70

    /* The apron. A poured concrete pad at the gateway end, laid over the plate
     * — the one non-metal ground in the yard, and the thing that tells a player
     * stepping out of the gateway that they have arrived somewhere with a
     * threshold rather than onto more of the same deck. Polygon-offset via the
     * `apron` material's own depth bias would be wrong here (it is a different
     * material, not an overlay), so it is a real 0.12 m pad with a kerb. */
    /* `APRON_Z` is 37 and not the 30 first drafted, and the seven metres are
     * arithmetic rather than composition — see `YardPlan.APRON_Z` and
     * `YardPlan.OFFICE` for the two halves of it. */
    put('apron', boxGeo(YARD_X * 2 - 8, 0.12, YARD_Z1 - APRON_Z, 6),
      0, DECK_Y + 0.06, (APRON_Z + YARD_Z1) / 2);
    this._solid(0, DECK_Y + 0.06, (APRON_Z + YARD_Z1) / 2,
      YARD_X - 4, 0.06, (YARD_Z1 - APRON_Z) / 2);
    put('hazard', boxGeo(YARD_X * 2 - 8, 0.14, 0.5, 1), 0, DECK_Y + 0.07, APRON_Z);

    /* ── Two grounds, so every marking is struck twice ───────────────────
     *
     * The apron is a REAL 0.12 m pad, not an overlay, and every marking in
     * this method is authored at deck level. Struck once, the keel line, the
     * chalk grid and the chainage ticks are 55-90 mm INSIDE the concrete for
     * the 27 m between the kerb and the gateway — which is precisely the
     * stretch the player is standing on when they arrive, looking down the
     * line this world is arranged around. Measured before the fix: apron top
     * 0.120, keel paint top 0.030, brass top 0.065.
     *
     * So each marking is cut at the kerb and the apron half is re-struck on
     * top of the pad, in `paintApron` rather than `paint`, because the paint
     * bucket samples the DECK's maps and would print chequer plate onto
     * concrete. `mark` and `inlay` below take the z range and pick the ground
     * for themselves, so a marking cannot be authored on one ground only. */
    const APRON_TOP = DECK_Y + 0.12;
    /** Ground top and paint bucket at a given z. */
    const ground = (z) => (z >= APRON_Z ? [APRON_TOP, 'paintApron'] : [DECK_Y, 'paint']);
    /** A marking running along z, cut at the kerb and re-struck on each side. */
    const runZ = (w, x, z0, z1, lift, colour, tile) => {
      for (const [a, b] of [[z0, Math.min(z1, APRON_Z)], [Math.max(z0, APRON_Z), z1]]) {
        if (b - a < 0.05) continue;
        const [top, key] = ground((a + b) / 2);
        // The pad is 4 m narrower than the floor: outboard of its kerb there
        // is no apron to strike a line on, only deck 120 mm below.
        if (key === 'paintApron' && Math.abs(x) > YARD_X - 4.5) continue;
        paintQuad(put, w, b - a, x, top + lift, (a + b) / 2, 0, colour, tile, key);
      }
    };

    /* ── The keel line ───────────────────────────────────────────────────
     * The yard's only piece of wayfinding, and the first thing framed by the
     * apron mouth: a 4 m chalk-and-brass strip from the gateway to the blast
     * door with the berths staggered either side of it. Done as vertex-
     * coloured quads in the paint buckets, so the strip, the chalk grid and
     * the four bay outlines are one draw call per ground between them. */
    runZ(KEEL_HW * 2, 0, YARD_Z0 + 1, YARD_Z1 - 1, 0.03, 0x7fd8ef, 4);
    // Brass inlay strips down both edges of the chalk, on both grounds.
    for (const s of [-1, 1]) {
      for (const [a, b] of [[YARD_Z0 + 1, APRON_Z], [APRON_Z, YARD_Z1 - 1]]) {
        const [top] = ground((a + b) / 2);
        put('emCyan', boxGeo(0.1, 0.04, b - a, 1),
          s * (KEEL_HW - 0.12), top + 0.045, (a + b) / 2);
      }
    }
    // Chainage ticks every bay, so the yard reads at a glance as measured.
    for (let z = YARD_Z0 + BAY; z < YARD_Z1; z += BAY) {
      const [top, key] = ground(z);
      for (const s of [-1, 1]) {
        paintQuad(put, 1.6, 0.14, s * (KEEL_HW + 0.9), top + 0.03, z, 0, 0xd8e4f0, 2, key);
      }
    }

    /* The setting-out grid the surveyors left, still chalked on the slab at
     * the bay pitch. Faint, broken and never repainted — the yard works off
     * it and nobody has re-struck a line since commissioning. */
    for (let x = -YARD_X + BAY; x < YARD_X; x += BAY) {
      if (Math.abs(x) < KEEL_HW + 1) continue;
      runZ(0.1, x, YARD_Z0 + 2, YARD_Z1 - 2, 0.028, 0x93a3b4, 4);
    }
    for (let z = YARD_Z0 + BAY; z < YARD_Z1; z += BAY) {
      const [top, key] = ground(z);
      /* The apron pad is 4 m narrower than the floor either side, so a
       * transverse line struck at the apron's own height has to stop at the
       * kerb — the full-width version overhangs by 2 m at each end and floats
       * 120 mm over the deck out there. */
      paintQuad(put, (z >= APRON_Z ? (YARD_X - 4) * 2 - 1 : YARD_X * 2 - 4), 0.1,
        0, top + 0.028, z, 0, 0x93a3b4, 4, key);
    }

    this._buildDatum();
  }

  /**
   * The surveyors' brass benchmark, salvaged wholesale from `SurveyWorld`.
   *
   * One of the four things worth keeping out of the placeholder, and the
   * single object in this world that predates it. It is bolted FLUSH to the
   * slab, not stood on a pillar — the pillar was for a site with no floor yet.
   * The trench was cut AROUND it (`DATUM_ISLAND_HZ`), which is the detail that
   * makes the claim "every measurement in the yard comes off this plate" a
   * thing the geometry actually says.
   *
   * No collider: a 60 mm rim is not grabbable and is well under `stepHeight`,
   * and a collider on it would be a thing to trip over at the exact centre of
   * the only route through the world.
   */
  _buildDatum() {
    const put = this._put;
    const ring = new THREE.CylinderGeometry(1.5, 1.5, 0.06, 28);
    put('emAmber', ring, 0, DECK_Y + 0.03, 0);
    const plate = new THREE.CylinderGeometry(1.24, 1.24, 0.08, 28);
    put('hazard', plate, 0, DECK_Y + 0.04, 0);
    // The benchmark itself, and the four setting-out arms struck off it.
    put('emAmber', new THREE.CylinderGeometry(0.16, 0.16, 0.1, 12), 0, DECK_Y + 0.06, 0);
    for (let i = 0; i < 4; i++) {
      const a = (i * Math.PI) / 2;
      paintQuad(put, 0.12, 7.2, Math.sin(a) * 3.9, DECK_Y + 0.032, Math.cos(a) * 3.9,
        a, 0xd8a33a, 2);
    }
    /* The plate's own legend, read from ABOVE — the one sign in the yard that
     * lies on the floor. `signBoard` builds an upright board, so this is a
     * bare quad laid flat rather than a board rotated after the fact: the
     * helper also emits a backer, and a backer under a floor decal is a slab
     * buried in the slab. */
    const legend = yardSignUV(new THREE.PlaneGeometry(2.6, 1.1), YARD_SIGN.datum);
    legend.rotateX(-Math.PI / 2);
    put('signs', legend, 0, DECK_Y + 0.055, -2.6);
  }

  /* ---------------------------------------------------------------- */
  /* The shed                                                          */
  /* ---------------------------------------------------------------- */

  /**
   * Four walls, the portal frames that hold them up, and a collided roof.
   *
   * The player never stands outside, so each wall is drawn as its INNER
   * lining — one inward-facing plane — plus the ribs, string courses and
   * clerestory that give it structure, with a single box collider carrying the
   * thickness. Drawing the wall as a closed box instead would spend six faces
   * to show one, and five of them would be back-faced and culled.
   */
  _buildShell() {
    const put = this._put;

    const wall = (axis, fixed, a, b, facing) => {
      const len = b - a;
      const q = new THREE.PlaneGeometry(len, ROOF_Y);
      uvScale(q, len / 8, ROOF_Y / 8);
      const cx = axis === 'x' ? (a + b) / 2 : fixed;
      const cz = axis === 'z' ? (a + b) / 2 : fixed;
      const yaw = axis === 'x' ? (facing > 0 ? 0 : Math.PI) : (facing > 0 ? Math.PI / 2 : -Math.PI / 2);
      put('plate', q, cx, ROOF_Y / 2, cz, yaw);
      const hx = axis === 'x' ? len / 2 : WALL_T / 2;
      const hz = axis === 'z' ? len / 2 : WALL_T / 2;
      const ox = axis === 'z' ? fixed - facing * WALL_T / 2 : cx;
      const oz = axis === 'x' ? fixed - facing * WALL_T / 2 : cz;
      this._solid(ox, ROOF_Y / 2, oz, hx, ROOF_Y / 2, hz);
    };

    // Three linings and two corner returns. `facing` points into the shed.
    wall('x', YARD_Z1, -YARD_X, YARD_X, -1);   // apron end, faces -Z
    wall('z', -YARD_X, YARD_Z0, YARD_Z1, 1);   // port, faces +X
    wall('z', YARD_X, YARD_Z0, YARD_Z1, -1);   // starboard, faces -X
    /* THE NORTH END IS A HOLE. What used to be one 172 m wall with a sealed
     * blast door in it is now two 4 m corner returns and 164 m of vacuum —
     * see `YardPlan.MOUTH_Z`. The returns are not cosmetic: the perimeter
     * catwalk, the crane runway and both string courses all die into them, and
     * without them the port and starboard runs end in mid-air. */
    wall('x', YARD_Z0, -YARD_X, -MOUTH_HW, 1);
    wall('x', YARD_Z0, MOUTH_HW, YARD_X, 1);

    /* Portal frames every 12 m: a stanchion up each side wall and the rafter
     * across. This is the shed's whole structural read and the reason the
     * walls are not two grey rectangles. Ribs are drawn only — they stand
     * 0.45 m proud of a wall that is already solid, and a collider on each
     * would be 28 boxes to stop the player brushing a column. */
    for (let z = YARD_Z0 + BAY / 2; z < YARD_Z1; z += BAY) {
      for (const s of [-1, 1]) {
        put('steel', boxGeo(0.9, ROOF_Y, 0.55, 4), s * (YARD_X - 0.45), ROOF_Y / 2, z);
        // Haunch bracket where the stanchion meets the rafter.
        put('steel', boxGeo(0.6, 2.6, 0.5, 2), s * (YARD_X - 1.6), ROOF_Y - 1.6, z, 0, 0, s * 0.55);
      }
      // Rafter: a lattice girder, drawn as a top and bottom boom plus web.
      const span = YARD_X * 2 - 1.8;
      put('steel', boxGeo(span, 0.42, 0.42, 4), 0, ROOF_Y - 0.3, z);
      put('steel', boxGeo(span, 0.42, 0.42, 4), 0, ROOF_Y - 1.9, z);
      for (let x = -span / 2 + 2; x < span / 2; x += 4) {
        put('steelDark', boxGeo(0.2, 2.1, 0.2, 1), x, ROOF_Y - 1.1, z, 0, 0, 0.52);
        put('steelDark', boxGeo(0.2, 2.1, 0.2, 1), x + 2, ROOF_Y - 1.1, z, 0, 0, -0.52);
      }
      // High-bay strip run along the rafter. This is what actually lights the
      // shed's upper volume; see `_buildLights` for why there are no point
      // lights up here.
      put('emAmber', boxGeo(span - 6, 0.16, 0.3, 1), 0, ROOF_Y - 2.2, z);
    }

    /* Bolted string courses at 8 m and 16 m, running the full perimeter.
     *
     * FOUR MEMBERS PER COURSE, ONE PER WALL, each inset so its inner face
     * lands INSIDE the lining rather than coplanar with it. This is the
     * full-plan-box family's fourth occurrence waiting to happen — a course
     * authored as one box the size of the whole plan is 251 of 407 z-fighting
     * hits in the medieval run and a sealed atrium — and the fixed shape is
     * `MedievalWorld.js:6862-6884`. Buried, never coplanar, identical to look
     * at from the floor. */
    for (const y of [8.4, 16.4]) {
      for (const s of [-1, 1]) {
        put('plate', boxGeo(0.5, 0.7, YARD_Z1 - YARD_Z0 - 1.2, 3),
          s * (YARD_X - 0.26), y, (YARD_Z0 + YARD_Z1) / 2);
      }
      // South end: one member the full width. North end: TWO, one per corner
      // return, because there is no wall between them any more.
      put('plate', boxGeo(YARD_X * 2 - 1.2, 0.7, 0.5, 3), 0, y, YARD_Z1 - 0.26);
      for (const s of [-1, 1]) {
        put('plate', boxGeo(YARD_X - MOUTH_HW, 0.7, 0.5, 1),
          s * (YARD_X + MOUTH_HW) / 2, y, YARD_Z0 + 0.26);
      }
    }

    /* Clerestory. A glazed band under the eaves down both side walls: the one
     * source of daylight in the shed, and the reason the upper volume is not
     * a black lid over a lit floor. Drawn, never collided — it is 22 m up
     * behind a solid wall collider. */
    for (const s of [-1, 1]) {
      const q = new THREE.PlaneGeometry(YARD_Z1 - YARD_Z0 - 4, 3.2);
      put('glass', q, s * (YARD_X - 0.1), 21.4, (YARD_Z0 + YARD_Z1) / 2,
        s > 0 ? -Math.PI / 2 : Math.PI / 2);
      put('steelDark', boxGeo(0.3, 0.25, YARD_Z1 - YARD_Z0 - 4, 2), s * (YARD_X - 0.2), 19.7, (YARD_Z0 + YARD_Z1) / 2);
      put('steelDark', boxGeo(0.3, 0.25, YARD_Z1 - YARD_Z0 - 4, 2), s * (YARD_X - 0.2), 23.1, (YARD_Z0 + YARD_Z1) / 2);
    }

    /* ── The roof, and THE LAUNCH WELL ───────────────────────────────────
     *
     * The plate now stops at `ROOF_CUT_Z`. North of that line the bay is open
     * to the sky: the portal frames, the rafters, the purlins and the crane
     * runway all carry on, but there is nothing on top of them and what you
     * see between them is the starfield.
     *
     * This is the second half of the answer to "it looks overall just like a
     * big dark room". A wall with a hole in it at the far end is still a room;
     * a room whose ceiling runs out over the last third of it is a WELL, and
     * the moment the lid ends — walking north up the keel line, at z -34 — is
     * the moment the place stops being interior. It is also the only thing
     * that makes the mouth read as tall: from the apron the aperture subtends
     * about 9 degrees, and the open truss above it doubles that.
     *
     * ── The collider stops with the plate, and that is deliberate ─────────
     * `mounts/FlightCeiling.flightCeilingAt` returns null for every world that
     * is not the station, so a mount under an uncollided roof climbs to
     * `bounds.max.y`. That was the whole argument for collidng this plate and
     * it still holds — over the SHED. Over the launch well it inverts: a
     * summoned eagle that cannot leave a bay which is open to space is an
     * invisible lid, and `bounds.max.y` at 34 m is eight metres over the truss
     * and is the clamp that catches it. So the collider covers the plate and
     * the well is open, which is what both halves of the geometry say.
     */
    const roofLen = YARD_Z1 - ROOF_CUT_Z;
    const roofQ = new THREE.PlaneGeometry(YARD_X * 2, roofLen);
    roofQ.rotateX(Math.PI / 2);
    uvScale(roofQ, (YARD_X * 2) / 10, roofLen / 10);
    put('roof', roofQ, 0, ROOF_Y, (ROOF_CUT_Z + YARD_Z1) / 2);
    this._solid(0, ROOF_Y + 0.4, (ROOF_CUT_Z + YARD_Z1) / 2, YARD_X, 0.4, roofLen / 2);
    // The cut edge is a real fascia beam, not a torn plate.
    put('steel', boxGeo(YARD_X * 2, 1.1, 0.9, 5), 0, ROOF_Y - 0.55, ROOF_CUT_Z);
    put('emAmber', boxGeo(YARD_X * 2 - 4, 0.12, 0.3, 1), 0, ROOF_Y - 1.15, ROOF_CUT_Z - 0.2);

    // Section numbers stencilled where a wall meets a berth, so the yard can
    // be talked about. Two-sided is pointless against a wall; one quad each.
    signBoard(this._put, YARD_SIGN.yard, 12, 3.4, 0, 13.5, YARD_Z1 - 0.4, Math.PI, { accent: 'emAmber' });
    signBoard(this._put, YARD_SIGN.gateway, 6, 1.9, 22, 6.4, YARD_Z1 - 0.4, Math.PI);
    signBoard(this._put, YARD_SIGN.gantry, 4.4, 1.5, -YARD_X + 0.4, 5.6, 46, Math.PI / 2);
  }

  /* ---------------------------------------------------------------- */
  /* The piers                                                         */
  /* ---------------------------------------------------------------- */

  /**
   * Five decks running out of the mouth into hard vacuum, with the three
   * flyable hulls at the ends of three of them.
   *
   * ── The shape, and why it is a spine and a head rather than a slab ────────
   * A pier wide enough to hold a 28 m ore tender is 28 m wide, and 28 m of
   * deck under your feet does not feel like anything. What the brief asks for
   * — "walking a pier should feel like walking a gangway over nothing" — is a
   * NARROW walk with a long fall either side of it, and what a ship needs is a
   * wide pad. So each pier is both: a 6.8 m spine with rails and a lit edge,
   * and a pad at the far end big enough to work a hull on. The transition from
   * one to the other, halfway out, is the moment the pier stops being a bridge
   * and becomes a berth.
   *
   * ── Every pier is railed, and that is not timidity ───────────────────────
   * There is no ground out here. A body that leaves a pier falls until
   * `Unstuck` notices it is below `bounds.min.y` and puts it back, which works
   * and is not an edge treatment. `railRun` glazes its infill, so the rail is
   * something you see the void THROUGH rather than a fence across it, and the
   * 1.15 m mouth balustrade in `_buildMouth` closes the 164 m of threshold
   * between the piers for the same reason.
   *
   * ── Colliders ─────────────────────────────────────────────────────────────
   * Deck and rails only. The trusses, the mooring bollards, the umbilical
   * masts and the edge lighting are drawn and not collided: nothing out here
   * is climbed, and every extra box on a pier is another thing
   * `dock-piers.test.mjs` has to prove a body cannot get stuck on.
   */
  _buildPiers() {
    const put = this._put;
    const solid = (cx, cy, cz, hx, hy, hz) => this._solid(cx, cy, cz, hx, hy, hz);

    /** One rectangle of pier deck: drawn, collided, soffit, lit edge.
     *
     * `floor` and NOT `grate`, and the reason is measured rather than
     * aesthetic. `M.grate` is metalness 0.62 with `envMapIntensity` 1.5, which
     * is right for a catwalk in a lit shed: most of what it returns is the
     * environment. The yard's probe is `'space'` — a starfield — so out here
     * that material returns almost nothing and the first pier rendered as a
     * black strip with two glowing edges on it, at a framing mean of 22 while
     * the analytic deck probe insisted it was carrying 0.66 lux. Both were
     * true: the light was arriving and the surface had no diffuse term to
     * answer with. `M.floor` is metalness 0.10 / roughness 0.88, so what a
     * pier lamp puts on it comes back. */
    const slab = (cx, cz, hx, hz) => {
      put('floor', boxGeo(hx * 2, 0.22, hz * 2, 2.2), cx, DECK_Y - 0.11, cz);
      this._solid(cx, DECK_Y - 0.11, cz, hx, 0.11, hz);
      // The structural depth under it. Drawn only — you can only ever see it
      // from another pier, which is exactly why it has to be there.
      put('steelDark', boxGeo(hx * 2 - 0.8, PIER_T, hz * 2 - 0.8, 3),
        cx, DECK_Y - 0.22 - PIER_T / 2, cz);
    };

    /** The lit edge bead that makes a pier readable from 240 m. */
    const edgeZ = (x, z0, z1) => put('emPier', boxGeo(0.22, 0.07, z1 - z0, 1), x, DECK_Y + 0.035, (z0 + z1) / 2);
    const edgeX = (z, x0, x1) => put('emPier', boxGeo(x1 - x0, 0.07, 0.22, 1), (x0 + x1) / 2, DECK_Y + 0.035, z);

    for (const p of PIERS) {
      const pad = pierPad(p);
      const spineZ1 = pad.z0;                 // where the spine meets the pad
      const cell = p.dock ? YARD_SIGN.launches : YARD_SIGN.gateway;

      /* ── The spine ────────────────────────────────────────────────────── */
      slab(p.x, (MOUTH_Z + spineZ1) / 2, PIER_HW, (MOUTH_Z - spineZ1) / 2);
      /* Transverse chainage bars every 6 m. Two parallel edge beads with
       * nothing between them give a walkway no sense of travel at all — the
       * pier reads the same at 10 m out as at 60. These are what tick past. */
      for (let z = MOUTH_Z - 6; z > spineZ1 + 1; z -= 6) {
        put('emPier', boxGeo(PIER_HW * 2 - 1.2, 0.06, 0.14, 1), p.x, DECK_Y + 0.03, z);
        put('hazard', boxGeo(PIER_HW * 2 - 0.4, 0.05, 0.5, 1), p.x, DECK_Y + 0.025, z - 0.5);
      }
      for (const s of [-1, 1]) {
        edgeZ(p.x + s * (PIER_HW - 0.16), spineZ1, MOUTH_Z);
        railRun(put, solid, {
          axis: 'z', a: spineZ1, b: MOUTH_Z, fixed: p.x + s * PIER_HW,
          y: DECK_Y, facing: -s, accent: 'emCyan',
        });
      }

      /* The truss under the spine. Two chords, a bottom boom and a Warren web
       * — 4.4 m deep, which is what a 46 m cantilever off a bay lip would
       * actually need and, more usefully, is enough that the pier has a
       * visible thickness when you look along the mouth from the gantry. */
      for (const s of [-1, 1]) {
        put('steel', boxGeo(0.34, 0.34, MOUTH_Z - spineZ1, 3),
          p.x + s * (PIER_HW - 0.3), DECK_Y - 4.4, (MOUTH_Z + spineZ1) / 2);
      }
      for (let z = spineZ1 + 2; z < MOUTH_Z; z += 4.2) {
        for (const s of [-1, 1]) {
          put('steelDark', boxGeo(0.16, 5.6, 0.16, 1), p.x + s * (PIER_HW - 0.3), DECK_Y - 2.5, z, 0, 0, 0.6);
        }
        put('steelDark', boxGeo(PIER_HW * 2 - 0.6, 0.16, 0.16, 1), p.x, DECK_Y - 4.4, z);
      }

      /* ── The head pad ─────────────────────────────────────────────────── */
      slab(p.x, pad.cz, p.hw, p.hd);
      edgeX(pad.z1 + 0.16, p.x - p.hw + 0.2, p.x + p.hw - 0.2);
      for (const s of [-1, 1]) {
        edgeZ(p.x + s * (p.hw - 0.16), pad.z1, pad.z0);
      }
      // Deeper truss under the pad, and four legs that read as the thing the
      // whole pier is cantilevered off nothing by.
      put('steelDark', boxGeo(p.hw * 1.6, 3.2, p.hd * 1.6, 4), p.x, DECK_Y - 3.4, pad.cz);
      for (const sx of [-1, 1]) {
        for (const sz of [-1, 1]) {
          put('steel', boxGeo(0.5, 7.0, 0.5, 3),
            p.x + sx * (p.hw - 1.4), DECK_Y - 3.6, pad.cz + sz * (p.hd - 1.4), 0, 0, sx * 0.16);
        }
      }

      /* Rails round the pad, with the one gap the spine arrives through. The
       * rule is the yard's rule everywhere else: a rail with nothing arriving
       * at it is a fall with nothing in front of it, and a rail across
       * something that does arrive is a walkway that ends at a fence. */
      railRun(put, solid, { axis: 'x', a: p.x - p.hw, b: p.x + p.hw, fixed: pad.z1, y: DECK_Y, facing: -1, accent: 'emCyan' });
      railRun(put, solid, {
        axis: 'x', a: p.x - p.hw, b: p.x + p.hw, fixed: pad.z0, y: DECK_Y, facing: 1, accent: 'emCyan',
        gaps: [[p.x - PIER_GATE_HW, p.x + PIER_GATE_HW]],
      });
      for (const s of [-1, 1]) {
        railRun(put, solid, { axis: 'z', a: pad.z1, b: pad.z0, fixed: p.x + s * p.hw, y: DECK_Y, facing: -s, accent: 'emCyan' });
      }

      /* ── Lighting the walk ────────────────────────────────────────────── */
      /* Spine lamps every 8.5 m, alternating sides; pad lamps at four stations
       * down each edge. Both pitches are the answer to a measurement rather
       * than a look: at 13 m on the spine and two stations per pad edge the
       * analytic deck probe read a MINIMUM of 0.042 against an assembly floor
       * that reads 0.099, i.e. there were stretches of pier darker than the
       * darkest square of the shed — and unlike the shed, a dark pier has no
       * lit wall behind it to be a silhouette against. See
       * `dock-light.test.mjs`'s pier grid for the numbers after. */
      let alt = 1;
      for (let z = MOUTH_Z - 4.5; z > spineZ1 + 1.5; z -= 8.5, alt = -alt) {
        this._pierLamp(p.x + alt * (PIER_HW - 0.5), z, alt > 0 ? -Math.PI / 2 : Math.PI / 2);
      }
      /* THREE stations per pad edge, not four, and it is a rig constraint
       * rather than a lighting one. `dock-interiors` guards the number of
       * sources reaching any one probe — twelve of them get a slot and the
       * rest are dropped, so a dense cluster is a lamp that visibly goes out
       * as the camera moves. Four per edge plus two flank brackets, a berth
       * mast and the nearest spine lamps put 18 sources inside 20 m of the
       * Dray against a guard of 16. Three per edge with 4 m more reach each
       * carries the same deck. */
      for (const sx of [-1, 1]) {
        for (const t of [-0.68, 0.68]) {
          this._pierLamp(p.x + sx * (p.hw - 0.9), pad.cz + t * p.hd, sx > 0 ? -Math.PI / 2 : Math.PI / 2);
        }
      }
      /* ...and one at each END of the pad, on the centreline.
       *
       * The corners of a pad are the furthest deck in this world from any
       * fitting — measured, the far centreline of Pier Three read 0.061
       * against a 0.12 floor, because the edge lamps sit at 0.62 of the
       * half-depth and the pad is 36 m long. `p.hd - 1.5` is 1.5 m inside the
       * rail at each end, which on every one of the five is also clear of the
       * hull: the longest ship here is 28 m in a 36 m pad, so there is at
       * least 2 m of open deck off her bow and off her stern. */
      /* Offset from the centreline by a spine half-width plus 1.6 m, NOT on
       * it. A 4.9 m post standing in the middle of the one lane a player walks
       * up is something they walk straight through — this world's own rule
       * about the trench cable tray, seen from the other side — and it is also
       * dead centre in every framing looking up the pier. */
      for (const t of [-1, 1]) {
        this._pierLamp(p.x + t * (PIER_HW + 1.6), pad.cz + t * (p.hd - 1.5), t > 0 ? 0 : Math.PI);
      }

      /* ── Mooring, umbilicals and the pier's own name ──────────────────── */
      for (const sx of [-1, 1]) {
        for (const t of [-0.6, 0, 0.6]) {
          const bz = pad.cz + t * p.hd * 0.8;
          put('steelDark', new THREE.CylinderGeometry(0.26, 0.34, 0.9, 8), p.x + sx * (p.hw - 2.2), 0.45, bz);
          put('steel', new THREE.TorusGeometry(0.3, 0.06, 5, 12), p.x + sx * (p.hw - 2.2), 0.92, bz, 0, Math.PI / 2);
        }
        // Umbilical mast: power, gas and data to whatever is on the cradle.
        const mx = p.x + sx * (p.hw - 3.4);
        put('steel', boxGeo(0.5, 5.4, 0.5, 3), mx, 2.7, pad.cz + p.hd * 0.3);
        put('steelDark', boxGeo(0.4, 0.4, 3.0, 2), mx, 5.0, pad.cz + p.hd * 0.3 - 1.5);
        put('emGreen', boxGeo(0.3, 0.3, 0.12, 1), mx, 4.2, pad.cz + p.hd * 0.3 - 3.0);
        for (let k = 0; k < 3; k++) {
          put('steelDark', new THREE.CylinderGeometry(0.09, 0.09, 4.2, 6).rotateX(Math.PI / 2),
            mx + (k - 1) * 0.16, 4.6, pad.cz + p.hd * 0.3 - 3.1);
        }
      }

      // The number, stencilled on the deck at the pier root where a player
      // steps onto it, and again on a board over the gate.
      paintQuad(put, PIER_HW * 1.5, 4.4, p.x, DECK_Y + 0.032, MOUTH_Z - 5.5, 0, 0xd8e4f0, 2);
      signBoard(put, cell, 5.2, 1.8, p.x, 4.6, MOUTH_Z - 1.6, Math.PI,
        { accent: p.dock ? 'emLaunch' : 'emCyan', twoSided: true });

      if (p.dock) this._buildDockPier(p, pad);
      else if (p.works) this._buildWorksPier(p, pad);
    }
  }

  /**
   * The section jigs on the vacated berths — see `YardPlan.SECTIONS`.
   *
   * A hull section is a ribbed drum in a saddle jig with ring frames standing
   * off it and staging round the lot. This is the middle scale the bay lost
   * when three ships moved out to the piers, and it is drawn in the yard's own
   * batch so it costs no extra draw call.
   *
   * ── What is collided, and what is not ─────────────────────────────────────
   * The jig cradle and the section drum, because both are things a body walks
   * into at chest height. The ring frames, the staging boards and the stencils
   * are not: a lattice of thin members collided individually is a dozen things
   * for the capsule to catch on in the middle of the bay, which is the
   * argument `_buildBerths` already makes about the cradle frames.
   */
  _buildSections() {
    const put = this._put;
    for (const s of SECTIONS) {
      const c = Math.cos(s.yaw), sn = Math.sin(s.yaw);
      /** Local (lx, lz) in the jig's own frame -> world. */
      const wx = (lx, lz) => s.x + lx * c + lz * sn;
      const wz = (lx, lz) => s.z - lx * sn + lz * c;

      // The jig: two saddle bearers on a base, with the section resting in them.
      put('steelDark', boxGeo(s.r * 2.4, 0.9, s.len + 2, 3), s.x, 0.45, s.z, s.yaw);
      this._solidRot(s.x, 0.45, s.z, s.r * 1.2, 0.45, (s.len + 2) / 2, s.yaw);
      for (const t of [-0.34, 0.34]) {
        put('steel', boxGeo(s.r * 2.2, 1.1, 1.0, 2), wx(0, t * s.len), 1.35, wz(0, t * s.len), s.yaw);
        put('hazard', boxGeo(s.r * 2.3, 0.08, 1.2, 1), wx(0, t * s.len), 1.94, wz(0, t * s.len), s.yaw);
      }

      /* The section. A drum on its side with a bolted string course at every
       * frame line, which is the shape the lore has claimed since drop one:
       * nothing bigger than a gateway arch has ever come through a gateway, so
       * every hull here arrived in pieces this size. */
      const cy = 1.9 + s.r;
      const drum = new THREE.CylinderGeometry(s.r, s.r, s.len, 16, 1, true).rotateX(Math.PI / 2);
      put('plate', drum, s.x, cy, s.z, s.yaw);
      this._solidRot(s.x, cy, s.z, s.r, s.r, s.len / 2, s.yaw);
      for (let i = 0; i <= s.frames; i++) {
        const lz = (i / s.frames - 0.5) * s.len;
        put('steel', new THREE.TorusGeometry(s.r + 0.06, 0.13, 6, 20),
          wx(0, lz), cy, wz(0, lz), s.yaw + Math.PI / 2, 0, 0);
      }
      // The open end, so it reads as a section and not as a tank.
      put('steelDark', new THREE.TorusGeometry(s.r - 0.35, 0.3, 6, 20),
        wx(0, s.len / 2), cy, wz(0, s.len / 2), s.yaw + Math.PI / 2, 0, 0);
      put('emAmber', boxGeo(1.1, 0.1, 0.1, 1), wx(s.r * 0.7, s.len / 2 + 0.2), cy + s.r * 0.5,
        wz(s.r * 0.7, s.len / 2 + 0.2), s.yaw);

      /* Ring frames standing off the section, waiting to be pinned to it, and
       * the staging the gang works off. */
      for (const t of [-1, 1]) {
        const lx = t * (s.r + 2.6);
        put('steel', new THREE.TorusGeometry(s.r + 0.2, 0.16, 6, 22),
          wx(lx, -s.len * 0.2), cy - 0.4, wz(lx, -s.len * 0.2), s.yaw + Math.PI / 2, 0, 0.12);
        put('steelDark', boxGeo(1.6, 0.16, 0.5, 1), wx(lx, -s.len * 0.2), 0.08, wz(lx, -s.len * 0.2), s.yaw);
        // Staging: a board run at chest height on trestles down the flank.
        put('crate', boxGeo(0.7, 0.09, s.len * 0.8, 2), wx(t * (s.r + 1.1), 0), 1.55, wz(t * (s.r + 1.1), 0), s.yaw);
        for (const q of [-0.3, 0.3]) {
          put('steelDark', boxGeo(0.1, 1.5, 0.1, 1),
            wx(t * (s.r + 1.1), q * s.len), 0.75, wz(t * (s.r + 1.1), q * s.len), s.yaw);
        }
      }
      signBoard(put, YARD_SIGN.gantry, 2.4, 0.9, wx(0, -s.len / 2 - 1.4), 2.4, wz(0, -s.len / 2 - 1.4),
        s.yaw + Math.PI, { accent: 'emCyan' });
    }
  }

  /**
   * A pier lamp: a real `PointLight` source, its head, and the post it is on.
   *
   * Hung at 4.6 m rather than the bay's 9 m, because out here there is no
   * ceiling to bounce off and no floor either side of the deck to catch the
   * spill — everything a pier lamp makes that misses the pier is gone. Low and
   * close is the only geometry that lights a 6.8 m walkway.
   *
   * ── The post is COLLIDED, unlike everything else out here ────────────────
   * The trusses, the bollards and the umbilical masts are drawn only, because
   * they are under the deck or against the rail and no body reaches them. A
   * lamp post stands ON the walkway at head height and there are fifty of
   * them; drawn and not collided, every one is a thing the player walks
   * straight through, which is this world's own rule about the trench cable
   * tray read from the other side. Fifty boxes on a 1,400 budget, all of them
   * against a rail rather than in a lane, and `dock-reach`'s pier march is
   * what proves they are not standing in the way.
   */
  _pierLamp(x, z, yaw) {
    const l = new THREE.PointLight(0xffcb96, 34, 40, 2.0);
    l.castShadow = false;
    l.position.set(x, 4.4, z);
    this._group.add(l);
    workLight(this._put, x, 4.75, z, yaw, { width: 1.3 });
    this._put('steel', boxGeo(0.24, 4.9, 0.24, 3), x, 2.45, z);
    this._solid(x, 2.45, z, 0.14, 2.45, 0.14);
    this._put('emAmber', boxGeo(0.3, 0.08, 0.3, 1), x, 0.12, z);
  }

  /**
   * BERTH ZERO — the empty one, and the reason coming home is a place.
   *
   * A vacant docking cradle with the launch portal standing on it, a landing
   * ring painted round it, four approach beacons and the keel line running
   * the whole way out to it from the apron 240 m away. The board over the
   * mouth has read LAUNCHES: 000 since the site was commissioned; this is the
   * berth the 001 comes back to.
   */
  _buildDockPier(p, pad) {
    const put = this._put;

    // The keel line, continued out of the bay and down the pier. This is the
    // one piece of wayfinding this world has ever had and it now ends
    // somewhere.
    paintQuad(put, KEEL_HW * 2, MOUTH_Z - pad.z1 - 2, 0, DECK_Y + 0.03,
      (MOUTH_Z + pad.z1 + 2) / 2, 0, 0x7fd8ef, 4);
    for (const s of [-1, 1]) {
      put('emPier', boxGeo(0.1, 0.05, MOUTH_Z - pad.z1 - 2, 1),
        s * (KEEL_HW - 0.12), DECK_Y + 0.05, (MOUTH_Z + pad.z1 + 2) / 2);
    }

    // The cradle itself: empty saddles, a landing ring, and hazard chevrons.
    const cz = PORTAL_SPACE_Z;
    for (let i = 0; i < 5; i++) {
      const z = cz - 8 + i * 4;
      put('steel', boxGeo(7.0, 0.5, 1.0, 2), 0, 0.25, z);
      put('hazard', boxGeo(7.4, 0.08, 1.2, 1), 0, 0.53, z);
    }
    const ring = new THREE.RingGeometry(9.2, 10.4, 56);
    ring.rotateX(-Math.PI / 2);
    put('emLaunch', ring, 0, DECK_Y + 0.04, cz);
    for (let i = 0; i < 12; i++) {
      const a = (i / 12) * Math.PI * 2;
      put('emLaunch', boxGeo(0.5, 0.06, 1.6, 1), Math.sin(a) * 11.6, DECK_Y + 0.04, cz + Math.cos(a) * 11.6, a);
    }

    /* Four approach beacons, and they are the only things in this world you
     * can see from the arrival point 240 m away without a lamp in front of
     * them: `emLaunch` is the one emissive family that does not grade off with
     * distance, for exactly this. */
    for (const sx of [-1, 1]) {
      for (const sz of [-1, 1]) {
        const bx = sx * (p.hw - 2.0), bz = pad.cz + sz * (p.hd - 2.0);
        put('steel', boxGeo(0.4, 4.2, 0.4, 3), bx, 2.1, bz);
        put('emLaunch', new THREE.CylinderGeometry(0.44, 0.44, 0.6, 10), bx, 4.4, bz);
      }
    }
    const beacon = new THREE.PointLight(0x9fd8ff, 26, 42, 2.0);
    beacon.castShadow = false;
    beacon.position.set(0, 6.0, cz);
    this._group.add(beacon);
  }

  /**
   * PIER FOUR — the works pier. No ship, and that is the point.
   *
   * Five piers all doing the same thing is a comb; one of them stacked with
   * section crates, a jib and a cutting frame is what says this yard
   * re-assembles hulls rather than parks them. It is also the pier that gives
   * the starboard half of the mouth something in it, which the composition
   * needed and a fourth berth would not have provided.
   */
  _buildWorksPier(p, pad) {
    const put = this._put;
    const stack = [];
    let s = 0x9a17 >>> 0;
    const rnd = () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
    /* The stack stays INSIDE the pad, with the row pitch chosen so the
     * northmost container's near face is 3 m short of the pad's own near edge.
     * The first version pitched the rows at 6.6 m from the pad centre and put
     * the last row at z -124.8 with a 3 m half-depth: 1.8 m of container
     * standing across the SPINE, on its centreline, where the reach probe
     * found five half-metre stations of "nothing standable" and a player would
     * have found a wall across the only way out to the pier head. */
    /* Four rows of three, pitched at 4.2 m from `pad.cz - p.hd + 5.2`. The
     * numbers are a clearance, not a composition: the containers are 6 m deep,
     * so the near row's face lands at z -129.2 against a pad edge at -126, and
     * the far row's at -147.8 against a pad edge at -150. Both ends clear by
     * over 2 m. */
    for (let i = 0; i < 12; i++) {
      const gx = p.x + (i % 3 - 1) * 4.4 + (rnd() - 0.5) * 0.5;
      const gz = pad.cz - p.hd + 5.2 + Math.floor(i / 3) * 4.2 + (rnd() - 0.5) * 0.3;
      const lvl = i % 5 === 0 ? 1 : 0;
      stack.push([gx, 1.5 + lvl * 3.0, gz, 0, (rnd() - 0.5) * 0.1, 0, 1, 1, 1]);
    }
    this._group.add(instanced(boxGeo(4.0, 3.0, 6.0, 2), this.mat.crate, stack, { cast: true, recv: true }));
    /* Collided, unlike the yard's loose clutter, and for the opposite reason:
     * a 3 m container is not something a capsule walks over, it is a wall.
     * Nothing STANDS on them — the tops are 3.0 and 6.0 m up with no route —
     * so they are obstacles rather than ground. */
    for (const [gx, gy, gz] of stack) this._solid(gx, gy, gz, 2.0, 1.5, 3.0);

    // The cutting frame: a section jig with a hull ring clamped in it.
    put('steel', boxGeo(0.6, 9.0, 0.6, 3), p.x - p.hw + 3.0, 4.5, pad.cz + p.hd - 5.0);
    put('steel', boxGeo(0.6, 9.0, 0.6, 3), p.x + p.hw - 3.0, 4.5, pad.cz + p.hd - 5.0);
    put('steel', boxGeo(p.hw * 2 - 6.0, 0.7, 0.7, 3), p.x, 9.0, pad.cz + p.hd - 5.0);
    put('steelDark', new THREE.TorusGeometry(3.4, 0.34, 8, 22), p.x, 4.4, pad.cz + p.hd - 5.0);
    put('emAmber', boxGeo(0.4, 0.4, 0.2, 1), p.x + p.hw - 3.0, 7.6, pad.cz + p.hd - 5.4);
  }

  /* ---------------------------------------------------------------- */
  /* The service trench                                                */
  /* ---------------------------------------------------------------- */

  /**
   * A 3 m slot under the keel line, 2.2 m down, grated over except at three
   * ramped bays.
   *
   * ── Why it is grated rather than open ─────────────────────────────────────
   * An open 3 m slot down the centre of the only route through the yard is a
   * hole in the wayfinding: the keel line is the thing the whole world is
   * arranged around and a player walking it would fall in. A trench with a
   * removable cover is also just what a real fitting-out bay has. So the
   * cover is walkable, the keel line is continuous, and the bays are where the
   * cover is lifted — three of them, each a ramp, so the trench is a route
   * with two ends rather than a pit with one ladder.
   *
   * Clear height under the grating is 2.10 m (floor -2.2, cover underside
   * -0.10) against a 1.75 m capsule, so this is headroom rather than a crawl.
   */
  _buildTrench() {
    const put = this._put;

    for (const [z0, z1] of TRENCH_RUNS) {
      const len = z1 - z0;
      const cz = (z0 + z1) / 2;
      // Trench floor, sunk into the recess the slabs leave.
      put('floor', boxGeo(TRENCH_HW * 2, 0.6, len, 4), 0, TRENCH_Y - 0.3, cz);
      this._solid(0, TRENCH_Y - 0.3, cz, TRENCH_HW, 0.3, len / 2);
      /* Cable tray and conduit down the port wall of the slot — the reason a
       * service trench exists, and the only thing to look at down there.
       *
       * Hung at 1.95 m up the wall, hard under the grating, NOT at the 1.4 m
       * that reads better in a section drawing. Clear height in the trench is
       * 2.10 m and the player capsule is 1.75 m; a tray at 1.4 m is head
       * height, and because it is drawn and not collided the capsule would
       * pass straight through it. Geometry the player walks through is the
       * same defect as geometry the player cannot walk through, seen from the
       * other side. */
      put('steelDark', boxGeo(0.5, 0.3, len - 1, 2), -TRENCH_HW + 0.35, TRENCH_Y + 1.95, cz);
      for (let i = 0; i < 3; i++) {
        put('steel', new THREE.CylinderGeometry(0.09, 0.09, len - 1, 8).rotateX(Math.PI / 2),
          -TRENCH_HW + 0.2 + i * 0.14, TRENCH_Y + 1.7, cz);
      }
      // Hazard kerb either side of the slot, at deck level. 0.22 m: readable,
      // and under `stepHeight` so it is a marking rather than a wall.
      for (const s of [-1, 1]) {
        put('hazard', boxGeo(0.32, 0.22, len, 1), s * (TRENCH_HW + 0.16), DECK_Y + 0.11, cz);
      }
    }

    // The cover: every span of a run that is not a bay.
    const covers = [];
    for (const [z0, z1] of TRENCH_RUNS) {
      let cuts = TRENCH_BAYS
        .filter((b) => b.z1 > z0 && b.z0 < z1)
        .map((b) => [Math.max(z0, b.z0), Math.min(z1, b.z1)])
        .sort((a, b) => a[0] - b[0]);
      let at = z0;
      for (const [c0, c1] of cuts) {
        if (c0 - at > 0.2) covers.push([at, c0]);
        at = c1;
      }
      if (z1 - at > 0.2) covers.push([at, z1]);
    }
    for (const [z0, z1] of covers) {
      const len = z1 - z0, cz = (z0 + z1) / 2;
      put('grate', boxGeo(TRENCH_HW * 2, GRATE_T, len, 1.5), 0, DECK_Y - GRATE_T / 2, cz);
      this._solid(0, DECK_Y - GRATE_T / 2, cz, TRENCH_HW, GRATE_T / 2, len / 2);
    }

    // The three bays, each filled end to end by its own ramp.
    for (const b of TRENCH_BAYS) {
      const footZ = b.up > 0 ? b.z0 : b.z1;
      const run = b.up > 0 ? (b.z1 - b.z0) : -(b.z1 - b.z0);
      this._flight('z', 0, footZ, TRENCH_Y, run, -TRENCH_Y, TRENCH_HW * 2 - 0.1, 7);
      // Grab rail down one side of the ramp, and a bay legend at the head.
      const headZ = b.up > 0 ? b.z1 : b.z0;
      put('steelDark', boxGeo(0.09, 0.09, b.z1 - b.z0, 1), -TRENCH_HW - 0.1, DECK_Y + 0.9, (b.z0 + b.z1) / 2);
      signBoard(put, YARD_SIGN.trench, 2.4, 0.9, -3.4, 1.5, headZ, b.up > 0 ? 0 : Math.PI);
    }

    // The interior stash. Doorless descriptor — legal and useful
    // (`medieval/Treasures.js:556-566`): it buys the whole streaming path for
    // the collectibles with no interior to build.
    this.enterables.push({
      label: 'yard-trench',
      origin: new THREE.Vector3(0, TRENCH_Y, -36),
      doors: [],
      lifts: [],
      collectibleSpots: [
        { position: new THREE.Vector3(0.7, TRENCH_Y + 0.5, -20), tier: 'common' },
        { position: new THREE.Vector3(-0.6, TRENCH_Y + 0.5, -42), tier: 'common' },
        { position: new THREE.Vector3(0.5, TRENCH_Y + 0.5, -58), tier: 'rare' },
        { position: new THREE.Vector3(0, TRENCH_Y + 0.5, 6), tier: 'common' },
      ],
    });

    this._buildButts();
  }

  /**
   * The test-fire butts: six steel plates down the covered length of the
   * trench, and the only place in this world a weapon has anything to do.
   *
   * -- Why a shooting range in a world with `hostiles: false` ----------------
   * `rules.weapons` is ON here and, until this, nothing answered it: the
   * player walked into the yard carrying a rifle, a bow and a gauntlet, and
   * the entire world was scenery to all three. That is the same shape of
   * omission as a mount with nowhere to ride. It also gives `laser_cell` a
   * SINK - the range burns eight to light the plates - so the cell rack Suri
   * Vane sells is a purchase with an effect in this drop rather than a
   * placeholder for the flight model.
   *
   * -- What is drawn, and what is scored ------------------------------------
   * Every plate here is a real collider, so a round that hits one is resolved
   * by `Combat._resolveWorldHit` exactly as a round into a bulkhead is, with
   * its own impact spray, decal and `weapon:hit` at the point of contact.
   * `minigames/TestFire.js` scores off that event and off `projectile:hit`,
   * and owns no physics of its own. A drawn plate WITHOUT a collider would
   * have been a target rounds pass through - "a detail the player can see and
   * not grab would be a lie", stated about handrails and just as true of a
   * thing you are invited to shoot.
   *
   * The geometry, the colliders and the venue's `config.targets` all come off
   * `BUTTS_PLATES` in `dock/YardPlan.js`. One list, so a target the game
   * scores that the world never drew is not expressible.
   */
  _buildButts() {
    const put = this._put;

    // The firing mark, and two ammunition lockers against the walls. Painted
    // across the full slot; the lockers are the only solid things and they sit
    // hard against the sides, leaving the 1.66 m lane the trench march needs.
    paintQuad(put, TRENCH_HW * 2 - 0.2, 0.5, 0, TRENCH_Y + 0.02, BUTTS_FIRE_Z, 0, 0xffb347, 1);
    for (const side of [-1, 1]) {
      const x = side * (TRENCH_HW - 0.35);
      put('crate', boxGeo(0.64, 0.5, 1.1, 1), x, TRENCH_Y + 0.25, BUTTS_FIRE_Z - 0.9);
      this._solid(x, TRENCH_Y + 0.25, BUTTS_FIRE_Z - 0.9, 0.32, 0.25, 0.55);
      put('emGreen', boxGeo(0.5, 0.04, 0.1, 1), x, TRENCH_Y + 0.51, BUTTS_FIRE_Z - 0.9);
    }
    // The legend, on the port wall above the mark, facing back up the trench.
    signBoard(put, YARD_SIGN.trench, 2.0, 0.75, -TRENCH_HW + 0.12, TRENCH_Y + 1.55,
      BUTTS_FIRE_Z, Math.PI / 2, { accent: 'emAmber' });

    for (const t of BUTTS_PLATES) {
      const side = Math.sign(t.x);

      /* EVERY piece of a plate is authored UNROTATED, facing +Z — down the
       * trench, at the firing mark. That is not a simplification, it is the
       * fix for the first version of this method: the plates were drawn with a
       * 90 deg yaw so they faced the opposite wall, while `_solid` registered
       * the un-yawed box the game scores against. Collision and geometry
       * disagreed about which way a target pointed, the range still passed its
       * line-of-fire probe (the COLLIDER faced the right way), and a player
       * would have been shooting at six plates seen edge-on. `dock-testfire`
       * now reads the collider's `halfExtents` back and compares them with the
       * published target, which is the assertion that caught it.
       *
       * Backing frame first, immediately behind the plate. Drawn only: it is
       * 40 mm of hazard stripe in the shadow of a target that is itself
       * collided, and a second collider there would only add a surface a round
       * can stop on 6 cm short of the thing it was aimed at. */
      put('hazard', boxGeo(t.hx * 2 + 0.22, t.hy * 2 + 0.22, 0.04, 1),
        t.x, t.y, t.z - t.hz - 0.03);

      // The plate itself: drawn and collided, one box, same extents.
      put('steel', boxGeo(t.hx * 2, t.hy * 2, t.hz * 2, 1), t.x, t.y, t.z);
      this._solid(t.x, t.y, t.z, t.hx, t.hy, t.hz);

      // Bracket down to the trench floor, so the plate is hung rather than
      // floating. Against the wall, inside the plate's own column, so it costs
      // no headroom the plate has not already cost.
      put('steelDark', boxGeo(0.1, t.y - TRENCH_Y - t.hy, 0.1, 1),
        side * (BUTTS_WALL_X - 0.08), (TRENCH_Y + t.y - t.hy) / 2, t.z);

      // Aiming pip, dead centre and PROUD of the face, so a plate reads as a
      // target rather than a panel. Cyan: this world's wayfinding colour, laid
      // over sodium worklight.
      put('emCyan', boxGeo(t.hx * 0.34, t.hy * 0.34, 0.02, 1),
        t.x, t.y, t.z + t.hz + 0.012);
    }

    /* Rank markers on the deck overhead - the grating is 2.1 m up and lit from
     * the yard, so a chevron under it is what tells a shooter which rank is
     * which without a menu. */
    for (let i = 0; i < BUTTS_RANKS.length; i++) {
      const r = BUTTS_RANKS[i];
      for (let n = 0; n <= i; n++) {
        put('emAmber', boxGeo(0.16, 0.03, 0.5, 1),
          -TRENCH_HW + 0.3 + n * 0.28, DECK_Y - GRATE_T - 0.05, r.z);
      }
    }
  }

  /* ---------------------------------------------------------------- */
  /* The gantry                                                        */
  /* ---------------------------------------------------------------- */

  /**
   * A continuous 2.4 m catwalk round the whole perimeter at 8.0 m, two
   * crossings over the keel line, and two stairs.
   *
   * ── The rail gaps are cut, not dropped ────────────────────────────────────
   * `railSpans` (from `station/Tower.js`, imported rather than reimplemented)
   * cuts an OPENING in a named run where the stair head or a crossing arrives.
   * Dropping the whole run instead is the hangar-mezzanine defect: the stair
   * lands in the middle of the port run, and losing that run would leave 160 m
   * of unguarded catwalk over an 8 m fall to save one 2.4 m gap.
   */
  _buildGantry() {
    const put = this._put;
    const solid = (cx, cy, cz, hx, hy, hz) => this._solid(cx, cy, cz, hx, hy, hz);

    const deck = (axis, a, b, fixed) => {
      const len = b - a, c = (a + b) / 2;
      const w = axis === 'x' ? len : WALK_W;
      const d = axis === 'x' ? WALK_W : len;
      const cx = axis === 'x' ? c : fixed;
      const cz = axis === 'x' ? fixed : c;
      put('grate', boxGeo(w, DECK_T, d, 1.5), cx, GANTRY_Y - DECK_T / 2, cz);
      this._solid(cx, GANTRY_Y - DECK_T / 2, cz, w / 2, DECK_T / 2, d / 2);
      // Under-slung beam and a service conduit, so the catwalk has a soffit.
      put('steelDark', boxGeo(axis === 'x' ? len : 0.5, 0.55, axis === 'x' ? 0.5 : len, 3),
        cx, GANTRY_Y - 0.5, cz);
    };

    const midX = (-YARD_X + -GANTRY_X) / 2;
    // Perimeter, four runs. The side runs are full length; the end runs stop
    // at the side runs so no two decks are coplanar in the same place.
    deck('z', YARD_Z0, YARD_Z1, midX);
    deck('z', YARD_Z0, YARD_Z1, -midX);
    deck('x', -GANTRY_X, GANTRY_X, (YARD_Z1 + GANTRY_Z1) / 2);
    deck('x', -GANTRY_X, GANTRY_X, (YARD_Z0 + GANTRY_Z0) / 2);

    /* ── Rail gaps ────────────────────────────────────────────────────────
     * Every place something ARRIVES at the catwalk is a cut in the run it
     * arrives on, and nothing else is. Four things arrive:
     *
     *   port run   two stair heads, the two crossings, and the crane run's
     *              foot — which leaves INBOARD, so it crosses the rail line
     *   stbd run   the two crossings
     *   north run  the flight up to the signal post
     *
     * Miss one of these and the rail is a fence across the route it is meant
     * to guard, which is a stair that arrives at a handrail. Cut one that is
     * not needed and it is an 8 m fall with nothing in front of it. The gap
     * half-width is the arriving thing's own half-width plus 20 cm, so a body
     * is not squeezed between two rail ends. */
    const gapHW = WALK_W / 2 + 0.2;
    const portGaps = [
      ...STAIRS.map((s) => [s.z - gapHW, s.z + gapHW]),
      ...CROSSINGS.map((z) => [z - gapHW, z + gapHW]),
      [CRANE_RUN.z - (CRANE_RUN.width / 2 + 0.2), CRANE_RUN.z + (CRANE_RUN.width / 2 + 0.2)],
    ];
    const stbdGaps = CROSSINGS.map((z) => [z - gapHW, z + gapHW]);
    const northGaps = [[SIGNAL_POST.x - 1.1, SIGNAL_POST.x + 1.1]];

    railRun(put, solid, { axis: 'z', a: YARD_Z0, b: YARD_Z1, fixed: -GANTRY_X, y: GANTRY_Y, facing: 1, accent: 'emCyan', gaps: portGaps });
    railRun(put, solid, { axis: 'z', a: YARD_Z0, b: YARD_Z1, fixed: GANTRY_X, y: GANTRY_Y, facing: -1, accent: 'emCyan', gaps: stbdGaps });
    railRun(put, solid, { axis: 'x', a: -GANTRY_X, b: GANTRY_X, fixed: GANTRY_Z1, y: GANTRY_Y, facing: -1, accent: 'emCyan' });
    railRun(put, solid, { axis: 'x', a: -GANTRY_X, b: GANTRY_X, fixed: GANTRY_Z0, y: GANTRY_Y, facing: 1, accent: 'emCyan', gaps: northGaps });

    // The two crossings, and the columns that carry them.
    for (const z of CROSSINGS) {
      deck('x', -GANTRY_X, GANTRY_X, z);
      /* No brow gap here any more. The Dray used to sit under `CROSSINGS[0]`
       * and put a brow up onto it; she is 150 m north of the bay on Pier
       * Three now, and her brow lands on that pier's bow gantry instead — see
       * `_buildBowGantry`. A gap cut in a rail with nothing arriving at it is
       * an eight-metre fall with nothing in front of it, so it goes with her. */
      railRun(put, solid, { axis: 'x', a: -GANTRY_X, b: GANTRY_X, fixed: z - WALK_W / 2, y: GANTRY_Y, facing: -1, accent: 'emCyan' });
      railRun(put, solid, { axis: 'x', a: -GANTRY_X, b: GANTRY_X, fixed: z + WALK_W / 2, y: GANTRY_Y, facing: 1, accent: 'emCyan' });
      for (const x of CROSSING_COLUMN_X) {
        put('steel', boxGeo(0.5, GANTRY_Y - 0.7, 0.5, 3), x, (GANTRY_Y - 0.7) / 2, z);
        this._solid(x, (GANTRY_Y - 0.7) / 2, z, 0.25, (GANTRY_Y - 0.7) / 2, 0.25);
        // Base plate and knee braces: a 7 m column on a bare floor reads as a
        // prop, and these are what carry a 165 m walkway.
        put('steelDark', boxGeo(1.1, 0.14, 1.1, 1), x, 0.07, z);
        for (const s of [-1, 1]) {
          put('steelDark', boxGeo(2.0, 0.2, 0.2, 1), x + s * 0.9, GANTRY_Y - 1.5, z, 0, 0, s * 0.6);
        }
      }
    }

    // The two flights. Both climb toward -X, so their heads land square on the
    // port run's inner edge and the gap is a cut in ONE run.
    for (const s of STAIRS) {
      this._flight('x', s.footX, s.z, DECK_Y, s.headX - s.footX, GANTRY_Y, STAIR_W, STAIR_RISERS);
      // Newel posts at the foot, and a hazard mark on the deck under it.
      for (const d of [-1, 1]) {
        put('steelDark', boxGeo(0.14, 1.2, 0.14, 1), s.footX, 0.6, s.z + d * (STAIR_W / 2 + 0.1));
      }
      put('hazard', boxGeo(1.4, 0.06, STAIR_W + 0.6, 1), s.footX + 0.7, DECK_Y + 0.03, s.z);
      signBoard(put, YARD_SIGN.gantry, 2.6, 0.9, s.footX + 1.4, 2.6, s.z, -Math.PI / 2, { twoSided: true });
      // Handrails up both sides of the flight, following the pitch.
      const pitch = Math.atan2(GANTRY_Y, STAIR_RUN);
      const len = Math.hypot(STAIR_RUN, GANTRY_Y);
      for (const d of [-1, 1]) {
        put('steelDark', boxGeo(len, 0.09, 0.09, 1),
          (s.footX + s.headX) / 2, GANTRY_Y / 2 + 0.95, s.z + d * (STAIR_W / 2 + 0.06),
          0, 0, pitch);
      }
    }
  }

  /* ---------------------------------------------------------------- */
  /* The berths                                                        */
  /* ---------------------------------------------------------------- */

  /**
   * Four cradles, four bays, four spec boards — and no ships.
   *
   * Everything here exists so a hull can be dropped onto it without this file
   * being touched again: `shipSpecs` publishes the cradle centre, its yaw, the
   * bearing height that is ship-local y 0, the footprint the ship stage must
   * hand to `_collisionSoup`, and the apron point a boarding ramp foot lands
   * on. The cradle top is walkable, which is deliberate — it is the first
   * 1.2-2.2 m of the climb onto a hull, and a mantle onto it is inside the
   * `[0.25, 2.4]` rise band `player/Climb.js` accepts.
   */
  _buildBerths() {
    const put = this._put;
    const cells = [YARD_SIGN.berthB1, YARD_SIGN.berthB2, YARD_SIGN.berthB3, YARD_SIGN.berthB4];

    for (let i = 0; i < BERTHS.length; i++) {
      const b = BERTHS[i];
      const cw = b.hw * 0.62, cd = b.hd * 0.66;

      // Bay outline on the floor, in the paint bucket.
      paintQuad(put, b.hw * 2, 0.16, b.x, DECK_Y + 0.031, b.z - b.hd, b.yaw, 0xffb347, 2);
      paintQuad(put, b.hw * 2, 0.16, b.x, DECK_Y + 0.031, b.z + b.hd, b.yaw, 0xffb347, 2);
      paintQuad(put, 0.16, b.hd * 2, b.x - b.hw, DECK_Y + 0.031, b.z, b.yaw, 0xffb347, 2);
      paintQuad(put, 0.16, b.hd * 2, b.x + b.hw, DECK_Y + 0.031, b.z, b.yaw, 0xffb347, 2);

      /* The cradle. One solid mass with a bearing top, plus the frame that
       * makes it read as a cradle rather than a plinth. The MASS is the
       * collider — the frame is drawn only, because a lattice of eighteen
       * 0.3 m members collided individually is eighteen things to catch a
       * capsule on halfway up a berth. */
      put('steelDark', boxGeo(cw * 2, b.cradleTop, cd * 2, 3), b.x, b.cradleTop / 2, b.z, b.yaw);
      this._solidRot(b.x, b.cradleTop / 2, b.z, cw, b.cradleTop / 2, cd, b.yaw);
      // Bearing saddles along the keel line of the cradle.
      const saddles = Math.max(3, Math.round(b.length / 6));
      for (let s = 0; s < saddles; s++) {
        const t = (s + 0.5) / saddles - 0.5;
        const lz = t * cd * 1.9;
        const px = b.x + Math.sin(b.yaw) * lz;
        const pz = b.z + Math.cos(b.yaw) * lz;
        put('steel', boxGeo(cw * 1.5, 0.34, 0.9, 2), px, b.cradleTop + 0.17, pz, b.yaw);
        put('hazard', boxGeo(cw * 1.5 + 0.2, 0.07, 1.1, 1), px, b.cradleTop + 0.36, pz, b.yaw);
      }
      // Raking props off the cradle sides — what actually holds a hull upright.
      for (const s of [-1, 1]) {
        for (let k = -1; k <= 1; k++) {
          const lz = k * cd * 0.62;
          const px = b.x + Math.cos(b.yaw) * s * cw * 1.35 + Math.sin(b.yaw) * lz;
          const pz = b.z - Math.sin(b.yaw) * s * cw * 1.35 + Math.cos(b.yaw) * lz;
          put('steel', boxGeo(0.28, b.cradleTop * 2.1, 0.28, 2),
            px, b.cradleTop * 1.0, pz, b.yaw, 0, s * 0.42);
        }
      }

      /* Service stair from the deck up to the cradle top, on the keel-line
       * side. The rise is 1.2-2.2 m: a mantle would do it, but a mantle costs
       * stamina and needs a clean top face, and a berth you can only get onto
       * by climbing is a berth a tired player walks past.
       *
       * The HEAD is placed 0.8 m inside the cradle's near face, and the face
       * is the ROTATED extent rather than `cw`. The first version put the foot
       * at the apron point and ran a fixed 1.9:1 flight inland from there,
       * which on every berth stopped two to three metres short of a cradle
       * yawed away from the world axes: four staircases climbing to nothing,
       * and `dock-reach.test.mjs` reported all four cradle tops as BUILT and
       * unreachable. */
      const dirX = Math.sign(b.apron.x - b.x) || 1;
      const rise = b.cradleTop;
      /* The face along the CENTRELINE, not the axis-aligned bound.
       *
       * `|cos|*cw + |sin|*cd` is the box's AABB half-extent, i.e. its widest
       * point, and on a cradle yawed 16 degrees that is 1.7 m further out than
       * where the face actually is on the line the stair runs along - so the
       * flight stopped short and left a 1.5 m step at the top. What a line
       * through the centre meets is the nearer of the two slabs. */
      const faceX = b.x + dirX * Math.min(
        cw / Math.max(1e-3, Math.abs(Math.cos(b.yaw))),
        cd / Math.max(1e-3, Math.abs(Math.sin(b.yaw)))
      );
      // 0.3 m INSIDE the face, so the last of the ramp is buried in the cradle
      // and the two surfaces meet flush rather than within a rounding error.
      const stairHeadX = faceX - dirX * 0.3;
      const run = -dirX * (rise * 1.9);
      /* `stairZ` where the berth publishes one — see `YardPlan.BERTHS`. It is
       * the Dray's, and it is there because her own cargo ramp lands on this
       * side of this cradle and two ramp proxies 60 mm apart merge into a
       * column a body can walk down and not back up. */
      const stairZ = b.stairZ ?? b.z;
      this._flight('x', stairHeadX - run, stairZ, DECK_Y, run, rise, 2.0, Math.max(3, Math.round(rise / 0.38)));

      /* The tool wall behind the cradle: racked stock, a bench and a board.
       * This is where a berth stops being a plinth in an empty shed. */
      const wallX = b.x + (b.side > 0 ? b.hw + 1.4 : -(b.hw + 1.4));
      put('steelDark', boxGeo(0.4, 4.2, b.hd * 1.5, 3), wallX, 2.1, b.z, b.yaw);
      this._solidRot(wallX, 2.1, b.z, 0.2, 2.1, b.hd * 0.75, b.yaw);
      for (let r = 0; r < 3; r++) {
        put('steel', boxGeo(0.75, 0.09, b.hd * 1.4, 2), wallX - b.side * 0.4, 1.0 + r * 1.2, b.z, b.yaw);
      }
      // Stock on the racks: pipe, bar and plate, instanced as one draw.
      const stock = [];
      for (let k = 0; k < 22; k++) {
        const lz = (k / 22 - 0.5) * b.hd * 1.3;
        stock.push([
          wallX - b.side * 0.4 + (k % 3) * 0.12,
          1.12 + (k % 3) * 1.2,
          b.z + Math.cos(b.yaw) * lz,
          0, b.yaw, 0,
          1, 1, 1,
        ]);
      }
      const stockMesh = instanced(boxGeo(0.5, 0.14, 1.1, 1), this.mat.crate, stock, { cast: true, recv: true });
      this._group.add(stockMesh);

      /* The spec board: this hull's four stat bars, its swatches and its
       * price, readable from the floor without opening a menu. The board is
       * the SHOPPING, and the comparison is the loop of this world — so it is
       * hung on the tool wall at eye height rather than in a UI panel. The
       * next stage paints its bars; the frame and the berth legend are here. */
      const bx = wallX - b.side * 0.55;
      signBoard(put, cells[i], 3.6, 1.5, bx, 3.2, b.z, b.yaw + (b.side > 0 ? Math.PI / 2 : -Math.PI / 2),
        { accent: 'emCyan' });

      /* ── The cradle as relic ground, and where on it ──────────────────
       *
       * `Relics` takes a roof's `anchor` where one is published and its
       * FOOTPRINT CENTRE where none is, and it added `anchor` because taking
       * the centre buried eight of the citadel's thirty relics inside opaque
       * domes. This is the same shape of surface with the same problem: there
       * is a ship bolted to every cradle, so the centre of a bearing face is
       * inside a hull. Measured before this: berth two's site at (34, 2.15,
       * -2) sat inside a solid spanning [2.00, 2.60] — the Dray's belly
       * plating — where it rendered inside opaque hull and could only be
       * collected by walking into a ship.
       *
       * The anchor is `lower.hw + 1.0` out along the boarding flank in the
       * hull's own frame, which is the exact strip of cradle top that
       * `dock-reach.test.mjs` already floods to and proves standable. */
      const bs = boardSide(b);
      const alx = bs * (HULLS[b.id].lower.hw + 1.0);
      this._roofs.push({
        x: b.x, y: b.cradleTop, z: b.z,
        anchor: {
          x: b.x + alx * Math.cos(b.yaw),
          y: b.cradleTop,
          z: b.z - alx * Math.sin(b.yaw),
        },
      });

      /* ── The anchor the ship stage plugs into ─────────────────────────── */
      this.shipSpecs.push({
        id: b.id,
        berth: b.berth,
        klass: b.klass,
        length: b.length,
        /** Cradle centre; ALSO the origin of the ship's local frame. */
        x: b.x, z: b.z, yaw: b.yaw,
        /** Bearing face of the cradle. Ship-local y 0 sits here. */
        keelY: b.cradleTop,
        /** Berth footprint, for `_collisionSoup` to skip. */
        footprint: { x: b.x, z: b.z, yaw: b.yaw, hw: b.hw, hd: b.hd, top: b.cradleTop },
        /** Where a boarding ramp foot lands, on the keel-line side. */
        apron: { x: b.apron.x, y: DECK_Y, z: b.apron.z },
        /** The gantry edge a dorsal spine mantles onto, and its height. */
        gantryY: GANTRY_Y,
      });
    }
  }

  /* ---------------------------------------------------------------- */
  /* The hulls                                                         */
  /* ---------------------------------------------------------------- */

  /**
   * Pin the four hulls onto their cradles.
   *
   * ── What a hull owns, and what the yard owns ──────────────────────────────
   * Each one is authored in its OWN frame by `dock/Hulls.js` through a
   * `ShipKit.ShipBuild`, so nothing below rotates a point by hand. This method
   * is the seam: it hands each builder a berth anchor, a boarding side derived
   * from the published apron, and its own cloned materials, then takes back a
   * door, a lift, a set of collectible spots and a lighting claim, and turns
   * them into the records `Interiors`, `Loot` and `ShipRegistry` understand.
   *
   * ── Why each hull gets its own batch AND its own material clones ─────────
   * `Car.js:859-861`: bind livery slots to CLONED materials only, because the
   * shared singletons feed the AI race grid. Here the shared singletons are the
   * yard's own plating and steel, so a livery written to them would repaint the
   * shed. Clones share their parents' maps, so this costs no texture memory
   * and, with identical defines, no new shader program.
   *
   * The interior goes into a SECOND batch, flushed into its own group and
   * registered with `DistanceLod` at `hideBeyond: 40` — `station/Tower.js`'s
   * interior band, re-decided rather than inherited. The station's "no LOD
   * outside interiors" is a reasoned trade for one continuous deck meant to be
   * legible from across it; a yard of walk-in hulls is the tower case. And
   * COLLIDERS ARE NEVER SPLIT: every `cbox` registered regardless, so a player
   * walking into the Dray's hold never falls through a floor that has not
   * faded up.
   */
  _buildShips() {
    const put = this._put;

    for (const berth of BERTHS) {
      const hull = HULLS[berth.id];
      const klass = SHIP_CLASSES[berth.id];
      const { mats, owned, slotMats } = shipMaterials(this.mat, SHIP_TINTS[berth.id]);
      for (const m of owned) this._shipMats.push(m);

      const exterior = new GeoBatch();
      const interior = new GeoBatch();
      const g = new THREE.Group();
      g.name = `yard:ship-${berth.id}`;
      const ig = new THREE.Group();
      ig.name = `yard:ship-${berth.id}:interior`;
      this._group.add(g, ig);

      const b = new ShipBuild({
        batch: exterior,
        interior,
        physics: this.physics,
        track: (c) => this.track(c),
        /* Loose objects — hatch leaves, lift cars, ramp proxies — go on the
         * WORLD group, not the LOD group. `Interiors` writes `car.position.y`
         * in world space, and a lift parented under something that fades would
         * be a lift whose collider and whose car disagree at 41 m. */
        group: this.group,
        x: berth.x, y: berth.cradleTop, z: berth.z, yaw: berth.yaw,
      });
      const side = boardSide(berth);

      let out;
      if (berth.id === 'kestrel') out = buildKestrel(b, side, berth.cradleTop, mats);
      else if (berth.id === 'dray') out = buildDray(b, side, berth.cradleTop, mats);
      else if (berth.id === 'pike') out = buildPike(b, side, berth.cradleTop, mats);
      else out = buildBastion(b, berth.cradleTop, mats);

      /* ── The fit-out ───────────────────────────────────────────────────
       * The seam, and the only line in this world that knows there is one. A
       * hull builder's job is the shell; what makes a compartment read as a
       * cockpit, a hold or somebody's cabin is a second pass over the room
       * envelope that builder just published — and it runs HERE because here is
       * where that envelope first exists alongside a finished shell, with every
       * doorway, flight and lift already cut and already publishing the volume a
       * fitting may not stand in. See `ShipKit.fitOut`. */
      fitOut(b, out.rooms);

      exterior.flush(g, mats, `ship-${berth.id}`, {
        glass: { cast: false, recv: false },
        glow: { cast: false, recv: false },
        warn: { cast: false, recv: false },
        lamp: { cast: false, recv: false },
        danger: { cast: false, recv: false },
        hazard: { cast: false, recv: true },
        signs: { cast: false, recv: true },
      });
      const iMeshes = interior.flush(ig, mats, `ship-${berth.id}-in`, {
        glow: { cast: false, recv: false },
        warn: { cast: false, recv: false },
      });
      for (const m of iMeshes) this._lod.add(m, { hideBeyond: 40, measure: CENTRE, band: 6 });

      /* ── Lighting ──────────────────────────────────────────────────────
       * Declared on the descriptor AND built as a real `PointLight`, because
       * "neither alone would have found the defect": a claim with no light is
       * a claim, and a light with no claim is a thing the next change silently
       * deletes. Every one is a LightRig SOURCE with `castShadow: false` — the
       * rig has two shadowed slots for the entire game. */
      const lights = [];
      for (const l of out.lights ?? []) {
        const w = b.P(l.x, l.y, l.z);
        const pl = new THREE.PointLight(0xffd9a8, l.intensity, l.distance, 2.0);
        pl.castShadow = false;
        pl.position.copy(w);
        this._group.add(pl);
        /* `floorY` in WORLD terms, per fitting: a compartment's lamp is
         * measured against its own floor, and the Dray's three are not on one
         * level. */
        lights.push({
          x: w.x, y: w.y, z: w.z,
          intensity: l.intensity, distance: l.distance,
          floorY: berth.cradleTop + (l.floorY ?? 0),
        });
      }

      /* ── The enterable ────────────────────────────────────────────────
       * `label` is UNIQUE per hull. The collected tag is
       * `interior:dock:${label}#${i}`, so two hulls both called 'ship' would
       * share tags and one of them would silently lose its loot. */
      const rooms = out.rooms ?? [];
      const main = rooms.length
        ? rooms.reduce((a, r) => (((r.z1 - r.z0) * r.hw > (a.z1 - a.z0) * a.hw) ? r : a))
        : null;
      this.enterables.push({
        label: berth.id === 'bastion' ? 'bastion-ribs' : `ship-${berth.id}`,
        origin: b.P(0, 0, 0),
        doors: b.doors,
        lifts: b.lifts,
        collectibleSpots: b.spots,
        lights,
        floorY: main ? berth.cradleTop + main.floorY : DECK_Y,
        ceilY: main ? berth.cradleTop + main.ceilY : berth.cradleTop + hull.ledge.y,
        /** The hull's own frame, so a probe can work in its coordinates. */
        shipId: berth.id,
        frame: { x: berth.x, y: berth.cradleTop, z: berth.z, yaw: berth.yaw },
      });

      /* ── The customisable hull ────────────────────────────────────────── */
      if (WALKABLE.includes(berth.id)) {
        this.ships.push(new Ship({
          id: berth.id,
          displayName: klass.name,
          berth: berth.berth,
          slotMats,
          position: { x: berth.x, y: berth.cradleTop + hull.spine.y, z: berth.z },
        }));
      }

      /* ── High ground the climb pays for ──────────────────────────────── */
      const crown = berth.cradleTop + hull.spine.y;
      this._towers.push({ x: berth.x, y: crown, z: berth.z });
      /* The aft crown anchor, OFF THE CENTRELINE.
       *
       * It was at local x 0 and on the Bastion that is 4.6 m inside her
       * conning tower — `BASTION.tower` spans local z -14.6 to -11.2 and this
       * anchor sits at -14.5, so the relic rendered inside 4.4 m of opaque
       * deckhouse and could only be collected by standing in a wall. It
       * survived because `Relics` had never picked that particular site until
       * the piers added fifteen more and shuffled the 14 m separation pass.
       *
       * 4.6 m out, or the spine's own half-width less a metre, whichever is
       * smaller: past every deckhouse and barbette on the four hulls and still
       * on deck rather than over the flank. */
      const aftX = Math.min(4.6, hull.spine.hw - 1.0);
      const aft = b.P(aftX, 0, hull.spine.z0 + 1.5);
      this._roofs.push({ x: aft.x, y: crown, z: aft.z });

      /* ── What the yard now knows about the hull on this berth ────────── */
      const spec = this.shipSpecs.find((sp) => sp.id === berth.id);
      if (spec) {
        spec.boardSide = side;
        spec.crownY = crown;
        spec.walkable = WALKABLE.includes(berth.id);
        /* How a body gets onto this hull's dorsal spine, as data rather than as
         * a comment: 'scaffold' and 'brow' are WALKS and are flooded to by
         * `dock-reach`; 'climb' is a mantle chain and is proved separately in
         * `dock-hulls`. A probe that tried to walk to the Kestrel's crown would
         * report a defect that is a design. */
        spec.spineAccess = berth.id === 'dray' ? 'brow'
          : berth.id === 'pike' ? 'scaffold'
            : 'climb';
        if (out.ramp) {
          const foot = b.P(out.ramp.footX, out.ramp.footY, hull.ramp.lz);
          spec.ramp = { x: foot.x, y: foot.y, z: foot.z, from: hull.ramp.from };

          /* ── The pier's landing plate at the cargo door ─────────────────
           * A dock puts a plate across the gap between a gangway and a ship's
           * sill, and this world now needs one for a reason it can measure.
           * The Dray's ramp head stops at local x 5.15 and her hold sill
           * starts a few centimetres inboard of it; on the shop floor she was
           * yawed 11 degrees and the seam never lined up with anything, but on
           * a pier she is square to the world and the seam falls exactly on
           * the reach probe's 0.5 m lattice. Measured: the column at world
           * x 29.00 had solids [-0.22, 1.60] and [5.20, 6.16] and NOTHING at
           * 2.60, with 2.48-2.60 present at 28.90 and 2.44-2.60 at 29.10 —
           * a sub-decimetre crack that the graph read as a 1.0 m pit you could
           * fall into and not climb out of, and `dock-reach` reported the hold
           * as somewhere you could enter and not leave.
           *
           * A 1.6 x 3.0 m plate at the sill height closes it. It is only ever
           * built for a ramp that comes down to the DECK — the Kestrel's and
           * the Pike's land on their own cradle tops, where there is no gap to
           * bridge and a plate would only be one more edge to seam against. */
          if (hull.ramp.from === 'deck') {
            const sgn = Math.cos(berth.yaw) >= 0 ? 1 : -1;
            /* `side` and not a bare sign: the builder mirrors the ramp about
             * the boarding flank, so the plate has to go to whichever flank
             * that is. Without it the plate lands on the far side of the hull
             * and the seam it exists to close is still open. */
            const px = berth.x + sgn * side * (hull.ramp.headX + 0.15);
            const pz = berth.z + sgn * hull.ramp.lz;
            const py = berth.cradleTop + hull.ramp.headY;
            const phz = hull.ramp.width / 2 + 0.2;
            put('grate', boxGeo(1.6, 0.12, phz * 2, 1.5), px, py - 0.06, pz);
            put('hazard', boxGeo(1.7, 0.04, phz * 2 + 0.1, 1), px, py + 0.01, pz);
            this._solid(px, py - 0.06, pz, 0.8, 0.06, phz);
          }
        }
      }

      this._specBoard(berth);
      if (berth.id === 'dray') this._buildBowGantry(berth, side);
    }
  }

  /**
   * PIER THREE'S BOW GANTRY, and the Dray's brow onto it.
   *
   * ── What this replaces ────────────────────────────────────────────────────
   * The Dray used to sit on the shop floor under `CROSSINGS[0]`, whose collided
   * deck passed 1.70 m over her foredeck, and `HullPlan.BROW` is the flight
   * that bridged that gap: foredeck at local y 4.56, up 1.84 m over 2.65 m of
   * run, arriving at the catwalk. That is quest 55's "get on the gantry the
   * hard way, up the Dray's flank", and it is a route worth keeping.
   *
   * She is on a pier now with nothing over her, so the thing at the top of the
   * brow has to be built rather than borrowed — a boarding gantry at the bow,
   * which is what a real dock puts alongside a ship anyway.
   *
   * ── Every number is DERIVED, not copied ──────────────────────────────────
   * `BROW` still owns the run, the rise, the width and the riser count;
   * `HULLS.dray.foredeck` owns the deck the foot stands on; the berth owns the
   * cradle height. So the platform lands at `cradleTop + foredeck.y +
   * BROW.rise` whatever those become, which matters because another hand is
   * working the hulls: a platform pinned to the literal 8.00 would be a brow
   * to a ledge the first time the foredeck moved 20 cm.
   *
   * The stair is on the OFF side (local -X) because the boarding ramp foot and
   * the berth apron are both on local +X: two flights arriving at the same
   * three metres of pad is how a berth ends up with a stair you cannot get to.
   */
  _buildBowGantry(berth, boardingSide) {
    const put = this._put;
    const solid = (cx, cy, cz, hx, hy, hz) => this._solid(cx, cy, cz, hx, hy, hz);
    const fore = HULLS[berth.id].foredeck;

    /* Local -> world. `yaw` is PI on every pier berth, so local +Z is world
     * -Z and local +X is world -X; `sgn` carries that and nothing here has to
     * know a sine from a cosine. */
    const sgn = Math.cos(berth.yaw) >= 0 ? 1 : -1;
    const wz = (lz) => berth.z + sgn * lz;
    const wx = (lx) => berth.x + sgn * lx;

    const footLz = fore.z1 - 2.6;                 // 8.4 on the Dray
    const headLz = footLz + BROW.run;             // 11.05
    const footY = berth.cradleTop + fore.y;       // 6.16
    const headY = footY + BROW.rise;              // 8.00

    /* ── The platform ──────────────────────────────────────────────────── */
    /* The platform's aft edge is the brow's HEAD, exactly — `pL0 === headLz`.
     *
     * It was 1.2 m aft of it, on the reasoning that a landing wants a bit of
     * deck in front of the last tread. What that actually did was run the top
     * 1.2 m of the ramp UNDER the platform's own deck slab, leaving 0.24 m of
     * headroom over the ramp where it needed 1.9 — so the brow's top end was
     * not standable, the only way onto the ship was a 1.84 m drop off the
     * platform, and `dock-reach` reported the Dray's spine as "reachable, but
     * there is no way back from it". One-way access is the unreachable-content
     * defect wearing a hat. */
    const pL0 = headLz, pL1 = headLz + 3.4;
    const pz0 = wz(pL0), pz1 = wz(pL1);           // pz0 is the AFT edge
    /* The platform reaches out along the flank OPPOSITE the boarding ramp, and
     * so does the stair off it. Two flights arriving at the same three metres
     * of pad is how a berth ends up with a stair you cannot get to; the ramp
     * foot, the berth apron and the cradle's service stair are all on
     * `boardingSide` already. */
    const off = -boardingSide;
    const px0 = wx(-off * 2), px1 = wx(off * 12);
    const cz = (pz0 + pz1) / 2, cx = (px0 + px1) / 2;
    const hz = Math.abs(pz1 - pz0) / 2, hx = Math.abs(px1 - px0) / 2;
    put('grate', boxGeo(hx * 2, 0.14, hz * 2, 1.5), cx, headY - 0.07, cz);
    this._solid(cx, headY - 0.07, cz, hx, 0.07, hz);
    put('steelDark', boxGeo(hx * 2 - 0.4, 0.5, hz * 2 - 0.4, 3), cx, headY - 0.44, cz);
    // Four legs down to the pad, set 1.2 m inside each corner.
    for (const ax of [cx - hx + 1.2, cx + hx - 1.2]) {
      for (const az of [cz - hz + 1.0, cz + hz - 1.0]) {
        put('steel', boxGeo(0.42, headY, 0.42, 3), ax, headY / 2, az);
        put('steelDark', boxGeo(0.9, 0.12, 0.9, 1), ax, 0.06, az);
      }
    }

    /* ── The stair up from the pad ──────────────────────────────────────
     * 35 degrees, same as the two gantry flights, so it is the same walk the
     * player already knows. `_flight` draws the treads and collides ONE ramp
     * proxy, because the capsule solver resolves slopes and does not step up. */
    const stairX = wx(off * 11);
    /* The flight travels FORWARD in the hull's frame — local +Z — so its world
     * run carries `sgn`. Getting that sign wrong puts the foot 3 m past the
     * far lip of the pad, which is a staircase standing in vacuum. */
    const run = sgn * (headY / Math.tan((35 * Math.PI) / 180));
    this._flight('z', stairX, pz0 - run, DECK_Y, run, headY, 1.8, Math.round(headY / 0.4));
    const sPitch = -Math.atan2(headY, Math.abs(run)) * Math.sign(run);
    for (const d of [-1, 1]) {
      put('steelDark', boxGeo(0.09, 0.09, Math.hypot(run, headY), 1),
        stairX + d * 1.0, headY / 2 + 0.95, pz0 - run / 2, 0, sPitch, 0);
    }

    /* ── The brow ───────────────────────────────────────────────────────
     * Off the platform's aft edge and DOWN onto the foredeck, which is the
     * direction a body actually uses it: you walk out the pier, up the stair,
     * along the gantry and down onto the ship. Read the other way it is the
     * quest-55 route, up the flank and off the bow. */
    this._flight('z', wx(0), wz(footLz), footY, wz(headLz) - wz(footLz), BROW.rise, BROW.width, BROW.risers);
    const bl = Math.hypot(BROW.run, BROW.rise);
    const bp = Math.atan2(BROW.rise, BROW.run) * sgn;
    for (const s of [-1, 1]) {
      put('steelDark', boxGeo(0.09, 0.09, bl, 1),
        wx(0) + s * (BROW.width / 2 + 0.06), footY + BROW.rise / 2 + 1.0,
        wz(footLz + BROW.run / 2), 0, -bp, 0);
      put('emCyan', boxGeo(0.05, 0.05, bl, 1),
        wx(0) + s * (BROW.width / 2 + 0.06), footY + BROW.rise / 2 + 1.08,
        wz(footLz + BROW.run / 2), 0, -bp, 0);
    }
    put('hazard', boxGeo(BROW.width + 0.6, 0.05, 0.5, 1), wx(0), footY + 0.03, wz(footLz - 0.4));

    /* ── Rails, with the two gaps the two routes arrive through ─────────
     * Both of them are in the AFT edge: the stair at local -11 and the brow at
     * local 0. `railSpans` cuts openings rather than dropping runs, which is
     * the rule everywhere else in this world and is the difference between a
     * gap you walk through and a fence across a stair head. */
    const a = Math.min(px0, px1), b = Math.max(px0, px1);
    railRun(put, solid, {
      axis: 'x', a, b, fixed: pz0, y: headY, facing: -sgn, accent: 'emCyan',
      gaps: [
        [wx(0) - BROW.gapHW, wx(0) + BROW.gapHW].sort((m, n) => m - n),
        [stairX - 1.2, stairX + 1.2],
      ],
    });
    railRun(put, solid, { axis: 'x', a, b, fixed: pz1, y: headY, facing: sgn, accent: 'emCyan' });
    for (const fx of [a, b]) {
      railRun(put, solid, {
        axis: 'z', a: Math.min(pz0, pz1), b: Math.max(pz0, pz1), fixed: fx, y: headY,
        facing: fx === a ? 1 : -1, accent: 'emCyan',
      });
    }
    signBoard(put, YARD_SIGN.gantry, 3.0, 1.1, cx, headY + 2.2, pz1, sgn > 0 ? Math.PI : 0,
      { accent: 'emCyan', twoSided: true });
  }

  /**
   * The berth's spec board, painted as GEOMETRY rather than as a canvas.
   *
   * Four stat bars and a class rule, hung on the tool wall at eye height so the
   * comparison between the hulls can be made from the floor without opening a
   * menu. The comparison IS the shopping, and shopping is the loop of this
   * world — a difference that is true but not legible is a difference nobody
   * acts on.
   *
   * Bars rather than a texture, because the yard's sign atlas is already full
   * at 1024 x 1536 with all sixteen cells role-reserved, and a second atlas for
   * four boards is a megabyte and a texture unit for something a few emissive
   * boxes say better. The bar LENGTHS are read from `SHIP_BASE_STATS`, so a
   * change to the ladder changes the board rather than leaving it lying.
   */
  _specBoard(berth) {
    const put = this._put;
    const wallX = berth.x + (berth.side > 0 ? berth.hw + 1.4 : -(berth.hw + 1.4));
    const bx = wallX - berth.side * 0.62;
    const yaw = berth.yaw + (berth.side > 0 ? Math.PI / 2 : -Math.PI / 2);
    const nx = Math.sin(yaw), nz = Math.cos(yaw);
    /** `u` runs across the board, `v` up it, both in the board's own plane. */
    const at = (u, v, w, h, key) => put(key, boxGeo(w, h, 0.06, 1),
      bx + nx * 0.09 - Math.cos(yaw) * u, 2.35 + v,
      berth.z + nz * 0.09 + Math.sin(yaw) * u, yaw);

    put('steelDark', boxGeo(3.4, 1.5, 0.12, 2), bx, 2.35, berth.z, yaw);
    const stats = SHIP_STATS[berth.id] ?? [];
    const base = SHIP_BASE_STATS[berth.id] ?? {};
    if (!stats.length) {
      /* The Bastion sells nothing, and the board says so rather than being
       * blank: a blank board reads as a board somebody forgot to paint. */
      at(0, 0.18, 2.6, 0.12, 'emRed');
      at(0, -0.22, 1.8, 0.09, 'emRed');
      return;
    }
    for (let i = 0; i < stats.length; i++) {
      const tier = base[stats[i]] ?? 0;
      const v = 0.5 - i * 0.3;
      at(-1.45, v, 0.16, 0.1, 'emCyan');          // the stat's tick
      at(-0.35, v, 2.0, 0.03, 'steel');           // the track
      if (tier > 0) at(-1.3 + (tier * 0.5) / 2, v, tier * 0.5, 0.1, 'emAmber');
    }
  }

  /* ---------------------------------------------------------------- */
  /* The site office                                                   */
  /* ---------------------------------------------------------------- */

  /**
   * The one real enterable interior in this drop.
   *
   * ── Why the yard needs one before the ships arrive ───────────────────────
   * Every ship the next stage hangs here is an interior, and the whole risk
   * register for this world is "a thing you can see into and cannot get into".
   * Proving that path — a door record `Interiors` understands, a threshold the
   * `dy <= 2.6` gate accepts, a floor lit above 40/255, and a reach probe that
   * marches in and back out — against a nine-metre hut costs an afternoon.
   * Proving it for the first time against a 28 m ore tender costs the drop.
   *
   * The threshold is the DECK. `Interiors.js:374` only offers a door when
   * `|player.y - door.position.y| <= 2.6`, and `door.position` must be
   * published at the height the player's FEET are when standing at it — this
   * is the medieval winding house, whose sill stood 2.03 m over the street and
   * whose prompt therefore never appeared at all.
   */
  _buildOffice() {
    const put = this._put;
    const o = OFFICE;
    const hw = o.w / 2, hd = o.d / 2;
    const T = 0.22;

    // Shell: FIVE segments plus a lintel round the opening, never one solid
    // box — a single box fills the interior (`InteriorKit.js:361-373`).
    const DOOR_HW = 1.1, DOOR_H = 2.3;
    const wallSeg = (cx, cz, w, d, h, y) => {
      put('plate', boxGeo(w, h, d, 3), cx, y + h / 2, cz);
      this._solid(cx, y + h / 2, cz, w / 2, h / 2, d / 2);
    };
    // Back.
    wallSeg(o.x - hw + T / 2, o.z, T, o.d, o.h, 0);

    /* ── The two side walls, with a hole in each ─────────────────────────
     *
     * They were one unbroken slab apiece, and the glazing was drawn at the
     * slab's own mid-plane: measured, the wall occupied z 36.500-36.720 and
     * the pane went at 36.588, i.e. 88 mm INSIDE opaque plating. Eight
     * sightlines from the office at eye height came back blocked at
     * 3.28-4.64 m, all but the doorway. The hut was a windowless box that
     * described itself as lit and legible from the yard.
     *
     * So the opening is cut the same way the door opening is — a sill course,
     * a head course and two jambs — and the pane fills it with a collider of
     * its own. That last part is the difference between a window and a hole:
     * without it, a 3.4 x 1.4 m gap with a 1.2 m sill is a second, unintended
     * way into the world's one proved enterable. */
    const WIN_W = 3.4, SILL = 1.2, HEAD = 2.6;
    const jamb = (o.w - T * 2 - WIN_W) / 2;
    for (const s of [-1, 1]) {
      const cz = o.z + s * (hd - T / 2);
      wallSeg(o.x, cz, o.w - T * 2, T, SILL, 0);
      wallSeg(o.x, cz, o.w - T * 2, T, o.h - HEAD, HEAD);
      for (const j of [-1, 1]) {
        wallSeg(o.x + j * (WIN_W + jamb) / 2, cz, jamb, T, HEAD - SILL, SILL);
      }
      put('glass', new THREE.PlaneGeometry(WIN_W, HEAD - SILL), o.x, (SILL + HEAD) / 2, cz);
      this._solid(o.x, (SILL + HEAD) / 2, cz, WIN_W / 2, (HEAD - SILL) / 2, T / 2);
      put('steelDark', boxGeo(WIN_W + 0.24, 0.12, T + 0.03, 1), o.x, SILL, cz);
      put('steelDark', boxGeo(WIN_W + 0.24, 0.12, T + 0.03, 1), o.x, HEAD, cz);
    }
    // Front, split round the door.
    const frontX = o.x + hw - T / 2;
    const sideD = (o.d - DOOR_HW * 2) / 2;
    wallSeg(frontX, o.z - hd + sideD / 2, T, sideD, o.h, 0);
    wallSeg(frontX, o.z + hd - sideD / 2, T, sideD, o.h, 0);
    wallSeg(frontX, o.z, T, DOOR_HW * 2, o.h - DOOR_H, DOOR_H);

    /* Floor and roof.
     *
     * The floor deck tops out at 0.22, NOT at the 0.12 first drafted. The
     * office stands on the apron pad, whose own top is 0.12, and two opaque
     * depth-writing surfaces sharing a plane is a z-fight - the exact defect
     * `M.plazaOnDeck` exists for at the station, where the habitat terrace was
     * drawn at the same height as the carriageway under it and read as ground
     * flickering between two materials as the camera moved. A hut on a 100 mm
     * plinth is also what a site office is. */
    put('grate', boxGeo(o.w, 0.22, o.d, 2), o.x, 0.11, o.z);
    this._solid(o.x, 0.11, o.z, hw, 0.11, hd);
    put('plate', boxGeo(o.w + 0.5, 0.24, o.d + 0.5, 3), o.x, o.h + 0.12, o.z);
    this._solid(o.x, o.h + 0.12, o.z, hw + 0.25, 0.12, hd + 0.25);
    this._roofs.push({ x: o.x, y: o.h + 0.24, z: o.z });

    /* Two steps up to the threshold? No — the floor deck is 0.12 m and the
     * deck outside is 0. A 0.12 m sill is a step the capsule absorbs, and a
     * flight there would be three treads to climb a hand's width. */

    /* ── The door ─────────────────────────────────────────────────────────
     * The record shape is `InteriorKit`'s exactly, because `Interiors._onWorld`
     * (`:55-62`) only understands `leaves[].pivot.rotation.y`. A sliding
     * airlock would need its own descriptor and a `Physics.setBoxColliderY`
     * driver that `Interiors` does not have; one new door verb is not worth a
     * new descriptor contract, so every door in this world is hinged. */
    const leaves = [];
    const doorGroup = new THREE.Group();
    doorGroup.name = 'yard:office-door';
    this._group.add(doorGroup);
    for (const dir of [-1, 1]) {
      const pivot = new THREE.Group();
      pivot.position.set(o.doorX, DOOR_H / 2 + 0.22, o.z + dir * DOOR_HW);
      const leaf = new THREE.Mesh(boxGeo(0.1, DOOR_H, DOOR_HW, 2), this.mat.steel);
      leaf.position.set(0, 0, -dir * DOOR_HW / 2);
      leaf.castShadow = leaf.receiveShadow = true;
      const bar = new THREE.Mesh(boxGeo(0.14, 0.1, DOOR_HW * 0.8, 1), this.mat.emAmber);
      bar.position.set(0.09, 0.4, -dir * DOOR_HW / 2);
      pivot.add(leaf, bar);
      doorGroup.add(pivot);
      leaves.push({ pivot, closed: 0, open: dir * Math.PI * 0.62 });
    }
    const doorCollider = this.track(
      this.physics.addBox(o.doorX, DOOR_H / 2 + 0.22, o.z, 0.09, DOOR_H / 2, DOOR_HW, { solid: true })
    );

    /* ── The fit-out, in its own batch and its own LOD band ──────────────── */
    const I = new GeoBatch();
    const ig = new THREE.Group();
    ig.name = 'yard:office-interior';
    this._group.add(ig);
    const iput = (key, geo, x, y, z, ry = 0, rx = 0, rz = 0) => I.at(key, geo, x, y, z, ry, rx, rz);

    // A desk against the back wall, a plan chest, a stool and a drawing board.
    iput('crate', boxGeo(1.0, 0.08, 2.6, 2), o.x - hw + 1.1, 0.86, o.z, 0);
    for (const s of [-1, 1]) {
      iput('steelDark', boxGeo(0.9, 0.82, 0.1, 1), o.x - hw + 1.1, 0.41, o.z + s * 1.1);
    }
    iput('crate', boxGeo(0.9, 1.1, 1.4, 2), o.x - hw + 1.2, 0.55, o.z - 2.2);
    iput('steelDark', new THREE.CylinderGeometry(0.2, 0.24, 0.62, 10), o.x - hw + 2.4, 0.31, o.z + 0.4);
    iput('crate', boxGeo(0.09, 1.3, 1.8, 2), o.x - hw + 0.5, 1.9, o.z + 1.6, 0, 0, 0.28);
    // Pigeonholes and a rack of rolled drawings over the desk.
    for (let r = 0; r < 3; r++) {
      iput('crate', boxGeo(0.28, 0.1, 2.4, 1), o.x - hw + 0.6, 1.7 + r * 0.42, o.z);
    }
    // The office lamp: EMISSIVE, plus one rig-source point light in
    // `_buildLights`. A luminaire that is only a light is an invisible lamp; a
    // luminaire that is only emissive lights nothing.
    iput('emAmber', boxGeo(1.6, 0.1, 0.3, 1), o.x, o.h - 0.35, o.z);
    iput('steelDark', boxGeo(1.8, 0.12, 0.42, 1), o.x, o.h - 0.24, o.z);

    const iMeshes = I.flush(ig, this.mat, 'yard-office', {});
    for (const m of iMeshes) {
      /* `hideBeyond: 40`, `measure: CENTRE`, `band: 6` — `station/Tower.js`'s
       * interior band. COLLIDERS ARE NOT SPLIT: everything above registered
       * its own box regardless, so what the capsule meets is identical whether
       * the fit-out is drawn or not. A player walking in never falls through a
       * floor that has not faded up, because the floor was never the thing
       * being faded. */
      this._lod.add(m, { hideBeyond: 40, measure: CENTRE, band: 6 });
    }

    signBoard(put, YARD_SIGN.office, 3.2, 1.2, o.x + hw + 0.16, 2.9, o.z, Math.PI / 2, { accent: 'emCyan' });

    this.enterables.push({
      /* UNIQUE. The collected tag is `interior:dock:${label}#${i}`
       * (`Interiors.js:91`), so two enterables sharing a label share tags and
       * one of them silently loses its loot. */
      label: 'yard-office',
      origin: new THREE.Vector3(o.x, DECK_Y, o.z),
      doors: [{
        id: 'dock_office_door',
        leaves,
        collider: doorCollider,
        /** Published at FOOT height at the threshold, not at the hull origin. */
        position: new THREE.Vector3(o.doorX, DECK_Y + 0.22, o.z),
        open: false,
        anim: 0,
      }],
      lifts: [],
      collectibleSpots: [
        { position: new THREE.Vector3(o.x - hw + 1.1, 1.05, o.z + 0.6), tier: 'rare' },
        { position: new THREE.Vector3(o.x - hw + 1.2, 1.25, o.z - 2.2), tier: 'common' },
      ],
      /** Declared lighting, for the paired light measurement. */
      lights: [{ x: o.x, y: o.h - 0.35, z: o.z, intensity: 34, distance: 14 }],
      floorY: 0.22,
      ceilY: o.h,
    });
  }

  /* ---------------------------------------------------------------- */
  /* The chandlery row                                                 */
  /* ---------------------------------------------------------------- */

  /** Three counters down the port side of the keel corridor. See `YardPlan`. */
  _buildChandlery() {
    const put = this._put;
    const cells = [YARD_SIGN.chandler, YARD_SIGN.fitter, YARD_SIGN.paint];
    for (let i = 0; i < COUNTERS.length; i++) {
      const c = COUNTERS[i];
      const x = COUNTER_X, z = c.z;
      // Counter: a solid worktop the player walks up to, never through.
      put('crate', boxGeo(1.5, 1.05, 4.6, 2), x, 0.525, z);
      this._solid(x, 0.525, z, 0.75, 0.525, 2.3);
      put('steel', boxGeo(1.9, 0.1, 5.0, 2), x, 1.1, z);
      // Back shelving and a canopy, so the stall is a place and not a table.
      put('steelDark', boxGeo(0.35, 3.0, 5.0, 3), x - 1.6, 1.5, z);
      this._solid(x - 1.6, 1.5, z, 0.18, 1.5, 2.5);
      for (let r = 0; r < 3; r++) {
        put('steel', boxGeo(0.7, 0.08, 4.8, 2), x - 1.3, 0.7 + r * 0.8, z);
      }
      put('tarp', boxGeo(3.4, 0.12, 5.4, 3), x - 0.4, 3.1, z);
      for (const s of [-1, 1]) {
        put('steelDark', boxGeo(0.12, 3.0, 0.12, 1), x + 0.9, 1.5, z + s * 2.5);
      }
      // Stock on the counter and under the canopy.
      const crates = [];
      for (let k = 0; k < 9; k++) {
        crates.push([x - 1.25 + (k % 2) * 0.5, 0.86 + Math.floor(k / 3) * 0.8, z - 2.0 + (k % 3) * 1.6,
          0, (k * 0.7) % 1.5, 0, 0.5, 0.5, 0.5]);
      }
      this._group.add(instanced(boxGeo(0.9, 0.7, 0.9, 1), this.mat.crate, crates));

      signBoard(put, cells[i], 3.0, 1.1, x + 1.0, 3.6, z, -Math.PI / 2, { accent: 'emAmber', twoSided: true });
      /* The relic anchor is the WORKTOP, and it used to be the top of the
       * canopy at 3.16 — which is drawn and NOT collided, so the relic hung
       * 3.71 m up over nothing. Measured: the column at (-9.9, 6) held
       * [-2.8, 1.05] and [26, 26.8] and nothing whatever at 3.16, and the
       * nearest surface a body could walk to was 2.87 m away against
       * `Relics.PICKUP_R` = 2.0. The only thing inside 2 m was the 0.36 m
       * back-shelf top, which is too narrow for `Climb`'s 0.77 m inboard
       * mantle and is therefore not somewhere a body can be either.
       *
       * `y` 1.05 is the counter collider's own top face. A relic on a
       * chandler's counter is also better staging than one on his roof. */
      this._roofs.push({ x: x + 0.4, y: 1.05, z });
    }
  }

  /* ---------------------------------------------------------------- */
  /* The bay mouth                                                     */
  /* ---------------------------------------------------------------- */

  /**
   * The north end: 164 m of open vacuum, the surround that frames it, the
   * containment field that holds the air in, and the balustrade that stops a
   * body walking off the lip between two piers.
   *
   * ── What used to be here ──────────────────────────────────────────────────
   * A sealed 34 x 16 m blast door with `LAUNCHES: 000` over it. It was the
   * single best-lettered thing in the world and it was also the reason the
   * whole place read as "a big dark room": the end of the only route through
   * the yard was a wall. The board survives — it is the sentence this place
   * is arranged around — and now it hangs on the header truss over an
   * aperture instead of over a door.
   *
   * ── The field is legible, because the brief said not to leave a hole ─────
   * "Whatever holds atmosphere in must be legible — a shimmer field across the
   * bay mouth, or airlocks. Do not just leave a hole and hope." So there is a
   * real scrim across the whole aperture: additive, animated, brightest where
   * it meets the frame and nearly clear in the middle so the starfield and the
   * piers read straight through it. It is drawn and NOT collided — the player
   * walks through it onto the piers, which is what a containment field is for
   * — and its coil runs are emissive geometry down both jambs and along the
   * header, so the thing that makes it is visible as well as the thing it
   * makes.
   */
  _buildMouth() {
    const put = this._put;
    const HW = MOUTH_HW;
    const z = MOUTH_Z;

    /* ── The surround ───────────────────────────────────────────────────
     * Jamb columns, a header truss and a sill beam. Every one of them is a
     * real structural member carrying a 164 m opening in a 26 m wall, and the
     * header is what the roof plate's north edge dies into. */
    for (const s of [-1, 1]) {
      put('plate', boxGeo(3.2, MOUTH_Y1 + 2.4, 2.4, 4), s * (HW + 1.6), (MOUTH_Y1 + 2.4) / 2, z + 1.2);
      put('steel', boxGeo(1.2, MOUTH_Y1, 0.9, 3), s * (HW - 0.6), MOUTH_Y1 / 2, z + 0.35);
      // Field coil stack down the jamb: this is what makes the scrim.
      for (let y = 1.4; y < MOUTH_Y1; y += 2.6) {
        put('steelDark', boxGeo(0.9, 0.5, 1.2, 1), s * (HW - 0.4), y, z + 0.5);
        put('emLaunch', boxGeo(0.5, 0.16, 1.0, 1), s * (HW - 0.55), y, z + 0.5);
      }
    }
    // Header truss across the whole opening: two booms and a web, plus the
    // lintel plate the roof lands on.
    put('plate', boxGeo(HW * 2 + 6, 2.4, 2.6, 5), 0, MOUTH_Y1 + 1.2, z + 1.3);
    put('steel', boxGeo(HW * 2, 0.6, 0.6, 5), 0, MOUTH_Y1 - 0.4, z + 0.4);
    put('steel', boxGeo(HW * 2, 0.6, 0.6, 5), 0, MOUTH_Y1 - 3.2, z + 0.4);
    for (let x = -HW + 3; x < HW; x += 6) {
      put('steelDark', boxGeo(0.24, 3.4, 0.24, 1), x, MOUTH_Y1 - 1.8, z + 0.4, 0, 0, 0.55);
      put('steelDark', boxGeo(0.24, 3.4, 0.24, 1), x + 3, MOUTH_Y1 - 1.8, z + 0.4, 0, 0, -0.55);
      put('emLaunch', boxGeo(1.6, 0.14, 0.5, 1), x + 1.5, MOUTH_Y1 - 3.7, z + 0.4);
    }
    this._solid(0, MOUTH_Y1 + 1.2, z + 1.3, HW + 3, 1.2, 1.3);

    /* ── The threshold balustrade ───────────────────────────────────────
     * 1.15 m, solid, glazed, the whole width of the mouth EXCEPT a gate at
     * each pier. Over `stepHeight` 0.45 so it cannot be walked over and under
     * the 1.55 m a mantle needs so it cannot be climbed by accident; see
     * `YardPlan.MOUTH_KERB_H` for why this is not left to `Unstuck`.
     *
     * The gaps are computed from `PIERS`, so a pier that moves takes its gate
     * with it — a gate authored by hand at a hard-coded x is how a pier ends
     * up behind a fence. */
    const gates = PIERS
      .map((p) => [p.x - PIER_GATE_HW, p.x + PIER_GATE_HW])
      .sort((a, b) => a[0] - b[0]);
    let at = -HW;
    for (const [g0, g1] of [...gates, [HW, HW]]) {
      const a = at, b = Math.min(g0, HW);
      at = Math.max(at, g1);
      if (b - a < 0.3) continue;
      const c = (a + b) / 2, len = b - a;
      put('plate', boxGeo(len, MOUTH_KERB_H, 0.5, 3), c, MOUTH_KERB_H / 2, z + 0.25);
      put('hazard', boxGeo(len, 0.18, 0.62, 2), c, MOUTH_KERB_H + 0.09, z + 0.25);
      put('emPier', boxGeo(len, 0.06, 0.16, 1), c, MOUTH_KERB_H + 0.2, z + 0.02);
      this._solid(c, MOUTH_KERB_H / 2, z + 0.25, len / 2, MOUTH_KERB_H / 2, 0.25);
      // Stanchions, so 164 m of kerb is not one extruded box.
      for (let sx = a + 2; sx < b; sx += 4) {
        put('steelDark', boxGeo(0.22, MOUTH_KERB_H + 0.3, 0.7, 1), sx, (MOUTH_KERB_H + 0.3) / 2, z + 0.25);
      }
    }
    // Hazard chevrons on the deck along the whole threshold, and a launch
    // stripe through each gate.
    put('hazard', boxGeo(HW * 2, 0.06, 1.6, 2), 0, DECK_Y + 0.04, z + 2.4);
    for (const p of PIERS) {
      paintQuad(put, PIER_GATE_HW * 2, 4.0, p.x, DECK_Y + 0.033, z + 3.0, 0, 0x9fd8ff, 2);
    }

    /* ── The containment field ──────────────────────────────────────────
     * One plane across the aperture. `ShaderMaterial` rather than a texture
     * because what makes a field read as a field is that it MOVES, and a
     * 164 x 24 m canvas painted at boot to do it once would be a megabyte and
     * a second of paint for a static shimmer.
     *
     * `depthWrite: false` and additive: everything behind it — the piers, the
     * ships, three planets and 4,200 stars — must survive the trip through it.
     * Not collided, on purpose: this is the thing you walk through.
     */
    const field = new THREE.ShaderMaterial({
      uniforms: {
        uTime: { value: 0 },
        uColour: { value: new THREE.Color(0x6fd0ff) },
      },
      vertexShader: `
        varying vec2 vUv;
        void main() {
          vUv = uv;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }`,
      fragmentShader: `
        varying vec2 vUv;
        uniform float uTime;
        uniform vec3 uColour;
        void main() {
          /* Brightest where the field meets the frame and almost clear in the
           * middle: a scrim you can see the stars through, with an edge that
           * says where the air stops. */
          /* ── The numbers, and why they are this small ──────────────────
           * The first version used a 0.30 vertical falloff and a 0.34 floor,
           * and rendered as a sheet of blue haze over the whole aperture: the
           * starfield went grey, Ember went pink, and the thing built to say
           * "there is air on this side" said "there is glass in the way"
           * instead. The aperture is only 23.6 m tall and 164 m wide, so a
           * falloff quoted as a fraction of HEIGHT is 7 m of glow at the sill
           * and the lintel — most of what a standing camera sees through it.
           *
           * 0.06 of the height is 1.4 m of edge glow, the middle is at 4% and
           * the stars come straight through. */
          float ex = 1.0 - smoothstep(0.0, 0.04, min(vUv.x, 1.0 - vUv.x));
          float ey = 1.0 - smoothstep(0.0, 0.06, min(vUv.y, 1.0 - vUv.y));
          float edge = max(ex, ey);
          float w1 = sin(vUv.x * 190.0 + uTime * 0.9) * 0.5 + 0.5;
          float w2 = sin(vUv.y * 26.0 - uTime * 0.55) * 0.5 + 0.5;
          float shimmer = w1 * w2;
          /* One slow band travelling up the aperture. No division anywhere in
           * this shader and no pow() of a signed base: a single NaN here is
           * 19 pixels that black out the whole frame through bloom. */
          float t = vUv.y - fract(uTime * 0.045);
          float band = exp(-(t * t) * 900.0);
          float a = clamp(0.035 + edge * 0.5 + shimmer * 0.03 + band * 0.09, 0.0, 1.0);
          gl_FragColor = vec4(uColour * (0.22 + edge * 1.5 + band * 0.7), a);
        }`,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      side: THREE.DoubleSide,
      fog: false,
      toneMapped: true,
    });
    this._voidMats.push(field);
    this._fieldTime = field.uniforms.uTime;
    const scrim = new THREE.Mesh(new THREE.PlaneGeometry(HW * 2, MOUTH_Y1), field);
    scrim.position.set(0, MOUTH_Y1 / 2, z);
    scrim.renderOrder = 20;
    scrim.frustumCulled = false;
    this.group.add(scrim);

    /* LAUNCHES: 000. Nine metres of board on the header truss, facing back
     * down the keel line. It is a sign cell rather than a live counter: the
     * flight drop turns it over, and a counter wired to nothing is a promise.
     * Its twin faces OUT, so the number is the first thing a pilot coming home
     * down Berth Zero reads. */
    signBoard(put, YARD_SIGN.launches, 13.0, 4.6, 0, MOUTH_Y1 - 6.4, z + 2.6, 0,
      { accent: 'emLaunch', twoSided: true });
    for (const s of [-1, 1]) {
      signBoard(put, YARD_SIGN.blastDoor, 6.0, 2.0, s * (HW - 9), 6.4, z + 2.6, 0, { accent: 'emRed' });
    }

    /* The signal post: a platform off the north catwalk beside the door, with
     * the lamp that says whether the bay is live. It is a VIEWPOINT, so it has
     * to be somewhere a body can stand — reached from the north run of the
     * gantry by a short flight, not by a ladder that does not exist. */
    const p = SIGNAL_POST;
    const HD = SIGNAL_POST_HD;
    put('grate', boxGeo(4.0, 0.14, HD * 2, 1.5), p.x, p.y - 0.07, p.z);
    this._solid(p.x, p.y - 0.07, p.z, 2.0, 0.07, HD);
    for (const s of [-1, 1]) {
      put('steel', boxGeo(0.4, p.y, 0.4, 3), p.x + s * 1.6, p.y / 2, p.z + s * (HD - 0.4));
    }
    put('emRed', boxGeo(0.6, 0.6, 0.6, 1), p.x, p.y + 1.9, p.z);
    put('steelDark', boxGeo(0.24, 1.9, 0.24, 1), p.x, p.y + 0.95, p.z);
    const solid = (cx, cy, cz, hx, hy, hz) => this._solid(cx, cy, cz, hx, hy, hz);
    /* Three sides railed and the fourth GAPPED, because the fourth is where
     * the flight arrives — from the catwalk, so it is the NORTH edge. The
     * first version railed all four and the platform became a published
     * viewpoint with a fence across its only entrance: the same defect as an
     * unreachable mezzanine, found by the reach probe rather than in a
     * playtest. */
    railRun(this._put, solid, { axis: 'x', a: p.x - 2, b: p.x + 2, fixed: p.z + HD, y: p.y, facing: 1, accent: 'emRed' });
    railRun(this._put, solid, { axis: 'z', a: p.z - HD, b: p.z + HD, fixed: p.x + 2, y: p.y, facing: -1, accent: 'emRed' });
    railRun(this._put, solid, { axis: 'z', a: p.z - HD, b: p.z + HD, fixed: p.x - 2, y: p.y, facing: 1, accent: 'emRed' });
    railRun(this._put, solid, {
      axis: 'x', a: p.x - 2, b: p.x + 2, fixed: p.z - HD, y: p.y, facing: -1, accent: 'emRed',
      gaps: [[p.x - 1.1, p.x + 1.1]],
    });
    /* The flight up from the north catwalk. 3.2 m of rise over 6.2 m of run is
     * 27.3 degrees — shallower than the gantry flights, because it starts on a
     * 2.4 m catwalk and there is no room to make a landing if it does not. */
    this._flight('z', p.x, SIGNAL_RUN.z0, GANTRY_Y, SIGNAL_RUN.z1 - SIGNAL_RUN.z0, p.y - GANTRY_Y, 1.8, 8);
    this._towers.push({ x: p.x, y: p.y, z: p.z });
  }

  /* ---------------------------------------------------------------- */
  /* The gantry crane                                                  */
  /* ---------------------------------------------------------------- */

  /**
   * The crane. Its RAIL is dressing; its CAB is a place.
   *
   * The brief lists a crane cab at 15.4 m as one of the yard's four
   * viewpoints, and `Viewpoints` will happily publish a marker on a platform
   * nothing can reach — which is the defect this project ships. So the cab
   * gets a caged run off the north crossing, the run is a real flight with a
   * real ramp proxy, and `dock-reach.test.mjs` floods to it from the arrival
   * point like anywhere else. The rail the bridge travels on stays uncollided
   * above the catwalk, where it belongs.
   *
   * A crane that CARRIES the player was considered and refused:
   * `Physics.setBoxColliderY` is the entire dynamic collider API and is Y-only,
   * safe only because the broadphase is XZ-indexed. Horizontal motion means
   * remove + re-add per frame, which fragments the broadphase; and a moving
   * surface has to ASSIGN a rider's height rather than increment it, because a
   * 5 mm/frame increment is inside the solver's own correction and gets
   * cancelled (`StationWorld.js:11002-11031`; riders reached 2.84 m of 4.80
   * twice before that was understood).
   */
  _buildCrane() {
    const put = this._put;
    // Runway beams down both walls, on brackets. Drawn only.
    for (const s of [-1, 1]) {
      put('steel', boxGeo(0.9, 0.9, YARD_Z1 - YARD_Z0 - 4, 4), s * (YARD_X - 1.6), CRANE_Y + 0.9, (YARD_Z0 + YARD_Z1) / 2);
      for (let z = YARD_Z0 + 8; z < YARD_Z1; z += BAY) {
        put('steelDark', boxGeo(1.8, 0.3, 0.3, 1), s * (YARD_X - 0.9), CRANE_Y + 1.6, z, 0, 0, s * 0.5);
      }
    }
    // The bridge: two girders across the yard at the crane's parked bay.
    const bz = CRANE_CAB.z;
    for (const d of [-1.8, 1.8]) {
      put('steel', boxGeo(YARD_X * 2 - 3.4, 1.5, 0.7, 4), 0, CRANE_Y + 0.9, bz + d);
      put('steelDark', boxGeo(YARD_X * 2 - 3.4, 0.2, 0.2, 1), 0, CRANE_Y + 0.15, bz + d);
    }
    for (let x = -YARD_X + 6; x < YARD_X - 4; x += 5) {
      put('steelDark', boxGeo(0.22, 0.22, 3.6, 1), x, CRANE_Y + 0.9, bz);
    }
    /* The trolley and hook block, parked mid-span — NOT over the spares pile.
     * The pile is the leap of faith's landing and the line from the cab down
     * to it has to be empty air; a hook block hanging through it would read as
     * something the player is meant to miss. */
    const TROLLEY_X = -52;
    put('steelDark', boxGeo(3.2, 1.2, 4.4, 2), TROLLEY_X, CRANE_Y - 0.2, bz);
    put('steel', new THREE.CylinderGeometry(0.05, 0.05, CRANE_Y - 5.0, 6),
      TROLLEY_X, 5.0 + (CRANE_Y - 5.0) / 2, bz);
    put('steelDark', boxGeo(1.3, 1.0, 1.3, 1), TROLLEY_X, 4.7, bz);
    put('emAmber', boxGeo(1.4, 0.1, 1.4, 1), TROLLEY_X, 4.18, bz);

    /* The cab, the runway walkway, and the caged run up from the port
     * catwalk. The cab floor IS the viewpoint. */
    const c = CRANE_CAB;
    const solidW = (cx, cy, cz, hx, hy, hz) => this._solid(cx, cy, cz, hx, hy, hz);
    // Runway walkway: flight head -> the cab's own bay.
    const wLen = CRANE_WALK.z1 - CRANE_WALK.z0;
    put('grate', boxGeo(CRANE_WALK.w, 0.14, wLen, 1.5), CRANE_WALK.x, c.y - 0.07, (CRANE_WALK.z0 + CRANE_WALK.z1) / 2);
    this._solid(CRANE_WALK.x, c.y - 0.07, (CRANE_WALK.z0 + CRANE_WALK.z1) / 2, CRANE_WALK.w / 2, 0.07, wLen / 2);
    // The spur from the walkway's inboard edge to the cab's outboard edge.
    const spurA = CRANE_WALK.x - CRANE_WALK.w / 2;
    const spurB = c.x - 1.5;
    put('grate', boxGeo(spurB - spurA, 0.14, CRANE_WALK.w, 1.5), (spurA + spurB) / 2, c.y - 0.07, c.z);
    this._solid((spurA + spurB) / 2, c.y - 0.07, c.z, (spurB - spurA) / 2, 0.07, CRANE_WALK.w / 2);
    railRun(put, solidW, { axis: 'z', a: CRANE_WALK.z0, b: CRANE_WALK.z1, fixed: CRANE_WALK.x - CRANE_WALK.w / 2, y: c.y, facing: 1, accent: 'emCyan' });
    railRun(put, solidW, { axis: 'z', a: CRANE_WALK.z0, b: c.z - CRANE_WALK.w / 2, fixed: CRANE_WALK.x + CRANE_WALK.w / 2, y: c.y, facing: -1, accent: 'emCyan' });
    // Hangers back up to the runway beam, so the walkway is carried.
    for (let z = CRANE_WALK.z0; z <= CRANE_WALK.z1; z += 4) {
      put('steelDark', new THREE.CylinderGeometry(0.06, 0.06, 2.4, 6), CRANE_WALK.x, c.y + 1.2, z);
    }
    put('grate', boxGeo(3.0, 0.14, 3.0, 1.5), c.x, c.y - 0.07, c.z);
    this._solid(c.x, c.y - 0.07, c.z, 1.5, 0.07, 1.5);
    put('steelDark', boxGeo(3.2, 2.4, 0.16, 2), c.x, c.y + 1.2, c.z - 1.5);
    this._solid(c.x, c.y + 1.2, c.z - 1.5, 1.6, 1.2, 0.08);
    put('glass', new THREE.PlaneGeometry(3.0, 2.2), c.x, c.y + 1.2, c.z + 1.5, 0);
    for (const s of [-1, 1]) {
      put('steelDark', boxGeo(0.14, 2.6, 0.14, 1), c.x + s * 1.5, c.y + 1.3, c.z + 1.5);
      put('steelDark', boxGeo(0.14, 2.6, 0.14, 1), c.x + s * 1.5, c.y + 1.3, c.z - 1.5);
    }
    put('steelDark', boxGeo(3.4, 0.16, 3.4, 2), c.x, c.y + 2.6, c.z);
    put('emCyan', boxGeo(1.2, 0.08, 0.5, 1), c.x, c.y + 1.05, c.z + 1.1);
    /* The cab's open side faces -X, out over the bay: that is the launch point
     * for the leap of faith, and it is the ONLY side without a rail. */
    railRun(put, solidW, { axis: 'x', a: c.x - 1.5, b: c.x + 1.5, fixed: c.z + 1.5, y: c.y, facing: 1, accent: 'emCyan' });
    railRun(put, solidW, { axis: 'x', a: c.x - 1.5, b: c.x + 1.5, fixed: c.z - 1.5, y: c.y, facing: -1, accent: 'emCyan' });

    /* The run up. 7.4 m of rise over 9.6 m is 37.6 degrees — steeper than the
     * gantry flights and still a ramp rather than a ladder, because a ladder
     * is a verb this engine does not have. Caged, so it reads as a service
     * access rather than a staircase somebody forgot to rail. */
    const r = CRANE_RUN;
    this._flight('x', r.footX, r.z, GANTRY_Y, r.headX - r.footX, r.rise, r.width, 16);
    for (let i = 0; i <= 8; i++) {
      const t = i / 8;
      const hx = r.footX + (r.headX - r.footX) * t;
      const hy = GANTRY_Y + r.rise * t + 1.3;
      put('steelDark', new THREE.TorusGeometry(1.15, 0.05, 4, 10, Math.PI), hx, hy, r.z, Math.PI / 2);
    }
    this._towers.push({ x: c.x, y: c.y, z: c.z });
  }

  /* ---------------------------------------------------------------- */
  /* Set dressing                                                      */
  /* ---------------------------------------------------------------- */

  /**
   * Tarps, scaffold, drums, bottles and the spares pile.
   *
   * No settle pass and no fixed-point prop-solidify loop. `_settleDressing` is
   * the station's single most expensive phase at 3,175 ms and it exists to
   * repair props authored without a ground datum; every prop below stands on a
   * surface this file knows the height of, so there is nothing to repair.
   */
  /**
   * The services: everything that makes a shed a WORKING shed.
   *
   * ── Why this is a phase of its own ────────────────────────────────────────
   * Measured before it existed, the yard drew 37,282 triangles in its widest
   * framing against a budget of 900,000 - two thirds of a per cent - and read
   * as a correct but empty box. A world made of boxes is not the problem;
   * `StationWorld` is a world made of boxes. What separates the two is prop
   * DENSITY: the station puts something in front of the eye at every scale
   * from ten metres to ten centimetres, and the first draft of this yard had
   * nothing between the 26 m portal frames and the 0.9 m crates.
   *
   * So this is the middle scale, and it is all the stuff a hangar is actually
   * full of: purlins, cable ladders, duct runs, fire mains, junction boxes,
   * bolt-down sockets, hose reels, a monorail hoist beam. It is DRAWN ONLY -
   * not one collider - which is deliberate on two counts. A cable tray hung at
   * 5 m is not something a body can touch, and every collider added here would
   * be another thing for the reach probe to have to prove innocent.
   *
   * It all merges into the same `GeoBatch` as the rest of the yard, so the
   * whole pass costs materials it already pays for and no extra draw calls.
   */
  _buildServices() {
    const put = this._put;

    /* ── Roof purlins ────────────────────────────────────────────────────
     * A shed roof is not four rafters and a plate: the plate is carried on
     * purlins every couple of metres, and those purlins are the texture of
     * the ceiling in every frame that looks up. Run in Z between the portal
     * frames, so the roof reads as spanning the way a roof does. */
    for (let x = -YARD_X + 4; x < YARD_X; x += 3.4) {
      /* Purlins carry the PLATE, so they stop where the plate does. North of
       * `ROOF_CUT_Z` the rafters are bare and what is between them is sky —
       * running the purlins on out over the launch well would be a ceiling
       * grid with nothing on it, which reads as a plate that failed to draw. */
      put('steelDark', boxGeo(0.22, 0.34, YARD_Z1 - ROOF_CUT_Z - 2, 4), x, ROOF_Y - 2.5, (ROOF_CUT_Z + YARD_Z1) / 2);
    }
    /* Two monorail hoist beams down the length of the bay, inboard of the
     * crane runway: the yard lifts sections it does not need the big crane
     * for, and this is the thing it lifts them with. */
    for (const s of [-1, 1]) {
      put('steel', boxGeo(0.5, 0.7, YARD_Z1 - YARD_Z0 - 20, 4), s * 30, 19.4, (YARD_Z0 + YARD_Z1) / 2);
      for (let z = YARD_Z0 + 16; z < YARD_Z1 - 12; z += BAY) {
        put('steelDark', boxGeo(0.16, 4.6, 0.16, 1), s * 30, 22.0, z);
        put('steelDark', boxGeo(2.2, 0.16, 0.16, 1), s * 30 + s * 1.1, 24.2, z, 0, 0, s * 0.5);
      }
      // The block and hook, parked at one end.
      put('steelDark', boxGeo(0.7, 0.6, 0.7, 1), s * 30, 18.7, -12);
      put('steel', new THREE.CylinderGeometry(0.04, 0.04, 5.0, 6), s * 30, 16.0, -12);
      put('steelDark', boxGeo(0.5, 0.5, 0.5, 1), s * 30, 13.4, -12);
    }

    /* ── Wall services ───────────────────────────────────────────────────
     * Cable ladder up alternate bays, two horizontal duct runs, a fire main
     * with a valve at every bay, and a junction box beside each ladder. This
     * is what the side walls have instead of being flat.  */
    for (const s of [-1, 1]) {
      const wx = s * (YARD_X - 0.9);
      // Two duct runs the length of the wall.
      for (const y of [5.2, 12.6]) {
        put('steelDark', boxGeo(0.6, 0.55, YARD_Z1 - YARD_Z0 - 4, 3), wx, y, (YARD_Z0 + YARD_Z1) / 2);
        put('steel', boxGeo(0.68, 0.1, YARD_Z1 - YARD_Z0 - 4, 2), wx, y + 0.32, (YARD_Z0 + YARD_Z1) / 2);
      }
      // The fire main: a red pipe at working height with a valve per bay.
      put('emRed', new THREE.CylinderGeometry(0.11, 0.11, YARD_Z1 - YARD_Z0 - 6, 8).rotateX(Math.PI / 2),
        wx - s * 0.5, 2.4, (YARD_Z0 + YARD_Z1) / 2);
      let bay = 0;
      for (let z = YARD_Z0 + BAY / 2; z < YARD_Z1; z += BAY, bay++) {
        put('steel', boxGeo(0.34, 0.34, 0.34, 1), wx - s * 0.5, 2.4, z);
        put('steel', boxGeo(0.1, 0.5, 0.1, 1), wx - s * 0.5, 2.75, z);
        // Cable ladder up alternate bays, from the duct to the truss.
        if (bay % 2 === 0) {
          put('steelDark', boxGeo(0.5, 20.0, 0.1, 2), wx, 12.0, z + 1.6);
          for (let r = 0; r < 26; r++) {
            put('steelDark', boxGeo(0.44, 0.05, 0.05, 1), wx - s * 0.1, 2.6 + r * 0.78, z + 1.6);
          }
          put('steelDark', boxGeo(0.7, 0.9, 0.4, 1), wx - s * 0.3, 3.4, z - 1.4);
          put('emGreen', boxGeo(0.12, 0.12, 0.06, 1), wx - s * 0.52, 3.7, z - 1.4);
        }
      }
      // Down-pipes from the duct to the deck at every third bay, and a
      // stencilled bay number band along the wall at eye height.
      for (let z = YARD_Z0 + BAY * 1.5; z < YARD_Z1; z += BAY * 3) {
        put('steel', new THREE.CylinderGeometry(0.13, 0.13, 4.6, 8), wx - s * 0.35, 2.6, z);
        put('steel', boxGeo(0.4, 0.4, 0.4, 1), wx - s * 0.35, 0.35, z);
      }
      put('hazard', boxGeo(0.14, 0.5, YARD_Z1 - YARD_Z0 - 4, 2), wx - s * 0.2, 1.35, (YARD_Z0 + YARD_Z1) / 2);
    }

    /* ── Under the catwalk ───────────────────────────────────────────────
     * A cable tray and a conduit bundle the whole way round, hung off the
     * soffit. Seen from the floor, this is what stops the gantry being a
     * plank: it is the difference between a walkway and a service gantry. */
    const runs = [
      ['z', -YARD_X + WALK_W / 2 + 0.3, YARD_Z0, YARD_Z1],
      ['z', YARD_X - WALK_W / 2 - 0.3, YARD_Z0, YARD_Z1],
      ['x', YARD_Z1 - WALK_W / 2 - 0.3, -GANTRY_X, GANTRY_X],
      ['x', YARD_Z0 + WALK_W / 2 + 0.3, -GANTRY_X, GANTRY_X],
    ];
    for (const [axis, fixed, a, b] of runs) {
      const len = b - a, c = (a + b) / 2;
      const w = axis === 'x' ? len : 0.44;
      const d = axis === 'x' ? 0.44 : len;
      put('steelDark', boxGeo(w, 0.18, d, 2), axis === 'x' ? c : fixed, GANTRY_Y - 0.95, axis === 'x' ? fixed : c);
      for (let i = 0; i < 3; i++) {
        const off = -0.14 + i * 0.14;
        put('steel', axis === 'x'
          ? new THREE.CylinderGeometry(0.05, 0.05, len, 6).rotateZ(Math.PI / 2)
          : new THREE.CylinderGeometry(0.05, 0.05, len, 6).rotateX(Math.PI / 2),
        axis === 'x' ? c : fixed + off, GANTRY_Y - 1.22, axis === 'x' ? fixed + off : c);
      }
      // Hangers back up to the deck, every three metres.
      for (let t = a + 3; t < b; t += 3) {
        put('steelDark', boxGeo(0.06, 0.85, 0.06, 1),
          axis === 'x' ? t : fixed, GANTRY_Y - 0.5, axis === 'x' ? fixed : t);
      }
    }

    /* ── The floor ───────────────────────────────────────────────────────
     * Bolt-down sockets on the setting-out grid - the yard pins its cradles
     * and its jigs to these, and they are the reason the grid is still chalked
     * - plus a covered cable duct out to every berth and a drain line down
     * each side of the keel corridor. */
    const sockets = [];
    for (let x = -YARD_X + BAY; x < YARD_X; x += BAY) {
      if (Math.abs(x) < KEEL_HW + 2) continue;
      for (let z = YARD_Z0 + BAY; z < YARD_Z1; z += BAY) {
        sockets.push([x, 0.03, z, 0, 0, 0, 1, 1, 1]);
      }
    }
    this._group.add(instanced(boxGeo(0.44, 0.06, 0.44, 1), this.mat.steel, sockets, { cast: false, recv: true }));

    /* Covered cable duct out to every berth THAT IS ON THE FLOOR. The piers
     * are not: a duct run from the keel line out to a berth 150 m north of the
     * bay would be a 60 m steel box lying across open vacuum. The piers get
     * their services down their own spines, from the umbilical masts on their
     * pads — see `_buildPiers`. */
    for (const b of BERTHS) {
      if (b.pier) continue;
      const dirX = Math.sign(b.apron.x - b.x) || 1;
      const x0 = dirX > 0 ? KEEL_HW + 0.6 : b.x + dirX * 2;
      const x1 = dirX > 0 ? b.x + dirX * 2 : -(KEEL_HW + 0.6);
      put('steelDark', boxGeo(Math.abs(x1 - x0), 0.14, 0.7, 2), (x0 + x1) / 2, 0.07, b.z + 3.2);
      put('hazard', boxGeo(Math.abs(x1 - x0), 0.03, 0.16, 1), (x0 + x1) / 2, 0.15, b.z + 3.2);
    }
    for (const s of [-1, 1]) {
      put('grate', boxGeo(0.34, 0.06, YARD_Z1 - YARD_Z0 - 8, 1), s * 6.5, 0.03, (YARD_Z0 + YARD_Z1) / 2);
    }
  }

  _buildDressing() {
    const put = this._put;

    /* The spares pile under the crane: dunnage, plate offcuts and a tarp over
     * the lot. Published as a HAYSTACK — `y` is the TOP of the stack, which is
     * what `Parkour._softLandingAt` measures against, and the leap of faith
     * off the crane cab lands here. */
    const sp = SPARES_PILE;
    put('crate', boxGeo(9.0, 1.4, 7.0, 2), sp.x, 0.7, sp.z, 0.12);
    this._solidRot(sp.x, 0.7, sp.z, 4.5, 0.7, 3.5, 0.12);
    put('crate', boxGeo(6.4, 0.9, 5.0, 2), sp.x + 0.6, 1.85, sp.z - 0.4, -0.2);
    this._solidRot(sp.x + 0.6, 1.85, sp.z - 0.4, 3.2, 0.45, 2.5, -0.2);
    put('tarp', boxGeo(10.5, 0.16, 8.4, 4), sp.x, sp.y, sp.z, 0.06);
    for (let i = 0; i < 8; i++) {
      const a = (i / 8) * Math.PI * 2;
      put('tarp', boxGeo(1.2, 1.6, 0.14, 2),
        sp.x + Math.cos(a) * 5.0, sp.y - 0.8, sp.z + Math.sin(a) * 4.0, a);
    }
    this.haystacks.push({ x: sp.x, y: sp.y, z: sp.z, r: sp.r });

    /* The covered berth. One immaculate hull under a clean tarp that nobody is
     * allowed to touch — the tone line of the whole world, and dressing rather
     * than a ship: what is under the sheet is four boxes and it is never
     * uncovered. Sited clear of all four numbered berths so the ship stage has
     * no reason to want the space. */
    const cx = -56, cz = -76;
    put('steelDark', boxGeo(9.0, 1.0, 20.0, 3), cx, 0.5, cz, 0.1);
    this._solidRot(cx, 0.5, cz, 4.5, 0.5, 10.0, 0.1);
    put('tarp', boxGeo(8.0, 4.2, 18.0, 4), cx, 3.1, cz, 0.1);
    this._solidRot(cx, 3.1, cz, 4.0, 2.1, 9.0, 0.1);
    put('tarp', boxGeo(5.4, 2.2, 12.0, 4), cx, 6.0, cz, 0.1);
    this._solidRot(cx, 6.0, cz, 2.7, 1.1, 6.0, 0.1);
    for (const s of [-1, 1]) {
      put('emGreen', boxGeo(0.3, 0.1, 0.3, 1), cx + s * 4.2, 1.1, cz + 9.4);
    }
    this._roofs.push({ x: cx, y: 7.1, z: cz });

    /* Scaffold towers beside three of the berths.
     *
     * ONE WALKABLE LIFT EACH, at 2.0 m, with standards and ledgers above it
     * carrying no deck. The first version decked every lift of a three- and a
     * four-lift tower and gave each tower one ramp to the bottom deck, which
     * made every deck above it a 2.0 m step up: built, visible, and
     * unreachable. The reach probe reported both towers, which is exactly the
     * class of defect it exists for.
     *
     * The fix is not more ramps. A scaffold's own access is a ladder and this
     * engine has no ladder verb; a 2 m rise costs 3.4 m of run as a flight,
     * which does not fit inside a 2.6 m tower footprint and would have to
     * cantilever into the bay at every lift. So the working lift is the one a
     * body can stand on, the frame above it is what a scaffold looks like, and
     * `_roofs` publishes the height that is actually standable. */
    for (const [sx, sz, frames] of [[-46, 4, 3], [52, -34, 4], [16, -84, 2]]) {
      const LIFT_Y = 2.0;
      put('grate', boxGeo(2.6, 0.12, 2.6, 1.5), sx, LIFT_Y, sz);
      this._solid(sx, LIFT_Y, sz, 1.3, 0.06, 1.3);
      for (let l = 0; l < frames; l++) {
        const y = LIFT_Y + l * 2.0;
        for (const ox of [-1.3, 1.3]) {
          for (const oz of [-1.3, 1.3]) {
            put('steel', new THREE.CylinderGeometry(0.06, 0.06, 2.0, 6), sx + ox, y + 1.0, sz + oz);
          }
          put('steel', boxGeo(2.6, 0.08, 0.08, 1), sx, y + 2.0, sz + ox);
          put('steel', boxGeo(0.08, 0.08, 2.6, 1), sx + ox, y + 2.0, sz);
        }
        // The diagonal that makes a scaffold a scaffold rather than a shelf.
        put('steel', boxGeo(3.1, 0.07, 0.07, 1), sx, y + 1.0, sz - 1.3, 0, 0, 0.66);
      }
      // Guard rail round the working lift, open on the face the ramp arrives at.
      const solidS = (cx, cy, cz, hx, hy, hz) => this._solid(cx, cy, cz, hx, hy, hz);
      railRun(put, solidS, { axis: 'x', a: sx - 1.3, b: sx + 1.3, fixed: sz + 1.3, y: LIFT_Y, facing: 1, accent: 'emAmber' });
      railRun(put, solidS, { axis: 'z', a: sz - 1.3, b: sz + 1.3, fixed: sx - 1.3, y: LIFT_Y, facing: 1, accent: 'emAmber' });
      railRun(put, solidS, { axis: 'z', a: sz - 1.3, b: sz + 1.3, fixed: sx + 1.3, y: LIFT_Y, facing: -1, accent: 'emAmber' });
      // The ramp up the south face, landing 0.5 m onto the deck.
      this._flight('z', sx, sz - 1.3 - 3.4, DECK_Y, 3.9, LIFT_Y, 1.2, 6);
      this._roofs.push({ x: sx, y: LIFT_Y, z: sz });
    }

    /* ── The berth fit-out ───────────────────────────────────────────────
     * Everything a gang working a hull actually has round it. Drawn only, and
     * kept clear of the berth apron so nothing stands where a boarding ramp
     * foot is going to land. */
    for (const b of BERTHS) {
      const side = b.side;
      const bx = b.x + side * (b.hw * 0.45);
      // Gas bottle rack: six bottles in a cage, chained.
      for (let k = 0; k < 6; k++) {
        put('steel', new THREE.CylinderGeometry(0.15, 0.15, 1.5, 8),
          bx + (k % 3) * 0.36, 0.75, b.z - b.hd * 0.6 + Math.floor(k / 3) * 0.4);
      }
      put('steelDark', boxGeo(1.5, 0.08, 0.9, 1), bx + 0.36, 0.9, b.z - b.hd * 0.6 + 0.2);
      put('steelDark', boxGeo(1.5, 0.08, 0.9, 1), bx + 0.36, 0.3, b.z - b.hd * 0.6 + 0.2);
      put('hazard', boxGeo(1.7, 0.04, 1.1, 1), bx + 0.36, 0.03, b.z - b.hd * 0.6 + 0.2);
      // Welding set and its cable coil.
      put('crate', boxGeo(0.9, 0.85, 0.7, 1), bx - 1.6, 0.42, b.z - b.hd * 0.35);
      put('steelDark', boxGeo(0.95, 0.12, 0.75, 1), bx - 1.6, 0.9, b.z - b.hd * 0.35);
      put('emAmber', boxGeo(0.14, 0.1, 0.06, 1), bx - 1.3, 0.72, b.z - b.hd * 0.35 - 0.36);
      for (let k = 0; k < 4; k++) {
        put('steelDark', new THREE.TorusGeometry(0.36 - k * 0.05, 0.05, 5, 14),
          bx - 2.6, 0.06 + k * 0.1, b.z - b.hd * 0.35, 0, Math.PI / 2);
      }
      // Hose reel on a stand.
      put('steel', boxGeo(0.14, 1.1, 0.14, 1), bx + 2.2, 0.55, b.z + b.hd * 0.3);
      put('steelDark', new THREE.CylinderGeometry(0.42, 0.42, 0.4, 12).rotateZ(Math.PI / 2),
        bx + 2.2, 1.05, b.z + b.hd * 0.3);
      // Staging boards leaning on the cradle, and a pair of trestles.
      for (let k = 0; k < 3; k++) {
        put('crate', boxGeo(0.34, 0.06, 3.4, 2),
          bx - 0.4 + k * 0.4, 1.0 + k * 0.05, b.z + b.hd * 0.5, 0, 0.42, 0);
      }
      for (const t of [-1, 1]) {
        put('crate', boxGeo(1.3, 0.1, 0.4, 1), bx + 1.2, 0.82, b.z + t * 1.4);
        for (const q of [-0.5, 0.5]) {
          put('crate', boxGeo(0.08, 0.8, 0.08, 1), bx + 1.2 + q, 0.4, b.z + t * 1.4, 0, 0, q * 0.3);
        }
      }
      // A chalked job board on a stand, which is how a yard talks to itself.
      put('steelDark', boxGeo(1.6, 1.1, 0.08, 2), bx - 3.4, 1.5, b.z + b.hd * 0.15, 0.3);
      put('steel', boxGeo(0.1, 1.5, 0.1, 1), bx - 3.4, 0.75, b.z + b.hd * 0.15);
      // Toolboxes and a bin.
      put('crate', boxGeo(1.1, 0.5, 0.5, 1), bx + 3.0, 0.25, b.z - 2.0, 0.2);
      put('crate', boxGeo(0.8, 0.42, 0.44, 1), bx + 3.1, 0.68, b.z - 2.1, -0.15);
      put('steelDark', new THREE.CylinderGeometry(0.42, 0.34, 0.95, 10), bx + 3.6, 0.48, b.z + 1.2);
    }

    /* ── Instanced clutter ───────────────────────────────────────────────
     * Seven families rather than three, and 220 placements rather than 64.
     * One draw call each, culled against the INSTANCES rather than the
     * prototype (`StationKit.instanced` computes the bounding sphere from the
     * matrices), so a scatter in one corner of the yard is rejected from the
     * frustum when the camera is in the other.
     *
     * The count is the point. Measured before this pass the widest framing
     * drew 37,282 triangles against a 900,000 budget and read as a correct,
     * empty box; what a shed is actually full of is small things at
     * human scale, and there is no substitute for having some. */
    const rnd = (() => { let s = 0x5eed; return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296); })();
    const fam = { drums: [], bottles: [], crates: [], pallets: [], coils: [], plates: [], cones: [], bins: [] };
    for (let i = 0; i < 620; i++) {
      const x = -YARD_X + 5 + rnd() * (YARD_X * 2 - 10);
      const z = YARD_Z0 + 5 + rnd() * (YARD_Z1 - YARD_Z0 - 10);
      /* Keep-outs, and every one of them is a route rather than a taste:
       * the keel corridor and its trench bays, every berth footprint, the
       * chandlery row, the site office and the clean strip behind the blast
       * door. A prop in a route is a prop the player walks into on the way
       * in - and, worse, a prop the reach probe has to prove innocent. */
      if (Math.abs(x) < KEEL_HW + 3.0) continue;
      if (Math.abs(x - COUNTER_X) < 4.5 && z > -14 && z < 26) continue;
      if (Math.abs(x - OFFICE.x) < OFFICE.w && Math.abs(z - OFFICE.z) < OFFICE.d) continue;
      if (z < YARD_Z0 + 12) continue;
      if (BERTHS.some((b) => Math.abs(x - b.x) < b.hw + 1.5 && Math.abs(z - b.z) < b.hd + 1.5)) continue;
      /* ...and the section jigs, which now stand on three of those berth
       * footprints. A drum in a jig is 4.4 m in the radius with staging down
       * both flanks; a scattered drum inside that is a prop growing out of a
       * hull section. */
      if (SECTIONS.some((s) => Math.hypot(x - s.x, z - s.z) < s.len / 2 + s.r + 2)) continue;
      const yaw = rnd() * Math.PI * 2;
      const roll = rnd();
      if (roll < 0.20) fam.drums.push([x, 0.44, z, 0, yaw, 0, 1, 1, 1]);
      else if (roll < 0.34) fam.bottles.push([x, 0.72, z, 0, yaw, 0, 1, 1, 1]);
      else if (roll < 0.50) fam.crates.push([x, 0.45, z, 0, yaw, 0, 1, 1, 1]);
      else if (roll < 0.64) fam.pallets.push([x, 0.07, z, 0, yaw, 0, 1, 1, 1]);
      else if (roll < 0.74) fam.coils.push([x, 0.3, z, 0, yaw, 0, 1, 1, 1]);
      else if (roll < 0.86) fam.plates.push([x, 0.12, z, 0, yaw, 0, 1, 1, 1]);
      else if (roll < 0.94) fam.cones.push([x, 0.3, z, 0, yaw, 0, 1, 1, 1]);
      else fam.bins.push([x, 0.42, z, 0, yaw, 0, 1, 1, 1]);
    }
    const scatter = [
      [new THREE.CylinderGeometry(0.32, 0.32, 0.88, 10), this.mat.crate, fam.drums],
      [new THREE.CylinderGeometry(0.14, 0.14, 1.44, 8), this.mat.steel, fam.bottles],
      [boxGeo(0.9, 0.9, 0.9, 1), this.mat.crate, fam.crates],
      [boxGeo(1.2, 0.14, 1.0, 1), this.mat.crate, fam.pallets],
      [new THREE.TorusGeometry(0.5, 0.16, 6, 16), this.mat.steel, fam.coils],
      [boxGeo(1.9, 0.24, 1.1, 2), this.mat.plate, fam.plates],
      [new THREE.ConeGeometry(0.24, 0.6, 8), this.mat.hazard, fam.cones],
      [boxGeo(1.0, 0.84, 0.7, 1), this.mat.steelDark, fam.bins],
    ];
    for (const [geo, mat, entries] of scatter) {
      this._group.add(instanced(geo, mat, entries, { cast: true, recv: true }));
    }
    /* NOT collided, and that is a decision rather than an omission: a 0.44 m
     * drum is under `stepHeight` 0.45 so the capsule walks over it, and 400
     * colliders scattered across the only route through the yard is a floor
     * that snags every three metres. Anything a player could stand ON - the
     * scaffold decks, the spares pile, the cradles, the counters - is collided
     * where it is built. */
  }

  /* ---------------------------------------------------------------- */
  /* Lighting                                                          */
  /* ---------------------------------------------------------------- */

  /**
   * A high-bay lighting grid, plus the motivated practicals over the work.
   *
   * ── Why this is not eight lamps any more ──────────────────────────────────
   * It was, and the reasoning was a misreading of `RIG_BUDGET`. The measured
   * fact behind that budget is real — 42 point lights cost 59.8 s of cold
   * shader compile against 12's 19.4 s on the same 207 programs — but it is a
   * fact about LIVE lights, i.e. about the light count baked into every shader.
   * Every light this method creates is a LightRig SOURCE: `lightRig.claim`
   * runs the instant `build()` returns and sets `visible = false` on all of
   * them, so `projectObject` never pushes one and the count in the program
   * cache key stays at `RIG_BUDGET.point` = 12 whether this file authors eight
   * sources or eighty. The station authors 222 point and spot sources for
   * exactly this reason. Authoring eight bought nothing and cost the floor.
   *
   * ── What eight lamps actually delivered ───────────────────────────────────
   * Analytic floor illuminance on a 10 m grid over the whole 27,864 m² bay and
   * an 8 m grid along both catwalk runs, evaluating every point source exactly
   * as the standard shader does - `intensity / d^decay`, windowed by
   * `saturate(1 - (d/cutoff)^4)^2` and multiplied by `dot(N, L)` against the
   * walking surface - beside the same probe over the station's hub deck.
   * Reproduce it with `scripts/tests/dock-light.test.mjs`.
   *
   *                          min    p10   median    p90     max    mean
   *     yard floor, was     0.000  0.000   0.005   0.055   0.563   0.020
   *     yard catwalks, was  0.000  0.000   0.000   0.000   0.000   0.000
   *     yard floor, now     0.099  0.124   0.161   0.259   1.030   0.186
   *     yard catwalks, now  0.081  0.152   0.611   0.617   0.617   0.448
   *     station hub deck    0.000  0.000   0.271   2.672  10.827   0.912
   *
   * 237 of the 272 floor points were under 0.05 and both catwalk runs were at
   * exactly zero. One lamp per 3,483 m² in a shed is not dim lighting, it is no
   * lighting: past about 10 m from a fitting a 26 cd source at 9 m with decay
   * 1.9 delivers under 0.03.
   *
   * ── The grid ──────────────────────────────────────────────────────────────
   * `BAY` is 12 m and the shed's portal frames are on it, so the lamps hang on
   * every SECOND frame - a 24 m grid, seven by seven, which is what a real
   * high-bay layout looks like and what the roof truss already draws.
   *
   * The floor's median lands at 59% of the station's, and its MINIMUM is up
   * from 0.000 to 0.099, which is the half that matters: the old bay had no
   * floor at all between the fittings, and a player crossing it walked through
   * black. 59% is the yard being the dimmer sibling on purpose instead of by
   * accident.
   *
   * Every one is `castShadow: false` and hung at 9 m rather than 5 m
   * (`StationWorld.js:9731`: 1050 cd at 5 m is eight times the bloom threshold
   * and a bay of those is a frame of white discs). The upper volume is still
   * lit by the emissive strip runs along the rafters, not by lights.
   */
  _buildLights() {
    const put = this._put;
    const lamps = [];
    const hang = (x, z, colour = 0xffa860, intensity = 26, dist = 42) => {
      const l = new THREE.PointLight(colour, intensity, dist, 1.9);
      l.castShadow = false;
      l.position.set(x, 9, z);
      this._group.add(l);
      lamps.push([x, z]);
      // The fitting the light comes out of. A practical with no visible source
      // is a glow with no cause.
      workLight(put, x, 9.45, z, 0, { width: 2.2 });
      // The pendant back up to the truss.
      put('steelDark', new THREE.CylinderGeometry(0.045, 0.045, ROOF_Y - 12, 6), x, (ROOF_Y + 9.6) / 2, z);
    };

    /* ── One over each berth, and A PAIR DOWN EACH FLANK ───────────────────
     * The overhead lamp alone was the whole reason no hull in this yard read as
     * a machine. A hull flank is VERTICAL and a fitting at y 9 on the berth's
     * own centreline arrives at it almost edge-on, so `dot(N, L)` is ~0.05 and
     * every candela the berth lamp makes lands on a top deck the player cannot
     * see from the floor. Evaluating all authored point sources exactly as the
     * standard shader does - `intensity / d^decay`, windowed by
     * `saturate(1 - (d/cutoff)^4)^2`, times `dot(N, L)` - against the flanks
     * and the top deck of each hull, mean over the flank's whole area:
     *
     *                 -X flank   +X flank   top deck
     *     kestrel        0.079      0.047      0.520
     *     dray           0.187      0.152      0.354
     *     pike           0.098      0.110      0.460
     *     bastion        0.151      0.062      0.320
     *
     * Every flank at or under the yard FLOOR's own median of 0.161, against
     * top decks up to 11x that. Rendered, with the grain neutralised, the
     * subject was darker than its background in all eight hull framings - at
     * its own hero framing no pixel on the Kestrel exceeded 80/255.
     *
     * These hang at 5.5 m, outboard of the hull's own half-beam, and aim
     * across it. That is what `bracket` below already does for the catwalks
     * and it is the same fitting: at 5.5 m and 3 m outboard a flank gets
     * `dot(N, L)` around 0.6 instead of 0.05. `dock-light.test.mjs` now probes
     * a VERTICAL normal, which is the reason this was invisible to a suite
     * that was 7/7 green - `illuminanceAt` hard-coded N = +Y. */
    for (const b of BERTHS) {
      /* The overhead pendant hangs off the roof truss, so a berth with no roof
       * over it does not get one. The three pier berths are lit entirely from
       * the side — which is what the flank measurement below says they should
       * have been all along — plus a mast head over the cradle. */
      if (b.pier) {
        const mast = new THREE.PointLight(0xffd0a2, 30, 40, 2.0);
        mast.castShadow = false;
        mast.position.set(b.x, 11.5, b.z);
        this._group.add(mast);
        workLight(put, b.x, 11.9, b.z, 0, { width: 2.6 });
        /* The mast stands at the pad's OUTBOARD corner and reaches the lamp
         * over the ship on an L of boom. It used to stand on the berth
         * centreline at the pad's near edge — three metres in front of a
         * player walking up the pier and dead centre in every framing of the
         * hull's stern, which is a 12 m post through the middle of the one
         * picture the berth exists to give. */
        const mx = b.x + b.side * (b.hw * 0.9);
        const mz = b.z + (b.hd - 1.0);
        put('steel', boxGeo(0.5, 12.0, 0.5, 4), mx, 6.0, mz);
        put('steel', boxGeo(0.36, 0.36, b.hd - 1.0, 3), mx, 11.9, b.z + (b.hd - 1.0) / 2);
        put('steel', boxGeo(Math.abs(mx - b.x), 0.36, 0.36, 3), (mx + b.x) / 2, 11.9, b.z);
        put('steelDark', boxGeo(1.4, 0.16, 1.4, 1), mx, 0.08, mz);
      } else {
        hang(b.x, b.z);
      }
      const hull = HULLS[b.id];
      const off = hull.lower.hw + 3.0;
      const c = Math.cos(b.yaw), sn = Math.sin(b.yaw);
      for (const sg of [-1, 1]) {
        // Local +X maps to world (cos yaw, -sin yaw) - `GeoBatch.localAt`.
        const wx = b.x + sg * off * c;
        const wz = b.z - sg * off * sn;
        const l = new THREE.PointLight(0xffc79a, 14, 20, 2.0);
        l.castShadow = false;
        l.position.set(wx, 5.5, wz);
        this._group.add(l);
        /* NOT pushed onto `lamps`. That list is the skip test for the shed's
         * own high-bay grid, and its rule is "a bay lamp within 9 m of a
         * motivated one is skipped rather than stacked". A bracket at 5.5 m
         * aimed sideways at a hull is not the same fitting as a 9 m pendant
         * over open floor and does not light that floor: pushing them here
         * deleted four bay lamps and took the floor's MINIMUM illuminance from
         * 0.099 to 0.066, straight through `dock-light`'s 0.07 gate. */
        workLight(put, wx, 5.9, wz, b.yaw + (sg > 0 ? Math.PI / 2 : -Math.PI / 2), { width: 1.4 });
        /* On the floor these hang off the truss; on a pier there is no truss,
         * so the same fitting stands on a post off the pad. A pendant on a
         * pier berth would be a 20 m wire into empty sky. */
        if (b.pier) put('steel', boxGeo(0.28, 6.05, 0.28, 3), wx, 3.02, wz);
        else {
          put('steelDark', new THREE.CylinderGeometry(0.045, 0.045, ROOF_Y - 6.1, 6),
            wx, (ROOF_Y + 6.05) / 2, wz);
        }
      }
    }
    // ...one over the chandlery, one over the apron, one at the blast door,
    // and one down in the trench, which is the only place in the yard you
    // cannot see the roof from and would otherwise be black.
    hang(COUNTER_X + 2, 6, 0xffb87a, 27, 40);
    hang(0, 40, 0xffc38c, 29, 44);
    hang(0, YARD_Z0 + 14, 0xff9a5c, 31, 44);

    /* ...and then the shed's own lighting grid, on every second portal frame.
     * A bay lamp within 9 m of a motivated one is skipped rather than stacked:
     * two fittings lighting the same square of floor is a doubled highlight
     * with no second shadow, which reads as a rendering fault. */
    const near = (x, z) => lamps.some(([lx, lz]) => Math.hypot(x - lx, z - lz) < 9);
    for (let x = -72; x <= 72.1; x += BAY * 2) {
      for (let z = -96; z <= 48.1; z += BAY * 2) {
        if (near(x, z)) continue;
        hang(x, z, 0xffbe86, 31, 44);
      }
    }

    /* ── The catwalks get their own ────────────────────────────────────────
     * The bay grid does nothing for them: the nearest bay lamp is 11 m inboard
     * and 1 m above the deck, so it arrives at 5 degrees off the walking
     * surface and the same illuminance probe read the whole perimeter at a
     * median of exactly 0.000 - against 0.611 with these. One per portal frame
     * rather than one per two: at 24 m the pools did not meet and the median
     * sat at 0.083 with two thirds of the run between them.
     * Wall brackets over the run instead, on the same 24 m pitch, close enough
     * in that the cone lands on the walkway rather than on the cladding. */
    const bracket = (x, z, yaw) => {
      const l = new THREE.PointLight(0xffc79a, 12, 22, 2.0);
      l.castShadow = false;
      l.position.set(x, GANTRY_Y + 2.5, z);
      this._group.add(l);
      workLight(put, x, GANTRY_Y + 2.9, z, yaw, { width: 1.2 });
    };
    for (let z = GANTRY_Z0 + 6; z <= GANTRY_Z1 - 6; z += BAY) {
      bracket(-GANTRY_X + 0.9, z, Math.PI / 2);
      bracket(GANTRY_X - 0.9, z, -Math.PI / 2);
    }
    for (let x = -GANTRY_X + 18; x <= GANTRY_X - 18; x += BAY) {
      bracket(x, GANTRY_Z0 + 0.9, 0);
      bracket(x, GANTRY_Z1 - 0.9, Math.PI);
    }

    /* The trench: a 1.5 m slot 84 m long with a roof of grating over it. One
     * lamp at its midpoint left both ends black - the framing `VIEWS.dock`
     * calls `trench` measured 51% of its pixels under 12/255 - so it gets a
     * run of them on a 14 m pitch, which is the pitch at which their pools
     * meet against the trench's 2.2 m walls. Every one is under the deck and
     * therefore invisible from the bay; they cost the rig nothing and are the
     * only lights in the yard hung below 8.5 m. */
    /* 10 m and 15 cd, not 14 m and 8. The framebuffer says so: with the bay
     * mouth open and the whole yard a stop brighter, the `trench` framing was
     * the darkest of the thirty-five at a mean of 14.5 with 36% of its pixels
     * under 12/255 — a corridor that had gone from "the dim one" to "the one
     * that is a different game". */
    for (const [z0, z1] of TRENCH_RUNS) {
      for (let z = z0 + 6; z < z1; z += 12) {
        const trench = new THREE.PointLight(0xffb066, 10, 20, 2.0);
        trench.castShadow = false;
        trench.position.set(0, TRENCH_Y + 1.9, z);
        this._group.add(trench);
        put('emSodium', boxGeo(0.7, 0.08, 0.2, 1), 0.9, TRENCH_Y + 1.95, z);
      }
    }

    /* The office: a deckhead lamp, and TWO WALL WASHERS, for the reason
     * `Hulls.wallWash` is written down at length for. One 12 cd source at
     * `h - 0.4` on the centreline of a 9 x 7 x 3.2 m room puts everything it
     * makes on the floor and nothing on the four walls that are most of what a
     * camera at eye height sees: the `office-inside` framing measured 15.6 of
     * 255 mean frame luma against the brief's 40. */
    const office = new THREE.PointLight(0xffe0b0, 16, 14, 2.0);
    office.castShadow = false;
    office.position.set(OFFICE.x, OFFICE.h - 0.4, OFFICE.z);
    this._group.add(office);
    for (const sg of [-1, 1]) {
      const w = new THREE.PointLight(0xffd9a8, 6, 9, 2.0);
      w.castShadow = false;
      w.position.set(OFFICE.x + sg * (OFFICE.w / 2 - 1.2), 1.75, OFFICE.z + sg * (OFFICE.d / 2 - 1.4));
      this._group.add(w);
    }

    /* ── The reflection probe ────────────────────────────────────────────
     *
     * `environment.envMapIntensity` is 0.75 and twenty of this world's
     * materials are authored around it, up to `M.glass` at 2.0 with clearcoat
     * — which is almost entirely image-based and collapses to a flat dark
     * sheet with no probe behind it. But `main.js` only assigns
     * `scene.environment` when the world publishes `envMap`, so leaving it
     * unset does not mean "no reflections": it means the yard is lit by
     * WHICHEVER WORLD RAN LAST. Booting `?world=dock` gave every metal in the
     * shed nothing at all; walking in from the concourse gave a cold shipyard
     * the station's baked cyan-and-amber probe. Neither is a look anybody
     * authored, and which one you got depended on the route.
     *
     * `'space'` rather than `'daylight'`: the shed has a roof and a starfield
     * past the blast door, and a blue sky probe indoors reads as a hole in the
     * wall. Same one line as `CitadelWorld` and `RaceWorld`; `?? undefined`
     * keeps `scene.environment` untouched in a headless build where the
     * material library is a stub. */
    this.environment.envMap = this.materials?.getEnvMap?.('space') ?? undefined;
  }

  /* ---------------------------------------------------------------- */
  /* Publication                                                       */
  /* ---------------------------------------------------------------- */

  _publish() {
    /* ── Spawns and portals ─────────────────────────────────────────── */

    /* Cold spawn, only reachable with `?world=dock`. On the apron, facing down
     * the keel line, which is the same first frame the gateway gives. */
    this.playerSpawn.set(0, DECK_Y + 0.3, 46);
    this.playerSpawnYaw = 0;   // characters look down -Z at yaw 0

    this.portalSpecs.push(
      {
        position: new THREE.Vector3(0, DECK_Y + 0.3, PORTAL_STATION_Z),
        rotationY: Math.PI,
        target: 'station',
        label: 'Aether Nexus Station',
        accent: 0x9fb8c8,
      },
      {
        /* THE LAUNCH SEAM. One spec, on the deck, in front of the blast door.
         * `arrivalFor` finds the return portal BY TARGET and takes the first
         * match, so this same record is both the way out and the way home —
         * which is why there must be exactly one of them, and why the cockpit
         * seat the flight drop adds calls `portals.enterById('dock->space')`
         * rather than authoring a second spec of its own. */
        position: new THREE.Vector3(0, DECK_Y + 0.3, PORTAL_SPACE_Z),
        rotationY: 0,
        target: 'space',
        label: 'Open Space',
        accent: 0x9fd8ff,
        /** Read by `Portals._kit`: a blast-door aperture, not a ceremonial arch. */
        style: 'launch',
      }
    );

    /* ── The cast ───────────────────────────────────────────────────── */

    const P = (x, z, y = DECK_Y + 0.2) => new THREE.Vector3(x, y, z);

    /* The Yard Warden, authored rather than left to `_spawnLorekeepers`.
     *
     * The manager gives each gateway its own keeper, and `lorekeeperScope`
     * hands a keeper the GATEWAY's destination whenever a world's portals name
     * more than one place. The yard names two (station, space), so both of its
     * automatic keepers speak about somewhere else and nobody in the world
     * recites the yard's own lore. This is that person, and the persona is
     * built from `DEFAULT_LORE.dock` so the two cannot drift.
     */
    this.npcSpawns.push({
      position: P(-6, 44),
      type: 'friendly',
      name: 'Yard Warden Teodora Vasa',
      persona: buildLorePersona('dock'),
      /* The third waypoint used to be (-9, 8), which is INSIDE the Fitting
       * Shop counter: the counter stands at `COUNTER_X` -9.5 with a 0.75 m
       * half-width and a 2.3 m half-depth about z 6, so the point was 0.25 m
       * inside its +x face and 0.30 m inside its +z face. `resolveCapsule`
       * does not eject horizontally there — it lifts the body to y 1.05 — so
       * the world's lorekeeper finished her leg standing on Suri Vane's
       * counter while `NPC._sampleGround`, whose probe stops 0.95 m up, still
       * reported the deck beneath her and popped her between the two.
       *
       * `npc-routes` missed it because `auditRoute` resolves a waypoint onto
       * whatever it is inside FIRST and then tests the capsule there, and the
       * 0.855 m level error sits inside its 2.0 m tolerance. The fix is the
       * customer's side of the counter, which is where a warden talking to a
       * fitter stands anyway. */
      patrol: [P(-6, 44), P(-4, 26), P(COUNTER_X + 1.6, 8), P(-4, 26)],
    });

    const vendors = [
      {
        z: COUNTERS[0].z,
        name: 'Ivo Marek',
        vendorTitle: 'Yard Chandlery',
        vendorCategories: ['tools', 'health'],
        signLines: ['YARD CHANDLERY', 'STORES & PHYSIC'],
        persona:
          'The Chandler of Lodestar Yard. Sells stores, medical kit and hand tools off a counter he has never once tidied, prices everything before you ask, and buys hull plate and coil by the ton because the yard sheds them. Dry, unhurried, and quietly furious that the board still reads LAUNCHES: 000 after all this time.',
      },
      {
        z: COUNTERS[1].z,
        name: 'Suri Vane',
        vendorTitle: 'Fitting Shop',
        vendorCategories: ['ships', 'weapons'],
        signLines: ['FITTING SHOP', 'HULLS & ORDNANCE'],
        persona:
          'The Fitter. She pins hull sections back together for a living and can tell you which of the four ships on the cradles is honest and which one is a hulk somebody is fond of. Talks in tolerances, distrusts anything smooth, and will sell you thruster coil, plate and a ship if you can carry the price.',
      },
      {
        z: COUNTERS[2].z,
        name: 'Beck Aldous',
        vendorTitle: 'Paint & Rope',
        vendorCategories: ['cosmetic', 'mounts', 'spells'],
        signLines: ['PAINT & ROPE', 'LIVERY & CORDAGE'],
        persona:
          'Runs Paint & Rope at the far end of the chandlery row: livery, cordage, tack and the odd charm. Cheerful, gossipy, convinced a ship in the right colours flies better, and the only person in the yard who thinks the covered berth should be uncovered.',
      },
    ];
    for (const v of vendors) {
      this.npcSpawns.push({
        position: P(COUNTER_X - 1.1, v.z),
        type: 'friendly',
        role: 'vendor',
        name: v.name,
        persona: v.persona,
        vendorTitle: v.vendorTitle,
        vendorCategories: v.vendorCategories,
        signLines: v.signLines,
        anchored: true,
        yaw: -Math.PI / 2,
      });
    }

    // Three yard hands, so the place reads as worked rather than abandoned.
    this.npcSpawns.push(
      {
        position: P(BERTHS[1].apron.x + 2, BERTHS[1].apron.z + 3),
        type: 'friendly',
        name: 'Rig-Chief Odalys Prieto',
        persona:
          'Runs the cradle gang on berth two. Twenty years of pinning sections back together and no patience at all for anyone who touches a rigging screw without asking. Will tell you exactly how the Dray came through the gateway, in order, section by section.',
        /* Her round is PIER THREE, end to end, and it has to be: berth two
         * moved 150 m north onto a pier, and the old route walked from the
         * cradle to (14, -20) in the middle of the bay. Straight-line legs
         * between those two points leave the pad at its west edge and cross
         * 32.1 m of open vacuum before they find the hall floor again —
         * `npc-routes.test.mjs` measured exactly that, twice, and it is the
         * same defect as a berth nobody can walk to seen from the NPC's side.
         *
         * Pad, spine, the gate at the bay lip, spine. Every leg is inside the
         * 6.8 m spine or the 28 m pad; the diagonal from the cradle to the
         * spine crosses the pad edge at x 31.6, which is inside the spine's
         * own 30.6-37.4.
         *
         * The waypoint before that used to be (20, -46), which is a crossing
         * support column: `CROSSING_COLUMN_X` puts one at x 20 and `CROSSINGS`
         * puts a crossing at z -46, so the two tables intersected exactly
         * there. The same test found it, 0.25 m inside the collider. */
        patrol: [
          P(BERTHS[1].apron.x + 2, BERTHS[1].apron.z + 3),
          P(34, -131), P(34, -107), P(34, -131),
        ],
      },
      {
        position: P(-20, -34),
        type: 'friendly',
        name: 'Fitter Casimir Oyelaran',
        persona:
          'A hull fitter working berth three, usually up to the elbows in the Pike\'s gun bay and cheerful about it. Thinks the interceptor is the only honest ship in the yard and that the Bastion should have been cut up years ago.',
        patrol: [P(-20, -34), P(-12, -12), P(-16, -56), P(-12, -12)],
      },
      {
        position: P(8, -78),
        type: 'friendly',
        name: 'Signaller Wren Achebe',
        persona:
          'Keeps the blast-door signal post and the launch log. The log has one page and no entries on it. Patient, precise, and privately certain that the first launch out of this yard will be somebody who walked in through the gateway rather than anybody on the payroll.',
        patrol: [P(8, -78), P(0, -86), P(-10, -70), P(0, -86)],
      }
    );

    /* ── Viewpoints ─────────────────────────────────────────────────── */

    /* Three, not the four the brief lists. The fourth was the Bastion's dorsal
     * rib, and the Bastion is the next stage's: a viewpoint published on a
     * hull that does not exist yet is a marker on a platform nothing can stand
     * on, which is precisely the defect the reach probe exists to catch. The
     * id `bastion-rib` is reserved and unpublished.
     *
     * Every one of these is flooded to by `dock-reach.test.mjs` from the
     * arrival point, on foot, and back. */
    this.viewpoints.push(
      {
        id: 'crane-cab',
        name: 'The Crane Cab',
        x: CRANE_CAB.x, y: CRANE_CAB.y, z: CRANE_CAB.z,
        r: 2.6,
        /* The leap of faith. The launch point is the cab's open side and the
         * haystack is the tarped spares pile 13.1 m below — inside
         * `Parkour._softLandingAt`'s window, and the drop is over the 7.5 m
         * fall-damage threshold, which is the entire point of the soft
         * landing. */
        launch: { x: CRANE_CAB.x + 1.4, y: CRANE_CAB.y + 0.2, z: CRANE_CAB.z },
        bearing: Math.atan2(SPARES_PILE.x - CRANE_CAB.x, SPARES_PILE.z - CRANE_CAB.z),
        hay: { x: SPARES_PILE.x, y: SPARES_PILE.y, z: SPARES_PILE.z, r: SPARES_PILE.r },
      },
      {
        id: 'signal-post',
        name: 'The Blast-Door Signal Post',
        x: SIGNAL_POST.x, y: SIGNAL_POST.y, z: SIGNAL_POST.z, r: 2.0,
      },
      {
        id: 'north-crossing',
        name: 'The North Crossing',
        x: 0, y: GANTRY_Y, z: CROSSINGS[1], r: 3.0,
      },
      /* ── The two the open mouth is worth ──────────────────────────────
       * The perimeter catwalk's north run used to be a walkway along a wall
       * with a sealed door in it. It is now a bridge across a 164 m aperture
       * eight metres over the pier gates, with three planets in front of it:
       * the best thing to look at in this world, reached by the same two
       * stairs everything else on the gantry is.
       *
       * And the far end of Berth Zero, which is 240 m from the gateway, has
       * nothing on any side of it and is the point of the place. Both are
       * flooded to on foot by `dock-piers.test.mjs`. */
      {
        id: 'mouth-bridge',
        name: 'The Bay Mouth Bridge',
        x: 0, y: GANTRY_Y, z: (YARD_Z0 + GANTRY_Z0) / 2, r: 3.0,
      },
      {
        id: 'berth-zero',
        name: 'The End of Berth Zero',
        x: 0, y: DECK_Y, z: pierPad(pierOf('P0')).z1 + 3.0, r: 3.0,
      }
    );

    /* ── Minigame venues ────────────────────────────────────────────── */

    /* ONE venue, and it is the one whose game module exists.
     *
     * `MinigameManager.arm()` looks a venue's `kind` up in its factory map and
     * SKIPS a venue whose kind nobody registered - "a published slot, not an
     * error". That silence is why the hull-cutting bench the design asks for
     * is still not here: a `kind: 'hullcut'` row with no module behind it is a
     * prompt in the world that does nothing, and it is invisible to every test
     * that reads this array rather than the factory map. `test_fire` is
     * registered in `main.js` against `minigames/TestFire.js`, and
     * `scripts/quest-vocab.mjs` reads all three of those files - this array,
     * that registration and that module's `TEST_FIRE_GAME_ID` - before it will
     * offer a `minigame` step here a target.
     *
     * `yTolerance: 1.6` is the number that keeps the prompt underground. The
     * trench floor is 2.2 m below the deck, so a band of 1.6 excludes anybody
     * standing on the grating directly over the range: the offer appears when
     * you are IN the butts and not when you are walking above them.
     *
     * `requires: 'weapons'` mirrors `MinigameManager`'s own capability gate.
     * The rule is on in this world, so it changes nothing today - it is there
     * so that turning weapons off would take the range with it rather than
     * leaving a contest nobody can shoot. */
    this.minigameVenues = [
      {
        id: 'yard_butts',
        kind: 'test_fire',
        label: 'The Test-Fire Butts',
        centre: { x: 0, y: TRENCH_Y, z: (BUTTS_FIRE_Z + BUTTS_PLATES[BUTTS_PLATES.length - 1].z) / 2 },
        radius: 22,
        yTolerance: 1.6,
        reward: BUTTS_REWARD,
        requires: 'weapons',
        config: {
          fireMark: { x: 0, y: TRENCH_Y, z: BUTTS_FIRE_Z },
          cells: BUTTS_CELL_COST,
          seconds: BUTTS_SECONDS,
          ranks: BUTTS_RANKS.length,
          targets: BUTTS_PLATES.map((t) => ({ ...t })),
        },
      },
    ];

    /* ── Relic sites ────────────────────────────────────────────────────
     *
     * `Relics` wants 30 in a world this size and takes authored surfaces
     * first, then darts at the map for the rest. In a world with a ROOF the
     * dart is not a fallback, it is a defect generator: it starts at y 400 and
     * takes the first hit, which here is the shed's own roof plate at 26.8
     * every single time. Measured before this list was filled out: 20 authored
     * anchors survived the 14 m separation rule, four darts landed on the roof
     * and the wall head — (84, 27.35, -34), (84, 27.35, 21), (84, 27.35, -7),
     * (-87, 26.55, -21) — 18.8 m above the catwalk with the roof slab itself
     * as the ceiling in between. Four relics of 24 that no route in this world
     * reaches, which makes the set reward unobtainable here forever.
     *
     * The fix is not a guard in `Relics`; it is publishing enough ground that
     * the dart never runs. Every anchor below is a surface `dock-reach` floods
     * to on foot or `dock-hulls` proves as a climb, and the whole list is
     * pinned by `dock-reach`'s relic floor. */

    /* The four gantry corners.
     *
     * `GANTRY_X` is the INNER, guarded edge of the perimeter catwalk — the
     * walkway runs from there out to the wall at `YARD_X`. The first version
     * of this loop moved 3 m INBOARD of that edge, i.e. 3 m out over an 8 m
     * drop: the column at (-80.6, 52.6) held [-2.8, 0.12] and [26, 26.8] and
     * nothing at all at y 8, and the relic hung 3.27 m from the nearest body
     * position against a 2.0 m pickup radius. The centre line of the run is
     * `GANTRY_X + WALK_W / 2`. */
    const RUN_X = GANTRY_X + WALK_W / 2;
    for (const x of [-RUN_X, RUN_X]) {
      for (const z of [GANTRY_Z1 - 3, GANTRY_Z0 + 3]) {
        this._towers.push({ x, y: GANTRY_Y, z });
      }
    }
    // Both crossings, port and starboard of the keel line.
    for (const z of CROSSINGS) {
      this._roofs.push({ x: -34, y: GANTRY_Y, z });
      this._roofs.push({ x: 34, y: GANTRY_Y, z });
    }
    /* The long runs between the corners, and one on each end run. Six hundred
     * metres of catwalk with a relic only at its four corners is the same walk
     * four times; these are what make the perimeter worth the loop. */
    for (const x of [-RUN_X, RUN_X]) {
      for (const z of [18, -30]) this._roofs.push({ x, y: GANTRY_Y, z });
    }
    this._roofs.push({ x: 0, y: GANTRY_Y, z: (YARD_Z1 + GANTRY_Z1) / 2 });
    this._roofs.push({ x: -40, y: GANTRY_Y, z: (YARD_Z0 + GANTRY_Z0) / 2 });
    this._roofs.push({ x: 40, y: GANTRY_Y, z: (YARD_Z0 + GANTRY_Z0) / 2 });
    /* Two below the deck, because a hunt that never goes down is half a world:
     * the trench floor south of the butts and again at the northern bay, both
     * clear of the firing lane between z -24 and -40. */
    this._roofs.push({ x: 0, y: TRENCH_Y, z: -20 });
    this._roofs.push({ x: 0, y: TRENCH_Y, z: -64 });
    /* And two on the floor itself, at the two ends of the keel line — the
     * threshold in front of the bay mouth, and the apron the gateway opens
     * onto, which is where the first one anybody sees ought to be. */
    this._roofs.push({ x: 0, y: DECK_Y, z: YARD_Z0 + 8 });
    this._roofs.push({ x: 30, y: DECK_Y + 0.12, z: 46 });

    /* ── The piers ──────────────────────────────────────────────────────
     * Three anchors per pier: one on the spine halfway out, one on each side
     * of the head pad. Seventy-six metres of new walkable deck with nothing to
     * find on it would be seventy-six metres nobody walks twice, and — the
     * harder half — a world that publishes too FEW anchors falls back on the
     * dart, which out here has no roof to hit and no floor either.
     *
     * Every one is on deck at y 0 and at least 1.5 m inboard of a rail, which
     * is inside `Relics.PICKUP_R` of somewhere `dock-piers.test.mjs` floods
     * to on foot. */
    for (const p of PIERS) {
      const pad = pierPad(p);
      this._roofs.push({ x: p.x, y: DECK_Y, z: (MOUTH_Z + pad.z0) / 2 });
      this._towers.push({ x: p.x - (p.hw - 3.0), y: DECK_Y, z: pad.cz + p.hd * 0.55 });
      this._roofs.push({ x: p.x + (p.hw - 3.0), y: DECK_Y, z: pad.cz - p.hd * 0.55 });
    }

    /* ── Cache sites ────────────────────────────────────────────────────
     *
     * `Caches._findHigh` darts from y 320 and keeps the first hit, then
     * demands that five of eight probes on a 9 m ring fall away by 7 m. Under
     * a roof both halves fail together: measured, 400 of 400 darts into this
     * world landed on the roof plate at 26.80, every ring probe came back on
     * the same continuous plate, `sheer` was 0 every time and the yard placed
     * ZERO caches — silently, because the `[Caches]` log line only prints when
     * something landed. `CACHE_TABLES.dock` is the only in-world source of
     * `alloy_scrap`, `hull_plate` and `laser_cell` with `hostiles: false`, so
     * that also made quest 54 step 1 impossible and blocked 55-60 behind it,
     * including the launch this drop exists for.
     *
     * So the yard names its own, the way it names its relic ground, and
     * `Caches` takes an authored site over a dart. `y` is the site's own
     * height, not a surface to be lifted off. All three are round-trip
     * reachable on `dock-reach`'s walk graph and at least 30 m apart, which is
     * the separation `_findHigh` applies to authored sites too. */
    this._caches.push(
      { x: 0, y: TRENCH_Y + 0.25, z: -56 },
      { x: -RUN_X, y: GANTRY_Y + 0.2, z: 30 },
      { x: RUN_X, y: GANTRY_Y + 0.2, z: -60 },
      /* Two out on the piers, because a cache hunt that stops at the bay lip
       * is a hunt that never goes to the part of this world the player asked
       * for. Both are on pad deck, over 30 m from anything else in this list
       * and from each other, which is the separation `_findHigh` applies to
       * authored sites as well as to darts. */
      { x: PIERS[0].x + 4, y: DECK_Y + 0.25, z: pierPad(PIERS[0]).cz - 4 },
      { x: PIERS[4].x - 4, y: DECK_Y + 0.25, z: pierPad(PIERS[4]).cz + 4 },
    );

    /* ── Minimap ────────────────────────────────────────────────────── */

    this._mmRect(0, (YARD_Z0 + YARD_Z1) / 2, YARD_X * 2, YARD_Z1 - YARD_Z0, 0,
      'rgba(20,28,38,0.85)', 'rgba(159,184,200,0.9)');
    /* The piers, drawn BEFORE the keel line so the line runs over them. Each
     * is a spine rectangle and a head pad; without them the minimap says the
     * world ends at the bay lip, which is where three of the four ships now
     * are not. */
    for (const p of PIERS) {
      const pad = pierPad(p);
      this._mmRect(p.x, (MOUTH_Z + pad.z0) / 2, PIER_HW * 2, MOUTH_Z - pad.z0, 0,
        'rgba(20,28,38,0.8)', 'rgba(111,230,255,0.85)');
      this._mmRect(p.x, pad.cz, p.hw * 2, p.hd * 2, 0,
        p.dock ? 'rgba(159,216,255,0.18)' : 'rgba(20,28,38,0.8)',
        p.dock ? '#9fd8ff' : 'rgba(111,230,255,0.85)');
    }
    // The mouth: an open lip, not a wall.
    this._mmPath([[-MOUTH_HW, MOUTH_Z], [MOUTH_HW, MOUTH_Z]], 'rgba(159,216,255,0.6)', 3, false);
    this._mmPath([[0, YARD_Z1 - 2], [0, pierPad(pierOf('P0')).z1 + 2]], '#7fd8ef', 4, false);
    for (const b of BERTHS) {
      this._mmRect(b.x, b.z, b.hw * 2, b.hd * 2, b.yaw, 'rgba(255,179,71,0.16)', '#ffb347');
    }
    for (const [z0, z1] of TRENCH_RUNS) {
      this._mmPath([[0, z0], [0, z1]], 'rgba(201,161,60,0.9)', 6, false);
    }
    this._mmRect(OFFICE.x, OFFICE.z, OFFICE.w, OFFICE.d, 0, 'rgba(80,110,130,0.5)', '#9fb8c8');
    for (const c of COUNTERS) {
      this._mmCircle(COUNTER_X, c.z, 2.2, 'rgba(255,179,71,0.35)', '#ffb347');
    }
    this._mmCircle(0, PORTAL_STATION_Z, 4, 'rgba(159,184,200,0.25)', '#9fb8c8');
    this._mmCircle(0, PORTAL_SPACE_Z, 6, 'rgba(159,216,255,0.3)', '#9fd8ff');
    this._mmCircle(CRANE_CAB.x, CRANE_CAB.z, 2.6, 'rgba(79,227,255,0.25)', '#4fe3ff');

    console.info(
      `[dock] Lodestar Yard: ${FLOOR_AREA} m2 of floor, ${PIERS.length} piers, ` +
      `${this.shipSpecs.length} berths, ${this.colliders.length} colliders, ` +
      `${this.viewpoints.length} viewpoints, ${this.enterables.length} enterables`
    );
  }

  /* ---------------------------------------------------------------- */
  /* Runtime                                                           */
  /* ---------------------------------------------------------------- */

  /**
   * One distance-LOD pass and nothing else. The yard has no animation: the
   * crane is parked, the door is sealed, and the countdown board is a number
   * that has not changed since commissioning. A world that moved something
   * every frame to feel finished would be paying for the feeling.
   */
  update(dt) {
    if (this.engine?.camera) this._lod.update(this.engine.camera);
    /* One float. The containment field is the only thing in this world that
     * moves, and it moves because a static shimmer is a decal: what tells a
     * player that 164 m of open vacuum is being held back by something is that
     * the something is visibly working. `dt` is guarded because `World.update`
     * is also called from the harness with no argument, and `undefined` here
     * would put NaN into a uniform — which is the bloom blackout, from the one
     * place in this file a number is written every frame. */
    if (this._fieldTime) this._fieldTime.value += Number.isFinite(dt) ? dt : 0.016;
    /* The sky's own clock. `Ceraunus`' bands churn and `Erenmark`'s surface
     * grains against it, and both shaders divide nothing by it - but the same
     * NaN rule applies as above, so `dt` is guarded exactly once here. */
    const step = Number.isFinite(dt) ? dt : 0.016;
    for (let i = 0; i < this._voidTime.length; i++) {
      const u = this._voidTime[i]?.uniforms?.uTime;
      if (u) u.value += step;
    }
    /* The corona is a billboard. Without this it is a flat plane edge-on to
     * anyone not standing on the keel line, which reads as the star vanishing
     * as you walk across the bay. */
    if (this._voidCorona && this.engine?.camera) {
      this._voidCorona.quaternion.copy(this.engine.camera.quaternion);
    }
  }

  dispose() {
    this._lod?.clear?.();
    for (const m of this._voidMats) m.dispose?.();
    this._voidMats.length = 0;
    this._voidTime.length = 0;
    this._voidCorona = null;
    this._fieldTime = null;
    for (const t of this._textures) t?.dispose?.();
    this._textures.length = 0;
    for (const m of this._mats) {
      m.map?.dispose?.();
      m.normalMap?.dispose?.();
      m.roughnessMap?.dispose?.();
      m.emissiveMap?.dispose?.();
      m.dispose?.();
    }
    this._mats.length = 0;
    /* Clones only: their maps are the yard's and `_textures` has already freed
     * them, so disposing a map here would be the second dispose of a texture
     * that several hulls borrowed. */
    for (const m of this._shipMats) m.dispose?.();
    this._shipMats.length = 0;
    this.enterables.length = 0;
    this.viewpoints.length = 0;
    this.haystacks.length = 0;
    this.minigameVenues.length = 0;
    this.shipSpecs.length = 0;
    this.ships.length = 0;
    this._roofs.length = 0;
    this._towers.length = 0;
    this._caches.length = 0;
    super.dispose();
  }
}
