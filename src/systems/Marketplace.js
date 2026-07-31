import { ITEMS, itemDef, sellValue, setMarketWorld } from './ItemDefs.js';

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

export class Marketplace {
  /**
   * @param {{ bus?:any, economy?:any, inventory?:any, player?:any, npcManager?:any,
   *           input?:any, root?:HTMLElement, ui?:boolean }} ctx
   */
  constructor({ bus, economy, inventory, player, npcManager, input, root, ui = true } = {}) {
    this.bus = bus ?? null;
    this.economy = economy ?? null;
    this.inventory = inventory ?? null;
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
    this._offMarket = this.bus?.on('world:changed', ({ id }) => {
      this._worldId = id ?? null;
      setMarketWorld(id);
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

  get categories() {
    return ['cosmetic', 'weapons', 'tools', 'health', 'spells'];
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
    const params = new URLSearchParams();
    if (world) params.set('world', world);
    if (this._filters.search.trim()) params.set('search', this._filters.search.trim());
    if (this._filters.category) params.set('category', this._filters.category);

    this._catalogLoading = true;
    this._catalogError = null;
    this.ui?.refresh?.();

    try {
      const res = await fetch(`/api/marketplace/items?${params.toString()}`, { cache: 'no-store' });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error || 'Failed to load marketplace catalog');
      if (requestId !== this._catalogSeq) return;
      this._catalog = Array.isArray(data?.items) ? data.items : [];
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
    if (MARKETPLACE_CONSUMABLE_ITEMS[source]) return { itemId: MARKETPLACE_CONSUMABLE_ITEMS[source], qty: 1 };

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

  preview(item) {
    if (!item || !this.inventory || !this.economy) {
      return { ok: false, reason: 'unavailable', stock: 0, grant: null, cost: 0 };
    }
    const grant = this._purchaseGrant(item);
    const stock = item.quantity == null ? Infinity : Math.max(0, Math.floor(Number(item.quantity) || 0));
    const cost = Math.max(1, Math.floor(Number(item.cost_buy) || 0));
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
    if (!item || !this.inventory || !this.economy) return { ok: false, reason: 'unavailable' };

    const preview = this.preview(item);
    if (!preview.ok || !preview.grant) return { ok: false, reason: preview.reason ?? 'unavailable' };

    const cost = preview.cost;
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
    this.bus?.emit('market:open', {});
    this.ui?.open?.(v);
    void this.refreshCatalog();
    return true;
  }

  close() {
    if (!this._open) return;
    this._open = false;
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
