import * as THREE from 'three';
import { boxGeo, cylGeo, uvScale, instanced } from './StationKit.js';

/**
 * A tall building you can actually go inside.
 *
 * ── What was wrong ────────────────────────────────────────────────────────
 * The station was full of seven- and nine-storey towers - the habitat stacks,
 * the residential cap blocks, the skyline - and every one of them was a solid
 * box. `_block` draws a facade, glazes it floor by floor, puts a lit entrance
 * canopy on the front, and then registers the whole mass as one collider. From
 * the deck they read as buildings; the moment you walked up to a door you
 * found there was no door, and the nine floors of windows were a texture.
 *
 * This builds the same silhouette out of parts you can be inside: a shell with
 * a real doorway, a floor plate at every storey, a lift that stops at all of
 * them, and two banks of escalators running the full height in a scissor so
 * the stairs are somewhere to look down as well as somewhere to climb.
 *
 * ── The section, and why it is this one ───────────────────────────────────
 * Every floor is identical in plan, which is what makes seven of them
 * affordable - the slab partition, the core and the escalator geometry are
 * computed once and repeated. The plan is:
 *
 *      -X                                                      +X
 *   +Z  +---------------------------------------------------+
 *       |  well   |                                |  slab  |     back
 *       |=========|          open floor            |        |
 *       | lane A  |                                |        |
 *       | lane B  |                                +--------+
 *       |=========|                                |  LIFT  |
 *   -Z  +---------------------------------------------------+     front (door)
 *
 * The escalator well is an atrium: a 10 m void through every slab with two
 * 3.6 m lanes side by side. Even floors climb on lane A heading +Z, odd floors
 * on lane B heading -Z, so consecutive flights never cross in plan. That last
 * part is not cosmetic - the first arrangement put both lanes in one 4.6 m
 * band and the down-flight's soffit passed 0.58 m over the up-flight's landing,
 * which is a head-height beam across the only route through the building.
 *
 * The lift is in the front corner, on the same side as the door, so somebody
 * who walks in has both routes up in front of them and does not have to learn
 * the floor plan to find either.
 */

/** Storey height. 3.9 m gives 2.4 m of headroom under a 0.35 m slab plus services. */
const FLOOR_H = 3.9;
/** Escalator pitch. 30 degrees is the real-world standard and, more to the point,
 *  well under the ~50 degrees `Physics.resolveCapsule` counts as walkable. */
const ESC_RISE_RUN = Math.tan(30 * Math.PI / 180);
const SLAB_T = 0.35;
const WALL_T = 0.4;
/**
 * Height of the plinth the shell stands on.
 *
 * Matches `_block`'s, because these towers stand in a row with buildings made
 * by it and a plinth that is not the same height reads as subsidence. The
 * consequence is that the ground floor is at 0.9, not at 0 - which is exactly
 * the mistake the first version of this file made. Every floor level, lift
 * stop, escalator foot and door pivot is measured from `floorY`, and `floorY(0)`
 * has to be the plinth top or the whole building is nine tenths of a metre out
 * of register with its own front door.
 */
const PLINTH = 0.9;

/**
 * @typedef {object} TowerSpec
 * @property {number} x        world X of the tower centre
 * @property {number} z        world Z
 * @property {number} yaw      world yaw; the entrance faces local -Z
 * @property {number} w        footprint width  (local X)
 * @property {number} d        footprint depth  (local Z)
 * @property {number} floors   number of walkable storeys, >= 7
 * @property {string} label    name shown by the Interiors prompt
 * @property {string} accent   emissive material key for this district
 * @property {string} [body]   cladding material key
 * @property {'hab'|'office'} [fit]
 */

/**
 * @param {import('../StationWorld.js').StationWorld} world
 * @param {import('./StationKit.js').GeoBatch} B  batch the caller will flush
 * @param {THREE.Group} g                          group for dynamic parts (lift cars)
 * @param {TowerSpec} spec
 * @param {() => number} rng
 * @returns {{ enterable: object, height: number, roofY: number }}
 */
export function buildTower(world, B, g, spec, rng) {
  const M = world.mat;
  const { x, z, yaw, w, d } = spec;
  const floors = Math.max(7, spec.floors | 0);
  const body = spec.body ?? 'panel';
  const accent = spec.accent ?? 'emCyan';

  /* Interior extents. */
  const ix = w / 2 - WALL_T;      // +/- interior X
  const iz = d / 2 - WALL_T;      // +/- interior Z

  /* The escalator well and the lift shaft, in local coordinates. */
  const WELL_X0 = -ix, WELL_X1 = -ix + 8.2;
  const WELL_Z0 = -5.0, WELL_Z1 = 5.0;
  const LANE_A = WELL_X0 + 1.8;   // even floors, climbing +Z
  const LANE_B = WELL_X1 - 1.8;   // odd floors, climbing -Z
  const LANE_HALF = 1.75;

  const SHAFT_HALF = 2.3;
  const SHAFT_X = ix - SHAFT_HALF;
  const SHAFT_Z = -iz + SHAFT_HALF;

  const floorY = (f) => PLINTH + f * FLOOR_H;
  const roofY = floorY(floors);
  const height = roofY + 1.5;

  /* Local -> world, matching `GeoBatch.localAt` exactly. */
  const cs = Math.cos(yaw), sn = Math.sin(yaw);
  const P = (lx, ly, lz) => new THREE.Vector3(x + lx * cs + lz * sn, ly, z - lx * sn + lz * cs);
  const put = (key, geo, lx, ly, lz, ry = 0, rx = 0, rz = 0) =>
    B.localAt(key, geo, x, 0, z, yaw, lx, ly, lz, ry, rx, rz);
  const solid = (lx, ly, lz, hx, hy, hz) => {
    const p = P(lx, ly, lz);
    return world._solidRot(p.x, p.y, p.z, hx, hy, hz, yaw);
  };

  /* ---------------------------------------------------------------- */
  /* Shell                                                             */
  /* ---------------------------------------------------------------- */

  // Plinth. Its top face IS the ground floor.
  put('panelDark', boxGeo(w + 0.8, PLINTH, d + 0.8, 2), 0, PLINTH / 2, 0);
  solid(0, PLINTH / 2, 0, (w + 0.8) / 2, PLINTH / 2, (d + 0.8) / 2);

  const DOOR_HW = 1.6, DOOR_H = 3.0;
  const shellH = height - PLINTH;

  /* Steps up to the threshold.
   *
   * Without these the door is a 0.9 m ledge and the building is unenterable -
   * which is the same defect this whole file exists to fix, just moved outside.
   * The treads are drawn and the collision is a single hidden ramp under them,
   * because the capsule solver resolves slopes and does not do step-up: a stack
   * of 0.3 m boxes looks right and stops the player dead at the first riser.
   * `_ramp` exists for exactly this.
   */
  const STEP_RUN = 3.4;
  for (let s = 0; s < 3; s++) {
    const t = (s + 0.5) / 3;
    put('trim', boxGeo(DOOR_HW * 2 + 2.6, PLINTH / 3 + 0.06, STEP_RUN / 3, 2),
      0, (PLINTH * (s + 0.5)) / 3, -(d / 2) - STEP_RUN + (STEP_RUN * (s + 0.5)) / 3);
    void t;
  }
  {
    const rp = P(0, PLINTH / 2, -(d / 2) - STEP_RUN / 2);
    // The ramp climbs toward the door, which is local +Z from out here.
    world._ramp(rp.x, rp.y, rp.z, DOOR_HW * 2 + 2.6, STEP_RUN, PLINTH, yaw);
  }

  /* Three solid walls and a fourth split around the entrance. Walls, not one
   * box: the whole point of this file is that the middle is hollow. */
  for (const [lx, lz, hx, hz] of [
    [0, iz + WALL_T / 2, w / 2, WALL_T / 2],                    // back
    [-(ix + WALL_T / 2), 0, WALL_T / 2, d / 2],                 // left
    [ix + WALL_T / 2, 0, WALL_T / 2, d / 2],                    // right
  ]) {
    put(body, boxGeo(hx * 2, shellH, hz * 2, 2.5), lx, PLINTH + shellH / 2, lz);
    solid(lx, PLINTH + shellH / 2, lz, hx, shellH / 2, hz);
  }
  // Front wall, either side of the doorway, plus the lintel over it.
  const frontSeg = (w / 2 - DOOR_HW) / 2;
  for (const s of [-1, 1]) {
    const cx = s * (DOOR_HW + frontSeg);
    put(body, boxGeo(frontSeg * 2, shellH, WALL_T, 2.5), cx, PLINTH + shellH / 2, -(iz + WALL_T / 2));
    solid(cx, PLINTH + shellH / 2, -(iz + WALL_T / 2), frontSeg, shellH / 2, WALL_T / 2);
  }
  put(body, boxGeo(DOOR_HW * 2 + 0.6, shellH - DOOR_H, WALL_T, 2.5), 0, PLINTH + DOOR_H + (shellH - DOOR_H) / 2, -(iz + WALL_T / 2));
  solid(0, PLINTH + DOOR_H + (shellH - DOOR_H) / 2, -(iz + WALL_T / 2), DOOR_HW + 0.3, (shellH - DOOR_H) / 2, WALL_T / 2 + 0.04);

  // Corner pilasters - the silhouette break `_block` uses, kept so a hollow
  // tower still photographs like its solid neighbours.
  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) {
      put('panelDark', boxGeo(1.2, shellH, 1.2, 2), sx * (w / 2 - 0.4), PLINTH + shellH / 2, sz * (d / 2 - 0.4));
    }
  }

  // Entrance canopy, lit soffit, and the building's name over the door.
  put('panelDark', boxGeo(6.2, 0.45, 2.8, 2), 0, 4.3, -(d / 2 + 1.2));
  put(accent, boxGeo(5.4, 0.14, 2.0, 1), 0, 4.03, -(d / 2 + 1.2));
  for (const sx of [-2.7, 2.7]) {
    put('trim', cylGeo(0.14, 0.14, 4.0, 6, 2), sx, 2.1, -(d / 2 + 1.2));
  }
  put(accent, boxGeo(4.6, 0.16, 0.24, 1), 0, 4.55, -(d / 2 + 0.1));

  /* ---------------------------------------------------------------- */
  /* Floor plates                                                      */
  /* ---------------------------------------------------------------- */

  /**
   * Each slab is four rectangles around the two voids. Partitioning by X band
   * rather than by a panel grid keeps it to four colliders per floor instead of
   * a hundred - and the capsule solver's cost is the number of candidate boxes,
   * not their size.
   */
  const slabRects = [
    [WELL_X0, WELL_X1, -iz, WELL_Z0],                 // in front of the well
    [WELL_X0, WELL_X1, WELL_Z1, iz],                  // behind the well
    [WELL_X1, SHAFT_X - SHAFT_HALF, -iz, iz],         // the open floor
    [SHAFT_X - SHAFT_HALF, ix, SHAFT_Z + SHAFT_HALF, iz], // beside the lift
  ];

  for (let f = 0; f < floors; f++) {
    const y = floorY(f);
    for (const [x0, x1, z0, z1] of slabRects) {
      const cw = x1 - x0, cd = z1 - z0;
      if (cw <= 0.05 || cd <= 0.05) continue;
      const cx = (x0 + x1) / 2, cz = (z0 + z1) / 2;
      if (f > 0) {
        put('grate', boxGeo(cw, SLAB_T, cd, 2), cx, y - SLAB_T / 2, cz);
        solid(cx, y - SLAB_T / 2, cz, cw / 2, SLAB_T / 2, cd / 2);
      } else {
        // Ground floor sits on the plinth, which is already solid.
        put('deck', boxGeo(cw, 0.1, cd, 3), cx, 0.95, cz);
      }
      // Ceiling services under every slab above the ground floor.
      if (f > 0) {
        put('trimDark', boxGeo(cw * 0.9, 0.18, 0.3, 1), cx, y - SLAB_T - 0.2, cz);
        put('emWhite', boxGeo(cw * 0.8, 0.08, 0.16, 1), cx, y - SLAB_T - 0.32, cz);
      }
    }

    /* Balustrade round the well - a 10 m hole with no edge protection is the
     * first thing a player falls down and the last thing they forgive.
     *
     * ── Which side is left open, and why it is the whole side ─────────────
     * One end of the well is the escalator opening and the other is a plain
     * edge. Both flights that touch a floor cross the SAME end of it:
     *
     *   even floor  the up-flight leaves on lane A from z=-6, and the flight
     *               arriving from the odd floor below lands on lane B and runs
     *               out to z=-5. Both cross z=-5.
     *   odd floor   the arrival from the even floor below lands on lane A and
     *               runs out to z=+5, and the up-flight leaves on lane B from
     *               z=+6. Both cross z=+5.
     *
     * So the open end alternates with floor parity, and both lanes need it -
     * which is why the whole run goes rather than a gap per lane. The first
     * version cut one lane-width gap and got the parity off by one, so every
     * floor's rail ran straight across its own escalator: a capsule marched up
     * flight 0 climbed 0.88 m of the 3.9 it should have and stopped dead at
     * z=-5. Nothing about that is visible from outside the building.
     *
     * The open edge is not unguarded - the flight's own balustrades run up both
     * sides of it, which is exactly how a real escalator opening is protected.
     */
    railRect(put, solid, WELL_X0, WELL_X1, WELL_Z0, WELL_Z1, y, accent, {
      openZ0: f % 2 === 0,
      openZ1: f % 2 === 1,
    });

    // Window band on all four faces.
    const ly = y + FLOOR_H * 0.55;
    for (const [face, span, lz2, ry] of [
      ['front', w - 5.5, -(d / 2 + 0.03), Math.PI],
      ['back', w - 5.5, d / 2 + 0.03, 0],
    ]) {
      void face;
      put('glassWindow', new THREE.PlaneGeometry(span, FLOOR_H * 0.5), 0, ly, lz2, ry);
      put('trim', boxGeo(span + 0.6, 0.18, 0.22, 1), 0, ly - FLOOR_H * 0.27, lz2);
      put('trim', boxGeo(span + 0.6, 0.18, 0.22, 1), 0, ly + FLOOR_H * 0.27, lz2);
    }
    for (const sx of [-1, 1]) {
      put('glassWindow', new THREE.PlaneGeometry(d - 5.5, FLOOR_H * 0.5), sx * (w / 2 + 0.03), ly, 0, sx > 0 ? Math.PI / 2 : -Math.PI / 2);
    }
    // String course, so the stack of floors reads from outside.
    put('trim', boxGeo(w + 0.5, 0.22, d + 0.5, 2), 0, y + FLOOR_H - 0.11, 0);
  }

  /* ---------------------------------------------------------------- */
  /* Escalators                                                        */
  /* ---------------------------------------------------------------- */

  const escalators = [];
  const treadEntries = [];
  for (let f = 0; f < floors - 1; f++) {
    const even = f % 2 === 0;
    const lane = even ? LANE_A : LANE_B;
    const dir = even ? 1 : -1;                    // +Z on lane A, -Z on lane B
    const run = FLOOR_H / ESC_RISE_RUN;           // 6.75 m
    const z0 = -dir * (WELL_Z1 + 1.0);            // starts on the solid slab
    const z1 = z0 + dir * run;
    const y0 = floorY(f), y1 = floorY(f + 1);
    const cz = (z0 + z1) / 2, cy = (y0 + y1) / 2;
    const len = Math.hypot(run, FLOOR_H);
    // A ramp climbing along +Z needs a NEGATIVE pitch about X in this frame;
    // getting that sign wrong builds a slide instead of a staircase, and the
    // capsule happily walks down it into the floor below.
    const pitch = -dir * Math.atan2(FLOOR_H, run);

    // Truss, balustrades and handrails.
    put('panelDark', boxGeo(LANE_HALF * 2 + 0.5, 0.7, len, 3), lane, cy - 0.55, cz, 0, pitch);
    put('grate', boxGeo(LANE_HALF * 2, 0.14, len, 2), lane, cy - 0.05, cz, 0, pitch);
    for (const s of [-1, 1]) {
      put('glassWindow', new THREE.PlaneGeometry(len, 1.05), lane + s * (LANE_HALF + 0.06), cy + 0.55, cz, s > 0 ? -Math.PI / 2 : Math.PI / 2, 0, pitch);
      put('trimDark', boxGeo(0.22, 0.22, len, 1), lane + s * (LANE_HALF + 0.06), cy + 1.12, cz, 0, pitch);
      put(accent, boxGeo(0.1, 0.08, len, 1), lane + s * (LANE_HALF + 0.06), cy + 1.24, cz, 0, pitch);
    }

    /* Treads. Instanced boxes that slide along the slope and wrap, rather than
     * a scrolling texture: the material is shared with every other grate in the
     * world, so animating its `map.offset` would set the whole station moving. */
    const STEPS = 22;
    const step = len / STEPS;
    for (let i = 0; i < STEPS; i++) {
      const t = i / STEPS;
      const px = lane;
      const py = y0 + FLOOR_H * t + 0.06;
      const pz = z0 + dir * run * t;
      treadEntries.push([px, py, pz, pitch, 0, 0, 1, 1, 1]);
    }
    escalators.push({
      first: treadEntries.length - STEPS, count: STEPS,
      lane, dir, z0, y0, runH: run, rise: FLOOR_H, len, pitch, step,
      // World-space data the player assist needs.
      world: {
        a: P(lane, y0, z0),
        b: P(lane, y1, z1),
        halfW: LANE_HALF,
      },
    });

    /* Ramp collider. This is what the player actually stands on.
     *
     * `_ramp` centres a 0.5 m thick box on the point it is given, so the
     * surface a capsule rests on is a quarter of a metre above it - measured
     * vertically, that is 0.25/cos(pitch), because the slab is tilted. Passing
     * the tread line straight through would float the player 29 cm over the
     * steps; this puts the collision surface just under the tread tops so feet
     * meet the geometry they appear to be standing on.
     *
     * It also measures its run along the local +Z of the yaw it is handed, so a
     * flight heading -Z is the same ramp turned round.
     */
    const surfaceY = cy + 0.10;
    const rp = P(lane, surfaceY - 0.25 / Math.cos(Math.abs(pitch)), cz);
    world._ramp(rp.x, rp.y, rp.z, LANE_HALF * 2, run, FLOOR_H, dir > 0 ? yaw : yaw + Math.PI);

    // Top landing, bridging from the flight's head to the solid slab.
    const lz0 = z1, lz1 = dir * WELL_Z1;
    const lcz = (lz0 + lz1) / 2, lcd = Math.abs(lz1 - lz0);
    if (lcd > 0.2) {
      put('grate', boxGeo(LANE_HALF * 2, SLAB_T, lcd, 2), lane, y1 - SLAB_T / 2, lcz);
      solid(lane, y1 - SLAB_T / 2, lcz, LANE_HALF, SLAB_T / 2, lcd / 2);
    }
    // Comb plates top and bottom.
    for (const [pz, py] of [[z0, y0], [z1, y1]]) {
      put('hazard', boxGeo(LANE_HALF * 2, 0.12, 0.9, 1), lane, py + 0.06, pz);
    }
  }
  if (treadEntries.length) {
    const treads = instanced(boxGeo(LANE_HALF * 2 - 0.12, 0.12, 0.42, 1), M.chrome, treadEntries, { cast: false, recv: true });
    if (treads.isInstancedMesh) {
      // Local -> world for the whole bank in one transform, so the per-frame
      // update can work entirely in the tower's own frame.
      treads.position.set(x, 0, z);
      treads.rotation.y = yaw;
      g.add(treads);
      /* 1.15 m/s along the slope.
       *
       * A real escalator runs at 0.5-0.75, and at 0.62 a single storey took
       * twelve and a half seconds - so a seven-storey climb was a minute and a
       * half of standing still, and every player would have taken the lift once
       * and never looked at the escalators again. This is fast for a building
       * and right for a game: a storey in under seven seconds, which is about
       * as long as the ride stays interesting. */
      (world._escalators ??= []).push({ mesh: treads, runs: escalators, speed: 1.15 });
    }
  }

  /* ---------------------------------------------------------------- */
  /* Lift                                                              */
  /* ---------------------------------------------------------------- */

  const stops = [];
  for (let f = 0; f < floors; f++) stops.push(floorY(f) + 0.02);

  // Shaft: three walls and an open face toward the floor plate.
  for (const [lx, lz, hx, hz] of [
    [SHAFT_X, SHAFT_Z - SHAFT_HALF - 0.15, SHAFT_HALF + 0.3, 0.15],
    [SHAFT_X + SHAFT_HALF + 0.15, SHAFT_Z, 0.15, SHAFT_HALF + 0.3],
    [SHAFT_X, SHAFT_Z + SHAFT_HALF + 0.15, SHAFT_HALF + 0.3, 0.15],
  ]) {
    put('panelDark', boxGeo(hx * 2, roofY, hz * 2, 3), lx, roofY / 2, lz);
    solid(lx, roofY / 2, lz, hx, roofY / 2, hz);
  }
  // Door surround and a call plate at every stop, on the open face.
  for (let f = 0; f < floors; f++) {
    const y = floorY(f);
    put('trim', boxGeo(0.2, 2.7, SHAFT_HALF * 2 + 0.4, 2), SHAFT_X - SHAFT_HALF - 0.1, y + 1.35, SHAFT_Z);
    put(accent, boxGeo(0.12, 0.14, SHAFT_HALF * 2, 1), SHAFT_X - SHAFT_HALF - 0.2, y + 2.55, SHAFT_Z);
    put('emWhite', boxGeo(0.08, 0.3, 0.22, 1), SHAFT_X - SHAFT_HALF - 0.22, y + 1.5, SHAFT_Z - SHAFT_HALF + 0.5);
  }

  const plateThick = 0.2;
  const carP = P(SHAFT_X, 0, SHAFT_Z);
  const collider = world.track(
    world.physics.addRotatedBox(
      new THREE.Vector3(carP.x, stops[0] - plateThick / 2, carP.z),
      new THREE.Vector3(SHAFT_HALF - 0.12, plateThick / 2, SHAFT_HALF - 0.12),
      yaw,
      { solid: true }
    )
  );

  const car = new THREE.Group();
  const plate = new THREE.Mesh(boxGeo((SHAFT_HALF - 0.12) * 2, plateThick, (SHAFT_HALF - 0.12) * 2, 2), M.grate);
  plate.position.y = -plateThick / 2;
  plate.castShadow = plate.receiveShadow = true;
  car.add(plate);
  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) {
      const post = new THREE.Mesh(boxGeo(0.14, 2.5, 0.14, 1), M.trim);
      post.position.set(sx * (SHAFT_HALF - 0.2), 1.25, sz * (SHAFT_HALF - 0.2));
      car.add(post);
    }
  }
  const canopy = new THREE.Mesh(boxGeo((SHAFT_HALF - 0.12) * 2, 0.16, (SHAFT_HALF - 0.12) * 2, 2), M.panelDark);
  canopy.position.y = 2.55;
  car.add(canopy);
  const lamp = new THREE.Mesh(boxGeo((SHAFT_HALF - 0.5) * 2, 0.08, 0.3, 1), M[accent] ?? M.emWhite);
  lamp.position.y = 2.42;
  car.add(lamp);
  car.position.set(carP.x, stops[0], carP.z);
  car.rotation.y = yaw;
  g.add(car);

  const callP = P(SHAFT_X - SHAFT_HALF - 0.7, 0, SHAFT_Z);
  const lift = {
    id: `tower_lift_${Math.round(x)}_${Math.round(z)}`,
    collider,
    car,
    plateThick,
    stops,
    stopIndex: 0,
    target: 0,
    pos: stops[0],
    /* 4.2 m/s, well above the 2.6 the medieval towers use. Those are three
     * storeys; this is seven, and at 2.6 the full ride is eleven seconds of
     * standing still, which is long enough that players take the escalators
     * once and never touch the lift again. */
    speed: 4.2,
    callPos: new THREE.Vector3(callP.x, stops[0], callP.z),
    footprint: { cx: carP.x, cz: carP.z, half: SHAFT_HALF },
  };

  /* ---------------------------------------------------------------- */
  /* Door                                                              */
  /* ---------------------------------------------------------------- */

  const doorZ = -(d / 2 + 0.06);
  const leaves = [];
  for (const s of [-1, 1]) {
    const pivot = new THREE.Group();
    pivot.position.copy(P(s * DOOR_HW, PLINTH + (DOOR_H - 0.1) / 2, doorZ));
    pivot.rotation.y = yaw;
    const leafGeo = boxGeo(DOOR_HW - 0.04, DOOR_H - 0.14, 0.14, 1.2);
    leafGeo.translate((-s * (DOOR_HW - 0.04)) / 2, 0, 0);
    const leaf = new THREE.Mesh(leafGeo, M.panelDark);
    leaf.castShadow = leaf.receiveShadow = true;
    pivot.add(leaf);
    const band = new THREE.Mesh(boxGeo((DOOR_HW - 0.04) * 0.8, 0.1, 0.18, 1), M[accent] ?? M.emCyan);
    band.position.set((-s * (DOOR_HW - 0.04)) / 2, 0.5, -0.02);
    pivot.add(band);
    g.add(pivot);
    leaves.push({ pivot, closed: yaw, open: yaw + s * Math.PI * 0.52 });
  }
  const doorCollider = world.track(
    world.physics.addRotatedBox(
      P(0, PLINTH + DOOR_H / 2, -(d / 2)),
      new THREE.Vector3(DOOR_HW, DOOR_H / 2, 0.14),
      yaw,
      { solid: true }
    )
  );

  /* ---------------------------------------------------------------- */
  /* Fit-out, roof and rewards                                         */
  /* ---------------------------------------------------------------- */

  const spots = [];
  for (let f = 0; f < floors; f++) {
    const y = floorY(f) + 0.05;
    fitFloor(put, solid, { f, floors, y, ix, iz, wellX1: WELL_X1, shaftX: SHAFT_X, shaftHalf: SHAFT_HALF, accent, fit: spec.fit ?? 'hab', rng });
    // One reward per floor, alternating corners so a player has to cross each
    // plate rather than riding the lift and looking down.
    const cx = f % 2 ? ix - 2.4 : WELL_X1 + 2.4;
    const cz = f % 3 === 0 ? iz - 2.4 : -iz + 3.0;
    spots.push({
      position: P(cx, y + 0.7, cz),
      tier: f === floors - 1 ? 'prize' : f >= floors - 3 ? 'rare' : 'common',
    });
  }

  // Roof: slab, parapet, plant and a lift overrun.
  put('grate', boxGeo(w - WALL_T * 2, SLAB_T, d - WALL_T * 2, 2), 0, roofY - SLAB_T / 2, 0);
  solid(0, roofY - SLAB_T / 2, 0, (w - WALL_T * 2) / 2, SLAB_T / 2, (d - WALL_T * 2) / 2);
  for (const [lx, lz, hx, hz] of [
    [0, -(d / 2 - 0.3), w / 2, 0.3], [0, d / 2 - 0.3, w / 2, 0.3],
    [-(w / 2 - 0.3), 0, 0.3, d / 2], [w / 2 - 0.3, 0, 0.3, d / 2],
  ]) {
    put('trim', boxGeo(hx * 2, 1.5, hz * 2, 2), lx, roofY + 0.75, lz);
    solid(lx, roofY + 0.75, lz, hx, 0.75, hz);
  }
  put('panelDark', boxGeo(SHAFT_HALF * 2 + 0.8, 3.2, SHAFT_HALF * 2 + 0.8, 3), SHAFT_X, roofY + 1.6, SHAFT_Z);
  solid(SHAFT_X, roofY + 1.6, SHAFT_Z, SHAFT_HALF + 0.4, 1.6, SHAFT_HALF + 0.4);
  for (let i = 0; i < 4; i++) {
    const lx = (rng() - 0.5) * (w - 7);
    const lz = 1 + rng() * (d / 2 - 3);
    put('shell', cylGeo(1.5, 1.5, 1.9, 12, 3), lx, roofY + 0.95, lz);
    solid(lx, roofY + 0.95, lz, 1.5, 0.95, 1.5);
  }
  put(accent, boxGeo(w - 6, 0.16, 0.3, 1), 0, roofY + 1.5, -(d / 2 - 0.35));

  const enterable = {
    label: spec.label,
    origin: new THREE.Vector3(x, 0, z),
    doors: [{
      id: `tower_door_${Math.round(x)}_${Math.round(z)}`,
      leaves,
      collider: doorCollider,
      position: P(0, 1.6, -(d / 2 + 0.5)),
      open: false,
      anim: 0,
    }],
    lifts: [lift],
    collectibleSpots: spots,
  };

  /* Publish the footprint so `_collisionSoup` can leave this building alone.
   *
   * A tower authors every collider it needs - shell, slabs, core, landings,
   * ramps, balustrades - and it has to, because the derived pass cannot know
   * which side of a wall is meant to be hollow. What the derived pass CAN do,
   * and did, is collide everything else that happens to be drawn in here: the
   * escalator trusses, the tread decks, the ceiling service runs, the cabin
   * furniture. None of that is authored as solid, all of it is in the way, and
   * the result was a rider stopped dead two thirds of the way up a flight by a
   * soffit that exists only as a decoration.
   *
   * `top` is the roof, so anything above it - the roof plant, the parapet - is
   * still collided normally from its own boxes.
   */
  return {
    enterable, height, roofY,
    footprint: { x, z, yaw, hw: w / 2 + 1.0, hd: d / 2 + 1.0, top: roofY - 0.05 },
  };
}

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

/**
 * Balustrade around a rectangular void.
 *
 * `openZ0` / `openZ1` omit an entire X-aligned run, for the end of the well the
 * escalators pass through. See the call site for why it is the whole run and
 * not a gap.
 */
function railRect(put, solid, x0, x1, z0, z1, y, accent, { openZ0, openZ1 } = {}) {
  const H = 1.1;
  const runs = [];
  if (!openZ0) runs.push([x0, x1, z0]);
  if (!openZ1) runs.push([x0, x1, z1]);
  for (const [a, b, z] of runs) {
    const cx = (a + b) / 2, len = b - a;
    put('trimDark', boxGeo(len, 0.12, 0.12, 1), cx, y + H, z);
    put(accent, boxGeo(len, 0.06, 0.06, 1), cx, y + H + 0.09, z);
    put('glassWindow', new THREE.PlaneGeometry(len, H - 0.2), cx, y + (H - 0.2) / 2 + 0.05, z, z > 0 ? 0 : Math.PI);
    solid(cx, y + H / 2, z, len / 2, H / 2, 0.09);
  }
  // The two Z-aligned runs are never interrupted - the lanes only ever open on
  // the +/-Z faces.
  for (const x of [x0, x1]) {
    const cz = (z0 + z1) / 2, len = z1 - z0;
    put('trimDark', boxGeo(0.12, 0.12, len, 1), x, y + H, cz);
    put(accent, boxGeo(0.06, 0.06, len, 1), x, y + H + 0.09, cz);
    put('glassWindow', new THREE.PlaneGeometry(len, H - 0.2), x, y + (H - 0.2) / 2 + 0.05, cz, x > 0 ? Math.PI / 2 : -Math.PI / 2);
    solid(x, y + H / 2, cz, 0.09, H / 2, len / 2);
  }
}

/**
 * Furnish one floor plate.
 *
 * Deliberately light. Seven floors times four towers is twenty-eight rooms, and
 * a full fit-out of each would cost more than the rest of the zone put
 * together - so this is the smallest set of objects that makes a floor read as
 * inhabited from the lift door: partitions that break the sightline, something
 * to sit on, something on the walls, and a light.
 */
function fitFloor(put, solid, o) {
  const { f, y, ix, iz, wellX1, shaftX, shaftHalf, accent, fit, rng } = o;
  const x0 = wellX1 + 1.0;
  const x1 = shaftX - shaftHalf - 1.0;
  if (x1 - x0 < 4) return;

  // A spine partition down the middle of the plate, with a gap you walk through.
  const spineX = (x0 + x1) / 2;
  for (const s of [-1, 1]) {
    const z0 = s * 2.2, z1 = s * (iz - 0.6);
    const len = Math.abs(z1 - z0);
    put('panelWarm', boxGeo(0.3, 2.7, len, 2), spineX, y + 1.35, (z0 + z1) / 2);
    solid(spineX, y + 1.35, (z0 + z1) / 2, 0.15, 1.35, len / 2);
  }
  put(accent, boxGeo(0.16, 0.1, 3.0, 1), spineX, y + 2.6, 0);

  if (fit === 'hab') {
    /* Crew cabins: a bunk, a locker and a desk against each flank, with the
     * cabin door standing open so the room is visible from the corridor. A
     * closed door on every cabin would be more plausible and would make the
     * whole floor read as a corridor with wallpaper. */
    for (const s of [-1, 1]) {
      for (let i = 0; i < 2; i++) {
        const cz = s * (3.6 + i * 4.4);
        const cx = spineX + s * 3.4;
        put('panelDark', boxGeo(3.0, 0.5, 1.9, 1.5), cx, y + 0.3, cz);
        put('panelWarm', boxGeo(2.8, 0.22, 1.7, 1.5), cx, y + 0.63, cz);
        put('shell', boxGeo(0.9, 0.3, 1.5, 1), cx - 1.0, y + 0.8, cz);
        solid(cx, y + 0.35, cz, 1.5, 0.35, 0.95);
        put('panelDark', boxGeo(0.9, 2.0, 0.6, 1.5), cx + 1.2, y + 1.0, cz + 1.4);
        solid(cx + 1.2, y + 1.0, cz + 1.4, 0.45, 1.0, 0.3);
        put('emDim', boxGeo(0.5, 0.06, 0.12, 1), cx - 1.3, y + 1.3, cz);
      }
    }
  } else {
    // Office fit: desk banks and a meeting pod.
    for (const s of [-1, 1]) {
      for (let i = 0; i < 2; i++) {
        const cz = s * (3.2 + i * 4.0);
        const cx = spineX + s * 3.2;
        put('panelWarm', boxGeo(2.6, 0.12, 1.2, 1.5), cx, y + 0.78, cz);
        for (const dx of [-1.1, 1.1]) put('trim', boxGeo(0.12, 0.78, 1.0, 1), cx + dx, y + 0.39, cz);
        solid(cx, y + 0.55, cz, 1.3, 0.4, 0.6);
        put('holo', boxGeo(1.0, 0.6, 0.03, 1), cx, y + 1.2, cz + 0.4);
      }
    }
  }

  // Something on the end wall, and a practical so the plate is not lit only by
  // the ceiling run.
  put('room', boxGeo(2.4, 1.4, 0.06, 1), x1 - 1.6, y + 1.8, iz - 0.5);
  void f; void ix; void rng;
}
