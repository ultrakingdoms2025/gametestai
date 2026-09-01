import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

/**
 * A PANEL A PHONE CANNOT CLOSE IS A PAGE RELOAD.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 *  THE TRAP, AND WHY IT IS WORSE THAN "THE CLOSE BUTTON IS MISSING"
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Every cursor-owning panel in `src/ui` calls `input.exitLock()` when it opens.
 * It has to: while the game holds pointer lock there is no cursor and no hit
 * testing at all, so nothing in the panel can be clicked. `MazeMap` records the
 * bug report that found this out.
 *
 * But `TouchControls.shown` is `touchMode && _started && input.locked`, and the
 * `≡` pause button lives inside that tray. So on a phone, opening any of these
 * panels does not merely fail to provide a way out - it TAKES AWAY the one that
 * was already on screen. The player is left with a full-screen panel, no
 * keyboard, no tray, and no pause button.
 *
 * Two panels then closed only on Escape, which a phone does not have:
 *
 *   - `KeybindMenu` drew its close affordance as `el('div', 'kb-close')` with
 *     the words "Esc / to close" inside it and NO LISTENER AT ALL. It looked
 *     exactly like a control. On a desktop that is only untidy; on a phone it
 *     is a dead end that looks like a working button.
 *   - `MazeMap` ended its header hint with the word ESC and had nothing else -
 *     in the one world where the map is the difference between finishing and
 *     giving up, and where the only way out was reloading and losing the run.
 *
 * `QuestBoard` has had this right the whole time: a `<button class="qb-close">`
 * with a click handler. The fix is that shape, twice.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 *  WHY THE GATE IS THE RULE AND NOT THE TWO INSTANCES
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Both defects are the same mistake made by different people at different
 * times, and neither was catchable by reading either file - the div LOOKED like
 * a button, and "ESC" in a hint line reads as documentation of a control rather
 * than as its only existence. So this derives the list rather than holding one:
 * any file in `src/ui` that releases the pointer lock is a panel that owns the
 * screen, and every one of them must have a click that leads to a close. A
 * panel added next year fails here on the commit that adds it.
 *
 * ── Why this is textual ───────────────────────────────────────────────────
 *
 * These classes cannot be constructed under Node: they `import './x.css'`,
 * which only a bundler resolves, and their builders need a real DOM
 * (`innerHTML`, `querySelector`, `classList`, capturing `window` listeners). A
 * source guard in the style of the F-key sweep in `pause-menu.test.mjs` is what
 * is available, and what it pins - "is there a click that closes this" - is
 * exactly the thing that was missing.
 */

const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/.*$/gm, ' ');

/**
 * Files in `src/ui` that take the cursor but are not panels.
 *
 * Deliberately tiny and each with a reason, because an exemption list is how a
 * gate quietly becomes optional:
 *
 *  - `HUD.js` is the surface the panels sit on. Its `exitLock` is the pause
 *    hub's own path, and the hub is closed with Escape, the `≡` tray button,
 *    and by picking any row - it is the thing the tray still shows.
 *  - `TouchActions.js` is the dispatcher the tray's own STAND DOWN button
 *    calls. It has no UI of its own to close.
 */
const NOT_PANELS = new Set(['HUD.js', 'TouchActions.js']);

async function uiFiles() {
  const out = [];
  for (const e of await readdir(path.join(root, 'src/ui'), { withFileTypes: true })) {
    if (e.isFile() && e.name.endsWith('.js')) out.push(e.name);
  }
  return out;
}

test('every panel that takes the cursor can be closed by a click', async () => {
  const checked = [];
  for (const name of await uiFiles()) {
    if (NOT_PANELS.has(name)) continue;
    const src = strip(await readFile(path.join(root, 'src/ui', name), 'utf8'));
    if (!/exitLock/.test(src)) continue;
    checked.push(name);

    /* A click listener whose body reaches a close. `closePanel` and `_closeStop`
     * are RaceUI's spellings of the same verb, so the pattern is the verb and
     * not one method name. */
    const closers = src.match(/addEventListener\(\s*'click'[\s\S]{0,220}?\b(?:this\.)?_?close\w*\(/g) ?? [];
    assert.ok(closers.length > 0,
      `${name} releases the pointer lock but has no click that closes it. On a phone that `
      + 'is a dead end: exitLock also hides the whole touch tray, the ≡ pause button '
      + 'included, so the only way out is reloading the page.');
  }

  // The scrape must be finding the panels at all - a broken sweep would pass
  // this test for every possible source tree.
  assert.ok(checked.length >= 10,
    `only ${checked.length} cursor-owning panels found (${checked.join(', ')}) - the sweep has broken`);
  for (const must of ['KeybindMenu.js', 'MazeMap.js', 'QuestBoard.js']) {
    assert.ok(checked.includes(must), `${must} is no longer seen as a cursor-owning panel`);
  }
});

test('the keybind panel closes with a real button, not a div that looks like one', async () => {
  /* The instance, pinned beside the rule. The element was `el('div',
   * 'kb-close')` containing the words "Esc / to close" - a caption with the
   * shape of a control and no listener on it. */
  const src = strip(await readFile(path.join(root, 'src/ui/KeybindMenu.js'), 'utf8'));
  assert.ok(!/el\(\s*'div'\s*,\s*'kb-close'/.test(src),
    'the close affordance is a div again - it draws like a button and does nothing');
  assert.ok(/el\(\s*'button'\s*,\s*'kb-close'/.test(src),
    'the close affordance is not a <button>');
  assert.ok(/close\.addEventListener\(\s*'click'/.test(src),
    'the close button has no click handler');
});

test('the maze map has a close control of its own, not the word ESC in a hint', async () => {
  const src = strip(await readFile(path.join(root, 'src/ui/MazeMap.js'), 'utf8'));
  assert.ok(/class="[^"]*mz-map-close[^"]*"/.test(src),
    'the maze map header has no close button - and the maze is the one world where '
    + 'losing the map loses the run');
  assert.ok(/\[data-close\]'?\s*\)\s*\.addEventListener\(\s*'click'/.test(src),
    'the maze map close button has no click handler');
});

test('a close control is reachable by a thumb on a coarse pointer', async () => {
  /* 44 px is the floor `hud.css` sets for every other control, and it is the
   * whole point here: these two buttons exist because a phone cannot press
   * Escape, so a phone that cannot press THEM either has gained nothing. */
  for (const [css, sel] of [['src/ui/keybind.css', 'kb-close'], ['src/ui/maze-map.css', 'mz-map-tab']]) {
    const text = await readFile(path.join(root, css), 'utf8');
    const at = text.indexOf('@media (pointer: coarse)');
    assert.ok(at > 0, `${css} has no coarse-pointer block`);
    const block = text.slice(at);
    assert.ok(block.includes(sel) && /min-height/.test(block),
      `${css} does not give .${sel} a 44 px minimum on a coarse pointer`);
  }
});
