import * as THREE from 'three';
import { GhostCompetitor } from './GhostCompetitor.js';

/**
 * The Meridian Downhill: a slalom descent of the ski mound's middle piste.
 *
 * ── Abstracted, but not faked ────────────────────────────────────────────────
 *
 * The player's half of this contest is entirely real movement, and none of it
 * is new. The mound is a real height field with real collision
 * (`SportsWorld._addHeightCollision`, :5503) and the hoverboard already
 * terrain-follows it with a snowboard stance (`MountManager._poseBoard`), so
 * "skiing" is riding the board down the groomed piste - which is what a
 * hoverboard on snow would be. This module adds nothing to the movement model
 * and changes none of it. It watches where the rider is and decides which
 * gates they took.
 *
 * The one thing it must NOT do is add a slide mechanic: the player controller
 * is DELIBERATELY immune to slope-sliding (`Player.js:851-871` - the capsule
 * solver already leaves the player tangent to the slope, and a "fix" on top
 * holds them off the ground). The board is the descent authority here, not
 * gravity.
 *
 * ── The rival is a ghost, and now the ghost has a body ───────────────────────
 *
 * Kjell Nordvik teaches at the bottom of this hill (`SportsWorld.js:8796`,
 * spawn (-52,-56)) and his patrol is authored content that must not break; an
 * NPC also cannot ride a mount. So the rival is his best time: a pace point
 * advancing down the fall line on a tuned curve, exactly like the swim's pace
 * swimmer. A missed gate does not disqualify - it hands the ghost
 * `penaltyS` seconds of extra running, which keeps the RIVAL gap readout
 * honest: what you see on the hill is what decides the result.
 *
 * That pace point now WEARS a `GhostCompetitor`: a kinematic skinned humanoid
 * in the board stance on a simple board, placed every fixed step at exactly
 * the fall-line distance `_rivalDist` reports, x on a cosine weave that
 * threads the gates, y from the world's own `heightFn` so he rides the snow.
 * The readout and the body are the same number by construction. No factory
 * or group (headless tests) means no body and an unchanged contest.
 *
 * ── Where the course is, and why the numbers are duplicated ──────────────────
 *
 * The middle piste is groomed into `skiHeight` (SportsWorld.js:841-884) as a
 * dip around a weaving centreline: lane centre x = -62 (PISTE_LANES[1]),
 * weave `sin((z + 200) * 0.034 + 1) * 5.5`, groomed width `9 + 1*1.6 = 10.6`.
 * Those constants are restated here so the gates can be laid ON the piste, and
 * `scripts/tests/minigame-ski.test.mjs` re-extracts them from SportsWorld's
 * own source and fails the build if the two ever drift. Gate HEIGHT is never
 * restated: the venue hands this module the world's own `skiHeight` as
 * `config.heightFn`, so every gate sits on the snow by construction.
 *
 * The course runs DOWNHILL toward +z ("Skiers travel toward +z" - the kicker
 * comment in `skiHeight`): a start line near the summit at z=-190, ten gates
 * on alternating sides of the centreline every 10 m, a finish at z=-88.
 *
 * ── Why the venue disc covers the whole face, not just the summit ────────────
 *
 * `MinigameManager` abandons a contest `LEAVE_GRACE_S` (9) seconds after the
 * player leaves the venue, and this descent drops ~100 m of fall line in
 * ~15-25 s. A summit-only trigger therefore self-aborts halfway down - so the
 * venue descriptor centres mid-course with a radius that holds the whole run,
 * and the START of the contest is enforced here instead, the way the swim
 * does it: an 'approach' phase that arms nothing until the start line at the
 * top is actually crossed. Dawdling on the climb costs nothing, and the clock
 * and the ghost do not move until the line does.
 *
 * ── The mount, and who owns it ───────────────────────────────────────────────
 *
 * On start this module summons and mounts the hoverboard through
 * `MountManager.summon('hoverboard')` ('hoverboard' is in the default
 * unlocked set, MountManager.js:241). One guard matters: `summon` TOGGLES -
 * summoning the mount the player is already riding dismisses it - so a player
 * already on their board is left exactly as they are. On finish and on abort
 * the board is dismounted only if this module was the one that mounted it,
 * and only when `canDismount()` agrees (the board refuses above 2.2 m of
 * air, and forcing it there would drop the rider).
 *
 * There is deliberately NO SkiPose module. While mounted the player avatar is
 * hidden (`MountManager._showAvatar(false)`) and the visible figure is the
 * rider proxy, whose stance `_poseBoard` owns entirely - a late-pose additive
 * would pose an invisible skeleton. On foot (countdown before the auto-mount
 * lands, and the result hold after the dismount) `MinigamePose` already
 * supplies the set crouch and the win/lose reactions for every contest.
 */

/** Course id. This is the handle a quest step names - see MinigameManager._finish. */
export const SKI_GAME_ID = 'ski_slalom';

/**
 * The course, as data. Every number that restates a `skiHeight` constant is
 * cross-checked against SportsWorld's source by the ski test.
 */
export const SKI_COURSE = {
  /** PISTE_LANES[1] - the middle piste's fall-line centre. */
  laneX: -62,
  /** The groomed corridor weaves sinusoidally: amp, frequency, phase (= lane index). */
  weaveAmp: 5.5,
  weaveFreq: 0.034,
  weavePhase: 1,
  weaveZOff: 200,
  /** Groomed width of the middle piste: 9 + 1 * 1.6. */
  pisteWidth: 10.6,
  /** Start line, near the summit (fz ≈ 0.99 of the 52 m cosine profile). */
  startZ: -190,
  /** Half-width of the start line's lateral acceptance band. */
  startHalf: 12,
  /** Finish line, in the run-out below the last gate. */
  finishZ: -88,
  gateCount: 10,
  gateZ0: -184,
  gateSpacing: 10,
  /** Gates alternate this far either side of the weaving centreline. */
  gateOffset: 3.2,
  /** Poles stand this far either side of a gate's centre. */
  gateHalf: 1.6,
  /** Swept pass-detection radius: a shade outside the poles, so a clean line
   *  through the gate can never be robbed by sampling. */
  gateRadius: 2.4,
  /** Vertical acceptance around the gate's snow height - rejects a dragon
   *  flown over the course, tolerates the board's hover and a fast step's
   *  worth of slope. Same idea as RaceManager's checkpoint yGate. */
  gateYGate: 10,
  /** Metres past a gate's z before it is called missed. */
  missMargin: 6,
  /** Seconds a missed gate hands the ghost. Stated on the HUD subtitle.
   *  4 s is the winnability tuning (see the pace-curve comment below): one
   *  miss on an ordinary run survives, two misses lose it. */
  penaltyS: 4,
};

/**
 * Kjell's ghost, as a pace down the fall line (metres of z per second).
 * A skier accelerates through a course, so the curve builds.
 *
 * The tuning, stated so it is auditable. Integrated over the 102 m of fall
 * line this curve is (102/2.0)*ln(5.2/3.2) ≈ 24.8 s. A real descent that
 * actually threads gates was measured at ~15-25 s (the board cruises at
 * 14 m/s but the slalom line is longer than the fall line and turning costs
 * grip), call an ordinary run ~18-20 s. Each missed gate hands the ghost
 * `penaltyS` = 4 s of extra running, so:
 *
 *   0 misses  -> ghost home in ~24.8 s -> an ordinary run wins by ~5-7 s
 *   1 miss    -> ~20.8 s              -> an ordinary run still wins, barely
 *   2 misses  -> ~16.8 s              -> an ordinary run LOSES
 *   3+ misses -> ~12.8 s or better    -> only a boosted flier saves it
 *
 * Which is the brief verbatim: take most of the gates and you win; miss two
 * or more and you lose; boost is how you win comfortably.
 */
const RIVAL_ZPACE_START = 3.2;
const RIVAL_ZPACE_END = 5.2;

/** Seconds before the whole contest (approach included) is called off. */
const TIME_LIMIT_S = 240;

/** Seconds a gate verdict stays on the banner. */
const FLASH_S = 2.0;

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

/** World x of the middle piste's groomed centreline at z. */
export function pisteCentreX(z) {
  const c = SKI_COURSE;
  return c.laneX + Math.sin((z + c.weaveZOff) * c.weaveFreq + c.weavePhase) * c.weaveAmp;
}

/**
 * The slalom gates, laid on the weaving centreline.
 *
 * @param {((x:number, z:number)=>number)|null} heightFn the world's own snow
 *   field; when absent (tests without a world) gate y is 0 and the vertical
 *   acceptance is disabled by the caller.
 * @returns {Array<{i:number, x:number, z:number, side:number, y:number}>}
 */
export function gateCourse(heightFn = null) {
  const c = SKI_COURSE;
  const gates = [];
  for (let i = 0; i < c.gateCount; i++) {
    const z = c.gateZ0 + i * c.gateSpacing;
    const side = i % 2 === 0 ? -1 : 1;
    const x = pisteCentreX(z) + side * c.gateOffset;
    gates.push({ i, x, z, side, y: heightFn ? heightFn(x, z) : 0 });
  }
  return gates;
}

export class SkiRun {
  /**
   * @param {object} venue validated descriptor from MinigameManager
   * @param {{player:any, bus:any, input?:any, mounts?:any, worldManager?:any,
   *          npcs?:any, engine?:any, factory?:any}} ctx
   *   `mounts` and `worldManager` are merged in by main.js's registerGame
   *   closure - the manager itself only supplies player/bus/input. `npcs`
   *   (or an explicit `factory`) lends the shared humanoid factory for the
   *   rival's body; absent, the player's own avatar factory stands in.
   */
  constructor(venue, ctx = {}) {
    const { player, bus, mounts, worldManager } = ctx;
    this.id = SKI_GAME_ID;
    this.venue = venue;
    this.player = player;
    this.bus = bus ?? null;
    this.rivalName = venue?.rival?.name ?? 'the pacesetter';

    const cfg = venue?.config ?? {};
    /** The world's own snow field. See the header - never restated here. */
    this.heightFn = typeof cfg.heightFn === 'function' ? cfg.heightFn : null;
    this._yGate = this.heightFn ? SKI_COURSE.gateYGate : Infinity;

    this.gates = gateCourse(this.heightFn);
    this.courseLen = SKI_COURSE.finishZ - SKI_COURSE.startZ;
    this._startX = pisteCentreX(SKI_COURSE.startZ);
    this._startY = this.heightFn ? this.heightFn(this._startX, SKI_COURSE.startZ) : null;

    /** 'approach' until the start line is crossed downhill, then 'racing'. */
    this.phase = 'approach';
    /** Race clock. Runs only while racing. */
    this.clock = 0;
    /** Index of the armed gate. Gates resolve strictly in order. */
    this._gate = 0;
    this.passed = 0;
    this.missed = 0;
    /** Seconds of penalty accrued - `missed * penaltyS`, kept for the HUD. */
    this.penalty = 0;
    /** Furthest z reached while racing - progress is monotonic, like a leg. */
    this._maxZ = SKI_COURSE.startZ;
    /** Previous fixed-step position, for the swept tests. null = not primed. */
    this._px = null;
    this._pz = null;
    /** Ghost's metres of fall line covered. */
    this._rivalDist = 0;
    this._rivalDone = false;
    this._flash = null;
    this._finished = false;
    this._cleaned = false;

    /* ---- the board ----
     * Summoned NOW, on accept, so the countdown is spent already mounted.
     * The toggle guard is load-bearing: `summon` dismisses the mount the
     * player is already riding. */
    this._mounts = mounts ?? null;
    this._weMounted = false;
    if (this._mounts && this._mounts.active?.id !== 'hoverboard') {
      try {
        this._weMounted = this._mounts.summon('hoverboard') === true;
      } catch (err) {
        console.warn('[ski] hoverboard summon failed:', err?.message ?? err);
        this._weMounted = false;
      }
    }

    /* ---- gate poles ----
     * Real objects in the world group while the run is live, removed on
     * cleanup. Built only when there is both a group to hold them and a
     * height field to seat them on - a headless test has neither. */
    this._gfx = null;
    const host = cfg.group ?? worldManager?.active?.group ?? null;
    if (host && typeof host.add === 'function' && this.heightFn) {
      this._buildGates(host);
    }

    /* ---- the start position ----------------------------------------
     * The factory runs during the countdown, so the placement is what makes
     * the countdown show the run laid out below the start gate. */
    this._placeAtStart();

    /* ---- the visible rival ------------------------------------------
     * Kjell's ghost gets a body when there is a group to hold it, a height
     * field to seat it on and a factory to loft it; a headless test has none
     * of those and races the readout alone, exactly as before. */
    this._ghost = null;
    this._offFrame = null;
    this._ghostPrev = null;
    this._buildGhost(ctx, host && typeof host.add === 'function' ? host : null);
  }

  /**
   * Stand the run's opening shot: the MOUNT is moved to just above the start
   * line, facing downhill, so the countdown shows the course laid out below.
   * While mounted the mount owns position (measured; teleporting the player
   * snaps back), so the BOARD is what gets placed — the seat carries the
   * rider on the next fixed step. Every write is feature-tested because the
   * headless double is a bare `{id, canDismount}`.
   */
  _placeAtStart() {
    const c = SKI_COURSE;
    const gz = c.startZ - 4; // a board-length or two above the line, ready to cross
    const gx = pisteCentreX(gz);
    const gy = this.heightFn ? this.heightFn(gx, gz) : null;
    const m = this._mounts?.active;
    if (m?.id === 'hoverboard' && typeof m.position?.set === 'function') {
      m.position.set(gx, (gy ?? m.position.y) + 0.5, gz);
      // Forward is (-sin yaw, 0, -cos yaw); PI faces +z — downhill.
      if (typeof m.heading === 'number') m.heading = Math.PI;
      m.velocity?.set?.(0, 0, 0);
      if (typeof m.speed === 'number') m.speed = 0;
      m.root?.position?.copy?.(m.position);
      if (m.root?.rotation) m.root.rotation.y = Math.PI;
      /* NOT player.teleport: it clears movementOverride, which is the mount's
       * seat authority. The seat carries the player to the board on the next
       * fixed step; only the camera boom needs telling, or it sweeps the
       * whole venue between the old position and the summit. */
      this.player?.cameraRig?.snap?.();
    } else if (gy !== null && typeof this.player?.teleport === 'function') {
      // No board (summon refused / world forbids mounts): the run is still
      // startable on foot, so the skier is still placed at the gate.
      this.player.teleport(new THREE.Vector3(gx, gy + 0.3, gz), Math.PI);
    }
  }

  /** Loft the rival's body and hook its animation to the frame tick. */
  _buildGhost(ctx, host) {
    if (!host || !this.heightFn) return;
    const factory =
      ctx?.factory ??
      ctx?.npcs?.factory ??
      globalThis.GAME?.npcManager?.factory ??
      this.player?.avatar?.factory ??
      null;
    this._ghost = GhostCompetitor.create({
      group: host,
      physics: this.player?.physics ?? null,
      factory,
      name: this.rivalName,
      tint: 0xf47a1f,
      seed: 71333,
      theme: 'sports',
    });
    if (!this._ghost) return;
    this._ghost.setPose('board');
    this._syncGhost();
    const engine = ctx?.engine ?? this.player?.engine ?? null;
    // Registered at match start: runs after the animators, reads no input.
    this._offFrame = engine?.onFrameUpdate?.((dt, elapsed) => this._ghost?.update(dt, elapsed)) ?? null;
  }

  /**
   * The rival's racing line in x: the groomed centreline plus a cosine weave
   * that passes dead-centre through every gate (gate i sits at
   * side (-1)^(i+1) * gateOffset, gates every gateSpacing metres — one half
   * cosine period per gate is exactly that alternation). The weave fades in
   * before gate 1 and out after the last, so he lines up straight at the
   * start gate and the finish.
   */
  _slalomX(z) {
    const c = SKI_COURSE;
    const u = (z - c.gateZ0) / c.gateSpacing;
    const fade = clamp01(Math.min(u + 1, c.gateCount - u));
    return pisteCentreX(z) - Math.cos(Math.PI * u) * c.gateOffset * fade;
  }

  /**
   * Put the body exactly at the fall-line distance the pace logic reports —
   * the same `rivalDist` the RIVAL row prints, so they can never disagree.
   * y comes from the venue's own height field: he rides the snow.
   */
  _syncGhost() {
    const g = this._ghost;
    if (!g) return;
    const racing = this.phase === 'racing';
    const d = this.rivalDist;
    const z = racing || d > 0 ? SKI_COURSE.startZ + d : SKI_COURSE.startZ;
    // Waiting, he stands beside the start gate rather than inside the
    // player's line through it.
    const x = racing || d > 0 ? this._slalomX(z) : pisteCentreX(SKI_COURSE.startZ) + 2.6;
    const y = this.heightFn(x, z) + 0.55;

    let heading = Math.PI;
    if (this._ghostPrev) {
      const dx = x - this._ghostPrev.x;
      const dz = z - this._ghostPrev.z;
      if (dx * dx + dz * dz > 1e-8) heading = Math.atan2(-dx, -dz);
      else heading = this._ghostPrev.h;
    }
    this._ghostPrev = { x, z, h: heading };

    g.place({ x, y, z }, heading);
    const u = clamp01(d / this.courseLen);
    g.setSpeedForAnim(
      racing && !this._rivalDone
        ? RIVAL_ZPACE_START + (RIVAL_ZPACE_END - RIVAL_ZPACE_START) * u
        : 0
    );
  }

  /** Seconds of "racers ready". Read by the manager. */
  get countdown() {
    return 4.0;
  }

  /** Called the instant the countdown expires. */
  begin() {
    this.phase = 'approach';
    this.clock = 0;
    this._gate = 0;
    this.passed = 0;
    this.missed = 0;
    this.penalty = 0;
    this._maxZ = SKI_COURSE.startZ;
    this._px = null;
    this._pz = null;
    this._rivalDist = 0;
    this._rivalDone = false;
    this._flash = null;
    this._ghostPrev = null;
    this._syncGhost();
  }

  /** Metres of fall line the ghost has covered. */
  get rivalDist() {
    return Math.min(this._rivalDist, this.courseLen);
  }

  /** Metres of fall line the player has covered. */
  get playerDist() {
    return clamp01((this._maxZ - SKI_COURSE.startZ) / this.courseLen) * this.courseLen;
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

    if (this.phase === 'approach') {
      /* The run arms on a DOWNHILL crossing of the start line, inside its
       * lateral band and at snow height. Riding up past it does not fire
       * (prev is below the line), and a dragon over the summit does not
       * either - the y check rejects altitude. Until then nothing runs, so
       * the climb costs the player only their patience, exactly like the
       * swim's approach to the start wall. */
      const crossed =
        this._pz <= SKI_COURSE.startZ &&
        p.z >= SKI_COURSE.startZ &&
        Math.abs(p.x - this._startX) <= SKI_COURSE.startHalf &&
        (this._startY === null || Math.abs(p.y - this._startY) <= 14);
      this._px = p.x;
      this._pz = p.z;
      if (crossed) {
        this.phase = 'racing';
        this.clock = 0;
        this._maxZ = p.z;
        this.bus?.emit('minigame:event', { gameId: this.id, kind: 'off', text: 'GO' });
      }
      // The rival's body waits at the gate while nothing is armed.
      this._syncGhost();
      // The time limit covers the approach too, or a player who never climbs
      // leaves a contest running until they walk off the mound.
      if (elapsed >= TIME_LIMIT_S) return this._lose('time');
      return null;
    }

    this.clock += dt;
    this._advanceRival(dt);
    if (p.z > this._maxZ) this._maxZ = p.z;

    /* Gates resolve strictly in order against the segment travelled this
     * step. The loop re-tests the SAME segment after each resolution, so a
     * stalled tab's one enormous step can pass (or miss) several gates
     * rather than silently skipping the course. */
    let guard = this.gates.length + 1;
    while (this._gate < this.gates.length && guard-- > 0) {
      const g = this.gates[this._gate];
      const d2 = segDistSq(this._px, this._pz, p.x, p.z, g.x, g.z);
      if (d2 <= SKI_COURSE.gateRadius * SKI_COURSE.gateRadius
          && Math.abs(p.y - g.y) <= this._yGate) {
        this._passGate(g);
        continue;
      }
      if (p.z > g.z + SKI_COURSE.missMargin) {
        this._missGate(g);
        continue;
      }
      break;
    }
    this._px = p.x;
    this._pz = p.z;

    /* The body rides the SAME number the readout shows — synced AFTER the
     * gate loop, because a miss credits the ghost inside it and a body synced
     * before the credit would lag the readout for a step. */
    this._syncGhost();

    if (p.z >= SKI_COURSE.finishZ) {
      // Gates still armed at the flag were skipped: each is a miss, each
      // hands the ghost its seconds, and THEN the line call is made - so
      // straight-lining the course is a strategy the ghost gets paid for.
      while (this._gate < this.gates.length) this._missGate(this.gates[this._gate]);
      return this._rivalDone ? this._lose('rival') : this._win();
    }

    if (this._rivalDone) return this._lose('rival');
    if (elapsed >= TIME_LIMIT_S) return this._lose('time');
    return null;
  }

  /**
   * Move the ghost down the fall line.
   *
   * Distance-driven, like the swim's: the pace is a property of the course,
   * not of how long the player has taken to get anywhere.
   */
  _advanceRival(dt) {
    if (this._rivalDone) return;
    const u = clamp01(this._rivalDist / this.courseLen);
    this._rivalDist += (RIVAL_ZPACE_START + (RIVAL_ZPACE_END - RIVAL_ZPACE_START) * u) * dt;
    if (this._rivalDist >= this.courseLen) {
      this._rivalDist = this.courseLen;
      this._rivalDone = true;
    }
  }

  /**
   * Hand the ghost extra seconds of running - the price of a missed gate.
   * Integrated through the same pace curve in small steps, so a penalty is
   * worth exactly what those seconds of skiing would have been.
   */
  _creditRival(seconds) {
    let t = seconds;
    while (t > 0 && !this._rivalDone) {
      const step = Math.min(0.25, t);
      this._advanceRival(step);
      t -= step;
    }
  }

  _passGate(g) {
    this._gate += 1;
    this.passed += 1;
    this._flash = null;
    this.bus?.emit('minigame:event', {
      gameId: this.id,
      kind: 'split',
      text: `GATE ${g.i + 1}/${this.gates.length} — ${clockText(this.clock)}`,
    });
  }

  _missGate(g) {
    this._gate += 1;
    this.missed += 1;
    this.penalty += SKI_COURSE.penaltyS;
    this._creditRival(SKI_COURSE.penaltyS);
    this._flash = {
      text: `GATE ${g.i + 1} MISSED — +${SKI_COURSE.penaltyS}s`,
      until: this.clock + FLASH_S,
    };
    this.bus?.emit('minigame:event', {
      gameId: this.id,
      kind: 'miss',
      text: this._flash.text,
    });
  }

  _win() {
    this._finished = true;
    this._cleanup();
    const total = this.clock + this.penalty;
    return {
      won: true,
      place: 1,
      total: 2,
      score: total,
      scoreLabel: clockText(total),
      rivalName: this.rivalName,
      detail: {
        gates: this.gates.length,
        passed: this.passed,
        missed: this.missed,
        penaltySeconds: this.penalty,
        run: this.clock,
        course: this.courseLen,
      },
    };
  }

  /** @param {'rival'|'time'} why */
  _lose(why) {
    this._finished = true;
    this._cleanup();
    const total = this.clock + this.penalty;
    return {
      won: false,
      place: 2,
      total: 2,
      score: total,
      scoreLabel: why === 'time' ? 'Timed out' : clockText(total),
      rivalName: why === 'time' ? null : this.rivalName,
      detail: {
        reason: why,
        gates: this.gates.length,
        passed: this.passed,
        missed: this.missed,
        penaltySeconds: this.penalty,
        progress: this.playerDist,
      },
    };
  }

  /**
   * The live readout, as generic rows the minigame HUD renders without
   * knowing what a gate is. The 2 s penalty rule is stated on the subtitle,
   * as asked.
   */
  snapshot() {
    const racing = this.phase === 'racing';
    const n = this.gates.length;
    const gap = this.playerDist - this.rivalDist;
    const mounted = this._mounts?.active?.id === 'hoverboard';
    const flash = this._flash && this.clock < this._flash.until ? this._flash.text : null;
    const rows = [
      { k: 'GATE', v: `${Math.min(this._gate + (racing ? 1 : 0), n)}/${n}` },
      { k: 'TIME', v: racing ? (clockText(this.clock) === '—' ? '0:00.00' : clockText(this.clock)) : '0:00.00' },
      {
        k: 'PENALTY',
        v: this.missed ? `+${this.penalty.toFixed(0)}s · ${this.missed} missed` : 'none',
        dim: !this.missed,
        tone: this.missed ? 'warn' : null,
      },
      {
        k: 'RIVAL',
        v: racing ? `${gap >= 0 ? '+' : ''}${gap.toFixed(1)} m` : '—',
        tone: !racing ? null : gap >= 0 ? 'good' : 'warn',
      },
    ];
    return {
      rows,
      progress: clamp01(this.playerDist / this.courseLen),
      rivalProgress: clamp01(this.rivalDist / this.courseLen),
      banner: racing
        ? flash
        : mounted
          ? 'RIDE DOWN THROUGH THE START GATE AT THE SUMMIT'
          : 'GET TO THE SUMMIT START GATE',
      subtitle: `${n} gates · missed gate +${SKI_COURSE.penaltyS}s · racing ${this.rivalName}`,
    };
  }

  /** Called by the manager on abort and world change. Idempotent. */
  dispose() {
    this._cleanup();
  }

  /* ================================================================ */
  /* Private                                                           */
  /* ================================================================ */

  /**
   * Two poles per gate plus a start and a finish pair, every one seated on
   * the snow by the world's own height field - at the POLE's x, not the
   * gate's, because 3.2 m of groomed piste still falls a few centimetres.
   */
  _buildGates(host) {
    const group = new THREE.Group();
    group.name = 'minigame:ski-gates';
    const poleGeo = new THREE.CylinderGeometry(0.045, 0.06, 2.0, 6).translate(0, 1.0, 0);
    const lineGeo = new THREE.CylinderGeometry(0.06, 0.075, 2.8, 6).translate(0, 1.4, 0);
    // Same palette as the decorative slalom on the west lane, so the live
    // course reads as course furniture rather than debug markers.
    const red = new THREE.MeshStandardMaterial({ color: 0xd2262c, roughness: 0.5 });
    const blue = new THREE.MeshStandardMaterial({ color: 0x1f5fd0, roughness: 0.5 });
    const orange = new THREE.MeshStandardMaterial({ color: 0xf47a1f, roughness: 0.6 });

    const pole = (geo, mat, x, z) => {
      const m = new THREE.Mesh(geo, mat);
      m.position.set(x, this.heightFn(x, z), z);
      group.add(m);
    };
    for (const g of this.gates) {
      const mat = g.i % 2 ? blue : red;
      pole(poleGeo, mat, g.x - SKI_COURSE.gateHalf, g.z);
      pole(poleGeo, mat, g.x + SKI_COURSE.gateHalf, g.z);
    }
    pole(lineGeo, orange, this._startX - 5, SKI_COURSE.startZ);
    pole(lineGeo, orange, this._startX + 5, SKI_COURSE.startZ);
    const fx = pisteCentreX(SKI_COURSE.finishZ);
    pole(lineGeo, orange, fx - 6, SKI_COURSE.finishZ);
    pole(lineGeo, orange, fx + 6, SKI_COURSE.finishZ);

    host.add(group);
    this._gfx = { group, geos: [poleGeo, lineGeo], mats: [red, blue, orange] };
  }

  /**
   * Tear down everything this module put into the world: the gate furniture,
   * and the mount IF this module was the one that summoned it. Runs on win,
   * loss, abort and world change; the flag makes repeats free.
   */
  _cleanup() {
    if (this._cleaned) return;
    this._cleaned = true;

    if (this._offFrame) {
      try {
        this._offFrame();
      } catch {
        /* engine already gone */
      }
      this._offFrame = null;
    }
    this._ghost?.dispose?.();
    this._ghost = null;

    if (this._gfx) {
      this._gfx.group.removeFromParent();
      for (const g of this._gfx.geos) g.dispose();
      for (const m of this._gfx.mats) m.dispose();
      this._gfx = null;
    }

    /* A player who brought their own board keeps riding it - taking it away
     * at the flag would undo a choice this module never made. `canDismount`
     * is honoured (the board refuses above 2.2 m of air); a rider the board
     * will not release simply stays on and steps off with F. On a world
     * change MountManager.clear() has usually emptied the seat before this
     * runs, and the no-op is the correct result. */
    const m = this._mounts;
    const active = m?.active;
    if (this._weMounted && active?.id === 'hoverboard' && (active.canDismount?.() ?? true)) {
      try {
        m.dismount();
      } catch {
        /* never let cleanup throw into the manager */
      }
    }
  }
}

/**
 * Factory registered against the `ski` venue kind.
 * @param {object} venue
 * @param {{player:any, bus:any, input?:any, mounts?:any, worldManager?:any}} ctx
 */
export function createSkiRun(venue, ctx) {
  return new SkiRun(venue, ctx);
}

export default SkiRun;
