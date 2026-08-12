import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

/* Textual, for the same reason as rules-applied.test.mjs: Portals.js and
 * main.js touch document/canvas/WebGL at module scope and cannot be imported
 * under Node.
 *
 * What this guards is a regression that is invisible in code review and costs
 * ~41 s of freezes across a 14-minute walk of the station. The gateway discs
 * render their destination into a half-float render target using the
 * *destination's* environment and fog, which is a different Three program cache
 * key from the live scene - so `warmWorld()`'s `compile(group, camera,
 * engine.scene)` does not cover it, and the link cost lands on the frame a
 * gateway first comes within 40 m. Three things have to hold for the warm to
 * hit the right key, and each of them is a one-line edit away from silently
 * warming nothing:
 *
 *   1. main.js has to run the preview warm in the background-build chain, after
 *      warmWorld - before that point the destination's materials do not exist.
 *   2. The warm has to go through the real `_renderPreview` path, so the
 *      preview scene's environment, fog and lights are the destination's.
 *   3. The broadening `compile()` has to run with the preview's render target
 *      *bound*, because `getParameters` reads `renderer.getRenderTarget()`.
 *
 * Comments are stripped before matching, so a name mentioned only in prose
 * cannot satisfy any of these.
 */
function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

const readCode = async (rel) => stripComments(await readFile(path.join(root, rel), 'utf8'));

test('PortalSystem exposes a preview warm', async () => {
  const code = await readCode('src/systems/Portals.js');
  assert.match(code, /\bwarmPreviews\s*\(\s*\{/, 'Portals.js has no warmPreviews method');
});

test('the preview warm goes through the real _renderPreview path', async () => {
  const code = await readCode('src/systems/Portals.js');
  const start = code.indexOf('warmPreviews({');
  assert.ok(start > 0, 'Portals.js has no warmPreviews({ ... }) body');
  const body = code.slice(start, start + 2000);
  assert.match(
    body,
    /this\._renderPreview\(/,
    'warmPreviews does not call _renderPreview - a warm that configures the ' +
    'preview scene itself will drift from the live path and miss the cache key',
  );
  assert.match(
    body,
    /this\._compilePreviewGroup\(/,
    'warmPreviews does not broaden with _compilePreviewGroup - one preview ' +
    'render is frustum-culled and only links what the arrival camera can see',
  );
});

test('the broadening compile runs with the preview render target bound', async () => {
  const code = await readCode('src/systems/Portals.js');
  const i = code.indexOf('_compilePreviewGroup(portal, group)');
  assert.ok(i > 0, 'Portals.js has no _compilePreviewGroup(portal, group)');
  const body = code.slice(i, i + 1200);
  const bind = body.indexOf('setRenderTarget(portal.rt)');
  const compile = body.indexOf('r.compile(');
  assert.ok(bind > 0, '_compilePreviewGroup never binds portal.rt');
  assert.ok(compile > 0, '_compilePreviewGroup never calls compile');
  assert.ok(
    bind < compile,
    'compile() runs before the preview target is bound, so getParameters sees ' +
    'the canvas and links the wrong program key',
  );
  assert.match(
    body,
    /this\._previewScene/,
    '_compilePreviewGroup must resolve lights, fog and environment against the ' +
    'preview scene, not the live one',
  );
});

test('main.js warms gateway previews after each background world build', async () => {
  const code = await readCode('src/main.js');
  assert.match(
    code,
    /\.then\(\s*\(\)\s*=>\s*warmWorld\(id\)\s*\)\s*\.then\(\s*\(\)\s*=>\s*warmPortalPreviews\(id\)\s*\)/,
    'the background build chain does not warm the gateway preview after ' +
    'warmWorld - the preview programs then link during navigation instead',
  );
  assert.match(
    code,
    /function warmPortalPreviews\(id\)[\s\S]{0,400}portals\.warmPreviews\(\s*\{\s*target:\s*id\s*\}\s*\)/,
    'warmPortalPreviews does not call portals.warmPreviews({ target: id })',
  );
});
