import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';

/**
 * The measurement harness's own correctness.
 *
 * Every case here is a bug that shipped and cost an afternoon of measuring,
 * because the harness failed silently in each of them - the game kept
 * rendering, the numbers kept arriving, and they were numbers about something
 * else. They are driven against the REAL `Harness` class rather than a
 * re-derivation, which is the only way a test like this stays true.
 *
 * The browser-only globals the class touches are stubbed before the import so
 * the module can be loaded under Node at all.
 */

globalThis.window = globalThis.window ?? globalThis;
globalThis.document = globalThis.document ?? { hidden: false, getElementById: () => null, querySelector: () => null };
globalThis.requestAnimationFrame = globalThis.requestAnimationFrame
  ?? ((cb) => setTimeout(() => cb(Date.now()), 0));

const { Harness } = await import('../../src/dev/Harness.js');
const { walkWorldTriangles } = await import('../../src/dev/WorldTriangles.js');

/* ------------------------------------------------------------------ */
/* A game just real enough to drive the harness                        */
/* ------------------------------------------------------------------ */

class FakeNPCManager {
  constructor() { this.npcs = []; this.calls = 0; }
  fixedUpdate() { this.calls++; }
}

class FakeMount {
  constructor() { this.id = 'car'; this.fixed = 0; this.framed = 0; }
  fixedUpdate() { this.fixed++; }
  update() { this.framed++; }
}

function stubGame({ driven = false, worldId = 'station' } = {}) {
  const camera = new THREE.PerspectiveCamera(70, 1.6, 0.1, 2000);
  const scene = new THREE.Scene();

  // One live sun, plus the rig's parked second slot: `autoUpdate = false` means
  // it renders no shadow map and costs nothing, and mistaking it for a second
  // shadow pass is precisely the misreading `frameCost` exists to prevent.
  const sun = new THREE.DirectionalLight(0xffffff, 2);
  sun.name = 'sun';
  sun.castShadow = true;
  const parked = new THREE.DirectionalLight(0xffffff, 1);
  parked.name = 'rig:dirShadow:1';
  parked.castShadow = true;
  parked.shadow.autoUpdate = false;
  scene.add(sun, parked);

  const fixedUpdaters = new Set();
  const frameUpdaters = new Set();
  const engine = {
    camera,
    scene,
    _paused: false,
    setPaused(p) { this._paused = !!p; },
    onFixedUpdate(fn) { fixedUpdaters.add(fn); return () => fixedUpdaters.delete(fn); },
    onFrameUpdate(fn) { frameUpdaters.add(fn); return () => frameUpdaters.delete(fn); },
    // Deliberately different values: the sampled figures must never be able to
    // masquerade as the instantaneous ones.
    stats: { fps: 58, frameMs: 17.25, frameMsMedian: 16.4, drawCalls: 111, triangles: 222, programs: 9 },
    renderer: { info: { render: { calls: 999, triangles: 888 } } },
    postfx: {
      enabled: true,
      composer: {
        passes: [
          { constructor: { name: 'RenderPass' }, enabled: true },
          { constructor: { name: 'GTAOPass' }, enabled: true },
          { constructor: { name: 'FilmPass' }, enabled: false },
        ],
      },
    },
  };

  const player = {
    position: new THREE.Vector3(0, 0, 0),
    teleports: [],
    _harnessFrozen: false,
    teleport(v, yaw, opts) {
      this.position.copy(v);
      this.teleports.push({ pos: [v.x, v.y, v.z], yaw, opts });
    },
  };

  let drivenState = driven;
  const blocks = new Set(driven ? [] : ['standby']);
  return {
    THREE,
    CONFIG: { player: { eyeHeight: 1.62 } },
    engine,
    scene,
    player,
    avatar: { harnessShadowOnly: false },
    npcManager: new FakeNPCManager(),
    mounts: { active: new FakeMount() },
    portals: { portals: [] },
    worldManager: { active: { id: worldId, group: new THREE.Group() } },
    __dev: {
      setGameplayDriven(on) {
        drivenState = !!on;
        if (drivenState) blocks.delete('standby'); else blocks.add('standby');
        return drivenState;
      },
      isGameplayDriven: () => drivenState,
      gameplayBlocks: () => [...blocks],
      sun,
    },
    _updaters: { fixedUpdaters, frameUpdaters },
  };
}

/* ------------------------------------------------------------------ */
/* 1. Freezing twice must not destroy the game                          */
/* ------------------------------------------------------------------ */

test('freezeAll is idempotent: freeze, freeze, unfreeze restores the real functions', () => {
  /* The original captured `obj[key]` every time it was asked to freeze, so the
   * second freeze recorded the noop the first one had installed. The matching
   * unfreeze then "restored" that noop and `npcManager.fixedUpdate` was dead
   * for the life of the page - no error, no symptom except a world where
   * nobody ever moved again. */
  const game = stubGame();
  const h = new Harness(game);
  const realNpc = FakeNPCManager.prototype.fixedUpdate;
  const mount = game.mounts.active;
  const realMountFixed = FakeMount.prototype.fixedUpdate;

  const first = h.freezeAll(true);
  const second = h.freezeAll(true);
  assert.equal(first.alreadyFrozen, false);
  assert.equal(second.alreadyFrozen, true, 'the second freeze must be a no-op');

  h.freezeAll(false);
  assert.equal(game.npcManager.fixedUpdate, realNpc, 'npcManager.fixedUpdate must be the real one');
  assert.equal(mount.fixedUpdate, realMountFixed);

  // And the restored function must actually run.
  game.npcManager.fixedUpdate(1 / 60, 0);
  assert.equal(game.npcManager.calls, 1);
});

test('a frozen game says so in stats(), and an unfrozen one does not', () => {
  const h = new Harness(stubGame());
  assert.equal(h.stats().frozenAll, false);
  h.freezeAll(true);
  assert.equal(h.stats().frozenAll, true);
  h.freezeAll(false);
  assert.equal(h.stats().frozenAll, false);
});

test('freezeAll can still pause while holdAwake is refusing pauses', () => {
  /* holdAwake replaces `engine.setPaused` to refuse pauses from anywhere else.
   * The harness's own deliberate freeze must not be caught by its own guard. */
  const game = stubGame();
  const h = new Harness(game);
  h.holdAwake(true);
  game.engine.setPaused(true);
  assert.equal(game.engine._paused, false, 'an external pause is refused');
  h.freezeAll(true);
  assert.equal(game.engine._paused, true, 'the harness\'s own freeze still pauses');
  h.freezeAll(false);
  h.holdAwake(false);
  game.engine.setPaused(true);
  assert.equal(game.engine._paused, true, 'the real setPaused is handed back');
});

/* ------------------------------------------------------------------ */
/* 2. stats() plumbing                                                  */
/* ------------------------------------------------------------------ */

test('stats() reports the instantaneous draw calls, not the ~1Hz sample', () => {
  /* `engine.stats` is resampled about once a second, so an A/B that flipped a
   * setting and read straight back got the PREVIOUS frame's figure and produced
   * tables that contradicted themselves. */
  const game = stubGame();
  const s = new Harness(game).stats();
  assert.equal(s.drawCalls, 999, 'drawCalls must come from renderer.info');
  assert.equal(s.triangles, 888);
  assert.equal(s.sampled.drawCalls, 111, 'the sampled figure is kept, under its own name');
  assert.equal(s.sampled.triangles, 222);
  assert.equal(s.sampled.fps, 58);
});

test('stats() says out loud whether gameplay - and therefore LOD - is running', () => {
  const game = stubGame({ driven: false });
  const h = new Harness(game);
  assert.equal(h.stats().gameplayDriven, false);
  assert.deepEqual(h.stats().gameplayBlocks, ['standby']);
  h.setGameplayDriven(true);
  assert.equal(h.stats().gameplayDriven, true);
  assert.deepEqual(h.stats().gameplayBlocks, []);
});

test('stats() reports how far the shadow camera is from what is on screen', () => {
  /* The sun's shadow camera is fitted around the PLAYER. A camera-only framing
   * therefore shadows an empty slab, and the only way to notice is for the
   * distance to be visible. */
  const game = stubGame();
  const h = new Harness(game);
  game.engine.camera.position.set(0, 0, 100);
  assert.equal(h.stats().cameraToPlayer, 100);
});

test('frameCost() counts one live shadow light, not two', () => {
  /* `rig:dirShadow:1` is parked with `shadow.autoUpdate = false` to hold the
   * shader program cache key steady; it renders nothing. Counting it is where
   * a phantom multiplier on the frame cost came from. */
  const fc = new Harness(stubGame()).frameCost();
  assert.equal(fc.liveShadowLights, 1);
  assert.equal(fc.shadowLights.length, 2);
  assert.deepEqual(fc.shadowLights.map((l) => l.name).sort(), ['rig:dirShadow:1', 'sun']);
  assert.equal(fc.shadowLights.find((l) => l.name === 'rig:dirShadow:1').live, false);
  // The pass list, so nobody has to guess what the second full-scene pass is.
  assert.deepEqual(fc.passes.map((p) => p.name), ['RenderPass', 'GTAOPass', 'FilmPass']);
  assert.equal(fc.passes.find((p) => p.name === 'FilmPass').enabled, false);
});

/* ------------------------------------------------------------------ */
/* 3. A vantage moves the player too                                    */
/* ------------------------------------------------------------------ */

test('look() moves the player to the vantage by default', async () => {
  const game = stubGame();
  const h = new Harness(game);
  await h.look([10, 5, 20], [10, 5, 0], 70, { settle: 1 });
  // Feet under the eye: the player's eyeline is the camera.
  assert.deepEqual(
    [game.player.position.x, +game.player.position.y.toFixed(2), game.player.position.z],
    [10, 3.38, 20]
  );
  assert.equal(h.stats().cameraToPlayer, 1.6);
});

test('look({ movePlayer: false }) is still available, and leaves the hole visible', async () => {
  const game = stubGame();
  const h = new Harness(game);
  await h.look([0, 5, 500], [0, 5, 0], 70, { settle: 1, movePlayer: false });
  assert.deepEqual([game.player.position.x, game.player.position.y, game.player.position.z], [0, 0, 0]);
  // 500m of it. The number is the point: an opt-out must not be silent.
  assert.ok(h.stats().cameraToPlayer > 490);
});

test('a view that owns the player position keeps it', async () => {
  /* `above-entrance` looks DOWN on maze level 0 from 60 m up, and MazeWorld
   * streams residency around the PLAYER: moving them to the camera would put
   * them at level 6 and unload the maze this view exists to show. */
  const game = stubGame({ worldId: 'maze' });
  const h = new Harness(game);
  await h.view('above-entrance', { settle: 1 });
  assert.deepEqual([game.player.position.x, game.player.position.z], [0, 0], 'player must not move');

  await h.view('forecourt', { settle: 1 });
  assert.equal(game.player.position.x, 1260, 'an ordinary view does move them');
});

test('pinning re-asserts the player every step, so an aerial vantage does not fall out of frame', () => {
  const game = stubGame();
  const h = new Harness(game);
  h.pinPlayer([0, 60, 0], 0);
  assert.equal(game.avatar.harnessShadowOnly, true, 'the body is in the lens: keep the shadow, drop the mannequin');

  // Gravity, then the pin's fixed-step re-assert.
  game.player.position.y -= 5;
  for (const fn of game._updaters.fixedUpdaters) fn(1 / 60, 0);
  assert.equal(game.player.position.y, 60);

  h.unpinPlayer();
  assert.equal(game.avatar.harnessShadowOnly, false);
  game.player.position.y -= 5;
  for (const fn of game._updaters.fixedUpdaters) fn(1 / 60, 0);
  assert.equal(game.player.position.y, 55, 'released means released');
});

test('re-pinning moves the anchor rather than dragging the player back to the first one', () => {
  /* The re-assert closes over `this._pin`, not over the position it was handed.
   * Closing over the position would have the second vantage silently fight the
   * first one for the rest of the session. */
  const game = stubGame();
  const h = new Harness(game);
  h.pinPlayer([0, 10, 0], 0);
  h.pinPlayer([100, 2, 0], 0);
  for (const fn of game._updaters.fixedUpdaters) fn(1 / 60, 0);
  assert.deepEqual([game.player.position.x, game.player.position.y], [100, 2]);
});

/* ------------------------------------------------------------------ */
/* 4. The deterministic triangle walk                                   */
/* ------------------------------------------------------------------ */

/** `n` triangles' worth of indexed geometry, at `x`. */
function tri(n, x, { name = '', material = 'stone', visible = true } = {}) {
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(3 * 3 * n), 3));
  geo.setIndex(new THREE.BufferAttribute(new Uint16Array(3 * n), 1));
  geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 0, 0), 1);
  const mat = new THREE.MeshBasicMaterial();
  mat.name = material;
  const mesh = new THREE.Mesh(geo, mat);
  mesh.name = name;
  mesh.position.x = x;
  mesh.visible = visible;
  return mesh;
}

function camAt(x, y, z) {
  const cam = new THREE.PerspectiveCamera(60, 1, 0.1, 100);
  cam.position.set(x, y, z);
  cam.lookAt(0, 0, 0);
  cam.updateMatrixWorld(true);
  return cam;
}

test('the walk counts only what is inside the frustum', () => {
  const group = new THREE.Group();
  group.add(tri(10, 0, { name: 'near', material: 'stone' }));
  group.add(tri(7, 5000, { name: 'miles-away', material: 'stone' }));
  const r = walkWorldTriangles(group, camAt(0, 0, 20));
  assert.equal(r.triangles, 10);
  assert.equal(r.objects, 1);
  assert.equal(r.culledObjects, 1);
  assert.equal(r.culledTriangles, 7);
});

test('an invisible object takes its whole subtree with it', () => {
  const group = new THREE.Group();
  const parent = new THREE.Group();
  parent.visible = false;
  parent.add(tri(10, 0));
  group.add(parent);
  group.add(tri(3, 0));
  assert.equal(walkWorldTriangles(group, camAt(0, 0, 20)).triangles, 3);
});

test('frustumCulled = false is drawn, and counted', () => {
  const group = new THREE.Group();
  const far = tri(4, 5000);
  far.frustumCulled = false;
  group.add(far);
  assert.equal(walkWorldTriangles(group, camAt(0, 0, 20)).triangles, 4);
});

test('an InstancedMesh costs its geometry once per instance', () => {
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(3 * 3 * 2), 3));
  geo.setIndex(new THREE.BufferAttribute(new Uint16Array(6), 1));
  geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 0, 0), 1);
  const inst = new THREE.InstancedMesh(geo, new THREE.MeshBasicMaterial(), 50);
  inst.count = 30; // the drawn count, not the allocated one
  const group = new THREE.Group();
  group.add(inst);
  const r = walkWorldTriangles(group, camAt(0, 0, 20));
  assert.equal(r.triangles, 2 * 30);
  assert.equal(r.instances, 30);
});

test('drawRange is honoured, because batched geometry draws a prefix of its buffer', () => {
  const mesh = tri(100, 0);
  mesh.geometry.setDrawRange(0, 30); // 10 triangles' worth of indices
  assert.equal(walkWorldTriangles(new THREE.Group().add(mesh), camAt(0, 0, 20)).triangles, 10);
});

test('the breakdown groups by material and by name, biggest first', () => {
  const group = new THREE.Group();
  group.add(tri(10, 0, { name: 'hedge', material: 'foliage' }));
  group.add(tri(5, 0, { name: 'hedge', material: 'foliage' }));
  group.add(tri(20, 0, { name: 'floor', material: 'stone' }));
  const r = walkWorldTriangles(group, camAt(0, 0, 20));
  assert.deepEqual(r.byMaterial, [
    { key: 'stone', triangles: 20, objects: 1 },
    { key: 'foliage', triangles: 15, objects: 2 },
  ]);
  assert.deepEqual(r.byName.map((b) => b.key), ['floor', 'hedge']);
});

test('an unnamed mesh is attributed to its nearest named ancestor', () => {
  const group = new THREE.Group();
  const district = new THREE.Group();
  district.name = 'district:10,0';
  district.add(tri(6, 0));
  group.add(district);
  const r = walkWorldTriangles(group, camAt(0, 0, 20));
  assert.deepEqual(r.byName, [{ key: 'district:10,0', triangles: 6, objects: 1 }]);
});

test('two graphs with the same contents in a different order produce identical output', () => {
  /* The whole reason this exists: `renderer.info.triangles` moved 10-13%
   * between page loads of an identical framing, because it sums passes whose
   * coverage varies. A tie broken by traversal order would put that
   * non-determinism straight back in. */
  const a = new THREE.Group();
  a.add(tri(9, 0, { name: 'a', material: 'm1' }));
  a.add(tri(9, 0, { name: 'b', material: 'm2' }));
  const b = new THREE.Group();
  b.add(tri(9, 0, { name: 'b', material: 'm2' }));
  b.add(tri(9, 0, { name: 'a', material: 'm1' }));
  const ra = walkWorldTriangles(a, camAt(0, 0, 20));
  const rb = walkWorldTriangles(b, camAt(0, 0, 20));
  assert.equal(JSON.stringify(ra), JSON.stringify(rb));
});

test('worldTriangles() labels which number holds still and which does not', () => {
  const game = stubGame();
  game.worldManager.active.group.add(tri(12, 0, { name: 'deck' }));
  game.engine.camera.position.set(0, 0, 20);
  game.engine.camera.lookAt(0, 0, 0);
  const r = new Harness(game).worldTriangles();
  assert.equal(r.triangles, 12);
  assert.equal(r.deterministic, true);
  assert.equal(r.rendererInfoTriangles, 888, 'the volatile figure is quoted beside it');
  assert.match(r.note, /deterministic/);
});
