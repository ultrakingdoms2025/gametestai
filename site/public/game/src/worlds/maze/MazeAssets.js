/**
 * The maze's authored-asset pipeline: manifest -> loader -> prefab registry.
 *
 * ## What this is, and what it deliberately is not
 *
 * Phase 6 Task 8 lands the pipeline with exactly ONE asset in it - the shaft
 * newel (`newel-finial.glb`) - so that every question that only shows up in
 * practice is answered once, cheaply: the `/game/` base path, the fallback
 * when a fetch 404s, the licence line, and whether a loaded mesh actually
 * instances through the same registry-and-batch machinery the procedural
 * prefabs ride. It is NOT a general model importer: it loads only what
 * `public/assets/maze/manifest.json` declares, and the manifest is held to a
 * licence allow-list by `scripts/tests/maze-assets.test.mjs`.
 *
 * ## Loaded on world BUILD, never on module import
 *
 * A world that is never entered must cost nothing. Importing this module
 * costs two frozen constants; the fetches - and GLTFLoader itself, via a
 * dynamic `import()` that Vite splits into its own chunk - happen inside
 * `loadMazeAssets()`, which `MazeWorld.build` awaits. The results are cached
 * for the SESSION, like the material set and for the same reason: a re-roll
 * is a rebuild, and re-fetching a static file per re-roll buys nothing.
 *
 * ## Every failure path resolves, and logs once
 *
 * The user may never supply a model, a CDN may be down, a file may be
 * renamed. None of that is allowed to matter: a missing manifest resolves to
 * an empty asset map, a missing or unparseable file resolves without its
 * entry, and `MazeMeshes.prefabFor` falls back to the procedural prefab for
 * any kind whose asset is absent - so the worst case is the world looking
 * exactly as it did before this task, never a throw and never a hole. Each
 * distinct failure logs once per session; a warning per frame or per district
 * would turn a missing prop into console flooding.
 *
 * ## Where files live, and why the URL shape is load-bearing
 *
 * Vite serves `public/` verbatim and this project sets `base: '/game/'`, so
 * every URL here is built from `import.meta.env.BASE_URL`. A leading-slash
 * absolute asset path works in dev and 404s in the built game - the worst
 * shape of bug, one that passes every check a developer runs and fails only
 * for the player - which is why the test suite greps this file for exactly
 * that mistake (so this comment cannot even spell the wrong form out).
 *
 * ## Loader inventory (Task 8 Step 1, recorded from the installed package)
 *
 * `node_modules/three/examples/jsm/loaders/` ships GLTFLoader.js,
 * KTX2Loader.js and DRACOLoader.js; `examples/jsm/libs/` ships the Basis
 * transcoder (`basis/basis_transcoder.{js,wasm}`), the Draco decoders
 * (`draco/`) and `meshopt_decoder.module.js`. Task 8 wired GLTFLoader;
 * Task 9 wires KTX2Loader for the bulk-surfacing texture sets, with the
 * Basis transcoder vendored to `public/vendor/basis/` (its own commit)
 * because the Emscripten module must be fetchable at runtime - it cannot
 * ride the Vite bundle - and its URL is built from BASE_URL like every
 * other asset path here, for the same /game/ reason.
 *
 * ## Textures need the renderer, geometry does not
 *
 * KTX2Loader transcodes each file to whatever compressed format the GPU
 * actually supports (BC7/BC1 on desktop, ASTC/ETC2 on mobile), and it
 * discovers that support from a live WebGLRenderer via `detectSupport`.
 * `loadMazeAssets(renderer)` therefore takes the renderer as an argument -
 * `MazeWorld.build` passes `this.engine.renderer`, the one renderer the
 * engine owns - and when it is absent (headless callers, older call sites)
 * texture entries are skipped with one warning while geometry loads exactly
 * as before. Skipped or failed textures are simply missing from the
 * resolved map, and `MazeMaterials.applyAuthoredSurfaces` keeps the
 * procedural bake for any surface whose authored set is incomplete - the
 * same never-a-hole rule the geometry pipeline has carried since Task 8.
 */

import * as THREE from 'three';
import { getMaxAnisotropy } from '../../gfx/Textures.js';

/**
 * Which asset id backs which prefab kind - the registry's side of the
 * contract with the manifest, and the single source `MazeMeshes.prefabFor`
 * consults. An id present here and absent from the manifest (or vice versa)
 * fails the suite, so the two cannot drift.
 */
export const MAZE_ASSET_PREFABS = Object.freeze({
  newel: 'newel-finial',
});

/**
 * Which manifest `slot` lands in which material slot(s), and how each slot is
 * colour-managed. Albedo is sRGB-encoded in the KTX2 file itself (the
 * container records KHR_DF_TRANSFER_SRGB and KTX2Loader tags the texture);
 * normal and ORM are linear data. The ORM follows the glTF packing -
 * R=AO, G=roughness, B=metalness - the same convention `bakeSurface` emits,
 * so authored and procedural sets are interchangeable slot-for-slot.
 */
export const MAZE_TEXTURE_SLOTS = Object.freeze(['map', 'normalMap', 'ormMap']);

/** Session cache: id -> BufferGeometry (or Texture, when one ever lands). */
let _assets = null;
/** Texture manifest entries that resolved, for authoredSurfaces(). */
let _textureEntries = [];
/** In-flight load, so concurrent builds share one fetch. */
let _loading = null;
/** Failure keys already logged - each distinct failure warns once per session. */
const _warned = new Set();

function warnOnce(key, message) {
  if (_warned.has(key)) return;
  _warned.add(key);
  console.warn(`MazeAssets: ${message} - falling back to the procedural prefab`);
}

/**
 * Load every asset the manifest declares. Resolves even when files are
 * absent - the resolved map simply lacks the entry, and the prefab registry
 * falls back. Never rejects.
 *
 * @param {import('three').WebGLRenderer} [renderer] required for KTX2
 *   texture entries (KTX2Loader.detectSupport); without it textures are
 *   skipped with one warning and geometry loads as before. The FIRST call
 *   of a session decides - the session cache means a later renderer cannot
 *   revive skipped textures, which is fine because the one real caller
 *   (MazeWorld.build) always has the engine's renderer in hand.
 * @returns {Promise<{[id:string]: import('three').BufferGeometry|import('three').Texture}>}
 */
export function loadMazeAssets(renderer) {
  if (_assets) return Promise.resolve(_assets);
  if (_loading) return _loading;
  _loading = loadAll(renderer).then((map) => {
    _assets = map;
    _loading = null;
    return map;
  });
  return _loading;
}

/**
 * The authored surface sets among the loaded assets, keyed by principal
 * surface kind, ONLY where the set is complete: a surface missing any of its
 * three maps keeps its procedural bake wholesale, because mixing an authored
 * albedo with a procedural normal map would disagree about where the relief
 * is - worse than either set alone.
 *
 * @param {{[id:string]: any}} assets the map `loadMazeAssets` resolved
 * @returns {{[surface:string]: {map: import('three').Texture,
 *   normalMap: import('three').Texture, ormMap: import('three').Texture}}}
 */
export function authoredSurfaces(assets) {
  const bySurface = {};
  for (const entry of _textureEntries) {
    const tex = assets?.[entry.id];
    if (!tex) continue;
    (bySurface[entry.surface] ??= {})[entry.slot] = tex;
  }
  const out = {};
  for (const [surface, set] of Object.entries(bySurface)) {
    if (MAZE_TEXTURE_SLOTS.every((slot) => set[slot])) out[surface] = set;
    else warnOnce(`incomplete:${surface}`, `surface '${surface}' has an incomplete authored set`);
  }
  return out;
}

async function loadAll(renderer) {
  /* BASE_URL, not '/': the built game mounts under /game/ and a hard-coded
   * absolute path is the bug the whole URL shape exists to prevent. Guarded
   * so the module stays importable under plain Node (no import.meta.env). */
  const base = (import.meta.env && import.meta.env.BASE_URL) || '/';
  const dir = `${base}assets/maze/`;

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
  /* One loader of each kind for the batch, imported lazily so the parsers
   * only ever download on the first maze build of a session - and never at
   * all for a player who never enters the maze. */
  let loader = null;
  let ktx2 = null;
  _textureEntries = entries.filter((e) => e.kind === 'texture');
  for (const entry of entries) {
    if (entry.kind === 'texture') {
      if (!renderer) {
        warnOnce('ktx2:no-renderer',
          'texture entries need a renderer for KTX2 transcoding and none was passed');
        continue;
      }
      try {
        if (ktx2 === null) {
          const { KTX2Loader } = await import('three/examples/jsm/loaders/KTX2Loader.js');
          /* The transcoder is VENDORED (public/vendor/basis/, its own
           * commit) and its path built from the Vite base like every asset
           * URL in this file - the /game/ mount makes a leading-slash path
           * the bug the suite greps for, in /vendor/ exactly as in the
           * asset dir. */
          ktx2 = new KTX2Loader()
            .setTranscoderPath(`${base}vendor/basis/`)
            .detectSupport(renderer);
        }
        const tex = await ktx2.loadAsync(dir + entry.file);
        /* World-scale UVs leave 0..1 immediately, so wrap is load-bearing;
         * the maze's KTX2 files are all POT, which WebGL2 compressed
         * textures require for repeat. Colour space is recorded IN the
         * container (albedo sRGB, normal/ORM linear) and KTX2Loader tags
         * the texture from it; per-surface `repeat` is a material decision
         * and is applied in MazeMaterials.applyAuthoredSurfaces. */
        tex.wrapS = THREE.RepeatWrapping;
        tex.wrapT = THREE.RepeatWrapping;
        tex.anisotropy = getMaxAnisotropy();
        tex.name = `maze.authored.${entry.surface}.${entry.slot}`;
        tex.needsUpdate = true;
        out[entry.id] = tex;
      } catch (e) {
        warnOnce(`asset:${entry.id}`, `could not load asset '${entry.id}' (${entry.file}: ${e.message})`);
      }
      continue;
    }
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
      const geo = firstGeometry(gltf);
      if (!geo) throw new Error('no mesh in scene');
      out[entry.id] = geo;
    } catch (e) {
      warnOnce(`asset:${entry.id}`, `could not load asset '${entry.id}' (${entry.file}: ${e.message})`);
    }
  }
  /* The KTX2 worker pool exists to parallelise transcodes WITHIN a load
   * burst; keeping it warm for a session that will never load another
   * texture is paying worker memory for nothing. The transcoded textures
   * outlive the loader. */
  ktx2?.dispose();
  return out;
}

/**
 * The first mesh's geometry, with its node transform baked in so an export
 * whose shape lives on a transformed node arrives the same as one whose
 * shape lives at the origin.
 *
 * The glTF MATERIAL is deliberately discarded here: a loaded material would
 * be its own program family (its own shader compile, its own entry against
 * MAZE_PROGRAM_BUDGET), so every asset-backed prefab is drawn with the
 * cached maze material of the batch family it joins - the newel rides the
 * stone family's `stair` material, aliased in MazeMaterials.js. Geometry is
 * what an authored asset contributes; surfaces stay the maze's own.
 */
function firstGeometry(gltf) {
  let mesh = null;
  gltf.scene.updateMatrixWorld(true);
  gltf.scene.traverse((o) => {
    if (o.isMesh && !mesh) mesh = o;
  });
  if (!mesh) return null;
  const geo = mesh.geometry;
  geo.applyMatrix4(mesh.matrixWorld);
  return geo;
}

/**
 * Session teardown for tests. The game itself never calls this: assets are
 * kept for the session exactly like the material set, because a re-roll
 * would otherwise re-fetch and re-parse files that cannot have changed.
 */
export function resetMazeAssets() {
  _assets = null;
  _loading = null;
  _textureEntries = [];
  _warned.clear();
}
