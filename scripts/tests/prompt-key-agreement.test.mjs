import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * DO THE WORDS ON SCREEN AND THE KEY AGREE?
 *
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `HUD._updatePrompt` decides what the E chip SAYS. Several systems decide what
 * E DOES, and each guards itself by hand because `Input.pressed` does not
 * consume. When those two orders disagree, the game tells a player to press a
 * key that does nothing — which is worse than offering nothing, because it is
 * indistinguishable from a broken key.
 *
 * This has now happened twice, in the same shape:
 *
 *  1. The Skyline viewpoint. The venue disc has to hold a 101.6 m route, so it
 *     is r 60.8 about the crown, and the beam tip 58.3 m out is inside it. A
 *     player walking to the end of the diving board was told about a race.
 *  2. The station hub deck. The concourse round's disc has to hold the whole
 *     contest, so it covers most of the deck, and **7 of the 12 talkable NPCs
 *     stand inside it**. The HUD read "E — Quest Board" and E did nothing.
 *
 * Both were repaired the same way and the reason is recorded in
 * `HUD._updatePrompt`: the fix belongs in `MinigameManager._keyTaken`, NOT in
 * the HUD's branch order, because reordering the HUD changes the words without
 * changing the key.
 *
 * So this test asserts the RULE rather than either instance: everything the HUD
 * ranks above the venue branch must also make the venue stand its key down.
 * A third prompt added above that branch without a matching `_keyTaken` term
 * fails here, on the commit that adds it.
 */
const HERE = dirname(fileURLToPath(import.meta.url));
const read = (...p) => readFileSync(join(HERE, '..', '..', ...p), 'utf8').replace(/\r\n/g, '\n');

const hud = read('src', 'ui', 'HUD.js');
const mgr = read('src', 'minigames', 'MinigameManager.js');

/** The prompt chain, from the first branch down to the venue branch. */
function branchesAboveVenue() {
  const start = hud.indexOf('// Quest Manager takes priority over everything else.');
  const venue = hud.indexOf('} else if (this._minigamePrompt && !this._chatOpen) {');
  assert.ok(start > 0 && venue > start, 'the prompt chain moved — re-read _updatePrompt');
  return hud.slice(start, venue);
}

test('the venue stands its key down for everything the HUD ranks above it', () => {
  const above = branchesAboveVenue();
  /* The getter BODY. Searching for `_pollPrompt()` from position zero finds the
   * CALL, which sits ~5,600 characters earlier than the definition, so the slice
   * came back empty and this test asserted against nothing while reporting a
   * failure. Anchored forward from the getter instead. */
  const at = mgr.indexOf('get _keyTaken()');
  const keyTaken = mgr.slice(at, mgr.indexOf('_pollPrompt()', at));
  assert.ok(keyTaken.includes('return'), 'the _keyTaken getter body could not be located');

  /* Every `this._x` the HUD consults in the branches above the venue. Each one
   * names a state that, while live, means the chip is NOT showing the venue.
   * `_chatOpen` is excluded because it is a modal state rather than a claim on
   * the key: the chat being open suppresses the whole chain. */
  const claims = [...new Set(above.match(/this._[A-Za-z]+/g) ?? [])]
    .filter((c) => c !== 'this._chatOpen');

  assert.ok(claims.includes('this._chatNpc'), 'the quest-manager / lorekeeper branch moved');
  assert.ok(claims.includes('this._interiorPrompt'), 'the interior branch moved');

  /* `_chatNpc` is mirrored as `_priorityNpc`, because the HUD ranks only its
   * questManager and lorekeeper forms above the venue and the manager filters to
   * exactly those two. Every other claim must appear under its own name. */
  const MIRROR = { 'this._chatNpc': '_priorityNpc' };

  for (const claim of claims) {
    const want = MIRROR[claim] ?? claim.replace('this.', '');
    assert.ok(keyTaken.includes(want),
      `HUD._updatePrompt ranks ${claim} above the venue branch, but ` +
      `MinigameManager._keyTaken does not stand down for it (looked for ${want}) - so ` +
      `the chip can say one thing while E does another. Add the term to _keyTaken; do ` +
      `NOT reorder the HUD, which changes the words without changing the key.`);
  }
});

test('a quest manager and a lorekeeper specifically take the key', () => {
  assert.ok(mgr.includes('isQuestManager') && mgr.includes('isLorekeeper'),
    'the two NPC kinds the HUD ranks above the venue must be named in the manager');
  assert.ok(mgr.includes('_priorityNpc'), 'the manager must hold the claim somewhere _keyTaken can read');
  assert.ok(/_keyTaken[\s\S]{0,240}_priorityNpc/.test(mgr),
    '_keyTaken must actually include the NPC claim');
});

test('an ordinary talkable NPC does NOT take the key', () => {
  /* The lifeguard patrols the pool deck, so a talkable NPC and the swim venue
   * overlap by design: one E must start a match, not open a chat, and T opens
   * chat unconditionally. Standing down for EVERY npc would silently undo that. */
  const sub = mgr.slice(mgr.indexOf("bus.on('chat:available'"), mgr.indexOf("bus.on('chat:available'") + 400);
  assert.ok(sub.includes('isQuestManager') && sub.includes('isLorekeeper'),
    'the subscription must filter to the two ranked kinds');
  assert.ok(!/_priorityNpc\s*=\s*npc\s*;/.test(sub),
    'standing down for any talkable NPC would undo the deliberate lifeguard/pool overlap');
});
