import * as THREE from 'three';
import { CONFIG } from '../core/Config.js';

/**
 * Leap, dive and roll - and the fall damage that gives them a point.
 *
 * ── Why fall damage had to come with them ─────────────────────────────────
 * There was none. Landing dipped the view and nothing else, which meant a roll
 * would have been a cosmetic animation with no reason to press it, and a
 * haystack would have been scenery. A parkour set is a set of *answers*, so the
 * question has to exist first.
 *
 * It is deliberately generous, because it is being retrofitted into three
 * worlds that were designed without it. Jump apex is 0.93 m and produces about
 * 6.4 m/s, so nothing you can do with the jump key is ever punished; damage
 * starts around a 7 m drop and only becomes lethal past about 36. That leaves
 * ordinary play in the station and the sports park untouched while making the
 * citadel's rooftops mean something.
 *
 * ── The three verbs, and why they share two keys ──────────────────────────
 * No new bindings. Every key in this game is spoken for, and a parkour set that
 * needs three more would not be reachable.
 *
 *   **Leap**   Sprint + jump, running. A flatter, longer jump that clears the
 *              roof gaps the citadel's outer rings are spaced for. Costs
 *              stamina, so it is a decision rather than a default.
 *   **Dive**   Crouch while airborne and falling. Pitches head-first, drops
 *              faster and carries further, and is what lets a leap of faith
 *              actually reach the haystack below a viewpoint.
 *   **Roll**   Crouch as you land. Converts a hard landing into a roll: most of
 *              the damage goes away and, unlike simply surviving it, your speed
 *              is preserved so a rooftop run is not interrupted.
 *
 * Crouch doing double duty is not a compromise - in the air it means "go down
 * faster", on the ground it means "absorb it", and those are the same intent.
 *
 * ── The landing window ────────────────────────────────────────────────────
 * A roll cannot require frame-perfect timing on a key pressed while falling at
 * 30 m/s. Crouch pressed any time in the {@link ROLL_WINDOW} before touchdown
 * counts, and it stays armed briefly after landing too, so an early press and a
 * late one both work. That window is the difference between a mechanic and a
 * coin flip.
 */

const P = CONFIG.player;
const clamp = THREE.MathUtils.clamp;

/** Impact speed below which a landing is free. ~7 m of fall. */
const SAFE_SPEED = 18;
/** Impact speed that kills outright from full health. ~36 m of fall. */
const LETHAL_SPEED = 42;
/** A roll removes this much of the damage above the safe threshold. */
const ROLL_ABSORB = 0.72;
/** ...and can never leave more than this, so a rolled landing is survivable. */
const ROLL_MAX_DAMAGE = 32;
/** Crouch pressed within this many seconds either side of touchdown rolls. */
const ROLL_WINDOW = 0.35;
/** How long the roll animation/state lasts. */
const ROLL_TIME = 0.55;
/** Speed multiplier carried through a roll - it should feel like momentum. */
const ROLL_SPEED = 1.12;

/** Extra horizontal speed a running leap adds, and what it costs. */
const LEAP_BOOST = 1.42;
const LEAP_LIFT = 1.12;
const LEAP_STAMINA = 14;
/** Minimum ground speed to qualify as "running". */
const LEAP_MIN_SPEED = 5.2;

/** Downward and forward acceleration while diving. */
const DIVE_ACCEL = 16;
const DIVE_FORWARD = 7.5;
/** A dive only starts once you are actually falling this fast. */
const DIVE_MIN_FALL = 3.0;

const _pv = new THREE.Vector3();

export class Parkour {
  /**
   * @param {{player:any, bus:any, input:any, worldManager:any}} ctx
   */
  constructor({ player, bus, input, worldManager } = {}) {
    this.player = player;
    this.bus = bus ?? null;
    this.input = input ?? null;
    this.worldManager = worldManager ?? null;

    /** Seconds of roll left, 0 when not rolling. */
    this.rollTime = 0;
    /** True while diving. */
    this.diving = false;
    /** Set when crouch was pressed recently; consumed on landing. */
    this._rollArmed = 0;
    this._crouchHeld = false;
    /** Peak downward speed this fall, for the damage model and the HUD. */
    this._peakFall = 0;
    /** Last landing verdict, for debugging and the harness. */
    this.lastLanding = null;

    this._offs = [];
    if (this.bus) {
      // Landing is announced by Player *after* it has resolved the ground, so
      // this is the only place with the real impact speed.
      this._offs.push(this.bus.on('player:landed', (e) => this._onLand(e)));
    }
  }

  /** 0..1 dive weight, for the avatar pose and the camera. */
  get diveWeight() {
    return this.diving ? 1 : 0;
  }

  /** True while the roll is playing. */
  get rolling() {
    return this.rollTime > 0;
  }

  /* ------------------------------------------------------------------ */
  /* Frame                                                               */
  /* ------------------------------------------------------------------ */

  /**
   * Called from `Player.fixedUpdate` before the jump is resolved.
   * @param {number} dt
   */
  fixedUpdate(dt) {
    const p = this.player;
    const s = this.input?.state;
    if (!p || !s) return;

    if (this.rollTime > 0) this.rollTime = Math.max(0, this.rollTime - dt);
    if (this._rollArmed > 0) this._rollArmed = Math.max(0, this._rollArmed - dt);

    const crouchEdge = !!s.crouch && !this._crouchHeld;
    this._crouchHeld = !!s.crouch;

    const grounded = p.grounded;
    const vy = p.velocity.y;

    // Track the worst of this fall. Reset on the ground so a long descent
    // followed by a step down is not charged for the descent.
    if (grounded) this._peakFall = 0;
    else if (vy < 0) this._peakFall = Math.max(this._peakFall, -vy);

    /* ---- arm the roll ------------------------------------------------ */
    // Any crouch press while falling arms it; the window is what makes this a
    // mechanic rather than a reflex test.
    if (crouchEdge && !grounded) this._rollArmed = ROLL_WINDOW;

    /* ---- dive -------------------------------------------------------- */
    if (!grounded && s.crouch && vy < -DIVE_MIN_FALL && !p.isFreeClimbing) {
      if (!this.diving) {
        this.diving = true;
        this.bus?.emit('player:dive', { state: 'start', position: p.position.clone() });
      }
      // Steepen and lengthen: a dive is how you *reach* the haystack, so it has
      // to add forward carry as well as speed, or it is only a faster death.
      p.velocity.y -= DIVE_ACCEL * dt;
      const yaw = p.yaw;
      p.velocity.x += -Math.sin(yaw) * DIVE_FORWARD * dt;
      p.velocity.z += -Math.cos(yaw) * DIVE_FORWARD * dt;
    } else if (this.diving && (grounded || !s.crouch)) {
      this.diving = false;
      this.bus?.emit('player:dive', { state: 'end', position: p.position.clone() });
    }
  }

  /**
   * Turn an ordinary jump into a running leap. Called by `Player` at the moment
   * it applies jump velocity.
   *
   * @returns {boolean} true if this was a leap
   */
  tryLeap() {
    const p = this.player;
    const s = this.input?.state;
    if (!p || !s || !s.sprint) return false;

    const v = p.velocity;
    const speed = Math.hypot(v.x, v.z);
    if (speed < LEAP_MIN_SPEED) return false;

    const stam = p.stamina;
    if (stam && !stam.spend(LEAP_STAMINA, 'leap')) return false;

    // Scale what is already there rather than setting a fixed speed: a leap
    // should reward the run-up that earned it.
    v.x *= LEAP_BOOST;
    v.z *= LEAP_BOOST;
    v.y = P.jumpVelocity * LEAP_LIFT;
    this.bus?.emit('player:leap', { speed: speed * LEAP_BOOST, position: p.position.clone() });
    return true;
  }

  /* ------------------------------------------------------------------ */
  /* Landing                                                             */
  /* ------------------------------------------------------------------ */

  _onLand(e) {
    const p = this.player;
    if (!p || p.isDead) return;
    const speed = Math.max(e?.speed ?? 0, this._peakFall);
    this._peakFall = 0;
    this.diving = false;

    const soft = this._softLandingAt(p.position);
    const rolled = !soft && (this._rollArmed > 0 || !!this.input?.state?.crouch);

    let damage = 0;
    if (!soft && speed > SAFE_SPEED) {
      const t = clamp((speed - SAFE_SPEED) / (LETHAL_SPEED - SAFE_SPEED), 0, 1);
      damage = t * p.maxHealth;
      if (rolled) damage = Math.min(ROLL_MAX_DAMAGE, damage * (1 - ROLL_ABSORB));
    }

    if (rolled && speed > SAFE_SPEED * 0.55) {
      this.rollTime = ROLL_TIME;
      this._rollArmed = 0;
      // Momentum through the roll is the reward: without it a rooftop run stops
      // dead every time it drops a level, which is the opposite of parkour.
      const v = p.velocity;
      const sp = Math.hypot(v.x, v.z);
      if (sp > 0.5) {
        v.x *= ROLL_SPEED;
        v.z *= ROLL_SPEED;
      }
      this.bus?.emit('player:roll', { speed, position: p.position.clone() });
    }

    if (soft) {
      this.bus?.emit('player:softland', { kind: soft, speed, position: p.position.clone() });
      this.bus?.emit('hud:notify', { text: soft === 'hay' ? 'Soft landing' : 'Broke the fall', tone: 'info' });
    }

    this.lastLanding = { speed: +speed.toFixed(1), soft, rolled, damage: Math.round(damage) };

    if (damage >= 1) {
      // `applyDamage(amount, sourcePosition, sourceId)` - no source position,
      // because a directional hit indicator pointing at the floor is noise.
      p.applyDamage?.(damage, null, 'fall');
      this.bus?.emit('player:falldamage', { speed, damage });
    }
  }

  /**
   * Is this landing spot something that breaks a fall?
   *
   * Worlds publish `haystacks` as `{x, y, z, r}`; the citadel places one under
   * every viewpoint by rule, which is what makes a leap of faith a route rather
   * than a death. Water is handled by `Swim` before a landing is ever reported,
   * so it needs no case here.
   *
   * @param {THREE.Vector3} pos
   * @returns {'hay'|null}
   */
  _softLandingAt(pos) {
    const world = this.worldManager?.active;
    const stacks = world?.haystacks;
    if (!stacks?.length) return null;
    for (const h of stacks) {
      const dx = pos.x - h.x;
      const dz = pos.z - h.z;
      const dy = pos.y - h.y;
      // Generous vertically: you land *in* a haystack, and its recorded y is
      // the top of it.
      if (dy > 1.5 || dy < -3.5) continue;
      const r = (h.r ?? 3) + 0.6;
      if (dx * dx + dz * dz <= r * r) return 'hay';
    }
    return null;
  }

  dispose() {
    for (const off of this._offs) off?.();
    this._offs.length = 0;
  }
}

export default Parkour;
