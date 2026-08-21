import { test } from 'node:test';
import assert from 'node:assert/strict';

import { PLANETS } from '../../src/worlds/planets/index.js';
import { SLOPE } from './planet-envelope.test.mjs';
import {
  LIQUID_EDGE, liquidKind, liquidDepth, liquidSurfaceAt, liquidField,
  liquidContour, liquidWalls, liquidCellMask, createLiquidMaterial, bodyGeometry,
  liquidSubstance, liquidHazard, liquidSwimmable, liquidWalled, liquidGuards,
} from '../../src/worlds/planets/PlanetLiquid.js';
import { ENTER_DEPTH } from '../../src/player/Swim.js';

/**
 * PLANET LIQUID: THE SHORE, THE DEPTH, AND THE MAP.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 *  THE THREE DEFECTS, AND THE ONE THE FIX FOR THEM CAUSED
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * 1. **The minimap painted every liquid lava-orange.** `_publish` hard-coded
 *    `rgba(255,110,30,0.55)`. On Shoal, whose sea is one 2,700 m disc over the
 *    whole playfield, the map came out a full-screen orange wash with the land
 *    indistinguishable from the sea.
 *
 * 2. **Nothing physically stopped a player walking into liquid.**
 *    `_buildLiquid` never touched `this.physics`; `swim` is false and
 *    `WaterVolumes` never saw planet liquid either. The shipped game let you
 *    walk down the beach and along the SEA BED under an opaque ceiling.
 *
 * 3. **No depth term.** 20 cm of water and 20 m of water were the same colour.
 *
 * 5. **AND THE FENCE WAS THE ANSWER TO THE WRONG QUESTION.** (2) above was
 *    closed by walling every metre of every waterline in the game, on the
 *    stated grounds that swimming "makes every one of Shoal's reachability
 *    decisions false". That was reasoned rather than measured, and when it was
 *    measured it turned out to be one island wide - see the swim section at
 *    the bottom of this file. Water is water and is now entered; lava and acid
 *    are not and keep their wall AND get `liquid.lethal` wired to a burn.
 *    5,362 of 6,829 posts came out.
 *
 * 4. **AND THEN THE BARRIER ANNEXED THE BANK.** The first fix for (2) marked
 *    whole terrain cells wet and fenced them, with the reach probes' 0.6 m
 *    freeboard margin folded in. On a beach that is a metre of slop. On
 *    Verdigris - whose gorge floor is flat and sits 1.1 m below the river's
 *    surface for the full width of the canyon, so every cell touching the
 *    ribbon counted - it was four metres of a bank only a few metres wide, and
 *    it cut the walking corridor. Flooded from `greenspan` at
 *    `SLOPE.LEGACY`: **9 of 20 malachite reachable, against 20 of 20 without
 *    the fence.** `malachite` is `terrain: 'channel'`; the ore and the river
 *    are the same feature by design.
 *
 * ── The rule these tests are written to ────────────────────────────────────
 *   A GATE has to hold at the ceiling; a ROUTE has to work at the floor.
 * The barrier is a gate, so it is marched against at speeds no player reaches.
 * The riverbank is a route, so it is flooded at `SLOPE.LEGACY`, the most
 * conservative envelope, where "reachable" means reachable however you approach.
 *
 * ── Why a real build and not a fixture ─────────────────────────────────────
 * The harness below is `planet-minerals.test.mjs`'s: a headless `three` plus a
 * live `Physics`, building the actual world. A fixture would let the contour,
 * the barrier and the mesh agree with each other while all three disagreed with
 * the planet.
 */

/* ------------------------------------------------------------------ */
/* Harness                                                             */
/* ------------------------------------------------------------------ */

function harness(THREE) {
  if (globalThis.__liquidHarness) return;
  globalThis.__liquidHarness = true;
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

const _built = new Map();

/** Build one planet for real, with its own `Physics`. Cached per id. */
async function planet(id) {
  if (_built.has(id)) return _built.get(id);
  const THREE = await import('three');
  harness(THREE);
  const { Physics, COLLISION_LAYER } = await import('../../src/physics/Physics.js');
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
  const rec = { world, physics, THREE, COLLISION_LAYER };
  _built.set(id, rec);
  return rec;
}

const LIQUID_IDS = Object.keys(PLANETS).filter((id) => PLANETS[id].liquid?.bodies?.length);

/* ================================================================== */
/* 0. WHAT THE 0.6 m MARGIN IS, AND WHERE IT DOES NOT BELONG          */
/* ================================================================== */

test('the probes freeboard margin is not built into the world as geometry', () => {
  assert.equal(LIQUID_EDGE, 0.6,
    'LIQUID_EDGE records the 0.6 hard-coded in planet-reach.test.mjs and planet-minerals.test.mjs.');

  /* THE DISTINCTION THIS ASSERTS.
   *
   * The probes block a lattice cell at `surface + 0.6` because 60 cm of
   * freeboard is not somewhere to promise a player can stand - a statement
   * about CONFIDENCE. `liquidField` is a statement about where the water IS,
   * and the water is not 60 cm up the bank. The first barrier conflated them
   * and walled four metres of Verdigris's malachite bank. */
  for (const id of LIQUID_IDS) {
    const L = PLANETS[id].liquid;
    const b = L.bodies[0];
    const surf = b.shape === 'disc' ? b.y : Math.max(b.y0, b.y1);
    const at = b.shape === 'disc' ? [b.x, b.z] : b.pts[0];
    // Ground exactly at the waterline is not under the liquid.
    assert.ok(liquidField(L, at[0], at[1], surf) <= 0,
      `${id}: ground level with the surface reads as submerged - the field has a margin in it`);
    // A hand's breadth below it is.
    assert.ok(liquidField(L, at[0], at[1], surf - 0.2) > 0,
      `${id}: ground 20 cm under the surface does not read as submerged`);
  }
});

test('every liquid planet declares a kind the material can act on', () => {
  assert.ok(LIQUID_IDS.length >= 1, 'no planet has liquid - this whole file is measuring nothing');
  for (const id of LIQUID_IDS) {
    const L = PLANETS[id].liquid;
    const kind = liquidKind(L);
    assert.ok(kind === 'lava' || kind === 'water', `${id}: liquidKind gave "${kind}"`);
    const d = liquidDepth(L);
    for (const [k, v] of Object.entries(d)) {
      if (typeof v === 'number') assert.ok(Number.isFinite(v), `${id}: depth.${k} is ${v}`);
    }
    assert.ok(d.scale > 0, `${id}: depth.scale must be positive - the shader divides by it`);
    assert.ok(d.surfBand > 0, `${id}: depth.surfBand must be positive - it is a smoothstep edge`);
    assert.ok(d.amount >= 0 && d.amount <= 1, `${id}: depth.amount ${d.amount} out of range`);
  }
});

/* ================================================================== */
/* 1. GEOMETRY AND THE BED: NOTHING NON-FINITE                        */
/* ================================================================== */

test('no liquid vertex, uv or bed sample is non-finite', async () => {
  for (const id of LIQUID_IDS) {
    const P = PLANETS[id];
    for (const [i, b] of P.liquid.bodies.entries()) {
      const { surface, skirt } = bodyGeometry(b);
      for (const [name, geo] of [['surface', surface], ['skirt', skirt]]) {
        for (const attr of ['position', 'uv']) {
          const a = geo.getAttribute(attr);
          if (!a) continue;
          for (let k = 0; k < a.array.length; k++) {
            assert.ok(Number.isFinite(a.array[k]),
              `${id} body ${i} ${name}.${attr}[${k}] is ${a.array[k]} - a NaN here reaches the shader, `
              + 'and 19 NaN pixels through UnrealBloomPass have already blacked out a 921,600-pixel frame here');
          }
        }
      }
      surface.dispose();
      skirt.dispose();
    }
  }
});

test('the bed texture a depth term reads is finite everywhere', async () => {
  for (const id of LIQUID_IDS) {
    if (liquidDepth(PLANETS[id].liquid).amount <= 0) continue;
    const { world } = await planet(id);
    const bedTex = world._owned.find((o) => o?.isTexture && /\.bed$/.test(o.name ?? ''));
    assert.ok(bedTex, `${id}: depth is on and no bed texture was built`);
    const data = bedTex.image.data;
    assert.equal(data.length, world._bed.nx * world._bed.nz,
      `${id}: bed texture is ${data.length} texels for a ${world._bed.nx}x${world._bed.nz} field`);
    /* Half floats: anything at or above 0x7c00 in the exponent is an infinity
     * or a NaN. Checked on the encoded bits, because that is what the GPU
     * reads. */
    for (let i = 0; i < data.length; i++) {
      assert.ok((data[i] & 0x7fff) < 0x7c00,
        `${id}: bed texel ${i} encodes a non-finite half float (0x${data[i].toString(16)})`);
    }
    assert.ok(world._bed.stepX > 0 && world._bed.stepZ > 0,
      `${id}: bed step must be positive - the shader divides world position by it`);
  }
});

/* ================================================================== */
/* 2. THE WATERLINE                                                   */
/* ================================================================== */

test('the contour is finite and its normal points at the water', async () => {
  for (const id of LIQUID_IDS) {
    const P = PLANETS[id];
    const { world } = await planet(id);
    const segs = liquidContour({ liquid: P.liquid, ...world._bed, sub: 2 });
    assert.ok(segs.length > 4, `${id}: only ${segs.length} contour segments - the waterline was not found`);

    let wrongWay = 0;
    let checked = 0;
    for (let i = 0; i < segs.length; i += Math.max(1, Math.floor(segs.length / 200))) {
      const s = segs[i];
      for (const v of [s.x0, s.z0, s.x1, s.z1, s.nx, s.nz, s.len, s.surf, s.ground]) {
        assert.ok(Number.isFinite(v), `${id}: contour segment ${i} carries ${v}`);
      }
      assert.ok(Math.abs(Math.hypot(s.nx, s.nz) - 1) < 1e-6, `${id}: segment ${i} normal is not a unit vector`);
      /* THE ONE THAT MATTERS: two metres along the normal must be MORE
       * submerged than two metres against it. Get this backwards and every
       * wall on the planet is built on the bank instead of in the water -
       * which is not a hypothetical, it is what an inverted sign did. */
      const mx = (s.x0 + s.x1) * 0.5;
      const mz = (s.z0 + s.z1) * 0.5;
      const inw = liquidField(P.liquid, mx + s.nx * 2, mz + s.nz * 2, world.groundAt(mx + s.nx * 2, mz + s.nz * 2));
      const out = liquidField(P.liquid, mx - s.nx * 2, mz - s.nz * 2, world.groundAt(mx - s.nx * 2, mz - s.nz * 2));
      checked++;
      if (!(inw > out)) wrongWay++;
    }
    assert.ok(wrongWay <= checked * 0.02,
      `${id}: ${wrongWay}/${checked} contour normals point away from the water`);
  }
});

test('wall runs are longer than they are deep and follow the waterline', async () => {
  for (const id of LIQUID_IDS) {
    const P = PLANETS[id];
    const { world } = await planet(id);
    const runs = liquidWalls(liquidContour({ liquid: P.liquid, ...world._bed, sub: 2 }));
    assert.ok(runs.length > 0, `${id}: the contour chained to nothing`);
    for (const r of runs) {
      for (const v of [r.cx, r.cz, r.ux, r.uz, r.nx, r.nz, r.len, r.surf, r.ground]) {
        assert.ok(Number.isFinite(v), `${id}: a wall run carries ${v}`);
      }
      assert.ok(r.len > 0, `${id}: a zero-length wall run`);
      assert.ok(Math.abs(r.ux * r.ux + r.uz * r.uz - 1) < 1e-6, `${id}: run direction is not a unit vector`);
    }
  }
});

/* ================================================================== */
/* 3. THE BARRIER                                                     */
/* ================================================================== */

test('every barrier collider is axis-aligned, because every probe assumes it', async () => {
  /* EVERY REACH PROBE IN THIS REPO MODELS A COLLIDER BY ITS AXIS-ALIGNED
   * BOUNDS (`planet-minerals.test.mjs`'s `boxIndex` is the pattern). That is
   * exact for a square post and a gross over-estimate for a turned one: a 13 m
   * wall panel following a shoreline at 76 degrees has a 14 x 6 m bounding box.
   * Measured: oriented panels placed correctly IN the water still cost eleven
   * of Verdigris's twenty malachite when flooded, because the flood could not
   * see them as anything but their bounds. A square post is its own bounding
   * box, so the measurement and the engine agree by construction. */
  for (const id of LIQUID_IDS) {
    const { world, physics } = await planet(id);
    const L = PLANETS[id].liquid;
    const posts = physics.colliders.filter((c) => c.userData?.planetLiquidBarrier);
    /* WHERE THE WALL IS, AND WHERE IT IS NOT.
     *
     * "There is a wall" is no longer the invariant - most of the liquid in the
     * game is swimmable now and has none. The invariant is that the builder
     * and the predicate agree about every metre of it, because the reach
     * probes below flood against the predicate and the player walks into the
     * colliders: `liquidWalled` false with a post standing there is a fence in
     * open water no probe can see, and true with no post is a gate that is not
     * there. */
    const wantWall = !liquidSwimmable(L) || liquidGuards(L).length > 0;
    assert.equal(posts.length > 0, wantWall,
      `${id}: ${posts.length} barrier posts, but liquidWalled says the shore is `
      + `${wantWall ? 'walled' : 'open'}`);
    assert.equal(posts.length, world.census.liquid.barrierPosts);
    for (const c of posts) {
      const m = c.matrix.elements;
      assert.ok(liquidWalled(L, m[12], m[14]),
        `${id}: a barrier post stands at (${m[12].toFixed(0)},${m[14].toFixed(0)}), which `
        + 'liquidWalled says is open water - a fence no reach probe models');
    }
    for (const c of posts) {
      const m = c.matrix.elements;
      assert.ok(Math.abs(m[0] - 1) < 1e-9 && Math.abs(m[2]) < 1e-9 && Math.abs(m[8]) < 1e-9 && Math.abs(m[10] - 1) < 1e-9,
        `${id}: a barrier collider is rotated; every reach probe here will over-state it by its bounding box`);
      assert.ok(Math.abs(c.halfExtents.x - c.halfExtents.z) < 1e-9,
        `${id}: a barrier post is not square in plan`);
      for (const v of [m[12], m[13], m[14], c.halfExtents.x, c.halfExtents.y, c.halfExtents.z]) {
        assert.ok(Number.isFinite(v), `${id}: a barrier post carries ${v}`);
      }
      assert.ok(c.halfExtents.y > 1, `${id}: a barrier post is ${c.halfExtents.y * 2} m tall - nothing is stopped by that`);
    }
  }
});

test('a capsule walked at a WALLED shore is stopped above the surface', async () => {
  /* THE GATE, AT THE CEILING.
   *
   * Not "a collider was added" - "a body cannot get in". The march is the
   * shipped solver: `resolveCapsule` with the player's own radius and height.
   * 0.5 m a step is 30 m/s at 60 fps, against a boosted sprint of 12.3 - so
   * this passes at more than twice anything the game can produce, which is what
   * a gate has to do. Before the barrier this walked straight down the beach
   * and out along the sea bed on every bearing tried.
   *
   * It now runs only where the shore is SUPPOSED to stop a body: every metre
   * of a lethal liquid, and Shoal's guarded Sundering Head. Running it on
   * Vitrine's meltwater pools measures the opposite of what is wanted - 91 of
   * 102 approaches "ended under the liquid", which is a description of getting
   * into a pond you are meant to be able to get into. The counterpart case
   * below asserts that. */
  const R = 0.35;
  const H = 1.75;
  const STEP = 0.5;

  for (const id of LIQUID_IDS) {
    const P = PLANETS[id];
    const { world, physics, THREE } = await planet(id);
    const bed = world._bed;
    const mask = liquidCellMask({ liquid: P.liquid, ...bed });

    const starts = [];
    for (let j = 1; j + 1 < mask.cz; j++) {
      for (let i = 1; i + 1 < mask.cx; i++) {
        if (mask.wet[j * mask.cx + i]) continue;
        for (const [di, dj] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
          if (!mask.wet[(j + dj) * mask.cx + (i + di)]) continue;
          const x = bed.originX + (i + 0.5) * bed.stepX;
          const z = bed.originZ + (j + 0.5) * bed.stepZ;
          // Only the stretches the world says it walls. @see liquidWalled
          if (!liquidWalled(P.liquid, x, z)) break;
          starts.push({ x, z, dx: di, dz: dj });
          break;
        }
      }
    }
    if (!starts.length) continue;   // an entirely open shore; the next case owns it
    assert.ok(starts.length > 20, `${id}: only ${starts.length} walled shoreline start points`);

    const pick = [];
    const stride = Math.max(1, Math.floor(starts.length / 120));
    for (let i = 0; i < starts.length; i += stride) pick.push(starts[i]);

    const pos = new THREE.Vector3();
    const failures = [];
    for (const s of pick) {
      const g0 = world.groundAt(s.x, s.z);
      if (!Number.isFinite(g0)) continue;
      pos.set(s.x, g0 + 0.05, s.z);
      let worst = -Infinity;
      for (let k = 0; k < 40; k++) {
        pos.x += s.dx * STEP;
        pos.z += s.dz * STEP;
        const ground = physics.terrainHeight(pos.x, pos.z);
        if (ground !== null) pos.y = Math.max(pos.y, ground);
        physics.resolveCapsule(pos, R, H);
        const surf = liquidSurfaceAt(P.liquid, pos.x, pos.z);
        if (surf === null) continue;
        worst = Math.max(worst, surf - pos.y);
      }
      /* Half a metre of tolerance: the post's face stands `WALL_BIAS` (0.35 m)
       * onto the bank and a capsule can rest against it, so on a shore that
       * drops steeply the feet can legitimately be a little under the plane.
       * The defect was walking to the SEA BED. */
      if (worst > 0.5) failures.push({ s, worst: Number(worst.toFixed(2)) });
    }
    assert.equal(failures.length, 0,
      `${id}: ${failures.length}/${pick.length} shore approaches ended under the liquid, worst `
      + `${failures.slice(0, 4).map((f) => `${f.worst} m at (${f.s.x.toFixed(0)},${f.s.z.toFixed(0)})`).join('; ')}`);
  }
});

test('the barrier does not fence the dry world', async () => {
  /* The counterweight. A barrier that blocked the beach as well as the water
   * would pass "cannot get in" and make the planet unplayable. */
  for (const id of LIQUID_IDS) {
    const { world, physics, THREE } = await planet(id);
    const pos = new THREE.Vector3();
    for (const site of world.landingSites) {
      pos.set(site.position.x, site.position.y + 0.4, site.position.z);
      const before = pos.clone();
      physics.resolveCapsule(pos, 0.35, 1.75);
      assert.ok(pos.distanceTo(before) < 1.2,
        `${id}: the pad "${site.id}" pushes a standing capsule ${pos.distanceTo(before).toFixed(2)} m - `
        + 'the barrier has swallowed a landing site');
    }
    for (const node of world.mineralNodes) {
      pos.set(node.position.x, node.position.y + 0.4, node.position.z);
      const before = pos.clone();
      physics.resolveCapsule(pos, 0.35, 1.75);
      assert.ok(pos.distanceTo(before) < 1.6,
        `${id}: mineral ${node.id} at (${node.position.x.toFixed(0)},${node.position.z.toFixed(0)}) is inside `
        + `the barrier (${pos.distanceTo(before).toFixed(2)} m of pushout) - ore behind an invisible wall`);
    }
  }
});

/* ================================================================== */
/* 4. THE ROUTE, AT THE FLOOR: ORE REACHABILITY BY FLOODING           */
/* ================================================================== */

const PITCH = 2.0;
const STEP_UP = 0.45;
const DROP_MAX = 3.0;
const HEADROOM = 1.9;
const ARRIVE = 3.2;

/** Solid world boxes on an XZ grid, with the barrier optionally ablated. */
function boxIndex(physics, COLLISION_LAYER, skipBarrier) {
  const cell = 8;
  const grid = new Map();
  for (const c of physics.colliders) {
    if (!c.solid || c.type !== 'box') continue;
    if ((c.layer & COLLISION_LAYER.WORLD) === 0) continue;
    if (skipBarrier && c.userData?.planetLiquidBarrier) continue;
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

/** The reach probes' model of liquid, re-derived rather than imported. */
function lavaMask(P) {
  const bodies = P.liquid?.bodies ?? [];
  const polyDist = (px, pz, pts) => {
    let best = Infinity;
    for (let i = 0; i + 1 < pts.length; i++) {
      const ax = pts[i][0]; const az = pts[i][1];
      const ex = pts[i + 1][0] - ax; const ez = pts[i + 1][1] - az;
      const l2 = ex * ex + ez * ez;
      const t = l2 > 0 ? Math.max(0, Math.min(1, ((px - ax) * ex + (pz - az) * ez) / l2)) : 0;
      best = Math.min(best, Math.hypot(px - (ax + ex * t), pz - (az + ez * t)));
    }
    return best;
  };
  return (x, z, y) => {
    for (const b of bodies) {
      if (b.shape === 'disc') {
        if (Math.hypot(x - b.x, z - b.z) <= b.r && y < b.y + 0.6) return true;
      } else if (polyDist(x, z, b.pts) <= b.width * 0.5) {
        if (y < Math.max(b.y0, b.y1) + 0.6) return true;
      }
    }
    return false;
  };
}

/** Reachable mineral nodes per type, flooding from `padId` at `slopeDeg`. */
function floodOre({ world, blocked, lava, padId, slopeDeg }) {
  const half = world.planet.half;
  const ground = world.groundAt;
  const tan = Math.tan((slopeDeg * Math.PI) / 180);
  const n = Math.floor((half * 2) / PITCH) + 1;
  const at = (i, j) => j * n + i;
  const ok = new Uint8Array(n * n);
  const y = new Float32Array(n * n);
  for (let j = 0; j < n; j++) {
    const z = -half + j * PITCH;
    for (let i = 0; i < n; i++) {
      const x = -half + i * PITCH;
      const g = ground(x, z);
      if (!Number.isFinite(g)) continue;
      y[at(i, j)] = g;
      if (lava(x, z, g) || blocked(x, z, g)) continue;
      const gx = ground(x + PITCH * 0.5, z); const gnx = ground(x - PITCH * 0.5, z);
      const gz = ground(x, z + PITCH * 0.5); const gnz = ground(x, z - PITCH * 0.5);
      if (![gx, gnx, gz, gnz].every(Number.isFinite)) continue;
      if (Math.hypot((gx - gnx) / PITCH, (gz - gnz) / PITCH) > tan) continue;
      ok[at(i, j)] = 1;
    }
  }
  const site = world.landingSites.find((s) => s.id === padId) ?? world.landingSites[0];
  const seen = new Uint8Array(n * n);
  const queue = [];
  const si = Math.round((site.position.x + half) / PITCH);
  const sj = Math.round((site.position.z + half) / PITCH);
  for (let dj = -2; dj <= 2; dj++) {
    for (let di = -2; di <= 2; di++) {
      const i = si + di; const j = sj + dj;
      if (i < 0 || j < 0 || i >= n || j >= n || !ok[at(i, j)] || seen[at(i, j)]) continue;
      seen[at(i, j)] = 1;
      queue.push(at(i, j));
    }
  }
  for (let head = 0; head < queue.length; head++) {
    const k = queue[head];
    const i = k % n; const j = (k - i) / n;
    for (const [di, dj] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const ni = i + di; const nj = j + dj;
      if (ni < 0 || nj < 0 || ni >= n || nj >= n) continue;
      const nk = at(ni, nj);
      if (seen[nk] || !ok[nk]) continue;
      const dy = y[nk] - y[k];
      if (dy > Math.max(PITCH * tan, STEP_UP) || dy < -DROP_MAX) continue;
      seen[nk] = 1;
      queue.push(nk);
    }
  }
  const counts = new Map();
  for (const nd of world.mineralNodes) {
    const c = counts.get(nd.type) ?? { total: 0, got: 0 };
    c.total++;
    const i0 = Math.max(0, Math.floor((nd.position.x + half - ARRIVE) / PITCH));
    const i1 = Math.min(n - 1, Math.ceil((nd.position.x + half + ARRIVE) / PITCH));
    const j0 = Math.max(0, Math.floor((nd.position.z + half - ARRIVE) / PITCH));
    const j1 = Math.min(n - 1, Math.ceil((nd.position.z + half + ARRIVE) / PITCH));
    let hit = false;
    for (let j = j0; j <= j1 && !hit; j++) {
      for (let i = i0; i <= i1; i++) {
        if (!seen[at(i, j)]) continue;
        if (Math.hypot(-half + i * PITCH - nd.position.x, -half + j * PITCH - nd.position.z) <= ARRIVE) { hit = true; break; }
      }
    }
    if (hit) c.got++;
    counts.set(nd.type, c);
  }
  return counts;
}

test('the barrier costs no ore on any liquid planet, flooded at the conservative envelope', async () => {
  /* THE REGRESSION TEST, AND IT IS AN ABLATION.
   *
   * The same build, the same flood, twice: once with every collider the world
   * registered and once with the barrier's own posts removed. Anything the
   * fence costs shows up as a difference, and inspection cannot produce this
   * number - the first barrier looked perfectly reasonable in the source and
   * cost eleven of Verdigris's twenty malachite.
   *
   * `SLOPE.LEGACY` deliberately: a riverbank is a ROUTE, and a route has to
   * work at the most conservative envelope, not just at the one a lucky
   * approach angle gives you.
   */
  for (const id of LIQUID_IDS) {
    const { world, physics, COLLISION_LAYER } = await planet(id);
    const lava = lavaMask(PLANETS[id]);
    const withF = boxIndex(physics, COLLISION_LAYER, false);
    const noF = boxIndex(physics, COLLISION_LAYER, true);
    for (const site of world.landingSites) {
      const a = floodOre({ world, blocked: withF, lava, padId: site.id, slopeDeg: SLOPE.LEGACY.deg });
      const b = floodOre({ world, blocked: noF, lava, padId: site.id, slopeDeg: SLOPE.LEGACY.deg });
      for (const [type, c] of a) {
        const u = b.get(type);
        assert.equal(c.got, u.got,
          `${id} from ${site.id}: ${type} is ${c.got}/${c.total} with the shore barrier and ${u.got}/${u.total} `
          + 'without it. The barrier is annexing ground the ore stands on - which is the whole of what '
          + '`terrain: "channel"` and `terrain: "shore"` ore is FOR.');
      }
    }
  }
});

test('the seams the shore barrier was measured against are all reachable', async () => {
  /* The absolute counts, not just the ablation, so a descriptor change that
   * strands ore cannot hide behind "well, the fence did not cause it". These
   * are the figures the quality gate quotes. */
  const WANT = {
    verdigris: { greenspan: { malachite: 20, humic: 40 } },
    shoal: { glassflat: { brinesalt: 40, nacre: 20, polymetal: 12 }, sunder: { abyssite: 7 } },
    sallow: { stillwater: { realgar: 20 } },
    sirocco: { panhead: { selenite: 22 } },
  };
  for (const [id, pads] of Object.entries(WANT)) {
    if (!PLANETS[id]) continue;
    const { world, physics, COLLISION_LAYER } = await planet(id);
    const lava = lavaMask(PLANETS[id]);
    const blocked = boxIndex(physics, COLLISION_LAYER, false);
    for (const [padId, want] of Object.entries(pads)) {
      const got = floodOre({ world, blocked, lava, padId, slopeDeg: SLOPE.LEGACY.deg });
      for (const [type, n] of Object.entries(want)) {
        const c = got.get(type);
        assert.ok(c, `${id}: no ${type} nodes at all`);
        assert.equal(c.got, n, `${id} from ${padId}: ${type} ${c.got}/${c.total}, expected ${n} reachable`);
      }
    }
  }
});

/* ================================================================== */
/* 5. THE MINIMAP                                                     */
/* ================================================================== */

test('the minimap draws liquid in the liquid colour, not lava orange', async () => {
  for (const id of LIQUID_IDS) {
    const { world } = await planet(id);
    const shapes = world.minimapShapes;
    assert.ok(shapes.length > 0, `${id}: no minimap shapes`);
    for (const s of shapes) {
      for (const k of ['x', 'z', 'r', 'w', 'd']) {
        if (s[k] !== undefined) assert.ok(Number.isFinite(s[k]), `${id}: minimap ${s.kind}.${k} is ${s[k]}`);
      }
      if (s.kind === 'path') {
        for (const p of s.points) {
          assert.ok(Array.isArray(p) && Number.isFinite(p[0]) && Number.isFinite(p[1]),
            `${id}: a path point is ${JSON.stringify(p)} - Minimap._bakePlan reads p[0]/p[1], and an `
            + 'object here is a moveTo(undefined, undefined) that silently draws nothing');
        }
      }
    }
  }
});

test('a liquid body larger than the playfield is the background, with land on it', async () => {
  const { world } = await planet('shoal');
  const shapes = world.minimapShapes;
  const base = shapes[0];
  assert.equal(base.kind, 'rect', 'the first shape must be the ground rect - the bake is a painter stack');

  const sea = PLANETS.shoal.liquid;
  const rgb = base.fill.match(/(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/).slice(1).map(Number);
  assert.ok(rgb[2] > rgb[0] + 30,
    `shoal: the map background is rgb(${rgb}) - a sea backdrop has to be bluer than it is red`);
  assert.equal(liquidKind(sea), 'water', 'shoal reads as lava; the ink derivation would be wrong');

  const covering = shapes.filter((s) => s.kind === 'circle' && (s.r ?? 0) > PLANETS.shoal.half);
  assert.equal(covering.length, 0,
    `shoal: a ${covering[0]?.r} m liquid disc is drawn over the map - that is the orange wash, in blue`);

  const land = shapes.filter((s, i) => i > 0 && s.kind === 'rect');
  assert.ok(land.length > 40, `shoal: only ${land.length} land rects - the islands are not on the map`);
  assert.ok(land.length < 4000, `shoal: ${land.length} land rects - the run merge is not merging`);

  for (const r of land) {
    const g = world.groundAt(r.x, r.z);
    const s = liquidSurfaceAt(sea, r.x, r.z);
    assert.ok(s === null || g >= s - 1.0,
      `shoal: a land rect at (${r.x.toFixed(0)},${r.z.toFixed(0)}) sits ${(s - g).toFixed(1)} m under the sea`);
  }
});

test('Cinder keeps a lava-coloured map and finally gets its gorge on it', async () => {
  const { world } = await planet('cinder');
  const shapes = world.minimapShapes;
  const disc = shapes.find((s) => s.kind === 'circle' && s.r === 25);
  assert.ok(disc, 'cinder: the crater lake is not on the map');
  const rgb = disc.fill.match(/(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/).slice(1).map(Number);
  /* It was the literal rgba(255,110,30,0.55). Derived from `hot`, `crust`,
   * `color` and `emissive` it lands within a few percent of that, which is the
   * deliberate, stated change to the calibrated planet's map. */
  assert.ok(Math.abs(rgb[0] - 255) < 30 && Math.abs(rgb[1] - 110) < 30 && Math.abs(rgb[2] - 30) < 30,
    `cinder: lava reads as rgb(${rgb}); the hard-coded value it replaces was rgb(255,110,30)`);

  const ribbon = shapes.find((s) => s.kind === 'path');
  assert.ok(ribbon, 'cinder: the outlet gorge flow is still missing from the map');
  assert.ok(ribbon.points.length >= 2 && Number.isFinite(ribbon.points[0][0]),
    'cinder: the gorge path is not an array-of-pairs and will draw as nothing');
});

/* ================================================================== */
/* 6. THE DEPTH TERM                                                  */
/* ================================================================== */

test('water gets a depth term and lava keeps the shader it was calibrated with', async () => {
  const cinderMat = createLiquidMaterial(PLANETS.cinder.liquid, null);
  assert.equal(cinderMat.depth.amount, 0,
    'cinder: a depth term switched itself on for lava. Volcanic.js is the calibrated reference and its '
    + 'look was tuned by measurement; a default that changes it is a change nobody asked for');
  assert.equal(cinderMat.material.customProgramCacheKey(), 'planet.liquid.v1',
    'cinder: the lava program key moved, so the shipped reference is no longer compiling the shader it was tuned with');
  assert.ok(!Object.keys(cinderMat.uniforms).includes('uBed'),
    'cinder: a bed sampler was bound to a material that has no depth term');
  cinderMat.material.dispose();

  const { world } = await planet('shoal');
  assert.ok(world._liquidDepth.amount > 0, 'shoal: the sea has no depth term');
  assert.equal(world._liquidDepth.kind, 'water');

  const d = world._liquidDepth;
  const tone = (depth, noise) => {
    const dw = 1 - Math.exp(-depth / d.scale);
    return Math.min(1, Math.max(0, noise * (1 - d.amount) + dw * d.amount));
  };
  const shallow = tone(0.3, 0.5);
  const deep = tone(20, 0.5);
  assert.ok(Number.isFinite(shallow) && Number.isFinite(deep), 'the depth mirror produced a non-finite tone');
  assert.ok(deep - shallow > 0.5,
    `shoal: 0.3 m and 20 m of water differ by ${(deep - shallow).toFixed(2)} on the crust->deep axis - `
    + 'that is the "a lagoon looks like open ocean" defect surviving the fix');

  for (const abuse of [{ scale: 0 }, { scale: -3 }, { surfBand: 0 }, { amount: 99 }, { scale: NaN }]) {
    const dd = liquidDepth({ emissive: 0.1, depth: abuse });
    assert.ok(dd.scale > 0 && dd.surfBand > 0 && dd.amount <= 1 && dd.amount >= 0,
      `a descriptor with depth ${JSON.stringify(abuse)} produced ${JSON.stringify(dd)} - a division by zero in a fragment shader`);
  }
});

test('the liquid census is reported so a dormant flag is visible', async () => {
  for (const id of LIQUID_IDS) {
    const { world } = await planet(id);
    const c = world.census.liquid;
    assert.ok(c, `${id}: no liquid census`);
    for (const k of ['wetCells', 'cells', 'contourSegments', 'barrierRuns', 'barrierPosts', 'parapet']) {
      assert.ok(Number.isFinite(c[k]), `${id}: census.liquid.${k} is ${c[k]}`);
    }
    assert.ok(c.parapet >= 2.0, `${id}: parapet ${c.parapet} m is under the floor`);
    /* `liquid.lethal` is in the schema, the docs say it is there "so the day it
     * turns true nothing has to be re-plumbed", and nothing in the build reads
     * it. Surfacing it in the census is not plumbing it - it is making sure the
     * next person can SEE that it is false everywhere. */
    assert.equal(typeof c.lethal, 'boolean');
  }
});

/* ================================================================== */
/* 7. WATER YOU CAN BE IN                                             */
/* ================================================================== */

/**
 * The gap this section was written for, verbatim from the brief:
 *
 *   "PlanetWorld sets swim: false. Planet water is not swimmable.
 *    liquid.lethal is declared in the schema, set on nothing, and READ BY
 *    NOTHING."
 *
 * Both halves are one decision - swimmability was a property of the WORLD, so
 * the only way to refuse Cinder's lava was to refuse Shoal's ocean with it.
 * It is a property of the LIQUID now.
 */

test('swimmability is a property of the liquid, not of the world', async () => {
  const rows = [];
  for (const id of LIQUID_IDS) {
    const { world } = await planet(id);
    const L = PLANETS[id].liquid;
    const sub = liquidSubstance(L);
    const haz = liquidHazard(L);
    assert.ok(sub === 'water' || sub === 'lava' || sub === 'acid', `${id}: substance "${sub}"`);

    /* The rendering kind must NOT have moved. Sallow renders through the water
     * branch and burns like acid, and that pair is the whole reason the
     * substance is a second axis: collapsing them would either make acid
     * swimmable or re-tune Cinder, whose look was calibrated by measurement. */
    const kind = liquidKind(L);
    assert.ok(kind === 'lava' || kind === 'water', `${id}: liquidKind gave "${kind}"`);
    if (sub === 'acid') assert.equal(kind, 'water', `${id}: acid must still RENDER as water`);

    assert.equal(liquidSwimmable(L), sub === 'water' && !L.lethal, `${id}: swimmable disagrees with the substance`);
    assert.equal(world.rules.swim, liquidSwimmable(L),
      `${id}: the world's swim rule is ${world.rules.swim} and its liquid is ${sub}`);

    if (haz.lethal) {
      assert.ok(haz.dps > 0, `${id}: lethal with ${haz.dps} dps does nothing at all`);
      assert.ok(Number.isFinite(haz.dps), `${id}: dps ${haz.dps} reaches applyDamage`);
      assert.equal(liquidSwimmable(L), false, `${id}: a lethal liquid you can swim in is a bath with a timer`);
    } else {
      assert.equal(haz.dps, 0, `${id}: a non-lethal liquid quotes ${haz.dps} dps`);
    }
    rows.push(`     ${id.padEnd(11)} ${sub.padEnd(6)} renders as ${kind.padEnd(6)} `
      + `swim ${String(liquidSwimmable(L)).padEnd(5)} ${haz.lethal ? `LETHAL ${haz.dps} dps` : 'harmless'}`
      + `   ${world.census.liquid.barrierPosts} posts`);
  }
  console.log('   WHAT EACH LIQUID IS, AND WHAT IT DOES');
  for (const r of rows) console.log(r);

  /* A dry planet must not acquire a swim rule from nowhere, and must not
   * publish a liquid field for `WaterVolumes` to believe. */
  for (const id of Object.keys(PLANETS)) {
    if (PLANETS[id].liquid) continue;
    const { world } = await planet(id);
    assert.equal(world.rules.swim, false, `${id} has no liquid and permits swimming`);
    assert.equal(world.liquidField, null, `${id} has no liquid and published a liquid field`);
  }
});

test('the world answers for its own liquid rather than being scanned', async () => {
  /* `WaterVolumes` infers volumes from geometry because the hand-built worlds
   * have no authored water. A planet does. Decomposing Shoal's sea - one
   * 128-triangle fan 2,700 m across - onto that system's 8 m lattice would
   * build on the order of 450,000 Box3 volumes for a shape `liquidSurfaceAt`
   * answers exactly. So the world publishes `liquidField` and is believed, and
   * this asserts the answer is the SAME surface the mesh was built from. */
  const { WaterVolumes } = await import('../../src/systems/WaterVolumes.js');
  for (const id of LIQUID_IDS) {
    const { world } = await planet(id);
    const L = PLANETS[id].liquid;
    const f = world.liquidField;
    assert.ok(f && typeof f.surfaceAt === 'function', `${id}: no liquidField`);

    const listeners = new Map();
    const bus = {
      on: (k, fn) => { listeners.set(k, fn); return () => listeners.delete(k); },
      emit: () => {},
    };
    const water = new WaterVolumes({ bus });
    water.rebuildFromWorld(world);
    assert.equal(water.describe().field?.name, f.name, `${id}: WaterVolumes did not take the world's answer`);

    let checked = 0;
    const b = L.bodies[0];
    const at = b.shape === 'disc' ? [b.x, b.z] : b.pts[0];
    for (let k = 0; k < 64; k++) {
      const a = (k / 64) * Math.PI * 2;
      for (const d of [0, 3, 9, 21]) {
        const x = at[0] + Math.cos(a) * d;
        const z = at[1] + Math.sin(a) * d;
        const want = liquidSurfaceAt(L, x, z);
        assert.equal(f.surfaceAt(x, z), want, `${id}: liquidField disagrees with the mesh at (${x},${z})`);
        assert.equal(water.surfaceYAt(x, z), want === null ? null : want,
          `${id}: WaterVolumes disagrees with the field at (${x},${z})`);
        const q = water.liquidAt(x, z);
        if (want === null) assert.equal(q, null);
        else {
          assert.equal(q.surfaceY, want);
          assert.equal(q.swimmable, liquidSwimmable(L));
          assert.equal(q.lethal, liquidHazard(L).lethal);
        }
        checked++;
      }
    }
    assert.ok(checked > 200, `${id}: only ${checked} samples`);
    water.dispose();
  }
});

test('lava kills, acid hurts, and water does neither - driven through the real Swim', async () => {
  /* THE FLAG IS WIRED. Not "the descriptor says lethal" - a body in it loses
   * health, through the shipped `Swim.fixedUpdate` at the shipped 60 Hz, with
   * the shipped `applyDamage`.
   *
   * The stub is a player and nothing else: the lethal branch returns before
   * `_integrate`, so a position, a health pool and `applyDamage` is the whole
   * of what the code path touches. Driving the real `Player` here would drag
   * in the avatar, the stamina pool and the input map for no extra coverage. */
  const { Swim } = await import('../../src/player/Swim.js');
  const THREE = await import('three');

  const drive = (hazard, seconds, startY = -1) => {
    const events = [];
    const player = {
      position: new THREE.Vector3(0, startY, 0),
      velocity: new THREE.Vector3(),
      health: 100,
      isDead: false,
      gravityRatio: 1,
      stamina: null,
      /* The swimmable branch DOES run for the control case, and these four are
       * every hook `_integrate` reaches on a frame with no input. Stubbing
       * them rather than skipping the water case matters: "water does not hurt
       * you" has to be measured on the path water actually takes. */
      pitch: 0,
      yaw: 0,
      speedMultiplier: 1,
      avatar: null,
      setStanceWet() {},
      setSwimContact() {},
      applyDamage(n) {
        if (this.isDead) return 0;
        const applied = Math.min(this.health, n);
        this.health -= applied;
        if (this.health <= 0) this.isDead = true;
        return applied;
      },
    };
    const bus = { emit: (k, e) => events.push([k, e]), on: () => () => {} };
    const swim = new Swim({
      player, bus,
      input: { state: { forward: 0, right: 0, jump: false, crouch: false, sprint: false } },
      physics: { groundHeight: () => -8, resolveCapsule: () => ({ grounded: false }) },
    });
    swim.setVolumes({ liquidAt: () => ({ surfaceY: 0, ...hazard }) });
    const dt = 1 / 60;
    let t = 0;
    for (let k = 0; k < Math.ceil(seconds / dt); k++) {
      swim.fixedUpdate(dt, k * dt);
      t = (k + 1) * dt;
      if (player.isDead) break;
    }
    return { player, events, t, swim };
  };

  const lava = { swimmable: false, lethal: true, dps: 240, cause: 'lava', name: 'lava' };
  const acid = { swimmable: false, lethal: true, dps: 14, cause: 'acid', name: 'acid' };
  const water = { swimmable: true, lethal: false, dps: 0, cause: 'water', name: 'sea water' };

  const inLava = drive(lava, 3);
  assert.ok(inLava.player.isDead, `lava left the player on ${inLava.player.health} hp after 3 s`);
  assert.ok(inLava.t < 0.6, `lava took ${inLava.t.toFixed(2)} s to kill; 240 dps against 100 hp is 0.42 s`);

  const inAcid = drive(acid, 4);
  assert.ok(!inAcid.player.isDead, 'acid killed inside four seconds - that is lava, not acid');
  assert.ok(inAcid.player.health < 50 && inAcid.player.health > 30,
    `acid left ${inAcid.player.health} hp after 4 s; 14 dps predicts about 44`);
  const dead = drive(acid, 12);
  assert.ok(dead.player.isDead, 'standing in acid is survivable indefinitely');

  const inWater = drive(water, 5);
  assert.equal(inWater.player.health, 100, 'swimmable water took health');

  /* The entry is announced once and the exit once, so a HUD can latch on it
   * rather than counting damage ticks. */
  const said = inAcid.events.filter(([k]) => k === 'player:liquid');
  assert.ok(said.length >= 1 && said[0][1].in === true && said[0][1].name === 'acid',
    `player:liquid was not announced on entry: ${JSON.stringify(said.slice(0, 2))}`);
  assert.equal(said.filter(([, e]) => e.in).length, 1, 'entry was announced more than once');

  /* And the burn stops the moment the body is out of the plane. A stream of
   * damage that outlives the hazard is how a player dies on dry land. */
  const out = drive(acid, 2, 0.5);      // feet above the surface
  assert.equal(out.player.health, 100, 'a body standing ABOVE the acid plane took damage');
  assert.equal(out.swim.burning, false);

  console.log(`   lava ${inLava.t.toFixed(2)} s to kill | acid 4 s -> ${inAcid.player.health} hp,`
    + ` dead at ${dead.t.toFixed(2)} s | water 5 s -> ${inWater.player.health} hp`);
});

test('a swimmable surface can be seen from underneath, and Cinder is untouched', async () => {
  /* The playthrough that got into Shoal's sea reported "a dry, dusty grey
   * plain to the horizon under an open sky, while the minimap is solid blue
   * with you in the middle of it". A disc is a fan wound to face UP - which
   * `planet-relief.test.mjs` asserts, because a face-down sea is 340 m of
   * river that is not in the frame - so from below it is culled and there is
   * no surface at all. */
  const THREE = await import('three');
  for (const id of LIQUID_IDS) {
    const { world } = await planet(id);
    const swimmable = liquidSwimmable(PLANETS[id].liquid);
    const group = world.group.getObjectByName(`planet:${id}:liquid`);
    assert.ok(group, `${id}: no liquid group`);
    let surfaces = 0;
    group.traverse((o) => {
      if (!o.isMesh || !o.material) return;
      if (!o.name.startsWith('liquid:')) return;
      surfaces++;
      assert.equal(o.material.side, swimmable ? THREE.DoubleSide : THREE.FrontSide,
        `${id}: liquid mesh "${o.name}" is ${swimmable ? 'single' : 'double'}-sided`);
    });
    assert.ok(surfaces >= 2, `${id}: only ${surfaces} liquid meshes`);
  }

  /* CINDER IS THE CALIBRATED REFERENCE. Its look was tuned by measurement, so
   * every lever this change could have moved is pinned: the compiled program,
   * the depth term, the face it draws and the light it hangs. */
  const { world } = await planet('cinder');
  assert.equal(world._liquidDepth.amount, 0, 'cinder: a depth term switched itself on for lava');
  const surf = world.group.getObjectByName('planet:cinder:liquid').getObjectByName('liquid:0');
  assert.equal(surf.material.customProgramCacheKey(), 'planet.liquid.v1',
    'cinder: the lava program key moved; the shipped reference is no longer the shader it was tuned with');
  assert.equal(surf.material.side, THREE.FrontSide, 'cinder: the lava surface became double-sided');
  assert.equal(liquidKind(PLANETS.cinder.liquid), 'lava');
  assert.equal(liquidSwimmable(PLANETS.cinder.liquid), false);
  /* 819 -> 1638, and it is a SHAPE change rather than a coverage change: the
   * stations are the same 819 in the same places, and each is two boxes now.
   * A 2.2 m square post has a standable top, so a sustained free climb tops out
   * on it and is hoisted over; the wall is a 2.2 m PLINTH stopped at head
   * height with a 0.50 m CAP carrying the rest of the gate, and half a metre
   * has nowhere on it to put a body. `barrierStations` is the number to compare
   * against the old one. @see src/worlds/PlanetWorld.js above POST_HALF */
  assert.equal(world.census.liquid.barrierStations, 819,
    'cinder: the lava shore lost or gained stations - the fence is what it is FOR now');
  assert.equal(world.census.liquid.barrierPosts, 1638,
    'cinder: a shore station is a plinth and a cap; the collider count no longer matches');
});

/* ================================================================== */
/* 8. THE FLOOR OF THE WORLD                                          */
/* ================================================================== */

test('a falling body meets the floor before it meets the void, on every planet', async () => {
  /* THE DEFECT, MEASURED. A capsule resolved at Shoal's own deepest sea-bed
   * sample (-431, 440) is pushed to z = 440.33 - 33 cm past the height field's
   * footprint - and from there `sampleHeight` is null, nothing else is under
   * it, and it falls without limit: -60, -200, -400. The playthrough that
   * reported "hp 0 at -33.9 and the body kept falling to -116.7" is this, and
   * the void catch never fired because `RESPAWN_DELAY` is 3.2 s and
   * `UnstuckSystem` waits for `bounds.min.y - 25`.
   *
   * Every planet has a `rim` that falls away at its edge, so every planet ends
   * in a lip a body can be nudged over. This is checked on all ten. */
  const THREE = await import('three');
  const VOID_MARGIN = 25;   // UnstuckSystem.VOID_MARGIN
  const rows = [];
  for (const id of Object.keys(PLANETS)) {
    const { world, physics } = await planet(id);
    const floor = world.census.floor;
    assert.ok(floor, `${id}: no floor was built`);
    const bound = world.bounds.min.y;

    /* THE ORDERING IS THE WHOLE POINT: floor, then bound, then void. */
    assert.ok(floor.top > bound, `${id}: the floor at ${floor.top} is below its own world bound ${bound}`);
    assert.ok(bound - VOID_MARGIN < floor.top,
      `${id}: the void catch at ${(bound - VOID_MARGIN).toFixed(1)} is above the floor at ${floor.top}`);
    /* ...and the floor must never be standing room. Every reach probe blocks a
     * box whose top is above `groundY + stepHeight`; 6 m under the terrain's
     * own minimum clears 0.45 m by more than a decimal order. */
    assert.ok(floor.top < floor.terrainMinY - 1,
      `${id}: the floor at ${floor.top} is within a metre of the terrain minimum ${floor.terrainMinY}`);

    const g = -22 * (PLANETS[id].gravity / 9.81);
    const half = PLANETS[id].half;
    const drops = [
      [0, 0], [half - 2, 0], [-half + 2, half - 2],
      [half + 90, half + 90], [-half - 140, 60],
    ];
    let worst = Infinity;
    for (const [x, z] of drops) {
      const pos = new THREE.Vector3(x, 90, z);
      let vy = 0;
      let landed = false;
      for (let k = 0; k < 60 * 30; k++) {
        vy += g / 60;
        pos.y += vy / 60;
        if (physics.resolveCapsule(pos, 0.35, 1.75).grounded) { landed = true; break; }
        if (pos.y < bound - VOID_MARGIN) break;
      }
      assert.ok(landed,
        `${id}: a capsule dropped at (${x},${z}) fell past the void catch to ${pos.y.toFixed(1)} m. `
        + 'This is the "body kept falling to -116.7" defect, on a different planet.');
      worst = Math.min(worst, pos.y);
    }
    rows.push(`     ${id.padEnd(11)} terrain min ${floor.terrainMinY.toFixed(1).padStart(7)}  `
      + `floor ${floor.top.toFixed(1).padStart(7)}  bound ${bound.toFixed(1).padStart(7)}  `
      + `void ${(bound - VOID_MARGIN).toFixed(1).padStart(7)}  deepest landing ${worst.toFixed(1)}`);
  }
  console.log('   FLOOR, THEN BOUND, THEN VOID - on all ten planets');
  for (const r of rows) console.log(r);
});

test('the playfield edge is walled wherever liquid crosses it', async () => {
  /* Shoal's sea is drawn as one disc 2,700 m across and its ground stops at
   * 440: 1,764 of 1,764 samples of the playfield boundary are under water.
   * That did not matter while the shore was fenced. It matters the moment a
   * swimmer can strike out from the beach, because `Swim` would keep finding a
   * surface for another two kilometres over ground that is not there. */
  const { world, physics } = await planet('shoal');
  const boxes = physics.colliders.filter((c) => c.userData?.planetEdgeWall);
  assert.ok(boxes.length > 0, 'shoal: the sea runs off the map and nothing stops a swimmer');
  assert.equal(boxes.length, world.census.edgeWall);
  for (const c of boxes) {
    const m = c.matrix.elements;
    /* Axis-aligned, for the same reason every shore post is: a reach probe
     * models a collider by its bounds, and a turned panel is a lie about how
     * much ground it takes. */
    assert.ok(Math.abs(m[0] - 1) < 1e-9 && Math.abs(m[2]) < 1e-9 && Math.abs(m[8]) < 1e-9,
      'shoal: an edge-wall box is rotated');
    for (const v of [m[12], m[13], m[14], c.halfExtents.x, c.halfExtents.y, c.halfExtents.z]) {
      assert.ok(Number.isFinite(v), `shoal: an edge-wall box carries ${v}`);
    }
    const half = PLANETS.shoal.half;
    assert.ok(Math.abs(Math.abs(m[12]) - half) < 1e-6 || Math.abs(Math.abs(m[14]) - half) < 1e-6,
      'shoal: an edge-wall box is not on the playfield boundary');
  }

  /* And a body swum at it is stopped, at the surface rather than under it. */
  const THREE = await import('three');
  const pos = new THREE.Vector3();
  const SEA = PLANETS.shoal.liquid.bodies[0].y;
  let crossed = 0;
  for (let k = 0; k < 24; k++) {
    const t = -420 + (840 * k) / 23;
    pos.set(430, SEA - 0.6, t);
    for (let i = 0; i < 40; i++) {
      pos.x += 0.5;
      physics.resolveCapsule(pos, 0.35, 1.75);
    }
    if (pos.x > PLANETS.shoal.half) crossed++;
  }
  assert.equal(crossed, 0, `shoal: a swimmer crossed the playfield edge on ${crossed} of 24 lines`);
});
