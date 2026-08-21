import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';

/**
 * THE WALKABLE ENVELOPE, AND THE ONE THE PROBES WERE USING.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 *  THE DEFECT THIS FILE WAS WRITTEN FOR
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Ten planets are designed around one rule: **the exotic ore is a SECOND
 * LANDING, not a longer walk.** It must be unreachable on foot from the
 * primary pad at any distance, and reachable only from its own pad down a
 * purpose-built road. Cinder established it (iridite 0-of-9 from Ashfall Flat,
 * reachable only from Rimhold Shelf down the spiral) and nine more planets
 * copied it. Every author verified it by flooding a walk lattice.
 *
 * They all verified it with the wrong number.
 *
 *   - The probes flood at **38 deg** of continuous slope
 *     (`planet-reach.test.mjs` `SLOPE_MAX_DEG`, `planet-minerals.test.mjs`
 *     `MAX_SLOPE_TAN`).
 *   - What the game stands on is `WALKABLE_NORMAL_Y = 0.55` in
 *     `src/npc/Grounding.js`, i.e. **acos(0.55) = 56.63 deg**.
 *
 * That is 18.6 degrees of slope the probes treat as a wall and the shipped
 * game walks straight up. A probe measuring something the game does not do is
 * worse than no probe, because it reports confidence.
 *
 * And a second multiplier landed with per-world gravity: the jump apex now
 * varies by planet, from 0.87 m on Verdigris to 1.70 m on Tessera. A big jump
 * reaches a ledge a walk cannot.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 *  WHAT THIS FILE DOES ABOUT IT
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Three envelopes, all three named, all three measured, on every planet:
 *
 *   (a) `LEGACY`  38 deg, no jump          - what the ten authors measured.
 *   (b) `REAL`    acos(WALKABLE_NORMAL_Y), no jump - what the game walks.
 *   (c) `REAL_JUMP`  (b) plus the planet's own jump, whose apex and hang time
 *       come out of a real `Player` handed the planet's real gravity.
 *
 * The `REAL` envelope is DERIVED from the game's own constant and never
 * re-typed: `SLOPE.REAL.deg` is `acos(WALKABLE_NORMAL_Y) * 180 / PI`. The
 * `LEGACY` one is kept, named and pinned, because it is deliberately
 * conservative for a different question - `Physics.resolveCapsule` degrades
 * past ~44 deg for a MOVING capsule, so 38 is the floor of what a walk is
 * certain to cross, while 56.63 is the ceiling of what the solver will let a
 * body stand on. **A GATE has to hold at the ceiling. A ROUTE has to work at
 * the floor.** Confusing the two is the whole defect.
 *
 * The first case below asserts the game constant has not drifted away from
 * what `SLOPE.REAL` computes, so this can never silently go stale again.
 *
 * ── What is NOT modelled ─────────────────────────────────────────────────
 * No mantle, no climb, no ladder. Liquid is not a floor, on any planet - the
 * same concession `planet-reach.test.mjs` makes. Sprint is not modelled in the
 * jump hop either; the hop reach uses `CONFIG.player.walkSpeed`, and the
 * sprint figure is PRINTED next to it so the difference is visible rather than
 * assumed away.
 */

/* ================================================================== */
/* 0. The three envelopes                                              */
/* ================================================================== */

import { CONFIG } from '../../src/core/Config.js';
import { WALKABLE_NORMAL_Y } from '../../src/npc/Grounding.js';

/** Lattice pitch, metres. Same 2.0 as the two probes this file audits. */
const PITCH = 2.0;
/** `CONFIG.player.stepHeight`, read and not re-typed. */
const STEP_UP = CONFIG.player.stepHeight;
/** The tallest drop a WALK edge may use. Under the ~7.5 m damage threshold. */
const DROP_MAX = 3.0;
/** Clear air a surface needs to be standing room. Capsule 1.75 m plus 15 cm. */
const HEADROOM = 1.9;
/** How close a flooded lattice node has to be to count as arriving. */
const ARRIVE = 3.2;

/**
 * The two slope ceilings, both named, so nobody mistakes one for the other.
 *
 * `LEGACY` is a claim about a MOVING capsule and `REAL` is a claim about a
 * STANDING one, and they are different numbers because `resolveCapsule`'s
 * closest-point iteration stops reporting the true face normal past ~44 deg.
 * @see ../../src/npc/Grounding.js `WALKABLE_NORMAL_Y`
 * @see ../../src/physics/Physics.js `resolveCapsule`
 */
export const SLOPE = Object.freeze({
  /** What `planet-reach` and `planet-minerals` flood at today. */
  LEGACY: Object.freeze({ name: 'legacy', deg: 38 }),
  /** What `Grounding` lets a body stand on. Derived, never typed. */
  REAL: Object.freeze({ name: 'real', deg: (Math.acos(WALKABLE_NORMAL_Y) * 180) / Math.PI }),
});

/** @param {number} deg */
const tanOf = (deg) => Math.tan((deg * Math.PI) / 180);

/* ================================================================== */
/* 1. The game constant has not drifted                                */
/* ================================================================== */

test('the probes and the game agree on what a body can stand on', () => {
  assert.ok(Number.isFinite(WALKABLE_NORMAL_Y) && WALKABLE_NORMAL_Y > 0 && WALKABLE_NORMAL_Y < 1,
    `WALKABLE_NORMAL_Y is ${WALKABLE_NORMAL_Y}, which is not a normal component`);
  assert.ok(Math.abs(SLOPE.REAL.deg - 56.633) < 0.01,
    `Grounding.WALKABLE_NORMAL_Y moved: acos(${WALKABLE_NORMAL_Y}) is now ${SLOPE.REAL.deg.toFixed(3)} deg, not 56.633.`
    + ' Every gate on every planet was authored against the old figure - re-run the table below before'
    + ' changing this assertion, because a shallower ceiling makes gates hold that should not and a'
    + ' steeper one opens gates that were closed.');
  assert.ok(SLOPE.REAL.deg > SLOPE.LEGACY.deg,
    'the legacy envelope is no longer the conservative one, so its name is now a lie');
  assert.equal(STEP_UP, 0.45, 'CONFIG.player.stepHeight moved; the two probes hard-code 0.45');
  console.log(`   legacy ${SLOPE.LEGACY.deg.toFixed(2)} deg (tan ${tanOf(SLOPE.LEGACY.deg).toFixed(4)})`
    + `   real acos(${WALKABLE_NORMAL_Y}) = ${SLOPE.REAL.deg.toFixed(2)} deg (tan ${tanOf(SLOPE.REAL.deg).toFixed(4)})`
    + `   gap ${(SLOPE.REAL.deg - SLOPE.LEGACY.deg).toFixed(2)} deg`);
});

/**
 * And the two probes this file audits still flood at a NAMED envelope.
 *
 * Read out of their source rather than imported, because neither exports its
 * constants and neither should have to. The rule is not "38" - it is that the
 * degree figure in a reach probe must be one of the two envelopes named above.
 * Generalise those files to `SLOPE.REAL` and this case stays green. Type a
 * third number into either of them and it goes red naming the file, which is
 * the whole point: the defect was never a wrong constant, it was an UNNAMED
 * one that nobody could compare against the game's.
 */
test('no reach probe floods at a slope that is neither envelope', async () => {
  const { readFile } = await import('node:fs/promises');
  const named = [SLOPE.LEGACY, SLOPE.REAL];
  const probes = ['planet-reach.test.mjs', 'planet-minerals.test.mjs'];
  for (const file of probes) {
    let src;
    try { src = await readFile(new URL(file, import.meta.url), 'utf8'); } catch { continue; }
    /* Both spellings the two files use today, and the one they would use if
     * they were driven from `WALKABLE_NORMAL_Y` instead. */
    const found = new Set();
    for (const m of src.matchAll(/SLOPE_MAX_DEG\s*=\s*([\d.]+)/g)) found.add(Number(m[1]));
    for (const m of src.matchAll(/Math\.tan\(\(\s*([\d.]+)\s*\*\s*Math\.PI\s*\)\s*\/\s*180\s*\)/g)) found.add(Number(m[1]));
    for (const deg of found) {
      const hit = named.find((e) => Math.abs(e.deg - deg) < 0.05);
      assert.ok(hit, `${file} floods at ${deg} deg, which is neither of the two named envelopes`
        + ` (${SLOPE.LEGACY.name} ${SLOPE.LEGACY.deg}, ${SLOPE.REAL.name} ${SLOPE.REAL.deg.toFixed(2)}).`
        + ' A reach probe measuring a slope nothing in the game is defined by is worse than no probe,'
        + ' because it reports confidence. Name the envelope or use one of these two.');
      console.log(`   ${file.padEnd(28)} floods at ${deg} deg = the ${hit.name} envelope`);
    }
    assert.ok(found.size > 0, `${file} no longer declares a slope ceiling this case can find`
      + ' - it was renamed or removed, and this audit is now measuring nothing');
  }
  console.log(`   a gate is checked against ${SLOPE.REAL.name} (${SLOPE.REAL.deg.toFixed(2)} deg, the ceiling);`
    + ` a route is checked against ${SLOPE.LEGACY.name} (${SLOPE.LEGACY.deg} deg, the floor)`);
});

/* ================================================================== */
/* 2. A world, built without a browser                                 */
/* ================================================================== */

function harness() {
  if (globalThis.__planetEnvelopeHarness) return;
  globalThis.__planetEnvelopeHarness = true;
  class Img {
    constructor(a, b, c) {
      if (typeof a === 'number') { this.width = a; this.height = b; this.data = new Uint8ClampedArray(a * b * 4); }
      else { this.data = a; this.width = b; this.height = c ?? 1; }
    }
  }
  const gradient = { addColorStop() {} };
  const context2d = (canvas) => new Proxy({
    canvas,
    createImageData: (w, h) => new Img(Math.max(1, w | 0), Math.max(1, (h ?? w) | 0)),
    getImageData: (x, y, w, h) => new Img(Math.max(1, w | 0), Math.max(1, h | 0)),
    createLinearGradient: () => gradient,
    createRadialGradient: () => gradient,
    createConicGradient: () => gradient,
    createPattern: () => null,
    measureText: () => ({ width: 8 }),
    getLineDash: () => [],
  }, { get: (o, k) => (k in o ? o[k] : () => undefined), set: () => true });
  globalThis.ImageData ??= Img;
  globalThis.requestAnimationFrame ??= (fn) => setTimeout(() => fn(Date.now()), 0);
  globalThis.document ??= {
    hidden: false, getElementById: () => null, querySelector: () => null,
    createElement(tag) { const c = { width: 1, height: 1, style: {}, tagName: tag }; c.getContext = () => context2d(c); return c; },
    createElementNS(_ns, tag) { return this.createElement(tag); },
  };
  globalThis.window ??= globalThis;
  globalThis.OffscreenCanvas ??= class { constructor(w, h) { this.width = w; this.height = h; } getContext() { return context2d(this); } };
  const dead = () => ({ texture: null, dispose() {} });
  THREE.PMREMGenerator.prototype.fromEquirectangular = dead;
  THREE.PMREMGenerator.prototype.fromScene = dead;
  THREE.PMREMGenerator.prototype.compileEquirectangularShader = () => {};
}
harness();

const { Physics, COLLISION_LAYER } = await import('../../src/physics/Physics.js');
const { PlanetWorld } = await import('../../src/worlds/PlanetWorld.js');
const { PLANETS } = await import('../../src/worlds/planets/index.js');
const { polyDist } = await import('../../src/worlds/planets/Placement.js');
const { Player } = await import('../../src/player/Player.js');

/** Build one planet for real: real physics, real colliders, real node placement. */
async function buildPlanet(id) {
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
  return { world, physics };
}

/** Every solid world box, indexed on XZ. Straight out of `physics.colliders`. */
function boxIndex(physics) {
  const cell = 8;
  const grid = new Map();
  for (const c of physics.colliders) {
    if (!c.solid) continue;
    if ((c.layer & COLLISION_LAYER.WORLD) === 0) continue;
    if (c.type !== 'box') continue;
    const m = c.matrix.elements;
    const b = {
      x: m[12], y: m[13], z: m[14],
      ax: Math.abs(m[0]) * c.halfExtents.x + Math.abs(m[4]) * c.halfExtents.y + Math.abs(m[8]) * c.halfExtents.z,
      ay: Math.abs(m[1]) * c.halfExtents.x + Math.abs(m[5]) * c.halfExtents.y + Math.abs(m[9]) * c.halfExtents.z,
      az: Math.abs(m[2]) * c.halfExtents.x + Math.abs(m[6]) * c.halfExtents.y + Math.abs(m[10]) * c.halfExtents.z,
    };
    const x0 = Math.floor((b.x - b.ax) / cell); const x1 = Math.floor((b.x + b.ax) / cell);
    const z0 = Math.floor((b.z - b.az) / cell); const z1 = Math.floor((b.z + b.az) / cell);
    for (let cx = x0; cx <= x1; cx++) {
      for (let cz = z0; cz <= z1; cz++) {
        const k = ((cx + 4096) << 13) | (cz + 4096);
        let list = grid.get(k);
        if (!list) grid.set(k, (list = []));
        list.push(b);
      }
    }
  }
  return (x, z, groundY) => {
    const k = ((Math.floor(x / cell) + 4096) << 13) | (Math.floor(z / cell) + 4096);
    const list = grid.get(k);
    if (!list) return false;
    for (const b of list) {
      if (Math.abs(x - b.x) > b.ax || Math.abs(z - b.z) > b.az) continue;
      if (b.y + b.ay <= groundY + STEP_UP) continue;
      if (b.y - b.ay >= groundY + HEADROOM) continue;
      return true;
    }
    return false;
  };
}

/** True where the descriptor's liquid covers the ground. Liquid is not a floor. */
function liquidMask(planet) {
  const bodies = planet.liquid?.bodies ?? [];
  if (!bodies.length) return () => false;
  return (x, z, y) => {
    for (const b of bodies) {
      if (b.shape === 'disc') { if (Math.hypot(x - b.x, z - b.z) <= b.r && y < b.y + 0.6) return true; }
      else if (polyDist(x, z, b.pts) <= b.width * 0.5 && y < Math.max(b.y0, b.y1) + 0.6) return true;
    }
    return false;
  };
}

/* ================================================================== */
/* 3. The jump, out of the real Player                                 */
/* ================================================================== */

/**
 * This planet's jump, computed by the shipped controller and not by this file.
 *
 * `Player.setWorldGravity` is the ONLY writer of the four resolved numbers; it
 * goes through `worldGravityRatio` for `CONFIG.player.gravityReference` and the
 * `GRAVITY_RATIO_MIN/MAX` clamp, applies the derived `r^(1/3)` jump exponent,
 * and computes the apex itself. Everything below is read back through the
 * PUBLIC getters, so the exponent, the reference, the clamp and the apex
 * formula all live in one place and this file re-types none of them.
 *
 * `Player#jumpApex` is the closed form `v^2/2g`. The 60 Hz integrator
 * quantises about 5.6% under it (0.878 m measured against 0.931 analytic at
 * default gravity, per `player-gravity.test.mjs`), so it is the GENEROUS side -
 * the correct side for a gate. A gate that holds against a jump slightly
 * bigger than the one the game grants is a gate that holds.
 *
 * Hang time has no getter and is the other closed form off the same two public
 * numbers, `2v/g`. It only feeds the horizontal hop distance.
 *
 * @param {number} gravity the descriptor's surface gravity, m/s^2
 */
function jumpOf(gravity) {
  const player = Object.create(Player.prototype);
  player.setWorldGravity({ id: 'probe', gravity });
  const g = -player.gravity;
  const v = player.jumpVelocity;
  const apex = player.jumpApex;
  const hang = (2 * v) / g;
  for (const [k, n] of Object.entries({ g, v, apex, hang })) {
    assert.ok(Number.isFinite(n) && n > 0,
      `Player produced a non-finite jump for gravity ${gravity}: ${k} = ${n}`);
  }
  return { g, v, apex, hang, ratio: player.gravityRatio };
}

/* ================================================================== */
/* 4. The lattice, parameterised by envelope                           */
/* ================================================================== */

/**
 * One standing-room mask per (planet, slope), one flood per (pad, envelope).
 *
 * The mask depends only on the slope ceiling, so it is built once per slope
 * and shared by the no-jump and with-jump floods over it. Only the traversal
 * rule differs between those two.
 *
 * @param {{ground:Function, blocked:Function, liquid:Function, half:number, slopeTan:number}} o
 */
function maskFor(o) {
  const { ground, blocked, liquid, half, slopeTan } = o;
  const n = Math.floor((half * 2) / PITCH) + 1;
  const ok = new Uint8Array(n * n);
  const y = new Float32Array(n * n);
  for (let j = 0; j < n; j++) {
    const z = -half + j * PITCH;
    for (let i = 0; i < n; i++) {
      const x = -half + i * PITCH;
      const k = j * n + i;
      const g = ground(x, z);
      if (!Number.isFinite(g)) { y[k] = NaN; continue; }
      y[k] = g;
      if (liquid(x, z, g)) continue;
      if (blocked(x, z, g)) continue;
      const gx = ground(x + PITCH * 0.5, z); const gnx = ground(x - PITCH * 0.5, z);
      const gz = ground(x, z + PITCH * 0.5); const gnz = ground(x, z - PITCH * 0.5);
      if (![gx, gnx, gz, gnz].every(Number.isFinite)) continue;
      if (Math.hypot((gx - gnx) / PITCH, (gz - gnz) / PITCH) > slopeTan) continue;
      ok[j * n + i] = 1;
    }
  }
  return { n, ok, y, half };
}

/**
 * Flood a mask under one traversal rule, forwards or backwards.
 *
 * ── The two rise allowances, which are not the same mechanism ────────────
 * `walkRise` is `PITCH * tan(slope)` floored at `STEP_UP`: the height an
 * adjacent lattice cell may stand above this one and still be the same
 * continuous slope. It is the rule both shipped probes use
 * (`if (d > 0 && d > MAX_RISE && d > STEP_UP) continue`) and it is reproduced
 * here so envelope (a) is the authors' measurement and not a new one.
 *
 * `jumpRise` is `STEP_UP + apex`: a DISCRETE riser cleared by leaving the
 * ground. It is zero in the two no-jump envelopes. A hop over non-standing
 * ground is governed by it alone - once airborne, the slope of what you came
 * off is irrelevant - and so is the check that the ground crossed does not
 * rise into the arc.
 *
 * `reverse` walks the SAME graph with every edge turned around, which is how
 * a one-way shelf is found: a pad whose forward flood reaches a node and whose
 * reverse flood does not is a pad you can leave and cannot return to.
 *
 * The frontier is an SPFA deque with an `inQueue` flag, so a cell is never
 * pending twice and the queue is bounded by the lattice. A plain growing
 * array is not: on Sallow it relaxed past 2^32 entries and threw.
 *
 * @param {{mask:object, walkRise:number, jumpRise:number, dropMax:number,
 *          hopCells:number, reverse?:boolean, seed:[number,number]}} o
 */
function flood(o) {
  const { mask, walkRise, jumpRise, dropMax, hopCells, seed } = o;
  const rev = !!o.reverse;
  const { n, ok, y, half } = mask;
  const N = n * n;
  const at = (i, j) => j * n + i;
  const dist = new Float32Array(N).fill(Infinity);

  const cellsNear = (x, z) => {
    const i0 = Math.round((x + half) / PITCH); const j0 = Math.round((z + half) / PITCH);
    const r = Math.ceil(ARRIVE / PITCH); const out = [];
    for (let dj = -r; dj <= r; dj++) {
      for (let di = -r; di <= r; di++) {
        const a = i0 + di; const b = j0 + dj;
        if (a < 0 || b < 0 || a >= n || b >= n || !ok[at(a, b)]) continue;
        if (Math.hypot(a * PITCH - half - x, b * PITCH - half - z) > ARRIVE) continue;
        out.push(at(a, b));
      }
    }
    return out;
  };

  const CAP = N + 1;
  const q = new Int32Array(CAP);
  const inQ = new Uint8Array(N);
  let head = 0; let tail = 0;
  const push = (k) => { if (inQ[k]) return; inQ[k] = 1; q[tail] = k; tail = tail + 1 === CAP ? 0 : tail + 1; };

  for (const k of cellsNear(seed[0], seed[1])) { dist[k] = 0; push(k); }
  const DIRS = [[1, 0], [-1, 0], [0, 1], [0, -1]];
  while (head !== tail) {
    const k = q[head]; head = head + 1 === CAP ? 0 : head + 1; inQ[k] = 0;
    const i = k % n; const j = (k - i) / n;
    const here = y[k]; const d0 = dist[k];
    for (const [di, dj] of DIRS) {
      let peak = -Infinity;
      for (let m = 1; m <= hopCells + 1; m++) {
        const a = i + di * m; const b = j + dj * m;
        if (a < 0 || b < 0 || a >= n || b >= n) break;
        const kk = at(a, b);
        const there = y[kk];
        if (!Number.isFinite(there)) break;
        /* Past the first cell the body is airborne: if the ground between has
         * risen into the arc, the jump hits it rather than clearing it. */
        if (m > 1 && peak > here + jumpRise + 1e-6) break;
        if (ok[kk]) {
          /* dh as the TRAVELLER experiences it: a reversed edge is the same
           * geometry walked the other way. */
          const dh = rev ? here - there : there - here;
          const rise = m === 1 ? Math.max(walkRise, jumpRise) : jumpRise;
          if (dh <= rise + 1e-6 && dh >= -dropMax - 1e-6) {
            const step = Math.hypot(PITCH * m, there - here);
            if (d0 + step < dist[kk] - 1e-6) { dist[kk] = d0 + step; push(kk); }
          }
          break; // the first standing ground in this direction is where you land
        }
        peak = Math.max(peak, there);
      }
    }
  }
  let covered = 0;
  for (let k = 0; k < N; k++) if (dist[k] < Infinity) covered++;
  return {
    /** Walking metres from the seed to (x,z), or Infinity. */
    to(x, z) {
      let best = Infinity;
      for (const k of cellsNear(x, z)) if (dist[k] < best) best = dist[k];
      return best;
    },
    /** How many lattice cells the flood covers. */
    covered,
  };
}

/* ================================================================== */
/* 5. The table                                                        */
/* ================================================================== */

const ids = Object.keys(PLANETS);

/** @type {Map<string, any>} */
const REPORT = new Map();

/**
 * Everything measured for one planet, under all three envelopes.
 *
 * Envelope (c) is (b) plus the jump: the rise allowance goes from a 0.45 m
 * step to the planet's own apex, and a hop may cross `floor(walkSpeed * hang /
 * PITCH)` cells of non-standing ground.
 */
async function measure(id) {
  if (REPORT.has(id)) return REPORT.get(id);
  const { world, physics } = await buildPlanet(id);
  const P = world.planet;
  const field = physics.heightfields[0];
  const ground = (x, z) => field.sampleHeight(x, z);
  const blocked = boxIndex(physics);
  const liquid = liquidMask(P);
  const jump = jumpOf(P.gravity);
  const hopCells = Math.floor((CONFIG.player.walkSpeed * jump.hang) / PITCH);

  const masks = {
    legacy: maskFor({ ground, blocked, liquid, half: P.half, slopeTan: tanOf(SLOPE.LEGACY.deg) }),
    real: maskFor({ ground, blocked, liquid, half: P.half, slopeTan: tanOf(SLOPE.REAL.deg) }),
  };
  /* Nineteen NaN pixels once blacked out a 921,600-pixel frame through the
   * bloom pass in this project. A landform edit is exactly how a height field
   * goes non-finite, so every sample the lattice took is checked - not a
   * sample of them. */
  let nonFinite = 0;
  for (let k = 0; k < masks.real.y.length; k++) if (!Number.isFinite(masks.real.y[k])) nonFinite++;
  const walkRiseOf = (deg) => Math.max(PITCH * tanOf(deg), STEP_UP);
  const envelopes = [
    { key: 'a', label: `${SLOPE.LEGACY.deg} deg no jump`, mask: masks.legacy, walkRise: walkRiseOf(SLOPE.LEGACY.deg), jumpRise: 0, hopCells: 0 },
    { key: 'b', label: `${SLOPE.REAL.deg.toFixed(1)} deg no jump`, mask: masks.real, walkRise: walkRiseOf(SLOPE.REAL.deg), jumpRise: 0, hopCells: 0 },
    { key: 'c', label: `${SLOPE.REAL.deg.toFixed(1)} deg + jump`, mask: masks.real, walkRise: walkRiseOf(SLOPE.REAL.deg), jumpRise: STEP_UP + jump.apex, hopCells },
  ];

  const pads = world.landingSites.map((s) => ({ id: s.id, x: s.position.x, z: s.position.z, primary: !!s.primary }));
  const tiers = P.minerals.map((m) => ({
    id: m.id,
    rarity: m.rarity,
    nodes: world.mineralNodes.filter((nd) => nd.type === m.id).map((nd) => [nd.position.x, nd.position.z]),
  }));

  /** rows[envKey][padId][tierId] = { reach, home, total, near } */
  const rows = {};
  /** union[envKey][tierId] = how many nodes SOME pad reaches. */
  const union = {};
  const oneWay = [];
  for (const env of envelopes) {
    rows[env.key] = {};
    union[env.key] = {};
    const anyPad = new Map(tiers.map((t) => [t.id, new Set()]));
    for (const pad of pads) {
      const args = { mask: env.mask, walkRise: env.walkRise, jumpRise: env.jumpRise, dropMax: DROP_MAX, hopCells: env.hopCells };
      const fwd = flood({ ...args, seed: [pad.x, pad.z] });
      const back = flood({ ...args, seed: [pad.x, pad.z], reverse: true });
      const cell = {};
      for (const t of tiers) {
        let reach = 0; let home = 0; let near = Infinity;
        for (let i = 0; i < t.nodes.length; i++) {
          const [x, z] = t.nodes[i];
          const d = fwd.to(x, z);
          if (d < Infinity) { reach++; anyPad.get(t.id).add(i); if (d < near) near = d; }
          if (back.to(x, z) < Infinity) home++;
        }
        cell[t.id] = { reach, home, total: t.nodes.length, near };
      }
      rows[env.key][pad.id] = cell;
      /* One-way is a property of the ENVELOPE, not just the pad: the walk rise
       * allowance rises with the slope ceiling while the 3 m drop does not, so
       * a ledge that is one-way at 38 deg can be a round trip at 56.63. Both
       * are recorded. */
      if (fwd.covered > 0 && back.covered < fwd.covered) {
        oneWay.push({ env: env.key, pad: pad.id, out: fwd.covered, back: back.covered, stranded: fwd.covered - back.covered });
      }
    }
    for (const t of tiers) union[env.key][t.id] = anyPad.get(t.id).size;
  }

  /* The built world is NOT retained: ten THREE scenes plus ten collider sets
   * plus ten lattices is a gigabyte, and nothing below needs more than these
   * numbers. */
  const out = {
    id, half: P.half, gravity: P.gravity, pads, tiers: tiers.map((t) => ({ id: t.id, rarity: t.rarity, count: t.nodes.length })),
    rows, union, jump, hopCells, oneWay, nonFinite, samples: masks.real.y.length,
  };
  REPORT.set(id, out);
  return out;
}

const RARITY_ORDER = ['common', 'uncommon', 'rare', 'exotic'];

test('THE TABLE: every mineral tier, every pad, all three envelopes', async () => {
  const missing = [];
  for (const id of ids) {
    let r;
    try { r = await measure(id); } catch (e) { missing.push(`${id}: ${e.message}`); continue; }
    console.log('');
    console.log(`  ══ ${id.toUpperCase()}  half ${r.half} m, gravity ${r.gravity} m/s^2 `
      + `(${r.jump.ratio.toFixed(4)}x), jump apex ${r.jump.apex.toFixed(2)} m, hang ${r.jump.hang.toFixed(2)} s, `
      + `hop ${r.hopCells} cells = ${(r.hopCells * PITCH).toFixed(0)} m at walk `
      + `(a sprint would carry ${(CONFIG.player.sprintSpeed * r.jump.hang).toFixed(1)} m)`);
    console.log(`     pads: ${r.pads.map((p) => (p.primary ? `${p.id}*` : p.id)).join(', ')}   (* = primary, the pad you arrive at)`);
    const w = Math.max(12, ...r.tiers.map((t) => t.id.length + 1));
    console.log(`     ${'tier'.padEnd(w)} ${'rarity'.padEnd(9)} ${'pad'.padEnd(12)} `
      + `${'(a) 38 no jump'.padEnd(15)} ${`(b) ${SLOPE.REAL.deg.toFixed(1)} no jump`.padEnd(15)} (c) ${SLOPE.REAL.deg.toFixed(1)} + jump`);
    for (const t of [...r.tiers].sort((x, y) => RARITY_ORDER.indexOf(x.rarity) - RARITY_ORDER.indexOf(y.rarity))) {
      for (const pad of r.pads) {
        const cells = ['a', 'b', 'c'].map((k) => {
          const c = r.rows[k][pad.id][t.id];
          const d = c.near < Infinity ? ` @${c.near.toFixed(0)}m` : '';
          return `${c.reach}/${c.total}${d}`.padEnd(15);
        });
        const flag = t.rarity === 'exotic' && pad.primary
          && (r.rows.b[pad.id][t.id].reach > 0 || r.rows.c[pad.id][t.id].reach > 0) ? '  <<< BROKEN' : '';
        console.log(`     ${t.id.padEnd(w)} ${t.rarity.padEnd(9)} ${(pad.primary ? `${pad.id}*` : pad.id).padEnd(12)} `
          + `${cells.join(' ')}${flag}`);
      }
    }
  }
  if (missing.length) console.log(`\n  NOT MEASURED: ${missing.join(' | ')}`);
  assert.equal(missing.length, 0, `planets that would not build: ${missing.join(' | ')}`);

  /* THE HEIGHT FIELD IS FINITE EVERYWHERE, on every planet, over every sample
   * the lattice took. Cheap here and load-bearing: this file EDITS landforms,
   * and a landform edit is how a height field goes non-finite. Nineteen NaN
   * pixels once blacked out a 921,600-pixel frame through the bloom pass. */
  const dirty = [];
  let total = 0;
  for (const id of ids) {
    const r = REPORT.get(id);
    if (!r) continue;
    total += r.samples;
    if (r.nonFinite) dirty.push(`${id}: ${r.nonFinite} of ${r.samples}`);
  }
  console.log(`\n  height field finite over all ${total.toLocaleString()} lattice samples on ${ids.length} planets: `
    + `${dirty.length ? dirty.join(', ') : 'yes, 0 non-finite'}`);
  assert.deepEqual(dirty, [], `non-finite ground: ${dirty.join(', ')}`);
});

/* ================================================================== */
/* 6. The guarantee, at the envelope the game actually walks           */
/* ================================================================== */

test('the exotic tier is a second landing under the REAL envelope, with and without a jump', async () => {
  const broken = [];
  for (const id of ids) {
    const r = await measure(id);
    const primary = r.pads.find((p) => p.primary);
    assert.ok(primary, `${id} has no primary landing site`);
    for (const t of r.tiers) {
      if (t.rarity !== 'exotic') continue;
      for (const key of ['b', 'c']) {
        const c = r.rows[key][primary.id][t.id];
        if (c.reach > 0) {
          broken.push(`${id}/${t.id} envelope (${key}): ${c.reach} of ${c.total} nodes walkable from ${primary.id}`
            + ` at ${c.near.toFixed(0)} m (envelope (a) said ${r.rows.a[primary.id][t.id].reach})`);
        }
      }
    }
  }
  if (broken.length) console.log(`   BROKEN:\n     ${broken.join('\n     ')}`);
  assert.deepEqual(broken, [], 'the exotic ore is reachable on foot from the pad you arrive at:\n  '
    + broken.join('\n  '));
});

test('the exotic tier is still reachable from its OWN pad, under every envelope', async () => {
  const lost = [];
  for (const id of ids) {
    const r = await measure(id);
    for (const t of r.tiers) {
      if (t.rarity !== 'exotic') continue;
      for (const key of ['a', 'b', 'c']) {
        const best = r.pads.map((p) => r.rows[key][p.id][t.id].reach).reduce((x, yy) => Math.max(x, yy), 0);
        if (best < t.count) {
          lost.push(`${id}/${t.id} envelope (${key}): the best single pad reaches ${best} of ${t.count}`);
        }
      }
    }
  }
  if (lost.length) console.log(`   UNREACHABLE FROM ANY PAD:\n     ${lost.join('\n     ')}`);
  assert.deepEqual(lost, [], 'exotic ore no pad can reach:\n  ' + lost.join('\n  '));
});

test('every seam below exotic is still reachable from some pad under the REAL envelope', async () => {
  const lost = [];
  const legacyOnly = [];
  for (const id of ids) {
    const r = await measure(id);
    for (const t of r.tiers) {
      if (t.rarity === 'exotic') continue;
      for (const key of ['a', 'b', 'c']) {
        /* SOME pad, not one pad: rheniite on Cinder hangs off two, which the
         * ablation case in planet-minerals exists to protect. */
        const u = r.union[key][t.id];
        if (u >= t.count) continue;
        const line = `${id}/${t.id} (${t.rarity}) envelope (${key}): every pad together reaches ${u} of ${t.count}`;
        /* (a) is REPORTED, (b) and (c) are ASSERTED, and the asymmetry is this
         * file's thesis. A seam the game can walk to and a 38 deg probe cannot
         * is the conservative envelope failing conservatively - a probe
         * artefact. A seam the GAME cannot walk to is content that was built
         * and cannot be reached, which is the defect this project keeps
         * shipping. Only the second is allowed to be red here. */
        if (key === 'a') legacyOnly.push(line); else lost.push(line);
      }
    }
  }
  if (legacyOnly.length) {
    console.log('   REACHABLE IN THE GAME, UNREACHABLE TO THE 38 deg PROBE - report, do not chase in terrain:');
    for (const line of legacyOnly) console.log(`     ${line}`);
  }
  if (lost.length) {
    console.log('   PARTIALLY UNREACHABLE AT THE REAL ENVELOPE:');
    for (const line of lost) console.log(`     ${line}`);
  }
  assert.deepEqual(lost, [],
    `ore below the exotic tier that no pad reaches at the envelope the game walks: ${lost.join(' | ')}`);
});

/* ================================================================== */
/* 7. One-way pads, reported and not asserted                          */
/* ================================================================== */

/**
 * A pad is ONE-WAY where the flood leaves it and cannot come back.
 *
 * Measured two ways, because they answer different questions:
 *
 *   BY AREA - the same flood run on the graph with every edge reversed. The
 *   difference between the two covered-cell counts is ground a body can walk
 *   ONTO from this pad and not walk back off.
 *
 *   BY SEAM - for every mineral tier, how many of its nodes the pad can reach
 *   against how many of them can reach the pad. `reach > home` is a miner who
 *   can get to the ore and not to their ship.
 *
 * REPORTED and not asserted. Cinder's Rimhold Shelf shipped as an isolated
 * region and Lathe's Shepherd Notch was flagged as a one-way shelf by its own
 * author, so a red assertion here would be a red assertion about the game as
 * released. It has to be KNOWN, which is what this prints.
 */
test('ONE-WAY PADS: where a player can walk off and not walk back', async () => {
  console.log('   BY AREA - forward flood against the same flood with every edge reversed:');
  const area = [];
  const seam = [];
  for (const id of ids) {
    const r = await measure(id);
    for (const w of r.oneWay) {
      const pct = (100 * w.stranded) / w.out;
      area.push({ id, ...w, pct });
      console.log(`     (${w.env}) ${id.padEnd(10)} ${w.pad.padEnd(15)} out ${String(w.out).padStart(6)} cells, `
        + `back ${String(w.back).padStart(6)} - ${w.stranded} (${pct.toFixed(1)}%) one-way`);
    }
    for (const key of ['a', 'b', 'c']) {
      for (const pad of r.pads) {
        for (const t of r.tiers) {
          const c = r.rows[key][pad.id][t.id];
          if (c.reach > c.home) {
            seam.push(`(${key}) ${id}/${pad.id}/${t.id}: reaches ${c.reach} of ${c.total}, only ${c.home} can walk back`);
          }
        }
      }
    }
  }
  if (!area.length) console.log('     none');
  console.log('   BY SEAM - nodes a pad can reach against nodes that can reach the pad:');
  if (!seam.length) console.log('     none: every seam every pad reaches is a round trip, on all ten planets');
  for (const line of seam) console.log(`     ${line}`);
});
