/**
 * THE ACTIVE-EFFECT LEDGER: what is running on the player right now.
 *
 * -- The problem this exists for -------------------------------------------
 *
 * Seven of the bag's consumables buy the player a DURATION - thirty seconds of
 * doubled speed, five of a shield, sixty of a frozen crowd, thirty of a widened
 * gun on a ship - and until this
 * file the only acknowledgement any of them got was a toast that lives 3.6 s
 * (`TOAST_LIFE`, in `ui/HUD.js`). A player who used a Time Lock Prism watched
 * the message fade with fifty-six of its sixty seconds still to run, and from
 * then on the interface said nothing at all about the effect they had paid 108
 * credits for. There was no way to tell an expired buff from a running one
 * except by playing carefully enough to feel the difference.
 *
 * -- Why the HUD does not simply read the systems ---------------------------
 *
 * Because it cannot. `HUD` is constructed with the player, the world manager,
 * the NPC manager and the portals, and with NOTHING ELSE - no `Combat`, no
 * `Loot` - and `HUD.attach()`, which would hand it the rest, IS NEVER CALLED
 * ANYWHERE IN THIS REPOSITORY. Its `_updateSystems` poll therefore resolves
 * every late-bound system off `window.GAME`, and `window.GAME` only exists
 * under `?dev=1` (main.js: `if (overrides.dev)`). A polled indicator would
 * have worked perfectly for the screenshot harness, which runs with `?dev=1`,
 * and been dead for every real player. So the ledger is PUSHED to the HUD over
 * the bus, and the HUD holds no system reference at all.
 *
 * -- One clock --------------------------------------------------------------
 *
 * `endsAt` is in seconds of `engine.simElapsed` - PLAY time, which stops while
 * a UI panel holds gameplay. Not `engine.elapsed`, and not `player._elapsed`.
 * Every one of the owning systems now writes its own deadline against that
 * same clock (`_buffNow()` in `Player`, `Combat`, `Loot`, `NPCManager`,
 * `Portals` and `ships/SpaceCombat`), which is what makes the chip on screen
 * and the effect it describes incapable of disagreeing. See `core/Engine.js`.
 *
 * -- Why the ledger owns expiry rather than the five systems ----------------
 *
 * Because there is one deadline per kind and six different places that could
 * notice it passing, each inside an update that is itself gated on gameplay
 * not being blocked. Six expiry announcements would be six chances to
 * disagree about a number they all derive identically. One `update()` over one
 * map, on the one clock, cannot.
 */

/**
 * The effects that get a chip, and how each is presented.
 *
 * KEYED BY THE `type` `ItemUse._effectFor` PUBLISHES, so an effect that exists
 * in the game and not here shows no chip rather than a wrong one, and an entry
 * here with no effect behind it can never be started. `heal` and `chart` are
 * absent on purpose: a medkit and a nav chart are instantaneous - they change
 * the world once and there is nothing left running to count down. `chart` in
 * particular is a PERMANENT map reveal, so a countdown against it would be
 * inventing an expiry the game does not have.
 *
 * `tag` is the same short badge `ItemDefs` already prints on the item itself
 * (`short`), so the chip and the bag row speak one vocabulary.
 */
export const EFFECT_KINDS = {
  speed: { tag: 'SPD', label: 'Speed' },
  shield: { tag: 'SHLD', label: 'Shield' },
  firepower: { tag: 'POWR', label: 'Firepower' },
  magnet: { tag: 'LOOT', label: 'Loot magnet' },
  pauseNpcs: { tag: 'STAS', label: 'Stasis' },
  portalPing: { tag: 'PING', label: 'Gatefinder' },
  gunSpread: { tag: 'WIDE', label: 'Wide dispersal' },
};

/**
 * What a world change actually ends.
 *
 * NOT "everything". `Combat.reset()` is wired to `world:changed` and zeroes the
 * damage boost, and a gateway ping lives on a portal object that is thrown away
 * and rebuilt with the new world - so those two really are over. A speed boost,
 * a shield, a magnet and a stasis field are all held in fields nothing resets
 * on a traversal, so they really do follow the player through the gate, and
 * clearing their chips would be the indicator lying in the tidy direction
 * rather than not lying.
 */
const ENDED_BY_WORLD_CHANGE = ['firepower', 'portalPing'];

/* WHY `gunSpread` IS IN NEITHER LIST, WHICH IS A STATEMENT ABOUT SpaceCombat.
 *
 * The rule both lists are written under is that they must describe what the
 * owning system ACTUALLY does, so the temptation to add a seventh entry to one
 * of them for tidiness is the exact failure they exist to prevent. Traced,
 * rather than assumed:
 *
 *   A WORLD CHANGE. `SpaceCombat._adopt` is what listens, and all it does is
 *   swap the encounter zones and `standDown` the wing. It does not touch
 *   `_spreadBolts`, and there is no `SpaceCombat.reset()` for `world:changed`
 *   to call - the object outlives every traversal. So a pilot who buys thirty
 *   seconds of fan, docks at the yard and launches again really does still
 *   have it, and a chip that vanished at the gate would be the indicator
 *   lying in the tidy direction.
 *
 *   A RESPAWN. `Player.respawn` clears `_speedBoostUntil` and `_invulnUntil`
 *   and nothing else; it has never had a reference to `SpaceCombat`. Dying in
 *   the seat runs `Piloting._onDied`, which flies the hull home and raises
 *   `pilot:left` - and `SpaceCombat`'s handler for that is `standDown`, which
 *   retires hostiles and clears the interdiction and, again, does not touch
 *   the fan.
 *
 * So the deadline is the only thing that ends it, on both sides, which is what
 * makes the chip honest. `ItemUse` is where the effect is stopped from being
 * STARTED somewhere it would do nothing: `SpaceCombat.canWidenGuns()` is asked
 * before the cell leaves the bag. */

/**
 * What a respawn ends: exactly what `Player.respawn` clears.
 *
 * It sets `_speedBoostUntil = 0` and overwrites `_invulnUntil` with the spawn
 * grace, which is not the shield the player bought - so both chips go. Nothing
 * in `respawn` touches the magnet, the crowd or a lit gateway.
 */
const ENDED_BY_RESPAWN = ['speed', 'shield'];

export class ActiveEffects {
  /**
   * @param {{ bus?:any, engine?:any, clock?:(() => number) }} ctx
   *   `clock` overrides the engine reading. It exists so the unit tests can
   *   drive play time by hand, and for no other reason.
   */
  constructor({ bus, engine, clock } = {}) {
    this.bus = bus ?? null;
    this.engine = engine ?? null;
    this._clock = typeof clock === 'function' ? clock : null;
    /**
     * @type {Map<string, {id:string, kind:string, label:string, tag:string,
     *   duration:number, endsAt:number}>}
     */
    this._active = new Map();
    this._offs = [];

    const on = (type, fn) => {
      const off = this.bus?.on?.(type, fn);
      if (off) this._offs.push(off);
    };
    on('world:changed', () => this.end(ENDED_BY_WORLD_CHANGE));
    on('player:respawned', () => this.end(ENDED_BY_RESPAWN));
  }

  /**
   * Play time, in seconds.
   * @returns {number}
   */
  now() {
    if (this._clock) return this._clock();
    return this.engine?.simElapsed ?? 0;
  }

  /** Every running effect, in the order the chips are drawn. A snapshot. */
  list() {
    return [...this._active.values()];
  }

  /** True while an effect of this kind is running. */
  has(kind) {
    return this._active.has(kind);
  }

  /**
   * Record an effect that has just been applied, and announce it.
   *
   * ONE ENTRY PER KIND, and the deadline only ever moves FORWARD. That is not a
   * simplification - it is what every owning system already does. `boostSpeed`,
   * `setMagnet`, `pauseFor`, `boostPlayerDamage`, `grantIFrames` and
   * `pingNearest` all raise their deadline with `Math.max`, so a second charge
   * on a running effect extends the one effect rather than starting a second.
   * A second chip would be a second thing that does not exist.
   *
   * @param {string} kind one of `EFFECT_KINDS`
   * @param {number} duration seconds
   * @param {string} [label] the item the player just used, for the chip title
   * @returns {boolean} false for an unknown kind or a duration that is not a
   *   positive finite number - both of which mean there is nothing to count.
   */
  start(kind, duration, label) {
    const def = EFFECT_KINDS[kind];
    if (!def || !(duration > 0) || !Number.isFinite(duration)) return false;

    const prior = this._active.get(kind);
    const endsAt = Math.max(prior?.endsAt ?? 0, this.now() + duration);
    const entry = {
      id: kind,
      kind,
      label: label || def.label,
      tag: def.tag,
      duration,
      endsAt,
    };
    /* Deleted before it is set so the map's iteration order puts the freshest
     * chip LAST, which is the order the HUD draws them in. A chip that
     * re-appeared in the middle of the row would shift every neighbour
     * sideways, and the eye reads that as the whole row changing rather than
     * as one thing being renewed. */
    this._active.delete(kind);
    this._active.set(kind, entry);
    this.bus?.emit('effect:started', { ...entry });
    return true;
  }

  /**
   * Retire one or more kinds now, whatever their deadline said.
   * @param {string|string[]} kinds
   */
  end(kinds) {
    const list = Array.isArray(kinds) ? kinds : [kinds];
    for (const kind of list) {
      const entry = this._active.get(kind);
      if (!entry) continue;
      this._active.delete(kind);
      this.bus?.emit('effect:ended', { id: entry.id, kind: entry.kind });
    }
  }

  /** Retire everything, announcing each. */
  clear() {
    this.end([...this._active.keys()]);
  }

  /**
   * Retire whatever the clock has passed. Cheap enough to call every frame:
   * the map holds at most six entries and usually none.
   *
   * Takes no arguments on purpose. A `now` parameter would be a second place a
   * caller could disagree with `start()` about what time it is, and the whole
   * point of this file is that there is only one.
   */
  update() {
    if (this._active.size === 0) return;
    const now = this.now();
    for (const entry of [...this._active.values()]) {
      if (now >= entry.endsAt) this.end(entry.kind);
    }
  }

  dispose() {
    for (const off of this._offs) {
      try {
        off();
      } catch {
        /* a bus that already cleared its handlers is not an error */
      }
    }
    this._offs.length = 0;
    this._active.clear();
  }
}
