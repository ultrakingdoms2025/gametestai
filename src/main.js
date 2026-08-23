import * as THREE from 'three';
import { CONFIG, applyUrlOverrides } from './core/Config.js';
import { bus } from './core/EventBus.js';
import { Engine } from './core/Engine.js';
import { Input } from './core/Input.js';
import { Physics } from './physics/Physics.js';
import { MaterialLibrary } from './gfx/Materials.js';
import { createPostFX } from './gfx/PostFX.js';
import { resolveTier, applyBootTier, applyTier, storeTierId, TIER_IDS, TIERS } from './gfx/QualityTier.js';
import { WorldManager } from './worlds/WorldManager.js';
import { mapActionOwner } from './worlds/WorldRules.js';
import { StationWorld } from './worlds/StationWorld.js';
import { MedievalWorld } from './worlds/MedievalWorld.js';
import { SportsWorld } from './worlds/SportsWorld.js';
import { CitadelWorld } from './worlds/CitadelWorld.js';
import { RaceWorld } from './worlds/RaceWorld.js';
import { MazeWorld } from './worlds/MazeWorld.js';
import { DockWorld } from './worlds/DockWorld.js';
import { SpaceWorld } from './worlds/SpaceWorld.js';
import { worldClasses as planetWorldClasses } from './worlds/planets/index.js';
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
import { CreditReporter } from './systems/CreditReporter.js';
import { SaveGame } from './systems/SaveGame.js';
import { UnstuckSystem } from './systems/Unstuck.js';
import { MountManager } from './mounts/MountManager.js';
import { WaterVolumes } from './systems/WaterVolumes.js';
import { Stamina } from './systems/Stamina.js';
import { Inventory } from './systems/Inventory.js';
import { Loot } from './systems/Loot.js';
import { Marketplace } from './systems/Marketplace.js';
import { Cosmetics } from './systems/Cosmetics.js';
import { ItemUseSystem } from './systems/ItemUse.js';
import { HelpMenu } from './ui/HelpMenu.js';
import { MountWheel } from './ui/MountWheel.js';
import { TouchControls } from './ui/TouchControls.js';
import { MazeMap } from './ui/MazeMap.js';
import { KeybindMenu } from './ui/KeybindMenu.js';
import { CharacterMenu } from './ui/CharacterMenu.js';
import { MountMenu } from './ui/MountMenu.js';
import { ShipMenu } from './ui/ShipMenu.js';
import { ShipRegistry } from './ships/ShipRegistry.js';
import { Piloting } from './ships/Piloting.js';
import { SpaceCombat } from './ships/SpaceCombat.js';
import { FlightHUD } from './ui/FlightHUD.js';
import { Mining } from './systems/Mining.js';
import { LightRig } from './gfx/LightRig.js';
import { Caches } from './systems/Caches.js';
import { Contracts } from './systems/Contracts.js';
import { QuestSystem } from './systems/QuestSystem.js';
import { AdminCheats } from './systems/AdminCheats.js';
import { Relics } from './systems/Relics.js';
import { syncProgress } from './systems/ProgressSync.js';
import { Viewpoints } from './systems/Viewpoints.js';
import { SpaceObjectives } from './systems/SpaceObjectives.js';
import { Interiors } from './systems/Interiors.js';
import { AudioDirector } from './audio/AudioDirector.js';
import { AudioMenu } from './ui/AudioMenu.js';
import { RaceManager } from './race/RaceManager.js';
import { RaceUI } from './ui/RaceUI.js';
import { MinigameManager } from './minigames/MinigameManager.js';
import { MinigamePose } from './minigames/MinigamePose.js';
import { createSwimChallenge } from './minigames/SwimChallenge.js';
import { createSkiRun } from './minigames/SkiRun.js';
import { createTennisMatch } from './minigames/TennisMatch.js';
import { createTrackRace } from './minigames/TrackRace.js';
import { createRooftopTrial } from './minigames/RooftopTrial.js';
import { createTestFire } from './minigames/TestFire.js';
import { TennisPose } from './minigames/TennisPose.js';
import { MinigameUI } from './ui/MinigameUI.js';
import { QuestBoard } from './ui/QuestBoard.js';
import { BugReport } from './ui/BugReport.js';
import { forceDrawable } from './gfx/RehearsalDraw.js';
import { planCompileWarm, chunkUnits, runSliced } from './gfx/PreviewWarm.js';

/**
 * AETHER NEXUS - bootstrap.
 *
 * This file is the single integration point: it constructs every subsystem,
 * wires them through the event bus, and owns the boot sequence. Subsystems
 * never import each other's concrete classes - they talk through `bus` and the
 * context objects handed to them here.
 */

const overrides = applyUrlOverrides();

/* The renderer quality tier, resolved FIRST and written into `CONFIG` before
 * anything reads it.
 *
 * Four of a tier's settings cannot be applied later: MSAA lives on the
 * composer's HDR render target, and the far plane, the pixel-ratio ceiling and
 * the shadow map's resolution are read out of `CONFIG.render` by the `Engine`
 * constructor and by the light rig below. Applied after `new Engine(...)` this
 * would set a far plane on a camera that had already been built with the old
 * one. @see gfx/QualityTier.js */
let qualityTier = resolveTier();
applyBootTier(qualityTier, CONFIG);

const canvas = document.getElementById('viewport');
const uiRoot = document.getElementById('ui-root');

const engine = new Engine(canvas, bus);
const input = new Input(canvas, bus);
const physics = new Physics(bus);
const materials = new MaterialLibrary(engine.renderer);

engine.postfx = createPostFX(engine);

/* The half of the tier that CAN move at runtime: the five post passes, the
 * shadow toggle, the far plane, the pixel-ratio ceiling and the resolution
 * floor. Applied here at boot and again from the hub's Graphics row. */
function setQualityTier(id) {
  storeTierId(id);
  qualityTier = resolveTier();
  applyTier(qualityTier, {
    renderer: engine.renderer,
    camera: engine.camera,
    engine,
    postfx: engine.postfx,
    config: CONFIG,
  });
  bus.emit('gfx:quality', { id: qualityTier.id, chosen: id });
  return qualityTier;
}
applyTier(qualityTier, {
  renderer: engine.renderer,
  camera: engine.camera,
  engine,
  postfx: engine.postfx,
  config: CONFIG,
});

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
worldManager.register(RaceWorld);
worldManager.register(MazeWorld);
/* Gateway 06's destination, and the one place beyond it.
 *
 * `register` is metadata-only and keyed on `static id` - nothing is
 * constructed until the world is first requested - so registering the yard and
 * the space beyond it costs nothing until somebody walks through the gateway.
 *
 * `SpaceWorld` is registered in the DOCK drop rather than in the flight drop
 * on purpose. The yard's launch portal targets it, so without it the blast
 * door leads to `[WorldManager] unknown world "space"`; and standing it up now
 * exercises the whole registration surface - background builds, the light rig
 * claim, portal previews, `arrivalFor`'s return-portal-by-target lookup, the
 * PostFX grade, the music score and `lorekeeperScope`'s two-target branch - at
 * a point where every one of those answers is still cheap to change. */
worldManager.register(DockWorld);
worldManager.register(SpaceWorld);
/* Every planet surface, from its descriptor.
 *
 * One registration per descriptor and no world class per planet - `PlanetWorld.of`
 * stamps a four-field subclass, which is the whole point of the parameterised
 * surface system. Ten planets later this loop is unchanged.
 *
 * They register HERE, beside the void that names them, because `Bodies.CINDER`
 * carries `surfaceWorld: 'planet:cinder'` and a body that names a world nobody
 * registered is a planet you can fly at forever and never reach. That is the
 * signature defect of this project, and `piloting-loop.test.mjs` asserts every
 * landable body resolves to something in `worldManager.ids`. */
for (const PlanetClass of planetWorldClasses()) worldManager.register(PlanetClass);

const player = new Player({ ...ctx, camera: engine.camera });
/* Worlds are constructed before the player exists, but they only ever read this
 * during `update`, by which time it is here. The station needs it: its links
 * carry travelators and its towers carry escalators, and a moving surface has to
 * know whether anybody is standing on it. `ctx` is shared by reference, so this
 * reaches every world already registered above. */
ctx.player = player;
const npcManager = new NPCManager({ ...ctx, player });
/* Same shared-by-reference trick as `ctx.player` above, and for a world that
 * needs it in exactly the same way: the maze streams its wanderers with the
 * districts that carry them (see MazePopulation), so it has to be able to ask
 * for one long after `spawnForWorld` has been and gone. Read during `update`
 * only, by which time this is here. */
ctx.npcManager = npcManager;
let loreRefreshInFlight = null;
let loreWarned = false;

async function refreshLore() {
  if (loreRefreshInFlight) return loreRefreshInFlight;
  loreRefreshInFlight = (async () => {
    try {
      const res = await fetch('/api/lore', { cache: 'no-store' });
      if (!res.ok) throw new Error(`http ${res.status}`);
      const data = await res.json();
      if (data?.entries) npcManager.setLoreData(data.entries);
    } catch (err) {
      if (!loreWarned) {
        loreWarned = true;
        console.warn('[lore] remote lore unavailable; using bundled defaults:', err);
      }
    } finally {
      loreRefreshInFlight = null;
    }
  })();
  return loreRefreshInFlight;
}

void refreshLore();
bus.on('world:changed', () => {
  void refreshLore();
});

const portals = new PortalSystem({ ...ctx, player, worldManager, npcManager });
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
/* Reports every credit change to the account so the SERVER owns the balance.
 * Idle until `start()`, which only happens for a signed-in player -- a guest's
 * credits stay local exactly as before. It listens to `credits:changed`, the
 * one event every earn and spend in the game passes through, so no source can
 * be missed and a source added later is covered without its author knowing
 * this exists. */
const creditReporter = new CreditReporter({ bus, economy });
const projectiles = new ProjectileSystem({ ...ctx, player, npcManager, combat });

// Loadout adopts the machine gun Player already built rather than making a
// second one, and from here on owns the viewmodel and the fire input.
const loadout = new Loadout({ ...ctx, camera: engine.camera, player, npcManager, projectiles, cameraRig });
player.loadout = loadout;

const mounts = new MountManager({ ...ctx, player, camera: engine.camera, cameraRig, avatar, npcManager, worldManager });
// Late injection: Player and Combat are built before the mounts exist, and both
// read purchased mount tiers (Armour, Dragon Fire) through this reference.
player.mounts = mounts;
combat.mounts = mounts;
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
// Permanent purchasable skins. Bought at a merchant, worn from the F2 (character)
// or F10 (mount) menu, and round-tripped through both save paths so a
// limited-edition unlock sticks.
const cosmetics = new Cosmetics({ bus });
const itemUse = new ItemUseSystem({ bus, player, inventory, loot, portals, npcManager, combat, mounts, cosmetics });
// `mounts` is passed read-only so preview() can refuse a mount power the player
// already owns - see the `owned` branch in Marketplace.preview().
const market = new Marketplace({ bus, economy, inventory, cosmetics, mounts, player, npcManager, input, root: uiRoot });
const helpMenu = new HelpMenu({ root: uiRoot, bus, input });
const mountWheel = new MountWheel({ root: uiRoot, bus, input, mounts, worldManager });
/* The on-screen touch layer. Constructed unconditionally and hidden until
 * `input:touchmode` says the session is being driven by a finger, so a desktop
 * player never has it and a tablet that is picked up mid-session does. */
const touchControls = new TouchControls({ root: uiRoot, bus, input });
/* The maze's M map. It owns its own keydown listener rather than going through
 * `input.pressed`, like the other panels, and shares the `map` action with the
 * mount wheel above - `mapActionOwner` decides which of them M means in the
 * active world, so the two can never both open. */
const mazeMap = new MazeMap({ root: uiRoot, bus, input, worldManager, player });
// F6. Rebinds anything Input resolves; the panel keys stay fixed on purpose.
const keybindMenu = new KeybindMenu({ root: uiRoot, bus, input });
// F2. Edits the avatar live and publishes `character:changed`, which SaveGame
// snapshots and MountManager listens for so the rider on a mount is the same
// person as the one on foot. F2 is character-only; mounts are customised from F10.
const characterMenu = new CharacterMenu({ root: uiRoot, bus, input, avatar, player, cosmetics });
// F10. Customises the mount being ridden (colour slots, skins, upgrade tiers);
// generic over each mount's CUSTOM_SLOTS/STATS. Refuses to open on foot.
const mountMenu = new MountMenu({ root: uiRoot, bus, input, mounts, cosmetics, inventory, player });
/* Hull liveries and upgrade tiers. It arms off a published field — `world.ships`
 * — exactly as `Relics`, `Caches`, `Viewpoints` and `MinigameManager` do, so no
 * world knows this exists and a world with no hulls simply has none. The panel
 * is in the Esc hub rather than on a function key: F2-F12 are Chrome's and only
 * answer when the page happens to have focus. */
const ships = new ShipRegistry({ bus, worldManager });
const shipMenu = new ShipMenu({
  root: uiRoot, bus, input, ships, player,
  /* The camera and the scene, so the panel can point at the hull it is
   * painting. See the turntable note in ShipMenu's constructor: the
   * customiser used to open while the player stood at the ship's stern
   * looking at a grey wall. */
  camera: engine.camera, scene: engine.scene,
});

/* PILOTING - the mode that turns four separate worlds into one loop.
 *
 * Constructed here, after `ships` and before the save, because it owns state
 * the save round-trips (which hull, where it is parked, what is in the hold)
 * and it reads liveries and upgrade tiers off the registry above.
 *
 * It is a MODE and not a world: it takes the player's body the way
 * `MountManager` does and hands it back the same way, and it survives a world
 * change instead of being cleared by one - because it is HOW the world
 * changes. See the header of ships/Piloting.js. */
const piloting = new Piloting({
  scene: engine.scene,
  engine,
  physics,
  bus,
  input,
  player,
  camera: engine.camera,
  cameraRig,
  avatar,
  worldManager,
  ships,
  economy,
  mounts,
  portals,
});
/* The cockpit readout. Its own overlay rather than five more branches in
 * `HUD.js`, and its own file so the nav list - the row that makes stranding
 * impossible - is somewhere a reader can find it. */
/* SHIP-TO-SHIP. Constructed after `piloting`, because it writes that mode's
 * `interdicted` flag and reads its flight state every step, and after `ships`,
 * because the shield pool and the gun's damage are both derived from the
 * upgrade tiers the registry owns. It arms off `world.encounters`, so it is
 * inert in every world that does not publish any - which is all of them but
 * `space`. */
const spaceCombat = new SpaceCombat({
  scene: engine.scene,
  camera: engine.camera,
  bus,
  input,
  player,
  worldManager,
  piloting,
  ships,
  economy,
});
const flightHUD = new FlightHUD({ root: uiRoot, bus, piloting, combat: spaceCombat });
/* The consumer `world.mineralNodes` has been waiting for. Ore goes into the
 * SHIP, not the bag, and pays nothing until it is sold at the yard - which is
 * what makes the flight home part of the loop rather than optional. */
const mining = new Mining({ bus, player, input, worldManager, piloting });

// Ammunition now comes out of the bag rather than a private per-weapon counter.
loadout.setInventory?.(inventory);

// Reasons to dive, to fly and to come back. Caches place themselves by terrain
// query on every world change and hand the reward to Loot, so there is no
// authored data and nothing to keep in sync when a world regenerates.
const caches = new Caches({ bus, physics, player, loot, worldManager, waterVolumes });

// Hidden collectibles that pay on pickup - the reason to look at the skyline.
// `cosmetics` and `mounts` ride along for the set prize: a quest can only pay
// credits, and a thirty-relic sweep should end in something credits cannot buy.
const relics = new Relics({
  scene: engine.scene, bus, physics, player, economy, inventory, cosmetics, mounts, worldManager,
});

/* Viewpoint synchronisation - the consumer `world.viewpoints` never had.
 *
 * Arms itself off `world:changed` exactly as the race and minigame managers do,
 * so a world that publishes the array gets the loop and one that does not costs
 * a failed property read. It owns the relic-map reveal (`reveals(x, z)`, asked
 * by `Minimap`) and the fast-travel anchor list the pause hub draws its Travel
 * rows from. */
const viewpoints = new Viewpoints({
  bus, player, economy, inventory, cosmetics, mounts, worldManager,
});
/* The yard's `nav_chart` is the one bag item whose effect is a viewpoint, and
 * `ItemUseSystem` is constructed a hundred lines above this because the
 * marketplace needs it. Handed over here rather than by re-ordering the two:
 * `Viewpoints` reads `player` and `inventory`, and moving IT up would only
 * move the same knot. `ItemUse._canApply` treats a null `viewpoints` as
 * "cannot chart", so the wire being absent refuses the use instead of eating
 * the chart. */
itemUse.viewpoints = viewpoints;

/* THE THREE THINGS THE PLAYER ASKED FOR, COUNTED.
 *
 * "so i have a few objectives, kill spacealiens, reach planets, mine for rare
 * elements". All three were already verbs - `SpaceCombat` kills, `Piloting`
 * lands, `Mining` cuts - and none of them was counted, paid, persisted or
 * shown. This is the consumer, and it consumes only what those three already
 * emit: `combat:kill`, `combat:cleared`, `pilot:entry`, `pilot:landed` and
 * `mining:node`. Not one line of any of them changed to make it work.
 *
 * Constructed after `piloting` because the survey sweep reads the ship's
 * position out of the flight integrator, and after `ships` because two of its
 * milestones pay a hull refit through `ShipRegistry.grantPower` - the same
 * purchase path the yard's spec board uses. */
const objectives = new SpaceObjectives({
  bus, economy, inventory, cosmetics, ships, piloting, worldManager,
});

// Enterable building interiors: doors, stairs, elevators and multi-floor
// collectibles. Constructed after Loot so its world:changed collectible spawn
// runs after Loot.clear() wipes the previous world's pickups.
const interiors = new Interiors({ bus, player, physics, loot, input, worldManager });

// Standing jobs from the people who already have names and personalities.
const contracts = new Contracts({ bus, npcManager, player, economy, inventory, worldManager });

// Backend quest system: tracks kill/collect/race steps automatically and
// syncs engagement state to the server. Opens via Quest Manager NPCs.
const questSystem = new QuestSystem({ bus, player, economy, worldManager, npcManager });
const questBoard  = new QuestBoard({ root: uiRoot, bus, input, questSystem });

const bugReport = new BugReport({ root: uiRoot, bus, input, player, worldManager });

// Typed cheat codes: "ammo" resupplies every weapon, "heal", "rich".
const cheats = new AdminCheats({ bus, input, loadout, player, economy });

// All sound is synthesised at runtime - see audio/AudioDirector.js for why
// there is not a single audio file in this project.
const audio = new AudioDirector({ bus, camera: engine.camera, player, worldManager, input, piloting });
const audioMenu = new AudioMenu({ root: uiRoot, bus, input, audio });

// Racing. The manager arms itself off `world:changed` by reading whatever the
// active world publishes (trackPath / startGrid / checkpoints / lapCount), so a
// world that carries a circuit needs no registration here and one that does not
// costs a failed property read per world change. The race world itself is
// registered with the other worlds above once it exists.
const race = new RaceManager({ ...ctx, player, mounts, economy, worldManager });
const raceUI = new RaceUI({ root: uiRoot, bus, input, race });

/* Minigames. Same arrangement as racing above and for the same reason: the
 * manager arms itself off `world:changed` by reading whatever the active world
 * publishes as `minigameVenues`, so a world that carries a venue needs no
 * registration here and one that does not costs a failed property read per
 * world change. Only the *games* are registered, once, because a game module is
 * code and cannot come from a world. A venue whose kind is not registered here
 * is skipped, which is what keeps the tennis and ski slots inert until their
 * modules exist. */
const minigames = new MinigameManager({ bus, player, economy, input, worldManager });
/* The closure lends the swim what its start placement and visible rival need:
 * the shared NPC humanoid factory (shader-warm), the mount authority (a ridden
 * board must be dismounted before the start-wall teleport can hold), and the
 * worldManager so the rival's body parents into the active world's group. */
minigames.registerGame('swim', (venue, ctx) =>
  createSwimChallenge(venue, { ...ctx, npcs: npcManager, mounts, worldManager, engine })
);
/* The ski factory needs the mount authority (it summons and returns the
 * hoverboard) which the manager deliberately does not know about, so it is
 * closed over here rather than added to the factory contract. `worldManager`
 * rides along so the gate poles can parent into the active world's group;
 * `npcs` and `engine` lend the rival ghost a shader-warm humanoid factory
 * and the frame hook that animates it. */
minigames.registerGame('ski', (venue, ctx) =>
  createSkiRun(venue, { ...ctx, mounts, worldManager, npcs: npcManager, engine })
);
/* The closure is the only place the tennis module learns about NPCs and the
 * frame loop; the manager itself hands over only player/bus/input. */
minigames.registerGame('tennis', (venue, ctx) =>
  createTennisMatch(venue, { ...ctx, npcs: npcManager, engine })
);
/* The closure lends the foot race what its start placement and visible field
 * need: the mount authority (a ridden board must be dismounted before the
 * start-line teleport can hold, and checkpoints refuse to count while
 * mounted), the shared NPC humanoid factory via npcs (shader-warm), the
 * worldManager so the three rival bodies parent into the active world's
 * group, and the engine for their frame-rate animation hook. */
minigames.registerGame('run', (venue, ctx) =>
  createTrackRace(venue, { ...ctx, mounts, worldManager, npcs: npcManager, engine })
);
/* Rooftop time trials. The closure lends the trial the shared NPC humanoid
 * factory (shader-warm) and the frame hook its rival's run cycle needs, the
 * worldManager so the checkpoint rings and the rival's body parent into the
 * active world's group rather than the scene root, and `save` so the HUD can
 * show a personal best that `SaveGame._recordTrial` already stores off
 * `minigame:finished`. `save` is declared below this line and read only when a
 * trial actually starts, which is long after module evaluation. */
minigames.registerGame('rooftop', (venue, ctx) =>
  createRooftopTrial(venue, { ...ctx, worldManager, npcs: npcManager, engine, save })
);
/* The yard's test-fire butts. The closure lends it `inventory`, which the
 * manager deliberately does not know about and which this contest genuinely
 * needs: the butts burn eight `laser_cell` to light the plates, and that is
 * the only thing in this drop that consumes one. `worldManager` rides along so
 * the plate lamps parent into the active world's group rather than the scene
 * root - a lamp left on the root survives a world change and hangs in the next
 * world at the same coordinates. No NPC factory and no frame hook: there is no
 * rival here, only the clock. */
minigames.registerGame('test_fire', (venue, ctx) =>
  createTestFire(venue, { ...ctx, inventory, worldManager })
);
const minigameUI = new MinigameUI({ root: uiRoot, bus, input, minigames });
/* The fourth and fifth late-pose modules, run as one pass. Assigned onto the
 * player rather than built by it, because the poses need the minigame manager
 * and Player must not know that system exists - see `Player._installLatePose`. */
const minigamePose = new MinigamePose({ player, minigames });
const tennisPose = new TennisPose({ player, minigames });
player.minigamePose = {
  applyPose(dt, elapsed) {
    minigamePose.applyPose(dt, elapsed);
    // Tennis last: mid-stroke, the swing must win over the generic poses.
    tennisPose.applyPose(dt, elapsed);
  },
};

const save = new SaveGame({
  bus, player, worldManager, economy, loadout, mounts, input, inventory, cosmetics,
  // The world-local progress layer. Absent from the snapshot until now, so
  // 3,600 CR of relics and every synchronised viewpoint reset on each reload.
  relics, viewpoints,
  // Hull liveries and tiers. World-local, and restored with the rest of that
  // layer after the world is live - a livery written before the yard is built
  // is a write into a hull that does not exist yet.
  ships,
  /* Where the ship is, what is in its hold, and whether the player was in the
   * seat when they quit. Without this, quitting mid-flight is a player who
   * reloads standing in a hangar with their ore gone. */
  piloting,
  /* Which seams are already worked out. There are 110 nodes on Cinder and they
   * do not come back; a finite collectible that resets is not finite, which is
   * the note `relics` and `viewpoints` are already here for. */
  mining,
  /* Hostiles killed by class, wings broken, bodies reached, elements assayed.
   * The one ledger here that is a CAREER rather than a world, and the one that
   * keys every column by identity - see the note in `SpaceObjectives`. */
  objectives,
});
/* Ask the browser not to evict this origin's storage under pressure. Fire and
 * forget - it resolves to false on browsers that do not offer it, and nothing
 * downstream depends on the answer. */
save.requestDurableStorage();
let persistTimer = null;
/* Debounced background persist.
 *
 * `save.autoSave`, never `save.save`. Everything that reaches this function is
 * an EVENT - a balance changing, an inventory changing, a merchant trade - and
 * not one of them is the player asking to save. `save()` skips the `_started`
 * and `_loading` guards and arms the autosave on its way past; `autoSave()`
 * honours them.
 *
 * That distinction is not academic. `hydrateAccountSession` applies the
 * server's balance at boot, which emits `credits:changed`, which lands here
 * while the player is still on the title screen with nothing loaded. Through
 * `save()` that wrote a pristine spawn state over the save CONTINUE was about
 * to read - every returning signed-in player, every boot. */
const schedulePersist = (reason) => {
  if (persistTimer) clearTimeout(persistTimer);
  persistTimer = setTimeout(() => {
    persistTimer = null;
    save.autoSave(reason);
    scheduleRemotePersist(reason);
  }, 750);
};

/* --- Backend persistence -------------------------------------------------
 * When the player is signed in, credits and inventory are mirrored to the
 * account database so progress survives across devices and the admin panel
 * reflects in-game spending. localStorage stays the fast local path; this is
 * the durable one. Merchant trades are batched and flushed with the state so
 * the admin purchase history shows in-game buys/sells too. */
let accountActive = false;
/** The account payload from boot, kept for the post-load arbitration. */
let accountState = null;
let remoteTimer = null;
let remoteInFlight = false;
let remoteDirty = false;
const pendingTrades = [];

function buildRemotePayload() {
  const payload = {
    // No `credits` field. The balance is the server's, moved only by
    // /api/game/credits; this route used to accept whatever number was put here
    // and write it straight to the account.
    state: {
      v: 1,
      at: Date.now(),
      inventory: inventory?.serialize?.() ?? null,
      mounts: mounts?.serialize?.() ?? null,
      cosmetics: cosmetics?.serialize?.() ?? null,
      /* Last-write-wins state, arbitrated by `at` above.
       *
       * These two are the only progress that is NOT monotone, which is why they
       * ride in this blob instead of the merge ledger. A ship has one position
       * and a body has one appearance; there is no union of two of them, so the
       * newer one has to win and a timestamp is unavoidable. Everything that
       * CAN merge does, in /api/game/progress, where no clock is consulted. */
      piloting: piloting?.serialize?.() ?? null,
      character: avatar?.characterConfig ?? null,
    },
  };
  if (pendingTrades.length) payload.trades = pendingTrades.splice(0, pendingTrades.length);
  return payload;
}

async function pushRemoteState() {
  if (!accountActive) return;
  if (remoteInFlight) { remoteDirty = true; return; }
  remoteInFlight = true;
  const payload = buildRemotePayload();
  try {
    const res = await fetch('/api/game/state', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
  } catch (err) {
    // Put unrecorded trades back so the next flush retries them.
    if (payload.trades?.length) pendingTrades.unshift(...payload.trades);
    console.warn('[account] state sync failed:', err?.message ?? err);
  } finally {
    remoteInFlight = false;
    if (remoteDirty) { remoteDirty = false; scheduleRemotePersist('retry'); }
  }
}

/**
 * Cross-device progress: push what this device found, adopt the merged answer.
 *
 * Separate from `/api/game/state` on purpose. That route keeps one opaque blob
 * and can only hold whichever copy arrived last, which is how a phone and a PC
 * each holding half a world's relics ends with one half deleted. `/api/game/
 * progress` merges instead - union for sets, best-of for numbers - so neither
 * device can lose the other's work and the order they sync in cannot matter.
 *
 * Called once, after the local load and before `game:started`. Failure is not
 * retried: everything it carries is monotone, so the next boot sends the same
 * facts and nothing is lost by missing one.
 *
 * NOTE, deliberate and worth knowing: this runs for a NEW GAME too, not only a
 * CONTINUE. That is what makes a fresh install on a second device recover the
 * account's relics and best times - the whole point of the phase. The
 * consequence is that "New Game" resets this device's world, position and
 * inventory but does NOT erase account-wide discovery, because the ledger never
 * subtracts. A true reset is an account-level action and is not built yet.
 */
/**
 * Settle the one genuine conflict: two copies of state that cannot merge.
 *
 * `hydrateAccountSession` applies the account's inventory, mounts and cosmetics
 * at boot, and then CONTINUE runs `save.load()`, whose restore steps write the
 * local copy straight over them. localStorage therefore won every time, silently
 * and regardless of which device was actually used last -- so playing on a phone
 * and coming back to a PC meant the PC's stale copy overwrote the phone's
 * afternoon and then pushed itself up as the new truth.
 *
 * Neither copy is "right" here. Inventory goes down as well as up, a ship has
 * one position, a body has one appearance: there is no union to take, so the
 * newer one wins and a timestamp is the only honest tie-break. That is why this
 * is a small function and the merge ledger is a large one - everything that
 * COULD merge already did, upstream, without consulting a clock.
 *
 * Runs after the load, so it sees the local save's real timestamp rather than
 * the pristine boot state's.
 */
function adoptRemoteIfNewer() {
  if (!accountActive || !accountState) return;
  const remote = accountState.game_state;
  const remoteAt = Number(remote?.at);
  if (!Number.isFinite(remoteAt)) return;

  const localAt = Number(save.savedAt?.()) || 0;
  if (remoteAt <= localAt) return;   // this device is the fresher one; the push carries it up

  const apply = (label, value, fn) => {
    if (!value || typeof fn !== 'function') return;
    try { fn(value); } catch (err) {
      console.warn(`[account] could not adopt server ${label}:`, err?.message ?? err);
    }
  };
  apply('inventory', remote.inventory, (v) => inventory.deserialize(v));
  apply('mounts', remote.mounts, (v) => mounts.deserialize(v));
  apply('cosmetics', remote.cosmetics, (v) => cosmetics.deserialize(v));
  apply('piloting', remote.piloting, (v) => piloting.deserialize(v));
  apply('character', remote.character, (v) => avatar.setCharacterConfig(v));

  console.info(`[account] adopted the server copy (${new Date(remoteAt).toISOString()}`
    + `, newer than this device's ${localAt ? new Date(localAt).toISOString() : 'no save'})`);
}

async function syncAccountProgress() {
  if (!accountActive) return;
  const res = await syncProgress({
    relics,
    viewpoints,
    mining,
    objectives,
    trials: { read: () => save.trialLedger(), merge: (best) => save.mergeTrials(best) },
  });
  if (res.ok && (res.applied || res.changed)) {
    console.info(`[progress] merged: ${res.changed} new on the server, ${res.applied} systems updated`);
  }
}

function scheduleRemotePersist() {
  if (!accountActive) return;
  if (remoteTimer) clearTimeout(remoteTimer);
  remoteTimer = setTimeout(() => {
    remoteTimer = null;
    pushRemoteState();
  }, 1500);
}

// Tab close / navigation: flush synchronously via sendBeacon, which survives
// page teardown where fetch does not.
window.addEventListener('pagehide', () => {
  if (!accountActive) return;
  try {
    const blob = new Blob([JSON.stringify(buildRemotePayload())], { type: 'application/json' });
    navigator.sendBeacon?.('/api/game/state', blob);
    // Earnings from the last few seconds, which would otherwise be lost with the
    // tab. The queue is NOT cleared -- sendBeacon cannot confirm delivery, so the
    // next boot re-sends and the server refuses whatever already landed.
    creditReporter.beacon();
  } catch { /* best effort */ }
});

const hud = new HUD({
  ...ctx, root: uiRoot, player, worldManager, npcManager, portals, caches, contracts, questBoard,
  // Straight through to `Minimap`, which had no relic layer at all, plus the
  // reveal authority that decides which of those relics a player can see yet.
  relics, viewpoints,
});

/* The Esc pause hub.
 *
 * Items are data because this is the only file that holds every panel; the HUD
 * owns the card, the keyboard and the return path and knows none of these
 * names. `keepOpen` items act in place and the hub stays up; everything else
 * goes through `hud.openFromHub`, which hides the hub, opens the panel and
 * brings the hub back when that panel closes. Ids are pinned by
 * `PAUSE_MENU_IDS` and checked against this list by a source test - a silently
 * missing row is invisible at runtime, because a menu with one fewer item still
 * works perfectly. */
hud.setPauseMenuItems([
  {
    title: 'Play',
    items: [
      /* `keepOpen` so it never goes through `openFromHub`: that would arm
       * `_hubReturn`, and the post-run check would find the Set still empty a
       * microtask later and put the hub straight back on. Resume is an act-in-
       * place item whose run happens to hide the card, and `hud.resume()` takes
       * the pointer lock back for real. */
      { id: 'resume', label: 'Resume', hint: 'Esc', keepOpen: true, run: () => hud.resume() },
      { id: 'character', label: 'Character', run: () => characterMenu.open() },
      {
        id: 'mount',
        label: 'Customise mount',
        // The panel refuses on foot and toasts; saying so up front is kinder.
        enabled: () => (mounts?.mounted ? true : 'Mount up first (M)'),
        run: () => mountMenu.open(),
      },
      {
        id: 'ship',
        label: 'Customise ship',
        /* Gated on the WORLD rather than on the player, which is the whole
         * difference from the mount row above: a mount is ridden and a hull is
         * selected, so the question is "is there a cradle here" and not "what
         * am I sitting on". */
        enabled: () => (ships?.canCustomise ? true : 'No hull on a cradle here'),
        run: () => shipMenu.open(),
      },
      /* `Inventory.open()` is synchronous ONLY once its panel exists. On the
       * very first call it kicks off a dynamic `import('../ui/InventoryUI.js')`
       * and returns (`Inventory.js:392-401` → `_mountUI` `:516-537`); the
       * `inventory:open` event then lands a promise tick later, well after
       * `_deferHubCheck`'s single microtask has already decided nothing opened
       * and put the hub back. That window is unreachable in practice - the
       * constructor calls `_mountUI()` eagerly at `Inventory.js:75`, long
       * before the player can click to enter, let alone press Esc. If the
       * eager mount is ever removed, this item needs `keepOpen: true` and its
       * own hide, or `openFromHub` needs an async-aware check. */
      { id: 'inventory', label: 'Inventory', hint: 'I', run: () => inventory.open() },
      { id: 'quests', label: 'Quest board', hint: 'J', run: () => questSystem.openBoard() },
      /* Fast travel to the viewpoints already synchronised.
       *
       * A fixed block of `visible()`-gated rows rather than a submenu: the hub
       * is built once at boot and re-reads every predicate on each open (see
       * `HUD.showPauseOverlay`), so gated rows ARE a live list and the hub
       * needs to know nothing about `Viewpoints`. They sit inside the Play
       * group on purpose - a group of their own would render its heading in
       * the four worlds that publish no viewpoints, with nothing beneath it. */
      ...viewpoints.hubItems(),
      {
        id: 'map',
        label: 'Map',
        // M is the mount wheel everywhere else; `mapActionOwner` is the same
        // test MazeMap and MountWheel use to decide which of them owns the key.
        visible: () => mapActionOwner(worldManager.active) === 'map',
        run: () => mazeMap.open(),
      },
      {
        id: 'race',
        label: () => (race?.racing ? 'Quit race' : 'Race panel'),
        // Mid-race there is nothing to set up - START is a no-op while racing -
        // so the row raises RaceUI's stop sheet instead of the dead picker.
        hint: () => (race?.racing ? 'Stop this race' : ''),
        visible: () => !!(race?.ready || race?.racing),
        run: () => (race?.racing ? bus.emit('race:quitRequest', {}) : raceUI.openPanel()),
      },
      {
        id: 'minigame-quit',
        label: 'Quit minigame',
        visible: () => !!minigames?.running,
        // Never a single keypress: the manager will not act on this itself,
        // MinigameUI raises its confirm sheet.
        run: () => bus.emit('minigame:quitRequest', {}),
      },
    ],
  },
  {
    title: 'System',
    items: [
      {
        id: 'help',
        label: 'Help & controls',
        hint: 'F1',
        // Help keeps pointer lock and sits OVER the hub (z 80 vs 60); closing
        // it reveals the hub again, so the hub must not hide for it.
        overlay: false,
        run: () => helpMenu.open(),
      },
      { id: 'audio', label: 'Audio', run: () => audioMenu.open() },
      { id: 'keybinds', label: 'Rebind keys', run: () => keybindMenu.open() },
      {
        id: 'fullscreen',
        // The PREFERENCE, not a live readout: `requestFullscreen` resolves
        // asynchronously and a browser-driven exit does not change what the
        // player asked for. The hint's first sentence says so.
        label: () => `Fullscreen: ${input.fullscreenPreferred ? 'On' : 'Off'}`,
        hint: 'Applies when you resume. Off gives Ctrl+W back to the browser; the save prompt still guards it',
        keepOpen: true,
        run: () => {
          const on = !input.fullscreenPreferred;
          input.fullscreenPreferred = on;
          try {
            if (on) document.documentElement.requestFullscreen?.()?.catch?.(() => {});
            else if (document.fullscreenElement) document.exitFullscreen?.()?.catch?.(() => {});
          } catch { /* refused; the preference still stands for the next resume */ }
        },
      },
      {
        /* The only UI the quality tiers have ever had. `PostFX.setQuality()`
         * has existed for as long as the post chain and was reachable from
         * nothing at all - no menu, no key, no query parameter - so a player on
         * a phone had 4x MSAA, GTAO, bloom, shafts and SMAA and no way to reach
         * any of it. One `keepOpen` row, cycling, because a submenu for four
         * values is a panel and this is a setting.
         *
         * The hint is honest about the half of a tier that cannot move: MSAA is
         * a property of the composer's render target and the shadow map's size
         * is baked in when the rig is built, so both wait for a reload. */
        id: 'graphics',
        label: () => `Graphics: ${TIERS[qualityTier.id]?.label ?? qualityTier.id}`,
        hint: 'Effects and resolution apply now; anti-aliasing and shadow detail on reload',
        keepOpen: true,
        run: () => {
          const next = TIER_IDS[(TIER_IDS.indexOf(qualityTier.id) + 1) % TIER_IDS.length];
          setQualityTier(next);
          hud?.notify?.(`Graphics: ${TIERS[next].label}`, 'info');
        },
      },
      {
        id: 'diagnostics',
        label: () => `Diagnostics: ${CONFIG.debug.showStats ? 'On' : 'Off'}`,
        keepOpen: true,
        run: () => {
          CONFIG.debug.showStats = !CONFIG.debug.showStats;
          hud.setDebugVisible(CONFIG.debug.showStats);
        },
      },
      {
        id: 'save',
        label: 'Save',
        hint: 'Writes local storage and a backup file',
        keepOpen: true,
        run: () => {
          // Before the write: the toast reads this to tell a deliberate save
          // from a background autosave.
          hud.expectSave();
          save.saveAndBackup('menu');
        },
      },
      {
        id: 'load',
        label: 'Load',
        hint: 'Local save, or pick a backup file',
        // May summon a mount and move the player; the hub stays and refreshes.
        keepOpen: true,
        run: () => save.loadAnywhere(),
      },
      { id: 'bug-report', label: 'Report a bug', run: () => bugReport.open() },
      {
        id: 'quit',
        label: 'Quit to menu',
        hint: 'Back to the landing page',
        // The game runs at /play, so the site root is one level up.
        run: () => {
          /* The player chose to leave; do not also ask "leave site?". That
           * prompt is the Ctrl+W backstop (SaveGame.js:125-146) and firing it
           * on a menu item reads as the game refusing to quit. The unload
           * autosave still runs. */
          save.suppressUnloadPrompt();
          window.location.href = `${window.location.origin}/`;
        },
      },
    ],
  },
]);

// Late injection breaks what would otherwise be a circular import between the
// world manager and the systems it has to drive on every world change.
worldManager.attach?.({ npcManager, portals, player });

// Parkour reads `world.haystacks` to know a fall is survivable, and the world
// manager is built after the player, so it is handed over here.
player.parkour.worldManager = worldManager;

/* The automated screenshot/critique harness and every debugging session need a
 * handle on the live systems - but this was published unconditionally, on every
 * build, to every player. `GAME.economy` is right there, so awarding yourself a
 * million credits was a single line in the console with no tools and no
 * knowledge of the codebase at all.
 *
 * It is behind `?dev=1` now. That is worth being precise about: it is not a
 * security boundary, because anyone who wants the handle can simply add the
 * parameter. What it does is stop the game handing its own internals to
 * everybody who ever opens devtools for an unrelated reason - which, in a game
 * with no server, is as far as this can honestly be taken. See the note on
 * INTEGRITY_SALT in SaveGame.js for the same argument at more length. */
if (overrides.dev) {
  window.GAME = {
    engine, input, physics, materials, worldManager, player, npcManager, portals, combat, hud, bus, THREE, CONFIG,
    cameraRig, avatar, loadout, projectiles, economy, mounts, unstuck, save, lightRig,
    /* The reporter that makes the SERVER own the balance. Exposed because the
     * only way to check a credit source still pays is to play and look at what
     * it queued -- a unit test proves the endpoint, never the loop. */
    creditReporter,
    waterVolumes, stamina, inventory, loot, itemUse, market, cosmetics, helpMenu, characterMenu, mountMenu, caches, contracts,
  cheats, audio, audioMenu, relics, viewpoints, mountWheel, race, raceUI, keybindMenu, questSystem, questBoard, bugReport,
  ships, shipMenu, piloting, spaceCombat, flightHUD, mining, objectives,
  interiors, mazeMap, minigames, minigameUI,
    /* The only door out of this file the harness is allowed through. Kept
     * behind `__dev` rather than spread across GAME so it is obvious at a call
     * site that a measurement is reaching into the integration layer. */
    __dev: {
      /** @see setDevGameplayDriven - runs gameplay without a pointer lock. */
      setGameplayDriven: (on) => setDevGameplayDriven(on),
      isGameplayDriven: () => devGameplayDriven,
      /** Everything currently holding the gameplay update block open. */
      gameplayBlocks: () => [...gameplayUiBlocks],
      /** The one live shadow-casting light, for the frame-cost model in stats(). */
      sun,
    },
  };
  import('./dev/Harness.js').then(({ installHarness }) => installHarness(window.GAME));
}

/* ------------------------------------------------------------------ */
/* Boot sequence                                                       */
/* ------------------------------------------------------------------ */

const loader = createLoadingScreen(uiRoot, {
  /* A human-readable stamp for the card, or null when there is nothing to
   * offer. `SaveGame.savedAt` reads the same validated payload `hasSave`
   * does, so a corrupt save offers nothing rather than offering a crash. */
  savedAt: () => {
    const at = save.savedAt();
    if (!at) return null;
    const mins = Math.max(0, Math.round((Date.now() - at) / 60000));
    if (mins < 1) return 'moments ago';
    if (mins < 60) return `${mins} min ago`;
    const hrs = Math.round(mins / 60);
    if (hrs < 24) return `${hrs} hour${hrs === 1 ? '' : 's'} ago`;
    return new Date(at).toLocaleDateString();
  },
  resume: () => save.load(),
  /* Explicit and immediate. A "new game" that leaves the old save in place is
   * the overwrite defect again, delayed by one autosave tick. */
  discard: () => save.clear(),
});
const accountStatePromise = fetch('/api/game/session', { cache: 'no-store' })
  .then(async (res) => {
    if (!res.ok) return null;
    return res.json();
  })
  .catch((err) => {
    console.warn('[account] could not load game session:', err);
    return null;
  });

async function hydrateAccountSession() {
  const account = await accountStatePromise;
  if (!account) return;
  accountActive = true;
  accountState = account;

  if (typeof account.credits === 'number') {
    economy.set(account.credits, 'account-sync');
  }

  /* Only now: the balance above is the server's opening answer, and starting
   * before it landed would report the local number as if it were fresh earnings.
   * `start()` also flushes anything a previous session queued and could not
   * deliver -- a closed tab or a dropped connection, replayed safely because
   * every queued event carries its original idempotency key. */
  creditReporter.start();

  // Server-saved inventory takes precedence over whatever the fresh boot
  // seeded - it is the durable copy of what the player actually owns.
  const remoteInv = account.game_state?.inventory;
  if (remoteInv && inventory?.deserialize) {
    try {
      inventory.deserialize(remoteInv);
    } catch (err) {
      console.warn('[account] could not restore server inventory:', err?.message ?? err);
    }
  }

  // Mount livery + purchased powers ride along with the account so a bought
  // upgrade or a chosen colour survives a reload on any device.
  const remoteMounts = account.game_state?.mounts;
  if (remoteMounts && mounts?.deserialize) {
    try {
      mounts.deserialize(remoteMounts);
    } catch (err) {
      console.warn('[account] could not restore server mounts:', err?.message ?? err);
    }
  }

  // Purchased cosmetic skins are account-bound the same way: a limited-edition
  // unlock the player paid for must reappear on any device they sign in from.
  const remoteCosmetics = account.game_state?.cosmetics;
  if (remoteCosmetics && cosmetics?.deserialize) {
    try {
      cosmetics.deserialize(remoteCosmetics);
    } catch (err) {
      console.warn('[account] could not restore server cosmetics:', err?.message ?? err);
    }
  }

  if (typeof account.handle === 'string' && account.handle.trim()) {
    bus.emit('player:identity', { handle: account.handle.trim() });
  }
}

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
    await hydrateAccountSession();

    /* --- The title card goes up *before* the shader warm, not after ------
     *
     * Shader compilation is by a long way the most expensive thing in the
     * boot - 118 s of a 127 s cold start, measured - and none of it is needed
     * to draw a title card. Putting the card up first turns "four minutes of
     * a progress bar stuck at 92%" into "the menu appears, and finishes
     * preparing while you read it".
     *
     * The warm itself blocks - `prewarm` uses the synchronous `compile()`, for
     * the reason documented on that function - so the card is painted *before*
     * it starts rather than staying animated during it. That is the whole point
     * of the ordering: the player gets something to read and a working start
     * prompt while the driver links, instead of a frozen progress bar.
     *
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
 * We deliberately use `compile()` here instead of `compileAsync()`. Some
 * browser/driver stacks can throw uncaught errors from compileAsync's internal
 * readiness polling (seen as `currentProgram.isReady` on undefined), which can
 * abort boot even though warmup is optional.
 */
async function prewarm() {
  const t0 = performance.now();
  loader.setWarming('Preparing shaders');
  let parked = [];
  try {
    // Every mount, or the first summon of the one left out pays for its
    // geometry and its shader programs on the spot - which is the stall this
    // whole prewarm exists to prevent.
    parked = mounts.prebuild?.(['hoverboard', 'dragon', 'car', 'horse', 'eagle', 'bicycle']) ?? [];
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
    engine.renderer.compile(engine.scene, engine.camera);
  } catch (err) {
    console.warn('[prewarm] compile failed, falling back to lazy compile:', err);
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

  // Everything above compiles the *material graph*. What is left needs the
  // objects actually drawn in the state the player will meet them in - see the
  // header on `rehearse`.
  try {
    await rehearse();
  } catch (err) {
    console.warn('[rehearse] failed, first-use costs stay with the player:', err);
  }

  try {
    for (const root of parked) root.visible = false;
    // Do NOT call setVisible(false) here. The prewarm used setVisible(true) to
    // ensure the avatar's materials compiled their shadow-pass programs. Now that
    // warmup is done, the avatar stays visible so update() can run each frame and
    // call _setShadowOnly(true/false) based on camera mode. Calling setVisible(false)
    // sets _visible=false, which short-circuits update() entirely - meaning
    // _setShadowOnly is never called when switching to 3rd person.
    // First-person invisibility is handled by _setShadowOnly(true) in PlayerAvatar.
    mounts.unpark?.(parked);
  } catch (err) {
    console.warn('[prewarm] restore failed:', err);
  }

  /* Nothing warms the interface here, and that is deliberate rather than an
   * oversight. The HUD does have a first-paint cost that is not shaders, and a
   * compositor rehearsal to pay it behind the loading card was built and
   * measured; it did not work. The reason it cannot, and the numbers, are in
   * scripts/tests/hud-composite-cost.test.mjs. */

  console.info(
    `[prewarm] shader warmup took ${Math.round(performance.now() - t0)}ms, ` +
    `${engine.renderer.info.programs.length} programs`
  );
}

/**
 * Play the first few minutes of the game, invisibly, behind the loading screen.
 *
 * ── What this fixes ────────────────────────────────────────────────────────
 * The player's report was "loading mounts or doing much of anything first time
 * is slow, after a while of use the speed is better". Measured on a cold GPU
 * program cache, with everything above this already done, that was:
 *
 *     summon the dragon        4 programs   4.1 s
 *     fire each weapon         3 programs   3.2 s
 *     summon the hoverboard    2 programs   2.6 s
 *     summon the car           2 programs   1.7 s
 *     first rare loot drop     5 programs   1.7 s
 *     switch through weapons   3 programs   1.0 s
 *     summon the bicycle       1 program    1.0 s
 *                                          ~15 s
 *
 * Every other first-use action measured - opening any panel, entering a
 * building, meeting a hostile, killing one, mounting the horse or the eagle,
 * flying - linked nothing at all. That list is what this function reproduces,
 * and nothing more: it is a ranking, not a guess.
 *
 * ── Why `compile()` was not enough, in one sentence per reason ─────────────
 *   1. `compile` collects materials from `object.material`. A loot accent that
 *      is never attached to a pickup, a mount that is built but never
 *      `spawn()`ed, a weapon part that is only added when drawn - none of them
 *      are on anything, so none of them are seen.
 *   2. `compile` issues `linkProgram` but reads no result. Three checks the
 *      link status on a program's first *use*, which is where the stall
 *      actually lands, so the program must also be drawn.
 *   3. A transparent `DoubleSide` material is *two* programs, not one - three
 *      draws it once per face winding. That is why `loot.beam.trinket`,
 *      `sword.trail` and `dragon.membrane` each linked twice from one material,
 *      and why chasing "unreferenced materials" never explained it.
 *
 * ── What it must not do ────────────────────────────────────────────────────
 * Leave anything behind. Mounts are spawned but never *mounted*, so the player
 * is never seated, moved, or swung into third person; loot is posed from the
 * pool and never enters `_active`, so nothing is dropped and nothing is
 * awarded; the HUD is silenced so the six mounts it would announce do not greet
 * the player as toasts for things that never happened. Everything is restored
 * in reverse, and the program/collider/child counts are logged either side so a
 * leak shows up as a number rather than as a bug report.
 */
async function rehearse() {
  const r = engine.renderer;
  const t0 = performance.now();
  const p0 = r.info.programs.length;
  /** State that must come out exactly as it went in. */
  const state = () => ({
    children: engine.scene.children.length,
    colliders: physics.colliders?.length ?? 0,
    pickups: loot?.pickups?.length ?? 0,
    weapon: loadout.current?.id ?? null,
    mounted: mounts.active?.id ?? null,
    credits: economy?.credits ?? 0,
    px: player.position.x, py: player.position.y, pz: player.position.z,
  });
  const before = state();
  // Uploads, deliberately *not* part of the leak test. `info.memory` counts GPU
  // resources, and drawing a mesh for the first time uploads its buffers and
  // textures - which is a second first-use cost this rehearsal is paying on the
  // player's behalf, not something it failed to clean up.
  const g0 = r.info.memory.geometries;
  const x0 = r.info.memory.textures;

  hud?.setQuiet?.(true);
  /** @type {Array<() => void>} */
  const restore = [];
  /** @type {THREE.Object3D[]} */
  let mountRoots = [];
  /** Where each root was parented, so the teardown can put it back. */
  let mountParents = [];
  /* Scene children as they stood before any of this, so a root the rehearsal
   * itself introduces can be taken back out again.
   *
   * Only matters away from boot, and it is what `recoverFromContextLoss` made
   * matter. During boot `prewarm` has already parked every mount root in the
   * scene, so `warmSpawn` adds nothing and prewarm's own `unpark` removes them
   * a moment later. Post-boot they are unparented, `warmSpawn` adds all six,
   * nothing follows to take them out, and the leak counter below reported
   * exactly that on the first real context recovery: `children: 160->166`. */
  const sceneBefore = new Set(engine.scene.children);

  try {
    mountRoots = mounts.warmSpawn?.(player.position, player.yaw ?? 0) ?? [];
    mountParents = mountRoots.map((root) => root.parent);
  } catch (err) {
    console.warn('[rehearse] mount spawn failed:', err);
  }

  try {
    const undo = loot?.warmAccents?.(player.position);
    if (undo) restore.push(undo);
  } catch (err) {
    console.warn('[rehearse] loot accents failed:', err);
  }

  const viewRoots = [];
  try {
    for (const inst of loadout.instances ?? []) {
      inst.setVisible?.(true);
      if (inst.root) viewRoots.push(inst.root);
    }
  } catch (err) {
    console.warn('[rehearse] viewmodel show failed:', err);
  }

  /**
   * The active world, and every gateway, drawn un-culled.
   *
   * ── The stall this closes ──────────────────────────────────────────────────
   * Everything above rehearses the things the PLAYER carries. The world itself
   * was left to the three rehearsal frames' own view - one camera, one bearing,
   * from the spawn point - and `projectObject` drops anything outside that
   * frustum before it can link a program or upload a buffer. So the boot warm
   * finished at 494 programs and the world quietly held twelve more in reserve,
   * to be paid for whenever the player first looked at the geometry that needed
   * them. Frame-exact attribution of the residual stall: a 1,275 ms frame that
   * created +8 programs and +219 geometries, and a 354 ms frame that created +1
   * and +14. Walking the station's own review framings on a settled boot
   * reproduces exactly that twelve: +5 crossing the plaza from the deck edge,
   * +5 facing the sports gateway, +2 out over the apron. 494 -> 506.
   *
   * `forceDrawable` is the machinery that already exists for this - it clears
   * `visible` and `frustumCulled` and hands back an exact restore - so the fix
   * is to hand it the world group rather than to invent a camera sweep that
   * would have to guess which bearings matter. Un-culled means bearing stops
   * being a variable at all: one frame draws every mesh in the world, into the
   * shadow map and the AO prepass as well as the beauty pass, and the geometry
   * uploads land here instead of under the player's mouse - measured, this line
   * moved the rehearsal from `+257 geometries` to `+829`.
   *
   * Affordable because the station is merged: 1,414 objects and 1,093 meshes
   * for 3.4 M triangles, so an un-culled frame is about twice a normal one, and
   * there are three of them behind a loading screen that is already up.
   *
   * The gateway roots and the crowd are listed separately because they are
   * parented to the SCENE, not to the world group (see
   * `PortalSystem._buildPortal` and `NPCManager`), and both linked programs the
   * world group alone did not reach: two of the three framings that linked
   * something were looking straight at a gateway, and the last one standing
   * after the world group was added was a character's `Sprite` name sign -
   * `sprite,highp,srgb-linear,...`, a program shared by every signed NPC in
   * every world and paid for by whoever first walked past one.
   *
   * With all three lists in, the boot settles at 508 programs and the same tour
   * of all twenty-one framings links nothing at all: worst frame 49 ms, no
   * frame over 100 ms, no program created.
   */
  const worldRoots = [];
  try {
    const active = worldManager.active;
    if (active?.group) worldRoots.push(active.group);
    for (const p of portals.portals ?? []) if (p.root) worldRoots.push(p.root);
    for (const npc of npcManager.npcs ?? []) if (npc.root) worldRoots.push(npc.root);
  } catch (err) {
    console.warn('[rehearse] world roots unavailable:', err);
  }

  restore.push(forceDrawable([...mountRoots, ...viewRoots, ...worldRoots, loot?.group, avatar?.root]));

  for (let i = 0; i < 3; i++) {
    try {
      // Before every rehearsal frame, not just the first: `warmSpawn` and
      // `forceDrawable` between them can expose a light that was hidden (a
      // car's headlamps), and one such light reaching `projectObject` would
      // rebuild every program in the scene against a light count that never
      // occurs again.
      lightRig.update(1 / 60);
      if (engine.postfx) engine.postfx.render(1 / 60);
      else r.render(engine.scene, engine.camera);
    } catch { /* a rehearsal frame must never abort the boot */ }
    await nextFrame();
  }

  try {
    for (let i = restore.length - 1; i >= 0; i--) restore[i]();
    for (const inst of loadout.instances ?? []) inst.setVisible?.(false);
    if (before.weapon != null) loadout.current?.setVisible?.(true);
    // Kill every mount this rehearsal spawned - an alive-but-torn-down mount is
    // the exact hazard `unpark` documents, because `summon` only calls `spawn`
    // on a mount that is not already alive and would otherwise seat the player
    // on an invisible one at stale coordinates.
    mounts.unpark?.([]);
    // `kill()` unparents the root, so put it back where `prebuild` left it:
    // hidden, in the scene, waiting for prewarm's own `unpark` to remove it a
    // moment later. Without this the rehearsal would appear to eat six scene
    // children, and the leak test below would be crying wolf every boot.
    //
    // The ridden mount is the exception, and it only exists because this
    // function is no longer boot-only: `recoverFromContextLoss` runs it mid-game
    // (see there), where `unpark` already refuses to kill the active mount for
    // the same reason. Hiding one the player is sitting on would leave them
    // riding an invisible dragon for the rest of the session.
    const active = mounts.active?.root ?? mounts.active?.mesh ?? null;
    mountRoots.forEach((root, i) => {
      if (root !== active) root.visible = false;
      if (!root.parent && mountParents[i]) mountParents[i].add(root);
      // ...and out again if the rehearsal is what put it there. @see sceneBefore
      if (root !== active && root.parent === engine.scene && !sceneBefore.has(root)) {
        engine.scene.remove(root);
      }
    });
  } catch (err) {
    console.warn('[rehearse] restore failed:', err);
  } finally {
    hud?.setQuiet?.(false);
  }

  const after = state();
  const leaked = Object.keys(before).filter((k) => before[k] !== after[k]);
  console.info(
    `[rehearse] ${r.info.programs.length - p0} programs in ` +
    `${Math.round(performance.now() - t0)}ms, ` +
    `+${r.info.memory.geometries - g0} geometries +${r.info.memory.textures - x0} textures uploaded` +
    (leaked.length
      ? ` - LEAKED ${leaked.map((k) => `${k}: ${before[k]}->${after[k]}`).join(', ')}`
      : ' - state clean')
  );
}

/* ------------------------------------------------------------------ */
/* Losing the GPU, and getting it back                                 */
/* ------------------------------------------------------------------ */

/**
 * Re-run the boot warm after the browser hands back a restored WebGL context.
 *
 * ── The failure this closes ────────────────────────────────────────────────
 * Observed on a measurement run: `THREE.WebGLRenderer: Context Lost.`, preceded
 * by an 11.7 s frame carrying only 8.2 ms of engine CPU - a driver hang, not
 * anything this game did. The context came back 1.1 s later, and it came back
 * EMPTY: `renderer.info` had dropped 392 programs, 1,375 geometries and 265
 * textures. Nothing rebuilt any of it, so every program was linked - and every
 * buffer re-uploaded - on demand, inside gameplay frames, and the game ran at
 * about 1.3 fps for the remaining ELEVEN MINUTES. The trigger was
 * environmental; the eleven minutes were ours.
 *
 * ── Why this is four lines and not a system ────────────────────────────────
 * A restored context is, exactly, a cold boot's program cache with a warm CPU
 * side: the scene graph, the geometries and the textures are all still here as
 * JavaScript, and only their GPU copies are gone. That is the state `prewarm`
 * was written for, so the recovery is `prewarm`'s own two steps and nothing
 * else - `renderer.compile()` to issue the links, then `rehearse()` to DRAW
 * them, which is the half that waits on the link and therefore the half that
 * matters. @see ./gfx/RehearsalDraw.js for why compiling alone buys nothing.
 *
 * `prewarm()` itself is deliberately NOT called. Its first act is
 * `mounts.prebuild(...)`, which is a no-op on a session where every mount is
 * already built, and its last is an `unpark` of a list that would then be
 * empty; what is left in the middle is exactly the compile and the two frames
 * reproduced here. The per-weapon `loadout.select` walk is left out for the
 * same reason: `rehearse` shows every viewmodel at once and force-draws all of
 * them, so it covers that set without touching the player's current weapon.
 *
 * ── What is left to the background ─────────────────────────────────────────
 * The worlds the player is not standing in, and the gateway previews. Both have
 * their own sliced warms already (`warmWorld`, `warmPortalPreviews`), both are
 * paced against `idleSoon`, and neither is needed before play resumes - so they
 * run after, exactly as they do on a cold boot, rather than holding the player
 * on an overlay for them.
 *
 * Engine-side: `Engine._runRecovery` holds the frame loop's own render and the
 * simulation for the duration, and restores both afterwards. @see core/Engine.js
 */
async function recoverFromContextLoss() {
  const t0 = performance.now();
  const r = engine.renderer;
  const p0 = r.info.programs.length;
  const screen = createRecoveryScreen(uiRoot);
  try {
    // One frame with the overlay up before anything blocking: the whole point
    // of showing it is that the player sees it *during* the stall, not after.
    await nextFrame();

    try {
      r.compile(engine.scene, engine.camera);
    } catch (err) {
      console.warn('[recover] compile failed, falling back to lazy compile:', err);
    }

    // The same two frames `prewarm` runs, and for the same reason: they buy the
    // shadow-pass depth programs and the PostFX chain, neither of which
    // `compile` sees. `lightRig.update` first, every time - a stray light
    // reaching the renderer would re-key the entire program set.
    for (let i = 0; i < 2; i++) {
      try {
        lightRig.update(1 / 60);
        if (engine.postfx) engine.postfx.render(1 / 60);
        else r.render(engine.scene, engine.camera);
      } catch { /* a warm frame must never abort the recovery */ }
      await nextFrame();
    }

    screen.setStatus('Rebuilding shaders');
    await rehearse();
  } catch (err) {
    console.warn('[recover] re-warm failed, first-use costs stay with the player:', err);
  } finally {
    screen.remove();
  }

  console.info(
    `[recover] context re-warmed in ${Math.round(performance.now() - t0)}ms, ` +
    `+${r.info.programs.length - p0} programs (${r.info.programs.length} total)`
  );

  // Everything the player is not looking at, on the same idle chain a cold boot
  // uses. Deliberately not awaited: play resumes the moment this function
  // returns, and these slices are sized to be invisible inside a live frame.
  rewarmOtherWorlds();
}

/**
 * The destinations and their gateway previews, re-warmed in the background
 * after a context loss.
 *
 * Same chain as `scheduleBackgroundBuilds`, minus the build - the worlds are
 * still generated, it is only their GPU programs that went. The `holdPreviews`
 * claim is here for the identical reason it is there: `Portals.update` draws a
 * preview on any frame a gateway is ready, and that draw is the multi-second
 * freeze the sliced warm exists to prevent.
 */
function rewarmOtherWorlds() {
  const activeId = worldManager.active?.id ?? null;
  const rest = worldManager.ids.filter(
    (id) => id !== activeId && worldManager.isBuilt?.(id) && !worldManager.isVolatile(id),
  );
  let i = 0;
  const step = () => {
    if (i >= rest.length) return;
    const id = rest[i++];
    Promise.resolve()
      .then(() => portals.holdPreviews?.(id))
      .then(() => warmWorld(id))
      .then(() => warmPortalPreviews(id))
      .catch((err) => console.warn(`[recover] re-warm of "${id}" failed:`, err))
      .finally(() => {
        portals.releasePreviews?.(id);
        idle(step);
      });
  };
  idle(step);
}

/**
 * The overlay the recovery holds up. Deliberately the boot screen's own markup
 * and classes, so it needs no new CSS and reads as the same thing it is.
 *
 * @param {HTMLElement} root
 * @returns {{ setStatus: (t: string) => void, remove: () => void }}
 */
function createRecoveryScreen(root) {
  const el = document.createElement('div');
  el.className = 'boot-screen';
  el.innerHTML = `
    <div class="boot-inner">
      <div class="boot-logo">AETHER<span>NEXUS</span></div>
      <div class="boot-tagline">Graphics device restarted</div>
      <div class="boot-bar"><div class="boot-bar-fill" style="width:100%"></div></div>
      <div class="boot-status">Restoring graphics</div>
    </div>`;
  root.appendChild(el);
  const status = el.querySelector('.boot-status');
  return {
    setStatus(text) { if (status) status.textContent = text; },
    remove() {
      el.classList.add('boot-hide');
      setTimeout(() => el.remove(), 900);
    },
  };
}

/**
 * The background scheduler this boot uses, for the world builds and for the
 * time-sliced gateway preview warm they hand off to.
 *
 * The `timeout` is not optional in practice. A 126 fps render loop leaves so
 * little idle time that a plain `requestIdleCallback` was never firing at all:
 * measured, the other two worlds were still unbuilt 45 s after boot, so every
 * portal paid for generating its destination *and* compiling it on the spot.
 * With a deadline Chrome runs the callback regardless of idleness.
 *
 * It is also the *yield* the preview warm is sliced against: an idle callback
 * is a real task, run after the frame is presented, so a slice armed with one
 * genuinely gives the compositor a turn. A promise resolved in the same
 * microtask would not, and would measure exactly like the block it replaced.
 *
 * @param {(deadline: any) => void} fn
 * @param {number} timeoutMs how long to wait for genuine idle time before
 *   running anyway.
 */
function idleTask(fn, timeoutMs) {
  if (window.requestIdleCallback) return window.requestIdleCallback(fn, { timeout: timeoutMs });
  return setTimeout(() => fn({ timeRemaining: () => 8 }), Math.min(200, timeoutMs));
}

/** World generation: a handful of long, chunky steps. */
const idle = (fn) => idleTask(fn, 1500);

/**
 * Preview-warm slices: a couple of hundred short ones, so the deadline is a
 * frame rather than a second and a half.
 *
 * This is not a tuning nicety. A running game leaves no genuine idle time at
 * all, so every callback waits out its whole deadline - measured with the 1500
 * ms deadline above, one gateway's 48 slices took 78 s and the other three
 * gateways never finished inside the opening two minutes. A frame's deadline
 * drains the plan at frame rate and the yield is exactly as real.
 */
const idleSoon = (fn) => idleTask(fn, 24);

function scheduleBackgroundBuilds(startWorld) {
  const rest = worldManager.ids.filter(
    (id) => id !== startWorld && !worldManager.isVolatile(id),
  );
  let i = 0;
  const step = () => {
    if (i >= rest.length) {
      bus.emit('worlds:all-ready');
      return;
    }
    const id = rest[i++];
    worldManager
      .build(id)
      /* Claim this destination's gateways the instant its build resolves, and
       * before anything slow runs against it.
       *
       * `update()` sets `p.ready` from `wm.isBuilt(target)` every frame, and its
       * priming pass draws a preview on the very first frame a gateway is ready.
       * That draw is the multi-second freeze `warmPreviews` exists to prevent -
       * it links the destination's whole preview program set inside one
       * gameplay frame. Nothing used to stand between the two because
       * `warmWorld` was a single blocking `compile()` in the same task as the
       * build's resolution, so `warmPortalPreviews` had already set the flag
       * before any frame could run. Slicing `warmWorld` opened that window, and
       * the window is not small: measured, the priming pass landed in it and
       * cost a single frame of 8,212 ms and 14,741 ms across two cold boots,
       * +35 programs and +512 first-draw geometry uploads.
       *
       * So the claim is made here, where it cannot depend on how long anything
       * downstream takes, and released in a `finally` no matter what happens. */
      .then(() => portals.holdPreviews?.(id))
      .then(() => warmWorld(id))
      .then(() => warmPortalPreviews(id))
      .then(() => {
        bus.emit('world:ready', { id });
        idle(step);
      })
      .catch((err) => {
        console.error(`[boot] background build of "${id}" failed:`, err);
        idle(step);
      })
      // A gateway must never be left permanently showing STABILISING because
      // something upstream threw.
      .finally(() => portals.releasePreviews?.(id));
  };
  idle(step);
}

/**
 * How many novel program signatures one background precompile callback issues.
 *
 * The unit here is a *link*, not an object, and that is the opposite of the
 * gateway preview warm next door: there the compile is nearly free and the draw
 * is what waits, because a draw reads `LINK_STATUS`. A background world is
 * never drawn, so nothing in `warmWorld` ever waits on a link - what it pays
 * for is ANGLE translating GLSL to HLSL inside `glCompileShader`, which is
 * synchronous and measured at roughly 10 ms per new program on this driver. So
 * the slice size bounds the worst frame at about 40 ms, and most slices are
 * free: the station's plan is 256 units carrying 51 new programs, so five
 * slices in six compile nothing that does not already exist.
 *
 * It is also what the wall clock is traded against, and that is the reason not
 * to make it smaller. `idleSoon`'s deadline is a frame, and a running game
 * never goes genuinely idle, so every callback waits its deadline out: at two
 * units the five worlds cost 219 callbacks and about 5 s of extra background
 * settle, at four they cost 110 and about 2.5 s.
 */
const WORLD_WARM_UNITS_PER_COMPILE = 4;

/**
 * Compile a world's materials before the player ever portals into it.
 *
 * This is only possible - and only worth doing - because the light rig fixed
 * the program cache key. Previously each world carried its own lights, so the
 * key changed on arrival and anything compiled in advance was thrown away
 * unused; the portal then rebuilt the entire program set in one blocking frame,
 * measured at 83 s going from the station to the medieval world.
 *
 * `compile(group, camera, scene)` is the three-argument form: it collects
 * materials from `group` but resolves lights and shadows against the live
 * `scene`, so the programs it builds are keyed exactly as the ones the world
 * will ask for on arrival - without the group ever entering the scene graph or
 * rendering a frame.
 *
 * ── Why it is sliced ───────────────────────────────────────────────────────
 * This runs from `scheduleBackgroundBuilds`, which runs after `engine.start()`.
 * The player is standing in the entry world while it works, so every millisecond
 * it spends is a millisecond of dead main thread inside a gameplay frame - and
 * as one call per world it was a big number. Measured on a cold boot with
 * medieval as the entry world, standing still and touching nothing, the game
 * declared itself playable at 112.6 s with 345 programs and then linked its way
 * to 490 over the next 33 s, in frames of 396.7 ms and 553.4 ms. `dGeometries`
 * and `dTextures` were zero on every one of them: nothing was streaming, it was
 * purely this function.
 *
 * The fix is the same shape as the gateway preview warm's, and reuses the same
 * machinery - `planCompileWarm` enumerates one representative object per
 * distinct program signature, `runSliced` paces them against `idleSoon`, and
 * `compile()` traverses whatever it is handed, so handing it a single mesh
 * issues exactly that mesh's links.
 *
 * The plan is a dedupe, not a replacement: the run finishes with one `compile()`
 * over the whole group, which is what it always did and what guarantees the
 * coverage cannot shrink if the signature key ever under-splits. That call is
 * cheap by then - every program a planned unit needed already exists, so it is
 * a parameter walk and no shader translation at all.
 *
 * @param {string} id
 * @returns {Promise<void>}
 */
function warmWorld(id) {
  const world = worldManager.getWorld(id);
  if (!world?.group) return Promise.resolve();
  // Demote its lights first. A world arrives with dozens of its own, and
  // compile() collects lights with `traverseVisible` - one live light here and
  // every program it built would be keyed to counts that never occur.
  lightRig.claim(world.group);
  const group = world.group;
  const t0 = performance.now();
  const p0 = engine.renderer.info.programs.length;
  /** @type {Array<() => void>} Appended to by the planning step; see runSliced. */
  const steps = [];
  let slices = 0;

  // Planning walks the whole world group, so it gets a callback of its own
  // rather than sharing one with the first batch of links.
  steps.push(() => {
    const batches = chunkUnits(planCompileWarm(group), WORLD_WARM_UNITS_PER_COMPILE);
    slices = batches.length;
    for (const batch of batches) {
      steps.push(() => {
        for (const o of batch) engine.renderer.compile(o, engine.camera, engine.scene);
      });
    }
    steps.push(() => engine.renderer.compile(group, engine.camera, engine.scene));
  });

  return runSliced({
    steps,
    // The same frame-deadline scheduler the preview slices use. The 1500 ms one
    // the world builds run on would stretch a hundred slices over minutes.
    schedule: idleSoon,
    // A world rebuilt or disposed while this was yielded leaves the plan
    // holding objects that belong to the old one.
    shouldStop: () => worldManager.getWorld(id) !== world || !world.group,
    onError: (err) => {
      // Never fatal: the cost simply reverts to being paid on arrival.
      console.warn(`[warm] precompile of "${id}" failed:`, err);
    },
  }).then((res) => {
    console.info(
      `[warm] "${id}" precompiled in ${Math.round(performance.now() - t0)}ms ` +
      `across ${slices} slices (${res.reason}, ` +
      `+${engine.renderer.info.programs.length - p0} programs, ` +
      `${engine.renderer.info.programs.length} total)`
    );
  });
}

/**
 * Pay the *gateway preview's* first-use shader cost as soon as its destination
 * exists, rather than on the frame the player walks within 40 m of the disc.
 *
 * `warmWorld` above is not enough on its own, and the reason is worth writing
 * down because it looks like it should be. It compiles the destination's
 * materials against `engine.scene` - the station's environment map, the
 * station's fog, the canvas render state. A gateway disc does not draw the
 * destination that way: it renders it into a 512² half-float target with the
 * *destination's* own environment and fog, in `Portals._previewScene`. Three
 * folds all of those into its program cache key, so the pre-compile builds one
 * set of programs and the preview then asks for a different set. Measured over
 * a 14-minute walk of the station: 87 further programs linked *during*
 * navigation, in seven freezes totalling ~41 s, 73% of the link time under
 * `Portals._renderPreview`.
 *
 * ── Why here and not in `prewarm()` ────────────────────────────────────────
 * Because there is nothing to warm at that point. Boot builds only the entry
 * world; every gateway destination is generated by `scheduleBackgroundBuilds`,
 * so a preview warm behind the loading screen would find no materials to link
 * and would have to build all five worlds first - trading a stall the player
 * feels for a much longer one they wait through. Per-world-on-demand puts the
 * cost in the same background chain that already generates and compiles that
 * world.
 *
 * ── Being in the background chain is not the same as being invisible ───────
 * That chain runs after `engine.start()`, so the player is walking around while
 * it works, and one un-sliced warm per world measured 12.4 s, 15.3 s, 4.8 s and
 * 3.3 s of dead main thread inside the first minute of play. Which is why this
 * hands `Portals.warmPreviews` a scheduler and waits on the promise instead of
 * calling it and returning: the warm spreads itself over hundreds of idle
 * callbacks, and holds the gateway's preview off the disc until it is done so
 * the cost can never land in a gameplay frame. See `warmPreviews`.
 *
 * The maze is the exception, deliberately. `MazeWorld` is `static volatile`, it
 * is filtered out of the background builds above, and it re-rolls its layout on
 * every entry - so it is never built while you are standing in the station, its
 * gateway shows a stabilising disc rather than a preview, and there is nothing
 * for this to warm. It costs nothing during navigation for the same reason.
 *
 * @param {string} id
 */
function warmPortalPreviews(id) {
  if (!portals?.warmPreviews) return Promise.resolve();
  // `idleSoon` is the yield. Handing it in is what turns this from one 12-15 s
  // block into one shader program per idle callback; the wall-clock total is
  // about the same and the largest single pause is a frame rather than a
  // freeze. The chain still waits for it, so the next world does not start
  // generating on top of these slices.
  return portals
    .warmPreviews({ target: id, schedule: idleSoon })
    .then((res) => {
      if (res.warmed.length) {
        console.info(
          `[warm] gateway preview to "${id}" linked in ${res.ms}ms ` +
          `across ${res.slices} slices (${res.reason}, ${res.programs} programs total)`
        );
      }
    })
    .catch((err) => {
      // Optional work: the cost simply reverts to being paid on approach.
      console.warn(`[warm] gateway preview warm for "${id}" failed:`, err);
    });
}

/* ------------------------------------------------------------------ */
/* Frame wiring                                                        */
/* ------------------------------------------------------------------ */

/* Registered before `boot()` runs, because a context can be lost at any moment
 * - including during the boot warm itself. @see recoverFromContextLoss */
engine.setContextRecovery(recoverFromContextLoss);

// Mounts run first: while ridden they own the player's position, so they must
// have written it before the player integrates its own movement and before
// anything downstream reads where the player is.
engine.onFixedUpdate((dt, elapsed) => {
  if (gameplayBlocked()) return;
  mounts.fixedUpdate(dt, elapsed);
  /* Beside the mounts and for the same reason: while the player is in a seat,
   * this owns their position, so it has to have written it before the player
   * integrates and before anything downstream reads where they are. The two
   * are mutually exclusive - `SpaceWorld` and `PlanetWorld` both set
   * `mounts: false`, and the yard's ships are boarded, not summoned. */
  piloting.fixedUpdate(dt, elapsed);
  /* AFTER the ship has been integrated, never before: every hostile leads its
   * shots against the position `piloting` just wrote, and every bolt in flight
   * is swept against the hull where it is THIS step. At a 455 m/s closure,
   * aiming at last step's position hands the enemy a 7.6 m error - in the
   * player's favour closing and against them separating, which is the worst
   * kind of wrong because it makes the fight inconsistent rather than hard. */
  spaceCombat.fixedUpdate(dt, elapsed);
  player.fixedUpdate(dt, elapsed);
  // After the player, never before: lap validation sweeps the segment the
  // player actually travelled this step, and reading their position before the
  // mount has written the seat would test last step's line.
  race.fixedUpdate(dt, elapsed);
  // After the player, for the same reason the race is: a length is measured
  // against the position the swimmer holds THIS step, not last step's.
  minigames.fixedUpdate(dt, elapsed);
  npcManager.fixedUpdate(dt, elapsed);
  combat.fixedUpdate(dt, elapsed);
  projectiles.fixedUpdate(dt, elapsed);
  loot.fixedUpdate(dt, elapsed);
  unstuck.fixedUpdate(dt, elapsed);
  portals.fixedUpdate(dt, elapsed);
});

// Last player XZ, used to derive a per-frame planar speed for the active world
// (motion-gated shadow refresh). Null until the first active frame.
let _prevPlayerX = null;
let _prevPlayerZ = null;

engine.onFrameUpdate((dt, elapsed) => {
  const uiPaused = gameplayBlocked();
  materials.update?.(dt, elapsed);
  if (!uiPaused) {
    player.update(dt, elapsed);
    // The rig reads the player's final position, and the avatar and mounts then
    // pose against the camera the rig just placed.
    cameraRig.update(dt, elapsed);
    /* AFTER the rig, and that ordering is the whole reason a barrel roll works.
     * The rig composes a boom from yaw and pitch, which has no roll in it; this
     * overwrites the camera from the flight quaternion, which has all three
     * axes. Running it first would have the rig level the horizon again every
     * frame. It is a no-op when nobody is flying. */
    piloting.update(dt, elapsed);
    /* AFTER `piloting.update`, which is the frame the chase camera is placed
     * in. The gun reticle and the lead pip are projected through that camera;
     * projecting through last frame's puts both a frame behind the nose, which
     * at 2.6 rad/s of roll is visibly detached from the ship they belong to. */
    spaceCombat.update(dt, elapsed);
    avatar.update(dt, elapsed);
    mounts.update(dt, elapsed);
    npcManager.update(dt, elapsed);
    projectiles.update(dt, elapsed);
    loadout.update(dt, elapsed);
    portals.update(dt, elapsed);
    combat.update(dt, elapsed);
    // Planar speed handed to the active world so a world with a throttled
    // shadow map (the station plaza) can refresh it every frame while the
    // character is actually moving fast - otherwise a sprinting silhouette
    // steps/trails across the deck. One distance per frame.
    let _playerSpeed = 0;
    if (dt > 0) {
      const p = player.position;
      if (_prevPlayerX !== null) {
        const dx = p.x - _prevPlayerX;
        const dz = p.z - _prevPlayerZ;
        _playerSpeed = Math.sqrt(dx * dx + dz * dz) / dt;
      }
      _prevPlayerX = p.x;
      _prevPlayerZ = p.z;
    }
    worldManager.active?.update(dt, elapsed, _playerSpeed);
    inventory.update(dt);
    market.update(dt);
    caches.update(dt);
    contracts.update(dt);
    relics.update(dt);
    // After the relics: a viewpoint synchronisation reveals the district those
    // relics are in, and reading the reveal in the frame it was written is what
    // keeps the map from lagging the climb by one frame.
    viewpoints.update(dt);
    interiors.update(dt);
    /* After `interiors` for the reason the minigames are: both publish an E
     * prompt, and reading interiors' in the same frame it was written is what
     * keeps one key from ever meaning two things at once. Mining stands down
     * entirely while the player is in a seat. */
    mining.update(dt);
    /* After `mining` and after `piloting` has stepped: the ore ledger is driven
     * by the `mining:node` this frame may just have emitted, and the survey
     * sweep reads the ship position the flight integrator has just written.
     * Reading either one frame late would put the HUD a frame behind the toast
     * that announced it. */
    objectives.update(dt);
    // After `interiors`, which is what publishes the door/lift prompt the
    // minigame venue stands down for — reading it in the same frame it was
    // written keeps the E key from ever meaning two things at once.
    minigames.update(dt);
    questSystem.update(dt);
  }
  questBoard.update(dt);
  bugReport.update(dt);
  // After the camera rig has placed the camera: the listener frame is read
  // straight off its world matrix, and a frame-old matrix pans every sound
  // to where the player was looking last frame.
  audio.update(dt);
  helpMenu.update?.(dt);
  touchControls.update?.(dt);
  characterMenu.update?.(dt);
  mountMenu.update?.(dt);
  shipMenu.update?.(dt);
  raceUI.update(dt);
  // Outside the `uiPaused` gate, like every other panel: its own sheets are
  // what raise the pause, so a UI that stopped ticking when they opened could
  // never draw the button that closes them.
  minigameUI.update(dt);
  hud.update(dt, elapsed);
  /* Outside the `uiPaused` gate, like every other overlay: the readout has to
   * keep drawing behind the Esc hub or a paused flight looks like a crashed one. */
  flightHUD.update(dt);
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

const gameplayUiBlocks = new Set();
const gameplayBlocked = () => gameplayUiBlocks.size > 0;
function setGameplayBlocked(id, blocked) {
  if (!id) return;
  if (blocked) gameplayUiBlocks.add(id);
  else gameplayUiBlocks.delete(id);
}

/* ?dev=1 only: let the harness run gameplay without a pointer lock.
 *
 * An automated browser cannot hold a pointer lock - the request is refused
 * without a user gesture, and any lock it does get is dropped the moment the
 * window is backgrounded. Either way Chrome fires `pointerlockchange`, the
 * handler below adds 'standby' to `gameplayUiBlocks`, and the whole
 * `if (!uiPaused)` block in the frame updater stops running for the life of
 * the page. The game still RENDERS, so nothing looks wrong.
 *
 * What silently stops: `npcManager.update` (so `_updateLOD` never fires and
 * every NPC stays at `distance: 0, detail: true, rate: 1` at any range) and
 * `worldManager.active.update` (so every world's per-frame LOD bands freeze).
 * Three separate performance measurement runs reported that LOD-disabled worst
 * case as if it were what a player sees. Do not remove this without reading
 * `Harness.setGameplayDriven` first.
 *
 * `devGameplayDriven` starts false and is only ever written by src/dev/Harness.js,
 * which is only imported under ?dev=1 - with it off this file behaves exactly as
 * it did before, for every real player. */
let devGameplayDriven = false;
function setDevGameplayDriven(on) {
  devGameplayDriven = !!on;
  // Re-derive 'standby' from the truth rather than assuming: turning the driver
  // off while genuinely unlocked must put the block back.
  setGameplayBlocked('standby', !devGameplayDriven && !input.locked);
  if (devGameplayDriven) hud.showPauseOverlay(false);
  return devGameplayDriven;
}

bus.on('chat:open', () => setGameplayBlocked('chat', true));
bus.on('chat:close', () => setGameplayBlocked('chat', false));
bus.on('help:open', () => setGameplayBlocked('help', true));
bus.on('help:close', () => setGameplayBlocked('help', false));
bus.on('character:open', () => setGameplayBlocked('character', true));
bus.on('character:close', () => setGameplayBlocked('character', false));
bus.on('inventory:open', () => setGameplayBlocked('inventory', true));
bus.on('inventory:close', () => setGameplayBlocked('inventory', false));
bus.on('mount:menu:open', () => setGameplayBlocked('mount-menu', true));
bus.on('mount:menu:close', () => setGameplayBlocked('mount-menu', false));
bus.on('inventory:use', ({ itemId }) => {
  const res = itemUse.use(itemId);
  if (res?.ok) return; // success path: ItemUse emits hud:notify itself
  if (res?.reason === 'missing') {
    hud?.notify?.('That item is no longer in your bag', 'warn');
  } else if (res?.reason === 'unavailable') {
    hud?.notify?.('Cannot use that right now', 'warn');
  } else if (res?.reason === 'unsupported') {
    hud?.notify?.('That item has no use effect', 'warn');
  }
});
// Drop: item was already moved to store by InventoryUI; spawn a world pickup at
// the player's feet so they can leave it for others or pick it back up.
// Deliberately ungated by rules.loot: that rule governs world-generated drops
// (Loot._dropFor), whereas dropping from your own bag is inventory management,
// not loot generation. Loot.clear() on world:changed already stops a dropped
// item persisting between worlds, so there is nothing here for rules.loot to
// guard against. Do not "fix" this to check allows(world, 'loot').
bus.on('inventory:drop', ({ itemId, qty }) => {
  if (!qty || qty <= 0) return;
  const pos = player.position.clone();
  // collectDelay of 4s stops the player from immediately walking over
  // the just-dropped pickup while still standing on the spawn point.
  loot.spawn(pos, [{ itemId, qty }], { collectDelay: 4 });
  hud?.notify?.(`Dropped ${qty}× ${itemId.replace(/_/g, ' ')}`, 'info');
});
// The maze's dead-end tokens: MazeWorld only ever announces a find (it never
// touches Economy or HUD directly - this file is the single integration
// point, see the header comment above), so this is where the credits are
// actually awarded and the notification actually shown.
/* Hold-L in the maze. MazeWorld only announces the fact - the world switch
 * lives here because this file is the single integration point, the same
 * reason the token award below does. The spec's hard constraint is that a
 * player four kilometres deep is never stranded, so this must work from any
 * level and any depth. */
bus.on('maze:abandon', () => {
  if (worldManager.active?.id !== 'maze') return;
  hud?.notify?.('Leaving the maze', 'info');
  worldManager.activate('station');
});
bus.on('maze:abandon-progress', ({ progress }) => {
  hud?.setHoldProgress?.('abandon', progress);
});
/* The centre of the maze: 100 credits, once. MazeWorld announces, this file
 * awards - see the note on the token handler below. */
bus.on('maze:centre-found', ({ amount }) => {
  economy.add(amount, 'maze-centre');
  hud?.notify?.(`+${amount} CR — the centre of the Coil`, 'loot');
});
bus.on('maze:centre-opened', () => {
  /* The return portal only exists once the centre is taken, so the portal
   * system has to be told to rebuild for this world rather than trusting the
   * specs it read at activation. */
  portals?.buildForWorld?.(worldManager.active);
});
bus.on('maze:token-found', ({ amount }) => {
  economy.add(amount, 'maze-token');
  hud?.notify?.(`+${amount} CR`, 'loot');
});
bus.on('credits:changed', ({ reason }) => schedulePersist(`credits:${reason ?? 'change'}`));
bus.on('inventory:changed', () => schedulePersist('inventory-change'));
// Merchant trades are queued and flushed with the next state sync so the
// admin purchase history shows in-game buys and sells.
bus.on('market:trade', ({ itemId, qty, credits, kind }) => {
  pendingTrades.push({
    kind: kind === 'sell' ? 'sell' : 'buy',
    itemName: String(itemId ?? 'item').replace(/_/g, ' '),
    credits: Math.abs(Math.floor(Number(credits) || 0)) * (kind === 'sell' ? -1 : 1),
    qty: Math.max(1, Math.floor(Number(qty) || 1)),
  });
  scheduleRemotePersist('trade');
});
bus.on('market:open', () => setGameplayBlocked('market', true));
bus.on('market:close', () => setGameplayBlocked('market', false));
// A mount upgrade bought at a merchant grants the power to the mount and
// persists it (locally + backend) so it survives a reload.
bus.on('mount:power:buy', ({ mount, power, tier }) => {
  mounts.grantPower?.(mount || 'car', power, tier);
  schedulePersist('mount-power');
  scheduleRemotePersist('mount-power');
});
// A livery change repaints the mount and persists the choice.
bus.on('mount:livery', () => {
  schedulePersist('mount-livery');
  scheduleRemotePersist('mount-livery');
});
// A cosmetic bought at a merchant unlocks the skin in the wardrobe and persists
// it (locally + backend) so the limited-edition purchase survives a reload.
bus.on('cosmetic:buy', ({ cosmeticId }) => {
  if (!cosmeticId) return;
  cosmetics.unlock(cosmeticId);
  schedulePersist('cosmetic');
  scheduleRemotePersist('cosmetic');
});
bus.on('keybinds:open', () => setGameplayBlocked('keybinds', true));
bus.on('keybinds:close', () => setGameplayBlocked('keybinds', false));
bus.on('audio:menu', ({ open }) => setGameplayBlocked('audio', !!open));
bus.on('race:menu', ({ open }) => setGameplayBlocked('race', !!open));
// Same contract as the race sheets: while the quit confirm or the result card
// is up the world stops, so the contest cannot be lost while it is being
// decided whether to abandon it.
bus.on('minigame:menu', ({ open }) => setGameplayBlocked('minigame', !!open));
// Use hud:block (emitted by QuestBoard only when it actually opens/closes,
// after guards) rather than quests:board:open (emitted by HUD as a request
// that QuestBoard may silently reject via _justClosed). If we reacted to the
// request event, the same-frame E-key close→HUD re-emit cycle would add
// 'quests' back to gameplayUiBlocks permanently.
bus.on('hud:block', ({ id, block }) => {
  if (id === 'quest-board') setGameplayBlocked('quests', !!block);
});
bus.on('bug-report:open', () => setGameplayBlocked('bug-report', true));
bus.on('bug-report:close', () => setGameplayBlocked('bug-report', false));

bus.on('input:lockchange', ({ locked }) => {
  // `devGameplayDriven` is false for every real player; see its declaration.
  setGameplayBlocked('standby', !locked && !devGameplayDriven);
  // Pausing on unlock keeps the world from simulating while a menu is open,
  // except when the chat box deliberately released the pointer.
  if (!locked && !hud.chatOpen && !devGameplayDriven) hud.showPauseOverlay(true);
  else hud.showPauseOverlay(false);
});

/* Minimap circuit overlay.
 *
 * Driven by events rather than polled per frame: the outline is fixed for the
 * life of a circuit and the marker array is mutated in place by RaceManager, so
 * the only thing that ever actually changes here is whether the field is being
 * drawn at all. The circuit goes up as soon as a world publishes one - knowing
 * the shape of the track before you have driven it is most of the value - and
 * the dots only while a race is live. */
bus.on('race:armed', () => hud.minimap?.setCircuit(race.circuit, null));
bus.on('race:started', () => hud.minimap?.setCircuit(race.circuit, race.markers));
bus.on('race:finished', () => hud.minimap?.setCircuit(race.circuit, null));
bus.on('race:aborted', () => hud.minimap?.setCircuit(race.circuit, null));
// `race:armed` never fires for a world without a circuit, so the clear has to
// hang off the world change itself or a circuit would survive the portal out.
bus.on('world:changing', () => hud.minimap?.setCircuit(null));

bus.on('world:changed', ({ world }) => {
  // Before anything else: a world arrives carrying dozens of its own lights,
  // and if a single frame renders with them live the whole program cache is
  // keyed to the wrong counts and every material in view recompiles. The
  // per-frame scan would catch them, but only after that frame.
  lightRig.claim(world.group);
  applyEnvironment(world.environment);
  engine.postfx?.setWorldGrade(world.environment);
});

// Diagnostics moved to the Esc hub; F3 is Chrome's find-in-page. KeyI stays -
// it is a letter key, and the hub's Inventory item is the second way in.
window.addEventListener('keydown', (e) => {
  if (e.code === 'KeyI' && !e.repeat && !e.ctrlKey && !e.metaKey && !e.altKey) {
    const tag = document.activeElement?.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA') return;
    // If the panel is already open, the capture-phase _key handler will close it
    // (and stopImmediatePropagation so we never reach here in that case).
    // If textCaptured is true for any OTHER reason (chat, etc.) don't open inventory.
    if (input.textCaptured) return;
    e.preventDefault();
    e.stopPropagation();
    inventory.toggle?.();
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

function createLoadingScreen(root, hooks = {}) {
  const el = document.createElement('div');
  el.className = 'boot-screen';
  el.innerHTML = `
    <div class="boot-inner">
      <div class="boot-logo">AETHER<span>NEXUS</span></div>
      <div class="boot-tagline">Seven worlds, one gateway ring, and the space beyond.</div>
      <div class="boot-bar"><div class="boot-bar-fill"></div></div>
      <div class="boot-status">Initialising</div>
      <div class="boot-start" hidden>
        <div class="boot-start-title">CLICK TO ENTER</div>
        <div class="boot-save" hidden>
          <span class="boot-save-note"></span>
          <button type="button" class="boot-fresh">Start a new game instead</button>
        </div>
        <div class="boot-controls">
          <span><b>WASD</b> Move</span><span><b>Shift</b> Sprint</span><span><b>Space</b> Jump</span>
          <span><b>C</b> Crouch / roll</span><span><b>LMB</b> Fire</span><span><b>RMB</b> Aim</span>
          <span><b>R</b> Reload</span><span><b>E</b> Talk / Enter portal</span>
          <span><b>F</b> Board your ship</span><span><b>W</b> Throttle</span>
          <span><b>X</b> Airbrake</span><span><b>Esc</b> Pause menu</span>
          <span><b>F1</b> Every control</span>
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
  const saveRow = el.querySelector('.boot-save');
  const saveNote = el.querySelector('.boot-save-note');
  const freshBtn = el.querySelector('.boot-fresh');

  /* The card is shown while the shader warm is still running, so a click has to
   * be able to arrive before the game is in a state to be entered. Rather than
   * disable the card - which reads as a hang - an early click is remembered and
   * honoured the moment the warm finishes. */
  let warm = false;
  let queued = false;
  let entered = false;
  /* Whether the click on this card restores the previous session.
   *
   * -- THE DEFECT THIS EXISTS FOR ----------------------------------------
   * The game autosaved and never auto-LOADED. Enter, and 30 s later the
   * autosave timer wrote a pristine spawn state over the save you had not
   * been told existed - measured three times: 7,777 cr became 0, and a real
   * 90-minute session's 2,066-byte payload became 1,558 bytes with
   * `credits: 0` and `liveries: {}`. `SaveGame` already guarded the boot
   * screen itself and says so in a comment; the thirty seconds AFTER the
   * click were the hole.
   *
   * The guard is not a longer timer. It is that entering with a save present
   * LOADS it, so there is no window in which the live state and the stored
   * state disagree. Starting fresh is still available and is explicit: it
   * clears the save on the click, which is the only way a new game can be
   * safe from the same overwrite. */
  let resume = false;

  const enter = () => {
    if (entered) return;
    entered = true;
    el.classList.add('boot-hide');
    setTimeout(() => el.remove(), 900);
    input.requestLock();
    /* Load BEFORE `game:started`, which is what arms the autosave. Failure is
     * non-fatal: a save that will not apply must still let the player into
     * the world, and `SaveGame.load` reports its own reason. */
    Promise.resolve()
      .then(() => (resume ? hooks.resume?.() : null))
      .catch((err) => { console.error('[boot] could not restore the save:', err); })
      /* AFTER the local load, and only then. The local save is the fuller copy
       * on the device the player last used, so it goes first and the account's
       * copy merges on top - union, never replacement. Running this before the
       * load would let `SaveGame.load`'s REPLACE semantics undo the merge.
       *
       * Signed out, this is a no-op: `syncAccountProgress` checks
       * `accountActive` and returns. */
      .then(() => { adoptRemoteIfNewer(); return syncAccountProgress(); })
      .catch((err) => { console.warn('[boot] progress sync skipped:', err?.message ?? err); })
      .then(() => bus.emit('game:started'));
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
      title.textContent = resume ? 'CLICK TO CONTINUE' : 'CLICK TO ENTER';
      /* `setWarming` overwrote the status line with "Preparing shaders" and
       * nothing ever put it back, so the card sat reading that it was still
       * compiling for the whole time it was ready to play. */
      status.textContent = 'Ready';
      if (queued) enter();
    },
    showStartPrompt(worldName) {
      status.textContent = `Entering ${worldName}`;
      start.hidden = false;
      /* A save is offered, never restored silently: the card says what the
       * click will do and names the alternative beside it. */
      const found = hooks.savedAt?.() ?? null;
      if (found) {
        resume = true;
        title.textContent = 'CLICK TO CONTINUE';
        saveRow.hidden = false;
        saveNote.textContent = `Saved game found - ${found}`;
        freshBtn.addEventListener('click', (e) => {
          /* Stop the card's own click handler: this button is the one control
           * on this screen that must not also enter the world. */
          e.stopPropagation();
          resume = false;
          hooks.discard?.();
          title.textContent = 'CLICK TO ENTER';
          saveRow.hidden = true;
        });
      }
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
