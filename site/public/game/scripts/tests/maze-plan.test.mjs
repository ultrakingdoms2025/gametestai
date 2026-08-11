import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MAZE, DIR, generateTopology, cellIndex, isOpen } from '../../src/worlds/maze/MazeTopology.js';
import { planCacheKey, levelSegments } from '../../src/worlds/maze/MazePlan.js';

test('planCacheKey falls back to world.id for an ordinary world', () => {
  assert.equal(planCacheKey({ id: 'station' }), 'station');
});

test('THE RE-ROLL GATE: two seeds of the same world never share a plan cache key', () => {
  // The bug this whole task exists for: a volatile world cached on `id` alone
  // serves the PREVIOUS run's floorplan - a map of a maze that no longer
  // exists, which is worse than no map at all because a player trusts it.
  const a = { id: 'maze', minimapPlanKey: 'maze:1111:0' };
  const b = { id: 'maze', minimapPlanKey: 'maze:2222:0' };
  assert.notEqual(planCacheKey(a), planCacheKey(b));
});

test('and neither do two levels of the same seed', () => {
  const l0 = { id: 'maze', minimapPlanKey: 'maze:1111:0' };
  const l1 = { id: 'maze', minimapPlanKey: 'maze:1111:1' };
  assert.notEqual(planCacheKey(l0), planCacheKey(l1));
});

test('planCacheKey always returns something, for any shape of world', () => {
  for (const w of [null, undefined, {}, { id: null }]) {
    assert.equal(typeof planCacheKey(w), 'string', `no key for ${JSON.stringify(w)}`);
  }
});

test('levelSegments draws a wall wherever the topology has no passage', () => {
  const { cells } = generateTopology(4242);
  const segs = levelSegments(cells, 0);
  assert.ok(segs.length > 1000, `expected a dense level, got ${segs.length} segments`);
  /* Every segment must correspond to a CLOSED passage. A segment across an
   * open one would draw a wall that is not there, which is the worst possible
   * lie for a navigation aid - the player would route around a gap they could
   * have walked through. */
  let checked = 0;
  for (const s of segs) {
    const horizontal = s.z0 === s.z1;
    const x = Math.min(s.x0, s.x1), z = Math.min(s.z0, s.z1);
    if (x >= MAZE.CELLS || z >= MAZE.CELLS) continue;      // the grid's far edges
    const dir = horizontal ? DIR.N : DIR.W;
    assert.equal(isOpen(cells, cellIndex(x, z, 0), dir), false,
      `a segment at ${x},${z} crosses an OPEN passage - the map would draw a wall that is not there`);
    checked++;
    if (checked >= 2000) break;
  }
  assert.ok(checked > 1000, `expected to verify many segments, checked ${checked}`);
});

test('levelSegments reads the level it is asked for', () => {
  const { cells } = generateTopology(4242);
  const a = levelSegments(cells, 0);
  const b = levelSegments(cells, 1);
  assert.notDeepEqual(a, b, 'two levels produced identical walls - the level argument is ignored');
});

test('a segment is never drawn across a passage the player can actually use', () => {
  /* The complement of the test above, and the one that would catch an
   * off-by-one in the ownership rule: for a sample of OPEN passages, assert no
   * emitted segment sits on that face. */
  const { cells } = generateTopology(77);
  const segs = levelSegments(cells, 0);
  const key = (a, b, c, d) => `${a},${b},${c},${d}`;
  const drawn = new Set(segs.map((s) => key(s.x0, s.z0, s.x1, s.z1)));
  let checked = 0;
  for (let z = 1; z < 60; z++) {
    for (let x = 1; x < 60; x++) {
      const idx = cellIndex(x, z, 0);
      if (isOpen(cells, idx, DIR.N)) {
        assert.ok(!drawn.has(key(x, z, x + 1, z)), `wall drawn across an open north passage at ${x},${z}`);
        checked++;
      }
      if (isOpen(cells, idx, DIR.W)) {
        assert.ok(!drawn.has(key(x, z, x, z + 1)), `wall drawn across an open west passage at ${x},${z}`);
        checked++;
      }
    }
  }
  assert.ok(checked > 200, `expected many open passages to check, found ${checked}`);
});
