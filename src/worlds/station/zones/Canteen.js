import * as THREE from 'three';
import { boxGeo, cylGeo, instanced, seamLift } from '../StationKit.js';
import { buildZoneTower } from '../Tower.js';

/**
 * THE LONG GALLEY - the station's canteen, on avenue 300.
 *
 * ── What this zone is for ─────────────────────────────────────────────────
 * The residential district feeds into this corridor, so the zone on the end of
 * it is where the people who live in those flats eat. That gives it the one
 * thing a 200 m disc of deck is otherwise very bad at having: a reason for
 * several hundred people to be in the same place at the same time doing
 * legible, different things. Everything below is arranged around making that
 * crowd readable rather than around making the architecture interesting - the
 * architecture is here to give the crowd somewhere to stand.
 *
 * ── The plan ──────────────────────────────────────────────────────────────
 * The section is fixed by `OuterRing.buildZone`: an open court under the dome
 * inside r=112, a covered arcade with a 30 m ceiling from there to the rim.
 * Both are dining floor. The named things sit in the sectors that are not:
 *
 *      bearing        radius        what
 *      ---------      ----------    ----------------------------------------
 *       -16..16       all           arrival plaza and the walk in - kept clear
 *       141..217      116..194      THE SERVERY, its queues and back of house
 *       211..233      132..170      Galley Provisions
 *        66..116      150..184      the mezzanine, over the dining below it
 *        18..342       37..47       THE ISLAND - eight counters facing outward
 *         0..360        0..31       the garden court and the grow tower
 *      everywhere    else           tables
 *
 * That last line is the whole zone. Eighteen ranks of group tables - ten round
 * the arcade, eight round the court - fill every square metre the grid below
 * does not reserve for a corridor, a spoke or one of the named sectors above.
 * A canteen is not a room with tables in it, it is a room made OF tables, and
 * a 113,000 m2 deck dressed with six hundred props reads as an empty hangar
 * no matter how good the six hundred are.
 *
 * The hero servery is deliberately on the far side of the deck from the link
 * mouth. A player arriving at the plaza is looking down 350 m of dining floor
 * at a 126 m lit counter with steam coming off it, which is the single frame
 * this zone exists to produce; putting the counter beside the entrance would
 * have given them a queue to look at instead. The island in the court is the
 * other half of that answer - it is what the walk down the processional passes
 * through, and it carries the seven things the one counter does not serve.
 *
 * ── Two conventions that are easy to get backwards ────────────────────────
 * Everything here is placed on a BEARING in degrees, measured from the link
 * mouth (local +Z, toward the hub) and increasing toward local +X, and a RADIUS
 * from the zone centre. `at()` turns that pair into (lx, lz) and `at3()` into
 * the (lx, ly, lz) triple every ZoneContext call actually wants.
 *
 * The trap is that geometry and people read the same yaw in opposite
 * directions. A box placed with `localYaw = A(deg)` has its local +X running
 * along the arc and its local +Z pointing OUT toward the rim - so `ctx.box`
 * takes its tangential size as `w` and its radial size as `d`, which is what
 * makes a counter follow the arcade instead of cutting across it. An ACTOR
 * given that same yaw faces the other way, IN toward the middle of the zone,
 * because a figure faces its own local -Z (see `StationActors._poseActor`).
 * Both are used constantly, so they have separate names: `A()` for geometry,
 * `faceIn()` / `faceOut()` / `faceTo()` for people.
 *
 * ── Collision is no longer entirely manual out here ───────────────────────
 * This used to read "not one triangle and not one instance in this file is
 * collided automatically", because both sweeps stopped at `DECK_R` and this
 * deck is 498 m out. Neither does any more: `_solidifyProps` has swept the
 * whole map since the ring was built, and `_collisionSoup` reaches the zones
 * through `collideCeilingAt`. What this file draws is solid because it drew it.
 *
 * The `ctx.solid` calls stay, and are still the rule for anything a player
 * stands on or shelters under - a derived collider is a shell around what was
 * drawn, and it cannot know that the inside of a servery is meant to be
 * hollow. But they are a floor under the automatic passes now rather than the
 * only collision in the zone, and a prop that has one keeps exactly the
 * collider its author chose. See `StationWorld._alreadySolid`.
 */

const DEG = Math.PI / 180;
const TAU = Math.PI * 2;

/* ------------------------------------------------------------------ */
/* Where everything is                                                 */
/* ------------------------------------------------------------------ */

/** Inner edge of the covered arcade. Inside this the roof is the dome. */
const COURT_R = 112;
/** Ceiling plate over the arcade, and the perimeter wall that meets it. */
const ARCADE_CEIL = 30;
/**
 * Working head height under the arcade.
 *
 * The radial trusses hang to 27.55 and the lit troughs on every third one to
 * 26.9, so this is the last height anything can occupy without a duct run
 * growing through a light fitting. The extraction risers are the only thing
 * in the zone that gets near it.
 */
const ARCADE_HEAD = ARCADE_CEIL - 4;
/** Outermost radius anything may occupy. The perimeter wall stands at 202. */
const BUILD_R = 194;

/* The counter run. 46 degrees at r=157 is 126 m of servery, which is where the
 * zone's name came from and is long enough that its far end is genuinely far. */
const SERVERY_A0 = 157, SERVERY_A1 = 203;
const SERVERY_R = 157;
/** Counter face, back gantry, extract hood and service catwalk, off one line. */
const SERVERY_FRONT = SERVERY_R - 0.85;
const SERVERY_BACK = SERVERY_R + 3.6;
const HOOD_R = SERVERY_R + 1.9;
const CATWALK_R = SERVERY_R + 6.4;
const CATWALK_Y = 6.2;
/** Where the catwalk stair lands, and therefore where its handrail is cut. */
const CATWALK_STAIR_A = 206.6;

/** Back of house: everything behind the servery, out to the perimeter. */
const BOH_A0 = 151, BOH_A1 = 211;
const BOH_WALL_R = 168;
/** The walk-in store, and the flight of steps up its flank. */
const STORE_A = 200, STORE_R = 182;

/** The order-point row, standing clear in front of the counter. */
const KIOSK_R = 138;
const KIOSK_BEARINGS = [164, 172, 180, 188, 196];

/** The mezzanine of booths, on the east flank. */
const MEZZ_A0 = 66, MEZZ_A1 = 116;
const MEZZ_R0 = 150, MEZZ_R1 = 184;
const MEZZ_Y = 4.6;
/**
 * Bearings the two mezzanine stairs come down on.
 *
 * They land at r=138.5, which is exactly where the four-top ring runs, so the
 * dining spans below are cut around them rather than the other way about - a
 * table under a stair is worse than a gap in a row.
 */
const MEZZ_STAIRS = [MEZZ_A0 + 2, MEZZ_A1 - 2];

/** Galley Provisions - the merchant's stall, off the end of the servery. */
const STALL_A = 222, STALL_R = 150;

/** Seat heights. These are passed to `ctx.actor` as `amount`, never guessed. */
const SEAT = 0.45;        // dining chair and refectory bench
const BOOTH_SEAT = 0.46;  // mezzanine booth
const STOOL_SEAT = 0.70;  // window bar

/* ------------------------------------------------------------------ *
 * The hall grid                                                       *
 * ------------------------------------------------------------------ *
 *
 * A mess hall is not a scatter of tables, it is a GRID of them with aisles
 * between, and the aisles are what has to be authored first. So the whole deck
 * is cut into concentric bands: alternating rings of clear deck a player can
 * always walk on, and rings of dining that are then filled solid.
 *
 *      116.5 - 121.5   promenade ring        the walk round the court edge
 *      121.5 - 148.0   dining band 1         five ranks, 5.4 m apart
 *      148.0 - 153.0   mid ring corridor
 *      153.0 - 179.0   dining band 2         five more, under the mezzanine
 *      179.0 - 184.0   outer ring corridor
 *      184.0 - 193.0   window band           the bars and the quiet gallery
 *
 * and in the court, inside the dome:
 *
 *      31 - 36         clear, round the planting ring
 *      37 - 47         THE ISLAND - eight counters facing outward
 *      47 - 53         its queue apron
 *      53 - 80         court dining, five rings
 *      80 - 85         court ring corridor
 *      85 - 101        court dining, three more rings
 *      101 - 116       the saplings and the clear rim
 *
 * Both sets are cut by eleven radial spokes on the 30 degree bearings, each
 * 6.8 m wide - the twelfth is the arrival funnel, which is 32 degrees of clear
 * deck all on its own. So no player is ever more than fifteen degrees of arc
 * from a route straight out to the rim. The rings and the spokes together are
 * the circulation; everything else in this file fills what is left.
 *
 * The corridors are deliberately NOT paved. The warm plate stops at the edge
 * of every band and the bare deck runs through, which is what tells a player
 * which of two identically furnished-looking strips is the one to walk down.
 */
const PROM_R = 119.0;
const BAND1_ROWS = [124.8, 130.2, 135.6, 141.0, 146.4];
const MID_R = 150.5;
const BAND2_ROWS = [156.0, 161.4, 166.8, 172.2, 177.6];
const OUT_R = 181.5;

const ISLAND_R = 42;
const COURT_ROWS_IN = [55.5, 60.9, 66.3, 71.7, 77.1];
const COURT_MID_R = 82.5;
const COURT_ROWS_OUT = [87.5, 92.9, 98.3];

/** Bearings of the radial spokes, and the half-width each one is kept clear. */
const SPOKES = [30, 60, 90, 120, 150, 180, 210, 240, 270, 300, 330];
const SPOKE_HALF = 3.4;

/**
 * Where furniture may not go, as (bearing0, bearing1, radius0, radius1).
 *
 * Authored as polar rectangles rather than as gaps in each row's bearing list
 * because the same hole has to be respected by nine different fillers - the
 * ranks, the round tables, the dividers, the bins, the totems - and nine
 * copies of "except between 141 and 217" is nine chances to get one wrong.
 */
const KEEPOUT = [
  // The arrival funnel: the plaza, the 8 m in front of it, and the whole walk
  // across the court to the tower. Nothing stands in the frame you arrive on.
  [344, 16, 0, 200],
  // The servery, its order points, its queues and the entire back of house.
  [141, 217, 116, 200],
  // Galley Provisions, and the room a customer needs to stand and be served.
  [211, 233, 132, 170],
  // Where the two mezzanine stairs land on the dining floor.
  [60, 76, 128, 154],
  [106, 122, 128, 154],
  /* The refectory block. See `buildRefectoryBlock` for why it stands where it
   * does; this row is what makes the nine fillers flow round it instead of
   * laying five rings of dining tables through a building. */
  [244, 266, 50, 84],
];

/* ------------------------------------------------------------------ */
/* The frame                                                           */
/* ------------------------------------------------------------------ */

/** Geometry yaw for a bearing: local +X along the arc, local +Z out to the rim. */
const A = (deg) => deg * DEG;

/**
 * Zone-local [lx, lz] `rad` metres out on `deg`, then `tan` metres along the
 * arc in the direction of increasing bearing.
 *
 * The tangential term is what lets a bay be authored once and then have its
 * splashback, its tray rail and the figure behind it placed relative to it
 * without four more lines of trigonometry each time.
 */
function at(deg, rad, tan = 0) {
  const t = deg * DEG, c = Math.cos(t), s = Math.sin(t);
  // The radial unit is (sin, cos); the tangent is its derivative, (cos, -sin).
  return [s * rad + c * tan, c * rad - s * tan];
}

/**
 * The same point as an (lx, ly, lz) triple.
 *
 * Nearly every call on the ZoneContext takes three coordinates in that order -
 * `box`, `put`, `solid`, `sign`, `actor`, `relic`, `roof`, `P` - so this is the
 * form that spreads straight into them. Spreading the two-element `at()` into
 * one of those is silently wrong in the worst possible way: it lands `lz` in
 * the `ly` slot and buries the prop in the deck.
 */
function at3(deg, rad, y, tan = 0) {
  const p = at(deg, rad, tan);
  return [p[0], y, p[1]];
}

/** Offset from a prop's own origin, in the frame `ctx.box(..., yaw)` places it. */
function off(lx, lz, yaw, ox, oz) {
  const c = Math.cos(yaw), s = Math.sin(yaw);
  return [lx + ox * c + oz * s, lz - ox * s + oz * c];
}

/** Actor yaw: face the middle of the zone from `deg`. */
const faceIn = (deg) => deg * DEG;
/** Actor yaw: face the perimeter from `deg`. */
const faceOut = (deg) => deg * DEG + Math.PI;
/** Actor yaw: look from (lx, lz) at (tx, tz). Solves (-sin, -cos) = target-me. */
const faceTo = (lx, lz, tx, tz) => Math.atan2(lx - tx, lz - tz);

/**
 * Walk an arc at `radius`, calling `fn(deg, i, n)` once every `pitch` metres.
 *
 * Every run in this file - counter bays, wall panels, table rows, balustrade
 * posts - is spaced in METRES and converted to degrees here, rather than being
 * given a step in degrees directly. A 6 m rhythm at r=157 and the same 6 m
 * rhythm at r=124 are different angles, and authoring the angle instead is how
 * a furniture row ends up twice as dense at one radius as at another.
 */
function arcRun(deg0, deg1, radius, pitch, fn) {
  const n = Math.max(1, Math.round(((deg1 - deg0) * DEG * radius) / pitch));
  const step = (deg1 - deg0) / n;
  for (let i = 0; i < n; i++) fn(deg0 + step * (i + 0.5), i, n);
  return n;
}

/** Bearing folded into [0, 360). */
const norm = (deg) => ((deg % 360) + 360) % 360;
/** Signed shortest angle from `b` to `a`, in degrees. */
function dAng(a, b) {
  let d = norm(a - b);
  if (d > 180) d -= 360;
  return d;
}
/** True if `deg` lies in the arc from `b0` round to `b1`, wrapping if it must. */
function inArc(deg, b0, b1) {
  const d = norm(deg), a = norm(b0), b = norm(b1);
  return a <= b ? d >= a && d <= b : d >= a || d <= b;
}

/**
 * True if a polar point is inside a keep-out or standing in a spoke.
 *
 * Every filler in the hall asks this before it places anything, which is the
 * whole reason the circulation survives contact with nine independent passes
 * of furniture. `pad` widens the spoke for wide props - a 12 m refectory table
 * whose CENTRE is 4 m off a spoke still lies across it.
 */
function blocked(deg, rad, pad = 0) {
  for (const [b0, b1, r0, r1] of KEEPOUT) {
    if (rad >= r0 && rad <= r1 && inArc(deg, b0, b1)) return true;
  }
  for (const s of SPOKES) {
    if (Math.abs(dAng(deg, s)) * DEG * rad < SPOKE_HALF + pad) return true;
  }
  return false;
}

/**
 * Walk a whole ring at `pitch` metres, skipping the keep-outs and the spokes.
 *
 * `pad` is half the tangential size of whatever is being placed, so a rank is
 * rejected when any part of it would cross a spoke rather than when its middle
 * would. Returns how many were actually placed, which is what the callers use
 * to keep their own counts honest.
 */
function ringFill(ctx, rad, pitch, pad, fn) {
  let placed = 0;
  arcRun(0, 360, rad, pitch, (d, i) => {
    if (blocked(d, rad, pad)) return;
    const c = at(d, rad);
    if (!ctx.onDeck(c[0], c[1], 7)) return;
    fn(d, i, placed++);
  });
  return placed;
}

/* ------------------------------------------------------------------ */
/* The furniture kit                                                   */
/* ------------------------------------------------------------------ */

/**
 * Instance lists, one per part, plus the two counters the population needs.
 *
 * Chairs, tables, trays and planting are the only things in this zone there
 * are hundreds of, and merged geometry is the wrong home for all of them: 200
 * chairs merged is 200 chairs of vertices sitting in the zone's single buffer
 * whether or not any of them is on screen, where 200 instances is one 36
 * triangle chair uploaded once. Anything with fewer than about fifteen copies
 * goes through `ctx.box` instead, which costs nothing extra per copy and keeps
 * its texel density.
 */
function newKit() {
  return {
    chairPost: [], chairSeat: [], chairBack: [],
    stool: [],
    roundTop: [], tablePost: [], squareTop: [],
    benchTop: [], benchLeg: [],
    boothSeat: [], boothBack: [], boothTop: [],
    tray: [], mug: [], crate: [], leaf: [], puff: [], marker: [],
    pendantShade: [], pendantBulb: [],

    /* The group-table kit.
     *
     * Everything the brief asks for in quantity - the refectory ranks, the
     * round eights, the high tables, and the whole service layer of caddies,
     * bins, rails and totems - lives here rather than in `ctx.box`, because
     * there are between forty and seven hundred of each and a merged copy of
     * every one of them is the fastest way to spend a zone's entire triangle
     * budget on furniture nobody is looking at. */
    refTop: [], refLeg: [], refRail: [],
    bigTop: [], midTop: [], bigPost: [],
    highTop: [], highPost: [],
    caddy: [], cutlery: [], napkin: [],
    binDrum: [], binLid: [], fountain: [],
    totem: [], totemLit: [],
    qPost: [], qBelt: [],
    trolley: [], trolleyShelf: [], highChair: [],
    screen: [], coatRail: [],
    tubLong: [], tubCap: [],
    urn: [], cupStack: [],

    /* Golden-angle phase walk.
     *
     * Two figures at one table sharing a phase gesture in unison, which reads
     * distinctly worse than two statues - the eye forgives stillness and does
     * not forgive synchronised twitching. 2.3999 rad is the golden angle, so
     * consecutive draws are as far apart as a sequence can put them and the
     * pattern does not come back round on a table of six or a queue of eight. */
    _ph: 0,
    phase() { this._ph = (this._ph + 2.3999) % TAU; return this._ph; },

    /** Running population count, so the build can report what it staffed. */
    people: 0,
  };
}

/** Push an instance in the zone frame. `instanced()` wants world space. */
function inst(ctx, list, lx, ly, lz, localYaw = 0, sx = 1, sy = 1, sz = 1) {
  const p = ctx.P(lx, ly, lz);
  list.push([p.x, p.y, p.z, 0, ctx.yawOf(localYaw), 0, sx, sy, sz]);
}

/**
 * A canteen chair. `yaw` is the direction the SITTER faces, so the same number
 * goes to the chair and to the actor on it and the back can never end up in
 * somebody's lap.
 */
function chair(ctx, K, lx, lz, floor, yaw) {
  inst(ctx, K.chairPost, lx, floor + 0.22, lz, yaw);
  inst(ctx, K.chairSeat, lx, floor + 0.42, lz, yaw);
  const b = off(lx, lz, yaw, 0, 0.22);
  inst(ctx, K.chairBack, b[0], floor + 0.70, b[1], yaw);
}

/** A round two-top. The collider is the top only - chairs stand outside it. */
function twoTop(ctx, K, lx, lz, yaw) {
  inst(ctx, K.tablePost, lx, 0.35, lz, yaw);
  inst(ctx, K.roundTop, lx, 0.735, lz, yaw);
  ctx.solid(lx, 0.55, lz, 0.46, 0.22, 0.46, yaw);
  ctx.contact(lx, lz, 2.4);
}

/** A square four-top. */
function fourTop(ctx, K, lx, lz, yaw) {
  inst(ctx, K.tablePost, lx, 0.35, lz, yaw);
  inst(ctx, K.squareTop, lx, 0.74, lz, yaw);
  ctx.solid(lx, 0.56, lz, 0.68, 0.22, 0.68, yaw);
  ctx.contact(lx, lz, 3.2);
}

/** A 4.4 m bench unit, seat top at 0.45 above `floor`. */
function bench(ctx, K, lx, lz, floor, yaw) {
  inst(ctx, K.benchTop, lx, floor + 0.41, lz, yaw);
  for (const s of [-1.7, 1.7]) {
    const g = off(lx, lz, yaw, s, 0);
    inst(ctx, K.benchLeg, g[0], floor + 0.185, g[1], yaw);
  }
  ctx.solid(lx, floor + 0.33, lz, 2.2, 0.12, 0.21, yaw);
}

/** The length the refectory top and the bench top are modelled at. */
const REF_LEN = 10, BENCH_LEN = 4.4;

/**
 * A bench of any length, from the one 4.4 m prototype.
 *
 * Scaled rather than repeated: a rank of twelve wants one continuous bench per
 * side, and three abutting 4.4 m copies is three colliders, three instances and
 * two visible seams to buy exactly the same object.
 */
function longBench(ctx, K, lx, lz, floor, yaw, len) {
  inst(ctx, K.benchTop, lx, floor + 0.41, lz, yaw, len / BENCH_LEN, 1, 1);
  for (const s of [-1, 1]) {
    const g = off(lx, lz, yaw, s * (len / 2 - 0.75), 0);
    inst(ctx, K.benchLeg, g[0], floor + 0.185, g[1], yaw);
  }
  // Top face at floor + 0.45, which is SEAT, which is what the sitters are given.
  ctx.solid(lx, floor + 0.33, lz, len / 2, 0.12, 0.21, yaw);
}

/**
 * ONE RANK OF THE LONG GALLEY.
 *
 * A refectory table `len` metres along the arc with a continuous bench down
 * each side, the covers laid on it, and however many of them are being eaten
 * from. This is the module the hall is mostly made of: everything else in the
 * zone is either a variation on it, something that serves it, or the route
 * between two of them.
 *
 * Seats are spaced at 1.55 m, which is the pitch that puts twelve people on a
 * ten metre table and lets each of them have an elbow. `occ` is the chance the
 * rank is in use at all - a hall where every table has two people at it looks
 * like a seating plan, where a hall with a third of its tables busy and the
 * rest cleared looks like the back half of a lunch service.
 */
function refectoryRank(ctx, K, deg, rad, len, occ) {
  const yaw = A(deg);
  const c = at(deg, rad);
  const half = len / 2;

  inst(ctx, K.refTop, c[0], 0.735, c[1], yaw, len / REF_LEN, 1, 1);
  for (const s of [-1, 1]) {
    const t = at(deg, rad, s * (half - 1.15));
    inst(ctx, K.refLeg, t[0], 0.36, t[1], yaw);
  }
  ctx.solid(c[0], 0.62, c[1], half, 0.14, 0.62, yaw);
  /* One patch, sized to the rank's DEPTH rather than its length.
   *
   * `_contact` only makes squares, and the obvious call - one square as long
   * as the table - puts a 12 m blob under a 3.4 m wide object. Seven hundred
   * of those is ninety thousand square metres of multiply-blended decal on a
   * hundred-and-thirteen thousand square metre deck, which stops being contact
   * occlusion and becomes a tint over the entire floor. A patch the width of
   * the rank grounds the middle of it, which is the part the eye checks. */
  ctx.contact(c[0], c[1], 5.0);

  // A condiment caddy and a cutlery stand every four metres down the middle.
  const nCad = Math.max(2, Math.round(len / 4));
  for (let i = 0; i < nCad; i++) {
    const t = -half + 1.2 + (i * (len - 2.4)) / (nCad - 1);
    inst(ctx, K.caddy, ...at3(deg, rad + 0.12, 0.88, t), yaw, 1, 1, 1);
    if (i % 2 === 1) inst(ctx, K.cutlery, ...at3(deg, rad - 0.2, 0.90, t + 0.5), yaw);
    else inst(ctx, K.napkin, ...at3(deg, rad - 0.24, 0.86, t + 0.45), yaw);
  }

  const nSeat = Math.max(3, Math.round(len / 1.55));
  let taken = 0;
  for (const side of [-1, 1]) {
    const look = side > 0 ? faceIn(deg) : faceOut(deg);
    const br = rad + side * 1.06;
    longBench(ctx, K, ...at(deg, br), 0, look, len);
    if (ctx.rng() > occ) continue;
    // A run of neighbours rather than a scatter: people who eat together sit
    // together, and a table with one figure at each end reads as two strangers.
    const run = 1 + Math.floor(ctx.rng() * 3);
    const from = Math.floor(ctx.rng() * Math.max(1, nSeat - run));
    for (let i = from; i < Math.min(nSeat, from + run); i++) {
      const t = -half + 0.9 + (i * (len - 1.8)) / (nSeat - 1);
      const p = at(deg, br, t);
      seat(ctx, K, p[0], p[1], 0, look, SEAT);
      const l = at(deg, rad + side * 0.42, t);
      inst(ctx, K.tray, l[0], 0.80, l[1], look);
      if (ctx.rng() > 0.4) inst(ctx, K.mug, l[0] + 0.16, 0.84, l[1] + 0.1, ctx.rng() * TAU);
      taken++;
    }
  }
  return taken;
}

/**
 * A round group table for six or eight, with its chairs round it.
 *
 * The collider is the top plus a skirt out to the chair line: eight separate
 * chair colliders would be eight more boxes in the broadphase for each of two
 * hundred tables, and the thing a player actually wants is not to be able to
 * walk through the middle of an occupied table.
 */
function roundGroup(ctx, K, lx, lz, yaw, n) {
  const big = n >= 8;
  const rTop = big ? 0.95 : 0.75;
  const rChair = rTop + 0.62;
  inst(ctx, K.bigPost, lx, 0.35, lz, yaw, big ? 1 : 0.85, 1, big ? 1 : 0.85);
  inst(ctx, big ? K.bigTop : K.midTop, lx, 0.745, lz, yaw);
  // The skirt is the top plus the width of the chair legs tucked under it -
  // wide enough that a player cannot stand inside an occupied table, narrow
  // enough that they can still walk between one table and the next.
  /* The skirt stops just short of the chair line. An eight-top's diagonal
   * chairs sit at (1.11, 1.11) in the table's own frame, so a half-extent of
   * 1.0 is the largest square that does not swallow four of the eight seats -
   * a collider a sitter is standing inside is a sitter buried in a table. */
  ctx.solid(lx, 0.60, lz, rTop + 0.05, 0.16, rTop + 0.05, yaw);
  ctx.contact(lx, lz, rChair * 2 + 0.8);

  const places = [];
  for (let i = 0; i < n; i++) {
    const a = yaw + (i / n) * TAU;
    const p = [lx + Math.sin(a) * rChair, lz + Math.cos(a) * rChair];
    chair(ctx, K, p[0], p[1], 0, faceTo(p[0], p[1], lx, lz));
    places.push(p);
  }
  return places;
}

/** A bar-height table with stools, for eating standing up in ten minutes. */
function highTable(ctx, K, lx, lz, yaw, n = 3) {
  inst(ctx, K.highPost, lx, 0.51, lz, yaw);
  inst(ctx, K.highTop, lx, 1.06, lz, yaw);
  ctx.solid(lx, 0.75, lz, 0.55, 0.35, 0.55, yaw);
  const out = [];
  for (let i = 0; i < n; i++) {
    const a = yaw + (i / n) * TAU + 0.4;
    const p = [lx + Math.sin(a) * 1.15, lz + Math.cos(a) * 1.15];
    inst(ctx, K.stool, p[0], 0.35, p[1], faceTo(p[0], p[1], lx, lz));
    out.push([p, faceTo(p[0], p[1], lx, lz)]);
  }
  return out;
}

/**
 * A block of four booths, back to back in pairs, running along the arc.
 *
 * Booths are what a canteen puts where it wants people to stay an hour, so
 * they go at the back of a band against a divider rather than out in the
 * middle of a rank field.
 */
function boothBlock(ctx, K, deg, rad, occ) {
  const yaw = A(deg);
  let taken = 0;
  for (const side of [-1, 1]) {
    const r = rad + side * 1.55;
    const look = side > 0 ? faceIn(deg) : faceOut(deg);
    for (const t of [-2.6, 2.6]) {
      const c = at(deg, r, t);
      inst(ctx, K.boothTop, c[0], 0.75, c[1], yaw);
      inst(ctx, K.tablePost, c[0], 0.36, c[1], yaw);
      const b = at(deg, r + side * 1.05, t);
      inst(ctx, K.boothSeat, b[0], 0.23, b[1], yaw);
      inst(ctx, K.boothBack, ...at3(deg, r + side * 1.58, 0.81, t), yaw);
      ctx.solid(c[0], 0.6, c[1], 1.05, 0.2, 0.6, yaw);
      ctx.solid(b[0], 0.23, b[1], 1.0, 0.23, 0.30, yaw);
      if (ctx.rng() > occ) continue;
      for (let k = 0; k < 1 + Math.floor(ctx.rng() * 2); k++) {
        const p = at(deg, r + side * 1.05, t + (k ? 0.55 : -0.55));
        seat(ctx, K, p[0], p[1], 0, look, BOOTH_SEAT);
        taken++;
      }
      inst(ctx, K.tray, ...at3(deg, r, 0.80, t), yaw);
    }
    // The screen between this pair of booths and the next block along.
    const w = at(deg, r, 5.4);
    inst(ctx, K.screen, w[0], 0.78, w[1], yaw + Math.PI / 2);
    ctx.solid(w[0], 0.78, w[1], 0.08, 0.78, 1.3, yaw);
  }
  return taken;
}

/**
 * A planted divider: a long tub with greenery in it, used to edge a band.
 *
 * These are what stop eight ranks of refectory tables reading as one field.
 * They stand just inside each band's edge, in runs with gaps in them, so the
 * band has a visible boundary that a player can still walk through.
 */
function plantedDivider(ctx, K, deg, rad, scale = 1) {
  const yaw = A(deg);
  const c = at(deg, rad);
  inst(ctx, K.tubLong, c[0], 0.45, c[1], yaw, scale, 1, 1);
  inst(ctx, K.tubCap, c[0], 0.96, c[1], yaw, scale, 1, 1);
  ctx.solid(c[0], 0.48, c[1], 3.0 * scale, 0.48, 0.58, yaw);
  ctx.contact(c[0], c[1], 4.0 * scale);
  for (const s of [-2.0 * scale, 0, 2.0 * scale]) {
    const p = at(deg, rad, s);
    shrub(ctx, K, p[0], p[1], 0.95, 0.9);
  }
}

/** A waste and recycling bank: two drums on a plinth, with a tray shelf over. */
function binBank(ctx, K, deg, rad) {
  const yaw = A(deg);
  const c = at(deg, rad);
  // The plinth is 16 cm so the 95 cm drums stand ON it rather than sunk into it.
  ctx.box('trimDark', 2.9, 0.16, 1.3, c[0], 0.08, c[1], yaw);
  for (const [s, key] of [[-0.8, 'emGreen'], [0.8, 'emAmber']]) {
    const p = at(deg, rad, s);
    inst(ctx, K.binDrum, p[0], 0.635, p[1], yaw);
    inst(ctx, K.binLid, p[0], 1.14, p[1], yaw);
    ctx.box(key, 0.5, 0.06, 0.36, ...at3(deg, rad - 0.5, 1.06, s), yaw);
  }
  ctx.solid(c[0], 0.60, c[1], 1.45, 0.60, 0.62, yaw);
  ctx.contact(c[0], c[1], 4.2);
  for (let i = 0; i < 2; i++) inst(ctx, K.tray, ...at3(deg, rad, 1.21 + i * 0.05, -1.0 + i * 0.06), yaw);
}

/**
 * A menu totem: a lit board on a post, read from the aisle it stands in.
 *
 * The board is 2.3 m tall and its origin is its middle, so it goes at 1.18 and
 * not at eye height - a totem authored at 1.55 stands 40 cm off the deck, which
 * is invisible in a wide shot and unmissable from three metres.
 */
function menuTotem(ctx, K, deg, rad, yaw = A(deg)) {
  const c = at(deg, rad);
  inst(ctx, K.totem, c[0], 1.18, c[1], yaw);
  inst(ctx, K.totemLit, c[0], 1.40, c[1], yaw);
  ctx.solid(c[0], 1.18, c[1], 0.4, 1.18, 0.14, yaw);
  ctx.contact(c[0], c[1], 2.4);
}

/** A run of retractable-belt barriers, for a queue route. */
function queueRun(ctx, K, deg0, deg1, rad) {
  arcRun(deg0, deg1, rad, 2.1, (d) => {
    const c = at(d, rad);
    inst(ctx, K.qPost, c[0], 0.48, c[1], A(d));
    inst(ctx, K.qBelt, ...at3(d, rad, 0.86, 1.05), A(d));
  });
}

/** Something to have been eating. Trays and mugs, scattered but seeded. */
function laid(ctx, K, lx, lz, floor, yaw, n) {
  for (let i = 0; i < n; i++) {
    const t = off(lx, lz, yaw, (ctx.rng() - 0.5) * 1.0, (ctx.rng() - 0.5) * 0.7);
    inst(ctx, K.tray, t[0], floor + 0.80, t[1], yaw + (ctx.rng() - 0.5) * 0.5);
    if (ctx.rng() > 0.35) inst(ctx, K.mug, t[0] + 0.18, floor + 0.84, t[1] + 0.12, ctx.rng() * TAU);
  }
}

/** A planted tub's worth of greenery: three crossed alpha-cut sprigs. */
function shrub(ctx, K, lx, lz, y, scale = 1) {
  for (let i = 0; i < 3; i++) {
    inst(ctx, K.leaf, lx, y + 0.62 * scale, lz, (i / 3) * Math.PI, scale, scale, scale);
  }
}

/**
 * Put a figure on a seat.
 *
 * `talk` is a STANDING verb - `StationActors._poseTalk` starts from
 * `_poseStand` - so a "talking" figure handed a chair stands up straight
 * through the table. Seated conversation is therefore `sit` and `eat` with
 * their phases pulled apart, and every actual `talk` actor in this zone is on
 * its feet in an aisle, at the end of a refectory row or out on the court,
 * which is where people stand and talk anyway.
 *
 * `sit` solves the legs from the seat height in `amount` and puts the ankles
 * 0.46 m in front of the hips, so the actor's origin belongs on the seat pan
 * itself - not in front of it, and not on the table side of it.
 */
function seat(ctx, K, lx, lz, floor, yaw, height) {
  ctx.actor(lx, floor, lz, {
    localYaw: yaw,
    activity: ctx.rng() > 0.42 ? 'eat' : 'sit',
    amount: height,
    phase: K.phase(),
    speed: 0.8 + ctx.rng() * 0.4,
  });
  K.people++;
}

/**
 * Merge nothing, upload once. Called last, after every list is full.
 *
 * Shadow casting is left on for the furniture - a hall of tables with no
 * shadows under them is exactly what made the hub's first dressing pass read
 * as decals - and off for the steam and the queue markers, which are additive
 * and painted respectively and have no business occluding anything.
 */
function flushKit(ctx, K) {
  const M = ctx.M;
  const g = ctx.group;
  const add = (geo, mat, list, opts) => {
    if (!list.length || !mat) return null;
    const m = instanced(geo, mat, list, opts);
    g.add(m);
    return m;
  };

  add(boxGeo(0.13, 0.44, 0.13, 1), M.trimDark, K.chairPost);
  add(boxGeo(0.46, 0.06, 0.46, 1), M.panelWarm, K.chairSeat);
  add(boxGeo(0.44, 0.46, 0.06, 1), M.panelWarm, K.chairBack);
  // One tapered pedestal is the whole stool - seat, column and foot in 32
  // triangles and a single draw, where a seat plus a post was two of each.
  add(cylGeo(0.19, 0.07, 0.70, 6, 1), M.trim, K.stool);
  add(cylGeo(0.45, 0.45, 0.07, 8, 1), M.trim, K.roundTop);
  add(cylGeo(0.09, 0.30, 0.70, 6, 1), M.trimDark, K.tablePost);
  add(boxGeo(1.34, 0.08, 1.34, 1.5), M.panelWarm, K.squareTop);
  add(boxGeo(4.4, 0.08, 0.42, 1.5), M.panelWarm, K.benchTop);
  add(boxGeo(0.12, 0.37, 0.36, 1), M.trimDark, K.benchLeg);
  add(boxGeo(2.0, 0.46, 0.58, 1.5), M.panelWarm, K.boothSeat);
  add(boxGeo(2.0, 0.70, 0.14, 1.5), M.panelTeal, K.boothBack);
  add(boxGeo(1.5, 0.08, 1.0, 1.5), M.panelWarm, K.boothTop);

  /* The group-table kit.
   *
   * `refTop` is modelled at REF_LEN and scaled on X per rank, so an 8 m table
   * and a 13 m one are the same twelve triangles; same for `benchTop` and
   * `tubLong`. Everything under about a metre has casting off - a caddy's
   * shadow is smaller than one shadow-map texel at this deck's cascade, so it
   * costs a draw in the depth pass and produces nothing. */
  add(boxGeo(REF_LEN, 0.09, 1.24, 1.5), M.panelWarm, K.refTop);
  add(boxGeo(0.20, 0.66, 1.0, 1), M.trimDark, K.refLeg);
  add(cylGeo(0.95, 0.95, 0.08, 10, 1), M.panelWarm, K.bigTop);
  add(cylGeo(0.75, 0.75, 0.08, 8, 1), M.panelWarm, K.midTop);
  add(cylGeo(0.11, 0.34, 0.70, 6, 1), M.trimDark, K.bigPost);
  add(cylGeo(0.52, 0.52, 0.07, 8, 1), M.trim, K.highTop);
  add(cylGeo(0.10, 0.32, 1.02, 6, 1), M.trimDark, K.highPost);
  add(boxGeo(0.34, 0.20, 0.22, 1), M.trim, K.caddy, { cast: false });
  add(boxGeo(0.16, 0.22, 0.16, 1), M.chrome, K.cutlery, { cast: false });
  add(boxGeo(0.22, 0.14, 0.16, 1), M.panelDark, K.napkin, { cast: false });
  add(cylGeo(0.40, 0.34, 0.95, 8, 1), M.trimDark, K.binDrum);
  add(cylGeo(0.44, 0.44, 0.10, 8, 1), M.trim, K.binLid);
  add(boxGeo(0.52, 1.05, 0.40, 1), M.chrome, K.fountain);
  add(boxGeo(0.76, 2.30, 0.22, 1.4), M.panelDark, K.totem);
  add(boxGeo(0.58, 1.45, 0.06, 1), M.emDim, K.totemLit, { cast: false });
  add(cylGeo(0.06, 0.09, 0.95, 6, 1), M.trim, K.qPost, { cast: false });
  add(boxGeo(1.90, 0.06, 0.03, 1), M.emAmber, K.qBelt, { cast: false, recv: false });
  add(boxGeo(0.90, 0.86, 0.66, 1), M.trim, K.trolley);
  add(boxGeo(0.94, 0.05, 0.70, 1), M.grate, K.trolleyShelf, { cast: false });
  add(boxGeo(0.36, 0.92, 0.36, 1), M.panelTeal, K.highChair);
  add(boxGeo(2.60, 1.55, 0.10, 1.5), M.panelTeal, K.screen);
  add(boxGeo(2.40, 0.07, 0.07, 1), M.chrome, K.coatRail, { cast: false });
  add(boxGeo(6.00, 0.90, 1.10, 1.5), M.panelTeal, K.tubLong);
  add(boxGeo(6.20, 0.12, 1.32, 1), M.trim, K.tubCap);
  add(cylGeo(0.30, 0.30, 0.70, 8, 1.5), M.chrome, K.urn);
  add(cylGeo(0.09, 0.09, 0.30, 6, 1), M.trim, K.cupStack, { cast: false });

  add(boxGeo(0.40, 0.03, 0.30, 1), M.panelDark, K.tray);
  add(boxGeo(0.09, 0.11, 0.09, 1), M.trim, K.mug);
  add(boxGeo(0.85, 0.75, 0.85, 1), M.crate, K.crate);
  add(new THREE.PlaneGeometry(1.7, 1.5), M.foliageCard, K.leaf);
  add(cylGeo(0.26, 0.10, 0.24, 6, 1), M.panelWarm, K.pendantShade);
  add(boxGeo(0.14, 0.06, 0.14, 1), M.emAmber, K.pendantBulb);
  add(boxGeo(1.5, 0.05, 0.22, 1), M.emAmber, K.marker, { cast: false, recv: false });

  /* Steam.
   *
   * `M.steam` is additive and depth-write-off, and the zone batch's flush opts
   * only exempt `room` and `holo` from casting - a steam plane pushed through
   * `ctx.put` would therefore be rendered into the shadow map and throw a hard
   * rectangle across the servery. It goes through `instanced()` with casting
   * explicitly off instead, which is also how the hub's vent puffs are built.
   * They do not drift: the hub's animation is driven from
   * `StationWorld._anim.steamSeeds`, which only ever tracks one mesh. */
  const puffs = add(new THREE.PlaneGeometry(2.8, 2.8), M.steam, K.puff, { cast: false, recv: false });
  if (puffs?.isInstancedMesh) puffs.renderOrder = 7;
}

/* ------------------------------------------------------------------ */
/* Floor                                                               */
/* ------------------------------------------------------------------ */

/**
 * Paving.
 *
 * The deck under this zone is one 400 m circle of identical plate, and at that
 * size it photographs as a grey field with furniture standing on it. The floor
 * treatment does the same job the alley refacing does on the commercial strip:
 * it tells you which room you are in before you have read a sign.
 */
function paveTheGalley(ctx) {
  /* The dining bands, laid outward.
   *
   * Warm plate under everything that is dining and NOTHING under anything that
   * is a route: the promenade, the two ring corridors and the eleven spokes
   * are left as the station's own bare deck, so the boundary between "eat
   * here" and "walk here" is a change of material a player reads without
   * having to be told. It also means the only floor treatment in the hall is
   * on the parts of it that are furnished, which is what stops 113,000 m2 of
   * inlay reading as wall-to-wall carpet.
   *
   * Each band is stacked a centimetre off its neighbours rather than all being
   * at 0.09, because a band's quads overlap their own neighbours' by 40 cm to
   * hide the seam and two coplanar overlaps in one ring is a stripe of
   * z-fighting 500 m long.
   *
   * That note had the diagnosis exactly right and then stopped one ring short.
   * The 40 cm of overlap is between a quad and the NEXT QUAD IN ITS OWN BAND,
   * and separating the bands from each other does nothing about it: the floor
   * sweep found 16 coincident `plaza || plaza` hits in this hall, one per joint
   * it happened to land on, and every one of them is inside a single band.
   * `seamLift` drops alternate segments by 4 mm so the joint has a winner - the
   * two quads carry the same texture at different UV origins either way, so
   * which one wins is not something a player can see; that the depth buffer
   * cannot decide, is. It drops rather than lifts, so that every surface this
   * hall already stacks on top of the dining plate - the processional at 0.13,
   * the marked bays at 0.145, the servery apron at 0.15 - keeps the clearance
   * it was given.
   *
   *      key      radius   depth   height   what it is
   *      -----    ------   -----   ------   ---------------------------------
   *      plaza    134.75    26.5    0.10    dining band 1
   *      plaza    166.00    26.0    0.11    dining band 2
   *      plaza    188.50     9.0    0.10    the window band
   */
  const SEAM = 0.004;
  const BANDS = [
    ['plaza', 134.75, 26.5, 0.10, 16, 11],
    ['plaza', 166.0, 26.0, 0.11, 18, 11],
    ['plaza', 188.5, 9.0, 0.10, 15, 9],
  ];
  for (const [key, rad, depth, y, pitch, tile] of BANDS) {
    arcRun(0, 360, rad, pitch, (d, i, n) => {
      const p = at(d, rad);
      if (!ctx.onDeck(p[0], p[1], 5)) return;
      ctx.floorQuad(key, pitch + 0.4, depth, p[0], p[1], A(d), y - seamLift(i, n, SEAM), tile);
    });
  }

  /* The court: the island's apron and the two fields of court dining. The
   * middle 31 m is the tower's and gets none of this - the planting ring is
   * its floor - and the ring corridor between the fields is bare deck for the
   * same reason the arcade's two are. */
  const COURT = [
    ['plaza', 44.6, 15.8, 0.10, 12, 9],
    ['plaza', 66.5, 27.0, 0.11, 14, 11],
    ['plaza', 93.0, 16.0, 0.10, 15, 10],
  ];
  for (const [key, rad, depth, y, pitch, tile] of COURT) {
    arcRun(0, 360, rad, pitch, (d, i, n) => {
      const p = at(d, rad);
      ctx.floorQuad(key, pitch + 0.4, depth, p[0], p[1], A(d), y - seamLift(i, n, SEAM), tile);
    });
  }

  /* The processional in from the plaza: a marked route 22 m wide running the
   * whole way to the tower, which is the one part of this floor a player is
   * guaranteed to walk down and the only reason the entry funnel is empty. */
  for (let i = 0; i < 11; i++) {
    const lz = 30 + i * 15.5;
    ctx.floorQuad('road', 22, 15.9, 0, lz, 0, 0.13, 9);
    if (i % 2 === 0) ctx.box('hazard', 21, 0.05, 0.5, 0, 0.15, lz - 7.5, 0, 3);
  }

  /* Marked bays: the hall's own wayfinding, one painted rectangle per dining
   * sector so a player can be told to meet somebody at a place with a name. */
  for (const [d, r] of [[45, 134.75], [100, 134.75], [265, 134.75], [320, 134.75],
    [45, 166.0], [100, 166.0], [265, 166.0], [320, 166.0],
    [60, 66.5], [120, 66.5], [240, 66.5], [300, 66.5]]) {
    const p = at(d, r);
    ctx.floorQuad('hazard', 12, 8, p[0], p[1], A(d), 0.145, 4);
  }

  /* Warm apron in front of the servery - the strip that is always busy.
   * Open runs, not closed rings, so `seamLift`'s wrap case never applies; the
   * overlap between one quad and the next is the same 40 cm and wants the same
   * 4 mm. */
  arcRun(SERVERY_A0 - 4, SERVERY_A1 + 4, 146, 11, (d, i, n) => {
    const p = at(d, 146);
    ctx.floorQuad('plaza', 11.4, 26, p[0], p[1], A(d), 0.15 - seamLift(i, n, SEAM, false), 9);
  });
  // Cooler, harder floor through the back of house, where the trolleys run.
  arcRun(BOH_A0, BOH_A1, 180, 12, (d, i, n) => {
    const p = at(d, 180);
    ctx.floorQuad('road', 12.4, 26, p[0], p[1], A(d), 0.16 - seamLift(i, n, SEAM, false), 8);
  });

  ctx.mmPath(
    [0, 1, 2, 3, 4, 5, 6].map((i) => at(SERVERY_A0 + ((SERVERY_A1 - SERVERY_A0) * i) / 6, SERVERY_R)),
    'rgba(255,201,138,0.8)', 9, false
  );
  ctx.mmCircle(0, 0, 34, 'rgba(70,140,100,0.35)', 'rgba(140,255,190,0.6)');
}

/* ------------------------------------------------------------------ */
/* The servery                                                         */
/* ------------------------------------------------------------------ */

/**
 * A 126 m counter, its back line, its extraction and the catwalk over it.
 *
 * The run is built from 6 m bays on a four-part cycle - hot plate, urns, cold
 * well, drinks - rather than as one extruded counter, for the same reason the
 * link corridor carries a portal frame every 8 m: an unbroken 126 m object has
 * no gauge in it and the eye cannot tell whether it is thirty metres away or a
 * hundred. The cycle also means all four things a canteen counter actually has
 * are visible from any single standing position.
 */
function buildServery(ctx, K) {
  arcRun(SERVERY_A0, SERVERY_A1, SERVERY_R, 7, (d, i) => {
    const kind = i % 4;
    const yaw = A(d);
    const c = at(d, SERVERY_R);

    /* --- The counter itself ---------------------------------------- */
    ctx.box('panelWarm', 6.15, 1.02, 1.6, c[0], 0.51, c[1], yaw);
    ctx.box('trim', 6.15, 0.10, 1.92, c[0], 1.07, c[1], yaw);
    ctx.box('trimDark', 6.15, 0.22, 1.2, c[0], 0.11, c[1], yaw);
    // Tray rail on the customer side, at the height a tray is actually pushed.
    ctx.box('trim', 6.15, 0.07, 0.30, ...at3(d, SERVERY_R - 1.05, 0.94), yaw);
    ctx.solid(c[0], 0.60, c[1], 3.1, 0.60, 1.0, yaw);

    /* --- Back line: splashback, pass shelf, under-shelf glow -------- */
    const gb = at(d, SERVERY_BACK);
    ctx.box('panelDark', 6.15, 4.4, 0.7, gb[0], 2.2, gb[1], yaw);
    ctx.box('trim', 6.15, 0.12, 1.0, gb[0], 1.78, gb[1], yaw);
    ctx.box('emDim', 5.6, 0.10, 0.26, ...at3(d, SERVERY_BACK - 0.75, 1.66), yaw);
    ctx.solid(gb[0], 2.2, gb[1], 3.1, 2.2, 0.45, yaw);

    /* --- What is actually being served ------------------------------ */
    if (kind === 0) {
      // Hot plate: a sunk bain-marie, a hot glow in it and steam off the top.
      const h = at3(d, SERVERY_R + 0.15, 1.14);
      ctx.box('grate', 5.0, 0.10, 1.05, ...h, yaw);
      ctx.box('emSodium', 4.6, 0.06, 0.8, ...at3(d, SERVERY_R + 0.15, 1.19), yaw);
      for (const s of [-1.5, 0, 1.5]) {
        inst(ctx, K.puff, ...at3(d, SERVERY_R + 0.15, 2.4 + Math.abs(s) * 0.2, s), faceIn(d));
      }
    } else if (kind === 1) {
      // Soup urns, with a service light under each spout.
      for (const s of [-1.7, 0, 1.7]) {
        const u = at3(d, SERVERY_R + 0.2, 1.55, s);
        ctx.put('chrome', cylGeo(0.42, 0.42, 0.86, 8, 1.6), ...u, yaw);
        ctx.put('trimDark', cylGeo(0.46, 0.46, 0.10, 8, 1), u[0], 2.03, u[2], yaw);
        ctx.box('emAmber', 0.16, 0.05, 0.06, ...at3(d, SERVERY_R - 0.28, 1.3, s), yaw);
      }
      inst(ctx, K.puff, ...at3(d, SERVERY_R + 0.9, 2.9), faceIn(d), 0.7, 0.7, 0.7);
    } else if (kind === 2) {
      // Cold well: a sneeze guard over a lit trough of things in trays.
      const w = at3(d, SERVERY_R + 0.1, 1.22);
      ctx.box('trimDark', 5.2, 0.24, 1.1, ...w, yaw);
      ctx.box('emWhite', 4.8, 0.05, 0.85, w[0], 1.35, w[2], yaw);
      ctx.put('glassWindow', new THREE.PlaneGeometry(5.4, 0.9),
        ...at3(d, SERVERY_R - 0.75, 1.85), yaw + Math.PI);
      for (let s = -2; s <= 2; s++) {
        inst(ctx, K.tray, ...at3(d, SERVERY_R + 0.1, 1.36, s * 1.0), yaw);
      }
    } else {
      // Drinks wall: dispensers, a rank of cups, the taps' own accent line.
      const dw = at3(d, SERVERY_BACK - 0.55, 2.5);
      ctx.box('panelTeal', 5.4, 2.2, 0.5, ...dw, yaw);
      ctx.box(ctx.accent, 5.0, 0.12, 0.14, dw[0], 3.5, dw[2], yaw);
      for (let s = -2; s <= 2; s++) {
        const n = at3(d, SERVERY_BACK - 0.9, 1.95, s * 1.05);
        ctx.put('chrome', cylGeo(0.07, 0.07, 0.34, 6, 1), ...n, yaw);
        inst(ctx, K.mug, n[0], 1.20, n[2], yaw);
      }
    }

    /* --- Extraction -------------------------------------------------- */
    const hd = at(d, HOOD_R);
    ctx.box('grate', 6.15, 1.5, 3.4, hd[0], 4.55, hd[1], yaw);
    ctx.box('trimDark', 6.15, 0.30, 3.8, hd[0], 3.72, hd[1], yaw);
    ctx.box('emWhite', 5.4, 0.08, 0.4, ...at3(d, HOOD_R - 1.5, 3.62), yaw);

    /* A riser on every third bay only.
     *
     * A duct off every hood would be twenty-two 20 m columns standing in front
     * of the perimeter glazing, which is most of what can be seen of this zone
     * from the court. Three hoods to a riser is what a real extract manifold
     * does anyway, and it leaves the gaps the glass is seen through. The top
     * stops at ARCADE_HEAD; the radial trusses hang to 27.55. */
    if (i % 3 === 1) {
      const top = ARCADE_HEAD - 0.6;
      const runH = top - 5.7;
      ctx.box('trimDark', 1.3, runH, 1.3, hd[0], 5.7 + runH / 2, hd[1], yaw);
      ctx.box('panelDark', 1.7, 0.8, 1.7, hd[0], 5.9, hd[1], yaw);
      ctx.box('trim', 1.5, 1.0, 1.5, hd[0], top - 0.5, hd[1], yaw);
    }
  });

  /* --- Menu boards --------------------------------------------------- *
   * The galley's own name over the middle of the run, concession fascias
   * either side of it. The four food cells belong to the commercial strip, and
   * reusing them here is deliberate: a NOVA RAMEN and a TITAN NOODLE CO counter
   * in the station canteen is one business with a second outlet, which is what
   * a franchise is. There is no adjacency left to break - the strip is 500 m
   * away through two pressure doors. */
  const CONCESSIONS = [0, 7, 2, 3];
  arcRun(SERVERY_A0 + 3, SERVERY_A1 - 3, SERVERY_FRONT, 15, (d, i) => {
    ctx.sign(CONCESSIONS[i % 4], 5.0, 1.25, ...at3(d, SERVERY_FRONT, 4.3), A(d) + Math.PI, {
      accent: ctx.accent, thickness: 0.22,
    });
  });
  ctx.sign(31, 11, 2.8, ...at3(180, SERVERY_FRONT - 1.2, 7.9), A(180) + Math.PI, {
    accent: ctx.accent, thickness: 0.3,
  });

  /* --- Service catwalk over the back line ----------------------------- *
   * It is here because the counter needs somewhere on top of it worth climbing
   * to, and an unreachable ledge is not that. It is a real lighting and
   * extract-access walkway with a stair off the end of the run, and it is the
   * only place in the zone from which the whole counter can be seen end-on. */
  arcRun(SERVERY_A0 - 1, SERVERY_A1 + 1, CATWALK_R, 8, (d) => {
    const yaw = A(d);
    const c = at(d, CATWALK_R);
    // Deck plate and collider share a top face at exactly CATWALK_Y, which is
    // the floor height the figure up here is registered on.
    ctx.box('grate', 7.2, 0.2, 1.9, c[0], CATWALK_Y - 0.1, c[1], yaw);
    ctx.solid(c[0], CATWALK_Y - 0.1, c[1], 3.6, 0.1, 0.95, yaw);
    for (const s of [-1, 1]) {
      // The outer handrail is cut where the stair arrives, or the flight
      // terminates in a fence and the whole climb is decorative.
      if (s > 0 && Math.abs(d - CATWALK_STAIR_A) < 3.5) continue;
      const p = at(d, CATWALK_R + s * 0.95);
      ctx.box('trim', 7.2, 1.05, 0.09, p[0], CATWALK_Y + 0.55, p[1], yaw);
      ctx.solid(p[0], CATWALK_Y + 0.55, p[1], 3.6, 0.55, 0.08, yaw);
    }
    // Downlights on the inner edge, aimed at the counter below.
    ctx.box(ctx.accent, 5.4, 0.1, 0.16, ...at3(d, CATWALK_R - 0.9, CATWALK_Y - 0.2), yaw);
  });
  ctx.roof(...at3(180, CATWALK_R, CATWALK_Y + 0.1));
  ctx.roof(...at3(SERVERY_A0 + 8, CATWALK_R, CATWALK_Y + 0.1));

  /* The stair itself, running along the arc past the end of the counter where
   * the back-of-house screen wall has already stopped. `ctx.ramp`'s high end is
   * its local +Z, and A(deg) - PI/2 aims local +Z along the arc toward
   * DECREASING bearing - which is where the catwalk is. */
  {
    const RUN = 14.3, RISE = CATWALK_Y;
    const pitch = Math.atan2(RISE, RUN);
    const m = at(CATWALK_STAIR_A, CATWALK_R);
    const len = Math.hypot(RUN, RISE);
    ctx.ramp(m[0], RISE / 2 - 0.25 / Math.cos(pitch), m[1], 3.6, RUN, RISE, A(CATWALK_STAIR_A) - Math.PI / 2);
    ctx.put('grate', boxGeo(3.6, 0.28, len, 2), m[0], RISE / 2, m[1], A(CATWALK_STAIR_A) - Math.PI / 2, -pitch, 0);
    for (const s of [-1.9, 1.9]) {
      const h = at(CATWALK_STAIR_A, CATWALK_R + s);
      ctx.put('trim', boxGeo(0.1, 0.1, len, 1), h[0], RISE / 2 + 1.0, h[1], A(CATWALK_STAIR_A) - Math.PI / 2, -pitch, 0);
      ctx.put('panelDark', boxGeo(0.22, 1.0, len, 2), h[0], RISE / 2 + 0.45, h[1], A(CATWALK_STAIR_A) - Math.PI / 2, -pitch, 0);
    }
    ctx.contact(m[0], m[1], 16);
  }

  /* --- Collection counter, at the low-bearing end of the run ---------- */
  arcRun(SERVERY_A0 - 12, SERVERY_A0 - 1, 152, 6, (d) => {
    const yaw = A(d);
    const c = at(d, 152);
    ctx.box('panelDark', 6.15, 0.92, 1.5, c[0], 0.46, c[1], yaw);
    ctx.box('trim', 6.15, 0.10, 1.8, c[0], 0.97, c[1], yaw);
    ctx.box('trimDark', 6.15, 0.5, 0.5, ...at3(d, 153.4, 2.6), yaw);
    // Heat lamps over the collection shelf, which is what makes it read as a
    // collection point rather than as more counter.
    ctx.box('emSodium', 5.4, 0.12, 0.3, ...at3(d, 153.0, 2.3), yaw);
    ctx.solid(c[0], 0.55, c[1], 3.1, 0.55, 0.95, yaw);
    for (let s = -1; s <= 1; s++) {
      inst(ctx, K.tray, ...at3(d, 152, 1.04 + (s & 1 ? 0.04 : 0), s * 1.4), yaw);
    }
  });

  /* --- Stacked trays at each end of the run --------------------------- */
  for (const d of [SERVERY_A0 - 14, SERVERY_A1 + 6]) {
    const c = at(d, 150);
    ctx.box('panelDark', 2.2, 0.95, 1.2, c[0], 0.48, c[1], A(d));
    ctx.solid(c[0], 0.5, c[1], 1.1, 0.5, 0.6, A(d));
    ctx.contact(c[0], c[1], 4.4);
    for (let s = 0; s < 6; s++) {
      inst(ctx, K.tray, ...at3(d, 150, 1.0 + s * 0.045, -0.5), A(d));
      inst(ctx, K.tray, ...at3(d, 150, 1.0 + s * 0.045, 0.5), A(d));
    }
  }

  /* --- Practicals ------------------------------------------------------ *
   * Warm, low and close. The zone's own arcade lights hang 5 m under a 30 m
   * ceiling and wash the whole annulus evenly; these are what make the counter
   * the brightest thing in the room, which is the only reason a player 300 m
   * away starts walking toward it. */
  for (const d of [160, 170, 180, 190, 200]) {
    const l = new THREE.PointLight(0xffc08a, 1500, 52, 2);
    l.position.copy(ctx.P(...at3(d, SERVERY_R - 2, 9.5)));
    l.castShadow = false;
    ctx.group.add(l);
  }
}

/* ------------------------------------------------------------------ */
/* Back of house                                                       */
/* ------------------------------------------------------------------ */

/**
 * The galley kitchen behind the counter, its stores and its dish return.
 *
 * It is open to the arcade rather than sealed behind a door because a canteen
 * whose kitchen is a blank wall has no depth behind its counter, and that depth
 * is most of what makes the counter look like it is being supplied by
 * something. The wall is a screen with three openings in it, not a partition.
 */
function buildBackOfHouse(ctx, K) {
  arcRun(BOH_A0, BOH_A1, BOH_WALL_R, 7, (d, i, n) => {
    // The three things the place works through: dish return in at the near
    // end, staff across the middle, stores out at the far end.
    const gap = i === 2 || i === Math.floor(n / 2) || i === n - 3;
    const yaw = A(d);
    const c = at(d, BOH_WALL_R);
    if (gap) {
      ctx.box('panelDark', 6.2, 1.5, 0.6, c[0], 4.25, c[1], yaw);
      ctx.solid(c[0], 4.25, c[1], 3.1, 0.75, 0.3, yaw);
      for (const s of [-2.6, 2.6]) {
        const j = at(d, BOH_WALL_R, s);
        ctx.box('trim', 0.35, 3.5, 0.7, j[0], 1.75, j[1], yaw);
        ctx.box(ctx.accent, 0.1, 3.3, 0.12, ...at3(d, BOH_WALL_R - 0.4, 1.75, s), yaw);
        ctx.solid(j[0], 1.75, j[1], 0.2, 1.75, 0.35, yaw);
      }
    } else {
      ctx.box('panel', 6.2, 5.0, 0.6, c[0], 2.5, c[1], yaw);
      ctx.box('trim', 6.2, 0.2, 0.85, c[0], 5.05, c[1], yaw);
      ctx.solid(c[0], 2.5, c[1], 3.1, 2.5, 0.35, yaw);
      if (i % 4 === 0) ctx.box('grate', 1.5, 1.0, 0.4, ...at3(d, BOH_WALL_R - 0.4, 3.9), yaw);
    }
  });
  ctx.sign(14, 2.6, 0.72, ...at3(BOH_A0 + 6, BOH_WALL_R - 0.6, 5.9), A(BOH_A0 + 6) + Math.PI, {
    accent: 'emAmber', thickness: 0.12,
  });

  /* --- Prep line: benches, ranges, a wash-up run ---------------------- */
  arcRun(BOH_A0 + 4, BOH_A1 - 4, 175, 9, (d, i) => {
    const yaw = A(d);
    const c = at(d, 175);
    ctx.box('chrome', 6.6, 0.90, 1.3, c[0], 0.45, c[1], yaw);
    ctx.box('trim', 6.6, 0.08, 1.5, c[0], 0.94, c[1], yaw);
    ctx.solid(c[0], 0.5, c[1], 3.3, 0.5, 0.8, yaw);
    if (i % 2 === 0) {
      for (const k of [-1.4, 1.4]) {
        ctx.put('emSodium', cylGeo(0.24, 0.24, 0.04, 8, 1), ...at3(d, 175, 0.97, k), yaw);
      }
      ctx.box('grate', 6.0, 0.8, 1.8, c[0], 2.6, c[1], yaw);
      inst(ctx, K.puff, ...at3(d, 175, 1.9, 0.6), A(d), 0.7, 0.7, 0.7);
    } else {
      ctx.box('trimDark', 6.6, 0.1, 0.7, c[0], 1.85, c[1], yaw);
      ctx.box('trimDark', 6.6, 0.1, 0.7, c[0], 2.55, c[1], yaw);
      for (let k = -2; k <= 2; k++) {
        inst(ctx, K.crate, ...at3(d, 175, 2.28, k * 1.3), yaw, 0.55, 0.55, 0.55);
      }
    }
  });

  /* --- Dish return ----------------------------------------------------- *
   * At the near end, where the dining floor meets the back of house, so a
   * player carrying a tray has somewhere obvious to be walking. */
  {
    const d0 = BOH_A0 + 2;
    arcRun(d0, d0 + 7, 171, 5, (dd) => {
      const yaw = A(dd);
      const c = at(dd, 171);
      ctx.box('trimDark', 5.2, 0.8, 1.1, c[0], 0.4, c[1], yaw);
      ctx.box('rubber', 5.2, 0.12, 0.9, c[0], 0.86, c[1], yaw);
      ctx.box('trim', 5.2, 0.16, 0.16, ...at3(dd, 170.4, 1.05), yaw);
      ctx.solid(c[0], 0.45, c[1], 2.6, 0.45, 0.6, yaw);
      for (const s of [-1.4, 0, 1.4]) {
        inst(ctx, K.tray, ...at3(dd, 171, 0.94, s), yaw + s * 0.15);
      }
      inst(ctx, K.puff, ...at3(dd, 171.6, 1.9), yaw, 0.6, 0.6, 0.6);
    });
    const r = at(d0 + 3.5, 176);
    ctx.box('panelTeal', 4.0, 2.6, 2.2, r[0], 1.3, r[1], A(d0 + 3.5));
    ctx.solid(r[0], 1.3, r[1], 2.0, 1.3, 1.1, A(d0 + 3.5));
    ctx.contact(r[0], r[1], 8);
    // Something has ridden the belt down and stayed on it.
    ctx.relic(...at3(d0 + 1.5, 171, 1.05), 'common');
  }

  /* --- Walk-in store, and the stair onto its roof ---------------------- *
   * Three walls and a lid, open on the inward face: a room you can walk into
   * and stand in the dark of, which is worth more as a hiding place than a
   * sealed box with a door texture on it would be. */
  {
    const yaw = A(STORE_A);
    const c = at(STORE_A, STORE_R);
    const back = at(STORE_A, STORE_R + 3.2);
    ctx.box('panel', 9.4, 4.2, 0.4, back[0], 2.1, back[1], yaw);
    ctx.solid(back[0], 2.1, back[1], 4.7, 2.1, 0.25, yaw);
    for (const s of [-4.5, 4.5]) {
      const e = at(STORE_A, STORE_R, s);
      ctx.box('panel', 0.4, 4.2, 6.6, e[0], 2.1, e[1], yaw);
      ctx.solid(e[0], 2.1, e[1], 0.25, 2.1, 3.3, yaw);
    }
    ctx.box('panelDark', 9.8, 0.35, 7.0, c[0], 4.35, c[1], yaw);
    ctx.solid(c[0], 4.35, c[1], 4.9, 0.2, 3.5, yaw);
    // Door head over the opening, with the cold-store accent under it.
    const f = at(STORE_A, STORE_R - 3.3);
    ctx.box('panelDark', 9.4, 1.1, 0.5, f[0], 3.6, f[1], yaw);
    ctx.box('emCyan', 8.4, 0.12, 0.18, f[0], 3.0, f[1], yaw);
    ctx.solid(f[0], 3.6, f[1], 4.7, 0.55, 0.25, yaw);
    // Racking inside, and something on a shelf worth going in for.
    for (const s of [-3.0, 3.0]) {
      const rk = at(STORE_A, STORE_R, s);
      for (const sy of [0.9, 1.9, 2.9]) ctx.box('grate', 1.6, 0.08, 5.4, rk[0], sy, rk[1], yaw);
      ctx.box('trim', 0.1, 3.4, 0.1, rk[0], 1.7, rk[1], yaw);
      for (let k = -2; k <= 2; k++) {
        inst(ctx, K.crate, ...at3(STORE_A, STORE_R + k * 1.15, 2.28, s), yaw, 0.7, 0.7, 0.7);
        if (k % 2 === 0) inst(ctx, K.crate, ...at3(STORE_A, STORE_R + k * 1.15, 1.28, s), yaw, 0.7, 0.7, 0.7);
      }
    }
    ctx.relic(...at3(STORE_A, STORE_R + 1.4, 0.55), 'prize');
    ctx.roof(...at3(STORE_A, STORE_R, 4.55));
    ctx.relic(...at3(STORE_A, STORE_R + 1.8, 4.75), 'rare');
    ctx.contact(c[0], c[1], 16);
    ctx.mmRect(c[0], c[1], 9.8, 7.0, yaw, 'rgba(90,110,130,0.6)', 'rgba(170,220,255,0.5)');

    /* Steps up the flank. A yaw of A(deg) + PI/2 puts `ctx.ramp`'s high end -
     * its local +Z - along the arc toward increasing bearing, so this climbs
     * toward the store rather than away from it. */
    const RAMP_A = 196.6, RUN = 11.4, RISE = 4.55;
    const pitch = Math.atan2(RISE, RUN);
    const len = Math.hypot(RUN, RISE);
    const m = at(RAMP_A, STORE_R);
    ctx.ramp(m[0], RISE / 2 - 0.25 / Math.cos(pitch), m[1], 3.4, RUN, RISE, A(RAMP_A) + Math.PI / 2);
    ctx.put('grate', boxGeo(3.4, 0.25, len, 2), m[0], RISE / 2, m[1], A(RAMP_A) + Math.PI / 2, -pitch, 0);
    for (const s of [-1.8, 1.8]) {
      const h = at(RAMP_A, STORE_R + s);
      ctx.put('trim', boxGeo(0.1, 0.1, len, 1), h[0], RISE / 2 + 1.0, h[1], A(RAMP_A) + Math.PI / 2, -pitch, 0);
    }
  }

  /* --- Dollies, cages and pallets --------------------------------------- */
  for (let i = 0; i < 18; i++) {
    const d = BOH_A0 + 4 + ctx.rng() * (BOH_A1 - BOH_A0 - 8);
    // Nothing scattered into the walk-in store's own footprint.
    if (d > 194 && d < 206) continue;
    const r = 184 + ctx.rng() * (BUILD_R - 187);
    const p = at(d, r);
    if (!ctx.onDeck(p[0], p[1], 8)) continue;
    const yaw = A(d) + (ctx.rng() - 0.5) * 0.6;
    const stack = 1 + Math.floor(ctx.rng() * 3);
    for (let s = 0; s < stack; s++) inst(ctx, K.crate, p[0], 0.42 + s * 0.78, p[1], yaw + s * 0.08);
    ctx.solid(p[0], (stack * 0.78) / 2, p[1], 0.45, (stack * 0.78) / 2, 0.45, yaw);
    ctx.contact(p[0], p[1], 3.4);
    if (i % 5 === 0) {
      // A roll cage, which is what these places move everything on.
      ctx.box('trim', 0.9, 1.6, 0.9, p[0], 0.8, p[1], yaw);
      ctx.box('grate', 1.0, 0.08, 1.0, p[0], 0.3, p[1], yaw);
    }
  }

  /* --- Light: cool and even, so it reads as work rather than as service -- */
  for (const d of [BOH_A0 + 10, 180, BOH_A1 - 10]) {
    const l = new THREE.PointLight(0xd8e8ff, 900, 40, 2);
    l.position.copy(ctx.P(...at3(d, 180, 6.5)));
    l.castShadow = false;
    ctx.group.add(l);
  }
}

/* ------------------------------------------------------------------ */
/* Order points                                                        */
/* ------------------------------------------------------------------ */

/**
 * Five free-standing order kiosks, each with a painted queue lane behind it.
 *
 * They stand 19 m clear of the counter rather than against it because the queue
 * is the point: a lane marked on the floor with six people on it, seen end-on
 * from the dining floor, is the clearest available statement that this place is
 * busy, and a queue pressed up against a counter just reads as a crowd.
 */
function buildOrderPoints(ctx, K) {
  for (const d of KIOSK_BEARINGS) {
    const yaw = A(d);
    const c = at(d, KIOSK_R);

    ctx.box('panelDark', 1.6, 2.3, 0.9, c[0], 1.15, c[1], yaw);
    ctx.box('trim', 1.75, 0.1, 1.05, c[0], 2.32, c[1], yaw);
    ctx.box('trimDark', 1.9, 0.16, 1.2, c[0], 0.08, c[1], yaw);
    ctx.solid(c[0], 1.15, c[1], 0.8, 1.15, 0.45, yaw);
    ctx.contact(c[0], c[1], 5);

    // The screen faces the queue, so it hangs on the court side of the post.
    const s = at3(d, KIOSK_R - 0.5, 1.75);
    ctx.put('holo', new THREE.PlaneGeometry(1.35, 1.15), ...s, yaw + Math.PI);
    ctx.box('trim', 1.5, 0.06, 0.06, s[0], 1.14, s[2], yaw);
    ctx.box(ctx.accent, 0.9, 0.05, 0.1, s[0], 1.05, s[2], yaw);

    ctx.sign(33, 1.9, 0.5, ...at3(d, KIOSK_R - 0.55, 3.05), yaw + Math.PI, {
      accent: ctx.accent, thickness: 0.12,
    });
    // A blade over the top, so the row can be counted from across the court.
    ctx.box('panelDark', 0.18, 1.5, 0.18, c[0], 3.05, c[1], yaw);
    ctx.box(ctx.accent, 0.5, 0.5, 0.5, c[0], 3.95, c[1], yaw);

    /* The queue lane: a painted strip and a marker every 1.6 m. The markers
     * are emissive and 5 cm tall - well under the 0.4 m the prop sweep would
     * ever collide, and nothing anybody can trip over. */
    const q = at(d, KIOSK_R - 8.0);
    ctx.floorQuad('hazard', 2.6, 14, q[0], q[1], yaw, 0.12, 4);
    for (let i = 0; i < 8; i++) {
      inst(ctx, K.marker, ...at3(d, KIOSK_R - 2.0 - i * 1.6, 0.14), yaw);
    }

    const l = new THREE.PointLight(0xffd9a8, 520, 26, 2);
    l.position.copy(ctx.P(c[0], 6.0, c[1]));
    l.castShadow = false;
    ctx.group.add(l);
  }

  ctx.mmPath(KIOSK_BEARINGS.map((d) => at(d, KIOSK_R)), 'rgba(255,220,150,0.7)', 5, false);
}

/* ------------------------------------------------------------------ */
/* Galley Provisions - the merchant's stall                            */
/* ------------------------------------------------------------------ */

function buildProvisions(ctx, K) {
  const yaw = A(STALL_A);
  const c = at(STALL_A, STALL_R);

  ctx.box('panelWarm', 5.4, 1.05, 1.4, c[0], 0.52, c[1], yaw);
  ctx.box('trim', 5.4, 0.1, 1.7, c[0], 1.1, c[1], yaw);
  ctx.box('trimDark', 5.4, 0.2, 1.1, c[0], 0.1, c[1], yaw);
  ctx.solid(c[0], 0.6, c[1], 2.7, 0.6, 0.85, yaw);

  const b = at(STALL_A, STALL_R + 3.4);
  ctx.box('panelDark', 5.8, 3.4, 0.6, b[0], 1.7, b[1], yaw);
  ctx.solid(b[0], 1.7, b[1], 2.9, 1.7, 0.35, yaw);
  for (const sy of [1.05, 1.85, 2.65]) {
    ctx.box('trim', 5.2, 0.08, 0.6, ...at3(STALL_A, STALL_R + 3.0, sy), yaw);
    for (let k = -2; k <= 2; k++) {
      inst(ctx, K.crate, ...at3(STALL_A, STALL_R + 3.0, sy + 0.31, k * 1.05),
        yaw + (ctx.rng() - 0.5) * 0.3, 0.72, 0.72, 0.72);
    }
  }
  // Medical green on the top shelf: half of what is sold here is not food.
  ctx.box('emGreen', 4.6, 0.1, 0.16, ...at3(STALL_A, STALL_R + 2.7, 3.05), yaw);

  // Canopy on two posts, with the fascia hung under it.
  ctx.box('panelWarm', 6.4, 0.18, 4.0, ...at3(STALL_A, STALL_R + 0.9, 3.5), yaw);
  for (const s of [-2.9, 2.9]) {
    const p = at(STALL_A, STALL_R - 0.9, s);
    ctx.box('trim', 0.16, 3.5, 0.16, p[0], 1.75, p[1], yaw);
    ctx.solid(p[0], 1.75, p[1], 0.1, 1.75, 0.1, yaw);
  }
  ctx.sign(32, 4.8, 1.2, ...at3(STALL_A, STALL_R - 1.0, 2.85), yaw + Math.PI, {
    accent: ctx.accent, thickness: 0.2,
  });

  ctx.contact(c[0], c[1], 14);
  ctx.mmRect(c[0], c[1], 6.4, 4.6, yaw, 'rgba(180,140,80,0.6)', 'rgba(255,210,140,0.7)');
  // Behind the shelving, where only somebody who walked round the back looks.
  ctx.relic(...at3(STALL_A, STALL_R + 3.9, 1.9, 2.2), 'rare');

  const l = new THREE.PointLight(0xffcf90, 420, 24, 2);
  l.position.copy(ctx.P(...at3(STALL_A, STALL_R - 0.5, 3.2)));
  l.castShadow = false;
  ctx.group.add(l);
}

/* ------------------------------------------------------------------ */
/* The dining floor                                                    */
/* ------------------------------------------------------------------ */

/**
 * THE HALL: ten ranks of tables round the arcade, filled sector by sector.
 *
 * The old dining floor was three thin rings of furniture on two flanks, and it
 * had the problem every sparse dressing pass has - 113,000 m2 of deck with 600
 * props on it photographs as an empty room somebody has left a few tables in.
 * This is the opposite approach: the grid at the top of the file reserves the
 * circulation FIRST, and then every square metre that is not a corridor, a
 * spoke, a queue route or the arrival funnel gets furniture until it is full.
 *
 * The ranks are the load-bearing idea. A refectory table is 9 to 12 m of
 * furniture in one object, seating twelve to sixteen; five of them deep in each
 * band and forty round the arc, and the hall reads as a mess hall from the
 * moment a player steps out of the link - because that is what a mess hall is,
 * a room in which the tables go all the way to the walls.
 *
 * Rows alternate module so no sightline crosses ten of the same thing: a rank,
 * a ring of round eights, a rank, a block of booths and a rank; then across the
 * mid corridor two more ranks, another ring of eights, and two ranks out under
 * the mezzanine.
 */
function buildDiningFields(ctx, K) {
  /* Radius, tangential pitch, module, table length, and the chance that any
   * one side of any one table has somebody at it.
   *
   * That last number is small on purpose and it is the single most load-bearing
   * value in the file. The hall now seats about five thousand; a tenth of them
   * is five hundred figures, which is already more people than the rest of the
   * station put together and is what a shift change in a room this size looks
   * like. Filling the seats would be sixty times the actor cost for a frame
   * that reads as worse - a hall at capacity is a stadium, and the empty
   * tables are what tell you this one is between services.
   *
   * The near rows are busier than the far ones because people sit where they
   * came in, which is also why the two rows nearest the promenade get the
   * highest numbers and the back of band 2 gets the lowest. */
  const ROWS = [
    [BAND1_ROWS[0], 12.0, 'rank', 9, 0.13],
    [BAND1_ROWS[1], 10.5, 'round', 0, 0.13],
    [BAND1_ROWS[2], 14.0, 'rank', 11, 0.11],
    [BAND1_ROWS[3], 14.5, 'booth', 0, 0.13],
    [BAND1_ROWS[4], 12.0, 'rank', 9, 0.09],
    [BAND2_ROWS[0], 14.0, 'rank', 11, 0.09],
    [BAND2_ROWS[1], 13.0, 'rank', 10, 0.08],
    [BAND2_ROWS[2], 10.5, 'round', 0, 0.09],
    [BAND2_ROWS[3], 15.0, 'rank', 12, 0.07],
    [BAND2_ROWS[4], 13.0, 'rank', 10, 0.06],
  ];
  for (const [rad, pitch, kind, len, occ] of ROWS) placeRow(ctx, K, rad, pitch, kind, len, occ);

  /* --- Planted dividers along the band edges --------------------------- *
   * On the inner edge of each band, in runs with a gap every fourth unit so
   * the band is bounded without being walled. This is what stops ten ranks of
   * the same table reading as one undifferentiated field seen end-on. */
  for (const rad of [122.3, 153.8]) {
    ringFill(ctx, rad, 15.5, 3.2, (d, i, n) => {
      if (n % 4 === 3) return;
      plantedDivider(ctx, K, d, rad);
    });
  }

  /* --- Lighting over the deepest rows ----------------------------------- *
   * The arcade plate is 30 m up, so a pendant hung from it would need a 28 m
   * flex. Row 137 carries its own truss at 6.2; the rest get pendants on
   * short drops, which is also the only thing giving the back of the hall a
   * height a player can judge. Nothing hangs where the mezzanine is overhead. */
  ringFill(ctx, BAND1_ROWS[2], 14.0, 5.5, (d) => {
    const yaw = A(d);
    const c = at(d, BAND1_ROWS[2]);
    ctx.box('beam', 10.4, 0.35, 0.35, c[0], 6.2, c[1], yaw);
    ctx.box('emWhite', 9.0, 0.10, 0.30, c[0], 5.95, c[1], yaw);
    for (const s of [-4.9, 4.9]) {
      const p = at(d, BAND1_ROWS[2], s);
      ctx.box('trim', 0.2, 6.2, 0.2, p[0], 3.1, p[1], yaw);
      ctx.solid(p[0], 3.1, p[1], 0.12, 3.1, 0.12, yaw);
    }
  });
  for (const rad of [BAND1_ROWS[0], BAND2_ROWS[0], BAND2_ROWS[3]]) {
    ringFill(ctx, rad, 7.5, 0, (d) => {
      if (underMezz(d, rad)) return;
      const c = at(d, rad);
      ctx.box('trim', 0.05, 1.2, 0.05, c[0], 5.4, c[1], A(d));
      inst(ctx, K.pendantShade, c[0], 4.7, c[1], A(d));
      inst(ctx, K.pendantBulb, c[0], 4.56, c[1], A(d));
    });
  }
}

/** True where the mezzanine deck is overhead, and a 6 m truss would not fit. */
function underMezz(deg, rad) {
  return rad > MEZZ_R0 - 3 && rad < MEZZ_R1 + 3 && inArc(deg, MEZZ_A0 - 3, MEZZ_A1 + 3);
}

/**
 * One ring of one module, laid at `pitch` metres round whatever arc is free.
 *
 * `pad` is half the tangential size of the module, handed to `blocked` so a
 * 12 m table is rejected when its END would cross a spoke rather than when its
 * middle would - the difference between a clear 6.8 m route and one with a
 * table lying across both ends of it.
 */
function placeRow(ctx, K, rad, pitch, kind, len, occ) {
  const pad = kind === 'rank' ? len / 2 : kind === 'booth' ? 5.8 : 4.6;
  return ringFill(ctx, rad, pitch, pad, (d) => {
    if (kind === 'rank') {
      refectoryRank(ctx, K, d, rad, len, occ);
      // A high chair at one rank in six, which is the cheapest available way
      // of saying that the people down the corridor have children.
      if (ctx.rng() > 0.84) {
        const p = at(d, rad + 1.6, len / 2 - 1.2);
        inst(ctx, K.highChair, p[0], 0.46, p[1], faceIn(d));
        ctx.solid(p[0], 0.46, p[1], 0.2, 0.46, 0.2, A(d));
      }
    } else if (kind === 'booth') {
      boothBlock(ctx, K, d, rad, occ);
    } else {
      // Two eights to a slot, so the ring reads as clusters and not as beads.
      for (const s of [-2.7, 2.7]) {
        const c = at(d, rad, s);
        seatedRound(ctx, K, c[0], c[1], A(d) + (ctx.rng() - 0.5) * 0.8, 8, occ);
      }
    }
  });
}

/**
 * A round group table with people at some of its places.
 *
 * Filled in a contiguous arc of chairs rather than at random seats: six people
 * spread evenly round an eight-top is a committee, and three of them next to
 * each other with the far side clear is lunch.
 */
function seatedRound(ctx, K, lx, lz, yaw, n, occ) {
  const places = roundGroup(ctx, K, lx, lz, yaw, n);
  if (ctx.rng() > occ) return 0;
  const take = 2 + Math.floor(ctx.rng() * (n - 2));
  const from = Math.floor(ctx.rng() * n);
  for (let k = 0; k < take; k++) {
    const p = places[(from + k) % n];
    const look = faceTo(p[0], p[1], lx, lz);
    seat(ctx, K, p[0], p[1], 0, look, SEAT);
    const t = [lx + (p[0] - lx) * 0.55, lz + (p[1] - lz) * 0.55];
    inst(ctx, K.tray, t[0], 0.80, t[1], look);
    if (ctx.rng() > 0.45) inst(ctx, K.mug, t[0] + 0.15, 0.84, t[1] + 0.1, ctx.rng() * TAU);
  }
  return take;
}

/* ------------------------------------------------------------------ */
/* The island                                                          */
/* ------------------------------------------------------------------ */

/**
 * THE ISLAND: eight counters in a ring under the dome, facing outward.
 *
 * The hero servery on the far rim is a wall of food seen end-on from 300 m and
 * it is the frame this zone exists to produce - but it is ONE counter, and a
 * hall that feeds a station has more than one thing to eat at. So the court
 * carries the rest of the menu, arranged as a ring rather than a line: a
 * counter you walk AROUND has eight fronts and eight queues and can be reached
 * from whichever side of the hall you happen to be eating on, which is the
 * whole argument for putting the second servery in the middle of the room.
 *
 * The gaps between the bays sit on the cardinal spokes, so the ring is a thing
 * you walk through on the way to the tower rather than a wall across the court.
 */
function buildIsland(ctx, K) {
  /* Eight fronts, each with what it actually serves standing on it, and eight
   * gaps between them. Four of the gaps are on the quarter bearings the court
   * is crossed on - 0 is the arrival funnel, 90, 180 and 270 are spokes - so
   * the ring never stands between a player and the way they were going. The
   * two longest fronts are the ones with no queue: salad is help-yourself and
   * dessert is where the trays of the day end up. */
  const BAYS = [
    [18, 52, 'hot'],
    [56, 86, 'grill'],
    [94, 124, 'noodle'],
    [128, 176, 'salad'],
    [184, 214, 'bakery'],
    [218, 266, 'dessert'],
    [274, 304, 'coffee'],
    [308, 342, 'self'],
  ];

  for (const [b0, b1, kind] of BAYS) {
    arcRun(b0, b1, ISLAND_R, 6.0, (d, i) => {
      const yaw = A(d);
      const c = at(d, ISLAND_R);

      // The counter, its top, its kickplate and the tray rail on the front.
      ctx.box('panelWarm', 5.5, 1.02, 1.5, c[0], 0.51, c[1], yaw);
      ctx.box('trim', 5.5, 0.10, 1.85, c[0], 1.07, c[1], yaw);
      ctx.box('trimDark', 5.5, 0.22, 1.1, c[0], 0.11, c[1], yaw);
      ctx.box('trim', 5.5, 0.07, 0.30, ...at3(d, ISLAND_R + 1.05, 0.94), yaw);
      ctx.solid(c[0], 0.60, c[1], 2.75, 0.60, 1.0, yaw);

      // The back line, which is what the staff work at and what the canopy
      // posts land on. It faces the middle of the ring, so it is inboard.
      const g = at(d, ISLAND_R - 2.3);
      ctx.box('panelDark', 5.5, 3.0, 0.7, g[0], 1.5, g[1], yaw);
      ctx.box('trim', 5.5, 0.12, 1.0, g[0], 1.72, g[1], yaw);
      ctx.solid(g[0], 1.5, g[1], 2.75, 1.5, 0.4, yaw);

      if (kind === 'hot' || kind === 'grill') {
        ctx.box('grate', 4.6, 0.10, 1.0, ...at3(d, ISLAND_R + 0.1, 1.14), yaw);
        ctx.box('emSodium', 4.2, 0.06, 0.76, ...at3(d, ISLAND_R + 0.1, 1.19), yaw);
        for (const s of [-1.3, 1.3]) {
          inst(ctx, K.puff, ...at3(d, ISLAND_R + 0.1, 2.3, s), faceOut(d), 0.8, 0.8, 0.8);
        }
        ctx.box('trimDark', 5.5, 1.1, 2.4, ...at3(d, ISLAND_R - 0.4, 3.6), yaw);
      } else if (kind === 'noodle') {
        for (const s of [-1.6, 1.6]) {
          inst(ctx, K.urn, ...at3(d, ISLAND_R + 0.2, 1.45, s), yaw);
          ctx.box('emAmber', 0.16, 0.05, 0.06, ...at3(d, ISLAND_R - 0.3, 1.3, s), yaw);
        }
        inst(ctx, K.puff, ...at3(d, ISLAND_R + 0.5, 2.6), faceOut(d), 0.7, 0.7, 0.7);
        ctx.box('trimDark', 5.5, 1.1, 2.4, ...at3(d, ISLAND_R - 0.4, 3.6), yaw);
      } else if (kind === 'salad') {
        ctx.box('trimDark', 4.8, 0.24, 1.05, ...at3(d, ISLAND_R + 0.05, 1.22), yaw);
        ctx.box('emWhite', 4.4, 0.05, 0.8, ...at3(d, ISLAND_R + 0.05, 1.35), yaw);
        ctx.put('glassWindow', new THREE.PlaneGeometry(5.0, 0.85), ...at3(d, ISLAND_R + 0.8, 1.82), yaw);
        for (let s = -2; s <= 2; s++) inst(ctx, K.tray, ...at3(d, ISLAND_R + 0.05, 1.36, s), yaw);
      } else if (kind === 'bakery' || kind === 'dessert') {
        ctx.put('glassWindow', new THREE.PlaneGeometry(5.0, 0.9), ...at3(d, ISLAND_R + 0.78, 1.6), yaw);
        for (const sy of [1.25, 1.75]) {
          ctx.box('trim', 4.8, 0.06, 0.85, ...at3(d, ISLAND_R + 0.1, sy), yaw);
          for (let s = -2; s <= 2; s++) inst(ctx, K.tray, ...at3(d, ISLAND_R + 0.1, sy + 0.05, s), yaw);
        }
        ctx.box('emAmber', 4.6, 0.08, 0.14, ...at3(d, ISLAND_R + 0.55, 2.2), yaw);
      } else {
        // Coffee and the self-service run: urns, taps and a rank of cups.
        for (const s of [-1.7, 0, 1.7]) {
          inst(ctx, K.urn, ...at3(d, ISLAND_R - 0.2, 1.45, s), yaw, 0.8, 0.85, 0.8);
          for (let k = 0; k < 3; k++) {
            inst(ctx, K.cupStack, ...at3(d, ISLAND_R + 0.7, 1.27 + k * 0.02, s + 0.35), yaw);
          }
        }
        ctx.box('emCyan', 4.8, 0.08, 0.14, ...at3(d, ISLAND_R - 1.9, 2.5), yaw);
        if (kind === 'self') inst(ctx, K.puff, ...at3(d, ISLAND_R, 2.5), faceOut(d), 0.5, 0.5, 0.5);
      }

      // Somebody behind every second bay, except on the self-service run.
      if (kind !== 'self' && i % 2 === 0) {
        const p = at(d, ISLAND_R - 1.5, (ctx.rng() - 0.5) * 1.6);
        ctx.actor(p[0], 0, p[1], {
          localYaw: faceOut(d),
          activity: ctx.rng() > 0.6 ? 'carry' : 'stand',
          phase: K.phase(),
          speed: 0.8 + ctx.rng() * 0.4,
          variant: 'hiviz',
        });
        K.people++;
      }
    });

    // The fascia over each front, and a totem out in the apron naming it.
    const mid = (b0 + b1) / 2;
    ctx.sign(31, 5.4, 1.35, ...at3(mid, ISLAND_R + 1.2, 4.6), A(mid), {
      accent: ctx.accent, thickness: 0.22,
    });
    menuTotem(ctx, K, mid + 6, 48.5);
    if (kind !== 'self') queueRun(ctx, K, mid - 5, mid + 5, 46.6);
  }

  /* --- The canopy ------------------------------------------------------- *
   * A ring of plate 7 m up on posts off the back line. It is here so the
   * island has a silhouette from the arrival plaza 190 m away: a 1 m counter
   * on flat deck at that range is a smudge, and the thing has to read as a
   * building or nobody walks toward it. */
  arcRun(0, 360, ISLAND_R - 1.2, 9.0, (d) => {
    const c = at(d, ISLAND_R - 1.2);
    ctx.box('panelDark', 9.4, 0.35, 6.6, c[0], 7.0, c[1], A(d));
    ctx.box(ctx.accent, 9.0, 0.14, 0.2, ...at3(d, ISLAND_R + 1.9, 6.7), A(d));
  });
  for (const d of [24, 68, 112, 156, 200, 244, 288, 332]) {
    const p = at(d, ISLAND_R - 2.6);
    ctx.box('trim', 0.42, 7.0, 0.42, p[0], 3.5, p[1], A(d));
    ctx.solid(p[0], 3.5, p[1], 0.25, 3.5, 0.25, A(d));
  }
  /* Extraction, off the canopy rather than out of the middle.
   *
   * The obvious place for the stack is the centre of the ring, and the centre
   * of the ring is 42 m of nothing with the grow tower's 4.8 m shaft standing
   * in it. So the hot lines vent through four risers off the canopy edge
   * instead, which is also what puts the ring's only vertical elements where
   * they are seen against the dome rather than lost against the tower. */
  for (const d of [34, 106, 214, 286]) {
    const p = at(d, ISLAND_R - 1.0);
    ctx.box('trimDark', 1.6, 5.4, 1.6, p[0], 9.9, p[1], A(d));
    ctx.box('grate', 2.0, 0.9, 2.0, p[0], 12.9, p[1], A(d));
  }

  /* --- Standing tables round the outside of the apron -------------------- */
  ringFill(ctx, 51.5, 9.5, 1.6, (d) => {
    const c = at(d, 51.5);
    const stools = highTable(ctx, K, c[0], c[1], A(d), 3);
    if (ctx.rng() > 0.90) {
      const [p, look] = stools[Math.floor(ctx.rng() * stools.length)];
      ctx.actor(p[0], 0, p[1], {
        localYaw: look,
        activity: ctx.rng() > 0.5 ? 'eat' : 'sit',
        amount: STOOL_SEAT,
        phase: K.phase(),
        speed: 0.85 + ctx.rng() * 0.3,
      });
      K.people++;
    }
  });

  /* --- Bins, fountains and tray trolleys round the apron edge ------------ */
  ringFill(ctx, 54.5, 26, 1.6, (d, i) => {
    if (i % 3 === 0) {
      binBank(ctx, K, d, 54.5);
    } else if (i % 3 === 1) {
      const c = at(d, 54.5);
      inst(ctx, K.fountain, c[0], 0.52, c[1], A(d));
      ctx.box('trim', 0.7, 0.12, 0.5, c[0], 1.1, c[1], A(d));
      ctx.solid(c[0], 0.52, c[1], 0.32, 0.52, 0.26, A(d));
    } else {
      const c = at(d, 54.5);
      inst(ctx, K.trolley, c[0], 0.43, c[1], A(d));
      inst(ctx, K.trolleyShelf, c[0], 0.90, c[1], A(d));
      for (let k = 0; k < 5; k++) inst(ctx, K.tray, c[0], 0.94 + k * 0.045, c[1], A(d));
      ctx.solid(c[0], 0.43, c[1], 0.47, 0.43, 0.35, A(d));
    }
  });

  for (const d of [30, 120, 210, 300]) {
    const l = new THREE.PointLight(0xffc08a, 1400, 48, 2);
    l.position.copy(ctx.P(...at3(d, ISLAND_R, 6.2)));
    l.castShadow = false;
    ctx.group.add(l);
  }
  ctx.mmCircle(0, 0, ISLAND_R, 'rgba(150,110,70,0.25)', 'rgba(255,200,140,0.55)');
  // Kicked under the self-service run, where only somebody stooping finds it.
  ctx.relic(...at3(300, ISLAND_R - 2.9, 0.5), 'rare');
}

/* ------------------------------------------------------------------ */
/* The court dining                                                    */
/* ------------------------------------------------------------------ */

/**
 * Seven rings of tables filling the court between the island and the rim.
 *
 * The court used to be one tall object with a thin scatter of cafe tables at
 * 70 m, on the argument that the middle of the room should feel like there is
 * room in it. That is the right instinct for a plaza and the wrong one for a
 * canteen: the middle of a mess hall is where the mess hall is. The tower and
 * the processional keep the arrival sightline; everything either side of them
 * is somebody's lunch.
 */
/**
 * The refectory block - the galley's one enterable building.
 *
 * ── Why the canteen needs a building in it ────────────────────────────────
 * The Long Galley is a single 400 m room. That is the right shape for a mess
 * hall and the wrong shape for a place with anywhere to go: from the corridor
 * mouth you can already see everything the zone contains. The brief asks for
 * an enterable building in each of the four outer zones and this had none. A
 * refectory block - kitchens' offices, dry store, crew mess rooms stacked over
 * the floor they feed - is what a galley this size would actually have.
 *
 * ── 255 degrees at 68 m, and every constraint that fixes it ───────────────
 *   HEIGHT. The arcade plate outside r = 112 is at 30 m and `buildTower`
 *   clamps to seven storeys (29.7 m to the parapet), so a tower can only stand
 *   in the court. At this footprint the dome is 118.4 m up: 88.7 m of clearance.
 *
 *   BEARING. 255 is the exact midpoint of the 240 and 270 spokes. At r = 68 a
 *   30-degree sector is 35.6 m of arc; taking `SPOKE_HALF` off each side
 *   leaves 28.8 m, which is why the block is 24 m wide and not the 26 the hub
 *   towers use. It also sits 75 degrees off the arrival axis and on the
 *   opposite side of the deck from the servery fan (141-217) and Galley
 *   Provisions (211-233), so it balances the mezzanine's mass at 66-116
 *   without competing with anything.
 *
 *   RADIUS. 57 to 79 m, plus 3.4 m of entrance steps reaching in to 53.6. That
 *   lands inside the court dining band (53-80) and crosses no circulation: the
 *   court ring corridor at 80-85, the promenade at 116.5-121.5 and all eleven
 *   spokes are untouched. The dining that would have been here is not deleted,
 *   it is displaced - every one of those rings is laid by `ringFill`, which
 *   consults `blocked()`, which reads the `KEEPOUT` row added above.
 */
const REFECTORY = { deg: 255, r: 68, w: 24, d: 22, floors: 7 };

function buildRefectoryBlock(ctx) {
  const bearing = REFECTORY.deg * DEG;
  const built = buildZoneTower(ctx, {
    bearing, r: REFECTORY.r,
    w: REFECTORY.w, d: REFECTORY.d, floors: REFECTORY.floors,
    label: 'Refectory Block',
    body: 'panelWarm',
    fit: 'office',
  });

  // A practical over the door. The galley is lit warm; the entrance has to
  // read as a way in from the far side of the court.
  const [lx, lz] = at(REFECTORY.deg, REFECTORY.r - 15);
  const light = new THREE.PointLight(ctx.spec.accentHex, 1600, 48, 2);
  light.position.copy(ctx.P(lx, 6, lz));
  light.castShadow = false;
  ctx.group.add(light);

  return built;
}

function buildCourtHall(ctx, K) {
  const ROWS = [
    [COURT_ROWS_IN[0], 9.0, 'round6', 0, 0.15],
    [COURT_ROWS_IN[1], 12.0, 'rank', 9, 0.12],
    [COURT_ROWS_IN[2], 10.5, 'round', 0, 0.12],
    [COURT_ROWS_IN[3], 14.0, 'rank', 11, 0.10],
    [COURT_ROWS_IN[4], 13.0, 'rank', 10, 0.09],
    [COURT_ROWS_OUT[0], 15.0, 'rank', 12, 0.07],
    [COURT_ROWS_OUT[1], 10.5, 'round', 0, 0.08],
    [COURT_ROWS_OUT[2], 14.0, 'rank', 11, 0.06],
  ];
  for (const [rad, pitch, kind, len, occ] of ROWS) {
    if (kind === 'round6') {
      ringFill(ctx, rad, pitch, 2.6, (d) => {
        const c = at(d, rad);
        seatedRound(ctx, K, c[0], c[1], A(d) + (ctx.rng() - 0.5) * 0.8, 6, occ);
      });
    } else {
      placeRow(ctx, K, rad, pitch, kind, len, occ);
    }
  }

  /* --- Dividers either side of the court corridor ------------------------ */
  for (const rad of [79.6, 85.4]) {
    ringFill(ctx, rad, 17, 3.2, (d, i, n) => {
      if (n % 3 === 2) return;
      plantedDivider(ctx, K, d, rad, 0.9);
    });
  }

  /* --- Service along the court corridor ---------------------------------- */
  ringFill(ctx, COURT_MID_R, 34, 1.6, (d, i) => {
    if (i % 2 === 0) binBank(ctx, K, d, COURT_MID_R);
    else menuTotem(ctx, K, d, COURT_MID_R);
  });

  /* --- Coat rails and screens on the outer rim of the court -------------- */
  ringFill(ctx, 105.5, 22, 1.4, (d, i) => {
    const c = at(d, 105.5);
    if (i % 2 === 0) {
      inst(ctx, K.coatRail, c[0], 1.62, c[1], A(d));
      for (const s of [-1.1, 1.1]) {
        const p = at(d, 105.5, s);
        ctx.box('trim', 0.09, 1.7, 0.09, p[0], 0.85, p[1], A(d));
      }
      ctx.solid(c[0], 0.85, c[1], 1.25, 0.85, 0.1, A(d));
    } else {
      inst(ctx, K.screen, c[0], 0.78, c[1], A(d));
      ctx.solid(c[0], 0.78, c[1], 1.3, 0.78, 0.08, A(d));
    }
  });

  // Under the back of the outer ring, where a bench hides it from the aisle.
  ctx.relic(...at3(258, COURT_ROWS_OUT[2] + 1.06, 0.3), 'common');
}

/* ------------------------------------------------------------------ */
/* Service furniture                                                   */
/* ------------------------------------------------------------------ */

/**
 * Everything a dining hall needs that is not a table: the beverage stations,
 * the bussing points, the dish-return runs, the trolleys and the signage.
 *
 * All of it goes on the EDGES of the circulation rather than inside the bands,
 * because that is where somebody carrying a tray actually stops - and because
 * a bin in the middle of a rank field is a bin nobody can reach without
 * climbing over somebody's lunch.
 */
function buildServiceRun(ctx, K) {
  /* Where the service furniture is allowed to stand.
   *
   * Not in the corridors. A ring corridor with a bin bank on its centreline is
   * not a 5 m corridor with a bin in it, it is two 1.8 m corridors, and the
   * whole point of reserving the circulation before laying a single table was
   * to not then fill it in with the last pass. So the three runs go:
   *
   *   COURT_EDGE   114.9   on the court side of the promenade, in the 15 m of
   *                        clear deck between the saplings and the arcade
   *   MID_EDGE     148.4   flush against band 1's back, projecting 0.7 m into
   *                        a 5.5 m gap and leaving 4.2 m of it walkable
   *   WINDOW_EDGE  186.0   inside the window band, not in the corridor at all
   *
   * and every module in them is under 1.4 m deep, which is what makes the
   * middle one fit. The hatch on a dish return and the fountain beside a
   * trolley are set out TANGENTIALLY for the same reason - both were radial,
   * and both turned a 1.1 m module into a 2.8 m one.
   */
  const COURT_EDGE = 114.9, MID_EDGE = 148.4, WINDOW_EDGE = 186.0;

  /* --- Self-service beverage stations, off the court edge ---------------- *
   * The one thing in the hall that everybody uses and nobody queues for, so
   * it goes where the walk round the court passes it rather than behind a
   * counter somebody has to join a line to reach. */
  ringFill(ctx, 111.8, 42, 3.2, (d) => {
    const yaw = A(d);
    const c = at(d, 111.8);
    ctx.box('panelWarm', 4.4, 0.98, 1.3, c[0], 0.49, c[1], yaw);
    ctx.box('trim', 4.4, 0.10, 1.6, c[0], 1.04, c[1], yaw);
    ctx.box('panelTeal', 4.4, 1.9, 0.45, ...at3(d, 110.6, 1.95), yaw);
    ctx.box(ctx.accent, 3.8, 0.10, 0.12, ...at3(d, 110.8, 2.75), yaw);
    ctx.solid(c[0], 0.55, c[1], 2.2, 0.55, 0.8, yaw);
    ctx.solid(...at3(d, 110.6, 1.95), 2.2, 0.95, 0.25, yaw);
    ctx.contact(c[0], c[1], 8);
    for (const s of [-1.4, 0, 1.4]) {
      inst(ctx, K.urn, ...at3(d, 111.4, 1.33, s), yaw, 0.75, 0.8, 0.75);
      for (let k = 0; k < 4; k++) {
        inst(ctx, K.cupStack, ...at3(d, 112.2, 1.24 + k * 0.02, s + 0.5), yaw);
      }
    }
    inst(ctx, K.caddy, ...at3(d, 112.3, 1.18, -1.9), yaw);
    menuTotem(ctx, K, d + 3.4, 111.8);
  });

  /* --- Bussing points, bins and dish returns ----------------------------- */
  for (const [rad, step] of [[COURT_EDGE, 26], [MID_EDGE, 30], [WINDOW_EDGE, 34]]) {
    ringFill(ctx, rad, step, 1.8, (d, i) => {
      // The window band already has the quiet gallery's own rail through it.
      if (rad === WINDOW_EDGE && inArc(d, 244, 336)) return;
      const yaw = A(d);
      const c = at(d, rad);
      if (i % 3 === 2) {
        // A dish-return conveyor stub: a belt into a hatch, which is where a
        // tray actually goes when a player has finished with it. The hatch is
        // beside the belt, not behind it - a 2.8 m deep module does not fit in
        // any corridor edge in this hall.
        ctx.box('trimDark', 3.2, 0.78, 1.1, c[0], 0.39, c[1], yaw);
        ctx.box('rubber', 3.2, 0.12, 0.9, c[0], 0.84, c[1], yaw);
        ctx.box('trim', 3.2, 0.16, 0.16, ...at3(d, rad - 0.5, 1.02), yaw);
        ctx.box('panelDark', 1.4, 1.5, 1.1, ...at3(d, rad, 0.75, 2.3), yaw);
        ctx.solid(c[0], 0.45, c[1], 1.6, 0.45, 0.58, yaw);
        ctx.solid(...at3(d, rad, 0.75, 2.3), 0.7, 0.75, 0.55, yaw);
        ctx.contact(c[0], c[1], 7);
        for (const s of [-1.0, 0.6]) inst(ctx, K.tray, ...at3(d, rad, 0.92, s), yaw + s * 0.2);
      } else if (i % 3 === 1) {
        binBank(ctx, K, d, rad);
      } else {
        inst(ctx, K.trolley, c[0], 0.43, c[1], yaw);
        inst(ctx, K.trolleyShelf, c[0], 0.90, c[1], yaw);
        for (let k = 0; k < 6; k++) inst(ctx, K.tray, c[0], 0.94 + k * 0.045, c[1], yaw);
        inst(ctx, K.fountain, ...at3(d, rad, 0.52, 1.5), yaw);
        ctx.solid(c[0], 0.45, c[1], 0.5, 0.45, 0.4, yaw);
        ctx.solid(...at3(d, rad, 0.52, 1.5), 0.32, 0.52, 0.26, yaw);
        ctx.contact(c[0], c[1], 5);
      }
    });
  }

  /* --- Every spoke mouth announced off the promenade --------------------- *
   * A spoke is only a route if it is legible as one from inside a rank field,
   * so each gets a marker post either side of its mouth and a totem beyond.
   * The posts stand at SPOKE_HALF + 0.6, which is OUTSIDE the reserved width -
   * a gate that narrows the gap it marks is worse than no gate. */
  for (const s of SPOKES) {
    for (const side of [-1, 1]) {
      const p = at(s, 123.2, side * (SPOKE_HALF + 0.7));
      if (blocked(s, 123.2)) continue;
      inst(ctx, K.qPost, p[0], 0.48, p[1], A(s));
      ctx.box('panelDark', 0.7, 2.2, 0.2, p[0], 1.1, p[1], A(s));
      ctx.solid(p[0], 1.1, p[1], 0.35, 1.1, 0.1, A(s));
    }
    if (!blocked(s + 2.8, 123.2)) menuTotem(ctx, K, s + 2.8, 123.2);
  }

  /* --- Coat rails and screens along the window band ---------------------- */
  ringFill(ctx, 184.9, 26, 1.4, (d, i) => {
    if (inArc(d, 244, 336)) return;
    const c = at(d, 184.9);
    if (i % 2 === 0) {
      inst(ctx, K.screen, c[0], 0.78, c[1], A(d));
      ctx.solid(c[0], 0.78, c[1], 1.3, 0.78, 0.08, A(d));
    } else {
      inst(ctx, K.coatRail, c[0], 1.62, c[1], A(d));
      for (const sx of [-1.1, 1.1]) {
        const p = at(d, 184.9, sx);
        ctx.box('trim', 0.09, 1.7, 0.09, p[0], 0.85, p[1], A(d));
      }
      ctx.solid(c[0], 0.85, c[1], 1.25, 0.85, 0.1, A(d));
    }
  });

  // Left on a tray trolley by the mid corridor, and behind a divider out west.
  ctx.relic(...at3(66, MID_EDGE, 1.15), 'common');
  ctx.relic(...at3(310, 153.8, 1.15), 'rare');
}

/* ------------------------------------------------------------------ */
/* The mezzanine                                                       */
/* ------------------------------------------------------------------ */

/**
 * A raised deck of booths on the east flank, 4.6 m up.
 *
 * The arcade is 88 m deep and dead flat, and one change of level is what a
 * 200 m room needs most: it gives the hall a horizon line, it gives the crowd
 * two heights to be seen at, and it puts a dozen people where somebody standing
 * on the dining floor has to look UP to see them, which no amount of floor
 * furniture can do.
 */
function buildMezzanine(ctx, K) {
  const RMID = (MEZZ_R0 + MEZZ_R1) / 2;
  const HALF_R = (MEZZ_R1 - MEZZ_R0) / 2;

  /* --- Deck, in six segments ------------------------------------------ *
   * Six rather than one: the capsule solver rejects a collider on its bounding
   * radius before anything else, and a single 145 m box would be a candidate
   * for every query in this half of the zone. Six 24 m boxes on a 167 m arc
   * sit within 0.44 m of the true curve, which is less than the fascia's own
   * thickness and nothing a capsule can feel. */
  arcRun(MEZZ_A0, MEZZ_A1, RMID, 24, (d) => {
    const c = at(d, RMID);
    const yaw = A(d);
    const halfT = (((MEZZ_A1 - MEZZ_A0) * DEG * RMID) / 6) / 2 + 0.4;
    ctx.box('panel', halfT * 2, 0.5, HALF_R * 2, c[0], MEZZ_Y - 0.25, c[1], yaw);
    ctx.solid(c[0], MEZZ_Y - 0.25, c[1], halfT, 0.25, HALF_R, yaw);
    ctx.roof(c[0], MEZZ_Y + 0.05, c[1]);
  });

  /* --- Columns, soffit and pendants underneath ------------------------ */
  arcRun(MEZZ_A0, MEZZ_A1, RMID, 15, (d) => {
    for (const r of [MEZZ_R0 + 1.5, MEZZ_R1 - 2.5]) {
      const p = at(d, r);
      ctx.box('trim', 0.6, 4.35, 0.6, p[0], 2.17, p[1], A(d));
      ctx.solid(p[0], 2.17, p[1], 0.35, 2.17, 0.35, A(d));
    }
    // Under the deck is a room of its own rather than the shadow of the one
    // above it, which is the whole difference between a mezzanine and a lid.
    const c = at(d, RMID);
    ctx.box('emAmber', 3.4, 0.1, 0.3, c[0], 4.2, c[1], A(d));
    ctx.box('trim', 0.05, 0.7, 0.05, c[0], 3.9, c[1], A(d));
    inst(ctx, K.pendantShade, c[0], 3.5, c[1], A(d));
    inst(ctx, K.pendantBulb, c[0], 3.36, c[1], A(d));
  });
  arcRun(MEZZ_A0, MEZZ_A1, MEZZ_R0, 9, (d) => {
    const p = at(d, MEZZ_R0);
    ctx.box('panelDark', 9.3, 1.1, 0.5, p[0], 4.35, p[1], A(d));
    ctx.box(ctx.accent, 8.6, 0.12, 0.16, p[0], 3.86, p[1], A(d));
  });

  /* --- Balustrade round the open edges -------------------------------- */
  arcRun(MEZZ_A0, MEZZ_A1, MEZZ_R0 + 0.4, 6, (d) => {
    // Cut where each stair arrives, or the flight ends in a fence.
    if (MEZZ_STAIRS.some((s) => Math.abs(d - s) < 2.6)) return;
    const p = at(d, MEZZ_R0 + 0.4);
    const yaw = A(d);
    ctx.put('glassWindow', new THREE.PlaneGeometry(4.6, 1.0), p[0], MEZZ_Y + 0.6, p[1], yaw + Math.PI);
    ctx.box('trim', 4.7, 0.1, 0.14, p[0], MEZZ_Y + 1.15, p[1], yaw);
    ctx.solid(p[0], MEZZ_Y + 0.6, p[1], 2.35, 0.6, 0.12, yaw);
  });
  for (const d of [MEZZ_A0, MEZZ_A1]) {
    for (let i = 0; i < 7; i++) {
      const r = MEZZ_R0 + 2.5 + i * 5;
      if (r > MEZZ_R1) break;
      const p = at(d, r);
      ctx.box('trim', 0.14, 1.15, 5.0, p[0], MEZZ_Y + 0.6, p[1], A(d));
      ctx.solid(p[0], MEZZ_Y + 0.6, p[1], 0.1, 0.6, 2.5, A(d));
    }
  }

  /* --- Two stairs up, one at each end ---------------------------------- *
   * `ctx.ramp`'s high end is its local +Z, and A(deg) points local +Z radially
   * outward - so these climb from the dining floor up to the deck's inner
   * edge. Their landings are why `KEEPOUT` has a hole either side. */
  for (const d of MEZZ_STAIRS) {
    const RUN = 11.5, RISE = MEZZ_Y;
    const pitch = Math.atan2(RISE, RUN);
    const len = Math.hypot(RUN, RISE);
    const p = at(d, MEZZ_R0 - RUN / 2);
    ctx.ramp(p[0], RISE / 2 - 0.25 / Math.cos(pitch), p[1], 5.0, RUN, RISE, A(d));
    ctx.put('grate', boxGeo(5.0, 0.28, len, 2), p[0], RISE / 2, p[1], A(d), -pitch, 0);
    for (const s of [-2.6, 2.6]) {
      const h = at(d, MEZZ_R0 - RUN / 2, s);
      ctx.put('trim', boxGeo(0.1, 0.1, len, 1), h[0], RISE / 2 + 1.0, h[1], A(d), -pitch, 0);
      ctx.put('panelDark', boxGeo(0.22, 1.0, len, 2), h[0], RISE / 2 + 0.45, h[1], A(d), -pitch, 0);
    }
    ctx.contact(p[0], p[1], 14);
  }

  /* --- The booths ------------------------------------------------------- *
   * Back to back down the middle of the deck, so the partition line is what a
   * player sees from below and the people are in the gaps between. */
  arcRun(MEZZ_A0 + 4, MEZZ_A1 - 4, RMID, 16, (d, i) => {
    for (const side of [-1, 1]) {
      const r = RMID + side * 5.6;
      const yaw = A(d);
      const c = at(d, r);
      ctx.box('panelWarm', 2.0, 0.09, 1.1, c[0], MEZZ_Y + 0.75, c[1], yaw);
      ctx.box('trimDark', 0.16, 0.72, 0.5, c[0], MEZZ_Y + 0.36, c[1], yaw);
      ctx.solid(c[0], MEZZ_Y + 0.6, c[1], 1.0, 0.25, 0.55, yaw);
      for (const s of [-1, 1]) {
        const b = at(d, r + s * 1.35);
        inst(ctx, K.boothSeat, b[0], MEZZ_Y + 0.23, b[1], yaw);
        inst(ctx, K.boothBack, ...at3(d, r + s * 1.95, MEZZ_Y + 0.81), yaw);
        ctx.solid(b[0], MEZZ_Y + 0.23, b[1], 1.0, 0.23, 0.29, yaw);
      }
      // Partition between this booth and the next one along.
      const w = at(d, r, 2.6);
      ctx.box('panelTeal', 0.16, 1.7, 3.6, w[0], MEZZ_Y + 0.85, w[1], yaw);
      ctx.solid(w[0], MEZZ_Y + 0.85, w[1], 0.1, 0.85, 1.8, yaw);

      const take = ctx.rng() > 0.48 ? (ctx.rng() > 0.5 ? 3 : 2) : 0;
      for (let k = 0; k < take; k++) {
        const s = k === 0 ? -1 : 1;
        const p = at(d, r + s * 1.35, k === 2 ? 0.6 : -0.15);
        seat(ctx, K, p[0], p[1], MEZZ_Y, s > 0 ? faceIn(d) : faceOut(d), BOOTH_SEAT);
      }
      if (take) laid(ctx, K, c[0], c[1], MEZZ_Y, yaw, Math.min(take, 3));

      // A tray kicked under a table and forgotten, and something left on top
      // of a partition where only somebody up here will ever see it.
      if (i === 1 && side < 0) ctx.relic(c[0], MEZZ_Y + 0.2, c[1], 'common');
      if (i === 4 && side > 0) ctx.relic(w[0], MEZZ_Y + 1.85, w[1], 'rare');
    }
  });

  for (const d of [MEZZ_A0 + 12, (MEZZ_A0 + MEZZ_A1) / 2, MEZZ_A1 - 12]) {
    const l = new THREE.PointLight(0xffc98a, 700, 34, 2);
    l.position.copy(ctx.P(...at3(d, RMID, MEZZ_Y + 4.5)));
    l.castShadow = false;
    ctx.group.add(l);
  }

  const mid = at((MEZZ_A0 + MEZZ_A1) / 2, RMID);
  ctx.mmRect(mid[0], mid[1], 130, MEZZ_R1 - MEZZ_R0, A((MEZZ_A0 + MEZZ_A1) / 2),
    'rgba(120,150,120,0.35)', 'rgba(200,255,210,0.5)');
}

/* ------------------------------------------------------------------ */
/* Against the glass                                                   */
/* ------------------------------------------------------------------ */

/**
 * The window seating: a standing bar on the east flank, a quiet gallery of
 * two-tops on the west.
 *
 * The perimeter is glazed above 6.4 m and looks out under the great dome at the
 * hub half a kilometre away, which is the best view in the zone and was being
 * spent on a strip of bare deck. Two different answers to the same wall because
 * they carry different people: the bar is where somebody eats in twenty minutes
 * standing up, the gallery is where somebody sits for an hour.
 */
function buildWindowSeating(ctx, K) {
  /* --- East: a bar counter facing out, cut where the spokes reach the glass */
  for (const [a0, a1] of [[24, 54], [126, 148]]) {
    arcRun(a0, a1, 190, 7, (d) => {
      if (blocked(d, 190, 3.2)) return;
      const yaw = A(d);
      const c = at(d, 190);
      ctx.box('panelWarm', 6.2, 0.12, 0.62, c[0], 1.03, c[1], yaw);
      ctx.box('trimDark', 6.2, 0.9, 0.24, ...at3(d, 190.3, 0.5), yaw);
      ctx.solid(c[0], 0.65, c[1], 3.1, 0.45, 0.35, yaw);
      // Bracket lamps off the perimeter: there is no ceiling to hang from and
      // the arcade wash dies 10 m short of the glass.
      ctx.box('trim', 0.14, 0.14, 2.2, ...at3(d, 192.4, 2.9), yaw);
      inst(ctx, K.pendantShade, ...at3(d, 191.4, 2.75), yaw);
      inst(ctx, K.pendantBulb, ...at3(d, 191.4, 2.61), yaw);
    });
    arcRun(a0, a1, 188.6, 4.4, (d) => {
      if (blocked(d, 188.6, 0.4)) return;
      const c = at(d, 188.6);
      inst(ctx, K.stool, c[0], 0.35, c[1], faceOut(d));
      // Roughly one stool in four is taken. A full bar with its back to the
      // room is a wall of shoulders, and it hides the view it exists for.
      if (ctx.rng() > 0.78) {
        ctx.actor(c[0], 0, c[1], {
          localYaw: faceOut(d),
          activity: ctx.rng() > 0.5 ? 'eat' : 'sit',
          amount: STOOL_SEAT,
          phase: K.phase(),
          speed: 0.85 + ctx.rng() * 0.3,
        });
        K.people++;
        inst(ctx, K.tray, ...at3(d, 190, 1.11), A(d));
      }
    });
  }

  /* --- West: the quiet gallery ----------------------------------------- */
  arcRun(250, 330, 188, 17, (d) => {
    if (blocked(d, 188, 1.3)) return;
    const yaw = A(d);
    const c = at(d, 188);
    twoTop(ctx, K, c[0], c[1], yaw);
    for (const s of [-1, 1]) {
      const p = at(d, 188 + s * 0.85);
      chair(ctx, K, p[0], p[1], 0, s > 0 ? faceIn(d) : faceOut(d));
    }
    if (ctx.rng() > 0.56) {
      const s = ctx.rng() > 0.5 ? 1 : -1;
      const p = at(d, 188 + s * 0.85);
      seat(ctx, K, p[0], p[1], 0, s > 0 ? faceIn(d) : faceOut(d), SEAT);
      laid(ctx, K, c[0], c[1], 0, yaw, 1);
    }
  });
  /* --- West: four-tops between the gallery and the rail ------------------ */
  arcRun(236, 344, 190.6, 9, (d) => {
    if (blocked(d, 190.6, 1.4)) return;
    if (inArc(d, 248, 332)) return;   // the quiet gallery has its own tables
    const c = at(d, 190.6);
    const yaw = A(d) + (ctx.rng() - 0.5) * 0.2;
    fourTop(ctx, K, c[0], c[1], yaw);
    const places = [];
    for (const [ox, oz] of [[0, 1.0], [0, -1.0], [1.0, 0], [-1.0, 0]]) {
      const p = off(c[0], c[1], yaw, ox, oz);
      chair(ctx, K, p[0], p[1], 0, faceTo(p[0], p[1], c[0], c[1]));
      places.push(p);
    }
    const r = ctx.rng();
    const take = r > 0.88 ? 3 : r > 0.74 ? 2 : 0;
    for (let i = 0; i < take; i++) {
      const p = places[i];
      seat(ctx, K, p[0], p[1], 0, faceTo(p[0], p[1], c[0], c[1]), SEAT);
    }
    if (take) laid(ctx, K, c[0], c[1], 0, yaw, take);
  });

  // A planted rail between the gallery and the dining floor, so the quiet end
  // reads as a separate room without a wall thrown across the arcade. It sits
  // on the window band's inner edge, not in the outer ring corridor - that
  // corridor is one of the two clear rings the whole hall circulates on.
  arcRun(248, 332, 184.4, 8, (d) => {
    if (blocked(d, 184.4, 3.2)) return;
    const yaw = A(d);
    const c = at(d, 184.4);
    ctx.box('panelTeal', 6.2, 0.95, 1.1, c[0], 0.48, c[1], yaw);
    ctx.box('trim', 6.2, 0.1, 1.3, c[0], 0.98, c[1], yaw);
    ctx.solid(c[0], 0.5, c[1], 3.1, 0.5, 0.6, yaw);
    for (const s of [-1.7, 1.7]) {
      const p = at(d, 184.4, s);
      shrub(ctx, K, p[0], p[1], 1.0, 0.85);
    }
  });
  {
    const p = at(290, 183.4);
    ctx.sign(22, 4.4, 1.1, p[0], 3.4, p[1], A(290) + Math.PI, { accent: 'emGreen', thickness: 0.16 });
    ctx.box('panelDark', 0.3, 3.4, 0.3, p[0], 1.7, p[1], A(290));
    ctx.solid(p[0], 1.7, p[1], 0.18, 1.7, 0.18, A(290));
  }

  for (const d of [270, 310, 40, 136]) {
    const l = new THREE.PointLight(0xffd2a0, 460, 28, 2);
    l.position.copy(ctx.P(...at3(d, 187, 4.5)));
    l.castShadow = false;
    ctx.group.add(l);
  }
}

/* ------------------------------------------------------------------ */
/* The garden court                                                    */
/* ------------------------------------------------------------------ */

/**
 * What the open middle of the zone is for.
 *
 * The court is 224 m across with the dome 98 m over it and no ceiling of its
 * own, and the brief for anything standing in it is simple: it has to be
 * legible from the arrival plaza 190 m away, or the walk across the deck has
 * nothing pulling it. So the answer is one tall object rather than a field of
 * short ones - a 34 m hydroponic grow tower, lit from inside, with the galley's
 * planting stacked up it in collars.
 *
 * It also has to be the reason the food exists, which is why it is a working
 * farm and not an ornament: this is where the green on the servery came from,
 * and the two are 130 m apart in the same frame.
 */
function buildGardenCourt(ctx, K) {
  const TOWER_H = 34;
  const GY = 6.0;   // the inspection gallery round the shaft

  /* --- The tower -------------------------------------------------------- */
  ctx.put('panelDark', cylGeo(4.0, 4.8, TOWER_H, 16, 4), 0, TOWER_H / 2, 0);
  ctx.solid(0, TOWER_H / 2, 0, 4.6, TOWER_H / 2, 4.6);
  // Growing collars up the shaft, each with a lit ring under it. The spacing
  // is even but the radius tapers, so the stack reads as a tower rather than
  // as a mast with rings on it.
  for (let i = 0; i < 8; i++) {
    const t = i / 7;
    const y = 8.5 + i * (TOWER_H - 12) / 7.5;
    const r = 7.4 - t * 2.2;
    ctx.put('panelTeal', cylGeo(r, r, 1.1, 14, 2), 0, y, 0);
    ctx.put('emGreen', cylGeo(r + 0.25, r + 0.25, 0.24, 14, 1), 0, y - 0.75, 0);
    for (let k = 0; k < 10; k++) {
      const a = (k / 10) * TAU + i * 0.31;
      inst(ctx, K.leaf, Math.sin(a) * (r - 0.3), y + 1.1, Math.cos(a) * (r - 0.3), a, 0.8, 0.8, 0.8);
    }
  }
  // The light head. From the link mouth 200 m away this is the last thing
  // still resolving, which is exactly the job it is here to do.
  ctx.put('trim', cylGeo(2.2, 5.2, 3.0, 16, 3), 0, TOWER_H + 1.2, 0);
  ctx.put('emWhite', cylGeo(1.9, 1.9, 0.8, 16, 1), 0, TOWER_H + 3.1, 0);
  ctx.mmCircle(0, 0, 8, 'rgba(80,200,140,0.5)', 'rgba(160,255,200,0.9)');

  /* --- Inspection gallery ----------------------------------------------- *
   * Four straight slabs round a round shaft, which is what a service gallery
   * on a pressure vessel actually is - and, not incidentally, four box
   * colliders instead of a ring of forty. */
  for (const [gx, gz, w, dd] of [[0, 6.4, 16.4, 3.6], [0, -6.4, 16.4, 3.6], [6.4, 0, 3.6, 9.2], [-6.4, 0, 3.6, 9.2]]) {
    ctx.box('grate', w, 0.25, dd, gx, GY - 0.12, gz);
    ctx.solid(gx, GY - 0.12, gz, w / 2, 0.15, dd / 2);
    ctx.box('trim', w, 0.1, 0.1, gx, GY + 1.05, gz);
  }
  for (const [bx, bz, w, dd] of [[0, 8.1, 16.4, 0.16], [0, -8.1, 16.4, 0.16], [8.1, 0, 0.16, 16.4], [-8.1, 0, 0.16, 16.4]]) {
    // The gallery is entered from +Z, so that side of the rail is left open.
    if (bz > 0) continue;
    ctx.box('trim', w, 1.05, dd, bx, GY + 0.52, bz);
    ctx.solid(bx, GY + 0.52, bz, Math.max(w, 0.16) / 2, 0.52, Math.max(dd, 0.16) / 2);
  }
  ctx.roof(0, GY + 0.15, 7.2);
  ctx.relic(0, GY + 0.35, -7.0, 'prize');

  /* The stair to it, straight down the entry axis so it reads as an invitation
   * from the plaza rather than being found by accident. Local +Z is the high
   * end, and A(0) + PI aims local +Z inward, at the tower. */
  {
    const RUN = 13.5, RISE = GY;
    const pitch = Math.atan2(RISE, RUN);
    const len = Math.hypot(RUN, RISE);
    const p = at(0, 8.2 + RUN / 2);
    ctx.ramp(p[0], RISE / 2 - 0.25 / Math.cos(pitch), p[1], 4.6, RUN, RISE, A(0) + Math.PI);
    ctx.put('grate', boxGeo(4.6, 0.28, len, 2), p[0], RISE / 2, p[1], A(0) + Math.PI, -pitch, 0);
    for (const s of [-2.4, 2.4]) {
      const h = at(0, 8.2 + RUN / 2, s);
      ctx.put('trim', boxGeo(0.1, 0.1, len, 1), h[0], RISE / 2 + 1.0, h[1], A(0) + Math.PI, -pitch, 0);
      ctx.put('panelDark', boxGeo(0.22, 1.0, len, 2), h[0], RISE / 2 + 0.45, h[1], A(0) + Math.PI, -pitch, 0);
    }
    ctx.contact(p[0], p[1], 18);
  }

  /* --- The planting ring around the tower -------------------------------- */
  arcRun(0, 360, 26, 11, (d, i) => {
    const yaw = A(d);
    const c = at(d, 26);
    ctx.box('panelTeal', 8.2, 1.05, 3.4, c[0], 0.52, c[1], yaw);
    ctx.box('trim', 8.4, 0.14, 3.7, c[0], 1.09, c[1], yaw);
    ctx.solid(c[0], 0.55, c[1], 4.1, 0.55, 1.7, yaw);
    ctx.contact(c[0], c[1], 12);
    for (const s of [-2.4, 0, 2.4]) {
      const p = at(d, 26, s);
      shrub(ctx, K, p[0], p[1], 1.12, 1.15);
    }
    if (i % 2 === 0) {
      // A bench on the outer face of every other tub, looking back at the hall.
      const b = at(d, 29.4);
      bench(ctx, K, b[0], b[1], 0, faceOut(d));
      if (ctx.rng() > 0.52) {
        const p = at(d, 29.4, (ctx.rng() - 0.5) * 2.4);
        seat(ctx, K, p[0], p[1], 0, faceOut(d), SEAT);
      }
    }
    if (i === 5) ctx.relic(c[0], 1.35, c[1], 'rare');
  });

  /* --- Grow lights -------------------------------------------------------- */
  for (let i = 0; i < 4; i++) {
    const a = (i / 4) * TAU + 0.4;
    const l = new THREE.PointLight(0x9fffcf, 2200, 74, 2);
    l.position.copy(ctx.P(Math.sin(a) * 16, 20, Math.cos(a) * 16));
    l.castShadow = false;
    ctx.group.add(l);
  }

  /* --- Two-tops in the gap between the planting ring and the island --------- *
   * The one part of the court the rings of group tables do not reach. Two-tops
   * because this is where somebody eats alone with their back to the garden,
   * which is a different thing from the twelve-seat ranks either side of it. */
  ringFill(ctx, 33.5, 9.5, 1.4, (d) => {
    const c = at(d, 33.5);
    const yaw = A(d);
    twoTop(ctx, K, c[0], c[1], yaw);
    for (const s of [-1, 1]) {
      const p = off(c[0], c[1], yaw, 0, s * 0.85);
      const look = faceTo(p[0], p[1], c[0], c[1]);
      chair(ctx, K, p[0], p[1], 0, look);
      if (ctx.rng() > 0.78) {
        seat(ctx, K, p[0], p[1], 0, look, SEAT);
        laid(ctx, K, c[0], c[1], 0, yaw, 1);
      }
    }
  });

  /* --- Sapling planters round the court rim --------------------------------- */
  arcRun(18, 342, COURT_R - 8, 34, (d) => {
    const c = at(d, COURT_R - 8);
    ctx.box('panelDark', 3.0, 0.8, 3.0, c[0], 0.4, c[1], A(d));
    ctx.solid(c[0], 0.4, c[1], 1.5, 0.4, 1.5, A(d));
    ctx.contact(c[0], c[1], 6);
    shrub(ctx, K, c[0], c[1], 0.85, 1.6);
    const p = off(c[0], c[1], A(d), 0.7, 0.6);
    shrub(ctx, K, p[0], p[1], 0.85, 1.1);
  });
}

/* ------------------------------------------------------------------ */
/* Odds and ends                                                       */
/* ------------------------------------------------------------------ */

/**
 * The last pass: bins, bollards and the remaining collectables.
 *
 * Everything here is on the threshold between the court and the arcade, which
 * is the band every player crosses on the way in and the only part of the zone
 * that gets looked at from three metres.
 */
function dressTheEdges(ctx, K) {
  /* Threshold markers where the court meets the arcade.
   *
   * The bin banks that used to stand here have gone: the promenade behind them
   * is one of the two clear rings the whole hall circulates on, and a 1 m deep
   * bin every 44 m down its inner edge was quietly costing it a fifth of its
   * width. The bussing points moved to `buildServiceRun`, which keeps all of
   * them on the court side of the ring. What is left is what the threshold
   * actually wanted - a low lit kerb telling you the room changes here. */
  arcRun(18, 342, COURT_R + 2.4, 22, (d) => {
    const yaw = A(d);
    const c = at(d, COURT_R + 2.4);
    ctx.box('trimDark', 18, 0.26, 0.5, c[0], 0.13, c[1], yaw);
    ctx.box(ctx.accent, 16, 0.06, 0.16, ...at3(d, COURT_R + 2.2, 0.28), yaw);
  });

  /* Bollards down the entry funnel, so the walk in from the plaza is a route
   * rather than an open field. They stop at lz=140: the arrival plaza and the
   * eight metres in front of it are built by the zone shell and nothing in
   * this file may stand in either. */
  for (const s of [-1, 1]) {
    for (let i = 0; i < 4; i++) {
      const lz = 120 + i * 6.5;
      const lx = s * (11 + i * 0.55);
      ctx.box('trimDark', 0.34, 0.95, 0.34, lx, 0.47, lz);
      ctx.box(ctx.accent, 0.4, 0.07, 0.4, lx, 0.98, lz);
      ctx.solid(lx, 0.47, lz, 0.2, 0.47, 0.2);
      ctx.contact(lx, lz, 2.2);
    }
  }

  /* The remaining hides. The rule for all of them is the same: somewhere a
   * player has to already be doing something else in order to be looking. */
  ctx.relic(...at3(190, SERVERY_R + 0.9, 1.15, 1.7), 'common');      // behind the urns
  ctx.relic(...at3(198, CATWALK_R, CATWALK_Y + 0.35), 'prize');      // out on the catwalk
  ctx.relic(...at3(SERVERY_A1 + 2, SERVERY_R - 1.3, 0.35), 'common');// under the counter end
  ctx.relic(...at3(96, MEZZ_R1 - 3.4, MEZZ_Y + 0.35), 'rare');       // back of the mezzanine
}

/* ------------------------------------------------------------------ */
/* Population                                                          */
/* ------------------------------------------------------------------ */

/**
 * Everybody who is not sitting down: the queues, the servers, the kitchen, the
 * tray carriers and the people standing about talking.
 *
 * The queues are the load-bearing part. Five lanes of six is thirty figures all
 * facing the same way at a known spacing, and a crowd with a DIRECTION in it is
 * what tells a player at 200 m that the counter is the thing to walk toward.
 * No quantity of scattered idlers does that.
 */
function castTheCrowd(ctx, K) {
  /* --- Queues at the order points --------------------------------------- */
  for (const d of KIOSK_BEARINGS) {
    const deep = 6 + Math.floor(ctx.rng() * 3);
    for (let i = 0; i < deep; i++) {
      // A perfectly straight queue is a barcode. A metre of lateral wander and
      // a little slop in the spacing is what makes it a line of people who
      // arrived separately and are standing where they ended up.
      const p = at(d, KIOSK_R - 2.1 - i * 1.55 - ctx.rng() * 0.3, (ctx.rng() - 0.5) * 1.1);
      ctx.actor(p[0], 0, p[1], {
        localYaw: faceOut(d) + (ctx.rng() - 0.5) * 0.3,
        activity: 'queue',
        phase: K.phase(),
        speed: 0.7 + ctx.rng() * 0.5,
      });
      K.people++;
    }
  }

  /* --- Servers, behind the counter, facing the customers ----------------- */
  arcRun(SERVERY_A0 + 3, SERVERY_A1 - 3, SERVERY_R + 1.9, 13, (d) => {
    const p = at(d, SERVERY_R + 1.9, (ctx.rng() - 0.5) * 2);
    ctx.actor(p[0], 0, p[1], {
      localYaw: faceIn(d),
      activity: ctx.rng() > 0.6 ? 'carry' : 'stand',
      phase: K.phase(),
      speed: 0.8 + ctx.rng() * 0.4,
      variant: 'hiviz',
    });
    K.people++;
  });
  // Two more on the collection counter, handing things over.
  for (const d of [SERVERY_A0 - 9, SERVERY_A0 - 4]) {
    ctx.actor(...at3(d, 153.4, 0), {
      localYaw: faceIn(d), activity: 'stand', phase: K.phase(), variant: 'hiviz',
    });
    K.people++;
  }
  // And four waiting on their order at the collection end.
  for (let i = 0; i < 4; i++) {
    const d = SERVERY_A0 - 11 + i * 2.6;
    const p = at(d, 149.5, (ctx.rng() - 0.5) * 1.5);
    ctx.actor(p[0], 0, p[1], {
      localYaw: faceOut(d), activity: i % 2 ? 'stand' : 'talk', phase: K.phase(),
    });
    K.people++;
  }

  /* --- Back of house ------------------------------------------------------ */
  const BOH_JOBS = ['carry', 'stand', 'lift', 'carry', 'stand', 'carry'];
  for (let i = 0; i < 9; i++) {
    const d = BOH_A0 + 6 + ctx.rng() * (BOH_A1 - BOH_A0 - 12);
    const p = at(d, 173 + ctx.rng() * 11);
    if (!ctx.onDeck(p[0], p[1], 8)) continue;
    ctx.actor(p[0], 0, p[1], {
      localYaw: ctx.rng() * TAU,
      activity: BOH_JOBS[i % BOH_JOBS.length],
      phase: K.phase(),
      speed: 0.75 + ctx.rng() * 0.5,
      amount: 0.8,
      variant: 'hiviz',
    });
    K.people++;
  }

  /* --- Tray carriers, working between the counter and the tables ---------- */
  for (let i = 0; i < 12; i++) {
    const d = 20 + ctx.rng() * 320;
    // The arrival funnel has to stay walkable; nobody stands in it.
    if (Math.abs(((d + 180) % 360) - 180) < 16) continue;
    const p = at(d, 118 + ctx.rng() * 46);
    if (!ctx.onDeck(p[0], p[1], 10)) continue;
    ctx.actor(p[0], 0, p[1], {
      localYaw: ctx.rng() * TAU,
      activity: ctx.rng() > 0.45 ? 'carry' : 'walk',
      phase: K.phase(),
      speed: 0.85 + ctx.rng() * 0.35,
    });
    K.people++;
  }

  /* --- Standing conversations --------------------------------------------- *
   * In twos and threes, everybody in a knot facing its middle - which is the
   * whole reason a knot reads as a conversation and not as a queue that has
   * gone wrong - and each figure on its own phase so the gestures alternate. */
  const KNOTS = [
    [40, 150], [128, 152], [244, 154], [288, 156], [318, 130],
    [96, 132], [70, 122], [214, 148], [336, 126], [26, 120],
    [176, 118], [150, 118],
  ];
  for (const [d, r] of KNOTS) {
    const n = 2 + Math.floor(ctx.rng() * 2);
    const c = at(d, r);
    for (let i = 0; i < n; i++) {
      const a = (i / n) * TAU + ctx.rng() * 0.4;
      const x = c[0] + Math.sin(a) * 0.85;
      const z = c[1] + Math.cos(a) * 0.85;
      if (!ctx.onDeck(x, z, 8)) continue;
      ctx.actor(x, 0, z, {
        localYaw: faceTo(x, z, c[0], c[1]),
        activity: 'talk',
        phase: K.phase(),
        speed: 0.8 + ctx.rng() * 0.4,
      });
      K.people++;
    }
  }

  /* --- Walkers out on the court -------------------------------------------- */
  for (let i = 0; i < 8; i++) {
    const p = at(ctx.rng() * 360, 34 + ctx.rng() * 66);
    if (!ctx.onDeck(p[0], p[1], 12)) continue;
    ctx.actor(p[0], 0, p[1], {
      localYaw: ctx.rng() * TAU, activity: 'walk', phase: K.phase(), speed: 0.9 + ctx.rng() * 0.3,
    });
    K.people++;
  }

  /* --- Two on the mezzanine rail, looking down at the hall ----------------- */
  for (const d of [MEZZ_A0 + 16, MEZZ_A1 - 20]) {
    ctx.actor(...at3(d, MEZZ_R0 + 1.6, MEZZ_Y), {
      localYaw: faceIn(d), activity: 'stand', phase: K.phase(),
    });
    K.people++;
  }
  // And one up on the service catwalk, changing a tube over the counter.
  ctx.actor(...at3(186, CATWALK_R, CATWALK_Y), {
    localYaw: faceIn(186), activity: 'press', phase: K.phase(), speed: 0.5, variant: 'hiviz',
  });
  K.people++;

  // Two browsing the merchant's shelves, so the stall is never empty.
  for (const [dd, rr] of [[STALL_A - 2.2, STALL_R - 2.4], [STALL_A + 2.4, STALL_R - 2.8]]) {
    ctx.actor(...at3(dd, rr, 0), {
      localYaw: faceOut(dd), activity: 'stand', phase: K.phase(),
    });
    K.people++;
  }
}

/* ------------------------------------------------------------------ */
/* The ones who have names                                             */
/* ------------------------------------------------------------------ */

/**
 * The named cast.
 *
 * This was two - the person you buy from and the person who runs the kitchen -
 * against a game-wide cap of eight authored friendlies that the world now
 * declares for itself (`friendlyBudget` in `StationWorld._fillSpawns`). The
 * trade the old note describes is still the right one: a canteen needs a
 * hundred bodies far more than it needs a biography for each of them, and
 * everybody else in here is still an instanced actor. Four more is what buys
 * the hall the two things it had no way to offer - a second counter and
 * somewhere to pick up work - plus two people worth stopping for.
 *
 * The four added stand in the radial SPOKES. Those are the hall's circulation:
 * `blocked()` keeps all nine furniture passes out of them, so a spoke is the
 * one place in a room with four hundred chairs in it that is guaranteed to be
 * clear floor. Their bearings are checked against KEEPOUT too - the arrival
 * funnel at 344-16 and the servery block at 141-217 are the two that bite.
 */
function castTheNamed(ctx) {
  // The merchant stands behind her own counter, which is also what stops a
  // player walking through the stall to reach her.
  const m = at(STALL_A, STALL_R + 1.9);
  ctx.npc(m[0], m[1], {
    name: 'Ovid Casserly',
    persona:
      'Quartermaster of Galley Provisions, a soft-spoken ex-medic off the hospital ships who now runs the only counter on this ring selling you both dinner and a suture kit. He weighs everything twice, quotes the ration tariff from memory, and will not hand over a stimulant without asking, mildly, when you last slept. Nothing on his shelves is a weapon and he would like that on the record.',
    role: 'vendor',
    vendorCategories: ['health', 'spells'],
    vendorTitle: 'Galley Provisions',
    signLines: ['PROVISIONS', 'RATIONS + MEDKITS'],
    patrol: [[m[0], m[1]], [m[0] + 2, m[1] + 1], [m[0] - 2, m[1]]],
  });

  const c0 = at(178, SERVERY_R + 2.4);
  const c1 = at(170, SERVERY_R + 2.4);
  const c2 = at(186, SERVERY_R + 2.0);
  ctx.npc(c0[0], c0[1], {
    name: 'Ma Tsering',
    persona:
      'Head cook of the Long Galley, thirty-one years on the line and audibly unimpressed by all of them. She has fed three station commanders, two evacuations and one wedding, and rates every one of them by how much was left in the trays afterwards. Ask her about the food and she will talk about the hydroponics; ask her about the hydroponics and she will tell you what the last shipment of real garlic cost.',
    patrol: [[c0[0], c0[1]], [c1[0], c1[1]], [c2[0], c2[1]]],
  });

  /* Spoke 60, well inside the mezzanine stair keep-out at r 128-154. */
  const b0 = at(60, 100);
  ctx.npc(b0[0], b0[1], {
    name: 'Sedna Ilkay',
    persona:
      'Runs the drinks and dry-goods trolley out of a pitch in the middle of the floor, which she chose because it is the furthest point in the hall from anybody who could tell her to move it. She sells hot things, cold things, and the sort of small comfort a crew member buys at the end of a bad shift. Endlessly nosy, entirely discreet, and she will remember your order the second time.',
    role: 'vendor',
    vendorCategories: ['health', 'cosmetic'],
    vendorTitle: 'The Long Galley Trolley',
    signLines: ['TROLLEY', 'HOT + COLD'],
    patrol: [[b0[0], b0[1]], [at(58, 104)[0], at(58, 104)[1]], [at(62, 96)[0], at(62, 96)[1]]],
  });

  /* Spoke 300, clear of the refectory block (244-266) and the provisions
   * stall's serving room (211-233). */
  const b1 = at(300, 110);
  ctx.npc(b1[0], b1[1], {
    name: 'Purser Oleander Vance',
    persona:
      'Keeps the mess ledger, which on this ring means she also keeps the list of everything the galley needs somebody to go and fetch. She posts it on the board beside her and reads it out in the tone of a woman who has costed every line. Immaculate, unhurried, and quietly the best-informed person about supply on five decks.',
    role: 'quest_manager',
    isQuestManager: true,
    signLines: ['MESS LEDGER', 'STANDING WORK'],
  });

  /* Spoke 90 and spoke 330, walked out and back. Both stay clear of the
   * servery arc and of the arrival funnel. */
  const w0 = at(90, 70);
  ctx.npc(w0[0], w0[1], {
    name: 'Hallam Oduya',
    persona:
      'Hydroponics lead, in the galley to argue - politely, endlessly - about what the kitchen does to his produce. He knows to the gram what this hall eats in a week and finds the number genuinely thrilling. Talk to him for two minutes and you will know more about closed-loop nitrogen than you intended to.',
    patrol: [
      [w0[0], w0[1]], [at(90, 112)[0], at(90, 112)[1]],
      [at(88, 126)[0], at(88, 126)[1]], [at(92, 58)[0], at(92, 58)[1]],
    ],
  });

  const w1 = at(330, 96);
  ctx.npc(w1[0], w1[1], {
    name: 'Kesi Aliyeva',
    persona:
      'Off-shift tug pilot who eats here twice a day and treats the hall as a waiting room with soup. She talks about approaches and berth slots the way other people talk about weather, is superstitious about exactly one thing and will not say which, and knows every freighter crew that comes through the ring by their handling.',
    patrol: [
      [w1[0], w1[1]], [at(330, 132)[0], at(330, 132)[1]],
      [at(322, 118)[0], at(322, 118)[1]], [at(336, 74)[0], at(336, 74)[1]],
    ],
  });
}

/* ------------------------------------------------------------------ */
/* Build                                                               */
/* ------------------------------------------------------------------ */

export function buildCanteen(ctx) {
  const kit = newKit();

  paveTheGalley(ctx);
  buildServery(ctx, kit);
  buildBackOfHouse(ctx, kit);
  buildOrderPoints(ctx, kit);
  buildProvisions(ctx, kit);
  buildDiningFields(ctx, kit);
  buildIsland(ctx, kit);
  buildRefectoryBlock(ctx);
  buildCourtHall(ctx, kit);
  buildServiceRun(ctx, kit);
  buildMezzanine(ctx, kit);
  buildWindowSeating(ctx, kit);
  buildGardenCourt(ctx, kit);
  dressTheEdges(ctx, kit);
  castTheCrowd(ctx, kit);
  castTheNamed(ctx);

  // Last, so every list is complete before a single InstancedMesh is built.
  flushKit(ctx, kit);
  return kit.people;
}
