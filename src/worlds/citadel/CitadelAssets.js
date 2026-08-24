/**
 * Lazy loader for Sunspire Citadel's authored hero architecture.
 *
 * Three parts - a pointed-arch surround, a mashrabiya window screen and a
 * muqarnas corbel run - for the three shapes `Batch.box` cannot make and the
 * before-shots said this world was missing. See `scripts/make-citadel-glb.mjs`
 * for what is authored and, more usefully, for what deliberately is not.
 *
 * This file is a near-copy of `src/worlds/medieval/BeastAssets.js` by intent
 * rather than by accident: that is the pipeline decision D4 names as already
 * proven, and a fifth variant of it invented from scratch would be a fifth set
 * of failure modes to discover. Manifest, lazy `GLTFLoader`, one fetch with an
 * abort signal, per-asset `try`/`catch`, one warning per distinct failure, and
 * a synchronous cache read that returns null rather than throwing.
 *
 * ── THE MATERIAL RULE, WHICH IS THE WHOLE POINT ───────────────────────────
 *
 * The glTF material is never read. Every part is handed to the world's own
 * `Batch` under the material key the manifest names, and merged into the
 * bucket that batch already flushes for that key.
 *
 * That is not tidiness. `Batch.flush` makes one `THREE.Mesh` per bucket, so a
 * part in a key its batch does not already emit is a draw call AND a candidate
 * shader program - and Citadel's whole render argument is 166 meshes for
 * ~350,000 triangles from every camera. Three keys its shader-program cache on
 * material configuration, this project boots by warming the cartesian product
 * of those programs, and Phase 9 is named in the roadmap as the phase most
 * likely to regress production frame time. Reusing the keys the world already
 * clones costs exactly zero.
 *
 * ── AND WHY THE PARTS ARE MERGED RATHER THAN PARENTED ─────────────────────
 *
 * The obvious implementation is a `THREE.Mesh` per arch. There are ~140
 * street-facing doorways in the souk, ~200 window reveals and 60 corbel runs.
 * Four hundred meshes against a framing measured at 914-1719 draws is not an
 * art pass, it is a regression with a nice picture on it. Added to the batch,
 * the cost is triangles and nothing else - no draw call, no material, no
 * program, no scene node.
 *
 * ── ONE CONSEQUENCE WORTH STATING OUT LOUD ────────────────────────────────
 *
 * `Batch.add` CONSUMES what it is handed: it converts to non-indexed, deletes
 * attributes it cannot merge, applies the matrix in place and disposes the
 * original. So every placement gets a `clone()`, and `citadelPart` hands back
 * the cached master rather than a copy precisely so the caller has to make
 * that decision visibly. `CitadelWorld._authored` is the one place that does.
 *
 * ── WHY THIS LIVES UNDER `worlds/citadel/` ───────────────────────────────
 *
 * Same argument `BeastAssets.js` makes from the other side: these are one
 * world's art, only `CitadelWorld.build` starts the load, and the asset lives
 * with the world that owns it. If a second world ever wants a pointed arch,
 * this moves to `src/gfx/` and the file to `public/assets/arch/` - at that
 * moment, and not before, on a guess about a world that may never exist.
 */

/**
 * Part keys the loader will accept.
 *
 * The allow-list is the point, exactly as it is for ship, hero and beast
 * parts: a part whose key nothing recognises would be placed by a rule chosen
 * by accident. A name outside this list is dropped with one warning instead of
 * guessed at.
 *
 * Kept in step with `scripts/make-citadel-glb.mjs` by `citadel-assets.test.mjs`.
 */
export const CITADEL_PART_KEYS = Object.freeze(['arch', 'screen', 'corbel']);

/**
 * `batch:materialKey` buckets `CitadelWorld` already flushes.
 *
 * A bind outside this set opens a new bucket in `Batch.flush`, which is one
 * more `THREE.Mesh`, one more draw call and a candidate shader program. Refused
 * at load, loudly, rather than silently costing a draw per district.
 *
 * Kept in step with `make-citadel-glb.mjs`'s `WELDABLE` by the test, and the
 * test holds the list itself against a real headless build so it cannot rot
 * into a stale claim that welding somewhere is safe.
 */
export const CITADEL_WELDABLE = Object.freeze([
  'wall:stone.castle',
  'souk:stone.castle',
  'souk:wood.beam',
  'citadel:stone.castle',
  'citadel:plaster.wall',
]);

/**
 * World-level triangle reservation for everything this pass adds.
 *
 * Not per part: the per-part reservation lives in the generator and bounds one
 * placement. This bounds the WORLD, because the cost of an authored arch is
 * the arch times however many doorways the souk turns out to have, and that
 * count is a property of `SOUK_RINGS` rather than of this file.
 *
 * MEASURED: 64,312 triangles over 347 placements, against a world that builds
 * 571,860 without them - 11.2%. The ceiling is 72,000, which is the measured
 * spend plus room for one more placement rule, and it is a CEILING rather than
 * a target. `citadel-assets.test.mjs` asserts a real headless build against it,
 * so a placement rule that quietly doubles a count fails a gate instead of a
 * frame time.
 *
 * What this buys, and why triangles are the right currency to spend here: the
 * same build is 166 meshes and 15 materials with the assets and 166 meshes and
 * 15 materials without them. Draw calls and shader programs are what this world
 * has a documented history of losing, and neither moves. Triangles are the one
 * budget line an art pass is allowed to spend, and this is the receipt.
 */
export const CITADEL_TRI_BUDGET = 72000;

/** Session cache: part key -> BufferGeometry. */
let _parts = null;
/** Part key -> { slot, batches }, from the manifest. */
let _bind = null;
/** In-flight load, so concurrent builds share one fetch. */
let _loading = null;
/** Failure keys already logged - each distinct failure warns once per session. */
const _warned = new Set();

function warnOnce(key, message) {
  if (_warned.has(key)) return;
  _warned.add(key);
  console.warn(`CitadelAssets: ${message} - falling back to the procedural detail`);
}

/**
 * How long any one request here may take before it is abandoned.
 *
 * Same reasoning as the ship, hero and beast loaders', and the same number. A
 * connection that neither answers nor errors is not a failure path - `fetch`
 * simply never settles - and this load sits on the citadel's build. Without a
 * bound, a stalled socket is a world that never finishes generating and no
 * error anywhere. It is a deadlock bound, not a performance bound: 35 KB over
 * a phone link must not be cancelled into a plainer town.
 */
const FETCH_TIMEOUT_MS = 12000;

const timeoutSignal = () =>
  (typeof AbortSignal !== 'undefined' && AbortSignal.timeout
    ? AbortSignal.timeout(FETCH_TIMEOUT_MS)
    : undefined);

/**
 * Load the manifest and the one `.glb`. Resolves even when the files are
 * absent - the resolved map is simply empty and every placement falls back to
 * the rectangle the world drew before this pass. Never rejects.
 */
export function loadCitadelAssets() {
  if (_parts) return Promise.resolve(_parts);
  if (_loading) return _loading;
  _loading = loadAll().then((map) => {
    _parts = map;
    _loading = null;
    return map;
  });
  return _loading;
}

/**
 * One authored part, or null - a SYNCHRONOUS read of whatever
 * `loadCitadelAssets` has already resolved.
 *
 * Null is not an error. It is the world as it was before this pass, which is
 * what every headless test that does not install the assets measures and what
 * a player with a failed download gets.
 *
 * The geometry is NOT cloned. `Batch.add` consumes what it is given, so the
 * caller must clone per placement - see the header note on why that is left
 * visible at the call site rather than hidden here.
 *
 * @param {string} key one of `CITADEL_PART_KEYS`
 * @returns {{key:string, slot:string, geometry:object}|null}
 */
export function citadelPart(key) {
  const geometry = _parts?.[key];
  if (!geometry) return null;
  const b = _bind?.[key];
  if (!b) return null;
  return { key, slot: b.slot, geometry };
}

/** Every part the manifest resolved, for tests and for the placement rules. */
export function citadelParts() {
  return _parts ? Object.keys(_parts) : [];
}

async function loadAll() {
  /* BASE_URL, not '/': the built game mounts under /game/ and a hard-coded
   * absolute path is the bug the whole URL shape exists to prevent. Guarded so
   * the module stays importable under plain Node (no import.meta.env). */
  const base = (import.meta.env && import.meta.env.BASE_URL) || '/';
  const dir = `${base}assets/citadel/`;

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
  _bind = manifest.bind ?? null;
  if (!_bind) {
    warnOnce('manifest-shape', 'manifest is missing bind');
    return {};
  }
  for (const [key, b] of Object.entries(_bind)) {
    for (const batch of b.batches ?? []) {
      if (!CITADEL_WELDABLE.includes(`${batch}:${b.slot}`)) {
        /* Loud, and the whole manifest is refused: a part in a key its batch
         * does not already flush is one more mesh per district, which is the
         * one cost this design exists to avoid, and it would be invisible in a
         * screenshot. */
        warnOnce('bind', `part '${key}' binds to '${batch}:${b.slot}', which CitadelWorld does not already flush`);
        _bind = null;
        return {};
      }
    }
  }

  /* One loader for the file, imported lazily so the glTF parser only ever
   * downloads on the first citadel build of a session. Vite splits it into its
   * own chunk, which the ship, hero and beast loaders already pull, so on most
   * sessions this import resolves from cache. */
  let loader = null;
  try {
    const { GLTFLoader } = await import('three/examples/jsm/loaders/GLTFLoader.js');
    loader = new GLTFLoader();
  } catch (e) {
    warnOnce('loader', `could not load the glTF parser (${e.message})`);
    return {};
  }

  const out = {};
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
      Object.assign(out, parts);
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
    if (!CITADEL_PART_KEYS.includes(key)) {
      warnOnce(`part:${id}:${key}`, `asset '${id}' has a mesh named '${key}', which is not a part key`);
      return;
    }
    const geo = o.geometry;
    if (!geo.index) {
      /* `Batch.add` calls `toNonIndexed()` on an indexed input and disposes
       * only that copy, so an indexed master survives every placement. A
       * non-indexed master would be disposed by the first arch and the second
       * would build from freed buffers - a defect that presents as a town with
       * one arch in it rather than as an error. */
      warnOnce(`unindexed:${id}:${key}`, `asset '${id}' part '${key}' is not indexed`);
      return;
    }
    geo.applyMatrix4(o.matrixWorld);
    geo.name = `citadel.authored.${key}`;
    out[key] = geo;
  });
  return out;
}

/** Session teardown for tests. The game never calls this. */
export function resetCitadelAssets() {
  _parts = null;
  _bind = null;
  _loading = null;
  _warned.clear();
}

/**
 * Install a resolved part map directly, for tests and headless rigs.
 *
 * There is no fetch in `node --test` and no DOM to hang one on, and the arm of
 * `CitadelWorld` that places authored geometry is the arm the player sees - so
 * it has to be testable without a browser. The test parses the real committed
 * `.glb` off disk and hands it in here, which is as close to the shipped path
 * as a test can stand.
 *
 * @param {{parts:object, bind:object}} m
 */
export function installCitadelAssets(m) {
  _parts = m.parts ?? null;
  _bind = m.bind ?? null;
  _loading = null;
}
