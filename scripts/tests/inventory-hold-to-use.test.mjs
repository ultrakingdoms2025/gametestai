import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { HoldToUse, HOLD_TO_USE_MS, HOLD_ABORT_SWALLOW_MS } from '../../src/ui/HoldToUse.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..', '..');

test('a hold fires exactly once, on the tick that reaches three seconds', () => {
  const h = new HoldToUse();
  h.begin('bag:medkit', 1000);
  assert.equal(h.active, true);

  const early = h.advance(1000 + HOLD_TO_USE_MS - 1);
  assert.equal(early.fired, false);
  assert.ok(early.progress < 1);
  assert.equal(h.active, true);

  const done = h.advance(1000 + HOLD_TO_USE_MS);
  assert.equal(done.fired, true);
  assert.equal(done.progress, 1);
  assert.equal(h.active, false, 'the hold ends on the tick that fires');

  const after = h.advance(1000 + HOLD_TO_USE_MS + 500);
  assert.equal(after.fired, false, 'never fires twice for one press');
});

test('the countdown reads 3, 2, 1 and never shows 0 while still counting', () => {
  const h = new HoldToUse();
  h.begin('bag:medkit', 0);
  assert.equal(h.advance(0).seconds, 3);
  assert.equal(h.advance(999).seconds, 3);
  assert.equal(h.advance(1000).seconds, 2);
  assert.equal(h.advance(2001).seconds, 1);
  assert.equal(h.advance(2999).seconds, 1);
  assert.equal(h.advance(3000).seconds, 0);
});

test('progress is linear in elapsed time', () => {
  const h = new HoldToUse();
  h.begin('bag:medkit', 0);
  assert.equal(h.advance(0).progress, 0);
  assert.equal(h.advance(1500).progress, 0.5);
  assert.equal(h.advance(2250).progress, 0.75);
});

test('a quick release is a click: nothing fires and the click goes through', () => {
  const h = new HoldToUse();
  h.begin('bag:medkit', 0);
  h.advance(120);
  h.cancel(140);
  assert.equal(h.active, false);
  assert.equal(h.swallowClick, false, 'a tap must still move the stack');
});

test('a press abandoned after the swallow threshold is not a click', () => {
  const h = new HoldToUse();
  h.begin('bag:medkit', 0);
  h.advance(1000);
  h.cancel(1200);
  assert.equal(h.active, false);
  assert.equal(h.swallowClick, true, 'letting go mid-hold must not move the stack');
  assert.ok(HOLD_ABORT_SWALLOW_MS < 1200);
  h.release();
  assert.equal(h.swallowClick, false, 'the swallow lasts one press only');
});

test('a completed hold swallows the trailing click, and release clears it', () => {
  const h = new HoldToUse();
  h.begin('bag:medkit', 0);
  assert.equal(h.advance(HOLD_TO_USE_MS).fired, true);
  assert.equal(h.swallowClick, true);
  h.release();
  assert.equal(h.swallowClick, false);
  // A fresh press starts clean even if release never arrived (grid redraw).
  h.begin('bag:medkit', 0);
  h.advance(HOLD_TO_USE_MS);
  h.begin('bag:speed_boost_25', 5000);
  assert.equal(h.swallowClick, false);
});

test('advance and cancel are no-ops when nothing is held', () => {
  const h = new HoldToUse();
  const idle = h.advance(10);
  assert.deepEqual(idle, { progress: 0, remaining: 0, seconds: 0, fired: false });
  h.cancel(10);
  assert.equal(h.swallowClick, false);
});

test('InventoryUI wires the hold to the primary button and routes it through inventory:use', async () => {
  const js = await readFile(path.join(root, 'src/ui/InventoryUI.js'), 'utf8');
  assert.match(js, /import \{[^}]*HoldToUse[^}]*\} from '\.\/HoldToUse\.js'/);
  assert.match(js, /addEventListener\('pointerdown'/, 'the hold starts on pointerdown');
  assert.match(js, /e\.button !== 0/, 'only the primary button holds');
  assert.match(js, /swallowClick/, 'the click handler asks the timer before moving a stack');
  // The hold must use the same use path as the Use button: no second dispatcher.
  const uses = js.match(/emit\('inventory:use'/g) ?? [];
  assert.equal(uses.length, 2, 'Use button + hold, both through inventory:use');
  const css = await readFile(path.join(root, 'src/ui/inventory.css'), 'utf8');
  assert.match(css, /\.inv-slot\.holding/, 'the cell shows it is being held');
  assert.match(css, /--hold/, 'the ring is driven by the --hold custom property');
});
