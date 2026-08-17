import './inventory.css';
import { el, menuFocusIn, menuFocusOut } from './InventoryUI.js';
import {
  itemIconSVG, itemDef, sellValue, SELL_RATE, packPrice, priceSignal, marketInfo,
} from '../systems/ItemDefs.js';

/**
 * Vendor terminal: buy packs, sell salvage.
 *
 * Every row states up front whether the trade is possible and why not, because
 * the two ways to lose money in a shop are a hidden price and a hidden capacity
 * limit. Buy rows grey out and turn their price red when the player cannot
 * afford them *or* has no room for the goods; sell rows show the exact payout.
 * All arithmetic lives in `Marketplace` - this file only draws it and asks.
 */

const TABS = [
  { id: 'buy', label: 'Buy' },
  { id: 'sell', label: 'Sell' },
];

const FALLBACK_CATEGORIES = ['', 'cosmetic', 'weapons', 'tools', 'health', 'spells', 'mounts'];

const CATEGORY_COLORS = {
  cosmetic: '#d46bff',
  weapons:  '#52e9ff',
  tools:    '#ffb44a',
  health:   '#b6ff5a',
  spells:   '#ff7d3c',
  mounts:   '#ff8a5c',
};

/**
 * Map game_action → [emoji, hex colour].
 * Falls back to category-level icon when action is not listed.
 */
const ACTION_ART = {
  ammo_pack_rifle:    ['🔫', '#52e9ff'],
  ammo_pack_arrow:    ['🏹', '#52e9ff'],
  ammo_pack_ember:    ['🔥', '#ff9b3c'],
  heal_25:            ['💊', '#b6ff5a'],
  heal_50:            ['❤️‍🩹', '#b6ff5a'],
  heal_full:          ['❤️', '#b6ff5a'],
  stamina_slowdown_25:  ['⚡', '#ffe97d'],
  stamina_slowdown_50:  ['⚡', '#ffe97d'],
  stamina_slowdown_75:  ['⚡', '#ffe97d'],
  stamina_slowdown_100: ['⚡', '#ffe97d'],
  firepower_boost_25:  ['💥', '#ff9b3c'],
  firepower_boost_50:  ['💥', '#ff9b3c'],
  firepower_boost_75:  ['💥', '#ff9b3c'],
  firepower_boost_100: ['💥', '#ff9b3c'],
  speed_boost_25:   ['💨', '#4cc9ff'],
  speed_boost_50:   ['💨', '#4cc9ff'],
  speed_boost_75:   ['💨', '#4cc9ff'],
  speed_boost_100:  ['💨', '#4cc9ff'],
  npc_pause_5s:  ['❄️', '#c0e8ff'],
  npc_pause_10s: ['❄️', '#c0e8ff'],
  npc_pause_30s: ['❄️', '#c0e8ff'],
  npc_pause_60s: ['❄️', '#c0e8ff'],
  shield_5s:        ['🛡️', '#7fe7ff'],
  loot_magnet_30s:  ['🧲', '#7ce3a3'],
  portal_ping_30s:  ['🌀', '#b08bff'],
  cosmetic_headgear: ['👒', '#d46bff'],
  cosmetic_shirt:    ['👕', '#d46bff'],
  cosmetic_pants:    ['👖', '#d46bff'],
  cosmetic_char_skin:    ['🧥', '#d46bff'],
  cosmetic_vehicle_skin: ['🎨', '#ff8a5c'],
  mount_strength_1: ['💪', '#ff8a5c'],
  mount_strength_2: ['💪', '#ff8a5c'],
  mount_strength_3: ['💪', '#ff8a5c'],
  mount_shield_1: ['🛡️', '#5cc8ff'],
  mount_shield_2: ['🛡️', '#5cc8ff'],
  mount_shield_3: ['🛡️', '#5cc8ff'],
  mount_power_1: ['🏎️', '#b6ff5a'],
  mount_power_2: ['🏎️', '#b6ff5a'],
  mount_power_3: ['🏎️', '#b6ff5a'],
  mount_skin: ['🎨', '#ff8a5c'],
};

const CATEGORY_FALLBACK_ICON = {
  cosmetic: ['🎭', '#d46bff'],
  weapons:  ['🔫', '#52e9ff'],
  tools:    ['🔧', '#ffb44a'],
  health:   ['💊', '#b6ff5a'],
  spells:   ['✨', '#ff7d3c'],
  mounts:   ['🏎️', '#ff8a5c'],
};

function _actionArt(gameAction, category) {
  if (gameAction && ACTION_ART[gameAction]) return ACTION_ART[gameAction];
  return CATEGORY_FALLBACK_ICON[category] ?? ['📦', '#52e9ff'];
}

/**
 * Render the item art cell. Shows the remote image if available, shows a shimmer
 * while loading, and falls back to a styled SVG placeholder on error.
 */
function _renderMktArt(artEl, imageUrl, category, name, gameAction) {
  const [icon, fg] = _actionArt(gameAction, category);
  const label = (name || category || 'ITEM').toUpperCase().replace(/[^A-Z0-9 ]+/g, '').slice(0, 10);

  function showFallback() {
    artEl.innerHTML = '';
    artEl.classList.remove('loading');
    artEl.classList.add('fallback');
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', '0 0 72 72');
    svg.setAttribute('fill', 'none');
    svg.innerHTML = `
      <rect width="72" height="72" rx="10" fill="#070c12"/>
      <rect x="4" y="4" width="64" height="64" rx="9" stroke="${fg}" stroke-width="2" opacity="0.6"/>
      <text x="36" y="42" text-anchor="middle" font-size="28" font-family="sans-serif">${icon}</text>
      <text x="36" y="60" text-anchor="middle" font-size="9" font-family="monospace" fill="${fg}" opacity="0.8">${label}</text>`;
    artEl.appendChild(svg);
  }

  if (!imageUrl) {
    showFallback();
    return;
  }

  const img = document.createElement('img');
  img.alt = '';
  img.decoding = 'async';
  img.loading = 'lazy';
  img.addEventListener('load', () => {
    artEl.classList.remove('loading', 'fallback');
  });
  img.addEventListener('error', () => {
    showFallback();
  });
  img.src = imageUrl;
  artEl.appendChild(img);
}

export class MarketplaceUI {
  /**
   * @param {{ bus?:any, market:any, inventory?:any, economy?:any, input?:any,
   *           root:HTMLElement, onClose?:Function }} ctx
   */
  constructor({ bus, market, inventory, economy, input, root, onClose }) {
    this.bus = bus ?? null;
    this.market = market;
    this.inventory = inventory ?? market?.inventory ?? null;
    this.economy = economy ?? market?.economy ?? null;
    this.input = input ?? null;
    this.root = root;
    this._onClose = onClose ?? null;

    this._open = false;
    this._hadLock = false;
    this._tab = 'buy';
    this._flashT = null;

    this._build();

    /** @type {Array<() => void>} */
    this._offs = [];
    if (bus) {
      this._offs.push(bus.on('credits:changed', (e) => this._onCredits(e)));
      this._offs.push(bus.on('inventory:changed', () => this._render()));
    }
    this._onKey = (e) => this._key(e);
  }

  get isOpen() {
    return this._open;
  }

  /* ====================================================================== */
  /* Build                                                                  */
  /* ====================================================================== */

  _build() {
    const wrap = el('div', 'inv-root');
    const panel = el('div', 'inv-panel mkt-panel interactive');

    const head = el('div', 'inv-head mkt-head');
    const vendor = el('div', 'mkt-vendor');
    this.vendorName = el('b', null, 'NEXUS EXCHANGE');
    vendor.append(this.vendorName, el('span', null, 'Licensed trade terminal'));

    const cap = el('div', 'inv-cap');
    const capRow = el('div', 'inv-cap-row');
    this.capVal = el('span', 'inv-cap-val', '0 / 30');
    capRow.append(this.capVal, el('span', 'inv-cap-unit', 'bag slots'));
    this.capEl = cap;
    this.capBar = el('div', 'inv-cap-bar');
    const capacity = this.inventory?.bagCapacity ?? 30;
    for (let i = 0; i < capacity; i++) this.capBar.appendChild(el('i'));
    const note = el('div', 'inv-cap-note');
    note.innerHTML = 'A pack is bought as one <b>stack</b> — 60 rounds fill a single bag slot.';
    cap.append(capRow, this.capBar, note);

    this.creditsEl = el('div', 'inv-credits');
    this.creditsEl.innerHTML = itemIconSVG('credits', 22);
    this.creditsVal = el('b', null, String(this.economy?.credits ?? 0));
    this.creditsEl.appendChild(this.creditsVal);

    const close = el('button', 'inv-x', 'ESC');
    close.type = 'button';
    close.addEventListener('click', () => this.close());

    head.append(vendor, cap, this.creditsEl, close);

    const tabs = el('div', 'mkt-tabs');
    this.tabEls = {};
    for (const t of TABS) {
      const b = el('button', `mkt-tab${t.id === this._tab ? ' on' : ''}`, t.label);
      b.type = 'button';
      b.addEventListener('click', () => this._setTab(t.id));
      tabs.appendChild(b);
      this.tabEls[t.id] = b;
    }

    this.filters = el('div', 'mkt-filters');
    this.searchEl = el('input', 'mkt-search');
    this.searchEl.type = 'search';
    this.searchEl.placeholder = 'Search catalog';
    this.searchEl.addEventListener('input', () => this._setFilters());

    this.categoryEl = el('select', 'mkt-select');
    this._buildCategoryOptions();
    this.categoryEl.addEventListener('change', () => this._setFilters());

    const filterLabel = el('label', 'mkt-filter');
    filterLabel.append(el('span', null, 'Search'), this.searchEl);
    const categoryLabel = el('label', 'mkt-filter');
    categoryLabel.append(el('span', null, 'Category'), this.categoryEl);
    this.filters.append(filterLabel, categoryLabel);

    this.body = el('div', 'mkt-body');

    const foot = el('div', 'mkt-foot');
    this.note = el('div', 'mkt-note');
    this.note.innerHTML = `Vendors buy back at <b>${Math.round(SELL_RATE * 100)}%</b> of value. Sales come out of the store first, then the bag.`;
    this.msg = el('div', 'inv-flash-msg');
    const keys = el('div', 'inv-keys');
    keys.innerHTML = '<span><b>B</b>close</span><span><b>Esc</b>close</span>';
    foot.append(this.note, this.msg, keys);

    panel.append(head, tabs, this.filters, this.body, foot);
    wrap.appendChild(panel);
    this.root.appendChild(wrap);
    this.el = wrap;

    panel.addEventListener('mousedown', (e) => e.stopPropagation());
    wrap.addEventListener('mousedown', (e) => {
      if (e.target === wrap) this.close();
    });
  }

  /**
   * Fill the category picker from whatever the vendor actually stocks.
   *
   * A trader may sell only part of the catalogue, so the list is asked for at
   * open time rather than baked in - and "All categories" then honestly means
   * all of *this* trader's categories. A vendor with no restriction reports the
   * whole catalogue, which is the list this picker always had.
   */
  _buildCategoryOptions() {
    const list = this.market?.categories ?? FALLBACK_CATEGORIES.slice(1);
    this.categoryEl.textContent = '';
    const allOption = document.createElement('option');
    allOption.value = '';
    allOption.textContent = 'All categories';
    this.categoryEl.appendChild(allOption);
    for (const category of list) {
      const option = document.createElement('option');
      option.value = category;
      option.textContent = category;
      this.categoryEl.appendChild(option);
    }
  }

  _setTab(id) {
    this._tab = id;
    for (const key in this.tabEls) this.tabEls[key].classList.toggle('on', key === id);
    this._render();
  }

  _setFilters() {
    if (!this.market?.setFilters) return;
    void this.market.setFilters({
      search: this.searchEl.value,
      category: this.categoryEl.value,
    });
  }

  /* ====================================================================== */
  /* Render                                                                 */
  /* ====================================================================== */

  _render() {
    if (!this._open) return;
    this.body.textContent = '';
    if (this._tab === 'buy') this._renderBuy();
    else this._renderSell();

    const inv = this.inventory;
    if (inv) {
      const used = inv.bagUsed;
      const capacity = inv.bagCapacity;
      this.capVal.textContent = `${used} / ${capacity}`;
      this.capEl.classList.toggle('near', used >= capacity * 0.8 && used < capacity);
      this.capEl.classList.toggle('full', used >= capacity);
      const ticks = this.capBar.children;
      for (let i = 0; i < ticks.length; i++) ticks[i].classList.toggle('on', i < used);
    }
    this.creditsVal.textContent = String(this.economy?.credits ?? 0);

    // Regional trade note. Naming what this world is short of is what turns a
    // price difference into a reason to walk through a portal.
    const info = marketInfo();
    this.note.innerHTML = info?.note
      ? `<b>${info.label}</b> — ${info.note} Vendors buy back at <b>${Math.round(SELL_RATE * 100)}%</b> of base value.`
      : `Vendors buy back at <b>${Math.round(SELL_RATE * 100)}%</b> of value. Sales come out of the store first, then the bag.`;
  }

  /** Re-draw if open. Called when the world (and therefore the prices) changes. */
  refresh() {
    if (this._open) this._render();
  }

  _renderBuy() {
    if (this.market.loading) {
      this.body.appendChild(el('div', 'mkt-empty', 'Loading catalog...'));
      return;
    }
    if (this.market.error) {
      this.body.appendChild(el('div', 'mkt-empty', this.market.error));
      return;
    }

    const rows = this.market.items ?? [];
    if (!rows.length) {
      this.body.appendChild(el('div', 'mkt-empty', 'No items match this search.'));
      return;
    }

    for (const item of rows) {
      const preview = this.market.preview?.(item) ?? { ok: false, reason: 'unavailable', grant: null, stock: 0, cost: item.cost_buy };
      const blocked = !preview.ok;
      const row = el('div', `mkt-row mkt-card${blocked ? ' blocked' : ''}`);

      const art = el('div', 'mkt-art loading');
      _renderMktArt(art, item.image, item.category, item.name, item.game_action);

      const info = el('div', 'mkt-info');
      info.appendChild(el('div', 'mkt-name', item.name));
      const blurb = el('div', 'mkt-blurb');
      const stock = item.quantity == null ? '∞' : String(item.quantity);
      const world = item.world_name ? ` &nbsp;·&nbsp; ${item.world_name}` : '';
      blurb.innerHTML = `${item.description} &nbsp;·&nbsp; stock <b>${stock}</b>${world}`;
      info.appendChild(blurb);

      const meta = el('div', 'mkt-meta');
      meta.append(
        el('span', 'mkt-tag', item.category),
        el('span', 'mkt-tag', item.game_action)
      );
      info.appendChild(meta);

      const priceEl = el('div', 'mkt-price', `${preview.cost} CR`);
      const grantLabel = preview.skin && preview.reason === 'owned'
        ? 'Owned'
        : preview.grant?.kind === 'upgrade'
        ? (preview.grant.label || 'Mount upgrade')
        : preview.grant?.kind === 'unlock'
          ? (preview.reason === 'owned' ? 'Owned' : (preview.grant.label || 'Unlock skin'))
          : preview.grant
            ? `${preview.grant.qty} item${preview.grant.qty === 1 ? '' : 's'} per buy`
            : 'not usable';
      priceEl.appendChild(el('small', null, grantLabel));

      const acts = el('div', 'mkt-acts');
      const owned = preview.reason === 'owned';
      const buy = el('button', 'inv-btn mkt-buy', owned ? 'Owned' : 'Buy');
      buy.type = 'button';
      buy.disabled = blocked;
      buy.title = preview.ok ? 'Buy this item'
        : owned ? (preview.skin ? 'You already have this skin — apply it from the Mount menu (F10) while riding'
          : preview.power ? 'You already own this tier or higher'
          : 'Already unlocked — equip it in the Character menu (F2)')
        : preview.reason === 'space' ? 'Not enough room'
        : preview.reason === 'credits' ? 'Not enough credits'
        : 'Not available';
      buy.addEventListener('click', () => this._buy(item.id));
      acts.appendChild(buy);

      row.append(art, info, priceEl, acts);
      this.body.appendChild(row);
    }
  }

  _renderSell() {
    const rows = this.market.sellables;
    if (!rows.length) {
      this.body.appendChild(el('div', 'mkt-empty', 'Nothing to sell'));
      return;
    }
    for (const item of rows) {
      const row = el('div', 'mkt-row');
      row.innerHTML = itemIconSVG(item.id, 38);

      const info = el('div', 'mkt-info');
      info.appendChild(el('div', 'mkt-name', item.def?.name ?? item.id));
      const blurb = el('div', 'mkt-blurb');
      // The demand tag is the whole point of regional pricing: it tells the
      // player which of their three destinations wants what they are carrying.
      const sig = priceSignal(item.id);
      const tag = sig.tone === 'flat' ? ''
        : ` &nbsp;·&nbsp; <b class="mkt-${sig.tone}">${sig.label}</b>`;
      blurb.innerHTML = `store <b>${item.store}</b> &nbsp;·&nbsp; bag <b>${item.bag}</b> &nbsp;·&nbsp; ${item.unit} CR each${tag}`;
      info.appendChild(blurb);

      const price = el('div', `mkt-price${sig.tone === 'high' ? ' mkt-cheap' : sig.tone === 'low' ? ' mkt-dear' : ''}`,
        `${sellValue(item.id, item.total)} CR`);
      price.appendChild(el('small', null, `all ${item.total}`));

      const acts = el('div', 'mkt-acts');
      const one = el('button', 'inv-btn', 'Sell 1');
      one.type = 'button';
      one.addEventListener('click', () => this._sell(item.id, 1));
      const all = el('button', 'inv-btn mkt-sell', 'Sell all');
      all.type = 'button';
      all.addEventListener('click', () => this._sell(item.id, item.total));
      acts.append(one, all);

      row.append(info, price, acts);
      this.body.appendChild(row);
    }
  }

  /* ====================================================================== */
  /* Actions                                                                */
  /* ====================================================================== */

  _buy(packId) {
    const res = this.market.buy(packId);
    if (!res.ok) {
      this._reject(
        res.reason === 'credits' ? 'Not enough credits' :
        res.reason === 'space' ? 'No room — free a bag or store slot' :
        res.reason === 'stock' ? 'Out of stock' :
        res.reason === 'owned' ? (res.skin ? 'You already have this skin — apply it from the Mount menu (F10) while riding'
          : res.power ? 'You already own this tier or higher'
          : 'You already own this skin — equip it in the Character menu (F2)') :
        res.reason === 'unsupported' ? 'This item cannot be bought yet' :
        'Trade unavailable'
      );
    }
    this._render();
  }

  _sell(itemId, qty) {
    const res = this.market.sell(itemId, qty);
    if (!res.ok) this._reject('Nothing to sell');
    this._render();
  }

  _reject(text) {
    this.msg.textContent = text;
    this.msg.classList.remove('show');
    void this.msg.offsetWidth;
    this.msg.classList.add('show');
    clearTimeout(this._flashT);
    this._flashT = setTimeout(() => this.msg.classList.remove('show'), 2200);
  }

  _onCredits(e) {
    if (!this.creditsVal) return;
    this.creditsVal.textContent = String(e?.credits ?? this.economy?.credits ?? 0);
    if (!this._open) return;
    const cls = (e?.delta ?? 0) < 0 ? 'spend' : 'earn';
    this.creditsEl.classList.remove('spend', 'earn');
    void this.creditsEl.offsetWidth;
    this.creditsEl.classList.add(cls);
  }

  /* ====================================================================== */
  /* Open / close                                                           */
  /* ====================================================================== */

  /** @param {any} [vendor] the NPC the player is trading with */
  open(vendor) {
    if (this._open) return;
    this._open = true;
    this._hadLock = menuFocusIn(this.input);
    // A world may name the shop rather than the shopkeeper - "Galley Provisions"
    // over "Oyo Tannen". Without one it is the trader's own name, as before.
    this.vendorName.textContent = String(vendor?.vendorTitle || vendor?.name || 'Nexus Exchange').toUpperCase();
    // Rebuilt per vendor, and before the value is restored: the previous shop's
    // categories must not linger in the picker of a restricted one.
    this._buildCategoryOptions();
    const filters = this.market?.filters ?? { search: '', category: '' };
    this.searchEl.value = filters.search ?? '';
    this.categoryEl.value = filters.category ?? '';
    this.el.classList.add('open');
    this._setTab(this._tab);
    window.addEventListener('keydown', this._onKey, true);
  }

  close() {
    if (!this._open) return;
    this._open = false;
    this.el.classList.remove('open');
    window.removeEventListener('keydown', this._onKey, true);
    menuFocusOut(this.input, this._hadLock, document.querySelector('.inv-root.open') !== null);
    this._onClose?.();
  }

  _key(e) {
    if (e.code === 'Escape' || e.code === 'KeyB') {
      e.preventDefault();
      e.stopPropagation();
      this.close();
    }
  }

  /** Frame tick; the panel is event driven. */
  update() {}

  dispose() {
    this.close();
    for (const off of this._offs) {
      try {
        off();
      } catch {
        /* a bus that already cleared its handlers is not an error */
      }
    }
    this._offs.length = 0;
    clearTimeout(this._flashT);
    this.el?.remove();
  }
}
