import * as THREE from 'three';
import { CONFIG } from '../core/Config.js';
import { COLLISION_LAYER } from '../physics/Physics.js';
import { NPC, clamp } from './NPC.js';
import { NPC_WEAPONS, buildWeaponModel, pickWeaponId, rollDamage, isMelee } from './NPCWeapons.js';

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
 *
 * Each hostile draws a weapon per encounter from `NPCWeapons` - sidearm, rifle,
 * bow or staff - and everything downstream follows from it: engagement range,
 * the band the AI tries to hold, rate of fire, magazine, reload, accuracy, the
 * length of the telegraph, and the damage band. That is what stops a firefight
 * being ten identical rifles delivering identical chip damage, and it is kept
 * fair by tying damage to telegraph: the 26-point arrow takes nearly a second
 * of visible draw, the 7-point sidearm barely pauses.
 */

const _v1 = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _v3 = new THREE.Vector3();
const _v4 = new THREE.Vector3();
const _aim = new THREE.Vector3();

const COVER_DIRS = 10;

export class HostileNPC extends NPC {
  constructor(ctx) {
    super({ ...ctx, type: 'hostile' });

    this.awareness = 0;
    this.alerted = false;
    this.lastKnownTarget = new THREE.Vector3();
    this.hasLastKnown = false;
    this.losClear = false;
    this.targetDistance = Infinity;

    this.reloadTimer = 0;
    this.burstLeft = 0;
    this.burstTimer = 0;
    this.telegraph = 0;
    this.fireCooldown = 0;
    this.burstsSinceReload = 0;

    /** Weapon ids this hostile is allowed to draw. Set by the manager. */
    this.weaponPool = ctx.weaponPool ?? null;
    /**
     * This character's weapon is part of its identity and must not be re-rolled.
     *
     * `_patrol` re-draws on first contact, and says why: "One weapon per
     * encounter: the draw happens as the character notices something, so a
     * player who fights the same patrol twice does not fight the same loadout
     * twice." That is right for an anonymous unit and it stays the default -
     * every hostile in every world that does not ask otherwise still re-rolls.
     *
     * It is wrong for an ARCHETYPE. The station names four (see `HOSTILE_KIND`
     * in StationWorld and `KINDS` in zones/Construction.js) and each one IS its
     * weapon: a Breaker Frame is a brawler because it carries a baton and an
     * Arc Lance Sentry telegraphs for most of a second because it carries a
     * lance. Measured before this flag existed: a "Rogue Security Unit" dealt
     * out a rifle at spawn was carrying a sidearm by the time it reached
     * COMBAT, so the name on the enemy told the player nothing about the fight
     * they were in - which is the whole thing an archetype is for.
     *
     * Set only when a world authored `weaponId` on the spawn descriptor. The
     * manager's own shuffled deal does not set it, so the unlearnable pairing
     * the note above wants is preserved everywhere it was.
     */
    this.weaponFixed = ctx.weaponFixed === true;
    this.weaponId = null;
    this.weaponDef = NPC_WEAPONS.rifle;
    this.magazine = this.weaponDef.magazine;
    this.ammo = this.magazine;
    this._weaponModels = new Map();
    this._muzzleLocal = new THREE.Vector3();

    this.strafeDir = this.rnd() < 0.5 ? -1 : 1;
    this.strafeTimer = 1 + this.rnd() * 2;
    /** Edge detector for `nav.blocked`; see `_combat`. */
    this._wasBlocked = false;
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

    this.selectWeapon(ctx.weaponId);

    this.setState('PATROL');
    if (this.patrol.length > 0) this.nav.setPath(this.patrol);
  }

  get target() {
    return this.manager?.player ?? null;
  }

  /* ---------------------------------------------------------------- */
  /* Weapons                                                           */
  /* ---------------------------------------------------------------- */

  /**
   * Draw a weapon for this encounter and adopt its stats wholesale.
   *
   * Models are built once per weapon id per character and then kept, hidden,
   * on the hand mount. That is deliberate: Three compiles a shader program the
   * first time a material is drawn, so building a staff for the first time in
   * the middle of a firefight would cost a frame. Building every model this
   * character can ever draw during world activation - behind the loading
   * screen - means a re-roll on respawn is a `visible` flip and nothing else.
   *
   * @param {string} [forceId] specific weapon, otherwise rolled from the pool
   */
  selectWeapon(forceId) {
    const theme = this.theme;
    const pool = this.weaponPool;
    let id = forceId;
    if (!id) {
      id = pool && pool.length ? pool[(this.rnd() * pool.length) | 0] : pickWeaponId(theme, this.rnd);
    }
    if (id === this.weaponId) {
      this._resetWeaponState();
      return;
    }
    this.weaponId = id;
    this.weaponDef = NPC_WEAPONS[id] ?? NPC_WEAPONS.rifle;

    const assets = this.manager?.assets;
    if (assets) {
      let entry = this._weaponModels.get(id);
      if (!entry) {
        entry = buildWeaponModel(id, assets, theme);
        this.humanoid.weaponMount.add(entry.group);
        this._weaponModels.set(id, entry);
      }
      for (const [key, e] of this._weaponModels) e.group.visible = key === id;
      this.weapon = entry.group;
      this._muzzleLocal.set(entry.muzzle[0], entry.muzzle[1], entry.muzzle[2]);
      this._weaponGlow = entry.glow ?? null;
    }

    const def = this.weaponDef;
    this.magazine = def.magazine;
    this.accuracy = clamp(def.accuracy + (this.rnd() - 0.5) * 0.08, 0.3, 0.92);
    this.preferredRange = def.preferredMin + this.rnd() * (def.preferredMax - def.preferredMin);
    /**
     * Brawler or shooter. A brawler has to *commit* - it runs flat out and does
     * not take cover, because a melee attacker that jogs and hides behind a
     * crate is just a shooter that cannot shoot. This is the flag the movement
     * code reads; the reach comes from the weapon table.
     */
    this.isMelee = isMelee(def.id);
    this._resetWeaponState();
  }

  /** Build every model this character could draw, so none compiles mid-fight. */
  prebuildWeapons() {
    const pool = this.weaponPool;
    if (!pool || !this.manager?.assets) return;
    const keep = this.weaponId;
    for (const id of pool) {
      if (this._weaponModels.has(id)) continue;
      const entry = buildWeaponModel(id, this.manager.assets, this.theme);
      entry.group.visible = false;
      this.humanoid.weaponMount.add(entry.group);
      this._weaponModels.set(id, entry);
    }
    for (const [key, e] of this._weaponModels) e.group.visible = key === keep;
  }

  _resetWeaponState() {
    this.ammo = this.magazine;
    this.reloadTimer = 0;
    this.burstLeft = 0;
    this.burstTimer = 0;
    this.telegraph = 0;
    this.fireCooldown = 0;
    this.burstsSinceReload = 0;
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

  /** Fresh body, fresh loadout - unless the loadout is the character. */
  onRespawned() {
    if (this.weaponFixed) return;
    this.selectWeapon();
  }

  onDied() {
    if (this.weapon) {
      // Drop the rifle out of the hand so the corpse is not clutching it.
      this.weapon.visible = false;
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
    if (this.awareness > 0.5) {
      // One weapon per encounter: the draw happens as the character notices
      // something, so a player who fights the same patrol twice does not fight
      // the same loadout twice. Skipped for a character whose weapon is its
      // identity - see `weaponFixed` in the constructor.
      if (!this.weaponFixed) this.selectWeapon();
      this.setState('SUSPICIOUS');
    }
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
      if (this.position.distanceTo(_v1) > 6) this.nav.setTargetIfNew(_v1, 0.6);
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
    // A shooter advances at a working pace because it is trading fire on the
    // way in. A brawler has nothing to trade until it arrives, so it runs.
    this.desiredSpeed = CONFIG.npc.runSpeed * (this.isMelee ? 1.0 : 0.62);
    this.faceOverride = this.hasLastKnown ? this.lastKnownTarget : player.position;
    this._lookTarget = player.position;
    this.animator.setAimTarget(this._aimPoint());

    const dist = this.targetDistance;

    // --- movement: hold the preferred band and keep strafing ---------
    //
    // `nav.blocked` is a level, not an event. Testing it directly flipped the
    // strafe direction on *every frame* the character was against something, so
    // the side-step target snapped left/right at frame rate and the character
    // stood there vibrating. Only the rising edge turns it around, and the
    // timer is re-armed with it so a wall cannot force a flip more often than a
    // deliberate change of direction would.
    this.strafeTimer -= dt;
    const blockedEdge = this.nav.blocked && !this._wasBlocked;
    this._wasBlocked = this.nav.blocked;
    if (this.strafeTimer <= 0 || blockedEdge) {
      this.strafeDir *= -1;
      this.strafeTimer = 1.3 + this.rnd() * 2.2;
    }
    this.coverTimer -= dt;
    if (this.coverTimer <= 0 && this.manager?.requestCoverSlot(this)) {
      this.coverTimer = 1.6 + this.rnd();
      this.coverPoint = this._findCover(player);
    }

    if (this.coverPoint && this.position.distanceToSquared(this.coverPoint) > 1.2) {
      // A fixed destination: re-issuing it every step only served to clear
      // `nav.arrived`, so the character kept accelerating at a point it was
      // already standing on.
      this.nav.setTargetIfNew(this.coverPoint);
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
    // Brawlers do not break off to find a firing angle - there is no angle to
    // find, and a charger that keeps backing off to cover reads as a shooter
    // whose gun is broken. They stay committed and keep coming.
    if (this.isMelee) return;
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

  /**
   * Cadence for the drawn weapon.
   *
   * Everything here is per-weapon: how long the wind-up is, how many rounds a
   * burst has, how fast they leave, and how long the gap is afterwards. The
   * telegraph is the fairness knob - the harder the weapon hits, the longer the
   * character visibly holds still with it raised before anything happens.
   */
  _updateFiring(dt) {
    const def = this.weaponDef;
    if (this.reloadTimer > 0) {
      this.animator.setAiming(false);
      this._setTelegraphGlow(0);
      return;
    }
    this.animator.setAiming(true);
    if (this.ammo <= 0) {
      this._beginReload();
      return;
    }
    if (!this.losClear || this.targetDistance > def.range) {
      this.telegraph = 0;
      this._setTelegraphGlow(0);
      return;
    }
    // Telegraph: settle the aim before the first round of a burst.
    if (this.burstLeft <= 0) {
      if (this.fireCooldown > 0) return;
      this.telegraph += dt;
      this._setTelegraphGlow(clamp(this.telegraph / def.telegraph, 0, 1));
      if (this.telegraph < def.telegraph) return;
      this.telegraph = 0;
      this._setTelegraphGlow(0);
      const [lo, hi] = def.burst;
      this.burstLeft = lo + ((this.rnd() * (hi - lo + 1)) | 0);
      this.burstTimer = 0;
      this.burstsSinceReload++;
      // A one-shot weapon reloads (nocks, recharges) after every shot; a
      // magazine weapon reloads after a few bursts.
      const burstsPerMag = Math.max(1, Math.floor(def.magazine / Math.max(1, hi)));
      if (this.burstsSinceReload > burstsPerMag) {
        this._beginReload();
        return;
      }
    }
    this.burstTimer -= dt;
    if (this.burstTimer > 0) return;
    this.burstTimer = def.burstDelay;
    this.burstLeft--;
    this.ammo--;
    if (this.burstLeft <= 0) {
      const [clo, chi] = def.cooldown;
      this.fireCooldown = clo + this.rnd() * (chi - clo);
    }
    this._fire();
  }

  _beginReload() {
    this.reloadTimer = this.weaponDef.reload;
    this.ammo = this.magazine;
    this.burstsSinceReload = 0;
    this.burstLeft = 0;
    this.telegraph = 0;
    this._setTelegraphGlow(0);
  }

  /**
   * Wind the staff crystal up as the shot charges.
   *
   * A 21-point hit from across a courtyard has to announce itself, and a light
   * that swells for four fifths of a second is the most readable announcement
   * available without adding a real light to the scene - which would recompile
   * every material in view. Scaling an emissive mesh costs nothing.
   */
  _setTelegraphGlow(t) {
    const g = this._weaponGlow;
    if (!g) return;
    const s = 1 + t * 0.85;
    g.scale.set(s, s, s);
  }

  _fire() {
    const player = this.target;
    if (!player) return;
    // Muzzle sits at the business end of whatever is being carried.
    if (this.weapon) {
      this.weapon.updateWorldMatrix(true, false);
      this._muzzle.copy(this._muzzleLocal).applyMatrix4(this.weapon.matrixWorld);
    } else {
      this._muzzle.copy(this.headPosition);
    }
    _v1.copy(player.position);
    _v1.y += CONFIG.player.eyeHeight * 0.72;
    _v2.subVectors(_v1, this._muzzle);
    const dist = _v2.length() || 1;
    _v2.multiplyScalar(1 / dist);

    // Accuracy is a cone: 1.0 is perfect, the weapon's own accuracy scales the
    // miss. Long shots and moving while shooting both open it up, and each
    // weapon adds its own drift on top.
    const def = this.weaponDef;
    const spread =
      (1 - this.accuracy) * 0.062 * (0.7 + 0.3 * clamp(dist / def.range, 0, 1.4)) +
      def.aimDrift +
      (this.moveSpeed > 1.2 ? 0.012 : 0);
    _v3.set(this.rnd() - 0.5, this.rnd() - 0.5, this.rnd() - 0.5).multiplyScalar(spread);
    _v2.add(_v3).normalize();

    // Recoil scales with the round: a sidearm nudges, a staff shoves.
    this._recoil.copy(_v2).negate();
    this.animator.flinch(this._recoil, def.damage >= 20);
    const damage = rollDamage(def, this.rnd);
    this.lastAttackDamage = damage;
    this.manager?.npcFire(this, this._muzzle, _v2, damage, def.id);
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
      // Patrols route around the river rather than through it - see the note
      // in FriendlyNPC._pickWanderTarget.
      if (this.nav.isDeepWaterAt(x, z)) continue;
      const ground = this.physics.groundHeight(x, z, origin.y + 6, 14);
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
}
