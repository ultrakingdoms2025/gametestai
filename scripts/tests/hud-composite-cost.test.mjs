import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const read = (rel) => readFile(path.join(root, rel), 'utf8').then((s) => s.replace(/\r\n/g, '\n'));

/**
 * The GPU cost of the interface, and the record of one attempt to move it.
 *
 * ── The stall is real ──────────────────────────────────────────────────────
 * A composited CSS effect painting for the first time - a `backdrop-filter`, a
 * `mix-blend-mode`, a `filter` - makes Skia ask ANGLE for a raster program, and
 * this driver links one in 0.3-0.9 s on the GPU main thread with the display
 * compositor stopped behind it. Those frames profile as ~98% `(idle)`: the page
 * is doing nothing, the frame simply never arrives. Measured, that class was
 * 55-65% of all post-gate blocking, with single frames of 3542, 1894 and
 * 1464 ms. Injecting a stylesheet that ablates every composited effect before
 * first paint cut the frame-source stall class by 78% and left the JS stall
 * class untouched, which is what identifies the class rather than merely
 * correlating with it.
 *
 * `hud.css` gates the whole interface behind `.hud { opacity: 0 }` until
 * `game:started`, and Chrome does not raster a fully transparent layer, so all
 * of that lands in the handful of frames after `engine.start()` - at the exact
 * moment the player is handed the controls.
 *
 * ── The obvious fix does not work. Do not rebuild it ───────────────────────
 * `src/ui/HudRehearsal.js` was that fix: force the whole of `#ui-root` to
 * `opacity: 1` during `prewarm()`, while the loading card is still on top of
 * it, hold until the frames go quiet, then restore exactly. It was careful -
 * opacity 1 exactly, because an ancestor below 1 is a backdrop root and a
 * `backdrop-filter` over an empty backdrop is free; the loading card dropped to
 * `opacity: 0.999`, because an opaque occluder lets cc drop the tiles
 * underneath before they are ever rastered. Screenshotting mid-rehearsal
 * confirmed not one pixel of it reached the screen, and the hold reliably
 * absorbed 260-490 ms of frame-source gap, so it really was rastering.
 *
 * It still did not help. Ten paired cold boots, interleaved, five per arm, each
 * measured over the six seconds after its own gate:
 *
 *     frame-source stall   without  1727 ms mean (2078 2162 972 1928 1496)
 *                          with     1588 ms mean ( 872  481 1528 2336 2721)
 *     lower arm            the fix, in 13 of 25 run pairs - a coin toss
 *
 * The spread inside each arm is far wider than the gap between them. Over the
 * wider 45 s window the fix arm is nominally worse. It cost 370-840 ms of
 * `prewarm()`, 536 forced inline styles and 11 injected nodes, and was removed.
 *
 * The probable reason, and the thing to disprove before trying this again: a
 * `backdrop-filter` is resolved by the display compositor when a surface is
 * DRAWN, not by a raster worker when a layer is PAINTED, and an occluded
 * surface is not drawn. The one trick that makes the rehearsal invisible -
 * hiding it under the loading card - is the same trick that stops it reaching
 * the effect it is trying to warm. Anything that warms a `backdrop-filter` has
 * to get it actually drawn, which is the hard part.
 *
 * ── Where the remaining gap goes ───────────────────────────────────────────
 * Two pieces, and neither is the HUD:
 *
 *   - The pause overlay, `.pause`, a full-screen `backdrop-filter`. The profiler
 *     harness never obtains a pointer lock, so the game drops to standby and
 *     paints it 0.6-1.8 s after the gate - which is exactly the band the big
 *     gaps sit in. `ABLATE=nopause` removes that band entirely. A player who
 *     clicks to enter gets the lock and never sees it at boot; they pay it the
 *     first time they press Esc instead.
 *   - Roughly 330-450 ms in the frame at the gate itself, which survives
 *     ablating every composited effect on the page. That is the gate frame, not
 *     a CSS cost, and nothing in this file will move it.
 *
 * ── What did measure, and is what these tests hold ─────────────────────────
 * Two edits, both permanent rather than first-use, and both cheap:
 *
 *   - `.minimap canvas` no longer carries `filter: drop-shadow(...)`. Minimap.js
 *     redraws that canvas every frame and a CSS filter is re-evaluated whenever
 *     its source changes, so that was a GPU blur pass per frame for the whole
 *     session. Steady-state median frame time 30-80 s after the gate went from
 *     17.2-20.1 ms to 15.5-18.2 ms, the better arm in 20.5 of 25 pairs - about
 *     0.8 ms a frame, for ever.
 *   - One `drop-shadow` radius across the file. The radius is baked into the
 *     shader; the colour is a uniform and costs nothing to vary.
 *
 * The harness that produced all of the above is `prof-boot.mjs` (fresh-profile
 * headed Chrome, V8 sampling profiler, rAF gap recorder, driver-injected CSS
 * ablations) with `prof-classify.mjs` to split each stall frame into "the main
 * thread was busy" and "the frame never came".
 */

test('the minimap does not run a GPU filter over a canvas redrawn every frame', async () => {
  /* The one measured win on this branch, and the easiest to lose: a filter here
   * looks harmless and costs a blur pass on the compositor every single frame. */
  const css = await read('src/ui/hud.css');
  const block = /\n\.minimap canvas \{([^}]*)\}/.exec(css)?.[1];
  assert.ok(block, '.minimap canvas is no longer styled; check the shadow did not come back');
  assert.doesNotMatch(block, /filter:/,
    'the minimap canvas has a filter again - it costs a GPU blur pass every frame, for ever');
  assert.match(css, /\n\.minimap::before \{/,
    'the static shadow behind the map is gone, so the map now floats with no shadow at all');
});

test('the glow radius is one value across the HUD', async () => {
  /* `drop-shadow` bakes its radius into the shader, so a second radius is a
   * second ANGLE link for a difference nobody can see at these sizes. */
  // Comments in this file quote the radii they removed, so read the rules only.
  const css = (await read('src/ui/hud.css')).replace(/\/\*[\s\S]*?\*\//g, '');
  const radii = new Set();
  // Offsets are commonly written unitless (`0 0 6px`); the radius never is.
  for (const m of css.matchAll(/drop-shadow\(\s*-?[\d.]+(?:px)?\s+-?[\d.]+(?:px)?\s+([\d.]+px)/g)) radii.add(m[1]);
  assert.ok(radii.size > 0, 'no drop-shadow radii found - the shape in hud.css changed');
  const spent = [...radii].filter((r) => r !== '6px');
  assert.deepEqual(spent, ['22px'],
    `drop-shadow radii in hud.css are ${[...radii].join(', ')}; each one past 6px is an ANGLE `
    + 'link of its own, and only the full-charge halo is meant to be spent that way');
});

test('the boot path speaks two glass values and no more', async () => {
  /* Every distinct blur/saturate pair is its own raster program. These two cover
   * the loading card, the whole HUD, and the three menus that dim the world; the
   * stragglers that remain are all in menus reached minutes in. A third value
   * here is a visible hitch the first time it paints. */
  const onPath = ['hud', 'inventory', 'quest-board', 'bug-report'];
  const values = new Set();
  for (const name of onPath) {
    const css = (await read(`src/ui/${name}.css`)).replace(/\/\*[\s\S]*?\*\//g, '');
    for (const m of css.matchAll(/(?<!-)backdrop-filter:\s*([^;]+);/g)) values.add(m[1].trim());
  }
  assert.ok(values.size > 0, 'no backdrop-filter declarations found on the boot path');
  assert.deepEqual([...values].sort(), ['var(--glass-dim)', 'var(--glass-fx)'],
    `the boot path now asks for ${[...values].join(' / ')}; each literal past the two tokens is a `
    + 'raster program of its own linking in front of the player');

  const tokens = await read('src/ui/hud.css');
  const fx = /--glass-fx:\s*blur\(([\d.]+)px\)/.exec(tokens)?.[1];
  const dim = /--glass-dim:\s*blur\(([\d.]+)px\)/.exec(tokens)?.[1];
  assert.ok(fx && dim, 'the glass tokens are no longer a plain blur radius');
  assert.equal(fx, dim,
    'the two glass tokens no longer share a blur radius, so they no longer share a kernel - '
    + 'they are meant to differ only in their colour matrix');
});

test('nothing on a contended frame animates a blur', async () => {
  /* Only the blur family matters here. `blur` and `drop-shadow` bake their
   * radius into the shader, so animating one walks Skia through a kernel per
   * step and the first play buys an ANGLE link for each one it meets;
   * `brightness` and friends are a colour matrix with the amount as a uniform,
   * which is why `start-pulse`, `wslot-pop` and `credits-spin` are left alone.
   *
   * Five sweeps were removed, all of them landing on frames that compete: the
   * loading card's exit (which plays as `game:started` fires - the single worst
   * frame in the boot), the toast in and out, the chat message entrance, the
   * ammo swap and the map zoom.
   *
   * `boot-card` is the one that stays, and deliberately. It is the card's own
   * entrance, played once at the very start of the loading screen with nothing
   * else on the page to compete with - the opposite end of the boot from the
   * frames this is about. It was not measured either way; it is simply not on
   * the contended path. */
  const KNOWN = ['boot-card'];
  const css = (await read('src/ui/hud.css')).replace(/\/\*[\s\S]*?\*\//g, '');
  const offenders = [];
  for (const m of css.matchAll(/@keyframes\s+([\w-]+)\s*\{((?:[^{}]|\{[^{}]*\})*)\}/g)) {
    for (const d of m[2].matchAll(/(?<!-)filter:\s*([^;]+);/g)) {
      if (/\b(?:blur|drop-shadow)\(/.test(d[1]) && !offenders.includes(m[1])) offenders.push(m[1]);
    }
  }
  assert.deepEqual(offenders, KNOWN,
    `@keyframes ${offenders.join(', ')} sweep a blur radius; each distinct kernel the sweep `
    + 'passes through is an ANGLE link the first time the animation plays, and opacity and '
    + 'transform are compositor-only and read the same');
});

test('the record of the rehearsal that did not work is still here', async () => {
  /* The diagnosis is convincing enough that the next person to profile a cold
   * boot will land on exactly this idea. The whole value of the failed attempt
   * is that it is written down; a tidy-up that drops it costs someone a day. */
  const self = await read('scripts/tests/hud-composite-cost.test.mjs');
  for (const [what, needle] of [
    ['the attempt itself', /HudRehearsal\.js/],
    ['the measurement that rejected it', /13 of 25/],
    ['why it cannot work', /DRAWN[\s\S]{0,200}not drawn/],
    ['where the rest of the gap goes', /pause overlay/],
  ]) {
    assert.match(self, needle, `the header no longer records ${what}`);
  }
  const main = await read('src/main.js');
  assert.doesNotMatch(main, /rehearseHud/, 'the rehearsal is wired back into main.js');
  assert.match(main, /hud-composite-cost/,
    'prewarm() no longer points at this file, so the next person to wonder why the HUD is not '
    + 'warmed with everything else has nothing to follow');
});
