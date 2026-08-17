import { ITEMS, itemDef, sellValue, setMarketWorld } from './ItemDefs.js';
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
const ALL_CATEGORIES = ['cosmetic', 'weapons', 'tools', 'health', 'spells', 'mounts'];

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
function consumableItemFor(key) {
  // Own-property only: a `source_key` of `constructor` must not resolve to a
  // function off Object.prototype.
  const has = (k) => Object.prototype.hasOwnProperty.call(MARKETPLACE_CONSUMABLE_ITEMS, k);
  if (has(key)) return MARKETPLACE_CONSUMABLE_ITEMS[key];
  const cut = key.lastIndexOf(':');
  if (cut <= 0) return null;
  const bare = key.slice(0, cut);
  return has(bare) ? MARKETPLACE_CONSUMABLE_ITEMS[bare] : null;
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
   * @returns {Array<{id:string, def:any, store:number, bag:number, total:number, unit:number}>}
   */
  get sellables() {
    const inv = this.inventory;
    if (!inv) return [];
    const rows = new Map();
    const push = (list, key) => {
      for (const row of list) {
        if (ITEMS[row.id]?.virtual) continue;
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
      this.ui?.refresh?.();
    } catch (err) {
      if (requestId !== this._catalogSeq) return;
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
    const config = item?.action_config ?? {};
    if (config?.effect !== 'grant_mount_power') return null;
    const mount = typeof config.mount === 'string' ? config.mount : 'car';
    const power = typeof config.power === 'string' ? config.power : null;
    if (!power) return null;
    const tier = Math.max(1, Math.floor(Number(config.tier) || 1));
    return { mount, power, tier };
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
    if (!preview.ok) return { ok: false, reason: preview.reason ?? 'unavailable' };

    const cost = preview.cost;

    // Mount upgrade: spend, announce, let MountManager apply the stat. No bag.
    if (preview.power) {
      if (!this.economy.spend(cost, 'market')) return { ok: false, reason: 'credits' };
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

    // Cosmetic unlock: spend, announce, let the wardrobe record the skin. No bag.
    if (preview.cosmetic) {
      if (!this.economy.spend(cost, 'market')) return { ok: false, reason: 'credits' };
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

    if (!this.economy.spend(cost, 'market')) return { ok: false, reason: 'credits' };

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
    if (!inv || !def || def.virtual) return { ok: false, reason: 'unavailable' };

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

  /** Nearest friendly in range that reads as a trader. */
  _findVendor() {
    const p = this.player?.position;
    const list = this.npcManager?.friendlies;
    if (!p || !list) return null;
    let best = null;
    let bestSq = VENDOR_RANGE * VENDOR_RANGE;
    for (const npc of list) {
      if (npc.isDead || !this._isVendor(npc)) continue;
      const d = npc.position.distanceToSquared(p);
      if (d < bestSq) {
        bestSq = d;
        best = npc;
      }
    }
    return best;
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
