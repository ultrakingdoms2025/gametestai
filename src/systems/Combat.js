import * as THREE from 'three';
import { CONFIG } from '../core/Config.js';
import { COLLISION_LAYER } from '../physics/Physics.js';
import { VFX } from './VFX.js';
import { DecalPool, DECAL } from './DecalPool.js';
import { WEAPON_STATS, statsFor, falloffFor, normaliseDamage } from './WeaponStats.js';

/**
 * Hitscan combat resolution and every visual that hangs off it.
 *
 * ── Where damage numbers come from ─────────────────────────────────────────
 * `src/systems/WeaponStats.js` is now the single source of truth for every
 * player weapon. This file reads it directly for hitscan, and rescales the
 * figures projectile weapons hand to `applyNPCDamage` onto the same table (see
 * `normaliseDamage`), so *every* point of damage the player deals is traceable
 * to one line in one file. `CONFIG.weapon.machinegun` still supplies the purely
 * cosmetic values - spread cone, muzzle velocity for tracer pacing - which are
 * feel, not balance.
 *
 * Responsibilities:
 *  - Resolve the player's machine gun against NPCs *and* world geometry, with
 *    the nearest hit winning so a hostile behind cover is genuinely safe.
 *  - Headshot detection, distance falloff, damage events.
 *  - NPC return fire: line of sight, aim error, ray-vs-capsule against the
 *    player, damage and death/respawn.
 *  - Tracers, surface-specific impact bursts, bullet-hole decals, muzzle smoke,
 *    hit flashes and screen shake requests.
 *
 * Screen shake note: this system only *emits* `camera:shake`. It never touches
 * `engine.camera` itself, because the Player owns the camera transform and
 * applying the shake in two places would double it.
 */

const _origin = new THREE.Vector3();
const _dir = new THREE.Vector3();
const _shotDir = new THREE.Vector3();
const _muzzle = new THREE.Vector3();
const _right = new THREE.Vector3();
const _upv = new THREE.Vector3();
const _bx = new THREE.Vector3();
const _by = new THREE.Vector3();
const _target = new THREE.Vector3();
const _capA = new THREE.Vector3();
const _capB = new THREE.Vector3();
const _segU = new THREE.Vector3();
const _w0 = new THREE.Vector3();
const _pA = new THREE.Vector3();
const _pB = new THREE.Vector3();
const _tmp = new THREE.Vector3();
const _normal = new THREE.Vector3();
const _hitPoint = new THREE.Vector3();
const _backOrigin = new THREE.Vector3();

const WORLD_UP = new THREE.Vector3(0, 1, 0);
const WORLD_X = new THREE.Vector3(1, 0, 0);
const TAU = Math.PI * 2;

/**
 * Fallback respawn delay. Deliberately a touch longer than the Player's own
 * timer so this acts as a safety net rather than racing it - whichever fires
 * first, `player:respawned` cancels the other.
 */
const RESPAWN_DELAY = 3.4;

const FLASH_TIME = 0.14;

/**
 * Tracers are drawn at half muzzle velocity. At the real 620 m/s a round
 * crosses a 40 m plaza in four frames and reads as a single flicker; every
 * shipped shooter slows tracers for exactly this reason.
 */
const TRACER_SPEED_SCALE = 0.5;

/* ------------------------------------------------------------------ */
/* Surface classification                                              */
/* ------------------------------------------------------------------ */

const SURFACE_RULES = [
  ['flesh', ['flesh', 'skin', 'npc', 'body', 'character']],
  ['glass', ['glass', 'window', 'pane', 'canopy', 'visor']],
  ['metal', ['metal', 'steel', 'hull', 'panel', 'grate', 'trim', 'iron', 'alloy',
    'pipe', 'gantry', 'catwalk', 'chrome', 'rail', 'girder', 'plate', 'chairlift']],
  ['wood', ['wood', 'plank', 'beam', 'timber', 'crate', 'barrel', 'fence', 'stall', 'cart']],
  ['stone', ['stone', 'cobble', 'castle', 'rock', 'brick', 'masonry', 'granite', 'keep']],
  ['concrete', ['concrete', 'asphalt', 'road', 'skatepark', 'tarmac', 'pavement',
    'kerb', 'curb', 'bowl', 'ledge', 'bleacher']],
  ['snow', ['snow', 'piste', 'ice', 'mogul']],
  ['water', ['water', 'pool', 'river', 'sea', 'lake']],
  ['dirt', ['dirt', 'ground', 'grass', 'sand', 'mud', 'earth', 'thatch', 'hay',
    'field', 'terrain', 'turf']],
  ['soft', ['rubber', 'plastic', 'fabric', 'banner', 'cloth', 'carpet', 'net',
    'tarp', 'track', 'court', 'mat']],
];

/** Material library key used to sample a plausible dust colour per surface. */
const SURFACE_MATERIAL_KEY = {
  metal: 'metal.panel',
  concrete: 'concrete.wall',
  stone: 'stone.castle',
  wood: 'wood.plank',
  dirt: 'dirt.ground',
  snow: 'snow.piste',
  glass: 'glass.window',
  water: 'water.pool',
  soft: 'fabric.banner',
};

const SURFACE_FALLBACK_TINT = {
  metal: 0x9aa0aa,
  concrete: 0xb4b0a6,
  stone: 0xa8a49a,
  wood: 0xb08a5c,
  dirt: 0x9c8767,
  snow: 0xe8eef4,
  glass: 0xcfe4ee,
  water: 0xbcd6e2,
  soft: 0xa9a6a0,
};

const WHITE = new THREE.Color(0xffffff);

const DECAL_FOR_SURFACE = {
  metal: DECAL.METAL,
  wood: DECAL.WOOD,
  concrete: DECAL.HARD,
  stone: DECAL.HARD,
  glass: DECAL.HARD,
  soft: DECAL.HARD,
  dirt: DECAL.HARD,
  snow: DECAL.HARD,
};

export class CombatSystem {
  /**
   * @param {{scene:THREE.Scene, engine:any, physics:any, bus:any, materials:any,
   *          input?:any, player:any, npcManager:any}} ctx
   */
  constructor({ scene, engine, physics, bus, materials, input, player, npcManager }) {
    this.scene = scene;
    this.engine = engine;
    this.physics = physics;
    this.bus = bus;
    this.materials = materials;
    this.input = input;
    this.player = player;
    this.npcManager = npcManager;

    this.vfx = new VFX({ scene, engine, bus });
    this.decals = new DecalPool(scene, engine?.renderer, 120);

    this._shotIndex = 0;
    this._npcShotIndex = 0;
    this._playerDead = false;
    this._respawnTimer = 0;
    this._playerDamageMul = 1;
    /** Seconds of `engine.simElapsed`. @see _buffNow */
    this._playerDamageBoostUntil = 0;
    /** Set by main.js once MountManager exists; Dragon Fire tiers read through it. */
    this.mounts = null;

    /* Re-entrancy guards: the Player/NPC modules may already emit the damage
     * events themselves. We watch for that and only emit as a fallback, so the
     * HUD never receives a doubled hit. */
    this._sawPlayerDamaged = false;
    this._sawPlayerDied = false;
    this._sawNpcDamaged = false;
    this._sawNpcKilled = false;

    /** @type {Map<any, THREE.Material[]>} exclusive flashable materials per NPC */
    this._flashMats = new Map();
    /** @type {Map<THREE.Material, number>|null} material -> owning NPC count */
    this._materialOwners = null;
    /** @type {Array<{mat:THREE.Material,r:number,g:number,b:number,i:number,t:number}>} */
    this._flashes = [];

    /** @type {Map<string, THREE.Color>} */
    this._tints = new Map();
    /** @type {Map<string, string>} */
    this._surfaceCache = new Map();

    this._offs = [];
    this._bind();
  }

  /* ---------------------------------------------------------------- */
  /* Wiring                                                            */
  /* ---------------------------------------------------------------- */

  _bind() {
    const on = (type, fn) => this._offs.push(this.bus.on(type, fn));

    on('weapon:fired', (e) => this._onWeaponFired(e));

    // Integration path A for hostiles: fire-and-forget event.
    on('npc:fire', (e) => {
      if (!e || !e.npc) return;
      this.npcShoot(e.npc, e.origin, e.direction, e.damage, e.accuracy);
    });

    // The same path for a beast's contact attack. The AI has already decided
    // that the volume touched something; everything that happens next is ours.
    on('beast:maul', (e) => this.resolveMaul(e));

    on('player:damaged', () => { this._sawPlayerDamaged = true; });
    on('npc:damaged', () => { this._sawNpcDamaged = true; });
    on('npc:killed', () => { this._sawNpcKilled = true; });

    on('player:died', () => {
      this._sawPlayerDied = true;
      if (!this._playerDead) {
        this._playerDead = true;
        this._respawnTimer = CONFIG.player.respawnDelay ?? RESPAWN_DELAY;
      }
    });
    on('player:respawned', () => {
      this._playerDead = false;
      this._respawnTimer = 0;
    });

    // NPC rosters change, so the shared-material analysis has to be rebuilt.
    on('npc:spawned', () => this._invalidateNPCCaches());
    on('npc:despawned', () => this._invalidateNPCCaches());

    on('world:changing', () => this.reset());
    on('world:changed', () => this.reset());
  }

  _invalidateNPCCaches() {
    this._materialOwners = null;
    this._flashMats.clear();
  }

  /* ---------------------------------------------------------------- */
  /* Player weapon                                                     */
  /* ---------------------------------------------------------------- */

  _onWeaponFired(evt) {
    if (!evt || !evt.origin || !evt.direction) return;
    if (this.player?.isDead) return;
    // Projectile weapons never raise `weapon:fired`, but an explicit opt-out
    // means a future one cannot be silently resolved as a hitscan round too.
    if (evt.hitscan === false) return;

    // Cosmetic tuning still lives in CONFIG; every damage figure comes from
    // WEAPON_STATS via `stats`.
    const gun = CONFIG.weapon.machinegun;
    const weaponId = typeof evt.weaponId === 'string' ? evt.weaponId : 'machinegun';
    const stats = statsFor(weaponId) ?? WEAPON_STATS.machinegun;

    _origin.copy(evt.origin);
    _dir.copy(evt.direction).normalize();

    const spread = Number.isFinite(evt.spread) ? evt.spread : gun.spreadBase;
    this._coneSpread(_dir, spread, _shotDir);

    const range = stats.range;
    const shot = ++this._shotIndex;

    // NPCs first: their hit distance caps the (much more expensive) world cast,
    // and a world hit inside that distance still wins, so cover works.
    let npcHit = null;
    try {
      npcHit = this.npcManager?.raycastNPCs?.(_origin, _shotDir, range) ?? null;
    } catch (err) {
      npcHit = null;
    }
    const npcDist = npcHit
      ? (Number.isFinite(npcHit.distance) ? npcHit.distance : _origin.distanceTo(npcHit.point))
      : Infinity;

    const worldHit = this.physics.raycast(
      _origin,
      _shotDir,
      Math.min(range, npcDist),
      COLLISION_LAYER.WORLD
    );

    const hitDistance = worldHit ? worldHit.distance : Math.min(npcDist, range);

    /* --- tracer + muzzle smoke ------------------------------------- */
    // The Weapon publishes its real barrel tip as an extra; fall back to an
    // estimate from the camera basis if a different weapon ever omits it.
    if (evt.muzzle && Number.isFinite(evt.muzzle.x)) _muzzle.copy(evt.muzzle);
    else this._muzzlePosition(_origin, _shotDir, _muzzle);

    // Roughly one round in three is a tracer, matching real belt loading.
    if (shot % 3 === 0) {
      this.vfx.tracer(
        _muzzle,
        _shotDir,
        Math.max(2, hitDistance),
        gun.muzzleVelocity * TRACER_SPEED_SCALE
      );
    }
    // Sparse: the Weapon viewmodel has its own close-range puff, so this is the
    // world-space smoke that lingers behind after the burst.
    if (shot % 6 === 0) this.vfx.muzzleSmoke(_muzzle, _shotDir);

    // A small kick on every shot; the Player consumes the event.
    this.bus.emit('camera:shake', { amount: 0.035, duration: 0.07 });

    /* --- resolve ---------------------------------------------------- */
    if (worldHit) {
      this._resolveWorldHit(worldHit);
      return;
    }
    if (npcHit) {
      this._resolveNPCHit(npcHit, npcDist, _shotDir, stats);
      return;
    }
    // Clean miss into open space - nothing further to do.
  }

  _resolveWorldHit(hit) {
    const surface = this._surfaceOf(hit.collider);
    _normal.copy(hit.normal);
    _hitPoint.copy(hit.point);
    const tint = this._tintFor(surface);

    this.vfx.impact(_hitPoint, _normal, surface, tint, 1);
    this._stampDecal(_hitPoint, _normal, surface);

    // Clone into the payload: `_hitPoint`/`_normal` are shared scratch and would
    // be rewritten by the next round before a listener could read them.
    this.bus.emit('weapon:hit', {
      point: _hitPoint.clone(),
      normal: _normal.clone(),
      isNPC: false,
      isHeadshot: false,
      damage: 0,
    });
  }

  /**
   * @param {any} npcHit result from `npcManager.raycastNPCs`
   * @param {number} distance metres from the muzzle
   * @param {THREE.Vector3} dir normalised shot direction
   * @param {any} stats the firing weapon's `WEAPON_STATS` block
   */
  _resolveNPCHit(npcHit, distance, dir, stats) {
    const npc = npcHit.npc;
    if (!npc || npc.isDead) return;

    const isHeadshot = npcHit.isHeadshot === true;
    const falloff = falloffFor(stats.id, distance);
    const damage = stats.damage * falloff * (isHeadshot ? stats.headshotMul : 1);

    _hitPoint.copy(npcHit.point ?? npc.position);
    // NPC raycasts do not report a surface normal, so face the spray back along
    // the incoming round - that is where the camera is.
    _normal.copy(dir).negate();

    this.vfx.bloodImpact(_hitPoint, _normal, dir);
    this._bloodSplatterBehind(_hitPoint, dir);

    const point = _hitPoint.clone();
    this.bus.emit('weapon:hit', {
      point,
      normal: _normal.clone(),
      isNPC: true,
      isHeadshot,
      damage,
    });

    const res = this.applyNPCDamage(npc, damage, {
      isHeadshot,
      sourcePosition: _hitPoint,
      weaponId: stats.id,
      byPlayer: true,
      // Already expressed in WEAPON_STATS units - do not rescale it again.
      statsApplied: true,
    });
    this.bus.emit('combat:hitmarker', {
      isHeadshot,
      isKill: res.killed,
      damage,
      point,
    });
  }

  /** Look for a wall behind the target and paint an exit splatter on it. */
  _bloodSplatterBehind(point, dir) {
    _backOrigin.copy(point).addScaledVector(dir, 0.12);
    const behind = this.physics.raycast(_backOrigin, dir, 5.5, COLLISION_LAYER.WORLD);
    if (!behind) return;
    this.decals.spawn(behind.point, behind.normal, 0.34 + Math.random() * 0.34, DECAL.BLOOD, 26);
  }

  /**
   * The single route by which an NPC takes damage from the player.
   *
   * Hitscan (`_resolveNPCHit`) and every projectile in `ProjectileSystem` come
   * through here, which is what guarantees `npc:damaged` and `npc:killed` are
   * emitted exactly once per event no matter which weapon dealt the blow. The
   * Economy keys credits off `npc:killed.byPlayer`, so a second emission - or a
   * missing `byPlayer` - would corrupt the player's balance rather than merely
   * duplicating a HUD line.
   *
   * Damage is republished onto `WEAPON_STATS` on the way through unless the
   * caller sets `statsApplied`. Projectile weapons are owned by other modules
   * and still compute their own figures from their own charge curves, so this
   * is the choke point that makes the table authoritative for them too - the
   * curve is preserved, the headline number is not. See `normaliseDamage`.
   *
   * @param {any} npc target
   * @param {number} amount damage with the caller's own multipliers applied
   * @param {{isHeadshot?:boolean, sourcePosition?:THREE.Vector3,
   *          weaponId?:string, byPlayer?:boolean, flash?:boolean,
   *          statsApplied?:boolean, source?:any}} [opts]
   * @returns {{applied:number, health:number, killed:boolean}}
   */
  applyNPCDamage(npc, amount, opts = {}) {
    if (!npc || !(amount > 0) || npc.isDead === true) {
      return { applied: 0, health: npc?.health ?? 0, killed: false };
    }

    const isHeadshot = opts.isHeadshot === true;
    const weaponId = opts.weaponId ?? 'unknown';
    const byPlayer = opts.byPlayer !== false;

    if (opts.statsApplied !== true) {
      amount = normaliseDamage(weaponId, amount, { isHeadshot });
      if (!(amount > 0)) {
        return { applied: 0, health: npc.health ?? 0, killed: false };
      }
    }
    if (byPlayer) amount *= this._playerDamageMul;
    if (byPlayer && weaponId === 'fireball') amount *= this.mountFireMul;

    const wasDead = npc.isDead === true;
    const before = Number.isFinite(npc.health) ? npc.health : 0;
    this._sawNpcDamaged = false;
    this._sawNpcKilled = false;

    if (opts.flash !== false) this._flashNPC(npc);

    /*
     * The NPC keeps `source` as `lastDamageSource` and reads `.position` off it
     * later to pick a threat, so it must be a live object with a stable
     * position - never a pooled scratch vector. The player is exactly that, and
     * for a player-owned projectile the player is also the correct attacker.
     */
    const source = byPlayer ? this.player : (opts.source ?? null);

    try {
      npc.applyDamage?.(amount, isHeadshot, source);
    } catch (err) {
      console.warn('[Combat] npc.applyDamage threw:', err);
    }

    const health = Number.isFinite(npc.health) ? npc.health : 0;
    const applied = Math.max(0, before - health);

    if (!this._sawNpcDamaged) {
      /* `byPlayer` rides along for the same reason it rides on `npc:killed`
       * below: `resolveMaul` routes a beast savaging a villager through this
       * very choke point, and without the flag a `defend` quest step counts
       * those hits. Quest 20's "defend Wry Tam x8" was clearable by standing
       * back and letting a wolf do the work. Economy already honoured the
       * flag on the kill event; QuestSystem could not honour it on damage
       * because damage never carried it. */
      this.bus.emit('npc:damaged', { npc, amount, health, isHeadshot, weaponId, byPlayer });
    }

    const killed = npc.isDead === true && !wasDead;
    if (killed) {
      if (!this._sawNpcKilled) this.bus.emit('npc:killed', { npc, byPlayer, weaponId });
      this.bus.emit('hud:notify', {
        text: `Eliminated ${npc.name ?? 'hostile'}${isHeadshot ? '  • HEADSHOT' : ''}`,
        tone: 'kill',
      });
    }
    return { applied, health, killed };
  }

  /**
   * Surface-correct impact burst for a non-bullet hit (arrows, debris).
   * Exposed so other systems get the same material response the machine gun
   * gets without duplicating the classification table.
   *
   * @param {THREE.Vector3} point
   * @param {THREE.Vector3} normal
   * @param {any} collider the collider that was hit, or null
   * @param {number} [intensity] 0..1 scale on particle counts
   * @param {boolean} [decal] stamp a bullet hole as well
   */
  /**
   * Blood spray for a non-bullet hit on a body (melee, thrown weapons).
   *
   * Exposed because the surface response for flesh is deliberately different
   * from `impactFX` - no decal on the target, no dust tint - and every weapon
   * that draws blood should draw the same blood.
   *
   * @param {THREE.Vector3} point world-space contact point
   * @param {THREE.Vector3} normal direction the spray faces (toward the camera)
   * @param {THREE.Vector3} [travelDir] direction the blow was travelling
   */
  bloodFX(point, normal, travelDir = null) {
    try {
      this.vfx.bloodImpact(point, normal, travelDir);
      if (travelDir) this._bloodSplatterBehind(point, travelDir);
    } catch (err) {
      // Best-effort decoration: it must never break the frame loop.
      console.warn('[Combat] bloodFX failed:', err);
    }
  }

  impactFX(point, normal, collider, intensity = 1, decal = true) {
    try {
      const surface = this._surfaceOf(collider);
      this.vfx.impact(point, normal, surface, this._tintFor(surface), intensity);
      if (decal) this._stampDecal(point, normal, surface);
    } catch (err) {
      // Best-effort decoration: it must never be able to break the frame loop.
      console.warn('[Combat] impactFX failed:', err);
    }
  }

  /* ---------------------------------------------------------------- */
  /* NPC return fire                                                   */
  /* ---------------------------------------------------------------- */

  /**
   * Fire one NPC round at the player. Safe to call from AI code directly; the
   * `npc:fire` event routes here too.
   *
   * @param {any} npc the shooter
   * @param {THREE.Vector3} origin muzzle position in world space
   * @param {THREE.Vector3} [direction] intended aim direction; defaults to the player
   * @param {number} [damage] defaults to `CONFIG.npc.attackDamage`
   * @param {number} [accuracy] 0..1, defaults to `CONFIG.npc.accuracy`
   * @returns {boolean} true if the round actually damaged the player
   */
  npcShoot(npc, origin, direction, damage, accuracy) {
    const player = this.player;
    if (!npc || !origin || !player) return false;
    if (npc.isDead || player.isDead) return false;

    const cfg = CONFIG.npc;
    const dmg = Number.isFinite(damage) ? damage : cfg.attackDamage;
    const acc = Number.isFinite(accuracy) ? accuracy : cfg.accuracy;

    const height = Number.isFinite(player.height) ? player.height : CONFIG.player.height;
    const radius = CONFIG.player.radius;

    // Aim at centre mass rather than the feet reference point.
    _target.copy(player.position);
    _target.y += height * 0.62;
    _dir.subVectors(_target, origin);
    const distance = _dir.length();
    if (distance < 0.2 || distance > cfg.sightRange * 1.6) return false;
    _dir.multiplyScalar(1 / distance);

    // Line of sight, stopping short of the player so their own capsule cannot
    // register as cover.
    const blocker = this.physics.raycast(
      origin,
      _dir,
      Math.max(0.1, distance - radius - 0.15),
      COLLISION_LAYER.WORLD
    );
    if (blocker) {
      // Still show the round smacking into the cover: that is the player's cue
      // that they are being shot at.
      this._npcTracer(origin, _dir, blocker.distance, true);
      const surface = this._surfaceOf(blocker.collider);
      this.vfx.impact(blocker.point, blocker.normal, surface, this._tintFor(surface), 0.7);
      this._stampDecal(blocker.point, blocker.normal, surface);
      return false;
    }

    // The caller's aim direction is blended in, not obeyed: it models the NPC's
    // turret lagging behind a strafing player, but a stale value must never be
    // able to make hostiles harmless.
    if (direction) _dir.lerp(_tmp.copy(direction).normalize(), 0.2).normalize();

    /*
     * Aim error is expressed in *metres at the target*, not as a fixed cone.
     * A cone makes hostiles infallible at 5 m and useless at 30 m, because hit
     * probability then falls off with the square of the range. Scattering
     * around the target in world units - growing only mildly with distance -
     * gives a curve that plays well at every range and makes CONFIG.npc.accuracy
     * mean something a designer can reason about.
     */
    const miss = (1 - Math.min(1, Math.max(0, acc))) * (0.95 + distance * 0.025);
    _target.copy(origin).addScaledVector(_dir, distance);
    if (miss > 0) {
      const ref = Math.abs(_dir.y) > 0.94 ? WORLD_X : WORLD_UP;
      _bx.crossVectors(ref, _dir).normalize();
      _by.crossVectors(_dir, _bx);
      const rr = Math.sqrt(Math.random()) * miss;
      const aa = Math.random() * TAU;
      _target.addScaledVector(_bx, Math.cos(aa) * rr).addScaledVector(_by, Math.sin(aa) * rr);
    }
    _shotDir.subVectors(_target, origin).normalize();

    _capA.copy(player.position);
    _capA.y += radius;
    _capB.copy(player.position);
    _capB.y += Math.max(radius + 0.05, height - radius);

    const t = rayCapsule(origin, _shotDir, _capA, _capB, radius);
    if (t >= 0 && t <= distance + radius * 2) {
      this._npcTracer(origin, _shotDir, t, true);
      const applied = this._damagePlayer(dmg, origin, npc.id ?? null);
      // No blood if the round was absorbed by spawn invulnerability.
      if (applied > 0) {
        _hitPoint.copy(origin).addScaledVector(_shotDir, t);
        this.vfx.bloodImpact(_hitPoint, _tmp.copy(_shotDir).negate(), null);
      }
      return applied > 0;
    }

    // Miss: carry the round on into the world so the player sees near-misses.
    const strayHit = this.physics.raycast(origin, _shotDir, cfg.sightRange * 1.6, COLLISION_LAYER.WORLD);
    this._npcTracer(origin, _shotDir, strayHit ? strayHit.distance : 60, false);
    if (strayHit) {
      const surface = this._surfaceOf(strayHit.collider);
      this.vfx.impact(strayHit.point, strayHit.normal, surface, this._tintFor(surface), 0.75);
      this._stampDecal(strayHit.point, strayHit.normal, surface);
    }
    return false;
  }

  /* ---------------------------------------------------------------- */
  /* Beast maul                                                        */
  /* ---------------------------------------------------------------- */

  /**
   * A beast's claws or jaws connected.
   *
   * This is the only place a maul turns into consequences, and it is
   * deliberately the same shape as `npcShoot`: the AI owns "did it hit", this
   * owns damage, feedback and everything the player feels. Against an NPC it
   * routes through `applyNPCDamage` - the single choke point that guarantees
   * `npc:damaged` / `npc:killed` fire exactly once - with `byPlayer: false`, so
   * a wolf eating a villager cannot pay the player for it.
   *
   * Against the player it is five things, in the order the player perceives
   * them: the hit, the shove, the view kick, the wound, the mark on the wall.
   *
   * @param {{beast:any, target:any, isPlayer:boolean, damage:number,
   *          origin:THREE.Vector3, direction:THREE.Vector3, def:any}} e
   * @returns {number} damage that actually landed
   */
  resolveMaul(e) {
    if (!e?.beast || !e.target || !(e.damage > 0)) return 0;
    const def = e.def ?? {};

    _hitPoint.copy(e.origin);
    _dir.copy(e.direction).normalize();

    if (!e.isPlayer) {
      const res = this.applyNPCDamage(e.target, e.damage, {
        isHeadshot: false,
        weaponId: 'maul',
        byPlayer: false,
        source: e.beast,
        // A beast's damage is authored in `BeastSpecies`, not in WEAPON_STATS;
        // re-normalising it onto a player weapon's curve would be nonsense.
        statsApplied: true,
      });
      this.bloodFX(_hitPoint, _tmp.copy(_dir).negate(), _dir);
      this._clawDecalBehind(e.target.position, _dir);
      return res.applied;
    }

    const player = this.player;
    if (!player || player.isDead) return 0;

    const applied = this._damagePlayer(e.damage, e.origin, e.beast.id ?? null);
    // Absorbed by spawn invulnerability: no shove, no blood, no wound. The
    // player has to be able to trust that "invulnerable" means it.
    if (applied <= 0) return 0;

    /* --- knockback ---
     * Straight out along the blow, resolved by the player's own capsule solver
     * - see `Player.applyImpulse` for why it can never push anybody through a
     * wall. */
    if (typeof player.applyImpulse === 'function') {
      _tmp.set(_dir.x * (def.knockback ?? 5), def.knockUp ?? 1.5, _dir.z * (def.knockback ?? 5));
      player.applyImpulse(_tmp);
    }

    /* --- camera kick ---
     * Directional, and distinct from `camera:shake`: the view snaps up and
     * rolls AWAY from the side the blow came from, which tells the player where
     * the animal is even if they were not looking at it. */
    if (typeof player.applyViewKick === 'function') {
      const kick = def.viewKick ?? 0.12;
      // Sign the roll off the cross product of the blow and world up, so a hit
      // from the left and a hit from the right do not feel the same.
      const side = Math.sign(_dir.x * Math.sin(player.yaw ?? 0) + _dir.z * Math.cos(player.yaw ?? 0)) || 1;
      player.applyViewKick(kick * 2.6, kick * 0.5 * side, kick * 1.4 * side);
    }

    /* --- bleed ---
     * Short, and it REFRESHES rather than stacks - see `Player.applyBleed`. */
    if (typeof player.applyBleed === 'function' && def.bleedRate > 0) {
      player.applyBleed(def.bleedRate, def.bleedTime ?? 3, e.beast.id ?? null);
    }

    /* --- marks --- */
    this.vfx.bloodImpact(_hitPoint, _tmp.copy(_dir).negate(), _dir);
    this._clawDecalBehind(player.position, _dir);
    this.bus.emit('combat:maul', {
      beast: e.beast,
      species: e.beast.species ?? null,
      damage: applied,
      point: _hitPoint.clone(),
    });
    return applied;
  }

  /**
   * Rake a claw mark onto whatever is behind the target.
   *
   * The same trick `_bloodSplatterBehind` uses, and for the same reason: the
   * mark cannot go on the victim - they move, and there is nothing to project
   * onto - so it goes on the wall or the ground behind them, which is where a
   * real one would end up anyway.
   */
  _clawDecalBehind(position, dir) {
    _backOrigin.copy(position);
    _backOrigin.y += 1.0;
    const behind = this.physics.raycast(_backOrigin, dir, 4.0, COLLISION_LAYER.WORLD);
    if (behind) {
      this.decals.spawn(behind.point, behind.normal, 0.55 + Math.random() * 0.4, DECAL.CLAW, 30);
      return;
    }
    /* No wall - so use the floor, which is always there.
     *
     * This used to return, and returning meant the claw mark never appeared
     * anywhere a bear or a wolf actually lives. The horizontal probe needs a
     * `COLLISION_LAYER.WORLD` collider within 4 m of chest height, and deep
     * woodland has none: the trees are instanced and carry no colliders, and
     * twenty-four bearings probed around a bear out to 8 m found nothing to
     * hit. Three full mauls in the open stamped zero decals while the blood,
     * the view kick, the knockback and the bleed all fired correctly - so the
     * one mark that persists after the fight, and the only evidence left that
     * it happened, was the one thing that never rendered.
     *
     * A rake that misses the wall behind you does not stop existing; it ends up
     * in the dirt. The terrain heightfield is a WORLD collider under every
     * point of the map, so a short downward cast just past the victim always
     * has an answer - and where there IS a wall the original behaviour is
     * untouched, because that branch is taken first.
     */
    const gx = position.x + dir.x * 1.3;
    const gz = position.z + dir.z * 1.3;
    /* From head height, and only far enough down to find the floor the fight is
     * happening on. A longer drop would put the mark on the ground UNDER the
     * bridge or the jetty the player is standing on. */
    const y = this.physics.groundHeight(gx, gz, position.y + 1.8, 4.5);
    if (y === null) return;
    _backOrigin.set(gx, y, gz);
    this.decals.spawn(_backOrigin, WORLD_UP, 0.55 + Math.random() * 0.4, DECAL.CLAW, 30);
  }

  _npcTracer(origin, dir, distance, force) {
    // Every second round unless the shot connected - incoming fire has to be
    // readable, but ten hostiles at 1.2 rps would otherwise be a light show.
    if (!force && ++this._npcShotIndex % 2 !== 0) return;
    this.vfx.tracer(
      origin,
      dir,
      Math.max(2, distance),
      CONFIG.weapon.machinegun.muzzleVelocity * TRACER_SPEED_SCALE * 0.8
    );
  }

  /**
   * Route damage through the Player and produce the feedback for it.
   * @returns {number} damage the Player actually accepted (0 while invulnerable)
   */
  _damagePlayer(amount, sourcePosition, sourceId) {
    const player = this.player;
    this._sawPlayerDamaged = false;
    this._sawPlayerDied = false;

    // Cloned once: the HUD keeps this to draw the damage-direction indicator,
    // and the shooter is free to move its muzzle vector on the next tick.
    const source = sourcePosition?.clone?.() ?? sourcePosition;

    const before = Number.isFinite(player.health) ? player.health : null;
    let returned;
    try {
      returned = player.applyDamage?.(amount, source, sourceId);
    } catch (err) {
      console.warn('[Combat] player.applyDamage threw:', err);
    }
    const after = Number.isFinite(player.health) ? player.health : null;

    /*
     * How much actually landed. The Player refuses damage during spawn
     * invulnerability, so trusting the requested amount would flash the HUD and
     * shake the camera for hits that never happened. Prefer the return value,
     * fall back to the health delta, and only then to the request.
     */
    let applied;
    if (Number.isFinite(returned)) applied = returned;
    else if (before !== null && after !== null) applied = before - after;
    else applied = amount;

    if (applied <= 0 && !this._sawPlayerDamaged) return 0;

    if (!this._sawPlayerDamaged) {
      this.bus.emit('player:damaged', {
        amount: applied,
        health: player.health ?? 0,
        maxHealth: player.maxHealth ?? CONFIG.player.maxHealth,
        sourcePosition: source,
      });
    }

    // Shake scales with the bite of the hit but is clamped so sustained fire
    // stays playable rather than nauseating.
    const shake = Math.min(0.5, 0.14 + applied * 0.012);
    this.bus.emit('camera:shake', { amount: shake, duration: 0.34 });

    if (player.isDead && !this._playerDead) {
      this._playerDead = true;
      this._respawnTimer = CONFIG.player.respawnDelay ?? RESPAWN_DELAY;
      if (!this._sawPlayerDied) this.bus.emit('player:died', { killerId: sourceId });
      this.bus.emit('camera:shake', { amount: 0.62, duration: 0.9 });
    }
    return applied;
  }

  /* ---------------------------------------------------------------- */
  /* Frame hooks                                                       */
  /* ---------------------------------------------------------------- */

  /** @param {number} dt fixed timestep seconds */
  fixedUpdate(dt) {
    // Safety net: catch deaths that did not come through npcShoot (falls, etc).
    if (this.player?.isDead && !this._playerDead) {
      this._playerDead = true;
      this._respawnTimer = CONFIG.player.respawnDelay ?? RESPAWN_DELAY;
      this.bus.emit('player:died', { killerId: null });
    }

    if (this._playerDead) {
      this._respawnTimer -= dt;
      if (this._respawnTimer <= 0) {
        this._respawnTimer = 0;
        this._playerDead = false;
        try {
          this.player?.respawn?.();
        } catch (err) {
          console.warn('[Combat] player.respawn threw:', err);
        }
      }
    }
  }

  /**
   * THE BUFF CLOCK: seconds of gameplay, from the engine.
   *
   * This used to be a private `_elapsed` accumulated by `update(dt)`, which
   * was correct - `update` only runs while gameplay simulates, so the boost
   * was already measured in play time rather than wall time - but it was a
   * clock with its own origin that nothing else could read. The HUD chip for
   * a firepower boost has to count down on the SAME seconds the boost expires
   * on, and `engine.simElapsed` is the one clock every timed consumable and
   * `systems/ActiveEffects.js` now share. Same rate as the old accumulator
   * (both stop when gameplay stops); the only thing that changed is that
   * somebody else can now read it.
   *
   * @returns {number} seconds
   */
  _buffNow() {
    return this.engine?.simElapsed ?? 0;
  }

  /** @param {number} dt frame seconds */
  update(dt) {
    if (this._buffNow() >= this._playerDamageBoostUntil) this._playerDamageMul = 1;
    this.vfx.update(dt);
    this.decals.update(dt);
    this._updateFlashes(dt);
  }

  /** Dragon Fire tiers: +15% fireball damage per tier while riding the dragon. */
  get mountFireMul() {
    const m = this.mounts;
    if (!m?.mounted || m.active?.id !== 'dragon') return 1;
    return 1 + 0.15 * Math.max(0, Number(m.active.fireTier) || 0);
  }

  boostPlayerDamage(multiplier, duration) {
    if (!(multiplier > 1) || !(duration > 0)) return false;
    this._playerDamageMul = Math.max(this._playerDamageMul, multiplier);
    this._playerDamageBoostUntil = Math.max(this._playerDamageBoostUntil, this._buffNow() + duration);
    return true;
  }

  /** Drop all transient combat state. Called on every world change. */
  reset() {
    this.vfx.clear();
    this.decals.clear();
    this._restoreAllFlashes();
    this._invalidateNPCCaches();
    this._shotIndex = 0;
    this._npcShotIndex = 0;
    this._playerDamageMul = 1;
    this._playerDamageBoostUntil = 0;
  }

  dispose() {
    for (const off of this._offs) off();
    this._offs.length = 0;
    this._restoreAllFlashes();
    this.vfx.dispose();
    this.decals.dispose();
  }

  /* ---------------------------------------------------------------- */
  /* Helpers                                                           */
  /* ---------------------------------------------------------------- */

  /**
   * Offset `dir` by a random point inside the spread cone.
   *
   * Sampled as sqrt(u) * tan(spread) so the distribution is uniform over the
   * disc; using two raw uniforms would bias every shot toward the crosshair and
   * make the spread stat lie.
   */
  _coneSpread(dir, spread, out) {
    out.copy(dir);
    if (!(spread > 0)) return out;

    const ref = Math.abs(dir.y) > 0.94 ? WORLD_X : WORLD_UP;
    _bx.crossVectors(ref, dir).normalize();
    _by.crossVectors(dir, _bx);

    const r = Math.sqrt(Math.random()) * Math.tan(spread);
    const a = Math.random() * TAU;
    out.addScaledVector(_bx, Math.cos(a) * r).addScaledVector(_by, Math.sin(a) * r);
    return out.normalize();
  }

  /** Approximate the viewmodel muzzle so tracers do not sprout from the eye. */
  _muzzlePosition(origin, dir, out) {
    const cam = this.engine?.camera;
    if (cam) {
      _right.setFromMatrixColumn(cam.matrixWorld, 0);
      _upv.setFromMatrixColumn(cam.matrixWorld, 1);
    } else {
      const ref = Math.abs(dir.y) > 0.94 ? WORLD_X : WORLD_UP;
      _right.crossVectors(dir, ref).normalize();
      _upv.crossVectors(_right, dir);
    }
    return out
      .copy(origin)
      .addScaledVector(dir, 0.85)
      .addScaledVector(_right, 0.2)
      .addScaledVector(_upv, -0.16);
  }

  _stampDecal(point, normal, surface) {
    if (surface === 'water' || surface === 'flesh') return;
    const cell = DECAL_FOR_SURFACE[surface] ?? DECAL.HARD;
    const size = surface === 'metal' ? 0.13 + Math.random() * 0.05 : 0.15 + Math.random() * 0.07;
    this.decals.spawn(point, normal, size, cell, 34);
  }

  /**
   * Work out what a collider is made of. Worlds may set
   * `userData.surface` explicitly; otherwise we infer from whatever naming they
   * did provide, which in practice is a material key like `metal.grate`.
   */
  _surfaceOf(collider) {
    const ud = collider?.userData;
    let hint = null;
    if (typeof ud === 'string') hint = ud;
    else if (ud) hint = ud.surface ?? ud.material ?? ud.kind ?? ud.type ?? ud.name ?? null;
    if (!hint || typeof hint !== 'string') return 'concrete';

    const cached = this._surfaceCache.get(hint);
    if (cached) return cached;

    const lower = hint.toLowerCase();
    let result = 'concrete';
    outer: for (const [surface, words] of SURFACE_RULES) {
      for (const w of words) {
        if (lower.includes(w)) {
          result = surface;
          break outer;
        }
      }
    }
    this._surfaceCache.set(hint, result);
    return result;
  }

  /** Dust/debris tint, sampled from the shared material library when possible. */
  _tintFor(surface) {
    let c = this._tints.get(surface);
    if (c) return c;

    c = new THREE.Color(SURFACE_FALLBACK_TINT[surface] ?? 0xb0aca4);
    const key = SURFACE_MATERIAL_KEY[surface];
    try {
      if (key && this.materials?.has?.(key)) {
        const mat = this.materials.get(key);
        if (mat?.color) c.copy(mat.color);
      }
    } catch (err) {
      /* material library not ready yet - the fallback is fine */
    }
    // Pulverised material is always lighter than the slab it came from.
    c.lerp(WHITE, 0.3);
    this._tints.set(surface, c);
    return c;
  }

  /* ------------------- NPC hit flash ------------------- */

  /**
   * Briefly light the NPC's own materials.
   *
   * NPC bodies frequently share one material across the whole roster, and
   * flashing a shared material would light up every hostile on the map. So we
   * count owners first and only touch materials that belong to exactly one NPC.
   * If the NPC module exposes `setHitFlash`, that always wins.
   */
  _flashNPC(npc) {
    if (typeof npc.setHitFlash === 'function') {
      try {
        npc.setHitFlash(1);
        return;
      } catch (err) {
        /* fall through to the material path */
      }
    }

    const mats = this._exclusiveMaterials(npc);
    for (let i = 0; i < mats.length; i++) {
      const mat = mats[i];
      let state = null;
      for (let k = 0; k < this._flashes.length; k++) {
        if (this._flashes[k].mat === mat) { state = this._flashes[k]; break; }
      }
      if (!state) {
        state = {
          mat,
          r: mat.emissive.r,
          g: mat.emissive.g,
          b: mat.emissive.b,
          i: Number.isFinite(mat.emissiveIntensity) ? mat.emissiveIntensity : 1,
          t: 0,
        };
        this._flashes.push(state);
      }
      state.t = FLASH_TIME;
    }
  }

  _exclusiveMaterials(npc) {
    let list = this._flashMats.get(npc);
    if (list) return list;

    if (!this._materialOwners) this._buildMaterialOwners();
    const owners = this._materialOwners;
    list = [];
    const root = npc.root;
    if (root?.traverse) {
      root.traverse((obj) => {
        const m = obj.material;
        if (!m) return;
        if (Array.isArray(m)) {
          for (const mm of m) if (mm?.emissive && owners.get(mm) === 1) list.push(mm);
        } else if (m.emissive && owners.get(m) === 1) {
          list.push(m);
        }
      });
    }
    this._flashMats.set(npc, list);
    return list;
  }

  _buildMaterialOwners() {
    const owners = new Map();
    const npcs = this.npcManager?.npcs ?? [];
    for (const npc of npcs) {
      const seen = new Set();
      npc.root?.traverse?.((obj) => {
        const m = obj.material;
        if (!m) return;
        if (Array.isArray(m)) for (const mm of m) { if (mm) seen.add(mm); }
        else seen.add(m);
      });
      for (const m of seen) owners.set(m, (owners.get(m) ?? 0) + 1);
    }
    this._materialOwners = owners;
  }

  _updateFlashes(dt) {
    for (let i = this._flashes.length - 1; i >= 0; i--) {
      const s = this._flashes[i];
      s.t -= dt;
      if (s.t <= 0) {
        s.mat.emissive.setRGB(s.r, s.g, s.b);
        s.mat.emissiveIntensity = s.i;
        this._flashes[i] = this._flashes[this._flashes.length - 1];
        this._flashes.pop();
        continue;
      }
      const k = s.t / FLASH_TIME;
      s.mat.emissive.setRGB(
        s.r + (1.0 - s.r) * k,
        s.g + (0.24 - s.g) * k,
        s.b + (0.2 - s.b) * k
      );
      s.mat.emissiveIntensity = s.i + (Math.max(s.i, 1) * 2.6 - s.i) * k;
    }
  }

  /** Restore every material we are currently tinting. */

  _restoreAllFlashes() {
    for (const s of this._flashes) {
      s.mat.emissive.setRGB(s.r, s.g, s.b);
      s.mat.emissiveIntensity = s.i;
    }
    this._flashes.length = 0;
  }
}

/**
 * Ray vs capsule (segment `a`-`b` swept by `radius`).
 *
 * Solved as a ray/segment closest-approach rather than an exact quadratic: the
 * approximation is sub-centimetre at these radii, allocation free, and about
 * three times cheaper than the cylinder-plus-caps form.
 *
 * @returns {number} distance along the ray, or -1 for a miss
 */
function rayCapsule(ro, rd, a, b, radius) {
  _segU.subVectors(b, a);
  _w0.subVectors(ro, a);

  const bb = rd.dot(_segU);
  const cc = _segU.dot(_segU);
  const dd = rd.dot(_w0);
  const ee = _segU.dot(_w0);
  const denom = cc - bb * bb; // rd is unit length, so aa == 1

  let tSeg;
  if (denom < 1e-8) {
    tSeg = cc > 1e-8 ? ee / cc : 0;
  } else {
    tSeg = (ee - bb * dd) / denom;
  }
  tSeg = Math.min(1, Math.max(0, tSeg));

  let tRay = tSeg * bb - dd;
  if (tRay < 0) tRay = 0;

  _pA.copy(ro).addScaledVector(rd, tRay);
  _pB.copy(a).addScaledVector(_segU, tSeg);
  const distSq = _pA.distanceToSquared(_pB);
  if (distSq > radius * radius) return -1;

  // Step back to the surface entry point so damage registers where the round
  // would actually break the silhouette.
  const back = Math.sqrt(Math.max(0, radius * radius - distSq));
  return Math.max(0, tRay - back);
}
