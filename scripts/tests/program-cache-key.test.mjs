import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

/* ==========================================================================
 * THE SCENE FIELDS THAT ARE PROGRAM CACHE KEYS
 * ==========================================================================
 *
 * Three folds `fog`, `fogExp2`, `envMap`, `envMapMode` and
 * `envMapCubeUVHeight` into every program's cache key, exactly as it folds the
 * light counts this project already had to pool into a fixed slot set (see
 * gfx/LightRig.js and the note on `prewarm` in main.js). All five are
 * properties of the SCENE. A world that changes one of them on arrival
 * therefore invalidates the program set of everything on screen - its own
 * geometry, the player's avatar, the viewmodels, the mounts, the gateways and
 * the NPC name sprites - and the arrival frame links the replacements one at a
 * time, blocking on `getProgramInfoLog` for each.
 *
 * Measured on the PRODUCTION bundle, with the background world chain finished
 * and the game otherwise idle, before the two fixes these tests hold in place:
 *
 *     entry            worst frame   new programs   key that changed
 *     sports           28.5-37.7 s   90             fogExp2  '' -> true   (79)
 *     medieval          8.0-33.5 s   28             envMapCubeUVHeight
 *                                                   1024 -> 128           (24)
 *
 * A CPU profile of one such arrival: 28,847 ms of a 30,001 ms frame inside
 * `getProgramInfoLog`. Nothing else came close.
 *
 * These are textual checks, for the same reason as portal-preview-warm's:
 * Portals.js, main.js and the world files touch document/canvas/WebGL at
 * module scope and cannot be imported under Node. Comments are stripped first,
 * so a name mentioned only in prose cannot satisfy anything here.
 * ========================================================================== */

function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

const readCode = async (rel) => stripComments(await readFile(path.join(root, rel), 'utf8'));

test('World declares sceneFog, so a world that swaps the fog can say so', async () => {
  const code = await readCode('src/worlds/World.js');
  assert.match(
    code,
    /get\s+sceneFog\s*\(\s*\)\s*\{/,
    'World has no `sceneFog` accessor. Without it a world that installs its own '
    + 'fog on the scene is indistinguishable from one that does not, and the '
    + 'gateway preview warm has no way to warm the program set the arrival will '
    + 'actually ask for.',
  );
});

test('the gateway preview is dressed in the destination\'s own fog', async () => {
  const code = await readCode('src/systems/Portals.js');
  const start = code.indexOf('_configurePreview(portal, elapsed)');
  assert.ok(start > 0, 'Portals.js has no _configurePreview(portal, elapsed) body');
  const body = code.slice(start, start + 4000);
  assert.match(
    body,
    /world\.sceneFog/,
    'the preview rig ignores `world.sceneFog`. It then warms - links, holds '
    + 'for, draws and caches - a program set keyed to a linear fog that the '
    + 'game asks for NOWHERE except inside the gateway window, and leaves the '
    + 'set the arrival frame needs entirely unpaid. Measured on the production '
    + 'bundle that was 79 programs and a 28-42 s block on the frame the player '
    + 'stepped through.',
  );
});

test('sports declares the exponential fog it installs, and installs what it declares', async () => {
  const code = await readCode('src/worlds/SportsWorld.js');
  assert.match(
    code,
    /get\s+sceneFog\s*\(\s*\)\s*\{\s*return\s+this\._fog;?\s*\}/,
    'SportsWorld does not declare its FogExp2 through `sceneFog`',
  );
  /* The declaration and the installation have to be the SAME instance, or the
   * preview warms one fog and the live scene runs another - which is the whole
   * defect, reintroduced with a `sceneFog` accessor on top of it to hide it. */
  assert.match(
    code,
    /this\.scene\.fog\s*!==\s*this\._fog\s*\)\s*this\.scene\.fog\s*=\s*this\._fog/,
    'SportsWorld no longer installs `this._fog` on the live scene, so what '
    + '`sceneFog` promises the preview warm is not what the arrival gets',
  );
});

test('no other world quietly swaps the scene fog', async () => {
  /* The next world that wants exponential aerial perspective must declare it,
   * not just assign it. An undeclared swap re-keys every program in the game
   * on arrival and nothing says so - which is exactly how this cost 28-42 s of
   * dead main thread for as long as it did. */
  const dir = path.join(root, 'src', 'worlds');
  const files = (await readdir(dir)).filter((f) => f.endsWith('.js'));
  const offenders = [];
  for (const f of files) {
    const code = await readCode(path.join('src', 'worlds', f));
    if (!/\b(?:this\.)?scene\.fog\s*=/.test(code)) continue;
    if (/get\s+sceneFog\s*\(\s*\)\s*\{/.test(code)) continue;
    offenders.push(f);
  }
  assert.deepEqual(
    offenders,
    [],
    `these worlds assign scene.fog without declaring \`sceneFog\`: ${offenders.join(', ')}. `
    + 'Add the accessor and return the instance you install, so the gateway '
    + 'preview warm builds the program set the arrival will ask for.',
  );
});

test('every prefiltered environment map lands on the same cubeUV height', async () => {
  /* `PMREMGenerator.fromEquirectangular` sizes its cube from `image.width / 4`
   * and nothing else; `fromScene` uses its `size` option, which defaults to
   * 256. A cube of 256 gives `envMapCubeUVHeight` 1024, which is what every
   * environment in this game that goes through `fromScene` produces. An
   * equirect narrower than 1024 therefore prefilters to a DIFFERENT key, and
   * every physical material on screen - including the player's own avatar and
   * viewmodels, which no world warm can reach because they are in no world's
   * group - re-links on arrival.
   *
   * Measured before this was fixed: medieval baked its sky at 192 wide, came
   * out at 128, and 24 of the 28 programs its arrival frame linked differed
   * from an existing program in `envMapCubeUVHeight` and in nothing else. */
  const dir = path.join(root, 'src', 'worlds');
  const files = (await readdir(dir)).filter((f) => f.endsWith('.js'));
  const checked = [];
  for (const f of files) {
    const code = await readCode(path.join('src', 'worlds', f));
    if (!/fromEquirectangular\s*\(/.test(code)) continue;
    checked.push(f);
    const widths = [...code.matchAll(/\bconst\s+W\s*=\s*(\d+)\s*;/g)].map((m) => Number(m[1]));
    assert.ok(
      widths.length > 0,
      `${f} calls fromEquirectangular but this test cannot find the source width `
      + '(`const W = <n>;`). Either the bake was restructured - in which case '
      + 'this check has to follow it - or the width is now dynamic, which is '
      + 'worse: it makes the program cache key depend on something nobody reads.',
    );
    for (const w of widths) {
      assert.ok(
        w >= 1024,
        `${f} prefilters a ${w}-wide equirect, so PMREMGenerator sizes its cube `
        + `at ${Math.pow(2, Math.floor(Math.log2(w / 4)))} and the map comes out `
        + `${4 * Math.pow(2, Math.floor(Math.log2(w / 4)))} high instead of 1024. `
        + 'That is a program cache key that disagrees with every other world in '
        + 'the game, and the whole scene re-links on arrival.',
      );
    }
  }
  assert.ok(
    checked.length > 0,
    'no world prefilters an equirectangular sky any more - if that is deliberate, '
    + 'delete this test; if it is not, a world has lost its image-based lighting',
  );
});

/* ==========================================================================
 * THE RENDER TARGET IS A CACHE KEY TOO
 * ==========================================================================
 *
 * Three folds the bound render target into every program's key twice:
 * `outputColorSpace` is the renderer's (`srgb`) when nothing is bound and the
 * working space (`srgb-linear`) when something is, and `toneMapping` is the
 * renderer's when nothing is bound and `NoToneMapping` when something is. So a
 * bare `renderer.compile()` builds the DIRECT-to-canvas set, and with the
 * PostFX chain up the game never draws that way.
 *
 * Read off the production bundle, tallying the cache key of every program at
 * the moment the background world chain finished:
 *
 *     254 of 485   srgb-linear   the set every frame in the session drew with
 *     230 of 485   srgb          the set nothing drew with, ever
 *
 * and every program a world entry linked in front of the player - 46 for
 * sports, 12 for dock, 11 for medieval, 5 for the citadel - was `srgb-linear`.
 *
 * The link wait those programs cost is not small and is not proportional to
 * how many there are: with the WebGL calls timed on that same bundle, the race
 * arrival spent 6,068 ms inside `getProgramInfoLog` for THREE programs.
 * ========================================================================== */

test('PostFX publishes the render target a scene draw actually lands in', async () => {
  const code = await readCode('src/gfx/PostFX.js');
  assert.match(
    code,
    /get\s+scenePassTarget\s*\(\s*\)\s*\{/,
    'PostFX has no `scenePassTarget`. Without it a warm cannot ask which render '
    + 'path this session takes, and `renderer.compile()` silently builds the '
    + 'direct-to-canvas program set instead of the one every frame draws with.',
  );
  const start = code.indexOf('get scenePassTarget()');
  const body = code.slice(start, code.indexOf('\n  }', start));
  assert.match(
    body,
    /if\s*\(\s*!this\._enabled\s*\|\|\s*!this\.composer\s*\)\s*return\s+null/,
    '`scenePassTarget` must answer null when the chain is off. A session that '
    + 'asked for `?postfx=0`, or whose composer failed to build, really does '
    + 'draw to the canvas, and warming it for a target it will never bind is '
    + 'the same defect facing the other way.',
  );
});

test('no warm in main.js compiles with nothing bound', async () => {
  /* `warmCompile` is the one place allowed to call `renderer.compile`, because
   * it is the one place that binds `PostFX.scenePassTarget` first. A bare call
   * anywhere else is a hundred-odd programs built for a render path the session
   * will not take, while the set it does take is still linked lazily, in front
   * of the player, at up to two seconds each. */
  const code = await readCode('src/main.js');
  const start = code.indexOf('function warmCompile(');
  assert.ok(start > 0, 'main.js has no warmCompile() - the target-bound compile is gone');
  const end = code.indexOf('\n}', start);
  const outside = code.slice(0, start) + code.slice(end);
  const stray = [...outside.matchAll(/\brenderer\.compile\s*\(/g)];
  assert.equal(
    stray.length,
    0,
    `main.js calls renderer.compile() directly ${stray.length} time(s) outside `
    + '`warmCompile`. Route it through `warmCompile` so the programs are keyed '
    + 'to the render path the session will actually run.',
  );
});

test('the destination warm wears the destination fog, and reaches what is in no world group', async () => {
  const code = await readCode('src/main.js');
  assert.match(
    code,
    /function\s+withArrivalKey\s*\(/,
    'main.js has no `withArrivalKey`. `warmWorld` then compiles the destination '
    + 'against the fog and environment of the world the player is STANDING in, '
    + 'and every program it builds is keyed to the wrong one - which is the '
    + 'whole reason an arrival still links anything.',
  );
  const start = code.indexOf('function warmWorld(');
  assert.ok(start > 0, 'main.js has no warmWorld()');
  const body = code.slice(start, start + 3000);
  assert.match(
    body,
    /withArrivalKey\s*\(\s*world\s*,/,
    '`warmWorld` no longer dresses the scene in the destination\'s fog and '
    + 'environment before compiling. Its programs go back to being keyed to the '
    + 'departure world and the arrival frame re-links them one at a time.',
  );
  assert.match(
    body,
    /persistentWarmRoots\s*\(\s*\)/,
    '`warmWorld` no longer reaches the avatar, the viewmodels, the mounts, the '
    + 'gateways, the NPCs and the loot pool. They hang off the SCENE, not off a '
    + 'world group, so nothing else reaches them either - and 23 of the 46 '
    + 'programs the sports arrival used to link were exactly those, differing '
    + 'from an existing program in `fogExp2` and in nothing else.',
  );
});

test('one set of gateway materials outlives clear(), so their shader ids hold still', async () => {
  /* Three caches a ShaderMaterial's compiled stages by SOURCE STRING and
   * `WebGLShaderCache.remove()` deletes a stage the instant its last material
   * is disposed. The gateway's four shaders come from four module constants -
   * byte-identical for every gateway in the game - but the cache entry carries
   * an incrementing `id` and that id is IN the program cache key. So disposing
   * the departure world's gateways evicted the stages, `buildForWorld` made
   * fresh materials from the same source milliseconds later, they got new ids,
   * and the identical GLSL was compiled and linked again from cold.
   *
   * Measured on the production bundle: every crossing to a gateway world
   * linked exactly four such programs - disc, halo, motes, embers - and the
   * key diff said `customVertexShaderID 60 -> 92` with every other field
   * equal. Repeated entry/exit paid it again on every crossing and could never
   * converge, because no warm can pre-build a program whose id will not exist
   * until the material does.
   *
   * Retaining one set holds `usedTimes` above zero and the ids steady. It reads
   * like a leak, which is exactly why it needs a test standing next to it. */
  const code = await readCode('src/systems/Portals.js');
  const start = code.indexOf('clear() {');
  assert.ok(start > 0, 'PortalSystem has no clear()');
  const body = code.slice(start, code.indexOf('\n  }', start));
  assert.match(
    body,
    /if\s*\(\s*!this\._shaderAnchor\s*\)/,
    'PortalSystem.clear() no longer retains a set of gateway materials. Every '
    + 'world crossing goes back to re-linking the disc, the halo, the motes and '
    + 'the embers from byte-identical GLSL, and repeated entry/exit never '
    + 'converges.',
  );
  for (const mat of ['discMat', 'haloMat', 'moteMat', 'emberMat']) {
    assert.match(
      body,
      new RegExp(`_shaderAnchor\\s*=\\s*\\{[\\s\\S]{0,240}${mat}:`),
      `the retained set does not include ${mat}. A shader stage held by nothing `
      + 'is evicted, and that one material\'s program is re-linked on every crossing.',
    );
  }
  /* And the other half: it is retained, not leaked once per crossing. */
  assert.match(
    body,
    /\}\s*else\s*\{[\s\S]{0,240}discMat\.dispose\(\)/,
    'clear() no longer disposes the gateway materials once an anchor exists, so '
    + 'every crossing leaks a full set. One is a fixed cost; one per crossing is '
    + 'a leak with a shader program attached to it.',
  );
});

test('withArrivalKey restores what it swapped, and swaps nothing across a yield', async () => {
  const code = await readCode('src/main.js');
  const start = code.indexOf('function withArrivalKey(');
  const body = code.slice(start, code.indexOf('\n}', start));
  assert.match(
    body,
    /finally\s*\{[\s\S]*scene\.fog\s*=[\s\S]*scene\.environment\s*=/,
    '`withArrivalKey` must restore the scene\'s fog and environment in a '
    + '`finally`. A compile that throws with sports\' exponential fog still on '
    + 'the station leaves every material in the game re-keyed, and the next '
    + 'frame re-links all of them.',
  );
  assert.doesNotMatch(
    body,
    /\bawait\b|\basync\b/,
    '`withArrivalKey` has become asynchronous. The swap is only safe because it '
    + 'spans a SYNCHRONOUS compile: a yield between the swap and the restore is '
    + 'a rendered frame wearing another world\'s fog.',
  );
});
