import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { CONFIG } from '../../src/core/Config.js';
import {
  segmentDistanceSq, capsulesOverlap, strikeTip, standingCapsule, strikeHits,
  STRIKE_ARC, STRIKE_DROP,
} from '../../src/npc/BeastMaul.js';
import { BeastNPC } from '../../src/npc/BeastNPC.js';
import { BEASTS } from '../../src/npc/BeastSpecies.js';

/**
 * The maul's contact volume.
 *
 * ── What this suite is for ────────────────────────────────────────────────
 * Every melee attack that existed before this one was a hitscan with a short
 * range (`NPCWeapons`: "an ordinary weapon with a 2.5 m reach", resolved by
 * `HostileNPC._fire` as a ray at the player's centre of mass). A ray from a
 * bear's chest to the player's navel connects whatever the player did, so the
 * only counterplay was to already be out of range. There was nothing to dodge.
 *
 * The whole justification for a bear hitting for 26 plus a bleed is that the
 * blow can MISS - so a test that only proves it can hit proves nothing. Every
 * case below comes in pairs: the player who stood there, and the player who
 * moved. If the miss half ever starts passing by accident, the balance argument
 * for the damage numbers has quietly stopped being true.
 */

const V = (x, y, z) => ({ x, y, z });
const PLAYER = { height: CONFIG.player.height, radius: CONFIG.player.radius };

/* ---------------------------------------------------------------- */
/* The primitive                                                     */
/* ---------------------------------------------------------------- */

test('segment distance handles the cases the closest-approach solve has to get right', () => {
  // Parallel, offset by 2 on x.
  assert.equal(segmentDistanceSq(V(0, 0, 0), V(0, 0, 4), V(2, 0, 0), V(2, 0, 4)), 4);
  // Crossing at right angles, one unit apart in y.
  assert.ok(Math.abs(segmentDistanceSq(V(-1, 0, 0), V(1, 0, 0), V(0, 1, -1), V(0, 1, 1)) - 1) < 1e-9);
  // Past each other end to end: the answer is between the near endpoints.
  assert.equal(segmentDistanceSq(V(0, 0, 0), V(0, 0, 1), V(0, 0, 4), V(0, 0, 5)), 9);
  // Both degenerate - two points.
  assert.equal(segmentDistanceSq(V(0, 0, 0), V(0, 0, 0), V(3, 4, 0), V(3, 4, 0)), 25);
  // One degenerate, projecting onto the middle of the other.
  assert.equal(segmentDistanceSq(V(0, 5, 0), V(0, 5, 0), V(-9, 0, 0), V(9, 0, 0)), 25);
});

test('capsule overlap is exactly the sum of the radii', () => {
  const a0 = V(0, 0, 0), a1 = V(0, 0, 1);
  const b0 = V(1, 0, 0), b1 = V(1, 0, 1);
  assert.equal(capsulesOverlap(a0, a1, 0.5, b0, b1, 0.49), false);
  assert.equal(capsulesOverlap(a0, a1, 0.5, b0, b1, 0.51), true);
});

test('the strike tip sweeps across the window and finishes on the far side', () => {
  const o = V(0, 1, 0);
  const out = V(0, 0, 0);
  // Yaw 0 is facing -Z, which is the game's convention everywhere.
  strikeTip(o, 0, 2, 0, 0.5, out);
  assert.ok(Math.abs(out.x) < 1e-9 && Math.abs(out.z + 2) < 1e-9,
    `a zero arc at mid-window should point straight ahead, got ${JSON.stringify(out)}`);
  // With an arc, the start and the end are on opposite sides of dead ahead.
  const start = { ...strikeTip(o, 0, 2, 1.0, 0, V(0, 0, 0)) };
  const end = { ...strikeTip(o, 0, 2, 1.0, 1, V(0, 0, 0)) };
  assert.ok(start.x * end.x < 0, 'the arc does not cross the centreline');
  // And it falls as it goes, because a paw comes down.
  const dropped = strikeTip(o, 0, 2, 0, 1, V(0, 0, 0), 0.5);
  assert.ok(Math.abs(dropped.y - 0.5) < 1e-9);
});

test('a standing capsule spans the body and never inverts', () => {
  const a = V(0, 0, 0), b = V(0, 0, 0);
  standingCapsule(V(0, 10, 0), 1.75, 0.35, a, b);
  assert.equal(a.y, 10.35);
  assert.ok(b.y > a.y);
  // A crouched or tiny target still produces a valid segment rather than an
  // inside-out one, which would make the distance solve meaningless.
  standingCapsule(V(0, 0, 0), 0.2, 0.35, a, b);
  assert.ok(b.y > a.y);
});

/* ---------------------------------------------------------------- */
/* Hit and miss, on the shipped numbers                              */
/* ---------------------------------------------------------------- */

/** The volume a real bear swings, at progress `u`, against a player at `feet`. */
function bearStrike(feet, u) {
  const def = BEASTS.bear;
  return strikeHits({
    origin: V(0, def.shoulderHeight * 0.78, 0),
    yaw: 0,
    reach: def.reach,
    arc: STRIKE_ARC.bear,
    drop: STRIKE_DROP.bear,
    strikeRadius: def.strikeRadius,
    u,
    feet,
    height: PLAYER.height,
    radius: PLAYER.radius,
  });
}

/** True if the volume touches the target at any point in the window. */
function anyPointOfWindow(fn, steps = 24) {
  for (let i = 0; i <= steps; i++) if (fn(i / steps)) return true;
  return false;
}

test('a bear swipe lands on somebody standing in front of it', () => {
  assert.ok(bearStrike(V(0, 0, -2.0), 0.5), 'a player two metres in front was not hit');
  assert.ok(anyPointOfWindow((u) => bearStrike(V(0, 0, -1.2), u)), 'a player at contact range was not hit');
});

test('a bear swipe MISSES somebody who stepped out of it', () => {
  /* The dodge, four ways. Every one of these has to miss for the whole window,
   * not merely at the instant the animation peaks. */
  const reach = BEASTS.bear.reach;
  // Backed off past the reach.
  assert.equal(anyPointOfWindow((u) => bearStrike(V(0, 0, -(reach + 1.4)), u)), false,
    'a player who backed out of reach was still mauled');
  // Stepped square sideways.
  assert.equal(anyPointOfWindow((u) => bearStrike(V(3.4, 0, -0.6), u)), false,
    'a player who side-stepped was still mauled');
  // Behind it.
  assert.equal(anyPointOfWindow((u) => bearStrike(V(0, 0, 2.2), u)), false,
    'a bear mauled somebody standing behind it');
  // Above it - on a rock, a wall, a cart.
  assert.equal(anyPointOfWindow((u) => bearStrike(V(0, 3.2, -1.8), u)), false,
    'a bear reached somebody standing three metres above it');
});

test('the swipe really is swept: the arc covers ground the mid-point does not', () => {
  /* If the volume were a fixed forward capsule this test would be impossible to
   * write, which is exactly the point - a bear's paw travels ACROSS its front,
   * so there is ground that only the leading edge of the swing covers. */
  let onlyEarly = 0;
  for (let i = 0; i < 60; i++) {
    const a = (i / 60) * Math.PI * 2;
    const spot = V(Math.cos(a) * 2.0, 0, Math.sin(a) * 2.0);
    if (!bearStrike(spot, 0.5) && anyPointOfWindow((u) => bearStrike(spot, u))) onlyEarly++;
  }
  assert.ok(onlyEarly > 0,
    'no ground is covered by the swing that is not covered at its mid-point - the arc is doing nothing');
});

test('a wolf bite is a lunge, not a sweep - it covers far less ground than a bear', () => {
  const wolf = BEASTS.wolf;
  const bite = (feet, u) => strikeHits({
    origin: V(0, wolf.shoulderHeight * 0.82, 0),
    yaw: 0,
    reach: wolf.reach,
    arc: STRIKE_ARC.wolf,
    drop: STRIKE_DROP.wolf,
    strikeRadius: wolf.strikeRadius,
    u,
    feet, height: PLAYER.height, radius: PLAYER.radius,
  });
  assert.ok(anyPointOfWindow((u) => bite(V(0, 0, -1.6), u)), 'a wolf could not bite what was in front of it');

  const covered = (fn) => {
    let n = 0;
    for (let i = 0; i < 72; i++) {
      const a = (i / 72) * Math.PI * 2;
      const spot = V(Math.cos(a) * 1.7, 0, Math.sin(a) * 1.7);
      if (anyPointOfWindow((u) => fn(spot, u))) n++;
    }
    return n;
  };
  assert.ok(covered(bite) < covered(bearStrike),
    'a wolf bite sweeps as much ground as a bear swipe - the two attacks read the same');
  assert.ok(STRIKE_ARC.wolf < STRIKE_ARC.bear * 0.5, 'the bite has grown into a swipe');
});

/* ---------------------------------------------------------------- */
/* Through the real BeastNPC                                         */
/* ---------------------------------------------------------------- */

/**
 * A beast built without a world.
 *
 * `Object.create(BeastNPC.prototype)` rather than `new`, because the whole
 * point is to exercise the strike path - `_strikeOrigin`, `_targetCapsule`,
 * `_testStrike` and the yaw convention that ties them together - without
 * needing physics, a scene or a body.
 */
function stubBeast(species, yaw = 0, at = new THREE.Vector3()) {
  const def = BEASTS[species];
  const beast = Object.create(BeastNPC.prototype);
  beast.def = def;
  beast.species = species;
  beast.yaw = yaw;
  beast.root = { position: at };
  beast.humanoid = { muzzleLocal: new THREE.Vector3(0, def.shoulderHeight * 0.8, -def.bodyLength * 0.45) };
  beast.manager = { player: null };
  return beast;
}

test('the strike origin sits in front of the beast, at head height, and follows its yaw', () => {
  const out = new THREE.Vector3();
  const bear = stubBeast('bear');
  bear._strikeOrigin(out);
  assert.ok(out.z < -0.5, `facing -Z, the mouth should be ahead of the root, got z=${out.z}`);
  assert.ok(Math.abs(out.x) < 1e-6);
  assert.ok(out.y > 0.8, 'the mouth is on the floor');

  // A quarter turn puts the same point on the -X axis.
  const turned = stubBeast('bear', Math.PI / 2);
  turned._strikeOrigin(out);
  assert.ok(out.x < -0.5 && Math.abs(out.z) < 1e-6,
    `after a quarter turn the mouth should be on -X, got ${out.toArray()}`);
});

test('a real beast hits a player in its jaws and misses one who stepped aside', () => {
  const player = { position: new THREE.Vector3(0, 0, -1.6), isDead: false };
  const wolf = stubBeast('wolf');
  wolf.manager = { player };

  assert.ok(wolf._testStrike(player, 0.5), 'the wolf could not reach a player in front of it');

  // Two metres to the side, at the same range: out of the lunge entirely.
  player.position.set(2.4, 0, -1.0);
  let any = false;
  for (let i = 0; i <= 20; i++) any = any || wolf._testStrike(player, i / 20);
  assert.equal(any, false, 'the wolf bit a player who was not in front of it');
});

test('the same call resolves an NPC target, whose capsule is its own', () => {
  const bear = stubBeast('bear');
  const villager = {
    position: new THREE.Vector3(0, 0, -1.8), isDead: false, height: 1.8, radius: 0.33,
  };
  bear.manager = { player: { position: new THREE.Vector3(90, 0, 90) } };
  assert.equal(bear.isPlayerTarget(villager), false);
  const cap = bear._targetCapsule(villager);
  assert.equal(cap.radius, 0.33, 'an NPC was measured with the player\'s capsule');
  assert.ok(bear._testStrike(villager, 0.5), 'a bear could not maul a villager standing in front of it');
});
