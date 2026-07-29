import { CONFIG } from './Config.js';

/**
 * Keyboard + mouse input with pointer-lock capture.
 *
 * Exposes an immediate-mode snapshot (`state`) that gameplay code samples each
 * frame, plus edge-triggered helpers (`pressed`) that consume a keypress so a
 * single tap cannot fire twice.
 */

/**
 * Keys the game reads *while Ctrl is held*, because Ctrl is crouch.
 *
 * Everything else pressed with Ctrl is left to the browser - Ctrl+R, Ctrl+T,
 * Ctrl+Shift+I and the rest stay exactly as the player expects. Only the keys
 * a crouching player genuinely needs are claimed, which is the movement set
 * plus jump.
 */
const CTRL_GAME_KEYS = new Set([
  'ControlLeft', 'ControlRight',
  'KeyW', 'KeyA', 'KeyS', 'KeyD', 'Space', 'ShiftLeft', 'ShiftRight',
  'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight',
]);

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
  { action: 'mapOut', code: 'BracketLeft', label: 'Minimap zoom out', group: 'Actions' },
  { action: 'mapIn', code: 'BracketRight', label: 'Minimap zoom in', group: 'Actions' },
];

const BIND_STORAGE = 'aether-nexus:binds:v1';

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
    /** While the chat box has focus we swallow all gameplay input. */
    this._textCaptured = false;

    this._bind();
  }

  get locked() {
    return this._locked;
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

  setEnabled(on) {
    this._enabled = on;
    if (!on) {
      this._keys.clear();
      this._resetAxes();
    }
  }

  requestLock() {
    if (this._locked) return;
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
    if (!document.fullscreenElement && el.requestFullscreen) {
      Promise.resolve(el.requestFullscreen()).then(
        () => this._lockKeyboard(),
        () => {}
      );
    } else if (document.fullscreenElement) {
      this._lockKeyboard();
    }
  }

  exitLock() {
    if (this._locked) document.exitPointerLock?.();
    this._unlockKeyboard();
  }

  _resetAxes() {
    const s = this.state;
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
      /* Ctrl is a game key - it is crouch - and it used to be discarded here
       * along with everything pressed alongside it. That had two consequences:
       * Ctrl never actually worked as crouch, because the ControlLeft keydown
       * itself arrives with ctrlKey set and was dropped; and Ctrl+W went
       * straight to the browser. Ctrl now reaches the game, and the genuine
       * browser combinations are listed explicitly instead. */
      if (e.metaKey || e.altKey) return;
      if (e.ctrlKey && !CTRL_GAME_KEYS.has(e.code)) return;
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

    this.canvas.addEventListener('mousedown', (e) => {
      if (!this._enabled || this._textCaptured) return;
      if (!this._locked) {
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
  }

  _syncAxes() {
    const k = this._keys;
    const s = this.state;
    // `b` maps a shipped code to whatever the player put there. The arrow keys
    // and the right-hand modifiers stay as fixed alternates: they are not worth
    // a row in the rebinding panel, and losing them would be a regression for
    // anyone who uses them.
    const b = (code) => k.has(this._bindsInverse.get(code) ?? code);
    s.forward = (b('KeyW') || k.has('ArrowUp') ? 1 : 0) - (b('KeyS') || k.has('ArrowDown') ? 1 : 0);
    s.right = (b('KeyD') || k.has('ArrowRight') ? 1 : 0) - (b('KeyA') || k.has('ArrowLeft') ? 1 : 0);
    s.jump = b('Space');
    s.sprint = b('ShiftLeft') || k.has('ShiftRight');
    /* Held, on either key - and C is the one that actually works.
     *
     * Ctrl cannot carry this on its own: Ctrl+<key> is claimed before the page
     * sees it, by the browser for Ctrl+W and by the Windows input-method
     * switcher for Ctrl+Space, and Keyboard Lock has no authority over the
     * latter. So Ctrl crouches, but only reliably by itself.
     *
     * I briefly made Ctrl a *toggle* to sidestep that, which was wrong. Crouch
     * is not only a stance here - five systems read it as a momentary action:
     * dive, roll, let go of a wall, swim down, fly down. A latched crouch makes
     * a dive that never ends and a wall that cannot be held, because FreeClimb
     * releases the moment it sees the flag. The fix belongs on the *binding*,
     * not on the semantics: crouch stays a hold, and it lives on a key that is
     * not a modifier, so it composes with everything. */
    s.crouch = k.has('ControlLeft') || k.has('ControlRight') || b('KeyC');
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

  /* ================================================================== */
  /* Rebinding                                                          */
  /* ================================================================== */

  /** Current mapping as `{ action, code, label, group, bound }` rows. */
  get bindings() {
    return BINDABLE.map((d) => ({ ...d, bound: this._binds.get(d.code) ?? d.code }));
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
    // Keys the game cannot give up without breaking its own escape hatches.
    if (['Escape', 'F1', 'F2', 'F3', 'F4', 'F5', 'F9', 'Tab'].includes(code)) {
      return { ok: false };
    }
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
        if (typeof v === 'string' && v && v !== d.code) this._binds.set(d.code, v);
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
