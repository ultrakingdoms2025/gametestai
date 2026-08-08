import * as THREE from 'three';
import { MAZE, districtCoords, districtAtWorld, neighbourhoodKeys } from './MazeTopology.js';
import { districtColliders } from './MazeColliders.js';

/**
 * Every descriptor `kind` this class knows how to turn into a mesh, and
 * (via `this.materials[kind]`) the cached material it is drawn with.
 *
 * This is the single source of truth for "what MazeChunks renders" - `ensure`
 * iterates it directly rather than a hand-copied literal, and the render-
 * coverage test (`scripts/tests/maze-render-coverage.test.mjs`) imports it
 * rather than re-typing the list, so the two can never quietly drift apart.
 * `districtColliders` emitting a `kind` not listed here is exactly the bug
 * this constant exists to make impossible to miss: the collider is built
 * (colliders are read straight off descriptors, never off this list) but
 * nothing ever draws it - a stair tread with no mesh, solid and invisible.
 * See that test for the enforcement.
 */
export const CHUNK_MESH_KINDS = Object.freeze(['hedge', 'floor', 'stair']);

/**
 * District-level streaming for the maze.
 *
 * A district is 120 m square and about 800 hedge segments. Building all 400 of
 * them up front cost ~176,000 colliders and ~170 MB for a single level, which
 * is affordable exactly once and not at all across four levels. This holds a
 * small resident set instead and releases the rest.
 *
 * Two details are load-bearing:
 *
 * 1. **Colliders come from descriptors, never from meshes.** `districtColliders`
 *    returns plain numbers, and this class turns each descriptor into both a
 *    physics box and an instance matrix. That separation is what lets the
 *    containment gate assemble a collision world under Node with no renderer.
 *
 * 2. **The world's collider array is kept in step.** `WorldManager._activate`
 *    re-registers every entry of `world.colliders` into the live physics world.
 *    A collider evicted from physics but left in that array would be resurrected
 *    on the next activation as an invisible wall.
 */
export class MazeChunks {
  /**
   * @param {{ world: { physics: any, colliders: any[] }, cells: Uint8Array,
   *           group: THREE.Group,
   *           materials: { hedge: THREE.Material, floor: THREE.Material,
   *                        stair: THREE.Material } }} ctx
   */
  constructor({ world, cells, group, materials }) {
    /* The WORLD, not its physics. WorldManager swaps `world.physics` to a
     * throwaway scratch instance for the duration of build() and restores the
     * real one afterwards - and this class is constructed inside build(). A
     * captured reference would be the scratch world, so every district streamed
     * in after arrival would register into a discarded object and the player
     * would walk through it. Resolved per call, deliberately. */
    this.world = world;
    this.cells = cells;
    this.group = group;
    this.materials = materials;
    /** @type {Map<number, { meshes: THREE.InstancedMesh[], colliders: any[] }>} */
    this._resident = new Map();
  }

  /** Live physics world. Never cache this - see the constructor. */
  get physics() {
    return this.world.physics;
  }

  /** The world's own collider array, kept in step so activation cannot resurrect evictions. */
  get worldColliders() {
    return this.world.colliders;
  }

  /** Sorted, so two residency sets compare equal. */
  residentKeys() {
    return [...this._resident.keys()].sort((a, b) => a - b);
  }

  colliderCount() {
    let n = 0;
    for (const c of this._resident.values()) n += c.colliders.length;
    return n;
  }

  /** Build a district if it is not already resident. */
  ensure(key) {
    if (this._resident.has(key)) return;
    const { dx, dz, level } = districtCoords(key);
    const descs = districtColliders(this.cells, dx, dz, level);

    const colliders = [];
    for (const d of descs) {
      const c = this.physics.addBox(d.cx, d.cy, d.cz, d.hx, d.hy, d.hz);
      colliders.push(c);
      this.worldColliders.push(c);
    }

    const meshes = [];
    for (const kind of CHUNK_MESH_KINDS) {
      const of = descs.filter((d) => d.kind === kind);
      const mesh = buildBoxInstances(of, this.materials[kind], `maze:${kind}:${key}`, this.group);
      if (mesh) meshes.push(mesh);
    }

    this._resident.set(key, { meshes, colliders });
  }

  /**
   * Release a district. Safe to call for one that is not resident.
   *
   * At full 25-district residency `worldColliders` is ~10,000 long. Splicing
   * it once per collider - the original approach - is an `indexOf` plus a
   * shift over that whole array, 401 times, per district: 802 linear scans
   * once `Physics.remove`'s own bookkeeping is counted too. Building one Set
   * of this district's colliders and rewriting `worldColliders` in a single
   * pass turns that into one O(n) filter regardless of how many colliders the
   * district holds.
   */
  drop(key) {
    const entry = this._resident.get(key);
    if (!entry) return;

    const evicted = new Set(entry.colliders);
    for (const c of entry.colliders) this.physics.remove(c);

    const wc = this.worldColliders;
    let w = 0;
    for (let r = 0; r < wc.length; r++) {
      if (!evicted.has(wc[r])) wc[w++] = wc[r];
    }
    wc.length = w;

    for (const m of entry.meshes) {
      this.group.remove(m);
      m.geometry.dispose();
      /* InstancedMesh's instanceMatrix buffer is only released through the
       * mesh's own dispose event - geometry.dispose() alone strands it, at
       * 64 bytes per instance. */
      m.dispose();
    }

    this._resident.delete(key);
  }

  /**
   * Release every resident district at once - the bulk-teardown path used by
   * `MazeWorld.dispose()`.
   *
   * Calling `drop()` in a loop here would still filter the whole (shrinking)
   * `worldColliders` array once per district - 25 passes for a full
   * neighbourhood. Since every resident district is leaving together, this
   * collects every collider from every district into one Set first and then
   * filters `worldColliders` exactly once, which is also the case
   * `MazeWorld.dispose()` cares about: it clears `world.colliders` outright a
   * few lines after calling this, so the per-district bookkeeping `drop()`
   * needs for correctness in isolation is pure waste here.
   */
  disposeAll() {
    if (this._resident.size === 0) return;

    const evicted = new Set();
    for (const entry of this._resident.values()) {
      for (const c of entry.colliders) {
        this.physics.remove(c);
        evicted.add(c);
      }
      for (const m of entry.meshes) {
        this.group.remove(m);
        m.geometry.dispose();
        m.dispose();
      }
    }

    const wc = this.worldColliders;
    let w = 0;
    for (let r = 0; r < wc.length; r++) {
      if (!evicted.has(wc[r])) wc[w++] = wc[r];
    }
    wc.length = w;

    this._resident.clear();
  }

  /**
   * Bring residency in line with where the player is, including which level.
   *
   * The player's own level gets the full neighbourhood; the levels either side
   * get a smaller ring, because a player halfway up a shaft needs both ends
   * built and nothing else. Drops before it loads, as before.
   *
   * @param {number} x world metres
   * @param {number} y world metres — the level is derived from this
   * @param {number} z world metres
   * @param {number} [radius] districts either side on the player's own level
   * @returns {boolean} true when the set changed
   */
  updateResidency(x, y, z, radius = 2) {
    const level = Math.min(MAZE.LEVELS - 1, Math.max(0, Math.round(y / MAZE.LEVEL_HEIGHT)));
    const want = new Set(neighbourhoodKeys(districtAtWorld(x, z, level), radius));
    for (const dl of [-1, 1]) {
      const near = level + dl;
      if (near < 0 || near >= MAZE.LEVELS) continue;
      for (const k of neighbourhoodKeys(districtAtWorld(x, z, near), 1)) want.add(k);
    }

    let changed = false;
    for (const key of [...this._resident.keys()]) {
      if (!want.has(key)) { this.drop(key); changed = true; }
    }
    for (const key of [...want].sort((a, b) => a - b)) {
      if (!this._resident.has(key)) { this.ensure(key); changed = true; }
    }
    return changed;
  }
}

/**
 * Build one InstancedMesh of unit boxes from a list of `{cx,cy,cz,hx,hy,hz}`
 * descriptors, add it to `group`, and return it - or return `null` for an
 * empty descriptor list rather than allocate a zero-instance mesh.
 *
 * Shared by `MazeChunks` (district streaming) and `MazeWorld` (the forecourt,
 * which is authored geometry rather than a chunk but built by exactly this
 * same recipe: same `BoxGeometry(1,1,1)`, same scratch Matrix4/Quaternion/
 * Vector3, same compose loop, same `instanceMatrix.needsUpdate`). It lives
 * here rather than in `MazeWorld.js` because `MazeWorld` already imports from
 * this module - putting it there instead would mean `MazeChunks` importing
 * back from `MazeWorld`, a cycle neither file needs.
 *
 * The empty-list guard matters for the forecourt specifically: it can
 * legitimately produce zero hedges or zero floor tiles depending on layout,
 * and the caller does not pre-filter the way `MazeChunks.ensure` does.
 *
 * @param {Array<{cx:number,cy:number,cz:number,hx:number,hy:number,hz:number}>} descs
 * @param {THREE.Material} material
 * @param {string} name
 * @param {THREE.Group} group
 * @returns {THREE.InstancedMesh|null}
 */
export function buildBoxInstances(descs, material, name, group) {
  if (descs.length === 0) return null;
  const geo = new THREE.BoxGeometry(1, 1, 1);
  const mesh = new THREE.InstancedMesh(geo, material, descs.length);
  mesh.name = name;
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  const m = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const pos = new THREE.Vector3();
  const scale = new THREE.Vector3();
  for (let i = 0; i < descs.length; i++) {
    const d = descs[i];
    pos.set(d.cx, d.cy, d.cz);
    scale.set(d.hx * 2, d.hy * 2, d.hz * 2);
    m.compose(pos, q, scale);
    mesh.setMatrixAt(i, m);
  }
  mesh.instanceMatrix.needsUpdate = true;
  group.add(mesh);
  return mesh;
}
