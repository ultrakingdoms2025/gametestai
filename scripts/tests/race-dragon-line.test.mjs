import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';

/**
 * Is the line the dragon race flies actually flyable?
 *
 * Not "does the lap validate", not "is the pace right" - is there anything
 * SOLID in the tube the race is run down. Nothing in this suite had ever asked,
 * and the answer on every circuit was yes: the start/finish gantry's crossbeam.
 *
 * ── The defect this file is written against ────────────────────────────────
 *
 * `DRAGON_RACE.flightHeight` was 10 m. The gantry crossbeam collider spans the
 * whole road plus run-off from road+9.65 m to road+12.45 m, 2.4 m deep along
 * the track, on all three circuits (RaceWorld._buildPaddock: centre `g.y +
 * 11.05`, half-extents `wHalf + 1.2` x 1.4 x 1.2). A dragon's body is a capsule
 * of radius 1.5 and height 3.2 centred on `position`, so the route passed
 * 1.95 m INSIDE it, once per lap, at the one point every lap must cross.
 *
 * The symptom did not read as a collision. `Dragon._resolveCollision` scrubs
 * 20% of the speed per step against a horizontal pushout, and `damp(v, 30, 3.3,
 * 1/60)` then `speed *= 0.8` has a stable fixed point at 5.289512 m/s, reached
 * from every starting speed tried - so the mount arrived at the line and sat
 * there at a sixth of its boost speed. Measured here before the fix: it never
 * gets past the line at all, and a lap that has covered 1595.6 m of 1598.3
 * stops dead.
 *
 * ── Why these gates are shaped the way they are ────────────────────────────
 *
 * Everything below is measured out of production code against the REAL world.
 * `RaceWorld.build()` runs headless in about 0.6 s and registers 8169
 * colliders, so the obstruction is found by asking the shipped
 * `Physics.resolveCapsule` rather than by re-deriving the gantry's geometry
 * here - a restatement would have agreed with itself while the world moved.
 *
 * The dragon's body size is likewise read OFF the mount, by spying on the
 * `resolveCapsule` call `Dragon._resolveCollision` makes, so the swept volume
 * cannot drift away from the body it stands for.
 *
 * The gate is "zero pushout anywhere on the corridor", not "a lap completes".
 * The mount is only on the flight line for as long as it is being flown there,
 * and the beam is 2.8 m of a corridor 22 m tall, so a route straight through it
 * can still be got round - slowly, or by giving the altitude up. Completion
 * would have been a false pass; contact is the property.
 */

/* ---- headless canvas: RaceWorld._buildSky and RaceRings both want one ---- */
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
const { TrackPath, RacerField } = await import('../../src/race/RacerAI.js');
const { DRAGON_RACE, buildDragonRingCheckpoints } = await import('../../src/race/RaceRings.js');
const { RaceManager, DIFFICULTY_FIELD } = await import('../../src/race/RaceManager.js');
const { Dragon } = await import('../../src/mounts/Dragon.js');

const STEP = 1 / 60;
const clamp = THREE.MathUtils.clamp;

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
const bus = { on() {}, off() {}, emit() {} };
const scene = new THREE.Scene();

/** The real world, built once: 8169 colliders, the same ones the browser gets. */
const physics = new Physics();
const world = new RaceWorld({ scene, engine: null, physics, bus, materials });
{
  const say = console.log;
  console.log = () => {};
  await world.build();
  console.log = say;
}

/** Circuits, each with the centreline RaceManager would actually race on. */
const CIRCUITS = world.circuits.map((c) => {
  world.selectTrack(c.id);
  return { id: c.id, path: new TrackPath(world.trackPath), grid: world.startGrid.map((g) => ({ ...g })) };
});

/**
 * The dragon's collision body, read off the mount instead of restated.
 *
 * `Dragon._resolveCollision` is the only caller of `resolveCapsule` in the
 * flight path, so spying on it yields the radius, the height and - from the
 * mount's own position at the moment of the call - how far below `position` the
 * capsule origin sits. Restating 1.5 / 3.2 / 1.6 here would let this file keep
 * passing after the body changed shape.
 */
const BODY = (() => {
  let seen = null;
  const spy = {
    groundHeight: () => 0,
    resolveCapsule: (p, radius, height) => { seen = { p: p.clone(), radius, height }; return p; },
    sphereCast: () => null,
    colliders: [],
  };
  const d = new Dragon({ scene, engine: null, physics: spy, bus, materials, camera: null });
  d.spawn(new THREE.Vector3(0, 40, 0), 0);
  d.state = 'flying';
  d.position.set(0, 40, 0);
  d.fixedUpdate(STEP, 0, { throttle: 0, strafe: 0, up: 0, boost: false, yaw: 0, pitch: 0 });
  const out = { radius: seen.radius, height: seen.height, drop: d.position.y - seen.p.y };
  d.dispose?.();
  return out;
})();

const _p = new THREE.Vector3();
const _q = new THREE.Vector3();
/** What the real physics does to a dragon body centred on (x, y, z). */
function pushout(x, y, z) {
  _p.set(x, y - BODY.drop, z);
  _q.copy(_p);
  physics.resolveCapsule(_p, BODY.radius, BODY.height);
  return { h: Math.hypot(_p.x - _q.x, _p.z - _q.z), v: _p.y - _q.y };
}

/** `_clampPlayerDragon`'s corridor half-width, called rather than restated. */
function corridorHalf(width) {
  return Math.max(2.5, width * 0.5 - 1.8);
}

/* ======================================================================== */

/**
 * The corridor the dragon race is flown down must contain nothing solid.
 *
 * Sampled every 0.25 m of centreline - a tenth of the 2.4 m the crossbeam is
 * deep, so the band cannot be stepped over - across five lateral offsets
 * spanning the corridor `RaceManager._clampPlayerDragon` allows, plus all
 * twenty grid slots. About 82 000 capsule resolves against the real world, and
 * the whole file runs in a couple of seconds.
 *
 * Measured on this tree: 0 obstructed samples of 82 305 at flightHeight 15.
 * Reverting the constant to its old 10 gives 110 / 113 / 109 obstructed samples
 * on vellum / cinder / aurora, a MAXIMUM HORIZONTAL PUSHOUT of 1.833 m (the
 * largest of the three, on cinder; vellum's own is 1.707 and aurora's 1.776)
 * and a maximum vertical of 1.957 m. All of it is within 2.8 m of the start
 * line - 2.54 m on vellum, 2.77 on cinder, 2.75 on aurora - which is the gantry
 * and nothing else. Every height from 8.5 to 14 is obstructed; 14.1 is the
 * first that measures clean, so 15 carries about 0.9 m of margin. Below the
 * beam, 4.5 to 8 measures clean as well and 4 starts catching road furniture at
 * 110 samples - which is why the fix goes up rather than down: the low band is
 * only 3.5 m wide and it has road furniture at the bottom of it.
 */
test('nothing solid stands in the dragon race\'s flight corridor', () => {
  const smp = { x: 0, y: 0, z: 0, width: 12, tx: 0, tz: -1 };
  const H = DRAGON_RACE.flightHeight;
  let checked = 0;
  const bad = [];

  for (const cir of CIRCUITS) {
    for (let s = 0; s < cir.path.length; s += 0.25) {
      cir.path.sample(s, smp);
      const half = corridorHalf(smp.width);
      const nx = -smp.tz;
      const nz = smp.tx;
      for (const lat of [-half, -half * 0.5, 0, half * 0.5, half]) {
        const r = pushout(smp.x + nx * lat, smp.y + H, smp.z + nz * lat);
        checked++;
        if (r.h > 1e-6 || Math.abs(r.v) > 1e-6) {
          bad.push(`${cir.id} s=${s.toFixed(2)} lat=${lat.toFixed(2)}`
            + ` push h=${r.h.toFixed(3)} v=${r.v.toFixed(3)}`);
        }
      }
    }
    // The grid, at the height the player is actually placed on it.
    for (let i = 0; i < cir.grid.length; i++) {
      const g = cir.grid[i];
      const baseY = physics.groundHeight(g.x, g.z, g.y + 3, 8) ?? g.y;
      const r = pushout(g.x, baseY + H, g.z);
      checked++;
      if (r.h > 1e-6 || Math.abs(r.v) > 1e-6) {
        bad.push(`${cir.id} grid slot ${i} push h=${r.h.toFixed(3)} v=${r.v.toFixed(3)}`);
      }
    }
  }

  assert.ok(checked > 80000, `only ${checked} samples - the sweep stopped covering the circuits`);
  assert.equal(bad.length, 0,
    `${bad.length} of ${checked} samples of the dragon race's corridor are inside solid world `
    + `geometry at flightHeight ${H}. A dragon cannot fly through it: the first one is `
    + `${bad[0]}. The gantry crossbeam spans road+9.64..12.44 m, so the corridor is blocked `
    + 'from 8.5 m to 14 m and clear from 14.1 m up.');
});

/**
 * And the outcome, driven rather than deduced: a real Dragon on the real grid,
 * stepped by its own `fixedUpdate` against the real colliders, with the real
 * `RaceManager._clampPlayerDragon` holding it in its corridor.
 *
 * The player's grid slot on CONTENDER is not the same distance behind the line
 * on every circuit, and the numbers below are not either. Measured, vellum /
 * cinder / aurora: the slot is 56.03 / 55.93 / 55.97 m back, and at
 * flightHeight 15 the mount covers 344.2 / 345.1 / 343.9 m in twelve seconds.
 *
 * What IS identical across the three, to three decimals, is everything the
 * flight model produces on its own with nothing in the way: 26.673 m/s at 1 s,
 * 29.809 at 2 s, 29.990 at 3 s, over the line at 2.400 s, and not one step in
 * which the mount was slowed by anything. That is the point - a clean run is
 * the same run on every circuit, and only contact makes them differ.
 *
 * At the old flightHeight 10 the same runs read 26.673 / 29.809 / 5.289 on all
 * three, never reach the line at all in twelve seconds (53.33 / 53.16 / 53.27 m
 * of the ~56 m gap) and spend 47 steps each being scrubbed. 5.289 m/s is not a
 * number the flight model can produce on its own - it is the fixed point of the
 * collision penalty.
 */
test('a dragon gets off the grid and over the start line', () => {
  const here = { x: 0, y: 0, z: 0, width: 12, tx: 0, tz: -1 };
  const at = { x: 0, y: 0, z: 0, width: 12, tx: 0, tz: -1 };
  const H = DRAGON_RACE.flightHeight;

  for (const cir of CIRCUITS) {
    const path = cir.path;
    const slot = cir.grid[DIFFICULTY_FIELD.standard.playerSlot];
    const d = new Dragon({ scene, engine: null, physics, bus, materials, camera: null });
    // Exactly what `RaceManager._placePlayer` does for a dragon race.
    const baseY = physics.groundHeight(slot.x, slot.z, slot.y + 3, 8) ?? slot.y;
    d.spawn(new THREE.Vector3(slot.x, baseY + H, slot.z), slot.yaw);
    d.position.set(slot.x, baseY + H, slot.z);
    d.state = 'flying';
    d._groundY = baseY;
    d._vy = 0;
    d.velocity.set(0, 0, 0);
    d.speed = 0;
    d.heading = slot.yaw;

    const ctx = { dragonRace: true, path, mounts: { active: d }, player: null };
    const ctrl = { throttle: 1, strafe: 0, up: 0, boost: true, yaw: slot.yaw, pitch: 0 };
    let s = path.project(d.position.x, d.position.z, -1);
    // How far this slot is from the line, measured on the centreline itself.
    const toLine = path.delta(0, s);
    let gone = 0;
    let scrubbed = 0;
    let vAt3 = 0;
    let crossed = -1;

    for (let i = 0; i < 60 * 12; i++) {
      const t = (i + 1) * STEP;
      const ns = path.project(d.position.x, d.position.z, s);
      gone += path.delta(ns, s);
      s = ns;
      path.sample(s, here);
      path.sample(s + 20, at);
      ctrl.yaw = Math.atan2(-(at.x - d.position.x), -(at.z - d.position.z));
      ctrl.up = clamp((here.y + H - d.position.y) * 0.5, -1, 1);
      const before = d.speed;
      d.fixedUpdate(STEP, t, ctrl);
      // The mount only ever loses speed to a collision here: the throttle is
      // pinned open and the corridor clamp runs after this and is counted below.
      if (d.speed < before - 1e-9) scrubbed++;
      RaceManager.prototype._clampPlayerDragon.call(ctx);
      if (vAt3 === 0 && t >= 3 - 1e-9) vAt3 = d.speed;
      if (crossed < 0 && gone >= toLine) crossed = t;
    }
    d.dispose?.();

    assert.ok(toLine > 40, `${cir.id}: the grid slot is only ${toLine.toFixed(1)} m from the line`);
    assert.equal(scrubbed, 0,
      `${cir.id}: the world slowed the dragon on ${scrubbed} of 720 steps between the grid and `
      + 'the line. Off the line the throttle is wide open and nothing but a collision can take '
      + 'speed off it');
    assert.ok(crossed > 0 && crossed < 4,
      `${cir.id}: the dragon needed ${crossed < 0 ? 'more than 12 s' : crossed.toFixed(2) + ' s'} `
      + `to cover the ${toLine.toFixed(1)} m from its grid slot to the start line - at 30 m/s that `
      + 'is under three seconds, and it never arrived at all with the gantry in the way');
    assert.ok(vAt3 > 25,
      `${cir.id}: three seconds off the line the dragon was doing ${vAt3.toFixed(2)} m/s against a `
      + '30 m/s boost speed. 5.29 m/s is the fixed point of damp(v,30,3.3) followed by the 0.8 '
      + 'collision penalty, i.e. a mount jammed against something solid');
  }
});

/**
 * A lap has to close, with the mount never touching anything.
 *
 * Stated as "zero collisions" and not as a lap time, for the reason in the file
 * header: a dragon sinks out from under the beam when it is not being flown
 * hard, so completion alone would pass over an obstructed route.
 *
 * Measured: 54.32 / 45.35 / 43.83 s and zero collision steps. Before the fix no
 * lap completes on any circuit inside the 200 s cap - vellum stalls at 1595.6
 * of 1598.3 m, cinder at 1291.7 of 1294.5, aurora at 1216.2 of 1218.9, 81
 * scrubbed steps each. They get the whole way round and jam at the line.
 *
 * Those distances belong to THIS harness and should not be quoted as the
 * game's. The lap here starts ON the line at s = 0 and holds the flight height
 * with a servo, which is the only arrangement that lets the mount reach the far
 * side of the circuit before it meets the beam; started on the grid, as the
 * game starts it, it never reaches the line at all (see the test above). What
 * carries over to the game is the pin itself - see the note in RaceRings.js for
 * what a lap costs there, with and without giving the altitude up.
 */
test('a dragon can complete a lap of every circuit without touching the world', () => {
  const here = { x: 0, y: 0, z: 0, width: 12, tx: 0, tz: -1 };
  const at = { x: 0, y: 0, z: 0, width: 12, tx: 0, tz: -1 };
  const H = DRAGON_RACE.flightHeight;

  for (const cir of CIRCUITS) {
    const path = cir.path;
    const d = new Dragon({ scene, engine: null, physics, bus, materials, camera: null });
    path.sample(0, here);
    const yaw = Math.atan2(-here.tx, -here.tz);
    d.spawn(new THREE.Vector3(here.x, here.y + H, here.z), yaw);
    d.state = 'flying';
    d.position.set(here.x, here.y + H, here.z);
    d._groundY = here.y;
    const ctx = { dragonRace: true, path, mounts: { active: d }, player: null };
    const ctrl = { throttle: 1, strafe: 0, up: 0, boost: true, yaw, pitch: 0 };
    let s = 0;
    let gone = 0;
    let t = 0;
    let scrubbed = 0;

    for (let i = 0; i < 60 * 200 && gone < path.length; i++) {
      const ns = path.project(d.position.x, d.position.z, s);
      gone += path.delta(ns, s);
      s = ns;
      path.sample(s, here);
      path.sample(s + 20, at);
      ctrl.yaw = Math.atan2(-(at.x - d.position.x), -(at.z - d.position.z));
      ctrl.up = clamp((here.y + H - d.position.y) * 0.5, -1, 1);
      const before = d.speed;
      d.fixedUpdate(STEP, t, ctrl);
      if (d.speed < before - 1e-9) scrubbed++;
      RaceManager.prototype._clampPlayerDragon.call(ctx);
      t += STEP;
    }
    d.dispose?.();

    assert.ok(gone >= path.length,
      `${cir.id}: no lap in 200 s - the dragon covered ${gone.toFixed(1)} m of ${path.length.toFixed(1)}`);
    assert.equal(scrubbed, 0,
      `${cir.id}: the world took speed off the dragon on ${scrubbed} steps of a clean lap`);
  }
});

/**
 * The rivals have to fly the line the rings are hung on.
 *
 * This is the coupling that makes the fix above dangerous if it is taken
 * halfway. A ring is validated by `RaceManager._advance` against a vertical
 * gate of `cp.radius * 0.9` = 4.68 m, and the rings are hung at
 * `DRAGON_RACE.flightHeight`. RacerAI used to hold its own `AI_DRAGON_FLIGHT =
 * 10` beside it, so moving one number and not the other puts the entire field
 * outside the gate - measured with the rings at 15 and the rivals left at 10,
 * 9464 of 15637 in-radius samples fail on vellum (60.5%), 11611 of 19671 on
 * cinder and 11959 of 20141 on aurora, worst vertical gap 6.69 m.
 *
 * That is not a cosmetic failure. If no rival can validate a ring, no rival
 * finishes; if no rival finishes, `_checkEnd` never starts FINISH_GRACE and the
 * race never ends. It would turn the payout defect this session also fixed into
 * a permanent hang.
 *
 * The gate is read from `_advance`'s own expression rather than restated, and
 * the rivals are real `RacerAI`s driven by the real `RacerField`.
 */
test('every rival flies the line the dragon rings are hung on', () => {
  const here = { x: 0, y: 0, z: 0, width: 12, tx: 0, tz: -1 };

  for (const cir of CIRCUITS) {
    const path = cir.path;
    const rings = buildDragonRingCheckpoints(path);
    /* No `rings.length >= DRAGON_RACE.minRings` here, though there was.
     *
     * That assertion restated `buildDragonRingCheckpoints`' own clamp against
     * itself: the count IS `clamp(round(length / ringSpacing), minRings,
     * maxRings)`, so it cannot come back under `minRings` and the check cannot
     * fail. Measured on this tree it is not even close to the arm being tested:
     * the three circuits ask for 29 / 24 / 22 rings at the record's 55 m
     * spacing and get 18 each, so `maxRings` is what binds and `minRings` is
     * slack on every circuit.
     *
     * It is deleted rather than repaired because the file already refuses to
     * certify an empty or thin plan for real: `samples` below only accumulates
     * inside a ring's radius, so a plan with no rings in it scores zero and
     * trips the `samples > 5000` gate. That one is measured against the world
     * (15 637 / 19 671 / 20 141 here), not against the function under test. */
    const field = new RacerField({ scene, physics, materials });
    const racers = field.build(path, DIFFICULTY_FIELD.expert.cars - 1, 1234, 'dragon');
    path.sample(0, here);
    const yaw = Math.atan2(-here.tx, -here.tz);
    field.reset('expert', racers.map(() => ({ x: here.x, y: here.y, z: here.z, yaw })), 'dragon');

    let samples = 0;
    let outside = 0;
    let worst = 0;
    // Two minutes of flying. How much of a ring plan that actually covers is
    // not assumed: the sample count is asserted below.
    for (let i = 0; i < 60 * 120; i++) {
      field.fixedUpdate(STEP, [], true);
      for (const r of racers) {
        for (const cp of rings) {
          const dx = cp.x - r.position.x;
          const dz = cp.z - r.position.z;
          if (dx * dx + dz * dz > cp.radius * cp.radius) continue;
          samples++;
          const gap = Math.abs(r.position.y - cp.y);
          if (gap > worst) worst = gap;
          // The gate `_advance` applies to a dragon-race checkpoint.
          if (gap > cp.radius * 0.9) outside++;
        }
      }
    }
    field.dispose();

    assert.ok(samples > 5000, `${cir.id}: only ${samples} rivals-inside-a-ring samples to judge`);
    assert.equal(outside, 0,
      `${cir.id}: ${outside} of ${samples} samples had a rival inside a ring's radius but `
      + `${worst.toFixed(2)} m off its height, outside the ${(rings[0].radius * 0.9).toFixed(2)} m `
      + 'vertical gate. The field and the rings are flying two different routes, so no rival can '
      + 'complete a lap, the race never ends and FINISH_GRACE never starts');
  }
});
