import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { CONFIG } from '../../src/core/Config.js';
import { PLANETS } from '../../src/worlds/planets/index.js';
import { worldGravityRatio } from '../../src/worlds/WorldRules.js';
import { liquidSwimmable, liquidGuards } from '../../src/worlds/planets/PlanetLiquid.js';
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
 *   THAT SHORE NO LONGER EXISTS. Shoal's sea is swimmable, so getting into it
 *   is the point rather than the defect, and the 3,122 posts that used to
 *   fence it are down to the 683 that guard Sundering Head. The measurement
 *   above is kept because it is still what a wall has to survive - it is just
 *   that far fewer places now need one. See `WALLED_IDS` below.
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
/** `PlanetWorld.POST_HALF`: half-depth of a shore station's PLINTH. */
const POST_HALF = num(SRC_PLANET, 'POST_HALF');
/** `PlanetWorld.CAP_HALF`: half-depth of the CAP that carries the wall's top. */
const CAP_HALF = num(SRC_PLANET, 'CAP_HALF');

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

/**
 * The shores that are still supposed to stop a body, and the ones that are not.
 *
 * When this file was written every waterline in the game was fenced, so
 * "liquid planet" and "walled planet" were the same list. They are not any
 * more: water is entered and swum, and the fence survives round LETHAL liquid
 * (Cinder's lava, Sallow's acid, which now burn as well as block) and round
 * the one stretch of swimmable shore a descriptor declares a guard on (Shoal's
 * Sundering Head).
 *
 * Derived rather than listed, so a descriptor that turns `lethal` on or off,
 * or adds a guard, moves this list with it instead of going quietly red.
 * @see ../../src/worlds/planets/PlanetLiquid.js `liquidWalled`
 */
const WALLED_IDS = LIQUID_IDS.filter(
  (id) => !liquidSwimmable(PLANETS[id].liquid) || liquidGuards(PLANETS[id].liquid).length > 0
);
const OPEN_IDS = LIQUID_IDS.filter((id) => !WALLED_IDS.includes(id));

test('a shore with nothing to guard has no wall on it at all', async () => {
  /* THE COUNTERWEIGHT to every case in this file. A wall that is not there
   * cannot be leapt, and 5,362 of the system's 6,829 shore posts are now not
   * there - 3,122 of them round an ocean, 1,500 round a river 1.21 m deep and
   * 442 round two brine pans 38 cm deep. This asserts they stayed gone. */
  assert.ok(OPEN_IDS.length > 0, 'every liquid in the game is still fenced');
  for (const id of OPEN_IDS) {
    const { world, physics } = await planet(id);
    const posts = physics.colliders.filter((c) => c.userData?.planetLiquidBarrier);
    assert.equal(posts.length, 0,
      `${id}: ${posts.length} shore posts on a shore that is swimmable and unguarded`);
    assert.equal(world.census.liquid.barrierPosts, 0);
    assert.equal(world.rules.swim, true, `${id}: an unwalled shore that cannot be swum is a hole, not a beach`);
  }
  console.log(`   open shores: ${OPEN_IDS.join(', ')}   walled: ${WALLED_IDS.join(', ')}`);
});

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
  for (const id of WALLED_IDS) {
    const { world, physics } = await planet(id);
    const leap = leapApexOn(world.planet);
    /* THE TWO REACHES ADD. The mantle is offered on the jump press and measures
     * its rise from the FEET, so a body that jumps first mantles a ledge one
     * apex higher. Sizing against `max(leap, MAX_RISE)` was the first attempt
     * and Shoal's shore was still crossed on six bearings out of eight, with the
     * peak of every crossing sitting exactly one standing jump above a post top.
     * @see the design block in PlanetWorld.js */
    const need = leap + MANTLE_MAX;

    /* ── THE GATE IS THE CAP'S TOP, AND ONLY THE CAP'S ─────────────────
     *
     * A shore station is two members now: a 2.2 m PLINTH that stops a body
     * walking, and a 0.5 m CAP that carries the top of the wall and refuses a
     * free climber's mantle because there is nowhere on half a metre to put
     * one. The plinth deliberately stops at head height, so measuring ITS top
     * against a running leap would be measuring the wrong member and would
     * fail on a wall that holds.
     *
     * Nothing goes unmeasured for that: the plinths are asserted below, on the
     * property that is theirs - that every one of them is capped, and that the
     * cap over it is the thing this case measures.
     * @see src/worlds/PlanetWorld.js, the design block above POST_HALF */
    const all = physics.colliders.filter((c) => c.userData?.planetLiquidBarrier);
    const posts = all.filter((c) => c.userData?.barrierCap);
    const plinths = all.filter((c) => !c.userData?.barrierCap);
    assert.ok(posts.length > 0, `${id}: no shore posts at all`);
    assert.equal(posts.length, plinths.length,
      `${id}: ${posts.length} caps against ${plinths.length} plinths - a station is missing a member`);

    /* EVERY PLINTH IS CAPPED. A plinth on its own is a 2.2 m square top with
     * standing room on it, which is exactly the shape this whole change exists
     * to delete, so "there is a cap directly over it" is the plinth's own
     * invariant and it is checked here rather than assumed. */
    const capAt = new Map();
    for (const c of posts) {
      const m = c.matrix.elements;
      capAt.set(`${m[12].toFixed(3)}/${m[14].toFixed(3)}`, c);
    }
    let orphans = 0;
    for (const c of plinths) {
      const m = c.matrix.elements;
      const pTop = m[13] + c.halfExtents.y;
      let found = null;
      for (const [, cap] of capAt) {
        const cm = cap.matrix.elements;
        if (Math.hypot(cm[12] - m[12], cm[14] - m[14]) > POST_HALF) continue;
        if (Math.abs((cm[13] - cap.halfExtents.y) - pTop) > 0.02) continue;
        found = cap;
        break;
      }
      if (!found) orphans++;
    }
    assert.equal(orphans, 0,
      `${id}: ${orphans} plinths have no cap sitting on them - a bare plinth top is 2.2 m of standing room`);

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
  for (const id of WALLED_IDS) {
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

/* ================================================================== */
/* 3. THE PIERS                                                        */
/* ================================================================== */

test('every pier edge out-tops the running leap and the mantle, all 900 m of it', async () => {
  /* THE SAME DEFECT AS THE MOUTH, LEFT OPEN WHEN THE MOUTH WAS CLOSED.
   *
   * The agent that raised the mouth screen wrote the note this case exists to
   * answer: "the pier rails (RAIL_H 1.1 m) are the same defect as the mouth
   * was. I only touched the mouth." They were. `dock-reach` leaned on the
   * sentence "a player who gets over a pier rail is recovered rather than
   * lost" - which is exactly the sentence the mouth's own comment carried while
   * sprint+jump crossed it at ten positions out of ten - and the piers run out
   * into open space, so going over one is a fall into the void with a rescue
   * system for an edge treatment.
   *
   * DRIVEN, before the fix, with real key events at five piers and two jump
   * phases each (`.probe/pier-drive.mjs`):
   *
   *     walk          held at 5 of 5.                the case that always passed
   *     sprint+jump   OVER at 23 of 40, into the void.
   *
   * This is the mouth's own march moved onto the piers: the real colliders out
   * of a real build, walked along every metre of every rail line, requiring a
   * solid standing on the deck whose top clears the running leap PLUS the
   * mantle that follows it. The one opening that must stay open is the gate in
   * each pad's bay-side run, which is where the spine arrives.
   *
   * MUTATION: put `h: RAIL_H` back on any one of the six `railRun` calls in
   * `_buildPiers` and this reports that run, metre by metre.
   */
  const THREE = await import('three');
  harness(THREE);
  const { Physics } = await import('../../src/physics/Physics.js');
  const { DockWorld } = await import('../../src/worlds/DockWorld.js');
  const PLAN = await import('../../src/worlds/dock/YardPlan.js');
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

  /* Every solid box that stands ON the pier deck, by its axis-aligned bounds.
   * Nothing here is rotated; if one ever is, this over-estimates its footprint,
   * which can only hide a hole rather than invent one - so the console line
   * below prints the lowest guard found as well as the failures. */
  const boxes = [];
  for (const c of physics.colliders) {
    if (!c.solid || c.type !== 'box') continue;
    const m = c.matrix.elements;
    const hx = Math.abs(m[0]) * c.halfExtents.x + Math.abs(m[4]) * c.halfExtents.y + Math.abs(m[8]) * c.halfExtents.z;
    const hy = Math.abs(m[1]) * c.halfExtents.x + Math.abs(m[5]) * c.halfExtents.y + Math.abs(m[9]) * c.halfExtents.z;
    const hz = Math.abs(m[2]) * c.halfExtents.x + Math.abs(m[6]) * c.halfExtents.y + Math.abs(m[10]) * c.halfExtents.z;
    if (m[14] + hz > PLAN.MOUTH_Z + 1) continue;             // north of the mouth only
    if (m[13] - hy > DECK_Y + P.stepHeight) continue;        // standing on the deck
    if (m[13] + hy < DECK_Y + 0.3) continue;                 // not the deck slab itself
    boxes.push({ x0: m[12] - hx, x1: m[12] + hx, z0: m[14] - hz, z1: m[14] + hz, top: m[13] + hy });
  }
  assert.ok(boxes.length > 20, `only ${boxes.length} guard boxes north of the mouth - the sampler is missing them`);

  /** The tallest solid standing over (x, z), as a height above the deck. */
  const guard = (x, z) => {
    let top = -Infinity;
    for (const b of boxes) {
      if (x < b.x0 - 0.12 || x > b.x1 + 0.12 || z < b.z0 - 0.12 || z > b.z1 + 0.12) continue;
      if (b.top > top) top = b.top;
    }
    return Number.isFinite(top) ? top - DECK_Y : 0;
  };

  const leap = BASE_APEX * LEAP_LIFT * LEAP_LIFT;
  const need = leap + MANTLE_MAX;
  const holes = [];
  let lowest = Infinity;
  let stations = 0;
  let gateOpen = 0;

  for (const p of PLAN.PIERS) {
    const pad = PLAN.pierPad(p);
    /** One rail line: `axis` is the direction it runs, `fixed` the other. */
    const line = (o) => {
      for (let t = o.a + 0.5; t <= o.b - 0.5; t += 1) {
        const x = o.axis === 'x' ? t : o.fixed;
        const z = o.axis === 'x' ? o.fixed : t;
        const h = guard(x, z);
        if (o.gate && Math.abs(x - p.x) <= PIER_GATE_HW) {
          // The route through, where the spine arrives. It must NOT be fenced.
          if (h <= P.stepHeight) gateOpen++;
          continue;
        }
        stations++;
        if (h < lowest) lowest = h;
        if (!(h > need)) holes.push(`${p.id} ${o.name} at (${x.toFixed(0)}, ${z.toFixed(0)}): ${h.toFixed(2)} m`);
      }
    };
    for (const s of [-1, 1]) {
      line({ name: `spine ${s > 0 ? '+X' : '-X'}`, axis: 'z', a: pad.z0, b: PLAN.MOUTH_Z, fixed: p.x + s * PLAN.PIER_HW });
      line({ name: `pad ${s > 0 ? '+X' : '-X'}`, axis: 'z', a: pad.z1, b: pad.z0, fixed: p.x + s * p.hw });
    }
    line({ name: 'pad far', axis: 'x', a: p.x - p.hw, b: p.x + p.hw, fixed: pad.z1 });
    line({ name: 'pad near', axis: 'x', a: p.x - p.hw, b: p.x + p.hw, fixed: pad.z0, gate: true });
  }

  console.log(`   the piers marched at 1 m: ${stations} stations on ${PLAN.PIERS.length} piers,`
    + ` lowest guard ${lowest.toFixed(2)} m, need > ${need.toFixed(3)} m,`
    + ` ${gateOpen} m of open spine gate; VOID_GUARD_H ${PLAN.VOID_GUARD_H.toFixed(2)} m`);
  assert.deepEqual(holes.slice(0, 12), [],
    `floor: 0 stations of pier edge under the running leap plus the mantle. achieved: ${holes.length}\n  `
    + holes.slice(0, 12).join('\n  '));
  assert.ok(gateOpen >= PLAN.PIERS.length * 3,
    'the spine gates have been fenced - the guard has closed the route as well as the hole');
  world.dispose?.();
});

test('the yard has ONE height for a guard with vacuum behind it', async () => {
  /* The mouth and the piers are the same defect and must not be able to drift
   * into two different answers. `MOUTH_SCREEN_H` IS `VOID_GUARD_H` - not a
   * number that happens to equal it - and a handrail is still a handrail. */
  const PLAN = await import('../../src/worlds/dock/YardPlan.js');
  assert.equal(PLAN.MOUTH_SCREEN_H, PLAN.VOID_GUARD_H,
    'the mouth screen has been given a height of its own again');
  assert.ok(PLAN.VOID_GUARD_H > BASE_APEX * LEAP_LIFT * LEAP_LIFT + MANTLE_MAX,
    `VOID_GUARD_H ${PLAN.VOID_GUARD_H} does not clear the leap plus the mantle`);
});

/* ================================================================== */
/* 4. FREE CLIMBING, AND THE ONE THING THAT DOES CLOSE IT              */
/* ================================================================== */

test('no guard in the yard has a top a mantle can land on', async () => {
  /* ═══════════════════════════════════════════════════════════════════════
   *  THE FREE-CLIMB QUESTION, DECIDED.
   * ═══════════════════════════════════════════════════════════════════════
   *
   * `FreeClimb` grabs any vertical face with Space held and every world here
   * publishes `climb: true`, so NO HEIGHT closes it - that much is true and is
   * deliberate: it is the mechanic the citadel is built around, not a hole in a
   * wall, and the file above says so.
   *
   * What is NOT true is that nothing closes it. A free climb does not end by
   * itself: `FreeClimb` tops out at the lip and hands off to `Climb.tryStart`,
   * because getting OVER a lip is the scripted hoist `Climb` already does. And
   * `Climb._probe` step 4 will only complete a hoist onto REAL STANDING ROOM -
   * it seats a test capsule `radius + LAND_INSET` inboard of the face it
   * climbed and requires the solver to report it grounded there. A guard
   * thinner than that reach has no top for the capsule to be seated on, so the
   * mantle is refused and the climber hangs at the lip until they let go.
   *
   * THAT is what actually held the mouth. Driven with Space held for nine
   * seconds at six positions, the 3.92 m screen was crossed 0 times - and the
   * 2.70 m version of it, before the leap-plus-mantle sum was understood, was
   * crossed 0 times too, because the screen is 0.5 m deep and there is nowhere
   * on top of half a metre of rail to put a body. The same run at the piers,
   * whose runs are 0.18 m deep: held, at a peak of 3.3 m.
   *
   * The shore wall was the counter-example that proved it is depth and not
   * height: `POST_HALF` is 1.1, so a shore post used to be 2.2 m square and DID
   * have a standable top, and it was the one shape in the game a sustained
   * climb still got over. It is not built that way any more - the case below
   * this one asserts the shore on the same terms - and this is the case that
   * keeps the yard so.
   *
   * So no `noGrip` flag, and the decision is recorded rather than assumed: a
   * second invisible rule saying "some walls refuse to be climbed" would be a
   * new mechanic across every world, for a defect that measurement says these
   * guards do not have. What is asserted instead is the structural property
   * they hold BY, so a guard that ever gets thick enough to stand on reports
   * itself here rather than in a playthrough.
   */
  const PLAN = await import('../../src/worlds/dock/YardPlan.js');
  /** `Climb.LAND_INSET`: how far inboard of the face the hoist tries to land. */
  const LAND_INSET = num(SRC_CLIMB, 'LAND_INSET');
  /** The whole reach from the climbed face to the landing capsule's centre. */
  const landing = P.radius + LAND_INSET;

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

  const thick = [];
  let count = 0;
  let widest = 0;
  for (const c of physics.colliders) {
    if (!c.solid || c.type !== 'box') continue;
    const m = c.matrix.elements;
    const hx = Math.abs(m[0]) * c.halfExtents.x + Math.abs(m[4]) * c.halfExtents.y + Math.abs(m[8]) * c.halfExtents.z;
    const hy = Math.abs(m[1]) * c.halfExtents.x + Math.abs(m[5]) * c.halfExtents.y + Math.abs(m[9]) * c.halfExtents.z;
    const hz = Math.abs(m[2]) * c.halfExtents.x + Math.abs(m[6]) * c.halfExtents.y + Math.abs(m[10]) * c.halfExtents.z;
    // Only the VOID guards: standing on the deck, as tall as the rule asks.
    if (m[13] - hy > DECK_Y + P.stepHeight) continue;
    if (Math.abs((m[13] + hy) - (DECK_Y + PLAN.VOID_GUARD_H)) > 0.02) continue;
    count++;
    const depth = Math.min(hx, hz) * 2;
    if (depth > widest) widest = depth;
    if (depth >= landing) {
      thick.push(`a guard at (${m[12].toFixed(0)}, ${m[14].toFixed(0)}) is ${depth.toFixed(2)} m deep`);
    }
  }

  console.log(`   ${count} void guards in the yard, deepest ${widest.toFixed(2)} m,`
    + ` against a ${landing.toFixed(2)} m mantle landing reach - a free climb tops out and finds nothing to stand on`);
  assert.ok(count >= 30, `only ${count} guards at VOID_GUARD_H - the sampler is missing them`);
  assert.deepEqual(thick, [],
    'a void guard is now deep enough for Climb to land a hoist on its top, which is the one thing that '
    + 'lets a sustained free climb get OVER it rather than hang off it');
  world.dispose?.();
});

test('no shore cap has a top a mantle can land on either', async () => {
  /* ═══════════════════════════════════════════════════════════════════════
   *  THE SHORE JOINS THE SET ABOVE.
   * ═══════════════════════════════════════════════════════════════════════
   *
   * The case above used to end by naming the shore wall as the one shape in
   * the game that did NOT hold by this property: `POST_HALF` 1.1 made a post
   * 2.2 m square, its top was standing room, and a held-Space climb was hoisted
   * onto it and over. The wall is two members now - a 2.2 m plinth for
   * thickness, stopped at head height, and a 0.50 m cap carrying the gate - and
   * this asserts the cap on exactly the terms the yard's guards are asserted
   * on.
   *
   * ── AND THE THRESHOLD IS MEASURED, NOT ASSUMED ────────────────────────
   * 0.77 m is the LANDING REACH and it is not the depth at which a hoist stops
   * completing. The test capsule's lower sphere centre sits 0.32 m above the
   * top face, so it still catches the far top EDGE of a box narrower than the
   * reach. `.probe/mantle-depth.mjs` sweeps the depth through the real
   * `Physics.resolveCapsule` with the real player constants and finds the knee
   * between 0.60 m (refused) and 0.65 m (completed). The bar asserted here is
   * that knee rather than the reach, because a 0.70 m cap would pass a naive
   * "under 0.77" test and be climbable.
   */
  const LAND_INSET = num(SRC_CLIMB, 'LAND_INSET');
  const landing = P.radius + LAND_INSET;
  /** The measured knee. @see .probe/mantle-depth.mjs */
  const KNEE = 0.63;
  assert.ok(landing > KNEE, 'the landing reach is now under the knee - one of the two numbers moved');
  assert.ok(CAP_HALF * 2 < KNEE,
    `PlanetWorld.CAP_HALF makes a ${(CAP_HALF * 2).toFixed(2)} m cap, at or over the ${KNEE} m depth`
    + ' at which a hoist starts completing again');

  const rows = [];
  for (const id of WALLED_IDS) {
    const { world, physics } = await planet(id);
    const all = physics.colliders.filter((c) => c.userData?.planetLiquidBarrier);
    const caps = all.filter((c) => c.userData?.barrierCap);
    assert.ok(caps.length > 0, `${id}: no shore caps at all`);

    let wallTop = -Infinity;
    for (const c of caps) wallTop = Math.max(wallTop, c.matrix.elements[13] + c.halfExtents.y);
    const thick = [];
    let widest = 0;
    let shortest = Infinity;
    for (const c of caps) {
      const m = c.matrix.elements;
      const depth = Math.min(c.halfExtents.x, c.halfExtents.z) * 2;
      widest = Math.max(widest, depth);
      shortest = Math.min(shortest, c.halfExtents.y * 2);
      if (depth >= KNEE) thick.push(`a cap at (${m[12].toFixed(0)}, ${m[14].toFixed(0)}) is ${depth.toFixed(2)} m deep`);
    }
    assert.deepEqual(thick, [],
      `${id}: a shore cap is deep enough for Climb to land a hoist on its top, which is the one input `
      + 'that got a body over this wall while 2,500 tests were green');

    /* NOTHING FAT REACHES THE TOP. Every plinth has to stop clear of the cap it
     * carries, by enough that a climber who tops out on a cap and reaches
     * 0.77 m inboard finds the plinth OUT OF RANGE below rather than under
     * their feet: `Climb._probe` accepts a landing down to `topY - 0.35`. */
    let high = 0;
    for (const c of all) {
      if (c.userData?.barrierCap) continue;
      const top = c.matrix.elements[13] + c.halfExtents.y;
      if (top > wallTop - 0.35) high++;
    }
    assert.equal(high, 0,
      `${id}: ${high} plinths reach within 0.35 m of the top of the wall - a hoist that tops out on a `
      + 'cap lands 0.77 m inboard, and at that height the plinth top would be standing room again');

    rows.push(`     ${id.padEnd(11)} ${String(caps.length).padStart(4)} caps, deepest ${widest.toFixed(2)} m,`
      + ` shortest ${shortest.toFixed(2)} m tall, against a ${landing.toFixed(2)} m landing reach`
      + ` and a ${KNEE} m measured knee`);
  }
  console.log('   THE SHORE WALL HOLDS BY DEPTH, THE SAME WAY THE YARD DOES');
  for (const r of rows) console.log(r);
});
