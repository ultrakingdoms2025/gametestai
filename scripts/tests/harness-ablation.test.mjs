import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';

/**
 * THE ABLATION, AND THE BOOT IT WAS TAKEN DURING.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 *  WHY THIS FILE EXISTS
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `world-shot --ablate <material>` is the A/B four Phase 9 branches used to
 * decide what owns a pixel. `art-medieval` rejected a hypothesis about the
 * white-orb defect with it. `art-sports` ablated the whole foreground lawn -
 * 2 meshes, 77,668 triangles - watched that crop's mean luma move by 0.00, and
 * reported the 0.00.
 *
 * The ablation was not in force when any of those measurements were taken.
 *
 * ── The mechanism, found by instrumenting `visible` and reading the stack ──
 *
 * `Harness.ready()` used to return the moment `worldManager.active` existed.
 * `boot()` in main.js sets that BEFORE it calls `prewarm()`, and `prewarm` is
 * most of a cold boot. Measured on a headless sports boot:
 *
 *     ready() returned                       t+ 95.9 s
 *     whole world force-drawn (334/334)      t+140.2 s
 *     [boot] playable                        t+172.0 s
 *     background program warm quiet          t+250   s
 *
 * `prewarm` ends in `rehearse()`, which calls `forceDrawable` - it snapshots
 * every object's `visible`/`frustumCulled`, forces both, draws, and then puts
 * the snapshot back. An `--ablate` landing inside that window had its writes
 * replayed away by a snapshot taken before it, and `--ablate` had already
 * printed its hit count. Caught in the act: 77 ablated meshes, 77 writes to
 * `visible = true` from `RehearsalDraw.js:50` and 77 more from its restore at
 * `:65`, every one of them stamped `rehearse -> prewarm -> boot`.
 *
 * Three separate confident wrong numbers come out of that single hole, and all
 * three are pinned below:
 *
 *   1. an ablation reported as applied and not applied,
 *   2. geometry figures taken with NOTHING culled - 783,008 triangles over 334
 *      objects against a settled 768,782 over 225 with 109 culled,
 *   3. `programs`, the figure this phase is gated on, climbing 249 -> 367 ->
 *      615 across one run because the background warm was still linking. That
 *      is the "programs swing 329->390 on unchanged code" noise floor three
 *      branches worked around instead of explaining.
 *
 * ── And the contract, which was the deeper bug ────────────────────────────
 *
 * Even with the mechanism fixed, "2 mesh(es) hidden" is not evidence. A
 * material can be hidden in a framing that never saw it, and the numbers then
 * do not move for a reason that has nothing to do with the system under test.
 * So an ablation now has to REMOVE DRAWN TRIANGLES from at least one framing
 * or the run fails - see the last case in this file.
 */

globalThis.window = globalThis.window ?? globalThis;
globalThis.document = globalThis.document ?? { hidden: false, getElementById: () => null, querySelector: () => null };
globalThis.requestAnimationFrame = globalThis.requestAnimationFrame
  ?? ((cb) => setTimeout(() => cb(Date.now()), 0));

const { Harness } = await import('../../src/dev/Harness.js');
const { forceDrawable, rehearsalInForce } = await import('../../src/gfx/RehearsalDraw.js');
const { drawnTrianglesOf } = await import('../../src/dev/WorldTriangles.js');
const { checkFrame, checkAblation } = await import('../world-shot.mjs');

/* ------------------------------------------------------------------ */
/* A world with two named-material meshes: one in shot, one behind     */
/* ------------------------------------------------------------------ */

function box(name, matName, z) {
  const m = new THREE.Mesh(
    new THREE.BoxGeometry(2, 2, 2),
    new THREE.MeshStandardMaterial({ name: matName })
  );
  m.name = name;
  m.position.set(0, 0, z);
  m.updateMatrixWorld(true);
  return m;
}

function stubGame() {
  const camera = new THREE.PerspectiveCamera(70, 16 / 9, 0.1, 2000);
  // Looking down -Z from the origin, so -20 is in shot and +20 is behind.
  camera.position.set(0, 0, 0);
  camera.lookAt(0, 0, -1);
  camera.updateMatrixWorld(true);

  const group = new THREE.Group();
  group.name = 'world:test';
  group.add(box('lawn', 'test.grass', -20));
  group.add(box('lawn-behind', 'test.grass', 20));
  group.add(box('wall', 'test.stone', -24));
  /* PARENTED INTO A SCENE, exactly as a real world group is. The fixture used
   * to leave it loose, and that hid a real bug: `ablationCheck` walked each
   * mesh to the top of its hierarchy and compared THAT against `world.group`,
   * which is only ever true when the group has no parent. The first browser
   * run reported all 77 ablated meshes as detached, on a world that had not
   * been rebuilt. A fixture that is simpler than the game is a fixture that
   * cannot see the game's bugs. */
  const scene = new THREE.Scene();
  scene.add(group);
  group.updateMatrixWorld(true);

  const frameUpdaters = new Set();
  const fixedUpdaters = new Set();
  const engine = {
    camera,
    scene,
    running: true,
    _paused: false,
    setPaused(p) { this._paused = !!p; },
    onFrameUpdate(fn) { frameUpdaters.add(fn); return () => frameUpdaters.delete(fn); },
    onFixedUpdate(fn) { fixedUpdaters.add(fn); return () => fixedUpdaters.delete(fn); },
    stats: { fps: 60, frameMs: 16, frameMsMedian: 16, drawCalls: 1, triangles: 1, programs: 1 },
    renderer: { info: { render: { calls: 1, triangles: 1 } } },
  };
  return {
    THREE,
    CONFIG: { player: { eyeHeight: 1.62 } },
    engine,
    scene,
    player: { position: new THREE.Vector3(), _harnessFrozen: false, teleport() {} },
    npcManager: { npcs: [] },
    worldManager: { active: { id: 'test', group } },
    __dev: { isGameplayDriven: () => true, setGameplayDriven: () => true, gameplayBlocks: () => [] },
    _frameUpdaters: frameUpdaters,
    _group: group,
  };
}

const step = (g) => { for (const fn of g._frameUpdaters) fn(1 / 60); };
const meshNamed = (g, n) => { let f = null; g._group.traverse((o) => { if (o.name === n) f = o; }); return f; };

/* ══════════════════════════════════════════════════════════════════════════
 *  1. THE MECHANISM: a restore must not replay over a later write
 * ══════════════════════════════════════════════════════════════════════════ */

test('forceDrawable puts back what it changed, not what it remembers', () => {
  const g = new THREE.Group();
  const a = box('a', 'x', 0);
  const b = box('b', 'x', 0);
  g.add(a, b);
  b.frustumCulled = true; // so both are snapshotted

  const restore = forceDrawable([g]);
  assert.equal(a.visible, true, 'forceDrawable must force everything visible');
  assert.equal(a.frustumCulled, false, 'and must clear frustum culling, or the renderer may still skip it');

  /* This is the ablation, landing inside the rehearsal's window. It is not a
   * hypothetical: measured, the whole 38.6 s rehearsal sat AFTER `ready()`
   * returned, which is when the harness does its ablating. */
  a.visible = false;

  const res = restore();
  assert.equal(a.visible, false,
    'the restore replayed a pre-ablation `true` over a write made after its snapshot - '
    + 'this is the defect that cost four branches their ablation evidence');
  assert.equal(b.visible, true, 'and it must still restore everything nobody else touched');
  assert.equal(res.leftAlone, 1, 'and it must SAY it left one alone, so the caller can report it');
  /* Two: `b`, and the group itself - `forceDrawable` walks the root as well as
   * its children, and a Group's `frustumCulled` is true by default so it is
   * snapshotted too. */
  assert.equal(res.restored, 2);
});

test('rehearsalInForce says when the scene is force-drawn, and clears afterwards', () => {
  const g = new THREE.Group();
  g.add(box('a', 'x', 0));
  assert.equal(rehearsalInForce(), 0, 'nothing should be in force before a rehearsal starts');
  const restore = forceDrawable([g]);
  assert.equal(rehearsalInForce(), 1,
    'a measurement taken here is of a world with nothing culled; the flag is how an instrument knows');
  restore();
  assert.equal(rehearsalInForce(), 0);
  restore();
  assert.equal(rehearsalInForce(), 0, 'the restore is idempotent and must not drive the count negative');
});

/* ══════════════════════════════════════════════════════════════════════════
 *  2. `ready()` must not hand back a game that is still booting
 * ══════════════════════════════════════════════════════════════════════════ */

test('ready() waits for the boot warm rather than for the world to exist', async () => {
  const g = stubGame();
  g.engine.running = false;
  const h = new Harness(g);
  let returned = false;
  const p = h.ready({ timeoutMs: 5000 }).then((id) => { returned = true; return id; });
  await new Promise((r) => setTimeout(r, 120));
  assert.equal(returned, false,
    'ready() returned while engine.start() had not run - that is the 76-second window '
    + 'in which every world-shot framing used to be taken');
  g.engine.running = true;
  assert.equal(await p, 'test');
  assert.equal(h.stats().warm.engineRunning, true, 'and it has to record that it waited');
});

test('ready() waits out a rehearsal that is still up', async () => {
  const g = stubGame();
  const h = new Harness(g);
  const restore = forceDrawable([g._group]);
  /* Released in a `finally`: a leaked force-draw is process-global, so a
   * failure here would otherwise make the NEXT case fail for the wrong
   * reason - which is the same class of confusion this file is about. */
  try {
    let returned = false;
    const p = h.ready({ timeoutMs: 5000 }).then(() => { returned = true; });
    await new Promise((r) => setTimeout(r, 120));
    assert.equal(returned, false, 'a force-draw was up and ready() returned anyway');
    restore();
    await p;
    assert.equal(h.stats().warm.rehearsalCleared, true);
  } finally {
    restore();
  }
});

test('settleBoot waits for the shader program cache to stop growing', async () => {
  const g = stubGame();
  const h = new Harness(g);

  /* The cache grows ON BEING READ rather than on a wall-clock timer, and that
   * is not a convenience - a timer-driven fixture made this case fail under a
   * loaded full-suite run (it sampled 612 of 615 before the interval had
   * finished) which is a test that reports the machine rather than the code.
   * Twelve reads take it from the 249 programs measured just after ready() to
   * the 615 the same run settled at; after that it holds, so the only thing
   * being measured is whether `settleBoot` waits for it to hold. */
  let reads = 0;
  Object.defineProperty(g.engine.renderer.info, 'programs', {
    configurable: true,
    get() {
      reads++;
      return new Array(reads < 12 ? 249 + reads * 30 : 615).fill(0);
    },
  });

  const w = await h.settleBoot({ timeoutMs: 30000, stableMs: 60, sampleMs: 10 });
  assert.equal(w.timedOut, false, 'the fixture must settle well inside the budget');
  assert.equal(w.programs, 615,
    'settleBoot handed back a program count that was still moving - this is the 329->390 '
    + '"noise floor" three branches attributed to the renderer');
  assert.equal(w.programsSettled, true);
});

/* ══════════════════════════════════════════════════════════════════════════
 *  3. The ablation must HOLD, and must say what it removed
 * ══════════════════════════════════════════════════════════════════════════ */

test('ablate hides every mesh carrying the named material, and reports a name that matched nothing', () => {
  const g = stubGame();
  const h = new Harness(g);
  const r = h.ablate(['test.grass']);
  assert.equal(r.meshes, 2, 'both meshes carrying the material must be hidden');
  assert.deepEqual(r.missing, []);
  assert.equal(meshNamed(g, 'lawn').visible, false);
  assert.equal(meshNamed(g, 'wall').visible, true, 'an unrelated material must not be touched');

  const typo = h.ablate(['test.grasss']);
  assert.deepEqual(typo.missing, ['test.grasss'],
    'a typo must be reported as a name that matched nothing, not pass as a system that turned out innocent');
});

test('an ablation is HELD against anything that re-shows the meshes', () => {
  const g = stubGame();
  const h = new Harness(g);
  h.ablate(['test.grass']);

  /* Two live mechanisms do this. `gfx/RehearsalDraw.js` is fixed above, but
   * `worlds/lod/DistanceLod.js` writes `e.object.visible` on every band
   * transition and in `remove()`/`clear()` - and the harness MOVES THE CAMERA
   * between framings, which is exactly what makes a band transition happen.
   * Fixing one mechanism and trusting the write is how this comes back. */
  meshNamed(g, 'lawn').visible = true;
  step(g);
  assert.equal(meshNamed(g, 'lawn').visible, false, 'the ablation did not survive a re-show');

  const chk = h.ablationCheck();
  assert.equal(chk.reasserted, 1, 'and it must COUNT the fight, so a world that keeps re-showing is reported');
  assert.deepEqual(chk.stillDrawn, [], 'nothing carrying an ablated material may still be drawn');
});

test('ablationCheck reports the triangles the ablation removes FROM THIS FRAMING', () => {
  const g = stubGame();
  const h = new Harness(g);
  const lawn = meshNamed(g, 'lawn');
  const behind = meshNamed(g, 'lawn-behind');
  const perBox = drawnTrianglesOf([lawn], g.engine.camera).triangles;
  assert.ok(perBox > 0, 'the fixture must have a mesh in shot or this case proves nothing');

  h.ablate(['test.grass']);
  const chk = h.ablationCheck();
  assert.equal(chk.removedTriangles, perBox,
    'only the mesh IN SHOT counts - the one behind the camera was never in the picture, '
    + 'so hiding it is not evidence about anything');
  assert.equal(drawnTrianglesOf([behind], g.engine.camera).triangles, 0);

  /* Turn the camera away from both, and the same ablation is worth nothing in
   * this framing. That is the state `art-sports` measured and reported as a
   * 0.00 luma change: not "the grass is not what is bright", but "no grass was
   * in this crop". */
  g.engine.camera.lookAt(0, 0, 1);
  g.engine.camera.updateMatrixWorld(true);
  assert.equal(h.ablationCheck().removedTriangles, perBox,
    'facing the other way, the mesh BEHIND is now the one in shot');
  g.engine.camera.position.set(0, 400, 0);
  g.engine.camera.lookAt(0, 500, 0);
  g.engine.camera.updateMatrixWorld(true);
  assert.equal(h.ablationCheck().removedTriangles, 0,
    'with neither in shot the ablation removes nothing, and the run must be told so');
});

test('ablationCheck reports meshes only as detached when the world really lost them', () => {
  const g = stubGame();
  const h = new Harness(g);
  h.ablate(['test.grass']);
  assert.equal(h.ablationCheck().detachedMeshes, 0,
    'a world group parented into a scene is still the world group - this check walked to the '
    + 'top of the hierarchy and called every mesh detached, on a world nothing had rebuilt');

  /* Now really take one away, which is what a rebuild does. */
  meshNamed(g, 'lawn').removeFromParent();
  assert.equal(h.ablationCheck().detachedMeshes, 1,
    'and a mesh the world actually dropped must still be reported');
});

test('unablate puts the meshes back exactly as they were', () => {
  const g = stubGame();
  const h = new Harness(g);
  meshNamed(g, 'lawn-behind').visible = false; // already hidden by the world itself
  h.ablate(['test.grass']);
  h.unablate();
  assert.equal(meshNamed(g, 'lawn').visible, true);
  assert.equal(meshNamed(g, 'lawn-behind').visible, false,
    'a mesh the world had already hidden must not be turned ON by releasing an ablation');
  meshNamed(g, 'lawn').visible = true;
  step(g);
  assert.equal(meshNamed(g, 'lawn').visible, true, 'and the hold must be detached, not merely idle');
});

/* ══════════════════════════════════════════════════════════════════════════
 *  4. stats() must not let a boot-time measurement look clean
 * ══════════════════════════════════════════════════════════════════════════ */

test('stats() flags a frame taken while the world is force-drawn', () => {
  const g = stubGame();
  const h = new Harness(g);
  assert.equal(h.stats().rehearsalInForce, 0);
  assert.equal(h.stats().unculledMeshes, 0, 'a settled test world culls normally');
  const restore = forceDrawable([g._group]);
  const s = h.stats();
  assert.equal(s.rehearsalInForce, 1);
  assert.equal(s.unculledMeshes, 3,
    'every mesh has opted out of frustum culling, so a triangle count here is of the whole world');
  restore();
});

/* ══════════════════════════════════════════════════════════════════════════
 *  5. The refusal rules world-shot publishes a row through
 * ══════════════════════════════════════════════════════════════════════════ */

test('a row measured in a different world is refused, not filed under the wrong heading', () => {
  const bad = [];
  checkFrame('entrance-portal', { world: 'station', rehearsalInForce: 0 }, { world: 'sports' }, bad);
  assert.equal(bad.length, 1);
  assert.match(bad[0], /photographed world "station", not "sports"/);

  const ok = [];
  checkFrame('track', { world: 'sports', rehearsalInForce: 0 }, { world: 'sports' }, ok);
  assert.deepEqual(ok, []);
});

test('a row measured during the boot warm is refused', () => {
  const bad = [];
  checkFrame('plaza-wide', { world: 'station', rehearsalInForce: 1 }, { world: 'station' }, bad);
  assert.equal(bad.length, 1);
  assert.match(bad[0], /force-draw/);
});

test('a row whose player is not at the camera is refused when the framing said it would be', () => {
  const bad = [];
  checkFrame('wolf-front',
    { world: 'medieval', rehearsalInForce: 0, cameraToPlayer: 14, expectPlayerAtCamera: true },
    { world: 'medieval' }, bad);
  assert.equal(bad.length, 1, "the sun's shadow box is a 120 m box on the PLAYER; 14 m off is a different slab");

  /* `keepPlayer` framings - the maze's `above-entrance` at 60 m up, its
   * `tower-top` at 30 m - are deliberately not at the player and must pass. */
  const ok = [];
  checkFrame('above-entrance',
    { world: 'maze', rehearsalInForce: 0, cameraToPlayer: 60, expectPlayerAtCamera: false },
    { world: 'maze' }, ok);
  assert.deepEqual(ok, []);
});

test('an ablation that stopped holding is refused', () => {
  const bad = [];
  checkAblation('village-square', {
    active: true, world: 'medieval', worldChanged: false, detachedMeshes: 0,
    stillDrawn: [{ key: 'medieval.glow', triangles: 4096, objects: 2 }],
  }, bad);
  assert.equal(bad.length, 1);
  assert.match(bad[0], /NOT holding/);

  const rebuilt = [];
  checkAblation('shaft-up', {
    active: true, world: 'maze', worldChanged: false, detachedMeshes: 2, stillDrawn: [],
  }, rebuilt);
  assert.equal(rebuilt.length, 1);
  assert.match(rebuilt[0], /no longer under the active world group/);
});

test('frameValidity catches a camera-relative backdrop the camera has left behind', () => {
  const g = stubGame();
  const h = new Harness(g);
  g.engine.camera.position.set(0, 0, 0);
  g.engine.camera.updateMatrixWorld(true);

  /* `space` draws nothing where it says it is: its sky is a 1,920 m dome and
   * every body is a `Backdrop` proxy, both re-placed against the camera every
   * frame. A framing that leaves one behind gets a black ellipse eating the
   * star field and bodies simply absent - and NO NUMBER MOVES. `art-space`
   * lost half an hour to that, reported as a world defect. */
  const proxy = box('space:body:cinder:surface', 'proxy', -1800);
  proxy.frustumCulled = false;
  g._group.add(proxy);
  g._group.updateMatrixWorld(true);
  assert.equal(h.frameValidity().ok, true, '1,800 m is inside the 2,000 m far plane and this frame is fine');

  proxy.position.set(0, 0, -2600);
  g._group.updateMatrixWorld(true);
  const v = h.frameValidity();
  assert.equal(v.ok, false);
  assert.match(v.problems[0], /past the 2000 m far plane/);
});

/* ══════════════════════════════════════════════════════════════════════════
 *  SCOPE: a shared system parented to the SCENE must be reachable
 * ══════════════════════════════════════════════════════════════════════════ */

/**
 * This one line is why a defect survived five art branches.
 *
 * `ablate` used to walk `worldManager.active.group`. `Relics` parents
 * `relics:glow` to the SCENE, so its material was not among medieval's 27 or
 * citadel's 14 world-group material names — a 69-name ablation sweep could
 * never reach it, `worldTriangles()` never counted it, and the material census
 * never listed it. Five branches hunted the white orbs it draws; every
 * instrument they had started at the world group, so none of them could see it.
 *
 * Widening the SEARCH costs nothing in precision, which is the argument for
 * doing it: an ablation names a material, so a wider walk can only make a named
 * material findable — it can never hide something nobody asked for. The second
 * assertion below is the one that pins that, and it is the one a future
 * narrowing would break first.
 */
test('ablate reaches a scene-parented system, not only the world group', () => {
  const g = stubGame();

  /* A shared system that lives beside the world rather than inside it —
   * relics, loot and portals are all built this way. */
  const glow = box('relics:glow', 'relic.glow', 6);
  g.engine.scene.add(glow);
  g.engine.scene.updateMatrixWorld(true);

  const h = new Harness(g);
  const r = h.ablate(['relic.glow']);

  assert.equal(r.meshes, 1,
    'a scene-parented system must be findable; scoping the walk to the world group is ' +
    'exactly what hid relic.glow from five branches');
  assert.deepEqual(r.missing, [], 'the name matched, so nothing may be reported missing');
  assert.equal(glow.visible, false, 'and it must actually be hidden');

  /* The world group must be untouched by a name that does not live there. */
  assert.equal(meshNamed(g, 'lawn').visible, true,
    'widening the search must not widen what gets hidden — ablation names a material');
});
