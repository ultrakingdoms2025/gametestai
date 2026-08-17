/**
 * The Lido swim challenge.
 *
 * ── Abstracted, but not faked ────────────────────────────────────────────────
 *
 * The contest is abstracted in the sense the user asked for: there is no stroke
 * simulation, no drag model and no rival body in the water. But the *player's*
 * half of it is entirely real. `player/Swim.js` already gives the pool
 * buoyancy, a 2.2 m/s cruise, a 3.15 m/s sprint that costs stamina, oxygen, and
 * a front-crawl pose. This module adds nothing to that and changes none of it.
 * It watches where the swimmer is and decides when a length is done.
 *
 * ── The rival is a ghost, and that is a decision, not a shortcut ─────────────
 *
 * There is no NPC in the water. `NPC.js` follows the ground every step, and the
 * pool floor is 1.2 m to 3.0 m *below* a water plane the NPC knows nothing
 * about; driving one into the basin would either have it walk along the tiled
 * bottom or need its ground-following disabled, and the only NPC in range is
 * Tavius Okonkwo, whose deck patrol is authored content that must not break.
 *
 * So the rival is a paced split time - a position on the course advancing on a
 * tuned speed curve. Everything the player can see of a rival in a real lane
 * race is the gap, and the gap is exactly what this produces. When a swimming
 * NPC exists, this module's `_rivalDist` becomes the thing that drives it and
 * nothing else here changes.
 *
 * ── Where the course is ──────────────────────────────────────────────────────
 *
 * The basin runs x 32..60, z 103..119, water at y = -0.22, floor sloping from
 * about 1.1 m deep at the blocks to about 2.8 m under the boards. The measured
 * course sits inside that: a touch plane at each end, `LENGTHS` legs, direction
 * alternating. A length is not a line crossing but a *monotonic* run to the far
 * plane, so drifting back does not un-swim it and treading water at the wall
 * does not swim it twice - the same reason `RaceManager` counts laps as an
 * ordered checkpoint sequence rather than a line test.
 *
 * ── The approach ────────────────────────────────────────────────────────────
 *
 * The player is standing on the deck when they accept, so the first thing they
 * do is get in - anywhere. Measuring from wherever they happened to enter would
 * make the course 48 m or 20 m depending on which end they jumped off, so leg 0
 * does not arm until they have actually reached the start wall. Until then the
 * race clock does not run and the rival does not move, which is why dawdling on
 * the approach costs nothing and rushing it gains nothing.
 */

/** Course id. This is the handle a quest step names - see MinigameManager._finish. */
export const SWIM_GAME_ID = 'swim_challenge';

/** Touch planes, in world X. Both sit inside the basin walls at 32 / 60. */
const START_X = 34;
const FAR_X = 58;
/** Lengths swum. Two: down and back, which is a contest rather than a commute. */
const LENGTHS = 2;

/** Basin footprint. Progress only counts inside it. */
const BASIN = { x0: 32, x1: 60, z0: 103, z1: 119 };
/**
 * Feet must be below this to count as "in the pool".
 *
 * The coping is at y = 0.13 and the water plane at y = -0.22, so anything under
 * -0.35 is in the basin rather than on the deck. Deliberately NOT `swim.active`:
 * the shallow end is 1.1 m deep and a swimmer touching that wall is standing up,
 * which is what happens at a real shallow end and would otherwise read as
 * leaving the water two metres from the finish.
 */
const IN_WATER_Y = -0.35;

/** Metres of slack on the start plane, so the touch does not require precision. */
const TOUCH_SLACK = 1.0;

/**
 * Rival pace, metres per second, over the course.
 *
 * A negative split - slower off the wall, faster home - because a flat number
 * makes the gap readout a straight line and there is nothing to respond to.
 * The mean is a little under the player's 2.2 m/s cruise, so a clean swim wins
 * and a sloppy one does not; sprinting is how you win comfortably, and it costs
 * stamina, so it is a decision rather than a button.
 */
const RIVAL_PACE_START = 1.72;
const RIVAL_PACE_END = 1.98;
/** Seconds the rival loses at each turn. Players lose about the same. */
const RIVAL_TURN_COST = 1.0;

/** Seconds before the contest is called off as a loss. Generous on purpose. */
const TIME_LIMIT_S = 180;

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);

/** `m:ss.mm`, matching the race clock so two timed events read alike. */
function clockText(seconds) {
  if (!(seconds > 0)) return '—';
  const m = Math.floor(seconds / 60);
  const s = seconds - m * 60;
  return `${m}:${s < 10 ? '0' : ''}${s.toFixed(2)}`;
}

export class SwimChallenge {
  /**
   * @param {object} venue validated descriptor from MinigameManager
   * @param {{player:any, bus:any}} ctx
   */
  constructor(venue, { player, bus }) {
    this.id = SWIM_GAME_ID;
    this.venue = venue;
    this.player = player;
    this.bus = bus ?? null;

    const c = venue?.config ?? {};
    this.startX = Number.isFinite(Number(c.startX)) ? Number(c.startX) : START_X;
    this.farX = Number.isFinite(Number(c.farX)) ? Number(c.farX) : FAR_X;
    this.lengths = Number.isFinite(Number(c.lengths)) && Number(c.lengths) > 0
      ? Math.floor(Number(c.lengths))
      : LENGTHS;
    this.basin = c.basin ?? BASIN;
    this.legLength = Math.abs(this.farX - this.startX);
    this.distance = this.legLength * this.lengths;
    this.rivalName = venue?.rival?.name ?? 'the pace swimmer';

    /** 'approach' until the start wall is touched, then 'racing'. */
    this.phase = 'approach';
    /** 0-based leg. Even legs run toward `farX`, odd legs back toward `startX`. */
    this.leg = 0;
    /** Furthest fraction of the current leg reached. Monotonic; see the header. */
    this._legMax = 0;
    /** Race clock. Runs only while `phase === 'racing'`. */
    this.clock = 0;
    /** @type {number[]} seconds at the end of each completed length */
    this.splits = [];

    this._rivalDist = 0;
    this._rivalHold = 0;
    this._rivalLeg = 0;
    this._rivalDone = false;
    /** Seconds the player has spent out of the basin while racing. */
    this._dryFor = 0;
    this._finished = false;
  }

  /** Seconds of "on your marks". Read by the manager. */
  get countdown() {
    return 5.0;
  }

  /** Called the instant the countdown expires. */
  begin() {
    this.phase = 'approach';
    this.clock = 0;
    this._legMax = 0;
    this.leg = 0;
    this._rivalDist = 0;
  }

  /** Metres of the course the player has completed. */
  get playerDist() {
    return (this.leg + this._legMax) * this.legLength;
  }

  /** Metres of the course the rival has completed. */
  get rivalDist() {
    return Math.min(this._rivalDist, this.distance);
  }

  /** True while the player's feet are inside the basin and under the coping. */
  get inWater() {
    const p = this.player?.position;
    if (!p) return false;
    const b = this.basin;
    return p.y < IN_WATER_Y && p.x > b.x0 && p.x < b.x1 && p.z > b.z0 && p.z < b.z1;
  }

  /**
   * One fixed step.
   *
   * @param {number} dt fixed timestep
   * @param {number} elapsed seconds since the contest began playing
   * @returns {object|null} an outcome once the contest is over, else null
   */
  fixedUpdate(dt, elapsed) {
    if (this._finished) return null;
    const p = this.player?.position;
    if (!p) return null;

    const wet = this.inWater;
    if (this.phase === 'approach') {
      /* Leg 0 arms on the first touch of the start wall. Nothing else is
       * running yet, so a long swim up from the deep end costs the player
       * nothing but their own patience. */
      if (wet && p.x <= this.startX + TOUCH_SLACK) {
        this.phase = 'racing';
        this.clock = 0;
        this._legMax = 0;
        this.bus?.emit('minigame:event', {
          gameId: this.id,
          kind: 'off',
          text: 'GO',
        });
      }
      // The time limit covers the approach too, or a player who never gets in
      // leaves a contest running until they walk out of the venue.
      if (elapsed >= TIME_LIMIT_S) return this._lose('time');
      return null;
    }

    this.clock += dt;
    this._advanceRival(dt);

    /* Getting out mid-race is not a foul, it is just slow: progress freezes
     * rather than resetting, exactly as it does when a swimmer stops. Tracked
     * so the HUD can say why the number stopped moving. */
    if (!wet) {
      this._dryFor += dt;
    } else {
      this._dryFor = 0;
      const from = this.leg % 2 === 0 ? this.startX : this.farX;
      const to = this.leg % 2 === 0 ? this.farX : this.startX;
      const t = clamp01((p.x - from) / (to - from));
      // Monotonic within the leg: drifting back does not un-swim it, and the
      // turn cannot be taken twice from one approach to the wall.
      if (t > this._legMax) this._legMax = t;

      if (this._legMax >= 1) {
        this.splits.push(this.clock);
        this.leg += 1;
        this._legMax = 0;
        if (this.leg >= this.lengths) return this._win();
        this.bus?.emit('minigame:event', {
          gameId: this.id,
          kind: 'split',
          text: `LENGTH ${this.leg} — ${clockText(this.splits[this.splits.length - 1])}`,
        });
      }
    }

    if (this._rivalDone) return this._lose('rival');
    if (elapsed >= TIME_LIMIT_S) return this._lose('time');
    return null;
  }

  /**
   * Move the pace swimmer.
   *
   * Distance-driven rather than time-driven, so the curve is a property of the
   * course rather than of how long the player has taken to get anywhere.
   */
  _advanceRival(dt) {
    if (this._rivalDone) return;
    if (this._rivalHold > 0) {
      this._rivalHold -= dt;
      return;
    }
    const u = clamp01(this._rivalDist / this.distance);
    this._rivalDist += (RIVAL_PACE_START + (RIVAL_PACE_END - RIVAL_PACE_START) * u) * dt;

    const leg = Math.floor(this._rivalDist / this.legLength);
    if (leg > this._rivalLeg) {
      this._rivalLeg = leg;
      // A turn costs the rival what it costs a swimmer: a beat at the wall.
      if (leg < this.lengths) this._rivalHold = RIVAL_TURN_COST;
    }
    if (this._rivalDist >= this.distance) {
      this._rivalDist = this.distance;
      this._rivalDone = true;
    }
  }

  _win() {
    this._finished = true;
    return {
      won: true,
      place: 1,
      total: 2,
      score: this.clock,
      scoreLabel: clockText(this.clock),
      rivalName: this.rivalName,
      detail: {
        lengths: this.lengths,
        distance: this.distance,
        splits: [...this.splits],
        rivalDistance: this.rivalDist,
        margin: this.distance - this.rivalDist,
      },
    };
  }

  /** @param {'rival'|'time'} why */
  _lose(why) {
    this._finished = true;
    return {
      won: false,
      place: 2,
      total: 2,
      score: this.clock,
      scoreLabel: why === 'time' ? 'Timed out' : clockText(this.clock),
      rivalName: why === 'time' ? null : this.rivalName,
      detail: {
        reason: why,
        lengths: this.lengths,
        distance: this.distance,
        splits: [...this.splits],
        swum: this.playerDist,
      },
    };
  }

  /**
   * The live readout, as generic rows the minigame HUD renders without knowing
   * what a length is.
   */
  snapshot() {
    const gap = this.playerDist - this.rivalDist;
    const racing = this.phase === 'racing';
    const rows = [
      { k: 'LENGTH', v: `${Math.min(this.leg + (racing ? 1 : 0), this.lengths)}/${this.lengths}` },
      { k: 'TIME', v: racing ? (clockText(this.clock) === '—' ? '0:00.00' : clockText(this.clock)) : '0:00.00' },
      {
        k: 'LAST',
        v: this.splits.length ? clockText(this.splits[this.splits.length - 1]) : '—',
        dim: true,
      },
      {
        k: 'RIVAL',
        v: racing ? `${gap >= 0 ? '+' : ''}${gap.toFixed(1)} m` : '—',
        tone: !racing ? null : gap >= 0 ? 'good' : 'warn',
      },
    ];
    return {
      rows,
      progress: clamp01(this.playerDist / this.distance),
      rivalProgress: clamp01(this.rivalDist / this.distance),
      banner: racing
        ? (this._dryFor > 1.2 ? 'GET BACK IN THE POOL' : null)
        : 'SWIM TO THE SHALLOW END WALL',
      subtitle: `${this.lengths} lengths · ${this.distance} m · racing ${this.rivalName}`,
    };
  }
}

/**
 * Factory registered against the `swim` venue kind.
 * @param {object} venue
 * @param {{player:any, bus:any}} ctx
 */
export function createSwimChallenge(venue, ctx) {
  return new SwimChallenge(venue, ctx);
}

export default SwimChallenge;
