import * as THREE from 'three';
import { extentClass, quantiseExtent, PREFAB_BUDGET, treadOutline } from './MazeProfiles.js';

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

/** `${kind}:${extentClass}:${lod}` -> geometry. */
const _prefabs = new Map();
/** The same geometries by identity, so `isPrefab` is a lookup and not a scan. */
const _owned = new Set();

/**
 * The shared geometry for one descriptor, built at world scale.
 *
 * @param {{kind:string, hx:number, hy:number, hz:number, lod?:number}} desc
 * @returns {THREE.BufferGeometry} cached - callers must never dispose it
 */
export function prefabFor({ kind, hx, hy, hz, lod = 0 }) {
  const key = `${kind}:${extentClass(hx, hy, hz)}:${lod}`;
  const hit = _prefabs.get(key);
  if (hit) return hit;

  const g = buildPrefab(kind, quantiseExtent(hx), quantiseExtent(hy), quantiseExtent(hz), lod);
  g.name = `prefab:${key}`;
  _prefabs.set(key, g);
  _owned.add(g);
  return g;
}

/**
 * Build one prefab at world scale. Half-extents arrive already quantised, so
 * the box is the class's own size and can only be a subset of any descriptor
 * that asked for it.
 *
 * The `stair` branch is Task 2 - the owner's own named complaint. LOD1 stays
 * the plain box alongside LOD2, judged rather than defaulted: a staircase
 * lives inside a walled shaft, so it is either being climbed (LOD0 range) or
 * occluded, and a mid LOD would be a geometry nobody can ever stand far
 * enough away to see. The remaining kinds gain their profiles in Task 4.
 */
function buildPrefab(kind, hx, hy, hz, lod) {
  if (kind === 'stair' && lod === 0) return buildStairPrefab(hx, hy, hz);
  return new THREE.BoxGeometry(hx * 2, hy * 2, hz * 2);
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
