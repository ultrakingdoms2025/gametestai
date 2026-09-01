import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';

/**
 * DOES A WORLD THE PLAYER HAS LEFT EVER GET ITS MEMORY BACK?
 *
 * ═══════════════════════════════════════════════════════════════════════════
 *  THE DEFECT
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `WorldManager._activate` ran `previous.onDeactivate()` and
 * `scene.remove(previous.group)` and NOTHING disposed. `dispose()` was reached
 * for a volatile world about to be rebuilt, and from `WorldManager.dispose()`
 * at page teardown, and from nowhere else - so every world the player entered,
 * and every world the lazy prefetch built because they walked within 48 m of
 * its gateway, stayed fully resident on the GPU for the whole session. The four
 * big worlds' `dispose()` bodies are careful and correct; nothing invoked them.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 *  WHY THE FIX IS TESTED HERE RATHER THAN MEASURED
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Every clause of the keep set exists because getting it wrong is far worse
 * than the leak it fixes. A built world re-enters instantly; an evicted one
 * costs a rebuild (5-12 s for the big worlds) and a relink, and this project's
 * own measurement is that ONE `linkProgram` can cost 5,433 ms on a frame the
 * player is in. So the assertions below are about WHAT SURVIVES, not about how
 * much was freed:
 *
 *   - the active world is never evicted
 *   - the `residentCap` most recently visited worlds are never evicted
 *   - a destination the player is standing near is never evicted
 *   - a destination whose preview warm is in flight is never evicted
 *   - `residentCap = Infinity` evicts nothing at all
 *
 * and one that is about the coupling, which is the part that could fail
 * silently:
 *
 *   - an evicted world is FORGOTTEN by `WorldPrefetch`
 *
 * `WorldPrefetch.started` is a Map that only ever grew. An evicted world left
 * in it can never be prepared again - `isPrepared` and the gateway hold are
 * both `started.has(id)` - so the player walks up to a disc whose destination
 * is neither built nor warmed, and the un-warmed preview draw is measured at
 * 8-14 s inside one gameplay frame. A leak traded for that would be a loss.
 */

globalThis.requestAnimationFrame = globalThis.requestAnimationFrame
  ?? ((cb) => setTimeout(() => cb(Date.now()), 0));

const { WorldManager } = await import('../../src/worlds/WorldManager.js');
const { World } = await import('../../src/worlds/World.js');
const { WorldPrefetch, PREFETCH_RANGE } = await import('../../src/systems/WorldPrefetch.js');
const { EventBus } = await import('../../src/core/EventBus.js');
const { Physics } = await import('../../src/physics/Physics.js');

/**
 * A world that is real enough for the manager and cheap enough for a test.
 *
 * It extends the REAL `World`, so `_built`, `ensureBuilt`, `group`, the
 * collider list and `dispose()`'s traverse are the shipping ones - a stub with
 * its own `_built` flag would pass this file while the manager talked to
 * something else entirely.
 */
function worldClass(id, gates = []) {
  return class extends World {
    static id = id;

    static displayName = id;

    async build() {
      const m = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshBasicMaterial());
      m.name = `${id}:box`;
      this.group.add(m);
      this.portalSpecs = gates.map((g) => ({
        position: new THREE.Vector3(g.x, 0, g.z), rotationY: 0, target: g.to, label: g.to, accent: 0,
      }));
      this.disposed = (this.disposed ?? 0);
    }

    dispose() {
      this.disposed = (this.disposed ?? 0) + 1;
      super.dispose();
    }
  };
}

/**
 * A manager wired the way `main.js` wires one, minus the renderer.
 *
 * `portals` is the live gateway list the eviction pass measures against, in
 * exactly the shape `PortalSystem` publishes: `target`, `discPosition` and
 * `_warmPending`.
 */
function makeManager({ worlds, gates = [], playerAt = { x: 0, y: 0, z: 0 }, cap = 4 } = {}) {
  const bus = new EventBus();
  const physics = new Physics(bus);
  const scene = new THREE.Scene();
  const wm = new WorldManager({ bus, physics, scene, engine: { running: true } });
  for (const C of worlds) wm.register(C);
  const player = { position: new THREE.Vector3(playerAt.x, playerAt.y, playerAt.z), teleport(p) { this.position.copy(p); } };
  const portals = { portals: gates, clear() {}, buildForWorld() {}, holdPreviews() {} };
  const prefetch = new WorldPrefetch({ portals, player, prepare: async () => {} });
  wm.attach({ player, portals, prefetch });
  wm.residentCap = cap;
  return { wm, prefetch, player, portals, scene };
}

const gateAt = (target, x, z, warm = false) => ({
  target, discPosition: new THREE.Vector3(x, 0, z), _warmPending: warm,
});

test('the active world and the last visited ones survive; the rest are freed', async () => {
  const ids = ['a', 'b', 'c', 'd', 'e', 'f'];
  const { wm } = makeManager({ worlds: ids.map((id) => worldClass(id)), cap: 3 });

  for (const id of ids) await wm.activate(id);

  /* Visited order is f, e, d, c, b, a. The cap is three, so f (active), e and
   * d stay; c, b and a go. */
  for (const id of ['f', 'e', 'd']) {
    assert.equal(wm.isBuilt(id), true, `"${id}" is inside the resident cap and must still be built`);
  }
  for (const id of ['c', 'b', 'a']) {
    assert.equal(wm.isBuilt(id), false, `"${id}" fell out of the resident cap and should have been freed`);
  }
  assert.equal(wm.active.id, 'f');
  assert.deepEqual(wm.evictions.ids.slice().sort(), ['a', 'b', 'c']);
});

test('the active world is never evicted, whatever the cap says', async () => {
  const { wm } = makeManager({ worlds: [worldClass('a'), worldClass('b')], cap: 1 });
  await wm.activate('a');
  await wm.activate('b');
  assert.equal(wm.isBuilt('b'), true, 'the world the player is standing in was disposed');
  assert.equal(wm.active.id, 'b');
  assert.equal(wm.isBuilt('a'), false, 'with a cap of one, the previous world is the one that goes');
});

test('a destination the player is standing near is kept, and the same one is freed once they walk away', async () => {
  /* The gateway sits at the origin and the player starts on top of it. Eviction
   * range is twice the prefetch range, deliberately, so the two cannot
   * oscillate around one threshold - the flip costs a full rebuild. */
  const { wm, player } = makeManager({
    worlds: [worldClass('hub'), worldClass('far')],
    gates: [gateAt('far', 0, 0)],
    cap: 1,
  });
  await wm.activate('far');
  await wm.activate('hub');
  assert.equal(wm.isBuilt('far'), true, 'a destination under the player\'s feet must not be evicted');

  player.position.set(0, 0, PREFETCH_RANGE * 2 + 10);
  await wm.build('far');
  assert.equal(wm.isBuilt('far'), true, 'the build that just ran is not evicted by its own pass');
  wm._evictStale();
  assert.equal(wm.isBuilt('far'), false, 'well outside the eviction range and outside the cap, it should go');
});

test('a destination whose preview warm is in flight is never evicted', async () => {
  const gate = gateAt('far', 0, 0, true);
  gate.discPosition.set(0, 0, 5000);
  const { wm } = makeManager({
    worlds: [worldClass('hub'), worldClass('far')],
    gates: [gate],
    cap: 1,
  });
  await wm.activate('far');
  await wm.activate('hub');
  assert.equal(wm.isBuilt('far'), true,
    'the sliced preview warm parks this world\'s group into the preview scene - taking it away mid-warm is a crash, not a saving');

  gate._warmPending = false;
  wm._evictStale();
  assert.equal(wm.isBuilt('far'), false, 'once the warm is done the same world is evictable');
});

test('residentCap = Infinity restores the never-dispose behaviour exactly', async () => {
  const ids = ['a', 'b', 'c', 'd', 'e'];
  const { wm } = makeManager({ worlds: ids.map((id) => worldClass(id)), cap: Infinity });
  for (const id of ids) await wm.activate(id);
  for (const id of ids) assert.equal(wm.isBuilt(id), true, `"${id}" was disposed with eviction switched off`);
  assert.equal(wm.evictions.worlds, 0);
});

test('an evicted world is forgotten by the prefetch, so it can be prepared again', async () => {
  /* THE COUPLING, AND IT IS THE PART THAT WOULD FAIL SILENTLY.
   *
   * `started` is the test for both "has this been prepared" and "should this
   * gateway be held". A world evicted from the manager but left in that Map is
   * a world the poller will never build again and a gateway the hold will never
   * cover - and the un-warmed preview draw that follows is 8-14 s in one
   * gameplay frame. */
  const { wm, prefetch } = makeManager({ worlds: [worldClass('a'), worldClass('b')], cap: 1 });
  await wm.activate('a');
  prefetch.claim('a');
  assert.equal(prefetch.isPrepared('a'), true);

  await wm.activate('b');
  assert.equal(wm.isBuilt('a'), false, 'precondition: "a" was evicted');
  assert.equal(prefetch.isPrepared('a'), false,
    'the prefetch still believes "a" is prepared, so it can never be built or warmed again');
});

test('a preparation in flight is never forgotten', () => {
  /* Belt and braces against the eviction pass touching a building world: two
   * `prepare` calls racing over one world\'s group is worse than either
   * outcome the Map was protecting against. */
  let release;
  const prefetch = new WorldPrefetch({
    portals: { portals: [] },
    player: { position: { x: 0, y: 0, z: 0 } },
    prepare: () => new Promise((r) => { release = r; }),
  });
  prefetch.request('slow');
  assert.equal(prefetch.forget('slow'), false, 'forgetting an in-flight preparation would let a second one start');
  assert.equal(prefetch.isPrepared('slow'), true);
  release();
});

test('the prefetch forgets nothing it never knew', () => {
  const prefetch = new WorldPrefetch({
    portals: { portals: [] }, player: { position: { x: 0, y: 0, z: 0 } }, prepare: async () => {},
  });
  assert.equal(prefetch.forget('never-heard-of-it'), false);
});
