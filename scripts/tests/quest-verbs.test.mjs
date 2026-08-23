import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { rig, goto } from './_flightrig.mjs';

/* `QuestSystem` registers `pagehide`/`beforeunload` so an in-flight step sync
 * is not lost when the tab goes. The flight rig's harness aliases `window` to
 * `globalThis`, which has no listener API, so the two shims below are the
 * whole of what this file adds to it. */
globalThis.window.addEventListener = globalThis.window.addEventListener ?? (() => {});
globalThis.window.removeEventListener = globalThis.window.removeEventListener ?? (() => {});
globalThis.document.addEventListener = globalThis.document.addEventListener ?? (() => {});
globalThis.document.removeEventListener = globalThis.document.removeEventListener ?? (() => {});

const { QuestSystem } = await import('../../src/systems/QuestSystem.js');
const { PLANETS } = await import('../../src/worlds/planets/index.js');
const {
  STEP_TYPE_EMITTERS, WORKING_STEP_TYPES, candidatesFor, resolveTarget,
} = await import('../../scripts/quest-vocab.mjs');

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..', '..');
const read = (...p) => readFileSync(join(root, ...p), 'utf8');

/**
 * TWO NEW VERBS, AND THE RULE THAT LETS THEM EXIST.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 *  WHY THESE TWO AND NOT THE OTHER SEVEN
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * The mission survey counted eleven quest step verbs against roughly thirty
 * things a player can do, and listed nine with no mission representation at all
 * - climb, free-climb, swim, dive, glide, mine, pilot, transit, dock-and-sell.
 * It named two of the nine as the significant omissions: **mining and
 * piloting are the entire second half of the game**. Zero quests, zero vendors
 * and zero quest managers exist for `space` or any of the ten planets, so a
 * player who boards a hull leaves the mission system behind entirely.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 *  THE RULE: AN EMITTER FIRST
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Five verbs - `stealth investigate deliver escort craft` - were DELETED from
 * this codebase after an audit found 0 of 50 seeded quests completable. Every
 * one of them was a step type with no emitter: a quest containing one could
 * never be finished by any action available in the game, and nothing anywhere
 * said so.
 *
 * So the bar for a new verb is not "it would be nice". It is:
 *
 *   1. a real event fires in the shipped game when the player does the thing;
 *   2. `QuestSystem` reaches `_advanceSteps` from it;
 *   3. the event carries an IDENTITY, so a step can name WHICH thing;
 *   4. `quest-vocab.mjs` can derive that identity vocabulary from the sources
 *      the game reads, so an author who types the wrong one is told.
 *
 * Every case below is one of those four, and the mining half is driven through
 * the REAL `Mining.mine` on the REAL Cinder rather than a hand-built event.
 */

/** An engagement in the shape `QuestSystem.accept` builds one. */
function engage(qs, steps, { world = null } = {}) {
  const stepStates = {};
  for (const s of steps) stepStates[s.order] = { done: false, have: 0 };
  qs.engagements.set('eng-1', {
    engagement: { id: 'eng-1', status: 'in_progress', world },
    quest: { id: 'q-1', title: 'Test', world, steps },
    stepStates,
  });
  return () => qs.engagements.get('eng-1').stepStates;
}

/* ====================================================================== */
/* 1. mine - driven through the real seam                                  */
/* ====================================================================== */

test('cutting a real seam advances a mine step that names the element', async () => {
  const r = await rig();
  const qs = new QuestSystem({
    bus: r.bus, player: r.player, economy: r.economy, worldManager: r.wm, npcManager: null,
  });
  await goto(r, 'dock');
  await goto(r, 'cinder');

  const node = r.wm.active.mineralNodes.find((n) => !r.mining._taken.has(`cinder/${n.id}`));
  assert.ok(node, 'every seam on Cinder is cut - the rig has broken');

  const states = engage(qs, [
    { order: 1, type: 'mine', target: node.type, count: 1, label: `Cut ${node.name}`, world: 'cinder' },
    { order: 2, type: 'mine', target: 'a_rock_that_does_not_exist', count: 1, label: 'No', world: 'cinder' },
  ]);

  r.piloting.board('dray', { silent: true });
  r.piloting._cargo = Object.create(null);
  r.piloting._cargoUnits = 0;
  assert.equal(r.mining.mine(node).ok, true, 'the real cut refused');

  assert.equal(states()[1].done, true, 'a real seam did not advance a step that named it');
  assert.equal(states()[2].done, false, 'a step naming a different element advanced anyway');
  qs.dispose?.();
});

test('a mine step is not a collect step wearing a hat', async () => {
  /* `Mining._cut` already emitted `quest:activity{type:'collect'}`, and it still
   * does - the ore genuinely is a thing you now hold. The reason `mine` exists
   * beside it is that `collect` fires for every pickup in the game, so a step
   * that meant "cut a seam" could be finished by walking over a dropped medkit
   * named after an ore. Both events fire; they are not the same event. */
  const src = read('src', 'systems', 'Mining.js');
  const emits = [...src.matchAll(/emit\??\.?\(\s*'quest:activity'\s*,\s*\{\s*type:\s*'(\w+)'/g)]
    .map((m) => m[1]);
  assert.ok(emits.includes('mine'), 'Mining does not emit a mine activity');
  assert.ok(emits.includes('collect'), 'Mining stopped emitting its collect activity');
});

/* ====================================================================== */
/* 2. pilot - the payload restated from the emit site, and pinned to it    */
/* ====================================================================== */

test('the landing event still carries the world and the site it is keyed on', () => {
  /* This case exists because the one below restates a payload rather than
   * flying a touchdown, and a restated payload is only worth anything while it
   * still matches the emitter. `Piloting.js:1636` is the single site. */
  const src = read('src', 'ships', 'Piloting.js');
  const emit = /emit\??\.?\(\s*'pilot:landed'\s*,\s*\{([^}]*)\}/.exec(src);
  assert.ok(emit, 'nothing emits pilot:landed any more');
  for (const field of ['world', 'site']) {
    assert.match(emit[1], new RegExp(`\\b${field}\\s*:`),
      `pilot:landed no longer carries ${field}, which every pilot step is keyed on`);
  }
});

test('setting down advances a pilot step that names the world or the pad', async () => {
  const r = await rig();
  const qs = new QuestSystem({
    bus: r.bus, player: r.player, economy: r.economy, worldManager: r.wm, npcManager: null,
  });
  await goto(r, 'dock');
  await goto(r, 'cinder');

  const pad = r.wm.active.landingSites[0];
  assert.ok(pad?.id, 'Cinder publishes no landing sites - the rig has broken');

  const states = engage(qs, [
    { order: 1, type: 'pilot', target: 'cinder', count: 1, label: 'Land on Cinder', world: 'cinder' },
    { order: 2, type: 'pilot', target: pad.id, count: 1, label: `Set down at ${pad.name}`, world: 'cinder' },
    { order: 3, type: 'pilot', target: 'tessera', count: 1, label: 'Land on Tessera', world: 'cinder' },
  ]);

  // The payload `Piloting._touchDown` emits, restated - see the case above.
  r.bus.emit('pilot:landed', {
    shipId: 'dray', world: 'cinder', site: { id: pad.id, name: pad.name }, speed: 12.5,
  });

  assert.equal(states()[1].done, true, 'landing did not advance a step naming the world');
  assert.equal(states()[2].done, true, 'landing did not advance a step naming the pad');
  assert.equal(states()[3].done, false, 'landing on Cinder advanced a step naming Tessera');
  qs.dispose?.();
});

/* ====================================================================== */
/* 3. The vocabulary gate knows about both                                 */
/* ====================================================================== */

test('both verbs are declared with their emitters', () => {
  for (const verb of ['mine', 'pilot']) {
    assert.ok(WORKING_STEP_TYPES.includes(verb), `${verb} is not a writable step type`);
    assert.ok(STEP_TYPE_EMITTERS[verb]?.emitter, `${verb} has no emitter recorded`);
  }
});

test('the mine vocabulary is the minerals the planet actually publishes', () => {
  const cands = candidatesFor('mine', 'cinder').map((c) => c.value);
  assert.ok(cands.length > 0, 'Cinder offers no mine targets');

  /* Derived from the descriptor, not restated here: the expectation is read out
   * of `Volcanic.js` the same way the engine reads it. A list typed into this
   * file would be a second copy of the planet. */
  const src = read('src', 'worlds', 'planets', 'Volcanic.js');
  const block = /minerals:\s*\[/.exec(src);
  assert.ok(block, 'Cinder no longer declares minerals');
  const ids = [...src.slice(block.index).matchAll(/id:\s*'([a-z_]+)',\s*item:/g)].map((m) => m[1]);
  assert.ok(ids.length >= 5, `the descriptor scrape found ${ids.length} minerals`);
  for (const id of ids) {
    assert.ok(cands.includes(id), `"${id}" is mined on Cinder and is not a legal mine target`);
  }
});

test('the pilot vocabulary is the world plus the pads that world publishes', () => {
  const cands = candidatesFor('pilot', 'cinder').map((c) => c.value);
  assert.ok(cands.includes('cinder'), 'a step cannot name the world it lands on');
  /* The descriptor key is `landing`, and `PlanetDescriptor` turns it into
   * `world.landingSites` - which is the list `Piloting._siteUnder` reads. */
  const src = read('src', 'worlds', 'planets', 'Volcanic.js');
  const block = /\n  landing:\s*\[/.exec(src);
  assert.ok(block, 'Cinder no longer declares landing sites');
  const ids = [...src.slice(block.index).matchAll(/id:\s*'([a-z_]+)',\s*name:/g)].map((m) => m[1]);
  assert.ok(ids.length >= 2, `the descriptor scrape found ${ids.length} pads`);
  for (const id of ids) {
    assert.ok(cands.includes(id), `"${id}" is a pad on Cinder and is not a legal pilot target`);
  }
});

test('every planet with seams can have a mine step written for it', () => {
  /* Not only Cinder. A vocabulary that worked on the one planet the scrape was
   * written against, and returned nothing for the other nine, would pass the
   * case above and be useless - which is this repo's signature defect wearing
   * a green tick. */
  
  const empty = [];
  for (const id of Object.keys(PLANETS)) {
    if (!candidatesFor('mine', id).length) empty.push(id);
  }
  assert.deepEqual(empty, [], `these planets publish minerals and offer no mine targets: ${empty}`);
});

test('every planet with a pad can have a pilot step written for it', () => {
  
  const empty = [];
  for (const id of Object.keys(PLANETS)) {
    if (!candidatesFor('pilot', id).length) empty.push(id);
  }
  assert.deepEqual(empty, [], `these planets have landing sites and offer no pilot targets: ${empty}`);
});

test('a mine target from the wrong planet is refused with a reason', () => {
  /* Tephra is Cinder's. A step written `{type:'mine', target:'tephra',
   * world:'tessera'}` is dead in the shipped game because `_advanceSteps`
   * refuses a step whose world is not the player's - so the gate has to be
   * world-scoped too, or it would validate a step nobody can finish. */
  const ok = resolveTarget('mine', 'tephra', { world: 'cinder' });
  assert.equal(ok.ok, true, `${ok.reason}: ${ok.detail}`);
  const bad = resolveTarget('mine', 'tephra', { world: 'tessera' });
  assert.equal(bad.ok, false, 'a mineral from another planet validated');
  const nowhere = resolveTarget('mine', 'tephra', { world: 'station' });
  assert.equal(nowhere.ok, false, 'a mine step validated in a world with no seams in it');
});

test('a verb with no emitter is still refused', () => {
  /* The guard the five deleted verbs bought. Adding `mine` and `pilot` must not
   * turn the vocabulary into a place where anything can be written. */
  for (const dead of ['stealth', 'craft', 'glide', 'swim']) {
    assert.ok(!WORKING_STEP_TYPES.includes(dead), `${dead} became writable`);
  }
});
