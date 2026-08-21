import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { CONFIG } from '../../src/core/Config.js';
import { PLANETS } from '../../src/worlds/planets/index.js';
import { worldGravityRatio } from '../../src/worlds/WorldRules.js';
import {
  MOUTH_Z, MOUTH_HW, MOUTH_KERB_H, MOUTH_SCREEN_H, MOUTH_LEAP_APEX,
  PIERS, PIER_GATE_HW, DECK_Y,
} from '../../src/worlds/dock/YardPlan.js';

/**
 * SPRINT AND JUMP AT EVERY BARRIER IN THE GAME.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 *  WHY THIS FILE EXISTS
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * A 2,500-case suite watched two barriers ship that a running leap goes
 * straight over, and it watched them ship for one reason: every case that had
 * ever been written about a barrier WALKED at it. Walking is the case that
 * passes. Measured in a real browser, with real key events:
 *
 *   Shoal's shore, eight bearings out of the Glassflat pad
 *     walk          stopped at the waterline on 8 of 8.
 *     sprint+jump   OVER on 7 of 8, landing at y -1.96 to -8.15, 14 m under a
 *                   sea the player takes no damage in and cannot swim in.
 *
 *   The Lodestar Yard's mouth rail, ten x positions 16 m inside the bay
 *     walk          stopped at z -103.2 at 10 of 10.
 *     jump          stopped at 10 of 10.
 *     sprint+jump   OVER at 10 of 10, into the void at y -30. Recovery then put
 *                   the player on the hangar ROOF, from which they walked into
 *                   the roof cut and fell for 69 damage.
 *
 * ── The arithmetic nobody had done ────────────────────────────────────────
 * A barrier has to clear TWO numbers and both of them are about the player's
 * body rather than about the water or the deck:
 *
 *   THE RUNNING LEAP  `Parkour.tryLeap` writes `v.y = jumpVelocity * LEAP_LIFT`,
 *                     so its apex is the STANDING apex times LEAP_LIFT SQUARED -
 *                     1.2544x, not 1.12x. And `jumpApex` is per-world, because
 *                     `Player.setWorldGravity` scales take-off as `ratio^(1/3)`
 *                     against gravity's `ratio`. The shore wall's old expression
 *                     used the UNSCALED 6.4 m/s against the SCALED gravity,
 *                     which is not any jump the player has anywhere.
 *   THE MANTLE        `Climb.MAX_RISE` is 2.4 m and does not scale - it is how
 *                     far a pair of arms reaches. A 2.0 m wall standing on
 *                     ground level with the water is INSIDE the mantle band and
 *                     can simply be climbed over. Nothing had ever checked it.
 *
 * ── And the datum was wrong ───────────────────────────────────────────────
 * The shore wall measured its parapet from the WATER. The player leaps from the
 * BANK. On Shoal that bank is 1.3-1.4 m above the sea, so a 2.0 m parapet was a
 * 0.6 m gate against a 1.18 m leap. Every case below measures the gate from the
 * ground a body could leap FROM.
 *
 * ── And the two reaches ADD ───────────────────────────────────────────────
 * Sizing against `max(leap, mantle)` was the first fix and it was still crossed
 * on six of Shoal's eight bearings. The trajectories say why: the peak of every
 * crossing was the POST TOP plus exactly one standing jump. `Player` offers the
 * mantle on the JUMP PRESS and `Climb._probe` measures the rise from the FEET,
 * so jump, press jump again at the top of the arc, and the reach is the SUM.
 * Every requirement below is `leapApex + MAX_RISE` for that reason.
 *
 * ── What this file does NOT claim ─────────────────────────────────────────
 * That a determined player cannot get past. `FreeClimb` grabs any vertical face
 * with Space held and both these worlds publish `climb: true`, so a sustained
 * wall climb goes over anything and no height in this file changes that: it is a
 * global mechanic the citadel is built around, not a hole in these two walls.
 * What is asserted here is that the move the game TEACHES for crossing a gap -
 * sprint, jump, and jump again at a lip - does not cross by accident. The
 * measured residue is on the report: Shoal went 7-of-8 crossed to 2-of-8, and
 * both survivors are sustained climbs onto a post top rather than leaps over it,
 * from which `K` now tells the truth and offers a ride home.
 */

/* ------------------------------------------------------------------ */
/* The two constants this file is about, read from where they live     */
/* ------------------------------------------------------------------ */

const SRC_PARKOUR = readFileSync(new URL('../../src/player/Parkour.js', import.meta.url), 'utf8');
const SRC_CLIMB = readFileSync(new URL('../../src/player/Climb.js', import.meta.url), 'utf8');
const SRC_PLANET = readFileSync(new URL('../../src/worlds/PlanetWorld.js', import.meta.url), 'utf8');
const SRC_YARD = readFileSync(new URL('../../src/worlds/dock/YardPlan.js', import.meta.url), 'utf8');

const num = (src, name) => {
  const m = src.match(new RegExp(`^const ${name} = ([0-9.]+);`, 'm'));
  assert.ok(m, `could not read ${name} out of the source - this file no longer measures what it says`);
  return Number(m[1]);
};

/** `Parkour.LEAP_LIFT`. Not exported by `Parkour`, so it is read, not imported. */
const LEAP_LIFT = num(SRC_PARKOUR, 'LEAP_LIFT');
/** `Climb.MAX_RISE`: the tallest ledge a mantle takes. */
const MANTLE_MAX = num(SRC_CLIMB, 'MAX_RISE');

const P = CONFIG.player;
/** The standing apex on a world that publishes no gravity. @see Player */
const BASE_APEX = (P.jumpVelocity * P.jumpVelocity) / (2 * -P.gravity);
/** `Player#jumpApex` on a planet: apex goes as `ratio^(-1/3)`. */
const apexOn = (planet) => BASE_APEX * Math.pow(Math.max(1e-3, worldGravityRatio(planet) ?? 1), -1 / 3);
/** The running leap's apex is the standing apex times LEAP_LIFT SQUARED. */
const leapApexOn = (planet) => apexOn(planet) * LEAP_LIFT * LEAP_LIFT;

test('the leap constants the barriers are sized from are the ones the player uses', () => {
  /* THE WHOLE FILE RESTS ON THESE THREE NUMBERS, and two of them are duplicated
   * into world code because `Parkour` and `Climb` export neither. A duplicate
   * that can drift silently is how the yard's comment came to claim a mantle
   * needed 1.55 m when `Climb` had said 1.0 for as long as it had existed. */
  assert.equal(LEAP_LIFT, 1.12, 'Parkour.LEAP_LIFT moved');
  assert.equal(MANTLE_MAX, 2.4, 'Climb.MAX_RISE moved');
  assert.equal(num(SRC_PLANET, 'LEAP_LIFT'), LEAP_LIFT,
    'PlanetWorld sizes the shore wall from a LEAP_LIFT that is not Parkour\'s');
  assert.equal(num(SRC_PLANET, 'MANTLE_MAX'), MANTLE_MAX,
    'PlanetWorld sizes the shore wall from a mantle reach that is not Climb\'s');
  assert.equal(num(SRC_YARD, 'LEAP_LIFT'), LEAP_LIFT,
    'YardPlan sizes the mouth screen from a LEAP_LIFT that is not Parkour\'s');
  assert.equal(num(SRC_YARD, 'MANTLE_MAX'), MANTLE_MAX,
    'YardPlan sizes the mouth screen from a mantle reach that is not Climb\'s');

  console.log(`   leap lift ${LEAP_LIFT} (apex x${(LEAP_LIFT * LEAP_LIFT).toFixed(4)}), mantle reach ${MANTLE_MAX} m`);
  console.log(`   default standing apex ${BASE_APEX.toFixed(3)} m -> running leap ${(BASE_APEX * LEAP_LIFT * LEAP_LIFT).toFixed(3)} m`);
});

/* ================================================================== */
/* 1. THE SHORE, ON EVERY LIQUID PLANET                                */
/* ================================================================== */

function harness(THREE) {
  if (globalThis.__barrierHarness) return;
  globalThis.__barrierHarness = true;
  class Img {
    constructor(a, b, c) {
      if (typeof a === 'number') { this.width = a; this.height = b; this.data = new Uint8ClampedArray(a * b * 4); }
      else { this.data = a; this.width = b; this.height = c ?? 1; }
    }
  }
  const gradient = { addColorStop() {} };
  const context2d = (canvas) => {
    const real = {
      canvas,
      createImageData: (w, h) => new Img(Math.max(1, w | 0), Math.max(1, (h ?? w) | 0)),
      getImageData: (x, y, w, h) => new Img(Math.max(1, w | 0), Math.max(1, h | 0)),
      createLinearGradient: () => gradient, createRadialGradient: () => gradient,
      createConicGradient: () => gradient, createPattern: () => null,
      measureText: () => ({ width: 8 }), getLineDash: () => [],
    };
    return new Proxy(real, { get: (o, k) => (k in o ? o[k] : () => undefined), set: () => true });
  };
  globalThis.ImageData = Img;
  globalThis.requestAnimationFrame = (fn) => setTimeout(() => fn(Date.now()), 0);
  globalThis.document = {
    createElement(tag) { const c = { width: 1, height: 1, style: {}, tagName: tag }; c.getContext = () => context2d(c); return c; },
    createElementNS(_ns, tag) { return this.createElement(tag); },
  };
  globalThis.window = globalThis;
  globalThis.OffscreenCanvas = class { constructor(w, h) { this.width = w; this.height = h; } getContext() { return context2d(this); } };
  const dead = () => ({ texture: null, dispose() {} });
  THREE.PMREMGenerator.prototype.fromEquirectangular = dead;
  THREE.PMREMGenerator.prototype.fromScene = dead;
  THREE.PMREMGenerator.prototype.compileEquirectangularShader = () => {};
}

const _built = new Map();
async function planet(id) {
  if (_built.has(id)) return _built.get(id);
  const THREE = await import('three');
  harness(THREE);
  const { Physics } = await import('../../src/physics/Physics.js');
  const { PlanetWorld } = await import('../../src/worlds/PlanetWorld.js');
  const physics = new Physics();
  const Cls = PlanetWorld.of(PLANETS[id]);
  const world = new Cls({
    physics,
    scene: new THREE.Scene(),
    bus: { on: () => () => {}, emit() {} },
    engine: {
      renderer: {
        capabilities: { getMaxAnisotropy: () => 4, isWebGL2: true },
        initTexture() {}, getContext: () => ({}),
        getRenderTarget: () => null, setRenderTarget() {}, render() {}, clear() {},
      },
      camera: new THREE.PerspectiveCamera(), onFrameUpdate: () => () => {}, onResize: () => () => {},
    },
    materials: { get: () => new THREE.MeshStandardMaterial(), dispose() {} },
  });
  world.physics = physics;
  await world.build(() => {});
  const rec = { world, physics };
  _built.set(id, rec);
  return rec;
}

const LIQUID_IDS = Object.keys(PLANETS).filter((id) => PLANETS[id].liquid?.bodies?.length);

test('every shore post out-tops the running leap FROM THE BANK, not from the water', async () => {
  /* THE MEASUREMENT IS TAKEN OFF THE REAL COLLIDERS AND THE REAL HEIGHT FIELD.
   *
   * Not off the census - a census is the build reporting on itself, and the
   * defect being closed was the build reporting a 2.0 m parapet that was a 0.6 m
   * gate. Each post is read out of `Physics`, its landward side is found from
   * its own nearest waterline, and the ground a body could stand on there is
   * sampled off `world.groundAt` - the same function the collision heightfield
   * was built from. */
  const rows = [];
  const failures = [];
  for (const id of LIQUID_IDS) {
    const { world, physics } = await planet(id);
    const leap = leapApexOn(world.planet);
    /* THE TWO REACHES ADD. The mantle is offered on the jump press and measures
     * its rise from the FEET, so a body that jumps first mantles a ledge one
     * apex higher. Sizing against `max(leap, MAX_RISE)` was the first attempt
     * and Shoal's shore was still crossed on six bearings out of eight, with the
     * peak of every crossing sitting exactly one standing jump above a post top.
     * @see the design block in PlanetWorld.js */
    const need = leap + MANTLE_MAX;

    const posts = physics.colliders.filter((c) => c.userData?.planetLiquidBarrier);
    assert.ok(posts.length > 0, `${id}: no shore posts at all`);

    let worst = Infinity;
    let worstAt = null;
    for (const c of posts) {
      const m = c.matrix.elements;
      const px = m[12];
      const pz = m[14];
      const top = m[13] + c.halfExtents.y;
      /* The ground a leap could come off, within reach of the post on every
       * bearing. The post does not carry its own normal, so all eight are
       * sampled: whichever side the bank is on, this finds it, and sampling the
       * WATER side too can only make the requirement harder rather than easier. */
      let bank = -Infinity;
      for (let k = 0; k < 8; k++) {
        const a = (k / 8) * Math.PI * 2;
        for (const d of [2.0, 3.4, 4.8]) {
          const g = world.groundAt(px + Math.cos(a) * d, pz + Math.sin(a) * d);
          if (Number.isFinite(g) && g > bank) bank = g;
        }
      }
      if (!Number.isFinite(bank)) continue;
      const gate = top - bank;
      if (gate < worst) { worst = gate; worstAt = [px.toFixed(0), bank.toFixed(1), pz.toFixed(0)]; }
    }

    rows.push(`     ${id.padEnd(11)} ${String(posts.length).padStart(4)} posts   leap apex ${leap.toFixed(3)} m`
      + `   mantle ${MANTLE_MAX} m   WORST GATE ${worst.toFixed(2)} m at (${worstAt?.join(', ')})`);
    if (!(worst > need)) {
      failures.push(`${id}: the shortest gate on the shore wall is ${worst.toFixed(2)} m at (${worstAt?.join(', ')}),`
        + ` against a running leap of ${leap.toFixed(3)} m and a mantle reach of ${MANTLE_MAX} m`);
    }
  }
  console.log('   THE SHORE WALL, MEASURED FROM THE BANK A BODY LEAPS OFF');
  for (const r of rows) console.log(r);
  assert.deepEqual(failures, [],
    'a shore wall a running leap clears is a shore wall that is not there - and walking at it will not find out');
});

test('the shore census reports the gate, and no post was clamped short', async () => {
  for (const id of LIQUID_IDS) {
    const { world } = await planet(id);
    const c = world.census.liquid;
    const leap = leapApexOn(world.planet);
    for (const k of ['parapet', 'leapApex', 'worstGate', 'tallestAboveWater', 'clampedPosts']) {
      assert.ok(Number.isFinite(c[k]), `${id}: census.liquid.${k} is ${c[k]}`);
    }
    assert.ok(Math.abs(c.leapApex - leap) < 0.01,
      `${id}: the build thinks the leap apex is ${c.leapApex} m; the player's own numbers say ${leap.toFixed(3)}`);
    assert.ok(c.parapet >= leap + MANTLE_MAX - 1e-9,
      `${id}: clearance ${c.parapet} m is under the ${leap.toFixed(3)} m leap plus the ${MANTLE_MAX} m mantle`
      + ' that follows it - jump, press jump again, and the post top is standing room');
    assert.equal(c.clampedPosts, 0,
      `${id}: ${c.clampedPosts} posts were clamped by WALL_MAX and are shorter than the bank beside them asks for`);
    assert.ok(c.worstGate > leap + MANTLE_MAX,
      `${id}: the build's own worst gate is ${c.worstGate} m`);
  }
});

/* ================================================================== */
/* 2. THE YARD MOUTH                                                   */
/* ================================================================== */

test('the yard mouth screen out-tops the running leap and the mantle', () => {
  /* The yard publishes no gravity, so the player walks in `CONFIG.player`'s own
   * numbers and there is exactly one leap to clear. */
  const leap = BASE_APEX * LEAP_LIFT * LEAP_LIFT;
  assert.ok(Math.abs(MOUTH_LEAP_APEX - leap) < 1e-9,
    `YardPlan thinks the leap apex is ${MOUTH_LEAP_APEX}; the player's numbers say ${leap}`);
  assert.ok(MOUTH_SCREEN_H >= leap + MANTLE_MAX,
    `the mouth screen is ${MOUTH_SCREEN_H} m against a ${leap.toFixed(3)} m running leap followed by a`
    + ` ${MANTLE_MAX} m mantle off the top of it`);
  assert.ok(MOUTH_KERB_H > P.stepHeight,
    'the solid part of the balustrade is inside step height and can be walked over');
  assert.ok(MOUTH_SCREEN_H > MOUTH_KERB_H,
    'the screen has to stand above the kerb it is hung on');
  console.log(`   yard mouth: kerb ${MOUTH_KERB_H} m, screen ${MOUTH_SCREEN_H.toFixed(2)} m,`
    + ` running leap ${leap.toFixed(3)} m, mantle ${MANTLE_MAX} m`);
});

test('the mouth collider IS that tall, everywhere except the pier gates', async () => {
  /* THE PLAN AND THE WORLD ARE TWO DIFFERENT CLAIMS. `MOUTH_SCREEN_H` being
   * right is worth nothing if `_buildMouth` registers a box half that height, so
   * this reads the real colliders out of a real build and marches the whole
   * 164 m threshold at 1 m intervals. The five pier gates are the ROUTE and must
   * stay open; everything between them is the GATE and must be shut. */
  const THREE = await import('three');
  harness(THREE);
  const { Physics } = await import('../../src/physics/Physics.js');
  const { DockWorld } = await import('../../src/worlds/DockWorld.js');
  const physics = new Physics();
  const world = new DockWorld({
    physics,
    scene: new THREE.Scene(),
    bus: { on: () => () => {}, emit() {} },
    engine: {
      renderer: {
        capabilities: { getMaxAnisotropy: () => 4, isWebGL2: true },
        initTexture() {}, getContext: () => ({}),
        getRenderTarget: () => null, setRenderTarget() {}, render() {}, clear() {},
      },
      camera: new THREE.PerspectiveCamera(), onFrameUpdate: () => () => {}, onResize: () => () => {},
    },
    materials: { get: () => new THREE.MeshStandardMaterial(), dispose() {} },
  });
  world.physics = physics;
  await world.build(() => {});

  /* Every box straddling the threshold plane, indexed on x. */
  const bars = [];
  for (const c of physics.colliders) {
    if (!c.solid || c.type !== 'box') continue;
    const m = c.matrix.elements;
    const hz = Math.abs(m[2]) * c.halfExtents.x + Math.abs(m[6]) * c.halfExtents.y + Math.abs(m[10]) * c.halfExtents.z;
    const hx = Math.abs(m[0]) * c.halfExtents.x + Math.abs(m[4]) * c.halfExtents.y + Math.abs(m[8]) * c.halfExtents.z;
    const hy = Math.abs(m[1]) * c.halfExtents.x + Math.abs(m[5]) * c.halfExtents.y + Math.abs(m[9]) * c.halfExtents.z;
    // Within a metre of the threshold, and standing on the deck rather than
    // hanging under the roof.
    if (Math.abs(m[14] - MOUTH_Z) > 1.6 + hz) continue;
    if (m[13] - hy > DECK_Y + P.stepHeight) continue;
    bars.push({ x0: m[12] - hx, x1: m[12] + hx, top: m[13] + hy });
  }

  const gates = PIERS.map((p) => [p.x - PIER_GATE_HW, p.x + PIER_GATE_HW]);
  const inGate = (x) => gates.some(([a, b]) => x >= a - 0.5 && x <= b + 0.5);
  const leap = BASE_APEX * LEAP_LIFT * LEAP_LIFT;
  const need = leap + MANTLE_MAX;

  const holes = [];
  let openGates = 0;
  let lowest = Infinity;
  for (let x = -MOUTH_HW + 0.5; x <= MOUTH_HW - 0.5; x += 1) {
    let top = -Infinity;
    for (const b of bars) if (x >= b.x0 && x <= b.x1 && b.top > top) top = b.top;
    const height = Number.isFinite(top) ? top - DECK_Y : 0;
    if (inGate(x)) { if (height <= P.stepHeight) openGates++; continue; }
    if (height < lowest) lowest = height;
    if (!(height > need)) holes.push(`x ${x.toFixed(0)}: ${height.toFixed(2)} m`);
  }

  console.log(`   yard mouth threshold marched at 1 m: lowest solid ${lowest.toFixed(2)} m over ${(MOUTH_HW * 2).toFixed(0)} m,`
    + ` need > ${need.toFixed(3)} m; ${openGates} m of open pier gate`);
  assert.deepEqual(holes.slice(0, 12), [],
    'a stretch of the mouth threshold is under the running leap - sprint+jump goes through there into vacuum');
  assert.ok(openGates >= PIERS.length * PIER_GATE_HW,
    'the pier gates have been fenced - the screen has closed the route as well as the hole');
  world.dispose?.();
});
