import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as THREE from 'three';
import { Physics } from '../../src/physics/Physics.js';
import { MAZE, generateTopology } from '../../src/worlds/maze/MazeTopology.js';
import { MazeWorld } from '../../src/worlds/MazeWorld.js';

/**
 * THE SHARED DAILY MAZE, PROVEN AT THE ONLY POINT THAT MATTERS.
 *
 * `site/lib/dailySeed.test.ts` proves the server hands out one number per
 * (server, UTC day). This file proves the other half: that the number actually
 * decides the labyrinth, and that a number the server could not have meant is
 * refused rather than half-adopted.
 *
 * The failure mode both halves exist for is silent. A maze built from a
 * corrupted seed is a perfectly valid maze — walls, routes, a centre — so two
 * players on two different mazes each see something that works, and the only
 * symptom is a route description that does not match the floor. There is no
 * exception to catch and nothing to log. It has to be gated at the seed.
 *
 * The world is built for real, headlessly, the way `maze-entrance.test.mjs`
 * builds it. A source scrape would pass against a `build()` that had stopped
 * reading the override.
 */

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

/** Read a repo file with line endings normalised. This tree checks out CRLF. */
async function read(rel) {
  return (await readFile(path.join(ROOT, rel), 'utf8')).replace(/\r\n/g, '\n');
}

/** Build a MazeWorld headlessly. `update()` steers residency off the player. */
async function buildMaze() {
  const world = new MazeWorld({
    scene: new THREE.Scene(),
    engine: null,
    physics: new Physics(null),
    bus: null,
    materials: null,
    player: { position: new THREE.Vector3() },
  });
  await world.build(() => {});
  return world;
}

/* ---------------------------------------------------------------------- */
/* adoptDailySeed: what it takes, and everything it refuses                */
/* ---------------------------------------------------------------------- */

test('adopts a whole uint32 out of a session payload', () => {
  MazeWorld.seedOverride = null;
  try {
    assert.equal(MazeWorld.adoptDailySeed({ daily_seed: 3141592653 }), true);
    assert.equal(MazeWorld.seedOverride, 3141592653);
    /* The two ends of the range `build()` rolls for itself. */
    assert.equal(MazeWorld.adoptDailySeed({ daily_seed: 0 }), true);
    assert.equal(MazeWorld.seedOverride, 0);
    assert.equal(MazeWorld.adoptDailySeed({ daily_seed: 0xffffffff }), true);
    assert.equal(MazeWorld.seedOverride, 0xffffffff);
  } finally {
    MazeWorld.seedOverride = null;
  }
});

test('refuses anything that is not a seed, and LEAVES the override alone', () => {
  /* The second half is the point. A refusal that wrote `null` would be fine;
   * a refusal that wrote the bad value, or that cleared a good one already
   * adopted, would be the shared maze quietly becoming a private one. */
  for (const bad of [
    undefined, null, {}, { daily_seed: undefined }, { daily_seed: null },
    { daily_seed: '3141592653' },        // a string out of a JSON body
    { daily_seed: 1.5 },                 // a float
    { daily_seed: Number.NaN },
    { daily_seed: Infinity },
    { daily_seed: -1 },                  // below the range build() rolls
    { daily_seed: 0x100000000 },         // above it
    { daily_seed: true },
    { daily_seed: [1] },
  ]) {
    MazeWorld.seedOverride = 12345;
    try {
      assert.equal(
        MazeWorld.adoptDailySeed(bad), false,
        `adoptDailySeed accepted ${JSON.stringify(bad)}`,
      );
      assert.equal(
        MazeWorld.seedOverride, 12345,
        `a refused payload still moved the override: ${JSON.stringify(bad)}`,
      );
    } finally {
      MazeWorld.seedOverride = null;
    }
  }
});

test('a signed-out boot leaves the maze re-rolling exactly as it always did', () => {
  MazeWorld.seedOverride = null;
  assert.equal(MazeWorld.adoptDailySeed(null), false);
  assert.equal(MazeWorld.seedOverride, null,
    'a session that answered "nobody" pinned a seed anyway');
});

/* ---------------------------------------------------------------------- */
/* The seed really is the maze                                             */
/* ---------------------------------------------------------------------- */

test('one seed is one labyrinth: the generator is deterministic', () => {
  const a = generateTopology(0xa17e5eed, { levels: MAZE.LEVELS });
  const b = generateTopology(0xa17e5eed, { levels: MAZE.LEVELS });
  assert.deepEqual([...a.cells], [...b.cells],
    'two runs of the same seed produced two different mazes');
  assert.equal(a.entranceCell, b.entranceCell);
  assert.equal(a.centreCell, b.centreCell);

  const other = generateTopology(0xa17e5eee, { levels: MAZE.LEVELS });
  assert.notDeepEqual([...a.cells], [...other.cells],
    'two different seeds produced the same maze — the seed is not being used');
});

test('two players on one shared seed walk the same labyrinth', async () => {
  /* The feature, end to end and twice over: a `/api/game/session` payload goes
   * in, `adoptDailySeed` validates it, `build()` consumes it, and two separate
   * builds — which is what two members of a server each do, on their own
   * machines — lay out the same hedges.
   *
   * `world.cells` is compared rather than `generateTopology`'s output because
   * `build()` carves the entrance corridor into the topology afterwards, so the
   * generator's raw answer is not what a player walks. Comparing two real
   * builds is both the stronger claim and the one a player would notice. */
  const SEED = 0x5eed1234;
  MazeWorld.seedOverride = null;
  try {
    assert.equal(MazeWorld.adoptDailySeed({ daily_seed: SEED }), true);
    const mine = await buildMaze();
    assert.equal(mine.seed, SEED, 'build() did not take the adopted seed');

    /* The second player's client, which was handed the same number by the same
     * server and validated it independently. */
    assert.equal(MazeWorld.adoptDailySeed({ daily_seed: SEED }), true);
    const theirs = await buildMaze();
    assert.equal(theirs.seed, SEED);
    assert.deepEqual([...mine.cells], [...theirs.cells],
      'two clients on the same daily seed built two different mazes');
    assert.equal(mine.entranceCell, theirs.entranceCell);
    assert.equal(mine.centreCell, theirs.centreCell);

    /* And tomorrow's seed is a different maze, which is what keeps this world
     * unlearnable at the granularity that matters. */
    assert.equal(MazeWorld.adoptDailySeed({ daily_seed: SEED + 1 }), true);
    const tomorrow = await buildMaze();
    assert.notDeepEqual([...mine.cells], [...tomorrow.cells],
      'a different daily seed produced the same maze — the seed is not being used');

    mine.dispose?.();
    theirs.dispose?.();
    tomorrow.dispose?.();
  } finally {
    MazeWorld.seedOverride = null;
  }
});

test('the maze still re-rolls when no seed was adopted', async () => {
  /* The property this world was built on — "the maze that cannot be learned is
   * the entire point" — must survive the feature. Two builds with the override
   * null must not agree. Two 32-bit rolls colliding is a 1-in-4-billion event,
   * so a failure here means the random path was removed, not bad luck. */
  MazeWorld.seedOverride = null;
  const a = await buildMaze();
  const b = await buildMaze();
  assert.notEqual(a.seed, b.seed,
    'the maze stopped re-rolling for a player with no shared seed');
  a.dispose?.();
  b.dispose?.();
});

/* ---------------------------------------------------------------------- */
/* The contract with the server                                            */
/* ---------------------------------------------------------------------- */

test('the range adoptDailySeed accepts is the range build() rolls', async () => {
  /* Two literals in two files that have to agree, and nothing else ties them
   * together: `build()` rolls `(Math.random() * 0xffffffff) >>> 0` and
   * `adoptDailySeed` admits `0 .. 0xffffffff`. If the roll changed, a shared
   * seed would be a value the game never produces on its own. */
  const src = await read('src/worlds/MazeWorld.js');
  assert.match(src, /MazeWorld\.seedOverride \?\? \(\(Math\.random\(\) \* 0xffffffff\) >>> 0\)/,
    'build() no longer rolls a uint32 — adoptDailySeed\'s range is now a guess');
  assert.match(src, /raw < 0 \|\| raw > 0xffffffff/,
    'adoptDailySeed no longer bounds the seed to the range build() rolls');
});

test('the harness override still works, because it is the same field', async () => {
  /* `src/dev/Harness.js` and `scripts/world-shot.mjs --seed` write
   * `seedOverride` to photograph a fixed maze. The daily seed is a SECOND
   * writer of the same field, not a replacement, and a review instrument that
   * silently lost its fixed seed would make every Phase 9 comparison a
   * comparison of two unrelated worlds again. */
  const harness = await read('src/dev/Harness.js');
  assert.match(harness, /MazeWorld\.seedOverride\s*=/,
    'the dev harness no longer sets seedOverride');
});
