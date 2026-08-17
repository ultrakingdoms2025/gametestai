import './race.css';
import { PLAYER_GRID_SLOT, RACE_TYPES, DIFFICULTY_FIELD } from '../race/RaceManager.js';

/** One line each, because "expert" on its own does not tell anyone what changes. */
/* Difficulty changes the circuit, not just the field, so the blurb has to say
 * what gets added to the road as well as who you are racing. A player who picks
 * EXPERT and then hits a barrier that was not there last time should have been
 * told. */
const RACE_TYPE_BLURB = {
  car: 'Classic ground race in the Interceptor.',
  dragon: 'Aerial race on dragons through ordered floating rings.',
};

/* The footer names the machine and how a lap is validated, and BOTH differ by
 * race type - so it is rebuilt in `_syncPicks` alongside the other facts rather
 * than written once in the constructor. It WAS written once, which is why a
 * dragon race told the player they were racing the Interceptor and warned them
 * about reversing over a line they never drive across.
 *
 * The payout sentence is shared because the payout is: `_classify` pays the
 * same RACE_PRIZES podium and the same 1 credit per drop for both types. */
const RACE_TYPE_NOTE = {
  car:
    'You race in the Interceptor — it is summoned onto the grid for you. '
    + 'Checkpoints must be taken in order, so cutting the circuit or reversing '
    + 'over the line will not count a lap.',
  dragon:
    'You race on your dragon — it is summoned onto the grid for you. '
    + 'The rings must be flown in order, so cutting the circuit or crossing '
    + 'back over the line will not count a lap.',
};
const RACE_NOTE_PAYOUT =
  ' Podium pays 10 / 5 / 2 credits, and drops pay 1 each whether or not you finish.';

/** Footer text for a race type, falling back to the car wording. */
function raceNote(type) {
  return (RACE_TYPE_NOTE[type] ?? RACE_TYPE_NOTE.car) + RACE_NOTE_PAYOUT;
}

/* The internal difficulty keys are easy/standard/expert; the player sees
 * EASY / MEDIUM / HARD. Kept as a display map rather than renaming the keys,
 * which are baked into saves and the economy. */
const DIFFICULTY_LABEL = { easy: 'EASY', standard: 'MEDIUM', expert: 'HARD' };
function diffLabel(id) {
  return DIFFICULTY_LABEL[id] ?? String(id ?? '').toUpperCase();
}

/* Everything except the lap count, which is per circuit and gets prepended by
 * `_diffBlurb`. Cinder Gorge and Aurora Rise are 300 m shorter than Vellum and
 * run a lap more to compensate, so a fixed "5 laps" here would be wrong on two
 * circuits out of three. */
const DIFFICULTY_BLURB = {
  easy: 'start 5th of 10. A slower field — win by driving cleanly.',
  standard: 'start 10th of 15. Rivals are faster — spend mount powers.',
  expert: 'start 15th of 20. Brutal pace — powers are mandatory.',
};

/**
 * Race front end: grid setup, live readout, chequered flag.
 *
 * Three surfaces, and they are deliberately not one:
 *
 *  - **The panel** (difficulty picker, start) is modal. It releases the pointer
 *    like every other menu here, which raises the pause overlay behind it, so
 *    it has to sit at the top of the overlay ladder or the pause sheet eats the
 *    clicks meant for the buttons. That exact tie is what made the audio
 *    sliders unusable, so the ladder is: pause 60, weapon strip 62, wipe 70,
 *    help/inventory 80, character 82, mountwheel 83, audio 84 — and this at 86.
 *    Above audio because a race can only be started from here and a panel that
 *    can be covered by a menu the player did not open is a dead end.
 *  - **The board** shares 86 for the same reason: it appears the instant the
 *    flag falls, when the pointer has been released, and has to be clickable.
 *  - **The live readout** is not a menu at all. It is HUD furniture — position,
 *    lap, clock — so it sits *below* everything at 12 with pointer events off.
 *    Putting it in the modal band would have it swallow mouse input for the
 *    whole race, which is the one thing that must never happen while driving.
 *
 * Everything is built once in the constructor and toggled by class, so a race
 * costs class writes and text updates rather than layout churn on a frame where
 * ten cars are already being simulated.
 */

const ORDINALS = ['0th', '1st', '2nd', '3rd', '4th', '5th', '6th', '7th', '8th', '9th', '10th',
  '11th', '12th', '13th', '14th', '15th', '16th', '17th', '18th', '19th', '20th'];

/* Fallback only, for a world that publishes no lap table of its own - the
 * synthetic test circuit, mostly. Real circuits state their own; see
 * `_lapsFor`, which reads them off the selected track. Mirroring RaceWorld's
 * numbers here is what this used to do, and it was wrong the moment a second
 * circuit with a different lap count existed. */
const RACE_LAPS = { easy: 3, standard: 5, expert: 10 };

function el(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
}

function ordinal(n) {
  return ORDINALS[n] ?? `${n}th`;
}

/** `m:ss.mm`. Racing reads hundredths, not milliseconds. */
function clockText(seconds) {
  if (!(seconds > 0)) return '—';
  const m = Math.floor(seconds / 60);
  const s = seconds - m * 60;
  return `${m}:${s < 10 ? '0' : ''}${s.toFixed(2)}`;
}

function hexCss(v) {
  return `#${(v >>> 0).toString(16).padStart(6, '0').slice(-6)}`;
}

export class RaceUI {
  /**
   * @param {{root:HTMLElement, bus:any, input:any,
   *          race:import('../race/RaceManager.js').RaceManager}} ctx
   */
  constructor({ root, bus, input, race }) {
    this.bus = bus ?? null;
    this.input = input ?? null;
    this.race = race ?? null;
    this._panelOpen = false;
    this._boardOpen = false;
    this._stopOpen = false;
    this._flash = 0;
    this._dropFlash = 0;
    /* Collected since the last frame that drew them. Driving through two in one
     * step emits one event with a count of two, and the readout has to say +2
     * rather than +1 twice or the number stops matching the wallet. */
    this._dropGain = 0;
    this._lastCount = -1;

    this.el = this._build();
    root.appendChild(this.el);

    // Own the key rather than polling `input.pressed()`: Input stops reporting
    // during a portal transition and while text is captured, and "the race
    // panel will not open" is exactly the dead end that costs a bug report.
    this._onKey = (e) => {
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      if (e.code === 'Enter') {
        /* Start, from wherever you are.
         *
         * The panel's button is the only other way in, and a player who closed
         * it to look at the circuit had to go back through a function key to
         * begin - so the start was manual but not *reachable*. Guarded on the
         * race being armed and idle, so Enter stays free everywhere else, and
         * on text capture, so it still means "send" in chat.
         */
        if (this.input?.textCaptured) return;
        /* Playing, or standing in this panel.
         *
         * We register before the HUD does (main.js:285 vs :421), so with the
         * Esc hub up this branch would run first, start a race behind it and
         * swallow the Enter the hub needed to activate the focused item. The
         * lock test covers every cursor-owning panel without naming one.
         *
         * But `openPanel` exits the lock itself, so the bare test also locked
         * out the panel that exists to start races: the START button worked and
         * Enter, two inches away, did nothing. `_panelOpen` is safe to add
         * because it and "the hub is up" are mutually exclusive - the hub
         * refuses to show while the Set is non-empty, and `race:menu` puts
         * `race` in the Set for exactly as long as this panel is open. */
        if (!this._panelOpen && !this.input?.locked) return;
        if (this._stopOpen || this._boardOpen || !this.race?.ready || this.race.state !== 'idle') return;
        e.preventDefault();
        this.closePanel();
        this.race.start(this.race.difficulty);
      } else if (e.code === 'Escape') {
        if (this._stopOpen) this._closeStop();
        else if (this._boardOpen) this._closeBoard();
        else if (this._panelOpen) this.closePanel();
      }
    };
    window.addEventListener('keydown', this._onKey, true);

    this._offs = [];
    if (bus) {
      /* Has the player actually entered the world yet?
       *
       * Booting straight into a race world - a save that was made here, or
       * ?world=race - arms the circuit while the title card is still up, which
       * used to raise this panel *behind* it. The click that dismisses the card
       * then takes pointer lock, and the player is left looking at a modal menu
       * with no cursor to press its buttons and no Escape either, because a
       * pointer-locked Chrome swallows Escape to release the lock rather than
       * delivering it to the page. The only way out was to start the race.
       *
       * So the auto-open waits for `game:started`. Opening after the click
       * means `openPanel`'s `exitLock()` has something to release, the cursor
       * comes back, and every way out of the panel works. */
      this._started = false;
      this._openWhenStarted = false;
      this._offs.push(bus.on('game:started', () => {
        this._started = true;
        if (this._openWhenStarted) {
          this._openWhenStarted = false;
          if (!this.race?.racing) this.openPanel();
        }
      }));
      /* A lock taken while a sheet is up would hide the cursor the sheet needs.
       * Nothing here asks for one, but the boot click, the standby overlay and
       * HUD's relock timer all can, so the invariant is enforced rather than
       * assumed: while any race sheet is open, the pointer stays free. */
      this._offs.push(bus.on('input:lockchange', ({ locked }) => {
        if (locked && this.isOpen) this.input?.exitLock?.();
      }));
      // Arriving on a circuit opens the picker unprompted. A player who has
      // just driven through a portal onto a start/finish straight should not
      // have to discover a function key to find out what the place is for.
      this._offs.push(bus.on('race:armed', () => {
        this._syncPanel();
        if (this.race?.racing) return;
        if (this._started) this.openPanel();
        else this._openWhenStarted = true;
      }));
      this._offs.push(bus.on('race:lights', (e) => this._showLights(e)));
      this._offs.push(bus.on('race:started', () => {
        this.closePanel();
        this._closeBoard();
        this._closeStop();
      }));
      this._offs.push(bus.on('race:lap', (e) => { if (e.isPlayer) this._flash = 1.2; }));
      this._offs.push(bus.on('race:pickup', (e) => {
        this._dropFlash = 0.5;
        this._dropGain += e?.count ?? 1;
      }));
      /* The loop, called out as it happens.
       *
       * Going over the top is the one thing on any of these circuits that the
       * player does not do by steering, and a set piece that passes without the
       * game acknowledging it reads as scenery you happened to drive through.
       * Two words on exit, and only on exit - announcing the entry would put a
       * caption up at the exact moment there is something worth looking at. */
      this._offs.push(bus.on('race:loop', (e) => {
        if (e?.state === 'exit') this._callout('360° CLEARED');
      }));
      this._offs.push(bus.on('race:finished', (e) => { this._closeStop(); this._showBoard(e); }));
      this._offs.push(bus.on('race:aborted', () => { this._closeStop(); this._closeBoard(); }));
    }
  }

  get isOpen() {
    return this._panelOpen || this._boardOpen || this._stopOpen;
  }

  /** The circuit currently armed, as the picker sees it. */
  get track() {
    const id = this.race?.trackId;
    const list = this.race?.tracks ?? [];
    return list.find((t) => t.id === id) ?? list[0] ?? null;
  }

  /** Laps this circuit runs at this difficulty. */
  _lapsFor(diff) {
    return this.track?.laps?.[diff] ?? RACE_LAPS[diff] ?? this.race?.lapCount ?? 3;
  }

  /** "5 laps · start 10th of 15. ..." */
  _diffBlurb(id) {
    const n = this._lapsFor(id);
    const rest = DIFFICULTY_BLURB[id] ?? '';
    return rest ? `${n} lap${n === 1 ? '' : 's'} · ${rest}` : `${n} laps`;
  }

  /* ------------------------------------------------------------------ */
  /* Markup                                                              */
  /* ------------------------------------------------------------------ */

  _build() {
    const wrap = el('div', 'rc');

    /* ---- live readout ------------------------------------------------ */
    const hud = el('div', 'rc-hud');
    this.posBox = el('div', 'rc-pos');
    this.posNum = el('div', 'rc-pos-n', '—');
    this.posOf = el('div', 'rc-pos-of', '/ 10');
    this.posBox.append(this.posNum, this.posOf);

    const stack = el('div', 'rc-stack');
    this.lapRow = el('div', 'rc-stat');
    this.lapRow.append(el('span', 'rc-k', 'LAP'), (this.lapVal = el('span', 'rc-v', '0/3')));
    this.timeRow = el('div', 'rc-stat');
    this.timeRow.append(el('span', 'rc-k', 'TIME'), (this.timeVal = el('span', 'rc-v', '0:00.00')));
    this.lastRow = el('div', 'rc-stat rc-dim');
    this.lastRow.append(el('span', 'rc-k', 'LAST'), (this.lastVal = el('span', 'rc-v', '—')));
    this.bestRow = el('div', 'rc-stat rc-dim');
    this.bestRow.append(el('span', 'rc-k', 'BEST'), (this.bestVal = el('span', 'rc-v', '—')));
    // Rings only exist in the dragon race; hidden by default and switched on by
    // the frame tick when the circuit reports a ring count.
    this.ringRow = el('div', 'rc-stat rc-ring off');
    this.ringRow.append(el('span', 'rc-k', 'RINGS'), (this.ringVal = el('span', 'rc-v', '0/0')));
    // Drops sit last and carry their own accent, because unlike the four rows
    // above it they are the only line a player can change by *steering* rather
    // than by going faster.
    this.dropRow = el('div', 'rc-stat rc-drop');
    this.dropRow.append(el('span', 'rc-k', 'DROPS'), (this.dropVal = el('span', 'rc-v', '0')));
    stack.append(this.lapRow, this.timeRow, this.lastRow, this.bestRow, this.ringRow, this.dropRow);
    hud.append(this.posBox, stack);
    wrap.appendChild(hud);
    this.hudEl = hud;

    /* ---- armed prompt -------------------------------------------------
     * Shown whenever a circuit is loaded and no race is running. Without it
     * the only evidence that this world does anything is a function key the
     * player has to already know about. */
    this.readyEl = el('div', 'rc-ready');
    this.readyBtn = el('button', 'rc-ready-go', 'START RACE');
    this.readyBtn.type = 'button';
    this.readyBtn.addEventListener('click', (ev) => {
      ev.stopPropagation();
      if (!this.race?.ready) return;
      this.closePanel();
      this.race.start(this.race.difficulty);
    });
    this.readyMeta = el('div', 'rc-ready-meta');
    // Named at runtime: there are three circuits and this prompt appears at
    // whichever one is armed.
    this.readyName = el('div', 'rc-ready-k', 'Circuit');
    this.readyEl.append(this.readyName, this.readyBtn, this.readyMeta);
    wrap.appendChild(this.readyEl);

    /* ---- start lights -------------------------------------------------
     * A repeat of the gantry rather than a number. The gantry is behind you on
     * the grid and out of shot the moment the camera settles, so without this
     * the player is being asked to react to a signal they cannot see - and a
     * "3, 2, 1" tells them exactly when the off is, which is the one thing an
     * F1 start deliberately does not. */
    this.countEl = el('div', 'rc-count');
    this.lightsEl = el('div', 'rc-lights');
    this.lightEls = [];
    for (let i = 0; i < 5; i++) {
      const col = el('div', 'rc-light');
      col.append(el('i', null), el('i', null));
      this.lightsEl.appendChild(col);
      this.lightEls.push(col);
    }
    this.countNum = el('div', 'rc-count-n', '');
    this.countEl.append(this.lightsEl, this.countNum);
    wrap.appendChild(this.countEl);

    /* ---- callout ------------------------------------------------------
     * One line, low in the frame, for something the player just did rather
     * than something they have to read. Pointer events off: it appears while
     * they are driving. */
    this.calloutEl = el('div', 'rc-callout', '');
    wrap.appendChild(this.calloutEl);

    /* ---- setup panel ------------------------------------------------- */
    const panel = el('div', 'rc-sheet rc-panel');
    const card = el('div', 'rc-card');
    const head = el('div', 'rc-head');
    const titles = el('div', null);
    this.panelKicker = el('div', 'rc-kicker', 'Circuit');
    titles.append(this.panelKicker, el('div', 'rc-title', 'RACE'));
    /* A button, not a hint.
     *
     * This was a line of text reading "F7 or Esc to close", which is fine right
     * up until one of those keys does not arrive - and while the pointer is
     * locked, Escape never does, because the browser eats it to release the
     * lock. A panel whose only exits are keys is a panel that can strand a
     * player, so the mouse gets one too. */
    const close = el('button', 'rc-close');
    close.type = 'button';
    close.title = 'Close (Esc)';
    close.append(el('b', null, 'Esc'), el('span', null, 'to close'), el('i', 'rc-close-x', '✕'));
    close.addEventListener('click', (ev) => {
      ev.stopPropagation();
      this.closePanel();
    });
    head.append(titles, close);

    const facts = el('div', 'rc-facts');
    this.factVehicle = this._fact(facts, 'Vehicle', 'CAR');
    this.factLaps = this._fact(facts, 'Laps', '3');
    this.factField = this._fact(facts, 'Grid', '10 cars');
    this.factGrid = this._fact(facts, 'You start', '5th');
    this.factDrops = this._fact(facts, 'Drops', '—');

    /* ---- circuit ------------------------------------------------------
     *
     * First, above race type and difficulty, because it is the choice the other
     * two are made *about*: five laps of the gorge and five laps of the ridge
     * are not the same race, and picking the length of a lap before picking
     * which lap it is reads backwards. */
    const trackLabel = el('div', 'rc-section', 'Circuit');
    this.trackLabelEl = trackLabel;
    this.trackEl = el('div', 'rc-picks rc-tracks');
    this._trackButtons = new Map();
    this._trackKey = null;

    const typeLabel = el('div', 'rc-section', 'Race type');
    this.typeEl = el('div', 'rc-picks');
    this._typeButtons = new Map();
    this._typeKey = null;

    const pickLabel = el('div', 'rc-section', 'Difficulty');
    this.pickEl = el('div', 'rc-picks');
    this._pickButtons = new Map();
    this._pickDescs = new Map();

    this.startBtn = el('button', 'rc-start', 'START RACE');
    this.startBtn.type = 'button';
    this.startBtn.addEventListener('click', () => {
      if (!this.race?.ready) return;
      this.closePanel();
      this.race.start(this.race.difficulty);
    });

    // Empty: `_syncPicks` fills it, and runs before the panel is ever shown.
    this.noteEl = el('div', 'rc-foot', '');

    card.append(head, facts, trackLabel, this.trackEl, typeLabel, this.typeEl,
      pickLabel, this.pickEl, this.startBtn, this.noteEl);
    panel.appendChild(card);
    // Clicks inside the card must not reach the canvas, which would request
    // pointer lock and close the panel from under the player.
    card.addEventListener('mousedown', (e) => e.stopPropagation());
    card.addEventListener('click', (e) => e.stopPropagation());
    panel.addEventListener('click', () => this.closePanel());
    wrap.appendChild(panel);
    this.panelEl = panel;

    /* ---- leaderboard -------------------------------------------------- */
    const board = el('div', 'rc-sheet rc-board');
    const bcard = el('div', 'rc-card rc-card-wide');
    const bhead = el('div', 'rc-head');
    const btitles = el('div', null);
    this.boardKicker = el('div', 'rc-kicker', 'Chequered flag');
    this.boardTitle = el('div', 'rc-title', 'RESULTS');
    btitles.append(this.boardKicker, this.boardTitle);
    this.boardBadge = el('div', 'rc-badge', '');
    bhead.append(btitles, this.boardBadge);

    const table = el('div', 'rc-table');
    const thead = el('div', 'rc-tr rc-th');
    thead.append(
      el('span', 'rc-c-pos', 'POS'),
      el('span', 'rc-c-name', 'DRIVER'),
      el('span', 'rc-c-time', 'TIME'),
      el('span', 'rc-c-gap', 'GAP'),
      el('span', 'rc-c-best', 'BEST LAP'),
      el('span', 'rc-c-cr', 'CR')
    );
    table.appendChild(thead);
    this.rowsEl = el('div', 'rc-rows');
    table.appendChild(this.rowsEl);

    const actions = el('div', 'rc-actions');
    this.againBtn = el('button', 'rc-start', 'RACE AGAIN');
    this.againBtn.type = 'button';
    this.againBtn.addEventListener('click', () => {
      this._closeBoard();
      this.race?.reset();
      this.openPanel();
    });
    const doneBtn = el('button', 'rc-ghost', 'CLOSE');
    doneBtn.type = 'button';
    doneBtn.addEventListener('click', () => {
      this._closeBoard();
      this.race?.reset();
    });
    actions.append(this.againBtn, doneBtn);

    bcard.append(bhead, table, actions);
    board.appendChild(bcard);
    bcard.addEventListener('mousedown', (e) => e.stopPropagation());
    bcard.addEventListener('click', (e) => e.stopPropagation());
    wrap.appendChild(board);
    this.boardEl = board;

    /* ---- in-race stop confirm ---------------------------------------- *
     * F7 during a race must not reopen the setup picker (you can't change the
     * grid mid-race), so it raises this instead: a single decision, stop or
     * carry on. Shares .rc-sheet so it hit-tests and hides like the others. */
    const stop = el('div', 'rc-sheet rc-stop');
    const scard = el('div', 'rc-card');
    const shead = el('div', 'rc-head');
    const stitles = el('div', null);
    stitles.append(el('div', 'rc-kicker', 'In progress'), el('div', 'rc-title', 'STOP RACE?'));
    shead.append(stitles);
    const sbody = el('div', 'rc-foot', 'Leaving now abandons the race — no finishing position and no prize money. The circuit stays open, so you can line up again from the picker.');
    const sactions = el('div', 'rc-actions');
    this.stopBtn = el('button', 'rc-start rc-danger', 'STOP RACE');
    this.stopBtn.type = 'button';
    this.stopBtn.addEventListener('click', () => {
      this._closeStop();
      this.race?.abort?.('player');
    });
    const resumeBtn = el('button', 'rc-ghost', 'RESUME');
    resumeBtn.type = 'button';
    resumeBtn.addEventListener('click', () => this._closeStop());
    sactions.append(this.stopBtn, resumeBtn);
    scard.append(shead, sbody, sactions);
    stop.appendChild(scard);
    scard.addEventListener('mousedown', (e) => e.stopPropagation());
    scard.addEventListener('click', (e) => e.stopPropagation());
    // A click on the backdrop resumes rather than stops — stopping is a
    // deliberate button press, never a stray click.
    stop.addEventListener('click', () => this._closeStop());
    wrap.appendChild(stop);
    this.stopEl = stop;

    return wrap;
  }

  _fact(parent, label, value) {
    const box = el('div', 'rc-fact');
    const v = el('div', 'rc-fact-v', value);
    box.append(v, el('div', 'rc-fact-k', label));
    parent.appendChild(box);
    return v;
  }

  /** Rebuild the difficulty row from whatever the circuit actually offers. */
  _syncPanel() {
    const r = this.race;

    /* ---- circuits ----
     *
     * Rebuilt only when the *set* changes, which in practice is once per world.
     * A world that publishes one circuit gets no row at all rather than a
     * picker with a single option in it, which is a control that does nothing. */
    const trackList = r?.tracks ?? [];
    const trackKey = trackList.map((t) => t.id).join(',');
    if (trackKey !== this._trackKey) {
      this._trackKey = trackKey;
      this.trackEl.textContent = '';
      this._trackButtons.clear();
      for (const t of trackList) {
        const b = el('button', 'rc-pick rc-track');
        b.type = 'button';
        b.style.setProperty('--rc-accent', hexCss(t.accent ?? 0x52e9ff));
        const head = el('span', 'rc-pick-n');
        head.append(el('span', null, t.name));
        // The loop is the one thing about a circuit that changes what you have
        // to *do* on it rather than how fast you can do it, so it gets a badge
        // instead of a clause at the end of a paragraph nobody reads.
        if (t.hasLoop) head.append(el('i', 'rc-tag', '360° LOOP'));
        b.append(
          head,
          el('span', 'rc-pick-k', t.kicker ?? ''),
          el('span', 'rc-pick-d', t.blurb ?? '')
        );
        b.addEventListener('click', () => {
          if (this.race?.selectTrack?.(t.id)) this._syncPanel();
        });
        this.trackEl.appendChild(b);
        this._trackButtons.set(t.id, b);
      }
      const one = trackList.length < 2;
      this.trackEl.classList.toggle('off', one);
      this.trackLabelEl.classList.toggle('off', one);
    }

    const typeList = r?.raceTypes?.length ? r.raceTypes : [RACE_TYPES.CAR, RACE_TYPES.DRAGON];
    const typeKey = typeList.join(',');
    if (typeKey !== this._typeKey) {
      this._typeKey = typeKey;
      this.typeEl.textContent = '';
      this._typeButtons.clear();
      for (const id of typeList) {
        const b = el('button', 'rc-pick');
        b.type = 'button';
        b.append(
          el('span', 'rc-pick-n', String(id).toUpperCase()),
          el('span', 'rc-pick-d', RACE_TYPE_BLURB[id] ?? '')
        );
        b.addEventListener('click', () => {
          this.race?.setRaceType?.(id);
          this._syncPanel();
        });
        this.typeEl.appendChild(b);
        this._typeButtons.set(id, b);
      }
    }

    const list = r?.difficulties?.length ? r.difficulties : ['standard'];
    const key = list.join(',');
    if (key !== this._pickKey) {
      this._pickKey = key;
      this.pickEl.textContent = '';
      this._pickButtons.clear();
      this._pickDescs.clear();
      for (const id of list) {
        const b = el('button', 'rc-pick');
        b.type = 'button';
        const desc = el('span', 'rc-pick-d', this._diffBlurb(id));
        b.append(el('span', 'rc-pick-n', diffLabel(id)), desc);
        b.addEventListener('click', () => {
          if (this.race) this.race.difficulty = id;
          this._syncPicks();
        });
        this.pickEl.appendChild(b);
        this._pickButtons.set(id, b);
        this._pickDescs.set(id, desc);
      }
    }
    this._syncPicks();

    const nDrops = r?.plannedDrops ?? 0;
    this.factDrops.textContent = nDrops ? `${nDrops} · 1 cr each` : '—';
    this.startBtn.disabled = !r?.ready;
    this.startBtn.textContent = r?.ready ? 'START RACE' : 'NO CIRCUIT LOADED';
  }

  _syncPicks() {
    const trackId = this.race?.trackId;
    for (const [id, b] of this._trackButtons) b.classList.toggle('on', id === trackId);
    for (const [id, b] of this._pickButtons) b.classList.toggle('on', id === this.race?.difficulty);
    for (const [id, b] of this._typeButtons) b.classList.toggle('on', id === this.race?.raceType);
    // Lap counts differ per circuit, so the difficulty blurbs are rewritten
    // rather than built once - the alternative is a picker that says five laps
    // on a circuit that runs six.
    for (const [id, d] of this._pickDescs) d.textContent = this._diffBlurb(id);
    // The card's kicker names the circuit: the panel is about one of three now,
    // and "Circuit / RACE" no longer says which.
    if (this.panelKicker) this.panelKicker.textContent = this.track?.name ?? 'Circuit';
    if (this.factVehicle) this.factVehicle.textContent = String(this.race?.raceType ?? RACE_TYPES.CAR).toUpperCase();
    if (this.noteEl) this.noteEl.textContent = raceNote(this.race?.raceType ?? RACE_TYPES.CAR);
    // Facts follow the *selected* difficulty, not the last race that ran, so the
    // player sees the length/field/grid they are about to get before starting.
    const diff = this.race?.difficulty ?? 'standard';
    const shape = DIFFICULTY_FIELD[diff] ?? { cars: 10, playerSlot: PLAYER_GRID_SLOT };
    const gridLen = this.race?.track?.startGrid?.length ?? shape.cars;
    const cars = Math.min(shape.cars, gridLen);
    const slot = Math.min(shape.playerSlot, cars - 1, gridLen - 1);
    if (this.factLaps) this.factLaps.textContent = String(this._lapsFor(diff));
    if (this.factField) this.factField.textContent = `${cars} ${this.race?.dragonRace ? 'dragons' : 'cars'}`;
    if (this.factGrid) this.factGrid.textContent = ordinal(slot + 1);
  }

  /* ------------------------------------------------------------------ */
  /* Panels                                                              */
  /* ------------------------------------------------------------------ */

  openPanel() {
    if (this._panelOpen || this._boardOpen) return;
    // Don't interrupt the quest board or other overlays that share the cursor.
    if (document.body.classList.contains('quest-board-open')) return;
    this._panelOpen = true;
    this._syncPanel();
    this.panelEl.classList.add('on');
    this.input?.exitLock?.();
    this.bus?.emit('race:menu', { open: true });
  }

  closePanel() {
    if (!this._panelOpen) return;
    this._panelOpen = false;
    this.panelEl.classList.remove('on');
    this.bus?.emit('race:menu', { open: false });
  }

  /* Mid-race stop confirm. Frees the cursor like the picker so the buttons are
   * clickable, but leaves the race running behind it — resuming just closes. */
  _openStop() {
    if (this._stopOpen || !this.race?.racing) return;
    this._stopOpen = true;
    this.stopEl?.classList.add('on');
    this.input?.exitLock?.();
    this.bus?.emit('race:menu', { open: true });
  }

  _closeStop() {
    if (!this._stopOpen) return;
    this._stopOpen = false;
    this.stopEl?.classList.remove('on');
    this.input?.relockKeyboard?.();
    this.bus?.emit('race:menu', { open: false });
  }

  _showBoard(payload) {
    const results = payload?.results ?? this.race?.results ?? [];
    const laps = payload?.laps ?? this.race?.lapCount ?? 3;
    this.rowsEl.textContent = '';
    for (const r of results) {
      const row = el('div', 'rc-tr');
      if (r.isPlayer) row.classList.add('me');
      if (r.place <= 3 && !r.dnf) row.classList.add(`p${r.place}`);
      const pos = el('span', 'rc-c-pos', r.dnf ? '—' : String(r.place));
      const name = el('span', 'rc-c-name');
      const chip = el('i', 'rc-chip');
      chip.style.background = hexCss(r.color);
      name.append(chip, el('span', null, r.name));
      row.append(
        pos,
        name,
        // Not "DNF": most unfinished rows are rivals who were simply still
        // circulating when the flag fell, which is a classification, not a
        // retirement. The lap they were on says exactly that, and for the
        // player the panel title already reads DID NOT FINISH.
        el('span', 'rc-c-time', r.dnf ? `LAP ${r.laps}/${laps}` : clockText(r.time)),
        el('span', 'rc-c-gap', r.place === 1 || r.dnf ? '—' : `+${r.gap.toFixed(2)}`),
        el('span', 'rc-c-best', clockText(r.bestLap)),
        // Not gated on `dnf`: a player who was still circulating at the flag
        // keeps what they drove over, and a paid-but-blank column reads as a
        // bug against a wallet that just went up.
        el('span', 'rc-c-cr', r.credits > 0 ? `+${r.credits}` : '—')
      );
      this.rowsEl.appendChild(row);
    }

    const mine = results.find((x) => x.isPlayer);
    this.boardKicker.textContent = payload?.difficulty
      ? `${diffLabel(payload.difficulty)} · ${laps} lap${laps === 1 ? '' : 's'}`
      : 'Chequered flag';
    this.boardTitle.textContent = mine?.dnf ? 'DID NOT FINISH' : `${ordinal(mine?.place ?? 0)} PLACE`;
    // Split the payout so a player can see what the driving earned and what the
    // detour earned - otherwise "+9 credits" for a second place looks wrong.
    const drops = payload?.pickups ?? 0;
    if (drops > 0) {
      this.boardKicker.textContent += ` · ${drops} drop${drops === 1 ? '' : 's'} (+${payload.pickupCredits})`;
    }
    this.boardBadge.textContent = payload?.credits > 0 ? `+${payload.credits} CREDITS` : '';
    this.boardBadge.classList.toggle('on', payload?.credits > 0);

    this._boardOpen = true;
    this.closePanel();
    this.boardEl.classList.add('on');
    this.input?.exitLock?.();
    this.bus?.emit('race:menu', { open: true });
  }

  _closeBoard() {
    if (!this._boardOpen) return;
    this._boardOpen = false;
    this.boardEl.classList.remove('on');
    this.bus?.emit('race:menu', { open: false });
  }

  /**
   * Mirror the gantry.
   *
   * @param {{lit:number, of:number, go:boolean}} e
   */
  _showLights(e) {
    const lit = e?.lit ?? 0;
    const go = !!e?.go;
    // Visible for the whole procedure including the lead-in, so the panel
    // arrives before the first column rather than with it.
    this.countEl.classList.toggle('on', !!e?.active || go);
    this.countEl.classList.toggle('go', go);
    for (let i = 0; i < this.lightEls.length; i++) {
      this.lightEls[i].classList.toggle('lit', !go && i < lit);
    }
    if (go) {
      this.countNum.textContent = 'GO';
      // Restart the pop by taking the class off and forcing a reflow, or a
      // second race animates once and then sits still.
      this.countNum.classList.remove('pop');
      void this.countNum.offsetWidth;
      this.countNum.classList.add('pop');
      clearTimeout(this._goTimer);
      this._goTimer = setTimeout(() => {
        this.countEl.classList.remove('on', 'go');
        this.countNum.textContent = '';
      }, 1100);
    } else {
      this.countNum.textContent = '';
    }
  }

  /* ------------------------------------------------------------------ */

  /** Frame tick. Reads one snapshot rather than subscribing to a firehose. */
  update(dt) {
    const r = this.race;
    if (!r) return;
    /* Failsafe, mirroring HUD's: the harness and a hot reload can remove the
     * title card without ever raising `game:started`, and a picker that waits
     * for a signal nobody sent is the same dead end from the other side. */
    if (this._openWhenStarted && !document.querySelector('.boot-screen')) {
      this._openWhenStarted = false;
      this._started = true;
      if (!r.racing) this.openPanel();
    }
    const s = r.snapshot();
    const live = s.state === 'racing' || s.state === 'countdown';
    this.hudEl.classList.toggle('on', live);

    // The prompt is the resting state of this world: armed, nothing running,
    // no panel in the way.
    const armed = !!r.ready && s.state === 'idle' && !this._panelOpen && !this._boardOpen;
    this.readyEl.classList.toggle('on', armed);
    if (armed) {
      const t = this.track;
      this.readyName.textContent = t?.name ?? 'Circuit';
      this.readyMeta.textContent =
        `${diffLabel(s.difficulty)} · ${this._lapsFor(s.difficulty)} laps · Enter to start, Esc menu for options`;
    }
    if (!live) {
      this._lastCount = -1;
      return;
    }

    this.posNum.textContent = s.place > 0 ? ordinal(s.place) : '—';
    this.posOf.textContent = `/ ${s.total}`;
    this.posBox.classList.toggle('podium', s.place > 0 && s.place <= 3);
    // Completed laps, not the lap in progress: crossing the line once should read
    // as "1 of 3 done", so the counter starts at 0 and ticks up on each crossing
    // rather than starting at 1 and looking a lap ahead of the driver.
    this.lapVal.textContent = `${Math.min(Math.max(0, s.lap - 1), s.laps)}/${s.laps}`;
    this.timeVal.textContent = clockText(s.clock) === '—' ? '0:00.00' : clockText(s.clock);
    this.lastVal.textContent = clockText(s.lastLap);
    this.bestVal.textContent = clockText(s.bestLap);

    const ringInfo = s.rings;
    const hasRings = !!ringInfo && (ringInfo.total ?? 0) > 0;
    this.ringRow.classList.toggle('off', !hasRings);
    if (hasRings) this.ringVal.textContent = `${ringInfo.done}/${ringInfo.total}`;

    // A circuit with nothing scattered on it should not show an empty counter.
    const hasDrops = (s.dropsTotal ?? 0) > 0;
    this.dropRow.classList.toggle('off', !hasDrops);
    if (hasDrops) this.dropVal.textContent = `${s.drops}/${s.dropsTotal}`;

    if (this._flash > 0) {
      this._flash -= dt;
      this.lapRow.classList.add('hit');
      if (this._flash <= 0) this.lapRow.classList.remove('hit');
    }

    if (this._dropGain > 0) {
      this._float(`+${this._dropGain}`);
      this._dropGain = 0;
    }
    if (this._dropFlash > 0) {
      this._dropFlash -= dt;
      this.dropRow.classList.add('hit');
      if (this._dropFlash <= 0) this.dropRow.classList.remove('hit');
    }
  }

  /**
   * A line of text, shown for a moment.
   *
   * Restarts its own animation by dropping the class and forcing a reflow -
   * without that, a second loop on the same lap sets the text and animates
   * nothing, because the animation has already run on that element.
   */
  _callout(text) {
    if (!this.calloutEl) return;
    this.calloutEl.textContent = text;
    this.calloutEl.classList.remove('on');
    void this.calloutEl.offsetWidth;
    this.calloutEl.classList.add('on');
    clearTimeout(this._calloutTimer);
    this._calloutTimer = setTimeout(() => this.calloutEl.classList.remove('on'), 1700);
  }

  /**
   * A `+N` that rises off the drops row and removes itself.
   *
   * Built per collection rather than pooled: there are forty on a circuit and
   * they cannot overlap in time by more than about a second, so a pool would be
   * machinery guarding against a load that cannot happen.
   */
  _float(text) {
    const n = el('div', 'rc-drop-pop', text);
    this.dropRow.appendChild(n);
    n.addEventListener('animationend', () => n.remove(), { once: true });
  }

  dispose() {
    window.removeEventListener('keydown', this._onKey, true);
    for (const off of this._offs) {
      try { off(); } catch { /* a bus that already cleared is not an error */ }
    }
    this._offs.length = 0;
    this.el.remove();
  }
}

export default RaceUI;
