import './inventory.css';
import { itemIconSVG, stackSize } from '../systems/ItemDefs.js';

/**
 * The inventory panel: store on the left, 30-slot active bag on the right.
 *
 * The design brief the panel is answering is "make it obvious that the bag
 * holds 30 *slots*, not 30 items", so the bag is drawn as a fixed 30-cell grid
 * with the empty cells visible, every filled cell states how many slots that
 * stack costs, and the header carries a 30-tick capacity bar plus the rule in
 * words. A player should never have to guess why a 60-round pack "only" took
 * one square.
 *
 * Interaction is deliberately redundant: drag between the grids, or click a
 * stack to send it across, or shift-click to send a single unit. Whichever a
 * player tries first, it works.
 */

export function el(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
}

/**
 * Take keyboard and cursor for a full-screen menu.
 *
 * Text capture is what stops WASD walking the player while a panel is open,
 * and it also means `input.pressed()` sees nothing - so every menu here binds
 * its own `keydown` listener for its close keys.
 *
 * @param {any} input
 * @returns {boolean} whether the pointer was locked before the menu opened
 */
export function menuFocusIn(input) {
  const had = !!input?.locked;
  input?.setTextCapture?.(true);
  input?.exitLock?.();
  document.body.classList.add('inv-menu-open');
  return had;
}

/**
 * Hand control back to the game. Pointer lock is re-requested on a short delay
 * because browsers reject a request that follows an Escape-driven exit too
 * closely, and an uncaught rejection would surface as a console error mid-game.
 *
 * @param {any} input
 * @param {boolean} relock
 * @param {boolean} [othersOpen=false] leave the body class alone if another menu is up
 */
export function menuFocusOut(input, relock, othersOpen = false) {
  input?.setTextCapture?.(false);
  if (!othersOpen) document.body.classList.remove('inv-menu-open');
  if (!relock) return;
  setTimeout(() => {
    try {
      const p = input?.canvas?.requestPointerLock?.();
      if (p && typeof p.catch === 'function') p.catch(() => {});
    } catch {
      /* the pause overlay is the fallback; never throw out of a menu close */
    }
  }, 140);
}

export class InventoryUI {
  /**
   * @param {{ bus?:any, inventory:any, economy?:any, input?:any, root:HTMLElement }} ctx
   */
  constructor({ bus, inventory, economy, input, root }) {
    this.bus = bus ?? null;
    this.inventory = inventory;
    this.economy = economy ?? null;
    this.input = input ?? null;
    this.root = root;

    this._open = false;
    this._hadLock = false;
    /** @type {{zone:string, id:string}|null} */
    this._drag = null;
    this._flashT = null;
    /** Items that just arrived, so the landing cell can flash. */
    this._recent = new Set();
    this._detailRow = null;
    this._detailZone = null;

    this._build();

    /** @type {Array<() => void>} */
    this._offs = [];
    if (bus) {
      this._offs.push(bus.on('inventory:changed', () => this._render()));
      this._offs.push(bus.on('credits:changed', (e) => this._onCredits(e)));
      this._offs.push(bus.on('inventory:full', (e) => this._reject(this._fullMessage(e))));
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
    const panel = el('div', 'inv-panel interactive');

    /* -- header ------------------------------------------------------- */
    const head = el('div', 'inv-head');

    const title = el('div', 'inv-title');
    title.append(el('b', null, 'INVENTORY'), el('span', null, 'Load manager'));

    const cap = el('div', 'inv-cap');
    this.capEl = cap;
    const capRow = el('div', 'inv-cap-row');
    this.capVal = el('span', 'inv-cap-val', '0 / 30');
    capRow.append(this.capVal, el('span', 'inv-cap-unit', 'bag slots'));
    this.capBar = el('div', 'inv-cap-bar');
    for (let i = 0; i < this.inventory.bagCapacity; i++) this.capBar.appendChild(el('i'));
    const note = el('div', 'inv-cap-note');
    note.innerHTML = 'Capacity is counted in <b>slots</b>, not items — one full stack fills one slot, so <b>60 rounds = 1 slot</b>.';
    cap.append(capRow, this.capBar, note);

    this.creditsEl = el('div', 'inv-credits');
    this.creditsEl.innerHTML = itemIconSVG('credits', 22);
    this.creditsVal = el('b', null, String(this.economy?.credits ?? 0));
    this.creditsEl.appendChild(this.creditsVal);

    const close = el('button', 'inv-x', 'ESC');
    close.type = 'button';
    close.addEventListener('click', () => this.close());

    head.append(title, cap, this.creditsEl, close);

    /* -- body --------------------------------------------------------- */
    const body = el('div', 'inv-body');

    const store = this._column('store', 'STORE', 'Everything you own');
    const mid = el('div', 'inv-mid');
    mid.append(el('div', 'rule'), el('i', null, '«'), el('i', null, '»'), el('div', 'rule'));
    const bag = this._column('bag', 'ACTIVE BAG', 'Carried into the world');

    body.append(store.col, mid, bag.col);
    this.storeGrid = store.grid;
    this.storeSub = store.sub;
    this.bagGrid = bag.grid;
    this.bagSub = bag.sub;

    /* -- footer ------------------------------------------------------- */
    const foot = el('div', 'inv-foot');
    this.detail = el('div', 'inv-detail');
    this._setDetail(null);
    this.useBtn = el('button', 'inv-btn inv-use', 'Use');
    this.useBtn.type = 'button';
    this.useBtn.addEventListener('click', () => {
      if (!this._detailRow) return;
      this.bus?.emit('inventory:use', { itemId: this._detailRow.id });
    });
    this.useBtn.hidden = true;
    this.msg = el('div', 'inv-flash-msg');

    const keys = el('div', 'inv-keys');
    keys.innerHTML =
      '<span><b>Click</b>move stack</span>' +
      '<span><b>⇧</b>move one</span>' +
      '<span><b>Drag</b>between panels</span>' +
      '<span><b>I</b>close</span>';

    foot.append(this.detail, this.useBtn, this.msg, keys);

    panel.append(head, body, foot);
    wrap.appendChild(panel);
    this.root.appendChild(wrap);
    this.el = wrap;

    // A stray click inside the panel must not re-request pointer lock.
    panel.addEventListener('mousedown', (e) => e.stopPropagation());
    wrap.addEventListener('mousedown', (e) => {
      if (e.target === wrap) this.close(); // click-away on the scrim
    });
  }

  /** One titled column with a sort button and a drop-target grid. */
  _column(zone, label, subtitle) {
    const col = el('div', `inv-col ${zone}`);
    const head = el('div', 'inv-colhead');
    head.appendChild(el('h3', null, label));
    const sub = el('div', 'inv-colsub', subtitle);
    const sort = el('button', 'inv-btn', 'Sort');
    sort.type = 'button';
    sort.addEventListener('click', () => this.inventory.sort(zone));
    head.append(sub, sort);

    const grid = el('div', 'inv-grid');
    grid.dataset.zone = zone;
    grid.addEventListener('dragover', (e) => {
      if (!this._drag || this._drag.zone === zone) return;
      e.preventDefault();
      grid.classList.add('drop-target');
    });
    grid.addEventListener('dragleave', () => grid.classList.remove('drop-target'));
    grid.addEventListener('drop', (e) => {
      e.preventDefault();
      grid.classList.remove('drop-target');
      if (!this._drag || this._drag.zone === zone) return;
      this._move(this._drag.id, this._drag.zone, e.shiftKey ? 1 : Infinity);
      this._drag = null;
    });

    col.append(head, grid);
    return { col, grid, sub };
  }

  /* ====================================================================== */
  /* Render                                                                 */
  /* ====================================================================== */

  _render() {
    if (!this._open) return;
    const inv = this.inventory;

    this._fillGrid(this.bagGrid, inv.bag, 'bag', inv.bagCapacity);
    this._fillGrid(this.storeGrid, inv.items, 'store', inv.storeCapacity);

    const used = inv.bagUsed;
    const capacity = inv.bagCapacity;
    this.capVal.textContent = `${used} / ${capacity}`;
    this.capEl.classList.toggle('near', used >= capacity * 0.8 && used < capacity);
    this.capEl.classList.toggle('full', used >= capacity);
    const ticks = this.capBar.children;
    for (let i = 0; i < ticks.length; i++) ticks[i].classList.toggle('on', i < used);

    this.bagSub.textContent = `${used} / ${capacity} slots used`;
    this.storeSub.textContent = `${inv.storeUsed} / ${inv.storeCapacity} slots used`;
    this.creditsVal.textContent = String(this.economy?.credits ?? 0);
    if (this._detailRow) {
      const source = this._detailZone === 'bag' ? inv.bag : inv.items;
      const next = source.find((row) => row.id === this._detailRow.id) ?? null;
      this._setDetail(next, this._detailZone);
    }
    this._recent.clear();
  }

  /**
   * Draw a container. Empty cells are rendered too - a grid of 30 squares is
   * what makes the capacity rule legible at a glance.
   */
  _fillGrid(grid, rows, zone, capacity) {
    grid.textContent = '';
    for (const row of rows) grid.appendChild(this._slot(row, zone));
    const used = rows.reduce((n, r) => n + r.slots, 0);
    for (let i = used; i < capacity; i++) grid.appendChild(el('div', 'inv-slot empty'));
  }

  _slot(row, zone) {
    const def = row.def;
    const stack = stackSize(row.id);
    const cell = el('div', `inv-slot filled kind-${def?.kind ?? 'ammo'}`);
    cell.draggable = true;
    cell.dataset.id = row.id;
    cell.dataset.zone = zone;
    cell.innerHTML = itemIconSVG(row.id, 44);

    cell.appendChild(el('div', 'inv-name', def?.name ?? row.id));
    const qty = el('div', `inv-qty${row.qty >= stack ? ' max' : ''}`, `×${row.qty}`);
    cell.appendChild(qty);
    // Slot cost, spelled out on anything that spans more than one.
    cell.appendChild(el('div', 'inv-slots', row.slots > 1 ? `${row.slots} SLOTS` : '1 SLOT'));
    if (this._recent.has(`${zone}:${row.id}`)) cell.classList.add('flash');

    cell.title = `${def?.name ?? row.id} — ${row.qty} held, stacks of ${stack}`;
    cell.addEventListener('mouseenter', () => this._setDetail(row, zone));
    cell.addEventListener('click', (e) => this._move(row.id, zone, e.shiftKey ? 1 : Infinity));
    cell.addEventListener('dragstart', (e) => {
      this._drag = { zone, id: row.id };
      cell.classList.add('dragging');
      e.dataTransfer?.setData('text/plain', row.id);
      if (e.dataTransfer) e.dataTransfer.effectAllowed = 'move';
    });
    cell.addEventListener('dragend', () => {
      cell.classList.remove('dragging');
      this._drag = null;
    });
    return cell;
  }

  _setDetail(row, zone) {
    this._detailRow = row ?? null;
    this._detailZone = row ? zone : null;
    const def = row?.def;
    const usable = !!def && zone === 'bag' && def.kind === 'consumable';
    this.useBtn.hidden = !usable;
    this.useBtn.disabled = !usable;
    this.detail.textContent = '';
    if (!def) {
      this.detail.innerHTML = `<div class="inv-detail-body"><div class="inv-detail-name">Select an item</div>
        <div class="inv-detail-sub">Hover a stack to inspect it. The bag holds <b>30 slots</b>; each slot holds one full stack.</div></div>`;
      return;
    }
    const stack = stackSize(def.id);
    this.detail.innerHTML =
      itemIconSVG(def.id, 30) +
      `<div class="inv-detail-body">
        <div class="inv-detail-name">${def.name}</div>
        <div class="inv-detail-sub">${def.desc} &nbsp;·&nbsp; stacks of <b>${stack}</b> &nbsp;·&nbsp;
          worth <b>${def.value} CR</b> each &nbsp;·&nbsp; ${row.qty} in ${zone === 'bag' ? 'bag' : 'store'}
          (<b>${row.slots}</b> slot${row.slots === 1 ? '' : 's'})</div>
         ${usable ? '<div class="inv-detail-sub">Click <b>Use</b> to apply the item effect.</div>' : ''}
      </div>`;
  }

  /* ====================================================================== */
  /* Actions                                                                */
  /* ====================================================================== */

  /** Move `id` out of `fromZone`. `qty === Infinity` means the whole stack. */
  _move(id, fromZone, qty) {
    const inv = this.inventory;
    const want = qty === Infinity ? (fromZone === 'bag' ? inv.bagCount(id) : inv.count(id)) : qty;
    if (want <= 0) return;
    const moved = fromZone === 'bag' ? inv.moveToStore(id, want) : inv.moveToBag(id, want);
    if (moved <= 0) {
      this._reject(fromZone === 'bag' ? 'Store is full' : 'Bag is full — 30 slots is the limit');
      return;
    }
    this._recent.add(`${fromZone === 'bag' ? 'store' : 'bag'}:${id}`);
    this._render();
  }

  _fullMessage(e) {
    if (e?.where === 'bag') return 'Bag is full — 30 slots is the limit';
    if (e?.where === 'store') return 'Store is full';
    return 'No space left';
  }

  /** Brief red line in the footer. Only meaningful while the panel is open. */
  _reject(text) {
    if (!this._open || !text) return;
    this.msg.textContent = text;
    this.msg.classList.remove('show');
    void this.msg.offsetWidth; // restart the nudge
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

  open() {
    if (this._open) return;
    this._open = true;
    this._hadLock = menuFocusIn(this.input);
    this.el.classList.add('open');
    this._setDetail(null);
    this._render();
    window.addEventListener('keydown', this._onKey, true);
    this.bus?.emit('inventory:open', {});
  }

  close() {
    if (!this._open) return;
    this._open = false;
    this.el.classList.remove('open');
    window.removeEventListener('keydown', this._onKey, true);
    this._drag = null;
    menuFocusOut(this.input, this._hadLock, document.querySelector('.inv-root.open') !== null);
    this.bus?.emit('inventory:close', {});
  }

  toggle() {
    if (this._open) this.close();
    else this.open();
  }

  _key(e) {
    if (e.code === 'Escape' || e.code === 'KeyI') {
      e.preventDefault();
      e.stopPropagation();
      this.close();
    }
  }

  /** Frame tick. The panel is event driven; this exists for the contract's sake. */
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
