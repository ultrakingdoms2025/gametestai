import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PALETTES, statLine, skinState } from '../../src/ui/MountMenuLogic.js';

test('every palette the mounts reference exists and is non-empty', () => {
  for (const k of ['paint', 'wheel', 'natural', 'glow']) assert.ok(PALETTES[k]?.length >= 6, k);
});

test('statLine reads the tier ladder', () => {
  assert.equal(statLine('power', 0), 'Not upgraded — buy at market (B)');
  assert.equal(statLine('power', 2), '+24% top speed');
  assert.equal(statLine('fire', 3), '+45% fireball damage while riding');
});

test('skinState: equipped > owned > held > locked', () => {
  const skin = { id: 'bike_racing', livery: { frame: { color: 0xc21f2f, finish: 'gloss' }, rims: { color: 0x0d0f12, finish: 'matt' } } };
  const eq = { frame: { color: 0xc21f2f, finish: 'gloss' }, rims: { color: 0x0d0f12, finish: 'matt' } };
  assert.equal(skinState({ skin, owned: true, held: 0, livery: eq }), 'equipped');
  assert.equal(skinState({ skin, owned: true, held: 0, livery: {} }), 'owned');
  assert.equal(skinState({ skin, owned: false, held: 1, livery: eq }), 'held');
  assert.equal(skinState({ skin, owned: false, held: 0, livery: {} }), 'locked');
});
