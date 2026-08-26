import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { register } from 'node:module';

/**
 * THE RECORDS SHEET READS WHAT THE SYSTEMS ACTUALLY PUBLISH.
 *
 * ── The failure this exists to catch ──────────────────────────────────────
 *
 * `Charters.mastery()` and `Charters.collection()` were fully written, tested
 * at the arithmetic level, and had ZERO callers. `reputationOf` rode in every
 * `charter:changed` payload with no consumer. `Retention.progress()` computed
 * `streak`/`best`/`season` and `HUD._setRetention` drew exactly two rows and
 * stopped. The server's leaderboard route had no client anywhere in `src/`.
 * Nothing was red; the only symptom was a player who could not see any of it.
 *
 * So every payload below comes out of the REAL `Charters` and the REAL
 * `Retention`, driven through their own `deserialize` — the same door
 * `SaveGame` uses — and the leaderboard cases run against a REAL `node:http`
 * server answering a real 401 / real JSON / a really closed port. A test that
 * hand-built `{ rank: 'Surveyor' }` would pass for ever against a system that
 * stopped publishing it, which is this repository's signature defect.
 *
 * ── Why the DOM is a shim and the panel is not ────────────────────────────
 *
 * The same technique `charter-hud.test.mjs` records: the panel builds its DOM
 * through `document.createElement` and keeps references, so a small node shim
 * lets the REAL `open()` / `_render*` methods run headlessly. The one new
 * trick is the module loader below, because `RecordsPanel.js` imports its own
 * stylesheet the way every probe-measured panel must (`hud-responsive.test
 * .mjs` asserts exactly that), and Node cannot parse CSS: the loader answers
 * every `.css` import with an empty module, and nothing else is intercepted.
 * The alternative — a source scrape — is what MazeMap's tests are stuck with,
 * and it is weaker than driving the real methods.
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
/* A DOM, reduced to what `el()` and the panel touch                       */
/* ---------------------------------------------------------------------- */

function makeNode(tag) {
  const listeners = new Map();
  const node = {
    tagName: String(tag).toUpperCase(),
    /* `className = 'a b'` and `classList` must agree, because the panel sets
     * the first at build time and reads/writes the second afterwards. */
    get className() { return [...this.classList._set].join(' '); },
    set className(v) {
      this.classList._set = new Set(String(v).split(/\s+/).filter(Boolean));
    },
    hidden: false,
    title: '',
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
    click() { for (const fn of listeners.get('click') ?? []) fn({ }); },
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
const { Charters, reputationOf } = await import('../../src/systems/Charters.js');
const { Retention, dayKey, seasonKey } = await import('../../src/systems/Retention.js');
const { EventBus } = await import('../../src/core/EventBus.js');

/* ---------------------------------------------------------------------- */
/* Fixtures: the real systems, seeded through their own doors              */
/* ---------------------------------------------------------------------- */

const WORLD_IDS = ['station', 'maze', 'citadel', 'race', 'medieval', 'space'];
const worldManager = {
  ids: WORLD_IDS,
  displayNameOf: (id) => ({ station: 'Aether Station', citadel: 'The Citadel' }[id] ?? id),
};

/** A charters system with a part-done station, learned rosters, one unsurveyed. */
function makeCharters(extra = {}) {
  const bus = new EventBus();
  const charters = new Charters({ bus, worldManager, ...extra });
  charters.deserialize({
    rosters: {
      citadel: { relics: 17, viewpoints: 5 },
      medieval: { relics: 24, seams: 6 },
      space: { wings: 12 },
    },
    charters: [],
    /* Two of the station's three deeds, so exactly one world has a non-zero
     * numerator without any collection system wired: 2/3 is Vouched. */
    deeds: ['station/trade', 'station/mount'],
  });
  return { bus, charters };
}

const inputStub = () => ({
  locked: false,
  textCaptured: false,
  exitLock() { this.locked = false; },
  reengage: () => null,
});

function openPanel({ bus, charters, retention = null, api = '', fetchImpl } = {}) {
  const root = makeNode('div');
  const panel = new RecordsPanel({
    root, bus, input: inputStub(), charters, retention, api, fetchImpl,
  });
  panel.open();
  return panel;
}

/** Every text node under a shim node, flattened. */
function textOf(node) {
  if (!node) return '';
  let out = node._text ?? '';
  for (const c of node.children ?? []) out += ' ' + textOf(c);
  return out.trim().replace(/\s+/g, ' ');
}

const rowsOf = (host, cls) => host.children.filter((c) => c.classList.contains(cls));

/* ====================================================================== */
/* 1. The gateway board                                                    */
/* ====================================================================== */

test('every registered world gets a row, from the real records()', () => {
  const { bus, charters } = makeCharters();
  const panel = openPanel({ bus, charters });

  const rows = rowsOf(panel.worldsEl, 'rec-world');
  assert.equal(rows.length, WORLD_IDS.length,
    'the board does not carry one row per registered world');

  /* Registration order, real display names. */
  assert.match(textOf(rows[0]), /Aether Station/);
  assert.match(textOf(rows[2]), /The Citadel/);
});

test('reputation labels are the real reputationOf output, not authored', () => {
  const { bus, charters } = makeCharters();
  const panel = openPanel({ bus, charters });
  const rows = rowsOf(panel.worldsEl, 'rec-world');

  /* Station: 2 of 3 deeds — whatever reputationOf says that is, verbatim. */
  const station = charters.record('station');
  assert.equal(station.have, 2);
  assert.equal(station.need, 3);
  assert.match(textOf(rows[0]), new RegExp(reputationOf(2, 3)));

  /* The citadel is known (learned roster) with nothing collected. */
  assert.match(textOf(rows[2]), new RegExp(reputationOf(0, 22)));
  assert.match(textOf(rows[2]), /0\/22/);
});

test('a world nobody has visited reads Unsurveyed, never 0/0', () => {
  const { bus, charters } = makeCharters();
  const panel = openPanel({ bus, charters });
  const rows = rowsOf(panel.worldsEl, 'rec-world');
  const race = rows[WORLD_IDS.indexOf('race')];
  assert.ok(race.classList.contains('unsurveyed'));
  assert.match(textOf(race), /Unsurveyed/);
  assert.match(textOf(race), /—/);
  assert.ok(!/0\/0/.test(textOf(race)), 'an unknown record was drawn as an empty one');
});

test('a known world unfolds to the per-column record records() carries', () => {
  const { bus, charters } = makeCharters();
  const panel = openPanel({ bus, charters });

  const kids = panel.worldsEl.children;
  const citadelRow = rowsOf(panel.worldsEl, 'rec-world')[2];
  assert.ok(citadelRow.classList.contains('openable'));
  const cols = kids[kids.indexOf(citadelRow) + 1];
  assert.ok(cols.classList.contains('rec-cols'));
  assert.equal(cols.hidden, true, 'the record is unfolded before anybody asked');

  citadelRow.click();
  assert.equal(cols.hidden, false, 'clicking the row did not unfold the record');
  const text = textOf(cols);
  assert.match(text, /Relics/);
  assert.match(text, /0\/17/);
  assert.match(text, /Viewpoints/);
  assert.match(text, /0\/5/);

  citadelRow.click();
  assert.equal(cols.hidden, true, 'clicking again did not fold it back');
});

test('the header carries the real rank, tally, hint and next rung', () => {
  const { bus, charters } = makeCharters();
  const panel = openPanel({ bus, charters });
  const p = charters.progress();

  assert.equal(panel.rankEl.textContent, p.rank.toUpperCase());
  assert.equal(panel.tallyEl.textContent, `${p.chartered}/${p.total} charters`);
  assert.equal(panel.hintEl.textContent, p.hint);
  assert.ok(p.hint.length > 0, 'the real hint was empty with five records unfinished');
  /* 0 of 6 chartered: the first rung above is Runner at ceil(1/18 * 6) = 1. */
  assert.match(panel.nextRankEl.textContent, /RUNNER at 1\/6/);
});

test('the board redraws on charter:changed while open', () => {
  const { bus, charters } = makeCharters();
  const panel = openPanel({ bus, charters });
  assert.match(textOf(rowsOf(panel.worldsEl, 'rec-world')[0]), /2\/3/);

  /* The third station deed lands, through the real event path: the world is
   * the station and the gateway deed's own channel fires. */
  charters._worldId = 'station';
  bus.emit('portal:entering', {});
  const station = rowsOf(panel.worldsEl, 'rec-world')[0];
  assert.match(textOf(station), /3\/3/);
  assert.match(textOf(station), /CHARTERED/);
  assert.equal(panel.tallyEl.textContent, '1/6 charters');
});

/* ====================================================================== */
/* 2. Mastery and collection — the zero-caller surfaces                    */
/* ====================================================================== */

test('mastery rows are the real mastery() output', () => {
  const objectives = {
    assayCount: 4, assayTotal: 9, wingCount: 3, wingTotal: 12, killCount: 48,
    surveyCount: 0, surveyTotal: 0,
  };
  const trials = { read: () => ({ best: { 'citadel/arena': 41.2, 'sports/court': 12.9 } }) };
  const races = { read: () => ({ best: { 'race/loop/easy': 88.1 } }) };
  const { bus, charters } = makeCharters({ objectives, trials, races });
  const panel = openPanel({ bus, charters });

  const want = charters.mastery();
  assert.ok(want.length >= 4, 'the fixture no longer produces mastery rows at all');
  const lines = rowsOf(panel.masteryEl, 'rec-line');
  assert.equal(lines.length, want.length);
  for (let i = 0; i < want.length; i++) {
    const t = textOf(lines[i]);
    assert.match(t, new RegExp(want[i].label));
    assert.match(t, new RegExp(String(want[i].value)));
  }
  assert.match(textOf(lines.find((l) => /Contest bests/.test(textOf(l)))), /2/);
  assert.match(textOf(lines.find((l) => /Elements assayed/.test(textOf(l)))), /4\/9/);
});

test('an empty mastery ledger says so in words, not a blank region', () => {
  const { bus, charters } = makeCharters();
  const panel = openPanel({ bus, charters });
  assert.match(textOf(panel.masteryEl), /Nothing on record yet/);
});

test('collection rows are the real collection() output', () => {
  const relics = { serialize: () => ({ foundIds: { citadel: ['r1', 'r2'] } }) };
  const viewpoints = { serialize: () => ({ worlds: { citadel: ['v1'] } }) };
  const cosmetics = { serialize: () => ['skin-a', 'skin-b'] };
  const { bus, charters } = makeCharters({ relics, viewpoints, cosmetics });
  const panel = openPanel({ bus, charters });

  const c = charters.collection();
  assert.equal(c.relics, 2);
  assert.equal(c.relicTotal, 41); // 17 citadel + 24 medieval, both learned
  const text = textOf(panel.collectionEl);
  assert.match(text, /Relics recovered 2\/41/);
  assert.match(text, /Viewpoints synced 1\/5/);
  assert.match(text, /Skins owned 2/);
});

/* ====================================================================== */
/* 3. Streak / best / season — the undrawn retention fields                */
/* ====================================================================== */

test('the journey rows carry the real streak, best and season', () => {
  const { bus, charters } = makeCharters();
  const NOW = Date.parse('2026-08-25T12:00:00Z');
  const retention = new Retention({ bus, charters, now: () => NOW });
  retention.deserialize({
    done: [
      `daily/${dayKey(NOW)}`,
      `daily/${dayKey(NOW - 86400000)}`,
      /* A longer, broken, older run: best must beat current. */
      `daily/${dayKey(NOW - 5 * 86400000)}`,
      `daily/${dayKey(NOW - 6 * 86400000)}`,
      `daily/${dayKey(NOW - 7 * 86400000)}`,
    ],
    season: [`${seasonKey(NOW)}/citadel`],
  });

  const panel = openPanel({ bus, charters, retention });
  const p = retention.progress();
  assert.equal(p.streak, 2);
  assert.equal(p.best, 3);

  const text = textOf(panel.journeyEl);
  assert.match(text, /Day streak 2 days/);
  assert.match(text, /Best streak 3 days/);
  assert.match(text, new RegExp(`Season ${seasonKey(NOW)} 1 charter`));
});

test('a build without the retention loop says so rather than drawing zeroes', () => {
  const { bus, charters } = makeCharters();
  const panel = openPanel({ bus, charters, retention: null });
  assert.match(textOf(panel.journeyEl), /not running in this build/);
});

/* ====================================================================== */
/* 4. Leaderboards — a real client against a real server                   */
/* ====================================================================== */

/** A real HTTP server; the handler decides the story. */
async function serve(handler) {
  const srv = createServer(handler);
  srv.listen(0, '127.0.0.1');
  await once(srv, 'listening');
  const { port } = srv.address();
  return { api: `http://127.0.0.1:${port}`, close: () => new Promise((r) => srv.close(r)) };
}

test('a real 401 renders the signed-out state, in words', async () => {
  const { api, close } = await serve((req, res) => {
    res.writeHead(401, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'Not authenticated.' }));
  });
  try {
    const { bus, charters } = makeCharters();
    const panel = openPanel({ bus, charters, api });
    await panel._loadBoards();
    assert.equal(panel._boards.state, 'signedout');
    const text = textOf(panel.boardsEl);
    assert.match(text, /Signed out/);
    assert.match(text, /Sign in/);
  } finally {
    await close();
  }
});

test('the boards the server offers render, and the refused ones render as refusals', async () => {
  const INDEX = {
    boards: [
      { id: 'relics', label: 'Relics recovered', why: 'capped by content' },
      { id: 'charters', label: 'Charters restored', why: 'eighteen, once each' },
    ],
    refused: {
      race: 'A client clock with unbounded improvement.',
      credits: 'Ranks whoever forged most patiently.',
    },
  };
  const BOARD = {
    relics: {
      category: 'relics', label: 'Relics recovered', ceiling: 110,
      entries: [
        { rank: 1, name: 'wayfarer', score: 61, self: false },
        { rank: 2, name: 'chester', score: 44, self: true, playerId: 'p1' },
      ],
    },
    charters: { category: 'charters', label: 'Charters restored', ceiling: 1, entries: [] },
  };
  const { api, close } = await serve((req, res) => {
    const url = new URL(req.url, 'http://x');
    const cat = url.searchParams.get('category');
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(cat ? BOARD[cat] : INDEX));
  });
  try {
    const { bus, charters } = makeCharters();
    const panel = openPanel({ bus, charters, api });
    await panel._loadBoards();
    assert.equal(panel._boards.state, 'ready');

    const boards = rowsOf(panel.boardsEl, 'rec-board');
    assert.equal(boards.length, 2, 'the client did not render exactly the boards offered');

    const relicsText = textOf(boards[0]);
    assert.match(relicsText, /Relics recovered/);
    assert.match(relicsText, /#1 wayfarer 61/);
    assert.match(relicsText, /#2 chester \(you\) 44/);
    const selfRow = boards[0].children.find((c) => c.classList.contains('self'));
    assert.ok(selfRow, 'the caller’s own row is not marked');

    assert.match(textOf(boards[1]), /Nobody on this board yet/);

    /* The refusals, in the server's words — and no board invented for them. */
    const refused = rowsOf(panel.boardsEl, 'rec-refused')[0];
    assert.ok(refused, 'the refused categories are not rendered at all');
    const refText = textOf(refused);
    assert.match(refText, /race A client clock with unbounded improvement/);
    assert.match(refText, /credits Ranks whoever forged most patiently/);
    assert.ok(!/#\d/.test(refText), 'a refused category grew ranked rows client-side');
  } finally {
    await close();
  }
});

test('an unreachable service renders the offline state, in words', async () => {
  /* A really closed port: bind, read the number, close, then dial it. */
  const { api, close } = await serve(() => {});
  await close();
  const { bus, charters } = makeCharters();
  const panel = openPanel({ bus, charters, api });
  await panel._loadBoards();
  assert.equal(panel._boards.state, 'offline');
  assert.match(textOf(panel.boardsEl), /unreachable/);
});

/* ====================================================================== */
/* 5. Open/close and key discipline                                        */
/* ====================================================================== */

const key = (code, extra = {}) => ({
  code, repeat: false, ctrlKey: false, metaKey: false, altKey: false,
  preventDefault() {}, stopPropagation() {}, ...extra,
});

test('N toggles, Escape closes, and ui:modal brackets both — before the lock goes', () => {
  const { bus, charters } = makeCharters();
  const root = makeNode('div');
  const input = inputStub();
  input.locked = true;
  const events = [];
  bus.on('ui:modal', (p) => events.push({ ...p, lockedAtEmit: input.locked }));

  const panel = new RecordsPanel({ root, bus, input, charters });
  panel._onWindowKey(key('KeyN'));
  assert.equal(panel.isOpen, true);
  assert.deepEqual(events[0], { id: 'records', open: true, lockedAtEmit: true },
    'ui:modal open must land while the lock is still held, or standby wins the race');
  assert.equal(input.locked, false, 'opening did not release the pointer lock');
  assert.ok(document.body.classList.contains('records-open'));

  panel._onWindowKey(key('Escape'));
  assert.equal(panel.isOpen, false);
  assert.equal(events[1].open, false);
  assert.ok(!document.body.classList.contains('records-open'));

  /* And N while a text field owns the keyboard does nothing. */
  input.textCaptured = true;
  panel._onWindowKey(key('KeyN'));
  assert.equal(panel.isOpen, false, 'N opened the sheet over a chat message being typed');
});

/* ====================================================================== */
/* 6. The wiring is real — source guards                                   */
/* ====================================================================== */

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const readSrc = async (p) => (await readFile(path.join(root, p), 'utf8')).replace(/\r\n/g, '\n');

test('main.js constructs the panel, wires the hub row and pauses the world under it', async () => {
  const src = await readSrc('src/main.js');
  assert.ok(src.includes('new RecordsPanel({'), 'main.js never constructs RecordsPanel');
  assert.ok(src.includes("id: 'records'"), 'the pause hub has no records row');
  assert.ok(src.includes("setGameplayBlocked('records'"),
    'nothing pauses gameplay while the records sheet is up on a touch session');
});

test('the panel brings its stylesheet in itself, so the layout harness styles it', async () => {
  const src = await readSrc('src/ui/RecordsPanel.js');
  assert.ok(src.includes("import './records.css'"),
    'RecordsPanel no longer imports records.css — the probe would lay it out unstyled');
});
