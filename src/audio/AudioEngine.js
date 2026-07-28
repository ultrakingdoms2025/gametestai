/**
 * The mixer: buses, volumes, persistence, and the positional model.
 *
 * ── Why there is not a single audio file in this project ──────────────────
 * Every texture, every material and every mesh in this game is generated in
 * code. Audio follows the same rule, and for the same reasons: nothing to
 * download, nothing to license, nothing to keep in sync with the art, and a
 * gunshot that can be *tuned* rather than replaced. So there is no `assets/`
 * directory here either - a dragon's roar is a filtered noise growl with a
 * formant stack on it, built at the moment it is heard.
 *
 * ── The three things this class exists to get right ───────────────────────
 *
 * 1. **Autoplay.** Browsers refuse to start an AudioContext outside a user
 *    gesture, and a context created too early is born `suspended` and stays
 *    that way silently. The context is therefore created lazily on the first
 *    real gesture and `resume()`d on every subsequent one, which is why
 *    `unlock()` is safe to call as often as you like.
 *
 * 2. **Buses.** Music and effects need independent volume and independent
 *    muting, so everything routes through one of two gain nodes into a master.
 *    Ramps are always scheduled rather than assigned - writing `.value` on a
 *    live AudioParam clicks.
 *
 * 3. **Position.** A full HRTF `PannerNode` per shot is expensive and, for a
 *    game whose listener is a first-person camera, mostly wasted. Distance
 *    gain plus a stereo pan derived from the angle off the camera's right
 *    vector reproduces everything the player actually perceives here, at a
 *    fraction of the cost, and degrades gracefully when a browser has no
 *    `StereoPannerNode`.
 */

const STORAGE_KEY = 'aether.audio.v1';

/** Defaults, overridden by whatever is in localStorage. */
const DEFAULTS = {
  master: 0.85,
  music: 0.45,
  sfx: 0.8,
  musicOn: true,
  sfxOn: true,
};

/** Beyond this a sound is inaudible and is not scheduled at all. */
export const MAX_AUDIBLE = 90;
/** Inside this radius there is no distance attenuation. */
const NEAR_FIELD = 3;

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);

export class AudioEngine {
  constructor() {
    /** @type {AudioContext|null} */
    this.ctx = null;
    this.ready = false;
    this.settings = { ...DEFAULTS, ...this._load() };

    /** Listener frame, refreshed every frame by the director. */
    this._lp = { x: 0, y: 0, z: 0 };
    this._right = { x: 1, y: 0, z: 0 };
    this._fwd = { x: 0, y: 0, z: -1 };

    /** Voices playing right now, for the cap and for teardown. */
    this._voices = 0;
    this._maxVoices = 24;
  }

  /* ------------------------------------------------------------------ */
  /* Lifecycle                                                           */
  /* ------------------------------------------------------------------ */

  /**
   * Create or resume the context. Must be called from inside a user gesture
   * the first time; safe and cheap on every call after that.
   * @returns {boolean} true when the context is running
   */
  unlock() {
    if (!this.ctx) {
      const AC = globalThis.AudioContext || globalThis.webkitAudioContext;
      if (!AC) return false;
      try {
        this.ctx = new AC({ latencyHint: 'interactive' });
      } catch (err) {
        console.warn('[Audio] no AudioContext:', err);
        return false;
      }
      this._buildGraph();
    }
    if (this.ctx.state === 'suspended') this.ctx.resume().catch(() => {});
    this.ready = this.ctx.state === 'running';
    return this.ready;
  }

  _buildGraph() {
    const ctx = this.ctx;
    this.master = ctx.createGain();
    this.master.gain.value = this.settings.master;

    // A gentle limiter on the master. Twenty overlapping gunshots will
    // otherwise clip the output hard, and clipping through a synthesised mix
    // sounds like a fault rather than like loudness.
    this.limiter = ctx.createDynamicsCompressor();
    this.limiter.threshold.value = -8;
    this.limiter.knee.value = 6;
    this.limiter.ratio.value = 12;
    this.limiter.attack.value = 0.003;
    this.limiter.release.value = 0.18;

    this.musicBus = ctx.createGain();
    this.musicBus.gain.value = this.settings.musicOn ? this.settings.music : 0;

    this.sfxBus = ctx.createGain();
    this.sfxBus.gain.value = this.settings.sfxOn ? this.settings.sfx : 0;

    /* A shared plate-ish reverb, fed from a send. Built from synthesised noise
     * rather than an impulse file - exponentially decaying, slightly darker in
     * the tail, which is all a small space needs to stop every effect sounding
     * like it was recorded in a vacuum. */
    this.reverb = ctx.createConvolver();
    this.reverb.buffer = this._makeImpulse(1.9, 2.6);
    this.reverbSend = ctx.createGain();
    this.reverbSend.gain.value = 0.16;
    this.reverbReturn = ctx.createGain();
    this.reverbReturn.gain.value = 0.9;

    this.reverbSend.connect(this.reverb);
    this.reverb.connect(this.reverbReturn);
    this.reverbReturn.connect(this.master);

    this.musicBus.connect(this.master);
    this.sfxBus.connect(this.master);
    this.master.connect(this.limiter);
    this.limiter.connect(ctx.destination);
  }

  /** Exponentially decaying stereo noise: a room, without a room recording. */
  _makeImpulse(seconds, decay) {
    const ctx = this.ctx;
    const rate = ctx.sampleRate;
    const len = Math.max(1, Math.floor(rate * seconds));
    const buf = ctx.createBuffer(2, len, rate);
    for (let c = 0; c < 2; c++) {
      const data = buf.getChannelData(c);
      let lp = 0;
      for (let i = 0; i < len; i++) {
        const t = i / len;
        const env = Math.pow(1 - t, decay);
        // One-pole lowpass on the noise so the tail darkens as it decays,
        // which is what stops a synthetic reverb hissing.
        lp += ((Math.random() * 2 - 1) - lp) * (0.35 - 0.25 * t);
        data[i] = lp * env;
      }
    }
    return buf;
  }

  /* ------------------------------------------------------------------ */
  /* Settings                                                            */
  /* ------------------------------------------------------------------ */

  _load() {
    try {
      const raw = globalThis.localStorage?.getItem(STORAGE_KEY);
      return raw ? JSON.parse(raw) : {};
    } catch {
      return {};
    }
  }

  _save() {
    try {
      globalThis.localStorage?.setItem(STORAGE_KEY, JSON.stringify(this.settings));
    } catch { /* private mode: settings simply do not persist */ }
  }

  /** Ramp a bus gain without clicking. */
  _ramp(param, value, time = 0.08) {
    if (!this.ctx) return;
    const now = this.ctx.currentTime;
    param.cancelScheduledValues(now);
    param.setValueAtTime(param.value, now);
    param.linearRampToValueAtTime(value, now + time);
  }

  setMaster(v) {
    this.settings.master = clamp01(v);
    if (this.master) this._ramp(this.master.gain, this.settings.master);
    this._save();
  }

  setMusicVolume(v) {
    this.settings.music = clamp01(v);
    if (this.musicBus) this._ramp(this.musicBus.gain, this.settings.musicOn ? this.settings.music : 0);
    this._save();
  }

  setSfxVolume(v) {
    this.settings.sfx = clamp01(v);
    if (this.sfxBus) this._ramp(this.sfxBus.gain, this.settings.sfxOn ? this.settings.sfx : 0);
    this._save();
  }

  /** @param {boolean} [on] omit to toggle */
  toggleMusic(on) {
    this.settings.musicOn = on === undefined ? !this.settings.musicOn : !!on;
    if (this.musicBus) {
      // Slower than the effects ramp: music cutting dead in 80 ms reads as a
      // dropout, where a third of a second reads as a fade.
      this._ramp(this.musicBus.gain, this.settings.musicOn ? this.settings.music : 0, 0.35);
    }
    this._save();
    return this.settings.musicOn;
  }

  /** @param {boolean} [on] omit to toggle */
  toggleSfx(on) {
    this.settings.sfxOn = on === undefined ? !this.settings.sfxOn : !!on;
    if (this.sfxBus) this._ramp(this.sfxBus.gain, this.settings.sfxOn ? this.settings.sfx : 0);
    this._save();
    return this.settings.sfxOn;
  }

  /* ------------------------------------------------------------------ */
  /* Listener + positioning                                              */
  /* ------------------------------------------------------------------ */

  /**
   * Tell the mixer where the ears are. Called once per frame.
   * @param {{x:number,y:number,z:number}} pos
   * @param {{x:number,y:number,z:number}} right camera right vector
   * @param {{x:number,y:number,z:number}} forward camera forward vector
   */
  setListener(pos, right, forward) {
    this._lp.x = pos.x; this._lp.y = pos.y; this._lp.z = pos.z;
    this._right.x = right.x; this._right.y = right.y; this._right.z = right.z;
    this._fwd.x = forward.x; this._fwd.y = forward.y; this._fwd.z = forward.z;
  }

  /**
   * Distance gain and stereo pan for a world position.
   * @param {{x:number,y:number,z:number}|null} at null for a 2D sound
   * @returns {{gain:number, pan:number, distance:number}}
   */
  spatial(at) {
    if (!at) return { gain: 1, pan: 0, distance: 0 };
    const dx = at.x - this._lp.x;
    const dy = at.y - this._lp.y;
    const dz = at.z - this._lp.z;
    const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
    if (dist >= MAX_AUDIBLE) return { gain: 0, pan: 0, distance: dist };

    // Inverse-ish rolloff with a near-field plateau, then a linear fade to
    // silence at the cutoff so nothing ever winks out mid-tail.
    const d = Math.max(dist, NEAR_FIELD);
    let gain = NEAR_FIELD / d;
    gain *= 1 - dist / MAX_AUDIBLE;

    // Pan is the component along the camera's right vector. Softened to 0.85
    // because hard-panned mono sources are exhausting over a long session.
    const inv = dist > 1e-4 ? 1 / dist : 0;
    const pan = dist < NEAR_FIELD
      ? 0
      : clampPan((dx * this._right.x + dy * this._right.y + dz * this._right.z) * inv * 0.85);

    return { gain, pan, distance: dist };
  }

  /* ------------------------------------------------------------------ */
  /* Voice plumbing                                                      */
  /* ------------------------------------------------------------------ */

  /** @returns {number} context time, or 0 when there is no context */
  get now() {
    return this.ctx ? this.ctx.currentTime : 0;
  }

  /**
   * A per-voice output chain: gain -> pan -> sfx bus (+ reverb send).
   *
   * Returns null when audio is off, the sound is out of range, or the voice
   * budget is spent - callers treat null as "do not build the voice", which is
   * what keeps a firefight from allocating fifty oscillators a second.
   *
   * @param {{x:number,y:number,z:number}|null} at
   * @param {number} volume 0..1 pre-distance
   * @param {number} [reverbAmount] 0..1 send level
   * @returns {{input:GainNode, gain:number, distance:number}|null}
   */
  voice(at, volume = 1, reverbAmount = 1) {
    if (!this.ready || !this.settings.sfxOn) return null;
    if (this._voices >= this._maxVoices) return null;
    const s = this.spatial(at);
    if (s.gain <= 0.0015) return null;

    const ctx = this.ctx;
    const g = ctx.createGain();
    g.gain.value = s.gain * volume;

    let tail = g;
    if (ctx.createStereoPanner) {
      const p = ctx.createStereoPanner();
      p.pan.value = s.pan;
      g.connect(p);
      tail = p;
    }
    tail.connect(this.sfxBus);
    if (reverbAmount > 0) {
      const send = ctx.createGain();
      // Distant sources are proportionally wetter, which is most of what sells
      // distance once the direct gain has already fallen off.
      send.gain.value = reverbAmount * (0.25 + 0.75 * Math.min(1, s.distance / 40));
      tail.connect(send);
      send.connect(this.reverbSend);
    }

    this._voices++;
    return { input: g, gain: s.gain * volume, distance: s.distance };
  }

  /** Book-keeping so the voice cap is real. Call when a voice's tail ends. */
  release(seconds = 0) {
    if (seconds <= 0) {
      this._voices = Math.max(0, this._voices - 1);
      return;
    }
    setTimeout(() => { this._voices = Math.max(0, this._voices - 1); }, seconds * 1000);
  }

  /** White noise buffer, cached by length. Noise is the basis of most of these. */
  noiseBuffer(seconds = 1) {
    if (!this.ctx) return null;
    this._noiseCache ??= new Map();
    const key = Math.round(seconds * 100);
    const hit = this._noiseCache.get(key);
    if (hit) return hit;
    const len = Math.max(1, Math.floor(this.ctx.sampleRate * seconds));
    const buf = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
    this._noiseCache.set(key, buf);
    return buf;
  }

  dispose() {
    try { this.ctx?.close(); } catch { /* already closed */ }
    this.ctx = null;
    this.ready = false;
  }
}

function clampPan(v) {
  return v < -1 ? -1 : v > 1 ? 1 : v;
}

export default AudioEngine;
