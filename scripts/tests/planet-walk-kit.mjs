import { PLANETS } from '../../src/worlds/planets/index.js';

/**
 * THE WALK LATTICE, SHARED.
 *
 * Lifted verbatim out of `planet-minerals.test.mjs`, which built it and was
 * for a while the only file that flooded it. It is imported by that file, by
 * the rare-tier gate that replaced its ratio, and by anything else that has to
 * ask "how far, on foot, from where the player lands".
 *
 * It is a KIT and not a test: it asserts nothing. Everything it exports is a
 * measurement, and the caller decides what a measurement means. The build
 * caches - one real `PlanetWorld` and one lattice mask per planet - are
 * module-level on purpose, because a nearest-neighbour tour runs one flood per
 * node and rebuilding the mask per flood is the difference between 3 s and 3
 * minutes across ten planets.
 */


/* The lattice. Same envelope as `planet-reach.test.mjs` - 2.0 m pitch, 38 deg
 * continuous, 0.45 m step-up, 3.0 m drop, no jump and no mantle - but this one
 * carries DISTANCE, because the question here is not whether a body can get
 * there, it is how long it takes and what it is paid for going. */
const PITCH = 2.0;
const MAX_SLOPE_TAN = Math.tan((38 * Math.PI) / 180);
const MAX_RISE = PITCH * MAX_SLOPE_TAN;
const STEP_UP = 0.45;
const DROP_MAX = 3.0;
const HEADROOM = 1.9;
const ARRIVE = 3.2;

function harness(THREE) {
  if (globalThis.__mineralHarness) return;
  globalThis.__mineralHarness = true;
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

/** Every planet the game registers, in registry order. */
const ALL = Object.values(PLANETS);

const _worlds = new Map();
/**
 * One real world per planet, built once. `PLANETS.cinder` by default so the
 * Cinder-only cases below read the way they always did.
 */
async function world_(planet = PLANETS.cinder) {
  if (_worlds.has(planet.id)) return _worlds.get(planet.id);
  const THREE = await import('three');
  harness(THREE);
  const { Physics, COLLISION_LAYER } = await import('../../src/physics/Physics.js');
  const { PlanetWorld } = await import('../../src/worlds/PlanetWorld.js');
  const { polyDist } = await import('../../src/worlds/planets/Placement.js');
  const physics = new Physics();
  const Cls = PlanetWorld.of(planet);
  const built = new Cls({
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
  built.physics = physics;
  await built.build(() => {});
  const out = { world: built, physics, COLLISION_LAYER, polyDist };
  _worlds.set(planet.id, out);
  return out;
}

/** Every solid world box, indexed on XZ. Straight out of `physics.colliders`. */
function boxIndex(physics, COLLISION_LAYER) {
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

/**
 * One walk lattice, many floods.
 *
 * `planet-reach` rebuilds its mask per flood because it runs four of them. A
 * nearest-neighbour tour runs one flood PER NODE - 119 of them on Cinder - so
 * the standing-room mask is built once and only the distance field is refilled.
 */
function lattice({ ground, blocked, lava, half }) {
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
      if (lava(x, z, g)) continue;
      if (blocked(x, z, g)) continue;
      const gx = ground(x + PITCH * 0.5, z); const gnx = ground(x - PITCH * 0.5, z);
      const gz = ground(x, z + PITCH * 0.5); const gnz = ground(x, z - PITCH * 0.5);
      if (![gx, gnx, gz, gnz].every(Number.isFinite)) continue;
      if (Math.hypot((gx - gnx) / PITCH, (gz - gnz) / PITCH) > MAX_SLOPE_TAN) continue;
      ok[at(i, j)] = 1;
    }
  }
  /* Float64, NOT Float32, AND THIS IS A BUG THAT WAS ALREADY HERE.
   *
   * The relaxation below accepts an improvement of more than 1e-6 m and then
   * STORES it. In a `Float32Array` a distance of about 1 km has a ULP of 6e-5,
   * so an improvement between 1e-6 and 6e-5 passes the test and rounds away in
   * the store: `dist[kk]` does not move, the node is queued again, the same
   * edge relaxes again, and the queue grows without bound. On Cinder the graph
   * never triggered it. On Sallow it does immediately - `q.push` throws
   * `RangeError: Invalid array length` - which is what running this on a second
   * planet found. Float64 carries the 1e-6 threshold with fifteen digits to
   * spare and the loop terminates. */
  const dist = new Float64Array(n * n);
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
  return {
    /** Seed at (x,z) and relax; the field stays valid until the next call. */
    from(x, z) {
      dist.fill(Infinity);
      const q = [];
      for (const k of cellsNear(x, z)) { dist[k] = 0; q.push(k); }
      let head = 0;
      while (head < q.length) {
        const k = q[head++];
        const i = k % n; const j = (k - i) / n;
        const here = y[k]; const d0 = dist[k];
        for (const [di, dj] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
          const a = i + di; const b = j + dj;
          if (a < 0 || b < 0 || a >= n || b >= n) continue;
          const kk = at(a, b);
          if (!ok[kk]) continue;
          const dh = y[kk] - here;
          if (dh > 0 && dh > MAX_RISE && dh > STEP_UP) continue;
          if (dh < -DROP_MAX) continue;
          const step = Math.hypot(PITCH, dh);
          if (d0 + step < dist[kk] - 1e-6) { dist[kk] = d0 + step; q.push(kk); }
        }
      }
      return this;
    },
    /** Walking metres from the last seed to (x,z), or Infinity. */
    to(x, z) {
      let best = Infinity;
      for (const k of cellsNear(x, z)) if (dist[k] < best) best = dist[k];
      return best;
    },
  };
}

const _walk = new Map();
/**
 * One walk lattice per planet, with the standing-room mask built once.
 *
 * Timed and printed: this is the expensive half of block 5 and the header says
 * what it costs. A nearest-neighbour tour runs one flood PER NODE, so the mask
 * is built once and only the distance field is refilled.
 */
async function walkGraph(planet = PLANETS.cinder) {
  if (_walk.has(planet.id)) return _walk.get(planet.id);
  const t0 = Date.now();
  const { world, physics, COLLISION_LAYER, polyDist } = await world_(planet);
  const tBuild = Date.now() - t0;
  const field = physics.heightfields[0];
  const blocked = boxIndex(physics, COLLISION_LAYER);
  const bodies = world.planet.liquid?.bodies ?? [];
  const lava = (x, z, y) => {
    for (const b of bodies) {
      if (b.shape === 'disc') { if (Math.hypot(x - b.x, z - b.z) <= b.r && y < b.y + 0.6) return true; }
      else if (polyDist(x, z, b.pts) <= b.width * 0.5 && y < Math.max(b.y0, b.y1) + 0.6) return true;
    }
    return false;
  };
  const t1 = Date.now();
  const L = lattice({ ground: (x, z) => field.sampleHeight(x, z), blocked, lava, half: world.planet.half });
  console.log(`   [${planet.id}] world built in ${tBuild} ms, walk lattice in ${Date.now() - t1} ms,`
    + ` ${world.mineralNodes.length} ore nodes, ${world.landingSites.length} pads`);
  const out = { world, blocked, lava, L };
  _walk.set(planet.id, out);
  return out;
}

/**
 * Nearest-pad and from-the-primary-pad walking distances for one planet.
 *
 * `nearest` is the distance to each node from whichever pad is closest to it.
 * `fromPrimary` is the distance from the pad the player ARRIVES at, which is a
 * different question and the one the rarity ladder is actually priced in.
 */
async function distances(planet) {
  const { world, L } = await walkGraph(planet);
  const primary = world.landingSites.find((site) => site.primary);
  const nearest = new Map();
  for (const site of world.landingSites) {
    L.from(site.position.x, site.position.z);
    for (const nd of world.mineralNodes) {
      const d = L.to(nd.position.x, nd.position.z);
      const cur = nearest.get(nd);
      if (!cur || d < cur.d) nearest.set(nd, { d, pad: site.id });
    }
  }
  L.from(primary.position.x, primary.position.z);
  const fromPrimary = new Map();
  for (const nd of world.mineralNodes) fromPrimary.set(nd, L.to(nd.position.x, nd.position.z));
  const rows = [];
  for (const min of world.planet.minerals) {
    const nodes = world.mineralNodes.filter((nd) => nd.type === min.id);
    const ds = nodes.map((nd) => nearest.get(nd).d).sort((a, b) => a - b);
    const pd = nodes.map((nd) => fromPrimary.get(nd)).sort((a, b) => a - b);
    rows.push({
      min,
      nodes,
      ds,
      pd,
      lost: ds.filter((d) => !(d < Infinity)).length,
      pads: new Set(nodes.map((nd) => nearest.get(nd).pad)),
      onPrimary: pd.filter((d) => d < Infinity).length,
      median: ds[Math.floor(ds.length / 2)],
    });
  }
  return { world, L, primary, rows };
}

export {
  PITCH, MAX_SLOPE_TAN, MAX_RISE, STEP_UP, DROP_MAX, HEADROOM, ARRIVE,
  ALL, harness, world_, boxIndex, lattice, walkGraph, distances,
};
