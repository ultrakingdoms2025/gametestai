import './keybind.css';

/**
 * F6 — key rebinding.
 *
 * ## What it can and cannot rebind
 *
 * Everything gameplay reads through `Input` — movement, jump, sprint, crouch,
 * interact, reload, dismount, camera, chat, minimap zoom. `Input` resolves each
 * of those through a redirection table, so rebinding one changes every call
 * site at once without any of them knowing (see BINDABLE in core/Input.js).
 *
 * It deliberately does **not** offer the panel keys — F1 help, F2 character,
 * F3 diagnostics, F4 audio, F5 save, F9 load, Escape. Those panels own their
 * own listeners so they still work when `Input` has stopped reporting, which is
 * exactly the situation where a player needs to be able to close one. Letting
 * them be rebound would put the escape hatches behind the same failure they
 * exist to escape from.
 *
 * ## Capturing a key
 *
 * Clicking a row arms it, and the *next* keydown is taken literally — modifiers
 * included, `preventDefault` on, capture phase, so binding to a key the browser
 * wants does not also trigger the browser. Escape cancels rather than binding,
 * because a player who has armed the wrong row needs a way out that cannot
 * itself be captured.
 */

const CAPTURE_HINT = 'Press any key…  (Esc to cancel)';

/**
 * Keys with dedicated handlers that are shown for reference but cannot be
 * rebound: each of these panels owns its own listener (see the note in the
 * footer for why), so the menu documents them rather than hiding them.
 */
const FIXED_KEYS = [
  { key: 'I', label: 'Inventory & bag' },
  { key: 'B', label: 'Marketplace (near a vendor)' },
  { key: 'K', label: 'Unstuck — teleport to safety' },
  { key: '1–4', label: 'Weapon slots' },
  { key: 'Wheel', label: 'Cycle weapons' },
  { key: 'F1', label: 'Help & controls' },
  { key: 'F2', label: 'Customise character' },
  { key: 'F3', label: 'Diagnostics overlay' },
  { key: 'F4', label: 'Audio options' },
  { key: 'F5', label: 'Save' },
  { key: 'F6', label: 'This panel' },
  { key: 'F7', label: 'Race panel — in the circuit' },
  { key: 'F9', label: 'Report a bug' },
  { key: 'Shift+F9', label: 'Load a save' },
  { key: 'Esc', label: 'Close panels / release mouse' },
];

/** Human-readable key names. `event.code` is unreadable on its own. */
function keyName(code) {
  if (!code) return '—';
  const map = {
    Space: 'Space', ShiftLeft: 'L Shift', ShiftRight: 'R Shift',
    ControlLeft: 'L Ctrl', ControlRight: 'R Ctrl',
    AltLeft: 'L Alt', AltRight: 'R Alt',
    BracketLeft: '[', BracketRight: ']', Backquote: '`',
    Minus: '-', Equal: '=', Semicolon: ';', Quote: "'",
    Comma: ',', Period: '.', Slash: '/', Backslash: '\\',
    ArrowUp: '↑', ArrowDown: '↓', ArrowLeft: '←', ArrowRight: '→',
    Enter: 'Enter', Backspace: 'Backspace', CapsLock: 'Caps',
  };
  if (map[code]) return map[code];
  if (code.startsWith('Key')) return code.slice(3);
  if (code.startsWith('Digit')) return code.slice(5);
  if (code.startsWith('Numpad')) return `Num ${code.slice(6)}`;
  return code;
}

function el(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
}

export class KeybindMenu {
  /** @param {{root:HTMLElement, bus?:any, input:any}} ctx */
  constructor({ root, bus, input }) {
    this.bus = bus ?? null;
    this.input = input;
    this._open = false;
    /** The row waiting for a key, or null. */
    this._arming = null;
    /** @type {Map<string, HTMLElement>} shipped code -> key cap element */
    this._caps = new Map();

    this.el = this._build();
    root.appendChild(this.el);

    this._onKey = (e) => this._key(e);
    window.addEventListener('keydown', this._onKey, true);

    this._offs = [];
    if (bus) {
      this._offs.push(bus.on('input:binds-changed', () => this._sync()));
    }
    this._sync();
  }

  get isOpen() {
    return this._open;
  }

  _build() {
    const wrap = el('div', 'kb');
    const card = el('div', 'kb-card');

    const head = el('div', 'kb-head');
    const titles = el('div', 'kb-titles');
    titles.append(el('div', 'kb-kicker', 'Controls'), el('div', 'kb-title', 'KEY BINDINGS'));
    const close = el('div', 'kb-close');
    close.append(el('b', null, 'F6'), el('span', null, 'or'), el('b', null, 'Esc'), el('span', null, 'to close'));
    head.append(titles, close);

    const body = el('div', 'kb-body');
    const groups = new Map();
    for (const d of this.input.bindings) {
      if (!groups.has(d.group)) {
        const sec = el('section', 'kb-group');
        sec.appendChild(el('h3', 'kb-group-t', d.group));
        groups.set(d.group, sec);
        body.appendChild(sec);
      }
      const row = el('div', 'kb-row');
      row.append(el('div', 'kb-label', d.label));
      const cap = el('button', 'kb-cap', keyName(d.bound));
      cap.addEventListener('click', () => this._arm(d.code, cap));
      row.appendChild(cap);
      this._caps.set(d.code, cap);
      groups.get(d.group).appendChild(row);
    }

    // Fixed keys: shown so F6 documents the whole keyboard, but not clickable
    // because their owners listen for the literal key (see the footer note).
    const fixedSec = el('section', 'kb-group');
    fixedSec.appendChild(el('h3', 'kb-group-t', 'Fixed keys'));
    for (const f of FIXED_KEYS) {
      const row = el('div', 'kb-row');
      row.append(el('div', 'kb-label', f.label));
      const cap = el('button', 'kb-cap', f.key);
      cap.disabled = true;
      cap.style.opacity = '0.65';
      cap.style.cursor = 'default';
      row.appendChild(cap);
      fixedSec.appendChild(row);
    }
    body.appendChild(fixedSec);

    const foot = el('div', 'kb-foot');
    const reset = el('button', 'kb-btn ghost', 'Reset all to defaults');
    reset.addEventListener('click', () => {
      this._cancelArm();
      this.input.resetBindings();
      this._note('Bindings reset');
    });
    this._msg = el('div', 'kb-msg', '');
    foot.append(reset, this._msg);

    const note = el('div', 'kb-note',
      'Fixed keys (I, B, M, K, F1–F9 and Esc) cannot be rebound: those panels listen for '
      + 'themselves so they still open when everything else is disabled, which is exactly '
      + 'when you need them.');

    card.append(head, body, foot, note);
    wrap.appendChild(card);
    return wrap;
  }

  /* ================================================================== */
  /* Capture                                                            */
  /* ================================================================== */

  _arm(defaultCode, cap) {
    this._cancelArm();
    this._arming = defaultCode;
    cap.classList.add('arming');
    cap.textContent = CAPTURE_HINT;
    this._note('');
  }

  _cancelArm() {
    if (!this._arming) return;
    const cap = this._caps.get(this._arming);
    if (cap) cap.classList.remove('arming');
    this._arming = null;
    this._sync();
  }

  _key(e) {
    // Capturing a key takes priority over everything, including closing.
    if (this._open && this._arming) {
      e.preventDefault();
      e.stopPropagation();
      if (e.code === 'Escape') { this._cancelArm(); return; }
      const target = this._arming;
      const res = this.input.setBinding(target, e.code);
      this._arming = null;
      if (!res.ok) this._note(`${keyName(e.code)} cannot be rebound`);
      else if (res.displaced) this._note(`${keyName(e.code)} taken from "${res.displaced}", which is back on its default`);
      else this._note('Bound');
      this._sync();
      return;
    }
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    if (e.code === 'F6') {
      e.preventDefault();
      e.stopPropagation();
      if (this.input?.textCaptured) return;
      this.toggle();
    } else if (e.code === 'Escape' && this._open) {
      e.preventDefault();
      e.stopPropagation();
      this.close();
    }
  }

  _note(text) {
    if (this._msg) this._msg.textContent = text;
  }

  _sync() {
    for (const d of this.input.bindings) {
      const cap = this._caps.get(d.code);
      if (!cap || this._arming === d.code) continue;
      cap.textContent = keyName(d.bound);
      cap.classList.toggle('changed', d.bound !== d.code);
      cap.classList.remove('arming');
    }
  }

  /* ================================================================== */
  /* Open / close                                                       */
  /* ================================================================== */

  open() {
    if (this._open) return;
    this._open = true;
    this._sync();
    this._note('');
    this.el.classList.add('show');
    this.input?.exitLock?.();
    this.bus?.emit?.('keybinds:open', {});
    requestAnimationFrame(() => {
      const first = this.el.querySelector('button');
      first?.focus?.();
    });
  }

  close() {
    if (!this._open) return;
    this._cancelArm();
    this._open = false;
    this.el.classList.remove('show');
    this.bus?.emit?.('keybinds:close', {});
    setTimeout(() => this.input?.requestLock?.(), 0);
  }

  toggle() {
    if (this._open) this.close();
    else this.open();
  }

  /** Present for symmetry with the other UI modules; the panel is event-driven. */
  update() {}

  dispose() {
    window.removeEventListener('keydown', this._onKey, true);
    for (const off of this._offs) off?.();
    this.el.remove();
  }
}

export default KeybindMenu;
