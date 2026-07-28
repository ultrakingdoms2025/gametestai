import * as THREE from 'three';
import { CONFIG, applyUrlOverrides } from './core/Config.js';
import { bus } from './core/EventBus.js';
import { Engine } from './core/Engine.js';
import { Input } from './core/Input.js';
import { Physics } from './physics/Physics.js';
import { MaterialLibrary } from './gfx/Materials.js';
import { createPostFX } from './gfx/PostFX.js';
import { WorldManager } from './worlds/WorldManager.js';
import { StationWorld } from './worlds/StationWorld.js';
import { MedievalWorld } from './worlds/MedievalWorld.js';
import { SportsWorld } from './worlds/SportsWorld.js';
import { CitadelWorld } from './worlds/CitadelWorld.js';
import { Player } from './player/Player.js';
import { NPCManager } from './npc/NPCManager.js';
import { PortalSystem } from './systems/Portals.js';
import { CombatSystem } from './systems/Combat.js';
import { HUD } from './ui/HUD.js';
import { CameraRig } from './player/CameraRig.js';
import { PlayerAvatar } from './player/PlayerAvatar.js';
import { Loadout } from './player/Loadout.js';
import { ProjectileSystem } from './systems/Projectiles.js';
import { Economy } from './systems/Economy.js';
import { SaveGame } from './systems/SaveGame.js';
import { UnstuckSystem } from './systems/Unstuck.js';
import { MountManager } from './mounts/MountManager.js';
import { WaterVolumes } from './systems/WaterVolumes.js';
import { Stamina } from './systems/Stamina.js';
import { Inventory } from './systems/Inventory.js';
import { Loot } from './systems/Loot.js';
import { Marketplace } from './systems/Marketplace.js';
import { HelpMenu } from './ui/HelpMenu.js';
import { CharacterMenu } from './ui/CharacterMenu.js';
import { LightRig } from './gfx/LightRig.js';
import { Caches } from './systems/Caches.js';
import { Contracts } from './systems/Contracts.js';
import { AdminCheats } from './systems/AdminCheats.js';
import { Relics } from './systems/Relics.js';
import { AudioDirector } from './audio/AudioDirector.js';
import { AudioMenu } from './ui/AudioMenu.js';

/**
 * AETHER NEXUS - bootstrap.
 *
 * This file is the single integration point: it constructs every subsystem,
 * wires them through the event bus, and owns the boot sequence. Subsystems
 * never import each other's concrete classes - they talk through `bus` and the
 * context objects handed to them here.
 */

const overrides = applyUrlOverrides();

const canvas = document.getElementById('viewport');
const uiRoot = document.getElementById('ui-root');

const engine = new Engine(canvas, bus);
const input = new Input(canvas, bus);
const physics = new Physics(bus);
const materials = new MaterialLibrary(engine.renderer);

engine.postfx = createPostFX(engine);

/* ------------------------------------------------------------------ */
/* Lighting                                                            */
/*                                                                     */
/* Built before any subsystem so that the shader program cache key is   */
/* settled before the first material is ever seen. See gfx/LightRig.js: */
/* the counts below are compiled into every shader in the game, and any */
/* light created anywhere else is demoted to a *source* that feeds them.*/
/* ------------------------------------------------------------------ */

/** Ambient + sun rig is owned here so worlds only declare intent, not objects. */
const ambient = new THREE.AmbientLight(0xffffff, 0.6);
const hemi = new THREE.HemisphereLight(0xffffff, 0x404040, 0.5);
const sun = new THREE.DirectionalLight(0xffffff, 2);
sun.name = 'sun';
sun.castShadow = true;
sun.shadow.mapSize.set(CONFIG.render.shadowMapSize, CONFIG.render.shadowMapSize);
sun.shadow.camera.near = 0.5;
sun.shadow.camera.far = 400;
sun.shadow.bias = -0.0004;
sun.shadow.normalBias = 0.035;
const sunTarget = new THREE.Object3D();
engine.scene.add(ambient, hemi, sun, sunTarget, sun.target);
sun.target = sunTarget;

// The sun becomes shadow slot 0 and stays under this file's control; every
// other light in the game is pooled into the rig's fixed slots.
const lightRig = new LightRig({ scene: engine.scene, camera: engine.camera, sun });

const ctx = { scene: engine.scene, engine, physics, bus, materials, input, lightRig };

const worldManager = new WorldManager(ctx);
worldManager.register(StationWorld);
worldManager.register(MedievalWorld);
worldManager.register(SportsWorld);
worldManager.register(CitadelWorld);

const player = new Player({ ...ctx, camera: engine.camera });
const npcManager = new NPCManager({ ...ctx, player });
const portals = new PortalSystem({ ...ctx, player, worldManager });
const combat = new CombatSystem({ ...ctx, player, npcManager });

/* ------------------------------------------------------------------ */
/* Feature set v2 - see CONTRACTS-V2.md                                */
/* ------------------------------------------------------------------ */

// Camera modes and the visible third-person body. The rig is attached back onto
// the player because Player asks it for the aim correction on every shot: in
// third person the muzzle is offset from the camera, so firing along the camera
// forward vector would miss whatever the crosshair is on.
const cameraRig = new CameraRig({ engine, camera: engine.camera, player, input, bus, physics, npcManager });
const avatar = new PlayerAvatar({ ...ctx, player });
player.cameraRig = cameraRig;
player.avatar = avatar;

const economy = new Economy({ bus });
const projectiles = new ProjectileSystem({ ...ctx, player, npcManager, combat });

// Loadout adopts the machine gun Player already built rather than making a
// second one, and from here on owns the viewmodel and the fire input.
const loadout = new Loadout({ ...ctx, camera: engine.camera, player, npcManager, projectiles, cameraRig });
player.loadout = loadout;

const mounts = new MountManager({ ...ctx, player, camera: engine.camera, cameraRig, avatar, npcManager });
const unstuck = new UnstuckSystem({ bus, player, physics, worldManager, input });

/* ------------------------------------------------------------------ */
/* Feature set v3 - see CONTRACTS-V3.md                                */
/* ------------------------------------------------------------------ */

// Water has no authored data: this scans each world for water surfaces and
// publishes the derived volumes on the bus, which Player.swim listens for.
// It subscribes to world:changed itself, so it only needs constructing.
const waterVolumes = new WaterVolumes({ bus });

// Stamina attaches itself to the player, and Player.fixedUpdate drives it -
// deliberately NOT ticked from here, or it would drain at double rate.
const stamina = new Stamina({ bus, player });

const inventory = new Inventory({ bus, economy, input, root: uiRoot });
const loot = new Loot({ ...ctx, player, inventory, economy, npcManager });
const market = new Marketplace({ bus, economy, inventory, player, npcManager, input, root: uiRoot });
const helpMenu = new HelpMenu({ root: uiRoot, bus, input });
// F2. Edits the avatar live and publishes `character:changed`, which SaveGame
// snapshots and MountManager listens for so the rider on a mount is the same
// person as the one on foot.
const characterMenu = new CharacterMenu({ root: uiRoot, bus, input, avatar, player });

// Ammunition now comes out of the bag rather than a private per-weapon counter.
loadout.setInventory?.(inventory);

// Reasons to dive, to fly and to come back. Caches place themselves by terrain
// query on every world change and hand the reward to Loot, so there is no
// authored data and nothing to keep in sync when a world regenerates.
const caches = new Caches({ bus, physics, player, loot, worldManager, waterVolumes });

// Hidden collectibles that pay on pickup - the reason to look at the skyline.
const relics = new Relics({ scene: engine.scene, bus, physics, player, economy, worldManager });

// Standing jobs from the people who already have names and personalities.
const contracts = new Contracts({ bus, npcManager, player, economy, inventory, worldManager });

// Typed cheat codes: "ammo" resupplies every weapon, "heal", "rich".
const cheats = new AdminCheats({ bus, input, loadout, player, economy });

// All sound is synthesised at runtime - see audio/AudioDirector.js for why
// there is not a single audio file in this project.
const audio = new AudioDirector({ bus, camera: engine.camera, player, worldManager, input });
const audioMenu = new AudioMenu({ root: uiRoot, bus, input, audio });

const save = new SaveGame({ bus, player, worldManager, economy, loadout, mounts, input, inventory });

const hud = new HUD({ ...ctx, root: uiRoot, player, worldManager, npcManager, portals, caches, contracts });

// Late injection breaks what would otherwise be a circular import between the
// world manager and the systems it has to drive on every world change.
worldManager.attach?.({ npcManager, portals, player });

// Parkour reads `world.haystacks` to know a fall is survivable, and the world
// manager is built after the player, so it is handed over here.
player.parkour.worldManager = worldManager;

// Expose for the automated screenshot/critique harness and for debugging.
window.GAME = {
  engine, input, physics, materials, worldManager, player, npcManager, portals, combat, hud, bus, THREE, CONFIG,
  cameraRig, avatar, loadout, projectiles, economy, mounts, unstuck, save, lightRig,
  waterVolumes, stamina, inventory, loot, market, helpMenu, characterMenu, caches, contracts,
  cheats, audio, audioMenu, relics,
};

if (overrides.dev) {
  import('./dev/Harness.js').then(({ installHarness }) => installHarness(window.GAME));
}

/* ------------------------------------------------------------------ */
/* Boot sequence                                                       */
/* ------------------------------------------------------------------ */

const loader = createLoadingScreen(uiRoot);

async function boot() {
  try {
    loader.setStatus('Baking surfaces', 0.04);
    await materials.warmup((p, label) =>
      loader.setStatus(label ?? 'Baking surfaces', 0.04 + p * 0.26)
    );

    const startWorld = overrides.startWorld || 'station';
    loader.setStatus('Generating worlds', 0.3);

    // Build the entry world first so the player can move immediately, then
    // stream the other two in the background - portals stay locked until ready.
    await worldManager.build(startWorld, (p, label) =>
      loader.setStatus(label ?? 'Generating world', 0.3 + p * 0.5)
    );

    loader.setStatus('Spawning inhabitants', 0.85);
    await worldManager.activate(startWorld);

    loader.setStatus('Calibrating optics', 0.95);
    await nextFrame();

    /* --- The title card goes up *before* the shader warm, not after ------
     *
     * Shader compilation is by a long way the most expensive thing in the
     * boot - 118 s of a 127 s cold start, measured - and none of it is needed
     * to draw a title card. Putting the card up first turns "four minutes of
     * a progress bar stuck at 92%" into "the menu appears, and finishes
     * preparing while you read it".
     *
     * `compileAsync` resolves through KHR_parallel_shader_compile, so the
     * driver links on its own threads and the card stays live throughout.
     * Entering is gated on the warm finishing - `showStartPrompt` queues an
     * early click rather than dropping the player into a world that is still
     * compiling.
     */
    loader.setStatus('Ready', 1);
    loader.showStartPrompt(worldManager.active.displayName);
    const tMenu = performance.now();
    console.info(`[boot] title card up at ${Math.round(tMenu)}ms`);

    await prewarm();

    engine.start();
    loader.warmComplete();
    console.info(
      `[boot] playable at ${Math.round(performance.now())}ms ` +
      `(${Math.round(performance.now() - tMenu)}ms of that behind the menu)`
    );

    // Remaining worlds build during idle time after the first frame is up.
    scheduleBackgroundBuilds(startWorld);
  } catch (err) {
    console.error('[boot] failed:', err);
    loader.showError(err);
  }
}

/**
 * Pay every first-use shader cost behind the loading screen.
 *
 * ── Why this is now one call ──────────────────────────────────────────────
 * This used to play the game through every configuration - select each weapon,
 * summon and dismount each mount, render frames in each state - because the
 * light *count* changed as it went. Three pushes `numDirLights`,
 * `numPointLights` and `numSpotLights` into its program cache key, so each
 * distinct count needs its own copy of every program in the scene, and the
 * only way to pre-build them was to reproduce each count for real. That warmup
 * cost 250 s on a cold PC boot, and it still did not help after a portal.
 *
 * Every light in the game is now pooled into the fixed slot set in
 * gfx/LightRig.js, so the counts in the cache key are constant for the whole
 * session - across weapons, mounts, effects *and worlds*. One count means one
 * program set, so a single `compileAsync` covers every configuration the player
 * can reach anywhere, and the same programs survive a portal.
 *
 * The slot budget is also what makes this affordable at all. Compile time
 * scales with the light count, because Three unrolls the per-light loop into
 * every fragment shader: measured on this scene, 42 point lights cost 59.8 s
 * where 12 cost 19.4 s. The station used to run 65.
 *
 * Two details make the single pass sufficient:
 *   - `renderer.compile()` collects *materials* with `scene.traverse`, not
 *     `traverseVisible`, so hidden objects still compile. The viewmodels and
 *     the avatar only have to be parented, not shown.
 *   - It collects *lights* with `traverseVisible`, so the set it compiles for
 *     is exactly the set the next real frame will use - which is only true
 *     because that set no longer changes.
 *
 * Mounts are the one thing that must be built here rather than lazily: they do
 * not enter the scene until `spawn()`, and their materials (and the dragon's
 * ~235 ms of geometry) would otherwise land on the first `G`/`H`/`J` press.
 *
 * `compileAsync` resolves through KHR_parallel_shader_compile where the driver
 * offers it, so this does not block the main thread the way a synchronous
 * compile would. A failure here is never fatal: the cost simply reverts to
 * being paid on first use.
 */
async function prewarm() {
  const t0 = performance.now();
  loader.setWarming('Preparing shaders');
  let parked = [];
  try {
    parked = mounts.prebuild?.(['hoverboard', 'dragon', 'car']) ?? [];
  } catch (err) {
    console.warn('[prewarm] mount prebuild failed:', err);
  }

  // Shown, not merely parented. `compile` finds materials through
  // `scene.traverse` and does not care about visibility, but it only prepares
  // each material's *beauty* program - the shadow pass draws through
  // `_depthMaterial`/`_distanceMaterial`, which `compile` never sees, and
  // `projectObject` skips hidden objects, so a mount that is only parented
  // never reaches the shadow map and pays for its depth program on the first
  // real summon. Two visible frames behind the loading screen buys those, plus
  // the PostFX chain, which is not part of `engine.scene` at all.
  try {
    for (const root of parked) {
      // Parked roots sit at the origin, which is almost never inside the
      // camera or the sun's shadow frustum - and a frustum-culled object is
      // dropped by `projectObject` before it can compile anything. Stand them
      // on the player so both passes actually reach them.
      root.position.copy(player.position);
      root.visible = true;
    }
    avatar?.setVisible?.(true);
  } catch { /* non-fatal */ }

  try {
    await engine.renderer.compileAsync(engine.scene, engine.camera);
  } catch (err) {
    console.warn('[prewarm] compileAsync failed, falling back to lazy compile:', err);
  }

  // Two frames, not the twenty-odd the old configuration walk needed: one
  // light count means one program set, so there is nothing left to vary.
  for (let i = 0; i < 2; i++) {
    try {
      if (engine.postfx) engine.postfx.render(1 / 60);
      else engine.renderer.render(engine.scene, engine.camera);
    } catch { /* a warmup frame must never abort the boot */ }
    await nextFrame();
  }

  // A viewmodel only reaches the renderer while its weapon is selected, so the
  // handful of programs unique to each one still compiled on first draw -
  // measured at 4.8 s for the bow and 3.4 s for the sword, because this driver
  // links at roughly a second per program. Selecting each one for a frame is
  // cheap now that the light count is fixed: it costs those few programs and
  // nothing else, where the old walk had to rebuild the entire scene's program
  // set for every configuration.
  const selected = loadout.current?.id ?? null;
  try {
    for (const inst of loadout.instances ?? []) {
      loadout.select(inst.id);
      inst.setVisible?.(true);
      if (engine.postfx) engine.postfx.render(1 / 60);
      else engine.renderer.render(engine.scene, engine.camera);
      await nextFrame();
    }
  } catch (err) {
    console.warn('[prewarm] viewmodel warm failed:', err);
  } finally {
    if (selected) loadout.select(selected);
  }

  try {
    for (const root of parked) root.visible = false;
    avatar?.setVisible?.(false);
    mounts.unpark?.(parked);
  } catch (err) {
    console.warn('[prewarm] restore failed:', err);
  }

  console.info(
    `[prewarm] shader warmup took ${Math.round(performance.now() - t0)}ms, ` +
    `${engine.renderer.info.programs.length} programs`
  );
}

function scheduleBackgroundBuilds(startWorld) {
  const rest = worldManager.ids.filter((id) => id !== startWorld);
  // The `timeout` is not optional in practice. A 126 fps render loop leaves so
  // little idle time that a plain `requestIdleCallback` was never firing at
  // all: measured, the other two worlds were still unbuilt 45 s after boot, so
  // every portal paid for generating its destination *and* compiling it on the
  // spot. With a deadline Chrome runs the callback regardless of idleness.
  const idle = window.requestIdleCallback
    ? (fn) => window.requestIdleCallback(fn, { timeout: 1500 })
    : (fn) => setTimeout(() => fn({ timeRemaining: () => 8 }), 200);
  let i = 0;
  const step = () => {
    if (i >= rest.length) {
      bus.emit('worlds:all-ready');
      return;
    }
    const id = rest[i++];
    worldManager
      .build(id)
      .then(() => warmWorld(id))
      .then(() => {
        bus.emit('world:ready', { id });
        idle(step);
      })
      .catch((err) => {
        console.error(`[boot] background build of "${id}" failed:`, err);
        idle(step);
      });
  };
  idle(step);
}

/**
 * Compile a world's materials before the player ever portals into it.
 *
 * This is only possible - and only worth doing - because the light rig fixed
 * the program cache key. Previously each world carried its own lights, so the
 * key changed on arrival and anything compiled in advance was thrown away
 * unused; the portal then rebuilt the entire program set in one blocking frame,
 * measured at 83 s going from the station to the medieval world.
 *
 * `compileAsync(group, camera, scene)` is the three-argument form: it collects
 * materials from `group` but resolves lights and shadows against the live
 * `scene`, so the programs it builds are keyed exactly as the ones the world
 * will ask for on arrival - without the group ever entering the scene graph or
 * rendering a frame.
 *
 * @param {string} id
 */
async function warmWorld(id) {
  const world = worldManager.getWorld(id);
  if (!world?.group) return;
  // Demote its lights first. A world arrives with dozens of its own, and
  // compile() collects lights with `traverseVisible` - one live light here and
  // every program it built would be keyed to counts that never occur.
  lightRig.claim(world.group);
  const t0 = performance.now();
  try {
    await engine.renderer.compileAsync(world.group, engine.camera, engine.scene);
    console.info(
      `[warm] "${id}" precompiled in ${Math.round(performance.now() - t0)}ms ` +
      `(${engine.renderer.info.programs.length} programs total)`
    );
  } catch (err) {
    // Never fatal: the cost simply reverts to being paid on arrival.
    console.warn(`[warm] precompile of "${id}" failed:`, err);
  }
}

/* ------------------------------------------------------------------ */
/* Frame wiring                                                        */
/* ------------------------------------------------------------------ */

// Mounts run first: while ridden they own the player's position, so they must
// have written it before the player integrates its own movement and before
// anything downstream reads where the player is.
engine.onFixedUpdate((dt, elapsed) => {
  mounts.fixedUpdate(dt, elapsed);
  player.fixedUpdate(dt, elapsed);
  npcManager.fixedUpdate(dt, elapsed);
  combat.fixedUpdate(dt, elapsed);
  projectiles.fixedUpdate(dt, elapsed);
  loot.fixedUpdate(dt, elapsed);
  unstuck.fixedUpdate(dt, elapsed);
  portals.fixedUpdate(dt, elapsed);
});

engine.onFrameUpdate((dt, elapsed) => {
  materials.update?.(dt, elapsed);
  player.update(dt, elapsed);
  // The rig reads the player's final position, and the avatar and mounts then
  // pose against the camera the rig just placed.
  cameraRig.update(dt, elapsed);
  avatar.update(dt, elapsed);
  mounts.update(dt, elapsed);
  npcManager.update(dt, elapsed);
  projectiles.update(dt, elapsed);
  loadout.update(dt, elapsed);
  portals.update(dt, elapsed);
  combat.update(dt, elapsed);
  worldManager.active?.update(dt, elapsed);
  inventory.update(dt);
  market.update(dt);
  caches.update(dt);
  contracts.update(dt);
  relics.update(dt);
  // After the camera rig has placed the camera: the listener frame is read
  // straight off its world matrix, and a frame-old matrix pans every sound
  // to where the player was looking last frame.
  audio.update(dt);
  helpMenu.update?.(dt);
  characterMenu.update?.(dt);
  hud.update(dt, elapsed);
  // Last, and deliberately so: every light in the game has now been moved and
  // dimmed for this frame, so the rig is ranking final positions. It also
  // re-hides any light that appeared since the previous frame, which is what
  // keeps the shader program cache key constant. See gfx/LightRig.js.
  lightRig.update(dt);
  input.endFrame();
});

/* ------------------------------------------------------------------ */
/* Global interactions                                                 */
/* ------------------------------------------------------------------ */

bus.on('input:lockchange', ({ locked }) => {
  // Pausing on unlock keeps the world from simulating while a menu is open,
  // except when the chat box deliberately released the pointer.
  if (!locked && !hud.chatOpen) hud.showPauseOverlay(true);
  else hud.showPauseOverlay(false);
});

bus.on('world:changed', ({ world }) => {
  // Before anything else: a world arrives carrying dozens of its own lights,
  // and if a single frame renders with them live the whole program cache is
  // keyed to the wrong counts and every material in view recompiles. The
  // per-frame scan would catch them, but only after that frame.
  lightRig.claim(world.group);
  applyEnvironment(world.environment);
  engine.postfx?.setWorldGrade(world.environment);
});

window.addEventListener('keydown', (e) => {
  if (e.code === 'F3') {
    e.preventDefault();
    CONFIG.debug.showStats = !CONFIG.debug.showStats;
    hud.setDebugVisible(CONFIG.debug.showStats);
  }
});

function applyEnvironment(env) {
  const scene = engine.scene;
  scene.background = env.background ?? null;
  if (env.fogFar > 0) {
    scene.fog = scene.fog instanceof THREE.Fog ? scene.fog : new THREE.Fog(0, 1, 100);
    scene.fog.color.copy(env.fogColor);
    scene.fog.near = env.fogNear;
    scene.fog.far = env.fogFar;
  } else {
    scene.fog = null;
  }
  ambient.color.copy(env.ambientColor);
  ambient.intensity = env.ambientIntensity;
  hemi.color.copy(env.skyColor ?? env.ambientColor);
  hemi.groundColor.copy(env.groundColor ?? env.fogColor);
  hemi.intensity = env.hemiIntensity ?? 0.4;
  sun.color.copy(env.sunColor);
  sun.intensity = env.sunIntensity;
  engine.renderer.toneMappingExposure = env.exposure ?? 1;
  scene.environmentIntensity = env.envMapIntensity ?? 1;
  if (env.envMap !== undefined) scene.environment = env.envMap;
}

/** Keep the shadow frustum tight around the player for crisp contact shadows. */
engine.onFrameUpdate(() => {
  const env = worldManager.active?.environment;
  if (!env) return;
  const p = player.position;
  const d = env.sunDirection;
  const dist = 90;
  sun.position.set(p.x + d.x * dist, p.y + d.y * dist, p.z + d.z * dist);
  sunTarget.position.copy(p);
  const cam = sun.shadow.camera;
  const half = CONFIG.render.shadowDistance * 0.5;
  if (cam.left !== -half) {
    cam.left = -half;
    cam.right = half;
    cam.top = half;
    cam.bottom = -half;
    cam.updateProjectionMatrix();
  }
});

/* ------------------------------------------------------------------ */
/* Loading screen                                                      */
/* ------------------------------------------------------------------ */

function createLoadingScreen(root) {
  const el = document.createElement('div');
  el.className = 'boot-screen';
  el.innerHTML = `
    <div class="boot-inner">
      <div class="boot-logo">AETHER<span>NEXUS</span></div>
      <div class="boot-tagline">Three worlds. One gateway.</div>
      <div class="boot-bar"><div class="boot-bar-fill"></div></div>
      <div class="boot-status">Initialising</div>
      <div class="boot-start" hidden>
        <div class="boot-start-title">CLICK TO ENTER</div>
        <div class="boot-controls">
          <span><b>WASD</b> Move</span><span><b>Shift</b> Sprint</span><span><b>Space</b> Jump</span>
          <span><b>LMB</b> Fire</span><span><b>RMB</b> Aim</span><span><b>R</b> Reload</span>
          <span><b>E</b> Talk / Enter portal</span><span><b>T</b> Chat</span><span><b>F4</b> Audio</span><span><b>Esc</b> Release cursor</span>
        </div>
      </div>
      <div class="boot-error" hidden></div>
    </div>`;
  root.appendChild(el);

  const fill = el.querySelector('.boot-bar-fill');
  const status = el.querySelector('.boot-status');
  const start = el.querySelector('.boot-start');
  const title = el.querySelector('.boot-start-title');
  const errorEl = el.querySelector('.boot-error');

  /* The card is shown while the shader warm is still running, so a click has to
   * be able to arrive before the game is in a state to be entered. Rather than
   * disable the card - which reads as a hang - an early click is remembered and
   * honoured the moment the warm finishes. */
  let warm = false;
  let queued = false;
  let entered = false;

  const enter = () => {
    if (entered) return;
    entered = true;
    el.classList.add('boot-hide');
    setTimeout(() => el.remove(), 900);
    input.requestLock();
    bus.emit('game:started');
  };

  const tryEnter = () => {
    if (warm) enter();
    else {
      queued = true;
      title.textContent = 'PREPARING…';
    }
  };

  return {
    setStatus(text, progress) {
      status.textContent = text;
      fill.style.width = `${Math.round(progress * 100)}%`;
    },
    /** Sub-line shown on the title card while shaders finish compiling. */
    setWarming(text) {
      status.textContent = text;
    },
    /** Shaders are done: unlock entry, and honour a click that already landed. */
    warmComplete() {
      warm = true;
      title.textContent = 'CLICK TO ENTER';
      if (queued) enter();
    },
    showStartPrompt(worldName) {
      status.textContent = `Entering ${worldName}`;
      start.hidden = false;
      el.addEventListener('click', tryEnter);
      if (overrides.autoStart) setTimeout(tryEnter, 120);
    },
    showError(err) {
      errorEl.hidden = false;
      errorEl.textContent = `Boot failed: ${err?.message ?? err}`;
      status.textContent = 'Error';
    },
  };
}

function nextFrame() {
  return new Promise((r) => requestAnimationFrame(() => r()));
}

boot();
