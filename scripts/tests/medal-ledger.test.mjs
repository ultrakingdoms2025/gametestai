import { test } from 'node:test';
import assert from 'node:assert/strict';

/**
 * THE MEDAL IS A RECORD, NOT A SENTENCE.
 *
 * ── The defect this file exists to hold shut ──────────────────────────────
 *
 * `RooftopTrial` grades a finish gold / silver / bronze against three MEASURED
 * par times, seven citadel venues use it, and the whole thing evaporated the
 * instant the result card closed. `SaveGame._recordTrial` stored
 * `{time, label, worldId}` and nothing else, so:
 *
 *   - a gold run that was SLOWER than the player's best never reached the
 *     write at all, because the `prev.time <= time` guard - which is the right
 *     guard for a time - returned first. A player could take gold on Tuesday
 *     and have the game forget it on Wednesday;
 *   - `Charters` could not count golds because there were none stored to
 *     count;
 *   - and the payout was flat, so a run 14% inside the reference pace and a
 *     bronze scraped with two seconds to spare paid identically. A repeat win
 *     at a venue you already held moved NOTHING.
 *
 * Every case below drives the REAL `SaveGame` through the REAL
 * `minigame:finished` channel, or the real `Charters` through its own
 * `deserialize`, for the reason `records-panel.test.mjs` states: a fixture
 * that hand-built `{medal:'gold'}` would pass for ever against a system that
 * had stopped writing it.
 *
 * ── The proof each gate can fail ──────────────────────────────────────────
 *
 * Run against the pre-change tree, the ones marked below fail:
 *   'a slow gold survives the MIN-on-time guard'      - no `medal` key at all
 *   'a faster silver never demotes a held gold'       - same
 *   'a sync from a device with no medal cannot erase one' - same
 *   'the medal grades the payout'                     - flat prize
 *   'golds are counted across every venue'            - `mastery()` had no row
 *   'the wardrobe row reads the shape Cosmetics writes' - count was hard zero
 */

/* ---------------------------------------------------------------------- */
/* Environment: SaveGame touches localStorage and window at construction    */
/* ---------------------------------------------------------------------- */

const store = new Map();
globalThis.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: (k) => store.delete(k),
  clear: () => store.clear(),
};
globalThis.window = globalThis.window ?? globalThis;
globalThis.window.addEventListener = globalThis.window.addEventListener ?? (() => {});
globalThis.window.removeEventListener = globalThis.window.removeEventListener ?? (() => {});

const { SaveGame, MEDAL_ORDER, medalRank, bestMedal } = await import('../../src/systems/SaveGame.js');
const { Charters, CHARTER_MEDALS } = await import('../../src/systems/Charters.js');
const { Cosmetics, COSMETIC_TOTAL, CHARACTER_SKINS, MOUNT_SKINS } =
  await import('../../src/systems/Cosmetics.js');
const { KNOWN_SHIP_SKIN_IDS } = await import('../../src/ships/ShipStats.js');
const {
  MinigameManager, MINIGAME_STATE, MEDAL_PRIZE_SHARE, medalPrize, medalOf,
  venuePrize, consolationFor,
} = await import('../../src/minigames/MinigameManager.js');
const { EventBus } = await import('../../src/core/EventBus.js');

const DT = 1 / 60;

/** A real SaveGame with its own internal trial ledger (no injected system). */
function makeSave() {
  store.clear();
  const bus = new EventBus();
  const save = new SaveGame({
    bus,
    player: { position: { x: 0, y: 0, z: 0 }, yaw: 0, health: 100, maxHealth: 100 },
    worldManager: { active: { id: 'citadel' }, ids: ['citadel'] },
    economy: { credits: 0 },
  });
  save.disableAutosave();
  return { bus, save };
}

/** One finished contest, down the channel the manager really emits on. */
const finish = (bus, over = {}) => bus.emit('minigame:finished', {
  gameId: 'rooftop_trial',
  venueId: 'citadel_skyline',
  worldId: 'citadel',
  label: 'The Skyline',
  won: true,
  time: 60,
  score: null,
  ...over,
});

/* ====================================================================== */
/* 1. The two records, kept apart                                          */
/* ====================================================================== */

test('the medal ladder is one order, spelled once per file and pinned', () => {
  /* `Charters` keeps its own copy rather than importing the persistence layer
   * (see the note on its import). A copy that could drift is a copy that will,
   * so the agreement is a gate rather than a comment. */
  assert.deepEqual([...CHARTER_MEDALS], [...MEDAL_ORDER]);
  assert.equal(medalRank('gold'), 3);
  assert.equal(medalRank('bronze'), 1);
  /* Every other contest's `score` must rank zero, or a tennis scoreline
   * becomes a medal. */
  assert.equal(medalRank('6-4 6-3'), 0);
  assert.equal(medalRank(41.2), 0);
  assert.equal(medalRank(null), 0);
  assert.equal(bestMedal('silver', 'gold'), 'gold');
  assert.equal(bestMedal('gold', 'silver'), 'gold');
  assert.equal(bestMedal(null, 'bronze'), 'bronze');
  assert.equal(bestMedal(41.2, null), null);
});

test('a slow gold survives the MIN-on-time guard', () => {
  const { bus, save } = makeSave();
  // A quick silver first: this is the personal best.
  finish(bus, { time: 40, score: 'silver' });
  assert.equal(save.bestTrialTime('citadel_skyline', 'citadel'), 40);
  assert.equal(save.bestTrialMedal('citadel_skyline', 'citadel'), 'silver');

  /* A SLOWER run that graded better. The time must not move - it is worse -
   * and the medal must. Pre-change this whole call returned at the first
   * guard and the gold was dropped on the floor. */
  finish(bus, { time: 55, score: 'gold' });
  assert.equal(save.bestTrialTime('citadel_skyline', 'citadel'), 40,
    'a slower run overwrote the best time');
  assert.equal(save.bestTrialMedal('citadel_skyline', 'citadel'), 'gold',
    'a gold earned on a slower run was discarded');
});

test('a faster silver never demotes a held gold', () => {
  const { bus, save } = makeSave();
  finish(bus, { time: 55, score: 'gold' });
  finish(bus, { time: 30, score: 'silver' });
  assert.equal(save.bestTrialTime('citadel_skyline', 'citadel'), 30);
  assert.equal(save.bestTrialMedal('citadel_skyline', 'citadel'), 'gold',
    'the medal is grow-only and a later silver took the gold away');
});

test('a loss records neither record', () => {
  const { bus, save } = makeSave();
  finish(bus, { time: 55, score: 'gold', won: false });
  assert.equal(save.bestTrialTime('citadel_skyline', 'citadel'), null);
  assert.equal(save.bestTrialMedal('citadel_skyline', 'citadel'), null);
});

test('an ungraded contest stores a time and no medal', () => {
  const { bus, save } = makeSave();
  // The swim puts a CLOCK in `score`; the tennis a games string.
  finish(bus, { venueId: 'lido', time: 41.2, score: 41.2 });
  finish(bus, { venueId: 'court', time: 300, score: '6-4 6-3' });
  assert.equal(save.bestTrialMedal('lido', 'citadel'), null,
    'a clock in `score` was read as a medal');
  assert.equal(save.bestTrialMedal('court', 'citadel'), null,
    'a tennis scoreline was read as a medal');
  assert.equal(save.bestTrialTime('lido', 'citadel'), 41.2);
});

test('trial:best says WHICH record moved', () => {
  const { bus, save } = makeSave();
  const seen = [];
  bus.on('trial:best', (p) => seen.push(p));
  finish(bus, { time: 55, score: 'silver' });
  finish(bus, { time: 58, score: 'gold' });   // medal only
  finish(bus, { time: 30, score: 'bronze' }); // time only
  assert.equal(seen.length, 3);
  assert.deepEqual(seen.map((s) => s.personalBest), [true, false, true]);
  assert.deepEqual(seen.map((s) => s.medalGained), ['silver', 'gold', null]);
  assert.deepEqual(seen.map((s) => s.medal), ['silver', 'gold', 'gold']);
  void save;
});

/* ====================================================================== */
/* 2. Cross-device: absent is unknown, not worse                           */
/* ====================================================================== */

test('a sync from a device with no medal cannot erase one', () => {
  const { bus, save } = makeSave();
  finish(bus, { time: 55, score: 'gold' });

  /* What `ProgressSync` actually hands back: ONE server column per venue, a
   * BIGINT of milliseconds. There is no medal on the wire, and there never
   * will be while the column is a number. */
  const improved = save.mergeTrials({
    'citadel/citadel_skyline': { time: 30, worldId: 'citadel' },
  });
  assert.equal(improved, 1);
  assert.equal(save.bestTrialTime('citadel_skyline', 'citadel'), 30);
  assert.equal(save.bestTrialMedal('citadel_skyline', 'citadel'), 'gold',
    'a remote row with no medal deleted the local one');
});

test('a slower remote row moves nothing but can still upgrade the medal', () => {
  const { bus, save } = makeSave();
  finish(bus, { time: 30, score: 'bronze' });
  const improved = save.mergeTrials({
    'citadel/citadel_skyline': { time: 99, medal: 'gold', worldId: 'citadel' },
  });
  assert.equal(improved, 1);
  assert.equal(save.bestTrialTime('citadel_skyline', 'citadel'), 30,
    'a slower remote time replaced the local best');
  assert.equal(save.bestTrialMedal('citadel_skyline', 'citadel'), 'gold');
});

test('both records survive a save round trip, and an old save loads clean', () => {
  const { bus, save } = makeSave();
  finish(bus, { time: 30, score: 'gold' });
  const snap = save.trialLedger();
  assert.equal(snap.best['citadel/citadel_skyline'].medal, 'gold');

  const { save: fresh } = makeSave();
  fresh._restoreTrials(snap);
  assert.equal(fresh.bestTrialMedal('citadel_skyline', 'citadel'), 'gold');

  /* A save written before medals existed. Absence is valid - the reader
   * answers null rather than inventing a grade or refusing the load. */
  const { save: old } = makeSave();
  old._restoreTrials({ best: { 'citadel/citadel_souk_dash': { time: 91.2, label: 'Souk' } } });
  assert.equal(old.bestTrialTime('citadel_souk_dash', 'citadel'), 91.2);
  assert.equal(old.bestTrialMedal('citadel_souk_dash', 'citadel'), null);
});

/* ====================================================================== */
/* 3. The payout ladder                                                    */
/* ====================================================================== */

test('the medal shares are a ladder that only ever descends from the prize', () => {
  assert.equal(MEDAL_PRIZE_SHARE.gold, 1,
    'gold pays anything but the whole prize - see the 250 CR reported-event ceiling');
  assert.ok(MEDAL_PRIZE_SHARE.gold > MEDAL_PRIZE_SHARE.silver);
  assert.ok(MEDAL_PRIZE_SHARE.silver > MEDAL_PRIZE_SHARE.bronze);
  assert.ok(MEDAL_PRIZE_SHARE.bronze > 0);
  /* The hard external constraint, restated as a number so a future multiplier
   * fails here rather than at the server. `site/lib/creditPricing.ts` caps a
   * reported `minigame` event at 250, and the richest venue publishes 18. */
  assert.ok(venuePrize(18) * MEDAL_PRIZE_SHARE.gold <= 250,
    'a gold at the richest venue would be refused by the credit reporter');
});

test('medalOf reads the one contest that grades and no other', () => {
  assert.equal(medalOf('gold'), 'gold');
  assert.equal(medalOf('none'), null);
  assert.equal(medalOf('dnf'), null);
  assert.equal(medalOf(41.2), null);
  assert.equal(medalOf('6-4 6-3'), null);
  assert.equal(medalOf(null), null);
});

test('an ungraded win pays exactly the venue prize, as it always did', () => {
  for (const raw of [8, 10, 12, 14, 15, 18, 120]) {
    const prize = venuePrize(raw);
    assert.equal(medalPrize(prize, null, consolationFor({ reward: prize })), prize,
      `a contest that grades nothing stopped paying its prize at reward ${raw}`);
  }
});

test('winning always pays more than finishing, at every venue and every grade', () => {
  for (const raw of [8, 10, 12, 14, 15, 18, 120]) {
    const prize = venuePrize(raw);
    const floor = consolationFor({ reward: prize });
    let last = floor;
    for (const medal of ['bronze', 'silver', 'gold']) {
      const paid = medalPrize(prize, medal, floor);
      assert.ok(Number.isInteger(paid), `${raw}/${medal} paid a fractional credit`);
      assert.ok(paid > floor,
        `${raw}/${medal} paid ${paid} against a ${floor} participation floor - `
        + 'winning must never pay less than finishing');
      assert.ok(paid >= last, `${raw}/${medal} is not above the grade below it`);
      assert.ok(paid <= prize, `${raw}/${medal} paid ${paid}, above the venue prize ${prize}`);
      last = paid;
    }
    assert.equal(medalPrize(prize, 'gold', floor), prize, 'gold is the whole prize');
  }
});

test('a pathological venue cannot make a bronze win pay less than the loss', () => {
  /* A venue that publishes a floor one credit under its own prize. The share
   * would put bronze below it; the clamp puts it exactly one above. */
  const prize = venuePrize(120);
  const floor = consolationFor({ reward: prize, consolation: prize - 1 });
  assert.equal(floor, prize - 1);
  assert.equal(medalPrize(prize, 'bronze', floor), prize);
});

/* ====================================================================== */
/* 4. The payout, through the real manager                                 */
/* ====================================================================== */

/**
 * One contest played to its end on a REAL manager, with a stub game whose
 * outcome the caller chooses.
 *
 * Deliberately not a real rooftop trial: the property under test belongs to
 * `MinigameManager._finish`, and driving a real trial would measure the
 * citadel's routes instead. The shape is `minigame-payout.test.mjs`'s, because
 * that file already pinned exactly how a contest is started and stepped.
 */
function playFor(score, reward = 18) {
  const bus = new EventBus();
  const wallet = [];
  const notes = [];
  bus.on('hud:notify', (p) => notes.push(p.text));
  const mgr = new MinigameManager({
    bus,
    player: { position: { x: 0, y: 0, z: 0 } },
    economy: { add: (n, why) => wallet.push({ n, why }) },
    input: null,
    worldManager: null,
  });
  mgr.registerGame('stub', () => ({
    id: 'rooftop_trial',
    countdown: 0.001,
    begin() {},
    fixedUpdate: () => ({ won: true, place: 1, total: 2, score, scoreLabel: 'x' }),
    snapshot: () => ({ rows: [] }),
    dispose() {},
  }));
  bus.emit('world:changed', {
    id: 'citadel',
    world: {
      minigameVenues: [{
        id: 'v1', kind: 'stub', label: 'The Skyline', reward,
        centre: { x: 0, y: 0, z: 0 }, radius: 40, yTolerance: 30,
      }],
    },
  });
  mgr.update(DT);
  assert.equal(mgr.start('v1'), true, 'the contest did not start');
  for (let i = 0; i < 600 && mgr.running; i++) mgr.fixedUpdate(DT, i * DT);
  assert.equal(mgr.state, MINIGAME_STATE.FINISHED, 'the contest never finished');
  const result = mgr.result;
  mgr.dispose();
  return { wallet, result, notes };
}

test('the medal grades the payout, and the result carries the grade', () => {
  const gold = playFor('gold');
  const silver = playFor('silver');
  const bronze = playFor('bronze');
  const plain = playFor(41.2);

  assert.equal(gold.wallet[0].n, venuePrize(18));
  assert.equal(plain.wallet[0].n, venuePrize(18), 'an ungraded win stopped paying the prize');
  assert.ok(silver.wallet[0].n < gold.wallet[0].n,
    'silver paid the same as gold - the whole defect this replaces');
  assert.ok(bronze.wallet[0].n < silver.wallet[0].n);
  assert.ok(bronze.wallet[0].n > consolationFor({ reward: venuePrize(18) }));

  assert.equal(gold.result.medal, 'gold');
  assert.equal(plain.result.medal, null, 'a clock in `score` was promoted to a medal');
  assert.equal(gold.result.credits, gold.wallet[0].n);
});

test('the toast names the grade the payout was computed from', () => {
  const { notes, wallet } = playFor('bronze');
  const won = notes.find((t) => /won/.test(t));
  assert.ok(won, 'the win said nothing at all');
  assert.match(won, /bronze/,
    `"${won}" pays a bronze share without saying it is a bronze`);
  assert.ok(won.includes(`+${wallet[0].n} credits`),
    `the toast "${won}" does not name the ${wallet[0].n} credits it paid`);
  /* An ungraded win must read exactly as it always did. */
  const plain = playFor(41.2).notes.find((t) => /won/.test(t));
  assert.doesNotMatch(plain, /gold|silver|bronze/);
});

/* ====================================================================== */
/* 5. Charters: the grid and the golds                                     */
/* ====================================================================== */

const worldManager = {
  ids: ['station', 'citadel', 'sports'],
  displayNameOf: (id) => id,
};

/** A Charters reading a trial ledger we control, shaped as SaveGame writes it. */
function charteredWith(best) {
  const bus = new EventBus();
  const charters = new Charters({
    bus, worldManager, trials: { read: () => ({ best }) },
  });
  return charters;
}

test('the medal grid fills up to the grade held, because the pars nest', () => {
  const charters = charteredWith({
    'citadel/citadel_skyline': { time: 30, label: 'The Skyline', medal: 'gold' },
    'citadel/citadel_ascent': { time: 44, label: 'The Long Ascent', medal: 'bronze' },
    'citadel/citadel_souk_dash': { time: 91, label: 'Souk Rooftop Dash', medal: 'silver' },
    /* An ungraded venue. It has a best time and belongs on the Trials column,
     * not on this grid. */
    'sports/lido': { time: 41.2, label: 'Lido Swim' },
  });
  const rows = charters.medals();
  assert.equal(rows.length, 3, 'an ungraded venue was drawn on the medal grid');
  // Sorted by grade, then name.
  assert.deepEqual(rows.map((r) => r.medal), ['gold', 'silver', 'bronze']);
  const gold = rows[0];
  assert.deepEqual(gold.tiers.map((t) => t.held), [true, true, true],
    'a gold time is inside silver and bronze too, and the grid must say so');
  const bronze = rows[2];
  assert.deepEqual(bronze.tiers.map((t) => t.held), [true, false, false]);
  assert.deepEqual(bronze.tiers.map((t) => t.medal), [...CHARTER_MEDALS]);
  assert.equal(gold.worldId, 'citadel');
  assert.equal(gold.venueId, 'citadel_skyline');
  assert.equal(gold.time, 30);
});

test('golds are counted across every venue, over the venues that grade', () => {
  const charters = charteredWith({
    'citadel/a': { time: 1, label: 'A', medal: 'gold' },
    'citadel/b': { time: 1, label: 'B', medal: 'gold' },
    'citadel/c': { time: 1, label: 'C', medal: 'silver' },
    'sports/lido': { time: 41.2, label: 'Lido' },
  });
  const row = charters.mastery().find((r) => r.key === 'golds');
  assert.ok(row, 'mastery has no Golds row');
  assert.equal(row.value, 2);
  assert.equal(row.total, 3, 'the denominator counted a venue that has no grade');
  assert.equal(row.label, 'Golds');
});

test('a player who has never been graded gets no Golds row at all', () => {
  const charters = charteredWith({ 'sports/lido': { time: 41.2, label: 'Lido' } });
  assert.equal(charters.mastery().find((r) => r.key === 'golds'), undefined,
    'a row of zero was drawn where nothing has been graded');
  assert.deepEqual(charters.medals(), []);
});

/* ====================================================================== */
/* 6. The wardrobe finally has a denominator                               */
/* ====================================================================== */

test('COSMETIC_TOTAL is the union of the three catalogues, never a constant', () => {
  assert.equal(COSMETIC_TOTAL, CHARACTER_SKINS.length + MOUNT_SKINS.length + KNOWN_SHIP_SKIN_IDS.size);
  assert.ok(COSMETIC_TOTAL > 0);
  /* The three catalogues as they stand, so an accidental deletion is loud.
   * These are floors rather than equalities: adding a livery is ordinary and
   * must not fail the build, losing five is not. */
  assert.ok(CHARACTER_SKINS.length >= 5);
  assert.ok(MOUNT_SKINS.length >= 20);
  assert.ok(KNOWN_SHIP_SKIN_IDS.size >= 18);
});

test('the wardrobe row reads the shape Cosmetics actually writes', () => {
  /* THE REAL `Cosmetics`, through its own `unlock`. This is the whole point of
   * the case: `Charters.collection` read `serialize().owned`, and
   * `Cosmetics.serialize()` returns `{ unlocked: [...] }` - so the count was
   * hard zero in the shipped game, the panel drew the row only when the count
   * was above zero, and the row therefore never appeared. The unit test that
   * covered it handed back a bare array and passed. */
  const cosmetics = new Cosmetics({ bus: new EventBus() });
  assert.equal(cosmetics.unlock(CHARACTER_SKINS[0].id), true);
  assert.equal(cosmetics.unlock(MOUNT_SKINS[0].id), true);

  const charters = new Charters({ bus: new EventBus(), worldManager, cosmetics });
  const c = charters.collection();
  assert.equal(c.cosmetics, 2,
    'the wardrobe count is zero against a Cosmetics holding two skins');
  assert.equal(c.cosmeticTotal, COSMETIC_TOTAL);
  assert.ok(c.cosmetics < c.cosmeticTotal);
});

test('the bare-array and legacy wardrobe shapes still read', () => {
  const bare = new Charters({
    bus: new EventBus(), worldManager, cosmetics: { serialize: () => ['a', 'b', 'c'] },
  });
  assert.equal(bare.collection().cosmetics, 3);
  const legacy = new Charters({
    bus: new EventBus(), worldManager, cosmetics: { serialize: () => ({ owned: ['a'] }) },
  });
  assert.equal(legacy.collection().cosmetics, 1);
  const broken = new Charters({
    bus: new EventBus(), worldManager, cosmetics: { serialize: () => { throw new Error('no'); } },
  });
  assert.equal(broken.collection().cosmetics, 0, 'a throwing wardrobe cost the whole board');
});
