import { smoothstep, lerp } from './RaceTrack.js';

/**
 * The three circuits of the race world, and the ground they are cut into.
 *
 * ── Why this is a separate file ────────────────────────────────────────────
 *
 * RaceWorld builds a circuit; it does not decide what one *is*. Everything a
 * circuit needs to be authored - its control points, where its spectators
 * stand, how many laps each difficulty runs, what furniture stands beside it -
 * lives here as data, so adding a fourth circuit is a new entry in {@link
 * CIRCUITS} rather than another branch inside a 2 500 line builder.
 *
 * ── The rules an author has to obey ────────────────────────────────────────
 *
 * The whole world is one height function (see RaceWorld's header), and a height
 * function is single-valued: exactly one surface above any (x, z). Two
 * consequences, and breaking either produces a circuit that looks fine and
 * cannot be driven:
 *
 *  1. **A circuit may never cross or overlap itself in plan.** No figure-eights,
 *     no flyovers, no switchback that stacks one leg over another. The one
 *     exception is the loop, which is not part of the height function at all -
 *     see {@link CIRCUITS} `loop` and RaceWorld._buildLoop.
 *  2. **Parallel legs need room.** The sealed surface is `w + v` either side of
 *     the centreline - about 20 m on open sections - and the terrain then blends
 *     back to natural ground over up to 30 m more. Two legs closer than ~60 m
 *     centre to centre leave no ground between them and the blend fights itself.
 *
 * The same applies *between* circuits, which is why they sit on a diagonal with
 * 100 m of clear ground at the nearest approach rather than being packed into a
 * row: the corner of one circuit's blend must not reach the corner of another's.
 *
 * Corner radius is not authored. It falls out of how close consecutive control
 * points are - Catmull-Rom through widely spaced points is a sweeper and through
 * tight ones is a hairpin - so a chicane is written as three points 25 m apart
 * and a straight as two points 60 m apart. RaceCourse then caps the road width
 * against the radius it measures, so an over-tight corner comes out narrow
 * rather than inside-out.
 */

/* ------------------------------------------------------------------ */
/* The playfield                                                       */
/* ------------------------------------------------------------------ */

/**
 * Playfield half-extent, metres.
 *
 * Was 260, for one circuit. Three circuits on a diagonal need the corner-most
 * one to reach 570 m out and still have its terrain blend, its scenery and the
 * rim that hides the map edge inside the boundary, so this is sized from the
 * layout rather than chosen: 390 to the far circuit's centre, 180 to its far
 * side, 90 for the blend and the rim.
 */
export const HALF = 660;

/**
 * Terrain mesh quads across the playfield.
 *
 * The old map was 200 quads over 520 m - 2.6 m each. Holding that resolution
 * over a 1 320 m map would cost 260 000 vertices of terrain, which is a quarter
 * of a million triangles drawn every frame for ground that is mostly looked at
 * from a car doing 30 m/s. 330 quads gives 4 m cells and 110 000 vertices:
 * 2.7x the old terrain for 6.5x the area.
 *
 * Cell size only affects ground away from the circuits. Every road carries its
 * own collision slabs at the true surface, so what a car drives on is unchanged
 * by this number.
 */
export const SEG = 330;
export const QUAD = (HALF * 2) / SEG;

/* ------------------------------------------------------------------ */
/* Landforms                                                           */
/* ------------------------------------------------------------------ */

/**
 * Hills, as explicit masses rather than noise.
 *
 * Noise in a height function is noise the collision has to reproduce, and the
 * only way to reproduce it is to sample it at the same resolution. Every mass
 * here is smooth over tens of metres, so a 4 m heightfield cell follows it to
 * within a few centimetres.
 *
 * Grouped by which circuit they shape. The ones with no circuit near them are
 * what stops the ground between the three reading as a car park.
 * @type {Array<[number, number, number, number]>} x, z, radius, height
 */
const HILLS = [
  /* ---- Vellum Ridge (centred on the origin) ---- */
  [186, -80, 132, 28],
  [244, -172, 112, 24],
  [112, -226, 136, 34],
  [-40, -246, 132, 30],
  [-182, -152, 130, 20],
  [52, -70, 104, 16],
  [146, 74, 112, 12],
  [4, 44, 142, 7],
  [250, 34, 92, 14],
  [244, 126, 96, 17],

  /* ---- Cinder Gorge (centred on -390, -390) ----
   * The quarry rim is the high ground the circuit climbs onto, so the mass sits
   * under the Rim section and falls away toward the start/finish plain. */
  [-332, -542, 158, 36],
  [-225, -450, 128, 27],
  [-550, -515, 124, 21],
  [-432, -456, 104, 25],
  [-570, -320, 118, 14],
  [-270, -610, 120, 22],

  /* ---- Aurora Rise (centred on +390, +390) ---- */
  [450, 298, 162, 35],
  [542, 378, 122, 27],
  [356, 312, 124, 30],
  [270, 530, 112, 9],
  [560, 560, 130, 16],
  [612, 232, 104, 20],

  /* ---- the country between them ---- */
  [-160, -420, 190, 22],
  [230, 420, 180, 19],
  [-430, 180, 165, 17],
  [420, -230, 170, 21],
  [-90, 430, 150, 11],
  [90, -430, 150, 13],

  /* ---- the rim ----
   *
   * The map is a square of terrain with sky past its edge, and at 1 320 m
   * across that edge is now only 90 m from the outermost circuit rather than
   * safely lost in fog. These are what stands in front of it: a ring of masses
   * on the boundary, high enough to fill the view from any road that gets near
   * one and smooth enough that the road's own blend ramps up to them as an
   * embankment rather than meeting them as a wall.
   *
   * This is also why Cinder Gorge is a quarry and Aurora Rise is highland: the
   * ground the layout needed was going to rise sharply at the edge whatever the
   * theme, so the themes are the ones that want it to. */
  [-700, -520, 260, 52],
  [-520, -700, 260, 50],
  [-700, -120, 250, 44],
  [-700, 260, 250, 42],
  [-380, -720, 250, 46],
  [40, -720, 250, 40],
  [420, -700, 250, 44],
  [700, -420, 260, 46],
  [700, -40, 250, 42],
  [700, 340, 250, 44],
  [520, 700, 260, 50],
  [140, 700, 250, 42],
  [-260, 700, 250, 44],
  [-660, 620, 250, 46],
  [660, -660, 250, 46],
  [-660, -660, 240, 48],
];

/**
 * Flat plates: ground held level for a paddock, a start/finish plain or a city
 * block. cx, cz, hx, hz, fade.
 */
const PLATES = [
  [-155, 70, 104, 128, 66],   // Vellum: the city block
  [40, 220, 236, 50, 58],     // Vellum: the paddock plain
  [-390, -232, 176, 54, 60],  // Cinder Gorge: start/finish plain
  [390, 544, 172, 50, 60],    // Aurora Rise: start/finish plain
];

/**
 * Natural ground, before any circuit is cut into it.
 *
 * A pure function of position, deliberately free of anything sharper than the
 * heightfield can follow.
 */
export function baseTerrain(x, z) {
  let h = 0;
  for (let i = 0; i < HILLS.length; i++) {
    const hx = HILLS[i][0];
    const hz = HILLS[i][1];
    const r = HILLS[i][2];
    const d = Math.hypot(x - hx, z - hz);
    if (d < r) {
      const t = 1 - d / r;
      h += HILLS[i][3] * t * t * (3 - 2 * t);
    }
  }
  h += Math.sin(x * 0.0165 + 1.2) * Math.cos(z * 0.0138 - 0.4) * 2.7;
  h += Math.sin((x + z) * 0.0292 + 2.1) * 1.15;
  h += Math.sin(x * 0.0505 - 0.7) * 0.5 + Math.cos(z * 0.0447 + 1.7) * 0.45;

  for (let i = 0; i < PLATES.length; i++) {
    const [cx, cz, hxE, hzE, fade] = PLATES[i];
    const wx = 1 - smoothstep(hxE, hxE + fade, Math.abs(x - cx));
    const wz = 1 - smoothstep(hzE, hzE + fade, Math.abs(z - cz));
    h = lerp(h, 0, wx * wz);
  }
  return h;
}

/** Vellum Ridge's city block, in world coordinates. Buildings only spawn inside it. */
export const CITY = { x0: -244, x1: -64, z0: -46, z1: 178 };

/* ------------------------------------------------------------------ */
/* Circuit 1 - Vellum Ridge                                            */
/* ------------------------------------------------------------------ */

/**
 * Control points, in the racing direction. `y` is the road surface height, `w`
 * the drivable half-width, `v` the run-off carried either side of it.
 *
 * `v` is what turns the west of this circuit into a street section. Everywhere
 * else it is 11 m of kerb, apron, gravel and grass; from Foundry Corner to the
 * exit of Wharf Street it collapses to 3.5, which puts the barrier three metres
 * off the racing line and lets the buildings stand where they would really
 * stand. Nothing else about those corners changes - the difficulty comes
 * entirely from having nowhere to put a mistake.
 */
const VELLUM_CONTROLS = [
  { x: 30, z: 203, y: 0.0, w: 11.5 },    //  0  start/finish line
  { x: 90, z: 199, y: 0.5, w: 11.5 },
  { x: 140, z: 189, y: 1.3, w: 11.0 },
  { x: 180, z: 174, y: 2.6, w: 10.0 },   //  3  T1, long left onto the east straight
  { x: 214, z: 142, y: 4.2, w: 9.5 },
  { x: 224, z: 100, y: 5.8, w: 9.5 },
  { x: 216, z: 54, y: 7.2, w: 10.0 },    //  6  east straight, climbing
  { x: 213, z: 2, y: 9.0, w: 10.0 },
  { x: 229, z: -48, y: 11.6, w: 9.5 },   //  8  right kink
  { x: 212, z: -98, y: 14.4, w: 9.0 },
  { x: 176, z: -142, y: 17.2, w: 9.0 },
  { x: 130, z: -170, y: 19.6, w: 9.0 },  // 11  first crest
  { x: 86, z: -160, y: 20.6, w: 8.5 },
  { x: 56, z: -124, y: 18.2, w: 8.5 },   // 13  esse left
  { x: 20, z: -142, y: 19.6, w: 8.5 },   // 14  esse right
  { x: -16, z: -188, y: 21.8, w: 9.0 },  // 15  ridge top
  { x: -72, z: -204, y: 21.6, w: 8.5 },  // 16  Ridge Loop entry
  { x: -122, z: -192, y: 20.4, w: 8.0 },
  { x: -148, z: -162, y: 18.8, w: 8.0 }, // 18  Ridge Loop apex
  { x: -144, z: -128, y: 16.6, w: 8.5 },
  { x: -114, z: -100, y: 12.8, w: 9.5 }, // 20  the Descent
  { x: -86, z: -68, y: 8.4, w: 10.0 },
  { x: -80, z: -36, y: 4.6, w: 10.0, v: 8 },
  { x: -82, z: -12, y: 2.2, w: 9.0, v: 4.5 },   // 23  Foundry Corner entry
  { x: -96, z: 6, y: 0.9, w: 8.0, v: 3.5 },     // 24  apex
  { x: -120, z: 14, y: 0.2, w: 9.0, v: 3.5 },
  { x: -162, z: 12, y: 0.0, w: 10.0, v: 3.5 },  // 26  Foundry Road
  { x: -200, z: 14, y: 0.0, w: 9.0, v: 3.5 },
  { x: -216, z: 32, y: 0.0, w: 8.0, v: 3.5 },   // 28  Dock Turn apex
  { x: -218, z: 58, y: 0.0, w: 9.0, v: 3.5 },
  { x: -216, z: 100, y: 0.0, w: 9.5, v: 3.5 },  // 30  Grand Avenue
  { x: -208, z: 128, y: 0.0, w: 8.5, v: 3.5 },
  { x: -186, z: 140, y: 0.0, w: 8.0, v: 3.5 },  // 32  Cargo Turn
  { x: -152, z: 142, y: 0.0, w: 9.0, v: 3.5 },  // 33  Wharf Street
  { x: -118, z: 150, y: 0.0, w: 9.0, v: 4.5 },
  { x: -92, z: 168, y: 0.0, w: 9.5, v: 7 },     // 35  out of the city
  { x: -74, z: 194, y: 0.0, w: 10.5 },
  { x: -40, z: 203, y: 0.0, w: 11.5 },          // 37  onto the main straight
  { x: -6, z: 204, y: 0.0, w: 11.5 },
];

/* ------------------------------------------------------------------ */
/* Circuit 2 - Cinder Gorge                                            */
/* ------------------------------------------------------------------ */

/**
 * A quarry circuit: flat plain at the bottom, 27 m of climb up the east side
 * through a chicane, a crested rim, and a technical descent with a hairpin on
 * it back to the plain.
 *
 * Authored in local coordinates about its own centre and offset by `origin`, so
 * the shape can be reasoned about against its own ±180 m budget rather than
 * against wherever on the map it ended up.
 *
 * The narrow `v` through the gorge is the point of the place: 5.5 m of run-off
 * against Vellum's 11 puts the rock walls close enough that the Steps have to
 * be taken on a line rather than on a prayer.
 */
const CINDER_CONTROLS = [
  { x: -92, z: 168, y: 0.0, w: 11.5 },          //  0  start/finish
  { x: -36, z: 170, y: 0.0, w: 11.5 },
  { x: 20, z: 169, y: 0.4, w: 11.0 },
  { x: 70, z: 164, y: 1.0, w: 10.5 },           //  3  braking
  { x: 104, z: 154, y: 1.8, w: 9.0, v: 7 },     //  4  Kiln chicane, left
  { x: 122, z: 136, y: 2.8, w: 9.0, v: 7 },     //  5  chicane, right
  { x: 150, z: 116, y: 4.2, w: 9.0 },           //  6  T1 proper, opening
  { x: 164, z: 84, y: 6.0, w: 9.5 },            //  7  east leg, climbing
  { x: 162, z: 48, y: 8.0, w: 9.5 },
  { x: 140, z: 26, y: 9.4, w: 7.5, v: 7 },      //  9  Cinder chicane, left
  { x: 148, z: 0, y: 10.8, w: 7.5, v: 7 },      // 10  chicane, right
  { x: 170, z: -24, y: 12.6, w: 9.0 },
  { x: 176, z: -60, y: 15.2, w: 9.0, v: 8 },    // 12  into the gorge
  { x: 164, z: -96, y: 18.6, w: 8.5, v: 5.5 },
  { x: 140, z: -124, y: 21.8, w: 8.0, v: 5.5 }, // 14  the Steps, tightening right
  { x: 108, z: -144, y: 24.4, w: 8.0, v: 5.5 },
  { x: 72, z: -154, y: 26.2, w: 8.5, v: 5.5 },  // 16  the Rim, crest
  { x: 36, z: -152, y: 27.0, w: 8.5, v: 6 },
  { x: 4, z: -140, y: 26.6, w: 8.0, v: 6 },     // 18  Bench esse, right
  { x: -18, z: -118, y: 25.4, w: 7.5, v: 7 },   // 19  Bench esse, left
  { x: -14, z: -88, y: 24.0, w: 8.0 },
  { x: -38, z: -66, y: 22.4, w: 7.2 },          // 21  Furnace hairpin
  { x: -76, z: -68, y: 21.0, w: 7.2 },          // 22  and out of it
  { x: -104, z: -88, y: 19.4, w: 8.0 },
  { x: -128, z: -112, y: 17.0, w: 8.5 },        // 24  the drop
  { x: -150, z: -138, y: 14.2, w: 8.0 },
  { x: -174, z: -122, y: 11.6, w: 7.5 },        // 26  north-west corner
  { x: -186, z: -84, y: 9.4, w: 8.5 },          // 27  west leg, descending
  { x: -172, z: -54, y: 7.6, w: 8.5 },
  { x: -152, z: -30, y: 6.2, w: 7.5, v: 7 },    // 29  Slate chicane, left
  { x: -158, z: -2, y: 4.8, w: 7.5, v: 7 },     // 30  chicane, right
  { x: -178, z: 22, y: 3.4, w: 9.0 },
  { x: -176, z: 58, y: 2.2, w: 9.0 },
  { x: -164, z: 92, y: 1.2, w: 9.5 },
  { x: -148, z: 124, y: 0.5, w: 10.0 },         // 34  final sweeper
  { x: -122, z: 152, y: 0.1, w: 11.0 },
];

/* ------------------------------------------------------------------ */
/* Circuit 3 - Aurora Rise                                             */
/* ------------------------------------------------------------------ */

/**
 * A highland circuit with the loop on it: 29 m of climb to a summit, a long
 * descending sweep off the back of it, and a level run down the west side where
 * the loop stands.
 *
 * Points 22 to 26 are deliberately near-straight and near-level for 90 m. That
 * is not laziness on a boring section: it is the only place on this circuit
 * where a vertical loop can stand without leaning, and a leaning loop is one
 * the car exits pointing somewhere it did not enter from. See `loop` below.
 */
const AURORA_CONTROLS = [
  { x: -92, z: 164, y: 0.0, w: 11.5 },          //  0  start/finish
  { x: -36, z: 166, y: 0.0, w: 11.5 },
  { x: 20, z: 165, y: 0.2, w: 11.0 },
  { x: 70, z: 158, y: 0.8, w: 10.0 },           //  3  braking
  { x: 106, z: 146, y: 1.6, w: 9.0 },           //  4  T1, first apex
  { x: 134, z: 128, y: 2.8, w: 9.0 },
  { x: 152, z: 102, y: 4.6, w: 8.5 },           //  6  T2, and it tightens
  { x: 160, z: 70, y: 6.8, w: 9.5 },
  { x: 158, z: 36, y: 9.2, w: 9.5 },
  { x: 136, z: 14, y: 11.4, w: 7.5, v: 7 },     //  9  Skyfall chicane, left
  { x: 144, z: -12, y: 13.2, w: 7.5, v: 7 },    // 10  chicane, right
  { x: 166, z: -34, y: 15.4, w: 9.0 },
  { x: 172, z: -68, y: 18.6, w: 9.0 },          // 12  the long climb
  { x: 162, z: -100, y: 21.8, w: 8.5 },
  { x: 140, z: -126, y: 24.6, w: 8.0 },
  { x: 112, z: -146, y: 27.0, w: 8.0 },
  { x: 78, z: -156, y: 28.6, w: 8.0 },          // 16  summit
  { x: 46, z: -152, y: 29.4, w: 8.0 },
  { x: 22, z: -160, y: 29.2, w: 8.0 },          // 18  Beacon flick, over the crest
  { x: -6, z: -150, y: 28.6, w: 8.0, v: 8 },    // 19  Ridge esse, right
  { x: -30, z: -126, y: 27.4, w: 7.8, v: 8 },   // 20  Ridge esse, left
  { x: -12, z: -100, y: 25.8, w: 8.5 },         // 21  and out
  { x: -40, z: -78, y: 23.4, w: 8.0 },          // 22  Cairn hook
  { x: -78, z: -82, y: 21.0, w: 8.5 },
  { x: -108, z: -98, y: 18.4, w: 9.0 },         // 24  the plunge
  { x: -142, z: -116, y: 15.6, w: 8.5 },
  { x: -164, z: -82, y: 12.6, w: 8.5 },         // 26  turning south
  { x: -162, z: -46, y: 9.4, w: 9.0 },
  { x: -158, z: -10, y: 6.4, w: 9.5 },
  { x: -152, z: 26, y: 5.0, w: 10.5 },          // 29  the level straight starts
  { x: -150, z: 62, y: 5.0, w: 10.5 },          // 30  THE LOOP stands here
  { x: -148, z: 98, y: 5.0, w: 10.5 },
  { x: -140, z: 130, y: 3.0, w: 10.0 },         // 32  final sweeper
  { x: -120, z: 156, y: 0.6, w: 11.0 },
];

/* ------------------------------------------------------------------ */
/* The circuits                                                        */
/* ------------------------------------------------------------------ */

/**
 * @typedef {object} CircuitDef
 * @property {string} id            stable key; saved and used by the picker
 * @property {string} name          shown on the picker and the ready prompt
 * @property {string} kicker        one line of character for the picker
 * @property {string} blurb         what makes this circuit different to drive
 * @property {{x:number,z:number}} origin  where the local control points land
 * @property {Array<object>} controls
 * @property {{easy:number,standard:number,expert:number}} laps
 * @property {(lx:number,lz:number)=>boolean} fenced  spectator sections, local coords
 * @property {'coast'|'gorge'|'highland'} dressing
 * @property {boolean} paddock      full pit lane and grandstand, or the light kit
 * @property {null|{anchor:{x:number,z:number}, radius:number, advance:number, width:number}} loop
 * @property {number} accent        colour used by the picker and the gantry trim
 */

/** @type {CircuitDef[]} */
export const CIRCUITS = [
  {
    id: 'vellum',
    name: 'Vellum Ridge Circuit',
    kicker: 'Coastal',
    blurb: 'Ridge line, a long descent and two city blocks with no run-off. '
      + 'The original: fast, open, and unforgiving only where the buildings start.',
    origin: { x: 0, z: 0 },
    controls: VELLUM_CONTROLS,
    laps: { easy: 3, standard: 5, expert: 10 },
    // The main straight, the city and the two grandstand corners.
    fenced: (x, z) => z > 150 || (x < -120 && z > -10) || (x > 150 && z > 60),
    dressing: 'coast',
    paddock: true,
    loop: null,
    accent: 0x52e9ff,
  },
  {
    id: 'cinder',
    name: 'Cinder Gorge',
    kicker: 'Quarry',
    blurb: 'Two chicanes, a hairpin and a crested rim with 5 m of run-off. '
      + 'The tightest circuit here — carry the climb or lose the lap on the descent.',
    origin: { x: -390, z: -390 },
    controls: CINDER_CONTROLS,
    laps: { easy: 3, standard: 6, expert: 11 },
    // Only the start/finish plain has stands; the gorge has rock instead.
    fenced: (x, z) => z > 134 || (z > 84 && x < -140),
    dressing: 'gorge',
    paddock: false,
    loop: null,
    accent: 0xff8a3d,
  },
  {
    id: 'aurora',
    name: 'Aurora Rise',
    kicker: 'Highland',
    blurb: 'A climb to the summit, a plunge off the back of it, and a vertical '
      + 'loop on the west straight that every lap has to go over the top of.',
    origin: { x: 390, z: 390 },
    controls: AURORA_CONTROLS,
    laps: { easy: 3, standard: 6, expert: 11 },
    fenced: (x, z) => z > 132 || (x < -130 && z > 20 && z < 112),
    dressing: 'highland',
    paddock: false,
    /* The loop.
     *
     * `anchor` is a point near the middle of the level straight; the builder
     * snaps it to the nearest centreline sample and takes that as the entry.
     * `advance` is how far along the road the exit is from the entry - a true
     * circular loop would put them in the same place, which reads as a car
     * teleporting, so the loop leans forward by roughly a third of its own
     * circumference. `radius` is measured to the road surface, so the apex is
     * 2 x radius above the tarmac and the car passes it upside down.
     */
    loop: { anchor: { x: -150, z: 58 }, radius: 15, advance: 34, width: 9 },
    accent: 0x9d7dff,
  },
];

/** Look one up by id, falling back to the first. */
export function circuitById(id) {
  return CIRCUITS.find((c) => c.id === id) ?? CIRCUITS[0];
}

/**
 * Control points moved into world space.
 * @param {CircuitDef} def
 */
export function worldControls(def) {
  const ox = def.origin?.x ?? 0;
  const oz = def.origin?.z ?? 0;
  if (!ox && !oz) return def.controls;
  return def.controls.map((p) => ({ ...p, x: p.x + ox, z: p.z + oz }));
}

/* ------------------------------------------------------------------ */
/* Many circuits, one height function                                  */
/* ------------------------------------------------------------------ */

/**
 * The three circuits presented as the single height function the world is built
 * from.
 *
 * Every terrain vertex, every collider, every prop placement goes through
 * `probe`, exactly as it did when there was one circuit - which is the property
 * that kept the old world's collision and geometry in agreement, and the one
 * worth preserving hardest while adding two more roads to disagree about.
 *
 * The bounding-box reject is what makes it affordable. A naive version would
 * ask all three courses for their nearest centreline point at all 110 000
 * terrain vertices; since the circuits are 500 m apart and each blend saturates
 * within 50 m, at most one of them can have anything to say about any given
 * point, and the box test finds which in a few comparisons.
 */
export class CourseSet {
  /**
   * @param {Array<import('./RaceTrack.js').RaceCourse>} courses
   * @param {(x:number,z:number)=>number} base natural ground
   */
  constructor(courses, base) {
    this.courses = courses;
    this.baseHeight = base;
    /** Reach past the sealed surface where a course can still move the ground. */
    this.pad = 64;
    this.boxes = courses.map((co) => {
      let x0 = Infinity;
      let x1 = -Infinity;
      let z0 = Infinity;
      let z1 = -Infinity;
      for (let i = 0; i < co.count; i++) {
        if (co.x[i] < x0) x0 = co.x[i];
        if (co.x[i] > x1) x1 = co.x[i];
        if (co.z[i] < z0) z0 = co.z[i];
        if (co.z[i] > z1) z1 = co.z[i];
      }
      const pad = this.pad + co.W[0] + 24;
      return { x0: x0 - pad, x1: x1 + pad, z0: z0 - pad, z1: z1 + pad };
    });
  }

  /** The course whose corridor owns this point, or null out in the country. */
  courseAt(x, z) {
    let best = null;
    let bestD = Infinity;
    for (let i = 0; i < this.courses.length; i++) {
      const b = this.boxes[i];
      if (x < b.x0 || x > b.x1 || z < b.z0 || z > b.z1) continue;
      const nr = this.courses[i].nearest(x, z);
      if (!nr) continue;
      if (nr.d < bestD) {
        bestD = nr.d;
        best = this.courses[i];
      }
    }
    return best;
  }

  /** See RaceCourse.probe - same contract, whichever circuit is nearest. */
  probe(x, z) {
    const base = this.baseHeight(x, z);
    let best = null;
    let bestD = Infinity;
    for (let i = 0; i < this.courses.length; i++) {
      const b = this.boxes[i];
      if (x < b.x0 || x > b.x1 || z < b.z0 || z > b.z1) continue;
      const p = this.courses[i].probe(x, z);
      if (p.d < bestD) {
        bestD = p.d;
        best = p;
      }
    }
    return best ?? { h: base, d: Infinity, w: 0, W: 0, road: base, base };
  }

  /** Convenience wrapper; see {@link probe}. */
  surfaceHeight(x, z) {
    return this.probe(x, z).h;
  }
}
