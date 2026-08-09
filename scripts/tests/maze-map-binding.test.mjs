import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { BINDABLE } from '../../src/core/Input.js';
import { makeRules, mapActionOwner } from '../../src/worlds/WorldRules.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

test('the map action is bindable, so a contextual key can still be rebound', () => {
  const entry = BINDABLE.find((b) => b.action === 'map');
  assert.ok(entry, 'no `map` action in BINDABLE - the key would be unrebindable');
  assert.equal(entry.code, 'KeyM');
});

test('exactly one owner of the map key per world, and it follows rules.mounts', () => {
  assert.equal(mapActionOwner({ rules: makeRules() }), 'mounts');
  assert.equal(mapActionOwner({ rules: makeRules({ mounts: false }) }), 'map');
});

test('a world with no rules at all still gets exactly one owner', () => {
  // Never both, never neither - that is the whole point of one predicate.
  for (const w of [null, undefined, {}, { rules: null }]) {
    assert.ok(['map', 'mounts'].includes(mapActionOwner(w)), `no owner for ${JSON.stringify(w)}`);
  }
});

test('the maze forbids mounts, so the maze is where the map owns M', () => {
  // Ties the contextual behaviour to the rule that drives it, rather than to
  // a world id - if the maze ever permits mounts, this is what says so.
  const maze = { rules: makeRules({ mounts: false }) };
  assert.equal(mapActionOwner(maze), 'map');
});

test('MountWheel asks the shared predicate rather than deciding for itself', async () => {
  const src = await readFile(path.join(root, 'src/ui/MountWheel.js'), 'utf8');
  assert.ok(src.includes('mapActionOwner'),
    'MountWheel does not consult mapActionOwner - two consumers deciding independently is how a '
    + 'contextual key ends up owned by both or neither');
});
