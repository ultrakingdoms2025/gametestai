/**
 * Static contract verifier.
 *
 * Most of this codebase cannot be imported under Node (it touches document,
 * canvas and WebGL at module scope), so we verify the API surface textually:
 * does each owned file exist, export the right symbol, and declare the methods
 * main.js is going to call on it? Cheap, and it catches a mis-specified
 * subsystem before we spend a browser boot finding out.
 *
 *   node scripts/contract-check.mjs
 */
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** @type {Array<{file:string, exports:string[], methods?:string[]}>} */
const CONTRACT = [
  { file: 'src/gfx/Textures.js', exports: ['makeNoiseTexture', 'makeNormalFromHeight'] },
  {
    file: 'src/gfx/Materials.js',
    exports: ['MaterialLibrary'],
    methods: ['warmup', 'get', 'dispose'],
  },
  { file: 'src/gfx/PostFX.js', exports: ['createPostFX'], methods: ['render', 'setSize', 'setWorldGrade'] },
  { file: 'src/gfx/Sky.js', exports: ['createSky'] },
  {
    file: 'src/player/Player.js',
    exports: ['Player'],
    methods: ['fixedUpdate', 'update', 'applyDamage', 'teleport', 'respawn'],
  },
  { file: 'src/player/Weapon.js', exports: ['Weapon'], methods: ['update', 'tryFire', 'reload'] },
  {
    file: 'src/npc/NPCManager.js',
    exports: ['NPCManager'],
    methods: ['spawnForWorld', 'clear', 'fixedUpdate', 'update', 'raycastNPCs'],
  },
  { file: 'src/npc/Humanoid.js', exports: [] },
  { file: 'src/npc/NPCAnimator.js', exports: [] },
  { file: 'src/npc/Navigation.js', exports: [] },
  { file: 'src/npc/NPC.js', exports: ['NPC'] },
  { file: 'src/npc/FriendlyNPC.js', exports: ['FriendlyNPC'] },
  { file: 'src/npc/HostileNPC.js', exports: ['HostileNPC'] },
  /* Roaming predators. Registered for exactly the reason every other entry is:
   * these modules are reached only through `NPCManager`'s beast branch and a
   * world's `npcSpawns`, so a renamed export would surface as a world with no
   * wildlife in it one browser boot later rather than as a failed check here.
   *
   * `BeastSpecies` and `BeastGait` are the tables the balance and the footfall
   * patterns live in and are pure data; `BeastBody` builds the two silhouettes;
   * `BeastAnimator` is the quadruped pose driver `NPC._createAnimator` hands
   * back; `BeastMaul` is the contact-volume arithmetic; `BeastPack` is the wolf
   * coordination; `BeastNPC` is the actor that ties them together.
   * Takes the count 60 -> 67. */
  {
    file: 'src/npc/BeastSpecies.js',
    exports: ['BEASTS', 'BEAST_IDS', 'beastDef', 'rollBeastDamage', 'rollPackSize'],
  },
  {
    file: 'src/npc/BeastGait.js',
    exports: ['GAITS', 'GAIT_PHASE', 'LEG_ORDER', 'gaitFor', 'legPhase', 'legPose',
      'planted', 'supportCount', 'footfallPhases', 'suspensionFraction'],
  },
  {
    file: 'src/npc/BeastBody.js',
    exports: ['BeastBody'],
    methods: ['getHeadWorldPosition', 'setDetailVisible', 'setShadowCasting', 'dispose'],
  },
  {
    file: 'src/npc/BeastAnimator.js',
    exports: ['BeastAnimator'],
    methods: ['setLocomotion', 'setLookTarget', 'setIntent', 'setIntentForState', 'flinch', 'die', 'revive',
      'beginSink', 'update'],
  },
  {
    file: 'src/npc/BeastMaul.js',
    exports: ['segmentDistanceSq', 'capsulesOverlap', 'strikeTip', 'standingCapsule',
      'strikeHits', 'STRIKE_ARC', 'STRIKE_DROP'],
  },
  {
    file: 'src/npc/BeastPack.js',
    exports: ['BeastPack', 'SHARE_RADIUS', 'PACK_FORGET'],
    methods: ['add', 'remove', 'share', 'slotAngle', 'requestAttack', 'releaseAttack', 'update'],
  },
  {
    file: 'src/npc/BeastNPC.js',
    exports: ['BeastNPC'],
    methods: ['_createAnimator', 'hitCapsule', 'adoptPackTarget', 'alert'],
  },
  {
    file: 'src/ui/HUD.js',
    exports: ['HUD'],
    methods: ['update', 'showPauseOverlay', 'setDebugVisible'],
  },
  { file: 'src/ui/Minimap.js', exports: [] },
  { file: 'src/ui/ChatBox.js', exports: [] },
  { file: 'src/ui/hud.css', exports: [] },
  { file: 'src/ai/ChatClient.js', exports: ['ChatClient'], methods: ['send'] },
  { file: 'server/chat-server.js', exports: [] },
  {
    file: 'src/worlds/WorldManager.js',
    exports: ['WorldManager'],
    methods: ['register', 'build', 'activate'],
  },
  {
    file: 'src/systems/Portals.js',
    exports: ['PortalSystem'],
    methods: ['buildForWorld', 'fixedUpdate', 'update'],
  },
  { file: 'src/systems/Combat.js', exports: ['CombatSystem'], methods: ['fixedUpdate', 'update'] },
  { file: 'src/worlds/StationWorld.js', exports: ['StationWorld'], methods: ['build'] },
  { file: 'src/worlds/MedievalWorld.js', exports: ['MedievalWorld', 'MEDIEVAL_LAYOUT'], methods: ['build'] },
  /* Split out of MedievalWorld.js when the vale was widened to 900m. The
   * settlement table owns the plots and the definition of trodden ground;
   * the grid index owns the broadphase the scatter passes query. Both are
   * `three`-free so the tests and the generation worker can read them. */
  {
    file: 'src/worlds/medieval/Settlements.js',
    exports: ['PLOTS', 'EXTRA_YARDS', 'SETTLEMENTS', 'GROUND_BOUNDS', 'settledAt', 'settlementAt'],
  },
  /* Added when the vale's ground was tiled and its meadow made resident.
   * Both are pure arithmetic split out of `MedievalWorld.js` for the same
   * reason as the two above: the failures are silent (a seam, a crack, a
   * bounding sphere that spans the map, a bald patch in front of the player)
   * and none of them needs a renderer to catch. */
  {
    file: 'src/worlds/medieval/TerrainTiles.js',
    exports: [
      'tileGrid', 'buildTile',
      'TILE_METRES', 'TILE_LO_STRIDE', 'TILE_SWAP_DISTANCE', 'TILE_SKIRT_DROP',
    ],
  },
  {
    file: 'src/worlds/medieval/GrassResidency.js',
    exports: [
      'GrassResidency', 'cellDistance',
      'GRASS_BUILD_DISTANCE', 'GRASS_RELEASE_DISTANCE', 'GRASS_ZONE_BUDGET',
      'GRASS_BYTES_PER_INSTANCE',
    ],
    methods: ['decide', 'initial', 'distance'],
  },
  {
    file: 'src/worlds/medieval/GridIndex.js',
    exports: ['GridIndex', 'segmentDistance'],
    methods: ['insert', 'query', 'nearest'],
  },
  /* The outer ring's content, split out for the same reason everything above
   * it was: these are the modules whose failures are silent.
   *
   * `RoadNet` owns the road table and the crossings, and it is the only thing
   * that can answer "is every town reachable" - a disconnected network throws
   * nothing and shows nothing, it just strands a player at a river. `Towns`
   * owns the five layouts and the interior arithmetic, so "the stairs reach
   * the floor above" and "you can stand up in here" are properties of a pure
   * function rather than of nine thousand lines of renderer. `Camps` owns
   * three camp layouts and the which-bank test. `Woodland` owns the stand
   * field and DERIVES the tree budget from it, which is the fix for an
   * absolute 520 trees over a map that grew five times.
   *
   * A renamed export in any of them surfaces here rather than as a town with
   * no beaten earth, a road to nowhere or a bald forest one browser boot
   * later. Takes the count 67 -> 71. */
  {
    file: 'src/worlds/medieval/RoadNet.js',
    exports: ['VALE_ROADS', 'RING_ROADS', 'ROADS', 'CROSSINGS', 'GREYOAK_STAGE',
      'ROAD_JOIN', 'ROAD_SAMPLE', 'samplePolyline', 'roadGraph'],
  },
  {
    file: 'src/worlds/medieval/Towns.js',
    exports: ['TOWNS', 'REEDWATER_DECK', 'REEDWATER_JETTIES', 'GRIMSCAR_WORKINGS',
      'CEOLWINE_PRECINCT', 'CEOLWINE_GARTH', 'CEOLWINE_HERBS', 'CEOLWINE_POND',
      'BLACKMARCH_PALISADE', 'BLACKMARCH_YARD', 'BLACKMARCH_BEACON',
      'FENWICK_MARKET', 'FENWICK_CROSS', 'FENWICK_CENTRE',
      'GROUND_H', 'UPPER_H', 'FLOOR_T', 'FLOOR_RISE', 'DOOR_W', 'DOOR_H', 'WALL_T',
      'STAIR_RISE_MAX', 'STAIR_TREAD', 'STAIR_W',
      'stairFlight', 'interiorPlan', 'storeyClear', 'shellHeight', 'allBuildings', 'landmarkOf',
      'footprintCorners', 'footprintDistance', 'footprintsOverlap', 'groundUnder',
      'isOverWater', 'townBank', 'enterableCounts'],
  },
  {
    file: 'src/worlds/medieval/Camps.js',
    exports: ['CAMPS', 'piecePosition', 'campPieces', 'bankOf', 'campGround'],
  },
  {
    file: 'src/worlds/medieval/Woodland.js',
    exports: ['WOOD_FREQ', 'woodMask', 'AUTHORED_WOODS', 'authoredLift',
      'standAt', 'isWoodEdge', 'STAND_AREA',
      'TREE_DENSITY', 'PLAYFIELD_TREES', 'UNDERSTOREY', 'BRACKEN',
      'TREE_BUCKET_M', 'TREE_BUCKETS', 'STAND_SPECIES', 'standSpecies',
      'NAMED_WOODS', 'woodAt', 'DEADFALL_PER_WOOD'],
  },
  { file: 'src/worlds/SportsWorld.js', exports: ['SportsWorld'], methods: ['build'] },
  { file: 'src/worlds/WorldRules.js', exports: ['DEFAULT_RULES', 'makeRules', 'allows'] },
  {
    file: 'src/worlds/maze/MazeTopology.js',
    exports: ['MAZE', 'DIR', 'generateTopology', 'solve', 'reachableCount',
              'buildDistrictGraph', 'carveDistrict', 'cellIndex', 'cellCoords'],
  },
  { file: 'src/worlds/maze/MazeColliders.js', exports: ['districtColliders', 'forecourtColliders', 'cellToWorld'] },
  /* Split out of MazeColliders.js in Phase 2c. The connector geometry and the
   * enclosure proof live here now; `cellToWorld` stayed reachable from
   * MazeColliders.js as a re-export, which is why it is still listed above. */
  { file: 'src/worlds/maze/MazeShafts.js', exports: ['shaftColliders', 'stairColliders', 'stairWellBounds', 'isEnclosureSound', 'requiredWallTop'] },
  /* `districtLodDistance` joined in Phase 6 Task 7: the residency update and
   * the headless triangle-budget test must measure the LOD bands with one
   * ruler, so the ruler is exported rather than duplicated. */
  { file: 'src/worlds/maze/MazeChunks.js', exports: ['MazeChunks', 'buildBoxInstances', 'CHUNK_MESH_KINDS', 'districtLodDistance'] },
  /* Phase 6. The geometry seam: visuals stop being literally the collider box.
   * `MazeProfiles.js` is pure arithmetic - the extent quantiser and the cache
   * bound - and `MazeMeshes.js` is the only place a maze BufferGeometry is
   * built, which is what lets `MazeChunks` carry translation and nothing else.
   * Both registered here for the same reason MazeChunks is: a renamed export
   * would otherwise surface as a blank world one browser boot later. */
  /* Phase 6 Task 7 adds the LOD bands: pure numbers, one definition, shared
   * by the residency update and the triangle-budget test. */
  { file: 'src/worlds/maze/MazeProfiles.js', exports: ['EXTENT_SNAP', 'EXTENT_QUANTUM', 'quantiseExtent', 'extentClass', 'PREFAB_BUDGET', 'treadProfile', 'treadOutline', 'LANDING_RATIO', 'CHAMFER', 'chamferFor', 'contactShade', 'CONTACT_AO', 'LOD0_RANGE', 'LOD1_RANGE', 'lodFor'] },
  /* Task 8 adds `DRESSING_KINDS` - the explicit dressing-exemption ledger the
   * fit contract's tests read - and the assets seam below. */
  { file: 'src/worlds/maze/MazeMeshes.js', exports: ['prefabFor', 'groupByExtentClass', 'isPrefab', 'prefabCount', 'releasePrefabs', 'extentClass', 'PREFAB_BUDGET', 'DRESSING_KINDS'] },
  /* Phase 6 Task 8. The authored-asset pipeline: manifest -> GLTFLoader ->
   * prefab registry, every failure path degrading to the procedural prefab.
   * `MAZE_ASSET_PREFABS` is the kind -> asset-id contract MazeMeshes builds
   * against; `loadMazeAssets` is what MazeWorld.build awaits. The manifest
   * and licence ledger are registered as files so a stray delete surfaces
   * here instead of as a silent all-fallback world. */
  /* Task 9 adds the texture side of the same pipeline: `authoredSurfaces`
   * groups loaded KTX2 maps into complete per-surface sets, and the vendored
   * Basis transcoder is registered as files because KTX2Loader fetches it at
   * runtime - a stray delete would silently fall the whole world back to
   * procedural surfaces. */
  { file: 'src/worlds/maze/MazeAssets.js', exports: ['loadMazeAssets', 'MAZE_ASSET_PREFABS', 'resetMazeAssets', 'authoredSurfaces', 'MAZE_TEXTURE_SLOTS'] },
  { file: 'public/vendor/basis/basis_transcoder.js', exports: [] },
  { file: 'public/vendor/basis/basis_transcoder.wasm', exports: [] },
  { file: 'public/assets/maze/manifest.json', exports: [] },
  { file: 'public/assets/maze/newel-finial.glb', exports: [] },
  { file: 'docs/assets/LICENCES.md', exports: [] },
  /* Phase 6 Task 6. One BatchedMesh per material family, capacity derived
   * from the residency radius; the streamed set's draw calls stop scaling
   * with district count. Registered like MazeChunks: a renamed export here
   * strands the streaming path. */
  /* Task 7: `setLod` is the per-instance geometry-id swap the residency
   * update drives, and `submittedTriangles` the ledger the budget test sums. */
  { file: 'src/worlds/maze/MazeBatches.js', exports: ['MazeBatches', 'BATCH_FAMILIES', 'BATCH_PER_DISTRICT_MAX', 'RESIDENCY_RADIUS', 'worstCaseResidency', 'worstCaseInstances', 'batchCapacity', 'GEOMETRY_BUDGET'], methods: ['setLod', 'submittedTriangles'] },
  /* Phase 6 Task 3. The cached material set, lifted verbatim out of
   * MazeWorld._ensureMaterials so the program-family gate can see it headlessly,
   * plus the fingerprint and the enumerated families that replaced Phase 5's
   * frozen browser-only program count. */
  /* Phase 6 Task 5 adds the surfacing seam: the async yield-path builder, the
   * declared size table and its byte sum (the headless texture budget), and
   * the bake timer the boot-cost gate reads in the browser. */
  /* Task 9 adds the authored-surface seam: the KTX2 size and physical-tile
   * tables (the authored half of the texture budget), the per-material
   * swap `MazeWorld.build` calls, and the A/B switch the harness exposes. */
  { file: 'src/worlds/maze/MazeMaterials.js', exports: ['buildMazeMaterials', 'buildMazeMaterialsAsync', 'materialFingerprint', 'MAZE_PROGRAM_FAMILIES', 'MAZE_PROGRAM_BUDGET', 'MAZE_TEXTURE_SIZES', 'declaredTextureBytes', 'surfaceBakeMillis', 'applyAuthoredSurfaces', 'setMazeSurfaceMode', 'mazeSurfaceMode', 'MAZE_AUTHORED_TEXTURE_SIZES', 'MAZE_AUTHORED_TILE_METRES'] },
  /* Phase 3. `MazePlan.js` is pure so both map surfaces derive their walls
   * from one definition; `MazeMap.js` is the M-key overlay that draws them. */
  { file: 'src/worlds/maze/MazePlan.js', exports: ['planCacheKey', 'levelSegments'] },
  { file: 'src/ui/MazeMap.js', exports: ['MazeMap'] },
  /* The all-levels arrangement, pure so it can be asserted without a canvas. */
  { file: 'src/ui/MazeMapLayout.js', exports: ['OVERVIEW', 'overviewSheet', 'singleSheet', 'sheetFor', 'paneAt', 'verticalLinks'] },
  { file: 'src/worlds/maze/MazeCanopy.js', exports: ['MazeCanopy'] },
  /* Population streaming. Mirrors MazeChunks' ensure/drop/sync lifecycle and is
   * handed its resident key set, so the two can never disagree about which
   * districts are live - registered here for the same reason MazeChunks is. */
  { file: 'src/worlds/maze/MazePopulation.js', exports: ['MazePopulation'] },
  { file: 'src/worlds/MazeWorld.js', exports: ['MazeWorld'], methods: ['build', 'dispose'] },
  /* Gateway 06's destination. Registered for the same reason every other world
   * is: the sixth gateway is live and routed here, so a renamed export or a
   * deleted file surfaces as a failed check rather than as a portal that drops
   * the player into nothing one browser boot later. Takes the count 59 -> 60. */
  { file: 'src/worlds/SurveyWorld.js', exports: ['SurveyWorld'], methods: ['build', 'dispose'] },
];

/** Feature set v2 — see CONTRACTS-V2.md. Absent until those agents land. */
const CONTRACT_V2 = [
  { file: 'src/player/CameraRig.js', exports: ['CameraRig'], methods: ['update', 'setMode', 'toggle'] },
  { file: 'src/player/PlayerAvatar.js', exports: ['PlayerAvatar'], methods: ['update', 'setVisible'] },
  { file: 'src/player/Loadout.js', exports: ['Loadout'], methods: ['update', 'select', 'next', 'prev'] },
  { file: 'src/weapons/Fireball.js', exports: [], methods: ['tryFire'] },
  { file: 'src/weapons/Bow.js', exports: [], methods: ['tryFire'] },
  { file: 'src/systems/Projectiles.js', exports: ['ProjectileSystem'], methods: ['spawn', 'fixedUpdate'] },
  { file: 'src/systems/Economy.js', exports: ['Economy'], methods: ['add', 'serialize', 'deserialize'] },
  { file: 'src/systems/SaveGame.js', exports: ['SaveGame'], methods: ['save', 'load', 'hasSave'] },
  { file: 'src/systems/Unstuck.js', exports: ['UnstuckSystem'], methods: ['fixedUpdate', 'unstuck'] },
  { file: 'src/mounts/MountManager.js', exports: ['MountManager'], methods: ['summon', 'dismount', 'update'] },
  { file: 'src/mounts/Hoverboard.js', exports: [], methods: [] },
  { file: 'src/mounts/Dragon.js', exports: [], methods: [] },
  { file: 'src/ui/WeaponWheel.js', exports: [], methods: [] },
];
// v2 files are only enforced once they exist, so this script stays useful mid-build.
for (const entry of CONTRACT_V2) {
  if (existsSync(path.join(root, entry.file))) CONTRACT.push(entry);
}

const problems = [];
const missing = [];
let checked = 0;

for (const entry of CONTRACT) {
  const abs = path.join(root, entry.file);
  if (!existsSync(abs)) {
    missing.push(entry.file);
    continue;
  }
  checked++;
  if (entry.file.endsWith('.css')) continue;
  const src = await readFile(abs, 'utf8');

  for (const name of entry.exports) {
    // Matches: export class X | export function X | export const X | export { X }
    const re = new RegExp(
      `export\\s+(?:async\\s+)?(?:class|function|const|let)\\s+${name}\\b|export\\s*\\{[^}]*\\b${name}\\b`
    );
    if (!re.test(src)) problems.push(`${entry.file}: missing export "${name}"`);
  }

  for (const m of entry.methods ?? []) {
    // Class methods, object-literal methods, or assigned arrow properties.
    const re = new RegExp(`(^|[\\s;{,])(?:async\\s+)?${m}\\s*(\\(|[:=]\\s*(?:async\\s*)?\\()`, 'm');
    if (!re.test(src)) problems.push(`${entry.file}: missing method "${m}"`);
  }

  // House rules that are cheap to check and expensive to discover in a browser.
  if (/from\s+['"]three\/examples\//.test(src)) {
    problems.push(`${entry.file}: imports three/examples/* - use three/addons/* instead`);
  }
  const remote = src.match(/https?:\/\/(?!localhost|127\.0\.0\.1)[^'"\s)]+/g);
  if (remote) {
    const assetish = remote.filter((u) => /\.(png|jpg|jpeg|hdr|exr|glb|gltf|fbx|ktx2?|bin)(\?|$)/i.test(u));
    if (assetish.length) problems.push(`${entry.file}: loads remote asset(s): ${assetish.join(', ')}`);
  }
}

console.log(`\ncontract-check: ${checked}/${CONTRACT.length} files present`);
if (missing.length) {
  console.log(`\nMISSING FILES (${missing.length}):`);
  for (const m of missing) console.log(`  - ${m}`);
}
if (problems.length) {
  console.log(`\nCONTRACT PROBLEMS (${problems.length}):`);
  for (const p of problems) console.log(`  ! ${p}`);
}
if (!missing.length && !problems.length) console.log('\nAll contracts satisfied.\n');

process.exit(missing.length || problems.length ? 1 : 0);
