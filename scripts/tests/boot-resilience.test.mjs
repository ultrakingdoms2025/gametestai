import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/.*$/gm, '$1 ');

const html = await readFile(path.join(root, 'index.html'), 'utf8');
const main = await readFile(path.join(root, 'src/main.js'), 'utf8');
const mainCode = strip(main);

/**
 * FOUR WAYS THE GAME NEVER STARTED AND NEVER SAID WHY.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 *  1. NO WEBGL: A BLACK RECTANGLE, FOR EVER, WITH NO TEXT
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `main.js` builds an `Engine` at module top level and `Engine`'s constructor
 * builds a `THREE.WebGLRenderer` immediately. Where the renderer cannot be
 * created - hardware acceleration switched off, a blocklisted driver, a VM with
 * no GPU, a locked-down work build - Three throws during MODULE EVALUATION, so
 * every line after it is skipped. `createLoadingScreen` is one of those lines,
 * about a thousand further down. There was no logo, no message, no error state
 * and no `<noscript>`: the player got a black rectangle and nothing else, and
 * the only explanation was in a console they will never open.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 *  2. A HUNG FETCH NEVER REJECTS, SO THE `catch` AROUND IT IS DECORATION
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `fetch` has no timeout. A promise waiting on a socket that will never answer
 * does not resolve and does not reject. `/api/game/session` is awaited from
 * `boot()` immediately after `loader.setStatus('Calibrating optics', 0.95)`, so
 * on a captive portal - a hotel, an airport, a corporate guest network, all of
 * which answer DNS and then hold the connection - or a hung serverless cold
 * start, the loading bar sits at 95% for ever and boot's catch never fires.
 *
 * The other two awaited fetches fail differently and just as permanently:
 * `/api/game/state` sets `remoteInFlight = true` before its await and clears it
 * in `finally`, so one hung POST kills cross-device sync for the session;
 * `/api/lore` holds `loreRefreshInFlight`, which every later refresh returns.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 *  3. "START A NEW GAME INSTEAD" HANDED THE OLD GAME STRAIGHT BACK
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * The button calls `save.clear()`, which is right. But that zeroes the local
 * timestamp, so `adoptRemoteIfNewer` saw `localAt = 0`, decided the server's
 * copy was newer than nothing, and applied the account's inventory, mounts,
 * cosmetics, ship position and character - which is the whole of what that
 * function moves, and the whole of what the player had just asked to be rid of.
 * A timestamp tie-break is for two copies of a game in progress; a deliberate
 * reset is not one of those and no clock can tell the difference.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 *  4. THE BOOT ERROR WAS A DEAD END
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `errorEl.textContent = 'Boot failed: ...'` and nothing else. Almost
 * everything that reaches there is transient - a chunk that failed to fetch, a
 * world build that threw once, a request that timed out - so reloading is
 * genuinely the fix, and the player had no way to know that and nothing to
 * press.
 *
 * ── Why this file is textual ──────────────────────────────────────────────
 *
 * `main.js` cannot be imported: it builds the entire game at module scope
 * (`rehearsal-world-warm.test.mjs` says the same thing and reads it the same
 * way), and `index.html` is markup. What is pinned here is that each guard is
 * PRESENT and WIRED - which is the way each of these four silently becomes a
 * no-op again.
 */

/* ====================================================================== */
/* 1. The page says something even when nothing can run                    */
/* ====================================================================== */

test('index.html has a noscript block that names the cause', () => {
  assert.match(html, /<noscript>/i, 'there is no <noscript> - a blocked script is a blank page');
  const at = html.indexOf('<noscript>');
  const block = html.slice(at, html.indexOf('</noscript>', at));
  assert.match(block, /javascript/i, 'the noscript block does not say what is wrong');
});

test('WebGL is probed before the module script, not after it', () => {
  /* Order is the whole mechanism. A classic `<script>` in the body runs in
   * document order; `type="module"` is deferred until after parsing. So the
   * probe is guaranteed to have run and painted before `main.js` is even
   * fetched - which is the only way to say anything at all when the failure is
   * a throw during that module's evaluation. */
  const probeAt = html.indexOf("getContext('webgl2')");
  const moduleAt = html.indexOf('<script type="module"');
  assert.ok(probeAt > 0, 'index.html does not probe for WebGL at all');
  assert.ok(moduleAt > 0, 'the module script tag is gone');
  assert.ok(probeAt < moduleAt,
    'the WebGL probe runs after the module script, so a throw during module evaluation '
    + 'still leaves the player looking at a black rectangle');
  assert.match(html, /getContext\('webgl'\)/,
    'the probe asks only for webgl2 - a machine with WebGL 1 only would be told it has none');
});

test('the probe hands its context back instead of leaking one', () => {
  // Browsers cap how many WebGL contexts can be live at once (commonly ~16),
  // and the renderer is about to ask for the one that matters.
  assert.match(html, /WEBGL_lose_context/,
    'the probe keeps the context it opened - that is one of the renderer\'s budget, '
    + 'spent to find out whether the renderer can have one');
});

test('the probe renders a page naming the cause, a fix, and a way to the account', () => {
  const at = html.indexOf('__AETHER_FATAL__ = function');
  assert.ok(at > 0, 'there is no fatal renderer');
  const body = html.slice(at, html.indexOf('var probe', at));
  assert.match(body, /\/account/, 'the fatal page offers no way to reach the account');
  assert.match(body, /location\.reload/, 'the fatal page offers no way to try again');

  const call = html.slice(html.indexOf('window.__AETHER_FATAL__(', at));
  assert.match(call, /hardware acceleration/i,
    'the WebGL message does not name the usual cause, so it is an error rather than an answer');
});

test('main.js catches a renderer that throws and shows the same page', () => {
  const at = mainCode.indexOf('new Engine(canvas, bus)');
  assert.ok(at > 0, 'main.js no longer constructs the Engine');
  const around = mainCode.slice(Math.max(0, at - 200), at + 600);
  assert.match(around, /try\s*\{/,
    'the Engine is constructed outside a try - a throw here skips every line below it, '
    + 'including the one that draws the loading screen');
  assert.match(around, /__AETHER_FATAL__/,
    'a renderer that throws does not reach a visible error state');
});

/* ====================================================================== */
/* 2. No awaited fetch can hang for ever                                   */
/* ====================================================================== */

test('every fetch in main.js carries a deadline', () => {
  /* Not "the three we know about" - every one. A fetch added later with no
   * signal is the same defect wearing a different URL, and the failure it
   * produces (a loading bar frozen at 95%, a sync that silently stops for the
   * session) is indistinguishable from a hang of the game itself. */
  const calls = [...mainCode.matchAll(/fetch\(\s*'([^']+)'\s*,\s*\{([\s\S]*?)\}\s*\)/g)];
  assert.ok(calls.length >= 3, `only ${calls.length} fetch calls found in main.js - the scrape has broken`);
  for (const [, url, options] of calls) {
    assert.match(options, /signal:/,
      `fetch('${url}') has no AbortSignal. A hung socket never rejects, so the catch `
      + 'around it is decoration and whatever it guards waits for ever.');
  }
  for (const url of ['/api/game/session', '/api/game/state', '/api/lore']) {
    assert.ok(calls.some(([, u]) => u === url), `fetch('${url}') is gone or was rewritten`);
  }
});

test('the deadline degrades rather than throwing on a browser that lacks it', () => {
  /* `AbortSignal.timeout` is a 2022 API. Returning undefined is exactly the
   * behaviour these call sites had before - no signal at all - rather than a
   * TypeError thrown at module scope, which would be the black rectangle again
   * by a different route. */
  const at = mainCode.indexOf('function abortAfter');
  assert.ok(at > 0, 'the timeout helper is gone');
  const body = mainCode.slice(at, mainCode.indexOf('\n}', at));
  assert.match(body, /AbortSignal\.timeout/);
  assert.match(body, /catch/, 'abortAfter throws on a browser without AbortSignal.timeout');
  assert.match(body, /return undefined/, 'the fallback is not "no signal"');
});

/* ====================================================================== */
/* 3. A fresh start stays fresh                                            */
/* ====================================================================== */

test('an explicit fresh start is not overwritten by the account copy', () => {
  const at = mainCode.indexOf('function adoptRemoteIfNewer');
  assert.ok(at > 0, 'adoptRemoteIfNewer is gone');
  const body = mainCode.slice(at, mainCode.indexOf('\n}', at));
  assert.match(body, /freshStart/,
    'adoptRemoteIfNewer does not check for a fresh start. save.clear() zeroes the local '
    + 'timestamp, so every remote timestamp beats it and the player is handed back the '
    + 'inventory, mounts, cosmetics and character they just asked to be rid of');
  const guard = body.slice(body.indexOf('freshStart'));
  assert.match(guard.slice(0, 220), /return;/, 'the fresh-start check does not actually skip the adoption');

  // ...and the button has to set it.
  assert.match(mainCode, /discard:\s*\(\)\s*=>\s*\{[^}]*freshStart\s*=\s*true/,
    'the "Start a new game instead" button does not latch freshStart');
});

/* ====================================================================== */
/* 4. The boot error offers the thing that usually works                   */
/* ====================================================================== */

test('the boot error state has a retry', async () => {
  const at = mainCode.indexOf('showError(err) {');
  assert.ok(at > 0, 'showError is gone');
  const body = mainCode.slice(at, mainCode.indexOf('\n    },', at));
  assert.match(body, /boot-retry/, 'the boot error has no retry button');
  assert.match(body, /location\.reload/, 'the retry button does not reload');
  assert.match(body, /stopPropagation/,
    'the retry click also reaches the card\'s own handler, which enters the world - the '
    + 'same trap the "Start a new game instead" button documents');

  const css = await readFile(path.join(root, 'src/ui/hud.css'), 'utf8');
  assert.match(css, /\.boot-retry\s*\{/,
    'the retry button has no styling and would render as a bare UA button on the boot card');
});
