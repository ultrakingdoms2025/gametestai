/**
 * Generative score, one per world.
 *
 * ── Why generated and not a loop ──────────────────────────────────────────
 * A looping track in an open world is a timer: the player learns its length
 * and starts hearing the seam instead of the music. These scores are written
 * as *rules* - a scale, a chord movement, a few voices with their own
 * probabilities - and played by a scheduler, so they never repeat exactly and
 * never seam. It also keeps the project's no-assets rule intact, and it means
 * a world's music is described in about fifteen lines rather than in a file
 * somebody has to license.
 *
 * ── The scheduler ─────────────────────────────────────────────────────────
 * Web Audio's clock is sample-accurate and JavaScript's is not, so notes are
 * scheduled *ahead* of the audio clock into a lookahead window and the timer
 * only decides what to queue next. This is the standard "tale of two clocks"
 * arrangement, and it is why the music does not stutter when the renderer has
 * a bad frame - which, in a game that compiles shaders, matters.
 *
 * Everything is deliberately sparse and low. Game music that sits in the same
 * band as gunfire and dialogue fights them; these scores live under 1 kHz and
 * leave the midrange to the effects.
 */

/** Seconds of music kept queued ahead of the audio clock. */
const LOOKAHEAD = 0.6;
/** How often the scheduler wakes to top that window up. */
const TICK_MS = 120;

/** Semitone offsets from the root, per scale. */
const SCALES = {
  minor: [0, 2, 3, 5, 7, 8, 10],
  dorian: [0, 2, 3, 5, 7, 9, 10],
  major: [0, 2, 4, 5, 7, 9, 11],
  lydian: [0, 2, 4, 6, 7, 9, 11],
  phrygian: [0, 1, 3, 5, 7, 8, 10],
};

/** midi -> Hz */
const hz = (m) => 440 * Math.pow(2, (m - 69) / 12);

/**
 * Per-world scores.
 *
 * `root` is a MIDI note, `chords` are scale-degree offsets walked in order,
 * and the voice flags decide which layers exist at all. Tempo is in seconds
 * per step, not BPM, because nothing here is percussive enough for BPM to be
 * the natural unit.
 */
const SCORES = {
  station: {
    root: 38, scale: 'minor', step: 0.75, chords: [0, 0, 5, 3],
    pad: { gain: 0.20, type: 'sawtooth', cutoff: 620 },
    // Cold, wide, slow: a pressurised hull at night.
    arp: { gain: 0.10, type: 'triangle', octave: 2, density: 0.42 },
    bass: { gain: 0.22, type: 'sine' },
    bell: { gain: 0.07, density: 0.10, octave: 3 },
  },
  medieval: {
    root: 33, scale: 'dorian', step: 0.92, chords: [0, 6, 4, 5],
    // Modal and open-fifthed - dorian is what stops it sounding like a lament.
    pad: { gain: 0.19, type: 'triangle', cutoff: 480 },
    arp: { gain: 0.09, type: 'sine', octave: 2, density: 0.3 },
    bass: { gain: 0.24, type: 'sine' },
    bell: { gain: 0.06, density: 0.08, octave: 2 },
  },
  citadel: {
    // Phrygian-flavoured: the flat second is the interval that reads as "east
    // of here" to a western ear without tipping into pastiche. Slow, wide and
    // mostly drone, because this world is climbed in silence and the score
    // should stay out of the way of the wind.
    root: 36, scale: 'phrygian', step: 1.05, chords: [0, 0, 3, 1],
    pad: { gain: 0.2, type: 'sawtooth', cutoff: 430 },
    arp: { gain: 0.085, type: 'triangle', octave: 3, density: 0.26 },
    bass: { gain: 0.26, type: 'sine' },
    bell: { gain: 0.075, density: 0.09, octave: 3 },
  },
  sports: {
    root: 40, scale: 'lydian', step: 0.5, chords: [0, 4, 5, 3],
    // Brighter, quicker, lighter on the bass: open air and daylight.
    pad: { gain: 0.15, type: 'triangle', cutoff: 900 },
    arp: { gain: 0.12, type: 'triangle', octave: 3, density: 0.55 },
    bass: { gain: 0.16, type: 'sine' },
    bell: { gain: 0.08, density: 0.16, octave: 3 },
  },
};

export class Music {
  /** @param {import('./AudioEngine.js').AudioEngine} engine */
  constructor(engine) {
    this.engine = engine;
    this.worldId = null;
    this.score = null;

    this._timer = null;
    this._next = 0;
    this._step = 0;
    /** Per-world output gain, so a world change can cross-fade. */
    this._out = null;
  }

  /** @returns {boolean} */
  get playing() {
    return this._timer !== null;
  }

  /**
   * Switch to a world's score, cross-fading out of whatever was playing.
   * @param {string|null} worldId
   */
  setWorld(worldId) {
    if (worldId === this.worldId) return;
    this.worldId = worldId ?? null;
    const score = SCORES[worldId] ?? null;
    this._fadeOut();
    this.score = score;
    if (score && this.engine.ready) this.start();
  }

  start() {
    if (!this.engine.ready || !this.score || this._timer) return;
    const ctx = this.engine.ctx;
    this._out = ctx.createGain();
    this._out.gain.setValueAtTime(0.0001, ctx.currentTime);
    this._out.gain.exponentialRampToValueAtTime(1, ctx.currentTime + 2.5);
    this._out.connect(this.engine.musicBus);

    this._next = ctx.currentTime + 0.15;
    this._step = 0;
    this._timer = setInterval(() => this._schedule(), TICK_MS);
  }

  stop() {
    this._fadeOut();
  }

  _fadeOut() {
    if (this._timer) {
      clearInterval(this._timer);
      this._timer = null;
    }
    const out = this._out;
    this._out = null;
    if (!out || !this.engine.ctx) return;
    const now = this.engine.ctx.currentTime;
    try {
      out.gain.cancelScheduledValues(now);
      out.gain.setValueAtTime(Math.max(out.gain.value, 0.0001), now);
      out.gain.exponentialRampToValueAtTime(0.0001, now + 1.6);
      setTimeout(() => { try { out.disconnect(); } catch { /* gone */ } }, 2200);
    } catch { /* context torn down */ }
  }

  /**
   * Queue every step that falls inside the lookahead window.
   *
   * The loop is `while` rather than `if` on purpose: after a long frame the
   * window can contain several steps, and scheduling only one would let the
   * music fall progressively behind the audio clock.
   */
  _schedule() {
    const eng = this.engine;
    if (!eng.ready || !this.score || !this._out) return;
    const ctx = eng.ctx;
    const s = this.score;
    let guard = 0;
    while (this._next < ctx.currentTime + LOOKAHEAD && guard++ < 32) {
      this._emit(this._next, this._step);
      this._next += s.step;
      this._step++;
    }
  }

  _emit(time, step) {
    const s = this.score;
    const scale = SCALES[s.scale] ?? SCALES.minor;
    const bar = Math.floor(step / 4) % s.chords.length;
    const degree = s.chords[bar];
    const rootNote = s.root + scale[degree % scale.length] + 12 * Math.floor(degree / scale.length);

    // Pad: held triad, re-struck once per bar. The long attack is what keeps
    // it behind everything else instead of announcing each change.
    if (s.pad && step % 4 === 0) {
      for (const off of [0, 3, 7]) {
        this._note(time, hz(rootNote + off), s.step * 4.6, s.pad.gain / 3, s.pad.type, s.pad.cutoff);
      }
    }

    // Bass: root on the bar, fifth on the half.
    if (s.bass) {
      if (step % 4 === 0) this._note(time, hz(rootNote - 12), s.step * 1.8, s.bass.gain, s.bass.type, 240);
      else if (step % 4 === 2) this._note(time, hz(rootNote - 5), s.step * 1.2, s.bass.gain * 0.6, s.bass.type, 240);
    }

    // Arp: a wandering scale walk, present only some of the time so it reads
    // as a motif surfacing rather than as a sequence running.
    if (s.arp && this._rand(step * 7) < s.arp.density) {
      const idx = Math.floor(this._rand(step * 13) * scale.length);
      const note = rootNote + scale[idx] + 12 * s.arp.octave;
      this._note(time, hz(note), s.step * 1.1, s.arp.gain, s.arp.type, 2600);
    }

    // Bell: rare, high, long. The one thing allowed above 1 kHz.
    if (s.bell && this._rand(step * 29 + 5) < s.bell.density) {
      const idx = Math.floor(this._rand(step * 31) * scale.length);
      const note = rootNote + scale[idx] + 12 * s.bell.octave;
      this._note(time, hz(note), 3.2, s.bell.gain, 'sine', 5000, 0.9);
    }
  }

  /** Deterministic per-step noise, so a score is repeatable but not periodic. */
  _rand(n) {
    const x = Math.sin(n * 12.9898 + (this.worldId?.length ?? 3) * 78.233) * 43758.5453;
    return x - Math.floor(x);
  }

  /** One enveloped, filtered voice into the world's music gain. */
  _note(time, freq, dur, gain, type = 'sine', cutoff = 1200, reverb = 0.35) {
    const eng = this.engine;
    const ctx = eng.ctx;
    if (!ctx || !this._out) return;

    const osc = ctx.createOscillator();
    osc.type = type;
    osc.frequency.value = freq;
    // A few cents of drift stops stacked voices phasing into a single tone.
    osc.detune.value = (this._rand(freq) - 0.5) * 9;

    const filt = ctx.createBiquadFilter();
    filt.type = 'lowpass';
    filt.frequency.value = cutoff;
    filt.Q.value = 0.6;

    const env = ctx.createGain();
    const attack = Math.min(0.6, dur * 0.35);
    env.gain.setValueAtTime(0.0001, time);
    env.gain.exponentialRampToValueAtTime(gain, time + attack);
    env.gain.exponentialRampToValueAtTime(0.0001, time + dur);

    osc.connect(filt);
    filt.connect(env);
    env.connect(this._out);

    if (reverb > 0 && eng.reverbSend) {
      const send = ctx.createGain();
      send.gain.value = reverb;
      env.connect(send);
      send.connect(eng.reverbSend);
    }

    osc.start(time);
    osc.stop(time + dur + 0.05);
  }

  dispose() {
    this._fadeOut();
  }
}

export default Music;
