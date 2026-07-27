import * as THREE from 'three';
import { CONFIG } from '../core/Config.js';
import { COLLISION_LAYER } from '../physics/Physics.js';
import { NPC, clamp } from './NPC.js';

/**
 * Hostile combatant.
 *
 * PATROL -> SUSPICIOUS -> COMBAT -> REPOSITION -> DEAD.
 *
 * Detection is a genuine sensor: distance, a field-of-view cone from
 * `CONFIG.npc.fieldOfView`, and a line-of-sight raycast against world
 * colliders, integrated into an awareness value so a glimpse at 40 m does not
 * instantly become a firefight. Combat telegraphs: the weapon comes up, there
 * is a beat, and only then does the burst start - so a player can react.
 */

const _v1 = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _v3 = new THREE.Vector3();
const _v4 = new THREE.Vector3();
const _aim = new THREE.Vector3();

const COVER_DIRS = 10;

/** Shared rifle geometry, built once and hung off the assets cache. */
function rifleGeometry(assets) {
  const key = 'npc.rifle';
  let g = assets.geoCache.get(key);
  if (g) return g;
  const parts = [];
  const push = (geo, x, y, z, rx = 0) => {
    if (rx) geo.rotateX(rx);
    geo.translate(x, y, z);
    parts.push(geo);
  };
  push(new THREE.BoxGeometry(0.05, 0.075, 0.36), 0, 0, -0.06);            // receiver
  push(new THREE.BoxGeometry(0.036, 0.05, 0.30), 0, -0.005, -0.35);       // handguard
  push(new THREE.CylinderGeometry(0.011, 0.011, 0.26, 8), 0, 0.006, -0.58, Math.PI / 2);
  push(new THREE.BoxGeometry(0.042, 0.10, 0.11), 0, -0.075, -0.02);       // magazine
  push(new THREE.BoxGeometry(0.046, 0.085, 0.20), 0, -0.012, 0.20);       // stock
  push(new THREE.BoxGeometry(0.03, 0.055, 0.045), 0, 0.055, -0.02);       // optic
  // Merge by hand: BufferGeometryUtils would pull in an addon for six boxes.
  let vTotal = 0;
  let iTotal = 0;
  for (const p of parts) {
    vTotal += p.getAttribute('position').count;
    iTotal += p.getIndex().count;
  }
  const pos = new Float32Array(vTotal * 3);
  const nrm = new Float32Array(vTotal * 3);
  const uv = new Float32Array(vTotal * 2);
  const idx = new Uint16Array(iTotal);
  let vo = 0;
  let io = 0;
  for (const p of parts) {
    const pp = p.getAttribute('position');
    const pn = p.getAttribute('normal');
    const pu = p.getAttribute('uv');
    const pi = p.getIndex();
    pos.set(pp.array, vo * 3);
    nrm.set(pn.array, vo * 3);
    uv.set(pu.array, vo * 2);
    for (let i = 0; i < pi.count; i++) idx[io + i] = pi.getX(i) + vo;
    vo += pp.count;
    io += pi.count;
    p.dispose();
  }
  g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.BufferAttribute(nrm, 3));
  g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  g.setIndex(new THREE.BufferAttribute(idx, 1));
  g.computeBoundingSphere();
  assets.geoCache.set(key, g);
  return g;
}

export class HostileNPC extends NPC {
  constructor(ctx) {
    super({ ...ctx, type: 'hostile' });

    this.awareness = 0;
    this.alerted = false;
    this.lastKnownTarget = new THREE.Vector3();
    this.hasLastKnown = false;
    this.losClear = false;
    this.targetDistance = Infinity;

    this.magazine = 30;
    this.ammo = this.magazine;
    this.reloadTimer = 0;
    this.burstLeft = 0;
    this.burstTimer = 0;
    this.telegraph = 0;
    this.fireCooldown = 0;
    this.burstsSinceReload = 0;

    this.strafeDir = this.rnd() < 0.5 ? -1 : 1;
    this.strafeTimer = 1 + this.rnd() * 2;
    this.coverTimer = 0;
    this.coverPoint = null;
    this.repositionTimer = 0;

    this.preferredRange = 9 + this.rnd() * 9;
    this.accuracy = CONFIG.npc.accuracy;
    this.sightRange = CONFIG.npc.sightRange;
    this.fovCos = Math.cos((CONFIG.npc.fieldOfView * Math.PI) / 360);

    this._senseTimer = this.rnd() * 0.2;
    this._muzzle = new THREE.Vector3();
    this._recoil = new THREE.Vector3();

    // Weapon: parented to the right hand so the aim IK carries it.
    const assets = this.manager?.assets;
    if (assets) {
      const mat = assets.metal(0x2a2e34, 'panel', 0.44);
      this.weapon = new THREE.Mesh(rifleGeometry(assets), mat);
      this.weapon.castShadow = true;
      this.weapon.position.set(0.01, -0.05, -0.05);
      this.weapon.rotation.set(-1.35, 0.06, 0.0);
      this.humanoid.weaponMount.add(this.weapon);
    }

    this.setState('PATROL');
    if (this.patrol.length > 0) this.nav.setPath(this.patrol);
  }

  get target() {
    return this.manager?.player ?? null;
  }

  /* ---------------------------------------------------------------- */
  /* Perception                                                        */
  /* ---------------------------------------------------------------- */

  /** Distance + FOV cone + line of sight. Throttled; senses do not need 60 Hz. */
  _sense(dt) {
    this._senseTimer -= dt;
    const player = this.target;
    if (!player || player.isDead) {
      this.losClear = false;
      this.targetDistance = Infinity;
      this.awareness = Math.max(0, this.awareness - dt * 0.5);
      return;
    }
    _v1.copy(player.position);
    _v1.y += CONFIG.player.eyeHeight * 0.75;
    this.targetDistance = this.position.distanceTo(player.position);

    if (this._senseTimer > 0) return;
    this._senseTimer = 0.12 + this.rnd() * 0.06;

    let visible = false;
    if (this.targetDistance < this.sightRange) {
      _v2.subVectors(_v1, this.headPosition);
      const dist = _v2.length();
      _v2.multiplyScalar(1 / dist);
      const facing = this.forward;
      // Alerted enemies get a wider cone - they know roughly where you are.
      const cone = this.alerted ? -0.2 : this.fovCos;
      if (_v2.dot(facing) > cone) {
        const hit = this.physics.raycast(this.headPosition, _v2, dist - 0.25, COLLISION_LAYER.WORLD);
        visible = !hit;
      }
    }
    this.losClear = visible;

    const closeness = 1 - clamp(this.targetDistance / this.sightRange, 0, 1);
    if (visible) {
      this.awareness = Math.min(1.6, this.awareness + (0.35 + closeness * 1.5) * 0.18);
      this.lastKnownTarget.copy(player.position);
      this.hasLastKnown = true;
    } else {
      this.awareness = Math.max(0, this.awareness - 0.055);
    }
  }

  /** Told about the player by an ally or by taking a hit. */
  alert(position, hard = false) {
    if (this.isDead) return;
    this.alerted = true;
    if (position) {
      this.lastKnownTarget.copy(position);
      this.hasLastKnown = true;
    }
    this.awareness = Math.max(this.awareness, hard ? 1.05 : 0.72);
  }

  onDamaged(amount, isHeadshot, source) {
    const from = source?.position ?? source;
    this.alert(from && from.isVector3 ? from : null, true);
    this.manager?.propagateAlert(this, 26);
    // Being shot at from cover is a reason to move.
    if (this.state === 'COMBAT' && this.rnd() < 0.5) this._beginReposition();
    void amount;
    void isHeadshot;
  }

  onDied() {
    if (this.weapon) {
      // Drop the rifle out of the hand so the corpse is not clutching it.
      this.weapon.visible = true;
    }
    this.animator.setAimTarget(null);
    this.manager?.propagateAlert(this, 20);
  }

  /* ---------------------------------------------------------------- */
  /* State machine                                                     */
  /* ---------------------------------------------------------------- */

  _think(dt) {
    this._sense(dt);
    this.fireCooldown = Math.max(0, this.fireCooldown - dt);
    if (this.reloadTimer > 0) this.reloadTimer = Math.max(0, this.reloadTimer - dt);

    switch (this.state) {
      case 'PATROL':
        this._patrol(dt);
        break;
      case 'SUSPICIOUS':
        this._suspicious(dt);
        break;
      case 'COMBAT':
        this._combat(dt);
        break;
      case 'REPOSITION':
        this._reposition(dt);
        break;
      default:
        break;
    }
  }

  _patrol(dt) {
    this.desiredSpeed = CONFIG.npc.walkSpeed;
    this.faceOverride = null;
    this._lookTarget = null;
    this.animator.setAimTarget(null);

    if (this.nav.path.length === 0 && this.patrol.length > 0) this.nav.setPath(this.patrol);
    if (!this.nav.active) {
      if (this.patrol.length > 1) {
        // Loop the route rather than stopping at the end of it.
        this.nav.setPath(this.patrol);
      } else {
        this._wanderNear(this.spawnPoint, 7);
      }
    }
    if (this.nav.isStuck) {
      this.nav.acknowledgeStuck();
      this._wanderNear(this.position, 5);
    }
    if (this.awareness > 0.5) this.setState('SUSPICIOUS');
    void dt;
  }

  _suspicious(dt) {
    this.desiredSpeed = CONFIG.npc.walkSpeed * 1.5;
    this._lookTarget = this.hasLastKnown ? this.lastKnownTarget : null;
    this.faceOverride = this.hasLastKnown ? this.lastKnownTarget : null;
    this.animator.setAiming(true);
    this.animator.setAimTarget(this._aimPoint());

    if (this.hasLastKnown && this.stateTime > 0.35) {
      _v1.copy(this.lastKnownTarget);
      if (this.position.distanceTo(_v1) > 6) this.nav.setTarget(_v1);
      else this.nav.clear();
    }
    if (this.awareness > 1.0) {
      this.alerted = true;
      this.manager?.propagateAlert(this, 22);
      this.setState('COMBAT');
    } else if (this.awareness < 0.18 && this.stateTime > 3) {
      this.alerted = false;
      this.setState('PATROL');
    }
    void dt;
  }

  _combat(dt) {
    const player = this.target;
    if (!player || player.isDead) {
      this.setState('PATROL');
      return;
    }
    this.desiredSpeed = CONFIG.npc.runSpeed * 0.62;
    this.faceOverride = this.hasLastKnown ? this.lastKnownTarget : player.position;
    this._lookTarget = player.position;
    this.animator.setAimTarget(this._aimPoint());

    const dist = this.targetDistance;

    // --- movement: hold the preferred band and keep strafing ---------
    this.strafeTimer -= dt;
    if (this.strafeTimer <= 0 || this.nav.blocked) {
      this.strafeDir *= -1;
      this.strafeTimer = 1.3 + this.rnd() * 2.2;
    }
    this.coverTimer -= dt;
    if (this.coverTimer <= 0 && this.manager?.requestCoverSlot(this)) {
      this.coverTimer = 1.6 + this.rnd();
      this.coverPoint = this._findCover(player);
    }

    if (this.coverPoint && this.position.distanceToSquared(this.coverPoint) > 1.2) {
      this.nav.setTarget(this.coverPoint);
    } else {
      _v1.subVectors(this.position, player.position);
      _v1.y = 0;
      const d = _v1.length() || 1;
      _v1.multiplyScalar(1 / d);
      _v2.set(-_v1.z, 0, _v1.x).multiplyScalar(this.strafeDir);
      const closeIn = dist > this.preferredRange + 3 ? -1 : dist < this.preferredRange - 3 ? 1 : 0;
      _v3.copy(this.position)
        .addScaledVector(_v1, closeIn * 4)
        .addScaledVector(_v2, 3.5);
      this.nav.setTarget(_v3);
    }
    if (this.nav.isStuck) {
      this.nav.acknowledgeStuck();
      this.strafeDir *= -1;
      this.coverPoint = null;
    }

    // --- firing ------------------------------------------------------
    this._updateFiring(dt);

    if (!this.losClear && this.awareness < 0.55) {
      if (this.stateTime > 2.5) this._beginReposition();
    }
    if (this.awareness <= 0.05 && this.stateTime > 6) {
      this.alerted = false;
      this.coverPoint = null;
      this.setState('PATROL');
    }
  }

  _reposition(dt) {
    this.desiredSpeed = CONFIG.npc.runSpeed * 0.85;
    this.animator.setAimTarget(this.losClear ? this._aimPoint() : null);
    this._lookTarget = this.hasLastKnown ? this.lastKnownTarget : null;
    this.faceOverride = null;
    this.repositionTimer -= dt;
    if (!this.nav.active || this.nav.isStuck) {
      this.nav.acknowledgeStuck();
      this._wanderNear(this.hasLastKnown ? this.lastKnownTarget : this.position, 9);
    }
    if (this.repositionTimer <= 0) {
      this.setState(this.awareness > 0.4 || this.alerted ? 'COMBAT' : 'PATROL');
    }
  }

  _beginReposition() {
    this.repositionTimer = 1.8 + this.rnd() * 2.2;
    this.coverPoint = null;
    this.setState('REPOSITION');
  }

  /* ---------------------------------------------------------------- */
  /* Weapon                                                            */
  /* ---------------------------------------------------------------- */

  _aimPoint() {
    const player = this.target;
    if (!player) return null;
    _aim.copy(player.position);
    _aim.y += CONFIG.player.eyeHeight * 0.78;
    return _aim;
  }

  _updateFiring(dt) {
    if (this.reloadTimer > 0) {
      this.animator.setAiming(false);
      return;
    }
    this.animator.setAiming(true);
    if (this.ammo <= 0) {
      this.reloadTimer = 2.1;
      this.ammo = this.magazine;
      this.burstsSinceReload = 0;
      this.burstLeft = 0;
      return;
    }
    if (!this.losClear || this.targetDistance > CONFIG.npc.attackRange) {
      this.telegraph = 0;
      return;
    }
    // Telegraph: settle the aim before the first round of a burst.
    if (this.burstLeft <= 0) {
      if (this.fireCooldown > 0) return;
      this.telegraph += dt;
      if (this.telegraph < 0.34) return;
      this.telegraph = 0;
      this.burstLeft = 3 + ((this.rnd() * 3) | 0);
      this.burstTimer = 0;
      this.burstsSinceReload++;
      if (this.burstsSinceReload >= 3 + ((this.rnd() * 2) | 0)) {
        this.reloadTimer = 2.1;
        this.ammo = this.magazine;
        this.burstsSinceReload = 0;
        this.burstLeft = 0;
        return;
      }
    }
    this.burstTimer -= dt;
    if (this.burstTimer > 0) return;
    this.burstTimer = 0.11;
    this.burstLeft--;
    this.ammo--;
    if (this.burstLeft <= 0) this.fireCooldown = 1.05 + this.rnd() * 1.35;
    this._fire();
  }

  _fire() {
    const player = this.target;
    if (!player) return;
    // Muzzle sits at the end of the barrel in world space.
    if (this.weapon) {
      this.weapon.updateWorldMatrix(true, false);
      this._muzzle.set(0, 0.006, -0.71).applyMatrix4(this.weapon.matrixWorld);
    } else {
      this._muzzle.copy(this.headPosition);
    }
    _v1.copy(player.position);
    _v1.y += CONFIG.player.eyeHeight * 0.72;
    _v2.subVectors(_v1, this._muzzle);
    const dist = _v2.length() || 1;
    _v2.multiplyScalar(1 / dist);

    // Accuracy is a cone: 1.0 is perfect, CONFIG.npc.accuracy scales the miss.
    // Long shots and moving while shooting both open it up.
    const spread =
      (1 - this.accuracy) * 0.062 * (0.7 + 0.3 * clamp(dist / CONFIG.npc.attackRange, 0, 1.4)) +
      (this.moveSpeed > 1.2 ? 0.012 : 0);
    _v3.set(this.rnd() - 0.5, this.rnd() - 0.5, this.rnd() - 0.5).multiplyScalar(spread);
    _v2.add(_v3).normalize();

    this._recoil.copy(_v2).negate();
    this.animator.flinch(this._recoil, false);
    this.manager?.npcFire(this, this._muzzle, _v2, CONFIG.npc.attackDamage);
  }

  /* ---------------------------------------------------------------- */
  /* Cover + wander                                                    */
  /* ---------------------------------------------------------------- */

  /**
   * Probe a ring of candidate positions and keep the nearest one that both
   * breaks line of sight to the player and can actually be walked to.
   */
  _findCover(player) {
    _v4.copy(player.position);
    _v4.y += CONFIG.player.eyeHeight * 0.8;
    let best = null;
    let bestScore = Infinity;
    const baseAngle = this.rnd() * Math.PI * 2;
    for (let i = 0; i < COVER_DIRS; i++) {
      const a = baseAngle + (i / COVER_DIRS) * Math.PI * 2;
      const dist = 4 + (i % 3) * 3.5;
      _v1.set(this.position.x + Math.cos(a) * dist, this.position.y, this.position.z + Math.sin(a) * dist);
      const ground = this.physics.groundHeight(_v1.x, _v1.z, this.position.y + 4, 8);
      if (ground === null) continue;
      _v1.y = ground;
      // Must be occluded from the player...
      _v2.set(_v1.x, _v1.y + 1.3, _v1.z);
      _v3.subVectors(_v4, _v2);
      const d = _v3.length();
      _v3.multiplyScalar(1 / d);
      if (!this.physics.raycast(_v2, _v3, d - 0.3, COLLISION_LAYER.WORLD)) continue;
      // ...and reachable, or it is a trap rather than cover.
      if (!this.nav._clearLine(this.position, _v1)) continue;
      const score = this.position.distanceToSquared(_v1) + Math.abs(_v1.distanceTo(player.position) - this.preferredRange) * 4;
      if (score < bestScore) {
        bestScore = score;
        best = _v1.clone();
      }
    }
    return best;
  }

  _wanderNear(origin, radius) {
    for (let i = 0; i < 5; i++) {
      const a = this.rnd() * Math.PI * 2;
      const r = radius * (0.35 + this.rnd() * 0.65);
      const x = origin.x + Math.cos(a) * r;
      const z = origin.z + Math.sin(a) * r;
      const ground = this.physics.groundHeight(x, z, origin.y + 6, 14);
      if (ground === null) continue;
      _v1.set(x, ground, z);
      if (!this.nav._clearLine(this.position, _v1)) continue;
      this.nav.setTarget(_v1);
      return true;
    }
    this.nav.clear();
    return false;
  }
}
