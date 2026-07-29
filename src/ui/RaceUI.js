import './race.css';
import { PLAYER_GRID_SLOT } from '../race/RaceManager.js';

/** One line each, because "expert" on its own does not tell anyone what changes. */
const DIFFICULTY_BLURB = {
  easy: 'A slower, scrappier field. Mistakes are frequent.',
  standard: 'Evenly matched. The podium is there to be taken.',
  expert: 'Faster than your car is, and they rarely slip.',
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
    this._lastCount = -1;

    this.el = this._build();
    root.appendChild(this.el);

    // Own the key rather than polling `input.pressed()`: Input stops reporting
    // during a portal transition and while text is captured, and "the race
    // panel will not open" is exactly the dead end that costs a bug report.
    this._onKey = (e) => {
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      if (e.code === 'F6') {
        e.preventDefault();
        if (this.input?.textCaptured) return;
        this.togglePanel();
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
      this._offs.push(bus.on('race:countdown', ({ count }) => this._showCount(count)));
      this._offs.push(bus.on('race:started', () => {
        this.closePanel();
        this._closeBoard();
      }));
      this._offs.push(bus.on('race:lap', (e) => { if (e.isPlayer) this._flash = 1.2; }));
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
    this.lapRow.append(el('span', 'rc-k', 'LAP'), (this.lapVal = el('span', 'rc-v', '1/3')));
    this.timeRow = el('div', 'rc-stat');
    this.timeRow.append(el('span', 'rc-k', 'TIME'), (this.timeVal = el('span', 'rc-v', '0:00.00')));
    this.lastRow = el('div', 'rc-stat rc-dim');
    this.lastRow.append(el('span', 'rc-k', 'LAST'), (this.lastVal = el('span', 'rc-v', '—')));
    this.bestRow = el('div', 'rc-stat rc-dim');
    this.bestRow.append(el('span', 'rc-k', 'BEST'), (this.bestVal = el('span', 'rc-v', '—')));
    stack.append(this.lapRow, this.timeRow, this.lastRow, this.bestRow);
    hud.append(this.posBox, stack);
    wrap.appendChild(hud);
    this.hudEl = hud;

    /* ---- countdown --------------------------------------------------- */
    this.countEl = el('div', 'rc-count');
    this.countNum = el('div', 'rc-count-n', '3');
    this.countEl.appendChild(this.countNum);
    wrap.appendChild(this.countEl);

    /* ---- setup panel ------------------------------------------------- */
    const panel = el('div', 'rc-sheet rc-panel');
    const card = el('div', 'rc-card');
    const head = el('div', 'rc-head');
    const titles = el('div', null);
    titles.append(el('div', 'rc-kicker', 'Circuit'), el('div', 'rc-title', 'RACE'));
    const close = el('div', 'rc-close');
    close.append(el('b', null, 'F6'), el('span', null, 'or'), el('b', null, 'Esc'), el('span', null, 'to close'));
    head.append(titles, close);

    const facts = el('div', 'rc-facts');
    this.factLaps = this._fact(facts, 'Laps', '3');
    this.factField = this._fact(facts, 'Grid', '10 cars');
    this.factGrid = this._fact(facts, 'You start', '5th');

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
      + 'over the line will not count a lap. Podium pays 10 / 5 / 2 credits.'
    );

    card.append(head, facts, pickLabel, this.pickEl, this.startBtn, this.noteEl);
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
    this.startBtn.disabled = !r?.ready;
    this.startBtn.textContent = r?.ready ? 'START RACE' : 'NO CIRCUIT LOADED';
  }

  _syncPicks() {
    for (const [id, b] of this._pickButtons) b.classList.toggle('on', id === this.race?.difficulty);
  }

  /* ------------------------------------------------------------------ */
  /* Panels                                                              */
  /* ------------------------------------------------------------------ */

  openPanel() {
    if (this._panelOpen || this._boardOpen) return;
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
        el('span', 'rc-c-cr', r.credits > 0 && !r.dnf ? `+${r.credits}` : '—')
      );
      this.rowsEl.appendChild(row);
    }

    const mine = results.find((x) => x.isPlayer);
    this.boardKicker.textContent = payload?.difficulty
      ? `${payload.difficulty.toUpperCase()} · ${laps} lap${laps === 1 ? '' : 's'}`
      : 'Chequered flag';
    this.boardTitle.textContent = mine?.dnf ? 'DID NOT FINISH' : `${ordinal(mine?.place ?? 0)} PLACE`;
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

  _showCount(n) {
    if (n === this._lastCount) return;
    this._lastCount = n;
    this.countNum.textContent = n > 0 ? String(n) : 'GO';
    this.countEl.classList.toggle('go', n === 0);
    // Restart the pop by taking the class off and forcing a reflow, or three
    // consecutive counts animate once and then sit still.
    this.countEl.classList.remove('on');
    void this.countEl.offsetWidth;
    this.countEl.classList.add('on');
    if (n === 0) setTimeout(() => this.countEl.classList.remove('on'), 700);
  }

  /* ------------------------------------------------------------------ */

  /** Frame tick. Reads one snapshot rather than subscribing to a firehose. */
  update(dt) {
    const r = this.race;
    if (!r) return;
    const s = r.snapshot();
    const live = s.state === 'racing' || s.state === 'countdown';
    this.hudEl.classList.toggle('on', live);
    if (!live) {
      this._lastCount = -1;
      return;
    }

    this.posNum.textContent = s.place > 0 ? ordinal(s.place) : '—';
    this.posOf.textContent = `/ ${s.total}`;
    this.posBox.classList.toggle('podium', s.place > 0 && s.place <= 3);
    this.lapVal.textContent = `${Math.max(1, s.lap)}/${s.laps}`;
    this.timeVal.textContent = clockText(s.clock) === '—' ? '0:00.00' : clockText(s.clock);
    this.lastVal.textContent = clockText(s.lastLap);
    this.bestVal.textContent = clockText(s.bestLap);

    if (this._flash > 0) {
      this._flash -= dt;
      this.lapRow.classList.add('hit');
      if (this._flash <= 0) this.lapRow.classList.remove('hit');
    }
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
