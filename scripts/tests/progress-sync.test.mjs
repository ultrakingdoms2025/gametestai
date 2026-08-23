import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { toPayload, applyState, syncProgress } from '../../src/systems/ProgressSync.js';

/**
 * THE TRANSLATION LAYER BETWEEN FIVE PROGRESS SYSTEMS AND ONE LEDGER.
 *
 * ── What is being tested, and what is not ─────────────────────────────────
 * The merge itself is not here. It happens once, in Postgres, as a UNIQUE
 * constraint, and `site/lib/progressLedger.test.ts` proves it against a real
 * database. This file covers the half that a database cannot: the mapping in
 * and out, which is where a silent progress leak would actually live.
 *
 * A field dropped on the way out never reaches the server and the player's
 * second device never sees it. A field dropped on the way back in is a player
 * watching their own relics vanish. Neither shows up as an error, so both get
 * a round-trip assertion rather than a shape assertion.
 *
 * ── The rosters ───────────────────────────────────────────────────────────
 * `SpaceObjectives` carries two lookups - `elements` and `wingRoster` - that
 * are learned from the worlds a session has visited rather than earned. They
 * must NOT travel, and applying a server answer must not erase them, because
 * the ledger has never held them and never will.
 */

const recorder = (payload) => ({
  restored: [],
  serialize: () => payload,
  deserialize(d) { this.restored.push(d); return true; },
});

/* ====================================================================== */
/* Local systems -> payload                                                */
/* ====================================================================== */

test('relic identities and receipts both travel', () => {
  const relics = recorder({
    found: { citadel: 2 },
    foundIds: { citadel: ['0:0', '40:0'], medieval: ['12:8'] },
    paid: ['citadel:half'],
  });
  const { items } = toPayload({ relics });

  const relicGroups = items.filter((g) => g.kind === 'relic');
  assert.deepEqual(relicGroups.map((g) => g.scope).sort(), ['citadel', 'medieval']);
  assert.deepEqual(relicGroups.find((g) => g.scope === 'citadel').keys, ['0:0', '40:0']);
  assert.deepEqual(items.find((g) => g.kind === 'relic_paid').keys, ['citadel:half']);
});

test('a best time travels in milliseconds, scoped by world', () => {
  /* The column is BIGINT. A float of seconds would truncate a personal best to
   * the nearest whole second, which for a time trial is the whole point of it. */
  const trials = { read: () => ({ best: { 'citadel/rooftop': { time: 42.531, worldId: 'citadel' } } }) };
  const { values } = toPayload({ trials });

  assert.deepEqual(values, [{ kind: 'trial', scope: 'citadel', key: 'rooftop', value: 42531 }]);
});

test('a survey state travels as an ordered number', () => {
  /* 'landed' must outrank 'sighted', or GREATEST would let a later flyby
   * un-land a world the player actually set down on. */
  const objectives = recorder({ survey: { cinder: 'landed', vault: 'sighted' }, kills: {}, ore: {} });
  const { values } = toPayload({ objectives });
  const by = Object.fromEntries(values.filter((v) => v.kind === 'survey').map((v) => [v.key, v.value]));

  assert.equal(by.cinder, 2);
  assert.equal(by.vault, 1);
  assert.ok(by.cinder > by.vault, 'landed must outrank sighted');
});

test('rosters do not travel', () => {
  const objectives = recorder({
    kills: {}, survey: {}, ore: {}, wings: [],
    elements: { fe: 'Iron' },
    wingRoster: { alpha: 'Alpha Wing' },
  });
  const { items, values } = toPayload({ objectives });
  const blob = JSON.stringify({ items, values });

  assert.ok(!blob.includes('Iron'), 'an element roster is a lookup, not progress');
  assert.ok(!blob.includes('Alpha Wing'), 'a wing roster is a lookup, not progress');
});

test('a system that throws does not cost the others their sync', () => {
  const relics = { serialize() { throw new Error('boom'); } };
  const mining = recorder({ taken: ['n1'], mined: 1, credits: 30 });

  const { items } = toPayload({ relics, mining });
  assert.ok(items.some((g) => g.kind === 'mining'), 'one bad system suppressed the whole payload');
});

test('an absent system contributes nothing rather than throwing', () => {
  const out = toPayload({});
  assert.deepEqual(out, { items: [], values: [] });
});

/* ====================================================================== */
/* Ledger state -> local systems                                           */
/* ====================================================================== */

test('the merged relic answer is applied, with found derived from the ids', () => {
  const relics = recorder({ found: {}, foundIds: {}, paid: [] });
  applyState({ items: { relic: { citadel: ['0:0', '40:0', '60:0'] }, relic_paid: { '': ['citadel:half'] } } },
    { relics });

  const got = relics.restored.at(-1);
  assert.deepEqual(got.foundIds.citadel, ['0:0', '40:0', '60:0']);
  assert.equal(got.found.citadel, 3, 'found must be derived from the ids, never sent separately');
  assert.deepEqual(got.paid, ['citadel:half']);
});

test('applying an objectives answer keeps the local rosters', () => {
  const objectives = recorder({
    kills: { raider: 3 }, survey: {}, ore: {}, wings: [],
    elements: { fe: 'Iron' },
    wingRoster: { alpha: 'Alpha Wing' },
    killTier: 0, oreTier: 0,
  });
  applyState({ values: { kills: { '': { raider: 11 } } } }, { objectives });

  const got = objectives.restored.at(-1);
  assert.equal(got.kills.raider, 11, 'the merged count was not applied');
  assert.deepEqual(got.elements, { fe: 'Iron' }, 'the element roster was erased by a sync');
  assert.deepEqual(got.wingRoster, { alpha: 'Alpha Wing' }, 'the wing roster was erased by a sync');
});

test('an ore row keeps its display name, which the ledger never carried', () => {
  const objectives = recorder({
    kills: {}, survey: {}, wings: [],
    ore: { fe: { n: 2, credits: 40, name: 'Iron' } },
  });
  applyState({ values: { ore: { n: { fe: 9 }, credits: { fe: 180 } } } }, { objectives });

  const got = objectives.restored.at(-1);
  assert.equal(got.ore.fe.n, 9);
  assert.equal(got.ore.fe.credits, 180);
  assert.equal(got.ore.fe.name, 'Iron', 'the name is a roster fact and must survive');
});

test('a survey rank comes back as its name', () => {
  const objectives = recorder({ kills: {}, survey: {}, ore: {}, wings: [] });
  applyState({ values: { survey: { '': { cinder: 2, vault: 1 } } } }, { objectives });

  assert.deepEqual(objectives.restored.at(-1).survey, { cinder: 'landed', vault: 'sighted' });
});

test('best times come back as seconds under their world/venue key', () => {
  const merged = [];
  applyState({ values: { trial: { citadel: { rooftop: 37500 } } } },
    { trials: { read: () => null, merge: (b) => { merged.push(b); return 1; } } });

  assert.deepEqual(merged.at(-1), { 'citadel/rooftop': { time: 37.5, worldId: 'citadel' } });
});

test('an empty answer applies nothing rather than wiping the systems', () => {
  /* The failure that would be invisible: a server with no rows yet, applied as
   * if it were the truth, deleting a local save's progress on first sync. */
  const relics = recorder({ found: { citadel: 9 }, foundIds: { citadel: ['0:0'] }, paid: [] });
  const objectives = recorder({ kills: { raider: 4 }, survey: {}, ore: {}, wings: [] });

  const applied = applyState({ items: {}, values: {} }, { relics, objectives });

  assert.equal(applied, 0);
  assert.equal(relics.restored.length, 0, 'an empty ledger must not clear a local system');
  assert.equal(objectives.restored.length, 0);
});

/* ====================================================================== */
/* The round trip                                                          */
/* ====================================================================== */

test('the round trip posts the payload and adopts the answer', async () => {
  const relics = recorder({ found: {}, foundIds: { citadel: ['0:0'] }, paid: [] });
  let sent = null;

  const res = await syncProgress({ relics }, {
    fetch: async (_url, opts) => {
      sent = JSON.parse(opts.body);
      return {
        ok: true,
        json: async () => ({
          state: { items: { relic: { citadel: ['0:0', '40:0'] } }, values: {} },
          changed: 1,
          rejected: [],
        }),
      };
    },
  });

  assert.equal(res.ok, true);
  assert.deepEqual(sent.items.find((g) => g.kind === 'relic').keys, ['0:0']);
  assert.deepEqual(relics.restored.at(-1).foundIds.citadel, ['0:0', '40:0'],
    'the merged answer was not adopted');
});

test('a failed sync is survivable and changes nothing locally', async () => {
  const relics = recorder({ found: {}, foundIds: { citadel: ['0:0'] }, paid: [] });

  const res = await syncProgress({ relics }, { fetch: async () => ({ ok: false, status: 401 }) });

  assert.equal(res.ok, false);
  assert.equal(relics.restored.length, 0, 'a refused sync must not touch local progress');
});

test('a sync with no fetch available is a no-op, not a crash', async () => {
  const res = await syncProgress({}, { fetch: null });
  assert.equal(res.ok, false);
});

/* ====================================================================== */
/* The boot order, which is the whole correctness argument                  */
/* ====================================================================== */

test('the boot path loads, then arbitrates, then merges, then starts', () => {
  /* This ordering IS the fix, and none of it can be asserted behaviourally -
   * it lives in `main.js`, which no test can construct. So it is scraped,
   * for the same reason `save-boot-order.test.mjs` scrapes its call site: a
   * rebuilt copy of the wiring would prove only that the copy was sound.
   *
   * Why each step sits where it does:
   *   1. `hooks.resume` -> `save.load()`. The local save is the fuller copy on
   *      whichever device was last used, so it lands first.
   *   2. `adoptRemoteIfNewer`. Runs AFTER the load, or it would read the
   *      pristine boot state's timestamp instead of the save's and conclude the
   *      server was newer every single time.
   *   3. `syncAccountProgress`. The union, last, so it merges against the copy
   *      that actually won steps 1-2.
   *   4. `game:started`, which arms the autosave. */
  const file = readFileSync(new URL('../../src/main.js', import.meta.url), 'utf8');

  /* Scope to the `enter()` body. Searching the whole file finds each function's
   * DECLARATION, which sits earlier than the boot path that calls it, and the
   * ordering assertion below would then be measuring where things are defined
   * rather than the order they run in - green, and about the wrong thing. */
  const from = file.indexOf('const enter = () => {');
  assert.ok(from > 0, 'the boot enter() path has been renamed');
  const src = file.slice(from, file.indexOf("bus.emit('game:started')", from) + 40);

  const at = (needle) => {
    const i = src.indexOf(needle);
    assert.ok(i >= 0, `${needle} is missing from the boot path`);
    return i;
  };

  const load = at('hooks.resume?.()');
  const adopt = at('adoptRemoteIfNewer()');
  const merge = at('syncAccountProgress()');
  const started = at("bus.emit('game:started')");

  assert.ok(load < adopt,
    'the remote arbitration must run AFTER the local load, or it compares against a pristine save');
  assert.ok(adopt < merge,
    'the union must merge against the copy that won the arbitration');
  assert.ok(merge < started,
    'progress must be settled before game:started arms the autosave');
});

test('the last-write-wins blob carries a timestamp to arbitrate on', () => {
  /* `piloting` and `character` cannot merge - one position, one appearance - so
   * they ride the blob and the newer wins. That is only sound while the blob
   * actually stamps itself. */
  const src = readFileSync(new URL('../../src/main.js', import.meta.url), 'utf8');
  const start = src.indexOf('function buildRemotePayload');
  const body = src.slice(start, src.indexOf('\n}', start));

  assert.ok(/at:\s*Date\.now\(\)/.test(body), 'the remote blob must stamp itself');
  for (const field of ['piloting', 'character', 'inventory', 'mounts', 'cosmetics']) {
    assert.ok(new RegExp(`\\b${field}:`).test(body), `${field} is not being sent to the account`);
  }
  assert.ok(!/\bcredits:/.test(body),
    'the balance is the server\'s and must never ride this payload again');
});

/* ====================================================================== */
/* The mission spine                                                       */
/* ====================================================================== */

test('every kind this file sends is a kind the ledger knows', async () => {
  /* THE GATE THAT MATTERS MOST HERE, and it is new with the mission drop
   * because that drop added four kinds at once.
   *
   * `mergeProgress` REJECTS an unknown kind rather than storing it: it lands in
   * `rejected[]`, the client logs one console line nobody reads, and the
   * player's progress in that kind silently never crosses a device. Nothing
   * errors. So the two lists are compared directly, against a payload that
   * exercises every producer in `toPayload`. */
  const { Charters } = await import('../../src/systems/Charters.js');
  const ledgerSrc = readFileSync(new URL('../../site/lib/progressLedger.ts', import.meta.url), 'utf8');
  const block = ledgerSrc.slice(
    ledgerSrc.indexOf('Object.freeze({'),
    ledgerSrc.indexOf('export type ProgressKind')
  );
  const known = new Set([...block.matchAll(/^\s{4}(\w+):\s*\{\s*shape/gm)].map((m) => m[1]));
  assert.ok(known.size >= 10, `the KINDS scrape found ${known.size} kinds - it has broken`);

  const bus = { on: () => () => {}, emit: () => {} };
  const charters = new Charters({ bus, worldManager: { ids: ['station'], displayNameOf: (i) => i } });
  /* All three station deeds, so the record is COMPLETE and there is a charter
   * in the payload. With an incomplete record `toPayload` sends no `charter`
   * group at all - an empty list is not a group - and this case passed with the
   * kind deleted from the ledger, which is the failure it exists to catch. */
  charters.deserialize({
    rosters: {},
    charters: [],
    deeds: ['station/trade', 'station/mount', 'station/gateway'],
  });
  assert.equal(charters.charteredCount, 1, 'the fixture does not produce a charter');

  const { items, values } = toPayload({
    relics: recorder({ found: { citadel: 1 }, foundIds: { citadel: ['0:0'] }, paid: ['a'] }),
    viewpoints: recorder({ worlds: { citadel: ['v'] }, charts: { citadel: ['c'] }, sets: ['citadel'] }),
    mining: recorder({ taken: ['cinder/tephra_1'], mined: 1, credits: 9 }),
    objectives: recorder({
      wings: ['ashlane'], kills: { skiff: 2 }, survey: { cinder: 'landed' },
      ore: { tephra: { n: 1, credits: 9 } }, killTier: 1, oreTier: 0,
      wingSet: true, surveySet: false, landfallSet: false,
    }),
    trials: { read: () => ({ best: { 'citadel/ascent': { time: 63 } } }) },
    races: { read: () => ({ best: { 'race/vellum/expert': { time: 101.5 } } }) },
    charters,
    onboarding: { serialize: () => ({ done: ['move'] }) },
  });

  const sent = new Set([...items.map((g) => g.kind), ...values.map((v) => v.kind)]);
  assert.ok(sent.size >= 14, `only ${sent.size} kinds were produced - the fixture has stopped exercising them`);
  for (const kind of sent) {
    assert.ok(known.has(kind), `ProgressSync sends "${kind}", which progressLedger.ts refuses`);
  }
});

test('charters and deeds travel, and the learned rosters do not', async () => {
  const { Charters } = await import('../../src/systems/Charters.js');
  const bus = { on: () => () => {}, emit: () => {} };
  const charters = new Charters({ bus, worldManager: { ids: ['maze'], displayNameOf: (i) => i } });
  charters.deserialize({
    rosters: { maze: { deeds: 1 }, cinder: { seams: 110 } },
    charters: [],
    deeds: ['maze/centre'],
  });

  const { items } = toPayload({ charters });
  const deed = items.find((g) => g.kind === 'deed');
  assert.ok(deed, 'no deed group was sent');
  assert.equal(deed.scope, 'maze', 'a deed is not scoped to the world it belongs to');
  assert.deepEqual(deed.keys, ['centre']);

  /* The rosters are what a WORLD published, not what a player did. A device on
   * an older build could otherwise hand this one a denominator its own worlds
   * no longer have, and the charter would become uncompletable. */
  const flat = JSON.stringify(items);
  assert.ok(!flat.includes('110'), 'a learned roster was sent to the server');
  assert.ok(!items.some((g) => g.kind === 'roster'), 'the rosters are travelling');
});

test('a charter arriving from another device is a claim, not a verdict', async () => {
  const { Charters } = await import('../../src/systems/Charters.js');
  const bus = { on: () => () => {}, emit: () => {} };
  const charters = new Charters({
    bus, worldManager: { ids: ['maze', 'citadel'], displayNameOf: (i) => i },
  });

  /* The server says both are charted. The Coil's record is one deed and this
   * device does not hold it; the citadel's record is not even known here. A
   * sync that took either on trust would mint charter rank from a POST. */
  applyState({ items: { charter: { '': ['maze', 'citadel'] } }, values: {} }, { charters });

  assert.equal(charters.isChartered('maze'), false, 'a forged charter was adopted');
  assert.equal(charters.isChartered('citadel'), false, 'a charter for an unsurveyed world was adopted');

  /* And with the deed it is made of, it stands - which is the half that has to
   * work or nothing crosses devices at all. */
  applyState({
    items: { charter: { '': ['maze'] }, deed: { maze: ['centre'] } },
    values: {},
  }, { charters });
  assert.equal(charters.isChartered('maze'), true, 'a charter backed by its own deed did not cross');
});

test('a circuit best crosses with its grade intact', () => {
  const { values } = toPayload({
    races: { read: () => ({ best: { 'race/cinder/expert': { time: 101.5 } } }) },
  });
  const row = values.find((v) => v.kind === 'race');
  assert.ok(row, 'no circuit time was sent');
  assert.equal(row.scope, 'race');
  assert.equal(row.key, 'cinder/expert', 'the grade was dropped, so easy and expert are one record');
  assert.equal(row.value, 101500, 'the time was not sent in milliseconds and a BIGINT would truncate it');

  const merged = [];
  applyState({ items: {}, values: { race: { race: { 'cinder/expert': 88250 } } } }, {
    races: { merge: (best) => merged.push(best) },
  });
  assert.deepEqual(merged, [{ 'race/cinder/expert': { time: 88.25, worldId: 'race' } }]);
});

test('the opening sequence unions across devices rather than replacing', () => {
  const local = { done: ['move', 'talk'] };
  const seen = [];
  applyState({ items: { onboarding: { '': ['fire'] } }, values: {} }, {
    onboarding: {
      serialize: () => local,
      deserialize: (d) => { seen.push(d); return true; },
    },
  });
  /* A phone three steps behind must not un-teach what this desktop already
   * did. `deserialize` REPLACES by design, so the union is built here. */
  assert.equal(seen.length, 1);
  assert.deepEqual([...seen[0].done].sort(), ['fire', 'move', 'talk']);
});
