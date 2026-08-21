import * as THREE from 'three';
import { boxGeo, uvScale } from '../station/StationKit.js';
import { railSpans } from '../station/Tower.js';
import { yardSignUV } from './YardTextures.js';

/**
 * LODESTAR YARD — the shared builders.
 *
 * Everything here takes a `put`/`solid` pair rather than a world, for the
 * reason `station/ZoneContext.js:36` gives: the geometry call and the collider
 * call are separate because the yard derives nothing from what it draws, and
 * a builder that could only be used by one caller is a builder that gets
 * copied. `railSpans` is imported rather than reimplemented — "the rail has a
 * gap where the stair arrives" is either true or it is a player walking off a
 * gantry, and there is exactly one function in this repo that decides it.
 */

const _v = new THREE.Vector3();

/** Height of every guard rail in the yard, top of the handrail above the deck. */
export const RAIL_H = 1.1;

/**
 * One straight guarded run, with openings cut where something arrives.
 *
 * `railRect` in `station/Tower.js` guards a rectangular VOID and picks which
 * way its glass faces from the sign of the coordinate, which is right for a
 * stairwell in the middle of a floor plate and wrong for a perimeter catwalk
 * where the guarded side is always inboard. So the facing is explicit here and
 * the run is straight; four calls make the perimeter and two more make a
 * crossing.
 *
 * @param {(key:string, geo:THREE.BufferGeometry, x:number, y:number, z:number, ry?:number)=>void} put
 * @param {(cx:number, cy:number, cz:number, hx:number, hy:number, hz:number)=>void} solid
 * @param {object} o
 * @param {'x'|'z'} o.axis      which way the run travels
 * @param {number} o.a          run start along that axis
 * @param {number} o.b          run end
 * @param {number} o.fixed      the other horizontal coordinate
 * @param {number} o.y          deck level the rail stands on
 * @param {number} o.facing     +1 or -1: which way along the OTHER axis the
 *                              guarded drop lies, so the glass is wound to be
 *                              seen from the walkway rather than from the void
 * @param {string} o.accent     emissive material key for the top bead
 * @param {Array<[number,number]>} [o.gaps]  openings in the run's own axis
 */
export function railRun(put, solid, o) {
  const { axis, a, b, fixed, y, facing = 1, accent = 'emCyan', gaps = [] } = o;
  for (const [s0, s1] of railSpans(Math.min(a, b), Math.max(a, b), gaps)) {
    const c = (s0 + s1) / 2;
    const len = s1 - s0;
    if (len < 0.2) continue;
    if (axis === 'x') {
      put('steelDark', boxGeo(len, 0.11, 0.11, 1), c, y + RAIL_H, fixed);
      put(accent, boxGeo(len, 0.05, 0.05, 1), c, y + RAIL_H + 0.085, fixed);
      put('steelDark', boxGeo(len, 0.09, 0.09, 1), c, y + RAIL_H * 0.5, fixed);
      // Stanchions every 2.4 m, so the run reads as built rather than extruded.
      const n = Math.max(2, Math.round(len / 2.4));
      for (let i = 0; i <= n; i++) {
        put('steelDark', boxGeo(0.1, RAIL_H, 0.1, 1), s0 + (len * i) / n, y + RAIL_H / 2, fixed);
      }
      put('glass', new THREE.PlaneGeometry(len, RAIL_H - 0.24),
        c, y + (RAIL_H - 0.24) / 2 + 0.06, fixed, facing > 0 ? 0 : Math.PI);
      solid(c, y + RAIL_H / 2, fixed, len / 2, RAIL_H / 2, 0.09);
    } else {
      put('steelDark', boxGeo(0.11, 0.11, len, 1), fixed, y + RAIL_H, c);
      put(accent, boxGeo(0.05, 0.05, len, 1), fixed, y + RAIL_H + 0.085, c);
      put('steelDark', boxGeo(0.09, 0.09, len, 1), fixed, y + RAIL_H * 0.5, c);
      const n = Math.max(2, Math.round(len / 2.4));
      for (let i = 0; i <= n; i++) {
        put('steelDark', boxGeo(0.1, RAIL_H, 0.1, 1), fixed, y + RAIL_H / 2, s0 + (len * i) / n);
      }
      put('glass', new THREE.PlaneGeometry(len, RAIL_H - 0.24),
        fixed, y + (RAIL_H - 0.24) / 2 + 0.06, c, facing > 0 ? Math.PI / 2 : -Math.PI / 2);
      solid(fixed, y + RAIL_H / 2, c, 0.09, RAIL_H / 2, len / 2);
    }
  }
}

/**
 * Draw the treads of one flight. The COLLISION is a single hidden ramp proxy
 * registered by the caller — see `StationWorld._ramp` and the note at
 * `station/Tower.js:527`: the capsule solver resolves slopes and does not step
 * up, so a stack of boxes looks right and stops the player dead at riser one.
 *
 * The flight runs along +`axis` from (`x0`,`z0`) at `y0`, gaining `rise` over
 * `run`. Treads overlap by a centimetre so no gap shows through at a low angle.
 */
export function stairTreads(put, o) {
  const { axis, x0, z0, y0, run, rise, width, risers, key = 'grate', sideKey = 'steelDark' } = o;
  /* `run` is SIGNED — a flight that climbs toward -X is the same flight as one
   * that climbs toward +X, read backwards, and forcing every caller to flip
   * its own coordinates is how one of them gets it wrong. Positions follow the
   * sign; sizes never do. */
  const stepRun = run / risers;
  const treadLen = Math.abs(stepRun);
  const stepRise = rise / risers;
  for (let i = 0; i < risers; i++) {
    const t = (i + 0.5) / risers;
    const cx = axis === 'x' ? x0 + run * t : x0;
    const cz = axis === 'z' ? z0 + run * t : z0;
    const cy = y0 + rise * t;
    const w = axis === 'x' ? treadLen + 0.02 : width;
    const d = axis === 'x' ? width : treadLen + 0.02;
    put(key, boxGeo(w, 0.09, d, 1.4), cx, cy + 0.045, cz);
    // Riser plate, so the flight is not a floating stack of slabs seen from
    // underneath.
    const rw = axis === 'x' ? 0.05 : width;
    const rd = axis === 'x' ? width : 0.05;
    put(sideKey, boxGeo(rw, stepRise, rd, 1),
      axis === 'x' ? cx - stepRun / 2 : cx,
      cy - stepRise / 2 + 0.045,
      axis === 'z' ? cz - stepRun / 2 : cz);
  }
  // Stringers down both sides, drawn only — the ramp proxy is the collision.
  const len = Math.hypot(run, rise);
  const pitch = Math.atan2(rise, Math.abs(run)) * Math.sign(run || 1);
  for (const s of [-1, 1]) {
    const g = boxGeo(axis === 'x' ? len : 0.16, 0.36, axis === 'x' ? 0.16 : len, 2);
    const cx = axis === 'x' ? x0 + run / 2 : x0 + s * (width / 2 + 0.08);
    const cz = axis === 'z' ? z0 + run / 2 : z0 + s * (width / 2 + 0.08);
    put(sideKey, g, cx, y0 + rise / 2 - 0.22,
      axis === 'x' ? cz + s * (width / 2 + 0.08) : cz,
      0, axis === 'z' ? -pitch : 0, axis === 'x' ? pitch : 0);
  }
}

/**
 * Place a sign so it can only ever be read the right way round.
 *
 * A `PlaneGeometry` faces +Z; rotating it by PI to aim it at something shows
 * its BACK, and a text atlas seen through its back face renders mirrored. The
 * sign material is `FrontSide`, so this emits a front-facing quad, an opaque
 * backer behind it, and — for a board hung in open air — a second correctly
 * wound quad on the reverse.
 */
export function signBoard(put, cell, w, h, x, y, z, yaw, opts = {}) {
  const quad = () => yardSignUV(new THREE.PlaneGeometry(w, h), cell);
  const nx = Math.sin(yaw), nz = Math.cos(yaw);
  const t = opts.thickness ?? 0.16;
  put('signs', quad(), x + nx * t * 0.56, y, z + nz * t * 0.56, yaw);
  if (opts.twoSided) put('signs', quad(), x - nx * t * 0.56, y, z - nz * t * 0.56, yaw + Math.PI);
  if (opts.backer !== false) {
    put(opts.backerKey ?? 'steelDark', boxGeo(w * 1.06, h * 1.2, t, 2), x, y, z, yaw);
  }
  if (opts.accent) {
    put(opts.accent, boxGeo(w * 1.06, 0.09, t * 1.12, 1), x, y - h * 0.62, z, yaw);
  }
}

/**
 * A flat painted marking on the floor, vertex-coloured into the shared `paint`
 * bucket so every stripe, bay outline and chalk line in the yard is one draw.
 *
 * The colour is written per-vertex rather than per-material because the
 * alternative is a material per colour, and the keel line, the four berth bays
 * and the trench margins are five different colours over one surface.
 *
 * `key` exists because the yard has TWO grounds, not one. The paint material
 * samples the surface it is painted on so a marking reads as paint rather than
 * as a coloured quad hovering over the floor — which means a marking on the
 * apron's concrete has to sample the APRON's maps, or the keel line arrives at
 * the gateway with chequer plate printed on it. One extra bucket, one extra
 * draw, and the markings still merge inside each of them.
 */
export function paintQuad(put, w, d, x, y, z, yaw, colour, tile = 6, key = 'paint') {
  const q = new THREE.PlaneGeometry(w, d);
  q.rotateX(-Math.PI / 2);
  uvScale(q, w / tile, d / tile);
  const n = q.attributes.position.count;
  const col = new Float32Array(n * 3);
  const c = _colour(colour);
  for (let i = 0; i < n; i++) {
    col[i * 3] = c.r;
    col[i * 3 + 1] = c.g;
    col[i * 3 + 2] = c.b;
  }
  q.setAttribute('color', new THREE.BufferAttribute(col, 3));
  put(key, q, x, y, z, yaw);
}

const _c = new THREE.Color();
function _colour(hex) {
  _c.set(hex);
  // Vertex colours multiply the albedo map in LINEAR space; the map is sRGB,
  // so the colour has to be converted or every marking comes out a stop or
  // two brighter than it was authored. This is the same trap the mount
  // customiser's `normColor` records.
  return _c.convertSRGBToLinear();
}

/**
 * A worklight head. The LAMP is emissive geometry and the light source is a
 * `PointLight` the caller hands to `LightRig` — never a live light in the
 * world group. `LightRig.claim` runs the instant `build()` returns and turns
 * every authored light off; what makes a practical read is the emissive head
 * plus a rig slot, and a world that authored forty of them would pay 59.8 s of
 * shader compile for twelve slots' worth of visible effect.
 */
export function workLight(put, x, y, z, yaw = 0, o = {}) {
  const w = o.width ?? 1.6;
  put('steelDark', boxGeo(w, 0.26, 0.5, 1.4), x, y, z, yaw);
  put(o.lamp ?? 'emSodium', boxGeo(w - 0.24, 0.1, 0.34, 1), x, y - 0.17, z, yaw);
  // Hood, so the lamp is not a bare bar floating under a truss.
  put('steelDark', boxGeo(w + 0.2, 0.1, 0.62, 1.4), x, y + 0.16, z, yaw);
  for (const s of [-1, 1]) {
    put('steelDark', boxGeo(0.08, 0.5, 0.08, 1),
      x + Math.cos(yaw) * s * (w / 2), y + 0.4, z - Math.sin(yaw) * s * (w / 2));
  }
}

/** Local (lx,ly,lz) -> world, matching `GeoBatch.localAt` exactly. */
export function localPoint(ox, oz, yaw, lx, ly, lz) {
  const c = Math.cos(yaw), s = Math.sin(yaw);
  return new THREE.Vector3(ox + lx * c + lz * s, ly, oz - lx * s + lz * c);
}

export { _v as _yardScratch };
