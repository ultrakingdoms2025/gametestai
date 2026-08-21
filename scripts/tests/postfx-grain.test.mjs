import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * THE FILM GRAIN THAT TURNED INTO A NEGATIVE DC OFFSET AND DARKENED THE WHOLE
 * GAME AFTER 165 SECONDS.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 *  WHAT WENT WRONG
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `PostFX.js`'s film pass builds triangular-PDF grain from two hash taps:
 *
 *     float tq = floor(uTime * 24.0);          // <- unbounded
 *     vec2  gp = vUv * uResolution;
 *     float n1 = hash21(gp + tq * 17.13);
 *     float n2 = hash21(gp + tq * 17.13 + 91.7);
 *     float grain = n1 + n2 - 1.0;
 *
 * `uTime` is `this._time += dt` and is never wrapped, so `tq` grows without
 * limit for as long as the tab is open. `hash21`'s first operation is
 * `fract(p * vec2(123.34, 456.21))`. Once that product passes 2^23 the float32
 * ULP is at least 1, which means the rounded product IS an integer, which means
 * `fract` returns exactly 0 - for both components, on every pixel. The hash
 * then returns 0, both taps return 0, and `grain` is a flat -1.0 forever.
 *
 * The film pass subtracts `uGrain` from every pixel of every frame from then
 * on. `GRADE_PRESETS.dock` sets `grain: 0.026`, the highest in the game, in the
 * game's darkest world.
 *
 * MEASURED IN THE BROWSER at the `kestrel` framing, world frozen, HUD hidden,
 * `gl.readPixels` over the full 1280x720 canvas, mean luma 0-255, with `uTime`
 * forced:
 *
 *     uTime    0.5     20      60     120     170     400     900
 *     mean    23.20  22.62   22.52   18.75   16.54   16.63   16.63
 *
 * - and 21.14 at uTime 400 with `uGrain` forced to 0, so the whole 4.5 point
 * loss is the grain's DC bias and it never comes back. (Grain-on at uTime 0.5
 * measures ABOVE grain-off because in a frame this dark the negative half of a
 * zero-mean grain is clipped at black and the positive half is not.)
 *
 * ═══════════════════════════════════════════════════════════════════════════
 *  WHAT THIS TEST DOES
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * It reads the shipped fragment shader, finds the two grain taps and the `tq`
 * line, and runs the named hash through a float32 emulation of the shader -
 * `Math.fround` on every operation, which is what `highp float` is on every
 * desktop GL implementation this game runs on. It then asserts what the frame
 * actually depends on:
 *
 *   1. the grain's MEAN over a tile stays near zero at every `tq` the shader
 *      can produce, so the pass cannot become a brightness control; and
 *   2. its COLUMN means stay decorrelated, so it cannot become vertical
 *      striping. `hash21` fails this long before it fails (1): emulated at
 *      tq 1440 - 60 seconds of uptime - it returns 8 distinct values over a
 *      64x64 tile with an adjacent-column swing of 0.357.
 *
 * Reproduce any row by running this file.
 */

const SRC = readFileSync(
  fileURLToPath(new URL('../../src/gfx/PostFX.js', import.meta.url)), 'utf8');

/* ------------------------------------------------------------------ */
/* float32 emulation of the shader's own hashes                        */
/* ------------------------------------------------------------------ */

const f = Math.fround;
const fract = (x) => f(x - Math.floor(x));

/** `PostFX.js`'s `hash21`, operation for operation, in float32. */
function hash21(px, py) {
  let x = fract(f(px * 123.34));
  let y = fract(f(py * 456.21));
  const d = f(f(x * f(x + 45.32)) + f(y * f(y + 45.32)));
  x = f(x + d); y = f(y + d);
  return fract(f(x * y));
}

/** `PostFX.js`'s `ign` - interleaved gradient noise - in float32. */
function ign(px, py) {
  return fract(f(52.9829189 * fract(f(f(px * 0.06711056) + f(py * 0.00583715)))));
}

const HASHES = { hash21, ign };

/**
 * The grain the shader would produce over a `w x h` tile at a given `tq`,
 * summarised the two ways a frame can notice.
 *
 * `mean` is the DC offset the pass adds to the image; `adjCol` is the mean
 * absolute difference between neighbouring column means, which is what
 * vertical striping is. Spatially independent noise of this amplitude
 * contributes about `1 / sqrt(h)` to `adjCol` and nothing to `mean`.
 */
function grainStats(fn, tq, w = 64, h = 64) {
  const cols = new Array(w).fill(0);
  const seen = new Set();
  let sum = 0;
  const off = f(tq * 17.13);
  for (let j = 0; j < h; j++) {
    for (let i = 0; i < w; i++) {
      const gx = f(i + 0.5 + off), gy = f(j + 0.5 + off);
      const g = fn(gx, gy) + fn(f(gx + 91.7), f(gy + 91.7)) - 1;
      sum += g; cols[i] += g / h; seen.add(g.toFixed(6));
    }
  }
  let adj = 0;
  for (let i = 1; i < w; i++) adj += Math.abs(cols[i] - cols[i - 1]);
  return { mean: sum / (w * h), adjCol: adj / (w - 1), distinct: seen.size };
}

const tapName = () => {
  const m = SRC.match(/float\s+n1\s*=\s*(\w+)\s*\(/);
  return m && m[1];
};

/* ------------------------------------------------------------------ */

test('the grain hash the shipped shader uses is one this file can emulate', () => {
  /* The tap names are read out of the shader rather than assumed, so this file
   * cannot go on asserting things about a hash the pass stopped using. */
  const n1 = SRC.match(/float\s+n1\s*=\s*(\w+)\s*\(/);
  const n2 = SRC.match(/float\s+n2\s*=\s*(\w+)\s*\(/);
  assert.ok(n1 && n2, 'the film pass no longer has n1/n2 grain taps - this file is measuring nothing');
  assert.equal(n1[1], n2[1], `the two grain taps use different hashes: ${n1[1]} and ${n2[1]}`);
  assert.ok(HASHES[n1[1]],
    `the grain taps call ${n1[1]}(), which this file has no float32 emulation for - `
    + 'add one beside hash21 and ign, or the numbers below are about a function nobody ships');
});

test('hash21 collapses to a constant, which is why the taps may not use it', () => {
  /* The evidence, kept executable. This is not a regression guard on `hash21`
   * itself - it is the measurement that says why the grain may not be built on
   * it, and it is what makes the next test's thresholds numbers rather than
   * preferences. */
  assert.ok(Math.abs(grainStats(hash21, 0).mean) < 0.02,
    'hash21 is not even well-behaved at tq 0 - the emulation is wrong');
  assert.equal(grainStats(hash21, 4080).mean, -1,
    'hash21 no longer degenerates at tq 4080 - either this emulation or float32 changed, '
    + 'and the note in PostFX.js about 165 seconds needs re-measuring');
  // The first tq at which every pixel of a tile returns exactly -1.
  let first = 0;
  for (let tq = 3900; tq < 4100; tq++) {
    if (grainStats(hash21, tq, 8, 8).mean === -1) { first = tq; break; }
  }
  assert.equal(first, 3971,
    `hash21 goes fully degenerate at tq ${first}, not 3971 - PostFX.js quotes 165.5 s of uptime`);
  // And it is visibly striped long before it is flat.
  assert.ok(grainStats(hash21, 1440).adjCol > 0.3,
    'hash21 at tq 1440 no longer stripes - re-measure the note in PostFX.js');
});

test('the shipped grain has no DC offset and no striping at any reachable tq', () => {
  /* THE ASSERTION THAT WOULD HAVE CAUGHT IT. The two numbers are the two ways
   * this pass can damage a frame, checked over the whole range of `tq` the
   * shader can produce - which is finite only because the `mod` is there.
   *
   * MEASURED on this tree with `ign` and `mod(..., 512.0)`: the worst |mean|
   * over all 512 reachable values of tq is 0.0035 and the worst adjCol is
   * 0.0219. The same sweep against `hash21` gives 1.000 and 0.413. */
  const fn = HASHES[tapName()];

  const tqLine = SRC.match(/float\s+tq\s*=\s*([^;]+);/);
  assert.ok(tqLine, 'the film pass no longer computes tq');
  const wrap = tqLine[1].match(/mod\s*\([^,]+,\s*([0-9.]+)\s*\)/);
  assert.ok(wrap,
    `tq is computed as "${tqLine[1].trim()}" with no mod - uTime is unbounded `
    + '(PostFX.update: this._time += dt), so tq grows until the hash saturates float32 and the '
    + 'grain becomes a constant -1 on every pixel of every frame, forever');
  const period = Number(wrap[1]);
  assert.ok(period > 8 && period <= 4096,
    `tq wraps at ${period}: under about 8 the grain repeats visibly, and over 4096 it can reach `
    + 'the magnitudes at which a hash saturates');

  let worstMean = ['', 0], worstAdj = ['', 0];
  for (let tq = 0; tq < period; tq++) {
    const st = grainStats(fn, tq);
    if (Math.abs(st.mean) > worstMean[1]) worstMean = [`tq ${tq}`, Math.abs(st.mean)];
    if (st.adjCol > worstAdj[1]) worstAdj = [`tq ${tq}`, st.adjCol];
    assert.ok(st.distinct > 256,
      `${tapName()} returns only ${st.distinct} distinct values over a 64x64 tile at tq ${tq} - `
      + 'that is a pattern, not grain');
  }
  assert.ok(worstMean[1] <= 0.02,
    `the grain's DC offset reaches ${worstMean[1].toFixed(4)} at ${worstMean[0]}. A film grain `
    + 'with a mean is a brightness control: at uGrain 0.026 a mean of -1 cost the dock 4.5 of '
    + '255 on every pixel of every frame and it never came back');
  assert.ok(worstAdj[1] <= 0.06,
    `the grain's adjacent-column means differ by ${worstAdj[1].toFixed(4)} at ${worstAdj[0]} - `
    + 'that is vertical striping across every flat wall in the game, not noise');
});

test('the grade presets all keep grain inside the amplitude the sweep covers', () => {
  /* A preset is what turns a shader defect into a visible one: `dock` runs
   * 0.026, the highest in the game, in the game's darkest world. The sweep
   * above bounds the grain's mean at 0.02 of full scale, so at these
   * amplitudes the worst DC error any preset can produce is under
   * 0.02 * 0.026 = 5.2e-4, i.e. 0.13 of 255. */
  const grains = [...SRC.matchAll(/grain:\s*([0-9.]+)/g)].map((m) => Number(m[1]));
  assert.ok(grains.length >= 5, `only ${grains.length} grain values found in the presets`);
  for (const g of grains) {
    assert.ok(g > 0 && g <= 0.04,
      `a grade preset sets grain ${g}; over 0.04 the pass reads as noise rather than as film`);
  }
});
