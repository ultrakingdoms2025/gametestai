import * as THREE from 'three';

/**
 * Persistence.
 *
 * The governing rule for this file is that **no read path may ever throw into
 * the frame loop**. localStorage can be disabled, full, or hold a save written
 * by a different build of the game; every one of those has to degrade to "start
 * fresh" with a single console line, never an exception. So the whole read side
 * funnels through `_read()`, which validates shape as well as version, and every
 * restore step is individually guarded - a save that only half-applies still
 * leaves a playable game.
 *
 * The write side is equally paranoid, because `save()` also runs from
 * `beforeunload`, where an exception costs the player the save *and* the tab.
 *
 * Interop note: `Loadout` and `MountManager` are written concurrently by other
 * agents, so ammo and mount restoration go through the published contract API
 * (`select` / `current` / `weapons`, `summon` / `active`) and probe for optional
 * `serialize`/`deserialize` first. If those land, this file uses them
 * automatically with no change.
 */

/** Versioned storage key. A schema break gets a new suffix, not a migration hack. */
export const SAVE_KEY = 'aether-nexus:save:v1';
/** Schema version *inside* the payload, so a v1-keyed save can still evolve. */
export const SAVE_SCHEMA = 1;
const AUTOSAVE_DEFAULT = 30;

/** Private to `_restorePlayer`, which hands it straight to `player.teleport`. */
const _target = new THREE.Vector3();

export class SaveGame {
  /**
   * @param {{ bus: import('../core/EventBus.js').EventBus,
   *           player: any, worldManager: any, economy: any,
   *           loadout?: any, mounts?: any, input?: any }} ctx
   */
  constructor({ bus, player, worldManager, economy, loadout, mounts, input, inventory }) {
    this.bus = bus;
    this.player = player;
    this.worldManager = worldManager;
    this.economy = economy;
    this.loadout = loadout ?? null;
    this.mounts = mounts ?? null;
    this.input = input ?? null;
    /** @type {any} Optional - the game is playable without an inventory wired. */
    this.inventory = inventory ?? null;

    this._autosaveTimer = null;
    this._autosaveSeconds = 0;
    /** Suppresses autosave while a load is applying, so a load cannot self-overwrite. */
    this._loading = false;
    /**
     * No unattended write happens before the player actually enters the world.
     * Without this, sitting on the boot screen for 30 seconds would autosave a
     * pristine spawn state over the save the player was about to load - which
     * is the single worst thing a save system can do.
     */
    this._started = false;
    /** One corruption message per session; a broken save must not spam the console. */
    this._corruptLogged = false;
    this._lastSaveAt = 0;
    /** @type {Array<() => void>} */
    this._offs = [];

    /**
     * F5 is the browser's reload key, so this listener has to win the race: it
     * is registered in the capture phase on `window` and calls preventDefault
     * before anything else sees the event. `Input` deliberately does not handle
     * function keys, so there is no double-binding to coordinate.
     */
    this._onKeyDown = (e) => {
      if (e.code !== 'F5' && e.code !== 'F9') return;
      // Ctrl+F5 stays a hard reload - developers need an escape hatch.
      if (e.ctrlKey || e.metaKey || e.altKey || e.repeat) return;
      // No text-focus guard: function keys never type a character, so stealing
      // them is always safe, and losing a chat message to an accidental reload
      // is a worse outcome than saving from inside the chat box.
      e.preventDefault();
      e.stopPropagation();
      if (e.code === 'F5') this.save('hotkey');
      else this.load();
    };
    window.addEventListener('keydown', this._onKeyDown, true);

    this._onBeforeUnload = () => {
      // Never throws: save() is fully guarded, and an exception here would be
      // swallowed by the browser anyway - along with the save.
      this._autoSave('unload');
    };
    window.addEventListener('beforeunload', this._onBeforeUnload);

    if (bus) {
      this._offs.push(bus.on('game:started', () => { this._started = true; }));
      this._offs.push(bus.on('world:changed', () => this._autoSave('world-change')));
    }

    // On by default: the contract requires a 30 s autosave, and a feature that
    // only works if the orchestrator remembers one extra call is not a feature.
    this.enableAutosave(AUTOSAVE_DEFAULT);
  }

  /* ================================================================ */
  /* Contract surface                                                  */
  /* ================================================================ */

  /**
   * Write the current game state.
   * @param {string} [reason] tag for logging / the autosave pip
   * @returns {boolean} true when the payload reached localStorage
   */
  save(reason = 'manual') {
    // An explicit save proves the player is in the world, so it also arms the
    // autosave even if `game:started` was missed.
    this._started = true;
    let payload;
    try {
      payload = this._snapshot();
    } catch (err) {
      this._fail('snapshot failed', err);
      return false;
    }

    try {
      localStorage.setItem(SAVE_KEY, JSON.stringify(payload));
    } catch (err) {
      // Quota, private-browsing, or storage disabled entirely.
      this._fail('storage write refused', err);
      return false;
    }

    this._lastSaveAt = payload.at;
    this.bus?.emit('save:written', { at: payload.at, reason });
    return true;
  }

  /**
   * Restore the last save. Builds and activates the stored world before the
   * player is placed, because the physics world only holds the active world's
   * colliders - teleporting first would settle the capsule against the wrong
   * floor.
   *
   * @returns {Promise<boolean>} true when a save was found and applied
   */
  async load() {
    const data = this._read();
    if (!data) {
      this.bus?.emit('save:error', { message: 'No save found' });
      this.bus?.emit('hud:notify', { text: 'No save found', tone: 'warn' });
      return false;
    }

    this._loading = true;
    try {
      await this._restoreWorld(data.world);
      this._restorePlayer(data.player);
      this._restoreHealth(data.player);
      this._restoreEconomy(data);
      // Before the loadout: weapons report their ammo from the bag, so the bag
      // has to hold the saved contents by the time they are asked.
      this._restoreInventory(data.inventory);
      this._restoreLoadout(data.weapons);
      this._restoreMounts(data.mounts);
    } catch (err) {
      // Should be unreachable - every step guards itself - but a load must not
      // be the thing that kills the session.
      this._fail('load failed', err, { clear: false });
      return false;
    } finally {
      this._loading = false;
    }

    this.bus?.emit('save:loaded', { at: data.at ?? Date.now(), world: data.world });
    this.bus?.emit('hud:notify', { text: 'Game loaded', tone: 'info' });
    return true;
  }

  /** @returns {boolean} true when a well-formed save is present. */
  hasSave() {
    return this._read({ quiet: true }) !== null;
  }

  /** Remove the save. Safe to call when there is nothing there. */
  clear() {
    try {
      localStorage.removeItem(SAVE_KEY);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Start (or restart) the periodic autosave.
   * @param {number} [seconds] interval; values below 5 s are clamped up
   */
  enableAutosave(seconds = AUTOSAVE_DEFAULT) {
    this.disableAutosave();
    const period = Math.max(5, Number(seconds) || AUTOSAVE_DEFAULT);
    this._autosaveSeconds = period;
    this._autosaveTimer = setInterval(() => this._autoSave('autosave'), period * 1000);
    return this;
  }

  /** Unattended write: only once the player is in, and never mid-load. */
  _autoSave(reason) {
    if (this._loading || !this._started) return false;
    return this.save(reason);
  }

  disableAutosave() {
    if (this._autosaveTimer !== null) clearInterval(this._autosaveTimer);
    this._autosaveTimer = null;
    this._autosaveSeconds = 0;
    return this;
  }

  /** Epoch ms of the last successful write, or 0. */
  get lastSaveAt() {
    return this._lastSaveAt;
  }

  get autosaveSeconds() {
    return this._autosaveSeconds;
  }

  dispose() {
    this.disableAutosave();
    window.removeEventListener('keydown', this._onKeyDown, true);
    window.removeEventListener('beforeunload', this._onBeforeUnload);
    for (const off of this._offs) {
      try {
        off();
      } catch {
        /* bus already torn down */
      }
    }
    this._offs.length = 0;
  }

  /* ================================================================ */
  /* Snapshot                                                          */
  /* ================================================================ */

  /** Build the payload. Every accessor is optional - subsystems may not be wired. */
  _snapshot() {
    const p = this.player;
    const pos = p?.position;

    return {
      version: SAVE_SCHEMA,
      at: Date.now(),
      world: this.worldManager?.active?.id ?? null,
      player: {
        x: num(pos?.x, 0),
        y: num(pos?.y, 2),
        z: num(pos?.z, 0),
        yaw: num(p?.yaw, 0),
        health: num(p?.health, 100),
        maxHealth: num(p?.maxHealth, 100),
      },
      credits: num(this.economy?.credits, 0),
      economy: safe(() => this.economy?.serialize?.()) ?? null,
      weapons: this._snapshotWeapons(),
      mounts: this._snapshotMounts(),
      // Ammunition lives in the bag now, so a save without the inventory would
      // restore a player who cannot fire anything they were carrying.
      inventory: safe(() => this.inventory?.serialize?.()) ?? null,
    };
  }

  _snapshotWeapons() {
    const loadout = this.loadout;
    if (!loadout) return null;

    const custom = safe(() => loadout.serialize?.());
    if (custom && typeof custom === 'object') return { custom };

    const list = safe(() => loadout.weapons) ?? [];
    const slots = [];
    if (Array.isArray(list)) {
      for (const w of list) {
        if (!w || typeof w.id !== 'string') continue;
        slots.push({ id: w.id, ammo: num(w.ammo, 0), reserve: num(w.reserve, 0) });
      }
    }
    return {
      selected: safe(() => loadout.current?.id) ?? null,
      slots,
    };
  }

  _snapshotMounts() {
    const mounts = this.mounts;
    if (!mounts) return null;

    const custom = safe(() => mounts.serialize?.());
    if (custom && typeof custom === 'object') return { custom };

    const unlocked = safe(() => mounts.unlocked);
    return {
      active: safe(() => mounts.active?.id) ?? null,
      mounted: safe(() => mounts.mounted) === true,
      unlocked: Array.isArray(unlocked) ? unlocked.filter((x) => typeof x === 'string') : null,
    };
  }

  /* ================================================================ */
  /* Restore                                                           */
  /* ================================================================ */

  async _restoreWorld(id) {
    if (typeof id !== 'string' || !id) return;
    const wm = this.worldManager;
    if (!wm) return;
    if (wm.active?.id === id) return;
    try {
      if (!wm.ids?.includes?.(id)) {
        console.warn(`[SaveGame] saved world "${id}" is not registered; staying put`);
        return;
      }
      await wm.build(id);
      await wm.activate(id);
    } catch (err) {
      this._fail(`could not activate world "${id}"`, err, { clear: false });
    }
  }

  _restorePlayer(snap) {
    if (!snap) return;
    const p = this.player;
    if (!p) return;
    try {
      // `activate()` has just dropped the player at the world spawn; move them
      // to the stored spot afterwards, preserving the stored yaw.
      _target.set(num(snap.x, 0), num(snap.y, 2), num(snap.z, 0));
      if (typeof p.teleport === 'function') {
        p.teleport(_target, num(snap.yaw, 0));
      } else if (p.position?.set) {
        p.position.copy(_target);
      }
    } catch (err) {
      this._fail('could not place the player', err, { clear: false });
    }
  }

  _restoreHealth(snap) {
    const p = this.player;
    if (!snap || !p) return;
    const target = num(snap.health, NaN);
    if (!Number.isFinite(target) || target <= 0) return;
    try {
      if (typeof p.setHealth === 'function') {
        p.setHealth(target);
        return;
      }
      const current = num(p.health, target);
      if (target > current) p.heal?.(target - current);
      // Deliberately never damage downward: applying damage would fire
      // `player:damaged`, flash the HUD, and can be swallowed by respawn
      // invulnerability anyway. Loading at full health is the kinder failure.
    } catch (err) {
      console.warn('[SaveGame] health restore skipped:', err);
    }
  }

  _restoreEconomy(data) {
    const eco = this.economy;
    if (!eco) return;
    try {
      if (data.economy && eco.deserialize?.(data.economy)) return;
      const credits = num(data.credits, NaN);
      if (!Number.isFinite(credits)) return;
      if (typeof eco.set === 'function') eco.set(credits, 'load');
      else eco.deserialize?.({ credits });
    } catch (err) {
      console.warn('[SaveGame] credit restore skipped:', err);
    }
  }

  _restoreLoadout(snap) {
    const loadout = this.loadout;
    if (!loadout || !snap) return;
    try {
      if (snap.custom && loadout.deserialize?.(snap.custom)) return;

      // `select(id)` then `current` is the only instance handle the Loadout
      // contract guarantees, so ammo is restored by walking the selection.
      const slots = Array.isArray(snap.slots) ? snap.slots : [];
      for (const slot of slots) {
        if (!slot || typeof slot.id !== 'string') continue;
        try {
          loadout.select(slot.id);
          this._applyAmmo(loadout.current, slot.ammo, slot.reserve);
        } catch (err) {
          console.warn(`[SaveGame] could not restore ammo for "${slot.id}":`, err);
        }
      }
      if (typeof snap.selected === 'string') loadout.select(snap.selected);
      else if (slots.length) loadout.select(slots[0].id);
    } catch (err) {
      console.warn('[SaveGame] loadout restore skipped:', err);
    }
  }

  /** Ammo has no setter in the weapon contract, so try the plausible routes. */
  /**
   * Restore the store and the active bag. Silent no-op when the inventory is
   * absent or the save predates it, so an old save still loads cleanly.
   */
  _restoreInventory(snap) {
    if (!snap || !this.inventory?.deserialize) return;
    try {
      this.inventory.deserialize(snap);
    } catch (err) {
      console.warn('[save] inventory restore failed, leaving current contents:', err?.message ?? err);
    }
  }

  _applyAmmo(weapon, ammo, reserve) {
    if (!weapon) return;
    const a = num(ammo, NaN);
    const r = num(reserve, NaN);
    if (!Number.isFinite(a) && !Number.isFinite(r)) return;

    if (typeof weapon.setAmmo === 'function') {
      weapon.setAmmo(a, r);
      return;
    }
    if (typeof weapon.deserialize === 'function') {
      weapon.deserialize({ ammo: a, reserve: r });
      return;
    }
    // `ammo`/`reserve` are getter-only on the machine gun, and assigning to a
    // getter throws in module (strict) scope - hence the individual guards.
    if (Number.isFinite(a)) {
      try {
        weapon.ammo = a;
      } catch {
        try {
          weapon._ammo = a;
        } catch {
          /* give up on this field */
        }
      }
    }
    if (Number.isFinite(r)) {
      try {
        weapon.reserve = r;
      } catch {
        try {
          weapon._reserve = r;
        } catch {
          /* give up on this field */
        }
      }
    }
  }

  _restoreMounts(snap) {
    const mounts = this.mounts;
    if (!mounts || !snap) return;
    try {
      if (snap.custom && mounts.deserialize?.(snap.custom)) return;
      if (typeof snap.active === 'string' && snap.active) {
        mounts.summon?.(snap.active);
      } else if (mounts.mounted) {
        mounts.dismount?.();
      }
    } catch (err) {
      console.warn('[SaveGame] mount restore skipped:', err);
    }
  }

  /* ================================================================ */
  /* Storage + validation                                              */
  /* ================================================================ */

  /**
   * Read, parse and validate. Anything unexpected logs once, wipes the save and
   * returns null - the caller simply carries on with a fresh game.
   * @param {{ quiet?: boolean }} [opts]
   */
  _read({ quiet = false } = {}) {
    let raw;
    try {
      raw = localStorage.getItem(SAVE_KEY);
    } catch (err) {
      if (!quiet) this._fail('storage read refused', err, { clear: false });
      return null;
    }
    if (raw === null || raw === '') return null;

    let data;
    try {
      data = JSON.parse(raw);
    } catch (err) {
      this._fail('save is not valid JSON', err);
      return null;
    }

    if (!this._validate(data)) {
      this._fail(`save is version ${data?.version ?? '?'} or malformed`, null);
      return null;
    }
    return data;
  }

  /** Structural check. Cheap, and it is the thing standing between us and a crash. */
  _validate(data) {
    if (!data || typeof data !== 'object' || Array.isArray(data)) return false;
    if (data.version !== SAVE_SCHEMA) return false;
    const p = data.player;
    if (!p || typeof p !== 'object') return false;
    if (!Number.isFinite(Number(p.x)) || !Number.isFinite(Number(p.y)) || !Number.isFinite(Number(p.z))) {
      return false;
    }
    if (data.world !== null && typeof data.world !== 'string') return false;
    if (data.weapons !== null && data.weapons !== undefined && typeof data.weapons !== 'object') {
      return false;
    }
    if (data.mounts !== null && data.mounts !== undefined && typeof data.mounts !== 'object') {
      return false;
    }
    return true;
  }

  /** Log once, optionally wipe, always emit `save:error`. Never throws. */
  _fail(message, err, { clear = true } = {}) {
    if (!this._corruptLogged) {
      this._corruptLogged = true;
      console.warn(`[SaveGame] ${message}${err ? `: ${err.message ?? err}` : ''} - resetting save.`);
    }
    if (clear) this.clear();
    this.bus?.emit('save:error', { message });
  }
}

/* ------------------------------------------------------------------ */
/* Local helpers                                                       */
/* ------------------------------------------------------------------ */

/** Coerce to a finite number or return the fallback. */
function num(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

/** Run a getter that may not exist and may throw. Returns undefined on failure. */
function safe(fn) {
  try {
    return fn();
  } catch {
    return undefined;
  }
}
