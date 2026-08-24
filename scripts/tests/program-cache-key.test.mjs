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
