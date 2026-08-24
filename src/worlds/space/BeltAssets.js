/**
 * Lazy loader for Halberd Reach's authored hero boulder.
 *
 * The belt is the one thing in open space a player flies INTO rather than at,
 * and its largest rocks are the only geometry out here that is ever seen from
 * a few hundred metres. They shipped as `IcosahedronGeometry(1, 1)` — eighty
 * triangles — and photographed at 900 m the biggest of them measured mean luma
 * 4.9 with 99.6% of its pixels under 48/255 and a mean Sobel edge energy of
 * 5.5 across 700 px of screen: a black twenty-facet die. See
 * `scripts/make-belt-glb.mjs` for what is authored instead, and for the two
 * separate faults that measurement was hiding.
 *
 * This file is a near-copy of `src/worlds/dock/YardAssets.js` by intent rather
 * than by accident: that is the pipeline decision D4 names as already proven,
 * and a sixth variant of it invented from scratch would be a sixth set of
 * failure modes to discover. Manifest, lazy `GLTFLoader`, an abort signal,
 * per-asset `try`/`catch`, one warning per distinct failure, and a synchronous
 * cache read that returns null rather than throwing.
 *
 * ── THE MATERIAL RULE, WHICH IS THE WHOLE POINT ───────────────────────────
 *
 * The glTF material is never read. **A mesh's NAME is the belt material key it
 * is drawn with**, exactly as it is for the yard's hull sections and the ship
 * hulls. There is one such key, because after this pass there is one belt
 * material: `Belt` built three byte-identical `MeshStandardMaterial`s, one per
 * silhouette, and now shares a single named instance across every bucket.
 *
 *   no new material, no new shader program, no new light.
 *
 * It does cost one renderable, one instanced mesh and one draw call, because
 * an `InstancedMesh` carries exactly one geometry and hero detail for the
 * forty-four rocks that need it cannot come out of the two hundred and sixteen
 * that do not without taking a silhouette away from the field. `Belt.js`
 * argues for three distinct small silhouettes with a reason; the fourth bucket
 * is the honest price, and the shared material pays it back twice over.
 *
 * ── DEGRADATION, WHICH IS NOT A THEORETICAL BRANCH ────────────────────────
 *
 * `heroGeometry()` returning null is the NORMAL path in three places: the
 * whole `node --test` suite (no `fetch`, no DOM), any deploy where the file is
 * missing, and any session where the fetch times out. In all three `Belt`
 * builds exactly the field it built before this pass — three procedural
 * silhouettes, 260 rocks, 20,800 triangles, three draw calls — and the only
 * difference a player sees is the one this pass could not lose, the albedo
 * fix, which lives in `Belt.js` and needs no asset at all.
 *
 * `scripts/tests/belt-assets.test.mjs` builds the belt BOTH ways and asserts
 * the difference is triangles and one bucket, and nothing else.
 */

/**
 * The one belt material key, and therefore the one legal mesh name in the file.
 *
 * `Belt` names its shared material `space:belt:rock`; this is the short key the
 * asset uses, the way the yard's parts are named `plate` / `steel` rather than
 * `yard:plate`. `belt-assets.test.mjs` holds the two against each other.
 */
export const BELT_PART_KEY = 'rock';

/**
 * `IcosahedronGeometry` detail for the hero rock — `20 * (detail + 1)^2`
 * triangles, so 4 is 500.
 *
 * Published from here rather than typed in the generator so the loader, the
 * generator and the manifest cannot drift. Why 500 and not 80 or 1280:
 *
 *   80    what shipped. On a 336 m boulder at 900 m that is one facet per
 *         78 x 78 pixels, and no feature smaller than a facet can exist -
 *         which is to say no craters.
 *   500   one facet per ~39 x 39 px at that framing, and a 0.4 rad crater
 *         covers twenty-odd of them, which is enough for a bowl with a rim.
 *   1280  detail 7. Better, and 56,320 triangles across the 44 hero rocks
 *         instead of 22,000 - a 39% rise in this world's whole triangle
 *         count to sharpen an object the player passes at 200 m/s.
 *
 * The middle one is the one that survives a screenshot and a budget together.
 */
export const HERO_DETAIL = 4;

/**
 * Hard ceiling on the authored rock, enforced by the generator and again by
 * the test against the committed bytes. It is `20 * (HERO_DETAIL + 1)^2` and
 * not a round number on purpose: a budget that is not the exact expected value
 * cannot tell you that the tessellation changed.
 */
export const HERO_TRI_BUDGET = 20 * (HERO_DETAIL + 1) * (HERO_DETAIL + 1);

/** Session cache: the parsed hero geometry, or null once a load has failed. */
let _hero = null;
/** In-flight load, so two builds of this world share one fetch. */
let _loading = null;
/** True once `loadBeltAssets` has settled, however it settled. */
let _settled = false;
/** Failure keys already logged - each distinct failure warns once per session. */
const _warned = new Set();

function warnOnce(key, message) {
  if (_warned.has(key)) return;
  _warned.add(key);
  console.warn(`BeltAssets: ${message} - falling back to the procedural rock`);
}

/**
 * How long any one request here may take before it is abandoned.
 *
 * Same reasoning as the ship, hero, beast and yard loaders', and the same
 * number. A connection that neither answers nor errors is not a failure path -
 * `fetch` simply never settles - and this load sits inside `SpaceWorld.build`,
 * in front of a loading screen. Without a bound, a stalled socket is a world
 * that never finishes building and no error anywhere. It is a deadlock bound,
 * not a performance bound.
 */
const FETCH_TIMEOUT_MS = 12000;

const timeoutSignal = () =>
  (typeof AbortSignal !== 'undefined' && AbortSignal.timeout
    ? AbortSignal.timeout(FETCH_TIMEOUT_MS)
    : undefined);

/**
 * Load the manifest and the hero asset. Resolves even when the file is absent —
 * the cache simply stays null and the belt is the procedural field, which is
 * what the whole headless suite measures. Never rejects.
 */
export function loadBeltAssets() {
  if (_settled) return Promise.resolve(_hero);
  if (_loading) return _loading;
  _loading = loadAll().then((geo) => {
    _hero = geo;
    _settled = true;
    _loading = null;
    return geo;
  });
  return _loading;
}

/**
 * The authored hero geometry, or null — a SYNCHRONOUS read of whatever
 * `loadBeltAssets` has already resolved.
 *
 * Null is not an error. It is the procedural field; see the header.
 *
 * The geometry is NOT cloned. `Belt` hands it straight to one `InstancedMesh`
 * and disposes that mesh's geometry in `dispose()`, so a second build of this
 * world would use a disposed buffer — which is why `Belt` clones at the call
 * site and this comment says so twice.
 *
 * @returns {object|null} a THREE.BufferGeometry, or null
 */
export function heroGeometry() {
  return _hero;
}

async function loadAll() {
  /* BASE_URL, not '/': the built game mounts under /game/ and a hard-coded
   * absolute path is the bug the whole URL shape exists to prevent. Guarded so
   * the module stays importable under plain Node (no import.meta.env), which
   * `scripts/make-belt-glb.mjs` relies on - it imports the constants above. */
  const base = (import.meta.env && import.meta.env.BASE_URL) || '/';
  const dir = `${base}assets/space/`;

  if (typeof fetch !== 'function') return null;

  let manifest;
  try {
    const res = await fetch(`${dir}manifest.json`, { signal: timeoutSignal() });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    manifest = await res.json();
  } catch (e) {
    warnOnce('manifest', `could not load ${dir}manifest.json (${e.message})`);
    return null;
  }

  const entry = (Array.isArray(manifest?.assets) ? manifest.assets : [])
    .find((a) => a?.id === 'reach-boulder');
  if (!entry) {
    warnOnce('manifest-shape', 'manifest declares no `reach-boulder` asset');
    return null;
  }
  if (entry.kind !== 'geometry') {
    warnOnce('kind', `asset 'reach-boulder' has unhandled kind '${entry.kind}'`);
    return null;
  }

  /* Imported lazily so the glTF parser only ever downloads on the first entry
   * into open space in a session. Vite splits it into its own chunk, which the
   * ship loader already pulls, so in practice this resolves from cache. */
  let loader = null;
  try {
    const { GLTFLoader } = await import('three/examples/jsm/loaders/GLTFLoader.js');
    loader = new GLTFLoader();
  } catch (e) {
    warnOnce('loader', `could not load the glTF parser (${e.message})`);
    return null;
  }

  try {
    const res = await fetch(dir + entry.file, { signal: timeoutSignal() });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const buf = await res.arrayBuffer();
    const gltf = await loader.parseAsync(buf, dir);
    return namedPart(gltf);
  } catch (e) {
    warnOnce('asset', `could not load 'reach-boulder' (${entry.file}: ${e.message})`);
    return null;
  }
}

/**
 * The one mesh in the file whose name is the belt material key, with its node
 * transform baked in.
 *
 * The glTF MATERIAL is deliberately never touched — see the header.
 */
function namedPart(gltf) {
  let out = null;
  gltf.scene.updateMatrixWorld(true);
  gltf.scene.traverse((o) => {
    if (out || !o.isMesh || !o.geometry) return;
    if (o.name !== BELT_PART_KEY) {
      warnOnce(`part:${o.name}`,
        `the asset has a mesh named '${o.name}', which is not the belt material key`);
      return;
    }
    const geo = o.geometry;
    if (!geo.index) {
      /* The generator always writes an index. A file that arrives without one
       * came from somewhere else, and an `InstancedMesh` over a non-indexed
       * buffer silently costs one vertex per index for the whole field. */
      warnOnce('unindexed', 'the asset is not indexed');
      return;
    }
    geo.applyMatrix4(o.matrixWorld);
    geo.name = 'belt.authored.reach-boulder';
    out = geo;
  });
  if (!out) warnOnce('empty', 'no usable mesh in the asset scene');
  return out;
}

/** Session teardown for tests. The game never calls this. */
export function resetBeltAssets() {
  _hero = null;
  _loading = null;
  _settled = false;
  _warned.clear();
}

/**
 * Install a resolved geometry directly, for tests and headless rigs.
 *
 * There is no fetch in `node --test` and no DOM to hang one on, and the arm of
 * `Belt._build` that uses authored geometry is the arm the player sees — so it
 * has to be testable without a browser. `belt-assets.test.mjs` parses the real
 * committed `.glb` off disk and hands it in here, which is as close to the
 * shipped path as a test can stand.
 *
 * @param {object|null} geometry a THREE.BufferGeometry, or null to force the
 *        procedural arm
 */
export function installBeltAssets(geometry) {
  _hero = geometry ?? null;
  _settled = true;
  _loading = null;
}
