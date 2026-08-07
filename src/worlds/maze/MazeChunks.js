import * as THREE from 'three';
import { districtCoords } from './MazeTopology.js';
import { districtColliders } from './MazeColliders.js';

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
   *           materials: { hedge: THREE.Material, floor: THREE.Material } }} ctx
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
    for (const [kind, material] of [['hedge', this.materials.hedge], ['floor', this.materials.floor]]) {
      const of = descs.filter((d) => d.kind === kind);
      if (of.length === 0) continue;
      meshes.push(this._instance(of, material, `maze:${kind}:${key}`));
    }

    this._resident.set(key, { meshes, colliders });
  }

  /** Release a district. Safe to call for one that is not resident. */
  drop(key) {
    const entry = this._resident.get(key);
    if (!entry) return;

    for (const c of entry.colliders) {
      this.physics.remove(c);
      const at = this.worldColliders.indexOf(c);
      if (at >= 0) this.worldColliders.splice(at, 1);
    }

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

  disposeAll() {
    for (const key of [...this._resident.keys()]) this.drop(key);
  }

  /** One InstancedMesh from a list of box descriptors. */
  _instance(descs, material, name) {
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
    this.group.add(mesh);
    return mesh;
  }
}
