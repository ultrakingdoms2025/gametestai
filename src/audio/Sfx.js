/**
 * Sound design, as DSP.
 *
 * Every effect here is built from the same four primitives - a noise burst, a
 * pitched oscillator, a filter with an envelope on its cutoff, and a decay
 * curve - because that is genuinely how these sounds are put together. A
 * gunshot is a wideband crack with a short resonant body under it. A sword
 * swing is filtered noise whose centre frequency sweeps with the arc. A
 * dragon's roar is a noise growl with a formant stack and a slow pitch fall.
 * Naming the parts is most of the work; the synthesis is the easy half.
 *
 * ── Rules the whole file follows ──────────────────────────────────────────
 * - Nothing is allocated until a sound is actually audible: `engine.voice()`
 *   returns null when the mixer is off, out of range or out of voices, and
 *   every recipe bails on that before it builds a single node.
 * - Every node is started and stopped with an explicit time, and every voice
 *   tells the engine when its tail ends. Web Audio nodes are single-use and a
 *   voice that never reports back leaks a slot in the budget forever.
 * - Randomised detail is deliberate and bounded. Real repeated sounds are
 *   never identical, and a perfectly identical gunshot at 720 rpm turns into a
 *   buzzing tone through sheer phase coherence.
 */

const rnd = (a, b) => a + Math.random() * (b - a);

/** Exponential decay to (near) zero. `setTargetAtTime` would never reach it. */
function decay(param, from, seconds, ctx, floor = 0.0001) {
  const t = ctx.currentTime;
  param.cancelScheduledValues(t);
  param.setValueAtTime(from, t);
  param.exponentialRampToValueAtTime(floor, t + seconds);
}

export class Sfx {
  /** @param {import('./AudioEngine.js').AudioEngine} engine */
  constructor(engine) {
    this.engine = engine;
    /** Rate limiter, per sound id, so a stuck emitter cannot machine-gun. */
    this._last = new Map();
  }

  /** True when this id fired too recently to fire again. */
  _throttled(id, minGap) {
    const now = this.engine.now;
    const prev = this._last.get(id) ?? -1;
    if (now - prev < minGap) return true;
    this._last.set(id, now);
    return false;
  }

  /** Shorthand: a noise source through a filter, enveloped.
   * `rate` slows the noise itself - at 0.4 white noise turns granular, which
   * is what wood creak and dragging stone are made of. `delay` offsets the
   * whole burst, for recipes made of several transients in sequence. */
  _noise(v, { seconds, type = 'bandpass', freq = 1000, q = 1, sweepTo = null, gain = 1, delay = 0, rate = 1 }) {
    const ctx = this.engine.ctx;
    const src = ctx.createBufferSource();
    src.buffer = this.engine.noiseBuffer(Math.max(0.25, seconds));
    if (rate !== 1) src.playbackRate.value = rate;
    const filt = ctx.createBiquadFilter();
    filt.type = type;
    filt.Q.value = q;
    const t = ctx.currentTime + delay;
    filt.frequency.setValueAtTime(freq, t);
    if (sweepTo !== null) {
      filt.frequency.exponentialRampToValueAtTime(Math.max(20, sweepTo), t + seconds);
    }
    const env = ctx.createGain();
    if (delay > 0) {
      // decay() anchors to `now`; a delayed burst must hold silent until t.
      env.gain.setValueAtTime(0.0001, ctx.currentTime);
      env.gain.setValueAtTime(gain, t);
      env.gain.exponentialRampToValueAtTime(0.0001, t + seconds);
    } else {
      decay(env.gain, gain, seconds, ctx);
    }
    src.connect(filt);
    filt.connect(env);
    env.connect(v.input);
    src.start(t);
    src.stop(t + seconds + 0.02);
    return { src, filt, env };
  }

  /** Shorthand: a pitched oscillator with a pitch fall and a decay. */
  _tone(v, { seconds, type = 'sine', freq, toFreq = null, gain = 1, delay = 0 }) {
    const ctx = this.engine.ctx;
    const osc = ctx.createOscillator();
    osc.type = type;
    const t = ctx.currentTime + delay;
    osc.frequency.setValueAtTime(freq, t);
    if (toFreq !== null) osc.frequency.exponentialRampToValueAtTime(Math.max(20, toFreq), t + seconds);
    const env = ctx.createGain();
    env.gain.setValueAtTime(0.0001, t);
    env.gain.exponentialRampToValueAtTime(gain, t + 0.004);
    env.gain.exponentialRampToValueAtTime(0.0001, t + seconds);
    osc.connect(env);
    env.connect(v.input);
    osc.start(t);
    osc.stop(t + seconds + 0.02);
    return { osc, env };
  }

  /** A tanh waveshaper of drive `k` - the cheapest thing that reads as a
   * throat (or a flame) rather than as an oscillator. */
  _shaper(k) {
    const sh = this.engine.ctx.createWaveShaper();
    const n = 512;
    const curve = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const x = (i / (n - 1)) * 2 - 1;
      curve[i] = Math.tanh(k * x) / Math.tanh(k);
    }
    sh.curve = curve;
    return sh;
  }

  /* ================================================================== */
  /* Weapons                                                             */
  /* ================================================================== */

  /**
   * Shotgun blast: a wide crack, twin low slams, and a long rolling tail.
   *
   * The crack carries the transient; the two staggered low bodies are the
   * chest punch - one slam reads as a rifle, two a hair apart read as a bore
   * full of shot leaving together. The bandpass tail is the report rolling
   * off the walls, and it is most of what makes the shot feel *large*.
   */
  gunshot(at, { volume = 1 } = {}) {
    const v = this.engine.voice(at, 0.6 * volume, 0.75);
    if (!v) return;
    this._noise(v, { seconds: 0.05, type: 'highpass', freq: 600, q: 0.7, gain: 0.8 });
    this._tone(v, { seconds: 0.15, type: 'triangle', freq: rnd(100, 122), toFreq: 40, gain: 0.7 });
    this._tone(v, { seconds: 0.16, type: 'sine', freq: rnd(88, 100), toFreq: 42, gain: 0.6, delay: 0.02 });
    this._noise(v, { seconds: 0.6, type: 'bandpass', freq: 420, q: 0.7, sweepTo: 180, gain: 0.4 });
    this.engine.release(0.8);
  }

  /** Dry click: the trigger falling on an empty chamber. */
  dryFire(at) {
    if (this._throttled('dry', 0.18)) return;
    const v = this.engine.voice(at, 0.4, 0.2);
    if (!v) return;
    this._noise(v, { seconds: 0.035, type: 'highpass', freq: 2600, q: 1, gain: 0.7 });
    this.engine.release(0.1);
  }

  /** Magazine out, magazine in, bolt home - three transients, not one. */
  reload(at) {
    const v = this.engine.voice(at, 0.42, 0.35);
    if (!v) return;
    this._noise(v, { seconds: 0.06, type: 'bandpass', freq: 900, q: 2, gain: 0.6 });
    this._tone(v, { seconds: 0.05, type: 'square', freq: 340, toFreq: 180, gain: 0.12, delay: 0.22 });
    this._noise(v, { seconds: 0.07, type: 'bandpass', freq: 1400, q: 3, gain: 0.5 });
    this._tone(v, { seconds: 0.06, type: 'square', freq: 520, toFreq: 240, gain: 0.15, delay: 0.55 });
    this.engine.release(0.9);
  }

  /**
   * Broadsword swing: a wide band sweeping *up* through the arc, with a low
   * push of air underneath.
   *
   * The rising sweep is the blade accelerating - down reads as something
   * passing you, up reads as something *you* are swinging. The low tone is
   * the mass; without it the arc is a wand, not a broadsword.
   */
  swordSwing(at) {
    const v = this.engine.voice(at, 0.55, 0.5);
    if (!v) return;
    this._noise(v, { seconds: 0.2, type: 'bandpass', freq: rnd(280, 340), q: 1.6, sweepTo: 1900, gain: 0.55 });
    this._tone(v, { seconds: 0.14, type: 'sine', freq: 150, toFreq: 90, gain: 0.3 });
    this.engine.release(0.35);
  }

  /** Steel on steel: inharmonic partials, which is what makes metal metallic. */
  swordHit(at, { hard = true } = {}) {
    const v = this.engine.voice(at, 0.6, 0.9);
    if (!v) return;
    const base = hard ? rnd(1900, 2400) : rnd(900, 1200);
    // Deliberately non-integer ratios: an integer stack would sound like a bell
    // being played, not like a blade being hit.
    for (const [mult, g, dur] of [[1, 0.5, 0.5], [2.37, 0.3, 0.36], [3.71, 0.18, 0.26], [5.13, 0.1, 0.18]]) {
      this._tone(v, { seconds: dur, type: 'sine', freq: base * mult, gain: g });
    }
    this._noise(v, { seconds: 0.07, type: 'highpass', freq: 3200, gain: 0.5 });
    this.engine.release(0.6);
  }

  /**
   * Longbow release: a deep string twang that *rings*, an octave under it,
   * and the arrow's hiss climbing away.
   *
   * The long triangle at ~140 Hz is a heavy string still vibrating after the
   * arrow has gone - the sound archers actually hear. The rising highpass is
   * the fletching leaving; it goes up because the arrow is departing.
   */
  bowRelease(at) {
    const v = this.engine.voice(at, 0.55, 0.6);
    if (!v) return;
    this._tone(v, { seconds: 0.45, type: 'triangle', freq: rnd(135, 148), toFreq: 132, gain: 0.5 });
    this._tone(v, { seconds: 0.3, type: 'sine', freq: 70, gain: 0.3 });
    this._noise(v, { seconds: 0.14, type: 'highpass', freq: 1400, sweepTo: 4200, gain: 0.35 });
    this.engine.release(0.55);
  }

  /** The draw: wood limbs creaking under load. The slowed noise is what
   * turns a filtered hiss into grain - fibre slipping against fibre. */
  bowDraw(at) {
    if (this._throttled('bowDraw', 0.4)) return;
    const v = this.engine.voice(at, 0.5, 0.3);
    if (!v) return;
    this._noise(v, { seconds: 0.35, type: 'bandpass', freq: 620, q: 5, sweepTo: 700, gain: 0.8, rate: 0.35 });
    this.engine.release(0.5);
  }

  /** Ember charge: a rising, slightly unstable tone with noise crackle. */
  fireballCharge(at) {
    if (this._throttled('fbCharge', 0.5)) return;
    const v = this.engine.voice(at, 0.35, 0.5);
    if (!v) return;
    this._tone(v, { seconds: 0.7, type: 'sawtooth', freq: 90, toFreq: 320, gain: 0.22 });
    this._noise(v, { seconds: 0.7, type: 'bandpass', freq: 900, q: 1.2, sweepTo: 2600, gain: 0.2 });
    this.engine.release(0.85);
  }

  /**
   * Hellfire cast: driven flame noise howling down, an almost-vocal throat
   * tone inside it, sub pressure underneath, and embers in the tail.
   *
   * The waveshaper is what separates this from a whoosh - clipped noise has
   * the crackle-density of real combustion, and the falling sawtooth through
   * the same register puts a *voice* in the flame.
   */
  fireballCast(at) {
    const v = this.engine.voice(at, 0.65, 0.85);
    if (!v) return;
    const ctx = this.engine.ctx;
    const t = ctx.currentTime;
    const dur = 1.0;
    // The flame: slowed noise, hard-driven, swept from bright to smothered.
    const src = ctx.createBufferSource();
    src.buffer = this.engine.noiseBuffer(1.2);
    src.playbackRate.value = 0.7;
    const sh = this._shaper(9);
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.setValueAtTime(2400, t);
    lp.frequency.exponentialRampToValueAtTime(300, t + dur);
    const env = ctx.createGain();
    decay(env.gain, 0.55, dur, ctx);
    src.connect(sh); sh.connect(lp); lp.connect(env); env.connect(v.input);
    src.start(t);
    src.stop(t + dur + 0.05);
    // The throat: a falling voice inside the fire.
    this._tone(v, { seconds: dur * 0.7, type: 'sawtooth', freq: 300, toFreq: 120, gain: 0.22 });
    // The pressure.
    this._tone(v, { seconds: dur, type: 'sine', freq: 75, toFreq: 45, gain: 0.4 });
    // Embers spitting off in the tail.
    for (let i = 0; i < 10; i++) {
      this._noise(v, { seconds: 0.02, type: 'bandpass', freq: 2800 * rnd(0.7, 1.4), q: 3,
        gain: rnd(0.06, 0.14), delay: 0.1 + Math.random() * 0.75 });
    }
    this.engine.release(dur + 0.2);
  }

  /** Detonation: sub drop, broadband body, and a debris tail. */
  explosion(at, { size = 1 } = {}) {
    const v = this.engine.voice(at, 0.85, 1);
    if (!v) return;
    const len = 0.6 + 0.5 * size;
    this._tone(v, { seconds: len, type: 'sine', freq: 90 * size, toFreq: 28, gain: 0.8 });
    this._noise(v, { seconds: len * 0.7, type: 'lowpass', freq: 1800, sweepTo: 160, gain: 0.7 });
    this._noise(v, { seconds: len, type: 'highpass', freq: 900, sweepTo: 3000, gain: 0.12 });
    this.engine.release(len + 0.3);
  }

  /* ================================================================== */
  /* Impacts, damage, world                                              */
  /* ================================================================== */

  /**
   * Bullet impact, coloured by what was hit. The material *is* the filter
   * setting - that is genuinely the difference between hitting stone and
   * hitting sheet metal.
   */
  impact(at, surface = 'concrete') {
    if (this._throttled(`imp${surface}`, 0.03)) return;
    const v = this.engine.voice(at, 0.55, 0.8);
    if (!v) return;
    /* `lift` compensates the band. A bandpass at 380 Hz passes a fraction of
     * the energy that one at 2.6 kHz does, so a flat gain across the palette
     * made every soft surface effectively silent - dirt measured at twice the
     * noise floor while metal measured at twenty times it. */
    const S = {
      metal: { freq: 2600, q: 3, sec: 0.22, ring: 3100, lift: 1.0 },
      stone: { freq: 1300, q: 1.4, sec: 0.13, ring: 0, lift: 1.3 },
      concrete: { freq: 1100, q: 1.2, sec: 0.14, ring: 0, lift: 1.4 },
      wood: { freq: 800, q: 1.8, sec: 0.12, ring: 420, lift: 1.7 },
      glass: { freq: 4200, q: 2.5, sec: 0.3, ring: 5200, lift: 0.9 },
      dirt: { freq: 380, q: 0.9, sec: 0.13, ring: 0, lift: 2.6 },
      snow: { freq: 600, q: 0.7, sec: 0.1, ring: 0, lift: 2.1 },
      water: { freq: 900, q: 0.8, sec: 0.22, ring: 0, lift: 1.6 },
      flesh: { freq: 260, q: 1.1, sec: 0.11, ring: 0, lift: 2.8 },
      soft: { freq: 300, q: 1, sec: 0.12, ring: 0, lift: 2.6 },
    }[surface] ?? { freq: 1100, q: 1.2, sec: 0.14, ring: 0, lift: 1.4 };

    this._noise(v, {
      seconds: S.sec, type: 'bandpass', freq: S.freq, q: S.q,
      sweepTo: S.freq * 0.35, gain: 0.6 * S.lift,
    });
    if (S.ring) this._tone(v, { seconds: S.sec * 1.6, type: 'sine', freq: S.ring * rnd(0.95, 1.05), gain: 0.16 });
    this.engine.release(S.sec + 0.3);
  }

  /** Taking damage: a dull thud plus a brief tinnitus-ish ring. */
  playerHurt() {
    if (this._throttled('hurt', 0.25)) return;
    const v = this.engine.voice(null, 0.5, 0.2);
    if (!v) return;
    this._tone(v, { seconds: 0.3, type: 'sine', freq: 160, toFreq: 60, gain: 0.6 });
    this._noise(v, { seconds: 0.18, type: 'lowpass', freq: 700, gain: 0.3 });
    this.engine.release(0.4);
  }

  /**
   * Footstep: heel, body, toe - in that order, because that is the order a
   * foot lands in. Quiet by design; they repeat forever.
   *
   * The heel is a hard scuff sweeping down, the body is the weight arriving
   * (lower and heavier at a sprint), and the toe is a lighter scuff a
   * fraction later. That two-transient gait is what a single burst can never
   * fake, and it is most of the realism. Surface still colours the band.
   */
  footstep(at, surface = 'concrete', { running = false } = {}) {
    const v = this.engine.voice(at, running ? 0.55 : 0.36, 0.35);
    if (!v) return;
    const F = {
      metal: 1500, stone: 900, concrete: 800, wood: 620,
      dirt: 380, snow: 520, grass: 440, water: 700,
    }[surface] ?? 800;
    // Soft surfaces sit low in the spectrum and need the same compensation the
    // impact palette does, or walking on dirt is silent while walking on deck
    // plate is not.
    const lift = F < 700 ? 2.2 : 1.0;
    const heel = F * rnd(0.9, 1.12);
    this._noise(v, {
      seconds: 0.05, type: 'bandpass', freq: heel * 1.4, q: 0.8,
      sweepTo: heel * 0.6, gain: (running ? 0.8 : 0.62) * lift,
    });
    this._tone(v, {
      seconds: running ? 0.09 : 0.07, type: 'sine',
      freq: running ? 95 : 110, toFreq: running ? 58 : 66, gain: running ? 0.6 : 0.45,
    });
    this._noise(v, {
      seconds: 0.04, type: 'bandpass', freq: heel * 1.1, q: 0.9,
      sweepTo: heel * 0.5, gain: (running ? 0.42 : 0.3) * lift, delay: running ? 0.05 : 0.07,
    });
    this.engine.release(0.25);
  }

  /**
   * Swim stroke: a swash pulling down through the water, with bubbles
   * breaking upward past the ear - each one a tiny rising sine, because a
   * bubble really is a resonator whose pitch climbs as it shrinks.
   */
  swimStroke(at) {
    if (this._throttled('swim', 0.45)) return;
    const v = this.engine.voice(at, 0.4, 0.6);
    if (!v) return;
    this._noise(v, { seconds: 0.5, type: 'bandpass', freq: 700, q: 0.6, sweepTo: 350, gain: 0.5 });
    for (let i = 0; i < 6; i++) {
      const f = rnd(350, 700);
      this._tone(v, { seconds: 0.06, type: 'sine', freq: f, toFreq: f * 2.2,
        gain: 0.16, delay: 0.05 + Math.random() * 0.4 });
    }
    this.engine.release(0.75);
  }

  /**
   * Climb: rock scraping under a hand or boot, then the settle knock.
   * The slowed noise is the grit; full-rate noise is a hiss, half-rate noise
   * is *texture*, and texture is what stone dragging against stone has.
   */
  climbScrape(at) {
    if (this._throttled('climb', 0.28)) return;
    const v = this.engine.voice(at, 0.42, 0.4);
    if (!v) return;
    this._noise(v, { seconds: 0.3, type: 'bandpass', freq: 1300, q: 3, sweepTo: 700, gain: 0.5, rate: 0.5 });
    this._tone(v, { seconds: 0.06, type: 'sine', freq: 130, toFreq: 95, gain: 0.28, delay: 0.22 });
    this.engine.release(0.45);
  }

  /**
   * Crouch: cloth folding, and nothing else. Eight staggered lowpassed
   * grains rather than one burst - fabric moves as a series of tiny
   * releases, and a single envelope reads as a puff of air instead.
   */
  crouchRustle(at) {
    if (this._throttled('crouch', 0.3)) return;
    const v = this.engine.voice(at, 0.3, 0.15);
    if (!v) return;
    for (let i = 0; i < 8; i++) {
      this._noise(v, { seconds: 0.03, type: 'lowpass', freq: 1600 * rnd(0.7, 1.4), q: 1,
        gain: rnd(0.12, 0.24), delay: Math.random() * 0.22 });
    }
    this.engine.release(0.35);
  }

  /* ---------------- parkour ---------------- *
   * Four recipes for the verbs in `player/Parkour.js`, which had no audio at
   * all: `player:leap`, `player:dive`, `player:roll` and `player:softland`
   * were emitted into nothing. Each is built the same way every other cue in
   * this file is - a voice, a couple of noise bands and a tone - so there is
   * no new audio path here, only new recipes on the existing one.
   */

  /**
   * Leap: the exhalation of a committed jump, and the scuff of the foot that
   * pushed off. Body first, ground a moment later, because that is the order
   * a bound happens in - you have already breathed out by the time the toe
   * leaves the roof.
   */
  leapGrunt(at) {
    if (this._throttled('leap', 0.25)) return;
    const v = this.engine.voice(at, 0.42, 0.3);
    if (!v) return;
    // Vocal: a short falling tone with a breath band over it. Two partials,
    // because one sine reads as a beep and never as a person.
    this._tone(v, { seconds: 0.20, type: 'sine', freq: rnd(178, 205), toFreq: 118, gain: 0.34 });
    this._tone(v, { seconds: 0.16, type: 'triangle', freq: rnd(356, 410), toFreq: 250, gain: 0.11 });
    this._noise(v, { seconds: 0.22, type: 'bandpass', freq: 900, q: 0.7, sweepTo: 420, gain: 0.22 });
    // Toe-off, half-rate for texture rather than hiss - the trick climbScrape uses.
    this._noise(v, { seconds: 0.09, type: 'bandpass', freq: 1400, q: 1.4, sweepTo: 700,
      gain: 0.30, rate: 0.5, delay: 0.05 });
    this.engine.release(0.4);
  }

  /**
   * Dive: wind over the ears. A long lowpassed band opening as the fall
   * steepens, plus a narrow whistle a fifth above it - the two things a
   * head-first drop actually sounds like from inside it.
   *
   * @param {number} speed downward speed, m/s. Brightens and lengthens the band.
   */
  diveWind(at, { speed = 12 } = {}) {
    if (this._throttled('dive', 0.5)) return;
    const s = Math.min(1, Math.max(0, speed / 30));
    const v = this.engine.voice(at, 0.30 + 0.22 * s, 0.2);
    if (!v) return;
    this._noise(v, { seconds: 0.85, type: 'lowpass', freq: 380 + 520 * s,
      sweepTo: 1300 + 900 * s, q: 0.6, gain: 0.5 });
    this._noise(v, { seconds: 0.7, type: 'bandpass', freq: 1750 + 700 * s, q: 5,
      sweepTo: 2400 + 900 * s, gain: 0.14, delay: 0.1 });
    this.engine.release(0.5);
  }

  /**
   * Roll: the thump of the shoulder arriving and the long scuff of the body
   * going over it. Two transients and a tail, in that order, which is the
   * same anatomy `footstep` uses for the same reason - one burst cannot fake
   * a movement that takes half a second.
   *
   * @param {number} hard 0..1, how much of the roll came out of a fall
   */
  rollThump(at, surface = 'concrete', { hard = 0.5 } = {}) {
    if (this._throttled('roll', 0.3)) return;
    const h = Math.min(1, Math.max(0, hard));
    const v = this.engine.voice(at, 0.42 + 0.2 * h, 0.4);
    if (!v) return;
    const F = {
      metal: 1500, stone: 900, concrete: 800, wood: 620,
      dirt: 380, snow: 520, grass: 440, water: 700,
    }[surface] ?? 800;
    // Shoulder down: low and heavy, and heavier the further you fell.
    this._tone(v, { seconds: 0.16, type: 'sine', freq: 88 + 18 * h, toFreq: 46, gain: 0.55 + 0.25 * h });
    this._noise(v, { seconds: 0.07, type: 'bandpass', freq: F * 1.3, q: 0.8, sweepTo: F * 0.5,
      gain: 0.5 + 0.3 * h });
    // ...then the body rolling across it. Half-rate: this is grit, not hiss.
    this._noise(v, { seconds: 0.34, type: 'bandpass', freq: F * 0.9, q: 1.2, sweepTo: F * 0.35,
      gain: 0.34, rate: 0.5, delay: 0.06 });
    // Coming back up onto the feet.
    this._noise(v, { seconds: 0.05, type: 'bandpass', freq: F * 1.1, q: 1.0, sweepTo: F * 0.6,
      gain: 0.26, delay: 0.34 });
    this.engine.release(0.5);
  }

  /**
   * Hay: the whump of a fall being caught. All body and no transient, which
   * is the whole difference between landing in a haystack and landing on the
   * roof beside it - there is no crack, only a lot of dry stalks moving at
   * once and then settling.
   */
  haystackWhump(at) {
    /* The only one of the four with a throttle it genuinely needs: 1 tone +
     * 1 noise + a twelve-grain loop is 41 WebAudio nodes against 5-11 for its
     * siblings, and `engine.release(0.8)` holds the voice slot for most of a
     * second each time. */
    if (this._throttled('hay', 0.4)) return;
    const v = this.engine.voice(at, 0.5, 0.45);
    if (!v) return;
    this._tone(v, { seconds: 0.22, type: 'sine', freq: 96, toFreq: 44, gain: 0.4 });
    this._noise(v, { seconds: 0.30, type: 'lowpass', freq: 900, sweepTo: 320, q: 0.7, gain: 0.55 });
    // Twelve staggered dry grains: the stalks settling after the body stops.
    for (let i = 0; i < 12; i++) {
      this._noise(v, { seconds: 0.05, type: 'bandpass', freq: rnd(2200, 5200), q: 2.5,
        gain: rnd(0.05, 0.13), delay: 0.06 + Math.random() * 0.55 });
    }
    this.engine.release(0.8);
  }

  /** Pickup: a short bright two-note lift. Reward, not alert. */
  pickup(at, { rare = false } = {}) {
    const v = this.engine.voice(at, 0.4, 0.5);
    if (!v) return;
    const base = rare ? 660 : 520;
    this._tone(v, { seconds: 0.12, type: 'triangle', freq: base, gain: 0.4 });
    this._tone(v, { seconds: 0.22, type: 'triangle', freq: base * 1.5, gain: 0.34, delay: 0.075 });
    if (rare) this._tone(v, { seconds: 0.35, type: 'sine', freq: base * 2, gain: 0.22, delay: 0.15 });
    this.engine.release(0.6);
  }

  /** UI blip. Deliberately dry - menu sound in a reverb tail is disorienting. */
  ui(kind = 'click') {
    const v = this.engine.voice(null, 0.28, 0);
    if (!v) return;
    const f = kind === 'open' ? 440 : kind === 'close' ? 300 : 700;
    this._tone(v, { seconds: 0.07, type: 'square', freq: f, toFreq: f * 0.8, gain: 0.16 });
    this.engine.release(0.1);
  }

  /** Portal: a shimmering cluster, slightly detuned, with a rising tail. */
  portal(at) {
    const v = this.engine.voice(at, 0.5, 1);
    if (!v) return;
    for (const [mult, delay] of [[1, 0], [1.5, 0.06], [2.02, 0.12], [2.98, 0.2]]) {
      this._tone(v, { seconds: 0.9, type: 'sine', freq: 320 * mult, toFreq: 320 * mult * 1.5, gain: 0.16, delay });
    }
    this._noise(v, { seconds: 1.1, type: 'bandpass', freq: 1200, q: 2, sweepTo: 4000, gain: 0.18 });
    this.engine.release(1.4);
  }

  /* ================================================================== */
  /* Mounts - continuous voices                                          */
  /* ================================================================== */

  /**
   * A held, modulatable voice for a vehicle.
   *
   * Mounts are not one-shots: an engine is a sound that exists for as long as
   * the thing does and is *modulated* by what it is doing. So these return a
   * handle with `set()` and `stop()` rather than firing and forgetting, and
   * they sit outside the voice budget because there is at most one of them.
   *
   * @param {'hoverboard'|'car'|'bicycle'|'dragon'|'horse'|'eagle'} kind
   * @returns {{set:(o:object)=>void, stop:()=>void}|null}
   */
  startMount(kind) {
    const eng = this.engine;
    if (!eng.ready || !eng.settings.sfxOn) return null;
    const ctx = eng.ctx;
    const t = ctx.currentTime;

    const out = ctx.createGain();
    out.gain.setValueAtTime(0.0001, t);
    out.gain.exponentialRampToValueAtTime(0.35, t + 0.5);
    const pan = ctx.createStereoPanner ? ctx.createStereoPanner() : null;
    if (pan) { out.connect(pan); pan.connect(eng.sfxBus); } else out.connect(eng.sfxBus);

    const nodes = [];
    let setter;

    if (kind === 'hoverboard') {
      /* Magnetic pulse: a square fundamental with its sine octave through a
       * resonant lowpass, the whole field throbbing at ~9 Hz. The throb is
       * the character - a steady hum is a refrigerator, a pulsed one is a
       * containment field working. Rate and pitch both climb with speed. */
      const a = ctx.createOscillator(); a.type = 'square'; a.frequency.value = 70;
      const b = ctx.createOscillator(); b.type = 'sine'; b.frequency.value = 140;
      const bg = ctx.createGain(); bg.gain.value = 0.75;
      const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 600; lp.Q.value = 5;
      const throb = ctx.createGain(); throb.gain.value = 1;
      const lfo = ctx.createOscillator(); lfo.type = 'sine'; lfo.frequency.value = 9;
      const lfoAmt = ctx.createGain(); lfoAmt.gain.value = 0.45;
      lfo.connect(lfoAmt); lfoAmt.connect(throb.gain);
      a.connect(lp); b.connect(bg); bg.connect(lp); lp.connect(throb); throb.connect(out);
      a.start(t); b.start(t); lfo.start(t);
      nodes.push(a, b, lfo);
      setter = ({ speed = 0, boost = 0 }) => {
        const now = ctx.currentTime;
        const f = 70 + speed * 4 + boost * 28;
        a.frequency.setTargetAtTime(f, now, 0.08);
        b.frequency.setTargetAtTime(f * 2, now, 0.08);
        lp.frequency.setTargetAtTime(600 + speed * 70 + boost * 700, now, 0.1);
        lfo.frequency.setTargetAtTime(9 + speed * 0.35, now, 0.15);
      };
    } else if (kind === 'car') {
      /* Rally growl: a harmonic stack with a *detuned* half-order saw in it.
       * The 1.5× sawtooth is the whole character - integer harmonics are a
       * clean engine, and the off-order partial snarling against them is a
       * competition motor with the refinement tuned out. */
      const oscs = [];
      const mix = ctx.createGain(); mix.gain.value = 0.5;
      for (const [mult, g, wave] of [[1, 0.5, 'sawtooth'], [1.5, 0.2, 'sawtooth'], [2, 0.3, 'square'], [3, 0.15, 'square']]) {
        const o = ctx.createOscillator();
        o.type = wave;
        o.frequency.value = 52 * mult;
        const og = ctx.createGain(); og.gain.value = g;
        o.connect(og); og.connect(mix);
        o.start(t);
        oscs.push({ o, mult });
        nodes.push(o);
      }
      const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 1100;
      mix.connect(lp); lp.connect(out);
      setter = ({ speed = 0, throttle = 0 }) => {
        const f = 52 + speed * 3.4 + throttle * 14;
        const now = ctx.currentTime;
        for (const { o, mult } of oscs) o.frequency.setTargetAtTime(f * mult, now, 0.06);
        lp.frequency.setTargetAtTime(900 + speed * 55 + throttle * 700, now, 0.08);
      };
    } else if (kind === 'bicycle') {
      /* Chain and clicks: a soft chain-whir noise bed, and freewheel pawl
       * clicks whose cadence tracks speed. The clicks are scheduled from a
       * timer rather than looped - a looped click train phase-locks into a
       * buzz, and a real hub never does. */
      const whir = ctx.createBufferSource(); whir.buffer = eng.noiseBuffer(2); whir.loop = true;
      const bp = ctx.createBiquadFilter(); bp.type = 'bandpass'; bp.frequency.value = 950; bp.Q.value = 1.2;
      const wg = ctx.createGain(); wg.gain.value = 0.0001;
      whir.connect(bp); bp.connect(wg); wg.connect(out);
      whir.start(t);
      nodes.push(whir);
      let rate = 0;
      let nextClick = 0;
      const tick = setInterval(() => {
        const now = ctx.currentTime;
        if (rate < 3 || now < nextClick) return;
        nextClick = now + 1 / rate;
        const o = ctx.createOscillator();
        o.type = 'square';
        o.frequency.value = 3200 * rnd(0.95, 1.05);
        const g = ctx.createGain();
        g.gain.setValueAtTime(0.0001, now);
        g.gain.exponentialRampToValueAtTime(0.1 * rnd(0.7, 1), now + 0.002);
        g.gain.exponentialRampToValueAtTime(0.0001, now + 0.014);
        o.connect(g); g.connect(out);
        o.start(now); o.stop(now + 0.02);
      }, 24);
      // A pseudo-node so the shared stop() tears the timer down with the rest.
      nodes.push({ stop() { clearInterval(tick); } });
      setter = ({ speed = 0 }) => {
        rate = speed * 1.6;
        const now = ctx.currentTime;
        wg.gain.setTargetAtTime(Math.min(0.09, 0.01 + speed * 0.006), now, 0.2);
        bp.frequency.setTargetAtTime(950 + speed * 30, now, 0.25);
      };
    } else if (kind === 'horse') {
      /* A horse is almost entirely hooves, and hooves are events, not a drone -
       * they are played per footfall by {@link hoof}, driven by the gait's own
       * phase table so the sound lands exactly when the leg does.
       *
       * What is left for the held voice is the part that really is continuous:
       * breath. A slow noise band pulsing at roughly the breathing rate, which
       * rises with effort. On its own it is nearly inaudible, and that is
       * correct - it is the bed the hoofbeats sit on, not the sound of a horse. */
      const air = ctx.createBufferSource(); air.buffer = eng.noiseBuffer(2); air.loop = true;
      const bp = ctx.createBiquadFilter(); bp.type = 'bandpass'; bp.frequency.value = 480; bp.Q.value = 0.9;
      const breath = ctx.createGain(); breath.gain.value = 0.05;
      const lfo = ctx.createOscillator(); lfo.type = 'sine'; lfo.frequency.value = 0.7;
      const lfoAmt = ctx.createGain(); lfoAmt.gain.value = 0.04;
      lfo.connect(lfoAmt); lfoAmt.connect(breath.gain);
      air.connect(bp); bp.connect(breath); breath.connect(out);
      air.start(t); lfo.start(t);
      nodes.push(air, lfo);
      setter = ({ speed = 0 }) => {
        const now = ctx.currentTime;
        // Breathing rate climbs with the gait: a walking horse is near silent,
        // a galloping one is audibly working.
        lfo.frequency.setTargetAtTime(0.7 + speed * 0.22, now, 0.4);
        bp.frequency.setTargetAtTime(480 + speed * 40, now, 0.3);
        breath.gain.setTargetAtTime(0.05 + speed * 0.05, now, 0.4);
      };
    } else if (kind === 'eagle') {
      /* Wind over the wing, and nothing else held.
       *
       * Airspeed is the whole sound of a gliding bird: a broad noise bed whose
       * brightness and level track speed, so a dive audibly loads up and a stall
       * goes quiet. The wingbeats themselves are one-shots from {@link wingBeat},
       * fired on the flap phase, because a looped flap is a helicopter. */
      const air = ctx.createBufferSource(); air.buffer = eng.noiseBuffer(2); air.loop = true;
      const bp = ctx.createBiquadFilter(); bp.type = 'bandpass'; bp.frequency.value = 620; bp.Q.value = 0.55;
      const hp = ctx.createBiquadFilter(); hp.type = 'highpass'; hp.frequency.value = 200;
      const g = ctx.createGain(); g.gain.value = 0.06;
      air.connect(bp); bp.connect(hp); hp.connect(g); g.connect(out);
      air.start(t);
      nodes.push(air);
      setter = ({ speed = 0 }) => {
        const now = ctx.currentTime;
        const s = Math.min(1, speed / 40);
        bp.frequency.setTargetAtTime(500 + s * 1700, now, 0.18);
        g.gain.setTargetAtTime(0.04 + s * 0.3, now, 0.2);
      };
    } else {
      /* Dragon: slow wingbeat (an LFO on a low noise band) with a breath bed.
       * The roar is a separate one-shot - see `dragonRoar`. */
      const air = ctx.createBufferSource(); air.buffer = eng.noiseBuffer(2); air.loop = true;
      const bp = ctx.createBiquadFilter(); bp.type = 'bandpass'; bp.frequency.value = 260; bp.Q.value = 1.2;
      const beatGain = ctx.createGain(); beatGain.gain.value = 0.3;
      const lfo = ctx.createOscillator(); lfo.type = 'sine'; lfo.frequency.value = 0.9;
      const lfoAmt = ctx.createGain(); lfoAmt.gain.value = 0.26;
      lfo.connect(lfoAmt); lfoAmt.connect(beatGain.gain);
      air.connect(bp); bp.connect(beatGain); beatGain.connect(out);
      air.start(t); lfo.start(t);
      nodes.push(air, lfo);
      setter = ({ speed = 0 }) => {
        lfo.frequency.setTargetAtTime(0.9 + speed * 0.06, ctx.currentTime, 0.3);
        bp.frequency.setTargetAtTime(260 + speed * 12, ctx.currentTime, 0.2);
      };
    }

    return {
      set(o) { try { setter(o); } catch { /* node torn down mid-frame */ } },
      setPan(p) { if (pan) pan.pan.setTargetAtTime(p, ctx.currentTime, 0.05); },
      stop() {
        const now = ctx.currentTime;
        try {
          out.gain.cancelScheduledValues(now);
          out.gain.setValueAtTime(out.gain.value, now);
          out.gain.exponentialRampToValueAtTime(0.0001, now + 0.35);
        } catch { /* already gone */ }
        for (const n of nodes) {
          try { n.stop(now + 0.4); } catch { /* not a source */ }
        }
      },
    };
  }

  /**
   * One hoof striking the ground.
   *
   * Three layers, because a hoof is not a footstep. The knock is a short pitched
   * body - a hoof is a hollow keratin box and it rings, which is the single cue
   * that separates it from a boot. Over it, a hard transient click for the shoe
   * on stone, and under it, a scuff of the ground giving way. The pitch is
   * jittered per strike so four hooves in a row do not sound like a machine.
   *
   * @param {THREE.Vector3|null} at
   * @param {{hard?:number, surface?:string}} [opts] `hard` 0..1 - how much
   *   weight is behind the strike, i.e. the gait.
   */
  hoof(at, { hard = 0.5 } = {}) {
    const v = this.engine.voice(at, 0.3, 0.5 + hard * 0.45);
    if (!v) return;
    /* Cobblestone: the knock sits high (~660 Hz) and falls a full octave,
     * which is the hollow keratin-box ring bouncing off stone. Bright shoe
     * click over it, and a modest body underneath - the stone carries the
     * high end, so the body stays small or every step turns into a drum. */
    const f = 660 * rnd(0.92, 1.1);
    this._tone(v, { seconds: 0.055, type: 'sine', freq: f, toFreq: f * 0.5,
      gain: 0.3 + hard * 0.3 });
    this._noise(v, { seconds: 0.02, type: 'bandpass', freq: 1900, q: 2,
      gain: 0.14 + hard * 0.25 });
    this._tone(v, { seconds: 0.09, type: 'sine', freq: 130, toFreq: 75,
      gain: 0.18 + hard * 0.2 });
  }

  /**
   * One beat of a large wing.
   *
   * A downstroke is a mass of air being moved, so it is a noise band that
   * *rises* into the stroke and cuts off, rather than a symmetrical whoosh. The
   * low thump underneath is the wing loading up; without it the beat reads as
   * cloth rather than as something with a two-metre span.
   *
   * @param {THREE.Vector3|null} at
   * @param {{power?:number}} [opts]
   */
  wingBeat(at, { power = 1 } = {}) {
    const v = this.engine.voice(at, 0.45, 0.5 + power * 0.5);
    if (!v) return;
    /* Broad-wing character: the band climbs much further into the stroke
     * (~1200 Hz) before cutting, which is a bigger sail moving more air. */
    this._noise(v, { seconds: 0.4, type: 'bandpass', freq: 300, q: 0.8, sweepTo: 1200,
      gain: 0.4 * power });
    this._noise(v, { seconds: 0.24, type: 'lowpass', freq: 900, sweepTo: 260, gain: 0.28 * power });
    this._tone(v, { seconds: 0.16, type: 'sine', freq: 62, toFreq: 34, gain: 0.22 * power });
  }

  /**
   * An eagle's cry: one long, driven note falling away into the canyon.
   *
   * Slightly overdriven sawtooth through a single high band - the drive adds
   * the torn upper harmonics a real raptor call has, and the full reverb send
   * is the other half of the sound: the cry is *of somewhere high*.
   */
  eagleScreech(at) {
    if (this._throttled('screech', 2.2)) return;
    const v = this.engine.voice(at, 0.7, 1);
    if (!v) return;
    const ctx = this.engine.ctx;
    const t = ctx.currentTime;
    const dur = 1.1;
    const osc = ctx.createOscillator();
    osc.type = 'sawtooth';
    osc.frequency.setValueAtTime(1900, t);
    osc.frequency.exponentialRampToValueAtTime(1140, t + dur);
    const sh = this._shaper(3.5);
    const band = ctx.createBiquadFilter();
    band.type = 'bandpass';
    band.frequency.value = 2100;
    band.Q.value = 1.6;
    const env = ctx.createGain();
    env.gain.setValueAtTime(0.0001, t);
    env.gain.exponentialRampToValueAtTime(0.4, t + 0.015);
    env.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    osc.connect(sh); sh.connect(band); band.connect(env); env.connect(v.input);
    osc.start(t);
    osc.stop(t + dur + 0.05);
    this.engine.release(dur + 0.3);
  }

  /** A horse's whinny, for summoning. */
  whinny(at) {
    if (this._throttled('whinny', 1.5)) return;
    const v = this.engine.voice(at, 0.9, 1);
    if (!v) return;
    // A whinny is a pitch fall with a hard tremolo on it; the formants keep it
    // in an animal's throat rather than a synth's.
    for (const [f, q, g] of [[420, 5, 0.34], [1150, 7, 0.22], [2400, 9, 0.1]]) {
      this._noise(v, { seconds: 0.8, type: 'bandpass', freq: f, q, sweepTo: f * 0.62, gain: g });
    }
    this._tone(v, { seconds: 0.85, type: 'sawtooth', freq: 360, toFreq: 180, gain: 0.26 });
  }

  /**
   * The rumbling growl: a warning, not a scream.
   *
   * A driven sawtooth at 58 Hz falling barely a third, amplitude-shaken at
   * 9 Hz (the growl itself - a real growl is pulsed air, not a steady tone),
   * pushed through a throat of three formant bands. Long, low, and it never
   * opens up: the menace is in what it withholds.
   */
  dragonRoar(at) {
    if (this._throttled('roar', 1.2)) return;
    const v = this.engine.voice(at, 0.85, 1);
    if (!v) return;
    const ctx = this.engine.ctx;
    const t = ctx.currentTime;
    const dur = 1.9;
    const osc = ctx.createOscillator();
    osc.type = 'sawtooth';
    osc.frequency.setValueAtTime(58, t);
    osc.frequency.exponentialRampToValueAtTime(46, t + dur * 0.85);
    const sh = this._shaper(5);
    const am = ctx.createGain();
    am.gain.value = 1;
    const lfo = ctx.createOscillator();
    lfo.frequency.value = 9;
    const lfoAmt = ctx.createGain();
    lfoAmt.gain.value = 0.35;
    lfo.connect(lfoAmt);
    lfoAmt.connect(am.gain);
    const mix = ctx.createGain();
    osc.connect(sh);
    sh.connect(am);
    for (const [f, q, g] of [[240, 1.1, 0.5], [620, 1.4, 0.38], [1150, 2, 0.2]]) {
      const b = ctx.createBiquadFilter();
      b.type = 'bandpass';
      b.frequency.value = f;
      b.Q.value = q;
      const bg = ctx.createGain();
      bg.gain.value = g;
      am.connect(b); b.connect(bg); bg.connect(mix);
    }
    const env = ctx.createGain();
    env.gain.setValueAtTime(0.0001, t);
    env.gain.exponentialRampToValueAtTime(0.55, t + 0.08);
    env.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    mix.connect(env);
    env.connect(v.input);
    osc.start(t); osc.stop(t + dur + 0.05);
    lfo.start(t); lfo.stop(t + dur + 0.05);
    // The breath around the growl.
    this._noise(v, { seconds: dur * 0.9, type: 'bandpass', freq: 900, q: 0.7,
      sweepTo: 400, gain: 0.32, rate: 0.8 });
    this.engine.release(dur + 0.2);
  }

  /** Mount summon / dismiss: a short materialising sweep. */
  mountSummon(at, { up = true } = {}) {
    const v = this.engine.voice(at, 0.5, 0.8);
    if (!v) return;
    this._noise(v, {
      seconds: 0.6, type: 'bandpass', freq: up ? 300 : 2600, q: 1.4,
      sweepTo: up ? 3000 : 220, gain: 0.4,
    });
    this._tone(v, { seconds: 0.5, type: 'sine', freq: up ? 180 : 520, toFreq: up ? 520 : 160, gain: 0.3 });
    this.engine.release(0.8);
  }

  /** Splash, for entering water. */
  splash(at, { big = false } = {}) {
    const v = this.engine.voice(at, big ? 0.6 : 0.35, 0.7);
    if (!v) return;
    this._noise(v, { seconds: big ? 0.5 : 0.3, type: 'bandpass', freq: 1400, q: 0.7, sweepTo: 300, gain: 0.6 });
    this._tone(v, { seconds: 0.25, type: 'sine', freq: 420, toFreq: 140, gain: 0.18 });
    this.engine.release(0.7);
  }
}

export default Sfx;
