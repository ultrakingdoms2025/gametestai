/**
 * Lazy loader for Aldermoor Vale's authored beast features.
 *
 * The vale's wolves and bears get authored geometry for the handful of
 * features that separate an animal from the lofted tube `BeastBody` builds:
 * a raised dorsal crest, a lateral ruff across the shoulder, a supraorbital
 * shelf, and a dark nose pad. Everything else about them stays procedural. See
 * `scripts/make-beast-glb.mjs` for what is authored and, more usefully, for
 * what deliberately is not.
 *
 * This file is a near-copy of `src/npc/HeroAssets.js` by intent rather than by
 * accident: that is the pipeline decision D4 names as already proven, and a
 * fourth variant of it invented from scratch would be a fourth set of failure
 * modes to discover. Manifest, lazy `GLTFLoader`, parallel fetches with an
 * abort signal, per-asset `try`/`catch`, one warning per distinct failure, and
 * a synchronous cache read that returns null rather than throwing.
 *
 * ── THE MATERIAL RULE, WHICH IS THE WHOLE POINT ───────────────────────────
 *
 * The glTF material is never read. Every part is MERGED into the geometry
 * `BeastBody` already builds for one (node, slot) pair, and which pair is a
 * manifest field.
 *
 * That is not tidiness. Three keys its shader-program cache on the material
 * configuration, this project boots by warming the cartesian product of those
 * programs, and Phase 9 is named in the roadmap as the phase most likely to
 * regress production frame time. A beast that brought its own PBR material
 * would be a new program family on every medieval load. Reusing the four
 * surfaces the animal already clones costs exactly zero.
 *
 * ── AND WHY THE PARTS ARE MERGED RATHER THAN PARENTED ─────────────────────
 *
 * The obvious implementation is to add each part to its node as its own
 * `THREE.Mesh`. That was rejected on arithmetic: a beast is already 22 meshes,
 * `MedievalResidency` streams up to EIGHT bodies at once, and four parented
 * parts each would be another 32 draw calls against a medieval framing that
 * measured 818-1549. Merged into the existing geometry, the cost is triangles
 * and nothing else - no draw call, no material, no program, no scene node.
 *
 * ── ONE CONSEQUENCE WORTH STATING OUT LOUD ────────────────────────────────
 *
 * Because the parts are merged rather than parented, the geometries handed
 * back here are consumed by `BeastBody`'s own `merge()`, which calls
 * `toNonIndexed()` on an indexed input and disposes only that copy. So the
 * cached geometry survives every animal built from it and is never cloned -
 * which is the whole reason a wolf pack of five costs one copy of this file
 * rather than five. `namedParts` refuses a non-indexed mesh for exactly that
 * reason: it would be disposed by the first animal and the second would build
 * from freed buffers.
 *
 * ── WHY THIS LIVES UNDER `worlds/medieval/` AND NOT UNDER `npc/` ──────────
 *
 * `HeroAssets.js` sits in `src/npc/` next to its consumer, and the symmetry
 * argument for putting this there too is a good one. It is not taken, for two
 * reasons worth writing down rather than leaving as a smell:
 *
 *  1. These are Aldermoor Vale's art. Phase 3 gives that world settlement and
 *     wildlife and it is the only world with beasts; the manifest declares two
 *     species and both are its. `MedievalWorld.build` is what starts the load,
 *     so the world owns the asset and the loader sits with the world.
 *  2. `BeastBody` is shared - the citadel's camel is built by it - so the
 *     import does cross from `npc/` into one world's directory. What it pulls
 *     in is this file and nothing else: there is no static import here beyond
 *     the lazily-`import()`ed glTF parser, so it drags no world code into the
 *     bundle and a camel simply gets `null` back.
 *
 * If a second world ever authors beast features, this moves to `src/npc/` and
 * the assets to `public/assets/beast/`, and that is the moment to do it -
 * not before, on a guess about a world that may never exist.
 */

/**
 * Part keys the loader will accept.
 *
 * The allow-list is the point, exactly as it is for ship and hero parts: a
 * part whose key nothing recognises would be merged into a mesh chosen by
 * accident, which renders as a wolf wearing its nose on its back. A name
 * outside this list is dropped with one warning instead of guessed at.
 *
 * Kept in step with `scripts/make-beast-glb.mjs` by `beast-assets.test.mjs`.
 */
export const BEAST_PART_KEYS = Object.freeze(['hackles', 'ruff', 'brow', 'nose']);

/**
 * (node, slot) pairs `BeastBody` already draws a mesh for.
 *
 * A part binding to anything else would need a mesh of its own, which is the
 * draw call this whole design exists to avoid. Refused at load, loudly, rather
 * than silently costing eight draws an animal.
 *
 * Kept in step with `make-beast-glb.mjs`'s `WELDABLE` by the test.
 */
export const BEAST_WELDABLE = Object.freeze([
  'body:coat', 'neck:coat', 'head:coat', 'head:dark', 'head:claw',
  'jaw:belly', 'jaw:claw',
]);

/** Session cache: asset id -> { key -> BufferGeometry }. */
let _assets = null;
/** Species id -> { asset, parts[] }, from the manifest. */
let _species = null;
/** Part key -> { node, slot }, from the manifest. */
let _bind = null;
/** In-flight load, so concurrent spawns share one fetch. */
let _loading = null;
/** Failure keys already logged - each distinct failure warns once per session. */
const _warned = new Set();

function warnOnce(key, message) {
  if (_warned.has(key)) return;
  _warned.add(key);
  console.warn(`BeastAssets: ${message} - falling back to the procedural beast`);
}

/**
 * How long any one request here may take before it is abandoned.
 *
 * Same reasoning as the ship and hero loaders', and the same number. A
 * connection that neither answers nor errors is not a failure path - `fetch`
 * simply never settles - and this load sits on the vale's first beast spawn.
 * Without a bound, a stalled socket is a forest with no animals in it and no
 * error anywhere. It is a deadlock bound, not a performance bound: 70 KB over
 * a phone link must not be cancelled into a worse animal.
 */
const FETCH_TIMEOUT_MS = 12000;

const timeoutSignal = () =>
  (typeof AbortSignal !== 'undefined' && AbortSignal.timeout
    ? AbortSignal.timeout(FETCH_TIMEOUT_MS)
    : undefined);

/**
 * Load every asset the manifest declares. Resolves even when files are absent -
 * the resolved map simply lacks the entry and every beast built from it is the
 * procedural one. Never rejects.
 */
export function loadBeastAssets() {
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
 * The authored parts for one species, or null - a SYNCHRONOUS read of whatever
 * `loadBeastAssets` has already resolved.
 *
 * Null is not an error. It is the procedural beast, which is what every
 * headless test measures and what a player with a failed download gets.
 *
 * Geometries are NOT cloned. The consumer (`BeastBody`) merges them into its
 * own buffers and never mutates or owns them - see the header note on why that
 * is safe and why it matters for a pack of five.
 *
 * @param {string} species one of the manifest's `species` keys
 * @returns {{key:string, node:string, slot:string, geometry:object}[]|null}
 */
export function beastParts(species) {
  const spec = _species?.[species];
  if (!spec) return null;
  const set = _assets?.[spec.asset];
  if (!set) return null;
  const out = [];
  for (const key of spec.parts) {
    const geometry = set[key];
    if (!geometry) continue; // one missing part is not a missing animal
    const b = _bind[key];
    if (!b) continue;
    out.push({ key, node: b.node, slot: b.slot, geometry });
  }
  return out.length ? out : null;
}

/** Every species the manifest knows, for tests and for the spawn-side mapping. */
export function beastSpecies() {
  return _species ? Object.keys(_species) : [];
}

async function loadAll() {
  /* BASE_URL, not '/': the built game mounts under /game/ and a hard-coded
   * absolute path is the bug the whole URL shape exists to prevent. Guarded so
   * the module stays importable under plain Node (no import.meta.env). */
  const base = (import.meta.env && import.meta.env.BASE_URL) || '/';
  const dir = `${base}assets/medieval/`;

  let manifest;
  try {
    const res = await fetch(`${dir}manifest.json`, { signal: timeoutSignal() });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    manifest = await res.json();
  } catch (e) {
    warnOnce('manifest', `could not load ${dir}manifest.json (${e.message})`);
    return {};
  }
  const entries = Array.isArray(manifest?.assets) ? manifest.assets : [];
  if (!entries.length) return {};
  _species = manifest.species ?? null;
  _bind = manifest.bind ?? null;
  if (!_species || !_bind) {
    warnOnce('manifest-shape', 'manifest is missing species/bind');
    return {};
  }
  for (const [key, b] of Object.entries(_bind)) {
    const pair = `${b.node}:${b.slot}`;
    if (!BEAST_WELDABLE.includes(pair)) {
      // Loud, and the whole manifest is refused: a part welded to a pair with
      // no mesh is a draw call per animal per part, which is the one cost this
      // design exists to avoid, and it would be invisible in a screenshot.
      warnOnce('bind', `part '${key}' binds to '${pair}', which BeastBody draws no mesh for`);
      _species = null;
      _bind = null;
      return {};
    }
  }

  /* One loader for the batch, imported lazily so the glTF parser only ever
   * downloads on the first beast spawn of a session. Vite splits it into its
   * own chunk, which the ship and hero loaders already pull, so on most
   * sessions this import resolves from cache. Hoisted above the fetches so the
   * chunk download overlaps them rather than sitting between them. */
  let loader = null;
  try {
    const { GLTFLoader } = await import('three/examples/jsm/loaders/GLTFLoader.js');
    loader = new GLTFLoader();
  } catch (e) {
    warnOnce('loader', `could not load the glTF parser (${e.message})`);
    return {};
  }

  const out = {};
  /* Both files at once. Each arm keeps its OWN try/catch and its own
   * `warnOnce`, so one 404 costs exactly one species and one warning, and
   * `Promise.all` never sees a rejection because none escapes. */
  await Promise.all(entries.map(async (entry) => {
    if (entry.kind !== 'geometry') {
      warnOnce(`kind:${entry.id}`, `asset '${entry.id}' has unhandled kind '${entry.kind}'`);
      return;
    }
    try {
      const res = await fetch(dir + entry.file, { signal: timeoutSignal() });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const buf = await res.arrayBuffer();
      const gltf = await loader.parseAsync(buf, dir);
      const parts = namedParts(gltf, entry.id);
      if (!Object.keys(parts).length) throw new Error('no usable mesh in scene');
      out[entry.id] = parts;
    } catch (e) {
      warnOnce(`asset:${entry.id}`, `could not load asset '${entry.id}' (${entry.file}: ${e.message})`);
    }
  }));
  return out;
}

/**
 * Every mesh in the file whose name is a known part key, with its node
 * transform baked in.
 *
 * The glTF MATERIAL is deliberately never touched - see the header.
 */
function namedParts(gltf, id) {
  const out = {};
  gltf.scene.updateMatrixWorld(true);
  gltf.scene.traverse((o) => {
    if (!o.isMesh || !o.geometry) return;
    const key = o.name;
    if (!BEAST_PART_KEYS.includes(key)) {
      warnOnce(`part:${id}:${key}`, `asset '${id}' has a mesh named '${key}', which is not a part key`);
      return;
    }
    const geo = o.geometry;
    if (!geo.index) {
      /* See the header. `BeastBody.merge` disposes a non-indexed input
       * directly, so the second animal in a pack would build from freed
       * buffers - a defect that would present as a wolf with no head rather
       * than as an error. */
      warnOnce(`unindexed:${id}:${key}`, `asset '${id}' part '${key}' is not indexed`);
      return;
    }
    geo.applyMatrix4(o.matrixWorld);
    geo.name = `beast.authored.${id}.${key}`;
    out[key] = geo;
  });
  return out;
}

/** Session teardown for tests. The game never calls this. */
export function resetBeastAssets() {
  _assets = null;
  _species = null;
  _bind = null;
  _loading = null;
  _warned.clear();
}

/**
 * Install a resolved asset map directly, for tests and headless rigs.
 *
 * There is no fetch in `node --test` and no DOM to hang one on, and the arm of
 * `BeastBody._build` that merges authored features is the arm the player sees -
 * so it has to be testable without a browser. The test parses the real
 * committed .glb off disk and hands it in here, which is as close to the
 * shipped path as a test can stand.
 *
 * @param {{assets:object, species:object, bind:object}} m
 */
export function installBeastAssets(m) {
  _assets = m.assets ?? null;
  _species = m.species ?? null;
  _bind = m.bind ?? null;
  _loading = null;
}
