import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import { HUD } from '../../src/ui/HUD.js';

/**
 * THE HUD SAYS HOW MANY ARE LEFT, AND STOPS LYING ABOUT THE LEAP.
 *
 * ── The defects ───────────────────────────────────────────────────────────
 * 1. `relics:changed` was emitted on every world change and every pickup and
 *    had **no listener anywhere**. Thirty finite collectibles, and the only way
 *    to learn how many were left was the three-second toast on the one you had
 *    just picked up.
 * 2. Every prompt in this widget draws an `E` key chip, because until now every
 *    prompt answered to E. The leap of faith answers to nothing - the beam is
 *    the interaction - so reusing the widget unmodified would have put a key
 *    binding on screen that does not exist.
 *
 * ── How this is measured ──────────────────────────────────────────────────
 * A full `HUD` cannot be constructed headlessly - it builds a hundred elements,
 * a `ChatBox` and a `WeaponWheel`. Both methods under test touch only the
 * handful of fields stubbed below, which is the same technique
 * `mount-hud.test.mjs` uses and for the same reason: the defects here are a
 * missing string and a wrong string, and no screenshot review catches either.
 */

/** The rows `_setDiscoveries` writes, and nothing else. */
function stubPanel() {
  const h = Object.create(HUD.prototype);
  h._relicFound = 0;
  h._relicTotal = 0;
  h._vpSynced = 0;
  h._vpTotal = 0;
  h._relicText = '';
  h._vpText = '';
  h.relicCount = { textContent: '' };
  h.vpCount = { textContent: '' };
  h.collectRelicRow = { hidden: false };
  h.collectVpRow = { hidden: false };
  h.collectPanel = { hidden: true };
  return h;
}

/** The fields `_updatePrompt` reads and the three it writes. */
function stubPrompt(fields = {}) {
  const classes = new Set();
  const h = Object.create(HUD.prototype);
  Object.assign(h, {
    _chatNpc: null, _chatOpen: false, _dead: false, _nearPortal: null,
    _interiorPrompt: null, _minigamePrompt: null, _minigameVerb: null, _minigameLabel: null,
    _viewpointPrompt: null, _promptKey: '',
    worldManager: { getWorld: () => null },
    promptText: { innerHTML: '' },
    prompt: {
      classList: {
        contains: (c) => classes.has(c),
        toggle: (c, on) => { if (on) classes.add(c); else classes.delete(c); },
      },
    },
  }, fields);
  h._classes = classes;
  return h;
}

/* ====================================================================== */
/* The counter                                                             */
/* ====================================================================== */

test('the discovery panel stays hidden in a world with neither', () => {
  const h = stubPanel();
  h._setDiscoveries({ found: 0, total: 0 }, { synced: 0, total: 0 });
  assert.equal(h.collectPanel.hidden, true, 'an empty panel was shown');
});

test('a world with relics and no viewpoints shows only the relic row', () => {
  // Three of the five worlds. A "Viewpoints 0/0" line in them would be the HUD
  // advertising a mechanic that is not in that world.
  const h = stubPanel();
  h._setDiscoveries({ found: 4, total: 30 }, { synced: 0, total: 0 });
  assert.equal(h.collectPanel.hidden, false, 'the panel stayed hidden with 30 relics in the world');
  assert.equal(h.collectRelicRow.hidden, false);
  assert.equal(h.collectVpRow.hidden, true, 'a viewpoint row showed in a world with no viewpoints');
  assert.equal(h.relicCount.textContent, '4/30');
});

test('the counts are what the systems published, both of them', () => {
  const h = stubPanel();
  h._setDiscoveries({ found: 11, total: 30 }, { synced: 2, total: 5 });
  assert.equal(h.relicCount.textContent, '11/30');
  assert.equal(h.vpCount.textContent, '2/5');
  assert.equal(h.collectVpRow.hidden, false);
});

test('either half can update without clobbering the other', () => {
  /* The two events arrive independently - `relics:changed` on a pickup,
   * `viewpoints:changed` on a climb - so a handler that took both at once would
   * zero whichever one did not fire. */
  const h = stubPanel();
  h._setDiscoveries({ found: 11, total: 30 }, { synced: 2, total: 5 });
  h._setDiscoveries({ found: 12, total: 30 }, null);
  assert.equal(h.relicCount.textContent, '12/30');
  assert.equal(h.vpCount.textContent, '2/5', 'a relic pickup wiped the viewpoint count');
  h._setDiscoveries(null, { synced: 3, total: 5 });
  assert.equal(h.relicCount.textContent, '12/30', 'a climb wiped the relic count');
  assert.equal(h.vpCount.textContent, '3/5');
});

test('an unchanged count is not written back to the DOM', () => {
  // The HUD's standing rule: never dirty layout for a value that did not move.
  const h = stubPanel();
  h._setDiscoveries({ found: 4, total: 30 }, null);
  let writes = 0;
  Object.defineProperty(h.relicCount, 'textContent', {
    get: () => '4/30', set: () => { writes++; },
  });
  h._setDiscoveries({ found: 4, total: 30 }, null);
  h._setDiscoveries({ found: 4, total: 30 }, null);
  assert.equal(writes, 0, 'the panel rewrote a count that had not changed');
});

/* ====================================================================== */
/* The leap prompt                                                         */
/* ====================================================================== */

test('the leap prompt shows with NO key chip', () => {
  const h = stubPrompt({ _viewpointPrompt: 'Leap of faith — hay 48 m below' });
  h._updatePrompt();
  assert.equal(h._classes.has('show'), true, 'the leap prompt never appeared');
  assert.equal(h._classes.has('keyless'), true,
    'the leap prompt drew an E chip for a key that does nothing');
  assert.match(h.promptText.innerHTML, /Leap of faith/);
});

test('an ordinary prompt keeps its key chip', () => {
  const h = stubPrompt({ _interiorPrompt: 'Open the door' });
  h._updatePrompt();
  assert.equal(h._classes.has('keyless'), false, 'the door prompt lost its E chip');
});

test('the chip comes back when the player steps off the beam', () => {
  const h = stubPrompt({ _viewpointPrompt: 'Leap of faith — hay 48 m below' });
  h._updatePrompt();
  assert.equal(h._classes.has('keyless'), true);
  h._viewpointPrompt = null;
  h._interiorPrompt = 'Open the door';
  h._updatePrompt();
  assert.equal(h._classes.has('keyless'), false, 'the keyless state stuck after the leap prompt');
});

test('a trial start line on the same tower still reads', () => {
  /* Given BOTH, the venue wins here - a contest must stay startable from its
   * own start line. What makes that safe is not this order, it is that the two
   * can no longer both be live: `MinigameManager._keyTaken` counts a live
   * `viewpoint:prompt` and publishes no venue prompt while one is up (see
   * `minigame-swim.test.mjs`, "stands down for doors and portals").
   *
   * An earlier note here said the two could never collide because the Skyline
   * venue is a 12 m disc about the crown while the leap needs 3 m of the beam
   * tip. Both halves were wrong: the venue disc has to hold the whole 101.6 m
   * route or `LEAVE_GRACE_S` abandons every run, so it is r 60.8 / yTol 33.5
   * about (-22.7, 44.1, -63.5), and the beam tip at (0, 68.15, -9.8) is 58.3 m
   * out and 24.1 m up - well inside it. */
  const h = stubPrompt({
    _viewpointPrompt: 'Leap of faith — hay 48 m below',
    _minigamePrompt: 'start', _minigameVerb: 'Start', _minigameLabel: 'The Skyline',
  });
  h._updatePrompt();
  assert.match(h.promptText.innerHTML, /Skyline/, 'the leap prompt hid the trial start line');
  assert.equal(h._classes.has('keyless'), false);
});

test('the leap prompt is escaped, never injected', () => {
  // Every other free-form prompt in this widget is escaped; this one arrives
  // from a world file and must be treated identically.
  const h = stubPrompt({ _viewpointPrompt: '<img src=x onerror=alert(1)>' });
  h._updatePrompt();
  assert.ok(!h.promptText.innerHTML.includes('<img'),
    'a world could put raw markup into the prompt');
});

/* ====================================================================== */
/* Wiring                                                                  */
/* ====================================================================== */

test('the HUD subscribes to both counters and hands both systems to the map', async () => {
  /* A listener that is never registered is invisible at runtime - the panel
   * simply stays at 0/0 and looks like a world with no relics in it, which is
   * exactly how the original defect hid for so long. */
  const src = await readFile(new URL('../../src/ui/HUD.js', import.meta.url), 'utf8');
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
  for (const evt of ['relics:changed', 'viewpoints:changed', 'viewpoint:prompt']) {
    assert.match(code, new RegExp(`_on\\('${evt}'`), `HUD never listens to ${evt}`);
  }
  const at = code.indexOf('new Minimap({');
  assert.ok(at > 0);
  const args = code.slice(at, code.indexOf('});', at));
  assert.match(args, /relics:/, 'the map is still built without the relic layer');
  assert.match(args, /viewpoints:/, 'the map is still built without the reveal authority');
});

test('main.js constructs and drives the viewpoint system', async () => {
  const src = await readFile(new URL('../../src/main.js', import.meta.url), 'utf8');
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
  assert.match(code, /new Viewpoints\(/, 'Viewpoints is never constructed');
  assert.match(code, /viewpoints\.update\(dt\)/, 'Viewpoints is never ticked, so nothing syncs');
  assert.match(code, /\.\.\.viewpoints\.hubItems\(\)/, 'the pause hub has no travel rows');
  // The save is where the whole layer would silently evaporate.
  const at = code.indexOf('new SaveGame({');
  const args = code.slice(at, code.indexOf('});', at));
  assert.match(args, /relics/, 'SaveGame is built without the relic tally');
  assert.match(args, /viewpoints/, 'SaveGame is built without the viewpoint record');
});
