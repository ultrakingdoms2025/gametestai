/**
 * Authors `public/assets/ship/kestrel-hull.glb` — the Kestrel's outer skin.
 *
 *   node scripts/make-ship-glb.mjs
 *
 * ═══════════════════════════════════════════════════════════════════════════
 *  WHY THIS FILE EXISTS: THE PRIMITIVE WAS THE PROBLEM, NOT THE EFFORT
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Three art passes tried to make the yard's hulls read as spacecraft and three
 * times the player came back with the same sentence: "spaceships do not look
 * like spaceships, they look like they are made of square blocks." That is not
 * a taste dispute. `Hulls.js` makes 197 `box()` calls, because `ShipKit` is a
 * box kit — which is exactly right for the Citadel, where buildings ARE boxes,
 * and cannot be argued into being right for a hull. A fourth pass of box
 * assembly would have produced a fourth box stack.
 *
 * So the geometry moves off the runtime primitive entirely. This script is a
 * plain Node program with `three` in hand and nothing else: it evaluates a
 * parametric hull — smooth curves through control tables, sections swept along
 * splined rails, per-vertex normals with named creases — and bakes the result
 * to a binary glTF that the game loads as data. Nothing here has to be
 * expressible as an axis-aligned box, which is the whole point.
 *
 * "Authored" therefore means PROCEDURALLY AUTHORED IN THIS REPOSITORY, which
 * is the same thing `scripts/make-newel-glb.mjs` means by it and the same
 * licence line (`generated`): re-run this script and the byte-identical file
 * comes back. `scripts/tests/ship-assets.test.mjs` re-runs it into a temp
 * directory and diffs the bytes, so a hand-edited .glb cannot survive.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 *  WHAT THE SHAPE IS ALLOWED TO BE, AND WHAT IT IS NOT
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * The Kestrel is a 14 m courier with a 4.16 m wide, 2.00 m tall, 6.8 m long
 * walk-in compartment inside her, a walkable deck at y 2.92, a walkable dorsal
 * spine at 5.16 and three climb bands that grip named faces. Those are
 * contracts in `HullPlan.js` and this file does not get to break them — so the
 * flanks stay near-vertical over the room, and the two decks stay flat.
 *
 * Everything else is free, and everything else is where a courier lives:
 *
 *   - **One surface from transom to nose tip.** The plated drum, the four
 *     stepped nose boxes and the flat belly box become a single swept skin
 *     whose sections are built from a keel flat, a radiused bilge, a cambered
 *     flank and a crowned deck edge. There is no step in it anywhere.
 *   - **A chisel nose, drooped.** The top line falls faster than the keel
 *     rises, so the profile forward of the cockpit is a wedge aimed slightly
 *     down — 4.4 m of it, ending in a chisel measured at 0.20 m across and
 *     0.28 m deep.
 *   - **A raked windscreen that IS the front of the dorsal.** The spine deck
 *     has to be 2.24 m above the section ledge, and a box that tall behind a
 *     flat canopy is a deckhouse — which is precisely what the player saw. So
 *     the rise happens FORWARD of the spine instead: the dorsal's leading face
 *     rakes up from the cockpit roof to the spine at a measured 25.5 degrees
 *     over 4.5 m, and the glazing is set into the bottom of that rake, over
 *     the seat at z 2.40.
 *   - **Nacelles with throats.** Each pod is a tube: an outer shell, an intake
 *     duct running aft from a rolled lip, and a nozzle flaring to the exit
 *     plane. You can see into both ends, which a disc cannot do.
 *   - **Swept wings.** The pods were carried on stub pylons buried under them;
 *     they are on swept, tapered aerofoils now that leave the flank aft of the
 *     boarding ramp and fair into the pod's inboard shoulder.
 *   - **Smooth shading with named creases.** Every other surface in the yard is
 *     a box face, and this one is not: normals are averaged within a patch and
 *     split at the chine, the deck edge and the wing leading edge, so the
 *     flank shades as a curve and the chine still reads as a line.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 *  THE NUMBERS THAT ARE NOT MINE TO CHOOSE
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Duplicated from `HullPlan.KESTREL` deliberately: this script must run under
 * plain Node with no import of the game's source, and every one of these is
 * asserted against the live plan by `ship-assets.test.mjs`, so the copy cannot
 * drift silently.
 *
 *   z0/z1        -6.20 / 7.80   overall length, keel origin at y 0
 *   belly.y0      0.36          SADDLE_TOP: the cradle's bearing blocks
 *   lower.hw      2.30          flank outer face; climb band 1 grips it
 *   ledge.y       2.92          walkable section deck (drawn as a slab)
 *   rooms hw      2.08          compartment half-beam — the skin clears it
 *   rooms ceilY   2.76          deck plate underside; the skin closes under it
 *   spine.y       5.16          walkable dorsal spine (drawn as a slab)
 *   upper.hw      1.15          dorsal flank; climb band 2 grips it
 *   nacelle       x 3.00..4.60, y 0.60..1.60, z -6.60..-2.90
 *   hatch         lz -1.50, w 1.10, h 2.00, sill at deck.y 0.76
 *   vtail         rootX 0.30, rootY 2.48, z -5.15, span 2.85, cant 0.66
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as THREE from 'three';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
/**
 * Which hull to bake. One script and not one script per hull, because every
 * hull in this yard shares the curve, the sweep, the crease rule, the foil and
 * the NaN gate — four copies of those would be four things to fix when one of
 * them turns out to be wrong, which has already happened three times here.
 *
 *   node scripts/make-ship-glb.mjs                       -> kestrel-hull.glb
 *   SHIP_GLB_HULL=bastion node scripts/make-ship-glb.mjs -> bastion-hull.glb
 *   SHIP_GLB_HULL=dray    node scripts/make-ship-glb.mjs -> dray-hull.glb
 */
const HULL_ID = process.env.SHIP_GLB_HULL || 'kestrel';
const OUT = process.env.SHIP_GLB_OUT
  ? path.resolve(process.env.SHIP_GLB_OUT)
  : path.join(root, `public/assets/ship/${HULL_ID}-hull.glb`);

/* ------------------------------------------------------------------ */
/* The plan constants this hull is cut to                              */
/* ------------------------------------------------------------------ */

export const PLAN = {
  z0: -6.20, z1: 7.80,
  bellyY0: 0.36,
  lowerHW: 2.30,
  ledgeY: 2.92,
  roomHW: 2.08,
  ceilY: 2.76,
  spineY: 5.16,
  upperHW: 1.15,
  nacelle: { x0: 3.00, x1: 4.60, y0: 0.60, y1: 1.60, z0: -6.60, z1: -2.90 },
  hatch: { lz: -1.50, w: 1.10, h: 2.00, sill: 0.76 },
  vtail: { rootX: 0.30, rootY: 2.48, z: -5.15, span: 2.85, cant: 0.66, chordRoot: 1.65, chordTip: 0.78 },
};

/** Metres of hull per texture tile. `ShipKit.boxUV` uses 2 for plating. */
const TILE = 2.2;

/* ------------------------------------------------------------------ */
/* Curves: monotone cubic through a control table                      */
/* ------------------------------------------------------------------ */

/**
 * Fritsch-Carlson monotone cubic interpolation over `[[x, y], ...]`.
 *
 * Monotone rather than plain Catmull-Rom because every table below is a hull
 * dimension and a spline that OVERSHOOTS its control points is a hull that
 * bulges 4 cm outboard of the flank the climb grips, or a keel that dips
 * through the cradle's bearing blocks. Overshoot is not a styling choice you
 * get to review — it is invisible in the table and visible in the game.
 */
function curve(pts) {
  const n = pts.length;
  const xs = pts.map((p) => p[0]);
  /* Ascending, and this guard is not theoretical: the dorsal's three control
   * tables were first written bow-to-stern, every lookup fell off the front of
   * the table and returned its first value, and the fairing was built 0.02 m
   * tall for its whole length — a spine deck plate floating 2.2 m over nothing,
   * with no error anywhere. */
  for (let i = 1; i < n; i++) {
    if (!(xs[i] > xs[i - 1])) {
      throw new Error(`curve: control points must ascend in x — ${xs[i - 1]} then ${xs[i]}`);
    }
  }
  const ys = pts.map((p) => p[1]);
  const dx = [], dy = [], slope = [];
  for (let i = 0; i < n - 1; i++) {
    dx.push(xs[i + 1] - xs[i]);
    dy.push(ys[i + 1] - ys[i]);
    slope.push(dy[i] / dx[i]);
  }
  const m = new Array(n);
  m[0] = slope[0];
  m[n - 1] = slope[n - 2];
  for (let i = 1; i < n - 1; i++) {
    if (slope[i - 1] * slope[i] <= 0) m[i] = 0;
    else {
      const w1 = 2 * dx[i] + dx[i - 1], w2 = dx[i] + 2 * dx[i - 1];
      m[i] = (w1 + w2) / (w1 / slope[i - 1] + w2 / slope[i]);
    }
  }
  return (x) => {
    if (x <= xs[0]) return ys[0];
    if (x >= xs[n - 1]) return ys[n - 1];
    let i = 0;
    while (i < n - 2 && x > xs[i + 1]) i++;
    const h = dx[i], t = (x - xs[i]) / h;
    const t2 = t * t, t3 = t2 * t;
    return (2 * t3 - 3 * t2 + 1) * ys[i] + (t3 - 2 * t2 + t) * h * m[i]
      + (-2 * t3 + 3 * t2) * ys[i + 1] + (t3 - t2) * h * m[i + 1];
  };
}

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
const smooth = (t) => { const u = clamp01(t); return u * u * (3 - 2 * u); };

/* ------------------------------------------------------------------ */
/* THE FUSELAGE, AS FOUR CURVES AND A SECTION RULE                     */
/* ------------------------------------------------------------------ */

/**
 * Half-beam of the skin, by station.
 *
 * Full beam is held from z -4.40 to 3.40 and that is not laziness: the flank's
 * outer face at 2.30 is what `plated` collides and what climb band 1 grips at
 * z -4.20, and the compartment behind it is 4.16 m across. Pinching the plan
 * where the room is would either hand the player a collider 20 cm outboard of
 * the plating they can see, or eat the cabin. So the taper is spent where it
 * is free: 2.8 m of boat-tail aft and 4.4 m of nose forward, both faired.
 */
const HW = curve([
  [-6.20, 0.30], [-5.90, 0.62], [-5.40, 1.22], [-4.90, 1.86], [-4.55, 2.18],
  [-4.40, 2.28], [-3.40, 2.30], [0.00, 2.30], [3.40, 2.28], [3.80, 2.20],
  [4.40, 1.92], [5.10, 1.50], [5.80, 1.06], [6.50, 0.68], [7.20, 0.36],
  [7.80, 0.10],
]);

/**
 * The keel line. Flat on 0.36 under the cradle's saddles — `SADDLE_TOP`, and a
 * keel below it is drawn through the bearing blocks — then lifting into both
 * ends so the underside is a curved surface along its length rather than the
 * one big plane the audit measured at 15% of the Kestrel's visible skin.
 */
const YBOT = curve([
  [-6.20, 1.44], [-5.80, 1.05], [-5.20, 0.70], [-4.60, 0.47], [-4.00, 0.38],
  [-3.20, 0.36], [2.40, 0.36], [3.20, 0.40], [3.90, 0.56], [4.60, 0.80],
  [5.40, 1.03], [6.30, 1.22], [7.20, 1.33], [7.80, 1.38],
]);

/**
 * The crown line, and every kink in it is a contract.
 *
 * 2.76 from z -4.40 to 3.60 is the compartment's own ceiling: the section deck
 * plate's underside aft of z 1.00, the cockpit's deckhead forward of it. The
 * skin closes exactly there and the drawn slab caps it, which is rule 2 of
 * `Hulls.js` — one plate, ledge on top, ceiling underneath.
 *
 * Forward of 3.60 it falls faster than {@link YBOT} rises: that difference IS
 * the droop, and it is what makes the nose read as a wedge aimed slightly down
 * rather than as a cone on a tube.
 */
const YTOP = curve([
  [-6.20, 1.86], [-5.80, 2.18], [-5.20, 2.52], [-4.60, 2.70], [-4.40, 2.74],
  [-3.40, 2.76], [1.00, 2.76], [1.45, 2.88], [3.40, 2.90], [3.62, 2.86],
  [4.20, 2.62], [5.00, 2.32], [5.80, 2.06], [6.60, 1.86], [7.20, 1.74],
  [7.80, 1.66],
]);

/** Half-width of the flat of the keel, as a fraction of the half-beam. */
const KEELW = curve([
  [-6.20, 0.55], [-5.20, 0.42], [-4.40, 0.38], [0.00, 0.40], [3.40, 0.40],
  [5.00, 0.46], [6.60, 0.60], [7.80, 0.72],
]);

/**
 * Half-width of the flat of the crown, as a fraction of the half-beam.
 *
 * 0.94 amidships, which looks like nothing and is a measurement: the section
 * deck plate is drawn out to 2.30 and its edge is 0.16 m deep, so a crown that
 * rolled in to 0.82 would leave the plate overhanging the skin by 41 cm with
 * its underside in view from the apron. At 0.94 the overhang is 14 cm — a deck
 * edge — and the roll happens where there is no plate over it.
 */
const TOPW = curve([
  [-6.20, 0.52], [-5.20, 0.62], [-4.40, 0.80], [-3.40, 0.94], [0.00, 0.94],
  [3.40, 0.90], [4.60, 0.72], [6.00, 0.56], [7.80, 0.42],
]);

/** Radius of the turn of the bilge. 0.36 puts the flank's foot on y 0.72. */
const BILGE = 0.36;
/** Height of the roll at the deck edge, under the slab that caps it. */
const CROWN = 0.16;
/**
 * How far the flank bows outboard at mid-height, in metres.
 *
 * The room needs 2.08 and the collider is at 2.30, so the whole budget for
 * shape in the flank is 22 cm and it has to be spent as a BOW rather than as a
 * tumblehome: bowing tucks the flank at the sole and at the deck edge and
 * leaves the waist on 2.30, so the face the climb grips and the face the
 * plating collides are still the same face, and the surface between them is
 * curved. Measured off the baked mesh, the tightest the flank comes to the
 * compartment is x 2.170 at y 2.72 — 0.09 m outboard of the room's own face,
 * and `ship-assets.test.mjs` fails on any vertex that gets inside it.
 */
const BOW = 0.11;

/** The boarding aperture, in the flank, as `plated`'s opening record cuts it. */
const DOOR = {
  z0: PLAN.hatch.lz - PLAN.hatch.w / 2,   // -2.05
  z1: PLAN.hatch.lz + PLAN.hatch.w / 2,   // -0.95
  y0: 0.72,                               // the foot of the flank, 4 cm under the sole
  y1: PLAN.ceilY,                         // 2.76, the deck plate's underside
};
/** Metres either side of the aperture over which the flank flattens to meet it. */
const DOOR_FAIR = 0.55;

/**
 * 1 where the flank must be a flat vertical panel, 0 where it is free.
 *
 * A door is a rectangle and a door leaf is a plane. Cutting a rectangular hole
 * in a bowed, crowned surface leaves an opening whose head is 10 cm shy of the
 * 2.00 m the plan promises and whose leaf stands proud of the skin at the sill
 * and buried in it at the head. So the surround is flat — which is what a real
 * hull does with a shell door, and what `knuckle`'s own note already says
 * about the Dray: "where a hull has a shell door the surround IS the strake".
 */
function doorPanel(z) {
  const d = Math.max(DOOR.z0 - z, z - DOOR.z1, 0);
  return 1 - smooth(d / DOOR_FAIR);
}

/**
 * One section of the fuselage, as a closed ring of points in the hull's XY.
 *
 * Rails are the same count at every station — they have to be, a swept surface
 * is a grid — and every one of them is named, because the creases and the
 * aperture are addressed by rail index and an off-by-one there is a hole in
 * the wrong place.
 */
const RAIL = Object.freeze({
  keelCentre: 0,   // on the centreline, bottom
  keelEdge: 1,     // end of the flat of the keel
  bilge0: 2,       // \
  bilge1: 3,       //  } the turn of the bilge
  chine: 4,        // foot of the flank — CREASE, and the aperture's sill
  flank0: 5,
  flank1: 6,       // the waist: full beam
  flank2: 7,
  deckEdge: 8,     // head of the flank — CREASE, and the aperture's head
  crown: 9,        // the roll over the deck edge
  topEdge: 10,     // end of the flat of the crown
  topCentre: 11,   // on the centreline, top
});
const HALF_RAILS = 12;
/** Rails whose normal is SPLIT: the surface creases here instead of rounding. */
const FUSELAGE_CREASES = [RAIL.chine, RAIL.deckEdge];

function fuseSection(z) {
  const yb = YBOT(z), yt = YTOP(z), hw = HW(z);
  const h = yt - yb;
  const flat = doorPanel(z);
  const bilge = Math.min(BILGE, h * 0.30) * (1 - 0.55 * flat);
  const crown = Math.min(CROWN, h * 0.14) * (1 - flat);
  const keel = KEELW(z) * hw;
  const topHalf = THREE.MathUtils.lerp(TOPW(z) * hw, hw - crown, flat);
  const bow = BOW * (1 - flat) * clamp01(hw / PLAN.lowerHW);

  const yChine = yb + bilge;
  const yDeck = yt - crown;
  /* The flank, bowed: full beam at the waist, tucked at the sole and at the
   * deck edge. `t` is 0 at the chine and 1 at the deck edge. */
  const flankX = (t) => hw - bow * (2 * t - 1) * (2 * t - 1);
  const at = (t) => [flankX(t), THREE.MathUtils.lerp(yChine, yDeck, t)];

  const half = new Array(HALF_RAILS);
  half[RAIL.keelCentre] = [0, yb];
  half[RAIL.keelEdge] = [keel, yb];
  for (let k = 1; k <= 2; k++) {
    const a = (k / 3) * (Math.PI / 2);
    half[RAIL.bilge0 + k - 1] = [keel + (flankX(0) - keel) * Math.sin(a), yb + bilge * (1 - Math.cos(a))];
  }
  half[RAIL.chine] = at(0);
  half[RAIL.flank0] = at(0.30);
  half[RAIL.flank1] = at(0.55);
  half[RAIL.flank2] = at(0.80);
  half[RAIL.deckEdge] = at(1);
  half[RAIL.crown] = [THREE.MathUtils.lerp(flankX(1), topHalf, 0.62), yt - crown * 0.28];
  half[RAIL.topEdge] = [topHalf, yt];
  half[RAIL.topCentre] = [0, yt];

  return closeRing(half);
}

/**
 * A half-section, mirrored into a closed ring.
 *
 * Order matters and it is the outward one: starboard side bottom-to-top, then
 * port side top-to-bottom, so consecutive points wind the same way at every
 * station and the sweep's face normals all point out of the hull.
 */
function closeRing(half) {
  const ring = half.map((p) => [p[0], p[1]]);
  for (let i = half.length - 2; i >= 1; i--) ring.push([-half[i][0], half[i][1]]);
  return ring;
}
/** Rail index of the mirror of a starboard rail, in a closed ring. */
const portRail = (r) => 2 * HALF_RAILS - 2 - r;

/**
 * Stations along the fuselage.
 *
 * Listed rather than stepped: curvature is not uniform along a hull, and the
 * two places that need a station exactly are the aperture's own edges — a
 * hole in a swept surface can only be cut on grid lines, so the grid has to
 * have lines where the hole is.
 */
const FUSE_Z = [
  -6.20, -6.00, -5.75, -5.45, -5.15, -4.85, -4.60, -4.40, -4.10, -3.70,
  -3.30, -2.90, -2.60, DOOR.z0, -1.80, -1.50, -1.20, DOOR.z1, -0.70, -0.30,
  0.20, 0.70, 1.20, 1.70, 2.30, 2.90, 3.40, 3.70, 4.05, 4.45,
  4.90, 5.40, 5.90, 6.40, 6.90, 7.35, 7.80,
];

/* ------------------------------------------------------------------ */
/* THE DORSAL: cockpit rake, spine, and the taper into the tail        */
/* ------------------------------------------------------------------ */

/**
 * The dorsal fairing's crown, by station — the line that used to be a box.
 *
 * `spine.y` is 5.16 and `ledge.y` is 2.92, so something 2.24 m tall stands on
 * this deck whatever it is shaped like. Made as a box behind a flat canopy it
 * is a deckhouse, and a deckhouse with a lattice mast on it is a boat, which
 * is what the player photographed. Made as a rake it is a fuselage: the crown
 * climbs from the cockpit roof at z 3.90 to the spine by z 0.60, holds the
 * spine's own 5.00 (the slab caps it to 5.16) back to z -3.60, and then falls
 * away into the boat-tail.
 */
const DORSAL_TOP = curve([
  [-5.85, 2.48], [-5.55, 3.02], [-5.10, 3.66], [-4.60, 4.28], [-4.10, 4.72],
  [-3.60, 5.00], [-0.60, 5.00], [0.20, 4.98], [0.80, 4.72], [1.40, 4.28],
  [2.00, 3.86], [2.60, 3.50], [3.20, 3.18], [3.90, 2.86],
]);

/**
 * Where the fairing's flanks stand. 1.15 over z -2.60..0.20 is climb band 2's
 * grip face and is held exactly; forward of that it widens into the cockpit
 * shoulders and aft of it it closes into the tail.
 */
const DORSAL_HW = curve([
  [-5.85, 0.18], [-5.55, 0.40], [-4.90, 0.70], [-4.20, 0.96], [-3.60, 1.12],
  [-2.60, 1.15], [0.20, 1.15], [0.80, 1.26], [1.40, 1.37], [2.20, 1.44],
  [3.00, 1.41], [3.90, 1.24],
]);

/** The foot of the fairing: the cockpit roof forward, the section deck aft. */
const DORSAL_BASE = curve([
  [-5.85, 1.98], [-5.55, 2.18], [-4.90, 2.50], [-4.20, 2.78], [-3.60, 2.90],
  [1.00, 2.90], [1.45, 2.86], [3.40, 2.82], [3.90, 2.74],
]);

/**
 * ASCENDING, like every other station list here, and that is load-bearing.
 *
 * `sweep` builds each quad from a station and its successor and takes the face
 * normal from the cross product, so a list running the other way turns the
 * whole surface inside out: every normal points into the hull and back-face
 * culling deletes it. The first build of this file listed the dorsal from the
 * nose aft, and the fairing simply was not in the render — no error, no
 * warning, a ship with a flat deck where its spine should be. `sweep` now
 * refuses a descending list rather than drawing an invisible one.
 */
const DORSAL_Z = [
  -5.85, -5.60, -5.25, -4.85, -4.40, -4.00, -3.60, -3.10, -2.50, -1.80,
  -1.10, -0.50, 0.00, 0.30, 0.60, 0.90, 1.20, 1.50, 1.80, 2.10,
  2.40, 2.70, 3.00, 3.30, 3.60, 3.90,
];

/**
 * A dorsal section: a flat crown with rounded shoulders on a splayed base.
 * Same rail count as the fuselage's own ring so the two read as one language.
 */
function dorsalSection(z) {
  const top = DORSAL_TOP(z), base = DORSAL_BASE(z), hw = DORSAL_HW(z);
  const h = Math.max(0.04, top - base);
  const shoulder = Math.min(0.30, h * 0.34);
  const crownHalf = Math.max(0.02, hw - Math.min(0.34, hw * 0.30));
  const half = [
    [hw * 0.55, base],
    [hw, base],
    [hw, base + h * 0.34],
    [hw, top - shoulder],
    [THREE.MathUtils.lerp(hw, crownHalf, 0.60), top - shoulder * 0.26],
    [crownHalf, top],
    [crownHalf * 0.5, top],
    [0, top],
  ];
  const ring = half.map((p) => [p[0], p[1]]);
  for (let i = half.length - 2; i >= 0; i--) ring.push([-half[i][0], half[i][1]]);
  return ring;
}

/* ------------------------------------------------------------------ */
/* Surfaces: a swept grid with creases, holes and per-vertex normals   */
/* ------------------------------------------------------------------ */

/**
 * Sweep a set of same-arity sections into a smooth-shaded surface.
 *
 * ── Why this is not `Hulls.loftGeo` ─────────────────────────────────────────
 * `loftGeo` emits one flat-shaded facet per quad, deliberately: "every other
 * surface in this yard is a box face, and a smoothly-shaded hull beside a
 * hard-edged shed reads as a different game." That argument held while the
 * hull WAS boxes. On a 22-rail section it is what turns a fair curve into the
 * faceted grey lump the review photographed — the shading says "polygon" at
 * every station whatever the silhouette says.
 *
 * So normals are averaged here, and the creases are named instead. The surface
 * is cut into patches at `creaseRails`; each patch owns its own copy of the
 * boundary rail, so the chine and the deck edge stay knife-sharp while the
 * flank between them shades as one continuous surface.
 *
 * @param {{z:number, pts:[number,number][]}[]} stations
 * @param {object} o
 * @param {number[]} [o.creaseRails] rail indices where the normal splits
 * @param {(s:number, r:number)=>boolean} [o.skip] omit this quad (a hole)
 * @param {boolean} [o.closed] the section ring wraps r = n-1 -> 0
 * @param {boolean} [o.capFore] / [o.capAft] close the ends with a fan
 * @param {number} [o.tile] metres per texture tile
 */
function sweep(stations, o = {}) {
  const closed = o.closed !== false;
  const n = stations[0].pts.length;
  for (let i = 1; i < stations.length; i++) {
    if (!(stations[i].z > stations[i - 1].z)) {
      throw new Error(`sweep: stations must ascend — ${stations[i - 1].z} then ${stations[i].z}. `
        + 'A descending list reverses every face normal and the surface renders as nothing at all.');
    }
    if (stations[i].pts.length !== n) throw new Error('sweep: every station needs the same rail count');
  }
  const tile = o.tile ?? TILE;
  const creases = new Set(o.creaseRails ?? []);
  const skip = o.skip ?? (() => false);
  const S = stations.length;

  /* Arc length round each section and along the hull, in metres: the same
   * constant-texel-density rule `boxUV` applies to every box in this world, so
   * an authored flank and a procedural deck plate carry the same plate size. */
  const us = stations.map((s) => {
    const acc = [0];
    for (let k = 1; k <= n; k++) {
      const p = s.pts[k - 1], q = s.pts[k % n];
      acc.push(acc[k - 1] + Math.hypot(q[0] - p[0], q[1] - p[1]));
    }
    return acc;
  });
  /**
   * Arc length at rail `k`, WHERE k MAY RUN PAST THE END OF THE RING.
   *
   * A patch between the last crease and the first one wraps: with creases at
   * rails 4, 8, 14 and 18 of a 22-rail section the fourth patch is 18..26, and
   * `us` only has 23 entries. Reading past it gives `undefined`, `undefined /
   * tile` is NaN, and a NaN texture coordinate is not a few bad pixels - the
   * bloom pass high-passes the frame and smears one NaN texel through five mip
   * levels, so the additive composite writes NaN over EVERY pixel and the
   * whole frame goes flat. `ShipBuild._tile` carries the same warning for
   * boxes and it is the same failure: this hull's first build in the browser
   * rendered as a white screen with a ship-shaped hole in it.
   */
  const arc = (s, k) => (k <= n ? us[s][k] : us[s][n] + us[s][k - n]);

  /* Patches: [r0, r1] inclusive ranges between creases. A closed ring with no
   * crease is one patch that wraps; with creases it is one patch per arc. */
  const patches = [];
  if (!closed) {
    let start = 0;
    for (let r = 1; r < n - 1; r++) if (creases.has(r)) { patches.push([start, r]); start = r; }
    patches.push([start, n - 1]);
  } else if (creases.size === 0) {
    patches.push([0, n]);           // n means "wrap back to 0"
  } else {
    const cs = [...creases].sort((a, b) => a - b);
    for (let i = 0; i < cs.length; i++) {
      const a = cs[i], b = cs[(i + 1) % cs.length];
      patches.push([a, b > a ? b : b + n]);
    }
  }

  const pos = [], nrm = [], uv = [], idx = [];
  const A = new THREE.Vector3(), B = new THREE.Vector3(), C = new THREE.Vector3();
  const e1 = new THREE.Vector3(), e2 = new THREE.Vector3(), fn = new THREE.Vector3();

  for (const [r0, r1] of patches) {
    const cols = r1 - r0 + 1;
    const base = pos.length / 3;
    const acc = [];
    for (let s = 0; s < S; s++) {
      for (let c = 0; c < cols; c++) {
        const r = (r0 + c) % n;
        const p = stations[s].pts[r];
        pos.push(p[0], p[1], stations[s].z);
        uv.push(arc(s, r0 + c) / tile, stations[s].z / tile);
        acc.push(new THREE.Vector3());
      }
    }
    const vid = (s, c) => base + s * cols + c;
    const local = (s, c) => (s * cols + c);
    const face = (a, b, c2) => {
      A.fromArray(pos, a * 3); B.fromArray(pos, b * 3); C.fromArray(pos, c2 * 3);
      e1.subVectors(B, A); e2.subVectors(C, A);
      fn.crossVectors(e1, e2);
      // A zero-area facet is a rail two curves agreed on. Dropping it is what
      // lets one section rule serve a full-beam waist and a knife-edge tip.
      if (fn.lengthSq() < 1e-12) return;
      idx.push(a, b, c2);
      fn.normalize();
      acc[a - base].add(fn); acc[b - base].add(fn); acc[c2 - base].add(fn);
    };
    for (let s = 0; s < S - 1; s++) {
      for (let c = 0; c < cols - 1; c++) {
        if (skip(s, (r0 + c) % n)) continue;
        const a = vid(s, c), b = vid(s, c + 1), c2 = vid(s + 1, c + 1), d = vid(s + 1, c);
        face(a, b, c2);
        face(a, c2, d);
      }
    }
    for (let i = 0; i < acc.length; i++) {
      const v = acc[i];
      if (v.lengthSq() < 1e-12) v.set(0, 1, 0); else v.normalize();
      nrm.push(v.x, v.y, v.z);
    }
    void local;
  }

  /* End caps, as a fan on the section's own centroid. Their normals are the
   * cap's, never the skin's, so a transom stays a transom. */
  const cap = (station, fore) => {
    const base = pos.length / 3;
    let mx = 0, my = 0;
    for (const p of station.pts) { mx += p[0]; my += p[1]; }
    mx /= n; my /= n;
    pos.push(mx, my, station.z);
    uv.push(mx / tile, my / tile);
    nrm.push(0, 0, fore ? 1 : -1);
    for (let k = 0; k < n; k++) {
      const p = station.pts[k];
      pos.push(p[0], p[1], station.z);
      uv.push(p[0] / tile, p[1] / tile);
      nrm.push(0, 0, fore ? 1 : -1);
    }
    for (let k = 0; k < n; k++) {
      const a = base, b = base + 1 + k, c = base + 1 + ((k + 1) % n);
      if (fore) idx.push(a, b, c); else idx.push(a, c, b);
    }
  };
  if (o.capFore) cap(stations[S - 1], true);
  if (o.capAft) cap(stations[0], false);

  /* `flip` turns a surface outside-in, which is what a DUCT is: the visible
   * face of an intake or a nozzle is its inside, so its normals point at the
   * axis and its triangles wind the other way. Spelled as a flag rather than
   * got at by listing the stations backwards, because backwards is also
   * exactly how a surface goes accidentally invisible - see DORSAL_Z. */
  if (o.flip) {
    for (let i = 0; i < nrm.length; i++) nrm[i] = -nrm[i];
    for (let i = 0; i < idx.length; i += 3) { const t = idx[i + 1]; idx[i + 1] = idx[i + 2]; idx[i + 2] = t; }
  }

  return { pos, nrm, uv, idx };
}

/** Merge parts built by {@link sweep} into one buffer set. */
function join(...parts) {
  const out = { pos: [], nrm: [], uv: [], idx: [] };
  for (const p of parts) {
    if (!p) continue;
    const base = out.pos.length / 3;
    out.pos.push(...p.pos);
    out.nrm.push(...p.nrm);
    out.uv.push(...p.uv);
    for (const i of p.idx) out.idx.push(i + base);
  }
  return out;
}

/** Move a part in the hull frame, and optionally mirror it across X. */
function place(part, dx = 0, dy = 0, dz = 0, mirror = false) {
  const out = { pos: [], nrm: [], uv: part.uv.slice(), idx: [] };
  const m = mirror ? -1 : 1;
  for (let i = 0; i < part.pos.length; i += 3) {
    out.pos.push(part.pos[i] * m + dx, part.pos[i + 1] + dy, part.pos[i + 2] + dz);
    out.nrm.push(part.nrm[i] * m, part.nrm[i + 1], part.nrm[i + 2]);
  }
  if (mirror) for (let i = 0; i < part.idx.length; i += 3) out.idx.push(part.idx[i], part.idx[i + 2], part.idx[i + 1]);
  else out.idx.push(...part.idx);
  return out;
}

/* ------------------------------------------------------------------ */
/* The parts                                                           */
/* ------------------------------------------------------------------ */

/** The fuselage: one swept skin from the transom to the nose tip. */
function fuselage() {
  const stations = FUSE_Z.map((z) => ({ z, pts: fuseSection(z) }));
  const s0 = FUSE_Z.indexOf(DOOR.z0), s1 = FUSE_Z.indexOf(DOOR.z1);
  if (s0 < 0 || s1 < 0) throw new Error('the aperture needs a station on each of its own edges');
  /* The hole. Quads are addressed by their LOW station and LOW rail, and the
   * rails between `chine` and `deckEdge` are exactly the flank — which is why
   * both of them are named constants and not literals. */
  const skip = (s, r) => s >= s0 && s < s1 && r >= RAIL.chine && r < RAIL.deckEdge;
  const skin = sweep(stations, {
    creaseRails: [RAIL.chine, RAIL.deckEdge, portRail(RAIL.chine), portRail(RAIL.deckEdge)],
    skip,
    capAft: true,
  });
  /* The reveal: the aperture turned 0.22 m inboard, so the doorway is a
   * recess with a jamb rather than a paper edge you can see the far side of.
   * `SKIN` is 0.22 and this is the same plate. */
  const t = 0.22;
  const rim = { pos: [], nrm: [], uv: [], idx: [] };
  const quad = (p, q, r, s2, nx, ny, nz) => {
    const b = rim.pos.length / 3;
    for (const v of [p, q, r, s2]) {
      rim.pos.push(v[0], v[1], v[2]);
      rim.nrm.push(nx, ny, nz);
      rim.uv.push(v[2] / TILE, v[1] / TILE);
    }
    rim.idx.push(b, b + 1, b + 2, b, b + 2, b + 3);
  };
  const edge = (s, r) => {
    const p = stations[s].pts[r];
    return [p[0], p[1], stations[s].z];
  };
  const inb = (v) => [v[0] - t, v[1], v[2]];
  for (let s = s0; s < s1; s++) {
    // sill and head, running fore-and-aft
    const a = edge(s, RAIL.chine), b = edge(s + 1, RAIL.chine);
    quad(inb(a), inb(b), b, a, 0, -1, 0);
    const c = edge(s, RAIL.deckEdge), d = edge(s + 1, RAIL.deckEdge);
    quad(c, d, inb(d), inb(c), 0, 1, 0);
  }
  for (const [s, sign] of [[s0, -1], [s1, 1]]) {
    const a = edge(s, RAIL.chine), b = edge(s, RAIL.deckEdge);
    if (sign < 0) quad(a, b, inb(b), inb(a), 0, 0, 1);
    else quad(inb(a), inb(b), b, a, 0, 0, -1);
  }
  return join(skin, rim);
}

/** The dorsal fairing: the cockpit rake, the spine, and the run into the tail. */
function dorsal() {
  const stations = DORSAL_Z.map((z) => ({ z, pts: dorsalSection(z) }));
  return sweep(stations, { creaseRails: [], capFore: true, capAft: true, tile: 2.0 });
}

/**
 * An aerofoil section: a rounded nose, a straight-ish taper, a sharp trailing
 * edge. Returned in the wing's own frame — x along the chord, y across the
 * thickness — so a wing, a fin and a pylon are the same function.
 */
function aerofoil(chord, thick, n = 8) {
  const pts = [];
  const yt = (t) => thick * 5 * (0.2969 * Math.sqrt(t) - 0.1260 * t - 0.3516 * t * t + 0.2843 * t * t * t - 0.1015 * t * t * t * t);
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    pts.push([t * chord, yt(t)]);
  }
  for (let i = n - 1; i >= 1; i--) {
    const t = i / n;
    pts.push([t * chord, -yt(t)]);
  }
  return pts;
}

/**
 * A lifting surface, swept and tapered: a wing, a V-tail fin, a dorsal fin.
 *
 * ── Why this is built in its own frame and mapped, not built in place ───────
 * `sweep` sweeps along +Z, so a surface built directly in hull coordinates has
 * to have its span along Z — which a wing does not and a vertical fin REALLY
 * does not. The first version interpolated the leading edge from root to tip in
 * hull coordinates and used the X component as the sweep parameter; the wings
 * and the V-tail worked and the dorsal fin, whose span is purely vertical,
 * collapsed to a set of coincident stations and emitted nothing.
 *
 * So the foil is built canonically — span along +Z, chord along +X, thickness
 * along +Y — and mapped by an orthonormal basis: the span axis is where the
 * tip is, the chord axis is aft (-Z in the hull, always: these are all
 * trailing surfaces), and the thickness axis is what is left over. A basis
 * with a negative determinant would mirror the surface, so the winding is
 * flipped when it is.
 *
 * @param {object} o
 * @param {[number,number,number]} o.root leading edge at the root, hull frame
 * @param {[number,number,number]} o.tip  leading edge at the tip, hull frame
 */
function foil(o) {
  const { root, tip, chordRoot, chordTip, thickRoot, thickTip, n = 7 } = o;
  const span = new THREE.Vector3(tip[0] - root[0], tip[1] - root[1], tip[2] - root[2]);
  const len = span.length();
  if (len < 0.05) throw new Error('foil: root and tip are the same point');
  const ez = span.clone().normalize();                       // canonical +Z -> the span
  /* Canonical +X is the chord, which runs AFT — and is made perpendicular to
   * the span first, or a swept fin's basis is sheared and its section is not
   * the aerofoil it was given. */
  const aft = new THREE.Vector3(0, 0, -1);
  const ex = aft.clone().addScaledVector(ez, -aft.dot(ez)).normalize();
  const ey = new THREE.Vector3().crossVectors(ez, ex).normalize();

  const stations = [];
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    const e = smooth(t);
    const c = THREE.MathUtils.lerp(chordRoot, chordTip, e);
    const th = THREE.MathUtils.lerp(thickRoot, thickTip, e);
    stations.push({ z: t * len, pts: aerofoil(c, th, 7) });
  }
  const s = sweep(stations, { creaseRails: [], capFore: true, capAft: true, tile: 1.6 });

  const out = { pos: [], nrm: [], uv: s.uv.slice(), idx: s.idx.slice() };
  const v = new THREE.Vector3();
  const map = (a, i, addRoot) => {
    v.set(0, 0, 0)
      .addScaledVector(ex, a[i]).addScaledVector(ey, a[i + 1]).addScaledVector(ez, a[i + 2]);
    if (addRoot) v.add(new THREE.Vector3(root[0], root[1], root[2]));
    return v;
  };
  for (let i = 0; i < s.pos.length; i += 3) {
    const p = map(s.pos, i, true); out.pos.push(p.x, p.y, p.z);
    const nv = map(s.nrm, i, false); out.nrm.push(nv.x, nv.y, nv.z);
  }
  if (new THREE.Matrix4().makeBasis(ex, ey, ez).determinant() < 0) {
    for (let i = 0; i < out.idx.length; i += 3) {
      const a = out.idx[i + 1]; out.idx[i + 1] = out.idx[i + 2]; out.idx[i + 2] = a;
    }
  }
  return out;
}

/**
 * A nacelle section: a superellipse with a flatter top than bottom.
 *
 * The top is flat on purpose and the flatness is a climb number. Band 0 mantles
 * a body onto this pod and `Climb` lands it 0.77 m inboard of the outer face,
 * at local x 3.83 — where a circular pod's crown would be 17 cm below the
 * collider's top face and the player would stand on air. At exponent 3.4 the
 * baked skin at the outer edge of that stance (x 4.18) is y 1.585 — 1.5 cm
 * under the collider's top, and the crown itself is exactly on it.
 */
function podSection(hw, hh, cy, nTop = 3.4, nBot = 2.4, n = 20) {
  const pts = [];
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2;
    const ca = Math.cos(a), sa = Math.sin(a);
    const e = 2 / (sa >= 0 ? nTop : nBot);
    pts.push([
      Math.sign(ca) * Math.pow(Math.abs(ca), e) * hw,
      cy + Math.sign(sa) * Math.pow(Math.abs(sa), e) * hh,
    ]);
  }
  return pts;
}

const POD = {
  cx: (PLAN.nacelle.x0 + PLAN.nacelle.x1) / 2,          // 3.80
  hw: (PLAN.nacelle.x1 - PLAN.nacelle.x0) / 2,          // 0.80
  cy: (PLAN.nacelle.y0 + PLAN.nacelle.y1) / 2,          // 1.10
  hh: (PLAN.nacelle.y1 - PLAN.nacelle.y0) / 2,          // 0.50
  z0: PLAN.nacelle.z0, z1: PLAN.nacelle.z1,
};

/**
 * One engine pod, as a TUBE. The outer shell rolls over a lip at each end and
 * runs back inside itself as a duct, so both ends are open throats you can see
 * down rather than the flat magenta discs the last review named.
 */
function pod() {
  const shellZ = [
    POD.z0, POD.z0 + 0.14, POD.z0 + 0.42, POD.z0 + 0.9, POD.z0 + 1.5,
    -4.90, -4.30, -3.80, -3.40, -3.10, -2.98, POD.z1,
  ];
  const rad = curve([
    [POD.z0, 0.92], [POD.z0 + 0.14, 1.00], [POD.z0 + 0.42, 1.00], [POD.z0 + 0.9, 0.97],
    [-4.90, 0.99], [-4.30, 1.00], [-3.80, 0.99], [-3.40, 0.95], [-3.10, 0.88],
    [-2.98, 0.82], [POD.z1, 0.74],
  ]);
  const shell = sweep(shellZ.map((z) => ({
    z, pts: podSection(POD.hw * rad(z), POD.hh * rad(z), POD.cy),
  })), { creaseRails: [], tile: 1.8 });

  /* The intake duct, forward: in through the lip and aft into the dark. */
  const inZ = [POD.z1 - 1.7, POD.z1 - 1.2, POD.z1 - 0.6, POD.z1 - 0.18, POD.z1];
  const inR = curve([[POD.z1 - 1.7, 0.42], [POD.z1 - 1.2, 0.46], [POD.z1 - 0.6, 0.55], [POD.z1 - 0.18, 0.64], [POD.z1, 0.74]]);
  const intake = sweep(inZ.map((z) => ({
    z, pts: podSection(POD.hw * inR(z), POD.hh * inR(z), POD.cy, 3.0, 2.6),
  })), { creaseRails: [], capAft: true, flip: true, tile: 1.4 });

  /* The nozzle, aft: a throat that flares to the exit plane. */
  const exZ = [POD.z0, POD.z0 + 0.18, POD.z0 + 0.5, POD.z0 + 1.0, POD.z0 + 1.5];
  const exR = curve([[POD.z0, 0.92], [POD.z0 + 0.18, 0.80], [POD.z0 + 0.5, 0.62], [POD.z0 + 1.0, 0.50], [POD.z0 + 1.5, 0.46]]);
  const nozzle = sweep(exZ.map((z) => ({
    z, pts: podSection(POD.hw * exR(z), POD.hh * exR(z), POD.cy, 3.0, 2.6),
  })), { creaseRails: [], capFore: true, flip: true, tile: 1.4 });

  return { shell, duct: join(intake, nozzle) };
}

/**
 * The wing. Leaves the flank aft of the boarding ramp — the ramp runs out
 * across z -2.30..-0.70 and the pylon note in `HullPlan` records what happened
 * the last time something crossed it — and fairs into the pod's inboard
 * shoulder with 0.7 m of sweep.
 */
function wing() {
  return foil({
    /* x 2.22 and not 2.00. The wing has to start INSIDE the skin to look
     * attached to it, and the compartment behind that skin is 2.08 m to the
     * centreline: a root at 2.00 puts 22 vertices of aerofoil through the
     * cabin's port side, where a player standing in their own ship can see the
     * back of a wing. 2.22 is 0.07 m inside the flank and 0.14 m outside the
     * room. `ship-assets.test.mjs` measures it.
     *
     * z -3.00 and not -2.86 for the neighbouring reason: the boarding
     * aperture's slide pocket reaches z -2.575, and `HullPlan.pylon` records
     * what the last thing to cross this doorway cost. */
    root: [PLAN.lowerHW - 0.08, 1.34, -3.00],
    tip: [POD.cx, 1.16, -3.66],
    chordRoot: 1.70, chordTip: 2.10,
    thickRoot: 0.19, thickTip: 0.13,
    n: 6,
  });
}

/** The V-tail fin, splayed off the boat-tail. Plan numbers, new surface. */
function fin() {
  const V = PLAN.vtail;
  const dx = Math.sin(V.cant) * V.span, dy = Math.cos(V.cant) * V.span;
  return foil({
    root: [V.rootX, V.rootY, V.z + V.chordRoot / 2],
    tip: [V.rootX + dx, V.rootY + dy, V.z + V.chordRoot / 2 - 0.86],
    chordRoot: V.chordRoot, chordTip: V.chordTip,
    thickRoot: 0.15, thickTip: 0.09,
    n: 5,
  });
}

/**
 * The dorsal fin, and it is what the lattice mast used to be.
 *
 * The mast was there for one measured reason — broadside, everything that makes
 * this hull a courier is outboard and invisible, and the silhouette probe read
 * 1.18 lit runs per column against the Dray's 1.92 — and it answered it by
 * putting a boat's signal mast on a spaceship. A fin does the same job in the
 * same place. It is rooted AFT of the spine deck (which ends at z -3.60) so
 * nothing standing on that deck can walk into it.
 */
function dorsalFin() {
  return foil({
    root: [0, 4.86, -3.80],
    tip: [0, 6.46, -4.35],
    chordRoot: 1.55, chordTip: 0.62,
    thickRoot: 0.16, thickTip: 0.08,
    n: 5,
  });
}

/**
 * THE CANOPY, AND IT IS THE FRONT OF THE DORSAL RATHER THAN A BUBBLE ON IT.
 *
 * `HullPlan` puts the spine deck 2.24 m above the section deck, so SOMETHING
 * that tall stands on this hull whatever shape it is given. Built as a box
 * behind a flat canopy it is a deckhouse; built as a rake it is a fuselage.
 * The glazing lies on the bottom of that rake, over the seat at z 2.40, which
 * is the one place on this hull a windscreen belongs.
 *
 * Both surfaces are the fairing's OWN section pushed outward — 0.05 m for the
 * glass and 0.02 m for the frame under it — so the canopy follows the hull
 * exactly instead of being a second shape parked near it, and the 3 cm between
 * them is what makes the coaming read as a frame rather than as a decal. The
 * frame runs 0.10 m past the glass at each end, so the glazing is bordered on
 * all four sides.
 */
const CANOPY = { z0: 1.20, z1: 3.70, glassOut: 0.05, frameOut: 0.02 };

/**
 * One station of a band lying on the dorsal, from port to starboard.
 *
 * `lo` and `hi` are FRACTIONAL rail indices into `dorsalSection`'s starboard
 * half, because the coaming has to be a thin border round the glass and the
 * rails are 0.2 m apart: a frame snapped to whole rails is a 0.2 m band of
 * trim round every edge, which is what the first version drew and it read as
 * an orange fairing with a dark stripe in it rather than as a window.
 *
 * @param {number} z station
 * @param {number} lo first rail (may be fractional)
 * @param {number} hi last rail (may be fractional)
 * @param {number} out how far to push the band off the surface, in metres
 * @param {number} [n] samples across the band
 */
function dorsalBand(z, lo, hi, out, n = 6) {
  const ring = dorsalSection(z);
  const half = ring.slice(0, ring.length / 2 + 1);
  const cy = (DORSAL_BASE(z) + DORSAL_TOP(z)) / 2;
  const at = (r) => {
    const i = Math.max(0, Math.min(half.length - 2, Math.floor(r)));
    const t = Math.max(0, Math.min(1, r - i));
    return [
      THREE.MathUtils.lerp(half[i][0], half[i + 1][0], t),
      THREE.MathUtils.lerp(half[i][1], half[i + 1][1], t),
    ];
  };
  const push = ([x, y]) => {
    const dy = y - cy;
    const d = Math.hypot(x, dy) || 1;
    return [x + (x / d) * out, y + (dy / d) * out];
  };
  const star = [];
  for (let k = 0; k <= n; k++) star.push(push(at(THREE.MathUtils.lerp(lo, hi, k / n))));
  const pts = [];
  for (let i = star.length - 1; i >= 0; i--) pts.push([-star[i][0], star[i][1]]);
  pts.push(...star);
  return { z, pts };
}

function canopyBand(lo, hi, out, pad = 0, n = 6) {
  const zs = [];
  const steps = 9;
  for (let i = 0; i <= steps; i++) {
    zs.push(THREE.MathUtils.lerp(CANOPY.z0 - pad, CANOPY.z1 + pad, i / steps));
  }
  return sweep(zs.map((z) => dorsalBand(z, lo, hi, out, n)), { creaseRails: [], closed: false, tile: 1.6 });
}

/** The glazing: the fairing's shoulders and crown, over the cockpit. */
function glazing() {
  return canopyBand(2, 5, CANOPY.glassOut);
}

/**
 * The coaming: the same band, a quarter of a rail wider at each edge and
 * 0.09 m longer at each end, sitting 3 cm under the glass. That is the whole
 * frame — six centimetres of trim round a window, not a window in a fairing.
 */
function coaming() {
  return canopyBand(1.74, 5.26, CANOPY.frameOut, 0.09, 7);
}

/** The sill light down each side of the glazing, which is what sells it. */
function canopySill() {
  const zs = [];
  for (let i = 0; i <= 6; i++) zs.push(THREE.MathUtils.lerp(CANOPY.z0 + 0.05, CANOPY.z1 - 0.05, i / 6));
  const band = sweep(zs.map((z) => {
    const st = dorsalBand(z, 1.86, 2.02, CANOPY.frameOut + 0.012, 1);
    return st;
  }), { creaseRails: [], closed: false, tile: 1.0 });
  return band;
}

/**
 * STRUCTURE ON A CURVED SKIN, WHICH IS THE THING BOXES COULD NOT DO.
 *
 * The procedural hull carried its surface interest in `relief`, `panelLines`,
 * `course`, `bolts` and `rib` — 190-odd boxes pinned to a flank at exactly
 * `hw`. None of them can follow this skin: it bows to 2.30 at the waist and
 * tucks to 2.19 at the sole and the deck edge, so a patch pinned to the flank
 * would float 11 cm off its own hull at both ends of every station. Left with
 * nothing, a 14 m hull in one material reads as a smooth grey mass with no
 * scale to it — which is a different failure from "made of square blocks" and
 * still a failure.
 *
 * So the dressing is generated FROM the same section functions the skin is,
 * pushed a couple of centimetres off the surface it belongs to. It cannot
 * float, because it is the hull's own geometry moved 0.02 m outward.
 */

/** Push a section's points off the surface, radially from its own centre. */
function offsetPts(pts, cy, out) {
  return pts.map(([x, y]) => {
    const dy = y - cy;
    const d = Math.hypot(x, dy) || 1;
    return [x + (x / d) * out, y + (dy / d) * out];
  });
}

/** Centre height of a fuselage station, for {@link offsetPts}. */
const fuseCentre = (z) => (YBOT(z) + YTOP(z)) / 2;

/**
 * A transverse frame band round the fuselage: the section, 0.025 m proud, over
 * 0.18 m of length. Three of them, and none crosses the boarding aperture —
 * the whole point of `ShipBuild.apertures` is that a hull's dressing asks
 * first, and a ring round a hull is exactly the shape of thing that used to
 * run straight over a doorway.
 */
function frameRings() {
  const parts = [];
  for (const z of [-4.15, -0.35, 3.15]) {
    const stations = [z - 0.09, z + 0.09].map((zz) => ({
      z: zz, pts: offsetPts(fuseSection(zz), fuseCentre(zz), 0.025),
    }));
    parts.push(sweep(stations, { creaseRails: [RAIL.chine, RAIL.deckEdge], tile: 1.2 }));
  }
  return join(...parts);
}

/**
 * The chine strake: a band lying along the crease at the turn of the bilge,
 * the full length of the parallel body.
 *
 * A hull this beamy needs a horizontal line low down or the eye reads its
 * whole side as one surface; the chine is where a real one puts it, and the
 * crease is already there for it to sit on.
 */
function chineStrake() {
  const zs = FUSE_Z.filter((z) => z >= -5.0 && z <= 6.2);
  const stations = zs.map((z) => {
    const sec = fuseSection(z);
    const cy = fuseCentre(z);
    const band = [RAIL.bilge1, RAIL.chine, RAIL.flank0].map((r) => sec[r]);
    /* Only the first fifth of the way up the flank — a strake, not a panel. */
    band[2] = [
      THREE.MathUtils.lerp(sec[RAIL.chine][0], sec[RAIL.flank0][0], 0.30),
      THREE.MathUtils.lerp(sec[RAIL.chine][1], sec[RAIL.flank0][1], 0.30),
    ];
    band[0] = [
      THREE.MathUtils.lerp(sec[RAIL.chine][0], sec[RAIL.bilge1][0], 0.45),
      THREE.MathUtils.lerp(sec[RAIL.chine][1], sec[RAIL.bilge1][1], 0.45),
    ];
    return { z, pts: offsetPts(band, cy, 0.02) };
  });
  const star = sweep(stations, { creaseRails: [], closed: false, tile: 1.4 });
  return join(star, place(star, 0, 0, 0, true));
}

/** A band round each pod, where a real one has its accessory case. */
function podBands() {
  const parts = [];
  for (const z of [-5.55, -4.05]) {
    const stations = [z - 0.10, z + 0.10].map((zz) => ({
      z: zz, pts: offsetPts(podSection(POD.hw, POD.hh, POD.cy), POD.cy, 0.03),
    }));
    const ring = sweep(stations, { creaseRails: [], tile: 1.0 });
    parts.push(place(ring, POD.cx, 0, 0), place(ring, -POD.cx, 0, 0, true));
  }
  return join(...parts);
}

/**
 * The lights, authored WITH the hull rather than placed against it.
 *
 * Every one of these sits on a surface this script owns and nothing else can
 * measure: a nav light bolted at a hard-coded local x would float the day the
 * flank's bow changes by a centimetre. Bar geometry, on the skin, in the same
 * file as the skin.
 */
function lamps() {
  const out = [];
  const slab = (w, h, d, x, y, z) => {
    const p = { pos: [], nrm: [], uv: [], idx: [] };
    const g = new THREE.BoxGeometry(w, h, d).translate(x, y, z);
    const nonIdx = g.toNonIndexed();
    const P = nonIdx.attributes.position.array, N = nonIdx.attributes.normal.array;
    for (let i = 0; i < P.length; i += 3) {
      p.pos.push(P[i], P[i + 1], P[i + 2]);
      p.nrm.push(N[i], N[i + 1], N[i + 2]);
      p.uv.push(P[i] / 1.2, P[i + 1] / 1.2);
    }
    for (let i = 0; i < p.pos.length / 3; i++) p.idx.push(i);
    g.dispose(); nonIdx.dispose();
    out.push(p);
  };
  // Nose light, in the chisel.
  slab(0.20, 0.07, 0.18, 0, 1.52, 7.62);
  // Wingtip navigation lights, on the pods' outboard shoulders.
  for (const s of [-1, 1]) {
    slab(0.10, 0.07, 0.36, s * (PLAN.nacelle.x1 - 0.06), 1.34, -3.30);
    // The burner ring, just inside each nozzle's throat.
    const ring = sweep([
      { z: POD.z0 + 0.42, pts: podSection(POD.hw * 0.66, POD.hh * 0.66, POD.cy, 3.0, 2.6, 16) },
      { z: POD.z0 + 0.62, pts: podSection(POD.hw * 0.60, POD.hh * 0.60, POD.cy, 3.0, 2.6, 16) },
    ], { creaseRails: [], flip: true, tile: 1.0 });
    out.push(place(ring, s * POD.cx, 0, 0, s < 0));
  }
  // The strip along the dorsal's crown, which is what reads at 200 m.
  slab(0.09, 0.06, 2.60, 0, 5.03, -1.90);
  out.push(canopySill());
  return join(...out);
}

/* ═══════════════════════════════════════════════════════════════════════════ */
/*  THE BASTION — 44 m FRIGATE HULK, berth B4                                  */
/* ═══════════════════════════════════════════════════════════════════════════ */

/**
 * A DEAD WARSHIP, AND WHY SHE IS THE HARDEST OF THE FOUR TO BUILD OUT OF BOXES.
 *
 * The Bastion is not a ship the player flies. She is the yard's scale-setter:
 * 44 m of stripped frigate on the pad, plating off in two bays, her bow cap
 * never fitted, a whole stern section standing on the shed floor aft of her
 * cradle and her engine bell on a stand beside it. Her job is to make the
 * other three feel small and to say that this is a place where ships are
 * broken and rebuilt.
 *
 * The procedural arm builds her out of `cbox`, and a wreck is exactly where
 * that primitive fails worst. A box hull that is INTACT can at least be
 * argued about; a box hull with holes cut in it says "a rectangular prism with
 * rectangular holes", and the frames standing in those holes were four `cbox`
 * stanchions apiece — goalposts, not ribs. The thing that reads as a gutted
 * ship is the FRAME: a rib bent to the shape of a section, so that looking
 * through the hole you see the boat that used to be there.
 *
 * So everything below is generated from ONE section rule and six longitudinal
 * curves, exactly as the Kestrel is, and the frames are that same section
 * offset inboard and given depth. Nothing here is a box:
 *
 *   - **The plated body** is a single swept skin from the cut at z -18 to the
 *     open bow at z 12: a flat of keel, a Bézier turn of the bilge, a flared
 *     flank and a knuckle at the deck edge, with the two stripped bays cut out
 *     of it on grid lines.
 *   - **The frames** — in the bays, through the open bow and in the stern
 *     section — are closed rings: the hull's own section offset inboard, given
 *     a web, and swept along the ship. They curve because the hull curves;
 *     that is the whole point of generating them from the same function.
 *   - **The open bow carries the fairing on.** The same six curves run past
 *     z 12 out to z 22, so the frames forward of the plating are the sections
 *     the shell WOULD have been fitted over — narrowing, rising, and cut off
 *     square where the stem was never built.
 *   - **The peeled plates** are ruled surfaces: a plate 1.55 m long held along
 *     the top edge of a bay and integrated along its own curling tangent, so
 *     it rolls up and outboard — torn free in the middle of the run and still
 *     fastened at both ends of it.
 *   - **The engine bell is lathed**, with twenty cooling-tube lobes round it
 *     and an inner surface drawn `dark`, so it is a throat you can see up
 *     rather than a cone.
 *   - **The conning tower** is a loft that rakes fore and aft as it rises.
 *
 * ── The numbers that are not mine to choose ─────────────────────────────────
 * Duplicated from `HullPlan.BASTION` deliberately — this script runs under
 * plain Node with no import of the game's source — and every one of them is
 * asserted against the live plan by `scripts/tests/bastion-asset.test.mjs`.
 *
 *   lower       y 0.80..4.00  hw 8.00  z -18..12    climb band 0 grips x 8.00
 *   ledge       y 4.00  outer 8.00                   walkable slab, DECK_T 0.16
 *   upper       y 4.00..7.20  hw 6.20  z -16..10    climb band 1 grips x 6.20
 *   spine       y 7.34  hw 6.20                      walkable slab
 *   stripped    z -15.5..-8.6 and 2.4..9.0, y 1.35..3.30
 *   openBow     z 12..22, hw 7.4 -> 2.8, y 0.8..4.0
 *   sternRibs   z -35..-24, hw 7.6, y -2.2..5.4
 *   bell        lx -11.5, lz -13, r 1.5..3.2, y0 -2.2
 *   tower       z -14.6..-11.2, hw 3.6, y 7.34..11.2
 *   barbette    r 2.6, h 1.15, z -9.5 and 2.5   — left procedural: it is a drum
 */
export const BASTION_PLAN = {
  z0: -18, z1: 12,
  /** The skin stops on the ledge slab's UNDERSIDE, not on its top. See BAS_DHW. */
  deckY: 4.00 - 0.16,
  lowerHW: 8.00,
  upperY0: 4.00, upperY1: 7.34 - 0.16,
  upperHW: 6.20,
  bays: [
    { z0: -15.5, z1: -8.6, y0: 1.35, y1: 3.30 },
    { z0: 2.4, z1: 9.0, y0: 1.35, y1: 3.30 },
  ],
  stern: { z0: -35, z1: -24, hw: 7.6, y0: -2.2, y1: 5.4 },
  bell: { lx: -11.5, lz: -13, y0: -2.2, throatY: 3.90, mouthY: 0.50, rMouth: 3.20 },
  tower: { z0: -14.6, z1: -11.2, hw: 3.6, y0: 7.34, y1: 11.2 },
};

/**
 * Half-beam at the DECK EDGE, and it is held on 8.00 for 24 of the 30 m of
 * plated body ON PURPOSE.
 *
 * `deckSlab(b, 'hull', 4.00, 8.00, -18, 12)` is drawn on BOTH arms — it is the
 * walkable ledge and rule 2 says a walkable plate is a plate — and it is a
 * rectangle 16 m across. A skin that tapered its deck line would leave that
 * rectangle overhanging its own hull by whatever it tapered, with the slab's
 * underside in view from the apron for the whole length. So the plan taper is
 * spent BELOW the knuckle instead, in {@link BAS_FX} and {@link BAS_YK}: the
 * ends flare, which is what a real forebody and a real counter do, and the
 * deck edge stays where the slab is.
 *
 * The table runs past z 12 out to z 22 because the open bow's frames are
 * sections of the SAME hull — the one that was never plated — and a second
 * table for them would be a second description of one object.
 */
const BAS_DHW = curve([
  [-18, 7.55], [-16.8, 7.94], [-15.0, 8.00], [9.0, 8.00], [10.8, 7.90],
  [12, 7.50], [14, 6.80], [16.5, 5.70], [19, 4.45], [22, 2.95],
]);

/**
 * Half-beam at the CHINE — the foot of the flank, and the sill of both bays.
 *
 * 8.00 from z -12 to 6, and that is not laziness either: `BASTION.bands[0]`
 * grips local x 8.00 at z -6.0 from the cradle top to the ledge, and `plated`
 * collides that flank at exactly 8.00. Pinching the waist would hand the
 * player a collider 20 cm outboard of the plating they can see.
 */
const BAS_FX = curve([
  [-18, 6.90], [-16.6, 7.56], [-14.8, 7.90], [-12, 8.00], [6, 8.00],
  [8.6, 7.90], [10.6, 7.40], [12, 6.85], [14, 6.10], [16.5, 5.00],
  [19, 3.85], [22, 2.40],
]);

/**
 * The chine's own height, and it is FLAT ON 1.35 ACROSS BOTH BAYS.
 *
 * `BASTION.stripped` cuts its holes at y 1.35..3.30 and a hole in a swept
 * surface can only be cut on grid lines, so rail 4 has to land on 1.35 for the
 * whole of z -15.5..-8.6 and of z 2.4..9.0. Everywhere else the chine is free,
 * and it rises into both ends — the line that stops a 30 m flank reading as
 * one plane.
 */
const BAS_YC = curve([
  [-18, 1.90], [-16.6, 1.62], [-15.5, 1.35], [-8.6, 1.35], [-5, 1.30],
  [0, 1.30], [2.4, 1.35], [9.0, 1.35], [10.6, 1.66], [12, 2.10],
  [14, 2.34], [17, 2.66], [19.5, 2.90], [22, 3.10],
]);

/** The keel line: flat on 0.50 amidships — `belly.y0` — and lifting into both ends. */
const BAS_YK = curve([
  [-18, 1.35], [-16.8, 1.05], [-15.2, 0.76], [-13.4, 0.58], [-11, 0.50],
  [6, 0.50], [7.8, 0.58], [9.2, 0.80], [10.6, 1.14], [12, 1.60],
  [14, 1.86], [17, 2.16], [19.5, 2.44], [22, 2.70],
]);

/** Half-width of the flat of the keel. `keel()`'s own is `belly.hw * 0.42` = 3.02. */
const BAS_KW = curve([
  [-18, 0.55], [-16, 1.25], [-13, 2.40], [-10, 3.00], [4, 3.00],
  [7, 2.60], [9.6, 1.70], [11, 0.95], [12, 0.55], [15, 0.42],
  [19, 0.34], [22, 0.30],
]);

/**
 * How FULL the turn of the bilge is, as a fraction of the chine's half-beam:
 * it is the x of the quadratic Bézier's control point. 0.86 amidships is a
 * warship's hard bilge; 0.34 at the ends is a fine run.
 */
const BAS_BILGE = curve([
  [-18, 0.44], [-14, 0.72], [-8, 0.86], [4, 0.86], [9, 0.68],
  [12, 0.48], [16, 0.40], [22, 0.34],
]);

/**
 * Rails of a Bastion section, keel to deck edge. Named, because the bays are
 * cut BY RAIL INDEX and an off-by-one there is a hole in the wrong place.
 */
const BRAIL = Object.freeze({
  keelCentre: 0, keelEdge: 1, bilge0: 2, bilge1: 3,
  chine: 4,      // CREASE, and the sill of both stripped bays
  f0: 5, f1: 6,
  bayTop: 7,     // the head of both stripped bays
  f3: 8,
  deckEdge: 9,   // CREASE, on the ledge slab's underside
});
const BAS_HALF = 10;

/**
 * Where rails 4..9 sit up the flank, as a fraction of chine-to-deck-edge.
 *
 * 0.7831 is `(3.30 - 1.35) / (3.84 - 1.35)` and it is the only reason the bay
 * is 1.95 m tall rather than "about two metres": over a bay the chine is flat
 * on 1.35 and the deck edge is flat on 3.84, so rail 7 lands exactly on the
 * 3.30 the plan declares and the hole is the hole the plan asked for.
 */
const BAS_T = [0, 0.26, 0.52, 0.7831, 0.90, 1.0];

/** One Bastion section: port deck edge, round the keel, to starboard deck edge. */
function basSection(z) {
  const yk = BAS_YK(z), yc = BAS_YC(z);
  const kw = BAS_KW(z), fx = BAS_FX(z), dh = BAS_DHW(z);
  const bx = Math.max(kw, fx * BAS_BILGE(z));
  /* Quadratic Bézier from the edge of the flat of the keel to the chine, with
   * its control point out at `bx` on the keel's own height: one expression for
   * a turn of the bilge that is hard amidships and slack at the ends. */
  const bez = (t) => [
    (1 - t) * (1 - t) * kw + 2 * t * (1 - t) * bx + t * t * fx,
    (1 - t) * (1 - t) * yk + 2 * t * (1 - t) * yk + t * t * yc,
  ];
  const half = new Array(BAS_HALF);
  half[BRAIL.keelCentre] = [0, yk];
  half[BRAIL.keelEdge] = [kw, yk];
  half[BRAIL.bilge0] = bez(0.38);
  half[BRAIL.bilge1] = bez(0.74);
  for (let i = 0; i < 6; i++) {
    const t = BAS_T[i];
    half[BRAIL.chine + i] = [fx + (dh - fx) * Math.pow(t, 1.35), yc + (BASTION_PLAN.deckY - yc) * t];
  }
  return basOpenRing(half);
}

/**
 * A half-section mirrored into an OPEN ring: port deck edge, down the port
 * side, across the keel, up the starboard side, starboard deck edge.
 *
 * Open rather than closed because the top of this hull IS the ledge slab, and
 * a ring that closed across it would be a second deck 16 cm under the first —
 * two coplanar surfaces, which is z-fighting with extra steps.
 *
 * The order is the outward one: `sweep` takes each quad's normal as the
 * section tangent turned clockwise, so a ring that runs UP the starboard side
 * faces out of the hull and a ring that runs down it renders as nothing at all.
 */
function basOpenRing(half) {
  const ring = [];
  for (let i = half.length - 1; i >= 1; i--) ring.push([-half[i][0], half[i][1]]);
  ring.push([half[0][0], half[0][1]]);
  for (let i = 1; i < half.length; i++) ring.push([half[i][0], half[i][1]]);
  return ring;
}
/** Ring index of a starboard rail, and of its port mirror. */
const bStar = (r) => BAS_HALF - 1 + r;
const bPort = (r) => BAS_HALF - 1 - r;
/** Centre height of a section, for {@link offsetPts}. */
const basCentre = (z) => (BAS_YK(z) + BASTION_PLAN.deckY) / 2;

/** Stations of the plated body. Both bays' edges are stations — they must be. */
const BAS_Z = [
  -18, -17.4, -16.6, -15.5, -14.3, -13.1, -11.9, -10.7, -9.6, -8.6,
  -7.5, -6.3, -5.1, -3.9, -2.7, -1.5, -0.3, 1.0, 2.4, 3.6,
  4.8, 6.0, 7.2, 8.2, 9.0, 9.9, 10.8, 12,
];

/** Is this station inside a stripped bay? */
const basInBay = (z) => BASTION_PLAN.bays.some((c) => z >= c.z0 - 1e-6 && z < c.z1 - 1e-6);

/**
 * The plated body: one swept skin with two rectangular bays taken out of it.
 *
 * Capped at both ends, and both caps are structural statements rather than
 * tidying: forward, z 12 is where the bow cap was never fitted and the frames
 * carry on into open space; aft, z -18 is where the stern section was cut off
 * and is still standing on the shed floor twelve metres behind her.
 */
function basBody() {
  const stations = BAS_Z.map((z) => ({ z, pts: basSection(z) }));
  /* Quads are addressed by their LOW station and LOW rail. Starboard rails
   * 4, 5 and 6 are the three bands between the chine and the head of the bay;
   * on the port side the ring runs the other way, so the same three bands are
   * indexed from the mirror of the bay's head down to the mirror of the chine. */
  const cut = new Set([
    bStar(BRAIL.chine), bStar(BRAIL.f0), bStar(BRAIL.f1),
    bPort(BRAIL.bayTop), bPort(BRAIL.f1), bPort(BRAIL.f0),
  ]);
  const skip = (s, r) => basInBay(stations[s].z) && cut.has(r);
  return sweep(stations, {
    closed: false,
    creaseRails: [bStar(BRAIL.chine), bPort(BRAIL.chine),
      bStar(BRAIL.keelEdge), bPort(BRAIL.keelEdge)],
    skip,
    capFore: true,
    capAft: true,
    tile: 3.0,
  });
}

/* ------------------------------------------------------------------ */
/* The stripped bays: an inner skin, frames, a returned edge, a peel   */
/* ------------------------------------------------------------------ */

/** Rails of a bay opening, starboard, sill to head. */
const BAS_BAY_RAILS = [BRAIL.chine, BRAIL.f0, BRAIL.f1, BRAIL.bayTop];

/** Starboard section points at a bay's rails, offset `out` off the surface. */
function basBayBand(z, out) {
  const sec = basSection(z);
  return offsetPts(BAS_BAY_RAILS.map((r) => sec[bStar(r)]), basCentre(z), out);
}

/**
 * The inner skin behind a bay, 0.62 m in.
 *
 * A hole with nothing drawn inside it is a hole onto back-face-culled plating,
 * which from the apron is a matt black rectangle in the silhouette — the
 * procedural arm records exactly that failure. And it stands 0.62 m back and
 * not 0.30 for the reason recorded there too: `dock-hulls` counts drawn
 * vertices inside the slab the plating occupies and calls any of them in a bay
 * a hole that has been painted back in.
 */
function basBayInner(c) {
  const zs = [];
  for (let i = 0; i <= 10; i++) zs.push(THREE.MathUtils.lerp(c.z0 - 0.02, c.z1 + 0.02, i / 10));
  return sweep(zs.map((z) => ({ z, pts: basBayBand(z, -0.62) })),
    { closed: false, creaseRails: [], tile: 2.0 });
}

/**
 * The returned edge of the opening: the plating turned 0.22 m inboard all the
 * way round, so a bay has a jamb rather than a paper edge you can see the far
 * side of. `SKIN` is 0.22 and this is the same plate.
 */
function basBayReturn(c) {
  const out = { pos: [], nrm: [], uv: [], idx: [] };
  const e1 = new THREE.Vector3(), e2 = new THREE.Vector3(), fn = new THREE.Vector3();
  const face = (p, q, r, s) => {
    e1.set(q[0] - p[0], q[1] - p[1], q[2] - p[2]);
    e2.set(r[0] - p[0], r[1] - p[1], r[2] - p[2]);
    fn.crossVectors(e1, e2);
    if (fn.lengthSq() < 1e-12) return;
    fn.normalize();
    const b = out.pos.length / 3;
    for (const v of [p, q, r, s]) {
      out.pos.push(v[0], v[1], v[2]);
      out.nrm.push(fn.x, fn.y, fn.z);
      out.uv.push(v[2] / 1.6, v[1] / 1.6);
    }
    out.idx.push(b, b + 1, b + 2, b, b + 2, b + 3);
  };
  const n = 10;
  const zs = [];
  for (let i = 0; i <= n; i++) zs.push(THREE.MathUtils.lerp(c.z0, c.z1, i / n));
  const at = (z, k, o) => { const p = basBayBand(z, o)[k]; return [p[0], p[1], z]; };
  for (let i = 0; i < n; i++) {
    const a = zs[i], b2 = zs[i + 1];
    face(at(a, 0, -0.22), at(b2, 0, -0.22), at(b2, 0, 0), at(a, 0, 0));   // the sill
    face(at(a, 3, 0), at(b2, 3, 0), at(b2, 3, -0.22), at(a, 3, -0.22));   // the head
  }
  for (const [z, sgn] of [[c.z0, -1], [c.z1, 1]]) {
    for (let k = 0; k < 3; k++) {
      const p0 = at(z, k, 0), p1 = at(z, k + 1, 0);
      const q0 = at(z, k, -0.22), q1 = at(z, k + 1, -0.22);
      if (sgn < 0) face(p0, p1, q1, q0); else face(q0, q1, p1, p0);
    }
  }
  return out;
}

/**
 * A RIB: one contour, offset into a web, extruded along the ship.
 *
 * ── Why this is not `sweep` with `capFore` ──────────────────────────────────
 * It was, and the frames came out SOLID. `sweep`'s cap closes a section with a
 * triangle fan on the section's own centroid, which is exactly right for a
 * transom or a nose tip and exactly wrong for a rib: a rib's section is an
 * ANNULUS — an outer contour and an inner one — and its centroid sits in the
 * hole, so the fan paints the hole in. Measured on the three-quarter framing,
 * the stern section rasterised as a filled 11 x 6 m rectangle: every frame in
 * this hull was a plate. The whole subject of a wreck is what you can see
 * BETWEEN the frames, and the caps had filled all of it.
 *
 * So a rib is built by hand out of four strips: the outer wall, the inner
 * wall, and an annular face at each end. Every quad takes its normal from its
 * own winding, so the outer wall faces out of the hull, the inner wall faces
 * into the frame's own hollow, and the two end faces look fore and aft.
 *
 * @param {[number,number][]} outer the contour, in the outward order
 * @param {[number,number][]} inner the same contour, offset into the web
 */
function basRib(outer, inner, z0, z1, tile = 1.2) {
  const P = { pos: [], nrm: [], uv: [], idx: [] };
  const e1 = new THREE.Vector3(), e2 = new THREE.Vector3(), fn = new THREE.Vector3();
  const quad = (a, b, c, d) => {
    e1.set(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
    e2.set(c[0] - a[0], c[1] - a[1], c[2] - a[2]);
    fn.crossVectors(e1, e2);
    if (fn.lengthSq() < 1e-12) return;
    fn.normalize();
    const base = P.pos.length / 3;
    for (const v of [a, b, c, d]) {
      P.pos.push(v[0], v[1], v[2]);
      P.nrm.push(fn.x, fn.y, fn.z);
      P.uv.push((v[0] + v[2]) / tile, v[1] / tile);
    }
    P.idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
  };
  const n = Math.min(outer.length, inner.length);
  const O0 = [], O1 = [], I0 = [], I1 = [];
  for (let i = 0; i < n; i++) {
    O0.push([outer[i][0], outer[i][1], z0]); O1.push([outer[i][0], outer[i][1], z1]);
    I0.push([inner[i][0], inner[i][1], z0]); I1.push([inner[i][0], inner[i][1], z1]);
  }
  for (let i = 0; i < n - 1; i++) {
    quad(O0[i], O0[i + 1], O1[i + 1], O1[i]);
    quad(I1[i], I1[i + 1], I0[i + 1], I0[i]);
    quad(O1[i], O1[i + 1], I1[i + 1], I1[i]);
    quad(I0[i], I0[i + 1], O0[i + 1], O0[i]);
  }
  /* The two cut ends of the rib — the heel of a leg, the edge of a floor. */
  quad(O0[0], O1[0], I1[0], I0[0]);
  quad(I0[n - 1], I1[n - 1], O1[n - 1], O0[n - 1]);
  return P;
}

/**
 * A frame standing in a bay: the hull's own section, offset 0.50 m inboard,
 * given a 0.36 m web and extruded 0.30 m along the ship.
 *
 * This is the whole difference between a rib and a goalpost, and it costs
 * nothing: the contour is already computed, it only has to be offset. 0.50 m
 * inboard rather than 0.30 is the measurement the procedural arm records — a
 * frame 0.34 m thick set 0.30 in reaches back into the plating slab, and the
 * bay then measures as full from outside.
 */
function basBayFrames(c) {
  const parts = [];
  const n = Math.max(3, Math.round((c.z1 - c.z0) / 2.3));
  for (let i = 0; i <= n; i++) {
    const z = c.z0 + ((c.z1 - c.z0) * i) / n;
    parts.push(basRib(basBayBand(z, -0.50), basBayBand(z, -0.86), z - 0.15, z + 0.15));
  }
  /* Two stringers running the length of the bay on the frames' inboard face,
   * generated from the section so they follow the flank's own curve instead of
   * lying along a straight line eight metres from the centreline. */
  const zs = [];
  for (let i = 0; i <= 8; i++) zs.push(THREE.MathUtils.lerp(c.z0, c.z1, i / 8));
  for (const k of [1, 2]) {
    const bar = (z) => {
      const p = basBayBand(z, -0.90)[k];
      const q = basBayBand(z, -1.12)[k];
      const dx = q[0] - p[0], dy = q[1] - p[1];
      const d = Math.hypot(dx, dy) || 1;
      const nx = (-dy / d) * 0.11, ny = (dx / d) * 0.11;
      return [
        [p[0] + nx, p[1] + ny], [q[0] + nx, q[1] + ny],
        [q[0] - nx, q[1] - ny], [p[0] - nx, p[1] - ny],
      ];
    };
    parts.push(sweep(zs.map((z) => ({ z, pts: bar(z) })),
      { creaseRails: [], capFore: true, capAft: true, tile: 1.0 }));
  }
  return join(...parts);
}

/**
 * A PEELED PLATE, and it is a ruled surface rather than a rotated slab.
 *
 * The plate was the plating over the bay. It is still held along the TOP edge
 * and has rolled up and outboard, so it is integrated along its own tangent:
 * the direction starts straight up the flank and turns outboard at a constant
 * rate, which closes to `up = sin(as)/a` and `out = (1 - cos(as))/a`. It is an
 * arc of a circle whose radius is the reciprocal of how far this station tore.
 *
 * It curls UP and not DOWN, which the procedural arm learned the hard way: a
 * plate peeled downward hangs across the opening, and was measured filling in
 * 0.6 m of the 1.2 m of depth the bay's whole silhouette depends on.
 *
 * `t` runs 0.12 at the ends of the tear to 1.0 in the middle, so the plate is
 * still fastened at both ends of the run and standing right off in the middle.
 * That is what a plate somebody cut free and levered looks like; a flap with a
 * constant curl looks like a moulding.
 */
function basPeel(c, z0, z1) {
  const L = 1.15, K = 1.15, TH = 0.06;
  const n = 9, m = 7;
  const stations = [];
  for (let i = 0; i <= n; i++) {
    const u = i / n;
    const z = THREE.MathUtils.lerp(z0, z1, u);
    const t = 0.12 + 0.88 * Math.pow(Math.sin(Math.PI * u), 0.7);
    const sec = basSection(z);
    const p0 = sec[bStar(BRAIL.bayTop)];
    const dx = p0[0], dy = p0[1] - basCentre(z);
    const d = Math.hypot(dx, dy) || 1;
    const ox = dx / d, oy = dy / d;
    const a = Math.max(0.05, t * K);
    const face = [], back = [];
    for (let k = 0; k <= m; k++) {
      const s = (k / m) * L;
      const phi = a * s;
      const ux = ox * (1 - Math.cos(phi)) / a, uy = Math.sin(phi) / a;
      face.push([p0[0] + ox * 0.04 + ux, p0[1] + oy * 0.04 + uy]);
    }
    for (let k = m; k >= 0; k--) {
      const s = (k / m) * L;
      const phi = a * s;
      const nx = ox * Math.cos(phi), ny = Math.sin(phi);
      const ux = ox * (1 - Math.cos(phi)) / a, uy = Math.sin(phi) / a;
      back.push([p0[0] + ox * 0.04 + ux - nx * TH, p0[1] + oy * 0.04 + uy - ny * TH]);
    }
    stations.push({ z, pts: [...face, ...back] });
  }
  /* No caps.  closes a section with a fan on its centroid, and a plate
   * curled through 200 degrees has its centroid in fresh air outside itself -
   * the fan would fill the whole curl in. The two ends are 5.5 cm of plate
   * edge seen end-on at the ends of the tear, which is what a torn plate is. */
  return sweep(stations, { creaseRails: [], tile: 1.4 });
}

/* ------------------------------------------------------------------ */
/* The open bow: frames only, and they are the sections never plated   */
/* ------------------------------------------------------------------ */

/**
 * The open bow.
 *
 * `BASTION.openBow` runs z 12..22 and tapers, and the procedural arm builds it
 * from two stanchions, two knees and a head beam per station — a goalpost,
 * repeated six times. What a hull waiting on a plating gang actually looks
 * like is FRAMES: the sections the shell would have been fitted over, standing
 * in the air with daylight between them and stringers running through them.
 *
 * They cost nothing extra to be right, because {@link BAS_DHW} and its five
 * companions already run out to z 22: these are literally the same hull, at
 * the stations where nobody ever welded a plate on.
 *
 * Cut off square at z 22 rather than closed into a stem, because the plan's
 * own frames stop there at half-beam 2.8 and a stem drawn past them would be
 * five metres of ship with nothing collided under it.
 */
function basBowFrames() {
  const parts = [];
  const N = 6;
  for (let i = 0; i <= N; i++) {
    const z = THREE.MathUtils.lerp(12.4, 21.6, i / N);
    const sec = basSection(z);
    const cy = basCentre(z);
    /* A full ring this time — port side, keel, starboard side — because the
     * frame forward of the plating is the WHOLE section, and the thing that
     * says "ship" about it is that it closes under the keel. */
    parts.push(basRib(offsetPts(sec, cy, -0.04), offsetPts(sec, cy, -0.38), z - 0.17, z + 0.17));
  }
  /* Longitudinal stringers through every frame, at five heights up the
   * section, plus the keelson on the centreline. Generated from the same
   * rails, so they bend with the hull instead of running straight. */
  const zs = [];
  for (let i = 0; i <= 12; i++) zs.push(THREE.MathUtils.lerp(12.0, 21.9, i / 12));
  for (const r of [BRAIL.keelCentre, BRAIL.bilge1, BRAIL.chine, BRAIL.f1, BRAIL.deckEdge]) {
    for (const side of [1, -1]) {
      if (r === BRAIL.keelCentre && side < 0) continue;
      const bar = (z) => {
        const sec = basSection(z);
        const p = offsetPts([sec[side > 0 ? bStar(r) : bPort(r)]], basCentre(z), -0.26)[0];
        const h = 0.155;
        return [[p[0] - h, p[1] - h], [p[0] + h, p[1] - h], [p[0] + h, p[1] + h], [p[0] - h, p[1] + h]];
      };
      parts.push(sweep(zs.map((z) => ({ z, pts: bar(z) })),
        { creaseRails: [], capFore: true, capAft: true, tile: 1.0 }));
    }
  }
  return join(...parts);
}

/**
 * What plating is LEFT on the open bow: a run along each bilge, and one panel
 * on the starboard flank, still hung on the frames.
 *
 * A bow with no plating at all reads as a ship that was never started. A bow
 * with two plates still on it reads as a ship somebody is halfway through
 * taking apart, which is what she is.
 */
function basBowPlating() {
  const band = (rails, za, zb, n) => {
    const zs = [];
    for (let i = 0; i <= n; i++) zs.push(THREE.MathUtils.lerp(za, zb, i / n));
    return sweep(zs.map((z) => {
      const sec = basSection(z);
      return { z, pts: offsetPts(rails.map((r) => sec[bStar(r)]), basCentre(z), 0) };
    }), { closed: false, creaseRails: [], tile: 2.4 });
  };
  const bilge = band([BRAIL.bilge0, BRAIL.bilge1, BRAIL.chine], 12.0, 14.8, 6);
  return join(bilge, place(bilge, 0, 0, 0, true));
}

/* ------------------------------------------------------------------ */
/* The stern section, standing on the shed floor                       */
/* ------------------------------------------------------------------ */

/** Half-beam of the stern section: it narrows aft, because it is a stern. */
const BAS_SHW = curve([[-35, 5.10], [-32.5, 6.35], [-30, 7.10], [-27, 7.50], [-24, 7.60]]);
/** How far in the foot of a stern frame is tucked, as a fraction of the beam. */
const BAS_STURN = curve([[-35, 0.79], [-32.5, 0.84], [-30, 0.88], [-27, 0.91], [-24, 0.93]]);

/**
 * One frame of the stern section: a U, open at the bottom, standing on the
 * shed floor.
 *
 * Open at the bottom AND NOT A CLOSED RING, unlike the open bow's, and the
 * reason is that a player walks THROUGH this one. `sternRibs.y0` is -2.2
 * local, which is the shed floor: a frame closed under the keel would put a
 * metre and a half of drawn arch across a doorway a body walks through, and
 * the plan collides two posts and a head beam per frame and nothing at all
 * across the bottom. So the legs stand where the posts are and the space
 * between them is empty in the picture and in the physics alike.
 */
function basSternFrame(z, beam) {
  const S = BASTION_PLAN.stern;
  const hw = BAS_SHW(z), turn = BAS_STURN(z);
  const legTop = S.y1 - 1.5;
  const half = [];
  const n = 7;
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    half.push([hw * (turn + (1 - turn) * smooth(Math.min(1, t * 1.45))),
      THREE.MathUtils.lerp(S.y0, legTop, t)]);
  }
  /* Half the frames have had their deck beam cut out — which is what a gang
   * stripping a section does first, and which is also the only thing that
   * keeps a rib from reading solid at an angle. A transverse frame is PLANAR:
   * seen three-quarters on, its 15 m of beam projects to a band ten metres
   * wide, so five of them at 2.2 m centres overlap into one mass however thin
   * each is. Alternate the beams and the daylight comes back — measured, the
   * three-quarter view went from 1.06 lit runs per column to 1.31.
   *
   * The legs curve either way, which is the part that matters: a leg bent to
   * the turn of a stern is a rib, and a straight post is scaffolding. */
  if (beam) {
    const m = 5;
    for (let i = 1; i <= m; i++) {
      const a = (i / m) * (Math.PI / 2);
      half.push([hw * Math.cos(a), legTop + 0.62 * Math.sin(a)]);
    }
  }
  /* Starboard foot, up the leg, over the crown, down the port leg to its foot:
   * the outward order, so the outside of the frame faces out. */
  const contour = [...half];
  for (let i = half.length - 2; i >= 0; i--) contour.push([-half[i][0], half[i][1]]);
  const cy = (S.y0 + S.y1) / 2;
  return basRib(offsetPts(contour, cy, 0), offsetPts(contour, cy, -0.38), z - 0.17, z + 0.17);
}

/** The stern section: six frames, stringers through them, and a sternpost. */
function basStern() {
  const S = BASTION_PLAN.stern;
  const parts = [];
  const N = 5;
  for (let i = 0; i <= N; i++) parts.push(basSternFrame(S.z0 + ((S.z1 - S.z0) * i) / N, i % 2 === 0));
  const run = [];
  for (let i = 0; i <= 10; i++) run.push(THREE.MathUtils.lerp(S.z0, S.z1, i / 10));
  for (const ty of [0.16, 0.42, 0.68, 0.94]) {
    for (const sgn of [1, -1]) {
      const bar = (z) => {
        const hw = BAS_SHW(z), turn = BAS_STURN(z);
        const y = THREE.MathUtils.lerp(S.y0, S.y1 - 1.5, ty);
        const x = sgn * (hw * (turn + (1 - turn) * smooth(Math.min(1, ty * 1.45))) - 0.36);
        const h = 0.155;
        return [[x - h, y - h], [x + h, y - h], [x + h, y + h], [x - h, y + h]];
      };
      parts.push(sweep(run.map((z) => ({ z, pts: bar(z) })),
        { creaseRails: [], capFore: true, capAft: true, tile: 1.0 }));
    }
  }
  /* The sternpost: the one heavy casting a stern section keeps, on the
   * centreline at the aft end, tapering as it rises. */
  const post = [];
  for (let i = 0; i <= 6; i++) {
    const t = i / 6;
    post.push({
      z: THREE.MathUtils.lerp(S.z0 - 0.5, S.z0 + 2.2, t),
      pts: (() => {
        const w = THREE.MathUtils.lerp(0.30, 0.54, t);
        const y1 = THREE.MathUtils.lerp(S.y0 + 1.5, S.y1 - 1.1, smooth(t));
        return [[-w, S.y0], [w, S.y0], [w, y1], [-w, y1]];
      })(),
    });
  }
  parts.push(sweep(post, { creaseRails: [], capFore: true, capAft: true, tile: 1.4 }));
  return join(...parts);
}

/* ------------------------------------------------------------------ */
/* The conning tower                                                   */
/* ------------------------------------------------------------------ */

const BAS_TWX = curve([
  [-14.6, 2.45], [-14.2, 3.15], [-13.6, 3.52], [-12.4, 3.60], [-11.75, 3.40],
  [-11.4, 2.95], [-11.2, 2.20],
]);
const BAS_TWY = curve([
  [-14.6, 9.85], [-14.2, 10.52], [-13.6, 10.98], [-12.4, 11.20], [-11.75, 11.08],
  [-11.4, 10.55], [-11.2, 9.60],
]);
const BAS_TWZ = [-14.6, -14.35, -14.0, -13.6, -13.1, -12.4, -11.9, -11.6, -11.38, -11.2];

/**
 * A tower section: flat sides would be a deckhouse, so the sides tumble home
 * and the crown rounds over. Open at the bottom — the spine deck is its floor
 * and is drawn on both arms.
 */
function basTowerSection(z) {
  const hw = BAS_TWX(z), top = BAS_TWY(z);
  const y0 = BASTION_PLAN.tower.y0;
  const h = Math.max(0.05, top - y0);
  const sh = Math.min(0.62, h * 0.22);
  const half = [
    [hw, y0],
    [hw, y0 + h * 0.30],
    [hw * 0.965, y0 + h * 0.62],
    [hw * 0.90, top - sh],
    [hw * 0.62, top - sh * 0.22],
    [hw * 0.30, top],
    [0, top],
  ];
  const ring = [];
  for (let i = half.length - 1; i >= 0; i--) ring.push([-half[i][0], half[i][1]]);
  for (let i = 1; i < half.length; i++) ring.push([half[i][0], half[i][1]]);
  return ring;
}

function basTower() {
  return sweep(BAS_TWZ.map((z) => ({ z, pts: basTowerSection(z) })),
    { closed: false, creaseRails: [], capFore: true, capAft: true, tile: 2.2 });
}

/** The bridge window band, and every one of them dark. Nothing is lit in here. */
function basTowerGlass() {
  const zs = [];
  for (let i = 0; i <= 8; i++) zs.push(THREE.MathUtils.lerp(-14.15, -11.45, i / 8));
  const band = (lo, hi, out) => sweep(zs.map((z) => {
    const ring = basTowerSection(z);
    const cy = (BASTION_PLAN.tower.y0 + BAS_TWY(z)) / 2;
    const half = ring.slice(6);                      // the starboard half
    const at = (r) => {
      const i = Math.max(0, Math.min(half.length - 2, Math.floor(r)));
      const t = Math.max(0, Math.min(1, r - i));
      return [THREE.MathUtils.lerp(half[i][0], half[i + 1][0], t),
        THREE.MathUtils.lerp(half[i][1], half[i + 1][1], t)];
    };
    const star = [];
    for (let k = 0; k <= 5; k++) star.push(at(THREE.MathUtils.lerp(lo, hi, k / 5)));
    const pushed = offsetPts(star, cy, out);
    const pts = [];
    for (let i = pushed.length - 1; i >= 0; i--) pts.push([-pushed[i][0], pushed[i][1]]);
    pts.push(...pushed);
    return { z, pts };
  }), { closed: false, creaseRails: [], tile: 1.6 });
  return { glass: band(2.05, 3.05, 0.045), sill: band(1.80, 3.30, 0.018) };
}

/* ------------------------------------------------------------------ */
/* The engine bell, on its stand beside the cradle                     */
/* ------------------------------------------------------------------ */

/** Turn a part built along +Z so that its +Z runs DOWN the hull's -Y. */
function basTurnDown(part) {
  const out = { pos: [], nrm: [], uv: part.uv.slice(), idx: part.idx.slice() };
  for (let i = 0; i < part.pos.length; i += 3) {
    out.pos.push(part.pos[i], -part.pos[i + 2], part.pos[i + 1]);
    out.nrm.push(part.nrm[i], -part.nrm[i + 2], part.nrm[i + 1]);
  }
  return out;
}

/**
 * A bell section: a circle with twenty shallow lobes on it.
 *
 * The lobes are the cooling tubes, and they are the single thing that makes a
 * flared surface read as an engine bell rather than as a megaphone. 1.8% of
 * the radius, which is 6 cm at the mouth: enough to catch a highlight down
 * every tube, not enough to read as a gear.
 */
function basBellSection(r, n = 44, lobes = 16, amp = 0.045) {
  const pts = [];
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2;
    const rr = r * (1 + amp * Math.cos(a * lobes));
    pts.push([Math.cos(a) * rr, Math.sin(a) * rr]);
  }
  return pts;
}

/**
 * The bell, lathed: a throat, a waist and a flare to the exit plane, with the
 * INSIDE drawn as well so it is a mouth you can see up rather than a cone.
 *
 * The procedural arm draws one `CylinderGeometry(1.5, 3.2, 3.4, 10)`. That is
 * a straight taper — the profile of a bell is not a straight line anywhere —
 * and a ten-sided one at 3.2 m radius carries two-metre facets.
 */
function basBell() {
  const B = BASTION_PLAN.bell;
  const R = curve([
    [0, 1.02], [0.20, 0.84], [0.42, 0.79], [0.75, 0.94], [1.20, 1.27],
    [1.75, 1.71], [2.35, 2.24], [2.90, 2.76], [3.40, B.rMouth],
  ]);
  const zs = [0, 0.12, 0.28, 0.50, 0.78, 1.10, 1.48, 1.90, 2.34, 2.76, 3.12, 3.40];
  const outer = sweep(zs.map((z) => ({ z, pts: basBellSection(R(z)) })),
    { creaseRails: [], tile: 1.8 });
  const inner = sweep(zs.map((z) => ({ z, pts: basBellSection(R(z) - 0.09, 44, 16, 0.012) })),
    { creaseRails: [], flip: true, capAft: true, tile: 1.8 });
  /* The injector head and the turbopump above the throat: the part that makes
   * it an engine rather than a horn. */
  const headR = curve([[-1.35, 0.42], [-1.15, 0.72], [-0.85, 0.86], [-0.45, 0.90],
    [-0.14, 1.00], [0, 1.02]]);
  const head = sweep([-1.35, -1.15, -0.85, -0.45, -0.14, 0].map((z) => ({
    z, pts: basBellSection(headR(z), 28, 12, 0.02),
  })), { creaseRails: [], capAft: true, tile: 1.4 });
  const rim = sweep([3.36, 3.46, 3.58].map((z) => ({
    z, pts: basBellSection(B.rMouth + (z > 3.5 ? 0.02 : 0.13), 44, 16, 0.055),
  })), { creaseRails: [], capFore: true, tile: 1.2 });
  /* One thing still lit on a dead ship: the chamber ring. `glow` and not
   * `danger`, for the draw-call reason the Dray's hopper lights record. */
  const glow = sweep([0.86, 1.04].map((z) => ({
    z, pts: basBellSection(R(z) - 0.11, 28, 1, 0),
  })), { creaseRails: [], flip: true, tile: 1.0 });

  const put = (p) => place(basTurnDown(p), B.lx, B.throatY, B.lz);
  return { shell: join(put(outer), put(head), put(rim)), dark: put(inner), glow: put(glow) };
}

/**
 * The stand the bell is chocked on: two curved cradle bearers on a plinth.
 * Swept, so a bearer's saddle is the bell's own radius and not a notch.
 */
function basBellStand() {
  const B = BASTION_PLAN.bell;
  const parts = [];
  for (const zoff of [-1.5, 1.5]) {
    const zs = [];
    for (let i = 0; i <= 3; i++) zs.push(B.lz + zoff - 0.17 + (0.34 * i) / 3);
    const arch = [];
    const n = 12;
    for (let i = 0; i <= n; i++) {
      const a = Math.PI * (0.05 + 0.90 * (i / n));
      arch.push([Math.cos(a) * 2.6, B.y0 + 1.50 + Math.sin(a) * 1.05]);
    }
    /* The arch runs right to left already; reversing it here once turned the
     * bearer into a bow-tie that crossed its own web. */
    const contour = [[2.62, B.y0 + 0.42], ...arch, [-2.62, B.y0 + 0.42]];
    const cy = B.y0 + 1.3;
    parts.push(basRib(offsetPts(contour, cy, 0), offsetPts(contour, cy, -0.36), zs[0], zs[zs.length - 1]));
  }
  const plinth = [];
  for (let i = 0; i <= 3; i++) {
    const z = B.lz - 2.4 + (4.8 * i) / 3;
    const w = 2.05 - 0.10 * Math.abs(i - 1.5);
    plinth.push({ z, pts: [[-w, B.y0], [w, B.y0], [w * 0.93, B.y0 + 0.45], [-w * 0.93, B.y0 + 0.45]] });
  }
  parts.push(sweep(plinth, { creaseRails: [], capFore: true, capAft: true, tile: 1.6 }));
  return place(join(...parts), B.lx, 0, 0);
}

/* ------------------------------------------------------------------ */
/* The upper body                                                      */
/* ------------------------------------------------------------------ */

/**
 * Half-beam of the upper body. 6.20 over the middle because `bands[1]` grips
 * exactly that at z -6.0 and `plated(b, H.upper)` collides it; the ends draw
 * in under the spine deck's own overhang, where nothing climbs.
 */
const BAS_UHW = curve([
  [-16, 5.60], [-15.0, 6.00], [-13.6, 6.20], [7.4, 6.20], [8.8, 6.05], [10, 5.60],
]);

/**
 * Half-beam of the upper body ABOVE the knuckle, and this is the curve that
 * stops her superstructure reading as a shipping container.
 *
 * The flank underneath it cannot move: `BASTION.bands[1]` grips 6.20 and
 * `plated(b, H.upper)` collides 6.20 from the ledge to the spine. But a body
 * standing on the ledge
 * deck at local y 4.00 has its head at 5.80, and NOTHING above that is
 * reachable from any deck on this ship - so the shape budget is spent up
 * there. The knuckle sits at 5.75 and the works draw in to 3.40 at the
 * forward end and 3.90 at the after one, which is a superstructure with a
 * rake on it rather than a box with a deck on top.
 */
const BAS_UTOP = curve([
  [-16, 3.90], [-14.2, 5.10], [-12, 5.80], [-6, 6.02], [2, 6.02],
  [5.5, 5.70], [8, 4.90], [10, 3.40],
]);
const BAS_UZ = [-16, -15.4, -14.6, -13.6, -12.2, -10.6, -8.8, -6.8, -4.6, -2.4,
  -0.2, 2.0, 4.0, 5.8, 7.4, 8.4, 9.3, 10];

function basUpperSection(z) {
  const hw = BAS_UHW(z), top = BAS_UTOP(z);
  const y0 = BASTION_PLAN.upperY0, y1 = BASTION_PLAN.upperY1;
  const half = [
    [hw, y0],
    [hw, y0 + 0.72],
    [hw, y0 + 1.44],
    [hw, 5.75],
    [THREE.MathUtils.lerp(hw, top, 0.62), 6.55],
    [top, y1],
    [top * 0.62, y1 + 0.08],
    [0, y1 + 0.08],
  ];
  const ring = [];
  for (let i = half.length - 1; i >= 0; i--) ring.push([-half[i][0], half[i][1]]);
  for (let i = 1; i < half.length; i++) ring.push([half[i][0], half[i][1]]);
  return ring;
}

function basUpper() {
  return sweep(BAS_UZ.map((z) => ({ z, pts: basUpperSection(z) })),
    { closed: false, creaseRails: [], capFore: true, capAft: true, tile: 2.6 });
}

/* ------------------------------------------------------------------ */
/* Dressing generated FROM the section, so that it cannot float        */
/* ------------------------------------------------------------------ */

/** The runs of the body between the bays. Same rule as `Hulls.intactRuns`. */
function basIntactRuns(z0, z1, cuts) {
  const out = [];
  let z = z0;
  for (const c of cuts) { out.push([z, c.z0]); z = c.z1; }
  out.push([z, z1]);
  return out.filter(([a, c]) => c - a > 0.02);
}

/**
 * The frame rings round the outside of the body, and the two string courses
 * along it.
 *
 * `course`, `bolts` and `rib` all pin a box to a flank at exactly `hw`, which
 * is what this skin is not: it flares from 6.90 to 8.00 over the last six
 * metres at each end, so a course pinned to 8.00 would float 1.1 m off its own
 * hull at the transom. These are the section itself, 0.03 m proud, and no
 * ring crosses a bay — a ring round a hull is exactly the shape of thing that
 * runs over an opening.
 */
function basStrakes() {
  const parts = [];
  for (const z of [-17.2, -7.6, -6.6, 0.5, 1.4, 10.4, 11.3]) {
    const stations = [z - 0.11, z + 0.11].map((zz) => ({
      z: zz, pts: offsetPts(basSection(zz), basCentre(zz), 0.03),
    }));
    parts.push(sweep(stations, {
      closed: false,
      creaseRails: [bStar(BRAIL.chine), bPort(BRAIL.chine)],
      tile: 1.2,
    }));
  }
  const bandAt = (mix) => (z) => {
    const sec = basSection(z);
    const a = sec[bStar(BRAIL.chine)], b2 = sec[bStar(BRAIL.deckEdge)];
    const at = (t) => [THREE.MathUtils.lerp(a[0], b2[0], t), THREE.MathUtils.lerp(a[1], b2[1], t)];
    return offsetPts([at(mix[0]), at(mix[1])], basCentre(z), 0.028);
  };
  for (const [ra, rb] of basIntactRuns(BASTION_PLAN.z0, BASTION_PLAN.z1, BASTION_PLAN.bays)) {
    if (rb - ra < 1.2) continue;
    const zs = [];
    const n = Math.max(3, Math.round((rb - ra) / 1.6));
    for (let i = 0; i <= n; i++) zs.push(THREE.MathUtils.lerp(ra + 0.1, rb - 0.1, i / n));
    for (const mix of [[-0.15, 0.16], [0.82, 1.02]]) {
      const f = bandAt(mix);
      const star = sweep(zs.map((z) => ({ z, pts: f(z) })),
        { closed: false, creaseRails: [], tile: 1.4 });
      parts.push(star, place(star, 0, 0, 0, true));
    }
  }
  /* And the same treatment on the upper body. */
  for (const z of [-14.0, -9.0, -3.0, 3.0, 8.4]) {
    const stations = [z - 0.10, z + 0.10].map((zz) => ({
      z: zz, pts: offsetPts(basUpperSection(zz), (BASTION_PLAN.upperY0 + BASTION_PLAN.upperY1) / 2, 0.03),
    }));
    parts.push(sweep(stations, { closed: false, creaseRails: [], tile: 1.2 }));
  }
  return join(...parts);
}

/**
 * An access panel taken off and left hanging, with the loom out of it.
 *
 * The recess and the leaf are both the hull's OWN section — the leaf is the
 * plate that came out of the hole, swung out about its forward edge — and the
 * loom is a bundle swept along the ship with its centre following a sag, which
 * is the one thing `sweep` does for free and a box kit cannot do at all.
 */
function basPanel(z, rLo, rHi) {
  const zs = [];
  for (let i = 0; i <= 4; i++) zs.push(z - 1.0 + (2.0 * i) / 4);
  const band = (out) => zs.map((zz) => {
    const sec = basSection(zz);
    const a = sec[bStar(rLo)], b2 = sec[bStar(rHi)];
    const pts = [];
    for (let k = 0; k <= 3; k++) {
      const t = k / 3;
      pts.push([THREE.MathUtils.lerp(a[0], b2[0], t), THREE.MathUtils.lerp(a[1], b2[1], t)]);
    }
    return { z: zz, pts: offsetPts(pts, basCentre(zz), out) };
  });
  const recess = sweep(band(-0.30), { closed: false, creaseRails: [], tile: 1.4 });

  const base = band(0.03);
  const swung = base.map((st, i) => {
    const swing = i / (base.length - 1);
    const cy = basCentre(st.z);
    return {
      z: st.z,
      pts: st.pts.map(([x, y]) => {
        const dx = x, dy = y - cy;
        const d = Math.hypot(dx, dy) || 1;
        return [x + (dx / d) * swing * 1.25, y + (dy / d) * swing * 0.28];
      }),
    };
  });
  const front = sweep(swung, { closed: false, creaseRails: [], tile: 1.4 });
  const backPts = swung.map((st) => ({ z: st.z, pts: st.pts.map(([x, y]) => [x - 0.07, y]) }));
  const back = sweep(backPts, { closed: false, creaseRails: [], tile: 1.4, flip: true });
  const leaf = join(front, back);

  const looms = [];
  const sec0 = basSection(z);
  const a0 = sec0[bStar(rLo)], b0 = sec0[bStar(rHi)];
  const mid = [THREE.MathUtils.lerp(a0[0], b0[0], 0.62), THREE.MathUtils.lerp(a0[1], b0[1], 0.62)];
  for (let k = 0; k < 3; k++) {
    const r = 0.075 + k * 0.022;
    const zs2 = [];
    for (let i = 9; i >= 0; i--) zs2.push(z - 0.4 - (3.1 * i) / 9);
    looms.push(sweep(zs2.map((zz) => {
      const u = (z - 0.4 - zz) / 3.1;
      const cx = mid[0] + 0.20 + 0.26 * Math.sin(u * 2.4) - k * 0.15;
      const cy2 = mid[1] - 1.55 * u * u - k * 0.13;
      const pts = [];
      for (let i = 0; i < 7; i++) {
        const ang = (i / 7) * Math.PI * 2;
        pts.push([cx + Math.cos(ang) * r, cy2 + Math.sin(ang) * r]);
      }
      return { z: zz, pts };
    }), { creaseRails: [], capFore: true, capAft: true, tile: 0.8 }));
  }
  return { recess, leaf, loom: join(...looms) };
}

/* ------------------------------------------------------------------ */
/* Assembly of the Bastion                                             */
/* ------------------------------------------------------------------ */

function bastionParts() {
  const hull = [basBody(), basUpper(), basTower(), basBowPlating()];
  const trim = [basStrakes(), basBowFrames(), basStern(), basBellStand()];
  const dark = [];
  const accent = [];
  const glow = [];

  for (const c of BASTION_PLAN.bays) {
    const inner = basBayInner(c);
    dark.push(inner, place(inner, 0, 0, 0, true));
    /* The returned edge is `trim`, not `hull`, and that is a legibility fix
     * with a measurement behind it: framed from the apron the bays did not
     * READ. The hole is cut, a ray fired at it stops 0.62 m in against 0.00 m
     * on plating either side — but a dark grey recess in a dark grey flank in
     * a shed lit from the roof is a hole nobody can see. `trim` is this hull's
     * rust orange (`SHIP_PALETTES.bastion.trim`), so the 0.22 m of turned
     * plate round each opening draws its outline. */
    const ret = basBayReturn(c);
    trim.push(ret, place(ret, 0, 0, 0, true));
    const fr = basBayFrames(c);
    trim.push(fr, place(fr, 0, 0, 0, true));
    const mid = (c.z0 + c.z1) / 2, half = (c.z1 - c.z0) * 0.44;
    const peel = basPeel(c, mid - half, mid + half);
    accent.push(peel, place(peel, 0, 0, 0, true));
  }

  /* Panels chosen to miss the bays: a door hanging off a hinge in a bay whose
   * plating was taken away entirely is a door with no wall. */
  /* Stations chosen to miss the bays AND the climb.
   *
   * The bays first, for the reason the procedural arm records: a door hanging
   * off a hinge in a bay whose plating was taken away entirely is a door with
   * no wall. And then the climb, which cost a test: a leaf swung out to local
   * x 8.90 at z -6.4 stood 0.90 m proud of the flank at exactly the station
   * 'BASTION.bands[0]' grips, and the ray fired down that band stopped on the
   * panel instead of on the hull. A player climbing that face would have gone
   * hand-over-hand into a hinged plate. Every leaf is now at least 3 m along
   * the hull from z -6.0, and every loom runs AFT of its own panel into clear
   * plating or into a bay. */
  for (const [z, lo, hi] of [
    [-0.4, BRAIL.f0, BRAIL.bayTop], [1.9, BRAIL.chine, BRAIL.f1], [10.6, BRAIL.f0, BRAIL.f3],
  ]) {
    const p = basPanel(z, lo, hi);
    dark.push(p.recess, place(p.recess, 0, 0, 0, true));
    accent.push(p.leaf, place(p.leaf, 0, 0, 0, true));
    trim.push(p.loom, place(p.loom, 0, 0, 0, true));
  }

  const tg = basTowerGlass();
  dark.push(tg.glass);
  trim.push(tg.sill);

  const bell = basBell();
  accent.push(bell.shell);
  dark.push(bell.dark);
  glow.push(bell.glow);

  return [
    { key: 'hull', geo: join(...hull) },
    { key: 'accent', geo: join(...accent) },
    { key: 'dark', geo: join(...dark) },
    { key: 'trim', geo: join(...trim) },
    { key: 'glow', geo: join(...glow) },
  ];
}


/* ================================================================== */
/* THE DRAY — 28 m ore tender, berth B2                                */
/* ================================================================== */

/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  WHY THE WORKHORSE IS THE HARD ONE
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * The Kestrel's brief was "stop being a box". The Dray's is harder, because
 * her bulk is the POINT — she is the ore tender, she is meant to read heavy —
 * and the lazy way to draw heavy is a rectangle. The procedural hull took it:
 * a 10.4 x 3.7 x 24 m plated drum with a second box on top of it, a third box
 * on top of that, a lattice derrick and a counter stern. From the apron that
 * is a barge with a crane on it, which is what the file's own note admits.
 *
 * What is NOT free to move, and every one of these is a contract in
 * `HullPlan.DRAY` that `Climb`, `dock-reach` and `dock-hulls` measure:
 *
 *   - the flank's outer face is 5.20 and climb band 0 grips it at z -8.0;
 *   - the weather deck at 4.56 is walked from z -13 to 11 at the full 5.20,
 *     so the skin has to close flat underneath it at 4.40 (`DECK_T` = 0.16);
 *   - the deckhouse flank is 4.05 and band 1 grips it at z 0.5, with 1.15 m
 *     of side deck outboard of it that is walked as well;
 *   - the spine deck at 6.54 is walked from z -12 to 2;
 *   - the cargo door is 3.0 x 2.6 in the flank at z -1.5 with its sill on the
 *     hold sole at 1.00, and `slidePocket` reserves z -4.00..1.00 round it.
 *
 * So the beam, both deck heights and the whole deckhouse envelope are pinned.
 * What is free is EVERY SECTION BETWEEN THEM, which is where a working ship's
 * character actually lives:
 *
 *   - **A hopper section.** Max beam is carried at a hard longitudinal
 *     knuckle 42% of the depth up from the keel; below it the plating slopes
 *     0.50 m inboard to the turn of the bilge, and above it the flank runs to
 *     the deck edge with 0.09 m of tumblehome. One continuous surface from the
 *     keel flat to the sheer with two creases in it — which is what an ore
 *     carrier's midship section is, and is not expressible in `sec()`.
 *   - **One skin, transom to stem.** The plated drum, the bow cap and the
 *     stern counter were three lofts with steps between them. Here they are
 *     stations 1 and 47 of the same swept surface: the beam fairs from 5.20
 *     into a 2.2 m stem, the keel takes 1.74 m of rocker forward and 1.52 m
 *     aft, and there is no step in it anywhere.
 *   - **External tankage.** Two 5.4 m pressure tanks with dished heads and
 *     girth straps, cantilevered off the deckhouse flanks on saddles. They
 *     are the one thing on this hull that puts daylight ABOVE the side deck
 *     and OUTBOARD of the spine, which is exactly what the silhouette probe
 *     measures — and they are placed by `DRAY.radiator`'s own rule.
 *   - **Three engines with throats.** The transom carried three cones on
 *     1.9 m boxes. They are tubes now: a casing rolled over a lip, a nozzle
 *     flaring to the exit plane and a duct running forward into the dark. The
 *     exit plane is where `bell()` recorded it, so the flown hull's plume
 *     still starts on metal.
 *
 * Everything the Kestrel's header says about method applies unchanged: curves
 * through control tables, sections swept along them, per-vertex normals split
 * at named creases, dressing generated from the same section functions so it
 * cannot float, and the three build-time gates that have all already fired.
 */

/**
 * The plan constants this hull is cut to. Duplicated from `HullPlan.DRAY` for
 * the reason {@link PLAN} is — this script imports nothing from the game — and
 * held against the live plan by `scripts/tests/ship-dray.test.mjs`.
 */
export const DRAY = {
  z0: -14.0, z1: 14.0,
  bellyY0: 0.40, bellyY1: 0.84, bellyHW: 4.70,
  lowerY0: 0.84, lowerY1: 4.56, lowerHW: 5.20, lowerZ0: -13.0, lowerZ1: 11.0,
  ledgeY: 4.56, ledgeOuter: 5.20,
  upper: { y0: 4.56, y1: 6.40, hw: 4.05, z0: -12.0, z1: 2.0 },
  spineY: 6.54, spineHW: 4.05,
  bridge: { z0: -9.6, z1: -6.6, hw: 3.30, y0: 6.54, y1: 9.10 },
  bowCap: { z0: 11.0, z1: 14.0, hw: 2.4, y0: 1.4, y1: 4.56 },
  hatch: { lz: -1.5, w: 3.0, h: 2.6 },
  deckY: 1.00,
  roomHW: 3.00, holdCeilY: 4.40,
  spineHole: { lx: 0, lz: 1.1, half: 1.5 },
  radiator: { x0: 3.4, x1: 6.4, y0: 7.40, y1: 9.00, z0: -9.4, z1: -6.8 },
  engineY: 2.20, engineX: 3.00,
};

/** Metres of hull per texture tile. Coarser than the Kestrel's: bigger plate. */
const DTILE = 3.0;

/* ------------------------------------------------------------------ */
/* The four rails the hull is drawn on                                 */
/* ------------------------------------------------------------------ */

/**
 * Half-beam at the sheer, by station.
 *
 * 5.20 is held from z -12.0 to 9.6 because that face is what `plated` collides
 * and what climb band 0 grips at z -8.0; a hull pinched anywhere in that run
 * hands the player a collider standing outboard of the plating they can see.
 * The taper is spent where it is free — 4.4 m of entrance forward and 1.0 m of
 * run aft — and the stations at 11.90 / 12.70 / 13.40 are the procedural bow
 * cap's own, so the boxes `loftSolid` inscribed in it are still inside this
 * skin on the arm that draws it.
 */
const DHW = curve([
  [-14.00, 3.30], [-13.60, 4.30], [-13.00, 5.20], [-12.00, 5.20],
  [9.60, 5.20], [11.00, 5.16], [11.90, 4.85], [12.70, 3.95],
  [13.40, 2.05], [14.00, 0.34],
]);

/**
 * The keel line. Flat on 0.40 — the height this berth's bearing blocks are cut
 * to — from z -7.0 to 5.0, then rocker into both ends.
 */
const DYBOT = curve([
  [-14.00, 1.92], [-13.60, 1.56], [-13.00, 1.12], [-12.20, 0.76],
  [-11.20, 0.54], [-10.00, 0.44], [-7.00, 0.40], [5.00, 0.40],
  [7.60, 0.44], [9.20, 0.55], [10.40, 0.72], [11.00, 0.86],
  [11.90, 1.05], [12.70, 1.30], [13.40, 2.24], [13.70, 2.66], [14.00, 3.16],
]);

/**
 * The crown, and the two 0.10 m steps in it are the weather deck's own ends.
 *
 * `deckSlab` lays a plate from z -13.0 to 11.0 whose TOP is the walked deck at
 * 4.56 and whose underside is 4.40, so the skin closes at 4.40 under it — rule
 * 2, one plate, ledge on top and ceiling underneath. Outside that run there is
 * no plate, so the skin itself is the deck at 4.56 and the step happens in the
 * 0.10 m the plate's own end face occupies. Read each pair of control points
 * as a vertical face, because that is what it is.
 */
const DYTOP = curve([
  [-14.00, 4.06], [-13.55, 4.34], [-13.10, 4.56], [-13.00, 4.40],
  [-11.00, 4.40], [9.00, 4.40], [10.90, 4.40], [11.00, 4.56],
  [11.90, 4.52], [12.70, 4.42], [13.40, 4.24], [13.70, 4.10], [14.00, 3.90],
]);

/**
 * Half-width of the flat of the keel, in metres.
 *
 * 1.97 amidships is not a look: `keel()` cuts the procedural belly's own flat
 * at `belly.hw * 0.42` = 1.974 and the cradle's saddles bear on it. A hull
 * that narrowed its keel here would sit on this berth's blocks on two lines
 * instead of on two faces.
 */
const DKEELW = curve([
  [-14.00, 0.50], [-13.00, 1.10], [-11.50, 1.72], [-9.00, 1.97],
  [6.00, 1.97], [9.00, 1.80], [11.00, 1.36], [12.70, 0.60],
  [14.00, 0.07],
]);

/** Height of the hopper knuckle — max beam — as a fraction of the depth. */
const DKNUCK = 0.42;
/** Height of the top of the turn of the bilge, as a fraction of the depth. */
const DBILGE = 0.11;
/**
 * How far the hopper slope tucks in at the turn of the bilge, in metres.
 *
 * 0.50 is arithmetic rather than taste. 5.20 - 0.50 = 4.70, which is
 * `DRAY.belly.hw`, and 0.11 of the 4.00 m midships depth is 0.44 over a keel
 * at 0.40, which is `DRAY.belly.y1` = 0.84. So the point where this slope
 * stops IS the corner the plan declares the belly to, and the boxes `keel()`
 * inscribes in the procedural underbody sit inside this surface rather than
 * poking through it.
 */
const DHOPIN = 0.50;
/** Tumblehome at the deck edge, in metres. */
const DTUMBLE = 0.09;
/** Height of the roll over the deck edge, under the plate that caps it. */
const DCROWN = 0.15;

/**
 * The cargo aperture, and both heights are `flankAperture`'s rather than mine.
 *
 * `ShipBuild.aperture` is told `deckY - 0.08 .. deckY + hatch.h + 0.30` =
 * 0.92 .. 3.90 and every dressing pass in `Hulls.js` asks it before drawing.
 * The hole in this skin is cut to 0.92 at the sill for exactly that reason,
 * and to 4.06 at the head because that is the top of the cargo passage's own
 * deckhead plate — the last thing behind the opening that closes it. Cut to
 * the deck edge instead, the hole would look into the 0.34 m void between that
 * plate and the weather deck.
 */
const DDOOR = {
  z0: DRAY.hatch.lz - DRAY.hatch.w / 2,   // -3.00
  z1: DRAY.hatch.lz + DRAY.hatch.w / 2,   //  0.00
  y0: DRAY.deckY - 0.08,                  //  0.92
  y1: DRAY.deckY + DRAY.hatch.h + 0.46,   //  4.06
};
/** Metres either side of the aperture over which the hopper slope fairs out. */
const DDOOR_FAIR = 1.10;

/**
 * 1 where the flank must be a flat vertical panel, 0 where it is free.
 *
 * A 3 x 2.6 m shell door is a rectangle and its leaves are planes. On this
 * hull the doorway spans y 0.92..3.60, which crosses the hopper knuckle at
 * 2.08 — so without this the lower half of the opening would be cut in a
 * sloping plate and the leaves would stand 0.4 m off it at the sill. Flat
 * surround, which is what a real hull does with a shell door and what
 * `knuckle`'s own note in `Hulls.js` already says about THIS ship: "where a
 * hull has a shell door the surround IS the strake".
 */
function drayDoorPanel(z) {
  const d = Math.max(DDOOR.z0 - z, z - DDOOR.z1, 0);
  return 1 - smooth(d / DDOOR_FAIR);
}

/**
 * The rails of a Dray section. Named, because the crease list, the hole and
 * every strake address them by index and an off-by-one is a hole in the wrong
 * place.
 */
const DRAIL = Object.freeze({
  keelCentre: 0,
  keelEdge: 1,     // CREASE — the edge of the flat the cradle bears on
  bilge0: 2,
  bilge1: 3,
  bilgeTop: 4,     // the turn of the bilge ends here, on 4.70 at y 0.84
  sill: 5,         // the cargo aperture's sill line
  knuckle: 6,      // CREASE — max beam, the hopper knuckle
  flank0: 7,
  flank1: 8,
  head: 9,         // the cargo aperture's head line
  deckEdge: 10,    // CREASE
  crown: 11,
  topEdge: 12,
  topCentre: 13,
});
const DRAY_HALF_RAILS = 14;
const DRAY_RING = 2 * DRAY_HALF_RAILS - 2;             // 26
const drayPort = (r) => DRAY_RING - r;
const DRAY_CREASES = [DRAIL.keelEdge, DRAIL.knuckle, DRAIL.deckEdge];

/**
 * One section of the hull, as a closed ring.
 *
 * `scale` fades every shape allowance out with the beam, so the rule that
 * gives a 10.4 m midships its hopper knuckle degenerates gracefully into a
 * 2.2 m stem instead of tying itself in a knot there.
 */
function draySection(z) {
  const yb = DYBOT(z), yt = DYTOP(z), hw = DHW(z);
  const h = Math.max(0.12, yt - yb);
  const flat = drayDoorPanel(z);
  const scale = clamp01(hw / DRAY.lowerHW);
  const keel = Math.min(DKEELW(z), hw * 0.88);

  const crown = Math.min(DCROWN, h * 0.06);
  const yDeck = yt - crown;
  const topHalf = Math.max(0.02, hw - Math.min(0.16, hw * 0.11));

  const yKn = yb + DKNUCK * h;
  const yBil = yb + DBILGE * h;
  const xBil = hw - DHOPIN * scale * (1 - flat);
  const tumble = DTUMBLE * scale;

  /* The flank above the knuckle: full beam at the knuckle, tumbled in at the
   * deck edge. `t` is 0 at the knuckle and 1 at the deck edge. */
  const flankX = (t) => hw - tumble * clamp01(t);
  const flankAt = (y) => {
    const t = (y - yKn) / Math.max(0.04, yDeck - yKn);
    return [flankX(t), y];
  };
  /* The hopper slope below it, straight, because a hopper plate is straight. */
  const hopAt = (y) => {
    const t = clamp01((y - yBil) / Math.max(0.04, yKn - yBil));
    return [THREE.MathUtils.lerp(xBil, hw, t), y];
  };

  /* The sill and head rails: the aperture's own edges where the aperture is,
   * and plain subdivision of the same two runs everywhere else. */
  const ySill = Math.min(Math.max(DDOOR.y0, yBil + 0.05), yKn - 0.05);
  const yHead = Math.max(Math.min(DDOOR.y1, yDeck - 0.05), yKn + 0.05);

  const half = new Array(DRAY_HALF_RAILS);
  half[DRAIL.keelCentre] = [0, yb];
  half[DRAIL.keelEdge] = [keel, yb];
  for (let k = 1; k <= 2; k++) {
    const a = (k / 3) * (Math.PI / 2);
    half[DRAIL.bilge0 + k - 1] = [
      keel + (xBil - keel) * Math.sin(a),
      yb + (yBil - yb) * (1 - Math.cos(a)),
    ];
  }
  half[DRAIL.bilgeTop] = [xBil, yBil];
  half[DRAIL.sill] = hopAt(ySill);
  half[DRAIL.knuckle] = [hw, yKn];
  half[DRAIL.flank0] = flankAt(THREE.MathUtils.lerp(yKn, yHead, 0.38));
  half[DRAIL.flank1] = flankAt(THREE.MathUtils.lerp(yKn, yHead, 0.74));
  half[DRAIL.head] = flankAt(yHead);
  half[DRAIL.deckEdge] = [flankX(1), yDeck];
  half[DRAIL.crown] = [THREE.MathUtils.lerp(flankX(1), topHalf, 0.62), yt - crown * 0.26];
  half[DRAIL.topEdge] = [topHalf, yt];
  half[DRAIL.topCentre] = [0, yt];
  return closeRing(half);
}

/**
 * Stations. Listed rather than stepped, and six of them are not negotiable:
 * -13.10 / -13.00 and 10.90 / 11.00 are the weather deck's end faces, and
 * -3.00 / 0.00 are the cargo aperture's own edges — a hole in a swept surface
 * can only be cut on grid lines, so the grid has to have lines where the hole
 * is.
 */
const DRAY_Z = [
  -14.00, -13.80, -13.55, -13.30, -13.10, -13.00, -12.70, -12.30, -11.80, -11.20,
  -10.50, -9.70, -8.80, -7.80, -6.80, -5.80, -4.80, -4.20, -3.60, -3.00,
  -2.40, -1.80, -1.20, -0.60, 0.00, 0.70, 1.50, 2.40, 3.40, 4.40,
  5.40, 6.40, 7.40, 8.40, 9.30, 10.10, 10.60, 10.90, 11.00, 11.40,
  11.90, 12.40, 12.70, 13.05, 13.40, 13.70, 14.00,
];

/** The hull: one swept skin from the transom to the stem, with the door in it. */
function drayHull() {
  const stations = DRAY_Z.map((z) => ({ z, pts: draySection(z) }));
  const s0 = DRAY_Z.indexOf(DDOOR.z0), s1 = DRAY_Z.indexOf(DDOOR.z1);
  if (s0 < 0 || s1 < 0) throw new Error('the cargo aperture needs a station on each of its own edges');
  const skip = (s, r) => s >= s0 && s < s1 && r >= DRAIL.sill && r < DRAIL.head;
  const creases = [...DRAY_CREASES, ...DRAY_CREASES.map(drayPort)];
  const skin = sweep(stations, { creaseRails: creases, skip, capAft: true, capFore: true, tile: DTILE });

  /* The reveal, 0.22 m deep — `SKIN`, the plating this doorway is cut through.
   * Without it the opening is a paper edge and a player on the ramp looks
   * straight through the thickness of their own ship's side. */
  const t = 0.22;
  const rim = { pos: [], nrm: [], uv: [], idx: [] };
  const quad = (p, q, r, s2, nx, ny, nz) => {
    const b = rim.pos.length / 3;
    for (const v of [p, q, r, s2]) {
      rim.pos.push(v[0], v[1], v[2]);
      rim.nrm.push(nx, ny, nz);
      rim.uv.push(v[2] / DTILE, v[1] / DTILE);
    }
    rim.idx.push(b, b + 1, b + 2, b, b + 2, b + 3);
  };
  const edge = (s, r) => {
    const p = stations[s].pts[r];
    return [p[0], p[1], stations[s].z];
  };
  const inb = (v) => [v[0] - t, v[1], v[2]];
  for (let s = s0; s < s1; s++) {
    const a = edge(s, DRAIL.sill), b = edge(s + 1, DRAIL.sill);
    quad(inb(a), inb(b), b, a, 0, -1, 0);
    const c = edge(s, DRAIL.head), d = edge(s + 1, DRAIL.head);
    quad(c, d, inb(d), inb(c), 0, 1, 0);
  }
  for (const [s, sign] of [[s0, -1], [s1, 1]]) {
    const a = edge(s, DRAIL.sill), b = edge(s, DRAIL.head);
    if (sign < 0) quad(a, b, inb(b), inb(a), 0, 0, 1);
    else quad(inb(a), inb(b), b, a, 0, 0, -1);
  }
  return join(skin, rim);
}

/* ------------------------------------------------------------------ */
/* The deckhouse                                                       */
/* ------------------------------------------------------------------ */

/**
 * THE ONE PART OF THIS HULL THAT REALLY IS PINNED TO A BOX, AND WHY.
 *
 * `DRAY.upper` is 8.10 m across, 1.84 m tall and 14 m long, and all three
 * numbers are held from outside: the flanks are climb band 1's grip face at
 * 4.05, the 1.15 m of side deck outboard of them is walked, and the spine deck
 * on top is walked from z -12 to 2 at that same 4.05. There is no tumblehome,
 * no taper and no rake available inside that envelope without handing the
 * player a collider standing where they can see open air.
 *
 * What IS free is the corners and the two ends, so that is where the shape
 * goes: a 0.30 m radius at the base, a 0.20 m radius under the deck edge — the
 * spine plate then overhangs by a deck edge rather than by a slab thickness —
 * a rounded aft end, and a framed portal at the forward end instead of a hole.
 * The rest of the answer is not the deckhouse at all: it is the tankage hung
 * off it, which is what puts daylight above this deck in the silhouette.
 */
const DH = DRAY.upper;
/** The crown: the spine plate's underside, 6.38 = 6.54 - `DECK_T`. */
const DH_TOP = curve([
  [-12.00, 5.98], [-11.70, 6.22], [-11.30, 6.34], [-10.80, 6.38],
  [1.40, 6.38], [1.75, 6.36], [2.00, 6.30],
]);
/** The plan: 4.05 through the whole of the run either deck is walked. */
const DH_HW = curve([
  [-12.00, 3.30], [-11.70, 3.74], [-11.30, 3.96], [-10.80, 4.05],
  [1.60, 4.05], [2.00, 4.02],
]);
const DH_Z = [
  -12.00, -11.85, -11.70, -11.50, -11.30, -11.05, -10.80, -10.00, -9.00, -7.80,
  -6.60, -5.40, -4.20, -3.00, -1.80, -0.60, 0.40, 1.10, 1.60, 2.00,
];

/** A deckhouse section: a radiused box standing on the weather deck. */
function dhSection(z) {
  const top = DH_TOP(z), hw = DH_HW(z), base = DH.y0;
  const h = Math.max(0.06, top - base);
  const rTop = Math.min(0.20, h * 0.16, hw * 0.5);
  const rBot = Math.min(0.30, h * 0.22, hw * 0.5);
  const half = [
    [hw * 0.55, base],
    [hw - rBot, base],
    [hw - rBot * 0.29, base + rBot * 0.29],
    [hw, base + rBot],
    [hw, top - rTop],
    [hw - rTop * 0.29, top - rTop * 0.29],
    [hw - rTop, top],
    [hw * 0.5, top],
    [0, top],
  ];
  const ring = half.map((p) => [p[0], p[1]]);
  for (let i = half.length - 2; i >= 0; i--) ring.push([-half[i][0], half[i][1]]);
  return ring;
}

/**
 * The deckhouse, open at the forward end.
 *
 * `plated(b, H.upper, 'hull', { capFore: false })` leaves that end open for a
 * reason the plan states: the companionway from the foredeck comes up THROUGH
 * it, and a cap there is a bulkhead across the middle of a stair. But an open
 * end on a swept shell is a hole you can see the inside of, so the fore end
 * gets a portal instead — two flat cheeks either side of the 3.4 m opening the
 * flight needs, with a jamb 1.10 m deep behind them so the opening has a
 * thickness rather than a paper edge.
 */
function drayDeckhouse() {
  const stations = DH_Z.map((z) => ({ z, pts: dhSection(z) }));
  const shell = sweep(stations, { creaseRails: [], capAft: true, tile: 2.6 });

  const zf = DH_Z[DH_Z.length - 1];
  const top = DH_TOP(zf), base = DH.y0, hw = DH_HW(zf);
  const PORT_HW = 1.70;                    // the flight is 2.2 m wide
  const cheek = { pos: [], nrm: [], uv: [], idx: [] };
  const quad = (vs, n) => {
    const b = cheek.pos.length / 3;
    for (const v of vs) {
      cheek.pos.push(v[0], v[1], v[2]);
      cheek.nrm.push(n[0], n[1], n[2]);
      cheek.uv.push(v[0] / 2.6, v[1] / 2.6);
    }
    cheek.idx.push(b, b + 1, b + 2, b, b + 2, b + 3);
  };
  for (const sg of [-1, 1]) {
    // The flat cheek between the portal and the shell's own edge.
    const a = [sg * PORT_HW, base, zf], c = [sg * hw, base, zf];
    const d = [sg * hw, top - 0.20, zf], e = [sg * PORT_HW, top, zf];
    if (sg > 0) quad([a, c, d, e], [0, 0, 1]); else quad([e, d, c, a], [0, 0, 1]);
    // The jamb, running aft into the stair well.
    const j0 = [sg * PORT_HW, base, zf], j1 = [sg * PORT_HW, top, zf];
    const j2 = [sg * PORT_HW, top, zf - 1.10], j3 = [sg * PORT_HW, base, zf - 1.10];
    if (sg > 0) quad([j0, j3, j2, j1], [-1, 0, 0]); else quad([j1, j2, j3, j0], [1, 0, 0]);
  }
  // The head of the portal, turned aft the same way.
  const hb = cheek.pos.length / 3;
  for (const v of [[-PORT_HW, top, zf], [PORT_HW, top, zf],
    [PORT_HW, top, zf - 1.10], [-PORT_HW, top, zf - 1.10]]) {
    cheek.pos.push(v[0], v[1], v[2]);
    cheek.nrm.push(0, -1, 0);
    cheek.uv.push(v[0] / 2.6, v[2] / 2.6);
  }
  cheek.idx.push(hb, hb + 1, hb + 2, hb, hb + 2, hb + 3);
  return join(shell, cheek);
}

/* ------------------------------------------------------------------ */
/* The bridge castle                                                   */
/* ------------------------------------------------------------------ */

const BR = DRAY.bridge;
/** The castle's crown: full height aft, raked away over the last 1.4 m. */
const BR_TOP = curve([
  [-9.60, 8.62], [-9.30, 8.94], [-8.90, 9.10], [-7.60, 9.10],
  [-7.20, 8.96], [-6.90, 8.62], [-6.60, 8.02],
]);
/** And its plan, tapering into the front. */
const BR_HW = curve([
  [-9.60, 2.92], [-9.30, 3.18], [-8.90, 3.30], [-7.60, 3.30],
  [-7.20, 3.18], [-6.90, 3.00], [-6.60, 2.76],
]);
const BR_Z = [
  -9.60, -9.45, -9.30, -9.10, -8.90, -8.50, -8.10, -7.85, -7.60, -7.40,
  -7.20, -7.05, -6.90, -6.75, -6.60,
];
/** Rails in one half of {@link brSection}, for {@link brBand}. */
const BR_HALF = 7;

/** A castle section: a radiused box with the top corners taken hard off. */
function brSection(z) {
  const top = BR_TOP(z), hw = BR_HW(z), base = BR.y0;
  const h = Math.max(0.06, top - base);
  const r = Math.min(0.44, h * 0.20, hw * 0.4);
  const half = [
    [hw * 0.6, base],
    [hw - 0.14, base],
    [hw, base + 0.16],
    [hw, top - r],
    [hw - r * 0.29, top - r * 0.29],
    [hw - r, top],
    [hw * 0.55, top],
    [0, top],
  ];
  const ring = half.map((p) => [p[0], p[1]]);
  for (let i = half.length - 2; i >= 0; i--) ring.push([-half[i][0], half[i][1]]);
  return ring;
}

function drayBridge() {
  const stations = BR_Z.map((z) => ({ z, pts: brSection(z) }));
  return sweep(stations, { creaseRails: [], capFore: true, capAft: true, tile: 2.2 });
}

/**
 * A band lying on the castle, port to starboard, `lo`..`hi` in FRACTIONAL rail
 * indices — the Kestrel's `dorsalBand` trick, and for its reason: the rails up
 * here are 0.4 m apart and a window snapped to whole rails is a 0.4 m band of
 * trim round every edge of the glass.
 */
function brBand(z, lo, hi, out, n = 5) {
  const ring = brSection(z);
  const half = ring.slice(0, BR_HALF + 1);
  const cy = (BR.y0 + BR_TOP(z)) / 2;
  const at = (r) => {
    const i = Math.max(0, Math.min(half.length - 2, Math.floor(r)));
    const t = Math.max(0, Math.min(1, r - i));
    return [
      THREE.MathUtils.lerp(half[i][0], half[i + 1][0], t),
      THREE.MathUtils.lerp(half[i][1], half[i + 1][1], t),
    ];
  };
  const push = ([x, y]) => {
    const dy = y - cy;
    const d = Math.hypot(x, dy) || 1;
    return [x + (x / d) * out, y + (dy / d) * out];
  };
  const star = [];
  for (let k = 0; k <= n; k++) star.push(push(at(THREE.MathUtils.lerp(lo, hi, k / n))));
  const pts = [];
  for (let i = star.length - 1; i >= 0; i--) pts.push([-star[i][0], star[i][1]]);
  pts.push(...star);
  return { z, pts };
}

function brBandSweep(lo, hi, out, z0, z1, n = 5, steps = 8) {
  const zs = [];
  for (let i = 0; i <= steps; i++) zs.push(THREE.MathUtils.lerp(z0, z1, i / steps));
  return sweep(zs.map((z) => brBand(z, lo, hi, out, n)), { creaseRails: [], closed: false, tile: 1.8 });
}

/**
 * THE WHEELHOUSE, AND IT FOLLOWS THE RAKE BECAUSE IT IS THE SAME SURFACE.
 *
 * The band's rails are fractions of the castle's own section, so where the
 * crown rakes away over the last 1.4 m the glazing rakes with it: `sides` is
 * the window band down each flank and `screen` is the same construction on the
 * rails that have become the raked front. A flat pane parked in front of the
 * castle — which is what the procedural hull draws — cannot do that, and a
 * raked bridge with an upright window in it is exactly the detail that reads
 * as "a box with a decal on it".
 */
const drayGlazing = () => join(
  brBandSweep(2.55, 3.55, 0.05, -9.10, -6.90, 5, 9),
  brBandSweep(4.55, 6.60, 0.05, -7.34, -6.64, 5, 6),
);
const drayCoaming = () => join(
  brBandSweep(2.40, 3.72, 0.02, -9.22, -6.82, 6, 10),
  brBandSweep(4.38, 6.80, 0.02, -7.44, -6.60, 6, 7),
);

/* ------------------------------------------------------------------ */
/* External tankage                                                    */
/* ------------------------------------------------------------------ */

/**
 * TWO PRESSURE TANKS, AND THE THREE NUMBERS THAT PLACE THEM.
 *
 *   y 6.62 at the bottom   2.06 m over the side deck at 4.56. `DRAY.radiator`
 *          is placed by the same rule and states it: a 1.75 m body walks
 *          under it.
 *   x 4.75 at the inboard face   0.70 m outboard of the spine deck's own edge
 *          at 4.05, so a capsule of radius 0.35 walking that edge has 0.35 m
 *          to spare.
 *   z -5.80..-0.40   forward of `DRAY.radiator` (-9.40..-6.80) and outboard of
 *          the ore hoppers on the deck (x -2.75, r 1.20). Nothing on this ship
 *          is inside them.
 *
 * A lathed shell with dished heads, not a cylinder with flat caps: the dish is
 * a dozen triangles and it is the difference between a pressure vessel and a
 * bin.
 */
const DTANK = { cx: 5.65, cy: 7.52, r: 0.90, z0: -5.80, z1: -0.40 };

/** Circular section — `podSection` with both exponents at 2 is an ellipse. */
const tube = (r, cy, n = 16) => podSection(r, r, cy, 2, 2, n);

function drayTank() {
  const T = DTANK;
  const L = T.z1 - T.z0;
  const zs = [
    T.z0, T.z0 + 0.10, T.z0 + 0.28, T.z0 + 0.55,
    T.z0 + L * 0.35, T.z0 + L * 0.65,
    T.z1 - 0.55, T.z1 - 0.28, T.z1 - 0.10, T.z1,
  ];
  /* The dish: an ellipse over the last 0.55 m at each end, leaving a 0.28 m
   * flat in the middle of the head — which is what a torispherical end looks
   * like from ten metres away, and what a hemisphere does not. */
  const rad = (z) => {
    const d = Math.min(z - T.z0, T.z1 - z);
    if (d >= 0.55) return T.r;
    const u = 1 - d / 0.55;
    return T.r * Math.sqrt(Math.max(0.04, 1 - u * u * 0.90));
  };
  const shell = sweep(zs.map((z) => ({ z, pts: tube(rad(z), T.cy) })),
    { creaseRails: [], capFore: true, capAft: true, tile: 1.8 });

  const parts = [shell];
  for (const gz of [T.z0 + 1.35, T.z1 - 1.35]) {
    parts.push(sweep([gz - 0.09, gz + 0.09].map((z) => ({ z, pts: tube(T.r + 0.05, T.cy) })),
      { creaseRails: [], tile: 1.0 }));
  }
  return join(...parts);
}

/** The saddles: two brackets per tank, down onto the deckhouse coaming. */
function drayTankSaddles() {
  const T = DTANK;
  const out = [];
  for (const gz of [T.z0 + 1.35, T.z1 - 1.35]) {
    out.push(slabPart(1.10, 0.16, 0.34, (T.cx + DH.hw) / 2, T.cy - T.r + 0.06, gz, 1.2));
    out.push(slabPart(0.22, 1.00, 0.30, DH.hw + 0.12, T.cy - 0.40, gz, 1.2));
  }
  return join(...out);
}

/* ------------------------------------------------------------------ */
/* The engines                                                         */
/* ------------------------------------------------------------------ */

/**
 * THREE ENGINES, AND THEY ARE TUBES BECAUSE A DISC IS NOT AN ENGINE.
 *
 * `bell()` draws a cone with a lit cone inside it and records the exit plane
 * in `b.nozzles`; the flown hull hangs its plume off that record, so the
 * numbers here are cut to it rather than chosen. `bell(b, s * 3.0, 2.2,
 * H.z0 - 0.70, 1.05, 1.45, 1.70)` ends its metal at z -15.55 and records the
 * plume at -15.64, and that is where this casing ends. What changes is that
 * there is something behind the lip: a nozzle flaring to the exit plane and a
 * duct running forward into the dark, so from astern — the one angle a chase
 * camera always gives you — you are looking down three holes rather than at
 * three discs.
 */
const DENG = { y: DRAY.engineY, xs: [-3.00, 0, 3.00], z1: -13.10, z0: -15.55 };

function drayEngine() {
  const E = DENG;
  const shellZ = [E.z0, E.z0 + 0.16, E.z0 + 0.42, E.z0 + 0.9, E.z0 + 1.5, E.z0 + 2.0, E.z1];
  const rad = curve([
    [E.z0, 1.34], [E.z0 + 0.16, 1.30], [E.z0 + 0.42, 1.14], [E.z0 + 0.9, 1.06],
    [E.z0 + 1.5, 1.10], [E.z0 + 2.0, 1.06], [E.z1, 0.96],
  ]);
  const shell = sweep(shellZ.map((z) => ({ z, pts: tube(rad(z), E.y, 18) })),
    { creaseRails: [], capFore: true, tile: 2.0 });

  /* The nozzle: a throat flaring to the exit plane, drawn inside out. Its rim
   * radius is the casing's own, so the two meet on a rolled lip instead of
   * leaving an 8 cm annulus of nothing between them. */
  const exZ = [E.z0, E.z0 + 0.22, E.z0 + 0.6, E.z0 + 1.2, E.z0 + 1.9];
  const exR = curve([
    [E.z0, 1.34], [E.z0 + 0.22, 1.02], [E.z0 + 0.6, 0.74], [E.z0 + 1.2, 0.58], [E.z0 + 1.9, 0.54],
  ]);
  const duct = sweep(exZ.map((z) => ({ z, pts: tube(exR(z), E.y, 18) })),
    { creaseRails: [], capFore: true, flip: true, tile: 1.4 });

  // The burner ring, just inside the throat.
  const burn = sweep([
    { z: E.z0 + 0.50, pts: tube(0.80, E.y, 14) },
    { z: E.z0 + 0.74, pts: tube(0.70, E.y, 14) },
  ], { creaseRails: [], flip: true, tile: 1.0 });

  // The collar the casing is hung on, and a girth band forward of the lip.
  const collar = sweep([
    { z: E.z1 - 0.30, pts: tube(1.08, E.y, 18) },
    { z: E.z1 - 0.10, pts: tube(1.08, E.y, 18) },
  ], { creaseRails: [], tile: 1.0 });
  const band = sweep([
    { z: E.z0 + 1.16, pts: tube(1.13, E.y, 18) },
    { z: E.z0 + 1.34, pts: tube(1.13, E.y, 18) },
  ], { creaseRails: [], tile: 1.0 });

  return { shell, duct, burn, trim: join(collar, band) };
}

/* ------------------------------------------------------------------ */
/* Dressing, generated from the same section functions as the skin     */
/* ------------------------------------------------------------------ */

/** Centre height of a hull station, for {@link offsetPts}. */
const drayCentre = (z) => (DYBOT(z) + DYTOP(z)) / 2;

/**
 * Transverse frame bands. None of them crosses the cargo aperture:
 * `slidePocket` reserves z -4.00..1.00 on the boarding flank, and a ring round
 * a hull is exactly the shape of thing that used to run over a doorway.
 */
function drayFrames() {
  const parts = [];
  for (const z of [-11.60, -8.60, -5.60, 2.20, 5.60, 8.60]) {
    const stations = [z - 0.11, z + 0.11].map((zz) => ({
      z: zz, pts: offsetPts(draySection(zz), drayCentre(zz), 0.03),
    }));
    parts.push(sweep(stations, {
      creaseRails: [DRAIL.knuckle, drayPort(DRAIL.knuckle)], tile: 1.4,
    }));
  }
  return join(...parts);
}

/**
 * A longitudinal band lying on one rail of the hull, in runs.
 *
 * Generated from `draySection` and pushed 0.025 m off it, so it follows the
 * hopper knuckle round into the entrance and down into the counter instead of
 * floating off a surface that has stopped being where the band was pinned —
 * which is what `relief` and `panelLines` do to any hull that is not a plate.
 * The runs exist because the cargo aperture is a hole, and a strake through a
 * doorway is the defect `flankAperture` was written to end.
 */
function drayStrake(rail, runs, width = 0.30, out = 0.025) {
  const parts = [];
  for (const [a, c] of runs) {
    const zs = DRAY_Z.filter((z) => z > a && z < c);
    zs.unshift(a); zs.push(c);
    const stations = zs.map((z) => {
      const sec = draySection(z);
      const cy = drayCentre(z);
      const p = sec[rail], up = sec[rail + 1], dn = sec[rail - 1];
      const lerpTo = (q, f) => [
        THREE.MathUtils.lerp(p[0], q[0], f), THREE.MathUtils.lerp(p[1], q[1], f),
      ];
      const span = Math.hypot(up[0] - p[0], up[1] - p[1]) + Math.hypot(dn[0] - p[0], dn[1] - p[1]);
      const f = Math.min(0.5, width / Math.max(0.12, span));
      return { z, pts: offsetPts([lerpTo(dn, f), p, lerpTo(up, f)], cy, out) };
    });
    const star = sweep(stations, { creaseRails: [], closed: false, tile: 1.6 });
    parts.push(star, place(star, 0, 0, 0, true));
  }
  return join(...parts);
}

/**
 * The stem bar: the last 2.6 m of the crown line, 0.04 m proud of it.
 * A raked stem with nothing on its edge is a wedge; a bar down it is a bow.
 */
function drayStem() {
  const zs = [11.40, 11.90, 12.40, 12.70, 13.05, 13.40, 13.70, 14.00];
  const stations = zs.map((z) => {
    const sec = draySection(z);
    const t = sec[DRAIL.topCentre], e = sec[DRAIL.topEdge];
    const w = Math.min(0.30, Math.abs(e[0]) * 0.8);
    return {
      z,
      pts: offsetPts([[-w, t[1]], [0, t[1]], [w, t[1]]], drayCentre(z), 0.04),
    };
  });
  return sweep(stations, { creaseRails: [], closed: false, tile: 1.4 });
}

/**
 * STIFFENER FRAMES ROUND THE DECKHOUSE, AND THIS IS THE ONE THE SHOT DEMANDED.
 *
 * Framed three-quarter from astern, the deckhouse and the bridge castle read as
 * two panelled slabs stacked on each other — which is the player's own sentence
 * about this yard, arriving on the one part of this hull the plan leaves no
 * room to reshape (see the note on {@link drayDeckhouse}). What is still free
 * is the SURFACE, so it gets structure: nine transverse frames standing 0.035 m
 * proud, generated from `dhSection` so they follow both corner radii instead of
 * stopping dead at them the way a box would.
 *
 * A full ring rather than two flank strips because the top and bottom of it are
 * free: the crown at 6.38 is under the spine plate (6.38..6.54) and the base at
 * 4.56 is inside the weather deck plate (4.40..4.56), so those arcs are buried
 * in geometry both arms already draw and cost nothing to look at.
 */
function drayHouseFrames() {
  const parts = [];
  for (const z of [-11.00, -9.40, -7.80, -6.20, -4.60, -3.00, -1.40, 0.20, 1.40]) {
    const stations = [z - 0.07, z + 0.07].map((zz) => ({
      z: zz, pts: offsetPts(dhSection(zz), (DH.y0 + DH_TOP(zz)) / 2, 0.035),
    }));
    parts.push(sweep(stations, { creaseRails: [], tile: 1.2 }));
  }
  return join(...parts);
}

/**
 * The castle's plinth and its roof cornice.
 *
 * Same trick as the wheelhouse band and the same reason: built from the
 * castle's own section, so the cornice follows the rake over the front instead
 * of stopping at it, and a box with a cornice is a building rather than a
 * crate.
 */
const drayCastleTrim = () => join(
  brBandSweep(1.55, 2.35, 0.03, -9.55, -6.65, 4, 9),
  brBandSweep(4.85, 5.65, 0.03, -9.55, -7.10, 4, 8),
);

/** A rubbing strake down each deckhouse flank, lying on its own section. */
function drayHouseStrake() {
  const zs = DH_Z.filter((z) => z >= -11.4 && z <= 1.8);
  const stations = zs.map((z) => {
    const hw = DH_HW(z);
    const cy = (DH.y0 + DH_TOP(z)) / 2;
    return { z, pts: offsetPts([[hw, 5.16], [hw, 5.38], [hw, 5.60]], cy, 0.03) };
  });
  const star = sweep(stations, { creaseRails: [], closed: false, tile: 1.6 });
  return join(star, place(star, 0, 0, 0, true));
}

/**
 * A flat slab as a part — the one place a box is still the right answer, and
 * it is used only for lamps and brackets, never for a surface.
 */
function slabPart(w, h, d, x, y, z, tile = 1.2) {
  const p = { pos: [], nrm: [], uv: [], idx: [] };
  const g = new THREE.BoxGeometry(w, h, d).translate(x, y, z);
  const nonIdx = g.toNonIndexed();
  const P = nonIdx.attributes.position.array, N = nonIdx.attributes.normal.array;
  for (let i = 0; i < P.length; i += 3) {
    p.pos.push(P[i], P[i + 1], P[i + 2]);
    p.nrm.push(N[i], N[i + 1], N[i + 2]);
    p.uv.push(P[i] / tile, P[i + 1] / tile);
  }
  for (let i = 0; i < p.pos.length / 3; i++) p.idx.push(i);
  g.dispose(); nonIdx.dispose();
  return p;
}

/**
 * The lights, authored WITH the hull rather than placed against it: every one
 * of these sits on a surface this script owns and nothing else can measure.
 */
function drayLamps() {
  const out = [];
  // The stem light, on the crown of the bow.
  out.push(slabPart(0.30, 0.10, 0.36, 0, 4.34, 13.20));
  for (const s of [-1, 1]) {
    // Deck-edge running lights, forward and aft, on the sheer.
    out.push(slabPart(0.10, 0.10, 0.70, s * 5.14, 4.06, 9.60));
    out.push(slabPart(0.10, 0.10, 0.70, s * 5.14, 4.06, -11.60));
    // Floods on the tank saddles, washing the side deck. 2.10 m over it.
    out.push(slabPart(0.34, 0.06, 0.16, s * 4.30, 6.66, DTANK.z0 + 1.35));
    out.push(slabPart(0.34, 0.06, 0.16, s * 4.30, 6.66, DTANK.z1 - 1.35));
    // The strip down the deckhouse flank, which is what reads at 200 m.
    out.push(slabPart(0.10, 0.08, 6.40, s * 4.07, 6.05, -4.20, 2.0));
  }
  return join(...out);
}

/* ------------------------------------------------------------------ */
/* Assembly of the Dray                                                */
/* ------------------------------------------------------------------ */

function drayParts() {
  const eng = drayEngine();
  const tank = drayTank();
  const saddle = drayTankSaddles();
  const engAt = (part) => join(...DENG.xs.map((x) => place(part, x, 0, 0)));
  return [
    { key: 'hull', geo: join(drayHull(), drayDeckhouse(), drayBridge()) },
    {
      key: 'accent',
      geo: join(
        engAt(eng.shell),
        place(tank, DTANK.cx, 0, 0), place(tank, -DTANK.cx, 0, 0, true),
      ),
    },
    {
      key: 'dark',
      geo: join(engAt(eng.duct), saddle, place(saddle, 0, 0, 0, true)),
    },
    { key: 'glass', geo: drayGlazing() },
    {
      key: 'trim',
      geo: join(
        drayCoaming(), drayFrames(), drayStem(), drayHouseStrake(), engAt(eng.trim),
        drayHouseFrames(), drayCastleTrim(),
        drayStrake(DRAIL.knuckle, [[-13.40, -4.20], [1.20, 11.20]], 0.34),
        drayStrake(DRAIL.deckEdge, [[-13.60, 10.80]], 0.26, 0.02),
      ),
    },
    { key: 'glow', geo: join(drayLamps(), engAt(eng.burn)) },
  ];
}


/* ══════════════════════════════════════════════════════════════════════════ */
/*  THE PIKE — 18 m interceptor, berth B3                                     */
/* ══════════════════════════════════════════════════════════════════════════ */

/**
 * THE SHIP A PLAYER BUYS TO FIGHT IN, AND WHAT THAT MEANS FOR THE SURFACE.
 *
 * The Kestrel's brief was "a courier that is not a barge". This one is
 * narrower: an interceptor has to read as FAST AND HOSTILE at a kilometre,
 * which is a silhouette problem before it is a detail problem. Three things
 * carry it and not one of them is expressible as a box:
 *
 *   - **A chine.** The widest line on this hull is a knife-edge crease at
 *     y ~1.90 running 13 m from the transom to the nose root, with the flank
 *     BELOW it tucking in to a narrow keel and the flank ABOVE it falling
 *     inboard to a crown half as wide. The section is a flattened diamond,
 *     which is what an SR-71, an F-16XL and an F-22 forebody all are, and it
 *     is the reason a 4.70 m beam does not read as a slab: the eye sees one
 *     bright line with two shaded surfaces folded off it, not a flat plate.
 *   - **A blade forebody.** Forward of the wing the crown half-beam falls
 *     from 2.28 to 0.09 over 6 m while the chine holds wide and then runs out
 *     as a strake, so the nose is a thin vertical blade sitting on a wide flat
 *     shelf. The two cannon lie in the troughs that leaves and emerge from the
 *     skin at z 8.2, with 3.2 m of barrel in clear air.
 *   - **A dorsal that rises FORWARD, not aft.** `PIKE.spine.y` is 4.60 and the
 *     ledge is 2.76, so 1.84 m of something stands on this deck whatever it is
 *     shaped like — and made as a box behind a flat canopy that something is a
 *     deckhouse, which is precisely the note this file opens with. So the rise
 *     happens forward: a measured 28.4-degree rake from the gun fairing up
 *     over the cockpit to the spine, with the blister set into the bottom of
 *     it, and the spine running straight aft into the fin root.
 *
 * ── The numbers that are not mine to choose ───────────────────────────────
 * Duplicated from `HullPlan.PIKE` for the reason {@link PLAN} is, and asserted
 * against the live plan by `scripts/tests/pike-assets.test.mjs`:
 *
 *   z0/z1        -7.50 / 10.50   overall length
 *   belly.y0      0.38           two centimetres over SADDLE_TOP
 *   lower.hw      2.35           flank; `plated` collides it over z -6.5..6.4
 *   ledge.y       2.76           walkable section deck (drawn as a slab)
 *   rooms ceilY   2.60           deck plate underside; the skin closes there
 *   spine.y       4.60           walkable dorsal spine (drawn as a slab)
 *   upper.hw      1.20           dorsal flank; climb band 2 grips it at z -2
 *   wing          x 2.20..5.60, TOP FLAT at 2.36 — climb band 0 mantles it
 *   fin           y 4.46..6.90, root z -6.9..-3.4, tip z -6.5..-5.1
 *   cannon        x 0.92, y 1.94, z 4.6..11.4
 *   hatch         lz -3.90, w 1.00, h 1.95, sill at deck.y 0.70
 */
export const PIKE_PLAN = {
  z0: -7.50, z1: 10.50,
  bellyY0: 0.38,
  lowerHW: 2.35,
  ledgeY: 2.76,
  roomHW: 1.20,
  ceilY: 2.60,
  spineY: 4.60,
  upperHW: 1.20,
  wing: {
    x0: 2.20, x1: 5.60, y0: 1.95, y1: 2.36,
    leadRoot: 3.05, trailRoot: -2.75, leadTip: 0.95, trailTip: -0.55,
    botRoot: 1.86, botTip: 2.19,
  },
  fin: { hw: 0.22, y0: 4.46, y1: 6.90, z0: -6.90, z1: -3.40, tipZ0: -6.50, tipZ1: -5.10 },
  ventral: { x: 5.05, y0: 1.10, y1: 2.10, z0: -0.90, z1: 0.90, cant: 0.42 },
  cannon: { x: 0.92, y: 1.94, z0: 4.60, z1: 11.40, r: 0.14 },
  hatch: { lz: -3.90, w: 1.00, h: 1.95, sill: 0.70 },
};

/**
 * Half-beam AT THE CHINE — the widest line on the hull, and the only one of
 * the three plan-view curves that is pinned by a collider.
 *
 * 2.35 from z -5.60 to 6.40 is neither laziness nor styling: `flankAperture`
 * runs `plated` over `PIKE.lower`, which registers a plate at x 2.24 for the
 * whole of z -6.5..6.4 on BOTH arms — `ShipBuild.mute` suppresses drawing and
 * never collision. A chine pinched inboard of 2.24 anywhere in that run would
 * hand the player an invisible wall standing off the plating they can see,
 * which is the complaint `station/Tower.js:425` records. So the taper is spent
 * where it is free: 1.9 m of transom aft, and the 4.1 m of nose forward of
 * z 6.40 where the plated section ends.
 */
const P_CHW = curve([
  [-7.50, 1.30], [-7.15, 1.68], [-6.80, 1.98], [-6.45, 2.20], [-6.10, 2.32],
  [-5.60, 2.35], [0.40, 2.35], [2.00, 2.35], [3.40, 2.34], [4.60, 2.32],
  [5.60, 2.30], [6.40, 2.25], [7.00, 1.80], [7.60, 1.42], [8.20, 1.06],
  [8.80, 0.76], [9.40, 0.52], [10.00, 0.30], [10.50, 0.10],
]);

/**
 * Height of the chine. Held between 1.86 and 1.94 the whole length, because a
 * crease that WANDERS in profile reads as a dent rather than as a line — and
 * because `PIKE.wing.y0` is 1.95, so the wing root leaves the hull on it.
 */
const P_YCHN = curve([
  [-7.50, 1.58], [-6.80, 1.76], [-5.60, 1.86], [0.40, 1.90], [3.40, 1.92],
  [6.40, 1.94], [8.20, 1.94], [9.60, 1.80], [10.50, 1.66],
]);

/**
 * Half-beam at the DECK EDGE, and the collapse of this curve forward of the
 * cockpit is what makes the forebody a blade instead of a wedge.
 *
 * 2.28 aft rather than the ledge's own 2.35: `deckSlab` draws that plate 4.70
 * across and its edge is 0.16 deep, so a 0.07 m overhang is a deck edge and a
 * flush one would be a plate with nothing under it. Forward of z 0.40 there is
 * no plate over the skin at all, so this curve is free — and it falls from
 * 2.28 to 0.09 over 10 m while {@link P_CHW} stays fat to z 6.40. The
 * difference between the two curves IS the strake.
 */
const P_DHW = curve([
  [-7.50, 0.90], [-7.10, 1.42], [-6.70, 1.86], [-6.30, 2.12], [-5.60, 2.26],
  [-5.00, 2.28], [0.40, 2.28], [1.20, 2.14], [2.20, 1.94], [3.40, 1.74],
  [4.60, 1.70], [5.60, 1.66], [6.40, 1.62], [7.20, 1.16], [8.20, 0.76],
  [9.10, 0.48], [9.90, 0.24], [10.50, 0.09],
]);

/**
 * The crown, and both of its flats are contracts.
 *
 * 2.60 from z -6.30 to 0.20 is `rooms.ceilY` — the section deck plate's own
 * underside, which `deckSlab` then caps from 2.60 to 2.76. The skin closes
 * exactly there and the slab is the deck: one plate, ledge on top, ceiling
 * underneath, which is rule 2 of `Hulls.js`.
 *
 * 2.76 from z 0.95 to 3.40 is that same slab's TOP, so the weather deck runs
 * aft as a plate and forward as the skin's own crown with no step between
 * them — and it is also `PIKE.fairing.y1`, the roof over the gun bay. Forward
 * of 3.40 it falls faster than {@link P_YBOT} rises, which is what aims the
 * blade slightly down.
 */
const P_YTOP = curve([
  [-7.50, 2.18], [-7.10, 2.40], [-6.70, 2.54], [-6.30, 2.60], [-5.50, 2.60],
  [0.20, 2.60], [0.55, 2.68], [0.95, 2.76], [3.40, 2.76], [4.60, 2.74],
  [5.60, 2.70], [6.40, 2.62], [7.20, 2.44], [8.20, 2.24], [9.10, 2.04],
  [9.90, 1.86], [10.50, 1.76],
]);

/**
 * The keel. Flat on 0.38 — `PIKE.belly.y0`, two centimetres over `SADDLE_TOP`
 * — from z -5.00 to 3.20, and lifting into both ends so the underside is a
 * curved surface along its length rather than the one big plane the shape
 * audit measured at 15.0% of this hull's whole visible skin.
 */
const P_YBOT = curve([
  [-7.50, 1.16], [-7.10, 0.90], [-6.70, 0.66], [-6.30, 0.49], [-5.80, 0.41],
  [-5.00, 0.38], [3.20, 0.38], [4.00, 0.43], [4.60, 0.47], [5.60, 0.62],
  [6.40, 0.80], [7.20, 1.00], [8.20, 1.20], [9.10, 1.36], [9.90, 1.50],
  [10.50, 1.56],
]);

/** Half-width of the flat of the keel, in metres. */
const P_KHW = curve([
  [-7.50, 0.40], [-6.50, 0.70], [-5.00, 0.92], [0.40, 0.98], [3.40, 0.92],
  [5.60, 0.78], [6.40, 0.64], [7.60, 0.40], [8.80, 0.24], [10.50, 0.05],
]);

/** How far the tumblehome above the chine bows outboard at mid-height. */
const P_BOW = 0.06;
/** Height of the roll over the deck edge, under whatever caps it. */
const P_CROWN = 0.13;

/** The boarding aperture, as `plated`'s own opening record cuts it. */
const P_DOOR = {
  z0: -4.40,          // hatch.lz - hatch.w / 2
  z1: -3.40,          // hatch.lz + hatch.w / 2
  y0: 0.50,
  y1: 2.60,           // ceilY: the skin closes under the deck plate
};
const P_DOOR_FAIR = 0.62;

/**
 * 1 where the flank must be a flat vertical panel, 0 where it is free.
 *
 * Same rule as the Kestrel's `doorPanel` and for the same reason — a door leaf
 * is a plane and a rectangular hole in a chined surface is not a rectangle —
 * but it costs this hull more, because the aperture runs from y 0.50 to 2.60
 * and the chine is at 1.90: the crease crosses the doorway. So inside the
 * panel the chine is driven DOWN to the sill and the crown roll to nothing,
 * which turns the section locally into a flat plate from sill to head. That is
 * what a real hull does with a shell door, and it is 2.2 m of a 13 m crease.
 */
function pikeDoorPanel(z) {
  const d = Math.max(P_DOOR.z0 - z, z - P_DOOR.z1, 0);
  return 1 - smooth(d / P_DOOR_FAIR);
}

/** Named rails. An off-by-one here is a hole in the wrong place. */
const PRAIL = Object.freeze({
  keelCentre: 0,
  keelEdge: 1,
  bilge0: 2,
  bilge1: 3,
  chine: 4,      // CREASE — max beam, and the aperture's sill
  flank0: 5,
  flank1: 6,
  deckEdge: 7,   // CREASE — the aperture's head
  crown: 8,
  topEdge: 9,
  topCentre: 10,
});
const P_HALF_RAILS = 11;
const pPortRail = (r) => 2 * P_HALF_RAILS - 2 - r;

/**
 * One section of the Pike, as a closed ring: a narrow flat keel, a radiused
 * turn out to the chine, a tumblehome above it, and a crowned deck edge.
 */
function pikeSection(z) {
  const yb = P_YBOT(z), yt = P_YTOP(z);
  const flat = pikeDoorPanel(z);
  const chw = P_CHW(z);
  const dhw = THREE.MathUtils.lerp(P_DHW(z), chw, flat);
  const h = yt - yb;
  const crown = Math.min(P_CROWN, h * 0.14) * (1 - flat);
  const yDeck = yt - crown;
  const yChine = THREE.MathUtils.lerp(
    Math.min(P_YCHN(z), yDeck - 0.12), yb + 0.12, flat);
  const keel = Math.min(P_KHW(z), chw * 0.92);
  /* Capped against the tumblehome's own run, because the CHINE is meant to be
   * the widest line on the hull and a 0.06 m bow on a flank that only falls
   * 0.07 m over the ledge run puts the waist 0.025 m outboard of it — a hull
   * whose crease is not its beam, which reads as a dent instead of an edge.
   *
   * The coefficient is arithmetic and not taste. The bow adds `bow*sin(pi*t)`
   * while the tumblehome only takes away `(chw-dhw)*t`, so near the chine the
   * bow wins unless `bow*pi <= chw-dhw`: the limit is 1/pi = 0.318 of the run
   * and 0.30 is under it at every station. Both bakes before this line went
   * in put the widest point on the flank rather than on the crease — 2.375
   * against a 2.35 chine, then 2.356. */
  const bow = Math.min(P_BOW, (chw - dhw) * 0.30) * (1 - flat) * clamp01(chw / PIKE_PLAN.lowerHW);

  const half = new Array(P_HALF_RAILS);
  half[PRAIL.keelCentre] = [0, yb];
  half[PRAIL.keelEdge] = [keel, yb];
  /* The turn of the bilge, as a quarter of an ellipse from the keel's own edge
   * out to the chine: two rails, because a crease needs a SURFACE either side
   * of it to read as a crease rather than as a corner between two planes. */
  for (let k = 1; k <= 2; k++) {
    const a = (k / 3) * (Math.PI / 2);
    half[PRAIL.bilge0 + k - 1] = [
      keel + (chw - keel) * Math.sin(a),
      yb + (yChine - yb) * (1 - Math.cos(a)),
    ];
  }
  half[PRAIL.chine] = [chw, yChine];
  /* The tumblehome: `t` is 0 at the chine and 1 at the deck edge, and the bow
   * is what stops it being a straight bevel between two creases. */
  const at = (t) => [
    THREE.MathUtils.lerp(chw, dhw, t) + bow * Math.sin(Math.PI * t),
    THREE.MathUtils.lerp(yChine, yDeck, t),
  ];
  half[PRAIL.flank0] = at(0.34);
  half[PRAIL.flank1] = at(0.68);
  half[PRAIL.deckEdge] = [dhw, yDeck];
  const topHalf = Math.max(0.02, dhw * (flat > 0.5 ? 0.96 : 0.70));
  half[PRAIL.crown] = [THREE.MathUtils.lerp(dhw, topHalf, 0.58), yt - crown * 0.26];
  half[PRAIL.topEdge] = [topHalf, yt];
  half[PRAIL.topCentre] = [0, yt];
  return closeRing(half);
}

/**
 * Stations. Listed rather than stepped, with a line on each edge of the
 * aperture — a hole in a swept surface can only be cut on grid lines.
 */
const P_FUSE_Z = [
  -7.50, -7.25, -7.00, -6.70, -6.40, -6.10, -5.80, -5.40, -5.00, -4.70,
  P_DOOR.z0, -4.05, -3.70, P_DOOR.z1, -3.05, -2.60, -2.10, -1.55, -1.00, -0.45,
  0.10, 0.40, 0.75, 1.15, 1.60, 2.10, 2.60, 3.10, 3.55, 4.10,
  4.70, 5.30, 5.90, 6.40, 6.80, 7.20, 7.65, 8.15, 8.65, 9.15,
  9.60, 10.05, 10.50,
];

/** The fuselage: one swept skin from the transom to the tip of the blade. */
function pikeFuselage() {
  const stations = P_FUSE_Z.map((z) => ({ z, pts: pikeSection(z) }));
  const s0 = P_FUSE_Z.indexOf(P_DOOR.z0), s1 = P_FUSE_Z.indexOf(P_DOOR.z1);
  if (s0 < 0 || s1 < 0) throw new Error('the aperture needs a station on each of its own edges');
  const skip = (s, r) => s >= s0 && s < s1 && r >= PRAIL.chine && r < PRAIL.deckEdge;
  const skin = sweep(stations, {
    creaseRails: [PRAIL.chine, PRAIL.deckEdge, pPortRail(PRAIL.chine), pPortRail(PRAIL.deckEdge)],
    skip,
    capAft: true,
  });
  /* The reveal, 0.22 m inboard — `SKIN`, the same plate the jamb is cut
   * through — so the doorway is a recess and not a paper edge. */
  const t = 0.22;
  const rim = { pos: [], nrm: [], uv: [], idx: [] };
  const quad = (p, q, r, s2, nx, ny, nz) => {
    const b = rim.pos.length / 3;
    for (const v of [p, q, r, s2]) {
      rim.pos.push(v[0], v[1], v[2]);
      rim.nrm.push(nx, ny, nz);
      rim.uv.push(v[2] / TILE, v[1] / TILE);
    }
    rim.idx.push(b, b + 1, b + 2, b, b + 2, b + 3);
  };
  const edge = (s, r) => {
    const p = stations[s].pts[r];
    return [p[0], p[1], stations[s].z];
  };
  const inb = (v) => [v[0] - t, v[1], v[2]];
  for (let s = s0; s < s1; s++) {
    const a = edge(s, PRAIL.chine), b = edge(s + 1, PRAIL.chine);
    quad(inb(a), inb(b), b, a, 0, -1, 0);
    const c = edge(s, PRAIL.deckEdge), d = edge(s + 1, PRAIL.deckEdge);
    quad(c, d, inb(d), inb(c), 0, 1, 0);
  }
  for (const [s, sign] of [[s0, -1], [s1, 1]]) {
    const a = edge(s, PRAIL.chine), b = edge(s, PRAIL.deckEdge);
    if (sign < 0) quad(a, b, inb(b), inb(a), 0, 0, 1);
    else quad(inb(a), inb(b), b, a, 0, 0, -1);
  }
  return join(skin, rim);
}

/* ------------------------------------------------------------------ */
/* The dorsal: gun fairing -> canopy rake -> spine -> fin root         */
/* ------------------------------------------------------------------ */

/**
 * The dorsal's crown. 4.46 from z -4.20 to 0.20 is `PIKE.upper.y1`, which the
 * spine slab caps to 4.60; forward of it the line rakes DOWN to the gun
 * fairing at a measured 28.4 degrees over 3.4 m, and the glazing lies on the
 * bottom of that rake. Aft of -4.20 it runs out into the fin root.
 */
const P_DORSAL_TOP = curve([
  [-5.95, 2.74], [-5.60, 3.24], [-5.20, 3.72], [-4.80, 4.14], [-4.50, 4.36],
  [-4.20, 4.46], [0.20, 4.46], [0.62, 4.34], [1.10, 4.10], [1.70, 3.76],
  [2.35, 3.36], [2.95, 3.02], [3.40, 2.80],
]);

/**
 * Where the dorsal's flanks stand. 1.20 over z -4.50..0.20 is climb band 2's
 * grip face and `plated(PIKE.upper)`'s own collider at 1.09; it is held
 * exactly. Forward of that it swells into the canopy shoulders.
 */
const P_DORSAL_HW = curve([
  [-5.95, 0.20], [-5.60, 0.52], [-5.20, 0.84], [-4.80, 1.08], [-4.50, 1.20],
  [0.20, 1.20], [0.62, 1.25], [1.20, 1.32], [1.90, 1.35], [2.60, 1.30],
  [3.40, 1.16],
]);

/**
 * The foot of the fairing, and 2.66 aft is a measurement rather than a guess:
 * the ledge slab occupies y 2.60..2.76, so a base ON 2.60 would ring the
 * dorsal's foot in a line visible under the plate and a base on 2.76 would
 * leave a 0.16 m gap you could see the deck through. 2.66 is inside the slab.
 */
function P_DORSAL_BASE(z) {
  /* Aft of the section deck's forward edge the fairing stands ON that plate,
   * whose top is 2.76 and whose underside is 2.60; 2.70 is inside it, so the
   * foot is buried rather than ringed by a visible line or floating 0.16 m
   * over the deck it is supposed to be welded to. Forward of the plate there
   * is no plate, so it is buried 0.06 m under the skin's own crown instead.
   *
   * Blended rather than switched, and the blend is free: {@link P_YTOP} is
   * 2.76 by z 0.95, so both expressions equal 2.70 where they meet and the
   * fairing's foot has no step in it anywhere. Tabulating this was the first
   * version and it left a 5 mm gap between two nearly-parallel surfaces over
   * 0.15 m of deck — which is not a modelling error, it is z-fighting. */
  const onPlate = PIKE_PLAN.ledgeY - 0.06;
  const onSkin = P_YTOP(z) - 0.06;
  return THREE.MathUtils.lerp(onPlate, onSkin, smooth((z - 0.20) / 0.75));
}

/** A dorsal section: a rounded crown on splayed shoulders. */
function pikeDorsalSection(z) {
  const top = P_DORSAL_TOP(z), base = P_DORSAL_BASE(z), hw = P_DORSAL_HW(z);
  const h = Math.max(0.04, top - base);
  const shoulder = Math.min(0.34, h * 0.38);
  const crownHalf = Math.max(0.02, hw - Math.min(0.38, hw * 0.34));
  const half = [
    [hw * 0.58, base],
    [hw, base],
    [hw, base + h * 0.36],
    [hw, top - shoulder],
    [THREE.MathUtils.lerp(hw, crownHalf, 0.58), top - shoulder * 0.24],
    [crownHalf, top],
    [crownHalf * 0.5, top],
    [0, top],
  ];
  const ring = half.map((p) => [p[0], p[1]]);
  for (let i = half.length - 2; i >= 0; i--) ring.push([-half[i][0], half[i][1]]);
  return ring;
}

const P_DORSAL_Z = [
  -5.95, -5.70, -5.40, -5.10, -4.80, -4.50, -4.15, -3.70, -3.10, -2.40,
  -1.70, -1.00, -0.40, 0.00, 0.20, 0.45, 0.75, 1.05, 1.35, 1.65,
  1.95, 2.25, 2.55, 2.85, 3.15, 3.40,
];

function pikeDorsal() {
  const stations = P_DORSAL_Z.map((z) => ({ z, pts: pikeDorsalSection(z) }));
  return sweep(stations, { creaseRails: [], capFore: true, capAft: true, tile: 2.0 });
}

/**
 * One station of a band lying on the dorsal, port to starboard. Fractional
 * rail indices, because a frame snapped to whole rails is a 0.25 m stripe of
 * trim round a window rather than a coaming.
 */
function pikeDorsalBand(z, lo, hi, out, n = 6) {
  const ring = pikeDorsalSection(z);
  const half = ring.slice(0, ring.length / 2 + 1);
  const cy = (P_DORSAL_BASE(z) + P_DORSAL_TOP(z)) / 2;
  const at = (r) => {
    const i = Math.max(0, Math.min(half.length - 2, Math.floor(r)));
    const t = Math.max(0, Math.min(1, r - i));
    return [
      THREE.MathUtils.lerp(half[i][0], half[i + 1][0], t),
      THREE.MathUtils.lerp(half[i][1], half[i + 1][1], t),
    ];
  };
  const push = ([x, y]) => {
    const dy = y - cy;
    const d = Math.hypot(x, dy) || 1;
    return [x + (x / d) * out, y + (dy / d) * out];
  };
  const star = [];
  for (let k = 0; k <= n; k++) star.push(push(at(THREE.MathUtils.lerp(lo, hi, k / n))));
  const pts = [];
  for (let i = star.length - 1; i >= 0; i--) pts.push([-star[i][0], star[i][1]]);
  pts.push(...star);
  return { z, pts };
}

/**
 * THE BLISTER, AND IT IS THE FRONT OF THE DORSAL RATHER THAN A LID ON A DECK.
 *
 * `PIKE.canopy` is `y 2.76, hw 1.35` over z 0.4..3.4 against a cockpit ceiling
 * of 2.60 — sixteen centimetres of glass lying flush in a weather deck, which
 * from the apron is not a canopy at all, it is a skylight. The brief asks for a
 * blister set low and the rake affords one for free: the glazing IS the
 * dorsal's own surface over the seat, from z 0.60 to 3.20, so the pilot sits
 * under a bubble that stands 0.74 m over the deck at its back and falls away
 * forward to nothing. Collided in `Hulls.buildPike` on the authored arm — a
 * body can step off the wing root onto this deck, and drawn-and-not-collided
 * is rule 4.
 */
const P_CANOPY = { z0: 0.60, z1: 3.20, glassOut: 0.05, frameOut: 0.02 };

function pikeCanopyBand(lo, hi, out, pad = 0, n = 6) {
  const zs = [];
  const steps = 10;
  for (let i = 0; i <= steps; i++) {
    zs.push(THREE.MathUtils.lerp(P_CANOPY.z0 - pad, P_CANOPY.z1 + pad, i / steps));
  }
  return sweep(zs.map((z) => pikeDorsalBand(z, lo, hi, out, n)),
    { creaseRails: [], closed: false, tile: 1.6 });
}

/**
 * The glazing, and it runs from the shoulder OVER the centreline rather than
 * stopping at the crown edge.
 *
 * A band that stops short leaves an opaque strip down the middle of the
 * canopy, which from three-quarters ahead — the framing this whole task was
 * set by — reads as a fairing with two windows in it rather than as a bubble.
 * `hi = 7` is `pikeDorsalSection`'s own centreline rail, so the two halves
 * meet on x 0 and the degenerate facets there are dropped by `sweep`'s own
 * zero-area guard.
 */
function pikeGlazing() {
  return pikeCanopyBand(1.95, 7, P_CANOPY.glassOut, 0, 8);
}

/** Six centimetres of coaming round its lower edge and both ends. */
function pikeCoaming() {
  return pikeCanopyBand(1.66, 7, P_CANOPY.frameOut, 0.10, 8);
}

/** The sill light down each side of the glazing, which is what sells it at 200 m. */
function pikeCanopySill() {
  const zs = [];
  for (let i = 0; i <= 6; i++) zs.push(THREE.MathUtils.lerp(P_CANOPY.z0 + 0.06, P_CANOPY.z1 - 0.06, i / 6));
  return sweep(zs.map((z) => pikeDorsalBand(z, 1.74, 1.90, P_CANOPY.frameOut + 0.012, 1)),
    { creaseRails: [], closed: false, tile: 1.0 });
}

/* ------------------------------------------------------------------ */
/* Lifting surfaces, engines and guns                                  */
/* ------------------------------------------------------------------ */

/**
 * Canonical (chord along +X, thickness along +Y, SPAN along +Z) into the hull
 * frame with the span running out to starboard.
 *
 * `sweep` sweeps along +Z and `foil` already solves this for a surface whose
 * section is symmetric about its chord — but the Pike's wing is not: its top
 * MUST be dead flat at y 2.36 because `bands[0]` mantles a body onto it, and
 * every millimetre of the taper is therefore on the underside. So the wing is
 * built with its own asymmetric section and mapped here instead.
 *
 * The map swaps X and Z, whose determinant is -1 — a reflection. That is the
 * same case `place(..., mirror)` handles and it is handled the same way:
 * normals go through the map unchanged (it is orthogonal) and every triangle's
 * winding is reversed, because a reflected solid whose winding was left alone
 * is a solid drawn inside out and culled away to nothing.
 */
function spanwise(part, rootX) {
  const out = { pos: [], nrm: [], uv: part.uv.slice(), idx: [] };
  for (let i = 0; i < part.pos.length; i += 3) {
    out.pos.push(rootX + part.pos[i + 2], part.pos[i + 1], part.pos[i]);
    out.nrm.push(part.nrm[i + 2], part.nrm[i + 1], part.nrm[i]);
  }
  for (let i = 0; i < part.idx.length; i += 3) {
    out.idx.push(part.idx[i], part.idx[i + 2], part.idx[i + 1]);
  }
  return out;
}

/** Where the wing root leaves the skin, inboard of the plan's own `x0`. */
const P_WING_ROOT_X = 1.95;

/**
 * THE WING: FLAT OVER, KNIFE UNDER, AND THAT IS A CLIMB NUMBER.
 *
 * `PIKE.wing`'s note records it — a mantle needs a top face at `normal.y >=
 * 0.7` and 1.12 m of flat inboard of the edge the hand grabbed, so all of the
 * section's taper is taken out of the underside. That is also what a lifting
 * body looks like, so nothing was given up to keep the climb.
 *
 * What the boxes could not do is the SECTION. The procedural wing is a
 * six-point polygon lofted about its span with one flat facet per segment; this
 * one carries max thickness at 25% of chord, a rounded leading edge tucked just
 * under the top plane, and a 0.11-of-thickness trailing edge, smooth-shaded
 * between named creases at the leading edge and both top corners. From the
 * apron the difference is that the underside has a highlight running down it
 * instead of four flat greys.
 *
 * The root is at x 1.95 rather than the plan's 2.20: a wing has to start
 * INSIDE the skin to look attached to it, the skin at y 2.36 stands at x 2.33
 * amidships and 2.06 at the root's own leading edge, and the compartment
 * behind it is only 1.20 m to the centreline — so 1.95 is 0.11 m inside the
 * plating at the tightest station and still 0.75 m outboard of the room.
 * `pike-assets.test.mjs` measures both clearances.
 */
function pikeWing() {
  const W = PIKE_PLAN.wing;
  const n = 7;
  const stations = [];
  const rootU = (P_WING_ROOT_X - W.x0) / (W.x1 - W.x0);   // -0.0735: outboard is +
  for (let i = 0; i <= n; i++) {
    const s = i / n;
    const u = THREE.MathUtils.lerp(rootU, 1, s);
    const lead = THREE.MathUtils.lerp(W.leadRoot, W.leadTip, u);
    const trail = THREE.MathUtils.lerp(W.trailRoot, W.trailTip, u);
    const ybot = THREE.MathUtils.lerp(W.botRoot, W.botTip, u);
    const d = W.y1 - ybot;
    const c = lead - trail;
    /* Fraction aft of the leading edge -> how much of the max thickness the
     * underside has fallen by. The knife is the last two entries. */
    const lower = [[1, 0.11], [0.75, 0.40], [0.50, 0.72], [0.25, 1.00], [0.15, 0.95], [0.05, 0.55], [0, 0.10]];
    const pts = [];
    for (const [f, k] of lower) pts.push([lead - f * c, W.y1 - k * d]);
    for (const f of [0.05, 0.30, 0.62, 1]) pts.push([lead - f * c, W.y1]);
    stations.push({ z: s * (W.x1 - P_WING_ROOT_X), pts });
  }
  /* Creases at the leading edge (6) and at both corners of the flat top
   * (7 and 10). Everything between 0 and 6 — the whole underside — is one
   * smooth patch, which is the point. */
  const panel = sweep(stations, { creaseRails: [0, 6, 7, 10], capFore: true, capAft: true, tile: 2.0 });
  return spanwise(panel, P_WING_ROOT_X);
}

/**
 * The ordnance pod under each wing, and it is INBOARD of x 4.6 for a walk:
 * the berth stair lands on the cradle top at local (5.90, 0.95) and the
 * boarding ramp foot is at (4.74, -3.9), so a body crosses under this wing at
 * x 5.2-5.9 with 0.20 m of clearance over its head. Anything hung below the
 * wing on that line is geometry the player walks through.
 */
function pikeOrdnance() {
  const zs = [-1.45, -1.15, -0.55, 0.35, 0.95, 1.30];
  const rad = curve([[-1.45, 0.10], [-1.15, 0.20], [-0.55, 0.24], [0.35, 0.24], [0.95, 0.19], [1.30, 0.07]]);
  const body = sweep(zs.map((z) => ({
    z, pts: podSection(rad(z) * 4.5, rad(z), 0, 2.6, 2.6, 14),
  })), { creaseRails: [], capFore: true, capAft: true, tile: 1.4 });
  const parts = [place(body, 3.50, 1.72, 0)];
  /* Three rails under it: the thing that says "this pod carries something". */
  for (let i = 0; i < 3; i++) {
    const rail = sweep([-1.0, -0.7, 0.5, 0.8].map((z) => ({
      z, pts: podSection(0.075, 0.075, 0, 2, 2, 8),
    })), { creaseRails: [], capFore: true, capAft: true, tile: 1.0 });
    parts.push(place(rail, 3.50 + (i - 1) * 0.62, 1.44, 0));
  }
  return join(...parts);
}

/**
 * The fin, and it is the tallest thing on this hull by 2.3 m.
 *
 * Plan numbers, new surface: `PIKE.fin` roots the chord at z -6.90..-3.40 on
 * y 4.46 and puts the tip chord at -6.50..-5.10 on 6.90, which is 35 degrees
 * of leading-edge sweep. `foil` maps a NACA section onto that span, so it has
 * a rounded leading edge, a sharp trailing edge and a thickness that falls
 * with the chord — none of which a four-point loft about its span can carry.
 */
function pikeFin() {
  const F = PIKE_PLAN.fin;
  return foil({
    root: [0, F.y0, F.z1],
    tip: [0, F.y1, F.tipZ1],
    chordRoot: F.z1 - F.z0, chordTip: F.tipZ1 - F.tipZ0,
    thickRoot: F.hw * 2, thickTip: F.hw * 0.72,
    n: 6,
  });
}

/**
 * The ventral fins, and they hang BELOW the wingtip on purpose: a winglet
 * standing on the tip is rule 3's guard rail — `Climb._probe` fires down from
 * 0.14 m inside the face it grabbed, lands on the winglet instead of the wing,
 * and the FIRST move of this hull's climb stops working. Under the wing it is
 * free, and from ahead it is what turns a flat span into a shape.
 */
function pikeVentral() {
  const V = PIKE_PLAN.ventral;
  const drop = V.y1 - V.y0;
  /* THE TIP IS DIRECTLY UNDER THE ROOT IN Z, AND THAT IS NOT A STYLE CHOICE.
   *
   * `foil` makes the chord axis perpendicular to the SPAN, which is right for
   * a wing and shears the section of anything whose span sweeps fore-and-aft:
   * with the tip 0.52 m aft of the root this fin's chord ran 23 degrees UP
   * going aft, so its trailing edge stood at y 2.67 — 0.31 m ABOVE the wing it
   * hangs under, straight through the flat top that `bands[0]` mantles onto.
   * Probing the mantle landing found it, which is why that test fires a grid
   * and not one ray. Sweep it back and the shear comes back with it; the taper
   * from a 1.8 m root chord to 1.0 m at the tip carries the shape instead. */
  return foil({
    root: [V.x, V.y1 + 0.08, V.z1],
    tip: [V.x + Math.sin(V.cant) * drop, V.y0, V.z1],
    chordRoot: V.z1 - V.z0, chordTip: (V.z1 - V.z0) * 0.55,
    thickRoot: 0.20, thickTip: 0.09,
    n: 4,
  });
}

/**
 * ONE ENGINE, AS A TUBE. Centres at x 1.05 and y 1.50 with the exit plane at
 * z -8.38 are `bell()`'s own numbers, unchanged: `ShipModel` hangs the flown
 * hull's plume off `b.nozzles`, `bell` is what records it on both arms, and a
 * throat drawn anywhere else would be an engine whose fire comes out of the
 * wrong place. What changes is that this one has an INSIDE — an outer shell
 * rolling over a lip, and a duct running forward from the exit plane to a
 * throat, drawn `dark`, so you see down it from astern.
 */
const P_POD = { cx: 1.05, cy: 1.50, z0: -8.38, z1: -6.40 };

function pikeEngine() {
  const shellZ = [P_POD.z0, -8.26, -8.05, -7.70, -7.30, -6.95, -6.65, P_POD.z1];
  const rad = curve([
    [P_POD.z0, 0.84], [-8.26, 0.86], [-8.05, 0.82], [-7.70, 0.80], [-7.30, 0.82],
    [-6.95, 0.80], [-6.65, 0.74], [P_POD.z1, 0.64],
  ]);
  const shell = sweep(shellZ.map((z) => ({
    z, pts: podSection(rad(z), rad(z), P_POD.cy, 2.6, 2.4, 18),
  })), { creaseRails: [], tile: 1.6 });

  const ductZ = [-7.05, -7.35, -7.72, -8.10, -8.30, P_POD.z0];
  const dr = curve([
    [-8.38, 0.84], [-8.30, 0.80], [-8.10, 0.70], [-7.72, 0.56], [-7.35, 0.45], [-7.05, 0.42],
  ]);
  const duct = sweep(ductZ.slice().sort((a, b) => a - b).map((z) => ({
    z, pts: podSection(dr(z), dr(z), P_POD.cy, 2.4, 2.4, 18),
  })), { creaseRails: [], capFore: true, flip: true, tile: 1.2 });

  return { shell, duct };
}

/**
 * One cannon barrel, and it is a tube with a hole down it rather than a
 * cylinder with a lit disc on the end.
 *
 * Drawn from z 7.60 forward only: `PIKE.cannon` runs from 4.60, but the skin
 * is 2.25 m to the chine at z 6.40 and the barrel is at x 0.92, so everything
 * aft of about 8.2 is inside the hull and would be triangles nobody can ever
 * see. What the player gets is 3.2 m of barrel in clear air past the nose,
 * a collar where it leaves the plating, four gas rings and a ported muzzle
 * brake with a dark throat.
 *
 * 0.13 and not the plan's 0.14: the gun bay is 0.80 m to the centreline and
 * the barrel is at 0.92, so a 0.14 m barrel's inboard face lands exactly ON
 * the room's own wall and `pike-assets.test.mjs`'s intrusion probe cannot tell
 * that from a hull drawn through a compartment. One centimetre buys the
 * assertion its margin; the COLLIDER is untouched.
 */
function pikeCannon() {
  const C = PIKE_PLAN.cannon;
  const r = 0.13;
  const zs = [7.60, 8.10, 8.30, 8.60, 9.40, 10.30, 10.90, 11.10, 11.40];
  const rad = curve([
    [7.60, r * 1.30], [8.10, r * 1.28], [8.30, r * 1.45], [8.60, r * 1.10], [9.40, r],
    [10.30, r * 0.94], [10.90, r * 0.92], [11.10, r * 1.34], [11.40, r * 1.30],
  ]);
  const barrel = sweep(zs.map((z) => ({
    z, pts: podSection(rad(z), rad(z), 0, 2.4, 2.4, 12),
  })), { creaseRails: [], tile: 1.0 });
  /* The bore: the muzzle turned inward, so the end of the gun is a hole. */
  const bore = sweep([
    { z: 10.60, pts: podSection(r * 0.44, r * 0.44, 0, 2.4, 2.4, 12) },
    { z: 11.40, pts: podSection(r * 0.48, r * 0.48, 0, 2.4, 2.4, 12) },
  ], { creaseRails: [], capAft: true, flip: true, tile: 0.8 });
  const rings = [];
  for (const z of [9.05, 9.75, 10.45]) {
    rings.push(sweep([z - 0.05, z + 0.05].map((zz) => ({
      zz, z: zz, pts: podSection(r * 1.32, r * 1.32, 0, 2.4, 2.4, 12),
    })), { creaseRails: [], tile: 0.8 }));
  }
  return {
    barrel: place(barrel, C.x, C.y, 0),
    dark: place(bore, C.x, C.y, 0),
    trim: place(join(...rings), C.x, C.y, 0),
  };
}

/* ------------------------------------------------------------------ */
/* Dressing, generated from the same section functions as the skin     */
/* ------------------------------------------------------------------ */

/** Push a section's points off the surface, radially from its own centre. */
const pikeCentre = (z) => (P_YBOT(z) + P_YTOP(z)) / 2;

/**
 * Transverse frame bands, and none of them crosses the boarding aperture —
 * `ShipBuild.apertures` exists because a ring round a hull is exactly the
 * shape of thing that used to run straight over a doorway.
 */
function pikeFrames() {
  const parts = [];
  for (const z of [-5.85, -2.35, 1.05, 4.55]) {
    const stations = [z - 0.09, z + 0.09].map((zz) => ({
      z: zz, pts: offsetPts(pikeSection(zz), pikeCentre(zz), 0.025),
    }));
    parts.push(sweep(stations, { creaseRails: [PRAIL.chine, PRAIL.deckEdge], tile: 1.2 }));
  }
  return join(...parts);
}

/**
 * THE CHINE STRAKE, and on this hull it is the whole silhouette rather than a
 * horizontal line low down.
 *
 * A band lying along the crease at max beam, 17 m of it, from the transom to
 * where the blade runs out. It is generated from `pikeSection` and pushed 0.02
 * m off the surface, so it cannot float the way a box pinned to a constant `hw`
 * would: this flank bows to 2.35 at the chine and tucks to 1.56 at the deck
 * edge, and a patch pinned to either would stand 0.8 m off its own hull.
 */
function pikeChineStrake() {
  const zs = P_FUSE_Z.filter((z) => z >= -6.90 && z <= 9.60);
  const stations = zs.map((z) => {
    const sec = pikeSection(z);
    const cy = pikeCentre(z);
    const lerpPt = (a, b, t) => [
      THREE.MathUtils.lerp(sec[a][0], sec[b][0], t),
      THREE.MathUtils.lerp(sec[a][1], sec[b][1], t),
    ];
    const band = [
      lerpPt(PRAIL.chine, PRAIL.bilge1, 0.34),
      sec[PRAIL.chine],
      lerpPt(PRAIL.chine, PRAIL.flank0, 0.26),
    ];
    return { z, pts: offsetPts(band, cy, 0.02) };
  });
  const star = sweep(stations, { creaseRails: [], closed: false, tile: 1.4 });
  return join(star, place(star, 0, 0, 0, true));
}

/**
 * The gun-bay blisters on the upper flank, z 4.20..7.00.
 *
 * The cannon are at x 0.92 and the hull is 2.25 m to the chine over them, so
 * from outside there is nothing at all to say this ship is carrying guns until
 * the barrels clear the nose at z 8.2. These are the ammunition feeds: the
 * hull's own upper flank between the chine and the deck edge, pushed 0.055 m
 * proud over 2.8 m and faired out at both ends, which is what a conformal gun
 * pack looks like and what an authored surface can do and a box cannot.
 */
function pikeGunPack() {
  const zs = [4.20, 4.50, 4.90, 5.40, 5.90, 6.40, 6.75, 7.00];
  const stations = zs.map((z) => {
    const sec = pikeSection(z);
    const cy = pikeCentre(z);
    const t = smooth(Math.min((z - 4.20) / 0.55, (7.00 - z) / 0.55));
    const band = [];
    for (let k = 0; k <= 4; k++) {
      const f = 0.10 + (k / 4) * 0.72;
      const i = f < 0.5 ? PRAIL.chine : PRAIL.flank0;
      const j = f < 0.5 ? PRAIL.flank0 : PRAIL.flank1;
      const u = f < 0.5 ? f * 2 : (f - 0.5) * 2;
      band.push([
        THREE.MathUtils.lerp(sec[i][0], sec[j][0], u),
        THREE.MathUtils.lerp(sec[i][1], sec[j][1], u),
      ]);
    }
    return { z, pts: offsetPts(band, cy, 0.055 * t) };
  });
  const star = sweep(stations, { creaseRails: [], closed: false, tile: 1.2 });
  return join(star, place(star, 0, 0, 0, true));
}

/** A band round each engine, where a real one has its accessory case. */
function pikeEngineBands() {
  const parts = [];
  for (const z of [-6.90, -7.55]) {
    const ring = sweep([z - 0.09, z + 0.09].map((zz) => ({
      zz, z: zz, pts: podSection(0.85, 0.85, P_POD.cy, 2.6, 2.4, 18),
    })), { creaseRails: [], tile: 1.0 });
    parts.push(place(ring, P_POD.cx, 0, 0), place(ring, -P_POD.cx, 0, 0, true));
  }
  return join(...parts);
}

/**
 * The lights, authored WITH the hull rather than placed against it: every one
 * of these sits on a surface this script owns and nothing else can measure.
 */
function pikeLamps() {
  const out = [];
  const slab = (w, h, d, x, y, z) => {
    const p = { pos: [], nrm: [], uv: [], idx: [] };
    const g = new THREE.BoxGeometry(w, h, d).translate(x, y, z);
    const nonIdx = g.toNonIndexed();
    const P = nonIdx.attributes.position.array, N = nonIdx.attributes.normal.array;
    for (let i = 0; i < P.length; i += 3) {
      p.pos.push(P[i], P[i + 1], P[i + 2]);
      p.nrm.push(N[i], N[i + 1], N[i + 2]);
      p.uv.push(P[i] / 1.2, P[i + 1] / 1.2);
    }
    for (let i = 0; i < p.pos.length / 3; i++) p.idx.push(i);
    g.dispose(); nonIdx.dispose();
    out.push(p);
  };
  // In the chisel at the tip of the blade.
  slab(0.14, 0.06, 0.16, 0, 1.66, 10.40);
  for (const s of [-1, 1]) {
    /* Wingtip navigation lights, UNDER the tip. On top of it they poked 0.01 m
     * through the one surface on this hull that has to be dead flat — the
     * mantle landing — and the flatness probe read 2.370 against 2.360. */
    slab(0.14, 0.07, 0.50, s * (PIKE_PLAN.wing.x1 - 0.16), 2.15, 0.28);
    // The burner ring, just inside each throat.
    const ring = sweep([
      { z: -7.86, pts: podSection(0.62, 0.62, P_POD.cy, 2.4, 2.4, 16) },
      { z: -7.62, pts: podSection(0.52, 0.52, P_POD.cy, 2.4, 2.4, 16) },
    ], { creaseRails: [], flip: true, tile: 1.0 });
    out.push(place(ring, s * P_POD.cx, 0, 0, s < 0));
    // The gun-port collar's own light, where the barrel leaves the plating.
    slab(0.06, 0.05, 0.30, s * (PIKE_PLAN.cannon.x + 0.16), PIKE_PLAN.cannon.y, 8.34);
  }
  // The strip along the spine, which is what reads at 200 m.
  slab(0.08, 0.05, 3.10, 0, 4.50, -2.10);
  // And the leading edge of the fin, which is the highest thing on the ship.
  slab(0.07, 1.90, 0.07, 0, 5.72, -4.32);
  out.push(pikeCanopySill());
  return join(...out);
}

/** Everything the Pike is made of, keyed by the material each part is drawn with. */
function pikeParts() {
  const eng = pikeEngine();
  const gun = pikeCannon();
  const wing = pikeWing();
  const vent = pikeVentral();
  const ord = pikeOrdnance();
  return [
    { key: 'hull', geo: join(pikeFuselage(), pikeDorsal()) },
    {
      key: 'accent',
      geo: join(
        wing, place(wing, 0, 0, 0, true),
        place(vent, 0, 0, 0), place(vent, 0, 0, 0, true),
        pikeFin(),
        place(gun.barrel, 0, 0, 0), place(gun.barrel, 0, 0, 0, true),
        place(eng.shell, P_POD.cx, 0, 0), place(eng.shell, -P_POD.cx, 0, 0, true),
      ),
    },
    {
      key: 'dark',
      geo: join(
        place(eng.duct, P_POD.cx, 0, 0), place(eng.duct, -P_POD.cx, 0, 0, true),
        place(gun.dark, 0, 0, 0), place(gun.dark, 0, 0, 0, true),
        ord, place(ord, 0, 0, 0, true),
      ),
    },
    { key: 'glass', geo: pikeGlazing() },
    {
      key: 'trim',
      geo: join(
        pikeCoaming(), pikeFrames(), pikeChineStrake(), pikeGunPack(), pikeEngineBands(),
        place(gun.trim, 0, 0, 0), place(gun.trim, 0, 0, 0, true),
      ),
    },
    { key: 'glow', geo: pikeLamps() },
  ];
}

/* ------------------------------------------------------------------ */
/* Assembly                                                            */
/* ------------------------------------------------------------------ */

const podParts = pod();
/** The parts of whichever hull {@link HULL_ID} named, in material-key order. */
const PARTS = HULL_ID === 'bastion' ? bastionParts()
  : HULL_ID === 'dray' ? drayParts()
    : HULL_ID === 'pike' ? pikeParts() : [
  { key: 'hull', geo: join(fuselage(), dorsal()) },
  {
    key: 'accent',
    geo: join(
      place(podParts.shell, POD.cx, 0, 0), place(podParts.shell, -POD.cx, 0, 0, true),
      place(wing(), 0, 0, 0), place(wing(), 0, 0, 0, true),
      place(fin(), 0, 0, 0), place(fin(), 0, 0, 0, true),
      dorsalFin(),
    ),
  },
  {
    key: 'dark',
    geo: join(place(podParts.duct, POD.cx, 0, 0), place(podParts.duct, -POD.cx, 0, 0, true)),
  },
  { key: 'glass', geo: glazing() },
  { key: 'trim', geo: join(coaming(), frameRings(), chineStrake(), podBands()) },
  { key: 'glow', geo: lamps() },
];

/* ------------------------------------------------------------------ */
/* Minimal binary glTF 2.0 writer — one mesh per material key          */
/* ------------------------------------------------------------------ */

const bins = [];
const bufferViews = [];
const accessors = [];
let binOffset = 0;
const pad4 = (n) => (Math.ceil(n / 4) * 4) - n;

function push(typedArray, { itemSize, componentType, type, target, withMinMax }) {
  const bytes = Buffer.from(typedArray.buffer, typedArray.byteOffset, typedArray.byteLength);
  bufferViews.push({ buffer: 0, byteOffset: binOffset, byteLength: bytes.length, target });
  const count = typedArray.length / itemSize;
  const acc = { bufferView: bufferViews.length - 1, componentType, count, type };
  if (withMinMax) {
    const min = new Array(itemSize).fill(Infinity), max = new Array(itemSize).fill(-Infinity);
    for (let i = 0; i < count; i++) {
      for (let c = 0; c < itemSize; c++) {
        const v = typedArray[i * itemSize + c];
        if (v < min[c]) min[c] = v;
        if (v > max[c]) max[c] = v;
      }
    }
    acc.min = min; acc.max = max;
  }
  accessors.push(acc);
  bins.push(bytes);
  const p = pad4(bytes.length);
  if (p) bins.push(Buffer.alloc(p));
  binOffset += bytes.length + p;
  return accessors.length - 1;
}

const ARRAY_BUFFER = 34962, ELEMENT_ARRAY_BUFFER = 34963;
const FLOAT = 5126, UNSIGNED_SHORT = 5123, UNSIGNED_INT = 5125;

const meshes = [], nodes = [], materials = [];
let totalTris = 0, totalVerts = 0;
const report = [];

PARTS.forEach((part, i) => {
  const g = part.geo;
  const verts = g.pos.length / 3;
  const tris = g.idx.length / 3;
  if (!tris) throw new Error(`part '${part.key}' is empty`);
  /* THE NaN GATE, AND IT HAS ALREADY EARNED ITS KEEP.
   *
   * The first build of this hull shipped 148 NaN texture coordinates from a
   * patch that wrapped past the end of its own arc-length table, and the game
   * rendered a white screen with a ship-shaped hole in it - `UnrealBloomPass`
   * smearing one bad texel over the whole frame, exactly as `ShipBuild._tile`
   * warns. A .glb is data: nothing downstream re-checks it, so it is checked
   * HERE, where the fix is one line and the failure is a build error. */
  for (const [name, arr] of [['position', g.pos], ['normal', g.nrm], ['uv', g.uv]]) {
    for (let k = 0; k < arr.length; k++) {
      if (!Number.isFinite(arr[k])) {
        throw new Error(`part '${part.key}' has a non-finite ${name} at index ${k} - a NaN uv blooms over the whole frame`);
      }
    }
  }
  totalTris += tris; totalVerts += verts;
  /* Per-part bounds in the printout, because two of this file's three real
   * bugs were parts that built but built WRONG — a fairing 0.02 m tall, a fin
   * with no span — and both were obvious the moment the numbers were beside
   * the triangle counts and invisible while they were not. */
  const bb = [Infinity, -Infinity, Infinity, -Infinity, Infinity, -Infinity];
  for (let k = 0; k < g.pos.length; k += 3) {
    for (let a = 0; a < 3; a++) {
      bb[a * 2] = Math.min(bb[a * 2], g.pos[k + a]);
      bb[a * 2 + 1] = Math.max(bb[a * 2 + 1], g.pos[k + a]);
    }
  }
  report.push({ key: part.key, verts, tris, bb });
  const posAcc = push(new Float32Array(g.pos), { itemSize: 3, componentType: FLOAT, type: 'VEC3', target: ARRAY_BUFFER, withMinMax: true });
  const norAcc = push(new Float32Array(g.nrm), { itemSize: 3, componentType: FLOAT, type: 'VEC3', target: ARRAY_BUFFER });
  const uvAcc = push(new Float32Array(g.uv), { itemSize: 2, componentType: FLOAT, type: 'VEC2', target: ARRAY_BUFFER });
  /* 16-bit indices while a part fits in them, which every part of this hull
   * does by an order of magnitude — 32-bit throughout cost 30 KB of the file
   * for nothing. The wide path stays, because a later hull may not fit. */
  const wide = verts > 65535;
  const idxAcc = push(wide ? new Uint32Array(g.idx) : new Uint16Array(g.idx),
    { itemSize: 1, componentType: wide ? UNSIGNED_INT : UNSIGNED_SHORT, type: 'SCALAR', target: ELEMENT_ARRAY_BUFFER });
  materials.push({
    name: `${HULL_ID}-${part.key}-placeholder`,
    pbrMetallicRoughness: {
      baseColorFactor: part.key === 'glass' ? [0.16, 0.24, 0.32, 1]
        : part.key === 'glow' ? [0.29, 0.85, 1.0, 1]
          : part.key === 'dark' ? [0.09, 0.10, 0.11, 1] : [0.53, 0.58, 0.64, 1],
      metallicFactor: 0.1, roughnessFactor: 0.65,
    },
  });
  meshes.push({
    /* THE MESH NAME IS THE CONTRACT. `ShipAssets.js` reads the material key
     * off it and draws the part with the yard's own cached material of that
     * name; the glTF material beside it is discarded unread, so an authored
     * hull costs no shader program. See the loader's own note. */
    name: part.key,
    primitives: [{ attributes: { POSITION: posAcc, NORMAL: norAcc, TEXCOORD_0: uvAcc }, indices: idxAcc, mode: 4, material: i }],
  });
  nodes.push({ mesh: i, name: part.key });
});

const json = {
  asset: {
    version: '2.0',
    generator: 'aether-nexus scripts/make-ship-glb.mjs',
    copyright: 'generated - procedurally authored in this repository, no external source',
  },
  scene: 0,
  scenes: [{ nodes: nodes.map((_, i) => i) }],
  nodes,
  meshes,
  materials,
  buffers: [{ byteLength: binOffset }],
  bufferViews,
  accessors,
};

let jsonBytes = Buffer.from(JSON.stringify(json), 'utf8');
if (jsonBytes.length % 4) jsonBytes = Buffer.concat([jsonBytes, Buffer.alloc(4 - (jsonBytes.length % 4), 0x20)]);
const binBytes = Buffer.concat(bins);

const header = Buffer.alloc(12);
header.writeUInt32LE(0x46546c67, 0);
header.writeUInt32LE(2, 4);
header.writeUInt32LE(12 + 8 + jsonBytes.length + 8 + binBytes.length, 8);
const jsonHeader = Buffer.alloc(8);
jsonHeader.writeUInt32LE(jsonBytes.length, 0);
jsonHeader.writeUInt32LE(0x4e4f534a, 4);
const binHeader = Buffer.alloc(8);
binHeader.writeUInt32LE(binBytes.length, 0);
binHeader.writeUInt32LE(0x004e4942, 4);

mkdirSync(path.dirname(OUT), { recursive: true });
const glb = Buffer.concat([header, jsonHeader, jsonBytes, binHeader, binBytes]);
writeFileSync(OUT, glb);

/* The measurements this file is allowed to put in a comment: taken here, on
 * the geometry that was just written, printed every run. */
let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity, minZ = Infinity, maxZ = -Infinity;
for (const p of PARTS) {
  for (let i = 0; i < p.geo.pos.length; i += 3) {
    minX = Math.min(minX, p.geo.pos[i]); maxX = Math.max(maxX, p.geo.pos[i]);
    minY = Math.min(minY, p.geo.pos[i + 1]); maxY = Math.max(maxY, p.geo.pos[i + 1]);
    minZ = Math.min(minZ, p.geo.pos[i + 2]); maxZ = Math.max(maxZ, p.geo.pos[i + 2]);
  }
}
console.log(OUT);
for (const r of report) {
  const f = (v) => v.toFixed(2).padStart(6);
  console.log(`  ${r.key.padEnd(7)} ${String(r.verts).padStart(5)} verts  ${String(r.tris).padStart(5)} tris`
    + `   x${f(r.bb[0])}..${f(r.bb[1])}  y${f(r.bb[2])}..${f(r.bb[3])}  z${f(r.bb[4])}..${f(r.bb[5])}`);
}
console.log(`  ${'TOTAL'.padEnd(7)} ${String(totalVerts).padStart(5)} verts  ${String(totalTris).padStart(5)} tris  ${glb.length} bytes`);
console.log(`  bounds  x ${minX.toFixed(2)}..${maxX.toFixed(2)}  y ${minY.toFixed(2)}..${maxY.toFixed(2)}  z ${minZ.toFixed(2)}..${maxZ.toFixed(2)}`);
