import './inventory.css';
import { el, menuFocusIn, menuFocusOut } from './InventoryUI.js';
import { itemIconSVG, itemDef, sellValue, SELL_RATE } from '../systems/ItemDefs.js';

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

    this.body = el('div', 'mkt-body');

    const foot = el('div', 'mkt-foot');
    this.note = el('div', 'mkt-note');
    this.note.innerHTML = `Vendors buy back at <b>${Math.round(SELL_RATE * 100)}%</b> of value. Sales come out of the store first, then the bag.`;
    this.msg = el('div', 'inv-flash-msg');
    const keys = el('div', 'inv-keys');
    keys.innerHTML = '<span><b>B</b>close</span><span><b>Esc</b>close</span>';
    foot.append(this.note, this.msg, keys);

    panel.append(head, tabs, this.body, foot);
    wrap.appendChild(panel);
    this.root.appendChild(wrap);
    this.el = wrap;

    panel.addEventListener('mousedown', (e) => e.stopPropagation());
    wrap.addEventListener('mousedown', (e) => {
      if (e.target === wrap) this.close();
    });
  }

  _setTab(id) {
    this._tab = id;
    for (const key in this.tabEls) this.tabEls[key].classList.toggle('on', key === id);
    this._render();
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
  }

  _renderBuy() {
    const credits = this.economy?.credits ?? 0;
    for (const pack of this.market.packs) {
      const def = itemDef(pack.itemId);
      const room = this.inventory?.roomFor(pack.itemId) ?? 0;
      const poor = credits < pack.price;
      const cramped = room < pack.qty;

      const row = el('div', `mkt-row${poor || cramped ? ' blocked' : ''}`);
      row.innerHTML = itemIconSVG(pack.itemId, 38);

      const info = el('div', 'mkt-info');
      info.appendChild(el('div', 'mkt-name', pack.name));
      const blurb = el('div', 'mkt-blurb');
      blurb.innerHTML = cramped
        ? `${pack.blurb} — <b style="color:var(--iv-red)">no room for ${pack.qty} ${def?.short ?? ''}</b>`
        : `${pack.blurb} &nbsp;·&nbsp; you hold <b>${this.inventory?.totalCount(pack.itemId) ?? 0}</b>`;
      info.appendChild(blurb);

      const price = el('div', 'mkt-price', `${pack.price} CR`);
      price.appendChild(el('small', null, poor ? 'not enough' : `${(pack.price / pack.qty).toFixed(1)} / unit`));

      const acts = el('div', 'mkt-acts');
      const buy = el('button', 'inv-btn mkt-buy', 'Buy');
      buy.type = 'button';
      buy.disabled = poor || cramped;
      buy.addEventListener('click', () => this._buy(pack.id));
      acts.appendChild(buy);

      row.append(info, price, acts);
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
      blurb.innerHTML = `store <b>${item.store}</b> &nbsp;·&nbsp; bag <b>${item.bag}</b> &nbsp;·&nbsp; ${item.unit} CR each`;
      info.appendChild(blurb);

      const price = el('div', 'mkt-price', `${sellValue(item.id, item.total)} CR`);
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
    const res = this.market.buy(packId, 1);
    if (!res.ok) {
      this._reject(
        res.reason === 'credits' ? 'Not enough credits' : res.reason === 'space' ? 'No room — free a bag or store slot' : 'Trade unavailable'
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
    this.vendorName.textContent = (vendor?.name ?? 'Nexus Exchange').toUpperCase();
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
