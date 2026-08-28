import * as THREE from 'three';
import { Physics } from '../physics/Physics.js';
import { versionOf } from '../systems/overlayVersion.js';

/**
 * Owns the world registry, lazy generation and the world-swap sequence.
 *
 * Two design decisions worth knowing about:
 *
 * 1. **Worlds build against a private physics world.** Background generation
 *    happens while the player is walking around another world, so if a world
 *    registered its colliders straight into the live `Physics` instance the
 *    player would collide with invisible geometry from a world they are not in.
 *    Each world therefore builds into a throwaway `Physics`, and activation
 *    re-registers only that world's colliders into the shared one.
 *
 * 2. **Late injection instead of circular imports.** `NPCManager`, `PortalSystem`
 *    and `Player` all need the world manager, and the world manager needs them
 *    during activation. `attach()` breaks the cycle; `_deps()` degrades
 *    gracefully when a dependency has not been wired yet.
 */

const _v1 = new THREE.Vector3();

/** Resolve on the next animation frame so a loading bar can actually paint. */
function yieldFrame() {
  return new Promise((resolve) => requestAnimationFrame(() => resolve()));
}

/** Shared "nothing to wait for", so a slice that does not yield allocates nothing. */
const RESOLVED = Promise.resolve();

const clamp01 = (x) => (x < 0 ? 0 : x > 1 ? 1 : x);

/**
 * How long a build waits for the overlay provider (spec §4.1, owner
 * decision G). Behind the loading gate (`engine.running` false) a wait costs
 * nothing visible and a cold serverless function needs seconds, so the
 * ceiling is generous but FINITE: a hanging fetch must not hold the boot for
 * ever, and it would fail frame-gaps as `timedOut` rather than as itself. In
 * the player's frames - a prefetch, or a portal forcing its destination - the
 * world is wanted now, and 1.5 s is the most a held gateway may wait for it.
 */
const OVERLAY_GATE_MS = 8000;
const OVERLAY_BACKGROUND_MS = 1500;
const OVERLAY_TIMED_OUT = Symbol('overlay timed out');

/**
 * How long the session breaker (`_overlayBrokenAt`) stays open before ONE
 * background build asks again - a half-open probe. A breaker only a document
 * could close would stay open for the rest of the session after one hang:
 * nothing in the background asks, and the gate builds only at boot. A
 * minute bounds a dead server's cost to one fuse a minute, and the time to
 * notice a live one to the same.
 */
const OVERLAY_BREAKER_RETRY_MS = 60000;

export class WorldManager {
  /**
   * @param {{ scene: THREE.Scene, engine: any, physics: import('../physics/Physics.js').Physics,
   *           bus: import('../core/EventBus.js').EventBus, materials: any, input?: any }} ctx
   */
  constructor(ctx) {
    this.ctx = ctx;
    this.scene = ctx.scene;
    this.engine = ctx.engine;
    this.physics = ctx.physics;
    this.bus = ctx.bus;
    this.materials = ctx.materials;

    /** @type {Map<string, typeof import('./World.js').World>} */
    this._classes = new Map();
    /** @type {Map<string, import('./World.js').World>} */
    this._instances = new Map();
    /** In-flight builds, so concurrent `build(id)` calls share one generation pass. */
    this._building = new Map();
    /** Serialises overlapping `activate()` calls (portal spam, debug console). */
    this._activation = null;

    this._active = null;

    /** The provider ceilings, on the instance so a test can shorten one. */
    this.overlayGateMs = OVERLAY_GATE_MS;
    this.overlayBackgroundMs = OVERLAY_BACKGROUND_MS;
    /**
     * Worlds whose overlay failure has been said, until the next answer: once
     * per OUTAGE, not once for ever, so a volatile world that fails, answers,
     * then fails again is news twice. @type {Set<string>}
     */
    this._overlayWarned = new Set();
    /**
     * The session breaker: when the last BACKGROUND lookup timed out, on
     * `this.now`'s clock, or null while closed. A provider that HANGS - not
     * one that fails fast - would cost every background build its whole
     * fuse: seventeen worlds on the prefetch chain at 1.5 s each, and a
     * `--chain-timeout` under `?prefetch=all`. One background timeout opens
     * this, and background builds skip the provider (built at 0, nothing
     * said, no fuse) until it closes: a lookup answers with a document - a
     * gate build's, which always asks, or the late answer of the very lookup
     * that was abandoned, which proves the server slow rather than dead - or
     * `OVERLAY_BREAKER_RETRY_MS` passes and ONE background build probes
     * again - literally one: the probe re-stamps this from its own start,
     * so a build that begins during its fuse skips, and a probe that hangs
     * leaves it re-opened from that moment, so a dead server costs one
     * fuse a minute. A GATE timeout never opens it: the boot pays its own
     * fuse once, and says nothing about the frames after. One more closer,
     * unreachable in practice: a lookup's abandoned null landing INSIDE the
     * fuse of a background build that joined that lookup is an in-fuse
     * answer to that build and closes it through the else branch - which
     * needs a lookup started outside the manager while the breaker is open,
     * with its ceiling falling inside the probe's fuse.
     * @type {number|null}
     */
    this._overlayBrokenAt = null;
    /** The breaker's clock, on the instance so a test can own the minute. */
    this.now = () => performance.now();

    /**
     * What the last crossing cost, step by step, in milliseconds.
     * Written by `_activate`; read by `HARNESS.stats().activation`.
     * @type {object|null}
     */
    this.activationCost = null;

    // Late-injected collaborators. See attach().
    this.npcManager = null;
    this.portals = null;
    this.player = null;
  }

  /* ------------------------------------------------------------------ */
  /* Registry                                                            */
  /* ------------------------------------------------------------------ */

  /**
   * Register a World subclass. Registration is metadata-only - nothing is
   * constructed or generated until the world is first requested.
   * @param {typeof import('./World.js').World} WorldClass
   */
  register(WorldClass) {
    const id = WorldClass.id;
    if (!id || id === 'base') {
      throw new Error('[WorldManager] world class is missing a unique static id');
    }
    this._classes.set(id, WorldClass);
    return this;
  }

  /**
   * Wire in the systems that must react to a world swap. Called by main.js after
   * every subsystem exists, because those systems also need a reference to this
   * manager and a direct import would be circular.
   * @param {{ npcManager?: any, portals?: any, player?: any }} deps
   */
  attach(deps = {}) {
    if (deps.npcManager) this.npcManager = deps.npcManager;
    if (deps.portals) this.portals = deps.portals;
    if (deps.player) this.player = deps.player;
    return this;
  }

  /**
   * Dependencies resolved at call time. Falls back to the debug handle main.js
   * publishes so activation still works if `attach()` was never called.
   */
  _deps() {
    const g = /** @type {any} */ (globalThis).GAME;
    return {
      npcManager: this.npcManager || g?.npcManager || null,
      portals: this.portals || g?.portals || null,
      player: this.player || g?.player || null,
    };
  }

  /** @returns {string[]} registered world ids, in registration order. */
  get ids() {
    return [...this._classes.keys()];
  }

  /** @returns {import('./World.js').World | null} */
  get active() {
    return this._active;
  }

  /** Display name without paying for instantiation. */
  displayNameOf(id) {
    return this._classes.get(id)?.displayName ?? id;
  }

  /**
   * Get (constructing on first use) the world instance for an id.
   * The returned world may not be built yet - check `isBuilt(id)`.
   * @param {string} id
   * @returns {import('./World.js').World}
   */
  getWorld(id) {
    let world = this._instances.get(id);
    if (world) return world;
    const WorldClass = this._classes.get(id);
    if (!WorldClass) throw new Error(`[WorldManager] unknown world "${id}"`);
    // Each world gets its own ctx so `physics` can be swapped for the duration
    // of the build without mutating the shared context object.
    world = new WorldClass({ ...this.ctx });
    this._instances.set(id, world);
    return world;
  }

  /** @param {string} id */
  isBuilt(id) {
    const world = this._instances.get(id);
    return !!(world && world._built);
  }

  /** True when this world re-generates on every activation. */
  isVolatile(id) {
    return this._classes.get(id)?.volatile === true;
  }

  /** True while a build for `id` is running. */
  isBuilding(id) {
    return this._building.has(id);
  }

  /* ------------------------------------------------------------------ */
  /* Generation                                                          */
  /* ------------------------------------------------------------------ */

  /**
   * Generate a world. Idempotent: a second call while a build is in flight
   * joins the existing one rather than generating twice.
   *
   * @param {string} id
   * @param {(progress:number, label:string)=>void} [onProgress] 0..1 + a status label
   * @returns {Promise<import('./World.js').World>}
   */
  async build(id, onProgress) {
    const world = this.getWorld(id);
    /* A volatile world re-generates on every request rather than serving its
     * cached build. The maze uses this: a layout that survived the last visit
     * would be a layout the player could learn.
     *
     * Guarded against the world currently being *active*: `_activate` calls
     * `build(id)` on its own target before touching anything else, and if
     * that target were already the live world this would clear its group and
     * rebuild into a scratch physics world while the *live* physics world -
     * which `_activate` only rebuilds afterwards, from `world.colliders` -
     * kept serving the collision data that was just discarded. Invisible
     * walls, not missing ones. Not reachable through any current call site
     * (nothing re-activates the world that is already active), but cheap
     * insurance against a future one that does. */
    const volatile = this._classes.get(id)?.volatile === true;
    if (world._built && volatile && this._active !== world) {
      world.dispose();
    }
    if (world._built) {
      onProgress?.(1, `${world.displayName} ready`);
      return world;
    }

    let entry = this._building.get(id);
    if (!entry) {
      entry = { listeners: new Set(), progress: 0, label: `Generating ${world.displayName}`, promise: null };
      entry.promise = this._runBuild(world, entry).finally(() => this._building.delete(id));
      this._building.set(id, entry);
    }

    if (onProgress) {
      entry.listeners.add(onProgress);
      onProgress(entry.progress, entry.label);
    }
    try {
      return await entry.promise;
    } finally {
      if (onProgress) entry.listeners.delete(onProgress);
    }
  }

  /**
   * The actual generation pass. Runs the world against a scratch physics world
   * and harvests its colliders afterwards.
   */
  async _runBuild(world, entry) {
    const realPhysics = this.physics;
    // A private collision world per build: two generations can legitimately be
    // in flight at once (background streaming plus a portal forcing its target)
    // and they must not see each other's geometry.
    const scratch = new Physics(this.bus);

    let lastYield = performance.now();

    /**
     * Progress relay. Returns a promise so a world may `await onProgress(...)`
     * to yield; worlds that call it synchronously still get a repainted bar
     * because we only actually stall when enough time has passed.
     */
    const report = (p, label) => {
      entry.progress = clamp01(typeof p === 'number' ? p : 0);
      if (label) entry.label = label;
      for (const fn of entry.listeners) {
        try {
          fn(entry.progress, entry.label);
        } catch (err) {
          console.error('[WorldManager] progress listener threw:', err);
        }
      }
      const now = performance.now();
      if (now - lastYield > 24) {
        lastYield = now;
        return yieldFrame();
      }
      return RESOLVED;
    };

    /**
     * Mid-phase yield, for a build phase that is one long synchronous pass.
     *
     * `report` above is only reachable BETWEEN phases, so the finest grain it
     * can hand back is one whole phase - and a phase can be enormous. The
     * station's set-dressing settle is a single 3.2 s pass measured on this
     * machine, which is one 3.2 s frame no matter how diligently the phases on
     * either side of it yield. This is the same relay called from inside such a
     * pass, and it shares `report`'s 24 ms clock deliberately: a phase that
     * slices and a build that steps must not each be spending a budget of
     * their own, or the two together would stall twice as often as either was
     * asked to.
     *
     * ── Why it does nothing behind the loading screen ─────────────────────
     * The entry world is built before `engine.start()`, with the loading
     * screen up and no gameplay frame in existence to protect. Every yield
     * taken there is wall clock added to the boot and buys nothing anybody can
     * see - a `requestAnimationFrame` round trip is ~8 ms on a 120 Hz panel,
     * so slicing the station's 6.5 s entry build to a 24 ms budget would have
     * added roughly two seconds to the loading screen for no visible gain.
     * The builds that must not block are the ones `scheduleBackgroundBuilds`
     * starts AFTER the gate opens, in the player's frames, and
     * `engine.running` is exactly that distinction - already true, already
     * maintained, and needing no flag threaded down through the world classes
     * to say which kind of build this is.
     *
     * The coarse per-phase yields are untouched in both directions. They are
     * what repaints the loading bar, and a boot that never yielded at all
     * would leave it frozen at whatever it last said.
     */
    report.slice = (p, label) => (this.engine?.running ? report(p, label) : RESOLVED);

    // Redirect collider registration for the duration of the build.
    world.physics = scratch;
    world.ctx.physics = scratch;

    try {
      await report(0, `Generating ${world.displayName}`);
      // The overlay, from whatever provides one (spec §4.1). Asked here, before
      // the world builds and inside the scratch-physics window, because stage
      // 3's primitives will consult it as they build; today only its version
      // is kept, on the world, for the report.
      world.builtVersion = await this._overlayVersion(world, report);
      await world.ensureBuilt(report);
    } finally {
      world.physics = realPhysics;
      world.ctx.physics = realPhysics;
    }

    // Harvest anything the world registered but forgot to track(), so a missing
    // track() call degrades into a working world rather than a hole in the floor.
    if (scratch.colliders.length !== world.colliders.length) {
      const tracked = new Set(world.colliders);
      for (const c of scratch.colliders) if (!tracked.has(c)) world.colliders.push(c);
    }
    scratch.clear();

    world.group.visible = false;
    await report(1, `${world.displayName} ready`);
    return world;
  }

  /**
   * The overlay version this build consumes: what `ctx.overlayProvider`
   * answers for the world, or 0.
   *
   * Reads THE MANAGER'S ctx, not the world's: `getWorld` spreads a copy per
   * world, and main.js sets the provider on the shared object after the
   * worlds exist. No provider means no await and no timer - seven headless
   * suites build worlds through this class with nothing on ctx, and the
   * slicing test counts every frame a build hands back.
   *
   * A failure or a timeout is a world with no overlay, which is what every
   * world was before this existed: said once per outage, and MapOverlay still
   * applies named-object entries live after the build.
   *
   * The wait is named on the loader. Behind the gate a cold function can take
   * seconds, and a bar that says "Generating" through them says the build is
   * slow; it says "Generating" again once the answer is in, because a world
   * that labels none of its own phases would otherwise sit on "Reading the
   * map" for the whole build.
   *
   * @param {import('./World.js').World} world
   * @param {(p:number, label?:string) => Promise<void>} [report] the build's progress relay
   * @returns {Promise<number>}
   */
  async _overlayVersion(world, report) {
    const provider = this.ctx?.overlayProvider;
    if (typeof provider !== 'function') return 0;
    const background = this.engine?.running === true;
    if (background && this._overlayBreakerOpen()) return 0;
    // The probe: a background build past that check with the breaker still
    // stamped is the one asking after the minute, and it re-opens the
    // breaker from ITS OWN start, not from its timeout - or every background
    // build that began during its fuse would ask too, and "one probe a
    // minute" would be one probe plus the rest of the chain. Stamped HERE,
    // in the same synchronous step as the check: the label's await below
    // is exactly where the next build on the chain would otherwise slip
    // past a check that had not yet been re-armed. Its answer closes it.
    if (background && this._overlayBrokenAt !== null) this._overlayBrokenAt = this.now();
    const limit = background ? this.overlayBackgroundMs : this.overlayGateMs;
    await report?.(0, `Reading the map for ${world.displayName}`);
    let timer = null;
    let version = 0;
    try {
      const lookup = Promise.resolve().then(() => provider(world.id));
      // A document closes the breaker whenever it lands - inside the fuse or
      // long after this build gave up on it. So does ANY answer inside the
      // fuse, null included (the else branch below): a provider that answered
      // in time is not hanging. A late null does not - it is what
      // MapOverlay.lookup answers for its own abandoned fetch - nor does a
      // rejection.
      lookup.then((doc) => { if (doc && typeof doc === 'object') this._overlayBrokenAt = null; }, () => {});
      const fuse = new Promise((resolve) => { timer = setTimeout(() => resolve(OVERLAY_TIMED_OUT), limit); });
      const doc = await Promise.race([lookup, fuse]);
      if (doc === OVERLAY_TIMED_OUT) {
        // A background hang opens the breaker - or re-opens it from now, when
        // this build was the probe. A gate hang does not: see the field.
        if (background) this._overlayBrokenAt = this.now();
        this._overlayUnavailable(world.id, `no answer within ${limit} ms`);
      } else {
        // An answer ends the outage and closes the breaker: the next failure
        // of this world is news, and the next background build asks.
        this._overlayWarned.delete(world.id);
        this._overlayBrokenAt = null;
        version = versionOf(doc);
      }
    } catch (err) {
      this._overlayUnavailable(world.id, err?.message ?? err);
    } finally {
      if (timer !== null) clearTimeout(timer);
    }
    await report?.(0, `Generating ${world.displayName}`);
    return version;
  }

  /** Open: a background lookup hung within the last `OVERLAY_BREAKER_RETRY_MS`, on `this.now`'s clock. */
  _overlayBreakerOpen() {
    return this._overlayBrokenAt !== null && this.now() - this._overlayBrokenAt < OVERLAY_BREAKER_RETRY_MS;
  }

  _overlayUnavailable(id, why) {
    if (this._overlayWarned.has(id)) return;
    this._overlayWarned.add(id);
    console.warn(`[WorldManager] overlay unavailable for "${id}": ${why}; building without it`);
  }

  /* ------------------------------------------------------------------ */
  /* Activation                                                          */
  /* ------------------------------------------------------------------ */

  /**
   * Make a world the live one: swap scene graph, physics, spawn point, NPCs and
   * portals. Safe to call while another activation is running - calls queue.
   *
   * @param {string} id
   * @param {{ fromPortal?: any }} [options] `fromPortal` is the portal the player
   *   stepped into; the arrival point becomes the matching return portal.
   */
  async activate(id, options = {}) {
    // Queue rather than interleave: two half-applied world swaps would leave the
    // physics world holding colliders from both.
    while (this._activation) {
      try {
        await this._activation;
      } catch {
        /* the failed activation reports its own error */
      }
    }
    this._activation = this._activate(id, options);
    try {
      return await this._activation;
    } finally {
      this._activation = null;
    }
  }

  async _activate(id, { fromPortal = null } = {}) {
    const world = await this.build(id);
    const previous = this._active;
    if (previous === world) return world;

    const { npcManager, portals, player } = this._deps();

    /* ── THE COST OF A CROSSING, BROKEN DOWN, ON THE SHIPPING BUNDLE ──────
     *
     * A world swap is one synchronous block and the player feels all of it,
     * but "the crossing took 1.6 s" names nothing you can fix. A CPU profile
     * names functions - and on the production bundle those functions are
     * called `pv` and `Hn`, so the profile that answers the question can only
     * be taken on a build whose numbers do not satisfy the criterion.
     *
     * These labels are string constants, so they survive minification intact.
     * Eight `performance.now()` calls per crossing is nothing against a block
     * measured in seconds, and the result is readable from
     * `HARNESS.stats().activation` on the same bytes the site serves.
     *
     * `changed` is the whole `world:changed` fan-out - water volumes, relics,
     * caches, minigames, races, loot - which is a listener list, not a call
     * site, and is otherwise invisible from here. */
    const T = (typeof performance !== 'undefined' && performance.now)
      ? () => performance.now() : () => 0;
    const cost = { world: id, from: previous?.id ?? null, colliders: 0 };
    let t = T();
    const step = (name) => { const n = T(); cost[name] = Math.round((n - t) * 10) / 10; t = n; };
    const t0 = t;

    this.bus.emit('world:changing', { from: previous?.id ?? null, to: id });
    step('changing');

    // 1. Tear the old world down. Portals first: their colliders live in the
    //    same physics world and must not survive the clear/rebuild below.
    portals?.clear?.();
    npcManager?.clear?.();
    if (previous) {
      previous.onDeactivate();
      this.scene.remove(previous.group);
    }
    step('teardown');

    // 2. Rebuild the collision world from scratch so only this world is solid.
    //    Character proxies are owned by gameplay systems, not by worlds, so they
    //    survive the wipe (NPC proxies were already dropped by npcManager.clear).
    const survivingCharacters = this.physics.characters.size
      ? [...this.physics.characters]
      : null;
    this.physics.clear();
    if (survivingCharacters) for (const c of survivingCharacters) this.physics.characters.add(c);
    step('physicsClear');
    for (let i = 0; i < world.colliders.length; i++) {
      const c = world.colliders[i];
      if (c) this.physics.add(c);
    }
    cost.colliders = world.colliders.length;
    cost.gridCells = this.physics._grid.size;
    cost.gridWrites = this.physics.gridWrites;
    step('physicsAdd');

    // 3. Bring the new world in.
    this.scene.add(world.group);
    world.onActivate();
    world.group.updateMatrixWorld(true);
    this._active = world;
    step('sceneIn');

    // 4. Portals before the player: their plinths register colliders, and the
    //    arrival point is on top of one of them - without them the ground probe
    //    would drop the player through the dais.
    try {
      portals?.buildForWorld?.(world);
    } catch (err) {
      console.error(`[WorldManager] portal build failed for "${id}":`, err);
    }
    step('portals');

    // 5. Place the player before anything queries their position.
    const arrival = this.arrivalFor(id, fromPortal ? fromPortal.worldId ?? previous?.id ?? null : null);
    if (player) {
      if (typeof player.teleport === 'function') {
        player.teleport(arrival.position, arrival.yaw);
      } else if (player.position) {
        player.position.copy(arrival.position);
      }
    }
    step('arrival');

    // 6. Populate. Optional, so a partially wired game still runs.
    try {
      npcManager?.spawnForWorld?.(world);
    } catch (err) {
      console.error(`[WorldManager] npc spawn failed for "${id}":`, err);
    }
    step('npcs');

    this.bus.emit('world:changed', { id, world });
    step('changed');

    cost.total = Math.round((T() - t0) * 10) / 10;
    this.activationCost = cost;
    return world;
  }

  /* ------------------------------------------------------------------ */
  /* Spawn placement                                                     */
  /* ------------------------------------------------------------------ */

  /**
   * Where the player should stand when entering `targetId`.
   *
   * Arriving through a portal puts the player a couple of metres in front of the
   * portal that leads back where they came from, facing away from it - so the
   * gateway is behind you and the new world is laid out ahead, exactly like
   * stepping out of a doorway.
   *
   * @param {string} targetId
   * @param {string|null} fromWorldId world the player is arriving from, or null for a cold spawn
   * @param {{ snapToGround?: boolean }} [opts] pass `snapToGround:false` when the
   *   target world is not the live one (the physics world holds someone else's floor).
   * @returns {{ position: THREE.Vector3, yaw: number, portalSpec: object|null }}
   */
  arrivalFor(targetId, fromWorldId = null, opts = {}) {
    const snapToGround = opts.snapToGround !== false && this._active?.id === targetId;
    const world = this.getWorld(targetId);
    const position = new THREE.Vector3().copy(world.playerSpawn);
    let yaw = world.playerSpawnYaw ?? 0;
    let spec = null;

    if (fromWorldId) {
      spec = world.portalSpecs?.find((s) => s.target === fromWorldId) ?? null;
      if (spec) {
        // Portal local +Z is its front face; stand out in front of it.
        const rotY = spec.rotationY ?? 0;
        const nx = Math.sin(rotY);
        const nz = Math.cos(rotY);
        const offset = 2.6;
        position.set(
          spec.position.x + nx * offset,
          spec.position.y,
          spec.position.z + nz * offset
        );
        // Characters look down -Z at yaw 0, so facing outward along the portal
        // normal means yaw = rotationY + PI.
        yaw = rotY + Math.PI;

        // If the front side has no floor (author faced the arch at a wall) flip.
        if (snapToGround) {
          const frontGround = this.physics.groundHeight(position.x, position.z, position.y + 1.2, 12);
          if (frontGround === null) {
            const back = _v1.set(
              spec.position.x - nx * offset,
              spec.position.y,
              spec.position.z - nz * offset
            );
            if (this.physics.groundHeight(back.x, back.z, back.y + 1.2, 12) !== null) {
              position.copy(back);
              yaw = rotY;
            }
          }
        }
      }
    }

    // Settle onto the floor so nobody spawns buried or falling from the sky.
    // The probe starts just above the authored spawn, never high overhead - a
    // spawn under a roof must not snap the player onto the roof.
    if (snapToGround) {
      const ground = this.physics.groundHeight(position.x, position.z, position.y + 1.2, 12);
      if (ground !== null) position.y = ground + 0.05;
    }

    return { position, yaw, portalSpec: spec };
  }

  /* ------------------------------------------------------------------ */
  /* Teardown                                                            */
  /* ------------------------------------------------------------------ */

  /** Free every built world. Only used on a full teardown / hot reload. */
  dispose() {
    for (const world of this._instances.values()) {
      if (world.group.parent) world.group.parent.remove(world.group);
      world.dispose();
    }
    this._instances.clear();
    this._building.clear();
    this._overlayWarned.clear();
    this._overlayBrokenAt = null;
    this._active = null;
  }
}
