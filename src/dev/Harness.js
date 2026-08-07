/**
 * Automated screenshot harness.
 *
 * Loaded only when the page is opened with ?dev=1. It gives the visual-review
 * tooling deterministic control over which world is loaded, where the camera
 * sits, and whether the HUD is composited - so a critique compares art
 * direction rather than whatever the player happened to be looking at.
 *
 * Everything here is dev-only and is tree-shaken out of a normal boot.
 */

/**
 * Camera framings, derived from each world's actual published layout
 * (portalSpecs, minimapShapes and bounds) rather than guessed. Framings that
 * point at empty ground make a visual review worthless, so these are checked
 * against the real geometry - see the layout dump in tools/world-layout.json.
 */
const VIEWS = {
  /* The hub plaza is a r40 circle at the origin; portals sit at z = -54
   * (medieval) and z = +54 (sports); the hub deck is r200 inside a hull at 202.
   *
   * Beyond that the station is four more decks of the same size, each on the
   * end of a 96 m link off avenue 120 / 180 / 240 / 300, all under one 720 m
   * dome. Zone centres are at radius 498 on those bearings:
   *
   *     habitation  (-249,  431)      gym          (-498,   0)
   *     construction(-249, -431)      canteen      ( 249, -431)
   *
   * Each zone has an open court inside r112 and a covered arcade out to its
   * rim, so the two useful framings per zone are one from the arrival plaza
   * looking in across the court, and one inside the arcade. */
  station: [
    { name: 'plaza-wide', pos: [0, 9, 96], look: [0, 5, 0], fov: 70 },
    { name: 'plaza-centre', pos: [0, 3, 34], look: [0, 5, -30], fov: 74 },
    { name: 'portal-medieval', pos: [0, 4, -30], look: [0, 5.5, -54], fov: 60 },
    { name: 'portal-sports', pos: [0, 4, 30], look: [0, 5.5, 54], fov: 60 },
    { name: 'street-level', pos: [-34, 1.7, 2], look: [0, 4, 0], fov: 75 },
    { name: 'district-east', pos: [104, 4, 40], look: [60, 8, -10], fov: 72 },
    { name: 'hull-outward', pos: [70, 10, 0], look: [190, 30, 0], fov: 80 },
    // The apron, seen through the great window - the view the whole outer ring
    // was arranged around.
    { name: 'window-apron', pos: [150, 6, 0], look: [520, 40, 40], fov: 82 },
    { name: 'apron-wide', pos: [300, 60, 60], look: [0, 30, 0], fov: 80 },
    // Looking back at the hub from outside it, under the dome.
    { name: 'dome-inside', pos: [-360, 40, 0], look: [0, 60, 0], fov: 84 },
    // The habitat stacks on avenue 120, which are now enterable.
    { name: 'hab-stacks', pos: [-70, 6, 96], look: [-110, 20, 150], fov: 74 },
    { name: 'hab-lobby', pos: [-61, 2.0, 118], look: [-75, 3, 132], fov: 78 },
    // One link, from the hull end looking out to the zone.
    { name: 'link-galley', pos: [110, 3, -186], look: [160, 5, -272], fov: 76 },
    // The four zones: arrival, then court.
    { name: 'zone-habitation', pos: [-206, 8, 358], look: [-249, 14, 431], fov: 76 },
    { name: 'zone-habitation-court', pos: [-249, 4, 505], look: [-249, 30, 431], fov: 80 },
    { name: 'zone-gym', pos: [-414, 8, 0], look: [-498, 12, 0], fov: 76 },
    { name: 'zone-gym-court', pos: [-425, 3, 40], look: [-498, 10, -10], fov: 80 },
    { name: 'zone-construction', pos: [-206, 8, -358], look: [-249, 30, -431], fov: 76 },
    { name: 'zone-construction-court', pos: [-190, 6, -470], look: [-260, 40, -430], fov: 80 },
    { name: 'zone-canteen', pos: [206, 8, -358], look: [249, 12, -431], fov: 76 },
    { name: 'zone-canteen-court', pos: [300, 4, -470], look: [240, 12, -420], fov: 80 },
  ],
  // Castle occupies x -130..-14, z -109..-7 (centre -72,-58); village clusters
  // around (34,18); portal back to the station at (2, 9.3, -22).
  medieval: [
    { name: 'castle-approach', pos: [-40, 12, 55], look: [-72, 20, -45], fov: 70 },
    { name: 'castle-gate', pos: [-72, 8, 15], look: [-72, 16, -40], fov: 68 },
    { name: 'village-square', pos: [58, 5, 48], look: [28, 4, 12], fov: 74 },
    { name: 'village-street', pos: [20, 2.2, 40], look: [36, 3.5, 14], fov: 76 },
    { name: 'ramparts-vista', pos: [-72, 32, -58], look: [34, 6, 20], fov: 78 },
    { name: 'portal', pos: [2, 11, 6], look: [2, 10.5, -22], fov: 62 },
    { name: 'hills-vista', pos: [120, 28, 118], look: [-40, 12, -20], fov: 80 },
  ],
  // Skate park centre (-75, 38) with bowls at (-95,40) r13 and (-77,34) r10;
  // ski zone centre (-62,-136); courts at (112,26) and (78,21)/(78,32);
  // track (128,162); pool (46,111); entrance portal at (0, 0.4, 150).
  sports: [
    { name: 'skatepark-wide', pos: [-40, 11, 96], look: [-82, 0, 38], fov: 72 },
    { name: 'skatepark-bowl', pos: [-95, 5, 66], look: [-95, -3, 38], fov: 74 },
    { name: 'bowl-interior', pos: [-95, 1.6, 50], look: [-88, 1, 24], fov: 80 },
    { name: 'ski-slope', pos: [-62, 18, -45], look: [-62, 34, -150], fov: 74 },
    { name: 'courts', pos: [95, 9, 74], look: [104, 1, 26], fov: 70 },
    { name: 'track', pos: [128, 16, 232], look: [128, 2, 162], fov: 74 },
    { name: 'pool', pos: [46, 7, 142], look: [46, 0, 111], fov: 72 },
    { name: 'entrance-portal', pos: [0, 3.5, 170], look: [0, 2.5, 150], fov: 64 },
  ],
  // Entrance forecourt centred at (1260, -10); maze grid runs from origin to 2394 m
  // on both axes; hedges 5 m tall.
  maze: [
    { name: 'forecourt', pos: [1260, 4, -16], look: [1260, 2, 20], fov: 75 },
    { name: 'corridor', pos: [1260, 1.7, 40], look: [1260, 1.7, 120], fov: 75 },
    { name: 'above-entrance', pos: [1260, 60, -40], look: [1260, 0, 200], fov: 70 },
  ],
};

class Harness {
  constructor(game) {
    this.game = game;
    this.savedFov = game.engine.camera.fov;
    this._detach = null;
    this.hudHidden = false;
  }

  /** Resolve once the first world is active and at least one frame has rendered. */
  async ready(timeoutMs = 120000) {
    const t0 = performance.now();
    while (!this.game.worldManager.active) {
      if (performance.now() - t0 > timeoutMs) throw new Error('harness: world never activated');
      await frame();
    }
    for (let i = 0; i < 3; i++) await frame();
    return this.game.worldManager.active.id;
  }

  /** Switch worlds without the portal transition. */
  async goto(worldId) {
    if (!this.game.worldManager.isBuilt?.(worldId)) {
      await this.game.worldManager.build(worldId);
    }
    await this.game.worldManager.activate(worldId);
    for (let i = 0; i < 4; i++) await frame();
    return worldId;
  }

  viewNames(worldId) {
    return (VIEWS[worldId] ?? []).map((v) => v.name);
  }

  /**
   * Park the camera at a named preset. Detaches the player controller so the
   * camera does not get overwritten on the next frame.
   */
  async view(name, settle = 6) {
    const worldId = this.game.worldManager.active?.id;
    const list = VIEWS[worldId] ?? [];
    const v = typeof name === 'number' ? list[name] : list.find((x) => x.name === name);
    if (!v) throw new Error(`harness: no view "${name}" in world "${worldId}"`);

    this.freezeCamera(true);
    const cam = this.game.engine.camera;
    cam.position.set(v.pos[0], v.pos[1], v.pos[2]);
    cam.lookAt(v.look[0], v.look[1], v.look[2]);
    cam.fov = v.fov;
    cam.updateProjectionMatrix();

    // Let temporal effects (AO, grain, adaptive resolution) settle before capture.
    for (let i = 0; i < settle; i++) await frame();
    return { world: worldId, view: v.name };
  }

  /** Free-fly the camera to an arbitrary transform. */
  async look(pos, target, fov = 70, settle = 6) {
    this.freezeCamera(true);
    const cam = this.game.engine.camera;
    cam.position.set(pos[0], pos[1], pos[2]);
    cam.lookAt(target[0], target[1], target[2]);
    cam.fov = fov;
    cam.updateProjectionMatrix();
    for (let i = 0; i < settle; i++) await frame();
  }

  /**
   * Freeze absolutely everything that can move a subject out of frame.
   *
   * `engine.setPaused(true)` stops the fixed/frame updaters but a mount keeps
   * driving itself, so framing a rider used to require stubbing the mount's own
   * fixedUpdate by hand. This does that centrally: pause the engine, freeze the
   * camera, and neutralise the active mount and the NPC manager.
   */
  freezeAll(on = true) {
    const G = this.game;
    G.engine.setPaused(on);
    this.freezeCamera(on);
    const mount = G.mounts?.active;
    if (on) {
      this._stubs = [];
      const stub = (obj, key) => {
        if (!obj || typeof obj[key] !== 'function') return;
        this._stubs.push([obj, key, obj[key]]);
        obj[key] = () => {};
      };
      stub(mount, 'fixedUpdate');
      stub(mount, 'update');
      stub(G.npcManager, 'fixedUpdate');
    } else {
      for (const [obj, key, fn] of this._stubs ?? []) obj[key] = fn;
      this._stubs = [];
    }
    return { paused: on, mount: mount?.id ?? null };
  }

  /** Suppress the player's camera writes so harness framing sticks. */
  freezeCamera(on) {
    const player = this.game.player;
    if (!player) return;
    if (on && !this._detach) {
      this._detach = true;
      player._harnessFrozen = true;
    } else if (!on && this._detach) {
      this._detach = null;
      player._harnessFrozen = false;
      this.game.engine.camera.fov = this.savedFov;
      this.game.engine.camera.updateProjectionMatrix();
    }
  }

  /** Move the player (and camera) to a spot and hand control back. */
  async teleport(x, y, z, yaw = 0) {
    this.freezeCamera(false);
    this.game.player.teleport(new this.game.THREE.Vector3(x, y, z), yaw);
    for (let i = 0; i < 4; i++) await frame();
  }

  hideHud(hide = true) {
    this.hudHidden = hide;
    const root = document.getElementById('ui-root');
    if (root) root.style.opacity = hide ? '0' : '1';
  }

  /** Skip the click-to-enter gate. */
  dismissBoot() {
    document.querySelector('.boot-screen')?.remove();
  }

  /** Collected runtime errors, for the review harness to assert against. */
  get errors() {
    return window.__HARNESS_ERRORS__ ?? [];
  }

  stats() {
    const s = this.game.engine.stats;
    return {
      fps: s.fps,
      frameMs: Math.round(s.frameMs * 100) / 100,
      drawCalls: s.drawCalls,
      triangles: s.triangles,
      world: this.game.worldManager.active?.id ?? null,
      npcs: this.game.npcManager?.npcs?.length ?? 0,
      portals: this.game.portals?.portals?.length ?? 0,
    };
  }

  /** Streaming diagnostics for the maze. Dev-only. */
  mazeStats() {
    const w = this.game.worldManager.active;
    if (w?.id !== 'maze') return { world: w?.id ?? null, note: 'not in the maze' };
    return {
      seed: w.seed,
      residentDistricts: w.chunks?.residentKeys().length ?? 0,
      colliders: this.game.physics.colliders.length,
      programs: this.game.engine.renderer.info.programs.length,
      drawCalls: this.game.engine.renderer.info.render.calls,
    };
  }
}

function frame() {
  return new Promise((r) => requestAnimationFrame(() => r()));
}

export function installHarness(game) {
  // Capture errors from the moment the harness loads so reviews can flag them.
  window.__HARNESS_ERRORS__ = window.__HARNESS_ERRORS__ ?? [];
  window.addEventListener('error', (e) => {
    window.__HARNESS_ERRORS__.push(String(e.message ?? e));
  });
  window.addEventListener('unhandledrejection', (e) => {
    window.__HARNESS_ERRORS__.push(`unhandled rejection: ${e.reason?.message ?? e.reason}`);
  });
  const origError = console.error.bind(console);
  console.error = (...args) => {
    window.__HARNESS_ERRORS__.push(args.map((a) => (a?.stack ?? String(a))).join(' '));
    origError(...args);
  };

  const harness = new Harness(game);
  window.HARNESS = harness;
  console.info('[harness] installed - window.HARNESS ready');
  return harness;
}

export { VIEWS };
