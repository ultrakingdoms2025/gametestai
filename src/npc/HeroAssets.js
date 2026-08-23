/**
 * Lazy loader for the authored hero-character features.
 *
 * The station's eleven referenced roles - four attackers and seven fixed
 * interactive characters - get authored geometry for the handful of features
 * that separate an ape from the procedural human `Humanoid` builds: a crested
 * cranium, a brow shelf, a muzzle, ears, knuckled hands, and the kit they wear.
 * Everything else about them stays procedural. See `scripts/make-npc-glb.mjs`
 * for what is authored and, more usefully, for what deliberately is not.
 *
 * This file is a near-copy of `src/ships/ShipAssets.js` by intent rather than
 * by accident: that is the pipeline decision D4 names as "already proven
 * twice", and a third variant of it invented from scratch would be a third set
 * of failure modes to discover. Manifest, lazy `GLTFLoader`, parallel fetches
 * with an abort signal, per-asset `try`/`catch`, one warning per distinct
 * failure, and a synchronous cache read that returns null rather than throwing.
 *
 * ── THE MATERIAL RULE, WHICH IS THE WHOLE POINT ───────────────────────────
 *
 * The glTF material is never read. Every part is drawn with one of the six
 * character material slots the `Humanoid` already owns - skin, primary,
 * secondary, leather, metal, glow - and which slot is a manifest field.
 *
 * That is not tidiness. Three keys its shader-program cache on the material
 * configuration, this project boots by warming the cartesian product of those
 * programs, and TODO-V4 items 2/4/5 record what happens to boot time when that
 * product grows. Eleven roles that each brought their own PBR material would
 * be dozens of new programs on the station's warm-up. Reusing the slots costs
 * exactly zero.
 *
 * ── AND WHY THE PARTS ARE NOT MESHES ──────────────────────────────────────
 *
 * The obvious implementation is to parent each part to a bone as its own
 * `THREE.Mesh`. That was measured and rejected: the station carries ~68 hero
 * characters, and ten bone-parented meshes each is ~680 extra draw calls
 * against a frame that draws about 2,000. Instead the parts are handed to
 * `HumanoidFactory` and welded into the character's own merged `SkinnedMesh`,
 * rigidly skinned to the bone the manifest names, in the material group the
 * slot names. The cost is therefore triangles and nothing else - no draw call,
 * no material, no program, no extra scene node.
 */

/**
 * Part keys the loader will accept.
 *
 * The allow-list is the point, exactly as it is for ship parts: a part whose
 * key nothing recognises would be welded into a material group chosen by
 * accident, which renders as a character wearing its belt for a face. A name
 * outside this list is dropped with one warning instead of guessed at.
 *
 * Kept in step with `scripts/make-npc-glb.mjs` by `npc-assets.test.mjs`.
 */
export const HERO_PART_KEYS = Object.freeze([
  'cranium', 'brow', 'muzzle', 'fangs', 'ear', 'eyeGlow',
  'pauldron', 'harness', 'harnessGlow', 'spineSpikes', 'armSpikes',
  'collar', 'backpack', 'chestRig', 'chestLamp', 'belt', 'boot', 'knuckle',
]);

/** Bones a part may be skinned to. Anything else is a typo in the manifest. */
export const HERO_BONES = Object.freeze([
  'head', 'neck', 'spine02', 'spine03', 'clavicleR', 'clavicleL',
  'foreArmR', 'foreArmL', 'handR', 'handL', 'pelvis', 'footR', 'footL',
]);

/** Session cache: asset id -> { key -> BufferGeometry }. */
let _assets = null;
/** Role id -> { asset, parts[] }, from the manifest. */
let _roles = null;
/** Part key -> material slot index, and part key -> bone name. */
let _slots = null;
let _bones = null;
/** In-flight load, so concurrent spawns share one fetch. */
let _loading = null;
/** Failure keys already logged - each distinct failure warns once per session. */
const _warned = new Set();

function warnOnce(key, message) {
  if (_warned.has(key)) return;
  _warned.add(key);
  console.warn(`HeroAssets: ${message} - falling back to the procedural character`);
}

/**
 * How long any one request here may take before it is abandoned.
 *
 * Same reasoning as the ship loader's, and the same number. A connection that
 * neither answers nor errors is not a failure path - `fetch` simply never
 * settles - and this load sits on the station's NPC spawn. Without a bound, a
 * stalled socket is a station with no characters in it and no error anywhere.
 * It is a deadlock bound, not a performance bound: 264 KB over a phone link
 * must not be cancelled into a worse character.
 */
const FETCH_TIMEOUT_MS = 12000;

const timeoutSignal = () =>
  (typeof AbortSignal !== 'undefined' && AbortSignal.timeout
    ? AbortSignal.timeout(FETCH_TIMEOUT_MS)
    : undefined);

/**
 * Load every asset the manifest declares. Resolves even when files are absent -
 * the resolved map simply lacks the entry and every character built from it is
 * the procedural one. Never rejects.
 */
export function loadHeroAssets() {
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
 * The authored parts for one role, or null - a SYNCHRONOUS read of whatever
 * `loadHeroAssets` has already resolved.
 *
 * Null is not an error. It is the procedural character, which is what every
 * headless test measures and what a player with a failed download gets.
 *
 * Geometries are NOT cloned here, unlike `shipParts`. The consumer
 * (`HumanoidFactory`) copies vertices out of them into a merged buffer and
 * never mutates or owns them, and the merged result is itself cached per
 * archetype - so one clone per character would be pure garbage.
 *
 * @param {string} role one of the manifest's `roles` keys
 * @returns {{key:string, slot:number, bone:string, geometry:object}[]|null}
 */
export function heroParts(role) {
  const spec = _roles?.[role];
  if (!spec) return null;
  const set = _assets?.[spec.asset];
  if (!set) return null;
  const out = [];
  for (const key of spec.parts) {
    const geometry = set[key];
    if (!geometry) continue; // one missing part is not a missing character
    out.push({ key, slot: _slots[key], bone: _bones[key], geometry });
  }
  return out.length ? out : null;
}

/** Every role the manifest knows, for tests and for the spawn-side mapping. */
export function heroRoles() {
  return _roles ? Object.keys(_roles) : [];
}

async function loadAll() {
  /* BASE_URL, not '/': the built game mounts under /game/ and a hard-coded
   * absolute path is the bug the whole URL shape exists to prevent. Guarded so
   * the module stays importable under plain Node (no import.meta.env). */
  const base = (import.meta.env && import.meta.env.BASE_URL) || '/';
  const dir = `${base}assets/npc/`;

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
  _roles = manifest.roles ?? null;
  _slots = manifest.slots ?? null;
  _bones = manifest.bones ?? null;
  if (!_roles || !_slots || !_bones) {
    warnOnce('manifest-shape', 'manifest is missing roles/slots/bones');
    return {};
  }

  /* One loader for the batch, imported lazily so the glTF parser only ever
   * downloads on the first station build of a session. Vite splits it into its
   * own chunk, which the ship loader already pulls, so on most sessions this
   * import resolves from cache. Hoisted above the fetches so the chunk
   * download overlaps them rather than sitting between them. */
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
   * `warnOnce`, so one 404 costs exactly one asset and one warning, and
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
    if (!HERO_PART_KEYS.includes(key)) {
      warnOnce(`part:${id}:${key}`, `asset '${id}' has a mesh named '${key}', which is not a part key`);
      return;
    }
    const geo = o.geometry;
    geo.applyMatrix4(o.matrixWorld);
    geo.name = `npc.authored.${id}.${key}`;
    out[key] = geo;
  });
  return out;
}

/** Session teardown for tests. The game never calls this. */
export function resetHeroAssets() {
  _assets = null;
  _roles = null;
  _slots = null;
  _bones = null;
  _loading = null;
  _warned.clear();
}

/**
 * Install a resolved asset map directly, for tests and headless rigs.
 *
 * There is no fetch in `node --test` and no DOM to hang one on, and the arm of
 * `HumanoidFactory.create` that welds authored features is the arm the player
 * sees - so it has to be testable without a browser. The test parses the real
 * committed .glb off disk and hands it in here, which is as close to the
 * shipped path as a test can stand.
 *
 * @param {{assets:object, roles:object, slots:object, bones:object}} m
 */
export function installHeroAssets(m) {
  _assets = m.assets ?? null;
  _roles = m.roles ?? null;
  _slots = m.slots ?? null;
  _bones = m.bones ?? null;
  _loading = null;
}
