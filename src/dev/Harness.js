/**
 * Automated screenshot and measurement harness.
 *
 * Loaded only when the page is opened with ?dev=1. It gives the visual-review
 * tooling deterministic control over which world is loaded, where the camera
 * sits, and whether the HUD is composited - so a critique compares art
 * direction rather than whatever the player happened to be looking at.
 *
 * Everything here is dev-only and is tree-shaken out of a normal boot.
 *
 * ------------------------------------------------------------------------
 * MEASURING PERFORMANCE THROUGH THIS FILE - read this before trusting a number
 * ------------------------------------------------------------------------
 * Three separate measurement runs were thrown away because the harness quietly
 * measured a game that was not running. The failures, and what now stops them:
 *
 *  1. An automated browser cannot hold a pointer lock, and losing it blocks the
 *     entire gameplay update - including all NPC and world LOD. `ready()` now
 *     turns on `setGameplayDriven` by default and `stats().gameplayDriven` says
 *     so out loud. If that flag is false, every LOD figure you are looking at
 *     is the LOD-disabled worst case.
 *  2. `stats().drawCalls` was a ~1 Hz sample, so an A/B read the previous
 *     value. It is the instantaneous `renderer.info` figure now; the sampled
 *     ones live under `stats().sampled`.
 *  3. The sun's shadow camera is aimed at the PLAYER, so a camera-only framing
 *     shadowed an empty slab. `view()`/`look()` move the player too by default.
 *  4. `freezeAll(true)` twice used to capture its own stub and destroy
 *     `npcManager.fixedUpdate` for the life of the page. It is idempotent now.
 *  5. A stalled frame loop (backgrounded window) leaves the sun stranded behind
 *     the player. `stats()` reports `documentHidden`, `enginePaused` and the
 *     rAF stall count; `holdAwake()` refuses pauses.
 *  6. `renderer.info` frame totals move 10-13% between loads. `worldTriangles()`
 *     is the deterministic counterpart - see src/dev/WorldTriangles.js.
 */

import { MAZE, DIR, cellIndex, districtCoords, isOpen, connectorAt } from '../worlds/maze/MazeTopology.js';
import { cellToWorld } from '../worlds/maze/MazeColliders.js';
import { shaftColliders, connectorHoleBounds } from '../worlds/maze/MazeShafts.js';
import { setMazeSurfaceMode, mazeSurfaceMode } from '../worlds/maze/MazeMaterials.js';
import { walkWorldTriangles } from './WorldTriangles.js';

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
  // on both axes; hedges 5 m tall. Levels are 9 m apart: level 0 at y=0, level 3 at y=27.
  //
  // The player spawns at a fixed entrance (district dx:10, dz:0, x=1260) and
  // residency only ever covers the districts within RESIDENCY_RADIUS (2, so
  // roughly +-240m) of wherever the player actually is - see MazeWorld.js. A
  // framing computed from anywhere else, or that moves only the camera and
  // not the player, shows geometry that was never streamed: an empty void
  // for shaft-up, bare sky for tower-top. Both views below are computed
  // dynamically per view() call, scanning ONLY the districts the maze world
  // has actually streamed in - see Harness._findResidentShaft.
  maze: [
    { name: 'forecourt', pos: [1260, 4, -16], look: [1260, 2, 20], fov: 75 },
    { name: 'corridor', pos: [1260, 1.7, 40], look: [1260, 1.7, 120], fov: 75 },
    /* keepPlayer: this one deliberately looks DOWN on level 0 from 60 m up.
     * Moving the player with the camera - which every other framing now does,
     * so the sun's shadow camera covers what is on screen - would put them at
     * level 6, and `MazeWorld` streams residency around the player: the maze
     * this view exists to show would unload out from under it. */
    { name: 'above-entrance', pos: [1260, 60, -40], look: [1260, 0, 200], fov: 70, keepPlayer: true },
    { name: 'shaft-up', computed: true },
    { name: 'lift-car', computed: true },
    { name: 'tower-top', computed: true },
  ],
};

class Harness {
  constructor(game) {
    this.game = game;
    this.savedFov = game.engine.camera.fov;
    this._detach = null;
    this.hudHidden = false;
    /** Null when nothing is stubbed. `freezeAll` reads this to stay idempotent. */
    this._stubs = null;
    this._awakeHeld = false;
    this._realSetPaused = null;
    /** {pos, yaw} the player is re-asserted to every step, or null. */
    this._pin = null;
    this._pinDetach = null;
  }

  /**
   * Resolve once the first world is active and a few frames have rendered.
   *
   * `drive` defaults TRUE, and that default is the whole point: without it the
   * pointer-lock loss that every automated session suffers leaves the gameplay
   * update block switched off, which silently disables all LOD. Measuring that
   * and calling it a frame cost is the exact mistake this harness exists to
   * stop. Pass `{ drive: false }` if you specifically want the frozen game.
   *
   * @param {{ timeoutMs?: number, drive?: boolean }|number} [opts] a number is
   *   read as `timeoutMs`, which is how this used to be called.
   */
  async ready(opts = {}) {
    const { timeoutMs = 120000, drive = true } = typeof opts === 'number' ? { timeoutMs: opts } : opts;
    const t0 = performance.now();
    while (!this.game.worldManager.active) {
      if (performance.now() - t0 > timeoutMs) throw new Error('harness: world never activated');
      await frame();
    }
    this.setGameplayDriven(drive);
    for (let i = 0; i < 3; i++) await frame();
    return this.game.worldManager.active.id;
  }

  /**
   * Run the game as if it were being played, without a pointer lock.
   *
   * THE FAILURE THIS FIXES. `main.js` blocks its whole gameplay update block -
   * `cameraRig/avatar/mounts/npcManager/projectiles/loadout/portals/combat`
   * update AND `worldManager.active.update()` - whenever the pointer lock is
   * lost, and an automated browser either never gets the lock or drops it the
   * instant the window is backgrounded. The game keeps rendering, so nothing
   * looks wrong; what stops is `NPCManager._updateLOD` (every NPC pinned at
   * `distance: 0, detail: true, rate: 1` at any range - measured with a
   * character 951 m away) and every world's per-frame LOD banding. Draw-call
   * and triangle figures taken in that state are the LOD-disabled worst case.
   *
   * This does not hand-call a subset of the updaters - that list would drift
   * out of date the first time someone added a system. It clears the one
   * 'standby' block that `main.js` puts up, so the real loop runs the real
   * code path. Reversible, and reported by `stats().gameplayDriven`.
   *
   * @param {boolean} [on]
   * @returns {boolean} the state now in force
   */
  setGameplayDriven(on = true) {
    const dev = this.game.__dev;
    if (!dev?.setGameplayDriven) {
      // Only possible against a main.js without the hook. Say so loudly rather
      // than let a caller believe gameplay is running.
      console.error(
        '[harness] GAME.__dev.setGameplayDriven is missing - gameplay CANNOT be driven, ' +
        'and every LOD-dependent number from this page is the LOD-disabled worst case.'
      );
      return false;
    }
    const state = dev.setGameplayDriven(on);
    console.info(
      `[harness] gameplayDriven = ${state}` +
      (state ? '' : ' - LOD is NOT running; stats() figures are the worst case')
    );
    return state;
  }

  /** @returns {boolean} is the real gameplay update block running? */
  get gameplayDriven() {
    return this.game.__dev?.isGameplayDriven?.() ?? false;
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
   * camera does not get overwritten on the next frame, and - unless the view
   * or the caller says otherwise - takes the player along. See `_vantage`.
   *
   * @param {string|number} name
   * @param {{ settle?: number, movePlayer?: boolean }|number} [opts] a number is
   *   read as `settle`, which is how this used to be called.
   */
  async view(name, opts = {}) {
    const worldId = this.game.worldManager.active?.id;
    const list = VIEWS[worldId] ?? [];
    const v = typeof name === 'number' ? list[name] : list.find((x) => x.name === name);
    if (!v) throw new Error(`harness: no view "${name}" in world "${worldId}"`);
    const o = typeof opts === 'number' ? { settle: opts } : opts;

    this.freezeCamera(true);

    // Handle dynamically computed views (e.g., shaft-up, tower-top). Awaited:
    // tower-top's computation teleports the player and waits for residency
    // and the canopy to follow before it can report where to look.
    let spec = v;
    if (v.computed) {
      const computed = await this._computeView(v.name, worldId);
      if (!computed) throw new Error(`harness: could not compute view "${name}"`);
      spec = computed;
    }

    /* `keepPlayer` is a property of the FRAMING, not of the caller: a view that
     * placed the player itself (tower-top) or that depends on the player being
     * somewhere else (above-entrance, for maze residency) must not have that
     * undone. An explicit `movePlayer` from the caller still wins. */
    const movePlayer = o.movePlayer ?? !spec.keepPlayer;
    const moved = await this._vantage(spec.pos, spec.look, spec.fov, {
      movePlayer,
      settle: o.settle ?? 6,
    });
    return { world: worldId, view: v.name, playerMoved: moved };
  }

  /**
   * Place the camera, and by default the player with it.
   *
   * WHY THE PLAYER MOVES TOO. There is exactly one live shadow-casting light
   * (`sun`, in main.js) and its shadow camera is fitted around the PLAYER, not
   * around the render camera - a 120 m box centred on wherever the player is
   * standing. Moving only the camera therefore renders the new vantage while
   * the shadow map covers an empty slab back at spawn: the characters in shot
   * cast nothing, and the shot's character-shadow cost measures as a couple of
   * draws instead of a few hundred. That is not a saving, it is a hole in the
   * measurement, and it produced a whole afternoon of confident wrong numbers.
   *
   * The player is PINNED here rather than merely teleported: with gameplay
   * driven (as it now is by default) an aerial vantage would otherwise have the
   * player fall out of it over the next second, dragging the shadow camera down
   * with them and quietly changing the answer mid-measurement.
   *
   * @returns {Promise<boolean>} whether the player was moved
   */
  async _vantage(pos, look, fov, { movePlayer = true, settle = 6 } = {}) {
    this.freezeCamera(true);
    const cam = this.game.engine.camera;

    if (movePlayer && this.game.player) {
      // Feet under the eye, so "the player is at this vantage" means the same
      // thing it means in play: their eyeline is the camera.
      const eye = this.game.CONFIG?.player?.eyeHeight ?? 1.62;
      const yaw = Math.atan2(-(look[0] - pos[0]), -(look[2] - pos[2]));
      this.pinPlayer([pos[0], pos[1] - eye, pos[2]], yaw);
    }

    cam.position.set(pos[0], pos[1], pos[2]);
    cam.lookAt(look[0], look[1], look[2]);
    cam.fov = fov;
    cam.updateProjectionMatrix();

    // Let temporal effects (AO, grain, adaptive resolution) settle before capture.
    for (let i = 0; i < settle; i++) await frame();
    // The pin re-asserts the player every step, but `teleport` inside it also
    // writes the camera on the frames before `_harnessFrozen` is honoured, so
    // the framing is restated after the settle rather than trusted to survive.
    cam.position.set(pos[0], pos[1], pos[2]);
    cam.lookAt(look[0], look[1], look[2]);
    return movePlayer && !!this.game.player;
  }

  /**
   * Hold the player at a fixed spot for the duration of a measurement.
   *
   * Re-asserted on the fixed step because gravity integrates there: a single
   * teleport to an aerial vantage lasts about a second before the player is
   * back on the ground and the sun's shadow camera has followed them down.
   *
   * @param {number[]|null} pos world position of the player's FEET, or null to release
   * @param {number} [yaw]
   */
  pinPlayer(pos, yaw = 0) {
    const player = this.game.player;
    if (!player) return null;
    if (!pos) {
      this._pinDetach?.();
      this._pinDetach = null;
      this._pin = null;
      if (this.game.avatar) this.game.avatar.harnessShadowOnly = false;
      return null;
    }
    this._pin = { pos: [...pos], yaw, v: new this.game.THREE.Vector3(pos[0], pos[1], pos[2]) };
    // The body is standing in the lens once the player is at the camera, and
    // the harness's camera detach normally forces it visible - see
    // PlayerAvatar's `harnessShadowOnly`. Keep its shadow, drop the mannequin.
    if (this.game.avatar) this.game.avatar.harnessShadowOnly = true;
    /* Reads `this._pin` rather than closing over the position: re-pinning to a
     * new vantage reuses the already-registered updaters, and a closure over
     * the FIRST position would quietly drag the player back to it. */
    const reassert = () => {
      const p = this._pin;
      // `anchor: false` so a measurement vantage never becomes the respawn point.
      if (p) player.teleport(p.v, p.yaw, { anchor: false });
    };
    reassert();
    if (!this._pinDetach) {
      const offFixed = this.game.engine.onFixedUpdate(reassert);
      const offFrame = this.game.engine.onFrameUpdate(reassert);
      this._pinDetach = () => { offFixed(); offFrame(); };
    }
    return { pos: this._pin.pos, yaw: this._pin.yaw };
  }

  /** Release a pinned player. */
  unpinPlayer() {
    return this.pinPlayer(null);
  }

  /**
   * Find a cell carrying DIR.UP inside a district the maze world has
   * actually streamed in - never the whole 400x400 grid.
   *
   * The previous version of this scan started from (0,0) and returned
   * whichever UP cell it met first, with no regard for whether anything was
   * ever built there. The player spawns at a fixed entrance (district
   * dx:10, dz:0, world x=1260) and `MazeWorld` only ever keeps districts
   * within `RESIDENCY_RADIUS` (2 districts, ~240m) of the player resident -
   * see MazeWorld.js. A shaft found by scanning from the origin is
   * overwhelmingly likely to sit in a district nobody streamed, so the
   * "shaft-up" view used to frame empty void: not an error, just wrong,
   * which is worse for a review instrument that is supposed to catch wrong
   * things. Scanning only `w.chunks.residentKeys()` instead guarantees
   * whatever this finds is actually built.
   *
   * @param {number|null} [level] restrict the search to one level, or search
   *   every resident district regardless of level.
   * @returns {{x:number, z:number, level:number}|null}
   */
  _findResidentShaft(level = null, kind = null) {
    const w = this.game.worldManager.active;
    if (w?.id !== 'maze' || !w.cells || !w.chunks) return null;

    const D = MAZE.DISTRICT;
    for (const key of w.chunks.residentKeys()) {
      const d = districtCoords(key);
      if (level !== null && d.level !== level) continue;
      const x0 = d.dx * D, z0 = d.dz * D;
      for (let lz = 0; lz < D; lz++) {
        for (let lx = 0; lx < D; lx++) {
          const x = x0 + lx, z = z0 + lz;
          const idx = cellIndex(x, z, d.level);
          if (!isOpen(w.cells, idx, DIR.UP)) continue;
          /* Phase 2c: optionally hold out for a particular connector. Which
           * shape a link becomes is the topology array's decision, and a
           * tunnel whose fold would sever a crossing falls back to a
           * staircase - so a caller after a REAL tunnel has to check what was
           * emitted, not just what was chosen. */
          if (kind) {
            const descs = shaftColliders(w.cells, x, z, d.level);
            const emitted = descs.some((k) => k.kind === 'tunnel') ? 'tunnel'
              : descs.some((k) => k.kind === 'lift') ? 'lift' : 'stair';
            if (emitted !== kind) continue;
          }
          return { x, z, level: d.level };
        }
      }
    }
    return null;
  }

  /**
   * Frame a real, resident LIFT - the car in its shaft, seen from the level-N
   * doorway it is entered through.
   *
   * Held to the same rule the shaft view had to learn: scan only resident
   * districts and check what was actually EMITTED, so this cannot frame a
   * lift that was never built or a district nobody streamed.
   *
   * @returns {{pos:number[], look:number[], fov:number}|null}
   */
  _findLiftFraming() {
    const lift = this._findResidentShaft(null, 'lift');
    if (!lift) return null;
    const world = this.game.worldManager.active;
    const w = cellToWorld(lift.x, lift.z, lift.level);
    const idx = cellIndex(lift.x, lift.z, lift.level);

    /* Stand in the corridor the shaft actually OPENS onto, derived from the
     * topology. Placing the camera at a fixed diagonal offset put it inside a
     * hedge - the same mistake 2b's ledger records the shaft view making, and
     * a review instrument that frames the wrong thing is worse than none.
     * A shaft always has at least one open side; that is how anyone gets in. */
    const sides = [
      { dir: DIR.N, dx: 0, dz: -1 }, { dir: DIR.E, dx: 1, dz: 0 },
      { dir: DIR.S, dx: 0, dz: 1 }, { dir: DIR.W, dx: -1, dz: 0 },
    ].filter((sd) => isOpen(world.cells, idx, sd.dir));
    if (sides.length === 0) return null;
    const s = sides[0];

    /* Just under a cell out, so the camera stands in the open corridor rather
     * than in the doorway itself, at eye height, looking at the car and the
     * landing above it. The well sits in the +x/+z quadrant of the cell. */
    const pos = [w.x + s.dx * MAZE.CELL * 0.9, w.y + 1.6, w.z + s.dz * MAZE.CELL * 0.9];
    const look = [w.x + 0.9, w.y + MAZE.LEVEL_HEIGHT * 0.35, w.z + 0.9];
    return { pos, look, fov: 75 };
  }

  /**
   * Find a resident staircase cell and compute the shaft-up camera framing.
   * Returns { pos, look, fov } or null if no resident shaft is found.
   */
  _findShaftFraming() {
    const shaft = this._findResidentShaft();
    if (!shaft) return null;

    // cellToWorld already returns the cell's own CENTRE (see its docstring) -
    // not a corner to be offset by another half-cell, which is what this used
    // to do by hand (`x * MAZE.CELL + MAZE.CELL / 2`) and which put every
    // computed view a half-cell off the shaft it meant to frame.
    const w = cellToWorld(shaft.x, shaft.z, shaft.level);

    // The OPENING's centre, not the cell's. `stairWellBounds` offsets the well
    // into the cell's +x/+z quadrant, so a camera on the cell centre looking
    // straight up frames the solid slab beside the hole - the very assumption
    // that had the daylight columns lighting stone until connectorHoleBounds
    // replaced it there, surviving here in the dev camera. Asked per KIND,
    // because a lift's well and a tunnel's exit sit elsewhere in the cell
    // again, and this helper serves all three.
    const world = this.game?.worldManager?.active;
    const hole = world?.cells
      ? connectorHoleBounds(world.cells, shaft.x, shaft.z, shaft.level)
      : null;
    const cx = hole?.cx ?? w.x;
    const cz = hole?.cz ?? w.z;

    // Camera low inside the shaft, looking up past the next level.
    const pos = [cx, w.y + 0.8, cz];
    const look = [cx, w.y + MAZE.LEVEL_HEIGHT * 2, cz];
    return { pos, look, fov: 75 };
  }

  /**
   * Find a resident shaft, teleport the player onto its landing at level
   * N+1, and frame the canopy from above it.
   *
   * `tower-top` used to move only the camera, to a fixed point nowhere near
   * where the player (and therefore residency and the canopy - both driven
   * off `player.position` in `MazeWorld.update`) actually were. The camera
   * looked out over whatever level the player last stood on, which streams
   * nothing at that height and reads as bare sky. Teleporting the player is
   * what makes residency and the canopy follow to the level this view is
   * meant to show - the same fix shape as `_findShaftFraming`, applied to
   * the half of the state a camera move alone cannot reach.
   *
   * @returns {Promise<{pos:number[], look:number[], fov:number}|null>}
   */
  async _computeTowerTop() {
    // Search from wherever the player currently is (a cold load's resident
    // set, centred on the fixed entrance) rather than the destination level -
    // nothing is resident up there yet to search.
    const shaft = this._findResidentShaft(0);
    if (!shaft) return null;

    const w = cellToWorld(shaft.x, shaft.z, shaft.level);
    const landingY = w.y + MAZE.LEVEL_HEIGHT;

    // NOT the cell's own centre. `MazeColliders.stairWellBounds` offsets the
    // stair well into the cell's +x/+z quadrant (`STAIR_WELL_OFFSET`), and
    // that quadrant reaches back across the cell centre - so a teleport
    // straight to (w.x, w.z) lands the player inside the hole itself, on top
    // of a guard rail rather than on solid floor (measured in-browser: a
    // teleport to the raw centre came to rest at HEDGE_HEIGHT above the floor
    // it should have landed on). The far corner - diagonally opposite the
    // well, the same "free corner" `scripts/tests/maze-enclosure.test.mjs`
    // routes a walking capsule through - is guaranteed floor.
    const cx = w.x - 1.6;
    const cz = w.z - 1.6;

    // Hand control back to the player controller just long enough to move
    // it - mirrors Harness.teleport() - then re-freeze once residency and
    // the canopy have had frames to update at the new position.
    this.unpinPlayer();
    this.freezeCamera(false);
    this.game.player.teleport(new this.game.THREE.Vector3(cx, landingY + 0.1, cz), 0);
    for (let i = 0; i < 8; i++) await frame();
    this.freezeCamera(true);

    // High above the landing, looking down and out across the canopy this
    // level's hedge-tops become once nothing streamed is under the camera.
    const pos = [cx, landingY + 30, cz];
    const look = [cx, landingY, cz];
    /* keepPlayer: this framing IS the player's position - it put them on the
     * landing so residency and the canopy would follow. Letting the generic
     * vantage move them 30 m up to the camera would undo the whole point. */
    return { pos, look, fov: 80, keepPlayer: true };
  }

  /**
   * Compute view parameters for dynamically generated views.
   */
  async _computeView(name, worldId) {
    if (worldId !== 'maze') return null;
    if (name === 'shaft-up') return this._findShaftFraming();
    if (name === 'lift-car') return this._findLiftFraming();
    if (name === 'tower-top') return this._computeTowerTop();
    return null;
  }

  /**
   * Free-fly to an arbitrary vantage. The player comes too, by default - see
   * `_vantage` for why measuring anything shadow-related without that is a
   * measurement of the wrong slab of world.
   *
   * @param {number[]} pos
   * @param {number[]} target
   * @param {number} [fov]
   * @param {{ settle?: number, movePlayer?: boolean }|number} [opts] a number is
   *   read as `settle`, which is how this used to be called.
   */
  async look(pos, target, fov = 70, opts = {}) {
    const o = typeof opts === 'number' ? { settle: opts } : opts;
    return this._vantage(pos, target, fov, {
      movePlayer: o.movePlayer ?? true,
      settle: o.settle ?? 6,
    });
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
    const mount = G.mounts?.active;

    /* IDEMPOTENT, and it has to be. The second `freezeAll(true)` used to
     * capture the noop the FIRST call had already installed, so the matching
     * `freezeAll(false)` "restored" that noop: `npcManager.fixedUpdate` was
     * dead for the life of the page, no error, no symptom beyond a world where
     * nobody moves. Two calls to freeze is exactly what a measurement script
     * does when a helper freezes and the caller freezes again to be sure. */
    if (on && this._stubs) return { paused: true, mount: mount?.id ?? null, alreadyFrozen: true };

    // Not `engine.setPaused`: `holdAwake` may have replaced that to refuse
    // pauses, and this pause is deliberate.
    (this._realSetPaused ?? G.engine.setPaused.bind(G.engine))(on);
    this.freezeCamera(on);
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
      this._stubs = null;
    }
    return { paused: on, mount: mount?.id ?? null, alreadyFrozen: false };
  }

  /**
   * Keep the engine running for the duration of a measurement.
   *
   * A stalled frame loop is invisible in the numbers and ruinous to them: the
   * frame updater that aims the sun at the player stops with everything else,
   * so the shadow camera is left stranded tens of metres behind and an
   * ablation that should have shown a shadow saving shows none at all.
   *
   * HONEST LIMIT: this refuses `setPaused(true)` and clears `_paused`, but it
   * cannot conjure animation frames. A backgrounded or fully occluded window
   * gets no `requestAnimationFrame` callbacks at all, and no flag here changes
   * that - `stats().documentHidden` and `stats().rafStalls` are how you find
   * out. Chrome's `--disable-features=CalculateNativeWinOcclusion` and a
   * foreground window are the actual fix.
   */
  holdAwake(on = true) {
    const engine = this.game.engine;
    if (on && !this._awakeHeld) {
      this._realSetPaused = engine.setPaused.bind(engine);
      engine.setPaused = (paused) => {
        if (paused) {
          console.warn('[harness] setPaused(true) refused - holdAwake() is in force');
          return;
        }
        this._realSetPaused(false);
      };
      this._realSetPaused(false);
      this._awakeHeld = true;
    } else if (!on && this._awakeHeld) {
      engine.setPaused = this._realSetPaused;
      this._realSetPaused = null;
      this._awakeHeld = false;
    }
    if (document.hidden) {
      console.warn('[harness] document.hidden is true: no animation frames are being delivered. Bring the window to the front before measuring.');
    }
    return { awakeHeld: this._awakeHeld, enginePaused: engine._paused, documentHidden: document.hidden };
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
    // A pin would drag them straight back; handing control back means all of it.
    this.unpinPlayer();
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

  /**
   * Everything a measurement needs to be trusted, including the reasons it
   * might not be.
   *
   * `drawCalls`/`triangles` are read straight from `renderer.info` and are the
   * figures for the frame that just rendered. They used to come from
   * `engine.stats`, which is resampled about once a second - so an A/B that
   * flipped a setting and read back immediately got the PREVIOUS value, and
   * produced tables that contradicted themselves. The sampled values are still
   * here, under `sampled`, because the smoothed frame time is what quality
   * decisions are actually made on.
   *
   * `gameplayDriven` is first because it invalidates everything below it when
   * false: no LOD is running, so the geometry figures are the worst case.
   */
  stats() {
    const G = this.game;
    const engine = G.engine;
    const s = engine.stats;
    const render = engine.renderer.info.render;
    const cam = engine.camera;
    const player = G.player;
    return {
      /* --- is this measurement even valid? ---------------------------- */
      gameplayDriven: this.gameplayDriven,
      gameplayBlocks: G.__dev?.gameplayBlocks?.() ?? null,
      enginePaused: engine._paused,
      awakeHeld: this._awakeHeld,
      documentHidden: typeof document !== 'undefined' ? document.hidden : null,
      rafStalls: window.__HARNESS_RAF_STALLS__ ?? 0,
      frozenAll: !!this._stubs,
      /* The sun's shadow camera is fitted around the PLAYER. Non-zero here
       * means the shadow map is covering somewhere other than what you can
       * see, and every shadow figure below is about that other place. */
      cameraToPlayer: player ? Math.round(cam.position.distanceTo(player.position) * 10) / 10 : null,
      playerPinned: this._pin ? [...this._pin.pos] : null,

      /* --- instantaneous: this frame, from renderer.info --------------- */
      drawCalls: render.calls,
      triangles: render.triangles,

      /* --- smoothed: engine.stats, resampled about once a second ------- */
      sampled: {
        fps: s.fps,
        frameMs: Math.round(s.frameMs * 100) / 100,
        frameMsMedian: Math.round(s.frameMsMedian * 100) / 100,
        drawCalls: s.drawCalls,
        triangles: s.triangles,
        programs: s.programs,
      },
      fps: s.fps,
      frameMs: Math.round(s.frameMs * 100) / 100,

      /* --- what the frame is actually made of -------------------------- */
      frameCost: this.frameCost(),

      world: G.worldManager.active?.id ?? null,
      npcs: G.npcManager?.npcs?.length ?? 0,
      portals: G.portals?.portals?.length ?? 0,
    };
  }

  /**
   * The passes a frame is actually paying for.
   *
   * Written down because it was materially misunderstood, twice. There is
   * exactly ONE live shadow-casting light - `sun`, owned by main.js. The rig's
   * second directional shadow slot (`rig:dirShadow:1`) exists to keep the
   * shader program cache key constant and has `shadow.autoUpdate = false`
   * (gfx/LightRig.js), so it renders nothing and costs zero draws; counting it
   * as a second shadow pass is where a phantom 3x multiplier came from. The
   * real second full-scene pass is GTAO's depth/normal prepass, measured here
   * at 1406 draws against a 3000-draw frame - 47% of it.
   */
  frameCost() {
    const engine = this.game.engine;
    const lights = [];
    engine.scene.traverse((o) => {
      if (!o.isLight || !o.castShadow) return;
      const auto = o.shadow?.autoUpdate !== false;
      lights.push({
        name: o.name || o.type,
        intensity: Math.round((o.intensity ?? 0) * 100) / 100,
        autoUpdate: auto,
        mapSize: o.shadow?.mapSize ? [o.shadow.mapSize.x, o.shadow.mapSize.y] : null,
        // The only ones that cost a shadow pass: lit, and allowed to refresh.
        live: auto && (o.intensity ?? 0) > 0,
      });
    });
    const passes = (engine.postfx?.composer?.passes ?? []).map((p) => ({
      name: p.constructor?.name ?? '(pass)',
      enabled: p.enabled !== false,
    }));
    return {
      shadowLights: lights,
      liveShadowLights: lights.filter((l) => l.live).length,
      postfxEnabled: engine.postfx?.enabled ?? false,
      passes,
    };
  }

  /**
   * Triangles in front of the camera, counted deterministically.
   *
   * Use this, not `stats().triangles`, whenever the question is "did this
   * change what is drawn". `renderer.info` sums every pass and moved 10-13%
   * between loads of an identical framing; this walk of the active world's
   * group reproduces exactly. See src/dev/WorldTriangles.js for the full note.
   *
   * @param {{ breakdown?: boolean, top?: number }} [opts]
   */
  worldTriangles(opts = {}) {
    const { breakdown = true, top = 12 } = opts;
    const world = this.game.worldManager.active;
    const r = walkWorldTriangles(world?.group, this.game.engine.camera, { breakdown });
    return {
      world: world?.id ?? null,
      ...r,
      byMaterial: r.byMaterial.slice(0, top),
      byName: r.byName.slice(0, top),
      /* Said out loud next to the number it contradicts. */
      note: 'deterministic; renderer.info.triangles is not - it includes the shadow and GTAO passes',
      rendererInfoTriangles: this.game.engine.renderer.info.render.triangles,
    };
  }

  /**
   * The Task 9 A/B: flip the maze's principal surfaces between the authored
   * KTX2 sets and the procedural bakes, live, without a reload. No argument
   * reports the current mode. Slot presence is identical in both modes, so
   * this can never cost a shader compile - see setMazeSurfaceMode.
   * @param {'authored'|'procedural'} [mode]
   */
  mazeSurfaces(mode) {
    return mode ? setMazeSurfaceMode(mode) : mazeSurfaceMode();
  }

  /** Streaming diagnostics for the maze. Dev-only. */
  mazeStats() {
    const w = this.game.worldManager.active;
    if (w?.id !== 'maze') return { world: w?.id ?? null, note: 'not in the maze' };

    // Collect distinct levels from both chunks and canopy resident sets.
    const levels = new Set();
    for (const key of w.chunks?.residentKeys() ?? []) {
      const { level } = districtCoords(key);
      levels.add(level);
    }
    for (const key of w.canopy?.residentKeys() ?? []) {
      const { level } = districtCoords(key);
      levels.add(level);
    }

    // Player's current level based on y-position.
    const playerPos = this.game.player?.position;
    let playerLevel = null;
    if (playerPos) {
      playerLevel = Math.min(MAZE.LEVELS - 1, Math.max(0, Math.round(playerPos.y / MAZE.LEVEL_HEIGHT)));
    }

    /* Phase 2c: what the three connectors are actually doing.
     *
     * `connectors` counts what the TOPOLOGY chose, `built` counts what
     * geometry was emitted - and they differ on purpose. A tunnel whose fold
     * would sever a crossing falls back to a staircase, so most tunnel links
     * build as stairs. Reporting only the topology figure would say 25%
     * tunnels and be misleading about what is in the world. */
    const connectors = { stair: 0, tunnel: 0, lift: 0 };
    const built = { stair: 0, tunnel: 0, lift: 0 };
    if (w.cells) {
      for (const key of w.chunks?.residentKeys() ?? []) {
        const { dx, dz, level } = districtCoords(key);
        if (level + 1 >= MAZE.LEVELS) continue;
        for (let lz = 0; lz < MAZE.DISTRICT; lz++) {
          for (let lx = 0; lx < MAZE.DISTRICT; lx++) {
            const cx = dx * MAZE.DISTRICT + lx, cz = dz * MAZE.DISTRICT + lz;
            if (!isOpen(w.cells, cellIndex(cx, cz, level), DIR.UP)) continue;
            const kind = connectorAt(w.cells, cx, cz, level);
            connectors[kind]++;
            const descs = shaftColliders(w.cells, cx, cz, level);
            if (descs.some((d) => d.kind === 'tunnel')) built.tunnel++;
            else if (descs.some((d) => d.kind === 'lift')) built.lift++;
            else built.stair++;
          }
        }
      }
    }

    return {
      seed: w.seed,
      residentDistricts: w.chunks?.residentKeys().length ?? 0,
      levels: levels.size,
      canopyDistricts: w.canopy?.residentKeys().length ?? 0,
      playerLevel,
      /* Vertical connectors in the RESIDENT set - `connectors` is what the
       * topology chose, `built` is what was emitted. See the note above. */
      connectors,
      built,
      liftsResident: w.chunks?.liftCount() ?? 0,
      gatesResident: w.chunks?.gateCount() ?? 0,
      colliders: this.game.physics.colliders.length,
      programs: this.game.engine.renderer.info.programs.length,
      drawCalls: this.game.engine.renderer.info.render.calls,
    };
  }
}

/**
 * One animation frame, with a watchdog.
 *
 * A backgrounded or occluded window delivers no `requestAnimationFrame`
 * callbacks at all, so every await in this file simply stops - and the symptom
 * an agent sees is a measurement script that hangs, or worse, one that resumed
 * later and read a frame from a world that had been frozen in between. Warn
 * rather than reject: a genuine 10 s frame is possible during shader warmup,
 * and failing the boot would be worse than saying so.
 */
function frame(timeoutMs = 10000) {
  return new Promise((resolve) => {
    const t = setTimeout(() => {
      window.__HARNESS_RAF_STALLS__ = (window.__HARNESS_RAF_STALLS__ ?? 0) + 1;
      console.warn(
        `[harness] no animation frame for ${timeoutMs}ms - the window is very likely ` +
        'backgrounded or occluded. Nothing is updating, including the sun\'s shadow camera.'
      );
    }, timeoutMs);
    requestAnimationFrame(() => {
      clearTimeout(t);
      resolve();
    });
  });
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

// `Harness` is exported for scripts/tests/harness-*.test.mjs, which drive the
// real class against stub games rather than re-deriving its logic.
export { VIEWS, Harness };
