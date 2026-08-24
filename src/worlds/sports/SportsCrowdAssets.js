import * as THREE from 'three';

/**
 * Lazy loader for the Meridian Athletic Grounds crowd's authored hero features.
 *
 * The site's 583 ambient figures get authored geometry for the three features
 * that separate a person from the merged cylinder stack `SportsWorld`'s
 * `figure()` builds: hair, hands and shoes. Everything else about them -
 * placement, poses, the palette, the grouping model that puts them in knots
 * rather than in a grid - stays procedural. See
 * `scripts/make-sports-crowd-glb.mjs` for what is authored and, more usefully,
 * for what deliberately is not.
 *
 * This file is a near-copy of `src/worlds/station/CrowdAssets.js` by intent
 * rather than by accident: that is the pipeline decision D4 names as already
 * proven, and a seventh variant of it invented from scratch would be a seventh
 * set of failure modes to discover. Manifest, lazy `GLTFLoader`, parallel
 * fetches with an abort signal, per-asset `try`/`catch`, one warning per
 * distinct failure, and a synchronous cache read that returns null rather than
 * throwing.
 *
 * ── THE MATERIAL RULE, WHICH IS THE WHOLE POINT ───────────────────────────
 *
 * The glTF material is never read. Every part is MERGED into the geometry
 * `SportsWorld._buildCrowd` already builds for one of the crowd's two
 * surfaces, and which surface is a manifest field.
 *
 * That is not tidiness. Three keys its shader-program cache on the material
 * configuration and this project boots by warming the cartesian product of
 * those programs. A crowd that brought its own PBR material would be a new
 * program family on every boot of the game. Reusing `crowd.cloth` and
 * `crowd.skin` costs exactly zero, and the branch ledger's before/after
 * confirms the count did not move.
 *
 * ── ONE DIFFERENCE FROM THE STATION'S LOADER, AND IT MATTERS ──────────────
 *
 * The station's `M.skin` is NOT built `vertexColors`, so a skin part there
 * must carry no colour attribute. **Both** of this world's crowd materials are
 * `vertexColors: true` - see `whiteColor()` in `SportsWorld.js`, which records
 * the bug that forced it - so here EVERY part carries one, and a part that
 * arrived without would be drawn pure black by the generic vertex-attribute
 * default of (0,0,0). The shade is baked once, here, at load, from the
 * manifest's `bind`, so a geometry shared by nothing else is never mutated
 * twice.
 *
 * ── WHY THE PARTS ARE MERGED RATHER THAN PARENTED ─────────────────────────
 *
 * There is nothing to parent them to: a crowd figure is not a scene node. The
 * whole crowd is TEN `InstancedMesh`es - one cloth and one skin per pose - and
 * "a figure" is one index into a pair of them. Three parts as their own
 * instanced meshes would be six more draw calls and three more parallel index
 * maps to keep in step. Merged into the geometry that is already there, the
 * cost is triangles and nothing else.
 */

/**
 * Part keys the loader will accept.
 *
 * The allow-list is the point, exactly as it is for ship, hero, beast and
 * station-crowd parts: a part whose key nothing recognises would be merged
 * into a mesh chosen by accident, which renders as a crowd wearing its shoes
 * on its head. A name outside this list is dropped with one warning instead of
 * guessed at.
 *
 * Kept in step with `scripts/make-sports-crowd-glb.mjs` by
 * `sports-crowd-assets.test.mjs`.
 */
export const SPORTS_CROWD_PART_KEYS = Object.freeze(['hair', 'hand', 'shoe']);

/**
 * The only two surfaces the crowd draws in.
 *
 * `cloth` is `crowd.cloth` (garment) and `skin` is `crowd.skin` (flesh). Both
 * are instance-tinted and both read vertex colours. A part bound to anything
 * else would need a material of its own, which is the shader program this
 * whole design exists not to spend. Refused at load, loudly.
 */
export const SPORTS_CROWD_SLOTS = Object.freeze(['cloth', 'skin']);

/** Session cache: asset id -> { key -> BufferGeometry }, shade-baked. */
let _assets = null;
/** Set id -> { asset, parts[] }, from the manifest. */
let _sets = null;
/** Part key -> { slot, shade }, from the manifest. */
let _bind = null;
/** In-flight load, so a re-entered build shares one fetch. */
let _loading = null;
/** Failure keys already logged - each distinct failure warns once per session. */
const _warned = new Set();

function warnOnce(key, message) {
  if (_warned.has(key)) return;
  _warned.add(key);
  console.warn(`SportsCrowdAssets: ${message} - falling back to the procedural crowd`);
}

/**
 * How long any one request here may take before it is abandoned.
 *
 * Same reasoning as the ship, hero, beast and station-crowd loaders', and the
 * same number. A connection that neither answers nor errors is not a failure
 * path - `fetch` simply never settles - and this load sits inside the sports
 * world's build. Without a bound, a stalled socket is a loading screen that
 * never finishes and no error anywhere. It is a deadlock bound, not a
 * performance bound: 41 KB over a phone link must not be cancelled into a
 * worse crowd.
 */
const FETCH_TIMEOUT_MS = 12000;

const timeoutSignal = () =>
  (typeof AbortSignal !== 'undefined' && AbortSignal.timeout
    ? AbortSignal.timeout(FETCH_TIMEOUT_MS)
    : undefined);

/**
 * Load every asset the manifest declares. Resolves even when files are absent -
 * the resolved map simply lacks the entry and the crowd built from it is the
 * procedural one. Never rejects.
 */
export function loadSportsCrowdAssets() {
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
 * The authored parts for one pose, split by the slot they merge into - a
 * SYNCHRONOUS read of whatever `loadSportsCrowdAssets` has already resolved.
 *
 * `null` is not an error. It is the procedural crowd, which is what every
 * headless test measures and what a player with a failed download gets.
 *
 * Geometries are NOT cloned. The consumer merges them into its own buffers and
 * never mutates or owns them.
 *
 * @param {string} set one of the manifest's `sets` keys (a pose id)
 * @returns {{cloth: THREE.BufferGeometry[], skin: THREE.BufferGeometry[]}|null}
 */
export function sportsCrowdParts(set) {
  const spec = _sets?.[set];
  if (!spec) return null;
  const bag = _assets?.[spec.asset];
  if (!bag) return null;
  const out = { cloth: [], skin: [] };
  for (const key of spec.parts) {
    const geometry = bag[key];
    if (!geometry) continue; // one missing part is not a missing crowd
    const b = _bind?.[key];
    if (!b || !out[b.slot]) continue;
    out[b.slot].push(geometry);
  }
  return (out.cloth.length || out.skin.length) ? out : null;
}

/**
 * Whether a given part actually landed for a pose.
 *
 * `_buildCrowd` asks this before it builds a limb `openEnded`: a leg may only
 * lose its end cap if the shoe that covers that cap is really going to be
 * merged in. Without the question there is a silent failure mode where a 404
 * produces a crowd with hollow tubes for legs - strictly worse than the
 * mannequin this pass set out to fix.
 *
 * @param {string} set pose id
 * @param {string} key part key
 */
export function sportsCrowdHas(set, key) {
  const spec = _sets?.[set];
  if (!spec || !spec.parts.includes(key)) return false;
  return !!_assets?.[spec.asset]?.[key];
}

/** Every set the manifest knows, for tests and for the build-side mapping. */
export function sportsCrowdSets() {
  return _sets ? Object.keys(_sets) : [];
}

async function loadAll() {
  /* BASE_URL, not '/': the built game mounts under /game/ and a hard-coded
   * absolute path is the bug the whole URL shape exists to prevent. Guarded so
   * the module stays importable under plain Node (no import.meta.env). */
  const base = (import.meta.env && import.meta.env.BASE_URL) || '/';
  const dir = `${base}assets/sports/`;

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
  _sets = manifest.sets ?? null;
  _bind = manifest.bind ?? null;
  if (!_sets || !_bind) {
    warnOnce('manifest-shape', 'manifest is missing sets/bind');
    return {};
  }
  for (const [key, b] of Object.entries(_bind)) {
    if (!SPORTS_CROWD_SLOTS.includes(b?.slot)) {
      /* Loud, and the whole manifest is refused. A part in an unknown slot
       * cannot be merged into anything the crowd already draws, so honouring
       * it would mean a new mesh and a new material - the one cost this design
       * exists to avoid, and one that would be invisible in a screenshot. */
      warnOnce('bind', `part '${key}' binds to slot '${b?.slot}', which the crowd draws no mesh for`);
      _sets = null;
      _bind = null;
      return {};
    }
    if (!(b.shade > 0)) {
      warnOnce('shade', `part '${key}' has no shade - both crowd materials read vertex colours and would draw it black`);
      _sets = null;
      _bind = null;
      return {};
    }
  }

  /* One loader for the batch, imported lazily so the glTF parser only ever
   * downloads on a session that actually reaches a world with authored assets.
   * Vite splits it into its own chunk, which the ship, hero, beast and station
   * crowd loaders already pull, so on most sessions this import resolves from
   * cache. */
  let loader = null;
  try {
    const { GLTFLoader } = await import('three/examples/jsm/loaders/GLTFLoader.js');
    loader = new GLTFLoader();
  } catch (e) {
    warnOnce('loader', `could not load the glTF parser (${e.message})`);
    return {};
  }

  const out = {};
  /* All five files at once. Each arm keeps its OWN try/catch and its own
   * `warnOnce`, so one 404 costs exactly one pose and one warning, and
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
 * transform baked in and the manifest's shade written as a constant vertex
 * colour.
 *
 * The glTF MATERIAL is deliberately never touched - see the header.
 */
function namedParts(gltf, id) {
  const out = {};
  gltf.scene.updateMatrixWorld(true);
  gltf.scene.traverse((o) => {
    if (!o.isMesh || !o.geometry) return;
    const key = o.name;
    if (!SPORTS_CROWD_PART_KEYS.includes(key)) {
      warnOnce(`part:${id}:${key}`, `asset '${id}' has a mesh named '${key}', which is not a part key`);
      return;
    }
    const b = _bind?.[key];
    if (!b) return;
    const geo = o.geometry;
    if (!geo.index) {
      /* `mergeGeometries` will not mix indexed and non-indexed inputs, and the
       * crowd's own primitives are all indexed. A non-indexed part would take
       * out the whole pose it landed in, presenting as an entire pose missing
       * from the site rather than as an error. */
      warnOnce(`unindexed:${id}:${key}`, `asset '${id}' part '${key}' is not indexed`);
      return;
    }
    geo.applyMatrix4(o.matrixWorld);
    bakeSportsCrowdPart(geo, b);
    geo.name = `sports.crowd.${id}.${key}`;
    out[key] = geo;
  });
  return out;
}

/**
 * Give one authored part the attribute set the geometry it merges into already
 * has.
 *
 * Exported so `sports-crowd-assets.test.mjs` can run the SHIPPED bake rather
 * than a copy of it. A test that reimplemented this would pass happily while
 * the loader wrote the wrong shade, and the symptom of that - a crowd with
 * flesh-coloured hair, or the whole merge returning null and the crowd
 * silently reverting - is invisible in every number a budget gate records.
 *
 * @param {THREE.BufferGeometry} geo mutated in place
 * @param {{slot:string, shade:number}} bind the manifest entry
 */
export function bakeSportsCrowdPart(geo, bind) {
  const n = geo.getAttribute('position').count;
  const col = new Float32Array(n * 3);
  col.fill(bind.shade);
  geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
  return geo;
}

/** Session teardown for tests. The game never calls this. */
export function resetSportsCrowdAssets() {
  _assets = null;
  _sets = null;
  _bind = null;
  _loading = null;
  _warned.clear();
}

/**
 * Install a resolved asset map directly, for tests and headless rigs.
 *
 * There is no fetch in `node --test` and no DOM to hang one on, and the arm of
 * `figure()` that merges authored features is the arm every player sees - so it
 * has to be testable without a browser. The test parses the real committed
 * `.glb` off disk, bakes the same shade this loader bakes, and hands it in
 * here, which is as close to the shipped path as a test can stand.
 *
 * @param {{assets:object, sets:object, bind:object}} m
 */
export function installSportsCrowdAssets(m) {
  _assets = m.assets ?? null;
  _sets = m.sets ?? null;
  _bind = m.bind ?? null;
  _loading = null;
}
