/**
 * Lazy loader for Aldermoor Vale's authored timber-frame carpentry.
 *
 * Two parts - a curved arch-brace and a cyma jetty console - for the one
 * shape a box batch cannot make on the surfaces the village framings actually
 * photograph. See `scripts/make-medieval-glb.mjs` for what is authored and,
 * more usefully, for what deliberately is not.
 *
 * This file is a near-copy of `src/worlds/citadel/CitadelAssets.js` by intent
 * rather than by accident - which was itself a near-copy of this world's own
 * `BeastAssets.js`. That is the pipeline decision D4 names as already proven
 * six times over, and a seventh variant invented from scratch would be a
 * seventh set of failure modes to discover. Manifest, lazy `GLTFLoader`, one
 * fetch with an abort signal, per-asset `try`/`catch`, one warning per
 * distinct failure, and a synchronous cache read that returns null rather
 * than throwing.
 *
 * ── THE MATERIAL RULE, WHICH IS THE WHOLE POINT ───────────────────────────
 *
 * The glTF material is never read. Every part is merged into the village
 * `GeoBatch` under the material SLOT the manifest names ('beam'), which every
 * village batch already flushes. Three keys its shader-program cache on
 * material configuration, this project boots by warming the cartesian product
 * of those programs, and medieval's entry budget is already 2.9x over. A
 * brace that brought its own PBR material would be a new program family on
 * every medieval load; reusing the slot the framing already draws in costs
 * exactly zero programs, zero materials and zero draw calls, because the
 * parts are MERGED into the mesh the village already draws, not parented to
 * it.
 *
 * ── AND WHY THE PARTS ARE MERGED RATHER THAN PARENTED ─────────────────────
 *
 * ~490 braces and ~210 consoles across the village. Five hundred `THREE.Mesh`
 * nodes against framings measured at 805-1537 draws is not an art pass, it is
 * a regression with a nice picture on it. Merged, the cost is triangles and
 * nothing else.
 *
 * ── ONE CONSEQUENCE WORTH STATING OUT LOUD ────────────────────────────────
 *
 * `GeoBatch.add` CONSUMES what it is handed: `normaliseGeo` deletes
 * attributes, the matrix is applied in place, and `build` disposes the merged
 * inputs. So every placement gets a `.clone()`, and `framePart` hands back
 * the cached master rather than a copy precisely so the caller has to make
 * that decision visibly. `MedievalWorld._authoredFrame` is the one place that
 * does.
 */

/** Part keys the loader will accept. */
export const FRAME_PART_KEYS = Object.freeze(['brace', 'console']);

/**
 * Material slots the village `GeoBatch` already flushes.
 *
 * A part bound to a slot outside this list would open a new bucket in
 * `GeoBatch.build` - one more mesh, one more draw call and a candidate shader
 * program. Refused at load, loudly. Kept in step with
 * `make-medieval-glb.mjs`'s `WELDABLE` by `medieval-frame-assets.test.mjs`,
 * which holds the list itself against a real headless build.
 */
export const FRAME_WELDABLE = Object.freeze(['beam']);

/**
 * World-level triangle reservation for everything this pass merges in.
 *
 * Not per part - that reservation lives in the generator and bounds one
 * placement. This bounds the WORLD, because the cost of an authored brace is
 * the brace times however many storey corners `PLOTS` turns out to hold, and
 * that count is a property of the plot table rather than of this file.
 * MEASURED: 24,968 triangles over 424 braces and 154 consoles, against a
 * village-plus-castle headless build of 169,034 without them. The ceiling is
 * the measured spend plus room for one more placement rule, and it is a
 * CEILING rather than a target - `medieval-frame-assets.test.mjs` asserts a
 * real headless build against it, so a placement rule that quietly doubles a
 * count fails a gate instead of a frame time.
 */
export const MEDIEVAL_FRAME_TRI_BUDGET = 32000;

/** Session cache: part key -> BufferGeometry. */
let _parts = null;
/** Part key -> { slot }, from the manifest. */
let _bind = null;
/** In-flight load, so concurrent builds share one fetch. */
let _loading = null;
/** Failure keys already logged - each distinct failure warns once per session. */
const _warned = new Set();

function warnOnce(key, message) {
  if (_warned.has(key)) return;
  _warned.add(key);
  console.warn(`FrameAssets: ${message} - falling back to the procedural framing`);
}

/**
 * How long any one request here may take before it is abandoned. Same
 * reasoning as the ship, hero, beast and citadel loaders', and the same
 * number: it is a deadlock bound, not a performance bound - a stalled socket
 * must not become a world that never finishes generating, and 10 KB over a
 * phone link must not be cancelled into a plainer village.
 */
const FETCH_TIMEOUT_MS = 12000;

const timeoutSignal = () =>
  (typeof AbortSignal !== 'undefined' && AbortSignal.timeout
    ? AbortSignal.timeout(FETCH_TIMEOUT_MS)
    : undefined);

/**
 * Load the manifest and the one `.glb`. Resolves even when the files are
 * absent - the resolved map is simply empty and every placement falls back to
 * the straight strap the village drew before this pass. Never rejects.
 */
export function loadFrameAssets() {
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
 * `loadFrameAssets` has already resolved.
 *
 * Null is not an error. It is the village as it was before this pass, which
 * is what every headless test that does not install the assets measures and
 * what a player with a failed download gets.
 *
 * The geometry is NOT cloned - see the header on why that is left visible at
 * the call site rather than hidden here.
 *
 * @param {string} key one of `FRAME_PART_KEYS`
 * @returns {{key:string, slot:string, geometry:object}|null}
 */
export function framePart(key) {
  const geometry = _parts?.[key];
  if (!geometry) return null;
  const b = _bind?.[key];
  if (!b) return null;
  return { key, slot: b.slot, geometry };
}

/** Every part the manifest resolved, for tests and for the placement rules. */
export function frameParts() {
  return _parts ? Object.keys(_parts) : [];
}

async function loadAll() {
  /* BASE_URL, not '/': the built game mounts under /game/ and a hard-coded
   * absolute path is the bug the whole URL shape exists to prevent. Guarded so
   * the module stays importable under plain Node (no import.meta.env). */
  const base = (import.meta.env && import.meta.env.BASE_URL) || '/';
  const dir = `${base}assets/medieval/`;

  let manifest;
  try {
    const res = await fetch(`${dir}frame-manifest.json`, { signal: timeoutSignal() });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    manifest = await res.json();
  } catch (e) {
    warnOnce('manifest', `could not load ${dir}frame-manifest.json (${e.message})`);
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
    if (!FRAME_WELDABLE.includes(b.slot)) {
      /* Loud, and the whole manifest is refused: a part in a slot the batch
       * does not already flush is one more mesh, which is the one cost this
       * design exists to avoid, and it would be invisible in a screenshot. */
      warnOnce('bind', `part '${key}' binds to slot '${b.slot}', which the village GeoBatch does not already flush`);
      _bind = null;
      return {};
    }
  }

  /* One loader for the file, imported lazily so the glTF parser only ever
   * downloads on the first medieval build of a session. Vite splits it into
   * its own chunk, which the ship, hero and beast loaders already pull, so on
   * most sessions this import resolves from cache. */
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
 * transform baked in. The glTF MATERIAL is deliberately never touched - see
 * the header.
 */
function namedParts(gltf, id) {
  const out = {};
  gltf.scene.updateMatrixWorld(true);
  gltf.scene.traverse((o) => {
    if (!o.isMesh || !o.geometry) return;
    const key = o.name;
    if (!FRAME_PART_KEYS.includes(key)) {
      warnOnce(`part:${id}:${key}`, `asset '${id}' has a mesh named '${key}', which is not a part key`);
      return;
    }
    const geo = o.geometry;
    if (!geo.index) {
      /* The master is cloned per placement and the clone is consumed; an
       * indexed master is what guarantees `toNonIndexed()` copies rather than
       * aliases. A non-indexed master would be disposed by the first brace
       * and the second would build from freed buffers - a defect that
       * presents as a village with one curved brace in it, not as an error. */
      warnOnce(`unindexed:${id}:${key}`, `asset '${id}' part '${key}' is not indexed`);
      return;
    }
    geo.applyMatrix4(o.matrixWorld);
    geo.name = `medieval.authored.${key}`;
    out[key] = geo;
  });
  return out;
}

/** Session teardown for tests. The game never calls this. */
export function resetFrameAssets() {
  _parts = null;
  _bind = null;
  _loading = null;
  _warned.clear();
}

/**
 * Install a resolved part map directly, for tests and headless rigs.
 *
 * There is no fetch in `node --test` and no DOM to hang one on, and the arm
 * of `MedievalWorld` that places authored geometry is the arm the player sees
 * - so it has to be testable without a browser. The test parses the real
 * committed `.glb` off disk and hands it in here, which is as close to the
 * shipped path as a test can stand.
 *
 * @param {{parts:object, bind:object}} m
 */
export function installFrameAssets(m) {
  _parts = m.parts ?? null;
  _bind = m.bind ?? null;
  _loading = null;
}
