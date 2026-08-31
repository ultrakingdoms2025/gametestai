import * as THREE from 'three';
import { CONFIG } from '../core/Config.js';
import { COLLISION_LAYER } from '../physics/Physics.js';
import { WALKABLE_NORMAL_Y } from '../npc/Grounding.js';
import { Weapon } from './Weapon.js';
import { Swim } from './Swim.js';
import { Climb } from './Climb.js';
import { FreeClimb } from './FreeClimb.js';
import { Parkour } from './Parkour.js';
import { Stamina } from '../systems/Stamina.js';
import { WaterVolumes } from '../systems/WaterVolumes.js';
import { allows, worldGravity, worldGravityRatio } from '../worlds/WorldRules.js';

/**
 * First-person player controller.
 *
 * Movement is acceleration-based in the Source lineage: friction is applied
 * first, then a projected acceleration toward the wish direction. That model is
 * what makes a shooter feel crisp - you reach top speed in a few frames, stop
 * dead when you release the keys, and keep useful air control without the
 * floatiness of a velocity lerp.
 *
 * Simulation runs on the engine's fixed 60 Hz step (`fixedUpdate`); everything
 * that must not be quantised to that rate - mouse look, camera composition,
 * viewmodel animation - runs per rendered frame (`update`).
 *
 * `position` is the FEET. Collision is delegated entirely to
 * `physics.resolveCapsule`; this class only decides where it *wants* to be.
 */

/* Module-scope scratch. Nothing in the per-frame path allocates. */
const _v1 = new THREE.Vector3();
const _prev = new THREE.Vector3();
const _step = new THREE.Vector3();
const _down = new THREE.Vector3(0, -1, 0);
const _up = new THREE.Vector3(0, 1, 0);
// Tunnelling guard: where the integrator wanted to be, and the ray it checks.
const _intended = new THREE.Vector3();
const _guardFrom = new THREE.Vector3();
const _guardDir = new THREE.Vector3();

const P = CONFIG.player;
const damp = THREE.MathUtils.damp;
const clamp = THREE.MathUtils.clamp;

const STAND_HEIGHT = P.height;
const CROUCH_HEIGHT = P.height * 0.58;
const STAND_EYE = P.eyeHeight;
const CROUCH_EYE = P.eyeHeight * 0.55;

const MAX_PITCH = 89 * (Math.PI / 180);
/** Below this speed friction is applied at a constant rate, which is what kills the slide. */
const STOP_SPEED = 1.1;
const COYOTE_TIME = 0.12;
const JUMP_BUFFER = 0.12;
/** Metres of travel per complete two-step bob cycle. */
const STRIDE = 1.55;
const RESPAWN_DELAY = 3.2;
const SPAWN_INVULN = 2.5;

/** Fraction of the usual ground friction that applies during a stagger. */
const IMPULSE_FRICTION = 0.22;
/** How long ground friction stays reduced after an impulse, seconds. */
const IMPULSE_STAGGER = 0.42;
/** Hard cap on the horizontal speed any single impulse may leave behind, m/s. */
const IMPULSE_MAX = 14;
/** View-kick spring: stiffness and damping, tuned to overshoot once and settle. */
const KICK_STIFFNESS = 78;
const KICK_DAMPING = 12;
/** How fast an FOV punch decays back into the ordinary sprint kick. @see punchFov */
const FOV_PUNCH_DECAY = 3.2;
/**
 * Radians the view pitches down at full dive weight.
 *
 * Deliberately a fraction of the body's own {@link Parkour} tilt of 1.18 rad.
 * The avatar goes fully head-first because that is what a dive looks like from
 * outside; the camera nods, because 68 degrees of involuntary pitch in first
 * person is the motion-sickness failure state `_tickDip` already refuses to
 * ship for a landing.
 */
const DIVE_VIEW_PITCH = 0.34;

/* ==================================================================== */
/* Per-world gravity                                                     */
/* ==================================================================== */

/**
 * ── The fact, and who reads it ────────────────────────────────────────────
 * A planet descriptor publishes `gravity` in m/s² and `PlanetWorld` copies it
 * onto the world. Until now exactly one thing read it: `Piloting._env`, for the
 * SHIP. A pilot could feel a sixth of a g settle their hull onto Tessera, step
 * out of the airlock, and jump precisely as high as they do in a shopping
 * concourse. Ten planets spanning 1.62 to 10.10 m/s² were a whole dimension of
 * variety that stopped at the cockpit door.
 *
 * `worldGravity()` is now the single reader of the field and both consumers go
 * through the same predicate. @see ../worlds/WorldRules.js
 *
 * ── The ratio, not the number ─────────────────────────────────────────────
 * `CONFIG.player.gravity` is -22, which is 2.24 real g. It is not a mistake to
 * be corrected: it is what makes a 0.93 m jump land in 0.58 s, and every
 * hand-built world is authored against it. So -22 is what one g LOOKS like
 * here, and a descriptor's m/s² is converted to a multiple of Earth before it
 * touches anything. @see ../core/Config.js `gravityReference`
 *
 * ── What is preserved across gravities, and what is not ───────────────────
 * Scaling gravity and leaving the jump impulse alone is not an option. Apex is
 * `v²/2g`, so Tessera at a sixth of a g would jump six times as high as it does
 * now and 5.2 times as high as Cinder - that is not a moon, it is a catapult,
 * and it would put the player on top of authored geometry that no world in the
 * game has a roof on. The other extreme, holding apex exactly (`v ∝ √g`), makes
 * the most famous fact about low gravity - you jump higher - simply not true.
 *
 * The rule chosen instead, and it is one sentence: **AIRTIME GROWS AS THE
 * SQUARE OF JUMP HEIGHT.** Double the apex and you get four times the hang
 * time. That is the difference between "floaty" and "trampoline" stated as a
 * number, and it fixes the exponent outright rather than leaving it to taste:
 * with `v = v₀·rᵏ` on a gravity of `g₀·r`, apex goes as `r^(2k-1)` and hang
 * time as `r^(k-1)`, so requiring `(k-1) = 2(2k-1)` gives **k = 1/3** and
 * nothing else. Apex `∝ r^(-1/3)`, hang time `∝ r^(-2/3)`.
 *
 * MEASURED, not derived, by driving the real integrator on Tessera (1.62 m/s²,
 * r = 0.1651, player gravity -3.633) and Verdigris (10.10, r = 1.0296, player
 * gravity -22.650). `scripts/tests/player-gravity.test.mjs` re-runs every row:
 *
 *                          default (-22)   Tessera      Verdigris
 *     jump velocity          6.400 m/s     3.509 m/s     6.463 m/s
 *     apex height            0.878 m       1.668 m       0.868 m
 *     hang time              0.533 s       1.883 s       0.533 s
 *     air acceleration      12.000 m/s²   3.607 m/s²   12.236 m/s²
 *     mid-air Δv per jump    6.982 m/s     6.982 m/s     6.982 m/s
 *     20 m fall, impact     29.70 m/s     12.00 m/s    30.20 m/s
 *     20 m fall, damage        49             0            51
 *     first drop that hurts   7.49 m       45.26 m       7.10 m
 *     first drop that kills  40.06 m      242.68 m      39.11 m
 *
 * So Tessera is 1.90x the apex for 3.53x the airtime - hang = apex², the rule,
 * to within 2% - and Verdigris is inside 1.2% of the default on both, which is
 * what a planet at 1.03 g should be. The default column is unchanged from what
 * shipped: 7.49 and 40.06 are the same two numbers `Parkour`'s header measured
 * at "about 7.5" and "40.0". @see ./Parkour.js
 *
 * ── Committed, not just slow ──────────────────────────────────────────────
 * Hang time alone would make low gravity EASIER to steer, not harder: air
 * control is `airAcceleration` applied for as long as you are off the ground,
 * so 3.5x the airtime is 3.5x the mid-air Δv, and a player could reverse a full
 * sprint twice over before landing. That is the opposite of "hard to change
 * your mind mid-air". `airAcceleration` therefore scales as `r^(1-k)` = `r^⅔`,
 * which holds the PRODUCT `a·T` - the total steering authority one jump buys -
 * invariant across every planet. You go further and you commit to it.
 *
 * ── What deliberately does NOT scale ──────────────────────────────────────
 *   - The **terminal clamp** (-60 m/s in `fixedUpdate`) is a solver limit
 *     expressed in metres per step, not a feel parameter: 1 m of travel in one
 *     60 Hz step against a 0.35 m capsule is where depenetration stops being
 *     trustworthy, and what accelerated you there is irrelevant. It is above
 *     `Parkour.LETHAL_SPEED` (42) on every world, so it never rescues a fall.
 *     On Tessera it needs 495 m of drop to bind and so never does.
 *   - The **ground-stick bias** (-2.2 m/s). It is what keeps the capsule
 *     welded to stair treads and ramp crests; scaling it down on a light world
 *     would make the player skip off every ramp in it. Being fixed is also what
 *     keeps the `-3.0` landing threshold correctly above it everywhere.
 *   - **Fall damage**, which is keyed to impact SPEED in `Parkour` and needs no
 *     change at all: `v = √(2gh)` does the scaling for free, and the table
 *     above is the proof rather than the claim. A 20 m fall costs 0 on Tessera
 *     and 51 on Verdigris; the drop that first hurts moves from 7.49 m to
 *     45.26 m and the drop that kills from 40.06 m to 242.68 m. That is the
 *     item this whole change exists for: low gravity is a feature and not a
 *     trap, and the two heights a player LEARNS move with the world they
 *     learned them on.
 *   - **Step-up, slope limit and headroom**, none of which read gravity in the
 *     first place - the step probe is geometric off `P.stepHeight` and the
 *     slope ceiling is the solver's `WALKABLE_NORMAL_Y`. The walk graph the
 *     planet reach tests flood (0.45 m step, 38°, 3.0 m drop, no jump) is
 *     therefore measuring exactly what it measured before, and everything it
 *     proves reachable is still reachable. @see ../../scripts/tests/planet-reach.test.mjs
 *
 * ── Who else reads the ratio, and what each does with it ──────────────────
 * The player was the first consumer and is no longer the only one. Everything
 * below goes through `worldGravityRatio` in `../worlds/WorldRules.js`, and
 * each applies the exponent ITS OWN quantity has - which is the whole reason
 * the three scales are published as plain numbers rather than left to be
 * recomputed, because a consumer that wrote `Math.pow(ratio, 1/3)` for itself
 * would be a second definition of the design rule:
 *
 *   `Parkour`  the dive. `DIVE_ACCEL` is a downward ACCELERATION, so it takes
 *              {@link Player#gravityRatio} and a dive stays 0.73x the world it
 *              is in rather than becoming 4.4x Tessera. `DIVE_FORWARD` is air
 *              control by another name and takes {@link Player#airScale}, so
 *              the forward carry one dive buys is invariant for the same reason
 *              `a·T` is. `DIVE_MIN_FALL` is a vertical SPEED and takes
 *              {@link Player#jumpScale}, so the dive arms at the same fraction
 *              of the arc everywhere. @see ./Parkour.js
 *   `Climb`    the lowest ledge worth a mantle, whose whole justification is
 *              "a jump already clears this", so it reads
 *              {@link Player#jumpApex} - the number that sentence is about.
 *              @see ./Climb.js
 *   `NPC`      resolves `_gravity` off the same ratio, so a beast, a corpse
 *              and the player who shot it all fall together. Until it did, the
 *              player floated on Tessera and the wildlife plummeted at -22.
 *              @see ../npc/NPC.js
 */
/* The ratio itself, its [0.01, 4] clamp and the one warning it logs live in
 * `../worlds/WorldRules.js` as `worldGravityRatio`. They moved there the day
 * the player stopped being the only body that falls: the dive, the mantle and
 * every NPC divide by the same number now, and four copies of a division are
 * four chances to disagree about the same planet. What stays HERE is the LAW
 * built on top of it, which is the block above and the two exponents below. */
/** Jump-velocity exponent. Derived, not tuned - see the block above. */
const JUMP_EXP = 1 / 3;
/** Air-control exponent. `1 - JUMP_EXP`, which is what holds `a·T` invariant. */
const AIR_EXP = 1 - JUMP_EXP;

/**
 * Returned in place of a real look delta when something else owns the mouse.
 * Frozen because it is handed out every frame and must never be written to.
 */
const ZERO_LOOK = Object.freeze({ dx: 0, dy: 0 });

export class Player {
  /**
   * @param {{ scene: THREE.Scene, engine: import('../core/Engine.js').Engine,
   *           physics: import('../physics/Physics.js').Physics,
   *           bus: import('../core/EventBus.js').EventBus, materials: any,
   *           input: import('../core/Input.js').Input,
   *           camera: THREE.PerspectiveCamera }} ctx
   */
  constructor({ scene, engine, physics, bus, materials, input, camera }) {
    this.scene = scene;
    this.engine = engine;
    this.physics = physics;
    this.bus = bus;
    this.materials = materials;
    this.input = input;
    this.camera = camera;

    /* ---- kinematics ---- */
    this._position = new THREE.Vector3(0, 2, 0);
    this._velocity = new THREE.Vector3();
    this._yaw = 0;
    this._pitch = 0;
    this._grounded = false;
    this._wasGrounded = false;
    this._groundNormal = new THREE.Vector3(0, 1, 0);
    this._coyote = 0;
    this._jumpBuffer = 0;
    this._jumpHeld = false;
    this._capsuleHeight = STAND_HEIGHT;
    this._eyeHeight = STAND_EYE;
    this._crouching = false;
    this._sprinting = false;

    /* ---- gravity, and the three constants it moves ---- *
     * Resolved once per world change rather than per step: `setWorldGravity`
     * is the only writer, `world:changed` is the only caller, and the fixed
     * step then reads three plain numbers with no branch and no lookup. They
     * are seeded at exactly the config values, so a world that publishes no
     * gravity - which is every world but the planets - is byte-for-byte the
     * game that shipped. @see the design block above `JUMP_EXP` */
    this._gravityRatio = 1;
    this._gravity = P.gravity;
    /** `ratio ** JUMP_EXP`. Held separately because `Parkour.tryLeap` writes an
     *  absolute lift off the config and this is what rescales it, and because
     *  `Parkour`'s dive threshold is a vertical speed with the same exponent. */
    this._jumpScale = 1;
    /** `ratio ** AIR_EXP`. The scale on any mid-air steering acceleration. */
    this._airScale = 1;
    this._jumpVelocity = P.jumpVelocity;
    this._airAcceleration = P.airAcceleration;
    /** Closed-form apex of a standing jump on this world, metres. @see jumpApex */
    this._jumpApex = (P.jumpVelocity * P.jumpVelocity) / (2 * -P.gravity);

    /* ---- view feel ---- */
    this._stepSmooth = 0;
    this._bobDist = 0;
    this._bobPhase = 0;
    this._bobWeight = 0;
    this._footAccum = 0;
    this._footIndex = 0;
    this._dip = 0;
    this._dipVel = 0;
    this._roll = 0;
    this._fov = CONFIG.render.fov;
    /**
     * Additive FOV punch in degrees, decayed in `_applyFov`.
     *
     * Distinct from the sprint kick, which is a state: this is an EVENT, and it
     * has to be able to fire while the sprint kick is already at its ceiling -
     * a leap is taken at a sprint by definition. @see punchFov
     */
    this._fovPunch = 0;
    /**
     * Body-state view offsets: a bank and a pitch written by whichever movement
     * module owns the body this frame, composed in `_applyCamera`.
     *
     * NOT folded into `_roll` and `_pitch`. `_roll` is a damped spring chasing
     * the strafe input, and handing it a half-second envelope makes the damper
     * lag the pose it is supposed to be following; `_pitch` is the aim, and the
     * whole rule about `applyViewKick` is that a body movement moves the camera
     * and never the aim.
     */
    this._poseRoll = 0;
    this._posePitch = 0;
    /**
     * True while the capsule is held at `Parkour.ROLL_HEIGHT` because an
     * ordinary crouch does not fit where the roll has put us.
     *
     * Written by the stance block, read by the eye spring. It is not the same
     * thing as `parkour.rolling` - the roll is over by then; what is left is a
     * player under a beam who cannot stand up yet.
     */
    this._stancePinned = false;
    this._lastLookX = 0;
    this._lastLookY = 0;

    /* ---- health ---- */
    this._maxHealth = P.maxHealth;
    this._health = P.maxHealth;
    this._dead = false;
    this._lastDamageAt = -999;
    /* ---- the two deadlines on the BUFF clock ------------------------------
     *
     * Both are seconds of `engine.simElapsed`, not of `_elapsed`. Everything
     * else in this block is on `_elapsed`, so read `_buffNow()` before
     * touching either of them. @see _buffNow */
    this._invulnUntil = 0;
    this._speedBoostUntil = 0;
    this._speedBoostMul = 1;
    this._deathAt = 0;
    this._regenCarry = 0;
    this._elapsed = 0;
    /** Set by main.js once MountManager exists; Armour tiers read through it. */
    this.mounts = null;

    /* ---- impact: knockback, bleed, view kick ---- */
    /**
     * Seconds of reduced ground friction after an impulse.
     *
     * Without it a knockback is invisible. Source-style friction at
     * `P.friction` = 10 sheds a 7 m/s shove in about three tenths of a second
     * and the player travels perhaps 40 cm - which reads as a stutter, not as
     * being thrown. Cutting friction for a moment lets the impulse actually
     * carry, and cutting it rather than disabling it means the player never
     * loses control for longer than they can feel.
     */
    this._impulseTime = 0;
    /** Damage per second of the active bleed, and how long is left of it. */
    this._bleedRate = 0;
    this._bleedTime = 0;
    this._bleedCarry = 0;
    this._bleedSource = null;
    /**
     * View kick: a damped spring per axis, entirely separate from the
     * `camera:shake` event five systems already emit. See `applyViewKick`.
     */
    this._kick = { pitch: 0, yaw: 0, roll: 0, vp: 0, vy: 0, vr: 0 };

    /* ---- spawn anchor ---- */
    this._spawnPosition = this._position.clone();
    this._spawnYaw = 0;

    /** Set by the screenshot harness to hand camera control over. */
    this._harnessFrozen = false;
    this._frozenApplied = false;

    /* ---- external drivers ---- */
    /**
     * Set true by `MountManager` while a mount owns the player's movement.
     * Contract: CONTRACTS-V2.md 3.3. While it is set this class integrates
     * nothing - the mount writes `position` (and optionally `yaw`) directly -
     * but the capsule is still resolved so you cannot ride through a wall.
     * @type {boolean}
     */
    this.movementOverride = false;
    /** Let a mount opt out of the capsule resolve (free flight well clear of geometry). */
    this.movementOverrideCollide = true;
    /** Let a mount own yaw/pitch entirely instead of taking mouse-look from here. */
    this.movementOverrideLook = true;
    /**
     * True while `movementOverride` was raised by *this* class - swimming or a
     * mantle - rather than by a mount.
     *
     * Reusing the mount flag is deliberate. Everything that has to stand down
     * when another system is driving the capsule already keys off it:
     * `UnstuckSystem` suspends its wedge and free-fall detectors (a swimmer
     * pressing into a pool wall is textbook "wedged"), and `PlayerAvatar` drops
     * foot IK and its free-fall starfish, both of which fight a swim pose. The
     * flag says "the controller is not integrating normal locomotion", which is
     * exactly true here.
     * @type {boolean}
     */
    this._selfOverride = false;

    /** @type {import('./CameraRig.js').CameraRig|null} set by CameraRig's constructor. */
    this.cameraRig = null;

    /**
     * Set by main.js once the weapon Loadout exists. Its presence transfers
     * ownership of the viewmodel and fire input away from `_driveWeapon`.
     */
    this.loadout = null;
    /** @type {import('./PlayerAvatar.js').PlayerAvatar|null} set by PlayerAvatar's constructor. */
    this.avatar = null;

    /** Engine time of the last shot. The avatar uses it to hold an aim pose. */
    this._lastFiredAt = -999;

    // Combat resolves hits, but the player owns the health model and the weapon.
    this._weapon = new Weapon({ scene, camera, bus, materials, engine, input });

    /* ---- movement modes owned by this controller (CONTRACTS-V3 3.1) ---- */
    /** @type {import('./Swim.js').Swim} */
    this.swim = new Swim({ player: this, physics, bus, input });
    /** @type {import('./Climb.js').Climb} */
    this.climb = new Climb({ player: this, physics, bus, input });
    /**
     * Sustained wall climbing. Distinct from `climb`, which is a one-shot
     * mantle over a ledge - this is the state you live in while scaling a
     * tower, and it hands off to `climb` to get over the lip.
     * @type {import('./FreeClimb.js').FreeClimb}
     */
    this.freeClimb = new FreeClimb({ player: this, physics, bus, input });
    /**
     * Leap, dive, roll, and the fall damage that gives them a point.
     * `worldManager` is injected later by main.js - it does not exist yet.
     * @type {import('./Parkour.js').Parkour}
     */
    this.parkour = new Parkour({ player: this, bus, input, worldManager: null });
    /**
     * Shared exertion pool. `main.js` constructs the real one and it attaches
     * itself here; if that wiring is absent the player builds its own on the
     * first step, so sprint gating and swim drain always work.
     * @type {import('../systems/Stamina.js').Stamina|null}
     */
    this.stamina = null;

    /**
     * `WaterVolumes` is constructed after the player, so it cannot be passed
     * in. It publishes itself on the bus instead - and answers `water:request`
     * for the case where it was constructed first and we missed the broadcast.
     */
    this._offWater = bus.on('water:volumes', (e) => {
      if (!e?.water) return;
      this.swim.setVolumes(e.water);
      // An orchestrator-owned instance always wins over our fallback.
      if (this._ownWater && e.water !== this._ownWater) {
        this._ownWater.dispose();
        this._ownWater = null;
      }
    });
    /** Fallback water scanner, built only if nothing else announces one. */
    this._ownWater = null;
    /** Most recent active world, so a late fallback can scan it immediately. */
    this._lastWorld = null;
    this._offWorldReady = bus.on('world:changed', (e) => {
      this._lastWorld = e?.world ?? null;
    });
    bus.emit('water:request', {});

    // A mount taking over supersedes swimming and climbing outright, and owns
    // `movementOverride` from that moment on.
    this._offMounted = bus.on('mount:mounted', () => {
      this._selfOverride = false;
      this.swim.cancel();
      this.climb.cancel();
      this.freeClimb.cancel();
    });
    this._offWorld = bus.on('world:changing', () => {
      this.swim.cancel();
      this.climb.cancel();
      this.freeClimb.cancel();
      this.parkour.cancel();
      this._releaseMovement();
    });

    /** Installed lazily on the first frame - see `_installLatePose`. */
    this._offLate = null;
    /**
     * Optional fourth late-pose module, assigned by main.js.
     * @type {{applyPose:(dt:number, elapsed:number)=>void}|null}
     */
    this.minigamePose = null;

    // Third-person parallax correction.
    //
    // ORDERING IS LOAD-BEARING: this subscription must be registered before
    // CombatSystem's so that Combat resolves the corrected origin/direction.
    // `main.js` constructs the Player before the CombatSystem and EventBus
    // dispatches in subscription order, which is what makes that true. The
    // payload is rewritten in place rather than re-emitted because a second
    // `weapon:fired` would double the tracer, the HUD kick and the NPC alert.
    // Anything that would rather resolve the shot itself can call
    // `player.resolveShot(origin, direction)` and skip this path entirely.
    this._offFired = bus.on('weapon:fired', (evt) => {
      this._lastFiredAt = this._elapsed;
      this.cameraRig?.correctShotEvent(evt);
    });

    /* `camera:shake` had eight emitters across Combat, Projectiles, Bow,
     * Fireball and Sword, and no listener anywhere in the tree - every
     * explosion, sword hit and death has been firing it into nothing. Rather
     * than add a ninth emitter for the maul and leave the rest dead, route the
     * event into the same kick spring.
     *
     * The scales are NOT the same and must not be conflated: `viewKick` is in
     * radians (0.12 is a bear's paw), while `amount` here runs 0.03 for a bow
     * draw to 0.62 for the death lurch. 0.55 rad per unit puts the bow at ~1
     * degree and death at ~20, which is the spread the emitters clearly meant.
     *
     * Roll alternates by event so a burst of hits shudders instead of nudging
     * the view the same way n times. Deterministic, not random, so a test can
     * assert it. */
    this._shakeParity = 1;
    this._offShake = bus.on('camera:shake', (e) => this.applyShake(e?.amount ?? 0));

    /** Active world, tracked for capability rules. @see ../worlds/WorldRules.js */
    this._world = null;
    /* One handler for both, and deliberately not two: the capability flags and
     * the gravity are read off the same object and must never be a world
     * apart. A second subscription would run in registration order and a
     * reorder would be invisible until someone jumped on the wrong planet. */
    this._offRules = this.bus?.on('world:changed', ({ world }) => {
      this._world = world;
      this.setWorldGravity(world);
    }) ?? null;

    this.camera.rotation.order = 'YXZ';
    this._applyCamera(0);
  }

  /* ================================================================ */
  /* Accessors (contract)                                              */
  /* ================================================================ */

  /** Live reference to the feet position. Do not retain a copy. */
  get position() {
    return this._position;
  }

  get yaw() {
    return this._yaw;
  }

  get pitch() {
    return this._pitch;
  }

  get health() {
    return this._health;
  }

  get maxHealth() {
    return this._maxHealth;
  }

  get isDead() {
    return this._dead;
  }

  get weapon() {
    return this._weapon;
  }

  get velocity() {
    return this._velocity;
  }

  get grounded() {
    return this._grounded;
  }

  /** Downward acceleration this world integrates, m/s². Negative. */
  get gravity() {
    return this._gravity;
  }

  /** This world's gravity as a multiple of `CONFIG.player.gravity`. 1 by default. */
  get gravityRatio() {
    return this._gravityRatio;
  }

  /** Upward speed a jump writes here, m/s. @see setWorldGravity */
  get jumpVelocity() {
    return this._jumpVelocity;
  }

  /** Mid-air steering authority, m/s². @see setWorldGravity */
  get airAcceleration() {
    return this._airAcceleration;
  }

  /**
   * `ratio ^ 1/3` - what any VERTICAL SPEED authored against `CONFIG.player`
   * must be multiplied by on this world. 1 by default.
   *
   * Published rather than left to be recomputed: `Parkour` needs it for the
   * leap lift and the dive threshold, and an exponent written down twice is a
   * design rule with two definitions. @see setWorldGravity
   */
  get jumpScale() {
    return this._jumpScale;
  }

  /**
   * `ratio ^ 2/3` - the scale on any MID-AIR ACCELERATION, which is what holds
   * `a·T` invariant. 1 by default. @see setWorldGravity
   */
  get airScale() {
    return this._airScale;
  }

  /**
   * How high a standing jump goes on this world, metres, closed form.
   *
   * `v²/2g` off the two resolved numbers rather than a remembered 0.93. The 60
   * Hz integrator quantises about 5.6% under it (0.878 m measured against 0.931
   * analytic at default gravity), so this is the GENEROUS side - which is the
   * correct side for anything asking "would a jump already have cleared that".
   * @see ./Climb.js `MIN_RISE_GROUND`
   */
  get jumpApex() {
    return this._jumpApex;
  }

  get isCrouching() {
    return this._crouching;
  }

  get isSprinting() {
    return this._sprinting;
  }

  /**
   * THE BUFF CLOCK: seconds of gameplay, from the engine.
   *
   * `_elapsed` is the wrong clock for anything a player is promised a DURATION
   * of, and the failure is not a rounding error. `_elapsed` is *assigned* from
   * the engine inside `fixedUpdate`/`update`, and main.js runs neither while a
   * UI panel holds gameplay - so while the inventory is open this clock is
   * frozen at the moment the bag opened, and the instant the bag closes it
   * jumps forward by however long the player was in there.
   *
   * Measured consequence: a Velocity Crown used forty seconds into a browse
   * wrote `_speedBoostUntil = (open + 30)`, `_elapsed` then snapped to
   * `open + 45`, and the thirty-second boost was over before the panel closed.
   * The player watched the item leave the bag and got nothing. A five-second
   * Aegis Shard could not survive being used AT ALL, because the bag cannot be
   * opened, navigated and closed in under five seconds.
   *
   * `engine.simElapsed` is the same seconds without the jump: it stops while
   * gameplay stops, so a deadline written against it is a deadline in play
   * time. It is also the clock `systems/ActiveEffects.js` counts the HUD chip
   * down on, which is why the chip and the buff cannot disagree.
   *
   * Falls back to `_elapsed` for a Player built without an engine (the unit
   * tests do this), which restores the old behaviour exactly rather than
   * freezing every buff at zero.
   *
   * @returns {number} seconds
   */
  _buffNow() {
    return this.engine?.simElapsed ?? this._elapsed;
  }

  /** True while respawn invulnerability or a shield is active. */
  get isInvulnerable() {
    return this._buffNow() < this._invulnUntil;
  }

  get speedMultiplier() {
    return this._buffNow() < this._speedBoostUntil ? this._speedBoostMul : 1;
  }

  /** Eye position in world space. A fresh vector each call, per the contract. */
  get eyePosition() {
    return new THREE.Vector3(
      this._position.x,
      this._position.y + this._eyeHeight,
      this._position.z
    );
  }

  /** Look direction including pitch. Fresh vector each call. */
  get forward() {
    const cp = Math.cos(this._pitch);
    return new THREE.Vector3(
      -Math.sin(this._yaw) * cp,
      Math.sin(this._pitch),
      -Math.cos(this._yaw) * cp
    );
  }

  /* ---- view state, read by CameraRig and PlayerAvatar ------------- */

  /** Current (smoothed) eye height above the feet, in metres. */
  get eyeHeight() {
    return this._eyeHeight;
  }

  /** Current (smoothed) capsule height. Shrinks on crouch. */
  get capsuleHeight() {
    return this._capsuleHeight;
  }

  /** Residual stair-step absorption the camera is still paying off. */
  get stepSmoothing() {
    return this._stepSmooth;
  }

  /** Landing-dip spring offset, negative while absorbing an impact. */
  get viewDip() {
    return this._dip;
  }

  /** Strafe roll in radians. */
  get viewRoll() {
    return this._roll;
  }

  get bobPhase() {
    return this._bobPhase;
  }

  get bobWeight() {
    return this._bobWeight;
  }

  /** Stance blend, 0 standing to 1 fully crouched. Follows the capsule, so it is smooth. */
  get crouchAmount() {
    return clamp((STAND_HEIGHT - this._capsuleHeight) / (STAND_HEIGHT - CROUCH_HEIGHT), 0, 1);
  }

  /** True while the aim (RMB) input is held and usable. */
  get isAiming() {
    return !this._dead && !this.input.textCaptured && !!this.input.state.aim;
  }

  /** ADS blend, 0..1, sourced from the weapon so FOV and boom agree. */
  get aimProgress() {
    return this._weapon?.aimProgress ?? 0;
  }

  /** Engine time of the last shot fired. */
  get lastFiredAt() {
    return this._lastFiredAt;
  }

  get isThirdPerson() {
    return this.cameraRig?.isThird ?? false;
  }

  /* ---- swim / climb / stamina state, read by the HUD and the avatar --- */

  /** True while the swim controller owns movement. */
  get isSwimming() {
    return this.swim.active;
  }

  /** Metres of water over the feet, 0 when dry. */
  get swimDepth() {
    return this.swim.depth;
  }

  /** True while the eyes are under a water surface. */
  get isUnderwater() {
    return this.swim.submerged;
  }

  /** Seconds of air remaining. Full whenever the head is out of the water. */
  get oxygen() {
    return this.swim.oxygen;
  }

  get maxOxygen() {
    return this.swim.maxOxygen;
  }

  /** True while a mantle is in flight. */
  get isClimbing() {
    return this.climb.active;
  }

  /** The ledge in front of the player, or null. Drives the `[Space] Climb` prompt. */
  get climbCandidate() {
    return this.climb.candidate;
  }

  /** True while clinging to a wall. Distinct from `isClimbing`, the mantle. */
  get isFreeClimbing() {
    return this.freeClimb.active;
  }

  /** True when a wall is in reach to grab. Drives the parkour prompt. */
  get wallCandidate() {
    return this.freeClimb.candidate;
  }

  /** Current stamina as a number. `player.stamina` is the pool object itself. */
  get staminaValue() {
    return this.stamina?.value ?? 0;
  }

  get maxStamina() {
    return this.stamina?.max ?? P.maxStamina;
  }

  /** World point the crosshair is over, or null before the rig exists. */
  get aimPoint() {
    return this.cameraRig?.aimPoint ?? null;
  }

  /** Yaw setter for mounts, which own orientation while `movementOverride` is set. */
  setYaw(y) {
    this._yaw = y;
  }

  setPitch(p) {
    this._pitch = clamp(p, -MAX_PITCH, MAX_PITCH);
  }

  /**
   * Where the player's next shot starts and which way it travels.
   *
   * First person is the camera line, unchanged. Third person is the avatar's
   * muzzle aimed at whatever the crosshair is over. Weapons that emit their own
   * `weapon:fired` should call this rather than reading the camera directly.
   *
   * @param {THREE.Vector3} outOrigin
   * @param {THREE.Vector3} outDirection
   * @returns {boolean} true if the shot was corrected for third-person parallax
   */
  resolveShot(outOrigin, outDirection) {
    if (this.cameraRig) return this.cameraRig.resolveShot(outOrigin, outDirection);
    this.camera.getWorldPosition(outOrigin);
    this.camera.getWorldDirection(outDirection);
    return false;
  }

  /**
   * Adopt a world's published surface gravity, or fall back to the config.
   *
   * The ONLY writer of `_gravity`, `_jumpVelocity`, `_jumpScale`, `_airScale`,
   * `_airAcceleration` and `_jumpApex`. Called from the `world:changed`
   * handler, and public so that a test or the dev harness can drive a planet
   * without a world manager.
   *
   * A world that publishes nothing - station, medieval, citadel, sports, race,
   * maze, dock, the yard, and `null` before the first world loads - restores
   * the config values EXACTLY, by assignment and not by a multiply, so there is
   * no float residue to make an unchanged world drift. Everything downstream is
   * then multiplying by a literal 1, which IEEE-754 leaves alone to the bit.
   *
   * @param {{gravity?:number, id?:string}|null|undefined} world
   * @see the design block above `JUMP_EXP`
   * @see ../worlds/WorldRules.js `worldGravityRatio` for the clamp
   */
  setWorldGravity(world) {
    const published = worldGravity(world);
    /* No opinion published: restore the shipped feel by assignment. */
    if (published === null) {
      this._gravityRatio = 1;
      this._jumpScale = 1;
      this._airScale = 1;
      this._gravity = P.gravity;
      this._jumpVelocity = P.jumpVelocity;
      this._airAcceleration = P.airAcceleration;
      this._jumpApex = (P.jumpVelocity * P.jumpVelocity) / (2 * -P.gravity);
      return;
    }

    /* The division, the clamp and the one warning it logs are all in
     * `worldGravityRatio` - the same function `NPC` and, through it, every
     * beast in the world call. @see ../worlds/WorldRules.js */
    const ratio = worldGravityRatio(world);

    this._gravityRatio = ratio;
    this._gravity = P.gravity * ratio;
    /* Apex ∝ r^(-1/3), hang time ∝ r^(-2/3): airtime grows as the square of
     * jump height, which is the whole design rule. */
    this._jumpScale = Math.pow(ratio, JUMP_EXP);
    this._jumpVelocity = P.jumpVelocity * this._jumpScale;
    /* `a · T` invariant, so one jump buys the same total mid-air Δv on every
     * planet however long it lasts. */
    this._airScale = Math.pow(ratio, AIR_EXP);
    this._airAcceleration = P.airAcceleration * this._airScale;
    /* Derived from the two resolved numbers, not from the exponent again: a
     * second closed form is a second thing to keep in step. `_gravity` is
     * negative and clamped away from zero at both ends, so this cannot divide
     * by zero and cannot go non-finite. */
    this._jumpApex = (this._jumpVelocity * this._jumpVelocity) / (2 * -this._gravity);
  }

  /* ================================================================ */
  /* Fixed-rate simulation                                             */
  /* ================================================================ */

  /**
   * Deterministic movement step. Runs at 60 Hz regardless of frame rate.
   * @param {number} dt fixed timestep in seconds
   * @param {number} elapsed engine time in seconds
   */
  fixedUpdate(dt, elapsed) {
    this._elapsed = elapsed;
    this._impulseTime = Math.max(0, this._impulseTime - dt);
    this._tickBleed(dt);
    this._tickHealth(dt, elapsed);
    if (!this.stamina) new Stamina({ bus: this.bus, player: this });
    this.stamina.fixedUpdate(dt, elapsed);
    this._ensureWater();

    if (this._dead) {
      // Corpses still fall, so the camera settles on the floor rather than
      // hanging in mid-air.
      this._velocity.x = damp(this._velocity.x, 0, 6, dt);
      this._velocity.z = damp(this._velocity.z, 0, 6, dt);
      // The world's gravity, not the config's: a corpse on a sixth-g moon
      // settles at a sixth of a g, or death is the one place the planet stops.
      this._velocity.y += this._gravity * dt;
      this._position.addScaledVector(this._velocity, dt);
      this.physics.resolveCapsule(this._position, P.radius, CROUCH_HEIGHT);
      if (elapsed - this._deathAt > RESPAWN_DELAY) this.respawn();
      return;
    }

    // A mount owns movement: it has already written `position` (and possibly
    // `velocity` and `yaw`) this step. We contribute only the collision resolve,
    // so a rider still cannot pass through a wall, and the stance/bob state that
    // the avatar and the HUD read.
    if (this.movementOverride && !this._selfOverride) {
      if (this.swim.active) this.swim.cancel();
      if (this.climb.active) this.climb.cancel();
      /* And the roll, for the reason the other two are here: this branch
       * RETURNS, so `parkour.fixedUpdate` never runs while a mount owns the
       * body - but `update()` is not gated and keeps reading `rolling`.
       * Measured: tap crouch at a sprint, summon a mount inside the 0.55 s
       * roll, and `rollTime` freezes at 0.55 with the eye pinned at
       * `Parkour.ROLL_EYE` - the third-person boom pivot 1.07 m below the
       * rider - for the entire ride. @see ./Parkour.js `cancel` */
      this.parkour.cancel();
      this._crouching = false;
      this._stancePinned = false;
      this._sprinting = false;
      this._capsuleHeight = damp(this._capsuleHeight, STAND_HEIGHT, 16, dt);
      if (this.movementOverrideCollide) {
        const res = this.physics.resolveCapsule(this._position, P.radius, this._capsuleHeight);
        this._wasGrounded = this._grounded;
        this._grounded = res.grounded;
        this._groundNormal.copy(res.groundNormal);
      }
      this._coyote = 0;
      this._jumpBuffer = 0;
      this._jumpHeld = !!this.input.state.jump;
      this._bobWeight = damp(this._bobWeight, 0, 9, dt);
      return;
    }

    const s = this.input.state;
    // Edge-detected here, once, because both the mantle and the jump buffer
    // consume it and whichever ran first would otherwise eat the other's press.
    const jumpEdge = !!s.jump && !this._jumpHeld;

    /* ---- mantle in flight ------------------------------------------- *
     * The hoist writes the capsule itself along a path it already proved
     * clear, so nothing below this runs - including the collision resolve,
     * which would eject the capsule out of the very wall it is climbing. */
    if (this.climb.active) {
      this._claimMovement();
      // Same reason as the mount branch above: this returns before
      // `parkour.fixedUpdate`, so a roll caught by a mantle would freeze rather
      // than finish, and the frozen `rolling` would hold the eye at 0.55 m for
      // the length of the hoist.
      this.parkour.cancel();
      this._jumpHeld = !!s.jump;
      this.climb.fixedUpdate(dt, elapsed);
      // The final step of a hoist calls `setClimbLanding`, which publishes the
      // real ground state; only overwrite it while still in the air.
      if (this.climb.active) {
        this._grounded = false;
        this._coyote = 0;
      }
      this._jumpBuffer = 0;
      this._bobWeight = damp(this._bobWeight, 0, 12, dt);
      return;
    }

    // Dive steering and the roll timer run before any movement branch claims
    // the step: a dive is an *airborne* modifier, so it has to apply whether
    // the player is falling normally or has just kicked off a wall.
    // Sustained wall climbing and diving, off in worlds that forbid it.
    if (allows(this._world, 'parkour')) this.parkour.fixedUpdate(dt);

    /* ---- clinging to a wall ------------------------------------------ *
     * Above water and below the mantle, because a free climb ends *in* a
     * mantle: `FreeClimb` calls `climb.tryStart` when it crests the lip, and
     * the branch above then owns the last metre. Like the mantle it writes the
     * capsule itself, so nothing below runs.
     * Gated on 'climb', off in worlds that forbid it - `&&`-shorted so the
     * whole block is skipped rather than just the call, since it claims the
     * movement step and returns early below. */
    if (allows(this._world, 'climb') && this.freeClimb.fixedUpdate(dt, elapsed)) {
      this._claimMovement();
      this._jumpHeld = !!s.jump;
      this._grounded = false;
      this._coyote = 0;
      this._jumpBuffer = 0;
      this._bobWeight = damp(this._bobWeight, 0, 12, dt);
      return;
    }

    /* ---- water ------------------------------------------------------- */
    if (this.swim.fixedUpdate(dt, elapsed)) {
      this._claimMovement();
      this._jumpHeld = !!s.jump;
      // A tap of Space at a pool wall hauls the player out; holding it just
      // swims up, so the mantle only ever consumes the leading edge.
      if (jumpEdge && this.climb.tryStart(elapsed, { inWater: true })) {
        this.swim.cancel();
      } else if (s.forward > 0) {
        this.climb.poll(true);
      }
      return;
    }
    this._releaseMovement();

    /* ---- stance ---------------------------------------------------- *
     * A roll owns the stance outright for its duration. It has to: a dodge is
     * a TAP of crouch, so by the second frame `s.crouch` is already false and
     * the block below would be standing the capsule back up underneath a body
     * that is still somersaulting. This is one of the two real readers of
     * `parkour.rolling`; the other is the eye spring in `update()`, which is a
     * separate spring and does not follow the capsule. */
    const rollTuck = allows(this._world, 'parkour') ? this.parkour.rollTuck : 0;
    if (rollTuck > 0) {
      // The crouch key is still the roll key, so a crouch held through a roll
      // must not also read as a stance change and rustle cloth every frame.
      const wasCrouching = this._crouching;
      this._crouching = false;
      if (wasCrouching) this.bus?.emit('player:crouch', { crouching: false });
      this.setRollStance(rollTuck, dt);
    } else {
      const wasCrouching = this._crouching;
      const wantsCrouch = s.crouch;
      /* Never stand up into a ceiling. The second term is a cheap gate on the
       * raycast - and it asks the CAPSULE rather than `_crouching`, because a
       * roll that ends under a low beam leaves the capsule tucked with
       * `_crouching` already false, and asking the flag would let it grow
       * straight back into the beam it had just gone under. */
      const tucked = this._crouching || this._capsuleHeight < STAND_HEIGHT - 0.01;
      if (!wantsCrouch && tucked && !this._hasHeadroom(STAND_HEIGHT)) {
        this._crouching = true;
      } else {
        this._crouching = wantsCrouch;
      }
      // Audio cares about the transition, not the state: cloth moves when the
      // stance changes, in either direction.
      if (this._crouching !== wasCrouching) {
        this.bus?.emit('player:crouch', { crouching: this._crouching });
      }
      const targetHeight = this._fittingHeight(this._crouching ? CROUCH_HEIGHT : STAND_HEIGHT);
      this._stancePinned = targetHeight < CROUCH_HEIGHT;
      this._capsuleHeight = damp(this._capsuleHeight, targetHeight, 16, dt);
    }

    /* ---- wish direction -------------------------------------------- */
    const sinY = Math.sin(this._yaw);
    const cosY = Math.cos(this._yaw);
    // Facing is -Z at yaw 0.
    const fwdX = -sinY;
    const fwdZ = -cosY;
    const rightX = cosY;
    const rightZ = -sinY;

    let wishX = fwdX * s.forward + rightX * s.right;
    let wishZ = fwdZ * s.forward + rightZ * s.right;
    const wishLen = Math.hypot(wishX, wishZ);
    if (wishLen > 1e-5) {
      wishX /= wishLen;
      wishZ /= wishLen;
    }

    const aiming = !!s.aim;
    // Sprint is gated on stamina, and the gate latches until the pool has
    // recovered a fifth - see the note on exhaustion in systems/Stamina.js.
    this._sprinting =
      !!s.sprint &&
      !aiming &&
      !this._crouching &&
      s.forward > 0 &&
      wishLen > 0.1 &&
      this._grounded &&
      (this.stamina ? this.stamina.canSprint : true);
    if (this._sprinting) this.stamina?.drain(P.sprintStaminaDrain * dt, 'sprint');

    /* `sprintWishSpeed`, not `sprintSpeed`, and the distinction is the point:
     * the accelerator takes a target it is allowed not to reach, and friction
     * caps a grounded character at `acceleration / friction` = 8.2 m/s however
     * high that target is. @see ../core/Config.js `sprintSpeed` */
    let wishSpeed = this._crouching ? P.crouchSpeed : this._sprinting ? P.sprintWishSpeed : P.walkSpeed;
    const boost = this.speedMultiplier;
    wishSpeed *= boost;
    if (aiming && !this._crouching) wishSpeed *= 0.62;
    if (wishLen < 1e-5) wishSpeed = 0;

    /* ---- acceleration ---------------------------------------------- */
    if (this._grounded) {
      this._applyFriction(dt);
      /* The boost scales the ACCELERATION as well as the wish, and that is the
       * only reason a speed pickup does anything to a sprint. Scaling the wish
       * alone is what it used to do, and a sprint is already over the cap, so
       * 1.5x and 3.0x both measured exactly the cap and the pickup read as a
       * no-op to anyone who tried it while running. The cap is
       * `acceleration / friction`, so multiplying the numerator moves the
       * ceiling with the wish: a 1.5x boost tops out at 1.5 * 8.2 = 12.3 while
       * sprinting and at 1.5 * 4.6 = 6.9 while walking, which is a boost felt
       * at every gait rather than at one. Friction is untouched - a boosted
       * player still stops in the same time, just from further out.
       *
       * Ground only: `_applyFriction` is what creates a ceiling to raise, and
       * it never runs in the air. Air control keeps its own authority. */
      this._accelerate(wishX, wishZ, wishSpeed, P.acceleration * boost, dt);
    } else {
      /* Air control: same projection, far less authority - and on a light
       * world, less again. `_airAcceleration` scales as `r^⅔` against a hang
       * time that scales as `r^-⅔`, so the total Δv one jump buys is the same
       * everywhere and a long floaty arc is a COMMITMENT rather than three
       * times the usual steering. @see setWorldGravity */
      this._accelerate(wishX, wishZ, wishSpeed, this._airAcceleration, dt);
    }

    /* ---- mantle: offered before the jump, never instead of it -------- *
     * `tryStart` only succeeds when a real ledge is in front, above jump
     * apex and under 2.4 m, with proven standing room. Everything else -
     * kerbs, stair treads, skate-park transitions - fails the probe and the
     * press falls straight through to the jump below. */
    // One-shot ledge mantling, off in worlds that forbid it.
    if (jumpEdge && allows(this._world, 'climb') && this.climb.tryStart(elapsed, { inWater: false })) {
      this._jumpHeld = true;
      this._jumpBuffer = 0;
      this._coyote = 0;
      this._claimMovement();
      return;
    }
    // Keep the prompt live while walking into something, and only then: the
    // probe is three short raycasts and there is no reason to pay for it while
    // standing still or backing away.
    if (!this._grounded || s.forward > 0) this.climb.poll(false);

    /* ---- grab a wall -------------------------------------------------- *
     * Offered *after* the mantle and before the jump, which is the whole
     * priority order in one line: if there is a ledge you can get over, get
     * over it; if there is only wall, hold on to it; otherwise jump.
     *
     * Space held rather than pressed, and pushing forward. Holding is what
     * distinguishes "I meant to climb this" from "I jumped near a wall", and
     * requiring forward means backing away from a facade never grabs it. A
     * running jump into a wall grabs it, which is the interaction the citadel
     * is built around. Gated on 'climb', off in worlds that forbid it. */
    if (s.jump && s.forward > 0.2 && allows(this._world, 'climb') && this.freeClimb.tryAttach()) {
      this._jumpHeld = true;
      this._jumpBuffer = 0;
      this._coyote = 0;
      this._claimMovement();
      return;
    }
    if (!this._grounded && s.forward > 0) this.freeClimb.poll();

    /* ---- jump: coyote time + input buffering ------------------------ */
    this._coyote = this._grounded ? COYOTE_TIME : Math.max(0, this._coyote - dt);
    if (s.jump && !this._jumpHeld) this._jumpBuffer = JUMP_BUFFER;
    else this._jumpBuffer = Math.max(0, this._jumpBuffer - dt);
    this._jumpHeld = !!s.jump;

    if (this._jumpBuffer > 0 && this._coyote > 0) {
      this._velocity.y = this._jumpVelocity;
      // A sprinting jump becomes a leap: `tryLeap` scales what is already in
      // the velocity rather than setting a fixed speed, so it rewards the
      // run-up, and it returns false (leaving an ordinary jump) if the player
      // was not running or could not pay the stamina.
      /* ...except for the LIFT, which is the one part of a leap that is written
       * absolutely: `Parkour.tryLeap` sets `v.y = P.jumpVelocity * LEAP_LIFT`
       * straight off the config and has no way to know what world it is on.
       * Left alone, a sprinting leap on Tessera would take off at 7.17 m/s
       * against an ordinary jump's 3.51 and clear four times the height of it,
       * on the same key. Rescale what it wrote rather than reaching in for
       * `LEAP_LIFT` - that keeps the leap's own constant its own business, and
       * the multiply is skipped outright on every world that publishes no
       * gravity, so nothing that shipped is touched by a float. */
      if (this.parkour.tryLeap() && this._jumpScale !== 1) {
        this._velocity.y *= this._jumpScale;
      }
      this._jumpBuffer = 0;
      this._coyote = 0;
      this._grounded = false;
      this.bus.emit('player:jumped', { position: this._position });
    } else if (this._grounded && this._velocity.y <= 0) {
      // Small downward bias keeps contact when running down ramps and stairs.
      this._velocity.y = -2.2;
    }

    if (!this._grounded) this._velocity.y += this._gravity * dt;
    /* Terminal velocity - stops the solver from tunnelling on long drops, and
     * DELIBERATELY not scaled with the world. It is a metres-per-step limit
     * against a 0.35 m capsule, and the tunnel is the same whatever
     * accelerated you into it. It also sits above `Parkour.LETHAL_SPEED` on
     * every world, so it never quietly rescues a fall that should have killed
     * you. @see setWorldGravity */
    if (this._velocity.y < -60) this._velocity.y = -60;

    /* ---- the roll's speed floor -------------------------------------- *
     * Here and nowhere else. Friction and the wish have both taken their bite
     * for this step and `_move` has not integrated yet, so what the floor
     * writes is exactly what gets travelled. A step earlier and friction takes
     * a sixth of it back inside the same step; a step later and the metre just
     * covered was covered at the wrong speed.
     * @see ./Parkour.js `holdRollSpeed` */
    if (allows(this._world, 'parkour')) this.parkour.holdRollSpeed();

    /* ---- integrate + collide ---------------------------------------- */
    this._move(dt);

    /* ---- bob + footsteps -------------------------------------------- */
    const speed = Math.hypot(this._velocity.x, this._velocity.z);
    const moving = this._grounded && speed > 0.6;
    this._bobWeight = damp(this._bobWeight, moving ? 1 : 0, 9, dt);
    if (moving) {
      const travelled = speed * dt;
      this._bobDist += travelled;
      this._bobPhase = (this._bobDist / STRIDE) * Math.PI * 2;
      this._footAccum += travelled;
      if (this._footAccum >= STRIDE * 0.5) {
        this._footAccum -= STRIDE * 0.5;
        this._emitFootstep(speed);
      }
    }
  }

  /** Source-style friction: constant deceleration below STOP_SPEED, so no slide. */
  _applyFriction(dt) {
    const vx = this._velocity.x;
    const vz = this._velocity.z;
    const speed = Math.hypot(vx, vz);
    if (speed < 1e-4) {
      this._velocity.x = 0;
      this._velocity.z = 0;
      return;
    }
    const control = Math.max(speed, STOP_SPEED);
    // Recently shoved: bleed the impulse off over a stagger rather than in
    // three frames. @see `_impulseTime`.
    const mu = this._impulseTime > 0 ? P.friction * IMPULSE_FRICTION : P.friction;
    const newSpeed = Math.max(0, speed - control * mu * dt);
    const k = newSpeed / speed;
    this._velocity.x = vx * k;
    this._velocity.z = vz * k;
  }

  /**
   * Accelerate toward `wish`, but only by the component we are missing. This is
   * what gives air-strafing its feel and prevents diagonal over-speed.
   */
  _accelerate(wishX, wishZ, wishSpeed, accel, dt) {
    if (wishSpeed <= 0) return;
    const current = this._velocity.x * wishX + this._velocity.z * wishZ;
    const add = wishSpeed - current;
    if (add <= 0) return;
    const gain = Math.min(accel * dt, add);
    this._velocity.x += wishX * gain;
    this._velocity.z += wishZ * gain;
  }

  /**
   * Integrate and resolve, retrying blocked horizontal motion as a step-up.
   * Kerbs and staircases must never stop the player dead.
   *
   * ── Why the player is immune to the slope treadmill the NPCs had ──────────
   * Every NPC in the game used to slide down every ramp, because `_followGround`
   * seats the feet at the VERTICAL ground height each step; on a slope that
   * buries the capsule's bottom sphere by `r * (1 - cos p)` and `resolveCapsule`
   * evicts it along the normal, which points downhill. They had to be given
   * `Grounding.capsuleSlopeLift` to stop it. @see ../npc/Grounding.js
   *
   * This method shares that solver and does not have that defect, for one
   * reason: IT NEVER RE-SEATS THE FEET. The capsule is integrated, handed to
   * `resolveCapsule`, and left exactly where the solver put it - and a solver
   * that has finished evicting a capsule from a slope has, by construction, left
   * it tangent to that slope, which is the height `capsuleSlopeLift` computes.
   * The NPCs had to be told that height because they overwrote it; the player is
   * already standing on it. `physics.groundHeight` is called once in this whole
   * controller - the tread probe below - and never to place the capsule.
   *
   * Do not "fix" the player by adding a lift here. Measured on a 30 degree ramp,
   * the feet settle 0.0419 m above the ground height, which is
   * `capsuleSlopeLift(0.35, cos 30) = 0.0541` less the `stick * tan^2 p` the
   * ground-stick bias below costs; adding the lift on top would hold the player
   * off the ground. @see ../../scripts/tests/player-slope.test.mjs
   *
   * ── Why the step-up asks `minNormalY` and not just "did I get there?" ─────
   * The retry below used to fire on the shortfall alone, and a shortfall is NOT
   * evidence of an obstruction: projecting a horizontal velocity onto a plane of
   * pitch p costs a factor of `cos^2 p`, which passes the 0.86 threshold at 22
   * degrees. So every smooth ramp in every world, with no riser anywhere on it,
   * read as blocked. Measured on a 30 degree ramp before this line existed: 20
   * probes a second, each teleporting the player onto the surface ~0.36 m ahead,
   * the feet hovering up to 0.198 m over it, airborne on a third of all steps,
   * sprint dropping out on half of them, footsteps halved, `_stepSmooth` pinned
   * at its cap - and an along-slope climb of 1.10x the flat-ground walk speed,
   * 1.41x at 45 degrees. The player went UP a ramp faster than it crossed a
   * floor.
   *
   * This was the same blind spot `Navigation._probe` had before it learned that
   * a hit whose normal passes `WALKABLE_NORMAL_Y` is floor rather than wall, and
   * it is closed the same way. `resolveCapsule` reports the shallowest direction
   * it pushed in; if every push that ate the motion was floor, the motion was
   * lost to the slope and there is nothing to step over. The threshold is
   * `Grounding.WALKABLE_NORMAL_Y` and deliberately not a second number of its
   * own, so "the player will not try to step over it" and "the player can stand
   * on it" stay the same question. @see ../npc/Navigation.js `isFloorHit`
   *
   * A riser, kerb or wall still fails it: the capsule's bottom sphere meets a
   * step at its top edge, whose push direction has `y` near 0.14 for a 0.30 m
   * riser and 0 for a wall - nowhere near 0.55 - so the probe fires exactly
   * where it always did. Flat ground never reaches the branch at all, because
   * unobstructed motion loses nothing.
   *
   * ── What this gate does NOT do, and it is not 56.6 degrees ────────────────
   * `res.minNormalY` is `resolveCapsule`'s contact normal, and that stops being
   * the true face normal past ~44 degrees: a walking capsule on a 46 degree
   * ramp reports ~0.44 where the face is 0.69. So a SMOOTH RAMP steeper than
   * ~45 degrees still reads as obstructed, the branch still fires, and it still
   * finds a tread - the slope itself. Measured at 7178224 over 3 s of holding
   * forward: 46 deg climbs at 6.18 m/s along-slope and 58 deg at 8.68 m/s,
   * against a 6.0 m/s flat-ground speed cap and a projection worth 1.61 and
   * 0.57 - i.e. the player is laddered up, grounded on a third to two thirds of
   * steps, with 60-90 tread probes in those 3 s. Sprinting starts it at 45.
   * 59 degrees is where it finally fails to find a tread and the player stops.
   *
   * The 45 degree boundary is therefore the SOLVER's, not this gate's, and it
   * is why every ramp actually authored in the game (all under 45) is handled
   * correctly by the note above. Raising `WALKABLE_NORMAL_Y` will not move it.
   * The mechanism, and why the one-line fix to the solver was measured and
   * rejected as making two other bands worse, is at the closest-point iteration
   * in `resolveCapsule`.
   * @see ../physics/Physics.js `resolveCapsule`
   * @see ../../scripts/tests/capsule-normal.test.mjs
   */
  _move(dt) {
    const radius = P.radius;
    const h = this._capsuleHeight;

    _prev.copy(this._position);
    const wantX = this._velocity.x * dt;
    const wantZ = this._velocity.z * dt;
    const expectedY = this._position.y + this._velocity.y * dt;

    this._position.set(_prev.x + wantX, expectedY, _prev.z + wantZ);
    _intended.copy(this._position);
    let res = this.physics.resolveCapsule(this._position, radius, h);
    let steppedUp = false;

    const wanted = Math.hypot(wantX, wantZ);
    const gotX = this._position.x - _prev.x;
    const gotZ = this._position.z - _prev.z;
    const got = Math.hypot(gotX, gotZ);
    let grounded = res.grounded;

    // Standing still: the ground-stick bias (-2.2) plus the resolver's
    // normal push otherwise creeps the capsule downslope a few cm/s. Pin
    // the planar position when there is no horizontal motion to integrate.
    if (wanted < 1e-4 && this._grounded && grounded && got < 0.06) {
      this._position.x = _prev.x;
      this._position.z = _prev.z;
    }

    // Blocked by something that is not floor, and we have ground (or coyote)
    // to push off: probe a step. @see the note above on `minNormalY`.
    const obstructed = res.minNormalY < WALKABLE_NORMAL_Y;
    if (wanted > 1e-4 && got < wanted * 0.86 && obstructed && (this._grounded || this._coyote > 0)) {
      // 1. Lift by the step height and make sure the raised capsule fits.
      _step.set(_prev.x, _prev.y + P.stepHeight, _prev.z);
      this.physics.resolveCapsule(_step, radius, h);
      const liftedY = _step.y;

      // 2. Retry the same horizontal motion from up there.
      _step.x += wantX;
      _step.z += wantZ;
      this.physics.resolveCapsule(_step, radius, h);
      const got2 = Math.hypot(_step.x - _prev.x, _step.z - _prev.z);

      if (got2 > got + 0.002 && Math.abs(_step.y - liftedY) < 0.02) {
        // 3. Find the tread by raycast rather than by dropping the capsule.
        //    Dropping it would bury the capsule in the riser, and a solver
        //    ejects along its shallowest axis - which would shove us straight
        //    back off the step. Probe ahead of the capsule axis, because the
        //    axis itself is still held a full radius short of the riser.
        const lead = (radius + 0.01) / wanted;
        const probeX = _step.x + wantX * lead;
        const probeZ = _step.z + wantZ * lead;
        const treadY = this.physics.groundHeight(
          probeX,
          probeZ,
          _step.y + 0.05,
          P.stepHeight + 0.7
        );
        if (treadY !== null && treadY <= _prev.y + P.stepHeight + 0.01 && treadY > _prev.y - 0.06) {
          // Seat slightly inside the tread so the solver reports us grounded.
          _step.y = treadY - 0.01;
          const landed = this.physics.resolveCapsule(_step, radius, h);
          if (Math.hypot(_step.x - _prev.x, _step.z - _prev.z) > got + 0.002) {
            const rise = _step.y - this._position.y;
            this._position.copy(_step);
            steppedUp = true;
            res = landed;
            grounded = res.grounded;
            if (!grounded) {
              grounded = true;
              res.grounded = true;
              if (res.groundNormal.y < 0.64) {
                res.groundNormal.set(0, 1, 0);
              }
            }
            // Absorb the instantaneous lift in the camera so stairs feel smooth.
            if (rise > 0) this._stepSmooth = Math.min(P.stepHeight * 1.3, this._stepSmooth + rise);
          }
        }
      }
    }

    /* Tunnelling guard.
     *
     * Depenetration pushes out of a collider along its shortest axis, which is
     * correct but has no memory of which side the capsule arrived from. Wedged
     * into the junction of two walls - the exact case of grabbing a wall at a
     * corner and jumping - the shortest way out of one of them can be straight
     * through to the far side, and the player ends up outside the building.
     *
     * The solver cannot fix this on its own; only the caller knows where the
     * capsule was a frame ago. So: if a resolve corrected the position by more
     * than a stride, check the straight line back to last frame's position. If
     * solid geometry stands in the way, the capsule did not travel there - it
     * was squeezed there - and last frame's position is the honest answer.
     *
     * Gated on a large correction and skipped after a step-up, so ordinary
     * walking, stairs and ramps never pay for it or trip it. */
    if (!steppedUp && this._position.distanceToSquared(_intended) > (radius * 1.5) ** 2) {
      _guardFrom.set(_prev.x, _prev.y + h * 0.5, _prev.z);
      _guardDir.set(
        this._position.x - _prev.x,
        this._position.y - _prev.y,
        this._position.z - _prev.z
      );
      const span = _guardDir.length();
      if (span > 1e-4) {
        _guardDir.multiplyScalar(1 / span);
        const blocked = this.physics.raycast(_guardFrom, _guardDir, span, COLLISION_LAYER.WORLD);
        if (blocked) {
          this._position.copy(_prev);
          this._velocity.x = 0;
          this._velocity.z = 0;
          res = this.physics.resolveCapsule(this._position, radius, h);
          grounded = res.grounded;
        }
      }
    }

    this._wasGrounded = this._grounded;
    this._grounded = grounded;
    this._groundNormal.copy(res.groundNormal);

    if (this._grounded) {
      // Threshold sits above the ground-stick bias (-2.2) so stair treads and
      // ramp crests never register as landings.
      if (!this._wasGrounded && this._velocity.y < -3.0) this._land(-this._velocity.y);
      if (this._velocity.y < 0) this._velocity.y = 0;
    } else if (this._velocity.y > 0 && this._position.y < expectedY - 0.001) {
      // Cracked our head on a ceiling.
      this._velocity.y = 0;
    }
  }

  _land(fallSpeed) {
    // Dip proportional to impact, capped so a long fall cannot black out the
    // view. Motion sickness is a failure state: 0.42 m is the hard ceiling.
    this._dipVel -= Math.min(1.35, Math.max(0, fallSpeed - 2.6) * 0.062);
    /* Resolved ONCE and handed to both. `player:landed` carried no `material`,
     * so `AudioDirector`'s handler - which has always read `e.material` - got
     * `undefined` and fell through to 'concrete' on every landing in the game,
     * and `Parkour` then passed the same nothing on to the roll and hard-land
     * cues. A per-surface table that is never reached reads like working
     * variation. @see _surfaceUnderfoot */
    const material = this._surfaceUnderfoot();
    this.bus.emit('player:landed', { speed: fallSpeed, position: this._position, material });
    this._emitFootstep(fallSpeed, true, material);
  }

  /**
   * What is under the feet right now, as a material name.
   *
   * One short raycast. Colliders may tag themselves via `userData.material` /
   * `.surface` / `.type`; anything untagged reports 'default'.
   *
   * @returns {string}
   */
  _surfaceUnderfoot() {
    _v1.set(this._position.x, this._position.y + 0.25, this._position.z);
    const hit = this.physics.raycast(_v1, _down, 0.8, COLLISION_LAYER.WORLD);
    const ud = hit?.collider?.userData;
    return ud?.material ?? ud?.surface ?? ud?.type ?? 'default';
  }

  /** Public read of {@link _surfaceUnderfoot}, for the movement modules. */
  surfaceUnderfoot() {
    return this._surfaceUnderfoot();
  }

  /** Raycast up from the feet to see whether we can extend to `height`. */
  _hasHeadroom(height) {
    _v1.set(this._position.x, this._position.y + 0.15, this._position.z);
    const hit = this.physics.raycast(_v1, _up, height - 0.15, COLLISION_LAYER.WORLD);
    return !hit;
  }

  /**
   * Footsteps carry a surface guess so audio/VFX can vary.
   *
   * `material` is a parameter with a default rather than always a fresh probe,
   * so `_land` can resolve the surface once and spend it on both the landing
   * event and the footstep. @see _surfaceUnderfoot
   */
  _emitFootstep(speed, isLanding = false, material = this._surfaceUnderfoot()) {
    this._footIndex ^= 1;
    this.bus.emit('player:footstep', {
      position: this._position,
      material,
      speed,
      sprinting: this._sprinting,
      crouching: this._crouching,
      foot: this._footIndex ? 'left' : 'right',
      landing: isLanding,
    });
  }

  /* ================================================================ */
  /* Swim + climb support                                              */
  /*                                                                   */
  /* Small, explicit hooks rather than reaching into `_private` fields  */
  /* from the sibling modules: the state these touch is load-bearing    */
  /* for the camera, the HUD and the avatar, so every writer is here.   */
  /* ================================================================ */

  /**
   * Raise `movementOverride` on our own behalf. Refuses to steal it from a
   * mount, which is the only other owner.
   */
  _claimMovement() {
    if (this._selfOverride || this.movementOverride) return;
    this.movementOverride = true;
    this._selfOverride = true;
  }

  /**
   * Guarantee the swim controller has water data.
   *
   * `main.js` is expected to construct `WaterVolumes` (CONTRACTS-V3 4), but the
   * feature must not be dead if that wiring lands late - and the scan is cheap
   * and idempotent, so owning a private one until the real instance announces
   * itself costs nothing but a few milliseconds per world change.
   */
  _ensureWater() {
    if (this.swim.water || this._ownWater) return;
    this._ownWater = new WaterVolumes({ bus: this.bus });
    if (this._lastWorld) this._ownWater.rebuildFromWorld(this._lastWorld);
  }

  /** Hand `movementOverride` back. A no-op unless we were the ones holding it. */
  _releaseMovement() {
    if (!this._selfOverride) return;
    this._selfOverride = false;
    this.movementOverride = false;
  }

  /**
   * Stance while swimming: never crouched, never sprinting on land terms, and
   * no head bob. Called by `Swim` each step it owns movement.
   * @param {number} dt
   */
  setStanceWet(dt) {
    this._crouching = false;
    this._sprinting = false;
    this._capsuleHeight = damp(this._capsuleHeight, STAND_HEIGHT, 12, dt);
    this._coyote = 0;
    this._jumpBuffer = 0;
    this._bobWeight = damp(this._bobWeight, 0, 9, dt);
    this._stepSmooth = damp(this._stepSmooth, 0, 13, dt);
  }

  /**
   * Ground state after a swim step. A swimmer standing on the river bed is
   * technically grounded, and reporting that keeps the avatar and the HUD
   * honest without letting the walk code run.
   * @param {{grounded:boolean, groundNormal:THREE.Vector3}} res
   */
  setSwimContact(res) {
    this._wasGrounded = this._grounded;
    this._grounded = false;
    if (res?.groundNormal) this._groundNormal.copy(res.groundNormal);
  }

  /**
   * Stance during a mantle. `tuck` runs 0 (fully tucked) to 1 (standing) and
   * drives the capsule height, which is what `crouchAmount` - and therefore the
   * avatar's leg pose and the camera's eye height - are derived from.
   * @param {number} tuck
   * @param {number} dt
   */
  setClimbStance(tuck, dt) {
    const target = THREE.MathUtils.lerp(CROUCH_HEIGHT, STAND_HEIGHT, clamp(tuck, 0, 1));
    this._capsuleHeight = damp(this._capsuleHeight, target, 14, dt);
    this._crouching = false;
    this._sprinting = false;
    this._bobWeight = damp(this._bobWeight, 0, 12, dt);
  }

  /**
   * Stance during a roll. `tuck` runs 0 (standing) to 1 (fully tucked), which
   * is the OPPOSITE sense to {@link setClimbStance} because the two states are
   * opposites: a mantle is a body on its way back up and a roll is a body on
   * its way down.
   *
   * The target is `Parkour.ROLL_HEIGHT` and not `CROUCH_HEIGHT`, and that is
   * the whole mechanic - a roll has to fit under things a crouch does not, or
   * "pass under a low obstacle" is just a crouch-walk with an animation on it.
   * Rate 16, the same rate the crouch uses, so the two stances tuck at the same
   * speed and only the depth differs.
   *
   * @param {number} tuck
   * @param {number} dt
   */
  setRollStance(tuck, dt) {
    const want = THREE.MathUtils.lerp(STAND_HEIGHT, Parkour.ROLL_HEIGHT, clamp(tuck, 0, 1));
    /* Clamped, because `rollTuck` eases back off over the last third of the
     * roll and that easing happens wherever the roll ended - including under
     * the 0.9 m beam the verb exists to pass. @see _fittingHeight */
    const target = this._fittingHeight(want);
    this._stancePinned = target < CROUCH_HEIGHT;
    this._capsuleHeight = damp(this._capsuleHeight, target, 16, dt);
  }

  /**
   * The tallest stance at or below `desired` that there is actually room for.
   *
   * THE ROLL MADE THIS NECESSARY. Before it, the capsule could never be under
   * `CROUCH_HEIGHT`, so a crouch fitted anywhere a player could get to and two
   * targets were enough. A roll reaches 0.735 m, which means a player can now
   * be somewhere 1.015 m does not fit - and damping toward a height that does
   * not fit hands `resolveCapsule` an impossible body. Measured under a 12 m
   * wide beam at a 0.9 m gap: the feet were ejected from y = 0.0 up to y = 0.9,
   * gravity dropped them, and the pair repeated at about 20 Hz with
   * `_crouching` flickering, for as long as the player stayed underneath.
   *
   * Probes only while the capsule is GROWING - shrinking always fits, and
   * standing up already paid for a probe before this existed. An ordinary
   * crouch-walk damps 1.75 -> 1.015 from above and so never asks.
   *
   * @param {number} desired
   * @returns {number} `desired`, `CROUCH_HEIGHT` or `Parkour.ROLL_HEIGHT`
   */
  _fittingHeight(desired) {
    if (desired <= this._capsuleHeight + 1e-4) return desired;
    if (this._hasHeadroom(desired)) return desired;
    if (desired > CROUCH_HEIGHT && this._hasHeadroom(CROUCH_HEIGHT)) return CROUCH_HEIGHT;
    return Parkour.ROLL_HEIGHT;
  }

  /**
   * Nudge the landing-dip spring. Negative dips the view down.
   *
   * The primitive `_land` uses, exposed so the sibling movement modules do not
   * have to reach into `_dipVel` - the rule for the whole of this block. The
   * spring is critically damped and clamped in `_tickDip`, so an over-large
   * impulse is bounded rather than blinding.
   *
   * @param {number} amount metres per second of dip velocity
   */
  addViewDip(amount) {
    if (!Number.isFinite(amount)) return false;
    this._dipVel += amount;
    return true;
  }

  /**
   * A short additive FOV punch, in degrees, decaying in `_applyFov`.
   *
   * Separate from the sprint kick because it is an event and the kick is a
   * state: a leap is taken at a sprint by definition, so the kick is already at
   * or near its 4.76-degree ceiling and widening the frame further has to be
   * additive or it does nothing at the exact moment it is wanted.
   *
   * Takes the larger of the two rather than summing, so a burst of leaps off a
   * rooftop chain reads as one wide frame instead of ratcheting the lens open.
   *
   * @param {number} degrees
   */
  punchFov(degrees) {
    if (!(degrees > 0)) return false;
    this._fovPunch = Math.max(this._fovPunch, degrees);
    return true;
  }

  /**
   * Called once as a mantle completes, with the settled capsule resolve.
   * @param {{grounded:boolean, groundNormal:THREE.Vector3}} res
   */
  setClimbLanding(res) {
    this._wasGrounded = this._grounded;
    this._grounded = res?.grounded ?? true;
    if (res?.groundNormal) this._groundNormal.copy(res.groundNormal);
    this._coyote = COYOTE_TIME;
    this._releaseMovement();
    // Absorb the last few centimetres in the camera so the top of the hoist
    // does not snap: same mechanism stairs use.
    this._stepSmooth = Math.min(P.stepHeight * 1.3, this._stepSmooth + 0.12);
  }

  /**
   * Install the late-frame pose pass.
   *
   * `PlayerAvatar` runs after this class in `main.js`'s frame order and rewrites
   * every bone, so a swim or climb pose written from `update()` would be thrown
   * away. Registering an extra frame updater on the *first* frame appends it
   * behind main.js's own callback - `Engine` iterates a Set, and insertion
   * order is call order - so this lands after the avatar has finished, and
   * before the renderer flattens the skeleton.
   */
  _installLatePose() {
    if (this._offLate || !this.engine?.onFrameUpdate) return;
    this._offLate = this.engine.onFrameUpdate((dt, elapsed) => {
      this.swim.applyPose(dt, elapsed);
      /* Parkour BEFORE the two climbs, and the order is the whole rule: later
       * wins, so this is the statement that a climb outranks a leap.
       *
       * It used to sit after them with a comment claiming the opposite - "a
       * leap that ends in a wall grab is posed by the wall" - which is what the
       * ordering should say and was not what it did. The overlap is real and it
       * is the interaction the citadel is built around: a leap or a dive that
       * ends in a wall grab leaves `_leapT` and `_diveW` decaying for up to
       * half a second AFTER `FreeClimb` has taken the body, and parkour running
       * last meant a head-first dive pose and a 0.57 m rig lift over the wall
       * pose for the whole of that tail. The same ordering keeps a mantle's
       * pose safe from a roll that has not finished.
       *
       * It shares `humanoid.rig` with swim, so it honours the same handover
       * guard `MinigamePose` does, and that guard is order-independent. */
      this.parkour.applyPose(dt, elapsed);
      // Free climb before the mantle: topping out hands off from one to the
      // other, and the mantle is the pose that should win on the frames where
      // both have weight.
      this.freeClimb.applyPose(dt, elapsed);
      this.climb.applyPose(dt, elapsed);
      /* Minigame poses last, and only when a contest is actually in its "take
       * your marks" or finish beat - so on every other frame in the game this
       * is one null check. It goes after swim deliberately: a swimmer punching
       * the air at the wall has to be able to write arms over the crawl cycle
       * that ran a line above. It shares the humanoid `rig` with swim rather
       * than fighting for it; see MinigamePose's header for the handover rule.
       *
       * Assigned from main.js rather than constructed here, because the pose
       * needs the minigame manager and the player must not know that system
       * exists. Absent in any harness that builds a Player on its own. */
      this.minigamePose?.applyPose?.(dt, elapsed);
    });
  }

  /* ================================================================ */
  /* Health                                                            */
  /* ================================================================ */

  _tickHealth(dt, elapsed) {
    if (this._dead || this._health >= this._maxHealth) return;
    if (elapsed - this._lastDamageAt < P.healthRegenDelay) return;
    this._regenCarry += P.healthRegenRate * dt;
    if (this._regenCarry >= 1) {
      const whole = Math.floor(this._regenCarry);
      this._regenCarry -= whole;
      this.heal(whole);
    }
  }

  /**
   * Apply damage. Ignored while dead or invulnerable.
   * @returns {number} damage actually applied
   */
  applyDamage(amount, sourcePosition = null, sourceId = null) {
    if (this._dead || amount <= 0) return 0;
    // `_buffNow`, because `_invulnUntil` is written against it. @see _buffNow
    if (this._buffNow() < this._invulnUntil) return 0;

    // Purchased Armour on the mount being ridden: -10% per tier.
    const shield = this.mounts?.mounted ? Math.max(0, Number(this.mounts.active?.shieldTier) || 0) : 0;
    if (shield > 0) amount *= Math.max(0.1, 1 - 0.10 * shield);

    const applied = Math.min(this._health, amount);
    this._health -= applied;
    this._lastDamageAt = this._elapsed;
    this._regenCarry = 0;

    this.bus.emit('player:damaged', {
      amount: applied,
      health: this._health,
      maxHealth: this._maxHealth,
      sourcePosition,
    });

    if (this._health <= 0) this._die(sourceId);
    return applied;
  }

  /**
   * Throw the player. The real knockback API.
   *
   * ── Why it goes into velocity and not into position ───────────────────────
   * There was no impulse API before this - the only thing in `src/player/` with
   * "impulse" in it is the weapon's visual spring kick - so the shape of it was
   * a decision, and there is only one safe answer. Writing `position` directly
   * would put the player wherever the shove pointed, walls included, and the
   * capsule solver would then eject them along the SHORTEST axis out of
   * whatever they landed in - which, wedged into a corner, is frequently
   * straight through to the far side. That is the exact failure `_move`'s
   * tunnelling guard exists to catch, and it should never have to.
   *
   * Adding to velocity means the shove is integrated by `_move` like any other
   * motion: it is swept, resolved by `resolveCapsule`, allowed to step up a
   * kerb, and rolled back by the tunnelling guard if the solver ever squeezes
   * the capsule through geometry. A player thrown at a wall stops at the wall,
   * with no code here that knows what a wall is.
   *
   * The vertical component SETS rather than adds, so being hit twice does not
   * launch anybody, and it is only ever applied upward.
   *
   * @param {{x:number,y:number,z:number}} impulse metres per second
   * @param {{stagger?:number}} [opts] seconds of reduced friction, so the
   *   shove reads as being thrown rather than as a stutter
   * @returns {boolean} false when the player is dead or a mount owns movement
   */
  applyImpulse(impulse, opts = {}) {
    if (!impulse || this._dead) return false;
    // A mount owns the capsule while it is being ridden; shoving the rider
    // would desynchronise them from the animal they are sitting on.
    if (this.movementOverride && !this._selfOverride) return false;

    this._velocity.x += impulse.x ?? 0;
    this._velocity.z += impulse.z ?? 0;
    const planar = Math.hypot(this._velocity.x, this._velocity.z);
    if (planar > IMPULSE_MAX) {
      const k = IMPULSE_MAX / planar;
      this._velocity.x *= k;
      this._velocity.z *= k;
    }

    const up = impulse.y ?? 0;
    if (up > 0) {
      this._velocity.y = Math.max(this._velocity.y, up);
      this._grounded = false;
      this._coyote = 0;
      this._jumpBuffer = 0;
    }

    this._impulseTime = Math.max(this._impulseTime, opts.stagger ?? IMPULSE_STAGGER);
    this.bus?.emit('player:impulse', {
      impulse: { x: impulse.x ?? 0, y: up, z: impulse.z ?? 0 },
      speed: Math.hypot(this._velocity.x, this._velocity.z),
    });
    return true;
  }

  /**
   * Kick the view.
   *
   * The primitive that makes `camera:shake` mean something. That event had
   * eight emitters and no listener at all until the constructor subscribed one,
   * so every explosion, sword hit and death was firing into nothing. Damage
   * calls this DIRECTLY rather than through the event, because the direction of
   * the blow is known at the call site and is the whole point; `camera:shake`
   * carries no direction and is routed in with an alternating roll instead.
   *
   * This is a real transform, applied in `_applyCamera` alongside the weapon recoil offset,
   * and it is DIRECTIONAL rather than random: a blow from the left rolls the
   * view right, which tells the player where it came from. A random shake tells
   * them only that something happened.
   *
   * Implemented as a damped spring per axis so it overshoots once and settles,
   * rather than as a decaying random offset - the difference between being hit
   * and standing on a washing machine.
   *
   * @param {number} pitch radians, positive kicks the view up
   * @param {number} [yaw]
   * @param {number} [roll]
   */
  /**
   * Undirected shake, routed into the same spring as a directed kick.
   *
   * `camera:shake` carries an `amount` and no direction, so this cannot roll
   * away from the blow the way {@link applyViewKick} does at a damage site.
   * Instead the roll ALTERNATES per call, so a burst - a fireball chain, a
   * flurry of sword hits - shudders rather than nudging the view identically n
   * times. Deterministic rather than random so a test can assert it.
   *
   * The two scales are not interchangeable and conflating them is the easy bug
   * here: `applyViewKick` takes radians, where 0.12 is a bear's paw, while
   * `amount` runs 0.03 for a bow draw to 0.62 for the death lurch. 0.55 rad per
   * unit puts the bow at about one degree and death at about twenty.
   *
   * @param {number} amount as emitted with `camera:shake`
   * @returns {boolean} false when there was nothing to do
   */
  applyShake(amount) {
    if (!(amount > 0)) return false;
    this._shakeParity = -(this._shakeParity ?? 1);
    const s = this._shakeParity;
    return this.applyViewKick(amount * 0.55, amount * 0.12 * s, amount * 0.3 * s);
  }

  applyViewKick(pitch, yaw = 0, roll = 0) {
    const k = this._kick;
    k.vp += pitch;
    k.vy += yaw;
    k.vr += roll;
    return true;
  }

  /**
   * Open a wound.
   *
   * Damage over time, delivered through `applyDamage` one whole point at a
   * time. Routing it through the normal path rather than decrementing `_health`
   * is what makes the HUD feedback "consistent with how `player:damaged` is
   * already presented": every tick raises the same event, flashes the same
   * vignette and pushes the same damage-direction marker, with no HUD changes
   * at all. It also - correctly - keeps resetting the regeneration delay, so a
   * bleeding player does not heal.
   *
   * Bleeds REFRESH rather than stack: a second bite takes the harsher rate and
   * the longer clock, but four wolves biting in one second cannot compound into
   * an unsurvivable 12/s. That is the single most important line in this method
   * for the "survivable" half of the design target.
   *
   * @param {number} rate health per second
   * @param {number} duration seconds
   * @param {*} [sourceId] whatever opened it, for the kill feed
   * @returns {boolean}
   */
  applyBleed(rate, duration, sourceId = null) {
    if (this._dead || !(rate > 0) || !(duration > 0)) return false;
    const wasBleeding = this._bleedTime > 0;
    this._bleedRate = Math.max(this._bleedRate, rate);
    this._bleedTime = Math.max(this._bleedTime, duration);
    this._bleedSource = sourceId ?? this._bleedSource;
    if (!wasBleeding) {
      this.bus?.emit('player:bleed', { active: true, rate: this._bleedRate, remaining: this._bleedTime });
      this.bus?.emit('hud:notify', { text: 'Bleeding', tone: 'warn' });
    }
    return true;
  }

  /** True while a wound is still open. */
  get isBleeding() {
    return this._bleedTime > 0;
  }

  /**
   * Stop the bleed - a bandage, a respawn, a world change.
   *
   * Gated on the RATE as well as on the clock, because `_tickBleed` calls this
   * on the step the clock reaches zero: keyed on the clock alone it would take
   * the early return, leave `_bleedRate` set, and never announce that the wound
   * had closed.
   */
  clearBleed() {
    if (this._bleedTime <= 0 && this._bleedRate <= 0) return false;
    this._bleedTime = 0;
    this._bleedRate = 0;
    this._bleedCarry = 0;
    this._bleedSource = null;
    this.bus?.emit('player:bleed', { active: false, rate: 0, remaining: 0 });
    return true;
  }

  /**
   * Run the clock down and pay out whole points of damage.
   *
   * Whole points, with a carry, for the same reason health regeneration uses
   * one: a fractional `applyDamage` every step would raise sixty
   * `player:damaged` events a second and pin the HUD's flash at maximum.
   */
  _tickBleed(dt) {
    if (this._bleedTime <= 0) return;
    if (this._dead) {
      this.clearBleed();
      return;
    }
    const step = Math.min(dt, this._bleedTime);
    this._bleedTime -= step;
    this._bleedCarry += this._bleedRate * step;
    if (this._bleedCarry >= 1) {
      const whole = Math.floor(this._bleedCarry);
      this._bleedCarry -= whole;
      this.applyDamage(whole, null, this._bleedSource);
    }
    if (this._bleedTime <= 0) this.clearBleed();
  }

  /** Integrate the view-kick springs toward rest. */
  _tickViewKick(dt) {
    const k = this._kick;
    if (k.vp === 0 && k.vy === 0 && k.vr === 0
      && k.pitch === 0 && k.yaw === 0 && k.roll === 0) return;
    // Semi-implicit Euler: stable at this stiffness for any frame time the
    // engine will ever hand out, and it costs six multiplies.
    const h = Math.min(dt, 1 / 30);
    k.vp += (-KICK_STIFFNESS * k.pitch - KICK_DAMPING * k.vp) * h;
    k.vy += (-KICK_STIFFNESS * k.yaw - KICK_DAMPING * k.vy) * h;
    k.vr += (-KICK_STIFFNESS * k.roll - KICK_DAMPING * k.vr) * h;
    k.pitch += k.vp * h;
    k.yaw += k.vy * h;
    k.roll += k.vr * h;
    if (Math.abs(k.pitch) < 1e-4 && Math.abs(k.vp) < 1e-3) { k.pitch = 0; k.vp = 0; }
    if (Math.abs(k.yaw) < 1e-4 && Math.abs(k.vy) < 1e-3) { k.yaw = 0; k.vy = 0; }
    if (Math.abs(k.roll) < 1e-4 && Math.abs(k.vr) < 1e-3) { k.roll = 0; k.vr = 0; }
  }

  heal(amount) {
    if (this._dead || amount <= 0) return 0;
    const applied = Math.min(amount, this._maxHealth - this._health);
    if (applied <= 0) return 0;
    this._health += applied;
    this.bus.emit('player:healed', {
      amount: applied,
      health: this._health,
      maxHealth: this._maxHealth,
    });
    return applied;
  }

  boostSpeed(multiplier, duration) {
    if (!(multiplier > 1) || !(duration > 0)) return false;
    this._speedBoostMul = Math.max(this.speedMultiplier, multiplier);
    this._speedBoostUntil = Math.max(this._speedBoostUntil, this._buffNow() + duration);
    this.bus.emit('player:buffed', { kind: 'speed', multiplier: this._speedBoostMul, duration });
    return true;
  }

  /**
   * Raise invulnerability without announcing a buff.
   *
   * The silent half of {@link grantShield}. A shield is a PICKUP - it has an
   * icon, a duration a player is meant to watch, and `player:buffed` is how the
   * HUD would learn about it. A dodge roll's i-frames are part of a movement,
   * and routing them through `grantShield` put a 1.7 Hz emitter on that event:
   * measured, 52 `player:buffed` in thirty seconds of crouch-tapping. The
   * design forbade it for the right reason even though the reason it gave (a
   * flashing HUD icon) has no listener to flash yet.
   *
   * `Math.max`, so a brief roll can never SHORTEN a real shield.
   *
   * @param {number} duration seconds
   */
  grantIFrames(duration) {
    if (!(duration > 0)) return false;
    this._invulnUntil = Math.max(this._invulnUntil, this._buffNow() + duration);
    return true;
  }

  grantShield(duration) {
    if (!this.grantIFrames(duration)) return false;
    this.bus.emit('player:buffed', { kind: 'shield', duration });
    return true;
  }

  _die(killerId) {
    this._dead = true;
    this._health = 0;
    this._deathAt = this._elapsed;
    this.swim.cancel();
    this.climb.cancel();
    /* The design named `_die` as one of the four cancel sites and it was the
     * one that got missed. The dead branch of `fixedUpdate` returns before
     * `parkour.fixedUpdate`, so without this the corpse holds whatever it was
     * doing for the full 3.2 s respawn delay: measured, killed 0.45 s into a
     * dodge, `humanoid.rig` stayed at 0.54 rad with the body floating 0.36 m
     * off its own feet and 4 degrees of bank on the death camera, every frame
     * until `respawn`. */
    this.parkour.cancel();
    this._releaseMovement();
    this._velocity.set(0, this._velocity.y, 0);
    this._weapon.setEnabled(false);
    this._weapon.setAim(false);
    this.bus.emit('player:died', { killerId: killerId ?? null });
  }

  /** Restore the player at the last spawn anchor with brief invulnerability. */
  respawn() {
    this._dead = false;
    this._health = this._maxHealth;
    this._regenCarry = 0;
    this.clearBleed();
    this._impulseTime = 0;
    this._kick.pitch = this._kick.yaw = this._kick.roll = 0;
    this._kick.vp = this._kick.vy = this._kick.vr = 0;
    this._lastDamageAt = -999;
    this._invulnUntil = this._buffNow() + SPAWN_INVULN;
    this._speedBoostUntil = 0;
    this._speedBoostMul = 1;
    this._velocity.set(0, 0, 0);
    this._dip = 0;
    this._dipVel = 0;
    this._stepSmooth = 0;
    this._weapon.setEnabled(true);
    this._weapon.resupply();
    this.teleport(this._spawnPosition, this._spawnYaw, { anchor: false });
    this.bus.emit('player:respawned', {});
  }

  /**
   * Move the player instantly. The destination becomes the respawn anchor
   * unless `opts.anchor === false`.
   * @param {THREE.Vector3} position feet position
   * @param {number} [yaw] radians
   */
  teleport(position, yaw = this._yaw, opts = {}) {
    // Whatever mode we were in, the destination decides the next one. Swim
    // re-detects on the following step from the bed depth there.
    this.swim.cancel();
    this.climb.cancel();
    // A roll does not follow you through a portal either. @see Parkour.cancel
    this.parkour.cancel();
    this._releaseMovement();
    // A wound does not follow you through a portal, and neither does a shove.
    this.clearBleed();
    this._impulseTime = 0;
    this._position.copy(position);
    this._yaw = yaw;
    this._pitch = 0;
    this._velocity.set(0, 0, 0);
    this._coyote = 0;
    this._jumpBuffer = 0;
    this._stepSmooth = 0;
    this._dip = 0;
    this._dipVel = 0;
    this._fovPunch = 0;
    this._poseRoll = 0;
    this._posePitch = 0;
    this._stancePinned = false;
    this._bobWeight = 0;
    this._footAccum = 0;
    // Settle out of anything we landed inside.
    const res = this.physics.resolveCapsule(this._position, P.radius, this._capsuleHeight);
    this._grounded = res.grounded;
    this._wasGrounded = res.grounded;

    if (opts.anchor !== false) {
      this._spawnPosition.copy(this._position);
      this._spawnYaw = yaw;
    }
    this._applyCamera(0);
    // Collapse the third-person spring: without this the boom would sweep
    // across the entire world between the old position and the new one.
    this.cameraRig?.snap();
    this.bus.emit('player:spawned', { position: this._position });
  }

  /* ================================================================ */
  /* Per-frame view + weapon                                           */
  /* ================================================================ */

  /**
   * Mouse look, camera composition and viewmodel drive. Runs every rendered
   * frame so look latency is never quantised to the physics rate.
   */
  update(dt, elapsed) {
    this._elapsed = elapsed;
    this._installLatePose();

    /* ── DO NOT CONSUME A LOOK DELTA SOMEBODY ELSE OWNS ──────────────────────
     *
     * `consumeLook` is destructive: it returns the accumulated mouse delta and
     * ZEROES it. This method runs before every other consumer in `main.js`'s
     * frame order, so whatever it takes, nothing downstream can have.
     *
     * That was fine while `lookOwned` only ever described a mount, because a
     * mount steers from `player.yaw` and wants this class to keep integrating
     * the mouse. `Piloting` is the other kind of driver: `Flight.readInput`
     * calls `input.consumeLook()` itself, from `piloting.update`, which runs
     * AFTER this - and it was getting {0, 0} every frame of every flight.
     *
     * The symptom was total: pitch and yaw are the only two axes a ship steers
     * with, `Flight`'s virtual stick is fed entirely from that delta, and both
     * sat at exactly zero. A player could throttle, boost, brake and thrust
     * vertically, and could not turn. Nothing caught it because every test of
     * the flight model - and the autopilot in `_flightrig.mjs` - writes
     * `flight.setCommand` directly, which is downstream of the missing half.
     * It was found by trying to aim a gun.
     *
     * So the delta is left in the input when it is owned elsewhere. The flag
     * that says so already existed and was already computed here; it simply had
     * no writer, and `Piloting._takeBody` is now it. */
    const lookOwned = this.movementOverride && !this.movementOverrideLook;
    const look = lookOwned ? ZERO_LOOK : this.input.consumeLook();
    if (!this._harnessFrozen && !this._dead && !lookOwned) {
      this._yaw -= look.dx;
      this._pitch = clamp(this._pitch - look.dy, -MAX_PITCH, MAX_PITCH);
    }
    this._lastLookX = look.dx;
    this._lastLookY = look.dy;

    // View springs.
    this._stepSmooth = damp(this._stepSmooth, 0, 13, dt);
    this._tickDip(dt);
    this._tickViewKick(dt);
    /* The eye is its OWN spring, keyed off `_crouching` and not off the
     * capsule, which is why a roll has to name it explicitly: the capsule
     * tucking to `Parkour.ROLL_HEIGHT` moves `crouchAmount` and the avatar's
     * legs and nothing else, and a camera left at 1.62 m over a body rolling
     * at 0.735 m is the whole reason this line is called out in the design.
     * Faster than the crouch rate too - a roll is 0.55 s long and a 14 rate
     * spring is still a third of the way from home when it ends. */
    const parkour = allows(this._world, 'parkour') ? this.parkour : null;
    // `rolling` OR still pinned under something a crouch does not fit: the
    // capsule is at ROLL_HEIGHT in both cases, and a 0.891 m crouch eye under a
    // 0.9 m beam is a camera inside the beam.
    const rolling = !!parkour?.rolling || this._stancePinned;
    this._eyeHeight = damp(
      this._eyeHeight,
      this._dead ? 0.32 : rolling ? Parkour.ROLL_EYE : this._crouching ? CROUCH_EYE : STAND_EYE,
      rolling ? 22 : 14,
      dt
    );
    /* Body-state view offsets. Composed in `_applyCamera` rather than folded
     * into `_roll`/`_pitch` - see the field comment. The roll banks; the dive
     * pitches the view down with the body, which is what makes `diveWeight` a
     * live number instead of a getter nothing called. */
    this._poseRoll = parkour ? parkour.poseRoll : 0;
    this._posePitch = parkour ? -DIVE_VIEW_PITCH * parkour.diveWeight : 0;

    const s = this.input.state;
    const speed = Math.hypot(this._velocity.x, this._velocity.z);

    // Subtle strafe roll - a couple of degrees, tied to lateral input.
    const rollTarget = this._dead
      ? 0.55
      : -s.right * 0.021 * clamp(speed / P.walkSpeed, 0, 1.2);
    this._roll = damp(this._roll, rollTarget, 7, dt);

    this._driveWeapon(dt, elapsed, speed);
    this._applyFov(dt);
    // In third person the rig owns the transform outright, so composing the eye
    // pose first would be wasted work overwritten a line later.
    if (!this.isThirdPerson) this._applyCamera(dt);
    // Contract 3.1: the rig runs after movement has resolved. It is idempotent
    // per frame, so main.js listing it in the frame order as well is harmless.
    this.cameraRig?.update(dt, elapsed);
  }

  _tickDip(dt) {
    // Critically damped spring back to neutral.
    const k = 150;
    const c = 17;
    const step = Math.min(dt, 1 / 40);
    this._dipVel += (-this._dip * k - this._dipVel * c) * step;
    this._dip += this._dipVel * step;
    this._dip = clamp(this._dip, -0.42, 0.12);
  }

  _driveWeapon(dt, elapsed, speed) {
    // A Loadout, once attached, owns everything in the player's hands - including
    // this machine gun, which it adopts rather than rebuilding. Driving the weapon
    // from here as well would double the fire rate and fight over the viewmodel
    // pose every frame, so this method stands down entirely.
    if (this.loadout) return;

    const w = this._weapon;
    // Belt-and-braces: `main.js` always attaches a Loadout, whose own
    // `update()` already gates this, but a bare Player driven without one
    // must not carry or fire a weapon in a world that forbids it either.
    if (!allows(this._world, 'weapons')) {
      w.setVisible(false);
      return;
    }
    const s = this.input.state;
    const usable = !this._dead && !this.input.textCaptured;

    // The viewmodel is a first-person object composed against the eye. In third
    // person the avatar carries a real weapon in its hand instead, so the
    // viewmodel is hidden outright rather than left floating at the boom pivot.
    w.setVisible(!this._harnessFrozen && !this.isThirdPerson);
    if (this._harnessFrozen) return;

    w.setAim(usable && !!s.aim);
    w.setLowered(!usable || this._sprinting);
    w.setEnabled(usable);

    w.setViewContext({
      referenceFov: this._referenceFov(),
      moveSpeed: speed,
      grounded: this._grounded,
      groundY: this._position.y,
      lookDeltaX: this._lastLookX,
      lookDeltaY: this._lastLookY,
      velocity: this._velocity,
      bobPhase: this._bobPhase,
      bobWeight: this._bobWeight,
      dt,
    });

    if (usable) {
      if (s.fire) w.tryFire(elapsed);
      if (this.input.pressed('KeyR')) w.reload(elapsed);
    }

    w.update(dt, elapsed);
  }

  /** FOV the viewmodel should be composed at, i.e. excluding the sprint kick. */
  _referenceFov() {
    const base = CONFIG.render.fov;
    return THREE.MathUtils.lerp(base, base * 0.7, this._weapon.aimProgress);
  }

  _applyFov(dt) {
    if (this._harnessFrozen) return;
    const base = CONFIG.render.fov;
    const aim = this._weapon.aimProgress;
    // Sprint widens the frame; ADS overrides it and pulls in.
    const hSpeed = Math.hypot(this._velocity.x, this._velocity.z);
    /* Normalised against the WISH speed, deliberately. The kick therefore tops
     * out at 6.5 * 8.2/11.2 = 4.759 degrees rather than saturating at 6.5,
     * which is what it has always done and is a look, not an accident. It read
     * 6.5 * 6.0/8.2 = 4.756 before the sprint cap was raised to 8.2: the wish
     * was raised in the same proportion precisely so this number would not
     * move. Swapping in `sprintSpeed` would make this reach its full
     * amplitude - a real change to how a sprint feels.
     * @see ../core/Config.js `sprintWishSpeed` */
    const sprintKick = this._sprinting ? 6.5 * clamp(hSpeed / P.sprintWishSpeed, 0, 1) : 0;
    // Event kick on top of the state kick. @see punchFov
    const punch = this._fovPunch;
    if (punch > 0) {
      this._fovPunch = damp(punch, 0, FOV_PUNCH_DECAY, dt);
      if (this._fovPunch < 0.01) this._fovPunch = 0;
    }
    const target = THREE.MathUtils.lerp(base + sprintKick + punch, base * 0.7, aim);
    const next = damp(this._fov, target, 9, dt);
    if (Math.abs(next - this._fov) > 0.005) {
      this._fov = next;
      this.camera.fov = next;
      this.camera.updateProjectionMatrix();
    }
  }

  /** Compose eye transform: stance, step smoothing, bob, landing dip, recoil. */
  _applyCamera(dt) {
    if (this._harnessFrozen) {
      this._frozenApplied = true;
      return;
    }
    const cam = this.camera;

    // Head bob in view space: vertical at twice the lateral frequency.
    const amp = P.bobAmplitude * this._bobWeight;
    const p = this._bobPhase;
    const bobY = Math.sin(p * 2) * amp;
    const bobX = Math.cos(p) * amp * 0.72;
    const bobRoll = Math.sin(p) * 0.006 * this._bobWeight;

    const sinY = Math.sin(this._yaw);
    const cosY = Math.cos(this._yaw);
    const rightX = cosY;
    const rightZ = -sinY;

    cam.position.set(
      this._position.x + rightX * bobX,
      this._position.y + this._eyeHeight - this._stepSmooth + bobY + this._dip,
      this._position.z + rightZ * bobX
    );

    const kick = this._weapon.getRecoilOffset();
    // Landing dip also pitches the view down slightly - the head nods forward.
    const dipPitch = this._dip * 0.35;
    // Impact kick, on top of the weapon recoil and clamped with it: it moves
    // the camera and never the aim, so a maul cannot spin the player's view
    // round or point it at the sky.
    const hit = this._kick;
    cam.rotation.set(
      clamp(
        this._pitch + kick.y + dipPitch + hit.pitch + this._posePitch,
        -MAX_PITCH - 0.2,
        MAX_PITCH + 0.2
      ),
      this._yaw + kick.x + hit.yaw,
      this._roll + bobRoll + hit.roll + this._poseRoll,
      'YXZ'
    );
  }

  dispose() {
    this._offRules?.();
    this._offRules = null;
    this._offFired?.();
    this._offFired = null;
    this._offShake?.();
    this._offShake = null;
    this._offWater?.();
    this._offWater = null;
    this._offMounted?.();
    this._offMounted = null;
    this._offWorld?.();
    this._offWorld = null;
    this._offWorldReady?.();
    this._offWorldReady = null;
    this._ownWater?.dispose();
    this._ownWater = null;
    this._offLate?.();
    this._offLate = null;
    this._weapon.dispose();
  }
}
