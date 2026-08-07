import * as THREE from 'three';
import { DEFAULT_RULES } from './WorldRules.js';

/**
 * Base class every world implements.
 *
 * A world owns a single THREE.Group plus the collision, lighting, spawn and
 * portal metadata that the rest of the game reads. Worlds are built once and
 * then activated/deactivated - `build()` is async so heavy generation can yield
 * to the browser and drive a loading bar.
 *
 * Contract for subclasses:
 *   static id            unique string key ('station' | 'medieval' | 'sports')
 *   static displayName   shown in the HUD and loading screen
 *   async build()        populate group / colliders / spawns / portalSpecs
 *   update(dt, elapsed)  per-frame world animation (called only while active)
 */
export class World {
  static id = 'base';
  static displayName = 'Untitled World';

  /**
   * @param {{ scene: THREE.Scene, engine: import('../core/Engine.js').Engine,
   *           physics: import('../physics/Physics.js').Physics,
   *           bus: import('../core/EventBus.js').EventBus,
   *           materials: any }} ctx
   */
  constructor(ctx) {
    this.ctx = ctx;
    this.scene = ctx.scene;
    this.engine = ctx.engine;
    this.physics = ctx.physics;
    this.bus = ctx.bus;
    this.materials = ctx.materials;

    /** Root node. Everything the world creates must be parented here. */
    this.group = new THREE.Group();
    this.group.name = `world:${this.constructor.id}`;

    /** Colliders this world registered, so they can be removed on unload. */
    this.colliders = [];

    /** Where the player appears when entering this world. */
    this.playerSpawn = new THREE.Vector3(0, 2, 0);
    /** Player yaw on spawn, radians. */
    this.playerSpawnYaw = 0;

    /**
     * NPC spawn descriptors.
     * @type {Array<{ position: THREE.Vector3, type: 'friendly'|'hostile',
     *                persona?: string, patrol?: THREE.Vector3[] }>}
     */
    this.npcSpawns = [];

    /**
     * Portal descriptors consumed by the portal system.
     * @type {Array<{ position: THREE.Vector3, rotationY: number,
     *                target: string, label: string, accent: number }>}
     */
    this.portalSpecs = [];

    /** Bounds used by the minimap to frame the world. */
    this.bounds = new THREE.Box3(
      new THREE.Vector3(-200, -20, -200),
      new THREE.Vector3(200, 200, 200)
    );

    /**
     * Minimap geometry: flat shapes drawn as the world's floorplan.
     * @type {Array<{ kind:'rect'|'circle'|'path', ...any }>}
     */
    this.minimapShapes = [];

    /**
     * Per-world capability gates. Everything is permitted by default, so an
     * existing world behaves exactly as it did before rules existed.
     * @see ./WorldRules.js
     */
    this.rules = DEFAULT_RULES;

    /** Per-world environment settings applied on activation. */
    this.environment = {
      background: new THREE.Color(0x05070d),
      fogColor: new THREE.Color(0x0a0e18),
      fogNear: 30,
      fogFar: 320,
      exposure: 1.0,
      ambientColor: new THREE.Color(0x404a60),
      ambientIntensity: 0.6,
      sunColor: new THREE.Color(0xffffff),
      sunIntensity: 2.0,
      sunDirection: new THREE.Vector3(-0.4, 0.85, -0.3).normalize(),
      envMapIntensity: 1.0,
      /** Bloom override; null keeps the global default. */
      bloom: null,
    };

    this._built = false;
    this.active = false;
  }

  get id() {
    return this.constructor.id;
  }

  get displayName() {
    return this.constructor.displayName;
  }

  /** Subclasses override. Must be idempotent-safe via the `_built` guard. */
  async build() {
    throw new Error(`${this.constructor.name} must implement build()`);
  }

  /** Called by WorldManager; wraps build() with the guard and timing. */
  async ensureBuilt(onProgress) {
    if (this._built) return;
    const t0 = performance.now();
    await this.build(onProgress);
    this._built = true;
    console.info(
      `[World] built "${this.id}" in ${Math.round(performance.now() - t0)}ms ` +
        `(${this.colliders.length} colliders, ${this.npcSpawns.length} npc spawns)`
    );
  }

  /** Register a collider and remember it for cleanup. */
  track(collider) {
    if (collider) this.colliders.push(collider);
    return collider;
  }

  /** Per-frame animation. Only called while this world is active. */
  update(_dt, _elapsed) {}

  /** Called when the world becomes the active one. */
  onActivate() {
    this.active = true;
    this.group.visible = true;
  }

  /** Called when the player leaves for another world. */
  onDeactivate() {
    this.active = false;
    this.group.visible = false;
  }

  /** Free GPU resources. Called only on a full teardown. */
  dispose() {
    this.group.traverse((obj) => {
      if (obj.geometry) obj.geometry.dispose();
      const mat = obj.material;
      if (Array.isArray(mat)) mat.forEach((m) => m.dispose?.());
      else mat?.dispose?.();
    });
    this.group.clear();
    this.colliders.length = 0;
    this._built = false;
  }

  /**
   * Helper: add a mesh to the world and register a box collider for it.
   * Worlds use this constantly, so it lives on the base class.
   */
  addSolid(mesh, opts = {}) {
    this.group.add(mesh);
    mesh.castShadow = opts.castShadow ?? true;
    mesh.receiveShadow = opts.receiveShadow ?? true;
    if (opts.collide !== false) {
      this.track(this.physics.addBoxFromObject(mesh, { userData: opts.userData }));
    }
    return mesh;
  }
}
