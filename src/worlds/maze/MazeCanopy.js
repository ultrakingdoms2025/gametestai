import * as THREE from 'three';
import { MAZE, DISTRICT_SPAN, districtAtWorld, districtCoords, neighbourhoodKeys } from './MazeTopology.js';

/** Districts of canopy either side of the player. Wider than the streamed set. */
const CANOPY_RADIUS = 8;

/**
 * Distant hedge-tops.
 *
 * Beyond the streamed districts the maze simply stops. At ground level the 5 m
 * hedges hide that completely, which is why it was invisible for a whole phase;
 * from the top of a shaft it is a void. This fills it with one flat quad per
 * district at hedge height.
 *
 * It carries no colliders and never will. It is the far side of a horizon, not
 * a floor, and a player who could stand on it would be standing on the tops of
 * the hedges the whole world is built to keep them out of.
 */
export class MazeCanopy {
  constructor({ group, material }) {
    this.group = group;
    this.material = material;
    /** @type {Map<number, THREE.InstancedMesh>} */
    this._resident = new Map();
    this._geo = new THREE.PlaneGeometry(DISTRICT_SPAN, DISTRICT_SPAN);
    this._geo.rotateX(-Math.PI / 2);
  }

  residentKeys() {
    return [...this._resident.keys()].sort((a, b) => a - b);
  }

  update(x, z, level) {
    const want = new Set(neighbourhoodKeys(districtAtWorld(x, z, level), CANOPY_RADIUS));
    for (const key of [...this._resident.keys()]) {
      if (!want.has(key)) this._drop(key);
    }
    for (const key of want) {
      if (this._resident.has(key)) continue;
      const { dx, dz, level: lv } = districtCoords(key);
      const mesh = new THREE.InstancedMesh(this._geo, this.material, 1);
      mesh.name = `maze:canopy:${key}`;
      const m = new THREE.Matrix4().setPosition(
        dx * DISTRICT_SPAN + DISTRICT_SPAN / 2,
        lv * MAZE.LEVEL_HEIGHT + MAZE.HEDGE_HEIGHT,
        dz * DISTRICT_SPAN + DISTRICT_SPAN / 2,
      );
      mesh.setMatrixAt(0, m);
      mesh.instanceMatrix.needsUpdate = true;
      mesh.castShadow = false;
      mesh.receiveShadow = false;
      this.group.add(mesh);
      this._resident.set(key, mesh);
    }
  }

  _drop(key) {
    const mesh = this._resident.get(key);
    if (!mesh) return;
    this.group.remove(mesh);
    mesh.dispose();
    this._resident.delete(key);
  }

  disposeAll() {
    for (const key of [...this._resident.keys()]) this._drop(key);
    this._geo.dispose();
  }
}
