import { Weapon } from './Weapon.js';
import { FireballWeapon } from '../weapons/Fireball.js';
import { BowWeapon } from '../weapons/Bow.js';

/**
 * Holds the player's three weapons and decides which one is live.
 *
 * ── Why this drives the weapon rather than `Player` ────────────────────────
 * `Player` historically owned a single `Weapon` and drove it from
 * `_driveWeapon`. Rather than fight that, `Loadout` keeps `player._weapon`
 * pointed at whichever weapon is selected, so a `Player` that still drives its
 * weapon drives the right one, and a `Player` that no longer does is driven
 * from here instead. Both paths are safe because every weapon's `update()` is
 * idempotent within a frame (it early-outs on a repeated `elapsed`) and
 * `tryFire()` is gated on its own cooldown - so being called twice in one frame
 * costs nothing and changes nothing.
 *
 * That also means the aim/recoil/FOV contract `Player` relies on
 * (`aimProgress`, `getRecoilOffset()`, `resupply()`, `setEnabled()`) has to be
 * satisfied by all three weapons, which it is.
 *
 * Every weapon implements: `update`, `tryFire`, `releaseFire`, `reload`,
 * `onSelect`, `onDeselect`, `dispose`, and the getters `id name ammo reserve
 * magazine isReloading spread chargeLevel`.
 */

/** Slot order is also the 1/2/3 key order and the HUD's strip order. */
const SLOT_KEYS = ['Digit1', 'Digit2', 'Digit3'];

export class Loadout {
  /**
   * @param {{scene:THREE.Scene, camera:THREE.PerspectiveCamera, engine:any,
   *          physics:any, bus:any, materials:any, input:any, player:any,
   *          npcManager:any, projectiles:any, cameraRig?:any}} ctx
   */
  constructor({
    scene, camera, engine, physics, bus, materials, input,
    player, npcManager, projectiles, cameraRig,
  }) {
    this.scene = scene;
    this.camera = camera ?? engine?.camera;
    this.engine = engine;
    this.physics = physics;
    this.bus = bus;
    this.materials = materials;
    this.input = input;
    this.player = player;
    this.npcManager = npcManager;
    this.projectiles = projectiles;
    this.cameraRig = cameraRig ?? null;

    /**
     * Where the shot is actually aimed. In first person that is the camera's
     * forward axis; in third person the rig has to correct for the boom offset
     * so the round still goes where the crosshair points. Passed to each weapon
     * as a function so neither has to know which mode is active.
     */
    this._aimFn = (out) => this.aimDirection(out);

    const ctx = {
      scene: this.scene,
      camera: this.camera,
      bus,
      materials,
      engine,
      input,
      physics,
      projectiles,
      player,
      npcManager,
      aimDirection: this._aimFn,
    };

    // Adopt the machine gun `Player` may already have built rather than
    // constructing a second one - two viewmodels would render on top of
    // each other and both would consume the fire input.
    const existing = player?.weapon;
    const machinegun = existing instanceof Weapon ? existing : new Weapon(ctx);

    this._weapons = [machinegun, new FireballWeapon(ctx), new BowWeapon(ctx)];
    this._index = -1;
    this._firing = false;
    this._enabled = true;
    /** Cached HUD descriptor array; mutated in place, never rebuilt. */
    this._descriptors = this._weapons.map((w) => ({
      id: w.id, name: w.name, icon: w.icon, accent: w.accent,
      ammo: 0, reserve: 0, magazine: 0, ammoKind: w.ammoKind,
      charge: 0, reloading: false, index: 0, active: false,
    }));

    this._offs = [];
    this._bind();
    this.select(0, { silent: true });
  }

  _bind() {
    const on = (type, fn) => this._offs.push(this.bus.on(type, fn));
    on('player:died', () => {
      this._releaseFire();
      for (const w of this._weapons) w.setEnabled?.(false);
    });
    on('player:respawned', () => {
      for (const w of this._weapons) {
        w.setEnabled?.(true);
        w.resupply?.();
      }
      this.current?.onSelect?.();
    });
    // A world change interrupts whatever was in flight; a charge held across a
    // teleport would fire into the new world from the old world's aim.
    on('world:changing', () => this._releaseFire());
  }

  /* ================================================================ */
  /* Selection                                                         */
  /* ================================================================ */

  /** @returns {any} the live weapon instance */
  get current() {
    return this._weapons[this._index] ?? null;
  }

  get index() {
    return this._index;
  }

  get count() {
    return this._weapons.length;
  }

  /**
   * HUD descriptor list. The array and its objects are reused, so the HUD may
   * read them every frame without generating garbage.
   * @returns {Array<{id:string,name:string,ammo:number,reserve:number,icon:string}>}
   */
  get weapons() {
    for (let i = 0; i < this._weapons.length; i++) {
      const w = this._weapons[i];
      const d = this._descriptors[i];
      d.ammo = w.ammo ?? 0;
      d.reserve = w.reserve ?? 0;
      d.magazine = w.magazine ?? 0;
      d.charge = w.chargeLevel ?? 0;
      d.reloading = w.isReloading === true;
      d.index = i;
      d.active = i === this._index;
    }
    return this._descriptors;
  }

  /**
   * Make a weapon live.
   * @param {number|string} indexOrId slot index or weapon id
   * @param {{silent?:boolean}} [opts]
   * @returns {boolean} true if the selection changed
   */
  select(indexOrId, opts = {}) {
    let i = indexOrId;
    if (typeof indexOrId === 'string') {
      i = this._weapons.findIndex((w) => w.id === indexOrId);
    }
    if (!Number.isInteger(i) || i < 0 || i >= this._weapons.length) return false;
    if (i === this._index) return false;

    // Drop any held charge before stowing: a fireball that launches after the
    // gauntlet has left the screen is indefensible.
    this._releaseFire();

    const prev = this.current;
    if (prev) {
      try { prev.onDeselect?.(); } catch (err) { console.warn('[Loadout] onDeselect threw:', err); }
    }

    this._index = i;
    const next = this.current;
    // Keep `player.weapon` in step so anything still reading it - Player's own
    // FOV/recoil composition, the HUD, save games - sees the live weapon.
    this._syncPlayerWeapon(next);
    try { next.onSelect?.(); } catch (err) { console.warn('[Loadout] onSelect threw:', err); }

    if (!opts.silent) {
      this.bus.emit('weapon:switched', { id: next.id, name: next.name, index: i });
    }
    return true;
  }

  /** Cycle forward one slot, wrapping. */
  next() {
    return this.select((this._index + 1) % this._weapons.length);
  }

  /** Cycle back one slot, wrapping. */
  prev() {
    return this.select((this._index - 1 + this._weapons.length) % this._weapons.length);
  }

  _syncPlayerWeapon(weapon) {
    const p = this.player;
    if (!p) return;
    try {
      if (typeof p.setWeapon === 'function') p.setWeapon(weapon);
      else p._weapon = weapon;
    } catch (err) {
      // A Player that exposes `weapon` as a read-only accessor is fine: it will
      // simply be driven from here instead.
      console.warn('[Loadout] could not publish the active weapon to Player:', err);
    }
  }

  /* ================================================================ */
  /* Aiming                                                            */
  /* ================================================================ */

  /**
   * Direction the crosshair is pointing, in world space.
   *
   * In third person the camera sits behind and to the side of the body, so its
   * forward axis is *not* where the crosshair points. `CameraRig` resolves that
   * (raycast from the camera through screen centre, then aim the muzzle at the
   * resulting point) and publishes it here.
   *
   * @param {THREE.Vector3} out
   * @returns {THREE.Vector3} `out`, normalised
   */
  aimDirection(out) {
    const rig = this.cameraRig ?? this.player?.cameraRig ?? null;
    if (rig && typeof rig.getAimDirection === 'function') {
      const r = rig.getAimDirection(out);
      if (r && Number.isFinite(r.x)) return out.copy(r).normalize();
    }
    this.camera.getWorldDirection(out);
    return out.normalize();
  }

  /** Late injection, because `CameraRig` is constructed after the loadout. */
  setCameraRig(rig) {
    this.cameraRig = rig ?? null;
  }

  /* ================================================================ */
  /* Frame                                                             */
  /* ================================================================ */

  /**
   * Input, selection and viewmodel drive.
   * @param {number} dt frame seconds
   * @param {number} elapsed engine time
   */
  update(dt, elapsed) {
    const input = this.input;
    const player = this.player;
    const w = this.current;
    if (!w) return;

    const textCaptured = input?.textCaptured === true;
    const frozen = player?._harnessFrozen === true;
    const usable = this._enabled && !frozen && !textCaptured && !(player?.isDead === true);

    /* ---- selection: 1/2/3 and the wheel ---- */
    if (!textCaptured && !frozen) {
      for (let i = 0; i < SLOT_KEYS.length; i++) {
        if (input?.pressed?.(SLOT_KEYS[i])) this.select(i);
      }
      // The wheel belongs to weapon switching now; the minimap moved to [ and ].
      const wheel = input?.consumeWheel?.() ?? 0;
      if (wheel > 0) this.next();
      else if (wheel < 0) this.prev();
    }

    const active = this.current;

    /* ---- drive the viewmodel ---- */
    // The viewmodel is composed against the eye, so it has no meaning once the
    // camera pulls back onto the boom - the avatar carries a real weapon there.
    active.setVisible?.(!frozen && player?.isThirdPerson !== true);
    if (frozen) {
      // The screenshot harness owns the camera; leave the viewmodel alone but
      // keep passive state (mana regen, restock timers) ticking.
      for (const other of this._weapons) other.update?.(dt, elapsed);
      return;
    }

    active.setAim?.(usable && !!input?.state?.aim);
    active.setLowered?.(!usable || player?.isSprinting === true);
    active.setEnabled?.(usable);
    active.setViewContext?.(this._viewContext(dt, player));

    /* ---- fire, charge and release ---- */
    const wantsFire = usable && !!input?.state?.fire;
    if (wantsFire) {
      active.tryFire?.(elapsed);
      this._firing = true;
    } else if (this._firing) {
      this._firing = false;
      // The falling edge is what launches a charged weapon. The machine gun's
      // `releaseFire()` is a no-op, so this is safe to call unconditionally.
      try { active.releaseFire?.(); } catch (err) {
        console.warn('[Loadout] releaseFire threw:', err);
      }
    }
    if (usable && input?.pressed?.('KeyR')) active.reload?.(elapsed);

    /* ---- update every weapon ---- */
    // Stowed weapons still need their timers: mana regenerates, quivers restock
    // and reloads finish while the weapon is off screen, which is what makes
    // switching a real tactical choice rather than a reset button.
    for (const other of this._weapons) other.update?.(dt, elapsed);
  }

  /**
   * Movement context for the viewmodel. Read from `Player`'s public state where
   * possible; the bob phase is internal, so it degrades to a derived value if a
   * future Player stops exposing it.
   */
  _viewContext(dt, player) {
    const ctx = this._ctxCache ?? (this._ctxCache = {
      referenceFov: 75, moveSpeed: 0, grounded: true, groundY: 0,
      lookDeltaX: 0, lookDeltaY: 0, velocity: null, bobPhase: 0, bobWeight: 0, dt: 0,
    });
    const v = player?.velocity;
    ctx.referenceFov = player?._referenceFov?.() ?? this.camera.fov;
    ctx.moveSpeed = v ? Math.hypot(v.x, v.z) : 0;
    ctx.grounded = player?.grounded !== false;
    ctx.groundY = player?.position?.y ?? 0;
    // Player consumes the look delta itself each frame and caches it; reading
    // `consumeLook()` here would steal half the mouse movement.
    ctx.lookDeltaX = player?._lastLookX ?? 0;
    ctx.lookDeltaY = player?._lastLookY ?? 0;
    ctx.velocity = v ?? null;
    ctx.bobPhase = player?._bobPhase ?? 0;
    ctx.bobWeight = player?._bobWeight ?? 0;
    ctx.dt = dt;
    return ctx;
  }

  /**
   * Fixed-rate hook. Nothing in the loadout is simulated at a fixed rate today -
   * projectiles are `ProjectileSystem`'s business - but the contract requires
   * the entry point and `main.js` calls it.
   */
  fixedUpdate() {}

  _releaseFire() {
    if (!this._firing) return;
    this._firing = false;
    try { this.current?.releaseFire?.(); } catch (err) {
      console.warn('[Loadout] releaseFire threw:', err);
    }
  }

  /** Stop the loadout responding to input (menus, cutscenes). */
  setEnabled(on) {
    this._enabled = on;
    if (!on) this._releaseFire();
  }

  /* ================================================================ */
  /* Persistence                                                       */
  /* ================================================================ */

  /** @returns {{active:string, weapons:Object<string,any>}} */
  serialize() {
    const weapons = {};
    for (const w of this._weapons) {
      weapons[w.id] = w.serialize
        ? w.serialize()
        : { ammo: w.ammo ?? 0, reserve: w.reserve ?? 0 };
    }
    return { active: this.current?.id ?? 'machinegun', weapons };
  }

  deserialize(data) {
    if (!data) return;
    const saved = data.weapons ?? {};
    for (const w of this._weapons) {
      const s = saved[w.id];
      if (!s) continue;
      if (typeof w.deserialize === 'function') {
        w.deserialize(s);
      } else {
        // The machine gun keeps plain magazine/reserve counters.
        if (Number.isFinite(s.ammo)) w._ammo = s.ammo;
        if (Number.isFinite(s.reserve)) w._reserve = s.reserve;
        w._emitAmmo?.();
      }
    }
    if (typeof data.active === 'string') this.select(data.active);
  }

  dispose() {
    for (const off of this._offs) off();
    this._offs.length = 0;
    for (const w of this._weapons) {
      try { w.dispose?.(); } catch (err) { console.warn('[Loadout] dispose threw:', err); }
    }
    this._weapons.length = 0;
    this._index = -1;
  }
}

export default Loadout;
