import { test } from 'node:test';
import assert from 'node:assert/strict';

/**
 * THE SERVER CHIP RENDERS WHAT THE SESSION ACTUALLY SAYS.
 *
 * ── The requirement ───────────────────────────────────────────────────────
 *
 * "When playing the HUD should make it clear if I am on a custom server /
 * which one, or general play." The chip is fed by exactly one event -
 * `session:server`, emitted by main.js only when `/api/game/session` names a
 * server - and every degraded shape (absent field on an older deploy, null,
 * 401, network error, timeout) means GENERAL PLAY, silently. So the states
 * under test are the whole contract: a named server shows the name on the HUD
 * chip and the pause-card mirror; everything else is the built state, which
 * is no chrome at all.
 *
 * ── Why the wiring is exercised, not re-implemented ───────────────────────
 *
 * The subscription lives in `_wireSession`, a real prototype method called by
 * `_wire`, precisely so this file can register the REAL handler over a real
 * `EventBus` and drive it with `bus.emit` - a test that subscribed its own
 * lambda would keep passing after a typo in the event name or the payload
 * plucking, which is a gate measuring something the game does not do.
 *
 * ── Why the DOM is a shim and the HUD is not ──────────────────────────────
 *
 * A whole `HUD` cannot be constructed headlessly (a hundred elements, a
 * `ChatBox`, a `WeaponWheel`). The chip is built by the REAL `_buildServer`
 * over an element shim and written by the REAL `_setServer` - the same
 * technique `charter-hud`, `discovery-hud` and `mount-hud` use. The pause
 * mirror's two nodes are attached by hand because `_buildPause` needs a
 * `PauseMenu` and a `window`; `_setServer` writes them through the same
 * guarded references it uses in the game.
 */

/* ---------------------------------------------------------------------- */
/* A DOM, reduced to what `el()` and the chip touch                        */
/* ---------------------------------------------------------------------- */

function makeNode(tag) {
  const node = {
    tagName: tag,
    className: '',
    hidden: false,
    children: [],
    _text: '',
    get textContent() { return this._text; },
    set textContent(v) {
      this._text = String(v);
      if (this._text === '') this.children.length = 0;
    },
    appendChild(c) { node.children.push(c); return c; },
    append(...cs) { for (const c of cs) node.children.push(c); },
    classList: {
      _set: new Set(),
      add(c) { this._set.add(c); },
      toggle(c, on) { if (on) this._set.add(c); else this._set.delete(c); },
      contains(c) { return this._set.has(c); },
    },
  };
  return node;
}

globalThis.document = globalThis.document ?? {};
globalThis.document.createElement = (tag) => makeNode(tag);
globalThis.document.createElementNS = (_ns, tag) => makeNode(tag);
globalThis.window = globalThis.window ?? globalThis;
globalThis.window.addEventListener = globalThis.window.addEventListener ?? (() => {});
globalThis.window.removeEventListener = globalThis.window.removeEventListener ?? (() => {});

const { HUD } = await import('../../src/ui/HUD.js');
const { EventBus } = await import('../../src/core/EventBus.js');

/**
 * A HUD reduced to the server chip: real `_buildServer`, real `_wireSession`,
 * real `EventBus`, plus the pause mirror's two nodes.
 */
function rig() {
  const h = Object.create(HUD.prototype);
  h.bus = new EventBus();
  h._offs = [];
  h._server = null;
  h._serverText = '';
  const col = makeNode('div');
  h._buildServer(col);
  h.pauseServer = makeNode('div');
  h.pauseServer.hidden = true;
  h.pauseServerName = makeNode('span');
  h._wireSession();
  return h;
}

/* ====================================================================== */
/* 1. General play is the built state                                      */
/* ====================================================================== */

test('before any event, both chips are hidden - general play costs nothing', () => {
  const h = rig();
  assert.equal(h.serverChip.hidden, true, 'the HUD chip is visible before any session arrived');
  assert.equal(h.pauseServer.hidden, true, 'the pause mirror is visible before any session arrived');
  assert.equal(h.serverName.textContent, '');
});

/* ====================================================================== */
/* 2. A named server renders on both chips, through the real event         */
/* ====================================================================== */

test('the session:server event renders the name on the chip and the pause mirror', () => {
  const h = rig();
  h.bus.emit('session:server', { server: { id: 'srv_1', name: 'Ironvale Frontier RP' } });

  assert.equal(h.serverChip.hidden, false, 'a named server left the chip hidden');
  assert.equal(h.serverName.textContent, 'Ironvale Frontier RP');
  assert.equal(h.pauseServer.hidden, false, 'a named server left the pause mirror hidden');
  assert.equal(h.pauseServerName.textContent, 'Ironvale Frontier RP',
    'the pause card disagrees with the HUD');
  assert.deepEqual(h._server, { id: 'srv_1', name: 'Ironvale Frontier RP' });
});

test('a name is trimmed, and a missing id degrades to an empty string', () => {
  const h = rig();
  h.bus.emit('session:server', { server: { name: '  Bastion  ' } });
  assert.equal(h.serverName.textContent, 'Bastion');
  assert.equal(h._server.id, '');
});

/* ====================================================================== */
/* 3. Every degraded payload means general play                            */
/* ====================================================================== */

test('null, absent, and nameless payloads all render the general state', () => {
  for (const payload of [
    { server: null },          // the endpoint saying "general play" out loud
    {},                        // an older deploy without the field
    undefined,                 // an emit with no payload at all
    { server: {} },            // a server object with no name
    { server: { id: 'x', name: '   ' } },  // a name that is only whitespace
    { server: { id: 'x', name: 42 } },     // a name that is not a string
  ]) {
    const h = rig();
    h.bus.emit('session:server', payload);
    assert.equal(h.serverChip.hidden, true,
      `payload ${JSON.stringify(payload)} showed the chip`);
    assert.equal(h.pauseServer.hidden, true,
      `payload ${JSON.stringify(payload)} showed the pause mirror`);
    assert.equal(h._server, null);
  }
});

test('a later downgrade to general play clears a chip that was showing', () => {
  const h = rig();
  h.bus.emit('session:server', { server: { id: 's', name: 'Bastion' } });
  assert.equal(h.serverChip.hidden, false);
  h.bus.emit('session:server', { server: null });
  assert.equal(h.serverChip.hidden, true, 'the chip survived a downgrade to general play');
  assert.equal(h.pauseServer.hidden, true);
  assert.equal(h._server, null);
});

/* ====================================================================== */
/* 4. A hostile-length name cannot be parked in the DOM                    */
/* ====================================================================== */

test('a hostile-length name is capped in the DOM and ends in an ellipsis', () => {
  const h = rig();
  const hostile = 'A'.repeat(5000);
  h.bus.emit('session:server', { server: { id: 'srv_evil', name: hostile } });

  assert.equal(h.serverChip.hidden, false, 'a long name is still a real server');
  assert.equal(h.serverName.textContent.length, 64, 'the DOM string is not capped');
  assert.ok(h.serverName.textContent.endsWith('…'), 'the cap does not read as truncation');
  assert.equal(h.pauseServerName.textContent, h.serverName.textContent,
    'the two chips truncated differently');
  /* The untruncated name is NOT kept anywhere the layout can reach - the
   * state carries the capped string too. */
  assert.equal(h._server.name.length, 64);
});

test('a name at exactly the cap is shown whole', () => {
  const h = rig();
  const name = 'B'.repeat(64);
  h.bus.emit('session:server', { server: { id: 's', name } });
  assert.equal(h.serverName.textContent, name, 'a 64-char name was truncated');
});
