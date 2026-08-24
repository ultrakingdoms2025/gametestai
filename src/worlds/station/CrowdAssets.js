import * as THREE from 'three';
import { uvScale } from './StationKit.js';

/**
 * Lazy loader for the station crowd's authored hero features.
 *
 * The hub deck's ~180 ambient figures get authored geometry for the four
 * features that separate a person from the merged capsule stack
 * `StationWorld._crowdBodyGeo` builds: hands, hair, a coat collar and shoes.
 * Everything else about them - placement, palette, poses, the backpack and
 * hood variants, the breathing - stays procedural. See
 * `scripts/make-crowd-glb.mjs` for what is authored and, more usefully, for
 * what deliberately is not.
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
 * The glTF material is never read. Every part is MERGED into the geometry
 * `StationWorld` already builds for one of the crowd's two surfaces, and which
 * surface is a manifest field.
 *
 * That is not tidiness. Three keys its shader-program cache on the material
 * configuration, this project boots by warming the cartesian product of those
 * programs, and the station is the ENTRY WORLD - the one place where a
 * boot-time regression is measured and where it hurts most. A crowd that
 * brought its own PBR material would be a new program family on every boot of
 * the game. Reusing `M.crowd` and `M.skin` costs exactly zero.
 *
 * ── AND WHY THE PARTS ARE MERGED RATHER THAN PARENTED ─────────────────────
 *
 * The obvious implementation is to hang each part off the figure as its own
 * mesh. There is nothing to hang it off: a crowd figure is not a scene node.
 * The whole crowd is six `InstancedMesh`es - four body variants and two head
 * meshes - and "a figure" is one index into all of them. Four parts as their
 * own instanced meshes would be four more draw calls per set and, worse, four
 * more parallel index maps for `_updateAnimated` to keep in step. Merged into
 * the geometry that is already there, the cost is triangles and nothing else.
 *
 * ── WHAT THIS LOADER BAKES, AND WHY IT BAKES IT HERE ──────────────────────
 *
 * Two things the `.glb` deliberately does not carry:
 *
 *  - **uv scale.** The crowd's own parts are `uvScale`d as they are placed, so
 *    an authored part at 1:1 would show the cloth map at a different texel
 *    density than the sleeve it sits on.
 *  - **vertex colour.** `M.crowd` is built `vertexColors: true`, so every
 *    geometry merged into a body variant MUST carry a `color` attribute or
 *    `mergeGeometries` refuses the whole merge - and `M.skin` is NOT, so a
 *    head-mesh part must carry none. That is not a detail: the two are
 *    different attribute sets and a part in the wrong one takes the whole
 *    crowd out silently, back to the procedural figure, with nothing in the
 *    console.
 *
 * Both are baked ONCE, here, at load, rather than at each of the four merge
 * sites. `_crowdBodyGeo` is called once per variant, so mutating a cached
 * geometry at the merge site would `uvScale` the same buffer three times over
 * and stretch the third variant's cloth to nothing. The geometries handed back
 * are ready to merge and must not be mutated further - which is also why a
 * pack of variants costs one copy of this file rather than four.
 */

/**
 * Part keys the loader will accept.
 *
 * The allow-list is the point, exactly as it is for ship, hero and beast
 * parts: a part whose key nothing recognises would be merged into a mesh
 * chosen by accident, which renders as a crowd wearing its shoes on its head.
 * A name outside this list is dropped with one warning instead of guessed at.
 *
 * Kept in step with `scripts/make-crowd-glb.mjs` by `crowd-assets.test.mjs`.
 */
export const CROWD_PART_KEYS = Object.freeze(['hair', 'collar', 'hand', 'shoe']);

/**
 * The only two surfaces the crowd draws in.
 *
 * `body` is `M.crowd` (garment, `vertexColors: true`, tinted per instance from
 * the coat palette) and `skin` is `M.skin` (flesh, tinted per instance from
 * the skin-tone pool, no vertex colours). A part bound to anything else would
 * need a material of its own, which is the shader program this whole design
 * exists not to spend. Refused at load, loudly.
 */
export const CROWD_SLOTS = Object.freeze(['body', 'skin']);

/** Session cache: asset id -> { key -> BufferGeometry }, uv- and colour-baked. */
let _assets = null;
/** Set id -> { asset, parts[] }, from the manifest. */
let _sets = null;
/** Part key -> { slot, shade, uv }, from the manifest. */
let _bind = null;
/** In-flight load, so a re-entered build shares one fetch. */
let _loading = null;
/** Failure keys already logged - each distinct failure warns once per session. */
const _warned = new Set();

function warnOnce(key, message) {
  if (_warned.has(key)) return;
  _warned.add(key);
  console.warn(`CrowdAssets: ${message} - falling back to the procedural crowd`);
}

/**
 * How long any one request here may take before it is abandoned.
 *
 * Same reasoning as the ship, hero and beast loaders', and the same number. A
 * connection that neither answers nor errors is not a failure path - `fetch`
 * simply never settles - and this load sits inside the station's build, which
 * is the boot of the game for most players. Without a bound, a stalled socket
 * is a loading screen that never finishes and no error anywhere. It is a
 * deadlock bound, not a performance bound: 36 KB over a phone link must not be
 * cancelled into a worse crowd.
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
export function loadCrowdAssets() {
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
 * The authored parts for one set, split by the slot they merge into - a
 * SYNCHRONOUS read of whatever `loadCrowdAssets` has already resolved.
 *
 * `null` is not an error. It is the procedural crowd, which is what every
 * headless test measures and what a player with a failed download gets.
 *
 * Geometries are NOT cloned. The consumer merges them into its own buffers and
 * never mutates or owns them - see the header on why that is safe and why it
 * matters when four variants share one copy.
 *
 * @param {string} set one of the manifest's `sets` keys ('standing'|'seated')
 * @returns {{body: object[], skin: object[]}|null}
 */
export function crowdParts(set) {
  const spec = _sets?.[set];
  if (!spec) return null;
  const bag = _assets?.[spec.asset];
  if (!bag) return null;
  const out = { body: [], skin: [] };
  for (const key of spec.parts) {
    const geometry = bag[key];
    if (!geometry) continue; // one missing part is not a missing crowd
    const b = _bind?.[key];
    if (!b || !out[b.slot]) continue;
    out[b.slot].push(geometry);
  }
  return (out.body.length || out.skin.length) ? out : null;
}

/** Every set the manifest knows, for tests and for the build-side mapping. */
export function crowdSets() {
  return _sets ? Object.keys(_sets) : [];
}

async function loadAll() {
  /* BASE_URL, not '/': the built game mounts under /game/ and a hard-coded
   * absolute path is the bug the whole URL shape exists to prevent. Guarded so
   * the module stays importable under plain Node (no import.meta.env). */
  const base = (import.meta.env && import.meta.env.BASE_URL) || '/';
  const dir = `${base}assets/station/`;

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
    if (!CROWD_SLOTS.includes(b?.slot)) {
      /* Loud, and the whole manifest is refused. A part in an unknown slot
       * cannot be merged into anything the crowd already draws, so honouring
       * it would mean a new mesh and a new material - the one cost this design
       * exists to avoid, and one that would be invisible in a screenshot. */
      warnOnce('bind', `part '${key}' binds to slot '${b?.slot}', which the crowd draws no mesh for`);
      _sets = null;
      _bind = null;
      return {};
    }
    if (b.slot === 'body' && !(b.shade > 0)) {
      warnOnce('shade', `body part '${key}' has no shade - M.crowd reads vertex colours and would draw it black`);
      _sets = null;
      _bind = null;
      return {};
    }
  }

  /* One loader for the batch, imported lazily so the glTF parser only ever
   * downloads on a session that actually reaches a world with authored assets.
   * Vite splits it into its own chunk, which the ship, hero and beast loaders
   * already pull, so on most sessions this import resolves from cache. */
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
   * `warnOnce`, so one 404 costs exactly one set and one warning, and
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
 * transform baked in, its uv rescaled and - for body parts only - a constant
 * vertex colour written at the manifest's shade.
 *
 * The glTF MATERIAL is deliberately never touched - see the header.
 */
function namedParts(gltf, id) {
  const out = {};
  gltf.scene.updateMatrixWorld(true);
  gltf.scene.traverse((o) => {
    if (!o.isMesh || !o.geometry) return;
    const key = o.name;
    if (!CROWD_PART_KEYS.includes(key)) {
      warnOnce(`part:${id}:${key}`, `asset '${id}' has a mesh named '${key}', which is not a part key`);
      return;
    }
    const b = _bind?.[key];
    if (!b) return;
    const geo = o.geometry;
    if (!geo.index) {
      /* `mergeGeometries` will not mix indexed and non-indexed inputs, and the
       * crowd's own primitives are all indexed. A non-indexed part would take
       * out the whole variant it landed in, presenting as an entire body
       * variant missing from the plaza rather than as an error. */
      warnOnce(`unindexed:${id}:${key}`, `asset '${id}' part '${key}' is not indexed`);
      return;
    }
    geo.applyMatrix4(o.matrixWorld);
    bakeCrowdPart(geo, b);
    geo.name = `station.crowd.${id}.${key}`;
    out[key] = geo;
  });
  return out;
}

/**
 * Give one authored part the uv density and the attribute set the geometry it
 * merges into already has.
 *
 * Exported so `crowd-assets.test.mjs` can run the SHIPPED bake rather than a
 * copy of it. A test that reimplemented this would pass happily while the
 * loader wrote the colour attribute onto the wrong slot, and the symptom of
 * that - the whole merge returning null and the crowd silently reverting to
 * the procedural figure - is invisible in every number a budget gate records.
 *
 * @param {THREE.BufferGeometry} geo mutated in place
 * @param {{slot:string, shade?:number, uv?:number}} bind the manifest entry
 */
export function bakeCrowdPart(geo, bind) {
  uvScale(geo, bind.uv ?? 1, bind.uv ?? 1);
  if (bind.slot === 'body') {
    /* Constant shade, exactly as the crowd's own `put()` bakes one. It
     * multiplies the per-instance garment colour, so hair at 0.26 is a dark
     * version of that figure's own coat - see the generator header for why
     * that constraint was accepted rather than worked around. */
    const n = geo.getAttribute('position').count;
    const col = new Float32Array(n * 3);
    col.fill(bind.shade);
    geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
  }
  return geo;
}

/** Session teardown for tests. The game never calls this. */
export function resetCrowdAssets() {
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
 * `_crowdBodyGeo` that merges authored features is the arm every player sees
 * on the entry world - so it has to be testable without a browser. The test
 * parses the real committed `.glb` off disk, bakes the same uv and shade this
 * loader bakes, and hands it in here, which is as close to the shipped path as
 * a test can stand.
 *
 * @param {{assets:object, sets:object, bind:object}} m
 */
export function installCrowdAssets(m) {
  _assets = m.assets ?? null;
  _sets = m.sets ?? null;
  _bind = m.bind ?? null;
  _loading = null;
}
