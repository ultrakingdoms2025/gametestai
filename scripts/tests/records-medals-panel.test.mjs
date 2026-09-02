import { test } from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';

/**
 * THE NEW RECORDS ARE ON SCREEN.
 *
 * ── The failure this exists to catch ──────────────────────────────────────
 *
 * This repository's signature defect is a model with no view: `mastery()` and
 * `collection()` shipped with zero callers, `reputationOf` rode in every
 * payload with no consumer, and the leaderboard route had no client. Three
 * records were added by this drop - the per-venue medal, the consignment
 * column and the wardrobe's denominator - and every one of them is a fresh
 * chance to make the same mistake.
 *
 * So the REAL panel and the REAL result card are driven headlessly, through a
 * DOM shim reduced to what `el()` touches, against the REAL `Charters`
 * seeded through its own `deserialize`. The technique and the module loader
 * are `records-panel.test.mjs`'s, for the reasons its header gives.
 *
 * ── The proof each gate can fail ──────────────────────────────────────────
 *
 * Against the pre-change tree:
 *   'the medal grid draws a cell per tier'         - no `_renderMedals` at all
 *   'the wardrobe row carries its denominator'     - the row never drew
 *   'the consignment column appears on the record' - no such column
 *   'the result card draws the medal ladder'       - `detail` was a string, so
 *      DETAIL_STATS saw an empty object and drew nothing but TIME
 */

register(
  'data:text/javascript,'
  + encodeURIComponent(
    'export async function load(url, context, next) {'
    + ' if (url.endsWith(".css")) return { format: "module", shortCircuit: true, source: "" };'
    + ' return next(url, context);'
    + ' }',
  ),
  import.meta.url,
);

/* ---------------------------------------------------------------------- */
/* A DOM, reduced to what `el()` and the two views touch                   */
/* ---------------------------------------------------------------------- */

function makeNode(tag) {
  const listeners = new Map();
  const node = {
    tagName: String(tag).toUpperCase(),
    get className() { return [...this.classList._set].join(' '); },
    set className(v) {
      this.classList._set = new Set(String(v).split(/\s+/).filter(Boolean));
    },
    hidden: false,
    title: '',
    type: '',
    children: [],
    _text: '',
    get textContent() { return this._text; },
    set textContent(v) {
      this._text = String(v);
      if (this._text === '') this.children.length = 0;
    },
    appendChild(c) { this.children.push(c); return c; },
    append(...cs) { for (const c of cs) this.children.push(c); },
    remove() {},
    addEventListener(type, fn) {
      const list = listeners.get(type) ?? [];
      list.push(fn);
      listeners.set(type, list);
    },
    removeEventListener() {},
    click() { for (const fn of listeners.get('click') ?? []) fn({}); },
    classList: {
      _set: new Set(),
      add(...cs) { for (const c of cs) this._set.add(c); },
      remove(...cs) { for (const c of cs) this._set.delete(c); },
      toggle(c, on) {
        const want = on === undefined ? !this._set.has(c) : !!on;
        if (want) this._set.add(c); else this._set.delete(c);
        return want;
      },
      contains(c) { return this._set.has(c); },
    },
  };
  return node;
}

globalThis.document = globalThis.document ?? {};
globalThis.document.createElement = (tag) => makeNode(tag);
globalThis.document.body = globalThis.document.body ?? makeNode('body');
globalThis.window = globalThis.window ?? globalThis;
globalThis.window.addEventListener = globalThis.window.addEventListener ?? (() => {});
globalThis.window.removeEventListener = globalThis.window.removeEventListener ?? (() => {});

const { RecordsPanel } = await import('../../src/ui/RecordsPanel.js');
const { MinigameUI } = await import('../../src/ui/MinigameUI.js');
const { Charters } = await import('../../src/systems/Charters.js');
const { Cosmetics, COSMETIC_TOTAL, CHARACTER_SKINS } = await import('../../src/systems/Cosmetics.js');
const { EventBus } = await import('../../src/core/EventBus.js');

const WORLD_IDS = ['station', 'citadel', 'medieval'];
const worldManager = { ids: WORLD_IDS, displayNameOf: (id) => id };

const inputStub = () => ({
  locked: false, textCaptured: false, exitLock() {}, reengage: () => null,
  relockKeyboard() {},
});

function openPanel(extra = {}) {
  const bus = new EventBus();
  const charters = new Charters({ bus, worldManager, ...extra });
  const panel = new RecordsPanel({
    root: makeNode('div'), bus, input: inputStub(), charters,
    /* No boards: the leaderboard client is `records-panel.test.mjs`'s subject
     * and a live fetch here would only make this file flaky. */
    fetchImpl: () => Promise.reject(new Error('no server in this case')),
  });
  panel.open();
  return { panel, charters, bus };
}

function textOf(node) {
  if (!node) return '';
  let out = node._text ?? '';
  for (const c of node.children ?? []) out += ' ' + textOf(c);
  return out.trim().replace(/\s+/g, ' ');
}

const rowsOf = (host, cls) => host.children.filter((c) => c.classList.contains(cls));

/* ====================================================================== */
/* 1. The medal grid                                                       */
/* ====================================================================== */

const LEDGER = {
  'citadel/citadel_skyline': { time: 30, label: 'The Skyline', medal: 'gold' },
  'citadel/citadel_ascent': { time: 44, label: 'The Long Ascent', medal: 'bronze' },
  'citadel/lido': { time: 41.2, label: 'Lido Swim' },
};

test('the medal grid draws a cell per tier, filled up to the grade held', () => {
  const { panel, charters } = openPanel({ trials: { read: () => ({ best: LEDGER }) } });
  const rows = rowsOf(panel.medalsEl, 'rec-medal-row');
  const want = charters.medals();
  assert.equal(rows.length, want.length, 'the grid does not carry one row per graded venue');
  assert.equal(rows.length, 2, 'an ungraded venue was drawn on the medal grid');

  assert.match(textOf(rows[0]), /The Skyline/);
  const goldCells = rows[0].children.find((c) => c.classList.contains('rec-medal-grid')).children;
  assert.equal(goldCells.length, 3, 'a tier the player has not reached was omitted');
  /* A gold time is inside silver and bronze, so all three fill. That is the
   * whole reason the grid can be drawn from one stored word. */
  assert.deepEqual(goldCells.map((c) => c.classList.contains('held')), [true, true, true]);

  const bronzeCells = rows[1].children.find((c) => c.classList.contains('rec-medal-grid')).children;
  assert.deepEqual(bronzeCells.map((c) => c.classList.contains('held')), [true, false, false]);
  /* Each cell carries its own class and a readable title - a three-letter grid
   * is unreadable without one. */
  assert.ok(bronzeCells[0].classList.contains('rec-medal-bronze'));
  assert.match(bronzeCells[2].title, /gold/);
  assert.match(bronzeCells[2].title, /not yet/);
});

test('a player with no graded runs gets a sentence, not a blank region', () => {
  const { panel } = openPanel();
  assert.equal(rowsOf(panel.medalsEl, 'rec-medal-row').length, 0);
  assert.match(textOf(panel.medalsEl), /No graded runs yet/);
});

test('a medal upgrade redraws the grid, though the charter board did not move', () => {
  /* `Charters._announce` dedupes on every world's have/need, and a gold that
   * replaces a silver at a venue already counted moves neither - so the sheet
   * has to listen to `trial:best` or it shows yesterday's grade until it is
   * closed and reopened. */
  const best = { 'citadel/citadel_skyline': { time: 30, label: 'The Skyline', medal: 'bronze' } };
  const { panel, bus } = openPanel({ trials: { read: () => ({ best }) } });
  const cells = () => rowsOf(panel.medalsEl, 'rec-medal-row')[0]
    .children.find((c) => c.classList.contains('rec-medal-grid')).children;
  assert.deepEqual(cells().map((c) => c.classList.contains('held')), [true, false, false]);

  /* SETTLE THE SIGNATURE FIRST. `_announce` starts with an empty `_sig`, so
   * the very first event of any kind announces whatever the board is - and a
   * case that upgraded the medal on that first event would pass through
   * `charter:changed` and prove nothing. This emit is the one that sets the
   * signature; the next one is the one under test. */
  bus.emit('trial:best', { key: 'citadel/citadel_skyline', medal: 'bronze' });
  const boards = [];
  bus.on('charter:changed', () => boards.push(1));

  best['citadel/citadel_skyline'].medal = 'gold';
  bus.emit('trial:best', { key: 'citadel/citadel_skyline', medal: 'gold', medalGained: 'gold' });
  assert.equal(boards.length, 0,
    'the fixture no longer exercises the case - the board itself moved, so any listener would redraw');
  assert.deepEqual(cells().map((c) => c.classList.contains('held')), [true, true, true],
    'a new grade never reached the open sheet');
});

test('the Golds row reaches the mastery list', () => {
  const { panel } = openPanel({ trials: { read: () => ({ best: LEDGER }) } });
  const text = textOf(panel.masteryEl);
  assert.match(text, /Golds 1\/2/,
    `the mastery list "${text}" does not carry the golds row`);
});

/* ====================================================================== */
/* 2. The wardrobe finally has a denominator                               */
/* ====================================================================== */

test('the wardrobe row carries its denominator, and reads the real Cosmetics', () => {
  const cosmetics = new Cosmetics({ bus: new EventBus() });
  cosmetics.unlock(CHARACTER_SKINS[0].id);
  const { panel, charters } = openPanel({ cosmetics });
  /* Seed a roster so the section is not in its empty state. */
  charters._learn('citadel', 'relics', 17);
  panel._renderCollection();

  const text = textOf(panel.collectionEl);
  assert.match(text, new RegExp(`Skins owned 1/${COSMETIC_TOTAL}`),
    `the collection panel says "${text}" - the wardrobe row is missing or has no total`);
});

test('a player who owns nothing still sees what there is to own', () => {
  const { panel, charters } = openPanel({ cosmetics: new Cosmetics({ bus: new EventBus() }) });
  charters._learn('citadel', 'relics', 17);
  panel._renderCollection();
  assert.match(textOf(panel.collectionEl), new RegExp(`Skins owned 0/${COSMETIC_TOTAL}`));
});

test('a board with nothing on it at all still says so in words', () => {
  const { panel } = openPanel();
  assert.match(textOf(panel.collectionEl), /Nothing catalogued yet/);
});

/* ====================================================================== */
/* 3. The consignment column reaches the board                             */
/* ====================================================================== */

test('the consignment column appears on the record the panel unfolds', () => {
  /* Seeded through `Charters.deserialize`, which is the door `SaveGame` uses -
   * a roster written by the learner, and a find set standing in for what
   * `Caches.serialize()` returns. */
  const bus = new EventBus();
  const caches = { serialize: () => ({ emptied: {}, found: ['medieval/high/0_0', 'medieval/sunken/9_9'] }) };
  const charters = new Charters({ bus, worldManager, caches });
  charters.deserialize({ rosters: { medieval: { caches: 6 } }, charters: [], deeds: [] });
  const panel = new RecordsPanel({
    root: makeNode('div'), bus, input: inputStub(), charters,
    fetchImpl: () => Promise.reject(new Error('no server')),
  });
  panel.open();

  const rows = rowsOf(panel.worldsEl, 'rec-world');
  const medieval = rows[WORLD_IDS.indexOf('medieval')];
  assert.match(textOf(medieval), /2\/6/, 'the consignment record is not on the world row');

  const kids = panel.worldsEl.children;
  const cols = kids[kids.indexOf(medieval) + 1];
  medieval.click();
  assert.equal(cols.hidden, false);
  const text = textOf(cols);
  assert.match(text, /Consignments/, `the unfolded record "${text}" has no consignment column`);
  assert.match(text, /2\/6/);
});

/* ====================================================================== */
/* 4. The result card                                                      */
/* ====================================================================== */

/** The real card, shown the payload `MinigameManager._finish` really emits. */
function showResult(result) {
  const bus = new EventBus();
  const ui = new MinigameUI({
    root: makeNode('div'),
    bus,
    input: inputStub(),
    minigames: { result: null, reset() {}, start() {} },
  });
  bus.emit('minigame:finished', result);
  return ui;
}

const ROOFTOP = (over = {}) => ({
  gameId: 'rooftop_trial',
  venueId: 'citadel_skyline',
  kind: 'rooftop',
  label: 'The Skyline',
  won: true,
  place: 1,
  total: 2,
  score: 'gold',
  medal: 'gold',
  scoreLabel: '0:58.20 · gold',
  rivalName: 'your best run',
  credits: 216,
  time: 58.2,
  detail: {
    checkpoints: 7,
    passed: 7,
    medal: 'gold',
    best: 61.4,
    parGold: 62.5,
    parSilver: 72.4,
    parBronze: 87.8,
    personalBest: true,
    note: '7 of 7 rings · personal best',
    reason: null,
  },
  ...over,
});

/** `{k: v}` for every stat box on the card. */
function statsOf(ui) {
  const out = {};
  for (const box of ui.boardStats.children) {
    const v = box.children.find((c) => c.classList.contains('mg-stat-v'));
    const k = box.children.find((c) => c.classList.contains('mg-stat-k'));
    out[k?.textContent] = v?.textContent;
  }
  return out;
}

test('the result card draws the medal ladder as boxes, not as a sentence', () => {
  const ui = showResult(ROOFTOP());
  const s = statsOf(ui);
  assert.equal(s.MEDAL, 'GOLD', `the card drew no medal box: ${JSON.stringify(s)}`);
  assert.equal(s.GOLD, '1:02.50');
  assert.equal(s.SILVER, '1:12.40');
  assert.equal(s.BRONZE, '1:27.80');
  assert.equal(s.BEST, '1:01.40');
  /* The ring count draws itself: `checkpoints` and `passed` are the keys the
   * table's existing MARKS row already reads. */
  assert.equal(s.MARKS, '7/7');
  /* TIME is the module's own `scoreLabel` and is left exactly as it was - the
   * medal box is an addition to the card, never a rewrite of what the game
   * module said about its own result. */
  assert.equal(s.TIME, '0:58.20 · gold');
});

test('an object detail still gets its sentence under the boxes', () => {
  const ui = showResult(ROOFTOP());
  assert.equal(ui.boardDetail.hidden, false, 'the prose band was hidden with a note to show');
  assert.match(ui.boardDetail.textContent, /personal best/);
});

test('a first attempt draws no BEST box, because there is no best', () => {
  const ui = showResult(ROOFTOP({ detail: { ...ROOFTOP().detail, best: null } }));
  assert.equal(statsOf(ui).BEST, undefined, 'a card claimed a best time that does not exist');
  assert.equal(statsOf(ui).MEDAL, 'GOLD');
});

test('an ungraded contest draws none of the five, exactly as before', () => {
  const ui = showResult({
    gameId: 'swim', venueId: 'lido', kind: 'swim', label: 'Lido Swim Challenge',
    won: true, place: 1, total: 2, score: 41.2, medal: null, scoreLabel: '0:41.20',
    rivalName: 'the pace swimmer', credits: 120, time: 41.2,
    detail: { lengths: 4, distance: 100, splits: [10, 20, 30, 41.2], margin: 6 },
  });
  const s = statsOf(ui);
  for (const k of ['MEDAL', 'GOLD', 'SILVER', 'BRONZE', 'BEST']) {
    assert.equal(s[k], undefined, `an ungraded contest drew a ${k} box`);
  }
  assert.equal(s.DISTANCE, '100 m', 'the existing detail rows stopped drawing');
  assert.equal(s.LENGTHS, '4/4');
});

test('a timed-out trial says it ran out of time rather than guessing', () => {
  const ui = showResult(ROOFTOP({
    won: false, place: 2, score: 'dnf', medal: null, scoreLabel: 'out of time',
    credits: 54,
    detail: {
      checkpoints: 7, passed: 3, medal: null, best: null,
      parGold: 62.5, parSilver: 72.4, parBronze: 87.8,
      reason: 'time', note: '3 of 7 rings before the clock ran out',
    },
  }));
  assert.match(ui.boardFoot.textContent, /Out of time/,
    `the footer said "${ui.boardFoot.textContent}"`);
  assert.match(ui.boardFoot.textContent, /54 CR/);
  assert.equal(statsOf(ui).MEDAL, undefined);
  assert.equal(statsOf(ui).MARKS, '3/7');
});
