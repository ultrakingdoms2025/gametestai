/**
 * THE THREE THINGS THAT WENT WRONG BY BEING PLAUSIBLE.
 *
 * Every defect guarded here read as correct code and cost seconds per session
 * for as long as it stood. None of them is reachable from a unit test of
 * behaviour: `src/main.js` touches `document` and WebGL at module scope and
 * cannot be imported under Node, which is exactly why `contract-check.mjs`
 * exists and checks the API surface textually. These do the same, plus the one
 * behavioural check that actually settles the argument - what three's fog
 * classes really carry - because that is the fact the bug depended on.
 *
 *   1. `arrivalKeyOf` keyed the persistent shader warm on `fog.type`, which
 *      neither `Fog` nor `FogExp2` defines. Every world produced the same key,
 *      the warm ran once under the wrong fog, and sports linked the player's
 *      whole kit on its arrival frame: 6,583-7,250 ms, 44-45 programs. Fixed,
 *      950-1,067 ms and 22-23.
 *   2. `scheduleBackgroundBuilds` filtered volatile worlds out, so the maze was
 *      the only world whose programs linked in front of the player.
 *   3. `frame-gaps.mjs` dispatched key events for codes with no row in its `VK`
 *      table. An unknown row still set `event.code`, so a handler reading
 *      `e.code` worked and one reading `e.key` did not - and `ChatBox` closes on
 *      `e.key === 'Escape'`, so a missing row would have opened the chat box,
 *      never closed it, and left every phase after it measuring a game nobody
 *      could type at.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as THREE from 'three';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const read = (rel) => readFile(path.join(root, rel), 'utf8');

/* ------------------------------------------------------------------ */
/* 1. The arrival key must be able to tell the two fogs apart          */
/* ------------------------------------------------------------------ */

test('three gives neither fog class a `type`, which is why the old key could not work', () => {
  const linear = new THREE.Fog(0x000000, 1, 10);
  const exp2 = new THREE.FogExp2(0x000000, 0.01);
  // The whole bug in two lines. If a future three ever adds `type`, this fails
  // and the comment in main.js needs re-reading rather than deleting.
  assert.equal(linear.type, undefined, 'THREE.Fog now has a `type`; re-read arrivalKeyOf');
  assert.equal(exp2.type, undefined, 'THREE.FogExp2 now has a `type`; re-read arrivalKeyOf');
  // And the flags that do exist, which is what the key reads instead.
  assert.equal(linear.isFog, true);
  assert.equal(linear.isFogExp2, undefined);
  assert.equal(exp2.isFogExp2, true);
});

test('arrivalKeyOf distinguishes FogExp2 from Fog, and does not read `fog.type`', async () => {
  const src = await read('src/main.js');
  const start = src.indexOf('function arrivalKeyOf');
  assert.ok(start > 0, 'arrivalKeyOf has gone; the persistent warm has no key');
  const body = src.slice(start, src.indexOf('\n}', start));
  assert.ok(
    /isFogExp2/.test(body),
    'arrivalKeyOf no longer tests isFogExp2 - sports and every linear-fog world share a key again',
  );
  /* Not a blanket ban on the string: the surrounding comment explains the bug
   * and names `fog.type` while doing so. This bans the READ. */
  assert.ok(
    !/^[^*\n]*\bfog\s*\?\s*fog\.type\b/m.test(body),
    'arrivalKeyOf is reading fog.type again, which is undefined on both fog classes',
  );
});

test('the only world with its own exponential fog is still the one the key is for', async () => {
  const src = await read('src/worlds/SportsWorld.js');
  assert.ok(/new THREE\.FogExp2\(/.test(src), 'SportsWorld no longer installs a FogExp2');
});

/* ------------------------------------------------------------------ */
/* 2. Volatile worlds stay in the background chain                     */
/* ------------------------------------------------------------------ */

test('scheduleBackgroundBuilds does not filter volatile worlds out of the chain', async () => {
  const src = await read('src/main.js');
  const start = src.indexOf('function scheduleBackgroundBuilds');
  assert.ok(start > 0, 'scheduleBackgroundBuilds has gone');
  const body = src.slice(start, src.indexOf('\n}', start));
  /* The exact shape that was there, and the shape anyone would write to put it
   * back. A volatile world excluded here is a world whose programs link in
   * front of the player, and the maze is the only one. */
  assert.ok(
    !/!\s*worldManager\.isVolatile\(/.test(body),
    'volatile worlds are excluded from the background chain again - the maze will link its '
    + 'shaders on the frame the player arrives',
  );
  // It must still ORDER them last: a volatile world's build is discarded on
  // entry, so paying for the durable ones first is strictly better for anyone
  // who does not wait for the whole chain.
  assert.ok(
    /isVolatile\(a\)\)\s*-\s*Number\(worldManager\.isVolatile\(b\)\)/.test(body),
    'the chain no longer sorts volatile worlds last',
  );
});

test('MazeWorld is still volatile, and still keeps its materials through a re-roll', async () => {
  const src = await read('src/worlds/MazeWorld.js');
  /* Both halves are load-bearing and they pull in opposite directions. The
   * volatile flag is the game design. The surviving materials are the only
   * reason a background build of a world that gets thrown away buys anything
   * at all - dispose them and the programs go with them. */
  assert.ok(/static volatile = true/.test(src), 'the maze is no longer volatile');
  const start = src.indexOf('  dispose() {');
  assert.ok(start > 0, 'MazeWorld.dispose has gone');
  const body = src.slice(start, src.indexOf('\n  }', start));
  assert.ok(
    !/\bmat(erial)?\??\.dispose\?\?\.\(\)|material\.dispose\(\)/.test(body),
    'MazeWorld.dispose now disposes materials, which releases every program the background '
    + 'warm linked - the warm becomes worthless and entry pays for it again',
  );
});

/* ------------------------------------------------------------------ */
/* 3. The instrument                                                   */
/* ------------------------------------------------------------------ */

/** Every `code` string the harness can dispatch, read out of the source. */
async function dispatchedCodes() {
  const src = await read('scripts/frame-gaps.mjs');
  const codes = new Set();
  for (const m of src.matchAll(/\bpress\(\s*'([A-Za-z0-9]+)'/g)) codes.add(m[1]);
  for (const m of src.matchAll(/\bhold\(\s*\[([^\]]*)\]/g)) {
    for (const c of m[1].matchAll(/'([A-Za-z0-9]+)'/g)) codes.add(c[1]);
  }
  for (const m of src.matchAll(/\b(?:open|close):\s*'([A-Za-z0-9]+)'/g)) codes.add(m[1]);
  return codes;
}

test('every key the harness dispatches has a VK row, with a real `key` as well as a code', async () => {
  const src = await read('scripts/frame-gaps.mjs');
  const table = src.slice(src.indexOf('const VK = {'), src.indexOf('};', src.indexOf('const VK = {')));
  const rows = new Map(
    [...table.matchAll(/(\w+):\s*\[(\d+),\s*'([^']*)'\]/g)].map((m) => [m[1], { vk: Number(m[2]), key: m[3] }]),
  );
  assert.ok(rows.size > 0, 'the VK table could not be parsed');
  for (const code of await dispatchedCodes()) {
    const row = rows.get(code);
    assert.ok(row, `frame-gaps dispatches "${code}" with no VK row - it would send a blank key`);
    assert.ok(row.vk > 0, `VK row for "${code}" has no virtual key code`);
    assert.ok(row.key.length > 0, `VK row for "${code}" has no KeyboardEvent.key`);
  }
  // The one that would have been silent: ChatBox closes on `e.key`, not `e.code`.
  assert.equal(rows.get('Escape')?.key, 'Escape', 'Escape must carry key "Escape" or chat never closes');
});

test('the default event set covers the whole criterion, interactions and movement included', async () => {
  const src = await read('scripts/frame-gaps.mjs');
  const m = src.match(/events:\s*'([^']+)'/);
  assert.ok(m, 'the default --events string has gone');
  const set = new Set(m[1].split(',').map((s) => s.trim()));
  /* Brief 4.1.2 and the acceptance criterion name seven axes between them. A
   * default covering five of seven is a gate reporting a pass for ground it
   * never walked, which is the failure this repository keeps paying for. */
  for (const axis of ['keybind', 'weapon', 'mount', 'interaction', 'movement', 'entry', 'repeat']) {
    assert.ok(set.has(axis), `"${axis}" is not in the default --events set`);
  }
});

test('a movement phase reports the distance covered, and the gate refuses a standing one', async () => {
  const src = await read('scripts/frame-gaps.mjs');
  /* Without this the axis is worse than absent: a player wedged against a wall,
   * dead, or frozen behind a stuck overlay produces a flawless 16.8 ms worst
   * frame over eight seconds and the table would call it a pass. */
  const start = src.indexOf('const measureMovement');
  assert.ok(start > 0, 'measureMovement has gone');
  const body = src.slice(start, src.indexOf('\n    };', start));
  assert.ok(/\bmoved:/.test(body), 'a movement phase no longer reports `moved`');
  assert.ok(/Math\.hypot\(/.test(body), 'movement no longer measures the distance travelled');
  assert.ok(/GATE_MIN_MOVE/.test(src), 'the gate no longer asserts the player actually moved');
});

test('the gate asserts counters and invariants and never the clock', async () => {
  const src = await read('scripts/frame-gaps.mjs');
  const start = src.indexOf('function gateRun');
  assert.ok(start > 0, 'gateRun has gone');
  const body = src.slice(start, src.indexOf('\n}', src.indexOf('return { failures, notes, block }', start)));
  // The invariants that make the rest mean anything.
  for (const needle of ['worlds:all-ready', 'builtBefore', 'timedOut', 'GATE_MIN_MOVE', 'stuck']) {
    assert.ok(body.includes(needle), `the gate no longer checks ${needle}`);
  }
  /* A millisecond assertion here would flake on the first occluded window and
   * be switched off within the week. The clock goes into `notes`, never into
   * `failures`. */
  const failurePushes = [...body.matchAll(/failures\.push\(([\s\S]{0,220}?)\);/g)].map((m) => m[1]);
  for (const f of failurePushes) {
    assert.ok(
      !/\bworst\b|\bbudget\b|\bblockedMs\b/.test(f),
      `the gate has started failing on the clock: ${f.slice(0, 80)}`,
    );
  }
});

test('CI runs the perf gate, and does not run it on every branch push', async () => {
  const yml = await read('.github/workflows/ci.yml');
  assert.ok(/frame-gaps\.mjs/.test(yml), 'CI does not run frame-gaps.mjs at all');
  assert.ok(/--gate/.test(yml), 'CI runs frame-gaps without --gate, so it asserts nothing');
  assert.ok(/FRAME_GAPS_GL:\s*swiftshader/.test(yml), 'the perf job no longer pins the renderer');
  /* It builds the bundle, boots the game, waits out the background world chain
   * and walks every world. That is tens of minutes; on every branch push it is
   * the kind of cost that gets a job deleted rather than fixed. */
  assert.ok(/pull_request'\s*\|\|\s*github\.ref == 'refs\/heads\/main'/.test(yml),
    'the perf job is no longer limited to pull requests and main');
});
