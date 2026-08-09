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
  { file: 'src/worlds/MedievalWorld.js', exports: ['MedievalWorld'], methods: ['build'] },
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
  { file: 'src/worlds/maze/MazeChunks.js', exports: ['MazeChunks', 'buildBoxInstances'] },
  /* Phase 3. `MazePlan.js` is pure so both map surfaces derive their walls
   * from one definition; `MazeMap.js` is the M-key overlay that draws them. */
  { file: 'src/worlds/maze/MazePlan.js', exports: ['planCacheKey', 'levelSegments'] },
  { file: 'src/ui/MazeMap.js', exports: ['MazeMap'] },
  { file: 'src/worlds/maze/MazeCanopy.js', exports: ['MazeCanopy'] },
  { file: 'src/worlds/MazeWorld.js', exports: ['MazeWorld'], methods: ['build', 'dispose'] },
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
