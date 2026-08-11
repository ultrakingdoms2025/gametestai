import * as THREE from 'three';
import { MAZE, DIR, districtCoords, districtAtWorld, neighbourhoodKeys } from './MazeTopology.js';
import { districtColliders } from './MazeColliders.js';
import {
  foliageTransforms, footingTransforms, candlePlacements, shaftIvyTransforms,
  wellLightColumns, WELL_LIGHT_RADIUS, newelPlacements, NEWEL_HALF,
} from './MazeFoliage.js';
import { PLATE_HALF_HEIGHT, PLATE_HALF_WIDTH } from './MazeShafts.js';
/* The geometry seam. This class turns descriptors into instance matrices and
 * nothing else now - the extents live in the prefab, so what arrives here is a
 * cached geometry already built at world scale and a matrix carrying only
 * where to put it. See MazeMeshes.js for why that separation is what lets the
 * art change without any headless proof being re-run. */
import { prefabFor, groupByExtentClass, isPrefab, releasePrefabs } from './MazeMeshes.js';
/* The LOD bands, pure. One definition, shared with the headless triangle-
 * budget test, so the bands the browser renders are the bands the suite
 * priced. See MazeProfiles.js for the derivation. */
import { lodFor } from './MazeProfiles.js';
/* The draw-call seam. Static boxes no longer get an InstancedMesh per
 * (district, kind, extent class) - they are instances in one shared
 * BatchedMesh per material family, and streaming a district is addInstance /
 * deleteInstance against those. See MazeBatches.js for the measurements and
 * for why the moving kinds are exempt. */
import { MazeBatches } from './MazeBatches.js';

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
/**
 * One authored point light per resident district.
 *
 * `LightRig` owns a FIXED set of slot lights and treats every other light in
 * the scene as a source: it walks the scene each frame, hides what it finds and
 * copies the best-scoring few into those slots. The light counts baked into
 * every shader cache key are therefore constant however many a world authors -
 * the station authors 65 - so this costs no programs.
 *
 * Three commits in Phases 2b and 2c claimed the opposite and gave the shafts
 * emissive materials on the grounds that a lamp was impossible. The emissive
 * treads were a reasonable answer; the reason was a misreading of LightRig.
 *
 * Created HIDDEN, and that part matters. The rig would hide it anyway, but not
 * until its next walk, and a light that is visible for one frame is a light
 * that can trigger a compile. Starting hidden costs nothing - the rig takes it
 * as a source either way.
 */
/** A candle flame: small, warm, short-range - a pool of light, not a floodlight. */
const CANDLE_COLOUR = 0xffbe6e;
const CANDLE_INTENSITY = 13;
const CANDLE_RANGE = 19;

const LANTERN_COLOUR = 0xffd9a0;
const LANTERN_INTENSITY = 38;
/** Bounded to its own district, so the rig's distance scoring is meaningful. */
const LANTERN_RANGE = MAZE.DISTRICT * MAZE.CELL * 0.75;

export const CHUNK_MESH_KINDS = Object.freeze([
  'hedge', 'floor', 'stair', 'shaftWall', 'lift', 'liftDoor', 'tunnel', 'gate', 'slideWall',
]);

/**
 * The kinds that MOVE, and therefore need their instance matrix rewritten when
 * their collider does.
 *
 * `gate` and `slideWall` were absent from the mesh list entirely until this was
 * written - a gate was a solid, invisible wall across a corridor. The lift car
 * and its door were worse, because they looked fine standing still: measured on
 * real geometry, a car's collider rode the full 8.700 m to the landing while
 * its mesh sat at 0.150, so the player rode an invisible platform and watched
 * the visible car never leave the bottom. Colliders come from descriptors and
 * meshes come from descriptors, but nothing had ever kept the two in step once
 * the descriptor's own `cy` stopped being the truth.
 */
const MOVING_KINDS = Object.freeze(['lift', 'liftDoor', 'gate', 'slideWall']);

/** Scratch for the instance-matrix rewrite. One per module, never re-entrant. */
const _moverMat = new THREE.Matrix4();

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
   *                        stair: THREE.Material, shaftWall: THREE.Material } }} ctx
   */
  constructor({ world, cells, group, materials, puzzles = null, assets = null }) {
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
    /* Which cells carry a puzzle, handed down from the world. `districtColliders`
     * has no seed and must not gain one - placement is a seed-and-graph
     * decision - so it is made once at build time and passed as a plain cell
     * lookup. Null for the headless gates, which then see no puzzles at all. */
    this.puzzles = puzzles;
    /* The authored-asset map `MazeAssets.loadMazeAssets()` resolved, or null
     * when the world built without one (every headless test does). Threaded
     * onto the newel descriptors in `ensure` so `prefabFor` can prefer the
     * .glb; a null here simply means every newel is the procedural fallback,
     * which is the pipeline's whole degradation contract. */
    this.assets = assets;
    /* The shared per-family batches every static box draws through. Owned
     * here because their lifecycle IS the residency lifecycle: `ensure` adds
     * a district's instances, `drop` deletes exactly them, and `disposeAll`
     * takes the batches down with the world. */
    this.batches = new MazeBatches({ materials, group });
    /** @type {Map<number, { meshes: THREE.InstancedMesh[], colliders: any[] }>} */
    this._resident = new Map();
    /** Live lifts, keyed by CONNECTOR CELL - see the lift section below. */
    this._lifts = new Map();
    /** Live one-way gates, keyed by the cell they stand at. */
    this._gates = new Map();
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

  /**
   * Exactly how many scene objects this class owns right now.
   *
   * Per-district objects (the movers' InstancedMeshes, the dressing, one
   * lantern and any candle flames) PLUS the shared per-family batches
   * currently in the scene - a batch is owned here too, via `this.batches`,
   * it is just not owned by any one district. Exposed so the leak test can
   * assert an EQUALITY rather than an upper bound: the bound it used ("hedges
   * and a floor per district") was already loose once stairs, shafts, lifts
   * and tunnels gained their own mesh kinds, and it broke outright when
   * districts gained a light. An exact count cannot rot the same way - and
   * when the static kinds moved into the batches, the count moved WITH them
   * rather than being weakened, which is what keeps "the scene holds exactly
   * what this class accounts for" a meaningful sentence.
   */
  objectCount() {
    let n = this.batches.meshCount();
    for (const e of this._resident.values()) {
      n += e.meshes.length + (e.lantern ? 1 : 0) + (e.flames?.length ?? 0);
    }
    return n;
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
    const descs = districtColliders(this.cells, dx, dz, level, this.puzzles);

    const colliders = [];
    for (const d of descs) {
      const c = this.physics.addBox(d.cx, d.cy, d.cz, d.hx, d.hy, d.hz);
      colliders.push(c);
      this.worldColliders.push(c);
      /* Paired by construction: this is the collider built from THIS
       * descriptor, in the same iteration. Searching the collider array for a
       * matching position afterwards would pick the wrong box the day two
       * coincide. */
      this._registerMover(d, c, key);
    }

    const meshes = [];
    /* Every static box this district wants drawn, collected for one
     * `batches.add` at the end of this method. The batch draws all of them in
     * one multi-draw call per material family, which is the entire point of
     * Task 6: an InstancedMesh per (district, kind, extent class) measured 909
     * draw calls at full residency, ~21 of them per district, and the batches
     * collapse that to one per family however many districts are live. */
    const batched = [];
    for (const kind of CHUNK_MESH_KINDS) {
      const of = descs.filter((d) => d.kind === kind);
      /* Only the MOVING kinds still get a per-district InstancedMesh. A mover
       * pairs its descriptor to an instance index whose matrix `stepLifts` and
       * `stepGates` rewrite every frame, and both safety interlocks are proved
       * against exactly that pairing - four small meshes per shaft district is
       * the wrong place to spend batching risk. Everything else goes to the
       * shared batches, which need no extent-class grouping at all: a batch
       * holds many geometries, so the split that InstancedMesh forced
       * (`groupByExtentClass`) simply does not arise on this path. */
      if (!MOVING_KINDS.includes(kind)) {
        batched.push(...of);
        continue;
      }
      for (const run of groupByExtentClass(of)) {
        const mesh = buildBoxInstances(
          run.descs, this.materials[kind], `maze:${kind}:${run.cls}:${key}`, this.group,
        );
        if (!mesh) continue;
        meshes.push(mesh);
        /* Hand each moving part the mesh and the instance index it lives at, so
         * the step functions can carry the geometry along with the collider. The
         * index is the descriptor's position within THIS run, which is exactly
         * the order `buildBoxInstances` wrote them in - the same
         * paired-by-construction argument the collider loop above makes, and for
         * the same reason: searching for the instance nearest a position would
         * pick the wrong one the day two coincide. Grouping happens here in the
         * open, rather than inside `buildBoxInstances`, precisely so this
         * pairing keeps holding against the exact list that was written. */
        mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
        for (let i = 0; i < run.descs.length; i++) this._attachMoverMesh(run.descs[i], mesh, i);
      }
    }

    /* Dressing: a stone band at each hedge's base, and unkempt growth along
     * its top edge. Both are MESH ONLY and never touch `colliders` - foliage
     * sits in the 0.45-5.0m band, where section 2 permits a prop only if it is
     * non-collidable, and the footing matches the hedge footprint exactly so
     * the hedge's own collider already covers it. See MazeFoliage.js. */
    const footings = footingTransforms(descs);
    if (footings.length && this.materials.footing) {
      /* Dressing carries a `kind` too. It is exempt from the fit contract -
       * nothing here reaches a collider descriptor - but it is NOT exempt from
       * the registry, because a footing is a box like any other and paying for
       * it out of the shared cache is free. The kind is what stops a footing
       * and a hedge of coincidentally equal extents sharing one geometry, which
       * would matter the moment either grows a profile of its own. */
      batched.push(...footings.map((f) => ({
        kind: 'footing', cx: f.x, cy: f.y, cz: f.z, hx: f.hx, hy: f.hy, hz: f.hz,
      })));
    }
    const sprigs = foliageTransforms(descs, key);
    if (sprigs.length && this.materials.foliage) {
      const sm = buildSprigInstances(sprigs, this.materials.foliage, `maze:foliage:${key}`, this.group);
      if (sm) meshes.push(sm);
    }

    /* Ivy up the tower shafts - section 10's "ivy-clad tower shafts". Only
     * districts holding a shaft grow any, so this is one extra draw call in
     * the handful of districts that have one and none at all in the rest. */
    const ivy = shaftIvyTransforms(descs, key);
    if (ivy.length && this.materials.ivy) {
      const im = buildSprigInstances(ivy, this.materials.ivy, `maze:ivy:${key}`, this.group);
      if (im) meshes.push(im);
    }

    /* Hedge candles. Many meshes, few lights - see `candlePlacements`. The
     * meshes are what you see; the rig only ever renders the nearest twelve
     * point lights in the scene, so more lights than that per district buys
     * nothing on screen and still costs a per-frame scan. */
    /* The pressure plates. MESH ONLY - the trigger is a position test, so a
     * plate needs no collider, and at 8 cm tall nothing needs to stand on one.
     * Derived from the wall descriptors rather than emitted alongside them so
     * a wall and its plate can never disagree about where the plate is. */
    const plates = descs.filter((d) => d.kind === 'slideWall' && d.plate);
    if (plates.length && this.materials.plate) {
      /* Batched like everything static; the plate family's batch carries the
       * castShadow=false these meshes used to set individually. */
      batched.push(...plates.map((d) => ({
        kind: 'plate', cx: d.plate.x, cy: d.plate.y, cz: d.plate.z,
        hx: PLATE_HALF_WIDTH, hy: PLATE_HALF_HEIGHT, hz: PLATE_HALF_WIDTH,
      })));
    }

    /* Daylight down the towers. Two meshes at most per district and only in the
     * districts that hold a shaft, both additive and both depth-write off, so
     * they cost no sorting and cannot occlude anything. See
     * `wellLightColumns` for why a shaft is the only place light can come from
     * on a roofed level. */
    const wells = wellLightColumns(this.cells, dx, dz, level);
    if (wells.length && this.materials.wellLight) {
      const geo = new THREE.CylinderGeometry(WELL_LIGHT_RADIUS * 0.55, WELL_LIGHT_RADIUS, 1, 12, 1, true);
      const col = new THREE.InstancedMesh(geo, this.materials.wellLight, wells.length);
      col.name = `maze:wellLight:${key}`;
      col.castShadow = false;
      col.receiveShadow = false;
      /* Drawn last. An additive column with depth-write off still has to be
       * rendered after the geometry behind it or it blends against whatever
       * was in the buffer at the time. */
      col.renderOrder = 2;
      const m = new THREE.Matrix4();
      const q = new THREE.Quaternion();
      const pos = new THREE.Vector3();
      const scl = new THREE.Vector3();
      for (let i = 0; i < wells.length; i++) {
        const c = wells[i];
        pos.set(c.x, c.y + c.height / 2, c.z);
        scl.set(1, c.height, 1);
        m.compose(pos, q, scl);
        col.setMatrixAt(i, m);
      }
      col.instanceMatrix.needsUpdate = true;
      this.group.add(col);
      meshes.push(col);

      /* And the ~1.2 m2 of daylight on the well floor the spec asks for - the
       * bright patch where the column lands, which is the whole reason the
       * column reads as light rather than as fog. */
      if (this.materials.wellPool) {
        const disc = new THREE.CircleGeometry(WELL_LIGHT_RADIUS * 0.62, 16);
        const pool = new THREE.InstancedMesh(disc, this.materials.wellPool, wells.length);
        pool.name = `maze:wellPool:${key}`;
        pool.castShadow = false;
        pool.receiveShadow = false;
        pool.renderOrder = 1;
        const pm = new THREE.Matrix4();
        const pq = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), -Math.PI / 2);
        const pp = new THREE.Vector3();
        const ps = new THREE.Vector3(1, 1, 1);
        for (let i = 0; i < wells.length; i++) {
          /* Just proud of the floor: coplanar with it would z-fight, and this
           * world's floors are flat slabs so a centimetre is plenty. */
          pp.set(wells[i].x, wells[i].y + 0.012, wells[i].z);
          pm.compose(pp, pq, ps);
          pool.setMatrixAt(i, pm);
        }
        pool.instanceMatrix.needsUpdate = true;
        this.group.add(pool);
        meshes.push(pool);
      }
    }

    /* The shaft newel - Task 8's hero prop, one per stair shaft, standing at
     * the exact centre of the spiral. Dressing (mesh only, never a collider;
     * see DRESSING_KINDS in MazeMeshes.js), batched with the stone family so
     * it costs zero extra draw calls, and carrying the assets map so the
     * prefab registry can serve the authored .glb when it loaded and the
     * procedural finial when it did not. */
    const newels = newelPlacements(this.cells, dx, dz, level);
    if (newels.length && this.materials.newel) {
      batched.push(...newels.map((n) => ({
        kind: 'newel', cx: n.x, cy: n.y, cz: n.z,
        hx: NEWEL_HALF.hx, hy: NEWEL_HALF.hy, hz: NEWEL_HALF.hz,
        assets: this.assets,
      })));
    }

    const candles = candlePlacements(descs, key);
    if (candles.length && this.materials.candle) {
      /* Batched; castShadow=false lives on the candle family's batch now. */
      batched.push(...candles.map((cd) => ({
        kind: 'candle', cx: cd.x, cy: cd.y, cz: cd.z, hx: 0.09, hy: 0.26, hz: 0.09,
      })));
    }
    const flames = [];
    for (const cd of candles) {
      if (!cd.lit) continue;
      /* Hidden on creation, exactly like the district lantern - the rig would
       * hide it anyway but not until its next walk, and one visible frame is
       * one frame that can compile. */
      const f = new THREE.PointLight(CANDLE_COLOUR, CANDLE_INTENSITY, CANDLE_RANGE);
      f.visible = false;
      f.position.set(cd.x, cd.y + 0.18, cd.z);
      this.group.add(f);
      flames.push(f);
    }

    /* The district's lantern. See LANTERN_COLOUR above for why this is free. */
    const w0 = districtCoords(key);
    const cx = (w0.dx * MAZE.DISTRICT + MAZE.DISTRICT / 2) * MAZE.CELL;
    const cz = (w0.dz * MAZE.DISTRICT + MAZE.DISTRICT / 2) * MAZE.CELL;
    const lantern = new THREE.PointLight(LANTERN_COLOUR, LANTERN_INTENSITY, LANTERN_RANGE);
    lantern.visible = false;
    lantern.position.set(cx, w0.level * MAZE.LEVEL_HEIGHT + MAZE.HEDGE_HEIGHT * 0.8, cz);
    this.group.add(lantern);

    /* Every static box at once, at the end, so the batch ledger for this key
     * is written exactly once whatever mix of kinds the district turned out
     * to hold. `drop` releases precisely this set. */
    this.batches.add(key, batched);

    this._resident.set(key, { meshes, colliders, lantern, flames });
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

    this._unregisterMovers(key);
    /* The district's share of the shared batches - deleteInstance only, never
     * a geometry, so eviction can never fragment the batch. */
    this.batches.drop(key);

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
      /* NOT the prefabs. A registry geometry is shared by every district that
       * happens to hold a box of that size, so freeing it here would pull the
       * buffer out from under the neighbours still drawing with it - and it
       * would come straight back on their next frame, so the symptom would be
       * churn rather than a missing wall. The dressing geometry a district
       * builds for itself (foliage, ivy, the daylight column and its pool) is
       * genuinely this district's and does still go. See MazeMeshes.isPrefab. */
      if (!isPrefab(m.geometry)) m.geometry.dispose();
      /* InstancedMesh's instanceMatrix buffer is only released through the
       * mesh's own dispose event - geometry.dispose() alone strands it, at
       * 64 bytes per instance. */
      m.dispose();
    }
    /* The lantern goes with its district, or a walk across the maze would
     * leave one behind every 120 m and the rig would score an ever-growing
     * source list. */
    if (entry.lantern) {
      this.group.remove(entry.lantern);
      entry.lantern.dispose?.();
    }
    for (const f of entry.flames ?? []) {
      this.group.remove(f);
      f.dispose?.();
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
    /* The prefabs go here and only here. This is world teardown - the one
     * moment at which no district is drawing with any of them - and it is not
     * optional tidying: this world re-rolls its seed on every entry, and a new
     * seed cuts its floors into differently-sized spans, so a cache that never
     * emptied would gain a few dozen geometries per visit for as long as the
     * session lasted.
     *
     * Last, after the district loop, so the `isPrefab` guard in that loop still
     * recognises them as the registry's; and outside the early return, because
     * the forecourt draws through the registry too and exists whether or not a
     * district happens to be resident. */
    /* The batches go down with the world in every case - like the prefab
     * release just below, and before it, so the batches never outlive the
     * registry geometries they were copied from (they hold no reference back,
     * but a teardown order that cannot be wrong needs no argument). */
    if (this._resident.size === 0) {
      this.batches.disposeAll();
      releasePrefabs();
      return;
    }

    this._lifts.clear();
    this._gates.clear();

    const evicted = new Set();
    for (const entry of this._resident.values()) {
      for (const c of entry.colliders) {
        this.physics.remove(c);
        evicted.add(c);
      }
      for (const m of entry.meshes) {
        this.group.remove(m);
        /* Same guard as `drop()`: the registry's geometries are freed once, by
         * `releasePrefabs` at the end of this method, not once per mesh. */
        if (!isPrefab(m.geometry)) m.geometry.dispose();
        m.dispose();
      }
      if (entry.lantern) {
        this.group.remove(entry.lantern);
        entry.lantern.dispose?.();
      }
      for (const f of entry.flames ?? []) {
        this.group.remove(f);
        f.dispose?.();
      }
    }

    const wc = this.worldColliders;
    let w = 0;
    for (let r = 0; r < wc.length; r++) {
      if (!evicted.has(wc[r])) wc[w++] = wc[r];
    }
    wc.length = w;

    this._resident.clear();
    this.batches.disposeAll();
    releasePrefabs();
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

    /* The LOD pass: per DISTRICT, on the residency update, never per
     * instance or per frame-of-geometry. A district is 120 m square against
     * bands of 25 m and 80 m, so per-instance evaluation could only matter
     * inside the district the player occupies - where everything is LOD0
     * anyway. This loop is ~43 distance computations against `setLod`'s
     * early-out, so a stationary player costs 43 comparisons and zero
     * writes; the browser no-thrash check (triangles identical across two
     * samples 5 s apart, standing still) is this early-out observed from
     * the outside. */
    for (const key of this._resident.keys()) {
      this.batches.setLod(key, lodFor(districtLodDistance(x, y, z, key)));
    }
    return changed;
  }

  /* ------------------------------------------------------------------ */
  /* Lifts                                                               */
  /*                                                                     */
  /* A lift's car and its landing door are emitted by DIFFERENT districts */
  /* - the car by the one at level N, the door by the one at level N+1 - */
  /* and either can be evicted while the other stays resident. So the    */
  /* registry is keyed on the CONNECTOR CELL both descriptors carry,     */
  /* never on the district that happened to emit them, and each half     */
  /* remembers which district key owns it so eviction can take back      */
  /* exactly its own.                                                    */
  /* ------------------------------------------------------------------ */

  /** How fast the car and the door travel, metres per second. */
  static CAR_SPEED = 1.6;
  /** How fast a one-way gate rises, metres per second. */
  static GATE_SPEED = 2.4;

  /**
   * How close the player must be to a pressure plate to press it.
   *
   * Generous on purpose, and in XZ only above a Y band: a plate is 8 cm tall
   * and flush with the corridor floor, so an exact footprint test would depend
   * on the capsule's own radius and would read as a plate that sometimes does
   * not work. A plate that triggers a little early costs nothing - it opens a
   * wall that was going to open.
   */
  static PLATE_REACH = 1.1;

  /** Is the player standing on this plate? */
  static _onPlate(plate, player) {
    const dx = player.x - plate.x, dz = player.z - plate.z;
    if (dx * dx + dz * dz > MazeChunks.PLATE_REACH * MazeChunks.PLATE_REACH) return false;
    /* Same level, not two floors up in a shaft that happens to share the XZ. */
    return player.y > plate.y - 1.5 && player.y < plate.y + 3.0;
  }
  static DOOR_SPEED = 2.0;

  /** Number of lifts with at least one half resident. */
  liftCount() {
    return this._lifts.size;
  }

  /** Every live lift record, for tests and `mazeStats`. */
  liveLifts() {
    return [...this._lifts.values()];
  }

  /**
   * Register a descriptor's collider into the lift registry, if it is one of
   * the two moving parts. Called from `ensure` with the collider built from
   * that exact descriptor, paired BY INDEX rather than by searching for a
   * matching position - the descriptors and colliders are built in one loop,
   * so the index is exact, and a positional search would silently pick the
   * wrong box if two ever coincided.
   */
  _registerMover(desc, collider, key) {
    if (desc.kind === 'gate' || desc.kind === 'slideWall') {
      /* A one-way gate, or a sliding hedge wall. Both live in this registry
       * because they are ONE moving surface with two triggers, and the thing
       * that makes either safe - never moving while its own footprint is
       * occupied - must have exactly one implementation. Registered here for
       * the same reason a lift car is: the collider built from THIS
       * descriptor, paired by construction rather than found by searching for
       * a matching position. */
      const slide = desc.kind === 'slideWall';
      this._gates.set(desc.cell, {
        cell: desc.cell,
        collider,
        key,
        dir: desc.dir,
        y: desc.cy,
        openY: desc.openY,
        closedY: desc.closedY,
        mesh: null,
        index: -1,
        /* A gate rests OPEN and shuts behind you; a wall rests SHUT until its
         * plate is found. One flag, so `stepGates` moves both toward whatever
         * `shut` currently says and only the trigger differs. */
        slide,
        plate: slide ? desc.plate : null,
        /* Which side of its plane the player was on last frame. `null` until
         * they are seen at all, so a gate never shuts because the player
         * SPAWNED beyond it. Unused by a wall, which has no crossing test. */
        lastSide: null,
        shut: slide,
      });
      return;
    }
    if (desc.kind !== 'lift' && desc.kind !== 'liftDoor') return;
    let rec = this._lifts.get(desc.cell);
    if (!rec) {
      rec = {
        cell: desc.cell,
        car: null, carKey: -1, carY: 0, carDownY: 0, carUpY: 0,
        carMesh: null, carIndex: -1,
        door: null, doorKey: -1, doorY: 0, doorOpenY: 0, doorClosedY: 0,
        doorMesh: null, doorIndex: -1,
        /* The car's rest state is DOWN, and the door's is CLOSED, matching
         * what `districtColliders` emits. A lift found mid-travel on a
         * re-roll would be a lift whose geometry and state disagreed. */
        wantUp: false,
      };
      this._lifts.set(desc.cell, rec);
    }
    if (desc.kind === 'lift') {
      rec.car = collider;
      rec.carKey = key;
      rec.carDownY = desc.cy;
      rec.carUpY = desc.swept.y1 - desc.hy;
      rec.carY = desc.cy;
    } else {
      rec.door = collider;
      rec.doorKey = key;
      rec.doorClosedY = desc.cy;
      rec.doorOpenY = desc.openTop - desc.hy;
      rec.doorY = desc.cy;
    }
  }

  /**
   * Give an already-registered mover the mesh instance that draws it.
   *
   * Called after the mesh build, because the instance index only exists once
   * the InstancedMesh has been written. Silently ignores any descriptor with no
   * mover record - a `slideWall` in a district whose puzzle map was not handed
   * down has colliders and a mesh but nothing to drive it, and that is a
   * headless caller rather than a fault.
   */
  _attachMoverMesh(desc, mesh, index) {
    if (desc.kind === 'gate' || desc.kind === 'slideWall') {
      const g = this._gates.get(desc.cell);
      if (g) { g.mesh = mesh; g.index = index; }
      return;
    }
    const rec = this._lifts.get(desc.cell);
    if (!rec) return;
    if (desc.kind === 'lift') { rec.carMesh = mesh; rec.carIndex = index; }
    else { rec.doorMesh = mesh; rec.doorIndex = index; }
  }

  /**
   * Move a mover's DRAWN box to where its collider now is.
   *
   * Rewrites the translation row of the existing instance matrix rather than
   * recomposing it, because these boxes never rotate and their size is not in
   * the matrix at all any more - it is in the prefab. The only thing that can
   * legitimately differ is Y, and touching only Y cannot silently resize a
   * lift car the day `buildBoxInstances` changes how it composes. Element 13
   * is the translation Y under a pure translation exactly as it was under a
   * translate-and-scale, so this survived the prefab seam untouched.
   */
  _syncMoverMesh(mesh, index, y) {
    if (!mesh || index < 0) return;
    mesh.getMatrixAt(index, _moverMat);
    _moverMat.elements[13] = y;
    mesh.setMatrixAt(index, _moverMat);
    mesh.instanceMatrix.needsUpdate = true;
  }

  /** Drop whichever halves district `key` owned; forget the lift if both are gone. */
  _unregisterMovers(key) {
    for (const [cell, g] of this._gates) {
      if (g.key === key) this._gates.delete(cell);
    }
    for (const [cell, rec] of this._lifts) {
      if (rec.carKey === key) { rec.car = null; rec.carKey = -1; }
      if (rec.doorKey === key) { rec.door = null; rec.doorKey = -1; }
      if (!rec.car && !rec.door) this._lifts.delete(cell);
    }
  }

  /**
   * Advance every resident lift by one frame.
   *
   * Two interlocks, and they are the whole safety argument:
   *
   * 1. THE DOOR NEVER MOVES WHILE ITS FOOTPRINT IS OCCUPIED. This is what
   *    makes a landing door safe rather than a ladder. A door's top sweeps
   *    the entire 0.45-5.0 m band on level N+1's floor, OUTSIDE the sealed
   *    shaft, so if it could carry a passenger it would deliver them onto a
   *    hedge - measured at exactly 14.000 m, the hedge top, with the
   *    interlock removed. Halting on boarding caps any ride at the height the
   *    player could have reached unaided.
   *
   * 2. THE CAR NEVER MOVES UNLESS THE DOOR IS SHUT. This is what makes the
   *    opening safe rather than a pit. The door is open only while the car is
   *    docked at the landing filling that opening; the instant the car is
   *    asked to leave, the door must close first. Without it the walk-off
   *    drop is a whole level - measured at 8.700 m on real geometry.
   *
   * Together they also give the crush guard for free: a capsule standing in
   * the doorway stops the door, which stops the car.
   *
   * @param {number} dt seconds
   * @param {{x:number,y:number,z:number}|null} player
   * @returns {number} how many lifts moved this frame
   */
  /** Number of gates with a live collider, for `mazeStats`. */
  gateCount() {
    return this._gates.size;
  }

  /** Every live gate record, for tests and the harness. */
  liveGates() {
    return [...this._gates.values()];
  }

  /**
   * Advance every resident one-way gate.
   *
   * A gate stands OPEN - recessed under the auto-step, walked straight over -
   * until the player crosses it in its forward direction. Then it closes
   * behind them and stays closed for the visit. A committal, not a trap:
   * `MazePuzzles` only places a gate along the entrance-to-centre path and
   * pointing forward, so passing one always leaves the player closer to the
   * centre, and hold-L guarantees a way out regardless.
   *
   * THE SAME INTERLOCK THE LIFT DOOR HAS, and for the same reason: a gate's
   * top sweeps the whole 0.45-5.0 m band on its way up, in open corridor with
   * no sealed shaft to earn the exemption. If it could rise under a player it
   * would carry them onto a hedge - Phase 2c measured exactly that at 14.000 m
   * when the invariant was removed from the door. So it never moves while its
   * own footprint is occupied.
   *
   * ## The sliding hedge wall shares every line of this
   *
   * A wall is the same surface with the trigger inverted: it RESTS shut,
   * blocking a doorway, and sinks when the player stands on its pressure plate
   * - which latches, because a plate that only holds the wall open while you
   * stand on it is a door nobody travelling alone can walk through. Its top
   * travels the same band in the same open corridor, so it needs the same
   * interlock, and the way to guarantee two things share an invariant is to
   * make them share the loop that enforces it.
   *
   * @returns {number} how many gates and walls moved this frame
   */
  stepGates(dt, player) {
    if (this._gates.size === 0) return 0;
    const EPS = 1e-4;
    let moved = 0;

    for (const g of this._gates.values()) {
      const c = g.collider;
      if (!c) continue;

      if (player && g.slide) {
        /* The plate. Latches OPEN and is never re-armed: see the note above on
         * why a hold-to-open plate is a door for two people. */
        if (g.shut && g.plate && MazeChunks._onPlate(g.plate, player)) g.shut = false;
      } else if (player) {
        /* Signed side of the gate's plane, along its own forward axis. */
        const along = g.dir === DIR.E || g.dir === DIR.W
          ? player.x - c.center.x
          : player.z - c.center.z;
        const forwardSign = (g.dir === DIR.E || g.dir === DIR.S) ? 1 : -1;
        const side = Math.sign(along * forwardSign);
        if (side !== 0) {
          if (g.lastSide !== null && g.lastSide < 0 && side > 0) g.shut = true;
          g.lastSide = side;
        }
      }

      const targetY = g.shut ? g.closedY : g.openY;
      if (Math.abs(g.y - targetY) <= EPS) continue;
      if (this._gateOccupied(g, player)) continue;

      const step = MazeChunks.GATE_SPEED * dt;
      g.y += Math.sign(targetY - g.y) * Math.min(step, Math.abs(targetY - g.y));
      this.physics.setBoxColliderY(c, g.y);
      this._syncMoverMesh(g.mesh, g.index, g.y);
      moved++;
    }
    return moved;
  }

  /**
   * Is a capsule standing in the gate's own column?
   *
   * Deliberately generous, exactly as `_doorOccupied` is: a gate that refuses
   * to move when it is unsure is a gate that stays open a moment longer, and a
   * gate that moves when it should not is the exploit.
   */
  _gateOccupied(g, player) {
    if (!player) return false;
    const c = g.collider;
    const R = 0.35, H = 1.75;
    const overlapsXZ = player.x + R > c.center.x - c.halfExtents.x
      && player.x - R < c.center.x + c.halfExtents.x
      && player.z + R > c.center.z - c.halfExtents.z
      && player.z - R < c.center.z + c.halfExtents.z;
    if (!overlapsXZ) return false;
    const top = g.y + c.halfExtents.y;
    const floor = g.closedY - c.halfExtents.y;
    return player.y + H > floor && player.y < top + 0.05;
  }

  stepLifts(dt, player) {
    this.stepGates(dt, player);
    if (this._lifts.size === 0) return 0;
    const EPS = 1e-4;
    let moved = 0;

    for (const rec of this._lifts.values()) {
      if (rec.car) this._callLift(rec, player);

      // 1. The door, gated on occupancy.
      if (rec.door) {
        /* Open only while the car is docked at the landing AND means to stay
         * there. Keying this on the car's POSITION alone was a real bug: a
         * docked car asked to leave kept its door held open, so the door
         * never shut, so the car could never depart - and had the car been
         * allowed to depart anyway that open door would have been the
         * nine-metre pit. The door tracks the car's INTENT, not its address. */
        const carDocked = rec.car ? rec.carY >= rec.carUpY - EPS : false;
        const targetY = (carDocked && rec.wantUp) ? rec.doorOpenY : rec.doorClosedY;
        if (Math.abs(rec.doorY - targetY) > EPS && !this._doorOccupied(rec, player)) {
          const stepY = MazeChunks.DOOR_SPEED * dt;
          rec.doorY += Math.sign(targetY - rec.doorY) * Math.min(stepY, Math.abs(targetY - rec.doorY));
          this.physics.setBoxColliderY(rec.door, rec.doorY);
          this._syncMoverMesh(rec.doorMesh, rec.doorIndex, rec.doorY);
          moved++;
        }
      }

      // 2. The car, gated on the door being shut.
      if (rec.car) {
        const targetY = rec.wantUp ? rec.carUpY : rec.carDownY;
        /* THE PIT INTERLOCK, and it is unconditional. An earlier version let
         * the car move once it had already left the landing, on the reasoning
         * that only DEPARTING needed the door shut. That is a hole, and it was
         * measured: the car slipped a fraction below the landing, the
         * exception then applied, and it rode all 8.700 m down with the door
         * standing open. Leaving the landing AT ALL is the thing being
         * prevented, so there is no exception.
         *
         * A lift whose door district is not resident may move freely: there is
         * no floor up there to fall through either, because the same district
         * emits both. */
        const doorShut = !rec.door || rec.doorY >= rec.doorClosedY - EPS;
        const mayMove = doorShut;
        if (Math.abs(rec.carY - targetY) > EPS && mayMove) {
          const stepY = MazeChunks.CAR_SPEED * dt;
          rec.carY += Math.sign(targetY - rec.carY) * Math.min(stepY, Math.abs(targetY - rec.carY));
          this.physics.setBoxColliderY(rec.car, rec.carY);
          this._syncMoverMesh(rec.carMesh, rec.carIndex, rec.carY);
          moved++;
        }
      }
    }
    return moved;
  }

  /**
   * Is a capsule standing in, or on, the door's own column?
   *
   * Deliberately generous: it counts a player merely overlapping the door's
   * footprint at landing height, not only one provably standing on its top.
   * A door that refuses to move when it is unsure is inconvenient; a door
   * that moves when it should not is the exploit.
   */
  _doorOccupied(rec, player) {
    if (!player || !rec.door) return false;
    const d = rec.door;
    const R = 0.35, H = 1.75;
    const overlapsXZ = player.x + R > d.center.x - d.halfExtents.x
      && player.x - R < d.center.x + d.halfExtents.x
      && player.z + R > d.center.z - d.halfExtents.z
      && player.z - R < d.center.z + d.halfExtents.z;
    if (!overlapsXZ) return false;
    const top = rec.doorY + d.halfExtents.y;
    const floor = rec.doorClosedY - d.halfExtents.y;
    return player.y + H > floor && player.y < top + 0.05;
  }

  /**
   * Decide which way this lift should be heading.
   *
   * No prompt and no UI, per the spec's silent posture: standing on the car
   * sends it to the other end, and standing on a landing plate calls it to
   * you. The plates are footprint tests, not colliders - a plate sits flush
   * on the floor below the auto-step, so it is never itself a surface in the
   * band and needs no exemption.
   */
  _callLift(rec, player) {
    if (!player) return;
    const c = rec.car;
    /* The player's CENTRE, not their capsule inflated by its radius.
     * Inflating it made someone merely standing in the open doorway - which
     * sits 0.1 m outside the well - count as riding, so the car's target
     * flipped the moment they stepped up to it. Being ON the lift means your
     * feet are on it. `_doorOccupied` keeps the generous inflated test,
     * because there the conservative answer is the safe one and here it is
     * not. */
    const onCarXZ = player.x > c.center.x - c.halfExtents.x
      && player.x < c.center.x + c.halfExtents.x
      && player.z > c.center.z - c.halfExtents.z
      && player.z < c.center.z + c.halfExtents.z;
    const carTop = rec.carY + c.halfExtents.y;
    if (onCarXZ && Math.abs(player.y - carTop) < 0.35) {
      /* Riding: send it to whichever end it is NOT at - but only decide that
       * while it is actually parked at one. Re-deciding every frame made the
       * car reverse the instant it crossed the midpoint, so a rider rose 4.5 m
       * and came straight back down. The target is latched for the whole
       * journey and only reconsidered on arrival. */
      const atBottom = rec.carY <= rec.carDownY + 1e-4;
      const atTop = rec.carY >= rec.carUpY - 1e-4;
      if (atBottom) rec.wantUp = true;
      else if (atTop) rec.wantUp = false;
      return;
    }
    // Calling: the plate is the well's footprint at either landing height.
    if (onCarXZ) return;
    const nearBottom = Math.abs(player.y - (rec.carDownY - c.halfExtents.y)) < 1.2;
    const nearTop = Math.abs(player.y - (rec.carUpY + c.halfExtents.y)) < 1.2;
    const within = Math.hypot(player.x - c.center.x, player.z - c.center.z) < 3.0;
    if (within && nearBottom) rec.wantUp = false;
    else if (within && nearTop) rec.wantUp = true;
  }
}

/**
 * How far the player stands from district `key`, for the LOD bands: the
 * distance to the NEAREST POINT of the district's box (its 120 m XZ square,
 * its level's hedge band in Y) - deliberately coarse, per the plan, and
 * deliberately nearest-point rather than centre-point.
 *
 * Centre distance was the obvious alternative and it inverts the bands: a
 * district is 120 m square, so its own centre sits up to ~85 m from a player
 * standing in its corner - past LOD1_RANGE - and the district the player is
 * INSIDE would demote itself to the far box. Nearest-point can only err the
 * safe way: it promotes a district the moment any part of it could be within
 * the band, so no surface within LOD0_RANGE of the eye ever renders far
 * geometry. The price is generosity - a player at a district corner holds
 * four districts at LOD0, and the ring districts on adjacent levels sit
 * ~4-9 m away in Y and stay LOD0 through the floor - which is triangles
 * spent, not detail lost, and the budget test prices exactly this rule.
 * (Those vertical neighbours also cannot be excluded by distance alone: a
 * player at the bottom of a shaft well looks straight up at the level above
 * from 9 m, and box treads at 9 m are the stack of slabs the owner
 * originally complained about.)
 *
 * Exported for the triangle-budget test, which must price the bands with the
 * same ruler the residency update swaps them with.
 *
 * @param {number} px player, world metres
 * @param {number} py
 * @param {number} pz
 * @param {number} key district key
 * @returns {number} metres
 */
export function districtLodDistance(px, py, pz, key) {
  const { dx, dz, level } = districtCoords(key);
  const span = MAZE.DISTRICT * MAZE.CELL;
  const x0 = dx * span;
  const z0 = dz * span;
  const y0 = level * MAZE.LEVEL_HEIGHT;
  const cx = Math.min(Math.max(px, x0), x0 + span);
  const cy = Math.min(Math.max(py, y0), y0 + MAZE.HEDGE_HEIGHT);
  const cz = Math.min(Math.max(pz, z0), z0 + span);
  return Math.hypot(px - cx, py - cy, pz - cz);
}

/**
 * One InstancedMesh of small leaning boxes, for foliage.
 *
 * Separate from `buildBoxInstances` because a sprig needs a Y ROTATION and a
 * uniform scale, and a hedge needs neither - threading rotation through the
 * hot path that builds ten thousand walls per district to serve the dressing
 * would be the wrong trade.
 *
 * Foliage casts no shadow: at five sprigs per hedge segment across 25 resident
 * districts that is tens of thousands of shadow casters for detail nobody
 * reads, and shadow cost is the one budget the canopy work already showed this
 * world is sensitive to.
 *
 * @param {Array<{x:number,y:number,z:number,ry:number,s:number}>} sprigs
 * @returns {THREE.InstancedMesh|null}
 */
export function buildSprigInstances(sprigs, material, name, group) {
  if (sprigs.length === 0) return null;
  const geo = new THREE.BoxGeometry(0.5, 0.5, 0.5);
  const mesh = new THREE.InstancedMesh(geo, material, sprigs.length);
  mesh.name = name;
  mesh.castShadow = false;
  mesh.receiveShadow = false;
  const m = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const up = new THREE.Vector3(0, 1, 0);
  const axisX = new THREE.Vector3(1, 0, 0);
  const axisZ = new THREE.Vector3(0, 0, 1);
  const pos = new THREE.Vector3();
  const scale = new THREE.Vector3();
  for (let i = 0; i < sprigs.length; i++) {
    const s = sprigs[i];
    pos.set(s.x, s.y, s.z);
    /* Which axis `ry` turns about.
     *
     * `compose` builds T*R*S, so the per-axis scale below is applied in the
     * instance's OWN frame and only then rotated. For hedge growth that is
     * fine: the sprig is roughly square in plan and Y is the only interesting
     * axis. For a leaf lying flat on a wall it is not - flattening on world X
     * and then yawing about Y swings that thin axis toward Z, and at a quarter
     * turn the leaf stands edge-out from the wall it is supposed to be lying
     * on. That is what made the first ivy read as confetti.
     *
     * So a sprig may name the axis to turn about, and ivy names the wall's own
     * normal: rolling about the normal leaves the thin axis exactly where it
     * was and varies the leaf only within the plane of the stone. */
    q.setFromAxisAngle(s.axis === 'x' ? axisX : s.axis === 'z' ? axisZ : up, s.ry);
    /* Per-axis scale when a sprig asks for one. Hedge-top growth is a chunky
     * little bush and wants the uniform default; ivy is a leaf lying flat on
     * stone and has to be squashed on the wall's normal, or it reads as dice
     * glued to a tower. */
    if (s.sx !== undefined) scale.set(s.sx, s.sy, s.sz);
    else scale.set(s.s, s.s * 1.4, s.s);
    m.compose(pos, q, scale);
    mesh.setMatrixAt(i, m);
  }
  mesh.instanceMatrix.needsUpdate = true;
  group.add(mesh);
  return mesh;
}

/**
 * Build one InstancedMesh from a run of `{kind,cx,cy,cz,hx,hy,hz}` descriptors
 * that all share an extent class, add it to `group`, and return it - or return
 * `null` for an empty list rather than allocate a zero-instance mesh.
 *
 * Shared by `MazeChunks` (district streaming) and `MazeWorld` (the forecourt,
 * which is authored geometry rather than a chunk but built by exactly this
 * same recipe). It lives here rather than in `MazeWorld.js` because
 * `MazeWorld` already imports from this module - putting it there instead
 * would mean `MazeChunks` importing back from `MazeWorld`, a cycle neither
 * file needs.
 *
 * ## The run has to be homogeneous, and the caller is who guarantees it
 *
 * An InstancedMesh has one geometry. Once the extents live in the geometry
 * rather than in each instance's scale, a run of mixed sizes cannot be drawn
 * by one mesh at all - so callers split with `groupByExtentClass` first and
 * this function takes the first descriptor's geometry for the whole run. That
 * is the caller's job rather than this function's because the moving kinds
 * pair a descriptor to its instance index, and an index only means anything
 * against the exact list that was written; splitting in here would hand the
 * caller back an index into a list it never saw.
 *
 * The empty-list guard matters for the forecourt specifically: it can
 * legitimately produce zero hedges or zero floor tiles depending on layout,
 * and the caller does not pre-filter the way `MazeChunks.ensure` does.
 *
 * @param {Array<{kind:string,cx:number,cy:number,cz:number,hx:number,hy:number,hz:number}>} descs
 * @param {THREE.Material} material
 * @param {string} name
 * @param {THREE.Group} group
 * @param {(desc:object) => THREE.BufferGeometry} [geometryFor] the registry, by
 *   default. Injectable so a test can watch what geometry a run asked for
 *   without standing up the cache.
 * @returns {THREE.InstancedMesh|null}
 */
export function buildBoxInstances(descs, material, name, group, geometryFor = prefabFor) {
  if (descs.length === 0) return null;
  /* One geometry for the whole run, taken from the first descriptor. Callers
   * pass a run that `groupByExtentClass` produced, so every descriptor here
   * shares an extent class and the first one speaks for all of them. */
  const geo = geometryFor(descs[0]);
  const mesh = new THREE.InstancedMesh(geo, material, descs.length);
  mesh.name = name;
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  const m = new THREE.Matrix4();
  for (let i = 0; i < descs.length; i++) {
    const d = descs[i];
    /* TRANSLATION ONLY. The half-extents used to be composed in here as a
     * scale on a unit cube; they are in the geometry now, and they have to
     * stay there. A scale would multiply whatever a prefab is authored with -
     * a 4 cm chamfer becomes 19 cm along a hedge's long axis and 2 cm across
     * its thin one - and it would make the fit contract a per-instance
     * question rather than a property of the geometry. */
    m.makeTranslation(d.cx, d.cy, d.cz);
    mesh.setMatrixAt(i, m);
  }
  mesh.instanceMatrix.needsUpdate = true;
  group.add(mesh);
  return mesh;
}
