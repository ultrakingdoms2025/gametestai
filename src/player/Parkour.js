import * as THREE from 'three';
import { CONFIG } from '../core/Config.js';
import { allows } from '../worlds/WorldRules.js';

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
 * worlds that were designed without it. Every number here was MEASURED by
 * walking the real controller off a real ledge, not derived:
 *
 *     jump, landing back on the flat      6.07 m/s      free
 *     7.0 m drop                         17.60 m/s      free
 *     7.5 m drop                         18.33 m/s      1 damage
 *     39.0 m drop                        41.43 m/s      98 damage, survived
 *     40.0 m drop                        42.17 m/s      dead
 *
 * So nothing you can do with the jump key is ever punished, damage begins at a
 * drop of about 7.5 m and a fall is lethal from full health at about 40 m. The
 * old docstring said "about 36" for the second, and the Citadel design says
 * 7.79 and 40.8 - both a little long, because they integrate a fall from REST
 * and a player stepping off a ledge is already doing 2.2 m/s downward: `_move`
 * applies a ground-stick bias of -2.2 every grounded step and the last one
 * before the lip is still in the velocity.
 * @see ../../scripts/tests/parkour.test.mjs 'the fall damage curve'
 *
 * ── The three verbs, and why they share two keys ──────────────────────────
 * No new bindings. Every key in this game is spoken for, and a parkour set that
 * needs three more would not be reachable.
 *
 *   **Leap**   Sprint + jump, running. A flatter, longer jump that clears the
 *              roof gaps the citadel's outer rings are spaced for. Costs
 *              stamina, so it is a decision rather than a default. Measured
 *              flat gap 7.569 m against a sprint jump's 4.647 m.
 *   **Dive**   Crouch while airborne and falling. Pitches head-first, drops
 *              faster and carries further, and is what lets a leap of faith
 *              actually reach the haystack below a viewpoint.
 *   **Roll**   Crouch as you land. Converts a hard landing into a roll: most of
 *              the damage goes away and, unlike simply surviving it, your speed
 *              is preserved so a rooftop run is not interrupted.
 *   **Dodge**  Crouch while RUNNING on the ground. The fourth entry in a set of
 *              three verbs: the same roll, entered on purpose rather than as an
 *              answer to a fall. The capsule tucks to {@link ROLL_HEIGHT}, the
 *              eye drops with it, and it is briefly invulnerable, so it goes
 *              under things a crouch cannot and through things that would hurt.
 *              Rationed by {@link DODGE_COOLDOWN}, because unrationed it was
 *              measured at 70.9% invulnerability uptime for free.
 *
 * Crouch doing quadruple duty is not a compromise - in the air it means "go
 * down faster", on landing it means "absorb it", and running on the ground it
 * means "get out of the way". They are the same intent read against the same
 * three pieces of state the controller already publishes: `grounded`,
 * `velocity.y` and planar speed. No new binding, and nothing added to
 * `BINDABLE`: `KeyC` already reads "Crouch / dive / roll".
 *
 * ── The landing window, and the half of it that is real ───────────────────
 * A roll cannot require frame-perfect timing on a key pressed while falling at
 * 30 m/s, so crouch pressed at any point in the {@link ROLL_WINDOW} BEFORE
 * touchdown counts, and the press is remembered.
 *
 * This docstring used to claim the window ran on both sides of touchdown. It
 * never did, and it never can: the damage verdict is computed and applied in
 * `_onLand`, on the landing step, and there is nothing honest to do about a
 * press that arrives afterwards - un-applying damage a fifth of a second later
 * reads as a health bar with a bug in it. So the two halves are now separated
 * and both are true:
 *
 *   - the DAMAGE window is the approach only, `ROLL_WINDOW` before touchdown;
 *   - the ROLL ITSELF - the pose, the momentum floor, the dust, the i-frames -
 *     is still available for `ROLL_WINDOW` after a hard landing, through
 *     exactly the same path a running dodge takes, cooldown included.
 *
 * A late press therefore still does something, and what it cannot do is
 * retroactively soften a hit that has already landed.
 *
 * ── The events, and who owns them ─────────────────────────────────────────
 * `player:leap`, `player:dive`, `player:roll`, `player:softland` and
 * `player:falldamage` had zero listeners in the whole of `src/` - the same
 * defect `camera:shake` shipped with. They now have owners:
 * {@link Parkour#applyPose} (registered in `Player._installLatePose`) for the
 * body, `Player`'s view springs for the camera, `AudioDirector` for sound and
 * `VFX` for dust. `player:hardland` is new and is in the same ratchet.
 *
 * `player:dive` is the only one of them that is a STATE rather than a beat, so
 * it is the only one with an end - and the end is emitted from exactly one
 * place, {@link Parkour#_endDive}, because the two exits disagreed and the
 * common one said nothing at all.
 *
 * ── Who is allowed to do any of this ──────────────────────────────────────
 * `Player.fixedUpdate` gates every parkour call on `allows(world, 'parkour')`,
 * and it also RETURNS before that call while dead, while mounted and while
 * mantling. Nothing here ticks in those states, so nothing here may be read as
 * live in them either: `Player` calls {@link Parkour#cancel} on each of them,
 * and `_onLand` - which arrives by subscription and not through `fixedUpdate` -
 * asks `allows` for itself.
 */

const P = CONFIG.player;
const clamp = THREE.MathUtils.clamp;
const damp = THREE.MathUtils.damp;

/**
 * Impact speed below which a landing is free. Measured: a 7.0 m drop.
 *
 * DELIBERATELY NOT PER-WORLD, and this is the item the whole per-world gravity
 * change exists for. Damage is keyed to impact SPEED, and `v = √(2gh)` does the
 * scaling for free: the same 18 m/s is a 7.49 m drop at default gravity and a
 * 45.26 m drop on Tessera, so the HEIGHT a player learns moves with the world
 * they learned it on without a single constant here being touched. Scaling this
 * as well would scale it twice and hand Tessera back its lethal 7 m ledge.
 * @see ./Player.js the per-world gravity design block
 */
const SAFE_SPEED = 18;
/** Impact speed that kills outright from full health. Measured: a 40.0 m drop.
 *  Absolute for the same reason - 40.06 m at default, 242.68 m on Tessera. */
const LETHAL_SPEED = 42;
/**
 * A roll removes this much of the damage above the safe threshold.
 *
 * There used to be a second constant here, `ROLL_MAX_DAMAGE = 32`, described as
 * the guarantee that "a rolled landing is survivable". It could not bind: the
 * unrolled curve tops out at `maxHealth` exactly, so the rolled curve tops out
 * at `maxHealth * (1 - ROLL_ABSORB)` = 28 of 100, and `Math.min(32, ...)` was a
 * branch that never chose its left operand at any speed the model can produce.
 * A rail set above the maximum is not a rail - it is a number a reader reasons
 * from, and a trap for whoever next lowers this fraction. It is deleted, and
 * the invariant it claimed is asserted where it can actually fail.
 * @see ../../scripts/tests/parkour.test.mjs 'ROLL_MAX_DAMAGE is gone'
 */
const ROLL_ABSORB = 0.72;
/** Crouch pressed within this many seconds of touchdown rolls. @see the header. */
const ROLL_WINDOW = 0.35;
/** How long the roll state - pose, speed floor, tucked capsule - lasts. */
const ROLL_TIME = 0.55;
/** Speed multiplier carried through a roll - it should feel like momentum. */
const ROLL_SPEED = 1.12;
/**
 * ...and the ceiling on what that multiplier may hold you at.
 *
 * The floor exists because the reward SELF-CANCELLED: `ROLL_SPEED` scaled the
 * velocity once on the landing step and held crouch then set `wishSpeed` to
 * `crouchSpeed` = 2.2, so friction shed the whole boost in about a fifth of a
 * second. Measured before the floor existed, a sprint off a 12 m ledge with
 * crouch held: 15.06 m/s at touchdown, 5.05 m/s a tenth of a second later,
 * 2.20 m/s by two tenths. The roll now owns its speed outright for `ROLL_TIME`.
 *
 * The cap is what stops that ownership becoming a launcher, and it is a cap on
 * a FLOOR: the floor itself is `planar speed * ROLL_SPEED`, so a roll returns
 * proportionally what it was given. The first version of it took the number
 * `_onLand` had to hand, which is the VERTICAL impact speed, and every rolled
 * landing is hard enough that `min(impact * 1.12, cap)` picked the cap - a
 * player who walked off a 20 m ledge at 4.6 m/s was accelerated to 9.184 m/s
 * for half a second, twice their entry speed and 12% over the sprint cap. A
 * set is not a floor. @see {@link Parkour#_startRoll}
 */
const ROLL_FLOOR_MAX = P.sprintSpeed * ROLL_SPEED;
/** Capsule height while rolling. Under `CROUCH_HEIGHT`, which is the point. */
const ROLL_HEIGHT = P.height * 0.42;
/** ...and the eye with it, or the camera stays up while the body goes down. */
const ROLL_EYE = P.eyeHeight * 0.34;
/**
 * Seconds of invulnerability a deliberate roll buys.
 *
 * Granted only by the GROUND entries (dodge and the late window), never by
 * `_onLand`: the landing roll's own fall damage is applied at the end of that
 * same call, and i-frames raised before it would cancel the very hit the roll
 * is supposed to be softening rather than negating.
 *
 * Raised through `Player.grantIFrames`, which is the SILENT half of
 * `grantShield`: a shield is a pickup and announces itself on `player:buffed`,
 * a dodge is a movement and must not. Measured before the split, a player
 * tapping crouch every time the roll expired emitted 52 `player:buffed` events
 * in thirty seconds.
 */
const ROLL_IFRAMES = 0.40;
/**
 * ...and the wait before another one can be bought.
 *
 * Without it the dodge is unbounded: nothing costs stamina, and the only gate
 * on re-entry was `rollTime <= 0`, so crouch tapped the instant each roll ended
 * measured **52 rolls and 70.9% invulnerability uptime over thirty seconds** at
 * a mean 8.65 m/s, sustainable for as long as the player cares to hold forward.
 * A running character who cannot be hit by anything for seven tenths of the
 * time is not dodging, it is switched off.
 *
 * `ROLL_TIME + DODGE_COOLDOWN` between entries puts the ceiling at
 * `ROLL_IFRAMES / (ROLL_TIME + DODGE_COOLDOWN)` = 22.9%. Tapping crouch the
 * instant the gates open, as fast as the game allows, now measures **17 rolls
 * and 23.4% uptime** over the same thirty seconds - the extra half a point is
 * the frame the roll starts on.
 * @see ../../scripts/tests/parkour.test.mjs 'the dodge cannot be spammed'
 */
const DODGE_COOLDOWN = 1.2;

/**
 * Extra horizontal speed a running leap adds, and what it costs.
 *
 * `LEAP_BOOST` is a MULTIPLIER on the run-up already in the velocity, and
 * `LEAP_MIN_SPEED`, `ROLL_SPEED` and `ROLL_FLOOR_MAX` are planar speeds off
 * `P.sprintSpeed`. None of them is a gravity, none of them scales, and none of
 * them should: how fast a body runs is not a statement about the ground pulling
 * it. The only per-world term in a leap is the LIFT, which `tryLeap` writes
 * absolutely off the config and `Player` rescales by `jumpScale` on the same
 * step - see the note at the jump in `Player.fixedUpdate`.
 */
const LEAP_BOOST = 1.42;
const LEAP_LIFT = 1.12;
const LEAP_STAMINA = 14;
/**
 * Minimum ground speed to qualify as "running".
 *
 * Shared by the leap and the ground dodge on purpose: "running" is one
 * question, and a walk that dodge-rolled while a walk-plus-jump refused to leap
 * would be two different definitions of the same word. It also sits above
 * `walkSpeed` (4.6), so an ordinary crouch-walk stays an ordinary crouch-walk
 * and only a sprint (8.2), a boosted walk or a landing keeps the dodge.
 */
const LEAP_MIN_SPEED = 5.2;

/**
 * Downward and forward acceleration while diving, and the fall speed that arms
 * it - all three authored against `CONFIG.player.gravity` and all three scaled
 * per world in {@link Parkour#fixedUpdate}.
 *
 * ── Why an absolute dive is the worst of the three to leave alone ─────────
 * `DIVE_ACCEL` is 16 against a gravity of 22, i.e. **a dive is 0.73x gravity**,
 * and that fraction is the whole feel of it: crouch and you fall about three
 * quarters again as fast. Left absolute it is 0.73x on the station and **4.4x
 * on Tessera**, where gravity is -3.633 - so the one verb whose entire purpose
 * is "go down faster" would go from a steepening to a rocket, and the moon
 * whose design is a floaty jump would ship with a button that cancels it. It
 * scales as `r` ({@link Player#gravityRatio}), and 0.73x is 0.73x everywhere.
 *
 * `DIVE_FORWARD` is mid-air steering by another name - the same quantity
 * `P.airAcceleration` is, applied on top of it - so it takes the same exponent,
 * `r^⅔` ({@link Player#airScale}). That holds the product `a·T` invariant, so
 * the forward CARRY one dive buys is the same on every world however long the
 * dive lasts. A dive is committed and not free, for the reason a jump is.
 *
 * `DIVE_MIN_FALL` is a vertical SPEED, so it takes `r^⅓`
 * ({@link Player#jumpScale}). Left absolute, 3.0 m/s is 22% of the way down
 * from a default apex and 73% of the way down from Tessera's - the dive would
 * arm almost too late to use on the world it matters most on. Scaled, it arms
 * at the same fraction of the arc everywhere.
 *
 * All three multiply by exactly 1 on a world that publishes no gravity, which
 * IEEE-754 leaves alone to the bit - the parkour ratchet is the proof.
 * @see ../../scripts/tests/parkour.test.mjs 'THE RATCHET'
 * @see ./Player.js the per-world gravity design block
 */
const DIVE_ACCEL = 16;
const DIVE_FORWARD = 7.5;
const DIVE_MIN_FALL = 3.0;

/* ------------------------------------------------------------------ *
 * Pose tuning. Every number below is authored by eye - they are
 * radians on a 26-bone skeleton and there is nothing to reproduce them
 * against. The numbers with a measurement behind them are all in the
 * block above and say so.
 * ------------------------------------------------------------------ */

/** Seconds the one-shot leap pose runs for. */
const LEAP_POSE_TIME = 0.55;
/** Fraction of the leap spent in the wind-up, before the body commits. */
const LEAP_WINDUP = 0.30;
/** Radians the dive pitches the whole body head-first. */
const DIVE_TILT = 1.18;
/** Turns of forward somersault in one roll. */
const ROLL_TURNS = 1;
/** Peak view bank a roll puts on the camera, radians. @see Player `_poseRoll`. */
const ROLL_VIEW_BANK = 0.13;
/** Metres of rig lift at full inversion, and at a full dive pitch. */
const RIG_LIFT = 0.62;
/**
 * Below this, `Swim.applyPose` still owns `humanoid.rig` and this module must
 * leave it alone. Same guard, same value and same reason as
 * `MinigamePose.SWIM_RIG_EPS`: whoever writes the rig is responsible for
 * putting it back, and taking it back mid-handover snaps the body upright.
 */
const SWIM_RIG_EPS = 0.02;

/* Module scratch. Nothing below allocates in a frame handler. */
const _poseE = new THREE.Euler();
const _poseQ = new THREE.Quaternion();
const _rigAxis = new THREE.Vector3(1, 0, 0);
/**
 * Right side, then left, with every bone name spelled out.
 *
 * `for (const side of [1, -1])` allocates an array per frame and
 * `` `upperArm${s}` `` allocates a string per bone per frame - 3 poses x 7
 * bones x 2 sides is 42 of them at 60 Hz. The other pose modules in this
 * codebase build both; this one does not, because the rule in
 * `NPCAnimator.js:19` is that nothing in a frame handler allocates and a table
 * costs six lines to read.
 */
const LIMBS = [
  { side: 1, clavicle: 'clavicleR', upperArm: 'upperArmR', foreArm: 'foreArmR',
    hand: 'handR', thigh: 'thighR', calf: 'calfR', foot: 'footR' },
  { side: -1, clavicle: 'clavicleL', upperArm: 'upperArmL', foreArm: 'foreArmL',
    hand: 'handL', thigh: 'thighL', calf: 'calfL', foot: 'footL' },
];

/**
 * Slerp one bone toward an ABSOLUTE euler at `weight`.
 *
 * A module function rather than the closure the other pose modules build per
 * call, for the reason in the header of `NPCAnimator`: this runs three times a
 * frame across seventeen bones and a closure per call is a closure per frame.
 *
 * @param {Map<string, import('three').Bone>} B
 */
function setBone(B, name, x, y, z, weight) {
  if (!(weight >= 0.002)) return;
  const bone = B.get(name);
  if (!bone) return;
  _poseE.set(x, y, z);
  _poseQ.setFromEuler(_poseE);
  bone.quaternion.slerp(_poseQ, weight > 1 ? 1 : weight);
}

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
    /** What started the current roll: 'land' | 'dodge' | 'late'. */
    this.rollKind = null;
    /** Ground speed the roll holds for its duration, 0 when not rolling. */
    this._rollFloor = 0;
    /** True while diving. */
    this.diving = false;
    /** Smoothed 0..1 dive blend - the pose and the camera both read it. */
    this._diveW = 0;
    /** Set when crouch was pressed recently; consumed on landing. */
    this._rollArmed = 0;
    /** Seconds left of the post-touchdown half of `ROLL_WINDOW`. */
    this._landGrace = 0;
    /** Seconds until another i-frame roll may be entered. @see DODGE_COOLDOWN */
    this._dodgeReady = 0;
    this._crouchHeld = false;
    /** Peak downward speed this fall, for the damage model and the HUD. */
    this._peakFall = 0;
    /** Last landing verdict, for debugging and the harness. */
    this.lastLanding = null;

    /* ---- pose state ---- */
    this._leapT = 0;
    this._rigApplied = false;

    this._offs = [];
    if (this.bus) {
      // Landing is announced by Player *after* it has resolved the ground, so
      // this is the only place with the real impact speed.
      this._offs.push(this.bus.on('player:landed', (e) => this._onLand(e)));
    }
  }

  /* ---- constants other modules and the tests read ------------------- */

  /** Capsule height while rolling, metres. Read by `Player.setRollStance`. */
  static get ROLL_HEIGHT() {
    return ROLL_HEIGHT;
  }

  /** Eye height while rolling, metres. Read by `Player`'s eye spring. */
  static get ROLL_EYE() {
    return ROLL_EYE;
  }

  /** Seconds a roll lasts. */
  static get ROLL_TIME() {
    return ROLL_TIME;
  }

  /**
   * The ceiling on the roll's speed floor, m/s.
   *
   * Exposed because a test that recomputes `P.sprintSpeed * 1.12` for itself
   * and then asserts against it is asserting arithmetic, not this module: the
   * one that used to live in `parkour.test.mjs` reduced to `8.2 * 1.12 > 8.2`
   * and could not fail for any edit to this file.
   */
  static get ROLL_FLOOR_MAX() {
    return ROLL_FLOOR_MAX;
  }

  /** Seconds a dodge must wait after the last one. @see DODGE_COOLDOWN */
  static get DODGE_COOLDOWN() {
    return DODGE_COOLDOWN;
  }

  /**
   * 0..1 dive weight, for the avatar pose and the camera.
   *
   * Smoothed rather than binary: `Player.update` turns it straight into a
   * sustained view pitch, and a step function there is a snap of 68 degrees in
   * a single frame.
   */
  get diveWeight() {
    return this._diveW;
  }

  /** True while the roll is playing. Read by `Player`'s stance and eye spring. */
  get rolling() {
    return this.rollTime > 0;
  }

  /**
   * 0 (standing) to 1 (fully tucked). What `Player.setRollStance` is driven by.
   *
   * Held at 1 for the body of the roll and eased off over the last third, so
   * the capsule and the eye are already on their way back up as the avatar
   * finishes its somersault rather than popping when the timer hits zero.
   */
  get rollTuck() {
    if (this.rollTime <= 0) return 0;
    return clamp(this.rollTime / (ROLL_TIME * 0.34), 0, 1);
  }

  /**
   * Camera bank for the roll, radians. Zero at both ends of the envelope.
   *
   * Named `poseRoll` and not `viewRoll` because `Player.viewRoll` already
   * exists and means the strafe lean - two getters called the same thing on
   * two objects one line apart is how `Player._poseRoll = parkour.viewRoll`
   * came to read as a tautology.
   */
  get poseRoll() {
    if (this.rollTime <= 0) return 0;
    const t = 1 - this.rollTime / ROLL_TIME;
    return ROLL_VIEW_BANK * Math.sin(Math.PI * t);
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

    if (this.rollTime > 0) {
      this.rollTime = Math.max(0, this.rollTime - dt);
      if (this.rollTime === 0) {
        this.rollKind = null;
        this._rollFloor = 0;
      }
    }
    if (this._rollArmed > 0) this._rollArmed = Math.max(0, this._rollArmed - dt);
    if (this._landGrace > 0) this._landGrace = Math.max(0, this._landGrace - dt);
    if (this._dodgeReady > 0) this._dodgeReady = Math.max(0, this._dodgeReady - dt);
    /* The two pose clocks are advanced HERE and not in `applyPose`, which is
     * where they started. `applyPose` returns early when there is no avatar -
     * a headless harness, a preview, the frames before the wardrobe has
     * built - and `diveWeight` is read by the CAMERA, which exists in all of
     * those. A blend weight that only ticks when somebody is looking at the
     * body is a blend weight that reads zero exactly when it is needed. Fixed
     * step also makes both of them deterministic, like `rollTime`. */
    if (this._leapT > 0) this._leapT = Math.max(0, this._leapT - dt);
    this._diveW = damp(this._diveW, this.diving ? 1 : 0, 9, dt);

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

    /* ---- the ground roll --------------------------------------------- *
     * Two ways in and one exit. Running plus crouch is the dodge - the new
     * verb - and crouch just after a hard landing is the late half of
     * `ROLL_WINDOW`, which the header used to promise and the code never
     * delivered. Neither may interrupt a roll already in flight, and neither
     * runs while another controller owns the capsule: a mantle, a free climb
     * and a swim all write the capsule themselves. */
    if (
      crouchEdge && grounded && this.rollTime <= 0 && this._dodgeReady <= 0
      && !p.isFreeClimbing && !p.isSwimming && !p.isClimbing && !p.movementOverride
    ) {
      const speed = Math.hypot(p.velocity.x, p.velocity.z);
      if (speed >= LEAP_MIN_SPEED) this._startRoll(speed, 'dodge');
      else if (this._landGrace > 0) this._startRoll(speed, 'late');
    }

    /* ---- dive -------------------------------------------------------- */
    /* One predicate, read twice. The exit used to be `grounded || !s.crouch`,
     * which is NOT the negation of the entry, and the gap between the two is a
     * latch: airborne with crouch held and `vy >= -DIVE_MIN_FALL` satisfies
     * neither branch, so `diving` stays true and `_diveW` keeps damping toward
     * 1. Measured - dive off a roof, take an upward impulse from a blast at
     * full dive weight - the body held its head-first pose and the camera held
     * 19.5 degrees of pitch-down for the whole of a four-second ASCENT. Written
     * as one boolean it cannot drift apart again. */
    /* The three dive constants, on this world. Read off `Player`, which
     * resolved them once on `world:changed`, rather than recomputed here: a
     * cube root of the ratio taken a second time is the design rule stated a
     * second time. Three plain property reads, and every one of
     * them is a literal 1 on a world that publishes no gravity. @see DIVE_ACCEL */
    const minFall = DIVE_MIN_FALL * p.jumpScale;
    const wantsDive = !grounded && !!s.crouch && vy < -minFall && !p.isFreeClimbing;
    if (wantsDive) {
      if (!this.diving) {
        this.diving = true;
        this.bus?.emit('player:dive', { state: 'start', speed: -vy, position: p.position.clone() });
      }
      // Steepen and lengthen: a dive is how you *reach* the haystack, so it has
      // to add forward carry as well as speed, or it is only a faster death.
      p.velocity.y -= DIVE_ACCEL * p.gravityRatio * dt;
      const yaw = p.yaw;
      const diveFwd = DIVE_FORWARD * p.airScale;
      p.velocity.x += -Math.sin(yaw) * diveFwd * dt;
      p.velocity.z += -Math.cos(yaw) * diveFwd * dt;
    } else if (this.diving) {
      this._endDive();
    }
  }

  /**
   * Hold the roll's ground speed.
   *
   * Called by `Player.fixedUpdate` from ONE place and it is a load-bearing one:
   * after friction and the wish have both taken their bite for this step, and
   * immediately before `_move` integrates. Written any earlier and friction
   * removes a sixth of it inside the same step; written any later and the step
   * that has already been travelled was travelled at the wrong speed.
   *
   * @returns {boolean} true when the floor actually did something
   */
  holdRollSpeed() {
    if (this.rollTime <= 0 || this._rollFloor <= 0) return false;
    const p = this.player;
    if (!p?.grounded) return false;
    const v = p.velocity;
    const sp = Math.hypot(v.x, v.z);
    // Below half a metre a second there is no heading left to scale by, and a
    // roll that has been stopped by a wall must not be shoved back into it.
    if (sp < 0.5 || sp >= this._rollFloor) return false;
    const k = this._rollFloor / sp;
    v.x *= k;
    v.z *= k;
    return true;
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
    this._leapT = LEAP_POSE_TIME;
    // A leap widens the frame for a moment. Small, because the sprint kick is
    // already worth up to 4.76 degrees and this sits on top of it.
    p.punchFov?.(4.5);
    this.bus?.emit('player:leap', { speed: speed * LEAP_BOOST, position: p.position.clone() });
    return true;
  }

  /* ------------------------------------------------------------------ */
  /* Rolling                                                             */
  /* ------------------------------------------------------------------ */

  /**
   * Enter the roll state.
   *
   * One entry point for all three kinds, so the pose, the speed floor and the
   * capsule can never disagree about whether a roll is happening.
   *
   * THE SPEED FLOOR IS READ OFF THE VELOCITY, not off `speed`. `speed` is what
   * the roll is REPORTED as, and for a landing roll that is the vertical impact
   * speed - the number the damage curve and the audio's `hard` term both want,
   * and the wrong number entirely for a planar floor. Deriving the floor from
   * it meant every rolled landing (impact > 9.9 m/s by definition of
   * `rollable`) picked `ROLL_FLOOR_MAX`, so a player who walked off a ledge at
   * 4.6 m/s came out of the roll doing 9.184. The floor now returns what it was
   * given, capped.
   *
   * @param {number} speed the speed this roll is reported at - planar for a
   *   ground entry, the vertical impact speed for a landing
   * @param {'land'|'dodge'|'late'} kind
   * @param {string} [material] surface underfoot, for the audio
   */
  _startRoll(speed, kind, material = undefined) {
    const p = this.player;
    this.rollTime = ROLL_TIME;
    this.rollKind = kind;
    this._rollArmed = 0;
    this._landGrace = 0;
    const v = p.velocity;
    const sp = Math.hypot(v.x, v.z);
    // Momentum through the roll is the reward: without it a rooftop run stops
    // dead every time it drops a level, which is the opposite of parkour.
    this._rollFloor = Math.min(sp * ROLL_SPEED, ROLL_FLOOR_MAX);
    if (sp > 0.5) {
      const k = this._rollFloor / sp;
      if (k > 1) {
        v.x *= k;
        v.z *= k;
      }
    }
    // i-frames belong to the deliberate entries only - see ROLL_IFRAMES - and
    // they are rationed, or the dodge is an off switch for the damage system.
    if (kind !== 'land') {
      p.grantIFrames?.(ROLL_IFRAMES);
      this._dodgeReady = ROLL_TIME + DODGE_COOLDOWN;
    }
    // A roll drops the view: the same spring a landing uses, at a fixed
    // amplitude, because a dodge on the flat has no impact speed to scale by.
    p.addViewDip?.(-0.55);
    this.bus?.emit('player:roll', {
      kind,
      speed,
      material: material ?? p.surfaceUnderfoot?.() ?? 'default',
      position: p.position.clone(),
      invulnerable: kind !== 'land',
    });
  }

  /**
   * Leave the dive state and say so.
   *
   * A private helper because there are two exits and only one of them used to
   * emit: `_onLand` cleared `this.diving` silently, and `_onLand` runs at the
   * END of `Player.fixedUpdate` - after `fixedUpdate` has already taken its
   * turn - so the branch that emits could never see the flag again. Measured:
   * three dives that ended on the ground produced three `dive:start` and zero
   * `dive:end`. That is the same emitted-into-nothing defect this phase exists
   * to remove, reintroduced inside the fix.
   */
  _endDive() {
    if (!this.diving) return;
    this.diving = false;
    this.bus?.emit('player:dive', { state: 'end', position: this.player.position.clone() });
  }

  /* ------------------------------------------------------------------ */
  /* Landing                                                             */
  /* ------------------------------------------------------------------ */

  _onLand(e) {
    const p = this.player;
    if (!p || p.isDead) return;
    const speed = Math.max(e?.speed ?? 0, this._peakFall);
    const material = e?.material ?? 'default';
    this._peakFall = 0;
    // The dive ends here on the overwhelmingly common path, and saying so is
    // the whole point of `_endDive`. @see {@link Parkour#_endDive}
    this._endDive();

    const soft = this._softLandingAt(p.position);
    /* Hard enough to be worth announcing at all: below this an arrival is a
     * footstep, which `player:landed` already covers. It gates the roll, the
     * late window AND the soft-landing cue, because a haystack sits at ground
     * level and every standing hop taken on top of one was firing a 41-node
     * whump and an unthrottled "Soft landing" toast. */
    const notable = speed > SAFE_SPEED * 0.55;
    const rolled = !soft && (this._rollArmed > 0 || !!this.input?.state?.crouch);
    const rollable = !soft && notable;

    let damage = 0;
    if (!soft && speed > SAFE_SPEED) {
      const t = clamp((speed - SAFE_SPEED) / (LETHAL_SPEED - SAFE_SPEED), 0, 1);
      damage = t * p.maxHealth;
      if (rolled) damage *= 1 - ROLL_ABSORB;
    }

    /* The ROLL is a parkour verb and obeys the world rules; the fall damage
     * below is not and does not. This subscription is the one parkour touchpoint
     * that does not arrive through `Player.fixedUpdate`, so it is the one that
     * has to ask for itself - without this, a 14 m drop in the maze started a
     * roll that nothing then ticked down, latching `rolling === true` and
     * `rollTime = 0.55` for the rest of the session. */
    const verb = allows(this.worldManager?.active, 'parkour');
    if (verb && rolled && rollable) {
      this._startRoll(speed, 'land', material);
    } else if (verb && rollable) {
      // Nothing was pressed on the way down. Leave the late half of the window
      // open so a press that arrives after the thump still rolls, even though
      // it can no longer soften a hit that has already been taken.
      this._landGrace = ROLL_WINDOW;
    }

    if (soft && notable) {
      this.bus?.emit('player:softland', { kind: soft, speed, position: p.position.clone() });
      this.bus?.emit('hud:notify', { text: soft === 'hay' ? 'Soft landing' : 'Broke the fall', tone: 'info' });
    }

    this.lastLanding = { speed: +speed.toFixed(1), soft, rolled, damage: Math.round(damage) };

    if (damage >= 1) {
      // `applyDamage(amount, sourcePosition, sourceId)` - no source position,
      // because a directional hit indicator pointing at the floor is noise.
      p.applyDamage?.(damage, null, 'fall');
      this.bus?.emit('player:falldamage', { speed, damage, material, position: p.position.clone() });
    } else if (rollable) {
      /* A hard but harmless arrival still kicks up dust and still thumps.
       * Separate from `player:falldamage` so those two cues do not double: one
       * of the two fires on any landing worth noticing, never both. The roll is
       * NOT exclusive with either - a rolled hard landing raises `player:roll`
       * and then one of these - which is why `VFX` ignores the landing roll's
       * puff and lets the arrival own the dust. */
      this.bus?.emit('player:hardland', { speed, material, position: p.position.clone() });
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

  /* ------------------------------------------------------------------ */
  /* Pose                                                                */
  /* ------------------------------------------------------------------ */

  /**
   * Pose the avatar for the three verbs.
   *
   * Runs in the late-pose pass (`Player._installLatePose`), after
   * `PlayerAvatar.update()` has rewritten every bone and after its additive
   * `_applyAirPose` has multiplied a jump tuck on top of them. That ordering is
   * the whole reason this wins, and the mechanism is worth being precise about
   * rather than assuming: `_applyAirPose` MULTIPLIES a delta onto whatever the
   * animator left, while every write below SLERPS toward an ABSOLUTE euler. At
   * envelope weight 1 a slerp lands exactly on its target whatever the bone
   * held a moment earlier, so the air pose contributes nothing; at partial
   * weight the two blend, which is what makes the entry and the exit smooth
   * instead of a cut. @see ./PlayerAvatar.js `_applyAirPose`
   *
   * Three poses, in blend order, later wins:
   *
   *   - **leap**  a committed forward bound. Both arms sweep back through the
   *               wind-up and drive forward and up through the follow-through,
   *               lead knee up and trail leg extended - the shape a long jump
   *               has and a vertical jump does not.
   *   - **dive**  head-first. The body pitches on `humanoid.rig` rather than on
   *               the spine, because a dive is the whole character rotating and
   *               folding a spine that far reads as a spasm.
   *   - **roll**  tuck and somersault. Also on the rig, one full forward turn,
   *               with the limbs pulled into a ball underneath it.
   *
   * The weight envelope on the two one-shots is `sin(pi t) ** 0.65` - the shape
   * `TennisPose` uses, zero at both ends. Slerping at full weight from frame
   * one is what makes an avatar twitch.
   *
   * @param {number} dt
   * @param {number} elapsed
   */
  applyPose(dt, elapsed) {
    const humanoid = this.player?.avatar?.humanoid;
    if (!humanoid) return;
    void dt;

    const swimWeight = this.player?.swim?.poseWeight ?? 0;

    /* ---- envelopes --------------------------------------------------- */
    const leapT = this._leapT > 0 ? 1 - this._leapT / LEAP_POSE_TIME : -1;
    const leapW = leapT >= 0 ? Math.pow(Math.sin(Math.PI * leapT), 0.65) : 0;

    const rollT = this.rollTime > 0 ? 1 - this.rollTime / ROLL_TIME : -1;
    const rollW = rollT >= 0 ? Math.pow(Math.sin(Math.PI * rollT), 0.65) : 0;

    const diveW = this._diveW;

    if (leapW < 0.002 && rollW < 0.002 && diveW < 0.002) {
      this._releaseRig(humanoid, swimWeight);
      return;
    }

    const B = humanoid.bones;

    /* ---- 1. leap ----------------------------------------------------- */
    if (leapW >= 0.002) {
      // -1 at full wind-up, +1 at full follow-through.
      const s = leapT < LEAP_WINDUP
        ? -(leapT / LEAP_WINDUP)
        : -1 + ((leapT - LEAP_WINDUP) / (1 - LEAP_WINDUP)) * 2;
      const drive = (s + 1) * 0.5;
      for (const L of LIMBS) {
        const side = L.side;
        // Both arms together: a bound is a two-armed drive, unlike the run
        // cycle's alternation, and that contrast is what reads as commitment.
        setBone(B, L.clavicle, 0, 0, -0.10 * side * s, leapW);
        setBone(B, L.upperArm, -0.70 + 1.95 * drive, 0, side * 0.26, leapW);
        setBone(B, L.foreArm, 0.30 + 0.55 * Math.max(0, -s), 0, side * 0.06, leapW);
        setBone(B, L.hand, -0.18, 0, 0, leapW);
      }
      // Legs split: the lead knee drives up, the trail leg extends behind.
      setBone(B, 'thighR', 0.20 + 1.05 * drive, 0, 0.05, leapW);
      setBone(B, 'calfR', -(0.30 + 1.05 * drive), 0, 0, leapW);
      setBone(B, 'footR', 0.35, 0, 0, leapW);
      setBone(B, 'thighL', 0.20 - 0.75 * drive, 0, -0.05, leapW);
      setBone(B, 'calfL', -(0.30 + 0.25 * drive), 0, 0, leapW);
      setBone(B, 'footL', 0.55 * drive, 0, 0, leapW);
      // Chest opens through the drive; the head leads it.
      setBone(B, 'spine01', -0.10 + 0.16 * drive, 0, 0, leapW);
      setBone(B, 'spine02', -0.08 + 0.14 * drive, 0, 0, leapW);
      setBone(B, 'spine03', -0.06 + 0.12 * drive, 0, 0, leapW);
      setBone(B, 'neck', -0.18 + 0.10 * drive, 0, 0, leapW);
      setBone(B, 'head', -0.14 + 0.08 * drive, 0, 0, leapW);
    }

    /* ---- 2. dive ----------------------------------------------------- */
    if (diveW >= 0.002) {
      for (const L of LIMBS) {
        const side = L.side;
        // Arms swept back along the body, hands past the hips: a dive is a
        // shape you make to go faster, so the silhouette has to be narrow.
        setBone(B, L.clavicle, 0, 0, 0.14 * side, diveW);
        setBone(B, L.upperArm, -0.92, 0, side * 0.34, diveW);
        setBone(B, L.foreArm, 0.22, 0, side * 0.10, diveW);
        setBone(B, L.hand, -0.10, 0, 0, diveW);
        setBone(B, L.thigh, -0.24, 0, side * 0.10, diveW);
        setBone(B, L.calf, -0.34, 0, 0, diveW);
        setBone(B, L.foot, 0.42, 0, 0, diveW);
      }
      setBone(B, 'spine01', 0.06, 0, 0, diveW);
      setBone(B, 'spine02', 0.05, 0, 0, diveW);
      setBone(B, 'spine03', 0.04, 0, 0, diveW);
      // Head up out of the pitch, so the character is looking where it is going.
      setBone(B, 'neck', -0.34, 0, 0, diveW);
      setBone(B, 'head', -0.30, 0, 0, diveW);
    }

    /* ---- 3. roll ----------------------------------------------------- */
    if (rollW >= 0.002) {
      for (const L of LIMBS) {
        const side = L.side;
        // Arms in and hands to the chest; knees to the chest to meet them.
        setBone(B, L.clavicle, 0, 0, 0.20 * side, rollW);
        setBone(B, L.upperArm, 0.55, 0, side * 0.62, rollW);
        setBone(B, L.foreArm, 1.65, 0, side * 0.20, rollW);
        setBone(B, L.hand, -0.25, 0, 0, rollW);
        setBone(B, L.thigh, 1.72, 0, side * 0.20, rollW);
        setBone(B, L.calf, -2.10, 0, 0, rollW);
        setBone(B, L.foot, 0.55, 0, 0, rollW);
      }
      setBone(B, 'spine01', 0.34, 0, 0, rollW);
      setBone(B, 'spine02', 0.32, 0, 0, rollW);
      setBone(B, 'spine03', 0.28, 0, 0, rollW);
      setBone(B, 'neck', 0.40, 0, 0, rollW);
      setBone(B, 'head', 0.34, 0, 0, rollW);
    }

    /* ---- the rig ------------------------------------------------------ *
     * Body-space rotation, shared with `Swim` and `MinigamePose`. The roll
     * outranks the dive: you cannot be doing both, but the dive's weight decays
     * over about a fifth of a second after touchdown and a landing roll starts
     * inside that tail. */
    const wantRig = rollW >= 0.002 || diveW >= 0.002;
    if (wantRig && swimWeight < SWIM_RIG_EPS) {
      const somersault = rollW >= 0.002;
      const tilt = somersault ? rollT * ROLL_TURNS * Math.PI * 2 : DIVE_TILT * diveW;
      this._takeRig(humanoid, tilt, somersault);
    } else if (!wantRig) {
      this._releaseRig(humanoid, swimWeight);
    }
    void elapsed;
  }

  /**
   * Rotate the body about its feet and lift it back off its own ankles.
   *
   * The same correction `Swim.applyPose` and `MinigamePose._takeRig` apply, for
   * the same reason: the rig pivots at the feet, so a fold with no lift buries
   * the chest below the ground the character is standing on. A somersault needs
   * a different curve from a fold - past a quarter turn the body is going over
   * the top, so the lift follows `1 - cos` and peaks at full inversion, where
   * `sin` would have come back to zero and dropped the body through the floor.
   *
   * Written straight rather than damped: both callers are already envelopes
   * that begin and end at zero, and damping an envelope only makes it lag.
   *
   * @param {any} humanoid
   * @param {number} tilt radians about +X; positive folds forward
   * @param {boolean} somersault true to use the over-the-top lift curve
   */
  _takeRig(humanoid, tilt, somersault) {
    humanoid.rig.quaternion.setFromAxisAngle(_rigAxis, -tilt);
    humanoid.rig.position.y = somersault
      ? RIG_LIFT * (1 - Math.cos(tilt))
      : Math.sin(Math.abs(tilt)) * RIG_LIFT;
    this._rigApplied = true;
  }

  /**
   * Hand the rig back exactly as it was found.
   *
   * Refused while the swim pose has weight, per the handover rule in
   * `MinigamePose`: Swim writes the rig every frame it is active and restores
   * it itself, so clearing it here would undo this frame's prone attitude
   * rather than clean anything up.
   *
   * @param {any} humanoid
   * @param {number} swimWeight
   */
  _releaseRig(humanoid, swimWeight = 0) {
    if (!this._rigApplied) return;
    this._rigApplied = false;
    if (swimWeight >= SWIM_RIG_EPS) return;
    humanoid.rig.quaternion.identity();
    humanoid.rig.position.y = 0;
  }

  /**
   * Drop every parkour state without emitting anything.
   *
   * Called from five places, alongside `swim.cancel` and `climb.cancel` and for
   * the same reason each time - somebody else owns the body now:
   *
   *   - `Player.teleport` (and so `respawn`) and the `world:changing` handler,
   *     because a roll does not follow you through a portal. The capsule would
   *     arrive tucked and hold a speed floor in a world just entered.
   *   - `Player._die`, the mount override and the mantle branch, because all
   *     three RETURN from `fixedUpdate` above `parkour.fixedUpdate` - so the
   *     clocks stop while `update()` and the late-pose pass keep reading them.
   *     A state nothing ticks is not a state, it is a stuck value.
   *
   * `_dodgeReady` is deliberately NOT cleared: it is a rate limit rather than a
   * movement state, and clearing it here would make a portal hop or a two-frame
   * mount into a way to refresh the i-frames.
   */
  cancel() {
    this.rollTime = 0;
    this.rollKind = null;
    this._rollFloor = 0;
    this._rollArmed = 0;
    this._landGrace = 0;
    this._peakFall = 0;
    this._leapT = 0;
    this.diving = false;
    this._diveW = 0;
    /* Hand the rig back here as well as in `applyPose`. Cancelling zeroes every
     * weight, so `applyPose` would take its early-out and never reach the
     * release - and a body left rotated by up to 2pi and lifted 1.24 m is what
     * a cancelled somersault would otherwise look like for the rest of the
     * session. */
    const humanoid = this.player?.avatar?.humanoid;
    if (humanoid) this._releaseRig(humanoid, this.player?.swim?.poseWeight ?? 0);
    else this._rigApplied = false;
  }

  dispose() {
    for (const off of this._offs) off?.();
    this._offs.length = 0;
  }
}

export default Parkour;
