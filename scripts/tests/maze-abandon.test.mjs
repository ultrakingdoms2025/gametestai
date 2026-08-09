import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AbandonHold, ABANDON_HOLD_S } from '../../src/worlds/maze/MazeAbandon.js';

const STEP = 1 / 60;

test('the hold is two seconds, per the spec', () => {
  assert.equal(ABANDON_HOLD_S, 2.0);
});

test('a full hold fires exactly once, at the stated time', () => {
  const h = new AbandonHold();
  let fired = 0, firedAt = 0, elapsed = 0;
  for (let i = 0; i < 300; i++) {
    const r = h.update(STEP, true);
    elapsed += STEP;
    if (r.fired) { fired++; firedAt = elapsed; }
  }
  assert.equal(fired, 1,
    `fired ${fired} times - a held key firing every frame would abandon the run sixty times a second`);
  assert.ok(Math.abs(firedAt - ABANDON_HOLD_S) < 0.05, `fired at ${firedAt.toFixed(3)}s`);
});

test('releasing early resets, so a fumble costs nothing', () => {
  const h = new AbandonHold();
  for (let i = 0; i < 60; i++) assert.equal(h.update(STEP, true).fired, false);
  assert.equal(h.update(STEP, false).progress, 0, 'progress survived a release');
  // A second hold must start from zero, or a fumble plus a tap would abandon.
  let fired = false;
  for (let i = 0; i < 60; i++) fired = fired || h.update(STEP, true).fired;
  assert.equal(fired, false, 'the second hold inherited the first one');
});

test('progress runs 0 to 1 monotonically, so the HUD can draw it', () => {
  const h = new AbandonHold();
  const seen = [];
  for (let i = 0; i < 130; i++) seen.push(h.update(STEP, true).progress);
  assert.ok(seen[0] > 0 && seen[0] < 0.05, `first frame was ${seen[0]}`);
  assert.ok(Math.max(...seen) <= 1.0001, 'progress exceeded 1');
  for (let i = 1; i < seen.length; i++) {
    assert.ok(seen[i] >= seen[i - 1], `progress went backwards at frame ${i} while held`);
  }
});

test('a hold that completes and continues stays fired, without re-firing', () => {
  const h = new AbandonHold();
  let fires = 0;
  for (let i = 0; i < 600; i++) if (h.update(STEP, true).fired) fires++;
  assert.equal(fires, 1, `ten seconds of holding fired ${fires} times`);
});

test('after firing, a release and a fresh full hold fires again', () => {
  // Leaving and re-entering the maze must not need a page reload.
  const h = new AbandonHold();
  for (let i = 0; i < 300; i++) h.update(STEP, true);
  h.update(STEP, false);
  let fires = 0;
  for (let i = 0; i < 300; i++) if (h.update(STEP, true).fired) fires++;
  assert.equal(fires, 1, 'a second run could not be abandoned');
});
