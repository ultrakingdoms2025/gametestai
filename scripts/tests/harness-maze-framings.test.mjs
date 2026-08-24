import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';

/**
 * THE FRAMING THAT KILLED THE RUN, AND THE WORLD THAT WAS NEVER TWICE THE SAME.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 *  WHY THIS FILE EXISTS
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `VIEWS.maze` has five framings. `lift-car` is computed, and
 * `Harness._findLiftFraming` returned null whenever no district the maze had
 * actually streamed contained a shaft that emitted a LIFT. `view()` then threw
 * `could not compute view "lift-car"`, the throw escaped `scripts/world-shot.mjs`
 * before `report.json` was written, and four good framings' measurements were
 * destroyed in order to report the fifth one's absence.
 *
 * That is not a rare edge. Driven over 64 seeds against the real topology
 * generator, at the fixed spawn entrance (district dx:10, dz:0, world x=1260)
 * with the real `RESIDENCY_RADIUS` neighbourhood:
 *
 *     resident shafts    min 2   median 5   max 11
 *     resident lifts     min 0   median 1   max  3
 *     seeds with NO resident lift        30 of 64   =  46.9%
 *     seeds with NO resident shaft at all  0 of 64  =   0.0%
 *
 * So `lift-car` failed on nearly half of all runs, and `shaft-up` on none.
 *
 * ── And the second half: the world was different every time ───────────────
 *
 * `MazeWorld.build()` re-seeds from `Math.random()` on every activation, and
 * the world is `volatile`, so it rebuilds on every activation. That is right
 * for a player - "the maze that cannot be learned is the entire point" - and
 * it means two runs of the SAME COMMIT photograph two unrelated mazes. Any
 * before/after of this world was measuring the seed.
 *
 * Both are fixed, and neither by pinning a seed and calling it done:
 *
 *   - `_findLiftFraming` MAKES a lift resident when none is. The nearest lift
 *     in the whole topology is a median 186 m from spawn (worst 523 m over 24
 *     seeds) and a maze holds 33-58 of them, so the player is teleported there
 *     and residency follows. The framing then works on ANY seed.
 *   - `MazeWorld.seedOverride` lets the harness pin the seed when it wants a
 *     repeatable before/after. It is null in every normal boot.
 *
 * The order matters: a fixed seed alone would make the maze photographable
 * while meaning the review only ever sees one maze, and would still leave the
 * framing broken for anyone who did not pin one.
 */

globalThis.window = globalThis.window ?? globalThis;
globalThis.document = globalThis.document ?? { hidden: false, getElementById: () => null, querySelector: () => null };
globalThis.requestAnimationFrame = globalThis.requestAnimationFrame
  ?? ((cb) => setTimeout(() => cb(Date.now()), 0));

const { Harness } = await import('../../src/dev/Harness.js');
const { MazeWorld } = await import('../../src/worlds/MazeWorld.js');
const {
  MAZE, generateTopology, districtAtWorld, neighbourhoodKeys,
} = await import('../../src/worlds/maze/MazeTopology.js');
const { cellToWorld } = await import('../../src/worlds/maze/MazeColliders.js');
const { shaftColliders } = await import('../../src/worlds/maze/MazeShafts.js');

/** The radius `MazeWorld` streams around the player. Mirrored in MazeBatches. */
const RESIDENCY_RADIUS = 2;

/** The district set `MazeChunks.updateResidency` keeps for a player at (x,y,z). */
function residentKeysAt(x, y, z) {
  const level = Math.min(MAZE.LEVELS - 1, Math.max(0, Math.round(y / MAZE.LEVEL_HEIGHT)));
  const want = new Set(neighbourhoodKeys(districtAtWorld(x, z, level), RESIDENCY_RADIUS));
  for (const dl of [-1, 1]) {
    const near = level + dl;
    if (near < 0 || near >= MAZE.LEVELS) continue;
    for (const k of neighbourhoodKeys(districtAtWorld(x, z, near), 1)) want.add(k);
  }
  return [...want].sort((a, b) => a - b);
}

/**
 * A maze world reduced to what the two finders read: real cells from the real
 * generator, and a resident set computed the way the streamer computes it.
 */
function mazeGame(seed, playerAt = [1260, 0.05, 60]) {
  const topo = generateTopology(seed, { levels: MAZE.LEVELS });
  const player = {
    position: new THREE.Vector3(...playerAt),
    teleports: [],
    _harnessFrozen: false,
    teleport(v, yaw) { this.position.copy(v); this.teleports.push([v.x, v.y, v.z, yaw]); },
  };
  return {
    THREE,
    CONFIG: { player: { eyeHeight: 1.62 } },
    engine: {
      camera: new THREE.PerspectiveCamera(75, 16 / 9, 0.1, 2000),
      scene: new THREE.Scene(),
      running: true,
      _paused: false,
      setPaused() {},
      onFrameUpdate: () => () => {},
      onFixedUpdate: () => () => {},
      stats: { fps: 60, frameMs: 16, frameMsMedian: 16, drawCalls: 0, triangles: 0, programs: 0 },
      renderer: { info: { render: { calls: 0, triangles: 0 } } },
    },
    player,
    worldManager: {
      active: {
        id: 'maze', seed, cells: topo.cells, group: new THREE.Group(),
        /* RECOMPUTED FROM THE PLAYER, every call - which is what the real
         * `MazeChunks.updateResidency` does. A fixed set would make the
         * end-to-end case below unfalsifiable: `_findLiftFraming` could
         * teleport the player and the stub would still report the old
         * districts, so the framing would fail for a reason the game does not
         * have. Residency follows the player; so does this. */
        chunks: {
          residentKeys: () => residentKeysAt(player.position.x, player.position.y, player.position.z),
        },
      },
    },
    __dev: { isGameplayDriven: () => true, setGameplayDriven: () => true, gameplayBlocks: () => [] },
  };
}

/** Seeds taken from the 64-seed sweep, not chosen: these are measured cases. */
const SEED_WITHOUT_RESIDENT_LIFT = 8;
const SEED_WITH_RESIDENT_LIFT = 1150358698;

test('the sweep this file is built on still holds: a seed with no resident lift exists', () => {
  /* The guard first. Every case below is worthless if the fixture seeds have
   * drifted - a topology change could make seed 8 grow a resident lift, and
   * then the "no lift" case would be testing nothing and passing. */
  const g = mazeGame(SEED_WITHOUT_RESIDENT_LIFT);
  const h = new Harness(g);
  assert.equal(h._findResidentShaft(null, 'lift'), null,
    `seed ${SEED_WITHOUT_RESIDENT_LIFT} was measured to have NO lift in its spawn-resident set; `
    + 'if it has one now the topology has changed and these fixtures need re-measuring');
  assert.ok(h._findResidentShaft(), 'and it must still have SOME resident shaft, or the fixture is wrong');

  const ok = new Harness(mazeGame(SEED_WITH_RESIDENT_LIFT));
  assert.ok(ok._findResidentShaft(null, 'lift'),
    `seed ${SEED_WITH_RESIDENT_LIFT} was measured to HAVE a resident lift`);
});

test('lift-car frames a lift on a seed that has none resident, instead of killing the run', async () => {
  const g = mazeGame(SEED_WITHOUT_RESIDENT_LIFT);
  const h = new Harness(g);

  /* What it used to do: nothing, and the null took `world-shot` down with it
   * before `report.json` was written. This is 46.9% of seeds. */
  assert.equal(h._findResidentShaft(null, 'lift'), null);

  /* Driven through the framing itself, not through its parts. A case that
   * called `_findAnyLift` and `_makeResident` directly would still pass with
   * `_findLiftFraming` reverted to `if (!lift) return null` - which is exactly
   * what happened the first time this was written. */
  const framing = await h._findLiftFraming();
  assert.ok(framing,
    'lift-car returned null on a seed with no resident lift - that is the failure that '
    + 'destroyed four other framings measurements to report this one');
  assert.ok(g.player.teleports.length >= 1,
    'and it can only have got there by moving the player: residency follows the player and nothing else');

  /* And it must have gone to a REAL lift, checked by what was emitted rather
   * than by what the topology chose - a tunnel whose fold would sever a
   * crossing falls back to a staircase. */
  const at = h._findResidentShaft(null, 'lift');
  assert.ok(at, 'after the move, a lift must actually be resident');
  assert.ok(shaftColliders(g.worldManager.active.cells, at.x, at.z, at.level).some((k) => k.kind === 'lift'));
  const w = cellToWorld(at.x, at.z, at.level);
  assert.ok(Math.hypot(framing.pos[0] - w.x, framing.pos[2] - w.z) < MAZE.CELL * 2,
    'the camera must stand at the lift it found, not at the one it was looking for');
});

test('a lift that IS resident is framed without moving the player at all', async () => {
  const g = mazeGame(SEED_WITH_RESIDENT_LIFT);
  const h = new Harness(g);
  const framing = await h._findLiftFraming();
  assert.ok(framing, 'this seed has a resident lift and must frame it');
  assert.equal(g.player.teleports.length, 0,
    'nothing may be teleported when the lift is already built - a framing that moves the player '
    + 'when it did not need to has changed the world it is measuring');
  assert.ok(Number.isFinite(framing.pos[0]) && Number.isFinite(framing.look[0]));
  const d = Math.hypot(framing.look[0] - framing.pos[0], framing.look[2] - framing.pos[2]);
  assert.ok(d > 0.5, 'the camera must aim somewhere other than itself');
});

test('the maze seed can be pinned, and is null for every player', () => {
  assert.equal(MazeWorld.seedOverride, null,
    'the override must default to null: a player who could learn the maze is the whole world defeated');
  const g = mazeGame(SEED_WITH_RESIDENT_LIFT);
  const h = new Harness(g);
  try {
    assert.deepEqual(h.mazeSeed(), { override: null, active: SEED_WITH_RESIDENT_LIFT, applied: null },
      'and it must report the seed actually in use even when nothing was pinned - '
      + 'a run that did not pin one still has to say which maze it photographed');
    h.mazeSeed(4242);
    assert.equal(MazeWorld.seedOverride, 4242);
    assert.equal(h.mazeSeed().override, 4242);
    h.mazeSeed(null);
    assert.equal(MazeWorld.seedOverride, null, 'and it must be releasable');
  } finally {
    MazeWorld.seedOverride = null;
  }
});

/* ═════════════════════════════════════════════════════════════════════════
 *  THE SEED THAT WAS PRINTED AND NEVER USED
 * ═════════════════════════════════════════════════════════════════════════
 *
 * `mazeSeed(n)` writes `MazeWorld.seedOverride`, and that decides the seed of
 * the NEXT `build()`. A volatile world's next build is its next ACTIVATION -
 * and `scripts/world-shot.mjs` wrote the override after boot had already built
 * the maze, then skipped its rebuild `goto` because the boot world was already
 * the world asked for, which it always is: the page URL carries
 * `world=${args.world}`.
 *
 * Measured on the shipped script: it printed "maze seed pinned to 20250823"
 * and then "maze seed in use: 4124197018", and 3030693222 on the next run of
 * the same commit. Every before/after of that world was a measurement of the
 * seed.
 *
 * ── WHY A BOUNCE AND NOT A REBUILD IN PLACE ──────────────────────────────
 * `WorldManager.build` regenerates a volatile world only when it is NOT the
 * active one, on purpose - rebuilding the live world generates into a scratch
 * physics world while the live collision world keeps serving the geometry that
 * was just discarded, which is invisible walls rather than missing ones. And
 * `activate` returns early when its target is already active. So the only way
 * to regenerate the live maze from the harness is to stop it being live: one
 * activation of another world, then `goto` back.
 *
 * The stub below models exactly those two rules and nothing else. That is
 * deliberate: a stub that simply rebuilt on demand would pass with
 * `pinMazeSeed` reverted to a plain setter, which is the version that shipped.
 */
function seedRig(firstSeed) {
  let nextSeed = firstSeed;
  const rolls = [];
  const instances = new Map();
  const built = new Set();
  const wm = {
    active: null,
    ids: ['maze', 'station'],
    isVolatile: (id) => id === 'maze',
    isBuilt: (id) => built.has(id),
    async build(id) {
      const world = instances.get(id) ?? { id, cells: null, chunks: { residentKeys: () => [] } };
      instances.set(id, world);
      /* WorldManager.build: a volatile world that is NOT active is disposed
       * and regenerated; one that IS active is served from cache. */
      if (built.has(id) && wm.isVolatile(id) && wm.active !== world) built.delete(id);
      if (built.has(id)) return world;
      if (id === 'maze') {
        world.seed = MazeWorld.seedOverride ?? (nextSeed = (nextSeed * 1664525 + 1013904223) >>> 0);
        rolls.push(world.seed);
      }
      built.add(id);
      return world;
    },
    async activate(id) {
      const world = await wm.build(id);
      if (wm.active === world) return world;   // WorldManager._activate's early return
      wm.active = world;
      return world;
    },
  };
  const game = {
    THREE,
    CONFIG: { player: { eyeHeight: 1.62 } },
    engine: {
      camera: new THREE.PerspectiveCamera(75, 16 / 9, 0.1, 2000),
      scene: new THREE.Scene(), running: true, _paused: false,
      setPaused() {}, onFrameUpdate: () => () => {}, onFixedUpdate: () => () => {},
      stats: { fps: 60, frameMs: 16, frameMsMedian: 16, drawCalls: 0, triangles: 0, programs: 0 },
      renderer: { info: { render: { calls: 0, triangles: 0 } } },
    },
    player: { position: new THREE.Vector3(), teleport() {}, _harnessFrozen: false },
    worldManager: wm,
    __dev: { isGameplayDriven: () => true, setGameplayDriven: () => true, gameplayBlocks: () => [] },
  };
  return { game, wm, rolls };
}

test('pinning a seed while the maze is LIVE rebuilds it, and the pin is in force', async () => {
  const { game, wm, rolls } = seedRig(7);
  const h = new Harness(game);
  try {
    await wm.activate('maze');
    const bootSeed = wm.active.seed;
    assert.ok(Number.isFinite(bootSeed), 'the boot build must have rolled a seed');

    /* What the shipped setter does on its own, and it is the whole defect:
     * the override is set and the live world is still the other maze. */
    h.mazeSeed(20250823);
    assert.equal(h.mazeSeed().active, bootSeed);
    assert.equal(h.mazeSeed().applied, false,
      'a written override over a live maze built from something else is NOT applied, and the '
      + 'report has to say so - this is the state world-shot used to print "pinned to N" over');

    const pin = await h.pinMazeSeed(20250823);
    assert.equal(pin.applied, true, 'pinMazeSeed must leave the pin actually in force');
    assert.equal(wm.active.seed, 20250823, 'and the LIVE world must be that maze');
    assert.equal(wm.active.id, 'maze', 'and it must hand the maze back, not the world it bounced through');
    assert.ok(pin.bouncedVia && pin.bouncedVia !== 'maze',
      'the rebuild can only have happened by leaving the maze first; say which world it used');
    assert.ok(rolls.length >= 2, 'the maze must have been generated a second time, not re-served from cache');
  } finally {
    MazeWorld.seedOverride = null;
  }
});

test('pinning a seed BEFORE the maze is live costs no rebuild at all', async () => {
  const { game, wm, rolls } = seedRig(11);
  const h = new Harness(game);
  try {
    await wm.activate('station');
    const pin = await h.pinMazeSeed(4242);
    assert.equal(pin.bouncedVia, null, 'nothing to rebuild: the maze has not been built yet');
    assert.equal(pin.applied, null, 'and there is nothing to compare against yet either');
    assert.equal(rolls.length, 0);

    await h.goto('maze');
    assert.equal(wm.active.seed, 4242, 'the first build must take the override');
    assert.equal(h.mazeSeed().applied, true);
  } finally {
    MazeWorld.seedOverride = null;
  }
});

test('a pin that cannot be applied throws rather than report a seed nobody used', async () => {
  /* The maze is live and there is no other world registered, so there is
   * nothing to bounce through and `WorldManager.build` will not regenerate the
   * live world. The one thing this must NOT do is return quietly. */
  const { game, wm } = seedRig(13);
  wm.ids = ['maze'];
  const h = new Harness(game);
  try {
    await wm.activate('maze');
    await assert.rejects(() => h.pinMazeSeed(31337), /cannot pin the maze seed/,
      'a half-pinned seed is worse than none: the caller has to be told');
    assert.notEqual(wm.active.seed, 31337);
  } finally {
    MazeWorld.seedOverride = null;
  }
});

/* ═════════════════════════════════════════════════════════════════════════
 *  AND THE FRAMING THAT `lift-car`'s OWN FIX BROKE
 * ═════════════════════════════════════════════════════════════════════════
 *
 * `tower-top` searched `_findResidentShaft(0)` and returned null when it found
 * nothing - the identical shape `lift-car` was fixed for, and it is the LAST
 * framing in `VIEWS.maze`, so every other framing was already measured when
 * the run died.
 *
 * Driven over 64 seeds against the real topology generator with the real
 * `RESIDENCY_RADIUS` neighbourhood, in the order `world-shot` takes the
 * framings (shaft-up, lift-car, tower-top):
 *
 *   no level-0 shaft resident at the COLD SPAWN            1 of 64  =  1.6%
 *   no level-0 shaft resident AFTER `lift-car` has run    10 of 64  = 15.6%
 *
 * The second number is caused by the first fix. `lift-car` now MAKES a lift
 * resident, the nearest lift is on level 1 or 2 for 23 of those 64 seeds, and
 * residency follows the player - so the level-0 districts stream out and there
 * is nothing left for `tower-top` to find.
 *
 * ── WHAT WAS REFUSED ─────────────────────────────────────────────────────
 * Dropping the level restriction makes it pass on every seed in one line, and
 * makes the framing photograph a DIFFERENT LEVEL'S canopy run to run. That is
 * the unpinned-seed defect wearing another hat: a framing whose meaning moves
 * is not a measurement. So it does what `lift-car` does instead - find the
 * nearest level-0 shaft in the whole topology, walk the player there, let
 * residency follow. Measured with that in place: 0 of the same 64 seeds fail.
 */
const SEED_WITHOUT_LEVEL0_RESIDENT = 5;
const SEED_WITH_LEVEL0_RESIDENT = 1;

test('the tower-top sweep this file is built on still holds', () => {
  /* The guard, for the same reason the lift sweep has one: a topology change
   * could grow seed 5 a level-0 shaft at the spawn, and then the case below
   * would be testing nothing and passing. */
  const bad = new Harness(mazeGame(SEED_WITHOUT_LEVEL0_RESIDENT));
  assert.equal(bad._findResidentShaft(0), null,
    `seed ${SEED_WITHOUT_LEVEL0_RESIDENT} was measured to have NO level-0 shaft in its spawn-resident `
    + 'set; if it has one now the topology has changed and these fixtures need re-measuring');
  assert.ok(bad._findResidentShaft(), 'and it must still have SOME resident shaft, or the fixture is wrong');
  assert.ok(bad._findAnyShaft(0), 'and a level-0 shaft must exist somewhere in the topology to walk to');

  const ok = new Harness(mazeGame(SEED_WITH_LEVEL0_RESIDENT));
  assert.ok(ok._findResidentShaft(0),
    `seed ${SEED_WITH_LEVEL0_RESIDENT} was measured to HAVE a level-0 shaft resident at the spawn`);
});

test('tower-top frames a level-0 shaft on a seed that has none resident, instead of killing the run', async () => {
  const g = mazeGame(SEED_WITHOUT_LEVEL0_RESIDENT);
  const h = new Harness(g);
  assert.equal(h._findResidentShaft(0), null);

  /* Driven through the framing itself. A case that called `_findAnyShaft` and
   * `_makeResident` directly would still pass with `_computeTowerTop` reverted
   * to `if (!shaft) return null` - which is the version that shipped. */
  const framing = await h._computeTowerTop();
  assert.ok(framing, 'tower-top returned null on a seed with no resident level-0 shaft - that is the '
    + 'failure that threw away five other framings measurements to report this one');
  assert.equal(framing.keepPlayer, true, 'this framing places the player itself; the vantage must not move them again');

  const at = h._findResidentShaft(0);
  assert.ok(at, 'after the move, a LEVEL-0 shaft must actually be resident');
  const w = cellToWorld(at.x, at.z, at.level);
  assert.ok(Math.hypot(framing.pos[0] - (w.x - 1.6), framing.pos[2] - (w.z - 1.6)) < 0.01,
    'the camera must stand over the shaft it found');
  /* And it must still be LEVEL 0 that it found: the framing looks down on the
   * landing one level up, and a framing that lands on a different level on a
   * different seed is a framing that means something new every run. */
  assert.equal(at.level, 0);
  assert.ok(Math.abs(framing.look[1] - MAZE.LEVEL_HEIGHT) < 1e-6,
    `the landing must be level 1 (y ${MAZE.LEVEL_HEIGHT}), not whatever level happened to be streamed`);
});

test('tower-top survives lift-car having walked the player up two levels', async () => {
  /* The 15.6% case, driven in the order `world-shot` actually takes them
   * rather than asserted on a fixture: shaft-up, then lift-car - which on this
   * seed teleports the player to a lift on level 2 - then tower-top. */
  const g = mazeGame(2);
  const h = new Harness(g);
  assert.ok(h._findResidentShaft(0), 'seed 2 starts with a level-0 shaft resident');

  const shaft = h._findShaftFraming();
  g.player.position.set(shaft.pos[0], shaft.pos[1], shaft.pos[2]);
  const lift = await h._findLiftFraming();
  assert.ok(lift);
  g.player.position.set(lift.pos[0], lift.pos[1], lift.pos[2]);
  assert.equal(Math.round(g.player.position.y / MAZE.LEVEL_HEIGHT), 2,
    'the fixture depends on lift-car having moved the player to level 2');
  assert.equal(h._findResidentShaft(0), null,
    'and that is what strands tower-top: no level-0 district is resident any more');

  const framing = await h._computeTowerTop();
  assert.ok(framing, 'tower-top must recover the ground floor rather than abort the run');
  assert.ok(h._findResidentShaft(0));
});

test('a level-0 shaft that IS resident is framed without a second teleport', async () => {
  const g = mazeGame(SEED_WITH_LEVEL0_RESIDENT);
  const h = new Harness(g);
  const framing = await h._computeTowerTop();
  assert.ok(framing);
  /* Exactly one: the move onto the landing that this framing has always made.
   * Two would mean `_makeResident` ran when it had no need to, which is a
   * framing that changed the world it is measuring. */
  assert.equal(g.player.teleports.length, 1,
    'nothing may be walked anywhere when a level-0 shaft is already built');
});

test('the same seed builds the same maze, and different seeds do not', () => {
  /* The property the whole before/after depends on, asserted on the topology
   * the world is generated from rather than on the world - which is what makes
   * this cheap enough to run every time. */
  const a = generateTopology(4242, { levels: MAZE.LEVELS });
  const b = generateTopology(4242, { levels: MAZE.LEVELS });
  assert.deepEqual([...a.cells], [...b.cells], 'one seed must give one maze');
  const c = generateTopology(4243, { levels: MAZE.LEVELS });
  assert.notDeepEqual([...a.cells], [...c.cells],
    'and two seeds must give two mazes, or pinning the seed is buying nothing');
});
