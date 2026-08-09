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

test('F7 only answers where a circuit actually exists', async () => {
  /* The panel is world-specific - its own comment says so - but the handler
   * was global, so F7 opened a race panel in the hedge maze, the citadel and
   * the station alike. */
  const src = await readFile(path.join(root, 'src/ui/RaceUI.js'), 'utf8');
  const at = src.indexOf("e.code === 'F7'");
  assert.ok(at > 0, 'no F7 handler found in RaceUI');
  const body = src.slice(at, at + 900);
  assert.ok(/this\.race\?\.\s*ready/.test(body),
    'the F7 handler does not consult race.ready - it will open the race panel in every world');
});

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
  assert.ok(/this\.arm\(world\)/.test(code), 'the world-change handler no longer arms');
  assert.ok(!/allows\s*\(\s*world/.test(code),
    'the handler skips worlds that forbid races again - that is what left a stale circuit armed');
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
