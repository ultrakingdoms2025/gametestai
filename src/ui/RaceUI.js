import './race.css';
import { PLAYER_GRID_SLOT } from '../race/RaceManager.js';

/** One line each, because "expert" on its own does not tell anyone what changes. */
/* Difficulty changes the circuit, not just the field, so the blurb has to say
 * what gets added to the road as well as who you are racing. A player who picks
 * EXPERT and then hits a barrier that was not there last time should have been
 * told. */
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
    this.lapRow.append(el('span', 'rc-k', 'LAP'), (this.lapVal = el('span', 'rc-v', '1/3')));
    this.timeRow = el('div', 'rc-stat');
    this.timeRow.append(el('span', 'rc-k', 'TIME'), (this.timeVal = el('span', 'rc-v', '0:00.00')));
    this.lastRow = el('div', 'rc-stat rc-dim');
    this.lastRow.append(el('span', 'rc-k', 'LAST'), (this.lastVal = el('span', 'rc-v', '—')));
    this.bestRow = el('div', 'rc-stat rc-dim');
    this.bestRow.append(el('span', 'rc-k', 'BEST'), (this.bestVal = el('span', 'rc-v', '—')));
    // Drops sit last and carry their own accent, because unlike the four rows
    // above it they are the only line a player can change by *steering* rather
    // than by going faster.
    this.dropRow = el('div', 'rc-stat rc-drop');
    this.dropRow.append(el('span', 'rc-k', 'DROPS'), (this.dropVal = el('span', 'rc-v', '0')));
    stack.append(this.lapRow, this.timeRow, this.lastRow, this.bestRow, this.dropRow);
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
    close.append(el('b', null, 'F7'), el('span', null, 'or'), el('b', null, 'Esc'), el('span', null, 'to close'));
    head.append(titles, close);

    const facts = el('div', 'rc-facts');
    this.factLaps = this._fact(facts, 'Laps', '3');
    this.factField = this._fact(facts, 'Grid', '10 cars');
    this.factGrid = this._fact(facts, 'You start', '5th');
    this.factDrops = this._fact(facts, 'Drops', '—');

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
    const nDrops = r?.plannedDrops ?? 0;
    this.factDrops.textContent = nDrops ? `${nDrops} · 1 cr each` : '—';
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
