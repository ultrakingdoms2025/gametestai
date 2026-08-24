/**
 * Lazy loader for Lodestar Yard's authored hull sections.
 *
 * The three drums on the jigs in the middle of the yard are the largest props
 * in this world and the object its whole premise rests on — a yard that
 * re-assembles hulls that came through a gateway in pieces. They shipped as
 * `CylinderGeometry(r, r, len, 16, 1, true)` with a torus at each frame line,
 * and photographed at 20 m the biggest of them measured mean luma 39.1 at
 * saturation 0.193 with 85% of its pixels under 48/255: a flat dark mass. See
 * `scripts/make-yard-glb.mjs` for what is authored instead and, more usefully,
 * for what deliberately is not.
 *
 * This file is a near-copy of `src/worlds/medieval/BeastAssets.js` by intent
 * rather than by accident: that is the pipeline decision D4 names as already
 * proven, and a fifth variant of it invented from scratch would be a fifth set
 * of failure modes to discover. Manifest, lazy `GLTFLoader`, parallel fetches
 * with an abort signal, per-asset `try`/`catch`, one warning per distinct
 * failure, and a synchronous cache read that returns null rather than throwing.
 *
 * ── THE MATERIAL RULE, WHICH IS THE WHOLE POINT ───────────────────────────
 *
 * The glTF material is never read. **A mesh's NAME is the yard material key it
 * is drawn with**, exactly as it is for the ship hulls in `ships/ShipAssets.js`
 * — and because `DockWorld` batches the entire yard through one `GeoBatch`
 * keyed on those same names, an authored part does not merely reuse a
 * material: it merges into the single mesh the yard already draws for that
 * bucket.
 *
 *   no new draw call, no new material, no new shader program.
 *
 * Three keys its shader-program cache on material configuration, this project
 * boots by warming the cartesian product of those programs, and Phase 9 is
 * named in the roadmap as the phase most likely to regress production frame
 * time. A section that brought its own PBR material would be a new program
 * family on every dock load. Measured across all 24 dock framings with these
 * installed: 490 programs before, 490 after.
 *
 * ── WHY THE KEY IS CHECKED AGAINST THE LIVE MATERIAL SET ──────────────────
 *
 * `YARD_PART_KEYS` below is an allow-list, and `DockWorld` re-checks each key
 * against `this.mat` before it puts anything. A part naming a bucket the yard
 * has no material for is not a cosmetic mistake: `GeoBatch.flush` would build
 * `new THREE.Mesh(merged, undefined)`, which three fills in with a default
 * white `MeshBasicMaterial` — a new draw call, a new material and a new
 * program, silently, on the one thing this design exists to prevent. Refused
 * at load with a warning, and the section degrades to the procedural drum.
 *
 * ── AND WHY THE GEOMETRIES ARE CLONED AT USE ──────────────────────────────
 *
 * `GeoBatch.add` takes OWNERSHIP: it applies the placement matrix to the
 * geometry in place and then disposes it in `flush`. The cache here is
 * session-scoped and a world can be built more than once (the harness does it,
 * the rehearsal does it, a re-entry could), so the consumer clones. Stated
 * here as well as there because the failure mode is a section that is in the
 * right place the first time and 30 m into the floor the second.
 */

/**
 * Part keys the loader will accept — which are yard MATERIAL keys.
 *
 * Kept in step with `scripts/make-yard-glb.mjs`'s `YARD_PART_KEYS` by
 * `scripts/tests/yard-assets.test.mjs`, which also holds every one of them
 * against the live output of `buildYardMaterials`.
 */
export const YARD_PART_KEYS = Object.freeze(['plate', 'steel', 'steelDark', 'hazard']);

/** Session cache: asset id -> { partKey -> BufferGeometry }. */
let _assets = null;
/** Section id -> { asset, parts[] }, from the manifest. */
let _sections = null;
/** In-flight load, so two builds of this world share one fetch. */
let _loading = null;
/** Failure keys already logged - each distinct failure warns once per session. */
const _warned = new Set();

function warnOnce(key, message) {
  if (_warned.has(key)) return;
  _warned.add(key);
  console.warn(`YardAssets: ${message} - falling back to the procedural section`);
}

/**
 * How long any one request here may take before it is abandoned.
 *
 * Same reasoning as the ship, hero and beast loaders', and the same number. A
 * connection that neither answers nor errors is not a failure path — `fetch`
 * simply never settles — and this load sits inside `DockWorld.build`, in front
 * of a loading screen. Without a bound, a stalled socket is a yard that never
 * finishes building and no error anywhere. It is a deadlock bound, not a
 * performance bound.
 */
const FETCH_TIMEOUT_MS = 12000;

const timeoutSignal = () =>
  (typeof AbortSignal !== 'undefined' && AbortSignal.timeout
    ? AbortSignal.timeout(FETCH_TIMEOUT_MS)
    : undefined);

/**
 * Load every asset the manifest declares. Resolves even when files are absent —
 * the resolved map simply lacks the entry and every section built from it is
 * the procedural drum, which is what the whole headless suite measures. Never
 * rejects.
 */
export function loadYardAssets() {
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
 * The authored parts for one section, or null — a SYNCHRONOUS read of whatever
 * `loadYardAssets` has already resolved.
 *
 * Null is not an error. It is the procedural section: `DockWorld._buildSections`
 * keeps that arm and every test that builds the yard headlessly takes it.
 *
 * Geometries are NOT cloned here. The caller clones, because the caller is the
 * one handing them to `GeoBatch`, which owns and disposes what it is given —
 * see the header.
 *
 * @param {string} id one of `YardPlan.SECTIONS[].id`
 * @returns {{key:string, geometry:object}[]|null}
 */
export function sectionParts(id) {
  const spec = _sections?.[id];
  if (!spec) return null;
  const set = _assets?.[spec.asset];
  if (!set) return null;
  const out = [];
  for (const key of spec.parts) {
    const geometry = set[key];
    if (!geometry) continue;   // one missing part is not a missing section
    out.push({ key, geometry });
  }
  return out.length ? out : null;
}

/** Every section the manifest knows, for tests. */
export function yardSections() {
  return _sections ? Object.keys(_sections) : [];
}

async function loadAll() {
  /* BASE_URL, not '/': the built game mounts under /game/ and a hard-coded
   * absolute path is the bug the whole URL shape exists to prevent. Guarded so
   * the module stays importable under plain Node (no import.meta.env). */
  const base = (import.meta.env && import.meta.env.BASE_URL) || '/';
  const dir = `${base}assets/dock/`;

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
  _sections = manifest.sections ?? null;
  if (!_sections) {
    warnOnce('manifest-shape', 'manifest is missing `sections`');
    return {};
  }

  /* One loader for the batch, imported lazily so the glTF parser only ever
   * downloads on the first dock entry of a session. Vite splits it into its
   * own chunk, which the ship loader already pulls on this very world, so in
   * practice this import resolves from cache. Hoisted above the fetches so the
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
  /* All three at once. Each arm keeps its OWN try/catch and its own
   * `warnOnce`, so one 404 costs exactly one section and one warning, and
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
 * Every mesh in the file whose name is a known yard material key, with its
 * node transform baked in.
 *
 * The glTF MATERIAL is deliberately never touched — see the header.
 */
function namedParts(gltf, id) {
  const out = {};
  gltf.scene.updateMatrixWorld(true);
  gltf.scene.traverse((o) => {
    if (!o.isMesh || !o.geometry) return;
    const key = o.name;
    if (!YARD_PART_KEYS.includes(key)) {
      warnOnce(`part:${id}:${key}`,
        `asset '${id}' has a mesh named '${key}', which is not a yard material key`);
      return;
    }
    const geo = o.geometry;
    if (!geo.index) {
      /* `GeoBatch.add` will index a non-indexed geometry for `mergeGeometries`,
       * so this would not crash — it would silently spend one index per vertex
       * on a mesh that arrived unindexed because something re-exported it.
       * Refused, because the generator never writes one and a file that has
       * one is a file nobody in this repository produced. */
      warnOnce(`unindexed:${id}:${key}`, `asset '${id}' part '${key}' is not indexed`);
      return;
    }
    geo.applyMatrix4(o.matrixWorld);
    geo.name = `yard.authored.${id}.${key}`;
    out[key] = geo;
  });
  return out;
}

/** Session teardown for tests. The game never calls this. */
export function resetYardAssets() {
  _assets = null;
  _sections = null;
  _loading = null;
  _warned.clear();
}

/**
 * Install a resolved asset map directly, for tests and headless rigs.
 *
 * There is no fetch in `node --test` and no DOM to hang one on, and the arm of
 * `DockWorld._buildSections` that puts authored geometry is the arm the player
 * sees — so it has to be testable without a browser. The test parses the real
 * committed `.glb` off disk and hands it in here, which is as close to the
 * shipped path as a test can stand.
 *
 * @param {{assets:object, sections:object}} m
 */
export function installYardAssets(m) {
  _assets = m.assets ?? null;
  _sections = m.sections ?? null;
  _loading = null;
}
