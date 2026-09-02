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
 *
 * ── THE ESCAPE HATCH, WHICH IS OFF, AND WHY IT EXISTS ─────────────────────
 *
 * The material rule above is also this pipeline's ceiling. A part that cannot
 * bring its own material cannot bring its own textures, its own `alphaTest` or
 * its own morph targets - so an authored FACE, alpha-cut HAIR CARDS and
 * EXPRESSION SHAPES are all unreachable through this loader, and those three
 * are the entire distance between these characters and the target.
 * `docs/character-pipeline.md` is the decision document; this is its one seam.
 *
 * An asset entry may declare `"own": ["<partKey>", ...]`. A part named there
 * keeps its glTF material, handed to the consumer as `material` on the
 * `heroParts()` record. NOTHING DECLARES IT TODAY: every part still comes back
 * with `material: null`, `HumanoidFactory` welds exactly what it welded before,
 * and the station's program count is untouched. Three properties make this a
 * mechanism rather than a speculation:
 *
 *  1. THE BUDGET IS ENFORCED HERE, NOT IN REVIEW. `HERO_OWN_PROGRAM_BUDGET`
 *     caps the programs the own-material set may add, counted from the same
 *     fields `WebGLPrograms.getParameters` reads. Over budget, every own
 *     material is dropped with one warning and the parts weld as before.
 *
 *     The cap is small because the exchange rate is brutal and already
 *     measured in this repo: `Humanoid.js:455-488` records six rim tuples
 *     costing six programs of byte-identical GLSL, differing in ONE cache-key
 *     field. And the counting rule is the one thing worth internalising -
 *     three keys on the material's TYPE and the SET OF MAP SLOTS BOUND, never
 *     on colours or on which texture is in the slot. So the cost is per
 *     material SIGNATURE and does not scale with the cast: one authored face
 *     material shared by all 166 named characters is one program.
 *
 *  2. AN OWN PART STILL DECLARES A SLOT AND A BONE. The degrade path is
 *     therefore always complete - over budget, or read by a consumer that
 *     ignores `material`, the character is exactly the one that ships today.
 *     Same discipline as every other failure here: never a hole, always the
 *     procedural character.
 *
 *  3. MORPH TARGETS ARE TRANSFORMED OR REFUSED. `BufferGeometry.applyMatrix4`
 *     moves `position`/`normal`/`tangent` and NOT `morphAttributes` (three
 *     0.185.1). `namedParts` bakes the node transform in, so an authored hero
 *     carrying blendshapes under a non-identity node would have had its base
 *     mesh moved and its deltas left behind in the authoring node's space -
 *     silent, and visible only as a face that tears when it smiles.
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

/**
 * How many shader programs the whole own-material set may add, across every
 * asset and every role.
 *
 * Four, because that is one complete authored hero and no more: an opaque face
 * signature, a garment signature, an alpha-cut hair signature, and the one
 * extra DEPTH program the alpha-cut hair takes. Its own morph targets ride
 * inside those signatures and cost nothing further - `morphTargetsCount` is a
 * key field, so shapes only cost when SOME characters have them and others do
 * not, which the welded path never does.
 *
 * The number is deliberately not "the margin under the current pin". The
 * station sits at 144 against a pin of 142 +/- 4, so the slack is 2 and an
 * authored hero does not fit in it; this cap says what the feature costs so
 * the pin can be moved on purpose, once, with the reason written down - rather
 * than drifting upward one part at a time. @see docs/character-pipeline.md
 */
export const HERO_OWN_PROGRAM_BUDGET = 4;

/** Session cache: asset id -> { key -> BufferGeometry }. */
let _assets = null;
/** Asset id -> { key -> Material }, for parts the manifest names in `own`. */
let _ownMats = null;
/** The distinct program signatures `_ownMats` holds. Empty while nothing opts in. */
let _ownSig = [];
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
 * `material` is the escape hatch, and it is null for every part today. When it
 * is NOT null the manifest asked for this part to keep its authored material; a
 * consumer that understands that draws the part itself, and a consumer that
 * does not welds it into `slot` exactly as before. Both are correct characters,
 * which is the point of carrying `slot` on an own-material part at all.
 *
 * @param {string} role one of the manifest's `roles` keys
 * @returns {{key:string, slot:number, bone:string, geometry:object,
 *            material:object|null}[]|null}
 */
export function heroParts(role) {
  const spec = _roles?.[role];
  if (!spec) return null;
  const set = _assets?.[spec.asset];
  if (!set) return null;
  const mats = _ownMats?.[spec.asset] ?? null;
  const out = [];
  for (const key of spec.parts) {
    const geometry = set[key];
    if (!geometry) continue; // one missing part is not a missing character
    out.push({
      key, slot: _slots[key], bone: _bones[key], geometry,
      material: mats?.[key] ?? null,
    });
  }
  return out.length ? out : null;
}

/**
 * The distinct program signatures the admitted own-material set carries.
 *
 * Exported so the budget is a number something can READ - a test, a console, a
 * future gate - rather than a claim in a comment. Empty while nothing opts in,
 * and empty after a set is refused for being over budget.
 *
 * @returns {string[]}
 */
export function heroOwnSignatures() {
  return _ownSig.slice();
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
  const own = {};
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
      const keep = ownKeys(entry);
      const { geometries, materials } = namedParts(gltf, entry.id, keep);
      if (!Object.keys(geometries).length) throw new Error('no usable mesh in scene');
      out[entry.id] = geometries;
      if (Object.keys(materials).length) own[entry.id] = materials;
    } catch (e) {
      warnOnce(`asset:${entry.id}`, `could not load asset '${entry.id}' (${entry.file}: ${e.message})`);
    }
  }));
  admitOwnMaterials(own);
  return out;
}

/**
 * The part keys an asset entry asks to keep their own material, validated.
 *
 * A key that is not a part key, or that has no slot and bone of its own, is
 * refused: without the fallback the over-budget and unaware-consumer paths
 * would leave a hole in the character instead of the welded part they are
 * supposed to leave. @see the header, property 2.
 */
function ownKeys(entry) {
  const list = Array.isArray(entry?.own) ? entry.own : null;
  if (!list || !list.length) return null;
  const keep = new Set();
  for (const key of list) {
    if (!HERO_PART_KEYS.includes(key)) {
      warnOnce(`own:${entry.id}:${key}`, `asset '${entry.id}' declares own material for '${key}', which is not a part key`);
      continue;
    }
    if (_slots?.[key] === undefined || _bones?.[key] === undefined) {
      warnOnce(`own-fallback:${entry.id}:${key}`,
        `part '${key}' keeps its own material but declares no slot/bone to fall back to`);
      continue;
    }
    keep.add(key);
  }
  return keep.size ? keep : null;
}

/**
 * A SUPERSET of three's program cache key, restricted to the fields a loaded
 * glTF material can vary.
 *
 * Same discipline, and the same reason, as `previewProgramKey` in
 * `gfx/PreviewWarm.js`: over-splitting costs one imaginary program in an
 * accounting number, under-splitting lets a real program in under the budget.
 * When in doubt, add a component.
 *
 * What is deliberately ABSENT is as informative as what is present. Colour,
 * texture identity, roughness, metalness and every other scalar are uniforms:
 * `WebGLPrograms.getParameters` reads which map SLOTS are bound, not what is in
 * them, so a hundred authored faces sharing one material layout are one program.
 */
function materialSignature(m) {
  if (!m) return '';
  const on = (v) => (v ? 1 : 0);
  return [
    m.type,
    on(m.map), on(m.normalMap), on(m.roughnessMap), on(m.metalnessMap),
    on(m.aoMap), on(m.emissiveMap), on(m.alphaMap), on(m.bumpMap),
    on(m.displacementMap), on(m.lightMap), on(m.envMap),
    on(m.alphaTest > 0), on(m.transparent), on(m.vertexColors), on(m.flatShading),
    m.side,
    on((m.sheen ?? 0) > 0), on((m.clearcoat ?? 0) > 0),
    on((m.transmission ?? 0) > 0), on((m.iridescence ?? 0) > 0),
    on((m.anisotropy ?? 0) > 0),
    /* Not a scalar: `morphTargetsCount` is a NUMBER in the cache key, so eight
     * shapes and four shapes are two programs even on one material. */
    `morph${m.userData?.heroMorphCount ?? 0}`,
    /* Last field of three's key. A material with an `onBeforeCompile` and no
     * constant key of its own defaults to the FUNCTION SOURCE, which is a
     * program per closure - the bug `Humanoid.js:478-488` documents. */
    typeof m.customProgramCacheKey === 'function' ? String(m.customProgramCacheKey()) : '',
  ].join('|');
}

/**
 * Does this material force three to clone the shared depth material, and so
 * pay a SECOND program in the shadow pass?
 *
 * `WebGLShadowMap.getDepthMaterial` (three 0.185.1, ~line 430) shares one
 * `_depthMaterial` instance across every opaque material in the scene, and
 * clones only for this list. Alpha-cut hair is the case that matters: it is the
 * whole reason the budget is 4 and not 3.
 */
function needsOwnDepth(m) {
  return !!m && (
    (m.alphaTest > 0 && (m.map || m.alphaMap))
    || (m.displacementMap && m.displacementScale !== 0)
    || m.alphaToCoverage === true
  );
}

/**
 * Admit the own-material set if it fits the budget, or drop all of it.
 *
 * All-or-nothing on purpose. Admitting the cheap half of an over-budget set
 * would ship a character wearing an authored face over a welded jaw, which is
 * worse than either whole answer and much harder to see in a screenshot.
 */
function admitOwnMaterials(own) {
  _ownMats = null;
  _ownSig = [];
  const ids = Object.keys(own);
  if (!ids.length) return;

  const sigs = new Set();
  let depth = 0;
  for (const id of ids) {
    for (const m of Object.values(own[id])) {
      sigs.add(materialSignature(m));
      if (needsOwnDepth(m)) depth = 1;
    }
  }
  const programs = sigs.size + depth;
  if (programs > HERO_OWN_PROGRAM_BUDGET) {
    warnOnce('own-budget',
      `the own-material set would add ${programs} shader programs`
      + ` (${sigs.size} material signature${sigs.size === 1 ? '' : 's'}`
      + `${depth ? ' plus a shadow-depth variant' : ''}) against a budget of`
      + ` ${HERO_OWN_PROGRAM_BUDGET} - every authored material was dropped and`
      + ' its part welded instead');
    return;
  }
  _ownMats = own;
  _ownSig = [...sigs];
}

/**
 * Every mesh in the file whose name is a known part key, with its node
 * transform baked in.
 *
 * The glTF MATERIAL is deliberately never touched, EXCEPT for the parts the
 * manifest named in `own` - see the header. `keep` is null on every asset that
 * ships today, so `materials` comes back empty and this function does what it
 * has always done.
 *
 * @param {object} gltf @param {string} id @param {Set<string>|null} keep
 * @returns {{geometries: object, materials: object}}
 */
function namedParts(gltf, id, keep = null) {
  const geometries = {};
  const materials = {};
  gltf.scene.updateMatrixWorld(true);
  gltf.scene.traverse((o) => {
    if (!o.isMesh || !o.geometry) return;
    const key = o.name;
    if (!HERO_PART_KEYS.includes(key)) {
      warnOnce(`part:${id}:${key}`, `asset '${id}' has a mesh named '${key}', which is not a part key`);
      return;
    }
    const geo = o.geometry;
    const morphs = bakeMorphTransform(geo, o.matrixWorld, id, key);
    geo.applyMatrix4(o.matrixWorld);
    geo.name = `npc.authored.${id}.${key}`;
    geometries[key] = geo;
    if (keep?.has(key) && o.material && !Array.isArray(o.material)) {
      /* The shape count travels ON the material because that is where the
       * signature is read, and because three keys the program on the pair -
       * one material drawn at two shape counts is two programs. */
      o.material.userData = { ...(o.material.userData ?? {}), heroMorphCount: morphs };
      materials[key] = o.material;
    }
  });
  return { geometries, materials };
}

/**
 * Move a part's morph deltas into the same space its base mesh is about to be
 * moved into, or drop them.
 *
 * `BufferGeometry.applyMatrix4` transforms `position`, `normal` and `tangent`
 * and NOTHING ELSE (three 0.185.1). Since this loader bakes the node transform
 * into the geometry, an authored blendshape under a rotated or scaled node
 * would otherwise be left in the authoring node's space while its base moved -
 * a face that tears the moment it is driven, with no warning anywhere.
 *
 * Relative targets are deltas, so they take the linear part of the matrix and
 * not its translation; absolute targets are positions and take all of it.
 * Anything this cannot reason about is DROPPED rather than guessed at, which
 * costs the expression and keeps the character.
 *
 * @returns {number} shapes surviving, which is what the program key counts
 */
function bakeMorphTransform(geo, matrix, id, key) {
  const targets = geo.morphAttributes?.position;
  if (!Array.isArray(targets) || !targets.length) return 0;
  const e = matrix.elements;
  const relative = geo.morphTargetsRelative === true;
  for (const attr of targets) {
    if (!attr?.array || attr.itemSize !== 3 || attr.isInterleavedBufferAttribute) {
      warnOnce(`morph:${id}:${key}`,
        `asset '${id}' part '${key}' carries a morph target this loader cannot transform`
        + ' - its shapes were dropped');
      geo.morphAttributes = {};
      return 0;
    }
  }
  for (const attr of targets) {
    const a = attr.array;
    for (let i = 0; i < a.length; i += 3) {
      const x = a[i];
      const y = a[i + 1];
      const z = a[i + 2];
      /* Column-major, same layout `Vector3.applyMatrix4` reads. The `w` divide
       * is skipped: a glTF node matrix is affine, so w is 1 by construction. */
      a[i]     = e[0] * x + e[4] * y + e[8]  * z + (relative ? 0 : e[12]);
      a[i + 1] = e[1] * x + e[5] * y + e[9]  * z + (relative ? 0 : e[13]);
      a[i + 2] = e[2] * x + e[6] * y + e[10] * z + (relative ? 0 : e[14]);
    }
    attr.needsUpdate = true;
  }
  return targets.length;
}

/** Session teardown for tests. The game never calls this. */
export function resetHeroAssets() {
  _assets = null;
  _ownMats = null;
  _ownSig = [];
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
 * `ownMaterials` goes through the same budget gate the fetch path uses, so a
 * rig cannot install a set the game would have refused - the whole value of a
 * loader-enforced cap is that there is exactly one place it is checked.
 *
 * @param {{assets:object, roles:object, slots:object, bones:object,
 *          ownMaterials?:object}} m
 */
export function installHeroAssets(m) {
  _assets = m.assets ?? null;
  _roles = m.roles ?? null;
  _slots = m.slots ?? null;
  _bones = m.bones ?? null;
  _loading = null;
  admitOwnMaterials(m.ownMaterials ?? {});
}
