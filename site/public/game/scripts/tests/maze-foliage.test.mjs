import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MAZE, generateTopology } from '../../src/worlds/maze/MazeTopology.js';
import { districtColliders } from '../../src/worlds/maze/MazeColliders.js';
import { foliageTransforms, footingTransforms, FOOTING_HEIGHT } from '../../src/worlds/maze/MazeFoliage.js';

test('THE NON-COLLIDABLE GATE: foliage never reaches the collider path', () => {
  /* Section 2 permits props in the 0.45-5.0m band only if non-collidable, and
   * names foliage as the example. A sprig sits on top of a five-metre hedge -
   * squarely in the band - so if one ever became a descriptor it would be a
   * ladder over a hedge, and THE ANTI-LADDER GATE would be right to fail. */
  const { cells } = generateTopology(2026);
  for (let dz = 2; dz < 5; dz++) {
    for (let dx = 2; dx < 5; dx++) {
      for (const d of districtColliders(cells, dx, dz, 0)) {
        assert.notEqual(d.kind, 'foliage', `a foliage descriptor reached districtColliders at ${dx},${dz}`);
        assert.notEqual(d.kind, 'footing', `a footing descriptor reached districtColliders at ${dx},${dz}`);
      }
    }
  }
});

test('foliage grows on full-height hedges and nowhere else', () => {
  const { cells } = generateTopology(2026);
  const descs = districtColliders(cells, 3, 3, 0);
  const sprigs = foliageTransforms(descs, 33);
  assert.ok(sprigs.length > 200, `only ${sprigs.length} sprigs in a district - too sparse to break the top line`);

  /* Every sprig must sit at hedge-top height. One at floor level would be a
   * bush growing out of the path; one above the hedge would float.
   *
   * Those two failures are what this checks, as a BAND rather than as the
   * exact sink offset. The offset is an art value and has been retuned twice;
   * an equality against the current literal only ever restated the
   * implementation and went red on tuning while catching neither failure. */
  const top = MAZE.HEDGE_HEIGHT;
  for (const s of sprigs) {
    assert.ok(s.y <= top, `a sprig floats at y=${s.y}, above the ${top}m hedge top`);
    assert.ok(s.y > top - 0.5, `a sprig sits at y=${s.y}, adrift from the ${top}m hedge top`);
    assert.ok(s.s > 0.2 && s.s < 1.5, `implausible sprig scale ${s.s}`);
  }
});

test('a guard rail does not sprout foliage', () => {
  /* Stairwell rails are `hedge`-kinded too, and are waist-high furniture
   * rather than shrubbery - a rail with a bush on it reads as a bug. */
  const rail = { cx: 0, cy: 2.5, cz: 0, hx: 0.2, hy: MAZE.HEDGE_HEIGHT / 2, hz: 1.5, kind: 'hedge' };
  const half = { ...rail, hy: 0.6 };
  assert.ok(foliageTransforms([rail], 1).length > 0, 'a full-height hedge grew nothing');
  assert.equal(foliageTransforms([half], 1).length, 0, 'a half-height rail grew foliage');
});

test('foliage is deterministic, and differs between districts', () => {
  const { cells } = generateTopology(7);
  const descs = districtColliders(cells, 2, 2, 0);
  assert.deepEqual(foliageTransforms(descs, 5), foliageTransforms(descs, 5));
  assert.notDeepEqual(foliageTransforms(descs, 5), foliageTransforms(descs, 6),
    'two districts with the same hedge layout grew identical foliage');
});

test('the stone footing is under the auto-step, so what looks walkable is walkable', () => {
  /* It is mesh-only and matches the hedge footprint exactly, so it registers
   * no colliders - but it must still not LOOK like a step the player could
   * stand on, or the visual and the collision would disagree. */
  assert.ok(FOOTING_HEIGHT <= MAZE.STEP_HEIGHT,
    `a ${FOOTING_HEIGHT}m footing against a ${MAZE.STEP_HEIGHT}m auto-step reads as a step that is not there`);
  const { cells } = generateTopology(2026);
  const footings = footingTransforms(districtColliders(cells, 3, 3, 0));
  assert.ok(footings.length > 40, `only ${footings.length} footings in a district`);
  for (const f of footings) {
    const top = f.y + f.hy;
    assert.ok(top <= MAZE.STEP_HEIGHT + 1e-6, `a footing tops out at ${top.toFixed(3)}m`);
  }
});
