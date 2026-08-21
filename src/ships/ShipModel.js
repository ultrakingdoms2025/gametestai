import * as THREE from 'three';
import { Physics } from '../physics/Physics.js';
import { GeoBatch } from '../worlds/station/StationKit.js';
import { ShipBuild, shipMaterials } from '../worlds/dock/ShipKit.js';
import { buildKestrel, buildDray, buildPike } from '../worlds/dock/Hulls.js';
import { SHIP_TINTS, SHIP_CLASSES } from './ShipStats.js';
import { HULLS } from '../worlds/dock/HullPlan.js';

/**
 * THE HULL YOU CAN SEE FROM BEHIND.
 *
 * ===========================================================================
 *  WHY THIS FILE EXISTS AT ALL
 * ===========================================================================
 *
 * `Hulls.js` already draws all four hulls, and it draws them WELDED TO A
 * BERTH: `ShipBuild` takes `(x, y, z, yaw)` in its constructor and bakes that
 * transform into every vertex it emits, because a yard hull never moves and
 * merging 9,608 triangles into one static mesh is the whole reason the bay
 * renders in 32 draw calls.
 *
 * A flown ship is the opposite requirement: one object, moved every frame, in
 * a world that is not the yard and may not even be built. So this builds the
 * SAME geometry from the SAME builders at the origin with yaw 0, flushes it
 * into a `Group`, and hands the group back. Nothing about the hull changes;
 * only where the transform is applied - at draw time on a parent node instead
 * of at build time in the vertex buffer.
 *
 * That is deliberately not a second copy of the hull art. The failure it
 * avoids is one this project has hit repeatedly: two descriptions of the same
 * object drifting apart, so the ship on the pier and the ship you fly are
 * different ships and nobody notices for a month.
 *
 * ===========================================================================
 *  THE NOSE POINTS THE OTHER WAY, AND IT IS NOT A SIGN ERROR
 * ===========================================================================
 *
 * `HullPlan` puts every hull's NOSE at local +Z (`KESTREL.nose.z0/z1` is
 * 3.8..7.8, `tail` is -6.2..-4.4). `Flight` puts its forward vector at local
 * -Z (`FWD_LOCAL`), which is the three.js camera convention and the same one
 * `Player.forward` uses.
 *
 * Those two are 180 degrees apart and both are right in their own file. So the
 * model group carries a fixed `Math.PI` yaw offset - {@link NOSE_YAW} - and
 * `Piloting` composes it once per frame rather than every reader of either
 * file having to remember. A test asserts the composed nose lands within a
 * degree of `flight.forward()`, because a silent 180 here is a ship that flies
 * tail first and looks almost right in a screenshot.
 *
 * ===========================================================================
 *  COLLIDERS AND MATERIALS
 * ===========================================================================
 *
 * `ShipBuild` registers colliders as it builds - a hull is 40-odd boxes of
 * solid geometry. A FLOWN hull must register none of them: they would be baked
 * at the origin of whatever world happens to be live, and the player would
 * collide with an invisible ship parked at 0,0,0 forever after. So the build
 * gets a throwaway `Physics` and a `track` that drops what it is handed, and
 * the scratch world is cleared on the way out. `colliderCount` is reported so
 * a test can assert the number that WOULD have been registered is non-zero -
 * i.e. that the builders really ran - while the live world's count is
 * unchanged.
 *
 * Materials are cloned per model by `shipMaterials`, exactly as the yard does,
 * so a livery written onto the flown hull does not repaint the one on the pier
 * and vice versa. `slotMats` is handed back for `Livery.applyLivery`.
 */

/** Local yaw that turns a `HullPlan` hull (nose +Z) to face `Flight` forward (-Z). */
export const NOSE_YAW = Math.PI;

const BUILDERS = { kestrel: buildKestrel, dray: buildDray, pike: buildPike };

/** Hulls that can be flown. The Bastion is a hulk and has no builder here. */
export const FLYABLE = Object.freeze(['kestrel', 'dray', 'pike']);

/**
 * Build one flyable hull, centred on its own keel origin.
 *
 * @param {object} o
 * @param {string} o.id             'kestrel' | 'dray' | 'pike'
 * @param {Record<string, THREE.Material>} o.yardMaterials the live `DockWorld.mat`
 * @returns {{group:THREE.Group, slotMats:object, owned:THREE.Material[],
 *            dispose:()=>void, colliderCount:number, radius:number, length:number}}
 */
export function buildShipModel({ id, yardMaterials }) {
  const build = BUILDERS[id];
  if (!build) throw new Error(`[ShipModel] "${id}" is not flyable - ${FLYABLE.join(', ')}`);
  if (!yardMaterials?.plate) {
    throw new Error('[ShipModel] needs the live yard material set (DockWorld.mat)');
  }

  const { mats, owned, slotMats } = shipMaterials(yardMaterials, SHIP_TINTS[id]);

  const group = new THREE.Group();
  group.name = `ship:${id}`;
  /* The hull's own yaw offset lives on the model, not on the flight
   * quaternion: `Flight` must keep meaning exactly what its own tests say it
   * means, and a caller that reads `flight.quaternion` for a laser muzzle or a
   * nav marker has to get the flight frame, not a hull-dressed one. */
  group.rotation.y = NOSE_YAW;

  const loose = new THREE.Group();
  loose.name = `ship:${id}:loose`;
  group.add(loose);

  const exterior = new GeoBatch();
  const interior = new GeoBatch();
  const scratch = new Physics(null);
  let colliderCount = 0;

  const b = new ShipBuild({
    batch: exterior,
    interior,
    physics: scratch,
    track: (c) => { colliderCount++; return c; },
    group: loose,
    x: 0, y: 0, z: 0, yaw: 0,
    /* THE BERTH DOES NOT COME WITH YOU. See `ShipBuild.yard`: with this false
     * the builders skip the berth stencil, the boarding brow and the Pike's
     * yard scaffold, all three of which used to be welded into the flown hull
     * and photographed in deep space. */
    yard: false,
  });

  /* `side` is which flank the boarding hatch is cut in. -1 for every berth in
   * the yard (`boardSide` derives it from the apron and all three walkable
   * hulls board to port), so the flown hull matches the parked one. */
  build(b, -1, 0, mats);

  const meshes = exterior.flush(group, mats, `ship-${id}`, {
    glass: { cast: false, recv: false },
    glow: { cast: false, recv: false },
    warn: { cast: false, recv: false },
    lamp: { cast: false, recv: false },
    danger: { cast: false, recv: false },
    hazard: { cast: false, recv: true },
    signs: { cast: false, recv: true },
  });
  /* The interior is flushed too, and it is 468-848 triangles. It is not for
   * looking at from the chase camera - it is so that the hull is not a hollow
   * shell when the camera clips it during a hard landing, which is the one
   * moment a player is inside their own hull with the lights on. */
  const inner = interior.flush(group, mats, `ship-${id}-in`, {
    glow: { cast: false, recv: false },
    warn: { cast: false, recv: false },
  });

  /* Nothing on a flown hull is culled per-mesh: the group is one object, it is
   * always the thing the camera is pointed at, and a merged bucket's bounding
   * sphere is computed in the BUILD frame - which is not where the ship is. */
  for (const m of meshes) m.frustumCulled = false;
  for (const m of inner) m.frustumCulled = false;
  for (const m of loose.children) if (m.isMesh) m.frustumCulled = false;

  /* THE HULL'S OWN BOXES, KEPT - in hull-local metres, before the scratch
   * world is thrown away.
   *
   * A FLOWN hull must register nothing (see the header). A LANDED one must:
   * driven on Ashfall Flat, the player stepped out at (145.7, 8.79, 210.9) and
   * walked a straight line THROUGH the hull centre to (161.5, 8.79, 189.2) in
   * 5.9 s with no obstruction and no change in Y, and standing beside the ship
   * put the camera inside the Kestrel's belly plating. So the specs are kept
   * and `Piloting` re-registers them against the live world for exactly as long
   * as the ship is standing on a surface.
   *
   * Local, not world: `ShipBuild` was given `x/y/z = 0, yaw = 0`, so a box's
   * matrix translation IS its hull-local centre and its rotation is pure Y.
   * `Piloting._addHullSolid` composes that with the landed pose, which is a
   * pure yaw because every touchdown levels the hull through `_settle`. */
  /* ── THE EXHAUST ────────────────────────────────────────────────────────
   * A cone per bell, additive, scaled and faded by the throttle.
   *
   * It is the cheapest "this is a spaceship" cue in the genre and it was
   * missing entirely: `Piloting._poseModel` wrote a position and a quaternion
   * and nothing else, `grep -rn "plume\|exhaust\|thrustGlow" src/ships/` came
   * back empty, and 200 frames at `throttle: 1` were pixel-identical at the
   * nozzles to the parked hull. Full burn, boost, airbrake and reverse all
   * looked the same from the seat.
   *
   * `toneMapped: false` with channel values over 1.6 is the same trick the
   * yard's bay mouth and the skiff's engine strips use: it is what carries the
   * core past the space grade's bloom threshold so a burn reads as heat rather
   * than as a painted cone. `depthWrite: false` and additive so two plumes
   * overlapping do not cut each other out.
   *
   * The geometry is built once with its apex aft, so `setThrust` is four
   * float writes per bell and allocates nothing. */
  const plumeMat = new THREE.MeshBasicMaterial({
    color: new THREE.Color(2.6, 1.75, 3.0),
    transparent: true, opacity: 0, depthWrite: false, fog: false, toneMapped: false,
    blending: THREE.AdditiveBlending, side: THREE.DoubleSide,
  });
  owned.push(plumeMat);
  const plumes = [];
  for (const nz of b.nozzles) {
    const len = Math.max(1.2, nz.r * 5.2);
    const geo = new THREE.ConeGeometry(nz.r * 0.94, len, 12, 1, true);
    /* Cone's axis is +Y with the apex at +Y. `-PI/2` about X sends the apex to
     * -Z, which is AFT in the hull's own frame (the plan's nose is +Z). */
    geo.rotateX(-Math.PI / 2);
    const m = new THREE.Mesh(geo, plumeMat);
    m.name = `ship:${id}:plume`;
    /* The cone's base sits exactly on the bell's exit plane. */
    m.position.set(nz.lx, nz.ly, nz.lz - len / 2);
    m.frustumCulled = false;
    m.renderOrder = 3;
    loose.add(m);
    plumes.push(m);
  }

  const hullBoxes = [];
  for (const c of scratch.colliders) {
    if (c.type !== 'box' || !c.matrix || !c.halfExtents) continue;
    const e = c.matrix.elements;
    hullBoxes.push({
      x: e[12], y: e[13], z: e[14],
      hx: c.halfExtents.x, hy: c.halfExtents.y, hz: c.halfExtents.z,
      ry: Math.atan2(e[8], e[10]),
    });
  }

  scratch.clear();

  const plan = HULLS[id];
  const length = plan ? plan.z1 - plan.z0 : 16;
  /* Bounding radius, for the landing probe and the dock-approach test. Taken
   * from the plan rather than from the merged geometry, because the merged
   * bounding sphere is centred on the keel origin, which is not the hull
   * centre, and a radius measured from the wrong centre is landing gear that
   * sinks. */
  const radius = Math.max(Math.abs(plan?.z0 ?? 8), Math.abs(plan?.z1 ?? 8));

  const geoms = [];
  for (const m of [...meshes, ...inner]) geoms.push(m.geometry);
  // The plume cones are built here rather than by the batch, so `dispose` has
  // to be told about them or they leak one geometry per bell per hull.
  for (const m of plumes) geoms.push(m.geometry);

  return {
    group,
    slotMats,
    owned,
    colliderCount,
    /** Hull-local solid boxes, for a ship standing on the ground. See above. */
    hullBoxes,
    /**
     * How hard the engines are burning, 0 to 1 (over 1 for boost).
     *
     * Called once per frame from `Piloting._poseModel`. Idle is not zero: a
     * ship under way with dead-black bells reads as adrift, so the floor is a
     * visible pilot light and the throttle is what makes it a burn.
     * @param {number} t
     */
    setThrust(t) {
      const v = Math.max(0, Math.min(1.6, t));
      plumeMat.opacity = Math.min(1, 0.10 + v * 0.62);
      for (let i = 0; i < plumes.length; i++) {
        plumes[i].scale.set(0.72 + v * 0.34, 0.72 + v * 0.34, 0.22 + v * 1.25);
      }
    },
    /** Bells this hull carries. Zero means the exhaust is a no-op. */
    plumeCount: plumes.length,
    radius,
    length,
    /* Top of the walkable dorsal spine, in hull-local metres. The chase camera
     * lifts by a fraction of it - see `Piloting._composeCamera` - because a
     * boom height measured from the KEEL puts the camera level with the belly
     * of a hull whose spine is five metres up, and you end up looking at the
     * underside of your own ship. Kestrel 5.16, Pike 5.6, Dray 7.5. */
    spineY: plan?.spine?.y ?? 5,
    displayName: SHIP_CLASSES[id]?.name ?? id,
    dispose() {
      for (const g of geoms) g.dispose();
      for (const m of owned) m.dispose?.();
      group.parent?.remove(group);
      group.clear();
    },
  };
}
