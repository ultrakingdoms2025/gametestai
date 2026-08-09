import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MAZE } from '../../src/worlds/maze/MazeTopology.js';
import { MazeWorld } from '../../src/worlds/MazeWorld.js';

/* The pollen cloud is one box of motes that rides with the player and wraps,
 * rather than a field of them scattered through a 2.4 km world - see
 * `_buildPollen`'s docstring for why. Everything that can go wrong with it is
 * in the wrap, so that is what this file is about.
 *
 * Both methods are called for real, on a bare object rather than on a built
 * MazeWorld. They touch nothing but `this._pollen` and `this.group`, so a stub
 * with an `add` on it is the whole environment they need - no renderer, no
 * scene graph, no generated maze. Stubbing the pollen record instead and
 * re-typing the wrap into the test would have proved only that the test can do
 * arithmetic. */

/** The least a MazeWorld has to be for `_buildPollen` to run against it. */
const stubWorld = () => ({ group: { add() {} } });

/** Where `_stepPollen` anchors the cloud for a player standing at height `y`. */
const anchorY = (y) => Math.min(MAZE.LEVELS - 1, Math.max(0, Math.round(y / MAZE.LEVEL_HEIGHT)))
  * MAZE.LEVEL_HEIGHT;

function built() {
  const w = stubWorld();
  MazeWorld.prototype._buildPollen.call(w);
  return w;
}

const step = (w, dt, player) => MazeWorld.prototype._stepPollen.call(w, dt, player);

/** Highest |x| or |z|, and the y range, over every mote in the cloud. */
function extent(pos) {
  let lateral = 0, minY = Infinity, maxY = -Infinity;
  for (let i = 0; i < pos.length; i += 3) {
    lateral = Math.max(lateral, Math.abs(pos[i]), Math.abs(pos[i + 2]));
    minY = Math.min(minY, pos[i + 1]);
    maxY = Math.max(maxY, pos[i + 1]);
  }
  return { lateral, minY, maxY };
}

test('the cloud is built inside its own box, and falls', () => {
  const w = built();
  const { pos, drift } = w._pollen;
  assert.equal(pos.length, MazeWorld.POLLEN_COUNT * 3);
  const e = extent(pos);
  assert.ok(e.lateral <= MazeWorld.POLLEN_BOX / 2, `a mote starts ${e.lateral}m out, outside the box`);
  assert.ok(e.minY >= 0 && e.maxY <= MazeWorld.POLLEN_HEIGHT,
    `motes start between ${e.minY} and ${e.maxY}, outside the 0-${MazeWorld.POLLEN_HEIGHT}m band`);
  /* Pollen falls, and it does not fall like rain. If the vertical drift were
   * ever symmetric about zero the cloud would read as static dust, and if the
   * lateral wander vanished it would read as rain - both are the failure the
   * `_buildPollen` comment names. */
  for (let i = 0; i < drift.length; i += 3) {
    assert.ok(drift[i + 1] < 0, `a mote drifts upward at ${drift[i + 1]} m/s`);
    assert.ok(Math.abs(drift[i]) > 0 || Math.abs(drift[i + 2]) > 0, 'a mote has no lateral wander at all');
    assert.ok(Math.abs(drift[i]) < 1 && Math.abs(drift[i + 2]) < 1, 'a mote wanders faster than it falls');
  }
});

test('the cloud is taller than the hedges it drifts between', () => {
  /* Its own constant says "above hedge height, so motes read against the sky
   * on the top level" - a cloud shorter than the hedges is one the player only
   * ever sees the underside of, and never against anything bright. */
  assert.ok(MazeWorld.POLLEN_HEIGHT > MAZE.HEDGE_HEIGHT,
    `a ${MazeWorld.POLLEN_HEIGHT}m cloud in a world of ${MAZE.HEDGE_HEIGHT}m hedges never clears them`);
  /* And wider than a corridor, or the wrap seam would be inside the corridor
   * the player is standing in rather than out beyond the hedges. */
  assert.ok(MazeWorld.POLLEN_BOX > MAZE.CELL * 2, `a ${MazeWorld.POLLEN_BOX}m box is corridor-sized`);
});

test('THE WRAP INVARIANT: a teleport across the world still leaves every mote in the box', () => {
  /* The reason the wrap is a modulo and not a single shift, stated as a test.
   * The first frame of a run and every portal arrival move the anchor by
   * kilometres in one step; a shift-by-one-box correction moves each mote 26 m
   * of the 12,000 it is out by, so the cloud would sit a kilometre away for
   * several hundred frames - visible as the player arriving into an empty
   * world that slowly fills in.
   *
   * The naive alternative is computed alongside, from the same starting
   * positions, purely so this test fails if the modulo is ever "simplified"
   * into it: without that, an implementation that had gone back to a shift
   * would still pass everything except this one assertion. */
  const w = built();
  const { pos, drift } = w._pollen;
  const half = MazeWorld.POLLEN_BOX / 2;
  step(w, 1 / 60, { x: 0, y: 0, z: 0 });

  const beforeX = Float32Array.from(pos);
  const jump = { x: 12345.6, y: 27.0, z: -9876.5 };
  step(w, 1 / 60, jump);

  const e = extent(pos);
  assert.ok(e.lateral <= half + 1e-4,
    `after a ${jump.x}m jump a mote sits ${e.lateral.toFixed(1)}m from the player - outside the `
    + `${half}m box, which is what a single-shift correction leaves behind`);
  assert.ok(e.minY >= -1e-4 && e.maxY <= MazeWorld.POLLEN_HEIGHT + 1e-4,
    `after the jump motes span ${e.minY.toFixed(1)}..${e.maxY.toFixed(1)}m vertically`);

  // The same step, wrapped by one box instead of by a modulo.
  let worstNaive = 0;
  for (let i = 0; i < beforeX.length; i += 3) {
    let x = beforeX[i] - (jump.x - 0) + drift[i] * (1 / 60);
    if (x > half) x -= MazeWorld.POLLEN_BOX;
    else if (x < -half) x += MazeWorld.POLLEN_BOX;
    worstNaive = Math.max(worstNaive, Math.abs(x));
  }
  assert.ok(worstNaive > half * 100,
    'the single-shift alternative landed inside the box too, so this test is not actually '
    + 'distinguishing the two - pick a bigger jump');
});

test('the cloud stays in its box over a long walk, not just over one frame', () => {
  /* A wrap that only ever runs once per mote would pass the teleport test
   * above and still drain the cloud: the drift is downward and lateral, so
   * over ten seconds every mote crosses at least the floor of the box, and
   * anything that does not come back at the top is gone for the rest of the
   * run. Walked rather than teleported, so this is the ordinary case. */
  const w = built();
  const player = { x: 0, y: 0, z: 0 };
  for (let f = 0; f < 600; f++) {
    player.x += 5.0 / 60;
    player.z += 2.0 / 60;
    step(w, 1 / 60, player);
    const e = extent(w._pollen.pos);
    assert.ok(e.lateral <= MazeWorld.POLLEN_BOX / 2 + 1e-4,
      `frame ${f}: a mote is ${e.lateral.toFixed(2)}m out`);
    assert.ok(e.minY >= -1e-4 && e.maxY <= MazeWorld.POLLEN_HEIGHT + 1e-4,
      `frame ${f}: motes span ${e.minY.toFixed(2)}..${e.maxY.toFixed(2)}m`);
  }
});

test('the cloud hangs on the player and on the floor they are standing on', () => {
  /* Motes are stored relative to the cloud object, so where that object is put
   * IS where the cloud is. It is put at the player's feet horizontally, but at
   * the level's floor vertically - a cloud anchored at the raw player y would
   * ride up and down the stairs with them, and one anchored at level 0 would
   * be four floors underground for a player on the top level. */
  const w = built();
  for (const y of [0, 4.4, 9.0, 13.5, 27.0, 99.0, -3.0]) {
    step(w, 1 / 60, { x: 12.5, y, z: -7.25 });
    assert.equal(w._pollen.pts.position.x, 12.5);
    assert.equal(w._pollen.pts.position.z, -7.25);
    assert.equal(w._pollen.pts.position.y, anchorY(y),
      `a player at y=${y} anchors the cloud at ${w._pollen.pts.position.y}, not on their own level`);
    // The anchor is also what the next frame subtracts out, so the two must
    // agree exactly or the cloud drifts away from the player a frame at a time.
    assert.equal(w._pollen.centre.y, w._pollen.pts.position.y);
  }
  // Never below the ground floor and never above the top one, whatever the
  // player's y does - a fall out of the world must not take the cloud with it.
  step(w, 1 / 60, { x: 0, y: -500, z: 0 });
  assert.equal(w._pollen.pts.position.y, 0);
  step(w, 1 / 60, { x: 0, y: 5000, z: 0 });
  assert.equal(w._pollen.pts.position.y, (MAZE.LEVELS - 1) * MAZE.LEVEL_HEIGHT);
});

test('a mote that has not wrapped stands still in the world while the player walks', () => {
  /* The point of subtracting the anchor's movement out. Without it every mote
   * is glued to the player and the cloud slides along as a swarm; with it the
   * motes stay where they are in the world and the player walks through them.
   * Checked in WORLD space - anchor plus local offset - because the local
   * offsets are supposed to change every frame; it is the sum that must not.
   * Drift is zeroed for the duration so the only thing that could move a mote
   * is the anchor bookkeeping this test is about. A mote that DID wrap has
   * moved by exactly one box, which is the whole box being seamless. */
  const w = built();
  w._pollen.drift.fill(0);
  const player = { x: 100, y: 0, z: -40 };
  step(w, 1 / 60, player);

  const { pos } = w._pollen;
  const worldBefore = [];
  for (let i = 0; i < pos.length; i += 3) {
    worldBefore.push([pos[i] + w._pollen.pts.position.x, pos[i + 2] + w._pollen.pts.position.z]);
  }

  player.x += 1.7;
  player.z -= 0.9;
  step(w, 1 / 60, player);

  const box = MazeWorld.POLLEN_BOX;
  let moved = 0, wrapped = 0;
  for (let i = 0, m = 0; i < pos.length; i += 3, m++) {
    const wx = pos[i] + w._pollen.pts.position.x;
    const wz = pos[i + 2] + w._pollen.pts.position.z;
    for (const [now, then] of [[wx, worldBefore[m][0]], [wz, worldBefore[m][1]]]) {
      const d = now - then;
      const boxes = Math.round(d / box);
      assert.ok(Math.abs(d - boxes * box) < 1e-2,
        `a mote moved ${d.toFixed(3)}m through the world while the player walked past it - `
        + 'the anchor\'s movement is not being cancelled out');
      if (boxes === 0) moved++; else wrapped++;
    }
  }
  assert.ok(moved > 0 && wrapped > 0,
    `expected some motes to stand still (${moved}) and some to wrap round the box (${wrapped}) - `
    + 'a run with no wraps in it never exercised the seam');
});
