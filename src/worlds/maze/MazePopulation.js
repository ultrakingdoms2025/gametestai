import * as THREE from 'three';
import { cellCoords } from './MazeTopology.js';
import { cellToWorld } from './MazeColliders.js';
import {
  TOKENS_PER_DISTRICT, MAX_LIVE_WANDERERS, isConnectorCell,
  pickDistrictTokens, pickDistrictWanderer, districtCastIndex, tokenPhase, routeToward,
} from './MazePopulate.js';

/**
 * District-level streaming for the maze's POPULATION, mirroring `MazeChunks`.
 *
 * ## The measurement this exists to fix
 *
 * Standing at the entrance (x=1260, z=60, seed 448071848) the maze held 200
 * tokens and 21 NPCs, and the player could reach almost none of them: TWO
 * tokens within 120 m, FOUR within 240 m, ONE NPC within 120 m, and the nearest
 * wanderer 543 m away - in a district that is not built until you walk to it.
 * A flat global count over 5.7 km2 of maze is a population you meet by
 * accident.
 *
 * ## Why it is keyed on MazeChunks' residency and not its own
 *
 * There is exactly one answer to "which districts are live", and it is
 * `MazeChunks.residentKeys()`. This class is handed that list and syncs to it;
 * it never computes a neighbourhood, never reads the player's position, and
 * never decides for itself when something should exist. A second source of
 * truth for residency is how you get a token floating in a district whose floor
 * was released - the exact bug class the chunk streamer's own header warns
 * about for colliders.
 *
 * So the lifecycle is the chunk lifecycle: `ensure(key)` when a district
 * arrives, `drop(key)` when it leaves, `disposeAll()` on teardown.
 *
 * ## What it owns, and what it deliberately does not
 *
 * Tokens are MESH ONLY and reach `physics` at no point - the same rule
 * `_buildCentreStack` follows, and for the same reason: a dead end puts a hedge
 * corner within 2 m on at least two sides, so anything standable there is a
 * ladder onto the hedge tops (design doc section 2). They are drawn from ONE
 * pre-allocated InstancedMesh with a free list rather than a mesh per district,
 * because a district crossing changes five to nine districts and rebuilding a
 * GPU buffer that often is exactly the churn instanced rendering exists to
 * avoid.
 *
 * NPCs are not owned here at all - `NPCManager` owns every character in the
 * game. This holds the SPEC (which is what the headless gates check) and asks
 * the manager to spawn or despawn one. The manager may legitimately be absent:
 * during `MazeWorld.build()` the world is registering into a scratch physics
 * world, so a character grounded then would be grounded against a floor that is
 * about to be thrown away. Districts made resident during the build therefore
 * carry a spec and no character, and the first `sync` after activation - which
 * runs against the live physics world, after `NPCManager.spawnForWorld` has had
 * its turn - fills them in.
 *
 * And because the manager can destroy the whole cast without telling anyone -
 * `clear()` and `spawnForWorld()` both do, on every world activation - a
 * character reference held here is re-checked against the manager on every
 * `sync` rather than trusted. A spec whose character has been disposed is a
 * district that must be repopulated, not one that is already done; assuming
 * otherwise measured as a maze containing no wanderers at all, silently,
 * because every retry saw a non-null `npc` and skipped.
 */
export class MazePopulation {
  /**
   * @param {{ cells: Uint8Array, seed: number, group: THREE.Group|null,
   *           material: THREE.Material|null, parents: Int32Array,
   *           cast: ReadonlyArray<{name:string, persona:string}>,
   *           exclude?: Set<number>|null, blocked?: Map<number, any>|null,
   *           npcManager?: (() => any)|null, patrolSteps?: number,
   *           capacity?: number }} o
   */
  constructor({
    cells, seed, group = null, material = null, parents, cast,
    exclude = null, blocked = null, npcManager = null,
    patrolSteps = 28, capacity = 256,
  }) {
    this.cells = cells;
    this.seed = seed >>> 0;
    this.group = group;
    this.parents = parents;
    this.cast = cast;
    this.patrolSteps = patrolSteps;
    /** Resolved per call, never captured - see the note on `MazeChunks.physics`. */
    this._npcManager = npcManager;

    /* One set, so a picker does not have to know whether a forbidden cell is
     * forbidden because it is the centre or because a sliding wall moves
     * through it. Built once here rather than per district. */
    this._forbidden = new Set(exclude ?? []);
    if (blocked) for (const cell of blocked.keys()) this._forbidden.add(cell);
    /** Bound once: `routeToward` calls it per step, on every wanderer spawned. */
    this._blocksRoute = (cell) => isConnectorCell(this.cells, cell) || this._forbidden.has(cell);

    /** @type {Map<number, {tokens: any[], spec: any, npc: any}>} */
    this._resident = new Map();

    /**
     * Every live token, in no particular order. `MazeWorld` reads this every
     * frame and each record carries its own `slot`, so compacting this array on
     * a drop cannot desynchronise it from the instance buffer.
     * @type {Array<{position: THREE.Vector3, taken: boolean, phase: number,
     *               slot: number, cell: number}>}
     */
    this.tokens = [];

    /**
     * Cells whose token has already been collected. Survives the district
     * streaming out and back in, or a walk down a corridor and back would pay
     * for the same token twice.
     * @type {Set<number>}
     */
    this.collected = new Set();

    this.capacity = capacity;
    /** @type {number[]} free instance slots, popped from the end. */
    this._free = [];
    /** @type {THREE.InstancedMesh|null} */
    this.mesh = null;
    if (group && material) this._buildMesh(material);
  }

  /** The live NPC manager, or null. Resolved per call, never cached. */
  get npcManager() {
    return this._npcManager?.() ?? null;
  }

  /** Sorted, so two residency sets compare equal - matches `MazeChunks`. */
  residentKeys() {
    return [...this._resident.keys()].sort((a, b) => a - b);
  }

  /** Live wanderers, whether or not a character was built for them. */
  wandererCount() {
    let n = 0;
    for (const e of this._resident.values()) if (e.spec) n++;
    return n;
  }

  /**
   * Wanderers that actually have a character in the world.
   *
   * Distinct from `wandererCount()` on purpose: that one counts SPECS, which is
   * the right budget input (a district holds a wanderer whether or not the
   * manager has got round to building them), and is exactly the number that
   * stayed reassuringly high while the maze contained nobody. This is the one
   * the density gate and the harness ask about.
   */
  spawnedWandererCount() {
    const mgr = this.npcManager;
    let n = 0;
    for (const e of this._resident.values()) {
      if (!e.npc) continue;
      if (mgr?.owns?.(e.npc) === false) continue;
      n++;
    }
    return n;
  }

  /** Every live wanderer spec, for the headless gates and the harness. */
  wandererSpecs() {
    const out = [];
    for (const e of this._resident.values()) if (e.spec) out.push(e.spec);
    return out;
  }

  /**
   * Bring the population in line with a residency set.
   *
   * @param {number[]} keys resident district keys, from `MazeChunks.residentKeys()`
   * @returns {boolean} true when anything changed
   */
  sync(keys) {
    const want = new Set(keys);
    let changed = false;
    /* Drops first, exactly as `MazeChunks.updateResidency` does: releasing
     * before loading keeps the peak live count at the size of the resident set
     * rather than at the size of the union with the previous one. */
    for (const key of [...this._resident.keys()]) {
      if (!want.has(key)) { this.drop(key); changed = true; }
    }
    for (const key of keys) {
      if (!this._resident.has(key)) { this.ensure(key); changed = true; }
    }
    /* Districts that arrived before there was anywhere to put a character - see
     * the class header - and, secondarily, any that were refused because the
     * manager's budget was full at the time.
     *
     * Retried rather than given up on, deliberately: a refusal is a temporary
     * state of the NPC budget, not a property of the district, and a district
     * that lost its wanderer to one busy frame would stay empty for the rest of
     * the visit. The scan itself is a `continue` over at most 43 entries and
     * does no work at all once every resident district is filled, which is the
     * steady state from the second frame onward. */
    const mgr = this.npcManager;
    if (mgr) {
      for (const e of this._resident.values()) {
        if (!e.spec) continue;
        /* A character this manager no longer owns is a character that is gone.
         *
         * `NPCManager.clear()` and `spawnForWorld()` both dispose the whole cast
         * without telling anyone which specs went with it, and they run on every
         * world activation - so a district populated before one of them is left
         * holding a disposed NPC. Treating that reference as "this district is
         * done" is what turned a wiped cast into a maze with no wanderers in it
         * at all and no error anywhere: the retry below skipped every one of
         * them forever. Asked rather than assumed, so the population recovers
         * from ANY external wipe rather than only from the one we predicted.
         *
         * A manager with no `owns` is trusted, which is what keeps a stub in a
         * test (and any future manager) from silently respawning everything. */
        if (e.npc && mgr.owns?.(e.npc) === false) e.npc = null;
        if (e.npc) continue;
        e.npc = mgr.spawnOne?.(e.spec) ?? null;
        if (e.npc) changed = true;
      }
    }
    return changed;
  }

  /** Populate a district if it is not already resident. */
  ensure(key) {
    if (this._resident.has(key)) return;
    const entry = { tokens: [], spec: null, npc: null };

    for (const cell of pickDistrictTokens(
      this.cells, key, this.seed, TOKENS_PER_DISTRICT, this._forbidden,
    )) {
      /* Already found. Skipped outright rather than spawned-and-hidden so the
       * live token count is an honest answer to "what is there to find". */
      if (this.collected.has(cell)) continue;
      const rec = this._addToken(cell);
      if (!rec) break;                       // instance buffer full
      entry.tokens.push(rec);
    }

    const site = pickDistrictWanderer(this.cells, key, this.seed, this._forbidden);
    if (site >= 0 && this.wandererCount() < MAX_LIVE_WANDERERS) {
      entry.spec = this._wandererSpec(key, site);
      entry.npc = this.npcManager?.spawnOne?.(entry.spec) ?? null;
    }

    this._resident.set(key, entry);
  }

  /** Release a district. Safe to call for one that is not resident. */
  drop(key) {
    const entry = this._resident.get(key);
    if (!entry) return;

    if (entry.tokens.length) {
      const going = new Set(entry.tokens);
      for (const rec of entry.tokens) this._freeSlot(rec.slot);
      let w = 0;
      for (let r = 0; r < this.tokens.length; r++) {
        if (!going.has(this.tokens[r])) this.tokens[w++] = this.tokens[r];
      }
      this.tokens.length = w;
    }

    if (entry.npc) this.npcManager?.despawn?.(entry.npc);
    this._resident.delete(key);
  }

  /**
   * Release every district at once - the teardown path, matching
   * `MazeChunks.disposeAll()`. The token array is emptied wholesale rather than
   * filtered once per district.
   */
  disposeAll() {
    const mgr = this.npcManager;
    for (const entry of this._resident.values()) {
      if (entry.npc) mgr?.despawn?.(entry.npc);
    }
    this._resident.clear();
    this.tokens.length = 0;
    this.collected.clear();
    this._free.length = 0;
    if (this.mesh) {
      this.group?.remove(this.mesh);
      this.mesh.geometry.dispose();
      this.mesh.dispose();
      this.mesh = null;
    }
  }

  /**
   * Mark a token collected. Idempotent, and remembered by CELL so the district
   * can stream out and back in without the token returning.
   *
   * @param {{cell:number, slot:number, taken:boolean}} rec
   */
  collect(rec) {
    if (!rec || rec.taken) return false;
    rec.taken = true;
    this.collected.add(rec.cell);
    this._writeSlot(rec.slot, null);
    if (this.mesh) this.mesh.instanceMatrix.needsUpdate = true;
    return true;
  }

  /* ------------------------------------------------------------------ */
  /* Internals                                                           */
  /* ------------------------------------------------------------------ */

  _wandererSpec(key, site) {
    /* The route is cut short of anything a character cannot stand in - the same
     * ground the spawn site itself avoids. See `routeToward`. */
    const routeCells = routeToward(this.parents, site, this.patrolSteps, this._blocksRoute);
    const patrol = routeCells.map((idx) => {
      const c = cellCoords(idx);
      const w = cellToWorld(c.x, c.z, c.level);
      return new THREE.Vector3(w.x, w.y + 0.05, w.z);
    });
    const who = this.cast[districtCastIndex(key, this.seed, this.cast.length)];
    return {
      position: patrol[0].clone(),
      type: 'friendly',
      name: who.name,
      persona: who.persona,
      patrol,
      district: key,
    };
  }

  _buildMesh(material) {
    const geo = new THREE.OctahedronGeometry(0.3, 0);
    const mesh = new THREE.InstancedMesh(geo, material, this.capacity);
    mesh.name = 'maze:tokens';
    mesh.castShadow = true;
    mesh.receiveShadow = false;
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    /* Never culled as a unit. The instances are scattered over the whole
     * resident neighbourhood, so the bounding sphere Three computes from the
     * unit octahedron would cull the lot the moment the camera looked away from
     * the origin. */
    mesh.frustumCulled = false;
    this.mesh = mesh;
    for (let i = this.capacity - 1; i >= 0; i--) this._free.push(i);
    for (let i = 0; i < this.capacity; i++) this._writeSlot(i, null);
    mesh.instanceMatrix.needsUpdate = true;
    this.group.add(mesh);
  }

  _addToken(cell) {
    const slot = this._free.length ? this._free.pop() : -1;
    if (slot < 0) return null;
    const c = cellCoords(cell);
    const w = cellToWorld(c.x, c.z, c.level);
    const rec = {
      position: new THREE.Vector3(w.x, w.y + 0.6, w.z),
      taken: false,
      phase: tokenPhase(cell, this.seed),
      slot,
      cell,
    };
    this.tokens.push(rec);
    this._writeSlot(slot, rec.position);
    if (this.mesh) this.mesh.instanceMatrix.needsUpdate = true;
    return rec;
  }

  _freeSlot(slot) {
    this._writeSlot(slot, null);
    this._free.push(slot);
    if (this.mesh) this.mesh.instanceMatrix.needsUpdate = true;
  }

  /**
   * Write one instance matrix, or zero-scale it when `position` is null.
   *
   * An InstancedMesh has no per-instance visibility flag, only a matrix, so a
   * free slot is a slot scaled to nothing - the same trick the token pickup has
   * always used, applied to the free list as well so an unallocated slot cannot
   * draw a stray octahedron at the origin.
   */
  _writeSlot(slot, position) {
    if (!this.mesh || slot < 0) return;
    if (position) _mat.compose(position, _quat, _one);
    else _mat.compose(_zeroPos, _quat, _zero);
    this.mesh.setMatrixAt(slot, _mat);
  }
}

/* Module-scratch, never re-entrant - the same convention `MazeChunks` uses for
 * its mover matrix. */
const _mat = new THREE.Matrix4();
const _quat = new THREE.Quaternion();
const _one = new THREE.Vector3(1, 1, 1);
const _zero = new THREE.Vector3(0, 0, 0);
const _zeroPos = new THREE.Vector3(0, 0, 0);
