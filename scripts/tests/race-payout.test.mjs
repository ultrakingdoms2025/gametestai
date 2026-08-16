import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';

/**
 * Does racing pay?
 *
 * Not "is the prize table right" - is the reward path capable of paying a
 * player who actually raced. Nothing in this suite had ever asked: before this
 * file and race-dragon-line.test.mjs existed, a grep of scripts/tests for
 * FINISH_GRACE, `_classify`, RACE_PRIZES, PICKUP_VALUE or `plannedDrops`
 * matched no file at all. What shipped underneath that gap was a whole
 * difficulty band worth exactly zero credits with certainty.
 *
 * ── The defect this file is written against ────────────────────────────────
 *
 * `RaceManager.start` passed `this.dragonRace ? 0 : this.plannedDrops` to
 * `pickups.scatter`, and `_syncPlayerEntry` skipped `pickups.claim` for a
 * dragon race. Between them a dragon race had no collectable income at all, so
 * its payout was a function of the FINISHING POSITION alone - and RACE_PRIZES
 * is three deep, `_classify` zeroes a DNF, and `abort` pays nothing.
 *
 * Both remaining roads to a credit are closed at once, which is why the total
 * is not small but exactly zero:
 *
 *  - `_checkEnd` drops the flag FINISH_GRACE = 25 s after the LAST rival gets
 *    home, and `_classify` then zeroes the placing prize of anyone still out
 *    there. Not home in time: zero.
 *  - RACE_PRIZES is three deep and `RACE_PRIZES[place - 1] ?? 0` pays nothing
 *    beyond it, while APEX seats the player 15th of 20. Home in time but off
 *    the podium: zero as well.
 *  - Meanwhile the setup panel read "DRAGON" over "40 · 1 cr each" for a race
 *    worth nothing, and RaceUI's own footer promised "drops pay 1 each whether
 *    or not you finish".
 *
 * The car race shares every line of that code and never showed it, because a
 * car DNF still comes home with its drops - 40 on Vellum Ridge, 32 on Cinder
 * Gorge, 30 on Aurora Rise.
 *
 * ── What is gated here, and what is deliberately not ───────────────────────
 *
 * Gated: both race types scatter what the panel advertised, a racer who covers
 * the circuit claims them, the flag pays them even on a DNF, and they are drawn
 * where the mount that has to collect them actually is.
 *
 * NOT gated, because they are design decisions and not defects - see the
 * session report: how deep RACE_PRIZES should be, whether laps completed should
 * earn partial credit, and whether FINISH_GRACE at 25 s should be long enough
 * for a stock mount to be classified on APEX at all.
 */

const noopCtx = () => {
  const grad = { addColorStop() {} };
  return {
    canvas: null,
    createLinearGradient: () => grad, createRadialGradient: () => grad, createPattern: () => null,
    fillRect() {}, clearRect() {}, strokeRect() {}, fill() {}, stroke() {},
    beginPath() {}, closePath() {}, moveTo() {}, lineTo() {}, arc() {}, ellipse() {},
    roundRect() {}, quadraticCurveTo() {}, bezierCurveTo() {},
    save() {}, restore() {}, translate() {}, rotate() {}, scale() {},
    setTransform() {}, transform() {}, drawImage() {}, fillText() {}, strokeText() {},
    measureText: () => ({ width: 10 }),
    getImageData: (x, y, w, h) => ({ data: new Uint8ClampedArray(w * h * 4), width: w, height: h }),
    putImageData() {},
    createImageData: (w, h) => ({ data: new Uint8ClampedArray(w * h * 4), width: w, height: h }),
  };
};
globalThis.document ??= {
  createElement(tag) {
    if (tag !== 'canvas') return {};
    return { width: 1, height: 1, getContext: () => noopCtx(), style: {} };
  },
};

const { RaceWorld } = await import('../../src/worlds/RaceWorld.js');
const { Physics } = await import('../../src/physics/Physics.js');
const { RaceManager, RACE_STATE, RACE_TYPES, RACE_PRIZES } = await import('../../src/race/RaceManager.js');
const { DRAGON_RACE } = await import('../../src/race/RaceRings.js');
const { PICKUP_VALUE } = await import('../../src/race/Pickups.js');

const matCache = new Map();
const materials = {
  has: () => true,
  get: (k) => {
    if (!matCache.has(k)) matCache.set(k, new THREE.MeshStandardMaterial());
    return matCache.get(k);
  },
  register: (k, m) => matCache.set(k, m),
  tinted: (k) => materials.get(k),
};
const scene = new THREE.Scene();
const physics = new Physics();
const bus = { on() {}, off() {}, emit() {} };

const world = new RaceWorld({ scene, engine: null, physics, bus, materials });
{
  const say = console.log;
  console.log = () => {};
  await world.build();
  console.log = say;
}

/**
 * A RaceManager armed on the real world, with the player standing in for a
 * mount.
 *
 * No `mounts`, deliberately: `_placePlayer` then teleports the player instead
 * of summoning, which keeps this file measuring the reward path rather than the
 * flight model - that is what race-dragon-line.test.mjs is for. Everything the
 * credits pass through (`start`, `_syncPlayerEntry`, `_classify`, `Pickups`) is
 * the shipped code, called.
 */
function armed() {
  const wallet = [];
  const finished = [];
  const localBus = {
    on() {}, off() {},
    emit(name, payload) { if (name === 'race:finished') finished.push(payload); },
  };
  const player = {
    position: new THREE.Vector3(),
    velocity: new THREE.Vector3(),
    teleport(v) { this.position.copy(v); },
    setYaw() {},
  };
  const race = new RaceManager({
    scene, physics, bus: localBus, materials, player, mounts: null,
    economy: { add: (n, why) => wallet.push({ n, why }) },
    worldManager: null,
  });
  assert.ok(race.arm(world), 'the race manager would not arm on the race world');
  return { race, wallet, finished, player };
}

/**
 * Drive one racer round one lap of the centreline and hand the result to the
 * flag, exactly as the game does.
 *
 * The position is written and `_syncPlayerEntry` is called, which is where the
 * production claim lives - so a claim the manager skips is a claim this does
 * not make. Half-metre steps: `claim` refuses an interval longer than half a
 * lap as a teleport, and half a metre is what a car covers in a frame anyway.
 */
function driveALap(race, player, flying) {
  const path = race.path;
  const smp = { x: 0, y: 0, z: 0, width: 12, tx: 0, tz: -1 };
  race.state = RACE_STATE.RACING;
  for (let s = 0; s <= path.length; s += 0.5) {
    path.sample(s % path.length, smp);
    player.position.set(smp.x, smp.y + (flying ? DRAGON_RACE.flightHeight : 0), smp.z);
    race._syncPlayerEntry();
  }
}

/** Where a drop's instance is actually drawn, in world Y. */
function dropY(race, i) {
  const m = new THREE.Matrix4();
  race.pickups.mesh.getMatrixAt(i, m);
  return new THREE.Vector3().setFromMatrixPosition(m).y;
}

/* ======================================================================== */

/**
 * The panel's promise, kept.
 *
 * `plannedDrops` is `path.length / 40` with no race-type branch, and RaceUI
 * reads it unconditionally into "Drops N · 1 cr each" on the setup card. Before
 * the fix a dragon race scattered 0 of the 40 it had just advertised. Measured
 * now: 40 on Vellum Ridge, 32 on Cinder Gorge, 30 on Aurora Rise, for both race
 * types and all three bands.
 */
test('every race scatters the drops its setup panel advertised', () => {
  const { race } = armed();
  for (const id of world.tracks.map((t) => t.id)) {
    race.selectTrack(id);
    for (const type of [RACE_TYPES.CAR, RACE_TYPES.DRAGON]) {
      race.setRaceType(type);
      for (const band of race.difficulties) {
        const promised = race.plannedDrops;
        assert.ok(promised > 0, `${id}: the panel advertises no drops at all`);
        /* The equality below is only an equality while the promise fits in the
         * mesh, and nothing else in the build says so out loud.
         *
         * `Pickups.scatter` lays `Math.min(count, instanceMatrix.count)` drops,
         * so a circuit long enough to ask for more than the InstancedMesh holds
         * gets silently truncated: the panel would go on advertising N, the
         * race would lay the capacity, and the only symptom would be a promise
         * quietly worth less than it says. `plannedDrops` is `length / 40` m
         * and the mesh holds 128, so that starts happening at a circuit of
         * 5120 m. Measured here: the longest asks for 40 (vellum, 1598 m),
         * against a capacity of 128 - a factor of three of headroom, which is
         * exactly the sort of margin that gets spent without anyone noticing. */
        const capacity = race.pickups.mesh.instanceMatrix.count;
        assert.ok(promised <= capacity,
          `${id}: the setup panel advertises ${promised} drops and the pickup InstancedMesh holds `
          + `${capacity}. scatter() truncates to the capacity, so the panel is now promising drops `
          + 'the race does not lay - raise the mesh, or stop deriving the promise from the length');
        assert.ok(race.start(band), `${id}/${type}/${band}: the race would not start`);
        assert.equal(race.pickups.items.length, promised,
          `${id}/${type}/${band}: the setup panel advertised ${promised} drops and the race `
          + `scattered ${race.pickups.items.length}. A reward the panel names and the race does `
          + 'not lay is a promise the build does not keep');
        race.abort('test');
      }
    }
  }
});

/**
 * A racer who covered the circuit is paid for it - on both mounts, in every
 * band, without finishing.
 *
 * The DNF is the case that matters and it is the one that shipped broken:
 * `_classify` zeroes the placing prize for a player who was still circulating
 * at the flag, so collectables are the whole of what a dragon on APEX could
 * ever come home with, and it collected none.
 *
 * `wallet` is `Economy.add`, so this asserts money that actually moved and not
 * just a number in a results row.
 */
test('a racer who covers the circuit is paid, on either mount and in every band', () => {
  /* Counted and asserted at the end rather than skipped quietly. A `continue`
   * on a band a circuit does not offer would let this whole gate certify
   * nothing the day the difficulty list changed shape. */
  let ran = 0;
  for (const id of world.tracks.map((t) => t.id)) {
    for (const type of [RACE_TYPES.CAR, RACE_TYPES.DRAGON]) {
      for (const band of ['easy', 'standard', 'expert']) {
        const { race, wallet, finished, player } = armed();
        race.selectTrack(id);
        race.setRaceType(type);
        assert.ok(race.difficulties.includes(band),
          `${id}: the circuit no longer offers the ${band} band this gate is written against`);
        ran++;
        assert.ok(race.start(band), `${id}/${type}/${band}: the race would not start`);
        const laid = race.pickups.items.length;
        driveALap(race, player, type === RACE_TYPES.DRAGON);

        const took = race.pickups.collected;
        assert.ok(took >= laid * 0.9,
          `${id}/${type}/${band}: a racer that covered the whole centreline claimed ${took} of `
          + `${laid} drops. On a dragon race the claim used to be skipped outright`);

        // The flag as `_checkEnd` drops it on a player who is still out there.
        race._classify(true);
        const mine = race.results.find((r) => r.isPlayer);
        /* Not `assert.ok(mine.dnf)`, which used to stand here and could not
         * discriminate anything: `_classify` writes `dnf: !e.finished`, and a
         * fixture that drives one lap of a five-lap race can only ever produce
         * a player who has not finished. It restated the fixture back to
         * itself.
         *
         * What can fail is whether being classified DNF actually COSTS the
         * placing prize, which is the branch the whole payout argument rests
         * on. The rivals never move here - `driveALap` writes the player's
         * position and syncs, it does not step the field - so the player is
         * ranked P1 and `_classify` hands them RACE_PRIZES[0] before
         * `if (mine.dnf) mine.credits = 0` takes it back. Assert there was
         * something to take: delete that line from RaceManager and the equality
         * below fails by exactly the prize, which is the point of it. */
        const stripped = RACE_PRIZES[mine.place - 1] ?? 0;
        assert.ok(stripped > 0,
          `${id}/${type}/${band}: the player came out of _classify in P${mine.place}, which pays `
          + `${stripped} credits. Zeroing a DNF's placing prize is then a no-op, and the payout `
          + 'equality below stops proving that a DNF loses it');
        assert.equal(mine.credits, took * PICKUP_VALUE,
          `${id}/${type}/${band}: a DNF paid ${mine.credits} credits for ${took} drops`);
        assert.ok(mine.credits > 0,
          `${id}/${type}/${band}: a racer who covered the entire circuit and was still out there `
          + 'when the flag fell was paid nothing at all. That is the APEX dragon race exactly: a '
          + 'nine-minute race, flown well, worth zero credits');
        assert.equal(wallet.length, 1, `${id}/${type}/${band}: Economy.add was called ${wallet.length} times`);
        /* These two are the DNF half of a pair and are weaker than they read.
         *
         * On a DNF `_classify` has already zeroed the placing prize, so
         * `mine.credits`, `paid`, `bonus` and `pickups.collected` are all the
         * same number, and an emit that reported any of them would satisfy the
         * comparison. Mutating `credits: paid` to `credits: bonus` passes this
         * test unchanged - measured. The test below is where the four numbers
         * are made to differ and the comparison bites. */
        assert.equal(wallet[0].n, mine.credits,
          `${id}/${type}/${band}: the results row says ${mine.credits} and the wallet took ${wallet[0].n}`);
        assert.equal(finished.at(-1)?.credits, mine.credits,
          `${id}/${type}/${band}: race:finished reported a different figure again`);
      }
    }
  }
  assert.equal(ran, 18, `only ${ran} of the 3 circuits x 2 mounts x 3 bands were actually raced`);
});

/**
 * And the other half: a finisher is paid the placing prize ON TOP of the drops,
 * and the three places that number is published all say the same thing.
 *
 * This exists because every other case in this file is a DNF, and on a DNF the
 * prize has been zeroed before anything is published - which leaves the results
 * row, the wallet and the `race:finished` payload all carrying the drop total
 * and nothing else. Three readouts agreeing on one number is not a measurement
 * when the number is the only one in the room: replacing `credits: paid` in the
 * emit with `credits: bonus` passed the DNF test above with nothing to say.
 *
 * With a finisher the four quantities separate - 10 for P1 against 40 drops on
 * Vellum - and the same mutation fails. The player is marked home the way
 * `_advance` marks them at the flag rather than driven there, because what is
 * under test here is `_classify`'s arithmetic, not the lap counter.
 */
test('a finisher is paid the prize AND the drops, and all three readouts agree', () => {
  const { race, wallet, finished, player } = armed();
  race.selectTrack('vellum');
  race.setRaceType(RACE_TYPES.CAR);
  assert.ok(race.start('standard'), 'the race would not start');
  driveALap(race, player, false);
  const took = race.pickups.collected;
  assert.ok(took > 0, 'the finisher collected nothing, so prize and drops cannot be told apart');

  const me = race.entries.find((e) => e.isPlayer);
  me.finished = true;
  me.finishTime = 61.5;
  race._classify(false);

  const mine = race.results.find((r) => r.isPlayer);
  assert.equal(mine.dnf, false, 'a racer marked home came out of _classify as a DNF');
  const prize = RACE_PRIZES[mine.place - 1] ?? 0;
  assert.ok(prize > 0,
    `the finisher was classified P${mine.place}, which pays nothing, so this test cannot tell a `
    + 'prize from a drop and proves neither');
  assert.equal(mine.credits, prize + took * PICKUP_VALUE,
    `a finisher in P${mine.place} took ${mine.credits} credits, not the ${prize} for the place plus `
    + `${took} for the drops. The placing prize and the collectables are separate rewards and a `
    + 'finisher is owed both');
  assert.equal(wallet.length, 1, `Economy.add was called ${wallet.length} times`);
  assert.equal(wallet[0].n, mine.credits,
    `the results row says ${mine.credits} and the wallet took ${wallet[0].n}`);
  assert.equal(finished.at(-1)?.credits, mine.credits,
    `the results row says ${mine.credits} and race:finished announced ${finished.at(-1)?.credits}`);
  assert.equal(finished.at(-1)?.pickupCredits, took * PICKUP_VALUE,
    'race:finished broke the drop share out as a different number from the drops collected');
});

/**
 * A drop has to be where the mount that must collect it is.
 *
 * `Pickups.claim` never sees a height - it is a centreline interval plus a
 * lateral check - so scattering for a dragon race without moving the drops off
 * the tarmac would have awarded a credit for flying fifteen metres over a coin.
 * The mesh is the only thing that tells the player where a drop is, so the mesh
 * is what has to move.
 *
 * Asserted against `DRAGON_RACE.flightHeight` rather than a literal, so the two
 * move together the next time the flight line does. The tolerance is the bob:
 * `_refresh` adds `sin(t) * BOB * 0.25` = ±0.1375 m.
 */
test('a drop is drawn on the line the race is actually run on', () => {
  const { race, player } = armed();
  const smp = { x: 0, y: 0, z: 0, width: 12, tx: 0, tz: -1 };
  void player;

  for (const [type, want] of [[RACE_TYPES.CAR, 1.0], [RACE_TYPES.DRAGON, DRAGON_RACE.flightHeight]]) {
    race.setRaceType(type);
    assert.ok(race.start('standard'));
    assert.ok(race.pickups.items.length > 0);
    for (let i = 0; i < race.pickups.items.length; i++) {
      const it = race.pickups.items[i];
      race.path.sample(it.s, smp);
      const over = dropY(race, i) - smp.y;
      assert.ok(Math.abs(over - want) <= 0.2,
        `${type}: drop ${i} is drawn ${over.toFixed(2)} m over the road, not the ${want} m the `
        + `race is run at. A ${type} race claims drops by centreline distance and never checks a `
        + 'height, so a drop drawn anywhere else is a credit awarded for passing nowhere near it');
    }
    race.abort('test');
  }
});
