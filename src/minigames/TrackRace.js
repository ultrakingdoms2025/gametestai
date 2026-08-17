import * as THREE from 'three';
import { GhostCompetitor } from './GhostCompetitor.js';

/**
 * The Meridian 400 m: one lap of the athletics oval, on foot, against three
 * pace runners who are visibly on the track with you.
 *
 * ── Abstracted, but not faked ────────────────────────────────────────────────
 *
 * The player's half of this contest is entirely real movement and none of it
 * is new: `Player` already walks at 4.6 m/s, sprints at 8.2 m/s, and pays for
 * the sprint out of the real `Stamina` pool (drain 15/s, regen 24/s after a
 * 0.9 s delay, exhaustion latched until 22%). This module adds nothing to the
 * movement model and changes none of it. It watches where the runner is and
 * decides which checkpoints they took — the swept ordered-checkpoint scheme
 * `RaceManager._advance` uses, for the same tunnelling reason.
 *
 * ── The course, and the two rulers ───────────────────────────────────────────
 *
 * The oval is `SportsWorld._buildTrack`'s: centred (105, -100), 84.39 m
 * straights, inner radius 36.5, eight 1.22 m lanes (`const TRACK`, restated
 * in `TRACK_COURSE` below; the track test re-extracts the world's numbers
 * from source and fails the build if the two ever drift). The whole oval
 * sits inside flat zone [15,-149,195,-51], where `parkHeight` returns 0 —
 * the rubber ribbon itself has NO collider, runners stand on the site
 * heightfield under it, so ground y here is 0 to within centimetres and
 * every y is taken from the venue's own `heightFn` (fallback: a physics
 * probe, then 0), never trusted as a bare constant.
 *
 * Two rulers, both stated so neither lies:
 *  - CHECKPOINTS and the progress readout live on the track's MID radius
 *    (41.38 m → a 428.8 m line): centred there, the 6.5 m pass radius covers
 *    every lane from the kerb to the outer edge with ~4.9 m to spare, so no
 *    legal racing line can be robbed by lane choice.
 *  - The PLAYER is started in lane 6 (r 43.21 → 440.3 m if they hold it) and
 *    the pacing arithmetic below is computed on that, their actual distance.
 *    Undercutting to lane 1 (402 m) is not a foul — it is the racing line,
 *    and the tuning still holds (see the table).
 *
 * The real-world stagger is deliberately NOT modelled: all four racers start
 * abreast on the finish line and each runs a full lap of their OWN lane, so
 * the inner-lane ghosts genuinely run shorter laps. Their pace curves are
 * tuned as absolute finish times, so the handicap is priced in, not ignored.
 *
 * ── The rivals are ghosts, and the ghosts have bodies ────────────────────────
 *
 * Priya Raghunathan trains beside this track (`SportsWorld` spawn (62,-48))
 * and her patrol is authored content that must not break — so, exactly like
 * Tavius at the pool and Kjell on the mound, the contest races her BEST TIME:
 * three paced distances advancing on tuned curves, each wearing a
 * `GhostCompetitor` in the real `NPCAnimator` run cycle, placed every fixed
 * step at exactly the distance its readout reports. The body and the number
 * can never disagree — they are the same number. No factory or group
 * (headless tests) means no bodies and an unchanged contest.
 *
 * ── Winnability, audited (the real numbers from Config.js / Stamina.js) ──────
 *
 * Sprint 8.2 m/s costs 15 stamina/s from a 100 pool → a 6.67 s / 54.7 m
 * opening tank. Regen is 24/s after a 0.9 s delay and an empty pool latches
 * until 22 (RECOVER_FRACTION 0.22), so holding sprint settles into a
 * 1.47 s sprint / 1.82 s recover cycle ≈ 6.21 m/s. Therefore:
 *
 *   committed sprinter, lane 6:  6.7 + (440.3 − 54.7)/6.21  ≈ 69 s (~6.4 m/s)
 *   jogger, lane 6:              440.3 / 4.6                ≈ 96 s
 *   jogger, even hugging lane 1: 402.0 / 4.6                ≈ 87 s
 *
 * Ghosts (T = (L / (v1−v0)) · ln(v1/v0), a gentle negative split each):
 *
 *   lane 1, 402.0 m, 5.05→5.70 m/s ≈ 74.9 s → the sprinter wins by ~6 s
 *   lane 2, 409.6 m, 4.85→5.42 m/s ≈ 79.9 s
 *   lane 3, 417.3 m, 4.55→5.18 m/s ≈ 85.9 s → a half-committed ~5.4 m/s run
 *                                              (~81 s) finishes P3
 *
 * So: sprint most of the lap and manage the dips → win narrowly; jog → lose
 * to all three. The pacing test drives a runner through the REAL `Stamina`
 * class over the real lane geometry and holds this outcome — retuning stamina
 * retunes this contest, and the suite will say so. (The model reaches 8.2
 * instantly where the real accelerator ramps over a second or two; the ~6 s
 * margin is what absorbs that optimism.)
 *
 * ── Mounts ───────────────────────────────────────────────────────────────────
 *
 * A foot race: on accept, a willing mount is dismounted before the start-line
 * teleport (the mount owns position while ridden — measured — so a seated
 * teleport would silently snap back). A player who summons a board MID-race
 * is not thrown off it, but checkpoints do not count while mounted and the
 * banner says why — the ski run's loot-moonlighting precedent, policed just
 * enough that a 14 m/s board cannot buy the payout.
 *
 * No course furniture is built: the track already carries its own painted
 * lines, numerals and the start/finish gantry, and the HUD carries the
 * checkpoint count. Nothing to add is nothing to leak.
 */

/** Course id. This is the handle a quest step names - see MinigameManager._finish. */
export const TRACK_GAME_ID = 'track_race';

/**
 * The oval, as data. Every number restating a `SportsWorld const TRACK` value
 * is cross-checked against that file's source by the track test.
 */
export const TRACK_COURSE = {
  /* ---- SportsWorld's TRACK, restated (drift-guarded by the test) ---- */
  cx: 105,
  cz: -100,
  straight: 84.39,
  inner: 36.5,
  lanes: 8,
  laneW: 1.22,
  /* ---- this contest's own course ---- */
  /** The player's start lane (outer-ish; ghosts take 1-3). */
  playerLane: 6,
  /** Checkpoints per lap, evenly spaced on the mid-radius line. */
  checkpoints: 12,
  /** Swept pass radius. Centred on the mid radius it reaches ~4.9 m past the
   *  kerb and the outer lane edge alike, so no lane choice can be robbed. */
  cpRadius: 6.5,
  /** Vertical acceptance — rejects a dragon flown over the oval, tolerates
   *  a jump. Same idea as RaceManager's checkpoint yGate. */
  cpYGate: 10,
};

/** Seconds before the whole contest is called off. A jog is ~96 s. */
const TIME_LIMIT_S = 240;

/**
 * The pace runners. Curves are linear in distance-fraction, integrating to
 * the finish times in the header table; the venue's `rival.name` replaces
 * the leader's so the world stays the naming authority.
 */
const RUNNER_DEFS = [
  { name: 'Priya Raghunathan', lane: 1, v0: 5.05, v1: 5.7, tint: 0xd23c3c, seed: 90211 },
  { name: 'Castor Ilunga', lane: 2, v0: 4.85, v1: 5.42, tint: 0x2f8fd0, seed: 90223 },
  { name: 'Greta Lindqvist', lane: 3, v0: 4.55, v1: 5.18, tint: 0xf4c542, seed: 90239 },
];

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);

/** `m:ss.mm`, copied from SwimChallenge so every timed contest reads alike. */
function clockText(seconds) {
  if (!(seconds > 0)) return '—';
  const m = Math.floor(seconds / 60);
  const s = seconds - m * 60;
  return `${m}:${s < 10 ? '0' : ''}${s.toFixed(2)}`;
}

/**
 * Squared distance from point `p` to the segment `a`->`b`, in XZ.
 * Copied from RaceManager.js:140 - the swept test that makes a fast pass
 * unable to tunnel a checkpoint, used here for the same reason.
 */
function segDistSq(ax, az, bx, bz, px, pz) {
  const ex = bx - ax;
  const ez = bz - az;
  const e2 = ex * ex + ez * ez;
  let t = e2 > 1e-9 ? ((px - ax) * ex + (pz - az) * ez) / e2 : 0;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  const dx = px - (ax + ex * t);
  const dz = pz - (az + ez * t);
  return dx * dx + dz * dz;
}

/** Centre radius of a 1-based lane. Lane 1 hugs the kerb. */
export function laneRadius(lane) {
  return TRACK_COURSE.inner + (lane - 0.5) * TRACK_COURSE.laneW;
}

/** The mid line of the lane band — where the checkpoints live. */
export function midRadius() {
  return TRACK_COURSE.inner + (TRACK_COURSE.lanes * TRACK_COURSE.laneW) / 2;
}

/** Metres of one lap at radius `r`: two straights and two semicircles. */
export function lapLength(r) {
  return 2 * TRACK_COURSE.straight + 2 * Math.PI * r;
}

/**
 * The point `s` metres around the oval at radius `r`.
 *
 * s = 0 is the finish line (x = cx on the southern home straight — where
 * `_buildTrack` paints it and parks the gantry) and travel is east first,
 * matching `ovalPath`'s winding: home straight +x, east curve, back straight
 * -x, west curve, home. `yaw` follows the engine's forward convention
 * (-sin yaw, 0, -cos yaw).
 *
 * @param {number} r lane radius
 * @param {number} s metres along the lap; wraps
 * @param {{x?:number,z?:number,yaw?:number}} [out]
 */
export function coursePoint(r, s, out = null) {
  const c = TRACK_COURSE;
  const hs = c.straight / 2;
  const arc = Math.PI * r;
  const lap = 2 * c.straight + 2 * arc;
  let t = s % lap;
  if (t < 0) t += lap;
  const o = out ?? {};
  if (t < hs) {
    // Home (southern) straight, east-bound, from the line.
    o.x = c.cx + t;
    o.z = c.cz - r;
    o.yaw = -Math.PI / 2;
  } else if (t < hs + arc) {
    // East curve.
    const a = -Math.PI / 2 + (t - hs) / r;
    o.x = c.cx + hs + Math.cos(a) * r;
    o.z = c.cz + Math.sin(a) * r;
    o.yaw = Math.PI - a;
  } else if (t < hs + arc + c.straight) {
    // Back straight, west-bound.
    o.x = c.cx + hs - (t - hs - arc);
    o.z = c.cz + r;
    o.yaw = Math.PI / 2;
  } else if (t < hs + 2 * arc + c.straight) {
    // West curve.
    const a = Math.PI / 2 + (t - hs - arc - c.straight) / r;
    o.x = c.cx - hs + Math.cos(a) * r;
    o.z = c.cz + Math.sin(a) * r;
    o.yaw = Math.PI - a;
  } else {
    // Southern straight, back east to the line.
    o.x = c.cx - hs + (t - hs - 2 * arc - c.straight);
    o.z = c.cz - r;
    o.yaw = -Math.PI / 2;
  }
  return o;
}

/**
 * The inverse: metres around the lap at radius `r` for a world position.
 * Pure angle/offset arithmetic, so it projects any position — infield,
 * outfield, airborne — onto the nearest course parameter.
 */
export function courseProject(x, z, r) {
  const c = TRACK_COURSE;
  const hs = c.straight / 2;
  const arc = Math.PI * r;
  const lap = 2 * c.straight + 2 * arc;
  if (x >= c.cx + hs) {
    let a = Math.atan2(z - c.cz, x - (c.cx + hs));
    a = Math.min(Math.max(a, -Math.PI / 2), Math.PI / 2);
    return hs + (a + Math.PI / 2) * r;
  }
  if (x <= c.cx - hs) {
    let a = Math.atan2(z - c.cz, x - (c.cx - hs));
    if (a < 0) a += Math.PI * 2; // west side: a lives in [pi/2, 3pi/2]
    a = Math.min(Math.max(a, Math.PI / 2), Math.PI * 1.5);
    return hs + arc + c.straight + (a - Math.PI / 2) * r;
  }
  if (z >= c.cz) return hs + arc + (c.cx + hs - x); // back straight
  const t = x - c.cx; // home straight: ahead of the line, or wrapped behind it
  return t >= 0 ? t : lap + t;
}

/**
 * The checkpoints: `TRACK_COURSE.checkpoints` of them, evenly spaced on the
 * mid-radius line, the last one ON the finish line (s = lap wraps to the
 * line point, which is what makes "pass them all in order" mean "run the
 * whole lap back to the paint").
 *
 * @param {((x:number, z:number)=>number)|null} heightFn ground field; when
 *   absent (tests without a world) y is 0 — which on this track's flat zone
 *   is also the truth.
 * @returns {Array<{i:number, s:number, x:number, z:number, y:number}>}
 */
export function checkpointCourse(heightFn = null) {
  const r = midRadius();
  const lap = lapLength(r);
  const n = TRACK_COURSE.checkpoints;
  const cps = [];
  const pt = {};
  for (let i = 0; i < n; i++) {
    const s = ((i + 1) * lap) / n;
    coursePoint(r, s, pt);
    cps.push({ i, s, x: pt.x, z: pt.z, y: heightFn ? heightFn(pt.x, pt.z) : 0 });
  }
  return cps;
}

/* Scratch for the per-step ghost sync — this module owns its own. */
const _pt = { x: 0, z: 0, yaw: 0 };

export class TrackRace {
  /**
   * @param {object} venue validated descriptor from MinigameManager
   * @param {{player:any, bus:any, input?:any, mounts?:any, worldManager?:any,
   *          npcs?:any, engine?:any, factory?:any}} ctx the manager supplies
   *   player/bus/input; the rest arrive from main.js's registerGame closure
   *   (see the integration spec) and every one degrades — no mounts means no
   *   dismount guard, no factory/group means no bodies — because the headless
   *   tests build none.
   */
  constructor(venue, ctx = {}) {
    const { player, bus } = ctx;
    this.id = TRACK_GAME_ID;
    this.venue = venue;
    this.player = player;
    this.bus = bus ?? null;

    const cfg = venue?.config ?? {};
    /** The world's own ground field (parkHeight — 0 across the flat zone). */
    this.heightFn = typeof cfg.heightFn === 'function' ? cfg.heightFn : null;
    this.groundY = Number.isFinite(Number(cfg.groundY)) ? Number(cfg.groundY) : 0;

    this._midR = midRadius();
    this._lap = lapLength(this._midR);
    this._spacing = this._lap / TRACK_COURSE.checkpoints;
    this.checkpoints = checkpointCourse((x, z) => this._groundAt(x, z));

    /** The field, each runner its own lane, lap and curve. */
    this.runners = RUNNER_DEFS.map((def, i) => {
      const r = laneRadius(def.lane);
      return {
        name: i === 0 && venue?.rival?.name ? venue.rival.name : def.name,
        lane: def.lane,
        r,
        lap: lapLength(r),
        v0: def.v0,
        v1: def.v1,
        tint: def.tint,
        seed: def.seed,
        dist: 0,
        done: false,
        finishClock: null,
        ghost: null,
        /* sparse ground cache for the body's y */
        _gx: Infinity,
        _gz: Infinity,
        _gy: this.groundY,
      };
    });
    this.rivalName = this.runners[0].name;

    /** 'set' until the gun; the player is PLACED on the line, so there is no
     *  approach phase — the countdown IS the marks, exactly like a race. */
    this.phase = 'set';
    this.clock = 0;
    /** Checkpoints passed, strictly in order. */
    this._cp = 0;
    /** Continuous mid-radius ruler, monotonic; see fixedUpdate. */
    this._sMax = 0;
    /** Previous fixed-step position, for the swept tests. null = not primed. */
    this._px = null;
    this._pz = null;
    /** First ghost home, for the loss card. */
    this._firstHome = null;
    this._finished = false;
    this._disposed = false;

    this._mounts = ctx.mounts ?? globalThis.GAME?.mounts ?? null;

    /* ---- the start position ----------------------------------------
     * start() runs this factory during the countdown, so placing here is
     * what makes the countdown show a runner on the line. */
    this._placePlayer();

    /* ---- the visible field ------------------------------------------
     * Bodies only where there is a group to hold them and a factory to loft
     * them; a headless test has neither and races the readout alone. */
    this._offFrame = null;
    this._buildGhosts(ctx);
  }

  /**
   * Ground under a course point: the venue's own field first (deterministic,
   * free), then a physics probe (from head height, so the walkable plane is
   * what answers), then the flat-zone truth of 0.
   */
  _groundAt(x, z) {
    if (this.heightFn) {
      const h = this.heightFn(x, z);
      if (Number.isFinite(h)) return h;
    }
    const g = this.player?.physics?.groundHeight?.(x, z, 6, 30);
    return Number.isFinite(g) ? g : this.groundY;
  }

  /**
   * Put the runner on the line: lane 6, on the finish paint, facing down the
   * home straight. A ridden mount owns position (measured), so a willing one
   * is dismounted first — this is a FOOT race. `teleport` is the same call
   * TennisMatch and the swim place with; the bare-position fallback is for
   * harnesses that build a plain `{position}` player.
   */
  _placePlayer() {
    const p = this.player;
    if (!p) return;
    const m = this._mounts;
    if (m?.active && (m.active.canDismount?.() ?? true)) {
      try {
        m.dismount?.();
      } catch {
        /* a mount that refuses stays; the teleport below is then cosmetic */
      }
    }
    const r = laneRadius(TRACK_COURSE.playerLane);
    const x = TRACK_COURSE.cx;
    const z = TRACK_COURSE.cz - r;
    const y = this._groundAt(x, z) + 0.05;
    // Forward is (-sin yaw, 0, -cos yaw): -PI/2 faces +X, down the straight.
    const yaw = -Math.PI / 2;
    if (typeof p.teleport === 'function') {
      p.teleport(new THREE.Vector3(x, y, z), yaw);
    } else if (p.position) {
      p.position.x = x;
      p.position.y = y;
      p.position.z = z;
    }
  }

  /** Loft the field's bodies and hook their animation to the frame tick. */
  _buildGhosts(ctx) {
    const host =
      this.venue?.config?.group ??
      ctx?.worldManager?.active?.group ??
      this.player?.scene ??
      null;
    if (!host || typeof host.add !== 'function') return;
    const factory =
      ctx?.factory ??
      ctx?.npcs?.factory ??
      globalThis.GAME?.npcManager?.factory ??
      this.player?.avatar?.factory ??
      null;
    for (const r of this.runners) {
      r.ghost = GhostCompetitor.create({
        group: host,
        physics: this.player?.physics ?? null,
        factory,
        name: r.name,
        tint: r.tint,
        seed: r.seed,
        theme: 'sports',
      });
      r.ghost?.setPose('run');
    }
    if (!this.runners.some((r) => r.ghost)) return;
    this._syncGhosts();
    const engine = ctx?.engine ?? this.player?.engine ?? null;
    // Registered at match start, so it runs AFTER the animators (insertion
    // order) and never reads input — both engine contracts by the book.
    this._offFrame =
      engine?.onFrameUpdate?.((dt, elapsed) => {
        for (const r of this.runners) r.ghost?.update(dt, elapsed);
      }) ?? null;
  }

  /**
   * Put every body exactly at the distance its pace logic reports — the same
   * numbers the POSITION and LEADER rows are computed from, so the field on
   * the track and the readout can never disagree. y is the ground under the
   * body, probed sparsely (the track is flat; the cache makes that free).
   */
  _syncGhosts() {
    const racing = this.phase === 'racing';
    for (const r of this.runners) {
      const g = r.ghost;
      if (!g) continue;
      coursePoint(r.r, Math.min(r.dist, r.lap), _pt);
      if (Math.abs(_pt.x - r._gx) > 1.5 || Math.abs(_pt.z - r._gz) > 1.5) {
        r._gx = _pt.x;
        r._gz = _pt.z;
        r._gy = this._groundAt(_pt.x, _pt.z);
      }
      g.place({ x: _pt.x, y: r._gy, z: _pt.z }, _pt.yaw);
      const u = clamp01(r.dist / r.lap);
      g.setSpeedForAnim(racing && !r.done ? r.v0 + (r.v1 - r.v0) * u : 0);
    }
  }

  /** Seconds of "on your marks". Read by the manager. */
  get countdown() {
    return 4.0;
  }

  /** Called the instant the countdown expires: the gun. */
  begin() {
    this.phase = 'racing';
    this.clock = 0;
    this._cp = 0;
    this._sMax = 0;
    this._px = null;
    this._pz = null;
    this._firstHome = null;
    for (const r of this.runners) {
      r.dist = 0;
      r.done = false;
      r.finishClock = null;
    }
    this._syncGhosts();
    this.bus?.emit('minigame:event', { gameId: this.id, kind: 'off', text: 'GO' });
  }

  /** Metres of the mid-radius course line the player has covered. */
  get playerDist() {
    return this._sMax;
  }

  /** The course line's lap, for readouts. */
  get playerLap() {
    return this._lap;
  }

  /** 1 + ghosts strictly ahead, by lap fraction (each runs their own lap). */
  _rank() {
    const pf = this._sMax / this._lap;
    let ahead = 0;
    for (const r of this.runners) if (r.dist / r.lap > pf + 1e-9) ahead += 1;
    return 1 + ahead;
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

    // Prime the swept tests: the first step has no segment yet.
    if (this._px === null) {
      this._px = p.x;
      this._pz = p.z;
      return null;
    }
    if (this.phase !== 'racing') {
      // Defensive: the manager only ticks a PLAYING game, and begin() always
      // ran first — but a bare harness may not honour that.
      this._syncGhosts();
      return null;
    }

    this.clock += dt;
    this._advanceRunners(dt);

    /* Checkpoints resolve strictly in order against the segment travelled
     * this step; the loop re-tests the SAME segment after each pass, so a
     * stalled tab's one enormous step cannot silently skip the course.
     * There is no miss branch and no penalty: an unpassed checkpoint simply
     * waits — leaving the track is not punished beyond the distance it
     * wastes. While MOUNTED nothing counts (the banner says why): this is a
     * foot race, and a 14 m/s hoverboard must not buy the payout. */
    if (!this._mounts?.active) {
      let guard = this.checkpoints.length + 1;
      while (this._cp < this.checkpoints.length && guard-- > 0) {
        const cp = this.checkpoints[this._cp];
        const d2 = segDistSq(this._px, this._pz, p.x, p.z, cp.x, cp.z);
        if (
          d2 <= TRACK_COURSE.cpRadius * TRACK_COURSE.cpRadius &&
          Math.abs(p.y - cp.y) <= TRACK_COURSE.cpYGate
        ) {
          this._cp += 1;
          this.bus?.emit('minigame:event', {
            gameId: this.id,
            kind: 'split',
            text: `CHECKPOINT ${this._cp}/${this.checkpoints.length} — ${clockText(this.clock)}`,
          });
          continue;
        }
        break;
      }
    }
    this._px = p.x;
    this._pz = p.z;

    /* The continuous ruler: project onto the mid-radius line and take only
     * the stretch between the last checkpoint passed and the next — a
     * position anywhere else (behind the line, across the infield, half a
     * lap ahead of the armed checkpoint) is worth zero. Ordered checkpoints
     * stay the authority; this number only smooths the LEADER gap between
     * them. The cpRadius of slack covers the honest case where the swept
     * pass registers a stride early. */
    const s = courseProject(p.x, p.z, this._midR);
    const base = this._cp * this._spacing;
    let rel = s - base;
    rel -= this._lap * Math.round(rel / this._lap);
    if (rel >= 0 && rel <= this._spacing + TRACK_COURSE.cpRadius) {
      const cand = base + Math.min(rel, this._spacing);
      if (cand > this._sMax) this._sMax = Math.min(cand, this._lap);
    }

    // The bodies ride the SAME numbers the readout shows — synced after the
    // advance and the gate loop, never before them.
    this._syncGhosts();

    if (this._cp >= this.checkpoints.length) {
      // Ordered passes all the way round and back to the paint: the lap is
      // genuinely run. A dead-heat step goes to the ghost (the ski rule).
      return this.runners.some((r) => r.done) ? this._lose('rival') : this._win();
    }
    if (this.runners.some((r) => r.done)) return this._lose('rival');
    if (elapsed >= TIME_LIMIT_S) return this._lose('time');
    return null;
  }

  /**
   * Move the field. Distance-driven, like the swim's and the ski's: each
   * curve is a property of the course, not of how long the player takes.
   */
  _advanceRunners(dt) {
    for (const r of this.runners) {
      if (r.done) continue;
      const u = clamp01(r.dist / r.lap);
      r.dist += (r.v0 + (r.v1 - r.v0) * u) * dt;
      if (r.dist >= r.lap) {
        r.dist = r.lap;
        r.done = true;
        r.finishClock = this.clock;
        if (!this._firstHome) this._firstHome = r;
      }
    }
  }

  _win() {
    this._finished = true;
    this.dispose();
    let best = this.runners[0];
    for (const r of this.runners) if (r.dist / r.lap > best.dist / best.lap) best = r;
    return {
      won: true,
      place: 1,
      total: 1 + this.runners.length,
      score: this.clock,
      scoreLabel: clockText(this.clock),
      rivalName: best.name,
      detail: {
        checkpoints: this.checkpoints.length,
        passed: this._cp,
        lane: TRACK_COURSE.playerLane,
        lapM: Math.round(lapLength(laneRadius(TRACK_COURSE.playerLane))),
        courseM: Math.round(this._lap),
        /** Metres the nearest ghost still had to run. */
        margin: best.lap - best.dist,
        runners: this.runners.map((r) => ({ name: r.name, lane: r.lane, covered: r.dist })),
      },
    };
  }

  /** @param {'rival'|'time'} why */
  _lose(why) {
    this._finished = true;
    const place = this._rank();
    this.dispose();
    return {
      won: false,
      place,
      total: 1 + this.runners.length,
      score: this.clock,
      scoreLabel: why === 'time' ? 'Timed out' : clockText(this.clock),
      rivalName: why === 'time' ? null : (this._firstHome?.name ?? this.rivalName),
      detail: {
        reason: why,
        checkpoints: this.checkpoints.length,
        passed: this._cp,
        progress: this.playerDist,
        courseM: Math.round(this._lap),
        runners: this.runners.map((r) => ({
          name: r.name,
          lane: r.lane,
          covered: r.dist,
          finish: r.finishClock,
        })),
      },
    };
  }

  /**
   * The live readout, as generic rows the minigame HUD renders without
   * knowing what a lap is: next checkpoint, clock, position in the field,
   * and the gap to (or lead over) the best ghost.
   */
  snapshot() {
    const racing = this.phase === 'racing';
    const n = this.checkpoints.length;
    const pf = this._sMax / this._lap;
    let best = 0;
    for (const r of this.runners) {
      const f = r.dist / r.lap;
      if (f > best) best = f;
    }
    const gap = (pf - best) * this._lap;
    const mounted = !!this._mounts?.active;
    const rows = [
      { k: 'CHECKPOINT', v: `${Math.min(this._cp + (racing ? 1 : 0), n)}/${n}` },
      { k: 'TIME', v: racing ? (clockText(this.clock) === '—' ? '0:00.00' : clockText(this.clock)) : '0:00.00' },
      { k: 'POSITION', v: racing ? `P${this._rank()}/${1 + this.runners.length}` : '—' },
      {
        k: 'LEADER',
        v: racing ? `${gap >= 0 ? '+' : ''}${gap.toFixed(1)} m` : '—',
        tone: !racing ? null : gap >= 0 ? 'good' : 'warn',
      },
    ];
    return {
      rows,
      progress: clamp01(pf),
      rivalProgress: clamp01(best),
      banner: racing
        ? (mounted ? 'ON FOOT — DISMOUNT TO RACE' : null)
        : 'ONE LAP — FOLLOW YOUR LANE ROUND TO THIS LINE',
      subtitle:
        `${n} checkpoints · one lap · ` +
        `${Math.round(lapLength(laneRadius(TRACK_COURSE.playerLane)))} m in lane ` +
        `${TRACK_COURSE.playerLane} · racing ${this.rivalName} + ${this.runners.length - 1} more`,
    };
  }

  /**
   * Idempotent, and called from two places on purpose (the TennisMatch
   * pattern): the manager's teardown on abort/quit/world change/death, and
   * this module's own win/lose — a FINISHED contest is only ever `reset()`,
   * which nulls the module without disposing it, and the bodies would leak.
   */
  dispose() {
    if (this._disposed) return;
    this._disposed = true;
    if (this._offFrame) {
      try {
        this._offFrame();
      } catch {
        /* engine already gone */
      }
      this._offFrame = null;
    }
    for (const r of this.runners) {
      r.ghost?.dispose?.();
      r.ghost = null;
    }
  }
}

/**
 * Factory registered against the `run` venue kind.
 * @param {object} venue
 * @param {{player:any, bus:any}} ctx
 */
export function createTrackRace(venue, ctx) {
  return new TrackRace(venue, ctx);
}

export default TrackRace;
