import * as THREE from 'three';
import { prefabFor } from './MazeMeshes.js';

/**
 * One `THREE.BatchedMesh` per material family, with a per-district instance
 * ledger - the `MazeCanopy` pattern (single pooled mesh, worst-case capacity
 * derived from the radius) applied to the streamed district set.
 *
 * ## Why this exists
 *
 * Task 1 moved the extents into the geometry, so same-size-different-
 * orientation boxes stopped sharing an InstancedMesh and `MazeChunks.ensure`
 * came to build up to ~14 meshes per district. At the full 43-district
 * residency that measured 909 draw calls (seed 2026, from a tower), against
 * a phase target of <= 120 in a corridor and <= 180 from a tower. A
 * BatchedMesh draws every instance of every geometry it holds in ONE
 * multi-draw call, so the whole static maze collapses to one draw per family
 * per render pass, however many districts are resident.
 *
 * ## What the installed three 0.185.1 actually provides
 *
 * Read from `node_modules/three/src/objects/BatchedMesh.js`, not from memory:
 *
 *  - `addGeometry(geometry)` copies the geometry into a preallocated shared
 *    buffer (capacity fixed at construction; exceeding it THROWS, loudly).
 *  - `addInstance(geometryId)` - any number of instances per geometry id, up
 *    to `maxInstanceCount`. Also throws at capacity rather than corrupting.
 *  - `deleteInstance(id)` is O(1): it marks the slot inactive and recycles the
 *    id through `_availableInstanceIds`. No buffer traffic, no compaction.
 *  - `setGeometryIdAt(instanceId, geometryId)` EXISTS - one integer write to
 *    repoint an instance at another resident geometry. Task 7's per-instance
 *    LOD swap can be built exactly as the plan hopes.
 *  - Per-instance visibility (`setVisibleAt`) and per-geometry bounds with
 *    per-instance frustum culling (`perObjectFrustumCulled`) exist; the
 *    culling walks EVERY instance on the CPU every render pass (shadow pass
 *    included, via `onBeforeShadow`).
 *
 * That last point decides two flags below. With ~50k resident box instances
 * across the families, a per-instance sphere-vs-frustum walk twice a frame is
 * milliseconds of CPU to cull geometry a modern GPU rasterises in microseconds
 * - the boxes are 12 triangles each. So `perObjectFrustumCulled` and
 * `sortObjects` are both switched OFF, which makes `onBeforeRender` early-out
 * entirely between residency changes: the multi-draw list is rebuilt only when
 * an instance is added or deleted, and a settled frame costs the CPU nothing.
 * Task 7's LOD0 prefabs (60+ triangles) may want per-instance culling back for
 * their family; that is a measurement for Task 7, not a default for this one.
 *
 * ## The rule that makes fragmentation impossible
 *
 * **Geometries are added once and never deleted; streaming is
 * `addInstance` / `deleteInstance` only.** Deleting a geometry from a batch
 * frees a hole in the middle of the shared vertex buffer, holes eventually
 * force `optimize()`, and `optimize()` is a rebuild by another name. An
 * append-only geometry buffer can never need either - which is why the test
 * suite greps this file for the geometry-deleting API rather than trusting
 * the intention (and why this comment names it obliquely).
 *
 * Prefabs register lazily, on the first district that needs one, rather than
 * by enumerating every extent class at construction: enumeration would mean
 * scanning all 1600 districts' descriptors at world build (~a second the
 * player would pay on every entry), and lazy registration is identical for
 * fragmentation purposes because the buffer is append-only either way.
 *
 * ## Capacity is derived, never hand-written
 *
 * `MazeCanopy`'s lesson: a pool sized by a literal silently starves the day
 * the radius changes. Instance capacity per family is a measured per-district
 * worst case times the worst-case resident-district count for the radius,
 * plus stated headroom - see `worstCaseInstances`. Geometry capacity gets the
 * same treatment via `GEOMETRY_BUDGET`, and both overflows fail loudly inside
 * three rather than corrupting a neighbour's slot.
 *
 * ## One batch per what, exactly?
 *
 * The plan says "one batch per program family" (`MAZE_PROGRAM_FAMILIES`, 3
 * entries). A BatchedMesh, however, draws with exactly ONE material, and the
 * kinds inside a program family differ in uniforms and maps - hedge and floor
 * carry different colour maps, stair and tunnel different emissives. Flatten
 * those into one batch and the corridor visibly changes colour, which Task 6
 * is forbidden to do ("visuals unchanged"). So a family here is a group of
 * kinds sharing one MATERIAL OBJECT - seven batches instead of three. The
 * difference is four draw calls per pass against a budget of 120, and it is
 * what keeps every surface pixel-identical to the InstancedMesh path it
 * replaces. The moving kinds (lift, liftDoor, gate, slideWall) and the
 * non-box dressing (sprigs, ivy, the daylight columns) stay on their existing
 * paths, exactly as the plan carves out.
 */

/**
 * The districts either side of the player on their own level. MUST equal the
 * `RESIDENCY_RADIUS` in `MazeWorld.js` - this module cannot import it from
 * there (the world file cannot load headless), so the two are pinned together
 * by a source-level test in `scripts/tests/maze-batches.test.mjs`.
 */
export const RESIDENCY_RADIUS = 2;

/** The ring streamed on each level adjacent to the player's - see `updateResidency`. */
const ADJACENT_RING_RADIUS = 1;

/**
 * The most districts `updateResidency` can ever hold resident at once: the
 * full block on the player's own level plus a ring on each neighbouring level
 * (a player on level 1 or 2 has one above AND one below).
 */
export function worstCaseResidency(radius) {
  return (2 * radius + 1) ** 2 + 2 * (2 * ADJACENT_RING_RADIUS + 1) ** 2;
}

/**
 * The most instances one district has ever been measured to emit, per family.
 *
 * MEASURED 2026-08-09 over every district of every level of seeds 1, 7, 42,
 * 2026 and 77771 - 8,000 districts - including the footing, plate and candle
 * boxes `MazeChunks.ensure` synthesises alongside the collider descriptors:
 *
 *   hedge 446, footing 446, candle 70, stone (stair+shaftWall) 28,
 *   tunnel 27, floor 4, plate 2.
 *
 * Baked rather than re-measured at boot because the measurement is a full-map
 * descriptor sweep (~0.8 s) the player would pay on every entry; the test
 * suite re-derives one seed's maxima per run so the bake cannot quietly rot.
 */
export const BATCH_PER_DISTRICT_MAX = Object.freeze({
  hedge: 446, floor: 4, stone: 28, tunnel: 27, footing: 446, plate: 2, candle: 70,
});

/**
 * Headroom multiplier on the measured per-district maxima. Five seeds is a
 * sample, not a proof; a quarter again covers an unluckier seed at a cost of
 * a few hundred kilobytes of matrix texture per family.
 */
const CAPACITY_HEADROOM = 1.25;

/**
 * The worst-case instance count a family's batch must hold for a residency
 * radius. Pure arithmetic over the measured table, so the capacity test runs
 * headless and the constructor cannot drift from it.
 */
export function worstCaseInstances(family, radius) {
  const perDistrict = BATCH_PER_DISTRICT_MAX[family];
  if (perDistrict === undefined) throw new Error(`MazeBatches: unknown family '${family}'`);
  return Math.ceil(perDistrict * CAPACITY_HEADROOM) * worstCaseResidency(radius);
}

/** The capacity every constructed batch is given - the derivation, applied. */
export function batchCapacity(family) {
  return worstCaseInstances(family, RESIDENCY_RADIUS);
}

/**
 * The batch families: groups of kinds that share one material object (see the
 * module note on why the unit is the material, not the program family).
 * `stone` leans on `MazeMaterials` aliasing `shaftWall` to the stair material
 * - pinned by a test, because the batch would silently repaint one of them if
 * the aliasing ever broke.
 *
 * `castShadow` is per family because it is per mesh: plates and candles never
 * cast (they never did as InstancedMeshes - a candle's shadow of itself is
 * noise, and there are thousands), everything structural does.
 */
export const BATCH_FAMILIES = Object.freeze({
  hedge: { kinds: Object.freeze(['hedge']), castShadow: true },
  floor: { kinds: Object.freeze(['floor']), castShadow: true },
  stone: { kinds: Object.freeze(['stair', 'shaftWall']), castShadow: true },
  tunnel: { kinds: Object.freeze(['tunnel']), castShadow: true },
  footing: { kinds: Object.freeze(['footing']), castShadow: true },
  plate: { kinds: Object.freeze(['plate']), castShadow: false },
  candle: { kinds: Object.freeze(['candle']), castShadow: false },
});

/** kind -> family name, derived so the two can never disagree. */
const KIND_FAMILY = {};
for (const [name, fam] of Object.entries(BATCH_FAMILIES)) {
  for (const k of fam.kinds) KIND_FAMILY[k] = name;
}

/**
 * Geometry-buffer reservations per family: how many DISTINCT prefabs a batch
 * may ever register, and the vertex/index worst case of one prefab.
 *
 * MEASURED 2026-08-09 alongside the instance maxima: distinct (kind, extent
 * class) counts within a single seed's whole map are floor 105 (the spans a
 * shaft cuts a slab into vary continuously), hedge 12, footing 12, stone 8,
 * tunnel 8, candle 1, plate 1; a box prefab is 24 vertices / 36 indices and
 * the Task 2 stair prefab 136 / 276. Reservations are those numbers with
 * roughly 1.5x headroom.
 *
 * RE-SIZED FOR TASK 4: a bevelled kind's LOD0 prefab is the 26-facet
 * chamfered box - 96 vertices / 132 indices, measured from the geometry and
 * asserted per family against a real world in `maze-bevel.test.mjs`, because
 * a reservation still sized for the 24-vertex box would make `addGeometry`
 * throw at boot on the first district streamed. `stone` keeps 192/384: the
 * Task 2 stair sweep (136/276) is still its fattest member. `hedge` and
 * `footing` draw the plain box TODAY (their bevel is deferred to Task 7's
 * LOD swap - see BEVELLED_KINDS in MazeMeshes.js for the measurement) but
 * their reservations are sized for the bevelled prefab anyway: the deferral
 * is a triangle-budget decision, not a buffer one, and a reservation that
 * shrank now would be the boot-time throw waiting for Task 7. Total reserved
 * vertex memory rises from ~9,000 to ~24,000 vertices across the seven
 * families - still under one district's hedges, so padding stays free.
 *
 * The registry's global PREFAB_BUDGET (192) bounds what the world ACTUALLY
 * caches; these reservations may sum past it because each is padded
 * independently - they bound what a family could ever ask its buffer to
 * hold, and `addGeometry` throws loudly if a seed somehow outgrows one,
 * which is the failure mode we want: an error naming the buffer, not a
 * corrupted wall.
 *
 * Exported for the reservation test, not for callers - `batchFor` is the one
 * consumer that sizes anything from it.
 */
export const GEOMETRY_BUDGET = Object.freeze({
  hedge: { prefabs: 24, verts: 96, indices: 132 },
  floor: { prefabs: 160, verts: 96, indices: 132 },
  stone: { prefabs: 16, verts: 192, indices: 384 },
  tunnel: { prefabs: 16, verts: 24, indices: 36 },
  footing: { prefabs: 24, verts: 96, indices: 132 },
  plate: { prefabs: 8, verts: 24, indices: 36 },
  candle: { prefabs: 8, verts: 24, indices: 36 },
});

/** Scratch for instance placement. One per module, never re-entrant. */
const _m = new THREE.Matrix4();

export class MazeBatches {
  /**
   * @param {{ materials: {[kind:string]: THREE.Material}, group: THREE.Group }} ctx
   */
  constructor({ materials, group }) {
    this.materials = materials;
    this.group = group;
    /** @type {Map<string, {batch: THREE.BatchedMesh, geomIds: Map<THREE.BufferGeometry, number>, inScene: boolean}>} */
    this._families = new Map();
    /** @type {Map<number, Array<[object, number]>>} district key -> [family record, instance id] */
    this._resident = new Map();
  }

  /**
   * The family's BatchedMesh, built on first need.
   *
   * Lazy for the same defensive reason `MazeCanopy._ensureMesh` is - a batch
   * asked for after `disposeAll` comes back rather than dereferencing a
   * corpse - and for one of its own: the mover tests construct dozens of
   * MazeChunks while searching seeds for a lift, and seven eager batches per
   * construction is several megabytes of typed arrays each time for
   * districts that mostly hold two families.
   */
  batchFor(family) {
    let rec = this._families.get(family);
    if (rec) return rec.batch;

    const fam = BATCH_FAMILIES[family];
    if (!fam) throw new Error(`MazeBatches: unknown family '${family}'`);
    const gb = GEOMETRY_BUDGET[family];
    const batch = new THREE.BatchedMesh(
      batchCapacity(family),
      gb.prefabs * gb.verts,
      gb.prefabs * gb.indices,
      this.materials[fam.kinds[0]],
    );
    batch.name = `maze:batch:${family}`;
    batch.castShadow = fam.castShadow;
    batch.receiveShadow = true;
    /* All three culling/sorting switches OFF - see the module note. Sorting
     * buys nothing for opaque z-buffered boxes and costs an O(n log n) pass
     * over every instance per frame; per-instance frustum culling costs a
     * matrix read and a sphere transform per instance per pass to save the
     * GPU twelve triangles each; and whole-object culling tests a bounding
     * sphere three computes ONCE from the mostly-zero preallocated buffer and
     * never refreshes as districts stream, so it would eventually cull a
     * batch that is squarely on screen. With the first two off,
     * `onBeforeRender` early-outs between residency changes and a settled
     * frame costs the CPU nothing at all. */
    batch.sortObjects = false;
    batch.perObjectFrustumCulled = false;
    batch.frustumCulled = false;

    rec = { batch, geomIds: new Map(), inScene: false };
    this._families.set(family, rec);
    return rec.batch;
  }

  /**
   * Register a district's boxes. Descriptors whose kind no family owns (the
   * movers, anything new) are ignored - their paths are their own. Safe to
   * call once per key; a second call for a resident key is a no-op, mirroring
   * `MazeChunks.ensure`.
   *
   * @param {number} key district key
   * @param {Array<{kind:string,cx:number,cy:number,cz:number,hx:number,hy:number,hz:number}>} descs
   */
  add(key, descs) {
    if (this._resident.has(key)) return;
    const owned = [];
    for (const d of descs) {
      const family = KIND_FAMILY[d.kind];
      if (!family) continue;
      const batch = this.batchFor(family);
      const rec = this._families.get(family);
      /* The prefab is the registry's cached geometry, so object identity is a
       * stable key for "already copied into this batch". Registered on first
       * sight, never deleted - the append-only rule the module note argues. */
      const geo = prefabFor(d);
      let gid = rec.geomIds.get(geo);
      if (gid === undefined) {
        gid = batch.addGeometry(geo);
        rec.geomIds.set(geo, gid);
      }
      const id = batch.addInstance(gid);
      /* TRANSLATION ONLY - the same contract buildBoxInstances carries, held
       * by the same source-level test. The extents are in the prefab. */
      _m.makeTranslation(d.cx, d.cy, d.cz);
      batch.setMatrixAt(id, _m);
      owned.push([rec, id]);
      if (!rec.inScene) {
        this.group.add(batch);
        rec.inScene = true;
      }
    }
    this._resident.set(key, owned);
  }

  /**
   * Release a district's instances - exactly its own, nobody else's. A batch
   * whose last instance leaves also leaves the scene, so "nothing resident"
   * still means an empty group and the leak tests keep their exact equality.
   */
  drop(key) {
    const owned = this._resident.get(key);
    if (!owned) return;
    for (const [rec, id] of owned) rec.batch.deleteInstance(id);
    for (const rec of this._families.values()) {
      if (rec.inScene && rec.batch.instanceCount === 0) {
        this.group.remove(rec.batch);
        rec.inScene = false;
      }
    }
    this._resident.delete(key);
  }

  /** Live instances across every family - the ledger the tests assert on. */
  instanceCount() {
    let n = 0;
    for (const rec of this._families.values()) n += rec.batch.instanceCount;
    return n;
  }

  /** How many batches are in the scene right now - `objectCount`'s share. */
  meshCount() {
    let n = 0;
    for (const rec of this._families.values()) {
      if (rec.inScene) n += 1;
    }
    return n;
  }

  /**
   * World teardown. The batches own their merged buffers and data textures -
   * `BatchedMesh.dispose` frees both - and the prefab geometries they copied
   * FROM belong to the registry, released separately by `releasePrefabs` in
   * `MazeChunks.disposeAll`. Maps are cleared rather than the instance being
   * marked dead so a stray later `add` rebuilds lazily, exactly as
   * `MazeCanopy` survives the same misuse.
   */
  disposeAll() {
    for (const rec of this._families.values()) {
      if (rec.inScene) this.group.remove(rec.batch);
      rec.batch.dispose();
    }
    this._families.clear();
    this._resident.clear();
  }
}
