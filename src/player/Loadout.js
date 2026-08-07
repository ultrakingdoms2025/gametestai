import { Weapon } from './Weapon.js';
import { FireballWeapon } from '../weapons/Fireball.js';
import { BowWeapon } from '../weapons/Bow.js';
import { SwordWeapon } from '../weapons/Sword.js';
import { WEAPON_STATS, AMMO_ITEMS } from '../systems/WeaponStats.js';
import { allows } from '../worlds/WorldRules.js';

/**
 * Holds the player's four weapons and decides which one is live.
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
 * satisfied by all four weapons, which it is.
 *
 * Every weapon implements: `update`, `tryFire`, `releaseFire`, `reload`,
 * `onSelect`, `onDeselect`, `dispose`, and the getters `id name ammo reserve
 * magazine isReloading spread chargeLevel`.
 *
 * ── Why ammunition is brokered here ────────────────────────────────────────
 * CONTRACTS-V3 §3.3 moves ammunition into the shared inventory: what the player
 * can fire is what is in the bag, not a private per-weapon counter. `Weapon.js`,
 * `Bow.js` and `Fireball.js` are owned by other agents, so rather than rewrite
 * their fire control this file brokers between them and `Inventory`:
 *
 *   - Magazine weapons (rifle, bow) keep their magazine. Their *reserve* is
 *     mirrored from the bag every frame, and any decrease the weapon makes to
 *     it - which only ever happens inside a reload - is played back to the bag
 *     as a `consumeFromBag`. Reload therefore literally pulls from the bag, and
 *     no weapon can consume ammunition the player does not have.
 *   - The fireball has no reserve, so it is gated at the trigger instead: an
 *     empty bag never reaches `tryFire`, and a successful launch spends one
 *     charge. Its mana pool survives as the rate limiter it always was.
 *
 * Watching the delta rather than patching the weapons is what keeps the three
 * reviewed viewmodels untouched. The whole broker is a no-op when `Inventory`
 * is absent, so the game is fully playable if that module lands late.
 */

/** Slot order is also the 1/2/3/4 key order and the HUD's strip order. */
const SLOT_KEYS = ['Digit1', 'Digit2', 'Digit3', 'Digit4'];

/**
 * Starting ammunition moved into the bag the first time an `Inventory` shows
 * up with none. Without this a fresh game would begin with one magazine and no
 * reserve, because the weapons' own private counters are no longer the truth.
 * Skipped entirely when the bag already holds that item, so it can never fight
 * with whatever the inventory or a save game seeded.
 */
const SEED_AMMO = { bullet: 180, arrow: 36, fireball_charge: 12 };

/** Minimum gap between `weapon:noammo` emissions, seconds. */
const NOAMMO_COOLDOWN = 0.35;

export class Loadout {
  /**
   * @param {{scene:THREE.Scene, camera:THREE.PerspectiveCamera, engine:any,
   *          physics:any, bus:any, materials:any, input:any, player:any,
   *          npcManager:any, projectiles:any, cameraRig?:any, combat?:any,
   *          inventory?:any}} ctx
   */
  constructor({
    scene, camera, engine, physics, bus, materials, input,
    player, npcManager, projectiles, cameraRig, combat, inventory,
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
     * The sword needs `CombatSystem` to route damage through the one path that
     * emits `npc:damaged`/`npc:killed`. main.js does not currently hand it to
     * the loadout, so fall back to the reference `ProjectileSystem` already
     * holds - it is the same instance.
     */
    this.combat = combat ?? projectiles?.combat ?? null;
    /** @type {any} set late by `setInventory` if it is not supplied here. */
    this.inventory = null;

    /**
     * Where the shot is actually aimed. In first person that is the camera's
     * forward axis; in third person the rig has to correct for the boom offset
     * so the round still goes where the crosshair points. Passed to each weapon
     * as a function so neither has to know which mode is active.
     */
    this._aimFn = (out) => this.aimDirection(out);
    /**
     * Where the crosshair is pointing, in world space.
     *
     * `aimDirection` is a *corrected* vector: the rig builds it from the
     * avatar's muzzle to this point, so it is only valid for a projectile that
     * actually leaves that muzzle. A weapon firing from somewhere else - a
     * dragon breathing from its mouth, four metres ahead of the rider - has to
     * re-aim from its own origin, and needs the target rather than the vector
     * to do it. Returns null when there is no rig to ask.
     */
    this._aimPointFn = (out) => {
      const rig = this.cameraRig ?? this.player?.cameraRig ?? null;
      return rig && typeof rig.getAimPoint === 'function' ? rig.getAimPoint(out) : null;
    };

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
      combat: this.combat,
      aimDirection: this._aimFn,
      aimPoint: this._aimPointFn,
    };

    // Adopt the machine gun `Player` may already have built rather than
    // constructing a second one - two viewmodels would render on top of
    // each other and both would consume the fire input.
    const existing = player?.weapon;
    const machinegun = existing instanceof Weapon ? existing : new Weapon(ctx);

    this._weapons = [
      machinegun,
      new FireballWeapon(ctx),
      new BowWeapon(ctx),
      new SwordWeapon(ctx),
    ];
    this._index = -1;
    this._firing = false;
    this._enabled = true;
    /** Cached HUD descriptor array; mutated in place, never rebuilt. */
    this._descriptors = this._weapons.map((w) => ({
      id: w.id, name: w.name, icon: w.icon, accent: w.accent,
      ammo: 0, reserve: 0, magazine: 0, ammoKind: w.ammoKind,
      // `ammoItem` is the inventory id the slot draws from (null for melee);
      // `bagAmmo` is how many of it are in the bag right now. Both are here so
      // the HUD can label the reserve with what it actually is.
      ammoItem: AMMO_ITEMS[w.id] ?? null, bagAmmo: 0,
      charge: 0, reloading: false, index: 0, active: false,
    }));

    this._buildBrokers();
    this._lastNoAmmo = -999;
    this._time = 0;

    /** Active world, tracked for capability rules. @see ../worlds/WorldRules.js */
    this._world = null;

    this._offs = [];
    this._bind();
    if (inventory) this.setInventory(inventory);
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
      // `resupply` rewrites private reserves; the bag is still the truth.
      this._resyncBrokers();
      this.current?.onSelect?.();
    });
    // A world change interrupts whatever was in flight; a charge held across a
    // teleport would fire into the new world from the old world's aim.
    on('world:changing', () => this._releaseFire());

    /*
     * The weapons raise `weapon:dry` from inside their own fire control. That
     * is the moment to tell the rest of the game the *bag* is empty - but only
     * if it actually is: a dry click with rounds still in the bag simply means
     * the magazine ran out and a reload is about to start.
     */
    on('weapon:dry', (e) => {
      const id = typeof e?.id === 'string' ? e.id : this.current?.id;
      const item = AMMO_ITEMS[id] ?? null;
      if (!item) return;
      if (this._bagCount(item) > 0) return;
      this._emitNoAmmo(id, item);
    });

    on('world:changed', ({ world }) => { this._world = world; });
  }

  /* ================================================================ */
  /* Ammunition brokering                                              */
  /* ================================================================ */

  /**
   * One broker per weapon that consumes ammunition.
   *
   * `reserveKey` names the private counter the weapon draws its magazine from,
   * which is the only field this file touches on a weapon it does not own.
   * `spendOnFire` marks weapons with no reserve at all, which are gated at the
   * trigger instead.
   */
  _buildBrokers() {
    /** @type {Array<{weapon:any,id:string,item:string,reserveKey:string|null,spendOnFire:boolean,last:number}>} */
    this._brokers = [];
    for (const w of this._weapons) {
      const item = AMMO_ITEMS[w.id] ?? null;
      if (!item) continue;
      const reserveKey = Number.isFinite(w._reserve) ? '_reserve' : null;
      this._brokers.push({
        weapon: w,
        id: w.id,
        item,
        reserveKey,
        spendOnFire: reserveKey === null,
        last: reserveKey ? w[reserveKey] : 0,
      });
    }
    this._seeded = false;
  }

  /**
   * Attach the shared inventory. Safe to call more than once and safe never to
   * call at all - without it the weapons keep their private counters and the
   * game plays exactly as it did before.
   * @param {any} inventory
   */
  setInventory(inventory) {
    if (!inventory || inventory === this.inventory) return;
    this.inventory = inventory;
    this._seedBag();
    this._resyncBrokers();
  }

  /**
   * Resolve the inventory, picking it up from `window.GAME` if the orchestrator
   * built it after this loadout. Cheap: it only searches until it finds one.
   * @returns {any|null}
   */
  _inv() {
    if (this.inventory) return this.inventory;
    const late = (typeof window !== 'undefined' ? window.GAME?.inventory : null) ?? null;
    if (late) this.setInventory(late);
    return this.inventory;
  }

  /** @returns {number} units of `item` in the active bag, 0 if unknown. */
  _bagCount(item) {
    const inv = this._inv();
    if (!inv || !item) return 0;
    const n = inv.bagCount?.(item);
    return Number.isFinite(n) ? n : 0;
  }

  /** Put a starting kit in the bag the first time we see an empty one. */
  _seedBag() {
    const inv = this.inventory;
    if (!inv || this._seeded) return;
    this._seeded = true;
    for (const b of this._brokers) {
      const qty = SEED_AMMO[b.item] ?? 0;
      if (qty <= 0) continue;
      try {
        if ((inv.bagCount?.(b.item) ?? 0) > 0) continue;
        const added = inv.add?.(b.item, qty) ?? 0;
        if (added > 0) inv.moveToBag?.(b.item, added);
      } catch (err) {
        console.warn(`[Loadout] could not seed "${b.item}":`, err);
      }
    }
  }

  /**
   * Fill every weapon and top the bag back up. The admin resupply.
   *
   * Order matters, and it is the whole reason this is a method rather than a
   * loop at the call site. The bag is the authority on reserve ammunition
   * (see the header): calling `weapon.resupply()` alone would write a private
   * reserve that `_syncAmmo` immediately overwrites from a bag that is still
   * empty, so the magazines would refill and then drain again on the next
   * reload. So: fill the bag first, then the weapons, then re-adopt the bag
   * without charging the player for the difference.
   *
   * @param {number} [rounds] target bag count per ammo type
   * @returns {{weapons:number, items:Object<string, number>}} what was granted
   */
  resupplyAll(rounds = 0) {
    const inv = this._inv();
    const granted = {};

    if (inv) {
      for (const b of this._brokers) {
        if (!b.item) continue;
        // Default to a full magazine's worth several times over, per weapon,
        // rather than one flat number: 300 arrows is absurd, 300 rounds is a
        // couple of minutes of suppressing fire.
        const stat = WEAPON_STATS[b.id];
        const want = rounds > 0
          ? rounds
          : Math.max(30, (stat?.magazine ?? 20) * 6);
        const have = this._bagCount(b.item);
        // Capped to what the *bag* will take. Overflow would land in the world
        // store, which no reserve ever reads, and would raise `inventory:full`
        // at the player for the privilege.
        const need = Math.min(want - have, inv.bagRoomFor?.(b.item) ?? 0);
        if (need <= 0) continue;
        try {
          const res = inv.acquire(b.item, need);
          const took = res?.taken ?? 0;
          if (took > 0) granted[b.item] = (granted[b.item] ?? 0) + took;
        } catch (err) {
          console.warn(`[Loadout] resupply could not grant "${b.item}":`, err);
        }
      }
    }

    let filled = 0;
    for (const w of this._weapons) {
      try {
        w.resupply?.();
        filled++;
      } catch (err) {
        console.warn(`[Loadout] resupply failed for "${w.id}":`, err);
      }
    }

    this._resyncBrokers();
    this.bus?.emit('loadout:resupplied', { weapons: filled, items: granted });
    return { weapons: filled, items: granted };
  }

  /**
   * Adopt the bag's counts without treating the difference as consumption.
   * Used after a resupply, a save load, or the inventory arriving late.
   */
  _resyncBrokers() {
    const inv = this._inv();
    if (!inv) return;
    for (const b of this._brokers) {
      const bag = this._bagCount(b.item);
      if (b.reserveKey) b.weapon[b.reserveKey] = bag;
      b.last = bag;
    }
  }

  /**
   * Mirror the bag into every reserve-backed weapon and play any decrease back
   * to the inventory. Called once per frame, before input is read, so a reload
   * that finished this frame is already accounted for.
   */
  _syncAmmo() {
    const inv = this._inv();
    if (!inv) return;
    for (const b of this._brokers) {
      if (!b.reserveKey) continue;
      const cur = b.weapon[b.reserveKey];
      if (Number.isFinite(cur) && cur < b.last) {
        // The only thing that decreases a reserve is a reload pulling rounds
        // out of it, so this is exactly the quantity the bag owes.
        const want = Math.min(b.last - cur, this._bagCount(b.item));
        if (want > 0) {
          try { inv.consumeFromBag?.(b.item, want); } catch (err) {
            console.warn(`[Loadout] consumeFromBag("${b.item}") threw:`, err);
          }
        }
      }
      const bag = this._bagCount(b.item);
      b.weapon[b.reserveKey] = bag;
      b.last = bag;
    }
  }

  /** @returns {object|null} the broker for a weapon id, if it needs ammunition */
  _brokerFor(id) {
    for (const b of this._brokers) if (b.id === id) return b;
    return null;
  }

  _emitNoAmmo(id, item) {
    if (this._time - this._lastNoAmmo < NOAMMO_COOLDOWN) return;
    this._lastNoAmmo = this._time;
    this.bus.emit('weapon:noammo', { id, itemId: item });
  }

  /**
   * Trigger gate for weapons with no magazine to fall back on.
   * @returns {boolean} true if the trigger may be pulled
   */
  _canFire(weapon) {
    const b = this._brokerFor(weapon.id);
    if (!b || !b.spendOnFire) return true;
    if (this._bagCount(b.item) > 0) return true;
    // Dry click: the same twitch the weapon plays for itself when it runs out,
    // driven from here because the weapon has no idea the bag is empty.
    if (this._time - this._lastNoAmmo >= NOAMMO_COOLDOWN) {
      weapon._dryT = 1;
      this.bus.emit('weapon:dry', { reserve: 0, id: weapon.id });
    }
    this._emitNoAmmo(b.id, b.item);
    return false;
  }

  /**
   * Release the trigger and, if that launched something, spend the charge.
   * @returns {boolean} whether the weapon fired
   */
  _doRelease(weapon) {
    if (!weapon) return false;
    let fired = false;
    try { fired = weapon.releaseFire?.() === true; } catch (err) {
      console.warn('[Loadout] releaseFire threw:', err);
    }
    if (!fired) return false;
    const b = this._brokerFor(weapon.id);
    if (b?.spendOnFire) {
      const inv = this._inv();
      const stats = WEAPON_STATS[weapon.id];
      const n = Math.max(1, stats?.ammoPerShot ?? 1);
      try { inv?.consumeFromBag?.(b.item, n); } catch (err) {
        console.warn(`[Loadout] consumeFromBag("${b.item}") threw:`, err);
      }
    }
    return fired;
  }

  /**
   * Ammunition in the bag for a slot.
   * @param {number|string} indexOrId slot index or weapon id
   * @returns {number} bag count, or Infinity for a weapon that needs none
   */
  ammoInBag(indexOrId) {
    const w = typeof indexOrId === 'string'
      ? this._weapons.find((x) => x.id === indexOrId)
      : this._weapons[indexOrId];
    if (!w) return 0;
    const item = AMMO_ITEMS[w.id] ?? null;
    if (!item) return Infinity;
    return this._bagCount(item);
  }

  /* ================================================================ */
  /* Selection                                                         */
  /* ================================================================ */

  /**
   * The live weapon instances, not the HUD descriptors from `weapons`.
   *
   * Exposed so boot-time warmup can make every viewmodel visible for a few
   * frames and force its shadow/depth shader variants to compile before the
   * player ever selects it.
   * @returns {Array<object>}
   */
  get instances() {
    return this._weapons;
  }

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
   *
   * `reserve` is the bag count for every weapon that draws from the inventory,
   * because the bag *is* the reserve now; `ammo` stays the loaded magazine so
   * an existing "loaded / reserve" readout keeps meaning what it says.
   * `bagAmmo` repeats the bag count explicitly for anything that wants it
   * without having to know which weapons have magazines.
   *
   * @returns {Array<{id:string,name:string,ammo:number,reserve:number,icon:string}>}
   */
  get weapons() {
    // Without an Inventory there is no bag, and the weapons' own reserves are
    // still the truth - reporting zero would blank the HUD's reserve readout on
    // a build where that module has not landed yet.
    const live = !!this._inv();
    for (let i = 0; i < this._weapons.length; i++) {
      const w = this._weapons[i];
      const d = this._descriptors[i];
      const item = d.ammoItem;
      const bag = (live && item) ? this._bagCount(item) : (w.reserve ?? 0);
      d.ammo = w.ammo ?? 0;
      d.reserve = bag;
      d.bagAmmo = bag;
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
    // A world with no weapons has no viewmodel and no selection.
    if (!allows(this._world, 'weapons')) return false;
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

  /** Late injection, because `CombatSystem` may be constructed after us. */
  setCombat(combat) {
    if (!combat) return;
    this.combat = combat;
    for (const w of this._weapons) w.setCombat?.(combat);
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
    this._time = elapsed;

    // Reserves are mirrored from the bag before anything reads them, so a HUD
    // that samples mid-frame never sees a stale count.
    this._syncAmmo();

    const textCaptured = input?.textCaptured === true;
    const frozen = player?._harnessFrozen === true;
    const usable = this._enabled && !frozen && !textCaptured && !(player?.isDead === true);

    /* ---- selection: 1/2/3/4 and the wheel ---- */
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
      // `_canFire` only ever blocks a weapon that has no magazine to fall back
      // on; everything else dry-clicks through its own fire control.
      if (this._canFire(active)) active.tryFire?.(elapsed);
      this._firing = true;
    } else if (this._firing) {
      this._firing = false;
      // The falling edge is what launches a charged weapon. The machine gun's
      // and the sword's `releaseFire()` are no-ops, so this is safe to call
      // unconditionally.
      this._doRelease(active);
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
   * projectiles are `ProjectileSystem`'s business, and the sword's arc sweep
   * runs off the same clock as its animation - but the contract requires the
   * entry point and `main.js` calls it.
   */
  fixedUpdate() {}

  _releaseFire() {
    if (!this._firing) return;
    this._firing = false;
    this._doRelease(this.current);
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
    // A saved reserve is historical: the bag is the authority, and treating the
    // difference as consumption would silently drain the player's ammunition.
    this._resyncBrokers();
    if (typeof data.active === 'string') this.select(data.active);
  }

  dispose() {
    for (const off of this._offs) off();
    this._offs.length = 0;
    for (const w of this._weapons) {
      try { w.dispose?.(); } catch (err) { console.warn('[Loadout] dispose threw:', err); }
    }
    this._weapons.length = 0;
    this._brokers.length = 0;
    this._index = -1;
  }
}

export default Loadout;
