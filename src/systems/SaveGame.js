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

/**
 * Salt for the integrity tag.
 *
 * ── Read this before trusting the tag for anything ────────────────────────
 *
 * This game runs entirely on the player's own machine. There is no server, no
 * authority anywhere but the browser tab, and every number in it - credits,
 * ammo, inventory - lives in memory that the player owns and can edit. That is
 * not a flaw in this file; it is what a client-only game *is*. Nothing
 * implemented here can change it, and any claim otherwise would be false.
 *
 * What the tag does do is make the save a **sealed** artefact rather than an
 * open one. Opening devtools and typing a new credit balance into the JSON now
 * produces a save the game rejects, so the casual edit - which is the one that
 * actually happens - stops working. Someone willing to read the bundle can find
 * this constant and recompute the tag, and they will succeed. It is a lock on a
 * door, not a wall.
 *
 * Real prevention requires the balance to live somewhere the player cannot
 * reach, which means an account and a server that owns the number.
 */
const INTEGRITY_SALT = 'aether-nexus/v1/8f3c1d';

/**
 * FNV-1a over a string, as 8 hex characters.
 *
 * Deliberately not a cryptographic hash: a real HMAC needs a key the client
 * cannot hold, and shipping one in the bundle would only look like security
 * while being exactly as strong as this. Cheap and honest beats expensive and
 * misleading.
 */
function tagOf(text) {
  let h = 0x811c9dc5;
  const s = `${INTEGRITY_SALT}:${text}`;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

/** The payload as the tag sees it: everything except the tag itself. */
function bodyOf(payload) {
  const { integrity, ...rest } = payload;
  void integrity;
  return JSON.stringify(rest);
}

/** Private to `_restorePlayer`, which hands it straight to `player.teleport`. */
const _target = new THREE.Vector3();

export class SaveGame {
  /**
   * @param {{ bus: import('../core/EventBus.js').EventBus,
   *           player: any, worldManager: any, economy: any,
   *           loadout?: any, mounts?: any, input?: any }} ctx
   */
  constructor({ bus, player, worldManager, economy, loadout, mounts, input, inventory, avatar, cosmetics }) {
    this.bus = bus;
    this.player = player;
    this.worldManager = worldManager;
    this.economy = economy;
    this.loadout = loadout ?? null;
    this.mounts = mounts ?? null;
    this.input = input ?? null;
    /** @type {any} Optional - the game is playable without an inventory wired. */
    this.inventory = inventory ?? null;
    /** @type {any} Optional wardrobe of purchased skins. */
    this.cosmetics = cosmetics ?? null;
    /**
     * The player's body, for the character configuration. Optional and resolved
     * lazily by `_avatar()`: `main.js` builds the avatar before this system, but
     * it also hangs it off the player, so there is nothing for the orchestrator
     * to remember.
     * @type {any}
     */
    this.avatar = avatar ?? null;

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

    this._onBeforeUnload = (e) => {
      // Never throws: save() is fully guarded, and an exception here would be
      // swallowed by the browser anyway - along with the save.
      this._autoSave('unload');
      /* And ask before the window actually goes.
       *
       * Crouch is Ctrl and forward is W, so crouch-walking is Ctrl+W, which
       * closes the window - a player doing something completely ordinary lost
       * the whole session. `Input` claims that combination through the Keyboard
       * Lock API, but the lock needs fullscreen and can be refused, so this is
       * the backstop for when it is not held: the browser's own "leave site?"
       * prompt, which does catch Ctrl+W.
       *
       * Only while a game is actually in progress. Prompting on the title
       * screen would be an obstacle protecting nothing. */
      if (this._started && !this._suppressPrompt) {
        e.preventDefault();
        e.returnValue = '';
        return '';
      }
      return undefined;
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

    // Seal it. See INTEGRITY_SALT for exactly how much this is and is not worth.
    payload.integrity = tagOf(bodyOf(payload));

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
      const worldReady = await this._restoreWorld(data.world);
      if (!worldReady) {
        this._fail(`could not restore world "${data.world ?? 'unknown'}"`, null, { clear: false });
        return false;
      }

      const playerReady = this._restorePlayer(data.player);
      if (!playerReady) {
        this._fail('could not place the player during load', null, { clear: false });
        return false;
      }

      const healthReady = this._restoreHealth(data.player);
      if (!healthReady) {
        this._fail('could not restore health during load', null, { clear: false });
        return false;
      }

      // Before the mounts: the rider proxy is built from the player's character
      // config, so restoring a mount first would seat the wrong person on it.
      const characterReady = this._restoreCharacter(data.character);
      if (!characterReady) {
        this._fail('could not restore character during load', null, { clear: false });
        return false;
      }

      const economyReady = this._restoreEconomy(data);
      if (!economyReady) {
        this._fail('could not restore economy during load', null, { clear: false });
        return false;
      }

      // Before the loadout: weapons report their ammo from the bag, so the bag
      // has to hold the saved contents by the time they are asked.
      const inventoryReady = this._restoreInventory(data.inventory);
      if (!inventoryReady) {
        this._fail('could not restore inventory during load', null, { clear: false });
        return false;
      }

      const loadoutReady = this._restoreLoadout(data.weapons);
      if (!loadoutReady) {
        this._fail('could not restore loadout during load', null, { clear: false });
        return false;
      }

      const mountsReady = this._restoreMounts(data.mounts);
      if (!mountsReady) {
        this._fail('could not restore mounts during load', null, { clear: false });
        return false;
      }

      this._restoreCosmetics(data.cosmetics);
    } catch (err) {
      // Should be unreachable - every step guards itself - but a load must not
      // be the thing that kills the session.
      this._fail('load failed', err, { clear: false });
      return false;
    } finally {
      this._loading = false;
    }

    const activeWorld = this.worldManager?.active?.id ?? data.world ?? null;
    this.bus?.emit('save:loaded', { at: data.at ?? Date.now(), world: activeWorld });
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
      // Purchased skins are ids, not geometry, so this is just the owned list.
      cosmetics: safe(() => this.cosmetics?.serialize?.()) ?? null,
      // Ammunition lives in the bag now, so a save without the inventory would
      // restore a player who cannot fire anything they were carrying.
      inventory: safe(() => this.inventory?.serialize?.()) ?? null,
      // Who the player *is*: sex, build, height, skin, hair, garment colours.
      // A flat JSON-safe object by contract - see `PlayerAvatar.characterConfig`.
      character: safe(() => this._avatar()?.characterConfig) ?? null,
    };
  }

  /**
   * The player's body. Resolved on each use rather than cached, because the
   * avatar can be rebuilt (a change of sex or outfit replaces the humanoid) and
   * because `main.js` may construct this system before it hands one over.
   */
  _avatar() {
    return this.avatar ?? this.player?.avatar ?? globalThis.GAME?.avatar ?? null;
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
    if (typeof id !== 'string' || !id) return true;
    const wm = this.worldManager;
    if (!wm) return true;
    if (wm.active?.id === id) return true;

    try {
      if (!wm.ids?.includes?.(id)) {
        const fallbackId = wm.active?.id ?? wm.ids?.[0] ?? null;
        if (!fallbackId) {
          console.warn(`[SaveGame] saved world "${id}" is not registered and no fallback world is available`);
          return false;
        }
        console.warn(`[SaveGame] saved world "${id}" is not registered; using "${fallbackId}"`);
        await wm.build(fallbackId);
        await wm.activate(fallbackId);
        return true;
      }
      await wm.build(id);
      await wm.activate(id);
      return true;
    } catch (err) {
      console.warn(`[SaveGame] could not activate world "${id}":`, err);
      return false;
    }
  }

  _restorePlayer(snap) {
    if (!snap) return true;
    const p = this.player;
    if (!p) return true;
    try {
      // `activate()` has just dropped the player at the world spawn; move them
      // to the stored spot afterwards, preserving the stored yaw.
      _target.set(num(snap.x, 0), num(snap.y, 2), num(snap.z, 0));
      if (typeof p.teleport === 'function') {
        p.teleport(_target, num(snap.yaw, 0));
      } else if (p.position?.set) {
        p.position.copy(_target);
      }
      return true;
    } catch (err) {
      console.warn('[SaveGame] could not place the player:', err);
      return false;
    }
  }

  _restoreHealth(snap) {
    const p = this.player;
    if (!snap || !p) return true;
    const target = num(snap.health, NaN);
    if (!Number.isFinite(target) || target <= 0) return true;
    try {
      if (typeof p.setHealth === 'function') {
        p.setHealth(target);
        return true;
      }
      const current = num(p.health, target);
      if (target > current) p.heal?.(target - current);
      // Deliberately never damage downward: applying damage would fire
      // `player:damaged`, flash the HUD, and can be swallowed by respawn
      // invulnerability anyway. Loading at full health is the kinder failure.
      return true;
    } catch (err) {
      console.warn('[SaveGame] health restore skipped:', err);
      return false;
    }
  }

  _restoreEconomy(data) {
    const eco = this.economy;
    if (!eco) return true;
    try {
      if (data.economy && eco.deserialize?.(data.economy)) return true;
      const credits = num(data.credits, NaN);
      if (!Number.isFinite(credits)) return true;
      if (typeof eco.set === 'function') eco.set(credits, 'load');
      else eco.deserialize?.({ credits });
      return true;
    } catch (err) {
      console.warn('[SaveGame] credit restore skipped:', err);
      return false;
    }
  }

  _restoreLoadout(snap) {
    const loadout = this.loadout;
    if (!loadout || !snap) return true;
    try {
      if (snap.custom && loadout.deserialize?.(snap.custom)) return true;

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
      return true;
    } catch (err) {
      console.warn('[SaveGame] loadout restore skipped:', err);
      return false;
    }
  }

  /** Ammo has no setter in the weapon contract, so try the plausible routes. */
  /**
   * Restore the store and the active bag. Silent no-op when the inventory is
   * absent or the save predates it, so an old save still loads cleanly.
   */
  _restoreInventory(snap) {
    if (!snap || !this.inventory?.deserialize) return true;
    try {
      this.inventory.deserialize(snap);
      return true;
    } catch (err) {
      console.warn('[save] inventory restore failed, leaving current contents:', err?.message ?? err);
      return false;
    }
  }

  /**
   * Restore the player's appearance.
   *
   * Defensive in exactly the way `_restoreInventory` is: a save written before
   * the character menu existed has no `character` key at all, and that has to
   * load into the default man without a word. `setCharacterConfig` normalises
   * whatever it is handed, so a partial or corrupt object degrades field by
   * field rather than throwing.
   *
   * @param {any} snap
   */
  _restoreCharacter(snap) {
    if (!snap || typeof snap !== 'object' || Array.isArray(snap)) return true;
    const avatar = this._avatar();
    if (!avatar?.setCharacterConfig) return true;
    try {
      avatar.setCharacterConfig(snap);
      return true;
    } catch (err) {
      console.warn('[save] character restore skipped:', err?.message ?? err);
      return false;
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
    if (!mounts || !snap) return true;
    try {
      if (snap.custom && mounts.deserialize?.(snap.custom)) return true;
      if (typeof snap.active === 'string' && snap.active) {
        mounts.summon?.(snap.active);
      } else if (mounts.mounted) {
        mounts.dismount?.();
      }
      return true;
    } catch (err) {
      console.warn('[SaveGame] mount restore skipped:', err);
      return false;
    }
  }

  /**
   * Re-grant purchased skins. Non-fatal: a wardrobe failure must never block a
   * load, so this returns nothing and only logs.
   */
  _restoreCosmetics(snap) {
    if (!this.cosmetics || !snap) return;
    try {
      this.cosmetics.deserialize?.(snap);
    } catch (err) {
      console.warn('[SaveGame] cosmetic restore skipped:', err);
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

    /* Integrity, checked after shape so a genuinely old save still reports the
     * useful error rather than "tampered".
     *
     * A save with no tag at all is accepted: every save written before this
     * shipped has none, and refusing them would delete the progress of every
     * existing player to defend against an edit they did not make. A save with
     * a *wrong* tag is refused - that is an edited one. */
    if (typeof data.integrity === 'string') {
      if (data.integrity !== tagOf(bodyOf(data))) {
        this._fail('save failed its integrity check - it has been edited', null);
        return null;
      }
    }
    return data;
  }

  /* ================================================================ */
  /* Backup, because localStorage is not durable storage              */
  /* ================================================================ */

  /**
   * Ask the browser to keep this origin's storage rather than evicting it.
   *
   * localStorage survives "clear cache" - cached files and site data are
   * different buckets - but it does *not* survive "cookies and other site
   * data", it does not survive a private window closing, and under storage
   * pressure the browser may evict it without asking. Granting persistence
   * removes the last of those three.
   *
   * The other two are the player's own deliberate action and no web API can
   * override them, which is exactly why {@link exportToFile} exists.
   */
  async requestDurableStorage() {
    try {
      if (!navigator.storage?.persist) return false;
      if (await navigator.storage.persisted?.()) return true;
      return await navigator.storage.persist();
    } catch {
      return false;
    }
  }

  /**
   * Download the current save as a file the player owns.
   *
   * The only honest answer to "what happens if I clear my browser data" for a
   * game with no account behind it: a copy that lives outside the browser. It
   * also moves a character between machines and browsers, which nothing else
   * here can do.
   *
   * @returns {boolean} false if there was nothing to export
   */
  exportToFile({ quiet = false } = {}) {
    const data = this._read({ quiet: true });
    if (!data) {
      if (!quiet) this.bus?.emit('hud:notify', { text: 'No save to export', tone: 'warn' });
      return false;
    }
    try {
      const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      const when = new Date(data.at ?? Date.now()).toISOString().slice(0, 10);
      a.href = url;
      a.download = `aether-nexus-save-${when}.json`;
      a.click();
      // Revoked on a timer rather than immediately: some browsers have not
      // finished reading the blob when click() returns.
      setTimeout(() => URL.revokeObjectURL(url), 10_000);
      // The merged save already says "saved"; a second toast for the copy that
      // is part of the same action is noise.
      if (!quiet) this.bus?.emit('hud:notify', { text: 'Save exported', tone: 'info' });
      return true;
    } catch (err) {
      this._fail('export failed', err, { clear: false });
      return false;
    }
  }

  /**
   * Save, and put a copy where the browser cannot lose it. One action.
   *
   * Saving and exporting were two separate keys, and that split asked the
   * player to understand a distinction that is really an implementation
   * detail: "where does my progress live". It lives in the browser, and the
   * browser can be cleared, so a save that is only in the browser is half a
   * save. Doing both under one key means the answer is always "both places"
   * and there is nothing to remember.
   *
   * Only manual saves back up. The 30-second autosave stays storage-only for
   * the obvious reason - a file downloaded every thirty seconds is not a
   * backup, it is a fault.
   *
   * @param {string} [reason]
   * @returns {boolean} whether the local write succeeded; the download is
   *   best-effort and never blocks it
   */
  saveAndBackup(reason = 'manual') {
    const ok = this.save(reason);
    if (ok) this.exportToFile({ quiet: true });
    return ok;
  }

  /**
   * Load from wherever the save actually is. One action.
   *
   * Tries local storage first, because that is where it will be in almost
   * every case and a file picker in front of an ordinary reload would be an
   * obstacle. Only when there is nothing stored - a cleared browser, a new
   * machine, a different browser - does it ask for the file, which is exactly
   * the moment the player wants to be asked.
   *
   * @returns {boolean|object} whatever `load` returns, or false if it asked
   *   for a file instead (the import completes asynchronously)
   */
  loadAnywhere() {
    if (this._read({ quiet: true })) return this.load();
    this.bus?.emit('hud:notify', { text: 'No local save — choose a backup file', tone: 'info' });
    this._pickImportFile();
    return false;
  }

  /** Open a file picker and import whatever comes back. */
  _pickImportFile() {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'application/json,.json';
    input.addEventListener('change', () => {
      const f = input.files?.[0];
      if (f) this.importFromFile(f);
    });
    input.click();
  }

  /**
   * Restore from a file produced by {@link exportToFile}.
   *
   * Validated exactly as a stored save is, integrity tag included - importing
   * is not a way around the seal, it is the same door.
   *
   * @param {File} file
   * @returns {Promise<boolean>}
   */
  async importFromFile(file) {
    let data;
    try {
      data = JSON.parse(await file.text());
    } catch (err) {
      this._fail('import is not valid JSON', err, { clear: false });
      return false;
    }
    if (!this._validate(data)) {
      this.bus?.emit('hud:notify', { text: 'That file is not a valid save', tone: 'warn' });
      return false;
    }
    if (typeof data.integrity === 'string' && data.integrity !== tagOf(bodyOf(data))) {
      this.bus?.emit('hud:notify', { text: 'That save has been edited', tone: 'warn' });
      return false;
    }
    try {
      localStorage.setItem(SAVE_KEY, JSON.stringify(data));
    } catch (err) {
      this._fail('storage write refused', err, { clear: false });
      return false;
    }
    this.bus?.emit('hud:notify', { text: 'Save imported', tone: 'info' });
    return this.load();
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
    // Absent on every save written before the character menu shipped, and that
    // must stay a valid save - only a wrong *type* is a structural failure.
    if (data.character !== null && data.character !== undefined && typeof data.character !== 'object') {
      return false;
    }
    // Cosmetics arrived after the character menu; absent on older saves, and only
    // a wrong type (not absence) is a structural failure.
    if (data.cosmetics !== null && data.cosmetics !== undefined && typeof data.cosmetics !== 'object') {
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
