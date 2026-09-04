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
 * ── THE RULE THAT OUTRANKS ALL OF THAT: A READ NEVER DELETES ──────────────
 *
 * `_fail` used to default to WIPING the save, and three read paths took that
 * default: a failed `localStorage.setItem`, a `version` that was not the
 * current one, and a JSON parse error. Every one of them destroyed the last
 * known-good save on evidence that said nothing whatever about whether the
 * stored save was good:
 *
 *   - a write that was refused (quota, Safari private mode, storage disabled)
 *     is a fact about the WRITE. The bytes already on disk are untouched and
 *     are the only copy of the player's afternoon.
 *   - a version mismatch is a fact about this BUILD. It is the ordinary
 *     consequence of shipping, and the answer to it is a migration - see
 *     {@link SAVE_MIGRATIONS} - not a deletion.
 *   - a parse error is one corrupt byte in a file the player can still export,
 *     hand to a later build, or repair by hand.
 *
 * And the version case fired while merely DRAWING THE TITLE CARD, because the
 * card asks `savedAt()`. So `clear` now defaults to false and no caller asks
 * for true: throwing a save away is a thing the PLAYER does, through
 * `clear()` behind the "Start a new game instead" button.
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

/* ====================================================================== */
/* The version ladder                                                     */
/* ====================================================================== */

/**
 * How a save written by an older build becomes a save this one can read.
 *
 * ── Why this exists while it is still empty ───────────────────────────────
 *
 * There was no ladder at all, and the code that stood in for one was a single
 * equality: `_validate` refused anything whose `version` was not the current
 * `SAVE_SCHEMA`, and the refusal went to `_fail` with `clear` defaulting true.
 * So the day somebody incremented `SAVE_SCHEMA` - a one-character edit, the
 * ordinary way this file evolves - **every returning player's save would have
 * been deleted**, and deleted while merely DRAWING THE TITLE CARD, because the
 * card asks `savedAt()`, which reads. Nobody would have had to press anything.
 *
 * The payload has only ever grown - `character`, `cosmetics`, `relics`,
 * `races`, `charters`, `retention`, `caches` and the rest all arrived as new
 * keys that old saves simply lack, and `_validate` treats absence as valid for
 * exactly that reason - so there is nothing for a v1 → v2 step to DO today.
 * That is the argument for writing the ladder now rather than later: the first
 * migration this game ever needs must not also be the commit that invents the
 * mechanism, under time pressure, on the day the data is already at risk.
 *
 * ── The contract for adding one ───────────────────────────────────────────
 *
 * Bump {@link SAVE_SCHEMA} to n, and register a step under key n-1 that takes a
 * payload at n-1 and returns one at n. Steps are **pure functions of one
 * payload**: no `this`, no bus, no storage, no clock. They run in a chain, so a
 * v1 save on a v4 build walks 1→2→3→4 and each step only has to know about its
 * own neighbour. A step may mutate and return its argument; {@link migrateSave}
 * hands it a private deep copy, so a caller's object is never touched.
 *
 * A step that throws, or a version with no step registered, is NOT a licence to
 * delete: `migrateSave` returns null, `_read` reports it and keeps the bytes
 * where they are. A save this build cannot read is still a save the NEXT build,
 * or the player's exported file, might.
 *
 * @type {Readonly<Object<number, (save: any) => any>>}
 */
export const SAVE_MIGRATIONS = Object.freeze({
  /* Worked example of the shape, deliberately left commented rather than
   * deleted - the first real migration should be an edit, not an invention:
   *
   *   1: (save) => {
   *     save.credits = num(save.wallet?.credits, save.credits ?? 0);
   *     delete save.wallet;
   *     save.version = 2;
   *     return save;
   *   },
   */
});

/**
 * Walk a stored payload up the ladder to the current schema.
 *
 * Returns the migrated payload, or **null** when this build cannot get there -
 * an unregistered rung, a step that threw, or a save from a FUTURE build (a
 * player who rolled back, which no forward ladder can answer). Null means
 * "refuse", never "delete"; see the note above and {@link SaveGame#_fail}.
 *
 * A migration rewrites the body, so the integrity tag the save was sealed with
 * no longer describes it. The tag is therefore RE-SEALED here, once the walk is
 * done - the caller has already checked the original tag against the original
 * bytes, which is the only check that could ever have meant anything.
 *
 * `steps` is a parameter rather than a closed-over constant so the ladder
 * itself is testable without inventing a schema version in shipped code.
 *
 * @param {any} data a parsed payload, as stored
 * @param {{to?: number, steps?: Object<number, Function>}} [opts]
 * @returns {any|null}
 */
export function migrateSave(data, { to = SAVE_SCHEMA, steps = SAVE_MIGRATIONS } = {}) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return null;
  const from = Number(data.version);
  if (!Number.isInteger(from) || from < 1) return null;
  // A save from a build newer than this one. There is no downgrade path and
  // pretending otherwise would silently drop whatever the newer build added.
  if (from > to) return null;
  if (from === to) return data;

  /* A private copy, so a step that mutates cannot reach the caller's object -
   * `_read` hands this the parsed payload and `exportToFile` hands the result
   * straight to the player. */
  let cur;
  try {
    cur = JSON.parse(JSON.stringify(data));
  } catch {
    return null;
  }

  for (let v = from; v < to; v++) {
    const step = steps?.[v];
    if (typeof step !== 'function') return null;
    try {
      cur = step(cur);
    } catch (err) {
      console.warn(`[SaveGame] migration ${v} -> ${v + 1} threw:`, err?.message ?? err);
      return null;
    }
    if (!cur || typeof cur !== 'object' || Array.isArray(cur)) return null;
    /* The step owns the version stamp, but it is the one field a step cannot be
     * allowed to get wrong: a step that forgot it would loop the ladder for
     * ever, and one that over-stamped would skip a rung. */
    cur.version = v + 1;
  }

  // Re-seal. See the note above for why this is honest rather than a bypass.
  if (typeof cur.integrity === 'string') cur.integrity = tagOf(bodyOf(cur));
  return cur;
}

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
  constructor({
    bus, player, worldManager, economy, loadout, mounts, input, inventory, avatar, cosmetics,
    relics, viewpoints, trials, races, ships, piloting, mining, objectives, charters, onboarding,
    retention, caches,
  }) {
    this.bus = bus;
    this.player = player;
    this.worldManager = worldManager;
    this.economy = economy;
    this.loadout = loadout ?? null;
    this.mounts = mounts ?? null;
    /** @type {any} Optional - hull liveries and upgrade tiers, in worlds that have hulls. */
    this.ships = ships ?? null;
    /**
     * Where the ship is and what is in its hold.
     *
     * Restored in the same late pass as the liveries above, and for a stronger
     * version of the same reason: the ship is a thing that exists in a world,
     * and boarding one before its world is live puts it at the origin of the
     * wrong place. `Piloting.deserialize` re-enters the seat only when the
     * restored world matches the one the save was taken in - which is what
     * makes "quit mid-flight" resume mid-flight rather than in a hangar.
     * @type {any}
     */
    this.piloting = piloting ?? null;
    /**
     * Which mineral seams are already worked out.
     *
     * There are 110 nodes on Cinder and they do not come back. Exactly the note
     * `relics` carries: a finite collectible that resets is not finite.
     * @type {any}
     */
    this.mining = mining ?? null;
    /**
     * The three objectives the player asked for by name: hostiles killed,
     * bodies reached, elements assayed.
     *
     * Unlike everything either side of it this one is NOT world-local - it is a
     * career ledger that spans the yard, the void and every planet - but it
     * rides in the same probe-first arrangement and is restored in the same
     * late pass, because two of its three columns are read against what the
     * live world publishes (`encounters` for the named wings,
     * `mineralNodes` for the element roster) and a restore that landed before
     * the world would read both as empty.
     * @type {any}
     */
    this.objectives = objectives ?? null;
    /**
     * Which gateways are charted, and what each world was last seen to publish.
     *
     * Assigned rather than constructed here in `main.js`, because `Charters`
     * reads the two best-time ledgers THIS file keeps - so one of the two has
     * to be handed to the other after both exist. Same late wire `itemUse`
     * takes for `viewpoints`, and for the same reason.
     *
     * Restored in the late pass with the rest of the progress layer, and
     * deliberately LAST inside it: every charter is re-derived from the relic,
     * viewpoint, seam and best-time sets around it, so restoring it before them
     * would clamp every receipt against ledgers that were still empty and drop
     * the lot.
     * @type {any}
     */
    this.charters = charters ?? null;
    /**
     * The daily, the weekly and the season record.
     *
     * Assigned in `main.js` beside `charters`, because it reads the same board.
     * Two sets of ids - which periods were claimed, and which worlds were
     * charted inside which window - and nothing numeric: the run of consecutive
     * days is derived on read, so there is no stored number for a load to
     * disagree with.
     * @type {any}
     */
    this.retention = retention ?? null;
    /**
     * Which caches are still on their restock clock.
     *
     * Assigned in `main.js` rather than constructed here, because `Caches`
     * exists long before this file does. It is in the save for one measured
     * reason: the restock timer used to die on `world:changed`, so stepping
     * through a gateway and back refilled every cache in the world you left.
     * With the ledger persisted the 210 seconds mean 210 seconds.
     * @type {any}
     */
    this.caches = caches ?? null;
    /**
     * The opening sequence, by step id.
     *
     * Assigned in `main.js` beside `charters`. It is here rather than in its own
     * storage key because a tutorial the player has finished is progress like
     * any other, and progress that lives outside the save is progress a
     * "start fresh" would not clear.
     * @type {any}
     */
    this.onboarding = onboarding ?? null;
    this.input = input ?? null;
    /** @type {any} Optional - the game is playable without an inventory wired. */
    this.inventory = inventory ?? null;
    /** @type {any} Optional wardrobe of purchased skins. */
    this.cosmetics = cosmetics ?? null;
    /**
     * The world-local progress layer, all three optional.
     *
     * These carried NOTHING before. Thirty relics worth 3,600 CR, five named
     * viewpoints and every contest time were rebuilt from scratch on every
     * reload, so the only finite content in the game was in fact infinite and
     * the only permanent content was in fact temporary.
     *
     * Same probe-first arrangement `loadout` and `mounts` already use: if the
     * system exposes `serialize`/`deserialize` this file uses them and knows
     * nothing else about it.
     * @type {any}
     */
    this.relics = relics ?? null;
    /** @type {any} */
    this.viewpoints = viewpoints ?? null;
    /**
     * Best contest times. Optional, and when it is absent this file keeps the
     * ledger itself off `minigame:finished` - see `_trialLedger`.
     * @type {any}
     */
    this.trials = trials ?? null;
    /** @type {Map<string, {time:number, label:string, worldId:string|null}>} */
    this._trials = new Map();
    /**
     * Best circuit times. Optional, and absent by default for the same reason
     * `trials` is - see `_raceLedger`.
     *
     * The twelve minigame venues have kept a personal best since the progress
     * layer landed; the three circuits on Vellum Ridge kept NOTHING. Run the
     * Cinder Gorge on expert, win it, reload, and the game had no record it
     * happened. That is also why Vellum Ridge could not have a charter: its
     * whole job is racing, and there was no ledger for its record to be made
     * of.
     * @type {any}
     */
    this.races = races ?? null;
    /** @type {Map<string, {time:number, label:string, worldId:string|null, circuitId:string, difficulty:string}>} */
    this._races = new Map();
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
    /**
     * A load stopped part way, so the live state is NOT the stored state.
     *
     * While this is set, `_started` stays false no matter what - including
     * through the `game:started` that `main.js` emits immediately after a
     * failed load, which is precisely the event that used to arm the autosave
     * that then overwrote the intact save with a half-restored one. Cleared by
     * a clean `load()` or by a successful explicit `save()`, because both of
     * those make the two copies agree again. @see _partial
     */
    this._degraded = false;
    /** True while `_partial` is holding the autosave off, so a clean load can put it back. */
    this._autosaveSuspended = false;
    /** One corruption message per session; a broken save must not spam the console. */
    this._corruptLogged = false;
    /** @see suppressUnloadPrompt - true once the player has asked to leave. */
    this._suppressPrompt = false;
    this._lastSaveAt = 0;
    /** @type {Array<() => void>} */
    this._offs = [];

    this._onBeforeUnload = (e) => {
      // Never throws: save() is fully guarded, and an exception here would be
      // swallowed by the browser anyway - along with the save.
      this.autoSave('unload');
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

    /* ── AND THE TWO EVENTS A PHONE ACTUALLY FIRES ──────────────────────────
     *
     * `beforeunload` was the only local flush, and on mobile it is very close
     * to useless. iOS Safari and Android Chrome both evict a backgrounded tab
     * without ever firing it - that is the documented behaviour, not a bug -
     * so a phone player who switched apps lost everything since the last
     * thirty-second tick. `main.js` already knew this: it flushes the REMOTE
     * beacon on `pagehide` (`main.js:931`) precisely because `beforeunload`
     * would not arrive. The LOCAL save was simply never given the same
     * treatment, so the signed-out player - the one with nothing but the local
     * save - was the one who lost the most.
     *
     * Both, not one. `pagehide` is the last event before the page is frozen or
     * discarded and is the reliable one; `visibilitychange` → hidden fires
     * EARLIER (the moment the app is backgrounded) and is the one that lands
     * when the tab is later killed with no further events at all. They overlap
     * constantly and that costs nothing: `autoSave` is idempotent, cheap, and
     * already refuses before `game:started` and during a load.
     *
     * Optional-chained through `globalThis`: this class is constructed under
     * Node by four test files, which stub `window` and not `document`.
     */
    this._onPageHide = () => this.autoSave('pagehide');
    this._onVisibility = () => {
      if (globalThis.document?.visibilityState === 'hidden') this.autoSave('hidden');
    };
    window.addEventListener?.('pagehide', this._onPageHide);
    globalThis.document?.addEventListener?.('visibilitychange', this._onVisibility);

    if (bus) {
      /* `_degraded` outranks this. See `_partial`: the whole failure was that
       * a half-restored session armed the autosave one line after the load
       * that failed, and this is the line it armed it on. */
      this._offs.push(bus.on('game:started', () => {
        if (!this._degraded) this._started = true;
      }));
      this._offs.push(bus.on('world:changed', () => this.autoSave('world-change')));
      this._offs.push(bus.on('minigame:finished', (r) => this._recordTrial(r)));
      this._offs.push(bus.on('race:finished', (r) => this._recordRace(r)));
    }

    // On by default: the contract requires a 30 s autosave, and a feature that
    // only works if the orchestrator remembers one extra call is not a feature.
    this.enableAutosave(AUTOSAVE_DEFAULT);
  }

  /* ================================================================ */
  /* Contract surface                                                  */
  /* ================================================================ */

  /**
   * Stand down the "leave site?" prompt for a navigation the player chose.
   *
   * The prompt exists to catch Ctrl+W, which is crouch-walking - an accident.
   * The hub's "Quit to menu" is the opposite: the player picked it off a menu
   * and confirming a second time reads as the game refusing to let them go.
   * One-way and permanent for the session, because the only caller is on its
   * way out; the unload autosave still runs, so nothing is lost either way.
   */
  suppressUnloadPrompt() {
    this._suppressPrompt = true;
  }

  /**
   * Write the current game state.
   * @param {string} [reason] tag for logging / the autosave pip
   * @returns {boolean} true when the payload reached localStorage
   */
  save(reason = 'manual') {
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
      /* Quota, private-browsing, or storage disabled entirely.
       *
       * This is the site that used to DELETE the save. A refused write says
       * nothing at all about the bytes already on disk - they are untouched,
       * and they are the only copy of the session. Deleting them made a full
       * disk into total data loss. @see _fail */
      this._fail('storage write refused', err);
      return false;
    }

    /* Only now, and only on the way out of a SUCCESSFUL write.
     *
     * `_started` used to be armed on the first line of this method, on the
     * argument that "an explicit save proves the player is in the world". The
     * argument still holds - but a save that then FAILED left the flag armed
     * anyway, so a background `world:changed` could write where the explicit
     * save had just been refused. And a save that succeeded is the stronger
     * proof in any case: the stored copy now IS the live one, which is exactly
     * what `_degraded` was tracking the absence of. */
    this._started = true;
    this._degraded = false;
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
   * ── A LOAD THAT STOPS HALF WAY MUST NOT THEN BE SAVED ────────────────────
   *
   * The steps below are ordered, and each one returning false ends the load
   * where it stands. That is right - carrying on past a failed step would
   * apply the rest of the save on top of a state that no longer matches it.
   * What was wrong is what happened NEXT.
   *
   * `main.js` treats a false return as non-fatal (deliberately: a save that
   * will not apply must still let the player into the world) and goes straight
   * on to emit `game:started`, which armed `_started`. So a load that stopped
   * after the world and the position but before the economy, the bag, the
   * loadout, the mounts, the relics and the charters left the player standing
   * in the right place with none of their things - and thirty seconds later
   * the autosave wrote exactly that over the intact save it had just failed to
   * read. The player's own progress was the thing that destroyed it.
   *
   * So a partial load goes through {@link SaveGame#_partial}: the autosave is
   * switched OFF, `_started` is pinned false and pinned false against the
   * `game:started` that is about to arrive, and the player is TOLD, loudly,
   * before anything can overwrite anything. Nothing unattended writes again
   * until they make a deliberate save.
   *
   * @returns {Promise<boolean>} true when a save was found and fully applied
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
      /* `{ok, exact}` rather than a bare boolean, because "the world is up" and
       * "the world is the one the save named" are different answers and only
       * the second one licenses restoring the stored coordinates. */
      const world = await this._restoreWorld(data.world);
      if (!world.ok) {
        return this._partial(`could not restore world "${data.world ?? 'unknown'}"`);
      }

      /* The position goes back only when the world resolved EXACTLY. A save
       * naming a world this build no longer registers falls back to another
       * one, and (900, 40, -120) in the world you meant is underground, inside
       * a wall, or in open sky in the world you got. The fallback's own spawn
       * is the only coordinate that is meaningful there. */
      const playerReady = this._restorePlayer(world.exact ? data.player : null);
      if (!playerReady) {
        return this._partial('could not place the player during load');
      }
      if (!world.exact) {
        console.warn(
          `[SaveGame] saved world "${data.world}" is gone; spawning in "${world.world}"`
          + ' and leaving the stored position behind'
        );
        this.bus?.emit('hud:notify', {
          text: `That world is no longer here — you have been placed in ${world.world}`,
          tone: 'warn',
        });
      }

      const healthReady = this._restoreHealth(data.player);
      if (!healthReady) {
        return this._partial('could not restore health during load');
      }

      // Before the mounts: the rider proxy is built from the player's character
      // config, so restoring a mount first would seat the wrong person on it.
      const characterReady = this._restoreCharacter(data.character);
      if (!characterReady) {
        return this._partial('could not restore character during load');
      }

      const economyReady = this._restoreEconomy(data);
      if (!economyReady) {
        return this._partial('could not restore economy during load');
      }

      // Before the loadout: weapons report their ammo from the bag, so the bag
      // has to hold the saved contents by the time they are asked.
      const inventoryReady = this._restoreInventory(data.inventory);
      if (!inventoryReady) {
        return this._partial('could not restore inventory during load');
      }

      const loadoutReady = this._restoreLoadout(data.weapons);
      if (!loadoutReady) {
        return this._partial('could not restore loadout during load');
      }

      const mountsReady = this._restoreMounts(data.mounts);
      if (!mountsReady) {
        return this._partial('could not restore mounts during load');
      }

      this._restoreCosmetics(data.cosmetics);
      // Last, and after the world is up: see `_restoreProgress`.
      this._restoreProgress(data);
    } catch (err) {
      // Should be unreachable - every step guards itself - but a load must not
      // be the thing that kills the session.
      return this._partial('load failed', err);
    } finally {
      this._loading = false;
    }

    /* A clean load clears any degradation a previous attempt left behind: the
     * live state and the stored state agree again, so unattended writes are
     * safe. `enableAutosave` is only re-armed if `_partial` had switched it
     * off, so a caller who deliberately disabled it keeps their choice. */
    this._degraded = false;
    if (this._autosaveTimer === null && this._autosaveSuspended) {
      this._autosaveSuspended = false;
      this.enableAutosave(AUTOSAVE_DEFAULT);
    }

    const activeWorld = this.worldManager?.active?.id ?? data.world ?? null;
    this.bus?.emit('save:loaded', { at: data.at ?? Date.now(), world: activeWorld });
    this.bus?.emit('hud:notify', { text: 'Game loaded', tone: 'info' });
    return true;
  }

  /**
   * A load stopped part way. Make sure nothing writes over what is still there.
   *
   * Three things, in this order and all of them before the caller can do
   * anything else:
   *
   *  1. `disableAutosave()` - the thirty-second timer is the thing that would
   *     have done the damage, and it is switched off rather than merely
   *     guarded, so no other path can start it ticking again by accident.
   *  2. `_degraded` - which pins `_started` false *and keeps it false through
   *     the `game:started` that `main.js` is about to emit*. Without that pin
   *     the guard would arm itself one line after being set, and
   *     `world:changed` alone would then be enough to write the wreckage down.
   *  3. Say so, in words, on the HUD, with `tone: 'bad'`. The player is the
   *     only one who can decide what to do about a half-restored game, and
   *     they cannot decide anything about a failure they were not told about.
   *
   * The stored save is NOT touched. It is still the good copy, it is still
   * exportable, and the next build may well read it.
   *
   * @param {string} message
   * @param {any} [err]
   * @returns {false} so callers can `return this._partial(...)`
   */
  _partial(message, err) {
    this._degraded = true;
    this._started = false;
    if (this._autosaveTimer !== null) {
      this._autosaveSuspended = true;
      this.disableAutosave();
    }
    this._fail(message, err);
    /* Two channels on purpose. The toast is what the player NOTICES; the
     * `save:partial` event is what the HUD's standing alert bar keeps on
     * screen, because a toast that has faded is a warning the player can miss
     * entirely and this one has to still be there when they wonder why their
     * credits are wrong. */
    this.bus?.emit('save:partial', { message });
    this.bus?.emit('hud:notify', {
      text: 'Your save only partly loaded — autosave is OFF so nothing overwrites it.',
      tone: 'error',
    });
    return false;
  }

  /** @returns {boolean} true when a well-formed save is present. */
  hasSave() {
    return this._read({ quiet: true }) !== null;
  }

  /**
   * When the present save was written, as epoch ms, or null when there is no
   * usable save.
   *
   * Same validated read `hasSave` performs, so a corrupt or wrong-version
   * payload reports nothing rather than reporting a date for a save that
   * cannot be loaded. The boot card offers CONTINUE on this answer, and
   * offering a continue that then fails is worse than not offering one.
   *
   * @returns {number|null}
   */
  savedAt() {
    const data = this._read({ quiet: true });
    const at = Number(data?.at);
    return Number.isFinite(at) && at > 0 ? at : null;
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
    this._autosaveTimer = setInterval(() => this.autoSave('autosave'), period * 1000);
    return this;
  }

  /**
   * Unattended write: only once the player is in, and never mid-load.
   *
   * Public, and deliberately so. Every background persist - the periodic
   * timer, `world:changed`, `beforeunload`, and the orchestrator's debounced
   * writes on `credits:changed` / `inventory:changed` / merchant events - must
   * come through here rather than through `save()`.
   *
   * `save()` is the wrong call for anything the player did not ask for: it
   * skips both guards below, and a successful one arms `_started` on its way
   * out. A background event firing before the title screen is dismissed would
   * therefore write a pristine spawn state over the save it was about to load,
   * and leave the autosave armed to keep doing it. That is not hypothetical -
   * the boot-time `economy.set(credits, 'account-sync')` did exactly this to
   * every returning signed-in player. See
   * `scripts/tests/save-boot-order.test.mjs`.
   *
   * The `_started` guard also carries the half-restored case, because
   * {@link SaveGame#_partial} pins the flag false and holds it there through
   * the `game:started` that follows a failed load. See
   * `scripts/tests/save-durability.test.mjs`.
   *
   * @param {string} [reason] tag for logging / the autosave pip
   * @returns {boolean} true when the payload reached localStorage
   */
  autoSave(reason) {
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
    window.removeEventListener?.('pagehide', this._onPageHide);
    globalThis.document?.removeEventListener?.('visibilitychange', this._onVisibility);
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
      /* The world-local progress layer. Every one of these was missing, and a
       * finite collectible that resets is not finite. */
      relics: safe(() => this.relics?.serialize?.()) ?? null,
      viewpoints: safe(() => this.viewpoints?.serialize?.()) ?? null,
      /* Hull liveries and upgrade tiers. World-local like the two above and
       * restored in the same place, because a `Ship` only exists while the
       * world that built it is live: writing a livery before the yard is up
       * would be a write into a hull that does not exist yet. */
      ships: safe(() => this.ships?.serialize?.()) ?? null,
      /* The ship itself: which hull, where it is parked, whether the player was
       * in the seat, and the ore aboard. `Piloting.serialize` is plain JSON. */
      piloting: safe(() => this.piloting?.serialize?.()) ?? null,
      mining: safe(() => this.mining?.serialize?.()) ?? null,
      /* Kills by class, wings broken, bodies reached, elements assayed. Every
       * one of them keyed by IDENTITY rather than by a count - which is what the
       * relic ledger above got wrong for a long time, and no longer does: see
       * `Relics.serialize`, which now writes `foundIds` for the same reason. */
      objectives: safe(() => this.objectives?.serialize?.()) ?? null,
      trials: this._trialLedger(),
      /* Best circuit times, keyed `worldId/circuitId/difficulty`. New in the
       * mission drop; every save written before it simply has no key here, and
       * absence is valid - the same old-save rule `character` and `cosmetics`
       * carry. */
      races: this._raceLedger(),
      /* Which gateways are charted, plus what each world was last seen to
       * publish. No numerator: every one of those is recomputed from the
       * identity sets above. See `Charters.serialize`. */
      charters: safe(() => this.charters?.serialize?.()) ?? null,
      /* Which opening steps are done. One set of ids - see
       * `Onboarding.serialize` for why there is no index beside it. */
      onboarding: safe(() => this.onboarding?.serialize?.()) ?? null,
      /* Claimed days and weeks, and the season record. Two more sets of ids. */
      retention: safe(() => this.retention?.serialize?.()) ?? null,
      /* Which caches are still on their restock clock, and which have ever been
       * found - both keyed by site identity. Not the site LIST: placement is
       * derived from the world and rebuilds itself on entry, so a saved list of
       * positions would be a second copy of something the world already knows.
       * The two sets are separate because the clock is meant to expire and the
       * find record is not; see `Caches._found`. */
      caches: safe(() => this.caches?.serialize?.()) ?? null,
    };
  }

  /* ================================================================ */
  /* Trial times                                                       */
  /* ================================================================ */

  /**
   * Best contest times, keyed `worldId/venueId`.
   *
   * Kept here rather than in `MinigameManager` for one reason: the manager has
   * no ledger and is owned elsewhere, and a best time that lives only in a
   * running manager is lost on the world change that follows the race. The
   * moment a system with `serialize()` is passed in as `trials`, that wins and
   * this ledger is bypassed entirely - the same probe-first arrangement
   * `_snapshotWeapons` and `_snapshotMounts` already use.
   *
   * @returns {{best:Object<string,{time:number,label:string,worldId:string|null,
   *            medal?:string, replay?:object}>}|null}
   */
  _trialLedger() {
    const custom = safe(() => this.trials?.serialize?.());
    if (custom && typeof custom === 'object') return custom;
    if (!this._trials.size) return null;
    const best = {};
    for (const [key, row] of this._trials) best[key] = { ...row };
    return { best };
  }

  /**
   * Note a finished contest: the quicker TIME, and separately the better MEDAL.
   *
   * Only a WIN records. A losing run is a run the game already told the player
   * was not good enough, and a "best time" that could be set by losing is not a
   * record of anything. Guarded end to end because this is a bus handler: an
   * exception here would be swallowed by `EventBus.emit`, but the save it was
   * about to feed would silently lose the row.
   *
   * ── WHY THE MEDAL IS A SECOND BEST AND NOT A FIELD ON THE FIRST ──────────
   *
   * The guard used to be one line - `if (prev && prev.time <= time) return` -
   * and it is the right guard for a TIME. It is the wrong guard for anything
   * else on the row, and the difference is not academic: `RooftopTrial` grades
   * a finish gold/silver/bronze off a par, and a par is a function of the
   * ROUTE, so the medal a run earns is not always the medal its time implies
   * on the next visit. Left as a field of the time row, a medal would be
   * dropped by the MIN guard on every run that was slower than the best - and
   * a player who took gold on Tuesday and bronze on Wednesday would have the
   * gold quietly discarded, because Wednesday never reached the write.
   *
   * So the medal is GROW-ONLY and independent, exactly as `Charters._charters`
   * and `Caches._found` are: better replaces worse, worse is ignored, and
   * neither can take the other away. That is also what makes a repeat run at a
   * venue you already hold worth doing, which is the whole point of grading a
   * contest at all.
   *
   * ── ..and why the REPLAY follows the time rather than the medal ──────────
   *
   * The ghost a player races is their FASTEST run, so the replay is a property
   * of the time and moves with it. A slower run that upgrades the medal keeps
   * the old ghost, because the old ghost is still the harder rival.
   *
   * @param {{venueId?:string, worldId?:string, label?:string, time?:number,
   *          won?:boolean, score?:any, medal?:any, replay?:any}} r
   */
  _recordTrial(r) {
    try {
      if (!r?.won) return;
      const venueId = typeof r.venueId === 'string' ? r.venueId : null;
      if (!venueId) return;
      const time = Number(r.time);
      if (!Number.isFinite(time) || time <= 0) return;
      const worldId = typeof r.worldId === 'string' ? r.worldId : null;
      const key = `${worldId ?? '?'}/${venueId}`;
      const prev = this._trials.get(key);

      /* `score` is a bag: three contests put a clock in it, three a count, one
       * a games string, and only `RooftopTrial` a medal. `medalRank` answers 0
       * for every one of the others, so reading it here needs no flag on the
       * payload and cannot mistake a tennis scoreline for a medal. `medal` is
       * read first for a caller that names one explicitly. */
      const earned = bestMedal(r.medal, r.score);
      const medal = bestMedal(prev?.medal, earned);
      const faster = !prev || time < prev.time;
      const upgraded = medal !== (prev?.medal ?? null);
      if (!faster && !upgraded) return;

      const replay = faster ? readReplay(r.replay) : (prev?.replay ?? null);
      const row = {
        time: faster ? time : prev.time,
        /* The label is kept from whichever side already had one, the same rule
         * `mergeTrials` states: it is a display string, not progress. */
        label: prev?.label ?? (typeof r.label === 'string' ? r.label : venueId),
        worldId: prev?.worldId ?? worldId,
      };
      if (medal) row.medal = medal;
      if (replay) row.replay = replay;
      this._trials.set(key, row);
      this.bus?.emit('trial:best', {
        key,
        venueId,
        worldId,
        time: row.time,
        previous: prev?.time ?? null,
        /* Both halves, so a listener can say WHICH record moved. A run can
         * upgrade the medal without beating the clock and the notice should be
         * able to tell the player that rather than saying nothing. */
        medal,
        medalGained: upgraded ? medal : null,
        personalBest: faster,
      });
    } catch (err) {
      console.warn('[SaveGame] trial time not recorded:', err?.message ?? err);
    }
  }

  /**
   * The best recorded time for one venue, or null.
   * @param {string} venueId
   * @param {string|null} [worldId]
   */
  bestTrialTime(venueId, worldId = null) {
    const row = this._trials.get(`${worldId ?? '?'}/${venueId}`);
    return row ? row.time : null;
  }

  /**
   * The best medal ever taken at one venue, or null.
   *
   * A separate reader rather than a second return from `bestTrialTime`,
   * because the two are separate records and a caller that wants one must not
   * have to know the other exists. @see _recordTrial
   *
   * @param {string} venueId
   * @param {string|null} [worldId]
   * @returns {'gold'|'silver'|'bronze'|null}
   */
  bestTrialMedal(venueId, worldId = null) {
    const row = this._trials.get(`${worldId ?? '?'}/${venueId}`);
    return row?.medal ?? null;
  }

  /**
   * The stored ghost of the fastest run at one venue, or null.
   *
   * Handed back RAW - the caller validates it against the course it is about
   * to drive, through `GhostReplay.from`, which is the only place that can
   * know whether the route still matches. This file's job is to have kept the
   * bytes, not to have an opinion about them.
   *
   * @param {string} venueId
   * @param {string|null} [worldId]
   * @returns {object|null}
   */
  bestTrialReplay(venueId, worldId = null) {
    const row = this._trials.get(`${worldId ?? '?'}/${venueId}`);
    return row?.replay ?? null;
  }

  /**
   * The best-time ledger, in the shape `_snapshot` writes it.
   *
   * Public counterpart to `mergeTrials`, so the cross-device sync can read this
   * record without reaching into a private. @see mergeTrials
   */
  trialLedger() {
    return this._trialLedger();
  }

  /**
   * Fold another device's best times into this one's. Quicker wins, always.
   *
   * Public because this ledger has no owning system to hang a merge off - see
   * `_trialLedger`. `MinigameManager` emits and forgets, so `SaveGame` keeps the
   * record itself, and a cross-device merge therefore has to enter here.
   *
   * MIN, never replace. A slower run on a second device is not news, and a
   * last-write-wins sync would let it delete a personal best - which is the one
   * thing a record is for. The label is kept from whichever side already had
   * one, since it is a display string rather than progress.
   *
   * ── THE MEDAL MERGES SEPARATELY, AND A SILENT ROW MUST NOT ERASE IT ──────
   *
   * `ProgressSync` reads this ledger into ONE server column per venue - a
   * BIGINT of milliseconds, `trial/<world>/<venue>` - so the rows that come
   * back from a second device carry a time and NOTHING ELSE. If the merge
   * wrote the incoming row wholesale, a sync from a phone that never took a
   * medal would delete the gold this device holds, and the player would watch
   * a record disappear for having opened the game somewhere else.
   *
   * So each half takes the better of the two INDEPENDENTLY, which is the same
   * split `_recordTrial` makes for the same reason: absent is not worse, it is
   * unknown. The replay follows the faster time, because that is what it is a
   * ghost of - but a remote row has no replay at all, so a faster remote time
   * arrives with a NULL ghost and the local one is dropped rather than left
   * describing a run that is no longer the best. A ghost of a slower run than
   * the record beside it would be a rival the player has already beaten.
   *
   * @param {Record<string, {time:number, label?:string, worldId?:string,
   *          medal?:string, replay?:object}>} best
   * @returns {number} how many records this actually improved
   */
  mergeTrials(best) {
    if (!best || typeof best !== 'object' || Array.isArray(best)) return 0;
    let improved = 0;
    for (const key of Object.keys(best)) {
      const row = best[key];
      const time = Number(row?.time);
      if (!Number.isFinite(time) || time <= 0) continue;
      const prev = this._trials.get(key);
      const faster = !prev || !(Number(prev.time) <= time);
      const medal = bestMedal(prev?.medal, row.medal);
      const upgraded = medal !== (prev?.medal ?? null);
      if (!faster && !upgraded) continue;
      const replay = faster ? readReplay(row.replay) : (prev?.replay ?? null);
      const next = {
        time: faster ? time : Number(prev.time),
        label: prev?.label ?? (typeof row.label === 'string' ? row.label : ''),
        worldId: prev?.worldId ?? (typeof row.worldId === 'string' ? row.worldId : null),
      };
      if (medal) next.medal = medal;
      if (replay) next.replay = replay;
      this._trials.set(key, next);
      improved++;
    }
    return improved;
  }

  /**
   * Put a stored ledger back. Non-fatal in exactly the way the cosmetics
   * restore is: a lost best time must never stop a load.
   * @param {any} snap
   */
  _restoreTrials(snap) {
    if (!snap || typeof snap !== 'object' || Array.isArray(snap)) return;
    try {
      if (this.trials?.deserialize?.(snap)) return;
      const best = snap.best;
      if (!best || typeof best !== 'object' || Array.isArray(best)) return;
      for (const key of Object.keys(best)) {
        const row = best[key];
        const time = Number(row?.time);
        if (!Number.isFinite(time) || time <= 0) continue;
        const restored = {
          time,
          label: typeof row.label === 'string' ? row.label : key,
          worldId: typeof row.worldId === 'string' ? row.worldId : null,
        };
        /* Absent, not zeroed. A save written before medals existed has neither
         * key, and both readers already answer null for a row that lacks them -
         * so an old save loads as "no medal recorded yet" rather than as
         * "recorded, and it was nothing". */
        const medal = bestMedal(row.medal, null);
        if (medal) restored.medal = medal;
        const replay = readReplay(row.replay);
        if (replay) restored.replay = replay;
        this._trials.set(key, restored);
      }
    } catch (err) {
      console.warn('[SaveGame] trial restore skipped:', err?.message ?? err);
    }
  }

  /* ================================================================ */
  /* Circuit times                                                     */
  /* ================================================================ */

  /**
   * Best circuit times, keyed `worldId/circuitId/difficulty`.
   *
   * Three parts, not two, and the third is load-bearing. `RaceWorld` rebuilds
   * its chicanes for the grade (`setDifficulty`, `RaceWorld.js:1691`), so an
   * expert lap of the Cinder Gorge is not a standard lap with a faster field on
   * it - it is a different circuit. Keyed on the circuit alone, an easy run
   * would overwrite an expert one with a "better" time and the two would be
   * silently the same record.
   *
   * @returns {{best:Object<string,object>}|null}
   */
  _raceLedger() {
    const custom = safe(() => this.races?.serialize?.());
    if (custom && typeof custom === 'object') return custom;
    if (!this._races.size) return null;
    const best = {};
    for (const [key, row] of this._races) best[key] = { ...row };
    return { best };
  }

  /**
   * Note a finished race, keeping only the quicker of the two.
   *
   * ── A FINISH, not a win ───────────────────────────────────────────────────
   * `_recordTrial` records only a win and says why. A race is different in the
   * one way that matters: a contest is you against a rival, and a race is you
   * against ten cars on expert. Requiring first place at every grade would put
   * a whole gateway's charter behind beating the hardest AI in the game three
   * times over - "a gold nobody can reach is the same defect as a relic nobody
   * can find". So finishing counts, and only a DNF does not, because a DNF has
   * no time to be the best of.
   *
   * ── Why a missing circuit id is dropped ──────────────────────────────────
   * `RaceManager` falls back to `null` for the synthetic test circuit, which no
   * world publishes. A row keyed on that would be a personal best for a circuit
   * that does not exist, sitting in a charter's numerator against a denominator
   * that can never match it.
   *
   * Guarded end to end: this is a bus handler, and `EventBus.emit` swallows
   * exceptions - so a throw here would lose the row and say nothing.
   *
   * @param {{circuitId?:string, circuitName?:string, difficulty?:string,
   *          time?:number, dnf?:boolean, place?:number}} r
   */
  _recordRace(r) {
    try {
      if (!r || r.dnf === true) return;
      const circuitId = typeof r.circuitId === 'string' && r.circuitId.trim()
        ? r.circuitId.trim() : null;
      if (!circuitId) return;
      const time = Number(r.time);
      if (!Number.isFinite(time) || time <= 0) return;
      const difficulty = typeof r.difficulty === 'string' && r.difficulty
        ? r.difficulty : 'standard';
      const worldId = this.worldManager?.active?.id ?? null;
      const key = `${worldId ?? '?'}/${circuitId}/${difficulty}`;
      const prev = this._races.get(key);
      if (prev && prev.time <= time) return;
      this._races.set(key, {
        time,
        label: typeof r.circuitName === 'string' && r.circuitName ? r.circuitName : circuitId,
        worldId,
        circuitId,
        difficulty,
      });
      this.bus?.emit('race:best', {
        key, circuitId, difficulty, worldId, time, previous: prev?.time ?? null,
      });
    } catch (err) {
      console.warn('[SaveGame] race time not recorded:', err?.message ?? err);
    }
  }

  /**
   * The best recorded time for one circuit at one grade, or null.
   * @param {string} circuitId
   * @param {string} [difficulty]
   * @param {string|null} [worldId]
   */
  bestRaceTime(circuitId, difficulty = 'standard', worldId = null) {
    const row = this._races.get(`${worldId ?? '?'}/${circuitId}/${difficulty}`);
    return row ? row.time : null;
  }

  /** The circuit ledger, in the shape `_snapshot` writes it. @see mergeRaces */
  raceLedger() {
    return this._raceLedger();
  }

  /**
   * Fold another device's circuit times into this one's. Quicker wins, always.
   *
   * MIN, never replace, for the identical reason `mergeTrials` gives: a slower
   * run on a second device is not news, and a last-write-wins sync would let it
   * delete a personal best.
   *
   * @param {Record<string, {time:number, label?:string, worldId?:string,
   *                         circuitId?:string, difficulty?:string}>} best
   * @returns {number} how many records this actually improved
   */
  mergeRaces(best) {
    if (!best || typeof best !== 'object' || Array.isArray(best)) return 0;
    let improved = 0;
    for (const key of Object.keys(best)) {
      const row = best[key];
      const time = Number(row?.time);
      if (!Number.isFinite(time) || time <= 0) continue;
      const prev = this._races.get(key);
      if (prev && Number(prev.time) <= time) continue;
      /* The key is the authority for what this row IS, because it is what the
       * ledger merged on. The fields are display only, and are taken from
       * whichever side already had them. */
      const parts = key.split('/');
      this._races.set(key, {
        time,
        label: prev?.label ?? (typeof row.label === 'string' ? row.label : parts[1] ?? key),
        worldId: prev?.worldId ?? (typeof row.worldId === 'string' ? row.worldId : parts[0] ?? null),
        circuitId: prev?.circuitId ?? (typeof row.circuitId === 'string' ? row.circuitId : parts[1] ?? ''),
        difficulty: prev?.difficulty ?? (typeof row.difficulty === 'string' ? row.difficulty : parts[2] ?? 'standard'),
      });
      improved++;
    }
    return improved;
  }

  /**
   * Put a stored circuit ledger back. Non-fatal exactly as `_restoreTrials` is.
   * @param {any} snap
   */
  _restoreRaces(snap) {
    if (!snap || typeof snap !== 'object' || Array.isArray(snap)) return;
    try {
      if (this.races?.deserialize?.(snap)) return;
      const best = snap.best;
      if (!best || typeof best !== 'object' || Array.isArray(best)) return;
      for (const key of Object.keys(best)) {
        const row = best[key];
        const time = Number(row?.time);
        if (!Number.isFinite(time) || time <= 0) continue;
        const parts = key.split('/');
        this._races.set(key, {
          time,
          label: typeof row.label === 'string' ? row.label : parts[1] ?? key,
          worldId: typeof row.worldId === 'string' ? row.worldId : parts[0] ?? null,
          circuitId: typeof row.circuitId === 'string' ? row.circuitId : parts[1] ?? '',
          difficulty: typeof row.difficulty === 'string' ? row.difficulty : parts[2] ?? 'standard',
        });
      }
    } catch (err) {
      console.warn('[SaveGame] race restore skipped:', err?.message ?? err);
    }
  }

  /**
   * Relic tallies and synchronised viewpoints.
   *
   * Deliberately AFTER `_restoreWorld` in `load()` and deliberately non-fatal.
   * After, because both systems rebuild their per-world state from
   * `world:changed` and a restore applied before the world arrived would be
   * wiped by it. Non-fatal, because progress in a collectible is not worth
   * refusing to load a save over.
   *
   * @param {any} data the whole payload
   */
  _restoreProgress(data) {
    /* FIRST, and before anything announces. `Charters.deserialize` below
     * re-derives every record and publishes a board that can jump by a hundred
     * relics at once; the retention loop watches that channel, and without this
     * window a returning player would be handed a free daily on every boot.
     *
     * A method rather than an event, because the ordering of two subscribers on
     * one channel is not something to rest a guarantee on - and closed by
     * `resume()` at the bottom of THIS method rather than by the `save:loaded`
     * the caller emits, because that emit is skipped on the failure path and
     * the loop would stay switched off for the rest of the session. */
    this.retention?.resync?.();
    try {
      if (data.relics) this.relics?.deserialize?.(data.relics);
    } catch (err) {
      console.warn('[SaveGame] relic restore skipped:', err?.message ?? err);
    }
    try {
      if (data.viewpoints) this.viewpoints?.deserialize?.(data.viewpoints);
    } catch (err) {
      console.warn('[SaveGame] viewpoint restore skipped:', err?.message ?? err);
    }
    try {
      if (data.ships) this.ships?.deserialize?.(data.ships);
    } catch (err) {
      console.warn('[SaveGame] ship livery restore skipped:', err?.message ?? err);
    }
    /* Mining BEFORE piloting: the ledger of worked-out seams has to be in place
     * before anything re-reads the world's nodes, and `Piloting.deserialize`
     * can trigger a board, which emits into the same frame. */
    try {
      if (data.mining) this.mining?.deserialize?.(data.mining);
    } catch (err) {
      console.warn('[SaveGame] mining restore skipped:', err?.message ?? err);
    }
    try {
      if (data.piloting) this.piloting?.deserialize?.(data.piloting);
    } catch (err) {
      console.warn('[SaveGame] ship position restore skipped:', err?.message ?? err);
    }
    /* AFTER piloting, and the ordering is load-bearing in one direction only:
     * `Piloting.deserialize` can re-enter the seat, which is what makes "quit
     * mid-flight resume mid-flight" work, and `SpaceObjectives.update` refuses
     * to survey anything unless the player is in it. Restoring the ledger first
     * would leave one frame in which a ship parked inside a survey sphere was
     * not yet flown - harmless today, and free to get right. */
    try {
      if (data.objectives) this.objectives?.deserialize?.(data.objectives);
    } catch (err) {
      console.warn('[SaveGame] objective restore skipped:', err?.message ?? err);
    }
    this._restoreTrials(data.trials);
    this._restoreRaces(data.races);
    /* LAST, and the ordering is load-bearing. Every charter is re-derived from
     * the relic, viewpoint, seam, objective and best-time sets above, and
     * `Charters.deserialize` CLAMPS each restored charter against the record
     * that earned it. Restored first, every one of those clamps would run
     * against ledgers that were still empty and the whole objective would be
     * dropped on the floor by the load that was meant to restore it. */
    try {
      if (data.charters) this.charters?.deserialize?.(data.charters);
    } catch (err) {
      console.warn('[SaveGame] charter restore skipped:', err?.message ?? err);
    }
    try {
      if (data.onboarding) this.onboarding?.deserialize?.(data.onboarding);
    } catch (err) {
      console.warn('[SaveGame] onboarding restore skipped:', err?.message ?? err);
    }
    /* AFTER charters, like everything else that reads the board. The `resync`
     * at the top of this method is what stops the announcement `charters`
     * just made from reading as a day's play; the `save:loaded` emitted by the
     * caller closes that window. */
    try {
      if (data.retention) this.retention?.deserialize?.(data.retention);
    } catch (err) {
      console.warn('[SaveGame] retention restore skipped:', err?.message ?? err);
    }
    try {
      if (data.caches) this.caches?.deserialize?.(data.caches);
    } catch (err) {
      console.warn('[SaveGame] cache restock restore skipped:', err?.message ?? err);
    }
    /* The other end of the `resync` at the top. Every step between the two is
     * individually guarded, so this line is reached whatever any of them did. */
    this.retention?.resume?.();
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

  /**
   * Get the saved world live, and say whether it is the one that was asked for.
   *
   * ── Why the answer is a pair and not a boolean ────────────────────────────
   *
   * This used to `return true` from the unknown-world branch - the branch that
   * has just given up on the world the save named and activated a DIFFERENT
   * one. `load()` read that as success and went straight on to teleport the
   * player to the saved x/y/z, which is a coordinate that means something only
   * in the world it was recorded in. In any other world it is underground, or
   * inside terrain, or in open sky over a map that does not reach that far.
   * The failure was silent, immediate and total, and it looks to the player
   * exactly like the game losing them.
   *
   * Not hypothetical: a world can leave the registry between the save and the
   * load simply by being renamed, and eighteen of them are registered by loops
   * over module lists.
   *
   * `ok` is "there is a live world to stand in"; `exact` is "it is the one the
   * save meant". Only `exact` licenses the stored position - see `load()`.
   *
   * @param {string|null} id the world id the save recorded
   * @returns {Promise<{ok:boolean, exact:boolean, world:string|null}>}
   */
  async _restoreWorld(id) {
    const wm = this.worldManager;
    const live = () => wm?.active?.id ?? null;
    /* No world named, or no manager wired: nothing was asked for, so nothing
     * can have been substituted. `exact` is true and the caller restores the
     * position, which is the behaviour every existing save relies on. */
    if (typeof id !== 'string' || !id) return { ok: true, exact: true, world: live() };
    if (!wm) return { ok: true, exact: true, world: null };
    if (wm.active?.id === id) return { ok: true, exact: true, world: id };

    try {
      if (!wm.ids?.includes?.(id)) {
        const fallbackId = wm.active?.id ?? wm.ids?.[0] ?? null;
        if (!fallbackId) {
          console.warn(`[SaveGame] saved world "${id}" is not registered and no fallback world is available`);
          return { ok: false, exact: false, world: null };
        }
        console.warn(`[SaveGame] saved world "${id}" is not registered; using "${fallbackId}"`);
        await wm.build(fallbackId);
        await wm.activate(fallbackId);
        return { ok: true, exact: false, world: fallbackId };
      }
      await wm.build(id);
      await wm.activate(id);
      /* A VOLATILE WORLD IS NEVER AN EXACT RESTORE.
       *
       * `exact` decides whether `load()` hands the stored coordinates to
       * `_restorePlayer`, and its own docstring already states the rule this
       * needs: null is passed "when the world did not resolve exactly, because
       * the stored coordinates describe a world that is not the one now
       * standing". That is the maze's permanent condition. It is the one
       * volatile world, `MazeWorld.build` rolls a fresh random seed on every
       * build, and the seed is NOT in the save - so the layout the player
       * stood in cannot be reproduced even in principle, and the stored x/y/z
       * name a spot in a maze that no longer exists.
       *
       * Restoring them anyway drops the player wherever that coordinate now
       * falls: inside a hedge, inside a wall, or under the floor. Nothing
       * catches it - there is no spawn-safety or de-penetration pass here, and
       * at the moment of the teleport the district colliders around the new
       * position have not streamed in, so the physics step has nothing to push
       * them out of either. The result is a player who cannot move, in a view
       * that shows no world, on every single reload, because the same stale
       * save is restored each time.
       *
       * `exact: false` keeps the world and drops the coordinates, so the maze's
       * own entrance spawn - where `activate()` has already put them, and the
       * only position that means anything in a freshly generated maze - is
       * what stands. */
      const exact = !wm.isVolatile?.(id);
      return { ok: true, exact, world: id };
    } catch (err) {
      console.warn(`[SaveGame] could not activate world "${id}":`, err);
      return { ok: false, exact: false, world: live() };
    }
  }

  /**
   * Put the player back where they were.
   *
   * A null `snap` is a legitimate, deliberate call and not an error: `load()`
   * passes null when the world did not resolve exactly, because the stored
   * coordinates describe a world that is not the one now standing. The world's
   * own spawn - where `activate()` has already put them - is then the only
   * meaningful position, so this returns success having moved nobody.
   */
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

  /**
   * Which mount was out, and whether the player was on it.
   *
   * ── QUIT ON THE DRAGON, RELOAD, STAND ON FOOT ─────────────────────────────
   *
   * `MountManager.serialize` writes `active` INSIDE the custom blob, and the
   * blob is the only thing `_snapshotMounts` stores once `serialize` exists -
   * so `snap.active` at this level is `undefined` for every save this build
   * writes. `deserialize` reads `data.active` correctly, but it cannot summon
   * there (the world has to be live first), so it parks the id and leaves the
   * finishing to `restorePending()`. Nothing in the entire codebase called
   * `restorePending()`. And `deserialize` returned `undefined`, so the `if`
   * below fell straight through to `snap.active` - also undefined - and the
   * `else` branch DISMOUNTED the player it was supposed to be remounting.
   *
   * Three separate breaks in one path, each of which alone would have been
   * enough. Both ends are fixed: `deserialize` now returns true, and the
   * deferred summon is completed HERE, which is the one place in the program
   * that knows the world is up (`load()` runs `_restoreWorld` first, and says
   * why).
   */
  _restoreMounts(snap) {
    const mounts = this.mounts;
    if (!mounts || !snap) return true;
    try {
      if (snap.custom && mounts.deserialize?.(snap.custom)) {
        // The other half of the deferral. Idempotent: it clears its own pending
        // id, so a manager with nothing parked does nothing.
        mounts.restorePending?.();
        return true;
      }
      /* The pre-`serialize` shape, still read because a save written by an
       * older build carries it. */
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
   * Read, parse, seal-check, migrate and validate.
   *
   * Anything unexpected logs once and returns null - the caller simply carries
   * on with a fresh game. **Nothing here deletes anything**; see "A READ NEVER
   * DELETES" at the top of this file for the three paths that used to.
   *
   * ── The order of the four checks, and why it changed ──────────────────────
   *
   * The seal is now checked BEFORE the shape rather than after. It has to be:
   * the tag describes the bytes exactly as they were stored, and migration
   * rewrites them, so a tag checked after a migration would be checking a body
   * nobody ever signed. The old ordering existed so that a genuinely old save
   * reported "version 4" rather than "tampered" - and that reason is gone,
   * because an old save is no longer an error at all. It is a migration.
   *
   * A save with no tag is still accepted: every save written before the seal
   * shipped has none, and refusing those would take the progress of every
   * existing player to defend against an edit they did not make. A save with a
   * *wrong* tag is refused - that is an edited one, or a flipped byte, and both
   * mean "do not trust this", never "destroy it".
   *
   * @param {{ quiet?: boolean }} [opts]
   */
  _read({ quiet = false } = {}) {
    let raw;
    try {
      raw = localStorage.getItem(SAVE_KEY);
    } catch (err) {
      if (!quiet) this._fail('storage read refused', err);
      return null;
    }
    if (raw === null || raw === '') return null;

    let stored;
    try {
      stored = JSON.parse(raw);
    } catch (err) {
      this._fail('save is not valid JSON', err);
      return null;
    }
    if (!stored || typeof stored !== 'object' || Array.isArray(stored)) {
      this._fail('save is not an object', null);
      return null;
    }

    if (typeof stored.integrity === 'string' && stored.integrity !== tagOf(bodyOf(stored))) {
      this._fail('save failed its integrity check - it has been edited', null);
      return null;
    }

    /* Up the ladder. Null is "this build cannot read it", which covers an
     * unregistered rung, a step that threw, and a save from a NEWER build - a
     * player who rolled back, and the one case no forward ladder can answer. */
    const data = migrateSave(stored);
    if (!data) {
      this._fail(
        `save is version ${stored.version ?? '?'}, which this build cannot read`
        + ` (it reads ${SAVE_SCHEMA})`,
        null
      );
      return null;
    }

    if (!this._validate(data)) {
      this._fail('save is malformed', null);
      return null;
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
      this._fail('export failed', err);
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
    let stored;
    try {
      stored = JSON.parse(await file.text());
    } catch (err) {
      this._fail('import is not valid JSON', err);
      return false;
    }
    /* Seal first, then the ladder, then the shape - the same order and for the
     * same reason as `_read`: the tag describes the file as it was written, and
     * a migration rewrites it. A backup file is exactly the case the ladder is
     * FOR: it is the copy most likely to predate the running build. */
    if (typeof stored?.integrity === 'string' && stored.integrity !== tagOf(bodyOf(stored))) {
      this.bus?.emit('hud:notify', { text: 'That save has been edited', tone: 'warn' });
      return false;
    }
    const data = migrateSave(stored);
    if (!data || !this._validate(data)) {
      this.bus?.emit('hud:notify', { text: 'That file is not a valid save', tone: 'warn' });
      return false;
    }
    try {
      localStorage.setItem(SAVE_KEY, JSON.stringify(data));
    } catch (err) {
      this._fail('storage write refused', err);
      return false;
    }
    this.bus?.emit('hud:notify', { text: 'Save imported', tone: 'info' });
    return this.load();
  }

  /**
   * Structural check. Cheap, and it is the thing standing between us and a
   * crash.
   *
   * Runs AFTER the ladder, never instead of it. The version equality below is
   * therefore a post-condition of {@link migrateSave} rather than a gate on
   * old saves: reaching here with the wrong version means a migration step
   * returned something it should not have, not that the player is on an old
   * build. That distinction is the whole of finding 2 - the equality used to
   * be the only version handling in the file, and it reported to a `_fail`
   * that deleted.
   */
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
    /* The progress layer is newer than all of the above, so every save written
     * before it has none of these keys and must stay valid. Same rule as every
     * other late arrival: absence is fine, a wrong TYPE is not. An array counts
     * as a wrong type here - all four are keyed records, and `Object.keys` on
     * an array would happily walk its indices. */
    for (const key of ['relics', 'viewpoints', 'trials', 'objectives']) {
      const v = data[key];
      if (v === null || v === undefined) continue;
      if (typeof v !== 'object' || Array.isArray(v)) return false;
    }
    return true;
  }

  /**
   * Log once, emit `save:error`, and - only if explicitly asked - wipe.
   *
   * `clear` defaults to FALSE, and the inversion is the whole point: see the
   * "A READ NEVER DELETES" section at the top of this file for the three
   * critical paths that took the old `true` default and destroyed a save on
   * evidence that was about the write, the build, or a single byte.
   *
   * No caller in this file passes `true` today, and that is the intended state
   * rather than dead weight. The parameter stays because "delete the save" has
   * to remain something a caller can say OUT LOUD if a reason ever appears -
   * the failure mode being defended against is a default nobody typed, not the
   * ability to ask. Anything that does pass it is a data-loss decision and
   * should read like one at the call site.
   *
   * Never throws: this runs from `beforeunload` and from the frame loop.
   */
  _fail(message, err, { clear = false } = {}) {
    if (!this._corruptLogged) {
      this._corruptLogged = true;
      console.warn(
        `[SaveGame] ${message}${err ? `: ${err.message ?? err}` : ''}`
        + `${clear ? ' - resetting save.' : ' - the stored save is left where it is.'}`
      );
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

/**
 * The medal ladder, weakest first, as an ORDER rather than a set.
 *
 * Exported because three files have to agree about which of two medals is
 * better - this one merging a repeat run, `Charters` counting golds, and
 * `RecordsPanel` filling a grid up to the best - and three independent
 * `gold > silver > bronze` comparisons is three chances for one of them to
 * sort the other way. It is deliberately NOT `MEDAL_FACTOR` from
 * `RooftopTrial`: that table is a time multiplier and lists them in the
 * opposite order, so borrowing it would put bronze at the top.
 *
 * @type {ReadonlyArray<'bronze'|'silver'|'gold'>}
 */
export const MEDAL_ORDER = Object.freeze(['bronze', 'silver', 'gold']);

/**
 * How good a medal is, as a number. 0 for anything that is not one.
 *
 * The zero branch is load-bearing rather than defensive: `minigame:finished`
 * carries `score`, and `score` is a clock in three contests, a count in three,
 * a games string in one and a medal in exactly one. A rank of 0 for all of
 * those is what lets `_recordTrial` read the field without a flag saying
 * whether it means anything this time.
 *
 * @param {any} m
 * @returns {number}
 */
export function medalRank(m) {
  return typeof m === 'string' ? MEDAL_ORDER.indexOf(m) + 1 : 0;
}

/** The better of two medals, or null when neither is one. */
export function bestMedal(a, b) {
  const ra = medalRank(a);
  const rb = medalRank(b);
  if (ra === 0 && rb === 0) return null;
  return ra >= rb ? a : b;
}

/**
 * A stored ghost, shape-checked but NOT validated against a route.
 *
 * This file keeps bytes; `GhostReplay.from` decides whether they describe the
 * course about to be run, because only the caller standing on that course
 * knows. What is checked here is the one thing a persistence layer must check
 * on its own behalf: that the thing about to be written into the save is small
 * and is not something else entirely. An unbounded `s` from a hand-edited
 * localStorage entry would otherwise be copied back out on every autosave.
 *
 * @param {any} r
 * @returns {{v:number,k:string,d:number,s:number[]}|null}
 */
function readReplay(r) {
  if (!r || typeof r !== 'object' || Array.isArray(r)) return null;
  const v = Number(r.v);
  const k = r.k;
  const d = Number(r.d);
  const s = r.s;
  if (!Number.isFinite(v) || v <= 0) return null;
  if (typeof k !== 'string' || !k || k.length > 128) return null;
  if (!Number.isFinite(d) || d <= 0) return null;
  if (!Array.isArray(s) || s.length < 4 || s.length % 2 !== 0 || s.length > 256) return null;
  const out = new Array(s.length);
  for (let i = 0; i < s.length; i++) {
    const n = Number(s[i]);
    if (!Number.isFinite(n)) return null;
    out[i] = n;
  }
  return { v, k, d, s: out };
}
