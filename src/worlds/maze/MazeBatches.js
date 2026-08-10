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
 *    LOD swap is built exactly as the plan hoped - BUT the write does NOT set
 *    `_visibilityChanged`, and with culling and sorting off (see below)
 *    `onBeforeRender` early-outs on that flag, so a bare id write would
 *    never reach the multi-draw list and the swap would silently not render.
 *    `setLod` therefore raises the flag itself, once per touched batch; the
 *    test suite pins the behaviour so a three upgrade that renames the field
 *    fails loudly instead of freezing every LOD where it stood.
 *  - Per-instance visibility (`setVisibleAt`) and per-geometry bounds with
 *    per-instance frustum culling (`perObjectFrustumCulled`) exist; the
 *    culling walks EVERY instance on the CPU every render pass (shadow pass
 *    included, via `onBeforeShadow`).
 *
 * That last point decides two flags below. With ~50k resident box instances
 * across the families, a per-instance sphere-vs-frustum walk twice a frame is
 * milliseconds of CPU to cull geometry a modern GPU rasterises in microseconds
 * - the boxes are 12 triangles each. So `sortObjects` is OFF everywhere, and
 * `perObjectFrustumCulled` is off by DEFAULT - which makes `onBeforeRender`
 * early-out entirely between residency changes: the multi-draw list is
 * rebuilt only when an instance is added, deleted or LOD-swapped, and a
 * settled frame costs the CPU nothing.
 *
 * Task 6 left a note here that Task 7's fatter LOD0 prefabs might want
 * per-instance culling back, as a measurement. MEASURED 2026-08-10 (seed
 * 2026, full bevels, LOD bands live, tower worst case at (1200,18.05,1200)):
 * culling OFF renders 5.34 M triangles at 36 fps - over the 5 M budget, and
 * ground level's 4.31 M was over its 3.5 M too, so the plan's own let-out
 * ("only touch it if the budget test cannot be met otherwise") applied.
 * Culling ON for `hedge` and `footing` only: tower 3.11 M at 41-48 fps,
 * ground worst 3.10 M - both budgets met, and fps went UP because the frame
 * is GPU-bound. Culling ON for all seven families: 3.07 M but 43 fps at
 * best - the CPU walk over the five small families costs more than the
 * ~74 k triangles it saves. Hence `cull: true` on exactly the two families
 * that are ~35 k of the ~38 k resident instances, and default-off elsewhere.
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
/* `stone` was measured at 28 (stair + shaftWall); Task 8 adds one `newel`
 * dressing instance per stair shaft, and no district across the 8,000
 * measured held more than one shaft - so the honest worst case is 29, held
 * at 30 for the same reason the table has headroom at all. The batch test
 * re-derives one seed's maxima INCLUDING newels per run. */
export const BATCH_PER_DISTRICT_MAX = Object.freeze({
  hedge: 446, floor: 4, stone: 30, tunnel: 27, footing: 446, plate: 2, candle: 70,
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
 *
 * `cull` opts a family into per-instance frustum culling - a measured
 * decision, not a default, and deliberately only on the two families that
 * carry ~35 k of the ~38 k resident instances. See the module note for the
 * numbers; culling the five small families measured SLOWER than leaving
 * them unculled, because the per-pass CPU walk outweighs their triangles.
 */
export const BATCH_FAMILIES = Object.freeze({
  hedge: { kinds: Object.freeze(['hedge']), castShadow: true, cull: true },
  floor: { kinds: Object.freeze(['floor']), castShadow: true },
  /* `newel` (Task 8) is the authored hero prop at each stair's well centre.
   * It joins `stone` rather than getting a family of its own because a
   * family is a MATERIAL: the newel is pale worked stonework drawn with the
   * exact stair material object (MazeMaterials aliases `newel` to `stair`,
   * like `shaftWall`), so batching it here costs zero extra draw calls and
   * zero programs - the loaded glTF's own material is discarded on load. */
  stone: { kinds: Object.freeze(['stair', 'shaftWall', 'newel']), castShadow: true },
  tunnel: { kinds: Object.freeze(['tunnel']), castShadow: true },
  footing: { kinds: Object.freeze(['footing']), castShadow: true, cull: true },
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
 * Task 2 stair sweep (136/276) is still its fattest member.
 *
 * RE-SIZED AGAIN FOR TASK 7: the LOD swap registers TWO geometries per
 * (kind, extent class) for every kind with an authored near tier - the LOD0
 * prefab and the plain far box - so the prefab COUNTS double for hedge,
 * floor, stone and footing (the registry collapses LOD1 and LOD2 to one
 * object, or they would triple - see `geometryLod` in MazeMeshes.js).
 * `floor` is the family that actually bites: 105 measured extent classes
 * (shaft-cut spans) x 2 tiers is 210 against the old 160 reservation, a
 * boot-time `addGeometry` throw waiting for a long walk. Counts below are
 * the measured class count x tiers with ~1.3-1.5x headroom; the two-tier
 * arithmetic is asserted against a real world in `maze-bevel.test.mjs`.
 * Total reserved vertex memory is ~45,000 vertices (~2 MB with attributes)
 * across the seven families - still well under one resident set's hedges.
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
/* RE-SIZED FOR TASK 8: `stone` gains the newel - the one authored prefab in
 * the world, and much the fattest member of any family: the shipped .glb is
 * 255 verts / 1344 indices (manifest-declared and test-held), the procedural
 * fallback 195 / 1008. Per-prefab reservations rise to 512 / 1536 so either
 * variant fits with margin; prefab count rises 24 -> 26 for the newel's slot
 * (one class, one tier - the registry hands the same object back at every
 * LOD, so it cannot double the way the two-tier kinds do). Pool cost of the
 * raise: 26 x 512 = 13,312 reserved verts (~0.6 MB with attributes) against
 * the old 4,608 - still under half of one resident set's hedges. */
export const GEOMETRY_BUDGET = Object.freeze({
  hedge: { prefabs: 32, verts: 96, indices: 132 },
  floor: { prefabs: 288, verts: 96, indices: 132 },
  stone: { prefabs: 26, verts: 512, indices: 1536 },
  tunnel: { prefabs: 16, verts: 24, indices: 36 },
  footing: { prefabs: 32, verts: 96, indices: 132 },
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
    /**
     * @type {Map<number, Array<[object, number, number, number]>>} district
     * key -> [family record, instance id, near geometry id, far geometry id].
     * Both tier ids are resolved at add time so a band change is nothing but
     * integer writes - no cache lookups on a path `updateResidency` runs for
     * every resident district.
     */
    this._resident = new Map();
    /** @type {Map<number, number>} district key -> the LOD its instances draw. */
    this._lods = new Map();
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
    /* Sorting and whole-object culling OFF for every family - see the module
     * note. Sorting buys nothing for opaque z-buffered boxes and costs an
     * O(n log n) pass over every instance per frame; and whole-object
     * culling tests a bounding sphere three computes ONCE from the
     * mostly-zero preallocated buffer and never refreshes as districts
     * stream, so it would eventually cull a batch that is squarely on
     * screen. Per-instance frustum culling is PER FAMILY and measured - on
     * for the two instance-heavy families, where it is the difference
     * between busting the triangle budgets and meeting them, and off for
     * the small ones, where the per-pass CPU walk measured slower than
     * just drawing them (numbers in the module note). A culled family
     * rebuilds its multi-draw list every pass by construction; an unculled
     * one still early-outs between residency changes. */
    batch.sortObjects = false;
    batch.perObjectFrustumCulled = fam.cull === true;
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
       * sight, never deleted - the append-only rule the module note argues.
       * BOTH tiers register here, eagerly: a district streams in far more
       * often than near (new keys appear at the residency rim), and resolving
       * the other tier lazily on the first band change would put addGeometry
       * - a buffer copy - inside `setLod`, which is meant to be integer
       * writes and nothing else. For a kind with no authored near tier the
       * registry hands back the SAME object for both (see `geometryLod` in
       * MazeMeshes.js), so nothing is registered twice. */
      const gidNear = this._geometryId(rec, prefabFor({ ...d, lod: 0 }));
      const gidFar = this._geometryId(rec, prefabFor({ ...d, lod: 2 }));
      const id = batch.addInstance(gidNear);
      /* TRANSLATION ONLY - the same contract buildBoxInstances carries, held
       * by the same source-level test. The extents are in the prefab. */
      _m.makeTranslation(d.cx, d.cy, d.cz);
      batch.setMatrixAt(id, _m);
      owned.push([rec, id, gidNear, gidFar]);
      if (!rec.inScene) {
        this.group.add(batch);
        rec.inScene = true;
      }
    }
    this._resident.set(key, owned);
    /* A fresh district's instances were written at the near tier; the caller
     * follows `add` with `setLod` in the same residency update, so a far
     * district never renders a near frame. */
    this._lods.set(key, 0);
  }

  /** The batch geometry id for a registry prefab, registering on first sight. */
  _geometryId(rec, geo) {
    let gid = rec.geomIds.get(geo);
    if (gid === undefined) {
      gid = rec.batch.addGeometry(geo);
      rec.geomIds.set(geo, gid);
    }
    return gid;
  }

  /**
   * Point district `key`'s instances at the geometry tier for LOD `lod`.
   *
   * This is the whole LOD mechanism: one integer write per instance, via
   * `setGeometryIdAt`, so a band change costs no draw calls, no allocator
   * churn and no instance count movement - the test suite asserts the count
   * is untouched, because remove-and-re-add is the churn path that fragments
   * an allocator, and it is exactly what this method exists to avoid.
   *
   * `THREE.LOD` was the obvious alternative and the wrong one: it swaps
   * whole Object3Ds, which would mean one scene object per hedge segment -
   * the thing batching exists to avoid.
   *
   * Idempotent and cheap when nothing changed: `updateResidency` calls this
   * for every resident district on every update, and the early-out is what
   * keeps a stationary player's frame free of the ~35,000 writes a naive
   * re-apply would cost (it is also what the no-thrash browser check leans
   * on: a settled camera means settled geometry ids, verbatim).
   */
  setLod(key, lod) {
    const owned = this._resident.get(key);
    if (!owned || this._lods.get(key) === lod) return;
    this._lods.set(key, lod);
    const far = lod > 0;
    for (const [rec, id, gidNear, gidFar] of owned) {
      /* Kinds with one tier have gidNear === gidFar; skipping them keeps the
       * touched set honest so an all-candle district raises no rebuild. */
      if (gidNear === gidFar) continue;
      const rb = rec.batch;
      rb.setGeometryIdAt(id, far ? gidFar : gidNear);
      /* three 0.185.1's setGeometryIdAt does not raise _visibilityChanged,
       * and with culling and sorting off onBeforeRender early-outs on that
       * flag - without this line the swap would never reach the multi-draw
       * list and every instance would render its stream-in tier forever.
       * A private field, knowingly: the alternative was toggling
       * setVisibleAt(false)/(true) per instance purely for its side effect,
       * which is the same write dressed as two. Pinned by the test suite so
       * a three upgrade fails loudly here rather than silently freezing LODs. */
      rb._visibilityChanged = true;
    }
  }

  /** The LOD district `key` currently draws, or undefined when not resident. */
  lodOf(key) {
    return this._lods.get(key);
  }

  /**
   * Triangles the batches would submit to ONE camera pass right now - the
   * headless side of `renderer.info.render.triangles`, priced from the same
   * ledger `setLod` writes. The triangle-budget test sums this at full
   * residency instead of standing up a renderer, which is the same trick
   * every collision gate in the repo leans on.
   */
  submittedTriangles() {
    let n = 0;
    const range = {};
    for (const owned of this._resident.values()) {
      for (const [rec, id] of owned) {
        rec.batch.getGeometryRangeAt(rec.batch.getGeometryIdAt(id), range);
        n += range.count / 3;
      }
    }
    return n;
  }

  /**
   * Release a district's instances - exactly its own, nobody else's. A batch
   * whose last instance leaves also leaves the scene, so "nothing resident"
   * still means an empty group and the leak tests keep their exact equality.
   */
  drop(key) {
    const owned = this._resident.get(key);
    if (!owned) return;
    this._lods.delete(key);
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
    this._lods.clear();
  }
}
