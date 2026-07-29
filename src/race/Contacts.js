/**
 * Car-to-car contact.
 *
 * ── Why this is not the physics world ─────────────────────────────────────
 *
 * The rivals are kinematic followers (see RacerAI): they own a distance along
 * the centreline and a lateral offset, and they have no colliders at all. That
 * is the right model for driving - the track is the constraint, so they cannot
 * leave it and no broadphase work is needed to guarantee it - but it means the
 * player drives straight through them, because as far as the collision world is
 * concerned they are not there.
 *
 * Giving them real colliders would be the expensive fix. Ten cars moving at
 * 34 m/s would have to be reinserted into the broadphase grid every step, and
 * the player's car resolves three capsules against every collider it overlaps,
 * so rivals would start scrubbing the player's speed through the same path that
 * treats a wall as a wall. What is actually wanted is much narrower: ten cars
 * against one another, once per step, with a response that puts the rival back
 * on its rails rather than pushing it into the scenery.
 *
 * So this is a dedicated pass over the field. Each car is a capsule in plan -
 * a segment along its own heading with a radius - which is what distinguishes
 * a side-by-side rub from a nose-to-tail shunt. A circle cannot: at these
 * proportions (4.2 m long, 1.9 m wide) a circle either lets cars overlap by
 * a metre when abreast or refuses to let them run side by side at all.
 *
 * ── The response ──────────────────────────────────────────────────────────
 *
 * Separation is split between the pair, then the closing speed along the
 * contact normal is spent: both cars lose speed in proportion to how square the
 * hit was, the player is knocked off line, and the rival is displaced in *track
 * space* rather than world space - its `s` and `lateral` are what it will read
 * back next step, so moving its `position` alone would be undone immediately.
 */

/** Half the contact capsule's length, metres. The bodies are ~4.2 m long. */
const HALF_LEN = 1.15;
/** Contact radius, metres. Two of these give a 1.9 m working width. */
const RADIUS = 0.95;
/** Closing speed below which a touch is a rub, not a crash. */
const CRASH_MPS = 7;
/**
 * Player health per m/s of closing speed above the threshold, and the ceiling
 * on one impact.
 *
 * Ordinary racing contact closes at 5-15 m/s, which lands at 0-9 health - felt,
 * not punishing. Ramming a near-stationary car at full boost closes at 30 and
 * is meant to hurt, but the cap stops a freak number taking a third of the bar
 * in one frame.
 */
const DAMAGE_PER_MPS = 1.15;
const DAMAGE_MAX = 26;
/**
 * Rival damage per m/s over the threshold.
 *
 * Sized so the worst shunt available - full boost into a stopped car - costs
 * about four tenths, which is a rival you have genuinely hurt rather than one
 * you have removed. At the original 0.045 a single hit maxed the scale and took
 * the car out of the race, which made contact a delete button.
 */
const AI_DAMAGE_PER_MPS = 0.018;
/** Seconds a rival is off its pace after being hit hard. */
const STUN_SECONDS = 1.1;
/**
 * Seconds after a scored impact during which the same pair cannot score again.
 *
 * Two cars that hit stay overlapped for several steps while they separate, and
 * without this every one of those steps is a fresh crash: a single shunt
 * measured five impacts, took 15 health off the player and left the rival with
 * 0.76 damage - effectively written off by one nudge. The cooldown is what
 * makes an impact an *event* rather than a state, and turns the steps after it
 * into the rub they actually are.
 */
const HIT_COOLDOWN_S = 0.45;

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);

const _cs = { ax: 0, az: 0, bx: 0, bz: 0 };
const _tp = { x: 0, y: 0, z: 0, width: 12, tx: 0, tz: -1 };

/**
 * Closest points between two 2-D segments.
 *
 * The standard clamped-parametric solution rather than sampling: a shunt at
 * 30 m/s moves a car most of its own length in a step, and a sampled test picks
 * the wrong contact normal exactly when the hit is hardest.
 */
function closestSegSeg(ax0, az0, ax1, az1, bx0, bz0, bx1, bz1, out) {
  const dax = ax1 - ax0;
  const daz = az1 - az0;
  const dbx = bx1 - bx0;
  const dbz = bz1 - bz0;
  const rx = ax0 - bx0;
  const rz = az0 - bz0;
  const a = dax * dax + daz * daz;
  const e = dbx * dbx + dbz * dbz;
  const f = dbx * rx + dbz * rz;
  const c = dax * rx + daz * rz;
  const b = dax * dbx + daz * dbz;
  const denom = a * e - b * b;
  let s = denom > 1e-8 ? clamp01((b * f - c * e) / denom) : 0;
  let t = e > 1e-8 ? (b * s + f) / e : 0;
  if (t < 0) {
    t = 0;
    s = a > 1e-8 ? clamp01(-c / a) : 0;
  } else if (t > 1) {
    t = 1;
    s = a > 1e-8 ? clamp01((b - c) / a) : 0;
  }
  out.ax = ax0 + dax * s;
  out.az = az0 + daz * s;
  out.bx = bx0 + dbx * t;
  out.bz = bz0 + dbz * t;
}

/** Forward vector for a heading. Bodies face -Z at yaw 0, as everything here does. */
function forwardOf(h, out) {
  out.x = -Math.sin(h);
  out.z = -Math.cos(h);
  return out;
}

const _fA = { x: 0, z: 0 };
const _fB = { x: 0, z: 0 };

export class Contacts {
  /** @param {{bus?:any, path:any}} ctx */
  constructor({ bus, path } = {}) {
    this.bus = bus ?? null;
    this.path = path ?? null;
    /** Contacts resolved last step, for diagnostics and tests. */
    this.hits = 0;
    this.lastPlayerHit = 0;
  }

  setPath(path) {
    this.path = path;
  }

  /**
   * One contact pass over the whole field.
   *
   * @param {object|null} car the player's car mount, or null when on foot
   * @param {Array<object>} racers the AI
   * @param {number} dt
   * @param {object|null} player for damage
   */
  resolve(car, racers, dt, player = null) {
    this.hits = 0;
    if (!racers?.length) return 0;

    for (const r of racers) {
      if (r._hitCool > 0) r._hitCool -= dt;
    }

    if (car) {
      for (const r of racers) {
        if (!r.root?.visible) continue;
        this._pair(car, r, dt, player);
      }
    }
    /* Rivals against each other. Cheap - 36 tests for a nine-car field - and
     * without it the pack visibly interpenetrates in the braking zones, which
     * would look worse next to player contact that works. The response is
     * gentler because their steering already tries to keep them apart, and a
     * stiff one fights that and makes the pack oscillate. */
    for (let i = 0; i < racers.length; i++) {
      for (let j = i + 1; j < racers.length; j++) {
        const a = racers[i];
        const b = racers[j];
        if (!a.root?.visible || !b.root?.visible) continue;
        this._pairAI(a, b);
      }
    }
    return this.hits;
  }

  /* ------------------------------------------------------------------ */

  /** Overlap test shared by both pair routines. Returns penetration, or 0. */
  _overlap(ax, az, ah, bx, bz, bh, out) {
    forwardOf(ah, _fA);
    forwardOf(bh, _fB);
    closestSegSeg(
      ax - _fA.x * HALF_LEN, az - _fA.z * HALF_LEN,
      ax + _fA.x * HALF_LEN, az + _fA.z * HALF_LEN,
      bx - _fB.x * HALF_LEN, bz - _fB.z * HALF_LEN,
      bx + _fB.x * HALF_LEN, bz + _fB.z * HALF_LEN,
      _cs
    );
    let dx = _cs.bx - _cs.ax;
    let dz = _cs.bz - _cs.az;
    let d = Math.hypot(dx, dz);
    if (d >= RADIUS * 2) return 0;
    if (d < 1e-5) {
      // Exactly concentric. Push apart along B's right vector rather than a
      // random direction, so a dead-centre overlap resolves sideways like a
      // real one instead of launching a car up the road.
      dx = -_fB.z;
      dz = _fB.x;
      d = 1;
    }
    out.nx = dx / d;
    out.nz = dz / d;
    return RADIUS * 2 - d;
  }

  /** Player car against one rival. */
  _pair(car, ai, dt, player) {
    const n = this._n ?? (this._n = { nx: 0, nz: 0 });
    const pen = this._overlap(car.position.x, car.position.z, car.heading,
      ai.position.x, ai.position.z, ai.heading, n);
    if (pen <= 0) return;
    this.hits++;

    /* Closing speed along the contact normal. Both cars carry their velocity in
     * their own heading, so this is the component of the approach that the
     * contact actually has to absorb - a car alongside at the same speed has
     * almost none of it and should be rubbed, not wrecked. */
    forwardOf(car.heading, _fA);
    forwardOf(ai.heading, _fB);
    const vA = (_fA.x * n.nx + _fA.z * n.nz) * car.speed;
    const vB = (_fB.x * n.nx + _fB.z * n.nz) * ai.speed;
    const closing = vA - vB;

    // The player is the heavier party: they keep more of their line, which is
    // what makes a deliberate shunt feel like it worked.
    this._pushPlayer(car, -n.nx * pen * 0.42, -n.nz * pen * 0.42, player);
    this._pushAI(ai, n.nx * pen * 0.58, n.nz * pen * 0.58);

    if (closing > 0) {
      const square = clamp01(closing / (Math.abs(car.speed) + 4));
      car.speed *= 1 - 0.30 * square;
      ai.speed *= 1 - 0.42 * square;
      // Knocked off line, not just slowed. A contact that only scrubs speed
      // reads as driving into treacle.
      car.heading += n.nx * _fA.z - n.nz * _fA.x > 0 ? -0.10 * square : 0.10 * square;
      ai._lateralTarget += (n.nx * -_fB.z + n.nz * _fB.x) * square * 2.6;

      if (closing > CRASH_MPS && (ai._hitCool ?? 0) <= 0) {
        ai._hitCool = HIT_COOLDOWN_S;
        const sev = closing - CRASH_MPS;
        ai.damage = Math.min(1, (ai.damage ?? 0) + sev * AI_DAMAGE_PER_MPS);
        ai._stunFor = Math.max(ai._stunFor ?? 0, STUN_SECONDS);
        car._onScrape?.(0.5 + square);
        player?.applyDamage?.(Math.min(DAMAGE_MAX, sev * DAMAGE_PER_MPS), ai.position, 'collision');
        this.lastPlayerHit = closing;
        this.bus?.emit('race:contact', {
          id: ai.id,
          name: ai.name,
          closing,
          severity: clamp01(sev / 18),
          x: ai.position.x,
          y: ai.position.y,
          z: ai.position.z,
        });
      }
    }
  }

  /** Rival against rival. Separation only - no damage, no player feedback. */
  _pairAI(a, b) {
    const n = this._n2 ?? (this._n2 = { nx: 0, nz: 0 });
    const pen = this._overlap(a.position.x, a.position.z, a.heading,
      b.position.x, b.position.z, b.heading, n);
    if (pen <= 0) return;
    this.hits++;
    this._pushAI(a, -n.nx * pen * 0.5, -n.nz * pen * 0.5);
    this._pushAI(b, n.nx * pen * 0.5, n.nz * pen * 0.5);
    // The one behind loses out of the exchange, which is what makes a pack
    // stretch under braking rather than pivot around its middle.
    if (a.speed > b.speed) a.speed *= 0.985;
    else b.speed *= 0.985;
  }

  /* ------------------------------------------------------------------ */

  /**
   * The rider moves with the seat.
   *
   * `MountManager` writes the player's position from the car at the top of the
   * next step, so this only closes a one-frame gap - but that frame is the one
   * the race reads for lap progress and pickups, and a rider left standing
   * where the car was is exactly the sort of thing that shows up as a pickup
   * being claimed from the wrong place.
   */
  _pushPlayer(car, dx, dz, player) {
    car.position.x += dx;
    car.position.z += dz;
    if (player?.position) {
      player.position.x += dx;
      player.position.z += dz;
    }
  }

  /**
   * Displace a rival in track space.
   *
   * Its `position` is recomputed from `s` and `lateral` at the top of every
   * step, so writing world coordinates here would be undone before anyone saw
   * it. Decomposing onto the tangent and the normal is what makes the shove
   * persist - and keeps a shunted car on the road rather than beside it.
   */
  _pushAI(ai, dx, dz) {
    const path = this.path ?? ai.path;
    if (!path?.valid) {
      ai.position.x += dx;
      ai.position.z += dz;
      return;
    }
    path.sample(ai.s, _tp);
    const along = dx * _tp.tx + dz * _tp.tz;
    const across = dx * -_tp.tz + dz * _tp.tx;
    ai.s = path.wrap(ai.s + along);
    // Held inside the road: being pushed wide is a punishment, being pushed
    // into the grandstand is a bug.
    const halfRoad = Math.max(1.6, _tp.width * 0.5 - 0.8);
    ai.lateral = Math.max(-halfRoad, Math.min(halfRoad, ai.lateral + across));
    ai.position.x += dx;
    ai.position.z += dz;
  }
}

export default Contacts;
