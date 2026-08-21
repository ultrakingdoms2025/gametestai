import * as THREE from 'three';
import { allows } from '../worlds/WorldRules.js';

/**
 * Swimmable water, discovered from the geometry a world already built.
 *
 * There is no authored water data anywhere in this project and the world files
 * belong to other agents, so the volumes have to be *inferred*. Two facts make
 * that tractable:
 *
 *   1. Every body of water in the game is a horizontal surface plane. Medieval
 *      names its shared material `medieval.water`; sports leaves its pool
 *      shader unnamed but, like medieval's, it declares `uShallow`/`uDeep`
 *      uniforms - a signature no other material in the build has. Matching on
 *      the name *or* that uniform pair finds both without touching either file.
 *   2. A surface plane says where the top of the water is but nothing about its
 *      body, so each volume is the surface extruded straight down.
 *
 * A single world-space bounding box per mesh would be far too coarse: the
 * medieval river is a 392 m meandering ribbon roughly 22 m wide, and its AABB
 * covers 76 m of dry flood plain either side of it. So each mesh is decomposed
 * over an 8 m XZ lattice - every triangle contributes its bounds clipped to the
 * cells it touches - and the union of those cell boxes traces the actual shape
 * of the water. The same lattice is then the broadphase: `contains()` is one
 * hash lookup and a handful of box tests.
 *
 * Depth queries are deliberately *not* answered here. How deep the water is at
 * a point is a question about the river bed, which is collision data; `Swim`
 * owns the physics reference and probes it.
 *
 * ## 3. A world may ANSWER instead of being scanned
 *
 * The inference above exists because the hand-built worlds have no authored
 * water data. The ten planets do: `PlanetWorld` knows every disc and ribbon it
 * poured, to the wobble on the outline. Scanning them would be worse in every
 * dimension - Shoal's sea is a 128-triangle fan 2,700 m across, so the 8 m
 * lattice would decompose it into roughly 450,000 `Box3` volumes for a shape
 * `liquidSurfaceAt` answers exactly, in constant memory, with the same
 * function the mesh was built from.
 *
 * So a world may publish `liquidField` and be believed:
 *
 *   {
 *     surfaceAt(x, z) -> number | null   the highest liquid surface there
 *     swimmable, lethal, dps, cause      what being in it does to a body
 *     name, worldId
 *   }
 *
 * That is also the only way the non-swimmable liquids get in at all. Lava and
 * acid are not water and `rules.swim` is false on their worlds, so the scan
 * never runs there - but `Swim` still has to know where Cinder's lava is in
 * order to burn anything standing in it. The field is installed whether or not
 * swimming is permitted; only the GEOMETRY SCAN is gated.
 */

/** Material or object names that mean water. */
const WATERISH = /water|pool|lake|pond|moat|river|lagoon/i;
/**
 * ...except these, which are the things that sit *around* water and would
 * otherwise be dragged in by the same words. `tile.pool` is the basin lining.
 */
const NOT_WATER = /tile|coping|deck|kerb|curb|glow|light|caustic|decal|splash|ripple|sign|rope|ladder|foam|spray|puddle/i;

/** XZ lattice pitch, metres. Small enough to trace a river, big enough to stay cheap. */
const CELL = 8;
/** How far below the surface a volume extends. Deeper than any basin in the game. */
const DEPTH = 10;
/** A point exactly on the surface counts as in the water. */
const SURFACE_EPS = 0.03;

/* Scratch. Each function owns its own - see the note in physics/Physics.js. */
const _amA = new THREE.Vector3();
const _amB = new THREE.Vector3();
const _amC = new THREE.Vector3();
const _amBox = new THREE.Box3();

/** Pack a lattice coordinate pair into one integer key. Worlds stay inside +-2048 m. */
function cellKey(cx, cz) {
  return ((cx + 1024) << 12) | (cz + 1024);
}

/**
 * Does this object read as a water surface?
 *
 * @param {THREE.Object3D} obj
 * @returns {boolean}
 */
function isWaterSurface(obj) {
  const mat = obj.material;
  if (!mat) return false;
  const list = Array.isArray(mat) ? mat : [mat];
  for (const m of list) {
    if (!m) continue;
    const name = m.name || '';
    if (WATERISH.test(name) && !NOT_WATER.test(name)) return true;
    // Unnamed procedural water: both water shaders in the build tint the body
    // between a shallow and a deep colour, and nothing else does.
    const u = m.uniforms;
    if (u && u.uShallow && u.uDeep) return true;
  }
  const on = obj.name || '';
  return WATERISH.test(on) && !NOT_WATER.test(on);
}

export class WaterVolumes {
  /**
   * @param {{ bus: import('../core/EventBus.js').EventBus }} ctx
   */
  constructor({ bus } = {}) {
    this.bus = bus ?? null;

    /** @type {Array<{ box: THREE.Box3, surfaceY: number, source: string }>} */
    this._volumes = [];
    /** @type {Map<number, Array<{ box: THREE.Box3, surfaceY: number, source: string }>>} */
    this._grid = new Map();
    /** Which world the current volumes came from, so a rebuild can be skipped. */
    this._worldId = null;
    /**
     * The active world's own answer for its liquid, when it publishes one.
     * @type {{surfaceAt:(x:number,z:number)=>number|null, swimmable:boolean,
     *         lethal:boolean, dps:number, cause:string, name:string}|null}
     */
    this._field = null;
    /** Per-world summary, kept so `describe()` can be read back from the console. */
    this._report = [];

    this._offs = [];
    if (this.bus) {
      this._offs.push(this.bus.on('world:changed', (e) => this.rebuildFromWorld(e?.world ?? null)));
      // Player is constructed before this system, so it cannot be handed the
      // reference directly. It asks; we answer. See `Swim.setVolumes`.
      this._offs.push(this.bus.on('water:request', () => this._announce()));
      this._announce();
    }
  }

  /* ================================================================ */
  /* Contract surface                                                  */
  /* ================================================================ */

  /** @returns {Array<{ box: THREE.Box3, surfaceY: number, source: string }>} */
  get volumes() {
    return this._volumes;
  }

  /** Id of the world the current volumes were built from, or null. */
  get worldId() {
    return this._worldId;
  }

  /**
   * Rescan a world for water surfaces and rebuild the swimmable volumes.
   *
   * Idempotent per world: calling it twice for the same world is a no-op, so
   * both `world:changed` and an explicit call from `main.js` are safe.
   *
   * @param {import('../worlds/World.js').World|null} world
   * @param {boolean} [force] rebuild even if the world is unchanged
   */
  rebuildFromWorld(world, force = false) {
    const id = world?.id ?? null;
    if (!force && id === this._worldId) return;

    this._volumes.length = 0;
    this._grid.clear();
    this._report.length = 0;
    this._worldId = id;
    this._field = null;

    /* THE WORLD'S OWN ANSWER FIRST, and installed even when swimming is
     * forbidden here: a lava planet publishes `swimmable: false` and still has
     * to tell `Swim` where the lava is, or nothing can burn for standing in
     * it. @see the header, section 3. */
    const field = world?.liquidField ?? null;
    if (field && typeof field.surfaceAt === 'function') {
      this._field = {
        surfaceAt: field.surfaceAt,
        swimmable: !!field.swimmable,
        lethal: !!field.lethal,
        dps: Number.isFinite(field.dps) ? Math.max(0, field.dps) : 0,
        cause: field.cause ?? 'liquid',
        name: field.name ?? 'liquid',
      };
      console.info(
        `[WaterVolumes] ${id ?? '?'}: the world answers for its own liquid - `
        + `${this._field.name}, swimmable=${this._field.swimmable}`
        + (this._field.lethal ? `, LETHAL at ${this._field.dps} dps` : '')
      );
      this._announce();
      return;
    }

    if (!world?.group) {
      console.info('[WaterVolumes] no world group - no swimmable water');
      this._announce();
      return;
    }

    // No water here; skip the full-geometry scan entirely.
    if (!allows(world, 'swim')) {
      this._announce();
      return;
    }

    // Matrices of an inactive world can be stale; the boxes are world-space.
    world.group.updateMatrixWorld(true);

    const surfaces = [];
    world.group.traverse((obj) => {
      // InstancedMesh water does not exist in this build and each instance
      // would need its own box, so it is deliberately out of scope.
      if (obj.isMesh && !obj.isInstancedMesh && isWaterSurface(obj)) surfaces.push(obj);
    });

    for (const mesh of surfaces) this._addSurface(mesh);

    // Logged per world because "did it find the moat?" is otherwise unanswerable
    // without a debugger, and the moat and the river sit at different heights.
    if (!this._report.length) {
      console.info(`[WaterVolumes] ${id ?? '?'}: no water surfaces found`);
    } else {
      const total = this._volumes.length;
      const detail = this._report
        .map((r) => `${r.name} surfaceY=${r.surfaceY.toFixed(2)} ${Math.round(r.area)}m2 x${r.cells}`)
        .join(' | ');
      console.info(
        `[WaterVolumes] ${id ?? '?'}: ${this._report.length} surface(s), ${total} volumes - ${detail}`
      );
    }
    this._announce();
  }

  /**
   * Is this world-space point inside a body of water?
   * @param {THREE.Vector3} point
   * @returns {boolean}
   */
  contains(point) {
    if (!point) return false;
    if (this._field) {
      const s = this._field.surfaceAt(point.x, point.z);
      return s !== null && point.y <= s + SURFACE_EPS;
    }
    const list = this._grid.get(cellKey(Math.floor(point.x / CELL), Math.floor(point.z / CELL)));
    if (!list) return false;
    for (let i = 0; i < list.length; i++) {
      if (list[i].box.containsPoint(point)) return true;
    }
    return false;
  }

  /**
   * Height of the water surface over a ground-plane position.
   *
   * Where volumes overlap (the moat's corner bands do) the highest surface
   * wins, which is the only answer that keeps a swimmer at the waterline.
   *
   * @param {number} x
   * @param {number} z
   * @returns {number|null} null when there is no water above this point
   */
  surfaceYAt(x, z) {
    if (this._field) {
      const s = this._field.surfaceAt(x, z);
      return Number.isFinite(s) ? s : null;
    }
    const list = this._grid.get(cellKey(Math.floor(x / CELL), Math.floor(z / CELL)));
    if (!list) return null;
    let best = null;
    for (let i = 0; i < list.length; i++) {
      const b = list[i].box;
      if (x < b.min.x || x > b.max.x || z < b.min.z || z > b.max.z) continue;
      if (best === null || list[i].surfaceY > best) best = list[i].surfaceY;
    }
    return best;
  }

  /**
   * Lowest point any volume over (x, z) reaches. Only used for diagnostics -
   * the real floor is collision geometry, which this class does not own.
   * @returns {number|null}
   */
  floorYAt(x, z) {
    const s = this.surfaceYAt(x, z);
    return s === null ? null : s - DEPTH;
  }

  /**
   * WHAT IS AT (x, z), AND WHAT IT DOES TO A BODY.
   *
   * The one query `Swim` asks. It has to be one query rather than two because
   * "how high is the surface" and "will this kill me" have to come from the
   * SAME body: answering them separately is how a swimmer ends up floating at
   * the height of a lake while taking damage from a lava flow forty metres
   * away, and on Cinder those two are the same descriptor.
   *
   * Scanned water is swimmable and harmless, which is what it has always been
   * in the four hand-built worlds - there is no lava in a medieval moat.
   *
   * @param {number} x
   * @param {number} z
   * @returns {{surfaceY:number, swimmable:boolean, lethal:boolean, dps:number,
   *            cause:string, name:string}|null} null where there is no liquid
   */
  liquidAt(x, z) {
    const f = this._field;
    if (f) {
      const s = f.surfaceAt(x, z);
      if (!Number.isFinite(s)) return null;
      return { surfaceY: s, swimmable: f.swimmable, lethal: f.lethal, dps: f.dps, cause: f.cause, name: f.name };
    }
    const s = this.surfaceYAt(x, z);
    if (s === null) return null;
    return { surfaceY: s, swimmable: true, lethal: false, dps: 0, cause: 'water', name: 'water' };
  }

  /** Human-readable summary of what the last scan found. */
  describe() {
    return {
      world: this._worldId,
      surfaces: this._report.slice(),
      volumes: this._volumes.length,
      field: this._field
        ? { name: this._field.name, swimmable: this._field.swimmable, lethal: this._field.lethal, dps: this._field.dps }
        : null,
    };
  }

  dispose() {
    for (const off of this._offs) off?.();
    this._offs.length = 0;
    this._volumes.length = 0;
    this._grid.clear();
    this._field = null;
  }

  /* ================================================================ */
  /* Internals                                                         */
  /* ================================================================ */

  /**
   * Decompose one surface mesh into lattice-aligned volumes.
   *
   * Working per triangle rather than per vertex matters: the river's grid is
   * ~4 m across, so a cell can easily hold a single vertex, and a box built
   * from vertex extents alone would collapse to a point and leave holes a
   * swimmer falls through.
   */
  _addSurface(mesh) {
    const geo = mesh.geometry;
    const pos = geo?.getAttribute?.('position');
    if (!pos) return;
    const index = geo.getIndex();
    const count = index ? index.count : pos.count;
    if (count < 3) return;

    const m = mesh.matrixWorld;
    /** @type {Map<number, {x0:number,x1:number,z0:number,z1:number}>} */
    const cells = new Map();
    let surfaceY = -Infinity;

    for (let i = 0; i < count; i += 3) {
      const ia = index ? index.getX(i) : i;
      const ib = index ? index.getX(i + 1) : i + 1;
      const ic = index ? index.getX(i + 2) : i + 2;
      _amA.fromBufferAttribute(pos, ia).applyMatrix4(m);
      _amB.fromBufferAttribute(pos, ib).applyMatrix4(m);
      _amC.fromBufferAttribute(pos, ic).applyMatrix4(m);

      const tx0 = Math.min(_amA.x, _amB.x, _amC.x);
      const tx1 = Math.max(_amA.x, _amB.x, _amC.x);
      const tz0 = Math.min(_amA.z, _amB.z, _amC.z);
      const tz1 = Math.max(_amA.z, _amB.z, _amC.z);
      const ty1 = Math.max(_amA.y, _amB.y, _amC.y);
      if (ty1 > surfaceY) surfaceY = ty1;

      const cx0 = Math.floor(tx0 / CELL);
      const cx1 = Math.floor(tx1 / CELL);
      const cz0 = Math.floor(tz0 / CELL);
      const cz1 = Math.floor(tz1 / CELL);
      for (let cx = cx0; cx <= cx1; cx++) {
        const gx0 = cx * CELL;
        const gx1 = gx0 + CELL;
        const x0 = Math.max(tx0, gx0);
        const x1 = Math.min(tx1, gx1);
        if (x1 < x0) continue;
        for (let cz = cz0; cz <= cz1; cz++) {
          const gz0 = cz * CELL;
          const gz1 = gz0 + CELL;
          const z0 = Math.max(tz0, gz0);
          const z1 = Math.min(tz1, gz1);
          if (z1 < z0) continue;
          const key = cellKey(cx, cz);
          const rec = cells.get(key);
          if (!rec) {
            cells.set(key, { x0, x1, z0, z1 });
          } else {
            if (x0 < rec.x0) rec.x0 = x0;
            if (x1 > rec.x1) rec.x1 = x1;
            if (z0 < rec.z0) rec.z0 = z0;
            if (z1 > rec.z1) rec.z1 = z1;
          }
        }
      }
    }

    if (!cells.size || !Number.isFinite(surfaceY)) return;

    const name = mesh.name || mesh.material?.name || 'water';
    let area = 0;
    for (const [key, r] of cells) {
      // A degenerate strip (one row of triangles clipped to a cell edge) is
      // still water; widen it enough that a 0.35 m capsule can be inside it.
      const box = new THREE.Box3(
        new THREE.Vector3(r.x0 - 0.02, surfaceY - DEPTH, r.z0 - 0.02),
        new THREE.Vector3(r.x1 + 0.02, surfaceY + SURFACE_EPS, r.z1 + 0.02)
      );
      const vol = { box, surfaceY, source: name };
      this._volumes.push(vol);
      let list = this._grid.get(key);
      if (!list) this._grid.set(key, (list = []));
      list.push(vol);
      area += (r.x1 - r.x0) * (r.z1 - r.z0);
    }

    this._report.push({ name, surfaceY, cells: cells.size, area });
  }

  /**
   * Publish this instance so systems built *before* it (the Player) can find
   * it. Sending the object on the bus is not elegant, but the alternative is a
   * wiring change in `main.js`, which this agent does not own.
   */
  _announce() {
    this.bus?.emit('water:volumes', { water: this, worldId: this._worldId });
  }
}
