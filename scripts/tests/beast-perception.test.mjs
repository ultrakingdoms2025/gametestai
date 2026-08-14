/**
 * WHAT A BEAST NOTICES, AND WHAT IT LEAVES BEHIND.
 *
 * ── Why these two things are in one file ──────────────────────────────────
 * Both were found by playing the game and neither could have been found by
 * reading it, and they fail in the same shape: a system that works perfectly
 * and is never reached.
 *
 *   - a bear with a 26 m sight radius that in practice acquires at 4.3 m,
 *     because sight is a cone off the body's facing and the cone was 160
 *     degrees wide - so the thing that actually noticed you was its nose;
 *   - a claw decal that raycasts 4 m for a world collider to stamp itself on,
 *     in a forest where the trees carry no colliders, so a full maul in the
 *     open marked nothing at all.
 *
 * Both were invisible to the existing beast suites for the same reason: those
 * suites drive the parts (`_canSee`, `strikeHits`, `BeastPack.share`) with the
 * inputs that make them work. Nothing asked what happens when a real animal
 * stands in a real place.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';

import { NPCManager } from '../../src/npc/NPCManager.js';
import { BEASTS } from '../../src/npc/BeastSpecies.js';
import { BeastPack } from '../../src/npc/BeastPack.js';
import { CombatSystem } from '../../src/systems/Combat.js';
import { DECAL } from '../../src/systems/DecalPool.js';

/* ------------------------------------------------------------------ */
/* Harness                                                             */
/* ------------------------------------------------------------------ */

/** An infinite floor at y = 0 and nothing else - the same one the other beast suites use. */
const flatWorld = () => ({
  groundHeight: () => 0,
  resolveCapsule: (p) => {
    if (p.y < 0) p.y = 0;
    return { grounded: p.y <= 0.001, groundNormal: new THREE.Vector3(0, 1, 0) };
  },
  raycast: (origin, dir, maxDistance) => {
    if (dir.y > -0.5 || origin.y < 0) return null;     // only the floor exists
    const d = origin.y / -dir.y;
    if (d > maxDistance) return null;
    return {
      distance: d,
      point: new THREE.Vector3(origin.x + dir.x * d, 0, origin.z + dir.z * d),
      normal: new THREE.Vector3(0, 1, 0),
      collider: { userData: {} },
    };
  },
  containsPoint: () => false,
});

/**
 * The real `NPCManager` with only the renderer-bound parts left out.
 * `Object.create` rather than `new`, exactly as `beast-combat.test.mjs` does it.
 */
function makeManager(player, seedCounter = 1) {
  const mgr = Object.create(NPCManager.prototype);
  Object.assign(mgr, {
    scene: new THREE.Scene(),
    engine: null,
    physics: flatWorld(),
    bus: { on: () => () => {}, emit: () => {} },
    materials: null,
    player,
    _npcs: [], _hostiles: [], _friendlies: [], _vendors: [], _respawnQueue: [],
    theme: 'medieval', worldId: 'medieval', maxNPCs: 72, water: null,
    _seedCounter: seedCounter, _groundCursor: 0, _simStep: 0, _pauseUntil: 0,
    _coverToken: 0, _groundFixes: 0, _contact: null, _chatNPC: null,
  });
  return mgr;
}

const stubPlayer = () => ({
  position: new THREE.Vector3(0, 0, 0),
  isDead: false,
  health: 100,
  maxHealth: 100,
  applyDamage: (a) => a,
  applyImpulse() {},
  applyViewKick() {},
  applyBleed() {},
});

/* ------------------------------------------------------------------ */
/* 1. The bear notices you                                             */
/* ------------------------------------------------------------------ */

/**
 * Spawn one bear `dist` metres from a stationary player on the given bearing
 * and let it think for ten seconds.
 * @returns {number} the frame it acquired on, or -1
 */
function noticesIn(dist, bearing, seedCounter) {
  const player = stubPlayer();
  const mgr = makeManager(player, seedCounter);
  const pos = new THREE.Vector3(Math.cos(bearing) * dist, 0, Math.sin(bearing) * dist);
  const [bear] = mgr.spawnBeastGroup({ position: pos, species: 'bear', count: 1 });
  assert.ok(bear, 'no bear spawned');
  for (let f = 0; f < 600; f++) {
    bear.fixedUpdate(1 / 60);
    if (bear.target) return f;
  }
  return -1;
}

test('a bear in the open notices a player well inside its sight radius', () => {
  /* THE DEFECT, as a number.
   *
   * `sight` is 26 m. Measured in play, a bear at 17-19 m in the open with clear
   * line of sight stayed in ROAM for 600 frames and drifted away; it acquired
   * at 4.3 m, which is inside the 11 m `scent` radius - so it was smelling the
   * player, not seeing them. A bear in woodland was therefore not a threat
   * until you were almost touching it.
   *
   * The cause is `fovDegrees`. It is the FULL cone, so 160 left a 200 degree
   * blind arc, and in ROAM the body faces wherever the last wander leg pointed.
   * Twenty-four starting bearings, stationary player, ten seconds each: it
   * noticed in 17 of them.
   *
   * Held as a rate over bearings rather than as a single case, because a single
   * case passes or fails on which way the animal happened to be standing -
   * which is the whole bug. */
  const N = 24;
  let seen = 0;
  const missed = [];
  for (let i = 0; i < N; i++) {
    const f = noticesIn(18, (i / N) * Math.PI * 2, i * 7 + 1);
    if (f >= 0) seen++;
    else missed.push(Math.round((i / N) * 360));
  }
  assert.ok(seen >= N - 1,
    `a bear 18 m away in the open noticed a stationary player from only ${seen} of `
    + `${N} starting bearings - blind from ${missed.join(', ')} degrees`);
});

test('the bear keeps a blind spot behind it, so stalking one still works', () => {
  /* The other half of the same design, and the reason the cone was not simply
   * removed: a predator with no blind arc cannot be approached, and `scent` is
   * what is supposed to end the approach, not eyesight. */
  assert.ok(BEASTS.bear.fovDegrees < 360, 'the bear sees in every direction at once');
  assert.ok(BEASTS.bear.fovDegrees >= 200,
    'the bear is back to a forward cone narrower than half the horizon');
  // And the nose still reaches further round than the eyes ever will.
  assert.ok(BEASTS.bear.scent > 0);
  assert.ok(BEASTS.bear.sight < BEASTS.wolf.sight, 'a bear is meant to see less far than a wolf');
});

/* ------------------------------------------------------------------ */
/* 2. A maul leaves a mark                                             */
/* ------------------------------------------------------------------ */

/** Just enough `CombatSystem` to call `_clawDecalBehind`. */
function decalHarness(worldHit) {
  const spawned = [];
  const combat = Object.create(CombatSystem.prototype);
  combat.physics = {
    raycast: () => worldHit,
    groundHeight: (x, z, startY, maxDrop) => (startY - maxDrop <= 0 ? 0 : null),
  };
  combat.decals = {
    spawn: (point, normal, size, cell, life) => {
      spawned.push({ point: point.clone(), normal: normal.clone(), size, cell, life });
    },
  };
  return { combat, spawned };
}

test('a maul on open ground with nothing to rake still leaves a mark', () => {
  /* THE DEFECT. `_clawDecalBehind` cast 4 m along the blow for a
   * `COLLISION_LAYER.WORLD` collider and returned silently when there was
   * none. Deep woodland has none - the trees are instanced and carry no
   * colliders, and twenty-four bearings probed around a bear out to 8 m found
   * nothing to hit. Three full mauls stamped zero decals while the blood, the
   * view kick, the knockback and the bleed all fired correctly. */
  const { combat, spawned } = decalHarness(null);
  combat._clawDecalBehind(new THREE.Vector3(4, 1.2, -7), new THREE.Vector3(0, 0, -1));
  assert.equal(spawned.length, 1, 'a maul in the open marked nothing');
  const d = spawned[0];
  assert.equal(d.cell, DECAL.CLAW);
  // On the ground, flat, and BEYOND the victim - a rake ends up past whatever
  // it went through, which is where a real one would be.
  assert.ok(Math.abs(d.normal.y - 1) < 1e-9, 'the mark is not lying on the floor');
  assert.ok(Math.abs(d.point.y) < 0.2, `the mark is ${d.point.y.toFixed(2)} m off the ground`);
  assert.ok(d.point.z < -7, 'the mark is on the near side of the victim');
  assert.ok(d.size > 0 && d.life > 0);
});

test('a wall behind the victim still takes the mark, and takes it first', () => {
  /* The fallback must not have replaced the original behaviour: a rake against
   * a wall belongs on the wall, at the wall's own angle. */
  const hit = {
    point: new THREE.Vector3(0, 1.4, -3),
    normal: new THREE.Vector3(0, 0, 1),
  };
  const { combat, spawned } = decalHarness(hit);
  combat._clawDecalBehind(new THREE.Vector3(0, 0, 0), new THREE.Vector3(0, 0, -1));
  assert.equal(spawned.length, 1);
  assert.equal(spawned[0].point.y, 1.4, 'the mark fell to the floor instead of staying on the wall');
  assert.equal(spawned[0].normal.z, 1);
});

test('the ground probe does not stamp the mark under the bridge you are standing on', () => {
  /* The one way a floor fallback can be wrong. The drop is deliberately short,
   * so a fight on a bridge deck marks the deck or marks nothing - never the
   * riverbed six metres below. */
  const { combat, spawned } = decalHarness(null);
  // A floor that only exists a long way down.
  combat.physics.groundHeight = (x, z, startY, maxDrop) => (startY - maxDrop <= -20 ? -20 : null);
  combat._clawDecalBehind(new THREE.Vector3(0, 3, 0), new THREE.Vector3(1, 0, 0));
  assert.equal(spawned.length, 0, 'the claw mark was stamped on the ground under the bridge');
});

/* ------------------------------------------------------------------ */
/* 3. A pack behaves like a pack                                       */
/* ------------------------------------------------------------------ */

test('a wolf pack holds five distinct bearings rather than converging on one point', () => {
  /* An earlier validation pass could not confirm this because the pack killed
   * the player before the data was captured, which is a fair result for the
   * combat design and a useless one for the claim. It is countable without a
   * renderer and without surviving the fight.
   *
   * The claim being held: five wolves attacking one target hold five SEPARATE
   * approach bearings that stay separated as the ring turns. Five identical
   * chargers would all sit on the same bearing - the direct line - and the
   * pack would read as a queue. */
  const pack = new BeastPack({ species: 'wolf', seed: 7 });
  const wolves = [];
  for (let i = 0; i < 5; i++) {
    const w = { position: { x: 0, y: 0, z: 0 }, isDead: false, adoptPackTarget: () => true };
    pack.add(w);
    wolves.push(w);
  }
  const spread = () => {
    const a = wolves.map((w) => ((pack.slotAngle(w) % (Math.PI * 2)) + Math.PI * 2) % (Math.PI * 2));
    a.sort((x, y) => x - y);
    let worst = Infinity;
    for (let i = 0; i < a.length; i++) {
      const gap = i === 0 ? a[0] + Math.PI * 2 - a[a.length - 1] : a[i] - a[i - 1];
      if (gap < worst) worst = gap;
    }
    return { angles: a, worst };
  };

  const s0 = spread();
  assert.equal(new Set(s0.angles.map((v) => v.toFixed(4))).size, 5,
    'two wolves are holding the same bearing');
  /* Evenly, not merely distinctly: five bearings round a circle is 72 degrees
   * apart, and anything much under that is a clump with an outlier. */
  assert.ok(s0.worst > 1.0,
    `the closest two wolves are only ${(s0.worst * 57.3).toFixed(0)} degrees apart`);

  // And it stays true while the ring turns, which is what stops it being a
  // static formation that happens to be evenly spaced at t = 0.
  for (let f = 0; f < 240; f++) {
    pack.update(1 / 60);
    const s = spread();
    assert.ok(s.worst > 1.0, `the ring collapsed after ${f} frames`);
  }

  /* Killing one closes the circle instead of leaving a hole in it - four
   * wolves must re-spread to 90 degrees, not hold four of the old five. */
  wolves[2].isDead = true;
  const s1 = spread();
  const live = wolves.filter((w) => !w.isDead);
  const liveAngles = live.map((w) => pack.slotAngle(w));
  assert.equal(new Set(liveAngles.map((v) => v.toFixed(4))).size, 4);
  void s1;
  const gaps = [];
  const sorted = liveAngles.map((v) => ((v % (Math.PI * 2)) + Math.PI * 2) % (Math.PI * 2)).sort((a, b) => a - b);
  for (let i = 0; i < sorted.length; i++) {
    gaps.push(i === 0 ? sorted[0] + Math.PI * 2 - sorted[sorted.length - 1] : sorted[i] - sorted[i - 1]);
  }
  assert.ok(Math.min(...gaps) > 1.3,
    `after a death the survivors sit ${(Math.min(...gaps) * 57.3).toFixed(0)} degrees apart `
    + 'rather than re-spreading round the ring');
});

test('a pack member that is told about a target takes a bearing, not the direct line', () => {
  /* The end-to-end version: real wolves, real manager, one of them acquires and
   * the rest are told. What must NOT happen is five animals all steering at the
   * same point. `_stalk` reads `pack.slotAngle`, so distinct slots are what
   * make distinct approaches, and this holds that the wiring is intact. */
  const player = stubPlayer();
  const mgr = makeManager(player, 3);
  const wolves = mgr.spawnBeastGroup(
    { position: new THREE.Vector3(0, 0, 22), species: 'wolf', count: 5 }
  );
  assert.ok(wolves.length >= 3, `only ${wolves.length} wolves spawned`);
  const pack = wolves[0].pack;
  assert.ok(pack, 'the wolves are not in a pack');
  for (let f = 0; f < 240; f++) for (const w of wolves) w.fixedUpdate(1 / 60);
  assert.ok(wolves.every((w) => w.target === player), 'word did not travel round the pack');
  const angles = wolves.map((w) => ((pack.slotAngle(w) % (Math.PI * 2)) + Math.PI * 2) % (Math.PI * 2));
  assert.equal(new Set(angles.map((v) => v.toFixed(4))).size, wolves.length,
    'the whole pack is approaching on one bearing');
  // Their actual positions have to have separated too, or the bearings are
  // bookkeeping that the steering ignores.
  let closest = Infinity;
  for (let i = 0; i < wolves.length; i++) {
    for (let j = i + 1; j < wolves.length; j++) {
      const d = wolves[i].position.distanceTo(wolves[j].position);
      if (d < closest) closest = d;
    }
  }
  assert.ok(closest > wolves[0].def.bodyRadius * 2,
    `two wolves are ${closest.toFixed(2)} m apart - they are standing on each other`);
});
