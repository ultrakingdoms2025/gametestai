import * as THREE from 'three';
import { boxGeo, cylGeo, uvScale, instanced, GeoBatch } from './StationKit.js';
import { CENTRE } from '../lod/DistanceLod.js';

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
/** Shell wall thickness. The interior - and so every floor plate - stops here. */
export const WALL_T = 0.4;
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
 * How far from a tower's centre its interior stops being drawn.
 *
 * See the note beside the `DistanceLod` registration at the end of
 * `buildTower` for why this is measured to the centre and why 34 is the number.
 * Exported so a test can assert it clears the entrance steps rather than
 * trusting a comment about them.
 */
export const INTERIOR_HIDE_R = 34;

/** Local X/Z of the entrance step run's outer edge, from the tower centre. */
export function entranceReach(d, stepRun = 3.4) {
  return d / 2 + stepRun;
}

/** Thickness of a drawn escalator tread. */
export const TREAD_T = 0.12;
/**
 * Height of a tread's centre above the deck datum it is built on.
 *
 * Baked into `StationWorld._runEscalators`, which re-derives every tread's
 * position from the run's datum as `y0 + rise * f + 0.06` on every animated
 * frame. Changing it here alone would put the treads back where they were the
 * moment the first flight came into range.
 */
export const TREAD_MOUNT = 0.06;

/**
 * How far a flight's deck datum sits below the line its riders walk on.
 *
 * A flight's line runs from `floorY(f)` to `floorY(f + 1)` exactly, and the
 * part of the assembly that has to lie ON that line is the TOP FACE of a
 * tread - that is what "the escalator meets the floor" means, at the comb
 * plate and at the landing alike. A tread is `TREAD_T` thick and pitched with
 * the flight, so vertically its centre is `TREAD_T/2/cos(pitch)` below its own
 * top face, and it is mounted `TREAD_MOUNT` above the deck. Add the two and
 * you have the distance the deck has to drop for the tread tops to land on the
 * line.
 *
 * Seating the treads by their CENTRES instead - putting the centre on the line
 * plus `TREAD_MOUNT` - is what the first version did, and at the standard
 * 30-degree pitch that is 0.129 m of lift on every tread top in the building:
 * a lip to step over at the foot of all 76 flights and a drop off the head of
 * all 76.
 *
 * @param {number} pitch  flight pitch in radians, either sign
 * @param {number} [treadThickness]
 * @returns {number}
 */
export function escalatorDeckDrop(pitch, treadThickness = TREAD_T) {
  return TREAD_MOUNT + (treadThickness / 2) / Math.cos(Math.abs(pitch));
}

/* ------------------------------------------------------------------ */
/* Floor numbers                                                       */
/* ------------------------------------------------------------------ */

/**
 * Why the storey numbers are drawn as SEGMENTS and not as a texture cell.
 *
 * Every other piece of lettering on this station comes out of the signage
 * atlas, and the obvious thing to do here was to add a row of numerals to it
 * and hang a quad at every landing. Two facts rule that out.
 *
 *   1. The sheet has no room. `SIGN_COLS * SIGN_ROWS` is 4 x 11 = 44 cells and
 *      `SIGN_ROLE` reserves all 44 by name, right up to `surveyEnquiries: 43`.
 *      The note beside `SIGN_ROWS` in StationKit.js is explicit that the two
 *      cells it calls spare are "the cost of a row, not slack anybody may
 *      borrow, because every cell here is reserved BY ROLE". Numbers 1 to 9
 *      would need nine cells, so it would be three more rows at ~4.5 MB each -
 *      13 MB of texture for eighteen glyphs.
 *   2. A new material is a new draw call in every batch that uses it. The
 *      profile this work has to protect says cost tracks draw calls at
 *      r = 0.939, and there are eleven towers over five separately flushed
 *      groups, so an atlas would put five to eleven more draws on the frame
 *      permanently.
 *
 * Segments cost neither. They are boxes in `emWhite`, a key every tower's
 * interior batch already carries for its ceiling strip, so they merge into an
 * existing bucket and add exactly zero draw calls. A seven-segment glyph is
 * also the right typography for a lift lobby, which is the one place in the
 * world where a real building would use it.
 *
 * Returned as plain rectangles rather than drawn, so the layout can be checked
 * under Node - `buildTower` needs a world, its materials and its physics and
 * cannot be. Same arrangement as `escalatorDeckDrop` and `stringCourseRuns`.
 */

/**
 * Which of the seven segments each digit lights.
 *
 * Named by the standard convention: `a` top, `b` upper right, `c` lower right,
 * `d` bottom, `e` lower left, `f` upper left, `g` middle.
 */
export const SEVEN_SEGMENT = Object.freeze({
  0: 'abcdef',
  1: 'bc',
  2: 'abdeg',
  3: 'abcdg',
  4: 'bcfg',
  5: 'acdfg',
  6: 'acdefg',
  7: 'abc',
  8: 'abcdefg',
  9: 'abcdfg',
});

/** Glyph cell: width and height as multiples of the requested cap height. */
export const GLYPH_W = 0.58;
/** Stroke width, likewise. Thin enough to read as signage, fat enough to bloom. */
export const GLYPH_STROKE = 0.15;
/** Gap between glyphs, as a multiple of cap height. */
export const GLYPH_GAP = 0.16;

/**
 * The lit bars of one digit, in a cell whose CENTRE is (0, 0).
 *
 * @param {string|number} digit  a single character, '0'-'9'
 * @param {number} h  cap height in metres
 * @returns {Array<{u:number, v:number, w:number, h:number}>} centres and FULL
 *   sizes, `u` across the glyph and `v` up it.
 */
export function digitBars(digit, h = 1) {
  const on = SEVEN_SEGMENT[String(digit)];
  if (!on) throw new Error(`digitBars: "${digit}" is not a digit`);
  const W = GLYPH_W * h;
  const t = GLYPH_STROKE * h;
  const barW = W - t;
  /* A vertical arm runs from the middle bar's top edge to the top bar's bottom
   * edge, MINUS a gap at each end.
   *
   * The gap is the whole point. Without it a glyph's own bars butt face to
   * face, which is the coincident-surface pair the depth buffer cannot order -
   * 323 of them were removed from this world in the change immediately before
   * this one, and a seven-segment digit is the easiest place in the world to
   * put them back. `station-floor-numbers.test.mjs` asserts every pair of bars
   * in every digit is separated on at least one axis by a real distance.
   *
   * 1.2% of cap height is 7 mm at the size these are drawn, which is under the
   * bevel a real illuminated sign would have anyway. */
  const gp = 0.012 * h;
  const armH = h / 2 - t * 1.5 - gp * 2;
  const armV = h / 4 - t / 4;
  const out = [];
  const put = (seg, u, v, w, hh) => { if (on.includes(seg)) out.push({ u, v, w, h: hh }); };
  put('a', 0, (h - t) / 2, barW, t);
  put('g', 0, 0, barW, t);
  put('d', 0, -(h - t) / 2, barW, t);
  put('f', -(W - t) / 2, armV, t, armH);
  put('b', (W - t) / 2, armV, t, armH);
  put('e', -(W - t) / 2, -armV, t, armH);
  put('c', (W - t) / 2, -armV, t, armH);
  return out;
}

/**
 * A whole number laid out and centred on (0, 0), plus the plate it sits on.
 *
 * The plate is returned rather than assumed because the bars are emissive and
 * an emissive glyph with nothing behind it blooms into the wall it is bolted
 * to - the same reason `paintSignAtlas` puts an opaque backing bar under every
 * line of text it draws.
 *
 * @param {number} n  storey number; 1-based, matching the lift prompt's
 *   "floor N of M" so a player reading the sign and reading the prompt is
 *   reading the same number.
 * @param {number} h  cap height in metres
 * @returns {{bars: Array<{u:number,v:number,w:number,h:number}>,
 *            plate: {u:number, v:number, w:number, h:number}}}
 */
export function floorNumeral(n, h = 0.62) {
  const text = String(Math.max(0, Math.round(n)));
  const W = GLYPH_W * h;
  const gap = GLYPH_GAP * h;
  const total = text.length * W + (text.length - 1) * gap;
  const bars = [];
  for (let i = 0; i < text.length; i++) {
    const u0 = -total / 2 + W / 2 + i * (W + gap);
    for (const b of digitBars(text[i], h)) bars.push({ ...b, u: b.u + u0 });
  }

  /* Centred on the INK, not on the cells.
   *
   * Eight of the ten digits are symmetric about their cell, so for those the
   * two are the same thing. `1` is not: it lights only `b` and `c`, both hard
   * against the right-hand edge, and a lift-lobby plate reading "1" with the
   * stroke jammed against the right frame does not read as considered
   * typography, it reads as a bug. A real seven-segment display leaves it
   * there because its cells are a fixed grid shared with every other digit;
   * a sign that says one number has no such constraint.
   *
   * The plate is then sized around the ink for the same reason - so a floor 1
   * plaque and a floor 8 plaque are both a number in the middle of a plate. */
  let u0 = Infinity, u1 = -Infinity;
  for (const b of bars) { u0 = Math.min(u0, b.u - b.w / 2); u1 = Math.max(u1, b.u + b.w / 2); }
  const shift = -(u0 + u1) / 2;
  for (const b of bars) b.u += shift;
  const ink = u1 - u0;

  const pad = h * 0.42;
  return { bars, plate: { u: 0, v: 0, w: Math.max(ink, W) + pad * 2, h: h + pad * 1.4 } };
}

/**
 * How the three layers of a floor sign are stacked off the wall it hangs on.
 *
 * Three surfaces, each parallel to the last, is exactly the arrangement that
 * produced 323 coincident pairs elsewhere in this world, so the two gaps are
 * named, exported and asserted in `station-coplanar-floors.test.mjs` rather
 * than left as two magic numbers inside a closure.
 *
 * `PLATE_GAP` is 30 mm because the wall behind these is drawn by four different
 * things depending on which sign it is - a shell wall, a lift shaft wall, a
 * door surround - and 30 mm clears the thickest of their own surface reliefs.
 * `BAR_GAP` only has to beat depth precision at reading distance, which two
 * metres of it does at one centimetre with a great deal to spare.
 */
export const SIGN_LAYERS = Object.freeze({
  /** Backing plate thickness. */
  PLATE_T: 0.06,
  /** Gap between the wall face and the back of the plate. */
  PLATE_GAP: 0.03,
  /** Segment bar thickness. */
  BAR_T: 0.05,
  /** Gap between the front of the plate and the back of a bar. */
  BAR_GAP: 0.01,
});

/**
 * A storey number on a wall, as a lit plate with segment glyphs on it.
 *
 * `plane` is which way the sign faces: `'-x'`, `'+x'`, `'-z'` or `'+z'` in the
 * building's own frame. The plate is inset from the surface it is bolted to and
 * the glyphs stand proud of the plate, both by a centimetre or more, so no face
 * of this assembly is coplanar with any other - the defect a whole session has
 * gone into removing.
 *
 * Lifted out of `buildTower`'s closure and exported when the control tower and
 * the hangar mezzanine needed the same signs. Everything that numbers a floor
 * in this world now numbers it with these bars, in this material, at these
 * three offsets - which is the point: a second copy of the layout is how one
 * building ends up with its plaque a centimetre inside the wall.
 *
 * @param {(key:string, geo:THREE.BufferGeometry, lx:number, ly:number,
 *          lz:number, ry?:number) => unknown} put  emitter in the building's
 *          local frame, normally an interior batch's
 */
export function drawFloorSign(put, n, plane, lx, ly, lz, capH = 0.6) {
  const { bars, plate } = floorNumeral(n, capH);
  const { PLATE_T, PLATE_GAP, BAR_T, BAR_GAP } = SIGN_LAYERS;
  const nx = plane === '-x' ? -1 : plane === '+x' ? 1 : 0;
  const nz = plane === '-z' ? -1 : plane === '+z' ? 1 : 0;
  const pOff = PLATE_GAP + PLATE_T / 2;
  const bOff = PLATE_GAP + PLATE_T + BAR_GAP + BAR_T / 2;
  /* `trim`, not `panelDark`.
   *
   * The first version backed the glyphs with `panelDark` and the lift shaft
   * they hang on is also `panelDark`, so the plate vanished into the wall and
   * the number read as digits floating on a dark field. A polished plaque is
   * both what a lift lobby actually has and the only key in the palette that
   * separates from the two surfaces these signs are ever bolted to. */
  if (nx) {
    put('trim', boxGeo(PLATE_T, plate.h, plate.w, 1), lx + nx * pOff, ly, lz);
    for (const b of bars) {
      put('emWhite', boxGeo(BAR_T, b.h, b.w, 1), lx + nx * bOff, ly + b.v, lz - nx * b.u);
    }
  } else {
    put('trim', boxGeo(plate.w, plate.h, PLATE_T, 1), lx, ly, lz + nz * pOff);
    for (const b of bars) {
      put('emWhite', boxGeo(b.w, b.h, BAR_T, 1), lx + nz * b.u, ly + b.v, lz + nz * bOff);
    }
  }
}

/** Depth of the string course band. */
export const STRING_COURSE_T = 0.22;
/** How far the band stands proud of the shell, per side. */
export const STRING_COURSE_OUT = 0.25;

/**
 * The string course: the horizontal band that makes the stack of floors read
 * from the avenue.
 *
 * ── What was wrong ────────────────────────────────────────────────────────
 * It was one box, `w + 0.5` by `d + 0.5`, at every storey. A band round the
 * outside of a building is a band; this was a lid. Two consequences, and the
 * player sees both of them:
 *
 *   1. Its TOP FACE sits at `floorY(f + 1)` exactly - the band is 0.22 thick and
 *      centred 0.11 below the floor above - and so does the top face of that
 *      floor's slab. Same plane, no offset, full plan area. Raycasting the
 *      render geometry over the hub deck and the habitation zone found this at
 *      every storey of every tower: 144 coincident hits on the hub's six
 *      stacks and 107 on the zone's, out of 407 in the whole world. Over half
 *      the world's z-fighting was this one line, and it is under the player's
 *      feet on every floor they walk onto.
 *   2. It closed the atrium. This file's own header says "The escalator well is
 *      an atrium: a 10 m void through every slab" - and a lid `d + 0.5` deep
 *      crosses that void at every level, so the void a rider looks down was
 *      floored seven times over in trim.
 *
 * ── The fix ───────────────────────────────────────────────────────────────
 * Draw the band as a band: four runs over the wall line and the 0.25 m
 * overhang, and nothing over the interior. From outside the silhouette is
 * identical, because the only part of the old box that was ever visible from
 * out there is the part this keeps. The inner edge lands exactly on the
 * interior face (`w/2 - WALL_T`), which is where the floor slabs stop - edge to
 * edge, no shared face - so there is no overlap left to order rather than an
 * overlap ordered by a millimetre.
 *
 * Returned rather than drawn so the relationship can be checked under Node;
 * `buildTower` needs a world, materials and physics and cannot be.
 *
 * @param {number} w  footprint width  (local X)
 * @param {number} d  footprint depth  (local Z)
 * @param {number} [wallT]
 * @param {number} [out]
 * @returns {Array<{w:number, d:number, x:number, z:number}>} four runs, sizes
 *   and local centres; height is `STRING_COURSE_T` for all of them.
 */
export function stringCourseRuns(w, d, wallT = WALL_T, out = STRING_COURSE_OUT) {
  const band = wallT + out;               // wall thickness plus the overhang
  const iz = d / 2 - wallT;               // interior face; where the slabs stop
  const runs = [];
  // Front and back, full width - they own the corners.
  for (const s of [-1, 1]) {
    runs.push({ w: w + out * 2, d: band, x: 0, z: s * (d / 2 + out - band / 2) });
  }
  // Left and right, stopping at the front/back runs so nothing is drawn twice.
  for (const s of [-1, 1]) {
    runs.push({ w: band, d: iz * 2, x: s * (w / 2 + out - band / 2), z: 0 });
  }
  return runs;
}

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
  /* The interior batch, and why there is a second one                 */
  /* ---------------------------------------------------------------- */

  /**
   * Everything a player can only see from INSIDE goes into `I`, not `B`.
   *
   * `B` is the caller's batch - the habitat block's, or a zone's - and it is
   * merged once for the whole district, so a tower's fit-out ends up inside a
   * mesh whose bounding sphere is a hundred metres across. That mesh is
   * submitted, depth-prepassed and shaded whenever any part of the district is
   * on screen, which from the plaza is always. Eleven towers' worth of bunks,
   * escalator trusses, balustrades and ceiling services were being drawn from
   * places you cannot see into any of them.
   *
   * `I` is flushed separately, per tower, into its own group, and registered
   * with the world's `DistanceLod` so it stops drawing once the camera is
   * further away than a player could read it from. That is the only mechanism
   * here: no swap geometry, no impostor. Past the band there is nothing to see
   * because the shell is opaque.
   *
   * WHAT STAYS IN `B`, and why it is not simply "everything indoors":
   *
   *   floor slabs        the storey lines are what you read through the window
   *                      band from the avenue. Hiding them makes a lit shell
   *                      with no floors in it, and the transition is visible
   *                      from thirty metres away.
   *   window bands,      exterior by definition.
   *   string course,
   *   shell, plinth,
   *   canopy, steps
   *   roof + parapet     seen from every other tower and from the walkway loop.
   *
   * Colliders are NOT split. `solid()` still registers everything, so what the
   * capsule meets is identical whether the interior is drawn or not - a player
   * walking in through a door never falls through a floor that has not faded
   * up yet, because the floor was never the thing being faded.
   */
  const I = new GeoBatch();
  const ig = new THREE.Group();
  ig.name = `tower-interior-${Math.round(x)}-${Math.round(z)}`;
  g.add(ig);
  const iput = (key, geo, lx, ly, lz, ry = 0, rx = 0, rz = 0) =>
    I.localAt(key, geo, x, 0, z, yaw, lx, ly, lz, ry, rx, rz);

  const floorSign = (n, plane, lx, ly, lz, capH = 0.6) =>
    drawFloorSign(iput, n, plane, lx, ly, lz, capH);

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
        iput('trimDark', boxGeo(cw * 0.9, 0.18, 0.3, 1), cx, y - SLAB_T - 0.2, cz);
        iput('emWhite', boxGeo(cw * 0.8, 0.08, 0.16, 1), cx, y - SLAB_T - 0.32, cz);
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
    railRect(iput, solid, WELL_X0, WELL_X1, WELL_Z0, WELL_Z1, y, accent, {
      openZ0: f % 2 === 0,
      openZ1: f % 2 === 1,
    });

    /* Storey numbers.
     *
     * Two per floor, because there are two ways up and a sign you cannot see
     * from the one you took is not wayfinding. One faces whoever steps out of
     * the lift; the other faces whoever rides an escalator up to this plate.
     *
     * `f + 1`, not `f`. `Interiors.update` prompts "floor N of M" with
     * `stopIndex + 1`, so a ground floor labelled 0 would contradict the
     * prompt the player reads with their hand on the same call plate.
     *
     * WHICH WALL the escalator sign goes on is decided by the same parity that
     * decides which end of the well is open, and for the same reason: a rider
     * arriving on an EVEN floor has come up lane B and runs out toward -Z, so
     * they are looking at the front wall; on an ODD floor they came up lane A
     * toward +Z and are looking at the back one. Putting both on one wall
     * would leave half the arrivals reading the sign over their shoulder.
     */
    const even = f % 2 === 0;
    floorSign(f + 1, '-x', SHAFT_X - SHAFT_HALF - 0.2, y + 1.95, SHAFT_Z + SHAFT_HALF - 0.55);
    floorSign(
      f + 1,
      even ? '+z' : '-z',
      even ? LANE_B : LANE_A,
      y + 2.35,
      even ? -iz : iz
    );

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
    for (const r of stringCourseRuns(w, d)) {
      put('trim', boxGeo(r.w, STRING_COURSE_T, r.d, 2), r.x, y + FLOOR_H - STRING_COURSE_T / 2, r.z);
    }
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

    /* Where the deck sits relative to the flight's walking line.
     *
     * `y0`..`y1` is the line a RIDER travels along, and its ends are exactly
     * `floorY(f)` and `floorY(f + 1)` by construction - that is what makes a
     * flight meet its landings. The one part of the assembly that has to touch
     * that line is the TOP FACE of a tread, so the treads are seated by their
     * tops rather than by their centres.
     *
     * `escalatorDeckDrop` is the distance between the two and carries the
     * reasoning; it is exported and tested headlessly because it is the whole
     * of the fix and nothing else in this file can be reached under Node.
     *
     * Everything else hangs off the deck rather than off the line, so the
     * truss, the grate, the balustrades and the handrails all move with it and
     * the flight is unchanged in itself - it just stops floating over its own
     * floors.
     */
    const deckDrop = escalatorDeckDrop(pitch);
    const dy0 = y0 - deckDrop;      // tread datum at the foot; + TREAD_MOUNT is a tread centre
    const dcy = cy - deckDrop;      // the same datum at the flight's middle

    // Truss, balustrades and handrails.
    iput('panelDark', boxGeo(LANE_HALF * 2 + 0.5, 0.7, len, 3), lane, dcy - 0.55, cz, 0, pitch);
    iput('grate', boxGeo(LANE_HALF * 2, 0.14, len, 2), lane, dcy - 0.05, cz, 0, pitch);
    for (const s of [-1, 1]) {
      iput('glassWindow', new THREE.PlaneGeometry(len, 1.05), lane + s * (LANE_HALF + 0.06), dcy + 0.55, cz, s > 0 ? -Math.PI / 2 : Math.PI / 2, 0, pitch);
      iput('trimDark', boxGeo(0.22, 0.22, len, 1), lane + s * (LANE_HALF + 0.06), dcy + 1.12, cz, 0, pitch);
      iput(accent, boxGeo(0.1, 0.08, len, 1), lane + s * (LANE_HALF + 0.06), dcy + 1.24, cz, 0, pitch);
    }

    /* Treads. Instanced boxes that slide along the slope and wrap, rather than
     * a scrolling texture: the material is shared with every other grate in the
     * world, so animating its `map.offset` would set the whole station moving. */
    const STEPS = 22;
    const step = len / STEPS;
    for (let i = 0; i < STEPS; i++) {
      const t = i / STEPS;
      const px = lane;
      const py = dy0 + FLOOR_H * t + TREAD_MOUNT;
      const pz = z0 + dir * run * t;
      treadEntries.push([px, py, pz, pitch, 0, 0, 1, 1, 1]);
    }
    escalators.push({
      first: treadEntries.length - STEPS, count: STEPS,
      // `y0` here is the TREAD DATUM, not the walking line: `_runEscalators`
      // re-derives every tread centre as `y0 + rise * f + 0.06` each frame, so
      // the datum it is handed has to be the one the treads were built on or
      // the first animated frame would put the deck back where it was. The
      // walking line itself is `world.a`..`world.b` below, which is what the
      // rider assist and the placement audit read.
      lane, dir, z0, y0: dy0, runH: run, rise: FLOOR_H, len, pitch, step,
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
     * vertically, that is 0.25/cos(pitch), because the slab is tilted. That
     * thickness correction is not negotiable and is not what was wrong.
     *
     * What the surface aims AT has changed. It used to be `cy + 0.10`, whose
     * note read "this puts the collision surface just under the tread tops so
     * feet meet the geometry they appear to be standing on" - true of the
     * treads, but the treads were themselves 0.129 m above the floors, so the
     * collision surface inherited 0.100 m of that and the player stepped off
     * every landing onto a shelf. With the treads seated on the walking line
     * (see `deckDrop`) there is nothing left to compensate for: the line IS the
     * tread tops and IS `floorY` at both ends, so aiming at it satisfies the
     * old note exactly and meets the slabs as well.
     *
     * It also measures its run along the local +Z of the yaw it is handed, so a
     * flight heading -Z is the same ramp turned round.
     */
    const surfaceY = cy;
    const rp = P(lane, surfaceY - 0.25 / Math.cos(Math.abs(pitch)), cz);
    world._ramp(rp.x, rp.y, rp.z, LANE_HALF * 2, run, FLOOR_H, dir > 0 ? yaw : yaw + Math.PI);

    // Top landing, bridging from the flight's head to the solid slab.
    const lz0 = z1, lz1 = dir * WELL_Z1;
    const lcz = (lz0 + lz1) / 2, lcd = Math.abs(lz1 - lz0);
    if (lcd > 0.2) {
      iput('grate', boxGeo(LANE_HALF * 2, SLAB_T, lcd, 2), lane, y1 - SLAB_T / 2, lcz);
      solid(lane, y1 - SLAB_T / 2, lcz, LANE_HALF, SLAB_T / 2, lcd / 2);
    }
    /* Comb plates top and bottom.
     *
     * These were 0.12 m thick and stood on the landing, which read as flush
     * only because the treads used to stand 0.129 m proud of it too. With the
     * treads seated on the floor, that thickness became exactly the lip this
     * work exists to remove - a hazard-striped kerb across the mouth of every
     * flight, standing over the steps it is supposed to comb into.
     *
     * It lies ON the slab rather than being let into it: the underside stays at
     * `py`, so the plate is still standing on the thing under it, and its top
     * face is 30 mm proud instead of coplanar with a slab face it would z-fight
     * with. 30 mm is the nosing a real comb plate has and is far below anything
     * the player can feel - the plate carries no collider either way.
     */
    const COMB_T = 0.03;
    for (const [pz, py] of [[z0, y0], [z1, y1]]) {
      iput('hazard', boxGeo(LANE_HALF * 2, COMB_T, 0.9, 1), lane, py + COMB_T / 2, pz);
    }
  }
  if (treadEntries.length) {
    const treads = instanced(boxGeo(LANE_HALF * 2 - 0.12, TREAD_T, 0.42, 1), M.chrome, treadEntries, { cast: false, recv: true });
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
      /* The treads hide with the rest of the interior. `_runEscalators` keeps
       * writing their matrices while they are hidden - which costs a little and
       * is the right trade, because a bank that stopped being animated would
       * snap to a new phase the moment it came back and every rider standing on
       * the ramp collider would see the steps jump under their feet. */
      world._lod?.add(treads, { hideBeyond: INTERIOR_HIDE_R, measure: CENTRE });
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
    iput('panelDark', boxGeo(hx * 2, roofY, hz * 2, 3), lx, roofY / 2, lz);
    solid(lx, roofY / 2, lz, hx, roofY / 2, hz);
  }
  // Door surround and a call plate at every stop, on the open face.
  for (let f = 0; f < floors; f++) {
    const y = floorY(f);
    iput('trim', boxGeo(0.2, 2.7, SHAFT_HALF * 2 + 0.4, 2), SHAFT_X - SHAFT_HALF - 0.1, y + 1.35, SHAFT_Z);
    iput(accent, boxGeo(0.12, 0.14, SHAFT_HALF * 2, 1), SHAFT_X - SHAFT_HALF - 0.2, y + 2.55, SHAFT_Z);
    iput('emWhite', boxGeo(0.08, 0.3, 0.22, 1), SHAFT_X - SHAFT_HALF - 0.22, y + 1.5, SHAFT_Z - SHAFT_HALF + 0.5);
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
    fitFloor(iput, solid, { f, floors, y, ix, iz, wellX1: WELL_X1, shaftX: SHAFT_X, shaftHalf: SHAFT_HALF, accent, fit: spec.fit ?? 'hab', rng });
    /* One reward per floor, walked round the plate so a player has to cross it
     * rather than ride the lift and look down.
     *
     * ── Why this is a table of four and not two modulos ─────────────────────
     * It used to be `f % 2 ? ix - 2.4 : WELL_X1 + 2.4` crossed with
     * `f % 3 === 0 ? iz - 2.4 : -iz + 3.0`, and one of the four combinations
     * that produces - `(ix - 2.4, -iz + 3.0)`, which comes up on floors 1, 5, 7,
     * 11, 13 ... - is INSIDE THE LIFT SHAFT. `SHAFT_X - SHAFT_HALF` is
     * `ix - 4.6` and `SHAFT_Z + SHAFT_HALF` is `-iz + 4.6`, so that corner sits
     * in the one rectangle `slabRects` deliberately leaves out. Measured across
     * the 23 enterable towers: 34 of 210 authored collectables were hanging in
     * a shaft void with the ground floor four to twenty-eight metres below
     * them. They were technically collectable - by riding the car to that
     * landing and reaching out of it - which is the exact behaviour this
     * comment's first sentence says the alternation exists to prevent.
     *
     * So the corners are enumerated instead of derived, and every one is stated
     * against the slab rectangle it belongs to:
     *
     *   0  the open floor, front       x in [WELL_X1, SHAFT_X - SHAFT_HALF]
     *   1  beside the lift, back       x in [SHAFT_X - SHAFT_HALF, ix],
     *                                  z >  SHAFT_Z + SHAFT_HALF
     *   2  the open floor, back        as 0
     *   3  the open floor, mid-front   as 0, at the far end of the band
     *
     * Three of the four are in the widest rectangle because it is the only one
     * that is guaranteed to exist at any tower footprint; the fourth is the
     * one that makes the player walk past the lift instead of round it.
     * Everything is clamped into its own band so a narrower tower cannot push a
     * corner back into a void.
     */
    const openX0 = WELL_X1 + 1.6;
    const openX1 = SHAFT_X - SHAFT_HALF - 1.6;
    const clamp = (v, lo, hi) => (lo > hi ? (lo + hi) / 2 : Math.min(hi, Math.max(lo, v)));
    const CORNERS = [
      [clamp(WELL_X1 + 2.4, openX0, openX1), clamp(-iz + 2.4, -iz + 1.4, iz - 1.4)],
      [clamp(ix - 2.4, SHAFT_X - SHAFT_HALF + 1.4, ix - 1.4), clamp(iz - 2.4, SHAFT_Z + SHAFT_HALF + 1.4, iz - 1.4)],
      [clamp(WELL_X1 + 2.4, openX0, openX1), clamp(iz - 2.4, -iz + 1.4, iz - 1.4)],
      [clamp(SHAFT_X - SHAFT_HALF - 2.4, openX0, openX1), clamp(-iz + 2.4, -iz + 1.4, iz - 1.4)],
    ];
    const [cx, cz] = CORNERS[f % CORNERS.length];
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

  /* ---------------------------------------------------------------- */
  /* Flush the interior, and hand it to the distance LOD               */
  /* ---------------------------------------------------------------- */

  /**
   * `hideBeyond` is measured to the CENTRE of the tower, not to the surface.
   *
   * `SURFACE` is the conservative default and the wrong one here. This building
   * is 24 by 22 by 30 m, so its bounding sphere has a 22 m radius and its
   * nearest point is underfoot for anybody within 22 m of the shell - the band
   * would fire almost nowhere, which is a true statement about the sphere and a
   * useless one about the building. Measured to the centre, the band is a plain
   * "how far is the player from this tower", which is exactly the question.
   *
   * 34 m with the default 6 m hysteresis means the interior is fully drawn from
   * 28 m out. The door is 11 m from the centre and the entrance steps reach
   * 14 m, so a player standing at the foot of the steps is 20 m inside the band
   * with the fit-out already up: the transition happens across the pavement, not
   * across the threshold. Nothing here is visible from outside 28 m anyway - the
   * shell is opaque, the glazing is a 0.55-opacity band on each storey, and the
   * doorway is 3.2 m wide seen through a 6.2 m canopy.
   */
  const interiorMeshes = I.flush(ig, M, `tower-int-${Math.round(x)}-${Math.round(z)}`, {
    cast: false, recv: true, glassWindow: { cast: false, recv: false },
  });
  for (const mesh of interiorMeshes) {
    world._lod?.add(mesh, { hideBeyond: INTERIOR_HIDE_R, measure: CENTRE });
  }

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
 * The spans of one balustrade run left after its openings are cut out.
 *
 * Exported and pure because "the rail has a gap where the stair arrives" is
 * exactly the kind of statement that is either true or is a player walking off
 * a gallery, and it can be settled here without a renderer.
 *
 * @param {number} a  run start along its own axis
 * @param {number} b  run end
 * @param {Array<[number, number]>} [gaps]  openings, in the same coordinate
 * @returns {Array<[number, number]>} the remaining solid spans, ascending
 */
export function railSpans(a, b, gaps = []) {
  let spans = [[a, b]];
  for (const [g0, g1] of gaps) {
    const lo = Math.min(g0, g1), hi = Math.max(g0, g1);
    const next = [];
    for (const [s0, s1] of spans) {
      if (hi <= s0 || lo >= s1) { next.push([s0, s1]); continue; }
      if (lo - s0 > 0.05) next.push([s0, lo]);
      if (s1 - hi > 0.05) next.push([hi, s1]);
    }
    spans = next;
  }
  return spans;
}

/**
 * Balustrade around a rectangular void, or along the edge of a gallery.
 *
 * `openZ0` / `openZ1` omit an entire X-aligned run, for the end of the well the
 * escalators pass through. See the call site for why it is the whole run and
 * not a gap.
 *
 * `gaps` cuts an OPENING in a named run instead of dropping the whole thing,
 * which is what a stair head needs: the hangar mezzanine's stair arrives in the
 * middle of a 21 m front edge and dropping that run would leave nineteen metres
 * of unguarded gallery over an eight-metre fall. Each entry is
 * `{ side: 'z0'|'z1'|'x0'|'x1', a, b }` in the run's own axis.
 *
 * Exported because the mezzanine is the second gallery in this world and a
 * second implementation of "rail with glass and a collider that matches it" is
 * how one of them ends up with a rail you can walk through.
 */
export function railRect(put, solid, x0, x1, z0, z1, y, accent, { openZ0, openZ1, gaps = [] } = {}) {
  const H = 1.1;
  const cut = (side) => gaps.filter((g) => g.side === side).map((g) => [g.a, g.b]);
  const runs = [];
  if (!openZ0) runs.push(['z0', x0, x1, z0]);
  if (!openZ1) runs.push(['z1', x0, x1, z1]);
  for (const [side, a, b, z] of runs) {
    for (const [s0, s1] of railSpans(a, b, cut(side))) {
      const cx = (s0 + s1) / 2, len = s1 - s0;
      put('trimDark', boxGeo(len, 0.12, 0.12, 1), cx, y + H, z);
      put(accent, boxGeo(len, 0.06, 0.06, 1), cx, y + H + 0.09, z);
      put('glassWindow', new THREE.PlaneGeometry(len, H - 0.2), cx, y + (H - 0.2) / 2 + 0.05, z, z > 0 ? 0 : Math.PI);
      solid(cx, y + H / 2, z, len / 2, H / 2, 0.09);
    }
  }
  // In the towers the two Z-aligned runs are never interrupted - the lanes only
  // ever open on the +/-Z faces - but a gallery may still want a gap in one.
  for (const [side, x] of [['x0', x0], ['x1', x1]]) {
    for (const [s0, s1] of railSpans(z0, z1, cut(side))) {
      const cz = (s0 + s1) / 2, len = s1 - s0;
      put('trimDark', boxGeo(0.12, 0.12, len, 1), x, y + H, cz);
      put(accent, boxGeo(0.06, 0.06, len, 1), x, y + H + 0.09, cz);
      put('glassWindow', new THREE.PlaneGeometry(len, H - 0.2), x, y + (H - 0.2) / 2 + 0.05, cz, x > 0 ? Math.PI / 2 : -Math.PI / 2);
      solid(x, y + H / 2, cz, 0.09, H / 2, len / 2);
    }
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

/* ------------------------------------------------------------------ */
/* Zone landmark towers                                                */
/* ------------------------------------------------------------------ */

/**
 * Stand one enterable tower on a zone deck.
 *
 * ── Why this wrapper exists ───────────────────────────────────────────────
 * `Habitation` has been raising five of these by hand since the hab stacks
 * landed, and its call site carries four things that are not about that zone at
 * all: the local-to-world frame, the `_selfCollided` registration that stops
 * `_collisionSoup` walling up the inside of the building, the rooftop
 * publication the relic placer reads, and the minimap footprint. Three more
 * zones now want the same building, and copying that block four times is how a
 * tower ends up in one zone with no `_selfCollided` entry and an interior full
 * of derived colliders that nobody can walk through.
 *
 * ── The frame, and the trap in it ─────────────────────────────────────────
 * `bearing` is a zone-local HEADING in radians: zero points at the corridor
 * mouth (local +Z, back toward the hub) and increases toward local +X, which is
 * the convention `Gym.bear` and `Canteen.at` already use. The tower stands at
 * `r` metres along that heading and its yaw is the heading ITSELF, not the
 * heading reversed.
 *
 * That last sentence is the trap. `GeoBatch.localAt` and `buildTower`'s own `P`
 * both send tower-local +Z to the heading they are given, and the entrance is
 * at tower-local -Z, so a yaw of `bearing` puts the door on the side facing the
 * zone centre - which is what you want, because the zone centre is where the
 * player is. `bearing + PI` reads like "turn round and face the middle" and
 * does the exact opposite; `Habitation` had it that way for every one of its
 * five stacks, with the entrance lights on the blank back wall.
 *
 * @param {import('./ZoneContext.js').ZoneContext} ctx
 * @param {{ bearing:number, r:number, label:string, floors?:number,
 *           w?:number, d?:number, fit?:'hab'|'office', body?:string }} spec
 * @returns {{ enterable:object, roofY:number, height:number, lx:number, lz:number,
 *             footprint:object }}
 */
export function buildZoneTower(ctx, spec) {
  const { bearing, r } = spec;
  const w = spec.w ?? 24;
  const d = spec.d ?? 22;
  const lx = Math.sin(bearing) * r;
  const lz = Math.cos(bearing) * r;
  const p = ctx.P(lx, 0, lz);

  const built = buildTower(
    ctx.world, ctx.B, ctx.group,
    {
      x: p.x, z: p.z, yaw: ctx.yawOf(bearing),
      w, d,
      floors: spec.floors ?? 7,
      label: spec.label,
      accent: ctx.accent,
      body: spec.body ?? 'panel',
      fit: spec.fit ?? 'office',
    },
    ctx.rng
  );

  ctx.enterables.push(built.enterable);
  /* Without this the derived collision pass fills the building in. See the
   * note where `buildTower` returns the footprint: a tower authors every
   * collider it needs, and `_collisionSoup` cannot know which side of a wall
   * is meant to be hollow. */
  ctx.world._selfCollided.push(built.footprint);
  ctx.roof(lx, built.roofY, lz);
  ctx.mmRect(lx, lz, w, d, bearing, 'rgba(70,120,110,0.6)', 'rgba(150,235,255,0.55)');
  ctx.contact(lx, lz, Math.max(w, d) + 6);

  return { ...built, lx, lz };
}
