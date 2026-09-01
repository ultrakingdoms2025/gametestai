import './inventory.css';
import { itemIconSVG, stackSize } from '../systems/ItemDefs.js';
import { HoldToUse, HOLD_TO_USE_MS } from './HoldToUse.js';

/**
 * The inventory panel: store on the left, active bag on the right.
 *
 * The design brief the panel is answering is "make it obvious that the bag
 * holds *slots*, not items", so the bag is drawn as a full grid of cells with
 * the empty ones visible, every filled cell states how many slots that stack
 * costs, and the header carries a one-tick-per-slot capacity bar plus the rule
 * in words. A player should never have to guess why a 60-round pack "only"
 * took one square.
 *
 * THE CELL COUNT AND THE TICK COUNT ARE BOTH READ, NEVER WRITTEN DOWN. A bag
 * starts at 30 slots and expansion rigs grow it to at most 60
 * (`Inventory.expandBag`), so every "30" that used to be a literal in this file
 * - the grid padding, the tick loop, the detail line, the two full-bag
 * messages - now asks `inventory.bagCapacity`. The grid scrolls, so sixty
 * cells cost the panel height rather than layout.
 *
 * Interaction is deliberately redundant: drag between the grids, or click a
 * stack to send it across, or shift-click to send a single unit. Whichever a
 * player tries first, it works.
 *
 * Using an item is the one gesture that must NOT be easy to do by accident,
 * because it destroys the unit: hover a usable bag item and a "HOLD" ring
 * appears; press and hold the primary button and the ring fills while the
 * number counts 3, 2, 1; at three seconds the item is used through the same
 * `inventory:use` event the Use button fires. Let go early and nothing
 * happens. The timing lives in `HoldToUse` so it can be tested off the DOM.
 */

/**
 * Tick count past which the capacity bar tightens its gutter.
 *
 * A UI threshold, not the model's starting capacity that happens to share its
 * value: the bar is 2 px-gutter comfortable up to about thirty ticks in a
 * phone-width header and is not past it. Named so the `dense` class has a
 * reason written beside it rather than a bare 30 in a comparison.
 */
const DENSE_TICK_THRESHOLD = 30;

/**
 * Make a `.inv-cap-bar` hold exactly `capacity` ticks.
 *
 * ── WHY THIS IS A REBUILD, AND WHY IT IS A MODULE FUNCTION ──────────────
 * `Inventory.expandBag` deliberately raises no capacity-specific event; it
 * raises `inventory:changed` like every other mutation, and that event has
 * always carried `bagCapacity`. So the bar is corrected from the ONE place a
 * panel already redraws from, on both routes into a redraw - the bus listener
 * while the panel is open, and `open()`'s own render for a bag that grew while
 * it was shut. A dedicated event would have been a second subscription doing
 * the same job, and the failure that shape produces is the one being fixed
 * here: a bar that stops agreeing with the bag and never says so.
 *
 * TWO PANELS DRAW THIS BAR. `InventoryUI` and `MarketplaceUI` both build a
 * `.inv-cap-bar` in their own `_build`, and both used to fill it once, with a
 * loop, and never touch the count again. The shop's copy is the worse of the
 * two: it is the panel that SELLS the expansion rig, so a player who bought
 * one, fitted it and walked back to the counter would have read "45 / 60" over
 * a bar of thirty ticks, all of them lit. One function, called from both
 * renders, is what stops that being fixed in one place and not the other.
 *
 * Cheap enough to call every render: it compares a child count first and
 * touches the DOM only when the number has actually moved, which for the
 * overwhelming majority of redraws is never.
 *
 * The column count is written INLINE because it is data, not styling - the
 * stylesheet cannot know how many slots this player has bought. `dense`
 * tightens the 2 px gutter to 1 px past thirty ticks, because sixty ticks and
 * fifty-nine 2 px gaps inside a phone-width header leaves each tick barely a
 * pixel of its own.
 *
 * @param {HTMLElement} bar the `.inv-cap-bar` element
 * @param {number} capacity slots the bag can hold right now
 */
export function syncCapTicks(bar, capacity) {
  if (!bar) return;
  const want = Math.max(0, Math.floor(Number(capacity) || 0));
  if (bar.childElementCount === want) return;
  bar.textContent = '';
  for (let i = 0; i < want; i++) bar.appendChild(el('i'));
  bar.style.gridTemplateColumns = `repeat(${want}, 1fr)`;
  bar.classList.toggle('dense', want > DENSE_TICK_THRESHOLD);
}

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
  // Another panel is still up. MarketplaceUI shares these helpers AND the
  // .inv-root class, so closing the inventory on top of an open marketplace
  // used to release text capture while a live modal was still on screen -
  // gameplay keys (WASD, weapon binds) resumed underneath it. Re-requesting
  // pointer lock here would be wrong for the same reason, so bail entirely
  // and let whichever panel is still open own focus until IT closes.
  if (othersOpen) return;
  input?.setTextCapture?.(false);
  document.body.classList.remove('inv-menu-open');
  if (!relock) return;
  setTimeout(() => {
    /* Re-engage. `reengage()` re-arms `navigator.keyboard` as well as taking
     * the pointer back (`exitLock` released both, and reclaiming only the
     * pointer leaves browser shortcuts like Ctrl+W live), and it decides WHICH
     * engagement to re-take - which is the whole point: this used to be a bare
     * `canvas.requestPointerLock()`, a method a phone does not have, so closing
     * this panel on touch left the player stood down with `standby` still held
     * and the world frozen behind nothing. @see core/Input.js `reengage` */
    const p = input?.reengage?.();
    if (p && typeof p.catch === 'function') p.catch(() => {});
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

    /* -- hold to use --------------------------------------------------- */
    this._hold = new HoldToUse();
    /** @type {{ cell: HTMLElement, id: string, num: HTMLElement }|null} */
    this._holdView = null;
    this._holdRaf = 0;
    this._onHoldTick = () => this._tickHold();
    /* Window-level release: the pointer can come up anywhere - off the cell,
     * off the panel, off the window - and every one of those must end the
     * hold. Bound while the panel is open only (see `open`/`close`). */
    this._onPointerUp = () => {
      this._cancelHold();
      /* pointerup → mouseup → click are dispatched back to back in the same
       * task, so a zero-delay timer runs AFTER the click the timer told us to
       * swallow. Clearing synchronously here would un-arm it one event early. */
      setTimeout(() => this._hold.release(), 0);
    };

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
    /* Built through the same method `_render` re-runs, NOT by a loop that only
     * happens once. The bar used to be filled here and nowhere else, which was
     * correct for exactly as long as the bag could never grow: a player who
     * fitted a +15 rig got a 45-slot bag with a 30-tick bar, and the bar then
     * under-reported for the rest of the session with no way to notice except
     * counting the squares. @see syncCapTicks */
    syncCapTicks(this.capBar, this.inventory.bagCapacity);
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

    const actRow = el('div', 'inv-act-row');
    this.useBtn = el('button', 'inv-btn inv-use', 'Use');
    this.useBtn.type = 'button';
    this.useBtn.addEventListener('click', () => {
      if (!this._detailRow) return;
      this.bus?.emit('inventory:use', { itemId: this._detailRow.id });
    });
    this.useBtn.hidden = true;

    this.dropBtn = el('button', 'inv-btn inv-drop', 'Drop');
    this.dropBtn.type = 'button';
    this.dropBtn.addEventListener('click', () => {
      if (!this._detailRow || this._detailZone !== 'bag') return;
      const id = this._detailRow.id;
      const qty = this.inventory.bagCount(id);
      if (qty <= 0) return;
      // Remove from bag entirely (do not move to store — it would be a duplicate
      // if the world pickup is collected again). consumeFromBag fires inventory:changed
      // which calls _render() via the bus listener.
      const dropped = this.inventory.consumeFromBag(id, qty) ? qty : 0;
      if (dropped <= 0) return;
      this.bus?.emit('inventory:drop', { itemId: id, qty: dropped });
      this._setDetail(null);
    });
    this.dropBtn.hidden = true;

    actRow.append(this.useBtn, this.dropBtn);
    this._setDetail(null); // must come after useBtn and dropBtn are created
    this.msg = el('div', 'inv-flash-msg');

    const keys = el('div', 'inv-keys');
    keys.innerHTML =
      '<span><b>Click</b>move stack</span>' +
      '<span><b>⇧</b>move one</span>' +
      '<span><b>Drag</b>between panels</span>' +
      '<span><b>Hold 3s</b>use item</span>' +
      '<span><b>Hover</b>select · Use/Drop below</span>' +
      '<span><b>I</b>close</span>';

    foot.append(this.detail, actRow, this.msg, keys);

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

    // The cells are about to be rebuilt; a hold on one of them has nothing
    // left to draw into. (A fired hold has already cleared itself.)
    this._cancelHold();
    this._fillGrid(this.bagGrid, inv.bag, 'bag', inv.bagCapacity);
    this._fillGrid(this.storeGrid, inv.items, 'store', inv.storeCapacity);

    const used = inv.bagUsed;
    const capacity = inv.bagCapacity;
    this.capVal.textContent = `${used} / ${capacity}`;
    this.capEl.classList.toggle('near', used >= capacity * 0.8 && used < capacity);
    this.capEl.classList.toggle('full', used >= capacity);
    syncCapTicks(this.capBar, capacity);
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
   * Draw a container. Empty cells are rendered too - a grid of `capacity`
   * squares is what makes the capacity rule legible at a glance, and it grows
   * with the bag because the count comes from the caller, not from a literal.
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
    if (this._recent.has(`${zone}:${row.id}`)) cell.classList.add('inv-landed');

    cell.title = `${def?.name ?? row.id} — ${row.qty} held, stacks of ${stack}`;
    cell.addEventListener('mouseenter', () => this._setDetail(row, zone));
    cell.addEventListener('click', (e) => {
      // The release at the end of a hold - completed or abandoned - is not a
      // request to move the stack.
      if (this._hold.swallowClick) return;
      this._move(row.id, zone, e.shiftKey ? 1 : Infinity);
    });

    if (this._usable(def, zone)) {
      cell.classList.add('usable');
      cell.title += ` — hold ${HOLD_TO_USE_MS / 1000}s to use`;
      const hold = el('div', 'inv-hold');
      hold.append(el('i', 'inv-hold-ring'), el('b', 'inv-hold-num', 'HOLD'));
      cell.appendChild(hold);
      cell.addEventListener('pointerdown', (e) => {
        if (e.button !== 0) return; // primary button only; right-click is nothing here
        this._beginHold(row, zone, cell, hold.lastElementChild);
      });
      // Any way the pointer stops being "down on this cell" ends the hold.
      cell.addEventListener('pointerup', () => this._cancelHold());
      cell.addEventListener('pointerleave', () => this._cancelHold());
      cell.addEventListener('pointercancel', () => this._cancelHold());
      // A long press on touch would otherwise pop the context menu mid-count.
      cell.addEventListener('contextmenu', (e) => {
        if (this._hold.active) e.preventDefault();
      });
    }

    cell.addEventListener('dragstart', (e) => {
      this._cancelHold(); // the press became a drag; that is a different gesture
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

  /** Only bag items have an effect to apply; only consumables, skins and mount upgrades have one at all. */
  _usable(def, zone) {
    return !!def && zone === 'bag' && this._hasUse(def);
  }

  /**
   * Whether this KIND of item can ever be used, ignoring which container it is
   * sitting in. Split out from `_usable` so the detail pane can tell the
   * difference between "this can never be used" and "this can be used, but not
   * from here" - the second used to be silent, and a player looking at a
   * medkit in the store saw exactly what they would have seen looking at a
   * lump of scrap: no button, no ring, no explanation.
   *
   * @param {any} def
   * @returns {boolean}
   */
  _hasUse(def) {
    return !!def && (def.kind === 'consumable' || def.kind === 'skin' || def.kind === 'mountpower'
      || def.kind === 'shipskin');
  }

  /* -- hold to use --------------------------------------------------------- */

  _beginHold(row, zone, cell, num) {
    this._cancelHold();
    this._hold.begin(`${zone}:${row.id}`, performance.now());
    this._holdView = { cell, id: row.id, num };
    /* Native HTML5 drag and a three-second hold cannot share one press.
     * Blink promotes a press into a drag after about four pixels of travel,
     * and `dragstart` tears the hold down - so asking a player to hold a
     * `cursor: grab` cell perfectly still for three seconds was asking them
     * to lose. Usable cells therefore stop being draggable for the duration
     * of the press and become draggable again the moment it ends. Moving a
     * consumable across is still a plain click (or shift-click for one), so
     * no capability is lost; only the redundant gesture on this one cell is,
     * and only while the button is actually down. */
    cell.draggable = false;
    cell.classList.add('holding');
    cell.style.setProperty('--hold', '0');
    num.textContent = String(HOLD_TO_USE_MS / 1000);
    this._holdRaf = requestAnimationFrame(this._onHoldTick);
  }

  _tickHold() {
    this._holdRaf = 0;
    const view = this._holdView;
    if (!view || !this._hold.active) return;
    const { progress, seconds, fired } = this._hold.advance(performance.now());
    if (fired) {
      const id = view.id;
      this._clearHoldView();
      // Same path as the Use button. ItemUse decides whether the effect can
      // apply, consumes the unit, and toasts; `inventory:changed` redraws us.
      this.bus?.emit('inventory:use', { itemId: id });
      return;
    }
    view.cell.style.setProperty('--hold', progress.toFixed(4));
    view.num.textContent = String(seconds);
    this._holdRaf = requestAnimationFrame(this._onHoldTick);
  }

  _cancelHold() {
    this._hold.cancel(performance.now());
    this._clearHoldView();
  }

  _clearHoldView() {
    if (this._holdRaf) cancelAnimationFrame(this._holdRaf);
    this._holdRaf = 0;
    const view = this._holdView;
    this._holdView = null;
    if (!view) return;
    // Hand the drag gesture back; see `_beginHold`.
    view.cell.draggable = true;
    view.cell.classList.remove('holding');
    view.cell.style.removeProperty('--hold');
    view.num.textContent = 'HOLD';
  }

  _setDetail(row, zone) {
    this._detailRow = row ?? null;
    this._detailZone = row ? zone : null;
    const def = row?.def;
    const inBag = zone === 'bag';
    const usable = this._usable(def, zone);
    const droppable = !!def && inBag;
    this.useBtn.hidden = !usable;
    this.useBtn.disabled = !usable;
    this.dropBtn.hidden = !droppable;
    this.dropBtn.disabled = !droppable;
    this.detail.textContent = '';
    if (!def) {
      /* The capacity is READ, never written down. This line said "30 slots"
       * for as long as 30 was the only number a bag could be; a player who had
       * fitted an expansion rig was then being told by the panel that their
       * 45-slot bag held 30, directly under a bar drawing 45 ticks. */
      this.detail.innerHTML = `<div class="inv-detail-body"><div class="inv-detail-name">Select an item</div>
        <div class="inv-detail-sub">Hover a stack to inspect it. The bag holds <b>${this.inventory.bagCapacity} slots</b>; each slot holds one full stack.</div></div>`;
      return;
    }
    const stack = stackSize(def.id);
    /* `noSell` rows print "not for sale" rather than a price. A mount upgrade
     * carries a `value` because `sellValue` is arithmetic over every item, but
     * `Marketplace.sellables` skips it and `sell()` refuses it - so quoting the
     * number sent a player to a merchant to look for a row that is not there. */
    const actions = [];
    if (usable) actions.push(`Hold the mouse button on it for <b>${HOLD_TO_USE_MS / 1000}s</b> to use it, or click <b>Use</b>.`);
    // Usable, but not from the store: say so rather than showing nothing.
    if (!usable && !inBag && this._hasUse(def)) {
      actions.push('Move it to your <b>Active Bag</b> to use it — click the stack to send it across.');
    }
    if (droppable) actions.push('Click <b>Drop</b> to leave it on the map.');
    this.detail.innerHTML =
      itemIconSVG(def.id, 30) +
      `<div class="inv-detail-body">
        <div class="inv-detail-name">${def.name}</div>
        <div class="inv-detail-sub">${def.desc} &nbsp;·&nbsp; stacks of <b>${stack}</b> &nbsp;·&nbsp;
          ${def.noSell ? '<b>not for sale</b>' : `worth <b>${def.value} CR</b> each`} &nbsp;·&nbsp; ${row.qty} in ${zone === 'bag' ? 'bag' : 'store'}
          (<b>${row.slots}</b> slot${row.slots === 1 ? '' : 's'})</div>
         ${actions.length ? `<div class="inv-detail-sub">${actions.join(' ')}</div>` : ''}
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
    // Pre-populate _recent before calling the inventory method so that the
    // _render() triggered synchronously by inventory:changed already has the
    // destination key. Without this, a second _render() call would be needed and
    // the two back-to-back DOM rebuilds in the same frame caused blank squares.
    const destKey = `${fromZone === 'bag' ? 'store' : 'bag'}:${id}`;
    this._recent.add(destKey);
    const moved = fromZone === 'bag' ? inv.moveToStore(id, want) : inv.moveToBag(id, want);
    if (moved <= 0) {
      this._recent.delete(destKey);
      this._reject(fromZone === 'bag' ? 'Store is full' : this._bagFullMessage());
      return;
    }
    // _render() was already called by the inventory:changed listener above.
  }

  _fullMessage(e) {
    if (e?.where === 'bag') return this._bagFullMessage();
    if (e?.where === 'store') return 'Store is full';
    return 'No space left';
  }

  /**
   * "Bag is full" in the player's own numbers.
   *
   * Two callers, one string, and it is built from `bagCapacity` rather than
   * from the 30 that used to be written into both of them - a player who has
   * bought their way to 45 slots being told that "30 slots is the limit" would
   * reasonably conclude the rig they paid for had done nothing. Where the bag
   * has actually been grown the message says so, because at that point the
   * limit is a thing the player bought and is entitled to see acknowledged.
   *
   * @returns {string}
   */
  _bagFullMessage() {
    return `Bag is full — ${this.inventory.bagCapacity} slots is the limit`;
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
    window.addEventListener('pointerup', this._onPointerUp, true);
    window.addEventListener('pointercancel', this._onPointerUp, true);
    this.bus?.emit('inventory:open', {});
  }

  close() {
    if (!this._open) return;
    this._open = false;
    this.el.classList.remove('open');
    window.removeEventListener('keydown', this._onKey, true);
    window.removeEventListener('pointerup', this._onPointerUp, true);
    window.removeEventListener('pointercancel', this._onPointerUp, true);
    this._cancelHold();
    this._hold.release();
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
      // stopImmediatePropagation prevents bubble-phase handlers on window from
      // reopening the panel — needed because keyboard events can target window
      // itself (e.g. in fullscreen/pointer-lock), where stopPropagation alone
      // does not block same-element bubble handlers.
      e.stopImmediatePropagation();
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
