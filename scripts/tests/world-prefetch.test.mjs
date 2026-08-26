import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { WorldPrefetch, pickPrefetchTarget, PREFETCH_RANGE } from '../../src/systems/WorldPrefetch.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
/** NORMALISE. See the note in `hud-source-checks.mjs`; this repo checks out CRLF. */
const read = async (p) => (await readFile(path.join(root, p), 'utf8')).replace(/\r\n/g, '\n');
const readCode = async (p) => (await read(p))
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/(^|[^:'"`])\/\/.*$/gm, '$1');

/**
 * LAZY WORLD PREPARATION.
 *
 * ── The defect ────────────────────────────────────────────────────────────
 *
 * The boot used to generate and warm every other world the moment the player
 * entered the first one. Measured on the production bundle on an RTX 5080:
 * 93.5 s of chain, 46 s of it spent inside frames over 24 ms, twelve of them
 * over 250 ms - a top-end desktop choppy for a minute and a half of every
 * session, and the owner's "loading all the worlds freezes the desktop all the
 * time". `WorldPrefetch` prepares a world when its gateway comes within reach
 * instead. See the module's docblock for the attribution.
 *
 * ── What is tested where ──────────────────────────────────────────────────
 *
 *   1. THE POLICY, driven. `pickPrefetchTarget` and `WorldPrefetch.update` are
 *      pure over plain objects, so the "nearest unprepared gateway in range,
 *      one at a time, hold the rest" contract is exercised for real.
 *   2. THE WIRING, scraped. That main.js runs the lazy poller by default and
 *      the eager chain only under `?prefetch=all`; that the per-world step
 *      still claims the gateways before the sliced warm and releases them in
 *      a `finally`; and that the instruments ask for the chain they measure.
 */

/* ---------------------------------------------------------------------- */
/* 1. The policy                                                           */
/* ---------------------------------------------------------------------- */

const at = (x, z) => ({ x, y: 0, z });
const gate = (target, x, z) => ({ target, position: at(x, z), _warmPending: false });

test('the nearest unprepared gateway inside the range is picked, and nothing outside it', () => {
  const portals = [gate('medieval', 30, 0), gate('sports', 10, 0), gate('race', 100, 0)];
  const prepared = new Set();
  assert.equal(pickPrefetchTarget(portals, at(0, 0), (id) => prepared.has(id)), 'sports');
  prepared.add('sports');
  assert.equal(pickPrefetchTarget(portals, at(0, 0), (id) => prepared.has(id)), 'medieval');
  prepared.add('medieval');
  /* The race gateway is 100 m off: a player who never walks that way never
   * pays for that world. That is the whole point. */
  assert.equal(pickPrefetchTarget(portals, at(0, 0), (id) => prepared.has(id)), null);
  assert.equal(pickPrefetchTarget(portals, at(60, 0), (id) => prepared.has(id)), 'race');
});

test('a durable world in range is prepared before a volatile one, however near the volatile one is', () => {
  /* The maze's gateway is the nearest to the station's spawn, and the maze is
   * thrown away on entry. Measured: a stationary player's first preparation
   * was a 12.6 s maze build while the citadel waited. */
  const portals = [gate('maze', 10, 0), gate('citadel', 30, 0), gate('sports', 200, 0)];
  const none = () => false;
  const volatile = (id) => id === 'maze';
  assert.equal(pickPrefetchTarget(portals, at(0, 0), none, PREFETCH_RANGE, volatile), 'citadel');
  // The volatile one is still prepared - after the durable ones in reach.
  assert.equal(pickPrefetchTarget(portals, at(0, 0), (id) => id === 'citadel', PREFETCH_RANGE, volatile), 'maze');
  // Without the rule the nearest wins, as before.
  assert.equal(pickPrefetchTarget(portals, at(0, 0), none, PREFETCH_RANGE), 'maze');
});

test('the range starts just past the preview range, so the disc has a world to show', async () => {
  /* `PREVIEW_RANGE` is module-private to Portals.js, so it is read off the
   * source. A prefetch range at or under it would mean the preview asks for a
   * destination that has not started preparing. */
  const portals = await read('src/systems/Portals.js');
  const m = portals.match(/const PREVIEW_RANGE = (\d+);/);
  assert.ok(m, 'Portals.js no longer declares PREVIEW_RANGE');
  assert.ok(PREFETCH_RANGE > Number(m[1]),
    `PREFETCH_RANGE (${PREFETCH_RANGE}) must exceed PREVIEW_RANGE (${m[1]})`);
  /* And not so far that the station's whole ring qualifies from the plaza
   * centre: the gateways stand at PORTAL_R from it, and a range past that is
   * the old chain again with a different name. */
  const plan = await read('src/worlds/station/Plan.js').catch(() => '');
  const r = plan.match(/PORTAL_R\s*=\s*(\d+)/);
  if (r) {
    assert.ok(PREFETCH_RANGE < Number(r[1]),
      `PREFETCH_RANGE (${PREFETCH_RANGE}) reaches every ring gateway from the plaza centre (PORTAL_R ${r[1]})`);
  }
});

test('one world prepares at a time, nearest first, and each exactly once', async () => {
  const log = [];
  let release;
  const prepare = (id) => {
    log.push(`start:${id}`);
    return new Promise((r) => { release = () => { log.push(`done:${id}`); r(); }; });
  };
  const portals = { portals: [gate('medieval', 20, 0), gate('sports', 5, 0)], holdPreviews: () => {} };
  const pf = new WorldPrefetch({ portals, player: { position: at(0, 0) }, prepare });

  pf.update();
  assert.deepEqual(log, ['start:sports']);
  // In flight: the poller waits rather than piling a second build on top.
  pf.update();
  pf.update();
  assert.deepEqual(log, ['start:sports']);

  release();
  await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
  pf.update();
  assert.deepEqual(log, ['start:sports', 'done:sports', 'start:medieval']);
  release();
  await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
  // Everything in range is prepared: nothing more to do, ever, for these two.
  pf.update();
  pf.update();
  assert.deepEqual(log, ['start:sports', 'done:sports', 'start:medieval', 'done:medieval']);
});

test('a gateway whose destination is not prepared is held, every frame, before anything is measured', () => {
  /* The invariant: a preview is never drawn un-warmed. A player can enter a
   * world before its preparation started, come back, and stand next to a
   * gateway whose destination is BUILT but whose preview programs were never
   * linked. The hold is what stops `Portals.update`'s priming draw from
   * paying that link inside one gameplay frame. */
  const held = [];
  const portals = {
    portals: [gate('medieval', 200, 0), gate('sports', 300, 0)],
    holdPreviews: (id) => { held.push(id); portals.portals.forEach((p) => { if (p.target === id) p._warmPending = true; }); },
  };
  const pf = new WorldPrefetch({ portals, player: { position: at(0, 0) }, prepare: () => Promise.resolve() });
  pf.update();
  // Both out of range, both unprepared: both held, neither started.
  assert.deepEqual(held.sort(), ['medieval', 'sports']);
  assert.equal(pf.inFlight, null);
  // Already held: not held again on the next frame.
  pf.update();
  assert.equal(held.length, 2);
  // Once claimed by someone else's preparation it is theirs to hold and release.
  pf.claim('medieval');
  portals.portals[0]._warmPending = false;
  pf.update();
  assert.equal(held.length, 2, 'a prepared world\'s gateway was held again');
});

test('a request for a world already started returns the same preparation', async () => {
  let calls = 0;
  const pf = new WorldPrefetch({ portals: { portals: [] }, player: null, prepare: () => { calls++; return Promise.resolve(); } });
  const a = pf.request('dock');
  const b = pf.request('dock');
  assert.equal(a, b);
  await a;
  assert.equal(calls, 1);
  assert.equal(pf.isPrepared('dock'), true);
});

test('switched off, the poller does nothing at all', () => {
  let calls = 0;
  const portals = { portals: [gate('sports', 5, 0)], holdPreviews: () => { calls++; } };
  const pf = new WorldPrefetch({ portals, player: { position: at(0, 0) }, prepare: () => { calls++; return Promise.resolve(); } });
  pf.enabled = false;
  pf.update();
  assert.equal(calls, 0);
});

/* ---------------------------------------------------------------------- */
/* 2. The wiring                                                           */
/* ---------------------------------------------------------------------- */

test('the boot runs the eager chain only when asked, and the lazy poller otherwise', async () => {
  const src = await readCode('src/main.js');
  const boot = src.slice(src.indexOf('async function boot()'), src.indexOf('\n}', src.indexOf('async function boot()')));
  assert.match(boot, /if \(overrides\.prefetch === 'all'\) scheduleBackgroundBuilds\(startWorld\);/,
    'boot() runs scheduleBackgroundBuilds unconditionally again - every world generates in the '
    + 'player\'s frames on entry, which is the freeze this file exists to keep out');
  assert.match(src, /new WorldPrefetch\(\{[\s\S]{0,200}prepare: \(id\) => prepareWorld\(id\),[\s\S]{0,120}isVolatile: \(id\) => worldManager\.isVolatile\(id\),/,
    'main.js no longer constructs the lazy poller with prepareWorld and the volatile rule');
  assert.match(src, /worldPrefetch\.update\(\);/, 'the poller is never ticked from the frame loop');
  /* Outside the pause gate: the block that holds `player.update` etc. is
   * `if (!uiPaused) {`, and the tick must come after it closes. */
  const tick = src.indexOf('worldPrefetch.update();');
  const gateOpen = src.lastIndexOf('if (!uiPaused) {', tick);
  const gateClose = src.indexOf('\n  }\n', gateOpen);
  assert.ok(gateClose < tick, 'worldPrefetch.update() sits inside the uiPaused gate, so a paused '
    + 'player next to a gateway never gets its world prepared');
});

test('the per-world step claims the gateways before the sliced warm and releases them in a finally', async () => {
  const src = await readCode('src/main.js');
  const from = src.indexOf('function prepareWorld(id)');
  assert.ok(from > 0, 'prepareWorld has gone');
  const fn = src.slice(from, src.indexOf('\n}', from));
  const hold = fn.indexOf('holdPreviews');
  const warm = fn.indexOf('warmWorld(id)');
  assert.ok(hold > 0 && warm > 0 && hold < warm,
    'the gateways are not claimed before warmWorld - frames run inside the sliced warm, and the '
    + 'first one draws an un-warmed preview');
  assert.match(fn, /\.finally\(\(\) => portals\.releasePreviews\?\.\(id\)\)/,
    'the claim is not released in a finally; a build that throws leaves the gateway STABILISING');
  assert.match(fn, /\.then\(\(\) => warmWorld\(id\)\)\s*\.then\(\(\) => warmPortalPreviews\(id\)\)/,
    'the preview warm no longer follows the program warm');
  /* Both callers go through the one door. */
  const chain = src.slice(src.indexOf('function scheduleBackgroundBuilds'), src.indexOf('\n}', src.indexOf('function scheduleBackgroundBuilds')));
  assert.match(chain, /worldPrefetch\.request\(id\)/, 'the eager chain bypasses WorldPrefetch.request and can prepare a world twice');
});

test('the URL overrides exist, and the instruments use them', async () => {
  const cfg = await readCode('src/core/Config.js');
  assert.match(cfg, /prefetch: params\.get\('prefetch'\)/, 'Config.js no longer reads ?prefetch=');
  assert.match(cfg, /quality: params\.get\('quality'\)/, 'Config.js no longer reads ?quality=');

  const fg = await readCode('scripts/frame-gaps.mjs');
  assert.match(fg, /quality=high/, 'frame-gaps no longer pins the tier its baselines were recorded at');
  assert.match(fg, /args\.awaitReady \? '&prefetch=all' : ''/,
    'frame-gaps must ask for the eager chain exactly when it waits for worlds:all-ready, and '
    + 'measure the lazy default when it does not');
});
