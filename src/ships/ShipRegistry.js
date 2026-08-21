import { cloneLivery, normColor, FINISH_PROPS } from '../mounts/Livery.js';
import { SHIP_SLOTS, SHIP_STATS, SHIP_ORDER, SHIP_SKINS_BY_ID } from './ShipStats.js';

/**
 * Who owns which hull's colours and upgrade tiers.
 *
 * A faithful clone of `MountManager`'s livery/powers half (`:629-765`,
 * `:1727-1785`) with the mount-shaped parts removed, because every one of the
 * behaviours in that half is a bug somebody already found in play:
 *
 * - **mid-migration tolerance.** `_knownSlot`/`_knownStat` return `true` when a
 *   hull declares no slots or stats at all, so an intermediate commit that adds
 *   a hull before its tables keeps working instead of silently dropping writes.
 * - **`sellsPower` is public.** The marketplace has to be able to REFUSE a
 *   purchase rather than take the money and silently drop the grant.
 * - **no-op patches are suppressed.** A patch that changes nothing — an unknown
 *   colour, a redundant finish, an empty object — never touches the hull and
 *   never emits, so dragging a colour picker cannot trigger a persist per frame.
 * - **an emptied bag is deleted, on write AND on deserialize.** `grantPower`
 *   lazily allocates only when a stat sticks, so a save round-trip that filters
 *   every stat out must clear the entry rather than leave `{}` behind.
 *
 * ── The precondition is different from a mount's, and that is the point ──
 * A mount is RIDDEN: `MountMenu` gates on `mounts.mounted && mounts.active`.
 * A dock ship is SELECTED. It stands on a cradle in a shed and the player walks
 * round it, so the lifecycle is "which of the hulls in this world am I looking
 * at", not "what am I sitting on". That is why this class knows about a world's
 * `ships` array and a mount manager does not.
 *
 * ── How hulls arrive ─────────────────────────────────────────────────────
 * Off a published field, exactly as `Relics`, `Caches`, `Viewpoints` and
 * `MinigameManager` all do: on `world:changed` this reads `world.ships` and
 * registers whatever is there. Nothing in `DockWorld` knows this class exists,
 * and a world that publishes no hulls simply has none.
 */
export class ShipRegistry {
  constructor({ bus = null, worldManager = null } = {}) {
    this.bus = bus;
    this.worldManager = worldManager;
    /** @type {Object<string, object>} */
    this._liveries = {};
    /** @type {Object<string, object>} */
    this._powers = {};
    /** @type {Map<string, import('./Ship.js').Ship>} */
    this._ships = new Map();
    /** The hull the panel opens on. Null when the player is not in a yard. */
    this._selected = null;

    this._onWorld = () => this._adopt();
    if (bus) this._offWorld = bus.on('world:changed', this._onWorld);
    // A registry constructed after the first world change still finds the hulls.
    this._adopt();
  }

  /* ================================================================ */
  /* Hulls in the world                                                */
  /* ================================================================ */

  /**
   * Pick up whatever hulls the live world publishes.
   *
   * Replace semantics, not merge: a world change means the old hulls' materials
   * are being disposed, and holding a `Ship` whose clones have been freed is a
   * livery write into a dead uniform.
   */
  _adopt() {
    /* `active`, not `current`.
     *
     * THE REGISTRY WAS DEAD. `WorldManager` publishes `get active()` and has
     * never had a `current`, so this read `undefined` on every world change and
     * on construction - `_ships` stayed empty forever, `canCustomise` was
     * always false, and every livery and upgrade tier the player bought was
     * stored in `_liveries`/`_powers` and applied to nothing at all. That is
     * `Dragon.js`'s recorded failure exactly: tiers banked, persisted,
     * re-emitted, and landing on no object.
     *
     * It survived because `ship-customizer.test.mjs` builds its own stub
     * (`{ current: { ships } }`) and so pinned the wrong property name in both
     * places at once - a test that could not fail against the real manager.
     * `current` is kept as a fallback so that stub, and anything else duck-typed
     * against it, still works. */
    const world = this.worldManager?.active ?? this.worldManager?.current ?? null;
    const list = Array.isArray(world?.ships) ? world.ships : [];
    this._ships.clear();
    for (const s of list) {
      if (!s?.id) continue;
      this._ships.set(s.id, s);
      // Whatever the player already owns has to land on the new instance, or a
      // portal round trip silently repaints every hull back to factory.
      s.applyCustomization?.(this._liveries[s.id] ?? {});
      s.applyPowers?.(this._powers[s.id] ?? {});
    }
    const keep = this._selected && this._ships.has(this._selected);
    this._selected = keep ? this._selected : (this.hulls()[0]?.id ?? null);
    this.bus?.emit?.('ship:available', { ships: this.hulls().map((s) => s.id) });
  }

  /** The hulls in the live world, in menu order. */
  hulls() {
    const out = [];
    for (const id of SHIP_ORDER) {
      const s = this._ships.get(id);
      if (s) out.push(s);
    }
    // Anything published that is not in the canonical order still shows up,
    // after the known hulls, rather than vanishing from the panel.
    for (const [id, s] of this._ships) if (!SHIP_ORDER.includes(id)) out.push(s);
    return out;
  }

  /** True when there is a hull to customise here at all. */
  get canCustomise() { return this._ships.size > 0; }

  /** The hull the panel is pointed at, or null. */
  get selected() { return this._selected ? this._ships.get(this._selected) ?? null : null; }
  get selectedId() { return this._selected; }

  /** Point the panel at a hull. A no-op for one that is not in this world. */
  select(shipId) {
    if (!shipId || !this._ships.has(shipId) || shipId === this._selected) return false;
    this._selected = shipId;
    this.bus?.emit?.('ship:selected', { shipId });
    return true;
  }

  /* ================================================================ */
  /* Slots and stats                                                   */
  /* ================================================================ */

  /**
   * True unless this hull declares slots and `slot` is not one of them. A hull
   * mid-migration (no table yet) accepts every slot id, so an intermediate
   * commit keeps working.
   */
  _knownSlot(shipId, slot) {
    const slots = SHIP_SLOTS[shipId];
    if (!slots) return true;
    return slots.some((s) => s.id === slot);
  }

  /** The stat twin of {@link _knownSlot}. */
  _knownStat(shipId, stat) {
    const stats = SHIP_STATS[shipId];
    if (!stats) return true;
    return stats.includes(stat);
  }

  /**
   * Public twin of {@link _knownStat}, for a caller outside this class.
   *
   * The marketplace needs to REFUSE rather than take the money and drop the
   * grant on the floor, which is the same rule `grantPower` and `deserialize`
   * already apply internally.
   */
  sellsPower(shipId, stat) { return this._knownStat(shipId, stat); }

  /**
   * Merge a livery patch into one hull and apply it live.
   *
   * `patch` is `{ [slotId]: { color?, finish? } }`; `finish: null` clears the
   * finish. A patch that changes nothing is a no-op: it never touches the hull
   * and never emits `ship:livery`, so a colour-picker drag cannot fire a
   * persist per frame. If the patch empties a hull's last slot the whole entry
   * is dropped rather than left as `{}`.
   */
  setLivery(shipId, patch = {}) {
    if (!shipId || !patch || typeof patch !== 'object') return;
    const cur = this._liveries[shipId] || {};
    let changed = false;
    for (const slot in patch) {
      const p = patch[slot];
      if (!p || typeof p !== 'object') continue;
      if (!this._knownSlot(shipId, slot)) continue;
      const before = cur[slot] ? JSON.stringify(cur[slot]) : undefined;
      const s = cur[slot] || (cur[slot] = {});
      const c = normColor(p.color);
      if (c != null) s.color = c;
      if (p.finish === null) delete s.finish;
      else if (FINISH_PROPS[p.finish]) s.finish = p.finish;
      if (!Object.keys(s).length) delete cur[slot];
      const after = cur[slot] ? JSON.stringify(cur[slot]) : undefined;
      if (before !== after) changed = true;
    }
    if (!changed) return;
    if (Object.keys(cur).length) this._liveries[shipId] = cur;
    else delete this._liveries[shipId];
    this._ships.get(shipId)?.applyCustomization?.(cur);
    this.bus?.emit?.('ship:livery', { shipId, livery: cloneLivery(cur) });
  }

  /** Current livery for one hull (deep copy; `{}` when untouched). */
  getLivery(shipId) { return cloneLivery(this._liveries[shipId]); }

  /** Back to factory. A no-op, with no emit, on a hull that had none. */
  resetLivery(shipId) {
    if (!shipId || !this._liveries[shipId]) return;
    delete this._liveries[shipId];
    this._ships.get(shipId)?.applyCustomization?.({});
    this.bus?.emit?.('ship:livery', { shipId, livery: {} });
  }

  /**
   * Paint one of the yard's schemes onto a hull.
   *
   * Refuses on an unknown id and on a scheme belonging to another hull, rather
   * than half-applying: `MountSkins.js:26-28` records the ordering rule this
   * follows — refuse BEFORE anything is consumed, because a purchase must never
   * be consumed with nowhere for it to land. Nothing is consumed here yet (see
   * the note on `SHIP_SKINS`), and the order is kept anyway so that the day a
   * bag item is wired in, the refusal is already in the right place.
   */
  applyScheme(shipId, skinId) {
    const skin = SHIP_SKINS_BY_ID.get(skinId);
    if (!skin) return { ok: false, reason: 'unknown-scheme' };
    if (skin.ship !== shipId) return { ok: false, reason: 'wrong-ship' };
    if (!this._ships.has(shipId)) return { ok: false, reason: 'not-here' };
    this.setLivery(shipId, skin.livery);
    return { ok: true };
  }

  /**
   * Grant an upgrade tier. A stat this hull does not sell is dropped silently —
   * never stored, never emitted — exactly as an unknown livery slot is.
   */
  grantPower(shipId, stat, tier = 1) {
    if (!shipId || !stat) return;
    if (!this._knownStat(shipId, stat)) return;
    const bag = this._powers[shipId] || (this._powers[shipId] = {});
    bag[stat] = Math.max(bag[stat] || 0, tier);
    this._ships.get(shipId)?.applyPowers?.({ ...bag });
    this.bus?.emit?.('ship:powers', { shipId, powers: { ...bag } });
  }

  /** Owned tiers for one hull (copy), or every hull if no id is given. */
  getPowers(shipId) {
    if (shipId) return { ...(this._powers[shipId] || {}) };
    const out = {};
    for (const k in this._powers) out[k] = { ...this._powers[k] };
    return out;
  }

  /* ================================================================ */
  /* Persistence (the shape `SaveGame` expects)                        */
  /* ================================================================ */

  serialize() {
    return {
      liveries: Object.fromEntries(
        Object.keys(this._liveries).map((id) => [id, cloneLivery(this._liveries[id])])
      ),
      powers: this.getPowers(),
      selected: this._selected,
    };
  }

  deserialize(data) {
    if (!data) return;
    if (data.liveries && typeof data.liveries === 'object') {
      for (const sid in data.liveries) {
        const l = cloneLivery(data.liveries[sid]);
        for (const slot in l) if (!this._knownSlot(sid, slot)) delete l[slot];
        if (!Object.keys(l).length) continue;
        this._liveries[sid] = l;
        this._ships.get(sid)?.applyCustomization?.(l);
      }
    }
    if (data.powers && typeof data.powers === 'object') {
      for (const sid in data.powers) {
        const bag = data.powers[sid];
        if (!bag || typeof bag !== 'object') continue;
        // The same filter `grantPower` applies, so a save cannot smuggle in a
        // stat the hull never sold.
        const owned = {};
        for (const p in bag) if (this._knownStat(sid, p)) owned[p] = bag[p];
        /* A bag that lost every stat to the filter must NOT persist as an empty
         * {}: `grantPower` never creates one, so a save round trip must not
         * either. Replace semantics per hull id — an empty result clears any
         * bag already loaded, rather than leaving a stale one in place. */
        if (!Object.keys(owned).length) { delete this._powers[sid]; continue; }
        this._powers[sid] = owned;
        this._ships.get(sid)?.applyPowers?.({ ...owned });
      }
    }
    if (typeof data.selected === 'string' && this._ships.has(data.selected)) {
      this._selected = data.selected;
    }
  }

  dispose() {
    this._offWorld?.();
    this._offWorld = null;
    this._ships.clear();
  }
}
