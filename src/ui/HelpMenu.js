/**
 * F1 control reference.
 *
 * A read-only panel: it lists every binding grouped by category and adds short
 * notes on the systems a new player cannot discover from a keycap alone
 * (portals, credits, the marketplace, swimming, climbing, stamina).
 *
 * Two deliberate decisions:
 *
 * 1. It does not take pointer lock or text capture on its own: the panel is
 *    readable at a glance and exits on the same keys that opened it.
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

/**
 * Every binding, in the order the panel reads them.
 *
 * Exported so a test can assert against the rows themselves rather than
 * against this file's source text. This list is HAND-MAINTAINED - it does not
 * read `BINDABLE` - so a new keybind that lands in the rebinding panel
 * automatically can still be missing from the only page that explains what it
 * is for. `scripts/tests/mount-fittings.test.mjs` holds that shut for the
 * fittings key; the next person to add a control should extend it.
 */
export const GROUPS = [
  {
    title: 'Movement',
    accent: 'cy',
    rows: [
      ['W A S D', 'Walk'],
      ['Shift', 'Sprint — drains stamina'],
      ['C', 'Crouch — hold'],
      ['Space', 'Jump'],
      ['Space', 'Swim up while in water'],
      ['Space', 'Climb a ledge you are facing'],
      ['C', 'Dive while swimming'],
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
      ['C', 'Sprint + tap: dodge roll. In the air: dive. On landing: roll'],
      ['C', 'On the wall: let go'],
      ['—', 'Land in hay to survive any fall'],
    ],
  },
  {
    title: 'Camera',
    accent: 'cy',
    rows: [
      ['V', 'First / third person'],
      ['[  ]', 'Minimap zoom out / in'],
      ['—', 'Diagnostics — in the Esc menu'],
      ['Esc', 'Pause menu'],
    ],
  },
  {
    title: 'Mounts',
    accent: 'mag',
    rows: [
      ['M', 'Mount wheel — hold, aim, release'],
      ['1-6', 'Pick from the wheel directly'],
      ['F', 'Dismount'],
      ['G', 'Fittings — hold, and 1-4 switch them off and on'],
      ['Shift', 'Gallop, sprint the pedals, or beat the eagle’s wings'],
      ['Space', 'Fly up — dragon and eagle; hop on the bicycle'],
      ['C', 'Fly down — dragon and eagle'],
      ['Mouse', 'Steer your mount'],
      ['W S', 'Eagle: pitch trim, trades height for speed'],
      ['W', 'Bicycle: pedal. Let go and it freewheels'],
    ],
  },
  /* ── SHIP ───────────────────────────────────────────────────────────────
   * Added because it was entirely absent. F1 is the canonical list, and it
   * taught none of boarding, throttle, boost, airbrake, roll, vertical
   * thrust, landing or mining - so every verb of the space campaign was
   * reachable and untaught, which is this project's signature defect wearing
   * a keycap. The bindings here are the ones `Flight._readInput` and
   * `Piloting` actually read, not a wish list: W/S throttle, Space/C vertical,
   * Shift boost, X airbrake (a HOLD), A/D roll, F board and leave.
   *
   * CTRL APPEARS NOWHERE, in this section or any other. `Input.onKey` drops
   * every event with `ctrlKey` set, so a Ctrl row on this panel is a control
   * that provably cannot fire. Three of them shipped on the title card. */
  {
    title: 'Ship',
    accent: 'cy',
    rows: [
      ['F', 'Board the ship you are standing at, or leave the seat'],
      ['W', 'Throttle up'],
      ['S', 'Reverse thrust'],
      ['Shift', 'Boost — burns boost fuel, refills when you let go'],
      ['Z', 'Transit drive — press to spin up, press again to drop out'],
      ['X', 'Airbrake — hold, kills speed fast'],
      ['A D', 'Roll'],
      ['Space', 'Thrust up'],
      ['C', 'Thrust down'],
      ['Mouse', 'Pitch and yaw'],
      ['LMB', 'Fire the guns'],
      ['E', 'Hold at a seam to cut ore'],
      ['—', 'Fly within 230 m of the yard to dock; the hold is sold on arrival'],
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
      ['J', 'Quest board — from anywhere'],
      ['N', 'Records — charters, standings, leaderboards'],
      ['Esc', 'Pause menu (everything below is in it)'],
      ['F1', 'This panel'],
      ['Esc', 'Close this panel'],
    ],
  },
];

/** Short explanations for the things a keycap cannot teach. */
const NOTES = [
  ['Portals', 'Each world holds a gateway to the others. Walk into the ring and press E. The destination keeps building while the transition holds — the spinner means it is working, not stuck.'],
  ['Credits', 'Earned from kills and loot, spent in the marketplace. The counter sits top-left; every award floats up from it.'],
  ['Marketplace', 'Stand near a vendor and press B to buy ammo packs or sell trinkets back. Your bag starts at 30 slots — a stack of 60 bullets is one slot, not sixty — and expansion rigs bought from a merchant grow it as far as 60.'],
  ['Swimming', 'Enter any lake, moat or pool and you switch to a swim stroke. Space rises, C dives. Stamina drains slowly; at zero you sink and start drowning.'],
  ['Climbing', 'Face a ledge above jump height and press Space to mantle up. Costs stamina, and only works when there is room to stand on top.'],
  ['Stamina', 'The bar under your health. Sprinting, swimming and climbing spend it; it refills after a short pause. Sprint is gated on it.'],
  /* The one ship verb a keycap genuinely cannot teach: the drive refuses in
   * two situations that are invisible from the cockpit (a gravity well and a
   * hostile lock) and governs itself by altitude, which nothing on screen
   * explains. It says why every time it refuses, but a player who never gets
   * it to light once will never see that sentence. */
  ['Transit drive', 'Z spins up the ship’s interplanetary drive: a couple of seconds of spool, then thousands of metres a second. Its top speed is set by how high you are above the nearest world, so it slows you down on its own as you close and you cannot arrive too fast. It will not spin up close to a planet, inside the yard, or while something has a lock on you — and taking a hit drops you back into normal space.'],
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
        /* This Escape is spent closing Help and nothing else.
         *
         * We register before the HUD does (main.js:227 vs :421), so its pause
         * handlers would otherwise run later in this same event - and by then
         * `close()` has already emitted `help:close`, clearing the `_helpOpen`
         * flag they guard on. The result was one keypress that closed Help AND
         * either resumed the game or dropped pointer lock. */
        e.preventDefault();
        e.stopImmediatePropagation();
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
