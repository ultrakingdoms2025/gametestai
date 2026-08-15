import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Engine } from '../../src/core/Engine.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const readSrc = async (p) => (await readFile(path.join(root, p), 'utf8')).replace(/\r\n/g, '\n');

/**
 * WHAT HAPPENS WHEN THE GPU GOES AWAY.
 *
 * Observed once, on a measurement run, and it is the worst failure this project
 * has ever recorded. A driver hang - an 11.7 s frame carrying only 8.2 ms of
 * engine CPU, so nothing this game did - took the WebGL context. Three logged
 * `Context Lost.`, `renderer.info` collapsed by 392 programs, 1,375 geometries
 * and 265 textures, and 1.1 s later the browser handed the context back EMPTY.
 *
 * Nothing rebuilt it. Every program was re-linked on demand inside gameplay
 * frames and **the game ran at about 1.3 fps for the remaining eleven minutes**.
 *
 * The trigger was environmental and is not ours to fix. The eleven minutes are.
 * A restored context is exactly a cold program cache with a warm CPU side, and
 * this project already owns the machinery for that state - `prewarm`,
 * `rehearse`, `forceDrawable`, and the sliced `warmWorld` /
 * `warmPortalPreviews`. So the recovery reuses them rather than inventing a
 * second warm, and what is pinned here is that it is WIRED and that it ROUTES
 * THERE - the two ways a recovery silently becomes a no-op.
 *
 * ── Why parts of this are textual ──────────────────────────────────────────
 * `Engine` cannot be constructed under Node: its constructor builds a
 * `THREE.WebGLRenderer` against a real canvas. Its prototype methods can be
 * driven against a stub, which is what the behavioural cases below do (the same
 * idiom as `npc-sim-lod.test.mjs`). `main.js` cannot be imported at all - it
 * builds the whole game at module scope - so the half that lives there is
 * checked by reading it, exactly as `rehearsal-world-warm.test.mjs` does.
 *
 * The one thing no headless test can reach is the browser event itself. To see
 * this end to end, run the game and take the context away:
 *
 *     const gl = GAME.engine.renderer.getContext();
 *     const ext = gl.getExtension('WEBGL_lose_context');
 *     ext.loseContext(); setTimeout(() => ext.restoreContext(), 500);
 */

/* ------------------------------------------------------------------ */
/* The handlers                                                        */
/* ------------------------------------------------------------------ */

/** An engine as the handlers see it: flags, a bus, a clock. */
function stub(over = {}) {
  const emitted = [];
  return {
    contextLost: false,
    _renderHeld: false,
    _recovering: false,
    _paused: false,
    _pausedBeforeLoss: false,
    _accumulator: 0.5,
    _recover: null,
    clock: { getDelta: () => 12.5 },
    bus: { emit: (name, payload) => emitted.push([name, payload]) },
    emitted,
    // The one method the handlers call on themselves, wired to the real one so
    // `_onContextRestored` is tested against what it actually reaches.
    _runRecovery() { return Engine.prototype._runRecovery.call(this); },
    ...over,
  };
}

const lost = (e, event) => Engine.prototype._onContextLost.call(e, event);
const restored = (e) => Engine.prototype._onContextRestored.call(e);
const canRender = (e) => Engine.prototype._canRender.call(e);

test('the lost handler calls preventDefault - without it the context never comes back', () => {
  /* THE ONE LINE THE WHOLE FEATURE RESTS ON. A `webglcontextlost` that is not
   * default-prevented is final: the browser never fires `webglcontextrestored`,
   * and the canvas is dead for the life of the page. Three calls it too, and
   * this calls it again on purpose - a disposed or replaced renderer has
   * removed its listener, and the difference between a hiccup and a black
   * screen must not rest on that. */
  const e = stub();
  let prevented = 0;
  lost(e, { preventDefault: () => prevented++ });
  assert.equal(prevented, 1, 'the context loss was allowed to become permanent');
});

test('losing the context freezes the simulation and announces itself', () => {
  /* Not cosmetic. Every frame that runs blind is a frame the player has walked,
   * been shot at and fallen through without seeing any of it. */
  const e = stub();
  lost(e, { preventDefault() {} });
  assert.equal(e.contextLost, true);
  assert.equal(e._paused, true, 'the simulation ran on through a lost context');
  assert.deepEqual(e.emitted.map(([n]) => n), ['engine:context-lost']);
});

test('a second loss event does not overwrite the paused state it has to give back', () => {
  /* The browser is allowed to fire more than one. If the second overwrote
   * `_pausedBeforeLoss` with the `true` the first one just set, the recovery
   * would hand the game back permanently paused. */
  const e = stub({ _paused: false });
  lost(e, { preventDefault() {} });
  lost(e, { preventDefault() {} });
  assert.equal(e._pausedBeforeLoss, false, 'the pre-loss pause state was clobbered by the second event');
});

test('a game that was already paused stays paused after the recovery', () => {
  const e = stub({ _paused: true, _recover: () => {} });
  lost(e, { preventDefault() {} });
  restored(e);
  return Promise.resolve().then(() => {
    assert.equal(e._paused, true, 'a menu-paused game was resumed by the recovery');
  });
});

test('the restore handler runs the registered recovery', async () => {
  /* The failure this catches is the whole defect restated: a restore that is
   * observed, logged, and does NOTHING is exactly the eleven minutes at 1.3
   * fps. */
  const e = stub();
  let ran = 0;
  e._recover = () => { ran++; };
  lost(e, { preventDefault() {} });
  restored(e);
  await Promise.resolve();
  assert.equal(ran, 1, 'the context came back and nothing re-warmed it');
  assert.equal(e.contextLost, false);
  assert.deepEqual(e.emitted.map(([n]) => n).slice(0, 2), ['engine:context-lost', 'engine:context-restored']);
});

test('a restore with no loss on record is ignored', () => {
  const e = stub();
  let ran = 0;
  e._recover = () => { ran++; };
  restored(e);
  assert.equal(ran, 0, 'a spurious restore kicked off a full re-warm');
});

test('the recovery holds the frame loop still, and hands it back exactly', async () => {
  /* Both halves matter. The hold is what stops an ordinary culled render
   * racing the un-culled warm frames - which would be the 1.3 fps grind
   * arriving through the door the fix came in by. Handing it back is what stops
   * the fix being a permanent freeze. */
  const e = stub({ _paused: false });
  let heldDuring = null;
  let pausedDuring = null;
  e._recover = async () => {
    heldDuring = e._renderHeld;
    pausedDuring = e._paused;
    await Promise.resolve();
  };
  lost(e, { preventDefault() {} });
  await Engine.prototype._runRecovery.call(e);
  assert.equal(heldDuring, true, 'the loop kept rendering through the re-warm');
  assert.equal(pausedDuring, true, 'the simulation ran during the re-warm');
  assert.equal(e._renderHeld, false, 'the render hold was never released - a permanently black screen');
  assert.equal(e._paused, false, 'the game was left paused after a successful recovery');
  assert.equal(e._accumulator, 0, 'the fixed-step backlog from the outage was carried into live frames');
});

test('a recovery that throws still gives the loop back', async () => {
  /* A failed re-warm costs the player the stalls it was there to prevent. A
   * thrown one would cost them the frame loop, permanently. */
  const e = stub();
  e._recover = () => { throw new Error('driver said no'); };
  lost(e, { preventDefault() {} });
  await Engine.prototype._runRecovery.call(e);
  assert.equal(e._renderHeld, false);
  assert.equal(e._paused, false);
  assert.equal(e._recovering, false);
});

test('a second restore while one recovery is running does not start another', async () => {
  const e = stub();
  let ran = 0;
  let release;
  e._recover = () => { ran++; return new Promise((r) => { release = r; }); };
  lost(e, { preventDefault() {} });
  const first = Engine.prototype._runRecovery.call(e);
  await Engine.prototype._runRecovery.call(e);
  release();
  await first;
  assert.equal(ran, 1, 'two overlapping re-warms would each draw the whole world un-culled');
});

test('setPaused during an outage is remembered rather than applied', () => {
  /* A world transition or a menu opening while the context is gone must not be
   * able to write `_paused`, because the recovery is going to overwrite it -
   * and must not be lost either, or the recovery hands back a game that is
   * running when the UI thinks it is paused. */
  const e = stub();
  lost(e, { preventDefault() {} });
  Engine.prototype.setPaused.call(e, true);
  assert.equal(e._paused, true, 'the freeze was lifted mid-outage');
  assert.equal(e._pausedBeforeLoss, true, 'the pause request was dropped on the floor');
  Engine.prototype.setPaused.call(e, false);
  assert.equal(e._pausedBeforeLoss, false);
});

test('setContextRecovery only accepts something callable', () => {
  const e = stub();
  const fn = () => {};
  Engine.prototype.setContextRecovery.call(e, fn);
  assert.equal(e._recover, fn);
  Engine.prototype.setContextRecovery.call(e, 'nope');
  assert.equal(e._recover, null, 'a non-function would throw inside the restore handler');
});

test('the loop refuses to draw with no context, or while a recovery owns the canvas', () => {
  assert.equal(canRender(stub()), true);
  assert.equal(canRender(stub({ contextLost: true })), false);
  assert.equal(canRender(stub({ _renderHeld: true })), false);
});

/* ------------------------------------------------------------------ */
/* The wiring, which is where this can silently become a no-op         */
/* ------------------------------------------------------------------ */

test('the engine listens for both canvas events, after Three does', async () => {
  /* Order is load-bearing and it is not an accident: Three adds its own
   * listeners inside the `WebGLRenderer` constructor, which has already run by
   * the time this code executes, so `onContextRestore`'s `initGLContext()` is
   * guaranteed to have re-created the GL state before ours re-warms into it. */
  const src = await readSrc('src/core/Engine.js');
  const renderer = src.indexOf('new THREE.WebGLRenderer');
  const lostAt = src.indexOf("canvas.addEventListener('webglcontextlost'");
  const restoreAt = src.indexOf("canvas.addEventListener('webglcontextrestored'");
  assert.ok(lostAt > 0 && restoreAt > 0, 'the engine no longer listens for context loss at all');
  assert.ok(lostAt > renderer && restoreAt > renderer,
    'the listeners are installed before the renderer exists; Three would then be second in the queue '
    + 'and the re-warm would run against GL state it has not re-created yet');
  assert.match(src, /_onContextLost = this\._onContextLost\.bind\(this\)/,
    'the handler is no longer a bound prototype method - the cases above drive it through the prototype');
});

test('main.js registers a recovery, and it is the boot warm rather than a log line', async () => {
  const src = await readSrc('src/main.js');
  assert.match(src, /engine\.setContextRecovery\(recoverFromContextLoss\)/,
    'nothing is registered with the engine, so a restored context re-links every program '
    + 'inside gameplay frames - the eleven-minute failure, unchanged');

  const from = src.indexOf('async function recoverFromContextLoss()');
  assert.notEqual(from, -1, 'recoverFromContextLoss is no longer a top-level function in main.js');
  const rest = src.slice(from + 1);
  const next = rest.search(/\n(?:async )?function \w+\(/);
  const fn = next === -1 ? rest : rest.slice(0, next);

  assert.match(fn, /\.compile\(engine\.scene, engine\.camera\)/,
    'the recovery no longer issues the links');
  assert.match(fn, /postfx\.render|renderer\.render|r\.render/,
    'the recovery no longer draws - `compile()` issues linkProgram and DRAWING is what waits for '
    + 'the link, so a compile-only recovery buys nothing at all. See gfx/RehearsalDraw.js');
  assert.match(fn, /await rehearse\(\)/,
    'the recovery no longer goes through `rehearse`, which is the only thing that draws the world, '
    + 'the gateways, the crowd, the mounts and the viewmodels un-culled');
  assert.match(fn, /lightRig\.update\(/,
    'a warm frame without a LightRig pass can expose a light, and the light COUNTS are folded into '
    + 'every program cache key - it would invalidate the whole set it is rebuilding');
  assert.match(fn, /rewarmOtherWorlds\(\)/,
    'the destinations the player is not standing in keep their empty program sets');
});

test('the background half reuses the sliced warms rather than one blocking call', async () => {
  /* Un-sliced, these measured 12.4 s, 15.3 s, 4.8 s and 3.3 s of dead main
   * thread per world on a cold boot. Re-warming them the blocking way after a
   * context loss would trade an eleven-minute grind for four freezes. */
  const src = await readSrc('src/main.js');
  const from = src.indexOf('function rewarmOtherWorlds()');
  assert.notEqual(from, -1, 'rewarmOtherWorlds is gone');
  const rest = src.slice(from + 1);
  const next = rest.search(/\n(?:async )?function \w+\(/);
  const fn = next === -1 ? rest : rest.slice(0, next);

  assert.match(fn, /warmWorld\(id\)/, 'the destinations are no longer precompiled');
  assert.match(fn, /warmPortalPreviews\(id\)/,
    'the gateway previews keep their own program set, keyed to the destination\'s environment and '
    + 'fog - `warmWorld` does not cover them');
  assert.match(fn, /holdPreviews/,
    'without the claim, `Portals.update` draws a preview on the first ready frame and pays the '
    + 'whole destination\'s link cost in one gameplay frame');
  assert.match(fn, /releasePreviews/,
    'a gateway left claimed shows STABILISING for the rest of the session');
  assert.match(fn, /isBuilt/, 'an unbuilt destination has no materials to warm');
});

test('the rehearsal is safe to run mid-game, which is what the recovery does with it', async () => {
  /* `rehearse` was boot-only, and its teardown hid every mount root it had
   * touched. Run while the player is riding one - which a context loss can
   * happen during - that would leave them on an invisible dragon for the rest
   * of the session. `MountManager.unpark` already exempts the active mount for
   * the same reason; the visibility reset has to as well. */
  const src = await readSrc('src/main.js');
  const from = src.indexOf('async function rehearse()');
  const rest = src.slice(from + 1);
  const next = rest.search(/\n(?:async )?function \w+\(/);
  const fn = next === -1 ? rest : rest.slice(0, next);
  assert.match(fn, /mounts\.active/,
    'the rehearsal teardown hides every mount root it spawned, including one the player is riding');
  assert.doesNotMatch(fn, /mountRoots\.forEach\(\(root, i\) => \{\n\s*root\.visible = false;/,
    'the mount roots are hidden unconditionally again');
});
