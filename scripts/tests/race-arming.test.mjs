import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

/* Textual, like the MountWheel and maze-map gates and for the same reason:
 * `RaceUI` and `RaceManager` touch the DOM and THREE at module scope and
 * cannot be imported under Node, but the property being guarded here is small
 * enough to read off the source honestly. Behaviour was verified in a browser
 * across five worlds; this is what stops it regressing unnoticed. */

test('the race manager re-arms on EVERY world change, including worlds that forbid races', async () => {
  /* `arm` is what CLEARS a loaded track. The handler used to return early when
   * a world forbade races, which left the previous world's circuit armed - so
   * `ready` stayed true walking from the circuit into the maze, and F7's new
   * gate would have leaked straight through it. The two fixes only work
   * together, which is why they are asserted together. */
  const src = await readFile(path.join(root, 'src/race/RaceManager.js'), 'utf8');
  const at = src.indexOf('_onWorldChanged =');
  assert.ok(at > 0, 'no _onWorldChanged in RaceManager');
  const body = src.slice(at, at + 1200);
  const code = body.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
  /* The property is NOT "there is no rules check" - my first draft asserted
   * that and was wrong, because section 5 of the maze spec requires this file
   * to honour `rules.races` and a separate gate enforces it. The property is
   * that the handler ALWAYS reaches `arm`: a world that forbids races arms on
   * nothing, which is what clears the last circuit. An early return is the
   * bug. */
  assert.ok(/this\.arm\(/.test(code), 'the world-change handler no longer arms at all');
  assert.ok(!/return\s*;/.test(code),
    'the handler returns early again - that is exactly what left a stale circuit armed after leaving it');
  assert.ok(/allows\s*\(\s*world/.test(code),
    'the handler no longer consults rules.races - spec section 5 requires this file to honour it');
});

test('the setup footer is re-synced per race type, not written once', async () => {
  /* The footer named the Interceptor and warned about "reversing over the
   * line" during a DRAGON race, because it was built once in the constructor
   * while `_syncPicks` rewrote every other fact around it. The panel already
   * rebuilds the kicker, the difficulty blurbs, the lap count and the field
   * ("N dragons" / "N cars") for exactly this reason.
   *
   * The property is NOT "the dragon string exists" - a build could carry both
   * strings and still show the wrong one. It is that the footer element is
   * ASSIGNED inside `_syncPicks`, which is the difference between text that
   * follows the picker and text that is frozen at construction. Textual, for
   * the reason this file's header already gives: RaceUI touches the DOM at
   * module scope and cannot be imported under Node. */
  const src = await readFile(path.join(root, 'src/ui/RaceUI.js'), 'utf8');

  const at = src.indexOf('_syncPicks() {');
  assert.ok(at > 0, 'no _syncPicks in RaceUI');
  const body = src.slice(at, at + 2600);
  assert.ok(/this\.noteEl[^\n]*textContent\s*=/.test(body),
    'the footer is no longer assigned in _syncPicks - it is frozen at construction again, '
    + 'which is what made a dragon race claim the player was in the Interceptor');

  /* And the constructor must NOT hard-code a machine into it. Guarding the
   * assignment alone would still pass if someone put the car literal back as
   * the initial value, which is visible for the first frame of the panel. */
  const ctorAt = src.indexOf('this.noteEl = el(');
  assert.ok(ctorAt > 0, 'no noteEl construction found');
  const ctor = src.slice(ctorAt, ctorAt + 400);
  assert.ok(!/Interceptor/.test(ctor),
    'the constructor hard-codes a vehicle into the footer again');

  /* Whatever the dragon footer says, it must not name the car. */
  const noteAt = src.indexOf('const RACE_TYPE_NOTE');
  assert.ok(noteAt > 0, 'no RACE_TYPE_NOTE table');
  const table = src.slice(noteAt, src.indexOf('};', noteAt));
  const dragon = table.slice(table.indexOf('dragon:'));
  assert.ok(dragon.length > 20, 'RACE_TYPE_NOTE has no dragon entry');
  assert.ok(!/Interceptor/.test(dragon),
    'the dragon footer names the Interceptor');
});

test('every place that documents F7 says it is circuit-only', async () => {
  /* Three panels list the key for the player. One of them said plain "Race
   * panel", which is now a promise the build does not keep. */
  for (const f of ['src/ui/HUD.js', 'src/ui/HelpMenu.js', 'src/ui/KeybindMenu.js']) {
    const src = await readFile(path.join(root, f), 'utf8');
    const line = src.split('\n').find((l) => l.includes("'F7'"));
    if (!line) continue;
    assert.ok(/circuit/i.test(line), `${f} documents F7 without saying it is circuit-only: ${line.trim()}`);
  }
});
