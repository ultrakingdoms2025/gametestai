import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  GAITS, GAIT_PHASE, LEG_ORDER,
  gaitFor, legPhase, legPose, planted, supportCount, footfallPhases, suspensionFraction,
} from '../../src/npc/BeastGait.js';

/**
 * The gait tables, held against what a four-legged animal actually does.
 *
 * ── The rule this suite does NOT check, and why ───────────────────────────
 * The obvious invariant - "no two legs are ever in swing at the same time" -
 * is false for every real quadruped gait except the walk. A TROT is DEFINED by
 * the diagonal pairs leaving the ground together, and a bear's AMBLE by the
 * lateral pairs doing it. Asserting that rule would not catch a broken table;
 * it would forbid the two gaits this game ships.
 *
 * What actually distinguishes a working gait table from a broken one is
 * SUPPORT, and there are three separate claims to hold:
 *
 *   1. an animal moving at a working pace always has at least two feet down -
 *      that is what a duty factor above a half MEANS;
 *   2. an animal at a run may leave the ground, but for a bounded slice of the
 *      cycle - a bound with 60% suspension is a bouncing ball;
 *   3. a gait's footfalls land at the number of distinct moments its name
 *      claims. A four-beat gallop whose beats have collapsed onto each other is
 *      a two-beat gait wearing a gallop's phase table, and it will read as one.
 *
 * All of it is arithmetic over the shipped tables, so a retune that quietly
 * turns the bear's amble into a trot fails here rather than in a play session.
 */

/** Every gait in the game, flattened. */
const ALL = Object.entries(GAITS).flatMap(([species, list]) =>
  list.map((g) => ({ species, gait: g })));

/** The gaits that actually move an animal. `stand` is a special case of none of this. */
const MOVING = ALL.filter(({ gait }) => gait.stride > 0);

/** The two gaits that are meant to have a flight phase. */
const RUNNING = new Set(['sprint', 'charge']);

const SAMPLES = 720;

/* ---------------------------------------------------------------- */
/* Table shape                                                       */
/* ---------------------------------------------------------------- */

test('every gait names a phase table with one entry per leg', () => {
  assert.deepEqual(LEG_ORDER, ['FL', 'FR', 'HL', 'HR']);
  for (const { species, gait } of ALL) {
    const table = GAIT_PHASE[gait.name];
    assert.ok(table, `${species}'s "${gait.name}" has no phase table`);
    assert.equal(table.length, 4, `${gait.name} has ${table.length} legs`);
    for (const o of table) {
      assert.ok(o >= 0 && o < 1, `${gait.name} has an offset of ${o}, which is not a turn`);
    }
  }
});

test('the bands rise, and so do the strides', () => {
  /* A longer stride at a higher speed is not decoration: speed / stride is the
   * cycle rate, so a gait that speeds up WITHOUT lengthening its stride spins
   * its legs faster and faster until the animal is a sewing machine. This is
   * the exact defect Horse.js documents having shipped with. */
  for (const [species, list] of Object.entries(GAITS)) {
    for (let i = 1; i < list.length; i++) {
      assert.ok(list[i].max > list[i - 1].max,
        `${species}: "${list[i].name}" does not sit above "${list[i - 1].name}"`);
      if (list[i - 1].stride === 0) continue;
      assert.ok(list[i].stride > list[i - 1].stride,
        `${species}: "${list[i].name}" covers ${list[i].stride} m a cycle against `
        + `"${list[i - 1].name}"'s ${list[i - 1].stride} - it will spin its legs`);
    }
    assert.equal(list[list.length - 1].max, Infinity,
      `${species} has no gait for its top speed`);
  }
});

test('cycle rates stay in the range a real animal manages', () => {
  // Two and a half cycles a second is about the ceiling for a galloping horse;
  // a wolf at full stretch is a shade under two. Anything past four is a blur.
  for (const { species, gait } of MOVING) {
    const top = Number.isFinite(gait.max) ? gait.max : 8;
    const rate = top / gait.stride;
    assert.ok(rate < 4,
      `${species} "${gait.name}" runs at ${rate.toFixed(2)} cycles/s at the top of its band`);
  }
});

test('gaitFor lands in the right band at every speed', () => {
  for (const [species, list] of Object.entries(GAITS)) {
    for (const g of list) {
      const inside = Number.isFinite(g.max) ? g.max - 1e-6 : 40;
      assert.equal(gaitFor(species, inside).name, g.name,
        `${species} at ${inside} m/s did not pick "${g.name}"`);
    }
    assert.equal(gaitFor(species, 0).name, 'stand');
    // Reverse is still a gait, not a crash.
    assert.equal(gaitFor(species, -5).name, gaitFor(species, 5).name);
  }
  // An unknown species falls back rather than throwing: a mis-typed spawn must
  // cost a log line, not the frame.
  assert.equal(gaitFor('griffin', 1).name, gaitFor('wolf', 1).name);
});

/* ---------------------------------------------------------------- */
/* Support - the invariant that matters                              */
/* ---------------------------------------------------------------- */

test('a standing animal has all four feet on the ground, all the time', () => {
  for (const [species, list] of Object.entries(GAITS)) {
    const stand = list[0];
    for (let i = 0; i < 32; i++) {
      assert.equal(supportCount(stand, i / 32), 4, `${species} stood on ${supportCount(stand, i / 32)} feet`);
    }
  }
});

test('a working pace never leaves the ground and never stands on one foot', () => {
  /* Duty factor at or above a half is the definition of a gait that keeps at
   * least half its feet down. This is the trot and the amble - the gaits a
   * player sees most of - and it is the closest true statement to the "two legs
   * in swing" rule the brief asked for. */
  for (const { species, gait } of MOVING) {
    if (1 - gait.swing < 0.5) continue;
    let worst = 4;
    for (let i = 0; i < SAMPLES; i++) worst = Math.min(worst, supportCount(gait, i / SAMPLES));
    assert.ok(worst >= 2,
      `${species} "${gait.name}" (duty ${(1 - gait.swing).toFixed(2)}) drops to ${worst} feet`);
    assert.equal(suspensionFraction(gait, SAMPLES), 0,
      `${species} "${gait.name}" leaves the ground at a working pace`);
  }
});

test('the running gaits DO leave the ground, and not for long', () => {
  /* Both halves matter. Suspension is what makes a gallop a gallop - a "run"
   * with continuous support is a fast walk - and unbounded suspension is a
   * bouncing ball. A quarter of the cycle is the ceiling. */
  let found = 0;
  for (const { species, gait } of MOVING) {
    const air = suspensionFraction(gait, SAMPLES);
    assert.ok(air < 0.25,
      `${species} "${gait.name}" spends ${(air * 100).toFixed(0)}% of its cycle airborne`);
    if (!RUNNING.has(gait.name)) continue;
    found++;
    assert.ok(air > 0.05,
      `${species} "${gait.name}" is a run with no flight phase (${(air * 100).toFixed(1)}%)`);
  }
  assert.equal(found, 2, 'the wolf sprint and the bear charge are no longer both running gaits');
});

test('no gait is ever standing on nothing for more than a fifth of a second', () => {
  // Suspension expressed in seconds at the top of the band, which is the number
  // a player would actually feel as float.
  for (const { species, gait } of MOVING) {
    const top = Number.isFinite(gait.max) ? gait.max : 8;
    const cycleTime = gait.stride / top;
    const air = suspensionFraction(gait, SAMPLES) * cycleTime;
    assert.ok(air < 0.2, `${species} "${gait.name}" floats for ${air.toFixed(3)}s`);
  }
});

/* ---------------------------------------------------------------- */
/* Beats                                                             */
/* ---------------------------------------------------------------- */

/** Distinct footfall moments, to within half a degree of cycle. */
function beats(gait) {
  const seen = [];
  for (const p of footfallPhases(gait)) {
    if (!seen.some((q) => Math.abs(q - p) < 1 / SAMPLES || Math.abs(q - p) > 1 - 1 / SAMPLES)) {
      seen.push(p);
    }
  }
  return seen.length;
}

test('the trot is a two-beat gait on diagonal pairs', () => {
  const trot = GAITS.wolf.find((g) => g.name === 'trot');
  assert.equal(beats(trot), 2, 'the trot has stopped being a two-beat gait');
  const [FL, FR, HL, HR] = GAIT_PHASE.trot;
  // FL with HR, FR with HL. If this pairing ever flips to same-side the wolf
  // starts pacing, which is the bear's gait and reads as the wrong animal.
  assert.equal(FL, HR, 'the wolf trot has lost its FL/HR diagonal');
  assert.equal(FR, HL, 'the wolf trot has lost its FR/HL diagonal');
  assert.ok(Math.abs(FL - FR) === 0.5, 'the diagonals are no longer in antiphase');
});

test('the bear ambles on LATERAL couplets - the thing that says "bear"', () => {
  /* A bear moves both legs on one side, then both on the other. It is the most
   * recognisable thing about how a bear walks and it is why a bear at forty
   * metres never reads as a large wolf. If this collapses into a diagonal the
   * silhouette work in BeastBody is doing the job on its own. */
  const amble = GAITS.bear.find((g) => g.name === 'amble');
  const fall = footfallPhases(amble);      // [FL, FR, HL, HR]
  const gap = (a, b) => Math.min(Math.abs(a - b), 1 - Math.abs(a - b));
  const sameSide = gap(fall[0], fall[2]);  // FL with HL
  const diagonal = gap(fall[0], fall[3]);  // FL with HR
  assert.ok(sameSide < diagonal,
    `the bear's FL lands ${sameSide.toFixed(2)} of a cycle from its HL and `
    + `${diagonal.toFixed(2)} from its HR - that is a trot, not an amble`);
  assert.equal(beats(amble), 4, 'the amble is meant to be a four-beat gait');
});

test('the running gaits are four distinct beats', () => {
  for (const { species, gait } of MOVING) {
    if (!RUNNING.has(gait.name)) continue;
    assert.equal(beats(gait), 4,
      `${species} "${gait.name}" has ${beats(gait)} beats - the footfalls have collapsed`);
  }
});

test('the lope sits between the trot and the sprint: four beats, no flight phase', () => {
  /* The middle gear, and it has to be genuinely in the middle or the wolf has
   * two speeds rather than three: more beats than the trot (which is two) and
   * still no suspension, which is what the sprint above it adds. */
  const lope = GAITS.wolf.find((g) => g.name === 'lope');
  const trot = GAITS.wolf.find((g) => g.name === 'trot');
  assert.ok(beats(lope) > beats(trot), 'the lope has collapsed onto the trot');
  assert.equal(suspensionFraction(lope, SAMPLES), 0, 'the lope has grown a flight phase');
});

/* ---------------------------------------------------------------- */
/* The pose, and the footfall event                                  */
/* ---------------------------------------------------------------- */

test('a leg lifts only while it is in swing and pushes back while it is not', () => {
  for (const { species, gait } of MOVING) {
    for (const front of [true, false]) {
      let sawLift = false;
      let sawPush = false;
      for (let i = 0; i < 200; i++) {
        const t = i / 200;
        const pose = legPose(t, gait, front);
        if (t < gait.swing) {
          assert.ok(pose.lift >= 0, `${species} ${gait.name}: negative lift`);
          if (pose.lift > 0) sawLift = true;
        } else {
          assert.equal(pose.lift, 0,
            `${species} ${gait.name}: a planted foot is ${pose.lift} m off the ground`);
          if (pose.swing < 0) sawPush = true;
        }
        assert.ok(pose.fold >= 0, 'a knee folded backwards');
      }
      assert.ok(sawLift, `${species} ${gait.name}: the foot never leaves the ground`);
      assert.ok(sawPush, `${species} ${gait.name}: the leg never pushes back under the body`);
    }
  }
});

test('each foot plants exactly once per cycle, wrap included', () => {
  /* The footfall event drives the sound and the ground puff. Firing twice is a
   * double-tap on every stride; firing zero times is a silent animal. The wrap
   * is the interesting case - the plant sits at `swing`, which for most of
   * these tables is nowhere near the phase-0 seam, but for a leg with a big
   * offset it is. */
  for (const { species, gait } of MOVING) {
    const offsets = GAIT_PHASE[gait.name];
    for (let leg = 0; leg < 4; leg++) {
      let fired = 0;
      let prev = legPhase(0, offsets[leg]);
      const STEPS = 512;
      for (let i = 1; i <= STEPS; i++) {
        const t = legPhase(i / STEPS, offsets[leg]);
        if (planted(prev, t, gait)) fired++;
        prev = t;
      }
      assert.equal(fired, 1,
        `${species} ${gait.name} ${LEG_ORDER[leg]} planted ${fired} times in one cycle`);
    }
  }
});

test('a standing animal never raises a footfall', () => {
  for (const [species, list] of Object.entries(GAITS)) {
    const stand = list[0];
    assert.equal(planted(0.1, 0.9, stand), false, `${species} took a step standing still`);
  }
});
