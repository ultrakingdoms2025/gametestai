import './race.css';
import { PLAYER_GRID_SLOT, RACE_TYPES } from '../race/RaceManager.js';

/** One line each, because "expert" on its own does not tell anyone what changes. */
/* Difficulty changes the circuit, not just the field, so the blurb has to say
 * what gets added to the road as well as who you are racing. A player who picks
 * EXPERT and then hits a barrier that was not there last time should have been
 * told. */
const RACE_TYPE_BLURB = {
  car: 'Classic ground race in the Interceptor.',
  dragon: 'Aerial race on dragons through ordered floating rings.',
};

const DIFFICULTY_BLURB = {
  easy: '2 laps, clear road. A slower, scrappier field.',
  standard: '3 laps, chicanes and scattered hazards. Evenly matched.',
  expert: '4 laps, tight chicanes and heavy debris. They rarely slip.',
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

const ORDINALS = ['0th', '1st', '2nd', '3rd', '4th', '5th', '6th', '7th', '8th', '9th', '10th'];

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
      /* F7, not F6.
       *
       * This panel and the key-rebinding panel were written at the same time by
       * different hands and both claimed F6, so pressing it toggled both at
       * once. F6 stays with rebinding, which sits naturally in the run of
       * global config panels on F1-F6; this one is world-specific and opens by
       * itself on arrival, so its key is the secondary way in rather than the
       * only one. */
      if (e.code === 'F7') {
        e.preventDefault();
        if (this.input?.textCaptured) return;
        this.togglePanel();
      } else if (e.code === 'Enter') {
        /* Start, from wherever you are.
         *
         * The panel's button is the only other way in, and a player who closed
         * it to look at the circuit had to go back through a function key to
         * begin - so the start was manual but not *reachable*. Guarded on the
         * race being armed and idle, so Enter stays free everywhere else, and
         * on text capture, so it still means "send" in chat.
         */
        if (this.input?.textCaptured) return;
        if (this._boardOpen || !this.race?.ready || this.race.state !== 'idle') return;
        e.preventDefault();
        this.closePanel();
        this.race.start(this.race.difficulty);
      } else if (e.code === 'Escape') {
        if (this._boardOpen) this._closeBoard();
        else if (this._panelOpen) this.closePanel();
      }
    };
    window.addEventListener('keydown', this._onKey, true);

    this._offs = [];
    if (bus) {
      // Arriving on a circuit opens the picker unprompted. A player who has
      // just driven through a portal onto a start/finish straight should not
      // have to discover a function key to find out what the place is for.
      this._offs.push(bus.on('race:armed', () => {
        this._syncPanel();
        if (!this.race?.racing) this.openPanel();
      }));
      this._offs.push(bus.on('race:lights', (e) => this._showLights(e)));
      this._offs.push(bus.on('race:started', () => {
        this.closePanel();
        this._closeBoard();
      }));
      this._offs.push(bus.on('race:lap', (e) => { if (e.isPlayer) this._flash = 1.2; }));
      this._offs.push(bus.on('race:pickup', (e) => {
        this._dropFlash = 0.5;
        this._dropGain += e?.count ?? 1;
      }));
      this._offs.push(bus.on('race:finished', (e) => this._showBoard(e)));
      this._offs.push(bus.on('race:aborted', () => { this._closeBoard(); }));
    }
  }

  get isOpen() {
    return this._panelOpen || this._boardOpen;
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
    this.readyEl.append(
      el('div', 'rc-ready-k', 'Vellum Ridge Circuit'),
      this.readyBtn,
      this.readyMeta
    );
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

    /* ---- setup panel ------------------------------------------------- */
    const panel = el('div', 'rc-sheet rc-panel');
    const card = el('div', 'rc-card');
    const head = el('div', 'rc-head');
    const titles = el('div', null);
    titles.append(el('div', 'rc-kicker', 'Circuit'), el('div', 'rc-title', 'RACE'));
    const close = el('div', 'rc-close');
    close.append(el('b', null, 'F7'), el('span', null, 'or'), el('b', null, 'Esc'), el('span', null, 'to close'));
    head.append(titles, close);

    const facts = el('div', 'rc-facts');
    this.factVehicle = this._fact(facts, 'Vehicle', 'CAR');
    this.factLaps = this._fact(facts, 'Laps', '3');
    this.factField = this._fact(facts, 'Grid', '10 cars');
    this.factGrid = this._fact(facts, 'You start', '5th');
    this.factDrops = this._fact(facts, 'Drops', '—');

    const typeLabel = el('div', 'rc-section', 'Race type');
    this.typeEl = el('div', 'rc-picks');
    this._typeButtons = new Map();
    this._typeKey = null;

    const pickLabel = el('div', 'rc-section', 'Difficulty');
    this.pickEl = el('div', 'rc-picks');
    this._pickButtons = new Map();

    this.startBtn = el('button', 'rc-start', 'START RACE');
    this.startBtn.type = 'button';
    this.startBtn.addEventListener('click', () => {
      if (!this.race?.ready) return;
      this.race.start(this.race.difficulty);
    });

    this.noteEl = el(
      'div', 'rc-foot',
      'You race in the Interceptor — it is summoned onto the grid for you. '
      + 'Checkpoints must be taken in order, so cutting the circuit or reversing '
      + 'over the line will not count a lap. Podium pays 10 / 5 / 2 credits, and '
      + 'drops pay 1 each whether or not you finish.'
    );

    card.append(head, facts, typeLabel, this.typeEl, pickLabel, this.pickEl, this.startBtn, this.noteEl);
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
      for (const id of list) {
        const b = el('button', 'rc-pick');
        b.type = 'button';
        b.append(
          el('span', 'rc-pick-n', String(id).toUpperCase()),
          el('span', 'rc-pick-d', DIFFICULTY_BLURB[id] ?? '')
        );
        b.addEventListener('click', () => {
          if (this.race) this.race.difficulty = id;
          this._syncPicks();
        });
        this.pickEl.appendChild(b);
        this._pickButtons.set(id, b);
      }
    }
    this._syncPicks();

    this.factLaps.textContent = String(r?.lapCount ?? 3);
    this.factField.textContent = `${Math.min(10, (r?.track?.startGrid?.length ?? 10))} cars`;
    this.factGrid.textContent = ordinal(PLAYER_GRID_SLOT + 1);
    const nDrops = r?.plannedDrops ?? 0;
    this.factDrops.textContent = nDrops ? `${nDrops} · 1 cr each` : '—';
    this.startBtn.disabled = !r?.ready;
    this.startBtn.textContent = r?.ready ? 'START RACE' : 'NO CIRCUIT LOADED';
  }

  _syncPicks() {
    for (const [id, b] of this._pickButtons) b.classList.toggle('on', id === this.race?.difficulty);
    for (const [id, b] of this._typeButtons) b.classList.toggle('on', id === this.race?.raceType);
    if (this.factVehicle) this.factVehicle.textContent = String(this.race?.raceType ?? RACE_TYPES.CAR).toUpperCase();
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

  togglePanel() {
    if (this._boardOpen) return;
    if (this._panelOpen) this.closePanel();
    else this.openPanel();
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
      ? `${payload.difficulty.toUpperCase()} · ${laps} lap${laps === 1 ? '' : 's'}`
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
    const s = r.snapshot();
    const live = s.state === 'racing' || s.state === 'countdown';
    this.hudEl.classList.toggle('on', live);

    // The prompt is the resting state of this world: armed, nothing running,
    // no panel in the way.
    const armed = !!r.ready && s.state === 'idle' && !this._panelOpen && !this._boardOpen;
    this.readyEl.classList.toggle('on', armed);
    if (armed) {
      this.readyMeta.textContent = `${String(s.difficulty).toUpperCase()} · ${s.laps} laps · Enter, or F7 for options`;
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
