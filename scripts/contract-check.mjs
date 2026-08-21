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

/** @type {Array<{file:string, exports:string[], methods?:string[], fields?:string[], statics?:string[]}>} */
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
  /* Gateway 05's destination, and the only one of the six that was never
   * registered here. Registered now for the reason every other world is: it is
   * reached by name from `main.js:123` through `worldManager.register`, so a
   * renamed export is a portal that drops the player into nothing one browser
   * boot later rather than a failed check in half a second.
   *
   * `build` is what `WorldManager.build` awaits and `update` is what the
   * gameplay block calls each frame - the banners are the only thing that
   * moves in this world, and a world whose `update` quietly stopped existing
   * would look almost right, which is the failure mode this file is for.
   * `dispose` is load-bearing here rather than optional: `CitadelWorld` owns
   * the sky dome's geometry, material and canvas texture plus every batched
   * geometry in `_owned`, and it is the one world that also clears four
   * published arrays (`_roofs`, `_towers`, `haystacks`, `viewpoints`) which
   * would otherwise be re-appended to on the next build.
   *
   * `terrain/CitadelHeight.js` is registered alongside it because that split
   * is a CROSS-THREAD contract, not a tidy-up: `terrain/index.js` maps the job
   * name `citadel` to `citadelHeight`, and the generation worker imports the
   * module directly (it may not import `three`). `CitadelWorld` imports the
   * same four constants back and builds the visible heightfield, the collision
   * heightfield and every prop placement off them - the file's own header
   * records that this slope was once three disagreeing approximations and the
   * player walked underneath the visible world across 7% of the map. A rename
   * of `terrainH`, `citadelHeight` or any of `MESA_Y` / `MESA_R` / `SHOULDER`
   * / `HALF` splits it back into two descriptions of one surface, in two
   * threads, with no error anywhere. Takes the count 75 -> 77. */
  {
    file: 'src/worlds/CitadelWorld.js',
    exports: ['CitadelWorld', 'CITADEL_LAYOUT'],
    methods: ['build', 'update', 'dispose'],
    /* The five surfaces the other four agents' code is built on, and the class
     * name is not one of them. `MinigameManager.arm` reads `minigameVenues`,
     * `Viewpoints._onWorld` reads `viewpoints`, `Relics._onWorld` reads
     * `_roofs` and `_towers` (and `_roofs[].anchor` inside them),
     * `_publishVenues` and the minimap read `ropeBridges`, and
     * `Caches._onWorld` reads `cacheSites`. Each is consumed by an
     * optional-chained property read, so a rename is not an error anywhere - it
     * is a trial venue that never arms, a leap prompt that never fires, a
     * hundred relics scattered by random dart instead of onto the skyline, and
     * five of the six outer regions holding no cache while the log says nine. */
    fields: ['minigameVenues', 'viewpoints', '_roofs', '_towers', 'ropeBridges',
      'contentBounds', 'cacheSites'],
  },
  /* Drop Three's two modules, and both are consumed across a boundary.
   *
   * `citadel/Districts.js` is the spatial split `CitadelWorld._splitDistricts`
   * and `_registerLod` are built on, and it is also read directly by
   * `citadel-districts.test.mjs` and `citadel-budgets.test.mjs` - the budget
   * assertions ARE the contract, so `districtStats`, `MAX_DISTRICT_RADIUS` and
   * `splitDistricts` disappearing would take design 5.4's C2 and C3 with them
   * and leave two green test files measuring nothing.
   *
   * `citadel/TerrainDetail.js` decides how far away each ground tile may swap to
   * half resolution. It exists because `medieval/TerrainTiles.js` publishes a
   * constant that is right for the vale and worth 637 m on this field - a
   * rename that quietly reverted the call site to that constant would flatten
   * the ring's quarry benches and karst faces from everywhere, with no distance
   * at which they came back, and nothing would throw. Takes the count 80 -> 82. */
  {
    file: 'src/worlds/citadel/Districts.js',
    exports: ['splitGeometry', 'splitMesh', 'splitDistricts', 'lowDetail', 'registerDistricts',
      'bandCanFire', 'sourceSphere', 'subPixelDistance', 'districtStats', 'triangleCount',
      'geometryBytes', 'MAX_DISTRICT_RADIUS', 'MIN_LEAF_TRIANGLES'],
  },
  {
    file: 'src/worlds/citadel/TerrainDetail.js',
    exports: ['loDeviation', 'swapDistance', 'PIXELS_PER_RADIAN', 'PIXEL_BUDGET'],
  },
  /* `citadel/Regions.js` is the outer ring's six regions, and every export here
   * is consumed across a boundary rather than inside it.
   *
   * `buildRegions` is what `CitadelWorld._buildRegions` calls; `REGIONS` and
   * `TIERS` are read directly by `citadel-regions.test.mjs`, which re-measures
   * every authored gap out of the collider set and flies every crossing at the
   * budget the tier names. `jumpSpan` and `gapFor` are the derivation the whole
   * difficulty curve rests on - the integrator that knows gravity is applied
   * BEFORE the move, so a jump apex is 0.878 m and not the closed form's 0.930
   * - and `LAND_COST` is what a landing costs in metres of that arc.
   *
   * A rename here is not an error anywhere: it is a world whose gaps quietly
   * stop being solved from the body that has to cross them, which is precisely
   * the state Drop Two measured and found `pearson(ring, gap) = 0.1485`.
   * Takes the count 82 -> 83. */
  {
    file: 'src/worlds/citadel/Regions.js',
    exports: ['buildRegions', 'REGIONS', 'TIERS', 'TIER', 'BUDGETS', 'jumpSpan', 'gapFor',
      'LAND_COST', 'LIP', 'RegionSite'],
  },
  /* Drop Two's three new modules, each consumed by a DIFFERENT agent's file -
   * which is precisely the shape this checker exists for. `Viewpoints` is
   * constructed in `main.js:268`, driven at `:1641`, feeds the pause hub at
   * `:509` and is read by `HUD` and `Minimap`; `createRooftopTrial` is the
   * factory `main.js:350` registers for the `rooftop` venue kind, and
   * `venueBounds` is imported back by `CitadelWorld` to size the venue discs;
   * `CheckpointSweep` is the swept ordered-checkpoint test `RaceManager` and
   * `RooftopTrial` both call. Takes the count 77 -> 80. */
  {
    file: 'src/systems/Viewpoints.js',
    exports: ['Viewpoints', 'normaliseViewpoint', 'REVEAL_R', 'LEAP_R', 'MAX_TRAVEL_ROWS'],
    /* `chartNearest`/`canChart` are the `nav_chart` bag item's entire effect,
     * and they are pinned here because the item's registration chain crosses
     * four files and this is the only link in it that is a METHOD. */
    methods: ['update', 'reveals', 'chartNearest', 'canChart', 'travelTo', 'hubItems',
      'serialize', 'deserialize', 'dispose'],
  },
  /* The three objectives the player named. Pinned for the reason every entry
   * here is: this system reaches nothing and is reached only from `main.js` and
   * `SaveGame`, so a renamed export is a HUD panel that quietly stops counting
   * one browser boot later rather than a failure here.
   *
   * The thresholds are pinned by NAME as well as the class: `KILL_TIERS`,
   * `ORE_TIERS`, `surveyRange` and `surveyReward` are all read by
   * `scripts/tests/space-objectives.test.mjs`, which re-derives every one of
   * them from the world rather than restating them - so a rename would take the
   * measurement with it. */
  {
    file: 'src/systems/SpaceObjectives.js',
    exports: ['SpaceObjectives', 'surveyRange', 'surveyReward', 'wingBounty',
      'SURVEY_FRACTION', 'SURVEY_FOV_DEG', 'KILL_TIERS', 'ORE_TIERS',
      'LANDFALL_CREDITS', 'ASSAY_CREDITS'],
    methods: ['update', 'progress', 'chart', 'reached', 'serialize', 'deserialize', 'dispose'],
  },
  {
    file: 'src/minigames/RooftopTrial.js',
    exports: ['createRooftopTrial', 'RooftopTrial', 'ROOFTOP_GAME_ID', 'parTimes', 'medalFor',
      'venueBounds', 'venueCoversRoute', 'START_RADIUS'],
    methods: ['begin', 'fixedUpdate', 'snapshot', 'dispose'],
  },
  /* Lodestar Yard's test-fire butts. `TEST_FIRE_GAME_ID` is pinned by name
   * because `scripts/quest-vocab.mjs` SCRAPES it to decide whether a `minigame`
   * step in the dock has a legal target at all - rename it silently and the
   * quest vocabulary loses a verb rather than erroring. */
  {
    file: 'src/minigames/TestFire.js',
    exports: ['createTestFire', 'TestFire', 'TEST_FIRE_GAME_ID', 'readTargets'],
    methods: ['begin', 'fixedUpdate', 'snapshot', 'dispose'],
  },
  { file: 'src/race/CheckpointSweep.js', exports: ['segDistSq', 'sweptPass'] },
  {
    file: 'src/worlds/terrain/CitadelHeight.js',
    exports: ['MESA_Y', 'MESA_R', 'SHOULDER', 'HALF', 'terrainH', 'citadelHeight'],
  },
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
  /* Gateway 06's destination, and the space beyond it. Registered for the same
   * reason every other world is: the sixth gateway is live and routed here, so
   * a renamed export or a deleted file surfaces as a failed check rather than
   * as a portal that drops the player into nothing one browser boot later.
   *
   * `fields` is the important half, and it is the ONLY mechanism in this repo
   * that pins a published array NAME. Every one of these is read through an
   * optional chain by a system that names no world - `Interiors` reads
   * `enterables`, `Viewpoints` reads `viewpoints`, `Parkour` reads
   * `haystacks`, `MinigameManager` reads `minigameVenues`, `Relics` reads
   * `_roofs` and `_towers`, `Caches` reads `cacheSites`, the ship stage reads
   * `shipSpecs`, `PortalSystem` reads `portalSpecs`, `NPCManager` reads
   * `npcSpawns` and `Minimap` reads `minimapShapes` - so a typo in any of them
   * is a whole system quietly finding nothing, one browser boot later. And
   * `cacheSites` is the newest and the most silent of them: without it this
   * world places no caches at all and says nothing, because the dart that would
   * find them lands on the shed roof. It is the SAME field name Citadel
   * publishes, and deliberately so: one channel, with the presence of a `y` on
   * an entry telling `Caches` the site is a deck under a roof and must be taken
   * as authored rather than probed from above. */
  {
    file: 'src/worlds/DockWorld.js',
    exports: ['DockWorld'],
    methods: ['build', 'update', 'dispose'],
    fields: [
      'enterables', 'viewpoints', 'haystacks', 'minigameVenues',
      '_roofs', '_towers', 'cacheSites', 'shipSpecs', 'ships', 'portalSpecs', 'npcSpawns', 'minimapShapes',
    ],
  },
  /* The yard's plan, three-free so the tests can read the numbers the world is
   * dimensioned off without building it. */
  {
    file: 'src/worlds/dock/YardPlan.js',
    exports: [
      'DECK_Y', 'GANTRY_Y', 'CRANE_Y', 'ROOF_Y', 'TRENCH_Y',
      'YARD_X', 'YARD_Z0', 'YARD_Z1', 'APRON_Z', 'BERTHS', 'COUNTERS', 'STAIRS',
      'TRENCH_RUNS', 'TRENCH_BAYS', 'CRANE_CAB', 'SIGNAL_POST', 'SPARES_PILE',
      'PORTAL_STATION_Z', 'PORTAL_SPACE_Z',
      'BUTTS_FIRE_Z', 'BUTTS_RANKS', 'BUTTS_PLATES', 'BUTTS_CELL_COST',
      'BUTTS_SECONDS', 'BUTTS_REWARD',
    ],
  },
  { file: 'src/worlds/dock/YardKit.js', exports: ['railRun', 'stairTreads', 'signBoard', 'paintQuad', 'workLight'] },
  /* The hulls. `HullPlan` is three-free for the same reason `YardPlan` is: the
   * numbers a mantle, a crouch bay and a companionway depend on are read by the
   * tests rather than re-derived, so there is one place a measurement lives. */
  {
    file: 'src/worlds/dock/HullPlan.js',
    exports: [
      'SKIN', 'DECK_T', 'MIN_STEP_IN', 'MANTLE_MAX', 'MANTLE_MIN_GROUND', 'STEP_UP',
      'CLIMB_BUDGET', 'BROW', 'KESTREL', 'DRAY', 'PIKE', 'BASTION', 'HULLS', 'WALKABLE',
      'boardSide',
    ],
  },
  {
    file: 'src/worlds/dock/ShipKit.js',
    exports: ['ShipBuild', 'shipMaterials', 'MANTLE_INBOARD', 'MANTLE_HEADROOM', 'GRIP_HEIGHT'],
  },
  { file: 'src/worlds/dock/Hulls.js', exports: ['buildKestrel', 'buildDray', 'buildPike', 'buildBastion'] },
  /* The hulls' authored-asset pipeline, modelled on the maze's. `loadShipAssets`
   * is awaited once by `DockWorld.build`; `shipParts` is the synchronous read
   * the hull builders make, and returns null - the procedural hull - whenever
   * the file is absent, which is every headless test in this repo. */
  {
    file: 'src/ships/ShipAssets.js',
    exports: [
      'loadShipAssets', 'shipParts', 'resetShipAssets', 'installShipAssets',
      'SHIP_ASSET_HULLS', 'SHIP_PART_KEYS',
    ],
  },
  /* The customiser. `ShipStats` is renderer-free and `three`-free so the
   * catalogue test can read the ladder without building a world, exactly as
   * `mounts/Livery.js` is for `MOUNT_STATS`. */
  {
    file: 'src/ships/ShipStats.js',
    exports: [
      'SHIP_ORDER', 'SHIP_CLASSES', 'SHIP_TINTS', 'SHIP_SLOTS', 'SHIP_STATS',
      'SHIP_STAT_META', 'SHIP_BASE_STATS', 'SHIP_SKINS', 'SHIP_SKINS_BY_ID',
      'KNOWN_SHIP_SKIN_IDS', 'shipSkinsFor', 'shipSkinItemId', 'holdCapacity',
    ],
  },
  { file: 'src/ships/Ship.js', exports: ['Ship'], methods: ['applyCustomization', 'applyPowers', 'snapshot'] },
  {
    file: 'src/ships/ShipRegistry.js',
    exports: ['ShipRegistry'],
    methods: ['setLivery', 'getLivery', 'resetLivery', 'grantPower', 'getPowers', 'sellsPower',
      'applyScheme', 'select', 'serialize', 'deserialize'],
  },
  { file: 'src/ui/ShipMenu.js', exports: ['ShipMenu'], methods: ['open', 'close', 'toggle', 'dispose'] },
  {
    file: 'src/ui/ShipMenuLogic.js',
    exports: ['SHIP_PALETTES', 'shipStatLine', 'schemeState', 'SCHEME_STATE_LABEL'],
  },
  { file: 'src/worlds/dock/YardTextures.js', exports: ['buildYardTextures', 'buildYardMaterials', 'YARD_SIGNS', 'YARD_SIGN'] },
  /* The far side of the blast door. A stub, registered in the dock drop so the
   * launch seam is exercised end to end before a flight model exists.
   *
   * `encounters` joined the field list when the void stopped being a stub: it
   * is the named alien wings, and it is read by `SpaceCombat._arm`
   * (`Array.isArray(w?.encounters)`) and by `SpaceObjectives` at four separate
   * optional-chained sites. None of them names this world, so a rename is a
   * void with nothing hostile in it and a wing objective that counts to zero
   * forever, with nothing in the console either way. */
  {
    file: 'src/worlds/SpaceWorld.js',
    exports: ['SpaceWorld'],
    methods: ['build', 'dispose'],
    fields: ['portalSpecs', 'minimapShapes', 'encounters'],
  },

  /* ══════════════════════════════════════════════════════════════════════════
   * THE PLANET / SPACE / SHIP SUBSYSTEM
   *
   * Until this block, `grep -i planet scripts/contract-check.mjs` returned
   * nothing across all 604 lines. This file covered eight world classes and
   * every `medieval/`, `citadel/`, `maze/` and `dock/` submodule, and then
   * printed "All contracts satisfied" while a rename of `worldClasses`,
   * `definePlanet`, `landableBodies`, `approachState` or `PlanetWorld.of`
   * sailed straight through. It was the largest unpinned surface in the repo
   * and it is about to grow by nine planets.
   *
   * Everything below is reached through an optional chain, through a name that
   * crosses `postMessage`, or through a regex in another script. Which is to
   * say: every failure mode in it is SILENT.
   * ══════════════════════════════════════════════════════════════════════════ */

  /* ONE class, every planet. `PlanetWorld.of(descriptor)` stamps a subclass
   * whose entire content is four statics, so a tenth planet costs a tenth
   * DESCRIPTOR and no code - and that is exactly what makes the names below
   * load-bearing in a way no other world's are. There is no `VolcanicWorld.js`
   * to fail loudly; there is a table and an optional chain.
   *
   * ── `statics` is a check this file did not have until this entry ─────────
   * and the reason it now does is `of`. The `methods` regex insists only on a
   * `(` after the name, and `for (const b of (P.liquid?.bodies ?? []))` on
   * line 830 of the world satisfies it - so `of` pinned as a method would have
   * been green against a file that had deleted `of` entirely. A pin that
   * cannot fail is worse than no pin, so `statics` matches `static of(` for
   * real.
   *
   * `id`, `displayName` and `planet` are pinned because they are the ENTIRE
   * content of a stamped subclass: `WorldManager` keys every registration on
   * `static id`, and `PlanetWorld.of` writes all three. If the class stops
   * declaring them, ten planets register as nothing.
   *
   * What this pin does NOT catch, and where that is caught instead: the file
   * declares `static id` three times - once on the base as the literal
   * `'planet'`, and again inside `of` as `descriptor.id` - so renaming only
   * the BASE one leaves the check green. That one matters on its own, because
   * `scripts/quest-vocab.mjs` scrapes it by regex (`PLANET_BASE`) to find the
   * base world it expands into the planets, and it used to fall back to the
   * string `'planet'` when the scrape failed: no base, no expansion, NO
   * PLANETS AT ALL in `VOCAB.worlds`, in silence. That fallback is now a
   * throw, in that file, next to the `PLANETS` scrape it belongs with.
   *
   * ── `fields` is the half that fails without a sound ──────────────────────
   * Every one of these is read through an optional chain by a system that
   * names no world:
   *   `planet`        `Piloting` (`active?.planet`) and every planet test; it
   *                   is the descriptor, and losing it is losing the world's
   *                   own dimensions.
   *   `groundAt`      the ONE height function - mesh, colliders and every prop
   *                   placement come out of it, and `planet-reach.test.mjs`
   *                   probes the flood-fill against it. Two descriptions of
   *                   one slope is the defect that let a player walk
   *                   underneath the visible world across 7% of Citadel.
   *   `landingSites`  `Piloting._descend` picks the pad out of
   *                   `w?.landingSites?.find((s) => s.primary)`. With no such
   *                   array the descent targets 0,0 - whatever is at 0,0.
   *   `mineralNodes`  `Mining._adopt` (`Array.isArray(w?.mineralNodes)`) and
   *                   `SpaceObjectives._learnElements` (`world?.mineralNodes`).
   *                   A rename is a planet with no ore, no prompt, no assay
   *                   objective and no error - which is the exact wording the
   *                   Mining header records having shipped once already.
   *   `gravity`       `Piloting._env` (`typeof w?.gravity === 'number'`), and
   *                   it FALLS BACK rather than throwing: the ship would fly
   *                   the yard's weight on a volcano.
   *   `bounds`        `Minimap` (`world?.bounds`) frames the map off it;
   *                   `Unstuck` (`active?.bounds`) clamps recovery to it.
   *   `minimapShapes` `Minimap` (`Array.isArray(world.minimapShapes)`). The
   *                   pads and the lava are the only marks on a planet's map.
   *   `census`        the ONE channel the per-planet triangle / draw-call /
   *                   collider count leaves the build on. Its only consumer
   *                   today is the build log in `PlanetWorld.build`, and it is
   *                   pinned as the declared shape of that report because nine
   *                   planets are about to be measured against it. It is the
   *                   weakest entry in this block and is named as such on
   *                   purpose - see the `worldClassFor` note below for what
   *                   this file does with a name that has NO consumer at all.
   */
  {
    file: 'src/worlds/PlanetWorld.js',
    exports: ['PlanetWorld'],
    statics: ['id', 'displayName', 'planet', 'of'],
    methods: ['build', 'update', 'onActivate', 'dispose'],
    fields: ['planet', 'groundAt', 'landingSites', 'mineralNodes', 'gravity',
      'bounds', 'census', 'minimapShapes'],
  },

  /* THE REGISTRY - and the one file in this subsystem that two DIFFERENT
   * consumers read in two different ways, only one of which is an import.
   *
   * `worldClasses` is what `main.js` imports and iterates to hand
   * `WorldManager` its registrations, and what `scripts/tests/_flightrig.mjs`
   * calls to build the same set headlessly. Rename it and no planet is
   * registered at all: every landable body in `Bodies.js` then names a world
   * that is not there, which `Piloting._resolveSurfaceWorld` turns into a ship
   * that bounces off an atmosphere. `getPlanet` at least throws on an unknown
   * id; `PLANETS` does not, which is why the id lookup is pinned beside it.
   *
   * `PLANETS` is ALSO scraped TEXTUALLY, by `scripts/quest-vocab.mjs`, and
   * that scrape understood exactly one shape: a computed `[BINDING.id]:` key
   * whose binding arrives on a relative import. A planet written `glass: ICE`,
   * or imported from a subfolder, used to vanish from `VOCAB.worlds` in
   * silence - which un-checked it in the "no registered world boots into
   * silence" test and in every quest-step world validation. It can no longer
   * do so quietly: `planetEntries()` in that file now THROWS on any `PLANETS`
   * object, or any entry inside one, that it cannot resolve. This entry pins
   * the module; that function pins the shape.
   *
   * ── NOT PINNED, DELIBERATELY: `worldClassFor(id)` ───────────────────────
   * It has ZERO consumers - one occurrence in the entire repo, which is its
   * own definition - and `WorldManager` already keys classes by id, so it is
   * redundant rather than pending. The right change is to DELETE it. It is
   * left unpinned rather than pinned because a contract entry would turn that
   * deletion into a red check, and this file must never become the reason
   * dead code survives. If it is still here when Phase 2 closes, delete it and
   * nothing above needs to change.
   */
  { file: 'src/worlds/planets/index.js', exports: ['PLANETS', 'getPlanet', 'worldClasses'] },

  /* THE VALIDATOR, and the vocabulary it validates against.
   *
   * `definePlanet` is the only way a descriptor is made, and the one thing
   * that refuses a closure or a `three` type inside `terrain` - which matters
   * because that block crosses `postMessage` VERBATIM to the generation
   * worker, and a function clones to `undefined`. The planet comes back flat
   * with nothing in the console, so the validator IS the error message.
   *
   * The four tables are pinned by name because they are the enumerations the
   * refusals are written against, and `planet-minerals.test.mjs` DRIVES every
   * refusal off them rather than restating them - a validator nobody has
   * watched throw is a validator nobody knows works. `MINERAL_RARITY` is a
   * LADDER (value, count and distance all have to agree with the word), not
   * four adjectives; `MINERAL_TERRAINS`, `REGION_SHAPES` and `PROP_KINDS` are
   * the closed sets a descriptor may name. Rename one and the check it backs
   * stops refusing, which is indistinguishable from a check that passes.
   *
   * `HOLD_UNITS_PER_SIZE` / `holdUnitsFor` are the one conversion between an
   * ore's bulk and a hull's hold, read back by `ship-customizer.test.mjs` and
   * `planet-minerals.test.mjs`. Two copies of that number is a hold that
   * silently stops filling at the wrong place. */
  {
    file: 'src/worlds/planets/PlanetDescriptor.js',
    exports: ['definePlanet', 'MINERAL_RARITY', 'MINERAL_TERRAINS',
      'HOLD_UNITS_PER_SIZE', 'holdUnitsFor', 'REGION_SHAPES', 'PROP_KINDS'],
  },

  /* WHERE THINGS ARE ALLOWED TO STAND. `scatter` is the rejection-sampled
   * placer every prop field and every mineral seam goes through; the
   * predicates under it are its filters, and three of them are imported
   * straight back by the tests (`planet-relief.test.mjs` takes `scatter`,
   * `polyDist` and `slopeDegAt`; `planet-reach.test.mjs` and
   * `planet-minerals.test.mjs` take `polyDist`) so the lava mask and the pad
   * clearance are measured with the ruler the placement used.
   *
   * `mulberry32` is pinned with them because the placement is SEEDED: it is
   * the reason two builds of one planet put the ore in the same place, and a
   * silent swap of the generator would make every reachability probe a probe
   * of a different world than the one that ships.
   *
   * A rename here does not throw. It is ore inside a lava lake, or on an
   * 80-degree crater wall - placed, counted, reported, and unreachable, which
   * is this project's signature defect. */
  {
    file: 'src/worlds/planets/Placement.js',
    exports: ['scatter', 'mulberry32', 'slopeDegAt', 'polyDist',
      'liquidClearance', 'padClearance'],
  },

  /* The two builders `PlanetWorld` calls by name, and nothing else does.
   * `buildPropField` returns the placed/requested/collider census the budget
   * line is summed from; `buildPlumes` is the vent animation. Renamed, a
   * planet builds with no props and no plumes, reports a SMALLER census than
   * it should, and every existing assertion about it stays green - because
   * nothing in the suite pins the number a planet is supposed to reach. */
  { file: 'src/worlds/planets/PlanetProps.js', exports: ['buildPropField', 'buildPlumes'] },

  /* The lava and the water. `PlanetWorld` imports the two materials and the
   * body geometry; `planet-relief.test.mjs` imports `SKIRT` and
   * `discRadiusAt` back so the shore is measured against the number the mesh
   * was actually built with rather than a second copy of it. A liquid body
   * whose geometry helper is renamed is a lake that does not render and a
   * shoreline nothing tests - and the lava mask is what `Placement` keeps ore
   * out of, so the failure is not only cosmetic. */
  {
    file: 'src/worlds/planets/PlanetLiquid.js',
    exports: ['createLiquidMaterial', 'createSkirtMaterial', 'bodyGeometry',
      'discRadiusAt', 'SKIRT'],
  },

  /* THE CROSS-THREAD SEAM - the second one in this repo after
   * `CitadelHeight.js`, and registered for exactly the reason that one is.
   *
   * `terrain/index.js` maps the job name `planet` to `planetHeight`, and the
   * generation worker imports that registry DIRECTLY (it may not import
   * `three`). `PlanetWorld` resolves the same entry on the main thread, so the
   * drawn mesh, the collision heightfield and every prop placement come from
   * one evaluation of one function. Rename `HEIGHT_FIELDS`, its `planet` key
   * or `planetHeight` and it splits back into two descriptions of one surface,
   * in two threads, with no error anywhere - which is the state that let a
   * player walk UNDERNEATH the visible world across 7% of Citadel.
   *
   * `HEIGHT_FIELDS` is registered here rather than beside `CitadelHeight.js`
   * because the `planet` entry is the only one in it that takes PARAMETERS:
   * medieval and citadel each name one piece of ground, a planet does not, and
   * that factory signature is what makes a tenth planet cost a descriptor.
   *
   * `LANDFORM_KINDS` is the vocabulary `definePlanet` refuses unknown kinds
   * against and `planet-relief.test.mjs` counts by name; `fbm` is imported
   * back by `PlanetWorld` for the terrain colour bands, so the rock reads as
   * the same noise the shape was cut from rather than a second one that looks
   * nearly right. */
  { file: 'src/worlds/terrain/index.js', exports: ['HEIGHT_FIELDS'] },
  {
    file: 'src/worlds/terrain/PlanetHeight.js',
    exports: ['planetHeight', 'LANDFORM_KINDS', 'fbm', 'ridged', 'vnoise',
      'hash2', 'clamp01', 'smoothstep', 'arclength'],
  },

  /* WHERE EVERYTHING IS, and the interface the planet system talks to space
   * through. Eleven modules import this file and not one of them re-derives
   * anything in it - which is the point, and which is why a rename here is a
   * subsystem going quiet rather than a stack trace.
   *
   *   `SPACE_BODIES` / `BODY_BY_ID`  the layout. Every test that flies flies
   *       to a body out of these two.
   *   `landableBodies`  the set `piloting-loop.test.mjs` walks to prove every
   *       landable body names a REGISTERED world. It is the only thing
   *       standing between this branch and twelve planets a player can fly at
   *       forever - the built-but-unreachable defect, at system scale.
   *   `approachState` / `APPROACH_PHASE`  the per-frame answer to "which body
   *       am I falling towards, and how far in". `Piloting` acts on
   *       `shouldHandoff` to activate the surface world; the whole call site
   *       is optional-chained, so a rename is a ship that never lands.
   *   `navTargets`  what the HUD draws markers from instead of reaching into
   *       `SpaceWorld`. No markers, no way home, no error.
   *   `DOCK_ANCHOR`  the yard's position, mouth, berths and `apronSpawn` -
   *       read by the exterior geometry, the return portal, the HUD home
   *       marker and `space-yard-reach.test.mjs`, which floods the deck from
   *       that exact point.
   *   `BELT`  what `Belt.js` builds Halberd Reach from.
   *   `PRIMARY` / `STAR_DIRECTION`  the single statement of where the light
   *       comes from, imported back by `DockWorld` so the sky over the yard
   *       and the sky in the void cannot disagree about the time of day. */
  {
    file: 'src/worlds/space/Bodies.js',
    exports: ['SPACE_BODIES', 'BODY_BY_ID', 'PRIMARY', 'STAR_DIRECTION',
      'DOCK_ANCHOR', 'BELT', 'APPROACH_PHASE', 'approachState',
      'landableBodies', 'navTargets'],
  },

  /* HOW 800 KM FITS INSIDE A 2,000 M FAR PLANE. Pure arithmetic, no `three`,
   * and the only reason a body 640 km away is drawn at all: distant objects
   * are re-placed each frame at a proxy distance with their radius scaled by
   * the same factor, so the angle they subtend is preserved and the depth
   * buffer never sees the real number. `SpaceWorld` and `Backdrop` place
   * everything distant through `proxyPlacement`, and `space-scale.test.mjs`
   * re-derives the entire scheme off these names.
   *
   * A rename does not throw - it drops the proxy step - and the result is
   * every planet either clipped through the far plane or z-fighting the dock.
   * The bands (`NEAR_FIELD`, `PROXY_MAX`, `FAR_SAFE`, `DEPTH_HORIZON`) are
   * pinned with the functions because they are what the test asserts the
   * placement lands INSIDE; without them the assertions have no ruler. */
  {
    file: 'src/worlds/space/Scale.js',
    exports: ['proxyDistance', 'proxyPlacement', 'angularRadius', 'screenFraction',
      'NEAR_FIELD', 'PROXY_MAX', 'FAR_SAFE', 'DEPTH_HORIZON'],
  },

  /* The three modules that make the void read as a volume rather than a
   * skybox. `Backdrop` is the per-frame re-placer - `add` / `addBody` /
   * `addStructure` are the three registration calls `SpaceWorld` makes, and
   * `report` is what `space-backdrop.test.mjs` audits the render ORDER with,
   * because a backdrop that sorts wrong draws a moon in front of the planet it
   * orbits and nothing throws. `Belt` builds Halberd Reach out of `BELT` and
   * owns the instanced rock geometry, so its `dispose` is load-bearing rather
   * than decorative. `BodyShaders` are the four analytic materials every disc,
   * halo, ring and corona in the game is drawn with, and `DockWorld` imports
   * three of them BACK so the sky over the yard is literally the same sky. */
  {
    file: 'src/worlds/space/Backdrop.js',
    exports: ['Backdrop'],
    methods: ['add', 'addBody', 'addStructure', 'update', 'report'],
  },
  { file: 'src/worlds/space/Belt.js', exports: ['Belt'], methods: ['update', 'dispose'] },
  {
    file: 'src/worlds/space/BodyShaders.js',
    exports: ['makeBodyMaterial', 'makeAtmosphereMaterial', 'makeRingMaterial',
      'makeCoronaMaterial'],
  },

  /* THE MODE THAT JOINS THE YARD, THE VOID AND THE PLANET INTO ONE LOOP.
   *
   * `_resolveSurfaceWorld` is pinned in spite of the underscore, and it is the
   * most important name in this entry: it is the seam between what
   * `Bodies.js` calls a surface (`'planet:cinder'`) and what
   * `planets/index.js` registers (`'cinder'`), it is called DIRECTLY by
   * `piloting-loop.test.mjs` case 1, and it is the single point at which a
   * body naming a world nobody registered becomes a console error instead of
   * a ship bouncing off an atmosphere forever. With nine planets landing, that
   * seam is crossed nine more times.
   *
   * `stow` and `sellCargo` are the two ends of the mining loop - `Mining`
   * calls `piloting?.stow?.(node)` through an optional chain, so a rename is
   * ore that mines, disappears, and is never in the hold.
   *
   * The constants are pinned because `piloting-loop.test.mjs` and
   * `piloting-return.test.mjs` FLY against them by name rather than restating
   * them: `LAUNCH_Z`, `SPACE_ARRIVAL_OUT`, `DOCK_RANGE`, `DOCK_SPEED`,
   * `LAND_SPEED`, `TOUCH_CLEAR` and `SEAM_COOLDOWN` are the geometry of every
   * seam in the loop, and a rename would leave both files measuring
   * `undefined`. `FLIGHT_WORLDS` is the list of worlds flight is legal in and
   * `pilot-mode-guards.test.mjs` is built on it.
   *
   * MID-CHANGE, NOT PINNED: the Transit Drive is being written as this lands.
   * `TRANSIT_MAX`, `TRANSIT_RAMP` and `TRANSIT_CLEAR` predate it and are read
   * by the flight tests, so they are pinned; `TRANSIT_KEY`, `TRANSIT_REASONS`
   * and `TRANSIT_DOCK_LOCK` arrived with that work and should join this list
   * when it settles. */
  {
    file: 'src/ships/Piloting.js',
    exports: ['Piloting', 'FLIGHT_WORLDS', 'LAUNCH_Z', 'SPACE_ARRIVAL_OUT',
      'DOCK_RANGE', 'DOCK_SPEED', 'SEAM_COOLDOWN', 'ENTRY_ALT', 'ENTRY_OUT',
      'DEPART_ALT', 'TOUCH_CLEAR', 'LAND_SPEED', 'YARD_GRAVITY',
      'TRANSIT_MAX', 'TRANSIT_RAMP', 'TRANSIT_CLEAR'],
    methods: ['board', 'disembark', 'boardableAt', 'fixedUpdate', 'update',
      'stow', 'sellCargo', 'navReport', 'report', 'serialize', 'deserialize',
      'dispose', '_resolveSurfaceWorld'],
  },

  /* The integrator. `FLIGHT` is the tuning table every derived speed comes out
   * of, and `cruiseTopSpeed` / `boostTopSpeed` / `turnRadius` /
   * `transitSpeedLimit` are the derivations - `_flightrig.mjs`,
   * `ship-flight.test.mjs`, `piloting-loop.test.mjs` and
   * `planet-minerals.test.mjs` all fly and cost journeys against them rather
   * than against a number typed twice. That matters more here than anywhere
   * else in this block: `Bodies.js` was laid out against an ASSUMED cruise
   * speed once already, and the result was an 8.6-minute flight to the one
   * planet the whole loop exists to reach.
   *
   * `blankCommand` is the shape `setCommand` merges into and the keyboard
   * writes; `readInput` is the only place input becomes a command; `step` is
   * the fixed step; `snapshot` is what the HUD reads. `TRANSIT_STATE` is the
   * enum the transit governor and its HUD readout share. */
  {
    file: 'src/ships/Flight.js',
    exports: ['Flight', 'FLIGHT', 'cruiseTopSpeed', 'boostTopSpeed', 'turnRadius',
      'transitSpeedLimit', 'TRANSIT_STATE', 'blankCommand'],
    methods: ['setShip', 'setCommand', 'readInput', 'step', 'place', 'halt',
      'snapshot', 'forward', 'up', 'right'],
  },

  /* `world.mineralNodes` -> a prompt, a hold and a payout, and the module's
   * own header records the state it was written to end: *"Mining is not wired
   * - `world.mineralNodes` is published with nothing reading it."*
   * `Mining._adopt` still reads the world through
   * `Array.isArray(w?.mineralNodes)`, so this system finding nothing looks
   * exactly like a planet with no ore on it.
   *
   * `MINE_RANGE` and `MINE_TIME` are imported back by
   * `space-objectives.test.mjs` and `planet-minerals.test.mjs` to cost a
   * mining tour in seconds and turn it into credits per minute - the one
   * measurement that says whether the rarity ladder is real or decoration. A
   * rename takes that measurement with it and leaves the test green. */
  {
    file: 'src/systems/Mining.js',
    exports: ['Mining', 'MINE_RANGE', 'MINE_TIME'],
    methods: ['nearest', 'mine', 'update', 'serialize', 'deserialize', 'dispose'],
  },
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

  /* PUBLISHED FIELDS, not methods.
   *
   * A world's contract with the rest of the engine is mostly an array it hangs
   * on itself: `RaceManager` reads `trackPath`, `MinigameManager` reads
   * `minigameVenues`, `Relics` reads `_roofs` and `_towers`, `Viewpoints` reads
   * `viewpoints`, and the trials and the minimap read `ropeBridges`. None of
   * those is a method, so the `methods` regex above - which insists on a `(` -
   * cannot see any of them, and this file reported "all contracts satisfied"
   * while pinning only the class name. Renaming one is a whole system quietly
   * finding nothing, one browser boot later.
   */
  for (const f of entry.fields ?? []) {
    if (!new RegExp(`this\\.${f}\\b`).test(src)) {
      problems.push(`${entry.file}: missing published field "this.${f}"`);
    }
  }

  /* CLASS STATICS, which are neither exports nor instance members.
   *
   * Added for `PlanetWorld`, where the whole registration mechanism lives in
   * four of them: `WorldManager` keys on `static id`, `scripts/quest-vocab.mjs`
   * SCRAPES `static id` textually to find the base world it expands into the
   * planets, and `static of(descriptor)` is the factory that stamps one
   * subclass per planet.
   *
   * `of` is the reason this is a separate check rather than another entry in
   * `methods`. That regex asks only for a `(` somewhere after the name, and
   * `for (const b of (P.liquid?.bodies ?? []))` supplies one - so `of` listed
   * as a method would have reported green against a file that had deleted the
   * factory outright. A pin that cannot fail is worse than no pin, because it
   * is counted.
   */
  for (const s of entry.statics ?? []) {
    if (!new RegExp(`static\\s+(?:get\\s+)?${s}\\b`).test(src)) {
      problems.push(`${entry.file}: missing class static "static ${s}"`);
    }
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
