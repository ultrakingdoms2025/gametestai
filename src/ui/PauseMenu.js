/**
 * The Esc hub's list widget: a pure model plus a thin DOM view.
 *
 * Game-agnostic on purpose. It knows nothing about mounts, worlds or pointer
 * lock - `main.js` supplies items as data and the HUD owns the card, the
 * keyboard and the return-to-hub bookkeeping. Same split as
 * `MountMenuLogic`/`MountMenu`, for the same reason: the interesting rules
 * (visible, disabled and why, where the highlight goes) are testable under
 * Node and the DOM half has none.
 *
 * `pause-menu.css` is loaded by a `<link>` in `index.html` alongside `hud.css`
 * rather than imported here, so this file stays importable without a bundler.
 *
 * An item is:
 *   { id, label: string|(()=>string), hint?: string|(()=>string),
 *     enabled?: () => true|string, visible?: () => boolean, run: () => void,
 *     keepOpen?: boolean, overlay?: boolean }
 */

/**
 * Every id the hub is expected to carry, in menu order. The source guard in
 * `scripts/tests/pause-menu.test.mjs` checks `main.js` wires all of them - a
 * silently missing row is invisible at runtime, because a menu with one fewer
 * item still works perfectly.
 */
export const PAUSE_MENU_IDS = [
  'resume', 'character', 'mount', 'ship', 'inventory', 'quests', 'records', 'map', 'race',
  'minigame-quit',
  'help', 'audio', 'keybinds', 'fullscreen', 'graphics', 'diagnostics', 'save', 'load',
  'bug-report', 'quit',
];

/** Resolve a `string | () => string` field. */
function textOf(v) {
  if (typeof v === 'function') return String(v() ?? '');
  return v == null ? '' : String(v);
}

/** Pure list logic. No DOM, no game references. */
export class PauseMenuModel {
  constructor() {
    /** @type {Array<{title?: string, items: Array<object>}>} */
    this._groups = [];
    /** Index into `visibleItems()`, not into any group. */
    this.focus = 0;
  }

  setItems(groups) {
    this._groups = Array.isArray(groups) ? groups : [];
    this.focus = 0;
  }

  get groups() {
    return this._groups;
  }

  /** Flattened, in menu order, with `visible:false` items dropped. */
  visibleItems() {
    const out = [];
    for (const g of this._groups) {
      for (const it of g?.items ?? []) {
        const vis = typeof it.visible === 'function' ? !!it.visible() : it.visible !== false;
        if (vis) out.push(it);
      }
    }
    return out;
  }

  /**
   * `true`, or the reason string the item gave. A bare `false` is normalised to
   * a reason so callers only ever see `true | string` - a tooltip reading
   * "false" is worse than a vague one.
   */
  isEnabled(item) {
    if (!item || item.enabled == null) return true;
    const r = typeof item.enabled === 'function' ? item.enabled() : item.enabled;
    if (r === true || r == null) return true;
    if (r === false) return 'Unavailable';
    return String(r);
  }

  labelOf(item) { return textOf(item?.label); }

  hintOf(item) { return textOf(item?.hint); }

  /** The item under the highlight, clamped if the list shrank under it. */
  focusedItem() {
    const items = this.visibleItems();
    if (items.length === 0) return null;
    if (this.focus >= items.length) this.focus = items.length - 1;
    if (this.focus < 0) this.focus = 0;
    return items[this.focus] ?? null;
  }

  /** Put the highlight on the first item that can actually be chosen. */
  focusFirst() {
    const items = this.visibleItems();
    this.focus = 0;
    for (let i = 0; i < items.length; i++) {
      if (this.isEnabled(items[i]) === true) { this.focus = i; return; }
    }
  }

  /**
   * Step the highlight, wrapping, skipping anything disabled or hidden.
   * @param {number} delta
   * @returns {object|null} the newly focused item
   */
  move(delta) {
    const items = this.visibleItems();
    const n = items.length;
    if (n === 0) return null;
    const step = delta < 0 ? -1 : 1;
    let i = this.focus;
    // At most one lap: a list where everything is disabled must not spin.
    for (let tries = 0; tries < n; tries++) {
      i = (i + step + n) % n;
      if (this.isEnabled(items[i]) === true) { this.focus = i; return items[i]; }
    }
    return this.focusedItem();
  }

  /**
   * Resolve what Enter/click should act on. Deliberately does NOT call `run`:
   * the host runs it, once, because hiding the hub has to happen before the
   * panel opens.
   * @returns {object|null}
   */
  activate() {
    const item = this.focusedItem();
    if (!item || this.isEnabled(item) !== true) return null;
    return item;
  }
}

function el(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
}

/** The model with a list of buttons attached. */
export class PauseMenu {
  /** @param {{root: HTMLElement, onActivate?: (item: object, keepOpen: boolean) => void}} ctx */
  constructor({ root, onActivate } = {}) {
    this.model = new PauseMenuModel();
    this.onActivate = onActivate ?? null;
    /** @type {Array<{item, btn, labelEl, hintEl}>} */
    this._rows = [];
    this.el = el('div', 'pm-root');
    /* A real menu, not a div of buttons. `aria-activedescendant` on the
     * container is what tells a screen reader the highlight moved: the rows are
     * focusable in their own right (see `_paintFocus`), but the arrow keys are
     * intercepted at `window` in capture, so DOM focus alone would never
     * announce anything. */
    this.el.setAttribute('role', 'menu');
    root?.appendChild(this.el);
  }

  setItems(groups) {
    this.model.setItems(groups);
    this._build();
    this.refresh();
  }

  _build() {
    this.el.textContent = '';
    this._rows = [];
    for (const g of this.model.groups) {
      const sec = el('section', 'pm-group');
      if (g?.title) sec.appendChild(el('h3', 'pm-group-t', g.title));
      for (const item of g?.items ?? []) {
        const btn = el('button', 'pm-item');
        btn.type = 'button';
        btn.dataset.id = String(item.id ?? '');
        btn.setAttribute('role', 'menuitem');
        // `aria-activedescendant` can only point at an element with an id.
        btn.id = `pm-item-${item.id ?? this._rows.length}`;
        const labelEl = el('span', 'pm-label');
        const hintEl = el('span', 'pm-hint');
        btn.append(labelEl, hintEl);
        /* The card behind this resumes on a background mousedown, so every
         * button stops its own - otherwise choosing "Audio" would also relock. */
        btn.addEventListener('mousedown', (e) => e.stopPropagation());
        btn.addEventListener('mouseenter', () => this._focusItem(item));
        btn.addEventListener('click', (e) => {
          e.stopPropagation();
          // `aria-disabled` rows still receive clicks: never act on the
          // *focused* item when the *clicked* one is off.
          if (this.model.isEnabled(item) !== true) return;
          this._focusItem(item);
          this.activate();
        });
        sec.appendChild(btn);
        this._rows.push({ item, btn, labelEl, hintEl });
      }
      this.el.appendChild(sec);
    }
  }

  _focusItem(item) {
    const items = this.model.visibleItems();
    const i = items.indexOf(item);
    if (i < 0 || this.model.isEnabled(item) !== true) return;
    this.model.focus = i;
    this._paintFocus();
  }

  /** Re-read every item's visible / enabled / label. Cheap; call it freely. */
  refresh() {
    // Once: every `visible()` is a live predicate reading game state, and
    // calling the list twice can legitimately return two different lists.
    const items = this.model.visibleItems();
    const shown = new Set(items);
    for (const r of this._rows) {
      const on = shown.has(r.item);
      r.btn.hidden = !on;
      if (!on) continue;
      r.labelEl.textContent = this.model.labelOf(r.item);
      const why = this.model.isEnabled(r.item);
      const off = why !== true;
      const hint = off ? String(why) : this.model.hintOf(r.item);
      r.btn.classList.toggle('off', off);
      /* `aria-disabled`, NOT the `disabled` property. Firefox suppresses the
       * native tooltip on a disabled button, and on a disabled item the tooltip
       * IS the feature - it carries the reason ("Mount up first (M)"). The
       * `.off` class does the visual work and every path that could act on the
       * item re-checks `isEnabled`: `_focusItem` refuses it, `move()` skips it,
       * and the click handler returns before activating. */
      r.btn.setAttribute('aria-disabled', off ? 'true' : 'false');
      r.btn.tabIndex = off ? -1 : 0;
      r.hintEl.textContent = hint;
      r.hintEl.hidden = !hint;
      // `title` too: the hint line is truncated on a narrow card.
      if (hint) r.btn.title = hint;
      else r.btn.removeAttribute('title');
    }
    /* A row that just went hidden or disabled must not keep the highlight -
     * Enter on it would do nothing and look broken. */
    const focused = items[this.model.focus];
    if (!focused || this.model.isEnabled(focused) !== true) this.model.focusFirst();
    this._paintFocus();
  }

  _paintFocus() {
    const focused = this.model.focusedItem();
    let activeId = '';
    for (const r of this._rows) {
      const on = r.item === focused;
      r.btn.classList.toggle('focus', on);
      if (!on) continue;
      activeId = r.btn.id;
      /* Real DOM focus too, not just the class. Without it Tab starts from
       * wherever the browser last was - usually the top of the document - so
       * the keyboard highlight and the Tab order disagreed about where the
       * player is. `preventScroll` because the card is short enough to need no
       * scrolling and a jump would be pure noise. */
      r.btn.focus?.({ preventScroll: true });
    }
    if (activeId) this.el.setAttribute('aria-activedescendant', activeId);
    else this.el.removeAttribute('aria-activedescendant');
  }

  move(delta) { this.model.move(delta); this._paintFocus(); }

  focusFirst() { this.model.focusFirst(); this._paintFocus(); }

  /**
   * Put the highlight back on a remembered row - the hub's return path, after
   * the panel it stood aside for closed. Refuses an index the list no longer
   * has or can no longer act on, leaving whatever `refresh` chose.
   * @param {number} i index into `visibleItems()`
   * @returns {boolean} whether the highlight moved
   */
  focusIndex(i) {
    const item = this.model.visibleItems()[i];
    if (!item || this.model.isEnabled(item) !== true) return false;
    this.model.focus = i;
    this._paintFocus();
    return true;
  }

  /** Hand the chosen item to the host, which owns the single call to `run`. */
  activate() {
    const item = this.model.activate();
    if (!item) return;
    this.onActivate?.(item, !!item.keepOpen);
  }

  dispose() {
    this.el.remove();
    this._rows.length = 0;
  }
}
