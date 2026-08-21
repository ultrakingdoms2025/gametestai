/**
 * Theatrical generative score, one per world.
 *
 * ── Why generated and not a loop ──────────────────────────────────────────
 * A looping track in an open world is a timer: the player learns its length
 * and starts hearing the seam instead of the music. These scores are written
 * as *rules plus a composed leitmotif* - a chord progression walked bar by
 * bar, percussion patterns, layered ensemble voices, and an eight-bar theme
 * per world - played by a scheduler, so they breathe rather than repeat.
 * It also keeps the project's no-assets rule intact: every drum, string and
 * bell below is an oscillator or a filtered noise burst, built when heard.
 *
 * ── Structure ─────────────────────────────────────────────────────────────
 * Each score runs a 16-bar cycle: bars 1-8 are the restrained statement
 * (thin percussion, reduced pad, lead absent or hushed), bars 9-16 the full
 * theatrical arrangement. The progression is 8 bars, cycled; the lead theme
 * is composed, not generated, so each world has a melody a player can hum.
 *
 * ── The scheduler ─────────────────────────────────────────────────────────
 * Web Audio's clock is sample-accurate and JavaScript's is not, so notes are
 * scheduled *ahead* of the audio clock into a lookahead window and the timer
 * only decides what to queue next - the standard "tale of two clocks"
 * arrangement, which is why the music does not stutter on a bad frame.
 */

/** Seconds of music kept queued ahead of the audio clock. */
const LOOKAHEAD = 0.6;
/** How often the scheduler wakes to top that window up. */
const TICK_MS = 110;

/** Chord qualities as semitone offsets from the chord root. */
const CHORD = { m: [0, 3, 7], M: [0, 4, 7], m7: [0, 3, 7, 10], M7: [0, 4, 7, 11], s: [0, 5, 7] };

/** midi -> Hz */
const hz = (m) => 440 * Math.pow(2, (m - 69) / 12);

/**
 * Per-world scores (approved 2026-08-10; auditioned in soundtrack-preview.html).
 *
 * `root` is a bass-register MIDI note. `progression` is one `[semitoneOffset,
 * quality]` per bar, 8 bars, cycled. Drum patterns are one char per 16th
 * step: 0 rest, 1 hit, 2 accent; `A` is the restrained half of the 16-bar
 * cycle, `B` the full one. Lead phrases are `[bar, beat, semitone, beats]`.
 */
const SCORES = {
  /* STATION - "Cold Orbit". Slow sci-fi epic in D minor: sub booms, wide
     detuned strings, glittering 16th arp, a soaring beacon theme. */
  station: {
    bpm: 72, beatsPerBar: 4, root: 38, seed: 11,
    progression: [[0, 'm'], [0, 'm7'], [8, 'M'], [3, 'M7'], [10, 'M'], [0, 'm'], [8, 'M7'], [10, 'M']],
    pad: { voice: 'strings', gain: 0.30, cutoff: 780, octave: 1 },
    bass: { style: 'pulse', gain: 0.24, type: 'sine' },
    drums: {
      boom: { A: '1000000000000000', B: '1000000000100000', gain: 0.30, voice: 'taiko', pitch: 62 },
      tick: { A: '0000000000000000', B: '0010001000100010', gain: 0.05, voice: 'hat' },
    },
    swellEveryBars: 8, swellGain: 0.07,
    arp: { div: 4, densityA: 0.16, densityB: 0.45, type: 'triangle', octave: 2, gain: 0.065, cutoff: 2600 },
    lead: {
      voice: 'tone', type: 'sine', octave: 2, gain: 0.12, cutoff: 2200,
      vibHz: 4.6, vibCents: 14, rvb: 0.6, inA: false,
      phrase: [
        [0, 0, 0, 2], [0, 2, 3, 1], [0, 3, 7, 1], [1, 0, 5, 2], [1, 2, 3, 1], [1, 3, 2, 1],
        [2, 0, 2, 2], [2, 2, 3, 1], [2, 3, 2, 1], [3, 0, 0, 4],
        [4, 0, 7, 2], [4, 2, 10, 1], [4, 3, 12, 1], [5, 0, 10, 2], [5, 2, 7, 2],
        [6, 0, 5, 2], [6, 2, 3, 1], [6, 3, 5, 1], [7, 0, 7, 3.5],
      ],
    },
    bells: { density: 0.07, octave: 3, gain: 0.05 },
  },

  /* MEDIEVAL - "Banner and Hearth". A-dorian folk theatre: drone fifths,
     frame drum and tambourine, lute plucks, a wooden-flute tune. */
  medieval: {
    bpm: 96, beatsPerBar: 4, root: 33, seed: 23,
    progression: [[0, 'm'], [10, 'M'], [0, 'm'], [5, 'M'], [3, 'M'], [10, 'M'], [0, 'm'], [7, 'm']],
    pad: { voice: 'drone5', gain: 0.20, cutoff: 520, octave: 0 },
    bass: { style: 'rootBeat', gain: 0.20, type: 'sine' },
    drums: {
      frame: { A: '1000000010100000', B: '1000100010100100', gain: 0.24, voice: 'frame' },
      tamb: { A: '0000100000001000', B: '0010001000100010', gain: 0.055, voice: 'hat' },
    },
    arp: { div: 2, densityA: 0.3, densityB: 0.52, type: 'pluck', octave: 1, gain: 0.10, cutoff: 2600 },
    lead: {
      voice: 'tone', type: 'sine', octave: 2, gain: 0.13, cutoff: 2400,
      vibHz: 5.4, vibCents: 10, rvb: 0.4, inA: false,
      phrase: [
        [0, 0, 0, 1], [0, 1, 2, 1], [0, 2, 3, 2], [1, 0, 2, 1], [1, 1, 0, 1], [1, 2, -2, 2],
        [2, 0, 0, 1], [2, 1, 3, 1], [2, 2, 5, 1], [2, 3, 7, 1], [3, 0, 7, 2], [3, 2, 5, 2],
        [4, 0, 9, 1], [4, 1, 7, 1], [4, 2, 5, 2], [5, 0, 3, 1], [5, 1, 5, 1], [5, 2, 2, 2],
        [6, 0, 0, 1], [6, 1, -2, 1], [6, 2, 0, 2], [7, 0, 0, 3.5],
      ],
    },
    bells: { density: 0.05, octave: 2, gain: 0.04 },
  },

  /* CITADEL - "The High Gate". E-phrygian monument: war taikos, low formant
     choir, a duduk lament around the flat second, risers every 4th bar. */
  citadel: {
    bpm: 62, beatsPerBar: 4, root: 40, seed: 37,
    progression: [[0, 'm'], [1, 'M'], [0, 'm'], [1, 'M'], [0, 'm'], [8, 'M'], [1, 'M'], [0, 'm']],
    pad: { voice: 'choir', gain: 0.34, octave: 1 },
    bass: { style: 'drone', gain: 0.26, type: 'sine' },
    drums: {
      taiko: { A: '1000000000000000', B: '2000000010010000', gain: 0.34, voice: 'taiko', pitch: 82 },
    },
    swellEveryBars: 4, swellGain: 0.06,
    arp: { div: 4, densityA: 0.09, densityB: 0.2, type: 'sine', octave: 2, gain: 0.05, cutoff: 1800 },
    lead: {
      voice: 'tone', type: 'triangle', octave: 1, gain: 0.15, cutoff: 1150,
      vibHz: 4.2, vibCents: 18, vibDelay: 0.45, rvb: 0.65, inA: true,
      phrase: [
        [0, 0, 0, 3], [0, 3, 1, 1], [1, 0, 0, 4],
        [2, 0, 3, 2], [2, 2, 1, 2], [3, 0, 0, 4],
        [4, 0, 7, 3], [4, 3, 8, 1], [5, 0, 7, 4],
        [6, 0, 3, 2], [6, 2, 1, 2], [7, 0, 0, 4],
      ],
    },
    bells: { density: 0.05, octave: 3, gain: 0.045 },
  },

  /* SPORTS - "Gold Hour". C-major stadium anthem: four-on-the-floor, claps,
     bright plucks, brass hits on the changes, a climbing chorus lead. */
  sports: {
    bpm: 122, beatsPerBar: 4, root: 36, seed: 51,
    progression: [[0, 'M'], [7, 'M'], [9, 'm'], [5, 'M'], [9, 'm'], [5, 'M'], [0, 'M'], [7, 'M']],
    pad: { voice: 'strings', gain: 0.18, cutoff: 1100, octave: 1 },
    bass: { style: 'eighths', gain: 0.17, type: 'sawtooth', cutoff: 520 },
    drums: {
      kick: { A: '1000100010001000', B: '1000100010001000', gain: 0.30, voice: 'kick' },
      clap: { A: '0000100000001000', B: '0000100000001000', gain: 0.13, voice: 'clap' },
      hat: { A: '1010101010101010', B: '2111211121112111', gain: 0.05, voice: 'hat' },
    },
    stabs: { pattern: '1000001000000000', gain: 0.16, octave: 1, inA: false },
    arp: { div: 4, densityA: 0.5, densityB: 0.72, type: 'pluck', octave: 2, gain: 0.08, cutoff: 3200 },
    lead: {
      voice: 'tone', type: 'triangle', octave: 2, gain: 0.12, cutoff: 3000,
      vibHz: 5.8, vibCents: 7, rvb: 0.35, inA: false,
      phrase: [
        [0, 0, 4, 1], [0, 1, 7, 1], [0, 2, 9, 2], [1, 0, 7, 1], [1, 1, 4, 1], [1, 2, 2, 2],
        [2, 0, 0, 1], [2, 1, 2, 1], [2, 2, 4, 2], [3, 0, 2, 2], [3, 2, 4, 2],
        [4, 0, 4, 1], [4, 1, 7, 1], [4, 2, 9, 1], [4, 3, 11, 1], [5, 0, 12, 2], [5, 2, 11, 1], [5, 3, 9, 1],
        [6, 0, 7, 2], [6, 2, 4, 1], [6, 3, 2, 1], [7, 0, 0, 3.5],
      ],
    },
    bells: { density: 0.09, octave: 3, gain: 0.05 },
  },

  /* DOCK - "Launches: 000". Slow industrial minor in C: a frame-drum pulse on
     the one and the three that reads as a hull being struck, a sine drone
     under it, a sparse bell arp for the gantry, and a long, patient lead that
     never resolves. The yard has fitted out four hulls and launched none of
     them; the tune is written not to arrive either.

     Deliberately the QUIETEST score in the game - every gain below is at or
     under the corresponding station value. The reason is diegetic: this world
     already makes a great deal of noise on its own account (the strip runs
     hum, the crane is parked, the trench echoes), and a hangar is a place you
     are meant to hear yourself walk across.

     No hat and no snare anywhere. A kit turns a shed into a level. */
  dock: {
    bpm: 66, beatsPerBar: 4, root: 36, seed: 97,
    progression: [[0, 'm'], [0, 'm7'], [10, 'M'], [0, 'm'], [3, 'M'], [10, 'M'], [8, 'M7'], [0, 'm']],
    pad: { voice: 'strings', gain: 0.22, cutoff: 620, octave: 1 },
    bass: { style: 'drone', gain: 0.24, type: 'sine' },
    drums: {
      // Struck steel. Two taiko voices a fifth apart: the low one is the hull
      // being rung, the high one is a hammer answering it from up the bay.
      hull: { A: '1000000000000000', B: '1000000010000000', gain: 0.30, voice: 'taiko', pitch: 58 },
      hammer: { A: '0000000000000000', B: '0000100000000010', gain: 0.13, voice: 'frame' },
    },
    swellEveryBars: 8, swellGain: 0.06,
    arp: { div: 4, densityA: 0.07, densityB: 0.18, type: 'bell', octave: 2, gain: 0.045, cutoff: 2100 },
    lead: {
      voice: 'tone', type: 'sine', octave: 1, gain: 0.13, cutoff: 1400,
      vibHz: 3.6, vibCents: 12, vibDelay: 0.6, rvb: 0.6, inA: true,
      phrase: [
        [0, 0, 0, 4], [1, 0, 3, 2], [1, 2, 2, 2],
        [2, 0, 7, 3], [2, 3, 5, 1], [3, 0, 3, 4],
        [4, 0, 10, 2], [4, 2, 7, 2], [5, 0, 5, 4],
        [6, 0, 3, 2], [6, 2, 5, 2], [7, 0, 2, 4],
      ],
    },
    bells: { density: 0.04, octave: 3, gain: 0.035 },
  },

  /* SPACE - "Nothing Between". The stub beyond the blast door. A drone, a
     choir pad and a bell every few bars, and that is the whole arrangement:
     no pulse of any kind, because the one thing a holding platform in vacuum
     must not sound like is a place with a tempo.

     It exists at all because `Music.setWorld` sets `score = null` for a world
     with no row and the failure is TOTAL SILENCE - which reads as the audio
     having broken rather than as a design. Twelve lines is cheaper than the
     bug report. */
  space: {
    bpm: 48, beatsPerBar: 4, root: 33, seed: 103,
    progression: [[0, 'm'], [0, 'm'], [7, 'M'], [7, 'M'], [3, 'M7'], [3, 'M7'], [10, 'M'], [0, 'm']],
    pad: { voice: 'choir', gain: 0.30, octave: 1 },
    bass: { style: 'drone', gain: 0.22, type: 'sine' },
    drums: {},
    swellEveryBars: 8, swellGain: 0.07,
    arp: { div: 2, densityA: 0.04, densityB: 0.07, type: 'sine', octave: 2, gain: 0.035, cutoff: 1500 },
    bells: { density: 0.05, octave: 3, gain: 0.04 },
  },

  /* CINDER - "Ashfall". The volcanic surface, and the row that was MISSING.
     `SCORES` carried eight of the nine registered worlds and `setWorld` sets
     `score = null` for one with no row, so landing on the planet the whole loop
     exists to reach faded the space score out and started nothing: the
     destination was silent, and silent immediately after a track that had been
     playing all the way there.

     Slow, heavy and tonally unresolved - C minor over a drone, 54 BPM, a taiko
     on the downbeat and a second off-grid hit in the B half so the pulse reads
     as ground movement rather than as a tempo. No lead: there is nobody out
     here. The bells are the only bright thing and they are rare, which is what
     a fissure network looks like from the ground. */
  cinder: {
    bpm: 54, beatsPerBar: 4, root: 36, seed: 137,
    progression: [[0, 'm'], [0, 'm'], [10, 'M'], [10, 'M'], [8, 'M'], [3, 'm'], [10, 'M'], [0, 'm']],
    pad: { voice: 'strings', gain: 0.26, cutoff: 560, octave: 1 },
    bass: { style: 'drone', gain: 0.26, type: 'sine' },
    drums: {
      boom: { A: '1000000000000000', B: '1000000010000010', gain: 0.26, voice: 'taiko', pitch: 54 },
    },
    swellEveryBars: 8, swellGain: 0.08,
    arp: { div: 2, densityA: 0.05, densityB: 0.11, type: 'triangle', octave: 2, gain: 0.04, cutoff: 1200 },
    bells: { density: 0.04, octave: 3, gain: 0.035 },
  },

  /* ================================================================== *
   * PHASE 2 - the other nine planet surfaces                            *
   * ==================================================================
   *
   * Cinder above shipped MISSING and the destination of the whole Phase 1
   * loop was silent. Nine more landable worlds is nine more chances to make
   * that mistake nine times, so every one of them has a row here and every
   * row says what it is going for.
   *
   * -- The rules these nine were written under -------------------------
   *
   * 1. NO TWO SHARE A ROOT, A TEMPO AND AN ARRANGEMENT. A jungle and an
   *    airless moon reaching for the same progression is the sticker-album
   *    failure the sky itself was designed against - see Bodies.js on
   *    Verdigris. Roots are spread across the MIDI notes the other nine
   *    worlds do not already sit on; tempos run 40 to 84 BPM.
   *
   * 2. PERCUSSION IS AIR. Tessera and Lathe are vacuum, and a drum is a
   *    pressure wave: neither of them has a `drums` block at all. That is the
   *    same fact `Bodies.js` records as `atmosphere === radius` and the same
   *    one the descent uses to skip its atmosphere phase, heard rather than
   *    flown. The two are told apart by everything else - Tessera is thin and
   *    has no melody, Lathe is enormous and has almost nothing but one.
   *
   * 3. NOBODY LIVES ON ANY OF THEM. Four of the nine have no `lead` at all,
   *    for Cinder's stated reason: a composed melody is a voice, and a
   *    wilderness with a singer in it is a settlement. Where a lead does
   *    appear it is what the PLACE does - Lathe's rings coming round, Shoal's
   *    water, Cathedra's plates ringing - never a character.
   *
   * 4. QUIETER THAN THE SPACE ABOVE THEM. `space` is the score a player fades
   *    out of on every descent, and a surface that arrives LOUDER than the
   *    void reads as a cut rather than as a landing. No pad here exceeds the
   *    0.30 the void itself runs at.
   */

  /* TESSERA - "Vacuum Noon". The airless moonlet, and the thinnest thing in
     the game.

     No air, so no percussion and no reverberant ensemble: a drone, a fifth
     above it, and a bell every eight bars or so. The progression is entirely
     `s` chords - root, fourth, fifth, NO THIRD anywhere in the score - which
     is the one harmonic trick that reads as "this place has no mood": a third
     is what makes a chord happy or sad, and Tessera is neither. 40 BPM is the
     slowest tempo in the game - four under Lathe, eight under the void.

     No lead. Nothing sings at a sixth of a g under a black noon sky. */
  tessera: {
    bpm: 40, beatsPerBar: 4, root: 34, seed: 149,
    progression: [[0, 's'], [0, 's'], [7, 's'], [7, 's'], [0, 's'], [5, 's'], [10, 's'], [0, 's']],
    /* `drone5` rather than `strings`: it plays the root and the fifth ONLY and
       ignores the chord, which is the correct instrument for a progression
       that has already thrown its thirds away. */
    pad: { voice: 'drone5', gain: 0.18, cutoff: 480, octave: 1 },
    bass: { style: 'drone', gain: 0.20, type: 'sine' },
    drums: {},
    arp: { div: 4, densityA: 0.03, densityB: 0.06, type: 'sine', octave: 3, gain: 0.030, cutoff: 1300 },
    bells: { density: 0.035, octave: 3, gain: 0.032 },
  },

  /* SIROCCO - "Long Dust". The desert, and the longest blind descent in the
     system - 1,000 m of orange nothing before a horizon arrives.

     So the progression NEVER lands: eight bars that walk i - bVII - v - bIII -
     i - bVI - bVII - v and hand the cycle back on the minor fifth rather than
     on the root. A player who tries to feel where the bar line resolves
     cannot, which is the descent written as harmony.

     Frame drum and hat, and the hat is a SHAKER here rather than a kit voice:
     a dry 16th tick under a slow frame pulse is sand moving. There is no kick
     and no taiko under either of them, so the world has a pulse without having
     a heartbeat, which is the difference between wind and weather. Pluck arp
     for heat shimmer, and a wide-vibrato reed lead in the B half - the only
     melody on any of the nine that could be called a tune, because Sirocco is
     the one that is merely inhospitable rather than lethal. */
  sirocco: {
    bpm: 66, beatsPerBar: 4, root: 39, seed: 151,
    progression: [[0, 'm7'], [10, 'M'], [7, 'm'], [3, 'M7'], [0, 'm7'], [8, 'M'], [10, 'M'], [7, 'm']],
    pad: { voice: 'strings', gain: 0.24, cutoff: 700, octave: 1 },
    bass: { style: 'rootBeat', gain: 0.21, type: 'sine' },
    drums: {
      frame: { A: '1000000000000000', B: '1000000010000000', gain: 0.20, voice: 'frame' },
      sand: { A: '0010001000100010', B: '1010101010101010', gain: 0.035, voice: 'hat' },
    },
    arp: { div: 2, densityA: 0.10, densityB: 0.24, type: 'pluck', octave: 2, gain: 0.055, cutoff: 2400 },
    lead: {
      voice: 'tone', type: 'triangle', octave: 2, gain: 0.11, cutoff: 1800,
      /* 22 cents is the widest vibrato in the game. A reed bending that far is
         a player breathing hard, which is what deep dust does to a landing. */
      vibHz: 5.0, vibCents: 22, vibDelay: 0.35, rvb: 0.5, inA: false,
      phrase: [
        [0, 0, 0, 2], [0, 2, 3, 1], [0, 3, 5, 1], [1, 0, 3, 2], [1, 2, 0, 2],
        [2, 0, 10, 2], [2, 2, 7, 1], [2, 3, 5, 1], [3, 0, 3, 4],
        [4, 0, 0, 1], [4, 1, 3, 1], [4, 2, 5, 2], [5, 0, 7, 2], [5, 2, 5, 2],
        [6, 0, 3, 2], [6, 2, 5, 1], [6, 3, 3, 1], [7, 0, 7, 3.5],
      ],
    },
    bells: { density: 0.03, octave: 3, gain: 0.030 },
  },

  /* SHOAL - "Shelf Light". The ocean world: island chains over a shallow
     shelf, and the only body in the sky whose albedo swings inside a
     hemisphere.

     Major, and the brightest of the ten - only Cathedra's sevenths come near
     it and those are cold. It earns the key: every other landable world is
     somewhere you survive. Brush rather than any drum with a skin on it, and
     it is the only landable world whose entire percussion section is filtered
     noise - a soft wash on the one and the three, which is surf.

     A BELL lead, hushed and present in both halves of the cycle
     (`inA: true`), because water does not have a quiet half. High bell
     density for the same reason - light off a shallow shelf is a scatter of
     bright points, which is exactly what `bells` does. */
  shoal: {
    bpm: 58, beatsPerBar: 4, root: 37, seed: 157,
    progression: [[0, 'M'], [0, 'M7'], [7, 'M'], [5, 'M'], [9, 'm'], [7, 'M'], [2, 'm7'], [5, 'M']],
    pad: { voice: 'strings', gain: 0.26, cutoff: 1050, octave: 1 },
    bass: { style: 'rootBeat', gain: 0.19, type: 'sine' },
    drums: {
      surf: { A: '1000000000000000', B: '1000000010000000', gain: 0.07, voice: 'brush' },
    },
    swellEveryBars: 8, swellGain: 0.05,
    arp: { div: 2, densityA: 0.14, densityB: 0.30, type: 'bell', octave: 2, gain: 0.050 },
    lead: {
      voice: 'bell', octave: 2, gain: 0.11, inA: true,
      phrase: [
        [0, 0, 7, 2], [0, 2, 4, 1], [0, 3, 2, 1], [1, 0, 0, 2], [1, 2, 4, 2],
        [2, 0, 7, 1], [2, 1, 9, 1], [2, 2, 11, 2], [3, 0, 7, 4],
        [4, 0, 4, 2], [4, 2, 2, 1], [4, 3, 0, 1], [5, 0, 2, 2], [5, 2, 4, 2],
        [6, 0, 9, 2], [6, 2, 7, 2], [7, 0, 0, 3.5],
      ],
    },
    bells: { density: 0.10, octave: 3, gain: 0.042 },
  },

  /* VITRINE - "Under the Vault". Ice: crevasse fields, pressure ridges and a
     subglacial vault.

     Brittle rather than cold-and-warm. The pad is `strings` at a cutoff of
     1,700 - the BRIGHTEST pad in the game, where every other slow world runs
     its strings dark at 420-700 - because a lowpass at 560 is a blanket and
     ice is the opposite of a blanket.

     Bass on `pulse`, the only style that plays twice a bar: a root on the one
     and a fifth on the ten reads as something under the ice shifting its
     weight. The frame drum is that too, and it appears ONLY in the B half -
     pressure ridges do not crack on a schedule.

     A bell arp and a bell-heavy high register, and no melodic lead at all. */
  vitrine: {
    bpm: 50, beatsPerBar: 4, root: 35, seed: 163,
    progression: [[0, 'm'], [3, 'M'], [10, 'M'], [0, 'm'], [5, 'm'], [3, 'M7'], [8, 'M'], [0, 'm']],
    pad: { voice: 'strings', gain: 0.25, cutoff: 1700, octave: 1 },
    bass: { style: 'pulse', gain: 0.22, type: 'sine' },
    drums: {
      ridge: { A: '0000000000000000', B: '0000000010000000', gain: 0.15, voice: 'frame' },
    },
    swellEveryBars: 8, swellGain: 0.06,
    arp: { div: 4, densityA: 0.09, densityB: 0.22, type: 'bell', octave: 3, gain: 0.045 },
    bells: { density: 0.07, octave: 3, gain: 0.040 },
  },

  /* VERDIGRIS - "Standing Growth". Canopy mesas over river gorges, and the
     only body Bodies.js calls biotic.

     84 BPM: eight faster than the next quickest planet and quicker than four
     of the eight gateway worlds. That is the whole argument - every other
     surface in the system is a place where nothing is happening, and this one
     is busy.

     Dorian - a minor world with a MAJOR sixth in it - because pure aeolian is
     what the dead planets use and the raised sixth is the single interval that
     turns a minor key green rather than grey.

     Frame drum and brush, both wooden and neither of them a kit, and a dense
     pluck arp: the canopy is the arrangement. */
  verdigris: {
    bpm: 84, beatsPerBar: 4, root: 42, seed: 167,
    progression: [[0, 'm'], [10, 'M'], [5, 'M'], [0, 'm'], [3, 'M'], [10, 'M'], [7, 'm7'], [5, 'M']],
    pad: { voice: 'strings', gain: 0.20, cutoff: 900, octave: 1 },
    bass: { style: 'rootBeat', gain: 0.18, type: 'sine' },
    drums: {
      log: { A: '1000000000100000', B: '1000001000100100', gain: 0.17, voice: 'frame' },
      leaf: { A: '0000100000000000', B: '0000100000001000', gain: 0.06, voice: 'brush' },
    },
    arp: { div: 2, densityA: 0.22, densityB: 0.44, type: 'pluck', octave: 2, gain: 0.070, cutoff: 2800 },
    lead: {
      voice: 'tone', type: 'triangle', octave: 2, gain: 0.10, cutoff: 2200,
      vibHz: 5.6, vibCents: 9, rvb: 0.45, inA: false,
      phrase: [
        [0, 0, 0, 1], [0, 1, 3, 1], [0, 2, 5, 1], [0, 3, 7, 1], [1, 0, 9, 2], [1, 2, 7, 2],
        [2, 0, 5, 1], [2, 1, 3, 1], [2, 2, 5, 2], [3, 0, 0, 4],
        [4, 0, 7, 1], [4, 1, 9, 1], [4, 2, 10, 2], [5, 0, 9, 2], [5, 2, 5, 2],
        [6, 0, 3, 1], [6, 1, 5, 1], [6, 2, 7, 2], [7, 0, 0, 3.5],
      ],
    },
    bells: { density: 0.05, octave: 3, gain: 0.035 },
  },

  /* LATHE - "Ringlight". The shepherd moon, airless, with Ceraunus and the
     whole of its ring system filling the sky.

     The other vacuum world, and deliberately the OPPOSITE of Tessera under the
     same rule. No percussion on either - see the header - but where Tessera is
     a drone with the thirds taken out and no melody at all, Lathe is a choir,
     a riser every four bars and one long held line that climbs and does not
     come back down. The progression ends on bIII MAJOR rather than on the
     minor root: eight bars that open out instead of closing, which is what is
     actually over your head when you stand there.

     `inA: true` on the lead, so the tune is present in the restrained half of
     the cycle as well. The view does not have a quiet half either. */
  lathe: {
    bpm: 44, beatsPerBar: 4, root: 44, seed: 173,
    progression: [[0, 'm'], [0, 'm'], [3, 'M'], [3, 'M'], [7, 'm'], [8, 'M'], [10, 'M'], [3, 'M']],
    pad: { voice: 'choir', gain: 0.29, octave: 1 },
    bass: { style: 'drone', gain: 0.23, type: 'sine' },
    drums: {},
    swellEveryBars: 4, swellGain: 0.055,
    arp: { div: 4, densityA: 0.05, densityB: 0.13, type: 'sine', octave: 3, gain: 0.035, cutoff: 1600 },
    lead: {
      voice: 'tone', type: 'sine', octave: 2, gain: 0.12, cutoff: 1900,
      vibHz: 3.4, vibCents: 11, vibDelay: 0.7, rvb: 0.7, inA: true,
      phrase: [
        [0, 0, 0, 4], [1, 0, 3, 4],
        [2, 0, 7, 2], [2, 2, 10, 2], [3, 0, 12, 4],
        [4, 0, 10, 2], [4, 2, 7, 2], [5, 0, 8, 4],
        [6, 0, 10, 2], [6, 2, 12, 2], [7, 0, 15, 4],
      ],
    },
    bells: { density: 0.045, octave: 3, gain: 0.038 },
  },

  /* CARNELIAN - "Ironfall". Red iron highlands: scarps, dust, one very deep
     gorge, and thin air over all of it.

     The only planet with a PULSE you could walk to. Thin air means a short
     descent with the ground in sight the whole way - the opposite of Sirocco,
     and the arrangement is the opposite too: where Sirocco refuses to land on
     a root, Carnelian hits one on every downbeat with a taiko under it.

     Brass stabs on the bar line, and they are the only stabs on any surface.
     A stab is a hit of ensemble, which is normally a settlement noise; it
     works here because Carnelian's identity is GEOLOGY rather than emptiness,
     and a scarp face is a struck thing. `inA: false` keeps them out of the
     restrained half so the world still has somewhere quiet to be.

     The tick is a hat used dry and off the beat: iron dust, not a kit. */
  carnelian: {
    bpm: 76, beatsPerBar: 4, root: 41, seed: 179,
    progression: [[0, 'm'], [10, 'M'], [8, 'M'], [0, 'm'], [3, 'M'], [10, 'M'], [0, 'm'], [7, 'm']],
    pad: { voice: 'strings', gain: 0.22, cutoff: 640, octave: 1 },
    bass: { style: 'rootBeat', gain: 0.23, type: 'sine' },
    drums: {
      scarp: { A: '1000000000000000', B: '1000000010001000', gain: 0.25, voice: 'taiko', pitch: 68 },
      grit: { A: '0000001000000010', B: '0010001000100010', gain: 0.040, voice: 'hat' },
    },
    stabs: { pattern: '1000000000000000', gain: 0.11, octave: 1, inA: false },
    arp: { div: 4, densityA: 0.08, densityB: 0.19, type: 'triangle', octave: 2, gain: 0.045, cutoff: 1700 },
    bells: { density: 0.035, octave: 3, gain: 0.032 },
  },

  /* SALLOW - "Yellow Overcast". Acid lakes and fumarole fields under
     permanent yellow cloud, and the body Bodies.js describes as "somewhere
     you have to decide to go".

     So the score has to be UNPLEASANT without being unlistenable, and the way
     it does that is the progression: the root minor and the chord a TRITONE
     above it, alternating, four times in eight bars. A tritone is the one
     interval in twelve-tone music with no resolution in either direction - it
     is the same distance up as it is down - so the cycle never decides where
     home is. Nothing else in the game uses one.

     46 BPM: the slowest score that still has a drum. That drum is one frame
     hit, off the grid, in the B half only, and it is a VENT rather than a
     pulse - which is why it sits on step 11 and not on any beat.

     Murky pad (cutoff 420, the darkest in the game), no lead, dull bells. */
  sallow: {
    bpm: 46, beatsPerBar: 4, root: 45, seed: 181,
    progression: [[0, 'm'], [6, 'M'], [0, 'm'], [6, 'M'], [1, 'M'], [0, 'm'], [6, 'm'], [0, 'm']],
    pad: { voice: 'strings', gain: 0.27, cutoff: 420, octave: 1 },
    bass: { style: 'drone', gain: 0.25, type: 'sine' },
    drums: {
      vent: { A: '0000000000000000', B: '0000000000010000', gain: 0.14, voice: 'frame' },
    },
    swellEveryBars: 8, swellGain: 0.05,
    arp: { div: 4, densityA: 0.04, densityB: 0.09, type: 'sine', octave: 2, gain: 0.032, cutoff: 900 },
    bells: { density: 0.03, octave: 2, gain: 0.030 },
  },

  /* CATHEDRA - "The Hollow Vault". Shattered crystal plates, spire fields and
     a hollow vault, 288 km out and the last thing in the system.

     Every chord is a SEVENTH - four notes where the rest of the game mostly
     plays three - because a triad is a solid and a seventh chord is a solid
     with something ringing inside it, which is the whole planet in one
     decision. Only two chords in the eight bars are minor; the rest are major
     sevenths, so the world reads as luminous rather than as dead.

     The one struck voice is a taiko at 190 Hz. Every other taiko authored in
     this table runs 54-82 - a drum. At 190 the same synth is a PLATE being
     rung, and that is the only percussion a crystal world can honestly have.

     A bell lead and the densest bell scatter of the nine, in the highest
     octave: from orbit Cathedra is legible by its cracks rather than by its
     disc - see Bodies.js on why `fissure` is brighter than `high` here - and
     this is that, heard from underneath. */
  cathedra: {
    bpm: 52, beatsPerBar: 4, root: 32, seed: 191,
    progression: [[0, 'M7'], [4, 'm7'], [9, 'M7'], [2, 'm7'], [7, 'M7'], [0, 'M7'], [5, 'M7'], [7, 'M']],
    pad: { voice: 'choir', gain: 0.28, octave: 1 },
    bass: { style: 'drone', gain: 0.21, type: 'sine' },
    drums: {
      plate: { A: '1000000000000000', B: '1000000000100000', gain: 0.16, voice: 'taiko', pitch: 190 },
    },
    swellEveryBars: 8, swellGain: 0.06,
    arp: { div: 2, densityA: 0.12, densityB: 0.28, type: 'bell', octave: 3, gain: 0.045 },
    lead: {
      voice: 'bell', octave: 2, gain: 0.12, inA: false,
      phrase: [
        [0, 0, 0, 2], [0, 2, 7, 1], [0, 3, 11, 1], [1, 0, 12, 2], [1, 2, 7, 2],
        [2, 0, 9, 2], [2, 2, 4, 1], [2, 3, 2, 1], [3, 0, 0, 4],
        [4, 0, 7, 1], [4, 1, 11, 1], [4, 2, 14, 2], [5, 0, 12, 2], [5, 2, 7, 2],
        [6, 0, 5, 2], [6, 2, 9, 2], [7, 0, 7, 3.5],
      ],
    },
    bells: { density: 0.12, octave: 4, gain: 0.038 },
  },

  /* RACE - "Redline". 140 BPM synth rock in E minor: 16th-note saw bass
     ostinato, full kit, crash every 4 bars, power-chord stabs. */
  race: {
    bpm: 140, beatsPerBar: 4, root: 40, seed: 67,
    progression: [[0, 'm'], [0, 'm'], [8, 'M'], [10, 'M'], [0, 'm'], [8, 'M'], [5, 'M'], [10, 'M']],
    pad: { voice: 'strings', gain: 0.13, cutoff: 900, octave: 1 },
    bass: { style: 'ostinato', gain: 0.19, type: 'sawtooth', cutoff: 640 },
    drums: {
      kick: { A: '1000100010001000', B: '1000100110001010', gain: 0.30, voice: 'kick' },
      snare: { A: '0000100000001000', B: '0000100000001000', gain: 0.17, voice: 'snare' },
      hat: { A: '1010101010101010', B: '2111211121112111', gain: 0.045, voice: 'hat' },
      crash: { A: '', B: '', gain: 0.10, voice: 'crash', everyBars: 4 },
    },
    stabs: { pattern: '1000000010000000', gain: 0.13, octave: 1, power: true, inA: false },
    lead: {
      voice: 'tone', type: 'sawtooth', octave: 1, gain: 0.12, cutoff: 2700,
      vibHz: 6.2, vibCents: 9, rvb: 0.3, inA: false,
      phrase: [
        [0, 0, 0, 0.5], [0, 0.5, 3, 0.5], [0, 1, 5, 0.5], [0, 1.5, 7, 0.5], [0, 2, 10, 2],
        [1, 0, 7, 1.5], [1, 1.5, 5, 0.5], [1, 2, 3, 2],
        [2, 0, 5, 0.5], [2, 0.5, 7, 0.5], [2, 1, 10, 0.5], [2, 1.5, 12, 0.5], [2, 2, 7, 2],
        [3, 0, 3, 1], [3, 1, 5, 1], [3, 2, 7, 2],
        [4, 0, 0, 0.5], [4, 0.5, 3, 0.5], [4, 1, 5, 0.5], [4, 1.5, 7, 0.5], [4, 2, 10, 2],
        [5, 0, 12, 1.5], [5, 1.5, 10, 0.5], [5, 2, 7, 2],
        [6, 0, 8, 1], [6, 1, 7, 1], [6, 2, 5, 1], [6, 3, 3, 1],
        [7, 0, 12, 3.5],
      ],
    },
  },

  /* MAZE - "The Verdant Coil". Mystery waltz in G, 3/4: music-box theme,
     pizzicato on beats 2 and 3, a borrowed minor iv, one lydian wink. */
  maze: {
    bpm: 92, beatsPerBar: 3, root: 43, seed: 83,
    progression: [[0, 'M'], [9, 'm'], [5, 'm'], [0, 'M'], [0, 'M'], [9, 'm'], [2, 'M7'], [7, 'M']],
    pad: { voice: 'strings', gain: 0.15, cutoff: 720, octave: 1 },
    bass: { style: 'waltz', gain: 0.17, type: 'sine' },
    drums: {
      brush: { A: '100000000000', B: '100000000000', gain: 0.05, voice: 'brush' },
    },
    compWaltz: { gain: 0.08, octave: 1, cutoff: 2400 },
    arp: { div: 2, densityA: 0.08, densityB: 0.16, type: 'bell', octave: 2, gain: 0.045 },
    lead: {
      voice: 'bell', octave: 2, gain: 0.13, inA: true,
      phrase: [
        [0, 0, 4, 1], [0, 1, 2, 1], [0, 2, 0, 1], [1, 0, 7, 2], [1, 2, 4, 1],
        [2, 0, 5, 1], [2, 1, 4, 1], [2, 2, 2, 1], [3, 0, 4, 3],
        [4, 0, 4, 1], [4, 1, 5, 1], [4, 2, 6, 1], [5, 0, 7, 2], [5, 2, 9, 1],
        [6, 0, 7, 1], [6, 1, 4, 1], [6, 2, 2, 1], [7, 0, 0, 3],
      ],
    },
    bells: { density: 0.06, octave: 3, gain: 0.04 },
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
    /** Shared noise buffer for percussion, built lazily per context. */
    this._noiseBuf = null;
  }

  /** @returns {boolean} */
  get playing() {
    return this._timer !== null;
  }

  /**
   * Switch to a world's score, cross-fading out of whatever was playing.
   * Re-issuing the current world while stopped (e.g. music toggled back on
   * before the engine was ready) restarts it rather than no-opping.
   * @param {string|null} worldId
   */
  setWorld(worldId) {
    if (worldId === this.worldId) {
      if (!this.playing && this.score && this.engine.ready) this.start();
      return;
    }
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
    this._out.gain.exponentialRampToValueAtTime(1, ctx.currentTime + 2.2);
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

  /* ------------------------------------------------------------------ */
  /* Scheduling                                                          */
  /* ------------------------------------------------------------------ */

  get _stepDur() { return 60 / this.score.bpm / 4; }
  get _stepsPerBar() { return this.score.beatsPerBar * 4; }
  get _barDur() { return this._stepDur * this._stepsPerBar; }

  /** Deterministic per-step noise, so a score is repeatable but not periodic. */
  _rand(n) {
    const x = Math.sin(n * 12.9898 + (this.score?.seed ?? 3) * 78.233) * 43758.5453;
    return x - Math.floor(x);
  }

  /**
   * Queue every step that falls inside the lookahead window. `while` rather
   * than `if` on purpose: after a long frame the window can contain several
   * steps, and scheduling only one would let the music fall behind.
   */
  _schedule() {
    const eng = this.engine;
    if (!eng.ready || !this.score || !this._out) return;
    const ctx = eng.ctx;
    let guard = 0;
    while (this._next < ctx.currentTime + LOOKAHEAD && guard++ < 48) {
      this._emit(this._next, this._step);
      this._next += this._stepDur;
      this._step++;
    }
  }

  _emit(t, step) {
    const s = this.score;
    const spb = this._stepsPerBar;
    const bar = Math.floor(step / spb);
    const sib = step % spb;
    const cycleBar = bar % 16;
    const inB = cycleBar >= 8;
    const sec = inB ? 'B' : 'A';
    const chord = s.progression[cycleBar % s.progression.length];
    const rootM = s.root + chord[0];
    const tones = CHORD[chord[1]] ?? CHORD.M;
    const beat = sib / 4;

    /* pad - struck once per bar */
    if (sib === 0 && s.pad) {
      const p = s.pad;
      const base = rootM + 12 * (p.octave ?? 1);
      const freqs = tones.slice(0, 3).map((o) => hz(base + o));
      const dur = this._barDur * 1.15;
      const g = p.gain * (inB ? 1 : 0.72);
      if (p.voice === 'choir') this._choir(t, freqs, dur, g);
      else if (p.voice === 'drone5') this._strings(t, [hz(rootM), hz(rootM + 7)], dur, g, p.cutoff);
      else this._strings(t, freqs, dur, g, p.cutoff || 900);
    }

    /* bass */
    if (s.bass) this._emitBass(t, sib, rootM, s.bass, inB);

    /* drums */
    if (s.drums) {
      for (const key of Object.keys(s.drums)) {
        const d = s.drums[key];
        let hit = '0';
        if (d.everyBars) {
          if (cycleBar % d.everyBars === 0 && sib === 0) hit = '1';
        } else {
          const pat = d[sec] || d.A;
          hit = (pat && pat[sib]) || '0';
        }
        if (hit === '0') continue;
        this._hitDrum(d.voice, t, d.gain * (hit === '2' ? 1.45 : 1), d.pitch);
      }
    }

    /* riser into the next phrase */
    if (s.swellEveryBars && sib === 0 && cycleBar % s.swellEveryBars === s.swellEveryBars - 1) {
      this._swell(t, this._barDur, s.swellGain ?? 0.06);
    }

    /* stabs (brass / power chords) */
    if (s.stabs && (inB || s.stabs.inA)) {
      const ch = s.stabs.pattern[sib];
      if (ch === '1' || ch === '2') {
        const base = rootM + 12 * (s.stabs.octave ?? 1);
        const freqs = s.stabs.power
          ? [hz(base), hz(base + 7), hz(base + 12)]
          : tones.slice(0, 3).map((o) => hz(base + o));
        this._brass(t, freqs, 0.32, s.stabs.gain);
      }
    }

    /* arp */
    if (s.arp && sib % s.arp.div === 0
      && this._rand(step * 7 + 1) < (inB ? s.arp.densityB : s.arp.densityA)) {
      const a = s.arp;
      const off = tones[Math.floor(this._rand(step * 13 + 3) * tones.length)];
      const note = rootM + off + 12 * a.octave;
      if (a.type === 'bell') this._bell(t, hz(note), a.gain, 1.8);
      else if (a.type === 'pluck') this._pluck(t, hz(note), a.gain, a.cutoff);
      else this._tone(t, hz(note), this._stepDur * a.div * 1.15, a.gain, { type: a.type, cutoff: a.cutoff, attack: 0.01 });
    }

    /* waltz comp - pizzicato chord on beats 2 and 3 */
    if (s.compWaltz && (sib === 4 || sib === 8)) {
      const base = rootM + 12 * s.compWaltz.octave;
      for (const o of tones.slice(0, 3)) {
        this._pluck(t + this._rand(step + o) * 0.012, hz(base + o), s.compWaltz.gain / 2, s.compWaltz.cutoff, 0.4);
      }
    }

    /* lead theme - composed phrase over the 8-bar cycle */
    if (s.lead && (inB || s.lead.inA)) {
      const themeBar = cycleBar % 8;
      const L = s.lead;
      for (const n of L.phrase) {
        if (n[0] !== themeBar || Math.abs(n[1] - beat) > 0.01) continue;
        const note = s.root + n[2] + 12 * (L.octave ?? 2);
        const dur = n[3] * this._stepDur * 4;
        const g = L.gain * (inB ? 1 : 0.55);
        if (L.voice === 'bell') this._bell(t, hz(note), g, Math.max(1.6, dur));
        else {
          this._tone(t, hz(note), dur, g, {
            type: L.type, cutoff: L.cutoff, attack: 0.04,
            vibHz: L.vibHz, vibCents: L.vibCents, vibDelay: L.vibDelay, rvb: L.rvb,
          });
        }
      }
    }

    /* stray high bells */
    if (s.bells && this._rand(step * 29 + 5) < s.bells.density) {
      const off = tones[Math.floor(this._rand(step * 31) * tones.length)];
      this._bell(t, hz(rootM + off + 12 * s.bells.octave), s.bells.gain, 3);
    }
  }

  _emitBass(t, sib, rootM, b, inB) {
    const low = rootM - 12;
    const dur4 = this._stepDur * 4;
    switch (b.style) {
      case 'pulse':
        if (sib === 0) this._tone(t, hz(low), dur4 * 2.4, b.gain, { type: b.type, cutoff: 260, attack: 0.02 });
        else if (sib === 10) this._tone(t, hz(low + 7), dur4, b.gain * 0.55, { type: b.type, cutoff: 260, attack: 0.02 });
        break;
      case 'drone':
        if (sib === 0) this._tone(t, hz(low), this._barDur * 1.1, b.gain, { type: b.type, cutoff: 220, attack: 0.3 });
        break;
      case 'rootBeat':
        if (sib % 8 === 0) this._tone(t, hz(low), dur4 * 1.6, b.gain, { type: b.type, cutoff: 260, attack: 0.02 });
        break;
      case 'eighths':
        if (sib % 2 === 0) {
          const n = sib >= 14 ? low + 7 : low;
          this._tone(t, hz(n), this._stepDur * 1.8, b.gain, { type: b.type, cutoff: b.cutoff || 500, attack: 0.008 });
        }
        break;
      case 'ostinato': {
        const oct = sib === 12 || sib === 14 ? 12 : 0;
        const g = b.gain * (sib % 4 === 0 ? 1 : 0.66) * (inB ? 1 : 0.8);
        this._tone(t, hz(low + oct), this._stepDur * 0.92, g, { type: b.type, cutoff: b.cutoff || 640, attack: 0.004 });
        break;
      }
      case 'waltz':
        if (sib === 0) this._tone(t, hz(low), dur4 * 0.9, b.gain, { type: b.type, cutoff: 300, attack: 0.015 });
        break;
    }
  }

  _hitDrum(voice, t, g, pitch) {
    switch (voice) {
      case 'kick': this._kick(t, g); break;
      case 'snare': this._snare(t, g); break;
      case 'hat': this._hat(t, g); break;
      case 'clap': this._clap(t, g); break;
      case 'crash': this._crash(t, g); break;
      case 'taiko': this._taiko(t, g, pitch || 88); break;
      case 'frame': this._taiko(t, g, 135); break;
      case 'brush': this._brush(t, g); break;
    }
  }

  /* ------------------------------------------------------------------ */
  /* Voices - every instrument is an oscillator or filtered noise         */
  /* ------------------------------------------------------------------ */

  _envGain(t, dur, gain, attack) {
    const g = this.engine.ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(Math.max(gain, 0.0002), t + Math.max(attack, 0.004));
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    g.connect(this._out);
    return g;
  }

  _sendRvb(node, amt) {
    if (amt <= 0 || !this.engine.reverbSend) return;
    const s = this.engine.ctx.createGain();
    s.gain.value = amt;
    node.connect(s);
    s.connect(this.engine.reverbSend);
  }

  /** Generic melodic voice: osc -> lowpass -> env, optional vibrato LFO. */
  _tone(t, freq, dur, gain, o = {}) {
    const ctx = this.engine.ctx;
    if (!ctx || !this._out) return;
    const osc = ctx.createOscillator();
    osc.type = o.type || 'sine';
    osc.frequency.value = freq;
    osc.detune.value = (this._rand(freq + t) - 0.5) * 7;
    const f = ctx.createBiquadFilter();
    f.type = 'lowpass';
    f.frequency.value = o.cutoff || 1500;
    f.Q.value = 0.7;
    const env = this._envGain(t, dur, gain, o.attack ?? Math.min(0.5, dur * 0.3));
    osc.connect(f);
    f.connect(env);
    if (o.vibHz) {
      const lfo = ctx.createOscillator();
      const lg = ctx.createGain();
      lfo.frequency.value = o.vibHz;
      lg.gain.value = o.vibCents || 8;
      lfo.connect(lg);
      lg.connect(osc.detune);
      lfo.start(t + (o.vibDelay ?? 0.25));
      lfo.stop(t + dur + 0.1);
    }
    this._sendRvb(env, o.rvb ?? 0.3);
    osc.start(t);
    osc.stop(t + dur + 0.1);
  }

  /** String ensemble: two detuned saws per pitch, slow attack. */
  _strings(t, freqs, dur, gain, cutoff = 800) {
    const ctx = this.engine.ctx;
    if (!ctx || !this._out) return;
    for (const fr of freqs) {
      for (const det of [-7, 7]) {
        const osc = ctx.createOscillator();
        osc.type = 'sawtooth';
        osc.frequency.value = fr;
        osc.detune.value = det + (this._rand(fr + det) - 0.5) * 4;
        const f = ctx.createBiquadFilter();
        f.type = 'lowpass';
        f.frequency.value = cutoff;
        f.Q.value = 0.5;
        const env = this._envGain(t, dur, gain / (freqs.length * 2), Math.min(0.9, dur * 0.35));
        osc.connect(f);
        f.connect(env);
        this._sendRvb(env, 0.4);
        osc.start(t);
        osc.stop(t + dur + 0.1);
      }
    }
  }

  /** Choir-ish: saw through two formant bandpasses. Dark, vowel-like. */
  _choir(t, freqs, dur, gain) {
    const ctx = this.engine.ctx;
    if (!ctx || !this._out) return;
    for (const fr of freqs) {
      const osc = ctx.createOscillator();
      osc.type = 'sawtooth';
      osc.frequency.value = fr;
      osc.detune.value = (this._rand(fr) - 0.5) * 10;
      const b1 = ctx.createBiquadFilter();
      b1.type = 'bandpass'; b1.frequency.value = 620; b1.Q.value = 1.2;
      const b2 = ctx.createBiquadFilter();
      b2.type = 'bandpass'; b2.frequency.value = 1050; b2.Q.value = 2;
      const env = this._envGain(t, dur, gain / freqs.length, Math.min(1.1, dur * 0.4));
      osc.connect(b1); b1.connect(env);
      osc.connect(b2); b2.connect(env);
      this._sendRvb(env, 0.55);
      osc.start(t);
      osc.stop(t + dur + 0.1);
    }
  }

  /** Brass stab: saw with a fast-opening filter envelope. */
  _brass(t, freqs, dur, gain) {
    const ctx = this.engine.ctx;
    if (!ctx || !this._out) return;
    for (const fr of freqs) {
      const osc = ctx.createOscillator();
      osc.type = 'sawtooth';
      osc.frequency.value = fr;
      osc.detune.value = (this._rand(fr) - 0.5) * 8;
      const f = ctx.createBiquadFilter();
      f.type = 'lowpass';
      f.Q.value = 1.4;
      f.frequency.setValueAtTime(420, t);
      f.frequency.exponentialRampToValueAtTime(2300, t + 0.06);
      f.frequency.exponentialRampToValueAtTime(700, t + dur);
      const env = this._envGain(t, dur, gain / freqs.length, 0.02);
      osc.connect(f);
      f.connect(env);
      this._sendRvb(env, 0.25);
      osc.start(t);
      osc.stop(t + dur + 0.1);
    }
  }

  /** Plucked string / lute / pizzicato: triangle, instant decay. */
  _pluck(t, freq, gain, cutoff = 2200, dur = 0.5) {
    const ctx = this.engine.ctx;
    if (!ctx || !this._out) return;
    const osc = ctx.createOscillator();
    osc.type = 'triangle';
    osc.frequency.value = freq;
    const f = ctx.createBiquadFilter();
    f.type = 'lowpass';
    f.frequency.value = cutoff;
    const env = this._envGain(t, dur, gain, 0.005);
    osc.connect(f);
    f.connect(env);
    this._sendRvb(env, 0.3);
    osc.start(t);
    osc.stop(t + dur + 0.1);
  }

  /** Music box / celesta bell: sine + inharmonic partial, long ring. */
  _bell(t, freq, gain, dur = 2.6) {
    const ctx = this.engine.ctx;
    if (!ctx || !this._out) return;
    for (const pair of [[1, gain], [4.16, gain * 0.28]]) {
      const osc = ctx.createOscillator();
      osc.type = 'sine';
      osc.frequency.value = freq * pair[0];
      const env = this._envGain(t, dur, pair[1], 0.004);
      osc.connect(env);
      this._sendRvb(env, 0.7);
      osc.start(t);
      osc.stop(t + dur + 0.1);
    }
  }

  /* ── percussion ──────────────────────────────────────────────────── */

  _noise() {
    const ctx = this.engine.ctx;
    if (!this._noiseBuf || this._noiseBuf.sampleRate !== ctx.sampleRate) {
      const len = ctx.sampleRate * 2;
      this._noiseBuf = ctx.createBuffer(1, len, ctx.sampleRate);
      const d = this._noiseBuf.getChannelData(0);
      for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
    }
    return this._noiseBuf;
  }

  _noiseVoice(t, dur, gain, filterType, freq, Q = 1, attack = 0.002) {
    const ctx = this.engine.ctx;
    if (!ctx || !this._out) return null;
    const src = ctx.createBufferSource();
    src.buffer = this._noise();
    src.loop = true;
    src.playbackRate.value = 0.9 + this._rand(t * 997) * 0.2;
    const f = ctx.createBiquadFilter();
    f.type = filterType;
    f.frequency.value = freq;
    f.Q.value = Q;
    const env = this._envGain(t, dur, gain, attack);
    src.connect(f);
    f.connect(env);
    src.start(t);
    src.stop(t + dur + 0.05);
    return env;
  }

  _kick(t, gain) {
    const ctx = this.engine.ctx;
    if (!ctx || !this._out) return;
    const osc = ctx.createOscillator();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(115, t);
    osc.frequency.exponentialRampToValueAtTime(42, t + 0.11);
    const env = this._envGain(t, 0.34, gain, 0.002);
    osc.connect(env);
    osc.start(t);
    osc.stop(t + 0.4);
    this._noiseVoice(t, 0.02, gain * 0.4, 'highpass', 1200);
  }

  _taiko(t, gain, pitch = 88) {
    const ctx = this.engine.ctx;
    if (!ctx || !this._out) return;
    const osc = ctx.createOscillator();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(pitch, t);
    osc.frequency.exponentialRampToValueAtTime(pitch * 0.55, t + 0.25);
    const env = this._envGain(t, 0.85, gain, 0.003);
    osc.connect(env);
    this._sendRvb(env, 0.35);
    osc.start(t);
    osc.stop(t + 0.95);
    this._noiseVoice(t, 0.06, gain * 0.35, 'bandpass', 420, 0.8);
  }

  _snare(t, gain) {
    const ctx = this.engine.ctx;
    if (!ctx || !this._out) return;
    this._noiseVoice(t, 0.18, gain, 'bandpass', 1800, 0.7);
    const osc = ctx.createOscillator();
    osc.type = 'triangle';
    osc.frequency.value = 190;
    const env = this._envGain(t, 0.1, gain * 0.5, 0.002);
    osc.connect(env);
    osc.start(t);
    osc.stop(t + 0.15);
  }

  _hat(t, gain) { this._noiseVoice(t, 0.045, gain, 'highpass', 6800, 1); }
  _clap(t, gain) { this._noiseVoice(t, 0.16, gain, 'bandpass', 1450, 1.4, 0.008); }
  _crash(t, gain) { this._noiseVoice(t, 1.3, gain, 'highpass', 5200, 0.6, 0.004); }
  _brush(t, gain) { this._noiseVoice(t, 0.35, gain, 'bandpass', 3000, 0.8, 0.05); }

  /** Cinematic riser: filtered noise swelling across `dur`, cut at the peak. */
  _swell(t, dur, gain) {
    const ctx = this.engine.ctx;
    if (!ctx || !this._out) return;
    const src = ctx.createBufferSource();
    src.buffer = this._noise();
    src.loop = true;
    const f = ctx.createBiquadFilter();
    f.type = 'bandpass';
    f.Q.value = 1.1;
    f.frequency.setValueAtTime(500, t);
    f.frequency.exponentialRampToValueAtTime(3200, t + dur);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(gain, t + dur);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur + 0.09);
    src.connect(f);
    f.connect(g);
    g.connect(this._out);
    this._sendRvb(g, 0.5);
    src.start(t);
    src.stop(t + dur + 0.2);
  }

  dispose() {
    this._fadeOut();
    this._noiseBuf = null;
  }
}

export default Music;
