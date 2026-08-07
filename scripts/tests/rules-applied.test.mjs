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
 * to eleven files and forgotten in the twelfth. */
const GATES = [
  ['src/systems/Loot.js', 'rules.loot'],
  ['src/systems/Caches.js', 'rules.caches'],
  ['src/systems/Relics.js', 'rules.relics'],
  ['src/systems/Contracts.js', 'rules.contracts'],
  ['src/systems/Marketplace.js', 'rules.merchants'],
  ['src/systems/QuestSystem.js', 'rules.quests'],
  ['src/systems/Interiors.js', 'rules.interiors'],
  ['src/systems/WaterVolumes.js', 'rules.swim'],
  ['src/race/RaceManager.js', 'rules.races'],
  ['src/npc/NPCManager.js', 'rules.hostiles'],
  ['src/mounts/MountManager.js', 'rules.mounts'],
  ['src/player/Loadout.js', 'rules.weapons'],
  ['src/player/Player.js', 'rules.climb'],
];

for (const [file, flag] of GATES) {
  test(`${file} honours ${flag}`, async () => {
    const src = await readFile(path.join(root, file), 'utf8');
    assert.ok(src.includes(flag), `${file} never mentions ${flag}`);
  });
}

test('Player also gates parkour', async () => {
  const src = await readFile(path.join(root, 'src/player/Player.js'), 'utf8');
  assert.ok(src.includes('rules.parkour'), 'Player never mentions rules.parkour');
});
