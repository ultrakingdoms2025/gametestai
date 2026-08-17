import './minigame.css';
import { MINIGAME_STATE } from '../minigames/MinigameManager.js';

/**
 * Minigame front end: countdown, live readout, quit confirm, result card.
 *
 * Built to `RaceUI`'s pattern because it has the same two-band problem, and
 * getting the bands wrong is what makes buttons unclickable:
 *
 *  - **The readout** is HUD furniture. z-index 12, `pointer-events: none`, so it
 *    can never eat a click while the player is swimming.
 *  - **The sheets** (quit confirm, result) are modal. They release the pointer,
 *    which raises the pause overlay at 60 behind them, so they sit at 86 with
 *    the race sheets - above the audio menu at 84.
 *
 * Everything is built once and toggled by class, so a contest costs class
 * writes and text updates rather than layout churn.
 *
 * The rows in the readout are supplied by the *game module*, not by this file:
 * `snapshot().live.rows` is a list of `{k, v, tone, dim}`. Tennis and skiing get
 * a HUD without touching this file, which is the whole point of the split.
 */

function el(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
}

export class MinigameUI {
  /**
   * @param {{root:HTMLElement, bus:any, input:any,
   *          minigames:import('../minigames/MinigameManager.js').MinigameManager}} ctx
   */
  constructor({ root, bus, input, minigames }) {
    this.bus = bus ?? null;
    this.input = input ?? null;
    this.mg = minigames ?? null;

    this._stopOpen = false;
    this._boardOpen = false;
    this._rowEls = [];
    this._rowKey = '';
    this._bannerText = '';
    this._countShown = -1;

    this.el = this._build();
    root.appendChild(this.el);

    /* Own the key rather than polling `input.pressed`.
     *
     * Same reason RaceUI does: Input stops reporting during a portal transition
     * and while text is captured, and "the quit dialogue will not open" is
     * exactly the dead end that costs a bug report. F8 because F5-F7 are taken
     * (save, keybinds, race) and this is the next free one. */
    this._onKey = (e) => {
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      if (e.code === 'F8') {
        if (!this.mg?.running) return;
        e.preventDefault();
        if (this.input?.textCaptured) return;
        this._toggleStop();
      } else if (e.code === 'Escape') {
        if (this._stopOpen) this._closeStop();
        else if (this._boardOpen) this._closeBoard();
      }
    };
    window.addEventListener('keydown', this._onKey, true);

    this._offs = [];
    if (bus) {
      // E at the venue, mid-contest. The manager will not act on it itself -
      // quitting is a confirmed decision, never a single keypress.
      this._offs.push(bus.on('minigame:quitRequest', () => this._openStop()));
      this._offs.push(bus.on('minigame:started', () => {
        this._closeStop();
        this._closeBoard();
      }));
      this._offs.push(bus.on('minigame:finished', (e) => {
        this._closeStop();
        this._showBoard(e);
      }));
      this._offs.push(bus.on('minigame:aborted', () => {
        this._closeStop();
        this._closeBoard();
      }));
      /* A programmatic manager reset (dev harness, future callers) must close
       * any sheet still up, or its gameplay block outlives the state it was
       * guarding. Safe against the _closeBoard -> mg.reset() -> here cycle:
       * both close methods early-return once their flag is down. */
      this._offs.push(bus.on('minigame:reset', () => {
        this._closeStop();
        this._closeBoard();
      }));
      this._offs.push(bus.on('minigame:event', (e) => this._callout(e?.text)));
      /* A lock taken while a sheet is up would hide the cursor the sheet needs.
       * Enforced rather than assumed, exactly as RaceUI does it. */
      this._offs.push(bus.on('input:lockchange', ({ locked }) => {
        if (locked && this.isOpen) this.input?.exitLock?.();
      }));
    }
  }

  get isOpen() {
    return this._stopOpen || this._boardOpen;
  }

  /* ------------------------------------------------------------------ */
  /* Markup                                                              */
  /* ------------------------------------------------------------------ */

  _build() {
    const wrap = el('div', 'mg');

    /* ---- live readout ------------------------------------------------ */
    const hud = el('div', 'mg-hud');
    this.titleEl = el('div', 'mg-title', 'CONTEST');
    this.subEl = el('div', 'mg-sub', '');
    this.rowsEl = el('div', 'mg-rows');
    const bar = el('div', 'mg-bar');
    this.barFill = el('i', 'mg-bar-fill');
    this.barRival = el('i', 'mg-bar-rival');
    bar.append(this.barFill, this.barRival);
    this.bannerEl = el('div', 'mg-banner');
    this.hintEl = el('div', 'mg-hint', 'E or F8 to quit');
    hud.append(this.titleEl, this.subEl, this.rowsEl, bar, this.bannerEl, this.hintEl);
    wrap.appendChild(hud);
    this.hudEl = hud;

    /* ---- countdown --------------------------------------------------- */
    this.countEl = el('div', 'mg-count');
    this.countNum = el('div', 'mg-count-n', '3');
    this.countCap = el('div', 'mg-count-c', 'TAKE YOUR MARKS');
    this.countEl.append(this.countNum, this.countCap);
    wrap.appendChild(this.countEl);

    /* ---- split / event callout --------------------------------------- */
    this.calloutEl = el('div', 'mg-callout');
    wrap.appendChild(this.calloutEl);

    /* ---- quit confirm ------------------------------------------------- *
     * The affordance the user asked for by name. Modelled on RaceUI's stop
     * sheet: the contest keeps running behind it (frozen, because every sheet
     * here blocks gameplay), and a click on the backdrop RESUMES - quitting is
     * a deliberate button press, never a stray click. */
    const stop = el('div', 'mg-sheet mg-stop');
    const scard = el('div', 'mg-card');
    this.stopKicker = el('div', 'mg-kicker', 'In progress');
    this.stopTitle = el('div', 'mg-h', 'QUIT MATCH?');
    this.stopBody = el('div', 'mg-foot', '');
    const sactions = el('div', 'mg-actions');
    this.quitBtn = el('button', 'mg-go mg-danger', 'QUIT MATCH');
    this.quitBtn.type = 'button';
    this.quitBtn.addEventListener('click', () => {
      this._closeStop();
      this.mg?.abort?.('player');
    });
    const resumeBtn = el('button', 'mg-ghost', 'RESUME');
    resumeBtn.type = 'button';
    resumeBtn.addEventListener('click', () => this._closeStop());
    sactions.append(this.quitBtn, resumeBtn);
    scard.append(this.stopKicker, this.stopTitle, this.stopBody, sactions);
    stop.appendChild(scard);
    scard.addEventListener('mousedown', (e) => e.stopPropagation());
    scard.addEventListener('click', (e) => e.stopPropagation());
    stop.addEventListener('click', () => this._closeStop());
    wrap.appendChild(stop);
    this.stopEl = stop;

    /* ---- result ------------------------------------------------------- */
    const board = el('div', 'mg-sheet mg-board');
    const bcard = el('div', 'mg-card');
    this.boardKicker = el('div', 'mg-kicker', '');
    this.boardTitle = el('div', 'mg-h', '');
    this.boardBadge = el('div', 'mg-badge', '');
    this.boardStats = el('div', 'mg-stats');
    this.boardFoot = el('div', 'mg-foot', '');
    const bactions = el('div', 'mg-actions');
    this.againBtn = el('button', 'mg-go', 'GO AGAIN');
    this.againBtn.type = 'button';
    this.againBtn.addEventListener('click', () => {
      // Read the venue BEFORE closing: `_closeBoard` resets the manager, which
      // is what clears `result`.
      const venueId = this.mg?.result?.venueId ?? null;
      this._closeBoard();
      if (venueId) this.mg?.start?.(venueId);
    });
    const closeBtn = el('button', 'mg-ghost', 'CLOSE');
    closeBtn.type = 'button';
    closeBtn.addEventListener('click', () => this._closeBoard());
    bactions.append(this.againBtn, closeBtn);
    bcard.append(this.boardKicker, this.boardTitle, this.boardBadge, this.boardStats, this.boardFoot, bactions);
    board.appendChild(bcard);
    bcard.addEventListener('mousedown', (e) => e.stopPropagation());
    bcard.addEventListener('click', (e) => e.stopPropagation());
    // A click outside dismisses. Safe here in a way it is not on the quit
    // sheet: closing a result throws nothing away.
    board.addEventListener('click', () => this._closeBoard());
    wrap.appendChild(board);
    this.boardEl = board;

    return wrap;
  }

  /* ------------------------------------------------------------------ */
  /* Sheets                                                              */
  /* ------------------------------------------------------------------ */

  _openStop() {
    if (this._stopOpen || this._boardOpen || !this.mg?.running) return;
    this._stopOpen = true;
    const s = this.mg.snapshot();
    this.stopTitle.textContent = `QUIT ${(s.label ?? 'MATCH').toUpperCase()}?`;
    this.stopBody.textContent =
      'Leaving now abandons the match — no result, no credits, and nothing '
      + 'credited to a quest. The venue stays open, so you can line up again '
      + 'straight away.';
    this.stopEl.classList.add('on');
    this.input?.exitLock?.();
    this.bus?.emit('minigame:menu', { open: true });
  }

  _closeStop() {
    if (!this._stopOpen) return;
    this._stopOpen = false;
    this.stopEl.classList.remove('on');
    this.input?.relockKeyboard?.();
    this.bus?.emit('minigame:menu', { open: false });
  }

  _toggleStop() {
    if (this._stopOpen) this._closeStop();
    else this._openStop();
  }

  _showBoard(result) {
    if (!result) return;
    this.boardKicker.textContent = result.label ?? 'Contest';
    this.boardTitle.textContent = result.won ? 'WON' : 'BEATEN';
    this.boardTitle.classList.toggle('lost', !result.won);
    this.boardBadge.textContent = result.credits > 0 ? `+${result.credits} CREDITS` : 'NO PRIZE';
    this.boardBadge.classList.toggle('on', result.credits > 0);

    this.boardStats.textContent = '';
    const d = result.detail ?? {};
    const stat = (k, v) => {
      const box = el('div', 'mg-stat');
      box.append(el('div', 'mg-stat-v', v), el('div', 'mg-stat-k', k));
      this.boardStats.appendChild(box);
    };
    if (result.scoreLabel) stat('TIME', String(result.scoreLabel));
    if (Number.isFinite(d.distance)) stat('DISTANCE', `${d.distance} m`);
    if (Array.isArray(d.splits) && d.splits.length) {
      stat('LENGTHS', `${d.splits.length}/${d.lengths ?? d.splits.length}`);
    }
    stat('PLACE', result.place === 1 ? '1st' : `${result.place}nd`);

    this.boardFoot.textContent = result.won
      ? `You beat ${result.rivalName ?? 'the pace'}.`
      : d.reason === 'time'
        ? 'Out of time. Nothing paid.'
        : `${result.rivalName ?? 'The pace swimmer'} got there first. Nothing paid.`;

    this._boardOpen = true;
    this.boardEl.classList.add('on');
    this.input?.exitLock?.();
    this.bus?.emit('minigame:menu', { open: true });
  }

  /**
   * Dismissing the result also clears it.
   *
   * Every way out of this card - the button, Escape, a click on the backdrop -
   * has to leave the manager idle, or the venue spends the rest of the result
   * hold offering no prompt at all and the player is standing at a pool that
   * has apparently stopped working. `reset` refuses while a contest is running,
   * so the `minigame:started` path through here is a no-op.
   */
  _closeBoard() {
    if (!this._boardOpen) return;
    this._boardOpen = false;
    this.boardEl.classList.remove('on');
    this.mg?.reset?.();
    this.bus?.emit('minigame:menu', { open: false });
  }

  /* ------------------------------------------------------------------ */
  /* Frame                                                               */
  /* ------------------------------------------------------------------ */

  update(dt) {
    const mg = this.mg;
    if (!mg) return;
    const s = mg.snapshot();

    const counting = s.state === MINIGAME_STATE.COUNTDOWN;
    this.countEl.classList.toggle('on', counting);
    if (counting) {
      if (s.countdown !== this._countShown) {
        this._countShown = s.countdown;
        this.countNum.textContent = s.countdown > 0 ? String(s.countdown) : 'GO';
        // Restart the pop animation, which otherwise runs once and never again.
        this.countNum.classList.remove('beat');
        void this.countNum.offsetWidth;
        this.countNum.classList.add('beat');
      }
      this.countCap.textContent = s.label ? s.label.toUpperCase() : 'TAKE YOUR MARKS';
    } else {
      this._countShown = -1;
    }

    const live = s.running;
    this.hudEl.classList.toggle('on', live);
    if (!live) {
      this._rowKey = '';
      return;
    }

    this.titleEl.textContent = (s.label ?? 'CONTEST').toUpperCase();
    const l = s.live;
    this.subEl.textContent = l?.subtitle ?? '';

    const rows = l?.rows ?? [];
    // Rebuild the row elements only when the SHAPE changes, so the common case
    // is four text writes rather than four element creations every frame.
    const key = rows.map((r) => r.k).join('|');
    if (key !== this._rowKey) {
      this._rowKey = key;
      this.rowsEl.textContent = '';
      this._rowEls = rows.map((r) => {
        const row = el('div', `mg-row${r.dim ? ' mg-dim' : ''}`);
        const v = el('span', 'mg-v', '');
        row.append(el('span', 'mg-k', r.k), v);
        this.rowsEl.appendChild(row);
        return { row, v };
      });
    }
    for (let i = 0; i < this._rowEls.length; i++) {
      const src = rows[i];
      const dst = this._rowEls[i];
      if (!src || !dst) continue;
      if (dst.v.textContent !== src.v) dst.v.textContent = src.v;
      dst.row.classList.toggle('good', src.tone === 'good');
      dst.row.classList.toggle('warn', src.tone === 'warn');
    }

    const prog = Math.max(0, Math.min(1, l?.progress ?? 0));
    const rival = Math.max(0, Math.min(1, l?.rivalProgress ?? 0));
    this.barFill.style.width = `${(prog * 100).toFixed(1)}%`;
    this.barRival.style.left = `${(rival * 100).toFixed(1)}%`;

    const banner = l?.banner ?? '';
    if (banner !== this._bannerText) {
      this._bannerText = banner;
      this.bannerEl.textContent = banner;
      this.bannerEl.classList.toggle('on', !!banner);
    }
    void dt;
  }

  /** A line of text for a moment; restarts its own animation. */
  _callout(text) {
    if (!this.calloutEl || !text) return;
    this.calloutEl.textContent = text;
    this.calloutEl.classList.remove('on');
    void this.calloutEl.offsetWidth;
    this.calloutEl.classList.add('on');
    clearTimeout(this._calloutTimer);
    this._calloutTimer = setTimeout(() => this.calloutEl.classList.remove('on'), 1700);
  }

  dispose() {
    window.removeEventListener('keydown', this._onKey, true);
    clearTimeout(this._calloutTimer);
    for (const off of this._offs) {
      try {
        off();
      } catch {
        /* a bus that already cleared is not an error */
      }
    }
    this._offs.length = 0;
    this.el.remove();
  }
}

export default MinigameUI;
