import { CONFIG } from './Config.js';

/**
 * Keyboard + mouse + touch input with pointer-lock capture.
 *
 * Exposes an immediate-mode snapshot (`state`) that gameplay code samples each
 * frame, plus edge-triggered helpers (`pressed`) that consume a keypress so a
 * single tap cannot fire twice.
 *
 * ── Engagement, and why `locked` is a union ───────────────────────────────
 *
 * `main.js` derives the `standby` gameplay block from `input.locked`, so on a
 * phone the game was unplayable in the worst possible way: iOS Safari does not
 * implement `requestPointerLock`, the optional call returned `undefined` with
 * nothing to reject, `pointerlockchange` never fired, `standby` was never added
 * - and **the world simulated behind the full-screen PAUSED card**, which owns
 * pointer events. The player was being shot at, drowning and falling behind a
 * menu they had no way to dismiss.
 *
 * The cure is not to stop blocking gameplay. `standby` is what stops the world
 * running behind a menu on every platform and weakening it would trade one
 * silent-simulation bug for another. The cure is that the pointer lock was
 * never the requirement: it was a PROXY for "the player has handed the canvas
 * their input", and a thumb on an on-screen stick is the same fact arriving
 * through a different API.
 *
 * So `get locked()` is the union of the two engagement sources, and the private
 * `_locked` keeps meaning *pointer lock* for the three handlers that genuinely
 * mean pointer lock (`mousemove`'s delta gate, `requestPointerLock`,
 * `exitPointerLock`). Every one of the thirteen call sites outside this file
 * already asks the getter, and every one of them means "is the player playing".
 */

/* Ctrl is NOT a game key.
 *
 * This used to be a `CTRL_GAME_KEYS` allow-list, because Ctrl was a second
 * crouch binding and a crouching player still needs to walk. That set claimed
 * the movement keys while Ctrl was held, which meant the game saw Ctrl+W and
 * the browser did too - and outside fullscreen the browser wins and closes the
 * tab. Crouch now lives on `KeyC` alone (see `_syncAxes`), so there is nothing
 * left to claim and every Ctrl combination goes back to the browser untouched.
 */

/**
 * Rebindable actions, and the key each one ships on.
 *
 * ── How rebinding works without touching thirty call sites ────────────────
 *
 * Gameplay code asks for keys two ways: the axes below read `_keys` directly,
 * and a dozen modules call `pressed('KeyF')` with a literal code. Rewriting
 * every one of those to ask for an *action* would be a wide, risky change
 * across files other people are editing.
 *
 * So the default code doubles as the action's identity. A binding is a
 * redirection from the shipped code to whatever the player chose, `pressed`
 * resolves through that redirection, and every existing call site keeps working
 * untouched while becoming rebindable. `pressed('KeyF')` means "the key that
 * dismount is on", which happens to be F until someone changes it.
 *
 * The label is what the rebinding panel shows; the group is how it sorts.
 */
export const BINDABLE = [
  { action: 'forward', code: 'KeyW', label: 'Move forward', group: 'Movement' },
  { action: 'back', code: 'KeyS', label: 'Move back', group: 'Movement' },
  { action: 'left', code: 'KeyA', label: 'Strafe left', group: 'Movement' },
  { action: 'right', code: 'KeyD', label: 'Strafe right', group: 'Movement' },
  { action: 'jump', code: 'Space', label: 'Jump / climb / fly up', group: 'Movement' },
  { action: 'sprint', code: 'ShiftLeft', label: 'Sprint', group: 'Movement' },
  { action: 'crouch', code: 'KeyC', label: 'Crouch / dive / roll', group: 'Movement' },
  { action: 'interact', code: 'KeyE', label: 'Interact / pick up / portal', group: 'Actions' },
  { action: 'reload', code: 'KeyR', label: 'Reload', group: 'Actions' },
  { action: 'dismount', code: 'KeyF', label: 'Dismount', group: 'Actions' },
  { action: 'camera', code: 'KeyV', label: 'First / third person', group: 'Actions' },
  { action: 'chat', code: 'KeyT', label: 'Open chat', group: 'Actions' },
  /* One action, two meanings, decided per world by `mapActionOwner` - the
   * maze's map where mounts are forbidden, the mount wheel everywhere else.
   * It is a single BINDABLE row on purpose: a contextual key that could not be
   * rebound would be the worst of both, and this way rebinding moves both
   * consumers together. The label names both because the panel should not
   * pretend otherwise. */
  { action: 'map', code: 'KeyM', label: 'Map / mount wheel', group: 'Actions' },
  /* A HOLD, not a press: the spec requires a player four kilometres deep to be
   * able to leave from anywhere, and requires that the control cannot be
   * fumbled mid-run. See `AbandonHold`. */
  { action: 'abandon', code: 'KeyL', label: 'Hold to leave the maze', group: 'Actions' },
  /* The ship's transit drive. A real row rather than a bare `pressed('KeyZ')`
   * so it is rebindable and appears in the panel like every other ship
   * control; `Piloting.TRANSIT_KEY` holds the literal and explains why Z and
   * not Q (Q is the only free half of the unbuilt lateral-thruster pair). */
  { action: 'transit', code: 'KeyZ', label: 'Transit drive (ship)', group: 'Actions' },
  { action: 'mapOut', code: 'BracketLeft', label: 'Minimap zoom out', group: 'Actions' },
  { action: 'mapIn', code: 'BracketRight', label: 'Minimap zoom in', group: 'Actions' },
];

const BIND_STORAGE = 'aether-nexus:binds:v1';
const FS_STORAGE = 'aether:fullscreen';

/**
 * Metres of look per CSS pixel of drag, before `mouseSensitivity`.
 *
 * A drag is not a mouse delta and must not be scaled like one. Pointer lock
 * reports raw device movement, which on a desktop mouse is several counts per
 * CSS pixel; a finger reports exactly the pixels it crossed. Feeding drag
 * pixels through `mouseSensitivity` unmodified gives a look so slow the player
 * runs out of screen before they have turned ninety degrees. 2.6 puts a
 * half-screen sweep at roughly a 180, which is the gesture every phone shooter
 * has trained players to expect.
 */
const TOUCH_LOOK_GAIN = 2.6;

/**
 * Keys the game cannot give up without breaking its own escape hatches, plus
 * the ones the BROWSER will never really hand over.
 *
 * Since the Esc hub landed, F2-F10 are no longer game keys at all - but they
 * stay reserved, because Chrome answers most of them itself (F3 find, F5
 * reload, F6 address bar, F10 menu bar) and a binding pointed at one would work
 * only while the page happened to have focus. F11 (fullscreen, which the hub
 * owns as a preference) and F12 (devtools, un-preventable) are here for the
 * same reason. Exported so `KeybindMenu` and the pause-hub source guard check
 * against the one list rather than a copy.
 *
 * Enforced in BOTH directions: `setBinding` refuses to write one, and
 * `_loadBinds` drops one already in storage. A build that shipped a narrower
 * list, or a hand-edited entry, would otherwise leave the player with an Escape
 * that no longer closes anything and no way in the UI to take it back.
 */
export const RESERVED_CODES = [
  'Escape', 'F1', 'F2', 'F3', 'F4', 'F5', 'F6', 'F7', 'F8', 'F9', 'F10', 'F11', 'F12', 'Tab',
  /* The modifiers, for the second reason above rather than the first: a keydown
   * for ControlLeft itself arrives with `ctrlKey` set, so `onKey` drops it and
   * the game can never see it. An action bound here would simply never fire.
   * Ctrl was crouch until a player found that it could not be made to work. */
  'ControlLeft', 'ControlRight',
];

export class Input {
  constructor(canvas, bus) {
    this.canvas = canvas;
    this.bus = bus;

    this.state = {
      forward: 0,
      right: 0,
      jump: false,
      sprint: false,
      crouch: false,
      fire: false,
      aim: false,
      reload: false,
      interact: false,
      // Accumulated mouse delta, consumed and zeroed by the player controller.
      lookX: 0,
      lookY: 0,
      wheel: 0,
    };

    this._keys = new Set();
    this._pressedThisFrame = new Set();
    /** shipped code -> code the player actually uses. See {@link BINDABLE}. */
    this._binds = new Map();
    /** The inverse, rebuilt on every change so lookups stay O(1) per frame. */
    this._bindsInverse = new Map();
    this._loadBinds();
    this._locked = false;
    this._enabled = true;

    /* ── Touch engagement ────────────────────────────────────────────────
     *
     * `_touchEngaged` is the second half of `get locked()`. It is only ever set
     * on a device that has told us it is being touched, so a mouse-and-keyboard
     * session cannot reach it and desktop standby behaviour is unchanged. */
    this._touchEngaged = false;
    /* Latched at construction where the API is simply missing (iOS Safari, and
     * the reason the original failure was silent), and again on the first
     * `pointerType: 'touch'` pointerdown - because Android Chrome DOES
     * implement pointer lock, so detection-by-absence alone would leave every
     * Android player on the desktop path with no on-screen controls at all. */
    this._touchMode = !Input.pointerLockSupported();
    /** Analog stick, folded into the axes by `_syncAxes` alongside the keys. */
    this._touchForward = 0;
    this._touchRight = 0;
    /** While the chat box has focus we swallow all gameplay input. */
    this._textCaptured = false;

    /* Fullscreen is a preference now, not an unconditional side effect of
     * taking the pointer: `requestLock` re-entered it on every resume, so the
     * hub's "Fullscreen: Off" survived exactly until Resume was pressed.
     * Persisted, because someone who turned it off wants it off tomorrow.
     * Default true - `navigator.keyboard.lock`, the only thing between a
     * crouch-walking player (Ctrl+W) and a closed window, needs fullscreen. */
    this._fullscreenPreferred = this._loadFullscreenPref();

    this._bind();
  }

  /**
   * Does the browser implement pointer lock at all?
   *
   * `exitPointerLock` rather than `requestPointerLock`, because it is on
   * `document` and can be asked before any canvas exists. iOS Safari ships
   * neither; every desktop browser ships both.
   *
   * @returns {boolean}
   */
  static pointerLockSupported() {
    return typeof document !== 'undefined' && typeof document.exitPointerLock === 'function';
  }

  /**
   * Is the player's input going into the game?
   *
   * The union of pointer lock and touch engagement - see the class docblock.
   * This is the question every caller outside this file is actually asking,
   * including the one that decides whether the world may simulate.
   */
  get locked() {
    return this._locked || this._touchEngaged;
  }

  /** True while this session is being driven by touch rather than a mouse. */
  get touchMode() {
    return this._touchMode;
  }

  get textCaptured() {
    return this._textCaptured;
  }

  /** Called by the chat UI so WASD typed into the box does not walk the player. */
  setTextCapture(on) {
    this._textCaptured = on;
    if (on) {
      this._keys.clear();
      this._resetAxes();
    }
  }

  /** Whether resuming should re-enter fullscreen. Persisted. */
  get fullscreenPreferred() {
    return this._fullscreenPreferred;
  }

  set fullscreenPreferred(on) {
    this._fullscreenPreferred = !!on;
    try {
      localStorage.setItem(FS_STORAGE, this._fullscreenPreferred ? '1' : '0');
    } catch { /* private mode; the session preference still applies */ }
  }

  /** @returns {boolean} stored preference, defaulting to on. */
  _loadFullscreenPref() {
    try {
      return localStorage.getItem(FS_STORAGE) !== '0';
    } catch {
      return true;
    }
  }

  setEnabled(on) {
    this._enabled = on;
    if (!on) {
      this._keys.clear();
      this._resetAxes();
    }
  }

  /**
   * Switch this session between the mouse path and the touch path.
   *
   * Leaving touch mode disengages first: a tablet that has just had a mouse
   * plugged in must not be left holding a touch engagement no on-screen control
   * can release, which would be `standby` cleared with nothing driving it.
   *
   * @param {boolean} on
   */
  setTouchMode(on) {
    const want = !!on;
    if (want === this._touchMode) return;
    if (!want) this._setTouchEngaged(false);
    this._touchMode = want;
    this.bus?.emit?.('input:touchmode', { touch: want });
  }

  /**
   * The touch half of `get locked()`. Emits the same `input:lockchange` the
   * pointer-lock path does, so `main.js`'s `standby` derivation and the HUD's
   * retry budget both need no touch-specific branch at all.
   *
   * @param {boolean} on
   */
  _setTouchEngaged(on) {
    const want = !!on;
    if (want === this._touchEngaged) return;
    this._touchEngaged = want;
    if (!want) {
      this._keys.clear();
      this._resetAxes();
    }
    this.bus.emit('input:lockchange', { locked: this.locked, touch: true });
  }

  requestLock() {
    if (this.locked) return;

    /* Touch: engage directly, synchronously, with no retry budget.
     *
     * Deliberately BEFORE the pointer-lock call and not after it. Asking first
     * and falling back is what produced the original defect - the request
     * neither succeeds nor rejects on iOS, so there is nothing to fall back
     * FROM, and the four-attempt retry loop in `HUD._requestLock` is what the
     * player ends up looking at. Fullscreen and `navigator.keyboard.lock` are
     * skipped too: iOS Safari implements neither, and Ctrl+W - the entire
     * reason the keyboard lock exists - is not a gesture a phone can make. */
    if (this._touchMode) {
      this._setTouchEngaged(true);
      return;
    }

    /* In newer browsers this returns a promise, and it rejects for reasons that
     * are entirely normal: the document lost focus, the user pressed Escape
     * moments ago and the engagement timer has not elapsed, or the click was
     * not sufficiently trusted. Unhandled, each one logs "Uncaught (in
     * promise)" - a permanent error in the console for something that is not an
     * error and that the next click fixes anyway. */
    try {
      const p = this.canvas.requestPointerLock?.();
      if (p && typeof p.catch === 'function') p.catch(() => {});
    } catch { /* older browsers throw synchronously instead */ }

    /* Fullscreen, so the keyboard lock can be granted - see `_lockKeyboard`.
     *
     * Requested after pointer lock and entirely best-effort: it needs the same
     * user gesture, and if it is refused the game plays exactly as before, just
     * without protection from Ctrl+W. Never awaited, because nothing downstream
     * should wait on a permission dialog. */
    const el = document.documentElement;
    if (this._fullscreenPreferred && !document.fullscreenElement && el.requestFullscreen) {
      Promise.resolve(el.requestFullscreen()).then(
        () => this._lockKeyboard(),
        () => {}
      );
    } else if (document.fullscreenElement) {
      /* Deliberately NOT gated on the preference: a player who is fullscreen
       * for their own reasons still gets Ctrl+W back. */
      this._lockKeyboard();
    }
  }

  /**
   * Stand the player down.
   *
   * Releases BOTH engagement sources. Every panel calls this on open (see
   * `menuFocusIn`), and one that only released a pointer lock would leave a
   * touch player still playing behind the inventory - the same
   * simulating-behind-a-menu defect this phase exists to close, wearing the
   * other hat.
   */
  exitLock() {
    if (this._locked) document.exitPointerLock?.();
    this._setTouchEngaged(false);
    this._unlockKeyboard();
  }

  /**
   * Put the player back in the world after a panel closes.
   *
   * ── The defect this exists for ────────────────────────────────────────
   *
   * Six modules used to do this themselves, with
   * `input.canvas.requestPointerLock()` and a `try/catch` copied between them -
   * bypassing this class entirely. On a phone that method does not exist, so
   * closing the inventory, the character sheet, the mount menu, the ship menu
   * or the maze map left the player stood down with `standby` still held: the
   * world frozen, nothing on screen to explain it, and no way back in. It was
   * found by playing a touch session, not by reading code, and no unit gate
   * could see it because none of them went through a panel.
   *
   * The delay those call sites wrap this in is theirs to keep - browsers refuse
   * a lock that follows an Escape-driven exit too closely - but the decision
   * about WHICH engagement to re-take belongs here, where it can be made once.
   *
   * @returns {Promise<void>|undefined} whatever the browser returned, so the
   *   caller can keep attaching its own rejection handler. Nothing on touch,
   *   where there is no request and so nothing to reject.
   */
  reengage() {
    if (this._touchMode) {
      this.requestLock();
      return undefined;
    }
    /* `exitLock` released the KEYBOARD lock as well as the pointer, so
     * re-taking only the pointer would leave Ctrl+W live again. */
    this.relockKeyboard();
    try {
      return this.canvas?.requestPointerLock?.();
    } catch {
      // The standby overlay is the fallback; never throw out of a menu close.
      return undefined;
    }
  }

  /** Re-arm navigator.keyboard after a menu close. No-op if not in fullscreen. */
  relockKeyboard() {
    if (document.fullscreenElement) this._lockKeyboard();
  }

  _resetAxes() {
    const s = this.state;
    /* The stick is cleared here rather than only in the callers, because every
     * caller means the same thing: input has been stood down. A thumb resting
     * on the stick when the inventory opens would otherwise keep pushing, and
     * because `_syncAxes` FOLDS the stick in, zeroing `s.forward` alone would
     * last exactly until the next key event put it back. */
    this._touchForward = 0;
    this._touchRight = 0;
    s.forward = 0;
    s.right = 0;
    s.jump = false;
    s.sprint = false;
    s.crouch = false;
    s.fire = false;
    s.aim = false;
    s.reload = false;
    s.interact = false;
    s.lookX = 0;
    s.lookY = 0;
  }

  /* ================================================================== */
  /* Touch                                                              */
  /*                                                                    */
  /* Three methods, and between them they are the whole touch input      */
  /* surface. Everything else a finger can do is a synthesised            */
  /* `KeyboardEvent` dispatched on `window` by `ui/TouchControls.js` -    */
  /* which is not a shortcut but the only correct route: half the panels  */
  /* in this game bind their own capture-phase `keydown` (they have to,   */
  /* because `Input` stops reporting while they are open), so a button    */
  /* that poked `_keys` directly could open the mount wheel and then be   */
  /* unable to close it.                                                  */
  /* ================================================================== */

  /**
   * A look delta from a drag rather than from `movementX/Y`.
   *
   * Not gated on `_locked`, and that is the point: there is no pointer lock on
   * a touch device to gate it with, and the `mousemove` handler's gate is
   * exactly what would swallow every drag. It writes the same `lookX/lookY`
   * accumulator `consumeLook()` drains, so the player controller, the flight
   * model and the mount steering all receive it without knowing it came from a
   * finger.
   *
   * The raw delta is also published on the bus, unscaled, for `MountWheel` -
   * which integrates deltas into a direction vector of its own and needs them
   * in the same units the mouse gives it.
   *
   * @param {number} dx CSS pixels
   * @param {number} dy CSS pixels
   */
  applyLook(dx, dy) {
    if (!this._enabled || this._textCaptured) return;
    const x = Number.isFinite(dx) ? dx : 0;
    const y = Number.isFinite(dy) ? dy : 0;
    const sens = CONFIG.player.mouseSensitivity * TOUCH_LOOK_GAIN;
    this.state.lookX += x * sens;
    this.state.lookY += y * sens;
    this.bus?.emit?.('input:look', { dx: x, dy: y });
  }

  /**
   * The virtual stick. Components are -1..1 and are FOLDED INTO the axes rather
   * than assigned to them, because `_syncAxes()` rewrites `forward`/`right` on
   * every single key event - a stick that merely wrote them would be zeroed by
   * the next button press.
   *
   * The analog magnitude is passed through even though `Player._move`
   * normalises the wish vector, because two things downstream do read it:
   * diagonals arrive at the right angle, and `wishLen > 0.1` is what stops a
   * hair of stick drift from arming a sprint.
   *
   * @param {number} forward +1 is ahead
   * @param {number} right +1 is right
   */
  setMoveAxis(forward, right) {
    if (!this._enabled || this._textCaptured) return;
    const clamp = (v) => (Number.isFinite(v) ? Math.max(-1, Math.min(1, v)) : 0);
    this._touchForward = clamp(forward);
    this._touchRight = clamp(right);
    this._syncAxes();
  }

  /**
   * The fire and aim buttons, writing the same two flags `mousedown` sets.
   *
   * @param {'fire'|'aim'} which
   * @param {boolean} down
   */
  setPointerButton(which, down) {
    if (which !== 'fire' && which !== 'aim') return;
    if (!this._enabled || this._textCaptured) return;
    this.state[which] = !!down;
  }

  /**
   * Take the reserved keyboard shortcuts while the game is being played.
   *
   * ── The bug this exists for ───────────────────────────────────────────────
   *
   * Crouch is Ctrl and forward is W, so crouch-walking *is* Ctrl+W - and
   * Ctrl+W closes the window. A player holding those two keys, which is a
   * completely ordinary thing to do, lost the entire session.
   *
   * A page cannot cancel Ctrl+W by preventing the event; Chrome does not
   * deliver it cancellably, for obvious reasons. The Keyboard Lock API is the
   * sanctioned way to ask for it, and it is granted only while the document is
   * fullscreen - which is why entering the game now goes fullscreen as well as
   * taking pointer lock. Escape still releases both, so there is no way to get
   * stuck.
   *
   * Where the lock is unavailable - a browser without it, or a player who
   * declines fullscreen - `SaveGame` still writes on unload and the confirm
   * prompt below still fires, so the worst case is a recoverable interruption
   * rather than a lost session.
   */
  async _lockKeyboard() {
    try {
      if (!navigator.keyboard?.lock) return false;
      // Only the keys that are genuinely destructive in combination with a
      // modifier the game uses. Asking for everything would also swallow the
      // browser's own escape hatches, which is worse than the problem.
      /* The movement set, plus the tab/window keys that are destructive next to
       * it. This only reclaims shortcuts owned by the *browser*; combinations
       * the operating system takes first - Ctrl+Space on a Windows box with
       * more than one input method - are not ours to claim, which is why crouch
       * is a toggle rather than a held modifier. */
      await navigator.keyboard.lock([
        'KeyW', 'KeyA', 'KeyS', 'KeyD', 'Space',
        'KeyN', 'KeyT', 'Escape',
      ]);
      this._keyboardLocked = true;
      return true;
    } catch {
      return false;
    }
  }

  /** Give the shortcuts back. Safe to call when nothing was ever locked. */
  _unlockKeyboard() {
    try { navigator.keyboard?.unlock?.(); } catch { /* not supported */ }
    this._keyboardLocked = false;
  }

  _bind() {
    const onKey = (e, down) => {
      /* Every modifier combination belongs to the browser and the OS, not to
       * the game. An earlier build carved out an exception so Ctrl could act as
       * a second crouch key; that let the game see Ctrl+W while the browser saw
       * it too, and outside fullscreen the browser wins by closing the tab. */
      if (e.metaKey || e.altKey || e.ctrlKey) return;
      if (this._textCaptured) {
        // Escape and Enter still need to reach the chat UI, which listens itself.
        return;
      }
      if (!this._enabled) return;

      const code = e.code;
      if (down) {
        if (!this._keys.has(code)) this._pressedThisFrame.add(code);
        this._keys.add(code);
      } else {
        this._keys.delete(code);
      }

      // Prevent page scroll / quick-find while playing.
      if (
        ['Space', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Slash', 'Tab'].includes(code)
      ) {
        e.preventDefault();
      }
      this._syncAxes();
    };

    window.addEventListener('keydown', (e) => onKey(e, true));
    window.addEventListener('keyup', (e) => onKey(e, false));

    window.addEventListener('blur', () => {
      this._keys.clear();
      this._resetAxes();
    });

    /* Which kind of pointer is driving this session.
     *
     * On `window` and in the CAPTURE phase, deliberately: the boot card is a
     * full-screen div with its own `click` handler that calls `requestLock()`,
     * and a bubbling listener on the canvas would never see the tap at all.
     * Capture-phase `pointerdown` on `window` runs before that click, so touch
     * mode is already set by the time the boot tap asks to engage - which is
     * what makes the very first gesture of a phone session take the right path
     * rather than the pointer-lock one that cannot succeed.
     *
     * `pen` counts as touch: a stylus on a tablet has no pointer lock either.
     */
    window.addEventListener(
      'pointerdown',
      (e) => {
        const t = e?.pointerType;
        if (t === 'touch' || t === 'pen') this.setTouchMode(true);
        else if (t === 'mouse' && Input.pointerLockSupported()) this.setTouchMode(false);
      },
      true
    );

    this.canvas.addEventListener('mousedown', (e) => {
      if (!this._enabled || this._textCaptured) return;
      /* Browsers fire a compatibility `mousedown` after a tap that was not
       * `preventDefault`ed, so on touch this handler would turn a look drag
       * into a shot. The touch layer owns firing; see `setPointerButton`. */
      if (this._touchMode) return;
      if (!this.locked) {
        this.requestLock();
        return;
      }
      if (e.button === 0) this.state.fire = true;
      if (e.button === 2) this.state.aim = true;
    });

    window.addEventListener('mouseup', (e) => {
      if (e.button === 0) this.state.fire = false;
      if (e.button === 2) this.state.aim = false;
    });

    this.canvas.addEventListener('contextmenu', (e) => e.preventDefault());

    window.addEventListener('mousemove', (e) => {
      if (!this._locked || !this._enabled || this._textCaptured) return;
      const sens = CONFIG.player.mouseSensitivity;
      this.state.lookX += e.movementX * sens;
      this.state.lookY += e.movementY * sens;
    });

    window.addEventListener(
      'wheel',
      (e) => {
        if (!this._enabled || this._textCaptured) return;
        this.state.wheel += Math.sign(e.deltaY);
      },
      { passive: true }
    );

    document.addEventListener('pointerlockchange', () => {
      this._locked = document.pointerLockElement === this.canvas;
      this.bus.emit('input:lockchange', { locked: this._locked });
      if (!this._locked) {
        this._keys.clear();
        this._resetAxes();
      }
    });

    /* Fullscreen can change without us asking: F11, the browser's own Escape,
     * an OS gesture, or the hub's toggle. Keyboard lock is only granted in
     * fullscreen, so it has to follow - otherwise leaving fullscreen keeps a
     * lock the browser already revoked, and re-entering leaves Ctrl+W live
     * while the player is still playing. */
    document.addEventListener('fullscreenchange', () => {
      if (document.fullscreenElement) {
        if (this._locked) this.relockKeyboard();
      } else {
        this._unlockKeyboard();
      }
    });

    /* A refused lock request.
     *
     * Chrome will not re-lock for roughly a second after the user pressed
     * Escape to get out, and it refuses *silently*: the legacy form of
     * `requestPointerLock()` returns undefined, so there is no promise to
     * reject and the only notification is this event. Without it a click on
     * the standby overlay during that window does nothing at all and the
     * player is stuck looking at it. */
    document.addEventListener('pointerlockerror', () => {
      this.bus.emit('input:lockerror', {});
    });
  }

  _syncAxes() {
    const k = this._keys;
    const s = this.state;
    // `b` maps a shipped code to whatever the player put there. The arrow keys
    // and the right-hand modifiers stay as fixed alternates: they are not worth
    // a row in the rebinding panel, and losing them would be a regression for
    // anyone who uses them.
    const b = (code) => k.has(this._bindsInverse.get(code) ?? code);
    /* Keys and stick ADD, then clamp - they are two sources for one axis, not
     * two modes. A tablet with a keyboard attached can use both in the same
     * second, and opposed inputs should cancel exactly as W and S do rather
     * than have one silently win.
     *
     * The `|| 0` is not decoration. These axes are multiplied into the wish
     * vector in `Player._move`, so a single undefined would put a NaN into the
     * player's velocity and from there into its position - an unrecoverable
     * state with no error anywhere. The constructor always sets both fields, so
     * the only way to reach that is a stub built with `Object.create`, which is
     * how half the tests in this repo drive this class. */
    const clamp = (v) => Math.max(-1, Math.min(1, v));
    s.forward = clamp(
      (b('KeyW') || k.has('ArrowUp') ? 1 : 0)
      - (b('KeyS') || k.has('ArrowDown') ? 1 : 0)
      + (this._touchForward || 0)
    );
    s.right = clamp(
      (b('KeyD') || k.has('ArrowRight') ? 1 : 0)
      - (b('KeyA') || k.has('ArrowLeft') ? 1 : 0)
      + (this._touchRight || 0)
    );
    s.jump = b('Space');
    s.sprint = b('ShiftLeft') || k.has('ShiftRight');
    /* Held, and on ONE key, which is deliberately not a modifier.
     *
     * Ctrl used to crouch as well, and the comment that stood here argued
     * correctly that it should not - then the line below kept it anyway. A
     * player reported the consequence ("ctrl does the same thing and I think
     * that might be making it hard to roll"). They were right, and it was
     * worse than an annoyance:
     *
     *   - Crouch KILLS sprint (`_sprinting` is gated on `!_crouching`), and the
     *     ground dodge needs >= LEAP_MIN_SPEED to arm. Ctrl is a modifier, so
     *     players HOLD it; held from a standstill it caps you at `crouchSpeed`
     *     2.2 and the dodge can then never fire. Tapping C works, holding Ctrl
     *     cannot, and nothing on screen explained the difference.
     *   - Ctrl+W CLOSES THE TAB outside fullscreen. `preventDefault` is only
     *     called for the scroll keys, and `navigator.keyboard.lock()` - which
     *     does claim KeyW - is only in force while `document.fullscreenElement`
     *     is set. Fullscreen is only the default *preference* and the pause hub
     *     offers to turn it off, so "crouch and walk forward" ended the session
     *     for anyone playing windowed.
     *   - Ctrl+Shift is the Windows input-method switcher when more than one
     *     layout is installed - and Ctrl+Shift+W is exactly the dodge input.
     *     Keyboard Lock has no authority over an OS-level combination.
     *
     * Crouch is also not merely a stance: five systems read it as a momentary
     * action - dive, roll, let go of a wall, swim down, fly down - so making
     * Ctrl a toggle to sidestep the problem was tried and was wrong (a latched
     * crouch is a dive that never ends and a wall that cannot be held, because
     * FreeClimb releases the moment it sees the flag).
     *
     * So the fix is the one the old comment already named: crouch lives on a
     * key that is not a modifier and composes with everything. `KeyC` is
     * rebindable; Ctrl is no longer a game key at all, which also hands every
     * Ctrl shortcut back to the browser intact. */
    s.crouch = b('KeyC');
    s.reload = b('KeyR');
    s.interact = b('KeyE');
  }

  /**
   * Edge-trigger: true exactly once per physical keypress.
   *
   * `code` is the *shipped* key for an action, which is also that action's
   * identity - see {@link BINDABLE}. Passing 'KeyF' asks "was dismount pressed",
   * not "was the F key pressed", so every existing call site became rebindable
   * without being touched.
   */
  pressed(code) {
    return this._pressedThisFrame.has(this._bindsInverse.get(code) ?? code);
  }

  /**
   * Level-trigger companion to {@link pressed}: true while the action's key is
   * physically down, with the same rebind resolution.
   *
   * Exists because `pressed` is cleared by `endFrame()`, which runs inside a
   * frame callback main.js registers at BOOT — so any frame callback
   * registered later (a minigame's late-frame hook, say) runs after the clear
   * and reads `pressed()` as always-false. Such callers edge-detect on this
   * instead. Measured before this existed: 44 correctly-timed tennis swings
   * across two matches, zero registered.
   */
  held(code) {
    return this._keys.has(this._bindsInverse.get(code) ?? code);
  }

  /* ================================================================== */
  /* Rebinding                                                          */
  /* ================================================================== */

  /** Current mapping as `{ action, code, label, group, bound }` rows. */
  get bindings() {
    return BINDABLE.map((d) => ({ ...d, bound: this._binds.get(d.code) ?? d.code }));
  }

  /**
   * The key code currently bound to an action, for the panels that own their
   * own `keydown` listener rather than going through `pressed`.
   *
   * Those panels (the maze map, the mount wheel) cannot use `pressed` because
   * they must keep working while `Input` has stopped reporting - the same
   * reason the F-key panels are excluded from rebinding. Without this they
   * would hard-code their key and quietly ignore a rebind, which for the
   * contextual `map` action would mean rebinding moved one consumer and not
   * the other. See `mapActionOwner`.
   *
   * @param {string} action an `action` from BINDABLE
   * @returns {string|null} the bound code, or null if there is no such action
   */
  codeFor(action) {
    const d = BINDABLE.find((b) => b.action === action);
    if (!d) return null;
    return this._binds.get(d.code) ?? d.code;
  }

  /**
   * Point an action at a different key.
   *
   * Any other action already holding that key is reset to its own default
   * rather than being left duplicated: two actions on one key is a state the
   * player cannot see and cannot debug, and silently stealing it without saying
   * so is worse. The panel reports what moved.
   *
   * @param {string} defaultCode the action's shipped code, i.e. its identity
   * @param {string} code the key to move it to
   * @returns {{ok:boolean, displaced?:string}}
   */
  setBinding(defaultCode, code) {
    if (!BINDABLE.some((d) => d.code === defaultCode)) return { ok: false };
    if (RESERVED_CODES.includes(code)) return { ok: false };
    let displaced;
    for (const d of BINDABLE) {
      if (d.code === defaultCode) continue;
      if ((this._binds.get(d.code) ?? d.code) === code) {
        this._binds.delete(d.code);
        displaced = d.label;
      }
    }
    if (code === defaultCode) this._binds.delete(defaultCode);
    else this._binds.set(defaultCode, code);
    this._rebuildBinds();
    this._saveBinds();
    return { ok: true, displaced };
  }

  /** Put every action back on the key it shipped with. */
  resetBindings() {
    this._binds.clear();
    this._rebuildBinds();
    this._saveBinds();
  }

  _rebuildBinds() {
    this._bindsInverse.clear();
    for (const [def, code] of this._binds) this._bindsInverse.set(def, code);
    // A held key under the old mapping would stay stuck down after a rebind.
    this._keys.clear();
    this._resetAxes();
    this.bus?.emit?.('input:binds-changed', { bindings: this.bindings });
  }

  _loadBinds() {
    try {
      const raw = globalThis.localStorage?.getItem(BIND_STORAGE);
      if (!raw) return;
      const obj = JSON.parse(raw);
      // Validated against the table rather than trusted: a stale entry from an
      // older build must not resurrect an action that no longer exists.
      for (const d of BINDABLE) {
        const v = obj?.[d.code];
        // ...and against the reserved list, which `setBinding` also enforces:
        // storage outlives the build that wrote it, so an entry saved before a
        // key joined the list would come back and take Escape or F10 away with
        // no UI left to undo it.
        if (typeof v === 'string' && v && v !== d.code && !RESERVED_CODES.includes(v)) {
          this._binds.set(d.code, v);
        }
      }
      this._rebuildBinds();
    } catch { /* corrupt or unavailable - ship defaults */ }
  }

  _saveBinds() {
    try {
      globalThis.localStorage?.setItem(
        BIND_STORAGE, JSON.stringify(Object.fromEntries(this._binds))
      );
    } catch { /* storage disabled or full; the session still has the binding */ }
  }

  /** Consume mouse-look delta; returns and clears it. */
  consumeLook() {
    const dx = this.state.lookX;
    const dy = this.state.lookY;
    this.state.lookX = 0;
    this.state.lookY = 0;
    return { dx, dy };
  }

  consumeWheel() {
    const w = this.state.wheel;
    this.state.wheel = 0;
    return w;
  }

  /** Called at the very end of each frame by the engine. */
  endFrame() {
    this._pressedThisFrame.clear();
  }
}
