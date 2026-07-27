import * as THREE from 'three';
import { CONFIG } from '../core/Config.js';
import { NPC } from './NPC.js';

/**
 * Civilian / ally.
 *
 * Wanders its waypoints, drifts into small standing groups that face each
 * other, notices the player approaching and greets them, and scatters when
 * shooting starts. Friendlies are the reason a world feels inhabited rather
 * than staged, so most of the work here is about idle behaviour reading as
 * intent rather than as a random walk.
 */

const _v1 = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _v3 = new THREE.Vector3();

/** Held poses a civilian can fall into while standing around. */
const POSTURE_POOL = ['none', 'crossed', 'hips', 'pocket', 'none', 'lean', 'crossed', 'pocket'];

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

    this.setState('IDLE');
    if (this.patrol.length > 1 && !this.anchored) this.nav.setPath(this.patrol);
  }

  get player() {
    return this.manager?.player ?? null;
  }

  /** Loud noise nearby: drop everything and get away from it. */
  onGunfire(origin, intensity = 1) {
    if (this.isDead) return;
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

    switch (this.state) {
      case 'FLEE':
        this._flee(dt);
        return;
      case 'GREET':
        this._greet(dt, player, dist);
        return;
      case 'SOCIAL':
        this._social(dt, dist);
        return;
      case 'WANDER':
        this._wander(dt, dist);
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
    const standing = this.state === 'IDLE' || this.state === 'SOCIAL' || this.state === 'GREET';
    if (!standing || this.moveSpeed > 0.35) {
      this.animator.setPosture('none');
      this.animator.setGesturing(false);
      return;
    }

    this.postureTimer -= dt;
    if (this.postureTimer <= 0) {
      this.postureTimer = 7 + this.rnd() * 12;
      // Keep an authored posture (a lounging skater stays lounging); otherwise
      // drift between poses so a long look at a crowd never freezes.
      if (!this.fixedPosture) {
        this.posture = POSTURE_POOL[(this.rnd() * POSTURE_POOL.length) | 0];
      }
    }
    this.animator.setPosture(this.state === 'GREET' ? 'none' : this.posture);

    // Talking hands, but only when there is somebody to talk to.
    const talking = this.state === 'SOCIAL' && this.nav.arrived !== false;
    this.gestureTimer -= dt;
    if (this.gestureTimer <= 0) {
      this.gesturing = talking && this.rnd() < 0.55;
      this.gestureTimer = this.gesturing ? 1.5 + this.rnd() * 2.5 : 2 + this.rnd() * 4;
    }
    this.animator.setGesturing(this.gesturing && talking);
  }

  _noticePlayer(dist) {
    const player = this.player;
    if (!player || player.isDead) return false;
    // Turn toward the player well before chat range, greet inside it.
    if (dist < CONFIG.npc.chatRange * 2.4) {
      this._lookTarget = _v3.copy(player.position).setY(player.position.y + CONFIG.player.eyeHeight);
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

    if (this.anchored) {
      // Anchored civilians never wander, but they do drift back into position
      // if something (the player, a stampede) shoved them out of it.
      const off = this.position.distanceToSquared(this.spawnPoint);
      if (off > 1.6 * 1.6) this.nav.setTarget(this.spawnPoint);
      else this.nav.clear();
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
      this.nav.setTarget(_v2);
      this.faceOverride = null;
    } else {
      this.nav.clear();
      this.faceOverride = partner.position;
    }
    this._lookTarget = _v3.copy(partner.position).setY(partner.position.y + partner.height * 0.9);

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
    this._lookTarget = _v3.copy(player.position).setY(player.position.y + CONFIG.player.eyeHeight);
    if (!this.hasGreeted && this.stateTime > 0.35) {
      this.hasGreeted = true;
      this.waveTimer = 1.35;
    }
    // A wave is an aim-layer pose: the arm reaches up toward the player's head.
    if (this.waveTimer > 0) {
      _v1.copy(player.position);
      _v1.y += CONFIG.player.eyeHeight + 0.35;
      this.animator.setAimTarget(_v1);
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

  _pickWanderTarget() {
    if (this.patrol.length > 1 && this.rnd() < 0.65) {
      this.patrolIndex = (this.patrolIndex + 1 + ((this.rnd() * 2) | 0)) % this.patrol.length;
      const wp = this.patrol[this.patrolIndex];
      const g = this.physics.groundHeight(wp.x, wp.z, wp.y + 6, 14);
      _v1.set(wp.x, g ?? wp.y, wp.z);
      this.nav.setTarget(_v1);
      return;
    }
    for (let i = 0; i < 6; i++) {
      const a = this.rnd() * Math.PI * 2;
      const r = this.homeRadius * (0.3 + this.rnd() * 0.7);
      const x = this.spawnPoint.x + Math.cos(a) * r;
      const z = this.spawnPoint.z + Math.sin(a) * r;
      const g = this.physics.groundHeight(x, z, this.spawnPoint.y + 8, 18);
      if (g === null) continue;
      _v1.set(x, g, z);
      if (!this.nav._clearLine(this.position, _v1)) continue;
      this.nav.setTarget(_v1);
      return;
    }
    this.setState('IDLE');
  }
}
