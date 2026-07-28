import './audio.css';

/**
 * F4 audio options.
 *
 * Modelled on `HelpMenu` deliberately - same overlay behaviour, same capture-
 * phase key handling, same "build the markup once and toggle a class" rule -
 * because a second overlay that behaves differently from the first is a bug
 * report waiting to happen.
 *
 * Two things it does that the help panel does not:
 *
 * 1. **It does not pause.** Muting music mid-firefight is a thing players do,
 *    and a panel that stopped the world to let them do it would be worse than
 *    the problem. The sliders take effect live.
 * 2. **It unlocks audio.** Opening this panel is a user gesture, so it is a
 *    legitimate second chance to start the AudioContext for anyone whose first
 *    gesture was missed - which matters because a silent game with a working
 *    volume slider is the most confusing possible failure.
 */

function el(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
}

export class AudioMenu {
  /**
   * @param {{root:HTMLElement, bus:any, input:any,
   *          audio:import('../audio/AudioDirector.js').AudioDirector}} ctx
   */
  constructor({ root, bus, input, audio }) {
    this.bus = bus ?? null;
    this.input = input ?? null;
    this.audio = audio ?? null;
    this._open = false;

    this.el = this._build();
    root.appendChild(this.el);
    this._sync();

    this._onKey = (e) => {
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      if (e.code === 'F4') {
        e.preventDefault();
        if (this.input?.textCaptured) return;
        this.toggle();
      } else if (e.code === 'Escape' && this._open) {
        this.close();
      }
    };
    window.addEventListener('keydown', this._onKey, true);

    // Another system may change the settings (a future options preset, a save
    // load); keep the controls honest rather than assuming we are the only
    // writer.
    this._off = this.bus?.on('audio:changed', () => this._sync()) ?? null;
  }

  get isOpen() {
    return this._open;
  }

  /* ------------------------------------------------------------------ */

  _build() {
    const wrap = el('div', 'aud');
    const card = el('div', 'aud-card');

    const head = el('div', 'aud-head');
    const titles = el('div', 'aud-titles');
    titles.append(el('div', 'aud-kicker', 'Options'), el('div', 'aud-title', 'AUDIO'));
    const close = el('div', 'aud-close');
    close.append(el('b', null, 'F4'), el('span', null, 'or'), el('b', null, 'Esc'), el('span', null, 'to close'));
    head.append(titles, close);

    const body = el('div', 'aud-body');

    this.sfxToggle = this._toggleRow(
      'Sound effects', 'Weapons, footsteps, impacts, mounts',
      (on) => this.audio?.toggleSfx(on)
    );
    this.musicToggle = this._toggleRow(
      'Music', 'A generated score per world',
      (on) => this.audio?.toggleMusic(on)
    );
    body.append(this.sfxToggle.row, this.musicToggle.row);

    this.masterSlider = this._sliderRow('Master', (v) => this.audio?.setMasterVolume(v));
    this.sfxSlider = this._sliderRow('Effects', (v) => this.audio?.setSfxVolume(v));
    this.musicSlider = this._sliderRow('Music', (v) => this.audio?.setMusicVolume(v));
    body.append(this.masterSlider.row, this.sfxSlider.row, this.musicSlider.row);

    const foot = el(
      'div', 'aud-foot',
      'Every sound here is synthesised at runtime — there are no audio files in this project. '
      + 'Settings are remembered on this device.'
    );

    card.append(head, body, foot);
    wrap.appendChild(card);
    // Clicks inside the card must not fall through to the canvas, which would
    // request pointer lock and close the panel from under the player.
    card.addEventListener('mousedown', (e) => e.stopPropagation());
    card.addEventListener('click', (e) => e.stopPropagation());
    wrap.addEventListener('click', () => this.close());
    return wrap;
  }

  _toggleRow(label, hint, apply) {
    const row = el('div', 'aud-row aud-row-toggle');
    const info = el('div', 'aud-info');
    info.append(el('div', 'aud-label', label), el('div', 'aud-hint', hint));

    const btn = el('button', 'aud-switch');
    btn.type = 'button';
    btn.setAttribute('role', 'switch');
    btn.appendChild(el('span', 'aud-knob'));
    const state = el('span', 'aud-state', 'ON');
    btn.appendChild(state);

    btn.addEventListener('click', () => {
      const on = apply(undefined);
      this._sync();
      void on;
    });

    row.append(info, btn);
    return { row, btn, state };
  }

  _sliderRow(label, apply) {
    const row = el('div', 'aud-row');
    const info = el('div', 'aud-info');
    info.appendChild(el('div', 'aud-label', label));

    const input = document.createElement('input');
    input.type = 'range';
    input.className = 'aud-range';
    input.min = '0';
    input.max = '100';
    input.step = '1';

    const val = el('div', 'aud-val', '0%');
    input.addEventListener('input', () => {
      const v = Number(input.value) / 100;
      val.textContent = `${input.value}%`;
      apply(v);
    });

    row.append(info, input, val);
    return { row, input, val };
  }

  /** Push the engine's settings into the controls. */
  _sync() {
    const s = this.audio?.settings;
    if (!s) return;
    const setToggle = (t, on) => {
      t.btn.classList.toggle('on', !!on);
      t.btn.setAttribute('aria-checked', on ? 'true' : 'false');
      t.state.textContent = on ? 'ON' : 'OFF';
    };
    setToggle(this.sfxToggle, s.sfxOn);
    setToggle(this.musicToggle, s.musicOn);
    const setSlider = (r, v) => {
      r.input.value = String(Math.round(v * 100));
      r.val.textContent = `${Math.round(v * 100)}%`;
    };
    setSlider(this.masterSlider, s.master);
    setSlider(this.sfxSlider, s.sfx);
    setSlider(this.musicSlider, s.music);
  }

  /* ------------------------------------------------------------------ */

  open() {
    if (this._open) return;
    this._open = true;
    // Opening the panel is a gesture, so it is a valid place to start audio.
    this.audio?.engine?.unlock();
    this._sync();
    this.el.classList.add('on');
    this.input?.exitLock?.();
    this.bus?.emit('audio:menu', { open: true });
  }

  close() {
    if (!this._open) return;
    this._open = false;
    this.el.classList.remove('on');
    this.bus?.emit('audio:menu', { open: false });
  }

  toggle() {
    if (this._open) this.close();
    else this.open();
  }

  /** Present for symmetry with the other menus; nothing to tick. */
  update() {}

  dispose() {
    window.removeEventListener('keydown', this._onKey, true);
    this._off?.();
    this.el.remove();
  }
}

export default AudioMenu;
