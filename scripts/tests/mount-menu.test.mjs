import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PALETTES, statLine, skinState } from '../../src/ui/MountMenuLogic.js';
import { Car } from '../../src/mounts/Car.js';
import { Dragon } from '../../src/mounts/Dragon.js';
import { Eagle } from '../../src/mounts/Eagle.js';
import { Horse } from '../../src/mounts/Horse.js';
import { Hoverboard } from '../../src/mounts/Hoverboard.js';
import { Bicycle } from '../../src/mounts/Bicycle.js';

test('every palette the mounts reference exists and is non-empty', () => {
  for (const k of ['paint', 'wheel', 'natural', 'glow']) assert.ok(PALETTES[k]?.length >= 6, k);
});

test('every mount CUSTOM_SLOTS default colour is a member of its own palette', () => {
  // A factory colour missing from its own palette opens the F10 menu with the
  // custom picker lit instead of a swatch, for every player of that mount.
  const CLASSES = { Car, Dragon, Eagle, Horse, Hoverboard, Bicycle };
  for (const [name, C] of Object.entries(CLASSES)) {
    for (const s of C.CUSTOM_SLOTS) {
      const hex = `#${s.defaultColor.toString(16).padStart(6, '0')}`;
      assert.ok(
        PALETTES[s.palette]?.includes(s.defaultColor),
        `${name}.${s.id}: default colour ${hex} is not in palette '${s.palette}'`
      );
    }
  }
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
