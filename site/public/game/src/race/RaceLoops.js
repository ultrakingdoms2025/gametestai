import * as THREE from 'three';

/**
 * The 360° loop: who is on it, and where that puts them.
 *
 * ── Why a loop is a rail and not a road ──────────────────────────────────────
 *
 * Every drivable surface in this game is a height function - one ground height
 * per (x, z) - and every vehicle reads it the same way: probe downward, sit on
 * what you find. `Car` does it four times a frame, once per wheel. That model
 * is what makes the cars cheap and the terrain and its collision impossible to
 * disagree; it is also, exactly, why it cannot drive a loop. Over the point
 * below the apex there are two surfaces and the probe has to pick one, and at
 * the apex the surface the car is on is *above* it and gravity is pointing the
 * wrong way.
 *
 * The honest alternative is a full rigid body with surface-relative gravity,
 * and it would mean rewriting the driving model that five worlds are tuned
 * around, to make one set piece work. So the loop is a rail instead: for the
 * two seconds a car is on it, nothing simulates. Position and attitude are
 * read off a curve, and at the far end the car is handed back to physics
 * pointing the way it came in and carrying the speed it arrived with.
 *
 * That is not a shortcut around a hard problem so much as the arcade answer to
 * it - it is how loops in racing games have always worked, and it is the only
 * version where the car cannot fall off, cannot get stuck upside down at the
 * top, and cannot arrive at the exit facing backwards.
 *
 * ── What it guarantees ───────────────────────────────────────────────────────
 *
 * Entry is *unconditional*. Anything that crosses the entry gate on the road
 * goes round, however slowly it was going: there is no "too slow" state,
 * because the alternative to going round is driving through a ramp with no
 * collision on it, which looks like a bug whatever the reason for it. A car
 * that arrives at a crawl is carried at {@link minSpeed} so the loop still
 * looks like a loop, and gets its own speed back at the exit - it is a rail,
 * not a gift.
 *
 * The lap requirement is enforced elsewhere and by geometry rather than by
 * bookkeeping: the circuit's checkpoint list has one at the apex, 30 m up, with
 * a vertical gate the loop's own radius. Nothing that stayed on the tarmac can
 * validate it. See RaceWorld._fillCircuit.
 */

const TAU = Math.PI * 2;

const _p = new THREE.Vector3();
const _seat = new THREE.Vector3();

/** Speed below which the rail carries a car anyway, m/s. */
export const MIN_LOOP_SPEED = 19;

/**
 * One loop's geometry, evaluated.
 *
 * Mirrors RaceWorld._buildLoop exactly - same curve, same convention - because
 * the mesh a player can see and the rail they ride have to be the same shape to
 * within nothing at all. Both are derived from the same published numbers
 * rather than one calling the other, so a world that failed to build its loop
 * geometry cannot leave a rail behind pointing at nothing.
 */
export class Loop {
  /** @param {object} spec as published by RaceWorld (see `_buildLoop`) */
  constructor(spec) {
    this.spec = spec;
    this.trackId = spec.trackId;
    this.radius = spec.radius;
    this.width = spec.width;
    this.length3d = spec.length3d || spec.radius * TAU;
    this.minSpeed = spec.minSpeed ?? MIN_LOOP_SPEED;
    this.entry = new THREE.Vector3(spec.entry.x, spec.entry.y, spec.entry.z);
    this.exit = new THREE.Vector3(spec.exit.x, spec.exit.y, spec.exit.z);
    this.forward = new THREE.Vector2(spec.forward.x, spec.forward.z);
    this.apex = new THREE.Vector3(spec.apex.x, spec.apex.y, spec.apex.z);
    /** Heading a car leaves with, in the game's -Z-at-yaw-0 convention. */
    this.heading = Math.atan2(-this.forward.x, -this.forward.y);
    /** Half-width of the gate at the entry. Wider than the road: missing the
     *  loop because you were a metre off line is not a skill test. */
    this.gate = spec.width * 0.5 + 4;
  }

  /**
   * Rail point at `u` in 0..1.
   * @param {number} u
   * @param {THREE.Vector3} out
   */
  pointAt(u, out) {
    const th = u * TAU;
    out.copy(this.entry).lerp(this.exit, u);
    out.x += this.forward.x * (this.radius * Math.sin(th));
    out.z += this.forward.y * (this.radius * Math.sin(th));
    out.y += this.radius * (1 - Math.cos(th));
    return out;
  }

  /**
   * Body pitch at `u`, radians, nose-up positive.
   *
   * The circle angle, not the tangent of the rail. The tangent at the apex is
   * horizontal - follow it and the car crosses the top the right way up, which
   * is the one thing a loop must not look like.
   */
  pitchAt(u) {
    return u * TAU;
  }

  /**
   * Has something just driven into the entry gate?
   *
   * A swept test against the segment travelled this step, like every other gate
   * in the race code: at 34 m/s a fixed step covers half a metre, so a point
   * test would work today and would silently start missing the loop the first
   * time somebody added a faster mount.
   *
   * @param {number} x0 @param {number} z0 previous position
   * @param {number} x1 @param {number} z1 current position
   * @param {number} y  current height, to reject anything already airborne
   * @returns {boolean}
   */
  crossed(x0, z0, x1, z1, y) {
    // In front of the entry plane at the end of the step, behind it at the
    // start: that is a crossing, in the right direction, exactly once.
    const f = this.forward;
    const before = (x0 - this.entry.x) * f.x + (z0 - this.entry.z) * f.y;
    const after = (x1 - this.entry.x) * f.x + (z1 - this.entry.z) * f.y;
    if (!(before < 0 && after >= 0)) return false;
    // Across the road, not past the end of the gate.
    const lat = -(x1 - this.entry.x) * f.y + (z1 - this.entry.z) * f.x;
    if (Math.abs(lat) > this.gate) return false;
    // On the ground. Something 20 m up is not entering a loop, it is a dragon.
    return Math.abs(y - this.entry.y) < 6;
  }
}

/**
 * Every loop in the world, and every racer currently going round one.
 *
 * Owned by RaceManager and ticked from its fixed step, after the field has
 * moved and before the race is scored - so a car on the rail is scored at the
 * position the rail put it, which is what lets the apex checkpoint fire.
 */
export class RaceLoops {
  /** @param {{bus?:any, physics?:any, player?:any, mounts?:any}} ctx */
  constructor({ bus = null, physics = null, player = null, mounts = null } = {}) {
    this.bus = bus;
    this.physics = physics;
    this.player = player;
    this.mounts = mounts;
    /** @type {Loop[]} */
    this.loops = [];
    /** id -> {loop, u, speed, entrySpeed} @type {Map<string, object>} */
    this.riders = new Map();
  }

  get active() {
    return this.riders.size > 0;
  }

  /** True while this racer is on a rail and its own movement must be ignored. */
  isRailed(id) {
    return this.riders.has(id);
  }

  /**
   * Adopt the loops a world publishes.
   * @param {Array<object>|null} specs
   */
  setLoops(specs) {
    // The method, not the Map's: adopting a new world's loops while something
    // is still going round an old one has to hand that car back its physics.
    this.clear();
    this.loops = Array.isArray(specs) ? specs.filter(Boolean).map((s) => new Loop(s)) : [];
  }

  /**
   * Take everything off the rail, now, and give it back its own physics.
   *
   * Dropping the riders is not enough on its own. `railed` is what tells `Car`
   * and `RacerAI` to stop simulating, and nothing else ever clears it - so a
   * player who presses dismount halfway up the loop, or a race abandoned from
   * the pause menu at the same moment, would leave a car that has been told to
   * hold still with nobody left to move it. It would hang there for the rest of
   * the session. So the flag is cleared from the record of who was railed,
   * rather than from whatever happens to be the active mount now, which by then
   * may be a horse.
   */
  clear() {
    for (const rider of this.riders.values()) {
      const ref = rider.mount ?? rider.ref;
      if (!ref) continue;
      ref.railed = false;
      ref._pitch = 0;
      ref._pitchTarget = 0;
      ref._roll = 0;
      ref._vy = 0;
      if (rider.ref && rider.ref !== ref) rider.ref.railed = false;
    }
    this.riders.clear();
  }

  /**
   * One fixed step.
   *
   * @param {number} dt
   * @param {Array<object>} entries every racer, player included. Each carries
   *   `id`, `position`, `speed`, and for the AI its own `s` along the path.
   * @param {object|null} playerMount the car, when the player is in one
   * @param {import('./RacerAI.js').TrackPath|null} path the armed circuit's
   *   path, used to keep a railed AI's lap distance in step with the rail
   */
  fixedUpdate(dt, entries, playerMount, path = null) {
    if (!this.loops.length || !entries?.length) return;

    for (const e of entries) {
      const rider = this.riders.get(e.id);
      if (rider) {
        this._advance(rider, e, dt, playerMount);
        continue;
      }
      // `_px`/`_pz` are last step's position, kept by RaceManager for its own
      // swept checkpoint test; reusing them keeps the two tests in step.
      const x0 = e._px ?? e.position.x;
      const z0 = e._pz ?? e.position.z;
      for (const loop of this.loops) {
        if (!loop.crossed(x0, z0, e.position.x, e.position.z, e.position.y)) continue;
        this._latch(loop, e, playerMount, path);
        break;
      }
    }
  }

  /** @private */
  _latch(loop, e, playerMount, path) {
    const entrySpeed = Math.abs(e.speed ?? 0);
    const rider = {
      loop,
      u: 0,
      entrySpeed,
      speed: Math.max(entrySpeed, loop.minSpeed),
      isPlayer: !!e.isPlayer,
      sIn: 0,
      sSpan: 0,
      // Held so `clear` can un-rail whatever was actually railed, even if the
      // player has since dismounted and `mounts.active` is something else.
      ref: e,
      mount: e.isPlayer ? playerMount : e,
    };
    /* Lap distance for the AI, projected onto *this* path rather than taken
     * from the world's own arc length.
     *
     * The two are within a per-cent of each other - the published centreline is
     * decimated to 6 m and chords the corners slightly - and a per-cent of a
     * lap is 12 m, which is enough to hand a car the wrong side of a checkpoint
     * when it comes off the rail. Projecting removes the question. */
    if (path?.valid) {
      const a = path.project(loop.entry.x, loop.entry.z, -1);
      const b = path.project(loop.exit.x, loop.exit.z, -1);
      rider.sIn = a;
      // Signed and wrapped, so a loop that straddles the start/finish line does
      // not send a car the long way round the lap in two seconds.
      rider.sSpan = path.delta(b, a);
    }
    this.riders.set(e.id, rider);
    if (e.isPlayer) {
      this.bus?.emit('race:loop', { state: 'enter', speed: entrySpeed });
      // The mount stops driving itself for the duration. Without this its own
      // ground probes fight the rail for `position.y` every step and the car
      // stutters up the inside of the loop.
      if (playerMount) playerMount.railed = true;
    } else {
      // Same flag, same reason - see RacerAI.fixedUpdate.
      e.railed = true;
    }
  }

  /** @private */
  _advance(rider, e, dt, playerMount) {
    const loop = rider.loop;
    rider.u += (rider.speed * dt) / loop.length3d;

    if (rider.u >= 1) {
      rider.u = 1;
      this.riders.delete(e.id);
      loop.pointAt(1, _p);
      this._place(e, _p, loop.heading, 0, rider, playerMount);
      if (!e.isPlayer) e.railed = false;
      if (e.isPlayer) {
        if (playerMount) {
          playerMount.railed = false;
          // Handed back with the speed it arrived with, not the rail's. The
          // loop is a thing to get over, not a boost pad.
          playerMount.speed = rider.entrySpeed;
          playerMount.velocity?.set?.(
            -Math.sin(loop.heading) * rider.entrySpeed, 0,
            -Math.cos(loop.heading) * rider.entrySpeed
          );
          playerMount._vy = 0;
          playerMount._pitch = 0;
          playerMount._pitchTarget = 0;
          playerMount._airborne = false;
        }
        this.bus?.emit('race:loop', { state: 'exit', speed: rider.entrySpeed });
      }
      return;
    }

    loop.pointAt(rider.u, _p);
    this._place(e, _p, loop.heading, loop.pitchAt(rider.u), rider, playerMount);
  }

  /**
   * Write one racer onto the rail.
   * @private
   */
  _place(e, pos, heading, pitch, rider, playerMount) {
    if (rider.isPlayer) {
      const mount = playerMount;
      if (mount) {
        mount.position.copy(pos);
        mount.heading = heading;
        mount.speed = rider.speed;
        mount._vy = 0;
        mount._airborne = false;
        mount._groundY = pos.y;
        mount.velocity?.set?.(0, 0, 0);
        /* Written after the mount's own fixed step has already damped these
         * toward the ground it thinks it is on - see the order in main.js. A
         * damped write would take half the loop to reach the top and would
         * never reach 2π at all. */
        mount._pitch = pitch;
        mount._pitchTarget = pitch;
        mount._roll = 0;
        mount._rollTarget = 0;
        mount.getSeat?.(_seat);
        if (this.player?.position) this.player.position.copy(_seat);
        this.player?.setYaw?.(heading);
      } else if (this.player?.position) {
        this.player.position.copy(pos);
      }
      // The entry's own position is the player's, by reference, in RaceManager.
      if (e.position !== this.player?.position) e.position.copy(pos);
    } else {
      e.position.copy(pos);
      e.heading = heading;
      e._pitch = pitch;
      e._roll = 0;
      e.lateral = 0;
      // Lap distance tracks the rail rather than the ground the car is over:
      // 34 m of road takes 97 m of rail, and a car scored on the rail's length
      // would gain 60 m on the field for going round.
      if (rider.sSpan) e.s = rider.sIn + rider.sSpan * rider.u;
      e._writeTransform?.();
    }
    e.speed = rider.speed;
  }
}

export default RaceLoops;
