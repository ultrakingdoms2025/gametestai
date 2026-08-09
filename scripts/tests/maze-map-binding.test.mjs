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

test('THE NO-MARKER GATE: MazeMap never reads a player position', async () => {
  /* The map deliberately does not say where you are - spec section 7, and the
   * reason it does not trivialise a 2.4 km maze that re-rolls every entry.
   * It is also the first thing anyone would add to be helpful, so this asserts
   * the INGREDIENTS are absent rather than trusting a comment to hold. */
  const src = await readFile(path.join(root, 'src/ui/MazeMap.js'), 'utf8');
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  for (const forbidden of [/player\s*\.\s*position/, /playerSpawn/, /youAreHere/i, /\bmarker\b/i]) {
    assert.ok(!forbidden.test(code),
      `MazeMap.js code mentions ${forbidden} - the map must not show where the player is`);
  }
});

test('MazeMap draws from the topology array, never from geometry', async () => {
  const src = await readFile(path.join(root, 'src/ui/MazeMap.js'), 'utf8');
  assert.ok(src.includes('levelSegments'), 'MazeMap does not use levelSegments');
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  for (const forbidden of [/districtColliders/, /shaftColliders/, /\.chunks\b/]) {
    assert.ok(!forbidden.test(code),
      `MazeMap.js reads ${forbidden} - geometry exists only for streamed districts, so a map drawn `
      + 'from it would be a map of wherever the player happens to be standing');
  }
});

test('rebinding the map action moves BOTH consumers, not just one', async () => {
  /* The claim the contextual key rests on. Both consumers own their own
   * keydown listener (they must keep working when Input has stopped
   * reporting), so both have to ask `codeFor` rather than hard-code KeyM. */
  for (const f of ['src/ui/MazeMap.js', 'src/ui/MountWheel.js']) {
    const src = await readFile(path.join(root, f), 'utf8');
    assert.ok(/codeFor\?\.\('map'\)|codeFor\('map'\)/.test(src),
      `${f} does not resolve the map action through Input.codeFor - a rebind would move the other `
      + 'consumer and leave this one on M');
  }
});

test('M is no longer listed as an unbindable fixed key', async () => {
  // It became a BINDABLE action, so the panel would otherwise show it twice
  // and claim it cannot be changed.
  const src = await readFile(path.join(root, 'src/ui/KeybindMenu.js'), 'utf8');
  assert.ok(!/key:\s*'M'/.test(src), 'KeybindMenu still lists M among FIXED_KEYS');
});
