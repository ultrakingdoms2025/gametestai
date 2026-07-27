import { CONFIG } from './Config.js';

/**
 * Keyboard + mouse input with pointer-lock capture.
 *
 * Exposes an immediate-mode snapshot (`state`) that gameplay code samples each
 * frame, plus edge-triggered helpers (`pressed`) that consume a keypress so a
 * single tap cannot fire twice.
 */
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
    if (!this._locked) this.canvas.requestPointerLock?.();
  }

  exitLock() {
    if (this._locked) document.exitPointerLock?.();
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

  _bind() {
    const onKey = (e, down) => {
      // Never steal browser shortcuts.
      if (e.ctrlKey || e.metaKey || e.altKey) return;
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
    s.forward = (k.has('KeyW') || k.has('ArrowUp') ? 1 : 0) - (k.has('KeyS') || k.has('ArrowDown') ? 1 : 0);
    s.right = (k.has('KeyD') || k.has('ArrowRight') ? 1 : 0) - (k.has('KeyA') || k.has('ArrowLeft') ? 1 : 0);
    s.jump = k.has('Space');
    s.sprint = k.has('ShiftLeft') || k.has('ShiftRight');
    s.crouch = k.has('ControlLeft') || k.has('KeyC');
    s.reload = k.has('KeyR');
    s.interact = k.has('KeyE');
  }

  /** Edge-trigger: true exactly once per physical keypress. */
  pressed(code) {
    return this._pressedThisFrame.has(code);
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
