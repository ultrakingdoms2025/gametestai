/**
 * The authored-asset core: manifest -> loader -> the caller's own registry.
 *
 * ## What this is, and what it deliberately is not
 *
 * This is the reusable middle of `maze/MazeAssets.js`, lifted with its
 * behaviour intact so a SECOND world can carry authored PBR without a second
 * copy of the KTX2 path. It is still NOT a general model importer: it loads
 * only what the caller's manifest declares, and each caller's own test holds
 * that manifest to the licence allow-list in `docs/assets/LICENCES.md`.
 *
 * ## Why this one is shared when the geometry loaders deliberately are not
 *
 * `medieval/FrameAssets.js` says in its own header that it is a near-copy of
 * `citadel/CitadelAssets.js`, which was a near-copy of `medieval/BeastAssets.js`
 * - the pipeline decision D4 names as "already proven six times over". That is
 * the right call for those six, and it is worth saying why this is not a
 * seventh: each of them binds authored GEOMETRY to a different world's batch
 * contract (a material slot, a node, a part-name convention, a triangle
 * reservation), so what looks like duplication is six different contracts
 * wearing one shape.
 *
 * The KTX2 TEXTURE half has no such per-world contract. It is: detect GPU
 * support off a live renderer, transcode from a vendored Emscripten module at
 * a /game/-relative URL, honour the colour space the container records, set
 * wrap and anisotropy, and refuse an incomplete map set. There is exactly one
 * correct form of all six of those; they cost a shipped whiteout and a
 * measured ORM histogram to get right (see MAZE_AUTHORED_CALIBRATION in
 * `maze/MazeMaterials.js`), and a second hand-written copy would be a second
 * place for one of them to be subtly wrong. So the texture path is shared and
 * the BINDING - which material slot, which repeat, which calibration - stays
 * local to each world, because that is the part that genuinely differs.
 *
 * ## Every property of the original survives, because they were the point
 *
 *  - manifest-declared only: nothing is fetched that the manifest does not name;
 *  - licence allow-list: enforced per caller by its own test, off the same file;
 *  - per-file graceful degradation: a missing manifest resolves to `{}`, a
 *    missing or unparseable file resolves WITHOUT its entry, and it is the
 *    caller that falls back - so the worst case is the world looking exactly
 *    as it did before, never a throw and never a hole;
 *  - loaded on world BUILD, never on module import: importing this module
 *    costs one frozen array, and both `fetch` and the lazily-`import()`ed
 *    parsers happen inside `load()`, which the world's `build` awaits;
 *  - cached for the SESSION: a re-roll is a rebuild, and re-fetching a static
 *    file per re-roll buys nothing;
 *  - each distinct failure logs ONCE per session: a warning per frame or per
 *    district would turn a missing file into console flooding.
 *
 * Each of those is now per-CALLER rather than per-module, because the state
 * lives in the closure `createAuthoredAssets` returns. Two worlds therefore
 * get two independent caches and two independent warned-sets, which is what
 * "once per session" has to mean once there is more than one world in it.
 *
 * ## Where files live, and why the URL shape is load-bearing
 *
 * Vite serves `public/` verbatim and this project sets `base: '/game/'`. A
 * leading-slash absolute asset path works in dev and 404s in the built game -
 * the worst shape of bug, one that passes every check a developer runs and
 * fails only for the player. `dir` is therefore supplied BY THE CALLER, and
 * every caller builds it from `import.meta.env.BASE_URL`, so the grep that
 * catches the mistake runs over the file that actually made the decision -
 * `scripts/tests/maze-assets.test.mjs` for the maze,
 * `scripts/tests/medieval-surfaces.test.mjs` for the second world, and both
 * of them over this file too. The one URL this module owns is the vendored
 * Basis transcoder, which is global rather than per-world, and it is built
 * from BASE_URL here for exactly the same reason.
 *
 * ## Textures need the renderer, geometry does not
 *
 * KTX2Loader transcodes each file to whatever compressed format the GPU
 * actually supports (BC7/BC1 on desktop, ASTC/ETC2 on mobile), and it
 * discovers that support from a live WebGLRenderer via `detectSupport`.
 * `load(renderer)` therefore takes the renderer; when it is absent (headless
 * callers, `node --test`) texture entries are skipped with one warning while
 * geometry loads exactly as before.
 */

import * as THREE from 'three';
import { getMaxAnisotropy } from '../../gfx/Textures.js';

/**
 * Which manifest `slot` lands in which material slot(s), and how each slot is
 * colour-managed. Albedo is sRGB-encoded in the KTX2 file itself (the
 * container records KHR_DF_TRANSFER_SRGB and KTX2Loader tags the texture);
 * normal and ORM are linear data. The ORM follows the glTF packing -
 * R=AO, G=roughness, B=metalness - the same convention the maze's
 * `bakeSurface` emits and the same one the medieval `_surface` bake's
 * separate AO and roughness canvases stand for, so authored and procedural
 * sets are interchangeable slot-for-slot in both worlds.
 */
export const TEXTURE_SLOTS = Object.freeze(['map', 'normalMap', 'ormMap']);

/**
 * The Vite base, guarded so this module stays importable under plain Node
 * (no `import.meta.env`). Only the vendored transcoder is built from it here;
 * every ASSET url comes from the caller's `dir` - see the header.
 */
function viteBase() {
  return (import.meta.env && import.meta.env.BASE_URL) || '/';
}

/**
 * One world's authored-asset pipeline.
 *
 * @param {object} cfg
 * @param {string} cfg.label prefix on every warning, e.g. 'MazeAssets'
 * @param {string} cfg.dir directory URL the manifest and files sit in, built
 *   BY THE CALLER from `import.meta.env.BASE_URL` - see the header on why
 *   that is not done here
 * @param {string} [cfg.manifest] manifest filename within `dir`
 * @param {string} [cfg.namespace] prefix on every loaded texture's `.name`.
 *   Not cosmetic: the ablation and pixel-attribution harnesses identify a
 *   surface by its texture and material names, and Phase 9 lost four
 *   branches' worth of conclusions to worlds whose materials were anonymous.
 *   Defaults to `label` so a new caller is never anonymous by accident.
 * @param {string} [cfg.fallback] the clause every warning ends with, naming
 *   what the world does instead - a warning that does not say what happened
 *   next reads as an error, and none of these are errors
 * @returns {{load:(renderer?:any)=>Promise<object>,
 *   surfaces:(assets:object)=>object, textureEntries:()=>object[],
 *   reset:()=>void}}
 */
export function createAuthoredAssets({
  label,
  dir,
  manifest: manifestFile = 'manifest.json',
  namespace = label,
  fallback = 'falling back to the procedural surface',
}) {
  /** Session cache: id -> BufferGeometry | Texture. */
  let _assets = null;
  /** Texture manifest entries that were DECLARED, for surfaces(). */
  let _textureEntries = [];
  /** In-flight load, so concurrent builds share one fetch. */
  let _loading = null;
  /** Failure keys already logged - each distinct failure warns once. */
  const _warned = new Set();

  function warnOnce(key, message) {
    if (_warned.has(key)) return;
    _warned.add(key);
    console.warn(`${label}: ${message} - ${fallback}`);
  }

  /**
   * Load every asset the manifest declares. Resolves even when files are
   * absent - the resolved map simply lacks the entry, and the caller falls
   * back. Never rejects.
   *
   * @param {import('three').WebGLRenderer} [renderer] required for KTX2
   *   texture entries (KTX2Loader.detectSupport); without it textures are
   *   skipped with one warning and geometry loads as before. The FIRST call
   *   of a session decides - the session cache means a later renderer cannot
   *   revive skipped textures, which is fine because the real callers all
   *   have the engine's renderer in hand at world build.
   */
  function load(renderer) {
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
   * surface kind, ONLY where the set is complete: a surface missing any of
   * its three maps keeps its procedural bake wholesale, because mixing an
   * authored albedo with a procedural normal map would disagree about where
   * the relief is - worse than either set alone.
   */
  function surfaces(assets) {
    const bySurface = {};
    for (const entry of _textureEntries) {
      const tex = assets?.[entry.id];
      if (!tex) continue;
      (bySurface[entry.surface] ??= {})[entry.slot] = tex;
    }
    const out = {};
    for (const [surface, set] of Object.entries(bySurface)) {
      if (TEXTURE_SLOTS.every((slot) => set[slot])) out[surface] = set;
      else warnOnce(`incomplete:${surface}`, `surface '${surface}' has an incomplete authored set`);
    }
    return out;
  }

  async function loadAll(renderer) {
    let manifest;
    try {
      const res = await fetch(`${dir}${manifestFile}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      manifest = await res.json();
    } catch (e) {
      warnOnce('manifest', `could not load ${dir}${manifestFile} (${e.message})`);
      return {};
    }
    const entries = Array.isArray(manifest?.assets) ? manifest.assets : [];
    if (!entries.length) return {};

    const out = {};
    /* One loader of each kind for the batch, imported lazily so the parsers
     * only ever download on the first build of a session that needs them -
     * and never at all for a player who never enters this world. */
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
             * URL in this pipeline - the /game/ mount makes a leading-slash
             * path the bug the suite greps for, in vendor/ exactly as in the
             * asset dir. */
            ktx2 = new KTX2Loader()
              .setTranscoderPath(`${viteBase()}vendor/basis/`)
              .detectSupport(renderer);
          }
          const tex = await ktx2.loadAsync(dir + entry.file);
          /* World-scale UVs leave 0..1 immediately, so wrap is load-bearing;
           * these KTX2 files are all POT, which WebGL2 compressed textures
           * require for repeat. Colour space is recorded IN the container
           * (albedo sRGB, normal/ORM linear) and KTX2Loader tags the texture
           * from it; per-surface `repeat` is a MATERIAL decision and belongs
           * to the world, which is the only thing that knows what a metre is
           * worth in its own UVs. */
          tex.wrapS = THREE.RepeatWrapping;
          tex.wrapT = THREE.RepeatWrapping;
          tex.anisotropy = getMaxAnisotropy();
          tex.name = `${namespace}.${entry.surface}.${entry.slot}`;
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

  /** The texture entries the last load declared - for the caller's tests. */
  const textureEntries = () => _textureEntries.slice();

  /**
   * Session teardown for tests. The game itself never calls this: assets are
   * kept for the session exactly like the material sets, because a re-roll
   * would otherwise re-fetch and re-parse files that cannot have changed.
   */
  function reset() {
    _assets = null;
    _loading = null;
    _textureEntries = [];
    _warned.clear();
  }

  return { load, surfaces, textureEntries, reset };
}

/**
 * The first mesh's geometry, with its node transform baked in so an export
 * whose shape lives on a transformed node arrives the same as one whose
 * shape lives at the origin.
 *
 * The glTF MATERIAL is deliberately discarded: a loaded material would be its
 * own program family (its own shader compile, its own entry against the
 * world's program budget), so every asset-backed prefab is drawn with a
 * material the world already has. Geometry is what an authored asset
 * contributes; surfaces stay the world's own.
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
