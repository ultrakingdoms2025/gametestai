/**
 * The maze's authored-asset pipeline: manifest -> loader -> prefab registry.
 *
 * ## What this is, and what it deliberately is not
 *
 * Phase 6 Task 8 landed the pipeline with exactly ONE asset in it - the shaft
 * newel (`newel-finial.glb`) - so that every question that only shows up in
 * practice was answered once, cheaply: the `/game/` base path, the fallback
 * when a fetch 404s, the licence line, and whether a loaded mesh actually
 * instances through the same registry-and-batch machinery the procedural
 * prefabs ride. Task 9 added the five bulk CC0 texture sets. It is NOT a
 * general model importer: it loads only what `public/assets/maze/manifest.json`
 * declares, and the manifest is held to a licence allow-list by
 * `scripts/tests/maze-assets.test.mjs`.
 *
 * ## Why this file is now thirty lines and a table
 *
 * Everything below the manifest - fetch, KTX2 transcode, glTF parse, graceful
 * degradation, session cache, once-per-session logging - moved to
 * `../assets/AuthoredAssets.js` when Aldermoor Vale became the second world to
 * carry authored PBR. Nothing about the behaviour changed; `createAuthoredAssets`
 * hands back the same four operations this module used to define inline, with
 * the session cache and the warned-set living in ITS closure instead of at
 * this module's scope - which is what "once per session" has to mean once
 * there is more than one world holding one. That header carries the reasoning
 * for the split, including why the six authored-GEOMETRY loaders in this repo
 * stay near-copies of one another and only the texture path was shared.
 *
 * What stays here is the part that is genuinely the maze's: which asset id
 * backs which prefab kind, and where the maze's files live.
 *
 * ## Loaded on world BUILD, never on module import
 *
 * A world that is never entered must cost nothing. Importing this module
 * costs two frozen constants and the loader's closure; the fetches - and
 * GLTFLoader and KTX2Loader themselves, via dynamic `import()`s that Vite
 * splits into their own chunks - happen inside `loadMazeAssets()`, which
 * `MazeWorld.build` awaits. The results are cached for the SESSION, like the
 * material set and for the same reason: a re-roll is a rebuild, and
 * re-fetching a static file per re-roll buys nothing.
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
 * that mistake (so this comment cannot even spell the wrong form out). The
 * directory is built HERE rather than in the shared core precisely so that
 * grep keeps landing on the file that made the decision; the core's header
 * says the same thing from the other side.
 *
 * ## Textures need the renderer, geometry does not
 *
 * KTX2Loader discovers which compressed format the GPU supports from a live
 * WebGLRenderer via `detectSupport`, so `loadMazeAssets(renderer)` takes it -
 * `MazeWorld.build` passes `this.engine.renderer`, the one renderer the
 * engine owns - and when it is absent (headless callers, older call sites)
 * texture entries are skipped with one warning while geometry loads exactly
 * as before. Skipped or failed textures are simply missing from the resolved
 * map, and `MazeMaterials.applyAuthoredSurfaces` keeps the procedural bake
 * for any surface whose authored set is incomplete - the same never-a-hole
 * rule the geometry pipeline has carried since Task 8.
 */

import { createAuthoredAssets, TEXTURE_SLOTS } from '../assets/AuthoredAssets.js';

/**
 * Which asset id backs which prefab kind - the registry's side of the
 * contract with the manifest, and the single source `MazeMeshes.prefabFor`
 * consults. An id present here and absent from the manifest (or vice versa)
 * fails the suite, so the two cannot drift.
 */
export const MAZE_ASSET_PREFABS = Object.freeze({
  newel: 'newel-finial',
  /* Phase 9. `sprig` is the dressing kind whose geometry BOTH the hedge-top
   * growth and the shaft ivy instance - one authored tuft, scaled upright for
   * a shoot and squashed flat on a wall's normal for a leaf. It is the single
   * most-drawn geometry in this world by a wide margin (measured: 3,600
   * instances per district, 21 districts resident at the entrance, and the
   * fourteen largest objects in every framing were fourteen of its meshes),
   * which is why the authored file is TEN triangles - two fewer than the box
   * it replaces. See scripts/make-maze-glb.mjs. */
  sprig: 'leaf-tuft',
  candle: 'hedge-candle',
});

/**
 * Which manifest `slot` lands in which material slot(s). Re-exported from the
 * shared core rather than redeclared: the maze's tests and the medieval
 * world's read the same three names, and two spellings of one list is how
 * they would eventually disagree.
 */
export const MAZE_TEXTURE_SLOTS = TEXTURE_SLOTS;

/* BASE_URL, not '/': the built game mounts under /game/ and a hard-coded
 * absolute path is the bug the whole URL shape exists to prevent. Guarded
 * so the module stays importable under plain Node (no import.meta.env). */
const MAZE_ASSET_DIR = `${(import.meta.env && import.meta.env.BASE_URL) || '/'}assets/maze/`;

const _pipeline = createAuthoredAssets({
  label: 'MazeAssets',
  dir: MAZE_ASSET_DIR,
  /* The texture NAME prefix is unchanged from before the split: the ablation
   * and pixel-attribution harnesses identify a surface by it, and renaming
   * one silently is how a harness starts reporting hits on nothing. */
  namespace: 'maze.authored',
  fallback: 'falling back to the procedural prefab',
});

/**
 * Load every asset the manifest declares. Resolves even when files are
 * absent - the resolved map simply lacks the entry, and the prefab registry
 * falls back. Never rejects.
 *
 * @param {import('three').WebGLRenderer} [renderer] required for KTX2
 *   texture entries; without it textures are skipped with one warning.
 * @returns {Promise<{[id:string]: import('three').BufferGeometry|import('three').Texture}>}
 */
export function loadMazeAssets(renderer) {
  return _pipeline.load(renderer);
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
  return _pipeline.surfaces(assets);
}

/**
 * Session teardown for tests. The game itself never calls this: assets are
 * kept for the session exactly like the material set, because a re-roll
 * would otherwise re-fetch and re-parse files that cannot have changed.
 */
export function resetMazeAssets() {
  _pipeline.reset();
}
