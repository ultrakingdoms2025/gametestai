import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import nodePath from 'node:path';
import { fileURLToPath } from 'node:url';
import * as THREE from 'three';
import { RaceCourse } from '../../src/worlds/RaceTrack.js';
import { CIRCUITS, baseTerrain, worldControls } from '../../src/worlds/RaceCircuits.js';
import { RacerField, TrackPath } from '../../src/race/RacerAI.js';
import { RaceManager, DIFFICULTY_FIELD } from '../../src/race/RaceManager.js';
import { DRAGON_RACE } from '../../src/race/RaceRings.js';
import { Car } from '../../src/mounts/Car.js';
import { Dragon } from '../../src/mounts/Dragon.js';
import { AudioDirector } from '../../src/audio/AudioDirector.js';

/**
 * Is the field the player is put in front of actually raceable, on the mount
 * they are actually riding?
 *
 * The suite had gates for the race UI, the world flag and the conifer LOD, and
 * none that ever compared a rival's pace to the player's. That is how a dragon
 * race shipped in which the player's mount was pinned at 10 m/s against rivals
 * doing 27-43: every constant involved looked reasonable on its own, and
 * nothing multiplied them together.
 *
 * The comparison is made end to end out of production code. The centreline is
 * a real RaceCourse decimated exactly as RaceWorld._fillCircuit decimates it
 * and fed to the real TrackPath. The rivals are real RacerAI instances built
 * by the real RacerField, so their personalities are the ones the game rolls
 * and their corner-speed law is the shipped one. The player's machine is the
 * real Car or Dragon, stepped at the engine's own 1/60, with the real
 * RaceManager._clampPlayerDragon holding the dragon in its corridor.
 *
 * The one thing written here is the driver, and it is written so that it
 * cannot smuggle in a handling model of its own:
 *
 *  - It MEASURES each mount's cornering limit rather than restating it, by
 *    running the real mount at a held speed with its aim 90 degrees off and
 *    reading the yaw rate that comes out (`yawCurve`). That reproduces
 *    min(1.95, LAT_GRIP/v) for the car and 1.55 - clamp01(v/BOOST)*0.55 for
 *    the dragon without either number appearing in this file.
 *  - It reads the road with the production `TrackPath.curvature` probe.
 *  - It searches a grid of aim distances and read-ahead spans and keeps the
 *    fastest lap that never left the corridor the mount is allowed, so the
 *    number is the best line this driver can find rather than an arbitrary
 *    one. It never makes a mistake, so it is an OPTIMISTIC bound on a human:
 *    the real deficits are at least as large as the ones asserted here.
 *
 * Measured on this tree (fastest legal clean lap / fastest rival's lap, one
 * rival per grid slot, seed 1234):
 *
 *              ROOKIE          CONTENDER       APEX
 *   vellum     car 0.844       car 1.099       car 1.229
 *              dragon 0.810    dragon 1.055    dragon 1.180
 *   cinder     car 0.904       car 1.174       car 1.319
 *              dragon 0.808    dragon 1.050    dragon 1.180
 *   aurora     car 0.886       car 1.157       car 1.293
 *              dragon 0.810    dragon 1.059    dragon 1.184
 *
 * which is the shape RacerAI's DIFFICULTIES comment claims: under 1 on ROOKIE
 * (win it by driving cleanly), just over on CONTENDER (a fight you lose stock
 * and take with lines or a Power tier), well over on APEX. Before the corridor
 * fix the dragon's CONTENDER figure was 2.60.
 *
 * The bounds below sit outside every measured value with room to spare, and
 * are two-sided on purpose: making the player's mount FASTER than the field
 * fails them just as an unwinnable field does. Removing the challenge is the
 * other way to get this wrong.
 */

const ROOT = nodePath.resolve(nodePath.dirname(fileURLToPath(import.meta.url)), '../..');
const STEP = 1 / 60;
const clamp = THREE.MathUtils.clamp;
const SEED = 1234;
/** Aim distances and curvature-probe spans the driver is allowed to try, m. */
const AIM = [12, 16, 20, 24];
const SPAN = [5, 12, 24, 56];
/**
 * The altitude a dragon race is flown at, taken from the race's own record.
 *
 * This file used to hold its own `10` in three places, which made it a THIRD
 * copy of a number that already existed twice - and the pair of copies it did
 * not know about is what put the route through the start gantry. Nothing here
 * moves when it changes: the flight model has no altitude term, and every lap
 * below reproduces to the last digit at 10 m and at 15 m (vellum 54.008333 /
 * 48.333333 / 44.058333 at tiers 0/1/2, identical at both heights; likewise
 * cinder 45.450000 / 40.741667 / 37.116667 and aurora 43.258333 / 38.850000 /
 * 35.550000). It is read rather than restated so that it CANNOT drift, not
 * because it changes anything measured here - the corridor these laps are
 * flown against has no colliders in it at all, which is why
 * scripts/tests/race-dragon-line.test.mjs exists and builds the real world.
 */
const FLIGHT = DRAGON_RACE.flightHeight;

/* ---- headless scaffolding ---------------------------------------------- */

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

/** The road IS the height field here: no terrain, no walls, same for everyone. */
function physicsFor(path) {
  const smp = { x: 0, y: 0, z: 0, width: 12, tx: 0, tz: -1 };
  let hint = -1;
  return {
    groundHeight(x, z) {
      hint = path.project(x, z, hint);
      path.sample(hint, smp);
      return smp.y;
    },
    resolveCapsule: (p) => p,
    sphereCast: () => null,
    colliders: [],
  };
}

/** The published centreline, built the way RaceWorld._fillCircuit builds it. */
function buildPath(def) {
  const co = new RaceCourse(worldControls(def), {
    spacing: 2, verge: 11, baseHeight: baseTerrain, maxBankDeg: 5, cornerWiden: 0.2,
  });
  const stride = Math.max(1, Math.round(6 / co.step));
  const samples = [];
  for (let i = 0; i < co.count; i += stride) {
    samples.push({ x: co.x[i], y: co.y[i], z: co.z[i], width: co.w[i] });
  }
  return new TrackPath(samples);
}

const MOUNTS = {
  car: {
    label: 'car',
    flying: false,
    make: (physics) => new Car({ scene, engine: null, physics, bus, materials, camera: null }),
  },
  dragon: {
    label: 'dragon',
    flying: true,
    make: (physics) => new Dragon({ scene, engine: null, physics, bus, materials, camera: null }),
  },
};

/** Put a mount on the line, flying if it flies. */
function place(mount, path, flying) {
  const here = { x: 0, y: 0, z: 0, width: 12, tx: 0, tz: -1 };
  path.sample(0, here);
  const yaw = Math.atan2(-here.tx, -here.tz);
  const y = here.y + (flying ? FLIGHT : 0);
  mount.spawn(new THREE.Vector3(here.x, y, here.z), yaw);
  if (flying) {
    mount.state = 'flying';
    mount.position.y = y;
    mount._groundY = here.y;
  }
  return yaw;
}

/* ---- measured handling limit ------------------------------------------- */

/**
 * Max sustained yaw rate against speed, read off the real mount.
 *
 * The aim is held a quarter turn off the heading - far more than either
 * steering law can answer in one step - so what comes back is the mount's cap
 * and not its response to a small error.
 */
function yawCurve(make, physics, flying, vmax) {
  const m = make(physics);
  const ctrl = { throttle: 1, strafe: 0, up: 0, boost: true, yaw: 0, pitch: 0 };
  const out = [];
  for (let v = 2; v <= vmax; v += 1) {
    m.spawn(new THREE.Vector3(0, flying ? 60 : 0, 0), 0);
    if (flying) { m.state = 'flying'; m.position.y = 60; }
    let best = 0;
    for (let i = 0; i < 40; i++) {
      m.speed = v;
      const h0 = m.heading;
      ctrl.yaw = m.heading + Math.PI / 2;
      m.fixedUpdate(STEP, i * STEP, ctrl);
      best = Math.max(best, Math.abs(m.heading - h0) / STEP);
    }
    out.push({ v, rate: best });
  }
  m.dispose?.();
  return out;
}

/** Fastest speed on the measured curve that still turns tightly enough for `k`. */
function speedForCurvature(curve, k, vmax) {
  if (!(k > 1e-5)) return vmax;
  let best = curve[0].v;
  for (const p of curve) {
    if (p.v > vmax) break;
    if (p.v * k <= p.rate) best = p.v;
  }
  return best;
}

/* ---- the player's lap --------------------------------------------------- */

/**
 * One clean run of `laps` laps. Progress is distance round the centreline,
 * which is what RaceManager._rank scores, so the player and the rivals are
 * measured on exactly the same quantity.
 */
function cleanLap(mount, path, laps, curve, vmax, { aim, span, flying }) {
  const here = { x: 0, y: 0, z: 0, width: 12, tx: 0, tz: -1 };
  const at = { x: 0, y: 0, z: 0, width: 12, tx: 0, tz: -1 };
  const yaw0 = place(mount, path, flying);
  // The real corridor, called rather than restated.
  const clampCtx = flying
    ? { dragonRace: true, path, mounts: { active: mount }, player: null }
    : null;

  const ctrl = { throttle: 1, strafe: 0, up: 0, boost: true, yaw: yaw0, pitch: 0 };
  const total = path.length * laps;
  let s = 0;
  let gone = 0;
  let t = 0;
  let worstLat = 0;

  for (let i = 0; i < 60 * 60 * 10 && gone < total; i++) {
    const ns = path.project(mount.position.x, mount.position.z, s);
    gone += path.delta(ns, s);
    s = ns;
    path.sample(s, here);
    path.sample(s + aim, at);
    // Corridor: RaceManager._clampPlayerDragon's for a dragon, the one RacerAI
    // holds itself to for a car. Neither machine may cheat by running wide.
    const half = flying
      ? Math.max(2.5, here.width * 0.5 - 1.8)
      : Math.max(1.6, here.width * 0.5 - 1.3);
    const lat = Math.abs(path.lateralOf(mount.position.x, mount.position.z, s));
    if (gone > 20) worstLat = Math.max(worstLat, lat / half);

    const want = speedForCurvature(curve, path.curvature(s, span), vmax);
    ctrl.yaw = Math.atan2(-(at.x - mount.position.x), -(at.z - mount.position.z));
    ctrl.boost = mount.speed < want;
    ctrl.throttle = mount.speed > want * 1.03 ? -1 : 1;
    if (flying) ctrl.up = clamp((here.y + FLIGHT - mount.position.y) * 0.5, -1, 1);
    mount.fixedUpdate(STEP, t, ctrl);
    if (clampCtx) RaceManager.prototype._clampPlayerDragon.call(clampCtx);
    t += STEP;
  }
  const done = gone >= total;
  return { lap: done ? t / laps : Infinity, legal: done && worstLat <= 1.0001 };
}

/** Best legal lap over the allowed aim/span grid. */
function playerLap(spec, path, { tier = 0, laps = 2 } = {}) {
  const physics = physicsFor(path);
  const vmax = (spec.flying ? 30 : 34) * (1 + tier * 0.12) + 0.5;
  const make = (p) => {
    const m = spec.make(p);
    if (tier) m.applyPowers?.({ power: tier });
    return m;
  };
  const curve = yawCurve(make, physics, spec.flying, vmax);
  let best = Infinity;
  for (const aim of AIM) {
    for (const span of SPAN) {
      const m = make(physics);
      const r = cleanLap(m, path, laps, curve, vmax, { aim, span, flying: spec.flying });
      m.dispose?.();
      if (r.legal && r.lap < best) best = r.lap;
    }
  }
  return best;
}

/* ---- the rivals --------------------------------------------------------- */

/** Every rival's lap, alone on the track, so the number is pace and not traffic. */
function rivalLaps(path, difficulty, mode, laps = 2) {
  const field = new RacerField({ scene, physics: null, materials });
  const count = Math.max(1, DIFFICULTY_FIELD[difficulty].cars - 1);
  const racers = field.build(path, count, SEED, mode);
  const here = { x: 0, y: 0, z: 0, width: 12, tx: 0, tz: -1 };
  path.sample(0, here);
  const yaw = Math.atan2(-here.tx, -here.tz);
  field.reset(difficulty, racers.map(() => ({ x: here.x, y: here.y, z: here.z, yaw })), mode);

  const out = [];
  for (const r of racers) {
    const total = path.length * laps;
    const solo = [r];
    let s = r.s;
    let gone = 0;
    let t = 0;
    for (let i = 0; i < 60 * 60 * 12 && gone < total; i++) {
      r.fixedUpdate(STEP, solo, true);
      gone += path.delta(r.s, s);
      s = r.s;
      t += STEP;
    }
    out.push(t / laps);
  }
  field.dispose();
  return out.sort((a, b) => a - b);
}

/* ======================================================================== */

/**
 * The corridor may only punish a dragon that actually left it.
 *
 * `_clampPlayerDragon` used to rebuild the dragon's position from
 * `sample(s) + normal * lateral` on every step and then ask whether the result
 * differed from where it started. It always did, by a few ulps, because the
 * rebuild is a float round trip - so the penalty branch (velocity zeroed,
 * speed capped at 10 m/s) ran on 64.9% of steps while the mount was flying
 * comfortably inside its corridor. This is that defect stated directly.
 */
test('the dragon race corridor only bites a dragon that is outside it', () => {
  const path = buildPath(CIRCUITS[0]);
  const physics = physicsFor(path);
  const dragon = MOUNTS.dragon.make(physics);
  const yaw0 = place(dragon, path, true);
  const ctx = { dragonRace: true, path, mounts: { active: dragon }, player: null };
  const here = { x: 0, y: 0, z: 0, width: 12, tx: 0, tz: -1 };
  const at = { x: 0, y: 0, z: 0, width: 12, tx: 0, tz: -1 };
  const ctrl = { throttle: 1, strafe: 0, up: 0, boost: true, yaw: yaw0, pitch: 0 };

  let s = 0;
  let inside = 0;
  let punished = 0;
  let top = 0;
  for (let i = 0; i < 60 * 60; i++) {
    s = path.project(dragon.position.x, dragon.position.z, s);
    path.sample(s, here);
    path.sample(s + 18, at);
    ctrl.yaw = Math.atan2(-(at.x - dragon.position.x), -(at.z - dragon.position.z));
    ctrl.up = clamp((here.y + FLIGHT - dragon.position.y) * 0.5, -1, 1);
    dragon.fixedUpdate(STEP, i * STEP, ctrl);

    const half = Math.max(2.5, here.width * 0.5 - 1.8);
    const lat = Math.abs(path.lateralOf(dragon.position.x, dragon.position.z, s));
    const before = dragon.speed;
    RaceManager.prototype._clampPlayerDragon.call(ctx);
    if (lat <= half) {
      inside++;
      if (dragon.speed < before) punished++;
    }
    top = Math.max(top, dragon.speed);
  }
  dragon.dispose?.();

  assert.ok(inside > 3000, `only ${inside} of 3600 steps were inside the corridor - the flight model changed, not the clamp`);
  assert.equal(punished, 0,
    `the corridor slowed a dragon that was inside it on ${punished} of ${inside} steps `
    + '(it fired on 2338 of 3600 before the fix, pinning the mount at 10 m/s all lap)');
  assert.ok(top > 29,
    `a dragon flying a clean line never got past ${top.toFixed(2)} m/s; it should reach its 30 m/s boost speed`);
});

/**
 * A Power tier has to reach the mount it was bought for.
 *
 * `MountManager._applyPowers` early-returns on `!mount?.applyPowers`, so a
 * mount without the hook banks the purchase, persists it, re-emits it on
 * `mount:powers` and applies it to nothing. Only Car had the hook, which left
 * the dragon race with a difficulty band whose own comment says to spend
 * powers on it and no power that could be spent.
 *
 * The 12% is read back as a ratio of measured terminal speeds, so it fails
 * both ways: if the hook disappears, and if the two mounts' ladders drift
 * apart.
 */
test('a purchased Power tier reaches every mount the player races', () => {
  for (const [id, spec] of Object.entries(MOUNTS)) {
    assert.equal(typeof spec.make(physicsFor(buildPath(CIRCUITS[0]))).applyPowers, 'function',
      `${id} has no applyPowers hook, so MountManager._applyPowers discards every tier bought for it`);
  }

  const path = buildPath(CIRCUITS[0]);
  const physics = physicsFor(path);
  const terminal = (spec, tier) => {
    const m = spec.make(physics);
    m.applyPowers({ power: tier });
    place(m, path, spec.flying);
    const ctrl = { throttle: 1, strafe: 0, up: spec.flying ? 1 : 0, boost: true, yaw: m.heading, pitch: 0 };
    for (let i = 0; i < 60 * 60; i++) {
      ctrl.yaw = m.heading;
      m.fixedUpdate(STEP, i * STEP, ctrl);
    }
    const v = m.speed;
    m.dispose?.();
    return v;
  };

  for (const [id, spec] of Object.entries(MOUNTS)) {
    const stock = terminal(spec, 0);
    assert.ok(stock > 10, `${id} never got moving: ${stock.toFixed(3)} m/s`);
    for (const tier of [1, 2]) {
      const got = terminal(spec, tier) / stock;
      const want = 1 + tier * 0.12;
      assert.ok(Math.abs(got - want) < 0.005,
        `${id} tier ${tier} multiplied top speed by ${got.toFixed(4)}, not the ${want} `
        + 'Car.applyPowers documents - the two ladders have drifted apart');
    }
  }
});

/**
 * A Power tier may not make the mount worse at anything the player can feel.
 *
 * Two distinct failures live here, and the first shipped. `Dragon.fixedUpdate`
 * caps the yaw rate at `1.55 - clamp01(speed / BOOST_SPEED) * 0.55`, which
 * SATURATES; multiplying the speed past BOOST_SPEED and leaving that alone
 * widens the turning radius v/omega, so a purchased tier bought straight-line
 * pace by spending cornering. Measured before the fix: 30.000 m at stock,
 * 33.600 at tier 1, 37.200 at tier 2.
 *
 * The radius is asserted rather than the corridor-clamp rate, because the clamp
 * rate is not a property of the mount: it counts how hard the driver in this
 * file is pushing, and a mount that corners better gets driven harder into the
 * same fixed-width corridor. The lap time is the outcome that matters and it is
 * asserted too.
 */
test('a Power tier buys the dragon speed without costing it cornering', () => {
  const path = buildPath(CIRCUITS[0]);
  const physics = physicsFor(path);

  /* Tightest sustained turn at each tier's OWN top speed, read off the mount
   * the same way `yawCurve` does. Held one radius, not three, is the whole
   * claim: k x the speed against k x the rate is the same v/omega. */
  const radiusAtTop = (tier) => {
    const d = MOUNTS.dragon.make(physics);
    d.applyPowers({ power: tier });
    const top = 30 * (1 + tier * 0.12);
    d.spawn(new THREE.Vector3(0, 60, 0), 0);
    d.state = 'flying';
    d.position.y = 60;
    const ctrl = { throttle: 1, strafe: 0, up: 0, boost: true, yaw: 0, pitch: 0 };
    let best = 0;
    for (let i = 0; i < 40; i++) {
      d.speed = top;
      const h0 = d.heading;
      ctrl.yaw = d.heading + Math.PI / 2;
      d.fixedUpdate(STEP, i * STEP, ctrl);
      best = Math.max(best, Math.abs(d.heading - h0) / STEP);
    }
    d.dispose?.();
    return top / best;
  };

  const stock = radiusAtTop(0);
  assert.ok(Math.abs(stock - 30) < 0.01,
    `a stock dragon's tightest turn at 30 m/s measured ${stock.toFixed(3)} m, not the 30.0 m `
    + 'the RacerAI calibration note is written against - the flight model moved');
  for (const tier of [1, 2]) {
    const r = radiusAtTop(tier);
    assert.ok(Math.abs(r - stock) < 0.01,
      `at Power tier ${tier} the dragon's tightest turn is ${r.toFixed(3)} m against a stock `
      + `${stock.toFixed(3)} m - a purchased tier that widens the turning radius makes the race `
      + 'corridor bite sooner, so the upgrade is partly a downgrade');
  }

  /* The saturated cap is only half of it: the proportional gain that reaches
   * for the cap has to scale too, or a 12% larger budget needs a 12% larger
   * heading error before it is reached and the extra authority goes unspent in
   * exactly the gentle corners it was bought for. Read one step from rest at a
   * heading error of 0.05 rad, which asks for 0.130 rad/s against a cap of
   * 1.330 at this speed, so what comes back is the gain and never the clamp. */
  const gainStep = (tier) => {
    const d = MOUNTS.dragon.make(physics);
    d.applyPowers({ power: tier });
    d.spawn(new THREE.Vector3(0, 60, 0), 0);
    d.state = 'flying';
    d.position.y = 60;
    d.speed = 12;
    d.fixedUpdate(STEP, 0, { throttle: 1, strafe: 0, up: 0, boost: false, yaw: 0.05, pitch: 0 });
    const turned = d.heading;
    d.dispose?.();
    return turned;
  };
  const g0 = gainStep(0);
  assert.ok(g0 > 0, `a stock dragon did not answer a 0.05 rad heading error at all (${g0})`);
  for (const tier of [1, 2]) {
    const got = gainStep(tier) / g0;
    const want = 1 + tier * 0.12;
    assert.ok(Math.abs(got - want) < 0.005,
      `below its cap, a tier-${tier} dragon answers a heading error ${got.toFixed(4)}x as fast as `
      + `stock, not the ${want} its speed was multiplied by - the raised yaw budget is not `
      + 'reachable, so the tier is agility the player paid for and cannot use');
  }

  /* And the outcome: the best lap that never left the corridor. */
  const laps = [0, 1, 2].map((tier) => playerLap(MOUNTS.dragon, path, { tier }));
  for (const tier of [1, 2]) {
    assert.ok(laps[tier] < laps[tier - 1],
      `Power tier ${tier} lapped in ${laps[tier].toFixed(2)}s against tier ${tier - 1}'s `
      + `${laps[tier - 1].toFixed(2)}s - the tier is not worth buying`);
  }
});

/**
 * A purchased tier has to be visible to the player who bought it.
 *
 * Everything else in this file gates the tier's EFFECT. None of it would
 * notice if the effect were entirely silent to the player, and it very nearly
 * was: the mount's own presentation values are deliberately saturated so a
 * tier changes none of them, the audio is now clamped for the same reason, and
 * the yaw budget scales precisely so that nothing visibly changes shape. What
 * was left was a slightly earlier lap time, which is what buying nothing also
 * looks like.
 *
 * Textual because the property is a DOM one: `_setMountPowers` writes a badge,
 * and asserting on the writing is what a headless test can honestly do. (`HUD.js`
 * itself imports fine under Node - `pause-menu.test.mjs` does exactly that - so
 * anything reachable on the prototype should be driven, not grepped.) The badge
 * itself was verified in a browser.
 */
test('a purchased mount power tier is shown to the player', async () => {
  const hud = await readFile(nodePath.join(ROOT, 'src/ui/HUD.js'), 'utf8');
  // The method definition, not either of the two call sites.
  const at = hud.search(/^ {2}_setMountPowers\(/m);
  assert.ok(at > 0, 'the HUD has no _setMountPowers - a bought tier is invisible again');

  const body = hud.slice(at, at + 1200);
  assert.ok(/getPowers/.test(body),
    'the mount badge no longer reads MountManager.getPowers, so it is not sourced from the same '
    + 'bag _applyPowers turns into multipliers and could show a tier the mount is not carrying');
  assert.ok(/this\._on\('mount:powers'/.test(hud),
    'the HUD does not listen for mount:powers, so a tier bought while already mounted shows '
    + 'nothing until the player dismounts and remounts');

  const css = await readFile(nodePath.join(ROOT, 'src/ui/hud.css'), 'utf8');
  assert.ok(/\.mount-pip\b/.test(css),
    'hud.css has no .mount-pip rule, so the badge renders as unstyled text');
  assert.ok(/\.mount-pow:empty\s*\{[^}]*display:\s*none/.test(css),
    'the badge row does not collapse when empty, so a stock mount now pays panel height for a '
    + 'purchase it has not made');
});

/**
 * The dragon's held audio voice may not outrun its own wings.
 *
 * `Sfx.mountLoop`'s dragon patch drives its wingbeat LFO from `0.9 + speed *
 * 0.06` Hz. Every VISIBLE speed driver on the mount is a `clamp01(speed /
 * BOOST_SPEED)` and saturates; that one read the raw number, so a Power tier
 * desynchronised the beat you hear from the beat you see - measured at full
 * boost, the visible rate term pinned at its 0.420 Hz floor while the LFO went
 * 2.700 Hz stock, 2.916 at tier 1, 3.132 at tier 2.
 *
 * `AudioDirector.update` is called rather than restated, so this fails both if
 * `Dragon.voiceSpeed` stops clamping and if the director stops reading it.
 */
test('a Power tier does not desynchronise the dragon you hear from the one you see', () => {
  const path = buildPath(CIRCUITS[0]);
  const physics = physicsFor(path);
  const seen = [];

  for (const tier of [0, 1, 2]) {
    const d = MOUNTS.dragon.make(physics);
    d.applyPowers({ power: tier });
    place(d, path, true);
    const ctrl = { throttle: 1, strafe: 0, up: 1, boost: true, yaw: d.heading, pitch: 0 };
    for (let i = 0; i < 60 * 60; i++) {
      ctrl.yaw = d.heading;
      d.fixedUpdate(STEP, i * STEP, ctrl);
    }
    const want = 30 * (1 + tier * 0.12);
    assert.ok(Math.abs(d.speed - want) < 0.05,
      `tier ${tier} settled at ${d.speed.toFixed(3)} m/s, not the ${want.toFixed(3)} the Power `
      + 'ladder documents - the rest of this test is measuring the wrong thing');
    /* The premise: at every tier the mount is at the speed where the VISIBLE
     * drivers saturate, so the wings have stopped changing. `speed01` is the
     * clamp they all share. Stock approaches its ceiling asymptotically and
     * lands 2e-15 short of exactly 1, hence the epsilon rather than equality. */
    assert.ok(d.speed01 >= 1 - 1e-9,
      `at tier ${tier} the dragon's own speed01 is ${d.speed01}, so its visuals have not `
      + 'saturated and there is no desynchronisation to test for');

    const heard = [];
    AudioDirector.prototype.update.call({
      engine: { ready: true },
      camera: null,
      player: null,
      _mount: { handle: { set: (o) => heard.push(o) }, id: 'dragon', mount: d },
    }, STEP);
    d.dispose?.();

    assert.equal(heard.length, 1, 'AudioDirector.update stopped feeding the held mount voice');
    seen.push(heard[0].speed);
  }

  /* 0.01 m/s is 0.0006 Hz of wingbeat LFO, against the 0.216 Hz (tier 1) and
   * 0.432 Hz (tier 2) the unclamped voice was running fast by. */
  for (const tier of [1, 2]) {
    assert.ok(Math.abs(seen[tier] - seen[0]) < 0.01,
      `the held voice reads ${seen[tier].toFixed(3)} m/s at Power tier ${tier} against `
      + `${seen[0].toFixed(3)} stock, while the wings it is meant to be have already saturated - `
      + `its wingbeat LFO runs ${(100 * (seen[tier] / seen[0] - 1)).toFixed(0)}% fast against the `
      + 'beat the player can see');
  }
});

/**
 * The ground probe may never let the dragon outrun its own body.
 *
 * `Dragon.fixedUpdate` probes the terrain at 20 Hz, and the note there earns
 * that with an exact arithmetic identity: 30 m/s over three fixed steps is
 * 1.500 m, which is exactly RIDE_RADIUS. A Power tier breaks the identity - at
 * tier 1 the tick alone would carry the body 1.680 m between probes - so the
 * cadence is distance-gated as well as tick-gated. Reverting that gate left
 * every test in this repo green, and the identity itself was guarded only by a
 * comment; this is both, stated as the invariant rather than as the mechanism.
 *
 * RIDE_RADIUS is read out of the production `resolveCapsule` call rather than
 * restated, so the bound cannot drift away from the body it describes.
 */
test('the dragon probes the ground before it has moved a body-width, at every Power tier', () => {
  const path = buildPath(CIRCUITS[0]);

  for (const tier of [0, 1, 2]) {
    const base = physicsFor(path);
    let rideRadius = 0;
    let probes = 0;
    let worst = 0;
    let last = null;
    const physics = {
      ...base,
      groundHeight(x, z, y, r) {
        probes++;
        if (last) worst = Math.max(worst, Math.hypot(x - last.x, z - last.z));
        last = { x, z };
        return base.groundHeight(x, z, y, r);
      },
      resolveCapsule(p, radius) { rideRadius = radius; return p; },
    };

    const d = MOUNTS.dragon.make(physics);
    d.applyPowers({ power: tier });
    place(d, path, true);
    const ctrl = { throttle: 1, strafe: 0, up: 0, boost: true, yaw: d.heading, pitch: 0 };
    // Settle to the tier's terminal speed first; the count below is of steady
    // flight, not of the run-up.
    for (let i = 0; i < 60 * 30; i++) { ctrl.yaw = d.heading; d.fixedUpdate(STEP, i * STEP, ctrl); }
    probes = 0;
    last = null;
    worst = 0;
    for (let i = 0; i < 600; i++) { ctrl.yaw = d.heading; d.fixedUpdate(STEP, i * STEP, ctrl); }
    const v = d.speed;
    d.dispose?.();

    assert.ok(rideRadius > 0,
      'Dragon._resolveCollision stopped passing its body radius to physics.resolveCapsule, so '
      + 'this test has nothing to measure the probe interval against');
    assert.ok(worst <= rideRadius + 1e-9,
      `at Power tier ${tier} (${v.toFixed(3)} m/s) the dragon travelled ${worst.toFixed(3)} m `
      + `between ground probes, past its own ${rideRadius} m body radius - terrain can appear `
      + 'inside it before the probe that would have found it');
    if (tier === 0) {
      // Pins the exact-arithmetic claim in Dragon.fixedUpdate: a stock dragon
      // is meant to be untouched by the distance gate, at 3 steps per probe.
      assert.equal(probes, 200,
        `a stock dragon probed ${probes} times in 600 fixed steps, not the 200 it did before the `
        + 'cadence was distance-gated - the gate is now firing early on stock speeds');
      assert.ok(Math.abs(worst - 1.5) < 1e-9,
        `a stock dragon covered ${worst.toFixed(9)} m per probe interval, not the 1.500 m that `
        + 'makes the 20 Hz cadence exactly affordable');
    }
  }
});

/**
 * The band the player is put in front of has to mean the same thing on both
 * mounts, because DIFFICULTIES and DIFFICULTY_FIELD are shared by both races
 * and their comments describe one intent, not two.
 */
test('every race type is winnable on ROOKIE, a fight on CONTENDER and out of reach on APEX', () => {
  /* Two-sided, and every bound is outside the widest value measured on this
   * tree. A regression that makes the player hopeless trips the upper bound;
   * one that hands them the race trips the lower. Measured range over all six
   * circuit/mount pairs: ROOKIE 0.808-0.904, CONTENDER 1.050-1.174, APEX
   * 1.180-1.319.
   *
   * ROOKIE's floor is 0.65 and not 0. `ratio` is a quotient of two positive
   * finite lap times, so `> 0` is a tautology - it was half of this band's gate
   * certifying nothing while the comments above and below both said every bound
   * was two-sided. 0.65 sits 0.158 under the tightest measured ROOKIE figure,
   * the same order of margin the other four bounds carry.
   *
   * What it takes to trip it, measured by scaling the ROOKIE band and
   * re-running the whole table: weakening `pace` and `grip` together to 0.9x
   * gives a floor ratio of 0.740, 0.8x gives 0.669 and 0.7x gives 0.593, so the
   * bound catches roughly a quarter of the band's performance going missing.
   * `pace` alone moves it much less, because `cornerLimit` still holds the
   * field: 0.8x pace only reaches 0.683, and it takes 0.6x (pace 0.48) to reach
   * 0.521. That asymmetry is the reason the bound is where it is rather than
   * just under 0.808. */
  const BOUND = {
    easy: { min: 0.65, max: 1.0 },
    standard: { min: 1.0, max: 1.35 },
    expert: { min: 1.0, max: 1.55 },
  };
  /* How far the two race types may differ on the same band. Measured spread
   * today is 0.139; before the corridor fix the dragon's CONTENDER figure was
   * 2.60 against the car's 1.10, a gap of 1.5. */
  const PARITY = 0.35;

  for (const def of CIRCUITS) {
    const path = buildPath(def);
    const ratios = {};
    for (const [id, spec] of Object.entries(MOUNTS)) {
      const mine = playerLap(spec, path);
      assert.ok(Number.isFinite(mine), `${def.id}: the ${id} could not complete a legal lap at all`);
      ratios[id] = {};
      for (const difficulty of Object.keys(BOUND)) {
        const rivals = rivalLaps(path, difficulty, id === 'dragon' ? 'dragon' : 'car');
        const ratio = mine / rivals[0];
        ratios[id][difficulty] = ratio;
        const b = BOUND[difficulty];
        const where = `${def.id}/${id}/${difficulty}: clean lap ${mine.toFixed(2)}s vs `
          + `fastest rival ${rivals[0].toFixed(2)}s = ${ratio.toFixed(3)}`;
        assert.ok(ratio > b.min, `${where} - the field is beaten stock, which removes the challenge instead of setting it`);
        assert.ok(ratio < b.max, `${where} - the field is out of reach on the mount the player actually rides`);
      }
    }
    for (const difficulty of Object.keys(BOUND)) {
      const gap = Math.abs(ratios.car[difficulty] - ratios.dragon[difficulty]);
      assert.ok(gap < PARITY,
        `${def.id}/${difficulty}: the same band is worth ${ratios.car[difficulty].toFixed(3)} in a car `
        + `and ${ratios.dragon[difficulty].toFixed(3)} on a dragon - the two races share DIFFICULTIES `
        + 'and one calibration, so they cannot mean this different a thing');
    }
  }
});

/**
 * On the dragon, the Power ladder has to be a way THROUGH the standard band,
 * not just a bigger number on the speedometer - CONTENDER's own comment sells
 * it as exactly that.
 *
 * Stated for the dragon and not for both mounts, because it is only true of
 * the dragon, and a gate that certifies something false is worse than none.
 * The dragon is top-speed limited on these circuits - its measured yaw cap of
 * 1.000 rad/s at 30 m/s is a 30.0 m turning radius, wider than all three
 * circuits' tightest corners (`RaceCourse.minRadius`: 20.0 m Vellum, 17.1 m
 * Cinder, 16.0 m Aurora) but close enough that it binds on very little of a lap
 * - so a tier converts almost all of its 12%. Measured with this file's own
 * driver: Vellum 54.01s -> 48.33s against a fastest CONTENDER of 51.21s,
 * Cinder 45.45 -> 40.74 against 43.29, Aurora 43.26 -> 38.85 against 40.86.
 *
 * The car is grip limited instead - 0.397 rad/s at 34 m/s is an 85.6 m turning
 * radius against those same 16.0-20.0 m corners - so it spends most of a lap
 * below its top speed and a Power tier buys much less of one: 50.82s -> 49.03s
 * on Cinder and 47.27 -> 45.45 on Aurora, both still well short of CONTENDER.
 * On Vellum a tier-1 car is actually 0.40s SLOWER over the best legal line
 * (56.26 -> 56.66), because the extra speed costs it more in corridor
 * discipline than it gains on the straights. That is the shipped car and not a
 * defect; asserting the same flip for it would be asserting a fiction.
 */
test('a Power tier is the dragon\'s way through the CONTENDER band', () => {
  const path = buildPath(CIRCUITS[0]);
  const target = rivalLaps(path, 'standard', 'dragon')[0];
  const stock = playerLap(MOUNTS.dragon, path);
  const tier1 = playerLap(MOUNTS.dragon, path, { tier: 1 });
  assert.ok(stock > target,
    `a stock dragon already beats the fastest CONTENDER (${stock.toFixed(2)}s vs ${target.toFixed(2)}s) - `
    + 'there is nothing left for a Power tier to be for');
  assert.ok(tier1 < target,
    `a tier-1 Power took the dragon's lap from ${stock.toFixed(2)}s to ${tier1.toFixed(2)}s, still short of `
    + `the fastest CONTENDER's ${target.toFixed(2)}s - the band's own comment promises powers are the way through`);
});
