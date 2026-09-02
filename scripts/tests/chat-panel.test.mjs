import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { register } from 'node:module';

/**
 * THE IN-GAME CHANNEL, AND THE PROMISE IT MUST NOT MAKE.
 *
 * `site/lib/serverChat.ts` has been a complete chat since Phase 7e and `src/`
 * never called it once. This panel is the client. Three classes of failure are
 * gated here, and only one of them is about chat working.
 *
 * ── 1. It must not imply presence the game cannot deliver ────────────────
 *
 * There is no multiplayer netcode. Vercel functions cannot hold a socket and
 * nothing streams a position. A panel that opened a WebSocket, or that said
 * "online now" beside a roster built from a 120-second poll window, would be
 * selling a thing that does not exist — and this repository has shipped a
 * promise without a mechanism before, and the audit found it. So the transport
 * is asserted (plain HTTP, on a timeout chain) and so is the wording.
 *
 * ── 2. It must not be a touch dead end ───────────────────────────────────
 *
 * `input.exitLock()` stands the touch session down, which takes the whole touch
 * tray with it INCLUDING the pause button. A panel closable only by Escape is
 * then unescapable on a phone without reloading the page, which has happened
 * twice here. The close BUTTON is gated as a real control, and closing through
 * it is driven rather than assumed.
 *
 * ── 3. The open/close order, which the pause-menu work paid for ──────────
 *
 * `ui:modal` must be emitted BEFORE the lock is released, or the lock release
 * lands `input:lockchange`, main.js asks for the standby overlay, and
 * `showPauseOverlay` allows it because `HUD._overlays` is still empty — a frame
 * of STANDBY painted over the sheet. The stub below records the order and the
 * test asserts it, rather than reading the code and hoping.
 *
 * The DOM is the shim `records-panel.test.mjs` records, widened for a form: the
 * panel builds through `document.createElement` and keeps references, so the
 * REAL `open()`, `_poll()`, `_send()` and `_render*` run headlessly. The module
 * loader answers `.css` imports with an empty module because the panel imports
 * its own stylesheet — `hud-responsive.test.mjs` requires exactly that of a
 * probe-measured panel — and Node cannot parse CSS.
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

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

/** Read a repo file with line endings normalised. This tree checks out CRLF. */
async function read(rel) {
  return (await readFile(path.join(ROOT, rel), 'utf8')).replace(/\r\n/g, '\n');
}

/* ---------------------------------------------------------------------- */
/* A DOM, reduced to what the panel touches                                */
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
    value: '',
    placeholder: '',
    disabled: false,
    maxLength: 0,
    scrollTop: 0,
    scrollHeight: 0,
    attrs: {},
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
    focus() { globalThis.document.activeElement = this; },
    setAttribute(k, v) { this.attrs[k] = String(v); },
    getAttribute(k) { return this.attrs[k] ?? null; },
    addEventListener(type, fn) {
      const list = listeners.get(type) ?? [];
      list.push(fn);
      listeners.set(type, list);
    },
    removeEventListener() {},
    click() { for (const fn of listeners.get('click') ?? []) fn({}); },
    submit() {
      for (const fn of listeners.get('submit') ?? []) fn({ preventDefault() {} });
    },
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
globalThis.document.activeElement = null;
const windowKeys = [];
globalThis.window = globalThis.window ?? globalThis;
globalThis.window.addEventListener = (type, fn) => { if (type === 'keydown') windowKeys.push(fn); };
/* A real removal, not a no-op. Every panel in this file registers a window key
 * listener and `dispose()` takes it off again; a stub that kept them would let
 * a disposed panel's handler run first and swallow the key the live one was
 * being tested with — which is a bug in the test that reads as a bug in the
 * panel, and did, once. */
globalThis.window.removeEventListener = (type, fn) => {
  const i = windowKeys.indexOf(fn);
  if (i >= 0) windowKeys.splice(i, 1);
};

const { ChatPanel, POLL_IDLE_MS, POLL_OPEN_MS } = await import('../../src/ui/ChatPanel.js');

/* ---------------------------------------------------------------------- */
/* Fixtures                                                                */
/* ---------------------------------------------------------------------- */

/** Every text node under a shim node, flattened. */
function textOf(node) {
  if (!node) return '';
  let out = node._text ?? '';
  for (const c of node.children ?? []) out += ' ' + textOf(c);
  return out.trim().replace(/\s+/g, ' ');
}

/**
 * An input stub that RECORDS THE ORDER of what a panel does to it.
 *
 * The pointer-lock contract is an ordering property, so a stub that only
 * recorded final state would pass against the exact defect the ordering exists
 * to prevent.
 */
function inputStub(log = []) {
  return {
    log,
    locked: true,
    textCaptured: false,
    exitLock() { this.locked = false; log.push('exitLock'); },
    setTextCapture(on) { this.textCaptured = !!on; log.push(`textCapture:${!!on}`); },
    reengage() { this.locked = true; log.push('reengage'); return null; },
  };
}

function busStub(log) {
  return {
    emit(type, payload) { log.push(`${type}:${payload?.id}:${payload?.open}`); },
    on() { return () => {}; },
  };
}

/** A real HTTP server answering the chat endpoint. Returns `{ url, close }`. */
async function serveChat(handler) {
  const seen = [];
  const server = createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    seen.push({ url: req.url, method: req.method, body });
    handler(req, res, seen);
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const { port } = server.address();
  return {
    url: `http://127.0.0.1:${port}`,
    seen,
    close: () => new Promise((r) => server.close(r)),
  };
}

const json = (res, code, obj) => {
  res.writeHead(code, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(obj));
};

/**
 * ONE log for the bus AND the input, because the property under test is an
 * ORDER ACROSS THE TWO.
 *
 * Two separate arrays cannot answer "did `ui:modal` come before `exitLock`",
 * and a version of this file that kept them separate reported the ordering
 * gate as passing while the emit was moved — the mutation could not be seen
 * because the two events were never in the same sequence. `order` is the
 * interleaved truth; `busLog` and `input.log` remain as filtered views for the
 * assertions that only care about one side.
 */
function makePanel(api, extra = {}) {
  const order = [];
  const busLog = [];
  const bus = {
    emit(type, payload) {
      const line = `${type}:${payload?.id}:${payload?.open}`;
      busLog.push(line);
      order.push(line);
    },
    on() { return () => {}; },
  };
  const input = inputStub(order);
  const panel = new ChatPanel({
    root: makeNode('div'),
    bus,
    input,
    api,
    autoStart: false,
    ...extra,
  });
  return { panel, input, busLog, order };
}

/* ====================================================================== */
/* 1. It reads the endpoint that already existed                           */
/* ====================================================================== */

test('renders the messages and roster the real endpoint returns', async () => {
  const srv = await serveChat((req, res) => {
    json(res, 200, {
      serverId: 'srv-1',
      messages: [
        { id: 4, from: 'ada', fromId: 'p1', direct: false, mine: false, body: 'north wall', at: '2026-09-01T10:00:00Z' },
        { id: 5, from: 'you', fromId: 'p2', direct: true, mine: true, body: 'on my way', at: '2026-09-01T10:01:00Z' },
      ],
      cursor: 5,
      active: [{ playerId: 'p1', handle: 'ada' }, { playerId: 'p3', handle: 'bo' }],
    });
  });
  const { panel } = makePanel(srv.url);
  try {
    await panel._poll();
    assert.equal(panel.state, 'ready');
    assert.equal(panel._cursor, 5, 'the cursor did not advance to the id the server gave');

    const log = textOf(panel.logEl);
    assert.match(log, /north wall/);
    assert.match(log, /ada/);
    assert.match(log, /on my way/);
    assert.match(log, /DM/, 'a direct message was not marked as one');

    const roster = panel.rosterEl.children.map((c) => c._text);
    assert.deepEqual(roster, ['ada', 'bo']);
    assert.match(textOf(panel.scopeEl), /2 in the game/);
  } finally {
    panel.dispose();
    await srv.close();
  }
});

test('polls from its cursor, so an idle poll asks for nothing it holds', async () => {
  const srv = await serveChat((req, res, seen) => {
    json(res, 200, {
      serverId: 'srv-1',
      messages: seen.length === 1 ? [{ id: 9, from: 'ada', body: 'hi', at: '' }] : [],
      cursor: 9,
      active: [],
    });
  });
  const { panel } = makePanel(srv.url);
  try {
    await panel._poll();
    await panel._poll();
    assert.match(srv.seen[0].url, /since=0\b/);
    assert.match(srv.seen[1].url, /since=9\b/, 'the second poll did not carry the cursor');
    assert.equal(panel._messages.length, 1, 'an empty page duplicated the held messages');
  } finally {
    panel.dispose();
    await srv.close();
  }
});

test('sends a shout, and a direct message to whoever was picked from the roster', async () => {
  const srv = await serveChat((req, res) => {
    if (req.method === 'POST') return json(res, 200, { id: 11 });
    json(res, 200, { serverId: 'srv-1', messages: [], cursor: 0, active: [{ playerId: 'p1', handle: 'ada' }] });
  });
  const { panel } = makePanel(srv.url);
  try {
    await panel._poll();

    panel.field.value = 'meet at the centre';
    await panel._send();
    const shout = srv.seen.find((r) => r.method === 'POST');
    assert.deepEqual(JSON.parse(shout.body), { body: 'meet at the centre', to: null });
    assert.equal(panel.field.value, '', 'the field was not cleared after a send');

    // Pick a recipient off the roster, exactly as a player does.
    panel.rosterEl.children[0].click();
    assert.match(textOf(panel.toEl), /→ ada/);
    panel.field.value = 'behind you';
    await panel._send();
    const dm = srv.seen.filter((r) => r.method === 'POST').at(-1);
    assert.deepEqual(JSON.parse(dm.body), { body: 'behind you', to: 'p1' });
  } finally {
    panel.dispose();
    await srv.close();
  }
});

test('a rate-limit refusal is shown in the server\'s own words, not swallowed', async () => {
  const srv = await serveChat((req, res) => {
    if (req.method === 'POST') return json(res, 429, { error: 'Slow down.', reason: 'too_fast' });
    json(res, 200, { serverId: 'srv-1', messages: [], cursor: 0, active: [] });
  });
  const { panel } = makePanel(srv.url);
  try {
    await panel._poll();
    panel.field.value = 'spam';
    await panel._send();
    assert.match(textOf(panel.noticeEl), /Slow down/);
    assert.equal(panel.field.value, 'spam', 'a refused message was thrown away');
  } finally {
    panel.dispose();
    await srv.close();
  }
});

/* ====================================================================== */
/* 2. Every degraded state says what it is, and stops paying for nothing   */
/* ====================================================================== */

test('signed out reads as signed out, and the heartbeat stops for good', async () => {
  const srv = await serveChat((req, res) => json(res, 401, { error: 'Not authenticated.' }));
  const { panel } = makePanel(srv.url);
  try {
    await panel._poll();
    assert.equal(panel.state, 'signedout');
    assert.match(textOf(panel.logEl), /Signed out/);
    assert.equal(panel._timer, null,
      'the panel is still polling an endpoint that will never answer it');
    panel._schedule(0);
    assert.equal(panel._timer, null, '_schedule re-armed a terminal state');
  } finally {
    panel.dispose();
    await srv.close();
  }
});

test('a player in no server is told there is no global channel, by design', async () => {
  const srv = await serveChat((req, res) => {
    json(res, 200, { serverId: null, messages: [], cursor: 0, active: [] });
  });
  const { panel } = makePanel(srv.url);
  try {
    await panel._poll();
    assert.equal(panel.state, 'noserver');
    const said = textOf(panel.logEl);
    assert.match(said, /not in a custom server/i);
    assert.match(said, /no global channel/i);
    assert.equal(panel._timer, null, 'a player with no channel is still being polled for');
    assert.equal(panel.field.disabled, true, 'the field invites a message nobody can receive');
  } finally {
    panel.dispose();
    await srv.close();
  }
});

test('an unreachable channel says so, and gives up after a bounded number of tries', async () => {
  const srv = await serveChat((req, res) => json(res, 500, { error: 'nope' }));
  const { panel } = makePanel(srv.url);
  try {
    for (let i = 0; i < 3; i++) await panel._poll();
    assert.equal(panel.state, 'offline');
    assert.match(textOf(panel.logEl), /did not answer/);
    assert.match(textOf(panel.logEl), /unaffected/);
    assert.equal(panel._timer, null, 'a dead endpoint is polled for ever');
  } finally {
    panel.dispose();
    await srv.close();
  }
});

test('a failure never leaves a blank region', async () => {
  /* The rule `RecordsPanel` records: every state is a sentence. A player who
   * opens an empty rectangle has been told nothing and files a bug about the
   * wrong thing. */
  const srv = await serveChat((req, res) => json(res, 500, {}));
  const { panel } = makePanel(srv.url);
  try {
    for (const state of ['idle', 'loading', 'signedout', 'noserver', 'offline']) {
      panel._state = state;
      panel._render();
      assert.ok(textOf(panel.logEl).length > 10, `state "${state}" renders a blank region`);
    }
  } finally {
    panel.dispose();
    await srv.close();
  }
});

/* ====================================================================== */
/* 3. The open/close contract, and the touch dead end                      */
/* ====================================================================== */

test('emits ui:modal BEFORE releasing the lock', async () => {
  /* The ordering the pause-menu work paid for. Release the lock first and
   * `input:lockchange` reaches main.js while `HUD._overlays` is still empty,
   * so `showPauseOverlay` allows a frame of STANDBY over the sheet. */
  const { panel, order } = makePanel('http://127.0.0.1:1');
  try {
    panel.open();
    const modalAt = order.indexOf('ui:modal:chat-panel:true');
    const lockAt = order.indexOf('exitLock');
    const textAt = order.indexOf('textCapture:true');
    assert.ok(modalAt >= 0, 'the panel never announced itself to the overlay Set');
    assert.ok(lockAt >= 0, 'the panel never released the lock');
    assert.ok(modalAt < lockAt,
      'ui:modal was emitted AFTER the lock went — a frame of STANDBY can paint over the sheet');
    assert.ok(textAt >= 0 && textAt < lockAt,
      'WASD could walk the player in the gap between the lock going and text capture');
    assert.ok(globalThis.document.body.classList.contains('chat-panel-open'));
  } finally {
    panel.dispose();
  }
});

test('closes on a REAL BUTTON, not only on Escape', async () => {
  /* `exitLock()` hides the whole touch tray, pause button included, so a panel
   * reachable only by a key a phone does not have needs a page reload to
   * escape. This repository has shipped that dead end twice. */
  const { panel, input, busLog } = makePanel('http://127.0.0.1:1');
  try {
    panel.open();
    assert.equal(panel.closeBtn.tagName, 'BUTTON');
    assert.equal(panel.closeBtn.type, 'button');
    assert.ok(panel.closeBtn.getAttribute('aria-label'), 'the close control has no accessible name');

    panel.closeBtn.click();
    assert.equal(panel.isOpen, false, 'the on-screen close button does not close the panel');
    assert.equal(busLog.at(-1), 'ui:modal:chat-panel:false');
    assert.equal(input.textCaptured, false, 'text capture survived the close');
    assert.ok(!globalThis.document.body.classList.contains('chat-panel-open'));
  } finally {
    panel.dispose();
  }
});

test('hands the lock back only when the lock was ours to give', async () => {
  const { panel, input } = makePanel('http://127.0.0.1:1');
  try {
    input.locked = false;               // a player already in a menu
    panel.open();
    panel.close();
    await new Promise((r) => setTimeout(r, 200));
    assert.ok(!input.log.includes('reengage'),
      'the panel grabbed a pointer lock it never had');
  } finally {
    panel.dispose();
  }

  const second = makePanel('http://127.0.0.1:1');
  try {
    second.input.locked = true;
    second.panel.open();
    second.panel.close();
    assert.ok(!second.input.log.includes('reengage'),
      'the re-lock was immediate — browsers refuse one that close to an Escape exit');
    await new Promise((r) => setTimeout(r, 200));
    assert.ok(second.input.log.includes('reengage'), 'the lock was never handed back');
  } finally {
    second.panel.dispose();
  }
});

test('Y opens the panel and never closes it', async () => {
  /* A toggle would close the panel every time somebody typed the letter y into
   * the message field, because the panel is text-captured while open. */
  /* A panel opened by an earlier test focused its own field, and the guard
   * below is `activeElement?.tagName === 'INPUT'` — a player typing into any
   * text box must not be teleported into chat. Reset it so this test is about
   * the key rather than about the last test's focus. */
  globalThis.document.activeElement = null;
  const { panel } = makePanel('http://127.0.0.1:1');
  const fire = (code) => {
    for (const fn of [...windowKeys]) fn({ code, preventDefault() {}, stopPropagation() {} });
  };
  try {
    fire('KeyY');
    assert.equal(panel.isOpen, true, 'Y did not open the channel');
    fire('KeyY');
    assert.equal(panel.isOpen, true, 'Y closed the panel a player was typing into');
    fire('Escape');
    assert.equal(panel.isOpen, false, 'Escape did not close the panel');
  } finally {
    panel.dispose();
    windowKeys.length = 0;
  }
});

/* ====================================================================== */
/* 4. It promises nothing the transport cannot deliver                     */
/* ====================================================================== */

test('opens no socket, and says out loud that messages arrive on a poll', async () => {
  const src = await read('src/ui/ChatPanel.js');
  for (const forbidden of ['WebSocket', 'EventSource', 'RTCPeerConnection', 'socket.io']) {
    assert.ok(!src.includes(forbidden),
      `ChatPanel reaches for ${forbidden} — this game has no realtime transport`);
  }
  /* And the wording. A roster from a 120-second poll window that said "online
   * now" would be selling presence the game cannot deliver. */
  const { panel } = makePanel('http://127.0.0.1:1');
  try {
    const footer = textOf(panel._el);
    assert.match(footer, /arrive when this panel polls/i);
    assert.match(footer, /Seen in the last two minutes/i);
    assert.match(footer, /no shared world instance/i);
  } finally {
    panel.dispose();
  }
});

test('polls on a timeout chain, so a slow link cannot stack requests', async () => {
  /* `setInterval` fires on a schedule that knows nothing about whether the last
   * request came back; on a slow link that stacks requests and the cursor
   * arrives out of order. */
  /* Comments stripped first: the file carries a note saying why it is a chain
   * and NOT a `setInterval`, and a scan that read prose would fail on the
   * explanation of its own rule. It failed exactly that way the first time. */
  const src = (await read('src/ui/ChatPanel.js')).replace(/\/\*[\s\S]*?\*\//g, '');
  assert.ok(!/setInterval/.test(src), 'the poll loop is an interval, not a chain');
  assert.match(src, /if \(this\._polling\) return;/,
    'nothing stops two polls being in flight at once');

  const srv = await serveChat((req, res) => {
    setTimeout(() => json(res, 200, { serverId: 's', messages: [], cursor: 1, active: [] }), 40);
  });
  const { panel } = makePanel(srv.url);
  try {
    await Promise.all([panel._poll(), panel._poll(), panel._poll()]);
    assert.equal(srv.seen.length, 1, 'concurrent polls were not collapsed');
  } finally {
    panel.dispose();
    await srv.close();
  }
});

test('a dispose during a poll does not leave the chain running', async () => {
  /* The leak this exists for, and how it was found. `dispose()` clears
   * `_timer`, but `_poll()` re-arms the chain from its own `finally` — so a
   * dispose that lands while a request is in flight clears a timer that the
   * settling request puts straight back. The panel is gone, its DOM is gone,
   * and it polls for ever.
   *
   * It surfaced while checking that the terminal-state gate could FAIL: with
   * that guard broken the test run never exited, because the chain kept
   * re-arming against a closed server. The mutation was not the shipped path;
   * the leak it exposed is, one `dispose()` during a poll away. */
  const srv = await serveChat((req, res) => {
    setTimeout(() => json(res, 200, { serverId: 's', messages: [], cursor: 1, active: [] }), 30);
  });
  const { panel } = makePanel(srv.url);
  try {
    const inFlight = panel._poll();
    panel.dispose();               // while the request is still open
    await inFlight;
    assert.equal(panel._timer, null,
      'a disposed panel re-armed itself from the finally of an in-flight poll');
    panel._schedule(0);
    assert.equal(panel._timer, null, '_schedule re-armed a disposed panel');
  } finally {
    await srv.close();
  }
});

test('the heartbeat is slower than the open poll and inside the presence window', async () => {
  /* `PRESENCE_WINDOW_SECONDS` is 120 in `site/lib/customServers.ts`. A beat
   * slower than that means a player who is in the game reads as gone; a beat as
   * fast as the open poll means an idle session paying for a panel nobody has
   * opened. */
  const servers = await read('site/lib/customServers.ts');
  const win = /PRESENCE_WINDOW_SECONDS = (\d+)/.exec(servers);
  assert.ok(win, 'the presence window is no longer readable — the beat rate is now a guess');
  assert.ok(POLL_IDLE_MS < Number(win[1]) * 1000,
    'the heartbeat is slower than the presence window it exists to stay inside');
  assert.ok(POLL_IDLE_MS > POLL_OPEN_MS,
    'a shut panel polls as hard as an open one');
});

/* ====================================================================== */
/* 5. The stylesheet half of the phone contract                            */
/* ====================================================================== */

test('the sheet measures no height in vh, not even inside a custom property', async () => {
  /* A phone's URL bar slides away and `100vh` is the LARGE viewport, so the
   * bottom of a `vh`-sized sheet sits behind the browser chrome while the bar
   * is up. Eleven sheets in this tree were measuring heights in `vh` when that
   * check was written; this one is held to the same rule at birth.
   *
   * Comments stripped first, because this sheet carries a note explaining the
   * rule and a scan that read prose would fail on its own explanation. */
  const css = (await read('src/ui/chat-panel.css')).replace(/\/\*[\s\S]*?\*\//g, '');
  const heights = [...css.matchAll(
    /(^|[\n;{])\s*((?:max-|min-)?height|inset|bottom|top)\s*:\s*([^;}]*\d(?:\.\d+)?vh[^;}]*)/g,
  )];
  assert.deepEqual(heights.map((m) => `${m[2]}: ${m[3].trim()}`), []);
  const custom = [...css.matchAll(/(^|[\n;{])\s*(--[\w-]+)\s*:\s*([^;}]*\d(?:\.\d+)?vh[^;}]*)/g)];
  assert.deepEqual(custom.map((m) => `${m[2]}: ${m[3].trim()}`), []);
});

test('the sheet reads the notch through the hud.css tokens, never env() itself', async () => {
  const css = (await read('src/ui/chat-panel.css')).replace(/\/\*[\s\S]*?\*\//g, '');
  assert.ok(!/env\(\s*safe-area-inset/.test(css),
    'chat-panel.css reads env() directly — the interface must have ONE answer to where the notch is');
  assert.match(css, /var\(--sa-t, 0px\)/);
  assert.match(css, /var\(--sa-b, 0px\)/);
});

test('the panel brings its own stylesheet, and keeps standby off the sheet', async () => {
  const js = await read('src/ui/ChatPanel.js');
  assert.match(js, /import '\.\/chat-panel\.css'/,
    'the panel would be laid out unstyled by the viewport harness');
  const css = await read('src/ui/chat-panel.css');
  assert.match(css, /body\.chat-panel-open \.pause/,
    'the standby overlay can paint over an open channel');
});
