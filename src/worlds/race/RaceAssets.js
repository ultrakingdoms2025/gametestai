/**
 * Lazy loader for the race world's two authored hero assets.
 *
 * ── WHY THESE TWO AND NOTHING ELSE ON A 1.3 KM MAP ───────────────────────
 *
 * The architecture was measured before anything was authored. Race builds
 * **453 renderables from 29 materials**, already merged by material per
 * district plus **129 tiled `InstancedMesh` systems** - the citadel/dock
 * shape, not the sports one. There is no draw-call win available in it and
 * none was attempted. What the measurement leaves is the two objects a player
 * gets close to, and both were photographed at conversational distance before
 * a vertex was written.
 *
 *   1. **The spectator.** 819 of them - 615 on Vellum's grandstand, 102 on
 *      each of the other two - and at 144 triangles each they are the SECOND
 *      largest object in the world: 102,384 triangles in a frame taken from
 *      the start/finish straight, 12.6% of everything drawn. They are also a
 *      lofted cone with a sphere on it: 1.22 m tall, no shoulders, no arms, no
 *      legs. And the defect that outranks the silhouette - body and head are
 *      merged into ONE geometry drawn with `vertexColors: false` and handed
 *      ONE `setColorAt`, so **the head is painted the shirt colour.** A
 *      spectator in a green shirt has a green head. All 819 do.
 *
 *   2. **The marshal post.** 29 of them, one every 150 m, and each is three
 *      batched boxes: a riveted crate, a lid, and a hazard band that is 0.2 m
 *      deep drawn at the crate's own centre inside a solid 2.6 m deep. 93% of
 *      that band's surface is buried. The 7% that renders is a 5 cm tab on
 *      each END of the post, side-on to the road, so from a car it has never
 *      been visible at all. It is the citadel's window recesses again:
 *      arithmetic that reads perfectly and has never produced a pixel.
 *
 * ── THE COST RULE, WHICH IS THE WHOLE DESIGN ─────────────────────────────
 *
 * Neither asset adds a bucket. The spectator's four parts are merged into ONE
 * geometry here and handed to the `race:crowd` `InstancedMesh` the world
 * already builds; the marshal's three parts are named for RACE MATERIAL KEYS
 * and go into the `trackside.<id>` `Batch` bucket of that key, which is a mesh
 * the world already draws.
 *
 *   no new renderable, no new instanced mesh, no new draw call,
 *   no new shader program, no new light, no new collider.
 *
 * Materials move by ONE, downward. Carrying a per-part shade needs
 * `vertexColors`, and the crowd's `paint.enamel|novc` clone was the only
 * material in the scene with that configuration - so the crowd joins the
 * shared `race.paint.enamel` every batched mesh in the world already uses and
 * the world draws 28 materials instead of 29.
 *
 * ── DEGRADATION, WHICH IS THE NORMAL PATH ────────────────────────────────
 *
 * `spectatorGeometry()` and `marshalParts()` returning null is what happens in
 * the whole `node --test` suite (no `fetch`, no DOM), on any deploy where the
 * files are missing, and in any session where a fetch times out. In all three
 * the world builds exactly what it built before: the swept cone for the crowd,
 * the three `B.box` calls for the post, in the same places with the same
 * colliders. `race-assets.test.mjs` builds both ways and asserts that only the
 * geometry moves.
 *
 * The one thing the fallback may NOT skip is the colour attribute. The crowd
 * now draws with a `vertexColors: true` material, and a geometry with no
 * colour attribute under `vertexColors` reads as ZERO and renders BLACK rather
 * than untinted - the trap `RaceWorld.Batch.add` already carries a comment
 * about. So `RaceWorld._spawnCrowd` writes white into the procedural
 * prototype, and the test asserts it.
 *
 * Shaped after `planets/PlanetAssets.js`, `space/BeltAssets.js` and
 * `dock/YardAssets.js` by intent rather than by accident: manifest, lazy
 * `GLTFLoader`, an abort signal, one warning per distinct failure, and a
 * synchronous cache read that returns null rather than throwing.
 */

/**
 * The spectator's parts and the VALUE each is drawn at, published from here so
 * the loader, the generator, the manifest and the test cannot drift.
 *
 * These are multipliers on the per-instance shirt colour, not colours. One
 * `InstancedMesh`, one material, one `setColorAt` per figure means no part of
 * this figure can have a hue the shirt does not have, and that constraint was
 * accepted rather than paid off: a second `InstancedMesh` per grandstand for
 * skin is +3 renderables and +3 draw calls on a budget whose whole instruction
 * is that renderables do not move.
 *
 * So the head is HAIR at 0.30 - a dark version of your own coat colour is what
 * dark hair looks like, and it varies person to person for free - and the face
 * is the one part above 1.0, a pale warm patch under a dark fringe.
 * `RaceWorld`'s shirt palette is desaturated to match, because 0.30 of a fully
 * saturated primary is not hair, it is the same primary in shadow.
 */
export const SPECTATOR_PARTS = Object.freeze({
  torso: 0.98,
  head: 0.30,
  face: 1.34,
  legs: 0.44,
});

/**
 * The exact triangle count of the authored spectator, which is EXACTLY the
 * count of the primitive it replaces.
 *
 * `_spawnCrowd` merges `sweep([4 sections], 8) + blob(0.12, 0.14, 0.12, 0,
 * 1.08, 0, 8)` into 144 triangles and instances it 819 times. A first draft of
 * this figure came out at 276, which is +108,108 world-wide and +11.9% on a
 * measured frame, for background crowd; it was refused and this is the budget
 * that replaced it. Eighty of the shipped 144 - more than half the figure -
 * are an eight-by-eight sphere used as a head, and re-spending those eighty on
 * shoulders, arms and legs costs nothing at all.
 */
export const SPECTATOR_TRIS = 144;

/** Overall height of the authored figure, in metres. The shipped cone is 1.22. */
export const SPECTATOR_HEIGHT = 1.70;

/**
 * The marshal's mesh names, which ARE race material keys.
 *
 * The loader reads the name off the mesh, discards the glTF material unread,
 * and `RaceWorld._buildTrackside` hands the geometry to the `Batch` bucket of
 * that key. A key the world has no material for is not a wrong colour:
 * `Batch.flush` would build `new THREE.Mesh(merged, undefined)`, and three
 * fills that in with a default white `MeshBasicMaterial` - a new draw call, a
 * new material and a new shader program, silently, on the one thing this
 * design exists to prevent. So the loader refuses a name it does not know and
 * the world falls back to boxes.
 */
export const MARSHAL_PART_KEYS = Object.freeze(['metal.panel', 'metal.trim', 'hazard.stripe']);

/**
 * The post's footprint, which is the collider's footprint.
 *
 * 3.2 m along X, 2.6 m along Z, 2.6 m tall, origin on the ground at the centre
 * of the footprint - exactly `B.box('metal.panel', 3.2, 2.6, 2.6, x, y + 1.3,
 * z, yaw)`. The authored post may add a platform, a rail and a roof outside
 * that box, all of which are things a driver can already see through, but it
 * may not move the SHELL, because `_buildTrackside` places a collider on the
 * shell and art does not move collision.
 */
export const MARSHAL_SHELL = Object.freeze({ hx: 1.6, hz: 1.3, h: 2.6 });

/** Triangles the authored post is allowed to reach, exactly. */
export const MARSHAL_TRIS = 204;

/** Session cache. */
let _spectator = null;
/** @type {Record<string, object>|null} */
let _marshal = null;
let _loading = null;
let _settled = false;
const _warned = new Set();

function warnOnce(key, message) {
  if (_warned.has(key)) return;
  _warned.add(key);
  console.warn(`RaceAssets: ${message} - falling back to the procedural build`);
}

/**
 * How long any one request here may take before it is abandoned.
 *
 * The same deadlock bound, for the same reason, as the ship, hero, beast,
 * yard, belt and planet loaders'. A connection that neither answers nor errors
 * is not a failure path - `fetch` simply never settles - and this load sits
 * inside `RaceWorld.build`, behind a loading screen. Without a bound, a
 * stalled socket is a lap that never starts and no error anywhere.
 */
const FETCH_TIMEOUT_MS = 12000;

const timeoutSignal = () =>
  (typeof AbortSignal !== 'undefined' && AbortSignal.timeout
    ? AbortSignal.timeout(FETCH_TIMEOUT_MS)
    : undefined);

/**
 * Load the manifest and both assets. Resolves even when they are absent - the
 * caches stay null and the world builds what it always built. Never rejects.
 */
export function loadRaceAssets() {
  if (_settled) return Promise.resolve({ spectator: _spectator, marshal: _marshal });
  if (_loading) return _loading;
  _loading = loadAll().then((out) => {
    _spectator = out.spectator;
    _marshal = out.marshal;
    _settled = true;
    _loading = null;
    return out;
  });
  return _loading;
}

/**
 * The authored spectator, as ONE geometry carrying a baked `color` attribute -
 * a SYNCHRONOUS read of whatever `loadRaceAssets` has already resolved.
 *
 * Null is not an error. It is the swept cone; see the header.
 *
 * The geometry is NOT cloned here. `_spawnCrowd` clones at the call site,
 * because three grandstands each hand their geometry to an `InstancedMesh`
 * that disposes it, and a second visit to the world would otherwise instance a
 * disposed buffer.
 *
 * @returns {object|null} a THREE.BufferGeometry, or null
 */
export function spectatorGeometry() {
  return _spectator;
}

/**
 * The authored marshal post, as one geometry per RACE MATERIAL KEY, or null.
 * @returns {Record<string, object>|null}
 */
export function marshalParts() {
  return _marshal;
}

async function loadAll() {
  /* BASE_URL, not '/': the built game mounts under /game/. Guarded so the
   * module stays importable under plain Node, which
   * `scripts/make-race-glb.mjs` relies on - it imports the constants above. */
  const base = (import.meta.env && import.meta.env.BASE_URL) || '/';
  const dir = `${base}assets/race/`;
  const none = { spectator: null, marshal: null };

  if (typeof fetch !== 'function') return none;

  let manifest;
  try {
    const res = await fetch(`${dir}manifest.json`, { signal: timeoutSignal() });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    manifest = await res.json();
  } catch (e) {
    warnOnce('manifest', `could not load ${dir}manifest.json (${e.message})`);
    return none;
  }

  let THREE;
  let mergeGeometries;
  let loader;
  try {
    THREE = await import('three');
    ({ mergeGeometries } = await import('three/addons/utils/BufferGeometryUtils.js'));
    const { GLTFLoader } = await import('three/examples/jsm/loaders/GLTFLoader.js');
    loader = new GLTFLoader();
  } catch (e) {
    warnOnce('loader', `could not load the glTF parser (${e.message})`);
    return none;
  }

  const assets = Array.isArray(manifest?.assets) ? manifest.assets : [];
  const parse = async (id) => {
    const entry = assets.find((a) => a?.id === id);
    if (!entry) {
      warnOnce(`manifest:${id}`, `manifest declares no '${id}' asset`);
      return null;
    }
    if (entry.kind !== 'geometry') {
      warnOnce(`kind:${id}`, `asset '${id}' has unhandled kind '${entry.kind}'`);
      return null;
    }
    try {
      const res = await fetch(dir + entry.file, { signal: timeoutSignal() });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const gltf = await loader.parseAsync(await res.arrayBuffer(), dir);
      return namedParts(gltf, id);
    } catch (e) {
      warnOnce(`asset:${id}`, `could not load '${id}' (${entry.file}: ${e.message})`);
      return null;
    }
  };

  const [specParts, marshal] = await Promise.all([parse('spectator'), parse('marshal')]);
  return {
    spectator: specParts ? mergeSpectator(THREE, mergeGeometries, specParts) : null,
    marshal: marshal && MARSHAL_PART_KEYS.every((k) => marshal[k]) ? marshal : null,
  };
}

/**
 * Every mesh in the file, by name, with its node transform baked in.
 *
 * The glTF MATERIAL is deliberately never touched. Both assets draw in
 * materials the world already has - `race.paint.enamel` for the crowd,
 * `race.metal.panel` / `race.metal.trim` / `race.hazard.stripe` for the post -
 * and an asset that brought its own PBR material would be a new program family
 * on every world load.
 *
 * @returns {Record<string, object>|null}
 */
function namedParts(gltf, id) {
  const legal = id === 'spectator' ? Object.keys(SPECTATOR_PARTS) : MARSHAL_PART_KEYS;
  const out = {};
  gltf.scene.updateMatrixWorld(true);
  gltf.scene.traverse((o) => {
    if (!o.isMesh || !o.geometry) return;
    if (!legal.includes(o.name)) {
      warnOnce(`part:${id}:${o.name}`,
        `'${id}' has a mesh named '${o.name}', which is not a part this loader wires`);
      return;
    }
    if (!o.geometry.attributes.uv) {
      /* The generator always writes TEXCOORD_0, and both of these draw with
       * materials that carry an albedo, a normal and an ORM map. A file that
       * arrived without UVs would render every facet sampling texel (0,0) -
       * one flat colour over the whole crowd, and no error anywhere. */
      warnOnce(`unwrapped:${id}:${o.name}`, `'${id}.${o.name}' carries no UVs`);
      return;
    }
    const geo = o.geometry;
    geo.applyMatrix4(o.matrixWorld);
    geo.name = `race.authored.${id}.${o.name}`;
    out[o.name] = geo;
  });
  const missing = legal.filter((k) => !out[k]);
  if (missing.length) {
    warnOnce(`empty:${id}`, `'${id}' is missing part(s) ${missing.join(', ')}`);
    return null;
  }
  return out;
}

/**
 * Merge the spectator's four parts into one geometry, baking each part's shade
 * into a `color` attribute.
 *
 * This is where the green head is actually fixed, and it costs nothing at
 * runtime: the merge happens once at load, into geometry that was going to be
 * uploaded anyway, and the attribute multiplies the `setColorAt` the world
 * already writes. The alternative - a second `InstancedMesh` for the head - is
 * +3 renderables and +3 draw calls.
 */
function mergeSpectator(THREE, mergeGeometries, parts) {
  const list = [];
  for (const [key, shade] of Object.entries(SPECTATOR_PARTS)) {
    const g = parts[key].index ? parts[key].toNonIndexed() : parts[key];
    /* `mergeGeometries` returns null the moment two inputs disagree about
     * which attributes exist, so everything unexpected has to go and the
     * colour has to go on ALL of them. */
    for (const k of Object.keys(g.attributes)) {
      if (k !== 'position' && k !== 'normal' && k !== 'uv') g.deleteAttribute(k);
    }
    const n = g.attributes.position.count;
    const col = new Float32Array(n * 3);
    col.fill(shade);
    g.setAttribute('color', new THREE.BufferAttribute(col, 3));
    list.push(g);
  }
  const merged = mergeGeometries(list, false);
  for (const g of list) g.dispose();
  if (!merged) {
    warnOnce('merge', 'the spectator parts could not be merged');
    return null;
  }
  merged.name = 'race.authored.spectator';
  return merged;
}

/** Session teardown for tests. The game never calls this. */
export function resetRaceAssets() {
  _spectator = null;
  _marshal = null;
  _loading = null;
  _settled = false;
  _warned.clear();
}

/**
 * Install resolved geometry directly, for tests and headless rigs.
 *
 * There is no fetch in `node --test` and no DOM to hang one on, and the arm of
 * `_spawnCrowd` and `_buildTrackside` that uses authored geometry is the arm
 * the player sees - so it has to be testable without a browser.
 * `race-assets.test.mjs` parses the real committed `.glb` files off disk and
 * hands them in here.
 *
 * @param {{spectator?:object|null, marshal?:Record<string,object>|null}} [g]
 */
export function installRaceAssets(g = {}) {
  _spectator = g.spectator ?? null;
  _marshal = g.marshal ?? null;
  _settled = true;
  _loading = null;
}

/**
 * Merge four already-parsed spectator parts, for the test rig.
 *
 * The shade bake is the whole point of the asset, so a test that parses the
 * `.glb` itself must go through the same code the browser does rather than
 * through a copy of it.
 */
export function mergeSpectatorParts(THREE, mergeGeometries, parts) {
  return mergeSpectator(THREE, mergeGeometries, parts);
}
