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
 *
 * And it runs here, under `npm test`, because that is what CI runs on every
 * push. The probe needs a browser and a dev server and is invoked by hand or
 * by `npm run test:layout`.
 */

test('the four facts a rectangle cannot carry', async () => {
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
