/**
 * Layout harness for `hud-viewport-probe.mjs`.
 *
 * ── What this is, and what it deliberately is not ─────────────────────────
 *
 * It is the REAL `HUD`, the REAL `WeaponWheel`, the REAL `PauseMenu`, the REAL
 * `ChatBox`, the REAL `HelpMenu`, the REAL `TouchControls` and the REAL panels
 * a player opens off the Esc hub and the touch tray - `QuestBoard`,
 * `InventoryUI`, `MarketplaceUI`, `CharacterMenu`, `MountMenu`, `ShipMenu`,
 * `KeybindMenu`, `MazeMap`, `MountWheel`, `BugReport` - built into a real
 * `#ui-root` in a real browser. Every stylesheet arrives the way the game
 * loads it: `hud.css` and `pause-menu.css` from the `<head>`, and the rest -
 * `touch.css` and the nine panel sheets - through each module's own
 * `import './x.css'`. Every box the probe measures is laid out by Blink from
 * the shipped stylesheets.
 *
 * ── Why the panels are here, which is the whole point of this file ────────
 *
 * They were not, and that is why the quest board shipped unusable on a phone.
 * The probe measured `HUD`, `HelpMenu` and `TouchControls` across five scenes,
 * so `quest-board.css` - a fixed `280px 1fr` grid inside `overflow: hidden`,
 * with no media query anywhere in the file - was never laid out at 390 px by
 * anything. At that width its detail pane is about 39 px of clipped,
 * unscrollable content, and the touch tray has a button that leads straight to
 * it. Eight further panels were in exactly the same position.
 *
 * A gate that grades three components out of thirteen and prints "HUD layout
 * OK" is this repository's signature defect wearing a green tick. So the
 * panels are built here, one scene each, and `SCENES` below is the authority
 * the probe reads its case list from - the next panel needs a scene here and
 * no change to the probe at all.
 *
 * It is still NOT the game. No renderer, no world, no physics, no Rapier, no
 * shader warmup - none of which has anything to say about where a panel lands.
 * Booting the whole game to measure a stylesheet would trade forty seconds of
 * WebGL for nothing, and would make the gate flaky for reasons that are not
 * layout.
 *
 * The stub systems below exist only so the real build methods run: the HUD
 * optional-chains every one of them (see its constructor docblock), so a stub
 * that answers nothing produces the same DOM a real one does. Where a panel
 * reads real content the real module is imported and used - the charter board
 * from `Charters.progress()`, the bag from a real `Inventory` with its real
 * starter kit, the shop from the real bundled `offlineCatalog()`, the mount
 * and ship ladders from the real `MOUNT_STATS` / `SHIP_SLOTS` tables. Only the
 * quest fixture is authored, because quests come from a service and there is
 * no bundled set to read; see `QUESTS`.
 *
 * ── Every panel scene PROVES the panel opened ─────────────────────────────
 *
 * `scene()` throws when the panel it names did not end up on screen. A panel
 * that silently refuses to open - a precondition the stub stopped satisfying,
 * a constructor that started needing something - would otherwise be measured
 * as an empty screen and reported clean, which is worse than not measuring it.
 * The probe turns that throw into a failed run.
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
import { Retention, dayKey } from '../../src/systems/Retention.js';
import { ActiveEffects, EFFECT_KINDS } from '../../src/systems/ActiveEffects.js';

/* The panels. Each one brings its own stylesheet in with it. */
import { QuestBoard } from '../../src/ui/QuestBoard.js';
import { InventoryUI } from '../../src/ui/InventoryUI.js';
import { MarketplaceUI } from '../../src/ui/MarketplaceUI.js';
import { CharacterMenu } from '../../src/ui/CharacterMenu.js';
import { MountMenu } from '../../src/ui/MountMenu.js';
import { ShipMenu } from '../../src/ui/ShipMenu.js';
import { KeybindMenu } from '../../src/ui/KeybindMenu.js';
import { MazeMap } from '../../src/ui/MazeMap.js';
import { MountWheel } from '../../src/ui/MountWheel.js';
import { BugReport } from '../../src/ui/BugReport.js';
import { RecordsPanel } from '../../src/ui/RecordsPanel.js';

/* Real content for the panels that have any. */
import { Inventory } from '../../src/systems/Inventory.js';
import { Economy } from '../../src/systems/Economy.js';
import { offlineCatalog } from '../../src/systems/MarketplaceOffline.js';
import { MOUNT_STATS } from '../../src/mounts/Livery.js';
import { SHIP_SLOTS, SHIP_STATS } from '../../src/ships/ShipStats.js';
import { MAZE, DIR } from '../../src/worlds/maze/MazeTopology.js';
import { BINDABLE } from '../../src/core/Input.js';

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

/* Everything the panels ask `Input` for while opening and closing. Each one is
 * optional-chained at the call site, but a stub that answers nothing makes a
 * panel take a different branch from the one the game takes - `MazeMap._onKey`
 * reads `textCaptured`, `MountWheel` and `MazeMap` both read `codeFor('map')` -
 * so they are answered rather than omitted. */
const inputStub = {
  locked: false,
  textCaptured: false,
  fullscreenPreferred: false,
  pressed: () => false,
  exitLock: () => {},
  setTextCapture(v) { this.textCaptured = !!v; },
  reengage: () => null,
  codeFor: (action) => (action === 'map' ? 'KeyM' : null),
  /* The REAL bindable table. `KeybindMenu` draws one row per entry and its
   * card's height is entirely a function of how many there are, so a stub list
   * would size the panel to a keyboard the game does not have. */
  get bindings() { return BINDABLE.map((d) => ({ ...d, bound: d.code })); },
  setBinding: () => ({ ok: false }),
  resetBindings: () => {},
};

const stubs = {
  bus,
  root,
  /* `simElapsed` is what the HUD counts an effect chip down against, and zero
   * is the honest reading for a harness that never runs a frame: every chip
   * then shows its full duration, which is also the widest number it can show
   * and therefore the right one to lay out against. */
  engine: { camera: null, simElapsed: 0 },
  input: inputStub,
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

/* ====================================================================== */
/* The panels, and the least content each one needs to be its real size    */
/* ====================================================================== */

/* ---- the bag ---------------------------------------------------------
 * The REAL `Inventory`, with its real starter kit, so the grid holds the
 * rows a new player actually has rather than a made-up list. `ui: false`
 * because the panel is built below by hand: `Inventory._mountUI` imports
 * `InventoryUI` dynamically and would race the harness's ready flag. */
const economy = new Economy({ bus, credits: 4820 });
const inventory = new Inventory({ bus, economy, input: stubs.input, root, ui: false });

/* ---- the shop --------------------------------------------------------
 * `offlineCatalog()` is the catalogue the game itself falls back to when
 * `/api/marketplace/items` is unreachable, which is exactly the situation a
 * Vite-only harness is in. Reading it directly rather than letting the real
 * `Marketplace` fetch and fail keeps the case synchronous: an async catalogue
 * would settle some time after `data-harness=ready` and the probe would
 * measure whichever of the two states it happened to catch. */
const marketRows = offlineCatalog('station');
const market = {
  items: marketRows,
  sellables: [],
  categories: ['cosmetic', 'weapons', 'tools', 'health', 'spells', 'mounts', 'ships'],
  loading: false,
  error: null,
  offline: true,
  filters: { search: '', category: '' },
  setFilters: () => {},
  buy: () => ({ ok: false }),
  sell: () => ({ ok: false }),
};

/* ---- quests ----------------------------------------------------------
 * AUTHORED, and the only fixture here that is. Quests are served by
 * `/api/game/quests`; there is no bundled set to read, the way there is for
 * the shop. So this is the widest realistic board: the longest title the
 * generator produces, a seven-step quest with counts and a prerequisite -
 * because the detail pane's ACCEPT button and per-step DONE buttons are what
 * a narrow layout squeezes first, and they only exist once a quest is
 * selected. `SCENES.quests` selects one by clicking the list row, the same
 * way a player does. */
const QUESTS = [
  {
    id: 'q-coil-01',
    title: 'The Long Dark of the Coil: recover the surveyor’s cache',
    quest_line: 'Verdant Coil',
    reward_credits: 1450,
    duration_minutes: 90,
    pre_steps: JSON.stringify(['Reach the second floor', 'Speak to Warden Cato Reyes']),
    steps: JSON.stringify([
      { order: 1, label: 'Reach the centre of the maze', type: 'reach', count: 1 },
      { order: 2, label: 'Collect maze tokens from the sunken junctions', type: 'collect', count: 7 },
      { order: 3, label: 'Investigate the surveyor’s abandoned camp', type: 'investigate', count: 1 },
      { order: 4, label: 'Defeat the coil wardens guarding the lift shaft', type: 'defeat', count: 4 },
      { order: 5, label: 'Deliver the cache to Quartermaster Bex', type: 'deliver', count: 1 },
      { order: 6, label: 'Return through the centre portal', type: 'reach', count: 1 },
      { order: 7, label: 'Report to the Deck Warden on the station concourse', type: 'talk', count: 1 },
    ]),
  },
  {
    id: 'q-yard-02',
    title: 'Lodestar Yard: sign for the Dray',
    quest_line: 'Lodestar Yard',
    reward_credits: 620,
    duration_minutes: 30,
    pre_steps: null,
    steps: JSON.stringify([
      { order: 1, label: 'Walk the cradle line', type: 'reach', count: 1 },
      { order: 2, label: 'Countersign the berth manifest', type: 'talk', count: 1 },
    ]),
  },
  {
    id: 'q-station-03',
    title: 'Foundry backlog',
    quest_line: 'Aether Nexus',
    reward_credits: 240,
    duration_minutes: null,
    pre_steps: null,
    steps: JSON.stringify([
      { order: 1, label: 'Sell 12 salvage cores to the exchange', type: 'sell', count: 12 },
    ]),
  },
];
const questSystem = {
  worldQuests: QUESTS,
  engagements: new Map(),
  openBoard: () => {},
  accept: async () => {},
};

/* ---- cosmetics, mounts, ships ---------------------------------------
 * `MountMenu` reads `mount.constructor.CUSTOM_SLOTS` and `.STATS`; `ShipMenu`
 * reads `ship.slots` / `ship.stats`. Both tables are imported real, so a
 * seventh slot or a fifth stat changes what this gate lays out. The mount
 * object itself is a literal: constructing a real `Hoverboard` would need a
 * THREE scene, physics and a material cache to answer one static field. */
const cosmetics = { has: () => false };
const hoverboard = {
  id: 'hoverboard',
  displayName: 'HOVERBOARD',
  constructor: {
    CUSTOM_SLOTS: [
      { id: 'deck', label: 'Deck', finish: true, defaultColor: 0x2c2f36, palette: 'paint' },
      { id: 'glow', label: 'Underglow', finish: false, defaultColor: 0xadefff, palette: 'glow' },
    ],
    STATS: MOUNT_STATS.hoverboard,
  },
};
const mounts = {
  mounted: true,
  active: hoverboard,
  unlocked: ['hoverboard', 'bicycle', 'car', 'horse'],
  worldManager: stubs.worldManager,
  getLivery: () => ({}),
  setLivery: () => {},
  resetLivery: () => {},
  /* EVERY stat owned, and one of them switched off.
   *
   * This used to be `() => ({})`, which is a stock mount - and a stock mount
   * lays out neither of the two pieces of geometry that own mount upgrades.
   * `.mount-pow` is `display: none` when empty, so the HUD's badge row was
   * never measured at all, and every F10 upgrade row read "Not upgraded", so
   * its On/Off switch was never measured either. The gate was grading a panel
   * the game only shows to a player who has bought nothing.
   *
   * Three tiers is the widest the badge row gets on this mount (hoverboard
   * sells three stats; only the dragon has a fourth), and one switched off is
   * what puts a struck-through badge and an "Off" chip on screen at the same
   * time as the lit ones. */
  getPowers: () => ({ power: 3, strength: 2, shield: 1 }),
  isPowerEnabled: (_mountId, power) => power !== 'shield',
  setPowerEnabled: () => false,
  summon: () => {},
};

/* The Dray: four slots, four stats and the longest blurb of the three
 * customisable hulls, which is the widest the drawer ever gets. */
const HULLS = ['kestrel', 'dray', 'pike'].map((id) => ({
  id,
  displayName: id[0].toUpperCase() + id.slice(1),
  berth: `Cradle ${id === 'kestrel' ? 'A' : id === 'dray' ? 'B' : 'C'}`,
  slots: SHIP_SLOTS[id],
  stats: SHIP_STATS[id],
}));
const ships = {
  selected: HULLS[1],
  hulls: () => HULLS,
  select: () => true,
  getLivery: () => ({}),
  setLivery: () => {},
  resetLivery: () => {},
  getPowers: () => ({ power: 2, shield: 1, fire: 1, hold: 3 }),
};

/* ---- the maze the map draws -----------------------------------------
 * `MazeMap` only opens in a world whose `rules.mounts` is false - that is
 * `mapActionOwner`'s whole contract - and it rasterises `world.cells`.
 *
 * The cells are SYNTHETIC and that is deliberate: `generateTopology()` carves
 * 640,000 of them and the probe reloads this page once per case, which would
 * put a real carve on every one of them for a drawing that cannot move a
 * single box. The canvas is `flex: 1 1 auto` inside the panel, so what is
 * drawn on it has no bearing on any rectangle the probe measures - the header
 * row, the level tabs, FIND ME and the legend are the layout, and those are
 * the real ones. A coarse open lattice keeps the bake to a few thousand
 * strokes so the case does not time out.
 *
 * Built on first use rather than at module scope: twelve of the thirteen
 * scenes never look at it. */
let mazeWorld = null;
function mazeCells() {
  if (mazeWorld) return mazeWorld;
  const cells = new Uint8Array(MAZE.TOTAL_CELLS);
  const open = DIR.N | DIR.E | DIR.S | DIR.W;
  cells.fill(open);
  for (let level = 0; level < MAZE.LEVELS; level++) {
    const base = level * MAZE.LEVEL_CELLS;
    for (let z = 0; z < MAZE.CELLS; z++) {
      for (let x = 0; x < MAZE.CELLS; x++) {
        /* One wall every twenty cells in each axis: a legible grid of rooms,
         * and ~16k segments a level rather than ~320k. */
        let v = open;
        if (x % 20 === 0) v &= ~DIR.W;
        if (z % 20 === 0) v &= ~DIR.N;
        cells[base + z * MAZE.CELLS + x] = v;
      }
    }
  }
  mazeWorld = {
    id: 'maze',
    displayName: 'The Verdant Coil',
    seed: 1,
    playerLevel: 1,
    rules: { mounts: false },
    cells,
    mapMarkers: () => null,
    solutionPath: () => null,
  };
  return mazeWorld;
}

/** The world manager the map and the wheel read. Swapped per scene. */
const panelWorlds = { active: world };

/* ---- the records sheet ----------------------------------------------
 * The REAL `Charters` and the REAL `Retention`, seeded through their own
 * `deserialize` (the same door `SaveGame` uses) so the board carries the
 * widest realistic mix: a part-done world with deeds, three worlds with
 * learned rosters at zero, and one never surveyed. Numerators stay honest —
 * no relic system is wired here, so every learned column reads 0/N, which is
 * exactly what those columns say on a fresh device. The leaderboard section
 * renders its real unreachable state, because a Vite-only harness has no
 * `/api/game/leaderboard` — the same state the game shows under `npm run dev`. */
const recordsCharters = new Charters({ bus, worldManager: stubs.worldManager });
recordsCharters.deserialize({
  rosters: {
    citadel: { relics: 17, viewpoints: 5, trials: 2 },
    medieval: { relics: 24, seams: 6 },
    space: { wings: 12, survey: 10 },
  },
  charters: [],
  deeds: ['station/trade', 'station/mount'],
});
const recordsRetention = new Retention({ bus, charters: recordsCharters });
recordsRetention.deserialize({
  done: [
    `daily/${dayKey(Date.now())}`,
    `daily/${dayKey(Date.now() - 86400000)}`,
    `daily/${dayKey(Date.now() - 2 * 86400000)}`,
  ],
  season: [],
});

const questBoard = new QuestBoard({ root, bus, input: stubs.input, questSystem });
const inventoryUI = new InventoryUI({ bus, inventory, economy, input: stubs.input, root });
const marketUI = new MarketplaceUI({ bus, market, inventory, economy, input: stubs.input, root });
const character = new CharacterMenu({ root, bus, input: stubs.input, avatar: null, player: stubs.player, cosmetics });
const mountMenu = new MountMenu({ root, bus, input: stubs.input, mounts, cosmetics, inventory, player: stubs.player });
const shipMenu = new ShipMenu({ root, bus, input: stubs.input, ships, player: stubs.player });
const keybinds = new KeybindMenu({ root, bus, input: stubs.input });
const mazeMap = new MazeMap({ root, bus, input: stubs.input, worldManager: panelWorlds, player: stubs.player });
const mountWheel = new MountWheel({ root, bus, input: stubs.input, mounts, worldManager: panelWorlds });
const bugReport = new BugReport({ root, bus, input: stubs.input, player: stubs.player, worldManager: stubs.worldManager });
const recordsPanel = new RecordsPanel({
  root, bus, input: stubs.input, charters: recordsCharters, retention: recordsRetention,
});

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
      { id: 'records', label: 'Records', hint: 'N', run() {} },
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

  /* The custom-server chip, through the REAL bus event main.js emits - not by
   * un-hiding the element - so the play and touch scenes measure the chip the
   * way a custom-server session renders it. The name is the widest realistic
   * one, for the same reason the pause hub gets its longest labels: a short
   * stand-in would understate the box. General play is the chip's built state
   * and is what every scene measured before this line existed. */
  bus.emit('session:server', { server: { id: 'srv-layout', name: 'Ironvale Frontier RP' } });

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
  /* The mount ledger, before `_setMount` draws the panel from it.
   *
   * `attach()` only fills `_att`; `_mounts` is written by `_pollSystems`, which
   * runs off `hud.update(dt)` and this harness never calls. Without the direct
   * write `_setMountPowers` reads a null ledger and draws NO badges - which is
   * precisely the production defect that was just fixed (`HUD.attach` was never
   * called at all), so a gate that skipped this would have gone on grading the
   * broken layout for as long as the bug lasted. Both lines, so the private and
   * the public route agree. */
  hud.attach({ mounts });
  hud._mounts = mounts;
  /* ARMED, because the numbered badge is the WIDER of the two states.
   *
   * Holding the fittings key (G) prefixes every badge with its digit -
   * "1·PWR 3" instead of "PWR 3" - and the badge row sits in a mount panel
   * that is measured to the pixel on a 390 px screen. A gate that only ever
   * saw the resting badges would grade the narrow case and let the wide one
   * ship clipped, which is the same shape as the `getPowers: () => ({})`
   * mistake this stub's own comment records. The resting state is strictly
   * narrower, so measuring the wide one covers both.
   *
   * Still three badges and not four: the hoverboard this harness rides sells
   * three stats, and a fourth would be measuring a mount the game cannot
   * produce. */
  hud._fittingsArmed = true;
  hud._setMount('hoverboard');
  hud.mountPanel.classList.add('show');
  hud.prompt.classList.add('show');
  hud.promptText.textContent = 'Talk to Quartermaster Vance';
  hud.stuckEl.classList.add('show');
  hud.camMode.classList.add('show');

  hud.mapLabel.textContent = 'AETHER STATION';

  hud.notify('Relic recovered — 120 CR when sold', 'loot');
  hud.notify('Quest updated: The Long Dark of the Coil', 'info');

  /* THE ACTIVE-EFFECT STRIP, from the REAL ledger on the real bus rather than
   * by appending chips by hand - so this measures the payload `ItemUse` will
   * actually raise. EVERY kind in `EFFECT_KINDS` at once - nine of them today -
   * because nothing stops a player using nine consumables in a row, it is the
   * widest the strip ever gets, and it is the case `--eff-h` is sized for
   * (rows of three, nine effects, three rows).
   *
   * Deliberately iterated rather than listed: a tenth kind added to that map
   * turns up here on its own and the gate measures the fourth row it needs,
   * which is what makes the reserve in `hud.css` checkable instead of trusted. */
  const effects = new ActiveEffects({ bus, clock: () => 0 });
  for (const kind of Object.keys(EFFECT_KINDS)) effects.start(kind, 30);

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

/**
 * On screen for real, right now.
 *
 * Every panel here closes by dropping to `opacity: 0`/`visibility: hidden` or
 * `display: none`, and each scene asserts through this that the panel it just
 * opened came up. A panel that quietly refuses - a precondition the stub
 * stopped meeting, a constructor that grew a dependency - would otherwise be
 * graded as a blank screen and reported clean.
 */
function shown(el, what) {
  const box = el?.getBoundingClientRect();
  const cs = el && getComputedStyle(el);
  if (!box || box.width < 2 || box.height < 2
      || cs.visibility === 'hidden' || cs.display === 'none' || parseFloat(cs.opacity) < 0.02) {
    throw new Error(`the ${what} did not open — this case would have measured an empty screen`);
  }
  return el;
}

const SCENES = {
  /** Engaged, everything on screen, no overlay. Desktop. */
  play() {
    touch.el.classList.remove('on');
  },
  /** Engaged on a phone: the same HUD with the touch layer over it. */
  touch() {
    touch.el.classList.add('on');
    /* The ring at REST, where the layer puts it before any thumb lands, and
     * the coach line up: the state a phone player meets first. */
    touch.el.querySelector('.touch-coach')?.classList.add('show');
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

  /* ---- the panels the hub and the touch tray lead to ------------------ */

  /**
   * J, and the touch tray's QUEST button.
   *
   * Opened AND a quest selected, by clicking the first row exactly as a player
   * does. The detail pane is empty until something is selected, and the detail
   * pane is where the ACCEPT button, the seven step rows and their per-step
   * controls live - which is the half of this panel a 390 px screen destroys.
   */
  quests() {
    questBoard.open();
    const panel = shown(document.querySelector('.qb-root'), 'quest board');
    panel.querySelector('.qb-item')?.click();
    shown(panel.querySelector('.qb-detail-inner'), 'quest board detail pane');
  },
  /** I. */
  inventory() {
    inventoryUI.open();
    shown(document.querySelector('.inv-root.open .inv-panel'), 'inventory');
  },
  /**
   * B, at a vendor.
   *
   * `market:open` is published by hand because in the game it is `Marketplace
   * .open()` that emits it, not the panel - and that event is what puts the
   * HUD into `.overlaid`, which is what takes the weapon strip off the sheet.
   * Opening the panel without it would measure a HUD state the game never has.
   */
  market() {
    marketUI.open({ name: 'Nexus Exchange' });
    bus.emit('market:open', {});
    shown(document.querySelector('.mkt-panel'), 'marketplace');
  },
  /** The hub's Character row. */
  character() {
    character.open();
    shown(document.querySelector('.ch-panel'), 'character drawer');
  },
  /** The hub's Customise mount row. */
  mount() {
    mountMenu.open();
    shown(document.querySelector('.mm-panel'), 'mount drawer');
  },
  /** The hub's Customise ship row. */
  ship() {
    shipMenu.open();
    shown(document.querySelector('.sm-panel'), 'ship drawer');
  },
  /** The hub's Rebind keys row. */
  keybinds() {
    keybinds.open();
    shown(document.querySelector('.kb.show .kb-card'), 'keybind panel');
  },
  /**
   * M in the maze - the hub's Map row.
   *
   * The world is swapped first: `mapActionOwner` gives M to the mount wheel
   * everywhere `rules.mounts` is not false, and the map refuses to open in a
   * world it cannot draw.
   */
  map() {
    panelWorlds.active = mazeCells();
    mazeMap.open();
    shown(document.querySelector('.mz-map-panel'), 'maze map');
  },
  /** M anywhere else. */
  wheel() {
    panelWorlds.active = world;
    mountWheel.open();
    shown(document.querySelector('.mw.show .mw-ring'), 'mount wheel');
  },
  /** F8. */
  bug() {
    bugReport.open();
    shown(document.querySelector('.br-root.open .br-panel'), 'bug report');
  },
  /**
   * N, and the hub's Records row.
   *
   * Opened AND a world row unfolded, by clicking it exactly as a player does —
   * the per-column record only exists on screen once a known row is expanded,
   * and those unfolded lines are the half a 390 px screen squeezes first. The
   * leaderboard section is left in its real unreachable state; see the
   * construction note above.
   */
  records() {
    recordsPanel.open();
    const panel = shown(document.querySelector('.rec-root.open .rec-panel'), 'records sheet');
    panel.querySelector('.rec-row.openable')?.click();
    shown(panel.querySelector('.rec-cols:not([hidden])'), 'records per-column record');
  },
};

function clearScene() {
  hud.showPauseOverlay(false);
  hud.chatBox.el?.classList.remove('open');
  help.close();
  touch.el.classList.remove('on');
  questBoard.close();
  inventoryUI.close();
  /* Guarded, because `market:close` is not a no-op the way the `close()` calls
   * around it are. Every panel here early-returns when it is already shut;
   * this event does not, and an unconditional one takes the HUD's overlay Set
   * to empty, which queues `_deferHubCheck` - a microtask that then hid the
   * pause card the `pause` scene had just raised. The scene measured four
   * weapon slots and no hub. */
  if (marketUI.isOpen) {
    marketUI.close();
    bus.emit('market:close', {});
  }
  character.close();
  mountMenu.close();
  shipMenu.close();
  keybinds.close();
  mazeMap.close();
  mountWheel.close();
  bugReport.close();
  recordsPanel.close();
  panelWorlds.active = world;
}

/* ---------------------------------------------------------------------- */
/* The probe's entry points                                                */
/* ---------------------------------------------------------------------- */

window.__harness = {
  viewportMeta: '',
  hud,
  /**
   * The live panel instances.
   *
   * The probe measures rectangles and needs none of these. They are here so
   * that a gesture - a pinch on the map, a drag - can be driven with real
   * pointer events against the REAL panel and its own state read back, which
   * is the only honest way to check one: `MazeMap.js` imports a stylesheet, so
   * Node cannot load it and every unit test this repository has of that file
   * is a source scrape.
   */
  panels: {
    questBoard, inventoryUI, marketUI, character, mountMenu,
    shipMenu, keybinds, mazeMap, mountWheel, bugReport, recordsPanel,
  },

  /**
   * THE CASE LIST, and it lives here rather than in the probe.
   *
   * The probe owns how a layout is graded; this file owns what exists to be
   * graded. Keeping the list here is what makes adding a panel a one-file
   * change - and it is why the quest board went unmeasured for as long as it
   * did, because the old list was a literal in the probe that nobody thought
   * to touch when a panel shipped.
   */
  scenes: Object.keys(SCENES),
  scene(name) {
    clearScene();
    const fn = SCENES[name];
    if (!fn) throw new Error(`no such harness scene: ${name}`);
    fn();
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
