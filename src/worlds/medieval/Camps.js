/**
 * The camps on the far bank.
 *
 * Three of them, and they exist because a road with nothing on it is a road to
 * nowhere. The vale's own bank has a village, a keep, a mill and a market; the
 * far bank had a ford, a track and 260,000 square metres of grass. A camp is
 * the cheapest possible thing that makes a stretch of road read as travelled -
 * it needs no foundations, no interior and no street, and a player who walks
 * past a fire that is still smoking learns more about the world than another
 * cottage would tell them.
 *
 * Nothing in this file may import `three` or touch the DOM. The layout is pure
 * data in the camp's OWN frame (`dx`/`dz` metres from its origin, rotated by
 * the camp's yaw), so `medieval-camps.test.mjs` can check that nothing
 * overlaps, that every camp is on the far bank, that every camp is within
 * reach of a road and that no tent is pitched on a slope you could not sleep
 * on - none of which needs a renderer.
 *
 * ---------------------------------------------------------------------------
 * WHICH BANK IS "FAR"
 *
 * Not a compass direction, and this matters because the river's centreline
 * swings 120 m across the map: `riverZ(-344)` is 67 and `riverZ(196)` is 123.
 * The far bank is `z > riverZ(x)` - the side Aldermoor, the keep and the market
 * are NOT on - and it is computed per camp rather than declared, so a camp
 * moved 80 m east cannot quietly end up on the wrong side of the water.
 *
 * ---------------------------------------------------------------------------
 * WHAT MAKES A CAMP LOOK INHABITED
 *
 * Occupancy is a set of *relationships*, not a set of objects. Six things
 * placed at random are six props; the same six placed as a hearth with a spit
 * over it, bedrolls facing the heat, firewood stacked upwind and a pot hung
 * where someone can reach it while sitting down is a camp. So every fire below
 * owns its spit, its pot and its wood pile as offsets from ITSELF, and the
 * tents are laid out facing the fire rather than facing the road.
 */

import { riverZ } from '../terrain/MedievalHeight.js';

/**
 * @typedef {{kind:string, dx:number, dz:number, yaw?:number, w?:number, d?:number,
 *            h?:number, r?:number, hex?:number}} CampPiece
 * @typedef {{id:string, name:string, kind:string, x:number, z:number, yaw:number,
 *            radius:number, tents:CampPiece[], fires:CampPiece[], props:CampPiece[]}} Camp
 */

/* ------------------------------------------------------------------ */
/* Layout helpers - a camp is a hearth with things arranged around it   */
/* ------------------------------------------------------------------ */

/**
 * A banked fire and everything that belongs to it.
 *
 * `spit` puts a pair of forked uprights and a turning bar across the embers
 * with a carcass on it; `pot` hangs a cauldron from a tripod; `logs` rings the
 * fire with seat logs. The wood pile is placed at a fixed bearing off the fire
 * because a stack of split cordwood two metres from the flame is the single
 * most legible "someone lives here" object there is - more than the tents,
 * which read as geometry, and more than the fire, which reads as a light.
 */
function hearth(dx, dz, o = {}) {
  return {
    kind: 'firepit', dx, dz, r: o.r ?? 1.15,
    spit: o.spit ?? false, pot: o.pot ?? false, logs: o.logs ?? 3,
    yaw: o.yaw ?? 0, smoke: o.smoke ?? true,
  };
}

/* ------------------------------------------------------------------ */
/* The camps                                                           */
/* ------------------------------------------------------------------ */

/** @type {Camp[]} */
export const CAMPS = [
  {
    /* ---- A merchant caravan halted short of the ford ----------------
     *
     * Sited 15 m off the Harrowgate road on the last flat ground before the
     * water, which is where a train of carts actually stops: you do not take
     * loaded waggons through a ford at dusk, you make camp and cross in the
     * morning. Bell tents rather than A-frames because these people can afford
     * canvas and poles, the carts are drawn into a crescent as a windbreak, and
     * the goods are stacked inside that crescent rather than beside the fire.
     */
    id: 'harrowgate-halt',
    name: 'Harrowgate Halt',
    kind: 'caravan',
    x: 276, z: 152, yaw: -0.55, radius: 17,
    tents: [
      { kind: 'bell', dx: -6.2, dz: -3.4, yaw: 0.35, r: 2.6, h: 3.1, hex: 0xd8cbae },
      { kind: 'bell', dx: -7.4, dz: 2.2, yaw: -0.20, r: 2.3, h: 2.9, hex: 0xcfc0a2 },
      { kind: 'bell', dx: -3.0, dz: 6.6, yaw: 0.9, r: 2.4, h: 3.0, hex: 0xd2c7ac },
      { kind: 'awning', dx: 4.6, dz: -5.2, yaw: 0.15, w: 5.2, d: 3.4, h: 2.4, hex: 0xc2a878 },
    ],
    fires: [hearth(0, 0, { r: 1.25, spit: true, pot: true, logs: 4, yaw: 0.3 })],
    props: [
      { kind: 'cart', dx: 7.8, dz: 1.4, yaw: 1.35 },
      { kind: 'cart', dx: 6.4, dz: 7.0, yaw: 1.05 },
      { kind: 'crate', dx: 3.4, dz: -6.4, yaw: 0.2 },
      { kind: 'crate', dx: 4.9, dz: -6.9, yaw: -0.5 },
      { kind: 'crate', dx: 4.1, dz: -5.5, yaw: 0.8, h: 0.9 },
      { kind: 'barrel', dx: 5.9, dz: -4.2, yaw: 0 },
      { kind: 'barrel', dx: 6.6, dz: -3.1, yaw: 0 },
      { kind: 'sacks', dx: 2.2, dz: -7.3, yaw: 0.4 },
      { kind: 'bedroll', dx: -3.6, dz: -2.2, yaw: 0.5 },
      { kind: 'bedroll', dx: -4.1, dz: 0.6, yaw: 0.1 },
      { kind: 'woodpile', dx: -1.4, dz: -4.6, yaw: 0.25 },
      { kind: 'laundry', dx: -10.5, dz: 8.4, yaw: 1.2, w: 7.0 },
      { kind: 'tether', dx: 9.6, dz: -2.0, yaw: 0 },
      { kind: 'ox', dx: 10.4, dz: 1.2, yaw: 1.5 },
      { kind: 'lantern', dx: 5.0, dz: -2.6, yaw: 0 },
      { kind: 'stool', dx: 1.9, dz: 2.4, yaw: 0.7 },
      { kind: 'stool', dx: -1.2, dz: 2.9, yaw: -0.4 },
      { kind: 'banner', dx: 8.6, dz: 5.4, yaw: 0.3, hex: 0xb02a33 },
    ],
  },
  {
    /* ---- Pilgrims in the mouth of the combe --------------------------
     *
     * At (-228, 266) the abbey road is 12 m away and St Ceolwine's is a
     * kilometre of walking further in through the one gap in an 18 m rim -
     * which is precisely why people stop here. The camp is poor: A-frames of
     * borrowed canvas over a ridge rope, no carts, a shared fire and a wayside
     * cross. The cross is the point of the whole camp; without it this is
     * three tents in a field.
     */
    id: 'ceolwine-rest',
    name: "Pilgrims' Rest",
    kind: 'pilgrim',
    x: -228, z: 266, yaw: 1.15, radius: 15,
    tents: [
      { kind: 'aframe', dx: -4.8, dz: -3.2, yaw: 0.1, w: 2.4, d: 4.2, h: 2.1, hex: 0xc9bda4 },
      { kind: 'aframe', dx: -5.4, dz: 1.4, yaw: -0.08, w: 2.2, d: 4.0, h: 2.0, hex: 0xbfb298 },
      { kind: 'aframe', dx: -4.2, dz: 5.8, yaw: 0.24, w: 2.3, d: 4.1, h: 2.05, hex: 0xd0c4ab },
      { kind: 'leanto', dx: 5.6, dz: 4.4, yaw: -1.1, w: 4.0, d: 2.6, h: 1.9, hex: 0xa89170 },
    ],
    fires: [hearth(0, 0, { r: 1.05, spit: false, pot: true, logs: 5 })],
    props: [
      { kind: 'cross', dx: 6.8, dz: -4.6, yaw: 0.2, h: 3.4 },
      { kind: 'bedroll', dx: -2.6, dz: -1.8, yaw: 0.3 },
      { kind: 'bedroll', dx: -2.9, dz: 1.0, yaw: -0.1 },
      { kind: 'bedroll', dx: -2.4, dz: 3.8, yaw: 0.4 },
      { kind: 'woodpile', dx: 2.0, dz: -3.4, yaw: -0.3 },
      { kind: 'staffs', dx: 3.2, dz: 1.2, yaw: 0.5 },
      { kind: 'laundry', dx: -7.8, dz: 7.4, yaw: 0.35, w: 6.2 },
      { kind: 'basket', dx: 1.4, dz: 3.2, yaw: 0.9 },
      { kind: 'basket', dx: 2.6, dz: 4.0, yaw: -0.2 },
      { kind: 'stool', dx: -0.6, dz: -2.6, yaw: 0.2 },
      { kind: 'lantern', dx: 6.2, dz: -3.0, yaw: 0 },
      { kind: 'waterpot', dx: 3.9, dz: -1.6, yaw: 0 },
    ],
  },
  {
    /* ---- Hunters at the fringe of Ninewells Wood --------------------
     *
     * On the woodland edge rather than in it: a camp inside closed canopy has
     * no light, no view and nowhere to hang a carcass. `standAt` here is 0.35,
     * which is the fringe belt, and the wood closes to 1.0 within forty metres
     * north-east - so the camp looks out over open ground with the trees at its
     * back, which is where you sit if the thing you are hunting is in them.
     *
     * x = 232 and not the flatter ground at x = 162 for a reason that has
     * nothing to do with hunting: a camp's beaten earth reaches 22 m, and at
     * (162, 212) that reach crossed z = 200 into the ORIGINAL 400 m vale.
     * Nothing would have looked wrong - a few hundred square metres of pasture
     * would quietly have become mud - but the inner square is bit-identical by
     * contract and `medieval-settled.test.mjs` enumerates every square metre of
     * it that this phase is allowed to change. Moving the camp is cheaper than
     * arguing for an exception.
     *
     * No tents worth the name. A brushwood lean-to, hides on a rack, a
     * gralloching pole and a fire kept small.
     */
    id: 'ninewells-camp',
    name: "Hunters' Camp",
    kind: 'hunters',
    x: 232, z: 202, yaw: 2.35, radius: 14,
    tents: [
      { kind: 'leanto', dx: -4.4, dz: -2.6, yaw: 0.15, w: 4.6, d: 2.8, h: 2.0, hex: 0x8f7a56 },
      { kind: 'leanto', dx: -4.0, dz: 3.2, yaw: -0.22, w: 3.8, d: 2.5, h: 1.85, hex: 0x9a835e },
      { kind: 'aframe', dx: -6.6, dz: 7.4, yaw: 0.5, w: 2.0, d: 3.6, h: 1.9, hex: 0x7f6c4c },
    ],
    fires: [hearth(0, 0, { r: 0.95, spit: true, pot: false, logs: 3, yaw: -0.4 })],
    props: [
      { kind: 'peltrack', dx: 4.6, dz: -3.8, yaw: 0.6, w: 4.4 },
      { kind: 'gralloch', dx: 5.8, dz: 2.6, yaw: -0.3, h: 2.8 },
      { kind: 'bedroll', dx: -2.4, dz: -1.6, yaw: 0.2 },
      { kind: 'bedroll', dx: -2.2, dz: 2.2, yaw: -0.15 },
      { kind: 'woodpile', dx: 1.2, dz: -3.6, yaw: 0.4 },
      { kind: 'traps', dx: 3.0, dz: 4.8, yaw: 0.8 },
      { kind: 'antlers', dx: -7.0, dz: -4.4, yaw: 0.25 },
      { kind: 'spears', dx: -1.8, dz: -4.2, yaw: -0.6 },
      { kind: 'stool', dx: 1.6, dz: 1.8, yaw: 0.3 },
      { kind: 'basket', dx: 2.8, dz: -1.2, yaw: 0.5 },
      { kind: 'waterpot', dx: -0.4, dz: 3.4, yaw: 0 },
      { kind: 'lantern', dx: 3.6, dz: 0.4, yaw: 0 },
    ],
  },
];

/* ------------------------------------------------------------------ */
/* Derived                                                             */
/* ------------------------------------------------------------------ */

/** World position of a camp piece, with the camp's own yaw applied. */
export function piecePosition(camp, piece) {
  const c = Math.cos(camp.yaw);
  const s = Math.sin(camp.yaw);
  return {
    x: camp.x + piece.dx * c - piece.dz * s,
    z: camp.z + piece.dx * s + piece.dz * c,
  };
}

/** Every piece of a camp, in one list, with its world position resolved. */
export function campPieces(camp) {
  const out = [];
  for (const group of ['tents', 'fires', 'props']) {
    for (const p of camp[group]) {
      const w = piecePosition(camp, p);
      out.push({ ...p, group, x: w.x, z: w.z });
    }
  }
  return out;
}

/**
 * Which bank a point is on. Computed, never declared - see the note above.
 * @returns {'vale'|'far'}
 */
export function bankOf(x, z) {
  return z > riverZ(x) ? 'far' : 'vale';
}

/**
 * Beaten-earth ground features for a camp, for `Settlements.js`.
 *
 * One disc, feathered generously: a camp does not have a paved yard, it has a
 * patch of grass that thirty people and eight oxen have walked flat, and the
 * boundary of that is a gradient rather than a kerb. The radius is the camp's
 * own working radius less two metres so the fringe of the feather lands
 * roughly where the outermost tent peg does.
 */
export function campGround(camp) {
  return [{ shape: 'disc', x: camp.x, z: camp.z, r: camp.radius - 2, feather: 9.0 }];
}
