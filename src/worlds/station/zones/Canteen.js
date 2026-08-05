import * as THREE from 'three';
import { boxGeo, cylGeo, instanced } from '../StationKit.js';

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
 * inside r=112, a covered arcade with a 30 m ceiling from there to the rim. So
 * the built content goes in the arcade and the landmark goes in the court.
 *
 *      bearing        radius        what
 *      ---------      ----------    ----------------------------------------
 *       -16..16       all           arrival plaza and the walk in - kept clear
 *        18..150      118..194      east dining, the mezzanine, the window bar
 *       151..211      152..194      THE SERVERY and its back of house
 *       212..232      140..168      Galley Provisions and the dish return
 *       232..344      118..194      west dining and the quiet window gallery
 *         0..360        0..106      the garden court and the grow tower
 *
 * The servery is deliberately on the far side of the deck from the link mouth.
 * A player arriving at the plaza is looking down 350 m of dining floor at a
 * 126 m lit counter with steam coming off it, which is the single frame this
 * zone exists to produce; putting the counter beside the entrance would have
 * given them a queue to look at instead.
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
 * ── Collision is entirely manual out here ─────────────────────────────────
 * `StationWorld._collisionSoup` and `_solidifyProps` both reject anything more
 * than `DECK_R` from the world origin, and this deck is 498 m out. Not one
 * triangle and not one instance in this file is collided automatically. If a
 * player can walk into it, it has a `ctx.solid` beside it in the same block.
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

/**
 * Dining bearings, both flanks.
 *
 * The east flank is cut into three by the mezzanine stairs at 68 and 114; the
 * west is one unbroken sweep. The gap at 0 +/- 16 is the arrival funnel and
 * stays empty in every pass.
 */
const DINING_SPANS = [[18, 58], [76, 106], [122, 150], [232, 344]];

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
    boothSeat: [], boothBack: [],
    tray: [], mug: [], crate: [], leaf: [], puff: [], marker: [],
    pendantShade: [], pendantBulb: [],

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
  // Warm apron in front of the servery - the strip that is always busy.
  arcRun(SERVERY_A0 - 4, SERVERY_A1 + 4, 146, 11, (d) => {
    const p = at(d, 146);
    ctx.floorQuad('plaza', 11.4, 26, p[0], p[1], A(d), 0.1, 9);
  });
  // Cooler, harder floor through the back of house, where the trolleys run.
  arcRun(BOH_A0, BOH_A1, 180, 12, (d) => {
    const p = at(d, 180);
    ctx.floorQuad('road', 12.4, 26, p[0], p[1], A(d), 0.11, 8);
  });
  // A warm bay under each run of tables.
  for (const [a0, a1] of DINING_SPANS) {
    arcRun(a0, a1, 132, 16, (d) => {
      const p = at(d, 132);
      ctx.floorQuad('plaza', 16.4, 30, p[0], p[1], A(d), 0.1, 10);
    });
  }

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
 * Tables, chairs and the people on them, across both flanks of the arcade.
 *
 * Three rings of different furniture rather than one grid of the same table:
 * two-tops at the court edge where people sit alone, four-tops through the
 * middle, and long refectory rows at the back where a whole watch eats
 * together. That ordering is not decorative - it means every sightline across
 * the hall crosses three different table sizes, which is what stops 200 m of
 * seating reading as wallpaper.
 *
 * Occupancy is deliberately partial and deliberately lumpy. A hall with every
 * seat filled looks staged; a hall at about a third looks like the back end of
 * a lunch service, which is also the only state in which the empty tables read
 * as empty rather than as missing.
 */
function buildDiningFloor(ctx, K) {
  /* --- Two-tops, hard against the court edge ------------------------- */
  for (const [a0, a1] of DINING_SPANS) {
    arcRun(a0, a1, 124, 19, (d) => {
      const c = at(d, 124);
      const yaw = A(d) + (ctx.rng() - 0.5) * 0.3;
      twoTop(ctx, K, c[0], c[1], yaw);
      const places = [];
      for (const s of [-1, 1]) {
        const p = off(c[0], c[1], yaw, 0, s * 0.85);
        // Chairs face the table, so their yaw is the bearing back to it.
        chair(ctx, K, p[0], p[1], 0, faceTo(p[0], p[1], c[0], c[1]));
        places.push(p);
      }
      const r = ctx.rng();
      const take = r > 0.80 ? 2 : r > 0.54 ? 1 : 0;
      for (let i = 0; i < take; i++) {
        const p = places[i];
        seat(ctx, K, p[0], p[1], 0, faceTo(p[0], p[1], c[0], c[1]), SEAT);
      }
      if (take) laid(ctx, K, c[0], c[1], 0, yaw, take);
    });
  }

  /* --- Four-tops ------------------------------------------------------ */
  for (const [a0, a1] of DINING_SPANS) {
    arcRun(a0, a1, 140, 32, (d) => {
      const c = at(d, 140);
      const yaw = A(d) + (ctx.rng() - 0.5) * 0.25;
      fourTop(ctx, K, c[0], c[1], yaw);
      const places = [];
      for (const [ox, oz] of [[0, 1.0], [0, -1.0], [1.0, 0], [-1.0, 0]]) {
        const p = off(c[0], c[1], yaw, ox, oz);
        chair(ctx, K, p[0], p[1], 0, faceTo(p[0], p[1], c[0], c[1]));
        places.push(p);
      }
      // Fill a table or leave it alone. Half-filling every single one is what
      // makes a hall look like a seating plan rather than like lunch.
      const r = ctx.rng();
      const take = r > 0.84 ? 4 : r > 0.70 ? 3 : r > 0.52 ? 2 : 0;
      for (let i = 0; i < take; i++) {
        const p = places[i];
        seat(ctx, K, p[0], p[1], 0, faceTo(p[0], p[1], c[0], c[1]), SEAT);
      }
      if (take) laid(ctx, K, c[0], c[1], 0, yaw, take);
    });
  }

  /* --- Refectory rows -------------------------------------------------- *
   * Only where the mezzanine is not: one short row on the east flank before
   * the deck starts, the long one on the west. */
  for (const [a0, a1] of [[20, 56], [236, 300]]) {
    arcRun(a0, a1, 158, 20, (d) => {
      const yaw = A(d);
      const c = at(d, 158);
      ctx.box('panelWarm', 9.0, 0.09, 1.15, c[0], 0.735, c[1], yaw);
      for (const s of [-3.6, 3.6]) {
        const t = at(d, 158, s);
        ctx.box('trimDark', 0.16, 0.70, 0.95, t[0], 0.35, t[1], yaw);
      }
      ctx.solid(c[0], 0.6, c[1], 4.5, 0.28, 0.6, yaw);
      ctx.contact(c[0], c[1], 12);

      for (const side of [-1, 1]) {
        const yawSeat = side > 0 ? faceIn(d) : faceOut(d);
        for (const t of [-2.25, 2.25]) {
          const p = at(d, 158 + side * 1.02, t);
          bench(ctx, K, p[0], p[1], 0, yawSeat);
        }
        for (let i = 0; i < 3; i++) {
          if (ctx.rng() > 0.4) continue;
          const p = at(d, 158 + side * 1.02, -3.0 + i * 3.0);
          seat(ctx, K, p[0], p[1], 0, yawSeat, SEAT);
          const l = at(d, 158 + side * 0.4, -3.0 + i * 3.0);
          laid(ctx, K, l[0], l[1], 0, yaw, 1);
        }
      }

      /* A lighting truss over each row.
       *
       * The arcade plate is 30 m up, so a pendant hung from it would need a
       * 28 m flex. The rows carry their own truss at 6.2 instead, which is
       * also the only thing giving the back of the dining floor a ceiling
       * whose height a player can judge. */
      ctx.box('beam', 9.4, 0.35, 0.35, c[0], 6.2, c[1], yaw);
      ctx.box('emWhite', 8.2, 0.1, 0.3, c[0], 5.95, c[1], yaw);
      for (const s of [-4.4, 4.4]) {
        const p = at(d, 158, s);
        ctx.box('trim', 0.2, 6.2, 0.2, p[0], 3.1, p[1], yaw);
        ctx.solid(p[0], 3.1, p[1], 0.12, 3.1, 0.12, yaw);
      }
    });
  }
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
   * edge. Their landings are why `DINING_SPANS` has a hole either side. */
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
  /* --- East: a continuous bar counter facing out ---------------------- */
  for (const [a0, a1] of [[24, 54], [126, 148]]) {
    arcRun(a0, a1, 190, 7, (d) => {
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
  // A planted rail between the gallery and the dining floor, so the quiet end
  // reads as a separate room without a wall thrown across the arcade.
  arcRun(248, 332, 182, 8, (d) => {
    const yaw = A(d);
    const c = at(d, 182);
    ctx.box('panelTeal', 6.2, 0.95, 1.1, c[0], 0.48, c[1], yaw);
    ctx.box('trim', 6.2, 0.1, 1.3, c[0], 0.98, c[1], yaw);
    ctx.solid(c[0], 0.5, c[1], 3.1, 0.5, 0.6, yaw);
    for (const s of [-1.7, 1.7]) {
      const p = at(d, 182, s);
      shrub(ctx, K, p[0], p[1], 1.0, 0.85);
    }
  });
  {
    const p = at(290, 181);
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

  /* --- Cafe tables out on the court ---------------------------------------- *
   * Kept off the entry axis so the arrival sightline to the tower stays clear,
   * and thinned right out: this is the one part of the zone that is meant to
   * feel like there is room in it. */
  arcRun(20, 340, 70, 38, (d) => {
    const c = at(d, 70 + (ctx.rng() - 0.5) * 14);
    if (!ctx.onDeck(c[0], c[1], 10)) return;
    const yaw = ctx.rng() * TAU;
    twoTop(ctx, K, c[0], c[1], yaw);
    for (const s of [-1, 1]) {
      const p = off(c[0], c[1], yaw, 0, s * 0.85);
      const look = faceTo(p[0], p[1], c[0], c[1]);
      chair(ctx, K, p[0], p[1], 0, look);
      if (ctx.rng() > 0.66) {
        seat(ctx, K, p[0], p[1], 0, look, SEAT);
        laid(ctx, K, c[0], c[1], 0, yaw, 1);
      }
    }
    if (ctx.rng() > 0.6) {
      const p = off(c[0], c[1], yaw, 1.9, 0);
      shrub(ctx, K, p[0], p[1], 0, 1.0);
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
  /* Bin banks and bussing points round the mouth of the arcade. */
  arcRun(18, 342, COURT_R + 4, 44, (d) => {
    const yaw = A(d);
    const c = at(d, COURT_R + 4);
    ctx.box('trimDark', 2.6, 1.15, 1.0, c[0], 0.57, c[1], yaw);
    ctx.box('trim', 2.8, 0.1, 1.2, c[0], 1.17, c[1], yaw);
    ctx.solid(c[0], 0.6, c[1], 1.3, 0.6, 0.5, yaw);
    ctx.contact(c[0], c[1], 5.5);
    // Recycling green and waste amber, which is the only signage a bin needs.
    for (const [s, key] of [[-0.75, 'emGreen'], [0.75, 'emAmber']]) {
      ctx.box(key, 0.7, 0.08, 0.5, ...at3(d, COURT_R + 3.6, 1.24, s), yaw);
    }
    for (let i = 0; i < 2; i++) {
      inst(ctx, K.tray, ...at3(d, COURT_R + 4, 1.24 + i * 0.045, -0.9 + i * 0.05), yaw);
    }
  });

  /* Bollards down the entry funnel, so the walk in from the plaza is a route
   * rather than an open field. They stop well short of lz=154: the arrival
   * plaza is built by the zone shell and nothing here may stand in it. */
  for (const s of [-1, 1]) {
    for (let i = 0; i < 5; i++) {
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
/* The two who have names                                              */
/* ------------------------------------------------------------------ */

/**
 * There is a hard cap of eight authored friendlies across the whole game and
 * three other zones want theirs, so this one gets exactly two: the person you
 * buy from and the person who runs the kitchen. Everybody else in here is an
 * ambient actor, which is the right trade - a named NPC costs a conversation
 * and a character, and a canteen needs a hundred bodies far more than it needs
 * a third biography.
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
  buildDiningFloor(ctx, kit);
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
