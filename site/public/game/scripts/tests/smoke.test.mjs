import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Physics } from '../../src/physics/Physics.js';

/* This project has no test framework by design: most of it touches document,
 * canvas or WebGL at module scope and cannot be imported under Node. Physics is
 * the exception - it imports only `three` and uses no DOM API - and the maze
 * spec requires MazeTopology to be pure for the same reason. This smoke test
 * pins that property, so if someone later adds a DOM import to Physics the
 * whole headless test tier fails loudly here rather than mysteriously
 * everywhere. */
test('Physics is importable and usable under Node', () => {
  const p = new Physics(null);
  p.addBox(0, 0, 0, 1, 1, 1);
  assert.equal(p.colliders.length, 1);
});
