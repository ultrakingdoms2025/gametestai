import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MAZE, generateTopology } from '../../src/worlds/maze/MazeTopology.js';
import { districtColliders, forecourtColliders, cellToWorld } from '../../src/worlds/maze/MazeColliders.js';
import { CHUNK_MESH_KINDS } from '../../src/worlds/maze/MazeChunks.js';

/**
 * The bug this file exists to make impossible to repeat: `districtColliders`
 * grew a third descriptor `kind` ('stair') for the ~617 spiral staircases
 * that connect the maze's four levels, but `MazeChunks` only ever built
 * meshes for `['hedge', 'floor']`. Every stair tread got a physics collider
 * - solid, walkable, correct - and NO mesh at all: ~14,800 invisible treads.
 * Every one of the project's other maze tests passed throughout, because
 * every one of them asserts on colliders, and nothing asked whether emitted
 * geometry is actually drawn.
 *
 * This is that missing question, asked in general form: whatever set of
 * `kind`s the collider descriptors actually emit must be a subset of the set
 * of `kind`s `MazeChunks` renders. Both sides are DERIVED, not hand-typed -
 * the emitted side by running real generation and collecting every `kind`
 * that comes out, the rendered side by importing `CHUNK_MESH_KINDS`, the
 * exact array `MazeChunks.ensure` iterates to decide what gets a mesh. A
 * future descriptor kind nobody wired up a mesh for fails this immediately,
 * whether or not anyone remembers to write a kind-specific test for it - see
 * `CHUNK_MESH_KINDS`'s own doc comment in MazeChunks.js.
 */

/** Every `kind` districtColliders emits, scanning the WHOLE grid on every
 * level so a kind that only ever appears inside a shaft (rare - only ~617
 * of them exist) is not missed by an under-sized sample window. Same
 * scan-the-whole-grid discipline as the enclosure gate in
 * maze-enclosure.test.mjs, and the same reasoning: a narrow window is a
 * tripwire something can land outside of. */
function emittedDistrictKinds(seed) {
  const t = generateTopology(seed, { levels: MAZE.LEVELS });
  const kinds = new Set();
  for (let level = 0; level < MAZE.LEVELS; level++) {
    for (let dz = 0; dz < MAZE.DISTRICTS; dz++) {
      for (let dx = 0; dx < MAZE.DISTRICTS; dx++) {
        for (const d of districtColliders(t.cells, dx, dz, level)) kinds.add(d.kind);
      }
    }
  }
  return kinds;
}

test('every kind districtColliders emits is one MazeChunks renders', () => {
  const kinds = emittedDistrictKinds(11);
  assert.ok(kinds.size > 0, 'no descriptors emitted at all - scan produced nothing to check');
  // 'stair' specifically must have been seen, or this run got unlucky and the
  // scan window did not actually exercise the shaft path - see the comment
  // above on why the window is the whole grid.
  assert.ok(kinds.has('stair'), "expected real generation to emit 'stair' descriptors somewhere in the grid");

  const rendered = new Set(CHUNK_MESH_KINDS);
  for (const kind of kinds) {
    assert.ok(rendered.has(kind),
      `districtColliders emits kind '${kind}' but MazeChunks.CHUNK_MESH_KINDS does not render it - ` +
      'this is the invisible-stairs bug class: a collider with no mesh.');
  }
});

test('every kind forecourtColliders emits is one MazeChunks renders', () => {
  const w = cellToWorld(10, 0, 0);
  const rendered = new Set(CHUNK_MESH_KINDS);
  // Forecourt geometry is authored, not carved, but check across every level
  // MazeWorld could plausibly hand it - same "derive, don't assume" spirit.
  for (let level = 0; level < MAZE.LEVELS; level++) {
    const kinds = new Set(forecourtColliders(w.x, level).map((d) => d.kind));
    assert.ok(kinds.size > 0, `forecourtColliders(level=${level}) emitted nothing to check`);
    for (const kind of kinds) {
      assert.ok(rendered.has(kind),
        `forecourtColliders emits kind '${kind}' at level ${level} but MazeChunks.CHUNK_MESH_KINDS ` +
        'does not render it');
    }
  }
});
