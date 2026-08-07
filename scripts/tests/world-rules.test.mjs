import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_RULES, makeRules } from '../../src/worlds/WorldRules.js';

const GATED = [
  'weapons', 'mounts', 'climb', 'parkour', 'merchants', 'quests',
  'contracts', 'caches', 'relics', 'loot', 'races', 'interiors',
  'hostiles', 'swim', 'jump',
];

test('every gated capability has a default and defaults to permitted', () => {
  for (const key of GATED) {
    assert.ok(key in DEFAULT_RULES, `missing rule: ${key}`);
    assert.equal(DEFAULT_RULES[key], true, `${key} should default to permitted`);
  }
});

test('defaults are frozen', () => {
  assert.throws(() => { DEFAULT_RULES.weapons = false; }, TypeError);
});

test('makeRules merges over the defaults', () => {
  const r = makeRules({ weapons: false, mounts: false });
  assert.equal(r.weapons, false);
  assert.equal(r.mounts, false);
  assert.equal(r.loot, true);
});

test('makeRules result is frozen', () => {
  const r = makeRules({ weapons: false });
  assert.throws(() => { r.weapons = true; }, TypeError);
});

test('makeRules rejects an unknown key', () => {
  // A typo here would silently permit the thing it meant to forbid.
  assert.throws(() => makeRules({ merchant: false }), /unknown world rule: merchant/);
});

test('makeRules with no argument returns the permissive defaults', () => {
  assert.deepEqual({ ...makeRules() }, { ...DEFAULT_RULES });
});

test('the maze rule set forbids exactly what the spec says', () => {
  const maze = makeRules({
    weapons: false, mounts: false, climb: false, parkour: false,
    merchants: false, quests: false, contracts: false, caches: false,
    relics: false, loot: false, races: false, interiors: false,
    hostiles: false, swim: false,
  });
  // Jump is retained on purpose: disabling climbing does not disable jumping.
  assert.equal(maze.jump, true);
  for (const key of GATED) {
    if (key === 'jump') continue;
    assert.equal(maze[key], false, `${key} should be forbidden in the maze`);
  }
});
