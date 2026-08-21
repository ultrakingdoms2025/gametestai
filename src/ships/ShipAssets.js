/**
 * The hulls' authored-asset pipeline: manifest -> loader -> hull builder.
 *
 * ## What this is, and why it exists at all
 *
 * The player has said three times, in their own words, that "spaceships do not
 * look like spaceships, they look like they are made of square blocks". Three
 * art passes answered it inside `Hulls.js` and produced three box stacks,
 * because `ShipKit` is a box kit: `box`, `cbox`, `rbox`, `wallX`, `wallZ`. That
 * is exactly right for the Citadel, where a building IS a box, and it cannot be
 * argued into being right for a spacecraft.
 *
 * So the Kestrel's SKIN moves off the runtime primitive: `scripts/
 * make-ship-glb.mjs` evaluates a parametric hull under plain Node and bakes it
 * to `public/assets/ship/kestrel-hull.glb`, and this module loads it. The
 * generator is free to lathe, loft, blend and smooth-shade because its output
 * is a baked mesh rather than a sequence of runtime box calls.
 *
 * This is deliberately the SAME pipeline `src/worlds/maze/MazeAssets.js`
 * proved with one hero prop (the stair newel) before the maze shipped bulk
 * assets, down to the manifest fields, the licence allow-list, the BASE_URL
 * rule and the silent degradation. One hull is in it. The other three follow
 * only once this one is proven end to end, which is that file's own strategy
 * and the reason it worked.
 *
 * ## The material is discarded, and that is the whole performance contract
 *
 * `MazeAssets.firstGeometry` records the trap: a loaded glTF material is its
 * own program family - its own shader compile, its own entry against the
 * program budget - so an authored asset must contribute GEOMETRY and nothing
 * else. The .glb's meshes are therefore NAMED FOR THE MATERIAL KEY they are to
 * be drawn with (`hull`, `accent`, `dark`, `glass`, `trim`, `glow`), this
 * loader reads that name, and `ShipBuild.put` draws the geometry with the
 * yard's own cached material of that key - the same clone every box on the
 * hull already rides. The glTF materials are never touched. A ship that added
 * six programs to the yard would be a worse outcome than a boxy ship.
 *
 * ## Synchronous at build time, asynchronous before it
 *
 * `DockWorld._buildShips` and `ShipModel.buildShipModel` both call the hull
 * builders SYNCHRONOUSLY - the yard bakes its transform into every vertex and
 * a flown hull is built from the same call - so the asset has to be in hand
 * before the builder runs, not awaited inside it. Hence two entry points:
 * `loadShipAssets()`, awaited once by `DockWorld.build`, and `shipParts(id)`,
 * a synchronous read of the session cache that returns null until then.
 *
 * A flown hull needs no second await for a reason `Piloting._yardMaterials`
 * already relies on: the flown model is cloned from the yard's live material
 * set, so the yard has necessarily been built before any ship is flown. The
 * cache the yard warmed is the cache the flight path reads.
 *
 * ## Every failure path resolves, and logs once
 *
 * A missing manifest, a 404, a corrupt file, a mesh named something no
 * material answers to: each resolves without its entry, warns once per
 * session, and leaves `shipParts` returning null - which puts `buildKestrel`
 * back on the procedural hull it has always had. `scripts/tests/
 * ship-assets.test.mjs` pins BOTH arms, because a fallback nobody exercises is
 * a fallback that has already rotted.
 *
 * ## Where the file lives, and why the URL shape is load-bearing
 *
 * Vite serves `public/` verbatim and this project sets `base: '/game/'`, so
 * every URL here is built from `import.meta.env.BASE_URL`. A leading-slash
 * absolute asset path works in dev and 404s in the built game - the worst
 * shape of bug, one that passes every check a developer runs and fails only
 * for the player - so the suite greps this file for exactly that mistake, as
 * it does `MazeAssets.js`.
 */

import * as THREE from 'three';

/**
 * Which asset id backs which hull. An id present here and absent from the
 * manifest (or vice versa) fails the suite, so the two cannot drift.
 */
export const SHIP_ASSET_HULLS = Object.freeze({
  kestrel: 'kestrel-hull',
  dray: 'dray-hull',
  bastion: 'bastion-hull',
  pike: 'pike-hull',
});

/**
 * Material keys an authored mesh may be named for.
 *
 * The allow-list is the point: `ShipBuild.put` takes the key straight to
 * `GeoBatch`, and a key no material answers to is a bucket that flushes with
 * `undefined` for its material - a mesh drawn in three.js's default white,
 * with its own program, which is the exact cost this pipeline exists to avoid.
 */
export const SHIP_PART_KEYS = Object.freeze(['hull', 'trim', 'accent', 'dark', 'glass', 'glow', 'hazard']);

/** Session cache: asset id -> [{ key, geometry }]. */
let _assets = null;
/** In-flight load, so concurrent builds share one fetch. */
let _loading = null;
/** Failure keys already logged - each distinct failure warns once per session. */
const _warned = new Set();

function warnOnce(key, message) {
  if (_warned.has(key)) return;
  _warned.add(key);
  console.warn(`ShipAssets: ${message} - falling back to the procedural hull`);
}

/**
 * Load every asset the manifest declares. Resolves even when files are absent -
 * the resolved map simply lacks the entry, and the hull builder falls back.
 * Never rejects.
 *
 * @returns {Promise<{[id:string]: {key:string, geometry:THREE.BufferGeometry}[]}>}
 */
export function loadShipAssets() {
  if (_assets) return Promise.resolve(_assets);
  if (_loading) return _loading;
  _loading = loadAll().then((map) => {
    _assets = map;
    _loading = null;
    return map;
  });
  return _loading;
}

/**
 * The authored parts for one hull, or null - a SYNCHRONOUS read of whatever
 * `loadShipAssets` has already resolved. Null is not an error: it is the
 * procedural hull, which is what every headless test measures.
 *
 * The geometries are CLONED on the way out. `GeoBatch.add` applies the placing
 * matrix to the geometry it is handed and then owns it, so handing out the
 * cached copy would bake the yard's berth transform into the cache and the
 * flown hull - built at the origin from the same cache - would arrive already
 * standing at berth B1.
 *
 * @param {string} id hull id, e.g. 'kestrel'
 * @param {{mirrorX?: boolean}} [o] mirror the parts across the centreline,
 *   for a hull whose boarding hatch is cut in the other flank. The .glb is
 *   authored with the aperture to starboard; everything else on this hull is
 *   symmetric, so a mirror is exact rather than an approximation.
 * @returns {{key:string, geometry:THREE.BufferGeometry}[]|null}
 */
export function shipParts(id, o = {}) {
  const assetId = SHIP_ASSET_HULLS[id];
  const parts = assetId ? _assets?.[assetId] : null;
  if (!parts || !parts.length) return null;
  return parts.map((p) => ({
    key: p.key,
    geometry: o.mirrorX ? mirrorX(p.geometry.clone()) : p.geometry.clone(),
  }));
}

/**
 * Mirror a geometry across the hull's centreline, winding and all.
 *
 * `scale(-1, 1, 1)` has a negative determinant: three.js transforms the normals
 * correctly through the normal matrix, but every triangle comes out wound the
 * other way and is then culled as a back face - a hull that renders as a hole.
 * Reversing the index restores it.
 */
function mirrorX(geo) {
  geo.scale(-1, 1, 1);
  const idx = geo.getIndex();
  if (idx) {
    const a = idx.array;
    for (let i = 0; i < a.length; i += 3) { const t = a[i]; a[i] = a[i + 2]; a[i + 2] = t; }
    idx.needsUpdate = true;
  }
  return geo;
}

async function loadAll() {
  /* BASE_URL, not '/': the built game mounts under /game/ and a hard-coded
   * absolute path is the bug the whole URL shape exists to prevent. Guarded so
   * the module stays importable under plain Node (no import.meta.env). */
  const base = (import.meta.env && import.meta.env.BASE_URL) || '/';
  const dir = `${base}assets/ship/`;

  let manifest;
  try {
    const res = await fetch(`${dir}manifest.json`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    manifest = await res.json();
  } catch (e) {
    warnOnce('manifest', `could not load ${dir}manifest.json (${e.message})`);
    return {};
  }
  const entries = Array.isArray(manifest?.assets) ? manifest.assets : [];
  if (!entries.length) return {};

  const out = {};
  /* One loader for the batch, imported lazily so the glTF parser only ever
   * downloads on the first yard build of a session - and never at all for a
   * player who never docks. Vite splits it into its own chunk. */
  let loader = null;
  for (const entry of entries) {
    if (entry.kind !== 'geometry') {
      warnOnce(`kind:${entry.id}`, `asset '${entry.id}' has unhandled kind '${entry.kind}'`);
      continue;
    }
    try {
      const res = await fetch(dir + entry.file);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const buf = await res.arrayBuffer();
      if (!loader) {
        const { GLTFLoader } = await import('three/examples/jsm/loaders/GLTFLoader.js');
        loader = new GLTFLoader();
      }
      const gltf = await loader.parseAsync(buf, dir);
      const parts = namedParts(gltf, entry.id);
      if (!parts.length) throw new Error('no usable mesh in scene');
      out[entry.id] = parts;
    } catch (e) {
      warnOnce(`asset:${entry.id}`, `could not load asset '${entry.id}' (${entry.file}: ${e.message})`);
    }
  }
  return out;
}

/**
 * Every mesh in the file whose name is a material key, with its node transform
 * baked in so an export whose part lives on a transformed node arrives the same
 * as one whose part lives at the origin.
 *
 * The glTF MATERIAL is deliberately never read - see the header. A mesh named
 * something outside {@link SHIP_PART_KEYS} is dropped with one warning rather
 * than guessed at, because guessing means drawing a hull with the wrong
 * material and looking like a bug in the livery system.
 */
function namedParts(gltf, id) {
  const out = [];
  gltf.scene.updateMatrixWorld(true);
  gltf.scene.traverse((o) => {
    if (!o.isMesh || !o.geometry) return;
    const key = o.name;
    if (!SHIP_PART_KEYS.includes(key)) {
      warnOnce(`part:${id}:${key}`, `asset '${id}' has a mesh named '${key}', which is not a material key`);
      return;
    }
    const geo = o.geometry;
    geo.applyMatrix4(o.matrixWorld);
    geo.name = `ship.authored.${id}.${key}`;
    out.push({ key, geometry: geo });
  });
  return out;
}

/**
 * Session teardown for tests. The game itself never calls this: assets are kept
 * for the session exactly like the material set, because a re-entry to the yard
 * would otherwise re-fetch and re-parse a file that cannot have changed.
 */
export function resetShipAssets() {
  _assets = null;
  _loading = null;
  _warned.clear();
}

/**
 * Install a resolved asset map directly, for tests and for the headless rigs.
 *
 * There is no fetch in `node --test` and no DOM to hang one on, and the arm of
 * `buildKestrel` that draws the authored skin is the arm the player sees - so
 * it has to be testable without a browser. `scripts/tests/ship-assets.test.mjs`
 * parses the real committed .glb off disk and hands it in here, which is as
 * close to the shipped path as a test can stand.
 */
export function installShipAssets(map) {
  _assets = map;
  _loading = null;
}
