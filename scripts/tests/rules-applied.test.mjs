import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

/* Textual, not behavioural: these modules touch document/canvas/WebGL at module
 * scope and cannot be imported under Node - the same reason
 * scripts/contract-check.mjs verifies the API surface by reading source. What
 * this guards is the boring failure that actually happens: the gate gets added
 * to eleven files and forgotten in the twelfth.
 *
 * Comments are stripped before matching. A flag name mentioned only in a
 * comment - e.g. left behind after the real `allows(...)` call it annotated
 * was deleted - must not satisfy this test: the point is to prove a live gate
 * exists, not that someone once wrote the word. */
const GATES = [
  ['src/systems/Loot.js', 'loot'],
  ['src/systems/Caches.js', 'caches'],
  ['src/systems/Relics.js', 'relics'],
  ['src/systems/Contracts.js', 'contracts'],
  ['src/systems/Marketplace.js', 'merchants'],
  ['src/systems/QuestSystem.js', 'quests'],
  ['src/systems/Interiors.js', 'interiors'],
  ['src/systems/WaterVolumes.js', 'swim'],
  ['src/race/RaceManager.js', 'races'],
  ['src/npc/NPCManager.js', 'hostiles'],
  ['src/mounts/MountManager.js', 'mounts'],
  ['src/player/Loadout.js', 'weapons'],
  ['src/player/Player.js', 'climb'],
  ['src/ui/HUD.js', 'weapons'],
];

function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

for (const [file, flag] of GATES) {
  test(`${file} honours ${flag}`, async () => {
    const src = await readFile(path.join(root, file), 'utf8');
    const code = stripComments(src);
    assert.match(
      code,
      new RegExp(String.raw`allows\(\s*[^,()]*(\([^)]*\))?[^,]*,\s*['"]${flag}['"]\s*\)`),
      `${file} has no allows(..., '${flag}') gate outside comments`,
    );
    assert.match(
      code,
      /import\s*\{[^}]*\ballows\b[^}]*\}\s*from\s*['"][^'"]*WorldRules\.js['"]/,
      `${file} never imports allows from WorldRules.js`,
    );
  });
}

test('Player also gates parkour', async () => {
  const src = await readFile(path.join(root, 'src/player/Player.js'), 'utf8');
  const code = stripComments(src);
  assert.match(
    code,
    /allows\(\s*[^,()]*(\([^)]*\))?[^,]*,\s*['"]parkour['"]\s*\)/,
    'Player has no allows(..., \'parkour\') gate outside comments',
  );
});

test('Loadout.js hides the viewmodel when weapons are forbidden', async () => {
  // A gate that only stops switching (`select`) is not enough on its own - the
  // weapon selected before the gate went up would stay drawn forever. This
  // proves a second, distinct path exists that actually hides it.
  const src = await readFile(path.join(root, 'src/player/Loadout.js'), 'utf8');
  const code = stripComments(src);
  assert.match(
    code,
    /if\s*\(\s*!allows\(\s*this\._world\s*,\s*['"]weapons['"]\s*\)\s*\)\s*\{[^}]*setVisible\?\.\(false\)/,
    'Loadout.js has no world-change path that hides the viewmodel when weapons are forbidden',
  );
});

test('MazeWorld declares itself volatile and forbids the right things', async () => {
  const src = await readFile(path.join(root, 'src/worlds/MazeWorld.js'), 'utf8');
  assert.ok(src.includes('static volatile = true'), 'MazeWorld must be volatile');
  assert.ok(src.includes("static id = 'maze'"), 'MazeWorld needs its id');
  for (const flag of ['weapons', 'mounts', 'climb', 'parkour', 'merchants', 'quests',
                      'contracts', 'caches', 'relics', 'loot', 'races', 'interiors',
                      'hostiles', 'swim']) {
    assert.ok(new RegExp(`${flag}:\\s*false`).test(src), `MazeWorld does not forbid ${flag}`);
  }
  // Jump must NOT be forbidden - the geometry makes it useless, not the input.
  assert.ok(!/jump:\s*false/.test(src), 'MazeWorld must not disable jumping');
});

test('WorldManager honours volatile worlds', async () => {
  const src = await readFile(path.join(root, 'src/worlds/WorldManager.js'), 'utf8');
  assert.ok(src.includes('volatile'), 'WorldManager never mentions volatile');
});

test('the station offers a portal to the maze', async () => {
  const src = await readFile(path.join(root, 'src/worlds/StationWorld.js'), 'utf8');
  assert.ok(src.includes("target: 'maze'"), 'no station gateway to the maze');
});

test('main.js registers the maze world', async () => {
  const src = await readFile(path.join(root, 'src/main.js'), 'utf8');
  assert.ok(src.includes('MazeWorld'), 'MazeWorld is not registered');
});

test('the signage atlas has exactly one cell per sign', async () => {
  /* paintSignAtlas loops i < SIGN_COLS * SIGN_ROWS and destructures SIGNS[i]
   * unconditionally. One entry short throws "Cannot destructure" at boot; one
   * entry long is silently dropped and the sign it belonged to never appears.
   * Both are easy to cause when adding a gateway and neither is easy to spot,
   * so the invariant is asserted rather than remembered. */
  const kit = await readFile(path.join(root, 'src/worlds/station/StationKit.js'), 'utf8');
  const cols = Number(kit.match(/SIGN_COLS\s*=\s*(\d+)/)[1]);
  const rows = Number(kit.match(/SIGN_ROWS\s*=\s*(\d+)/)[1]);

  const station = await readFile(path.join(root, 'src/worlds/StationWorld.js'), 'utf8');
  const body = station.match(/const SIGNS = \[([\s\S]*?)\n\];/)[1];
  const entries = (body.match(/^\s*\['/gm) ?? []).length;

  assert.equal(entries, cols * rows,
    `SIGNS has ${entries} entries but the atlas has ${cols * rows} cells`);
});

test('every SIGN_ROLE points at a real sign', async () => {
  const station = await readFile(path.join(root, 'src/worlds/StationWorld.js'), 'utf8');
  const body = station.match(/const SIGNS = \[([\s\S]*?)\n\];/)[1];
  const entries = (body.match(/^\s*\['/gm) ?? []).length;
  const roles = station.match(/const SIGN_ROLE = \{([\s\S]*?)\n\};/)[1];
  for (const m of roles.matchAll(/(\w+):\s*(\d+)/g)) {
    assert.ok(Number(m[2]) < entries, `SIGN_ROLE.${m[1]} = ${m[2]} is past the end of SIGNS`);
  }
});
