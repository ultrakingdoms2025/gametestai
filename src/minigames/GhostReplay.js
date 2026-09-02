/**
 * THE PERSONAL-BEST GHOST: a recorded pace, in twenty floats.
 *
 * ── Why this exists ───────────────────────────────────────────────────────
 *
 * Every progression axis in this game has a finite denominator BY DESIGN.
 * `Charters` says so in its own header - "no column for anything counted
 * rather than collected" - and eight columns, eighteen worlds, one hundred and
 * ten relics and thirty-six medals all bottom out. Self-competition is the one
 * axis that does not, and until this file the game had no way to express it:
 * the rooftop rival was ANALYTIC (`RooftopTrial._paceRival` ran
 * `par.chain / par.silver` metres a second, so the rival literally WAS the
 * silver par), the swim and ski rivals ran tuned pace curves, and nothing
 * anywhere in the tree recorded a replay of anything.
 *
 * ── What a replay is, and what it deliberately is not ─────────────────────
 *
 * It is a POLYLINE OF PROGRESS AGAINST TIME, and nothing else. Not a position
 * track, not an input tape, not a pose stream. `(t, u)` where `u` is the
 * fraction of the course completed - so a replay is measured in the same units
 * the HUD's own progress bar is, and the ghost's body is placed by the OWNING
 * game module through the same `_chainPoint`-style mapping the analytic pace
 * already used. That is the whole safety argument for driving a body with it:
 *
 *   the replay decides HOW FAR ALONG, the live world decides WHERE THAT IS.
 *
 * A position track recorded on Tuesday's citadel would drive a body through
 * Wednesday's wall. A progress fraction cannot: the only thing it can be wrong
 * about is the pace, and a wrong pace is a rival who is slow, not a rival
 * inside a building. The version and course keys below are belt and braces on
 * top of that, not the load-bearing part.
 *
 * ── Why the samples are the checkpoint emits and not a fixed cadence ──────
 *
 * Five contests already emit a per-leg event with a time on it -
 * `trial:checkpoint`, `delivery:leg`, `hack:node`, `testfire:plate`,
 * `race:lap` - and every one of them fires at a place the player had to REACH.
 * Sampling those costs nothing, produces a polyline whose knots are exactly
 * the moments that discriminate one run from another, and bounds the storage
 * at the number of checkpoints a route has (seven rings on the longest citadel
 * route, so seven pairs). Sampling at 10 Hz instead would be nine hundred
 * floats for a ninety-second run, would need a decimator, and would say
 * nothing the knots do not.
 *
 * The price is honest: between two knots the ghost moves at a CONSTANT pace,
 * so it does not reproduce the player's acceleration inside a leg. That is
 * visible only to somebody watching the ghost rather than racing it, and the
 * alternative costs forty times the bytes for it.
 *
 * ── Storage shape and size ────────────────────────────────────────────────
 *
 *   { v: 1, k: '<course key>', d: <seconds>, s: [t, u, t, u, ...] }
 *
 * `s` is FLAT and interleaved rather than an array of objects: `[12.4,0.13]`
 * is nine bytes of JSON and `[{"t":12.4,"u":0.13}]` is twenty-four, and this
 * rides in `localStorage` beside every other ledger the game keeps. Times are
 * rounded to milliseconds and progress to 1e-4 (a tenth of a millimetre on a
 * 500 m route), because the digits past those are float noise that would
 * otherwise cost four bytes each, every save, for ever.
 *
 * A seven-ring route is 7 pairs = 14 numbers ~= 190 bytes of JSON including
 * the key. Sixteen venues is under 4 kB, against a `SAVE_KEY` payload already
 * measured in tens of kilobytes.
 *
 * ── Refusing, rather than driving through a wall ──────────────────────────
 *
 * {@link GhostReplay.from} answers null - never a partially-trusted replay -
 * for a version it does not know, a course key that does not match the route
 * being run now, a sample list that is not strictly ascending in time, or any
 * shape it did not write itself. Null is already a supported state everywhere
 * this is used: `GhostCompetitor.create` returns null when there is no factory
 * and the contests race the readout alone, and the analytic pace this replaces
 * is still there as the fallback. So a refusal costs a player their ghost for
 * one run and costs the game nothing.
 *
 * @see ./RooftopTrial.js the first consumer - records at `trial:checkpoint`
 * @see ../../scripts/tests/ghost-replay.test.mjs
 */

/** Schema version. Bump when the SHAPE of `s` changes, never for new keys. */
export const REPLAY_VERSION = 1;

/**
 * Hard ceiling on stored samples.
 *
 * A route publishes its own checkpoint count, so this is not the normal bound -
 * it is the guard against a venue that publishes four hundred rings, or a
 * hand-edited save that does. `_read` truncates rather than refusing, because a
 * replay whose first sixty-four knots are good is still a usable pace and
 * refusing it would be a worse answer than shortening it.
 */
export const REPLAY_MAX_SAMPLES = 64;

/** Decimal places kept for time (ms) and progress (1e-4 of a course). */
const T_DP = 3;
const U_DP = 4;

const round = (v, dp) => {
  const k = 10 ** dp;
  return Math.round(v * k) / k;
};
const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);

/**
 * A stable name for the COURSE a replay was set on.
 *
 * ── Why a fingerprint and not a version number ────────────────────────────
 *
 * Nothing in this repository versions a world's authored content, and the one
 * thing that has repeatedly gone wrong with derived placement is that it moves
 * silently: `Caches.cacheSiteId`'s own header records a site that was index 4
 * becoming index 3 because somebody built a terrace beside a ledge. A route is
 * exactly that kind of thing. So the key is measured off the route itself and
 * changes the moment the route does.
 *
 * Rounded to whole metres for the same reason `cacheSiteId` is: a chain whose
 * length came out 0.004 m different because a float landed differently is the
 * same chain, and invalidating every player's ghost over that would be a
 * self-inflicted wipe.
 *
 * @param {Array<{x:number,y:number,z:number}>} cps the checkpoint chain
 * @param {number} [length] the chain length, when the caller already has it
 * @returns {string} '' when there is no usable chain, which never matches
 */
export function courseKey(cps, length) {
  if (!Array.isArray(cps) || cps.length < 2) return '';
  let chain = Number(length);
  if (!Number.isFinite(chain) || chain <= 0) {
    chain = 0;
    for (let i = 1; i < cps.length; i++) {
      chain += Math.hypot(
        cps[i].x - cps[i - 1].x,
        cps[i].y - cps[i - 1].y,
        cps[i].z - cps[i - 1].z,
      );
    }
  }
  const a = cps[0];
  const b = cps[cps.length - 1];
  /* Count, length, and both ends. The count alone would not notice a ring
   * moved fifty metres; the length alone would not notice two rings swapped;
   * the ends catch a route re-anchored at the same length, which is what a
   * district rebuild does. */
  return `${cps.length}:${Math.round(chain)}`
    + `:${Math.round(a.x)}_${Math.round(a.z)}`
    + `:${Math.round(b.x)}_${Math.round(b.z)}`;
}

/**
 * Collects `(t, u)` knots during a run and hands back the stored shape.
 *
 * Deliberately forgiving on the way IN and strict on the way OUT: a game
 * module calling `mark` from a bus handler must never be able to throw into
 * the frame loop, so a bad sample is dropped silently, and `serialize()` then
 * answers null for a run that did not produce a usable polyline. Recording is
 * therefore always safe to switch on, and the decision about whether there is
 * a ghost worth keeping is made once, at the end, in one place.
 */
export class ReplayRecorder {
  /**
   * @param {string} key the course key this run is being set on
   * @param {{max?:number}} [opts]
   */
  constructor(key, { max = REPLAY_MAX_SAMPLES } = {}) {
    this.key = typeof key === 'string' ? key : '';
    this.max = Number.isFinite(max) && max > 1 ? Math.floor(max) : REPLAY_MAX_SAMPLES;
    /** @type {number[]} flat, interleaved `t, u` */
    this._s = [];
    /** Last accepted time, so the polyline is strictly ascending by construction. */
    this._lastT = -Infinity;
    /** Last accepted progress: monotonic, because a course is not run backwards. */
    this._lastU = -Infinity;
  }

  /** How many knots are on the polyline so far. */
  get length() {
    return this._s.length / 2;
  }

  /**
   * Record one knot.
   *
   * Refuses anything that would make the polyline unreadable rather than
   * storing it and hoping: a non-finite number, a time that did not advance
   * (two checkpoints swept in one fixed step is a real case - see
   * `RooftopTrial._advance`), or progress that went backwards.
   *
   * @param {number} t seconds since the lights went out
   * @param {number} u fraction of the course completed, 0..1
   * @returns {boolean} true when the knot was kept
   */
  mark(t, u) {
    const tt = Number(t);
    const uu = Number(u);
    if (!Number.isFinite(tt) || !Number.isFinite(uu)) return false;
    if (tt < 0) return false;
    if (tt <= this._lastT && this._s.length) return false;
    const cu = clamp01(uu);
    if (cu < this._lastU) return false;
    if (this.length >= this.max) return false;
    this._lastT = tt;
    this._lastU = cu;
    this._s.push(round(tt, T_DP), round(cu, U_DP));
    return true;
  }

  /**
   * The stored shape, or null when this run is not a usable ghost.
   *
   * Three refusals, each of which would otherwise put a ghost on a roof that
   * teaches the player nothing:
   *
   *  - fewer than two knots: a polyline needs two points, and a run that
   *    passed one ring is not a pace.
   *  - no course key: the replay could never be validated against a route
   *    later, so storing it would only cost bytes.
   *  - a final progress short of the finish: the run did not complete the
   *    course, and a ghost that stops three quarters of the way down is a
   *    rival the player beats by walking.
   *
   * @param {number} [finishT] the finishing time, recorded as the last knot at
   *   u = 1 when the run ended between checkpoints
   * @returns {{v:number,k:string,d:number,s:number[]}|null}
   */
  serialize(finishT) {
    if (this.key) this.mark(finishT, 1);
    if (!this.key) return null;
    if (this.length < 2) return null;
    const lastU = this._s[this._s.length - 1];
    /* 0.999 and not 1: `u` is rounded to 1e-4 on the way in, and a chain
     * distance divided by its own total can land a hair under one on a float
     * that did not co-operate. A ghost that reached 99.9% of the course ran
     * the course. */
    if (lastU < 0.999) return null;
    return {
      v: REPLAY_VERSION,
      k: this.key,
      d: this._s[this._s.length - 2],
      s: this._s.slice(),
    };
  }
}

/**
 * A stored replay, read back and made askable.
 *
 * Immutable once built. `progressAt` and `paceAt` are pure and allocate
 * nothing, because they run once per fixed step for the length of a contest.
 */
export class GhostReplay {
  /**
   * Validate a stored payload against the course it is about to drive.
   *
   * @param {any} data whatever came out of the save
   * @param {string} key the course key of the route being run NOW
   * @returns {GhostReplay|null} null for anything that does not stand up
   */
  static from(data, key) {
    if (!data || typeof data !== 'object' || Array.isArray(data)) return null;
    if (data.v !== REPLAY_VERSION) return null;
    if (typeof key !== 'string' || !key) return null;
    /* THE REFUSAL THAT MATTERS. A replay from a route that has since been
     * re-authored is not "mostly right" - its knots are progress fractions of
     * a chain that no longer exists, so the pace it describes is a pace at
     * nowhere. The analytic fallback is strictly better than that. */
    if (data.k !== key) return null;
    const raw = data.s;
    if (!Array.isArray(raw) || raw.length < 4 || raw.length % 2 !== 0) return null;

    const s = [];
    let lastT = -Infinity;
    let lastU = -Infinity;
    for (let i = 0; i < raw.length && s.length / 2 < REPLAY_MAX_SAMPLES; i += 2) {
      const t = Number(raw[i]);
      const u = Number(raw[i + 1]);
      if (!Number.isFinite(t) || !Number.isFinite(u)) return null;
      if (t < 0 || u < 0 || u > 1) return null;
      /* Strictly ascending in time and non-decreasing in progress, checked on
       * READ as well as on write. The write side is this file's own recorder;
       * the read side is a JSON string a player can edit, and an unsorted
       * polyline would make `progressAt` return whichever segment it happened
       * to land in. */
      if (t <= lastT && s.length) return null;
      if (u < lastU) return null;
      lastT = t;
      lastU = u;
      s.push(t, u);
    }
    if (s.length < 4) return null;
    return new GhostReplay(s, data.k);
  }

  /** @param {number[]} samples flat, validated `t, u` @param {string} key */
  constructor(samples, key) {
    /** @type {number[]} */
    this._s = samples;
    this.key = key;
    /** Seconds the recorded run took. The number a player is racing. */
    this.duration = samples[samples.length - 2];
  }

  /** How many knots the polyline has. */
  get length() {
    return this._s.length / 2;
  }

  /**
   * Course fraction the recorded run had completed at `t`.
   *
   * Linear between knots. Before the first knot it interpolates from the
   * ORIGIN - `(0, 0)`, the start line at the moment the lights went out -
   * rather than holding the first knot's progress, because a ghost that sits
   * on the line and then teleports to ring one is not a rival, it is a bug
   * report. After the last knot it holds, which is a rival standing at the
   * finish waiting: the honest picture of a run already over.
   *
   * @param {number} t seconds since the lights went out
   * @returns {number} 0..1
   */
  progressAt(t) {
    const s = this._s;
    const tt = Number(t);
    if (!Number.isFinite(tt) || tt <= 0) return 0;
    if (tt >= s[s.length - 2]) return s[s.length - 1];
    let pt = 0;
    let pu = 0;
    for (let i = 0; i < s.length; i += 2) {
      const nt = s[i];
      const nu = s[i + 1];
      if (tt < nt) {
        const span = nt - pt;
        const f = span > 0 ? (tt - pt) / span : 1;
        return pu + (nu - pu) * f;
      }
      pt = nt;
      pu = nu;
    }
    return pu;
  }

  /**
   * Rate of progress at `t`, in course fractions per second.
   *
   * The animation speed the body should WEAR, which the owning module turns
   * into metres a second by multiplying by the course length. Piecewise
   * constant, exactly as `progressAt` is piecewise linear, so the two can
   * never disagree about how fast the ghost is going.
   *
   * @param {number} t
   * @returns {number} >= 0
   */
  paceAt(t) {
    const s = this._s;
    const tt = Number(t);
    if (!Number.isFinite(tt) || tt < 0) return 0;
    // Past the end the run is over and the body is standing still.
    if (tt >= s[s.length - 2]) return 0;
    let pt = 0;
    let pu = 0;
    for (let i = 0; i < s.length; i += 2) {
      const nt = s[i];
      const nu = s[i + 1];
      if (tt < nt) {
        const span = nt - pt;
        return span > 0 ? Math.max(0, (nu - pu) / span) : 0;
      }
      pt = nt;
      pu = nu;
    }
    return 0;
  }
}

export default GhostReplay;
