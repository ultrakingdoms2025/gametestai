import * as THREE from 'three';
import { RaceRings } from '../race/RaceRings.js';
import { sweptPass } from '../race/CheckpointSweep.js';
import { GhostCompetitor } from './GhostCompetitor.js';

/**
 * Rooftop time trials: the citadel's roofs, scored.
 *
 * The brief this exists against was "in citadel it is mainly running on roof
 * tops ... with no purpose". Running on roofs is this world's best verb and it
 * had no consumer at all, so this is the consumer: an authored line of
 * checkpoints across the deck network, a clock, a rival with a body, and three
 * medals whose times were MEASURED rather than picked.
 *
 * -- What is reused, and why ------------------------------------------------
 *
 *  - the swept ordered-checkpoint test, `race/CheckpointSweep.sweptPass`. It
 *    was `RaceManager._advance`'s inner thirty lines and is now a pure function
 *    both callers share. Anti-tunnel matters MORE here than in the car race: a
 *    leap crosses at 11.64 m/s and lands inside one fixed step, so a point test
 *    would drop checkpoints on exactly the manoeuvre the trial is about.
 *  - `race/RaceRings`, the only in-world waypoint marker this project has, now
 *    that its 5.2 m dragon torus is a parameter. A trial ring is 2.6 m, which
 *    is what fits on a souk roof.
 *  - `GhostCompetitor`, so the rival is a real skinned humanoid in the real
 *    `NPCAnimator` run cycle with foot IK rather than an arrow on a bar.
 *  - `MinigameManager`'s whole lifecycle - venue trigger, hysteresis prompt,
 *    the E key shared with five other consumers, countdown, quit-pays-nothing,
 *    leave grace, payout, `quest:activity`, pause block.
 *
 * -- The medal times were driven, not computed -------------------------------
 *
 * Three numbers in this drop's design document were wrong because they were
 * derived, so nothing here is. `parTimes` is a two-term model and every
 * coefficient in it came off a measurement; `scripts/tests/minigame-rooftop
 * .test.mjs` re-derives all of them from the built world on every run, so a
 * change to the souk layout, to `Stamina`, to `sprintSpeed` or to `FreeClimb`
 * moves the reference times and the suite says so.
 *
 * How they were taken, in order:
 *
 *  1. **The pace.** The real `Player`, with the real `Stamina` pool, driven on
 *     a flat rig for 90 s per gait. Holding sprint settles at **6.292 m/s**,
 *     not `sprintSpeed` 8.2 - the pool empties in 6.67 s and latches until 22%,
 *     so what is left is the duty cycle (`TrackRace` derives 6.21 for the same
 *     cycle by hand; this drives it). Jumping every 15 m makes it **6.372**,
 *     leaping every 15 m **6.609**: a jump is ballistic at the speed you left
 *     the roof at, so gaps do not cost time, they cost stamina. A walk is
 *     **4.599 m/s**, which is `walkSpeed` exactly, there being nothing to pay.
 *  2. **The climb.** The same real `Player` at a wall rig: attaching from a run
 *     costs **0.70 s** and the face goes at `FreeClimb`'s `SPEED_UP` 2.05 m/s
 *     exactly - 2.87 s over 6 m, 6.77 s over 14 m. A 12 m souk face is 6.55 s.
 *  3. **The route.** A pad graph over the world's OWN published decks
 *     (`_roofs`, `_towers`, `ropeBridges`), every deck edge found by probing
 *     the real colliders and every crossing validated by flying the real
 *     integrator at the three budgets, shortest path per checkpoint leg.
 *     Measured route lengths 497.7 / 130.5 / 126.9 m against published chain
 *     lengths of 483.2 / 114.2 / 124.5 m.
 *  4. **The time.** That route stepped at `walkSpeed` and the grounded sprint
 *     cap through the real `Stamina` instance - paying 15/s to sprint, 14 a
 *     leap and 7.0/s to climb, re-deciding the gait every step, and WAITING
 *     when the pool cannot afford the next leap:
 *
 *          route          sprint held   managed   jog only   gold par
 *          souk dash          78.1 s     94.2 s     97.9 s     91.8 s
 *          long ascent        40.6 s     38.3 s     40.5 s     39.7 s
 *          skyline            17.7 s     23.2 s     26.2 s     23.7 s
 *
 *     Two findings worth keeping. On the long open dash, holding sprint wins
 *     outright even though it spends 2.3 s standing still waiting for 14 points
 *     of bar to leap with. On the ASCENT it loses: six leaps and two free
 *     climbs out of one pool means the always-sprint runner waits 6.0 s and
 *     comes home 2.3 s behind a runner who manages the bar. Managing beats
 *     mashing where the route is technical, which is the contest worth having.
 *
 *     The ascent is also the route whose medals discriminate least - its best
 *     line and its jog are 5% apart, because a 2.05 m/s free climb takes
 *     everybody the same time. Gold sits in the 2.2 s window between them with
 *     3.5% of headroom; the dash has 14.9% and the skyline 25.4%.
 *
 * -- What a medal is worth ---------------------------------------------------
 *
 * A finish inside bronze is a WIN, which is what makes `SaveGame._recordTrial`
 * keep the time (it records wins only, deliberately) and what pays the venue's
 * credits. The medal itself rides in the result's `score`, so the result card
 * and any future quest step can read it without this file needing an economy
 * handle of its own.
 *
 * @see ../race/CheckpointSweep.js
 * @see ../../scripts/tests/minigame-rooftop.test.mjs
 */

/** Game id. The handle a quest step names - see MinigameManager._finish. */
export const ROOFTOP_GAME_ID = 'rooftop_trial';

/**
 * The reference pace, in metres of published checkpoint CHAIN per second.
 *
 * Not the flat-rig 6.292: this is chain metres and a real route weaves - the
 * three measured routes walk 497.7, 130.5 and 126.9 m of deck for published
 * chains of 483.2, 114.2 and 124.5. Their fastest gaits worked out at 6.19
 * (dash) and 7.03 (skyline) chain-metres a second, and the climb-heavy ascent
 * at 5.9 once its two free climbs are taken out into the climb term below.
 * 6.0 sits under the slowest of the three, so the running term is never tighter
 * than a route has actually been run.
 */
export const REF_PACE = 6.0;

/**
 * Seconds a leg that must be climbed costs, over and above running it.
 *
 * The souk's inner rings stand 12-13 m over the street, and a 12 m face costs a
 * measured 6.55 s - 5.85 s at `FreeClimb`'s 2.05 m/s plus 0.70 s to attach from
 * a run. 9.0 covers that plus the drop into the street and the seconds spent
 * standing at the bottom waiting for enough bar to hold on with, which the
 * ascent's two climbs measured at 6.0 s between them for an always-sprinting
 * runner.
 */
export const CLIMB_LEG_S = 9.0;

/**
 * A leg rising more than this cannot be jumped, so it has to be climbed.
 *
 * The leap apex, measured in a browser: 1.109 m. `Player.fixedUpdate` applies
 * gravity BEFORE `_move` integrates, so the closed form `v^2/2g` (1.17 m) is
 * 6 cm too generous - and 6 cm is the difference between a ledge band a leap
 * clears and one it does not. Do not recompute this; drive it.
 */
export const LEAP_APEX = 1.109;

/**
 * The medal spread, applied to the RUNNING term only.
 *
 * Climbing is not a skill expression - `FreeClimb` ascends at a fixed 2.05 m/s
 * whoever is holding the wall - so scaling the climb term by the medal would
 * hand a slower player extra seconds for a manoeuvre that takes everybody the
 * same time. Split like this the measured jog lands on SILVER on all three
 * routes and the measured best line lands inside gold with 3.5-25% to spare;
 * scaled whole, the jog took GOLD on the climb-heavy ascent. The ascent is what
 * pins the low end: 3.5% is the whole window between its best line and its jog,
 * because two 2.05 m/s free climbs dominate it.
 */
export const MEDAL_FACTOR = Object.freeze({ gold: 1.14, silver: 1.32, bronze: 1.60 });

/**
 * Multiple of the bronze par at which a run is called off.
 *
 * Not "over the moment bronze passes": a player two seconds outside bronze
 * still wants to see their time, and being cut off mid-roof reads as a bug.
 * Not unbounded either - a state machine running over a rooftop nobody is
 * racing on any more is what `LEAVE_GRACE_S` exists for, and this is the same
 * idea for a player who is still on the route but no longer contesting it.
 */
export const TIMEOUT_FACTOR = 1.6;

/** Metres from checkpoint 0 the player must be standing to start. */
export const START_RADIUS = 12;

/**
 * Vertical acceptance at a checkpoint.
 *
 * `player.position` is the capsule CENTRE and a checkpoint's `y` is the deck,
 * so a player standing in the ring is already +0.875 and one at the top of a
 * leap is +1.98. 3.0 takes both and still refuses the street, which on the souk
 * is 6.6 m below the outer ring's deck: a runner passing underneath a
 * checkpoint must never be credited with it.
 */
export const CP_Y_GATE = 3.0;

/** Ring radius used when a venue names none. */
const DEFAULT_RING_R = 2.6;

/** `SkiRun.js:159`, same one-liner. */
const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);

/* Scratch. Module level, never inside a step - the house rule. */
const _ghostPos = new THREE.Vector3();

/** `m:ss.mm`, copied from SwimChallenge so every timed contest reads alike. */
export function clockText(seconds) {
  if (!(seconds > 0)) return '-';
  const m = Math.floor(seconds / 60);
  const s = seconds - m * 60;
  return `${m}:${s < 10 ? '0' : ''}${s.toFixed(2)}`;
}

/** Summed 3D length of a checkpoint chain. */
export function chainLength(cps) {
  let sum = 0;
  for (let i = 1; i < cps.length; i++) {
    sum += Math.hypot(cps[i].x - cps[i - 1].x, cps[i].y - cps[i - 1].y, cps[i].z - cps[i - 1].z);
  }
  return sum;
}

/**
 * Legs the body cannot jump up and must therefore climb.
 *
 * Counted off the chain rather than taken from the world, because the world
 * publishes decks and not routes: a leg that gains more than the leap apex has
 * no ballistic answer at any budget, so whatever the geometry in between, the
 * player is going down into the street and up a wall.
 */
export function climbLegs(cps) {
  let n = 0;
  for (let i = 1; i < cps.length; i++) if (cps[i].y - cps[i - 1].y > LEAP_APEX) n++;
  return n;
}

/**
 * Gold, silver and bronze for one route.
 *
 * @param {Array<{x:number,y:number,z:number}>} cps the checkpoint chain
 * @param {number} [routeLength] the world's own measured chain length when it
 *   published one; recomputed from `cps` when it did not.
 * @returns {{gold:number, silver:number, bronze:number, timeout:number,
 *            run:number, climb:number, chain:number, climbLegs:number}}
 */
export function parTimes(cps, routeLength) {
  const chain = Number.isFinite(routeLength) && routeLength > 0 ? routeLength : chainLength(cps);
  const legs = climbLegs(cps);
  const run = chain / REF_PACE;
  const climb = legs * CLIMB_LEG_S;
  const par = (k) => run * k + climb;
  const bronze = par(MEDAL_FACTOR.bronze);
  return {
    gold: par(MEDAL_FACTOR.gold),
    silver: par(MEDAL_FACTOR.silver),
    bronze,
    timeout: bronze * TIMEOUT_FACTOR,
    run,
    climb,
    chain,
    climbLegs: legs,
  };
}

/** Which medal a finishing time earns, or null for none. */
export function medalFor(time, par) {
  if (!(time > 0)) return null;
  if (time <= par.gold) return 'gold';
  if (time <= par.silver) return 'silver';
  if (time <= par.bronze) return 'bronze';
  return null;
}

/**
 * The venue disc a route needs, for the world that publishes it.
 *
 * `MinigameManager.fixedUpdate` abandons a contest `LEAVE_GRACE_S` = 9 s after
 * the player leaves the venue, measured against the venue's own centre, radius
 * and `yTolerance`. A start-line-sized disc therefore self-aborts every trial
 * that lasts longer than nine seconds, which is all of them. `SportsWorld`
 * records the same requirement twice in comments, once over the ski slope's
 * 60 m radius and once over the track's; this returns the numbers so the next
 * world does not have to rediscover them.
 *
 * The START is not this disc's job: {@link createRooftopTrial} refuses to build
 * unless the player is within {@link START_RADIUS} of checkpoint 0 - the same
 * split the ski run uses, a wide venue with a module-enforced summit gate.
 *
 * @param {Array<{x:number,y:number,z:number}>} cps
 * @param {number} [margin] metres of slack around the route
 * @returns {{centre:{x:number,y:number,z:number}, radius:number, yTolerance:number}}
 */
export function venueBounds(cps, margin = 10) {
  let x0 = Infinity;
  let x1 = -Infinity;
  let y0 = Infinity;
  let y1 = -Infinity;
  let z0 = Infinity;
  let z1 = -Infinity;
  for (const c of cps) {
    if (c.x < x0) x0 = c.x;
    if (c.x > x1) x1 = c.x;
    if (c.y < y0) y0 = c.y;
    if (c.y > y1) y1 = c.y;
    if (c.z < z0) z0 = c.z;
    if (c.z > z1) z1 = c.z;
  }
  const cx = (x0 + x1) / 2;
  const cy = (y0 + y1) / 2;
  const cz = (z0 + z1) / 2;
  let r = 0;
  for (const c of cps) r = Math.max(r, Math.hypot(c.x - cx, c.z - cz));
  return {
    centre: { x: cx, y: cy, z: cz },
    radius: r + margin,
    yTolerance: (y1 - y0) / 2 + margin,
  };
}

/**
 * True when `MinigameManager._inVenue` would hold the player over the WHOLE
 * route, which is what stops `LEAVE_GRACE_S` abandoning a run in progress.
 */
export function venueCoversRoute(venue, cps) {
  if (!venue?.centre || !Array.isArray(cps) || !cps.length) return false;
  for (const c of cps) {
    if (Math.abs(c.y - venue.centre.y) > venue.yTolerance) return false;
    if (Math.hypot(c.x - venue.centre.x, c.z - venue.centre.z) >= venue.radius) return false;
  }
  return true;
}

/**
 * Read and validate a venue's route.
 * @returns {Array<object>|null} null for anything unusable
 */
function readRoute(venue) {
  const raw = venue?.config?.checkpoints;
  if (!Array.isArray(raw) || raw.length < 3) return null;
  const r = Number(venue.config.ringRadius);
  const radius = Number.isFinite(r) && r > 0 ? r : DEFAULT_RING_R;
  const out = [];
  for (let i = 0; i < raw.length; i++) {
    const c = raw[i];
    const x = Number(c?.x);
    const y = Number(c?.y);
    const z = Number(c?.z);
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) return null;
    out.push({ x, y, z, radius, number: i + 1, index: i, tx: 0, tz: -1 });
  }
  /* Rings face ALONG the route, so a player running it passes through each one
   * rather than beside it; the last faces the way the one before it did. The
   * facing is cosmetic - `sweptPass` is a cylinder test and does not read it -
   * but a ring turned side-on to the runner reads as a ring they missed. */
  for (let i = 0; i < out.length; i++) {
    const a = out[i];
    const fwd = out[i + 1];
    const b = fwd ?? out[i - 1];
    const dx = fwd ? b.x - a.x : a.x - b.x;
    const dz = fwd ? b.z - a.z : a.z - b.z;
    const d = Math.hypot(dx, dz) || 1;
    a.tx = dx / d;
    a.tz = dz / d;
  }
  return out;
}

export class RooftopTrial {
  /**
   * @param {object} venue the manager's validated venue record
   * @param {{player?:any, bus?:any, input?:any, worldManager?:any, engine?:any,
   *          npcs?:any, factory?:any, save?:any, scene?:any}} ctx
   */
  constructor(venue, ctx = {}) {
    this.id = ROOFTOP_GAME_ID;
    this.venue = venue;
    this.player = ctx.player ?? null;
    this.bus = ctx.bus ?? null;
    this.save = ctx.save ?? null;
    /* The key `SaveGame` files a best time under is `${worldId}/${venueId}`,
     * and the worldId it uses is the one `MinigameManager` caught off
     * `world:changed` - `World.id`, i.e. the static 'citadel'. Read the same
     * string here or the personal best on the HUD is looked up under a key
     * nothing was ever written to. `WorldManager` publishes no `activeId`;
     * the active world's own `id` getter is the accessor. */
    this.worldId = ctx.worldManager?.active?.id ?? ctx.worldId ?? null;

    this.route = readRoute(venue);
    if (!this.route) throw new Error('rooftop trial: the venue publishes no usable checkpoint chain');

    this.par = parTimes(this.route, venue?.config?.routeLength);
    this.best = Number(this.save?.bestTrialTime?.(venue.id, this.worldId)) || null;

    /** The checkpoint the cursor is on. The player STARTS on 0, so 1 is next. */
    this.nextCp = 1;
    this.done = 0;
    this.clock = 0;
    this.finished = false;
    /** Previous step's XZ for the swept test. Advanced on EVERY step. */
    this._px = 0;
    this._pz = 0;

    this.rivalName = venue?.rival?.name ?? 'the pacesetter';
    this.rivalDist = 0;
    /* The rival runs the SILVER par, so "beat the body on the roof" and "beat
     * the silver time" are the same statement rather than two. */
    this.rivalPace = this.par.chain / this.par.silver;

    this._host = ctx.worldManager?.active?.group ?? ctx.scene ?? this.player?.scene ?? null;
    this.rings = new RaceRings({
      scene: this._host,
      radius: this.route[0].radius,
      tube: 0.11,
      labelGap: 1.0,
      labelScale: 1.9,
      name: `rooftop-trial-rings-${venue.id}`,
      groupPrefix: `rooftop-cp-${venue.id}`,
    });
    this.rings.setCheckpoints(this.route);
    // Checkpoint 0 is the line the player is standing on; 1 is what to run at.
    this.rings.pass(0, 1);

    this.ghost = null;
    this._offFrame = null;
    this._buildGhost(ctx);
  }

  /** Seconds of "on your marks". Short: the player is already on the line. */
  get countdown() {
    return 3.0;
  }

  /**
   * A rival with a body, or none at all.
   *
   * No factory or no group means no ghost and an unchanged contest - the
   * `GhostCompetitor` contract, and the reason the swim and the ski run still
   * work headless.
   */
  _buildGhost(ctx) {
    if (!this._host || typeof this._host.add !== 'function') return;
    const factory =
      ctx?.factory
      ?? ctx?.npcs?.factory
      ?? globalThis.GAME?.npcManager?.factory
      ?? this.player?.avatar?.factory
      ?? null;
    this.ghost = GhostCompetitor.create({
      group: this._host,
      physics: this.player?.physics ?? null,
      factory,
      name: this.rivalName,
      tint: 0x52e9ff,
      seed: 51479,
      theme: 'citadel',
    });
    if (!this.ghost) return;
    this.ghost.setPose('run');
    this._syncGhost();
    const engine = ctx?.engine ?? this.player?.engine ?? null;
    /* Registered at match start, so insertion order puts it after NPCManager's
     * updater and the avatar's. Reads no input, so the endFrame()/pressed()
     * trap cannot apply. Released in dispose(). */
    this._offFrame = engine?.onFrameUpdate?.((dt, elapsed) => this.ghost?.update(dt, elapsed)) ?? null;
  }

  /** The lights go out. */
  begin(elapsed) {
    void elapsed;
    const p = this.player?.position;
    /* Seed the swept tail from where the body IS. Left at (0,0) the first step
     * would test a segment from the world origin to the start line, which on
     * this route passes through the inner ward and would credit checkpoints
     * nobody ran to. */
    this._px = p?.x ?? this.route[0].x;
    this._pz = p?.z ?? this.route[0].z;
    this.clock = 0;
    this.bus?.emit('trial:started', {
      venueId: this.venue.id,
      label: this.venue.label,
      checkpoints: this.route.length,
      par: { gold: this.par.gold, silver: this.par.silver, bronze: this.par.bronze },
      best: this.best,
    });
  }

  /**
   * One fixed step.
   *
   * @param {number} dt
   * @param {number} clock seconds since the lights went out - the MANAGER's
   *   clock, which is the number `minigame:finished` reports and `SaveGame`
   *   records, so the trial never keeps a second opinion about the time.
   * @returns {object|null} an outcome when the run is over
   */
  fixedUpdate(dt, clock) {
    void dt;
    this.clock = clock;
    if (this.finished) return null;

    this._advance();
    this._paceRival();

    if (this.nextCp >= this.route.length) return this._finish(true);
    if (clock >= this.par.timeout) return this._finish(false, 'out of time');
    return null;
  }

  /**
   * Advance the cursor if this step swept the armed checkpoint.
   *
   * One checkpoint is live at a time, which is the whole anti-shortcut and
   * anti-reverse argument: every other ring on the roof is inert, so cutting
   * the middle of the route never moves the cursor, and doubling back over a
   * ring already taken does nothing. See `race/CheckpointSweep.js`.
   */
  _advance() {
    const p = this.player?.position;
    if (!p) return;
    const cp = this.route[this.nextCp];
    if (!cp) return;
    const swept = sweptPass(this._px, this._pz, p.x, p.z, p.y, cp, CP_Y_GATE);
    /* Every step, hit or miss: a tail that only advanced on a hit would turn
     * the swept test into a test against the whole run so far. */
    this._px = p.x;
    this._pz = p.z;
    if (!swept) return;

    const passed = this.nextCp;
    this.done++;
    this.nextCp++;
    if (this.nextCp >= this.route.length) this.rings?.clear();
    else this.rings?.pass(passed, this.nextCp);
    this.bus?.emit('trial:checkpoint', {
      venueId: this.venue.id,
      label: this.venue.label,
      checkpoint: passed,
      of: this.route.length - 1,
      time: this.clock,
      /* On pace for gold, measured against an even split of the gold par. The
       * split is even because the route's own difficulty gradient is not this
       * file's to model - it is the world's, and it is authored. */
      onPace: this.clock <= (this.par.gold * passed) / (this.route.length - 1),
    });
  }

  /** Move the rival's body to exactly the distance its pace reports. */
  _paceRival() {
    this.rivalDist = Math.min(this.par.chain, this.rivalPace * this.clock);
    this._syncGhost();
  }

  _syncGhost() {
    if (!this.ghost) return;
    const heading = this._chainPoint(this.rivalDist, _ghostPos);
    this.ghost.place(_ghostPos, heading);
    this.ghost.setSpeedForAnim(this.rivalPace);
  }

  /**
   * The point `s` metres along the checkpoint chain, and the heading there.
   *
   * The CHAIN, not the walked route: the rival is a pace, and interpolating the
   * authored line is the only reading of "where the pace is" that cannot
   * disagree with the number on the HUD - they are the same number. It floats
   * over the gaps, exactly as the swim and ski rivals cut their own corners.
   *
   * @param {number} s
   * @param {THREE.Vector3} out mutated in place
   * @returns {number} heading, in the engine's forward convention
   */
  _chainPoint(s, out) {
    const cps = this.route;
    let left = Math.max(0, s);
    for (let i = 1; i < cps.length; i++) {
      const a = cps[i - 1];
      const b = cps[i];
      const seg = Math.hypot(b.x - a.x, b.y - a.y, b.z - a.z) || 1e-6;
      if (left <= seg || i === cps.length - 1) {
        const t = Math.min(1, left / seg);
        out.set(a.x + (b.x - a.x) * t, a.y + (b.y - a.y) * t, a.z + (b.z - a.z) * t);
        return Math.atan2(-(b.x - a.x), -(b.z - a.z));
      }
      left -= seg;
    }
    out.set(cps[0].x, cps[0].y, cps[0].z);
    return 0;
  }

  /**
   * Classify.
   *
   * `won` is "inside bronze", not "reached the last ring": a trial you can win
   * by strolling is a walk with a clock on it, and `SaveGame._recordTrial`
   * keeps the times of WINS only - so a stroll must not be able to write itself
   * into the ledger as a personal best.
   */
  _finish(completed, why) {
    this.finished = true;
    const time = this.clock;
    const medal = completed ? medalFor(time, this.par) : null;
    const won = !!medal;
    const beatBest = won && (!this.best || time < this.best);
    const pars = `gold ${clockText(this.par.gold)} · silver ${clockText(this.par.silver)} · bronze ${clockText(this.par.bronze)}`;
    return {
      won,
      place: won ? 1 : 2,
      total: 2,
      score: medal ?? (completed ? 'none' : 'dnf'),
      scoreLabel: completed ? `${clockText(time)}${medal ? ` · ${medal}` : ''}` : (why ?? 'did not finish'),
      rivalName: this.rivalName,
      detail: completed
        ? `${this.done} of ${this.route.length - 1} rings · ${pars}${beatBest ? ' · personal best' : ''}`
        : `${this.done} of ${this.route.length - 1} rings before the clock ran out`,
    };
  }

  /**
   * Everything the HUD wants for one frame, in one object.
   *
   * The keys are `MinigameUI`'s, not this file's preference. `update` reads
   * `r.k` for the label cell and `r.v` for the value, keys the row-rebuild off
   * `rows.map(r => r.k)`, and reads `progress` / `rivalProgress` / `subtitle` /
   * `banner` off the top level. `{label, value}` therefore rendered five blank
   * labels and the literal string "undefined" in every value cell, with the
   * progress bar frozen at 0% - all four other game modules (`SwimChallenge`,
   * `SkiRun`, `TrackRace`, `TennisMatch`) publish `{k, v}` and this one did
   * not. Nothing reads `medal`/`gold`/`silver`/`bronze`, so they are gone;
   * `detail` on the outcome already carries the pars.
   */
  snapshot() {
    const chain = this._playerChainDist();
    const gap = this.rivalDist - chain;
    const bronzeIn = this.par.bronze - this.clock;
    const n = this.route.length - 1;
    return {
      rows: [
        { k: 'TIME', v: clockText(this.clock) },
        { k: 'RING', v: `${this.done}/${n}` },
        {
          k: 'RIVAL',
          v: `${gap >= 0 ? '+' : ''}${gap.toFixed(0)} m`,
          tone: gap >= 0 ? 'good' : 'warn',
        },
        {
          k: 'BRONZE IN',
          v: clockText(Math.max(0, bronzeIn)),
          tone: bronzeIn <= 0 ? 'warn' : null,
        },
        { k: 'BEST', v: this.best ? clockText(this.best) : '—', dim: !this.best },
      ],
      // Both bars run on the CHAIN, which is what `rivalDist` is measured in -
      // mixing the walked route into one and the chain into the other would
      // put the ghost marker somewhere the ghost is not.
      progress: clamp01(chain / this.par.chain),
      rivalProgress: clamp01(this.rivalDist / this.par.chain),
      banner: this.finished ? null : (this.nextCp >= this.route.length ? 'FINISH' : null),
      subtitle: `${n} rings · gold ${clockText(this.par.gold)}`
        + ` · silver ${clockText(this.par.silver)} · bronze ${clockText(this.par.bronze)}`
        + ` · racing ${this.rivalName}`,
    };
  }

  /** How far along the chain the cursor has taken the player. */
  _playerChainDist() {
    let sum = 0;
    for (let i = 1; i <= this.done && i < this.route.length; i++) {
      const a = this.route[i - 1];
      const b = this.route[i];
      sum += Math.hypot(b.x - a.x, b.y - a.y, b.z - a.z);
    }
    return sum;
  }

  /** Idempotent: the manager tears down on quit, death and world change too. */
  dispose() {
    if (this._offFrame) {
      try {
        this._offFrame();
      } catch {
        /* a hook already released is not an error */
      }
      this._offFrame = null;
    }
    this.ghost?.dispose?.();
    this.ghost = null;
    this.rings?.dispose?.();
    this.rings = null;
  }
}

/**
 * The factory `minigames.registerGame('rooftop', ...)` calls.
 *
 * Returns null - "not available", never a thrown contest - when the venue has
 * no usable route or when the player is not standing on the start line. The
 * start gate lives HERE and not in the venue disc because the disc has to hold
 * the whole route or `LEAVE_GRACE_S` abandons the run nine seconds in; see
 * {@link venueBounds}.
 *
 * @param {object} venue
 * @param {object} ctx
 * @returns {RooftopTrial|null}
 */
export function createRooftopTrial(venue, ctx = {}) {
  const cps = venue?.config?.checkpoints;
  if (!Array.isArray(cps) || cps.length < 3) return null;
  const start = cps[0];
  const p = ctx.player?.position;
  const named = Number(venue?.config?.startRadius);
  const startR = named > 0 ? named : START_RADIUS;
  if (p) {
    const d = Math.hypot(p.x - start.x, p.z - start.z);
    if (d > startR || Math.abs(p.y - start.y) > CP_Y_GATE) {
      /* Say WHERE, not just no. The venue disc covers the whole route, so the
       * prompt is up along the length of it, and a bare "not available" would
       * read as a broken venue rather than as "you are not on the line". */
      ctx.bus?.emit('hud:notify', {
        text: `${venue.label ?? 'The trial'} starts at the first ring, ${Math.round(d)} m away`,
        tone: 'warn',
      });
      return null;
    }
  }
  try {
    return new RooftopTrial(venue, ctx);
  } catch (err) {
    console.warn('[rooftop] trial failed to build:', err?.message ?? err);
    return null;
  }
}

export default createRooftopTrial;
