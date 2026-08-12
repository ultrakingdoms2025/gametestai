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
  const end = code.indexOf('const conclude = (reason)');
  assert.ok(end > start, 'could not find the end of the warmPreviews plan');
  const body = code.slice(start, end);
  assert.match(
    body,
    /this\._configurePreview\(/,
    'the warm does not configure the preview rig through the live path - a ' +
    'warm that dresses the preview scene itself will drift from what the ' +
    'gateway actually draws and miss the cache key entirely',
  );
  assert.match(
    body,
    /this\._renderPreview\(/,
    'the warm never finishes with a real preview render, so the disc is left ' +
    'with uHasPreview = 0 and the gateway never shows its destination',
  );
  assert.match(
    body,
    /this\._compilePreviewGroup\(p, world\.group\)/,
    'the warm does not broaden with a whole-group compile - the sliced draws ' +
    'only cover materials a VISIBLE object carries, and `compile` is the only ' +
    'thing that reaches the rest',
  );
  assert.match(
    body,
    /this\._drawWarmSlice\(/,
    'the warm issues links but never draws them. compile() does not wait for a ' +
    'link and drawing does: a warm that only compiles measures as no warm at all',
  );
});

test('the broadening compile runs with the preview render target bound', async () => {
  const code = await readCode('src/systems/Portals.js');
  const i = code.indexOf('_compilePreviewGroup(portal, root)');
  assert.ok(i > 0, 'Portals.js has no _compilePreviewGroup(portal, root)');
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
    /function warmPortalPreviews\(id\)[\s\S]{0,600}portals\s*\.warmPreviews\(\s*\{\s*target:\s*id,\s*schedule:\s*idleSoon\s*\}\s*\)/,
    'warmPortalPreviews does not call portals.warmPreviews({ target: id, ' +
    'schedule: idleSoon }) - without the scheduler the warm runs as one block ' +
    'and is the 12-15 s freeze it was written to remove',
  );
  // A running game never goes idle, so every idle callback waits out its whole
  // deadline. With the world builds' 1500 ms one, a single gateway's 48 slices
  // measured 78 s and the other three never finished in the opening two minutes.
  const soon = code.match(/const idleSoon = \(fn\) => idleTask\(fn, (\d+)\)/);
  assert.ok(soon, 'main.js has no idleSoon scheduler for the preview slices');
  assert.ok(
    Number(soon[1]) <= 100,
    `the slice scheduler waits ${soon[1]} ms for idle time that never comes; ` +
    'a couple of hundred slices at that deadline is minutes of warm',
  );
  assert.match(
    code,
    /function warmPortalPreviews\(id\)[\s\S]{0,300}return portals/,
    'warmPortalPreviews does not return the warm promise, so the background ' +
    'build chain no longer waits for it and the next world generates on top ' +
    'of the slices',
  );
});

/* ------------------------------------------------------------------ */
/* The time slicing                                                    */
/* ------------------------------------------------------------------ */

/* What follows guards the second half of the same defect. `91689c5` moved the
 * preview link cost off the walk and into `scheduleBackgroundBuilds` - which
 * runs AFTER `engine.start()`, so it landed as four blocking chunks (12.4 s,
 * 15.3 s, 4.8 s, 3.3 s measured) inside the first minute of play.
 *
 * The thing that has to be sliced is the DRAW, not the compile. Measured on the
 * same boot: `_compilePreviewGroup` x4 = 43.9 ms total, `_renderPreview` x4 =
 * 35.8 s. `compile()` issues `linkProgram` and never reads the result; three
 * reads `LINK_STATUS` on first use, which is a draw. A future change that
 * slices the compile instead, or that drops the per-slice yield for an
 * already-resolved promise, measures exactly like the block it replaced. */

test('the warm is sliced against a real yield, one step per callback', async () => {
  const { runSliced } = await import('../../src/gfx/PreviewWarm.js');
  /** A scheduler that runs nothing until it is explicitly driven. */
  const queue = [];
  const schedule = (fn) => queue.push(fn);
  const ran = [];
  const steps = [0, 1, 2, 3].map((i) => () => ran.push(i));

  const done = runSliced({ steps, schedule });
  assert.equal(ran.length, 0, 'runSliced ran work before its scheduler did');

  let ticks = 0;
  while (queue.length) {
    assert.equal(queue.length, 1, 'more than one callback armed at a time');
    const before = ran.length;
    queue.shift()();
    assert.ok(
      ran.length - before <= 1,
      `${ran.length - before} steps ran in ONE scheduler callback - the whole ` +
      'point is that the compositor gets a turn between them',
    );
    if (++ticks > 50) break;
  }
  assert.deepEqual(ran, [0, 1, 2, 3]);
  assert.deepEqual(await done, { ran: 4, total: 4, reason: 'complete' });
});

test('a step may append further steps, and they are picked up', async () => {
  const { runSliced } = await import('../../src/gfx/PreviewWarm.js');
  const queue = [];
  const ran = [];
  const steps = [];
  // The real plan works this way: the first slice for a gateway issues every
  // link and only then walks the destination to build the draw plan.
  steps.push(() => {
    ran.push('plan');
    steps.push(() => ran.push('draw-a'));
    steps.push(() => ran.push('draw-b'));
  });
  const done = runSliced({ steps, schedule: (fn) => queue.push(fn) });
  while (queue.length) queue.shift()();
  await done;
  assert.deepEqual(ran, ['plan', 'draw-a', 'draw-b']);
});

test('the warm stops and pauses without running further work', async () => {
  const { runSliced } = await import('../../src/gfx/PreviewWarm.js');
  const drive = (opts) => {
    const queue = [];
    const p = runSliced({ ...opts, schedule: (fn) => queue.push(fn) });
    return { queue, p };
  };

  let ran = 0;
  let stop = false;
  const a = drive({ steps: [() => ran++, () => ran++, () => ran++], shouldStop: () => stop });
  a.queue.shift()();
  stop = true;
  a.queue.shift()();
  assert.equal(ran, 1, 'shouldStop did not stop the run');
  assert.equal((await a.p).reason, 'cancelled');

  ran = 0;
  let paused = true;
  const b = drive({ steps: [() => ran++], shouldPause: () => paused });
  for (let i = 0; i < 5; i++) b.queue.shift()();
  assert.equal(ran, 0, 'shouldPause did not hold the run');
  paused = false;
  b.queue.shift()();
  assert.equal(ran, 1, 'the run never resumed after the pause cleared');
  while (b.queue.length) b.queue.shift()();
  assert.equal((await b.p).reason, 'complete');

  // A permanently paused system must not hold the callback chain open forever.
  // The cap is wall-clock, not callbacks, because the deliberate settle between
  // issuing links and drawing them is itself a pause of several seconds and a
  // callback count cannot tell the two apart. Clock injected so this is not a
  // timing test.
  let clock = 0;
  const c = drive({
    steps: [() => {}],
    shouldPause: () => true,
    maxPauseMs: 8000,
    now: () => clock,
  });
  for (let i = 0; i < 4 && c.queue.length; i++) { clock += 1000; c.queue.shift()(); }
  assert.equal(c.queue.length, 1, 'a 3 s pause inside an 8 s budget already gave up');
  clock += 9000;
  c.queue.shift()();
  assert.equal((await c.p).reason, 'stalled');
});

test('the draws hold off long enough for the driver to resolve the links', async () => {
  const code = await readCode('src/systems/Portals.js');
  const m = code.match(/const WARM_SETTLE_MS = (\d+)/);
  assert.ok(m, 'Portals.js has no WARM_SETTLE_MS');
  assert.ok(
    Number(m[1]) >= 4000,
    `WARM_SETTLE_MS is ${m[1]} ms. compile() issues a link and never waits for ` +
    'it; the draw waits. Measured on the medieval gateway, same 48 slices: no ' +
    'hold cost 4424 ms of blocking with a 1574 ms worst slice, an 8000 ms hold ' +
    'cost 166 ms with a 29 ms worst slice',
  );
  assert.match(
    code,
    /shouldPause:\s*\(\)\s*=>\s*\{[\s\S]{0,400}performance\.now\(\) >= drawsFrom/,
    'the run does not hold the draws off until drawsFrom',
  );
  assert.match(
    code,
    /const fresh = this\.renderer\.info\.programs\.slice\(before\);\s*if \(paced && fresh\.length\)/,
    'the hold is unconditional - a destination whose programs are all already ' +
    'linked would sit out the settle for nothing, and an unpaced run has no ' +
    'scheduler to yield to so the hold would be a busy-wait',
  );
});

test('the hold ends when the driver says the links are done, not on a guess', async () => {
  const code = await readCode('src/systems/Portals.js');
  assert.match(
    code,
    /_previewLinksResolved\(programs\)[\s\S]{0,400}p\.isReady\(\) === false/,
    'nothing polls WebGLProgram.isReady - the hold is then a fixed guess, and ' +
    'measured while walking a single slice still cost 3.5 s through an 8 s one',
  );
  assert.match(
    code,
    /_previewLinksResolved\(programs\)\s*\{\s*try\s*\{/,
    'the readiness poll is not inside a try - a throw from it would reach the ' +
    'idle chain, which is the exact failure that keeps this file off compileAsync',
  );
  assert.match(
    code,
    /_canAskDriver\(\)[\s\S]{0,400}KHR_parallel_shader_compile/,
    'nothing feature-detects the extension. Without it three flags every ' +
    'program ready on creation, isReady() answers yes instantly, and the hold ' +
    'silently becomes no hold at all',
  );
  // Scoped to the preview warm. `_warmDestination` - the post-swap warmup on
  // the far side of a portal - does use compileAsync, and that is a separate
  // decision with its own timeout and catch.
  const warm = code.slice(code.indexOf('warmPreviews({'), code.indexOf('_warmDestination'));
  assert.ok(warm.length > 500, 'could not isolate the preview warm');
  assert.doesNotMatch(
    warm,
    /compileAsync/,
    'the preview warm reaches for compileAsync. Its readiness promise is ' +
    'driven from an uncaught requestAnimationFrame callback; that is a ' +
    'separate project with its own error boundary',
  );
});

test('a throwing slice ends the run instead of reaching the frame loop', async () => {
  const { runSliced } = await import('../../src/gfx/PreviewWarm.js');
  const queue = [];
  const seen = [];
  const p = runSliced({
    steps: [() => seen.push('ok'), () => { throw new Error('boom'); }, () => seen.push('never')],
    schedule: (fn) => queue.push(fn),
    onError: (err) => seen.push(`caught:${err.message}`),
  });
  while (queue.length) queue.shift()();
  const res = await p;
  assert.deepEqual(seen, ['ok', 'caught:boom']);
  assert.equal(res.reason, 'failed');
});

test('the immediate scheduler drains a long plan without recursing per step', async () => {
  const { runSliced, immediateScheduler } = await import('../../src/gfx/PreviewWarm.js');
  let depth = 0;
  const steps = Array.from({ length: 20000 }, () => () => {
    depth = Math.max(depth, new Error().stack.split('\n').length);
  });
  const res = await runSliced({ steps, schedule: immediateScheduler() });
  assert.equal(res.ran, 20000);
  assert.ok(depth < 60, `stack grew to ${depth} frames - the trampoline is gone`);
});

test('the plan is one representative object per distinct program', async () => {
  const { planPreviewWarm, previewProgramKey, chunkUnits } =
    await import('../../src/gfx/PreviewWarm.js');

  const mat = (uuid) => ({ uuid });
  const shared = mat('shared');
  const node = (props) => ({
    isMesh: true, visible: true, children: [], geometry: { attributes: {} }, ...props,
  });
  // Minimal stand-in for Object3D.traverseVisible.
  const walk = (o, fn) => {
    if (o.visible === false) return;
    fn(o);
    for (const c of o.children ?? []) walk(c, fn);
  };
  /* `visible: false` deliberately. An inactive world's group is hidden - that
   * is how it stays off the live frame - and a preview draw is only possible
   * because parking it forces the flag true. A plan built without doing the
   * same stops at the root, comes back empty, says nothing, and leaves the
   * whole cost to the un-sliced render it was supposed to replace. That is not
   * hypothetical: it is what the first version of this shipped as. */
  const root = { visible: false, children: [], traverseVisible(fn) { walk(this, fn); } };

  const plain = node({ material: shared });
  const skinned = node({ material: shared, isSkinnedMesh: true });
  const duplicate = node({ material: shared });
  const multi = node({ material: [mat('a'), mat('b')] });
  const hiddenParent = { visible: false, children: [node({ material: mat('hidden') })] };
  const light = { isLight: true, visible: true, children: [] };
  root.children.push(plain, skinned, duplicate, multi, hiddenParent, light);

  const units = planPreviewWarm(root);
  assert.deepEqual(
    units, [plain, skinned, multi],
    'the plan must carry the skinned copy of a shared material (its object ' +
    'flags are part of the program key), drop the exact duplicate, count a ' +
    'multi-material mesh once because one draw covers every group, and skip ' +
    'an invisible subtree - which never reaches a draw and so never links',
  );
  assert.equal(root.visible, false, 'planPreviewWarm left the destination group visible');

  assert.notEqual(
    previewProgramKey(plain, shared), previewProgramKey(skinned, shared),
    'skinning is not in the program key',
  );
  assert.equal(
    previewProgramKey(plain, shared), previewProgramKey(duplicate, shared),
    'two identical meshes produced two keys',
  );
  assert.deepEqual(chunkUnits([1, 2, 3, 4, 5], 2), [[1, 2], [3, 4], [5]]);
  assert.deepEqual(chunkUnits([1, 2, 3], 0), [[1], [2], [3]], 'a zero size must not hang');
});

test('an un-warmed gateway preview is never drawn by the frame loop', async () => {
  const code = await readCode('src/systems/Portals.js');
  assert.match(
    code,
    /_warmPending:\s*false/,
    'portals carry no _warmPending flag',
  );
  const i = code.indexOf('viewDist < PREVIEW_RANGE');
  assert.ok(i > 0, 'the 10 Hz preview gate is gone');
  const gate = code.slice(Math.max(0, i - 400), i);
  assert.match(
    gate,
    /!\s*p\._warmPending/,
    'update() draws a preview whose sliced warm has not finished - that draw ' +
    'IS the 14 s freeze, paid inside a gameplay frame',
  );
  assert.match(
    code,
    /warmPreviews\([\s\S]{0,4000}p\._warmPending = true/,
    'warmPreviews never suppresses the live preview while it is slicing',
  );
});

test('a slice draws on its own camera layer, with the preview lights on it', async () => {
  const code = await readCode('src/systems/Portals.js');
  const i = code.indexOf('_drawPreviewSlice(portal, cam, slice)');
  assert.ok(i > 0, 'Portals.js has no _drawPreviewSlice(portal, cam, slice)');
  const body = code.slice(i, i + 1200);
  assert.match(body, /cam\.layers\.set\(WARM_LAYER\)/, 'the slice draw does not isolate the camera layer');
  assert.match(body, /o\.layers\.enable\(WARM_LAYER\)/, 'the slice objects never reach the camera layer');
  assert.match(body, /o\.frustumCulled = false/, 'a slice object outside the arrival frustum would not draw at all');
  assert.match(body, /finally/, 'the slice leaves layers and culling mutated if the draw throws');
  assert.match(body, /o\.layers\.mask = mask/, 'the slice does not restore the exact layer mask');

  const rig = code.indexOf('_buildPreviewRig()');
  const rigBody = code.slice(rig, code.indexOf('_ensurePreviewTarget'));
  assert.match(
    rigBody,
    /_previewScene\.traverse\(\(o\) => o\.layers\.enable\(WARM_LAYER\)\)/,
    'the preview light rig is not on the warm layer - projectObject gates ' +
    'lights on layers exactly as it gates meshes, so every slice would link a ' +
    'zero-light program set the live preview never asks for',
  );
});

test('a slice never leaves the destination parked across a yield', async () => {
  const code = await readCode('src/systems/Portals.js');
  const i = code.indexOf('_drawWarmSlice(portal, world, slice)');
  assert.ok(i > 0, 'Portals.js has no _drawWarmSlice(portal, world, slice)');
  const body = code.slice(i, i + 900);
  assert.match(body, /_parkPreviewGroup\(/, 'the slice never parks the destination in the preview scene');
  assert.match(
    body,
    /finally\s*\{\s*this\._unparkPreviewGroup\(/,
    'the slice does not un-park in a finally - a group left parked has been ' +
    'removed from its own world, and the next yield hands that to the game',
  );
});
