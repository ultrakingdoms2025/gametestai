/**
 * Quadruped gait tables, and the pure arithmetic that drives them.
 *
 * ── Why this is its own module ────────────────────────────────────────────
 * `Horse.js` proved the pattern: a four-legged animal reads as an animal
 * because of its FOOTFALL PATTERN, not because its legs move. A trot and a
 * gallop played from the same phase table at different rates are the same
 * animation twice; a trot and a gallop played from their own tables are two
 * different creatures. The tables are therefore data, and the data lives here -
 * away from geometry, away from THREE, away from the AI - so that it can be
 * checked without a renderer and shared by the animator and the tests alike.
 *
 * ── The model ─────────────────────────────────────────────────────────────
 * One cycle of the whole animal is a phase in [0, 1). Each leg has a fixed
 * OFFSET into that cycle, in turns, and within its own local phase `t` it is:
 *
 *     t <  swing   →  SWING   (foot in the air, travelling forward)
 *     t >= swing   →  STANCE  (foot planted, pushing the body along)
 *
 * so `1 - swing` is the leg's duty factor. The instant `t` crosses `swing` is
 * the FOOTFALL: that is where the hoof/paw sound and the ground puff belong,
 * and taking it from the same table that placed the leg is the only way the
 * sound can never drift out of step with the picture.
 *
 * ── What makes a gait table valid ─────────────────────────────────────────
 * The obvious rule - "never two legs in swing at once" - is simply false for
 * real animals: a trot is DEFINED by the diagonal pairs swinging together, and
 * a bear's amble by the lateral ones. The real invariant is SUPPORT:
 *
 *   - a walking / trotting / ambling animal always has at least two feet down;
 *   - a running animal may leave the ground entirely, but only for a bounded
 *     slice of the cycle (a bound with 60% suspension is a bouncing ball);
 *   - the footfalls of a 4-beat gait land at four distinct moments, or the
 *     animal is not doing the gait its table claims.
 *
 * `supportCount`, `footfallPhases` and `suspensionFraction` express exactly
 * those three, which is what `scripts/tests/beast-gait.test.mjs` holds.
 *
 * Phase order throughout is [FL, FR, HL, HR] - front-left, front-right,
 * hind-left, hind-right - matching the leg order `BeastBody` builds in.
 */

/** Leg index names, in the order every table and every leg array uses. */
export const LEG_ORDER = ['FL', 'FR', 'HL', 'HR'];

/**
 * Phase offsets per gait, in turns, ordered [FL, FR, HL, HR].
 *
 * These are the real patterns, not decoration:
 *
 *  - `trot` puts the diagonal pairs exactly out of phase - FL with HR, FR with
 *    HL. It is the wolf's cruising gait and the one a player sees most.
 *  - `lope` is a canter: a leading foreleg, its diagonal partner close behind,
 *    and a trailing pair. Three beats, continuous support.
 *  - `sprint` is a four-beat gallop with the hind pair grouped ahead of the
 *    fore pair, which is what opens the flight phase after the forelegs leave.
 *  - `amble` is the bear's: LATERAL couplets, left side then right side. It is
 *    the single most recognisable thing about how a bear moves and it is the
 *    reason a bear never reads as a big wolf.
 *  - `charge` is the bear's bounding run - the same grouping as the gallop, on
 *    a shorter, heavier duty factor.
 */
export const GAIT_PHASE = {
  stand:  [0, 0, 0, 0],
  trot:   [0, 0.5, 0.5, 0],
  lope:   [0, 0.15, 0.5, 0.65],
  sprint: [0.3, 0.42, 0.0, 0.12],
  amble:  [0, 0.5, 0.1, 0.6],
  charge: [0.3, 0.42, 0.0, 0.12],
};

/**
 * @typedef {object} Gait
 * @property {string} name    key into {@link GAIT_PHASE}
 * @property {number} max     top of this gait's speed band, m/s
 * @property {number} stride  ground covered by one COMPLETE cycle, metres
 * @property {number} swing   fraction of a leg's cycle spent in the air
 * @property {number} lift    peak foot lift, metres
 * @property {number} reach   peak fore/aft swing of the upper leg, radians
 * @property {number} bob     vertical body travel, metres
 */

/**
 * Gait bands per species, ordered slowest first.
 *
 * `stride` is metres per complete cycle, so `speed / stride` is the cycle rate
 * and the feet can never skate: phase advances with distance travelled, exactly
 * as it does on the horse. The strides lengthen with the band for the same
 * reason a real animal's do - most of the extra speed comes from a longer
 * stride, not from a faster one - and getting that backwards is what makes an
 * animal look like a sewing machine at full pelt.
 */
export const GAITS = {
  wolf: [
    { name: 'stand',  max: 0.15,     stride: 0,   swing: 0,    lift: 0,    reach: 0,    bob: 0 },
    { name: 'trot',   max: 3.4,      stride: 2.2, swing: 0.42, lift: 0.14, reach: 0.62, bob: 0.026 },
    { name: 'lope',   max: 5.6,      stride: 3.0, swing: 0.55, lift: 0.22, reach: 0.82, bob: 0.062 },
    { name: 'sprint', max: Infinity, stride: 4.0, swing: 0.62, lift: 0.30, reach: 1.02, bob: 0.10 },
  ],
  bear: [
    { name: 'stand',  max: 0.15,     stride: 0,   swing: 0,    lift: 0,    reach: 0,    bob: 0 },
    { name: 'amble',  max: 3.0,      stride: 2.8, swing: 0.36, lift: 0.13, reach: 0.50, bob: 0.030 },
    { name: 'charge', max: Infinity, stride: 4.2, swing: 0.58, lift: 0.26, reach: 0.86, bob: 0.095 },
  ],
};

/** Wrap into [0, 1). */
const wrap01 = (t) => {
  const v = t % 1;
  return v < 0 ? v + 1 : v;
};

/**
 * The gait band a given speed falls in.
 * @param {string} species key into {@link GAITS}
 * @param {number} speed metres per second, absolute
 * @returns {Gait}
 */
export function gaitFor(species, speed) {
  const table = GAITS[species] ?? GAITS.wolf;
  const s = Math.abs(speed);
  for (const g of table) {
    if (s <= g.max) return g;
  }
  return table[table.length - 1];
}

/**
 * Local phase of one leg.
 * @param {number} cyclePhase 0..1 phase of the whole animal
 * @param {number} offset the leg's entry in {@link GAIT_PHASE}
 */
export function legPhase(cyclePhase, offset) {
  return wrap01(cyclePhase + offset);
}

/** Is a leg at local phase `t` in the air? */
export function isSwing(t, swing) {
  return swing > 0 && wrap01(t) < swing;
}

/**
 * How many feet are on the ground at `cyclePhase`.
 *
 * The single most useful thing to know about a gait table: zero means the
 * animal is airborne, one means it is falling onto the next foot, two or more
 * means it is standing on itself.
 *
 * @param {Gait} gait
 * @param {number} cyclePhase
 * @returns {number} 0..4
 */
export function supportCount(gait, cyclePhase) {
  const offsets = GAIT_PHASE[gait.name] ?? GAIT_PHASE.stand;
  let n = 0;
  for (let i = 0; i < 4; i++) {
    if (!isSwing(legPhase(cyclePhase, offsets[i]), gait.swing)) n++;
  }
  return n;
}

/**
 * The cycle phase at which each leg plants, ordered [FL, FR, HL, HR].
 *
 * A leg is in swing for the first `swing` of its own cycle, so it plants when
 * its local phase reaches `swing` - which happens at cycle phase
 * `swing - offset`. Four distinct values is a four-beat gait; two pairs is a
 * two-beat one (the trot); anything else is a table with a typo in it.
 *
 * @param {Gait} gait
 * @returns {number[]} four phases in [0, 1)
 */
export function footfallPhases(gait) {
  const offsets = GAIT_PHASE[gait.name] ?? GAIT_PHASE.stand;
  return offsets.map((o) => wrap01(gait.swing - o));
}

/**
 * Fraction of the cycle with no foot on the ground at all.
 *
 * Sampled rather than solved: the stance intervals are arcs on a circle and the
 * closed form is a union-of-intervals problem that buys nothing here. 720
 * samples is half a degree of cycle, which is finer than any suspension phase
 * these tables express.
 *
 * @param {Gait} gait
 * @param {number} [samples]
 * @returns {number} 0..1
 */
export function suspensionFraction(gait, samples = 720) {
  let airborne = 0;
  for (let i = 0; i < samples; i++) {
    if (supportCount(gait, i / samples) === 0) airborne++;
  }
  return airborne / samples;
}

/**
 * Pose one leg from its local phase.
 *
 * Swing is a single forward arc; stance is the slower push back underneath the
 * body. The asymmetry between the two - a fast reach and a long push - is what
 * makes a leg look like it is driving the animal rather than pedalling, and it
 * comes out of the duty factor for free.
 *
 * @param {number} t local phase, 0..1
 * @param {Gait} gait
 * @param {boolean} front front legs reach further and fold less
 * @returns {{swing:number, lift:number, fold:number}} radians, metres, radians
 */
export function legPose(t, gait, front) {
  if (gait.swing <= 0) return { swing: 0, lift: 0, fold: front ? 0.06 : 0.14 };
  const p = wrap01(t);
  const reach = gait.reach * (front ? 1 : 0.86);
  if (p < gait.swing) {
    const u = p / gait.swing;
    const s = Math.sin(u * Math.PI) * reach;
    return {
      swing: s,
      lift: Math.sin(u * Math.PI) * gait.lift,
      // Knee/hock folds hardest in the middle of the reach and only ever one way.
      fold: (front ? 0.9 : 1.25) * Math.max(0, s),
    };
  }
  const u = (p - gait.swing) / (1 - gait.swing);
  return {
    swing: -Math.sin(u * Math.PI) * reach * 0.62,
    lift: 0,
    fold: front ? 0.06 : 0.14,
  };
}

/**
 * Did this leg plant between `prevT` and `t`?
 *
 * Both are local phases and the cycle wraps, so a naive `prevT < swing <= t`
 * misses every footfall that straddles the wrap. Comparing the *distance
 * travelled* past the plant instead is wrap-safe and costs one subtraction.
 *
 * @param {number} prevT previous local phase
 * @param {number} t current local phase
 * @param {Gait} gait
 * @returns {boolean}
 */
export function planted(prevT, t, gait) {
  if (gait.swing <= 0) return false;
  const before = wrap01(prevT - gait.swing);
  const after = wrap01(t - gait.swing);
  // Advancing across the plant shows up as the "past the plant" measure
  // resetting to nearly zero from nearly one.
  return after < before;
}

export { wrap01 };
