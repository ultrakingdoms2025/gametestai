import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * THE RETENTION LOOP WAS BUILT, TESTED, MERGED AND INVISIBLE.
 *
 * `Retention` ships a daily, a weekly, a streak and a season. It persists,
 * it merges cross-device, and it works signed out. `progress()` returns
 * everything a panel would draw and `retention:changed` carries it on every
 * change.
 *
 * Nothing listened. The loop ran, claimed its tasks and advanced its streak
 * with no way for a player to know any of it existed - which is the same
 * shape as every other defect this session found: a thing that works
 * perfectly and reports nothing.
 *
 * ── Why this lives in the charter panel and not its own ───────────────────
 *
 * The design (`2026-08-23-mission-architecture.md` §6) draws the daily from
 * the player's INCOMPLETE RECORDS, so the task always points at something
 * that advances the objective. The daily therefore IS charter progress,
 * sliced by time. A second panel would compete with the charter board for the
 * same corner of the screen while saying a rephrasing of what it already
 * says.
 *
 * So: two rows under the hint, in the panel that already owns the objective.
 * That also means it inherits `hud-responsive`'s measured layout rather than
 * needing a new placement proved from scratch.
 */

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..', '..');
/* Normalised: this repo checks out with core.autocrlf on, and an anchor with a
 * trailing \n matches nothing against CRLF. Paid for three times already. */
const read = (...p) => readFileSync(join(root, ...p), 'utf8').replace(/\r\n/g, '\n');

test('the HUD listens for retention at all', () => {
  const hud = read('src', 'ui', 'HUD.js');
  assert.match(hud, /_on\('retention:changed'/,
    'nothing in the HUD subscribes to retention:changed, so the daily, the weekly, '
    + 'the streak and the season are all invisible to the player');
});

test('the retention rows are built into the objective panel', () => {
  /* Not a panel of their own: §6 draws the daily from incomplete records, so it
   * is the same objective on a clock. */
  const hud = read('src', 'ui', 'HUD.js');
  const from = hud.indexOf('_buildCharter(col) {');
  assert.ok(from > 0, '_buildCharter has been renamed - this gate is measuring nothing');
  const body = hud.slice(from, hud.indexOf('\n  }\n', from));

  assert.match(body, /cht-today/,
    'the objective panel builds no retention rows');
  assert.ok(!/new .*[Pp]anel|el\('div', 'panel retention/.test(body),
    'retention must not open a second panel competing with the charter board');
});

test('a task renders its world, its label and how many are left', () => {
  /* `Retention._derive` returns { world, label, have, need, target, left, done }.
   * A row that showed only "Daily" would tell a player nothing they could act
   * on - the whole point is that the task names a place and a thing. */
  const hud = read('src', 'ui', 'HUD.js');
  const from = hud.indexOf('_setRetention(');
  assert.ok(from > 0, 'the HUD has no _setRetention');
  const body = hud.slice(from, hud.indexOf('\n  }\n', from));

  for (const field of ['world', 'label', 'left']) {
    assert.ok(new RegExp(`\\b${field}\\b`).test(body),
      `_setRetention never reads task.${field}, so the row cannot say what to do`);
  }
});

test('a finished task reads as finished rather than as zero left', () => {
  /* "0 left" and "done" are different sentences, and the first one reads as a
   * task you have not started. `progress()` carries `dailyDone`/`weeklyDone`
   * precisely so the panel does not have to infer it from a count. */
  const hud = read('src', 'ui', 'HUD.js');
  const from = hud.indexOf('_setRetention(');
  const body = hud.slice(from, hud.indexOf('\n  }\n', from));
  assert.match(body, /dailyDone|weeklyDone|\.done\b/,
    '_setRetention never reads the done flags, so a completed daily draws as "0 left"');
});

test('the panel survives retention being absent', () => {
  /* `Retention` is optional in the same way every progress system is - a build
   * with it unwired, or a payload that never arrives, must leave the objective
   * panel exactly as it was rather than throwing into the frame loop. */
  const hud = read('src', 'ui', 'HUD.js');
  const from = hud.indexOf('_setRetention(');
  const body = hud.slice(from, hud.indexOf('\n  }\n', from));
  assert.match(body, /if \(!\w+\)|\?\?|\?\./,
    '_setRetention has no guard for a missing payload');
});
