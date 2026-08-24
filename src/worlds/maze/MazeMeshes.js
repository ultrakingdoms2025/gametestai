import * as THREE from 'three';
import {
  extentClass, quantiseExtent, PREFAB_BUDGET, treadOutline,
  chamferFor, contactShade, CONTACT_AO,
} from './MazeProfiles.js';
/* Which asset id backs which kind - constants only; nothing here triggers a
 * fetch, so importing this module stays free for headless tests. The actual
 * loading is MazeAssets.loadMazeAssets(), awaited by MazeWorld.build. */
import { MAZE_ASSET_PREFABS } from './MazeAssets.js';

/* Re-exported so a caller needs one import for "how the maze turns a descriptor
 * into geometry". The numbers live in MazeProfiles.js because they are pure and
 * belong in a file that can be reasoned about without a renderer; this is the
 * seam that gives them a THREE object. */
export { extentClass, quantiseExtent, PREFAB_BUDGET };

/**
 * The maze's geometry prefab registry: `(kind, extent class, LOD) -> geometry`.
 *
 * ## What this file is for
 *
 * Until now a maze visual was LITERALLY its collider: `buildBoxInstances` took
 * a unit cube and scaled it by the descriptor's half-extents, so the drawn
 * surface and the physics box were the same object seen twice. That is why the
 * world is made of boxes, and it is also why it could not stop being: a 4 cm
 * chamfer authored on a unit cube comes out 19 cm along a hedge segment's long
 * axis and 2 cm across its thin one, which reads as a mistake rather than as a
 * bevel. Detail authored in a unit cube's frame is detail at the mercy of
 * whatever the instance matrix does to it.
 *
 * So the extents move INTO the geometry and out of the matrix. The registry
 * hands back a geometry already built at world scale, and the instance matrix
 * carries translation only. Everything a later task wants to author - bevels,
 * a stair nosing, baked contact AO on the lower edges - is then authored in
 * metres and stays the size it was authored at, on every instance, everywhere
 * in the world.
 *
 * ## The rule that keeps every headless proof in the repo valid
 *
 * A prefab built for half-extents (hx, hy, hz) has its bounding box contained
 * in [-hx,hx] x [-hy,hy] x [-hz,hz], and the instance matrix carries no scale.
 * A visual that is a SUBSET of its descriptor cannot create a standable surface
 * the enclosure proof, the anti-ladder band scan, the perforation gate and the
 * containment flood fill never saw - so all of them survive by construction
 * rather than by being re-run against pixels they cannot see. A visual that
 * OVERHANGS is the opposite: a surface the player's eye trusts, the physics
 * denies, and no existing gate measures. `scripts/tests/maze-prefabs.test.mjs`
 * asserts the containment directly, which is cheaper than any of the proofs it
 * stands in for.
 *
 * ## Why the cache is shared and not per district
 *
 * A district holds about 800 hedge segments and there are 25-43 resident. A
 * registry that allocated per descriptor would hold ~20,000 BufferGeometries
 * and `renderer.info.memory.geometries` would climb with every district
 * streamed in - the exact leak this is a registry rather than a factory to
 * avoid. The maze has very few distinct box sizes (see `PREFAB_BUDGET`, which
 * is measured), so sharing collapses that to ~150 for the entire world.
 *
 * Sharing has one consequence and it is easy to get wrong: **a district
 * evicting its meshes must not dispose their geometry**, because the district
 * next door is still drawing with it. `isPrefab` exists so `MazeChunks.drop`
 * can ask rather than assume, and `releasePrefabs` is the one moment - world
 * teardown, when no district is resident - at which the geometries do go.
 * That release is not optional housekeeping: this world RE-ROLLS its seed on
 * every entry, and a new seed brings a new set of floor-slab spans, so a cache
 * that never emptied would grow by a few dozen geometries per visit forever.
 *
 * ## Where the shapes come from, and where the boxes went
 *
 * Task 1 landed this registry emitting the same boxes as before, so that when
 * a prefab first changed shape the difference had exactly one place it could
 * have come from. Task 2 was that change: the `stair` kind now builds real
 * tread carpentry at LOD0 (see `buildStairPrefab`). Every other kind, and
 * every stair beyond LOD0, is still the plain box.
 *
 * This is also where a future reader will look for the `?art=v2` flag the
 * phase plan puts around every task. There is none, still: the box path did
 * not go away, it became the higher LODs of the same registry - `prefabFor`
 * at lod 2 IS `art=box` - so the A/B the flag existed to provide is already
 * one argument away, without threading a URL param through `Config.js` to
 * gate a second copy of a code path the LOD axis keeps alive anyway.
 */

/**
 * The kinds that are DRESSING: drawn, batched and cached like everything
 * else, but never emitted by `districtColliders` - `MazeChunks.ensure`
 * synthesises them alongside the collider descriptors, mesh only. That is
 * the whole basis of their exemption from the fit contract, stated here as
 * `dressing: true` rather than implied by absence from a test's kind list:
 * a visual with NO collider descriptor cannot disagree with physics about a
 * surface, because physics never heard of it. `newel` (Task 8) is the first
 * kind to actually spend the exemption - an authored glTF refitted into its
 * dressing box by `buildAssetPrefab` - though in practice the refit keeps it
 * inside the box anyway, so the exemption stays headroom rather than debt.
 */
export const DRESSING_KINDS = Object.freeze({
  footing: true, plate: true, candle: true, newel: true, sprig: true,
});

/**
 * The sprig's dressing box, and the ONE place its size is written.
 *
 * Exactly the `BoxGeometry(0.5, 0.5, 0.5)` that `MazeChunks.buildSprigInstances`
 * used to allocate per district. Every scale in `MazeFoliage` - the hedge
 * growth's `(s, 1.4s, s)` and the ivy leaf's flattening onto a wall normal -
 * is expressed against that half-metre cube, so the authored tuft is authored
 * to the same bounding box and this commit changes SHAPE and nothing else.
 *
 * Routing the sprig through the registry rather than through a `new
 * THREE.BoxGeometry` inside the instancer is not only how the authored file
 * gets adopted: it also stops the world allocating and disposing one
 * identical box geometry PER RESIDENT DISTRICT (twenty-one of them at the
 * entrance, rebuilt on every residency change), because `MazeChunks` already
 * skips `dispose()` for anything `isPrefab` owns.
 */
export const SPRIG_HALF = Object.freeze({ hx: 0.25, hy: 0.25, hz: 0.25 });

/**
 * The shared geometry every sprig instance - hedge growth and shaft ivy alike
 * - is drawn with: the authored leaf tuft when `MazeAssets` resolved it, the
 * procedural box when it did not.
 *
 * @param {{[id:string]: import('three').BufferGeometry}|null} [assets]
 * @returns {THREE.BufferGeometry} cached - callers must never dispose it
 */
export function sprigGeometry(assets = null) {
  return prefabFor({ kind: 'sprig', ...SPRIG_HALF, assets });
}

/** `${kind}:${extentClass}:${lod}[:asset]` -> geometry. */
const _prefabs = new Map();
/** The same geometries by identity, so `isPrefab` is a lookup and not a scan. */
const _owned = new Set();

/**
 * The shared geometry for one descriptor, built at world scale.
 *
 * `assets` is the map `MazeAssets.loadMazeAssets()` resolved - when it holds
 * a geometry for this kind's asset id, that geometry (refitted, see
 * `buildAssetPrefab`) becomes the prefab; otherwise the procedural builder
 * runs exactly as before. Asset-backed entries take a distinct cache key so
 * a build that raced ahead of the load (or a headless test with no assets at
 * all) can never pin the fallback into a slot the authored version owns.
 *
 * @param {{kind:string, hx:number, hy:number, hz:number, lod?:number,
 *          assets?: {[id:string]: THREE.BufferGeometry}|null}} desc
 * @returns {THREE.BufferGeometry} cached - callers must never dispose it
 */
export function prefabFor({ kind, hx, hy, hz, lod = 0, assets = null }) {
  const gLod = geometryLod(kind, lod);
  const assetId = MAZE_ASSET_PREFABS[kind];
  const src = (assetId && assets) ? assets[assetId] : undefined;
  const key = `${kind}:${extentClass(hx, hy, hz)}:${gLod}${src ? ':asset' : ''}`;
  const hit = _prefabs.get(key);
  if (hit) return hit;

  const qx = quantiseExtent(hx);
  const qy = quantiseExtent(hy);
  const qz = quantiseExtent(hz);
  const g = src ? buildAssetPrefab(src, qx, qy, qz, kind) : buildPrefab(kind, qx, qy, qz, gLod);
  g.name = `prefab:${key}`;
  _prefabs.set(key, g);
  _owned.add(g);
  return g;
}

/**
 * The kinds whose LOD0 prefab is the chamfered box of `buildChamferPrefab` -
 * Task 4's full six: hedge, floor, shaftWall, gate, slideWall, footing.
 *
 * `hedge` and `footing` spent Task 4-6 deferred out of this set, by
 * measurement: with no LOD swap, every resident instance rendered LOD0, and
 * at the worst case (seed 2026, 43 districts from (1200, 18.05, 1200)) those
 * two kinds are ~17,000 instances EACH - bevelling them measured 8.56 M
 * triangles against the 5 M budget, +32 tris/instance multiplied ~3.6x by
 * the shadow passes. Task 7's per-district distance swap is what made them
 * affordable: only the districts within `LOD0_RANGE` draw this prefab now
 * (~8-12 of 43 at the measured worst cases), and everything further draws
 * the 12-triangle box exactly as it did during the deferral. The headless
 * ledger of that trade lives in `scripts/tests/maze-lod.test.mjs`.
 *
 * `stair` is absent because its LOD0 is Task 2's tread carpentry, and the
 * movers `lift`/`liftDoor` are absent because a lift car's edges are read in
 * motion, at shaft-lantern light levels, through a door - the one place a
 * bevel buys nothing.
 */
const BEVELLED_KINDS = new Set(['hedge', 'floor', 'shaftWall', 'gate', 'slideWall', 'footing']);

/**
 * The kinds whose prefabs carry a baked vertex-colour AO attribute, AT EVERY
 * LOD - the plan's full six plus `stair`, wider than the bevel list on
 * purpose:
 *
 *  - `hedge` and `footing` sit here even though their bevel is deferred (see
 *    BEVELLED_KINDS): the bake is free of triangles, so the contact
 *    darkening ships now on the plain box.
 *  - `stair` shares the shaftWall MATERIAL OBJECT (asserted by
 *    maze-materials.test.mjs), so the moment that material reads vertex
 *    colours, every stair geometry must supply them - a mesh with no colour
 *    attribute under a vertexColors material renders BLACK in three, which is
 *    the silent failure this set exists to make impossible.
 *  - every LOD, not just LOD0, for the same reason: LOD1/2 draw with the same
 *    material. Baking the box LODs also keeps the base darkening through the
 *    Task 7 LOD swap, so distance changes silhouette, never brightness.
 */
const AO_KINDS = new Set([...BEVELLED_KINDS, 'stair', 'newel']);

/**
 * Collapse a requested LOD to the coarsest one whose geometry is identical,
 * so equivalent LODs share ONE cached object rather than two equal copies.
 *
 * Identity, not just equality, is the point: `MazeBatches` keys its
 * `addGeometry` ledger on the geometry OBJECT, so `prefabFor(lod 1)` and
 * `prefabFor(lod 2)` returning two separate-but-identical boxes would
 * register both into every family's shared buffer and double the geometry
 * reservations for nothing drawn. Collapsing here also means a kind with no
 * authored near tier (tunnel, plate, candle) hands back the SAME object at
 * every LOD, which is what lets the batch's LOD swap skip such instances by
 * comparing ids instead of by consulting a second list of exempt kinds.
 *
 * Today that leaves exactly two tiers: the authored LOD0, and the plain box
 * that serves both far bands - `lodFor`'s three bands are a contract with
 * room for a mid tier this function does not yet distinguish.
 */
function geometryLod(kind, lod) {
  if (lod === 0) return 0;
  return (kind === 'stair' || BEVELLED_KINDS.has(kind)) ? 1 : 0;
}

/**
 * Build one prefab at world scale. Half-extents arrive already quantised, so
 * the box is the class's own size and can only be a subset of any descriptor
 * that asked for it.
 *
 * The `stair` branch is Task 2 - the owner's own named complaint - and the
 * chamfer branch is Task 4. LOD1 stays the plain box alongside LOD2 for every
 * kind, judged rather than defaulted: a 4 cm chamfer is not resolvable at
 * 30 m, and the phase's whole triangle argument depends on the far LODs
 * costing what a box costs.
 */
function buildPrefab(kind, hx, hy, hz, lod) {
  let g;
  if (kind === 'stair' && lod === 0) g = buildStairPrefab(hx, hy, hz);
  else if (kind === 'newel') g = buildNewelPrefab(hx, hy, hz);
  else if (BEVELLED_KINDS.has(kind) && lod === 0) g = buildChamferPrefab(hx, hy, hz);
  else {
    g = new THREE.BoxGeometry(hx * 2, hy * 2, hz * 2);
    worldScaleBoxUVs(g);
  }
  if (AO_KINDS.has(kind)) bakeContactAO(g, hy);
  return g;
}

/**
 * Rewrite a BoxGeometry's per-face 0..1 UVs as world-scale metres - Task 5's
 * settled convention, applied to every prefab builder at once.
 *
 * The alternative was keeping BoxGeometry's own parameterisation, where every
 * face spans the unit square whatever it measures. That was survivable while
 * the maps were tuned per kind against known face sizes (Phase 5 did exactly
 * that, and Task 4 deliberately left it alone to avoid moving hedge density
 * inside a geometry commit) - but it breaks the moment one material serves
 * many extents: the same earth grain would span 1.4 m on one floor slab and
 * 24 m on its neighbour, and a normal map makes that stretch legible as
 * smeared relief. Metres everywhere gives constant texel density on every
 * face of every box, matches the stair sweep (world-scale since Task 2, for
 * this task) and lets a texture declare its own physical tile via `repeat`.
 *
 * Projection axes match `buildChamferPrefab`'s patches - x-faces map (z, y),
 * y-faces (x, z), z-faces (x, y) - so a chamfered box and its plain LOD wear
 * the map identically and an LOD swap cannot slide the texture.
 */
function worldScaleBoxUVs(g) {
  const pos = g.attributes.position;
  const nor = g.attributes.normal;
  const uv = g.attributes.uv;
  for (let i = 0; i < pos.count; i++) {
    const ax = Math.abs(nor.getX(i));
    const ay = Math.abs(nor.getY(i));
    const az = Math.abs(nor.getZ(i));
    if (ax >= ay && ax >= az) uv.setXY(i, pos.getZ(i), pos.getY(i));
    else if (ay >= az) uv.setXY(i, pos.getX(i), pos.getZ(i));
    else uv.setXY(i, pos.getX(i), pos.getY(i));
  }
}

/**
 * A box with every edge and corner chamfered by `chamferFor` - the 26-facet
 * solid: six inset faces, twelve edge facets, eight corner triangles. 44
 * triangles and 96 creased vertices against the box's 12 and 24.
 *
 * Authored as explicit facet patches rather than by sweeping an outline the
 * way the stair is, because a sweep with mitred plan corners cannot chamfer
 * the four VERTICAL edges - and on a hedge those are the edges the player
 * actually walks past; the top arrises live 5 m up. Each patch owns its
 * vertices, so the facets shade flat with creases exactly at the arrises,
 * which is what makes the edge catch light as a distinct highlight instead
 * of smearing into a rounded normal.
 *
 * Facet corners are sorted by angle about the outward normal rather than
 * hand-wound: 26 winding tables were the alternative, and every one of them
 * is a place for a silently inward-facing facet to hide. Runs once per
 * (kind, extent class) for the life of the cache, so the sort costs nothing
 * that matters.
 *
 * UVs are world-scale metres, projected along each facet's dominant normal
 * axis - Task 4 shipped this builder on BoxGeometry's 0..1-per-face
 * convention to avoid moving Phase 5's map density inside a geometry commit,
 * and Task 5 (which owns the surfacing) moved every builder to metres
 * together. See `worldScaleBoxUVs` for the argument.
 */
function buildChamferPrefab(hx, hy, hz) {
  const b = chamferFor({ hx, hy, hz });
  /* Where the flat faces end and the cuts begin, per axis. */
  const inset = [hx - b, hy - b, hz - b];
  const half = [hx, hy, hz];

  const positions = [];
  const normals = [];
  const uvs = [];
  const indices = [];

  /* The corner vertex lying ON the face whose axis is `axis`, for the corner
   * with signs s = [sx, sy, sz]: full half-extent along the face's axis,
   * inset along the other two. The three such points of one corner are the
   * corner triangle; shared pairs make the edge facets; quads of one axis
   * make the faces. */
  const cornerVert = (s, axis) => s.map(
    (sign, a) => sign * (a === axis ? half[a] : inset[a]),
  );

  /* One flat facet: sort its corners CCW about the outward normal (see the
   * builder note), fan-triangulate, and project UVs onto the box face behind
   * the facet's dominant normal axis. */
  const patch = (verts, n) => {
    const len = Math.hypot(n[0], n[1], n[2]);
    const nx = n[0] / len; const ny = n[1] / len; const nz = n[2] / len;
    /* A tangent basis: cross the normal with whichever axis it leans on least. */
    const ref = Math.abs(nx) <= Math.abs(ny) && Math.abs(nx) <= Math.abs(nz)
      ? [1, 0, 0] : (Math.abs(ny) <= Math.abs(nz) ? [0, 1, 0] : [0, 0, 1]);
    const u = [ny * ref[2] - nz * ref[1], nz * ref[0] - nx * ref[2], nx * ref[1] - ny * ref[0]];
    const v = [ny * u[2] - nz * u[1], nz * u[0] - nx * u[2], nx * u[1] - ny * u[0]];
    const c = [0, 1, 2].map((a) => verts.reduce((s2, p) => s2 + p[a], 0) / verts.length);
    const angle = (p) => Math.atan2(
      (p[0] - c[0]) * v[0] + (p[1] - c[1]) * v[1] + (p[2] - c[2]) * v[2],
      (p[0] - c[0]) * u[0] + (p[1] - c[1]) * u[1] + (p[2] - c[2]) * u[2],
    );
    const ordered = [...verts].sort((p, q) => angle(p) - angle(q));

    const uvAxes = Math.abs(nx) >= Math.abs(ny) && Math.abs(nx) >= Math.abs(nz)
      ? [2, 1] : (Math.abs(ny) >= Math.abs(nz) ? [0, 2] : [0, 1]);
    const base = positions.length / 3;
    for (const p of ordered) {
      positions.push(p[0], p[1], p[2]);
      normals.push(nx, ny, nz);
      uvs.push(p[uvAxes[0]], p[uvAxes[1]]);
    }
    for (let i = 1; i < ordered.length - 1; i++) {
      indices.push(base, base + i, base + i + 1);
    }
  };

  const corners = [];
  for (const sx of [-1, 1]) {
    for (const sy of [-1, 1]) for (const sz of [-1, 1]) corners.push([sx, sy, sz]);
  }

  /* Six faces: the four corners agreeing with (axis, sign), on that face. */
  for (let axis = 0; axis < 3; axis++) {
    for (const sign of [-1, 1]) {
      const quad = corners.filter((s) => s[axis] === sign).map((s) => cornerVert(s, axis));
      const n = [0, 0, 0];
      n[axis] = sign;
      patch(quad, n);
    }
  }
  /* Twelve edge facets: a pair of face axes with fixed signs, the two corners
   * sharing them, and one vertex from each of the pair's faces. */
  for (let a1 = 0; a1 < 3; a1++) {
    for (let a2 = a1 + 1; a2 < 3; a2++) {
      for (const s1 of [-1, 1]) {
        for (const s2 of [-1, 1]) {
          const pair = corners.filter((s) => s[a1] === s1 && s[a2] === s2);
          const quad = pair.flatMap((s) => [cornerVert(s, a1), cornerVert(s, a2)]);
          const n = [0, 0, 0];
          n[a1] = s1;
          n[a2] = s2;
          patch(quad, n);
        }
      }
    }
  }
  /* Eight corner triangles. */
  for (const s of corners) {
    patch([cornerVert(s, 0), cornerVert(s, 1), cornerVert(s, 2)], s);
  }

  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  g.setIndex(indices);
  return g;
}

/**
 * Bake contact AO into a prefab as a greyscale `color` attribute: the base
 * shaded by `contactShade`, the chamfer facets a few percent darker still.
 *
 * Vertex colours rather than a lightmap, and the reasons are the task's own:
 * a lightmap needs a second UV set and a texture per district, which across
 * 2.4 km x 4 levels is a budget nobody can pay and a bake nobody can re-run
 * on a re-rolled seed. One colour attribute re-rolls for free and is
 * IDENTICAL for every instance of an extent class - exactly the property
 * that lets it live here, in the shared cached geometry, instead of anywhere
 * per-instance.
 *
 * The crease term keys on the normal being off-axis, which on these prefabs
 * is true of precisely the chamfer facets, the corner triangles and the
 * stair's bulnose arc - no flat face ever qualifies, so a plain box LOD
 * comes through with pure `contactShade` and matches its LOD0 at distance.
 */
function bakeContactAO(g, hy) {
  const pos = g.attributes.position;
  const nor = g.attributes.normal;
  const colour = new Float32Array(pos.count * 3);
  for (let i = 0; i < pos.count; i++) {
    let s = contactShade(pos.getY(i), hy);
    const flat = Math.max(Math.abs(nor.getX(i)), Math.abs(nor.getY(i)), Math.abs(nor.getZ(i)));
    if (flat < 0.999) s *= CONTACT_AO.crease;
    colour[i * 3] = s;
    colour[i * 3 + 1] = s;
    colour[i * 3 + 2] = s;
  }
  g.setAttribute('color', new THREE.BufferAttribute(colour, 3));
}

/**
 * Adopt an authored geometry (from `MazeAssets`) as the prefab for one
 * extent class: CLONE it, refit the clone into the dressing box, and give it
 * the same baked-AO colour attribute every procedural prefab in its family
 * carries.
 *
 * A clone, not the source object, because the registry DISPOSES its cache at
 * world teardown (`releasePrefabs` - this world re-rolls per entry) while
 * `MazeAssets` keeps the parsed source for the whole session; adopting the
 * source would free its buffers out from under the next build. The clone is
 * one small geometry per (kind, extent class) per session-entry, which is
 * exactly the cost every procedural builder here already pays.
 *
 * The refit is UNIFORM scale - largest that fits all three extents - then
 * centred in x/z and stood on the box floor. Uniform, because squashing an
 * authored silhouette per-axis would defeat the reason the asset exists;
 * dressing kinds are exempt from the fit contract, so an authored prop that
 * chose to overhang could, but the refit keeps everything inside the box and
 * leaves the exemption as headroom. NOTE the loaded glTF's own material was
 * already discarded in MazeAssets.firstGeometry: the prefab is drawn by its
 * batch family's cached maze material (the newel rides `stone`'s stair
 * material), so an authored asset costs ZERO new shader programs.
 */
function buildAssetPrefab(src, hx, hy, hz, kind) {
  const g = src.clone();
  g.computeBoundingBox();
  const b = g.boundingBox;
  const size = new THREE.Vector3();
  b.getSize(size);
  const s = Math.min(
    (2 * hx) / Math.max(size.x, 1e-6),
    (2 * hy) / Math.max(size.y, 1e-6),
    (2 * hz) / Math.max(size.z, 1e-6),
  );
  g.scale(s, s, s);
  /* `scale` runs through applyMatrix4, which refreshes the geometry's
   * boundingBox in place - so `b` now holds the SCALED box and the offsets
   * read straight off it. */
  g.translate(
    -(b.min.x + b.max.x) / 2,
    -hy - b.min.y,
    -(b.min.z + b.max.z) / 2,
  );
  /* Baked whether or not the kind is in AO_KINDS: an authored file may join
   * a family whose material reads vertexColors, and a geometry without the
   * attribute renders black under such a material - silently. */
  if (AO_KINDS.has(kind) || !g.attributes.color) bakeContactAO(g, hy);
  return g;
}

/**
 * The procedural newel fallback - a turned post (plinth, coved shaft, collar
 * bead, acorn finial) lathed at world scale, the same silhouette
 * `scripts/make-newel-glb.mjs` authors into the shipped .glb. The two exist
 * on purpose: the pipeline's guarantee is that a missing file degrades to a
 * prop of the same kind, and the cheapest honest way to keep that guarantee
 * is for the fallback to be the same shape at a lower segment count.
 *
 * One LOD tier only (see `geometryLod`): the whole prop is 0.6 m wide and
 * lives inside a shaft, so a far tier would optimise triangles nobody can
 * resolve through a stone wall.
 */
function buildNewelPrefab(hx, hy, hz) {
  /* (radius, y) in fractions of the box; radius fraction of min(hx, hz) so a
   * non-square request still lathes a round post that fits. */
  const profile = [
    [0.00, -1.00], [0.87, -1.00], [0.93, -0.92], [0.93, -0.68], [0.67, -0.60],
    [0.53, -0.44], [0.43, -0.10], [0.40, 0.20], [0.57, 0.32], [0.57, 0.40],
    [0.40, 0.48], [0.63, 0.68], [0.47, 0.88], [0.17, 0.98], [0.00, 1.00],
  ];
  const r = Math.min(hx, hz);
  const g = new THREE.LatheGeometry(
    profile.map(([pr, py]) => new THREE.Vector2(Math.max(pr * r, 0), py * hy)), 12,
  );
  return g;
}

/**
 * A stair tread (or landing - `treadOutline` decides which from proportion)
 * as real carpentry: the walking slab at the top of the box, a riser set back
 * beneath it, a bulnose rolled over the slab's edge and a chamfer easing the
 * soffit into the riser. The nosing overhangs the RISER, which is what got
 * set back - nothing here leaves the descriptor box, so the fit contract
 * holds for this prefab the same way it holds for a plain box.
 *
 * The outline is swept around the box's plan rectangle with mitred corners:
 * each outline point becomes a rectangular ring inset by that point's `d`,
 * and each of the ring's four sides is stitched independently. Sides and
 * bands own their vertices - duplicated at plan corners and at band
 * boundaries - so `computeVertexNormals` smooths exactly where the outline
 * says to: along the bulnose arc, and nowhere across a crease. An
 * ExtrudeGeometry along a rounded-rect path was the alternative and lost: it
 * cannot vary the inset per profile point, which is the entire shape.
 *
 * UVs are world-scale metres (u along each side's run, v down the profile's
 * arc length; caps map plan position), so the maps Task 5 hangs on this
 * material will tile at the same density they do on every box.
 */
function buildStairPrefab(hx, hy, hz) {
  const bands = treadOutline({ hx, hy, hz });
  const positions = [];
  const uvs = [];
  const indices = [];

  /* The four sides of the ring at inset d, each as [start, end] chosen so the
   * quad winding below faces outward. Rotational order: +x, +z, -x, -z. */
  const sides = [
    (d, y) => [[hx - d, y, -(hz - d)], [hx - d, y, hz - d]],
    (d, y) => [[hx - d, y, hz - d], [-(hx - d), y, hz - d]],
    (d, y) => [[-(hx - d), y, hz - d], [-(hx - d), y, -(hz - d)]],
    (d, y) => [[-(hx - d), y, -(hz - d)], [hx - d, y, -(hz - d)]],
  ];

  for (const band of bands) {
    for (const side of sides) {
      const base = positions.length / 3;
      let v = 0;
      for (let i = 0; i < band.length; i++) {
        const [d, y] = band[i];
        if (i > 0) {
          const [pd, py] = band[i - 1];
          v += Math.hypot(d - pd, y - py);
        }
        const [a, b] = side(d, y);
        positions.push(a[0], a[1], a[2], b[0], b[1], b[2]);
        const run = Math.hypot(b[0] - a[0], b[2] - a[2]);
        uvs.push(0, v, run, v);
      }
      for (let i = 0; i < band.length - 1; i++) {
        const a0 = base + i * 2;
        indices.push(a0, a0 + 1, a0 + 3, a0, a0 + 3, a0 + 2);
      }
    }
  }

  /* Caps. The top starts where the first band does (inset by the nosing
   * radius, which is why the bulnose meets it tangentially) and the bottom
   * ends where the last band does. */
  const cap = (d, y, facingUp) => {
    const X = hx - d;
    const Z = hz - d;
    const base = positions.length / 3;
    positions.push(X, y, Z, -X, y, Z, -X, y, -Z, X, y, -Z);
    uvs.push(X, Z, -X, Z, -X, -Z, X, -Z);
    if (facingUp) indices.push(base, base + 2, base + 1, base, base + 3, base + 2);
    else indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
  };
  const first = bands[0][0];
  const lastBand = bands[bands.length - 1];
  const last = lastBand[lastBand.length - 1];
  cap(first[0], first[1], true);
  cap(last[0], last[1], false);

  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  g.setIndex(indices);
  g.computeVertexNormals();
  return g;
}

/**
 * Split a kind's descriptors into runs that can share one InstancedMesh.
 *
 * An InstancedMesh has exactly one geometry, and once the extents live in the
 * geometry rather than in the matrix, descriptors of the same kind but
 * different sizes can no longer ride in the same mesh. Most of the time this
 * changes nothing - a district's hedges come in two orientations and its floor
 * is one slab - but a district holding a shaft splits its floor into several
 * spans and each needs its own.
 *
 * Callers group rather than `buildBoxInstances` doing it internally because the
 * moving kinds pair a descriptor to its instance INDEX, and an index is only
 * meaningful against the exact list that was written. Grouping in the open
 * keeps that pairing by construction, which is the same argument the collider
 * loop in `MazeChunks.ensure` makes for not searching by position.
 *
 * @returns {Array<{cls:string, descs:Array<object>}>} in first-seen order
 */
export function groupByExtentClass(descs) {
  /* One group is overwhelmingly the common case; building a Map for a single
   * class would allocate for nothing on the hot streaming path. */
  if (descs.length === 0) return [];
  const first = extentClass(descs[0].hx, descs[0].hy, descs[0].hz);
  let mixed = false;
  for (let i = 1; i < descs.length; i++) {
    if (extentClass(descs[i].hx, descs[i].hy, descs[i].hz) !== first) { mixed = true; break; }
  }
  if (!mixed) return [{ cls: first, descs }];

  const by = new Map();
  for (const d of descs) {
    const cls = extentClass(d.hx, d.hy, d.hz);
    const run = by.get(cls);
    if (run) run.push(d);
    else by.set(cls, [d]);
  }
  return [...by].map(([cls, list]) => ({ cls, descs: list }));
}

/**
 * Is this geometry the registry's, and therefore not the caller's to dispose?
 *
 * The question a district asks on eviction. Answering it from the registry
 * rather than from a flag on the mesh means there is one place that knows who
 * owns a geometry, and a mesh that forgets to set a flag cannot quietly free a
 * buffer twenty other districts are drawing from.
 */
export function isPrefab(geo) {
  return _owned.has(geo);
}

/** How many distinct geometries the registry holds. Asserted against `PREFAB_BUDGET`. */
export function prefabCount() {
  return _prefabs.size;
}

/**
 * Free every prefab and empty the cache.
 *
 * Called from `MazeChunks.disposeAll`, which is world teardown and the only
 * moment at which no district is drawing with any of these. Anything finer -
 * releasing on district eviction, say - would free geometry its neighbours are
 * still using; anything coarser is a cache that grows by a seed's worth of
 * floor spans on every re-roll.
 */
export function releasePrefabs() {
  for (const g of _prefabs.values()) g.dispose();
  _prefabs.clear();
  _owned.clear();
}
