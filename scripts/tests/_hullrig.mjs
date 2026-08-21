import * as THREE from 'three';

/**
 * ONE HULL, BUILT WITH NO WORLD AROUND IT.
 *
 * `dock-hulls.test.mjs` builds the whole of `DockWorld` to get at a ship, which
 * is right for the questions it asks — a hull's boarding route starts on the
 * yard's own apron — and wrong for the two this rig exists for. "Does this
 * thing read as a spacecraft" and "is this doorway a hole" are properties of
 * the hull ALONE, in its own frame, and coupling them to a 3,000-line world
 * builder means every unrelated edit to the yard turns them red.
 *
 * So: stub materials, a bare `Physics`, one `ShipBuild` at the origin with no
 * yaw, and the hull builder called directly. Nothing here imports `DockWorld`.
 */

let _harnessed = false;
export function harness() {
  if (_harnessed) return;
  _harnessed = true;
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
      createLinearGradient: () => gradient,
      createRadialGradient: () => gradient,
      createConicGradient: () => gradient,
      createPattern: () => null,
      measureText: () => ({ width: 8 }),
      getLineDash: () => [],
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
}
harness();

const { Physics } = await import('../../src/physics/Physics.js');
const { GeoBatch } = await import('../../src/worlds/station/StationKit.js');
const { ShipBuild, shipMaterials } = await import('../../src/worlds/dock/ShipKit.js');
const HULLS_SRC = await import('../../src/worlds/dock/Hulls.js');
export const PLAN = await import('../../src/worlds/dock/HullPlan.js');

/**
 * The material table `shipMaterials` expects, as plain standard materials.
 *
 * Every key it reads is present and none of them carries a map, so nothing here
 * touches the texture bakes — this rig measures geometry, and a bake is 300 ms
 * of canvas work per hull that would tell it nothing.
 */
function stubMaterials() {
  const M = {};
  for (const k of ['plate', 'steel', 'glass', 'emCyan', 'steelDark', 'grate',
    'hazard', 'crate', 'tarp', 'emAmber', 'emSodium', 'emRed', 'signs']) {
    M[k] = new THREE.MeshStandardMaterial({ name: k });
  }
  return M;
}

/**
 * Bearing height of each cradle.
 *
 * Read from `YardPlan` where it can be, because a ramp with `from: 'deck'`
 * measures its run from the shed floor and would be the wrong length against a
 * guessed number. Wrapped, because `YardPlan` belongs to the yard and this rig
 * must not go red while somebody is moving a berth: the fallbacks are the
 * values in the plan at the time of writing, and only the Dray's cargo ramp and
 * the Bastion's floor-standing stern read the figure at all.
 */
export const CRADLE_TOP = await (async () => {
  const fallback = { kestrel: 1.2, dray: 1.6, pike: 1.2, bastion: 2.2 };
  try {
    const { BERTHS } = await import('../../src/worlds/dock/YardPlan.js');
    const out = {};
    for (const id of Object.keys(fallback)) {
      out[id] = BERTHS.find((b) => b.id === id)?.cradleTop ?? fallback[id];
    }
    return Object.freeze(out);
  } catch { return Object.freeze(fallback); }
})();

const BUILDER = {
  kestrel: (b, side, keel, mats) => HULLS_SRC.buildKestrel(b, side, keel, mats),
  dray: (b, side, keel, mats) => HULLS_SRC.buildDray(b, side, keel, mats),
  pike: (b, side, keel, mats) => HULLS_SRC.buildPike(b, side, keel, mats),
  bastion: (b, _side, keel, mats) => HULLS_SRC.buildBastion(b, keel, mats),
};

const _cache = new Map();

/**
 * Build one hull at the origin, yaw 0, boarding to starboard.
 *
 * @param {'kestrel'|'dray'|'pike'|'bastion'} id
 * @returns {{ id, build, ext, int, extRoot, intRoot, physics, plan, result, mats }}
 */
export async function hull(id) {
  if (_cache.has(id)) return _cache.get(id);
  const physics = new Physics();
  const M = stubMaterials();
  const tint = { hull: 0x8894a4, trim: 0x59636f, glass: 0x2a3d52, glow: 0x49d8ff, accent: 0x7d6a52 };
  const { mats } = shipMaterials(M, tint);
  const ext = new GeoBatch();
  const int = new GeoBatch();
  const group = new THREE.Group();
  const build = new ShipBuild({
    batch: ext, interior: int, physics, track: (c) => c, group,
    x: 0, y: 0, z: 0, yaw: 0,
  });
  const result = BUILDER[id](build, 1, CRADLE_TOP[id], mats);
  const extRoot = new THREE.Group();
  const intRoot = new THREE.Group();
  ext.flush(extRoot, mats, 'rig-' + id, {});
  int.flush(intRoot, mats, 'rig-' + id + '-in', {});
  extRoot.updateMatrixWorld(true);
  intRoot.updateMatrixWorld(true);
  group.updateMatrixWorld(true);
  const rec = { id, build, ext, int, extRoot, intRoot, physics, plan: PLAN.HULLS[id], result, mats, group };
  _cache.set(id, rec);
  return rec;
}

/* ------------------------------------------------------------------ */
/* Triangle soup, for the ray probes and the rasteriser                */
/* ------------------------------------------------------------------ */

/**
 * Every drawn triangle under `root`, in world space, tagged with the mesh it
 * came from.
 *
 * Flat arrays rather than `THREE.Triangle`s: the silhouette rasteriser walks
 * this list once per pixel row and a per-triangle object allocation is the one
 * thing this repo's house rules forbid outright.
 */
export function triangles(roots) {
  const out = { a: [], names: [] };
  const v = new THREE.Vector3();
  for (const root of [].concat(roots)) {
    root.traverse((o) => {
      if (!o.isMesh || !o.geometry) return;
      const pos = o.geometry.attributes.position;
      if (!pos) return;
      const idx = o.geometry.getIndex();
      const n = idx ? idx.count : pos.count;
      const name = o.name || o.material?.name || 'unnamed';
      for (let i = 0; i + 2 < n; i += 3) {
        for (let k = 0; k < 3; k++) {
          v.fromBufferAttribute(pos, idx ? idx.getX(i + k) : i + k).applyMatrix4(o.matrixWorld);
          out.a.push(v.x, v.y, v.z);
        }
        out.names.push(name);
      }
    });
  }
  return out;
}

/**
 * Nearest triangle hit along a segment, or null. Moller-Trumbore, no allocation.
 *
 * @returns {{t:number, name:string}|null}
 */
export function raycast(soup, ox, oy, oz, dx, dy, dz, maxT) {
  const a = soup.a;
  let bestT = maxT, bestI = -1;
  for (let i = 0, tri = 0; i < a.length; i += 9, tri++) {
    const ax = a[i], ay = a[i + 1], az = a[i + 2];
    const e1x = a[i + 3] - ax, e1y = a[i + 4] - ay, e1z = a[i + 5] - az;
    const e2x = a[i + 6] - ax, e2y = a[i + 7] - ay, e2z = a[i + 8] - az;
    const px = dy * e2z - dz * e2y;
    const py = dz * e2x - dx * e2z;
    const pz = dx * e2y - dy * e2x;
    const det = e1x * px + e1y * py + e1z * pz;
    if (det > -1e-9 && det < 1e-9) continue;
    const inv = 1 / det;
    const tx = ox - ax, ty = oy - ay, tz = oz - az;
    const u = (tx * px + ty * py + tz * pz) * inv;
    if (u < -1e-6 || u > 1 + 1e-6) continue;
    const qx = ty * e1z - tz * e1y;
    const qy = tz * e1x - tx * e1z;
    const qz = tx * e1y - ty * e1x;
    const vv = (dx * qx + dy * qy + dz * qz) * inv;
    if (vv < -1e-6 || u + vv > 1 + 1e-6) continue;
    const t = (e2x * qx + e2y * qy + e2z * qz) * inv;
    if (t > 1e-4 && t < bestT) { bestT = t; bestI = tri; }
  }
  return bestI < 0 ? null : { t: bestT, name: soup.names[bestI] };
}

/** Total triangle count under a root. */
export function triCount(root) {
  let n = 0;
  root.traverse((o) => {
    if (!o.isMesh || !o.geometry) return;
    const idx = o.geometry.getIndex();
    n += (idx ? idx.count : o.geometry.attributes.position.count) / 3;
  });
  return n;
}
