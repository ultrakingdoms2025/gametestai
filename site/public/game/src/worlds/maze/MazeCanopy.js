import * as THREE from 'three';
import { MAZE, DISTRICT_SPAN, districtAtWorld, districtCoords, neighbourhoodKeys } from './MazeTopology.js';

/** Districts of canopy either side of the player. Wider than the streamed set. */
const CANOPY_RADIUS = 8;

/**
 * Worst-case resident count: the full `(2r+1) x (2r+1)` block `neighbourhoodKeys`
 * can hand back for a centre away from any grid edge. Derived from the radius
 * rather than hard-coded, so a future change to `CANOPY_RADIUS` cannot silently
 * outgrow the pool and start starving `_add` of slots.
 */
const MAX_CANOPY = (2 * CANOPY_RADIUS + 1) ** 2;

/** Scratch for the matrix carried during a slot swap in `_drop` - see there. */
const _swapMatrix = new THREE.Matrix4();

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
 *
 * ── One mesh, not one per district ─────────────────────────────────────────
 * A first pass built one `InstancedMesh` per resident district - at radius 8
 * that is up to 289 separate one-instance meshes, each its own draw call,
 * measured against 71 for the entire rest of the maze. That is exactly the
 * moment (a player on a tower, looking out) draw-call pressure is already at
 * its worst, so it is the worst possible place to pay that cost.
 *
 * Instead this holds a single `InstancedMesh` sized to `MAX_CANOPY` - the
 * worst case for the radius - and manages a packed slot allocator over it:
 * `_resident` maps a district key to its slot, `_slotDistrict` is the reverse.
 * Live slots are kept packed at `[0, mesh.count)` with no gaps, so `mesh.count`
 * is always exactly the number of resident districts and nothing beyond it is
 * ever drawn. Dropping a district swaps the last live slot into the freed one
 * (`_drop`) rather than leaving a hole, which is what keeps that invariant true
 * without a separate free-list to keep in sync.
 */
export class MazeCanopy {
  constructor({ group, material }) {
    this.group = group;
    this.material = material;
    this._geo = new THREE.PlaneGeometry(DISTRICT_SPAN, DISTRICT_SPAN);
    this._geo.rotateX(-Math.PI / 2);

    /** @type {Map<number, number>} district key -> its slot in the pooled mesh */
    this._resident = new Map();
    /** @type {Array<number|null>} slot -> district key, the reverse of `_resident` */
    this._slotDistrict = new Array(MAX_CANOPY).fill(null);

    this._mesh = null;
    this._ensureMesh();
  }

  /**
   * Build `_mesh` if it does not currently exist.
   *
   * Split out of the constructor so `_add` can call it too: `disposeAll` nulls
   * `_mesh` rather than leaving a disposed-but-still-referenced instance
   * behind, and without this guard a stray `update()` call after `disposeAll`
   * would dereference that null and either throw somewhere unhelpful or (if
   * some future edit made `_add` more defensive on its own) silently render
   * nothing forever - a broken contract with no error to point at it. Lazily
   * rebuilding instead makes a canopy usable again exactly when something
   * asks it to be, which is what every other pooled resource in this class
   * already does slot-by-slot.
   */
  _ensureMesh() {
    if (this._mesh) return;
    this._mesh = new THREE.InstancedMesh(this._geo, this.material, MAX_CANOPY);
    this._mesh.name = 'maze:canopy';
    this._mesh.castShadow = false;
    this._mesh.receiveShadow = false;
    /* Nothing resident yet - draw range starts at zero, not the pool's capacity. */
    this._mesh.count = 0;
    this.group.add(this._mesh);
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
      if (!this._resident.has(key)) this._add(key);
    }
  }

  /** Claim the next packed slot for `key` and write its world matrix into it. */
  _add(key) {
    this._ensureMesh();
    const slot = this._mesh.count;
    if (slot >= MAX_CANOPY) {
      // Cannot happen while MAX_CANOPY tracks CANOPY_RADIUS - see the constant's
      // own comment - but a silent overflow would corrupt a neighbour's slot
      // rather than announce itself, so this fails loud instead.
      throw new Error(`MazeCanopy pool exhausted: ${MAX_CANOPY} slots is not enough for radius ${CANOPY_RADIUS}`);
    }
    const { dx, dz, level: lv } = districtCoords(key);
    const m = new THREE.Matrix4().setPosition(
      dx * DISTRICT_SPAN + DISTRICT_SPAN / 2,
      lv * MAZE.LEVEL_HEIGHT + MAZE.HEDGE_HEIGHT,
      dz * DISTRICT_SPAN + DISTRICT_SPAN / 2,
    );
    this._mesh.setMatrixAt(slot, m);
    this._mesh.instanceMatrix.needsUpdate = true;
    this._resident.set(key, slot);
    this._slotDistrict[slot] = key;
    this._mesh.count = slot + 1;
  }

  /**
   * Release `key`'s slot, keeping every live slot packed at `[0, count)`.
   *
   * The freed slot is not left as a hole: the district currently in the last
   * live slot is copied into it and its map entry is repointed, then `count`
   * drops by one. That is what makes `mesh.count` a correct, cheap answer to
   * "how many districts are resident" and guarantees nothing at or beyond it
   * is ever read as live - no separate free-list, no stale slot to skip.
   */
  _drop(key) {
    const slot = this._resident.get(key);
    if (slot === undefined) return;

    const lastSlot = this._mesh.count - 1;
    if (slot !== lastSlot) {
      const lastKey = this._slotDistrict[lastSlot];
      this._mesh.getMatrixAt(lastSlot, _swapMatrix);
      this._mesh.setMatrixAt(slot, _swapMatrix);
      this._resident.set(lastKey, slot);
      this._slotDistrict[slot] = lastKey;
    }
    this._slotDistrict[lastSlot] = null;
    this._resident.delete(key);
    this._mesh.count = lastSlot;
    this._mesh.instanceMatrix.needsUpdate = true;
  }

  disposeAll() {
    for (const key of [...this._resident.keys()]) this._drop(key);
    this.group.remove(this._mesh);
    this._mesh.dispose();
    this._geo.dispose();
    /* Nulled, not left dangling: `_add` (via `_ensureMesh`) rebuilds it on
     * demand, so a canopy that outlives its own disposal - unreachable today,
     * since `MazeWorld.dispose()` drops the whole instance and `build()`
     * constructs a fresh one, but not guaranteed to stay that way - keeps
     * working instead of silently going inert. */
    this._mesh = null;
  }
}
