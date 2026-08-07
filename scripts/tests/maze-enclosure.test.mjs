import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { Physics } from '../../src/physics/Physics.js';
import { MAZE } from '../../src/worlds/maze/MazeTopology.js';
import { isEnclosureSound } from '../../src/worlds/maze/MazeColliders.js';

const RADIUS = 0.35, HEIGHT = 1.75, SPRINT = 8.2, HOP = 0.93, STEP = 1 / 60;

/**
 * Drive a capsule around inside a set of colliders and report the highest it
 * ever gets outside the shaft footprint. This is the proof that an `enclosed`
 * exemption is honest: steps may exist in the hop band only if a player using
 * them cannot arrive on top of a hedge.
 */
function escapeHeight(descs, shaft) {
  const p = new Physics(null);
  for (const d of descs) p.addBox(d.cx, d.cy, d.cz, d.hx, d.hy, d.hz);
  const pos = new THREE.Vector3();
  let highestOutside = -Infinity;
  for (let a = 0; a < 32; a++) {
    const ang = (a / 32) * Math.PI * 2;
    pos.set(shaft.cx, shaft.floorY + 0.05, shaft.cz);
    const vx = Math.cos(ang) * SPRINT, vz = Math.sin(ang) * SPRINT;
    // Starting on the shaft floor counts as grounded for the very first hop.
    let grounded = true;
    for (let s = 0; s < 200; s++) {
      pos.x += vx * STEP; pos.z += vz * STEP;
      // Only hop when the previous resolve left the capsule grounded - a real
      // player cannot chain a second hop while still airborne from the first.
      // `Physics` applies no gravity of its own (that lives in the caller's
      // game loop), so hopping unconditionally every 20 steps regardless of
      // ground contact lets height accumulate without bound, eventually
      // floating the capsule above *any* finite wall - including a genuinely
      // sealed one - and gliding it out above hedge height. That is an
      // artifact of this synthetic sweep, not a real exploit, so it is gated
      // out here rather than left to produce a false failure on a sound shaft.
      if (s % 20 === 0 && grounded) pos.y += HOP;   // try to hop out on the way
      const res = p.resolveCapsule(pos, RADIUS, HEIGHT);
      grounded = res.grounded;
      const outside = Math.abs(pos.x - shaft.cx) > MAZE.CELL / 2
                   || Math.abs(pos.z - shaft.cz) > MAZE.CELL / 2;
      if (outside) highestOutside = Math.max(highestOutside, pos.y - shaft.floorY);
    }
  }
  return highestOutside;
}

test('a sealed shaft is sound', () => {
  // Four full-height walls around one cell, with a step ladder inside.
  const c = MAZE.CELL, H = MAZE.HEDGE_HEIGHT;
  const descs = [
    { cx: 0, cy: -0.5, cz: 0, hx: c, hy: 0.5, hz: c, kind: 'floor' },
    { cx: -c / 2, cy: H / 2, cz: 0, hx: 0.6, hy: H / 2, hz: c / 2, kind: 'hedge' },
    { cx: c / 2, cy: H / 2, cz: 0, hx: 0.6, hy: H / 2, hz: c / 2, kind: 'hedge' },
    { cx: 0, cy: H / 2, cz: -c / 2, hx: c / 2, hy: H / 2, hz: 0.6, kind: 'hedge' },
    { cx: 0, cy: H / 2, cz: c / 2, hx: c / 2, hy: H / 2, hz: 0.6, kind: 'hedge' },
  ];
  for (let i = 0; i < 8; i++) {
    descs.push({ cx: -1 + i * 0.3, cy: (i + 1) * 0.25, cz: 0, hx: 0.8, hy: (i + 1) * 0.25, hz: 0.8, kind: 'stair', enclosed: true });
  }
  assert.ok(escapeHeight(descs, { cx: 0, cz: 0, floorY: 0 }) < MAZE.HEDGE_HEIGHT,
    'a capsule escaped a sealed shaft above hedge height');
  assert.equal(isEnclosureSound(descs, { cx: 0, cz: 0, floorY: 0 }), true);
});

test('a shaft with a missing wall is NOT sound', () => {
  const c = MAZE.CELL, H = MAZE.HEDGE_HEIGHT;
  const descs = [
    { cx: 0, cy: -0.5, cz: 0, hx: c * 3, hy: 0.5, hz: c * 3, kind: 'floor' },
    { cx: -c / 2, cy: H / 2, cz: 0, hx: 0.6, hy: H / 2, hz: c / 2, kind: 'hedge' },
    { cx: 0, cy: H / 2, cz: -c / 2, hx: c / 2, hy: H / 2, hz: 0.6, kind: 'hedge' },
    { cx: 0, cy: H / 2, cz: c / 2, hx: c / 2, hy: H / 2, hz: 0.6, kind: 'hedge' },
    // east wall missing
  ];
  for (let i = 0; i < 8; i++) {
    descs.push({ cx: -1 + i * 0.3, cy: (i + 1) * 0.25, cz: 0, hx: 0.8, hy: (i + 1) * 0.25, hz: 0.8, kind: 'stair', enclosed: true });
  }
  assert.equal(isEnclosureSound(descs, { cx: 0, cz: 0, floorY: 0 }), false,
    'an open-sided shaft was reported sound');
});
