import './mountwheel.css';

/**
 * The mount selector radial.
 *
 * ── Why this replaced five keybinds ───────────────────────────────────────
 *
 * Every mount used to own a letter: H hoverboard, G dragon, J car, X horse,
 * and the eagle wandered from C to Z after C turned out to be crouch. That is
 * five keys spent on one concept, five lines in both control references, and a
 * fresh collision every time a mount is added - the eagle's move was exactly
 * that. It also gave the player nothing to look at: the roster only existed in
 * the help panel, so an unlocked mount was invisible until someone read F1.
 *
 * One key opens a radial instead. Adding a sixth mount now costs a row in a
 * table and no keyboard real estate at all, and the whole roster - including
 * what is still locked - is visible the moment it opens.
 *
 * ── Selecting under pointer lock ──────────────────────────────────────────
 *
 * There is no cursor to point with: the game holds pointer lock, so the mouse
 * reports deltas rather than a position. The wheel therefore integrates raw
 * `movementX/Y` into a direction vector of its own and lights whichever sector
 * that vector falls in. Past a small dead zone the choice is committed on
 * release, which makes a flick-and-let-go as quick as the old single keypress
 * once the direction is learned - and unlike the keypress, it can be aimed
 * without being memorised.
 *
 * The number keys work too, for anyone who would rather not aim at all.
 */

const SVG_NS = 'http://www.w3.org/2000/svg';

/**
 * The roster, in ring order starting at twelve o'clock and going clockwise.
 *
 * Order is deliberate rather than alphabetical: the two flying mounts sit
 * opposite each other, and the ground vehicles fill the lower half, so the
 * directions stay learnable as a shape rather than as a list.
 */
const MOUNTS = [
  { id: 'dragon', label: 'Dragon', hint: 'Flies. Breathes fire.' },
  { id: 'eagle', label: 'Eagle', hint: 'Glides. Trades height for speed.' },
  { id: 'car', label: 'Ground Car', hint: 'Fast over open ground.' },
  { id: 'horse', label: 'Horse', hint: 'Sure-footed. Jumps.' },
  { id: 'hoverboard', label: 'Hoverboard', hint: 'Nimble. Boosts.' },
];

/** Inline SVG, authored in a 64x64 box, one path set per mount. */
const ICONS = {
  dragon: ['M10 42c8-14 20-20 22-30 2 10 14 16 22 30-8-2-14 2-22 8-8-6-14-10-22-8z',
    'M32 12c-2 6-2 12 0 18 2-6 2-12 0-18z'],
  eagle: ['M6 34c10-10 18-12 26-12s16 2 26 12c-10-4-18-4-26 0-8-4-16-4-26 0z',
    'M32 22v22M28 44h8'],
  car: ['M10 38h44v10H10z', 'M16 38l6-12h20l6 12', 'M20 48a4 4 0 108 0 4 4 0 10-8 0z',
    'M36 48a4 4 0 108 0 4 4 0 10-8 0z'],
  horse: ['M18 50V34c0-8 6-14 14-14h6l6-8v12c0 8-4 12-10 14v12',
    'M24 50V38', 'M40 50V40'],
  hoverboard: ['M12 36h40l-4 8H16z', 'M18 48h28', 'M22 26h20l-4 10H26z'],
};

function el(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
}

export class MountWheel {
  /**
   * @param {{root:HTMLElement, bus:any, input:any, mounts:any}} ctx
   */
  constructor({ root, bus, input, mounts }) {
    this.bus = bus ?? null;
    this.input = input ?? null;
    this.mounts = mounts ?? null;

    this._open = false;
    this._sel = -1;
    /** Integrated pointer delta while open. Reset every time it opens. */
    this._vx = 0;
    this._vy = 0;

    this.el = this._build();
    root.appendChild(this.el);

    /* Capture phase, like every other panel here: `Input` stops reporting while
     * a text field owns the keyboard, and a selector that cannot be closed is
     * worse than one that cannot be opened. */
    this._onKey = (e) => this._key(e);
    this._onMove = (e) => this._move(e);
    window.addEventListener('keydown', this._onKey, true);
    window.addEventListener('keyup', this._onKey, true);
    window.addEventListener('mousemove', this._onMove);
  }

  get isOpen() {
    return this._open;
  }

  _build() {
    const wrap = el('div', 'mw');
    const ring = el('div', 'mw-ring');

    this._slots = [];
    for (let i = 0; i < MOUNTS.length; i++) {
      const m = MOUNTS[i];
      const a = (i / MOUNTS.length) * Math.PI * 2 - Math.PI / 2;
      const slot = el('div', 'mw-slot');
      slot.style.left = `${50 + Math.cos(a) * 34}%`;
      slot.style.top = `${50 + Math.sin(a) * 34}%`;

      const svg = document.createElementNS(SVG_NS, 'svg');
      svg.setAttribute('viewBox', '0 0 64 64');
      svg.setAttribute('class', 'mw-icon');
      for (const d of ICONS[m.id] ?? []) {
        const p = document.createElementNS(SVG_NS, 'path');
        p.setAttribute('d', d);
        svg.appendChild(p);
      }
      slot.append(svg, el('div', 'mw-label', m.label), el('div', 'mw-num', String(i + 1)));
      // Clicking works whenever the pointer happens to be free, which is the
      // only time a click can reach the DOM at all.
      slot.addEventListener('mousedown', (e) => { e.preventDefault(); this._commit(i); });
      ring.appendChild(slot);
      this._slots.push(slot);
    }

    this._hint = el('div', 'mw-hint', 'Aim and release');
    ring.append(el('div', 'mw-hub', 'MOUNTS'), this._hint);
    wrap.appendChild(ring);
    return wrap;
  }

  /* ================================================================== */
  /* Input                                                              */
  /* ================================================================== */

  _key(e) {
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    if (e.code !== 'KeyM') {
      if (!this._open || e.type !== 'keydown') return;
      if (e.code === 'Escape') { e.preventDefault(); this.close(); return; }
      // Digits pick directly, for anyone who would rather not aim.
      const n = { Digit1: 0, Digit2: 1, Digit3: 2, Digit4: 3, Digit5: 4 }[e.code];
      if (n !== undefined && n < MOUNTS.length) {
        e.preventDefault();
        this._commit(n);
      }
      return;
    }
    if (this.input?.textCaptured) return;
    e.preventDefault();
    if (e.type === 'keydown') {
      if (!this._open) this.open();
    } else {
      /* Release commits. A tap with no aim leaves the wheel up instead of
       * closing it, so the key works as a toggle for anyone who wants to read
       * the roster rather than flick through it. */
      if (this._sel >= 0) this._commit(this._sel);
      else if (this._moved) this.close();
    }
  }

  _move(e) {
    if (!this._open) return;
    this._vx += e.movementX ?? 0;
    this._vy += e.movementY ?? 0;
    const len = Math.hypot(this._vx, this._vy);
    // Dead zone, so a hand that has not moved does not pick the sector the
    // mouse drifted a pixel towards.
    if (len < 26) { this._select(-1); return; }
    this._moved = true;
    // Clamped, or a long sweep leaves the vector so large that coming back
    // takes as long as it went out.
    if (len > 220) { this._vx *= 220 / len; this._vy *= 220 / len; }
    // Screen angle -> ring index. -PI/2 is twelve o'clock, matching the layout.
    let a = Math.atan2(this._vy, this._vx) + Math.PI / 2;
    if (a < 0) a += Math.PI * 2;
    this._select(Math.round((a / (Math.PI * 2)) * MOUNTS.length) % MOUNTS.length);
  }

  _select(i) {
    if (i === this._sel) return;
    this._sel = i;
    for (let k = 0; k < this._slots.length; k++) {
      this._slots[k].classList.toggle('sel', k === i);
    }
    const m = MOUNTS[i];
    const active = this.mounts?.active?.id ?? null;
    this._hint.textContent = !m
      ? 'Aim and release'
      : m.id === active ? `Release to dismiss ${m.label}` : m.hint;
  }

  _commit(i) {
    const m = MOUNTS[i];
    this.close();
    if (!m || !this.mounts) return;
    // `summon` already dismisses when asked for the mount being ridden, so
    // selecting the active one is the way to put it away.
    this.mounts.summon(m.id);
  }

  /* ================================================================== */
  /* Open / close                                                       */
  /* ================================================================== */

  open() {
    if (this._open) return;
    this._open = true;
    this._vx = 0;
    this._vy = 0;
    this._moved = false;
    this._sel = -1;

    const unlocked = new Set(this.mounts?.unlocked ?? []);
    const active = this.mounts?.active?.id ?? null;
    for (let i = 0; i < MOUNTS.length; i++) {
      const m = MOUNTS[i];
      // A locked mount is shown, not hidden: knowing one exists is most of the
      // reason to go and unlock it.
      this._slots[i].classList.toggle('locked', unlocked.size > 0 && !unlocked.has(m.id));
      this._slots[i].classList.toggle('active', m.id === active);
      this._slots[i].classList.remove('sel');
    }
    this._select(-1);
    this.el.classList.add('show');
    this.bus?.emit('mountwheel:open', {});
  }

  close() {
    if (!this._open) return;
    this._open = false;
    this._sel = -1;
    this.el.classList.remove('show');
    this.bus?.emit('mountwheel:close', {});
  }

  /** Present for symmetry with the other UI modules; the wheel is event-driven. */
  update() {}

  dispose() {
    window.removeEventListener('keydown', this._onKey, true);
    window.removeEventListener('keyup', this._onKey, true);
    window.removeEventListener('mousemove', this._onMove);
    this.el.remove();
  }
}

export default MountWheel;
