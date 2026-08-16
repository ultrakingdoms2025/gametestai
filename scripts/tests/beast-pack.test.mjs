import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BeastPack, SHARE_RADIUS, PACK_FORGET } from '../../src/npc/BeastPack.js';

/**
 * Pack coordination: shared aggro, the ring, and taking turns.
 *
 * ── Why a pack is bookkeeping and not behaviour ───────────────────────────
 * Four wolves each independently running "close on the target" produce four
 * wolves standing on the same spot, taking turns to be shoved out of it by the
 * separation constraint. It reads as a queue, and all four are in front of the
 * player where one swing kills them.
 *
 * The three things that turn that into a hunt are all countable, which is why
 * they live in a class with no THREE in it and are tested with stubs:
 *
 *   1. word travels - one wolf noticing you is all of them noticing you;
 *   2. the ring is SHARED OUT rather than fought over, so five wolves hold five
 *      bearings by construction;
 *   3. only some of them may be committed at once, so the threat arrives one
 *      readable lunge at a time.
 *
 * And the fourth, which is the one that keeps the design honest: a pack has to
 * be able to FORGET. Members re-adopt the pack's target whenever they find
 * themselves idle, so without a clock on the pack itself a shared target would
 * be permanent and there would be no such thing as escaping.
 */

/** A wolf, as far as a pack is concerned. */
function stubWolf(x = 0, z = 0) {
  return {
    position: { x, y: 0, z },
    isDead: false,
    adopted: null,
    adoptPackTarget(t) {
      if (this.isDead) return false;
      this.adopted = t;
      return true;
    },
  };
}

function makePack(n, spread = 0) {
  const pack = new BeastPack({ species: 'wolf', seed: 42 });
  const wolves = [];
  for (let i = 0; i < n; i++) {
    const w = stubWolf(i * spread, 0);
    pack.add(w);
    wolves.push(w);
  }
  return { pack, wolves };
}

/* ---------------------------------------------------------------- */
/* Membership                                                        */
/* ---------------------------------------------------------------- */

test('joining a pack numbers you, and leaving it renumbers everybody else', () => {
  const { pack, wolves } = makePack(4);
  assert.deepEqual(wolves.map((w) => w.packSlot), [0, 1, 2, 3]);
  for (const w of wolves) assert.equal(w.pack, pack);

  pack.remove(wolves[1]);
  assert.equal(wolves[1].pack, null);
  assert.deepEqual(pack.members.map((w) => w.packSlot), [0, 1, 2],
    'a departed member left a hole in the ring');
  // Idempotent: removing twice, or removing a stranger, must not corrupt it.
  pack.remove(wolves[1]);
  pack.remove(stubWolf());
  assert.equal(pack.members.length, 3);
});

test('the pack is driven by a LIVING member', () => {
  /* A corpse's `fixedUpdate` returns before `_think`, so a pack whose clock was
   * owned by `members[0]` would stop orbiting and stop ageing its target out
   * the moment the first wolf died - permanently. */
  const { pack, wolves } = makePack(3);
  assert.equal(pack.firstLiving(), wolves[0]);
  wolves[0].isDead = true;
  assert.equal(pack.firstLiving(), wolves[1]);
  wolves[1].isDead = true;
  wolves[2].isDead = true;
  assert.equal(pack.firstLiving(), null);
});

/* ---------------------------------------------------------------- */
/* Shared aggro                                                      */
/* ---------------------------------------------------------------- */

test('one wolf noticing you is the whole pack noticing you', () => {
  const { pack, wolves } = makePack(5);
  const player = { position: { x: 0, y: 0, z: 20 }, isDead: false };

  const told = pack.share(player, wolves[0]);
  assert.equal(told, 4, `word reached ${told} of the other four`);
  assert.equal(pack.target, player);
  for (const w of wolves.slice(1)) {
    assert.equal(w.adopted, player, 'a packmate was not told about the target');
  }
  // The spotter is not told about its own discovery.
  assert.equal(wolves[0].adopted, null);
});

test('word does not travel across the map', () => {
  /* A pack that shares aggro at any range is not a pack, it is a global alarm -
   * and a wolf a kilometre away sprinting at the player from off screen is the
   * least readable threat there is. */
  const { pack, wolves } = makePack(3);
  wolves[1].position.x = SHARE_RADIUS * 0.5;
  wolves[2].position.x = SHARE_RADIUS + 10;
  const player = { position: { x: 0, y: 0, z: 0 }, isDead: false };

  const told = pack.share(player, wolves[0]);
  assert.equal(told, 1, 'the far wolf was told anyway');
  assert.equal(wolves[1].adopted, player);
  assert.equal(wolves[2].adopted, null);
});

test('the dead are not told anything', () => {
  const { pack, wolves } = makePack(3);
  wolves[2].isDead = true;
  const player = { position: { x: 0, y: 0, z: 0 }, isDead: false };
  assert.equal(pack.share(player, wolves[0]), 1);
  assert.equal(wolves[2].adopted, null);
});

test('sharing nothing is not sharing', () => {
  const { pack, wolves } = makePack(3);
  assert.equal(pack.share(null, wolves[0]), 0);
  assert.equal(pack.target, null);
});

test('a pack forgets a target nobody has confirmed, which is what makes escape possible', () => {
  const { pack, wolves } = makePack(4);
  const player = { position: { x: 0, y: 0, z: 0 }, isDead: false };
  pack.share(player, wolves[0]);

  // Somebody keeps seeing it: the pack holds on indefinitely.
  for (let i = 0; i < 60 * 30; i++) {
    pack.update(1 / 60);
    pack.targetAge = 0;
  }
  assert.equal(pack.target, player, 'a pack lost a target it could see');

  // Nobody confirms it any more.
  for (let i = 0; i < Math.ceil((PACK_FORGET + 1) * 60); i++) pack.update(1 / 60);
  assert.equal(pack.target, null, `the pack still holds a target after ${PACK_FORGET} s of silence`);
});

test('a pack drops a target that dies', () => {
  const { pack, wolves } = makePack(3);
  const villager = { position: { x: 0, y: 0, z: 0 }, isDead: false };
  pack.share(villager, wolves[0]);
  villager.isDead = true;
  pack.update(1 / 60);
  assert.equal(pack.target, null);
});

/* ---------------------------------------------------------------- */
/* The ring                                                          */
/* ---------------------------------------------------------------- */

test('five wolves hold five different bearings, and the ring turns', () => {
  const { pack, wolves } = makePack(5);
  const angles = wolves.map((w) => pack.slotAngle(w));
  for (let i = 0; i < angles.length; i++) {
    for (let j = i + 1; j < angles.length; j++) {
      const gap = Math.abs(angles[i] - angles[j]) % (Math.PI * 2);
      assert.ok(Math.min(gap, Math.PI * 2 - gap) > 0.6,
        `wolves ${i} and ${j} are circling the same bearing`);
    }
  }
  const before = pack.slotAngle(wolves[0]);
  pack.update(0.5);
  assert.notEqual(pack.slotAngle(wolves[0]), before, 'the ring is a formation, not a circling');
});

test('killing one closes the circle rather than leaving a hole in it', () => {
  const { pack, wolves } = makePack(4);
  wolves[1].isDead = true;
  const live = wolves.filter((w) => !w.isDead);
  const angles = live.map((w) => pack.slotAngle(w)).sort((a, b) => a - b);
  for (let i = 1; i < angles.length; i++) {
    const gap = angles[i] - angles[i - 1];
    assert.ok(Math.abs(gap - (Math.PI * 2) / 3) < 1e-9,
      `three survivors are spread ${gap.toFixed(3)} rad apart, not a third of a circle`);
  }
});

/* ---------------------------------------------------------------- */
/* Taking turns                                                      */
/* ---------------------------------------------------------------- */

test('a bigger pack commits more wolves, but slower than it grows', () => {
  /* If all five committed at once the player would take sixty damage in one
   * beat with nothing to read. One for a trio, two for a five: a bigger pack IS
   * more dangerous and the danger does not scale with the head count. */
  for (const [n, expected] of [[1, 1], [3, 1], [4, 1], [5, 1], [6, 2], [9, 3]]) {
    const { pack } = makePack(n);
    assert.equal(pack.attackSlots, expected, `a pack of ${n} commits ${pack.attackSlots}`);
  }
});

test('the attack token is handed out, held, and given back', () => {
  const { pack, wolves } = makePack(5);
  assert.equal(pack.attackSlots, 1);

  assert.equal(pack.requestAttack(wolves[0]), true);
  assert.equal(pack.requestAttack(wolves[1]), false, 'two wolves lunged at once');
  // Idempotent: the holder asks again on every step of its own wind-up.
  assert.equal(pack.requestAttack(wolves[0]), true);
  assert.equal(pack.isCommitted(wolves[0]), true);

  pack.releaseAttack(wolves[0]);
  assert.equal(pack.isCommitted(wolves[0]), false);
  assert.equal(pack.requestAttack(wolves[1]), true, 'the slot was never freed');
  // Releasing a slot you never had is harmless.
  pack.releaseAttack(wolves[3]);
  assert.equal(pack.isCommitted(wolves[1]), true);
});

test('the slot goes to the member that can actually reach, not the one that asked first', () => {
  /* THE STARVATION THIS FIXES, MEASURED IN THE GAME.
   *
   * A pack of three to five has exactly one slot. First-come-first-served put
   * it wherever the roster order happened to put it, and on the Ashlea plank
   * bridge - 2.6 m wide, with the river braking anything that strays off the
   * planks - the holder was a wolf 8.65 m away and jammed behind two others,
   * while wolves at 0.16 m and 1.51 m with clear line of sight were refused for
   * thirty seconds without a single telegraph.
   *
   * The margin is a LUNGE, `def.reach`, which is both the scale on which
   * "nearer" means anything and the hysteresis that stops two members swapping
   * the slot every frame. */
  const { pack, wolves } = makePack(4);
  for (const w of wolves) w.def = { reach: 2 };
  wolves[0].targetDistance = 9;
  wolves[1].targetDistance = 8;      // nearer, but not by a lunge
  wolves[2].targetDistance = 1;      // a lunge and then some nearer
  wolves[3].targetDistance = 12;

  assert.equal(pack.requestAttack(wolves[0]), true, 'the first asker did not get the only slot');
  assert.equal(pack.requestAttack(wolves[3]), false, 'a member FURTHER out took the slot');
  assert.equal(pack.requestAttack(wolves[1]), false,
    'a member one metre nearer took the slot - that is inside a lunge and will thrash');
  assert.equal(pack.requestAttack(wolves[2]), true,
    'a wolf on top of the target could not get the slot off one eight metres away');
  assert.equal(pack.isCommitted(wolves[0]), false, 'the displaced holder still holds it');
  assert.equal(pack.isCommitted(wolves[2]), true);

  /* A committed SEQUENCE is never interrupted. The telegraph is the whole
   * fairness deal - a wind-up a neighbour could cancel would not be one. */
  wolves[2].attackPhase = 'telegraph';
  wolves[0].targetDistance = 0.2;
  assert.equal(pack.requestAttack(wolves[0]), false,
    'a wolf mid-wind-up was cut off by a neighbour standing closer');

  /* And it degrades to the old rule for anything that publishes no distance,
   * which is what keeps the rest of this file measuring what it always did. */
  const bare = makePack(3);
  assert.equal(bare.pack.requestAttack(bare.wolves[0]), true);
  assert.equal(bare.pack.requestAttack(bare.wolves[1]), false,
    'a stub with no targetDistance took the slot on a NaN comparison');
});

test('a wolf that dies mid-lunge does not hold the slot for ever', () => {
  const { pack, wolves } = makePack(4);
  pack.requestAttack(wolves[0]);
  wolves[0].isDead = true;
  pack.update(1 / 60);
  assert.equal(pack.requestAttack(wolves[1]), true, 'a dead wolf is still holding the attack token');
});

test('losing the target releases everybody', () => {
  const { pack, wolves } = makePack(6);
  const player = { position: { x: 0, y: 0, z: 0 }, isDead: false };
  pack.share(player, wolves[0]);
  pack.requestAttack(wolves[1]);
  pack.requestAttack(wolves[2]);
  pack.clearTarget();
  assert.equal(pack.isCommitted(wolves[1]), false);
  assert.equal(pack.isCommitted(wolves[2]), false);
});
