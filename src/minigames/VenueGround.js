import * as THREE from 'three';
import { COLLISION_LAYER } from '../physics/Physics.js';

/**
 * Putting a venue's points on ground that exists.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 *  THE DEFECT THIS FILE IS THE ANSWER TO
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * "Content that is BUILT but cannot be REACHED" is this project's recorded
 * signature defect - it cost the medieval expansion four shipped defects and
 * World 06 nine separate gates that measured the wrong thing. A minigame venue
 * is unusually good at committing it, because every one of its failures is
 * silent:
 *
 *  - A drop point authored at `y: 0` over a deck that is really at 10.005 is
 *    outside the arrival band forever. The venue arms, the prompt appears, the
 *    run starts, and one leg of it can never be completed.
 *  - A relay node inside a plinth, a shop wall or a set-dressing crate has no
 *    standable floor at all. Same silence.
 *  - A point under a stair or a walkway has floor and no HEADROOM, so a capsule
 *    cannot stand there even though a downward ray says it can.
 *
 * None of the three throws. None of them fails a geometry test, because the
 * geometry is fine - it is the ROUTE that is impossible.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 *  SO: AUTHOR PLAN, DERIVE GEOMETRY
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * The same split `CitadelWorld._publishVenues` uses and documents. A world
 * authors WHERE it wants a point in plan - an x and a z it can reason about -
 * and this file asks the built world how high the floor there really is, drops
 * anything that has no floor or no room to stand, and hands back what survived.
 * A venue with too few survivors is pruned by its world rather than shipped as
 * a prompt that starts a contest nobody can finish.
 *
 * Nothing here is a guess. `groundHeight` is the same probe `_solidifyProps`,
 * `Relics` and the spawn placer use, so a point this file accepts is a point
 * those three would also have accepted.
 */

const _from = new THREE.Vector3();
const _up = new THREE.Vector3(0, 1, 0);

/**
 * Headroom a standing capsule needs, metres.
 *
 * `CONFIG.player` carries a 1.75 m capsule; 1.9 is that plus the clearance the
 * station's own walkway test (`station-walkway-loop.test.mjs`) uses for the
 * same question, so a point accepted here is a point that file would call
 * walkable.
 */
export const STAND_HEADROOM = 1.9;

/**
 * Radius of the ring that asks "can a body WALK onto this?", metres.
 *
 * A downward ray and a headroom clause together accept the top of a packing
 * crate: it has floor, and it has all the sky above it you like. The station's
 * hub deck carries 2,226 solid set-dressing props, and a relay node settled
 * onto one of them at 5.45 m over a 0.08 m deck is content that was BUILT and
 * cannot be REACHED - this repo's signature defect, delivered by the very pass
 * written to prevent it.
 *
 * So a settled point is also asked about its NEIGHBOURS. Eight samples at 1.2 m
 * - just outside a 0.35 m capsule, close enough that a real step is still
 * inside the ring - and a majority of them have to be within a step of the
 * point's own floor. A crate top has eight neighbours two to five metres below
 * it and fails; a hillside, a ramp and a kerb all pass, because on those the
 * ground around you IS roughly the ground under you.
 */
export const WALK_RING_R = 1.2;
/** Height difference between a point and its neighbours that still walks. */
export const WALK_STEP_UP = 0.75;
/** How many of the eight ring samples have to agree. */
export const WALK_RING_QUORUM = 5;

/**
 * Settle a plan of (x, z) points onto the floor the built world actually has.
 *
 * @param {any} physics the world's physics, mid-build
 * @param {Array<{id?:string, label?:string, x:number, z:number}>} plan
 * @param {{from?:number, depth?:number, lift?:number, headroom?:number,
 *   ringR?:number, stepUp?:number, quorum?:number}} [opts]
 *   `from`/`depth` are the downward probe's start height and length - a station
 *   deck under a dome and an open hillside need very different ones, so neither
 *   is guessed here. `lift` raises the settled point off the floor, which is
 *   what an arrival band is measured against. `ringR`/`stepUp`/`quorum` tune the
 *   walk-on test; a quorum of 0 turns it off, which is what a venue standing
 *   deliberately on a platform would do.
 * @returns {{points:Array<{id:string,label:string,x:number,y:number,z:number}>,
 *   dropped:Array<{id:string, why:string}>}}
 */
export function settlePoints(physics, plan, opts = {}) {
  const from = Number.isFinite(opts.from) ? opts.from : 200;
  const depth = Number.isFinite(opts.depth) ? opts.depth : 400;
  const lift = Number.isFinite(opts.lift) ? opts.lift : 0;
  const need = Number.isFinite(opts.headroom) ? opts.headroom : STAND_HEADROOM;
  const ringR = Number.isFinite(opts.ringR) ? opts.ringR : WALK_RING_R;
  const stepUp = Number.isFinite(opts.stepUp) ? opts.stepUp : WALK_STEP_UP;
  const quorum = Number.isFinite(opts.quorum) ? opts.quorum : WALK_RING_QUORUM;

  const points = [];
  const dropped = [];
  for (const raw of Array.isArray(plan) ? plan : []) {
    const x = Number(raw?.x);
    const z = Number(raw?.z);
    const id = typeof raw?.id === 'string' && raw.id ? raw.id : `pt-${points.length + dropped.length}`;
    if (!Number.isFinite(x) || !Number.isFinite(z)) {
      dropped.push({ id, why: 'not a point' });
      continue;
    }
    const g = physics?.groundHeight?.(x, z, from, depth);
    if (g === null || g === undefined || !Number.isFinite(g)) {
      dropped.push({ id, why: 'no floor' });
      continue;
    }
    /* Headroom, measured with the real raycast rather than assumed from the
     * absence of a roof. A point under a stair flight, a travelator or the
     * underside of a walkway has floor and no room, and only the upward ray
     * can tell the two apart. */
    if (need > 0 && typeof physics?.raycast === 'function') {
      _from.set(x, g + 0.08, z);
      const above = physics.raycast(_from, _up, need + 0.5, COLLISION_LAYER.WORLD);
      if (above && above.distance < need) {
        dropped.push({ id, why: `only ${above.distance.toFixed(2)} m of headroom` });
        continue;
      }
    }
    /* ..and can a body WALK onto it? See WALK_RING_R: floor plus headroom
     * accepts the top of a crate, and the station deck carries 2,226 solid
     * props to settle onto. */
    if (quorum > 0 && ringR > 0) {
      let agree = 0;
      for (let i = 0; i < 8; i++) {
        const a = (i / 8) * Math.PI * 2;
        const h = physics.groundHeight(x + Math.cos(a) * ringR, z + Math.sin(a) * ringR, from, depth);
        if (h !== null && h !== undefined && Number.isFinite(h) && Math.abs(h - g) <= stepUp) agree++;
      }
      if (agree < quorum) {
        dropped.push({ id, why: `${agree}/8 neighbours within a step — this is a pedestal, not a floor` });
        continue;
      }
    }
    points.push({
      id,
      label: typeof raw?.label === 'string' && raw.label ? raw.label : id,
      x,
      y: g + lift,
      z,
    });
  }
  return { points, dropped };
}

/**
 * The disc a venue needs to hold every one of its points.
 *
 * `MinigameManager.fixedUpdate` abandons a running contest `LEAVE_GRACE_S` = 9 s
 * after the player leaves the venue disc, so a disc that does not cover the
 * whole route ends every run that reaches the far end of it. That is
 * `citadel_skyline`'s recorded lesson, and it is why this is computed from the
 * route rather than authored beside it.
 *
 * `yTolerance` is derived the same way and for the same reason: a courier round
 * that climbs a ramp leaves a planar disc's height band unless the band was
 * measured against the climb.
 *
 * @param {Array<{x:number,y:number,z:number}>} points
 * @param {{margin?:number, band?:number}} [opts]
 * @returns {{centre:{x:number,y:number,z:number}, radius:number, yTolerance:number}|null}
 */
export function discFor(points, opts = {}) {
  const list = Array.isArray(points) ? points.filter((p) => Number.isFinite(p?.x)) : [];
  if (!list.length) return null;
  const margin = Number.isFinite(opts.margin) ? opts.margin : 14;
  const band = Number.isFinite(opts.band) ? opts.band : 6;

  let minX = Infinity; let maxX = -Infinity;
  let minZ = Infinity; let maxZ = -Infinity;
  let minY = Infinity; let maxY = -Infinity;
  for (const p of list) {
    minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x);
    minZ = Math.min(minZ, p.z); maxZ = Math.max(maxZ, p.z);
    minY = Math.min(minY, p.y); maxY = Math.max(maxY, p.y);
  }
  const centre = { x: (minX + maxX) / 2, y: (minY + maxY) / 2, z: (minZ + maxZ) / 2 };
  let radius = 0;
  for (const p of list) radius = Math.max(radius, Math.hypot(p.x - centre.x, p.z - centre.z));
  return {
    centre,
    radius: radius + margin,
    yTolerance: (maxY - minY) / 2 + band,
  };
}
