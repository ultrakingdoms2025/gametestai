import './mountwheel.css';
import { allows } from '../worlds/WorldRules.js';

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
  { id: 'bicycle', label: 'Bicycle', hint: 'Quiet. Turns tightly. You pedal.' },
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
  // Two wheels, the diamond frame between them, and the bars. Drawn as the
  // silhouette rather than as a side elevation with spokes: at 64 px a spoked
  // wheel is a grey disc, and the frame triangle is what reads as "bicycle".
  bicycle: ['M16 44a8 8 0 1016 0 8 8 0 10-16 0z', 'M32 44a8 8 0 1016 0 8 8 0 10-16 0z',
    'M24 44l8-16h10l-6 16', 'M32 28h-8', 'M42 28l-4-8h-6', 'M38 20h6'],
};

function el(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
}

function svg(tag, attrs) {
  const n = document.createElementNS(SVG_NS, tag);
  for (const k in attrs) n.setAttribute(k, attrs[k]);
  return n;
}

/* The dial is authored in a 400x400 box and scaled by CSS, so every radius here
 * is in those units rather than pixels. */
const VB = 400;
const CX = VB / 2;
const RING_IN = 92;
const RING_OUT = 178;
/** Where the icon and name sit — between the two radii, not on top of either. */
const LABEL_R = 135;
/** Degrees trimmed off each side of a wedge, so the seams read as cuts. */
const SECTOR_GAP_DEG = 2.4;

/**
 * One wedge of the dial as an SVG path.
 *
 * Drawn outer-arc → in → inner-arc-back → close, which is the only winding that
 * leaves a true annular sector rather than a pie slice with a bite out of it.
 */
function sectorPath(a0, a1, rIn = RING_IN, rOut = RING_OUT) {
  const at = (r, a) => `${(CX + Math.cos(a) * r).toFixed(2)} ${(CX + Math.sin(a) * r).toFixed(2)}`;
  const large = a1 - a0 > Math.PI ? 1 : 0;
  return `M${at(rOut, a0)} A${rOut} ${rOut} 0 ${large} 1 ${at(rOut, a1)}`
    + ` L${at(rIn, a1)} A${rIn} ${rIn} 0 ${large} 0 ${at(rIn, a0)} Z`;
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

    /* ---- the dial ---------------------------------------------------------
     * The wedge *is* the button. The previous build floated five rounded cards
     * in a circle, which reads as a menu that happens to be arranged in a ring
     * rather than as a radial - and rounded corners are a shape the rest of
     * this HUD never uses, so it looked borrowed from another game. */
    const dial = svg('svg', { viewBox: `0 0 ${VB} ${VB}`, class: 'mw-dial' });

    dial.appendChild(svg('circle', { class: 'mw-rim mw-rim-o', cx: CX, cy: CX, r: RING_OUT + 9 }));
    dial.appendChild(svg('circle', { class: 'mw-rim mw-rim-i', cx: CX, cy: CX, r: RING_IN - 8 }));

    const step = (Math.PI * 2) / MOUNTS.length;
    const gap = (SECTOR_GAP_DEG * Math.PI) / 180;

    // Boundary ticks, bridging the two rims at every seam.
    const ticks = svg('g', { class: 'mw-ticks' });
    for (let i = 0; i < MOUNTS.length; i++) {
      const a = (i + 0.5) * step - Math.PI / 2;
      ticks.appendChild(svg('line', {
        x1: CX + Math.cos(a) * (RING_IN - 8), y1: CX + Math.sin(a) * (RING_IN - 8),
        x2: CX + Math.cos(a) * (RING_OUT + 9), y2: CX + Math.sin(a) * (RING_OUT + 9),
      }));
    }
    dial.appendChild(ticks);

    this._sectors = [];
    const secs = svg('g', { class: 'mw-secs' });
    for (let i = 0; i < MOUNTS.length; i++) {
      const ac = i * step - Math.PI / 2;
      const p = svg('path', { class: 'mw-sec', d: sectorPath(ac - step / 2 + gap, ac + step / 2 - gap) });
      // Clicking works whenever the pointer happens to be free, which is the
      // only time a click can reach the DOM at all.
      p.addEventListener('mousedown', (e) => { e.preventDefault(); this._commit(i); });
      secs.appendChild(p);
      this._sectors.push(p);
    }
    dial.appendChild(secs);

    /* The aim needle. Under pointer lock there is no cursor, so without this
     * the only feedback for "where am I pointing" is which wedge happens to be
     * lit - which says nothing about how close the vector is to the next seam. */
    this._needle = svg('g', { class: 'mw-needle' });
    /* Starts outside the hub, not at the centre. The hub is a text block about
     * 80 units across, so a needle rooted at the middle spends its first third
     * drawn over the name it is there to confirm. */
    this._needleTail = CX - (RING_IN - 6);
    this._needleHead = CX - (RING_OUT - 4);
    this._needleLine = svg('line', { x1: CX, y1: this._needleTail, x2: CX, y2: this._needleHead });
    this._needleTip = svg('circle', { cx: CX, cy: this._needleHead - 6, r: 4.5 });
    this._needle.append(this._needleLine, this._needleTip);
    dial.appendChild(this._needle);
    ring.appendChild(dial);

    /* ---- labels over the wedges ------------------------------------------ */
    this._slots = [];
    for (let i = 0; i < MOUNTS.length; i++) {
      const m = MOUNTS[i];
      const a = i * step - Math.PI / 2;
      const slot = el('div', 'mw-slot');
      slot.style.left = `${50 + (Math.cos(a) * LABEL_R * 100) / VB}%`;
      slot.style.top = `${50 + (Math.sin(a) * LABEL_R * 100) / VB}%`;

      const ico = svg('svg', { viewBox: '0 0 64 64', class: 'mw-icon' });
      for (const d of ICONS[m.id] ?? []) ico.appendChild(svg('path', { d }));
      slot.append(ico, el('div', 'mw-label', m.label), el('div', 'mw-num', String(i + 1)));
      ring.appendChild(slot);
      this._slots.push(slot);
    }

    /* ---- hub readout ------------------------------------------------------
     * The centre of a radial is where the choice is confirmed, so the name of
     * what is aimed at belongs here rather than only out on the rim where the
     * eye is not looking while it aims. */
    const hub = el('div', 'mw-hub');
    this._hubName = el('div', 'mw-hub-n', 'MOUNTS');
    this._hint = el('div', 'mw-hub-h', 'Aim and release');
    hub.append(el('div', 'mw-hub-k', 'Summon'), this._hubName, this._hint);
    ring.appendChild(hub);

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
      const n = { Digit1: 0, Digit2: 1, Digit3: 2, Digit4: 3, Digit5: 4, Digit6: 5 }[e.code];
      if (n !== undefined && n < MOUNTS.length) {
        e.preventDefault();
        this._commit(n);
      }
      return;
    }
    if (this.input?.textCaptured) return;
    e.preventDefault();
    if (e.type === 'keydown') {
      // Auto-repeat while the key is held is not a fresh press - ignoring it is
      // what lets the hold-to-aim gesture coexist with the tap-to-toggle one.
      if (e.repeat) return;
      // A tap while open shuts the wheel: pressing M is a true toggle now, so a
      // roster left up by an earlier tap closes on the next M rather than only
      // on Esc or a click.
      if (this._open) this.close();
      else this.open();
    } else {
      /* Release commits an aimed selection. A tap with no aim leaves the wheel
       * up; the next M press (handled above) closes it, so M toggles. */
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
    if (len < 26) { this._select(-1); this._aim(0, 0); return; }
    this._moved = true;
    // Clamped, or a long sweep leaves the vector so large that coming back
    // takes as long as it went out.
    if (len > 220) { this._vx *= 220 / len; this._vy *= 220 / len; }
    // Screen angle -> ring index. -PI/2 is twelve o'clock, matching the layout.
    let a = Math.atan2(this._vy, this._vx) + Math.PI / 2;
    if (a < 0) a += Math.PI * 2;
    this._aim(a, (Math.min(len, 220) - 26) / (120 - 26));
    this._select(Math.round((a / (Math.PI * 2)) * MOUNTS.length) % MOUNTS.length);
  }

  _select(i) {
    if (i === this._sel) return;
    this._sel = i;
    for (let k = 0; k < this._slots.length; k++) {
      const on = k === i;
      this._slots[k].classList.toggle('sel', on);
      this._sectors[k].classList.toggle('sel', on);
    }
    const m = MOUNTS[i];
    const active = this.mounts?.active?.id ?? null;
    const locked = m && this._lockedIds?.has(m.id);
    this._hubName.textContent = m ? m.label.toUpperCase() : 'MOUNTS';
    this._hubName.classList.toggle('on', !!m && !locked);
    this._hubName.classList.toggle('locked', !!locked);
    this._hint.textContent = !m
      ? 'Aim and release'
      : locked ? 'Not unlocked yet'
        : m.id === active ? `Release to dismiss ${m.label}` : m.hint;
  }

  /**
   * Point the needle.
   *
   * Length tracks how far the vector is past the dead zone, so a hand that has
   * barely moved gets a stub rather than a committed-looking dart.
   */
  _aim(angle, len) {
    if (len <= 0) {
      this._needle.classList.remove('on');
      return;
    }
    this._needle.classList.add('on');
    const deg = (angle * 180) / Math.PI;
    this._needle.setAttribute('transform', `rotate(${deg.toFixed(1)} ${CX} ${CX})`);
    const r = Math.min(1, len);
    this._needle.style.setProperty('--reach', r.toFixed(3));
    // Grows from the hub outwards, so the needle reads as being pushed rather
    // than as sliding along a track.
    const head = this._needleTail + (this._needleHead - this._needleTail) * r;
    this._needleLine.setAttribute('y2', head.toFixed(1));
    this._needleTip.setAttribute('cy', (head - 6).toFixed(1));
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
    // No mount ever appears in a world that forbids them - `MountManager.summon`
    // already refuses - but leaving this ungated let the wheel itself pop up
    // anyway, which reads as broken rather than as "no mounts here".
    if (!allows(this.mounts?.worldManager?.active, 'mounts')) return;
    this._open = true;
    this._vx = 0;
    this._vy = 0;
    this._moved = false;
    this._sel = -1;

    const unlocked = new Set(this.mounts?.unlocked ?? []);
    const active = this.mounts?.active?.id ?? null;
    this._lockedIds = new Set();
    for (let i = 0; i < MOUNTS.length; i++) {
      const m = MOUNTS[i];
      // A locked mount is shown, not hidden: knowing one exists is most of the
      // reason to go and unlock it.
      const locked = unlocked.size > 0 && !unlocked.has(m.id);
      if (locked) this._lockedIds.add(m.id);
      for (const n of [this._slots[i], this._sectors[i]]) {
        n.classList.toggle('locked', locked);
        n.classList.toggle('active', m.id === active);
        n.classList.remove('sel');
      }
    }
    // -1 is the resting state, but `_select` early-returns when the index has
    // not changed and `_sel` was already reset above, so drive the readout
    // directly rather than relying on the guard letting it through.
    this._sel = -2;
    this._select(-1);
    this._aim(0, 0);
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
