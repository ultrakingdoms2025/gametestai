/**
 * Layout harness for `hud-viewport-probe.mjs`.
 *
 * ── What this is, and what it deliberately is not ─────────────────────────
 *
 * It is the REAL `HUD`, the REAL `WeaponWheel`, the REAL `PauseMenu`, the REAL
 * `ChatBox`, the REAL `HelpMenu` and the REAL `TouchControls`, built into a
 * real `#ui-root` in a real browser with `hud.css`, `pause-menu.css` and
 * `touch.css` loaded exactly as `index.html` loads them. Every box the probe
 * measures is laid out by Blink from the shipped stylesheets.
 *
 * It is NOT the game. No renderer, no world, no physics, no Rapier, no shader
 * warmup - none of which has anything to say about where a panel lands. Booting
 * the whole game to measure a stylesheet would trade forty seconds of WebGL for
 * nothing, and would make the gate flaky for reasons that are not layout.
 *
 * The stub systems below exist only so the real build methods run: the HUD
 * optional-chains every one of them (see its constructor docblock), so a stub
 * that answers nothing produces the same DOM a real one does.
 *
 * ── The viewport meta is copied, not authored ─────────────────────────────
 *
 * The `<head>` here has no viewport meta on purpose. `installViewportMeta()`
 * fetches `/index.html`, lifts the shipped `content` string out of it and
 * installs that. If the harness declared its own, the probe's assertion about
 * `viewport-fit=cover` would be measuring the harness rather than the game.
 */

import { EventBus } from '../../src/core/EventBus.js';
import { HUD } from '../../src/ui/HUD.js';
import { HelpMenu } from '../../src/ui/HelpMenu.js';
import { TouchControls } from '../../src/ui/TouchControls.js';
import { Charters } from '../../src/systems/Charters.js';
import { Onboarding } from '../../src/systems/Onboarding.js';

const root = document.getElementById('ui-root');
const bus = new EventBus();

/* ---------------------------------------------------------------------- */
/* The viewport meta, lifted out of the shipped index.html                  */
/* ---------------------------------------------------------------------- */

async function installViewportMeta() {
  const html = await (await fetch('../../index.html')).text();
  const m = html.match(/<meta\s+name=["']viewport["']\s+content=["']([^"']+)["']/i);
  const content = m ? m[1] : '';
  const meta = document.createElement('meta');
  meta.name = 'viewport';
  meta.content = content;
  document.head.appendChild(meta);
  return content;
}

/* ---------------------------------------------------------------------- */
/* Stubs. Every one of these is optional on the HUD's own contract.         */
/* ---------------------------------------------------------------------- */

const world = {
  id: 'station',
  displayName: 'Aether Station',
  minimapShapes: [],
  bounds: { minX: -200, maxX: 200, minZ: -200, maxZ: 200 },
};

const stubs = {
  bus,
  root,
  engine: { camera: null },
  input: { locked: false, pressed: () => false, fullscreenPreferred: false },
  player: {
    maxHealth: 100, health: 100, position: { x: 0, y: 0, z: 0 },
    yaw: 0, maxStamina: 100, stamina: 100,
  },
  worldManager: { active: world, ids: ['station', 'maze', 'citadel', 'race', 'medieval', 'space'], displayNameOf: (i) => i },
  npcManager: { npcs: [] },
  portals: { portals: [] },
  caches: null,
  contracts: null,
  questBoard: null,
  relics: null,
  viewpoints: null,
};

const hud = new HUD(stubs);
const help = new HelpMenu({ root, bus, input: stubs.input });
const touch = new TouchControls({ root, bus, input: stubs.input });

/* ---------------------------------------------------------------------- */
/* Fill every panel with the widest realistic content it can carry.         */
/* ---------------------------------------------------------------------- */

/* The pause hub, with the real shape `main.js` publishes: two groups, the
 * longest labels and the longest hint on the list. The hint is what sets the
 * card's minimum width, so a short stand-in would understate the card. */
hud.setPauseMenuItems([
  {
    title: 'Play',
    items: [
      { id: 'resume', label: 'Resume', hint: 'Esc', run() {} },
      { id: 'character', label: 'Character', run() {} },
      { id: 'mount', label: 'Customise mount', run() {} },
      { id: 'ship', label: 'Customise ship', run() {} },
      { id: 'inventory', label: 'Inventory', hint: 'I', run() {} },
      { id: 'quests', label: 'Quest board', hint: 'J', run() {} },
      { id: 'map', label: 'Map', run() {} },
    ],
  },
  {
    title: 'System',
    items: [
      { id: 'help', label: 'Help & controls', hint: 'F1', run() {} },
      { id: 'audio', label: 'Audio', run() {} },
      { id: 'keybinds', label: 'Rebind keys', run() {} },
      {
        id: 'fullscreen',
        label: 'Fullscreen: Off',
        hint: 'Applies when you resume. Off gives Ctrl+W back to the browser; the save prompt still guards it',
        run() {},
      },
      {
        id: 'graphics',
        label: 'Graphics: Balanced',
        hint: 'Effects and resolution apply now; anti-aliasing and shadow detail on reload',
        run() {},
      },
      { id: 'diagnostics', label: 'Diagnostics: Off', run() {} },
      { id: 'save', label: 'Save game', hint: 'F5', run() {} },
      { id: 'quit', label: 'Quit to menu', run() {} },
    ],
  },
]);

/** Everything the play scene shows at once, driven through the real setters. */
function dressPlayScene() {
  hud._goLive();

  /* Charter board, from the REAL `Charters.progress()` - the same payload the
   * `charter-hud` unit gate uses, for the same reason. */
  const charters = new Charters({ bus, worldManager: stubs.worldManager });
  const onboarding = new Onboarding({ bus });
  onboarding.deserialize({ done: [] });
  hud._setOnboarding(onboarding.progress());
  hud._setCharter(charters.progress());

  /* Space objectives: `live` plus every row populated, which is the widest the
   * panel ever gets. */
  hud._setObjectives({
    live: true, rank: 'Wing Commander', kills: 48, killNext: 60,
    wings: 3, wingTotal: 5, surveyed: 7, surveyTotal: 12,
    assayed: 4, assayTotal: 9, ore: 12480, oreNext: 20000,
    plot: null, hint: 'Survey the outer belt for the last two elements.',
  });

  hud._setDiscoveries({ found: 12, total: 30 }, { synced: 3, total: 5 });

  /* Quest tracker: the panel is hidden without a whole `QuestSystem`, and its
   * geometry is what matters here, so it is un-hidden and written directly. */
  hud.questTrack.hidden = false;
  hud.questTitle.textContent = 'The Long Dark of the Coil';
  hud.questStepLabel.textContent = 'Reach the centre of the maze';
  hud.questStepCount.textContent = '3/7';

  hud._setAmmo(24, 180, 30);
  hud._setMaxHealth(100);

  /* Mount readout, help chip, prompt and the unstuck affordance are all
   * class-toggled panels. */
  hud._setMount('hoverboard');
  hud.mountPanel.classList.add('show');
  hud.prompt.classList.add('show');
  hud.promptText.textContent = 'Talk to Quartermaster Vance';
  hud.stuckEl.classList.add('show');
  hud.camMode.classList.add('show');

  hud.mapLabel.textContent = 'AETHER STATION';

  hud.notify('Relic recovered — 120 CR when sold', 'loot');
  hud.notify('Quest updated: The Long Dark of the Coil', 'info');

  hud.setDebugVisible(true);

  /* Kill feed: three rows, which is what it holds in a firefight. */
  for (let i = 0; i < 3; i++) {
    const row = document.createElement('div');
    row.className = 'kf-row by-player';
    row.innerHTML = '<span class="kf-src">YOU</span><span class="kf-ico">×</span>'
      + '<span class="kf-dst">Corsair Lance</span>';
    hud.killfeed.appendChild(row);
  }
}

/* ---------------------------------------------------------------------- */
/* Scenes                                                                  */
/* ---------------------------------------------------------------------- */

const SCENES = {
  /** Engaged, everything on screen, no overlay. Desktop. */
  play() {
    touch.el.classList.remove('on');
  },
  /** Engaged on a phone: the same HUD with the touch layer over it. */
  touch() {
    touch.el.classList.add('on');
    touch.el.querySelector('.touch-stick')?.classList.add('on');
  },
  /** The Esc hub. */
  pause() {
    touch.el.classList.remove('on');
    hud.showPauseOverlay(true);
  },
  /** A conversation. */
  chat() {
    touch.el.classList.remove('on');
    hud.chatBox.open({ id: 'vance', name: 'Quartermaster Vance', role: 'Quartermaster' });
    hud.chatBox.el?.classList.add('open');
  },
  /** F1. */
  help() {
    touch.el.classList.remove('on');
    help.open();
  },
};

function clearScene() {
  hud.showPauseOverlay(false);
  hud.chatBox.el?.classList.remove('open');
  help.close();
  touch.el.classList.remove('on');
}

/* ---------------------------------------------------------------------- */
/* The probe's entry points                                                */
/* ---------------------------------------------------------------------- */

window.__harness = {
  viewportMeta: '',
  hud,
  scene(name) {
    clearScene();
    SCENES[name]?.();
    return name;
  },
  /**
   * Fake safe-area insets.
   *
   * There is no CDP command that makes a headless browser report a notch, so
   * `env(safe-area-inset-*)` is always 0 here. Both stylesheets therefore read
   * their insets through `--sa-t/r/b/l`, which are *defined* in `hud.css` as
   * `env(...)` with a 0 fallback - and this override replaces those four
   * custom properties with real lengths. What the probe then measures is
   * genuine Blink layout: a panel that is not actually anchored to the token
   * does not move, and the assertion catches it. The one thing it cannot
   * prove is that Safari's own `env()` values arrive - only that everything
   * downstream of them is wired.
   *
   * @param {{t:number,r:number,b:number,l:number}|null} inset CSS px per edge
   */
  setSafeArea(inset) {
    let style = document.getElementById('harness-safe-area');
    if (!style) {
      style = document.createElement('style');
      style.id = 'harness-safe-area';
      document.head.appendChild(style);
    }
    style.textContent = inset
      ? `:root{--sa-t:${inset.t}px;--sa-r:${inset.r}px;`
        + `--sa-b:${inset.b}px;--sa-l:${inset.l}px;}`
      : '';
  },
};

await installViewportMeta().then((c) => { window.__harness.viewportMeta = c; });
dressPlayScene();
SCENES.play();
document.documentElement.dataset.harness = 'ready';
