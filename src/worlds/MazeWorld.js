import * as THREE from 'three';
import { World } from './World.js';
import { makeRules } from './WorldRules.js';
import {
  MAZE, generateTopology, cellCoords, carveEntranceCorridor,
} from './maze/MazeTopology.js';
import {
  districtColliders, cellToWorld, forecourtColliders, FORECOURT_PORTAL_Z,
} from './maze/MazeColliders.js';

/**
 * The Verdant Coil - a hedge maze that re-rolls its layout on every entry.
 *
 * Phase 1 scope, deliberately: one level, every district built up front, and
 * box geometry rather than foliage. Streaming, the other three levels, the art
 * pass, the puzzles and the map are Phases 2-5. Building the whole level
 * up front is knowingly wrong for the finished world and knowingly right for
 * now - it takes streaming out of the equation while the topology, the rules
 * and the containment work are being proven.
 *
 * @see docs/superpowers/specs/2026-08-07-maze-world-design.md
 */
export class MazeWorld extends World {
  static id = 'maze';
  static displayName = 'The Verdant Coil';

  /**
   * Re-generate on every activation rather than serving a cached build.
   * Read by WorldManager. The maze that cannot be learned is the entire point.
   */
  static volatile = true;

  constructor(ctx) {
    super(ctx);

    this.rules = makeRules({
      weapons: false, mounts: false, climb: false, parkour: false,
      merchants: false, quests: false, contracts: false, caches: false,
      relics: false, loot: false, races: false, interiors: false,
      hostiles: false, swim: false,
      // jump stays permitted: the geometry makes the hop useless, not the input.
    });

    /** Current run's seed. Re-rolled on every build. */
    this.seed = 0;
    /** @type {Uint8Array|null} */
    this.cells = null;
    this.entranceCell = 0;
    this.centreCell = 0;

    /* Materials are created once and reused across every re-roll. Allocating
     * fresh ones per entry would re-trigger the shader compilation that already
     * dominates cold boot in this project - see the prewarm notes in main.js. */
    this._materials = null;

    const span = MAZE.CELLS * MAZE.CELL;
    this.bounds = new THREE.Box3(
      new THREE.Vector3(-MAZE.CELL, -10, -MAZE.CELL),
      new THREE.Vector3(span, MAZE.LEVEL_HEIGHT * MAZE.LEVELS + 20, span),
    );

    this.environment.background = new THREE.Color(0x9fb8c8);
    this.environment.fogColor = new THREE.Color(0xa8c0ce);
    this.environment.fogNear = 20;
    this.environment.fogFar = 160;
    this.environment.ambientColor = new THREE.Color(0x6f7f68);
    this.environment.ambientIntensity = 0.7;
    this.environment.sunColor = new THREE.Color(0xfff2d8);
    this.environment.sunIntensity = 2.2;
    this.environment.sunDirection = new THREE.Vector3(-0.3, 0.9, -0.25).normalize();
  }

  /** Reusable material set, built on first use and kept for the session. */
  _ensureMaterials() {
    if (this._materials) return this._materials;
    this._materials = {
      hedge: new THREE.MeshStandardMaterial({ color: 0x2f4a2a, roughness: 0.95, metalness: 0 }),
      floor: new THREE.MeshStandardMaterial({ color: 0x6b6357, roughness: 1.0, metalness: 0 }),
      credits: new THREE.MeshStandardMaterial({
        color: 0xffd479, roughness: 0.35, metalness: 0.8,
        emissive: 0x6a4a10, emissiveIntensity: 0.6,
      }),
    };
    return this._materials;
  }

  async build(onProgress) {
    /* A fresh seed per build. `build()` runs on every activation because this
     * world is volatile, so this is what makes the maze unlearnable. */
    this.seed = (Math.random() * 0xffffffff) >>> 0;

    await onProgress?.(0.05, 'Growing the hedges');

    const topo = generateTopology(this.seed, { levels: 1 });
    this.cells = topo.cells;
    this.entranceCell = topo.entranceCell;
    this.centreCell = topo.centreCell;

    /* `buildDistrictGraph` fixes the entrance at the *centre* of district
     * (10,0) - ten cells inside the grid's own edge, not on it - so nothing
     * connects it to the outside on its own. Carve a straight corridor from
     * the grid's north boundary out to the entrance and breach that boundary
     * wall. This can only open passage bits, never close any, so it cannot
     * disconnect anything that was already reachable - see
     * MazeTopology.carveEntranceCorridor. */
    const e = cellCoords(this.entranceCell);
    carveEntranceCorridor(this.cells, e);

    await onProgress?.(0.25, 'Laying the paths');

    const mats = this._ensureMaterials();
    const ew = cellToWorld(e.x, e.z, e.level);

    /* One InstancedMesh for hedges and one for floors across the whole level.
     * Phase 2 replaces this with per-district chunks; for now a single pair of
     * draw calls is both simplest and fastest. */
    const descs = [];
    for (let dz = 0; dz < MAZE.DISTRICTS; dz++) {
      for (let dx = 0; dx < MAZE.DISTRICTS; dx++) {
        for (const d of districtColliders(this.cells, dx, dz, 0)) descs.push(d);
      }
      if (dz % 4 === 0) {
        await onProgress?.(0.25 + 0.55 * (dz / MAZE.DISTRICTS), 'Laying the paths');
      }
    }

    /* The walled forecourt outside the grid where the corridor above opens.
     * The return portal stands in it rather than in the corridor itself -
     * see MazeColliders.forecourtColliders for why the generic plinth cannot
     * fit inside a 6m maze cell. */
    for (const d of forecourtColliders(ew.x, e.level)) descs.push(d);

    const hedges = descs.filter((d) => d.kind === 'hedge');
    const floors = descs.filter((d) => d.kind === 'floor');

    this._addInstanced(hedges, mats.hedge, 'maze:hedges');
    this._addInstanced(floors, mats.floor, 'maze:floors');

    await onProgress?.(0.85, 'Registering collision');

    for (const d of descs) {
      this.track(this.physics.addBox(d.cx, d.cy, d.cz, d.hx, d.hy, d.hz));
    }

    /* Spawn the player standing in the entrance cell, facing into the maze
     * (south, +z). */
    this.playerSpawn.set(ew.x, ew.y + 0.05, ew.z);
    this.playerSpawnYaw = Math.PI;

    /* The return arch stands in the middle of the forecourt rather than one
     * cell north of the entrance - that position sat inside the hedge the
     * entrance cell's own (closed, before carveEntranceCorridor) north face
     * put there, and the plinth is far too wide to fit in a maze corridor
     * regardless. `rotationY: 0` keeps `WorldManager.arrivalFor`'s arithmetic
     * (arrival = position + 2.6m along (sin(rotY), cos(rotY)), yaw = rotY +
     * PI) landing the player just south of the portal, facing +z into the
     * corridor - confirmed against `Player.forward`, where yaw=PI is +Z. */
    this.portalSpecs = [{
      position: new THREE.Vector3(ew.x, ew.y, FORECOURT_PORTAL_Z),
      rotationY: 0,
      target: 'station',
      label: 'Aether Station',
      accent: 0x8fd67a,
    }];

    this._buildCentreStack(mats.credits);

    await onProgress?.(1, 'The Verdant Coil is ready');
  }

  /** Build one InstancedMesh from a list of box descriptors. */
  _addInstanced(descs, material, name) {
    if (descs.length === 0) return;
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
  }

  /** The prize: a stack of credits at the centre, worth 100. */
  _buildCentreStack(material) {
    const c = cellCoords(this.centreCell);
    const w = cellToWorld(c.x, c.z, c.level);
    const stack = new THREE.Group();
    stack.name = 'maze:centre-stack';
    for (let i = 0; i < 7; i++) {
      const coin = new THREE.Mesh(new THREE.CylinderGeometry(0.5, 0.5, 0.08, 20), material);
      coin.position.set(
        (i % 2) * 0.04 - 0.02,
        0.06 + i * 0.09,
        Math.floor(i / 2) * 0.03 - 0.03,
      );
      coin.castShadow = true;
      stack.add(coin);
    }
    stack.position.set(w.x, w.y, w.z);
    this.group.add(stack);

    /* Deliberately NOT collidable. A 0.7m stack sits squarely in the 0.45-5.0m
     * hop band, and the centre cell has hedges on at least three sides - a
     * solid stack there would be a step onto the hedge tops. */
    this.centrePosition = new THREE.Vector3(w.x, w.y, w.z);
  }

  /** Re-generation needs a clean group and collider list each time. */
  dispose() {
    this.group.traverse((obj) => {
      if (obj.geometry) obj.geometry.dispose();
      /* InstancedMesh owns an `instanceMatrix` GPU buffer that geometry
       * disposal does not touch - it is released only through the mesh's own
       * dispose event. At ~175,600 hedge instances that is 175,600 * 16 * 4 =
       * ~11.2 MB stranded on every re-roll if this is skipped, and repeated
       * re-rolling is this world's entire premise. */
      if (obj.isInstancedMesh) obj.dispose();
    });
    this.group.clear();
    this.colliders.length = 0;
    this._built = false;
    /* Materials survive on purpose - see _ensureMaterials. */
  }
}
