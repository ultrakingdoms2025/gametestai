import { ITEMS, itemDef, sellValue, setMarketWorld, skinIdFromItem } from './ItemDefs.js';
import { offlineCatalog } from './MarketplaceOffline.js';
import { WEAPON_POWERS } from './WeaponStats.js';
import { activeShipRegistry } from '../ships/ShipRegistry.js';
import { allows } from '../worlds/WorldRules.js';

/**
 * Vendor trading: buy ammo packs, sell salvage back at a loss.
 *
 * The trading rules are deliberately paranoid, because a shop is where an
 * economy bug becomes permanent:
 *
 *  - Space is validated *before* credits are spent, and whatever the inventory
 *    refuses is refunded in the same call, so a full bag can never eat money.
 *  - Every debit goes through `Economy.spend`, which refuses to go below zero;
 *    nothing here ever writes the balance directly.
 *  - A sale removes the goods first and only then pays, so a failed removal
 *    cannot mint credits.
 *
 * Opening is gated on standing near a vendor. Until the NPC agent lands
 * explicit vendor roles we also recognise one by trade-sounding name or
 * persona, so the feature is usable today and gets stricter for free later.
 */

/** How close the player must be to a vendor for `B` to work, in metres. */
const VENDOR_RANGE = 7;
/** Re-scan for a nearby vendor at 5 Hz; a per-frame scan of 24 NPCs is waste. */
const SCAN_INTERVAL = 0.2;

/** Names/personas that read as a trader before roles exist. */
const VENDOR_WORDS =
  /vendor|trader|merchant|quartermaster|shopkeep|stall|market|supply|supplies|rations|clerk|smith|fletcher|cooper|apothec|armou?rer|barter|wares|pedlar|peddler|outfitter|kit\b/i;

/**
 * Every catalogue category the marketplace ships.
 *
 * Mirrors `MARKETPLACE_CATEGORIES` in `site/lib/marketplaceCatalog.ts`; a vendor
 * that authors no restriction sells all of them, which is what the shop has
 * always done.
 */
const ALL_CATEGORIES = ['cosmetic', 'weapons', 'tools', 'health', 'spells', 'mounts', 'ships'];

const MARKETPLACE_CONSUMABLE_ITEMS = {
  spell_velocity_25: 'speed_boost_25',
  spell_velocity_50: 'speed_boost_50',
  spell_velocity_75: 'speed_boost_75',
  spell_velocity_100: 'speed_boost_100',
  spell_loot_grab_30: 'loot_magnet_30s',
  spell_portal_ping_30: 'portal_ping_30s',
  spell_stasis_5s: 'npc_pause_5s',
  spell_stasis_10s: 'npc_pause_10s',
  spell_stasis_30s: 'npc_pause_30s',
  spell_stasis_60s: 'npc_pause_60s',
  shield_5s: 'shield_5s',
  firepower_boost_25: 'firepower_boost_25',
  firepower_boost_50: 'firepower_boost_50',
  firepower_boost_75: 'firepower_boost_75',
  firepower_boost_100: 'firepower_boost_100',
  /* The three damage-reduction wards, wired exactly like the four firepower
   * rows above them because that is what they are the mirror of - one entry per
   * item, keyed by the bare `source_key` the catalogue authors. */
  ward_20: 'ward_20',
  ward_35: 'ward_35',
  ward_50: 'ward_50',
  /* The four stamina draughts. THE KEY ON THE LEFT IS THE CATALOGUE
   * `source_key` AND THE ID ON THE RIGHT IS THE BAG ITEM, and here they are
   * genuinely different strings rather than the same one twice: the actions
   * `stamina_slowdown_*` were authored years before the items and the
   * catalogue rows are keyed to them, while `ItemDefs` names the things a
   * player actually carries. Both halves are pinned by a test for exactly that
   * reason - a mapping that looks like a typo is a mapping somebody will
   * "correct". */
  stamina_slowdown_25: 'stamina_draught_25',
  stamina_slowdown_50: 'stamina_draught_50',
  stamina_slowdown_75: 'stamina_draught_75',
  stamina_slowdown_100: 'stamina_draught_100',
};

/**
 * Resolve a catalogue `source_key` to the inventory item a purchase grants.
 *
 * The key arriving from the API is *not* the bare seed key. `buildMarketplaceSeedItems`
 * in `site/lib/marketplaceCatalog.ts` seeds one row per world and stamps the
 * world onto the key - `spell_velocity_25` is stored as `spell_velocity_25:station` -
 * and nothing between the DB row and this module strips it (`rowToItem` and the
 * `/api/marketplace/items` route both pass `source_key` straight through). An
 * exact-key lookup therefore misses every consumable; only the four `pack_*`
 * rows survived, because those are matched with `startsWith`.
 *
 * So: probe the exact key first, so an item whose real key legitimately contains
 * a colon still wins, and only then retry without the trailing `:<world>`. Do
 * not "simplify" this back to a single exact lookup - every spell, shield and
 * firepower boost silently becomes `reason: 'unsupported'` again if you do.
 *
 * @param {string} key
 * @returns {string|null}
 */
export function consumableItemFor(key) {
  // Own-property only: a `source_key` of `constructor` must not resolve to a
  // function off Object.prototype.
  const has = (k) => Object.prototype.hasOwnProperty.call(MARKETPLACE_CONSUMABLE_ITEMS, k);
  if (has(key)) return MARKETPLACE_CONSUMABLE_ITEMS[key];
  const cut = key.lastIndexOf(':');
  if (cut <= 0) return null;
  const bare = key.slice(0, cut);
  return has(bare) ? MARKETPLACE_CONSUMABLE_ITEMS[bare] : null;
}

/**
 * What a `grant_mount_power` config grants: the mount (the car when unnamed -
 * the original nine `mount_*` rows predate any other mount having a ladder),
 * the power (required), and a tier clamped to at least I.
 *
 * A module function rather than a method because TWO callers read it and
 * must never disagree: `Marketplace._mountPowerGrant` for a purchase, and
 * `grantForPlacement` in `MapOverlay.js` for a mount upgrade the map editor
 * laid down as a pickup. Collecting that pickup emits the same
 * `mount:power:buy` a purchase does, so the grant it carries has to be the
 * one a purchase would have carried.
 *
 * @param {any} config a row's `action_config` (or a place entry's copy of it)
 * @returns {{mount:string, power:string, tier:number}|null}
 */
export function mountPowerGrantFor(config) {
  if (config?.effect !== 'grant_mount_power') return null;
  const mount = typeof config.mount === 'string' ? config.mount : 'car';
  const power = typeof config.power === 'string' ? config.power : null;
  if (!power) return null;
  const tier = Math.max(1, Math.floor(Number(config.tier) || 1));
  return { mount, power, tier };
}

export class Marketplace {
  /**
   * @param {{ bus?:any, economy?:any, inventory?:any, player?:any, npcManager?:any,
   *           input?:any, root?:HTMLElement, ui?:boolean }} ctx
   */
  constructor({ bus, economy, inventory, cosmetics, mounts, player, npcManager, input, root, ui = true } = {}) {
    this.bus = bus ?? null;
    this.economy = economy ?? null;
    this.inventory = inventory ?? null;
    this.cosmetics = cosmetics ?? null;
    /**
     * Read-only here: preview() needs it to refuse a mount power the player
     * already owns. Without it every tier stayed re-buyable at full price
     * forever, because `quantity` is NULL on all 45 mount rows and nothing
     * else in the purchase path knows what has already been granted.
     */
    this.mounts = mounts ?? null;
    this.player = player ?? null;
    this.npcManager = npcManager ?? null;

    this._vendor = null;
    this._scanT = 0;
    this._open = false;
    this._catalog = [];
    this._catalogLoading = false;
    this._catalogError = null;
    /** True while the stock on show came from the bundled offline catalogue. */
    this._catalogOffline = false;
    this._catalogSeq = 0;
    this._filters = { search: '', category: '' };
    /** Categories the open vendor is allowed to sell, or null for "everything". */
    this._vendorCategories = null;
    this._worldId = null;

    this._input = input ?? null;
    this._uiRoot = root ?? null;
    this._wantUI = ui !== false;
    this.ui = null;
    this._uiPending = false;
    this._ticked = false;
    this._latch = false;
    this._keyFallback = null;

    /* Regional pricing. The price tables in ItemDefs are keyed on the world the
     * player is standing in, so this is the one place that has to keep them
     * pointed at the right one - a shop opened in the medieval world must not
     * quote station rates. */
    this._offMarket = this.bus?.on('world:changed', ({ id, world }) => {
      this._worldId = id ?? null;
      setMarketWorld(id);
      // Nothing to buy inside the maze. Repoint pricing first - other systems
      // read it independently of whether this shop can open - then clear any
      // stock left over from the previous world and decline to repopulate it.
      if (!allows(world, 'merchants')) {
        // Bump the sequence before clearing so a fetch still in flight from the
        // previous world fails `refreshCatalog`'s requestId guard instead of
        // writing that world's stock back into `_catalog` after this portal.
        ++this._catalogSeq;
        this._catalog = [];
        return;
      }
      // A shop left open through a portal must show the new world's stock, not
      // stale items from the destination that was just left behind.
      void this.refreshCatalog();
    }) ?? null;

    if (this._wantUI && typeof document !== 'undefined') {
      this._mountUI();
      setTimeout(() => {
        if (!this._ticked) this._installKeyFallback();
      }, 2500);
    }
  }

  /* ====================================================================== */
  /* Queries                                                                */
  /* ====================================================================== */

  /** @returns {boolean} */
  get isOpen() {
    return this._open;
  }

  /** The vendor the player is currently standing next to, if any. */
  get vendor() {
    return this._vendor;
  }

  /** Everything on sale. @returns {typeof PACKS} */
  get items() {
    return this._catalog;
  }

  /**
   * True when the stock on show is the bundled catalogue rather than the API's.
   *
   * Read by `MarketplaceUI` so an offline shop says so once, at the top, and
   * is otherwise a working shop. Silence here is what turned a 404 into "this
   * vendor sells nothing".
   */
  get offline() {
    return this._catalogOffline === true && this._catalog.length > 0;
  }

  get loading() {
    return this._catalogLoading;
  }

  get error() {
    return this._catalogError;
  }

  get filters() {
    return { ...this._filters };
  }

  /**
   * The categories the player may filter by right now.
   *
   * A vendor that authored `vendorCategories` narrows this to its own stock, so
   * the picker's "All categories" means all of *this* trader's categories. Any
   * other vendor gets the full catalogue, exactly as before.
   * @returns {string[]}
   */
  get categories() {
    return this._vendorCategories ? this._vendorCategories.slice() : ALL_CATEGORIES.slice();
  }

  /**
   * The open vendor's stock restriction, or null when it sells everything.
   * @returns {string[]|null}
   */
  get vendorCategories() {
    return this._vendorCategories ? this._vendorCategories.slice() : null;
  }

  /**
   * What the player can sell right now, merged across store and bag.
   *
   * `noSell` items are skipped alongside the virtual ones, and for a related
   * reason: neither is goods. Credits are a balance rather than a stack; a
   * mount upgrade is an entitlement the shop has never bought back, because
   * buying one there applies it to the rider and no item is ever created. The
   * only mount-upgrade items in existence come off pickups the map editor
   * placed, and those respawn for anyone who does not have the upgrade - so a
   * vendor willing to take one would be an unbounded credit printer, not a
   * trade. @see ItemDefs, the mount power generator.
   *
   * @returns {Array<{id:string, def:any, store:number, bag:number, total:number, unit:number}>}
   */
  get sellables() {
    const inv = this.inventory;
    if (!inv) return [];
    const rows = new Map();
    const push = (list, key) => {
      for (const row of list) {
        if (ITEMS[row.id]?.virtual || ITEMS[row.id]?.noSell) continue;
        let r = rows.get(row.id);
        if (!r) {
          r = { id: row.id, def: row.def ?? itemDef(row.id), store: 0, bag: 0, total: 0, unit: sellValue(row.id, 1) };
          rows.set(row.id, r);
        }
        r[key] += row.qty;
        r.total += row.qty;
      }
    };
    push(inv.items, 'store');
    push(inv.bag, 'bag');
    return [...rows.values()];
  }

  /** Credits the player holds. */
  get credits() {
    return this.economy?.credits ?? 0;
  }

  setFilters(filters = {}) {
    const next = {
      search: typeof filters.search === 'string' ? filters.search : this._filters.search,
      category: typeof filters.category === 'string' ? filters.category : this._filters.category,
    };
    this._filters = next;
    return this.refreshCatalog();
  }

  async refreshCatalog() {
    const requestId = ++this._catalogSeq;
    const world = this._worldId ?? null;
    // Read once, so a vendor swap mid-flight cannot narrow the wrong response.
    const allowed = this._vendorCategories;
    // The API filters by one category at a time, so a vendor stocking several
    // asks for the whole world and narrows the answer below. A category the
    // vendor does not stock is treated as "all of theirs" rather than as an
    // empty shop.
    const category = allowed
      ? (allowed.includes(this._filters.category) ? this._filters.category : '')
      : this._filters.category;
    const params = new URLSearchParams();
    if (world) params.set('world', world);
    if (this._filters.search.trim()) params.set('search', this._filters.search.trim());
    if (category) params.set('category', category);

    this._catalogLoading = true;
    this._catalogError = null;
    this.ui?.refresh?.();

    try {
      const res = await fetch(`/api/marketplace/items?${params.toString()}`, { cache: 'no-store' });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error || 'Failed to load marketplace catalog');
      if (requestId !== this._catalogSeq) return;
      const items = Array.isArray(data?.items) ? data.items : [];
      // The restriction lands on `_catalog` itself rather than on the drawing
      // code, so `preview` and `buy` cannot reach a row this vendor does not
      // stock even if something else hands them an id.
      this._catalog = allowed
        ? items.filter((entry) => allowed.includes(String(entry?.category ?? '')))
        : items;
      this._catalogError = null;
      this._catalogOffline = false;
      this.ui?.refresh?.();
    } catch (err) {
      if (requestId !== this._catalogSeq) return;
      /* THE SHOP DEGRADES. It used to stop here.
       *
       * `_catalogError` was set, the panel drew "not found" in the same
       * neutral style as an empty shop, and every credit in the game became
       * unspendable - including the ship-stat upgrades `ShipMenuLogic` points
       * the player at by name. Lore has degraded to bundled defaults since it
       * was written; the shop, which is the only sink for the currency,
       * degraded to nothing.
       *
       * `offlineCatalog` returns the same row shape the API does, priced
       * through `WORLD_MARKETS` with the seeder's own arithmetic. The vendor's
       * category restriction is applied to it identically, because the point
       * of putting that restriction on `_catalog` rather than on the drawing
       * code was that no other path could get round it.
       *
       * `_catalogError` still carries the reason - the UI shows it as a
       * one-line notice ABOVE stock rather than instead of it - so an offline
       * shop is legible as offline instead of silently pretending. */
      const offline = offlineCatalog(world);
      if (offline.length) {
        this._catalog = allowed
          ? offline.filter((entry) => allowed.includes(String(entry?.category ?? '')))
          : offline;
        this._catalogOffline = true;
      } else {
        this._catalog = [];
        this._catalogOffline = false;
      }
      this._catalogError = err instanceof Error ? err.message : 'Failed to load marketplace catalog';
      this.ui?.refresh?.();
    } finally {
      if (requestId === this._catalogSeq) {
        this._catalogLoading = false;
        this.ui?.refresh?.();
      }
    }
  }

  /* ====================================================================== */
  /* Trading                                                                */
  /* ====================================================================== */

  /**
   * Resolve how a catalog item should be granted into the inventory.
   *
   * @param {any} item
   * @returns {{itemId:string, qty:number}|null}
   */
  _purchaseGrant(item) {
    const source = String(item?.source_key ?? '');
    if (source.startsWith('pack_bullets')) return { itemId: 'bullet', qty: 60 };
    if (source.startsWith('pack_arrows')) return { itemId: 'arrow', qty: 30 };
    if (source.startsWith('pack_embers')) return { itemId: 'fireball_charge', qty: 10 };
    if (source.startsWith('pack_medkit')) return { itemId: 'medkit', qty: 2 };
    const consumable = consumableItemFor(source);
    if (consumable) return { itemId: consumable, qty: 1 };

    const config = item?.action_config ?? {};
    if (config?.effect === 'grant_ammo' && typeof config.ammo_item === 'string') {
      const qty = Math.max(1, Math.floor(Number(config.amount) || 1));
      return { itemId: config.ammo_item, qty };
    }
    if (config?.effect === 'grant_item' && typeof config.item_id === 'string') {
      const qty = Math.max(1, Math.floor(Number(config.amount) || 1));
      return { itemId: config.item_id, qty };
    }
    return null;
  }

  /**
   * A mount upgrade is not a bag item: it grants a purchased power to a mount
   * instead of stock. Detected by its action effect so the catalog stays the
   * single source of truth.
   * @param {any} item
   * @returns {{mount:string, power:string, tier:number}|null}
   */
  _mountPowerGrant(item) {
    return mountPowerGrantFor(item?.action_config ?? {});
  }

  /**
   * A weapon upgrade is not a bag item either: it grants a permanent damage
   * tier to one of the four weapons. Detected by its action effect, the way
   * every other non-stock grant on this counter is, so the catalogue stays the
   * single source of truth about what a row does.
   *
   * ── Why this one needs nothing wired in ──────────────────────────────────
   *
   * `_mountPowerGrant` above hands its answer to `buy`, which emits
   * `mount:power:buy` for `main.js` to catch and apply to the mount manager it
   * holds. There is no equivalent registry to hold for weapons: the tier has to
   * be readable by `Combat`, `Sword` and `Projectiles` at the moment they read
   * `WEAPON_STATS[id].damage`, so it lives in a module singleton
   * (`WEAPON_POWERS`) that this file simply imports. The grant therefore
   * completes here, in `buy`, with no handler anywhere else - and the event is
   * still published, for the persist scheduler and for a HUD that may want to
   * say so.
   *
   * @param {any} item
   * @returns {{weapon:string, tier:number}|null}
   */
  /**
   * The hull registry this counter sells fittings against.
   *
   * A getter rather than a stored field so a `ShipRegistry` built AFTER the
   * shop - which is what `main.js` does, and it is the ordering that made the
   * whole ship half of this counter unreachable through a constructor - is
   * still found. An explicitly assigned `market.ships` wins, for a rig that
   * wants an isolated one.
   */
  get ships() {
    return this._ships ?? activeShipRegistry();
  }

  set ships(v) {
    this._ships = v ?? null;
  }

  /**
   * A ship fitting is not a bag item: it grants a permanent tier to one hull's
   * stat. Detected by its action effect, like every other non-stock grant here.
   * @param {any} item
   * @returns {{ship:string, power:string, tier:number}|null}
   */
  _shipPowerGrant(item) {
    const config = item?.action_config ?? {};
    if (config?.effect !== 'grant_ship_power') return null;
    const ship = typeof config.ship === 'string' ? config.ship : null;
    const power = typeof config.power === 'string' ? config.power : null;
    if (!ship || !power) return null;
    return { ship, power, tier: Math.max(1, Math.floor(Number(config.tier) || 1)) };
  }

  _weaponPowerGrant(item) {
    const config = item?.action_config ?? {};
    if (config?.effect !== 'grant_weapon_power') return null;
    const weapon = typeof config.weapon === 'string' ? config.weapon : null;
    if (!weapon) return null;
    return { weapon, tier: Math.max(1, Math.floor(Number(config.tier) || 1)) };
  }

  /**
   * A cosmetic unlock is not stock either: it grants a permanent skin id to the
   * wardrobe. Detected by its action effect so the catalog stays authoritative.
   * @param {any} item
   * @returns {{cosmeticId:string, kind:string}|null}
   */
  _cosmeticGrant(item) {
    const config = item?.action_config ?? {};
    if (config?.effect !== 'unlock_cosmetic') return null;
    const cosmeticId = typeof config.cosmetic_id === 'string' ? config.cosmetic_id : null;
    if (!cosmeticId) return null;
    const kind = config.kind === 'vehicle' ? 'vehicle' : 'character';
    return { cosmeticId, kind };
  }

  preview(item) {
    if (!item || !this.economy) {
      return { ok: false, reason: 'unavailable', stock: 0, grant: null, cost: 0 };
    }
    const stock = item.quantity == null ? Infinity : Math.max(0, Math.floor(Number(item.quantity) || 0));
    const cost = Math.max(1, Math.floor(Number(item.cost_buy) || 0));

    // Mount upgrade: needs credits and stock, but no bag room.
    const power = this._mountPowerGrant(item);
    if (power) {
      const grant = { qty: 1, kind: 'upgrade', label: 'Mount upgrade' };
      // A mis-authored row (Fire on a horse) must be unavailable rather than
      // sold and dropped: MountManager.grantPower would silently refuse to
      // store it, and buy() must not have already spent the player's credits
      // for nothing.
      if (this.mounts?.sellsPower && !this.mounts.sellsPower(power.mount, power.power)) {
        return { ok: false, reason: 'unsupported', stock, grant, power, cost };
      }
      // A higher tier replaces a lower one (MountManager.grantPower), so owning
      // tier 3 makes tiers 1 and 2 no-ops too - refuse anything at or below what
      // is already granted rather than charging for a purchase that changes
      // nothing. Mirrors the cosmetic `owned` branch below.
      const ownedTier = Number(this.mounts?.getPowers?.(power.mount)?.[power.power] ?? 0);
      if (ownedTier >= power.tier) {
        return { ok: false, reason: 'owned', stock, grant, power, cost };
      }
      if (stock <= 0) return { ok: false, reason: 'stock', stock, grant, power, cost };
      if (this.credits < cost) return { ok: false, reason: 'credits', stock, grant, power, cost };
      return { ok: true, stock, grant, power, cost };
    }

    /* Ship fitting: the mount branch above, one vehicle over, and every one of
     * its refusals restated against the hull registry.
     *
     * `this.ships` is `activeShipRegistry()` unless a caller handed one in -
     * see the note over that function for why the shop reaches for a module
     * pointer rather than a constructor argument it would never be given. A
     * NULL registry refuses with `unsupported`, which is the only safe answer:
     * `grantPower` would have nowhere to bank the tier, and this counter must
     * never charge for a grant it cannot see land. */
    const ship = this._shipPowerGrant(item);
    if (ship) {
      const reg = this.ships;
      const grant = { qty: 1, kind: 'upgrade', label: 'Ship fitting' };
      if (!reg || (reg.sellsPower && !reg.sellsPower(ship.ship, ship.power))) {
        return { ok: false, reason: 'unsupported', stock, grant, ship, cost };
      }
      const ownedTier = Math.max(0, Math.floor(Number(reg.getPowers?.(ship.ship)?.[ship.power]) || 0));
      if (ship.tier <= ownedTier || ship.tier > ownedTier + 1) {
        return { ok: false, reason: 'owned', stock, grant, ship, cost };
      }
      if (stock <= 0) return { ok: false, reason: 'stock', stock, grant, ship, cost };
      if (this.credits < cost) return { ok: false, reason: 'credits', stock, grant, ship, cost };
      return { ok: true, stock, grant, ship, cost };
    }

    /* Weapon upgrade: credits and stock, no bag room. The three refusals are
     * the mount branch's, asked of the weapon ledger and IN THE SAME ORDER,
     * because every one of them is a way to take money for nothing:
     *
     *  - `unsupported`  a row naming a weapon with no ladder. `sellsPower` is
     *    public on `WeaponRegistry` for exactly this, the way `ShipRegistry`
     *    made its own public - "the marketplace has to be able to REFUSE a
     *    purchase rather than take the money and silently drop the grant";
     *  - `owned`        `grantPower` keeps `max(owned, tier)`, so selling a
     *    tier at or below what is already fitted is a full charge for nothing;
     *  - and the ladder is climbed in order, so tier III with no tier II is
     *    refused as `owned` too - buying it would make the two cheap rungs
     *    permanently unsellable, which is a purchase that DESTROYS value. */
    const weapon = this._weaponPowerGrant(item);
    if (weapon) {
      const grant = { qty: 1, kind: 'upgrade', label: 'Weapon upgrade' };
      if (!WEAPON_POWERS.sellsPower(weapon.weapon)) {
        return { ok: false, reason: 'unsupported', stock, grant, weapon, cost };
      }
      const ownedTier = WEAPON_POWERS.tierOf(weapon.weapon);
      if (weapon.tier <= ownedTier || weapon.tier > ownedTier + 1) {
        return { ok: false, reason: 'owned', stock, grant, weapon, cost };
      }
      if (stock <= 0) return { ok: false, reason: 'stock', stock, grant, weapon, cost };
      if (this.credits < cost) return { ok: false, reason: 'credits', stock, grant, weapon, cost };
      return { ok: true, stock, grant, weapon, cost };
    }

    // Cosmetic unlock: a one-time skin. Owned skins can't be re-bought.
    const cosmetic = this._cosmeticGrant(item);
    if (cosmetic) {
      const grant = { qty: 1, kind: 'unlock', label: 'Unlock skin' };
      if (this.cosmetics?.has?.(cosmetic.cosmeticId)) {
        return { ok: false, reason: 'owned', stock, grant, cosmetic, cost };
      }
      if (stock <= 0) return { ok: false, reason: 'stock', stock, grant, cosmetic, cost };
      if (this.credits < cost) return { ok: false, reason: 'credits', stock, grant, cosmetic, cost };
      return { ok: true, stock, grant, cosmetic, cost };
    }

    if (!this.inventory) {
      return { ok: false, reason: 'unavailable', stock, grant: null, cost };
    }
    const grant = this._purchaseGrant(item);
    if (!grant) return { ok: false, reason: 'unsupported', stock, grant: null, cost };
    // A mount skin is one-per-player: refuse when it is burned in already or a
    // copy is still sitting in the bag/store, so nobody buys a second one.
    const skinId = skinIdFromItem(grant.itemId);
    if (skinId && (this.cosmetics?.has?.(skinId) || (this.inventory.totalCount?.(grant.itemId) ?? 0) > 0)) {
      return { ok: false, reason: 'owned', skin: true, stock, grant, cost };
    }
    if (stock <= 0) return { ok: false, reason: 'stock', stock, grant, cost };
    if (this.credits < cost) return { ok: false, reason: 'credits', stock, grant, cost };
    const room = this.inventory.roomFor(grant.itemId);
    if (room < grant.qty) return { ok: false, reason: 'space', stock, grant, cost };
    return { ok: true, stock, grant, cost };
  }

  /**
   * Buy one catalog item from the DB-backed market.
   *
   * @param {string} itemId
   * @returns {{ok:boolean, reason?:string, qty?:number, cost?:number}}
   */
  buy(itemId) {
    const item = this._catalog.find((entry) => entry.id === itemId);
    if (!item || !this.economy) return { ok: false, reason: 'unavailable' };

    const preview = this.preview(item);
    if (!preview.ok) return { ok: false, reason: preview.reason ?? 'unavailable', skin: preview.skin === true, power: !!preview.power };

    const cost = preview.cost;

    /* WHICH ROW WAS BOUGHT travels with every debit below.
     *
     * `cost` here is the client's arithmetic and always was; what changed is
     * that the server no longer believes it. A marketplace debit is priced from
     * `marketplace_items.cost_buy`, and an event that does not name the row is
     * refused rather than charged at whatever the browser sent -- a
     * 1,071-credit item was bought for 1 credit before this.
     *
     * `item.id` is the reference the server resolves: a UUID from the API, or
     * the seeded `source_key` when the row came from the bundled offline
     * catalogue, which `MarketplaceOffline` keys deliberately so that "an
     * offline purchase and an online one name the same row". */
    const buyMeta = { itemId: String(item.id ?? '') };

    // Mount upgrade: spend, announce, let MountManager apply the stat. No bag.
    if (preview.power) {
      if (!this.economy.spend(cost, 'market', buyMeta)) return { ok: false, reason: 'credits' };
      if (item.quantity != null) item.quantity = Math.max(0, item.quantity - 1);
      this.bus?.emit('mount:power:buy', {
        mount: preview.power.mount,
        power: preview.power.power,
        tier: preview.power.tier,
        catalogId: item.id,
        cost,
      });
      this.bus?.emit('market:trade', {
        itemId: item.source_key || item.id,
        catalogId: item.id,
        qty: 1,
        credits: -cost,
        kind: 'buy',
      });
      this.bus?.emit('hud:notify', { text: `Bought ${item.name}`, tone: 'info' });
      this.ui?.refresh?.();
      return { ok: true, qty: 1, cost };
    }

    /* Ship fitting: spend, grant, announce. The grant happens HERE and not in
     * a `main.js` handler, for the reason the weapon branch below states: the
     * registry is in hand, so an event that had to be caught elsewhere would
     * be one more place for a purchase to go missing. `ship:power:buy` is
     * still published - as a receipt for the persist scheduler, the way
     * `ShipMenu` publishes it after its own grant. */
    if (preview.ship) {
      const reg = this.ships;
      if (!this.economy.spend(cost, 'market', buyMeta)) return { ok: false, reason: 'credits' };
      reg?.grantPower?.(preview.ship.ship, preview.ship.power, preview.ship.tier);
      if (item.quantity != null) item.quantity = Math.max(0, item.quantity - 1);
      this.bus?.emit('ship:power:buy', {
        ship: preview.ship.ship,
        power: preview.ship.power,
        tier: preview.ship.tier,
        catalogId: item.id,
        cost,
      });
      this.bus?.emit('market:trade', {
        itemId: item.source_key || item.id,
        catalogId: item.id,
        qty: 1,
        credits: -cost,
        kind: 'buy',
      });
      this.bus?.emit('hud:notify', { text: `Bought ${item.name}`, tone: 'info' });
      this.ui?.refresh?.();
      return { ok: true, qty: 1, cost };
    }

    /* Weapon upgrade: spend, GRANT HERE, then announce. The mount branch above
     * announces and lets `main.js` grant, because the mount registry is built
     * there; the weapon ledger is a module singleton this file imports, so the
     * grant has nowhere else to happen and no handler to go missing.
     *
     * The order is the one this whole file is paranoid about: `spend` refuses
     * rather than going below zero, and `grantPower` only runs after it has
     * said yes. `grantPower` returns false for a grant that would change
     * nothing - and `preview` has already refused those, so a false here would
     * mean the ledger moved between the preview and the debit. That is a
     * refund, not a shrug: the credits go back and the row reports `owned`. */
    if (preview.weapon) {
      if (!this.economy.spend(cost, 'market', buyMeta)) return { ok: false, reason: 'credits' };
      if (!WEAPON_POWERS.grantPower(preview.weapon.weapon, preview.weapon.tier)) {
        this.economy.add(cost, 'market-refund');
        return { ok: false, reason: 'owned' };
      }
      if (item.quantity != null) item.quantity = Math.max(0, item.quantity - 1);
      this.bus?.emit('weapon:power:buy', {
        weapon: preview.weapon.weapon,
        tier: preview.weapon.tier,
        catalogId: item.id,
        cost,
      });
      this.bus?.emit('market:trade', {
        itemId: item.source_key || item.id,
        catalogId: item.id,
        qty: 1,
        credits: -cost,
        kind: 'buy',
      });
      this.bus?.emit('hud:notify', { text: `Bought ${item.name}`, tone: 'info' });
      this.ui?.refresh?.();
      return { ok: true, qty: 1, cost };
    }

    // Cosmetic unlock: spend, announce, let the wardrobe record the skin. No bag.
    if (preview.cosmetic) {
      if (!this.economy.spend(cost, 'market', buyMeta)) return { ok: false, reason: 'credits' };
      if (item.quantity != null) item.quantity = Math.max(0, item.quantity - 1);
      this.bus?.emit('cosmetic:buy', {
        cosmeticId: preview.cosmetic.cosmeticId,
        kind: preview.cosmetic.kind,
        catalogId: item.id,
        cost,
      });
      this.bus?.emit('market:trade', {
        itemId: item.source_key || item.id,
        catalogId: item.id,
        qty: 1,
        credits: -cost,
        kind: 'buy',
      });
      this.bus?.emit('hud:notify', { text: `Unlocked ${item.name}`, tone: 'info' });
      this.ui?.refresh?.();
      return { ok: true, qty: 1, cost };
    }

    if (!preview.grant || !this.inventory) return { ok: false, reason: preview.reason ?? 'unavailable' };
    const grant = preview.grant;

    if (!this.economy.spend(cost, 'market', buyMeta)) return { ok: false, reason: 'credits' };

    const got = this.inventory.acquire(grant.itemId, grant.qty);
    if (got.taken < grant.qty) {
      const refund = Math.round((cost * (grant.qty - got.taken)) / grant.qty);
      if (refund > 0) this.economy.add(refund, 'market-refund');
    }

    if (item.quantity != null) item.quantity = Math.max(0, item.quantity - 1);

    this.bus?.emit('market:trade', {
      itemId: grant.itemId,
      catalogId: item.id,
      qty: got.taken,
      credits: -cost,
      kind: 'buy',
    });
    this.bus?.emit('hud:notify', {
      text: `Bought ${item.name}`,
      tone: 'info',
    });
    this.ui?.refresh?.();
    return { ok: true, qty: got.taken, cost };
  }

  /**
   * Sell items back. Pulls from the store first, then the bag, so a careless
   * click cannot strip the ammo the player is actually carrying.
   *
   * @param {string} itemId
   * @param {number} [qty=1]
   * @param {'auto'|'store'|'bag'} [from='auto']
   * @returns {{ok:boolean, reason?:string, qty?:number, credits?:number}}
   */
  sell(itemId, qty = 1, from = 'auto') {
    const inv = this.inventory;
    const def = itemDef(itemId);
    const n = Math.max(1, Math.floor(qty) || 1);
    // `noSell` beside `virtual`, and checked HERE and not only in `sellables`:
    // the list is what the panel draws, this is what actually moves goods and
    // credits, and a caller that never opened the panel must meet the same
    // refusal. @see sellables for what a mount upgrade is doing on that list.
    if (!inv || !def || def.virtual || def.noSell) return { ok: false, reason: 'unavailable' };

    let sold = 0;
    if (from !== 'bag') sold += inv.remove(itemId, n);
    if (sold < n && from !== 'store') {
      const want = n - sold;
      if (inv.consumeFromBag(itemId, want)) sold += want;
      else {
        // Not enough for the whole remainder: take exactly what is there.
        const have = inv.bagCount(itemId);
        if (have > 0 && inv.consumeFromBag(itemId, have)) sold += have;
      }
    }
    if (sold <= 0) return { ok: false, reason: 'none' };

    const paid = sellValue(itemId, sold);
    this.economy?.add(paid, 'market');
    this.bus?.emit('market:trade', { itemId, qty: sold, credits: paid, kind: 'sell' });
    this.bus?.emit('hud:notify', { text: `Sold ${sold} x ${def.name} for ${paid} CR`, tone: 'info' });
    return { ok: true, qty: sold, credits: paid };
  }

  /* ====================================================================== */
  /* Open / close                                                           */
  /* ====================================================================== */

  /**
   * Open the shop. Refuses politely when there is no vendor in range so the
   * key always produces feedback.
   * @param {any} [vendor]
   * @returns {boolean}
   */
  open(vendor = null) {
    if (this._open) return true;
    const v = vendor ?? this._vendor ?? this._findVendor();
    if (!v) {
      this.bus?.emit('hud:notify', { text: 'No vendor nearby — find a trader to open the market', tone: 'warn' });
      return false;
    }
    this._vendor = v;
    this._open = true;
    // Re-read the restriction on every open, so walking from a general trader
    // to a provisions stall swaps the stock instead of inheriting it, and set
    // it *before* the UI opens so the picker is built from the right list.
    this._vendorCategories = this._readVendorCategories(v);
    if (this._vendorCategories && !this._vendorCategories.includes(this._filters.category)) {
      this._filters.category = '';
    }
    this.bus?.emit('market:open', {});
    this.ui?.open?.(v);
    void this.refreshCatalog();
    return true;
  }

  close() {
    if (!this._open) return;
    this._open = false;
    // Back to the unrestricted view: the catalogue is also refetched on a world
    // change while the shop is shut, and that must not stay narrowed to a
    // vendor the player has walked away from.
    this._vendorCategories = null;
    this.bus?.emit('market:close', {});
    this.ui?.close?.();
  }

  toggle() {
    if (this._open) this.close();
    else this.open();
  }

  /**
   * Frame tick: vendor proximity, the `B` keybind, and closing the panel when
   * the player wanders off.
   * @param {number} dt
   */
  update(dt = 0) {
    this._ticked = true;
    this._scanT -= dt;
    if (this._scanT <= 0) {
      this._scanT = SCAN_INTERVAL;
      const found = this._findVendor();
      if (found !== this._vendor && !this._open) {
        this._vendor = found;
        this.bus?.emit('market:available', { vendor: found ?? null });
      }
      // Walking away closes the shop rather than trading through a wall.
      if (this._open && this._vendor && !this._inRange(this._vendor)) this.close();
    }

    const input = this._resolveInput();
    if (input && !this.ui?.isOpen) {
      const down = input.pressed?.('KeyB') ?? false;
      if (down && !this._latch) {
        this._latch = true;
        this.open();
      } else if (!down) {
        this._latch = false;
      }
    }
    this.ui?.update?.(dt);
  }

  dispose() {
    if (this._keyFallback) window.removeEventListener('keydown', this._keyFallback);
    this._keyFallback = null;
    this.ui?.dispose?.();
    this.ui = null;
  }

  /* ====================================================================== */
  /* Internals                                                              */
  /* ====================================================================== */

  _inRange(npc) {
    const p = this.player?.position;
    if (!p || !npc || npc.isDead) return false;
    return npc.position.distanceToSquared(p) <= VENDOR_RANGE * VENDOR_RANGE;
  }

  /**
   * Nearest friendly in range that reads as a trader - an AUTHORED counter
   * first, and only then the word match.
   *
   * ── Why rank and not just distance ────────────────────────────────────────
   * `_isVendor` recognises two quite different things. One is a world author
   * writing `role: 'vendor'` with a stall title and a stock list; the other is
   * `VENDOR_WORDS` matching a persona, which exists because the roles came
   * later and is deliberately generous - it fires on `smith`, `stall`,
   * `market`, `kit` and a dozen more.
   *
   * Generous is right for finding SOMEBODY to trade with in a world that
   * authored nobody. It is wrong the moment a real counter is standing there,
   * because nearest-wins then lets a bystander whose persona happens to mention
   * the smithy stand in front of the smith. Measured in the vale: Bram Tallow
   * holds the Forge & Armoury counter at (49.5, 22.5) and his seventeen-year-old
   * apprentice Rook Danby patrols to within 5.4 m of it. Rook's persona says
   * "apprentice at the smithy", so he matched `smith`; standing at the anvil
   * opened ROOK - an unrestricted trader, because a word match authors no
   * `vendorCategories` - and the picker offered `ships`, a category with no
   * rows in the medieval world at all. The counter behind him was unreachable.
   *
   * So: any explicitly-roled vendor in range beats every word match in range,
   * and distance decides within each rank. It cannot open a shop that distance
   * alone would not have opened - `VENDOR_RANGE` still bounds both passes - and
   * where a world authors no vendors at all the behaviour is exactly what it
   * was.
   */
  _findVendor() {
    const p = this.player?.position;
    const list = this.npcManager?.friendlies;
    if (!p || !list) return null;
    const RANGE_SQ = VENDOR_RANGE * VENDOR_RANGE;
    let best = null;
    let bestSq = Infinity;
    let bestAuthored = false;
    for (const npc of list) {
      if (npc.isDead || !this._isVendor(npc)) continue;
      const d = npc.position.distanceToSquared(p);
      // The range bound is checked FIRST and against the constant, never
      // against the incumbent: an authored counter outranks a word match only
      // among characters the player could already have opened.
      if (d > RANGE_SQ) continue;
      const authored = this._isAuthoredVendor(npc);
      if (bestAuthored && !authored) continue;      // rank beats distance
      if (authored && !bestAuthored) {              // ...in both directions
        bestSq = d;
        best = npc;
        bestAuthored = true;
        continue;
      }
      if (d < bestSq) {
        bestSq = d;
        best = npc;
        bestAuthored = authored;
      }
    }
    return best;
  }

  /**
   * True when a world DECLARED this character a counter, rather than the word
   * match having guessed it. @see _findVendor for why the two are ranked.
   * @param {any} npc
   * @returns {boolean}
   */
  _isAuthoredVendor(npc) {
    if (!npc) return false;
    if (Array.isArray(npc.vendorCategories) && npc.vendorCategories.length) return true;
    const role = npc.role ?? npc.spawnSpec?.role ?? npc.job;
    return typeof role === 'string' && /vendor|trader|merchant|shop/i.test(role);
  }

  /**
   * Read a vendor's authored stock restriction.
   *
   * A world writes `vendorCategories: ['health', 'spells']` on its `npcSpawns`
   * entry and `NPCManager` copies it onto the NPC. Unknown names are dropped so
   * a typo narrows nothing rather than emptying the shop, and a list that ends
   * up empty means the same as no list at all: a general trader.
   *
   * @param {any} vendor
   * @returns {string[]|null}
   */
  _readVendorCategories(vendor) {
    const raw = vendor?.vendorCategories ?? vendor?.spawnSpec?.vendorCategories;
    if (!Array.isArray(raw)) return null;
    const list = [];
    for (const entry of raw) {
      const key = String(entry ?? '').trim().toLowerCase();
      if (ALL_CATEGORIES.includes(key) && !list.includes(key)) list.push(key);
    }
    return list.length ? list : null;
  }

  /** Explicit role wins; the word match is the pre-role fallback. */
  _isVendor(npc) {
    if (!npc) return false;
    if (npc.vendor === true || npc.isVendor === true) return true;
    const role = npc.role ?? npc.spawnSpec?.role ?? npc.job;
    if (typeof role === 'string' && /vendor|trader|merchant|shop/i.test(role)) return true;
    if (npc.type === 'hostile') return false;
    return VENDOR_WORDS.test(`${npc.name ?? ''} ${npc.persona ?? ''}`);
  }

  _resolveInput() {
    if (this._input) return this._input;
    this._input = (typeof window !== 'undefined' ? window.GAME?.input : null) ?? null;
    return this._input;
  }

  _mountUI() {
    if (this.ui || this._uiPending) return;
    this._uiPending = true;
    import('../ui/MarketplaceUI.js')
      .then(({ MarketplaceUI }) => {
        this._uiPending = false;
        this.ui = new MarketplaceUI({
          bus: this.bus,
          market: this,
          inventory: this.inventory,
          economy: this.economy,
          input: this._resolveInput(),
          root: this._uiRoot ?? document.getElementById('ui-root') ?? document.body,
          onClose: () => this.close(),
        });
      })
      .catch((err) => {
        this._uiPending = false;
        console.warn('[market] panel failed to mount:', err);
      });
  }

  _installKeyFallback() {
    if (this._keyFallback) return;
    console.info('[market] no external tick - binding "B" directly');
    this._keyFallback = (e) => {
      if (e.repeat || e.ctrlKey || e.metaKey || e.altKey) return;
      if (e.code !== 'KeyB') return;
      const tag = document.activeElement?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA') return;
      if (this.ui?.isOpen) return;
      this._vendor = this._findVendor();
      this.open();
    };
    window.addEventListener('keydown', this._keyFallback);
  }
}
