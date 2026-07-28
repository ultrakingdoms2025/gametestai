import { ITEMS, PACKS, itemDef, packDef, sellValue, packPrice, setMarketWorld } from './ItemDefs.js';

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
      setMarketWorld(id);
      // A shop left open through a portal would be showing the old world's
      // prices against the new world's stock.
      if (this._open) this.ui?.refresh?.();
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
  get packs() {
    return PACKS;
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

  /* ====================================================================== */
  /* Trading                                                                */
  /* ====================================================================== */

  /**
   * Buy `count` copies of a pack.
   *
   * @param {string} packId
   * @param {number} [count=1]
   * @returns {{ok:boolean, reason?:string, qty?:number, cost?:number}}
   */
  buy(packId, count = 1) {
    const pack = packDef(packId);
    const n = Math.max(1, Math.floor(count) || 1);
    if (!pack || !this.inventory || !this.economy) return { ok: false, reason: 'unavailable' };

    const qty = pack.qty * n;
    const cost = packPrice(pack) * n;
    if (this.credits < cost) return { ok: false, reason: 'credits' };

    // Space first: an inventory that can only take part of the pack would leave
    // the player short of both goods and money.
    if (this.inventory.roomFor(pack.itemId) < qty) {
      this.bus?.emit('inventory:full', { itemId: pack.itemId, overflow: qty, where: 'both' });
      return { ok: false, reason: 'space' };
    }
    if (!this.economy.spend(cost, 'market')) return { ok: false, reason: 'credits' };

    const got = this.inventory.acquire(pack.itemId, qty);
    if (got.taken < qty) {
      // Should be unreachable given the check above, but a refund is one line
      // and a silently robbed player is a bug report.
      const refund = Math.round((cost * (qty - got.taken)) / qty);
      if (refund > 0) this.economy.add(refund, 'market-refund');
    }

    this.bus?.emit('market:trade', { itemId: pack.itemId, qty: got.taken, credits: -cost, kind: 'buy' });
    this.bus?.emit('hud:notify', { text: `Bought ${got.taken} ${pack.itemId === 'medkit' ? 'medkits' : itemDef(pack.itemId)?.name ?? pack.itemId}`, tone: 'info' });
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
