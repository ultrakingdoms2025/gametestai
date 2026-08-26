/**
 * RecordsPanel — the browsable half of "Chart the Nexus".
 *
 * ── Why this panel exists ─────────────────────────────────────────────────
 *
 * The HUD's objective panel shows the record of the world the player is
 * STANDING IN (`HUD._setCharter` draws `p.here` and nothing else), so the only
 * way to learn why any other world matters was to travel there. Meanwhile four
 * finished systems had no surface at all: `Charters.mastery()` and
 * `Charters.collection()` were fully written with zero callers, `reputationOf`
 * rode in every `charter:changed` payload with no consumer, and the retention
 * payload's `streak` / `best` / `season` were computed and never drawn. The
 * server's leaderboard (`/api/game/leaderboard`) had no client anywhere.
 *
 * This is that surface: one sheet, opened from the Esc hub's Records row or on
 * N, showing every world's record, its standing, the mastery and collection
 * read-outs, the daily-loop streak, and the boards the server actually ranks.
 *
 * ── What it deliberately does not do ──────────────────────────────────────
 *
 * It AUTHORS NOTHING. Every row is read from `Charters` / `Retention` on open
 * and re-read on the same `charter:changed` / `retention:changed` events the
 * HUD listens to, so this panel cannot disagree with the objective panel about
 * what is left to do. And it FAKES NO BOARDS: the server refuses race, trial,
 * credit and kill boards by design (client clocks, unbounded sources — see
 * `site/lib/leaderboard.ts` REFUSED), so those appear here only as the
 * server's own refusal reasons, never as client-side rankings. Signed out or
 * unreachable reads as exactly that, in words, never as a blank region.
 *
 * ── Open/close discipline ─────────────────────────────────────────────────
 *
 * Same contract as MazeMap/CharacterMenu: `ui:modal { id: 'records' }` into
 * the HUD's overlay Set — emitted BEFORE the pointer lock is released, so the
 * standby overlay never wins the race (the OrientationGate ordering note) —
 * a `records-open` body class to keep `.pause` off the sheet, and a delayed
 * `input.reengage()` on close only when the lock was ours to give back.
 */

import './records.css';
import { CHARTER_RANKS } from '../systems/Charters.js';

/** Rows requested per board. Enough to read a race, small enough to scan. */
const BOARD_LIMIT = 8;

function el(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
}

export class RecordsPanel {
  /**
   * @param {{ root: HTMLElement, bus?: any, input?: any,
   *           charters?: import('../systems/Charters.js').Charters,
   *           retention?: any,
   *           api?: string, fetchImpl?: typeof fetch }} ctx
   *   `api` and `fetchImpl` exist for the tests, which point the client at a
   *   real local HTTP server rather than stubbing the transport — the shipped
   *   call is same-origin `fetch('/api/game/leaderboard')`, the same pattern
   *   as `main.js`'s `/api/lore`, cookie and all.
   */
  constructor({ root, bus, input, charters, retention, api = '', fetchImpl } = {}) {
    this.root = root;
    this.bus = bus ?? null;
    this.input = input ?? null;
    this.charters = charters ?? null;
    this.retention = retention ?? null;
    this.api = api;
    this._fetch = fetchImpl ?? ((...a) => globalThis.fetch(...a));

    this._open = false;
    this._hadLock = false;
    /** Which world row is unfolded to its per-column record. */
    this._expandedId = null;
    /** @type {{state:'idle'|'loading'|'signedout'|'offline'|'ready', boards?:any[], refused?:Record<string,string>, why?:string}} */
    this._boards = { state: 'idle' };
    this._boardsPromise = null;

    this._el = this._build();
    root.appendChild(this._el);

    /* Window-level, capture phase, same pattern and same reasons as
     * QuestBoard's J: `Input` stops reporting while a panel owns the keyboard,
     * which is exactly when the close key must still work — so panel keys own
     * their listeners and stay off `BINDABLE`. `textCaptured` because this
     * runs outside `Input` and must not fire while the chat field has focus. */
    this._onWindowKey = (e) => {
      if (e.code === 'Escape') {
        if (this._open) {
          e.preventDefault();
          e.stopPropagation();
          this.close();
        }
        return;
      }
      if (e.code !== 'KeyN' || e.repeat || e.ctrlKey || e.metaKey || e.altKey) return;
      if (this.input?.textCaptured) return;
      const tag = document.activeElement?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA') return;
      e.preventDefault();
      e.stopPropagation();
      this.toggle();
    };
    window.addEventListener('keydown', this._onWindowKey, true);

    /** @type {Array<() => void>} */
    this._offs = [];
    if (this.bus) {
      /* Redraw from the SYSTEMS, not from the payload: `progress()` and the
       * payload are the same object shape from the same code, and reading the
       * live system keeps this panel correct even when it opens between
       * announcements (the announce dedupes on a signature, so a panel that
       * only listened would open stale). */
      this._offs.push(this.bus.on('charter:changed', () => { if (this._open) this._renderProgress(); }));
      this._offs.push(this.bus.on('retention:changed', () => { if (this._open) this._renderJourney(); }));
    }
  }

  get isOpen() { return this._open; }

  open() {
    if (this._open) return;
    this._open = true;
    /* ORDER IS LOAD-BEARING — the OrientationGate note. `ui:modal` first, so
     * this panel is already in `HUD._overlays` when the lock release below
     * lands `input:lockchange` and main.js asks for the standby overlay:
     * `showPauseOverlay` refuses while the Set is non-empty. */
    this.bus?.emit('ui:modal', { id: 'records', open: true });
    /* Before the lock goes: `body.records-open .pause` is what keeps a frame
     * of STANDBY from painting over the sheet — the same rule quest-board.css,
     * character.css and maze-map.css each carry. */
    document.body.classList.add('records-open');
    this._hadLock = !!this.input?.locked;
    this.input?.exitLock?.();

    this._renderProgress();
    this._renderJourney();
    this._loadBoards();
    this._el.classList.add('open');
  }

  close() {
    if (!this._open) return;
    this._open = false;
    this._el.classList.remove('open');
    document.body.classList.remove('records-open');

    const hadLock = this._hadLock;
    this._hadLock = false;
    if (hadLock) {
      /* Delayed, and through `reengage()` — the pointer lock on a mouse
       * session, the touch session on a phone. Browsers refuse a lock request
       * that follows an Escape-driven exit too closely; every sibling panel
       * records the same 140 ms answer. */
      setTimeout(() => {
        const p = this.input?.reengage?.();
        if (p && typeof p.catch === 'function') p.catch(() => {});
      }, 140);
    }
    this.bus?.emit('ui:modal', { id: 'records', open: false });
  }

  toggle() {
    if (this._open) this.close();
    else this.open();
  }

  /** Present for symmetry with the other panels; this one is event driven. */
  update() {}

  dispose() {
    this.close();
    window.removeEventListener('keydown', this._onWindowKey, true);
    for (const off of this._offs) { try { off?.(); } catch { /* already gone */ } }
    this._offs.length = 0;
    this._el.remove?.();
  }

  /* ------------------------------------------------------------------ */
  /* Build                                                               */
  /* ------------------------------------------------------------------ */

  _build() {
    const rootEl = el('div', 'rec-root');
    const panel = el('div', 'rec-panel');
    rootEl.appendChild(panel);

    /* Header: name, rank, tally, close. */
    const head = el('div', 'rec-header');
    head.appendChild(el('div', 'rec-title', 'NEXUS RECORDS'));
    this.rankEl = el('div', 'rec-rank', '');
    head.appendChild(this.rankEl);
    this.tallyEl = el('div', 'rec-tally', '');
    head.appendChild(this.tallyEl);
    const close = el('button', 'rec-close', '✕');
    close.title = 'Close [N / Esc]';
    close.addEventListener('click', () => this.close());
    head.appendChild(close);
    panel.appendChild(head);

    const body = el('div', 'rec-body');
    panel.appendChild(body);

    /* Left: the gateway board. */
    const main = el('div', 'rec-main');
    body.appendChild(main);
    const worldsSec = el('div', 'rec-sec rec-worlds-sec');
    const wHead = el('div', 'rec-sec-title', 'GATEWAY RECORDS');
    this.nextRankEl = el('span', 'rec-next', '');
    wHead.appendChild(this.nextRankEl);
    worldsSec.appendChild(wHead);
    this.hintEl = el('div', 'rec-hint', '');
    worldsSec.appendChild(this.hintEl);
    this.worldsEl = el('div', 'rec-worlds');
    worldsSec.appendChild(this.worldsEl);
    main.appendChild(worldsSec);

    /* Right: journey, mastery, collection, standings. */
    const side = el('div', 'rec-side');
    body.appendChild(side);

    const journeySec = el('div', 'rec-sec');
    journeySec.appendChild(el('div', 'rec-sec-title', 'THE JOURNEY'));
    this.journeyEl = el('div', 'rec-rows rec-journey');
    journeySec.appendChild(this.journeyEl);
    side.appendChild(journeySec);

    const masterySec = el('div', 'rec-sec');
    masterySec.appendChild(el('div', 'rec-sec-title', 'MASTERY'));
    this.masteryEl = el('div', 'rec-rows rec-mastery');
    masterySec.appendChild(this.masteryEl);
    side.appendChild(masterySec);

    const collectionSec = el('div', 'rec-sec');
    collectionSec.appendChild(el('div', 'rec-sec-title', 'COLLECTION'));
    this.collectionEl = el('div', 'rec-rows rec-collection');
    collectionSec.appendChild(this.collectionEl);
    side.appendChild(collectionSec);

    const boardsSec = el('div', 'rec-sec');
    boardsSec.appendChild(el('div', 'rec-sec-title', 'STANDINGS'));
    this.boardsEl = el('div', 'rec-boards');
    boardsSec.appendChild(this.boardsEl);
    side.appendChild(boardsSec);

    const foot = el('div', 'rec-footer', 'Press N or Esc to close');
    panel.appendChild(foot);

    return rootEl;
  }

  /* ------------------------------------------------------------------ */
  /* Charters: the board, mastery, collection                            */
  /* ------------------------------------------------------------------ */

  _renderProgress() {
    const c = this.charters;
    if (!c?.progress) return;
    let p;
    try { p = c.progress(); } catch { return; }
    if (!p) return;

    const rank = typeof p.rank === 'string' && p.rank ? p.rank.toUpperCase() : '';
    this.rankEl.textContent = rank;
    this.tallyEl.textContent = `${p.chartered}/${p.total} charters`;
    this.hintEl.textContent = p.hint ?? '';

    /* The next rung, derived from the same table the rank is. Every rung is a
     * fraction of the registry, so "what one more charter buys" is arithmetic,
     * never authored. Silent at the top — there is nothing above it. */
    let next = '';
    if (p.total > 0) {
      for (const r of CHARTER_RANKS) {
        const at = Math.ceil(r.fraction * p.total);
        if (at > p.chartered) { next = `next: ${r.title.toUpperCase()} at ${at}/${p.total}`; break; }
      }
    }
    this.nextRankEl.textContent = next;

    this._renderWorlds(Array.isArray(p.worlds) ? p.worlds : []);
    this._renderMastery();
    this._renderCollection();
  }

  /**
   * One row per registered world, in registration order — the browsable board
   * the HUD's here-only panel is not. A known world unfolds to the per-column
   * record `Charters.records()` already carries; an unsurveyed world says so
   * in words, because "unsurveyed" and "empty" are different sentences and the
   * denominators are learned by going there.
   */
  _renderWorlds(worlds) {
    const host = this.worldsEl;
    host.textContent = '';
    for (const w of worlds) {
      const row = el('div', 'rec-row rec-world');
      if (w.restored) row.classList.add('chartered');
      if (!w.known) row.classList.add('unsurveyed');

      const name = el('div', 'rec-w-name', w.name ?? w.id);
      if (w.restored) name.appendChild(el('span', 'rec-w-badge', 'CHARTERED'));
      row.appendChild(name);

      /* The reputation label nothing consumed: `reputationOf`, straight off
       * the record. Null means no record to have a relationship with. */
      const rep = el('div', 'rec-w-rep', w.reputation ?? 'Unsurveyed');
      row.appendChild(rep);

      const count = el('div', 'rec-w-count', w.known ? `${w.have}/${w.need}` : '—');
      if (w.known && w.have >= w.need) count.classList.add('done');
      row.appendChild(count);

      host.appendChild(row);

      if (w.known && Array.isArray(w.columns) && w.columns.length) {
        const cols = el('div', 'rec-cols');
        for (const col of w.columns) {
          const cr = el('div', 'rec-col');
          cr.appendChild(el('div', 'rec-col-name', col.label));
          const cc = el('div', 'rec-col-count', `${col.have}/${col.need}`);
          if (col.have >= col.need) cc.classList.add('done');
          cr.appendChild(cc);
          cols.appendChild(cr);
        }
        cols.hidden = this._expandedId !== w.id;
        host.appendChild(cols);
        row.classList.add('openable');
        row.addEventListener('click', () => {
          this._expandedId = this._expandedId === w.id ? null : w.id;
          cols.hidden = this._expandedId !== w.id;
          row.classList.toggle('expanded', !cols.hidden);
        });
        row.classList.toggle('expanded', !cols.hidden);
      } else {
        const why = el('div', 'rec-cols rec-unsurveyed-note');
        why.appendChild(el('div', 'rec-col-name', 'No survey on file — travel there and the record fills in.'));
        why.hidden = true;
        host.appendChild(why);
      }
    }
  }

  /** `Charters.mastery()` — the per-verb depth, drawn for the first time. */
  _renderMastery() {
    const host = this.masteryEl;
    host.textContent = '';
    let rows = [];
    try { rows = this.charters?.mastery?.() ?? []; } catch { rows = []; }
    if (!rows.length) {
      host.appendChild(el('div', 'rec-empty',
        'Nothing on record yet — bests and tallies appear as you set them.'));
      return;
    }
    for (const r of rows) {
      const row = el('div', 'rec-line');
      row.appendChild(el('div', 'rec-line-name', r.label));
      const v = typeof r.total === 'number' ? `${r.value}/${r.total}` : `${r.value}`;
      row.appendChild(el('div', 'rec-line-count', v));
      host.appendChild(row);
    }
  }

  /** `Charters.collection()` — the finite things, across every world at once. */
  _renderCollection() {
    const host = this.collectionEl;
    host.textContent = '';
    let c = null;
    try { c = this.charters?.collection?.() ?? null; } catch { c = null; }
    if (!c || (!c.relicTotal && !c.viewpointTotal && !c.cosmetics)) {
      host.appendChild(el('div', 'rec-empty',
        'Nothing catalogued yet — relics and viewpoints count here once a world is surveyed.'));
      return;
    }
    const line = (label, text) => {
      const row = el('div', 'rec-line');
      row.appendChild(el('div', 'rec-line-name', label));
      row.appendChild(el('div', 'rec-line-count', text));
      host.appendChild(row);
    };
    if (c.relicTotal > 0) line('Relics recovered', `${c.relics}/${c.relicTotal}`);
    if (c.viewpointTotal > 0) line('Viewpoints synced', `${c.viewpoints}/${c.viewpointTotal}`);
    if (c.cosmetics > 0) line('Skins owned', `${c.cosmetics}`);
  }

  /* ------------------------------------------------------------------ */
  /* Retention: streak / best / season                                   */
  /* ------------------------------------------------------------------ */

  /**
   * The three retention fields nobody drew (`HUD._setRetention` writes the
   * daily and weekly task rows and stops). The tasks stay on the HUD where
   * they are actionable; the CAREER half — streak, best, season — reads
   * naturally here, beside the records it is a career of.
   */
  _renderJourney() {
    const host = this.journeyEl;
    if (!host) return;
    host.textContent = '';
    let p = null;
    try { p = this.retention?.progress?.() ?? null; } catch { p = null; }
    if (!p) {
      host.appendChild(el('div', 'rec-empty', 'The daily loop is not running in this build.'));
      return;
    }
    const line = (label, text) => {
      const row = el('div', 'rec-line');
      row.appendChild(el('div', 'rec-line-name', label));
      row.appendChild(el('div', 'rec-line-count', text));
      host.appendChild(row);
    };
    const streak = Number(p.streak) || 0;
    const best = Number(p.best) || 0;
    line('Day streak', streak === 1 ? '1 day' : `${streak} days`);
    line('Best streak', best === 1 ? '1 day' : `${best} days`);
    if (p.season?.id) {
      const n = Array.isArray(p.season.worlds) ? p.season.worlds.length : 0;
      line(`Season ${p.season.id}`, n === 1 ? '1 charter' : `${n} charters`);
    }
  }

  /* ------------------------------------------------------------------ */
  /* Leaderboards                                                        */
  /* ------------------------------------------------------------------ */

  /**
   * Ask the server which boards it ranks, then read each one.
   *
   * Same-origin, `cache: 'no-store'`, cookie riding — the `/api/lore` pattern,
   * including how failures degrade: a 401 is a signed-out player and says so,
   * anything else is an unreachable service and says that instead. Neither is
   * ever a blank region, and no board is invented client-side — the refused
   * categories render as the server's own reasons.
   */
  async _loadBoards() {
    if (this._boardsPromise) return this._boardsPromise;
    this._boards = { state: 'loading' };
    this._renderBoards();
    this._boardsPromise = (async () => {
      try {
        const res = await this._fetch(`${this.api}/api/game/leaderboard`, { cache: 'no-store' });
        if (res.status === 401) {
          this._boards = { state: 'signedout' };
          return;
        }
        if (!res.ok) {
          this._boards = { state: 'offline', why: `http ${res.status}` };
          return;
        }
        const index = await res.json();
        const list = Array.isArray(index?.boards) ? index.boards : [];
        const refused = index?.refused && typeof index.refused === 'object' ? index.refused : {};
        const boards = await Promise.all(list.map(async (b) => {
          try {
            const r = await this._fetch(
              `${this.api}/api/game/leaderboard?category=${encodeURIComponent(b.id)}&limit=${BOARD_LIMIT}`,
              { cache: 'no-store' },
            );
            if (!r.ok) return { ...b, error: `http ${r.status}` };
            const data = await r.json();
            return {
              ...b,
              label: data?.label ?? b.label ?? b.id,
              entries: Array.isArray(data?.entries) ? data.entries : [],
            };
          } catch {
            return { ...b, error: 'unreachable' };
          }
        }));
        this._boards = { state: 'ready', boards, refused };
      } catch {
        this._boards = { state: 'offline', why: 'unreachable' };
      } finally {
        this._boardsPromise = null;
        this._renderBoards();
      }
    })();
    return this._boardsPromise;
  }

  _renderBoards() {
    const host = this.boardsEl;
    if (!host) return;
    host.textContent = '';
    const s = this._boards;

    if (s.state === 'idle' || s.state === 'loading') {
      host.appendChild(el('div', 'rec-empty', 'Reading the boards…'));
      return;
    }
    if (s.state === 'signedout') {
      /* Honest, and specific: the progress is safe, the ranking needs the
       * account the server derives it from. */
      host.appendChild(el('div', 'rec-empty rec-signedout',
        'Signed out — standings are ranked from your account’s own progress. '
        + 'Sign in on the site to appear on them. Your local progress is safe either way.'));
      return;
    }
    if (s.state === 'offline') {
      host.appendChild(el('div', 'rec-empty rec-offline',
        'Leaderboards unreachable from here — the service did not answer. '
        + 'Everything above is local and unaffected.'));
      return;
    }

    /* Ready: exactly the boards the server offered, nothing else. */
    for (const b of s.boards ?? []) {
      const sec = el('div', 'rec-board');
      sec.appendChild(el('div', 'rec-board-title', b.label ?? b.id));
      if (b.error) {
        sec.appendChild(el('div', 'rec-empty', `Could not read this board (${b.error}).`));
        host.appendChild(sec);
        continue;
      }
      if (!b.entries?.length) {
        sec.appendChild(el('div', 'rec-empty', 'Nobody on this board yet.'));
        host.appendChild(sec);
        continue;
      }
      for (const e of b.entries) {
        const row = el('div', 'rec-line rec-entry');
        if (e.self) row.classList.add('self');
        row.appendChild(el('div', 'rec-entry-rank', `#${e.rank}`));
        row.appendChild(el('div', 'rec-line-name', e.self ? `${e.name} (you)` : `${e.name}`));
        row.appendChild(el('div', 'rec-line-count', `${e.score}`));
        sec.appendChild(row);
      }
      host.appendChild(sec);
    }

    /* The refusals, in the server's own words. Rendered so nobody files "add
     * a race board" against a decision the server already recorded — and so
     * this client is never tempted to fake one from localStorage. */
    const refusedIds = Object.keys(s.refused ?? {});
    if (refusedIds.length) {
      const ref = el('div', 'rec-refused');
      ref.appendChild(el('div', 'rec-board-title rec-refused-title', 'NOT RANKED, BY DESIGN'));
      for (const id of refusedIds) {
        const row = el('div', 'rec-refused-row');
        row.appendChild(el('div', 'rec-refused-id', id.replace(/_/g, ' ')));
        row.appendChild(el('div', 'rec-refused-why', s.refused[id]));
        ref.appendChild(row);
      }
      host.appendChild(ref);
    }
  }
}

export default RecordsPanel;
