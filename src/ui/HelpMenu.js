/**
 * F1 control reference.
 *
 * A read-only panel: it lists every binding grouped by category and adds short
 * notes on the systems a new player cannot discover from a keycap alone
 * (portals, credits, the marketplace, swimming, climbing, stamina).
 *
 * Two deliberate decisions:
 *
 * 1. It does **not** pause. CONTRACTS-V3 §3.6 asks for a reference, not a menu,
 *    and pausing on F1 would let a player freeze a firefight to read it.
 * 2. It owns its own `keydown` listener rather than polling `input.pressed()`.
 *    `Input` stops reporting while text capture is on and while a portal
 *    transition has disabled it, and "the help menu will not close" is exactly
 *    the sort of dead end this panel exists to prevent. The listener is on the
 *    capture phase so `F1` never reaches the browser's own help shortcut.
 *
 * All markup is built once in the constructor and only ever toggled by class,
 * so opening it costs a class write and nothing else — no layout thrash on a
 * key the player may spam.
 */

/** Every binding, in the order the panel reads them. */
const GROUPS = [
  {
    title: 'Movement',
    accent: 'cy',
    rows: [
      ['W A S D', 'Walk'],
      ['Shift', 'Sprint — drains stamina'],
      ['Ctrl / C', 'Crouch'],
      ['Space', 'Jump'],
      ['Space', 'Swim up while in water'],
      ['Space', 'Climb a ledge you are facing'],
      ['Ctrl', 'Dive while swimming'],
      ['K', 'Unstuck — teleports you clear'],
    ],
  },
  {
    title: 'Combat',
    accent: 'amber',
    rows: [
      ['LMB', 'Fire / hold to charge'],
      ['RMB', 'Aim down sight'],
      ['R', 'Reload from the bag'],
      ['1', 'Machine gun'],
      ['2', 'Ember caster — fireball'],
      ['3', 'Recurve bow'],
      ['4', 'Sword — melee, no ammo'],
      ['Wheel', 'Cycle weapons'],
    ],
  },
  {
    title: 'Parkour',
    accent: 'lime',
    rows: [
      ['Space', 'Hold at a wall to climb it'],
      ['Shift Space', 'Running leap — clears wide gaps'],
      ['Ctrl', 'In the air: dive. On landing: roll'],
      ['Ctrl', 'On the wall: let go'],
      ['—', 'Land in hay to survive any fall'],
    ],
  },
  {
    title: 'Camera',
    accent: 'cy',
    rows: [
      ['V', 'First / third person'],
      ['[  ]', 'Minimap zoom out / in'],
      ['F3', 'Diagnostics overlay'],
      ['Esc', 'Release the mouse cursor'],
    ],
  },
  {
    title: 'Mounts',
    accent: 'mag',
    rows: [
      ['H', 'Summon / dismiss hoverboard'],
      ['G', 'Summon / dismiss dragon'],
      ['J', 'Summon / dismiss car'],
      ['X', 'Summon / dismiss horse'],
      ['C', 'Summon / dismiss eagle'],
      ['F', 'Dismount'],
      ['Shift', 'Gallop, or beat the eagle’s wings'],
      ['Space', 'Fly up — dragon and eagle'],
      ['Ctrl', 'Fly down — dragon and eagle'],
      ['Mouse', 'Steer your mount'],
      ['W S', 'Eagle: pitch trim, trades height for speed'],
    ],
  },
  {
    title: 'Inventory & trade',
    accent: 'lime',
    rows: [
      ['I', 'Inventory and 30-slot bag'],
      ['B', 'Marketplace — near a vendor'],
      ['E', 'Pick up loot'],
      ['E', 'Talk to a friendly'],
      ['E', 'Enter a portal'],
    ],
  },
  {
    title: 'System',
    accent: 'amber',
    rows: [
      ['T', 'Open comms / chat'],
      ['F1', 'This panel'],
      ['F2', 'Customise your character'],
      ['F4', 'Audio options'],
      ['F5', 'Save'],
      ['F9', 'Load'],
      ['Shift F5', 'Export save to a file'],
      ['Shift F9', 'Import a save file'],
      ['Esc', 'Close this panel'],
    ],
  },
];

/** Short explanations for the things a keycap cannot teach. */
const NOTES = [
  ['Portals', 'Each world holds a gateway to the others. Walk into the ring and press E. The destination keeps building while the transition holds — the spinner means it is working, not stuck.'],
  ['Credits', 'Earned from kills and loot, spent in the marketplace. The counter sits top-left; every award floats up from it.'],
  ['Marketplace', 'Stand near a vendor and press B to buy ammo packs or sell trinkets back. Your bag holds 30 slots — a stack of 60 bullets is one slot, not sixty.'],
  ['Swimming', 'Enter any lake, moat or pool and you switch to a swim stroke. Space rises, Ctrl dives. Stamina drains slowly; at zero you sink and start drowning.'],
  ['Climbing', 'Face a ledge above jump height and press Space to mantle up. Costs stamina, and only works when there is room to stand on top.'],
  ['Stamina', 'The bar under your health. Sprinting, swimming and climbing spend it; it refills after a short pause. Sprint is gated on it.'],
];

function el(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
}

export class HelpMenu {
  /**
   * @param {{ root:HTMLElement, bus:any, input?:any }} ctx
   */
  constructor({ root, bus, input }) {
    this.bus = bus;
    this.input = input ?? null;
    this._open = false;

    this.el = this._build();
    root.appendChild(this.el);

    // Capture phase: F1 is a browser help shortcut in some builds, and Escape
    // is consumed by pointer lock. Getting there first is the only way to be
    // sure both keys reach us.
    this._onKey = (e) => {
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      if (e.code === 'F1') {
        e.preventDefault();
        // While the chat box owns the keyboard, F1 is a character, not a key.
        if (this.input?.textCaptured) return;
        this.toggle();
      } else if (e.code === 'Escape' && this._open) {
        this.close();
      }
    };
    window.addEventListener('keydown', this._onKey, true);
  }

  /** True while the panel is on screen. */
  get isOpen() {
    return this._open;
  }

  _build() {
    const wrap = el('div', 'help');

    const card = el('div', 'help-card');

    const head = el('div', 'help-head');
    const titles = el('div', 'help-titles');
    titles.append(el('div', 'help-kicker', 'Operator Reference'), el('div', 'help-title', 'CONTROLS'));
    const close = el('div', 'help-close');
    close.append(el('b', null, 'F1'), el('span', null, 'or'), el('b', null, 'Esc'), el('span', null, 'to close'));
    head.append(titles, close);

    const grid = el('div', 'help-grid');
    for (const g of GROUPS) {
      const col = el('section', `help-group a-${g.accent}`);
      col.appendChild(el('h3', 'help-group-t', g.title));
      const list = el('dl', 'help-rows');
      for (const [key, what] of g.rows) {
        const dt = el('dt');
        // Split on runs of whitespace so "W A S D" renders as four keycaps.
        for (const k of String(key).trim().split(/\s+/)) dt.appendChild(el('b', null, k));
        list.append(dt, el('dd', null, what));
      }
      col.appendChild(list);
      grid.appendChild(col);
    }

    const notes = el('div', 'help-notes');
    notes.appendChild(el('h3', 'help-group-t', 'Field notes'));
    const nrow = el('div', 'help-notes-row');
    for (const [t, body] of NOTES) {
      const n = el('div', 'help-note');
      n.append(el('b', null, t), el('p', null, body));
      nrow.appendChild(n);
    }
    notes.appendChild(nrow);

    const foot = el(
      'div',
      'help-foot',
      'Characters and worlds are generated in code — no downloaded assets. If a world takes a moment to appear, it is being built.'
    );

    card.append(head, grid, notes, foot);
    wrap.appendChild(card);
    return wrap;
  }

  open() {
    if (this._open) return;
    this._open = true;
    this.el.classList.add('show');
    this.bus?.emit?.('help:open', {});
  }

  close() {
    if (!this._open) return;
    this._open = false;
    this.el.classList.remove('show');
    this.bus?.emit?.('help:close', {});
  }

  toggle() {
    if (this._open) this.close();
    else this.open();
  }

  /** Present for symmetry with the other UI modules; the panel is event-driven. */
  update() {}

  dispose() {
    window.removeEventListener('keydown', this._onKey, true);
    this.el.remove();
  }
}
