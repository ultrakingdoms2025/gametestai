import * as THREE from 'three';
import { CONFIG } from '../core/Config.js';
import { NPC } from './NPC.js';
import { ROLE, roleDef } from './NPCRoles.js';

/**
 * Civilian / ally.
 *
 * Wanders its waypoints, drifts into small standing groups that face each
 * other, notices the player approaching and greets them, and scatters when
 * shooting starts. Friendlies are the reason a world feels inhabited rather
 * than staged, so most of the work here is about idle behaviour reading as
 * intent rather than as a random walk.
 *
 * The stationary half of the population - the vendors, guards, spectators and
 * loiterers that hold a post - used to be genuinely motionless: they picked a
 * held pose at spawn and never did anything else, which is why a plaza full of
 * them photographed as a rank of shop dummies. They now run an *idle life*
 * loop instead (`_postIdle`): short strolls off the post and back, turns to
 * look at whatever is nearby, conversation turns with a neighbour, and a
 * re-pick of the held pose in between. Seated characters run the same loop with
 * the walking taken out and the upper body left in.
 *
 * Every friendly - post-holder, sitter and wanderer alike - is a chat target.
 * That is deliberate and is the whole point of the role system: there is no
 * such thing here as a person-shaped prop.
 */

const _v1 = new THREE.Vector3();
const _v2 = new THREE.Vector3();
/** `_pickStrollTarget` owns this exclusively. */
const _p2 = new THREE.Vector3();

/** Held poses a civilian can fall into while standing around. */
const POSTURE_POOL = ['none', 'crossed', 'hips', 'pocket', 'none', 'lean', 'crossed', 'pocket'];
/** Held poses for a seated character. Both keep the head and hands live. */
const SEATED_POSTURES = ['sit', 'sitLean', 'sit'];

export class FriendlyNPC extends NPC {
  constructor(ctx) {
    super({ ...ctx, type: 'friendly' });

    this.idleTimer = 1 + this.rnd() * 4;
    this.socialPartner = null;
    this.socialTimer = 0;
    this.socialCheck = this.rnd() * 2;
    this.greetCooldown = 0;
    this.hasGreeted = false;
    this.waveTimer = 0;
    this.alarm = 0;
    this.fleeTimer = 0;
    this.cowering = false;

    this.homeRadius = 12 + this.rnd() * 10;

    /**
     * Held idle pose. Worlds hand these out through the spawn spec so a plaza
     * reads as a crowd of individuals rather than a rank of identical statues.
     */
    this.posture = ctx.posture ?? POSTURE_POOL[(this.rnd() * POSTURE_POOL.length) | 0];
    this.postureTimer = 4 + this.rnd() * 9;
    /** Anchored NPCs hold a spot in a social group instead of wandering off. */
    this.anchored = !!ctx.anchored;
    this.groupFocus = ctx.groupFocus ? ctx.groupFocus.clone() : null;
    this.gestureTimer = this.rnd() * 6;
    this.gesturing = false;

    /* --- role and idle life ------------------------------------------ */
    this.role = ctx.role ?? (this.anchored ? ROLE.LOITERER : ROLE.WANDERER);
    this.roleDef = roleDef(this.role);
    this.isVendor = this.role === ROLE.VENDOR;
    this.roleLabel = this.roleDef.label;
    /** Post-holders keep station; wanderers roam their waypoints. */
    this.stationary = this.roleDef.stationary || this.anchored;
    /** The bearing they face when nothing more interesting is happening. */
    this.postYaw = this.yaw;
    this.seated = false;

    /*
     * Per-instance look and aim points.
     *
     * These used to be module scratch, which meant every civilian's
     * `_lookTarget` pointed at the same vector: the last one to run `_think`
     * decided what all twenty-four of them were looking at when the animator
     * read it a phase later. It was invisible while everyone happened to be
     * looking at the player, and would have been very visible now that they
     * look at each other.
     */
    this._lookPos = new THREE.Vector3();
    this._aimPos = new THREE.Vector3();

    // Staggered so twenty civilians in one square never act on the same frame.
    this.lifeTimer = 1.5 + this.rnd() * 5;
    this.lifeAction = 'hold';
    this.strollHome = false;
    /** Latched "walk back to my post", with hysteresis - see `_postIdle`. */
    this.returningToPost = false;
    this.talkPartner = null;
    this.talkTimer = 0;

    this.setState('IDLE');
    /* No route is issued here. It used to be - `setPath(this.patrol)` from
     * waypoint 0 - which had a character walking a round while its state
     * machine said IDLE, and was replaced a second or two later by the first
     * `_pickWanderTarget` anyway. A round starts when the character decides to
     * set off, which is `_idle`'s job. */
  }

  /** Human-readable role, used by the interaction prompt. */
  get roleName() {
    return this.roleLabel;
  }

  /** Sit down / stand up, keeping the idle loop consistent with the pose. */
  setSeated(on, seatHeight) {
    super.setSeated(on, seatHeight);
    if (on) {
      this.nav.clear();
      this.stationary = true;
      this.posture = SEATED_POSTURES[(this.rnd() * SEATED_POSTURES.length) | 0];
      this.postureTimer = 5 + this.rnd() * 8;
    } else if (this.posture === 'sit' || this.posture === 'sitLean') {
      this.posture = POSTURE_POOL[(this.rnd() * POSTURE_POOL.length) | 0];
    }
  }

  /** A character who is running for their life does not stay sat down. */
  onStateEnter(next) {
    if (next === 'FLEE' && this.seated) this.setSeated(false);
  }

  get player() {
    return this.manager?.player ?? null;
  }

  /** Loud noise nearby: drop everything and get away from it. */
  onGunfire(origin, intensity = 1) {
    // Lorekeepers are sacred — they never flee, no matter what.
    if (this.isDead || this.isLorekeeper) return;
    const d = origin ? this.position.distanceTo(origin) : 0;
    if (d > 45) return;
    this.alarm = Math.min(1, this.alarm + intensity * (1 - d / 45));
    if (this.alarm > 0.35 && this.state !== 'FLEE') {
      this.fleeOrigin = origin ? origin.clone() : null;
      this.fleeTimer = 4 + this.rnd() * 4;
      this.setState('FLEE');
    }
  }

  onDamaged() {
    // Lorekeepers are sacred — they ignore damage and stay at their post.
    if (this.isLorekeeper) return;
    this.alarm = 1;
    this.fleeOrigin = this.lastDamageSource?.position?.clone?.() ?? null;
    this.fleeTimer = 6 + this.rnd() * 4;
    this.setState('FLEE');
  }

  _think(dt) {
    this.alarm = Math.max(0, this.alarm - dt * 0.14);
    this.greetCooldown = Math.max(0, this.greetCooldown - dt);
    if (this.waveTimer > 0) this.waveTimer -= dt;
    this._updatePosture(dt);

    const player = this.player;
    const dist = player ? this.position.distanceTo(player.position) : Infinity;
    this.playerDistance = dist;

    /* FLEE is dispatched BEFORE the minigame lock below, and deliberately:
     * `onGunfire` and `onDamaged` set state to FLEE from their event handlers,
     * and fear has to outrank a borrowed match - a locked tennis opponent
     * still scatters from gunfire, cowers when cornered, and only stands down
     * again once her own flee recovery has run. */
    if (this.state === 'FLEE') {
      this._flee(dt);
      return;
    }

    /* A minigame has borrowed this character and drives nav/face/look itself
     * (see minigames/TennisMatch.js). The body keeps walking - _steer and
     * _integrate still run in NPC.fixedUpdate - but the brain stands down. */
    if (this._minigameLock) return;

    switch (this.state) {
      case 'GREET':
        this._greet(dt, player, dist);
        return;
      case 'SOCIAL':
        this._social(dt, dist);
        return;
      case 'WANDER':
        this._wander(dt, dist);
        return;
      case 'STROLL':
        this._stroll(dt, dist);
        return;
      default:
        this._idle(dt, dist);
    }
  }

  /* ---------------------------------------------------------------- */

  /**
   * Cycle the held pose and the conversational hand movement.
   *
   * Both are purely cosmetic and both are cheap: a posture change is one
   * assignment, and the animator blends the rest.
   */
  _updatePosture(dt) {
    // A seated character never loses its pose: the legs are solved by the seat
    // solver and the held pose is the only thing keeping the arms on the knees.
    if (this.seated) {
      this.postureTimer -= dt;
      if (this.postureTimer <= 0) {
        this.postureTimer = 8 + this.rnd() * 12;
        this.posture = SEATED_POSTURES[(this.rnd() * SEATED_POSTURES.length) | 0];
      }
      this.animator.setPosture(this.posture);
      this._updateGesture(dt, this.talkTimer > 0 || this.state === 'GREET');
      return;
    }

    const standing = this.state === 'IDLE' || this.state === 'SOCIAL' || this.state === 'GREET';
    if (!standing || this.moveSpeed > 0.35) {
      this.animator.setPosture('none');
      this.animator.setGesturing(false);
      return;
    }

    this.postureTimer -= dt;
    if (this.postureTimer <= 0) {
      this.postureTimer = 7 + this.rnd() * 12;
      // Re-pick from the poses that suit the role. A vendor plants their hands
      // and a loiterer slouches; both change often enough that a long look at a
      // crowd never freezes, which is what made them read as props before.
      const pool = this.roleDef?.postures ?? POSTURE_POOL;
      this.posture = pool[(this.rnd() * pool.length) | 0];
    }
    this.animator.setPosture(this.state === 'GREET' ? 'none' : this.posture);

    // Talking hands, but only when there is somebody to talk to.
    const talking =
      (this.state === 'SOCIAL' && this.nav.arrived !== false) || this.talkTimer > 0;
    this._updateGesture(dt, talking);
  }

  /** Conversational hand movement, gated on actually having an audience. */
  _updateGesture(dt, talking) {
    this.gestureTimer -= dt;
    if (this.gestureTimer <= 0) {
      this.gesturing = talking && this.rnd() < 0.6;
      this.gestureTimer = this.gesturing ? 1.5 + this.rnd() * 2.5 : 2 + this.rnd() * 4;
    }
    this.animator.setGesturing(this.gesturing && talking);
  }

  _noticePlayer(dist) {
    const player = this.player;
    if (!player || player.isDead) return false;
    // Turn toward the player well before chat range, greet inside it.
    if (dist < CONFIG.npc.chatRange * 2.4) {
      this._lookTarget = this._lookPos
        .copy(player.position)
        .setY(player.position.y + CONFIG.player.eyeHeight);
      if (dist < CONFIG.npc.chatRange * 1.25 && this.greetCooldown <= 0) {
        this.setState('GREET');
        return true;
      }
    }
    return false;
  }

  _idle(dt, dist) {
    this.desiredSpeed = CONFIG.npc.walkSpeed;
    // Members of a standing group keep facing the middle of it; everyone else
    // faces wherever they last walked.
    this.faceOverride = this.anchored ? this.groupFocus : null;
    this._lookTarget = null;
    this.animator.setAimTarget(null);
    if (this._noticePlayer(dist)) return;

    if (this.stationary) {
      this._postIdle(dt);
      return;
    }

    this.socialCheck -= dt;
    if (this.socialCheck <= 0) {
      this.socialCheck = 1.5 + this.rnd() * 2;
      const partner = this.manager?.findSocialPartner?.(this, 9);
      if (partner) {
        this.socialPartner = partner;
        this.socialTimer = 8 + this.rnd() * 10;
        this.setState('SOCIAL');
        return;
      }
    }

    this.idleTimer -= dt;
    if (this.idleTimer <= 0) {
      this.idleTimer = 3 + this.rnd() * 6;
      this.setState('WANDER');
      this._pickWanderTarget();
    }
  }

  /**
   * Idle life for a character who holds a post.
   *
   * Runs a short cycle of small, cheap actions: shift the held pose, turn to
   * look at something, take a few steps off the post and come back, or trade a
   * conversation turn with whoever is standing next to them. None of it costs
   * more than one navigation target and a timer, and between them they are the
   * difference between "twelve people in a square" and "twelve statues".
   *
   * Seated characters run the same cycle with the stroll removed - they still
   * look around, still gesture, still take conversation turns.
   */
  _postIdle(dt) {
    // Shoved out of position (by the player, by a stampede): walk back first.
    //
    // Latched, with a wide band between "I have been pushed off my post" and
    // "I am back on it". A bare `distance > 1.7` test re-issued the same target
    // on every fixed step, which cleared `nav.arrived` every step so the
    // character could never settle, and it re-engaged the moment anything
    // nudged it back over the line - a post-holder standing in a crowd would
    // shuffle in and out forever.
    if (!this.seated) {
      const off = this.position.distanceToSquared(this.spawnPoint);
      if (!this.returningToPost && off > 1.7 * 1.7) this.returningToPost = true;
      else if (this.returningToPost && off < 0.7 * 0.7) this.returningToPost = false;
      if (this.returningToPost) {
        // Only actually re-targets when the destination has moved.
        this.nav.setTargetIfNew(this.spawnPoint);
        return;
      }
    }

    if (this.talkTimer > 0) {
      this.talkTimer -= dt;
      const partner = this.talkPartner;
      if (partner && !partner.isDead) {
        this.faceOverride = this.seated ? null : partner.position;
        this._lookTarget = this._lookPos
          .copy(partner.position)
          .setY(partner.position.y + partner.height * 0.88);
      } else {
        this.talkTimer = 0;
      }
      if (this.talkTimer <= 0) this.talkPartner = null;
      return;
    }

    // Between actions the character holds their bearing and their pose, which
    // is what the weight shift and breathing in the animator play against.
    this.lifeTimer -= dt;
    if (this.lifeTimer > 0) {
      if (this.lifeAction === 'look' && this._lookPoint) {
        this._lookTarget = this._lookPos.copy(this._lookPoint);
      }
      return;
    }

    this.nav.clear();
    this.lifeTimer = 3.5 + this.rnd() * 6;
    const roll = this.rnd();
    const def = this.roleDef;

    // 1. Trade a word with a neighbour.
    const neighbour = this._nearestNeighbour(3.6);
    if (neighbour && roll < 0.3) {
      this.lifeAction = 'talk';
      this.talkPartner = neighbour;
      this.talkTimer = 3 + this.rnd() * 5;
      neighbour.receiveConversation?.(this, this.talkTimer * 0.85);
      return;
    }

    // 2. Take a few steps and come back. Seated characters and lorekeepers skip this.
    if (!this.seated && !this.isLorekeeper && roll < 0.3 + def.strollChance * 0.45) {
      if (this._pickStrollTarget(def.strollRadius)) {
        this.lifeAction = 'stroll';
        this.strollHome = true;
        this.setState('STROLL');
        return;
      }
    }

    // 3. Turn and look at something: a neighbour, or a bearing off the post.
    if (roll < 0.72 || this.rnd() < def.lookAround) {
      this.lifeAction = 'look';
      const a = this.postYaw + (this.rnd() - 0.5) * 2.4;
      const r = 6 + this.rnd() * 10;
      this._lookPoint = (this._lookPoint ?? new THREE.Vector3()).set(
        (neighbour ? neighbour.position.x : this.position.x - Math.sin(a) * r),
        (neighbour ? neighbour.position.y + neighbour.height * 0.88 : this.position.y + 1.55),
        (neighbour ? neighbour.position.z : this.position.z - Math.cos(a) * r)
      );
      this.lifeTimer = 2 + this.rnd() * 3.5;
      return;
    }

    // 4. Otherwise just shift weight and re-pick the held pose.
    this.lifeAction = 'hold';
    this._lookPoint = null;
    this.postureTimer = 0;
  }

  /**
   * A neighbour started talking to us: face them back for a while, so a
   * conversation reads as two people rather than one person lecturing a statue.
   *
   * @param {FriendlyNPC} from
   * @param {number} seconds
   */
  receiveConversation(from, seconds) {
    if (this.isDead || this.state === 'FLEE' || this.state === 'GREET') return;
    this.talkPartner = from;
    this.talkTimer = Math.max(this.talkTimer, seconds);
    this.lifeTimer = Math.max(this.lifeTimer, seconds);
  }

  /** Nearest other friendly within `radius`, for looks and conversation turns. */
  _nearestNeighbour(radius) {
    const list = this.manager?.friendlies;
    if (!list) return null;
    let best = null;
    let bestSq = radius * radius;
    for (const other of list) {
      if (other === this || other.isDead) continue;
      const d = other.position.distanceToSquared(this.position);
      if (d < bestSq && d > 0.4) {
        bestSq = d;
        best = other;
      }
    }
    return best;
  }

  /**
   * A destination a few steps off the post, on ground we can actually reach.
   * @param {number} radius
   */
  _pickStrollTarget(radius) {
    for (let i = 0; i < 5; i++) {
      const a = this.rnd() * Math.PI * 2;
      const r = radius * (0.45 + this.rnd() * 0.55);
      const x = this.spawnPoint.x + Math.cos(a) * r;
      const z = this.spawnPoint.z + Math.sin(a) * r;
      const g = this.physics.groundHeight(x, z, this.spawnPoint.y + 2.2, 5);
      if (g === null || Math.abs(g - this.spawnPoint.y) > 1.0) continue;
      _p2.set(x, g, z);
      if (!this.nav._clearLine(this.position, _p2)) continue;
      this.nav.setTarget(_p2);
      return true;
    }
    return false;
  }

  /**
   * Walk the short stroll out and back. Deliberately slower than a wander: a
   * vendor stepping round their stall does not march.
   */
  _stroll(dt, dist) {
    this.desiredSpeed = CONFIG.npc.walkSpeed * 0.68;
    this.faceOverride = null;
    this._lookTarget = null;
    if (this._noticePlayer(dist)) return;

    if (this.nav.isStuck) {
      this.nav.acknowledgeStuck();
      this.strollHome = false;
      this.nav.setTarget(this.spawnPoint);
    }
    if (!this.nav.active) {
      if (this.strollHome) {
        this.strollHome = false;
        this.nav.setTarget(this.spawnPoint);
        return;
      }
      // Home again: settle facing roughly the way the post faces.
      this.targetYaw = this.postYaw + (this.rnd() - 0.5) * 0.7;
      this.lifeTimer = 4 + this.rnd() * 7;
      this.lifeAction = 'hold';
      this.postureTimer = 0;
      this.setState('IDLE');
    }
    void dt;
  }

  _wander(dt, dist) {
    this.desiredSpeed = CONFIG.npc.walkSpeed;
    this.faceOverride = null;
    if (this._noticePlayer(dist)) return;
    this._lookTarget = null;

    if (this.nav.isStuck) {
      this.nav.acknowledgeStuck();
      this._pickWanderTarget();
    }
    if (!this.nav.active) {
      this.idleTimer = 2.5 + this.rnd() * 6;
      this.setState('IDLE');
    }
    void dt;
  }

  _social(dt, dist) {
    this.desiredSpeed = CONFIG.npc.walkSpeed * 0.9;
    const partner = this.socialPartner;
    if (!partner || partner.isDead || partner.state === 'FLEE') {
      this.socialPartner = null;
      this.setState('IDLE');
      return;
    }
    if (this._noticePlayer(dist)) return;

    // Stand a conversational distance apart and turn to face each other.
    _v1.subVectors(this.position, partner.position);
    _v1.y = 0;
    const gap = _v1.length();
    if (gap > 1.9) {
      _v1.multiplyScalar(1 / Math.max(gap, 1e-4));
      _v2.copy(partner.position).addScaledVector(_v1, 1.5);
      // Follows the partner, but only re-issues when they have actually moved,
      // so a stationary pair stops rather than creeping at each other forever.
      this.nav.setTargetIfNew(_v2, 0.35);
      this.faceOverride = null;
    } else {
      this.nav.clear();
      this.faceOverride = partner.position;
    }
    this._lookTarget = this._lookPos
      .copy(partner.position)
      .setY(partner.position.y + partner.height * 0.9);

    this.socialTimer -= dt;
    if (this.socialTimer <= 0) {
      this.socialPartner = null;
      this.socialCheck = 6 + this.rnd() * 8;
      this.setState('IDLE');
    }
  }

  _greet(dt, player, dist) {
    this.desiredSpeed = CONFIG.npc.walkSpeed * 0.7;
    this.nav.clear();
    this.socialPartner = null;
    if (!player || dist > CONFIG.npc.chatRange * 2.8) {
      this.hasGreeted = false;
      this.greetCooldown = 4;
      this.setState('IDLE');
      return;
    }
    this.faceOverride = player.position;
    this._lookTarget = this._lookPos
      .copy(player.position)
      .setY(player.position.y + CONFIG.player.eyeHeight);
    if (!this.hasGreeted && this.stateTime > 0.35) {
      this.hasGreeted = true;
      this.waveTimer = 1.35;
    }
    // A wave is an aim-layer pose: the arm reaches up toward the player's head.
    if (this.waveTimer > 0) {
      this._aimPos.copy(player.position);
      this._aimPos.y += CONFIG.player.eyeHeight + 0.35;
      this.animator.setAimTarget(this._aimPos);
      this.animator.setAiming(true);
    } else {
      this.animator.setAimTarget(null);
    }
    void dt;
  }

  _flee(dt) {
    this.desiredSpeed = CONFIG.npc.runSpeed;
    this.faceOverride = null;
    this.animator.setAimTarget(null);
    this.fleeTimer -= dt;

    if (this.cowering) {
      this.nav.clear();
      this.animator.crouchTarget = 1;
      this._lookTarget = null;
      if (this.fleeTimer <= 0) {
        this.cowering = false;
        this.animator.crouchTarget = 0;
        this.setState('IDLE');
      }
      return;
    }

    if (!this.nav.active || this.nav.isStuck) {
      const stuck = this.nav.isStuck;
      this.nav.acknowledgeStuck();
      if (stuck && this.rnd() < 0.45) {
        // Cornered: crouch and cover up instead of running into a wall.
        this.cowering = true;
        this.fleeTimer = 3 + this.rnd() * 3;
        return;
      }
      const away = this.fleeOrigin ?? this.position;
      _v1.subVectors(this.position, away);
      _v1.y = 0;
      if (_v1.lengthSq() < 0.1) _v1.set(this.rnd() - 0.5, 0, this.rnd() - 0.5);
      _v1.normalize();
      let found = false;
      for (let i = 0; i < 6 && !found; i++) {
        const spin = (this.rnd() - 0.5) * 1.6;
        const c = Math.cos(spin);
        const s = Math.sin(spin);
        _v2.set(_v1.x * c - _v1.z * s, 0, _v1.x * s + _v1.z * c);
        const range = 9 + this.rnd() * 9;
        const x = this.position.x + _v2.x * range;
        const z = this.position.z + _v2.z * range;
        const g = this.physics.groundHeight(x, z, this.position.y + 6, 16);
        if (g === null) continue;
        _v2.set(x, g, z);
        if (!this.nav._clearLine(this.position, _v2)) continue;
        this.nav.setTarget(_v2);
        found = true;
      }
      if (!found) this.cowering = true;
    }
    if (this.fleeTimer <= 0 && this.alarm < 0.2) {
      this.setState('IDLE');
    }
  }

  /**
   * Where to walk next: a stretch of the character's own round, or, failing
   * that, somewhere within reach of home.
   *
   * ── What this used to do ─────────────────────────────────────────────────
   * It picked ONE waypoint, "one or two ahead at random", and steered straight
   * at it. That is not route following and it produced two separate failures.
   * A skipped waypoint means the line walked is between two points the author
   * never joined - across the inside of an elbow, off a walkway, through a
   * building. And the modular wrap at the end of an open route means the line
   * from the far end back to the start, which is every leg of the round at
   * once. The station's two promenade rounds were authored as single-bearing
   * corridors, every point inside one 5.4 m railing opening, purely so that no
   * pair of their waypoints could produce a bad line.
   *
   * Now it hands `Navigation` a stretch of the round in order and lets the
   * route follower walk it. Two to four legs, because a wanderer that walked
   * the whole round in one go would never take a social turn, never notice a
   * neighbour and never stop - the pauses between stretches are what makes it
   * read as a person on a round rather than a tram.
   */
  _pickWanderTarget() {
    /* A round, once started, is finished.
     *
     * The free-roam pick below chooses a spot within `homeRadius` of the SPAWN
     * point, so rolling it while a character is part-way round is not variety -
     * it is a decision to walk home from wherever it has got to. Measured on
     * the station: Ceri Bardo climbed 5.9 m of the bearing-30 flight, rolled
     * the 35%, and walked back down to the hub deck. She never once completed a
     * circuit of the loop. So the roll only happens where free roam makes sense
     * - back at the head of the round, which is also where `homeRadius` is
     * centred - and anywhere else the character carries on.
     *
     * This is the same nearest-waypoint scan `routeAhead` does, and it is why
     * that scan is a method rather than a loop inside it. */
    const atRoundHead = this.nearestRouteIndex() <= 0;
    if (this.patrol.length > 1 && (!atRoundHead || this.rnd() < 0.65)) {
      const legs = this.routeAhead(2 + ((this.rnd() * 3) | 0));
      /* Authored routes predate the water volumes and a couple of them ford the
       * river. Drop the wet legs; `setPath` does the same for the waypoints
       * themselves. If nothing survives, fall through to a free-roam pick
       * rather than march in. */
      // An authored waypoint carries the height its author meant, so a leg that
      // crosses a bridge is probed on the DECK rather than under it - see
      // `Grounding.waterDepthAt`. Without that the vale's own routes lost every
      // leg that used a crossing and fell through to a free-roam pick.
      const dry = legs.filter((wp) => !this.nav.isDeepWaterAt(wp.x, wp.z, wp.y));
      if (dry.length && this.nav.waterFreeLine(this.position, dry[0])) {
        /* Resolve each waypoint onto the ground the way the old single-target
         * path did. An authored waypoint carries the height its author meant -
         * the promenade round's are at 10 - and the probe window is taken from
         * the waypoint rather than from the character, so a route that climbs
         * still resolves.
         *
         * Fresh vectors, not module scratch: `setPath` clones the array it is
         * given, but it clones it AFTER `map` has built it, so handing it the
         * same reused vector four times would hand it four copies of the last
         * waypoint. Two to four allocations when a character decides to set off
         * is not a cost worth being clever about. */
        this.nav.setPath(dry.map((wp) => {
          const g = this.physics.groundHeight(wp.x, wp.z, wp.y + 6, 14);
          return new THREE.Vector3(wp.x, g ?? wp.y, wp.z);
        }));
        return;
      }
    }
    for (let i = 0; i < 6; i++) {
      const a = this.rnd() * Math.PI * 2;
      const r = this.homeRadius * (0.3 + this.rnd() * 0.7);
      const x = this.spawnPoint.x + Math.cos(a) * r;
      const z = this.spawnPoint.z + Math.sin(a) * r;
      // Never stroll into the river. Steering would eventually deflect the
      // agent off the bank, but only after it had spent seconds leaning into
      // the water - rejecting the destination is what stops it looking like a
      // decision to go for a swim.
      if (this.nav.isDeepWaterAt(x, z)) continue;
      const g = this.physics.groundHeight(x, z, this.spawnPoint.y + 8, 18);
      if (g === null) continue;
      _v1.set(x, g, z);
      if (!this.nav._clearLine(this.position, _v1)) continue;
      // ...and the route there has to be walkable too, or a dry spot on the far
      // bank sends them straight through the river to reach it.
      if (!this.nav.waterFreeLine(this.position, _v1)) continue;
      this.nav.setTarget(_v1);
      return;
    }
    this.setState('IDLE');
  }
}
