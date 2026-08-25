import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { EventBus } from '../../src/core/EventBus.js';
import { Physics } from '../../src/physics/Physics.js';
import { World } from '../../src/worlds/World.js';
import { WorldManager } from '../../src/worlds/WorldManager.js';
import { Caches } from '../../src/systems/Caches.js';

/**
 * WHAT A CROSSING MUST STILL BE TRUE OF, AND WHAT IT COSTS.
 *
 * `WorldManager._activate` wipes the collision world and re-registers the
 * arriving world's colliders one at a time. That loop was handed to this branch
 * as "~1,617 ms of collider-rebuild JavaScript" over the station's 26,345
 * colliders, and the fix proposed for it was to retain a built collider set per
 * world instead of rebuilding from nothing.
 *
 * Measured on the production bundle it is 7.5 ms of a 1,274 ms crossing - 0.6%
 * - so the retained set was refused. @see
 * docs/superpowers/specs/2026-08-24-crossing-cost-ledger.md
 *
 * These cases exist because the refusal is the kind that gets revisited. A
 * retained or cached collider set is a perfectly reasonable idea to have again,
 * and the way it goes wrong is not that it is slow: it is that the set goes
 * STALE. A collider that survives a crossing it should not have survived is an
 * invisible wall; one that is dropped is a hole in the floor. This repository
 * has four separate shipped defects where a test proved a thing was BUILT and
 * never that a player could REACH it, so the assertions below are written
 * against the capsule and the query rather than against the array length.
 *
 * They pass on today's rebuild-from-nothing. They are here so that they have to
 * go on passing for whatever replaces it.
 */

/* `_runBuild` yields a frame when a build phase runs long. The worlds here are
 * a few hundred boxes and never reach it, but a shim costs nothing and keeps a
 * slow machine from turning this file into a ReferenceError. */
if (typeof globalThis.requestAnimationFrame !== 'function') {
  globalThis.requestAnimationFrame = (fn) => setTimeout(() => fn(performance.now()), 0);
}

/** A world that is a floor, a wall the player must not walk through, and dressing. */
function makeWorld(id, { wallX, props = 200 }) {
  return class extends World {
    static id = id;
    static displayName = id;

    async build() {
      // Floor.
      this.track(this.physics.addBox(0, -0.5, 0, 60, 0.5, 60));
      // The wall this world is identified by.
      this.track(this.physics.addBox(wallX, 2.5, 0, 0.6, 2.5, 20));
      // Dressing, so the broadphase has real work to do and real cells to fill.
      for (let i = 0; i < props; i++) {
        const a = (i / props) * Math.PI * 2;
        this.track(this.physics.addBox(
          Math.cos(a) * (12 + (i % 17)), 0.6, Math.sin(a) * (12 + (i % 23)),
          0.5, 0.6, 0.5,
        ));
      }
      this.playerSpawn.set(0, 1, 0);
    }
  };
}

/** Walk a capsule from the origin toward +x and report where it ended up. */
function walkEast(physics, metres = 8.2) {
  const pos = new THREE.Vector3(0, 1, 0);
  for (let i = 0; i < 120; i++) {
    pos.x += metres / 60;
    physics.resolveCapsule(pos, 0.35, 1.75);
  }
  return pos.x;
}

function makeManager() {
  const bus = new EventBus();
  const scene = new THREE.Scene();
  const physics = new Physics(bus);
  const manager = new WorldManager({
    scene, engine: { running: false }, physics, bus, materials: {},
  });
  manager.register(makeWorld('alpha', { wallX: 3 }));
  manager.register(makeWorld('beta', { wallX: 40, props: 60 }));
  return { manager, physics, bus, scene };
}

/* ------------------------------------------------------------------ */
/* The crossing is complete                                            */
/* ------------------------------------------------------------------ */

test('re-entering a world registers every one of its colliders, exactly once', async () => {
  const { manager, physics } = makeManager();

  await manager.activate('alpha');
  const alpha = manager.getWorld('alpha');
  const first = new Set(physics.colliders);
  assert.equal(first.size, alpha.colliders.length,
    'the first entry did not register the world it was given');

  await manager.activate('beta');
  await manager.activate('alpha');

  const again = new Set(physics.colliders);
  assert.equal(physics.colliders.length, again.size,
    'a collider was registered twice - the second copy answers every query the first does');
  assert.deepEqual([...again].sort(), [...first].sort(),
    're-entry did not restore exactly the set the world authored');
});

test('the departed world is gone, not merely hidden', async () => {
  const { manager, physics } = makeManager();

  await manager.activate('alpha');
  const alpha = manager.getWorld('alpha');
  await manager.activate('beta');

  const live = new Set(physics.colliders);
  for (const c of alpha.colliders) {
    assert.ok(!live.has(c), 'a collider from the world we LEFT is still solid - an invisible wall');
  }
});

test('a broadphase cell never lists the same collider twice after a crossing', async () => {
  const { manager, physics } = makeManager();

  await manager.activate('alpha');
  await manager.activate('beta');
  await manager.activate('alpha');

  for (const [key, list] of physics._grid) {
    assert.equal(new Set(list).size, list.length,
      `broadphase cell ${key} holds a duplicate; every query through it does double the work`);
  }
});

/* ------------------------------------------------------------------ */
/* ... and the player can still not walk through it                    */
/* ------------------------------------------------------------------ */

test('a wall that stopped the player before the crossing stops them after it', async () => {
  const { manager, physics } = makeManager();

  await manager.activate('alpha');
  const before = walkEast(physics);
  assert.ok(before < 2.5, `alpha's wall did not stop the capsule on first entry: x=${before}`);

  await manager.activate('beta');
  const inBeta = walkEast(physics);
  assert.ok(inBeta > 5, `alpha's wall is still solid in beta: x=${inBeta}`);

  await manager.activate('alpha');
  const after = walkEast(physics);
  assert.ok(after < 2.5, `alpha's wall stopped being solid on RE-entry: x=${after}`);
});

test('the floor is still under the player on re-entry', async () => {
  const { manager, physics } = makeManager();

  await manager.activate('alpha');
  const first = physics.groundHeight(0, 0, 5, 20);
  await manager.activate('beta');
  await manager.activate('alpha');
  const again = physics.groundHeight(0, 0, 5, 20);

  assert.notEqual(first, null, 'no floor on first entry');
  assert.equal(again, first, 'the floor moved, or went missing, on re-entry');
});

/* ------------------------------------------------------------------ */
/* The instrument                                                      */
/* ------------------------------------------------------------------ */

test('a crossing records what each of its steps cost', async () => {
  const { manager, physics } = makeManager();

  await manager.activate('alpha');
  await manager.activate('beta');

  const cost = manager.activationCost;
  assert.ok(cost, 'no activationCost recorded - the production-bundle instrument is gone');
  assert.equal(cost.world, 'beta');
  assert.equal(cost.from, 'alpha');
  for (const step of ['changing', 'teardown', 'physicsClear', 'physicsAdd',
    'sceneIn', 'portals', 'arrival', 'npcs', 'changed', 'total']) {
    assert.equal(typeof cost[step], 'number', `activationCost.${step} is missing`);
  }
  assert.equal(cost.colliders, manager.getWorld('beta').colliders.length);
  assert.equal(cost.gridWrites, physics.gridWrites);
});

test('gridWrites counts one write per collider per broadphase cell it occupies', async () => {
  const p = new Physics(null);
  assert.equal(p.gridWrites, 0);

  // cellSize is 12; a half-metre box at the origin lands in exactly one cell.
  p.addBox(6, 0, 6, 0.5, 0.5, 0.5);
  assert.equal(p.gridWrites, 1);

  let entries = 0;
  for (const list of p._grid.values()) entries += list.length;
  assert.equal(entries, p.gridWrites, 'the counter and the grid disagree');

  /* Exactly reproducible, which is the whole reason it exists: wall clock on
   * the machine this was measured on reported identical work as 700 ms and as
   * 14,700 ms, so a timing that moves is not on its own evidence that the work
   * moved. */
  const q = new Physics(null);
  q.addBox(6, 0, 6, 0.5, 0.5, 0.5);
  assert.equal(q.gridWrites, p.gridWrites);
});

test('clearing and re-adding restores the identical broadphase', async () => {
  const p = new Physics(null);
  const boxes = [];
  for (let i = 0; i < 300; i++) {
    boxes.push(p.addBox((i % 20) * 3 - 30, 1, Math.floor(i / 20) * 3 - 20, 0.8, 1, 0.8));
  }
  const writes = p.gridWrites;
  const cells = p._grid.size;

  p.clear();
  assert.equal(p._grid.size, 0);
  assert.equal(p.colliders.length, 0);

  for (const b of boxes) p.add(b);
  assert.equal(p.gridWrites, writes * 2, 'the re-add did not do the same work');
  assert.equal(p._grid.size, cells, 'the rebuilt broadphase has a different shape');
});

/* ------------------------------------------------------------------ */
/* ... and a cache is still on something the player can stand on       */
/* ------------------------------------------------------------------ */

/**
 * WHY THESE CASES ARE ABOUT REACHABILITY AND NOT ABOUT PLACEMENT.
 *
 * `Caches._hasVisibleFloor` was 75% of a station crossing - eleven
 * `THREE.Raycaster` calls against the whole world group at 86 ms each - and the
 * fix is an index that narrows what the raycaster is handed. The cheapest
 * version of that fix is the one these cases exist to forbid: keep the ANSWERS
 * across the crossing, because the placement is seeded and the colliders did
 * not change. It removes the whole cost and it is wrong in a way nothing
 * reports, because the `[Caches]` log line only prints when something LANDED. A
 * site that survives a crossing it should not have survived is a cache floating
 * in mid-air; a site that is not re-found is a world that has quietly lost its
 * reason to fly.
 *
 * So these do not assert "the same three sites came back". They assert
 * "whatever came back has a floor under it that the player can see and stand
 * on, on THIS crossing" - and both directions of staleness are injected between
 * crossings to prove they bite: geometry taken away must lose its site, and
 * geometry put there must be able to gain one.
 */

const SITE_MAT = new THREE.MeshBasicMaterial();

/** A visible slab centred on (x, y, z), with a collider that matches it. */
function slab(world, x, y, z, w, h, d) {
  const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), SITE_MAT);
  m.position.set(x, y, z);
  world.addSolid(m);
  return m;
}

/**
 * A world with a deck you can see, a ledge you cannot, and floor under both.
 *
 * The ground plate is far wider than the content box on purpose. `_findHigh`
 * darts inside the box, and a dart near the plate's edge finds open air on its
 * ring probes and reads it as a drop; keeping every dart well inside the plate
 * means no dart can place anything. The only sites in this world are therefore
 * the AUTHORED ones - which go through `_highAt`, the same predicate the dart
 * has to satisfy, and are deterministic enough to assert on by name.
 */
function makeSiteWorld(id) {
  return class extends World {
    static id = id;
    static displayName = id;

    async build() {
      slab(this, 0, -0.5, 0, 800, 1, 800);
      // A deck the player can see: a plate 12 m up with a long drop all round.
      this.deck = slab(this, 60, 11.5, 60, 12, 1, 12);
      /* And a boundary collider: solid, and nothing whatsoever to look at.
       * This is the shape `_hasVisibleFloor` exists to refuse - `groundHeight`
       * reports a perfectly good surface 14 m up and there is no renderable
       * geometry within a hundred metres of it. */
      this.track(this.physics.addBox(-60, 13.5, -60, 6, 0.5, 6));

      this.contentBounds = new THREE.Box3(
        new THREE.Vector3(-150, 0, -150),
        new THREE.Vector3(150, 40, 150),
      );
      this.cacheSites = [
        { x: 60, z: 60, label: 'deck' },
        { x: -60, z: -60, label: 'boundary ledge' },
      ];
      this.playerSpawn.set(0, 1, 0);
    }
  };
}

/** Enough of Loot for Caches to stock a site against. */
function fakeLoot() {
  return {
    spawned: [],
    spawn(pos, contents, opts) {
      const p = { pos: pos.clone(), contents, opts };
      this.spawned.push(p);
      return p;
    },
    despawn(p) { this.spawned = this.spawned.filter((x) => x !== p); },
  };
}

function makeSiteManager() {
  const bus = new EventBus();
  const scene = new THREE.Scene();
  const physics = new Physics(bus);
  const manager = new WorldManager({
    scene, engine: { running: false }, physics, bus, materials: {},
  });
  manager.register(makeSiteWorld('deckworld'));
  manager.register(makeWorld('elsewhere', { wallX: 40, props: 40 }));
  const loot = fakeLoot();
  const caches = new Caches({ bus, physics, loot, worldManager: manager });
  return { manager, physics, bus, scene, caches, loot };
}

/** Where the RENDER TREE says the floor is at (x, z), or null. */
function seenFloorY(group, x, z, from = 40) {
  const ray = new THREE.Raycaster(
    new THREE.Vector3(x, from, z), new THREE.Vector3(0, -1, 0), 0, 400,
  );
  const hits = ray.intersectObject(group, true);
  return hits.length ? hits[0].point.y : null;
}

/** Drop a capsule onto (x, z) from just above and report where it rests. */
function settleAt(physics, x, y, z) {
  const pos = new THREE.Vector3(x, y + 1.5, z);
  for (let i = 0; i < 400; i++) {
    pos.y -= 0.06;
    physics.resolveCapsule(pos, 0.35, 1.75);
  }
  return pos.y;
}

/** Sites near (x, z), the way the assertions below want to ask. */
function siteNear(caches, x, z, r = 8) {
  return caches.all.find((s) => Math.abs(s.pos.x - x) < r && Math.abs(s.pos.z - z) < r) ?? null;
}

test('every cache placed on re-entry is standing on geometry the player can see', async () => {
  const { manager, physics, caches } = makeSiteManager();

  await manager.activate('deckworld');
  await manager.activate('elsewhere');
  await manager.activate('deckworld');

  const group = manager.getWorld('deckworld').group;
  assert.ok(caches.all.length > 0, 'the world came back with no caches at all');
  for (const s of caches.all) {
    const seen = seenFloorY(group, s.pos.x, s.pos.z);
    assert.notEqual(seen, null,
      `cache ${s.id} hangs over nothing a player can see - a cache in the sky`);
    assert.ok(Math.abs(seen - (s.pos.y - 0.2)) < 1.2,
      `cache ${s.id} sits at y=${s.pos.y} and the nearest visible floor is y=${seen}`);
    const rest = settleAt(physics, s.pos.x, s.pos.y, s.pos.z);
    assert.ok(Math.abs(rest - (s.pos.y - 0.2)) < 1.2,
      `a player dropped on cache ${s.id} fell to y=${rest} instead of standing at y=${s.pos.y}`);
  }
});

test('a boundary collider never gets a cache, however many times the world is entered', async () => {
  const { manager, caches } = makeSiteManager();

  for (let i = 0; i < 3; i++) {
    await manager.activate('deckworld');
    await manager.activate('elsewhere');
  }
  await manager.activate('deckworld');

  assert.equal(siteNear(caches, -60, -60), null,
    'a cache landed on the invisible boundary ledge');
  assert.ok(siteNear(caches, 60, 60),
    'the visible deck lost its cache across repeated crossings');
});

test('STALE, taking away: geometry removed between crossings loses its cache', async () => {
  const { manager, caches } = makeSiteManager();

  await manager.activate('deckworld');
  const world = manager.getWorld('deckworld');
  assert.ok(siteNear(caches, 60, 60),
    'the deck did not get a cache on first entry, so this case proves nothing');

  /* The deck is demolished while the player is away. Its collider stays - it is
   * still solid - and there is no longer anything to see standing on. An answer
   * kept from the previous crossing would put the cache back on a deck that is
   * not there. */
  world.deck.removeFromParent();
  await manager.activate('elsewhere');
  await manager.activate('deckworld');

  assert.equal(siteNear(caches, 60, 60), null,
    'a cache came back on a deck that had been removed - the probe answered from a stale index');
});

test('STALE, putting back: geometry added between crossings can gain a cache', async () => {
  const { manager, caches } = makeSiteManager();

  await manager.activate('deckworld');
  const world = manager.getWorld('deckworld');
  assert.equal(siteNear(caches, 120, 120), null,
    'something was already at the second deck before it was built');

  /* A new deck, and a nomination for it. An index built once and kept would
   * have been built before this existed, and the site would be refused for
   * having no visible floor - which is how a world loses its high caches
   * silently, because the [Caches] line only prints what landed. */
  slab(world, 120, 11.5, 120, 12, 1, 12);
  world.cacheSites = [...world.cacheSites, { x: 120, z: 120, label: 'new deck' }];

  await manager.activate('elsewhere');
  await manager.activate('deckworld');

  const found = siteNear(caches, 120, 120);
  assert.ok(found, 'a deck built between crossings never got its cache');
  const seen = seenFloorY(world.group, found.pos.x, found.pos.z);
  assert.ok(seen !== null && Math.abs(seen - (found.pos.y - 0.2)) < 1.2,
    `the new deck's cache is at y=${found.pos.y} and its visible floor at y=${seen}`);
});

test('the narrowed probe answers exactly what the whole-tree probe answered', async () => {
  const { manager, caches } = makeSiteManager();
  await manager.activate('deckworld');
  const world = manager.getWorld('deckworld');

  /* The index is scoped to one `_onWorld` call, so outside one
   * `_hasVisibleFloor` takes the whole-tree branch. Run both branches over the
   * same grid - the deck, the boundary ledge, open ground, and the empty air
   * between them - and they must not disagree anywhere. A narrowing that drops
   * a candidate deletes a cache site; one that invents a hit puts a cache in
   * the sky. Neither would show up in a timing. */
  const points = [];
  for (let x = -140; x <= 140; x += 10) {
    for (let z = -140; z <= 140; z += 10) {
      for (const y of [0, 11.7, 13.9, 26]) points.push([x, y, z]);
    }
  }

  const whole = points.map(([x, y, z]) => caches._hasVisibleFloor(x, y, z));
  caches._indexVisible(world.group);
  const narrowed = points.map(([x, y, z]) => caches._hasVisibleFloor(x, y, z));
  caches._vis = null;
  caches._visOut = null;

  let found = 0;
  for (let i = 0; i < points.length; i++) {
    if (whole[i]) found++;
    assert.equal(narrowed[i], whole[i],
      `the index disagreed at ${points[i].join(', ')}: whole tree ${whole[i]}, narrowed ${narrowed[i]}`);
  }
  assert.ok(found > 100,
    `only ${found} of ${points.length} probes found a floor - the grid missed the world`);
});
