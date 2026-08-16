import * as THREE from 'three';
import { CONFIG } from '../core/Config.js';
import { COLLISION_LAYER } from '../physics/Physics.js';
import { NPC, clamp } from './NPC.js';
import { BeastAnimator } from './BeastAnimator.js';
import { beastDef, rollBeastDamage, threatRadius } from './BeastSpecies.js';
import { strikeHits, STRIKE_ARC, STRIKE_DROP } from './BeastMaul.js';

/**
 * A roaming predator: wolf or bear.
 *
 * ── Where this sits in the stack ──────────────────────────────────────────
 * It is an ordinary {@link NPC}. That is the entire integration strategy and it
 * is worth being explicit about why: everything the brief asks for downstream -
 * being shootable, dropping loot, counting for a quest, honouring the sim-rate
 * LOD band, being pulled out of the river, being pushed off a neighbour - is
 * already implemented once, for anything that lives in `NPCManager._npcs`.
 * Re-implementing any of it for beasts would be re-implementing it wrong.
 *
 * Two things about a beast are genuinely not humanoid, and both are handled by
 * an overridable hook on the base class rather than by a fork:
 *
 *   - the BODY, which `NPCManager` builds and passes in as `ctx.humanoid`;
 *   - the ANIMATOR, which `NPC` used to hard-construct and now asks
 *     `_createAnimator` for.
 *
 * Nothing else in `NPC` needed to change.
 *
 * ── The behaviour ─────────────────────────────────────────────────────────
 *
 *   ROAM ──notices──► STALK ──in reach──► ATTACK ──► (recover) ──► STALK
 *     ▲                 │                                            │
 *     └── loses interest ┴──────────── hurt and afraid ──► FLEE ──────┘
 *
 * STALK is where the two species differ most. A bear walks straight at you: it
 * has no reason to do anything else and its whole threat is that it does not
 * stop. A wolf holds a BEARING handed to it by its pack (see `BeastPack`) and
 * orbits, closing only when the pack gives it an attack slot - so a player
 * fighting four wolves is turning on the spot, which is the point.
 *
 * ATTACK is a three-part committed sequence, and the commitment is the fairness
 * knob: telegraph (visible, the beast is slow and cannot change its mind),
 * strike (the contact volume is live for a fraction of a second), recover (it
 * is open). A player who reads the wind-up and moves takes nothing, because the
 * strike is a real swept volume - see `BeastMaul`.
 */

const _v1 = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _v3 = new THREE.Vector3();
const _origin = new THREE.Vector3();
const _eye = new THREE.Vector3();

/** Sense on a timer; a predator does not need 60 Hz eyesight. */
const SENSE_INTERVAL = 0.18;
/** Seconds a beast keeps hunting a target it can no longer see. */
const MEMORY = 6;
/** Seconds a beast stops looking for anything after making a kill. */
const SATIATED_TIME = 55;

export class BeastNPC extends NPC {
  /**
   * @param {{species:string, home?:THREE.Vector3, pack?:import('./BeastPack.js').BeastPack}} ctx
   *   plus everything {@link NPC} takes.
   */
  constructor(ctx) {
    const def = beastDef(ctx.species);
    super({
      ...ctx,
      /**
       * A beast is a HOSTILE, and that is a deliberate choice rather than a
       * shortcut. `type` is what the rest of the game keys off: `QuestSystem`
       * only counts a kill when `npc.type === 'hostile'`, `NPC` derives
       * `conversational` from it, and `NPCManager._updateRespawns` walks the
       * hostile roster. Inventing a third type would have meant editing every
       * one of those to say "or a beast", for no gain - a wolf that eats
       * travellers is hostile by any definition the game already uses. What
       * makes it a beast is `isBeast` and `species`, which is what the code
       * that genuinely cares reads.
       */
      type: 'hostile',
      // The capsule is the animal's chest, not a person's: a bear that walks
      // around inside a 0.33 m cylinder has its shoulders in the walls.
      radius: def.bodyRadius,
    });

    /** @type {import('./BeastSpecies.js').BeastDef} */
    this.def = def;
    this.species = def.id;
    this.body = ctx.humanoid;
    this.isBeast = true;

    this.maxHealth = def.health;
    this.health = def.health;

    this.role = 'beast';
    this.isVendor = false;
    this.conversational = false;

    /**
     * The cheap rejection sphere `NPCManager.raycastNPCs` uses is sized off
     * `height`, which is right for something taller than it is long and wrong
     * for something the other way round - a wolf's nose is a metre in front of
     * a sphere that only reaches 0.64 m. Publishing the real bound is what
     * makes a beast shootable along its length.
     */
    this.boundRadius = (ctx.humanoid?.bodyLength ?? def.bodyLength) * 0.55 + def.bodyRadius;
    /** The separation constraint's minimum gap for this body. @see NPCManager */
    this.personalSpace = def.bodyRadius * 1.9;
    /** Footprint for the shared contact-shadow decal. @see NPCManager */
    this.contactRadius = (ctx.humanoid?.bodyLength ?? def.bodyLength) * 0.62;

    /* Steering, sized for the animal rather than for a person. */
    this.nav.radius = def.bodyRadius;
    this.nav.probeRange = 2.2 + def.bodyRadius * 2.6;
    this.nav.separationRange = def.bodyRadius * 2.6;
    this.nav.arriveRadius = 0.7;

    /** Territory centre. Defaults to where it was placed. */
    this.home = (ctx.home ?? ctx.position).clone();
    /**
     * How far from `home` this animal will hunt. @see BeastSpecies.threatRadius
     *
     * Held on the instance rather than recomputed, because it is read on every
     * acquisition test and because a world that hands a beast a custom
     * territory should get a leash that follows it.
     */
    this.leash = threatRadius(def);
    /** @type {import('./BeastPack.js').BeastPack|null} */
    this.pack = ctx.pack ?? null;
    this.packSlot = 0;

    /* ---- perception ---- */
    this.target = null;
    this.targetDistance = Infinity;
    this.losClear = false;
    this.lastKnown = new THREE.Vector3();
    this.hasLastKnown = false;
    this.memory = 0;
    this._senseTimer = this.rnd() * SENSE_INTERVAL;
    this.fovCos = Math.cos((def.fovDegrees * Math.PI) / 360);

    /* ---- attack ---- */
    this.attackTimer = 0;
    this.attackPhase = 'none';
    this._atkT = 0;
    this._atkHit = false;
    this.lastAttackDamage = 0;

    /* ---- roaming ---- */
    this.roamPause = 0;
    this.fleeTimer = 0;
    /**
     * Seconds left of "I have eaten", during which nothing new is hunted.
     *
     * Beasts hunt travellers as well as the player, which is what the brief
     * asked for and is also a slow way to depopulate a village. WHICH
     * civilians, exactly, is worth being precise about, because the obvious
     * claim - "friendlies are not in the respawn queue, so every one a pack
     * works through is gone for the session" - is FALSE for most of them and
     * was believed here for a while.
     *
     * `MedievalResidency` despawns a streamed civilian at 220 m and re-spawns
     * its SPEC on the way back in, and it does not look at `isDead` on either
     * leg. So a round trip past 220 m restores 96 of the vale's 108 - the 88
     * planned residents and the 8 travellers - as new bodies. What genuinely
     * does not come back is everything the manager placed rather than streamed:
     * the twelve authored friendlies (Bram Tallow, Wilda Sorrel, Captain Osric
     * Vane, Piety Lark, Nell Harrow, Corvin Ash, Goodman Alder, Tibb Marrow,
     * Rook Danby, Serjeant Hale, Watchman Pell, Sister Meriet), the quest
     * manager `_spawnQuestManagers` plants (Edmund Marsh, at (10, -9), 7.2 m
     * from the player's spawn pin, anchored and weaponless - and `HUD` gates
     * the quest board on `isQuestManager`, so he takes it with him), the portal
     * lorekeeper, and the hub crowd. `NPCManager._updateRespawns` walks
     * `_hostiles` only, so nothing else will bring any of them back.
     *
     * Those are also exactly the ones the placement cordon and the home leash
     * are sized to keep a pack away from - see `BeastSpecies.threatRadius`. A
     * predator that has just made a kill and then immediately picks the next
     * nearest body is not behaving like a predator anyway. This bounds the
     * damage to roughly one kill a minute per animal without adding a system to
     * do it.
     *
     * It gates ACQUISITION only. Something that attacks a satiated beast still
     * gets its attention through `onDamaged`, so the player can always pick a
     * fight with one.
     */
    this.satiated = 0;

    this.setState('ROAM');
  }

  /**
   * THE SEAM.
   *
   * `NPC` used to build an `NPCAnimator` inline. It now asks for one here, and
   * this is the whole of what a non-humanoid character has to override to live
   * in the crowd - the alternative was a parallel copy of `NPC`, which would
   * have had to be kept in step with the grounding watchdog, the walked-height
   * memory, the banked-`dt` LOD contract and the capsule integrator forever.
   *
   * Called from the base constructor, so it may only touch what the base has
   * already assigned: `humanoid`, `physics`, `seed`, `bus`.
   */
  _createAnimator(ctx) {
    return new BeastAnimator({
      body: ctx.humanoid,
      species: beastDef(ctx.species).id,
      seed: this.seed,
      bus: this.bus,
      owner: this,
    });
  }

  /**
   * The volume the player's bullets have to hit.
   *
   * `NPCManager.raycastNPCs` builds a VERTICAL capsule from a character's feet
   * to its head, which is the right shape for a person and completely the wrong
   * one for a wolf - worked through for a 0.85 m animal it comes out as a
   * 0.36 m sphere sitting under the ribs, so most of a wolf could not be shot
   * at all. A quadruped's body is a HORIZONTAL capsule along its spine, so the
   * manager asks for one when a character offers it.
   *
   * @param {THREE.Vector3} a written with the rear cap centre
   * @param {THREE.Vector3} b written with the front cap centre
   * @returns {number} the capsule radius
   */
  hitCapsule(a, b) {
    // Read the facing off the yaw rather than through `this.forward`, which
    // hands back shared module scratch that `a`/`b` would then race with.
    const fx = -Math.sin(this.yaw);
    const fz = -Math.cos(this.yaw);
    const half = this.def.bodyLength * 0.32;
    const p = this.position;
    const y = p.y + this.def.shoulderHeight * 0.62;
    a.set(p.x - fx * half, y, p.z - fz * half);
    b.set(p.x + fx * half, y, p.z + fz * half);
    return this.def.bodyRadius * 0.72;
  }

  /* ---------------------------------------------------------------- */
  /* Perception                                                        */
  /* ---------------------------------------------------------------- */

  /** Everything a beast is willing to hunt: the player and the civilians. */
  _candidates() {
    const out = [];
    const player = this.manager?.player;
    if (player && !player.isDead) out.push(player);
    const friendlies = this.manager?.friendlies;
    if (friendlies) {
      for (const npc of friendlies) if (!npc.isDead) out.push(npc);
    }
    return out;
  }

  /** True when `t` is the player rather than an NPC. */
  isPlayerTarget(t) {
    return !!t && t === this.manager?.player;
  }

  /**
   * Is `t` outside this animal's country?
   *
   * THE HOME LEASH, in one place. Horizontal distance only: a target standing
   * on a bridge deck is four metres up and no further away for it, and the
   * cordon this bound is paired with is drawn in plan.
   *
   * Written against the TARGET rather than against the beast on purpose. It
   * makes the rule self-limiting - a beast only ever steers at something inside
   * the disc, and a disc is convex, so it cannot walk itself out - and it
   * gives the boundary hysteresis for free: crossing it drops the hunt, and
   * stepping back inside starts it again, with no flicker at the line.
   *
   * @param {any} t
   * @returns {boolean}
   */
  beyondLeash(t) {
    const p = t?.position;
    if (!p) return false;
    const dx = p.x - this.home.x;
    const dz = p.z - this.home.z;
    return dx * dx + dz * dz > this.leash * this.leash;
  }

  /**
   * Capsule for whatever is being mauled.
   *
   * The player and an NPC report their dimensions differently - the player's
   * live in CONFIG, an NPC carries its own - and the maul has to be able to
   * miss both for the same reasons, so the difference is resolved here once.
   */
  _targetCapsule(t) {
    if (this.isPlayerTarget(t)) {
      return { feet: t.position, height: CONFIG.player.height, radius: CONFIG.player.radius };
    }
    return { feet: t.position, height: t.height ?? 1.8, radius: t.radius ?? 0.33 };
  }

  /**
   * Distance, cone and line of sight, throttled.
   *
   * The eye point is the head - which on a quadruped is a metre in front of the
   * root and well below the top of it - so a wolf behind a low wall genuinely
   * cannot see over it.
   */
  _sense(dt) {
    this._senseTimer -= dt;
    this.satiated = Math.max(0, this.satiated - dt);
    if (this.target) {
      this.targetDistance = this.position.distanceTo(this.target.position);
      if (this.target.isDead) {
        // It brought something down. Predators eat; they do not queue.
        this.satiated = SATIATED_TIME;
        this.pack?.clearTarget();
        this._dropTarget();
      }
    }
    if (this._senseTimer > 0) {
      this.memory = Math.max(0, this.memory - dt);
      return;
    }
    this._senseTimer = SENSE_INTERVAL + this.rnd() * 0.06;

    // Confirm or lose the target we already have before looking for a new one:
    // a predator that re-picks the nearest body every fifth of a second flips
    // between two people standing together and never commits to either.
    if (this.target) {
      const seen = this._canSee(this.target);
      this.losClear = seen;
      if (seen) {
        this.memory = MEMORY;
        this.lastKnown.copy(this.target.position);
        this.hasLastKnown = true;
        // Anybody who can still see it keeps the whole pack's clock alive.
        if (this.pack && this.pack.target === this.target) this.pack.targetAge = 0;
      } else {
        this.memory = Math.max(0, this.memory - SENSE_INTERVAL);
      }
      /* Three ways to lose a hunt, and the third is the only one a walking
       * player cannot defeat. `loseInterest` is 46 m against a `chargeSpeed` of
       * 7.6 and a player's 4.6, so a beast closes on anybody who merely walks
       * and that clock never runs out; the leash is measured from HOME and
       * closes at the same rate whoever is being followed. */
      if (this.memory <= 0 || this.targetDistance > this.def.loseInterest
        || this.beyondLeash(this.target)) this._dropTarget();
      if (this.target) return;
    }

    if (this.satiated > 0) return;
    let best = null;
    let bestD = this.def.sight;
    for (const c of this._candidates()) {
      const d = this.position.distanceTo(c.position);
      if (d >= bestD) continue;
      if (!this._canSee(c, d)) continue;
      bestD = d;
      best = c;
    }
    if (best) this._acquire(best, true);
  }

  /**
   * @param {any} t
   * @param {number} [dist]
   * @returns {boolean}
   */
  _canSee(t, dist = this.position.distanceTo(t.position)) {
    if (!t || t.isDead) return false;
    if (dist > this.def.sight) return false;
    this.humanoid.getHeadWorldPosition(_eye);
    _v1.copy(t.position);
    _v1.y += (this.isPlayerTarget(t) ? CONFIG.player.eyeHeight : (t.height ?? 1.8) * 0.7);
    _v2.subVectors(_v1, _eye);
    const d = _v2.length();
    if (d < 1e-3) return true;
    _v2.multiplyScalar(1 / d);
    /* Three cones, near to far:
     *  - inside `scent`, none at all - it has your smell and facing is
     *    irrelevant, which is what stops a player walking up behind a bear and
     *    concluding the animal is broken;
     *  - once it has committed to you, a very wide one, so it does not lose you
     *    by turning its head mid-stride;
     *  - otherwise the species' own field of view. */
    const cone = dist < this.def.scent ? -1
      : this.target === t ? -0.35
        : this.fovCos;
    if (cone > -1 && _v2.dot(this.forward) < cone) return false;
    return !this.physics.raycast(_eye, _v2, d - 0.3, COLLISION_LAYER.WORLD);
  }

  /**
   * Take a target and, if this beast runs with a pack, tell the pack.
   *
   * @returns {boolean} false when the leash refused it, so callers that had
   *   something else to do with the news - `onDamaged` - still can.
   */
  _acquire(t, share = false) {
    if (!t || t.isDead) return false;
    /* The leash gates ACQUISITION as well as pursuit, and that is the half
     * that keeps the vale's cast alive. A beast that has been drawn out of its
     * country by a player - or thrown out of it by a flee - must not arrive
     * somewhere new and start hunting whoever lives there. */
    if (this.beyondLeash(t)) return false;
    const fresh = this.target !== t;
    this.target = t;
    /* Measure it NOW, not on the next sense.
     *
     * `_stalk` runs in the same `_think` call this is reached from - `_acquire`
     * sets the state and the switch below it dispatches immediately - and its
     * first line of business is "have I lost this, is it past `loseInterest`".
     * Left at its constructor value of Infinity that test is always true, so a
     * solitary beast acquired a target, dropped it in the same step, and went
     * back to roaming: measured, a lone wolf spawned five metres from the
     * player spent twenty seconds cycling ROAM -> STALK -> ROAM without ever
     * moving toward them. Packs hid it, because `_roam`'s re-adopt put the
     * target back a step later, by which point the distance was fresh. */
    this.targetDistance = this.position.distanceTo(t.position);
    this.memory = MEMORY;
    this.lastKnown.copy(t.position);
    this.hasLastKnown = true;
    if (fresh && this.state === 'ROAM') this.setState('STALK');
    if (share && this.pack) this.pack.share(t, this);
    return true;
  }

  /**
   * Adopt a target the pack found. Returns true when it was actually taken, so
   * `BeastPack.share` can report how far the word travelled.
   */
  adoptPackTarget(t) {
    if (this.isDead || !t || t.isDead) return false;
    if (this.satiated > 0) return false;
    /* Shared aggro is how a pack behaves like one, and it is also the path a
     * dragged pack would use to re-form around a target none of its members
     * could legally take: `_roam` re-adopts whatever the pack holds the moment
     * it is idle. Each member answers for its own leash. */
    if (this.beyondLeash(t)) return false;
    if (this.target === t) return true;
    this.target = t;
    // @see `_acquire` - the distance has to be fresh before `_stalk` reads it.
    this.targetDistance = this.position.distanceTo(t.position);
    this.memory = MEMORY;
    this.lastKnown.copy(t.position);
    this.hasLastKnown = true;
    if (this.state === 'ROAM') this.setState('STALK');
    return true;
  }

  _dropTarget() {
    this.target = null;
    this.losClear = false;
    this.memory = 0;
    this._endAttack();
    if (this.state !== 'FLEE' && this.state !== 'DEAD') this.setState('ROAM');
  }

  /**
   * Compatibility with `NPCManager.propagateAlert` and `_onGunfire`, which walk
   * `_hostiles` and call `alert(position)` on everything in it. A beast that is
   * shot at nearby should look up, not shrug - but it hunts what it can see, so
   * this only raises its attention rather than handing it a target.
   */
  alert(position) {
    if (this.isDead) return;
    this._senseTimer = 0;
    if (position) {
      this.lastKnown.copy(position);
      this.hasLastKnown = true;
    }
  }

  /* ---------------------------------------------------------------- */
  /* Damage                                                            */
  /* ---------------------------------------------------------------- */

  onDamaged(amount, isHeadshot, source) {
    const from = source?.position ?? source;
    // Whatever hurt it becomes the thing it is interested in, if it is
    // huntable. Being attacked overrides having just eaten: a beast that has
    // made a kill still defends itself, or the player could farm one for free.
    let took = false;
    if (source && source !== this && this._isHuntable(source)) {
      this.satiated = 0;
      took = this._acquire(source, true);
    }
    /* A shot from outside the leash still turns its head - it just does not
     * become a hunt. Losing that would make a sniped beast stand there with no
     * record of where the shot came from at all. */
    if (!took && from?.isVector3) {
      this.lastKnown.copy(from);
      this.hasLastKnown = true;
    }
    // A wolf that is losing runs; a bear does not have the concept.
    if (this.def.courage > 0 && this.health < this.maxHealth * this.def.courage) {
      this._beginFlee();
    }
    void amount;
    void isHeadshot;
  }

  _isHuntable(o) {
    if (!o || o.isDead) return false;
    if (o === this.manager?.player) return true;
    return o.type === 'friendly';
  }

  onDied() {
    this._endAttack();
    this.pack?.releaseAttack(this);
    // The rest of the pack loses its nerve for a moment when one of them drops.
    if (this.pack) {
      for (const m of this.pack.members) {
        if (m !== this && !m.isDead) m.spook?.(1.2);
      }
    }
  }

  onRespawned() {
    this.target = null;
    this.memory = 0;
    this.fleeTimer = 0;
    this.satiated = 0;
    this.attackTimer = 0;
    this._endAttack();
    this.setState('ROAM');
  }

  /** Back off for `seconds`, without abandoning the hunt outright. */
  spook(seconds) {
    this._spooked = Math.max(this._spooked ?? 0, seconds);
  }

  _beginFlee() {
    if (this.state === 'FLEE') return;
    this.pack?.releaseAttack(this);
    this._endAttack();
    this.fleeTimer = 6 + this.rnd() * 4;
    this.setState('FLEE');
  }

  /* ---------------------------------------------------------------- */
  /* State machine                                                     */
  /* ---------------------------------------------------------------- */

  _think(dt) {
    this.attackTimer = Math.max(0, this.attackTimer - dt);
    this._spooked = Math.max(0, (this._spooked ?? 0) - dt);
    this._sense(dt);
    if (this.pack && this.pack.firstLiving() === this) this.pack.update(dt);

    switch (this.state) {
      case 'ROAM': this._roam(dt); break;
      case 'STALK': this._stalk(dt); break;
      case 'ATTACK': this._attack(dt); break;
      case 'FLEE': this._flee(dt); break;
      default: break;
    }
    this._poseIntent();
  }

  /** Wander the territory. */
  _roam(dt) {
    this.desiredSpeed = this.def.roamSpeed;
    this.faceOverride = null;
    this._lookTarget = null;

    /* Rejoin the hunt.
     *
     * A wolf that turns its head at the wrong moment loses line of sight, ages
     * out its own memory and drops back to roaming - while the other four are
     * still working the same target twenty metres away. Without this it wanders
     * off on its own and the pack is four wolves and a tourist. The pack's own
     * clock is what stops this being a target nobody can ever escape: once no
     * member has confirmed it for `PACK_FORGET` seconds the pack forgets it and
     * there is nothing here to rejoin. */
    const shared = this.satiated > 0 ? null : this.pack?.target;
    if (shared && !shared.isDead
      && this.position.distanceTo(shared.position) < this.def.loseInterest
      // Only return if the target was actually TAKEN. The leash can refuse it,
      // and a member that returns anyway has skipped its own wander this step
      // for nothing - which, repeated every step, is a wolf standing still.
      && this.adoptPackTarget(shared)) {
      return;
    }

    if (this.roamPause > 0) {
      this.roamPause -= dt;
      this.nav.clear();
      return;
    }
    if (!this.nav.active || this.nav.isStuck) {
      this.nav.acknowledgeStuck();
      // Pause now and then: an animal that walks without stopping is a patrol
      // route with fur on. Standing still, sniffing, is what makes it read as
      // wildlife rather than as a guard.
      if (this.rnd() < 0.3) {
        this.roamPause = 1.5 + this.rnd() * 4;
        return;
      }
      /* Short legs inside the territory, a long one back to it from outside.
       *
       * Roaming straight at the far edge of a 34 m territory is twenty seconds
       * of walking in one direction without ever turning the head - which,
       * because sight is a cone off the body's facing, means an animal that
       * cannot notice anything it did not start out pointing at. Measured
       * before this: a wolf spawned five metres from the player walked thirty
       * metres away over ten seconds and never once looked at them. */
      const strayed = this.position.distanceToSquared(this.home) > this.def.territory ** 2;
      if (strayed) this._wanderNear(this.home, this.def.territory * 0.5);
      else this._wanderNear(this.position, 9);
    }
  }

  /**
   * Close on the target.
   *
   * A bear walks at you. A wolf holds the bearing its pack gave it and orbits,
   * closing only when it has an attack slot - which is the whole difference
   * between "four animals in a queue" and "a pack".
   */
  _stalk(dt) {
    const t = this.target;
    if (!t) {
      this.setState('ROAM');
      return;
    }
    this._lookTarget = t.position;
    this.faceOverride = t.position;

    const dist = this.targetDistance;
    const def = this.def;
    const wantsToCommit = this.attackTimer <= 0 && this.losClear && this._spooked <= 0
      && (!this.pack || this.pack.requestAttack(this));

    if (wantsToCommit && dist <= def.reach + this.radius) {
      this._beginAttack();
      return;
    }

    /* Committed: straight in, at speed - but never through the river.
     *
     * `_roam` and the orbit branch below both refuse a wet destination and a
     * wet route; this branch did not, and it is the only one that sets a
     * target somebody else chose. Measured in a live session: `npc-57`, a wolf
     * from the Hazelbrake pack, stood at (-28.87, 113.44) with the ground at
     * -0.83 m against a 0.85 m water line - 1.7 m out of its depth, twelve
     * metres off the channel centre, in the flooded margin - having charged
     * there in a straight line. A wolf cannot swim, which is why `rejectHome`
     * will not even house one below the flood line.
     *
     * ── WHAT THE FIRST VERSION OF THIS REFUSAL COST ────────────────────────
     * It cleared the nav and returned, having ALREADY been granted
     * `pack.requestAttack`. The slot was never given back, `_endAttack` was
     * unreachable because the beast never came within `def.reach`, and
     * `attackSlots` is `max(1, floor(liveCount / 3))` - which is ONE for any
     * pack of three to five. So one wolf whose line happened to cross the
     * river held the pack's only slot for as long as the target lived, and the
     * other four orbited forever. It could not be seen in a test because there
     * was no test, and in play it read as a pack that had noticed you and
     * decided not to bother.
     *
     * So a refusal gives the slot back and falls through to the ring, which is
     * strictly better than standing still: the ring is a legal, dry position
     * (the branch below checks it) and it is nearer the target, so a pack held
     * off by water works its way round to whatever side it CAN reach instead of
     * queueing on the bank. `requestAttack` is asked again next step, so the
     * moment the line clears, whichever member has the clearest one takes it. */
    let holdRing = !wantsToCommit;
    if (wantsToCommit) {
      _v1.copy(t.position);
      if (this.nav.isDeepWaterAt(_v1.x, _v1.z, _v1.y)
        || !this.nav.waterFreeLine(this.position, _v1)) {
        this.pack?.releaseAttack(this);
        holdRing = true;
      } else {
        this.desiredSpeed = def.chargeSpeed;
        this.nav.setTarget(_v1);
      }
    }

    if (holdRing) {
      // Not our turn (or the pack has none, or the water said no): hold the ring.
      this.desiredSpeed = def.stalkSpeed;
      const ring = Math.max(def.reach + 1.6, 4.2);
      const angle = this.pack ? this.pack.slotAngle(this) : this._soloOrbitAngle(dt);
      _v1.set(
        t.position.x + Math.cos(angle) * ring,
        t.position.y,
        t.position.z + Math.sin(angle) * ring
      );
      /* Probed at the TARGET's height, not at the ground's, which is what lets
       * a pack circle somebody standing on a bridge. The ring is 4.2 m across
       * so its points sit on the same deck the target does; probed from under
       * the planks every one of them reads as a metre and a half of river and
       * the whole pack holds station on the bank. @see Grounding.waterDepthAt */
      if (this.nav.isDeepWaterAt(_v1.x, _v1.z, _v1.y)) {
        // Never circle through the river; hold where we are instead.
        this.nav.clear();
      } else {
        this.nav.setTargetIfNew(_v1, 0.9);
      }
    }

    if (this.nav.isStuck) this.nav.acknowledgeStuck();
    // Gave up: too far, lost it for too long, or it left this animal's country.
    // The last of those is the only one a player who simply keeps walking
    // cannot outlast - @see `beyondLeash`.
    if (dist > def.loseInterest || (this.memory <= 0 && !this.losClear)
      || this.beyondLeash(t)) this._dropTarget();
  }

  /** A lone beast still circles, just on its own clock. */
  _soloOrbitAngle(dt) {
    this._soloOrbit = (this._soloOrbit ?? this.rnd() * Math.PI * 2) + dt * 0.5;
    return this._soloOrbit;
  }

  /* ---------------------------------------------------------------- */
  /* The maul                                                          */
  /* ---------------------------------------------------------------- */

  _beginAttack() {
    this.attackPhase = 'telegraph';
    this._atkT = 0;
    this._atkHit = false;
    this.setState('ATTACK');
    this.bus?.emit('beast:telegraph', {
      beast: this, species: this.species, position: this.position,
      duration: this.def.telegraph,
    });
  }

  _endAttack() {
    this.attackPhase = 'none';
    this._atkT = 0;
    this._atkHit = false;
    this.pack?.releaseAttack(this);
  }

  /**
   * The committed sequence. Once this starts the beast is slow and cannot
   * change its mind, which is precisely what makes it dodgeable - and it is
   * the same bargain `NPCWeapons` strikes for the bow and the staff.
   */
  _attack(dt) {
    const def = this.def;
    const t = this.target;
    if (!t || t.isDead) {
      this._endAttack();
      this.setState('ROAM');
      return;
    }
    this._atkT += dt;
    this._lookTarget = t.position;

    if (this.attackPhase === 'telegraph') {
      // Still steering, but barely: enough to track a target that side-steps
      // early, not enough to follow one that dodges late.
      this.desiredSpeed = def.chargeSpeed * 0.25;
      this.faceOverride = t.position;
      this.nav.setTarget(t.position);
      if (this._atkT >= def.telegraph) {
        this.attackPhase = 'strike';
        this._atkT = 0;
      }
      return;
    }

    if (this.attackPhase === 'strike') {
      this.desiredSpeed = 0;
      this.nav.clear();
      const u = clamp(this._atkT / def.strikeWindow, 0, 1);
      if (!this._atkHit && this._testStrike(t, u)) this._land(t);
      if (this._atkT >= def.strikeWindow) {
        this.attackPhase = 'recover';
        this._atkT = 0;
      }
      return;
    }

    // Recovering: open, and going nowhere.
    this.desiredSpeed = 0;
    this.nav.clear();
    this.faceOverride = t.position;
    if (this._atkT >= def.recover) {
      this.attackTimer = def.attackCooldown;
      this._endAttack();
      this.setState('STALK');
    }
  }

  /**
   * Where the blow comes from: the mouth, in world space.
   *
   * Derived from the built body's own muzzle point rather than from a constant,
   * and taken from the ROOT transform rather than from the animated head - the
   * contact volume must not wobble with the head bob, or a hit would depend on
   * which frame of the gait cycle the beast happened to be in.
   */
  _strikeOrigin(out) {
    const local = this.humanoid?.muzzleLocal;
    const forward = this.forward;             // (-sin yaw, 0, -cos yaw)
    const ahead = local ? -local.z : this.def.bodyLength * 0.5;
    const up = local ? local.y : this.def.shoulderHeight * 0.8;
    return out.set(
      this.position.x + forward.x * ahead,
      this.position.y + up,
      this.position.z + forward.z * ahead
    );
  }

  /** @returns {boolean} true when the volume is touching the target right now */
  _testStrike(t, u) {
    const cap = this._targetCapsule(t);
    this._strikeOrigin(_origin);
    return strikeHits({
      origin: _origin,
      yaw: this.yaw,
      reach: this.def.reach,
      arc: STRIKE_ARC[this.species] ?? 0.3,
      drop: STRIKE_DROP[this.species] ?? 0.1,
      strikeRadius: this.def.strikeRadius,
      u,
      feet: cap.feet,
      height: cap.height,
      radius: cap.radius,
    });
  }

  /**
   * It connected. Everything past this point - damage, knockback, the camera
   * kick, the claw decal, the bleed - is the combat system's job, exactly as
   * it is for a bullet: `NPCManager.beastMaul` publishes it and resolves it
   * itself only if nothing is listening, which is the same contract
   * `npcFire` has always had.
   */
  _land(t) {
    this._atkHit = true;
    const damage = rollBeastDamage(this.def, this.rnd);
    this.lastAttackDamage = damage;
    this._strikeOrigin(_origin);
    _v3.subVectors(t.position, this.position);
    _v3.y = 0;
    if (_v3.lengthSq() < 1e-6) _v3.copy(this.forward);
    _v3.normalize();
    this.manager?.beastMaul?.(this, {
      target: t,
      isPlayer: this.isPlayerTarget(t),
      damage,
      origin: _origin,
      direction: _v3,
      def: this.def,
    });
  }

  /* ---------------------------------------------------------------- */
  /* Flee + wander                                                     */
  /* ---------------------------------------------------------------- */

  _flee(dt) {
    this.desiredSpeed = this.def.chargeSpeed * 0.95;
    this.faceOverride = null;
    this._lookTarget = null;
    this.fleeTimer -= dt;
    if (!this.nav.active || this.nav.isStuck) {
      this.nav.acknowledgeStuck();
      const away = this.target ?? { position: this.lastKnown };
      _v2.subVectors(this.position, away.position ?? this.lastKnown);
      _v2.y = 0;
      if (_v2.lengthSq() < 1e-4) _v2.copy(this.forward).negate();
      _v2.normalize();
      _v1.copy(this.position).addScaledVector(_v2, 14 + this.rnd() * 8);
      this._wanderNear(_v1, 8);
    }
    if (this.fleeTimer <= 0) {
      this.target = null;
      this.memory = 0;
      this.setState('ROAM');
    }
  }

  /**
   * Pick somewhere to walk to near `origin`.
   *
   * The same shape as `HostileNPC._wanderNear` and for the same reasons - clear
   * line, no deep water on the way or at the end - because those constraints
   * are properties of the world rather than of the character.
   */
  _wanderNear(origin, radius) {
    for (let i = 0; i < 6; i++) {
      const a = this.rnd() * Math.PI * 2;
      const r = radius * (0.3 + this.rnd() * 0.7);
      const x = origin.x + Math.cos(a) * r;
      const z = origin.z + Math.sin(a) * r;
      if (this.nav.isDeepWaterAt(x, z)) continue;
      const ground = this.physics.groundHeight(x, z, origin.y + 8, 18);
      if (ground === null) continue;
      _v1.set(x, ground, z);
      if (!this.nav._clearLine(this.position, _v1)) continue;
      if (!this.nav.waterFreeLine(this.position, _v1)) continue;
      this.nav.setTarget(_v1);
      return true;
    }
    this.nav.clear();
    return false;
  }

  /* ---------------------------------------------------------------- */
  /* Pose                                                              */
  /* ---------------------------------------------------------------- */

  /**
   * Hand the state machine to the animator.
   *
   * What each state LOOKS like is the animator's business - see
   * `BeastAnimator.setIntentForState`. What matters here is that the wind-up
   * weight is taken from the attack timer itself rather than from a parallel
   * animation clock: the whole fairness argument for a 26-point swipe is that
   * the animal spends 0.8 s visibly winding up first, and that argument is only
   * true if the two can never drift apart.
   */
  _poseIntent() {
    this.animator?.setIntentForState?.({
      state: this.state,
      phase: this.attackPhase,
      wind: this.attackPhase === 'telegraph'
        ? clamp(this._atkT / Math.max(0.01, this.def.telegraph), 0, 1)
        : 0,
      hunting: !!this.target,
      stalking: !!this.target && this.moveSpeed < this.def.stalkSpeed * 1.2,
    });
  }
}
