/**
 * LANDSCAPE ON A PHONE — the honest two-layer version.
 *
 * The request was "for mobile we should force it to run in landscape to better
 * fit". **A web page cannot force this, and this file does not claim to.**
 * What exists is two separate mechanisms with two different reaches, and the
 * whole point of keeping them in one file is that the second one is what
 * actually delivers the requirement on the phones most players are holding:
 *
 *   1. `screen.orientation.lock('landscape')`, which REALLY turns the screen.
 *      It exists on Android Chrome / Edge / Samsung Internet, and it only
 *      resolves while the document is fullscreen - outside fullscreen it
 *      rejects with `NotSupportedError` / `SecurityError` every time. So the
 *      attempt hangs off `fullscreenchange`, which is the one moment the
 *      browser is willing to grant it, and it is fired no matter WHO entered
 *      fullscreen: `Input.requestLock`, the pause hub's Fullscreen row, or
 *      F11. Hooking the event rather than the call sites is deliberate - there
 *      is no path into fullscreen this misses, and no file outside `src/ui`
 *      has to change to get it.
 *
 *      READ THIS BEFORE BELIEVING THE LOCK IS AUTOMATIC ON A PHONE. It is
 *      not, and the reason is three lines into `Input.requestLock`: on the
 *      touch path it engages and RETURNS, before the fullscreen request,
 *      because iOS Safari implements neither pointer lock nor element
 *      fullscreen and `Ctrl+W` - the whole reason that fullscreen is asked for
 *      - is not a gesture a phone can make. So a phone never enters fullscreen
 *      of its own accord, and the automatic hook therefore never fires there.
 *      TURN THE SCREEN FOR ME is the path that does it: one click, inside the
 *      user activation both calls need, fullscreen first and then the lock.
 *
 *   2. A rotate prompt, for everywhere else. **iOS Safari does not implement
 *      `screen.orientation.lock` at all** - there is no API, no permission and
 *      no workaround - so on an iPhone the prompt IS the feature, and the
 *      button above is not even built (see `_build`). It is also what a player
 *      on Android sees before they press that button, and what they still see
 *      if the browser refuses it.
 *
 * ── The CSS rotate hack is not here, on purpose ───────────────────────────
 *
 * The usual "fix" is `@media (orientation: portrait) { #root { transform:
 * rotate(90deg) } }`. It rotates the PIXELS and nothing else: pointer
 * coordinates, scroll, `innerWidth`/`innerHeight`, `env(safe-area-inset-*)`
 * and the virtual keyboard all stay in the frame the browser thinks it is in,
 * so every touch on this game's virtual stick would land somewhere else. This
 * game is played with a thumb on a look pad. It would be unplayable, and it
 * would be unplayable in a way no screenshot shows.
 *
 * ── When the prompt appears, and why that rule ────────────────────────────
 *
 * See {@link shouldPromptRotate}. Three conditions, all required, and the
 * reasoning for each is written there rather than here because that function
 * is the one thing in this file a unit test can drive directly.
 *
 * ── How gameplay stops behind it ──────────────────────────────────────────
 *
 * NOT with a second pause mechanism. `Input.exitLock()` is the one every panel
 * in this repository already calls, and the `input:lockchange` it emits is
 * what makes `main.js` raise the `standby` gameplay block - the block that
 * stops the world simulating. `ui:modal` puts the gate in `HUD._overlays`,
 * which is what stops the PAUSED card being drawn UNDERNEATH this one, and
 * what brings the Esc hub back if the player was in it when they turned the
 * phone over. Both of those are the existing contracts; nothing here is new.
 *
 * ── The escape hatch is a requirement, not a convenience ──────────────────
 *
 * WCAG 2.2 SC 1.3.4 (Orientation, AA) says content must not restrict its view
 * to a single display orientation unless a specific orientation is essential.
 * `index.html` already gave up `user-scalable=no` for SC 1.4.4, so this file
 * keeps faith with the same standard: CONTINUE IN PORTRAIT dismisses the gate
 * for the life of the document. That is also why the narrow-width layouts in
 * `quest-board.css`, `inventory.css` and the rest are still live code and are
 * still graded by `hud-viewport-probe.mjs` at 390 x 844 - dismissing the gate
 * is a state the game genuinely has, so measuring it is measuring the game.
 */

/**
 * The width, in CSS pixels, below which a portrait viewport gets the prompt.
 *
 * 720 is not a new number. It is the breakpoint at which `quest-board.css`,
 * `inventory.css` and `race.css` all abandon their side-by-side layouts and
 * stack - i.e. exactly the width at which the interface has already admitted
 * it does not fit. Above it the panels keep the two-column form the layout
 * probe grades at 768 x 1024 and passes, so a tablet held upright is left
 * alone: it has the room, and being told to turn a working screen is worse
 * than the problem.
 */
export const ROTATE_MAX_PORTRAIT_W = 720;

/**
 * Should this viewport be asked to turn over?
 *
 * Pure, and exported, so `scripts/tests/orientation-gate.test.mjs` can drive
 * the actual decision rather than scraping the source for a media query.
 *
 * Three conditions, all required:
 *
 *   1. **A COARSE POINTER.** This is the one that keeps the prompt off a
 *      desktop. A developer dragging a browser window to 400 px wide is not on
 *      a phone and must never be told to rotate a monitor - and width alone
 *      cannot tell the two apart, which is the whole reason this is keyed on
 *      the pointer. Same rule `hud.css`'s 44 px floor is keyed on, for the
 *      same reason: "narrow" and "touched" are independent facts.
 *   2. **PORTRAIT.** Taller than it is wide. A square viewport counts as
 *      landscape: there is nothing to gain by turning it.
 *   3. **NARROW ENOUGH TO MATTER.** See {@link ROTATE_MAX_PORTRAIT_W}.
 *
 * @param {{width:number, height:number, coarse:boolean}} v
 * @returns {boolean}
 */
export function shouldPromptRotate({ width, height, coarse }) {
  if (!coarse) return false;
  if (!(height > width)) return false;
  return width < ROTATE_MAX_PORTRAIT_W;
}

function el(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
}

/**
 * A phone held upright, drawn as a phone held upright with an arrow round it.
 * Inline SVG for the same reason every other mark in this interface is inline:
 * no second request, and nothing to lose.
 */
const PHONE_SVG = `
<svg viewBox="0 0 120 120" width="100%" height="100%" aria-hidden="true" focusable="false">
  <path d="M18 44a44 44 0 0 1 84 0" fill="none" stroke="currentColor" stroke-width="3"
        stroke-linecap="round" opacity=".55"/>
  <path d="M102 44 92 30 M102 44 87 47" fill="none" stroke="currentColor" stroke-width="3"
        stroke-linecap="round" stroke-linejoin="round" opacity=".55"/>
  <rect x="44" y="34" width="32" height="56" rx="5" fill="none" stroke="currentColor"
        stroke-width="3"/>
  <line x1="55" y1="41" x2="65" y2="41" stroke="currentColor" stroke-width="3"
        stroke-linecap="round" opacity=".7"/>
  <rect x="30" y="62" width="60" height="34" rx="5" fill="none" stroke="currentColor"
        stroke-width="3" opacity=".35"/>
</svg>`;

export class OrientationGate {
  /**
   * @param {{root:HTMLElement, bus?:any, input?:any}} ctx
   */
  constructor({ root, bus, input }) {
    this.root = root;
    this.bus = bus ?? null;
    this.input = input ?? null;

    /** True while the card is on screen. */
    this._on = false;
    /** True once CONTINUE IN PORTRAIT has been pressed. Document-scoped. */
    this._dismissed = false;

    this.el = this._build();
    root.appendChild(this.el);

    this._onResize = () => this.sync();
    this._onFullscreen = () => this._onFullscreenChange();
    window.addEventListener('resize', this._onResize);
    /* `orientationchange` as well as `resize`: on iOS the resize that follows a
     * turn can land before the new metrics are readable, and the two together
     * mean the card never survives a rotation by a frame the player can see. */
    window.addEventListener('orientationchange', this._onResize);
    screen?.orientation?.addEventListener?.('change', this._onResize);
    document.addEventListener('fullscreenchange', this._onFullscreen);
    /* Safari spells it with a prefix and fires nothing else. Harmless where the
     * unprefixed event is the only one: `_onFullscreenChange` is idempotent. */
    document.addEventListener('webkitfullscreenchange', this._onFullscreen);

    /* ONE MICROTASK LATE, AND THAT IS NOT A TIDINESS CHOICE.
     *
     * `HUD._build()` constructs this, and `HUD._wire()` - which is what
     * subscribes to `ui:modal` and so is what puts the gate into
     * `HUD._overlays` - runs afterwards. Deciding synchronously here would
     * emit the open event into a bus nobody is listening on yet: the card
     * would be up, the HUD would not know a modal owned the screen, and the
     * PAUSED card would be drawn straight through it on the first
     * `input:lockchange`. A microtask is after every synchronous constructor
     * and before the first paint, so nothing flashes either. */
    queueMicrotask(() => this.sync());
  }

  /** True while the prompt is on screen. Read by the layout probe's harness. */
  get showing() {
    return this._on;
  }

  /* ------------------------------------------------------------------ */
  /* Build                                                               */
  /* ------------------------------------------------------------------ */

  _build() {
    const wrap = el('div', 'rotate');
    wrap.setAttribute('role', 'dialog');
    wrap.setAttribute('aria-modal', 'true');
    wrap.setAttribute('aria-labelledby', 'rotate-title');
    /* Hidden from the accessibility tree while it is down, so a screen reader
     * on a desktop never announces a phone instruction. `visibility: hidden`
     * in the sheet does the same for the visual side; both are needed. */
    wrap.setAttribute('aria-hidden', 'true');

    const inner = el('div', 'rotate-in');

    const icon = el('div', 'rotate-icon');
    icon.innerHTML = PHONE_SVG;
    inner.appendChild(icon);

    const title = el('div', 'rotate-t', 'ROTATE YOUR DEVICE');
    title.id = 'rotate-title';
    inner.appendChild(title);

    inner.appendChild(el('div', 'rotate-s',
      'Aether Nexus is laid out for landscape. Turn your phone on its side to play.'));

    /* THE BUTTON THAT REALLY TURNS THE SCREEN, and it is only built where the
     * API that turns it exists. On iOS Safari `screen.orientation.lock` is
     * absent, and a button that provably cannot do the thing it is labelled
     * with is worse than no button - the instruction above is the whole
     * affordance there. Detected once, at build, so the card's shape is a fact
     * about the browser rather than a race with a permission. */
    this.lockBtn = null;
    if (typeof screen?.orientation?.lock === 'function') {
      this.lockBtn = el('button', 'rotate-btn rotate-lock', 'Turn the screen for me');
      this.lockBtn.type = 'button';
      this.lockBtn.addEventListener('click', () => this._forceLandscape());
      inner.appendChild(this.lockBtn);
    }

    /* WCAG 2.2 SC 1.3.4. See the file docblock: this is a conformance
     * requirement, not a convenience, and it is why the narrow-width layouts
     * are still live code. */
    this.dismissBtn = el('button', 'rotate-btn rotate-dismiss', 'Continue in portrait');
    this.dismissBtn.type = 'button';
    this.dismissBtn.addEventListener('click', () => this.dismiss());
    inner.appendChild(this.dismissBtn);

    /* Only ever revealed by a lock that was asked for and refused, so the
     * player is told the difference between "the browser will not" and
     * "nothing happened". `hidden` until then, so it is never measured. */
    this.note = el('div', 'rotate-note',
      'This browser will not turn the screen — please rotate the device.');
    this.note.hidden = true;
    inner.appendChild(this.note);

    wrap.appendChild(inner);
    return wrap;
  }

  /* ------------------------------------------------------------------ */
  /* The decision                                                        */
  /* ------------------------------------------------------------------ */

  /** Re-evaluate and show or hide. Safe to call as often as you like. */
  sync() {
    const want = !this._dismissed && shouldPromptRotate({
      width: window.innerWidth,
      height: window.innerHeight,
      coarse: this._coarse(),
    });
    if (want) this._show();
    else this._hide();
  }

  /** @returns {boolean} is the primary pointer a finger? */
  _coarse() {
    return !!window.matchMedia?.('(pointer: coarse)')?.matches;
  }

  /**
   * Stand down for the rest of this document.
   *
   * Not persisted. A reload is a new session and a new chance to hold the
   * phone the way the game reads best; a stored "no" would silently turn the
   * feature off for a player who tapped it once, months ago, and would be
   * invisible to anyone reading this file.
   */
  dismiss() {
    if (this._dismissed) return;
    this._dismissed = true;
    this._hide();
  }

  /* ------------------------------------------------------------------ */
  /* Show / hide                                                         */
  /* ------------------------------------------------------------------ */

  _show() {
    if (this._on) return;
    this._on = true;

    /* ORDER IS LOAD-BEARING. `ui:modal` first, so the gate is already in
     * `HUD._overlays` by the time `exitLock()` fires `input:lockchange` and
     * `main.js` answers it with `hud.showPauseOverlay(true)`. Raised the other
     * way round, the PAUSED card would be drawn behind this one and the player
     * would be looking at a stack of two overlays saying different things. */
    this.bus?.emit?.('ui:modal', { id: 'rotate', open: true });

    /* The same two calls `InventoryUI.menuFocusIn` makes, and for the same two
     * reasons: text capture stops a Bluetooth keyboard walking the player, and
     * `exitLock` is what raises the `standby` gameplay block that stops the
     * world simulating behind a screen nobody can see. */
    this.input?.setTextCapture?.(true);
    this.input?.exitLock?.();

    this.el.classList.add('show');
    this.el.setAttribute('aria-hidden', 'false');
  }

  _hide() {
    if (!this._on) return;
    this._on = false;
    this.el.classList.remove('show');
    this.el.setAttribute('aria-hidden', 'true');
    this.note.hidden = true;

    this.input?.setTextCapture?.(false);
    /* And the HUD takes it from here. `_overlayClose` empties `_overlays`,
     * which runs `_deferHubCheck`: that either brings the Esc hub back (if the
     * player was in it when they turned the phone over) or re-takes the
     * engagement through `_schedRelock`. Re-engaging here as well would be a
     * second mechanism racing the first. */
    this.bus?.emit?.('ui:modal', { id: 'rotate', open: false });
  }

  /* ------------------------------------------------------------------ */
  /* The real lock                                                       */
  /* ------------------------------------------------------------------ */

  /**
   * Entered or left fullscreen. This is the ONLY moment `screen.orientation
   * .lock` can be granted, so it is the only moment it is asked for.
   *
   * Every failure here is the normal case, not an error: a rejected lock is
   * what a desktop, an iPad and every browser without the API return, and it
   * costs the player nothing - the prompt is still there for portrait. So the
   * rejection is swallowed silently and nothing is logged.
   */
  _onFullscreenChange() {
    const o = screen?.orientation;
    if (typeof o?.lock !== 'function') return;
    /* Only where a finger is driving. A desktop in fullscreen on a portrait
     * monitor has made a deliberate choice about its own screen and is not
     * this feature's business; Chrome rejects it there anyway, but asking is
     * still the wrong thing to do. */
    if (document.fullscreenElement) {
      if (!this._coarse()) return;
      try {
        o.lock('landscape')?.catch?.(() => {});
      } catch { /* older engines throw synchronously; same non-event */ }
    } else {
      try {
        o.unlock?.();
      } catch { /* nothing was locked */ }
    }
  }

  /**
   * The player asked for the screen to be turned.
   *
   * Fullscreen FIRST and awaited, because the lock is refused outside it - and
   * both calls are inside the click's user activation, which both of them
   * need. If either is refused the card says so rather than appearing to do
   * nothing, which is the only outcome a player can act on.
   */
  async _forceLandscape() {
    const doc = document.documentElement;
    try {
      if (!document.fullscreenElement && doc.requestFullscreen) {
        await doc.requestFullscreen();
      }
    } catch { /* refused: try the lock anyway, it may be a device that allows it */ }
    try {
      await screen.orientation.lock('landscape');
      /* A resolved lock turns the screen, which fires `resize`, which calls
       * `sync()` and takes this card down. Nothing to do here. */
    } catch {
      this.note.hidden = false;
    }
  }

  /* ------------------------------------------------------------------ */

  dispose() {
    window.removeEventListener('resize', this._onResize);
    window.removeEventListener('orientationchange', this._onResize);
    screen?.orientation?.removeEventListener?.('change', this._onResize);
    document.removeEventListener('fullscreenchange', this._onFullscreen);
    document.removeEventListener('webkitfullscreenchange', this._onFullscreen);
    this.el.remove();
  }
}

export default OrientationGate;
