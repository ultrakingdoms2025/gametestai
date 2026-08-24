/**
 * Lazy loader for the planet surfaces' authored ejecta block.
 *
 * ── WHY THIS OBJECT AND NOT SOMETHING ELSE ON TEN PLANETS ─────────────────
 *
 * `boulders` is the most-used prop family in the game. Thirteen fields across
 * nine of the ten planets, **8,880 instances**, 177,600 triangles - 44% of all
 * the prop geometry the ten surfaces draw between them - and every one of the
 * thirteen fields declares `collide: true`, which is the descriptor stating on
 * the record that a body meets these.
 *
 * All 8,880 of them are `IcosahedronGeometry(1, 0)`.
 *
 * Photographed on Cinder from seven metres - which is where a player meets one -
 * the largest ejecta block measured **mean luma 29.4 over its own interior,
 * 87.6% of its pixels under 48/255, Sobel edge energy 2.87**: three or four
 * facets across the whole of a 1600 px frame, each one an unbroken flat value,
 * with a hard UV seam down the middle of the lit one. It reads as a piece of
 * masonry, not as a rock.
 *
 * The triangle count is not the fault. Twenty triangles is a reasonable budget
 * for a thing that exists 1,100 times on one planet. The faults are that it is
 * a REGULAR CONVEX SOLID - so every boulder in the game has the same twenty
 * faces meeting five-at-a-vertex in the same pattern, and the per-instance
 * tumble rotates a symmetry rather than changing a silhouette - and that its
 * UVs are the polyhedron's spherical ones, which pinch at the poles and carry a
 * wrap seam straight down the front of the lit face.
 *
 * ── THE COST RULE, WHICH IS THE WHOLE DESIGN ──────────────────────────────
 *
 * The authored block REPLACES the primitive inside the field's own
 * `InstancedMesh`. It does not add a bucket. So:
 *
 *   no new renderable, no new instanced mesh, no new draw call,
 *   no new material, no new shader program, no new light, no new collider.
 *
 * That is a stronger position than the belt's hero rock could take - see
 * `space/BeltAssets.js`, which had to buy a fourth bucket because it wanted
 * hero detail for 44 rocks out of 260. Here every boulder in the game is the
 * same case, so there is nothing to partition and nothing to pay for.
 *
 * Which boulders use it is therefore not a threshold anybody invented: it is
 * `kind === 'boulders'`, the descriptor's own word for what the thing is.
 * `scripts/tests/planet-assets.test.mjs` asserts the drawn set is the field's
 * whole instance set, off a real planet.
 *
 * ── DEGRADATION, WHICH IS THE NORMAL PATH ─────────────────────────────────
 *
 * `blockGeometry()` returning null is what happens in the whole `node --test`
 * suite (no `fetch`, no DOM), on any deploy where the file is missing, and in
 * any session where the fetch times out. In all three `buildPropField` builds
 * the icosahedron it always built, at the same twenty triangles, in the same
 * places, with the same colliders. `planet-assets.test.mjs` builds a field both
 * ways and asserts that the placement, the instance matrices and the collider
 * boxes are identical and that only the geometry moves.
 *
 * Shaped after `space/BeltAssets.js` and `dock/YardAssets.js` by intent rather
 * than by accident: manifest, lazy `GLTFLoader`, an abort signal, one warning
 * per distinct failure, and a synchronous cache read that returns null rather
 * than throwing.
 */

/**
 * The one legal mesh name in the file, and it is a PROP KIND rather than a
 * material key.
 *
 * Every prop family on every planet draws in one shared material -
 * `PlanetWorld._propMaterial`, one clone of `stone.castle:1.4` per planet - so
 * naming a part for its material would name all of them the same thing and say
 * nothing. What the name has to carry here is which `geometryFor` branch the
 * part stands in for, because that is the switch the loader is wired into.
 */
export const BLOCK_PART_KEY = 'boulders';

/**
 * How many of the icosahedron's twenty faces get split into four.
 *
 * Published from here rather than typed into the generator so the loader, the
 * generator, the manifest and the test cannot drift, and stated as a count of
 * SPLITS rather than as a triangle total because the point of the number is
 * that the facets come out UNEQUAL:
 *
 *   0 splits   20 triangles. The count the icosahedron already cost, so the
 *              substitution is free in every axis the budget measures. A
 *              noise-displaced, plane-sheared body at twenty triangles is
 *              already a different OBJECT from a regular one, because what
 *              made the shipped rock read as a die was its regularity and its
 *              spherical UVs, not its budget.
 *   8 splits   58 triangles - NOT 44. Splitting a face into four puts a
 *              midpoint on each of its three edges, and the neighbour across
 *              each of those edges has to close against it or the body has a
 *              hole in it, so eight red faces drag green refinement into their
 *              neighbours. +38 per instance is +26,400 on Cinder: 13.8% of
 *              that world's whole triangle count.
 *   20 splits  80 triangles, `IcosahedronGeometry(1, 1)`'s count, and every
 *              facet is the same size again - which is the thing being fixed.
 *
 * ── AND IT IS ZERO, DECIDED BY THE STOPPING RULE RATHER THAN BY TASTE ─────
 *
 * Both arms were built and photographed on the same two boulders from the same
 * cameras. `tall-three-quarter` is the framing most favourable to the extra
 * triangles that exists in this world: seven metres from the tallest ejecta
 * block on Cinder, filling a 1600 x 900 frame. Whole-frame, 20 against 58:
 *
 *     mean luma  30.07 -> 29.33      Sobel edge energy  1.48 -> 1.45
 *
 * A 0.03 change in edge energy, in the one shot built to flatter it, for
 * +13.8% of the world's triangles every frame. `art-space`'s experiment
 * protocol is "adopt only if the pixels move"; they do not, so this is
 * REFUSED and written down rather than shipped. The pairs are in
 * `docs/superpowers/specs/img/2026-08-23-art-planets/`.
 */
export const BLOCK_SPLITS = 0;

/**
 * Triangles the authored block is allowed to reach - the EXACT expected count,
 * not a round ceiling, so that a tessellation change cannot pass unnoticed.
 *
 * It is not `20 + 3 * splits`, and the arithmetic is worth writing down because
 * the naive figure is what the first version of this file carried. Splitting a
 * face into four puts a midpoint on each of its three edges, and the face on
 * the other side of each of those edges has to close against it or the body has
 * a hole in it - so a red face drags green refinement into up to three
 * neighbours. Measured off `buildBlock`, which is where the count comes from:
 *
 *   splits  0   2   3   4   6   8  12
 *   tris   20  32  36  42  50  58  72
 */
export const BLOCK_TRI_BUDGET = 20;

/**
 * The radial envelope the authored block must stay inside.
 *
 * `IcosahedronGeometry(1, 0)` reaches exactly 1.0 at its twelve vertices, and
 * `buildPropField`'s boulder collider is `max(sx, sz2) * 0.8` - so the shipped
 * rock already spills a quarter of its own radius outside its own collider at
 * the corners. That is a pre-existing trade (a collider wider than the drawn
 * thing is an invisible wall, which is the worse error) and this asset is not
 * allowed to make it worse. The generator refuses a vertex outside this, and
 * `planet-assets.test.mjs` re-checks it against the committed bytes.
 */
export const BLOCK_R_MAX = 1.0;

/** And a floor, so a noise seed cannot pinch the body into a spike. */
export const BLOCK_R_MIN = 0.5;

/** Session cache: the parsed block geometry, or null once a load has failed. */
let _block = null;
/** In-flight load, so ten planets in one session share one fetch. */
let _loading = null;
/** True once `loadPlanetAssets` has settled, however it settled. */
let _settled = false;
/** Failure keys already logged - each distinct failure warns once per session. */
const _warned = new Set();

function warnOnce(key, message) {
  if (_warned.has(key)) return;
  _warned.add(key);
  console.warn(`PlanetAssets: ${message} - falling back to the procedural boulder`);
}

/**
 * How long any one request here may take before it is abandoned.
 *
 * The same deadlock bound, for the same reason, as the ship, hero, beast, yard
 * and belt loaders'. A connection that neither answers nor errors is not a
 * failure path - `fetch` simply never settles - and this load sits inside
 * `PlanetWorld.build`, behind a loading screen. Without a bound, a stalled
 * socket is a descent that never finishes and no error anywhere.
 */
const FETCH_TIMEOUT_MS = 12000;

const timeoutSignal = () =>
  (typeof AbortSignal !== 'undefined' && AbortSignal.timeout
    ? AbortSignal.timeout(FETCH_TIMEOUT_MS)
    : undefined);

/**
 * Load the manifest and the authored block. Resolves even when the file is
 * absent - the cache stays null and every planet draws the icosahedron, which
 * is what the whole headless suite measures. Never rejects.
 */
export function loadPlanetAssets() {
  if (_settled) return Promise.resolve(_block);
  if (_loading) return _loading;
  _loading = loadAll().then((geo) => {
    _block = geo;
    _settled = true;
    _loading = null;
    return geo;
  });
  return _loading;
}

/**
 * The authored block geometry, or null - a SYNCHRONOUS read of whatever
 * `loadPlanetAssets` has already resolved.
 *
 * Null is not an error. It is the icosahedron; see the header.
 *
 * The geometry is NOT cloned here. `buildPropField` clones at the call site,
 * because thirteen fields across ten planets each hand their geometry to an
 * `InstancedMesh` that disposes it, and a second visit to a planet would
 * otherwise instance a disposed buffer.
 *
 * @returns {object|null} a THREE.BufferGeometry, or null
 */
export function blockGeometry() {
  return _block;
}

async function loadAll() {
  /* BASE_URL, not '/': the built game mounts under /game/. Guarded so the
   * module stays importable under plain Node, which
   * `scripts/make-planet-glb.mjs` relies on - it imports the constants above. */
  const base = (import.meta.env && import.meta.env.BASE_URL) || '/';
  const dir = `${base}assets/planets/`;

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
    .find((a) => a?.id === 'ejecta-block');
  if (!entry) {
    warnOnce('manifest-shape', 'manifest declares no `ejecta-block` asset');
    return null;
  }
  if (entry.kind !== 'geometry') {
    warnOnce('kind', `asset 'ejecta-block' has unhandled kind '${entry.kind}'`);
    return null;
  }

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
    warnOnce('asset', `could not load 'ejecta-block' (${entry.file}: ${e.message})`);
    return null;
  }
}

/**
 * The one mesh in the file whose name is the prop kind, with its node transform
 * baked in.
 *
 * The glTF MATERIAL is deliberately never touched. Every prop on a planet draws
 * in `planet.<id>.rock`, which is one clone of a library material per planet,
 * and an authored block that brought its own PBR material would be a new
 * program family on every one of ten world loads.
 */
function namedPart(gltf) {
  let out = null;
  gltf.scene.updateMatrixWorld(true);
  gltf.scene.traverse((o) => {
    if (out || !o.isMesh || !o.geometry) return;
    if (o.name !== BLOCK_PART_KEY) {
      warnOnce(`part:${o.name}`,
        `the asset has a mesh named '${o.name}', which is not a prop kind this loader wires`);
      return;
    }
    const geo = o.geometry;
    if (!geo.attributes.uv) {
      /* The generator always writes TEXCOORD_0, and unlike the belt's rock this
       * one is drawn with a material that carries an albedo, a normal and an
       * ORM map. A file that arrives without UVs would render every facet
       * sampling texel (0,0) - one flat colour over the whole field, and no
       * error anywhere. */
      warnOnce('unwrapped', 'the asset carries no UVs and the prop material is textured');
      return;
    }
    geo.applyMatrix4(o.matrixWorld);
    geo.name = 'planet.authored.ejecta-block';
    out = geo;
  });
  if (!out) warnOnce('empty', 'no usable mesh in the asset scene');
  return out;
}

/** Session teardown for tests. The game never calls this. */
export function resetPlanetAssets() {
  _block = null;
  _loading = null;
  _settled = false;
  _warned.clear();
}

/**
 * Install a resolved geometry directly, for tests and headless rigs.
 *
 * There is no fetch in `node --test` and no DOM to hang one on, and the arm of
 * `buildPropField` that uses authored geometry is the arm the player sees - so
 * it has to be testable without a browser. `planet-assets.test.mjs` parses the
 * real committed `.glb` off disk and hands it in here.
 *
 * @param {object|null} geometry a THREE.BufferGeometry, or null to force the
 *        procedural arm
 */
export function installPlanetAssets(geometry) {
  _block = geometry ?? null;
  _settled = true;
  _loading = null;
}
