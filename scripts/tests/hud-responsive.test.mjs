import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { hudSourceChecks } from '../hud-source-checks.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
/** NORMALISE. See the note in `hud-source-checks.mjs`; this repo checks out CRLF. */
const read = async (p) => (await readFile(path.join(root, p), 'utf8')).replace(/\r\n/g, '\n');

/**
 * THE RESPONSIVE HUD — the half of it a browser cannot answer.
 *
 * ── Read this before adding anything to this file ─────────────────────────
 *
 * The real gate for this work is `scripts/hud-viewport-probe.mjs`. It drives
 * Chrome over the DevTools Protocol against a Vite dev server on a fresh port,
 * builds the REAL `HUD` with the REAL stylesheets at six viewport sizes in
 * five states, and measures thirty layouts' worth of `getBoundingClientRect()`
 * for clipping, overlap, 44 px touch targets and the safe area. That is where
 * "the weapon strip is 731 px on a 390 px screen" is caught, because that fact
 * lives in a rectangle and nowhere else.
 *
 * **A CSS test that asserts a rule exists proves nothing about layout.** This
 * repository has paid for that shape of gate nine separate times on World 06
 * alone, and the roadmap's own discipline note says a gate that measures the
 * wrong thing is worse than no gate. So this file does NOT check that
 * `.vitals` has a width, or that a breakpoint exists, or that some token is
 * declared for its own sake.
 *
 * What it checks is the short list of things that ARE NOT VISIBLE IN A
 * RECTANGLE, and would therefore be silently un-graded by the probe:
 *
 *   - `dvh` vs `vh`: a headless browser has no URL bar, so the two measure
 *     identically in it and no rectangle can tell them apart. On a phone they
 *     differ by the height of the browser chrome.
 *   - the shipped viewport meta: without `viewport-fit=cover` every
 *     `env(safe-area-inset-*)` resolves to 0, and the whole safe-area layer
 *     becomes dead code that reads as finished.
 *   - whether both stylesheets read the same four safe-area tokens: the probe
 *     drives those tokens, so a layer that goes around them is graded without
 *     being tested.
 *   - whether `Minimap.js` writes `canvas.style.width` again: an inline style
 *     beats every stylesheet, which is why a 390 px phone used to get the
 *     desktop's 220 px map.
 *   - whether anybody has "forced landscape" with a `transform: rotate(90deg)`
 *     on the frame. That is the one entry here a browser makes MORE invisible
 *     rather than less: the pixels turn, the input frame does not, and the
 *     result measures and photographs perfectly while being unplayable with a
 *     thumb. `src/ui/OrientationGate.js` is the honest version, and
 *     `scripts/tests/orientation-gate.test.mjs` is the rest of its contract.
 *
 * And it runs here, under `npm test`, because that is what CI runs on every
 * push. The probe needs a browser and a dev server and is invoked by hand or
 * by `npm run test:layout`.
 */

test('the five facts a rectangle cannot carry', async () => {
  const fails = await hudSourceChecks();
  assert.deepEqual(fails, [], `\n  - ${fails.join('\n  - ')}\n`);
});

/* ====================================================================== */
/* The probe itself must stay pointed at the game                         */
/* ====================================================================== */

test('the layout probe measures the game, not a copy of it', async () => {
  /* THE FAILURE THIS EXISTS TO CATCH.
   *
   * The probe's whole claim is that it lays out the REAL HUD with the REAL
   * stylesheets. The day somebody replaces the harness's `import { HUD } from
   * '../../src/ui/HUD.js'` with a hand-built fixture - because the real one
   * grew a dependency, or because a stub was quicker - the probe carries on
   * printing thirty green cases about a page the game does not have.
   *
   * That is this repository's signature defect, and the reason the roadmap
   * says a gate that reports confidence about the wrong thing is worse than
   * no gate. So the harness's sources are pinned. */
  const harness = await read('scripts/harness/hud-viewport.js');
  for (const mod of ['src/ui/HUD.js', 'src/ui/TouchControls.js', 'src/ui/HelpMenu.js']) {
    const spec = `../../${mod}`;
    assert.ok(harness.includes(`from '${spec}'`),
      `the layout harness no longer imports ${mod} — it is measuring something else`);
  }

  const html = await read('scripts/harness/hud-viewport.html');
  for (const sheet of ['hud.css', 'pause-menu.css']) {
    assert.ok(html.includes(`../../src/ui/${sheet}`),
      `the layout harness no longer loads ${sheet} — it is measuring something else`);
  }
  /* `touch.css` arrives through `TouchControls.js`'s own `import './touch.css'`,
   * which is how the game loads it too. */
  const touch = await read('src/ui/TouchControls.js');
  assert.match(touch, /import '\.\/touch\.css'/,
    'TouchControls no longer imports touch.css, so the harness never loads the touch layer');

  /* The harness must not declare a viewport meta of its own: it lifts the
   * shipped one out of `index.html`, and an authored one would make the
   * probe's assertion about `viewport-fit=cover` a statement about the
   * harness. */
  assert.ok(!/<meta\s+name=["']viewport["']/.test(html),
    'the layout harness declares its own viewport meta — it is now grading itself');
  assert.match(harness, /fetch\('\.\.\/\.\.\/index\.html'\)/,
    'the layout harness no longer reads the shipped viewport meta out of index.html');
});

/* ====================================================================== */
/* And it must keep measuring the PANELS                                  */
/* ====================================================================== */

/** Every panel the probe is expected to lay out, and the sheet it brings in. */
const PANELS = [
  ['src/ui/QuestBoard.js', 'src/ui/quest-board.css'],
  ['src/ui/InventoryUI.js', 'src/ui/inventory.css'],
  ['src/ui/MarketplaceUI.js', 'src/ui/inventory.css'],
  ['src/ui/CharacterMenu.js', 'src/ui/character.css'],
  ['src/ui/MountMenu.js', 'src/ui/mount-menu.css'],
  ['src/ui/ShipMenu.js', 'src/ui/ship-menu.css'],
  ['src/ui/KeybindMenu.js', 'src/ui/keybind.css'],
  ['src/ui/MazeMap.js', 'src/ui/maze-map.css'],
  ['src/ui/MountWheel.js', 'src/ui/mountwheel.css'],
  ['src/ui/BugReport.js', 'src/ui/bug-report.css'],
];

test('the layout probe still builds every panel, and one scene per panel', async () => {
  /* THE FAILURE THIS EXISTS TO CATCH, AND IT IS NOT HYPOTHETICAL.
   *
   * The harness used to build `HUD`, `HelpMenu` and `TouchControls` and stop.
   * Ten panels were therefore laid out at NO viewport by anything, and one of
   * them - the quest board, which the touch tray has a button for - shipped
   * with a fixed `280px 1fr` grid inside `overflow: hidden` and not one media
   * query in its stylesheet. On a 390 px phone its detail pane was 39 px of
   * clipped, unscrollable text with the ACCEPT button underneath it.
   *
   * The probe reads its case list out of the harness, so deleting a scene
   * here is silent: the run gets shorter and still prints "HUD layout OK".
   * This is what makes it loud. */
  const harness = await read('scripts/harness/hud-viewport.js');
  const scenes = harness.slice(harness.indexOf('const SCENES = {'), harness.indexOf('function clearScene'));
  assert.ok(scenes.length > 0, 'the harness no longer has a SCENES map at all');

  for (const [mod] of PANELS) {
    assert.ok(harness.includes(`from '../../${mod}'`),
      `the layout harness no longer imports ${mod} — that panel is measured at no viewport`);
  }

  /* One scene per panel, named, and each of them proving the panel opened. */
  for (const name of ['quests', 'inventory', 'market', 'character', 'mount',
    'ship', 'keybinds', 'map', 'wheel', 'bug']) {
    assert.ok(new RegExp(`\\n  ${name}\\(\\) \\{`).test(scenes),
      `the layout harness has no \`${name}\` scene — that panel is built and never shown`);
  }

  /* A scene that opens nothing would be measured as an empty screen and
   * reported clean, which is worse than not measuring it at all. */
  const shows = (scenes.match(/\bshown\(/g) ?? []).length;
  assert.ok(shows >= 10,
    `only ${shows} scenes assert the panel they name actually opened; a scene that `
    + 'silently opens nothing measures a blank viewport and passes');

  /* And the list has to be published, or the probe falls back to the five HUD
   * states it used to hardcode. */
  assert.match(harness, /scenes:\s*Object\.keys\(SCENES\)/,
    'the harness no longer publishes its scene list — the probe cannot read it');
});

test('the source-level sheet list covers every panel the probe lays out', async () => {
  /* The two checks in `hud-source-checks.mjs` that walk `SHEETS` are both
   * about a phone: `vh` against a moving URL bar, and one answer to "where is
   * the notch". A panel that the probe now positions at 390 px but whose
   * stylesheet is not on that list gets the rectangle half of its contract
   * graded and not the other half - which is how eleven sheets came to be
   * measuring heights in `vh`. */
  const src = await read('scripts/hud-source-checks.mjs');
  const list = src.slice(src.indexOf('const SHEETS = ['), src.indexOf('];', src.indexOf('const SHEETS = [')));
  const missing = [...new Set(PANELS.map(([, sheet]) => sheet))]
    .filter((sheet) => !list.includes(`'${sheet}'`));
  assert.deepEqual(missing, [],
    `the layout probe positions these panels but hud-source-checks.mjs does not read their `
    + `stylesheets: ${missing.join(', ')}`);

  /* Each panel really does bring that sheet in itself - which is how the
   * harness loads them, and the reason the list above is not a guess. */
  for (const [mod, sheet] of PANELS) {
    const js = await read(mod);
    const name = sheet.split('/').pop();
    assert.ok(js.includes(`import './${name}'`),
      `${mod} no longer imports ${name} — the harness would lay it out unstyled`);
  }
});
