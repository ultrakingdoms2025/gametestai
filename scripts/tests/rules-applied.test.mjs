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
