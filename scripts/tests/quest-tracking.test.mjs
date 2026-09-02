import test from 'node:test';
import assert from 'node:assert/strict';

/**
 * FOUR WAYS A QUEST STEP COMPLETED FOR SOMETHING THE PLAYER DID NOT DO.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 *  WHY THESE FOUR BELONG IN ONE FILE
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * They are the same defect four times: `_advanceSteps` is fed by handlers that
 * each decide, on their own, what counts - and four of them were reading an
 * event more loosely than the event itself is written.
 *
 *   1. `purchase` completed on a SALE, because `_eventTargetCandidates` pushed
 *      `event.itemId` without looking at `event.kind`, which `market:trade`
 *      carries specifically to say which side of the counter it was. Thirteen
 *      quests, including the two station tutorials whose subject IS the buy
 *      side.
 *   2. `talk` with `count > 1` completed on ONE NPC pressed repeatedly, because
 *      the de-duplication `_creditVisit` uses was never wired to this channel.
 *      Eight steps across seven quests; the content's own note beside them says
 *      "three different people and a short walk".
 *   3. `kill` completed on somebody else's kill, because `npc:killed.byPlayer`
 *      was never read here - though `Economy` reads it, and `Combat.resolveMaul`
 *      sets it false explicitly "so a wolf eating a villager cannot pay the
 *      player for it".
 *   4. `defend` counted anyone's hits, and STILL DOES, because `npc:damaged`
 *      carries no `byPlayer` at all. The guard is in place and the emitter is
 *      not; the last test in this file pins exactly that, so it turns green on
 *      the one-word Combat.js change rather than being forgotten.
 *
 * Plus the exit that did not exist: there was no way to give a quest back.
 *
 * Everything here drives the REAL `QuestSystem` over the REAL bus contract -
 * the payloads are the ones the shipped emitters send, quoted from their emit
 * sites - because a rig that invents its own event shape proves nothing about
 * the handler that has to read the real one.
 */

import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..', '..');
const read = (...p) => readFileSync(join(root, ...p), 'utf8');

/* `QuestSystem` registers `pagehide`/`beforeunload`, so it needs a window with
 * a listener API. Same two shims `quest-verbs.test.mjs` adds, for the same
 * reason. */
globalThis.window ??= globalThis;
globalThis.window.addEventListener = globalThis.window.addEventListener ?? (() => {});
globalThis.window.removeEventListener = globalThis.window.removeEventListener ?? (() => {});

const { QuestSystem } = await import('../../src/systems/QuestSystem.js');

/* ================================================================== */
/* Apparatus                                                           */
/* ================================================================== */

function fakeBus() {
  const handlers = new Map();
  const seen = [];
  return {
    seen,
    on(name, fn) {
      if (!handlers.has(name)) handlers.set(name, []);
      handlers.get(name).push(fn);
      return () => {
        const a = handlers.get(name);
        const i = a.indexOf(fn);
        if (i >= 0) a.splice(i, 1);
      };
    },
    emit(name, payload) {
      seen.push([name, payload]);
      for (const fn of [...(handlers.get(name) ?? [])]) fn(payload);
    },
    find(name) { return seen.filter(([n]) => n === name).map(([, p]) => p); },
  };
}

/**
 * A quest system with one in-progress engagement, standing in `world`.
 *
 * `_worldId` is set directly rather than by emitting `world:changed`, because
 * that handler kicks off a `fetch` this harness has no server for - and the
 * property is what every step gate actually reads.
 */
function harness(steps, { world = 'station' } = {}) {
  const bus = fakeBus();
  const qs = new QuestSystem({ bus, player: null, economy: null, worldManager: null });
  qs._worldId = world;
  const stepStates = {};
  for (const s of steps) stepStates[s.order] = { done: false, have: 0 };
  qs.engagements.set('eng-1', {
    engagement: { id: 'eng-1', status: 'in_progress', world, percent_complete: 0 },
    quest: { id: 'q-1', title: 'Test quest', world, reward_credits: 100, steps },
    stepStates,
    timeLeftMs: null,
  });
  return { bus, qs, states: () => qs.engagements.get('eng-1').stepStates };
}

/* ================================================================== */
/* 1. A sale is not a purchase                                         */
/* ================================================================== */

test('selling an item does not complete a step that asked you to buy it', () => {
  const { bus, states, qs } = harness([
    { order: 1, type: 'purchase', target: 'medkit', count: 1, label: 'Buy a medkit', world: 'station' },
  ]);

  // The sell payload, exactly as the marketplace emits it.
  bus.emit('market:trade', { itemId: 'medkit', qty: 1, credits: 40, kind: 'sell' });
  assert.equal(states()[1].done, false,
    'a SALE of the item completed a purchase step — the buy-side tutorials teach nothing');

  bus.emit('market:trade', { itemId: 'medkit', qty: 1, credits: 95, kind: 'buy' });
  assert.equal(states()[1].done, true, 'an actual purchase no longer advances the step');
  qs.dispose?.();
});

test('a step that asks for a SALE is still satisfied by one', () => {
  /* Seven authored steps target `sell` (quests 106, 107, 19, 24, 39, 43 and
   * 58's `medkit`), so withholding item identities from a sale must not also
   * withhold `kind`. This is the assertion that keeps the fix from being a
   * regression dressed as a repair. */
  const { bus, states, qs } = harness([
    { order: 1, type: 'purchase', target: 'sell', count: 2, label: 'Sell two things', world: 'station' },
  ]);
  bus.emit('market:trade', { itemId: 'alloy_scrap', qty: 1, credits: 12, kind: 'sell' });
  bus.emit('market:trade', { itemId: 'arrow', qty: 3, credits: 20, kind: 'sell' });
  assert.equal(states()[1].done, true, 'a purchase:sell step no longer completes on sales');
  qs.dispose?.();
});

test('a buy still matches by item, pack and id, not only by kind', () => {
  const { bus, states, qs } = harness([
    { order: 1, type: 'purchase', target: 'pack_medkit', count: 1, label: 'Buy', world: 'station' },
  ]);
  bus.emit('market:trade', { itemId: 'pack_medkit', qty: 1, credits: 95, kind: 'buy' });
  assert.equal(states()[1].done, true);
  qs.dispose?.();
});

/* ================================================================== */
/* 2. One NPC is one person                                            */
/* ================================================================== */

test('a talk step of count 3 needs three different people', () => {
  const { bus, states, qs } = harness([
    { order: 1, type: 'talk', target: 'vendor', count: 3, label: 'Talk to three traders', world: 'station' },
  ]);

  // HUD flattens {id, name, role} onto the activity; this is Rafiq, three times.
  for (let i = 0; i < 5; i++) {
    bus.emit('quest:activity', { type: 'talk', id: 'npc-rafiq', name: 'Rafiq the Keeper', role: 'vendor' });
  }
  assert.equal(states()[1].have, 1,
    'pressing E five times at one NPC counted five people');
  assert.equal(states()[1].done, false);

  bus.emit('quest:activity', { type: 'talk', id: 'npc-hafsa', name: 'Hafsa the Dyer', role: 'vendor' });
  bus.emit('quest:activity', { type: 'talk', id: 'npc-bashir', name: 'Bashir the Ostler', role: 'vendor' });
  assert.equal(states()[1].done, true, 'three different traders did not finish the step');
  qs.dispose?.();
});

test('an anonymous talker is not collapsed into one person', () => {
  /* `talk:undefined` as a key would make the FIRST anonymous conversation the
   * only one that ever counted, which is a worse failure than the one being
   * fixed: it is silent and it affects a step that was working. */
  const { bus, states, qs } = harness([
    { order: 1, type: 'talk', target: '', count: 2, label: 'Talk to anyone twice', world: 'station' },
  ]);
  bus.emit('quest:activity', { type: 'talk' });
  bus.emit('quest:activity', { type: 'talk' });
  assert.equal(states()[1].done, true, 'un-keyed talk activities stopped counting');
  qs.dispose?.();
});

test('the de-duplication is scoped to talk and does not leak into other verbs', () => {
  const { bus, states, qs } = harness([
    { order: 1, type: 'mine', target: 'rheniite', count: 3, label: 'Cut three', world: 'station' },
  ]);
  for (let i = 0; i < 3; i++) {
    bus.emit('quest:activity', { type: 'mine', target: 'rheniite', id: 'seam-7', name: 'Rheniite' });
  }
  assert.equal(states()[1].done, true,
    'cutting the same seam three times stopped counting — the talk key leaked');
  qs.dispose?.();
});

/* ================================================================== */
/* 3. Somebody else's kill                                             */
/* ================================================================== */

test('a beast mauling a hostile does not advance a kill step', () => {
  const { bus, states, qs } = harness([
    { order: 1, type: 'kill', target: 'Rook Gant', count: 1, label: 'Deal with Rook Gant', world: 'station' },
  ]);
  const npc = { id: 'npc-rook', name: 'Rook Gant', type: 'hostile' };

  // `Combat.resolveMaul` -> `applyNPCDamage(..., byPlayer: false)` -> this.
  bus.emit('npc:killed', { npc, byPlayer: false, weaponId: 'maul' });
  assert.equal(states()[1].done, false,
    'standing back and letting a wolf do it completed the step');

  bus.emit('npc:killed', { npc, byPlayer: true, weaponId: 'rifle' });
  assert.equal(states()[1].done, true, 'the player’s own kill no longer counts');
  qs.dispose?.();
});

test('a kill event with no byPlayer flag is treated as unknown, not as refused', () => {
  /* `=== false` rather than `!== true`, and this is why: a hand-rolled or
   * legacy emit that predates the field must keep working. `Onboarding` reads
   * the same event the same way. */
  const { bus, states, qs } = harness([
    { order: 1, type: 'kill', target: null, count: 1, label: 'Kill one', world: 'station' },
  ]);
  bus.emit('npc:killed', { npc: { id: 'x', type: 'hostile' } });
  assert.equal(states()[1].done, true, 'an un-flagged kill stopped counting');
  qs.dispose?.();
});

/* This test used to end in a deliberate `assert.fail` that fired the day
 * `Combat.js` started sending `byPlayer` on `npc:damaged` — a self-liquidating
 * branch whose message said what to replace it with. It fired, and this is the
 * replacement: the guard is no longer proven against a payload the emitter did
 * not yet send, but against the one it actually sends.
 *
 * The defect being pinned: `resolveMaul` routes a beast savaging a villager
 * through the SAME choke point as a player's shot. Before the flag rode along,
 * quest 20's "defend Wry Tam x8" was cleared by standing back and letting a
 * wolf do the work. Economy honoured the flag on `npc:killed` and QuestSystem
 * could not honour it on damage, because damage never carried it. */
test('a beast hit does not advance a defend step; a player hit does', () => {
  const { bus, states } = harness([
    { order: 1, type: 'defend', target: 'Wry Tam', count: 2, label: 'Land two hits', world: 'station' },
  ]);
  const npc = { id: 'npc-tam', name: 'Wry Tam', type: 'hostile' };

  /* The beast half, in the shape `Combat.resolveMaul` sends it. */
  bus.emit('npc:damaged', { npc, amount: 10, health: 90, isHeadshot: false, weaponId: null, byPlayer: false });
  bus.emit('npc:damaged', { npc, amount: 10, health: 80, isHeadshot: false, weaponId: null, byPlayer: false });
  assert.equal(states()[1].have, 0,
    'a beast mauling the defended NPC advanced the step the player is being paid to do');

  /* The player half, in the shape `Combat.applyNPCDamage` sends it. */
  bus.emit('npc:damaged', { npc, amount: 10, health: 70, isHeadshot: false, weaponId: 'rifle', byPlayer: true });
  assert.equal(states()[1].have, 1, 'a player hit stopped counting');
  bus.emit('npc:damaged', { npc, amount: 10, health: 60, isHeadshot: false, weaponId: 'rifle', byPlayer: true });
  assert.equal(states()[1].done, true, 'two player hits did not finish a count-2 defend step');

  /* The emitter is still the single choke point both halves go through — if it
   * ever stops carrying the flag, the guard above silently passes everything. */
  const combat = read('src', 'systems', 'Combat.js');
  const emit = /this\.bus\.emit\('npc:damaged',\s*\{([^}]*)\}\)/.exec(combat);
  assert.ok(emit, 'Combat.js no longer has a single npc:damaged emit — re-read this test');
  assert.ok(emit[1].includes('byPlayer'),
    'Combat.js stopped sending byPlayer on npc:damaged; every beast hit now counts again');
});

/* ================================================================== */
/* 4. The way out                                                      */
/* ================================================================== */

test('abandoning gives the quest back rather than completing or deleting it', async () => {
  const { states, qs } = harness([
    { order: 1, type: 'kill', target: null, count: 4, label: 'Kill four', world: 'station' },
  ]);
  const calls = [];
  globalThis.fetch = async (url, opts) => {
    calls.push(JSON.parse(opts.body));
    // The shipped route knows nothing of `abandon`; it answers 400 Unknown action.
    const action = JSON.parse(opts.body).action;
    return { ok: action !== 'abandon', status: action === 'abandon' ? 400 : 200,
      json: async () => ({ ok: true }) };
  };

  qs._syncQueue.add('eng-1');
  assert.equal(await qs.abandon('eng-1'), true);

  const eng = qs.engagements.get('eng-1').engagement;
  assert.equal(eng.status, 'failed',
    'abandoning must file the engagement as failed — a completed one would pay out');
  assert.equal(eng.failure_reason, 'Abandoned');
  assert.ok(qs.engagements.has('eng-1'), 'the engagement was deleted rather than given back');
  assert.equal(states()[1].done, false, 'abandoning silently completed a step');
  assert.ok(!qs._syncQueue.has('eng-1'),
    'queued progress for an abandoned quest would be POSTed after the abandon');

  assert.deepEqual(calls.map((c) => c.action), ['abandon', 'fail'],
    'the dedicated action must be tried first, and must fall back to the one every '
    + 'deployed server already handles');
  assert.equal(calls[1].reason, 'Abandoned',
    'the fallback must say WHY, or the ledger cannot tell a refusal from a timeout');

  // A second abandon is a no-op rather than a second POST.
  const before = calls.length;
  assert.equal(await qs.abandon('eng-1'), false);
  assert.equal(calls.length, before);
  qs.dispose?.();
  delete globalThis.fetch;
});

test('the board offers the way out, and only while a quest is running', () => {
  const src = read('src', 'ui', 'QuestBoard.js');
  assert.match(src, /qb-abandon-btn/, 'QuestBoard has no abandon control');
  assert.match(src, /questSystem\?\.abandon\?\./, 'the button does not reach QuestSystem.abandon');
  const at = src.indexOf('const abandonBtn');
  assert.ok(at > 0, 'the abandon button is not built in _renderDetail');
  assert.match(src.slice(at, at + 200), /isActive/,
    'the abandon button is offered on quests that are not in progress');
});

/* ================================================================== */
/* 5. A step for somewhere else says so                                */
/* ================================================================== */

test('the board renders the world a step belongs to, and greys it when it is elsewhere', () => {
  /* 34 steps across 17 quests are cross-world. `_advanceSteps` skips a step
   * whose `world` is not the player's, and the panel drew it as live and
   * "Auto" - so quest 203's relic coins looked broken on the station. */
  const src = read('src', 'ui', 'QuestBoard.js');
  assert.match(src, /const elsewhere = /, 'no cross-world step state is computed');
  assert.match(src, /const typeText = step\.world \?/,
    'the step row does not name the world the step is for');
  assert.match(src, /'Elsewhere'/, 'a step for another world still reads "Auto"');
});

/* ================================================================== */
/* 6. A full bag names what it is blocking                             */
/* ================================================================== */

test('the live collect steps are published for the pickup layer, and Loot reads them', () => {
  const { bus, qs } = harness([
    { order: 1, type: 'collect', target: 'relic_coin', count: 3, label: 'Gather 3 relic coins', world: 'station' },
    { order: 2, type: 'collect', target: 'arrow', count: 2, label: 'Elsewhere', world: 'medieval' },
    { order: 3, type: 'kill', target: null, count: 1, label: 'Not a collect step', world: 'station' },
  ]);
  qs._publishCollectPending();
  const pending = bus.find('quests:collect:pending').pop();
  assert.ok(pending, 'nothing was published');
  assert.deepEqual(pending.steps.map((s) => s.target), ['relic_coin'],
    'the published list must be this world’s live collect steps and nothing else');
  assert.equal(pending.steps[0].count, 3);
  assert.equal(pending.steps[0].label, 'Gather 3 relic coins');

  // A finished step drops off the list.
  qs.engagements.get('eng-1').stepStates[1].done = true;
  qs._publishCollectPending();
  assert.deepEqual(bus.find('quests:collect:pending').pop().steps, [],
    'a completed collect step is still advertised as blocked');
  qs.dispose?.();
});

test('Loot names the blocked step in the inventory-full notice', () => {
  const src = read('src', 'systems', 'Loot.js');
  assert.match(src, /quests:collect:pending/, 'Loot never learns what the player is collecting for');
  assert.match(src, /_blockedStepFor/, 'Loot has no way to name the step a full bag blocks');
  assert.match(src, /cannot advance until you free a slot/,
    'the inventory-full notice still says nothing about the quest it is stalling');
  /* The matcher is SHARED, not re-implemented: two descriptions of "does this
   * id name that target" is how the notice starts naming a step the pickup
   * could not have advanced. */
  assert.match(src, /import \{ targetMatches \} from '\.\/QuestSystem\.js'/,
    'Loot re-implements the target matcher instead of sharing it');
});
