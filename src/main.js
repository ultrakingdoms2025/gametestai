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
import { Player } from './player/Player.js';
import { NPCManager } from './npc/NPCManager.js';
import { PortalSystem } from './systems/Portals.js';
import { CombatSystem } from './systems/Combat.js';
import { HUD } from './ui/HUD.js';

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

const ctx = { scene: engine.scene, engine, physics, bus, materials, input };

const worldManager = new WorldManager(ctx);
worldManager.register(StationWorld);
worldManager.register(MedievalWorld);
worldManager.register(SportsWorld);

const player = new Player({ ...ctx, camera: engine.camera });
const npcManager = new NPCManager({ ...ctx, player });
const portals = new PortalSystem({ ...ctx, player, worldManager });
const combat = new CombatSystem({ ...ctx, player, npcManager });
const hud = new HUD({ ...ctx, root: uiRoot, player, worldManager, npcManager, portals });

// Late injection breaks what would otherwise be a circular import between the
// world manager and the systems it has to drive on every world change.
worldManager.attach?.({ npcManager, portals, player });

// Expose for the automated screenshot/critique harness and for debugging.
window.GAME = { engine, input, physics, materials, worldManager, player, npcManager, portals, combat, hud, bus, THREE, CONFIG };

if (overrides.dev) {
  import('./dev/Harness.js').then(({ installHarness }) => installHarness(window.GAME));
}

/* ------------------------------------------------------------------ */
/* Boot sequence                                                       */
/* ------------------------------------------------------------------ */

const loader = createLoadingScreen(uiRoot);

async function boot() {
  try {
    loader.setStatus('Compiling shaders', 0.05);
    await materials.warmup();

    const startWorld = overrides.startWorld || 'station';
    loader.setStatus('Generating worlds', 0.15);

    // Build the entry world first so the player can move immediately, then
    // stream the other two in the background - portals stay locked until ready.
    await worldManager.build(startWorld, (p, label) =>
      loader.setStatus(label ?? 'Generating world', 0.15 + p * 0.55)
    );

    loader.setStatus('Spawning inhabitants', 0.75);
    await worldManager.activate(startWorld);

    loader.setStatus('Calibrating optics', 0.9);
    await nextFrame();

    loader.setStatus('Ready', 1);
    loader.showStartPrompt(worldManager.active.displayName);

    engine.start();

    // Remaining worlds build during idle time after the first frame is up.
    scheduleBackgroundBuilds(startWorld);
  } catch (err) {
    console.error('[boot] failed:', err);
    loader.showError(err);
  }
}

function scheduleBackgroundBuilds(startWorld) {
  const rest = worldManager.ids.filter((id) => id !== startWorld);
  const idle = window.requestIdleCallback || ((fn) => setTimeout(() => fn({ timeRemaining: () => 8 }), 200));
  let i = 0;
  const step = () => {
    if (i >= rest.length) {
      bus.emit('worlds:all-ready');
      return;
    }
    const id = rest[i++];
    worldManager
      .build(id)
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

/* ------------------------------------------------------------------ */
/* Frame wiring                                                        */
/* ------------------------------------------------------------------ */

engine.onFixedUpdate((dt, elapsed) => {
  player.fixedUpdate(dt, elapsed);
  npcManager.fixedUpdate(dt, elapsed);
  combat.fixedUpdate(dt, elapsed);
  portals.fixedUpdate(dt, elapsed);
});

engine.onFrameUpdate((dt, elapsed) => {
  materials.update?.(dt, elapsed);
  player.update(dt, elapsed);
  npcManager.update(dt, elapsed);
  portals.update(dt, elapsed);
  combat.update(dt, elapsed);
  worldManager.active?.update(dt, elapsed);
  hud.update(dt, elapsed);
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

/** Ambient + sun rig is owned here so worlds only declare intent, not objects. */
const ambient = new THREE.AmbientLight(0xffffff, 0.6);
const hemi = new THREE.HemisphereLight(0xffffff, 0x404040, 0.5);
const sun = new THREE.DirectionalLight(0xffffff, 2);
sun.castShadow = true;
sun.shadow.mapSize.set(CONFIG.render.shadowMapSize, CONFIG.render.shadowMapSize);
sun.shadow.camera.near = 0.5;
sun.shadow.camera.far = 400;
sun.shadow.bias = -0.0004;
sun.shadow.normalBias = 0.035;
const sunTarget = new THREE.Object3D();
engine.scene.add(ambient, hemi, sun, sunTarget, sun.target);
sun.target = sunTarget;

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
          <span><b>E</b> Talk / Enter portal</span><span><b>T</b> Chat</span><span><b>Esc</b> Release cursor</span>
        </div>
      </div>
      <div class="boot-error" hidden></div>
    </div>`;
  root.appendChild(el);

  const fill = el.querySelector('.boot-bar-fill');
  const status = el.querySelector('.boot-status');
  const start = el.querySelector('.boot-start');
  const errorEl = el.querySelector('.boot-error');

  return {
    setStatus(text, progress) {
      status.textContent = text;
      fill.style.width = `${Math.round(progress * 100)}%`;
    },
    showStartPrompt(worldName) {
      status.textContent = `Entering ${worldName}`;
      start.hidden = false;
      const enter = () => {
        el.classList.add('boot-hide');
        setTimeout(() => el.remove(), 900);
        input.requestLock();
        bus.emit('game:started');
      };
      el.addEventListener('click', enter, { once: true });
      if (overrides.autoStart) setTimeout(enter, 120);
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
