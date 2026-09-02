import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

/**
 * THE THREE FAILURES THE PLAYER WAS NEVER TOLD ABOUT.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 *  1. THE GPU WENT AWAY AND THE GAME JUST STOPPED
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `Engine._onContextLost` sets `_paused = true` - correctly; every frame that
 * runs blind is a frame the player has walked, been shot at and fallen through
 * without seeing any of it - and emits `engine:context-lost`. **Nothing in the
 * codebase had ever subscribed to that event.** So a driver hiccup froze the
 * game on its last drawn frame, in silence, with no way for the player to tell
 * it from their own machine hanging, and permanently if the browser never
 * handed the context back.
 *
 * This is not theoretical. `context-recovery.test.mjs` opens with a measured
 * account of it happening: an 11.7 s driver hang took the context, the browser
 * returned it empty, and the game ran at ~1.3 fps for eleven minutes. The
 * recovery machinery that failure produced is real and wired; the one thing
 * still missing was telling the human sitting in front of it.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 *  2. A HALF-RESTORED SAVE, WITH THE AUTOSAVE SWITCHED OFF UNDER IT
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `SaveGame._partial` now disables the autosave to stop a half-loaded game
 * overwriting the intact one. That is the right thing to do and it is also a
 * state the player MUST know they are in - they are looking at a game missing
 * its credits, its bag and its records, and the only way out is their decision.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 *  3. AN ACCOUNT SESSION THAT FAILED FOR A REASON THAT IS NOT "SIGNED OUT"
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `/api/game/session` collapsed 401, 500 and a network error to the same null.
 * `accountActive` stayed false and `creditReporter` never started, so an hour
 * of earnings queued into a reporter that was not running and never reached the
 * account - with nothing on screen, during or after. A 401 is different in kind
 * and stays silent: being signed out is the endpoint working correctly, and a
 * first-run player must see the HUD exactly as it shipped.
 *
 * ── Why a bar and not a toast ─────────────────────────────────────────────
 *
 * All three are STATES. A toast fades in five seconds, which is right for "+30
 * credits" and useless for a condition the player will still be inside ten
 * minutes later and will want to look up when they notice something is wrong.
 *
 * ── Why the wiring is exercised rather than re-implemented ────────────────
 *
 * `_wireAlerts` is a real prototype method called by `_wire`, exactly as
 * `_wireSession` is, so this registers the REAL handlers over a real
 * `EventBus`. A test that subscribed its own lambda would keep passing after a
 * typo in an event name - a gate measuring something the game does not do.
 */

/* ---------------------------------------------------------------------- */
/* A DOM reduced to what `el()` and the bar touch                          */
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
      remove(c) { this._set.delete(c); },
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

/** A HUD reduced to the alert bar: real `_buildAlerts`, real `_wireAlerts`. */
function rig() {
  const h = Object.create(HUD.prototype);
  h.bus = new EventBus();
  h._offs = [];
  h._quiet = false;
  h.toasts = [];
  h._toasts = [];
  h.toastWrap = makeNode('div');
  h.notify = (text, tone) => h.toasts.push({ text, tone });
  const hud = makeNode('div');
  h._buildAlerts(hud);
  h._wireAlerts();
  return h;
}

const shown = (h) => (h.alertEl.hidden ? null : h.alertText.textContent);

/* ====================================================================== */
/* 1. Built state: nothing to say, nothing on screen                       */
/* ====================================================================== */

test('a healthy session shows no bar at all', () => {
  const h = rig();
  assert.equal(h.alertEl.hidden, true, 'the alert bar is visible before anything went wrong');
  assert.equal(h.alertText.textContent, '');
});

/* ====================================================================== */
/* 2. Each condition, through its real event                               */
/* ====================================================================== */

test('a lost graphics context raises a notice that says what to do', () => {
  const h = rig();
  h.bus.emit('engine:context-lost', {});
  const text = shown(h);
  assert.ok(text, 'the GPU went away and the HUD said nothing - the game is frozen on one frame');
  assert.match(text, /graphics/i, 'the notice does not name the cause');
  assert.match(text, /reload/i,
    'the notice does not tell the player what to do if the context never comes back');
});

test('the context coming back clears the bar and says so once', () => {
  const h = rig();
  h.bus.emit('engine:context-lost', {});
  h.bus.emit('engine:context-restored', {});
  assert.equal(shown(h), null, 'the notice outlived the failure it described');
  assert.equal(h.toasts.length, 1, 'the recovery was silent');
  assert.match(h.toasts[0].text, /restored/i);
});

test('a partial load raises a notice naming the autosave being off', () => {
  const h = rig();
  h.bus.emit('save:partial', { message: 'could not restore economy during load' });
  const text = shown(h);
  assert.ok(text, 'a half-restored save left the HUD silent');
  assert.match(text, /autosave is off/i,
    'the notice does not say the autosave has been switched off, which is the whole '
    + 'reason the intact save is still safe');
});

test('a degraded session raises a notice naming the reason', () => {
  const h = rig();
  h.bus.emit('session:offline', { reason: 'timed out' });
  const text = shown(h);
  assert.ok(text, 'the account session failed and nothing appeared');
  assert.match(text, /offline/i);
  assert.match(text, /timed out/, 'the reason the caller supplied was dropped');
  assert.match(text, /local only|account/i,
    'the notice does not say what the player loses - that earnings stop reaching the account');
});

test('a session with no reason still renders', () => {
  const h = rig();
  h.bus.emit('session:offline', {});
  assert.match(shown(h), /offline/i);
});

/* ====================================================================== */
/* 3. One bar, several conditions, and none of them clears another         */
/* ====================================================================== */

test('the GPU coming back does not wipe a save warning that is still true', () => {
  /* The bar is shared, so a naive clear-on-any-recovery would take down a
   * warning about a condition nobody has fixed. The autosave is still off. */
  const h = rig();
  h.bus.emit('save:partial', { message: 'x' });
  h.bus.emit('engine:context-restored', {});
  assert.match(shown(h) ?? '', /autosave is off/i,
    'an unrelated recovery cleared a warning that is still true');
});

test('the newest condition takes the bar, and clearing it falls back to what is still wrong', () => {
  /* The reason `_alerts` is a Map and not one string. These three conditions
   * are independent and overlap easily - a driver hiccup during a session that
   * is already offline is one bad afternoon, not two exotic ones - and a single
   * slot would have blanked the bar when the newer of them recovered, taking a
   * live warning down with it. */
  const h = rig();
  h.bus.emit('session:offline', { reason: 'no connection' });
  h.bus.emit('engine:context-lost', {});
  assert.match(shown(h), /graphics/i, 'the newer, more urgent condition did not take the bar');

  h.bus.emit('engine:context-restored', {});
  assert.match(shown(h) ?? '', /offline/i,
    'the GPU recovering blanked the bar and took the offline warning with it - the '
    + 'account still is not reachable');
});

test('a condition raised twice does not stack, and clears in one', () => {
  const h = rig();
  h.bus.emit('engine:context-lost', {});
  h.bus.emit('engine:context-lost', {});
  h.bus.emit('engine:context-restored', {});
  assert.equal(shown(h), null, 'a repeated loss left a copy of itself behind');
});

/* ====================================================================== */
/* 4. The channels are real - none of these listens to a dead event        */
/* ====================================================================== */

test('every event the bar listens for is one something in src/ actually emits', async () => {
  /* The failure this whole feature is a fix FOR is a subscription with no
   * publisher, or a publisher with no subscriber. Having just added three
   * subscribers, the cheapest way to be wrong is a typo in an event name -
   * which produces a bar that never appears and a test suite that never
   * notices. Five step verbs were deleted from `QuestSystem` for exactly this
   * shape after an audit found 0 of 50 quests completable. */
  const emitted = new Set();
  const walk = async (dir) => {
    for (const e of await readdir(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) { await walk(p); continue; }
      if (!p.endsWith('.js')) continue;
      const s = await readFile(p, 'utf8');
      for (const m of s.matchAll(/emit\??\.?\(\s*'([a-z][\w:-]*)'/g)) emitted.add(m[1]);
    }
  };
  await walk(path.join(root, 'src'));
  assert.ok(emitted.size > 50, 'the emit scrape found almost nothing - it has broken');

  for (const evt of ['engine:context-lost', 'engine:context-restored', 'save:partial',
    'session:offline']) {
    assert.ok(emitted.has(evt),
      `the alert bar waits on "${evt}", which nothing in src/ emits - a notice that can `
      + 'never appear is worse than no notice, because it reads as done');
  }
});

test('_wireAlerts is reached from _wire, not merely defined', async () => {
  /* `HUD.attach` existed since the HUD did and was NEVER CALLED; the six
   * systems it hands over resolved to null for every real player while being
   * perfectly populated in dev. A method nobody calls is this codebase's
   * signature defect, and a headless rig that calls it by hand cannot see it. */
  const src = (await readFile(path.join(root, 'src/ui/HUD.js'), 'utf8'))
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/\/\/.*$/gm, ' ');
  const calls = (src.match(/this\._wireAlerts\(\)/g) ?? []).length;
  assert.equal(calls, 1, `_wireAlerts is called ${calls} times - expected exactly one, from _wire`);
  const builds = (src.match(/this\._buildAlerts\(/g) ?? []).length;
  assert.equal(builds, 1, `_buildAlerts is called ${builds} times - expected exactly one, from _build`);
});

test('main.js only reports offline for a failure that is not a 401', async () => {
  /* Being signed out is the endpoint working correctly. A first-run player must
   * get the HUD exactly as it shipped - no chip, no warning, no chrome - and a
   * bar that cried "offline" at every signed-out player would be noise that
   * teaches everybody to ignore the one case that matters. */
  const src = (await readFile(path.join(root, 'src/main.js'), 'utf8'))
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/\/\/.*$/gm, ' ');
  assert.ok(/res\.status === 401/.test(src),
    'main.js no longer distinguishes a 401 from a real failure - they were the same null, '
    + 'which is how a 500 read as "signed out" and creditReporter silently never started');
  assert.ok(/session:offline/.test(src), 'nothing emits session:offline');
  const at = src.indexOf('session:offline');
  const around = src.slice(Math.max(0, at - 400), at);
  assert.ok(/sessionFailure/.test(around),
    'session:offline is emitted unconditionally rather than only on a real failure');
});
