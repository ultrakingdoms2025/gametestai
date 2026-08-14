import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as THREE from 'three';
import { planCompileWarm, planPreviewWarm, chunkUnits, runSliced } from '../../src/gfx/PreviewWarm.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

/**
 * The background worlds' precompile must be sliced, and must not shrink.
 *
 * ── The defect ─────────────────────────────────────────────────────────────
 * `scheduleBackgroundBuilds` runs AFTER `engine.start()`, so everything it does
 * happens in gameplay frames with the player standing in the entry world.
 * `warmWorld` was one `renderer.compile()` per world in one callback. Measured
 * on a cold boot with medieval as the entry world, standing still and touching
 * nothing: playable at 112.6 s with 345 programs, then 490 programs 33 s later,
 * with frames of 396.7 ms (`dPrograms +38`) and 553.4 ms. `dGeometries` and
 * `dTextures` were zero on every stall frame - nothing was streaming, it was
 * this function alone. The honest time-to-quiet was ~145 s against a loading
 * screen that opened at 112.6 s.
 *
 * ── The two halves of the fix, and why each needs a test ───────────────────
 *   1. The compile has to go through the slicer, one small batch of novel
 *      program signatures per idle callback. A future edit that reaches for the
 *      whole group in one call - or drops the scheduler - restores the freeze
 *      exactly, and nothing about the code would look wrong.
 *   2. The plan has to be built with `traverse`, not `traverseVisible`. That is
 *      the one-character difference between "slice the same work" and "silently
 *      compile less than we used to": `renderer.compile()` collects materials
 *      with `scene.traverse` and prepares a parked interior as readily as the
 *      street outside, so a visible-only plan would drop every program behind a
 *      hidden door and hand it back to the frame the player opens it on. The
 *      whole-group call is kept as the last slice for exactly this reason, so
 *      coverage cannot shrink even if the signature key under-splits.
 */

function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

const readCode = async (rel) => stripComments(await readFile(path.join(root, rel), 'utf8'))
  .replace(/\r\n/g, '\n');

/** The body of a top-level function in main.js, to the next top-level one. */
function topLevelFn(src, header) {
  const from = src.indexOf(header);
  assert.notEqual(from, -1, `${header} is no longer a top-level function in main.js`);
  const rest = src.slice(from + header.length);
  const next = rest.search(/\n(?:async )?function \w+\(/);
  return next === -1 ? rest : rest.slice(0, next);
}

/* ------------------------------------------------------------------ */
/* 1. The plan covers what compile() covers                            */
/* ------------------------------------------------------------------ */

test('planCompileWarm reaches a hidden subtree that a preview plan drops', () => {
  const world = new THREE.Group();
  const street = new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshStandardMaterial());
  // A parked interior: built, parented, and hidden until the player opens the
  // door. `renderer.compile()` prepares it; a draw never touches it.
  const interior = new THREE.Group();
  interior.visible = false;
  const wall = new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshStandardMaterial());
  interior.add(wall);
  world.add(street, interior);

  const compilePlan = planCompileWarm(world);
  assert.ok(
    compilePlan.includes(wall),
    'the compile plan skipped a hidden subtree. `renderer.compile()` does not: '
    + 'it collects materials with scene.traverse, so a visible-only plan covers '
    + 'strictly less than the single call it replaces and every program it '
    + 'dropped links later, in a gameplay frame',
  );
  assert.ok(compilePlan.includes(street), 'the compile plan skipped a visible mesh');

  assert.equal(
    planPreviewWarm(world).includes(wall), false,
    'planPreviewWarm has stopped being visibility-scoped - a preview draw skips '
    + 'a hidden subtree, so warming one is warming a key the preview never asks for',
  );
  assert.equal(world.visible, true, 'planCompileWarm mutated the root');
  assert.equal(interior.visible, false, 'planCompileWarm left a parked subtree visible');
});

test('planCompileWarm is one representative object per program signature', () => {
  const world = new THREE.Group();
  const shared = new THREE.MeshStandardMaterial();
  const a = new THREE.Mesh(new THREE.BoxGeometry(), shared);
  const duplicate = new THREE.Mesh(new THREE.BoxGeometry(), shared);
  // Same material, different object flags - two programs, because three folds
  // skinning into the cache key.
  const skinned = new THREE.SkinnedMesh(new THREE.BoxGeometry(), shared);
  world.add(a, duplicate, skinned);

  const units = planCompileWarm(world);
  assert.ok(units.includes(a), 'the first user of a material is not in the plan');
  assert.equal(units.includes(duplicate), false, 'an identical second mesh was planned twice');
  assert.ok(units.includes(skinned), 'the skinned copy of a shared material was deduped away');
  assert.deepEqual(planCompileWarm(null), [], 'a null root must plan nothing rather than throw');
  assert.deepEqual(planCompileWarm({}), [], 'an unwalkable root must plan nothing');
});

/* ------------------------------------------------------------------ */
/* 2. The slicing is structural                                        */
/* ------------------------------------------------------------------ */

test('a warmWorld-shaped plan issues at most one batch per scheduler callback', async () => {
  /* The plan is built the way `warmWorld` builds it - a first step that walks
   * the world and appends the batches - so this exercises the append-while-
   * running path as well as the pacing. What must never happen is the whole
   * plan draining inside one callback, which is what an `await` of an
   * already-resolved promise would give and what measures exactly like the
   * block it replaced. */
  const compiled = [];
  const perCallback = [];
  const queue = [];
  const steps = [];
  const units = Array.from({ length: 9 }, (_, i) => i);
  steps.push(() => {
    for (const batch of chunkUnits(units, 2)) {
      steps.push(() => { for (const o of batch) compiled.push(o); });
    }
    steps.push(() => compiled.push('whole-group'));
  });

  const done = runSliced({ steps, schedule: (fn) => queue.push(fn) });
  let guard = 0;
  while (queue.length) {
    assert.equal(queue.length, 1, 'more than one callback armed at a time');
    const before = compiled.length;
    queue.shift()();
    perCallback.push(compiled.length - before);
    assert.ok(++guard < 100, 'the sliced plan never terminated');
  }
  await done;

  assert.deepEqual(compiled, [0, 1, 2, 3, 4, 5, 6, 7, 8, 'whole-group']);
  assert.ok(
    Math.max(...perCallback) <= 2,
    `one callback compiled ${Math.max(...perCallback)} units - the slice size is `
    + 'the only thing bounding the worst frame this warm can cost',
  );
  assert.equal(
    compiled[compiled.length - 1], 'whole-group',
    'the broadening whole-group compile is not the last slice. Without it the '
    + 'warm covers only what the signature key split out, and anything it '
    + 'under-split links on arrival instead',
  );
});

/* ------------------------------------------------------------------ */
/* 3. main.js actually wires it that way                               */
/* ------------------------------------------------------------------ */

test('warmWorld compiles through the slicer, never in one call', async () => {
  const src = await readCode('src/main.js');
  const body = topLevelFn(src, 'function warmWorld(id)');

  assert.match(body, /planCompileWarm\(group\)/,
    'warmWorld no longer plans with planCompileWarm - a plan built from '
    + 'traverseVisible would silently compile less than the call it replaced');
  assert.match(body, /chunkUnits\(/,
    'warmWorld does not chunk its plan, so one callback issues every link it found');
  assert.match(body, /runSliced\(\{/,
    'warmWorld does not go through runSliced. One compile() of a whole world is '
    + 'the 396-553 ms gameplay frame this slicing exists to remove');
  assert.match(body, /schedule:\s*idleSoon/,
    'warmWorld is not scheduled against idleSoon. `idle` (1500 ms) would stretch '
    + 'a hundred slices over minutes, and no scheduler at all runs the whole plan '
    + 'in one task - which measures exactly like the block it replaced');
  assert.match(body, /shouldStop:/,
    'nothing cancels the warm when the world it planned against is rebuilt or '
    + 'disposed, so the plan would compile objects belonging to a dead world');

  // Every compile in here is a slice: one for a batch of plan units, one for the
  // broadening pass. A third, or either of these hoisted out of `steps.push`, is
  // the defect coming back.
  assert.match(
    body,
    /steps\.push\(\(\) => \{\s*for \(const o of batch\) engine\.renderer\.compile\(o, engine\.camera, engine\.scene\);\s*\}\)/,
    'the per-unit compile is not a scheduled step',
  );
  assert.match(
    body,
    /steps\.push\(\(\) => engine\.renderer\.compile\(group, engine\.camera, engine\.scene\)\)/,
    'the broadening whole-group compile is not a scheduled step - as a bare call '
    + 'it is the original block, with extra work in front of it',
  );
  assert.equal(
    (body.match(/renderer\.compile\(/g) ?? []).length, 2,
    'warmWorld makes a compile call that is neither the sliced unit compile nor '
    + 'the broadening pass. Anything unsliced here lands in a gameplay frame',
  );

  const size = src.match(/const WORLD_WARM_UNITS_PER_COMPILE = (\d+)/);
  assert.ok(size, 'main.js has no WORLD_WARM_UNITS_PER_COMPILE');
  assert.ok(
    Number(size[1]) >= 1 && Number(size[1]) <= 4,
    `the warm issues ${size[1]} links per callback. Nothing here ever waits on a `
    + 'link - the cost is ANGLE translating GLSL to HLSL inside glCompileShader, '
    + 'about 10 ms per new program on this driver - so the slice size is the '
    + 'worst frame the warm can cost',
  );
});

/* ------------------------------------------------------------------ */
/* 4. Slicing the warm opened a window; this is what closes it         */
/* ------------------------------------------------------------------ */

/* The regression this half exists for was only visible in a cold boot trace.
 *
 * `Portals.update()` derives `p.ready` from `worldManager.isBuilt(target)` every
 * frame and PRIMES a preview on the first frame a gateway is ready, so the
 * establishing frame of an approach is not an empty window. That priming draw
 * links the destination's entire preview program set inside one gameplay frame.
 *
 * Nothing used to stand between "built" and "warming", and nothing needed to:
 * `warmWorld` was one blocking `compile()` in the same task as the build's
 * resolution, so `warmPreviews` had set `_warmPending` before any frame could
 * run. That is an accident of timing, not a guarantee. Slicing `warmWorld`
 * spread it over ~2.5 s of idle callbacks, the priming pass landed in the gap,
 * and two cold boots measured a SINGLE frame of 8,212 ms and 14,741 ms - +35
 * programs and +512 first-draw geometry uploads - which is worse than the
 * 546 ms frame the slicing removed.
 *
 * So the claim is taken by the caller the instant the build resolves, and
 * released in a `finally`. Both halves have to be there: without the hold the
 * freeze comes back, without the release a gateway shows STABILISING forever. */

test('a destination\'s gateways are claimed before anything warms them', async () => {
  const portals = await readCode('src/systems/Portals.js');
  assert.match(portals, /\bholdPreviews\s*\(\s*target\s*\)\s*\{[\s\S]{0,240}_warmPending = true/,
    'PortalSystem has no holdPreviews(target) that suppresses the live preview');
  assert.match(portals, /\breleasePreviews\s*\(\s*target\s*\)\s*\{[\s\S]{0,240}_warmPending = false/,
    'PortalSystem has no releasePreviews(target)');

  const src = await readCode('src/main.js');
  const chain = topLevelFn(src, 'function scheduleBackgroundBuilds(startWorld)');
  const hold = chain.indexOf('holdPreviews');
  const warm = chain.indexOf('warmWorld(id)');
  assert.ok(hold > 0, 'the background chain never claims the destination\'s gateways');
  assert.ok(warm > 0, 'the background chain no longer calls warmWorld');
  assert.ok(
    hold < warm,
    'the gateways are claimed after warmWorld starts. warmWorld is sliced, so '
    + 'frames run inside it - and the first one draws an un-warmed preview',
  );
  assert.match(
    chain,
    /\.finally\(\(\) => portals\.releasePreviews\?\.\(id\)\)/,
    'the claim is not released in a finally. A build that throws would leave the '
    + 'gateway showing STABILISING for the rest of the session',
  );
});

test('nothing after engine.start() compiles a whole scene in one call', async () => {
  const src = await readCode('src/main.js');

  /* `prewarm()` is the one place a whole-scene compile belongs: it runs behind
   * the loading screen, before `engine.start()`, and the un-sliced cost is the
   * loading screen telling the truth. Everything the background chain reaches
   * runs after the gate opens, in the player's frames. */
  const prewarm = topLevelFn(src, 'async function prewarm()');
  assert.match(prewarm, /engine\.renderer\.compile\(engine\.scene, engine\.camera\)/,
    'prewarm no longer compiles the live scene behind the loading screen');

  const boot = topLevelFn(src, 'async function boot()');
  const started = boot.indexOf('engine.start()');
  assert.ok(started > 0, 'boot() no longer starts the engine');
  assert.doesNotMatch(boot.slice(started), /renderer\.compile\(/,
    'boot() compiles something after engine.start() - that cost is paid in a '
    + 'gameplay frame with the loading screen already gone');

  const background = topLevelFn(src, 'function scheduleBackgroundBuilds(startWorld)');
  assert.doesNotMatch(background, /renderer\.compile\(/,
    'the background build chain compiles directly instead of through the sliced '
    + 'warmWorld');

  // The whole-scene form, anywhere but prewarm, is the shape that cannot be
  // sliced after the fact - it is every material in the game in one callback.
  const elsewhere = src.replace(prewarm, '');
  assert.doesNotMatch(elsewhere, /compile\(engine\.scene/,
    'a whole-scene compile has appeared outside prewarm(). There is no loading '
    + 'screen up by then and no way to slice it: it is every material in the game '
    + 'in one callback');
});
