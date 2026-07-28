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

  /** Shorthand: a noise source through a filter, enveloped. */
  _noise(v, { seconds, type = 'bandpass', freq = 1000, q = 1, sweepTo = null, gain = 1 }) {
    const ctx = this.engine.ctx;
    const src = ctx.createBufferSource();
    src.buffer = this.engine.noiseBuffer(Math.max(0.25, seconds));
    const filt = ctx.createBiquadFilter();
    filt.type = type;
    filt.Q.value = q;
    const t = ctx.currentTime;
    filt.frequency.setValueAtTime(freq, t);
    if (sweepTo !== null) {
      filt.frequency.exponentialRampToValueAtTime(Math.max(20, sweepTo), t + seconds);
    }
    const env = ctx.createGain();
    decay(env.gain, gain, seconds, ctx);
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

  /* ================================================================== */
  /* Weapons                                                             */
  /* ================================================================== */

  /**
   * Rifle shot: a wideband crack, a short resonant body, and a low thump.
   *
   * The crack carries the transient and is what makes it read as a *shot*
   * rather than as a click; the body is the receiver ringing; the thump is the
   * part you feel. Randomising the body frequency a few percent per shot is
   * what stops full-auto fire collapsing into a buzz.
   */
  gunshot(at, { volume = 1 } = {}) {
    const v = this.engine.voice(at, 0.55 * volume, 0.7);
    if (!v) return;
    this._noise(v, { seconds: 0.09, type: 'highpass', freq: 1800, q: 0.7, gain: 0.9 });
    this._noise(v, { seconds: 0.16, type: 'bandpass', freq: rnd(520, 700), q: 1.4, sweepTo: 180, gain: 0.5 });
    this._tone(v, { seconds: 0.12, type: 'triangle', freq: rnd(95, 120), toFreq: 45, gain: 0.55 });
    this.engine.release(0.25);
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
   * Sword swing: filtered noise whose centre sweeps down through the arc.
   *
   * The sweep *is* the swing - a static band reads as a hiss, and it is the
   * downward glide that the ear hears as something heavy moving past.
   */
  swordSwing(at) {
    const v = this.engine.voice(at, 0.5, 0.5);
    if (!v) return;
    this._noise(v, { seconds: 0.34, type: 'bandpass', freq: rnd(1500, 2100), q: 1.6, sweepTo: 320, gain: 0.55 });
    this.engine.release(0.45);
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

  /** Bowstring: a short pluck plus the fletching passing the riser. */
  bowRelease(at) {
    const v = this.engine.voice(at, 0.5, 0.6);
    if (!v) return;
    this._tone(v, { seconds: 0.14, type: 'triangle', freq: rnd(150, 190), toFreq: 70, gain: 0.5 });
    this._noise(v, { seconds: 0.2, type: 'bandpass', freq: 2400, q: 2, sweepTo: 700, gain: 0.35 });
    this.engine.release(0.3);
  }

  /** The draw: rising creak of limbs under load. */
  bowDraw(at) {
    if (this._throttled('bowDraw', 0.4)) return;
    const v = this.engine.voice(at, 0.55, 0.3);
    if (!v) return;
    // Q of 6 is a narrow band, and a narrow band passes very little energy -
    // measured at barely twice the noise floor before the gain came up.
    this._noise(v, { seconds: 0.5, type: 'bandpass', freq: 320, q: 6, sweepTo: 620, gain: 0.85 });
    this.engine.release(0.6);
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

  /** Release: a body of low noise with a bright leading edge. */
  fireballCast(at) {
    const v = this.engine.voice(at, 0.6, 0.8);
    if (!v) return;
    this._noise(v, { seconds: 0.45, type: 'lowpass', freq: 2200, q: 0.8, sweepTo: 320, gain: 0.6 });
    this._tone(v, { seconds: 0.3, type: 'sawtooth', freq: 220, toFreq: 60, gain: 0.35 });
    this.engine.release(0.6);
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

  /** Footstep, coloured by surface. Quiet by design - they repeat forever. */
  footstep(at, surface = 'concrete', { running = false } = {}) {
    const v = this.engine.voice(at, running ? 0.5 : 0.34, 0.4);
    if (!v) return;
    const F = {
      metal: 1500, stone: 900, concrete: 800, wood: 620,
      dirt: 380, snow: 520, grass: 440, water: 700,
    }[surface] ?? 800;
    // Soft surfaces sit low in the spectrum and need the same compensation the
    // impact palette does, or walking on dirt is silent while walking on deck
    // plate is not.
    const lift = F < 700 ? 2.2 : 1.0;
    this._noise(v, {
      seconds: running ? 0.11 : 0.14,
      type: 'bandpass', freq: F * rnd(0.88, 1.14), q: 1.1, sweepTo: F * 0.4, gain: 0.7 * lift,
    });
    this.engine.release(0.25);
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
   * @param {'hoverboard'|'car'|'dragon'|'horse'|'eagle'} kind
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
      /* Anti-grav hum: two detuned saws through a lowpass, plus an airy noise
       * bed. The detune is what gives it the slow beating that reads as a
       * field rather than as a note. */
      const a = ctx.createOscillator(); a.type = 'sawtooth'; a.frequency.value = 92;
      const b = ctx.createOscillator(); b.type = 'sawtooth'; b.frequency.value = 92 * 1.007;
      const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 700; lp.Q.value = 4;
      const air = ctx.createBufferSource(); air.buffer = eng.noiseBuffer(2); air.loop = true;
      const ap = ctx.createBiquadFilter(); ap.type = 'bandpass'; ap.frequency.value = 2400; ap.Q.value = 0.8;
      const ag = ctx.createGain(); ag.gain.value = 0.09;
      a.connect(lp); b.connect(lp); lp.connect(out);
      air.connect(ap); ap.connect(ag); ag.connect(out);
      a.start(t); b.start(t); air.start(t);
      nodes.push(a, b, air);
      setter = ({ speed = 0, boost = 0 }) => {
        const f = 92 + speed * 5.5 + boost * 40;
        a.frequency.setTargetAtTime(f, ctx.currentTime, 0.08);
        b.frequency.setTargetAtTime(f * 1.007, ctx.currentTime, 0.08);
        lp.frequency.setTargetAtTime(700 + speed * 90 + boost * 900, ctx.currentTime, 0.1);
        ag.gain.setTargetAtTime(0.09 + speed * 0.012, ctx.currentTime, 0.15);
      };
    } else if (kind === 'car') {
      /* Engine: a stack of harmonics on a fundamental that tracks rpm, with a
       * touch of noise for induction. Sawtooth alone is a synth; the harmonic
       * stack with unequal gains is what gives it a body. */
      const oscs = [];
      const mix = ctx.createGain(); mix.gain.value = 0.5;
      for (const [mult, g] of [[1, 0.5], [2, 0.28], [3, 0.16], [4.5, 0.08]]) {
        const o = ctx.createOscillator();
        o.type = mult === 1 ? 'sawtooth' : 'square';
        o.frequency.value = 55 * mult;
        const og = ctx.createGain(); og.gain.value = g;
        o.connect(og); og.connect(mix);
        o.start(t);
        oscs.push({ o, mult });
        nodes.push(o);
      }
      const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 1200;
      mix.connect(lp); lp.connect(out);
      setter = ({ speed = 0, throttle = 0 }) => {
        const f = 46 + speed * 3.4 + throttle * 14;
        const now = ctx.currentTime;
        for (const { o, mult } of oscs) o.frequency.setTargetAtTime(f * mult, now, 0.06);
        lp.frequency.setTargetAtTime(900 + speed * 55 + throttle * 700, now, 0.08);
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
    const v = this.engine.voice(at, 0.28, 0.55 + hard * 0.45);
    if (!v) return;
    const f = rnd(150, 215);
    // The ring. Falls fast - a hoof is damped by the ground it just hit.
    this._tone(v, { seconds: 0.1 + hard * 0.05, type: 'triangle', freq: f, toFreq: f * 0.62,
      gain: 0.32 + hard * 0.3 });
    // The shoe. Bright, and only really present at speed.
    this._noise(v, { seconds: 0.028, type: 'highpass', freq: 3200 + hard * 1800, q: 0.8,
      gain: 0.18 + hard * 0.4 });
    // The ground. Dust and grit under the strike.
    this._noise(v, { seconds: 0.13, type: 'bandpass', freq: rnd(700, 1100), q: 1.1,
      sweepTo: 260, gain: 0.16 + hard * 0.22 });
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
    this._noise(v, { seconds: 0.3, type: 'bandpass', freq: 210, q: 0.7, sweepTo: 620,
      gain: 0.4 * power });
    this._noise(v, { seconds: 0.22, type: 'lowpass', freq: 900, sweepTo: 260, gain: 0.3 * power });
    this._tone(v, { seconds: 0.16, type: 'sine', freq: 62, toFreq: 34, gain: 0.22 * power });
  }

  /** An eagle's cry: a hard, bright descending scream. */
  eagleScreech(at) {
    if (this._throttled('screech', 2.2)) return;
    const v = this.engine.voice(at, 0.7, 1);
    if (!v) return;
    /* Raptor calls are strident because the energy sits in the upper harmonics
     * rather than the fundamental, so the stack is deliberately top-heavy and
     * every partial slides down together. */
    for (const [mult, g] of [[1, 0.16], [2, 0.3], [3, 0.26], [4, 0.14]]) {
      this._tone(v, { seconds: 0.62, type: 'sawtooth', freq: 900 * mult * 0.5,
        toFreq: 560 * mult * 0.5, gain: g });
    }
    this._noise(v, { seconds: 0.5, type: 'bandpass', freq: 2800, q: 3.5, sweepTo: 1500, gain: 0.3 });
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

  /** A roar: formant-filtered noise growl over a falling pitch. */
  dragonRoar(at) {
    if (this._throttled('roar', 1.2)) return;
    const v = this.engine.voice(at, 0.8, 1);
    if (!v) return;
    // Three formants is the cheapest thing that reads as a throat rather than
    // as a filter sweep.
    for (const [f, q, g] of [[220, 6, 0.45], [640, 8, 0.3], [1500, 10, 0.16]]) {
      this._noise(v, { seconds: 1.1, type: 'bandpass', freq: f, q, sweepTo: f * 0.55, gain: g });
    }
    this._tone(v, { seconds: 1.0, type: 'sawtooth', freq: 88, toFreq: 42, gain: 0.3 });
    this.engine.release(1.3);
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
