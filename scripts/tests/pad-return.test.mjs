import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';

/**
 * CAN A BODY WALK BACK TO ITS SHIP? THE PAD MARKING, MEASURED.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 *  WHY THIS FILE EXISTS
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Seven of the ten planets have a landing pad you can walk off and never walk
 * back onto. That is DESIGN - it is what makes the exotic seam cost a second
 * landing - and the amber hazard blocks around a pad rim exist to say so on the
 * ground, because a player who lands on a 20 m disc notched into a crater rim
 * finds out what they have done forty seconds later otherwise.
 *
 * The blocks used to be painted from `PlanetWorld._padDrop`, which measures how
 * much of the horizon within 46 m FALLS AWAY. That is a cliff test, and it
 * answers a different question from the one the blocks are asking. Measured on
 * all ten planets, the two do not even correlate:
 *
 *     pad                cliff test     can walk home
 *     tessera raysedge   300 deg        98.2%      painted, and perfectly safe
 *     shoal   sunder     263 deg        99.9%      painted, and perfectly safe
 *     lathe   highwall   233 deg       100.0%      painted, and perfectly safe
 *     verdigris crown      0 deg         6.7%      SILENT, and a one-way trip
 *     cathedra  gallery    0 deg        24.9%      SILENT, and a one-way trip
 *     carnelian kiln       0 deg        49.8%      SILENT, and a one-way trip
 *
 * So the blocks are painted from `_padReturn` now. This file is the check that
 * the build's own answer is the right one, and it does not take the build's
 * word for it: every number below is re-derived here, at a DIFFERENT LATTICE
 * PITCH and from an independent implementation, off the real collision bed and
 * the real colliders of a real build.
 *
 * ── The three floods, and why forwards alone finds nothing ────────────────
 * A forward walk flood from a pad reports no trap anywhere on any planet,
 * because a walk cannot cross a 60 degree face - and a body can, downwards, any
 * time it likes. So "where can I end up" is the walk PLUS unlimited descent,
 * and "can I get home" is the walk rule REVERSED, because a ledge you dropped
 * off is not an edge you can climb.
 */

/* ------------------------------------------------------------------ */
/* The envelope. `planet-reach`'s rule, at `pad-trap`'s pitch.          */
/* ------------------------------------------------------------------ */

/** Independent of the build's, which walks the bed's own ~3.1 m grid. */
const PITCH = 2.0;
const SLOPE_MAX_TAN = Math.tan((38 * Math.PI) / 180);
const MAX_RISE = Math.max(0.45, PITCH * SLOPE_MAX_TAN);
const STEP_UP = 0.45;
const DROP_MAX = 3.0;
const HEADROOM = 1.9;

/**
 * THE MEASURED VERDICT, PAD BY PAD, AND IT IS A LEDGER RATHER THAN A GUESS.
 *
 * Every pad on every planet, with the share of the ground reachable from it
 * that can walk back. Listed rather than derived so that a descriptor change
 * that quietly stranded a pad - or quietly un-stranded one - shows up as a
 * number that moved rather than as a marking that silently changed. The
 * tolerance is 6 points, which is wider than the 5-point disagreement the two
 * lattice pitches show at their worst and far narrower than the 42-point gap
 * the verdict is decided in.
 */
const RETURN_PCT = Object.freeze({
  cinder: { ashfall: 95, rimhold: 3, colonnade: 95 },
  tessera: { mosaic: 98, raysedge: 98, coldwell: 100 },
  sirocco: { panhead: 98, rimwatch: 98, windward: 45 },
  shoal: { glassflat: 100, kelphold: 100, sunder: 99 },
  vitrine: { firn: 95, blackhorn: 95, vaultmouth: 5 },
  verdigris: { greenspan: 93, sumphead: 93, crown: 7 },
  lathe: { drifthead: 100, shepherd_notch: 8, highwall: 100 },
  carnelian: { redgate: 92, anvil: 92, kiln: 50 },
  sallow: { cauldron: 100, stillwater: 100, throat: 2 },
  cathedra: { pavement: 100, gallery: 25, lantern: 18 },
});

/**
 * The nine pads a body cannot get home from, on eight planets.
 *
 * This IS "seven of the ten planets have a pad you can walk off and never walk
 * back onto", found by measurement rather than by eye - and it is eight, not
 * seven, because Cathedra has two.
 */
const ONE_WAY = Object.freeze([
  'cinder/rimhold', 'sirocco/windward', 'vitrine/vaultmouth', 'verdigris/crown',
  'lathe/shepherd_notch', 'carnelian/kiln', 'sallow/throat',
  'cathedra/gallery', 'cathedra/lantern',
]);

/* ------------------------------------------------------------------ */

function harness() {
  if (globalThis.__padReturnHarness) return;
  globalThis.__padReturnHarness = true;
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
harness();

const { PLANETS } = await import('../../src/worlds/planets/index.js');
const { PlanetWorld } = await import('../../src/worlds/PlanetWorld.js');
const { Physics, COLLISION_LAYER } = await import('../../src/physics/Physics.js');
const { liquidCellMask } = await import('../../src/worlds/planets/PlanetLiquid.js');

const _built = new Map();
async function planet(id) {
  if (_built.has(id)) return _built.get(id);
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

/** Bilinear read of the collision bed: the surface the capsule sits on. */
function bedSampler(bed) {
  const { heights, nx, nz, originX, originZ, stepX, stepZ } = bed;
  return (x, z) => {
    const fx = (x - originX) / stepX;
    const fz = (z - originZ) / stepZ;
    if (!(fx >= 0 && fz >= 0 && fx <= nx - 1 && fz <= nz - 1)) return null;
    const i = Math.min(nx - 2, Math.floor(fx));
    const j = Math.min(nz - 2, Math.floor(fz));
    const tx = fx - i;
    const tz = fz - j;
    const h00 = heights[j * nx + i];
    const h10 = heights[j * nx + i + 1];
    const h01 = heights[(j + 1) * nx + i];
    const h11 = heights[(j + 1) * nx + i + 1];
    return (h00 * (1 - tx) + h10 * tx) * (1 - tz) + (h01 * (1 - tx) + h11 * tx) * tz;
  };
}

/** Every solid box on an 8 m XZ grid, by its axis-aligned bounds. */
function boxIndex(physics) {
  const cell = 8;
  const grid = new Map();
  for (const c of physics.colliders) {
    if (!c.solid || c.type !== 'box') continue;
    if (((c.layer ?? COLLISION_LAYER.WORLD) & COLLISION_LAYER.WORLD) === 0) continue;
    const m = c.matrix.elements;
    const b = {
      x: m[12], y: m[13], z: m[14],
      ax: Math.abs(m[0]) * c.halfExtents.x + Math.abs(m[4]) * c.halfExtents.y + Math.abs(m[8]) * c.halfExtents.z,
      ay: Math.abs(m[1]) * c.halfExtents.x + Math.abs(m[5]) * c.halfExtents.y + Math.abs(m[9]) * c.halfExtents.z,
      az: Math.abs(m[2]) * c.halfExtents.x + Math.abs(m[6]) * c.halfExtents.y + Math.abs(m[10]) * c.halfExtents.z,
    };
    for (let cx = Math.floor((b.x - b.ax) / cell); cx <= Math.floor((b.x + b.ax) / cell); cx++) {
      for (let cz = Math.floor((b.z - b.az) / cell); cz <= Math.floor((b.z + b.az) / cell); cz++) {
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

/** The whole measurement for one planet, re-derived at 2 m. */
const _measured = new Map();
async function measure(id) {
  if (_measured.has(id)) return _measured.get(id);
  const { world, physics } = await planet(id);
  const bed = world._bed;
  const ground = bedSampler(bed);
  const blocked = boxIndex(physics);
  const half = world.planet.half;
  const mask = liquidCellMask({
    liquid: world.planet.liquid, heights: bed.heights, nx: bed.nx, nz: bed.nz,
    originX: bed.originX, originZ: bed.originZ, stepX: bed.stepX, stepZ: bed.stepZ,
  });
  /** Is (x, z) under a liquid surface? Read off the bed's own cell mask. */
  const wet = (x, z) => {
    if (!mask.wetCount) return false;
    const ci = Math.floor((x - bed.originX) / bed.stepX);
    const cj = Math.floor((z - bed.originZ) / bed.stepZ);
    if (ci < 0 || cj < 0 || ci >= mask.cx || cj >= mask.cz) return false;
    return !!mask.wet[cj * mask.cx + ci];
  };

  const n = Math.floor((half * 2) / PITCH) + 1;
  const at = (i, j) => j * n + i;
  const ok = new Uint8Array(n * n);
  const dry = new Uint8Array(n * n);
  const y = new Float32Array(n * n);
  for (let j = 0; j < n; j++) {
    const z = -half + j * PITCH;
    for (let i = 0; i < n; i++) {
      const x = -half + i * PITCH;
      const g = ground(x, z);
      if (g === null || !Number.isFinite(g)) continue;
      y[at(i, j)] = g;
      if (wet(x, z)) continue;
      dry[at(i, j)] = 1;
      const gx = ground(x + PITCH * 0.5, z);
      const gnx = ground(x - PITCH * 0.5, z);
      const gz = ground(x, z + PITCH * 0.5);
      const gnz = ground(x, z - PITCH * 0.5);
      if (gx === null || gnx === null || gz === null || gnz === null) continue;
      if (Math.hypot((gx - gnx) / PITCH, (gz - gnz) / PITCH) > SLOPE_MAX_TAN) continue;
      if (blocked(x, z, g)) continue;
      ok[at(i, j)] = 1;
    }
  }

  const flood = (seed, edge) => {
    const seen = new Uint8Array(n * n);
    const stack = [];
    seen[seed] = 1;
    stack.push(seed);
    while (stack.length) {
      const k = stack.pop();
      const i = k % n;
      const j = (k - i) / n;
      const here = y[k];
      for (const [di, dj] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const a = i + di;
        const b = j + dj;
        if (a < 0 || b < 0 || a >= n || b >= n) continue;
        const m = at(a, b);
        if (seen[m] || !edge(here, m)) continue;
        seen[m] = 1;
        stack.push(m);
      }
    }
    return seen;
  };

  const rows = [];
  for (const site of world.landingSites) {
    const si = Math.round((site.position.x + half) / PITCH);
    const sj = Math.round((site.position.z + half) / PITCH);
    const seed = at(si, sj);
    if (!ok[seed]) { rows.push({ id: site.id, pct: 100, site, unmeasured: true }); continue; }
    // Where a body can END UP: the walk, plus unlimited descent.
    const up = flood(seed, (here, m) => {
      if (!dry[m]) return false;
      const d = y[m] - here;
      return d <= 0 ? true : (!!ok[m] && d <= MAX_RISE);
    });
    // Where a walk RETURNS from: the forward rule, reversed.
    const back = flood(seed, (here, m) => {
      if (!ok[m]) return false;
      const d = here - y[m];
      return d <= MAX_RISE && d >= -DROP_MAX;
    });
    let total = 0;
    let home = 0;
    for (let k = 0; k < up.length; k++) {
      if (!up[k] || !ok[k]) continue;
      total++;
      if (back[k]) home++;
    }
    rows.push({ id: site.id, pct: total ? (100 * home) / total : 100, site });
  }
  const rec = { world, rows };
  _measured.set(id, rec);
  return rec;
}

const ids = Object.keys(PLANETS);

/* ================================================================== */

test('every pad publishes a finite return measurement', async () => {
  /* NO NON-FINITE VALUES. A NaN here is a NaN in the flight HUD and a NaN in
   * the matrix of an instanced mesh, and 19 NaN pixels have already blacked out
   * a 921,600-pixel frame in this project once. */
  const bad = [];
  for (const id of ids) {
    const { world } = await planet(id);
    for (const s of world.landingSites) {
      const h = s.home;
      if (!h) { bad.push(`${id}/${s.id}: publishes no home measurement at all`); continue; }
      for (const k of ['pct', 'metres', 'area']) {
        if (!Number.isFinite(h[k])) bad.push(`${id}/${s.id}: home.${k} is ${h[k]}`);
      }
      if (typeof h.oneWay !== 'boolean') bad.push(`${id}/${s.id}: home.oneWay is ${h.oneWay}`);
      if (h.pct < 0 || h.pct > 100) bad.push(`${id}/${s.id}: home.pct is ${h.pct}`);
      // The cliff number survives untouched beside it - two facts, two names.
      if (!Number.isFinite(s.drop?.deg) || !Number.isFinite(s.drop?.metres)) {
        bad.push(`${id}/${s.id}: drop is ${JSON.stringify(s.drop)}`);
      }
    }
  }
  assert.deepEqual(bad, [], bad.join('\n  '));
});

test('the build agrees with an independent flood at a different lattice pitch', async () => {
  /* THE BUILD MEASURING ITSELF IS NOT EVIDENCE. `_padReturn` walks the bed's
   * own ~3.1 m grid, which is the cheap lattice a build can afford; this walks a
   * 2 m one, bilinearly sampled, with its own flood. If the two agree on thirty
   * pads then the verdict is a property of the terrain rather than of either
   * implementation - and if they ever stop agreeing, the pitch has started to
   * matter, which is itself the finding. */
  const rows = [];
  const wrong = [];
  for (const id of ids) {
    const { rows: mine } = await measure(id);
    for (const r of mine) {
      const built = r.site.home;
      const listed = RETURN_PCT[id]?.[r.id];
      rows.push(`     ${id.padEnd(11)} ${r.id.padEnd(16)} build ${built.pct.toFixed(1).padStart(5)}%`
        + `  independent ${r.pct.toFixed(1).padStart(5)}%  ${built.oneWay ? 'ONE-WAY' : 'returnable'}`);
      if (Math.abs(built.pct - r.pct) > 6) {
        wrong.push(`${id}/${r.id}: the build says ${built.pct.toFixed(1)}% of the ground it reaches walks home, `
          + `a 2 m lattice says ${r.pct.toFixed(1)}%`);
      }
      if (listed === undefined) {
        wrong.push(`${id}/${r.id} is not in RETURN_PCT - a new pad has appeared and nobody has measured it`);
      } else if (Math.abs(built.pct - listed) > 6) {
        wrong.push(`${id}/${r.id} is listed at ${listed}% and measures ${built.pct.toFixed(1)}% - `
          + 'the terrain under a pad has moved, so update the ledger and look at the pad');
      }
      // The two lattices must reach the same VERDICT, which is the thing painted.
      if (built.oneWay !== (r.pct < 70)) {
        wrong.push(`${id}/${r.id}: the build calls it ${built.oneWay ? 'one-way' : 'returnable'} `
          + `and a 2 m lattice measures ${r.pct.toFixed(1)}% - the verdict depends on the pitch`);
      }
    }
  }
  console.log('   CAN A BODY WALK BACK TO ITS SHIP?');
  for (const r of rows) console.log(r);
  assert.deepEqual(wrong, [], wrong.join('\n  '));
});

test('the one-way pads are the nine measured ones, and no others', async () => {
  const found = [];
  for (const id of ids) {
    const { world } = await planet(id);
    for (const s of world.landingSites) if (s.home.oneWay) found.push(`${id}/${s.id}`);
  }
  assert.deepEqual(found.sort(), [...ONE_WAY].sort(),
    'the set of pads a body cannot walk home from has changed. That is either a real world change '
    + 'worth looking at or a regression in the measurement - it is never a list to edit without doing both');
  /* And no PRIMARY is one of them: `primary` is where an atmospheric entry
   * puts a ship and where `Unstuck` returns a body, so a one-way primary is not
   * a balance question, it is a stranding on arrival. */
  for (const id of ids) {
    const { world } = await planet(id);
    const primary = world.landingSites.find((s) => s.primary) ?? world.landingSites[0];
    assert.equal(primary.home.oneWay, false,
      `${id}: a ship arrives at ${primary.id}, from which only ${primary.home.pct}% of the ground `
      + 'it reaches can walk back');
  }
});

test('the rim ring is painted on exactly the pads that are one-way, and nowhere else', async () => {
  /* THE MARKING MEANS ONE THING. A ring says "most of the ground you can reach
   * on foot from this disc cannot walk back to it" - so a pad wears a COMPLETE
   * ring or none at all, and there is no third state for a player to interpret.
   *
   * MUTATION: paint from `drop.bearings` again and this reports six pads
   * ringed that walk home fine and three one-way pads with nothing on them. */
  const wrong = [];
  for (const id of ids) {
    const { world } = await planet(id);
    for (const s of world.landingSites) {
      let count = 0;
      let seen = 0;
      world.group.traverse((o) => {
        if (o.name !== `planet:${id}:padedge:${s.id}`) return;
        seen++;
        count = o.count;
        // Every instance on the ground, and no non-finite matrix anywhere.
        for (let i = 0; i < o.count; i++) {
          const m = new THREE.Matrix4();
          o.getMatrixAt(i, m);
          const e = m.elements;
          for (let k = 0; k < 16; k++) {
            if (!Number.isFinite(e[k])) { wrong.push(`${id}/${s.id}: block ${i} matrix element ${k} is ${e[k]}`); break; }
          }
          const dx = e[12] - s.position.x;
          const dz = e[14] - s.position.z;
          const r = Math.hypot(dx, dz);
          if (Math.abs(r - (s.radius - 0.7)) > 0.05) {
            wrong.push(`${id}/${s.id}: block ${i} stands ${r.toFixed(2)} m out on a ${s.radius} m disc`);
          }
        }
      });
      if (s.home.oneWay) {
        if (seen !== 1) wrong.push(`${id}/${s.id} is one-way (${s.home.pct}% walks home) and wears ${seen} rings`);
        else if (count !== 48) wrong.push(`${id}/${s.id} is one-way and wears ${count} blocks, not a full ring of 48`);
      } else if (seen !== 0) {
        wrong.push(`${id}/${s.id} walks home at ${s.home.pct}% and is ringed anyway - `
          + 'the ring would then mean two things');
      }
    }
  }
  assert.deepEqual(wrong.slice(0, 12), [], wrong.slice(0, 12).join('\n  '));
});
