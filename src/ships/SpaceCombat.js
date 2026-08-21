import * as THREE from 'three';
import { AlienShip, ALIEN_CLASSES, buildAlienModel } from '../npc/AlienShip.js';
import { SHIP_CLASSES, SHIP_BASE_STATS, SHIP_STAT_META } from './ShipStats.js';
import { DOCK_ANCHOR } from '../worlds/space/Bodies.js';

/**
 * LASERS, BOTH WAYS.
 *
 * ===========================================================================
 *  WHY THIS IS NOT `systems/Projectiles.js`
 * ===========================================================================
 *
 * The brief said to reuse `Projectiles` "or say so if you must write a
 * space-scale version". Here is the saying-so, with the numbers.
 *
 * `Projectiles` is a good system and every one of its decisions is correct for
 * the world it was written in - and every one of them is wrong here:
 *
 *   SPEED. An arrow is 80 m/s and a fireball is 52. A laser bolt has to
 *   outrun a Kestrel doing 455 m/s under boost, and be quick enough that a
 *   700 m shot is a lead problem rather than a prayer. Ours is 1,600 m/s -
 *   twenty times a fireball.
 *
 *   WHAT IT HITS. Every `Projectiles` shot resolves through `physics.raycast`
 *   against the world's collider set, then `npcManager.raycastNPCs` against
 *   humanoid capsules. Out here there are no colliders within 26 km of the
 *   yard (the belt's rocks are the nearest, and they are 26 km to port), and
 *   there are no NPCs - a hostile craft is not an `NPC`, it has no capsule and
 *   no `Grounding`. Both of its two hit paths would be dead code every frame.
 *
 *   WHAT IT DRAWS. Trails, embers, smoke, scorch decals on surfaces, stuck
 *   arrows, shockwaves and three pooled point lights. There are no surfaces to
 *   scorch in vacuum, no smoke to hang in it, and `RIG_BUDGET.point` is 12 for
 *   the whole game with every one of them compiled into every shader in every
 *   world - three more, live, in the world with the most expensive shaders, is
 *   not a trade worth making for a flash that bloom already draws.
 *
 *   HOW MANY. `MAX_PROJECTILES` is 32. Two skiffs and a lance firing bursts of
 *   two and three at 1,350 m/s over 900 m, plus a player holding the trigger
 *   at five a second, saturates 32 in about a second and a half - at which
 *   point `spawn` starts recycling the oldest LIVE bolt, and shots begin
 *   vanishing mid-flight.
 *
 * So: a second pool, 128 bolts, two draw calls, swept against spheres. What is
 * NOT rewritten is the thinking - the sweep-the-segment-you-are-about-to-cross
 * rule is `Projectiles`' and it is inherited verbatim, because at 1,600 m/s a
 * bolt moves 26.7 m per fixed step and a point test against a 4.2 m skiff
 * would miss it six times out of seven.
 *
 * ===========================================================================
 *  WHAT MAKES THE UPGRADE LADDER MATTER
 * ===========================================================================
 *
 * `ShipStats.SHIP_STAT_META` has sold `fire` as "15% laser damage" and
 * `shield` as "10% less hull damage" since the customiser shipped, and
 * `Ship.applyPowers` has been banking both into `_fireTier` and `_shieldTier`
 * ever since - applied to nothing. `Ship.js` records why that was allowed:
 * *"a purchase whose entire effect is a slightly earlier lap time is
 * indistinguishable from a purchase that did nothing"*, and the mitigation was
 * to ship the wiring early and the effect later. This is the later.
 *
 *   fireTier   -> `1 + 0.15 * tier` on every bolt, which is the panel's own
 *                 number applied literally. Base bias counts: a Pike is
 *                 `fire: 4` out of the box, so it leaves the yard at x1.60
 *                 while a Kestrel leaves at x1.15.
 *   shieldTier -> BOTH halves, and this is the one place the published copy
 *                 needed a decision. `SHIELD_PER_TIER` metres of shield pool
 *                 per tier is the new thing; "10% less hull damage" is honoured
 *                 exactly as written on whatever gets THROUGH the pool. A
 *                 Dray (`shield: 3`) therefore carries 165 points of shield and
 *                 takes 30% less on the hull; a Kestrel carries 55 and takes
 *                 10% less. That is the difference between an ore tender that
 *                 can be shot at and a courier that cannot.
 *
 * Neither is read off the private `Ship` instance. Both are recomputed here
 * from `SHIP_BASE_STATS` plus `ShipRegistry.getPowers`, which is the same
 * arithmetic `Ship.applyPowers` does from the same two public sources - so a
 * hull the registry has not adopted yet (which happens for one frame after a
 * world change) still has the right gun.
 *
 * ===========================================================================
 *  ENCOUNTER PLACEMENT, WHICH IS THE HARD PART
 * ===========================================================================
 *
 * Citadel's lesson was that content placed where nobody goes is invisible; the
 * brief adds that content dumped on the player is worse. Both are placement
 * problems and both are solved by the same three rules:
 *
 *   1. ZONES SIT ON THE ROUTES THE PLAYER ALREADY FLIES. `SpaceWorld` publishes
 *      them (see `SpaceWorld._fillEncounters`) and every one of them is on the
 *      dock-to-Cinder line or at Halberd Reach, because those are the only two
 *      places in 800 km that a player has a reason to be. A picket parked in
 *      empty space at a random bearing is the zero-reachable-wildlife defect
 *      with guns.
 *
 *   2. NOTHING SPAWNS NEAR THE YARD. `SAFE_RADIUS` is 9 km and it is checked at
 *      the spawner, not just at the zone, so a zone that were ever authored too
 *      close still could not fire. The nearest authored zone is 20 km out.
 *
 *   3. THEY ARRIVE AHEAD OF YOU, OUTSIDE WEAPONS RANGE, AND HOLD FIRE. The
 *      launch cone is 900-1,250 m and biased into the forward hemisphere, so a
 *      wing appears as three red sparks you can see coming; `holdFire` gives
 *      1.8 s of warning before the first bolt. Never behind, never inside
 *      `SPAWN_MIN`, never while docked, landed or mid-seam.
 *
 * ===========================================================================
 *  INTERDICTION, AND THE ONE LINE IT COSTS ELSEWHERE
 * ===========================================================================
 *
 * `Piloting`'s transit multiplies displacement by eight while the throttle is
 * pinned and nothing is within 4 km. Without a hook, every encounter in this
 * file would be flown past at 3,640 m/s before the first burst landed - the
 * fight would exist and never happen, which is this project's signature defect
 * in a new costume.
 *
 * So `SpaceCombat` writes `piloting.interdicted` and `Piloting._clearOfEverything`
 * reads it. That is the entire change to a file this drop does not own, it is
 * two lines, and it is the genre's own answer: something has a lock on you, so
 * you are in normal space until it does not.
 */

/* ------------------------------------------------------------------ */
/* Constants. Each one is stated against the thing it is measured on.  */
/* ------------------------------------------------------------------ */

/**
 * The player's gun, at `fireTier` 0. Damage is multiplied by the tier.
 *
 * 16 damage and 95 skiff integrity is six hits from a stock Kestrel (x1.15 ->
 * 18.4) and four from a stock Pike (x1.60 -> 25.6). At the sustained rate
 * below that is 1.8 s and 1.2 s of time-on-target respectively, which is a
 * dogfight rather than a click.
 */
export const GUN = Object.freeze({
  damage: 16,
  /** m/s. Fast enough that 700 m is a lead problem, not a prayer. */
  speed: 1600,
  /** Metres. Comfortably inside `Scale.NEAR_FIELD` (1400), which is the
   *  distance out to which everything is drawn at its TRUE position - so the
   *  thing you are shooting at is where the maths says it is. */
  range: 1000,
  /** Seconds between shots when the capacitor can pay for them. 5/s. */
  interval: 0.20,
  /**
   * Capacitor. 100 units, 9 a shot, 30/s back, and NO recharge delay.
   *
   * The delay is the interesting part of this note. It was 0.35 s, on the
   * reflex that a gun should have a vent - and 0.35 s of dead time after every
   * shot, on top of the 9/30 = 0.3 s it takes to afford the next one, means a
   * sustained rate of 1/(0.35 + 0.3) = 1.54 shots a second. Against a burst
   * rate of five that is not a capacitor, it is a jam: measured in the browser
   * at 2 shots in 1.2 seconds while the trigger was held, which reads as the
   * gun being broken rather than as a resource being managed.
   *
   * With no delay the ladder is the one the design wanted and a player can
   * feel: eleven shots at 5/s straight off a full charge, then a steady
   * 30/9 = 3.33/s for as long as you hold it. The cliff is visible on the bar
   * and it is a decision; the jam was neither.
   */
  capacity: 100,
  cost: 9,
  regen: 30,
  regenDelay: 0,
});

/**
 * Metres up the nose line where the two guns cross, and the furthest a muzzle
 * may sit from the keel. Both exist because of the Dray - see `_playerGun`.
 *
 * 550 is `GUN.range * 0.55`, and it is deliberately the same point `_drawAim`
 * puts the reticle at: the crosshair is exact exactly where the bolts meet.
 */
export const CONVERGE = 550;
export const MAX_SPAN = 3.2;

/** Shield pool per point of `shieldTier`. See the ladder note in the header. */
export const SHIELD_PER_TIER = 55;
/** Floor, so a hull with no shield bias is still not made of paper. */
export const SHIELD_FLOOR = 40;
/** Points per second, once `SHIELD_DELAY` has passed without a hit. */
export const SHIELD_REGEN = 9;
export const SHIELD_DELAY = 4.5;

/** No hostile may exist within this of the yard mouth. Rule 2 in the header. */
export const SAFE_RADIUS = 9000;
/** Launch shell around the player: never nearer, never further. */
export const SPAWN_MIN = 900;
export const SPAWN_MAX = 1250;
/** Seconds a fresh wing may not fire for. The warning. */
export const HOLD_FIRE = 1.8;

/**
 * THE HULL ALARM. The warning that was not there.
 *
 * Driven cold, a whole session ended like this and nothing else was said:
 *
 *     "3 hostile contacts - Cinder high orbit."     (info toast)
 *     "Autopilot returned the hull to Lodestar Yard."  (warn toast)
 *     player:died { killerId: "laser" }
 *
 * Integrity read 100 on the last check the player made before it happened. 27
 * points of damage arrived across one engagement with no on-screen cue that
 * the hull - as opposed to the shield - was being opened at all.
 *
 * Two rungs, because one is a threshold and two is a trend: a pilot who sees
 * DAMAGED and then CRITICAL knows which way it is going and has a decision to
 * make (run for the yard, or press). `WARN_HOLD` is how long the banner sits
 * up and `WARN_REPEAT` how often it comes back while the hull stays under -
 * a one-shot alarm on the frame you cross 34% is an alarm nobody sees.
 */
export const HULL_WARN_FRAC = 0.55;
export const HULL_CRIT_FRAC = 0.28;
export const WARN_HOLD = 3.4;
export const WARN_REPEAT = 6.0;
/** Leave the fight by this much and the wing stands down. */
export const DISENGAGE = 3600;
/** Seconds before a cleared zone can fire again. */
export const REARM_CLEARED = 210;
/** ...and before one the player merely ran away from can. */
export const REARM_FLED = 45;

/** Bolts in flight, both sides. See the pool note in the header. */
const MAX_BOLTS = 128;
/** Sparks, flashes and debris. */
const MAX_FLARES = 260;
/** Salvage canisters floating at once. */
const MAX_SALVAGE = 8;
/** Hostiles alive at once, across every class. */
const MAX_HOSTILES = 6;
/** Metres. Fly this close to a canister and it is scooped. */
const SCOOP_RANGE = 60;
/** Seconds a canister drifts before it is lost. */
const SALVAGE_LIFE = 60;

/** Module-level scratch. HOUSE RULE: a frame handler allocates nothing. */
const _v = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _v3 = new THREE.Vector3();
const _seg = new THREE.Vector3();
const _rel = new THREE.Vector3();
const _fwd = new THREE.Vector3();
const _right = new THREE.Vector3();
const _up = new THREE.Vector3();
const _prevDir = new THREE.Vector3();
const _mtx = new THREE.Matrix4();
const _quat = new THREE.Quaternion();
const _scale = new THREE.Vector3();
const _col = new THREE.Color();
const _mouth = new THREE.Vector3(...DOCK_ANCHOR.mouth);
const _target = { position: new THREE.Vector3(), velocity: new THREE.Vector3(), jink: 0 };
const _FWD_Z = new THREE.Vector3(0, 0, 1);

const clamp = THREE.MathUtils.clamp;

export class SpaceCombat {
  /**
   * @param {{scene:THREE.Scene, camera:THREE.PerspectiveCamera, bus:any,
   *          input:any, player:any, worldManager:any, piloting:any,
   *          ships?:any, economy?:any, rnd?:()=>number}} ctx
   */
  constructor({
    scene, camera, bus, input, player, worldManager, piloting,
    ships = null, economy = null, rnd = Math.random,
  }) {
    this.scene = scene;
    this.camera = camera ?? null;
    this.bus = bus ?? null;
    this.input = input ?? null;
    this.player = player ?? null;
    this.worldManager = worldManager ?? null;
    this.piloting = piloting ?? null;
    this.ships = ships ?? null;
    this.economy = economy ?? null;
    this.rnd = rnd;

    /** Everything this system draws hangs off one node, so it is one remove. */
    this.group = new THREE.Group();
    this.group.name = 'combat';
    scene?.add?.(this.group);

    /** @type {Map<string, object>} one model per class, shared by every craft. */
    this._models = new Map();
    /** @type {AlienShip[]} */
    this.hostiles = [];

    /** Zones published by the live world. Replaced on every world change. */
    this._zones = [];
    /** zone id -> seconds until it may fire again. */
    this._cool = new Map();

    /* Player state. */
    this.shield = 0;
    this.shieldMax = SHIELD_FLOOR;
    this.gunCharge = GUN.capacity;
    this._fireCool = 0;
    this._gunIdle = 0;
    this._shieldIdle = 0;
    /** Seconds of screen flash left, and which kind. */
    this.hitFlash = 0;
    this.hitKind = 'shield';
    /** Radians/second the player's velocity direction is turning. */
    this.jink = 0;
    /** False until `_readTarget` has one previous heading to difference. */
    this._hasPrev = false;
    /** @type {AlienShip|null} */
    this.target = null;
    /** Seconds the "contacts" banner stays up. */
    this.warn = 0;
    this._warnText = '';
    /** Which rung of `_hullAlarm` is up, and the countdown to its repeat. */
    this._hullRung = null;
    this._hullSince = 0;

    /** Tallies. Read by the HUD, the tests and the trip report. */
    this.stats = { kills: 0, shotsFired: 0, shotsHit: 0, bounty: 0, taken: 0, salvaged: 0 };
    /** The zone currently being fought, or null. */
    this.zone = null;

    this._buildBolts();
    this._buildFlares();
    this._buildSalvage();
    this._chargeShield();

    /* Screen-space aim marks, published as NDC so the HUD can stay a HUD.
     * `on` is false when the point is behind the camera or off the plate. */
    this.aim = { x: 0, y: 0, on: false };
    this.lead = { x: 0, y: 0, on: false, range: 0 };

    /* A HULL LEAVES THE YARD WITH ITS SHIELDS UP.
     *
     * `_regen` sizes the pool from the tier every step and preserves the
     * FRACTION when the ceiling moves, which is right for an upgrade bought
     * mid-session and wrong for the very first step of a session: the pool
     * starts at zero, the fraction is therefore zero, and the player launches
     * naked and spends eleven seconds regenerating. Measured before this: the
     * shield read 0% at t = 0.0 s on every flight. */
    this._offBoard = bus?.on?.('pilot:boarded', () => this._chargeShield());
    this._offWorld = bus?.on?.('world:changed', () => this._adopt());
    /* Leaving the seat ends the fight. Dying in it does too - `Piloting._onDied`
     * flies the hull home, and hostiles left circling an empty patch of sky
     * would still be there when the player launched again. */
    this._offLeft = bus?.on?.('pilot:left', () => this.standDown('left'));
    this._offTravel = bus?.on?.('pilot:travelling', () => this.standDown('travel'));
    this._adopt();
  }

  /* ================================================================== */
  /* Published surface                                                   */
  /* ================================================================== */

  /** True while at least one hostile is alive. */
  get engaged() {
    for (const h of this.hostiles) if (h.alive) return true;
    return false;
  }

  /** How many are alive right now. */
  get contacts() {
    let n = 0;
    for (const h of this.hostiles) if (h.alive) n++;
    return n;
  }

  /** The hull the player is flying, as the two tiers that matter. */
  tiers(shipId = this.piloting?.shipId) {
    const base = SHIP_BASE_STATS[shipId] ?? {};
    const bought = this.ships?.getPowers?.(shipId) ?? {};
    const t = (k) => Math.max(0, Math.floor(Number(bought?.[k]) || 0));
    return {
      fire: (base.fire ?? 0) + t('fire'),
      shield: (base.shield ?? 0) + t('shield'),
    };
  }

  /** Damage one of the player's bolts does. The panel's own 15% per tier. */
  boltDamage(shipId = this.piloting?.shipId) {
    return GUN.damage * (1 + (SHIP_STAT_META.fire.perTier / 100) * this.tiers(shipId).fire);
  }

  /** Everything the flight HUD draws, in one read. Fills a caller's object. */
  report(out = {}) {
    out.engaged = this.engaged;
    out.contacts = this.contacts;
    out.shield = this.shield;
    out.shieldMax = this.shieldMax;
    out.shieldFrac = this.shieldMax > 0 ? this.shield / this.shieldMax : 0;
    out.gun = GUN.capacity > 0 ? this.gunCharge / GUN.capacity : 0;
    out.hitFlash = this.hitFlash;
    out.hitKind = this.hitKind;
    out.warn = this.warn;
    out.warnText = this._warnText;
    out.kills = this.stats.kills;
    out.bounty = this.stats.bounty;
    out.aim = this.aim;
    out.lead = this.lead;
    const t = this.target;
    const f = this.piloting?.flight ?? null;
    out.target = t && t.alive && f
      ? {
        name: t.name,
        range: t.position.distanceTo(f.position),
        frac: t.healthFrac,
        state: t.state,
      }
      : null;
    return out;
  }

  /* ================================================================== */
  /* Fixed step                                                          */
  /* ================================================================== */

  /**
   * Runs AFTER `piloting.fixedUpdate`, because every hostile leads its shots
   * against the position the player's integrator wrote THIS step. Reading last
   * step's position at a 455 m/s closure is a 7.6 m aiming error handed to the
   * enemy for free, in the player's favour on approach and against them on
   * separation - which is the worst kind of bug, because it makes the fight
   * inconsistent rather than merely wrong.
   */
  fixedUpdate(dt, elapsed) {
    const live = this._playable();

    this.hitFlash = Math.max(0, this.hitFlash - dt);
    this.warn = Math.max(0, this.warn - dt);
    if (live) this._hullAlarm(dt);

    if (live) {
      this._readTarget(dt);
      this._regen(dt);
      this._playerGun(dt);
      this._steps(dt, elapsed);
      this._stepBolts(dt, true);
      this._stepSalvage(dt);
      this._spawner(dt);
      this._retarget();
    } else if (this.hostiles.length) {
      this._stepBolts(dt, false);
    }

    /* THE HOOK INTO TRANSIT, AND IT IS WRITTEN LAST ON PURPOSE.
     *
     * `main.js` runs `piloting.fixedUpdate` BEFORE this, so the flag piloting
     * reads is always the one written at the end of the previous step. Writing
     * it at the TOP of this method - which the first version did - meant it
     * described the state before `_spawner` had run, so on the step a wing
     * launched the flag still said "clear" and the ship covered one more step
     * at eight times speed. Written here it is the freshest fact available to
     * the next step, and the stale window is gone.
     *
     * It is also cleared the step the last hostile dies, so a cleared field
     * lets the player leave at transit immediately rather than after a timer. */
    if (this.piloting) this.piloting.interdicted = live && this.engaged;
  }

  /** Is there a ship, flying, in the void, not mid-seam? */
  _playable() {
    const p = this.piloting;
    if (!p?.active || p._travelling) return false;
    if (p.landed) return false;
    return (this.worldManager?.active?.id ?? null) === 'space';
  }

  /**
   * The target struct every hostile aims at, plus the jink measurement their
   * accuracy is degraded by.
   *
   * `jink` is the rate at which the velocity DIRECTION is turning, normalised
   * against the player's own best turn rate so 1.0 means "pulling as hard as
   * this hull can". Measured off the real integrator rather than off the
   * command struct on purpose: a player who holds full pitch while pointing
   * straight at a planet at 40 m/s is not jinking, whatever the stick says.
   */
  _readTarget(dt) {
    const f = this.piloting.flight;
    _target.position.copy(f.position);
    _target.velocity.copy(f.velocity);
    const sp = f.velocity.length();
    if (sp > 1 && dt > 0) {
      _v.copy(f.velocity).divideScalar(sp);
      if (this._hasPrev) {
        const dot = clamp(_v.dot(_prevDir), -1, 1);
        const rate = Math.acos(dot) / dt;
        /* Damped, because a single step's arccos is noisy near zero and a
         * hostile whose aim flickers frame to frame reads as a bug. */
        this.jink += (clamp(rate / 1.4, 0, 1) - this.jink) * Math.min(1, dt * 6);
      }
      _prevDir.copy(_v);
      this._hasPrev = true;
    } else {
      this.jink += (0 - this.jink) * Math.min(1, dt * 6);
    }
    _target.jink = this.jink;
  }

  /* ------------------------------------------------------------------ */
  /* The player's gun                                                    */
  /* ------------------------------------------------------------------ */

  _playerGun(dt) {
    this._fireCool = Math.max(0, this._fireCool - dt);
    this._gunIdle += dt;
    if (this._gunIdle > GUN.regenDelay) {
      this.gunCharge = Math.min(GUN.capacity, this.gunCharge + GUN.regen * dt);
    }

    const inp = this.input;
    if (!inp || inp.textCaptured) return;
    if (!inp.state?.fire) return;
    if (this._fireCool > 0 || this.gunCharge < GUN.cost) return;

    this._fireCool = GUN.interval;
    this.gunCharge -= GUN.cost;
    this._gunIdle = 0;

    const f = this.piloting.flight;
    f.forward(_fwd);
    f.right(_right);
    f.up(_up);
    /* -- WHERE THE GUNS POINT, AND THE DRAY THAT COULD NOT HIT ANYTHING ------
     *
     * The first version put a muzzle at each wingtip firing PARALLEL to the
     * nose, on the argument that parallel guns make the reticle true at every
     * range. It does - and on the Dray it made the gun useless. A 28 m ore
     * tender has a 6.16 m half-span at `length * 0.22`, so its two bolts
     * straddle a 4.2 m skiff sitting dead on the crosshair and both miss, at
     * every range, forever. The case that found it fired forty shots at a
     * stationary target 200 m dead ahead and did no damage at all.
     *
     * Two changes, and both are needed:
     *
     *   CONVERGENCE. The bolts are aimed at a point `CONVERGE` metres up the
     *   nose line, which is the SAME point `_drawAim` projects the reticle to.
     *   The crosshair is therefore exact exactly where the guns cross, which
     *   is the honest version of what parallel guns were meant to buy.
     *
     *   A CAP ON THE SPAN. Convergence alone still spreads at close range - at
     *   100 m a 6.16 m span is still 5 m off the axis - so the span is capped
     *   at `MAX_SPAN`. Past that the guns move in from the wingtips toward the
     *   chin, which is where a heavy hauler would carry them anyway.
     *
     * The span comes from `SHIP_CLASSES[...].length`, public catalogue data.
     * The flown model's own radius is on `Piloting._model`, and reading a
     * private field to place a muzzle is how two descriptions of one ship
     * start to drift. */
    const len = SHIP_CLASSES[this.piloting.shipId]?.length ?? 14;
    const span = Math.min(len * 0.22, MAX_SPAN);
    const dmg = this.boltDamage();
    _v3.copy(f.position).addScaledVector(_fwd, CONVERGE);
    for (let s = -1; s <= 1; s += 2) {
      _v.copy(f.position).addScaledVector(_right, span * s).addScaledVector(_up, -0.6);
      _v2.copy(_v3).sub(_v).normalize();
      this._spawnBolt(_v, _v2, GUN.speed, dmg, GUN.range, 0);
      /* The muzzle bloom, and both numbers in it were wrong first time.
       *
       * It was 1.9 m across for 0.09 s in (2.4, 0.32, 3.4) - and (2.4, 0.32,
       * 3.4) is MAGENTA, which matched nothing on either side of the fight and
       * looked like a bug; at 1.9 m, sitting on the wingtips of a hull that
       * fills the middle of the chase view, two of them covered a third of the
       * plate every fifth of a second. Screenshotted, and unmistakable.
       *
       * It is now the bolt's own cyan at a fifth the size and a shorter life:
       * a spark where the gun is, not a firework. */
      this._flare(_v, _v2, 0.62, 0.055, 0.7, 3.2, 4.2, 26);
    }
    this.stats.shotsFired++;
    this.bus?.emit?.('combat:fire', { position: f.position, ship: this.piloting.shipId });
  }

  /* ------------------------------------------------------------------ */
  /* Hostiles                                                            */
  /* ------------------------------------------------------------------ */

  _steps(dt, elapsed) {
    const fire = this._alienFire;
    for (let i = 0; i < this.hostiles.length; i++) {
      this.hostiles[i].fixedUpdate(dt, elapsed, _target, fire);
    }
  }

  /* Bound once in the constructor's stead - an arrow property, so the callback
   * handed to every craft every step is one function and not a closure made
   * sixty times a second. */
  _alienFire = (from, dir, ship) => {
    this._spawnBolt(from, dir, ship.def.boltSpeed, ship.def.damage, ship.def.range * 1.25, 1, ship);
    this._flare(from, dir, 1.5, 0.08, 3.2, 0.42, 0.18, 14);
    this.bus?.emit?.('combat:enemyFire', { position: from, classId: ship.classId });
  };

  /** Nearest live hostile, sticky, biased to the one you are pointing at. */
  _retarget() {
    const f = this.piloting.flight;
    f.forward(_fwd);
    const cur = this.target;
    if (cur?.alive) {
      const d = cur.position.distanceTo(f.position);
      _v.copy(cur.position).sub(f.position);
      if (d < 1600 && (d < 1e-3 || _v.normalize().dot(_fwd) > 0.35)) return;
    }
    let best = null;
    let bestScore = -Infinity;
    for (const h of this.hostiles) {
      if (!h.alive) continue;
      const d = h.position.distanceTo(f.position);
      if (d > 1600) continue;
      _v.copy(h.position).sub(f.position);
      const ahead = d > 1e-3 ? _v.normalize().dot(_fwd) : 1;
      /* Ahead beats near: the thing you are pointing at is the thing you want
       * a range readout for, and a hostile 200 m behind you is not one you can
       * do anything about this second. */
      const score = ahead * 2 - d / 1600;
      if (score > bestScore) { bestScore = score; best = h; }
    }
    this.target = best;
  }

  /* ------------------------------------------------------------------ */
  /* Bolts                                                               */
  /* ------------------------------------------------------------------ */

  _buildBolts() {
    /* One box, stretched along +Z per instance and pointed down the velocity.
     * A box and not a cylinder: at these speeds a bolt is 12 m of streak
     * covering four pixels of width, and eight vertices draw it exactly as
     * well as forty-eight. */
    this._boltGeo = new THREE.BoxGeometry(1, 1, 1);
    this._boltMat = new THREE.MeshBasicMaterial({
      color: 0xffffff, fog: false, toneMapped: false,
    });
    this._boltMesh = new THREE.InstancedMesh(this._boltGeo, this._boltMat, MAX_BOLTS);
    this._boltMesh.name = 'combat:bolts';
    this._boltMesh.frustumCulled = false;
    this._boltMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    /* `setColorAt` once with anything at all is what creates `instanceColor`;
     * doing it here means the attribute exists before the first frame and the
     * material's program is compiled with it. Allocating it lazily on the
     * first shot would relink the shader in the middle of a firefight. */
    for (let i = 0; i < MAX_BOLTS; i++) this._boltMesh.setColorAt(i, _col.setRGB(0, 0, 0));
    this.group.add(this._boltMesh);

    const N = MAX_BOLTS;
    this._b = {
      px: new Float32Array(N), py: new Float32Array(N), pz: new Float32Array(N),
      vx: new Float32Array(N), vy: new Float32Array(N), vz: new Float32Array(N),
      life: new Float32Array(N),
      dmg: new Float32Array(N),
      /** 0 = the player's, 1 = a hostile's. */
      side: new Uint8Array(N),
      active: new Uint8Array(N),
      /** Who fired it, so a hit can be credited. */
      owner: new Array(N).fill(null),
    };
    this._boltCount = 0;
    this._boltHead = 0;
  }

  _spawnBolt(origin, dir, speed, damage, range, side, owner = null) {
    const b = this._b;
    let slot = -1;
    for (let k = 0; k < MAX_BOLTS; k++) {
      const i = (this._boltHead + k) % MAX_BOLTS;
      if (b.active[i] === 0) { slot = i; break; }
    }
    /* Saturated. Drop the NEWEST shot rather than recycling a live one:
     * a bolt that vanishes mid-flight is a hit the player watched not happen,
     * and a shot that was never drawn is one they never saw. With 128 slots
     * and the cadences in `ALIEN_CLASSES` this cannot be reached by the
     * authored wings; it is here so that it cannot be reached by a future one
     * either. */
    if (slot < 0) return -1;
    this._boltHead = (slot + 1) % MAX_BOLTS;

    b.px[slot] = origin.x; b.py[slot] = origin.y; b.pz[slot] = origin.z;
    b.vx[slot] = dir.x * speed; b.vy[slot] = dir.y * speed; b.vz[slot] = dir.z * speed;
    b.life[slot] = range / speed;
    b.dmg[slot] = damage;
    b.side[slot] = side;
    b.owner[slot] = owner;
    b.active[slot] = 1;
    this._boltCount++;
    return slot;
  }

  /**
   * Integrate every bolt and resolve the segment it is about to cross.
   *
   * SWEPT, and the reasoning is `Projectiles`': at 1,600 m/s a fixed step is
   * 26.7 m of travel and a skiff is 4.2 m across, so a point test at the new
   * position would pass through six hostiles out of seven. The test is
   * segment-versus-sphere, closed form, no allocation:
   *
   *   solve |A + t(B-A) - C|^2 = r^2 for the smallest t in [0,1]
   *
   * @param {boolean} armed false while the player is not flying - bolts still
   *   fly and expire so a fight left behind does not freeze mid-air, but
   *   nothing can be hit by them.
   */
  _stepBolts(dt, armed) {
    if (this._boltCount === 0) return;
    const b = this._b;
    const shipPos = armed ? this.piloting.flight.position : null;
    const shipR = armed ? this._playerRadius() : 0;

    for (let i = 0; i < MAX_BOLTS; i++) {
      if (b.active[i] === 0) continue;
      b.life[i] -= dt;
      if (b.life[i] <= 0) { this._killBolt(i); continue; }

      _v.set(b.px[i], b.py[i], b.pz[i]);
      _seg.set(b.vx[i] * dt, b.vy[i] * dt, b.vz[i] * dt);
      _v2.copy(_v).add(_seg);

      let hitT = 2;
      let hitShip = null;
      if (armed) {
        if (b.side[i] === 0) {
          for (const h of this.hostiles) {
            if (!h.alive) continue;
            const t = this._sweep(_v, _seg, h.position, h.radius);
            if (t >= 0 && t < hitT) { hitT = t; hitShip = h; }
          }
        } else if (shipPos) {
          const t = this._sweep(_v, _seg, shipPos, shipR);
          if (t >= 0 && t < hitT) { hitT = t; hitShip = 'player'; }
        }
      }

      if (hitT <= 1) {
        _v3.copy(_v).addScaledVector(_seg, hitT);
        if (hitShip === 'player') this._playerHit(b.dmg[i], _v3, b.owner[i]);
        else this._hostileHit(hitShip, b.dmg[i], _v3);
        this._killBolt(i);
        continue;
      }

      b.px[i] = _v2.x; b.py[i] = _v2.y; b.pz[i] = _v2.z;
    }
  }

  /**
   * Smallest t in [0,1] at which the segment `from + t*seg` first enters the
   * sphere, or -1. Returns 0 when the segment starts inside it.
   */
  _sweep(from, seg, centre, radius) {
    _rel.copy(from).sub(centre);
    const a = seg.lengthSq();
    if (a < 1e-12) return _rel.lengthSq() <= radius * radius ? 0 : -1;
    const bq = 2 * _rel.dot(seg);
    const c = _rel.lengthSq() - radius * radius;
    if (c <= 0) return 0;
    const disc = bq * bq - 4 * a * c;
    if (disc < 0) return -1;
    const t = (-bq - Math.sqrt(disc)) / (2 * a);
    return t >= 0 && t <= 1 ? t : -1;
  }

  _killBolt(i) {
    this._b.active[i] = 0;
    this._b.owner[i] = null;
    this._boltCount--;
  }

  /** Hit sphere of the flown hull. Public catalogue data - see `_playerGun`. */
  _playerRadius() {
    return (SHIP_CLASSES[this.piloting?.shipId]?.length ?? 14) * 0.45;
  }

  /* ------------------------------------------------------------------ */
  /* Damage                                                              */
  /* ------------------------------------------------------------------ */

  _hostileHit(ship, damage, at) {
    if (!ship) return;
    this.stats.shotsHit++;
    const died = ship.damage(damage);
    this._burst(at, 12, 0.16, 3.0, 1.5, 0.5);
    this.bus?.emit?.('combat:hit', { position: at, target: ship.classId, damage, died });
    if (died) this._onKill(ship, at);
  }

  _onKill(ship, at) {
    this.stats.kills++;
    const bounty = ship.def.bounty;
    this.stats.bounty += bounty;
    this.economy?.add?.(bounty, 'bounty');
    this._explode(at, ship.def.radius);
    this._dropSalvage(ship);
    this.bus?.emit?.('combat:kill', {
      classId: ship.classId, name: ship.name, bounty, position: at,
    });
    this.bus?.emit?.('hud:notify', {
      text: `${ship.name} destroyed - ${bounty} CR bounty.`, tone: 'info',
    });
    /* Was that the last of them? Report the encounter and let the zone rearm. */
    if (!this.engaged) this._clearZone();
  }

  /**
   * A hit on the player.
   *
   * Shields first, then the hull, and "the hull" is the player's own health -
   * deliberately, rather than a second private pool. `Player.applyDamage`
   * already owns the damage event the HUD draws, the death that
   * `Piloting._onDied` catches to fly the wreck home, and the respawn. A
   * parallel hull bar would be a second health system that has to be kept in
   * step with the first, and the first is the one the rest of the game reads.
   */
  _playerHit(damage, at, owner) {
    this.stats.taken += damage;
    if (owner) owner.hits++;
    this._shieldIdle = 0;
    this._burst(at, 9, 0.14, 0.5, 2.0, 3.2);

    let through = damage;
    if (this.shield > 0) {
      const absorbed = Math.min(this.shield, damage);
      this.shield -= absorbed;
      through -= absorbed;
      this.hitFlash = 0.28;
      this.hitKind = this.shield <= 0 ? 'down' : 'shield';
    } else {
      this.hitFlash = 0.34;
      this.hitKind = 'hull';
    }

    if (through > 0) {
      /* The panel's published "10% less hull damage" per tier, applied
       * literally to what got through, with a floor so a maximum-shield Dray
       * (tier 6 -> 60%) is tough rather than immortal. */
      const tier = this.tiers().shield;
      const mul = Math.max(0.4, 1 - 0.10 * tier);
      this.player?.applyDamage?.(through * mul, at, 'laser');
    }

    this.bus?.emit?.('combat:playerHit', {
      damage, through, shield: this.shield, shieldMax: this.shieldMax,
      kind: this.hitKind, position: at,
    });
  }

  /**
   * Raise the hull banner while integrity is low, and drop it when it is not.
   *
   * Reads `Player.health` rather than a private pool, for the same reason
   * `_playerHit` deals damage into it: the hull IS the player's health here,
   * and a second number would be a second thing to keep in step.
   *
   * Allocates nothing - two floats and a string compare - and the string is
   * only rebuilt when the rung changes, because `_warnText` is written into
   * the DOM by `FlightHUD._drawFight` whenever `warn > 0`.
   */
  _hullAlarm(dt) {
    const hp = Number(this.player?.health);
    const max = Number(this.player?.maxHealth);
    if (!Number.isFinite(hp) || !Number.isFinite(max) || max <= 0) return;
    const frac = hp / max;

    const rung = frac <= HULL_CRIT_FRAC ? 'crit' : frac <= HULL_WARN_FRAC ? 'warn' : null;
    if (!rung) {
      /* Out of the woods. Clear only OUR banner - a zone-arrival or hold-full
       * warning set by something else is not ours to cancel, which is why the
       * owning rung is tracked rather than inferred from the text. */
      if (this._hullRung) { this._hullRung = null; if (this.warn > 0) this.warn = 0; }
      this._hullSince = 0;
      return;
    }

    this._hullSince = (this._hullSince ?? 0) - dt;
    if (rung !== this._hullRung || this._hullSince <= 0) {
      this._hullRung = rung;
      this._hullSince = WARN_REPEAT;
      this.warn = WARN_HOLD;
      this._warnText = rung === 'crit'
        ? `HULL CRITICAL - ${Math.round(frac * 100)}% - break off`
        : `Hull damaged - ${Math.round(frac * 100)}%`;
    }
  }

  /** Size the pool from the current hull's tier and fill it. */
  _chargeShield() {
    this.shieldMax = Math.max(SHIELD_FLOOR, SHIELD_PER_TIER * this.tiers().shield);
    this.shield = this.shieldMax;
    this._shieldIdle = SHIELD_DELAY;
  }

  _regen(dt) {
    /* The pool is re-derived every step rather than on board, because a player
     * can buy a shield tier at the yard, launch, and the panel would otherwise
     * be selling a number that only takes effect next session. */
    const want = Math.max(SHIELD_FLOOR, SHIELD_PER_TIER * this.tiers().shield);
    if (want !== this.shieldMax) {
      /* Keep the FRACTION when the ceiling moves, so an upgrade bought
       * mid-session neither refills a depleted shield nor leaves a full one
       * looking damaged. */
      const frac = this.shieldMax > 0 ? this.shield / this.shieldMax : 1;
      this.shieldMax = want;
      this.shield = want * frac;
    }
    this._shieldIdle += dt;
    if (this._shieldIdle > SHIELD_DELAY && this.shield < this.shieldMax) {
      this.shield = Math.min(this.shieldMax, this.shield + SHIELD_REGEN * dt);
    }
  }

  /* ------------------------------------------------------------------ */
  /* Encounters                                                          */
  /* ------------------------------------------------------------------ */

  /** Take the zones the live world publishes. Replace, never merge. */
  _adopt() {
    const w = this.worldManager?.active ?? null;
    const zones = Array.isArray(w?.encounters) ? w.encounters : [];
    this._zones = zones;
    /* Every hostile belongs to the world it was launched in. A world change
     * that this system did not cause is a fight that is over. */
    this.standDown('world');
  }

  /** Send everyone home. */
  standDown(reason = 'manual') {
    let any = false;
    for (const h of this.hostiles) {
      if (h.alive || h.dying > 0) { h.retire(); any = true; }
    }
    if (this.zone && any && reason !== 'cleared') {
      /* Ran away, or docked, or descended. A shorter rearm than a clear,
       * because the fight is unfinished rather than won. */
      this._cool.set(this.zone.id, REARM_FLED);
    }
    this.zone = null;
    this.target = null;
    if (this.piloting) this.piloting.interdicted = false;
    if (any) this.bus?.emit?.('combat:standdown', { reason });
  }

  _clearZone() {
    const z = this.zone;
    if (!z) return;
    this._cool.set(z.id, z.rearm ?? REARM_CLEARED);
    this.zone = null;
    this.bus?.emit?.('combat:cleared', { zone: z.id, name: z.name, bounty: this.stats.bounty });
    this.bus?.emit?.('hud:notify', { text: `${z.name} clear.`, tone: 'info' });
  }

  _spawner(dt) {
    for (const [k, v] of this._cool) {
      const next = v - dt;
      if (next <= 0) this._cool.delete(k); else this._cool.set(k, next);
    }
    if (this.engaged) {
      /* Already fighting: the only question is whether the player has left.
       * Measured from the CENTROID of the living wing rather than from the
       * zone, because a running fight drifts kilometres from where it started
       * and a disengage test against a fixed point would either never fire or
       * fire while the shooting was still going on. */
      _v.set(0, 0, 0);
      let n = 0;
      for (const h of this.hostiles) if (h.alive) { _v.add(h.position); n++; }
      if (n > 0) {
        _v.divideScalar(n);
        if (_v.distanceTo(this.piloting.flight.position) > DISENGAGE) this.standDown('fled');
      }
      return;
    }
    /* Wrecks are still burning; do not start a second fight over the first. */
    for (const h of this.hostiles) if (h.dying > 0) return;

    const p = this.piloting.flight.position;
    if (p.distanceTo(_mouth) < SAFE_RADIUS) return;

    for (const z of this._zones) {
      if (this._cool.has(z.id)) continue;
      _v.set(z.position[0], z.position[1], z.position[2]);
      if (p.distanceTo(_v) > z.radius) continue;
      this._launch(z);
      return;
    }
  }

  /**
   * Put a wing in the sky ahead of the player.
   *
   * The cone is biased forward but not centred on the nose. `0.85` of the
   * forward vector plus a lateral of 0.28 to 0.80 puts a craft between 18 and
   * 43 degrees off it. Those two numbers are measured against the real frustum
   * rather than chosen: `CONFIG.render.fov` is 75 degrees vertical, which at
   * 16:9 is 106 horizontal, so the corner of the plate is 53 degrees off the
   * nose. A wing at 43 is inside it with room to spare - and one at the 64
   * degrees the first version produced was OFF SCREEN when it launched, which
   * turns "three sparks closing on you" into "you are suddenly being shot".
   *
   * Directly ahead would read as a spawn; directly behind would be an ambush
   * the player never saw coming, which the brief rules out in as many words.
   */
  _launch(zone) {
    const f = this.piloting.flight;
    f.forward(_fwd);
    f.right(_right);
    f.up(_up);

    let launched = 0;
    for (const entry of zone.wing) {
      const count = entry.count ?? 1;
      for (let i = 0; i < count; i++) {
        const ship = this._take(entry.class);
        if (!ship) continue;
        const a = (this.rnd() * 2 - 1) * Math.PI;
        const lat = 0.28 + this.rnd() * 0.52;
        _v.copy(_fwd).multiplyScalar(0.85)
          .addScaledVector(_right, Math.cos(a) * lat)
          .addScaledVector(_up, Math.sin(a) * lat * 0.6)
          .normalize();
        const d = SPAWN_MIN + this.rnd() * (SPAWN_MAX - SPAWN_MIN);
        _v2.copy(f.position).addScaledVector(_v, d);
        ship.spawn(_v2, f.position, { holdFire: HOLD_FIRE, zone });
        launched++;
      }
    }
    if (launched === 0) return;

    this.zone = zone;
    this.warn = 4.2;
    this._warnText = zone.warn ?? 'Unknown transponders - closing';
    this.bus?.emit?.('combat:contacts', { zone: zone.id, name: zone.name, count: launched });
    this.bus?.emit?.('hud:notify', {
      text: `${launched} hostile contact${launched > 1 ? 's' : ''} - ${zone.name}.`, tone: 'warn',
    });
  }

  /** A free craft of a class, building the shared model on first use. */
  _take(classId) {
    if (!ALIEN_CLASSES[classId]) {
      console.error(`[SpaceCombat] encounter names unknown class "${classId}"`);
      return null;
    }
    for (const h of this.hostiles) {
      if (h.classId === classId && !h.alive && h.dying <= 0) return h;
    }
    if (this.hostiles.length >= MAX_HOSTILES) return null;
    let model = this._models.get(classId);
    if (!model) {
      model = buildAlienModel(classId);
      this._models.set(classId, model);
    }
    /* One `Group` per craft over SHARED geometry and materials. Cloning the
     * group is what makes a second skiff free: four `Mesh` objects pointing at
     * buffers that already exist on the GPU. */
    const g = model.group.clone(true);
    g.visible = false;
    this.group.add(g);
    const ship = new AlienShip({
      classId,
      model: { group: g, def: model.def, muzzles: model.muzzles },
      rnd: this.rnd,
    });
    this.hostiles.push(ship);
    return ship;
  }

  /* ------------------------------------------------------------------ */
  /* Salvage                                                             */
  /* ------------------------------------------------------------------ */

  _buildSalvage() {
    const geo = new THREE.OctahedronGeometry(2.6, 0);
    const mat = new THREE.MeshBasicMaterial({
      color: new THREE.Color(2.4, 1.55, 0.42), fog: false, toneMapped: false,
    });
    this._salvGeo = geo;
    this._salvMat = mat;
    this._salvMesh = new THREE.InstancedMesh(geo, mat, MAX_SALVAGE);
    this._salvMesh.name = 'combat:salvage';
    this._salvMesh.frustumCulled = false;
    this._salvMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.group.add(this._salvMesh);
    this._salv = [];
    for (let i = 0; i < MAX_SALVAGE; i++) {
      this._salv.push({
        active: false, t: 0,
        pos: new THREE.Vector3(), vel: new THREE.Vector3(),
        credits: 0, bulk: 0, name: '',
      });
    }
  }

  _dropSalvage(ship) {
    const s = this._salv.find((x) => !x.active);
    if (!s) return;
    s.active = true;
    s.t = SALVAGE_LIFE;
    s.pos.copy(ship.position);
    /* It keeps the wreck's momentum, slowed. A canister that hangs motionless
     * where a craft doing 170 m/s exploded looks like a prop. */
    s.vel.copy(ship.velocity).multiplyScalar(0.25);
    s.credits = ship.def.salvage;
    s.bulk = ship.def.salvageBulk;
    s.name = `${ship.name} salvage`;
  }

  _stepSalvage(dt) {
    const p = this.piloting.flight.position;
    for (const s of this._salv) {
      if (!s.active) continue;
      s.t -= dt;
      s.pos.addScaledVector(s.vel, dt);
      if (s.t <= 0) { s.active = false; continue; }
      if (s.pos.distanceTo(p) > SCOOP_RANGE) continue;

      /* SALVAGE DOES NOT DISPLACE BETTER CARGO.
       *
       * -- THE DEFECT ------------------------------------------------------
       * The scoop is automatic and had no opinion about what it was scooping
       * into. Driven cold: one skiff kill loaded 4 m3 of salvage worth 40 CR
       * into a 10 m3 Kestrel hold - 40% of the hull's entire capacity at
       * 10 CR/m3 - against iridite's 310 CR for one cubic metre. The tester's
       * note: "I never chose to pick it up and was never told."
       *
       * That was already a bad trade. It is a worse one now that being shot
       * down empties the un-banked hold (`Piloting._onDied`), because the
       * player is carrying a real stake and the ship keeps deciding to swap
       * some of it for scrap.
       *
       * The rule is the one a pilot would apply: a canister worth LESS per
       * cubic metre than what is already aboard is left where it is. Both
       * numbers are ones the game already has - `cargoValue / cargoUnits` is
       * the hold's own rate - so nothing here is a new threshold to keep
       * honest. An empty hold takes anything, which keeps the scoop the
       * pleasant thing it is on a patrol you flew out empty for.
       *
       * The canister is not destroyed. It floats its full `SALVAGE_LIFE`, so a
       * pilot who sells and comes back can still have it, exactly as a mineral
       * seam is left in the ground. */
      const units = this.piloting.cargoUnits;
      if (units > 0 && s.bulk > 0) {
        const holdRate = this.piloting.cargoValue / units;
        const salvageRate = s.credits / s.bulk;
        if (salvageRate < holdRate) {
          if (this.warn <= 0) {
            this.warn = 2.4;
            this._warnText = `Salvage left - ${Math.round(salvageRate)} CR/m³ against ${Math.round(holdRate)} aboard`;
          }
          continue;
        }
      }

      /* `stow` sizes a load as `round(size * 1.6)` cubic metres, so the bulk a
       * class publishes is divided back out here. Going through `stow` rather
       * than writing the hold directly is the point: it refuses BEFORE it
       * consumes, so a full hold leaves the canister in space rather than
       * eating it, exactly as a mineral node is left in the ground. */
      const res = this.piloting.stow({
        type: 'salvage',
        name: s.name,
        credits: s.credits,
        size: s.bulk / 1.6,
      });
      if (!res?.ok) {
        if (res?.reason === 'hold-full' && this.warn <= 0) {
          this.warn = 2.4;
          this._warnText = 'Hold full - salvage adrift';
        }
        continue;
      }
      s.active = false;
      this.stats.salvaged += s.credits;
      this.bus?.emit?.('combat:salvage', { credits: s.credits, bulk: s.bulk, name: s.name });
      this.bus?.emit?.('hud:notify', { text: `${s.name} aboard - ${s.credits} CR.`, tone: 'info' });
    }
  }

  /* ------------------------------------------------------------------ */
  /* Flares: muzzle bloom, impact sparks, wrecks                          */
  /* ------------------------------------------------------------------ */

  _buildFlares() {
    /* An icosahedron and not a textured billboard. A quad would need a
     * radial-gradient canvas texture, and a canvas at construction time is a
     * dependency on a DOM this system does not otherwise have - which matters,
     * because the headless test rig builds this. Twenty triangles of additive
     * white through the space grade's bloom is a soft ball of light anyway;
     * the bloom is doing the work the texture would have done. */
    this._flareGeo = new THREE.IcosahedronGeometry(1, 0);
    this._flareMat = new THREE.MeshBasicMaterial({
      color: 0xffffff, fog: false, toneMapped: false,
      transparent: true, blending: THREE.AdditiveBlending, depthWrite: false,
    });
    this._flareMesh = new THREE.InstancedMesh(this._flareGeo, this._flareMat, MAX_FLARES);
    this._flareMesh.name = 'combat:flares';
    this._flareMesh.frustumCulled = false;
    this._flareMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this._flareMesh.renderOrder = 6;
    for (let i = 0; i < MAX_FLARES; i++) this._flareMesh.setColorAt(i, _col.setRGB(0, 0, 0));
    this.group.add(this._flareMesh);

    const N = MAX_FLARES;
    this._f = {
      px: new Float32Array(N), py: new Float32Array(N), pz: new Float32Array(N),
      vx: new Float32Array(N), vy: new Float32Array(N), vz: new Float32Array(N),
      t: new Float32Array(N), dur: new Float32Array(N), size: new Float32Array(N),
      r: new Float32Array(N), g: new Float32Array(N), b: new Float32Array(N),
      active: new Uint8Array(N),
    };
    this._flareHead = 0;
  }

  /** One flare. Colours are pre-tone-mapping, so >1 is what blooms. */
  _flare(at, dir, size, dur, r, g, b, speed = 0) {
    const f = this._f;
    let slot = -1;
    for (let k = 0; k < MAX_FLARES; k++) {
      const i = (this._flareHead + k) % MAX_FLARES;
      if (f.active[i] === 0) { slot = i; break; }
    }
    /* Unlike a bolt, a saturated flare pool recycles: a spark that is not
     * drawn costs nothing but a slightly thinner explosion, and refusing would
     * mean the LAST kill in a busy frame is the one with no visual. */
    if (slot < 0) { slot = this._flareHead; }
    this._flareHead = (slot + 1) % MAX_FLARES;

    f.px[slot] = at.x; f.py[slot] = at.y; f.pz[slot] = at.z;
    if (dir && speed) {
      f.vx[slot] = dir.x * speed; f.vy[slot] = dir.y * speed; f.vz[slot] = dir.z * speed;
    } else {
      f.vx[slot] = 0; f.vy[slot] = 0; f.vz[slot] = 0;
    }
    f.t[slot] = dur; f.dur[slot] = dur; f.size[slot] = size;
    f.r[slot] = r; f.g[slot] = g; f.b[slot] = b;
    f.active[slot] = 1;
  }

  /** A spray of sparks in every direction. */
  _burst(at, n, dur, r, g, b) {
    for (let i = 0; i < n; i++) {
      _v.set(this.rnd() * 2 - 1, this.rnd() * 2 - 1, this.rnd() * 2 - 1);
      if (_v.lengthSq() < 1e-6) _v.set(1, 0, 0);
      _v.normalize();
      this._flare(at, _v, 0.5 + this.rnd() * 0.9, dur * (0.6 + this.rnd()), r, g, b,
        14 + this.rnd() * 46);
    }
  }

  /** A wreck. One big slow flash and a lot of fast debris. */
  _explode(at, radius) {
    this._flare(at, null, radius * 2.6, 0.5, 4.0, 1.5, 0.5, 0);
    this._flare(at, null, radius * 1.3, 0.9, 3.0, 0.7, 0.2, 0);
    this._burst(at, 34, 0.55, 3.4, 1.0, 0.3);
    this._burst(at, 14, 1.1, 1.2, 0.35, 0.12);
  }

  /* ================================================================== */
  /* Frame                                                               */
  /* ================================================================== */

  /**
   * Visual only, and it runs even when the player is not flying so that a
   * wreck finishes burning after they walk away from the seat.
   *
   * Runs AFTER `piloting.update` in `main.js`, because the aim marks below are
   * projected through the camera that `Piloting._composeCamera` has just
   * placed. Projecting through last frame's camera puts the reticle a frame
   * behind the nose, which at 1.4 rad/s of roll is visibly detached.
   */
  update(dt) {
    this._drawBolts();
    this._drawFlares(dt);
    this._drawSalvage(dt);
    this._drawAim();
  }

  _drawBolts() {
    const b = this._b;
    const mesh = this._boltMesh;
    for (let i = 0; i < MAX_BOLTS; i++) {
      if (b.active[i] === 0) {
        _mtx.makeScale(0, 0, 0);
        mesh.setMatrixAt(i, _mtx);
        continue;
      }
      _v.set(b.vx[i], b.vy[i], b.vz[i]);
      const sp = _v.length();
      _v.divideScalar(sp || 1);
      _quat.setFromUnitVectors(_FWD_Z, _v);
      /* Length is a fixed streak rather than a step of travel: a bolt drawn
       * `v*dt` long would be 26.7 m at 60 Hz and 13.3 m at 120 Hz, so the guns
       * would visibly change calibre with the frame rate. */
      const long = b.side[i] === 0 ? 15 : 12;
      _scale.set(0.34, 0.34, long);
      /* Drawn CENTRED on the leading point pulled back by half a streak, so
       * the bright tip is where the maths says the bolt is. */
      _v2.set(b.px[i], b.py[i], b.pz[i]).addScaledVector(_v, -long * 0.5);
      _mtx.compose(_v2, _quat, _scale);
      mesh.setMatrixAt(i, _mtx);
      if (b.side[i] === 0) _col.setRGB(0.55, 3.6, 4.2);
      else _col.setRGB(4.0, 0.55, 0.18);
      mesh.setColorAt(i, _col);
    }
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
  }

  _drawFlares(dt) {
    const f = this._f;
    const mesh = this._flareMesh;
    for (let i = 0; i < MAX_FLARES; i++) {
      if (f.active[i] === 0) {
        _mtx.makeScale(0, 0, 0);
        mesh.setMatrixAt(i, _mtx);
        continue;
      }
      f.t[i] -= dt;
      if (f.t[i] <= 0) {
        f.active[i] = 0;
        _mtx.makeScale(0, 0, 0);
        mesh.setMatrixAt(i, _mtx);
        continue;
      }
      f.px[i] += f.vx[i] * dt; f.py[i] += f.vy[i] * dt; f.pz[i] += f.vz[i] * dt;
      const k = f.t[i] / f.dur[i];
      /* Shrinks and dims together. `compose` with a positive scale is exact -
       * nothing here is inverted, which is the rule this world learned when
       * four boxes with a zero tile put NaN through the bloom and blacked out
       * 921,600 pixels. */
      const s = f.size[i] * (0.35 + k * 0.85);
      _v.set(f.px[i], f.py[i], f.pz[i]);
      _quat.identity();
      _scale.set(s, s, s);
      _mtx.compose(_v, _quat, _scale);
      mesh.setMatrixAt(i, _mtx);
      _col.setRGB(f.r[i] * k, f.g[i] * k, f.b[i] * k);
      mesh.setColorAt(i, _col);
    }
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
  }

  _drawSalvage(dt) {
    const mesh = this._salvMesh;
    this._spin = (this._spin ?? 0) + dt * 1.1;
    for (let i = 0; i < MAX_SALVAGE; i++) {
      const s = this._salv[i];
      if (!s.active) { _mtx.makeScale(0, 0, 0); mesh.setMatrixAt(i, _mtx); continue; }
      _quat.setFromAxisAngle(_up.set(0.3, 0.9, 0.2).normalize(), this._spin + i);
      _scale.setScalar(1);
      _mtx.compose(s.pos, _quat, _scale);
      mesh.setMatrixAt(i, _mtx);
    }
    mesh.instanceMatrix.needsUpdate = true;
  }

  /**
   * Where the gun is pointing, and where to point it.
   *
   * Both are published as normalised device coordinates because the HUD is a
   * DOM overlay with no camera and no business having one. The AIM mark is the
   * nose line at the gun's own range; the LEAD mark is the firing solution for
   * the current target - the same one-iteration intercept the hostiles use,
   * run in the player's favour, and it is the single most useful thing on the
   * screen in a fight.
   */
  _drawAim() {
    const cam = this.camera;
    const p = this.piloting;
    if (!cam || !p?.active) { this.aim.on = false; this.lead.on = false; return; }

    const f = p.flight;
    f.forward(_fwd);
    _v.copy(f.position).addScaledVector(_fwd, CONVERGE);
    this._project(_v, this.aim);

    const t = this.target;
    if (!t?.alive) { this.lead.on = false; return; }
    const d = t.position.distanceTo(f.position);
    const tof = d / GUN.speed;
    /* The target's velocity relative to OURS: a bolt inherits nothing, but the
     * shooter is moving, so the lead that matters is the closure. */
    _v2.copy(t.velocity).sub(f.velocity).multiplyScalar(tof).add(t.position);
    this._project(_v2, this.lead);
    this.lead.range = d;
  }

  _project(worldPoint, out) {
    _v3.copy(worldPoint).project(this.camera);
    /* `project` divides by w, and w is negative behind the camera - which
     * flips both axes and puts a marker for something astern in the opposite
     * corner of the screen, confidently. The z test is the only honest way to
     * ask "is this in front of me". */
    out.on = _v3.z < 1 && Math.abs(_v3.x) <= 1.2 && Math.abs(_v3.y) <= 1.2;
    out.x = _v3.x;
    out.y = _v3.y;
  }

  /* ================================================================== */

  dispose() {
    this._offBoard?.();
    this._offWorld?.();
    this._offLeft?.();
    this._offTravel?.();
    for (const h of this.hostiles) h.model.group.parent?.remove(h.model.group);
    this.hostiles.length = 0;
    for (const m of this._models.values()) m.dispose?.();
    this._models.clear();
    this._boltGeo.dispose();
    this._boltMat.dispose();
    this._flareGeo.dispose();
    this._flareMat.dispose();
    this._salvGeo.dispose();
    this._salvMat.dispose();
    this.group.parent?.remove(this.group);
    this.group.clear();
  }
}
