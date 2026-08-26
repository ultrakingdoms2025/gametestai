import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { shouldPromptRotate, ROTATE_MAX_PORTRAIT_W } from '../../src/ui/OrientationGate.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
/** NORMALISE. See the note in `hud-source-checks.mjs`; this repo checks out CRLF. */
const read = async (p) => (await readFile(path.join(root, p), 'utf8')).replace(/\r\n/g, '\n');

/**
 * The same file with every comment removed.
 *
 * COMMENTS STRIPPED FIRST, and this file paid for it inside an hour: the
 * gate's own docblock explains why `screen.orientation.lock('landscape')` only
 * resolves inside fullscreen, and the scan below found that sentence and
 * reported the explanation of the fix as the defect. Every scrape here reads
 * code. Same note `hud-source-checks.mjs` carries, for the same reason.
 */
const readCode = async (p) => (await read(p))
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/(^|[^:'"`])\/\/.*$/gm, '$1');

/**
 * LANDSCAPE ON A PHONE.
 *
 * ── What is tested where, and why it is split this way ────────────────────
 *
 * The real gate for the rotate card is `scripts/hud-viewport-probe.mjs`. It
 * drives Chrome at 390 x 844 with a coarse pointer emulated, and asserts that
 * the card is up, that it reaches all four edges, that a tap at five points on
 * the screen lands on IT and not on the game behind it, and that CONTINUE IN
 * PORTRAIT is on screen and thumb-sized - then presses that button and grades
 * the layout underneath exactly as it always did. Every one of those facts
 * lives in a rectangle or in a hit test, and only a browser has either.
 *
 * This file is the rest, and it is deliberately short:
 *
 *   1. THE RULE ITSELF, driven directly. `shouldPromptRotate` is exported and
 *      pure precisely so this can call it with real device sizes instead of
 *      scraping a media query out of a stylesheet and agreeing with itself.
 *   2. Four facts that are NOT in a rectangle, each of which would be silent.
 *
 * `src/ui/OrientationGate.js` is importable in Node - it touches no DOM at
 * module scope and imports no stylesheet - which is what makes (1) a real test
 * rather than a source scrape. Do not add a `import './x.css'` to it.
 */

/* ====================================================================== */
/* 1. The rule, driven                                                    */
/* ====================================================================== */

test('the rotate prompt appears on a phone held upright and nowhere else', () => {
  /* Real devices, in both orientations, with the pointer each one actually
   * has. The two that matter most are the last two: a desktop window dragged
   * narrower than a phone, and an iPad stood on its end. Neither may be told
   * to turn, and the reasons are different - one is not a touch device at all,
   * the other has the room. */
  const cases = [
    // [label,                        w,    h,   coarse, prompt]
    ['iPhone 15 portrait',            393, 852,  true,   true],
    ['iPhone 15 landscape',           852, 393,  true,   false],
    ['iPhone SE portrait',            375, 667,  true,   true],
    ['Pixel 8 Pro portrait',          448, 998,  true,   true],
    ['Galaxy Fold, folded, portrait',  344, 882, true,   true],
    ['Galaxy Fold, open, portrait',   673, 841,  true,   true],
    ['iPad mini portrait',            744, 1133, true,   false],
    ['iPad portrait',                 768, 1024, true,   false],
    ['iPad landscape',                1024, 768, true,   false],
    ['a 1280x800 desktop',            1280, 800, false,  false],
    /* THE ONE THAT KEEPS THIS HONEST. A developer with the window dragged to
     * phone width is not on a phone: same rectangle, fine pointer, and being
     * told to rotate a monitor would be absurd. Width alone cannot tell these
     * two rows apart, which is why the rule is keyed on the pointer. */
    ['a desktop window at phone size', 380, 900, false,  false],
    ['a tall thin desktop window',     500, 1200, false, false],
  ];

  for (const [label, width, height, coarse, want] of cases) {
    assert.equal(shouldPromptRotate({ width, height, coarse }), want,
      `${label} (${width}x${height}, ${coarse ? 'coarse' : 'fine'}) should `
      + `${want ? '' : 'NOT '}be asked to rotate`);
  }
});

test('the prompt threshold is the width the panels already stack at', async () => {
  /* 720 is not a number invented for this feature. It is the breakpoint at
   * which the quest board, the bag and the race panel abandon their
   * side-by-side layouts - i.e. the width at which the interface has already
   * admitted it does not fit - and picking the same one is what stops there
   * being two different answers to "how narrow is too narrow".
   *
   * Checked against the stylesheets rather than restated, so moving one and
   * not the other is loud. */
  assert.equal(ROTATE_MAX_PORTRAIT_W, 720);
  for (const sheet of ['src/ui/quest-board.css', 'src/ui/inventory.css']) {
    const css = await read(sheet);
    assert.match(css, /@media\s*\(max-width:\s*720px\)/,
      `${sheet} no longer has a 720px breakpoint, so ROTATE_MAX_PORTRAIT_W is now `
      + 'a number with nothing behind it');
  }
});

test('the boundary is exclusive, and a square screen is landscape', () => {
  /* At exactly 720 the panels are still in their two-column form (the media
   * query is `max-width: 720px`, so it has only just taken effect) — but the
   * point of the rule is "narrower than the width the layout stacks at", and
   * one pixel of ambiguity in a threshold is how a boundary becomes folklore.
   * Stated, so the answer is in the test rather than in someone's head. */
  assert.equal(shouldPromptRotate({ width: 719, height: 1000, coarse: true }), true);
  assert.equal(shouldPromptRotate({ width: 720, height: 1000, coarse: true }), false);

  /* A square viewport is not turned: there is nothing to gain. */
  assert.equal(shouldPromptRotate({ width: 500, height: 500, coarse: true }), false);
  assert.equal(shouldPromptRotate({ width: 500, height: 501, coarse: true }), true);
});

/* ====================================================================== */
/* 2. The facts that are not in a rectangle                               */
/* ====================================================================== */

test('the gate stops the world through the standby path, not a new one', async () => {
  /* THE DEFECT THIS EXISTS FOR, and it has already been paid for twice here.
   *
   * `main.js` derives its `standby` gameplay block from `input:lockchange`,
   * and `Input.exitLock()` is what emits it. A modal that puts a card on the
   * screen without going through that call leaves the world simulating behind
   * it - the player is being shot at while looking at an instruction to turn
   * their phone - and NOTHING FAILS: the card is the right size, in the right
   * place, in front of everything, and the layout probe grades it clean. The
   * same shape closed `InventoryUI` (a phone had no `requestPointerLock`, so
   * six panels left `standby` held with no way back) and the PAUSED card the
   * world ran behind.
   *
   * `ui:modal` is the second half: it is what puts the gate into
   * `HUD._overlays`, which is what stops `showPauseOverlay` drawing the PAUSED
   * card underneath this one.
   *
   * Scraped, because there is no world and no `main.js` here to simulate - the
   * question is which mechanism the file reaches for, and that is a fact about
   * the source. */
  const src = await readCode('src/ui/OrientationGate.js');
  assert.match(src, /this\.input\?\.exitLock\?\.\(\)/,
    'OrientationGate no longer calls Input.exitLock() — whatever it does instead, '
    + 'main.js will not raise the `standby` block and the world will run behind the card');
  assert.match(src, /emit\?\.\('ui:modal',\s*\{\s*id:\s*'rotate',\s*open:\s*true\s*\}\)/,
    'OrientationGate no longer announces itself as a modal — HUD._overlays will not '
    + 'know it is up, and the PAUSED card will be drawn underneath it');
  assert.match(src, /emit\?\.\('ui:modal',\s*\{\s*id:\s*'rotate',\s*open:\s*false\s*\}\)/,
    'OrientationGate never closes its modal — the HUD would hold the overlay for ever '
    + 'and the pause hub would stop working after one rotation');
  assert.match(src, /setTextCapture\?\.\(true\)/,
    'OrientationGate no longer captures text, so a keyboard paired with the phone '
    + 'still walks the player behind the card');
});

test('the orientation lock is only ever asked for from inside fullscreen', async () => {
  /* `screen.orientation.lock()` REJECTS outside fullscreen, on every browser
   * that implements it. A version that called it on load, or on the rotate
   * card's own timer, would therefore do nothing at all - and would do nothing
   * SILENTLY, because the rejection is swallowed exactly as it should be for
   * the normal case. There is no rectangle, no screenshot and no headless
   * browser that can tell that version from this one.
   *
   * So what is pinned is the wiring: the attempt hangs off `fullscreenchange`
   * (which is fired by every path into fullscreen - `Input.requestLock`, the
   * pause hub's Fullscreen row, F11 - so none is missed), and the call is
   * guarded on `document.fullscreenElement`. */
  const src = await readCode('src/ui/OrientationGate.js');
  assert.match(src, /addEventListener\('fullscreenchange'/,
    'the orientation lock is no longer hooked to fullscreenchange — outside fullscreen '
    + 'every lock request is rejected, so it would be attempting nothing');
  assert.match(src, /document\.fullscreenElement[\s\S]{0,400}?\.lock\('landscape'\)/,
    "the lock('landscape') call is no longer guarded on document.fullscreenElement");

  /* And every rejection is swallowed. A refused lock is the NORMAL case - it
   * is what a desktop, an iPad and every iOS browser return - so an unhandled
   * one would put a permanent "Uncaught (in promise)" in the console of every
   * session, in front of every real error anyone is trying to read. The same
   * reasoning `Input.requestLock` gives for its own `.catch(() => {})`. */
  const attempts = [...src.matchAll(/\.lock\('landscape'\)/g)];
  assert.ok(attempts.length > 0, 'nothing in OrientationGate asks for a landscape lock');
  for (const m of attempts) {
    assert.match(src.slice(Math.max(0, m.index - 240), m.index), /try \{/,
      'a lock() call sits outside a try. Older engines throw synchronously rather than '
      + 'returning a promise, and that throw would take the fullscreen handler with it');
  }
  assert.doesNotMatch(src, /console\.(log|warn|error|info)\b/,
    'OrientationGate logs. A refused lock is what a desktop, an iPad and every iOS '
    + 'browser return, so logging it would put a permanent error in the console of '
    + 'every session, in front of the real ones');

  /* THE HACK THAT IS NOT HERE. Checked in `hud-source-checks.mjs` for the
   * stylesheets; checked here for the module, because a JS-applied
   * `style.transform` would go round the CSS scan entirely and has exactly the
   * same consequence - the pixels turn and the touch coordinates do not. */
  assert.doesNotMatch(src, /style\.transform\s*=/,
    'OrientationGate writes an inline transform. Rotating the frame in JS is the same '
    + 'trap as rotating it in CSS: the pixels turn and the input frame does not');
});

test('the layout probe checks both directions, at every viewport', async () => {
  /* A gate that asserts only "the card is up on a phone" is half a gate. The
   * failure it cannot see is the one that would be worst: a rule that decided
   * on width alone would put a rotate prompt over a 768 px iPad in portrait
   * and over anything else narrow, and every other assertion in the probe
   * would still pass - a covered layout is a laid-out layout, and the probe
   * would happily measure the card's two buttons and report the case clean.
   *
   * So the expectation is declared for all six viewports and the negative arm
   * is asserted. This pins that, and pins that the expectation is WRITTEN
   * DOWN: importing `shouldPromptRotate` into the probe would make it agree
   * with the implementation by construction and no rule change could ever
   * fail. */
  const probe = await read('scripts/hud-viewport-probe.mjs');
  const list = probe.slice(probe.indexOf('const VIEWPORTS = ['),
    probe.indexOf('];', probe.indexOf('const VIEWPORTS = [')));

  const flags = [...list.matchAll(/id: '([\w-]+)'[^}]*rotateGate: (true|false)/g)];
  assert.equal(flags.length, 6,
    `only ${flags.length} of the probe's viewports declare rotateGate — the ones that `
    + 'do not are never checked in either direction');
  const expects = Object.fromEntries(flags.map((m) => [m[1], m[2] === 'true']));
  assert.deepEqual(expects, {
    'phone-portrait': true,
    'phone-landscape': false,
    'tablet-portrait': false,
    'tablet-landscape': false,
    desktop: false,
    'desktop-wide': false,
  }, 'the probe now expects the rotate card at a different set of viewports');

  assert.doesNotMatch(probe, /from '\.\.\/src\/ui\/OrientationGate\.js'/,
    'the probe imports the gate\'s own rule. It would then agree with the '
    + 'implementation by construction and a changed rule could never fail it');

  /* Both arms present. */
  assert.match(probe, /assertGate\(/,
    'the probe no longer asserts the card is up where it should be');
  assert.match(probe, /!vp\.rotateGate && m\.gate\?\.shown/,
    'the probe no longer asserts the card is ABSENT where it must never appear');
  /* And the panels behind it are still graded, through the escape hatch. */
  assert.match(probe, /window\.__harness\.dismissRotateGate\(\)/,
    'the probe no longer dismisses the card, so the narrow-width layouts in '
    + 'quest-board.css, inventory.css and race.css are measured at no viewport at all');
});

test('the rotate card is built by the real HUD, and sits above the boot screen', async () => {
  /* Built by the HUD, so the layout probe measures the shipped object rather
   * than one the harness assembled. Same pin `hud-responsive.test.mjs` puts on
   * the harness's other imports, and for the same reason. */
  const hudJs = await read('src/ui/HUD.js');
  assert.match(hudJs, /import \{ OrientationGate \} from '\.\/OrientationGate\.js'/,
    'HUD.js no longer builds the rotate gate — nothing constructs it and the layout '
    + 'probe would be measuring a game that does not have it');
  assert.match(hudJs, /new OrientationGate\(\{/, 'HUD.js imports the gate but never builds it');

  /* ABOVE THE BOOT SCREEN, and this is the one stacking fact the probe cannot
   * check: its harness has no boot screen to be underneath. A card at a lower
   * z-index still measures as covering the whole viewport - `getBoundingClient
   * Rect` knows nothing about what is painted over it - so a phone held
   * upright would be looking at the rotate card's scrim with CLICK TO ENTER
   * live on top of it, and would enter the world in portrait. */
  const css = await read('src/ui/hud.css');
  const zOf = (sel) => {
    const m = css.match(new RegExp(`\\${sel}\\s*\\{[^}]*z-index:\\s*(\\d+)`));
    assert.ok(m, `${sel} has no z-index in hud.css`);
    return Number(m[1]);
  };
  assert.ok(zOf('.rotate') > zOf('.boot-screen'),
    `.rotate is z-index ${zOf('.rotate')} and .boot-screen is ${zOf('.boot-screen')} — `
    + 'a phone in portrait could press CLICK TO ENTER straight through the card');
});
