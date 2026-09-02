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
 *  - `pace` is the camel's, and it is the strongest species cue in this whole
 *    file. A pace is the LATERAL couplets moving in EXACT synchrony - not the
 *    bear's staggered lateral sequence, which is an amble, but both feet on one
 *    side leaving and landing together. That is what rolls a camel from side to
 *    side and it is why a camel is a ship. Two beats, like the trot, off the
 *    opposite pairing: [0, 0.5, 0, 0.5] is FL with HL, FR with HR.
 *  - `gallop` is the camel's flat-out bolt, four beats with the hind pair
 *    grouped ahead of the fore pair. It is deliberately NOT named `sprint` or
 *    `charge`: those two names are what `beast-gait.test.mjs` counts to prove
 *    the wolf and the bear each still own exactly one running gait.
 */
export const GAIT_PHASE = {
  stand:  [0, 0, 0, 0],
  trot:   [0, 0.5, 0.5, 0],
  lope:   [0, 0.15, 0.5, 0.65],
  sprint: [0.3, 0.42, 0.0, 0.12],
  amble:  [0, 0.5, 0.1, 0.6],
  charge: [0.3, 0.42, 0.0, 0.12],
  pace:   [0, 0.5, 0, 0.5],
  gallop: [0.30, 0.44, 0.0, 0.14],
};

/**
 * @typedef {object} Gait
 * @property {string} name    key into {@link GAIT_PHASE}
 * @property {number} max     top of this gait's speed band, m/s
 * @property {number} stride  ground covered by one COMPLETE cycle, metres
 * @property {number} swing   fraction of a leg's cycle spent in the air
 * @property {number} lift    peak foot lift, metres
 * @property {number} reach   knee/hock fold scale, radians. It was the leg's
 *   fore/aft sweep until that sweep was derived from the stride instead
 *   (@see stanceReach), and it is left at exactly the value it always had so
 *   that the fold - a clearance flourish, not a contact-point term - is
 *   unchanged by that fix.
 * @property {number} bob     vertical body travel, metres
 * @property {number} [roll]  peak LATERAL body roll, radians, one full cycle of
 *   it per stride cycle. Absent on every four-legged gait whose footfalls are
 *   diagonal or staggered, because those cancel sideways; present only on the
 *   camel's `pace`, where both legs on one side leave the ground together and
 *   the body genuinely falls toward the unsupported side. `BeastAnimator` adds
 *   the term only when it is non-zero, so a gait without it is bit-for-bit the
 *   animation it was before this field existed.
 */

/**
 * Gait bands per species, ordered slowest first.
 *
 * `stride` is metres per complete cycle, so `speed / stride` is the cycle rate
 * and the phase advances with DISTANCE TRAVELLED, exactly as it does on the
 * horse. That is HALF of what it takes to keep a planted foot still, and this
 * note used to claim it was all of it - "the feet can never skate" - while
 * `legPose` swept a planted foot back to mid-stance and then forward again and
 * put the contact point down exactly where it picked it up. The phase was never
 * the half that was wrong. @see legPose and @see stanceReach for the other half.
 *
 * The strides lengthen with the band for the same reason a real animal's do -
 * most of the extra speed comes from a longer stride, not from a faster one -
 * and getting that backwards is what makes an animal look like a sewing machine
 * at full pelt. They are also, measurably, LONGER than legs this short can
 * cover; `stanceReach` carries that accounting and what it costs.
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
  /**
   * CAMEL - two gaits, and the slow one is the whole character.
   *
   * A camel has no trot. It PACES at everything short of a bolt, which is why
   * the band below runs all the way to 3.4 m/s off a single table: there is no
   * intermediate gear to build, because the animal does not have one.
   *
   * The strides are long because the legs are - 3.4 m a cycle against a bear's
   * 2.8 on an animal only a little longer - and that is what keeps the cycle
   * rate down at 1.0/s at the top of the pace band. A camel walking looks slow
   * and covers ground, and the arithmetic is where that comes from: it is the
   * lowest cycle rate of any gait in this file, and the wolf's trot at the top
   * of its own band is 1.55.
   *
   * `roll` is the ship. @see the field note on the Gait typedef.
   */
  camel: [
    { name: 'stand',  max: 0.15,     stride: 0,   swing: 0,    lift: 0,    reach: 0,    bob: 0 },
    { name: 'pace',   max: 3.4,      stride: 3.4, swing: 0.45, lift: 0.20, reach: 0.58, bob: 0.055,
      roll: 0.075 },
    { name: 'gallop', max: Infinity, stride: 4.8, swing: 0.58, lift: 0.30, reach: 0.86, bob: 0.105,
      roll: 0.022 },
  ],
};

/**
 * Hip height above the ground, in metres, ordered [front, hind].
 *
 * A leg in this rig is a rigid link that pivots at the hip and finishes on the
 * ground, so the hip's height IS the radius its contact point swings on, and it
 * is the one number the stride arithmetic below cannot be done without.
 *
 * The values are `legs.frontHipY` / `legs.hindHipY` from `BeastBody`'s profiles,
 * copied rather than imported: this module is deliberately free of THREE and of
 * geometry (see the header), and pulling the body in to read six numbers would
 * drag the renderer into a table the tests load without one. If a profile's hips
 * move, these move with them.
 *
 * They are NOT scaled by `BeastBody.heightScale`, the 0.9 - 1.1 per-animal size
 * jitter this module cannot see: a small wolf therefore sweeps a little less far
 * than its stride wants and a large one a little too far, by up to a tenth
 * either way. That is an order of magnitude under the error the stride tables
 * themselves carry - @see stanceReach.
 */
export const LEG_LENGTH = {
  wolf:  [0.620, 0.645],
  bear:  [1.000, 0.980],
  camel: [1.460, 1.460],
};

/** Clamp, local so this module stays free of THREE. */
const clamp = (v, lo, hi) => (v < lo ? lo : (v > hi ? hi : v));

/**
 * How far one leg may sweep fore and aft, in radians, and the two facts that
 * fight over the answer.
 *
 * WHAT THE STRIDE DEMANDS. While a foot is down the body covers
 * `(1 - swing) * stride` metres, so the contact point has to travel exactly
 * that far REARWARD relative to the hip or the foot is sliding along the
 * ground. Half of that lies either side of the hip, and a leg of length L swung
 * by theta puts its foot L*sin(theta) from under it, so the sweep the stride is
 * asking for is asin((1 - swing) * stride / 2L).
 *
 * WHAT THE LEG CAN ACTUALLY HOLD DOWN. The same rigid link lifts its foot
 * L*(1 - cos theta) off the ground at the ends of that sweep, and there is no IK
 * here and no knee extension to put it back (`fold` is constant through
 * stance). Sweep far enough and the animal is standing on air at both ends of
 * every step, which is a worse defect than the one this arithmetic exists to
 * fix. The ceiling is therefore the sweep at which a PLANTED foot rises no
 * higher than the gait already lifts a SWINGING one: acos(1 - lift / L).
 *
 * MEASURED OVER THE SHIPPED TABLES, THE CEILING IS THE ONE THAT BINDS. Every
 * gait in this file asks for more ground than its legs can cover (front legs,
 * metres either side of the hip - needed against available):
 *
 *   wolf trot     0.64 / 0.39   62%      bear amble    0.90 / 0.49   55%
 *   wolf lope     0.67 / 0.47   70%      bear charge   0.88 / 0.67   76%
 *   wolf sprint   0.76 / 0.53   70%      camel pace    0.94 / 0.74   79%
 *                                        camel gallop  1.01 / 0.89   88%
 *
 * so what ships still slides a fifth to a half of a stance - against the WHOLE
 * of one before this, because the old stance curve was a sine hump that ended
 * where it began and moved the contact point by nothing at all. Closing the rest
 * is not a pose problem: these strides are 1.3 - 1.8x what an animal of this
 * size really takes, and shortening them (or giving stance a knee that extends)
 * is a change to tables and rigs that other files own. The `Math.min` below is
 * what makes that fix land automatically if it is ever made - shorten a stride
 * and the derived sweep drops under the ceiling and starts tracking it.
 *
 * @param {Gait} gait
 * @param {number} legLength hip height above the ground, metres
 * @returns {number} radians; 0 for a gait that does not move
 */
export function stanceReach(gait, legLength) {
  if (!(gait.swing > 0) || !(gait.stride > 0) || !(legLength > 0)) return 0;
  const wanted = Math.asin(clamp(((1 - gait.swing) * gait.stride) / (2 * legLength), -0.95, 0.95));
  const holdable = Math.acos(clamp(1 - gait.lift / legLength, -1, 1));
  return Math.min(wanted, holdable);
}

/**
 * The sweep for every shipped gait, worked out once at load.
 *
 * A WeakMap keyed on the gait ROW, rather than a `legLength` field written onto
 * the row, and both halves of that are deliberate. `camel.test.mjs` pins a SHA
 * of `JSON.stringify(GAITS.wolf)` and `GAITS.bear` to prove that adding a
 * species left the two that were already here untouched, and a new field on
 * those rows - however correct - fails that digest. It would also be a lie
 * waiting to happen: leg length belongs to the ANIMAL, not to one of its gears,
 * and a copy of it on every band is a copy to forget when a profile changes.
 */
const AMPLITUDE = new WeakMap();
for (const [species, list] of Object.entries(GAITS)) {
  const legs = LEG_LENGTH[species] ?? LEG_LENGTH.wolf;
  for (const g of list) AMPLITUDE.set(g, [stanceReach(g, legs[0]), stanceReach(g, legs[1])]);
}

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
 * A leg has exactly one job while it is planted: HOLD STILL ON THE GROUND. It
 * cannot do that unless its contact point travels rearward relative to the hip
 * at the rate the body travels forward, so:
 *
 *   STANCE  a monotone ramp from fully forward to fully back, which is the
 *           humanoid's stance verbatim (`NPCAnimator` ~870, in metres there
 *           because that rig has IK and this one has an angle);
 *   SWING   the eased return that carries the foot from behind the animal back
 *           out in front of it, on the same smoothstep and the same 7% lead the
 *           humanoid uses at ~876 - so the foot leads a little through the
 *           middle of the reach and is slowing down as it arrives at the plant.
 *
 * ── The bug both halves used to have ──────────────────────────────────────
 * Both were SINE HUMPS. A hump starts and ends at zero, so the swing never
 * reached forward - the foot touched down directly under the hip - and the
 * stance swept back to mid-stance and then FORWARD AGAIN, riding along with the
 * body for the second half of every step and setting the foot down exactly
 * where it had picked it up. Net contact displacement across a stance: zero.
 * Every quadruped in the game skated its entire stride length, at every speed,
 * for as long as this file has existed, while the header above said it could
 * not because the phase advances with distance. The phase always did. Where the
 * foot sat WITHIN that phase was never tied to it.
 *
 * The amplitude is derived from the stride now rather than authored.
 * @see stanceReach for the arithmetic, and for the honest accounting of the
 * part of the slide this rig cannot fix.
 *
 * @param {number} t local phase, 0..1
 * @param {Gait} gait
 * @param {boolean} front front legs fold less, and stand on their own leg length
 * @returns {{swing:number, lift:number, fold:number}} radians, metres, radians
 */
export function legPose(t, gait, front) {
  if (gait.swing <= 0) return { swing: 0, lift: 0, fold: front ? 0.06 : 0.14 };
  const p = wrap01(t);
  const amp = AMPLITUDE.get(gait);
  // A gait row that did not come from `GAITS` - a test literal - has no entry,
  // and falls back to the wolf's legs rather than to a pose with no sweep.
  const reach = amp ? (front ? amp[0] : amp[1])
    : stanceReach(gait, LEG_LENGTH.wolf[front ? 0 : 1]);
  /* The knee fold keeps the authored `reach`, and the fold is now all it
   * scales: how hard a knee tucks is a ground-clearance flourish, and a fix to
   * where the foot IS has no business restyling every knee in the game. Every
   * fold this function returns is therefore bit-for-bit the one it returned
   * before. @see the `reach` field note. */
  const foldReach = gait.reach * (front ? 1 : 0.86);
  if (p < gait.swing) {
    const u = p / gait.swing;
    const hump = Math.sin(u * Math.PI);
    const ease = u * u * (3 - 2 * u) + 0.07 * hump;
    return {
      swing: -reach + 2 * reach * ease,
      lift: hump * gait.lift,
      // Folds hardest just past vertical - which is where a foot has to clear
      // the ground - and only ever one way.
      fold: (front ? 0.9 : 1.25) * foldReach * hump,
    };
  }
  const u = (p - gait.swing) / (1 - gait.swing);
  return {
    /* +reach at touchdown to -reach at lift-off, linear in u so the contact
     * point moves rearward at a constant rate. Linear in the ANGLE rather than
     * in the contact position: over the sweeps these tables reach, sin(theta)
     * departs from a straight line by about 6% at worst, which is an order of
     * magnitude under the shortfall `stanceReach` documents and does not earn
     * an asin per leg per frame. */
    swing: reach * (1 - 2 * u),
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
