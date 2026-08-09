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
const LANTERN_COLOUR = 0xffd9a0;
const LANTERN_INTENSITY = 26;
/** Bounded to its own district, so the rig's distance scoring is meaningful. */
const LANTERN_RANGE = MAZE.DISTRICT * MAZE.CELL * 0.75;

export const CHUNK_MESH_KINDS = Object.freeze(['hedge', 'floor', 'stair', 'shaftWall', 'lift', 'liftDoor', 'tunnel']);

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
    /** Live lifts, keyed by CONNECTOR CELL - see the lift section below. */
    this._lifts = new Map();
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
   * Meshes plus one lantern per resident district. Exposed so the leak test
   * can assert an EQUALITY rather than an upper bound: the bound it used
   * ("hedges and a floor per district") was already loose once stairs, shafts,
   * lifts and tunnels gained their own mesh kinds, and it broke outright when
   * districts gained a light. An exact count cannot rot the same way.
   */
  objectCount() {
    let n = 0;
    for (const e of this._resident.values()) n += e.meshes.length + (e.lantern ? 1 : 0);
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
    const descs = districtColliders(this.cells, dx, dz, level);

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
    for (const kind of CHUNK_MESH_KINDS) {
      const of = descs.filter((d) => d.kind === kind);
      const mesh = buildBoxInstances(of, this.materials[kind], `maze:${kind}:${key}`, this.group);
      if (mesh) meshes.push(mesh);
    }

    /* The district's lantern. See LANTERN_COLOUR above for why this is free. */
    const w0 = districtCoords(key);
    const cx = (w0.dx * MAZE.DISTRICT + MAZE.DISTRICT / 2) * MAZE.CELL;
    const cz = (w0.dz * MAZE.DISTRICT + MAZE.DISTRICT / 2) * MAZE.CELL;
    const lantern = new THREE.PointLight(LANTERN_COLOUR, LANTERN_INTENSITY, LANTERN_RANGE);
    lantern.visible = false;
    lantern.position.set(cx, w0.level * MAZE.LEVEL_HEIGHT + MAZE.HEDGE_HEIGHT * 0.8, cz);
    this.group.add(lantern);

    this._resident.set(key, { meshes, colliders, lantern });
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
    /* The lantern goes with its district, or a walk across the maze would
     * leave one behind every 120 m and the rig would score an ever-growing
     * source list. */
    if (entry.lantern) {
      this.group.remove(entry.lantern);
      entry.lantern.dispose?.();
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

    this._lifts.clear();

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
      if (entry.lantern) {
        this.group.remove(entry.lantern);
        entry.lantern.dispose?.();
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
    if (desc.kind !== 'lift' && desc.kind !== 'liftDoor') return;
    let rec = this._lifts.get(desc.cell);
    if (!rec) {
      rec = {
        cell: desc.cell,
        car: null, carKey: -1, carY: 0, carDownY: 0, carUpY: 0,
        door: null, doorKey: -1, doorY: 0, doorOpenY: 0, doorClosedY: 0,
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

  /** Drop whichever halves district `key` owned; forget the lift if both are gone. */
  _unregisterMovers(key) {
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
  stepLifts(dt, player) {
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
