import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { register } from 'node:module';

/**
 * A NEW SERVER BOARD MUST NEED NO CLIENT CHANGE. PROVEN, NOT ASSERTED.
 *
 * The server-scoped time boards were designed around a claim about a file this
 * work does not own: `RecordsPanel` loops whatever `/api/game/leaderboard`
 * offers in its index, fetches each id back, and renders `label` and
 * `${e.score}` — so a category added purely on the server should appear on the
 * standings sheet with nothing shipped to the game at all.
 *
 * A claim like that is exactly the kind this repository has been burned by:
 * "the model is finished, the view will pick it up" is how `Charters.mastery()`
 * and `Charters.collection()` came to be fully written with zero callers. So it
 * is driven rather than believed. The REAL `RecordsPanel` runs against a REAL
 * `node:http` server answering the REAL response shape the route now emits, and
 * the assertions are about what a player would see.
 *
 * The two design decisions this pins, both of which exist only to make the
 * claim true:
 *
 *   1. The board id is opaque to the client. The panel passes back whatever the
 *      index gave it, so `race_time.race.vellum.standard` needs no parser.
 *   2. `score` carries a FORMATTED time, with the raw `ms` beside it. The panel
 *      renders `${e.score}`; a millisecond integer would read as "220338" on
 *      the sheet, which is why the formatting is on the server.
 *
 * If `RecordsPanel` later grows a proper time renderer, this test should be
 * updated to match — its job is to prove the sheet is never WRONG about a board
 * the server offers, not to freeze how it draws one.
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
/* The DOM shim `records-panel.test.mjs` records                           */
/* ---------------------------------------------------------------------- */

function makeNode(tag) {
  const listeners = new Map();
  return {
    tagName: String(tag).toUpperCase(),
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
}

globalThis.document = globalThis.document ?? {};
globalThis.document.createElement = (tag) => makeNode(tag);
globalThis.document.body = globalThis.document.body ?? makeNode('body');
globalThis.window = globalThis.window ?? globalThis;
globalThis.window.addEventListener = globalThis.window.addEventListener ?? (() => {});
globalThis.window.removeEventListener = globalThis.window.removeEventListener ?? (() => {});

const { RecordsPanel } = await import('../../src/ui/RecordsPanel.js');

/** Every text node under a shim node, flattened. */
function textOf(node) {
  if (!node) return '';
  let out = node._text ?? '';
  for (const c of node.children ?? []) out += ' ' + textOf(c);
  return out.trim().replace(/\s+/g, ' ');
}

/** The exact ids and labels `leaderboard.ts` builds for a member's boards. */
const TIME_ID = 'race_time.race.vellum.standard';
const TIME_LABEL = 'Vellum Ridge Circuit · CONTENDER';

/**
 * The response shape `/api/game/leaderboard` now emits for a member.
 *
 * Hand-written here on purpose: this test is about whether the CLIENT can read
 * that shape, so importing the server's own serialiser would only prove the
 * route agrees with itself.
 */
function leaderboardServer() {
  const server = createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    const category = url.searchParams.get('category');
    res.writeHead(200, { 'Content-Type': 'application/json' });

    if (!category) {
      return res.end(JSON.stringify({
        boards: [
          { id: 'relics', label: 'Relics recovered', why: 'capped by content' },
          { id: TIME_ID, label: TIME_LABEL, why: '5 laps of 1599 m.' },
        ],
        refused: { trial: 'A client clock.' },
        server: 'srv-1',
      }));
    }
    if (category === 'relics') {
      return res.end(JSON.stringify({
        category, label: 'Relics recovered', ceiling: 1980, unit: 'count', floor_ms: null,
        entries: [{ rank: 1, name: 'ada', score: 42, self: false }],
      }));
    }
    if (category === TIME_ID) {
      return res.end(JSON.stringify({
        category, label: TIME_LABEL, ceiling: null, unit: 'time', floor_ms: 86449,
        entries: [
          { rank: 1, name: 'ada', score: '3:40.338', ms: 220338, self: false },
          { rank: 2, name: 'bo', score: '4:02.001', ms: 242001, self: true, playerId: 'p2' },
        ],
      }));
    }
    return res.end(JSON.stringify({ error: 'Unknown leaderboard.' }));
  });
  server.listen(0, '127.0.0.1');
  return server;
}

const inputStub = () => ({
  locked: false,
  textCaptured: false,
  exitLock() { this.locked = false; },
  reengage: () => null,
});

test('the standings sheet draws a server time board with no client change', async () => {
  const server = leaderboardServer();
  await once(server, 'listening');
  const api = `http://127.0.0.1:${server.address().port}`;
  const panel = new RecordsPanel({
    root: makeNode('div'), bus: null, input: inputStub(),
    charters: null, retention: null, api,
  });
  try {
    panel.open();
    await panel._loadBoards();

    const drawn = textOf(panel.boardsEl);

    /* The board is there, under the label the SERVER chose — the panel never
     * parses `race_time.race.vellum.standard` and does not need to. */
    assert.match(drawn, /Vellum Ridge Circuit/,
      'a board the server offered was not drawn at all');

    /* And the times read as times. This is what the server-side formatting
     * buys: `${e.score}` on a millisecond integer would print "220338". */
    assert.match(drawn, /3:40\.338/, 'the time board rendered no readable time');
    assert.match(drawn, /4:02\.001/);
    assert.ok(!/220338/.test(drawn), 'a raw millisecond count reached the sheet');

    /* No error row. A board id the panel could not resolve would render
     * "Could not read this board", which is the failure mode this whole
     * arrangement exists to avoid. */
    assert.ok(!/Could not read this board/.test(drawn),
      'the panel failed to read a board the server offered it');
    assert.ok(!/Nobody on this board yet/.test(drawn));

    /* The caller's own row is still marked, and the counting board beside it is
     * untouched — a new category must not disturb an existing one. */
    assert.match(drawn, /bo \(you\)/);
    assert.match(drawn, /Relics recovered/);
    assert.match(drawn, /42/);

    /* And the refusals still render in the server's own words. */
    assert.match(drawn, /NOT RANKED, BY DESIGN/);
    assert.match(drawn, /A client clock/);
  } finally {
    panel.dispose();
    await new Promise((r) => server.close(r));
  }
});

test('a board the panel cannot read still says so rather than vanishing', async () => {
  /* The other half of the claim: the sheet is honest when the server offers an
   * id it then refuses. Without this, "no client change needed" could be true
   * because the panel silently drops anything it does not understand. */
  const server = createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    if (!url.searchParams.get('category')) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({
        boards: [{ id: TIME_ID, label: TIME_LABEL, why: '' }],
        refused: {},
        server: null,
      }));
    }
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'That board only exists inside a custom server.', reason: 'server_only' }));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const api = `http://127.0.0.1:${server.address().port}`;
  const panel = new RecordsPanel({
    root: makeNode('div'), bus: null, input: inputStub(),
    charters: null, retention: null, api,
  });
  try {
    panel.open();
    await panel._loadBoards();
    const drawn = textOf(panel.boardsEl);
    assert.match(drawn, /Vellum Ridge Circuit/);
    assert.match(drawn, /Could not read this board \(http 404\)/,
      'a refused board vanished from the sheet instead of saying what happened');
  } finally {
    panel.dispose();
    await new Promise((r) => server.close(r));
  }
});
