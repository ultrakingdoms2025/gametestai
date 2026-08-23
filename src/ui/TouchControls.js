import './touch.css';
import { TOUCH_ACTIONS, sendTouchAction } from './TouchActions.js';

/**
 * The on-screen control layer: virtual stick, look drag, action buttons, tray.
 *
 * ── What this is not ─────────────────────────────────────────────────────
 *
 * It is not a second implementation of the game's controls. Every control here
 * goes through `TouchActions.sendTouchAction`, which either sets one of the two
 * pointer-button flags `mousedown` sets, or dispatches a real `KeyboardEvent`
 * on `window` - the same event a physical key produces, reaching the same
 * listeners in the same order. That is why this file may not name `mounts`,
 * `hud`, `player` or `worldManager`; a gate enforces it.
 *
 * ── When it is on screen ─────────────────────────────────────────────────
 *
 * Three conditions, all required:
 *
 *   1. the session is being driven by touch (`input:touchmode`),
 *   2. the game has started (`game:started`) - the boot card is a full-screen
 *      div with its own click handler, and a look pad over it would eat the tap
 *      that enters the world, and
 *   3. the player is engaged (`input:lockchange`) - so the sticks come off the
 *      screen while the pause hub, the inventory or the marketplace is up,
 *      rather than floating over a menu and swallowing taps meant for it.
 *
 * Condition 3 is the same signal that raises the `standby` gameplay block, so
 * the controls are on screen exactly when the world is running. They cannot
 * drift apart.
 *
 * ── The stick floats ─────────────────────────────────────────────────────
 *
 * It appears where the thumb lands rather than at a fixed spot. A fixed stick
 * on a phone means looking down to find it, and on a tablet it is either
 * unreachable or in the way; a floating one is wherever the hand already was.
 * The visible ring is the origin, not the control.
 */

/** Stick throw in CSS pixels: the distance that means "full deflection". */
const STICK_RADIUS = 56;

/**
 * Movement below this many pixels is not a drag.
 *
 * A tap on the look pad is how a player dismisses the tray, and without a
 * threshold the two or three pixels a thumb rolls while lifting would arrive as
 * a look nudge on every single tap.
 */
const LOOK_SLOP = 2;

function el(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
}

export class TouchControls {
  /**
   * @param {{root:HTMLElement, bus:any, input:any}} ctx
   */
  constructor({ root, bus, input }) {
    this.bus = bus ?? null;
    this.input = input ?? null;

    this._started = false;
    this._trayOpen = false;
    /** Ids of the toggle rows currently latched on. */
    this._latched = new Set();
    /** pointerId -> what that finger is doing. */
    this._pointers = new Map();
    /** id -> button element, so a toggle can show its own state. */
    this._buttons = new Map();
    this._offs = [];

    this.el = this._build();
    root.appendChild(this.el);
    this._wire();
    this._sync();
  }

  /* ------------------------------------------------------------------ */
  /* Build                                                               */
  /* ------------------------------------------------------------------ */

  _build() {
    const wrap = el('div', 'touch');

    /* The look pad fills the screen and sits UNDER everything else in the
     * layer, so a drag that starts on a button is that button's and a drag
     * that starts anywhere else is a look. Nothing needs hit-testing. */
    this.look = el('div', 'touch-look');
    wrap.appendChild(this.look);

    this.stick = el('div', 'touch-stick');
    this.stickKnob = el('div', 'touch-stick-knob');
    this.stick.appendChild(this.stickKnob);
    wrap.appendChild(this.stick);

    const primary = el('div', 'touch-primary');
    const left = el('div', 'touch-left');
    const tray = el('div', 'touch-tray');
    const trayGrid = el('div', 'touch-tray-grid');
    tray.appendChild(trayGrid);

    for (const row of TOUCH_ACTIONS) {
      const b = this._button(row);
      if (row.where === 'primary') primary.appendChild(b);
      else if (row.where === 'left') left.appendChild(b);
      else trayGrid.appendChild(b);
    }

    /* The tray's own opener is not a `TOUCH_ACTIONS` row: it performs no game
     * verb at all, and putting it in the table would make it the one entry that
     * fails the "every row reaches the game" shape check. */
    this.trayBtn = el('button', 'touch-btn touch-more');
    this.trayBtn.type = 'button';
    this.trayBtn.append(el('span', 'touch-glyph', '⋯'), el('span', 'touch-label', 'More'));
    this.trayBtn.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      e.stopPropagation();
      this._setTray(!this._trayOpen);
    });
    left.appendChild(this.trayBtn);

    wrap.append(left, primary, tray);
    this.tray = tray;
    return wrap;
  }

  /**
   * One button, wired to its row.
   *
   * `pointerdown`/`pointerup` rather than `click`: a click arrives on release,
   * which is 100-300 ms of a held fire button that never fired, and a hold
   * cannot be expressed with it at all.
   */
  _button(row) {
    const b = el('button', `touch-btn touch-${row.kind} touch-a-${row.id}`);
    b.type = 'button';
    b.dataset.id = row.id;
    b.append(
      el('span', 'touch-glyph', row.glyph ?? ''),
      el('span', 'touch-label', row.label)
    );
    if (row.hint) b.appendChild(el('span', 'touch-hint', row.hint));

    const press = (e) => {
      e.preventDefault();
      // Or the look pad beneath would take the same gesture as a drag.
      e.stopPropagation();
      b.setPointerCapture?.(e.pointerId);
      this._press(row, true);
      // The tray is a menu: choosing from it closes it. Holds are the exception
      // - the abandon hold and the airbrake both need the button to stay under
      // the thumb while it is held.
      if (row.where === 'tray' && row.kind !== 'hold') this._setTray(false);
    };
    const release = (e) => {
      e.preventDefault();
      e.stopPropagation();
      this._press(row, false);
    };

    b.addEventListener('pointerdown', press);
    b.addEventListener('pointerup', release);
    /* Without this a finger that slides off a held button - which is what a
     * thumb does under recoil - leaves the key down for the rest of the
     * session. `pointercancel` is also what the browser sends when it decides
     * a gesture became a scroll. */
    b.addEventListener('pointercancel', release);
    b.addEventListener('lostpointercapture', () => this._press(row, false));

    this._buttons.set(row.id, b);
    return b;
  }

  /**
   * Perform a row, honouring the toggle rows' latch.
   *
   * @param {object} row
   * @param {boolean} down
   */
  _press(row, down) {
    if (row.kind === 'toggle') {
      if (!down) return; // the latch is changed on the press, not the release
      const on = !this._latched.has(row.id);
      if (on) this._latched.add(row.id);
      else this._latched.delete(row.id);
      this._buttons.get(row.id)?.classList.toggle('on', on);
      sendTouchAction(row, on, { input: this.input });
      return;
    }
    if (row.kind === 'hold') {
      // Idempotent: `pointerup`, `pointercancel` and `lostpointercapture` can
      // all arrive for the same release, and three keyups are two too many.
      const held = this._latched.has(row.id);
      if (down === held) return;
      if (down) this._latched.add(row.id);
      else this._latched.delete(row.id);
      this._buttons.get(row.id)?.classList.toggle('on', down);
    }
    sendTouchAction(row, down, { input: this.input });
  }

  /* ------------------------------------------------------------------ */
  /* Gestures                                                            */
  /* ------------------------------------------------------------------ */

  _wire() {
    const on = (node, type, fn, opts) => {
      node.addEventListener(type, fn, opts);
      this._offs.push(() => node.removeEventListener(type, fn, opts));
    };

    on(this.look, 'pointerdown', (e) => {
      e.preventDefault();
      this.look.setPointerCapture?.(e.pointerId);
      /* Left half drives, right half looks. Split on the pointer's own x rather
       * than on separate elements so a thumb that starts near the middle and
       * drifts across keeps doing what it started doing. */
      const drives = e.clientX < window.innerWidth * 0.42;
      this._pointers.set(e.pointerId, {
        drives,
        ox: e.clientX,
        oy: e.clientY,
        lx: e.clientX,
        ly: e.clientY,
        moved: false,
      });
      if (drives) this._showStick(e.clientX, e.clientY);
    });

    on(this.look, 'pointermove', (e) => {
      const p = this._pointers.get(e.pointerId);
      if (!p) return;
      e.preventDefault();
      if (p.drives) {
        const dx = e.clientX - p.ox;
        const dy = e.clientY - p.oy;
        const len = Math.hypot(dx, dy);
        const k = len > STICK_RADIUS ? STICK_RADIUS / len : 1;
        this._moveKnob(dx * k, dy * k);
        // Screen y grows downwards; forward is up.
        this.input?.setMoveAxis?.((-dy * k) / STICK_RADIUS, (dx * k) / STICK_RADIUS);
      } else {
        const dx = e.clientX - p.lx;
        const dy = e.clientY - p.ly;
        p.lx = e.clientX;
        p.ly = e.clientY;
        if (!p.moved && Math.hypot(dx, dy) < LOOK_SLOP) return;
        p.moved = true;
        this.input?.applyLook?.(dx, dy);
      }
    });

    const end = (e) => {
      const p = this._pointers.get(e.pointerId);
      if (!p) return;
      this._pointers.delete(e.pointerId);
      if (p.drives) {
        this._hideStick();
        this.input?.setMoveAxis?.(0, 0);
      } else if (!p.moved && this._trayOpen) {
        // A tap on open ground dismisses the tray, the way tapping outside a
        // menu does everywhere else.
        this._setTray(false);
      }
    };
    on(this.look, 'pointerup', end);
    on(this.look, 'pointercancel', end);

    const sub = (type, fn) => this._offs.push(this.bus?.on?.(type, fn) ?? (() => {}));
    sub('input:touchmode', () => this._sync());
    sub('input:lockchange', () => this._sync());
    sub('game:started', () => { this._started = true; this._sync(); });
  }

  _showStick(x, y) {
    this.stick.style.left = `${x}px`;
    this.stick.style.top = `${y}px`;
    this.stick.classList.add('on');
    this._moveKnob(0, 0);
  }

  _moveKnob(dx, dy) {
    this.stickKnob.style.transform = `translate(-50%, -50%) translate(${dx}px, ${dy}px)`;
  }

  _hideStick() {
    this.stick.classList.remove('on');
    this._moveKnob(0, 0);
  }

  _setTray(open) {
    this._trayOpen = !!open;
    this.tray.classList.toggle('open', this._trayOpen);
    this.trayBtn.classList.toggle('on', this._trayOpen);
  }

  /* ------------------------------------------------------------------ */
  /* Visibility                                                          */
  /* ------------------------------------------------------------------ */

  /** True when the layer should be on screen. See the class docblock. */
  get shown() {
    return !!(this.input?.touchMode && this._started && this.input?.locked);
  }

  _sync() {
    const show = this.shown;
    this.el.classList.toggle('on', show);
    if (show) return;
    /* Going away is a release, not a pause. A latched sprint or a held airbrake
     * that survived into the pause hub would still be down when the player came
     * back, with no button on screen that could let it go. */
    this._setTray(false);
    this._hideStick();
    this._pointers.clear();
    for (const row of TOUCH_ACTIONS) {
      if (!this._latched.has(row.id)) continue;
      this._latched.delete(row.id);
      this._buttons.get(row.id)?.classList.remove('on');
      sendTouchAction(row, false, { input: this.input });
    }
  }

  /** Present for symmetry with the other UI modules; this layer is event-driven. */
  update() {}

  dispose() {
    for (const off of this._offs) off();
    this._offs.length = 0;
    this.el.remove();
  }
}
