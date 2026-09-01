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

/**
 * English ordinal for a finishing position.
 *
 * The card used to say `place === 1 ? '1st' : `${place}nd``, which is right for
 * exactly one of the numbers it is handed. `TrackRace` grids the player against
 * three pace runners and `_lose` returns `this._rank()`, so places 2, 3 and 4
 * all reach here - and two of the three printed "3nd" and "4nd". The live HUD
 * has always had this right; only the result card was wrong, which is the one
 * place the player reads the number slowly.
 *
 * The 11-13 exception is included because it costs one line and the alternative
 * is a second bug the day a contest grids a field of twenty.
 *
 * @param {number} n
 * @returns {string}
 */
export function ordinal(n) {
  const i = Math.floor(Number(n));
  if (!Number.isFinite(i) || i <= 0) return '';
  const teen = i % 100;
  if (teen >= 11 && teen <= 13) return `${i}th`;
  const last = i % 10;
  return `${i}${last === 1 ? 'st' : last === 2 ? 'nd' : last === 3 ? 'rd' : 'th'}`;
}

/**
 * The `detail` keys the shipped game modules publish, and how to draw each.
 *
 * ── What this replaces ───────────────────────────────────────────────────────
 *
 * The card read four keys - `distance`, `splits`, `lengths`, `reason` - out of
 * an object that twelve of the sixteen venues fill with something richer, and
 * threw the rest away. `RooftopTrial._finish` returns the whole medal system as
 * a sentence ("4 of 7 rings · gold 1:02 · silver 1:14 · bronze 1:26 · personal
 * best") and it was rendered NOWHERE: a player could beat their own best time
 * on the Skyline and the only thing the game said about it was "BEATEN" or
 * "WON". `TrackRace` returns lane, lap length and the margin the nearest ghost
 * still had to run; `TennisMatch` returns points won, points lost and the
 * longest rally; `SkiRun` returns gates passed, gates missed and the penalty
 * seconds those misses cost. None of it reached the screen.
 *
 * ── Why a table and not a loop over the object ───────────────────────────────
 *
 * `MinigameManager._finish` passes `detail: outcome.detail ?? null` with no
 * normalisation, so this is a bag of whatever a game module felt like putting
 * in it. Walking its keys would put `rivalDistance`, `progress` and a whole
 * `runners` array on the card the moment a module added one, in insertion
 * order, with raw property names as labels. A declared table renders what was
 * designed to be read, in a fixed order, and silently ignores everything else -
 * which is also what lets a module carry working state in `detail` without
 * that state becoming UI.
 *
 * Each entry is `[label, (d) => string|null]`. Returning null draws nothing.
 */
const DETAIL_STATS = [
  ['DISTANCE', (d) => (Number.isFinite(d.distance) ? `${Math.round(d.distance)} m` : null)],
  ['LENGTHS', (d) => (Array.isArray(d.splits) && d.splits.length
    ? `${d.splits.length}/${d.lengths ?? d.splits.length}`
    : null)],
  ['GATES', (d) => (Number.isFinite(d.gates) && Number.isFinite(d.passed)
    ? `${d.passed}/${d.gates}`
    : null)],
  ['MISSED', (d) => (Number.isFinite(d.missed) ? String(d.missed) : null)],
  ['PENALTY', (d) => (Number(d.penaltySeconds) > 0 ? `+${Math.round(d.penaltySeconds)}s` : null)],
  ['MARKS', (d) => (Number.isFinite(d.checkpoints) && Number.isFinite(d.passed)
    ? `${d.passed}/${d.checkpoints}`
    : null)],
  ['LANE', (d) => (Number.isFinite(d.lane) ? String(d.lane) : null)],
  ['LAP', (d) => (Number.isFinite(d.lapM) ? `${Math.round(d.lapM)} m` : null)],
  ['COURSE', (d) => (Number.isFinite(d.courseM) ? `${Math.round(d.courseM)} m` : null)],
  /* Metres, and signed on purpose: `SwimChallenge` publishes the player's lead
   * (positive on a win, negative on a loss) and `TrackRace` publishes what the
   * nearest ghost still had to run. Both read as "the gap", which is what the
   * word means at the finish of a race. */
  ['MARGIN', (d) => (Number.isFinite(d.margin) ? `${d.margin > 0 ? '+' : ''}${Math.round(d.margin)} m` : null)],
  ['GAMES', (d) => (typeof d.games === 'string' && d.games ? d.games : null)],
  ['POINTS', (d) => (Number.isFinite(d.pointsWon) && Number.isFinite(d.pointsLost)
    ? `${d.pointsWon}-${d.pointsLost}`
    : null)],
  ['RALLY', (d) => (Number.isFinite(d.longestRally) && d.longestRally > 0
    ? `${d.longestRally}`
    : null)],
  ['FIELD', (d) => (Array.isArray(d.runners) && d.runners.length
    ? String(d.runners.length + 1)
    : null)],
];

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

    /* The quit-confirm sheet is reached by E at the venue (which emits
     * `minigame:quitRequest`, wired below to `_openStop`) and by the Esc
     * pause hub's "Quit minigame" item - never by its own key. Escape here
     * only ever closes a sheet that is already open. */
    this._onKey = (e) => {
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      if (e.code === 'Escape') {
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
    this.hintEl = el('div', 'mg-hint', 'E, or Esc menu, to quit');
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
    /* A game module's PROSE detail, when it publishes one rather than an object.
     * Given `mg-foot` so it inherits the footer's type without needing a rule of
     * its own; `mg-detail` is a hook for one later if it ever earns one. Four
     * venues use this - the rooftop trials' medal line is the long one. */
    this.boardDetail = el('div', 'mg-foot mg-detail', '');
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
    bcard.append(this.boardKicker, this.boardTitle, this.boardBadge, this.boardStats,
      this.boardDetail, this.boardFoot, bactions);
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

  _showBoard(result) {
    if (!result) return;
    this.boardKicker.textContent = result.label ?? 'Contest';
    this.boardTitle.textContent = result.won ? 'WON' : 'BEATEN';
    this.boardTitle.classList.toggle('lost', !result.won);
    this.boardBadge.textContent = result.credits > 0 ? `+${result.credits} CREDITS` : 'NO PRIZE';
    this.boardBadge.classList.toggle('on', result.credits > 0);

    this.boardStats.textContent = '';
    /* `detail` is a STRING from four venues and an OBJECT from the rest, and
     * `MinigameManager._finish` normalises neither. Split them here: the object
     * drives the stat boxes through DETAIL_STATS, the string is prose and goes
     * under them. `d` stays an object either way so the table's readers never
     * index into a string. */
    const rawDetail = result.detail ?? null;
    const detailText = typeof rawDetail === 'string' ? rawDetail.trim() : '';
    const d = (rawDetail && typeof rawDetail === 'object') ? rawDetail : {};
    const stat = (k, v) => {
      const box = el('div', 'mg-stat');
      box.append(el('div', 'mg-stat-v', v), el('div', 'mg-stat-k', k));
      this.boardStats.appendChild(box);
    };
    if (result.scoreLabel) stat('TIME', String(result.scoreLabel));
    for (const [label, read] of DETAIL_STATS) {
      const v = read(d);
      if (v != null && v !== '') stat(label, String(v));
    }
    /* PLACE only where placing is a fact.
     *
     * Five venues are solo contests - the two relay splices, the two delivery
     * rounds and the archery butts - and they publish `total: 1` because there
     * is one competitor. "PLACE 2nd" over a stand-still hacking puzzle was not
     * a rounding error in the copy, it was the card asserting a field that had
     * beaten the player when nothing had. */
    const field = Number(result.total);
    if (!Number.isFinite(field) || field > 1) {
      const place = ordinal(result.place);
      if (place) stat('PLACE', place);
    }

    this.boardDetail.textContent = detailText;
    this.boardDetail.classList.toggle('on', !!detailText);
    /* Hidden rather than emptied: an empty div still eats the card's flex gap,
     * and the result sheet is tight enough that a blank band under the stats
     * reads as a missing line. */
    this.boardDetail.hidden = !detailText;

    this.boardFoot.textContent = this._footerFor(result, d);

    this._boardOpen = true;
    this.boardEl.classList.add('on');
    this.input?.exitLock?.();
    this.bus?.emit('minigame:menu', { open: true });
  }

  /**
   * The sentence under the result card.
   *
   * ── Two defects, one line ────────────────────────────────────────────────
   *
   * **It said "Nothing paid." while the game was paying.** Every shipped venue
   * pays a participation floor on a COMPLETED loss - `consolationFor` only
   * returns zero for a venue that publishes `consolation: 0` and no venue does,
   * so all sixteen pay 2-4 CR at the old prize scale. The card said nothing was
   * paid; the badge two lines above it said "+3 CREDITS" and the HUD toast said
   * "lost — +3 for finishing", in the same second. The card is the one the
   * player reads, so the card was the one lying.
   *
   * **It named a rival that does not exist.** Five venues are solo - the two
   * relay splices, the two delivery rounds and the archery butts - and none
   * sets `rivalName`, so `?? 'The pace swimmer'` put a swimmer in a stand-still
   * hacking puzzle on a space station. `rivalName == null` is the honest test
   * for "there was nobody to beat", and it is also how `SwimChallenge`,
   * `SkiRun` and `TrackRace` spell a TIMED-OUT loss (they null the rival on
   * `why === 'time'`), which is why the reason is read first: a timeout in a
   * rival contest is out of time, not a contest with no rival.
   *
   * @param {object} result the `minigame:finished` payload
   * @param {object} d `result.detail` when it is an object, `{}` otherwise
   * @returns {string}
   */
  _footerFor(result, d) {
    const credits = Math.max(0, Math.floor(Number(result?.credits) || 0));
    const paid = credits > 0
      ? (result?.won ? ` +${credits} CR.` : ` +${credits} CR for seeing it out.`)
      : ' Nothing paid.';

    if (result?.won) {
      return result?.rivalName
        ? `You beat ${result.rivalName}.${paid}`
        : `Target met.${paid}`;
    }
    if (d?.reason === 'time') return `Out of time.${paid}`;
    if (result?.rivalName) return `${result.rivalName} got there first.${paid}`;
    /* No rival and no `reason`: a solo contest lost to its own clock. The kind
     * is what names the clock, because "out of time" is true of all three and
     * describes none of them. */
    switch (result?.kind) {
      case 'hack':      return `The trace caught you.${paid}`;
      case 'courier':   return `The schedule ran out.${paid}`;
      case 'test_fire': return `The range went cold before the last plate did.${paid}`;
      default:          return `The clock beat you.${paid}`;
    }
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
