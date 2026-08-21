import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { transform } from 'esbuild';

/**
 * EVERY SOURCE FILE IS A SOURCE FILE.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 *  THE DEFECT, WHICH HAPPENED WHILE THIS DROP WAS BEING WRITTEN
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * A comment was added inside `starLayer` in `src/gfx/Sky.js`. The comment was
 * prose about the code, so it quoted an identifier the way every comment in
 * this codebase quotes an identifier - in backticks.
 *
 * `starLayer` is GLSL, and the GLSL in this project lives inside JS TEMPLATE
 * LITERALS. A backtick does not open a code span in a template literal; it
 * ENDS THE STRING. The result was `Uncaught SyntaxError: Unexpected identifier
 * 'mag'`, the module never evaluated, and the entire game failed to boot -
 * black page, no HUD, no harness.
 *
 * ── Why nothing caught it ─────────────────────────────────────────────────
 * 2,067 tests were green. The suite is headless and almost nothing in it
 * imports a file that touches WebGL at module scope, which is most of `gfx/`
 * and every world. `smoke.test.mjs` says so in its own header and pins
 * `Physics` precisely because it is the one module that CAN be imported.
 *
 * So the coverage hole was not "this shader is untested". It was that a whole
 * directory of files could stop being valid JavaScript and the suite would not
 * notice. Nothing about that is specific to shaders: a stray brace in a world
 * builder is the same outage.
 *
 * ── The instrument ────────────────────────────────────────────────────────
 * `esbuild.transform` PARSES a module and never evaluates it, which is exactly
 * the distinction that matters here: it needs no DOM, no canvas and no WebGL,
 * and it still rejects anything that is not valid ES module syntax. Every
 * `.js` under `src/` goes through it.
 *
 * esbuild rather than `vm.SourceTextModule`, and the reason is worth a line:
 * `SourceTextModule` needs `--experimental-vm-modules`, `npm test` is a plain
 * `node --test scripts/tests/*.test.mjs`, and a test that only works under a
 * flag the suite does not pass is a test that reports green by not running.
 * esbuild is already a devDependency of this suite (`planet-minerals`) and it
 * parses the whole tree in well under a second.
 *
 * ── And the specific trap, named ──────────────────────────────────────────
 * Case 2 exists because case 1 only fails when the mistake happens to produce
 * a SYNTAX error. Terminate a shader literal in the wrong place and the GLSL
 * that spills out can be valid JavaScript - `col = mix(a, b);` is an
 * expression statement in both languages - and then the file compiles, the
 * game boots, and the shader is silently half a shader. Case 2 asks the
 * question case 1 cannot: do the braces of every literal that declares GLSL
 * uniforms still balance?
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '../..');
const SRC = path.join(ROOT, 'src');

/** Every `.js` under `src/`, recursively. */
async function sources(dir = SRC, out = []) {
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) await sources(full, out);
    else if (e.name.endsWith('.js')) out.push(full);
  }
  return out;
}

/* ================================================================== */
/* 1. It all parses                                                    */
/* ================================================================== */

test('every file under src/ is valid ES module syntax', async () => {
  const files = await sources();
  assert.ok(files.length > 100,
    `only ${files.length} source files found under ${SRC} - the walk is not reaching them, ` +
    'so a green result here would mean nothing');

  const broken = [];
  for (const f of files) {
    const src = await readFile(f, 'utf8');
    try {
      /* PARSE, do not evaluate. Nothing in these files runs, which is the
       * whole reason this can cover modules no other test in the suite can
       * touch - `gfx/`, every world, anything that opens a canvas at module
       * scope. */
      await transform(src, { loader: 'js', format: 'esm', sourcefile: f });
    } catch (err) {
      broken.push(`${path.relative(ROOT, f)}: ${err.message}`);
    }
  }
  assert.deepEqual(broken, [],
    `${broken.length} source file(s) will not parse, so the game cannot boot at all:\n  ` +
    broken.join('\n  '));
});

/* ================================================================== */
/* 2. Every shader literal balances                                     */
/* ================================================================== */

/**
 * MUTATION RECORD for this file: 8 of 8 red.
 *
 * Four assertion reversals, plus four real defects, each re-run against the
 * case it should redden:
 *   1. the actual bug - a backtick round `mag` in the `starLayer` comment in
 *      `src/gfx/Sky.js`                                    -> case 1 red
 *   2. a stray `{` in `DockExterior._buildCrossWalkKerbs`   -> case 1 red
 *   3. an unterminated string literal in `FlightHUD.js`     -> case 1 red
 *   4. `starLayer` truncated mid-function so its braces no longer balance,
 *      chosen so the file STILL PARSES                      -> case 2 red
 *
 * Number 4 is the whole argument for case 2 existing. Case 1 only fails when
 * the mistake happens to produce a syntax error; terminate a shader literal at
 * a point where the GLSL that spills out is also valid JavaScript - and
 * `col = mix(a, b);` is an expression statement in both languages - and the
 * file compiles, the game boots, and the shader is silently half a shader.
 */
test('every GLSL literal balances its braces, so none is half a shader', async () => {
  const files = await sources();

  /* A shader source here is a template literal of GLSL. Recognised by the
   * declarations only GLSL has rather than by filename: `Sky.js`,
   * `BodyShaders.js`, `PostFX.js`, `HullSkin.js` and several world files all
   * carry one, and a filename list would go stale the day the next is added. */
  const DECLARES = /(?:^|\n)\s*(?:uniform|varying|attribute|precision)\s+\w+/;

  /* BALANCED BRACES, and not "does it have a void main".
   *
   * Plenty of the GLSL here is a FRAGMENT by design - the `onBeforeCompile`
   * chunk injections in `PostFX`, `Portals`, `DecalPool` and three worlds
   * declare uniforms and have no entry point at all, which is correct.
   * Thirteen of them, so an entry-point rule fails the codebase rather than
   * the defect.
   *
   * What a fragment and a whole shader BOTH are is balanced. A literal cut off
   * partway through a function body is not: every brace that function opened
   * is still open when the string ends. That is the property a truncation
   * always breaks and a legitimate chunk never does. */
  const truncated = [];
  let scanned = 0;
  for (const f of files) {
    const src = await readFile(f, 'utf8');
    for (const m of src.matchAll(/`([\s\S]*?)`/g)) {
      const body = m[1];
      if (!DECLARES.test(body)) continue;
      scanned++;
      let depth = 0, floor = 0;
      for (const ch of body) {
        if (ch === '{') depth++;
        else if (ch === '}') { depth--; if (depth < floor) floor = depth; }
      }
      if (depth !== 0 || floor < 0) {
        const line = src.slice(0, m.index).split('\n').length;
        truncated.push(`${path.relative(ROOT, f)}:${line} (brace depth ends at ${depth})`);
      }
    }
  }

  assert.ok(scanned >= 4,
    `only ${scanned} GLSL template literals found across the whole tree - the detector ` +
    'has stopped matching, so a green result below would mean nothing');
  assert.deepEqual(truncated, [],
    'a template literal declares GLSL uniforms and its braces do not balance, so it ' +
    'is half a shader. The overwhelmingly likely cause is a BACKTICK inside the GLSL: a ' +
    'backtick does not quote an identifier in a template literal, it ENDS THE STRING - ' +
    'which is how `Sky.js` once shipped half a starfield shader and a game that would ' +
    `not boot.\n  ${truncated.join('\n  ')}`);
});
