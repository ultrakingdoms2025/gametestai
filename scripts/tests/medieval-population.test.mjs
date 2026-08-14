import { test } from 'node:test';
import assert from 'node:assert/strict';

import { medievalHeight, HALF, WATER_Y, riverZ, riverHalfWidth } from '../../src/worlds/terrain/MedievalHeight.js';
import { SETTLEMENTS } from '../../src/worlds/medieval/Settlements.js';
import {
  planPopulation, planSettlement, planTravellers, quotaFor, resolveKind, tradeFor,
  PROFILES, TRADE, REFERENCE_RADIUS, defaultOpen,
} from '../../src/worlds/medieval/Population.js';

/**
 * THE MERGE GATE.
 *
 * The population of Aldermoor Vale is derived from `medieval/Settlements.js`
 * rather than written out per town, and the ONLY thing that makes that worth
 * doing is that it keeps working for a settlement nobody has written yet. A
 * table-driven populator that has only ever been run against the table it was
 * written against is indistinguishable, from the outside, from a hard-coded
 * one - right up until the branch that adds five towns lands and the world has
 * five empty towns in it.
 *
 * So the load-bearing tests here are the ones that run against settlements that
 * DO NOT EXIST. They synthesise the five the expansion is known to be adding -
 * a stilt fishing village, a hill mining town, a monastery, a palisade fort and
 * a crossroads market town - under kinds this file has deliberately not been
 * told about, and assert each one comes out populated, staffed and stocked
 * appropriately. And then they do it again with a kind that is pure nonsense,
 * because the failure mode that matters is the silent empty town.
 */

/* ------------------------------------------------------------------ */
/* Fixtures                                                            */
/* ------------------------------------------------------------------ */

/**
 * The five settlements the expansion adds, as they were described in the
 * brief, at the coordinates the terrain module already carries landforms for.
 *
 * Their `kind` strings are GUESSES - that is the point. None of them is a word
 * `PROFILES` knows, and the whole claim under test is that guessing wrong about
 * the spelling cannot leave a town empty.
 */
const FUTURE = [
  { id: 'reedwater', displayName: 'Reedwater', kind: 'stilt fishing village', centre: { x: -344, z: 111 }, radius: 58, plots: null, ground: [] },
  { id: 'grimscar', displayName: 'Grimscar', kind: 'hill mining town', centre: { x: -361, z: -152 }, radius: 78, plots: null, ground: [] },
  { id: 'st-ceolwine', displayName: "St Ceolwine's Abbey", kind: 'abbey', centre: { x: -300, z: 340 }, radius: 52, plots: null, ground: [] },
  { id: 'blackmarch', displayName: 'Blackmarch Hold', kind: 'frontier palisade fort', centre: { x: 348, z: -204 }, radius: 60, plots: null, ground: [] },
  { id: 'fenwick-cross', displayName: 'Fenwick Cross', kind: 'crossroads market town', centre: { x: 196, z: 344 }, radius: 96, plots: null, ground: [] },
];

/** A settlement whose kind is a word that means nothing at all. */
const NONSENSE = {
  id: 'zorblax', displayName: 'Zorblax', kind: 'quantum bratwurst',
  centre: { x: 250, z: 60 }, radius: 44, plots: null, ground: [],
};

const open = (x, z) => defaultOpen(x, z, medievalHeight);
const plan = (s, extra = {}) => planSettlement(s, { height: medievalHeight, open, ...extra });

/* ------------------------------------------------------------------ */
/* Every kind resolves, and every settlement is populated              */
/* ------------------------------------------------------------------ */

test('every settlement in the SHIPPED table gets a population', () => {
  for (const s of SETTLEMENTS) {
    const made = plan(s);
    const q = quotaFor(s);
    // A ruin is the one place allowed to hold only a keeper.
    assert.ok(made.length >= 1, `${s.id} came out empty`);
    assert.ok(made.length <= q.total, `${s.id} placed ${made.length} against a quota of ${q.total}`);
    for (const p of made) {
      assert.equal(p.settlement, s.id);
      assert.ok(p.name && p.persona, `${s.id} produced a nameless or personaless resident`);
      assert.ok(PROFILES[q.kindKey], `${s.id} resolved to an unknown profile`);
    }
  }
});

test('THE MERGE GATE: a settlement that does not exist yet is populated too', () => {
  for (const s of FUTURE) {
    const made = plan(s);
    const q = quotaFor(s);
    assert.ok(made.length >= 4,
      `${s.displayName} (kind "${s.kind}") got ${made.length} people - a new town would ship empty`);
    // Somewhere to trade. This is the one that would bite hardest: a town you
    // can walk to for four minutes and cannot buy anything in.
    const vendors = made.filter((m) => m.role === 'vendor');
    assert.ok(vendors.length >= 1, `${s.displayName} has nowhere to trade`);
    for (const v of vendors) {
      assert.ok(Array.isArray(v.vendorCategories) && v.vendorCategories.length,
        `${s.displayName}'s merchant sells nothing in particular`);
      assert.ok(v.vendorTitle, `${s.displayName}'s merchant has no stall title`);
      assert.ok(v.signLines?.length === 2, `${s.displayName}'s stall is unlettered`);
    }
    assert.ok(q.kindKey !== undefined);
  }
});

test('a kind nobody has ever heard of still gets a full village', () => {
  const { via, key } = resolveKind(NONSENSE.kind);
  assert.equal(via, 'default', 'the nonsense kind matched something by accident');
  assert.equal(key, 'village');
  const made = plan(NONSENSE);
  assert.ok(made.length >= 4, `an unknown kind produced ${made.length} people`);
  assert.ok(made.some((m) => m.role === 'vendor'), 'an unknown kind has nowhere to trade');
  assert.ok(made.some((m) => m.role === 'guard'), 'an unknown kind has no watch');
});

/* ------------------------------------------------------------------ */
/* Population is APPROPRIATE, not merely present                       */
/* ------------------------------------------------------------------ */

test('kind resolution reaches the right profile for each expected new town', () => {
  const want = {
    reedwater: 'village',       // "stilt fishing village"
    grimscar: 'mine',           // "hill mining town" - `mining` beats `town`
    'st-ceolwine': 'monastery', // "abbey"
    blackmarch: 'fort',         // "frontier palisade fort"
    'fenwick-cross': 'town',    // "crossroads market town"
  };
  for (const s of FUTURE) {
    assert.equal(resolveKind(s.kind).key, want[s.id],
      `"${s.kind}" resolved to ${resolveKind(s.kind).key}, not ${want[s.id]}`);
  }
});

test('a fishing village and a mine sell different things, derived from the ground they stand on', () => {
  const byId = Object.fromEntries(FUTURE.map((s) => [s.id, tradeFor(s)]));
  assert.equal(byId.reedwater.id, 'fishing');
  assert.equal(byId.grimscar.id, 'mine');
  assert.equal(byId['st-ceolwine'].id, 'monastic');
  assert.equal(byId.blackmarch.id, 'garrison');
  assert.equal(byId['fenwick-cross'].id, 'market');

  // And they are DERIVED, not declared: every one of the five is decided by a
  // landform or a river reach the terrain module already publishes, which is
  // the only reason this can work across a merge.
  for (const s of FUTURE) {
    const via = tradeFor(s).via;
    assert.ok(/^(landform|river):/.test(via),
      `${s.id} fell back to "${via}" - its trade is not derived from the map`);
  }

  // The stock actually differs. A fishing village selling plate armour is the
  // detail that makes a world read as generated rather than built.
  const stock = new Set(FUTURE.map((s) => tradeFor(s).def.categories.join('/')));
  assert.ok(stock.size >= 3, `five towns share only ${stock.size} distinct stock lists`);
});

test('nothing in the shipped inner vale is dragged onto a landform or a named reach', () => {
  /* The landform boxes are pinned disjoint from the inner square by
   * `medieval-landforms.test.mjs`, so every settlement that existed before the
   * expansion must still take its trade from its kind. If this fails, the
   * derivation has started reaching into the old vale and Aldermoor is about
   * to become a mining town. */
  for (const s of SETTLEMENTS) {
    assert.equal(tradeFor(s).via, 'kind', `${s.id} now derives its trade from the map`);
  }
});

test('quota scales with radius, and never rounds a small place down to nothing', () => {
  const base = { id: 'x', displayName: 'X', kind: 'village', ground: [], plots: null };
  const small = quotaFor({ ...base, centre: { x: 0, z: -300 }, radius: 12 });
  const big = quotaFor({ ...base, centre: { x: 0, z: -300 }, radius: REFERENCE_RADIUS * 3 });
  assert.ok(big.people > small.people, 'a big village is no busier than a tiny one');
  assert.ok(small.people >= 1, 'a small village rounded its people away');
  assert.ok(small.vendors >= 1, 'a small village rounded its merchant away');
  // Clamped at both ends, or a 300 m settlement would ask for a city.
  const huge = quotaFor({ ...base, centre: { x: 0, z: -300 }, radius: 900 });
  assert.ok(huge.people <= PROFILES.village.people * 1.8 + 1, `radius 900 asked for ${huge.people}`);
});

test('a settlement that already has people authored in it gets fewer, not double', () => {
  const s = FUTURE[4];                        // Fenwick Cross, the biggest
  const alone = plan(s).length;
  const crowded = plan(s, { already: 5 }).length;
  assert.equal(crowded, Math.max(0, alone - 5),
    'authored residents did not count against the quota');
  const saturated = plan(s, { already: 100 });
  assert.equal(saturated.length, 0, 'a fully hand-authored town still got filler');
});

test('the quota is spent on the merchant first and the filler last', () => {
  /* When a budget bites it must take the townsfolk, not the shop. Walking the
   * budget down from the full quota to one, a vendor has to survive longest. */
  const s = FUTURE[4];
  for (let b = 1; b <= 6; b++) {
    const made = plan(s, { budget: b });
    assert.equal(made.length, b);
    assert.ok(made.some((m) => m.role === 'vendor'),
      `at a budget of ${b} the town lost its merchant before its filler`);
  }
});

/* ------------------------------------------------------------------ */
/* Where they stand                                                    */
/* ------------------------------------------------------------------ */

test('no resident stands in deep water, in the channel, or outside the playfield', () => {
  const all = [...SETTLEMENTS, ...FUTURE, NONSENSE].flatMap((s) => plan(s));
  assert.ok(all.length > 40, 'not enough people planned to make this test mean anything');
  for (const p of all) {
    assert.ok(p.x > -HALF && p.x < HALF && p.z > -HALF && p.z < HALF,
      `${p.name} stands at ${p.x | 0},${p.z | 0}, outside the playfield`);
    const h = medievalHeight(p.x, p.z);
    assert.ok(h >= WATER_Y + 0.6, `${p.name} stands ${(WATER_Y - h).toFixed(2)} m under water`);
    const bank = Math.abs(p.z - riverZ(p.x));
    assert.ok(bank >= riverHalfWidth(p.x) + 3,
      `${p.name} stands in the channel at ${p.x | 0},${p.z | 0}`);
  }
});

test('every resident stands ON the ground - y is the height function, to the bit', () => {
  const all = [...SETTLEMENTS, ...FUTURE].flatMap((s) => plan(s));
  for (const p of all) {
    assert.equal(p.y, medievalHeight(p.x, p.z),
      `${p.name} is floating or buried at ${p.x | 0},${p.z | 0}`);
    for (const leg of p.patrol ?? []) {
      assert.equal(leg.y, medievalHeight(leg.x, leg.z),
        `${p.name} has a patrol leg off the ground`);
    }
  }
});

test('no two residents of a settlement are stacked on each other', () => {
  for (const s of [...SETTLEMENTS, ...FUTURE]) {
    const made = plan(s);
    for (let i = 0; i < made.length; i++) {
      for (let j = i + 1; j < made.length; j++) {
        const d = Math.hypot(made[i].x - made[j].x, made[i].z - made[j].z);
        assert.ok(d >= 3.19, `${s.id}: ${made[i].name} and ${made[j].name} are ${d.toFixed(2)} m apart`);
      }
    }
  }
});

test('every patrol leg is somewhere its owner could actually stand', () => {
  const all = [...SETTLEMENTS, ...FUTURE].flatMap((s) => plan(s));
  for (const p of all) {
    for (const leg of p.patrol ?? []) {
      assert.ok(open(leg.x, leg.z), `${p.name}'s route walks through ${leg.x | 0},${leg.z | 0}`);
    }
  }
});

/* ------------------------------------------------------------------ */
/* Travellers                                                          */
/* ------------------------------------------------------------------ */

test('travellers are placed on the roads, with the road as their route', () => {
  const roads = [
    { key: 'long', width: 6, pts: Array.from({ length: 40 }, (_, i) => [-150 + i * 8, -260]) },
    { key: 'stub', width: 4, pts: [[0, -300], [4, -300]] },
  ];
  const made = planTravellers(roads, { height: medievalHeight, open, budget: 4 });
  assert.ok(made.length >= 2, `only ${made.length} travellers found the road`);
  for (const t of made) {
    assert.equal(t.role, 'wanderer');
    assert.equal(t.road, 'long', 'a traveller was put on a two-metre stub');
    assert.ok(t.patrol.length > 1, 'a traveller has nowhere to walk');
    // On the verge: within a couple of metres of the road they belong to.
    assert.ok(Math.abs(t.z + 260) < 8, `traveller is ${Math.abs(t.z + 260).toFixed(1)} m off its road`);
  }
});

test('a world with no roads gets no travellers rather than an exception', () => {
  assert.deepEqual(planTravellers([], { height: medievalHeight, open, budget: 6 }), []);
  assert.deepEqual(planTravellers(null, { height: medievalHeight, open, budget: 6 }), []);
});

/* ------------------------------------------------------------------ */
/* Determinism and budget                                              */
/* ------------------------------------------------------------------ */

test('same table, same population - to the metre and to the name', () => {
  const a = planPopulation({ height: medievalHeight, open, settlements: [...SETTLEMENTS, ...FUTURE] });
  const b = planPopulation({ height: medievalHeight, open, settlements: [...SETTLEMENTS, ...FUTURE] });
  assert.equal(a.residents.length, b.residents.length);
  for (let i = 0; i < a.residents.length; i++) {
    assert.deepEqual(
      { x: a.residents[i].x, z: a.residents[i].z, n: a.residents[i].name, r: a.residents[i].role },
      { x: b.residents[i].x, z: b.residents[i].z, n: b.residents[i].name, r: b.residents[i].role },
    );
  }
});

test('table ORDER does not change who lives where', () => {
  /* The parallel branch will append its five settlements to the end of the
   * table, but a later one might insert them in the middle. Neither may move
   * anybody: `planPopulation` sorts by radius and seeds per settlement id. */
  const forward = planPopulation({ height: medievalHeight, open, settlements: [...SETTLEMENTS, ...FUTURE] });
  const reversed = planPopulation({ height: medievalHeight, open, settlements: [...FUTURE, ...SETTLEMENTS] });
  const key = (r) => `${r.settlement}|${r.name}|${r.x.toFixed(4)}|${r.z.toFixed(4)}`;
  assert.deepEqual(forward.residents.map(key).sort(), reversed.residents.map(key).sort());
});

test('a budget binds on the SMALLEST settlement, never on the market town', () => {
  const all = [...SETTLEMENTS, ...FUTURE];
  const full = planPopulation({ height: medievalHeight, open, settlements: all });
  const tight = planPopulation({ height: medievalHeight, open, settlements: all, budget: 30 });
  assert.equal(tight.residents.length, 30);
  const biggest = [...all].sort((a, b) => b.radius - a.radius)[0].id;
  assert.ok(tight.residents.some((r) => r.settlement === biggest),
    `a tight budget emptied ${biggest}, the largest settlement in the table`);
  assert.ok(full.residents.length > tight.residents.length);
});

test('the summary reports how every settlement was resolved, including the fallbacks', () => {
  const { perSettlement } = planPopulation({
    height: medievalHeight, open, settlements: [...SETTLEMENTS, NONSENSE],
  });
  const row = perSettlement.find((r) => r.id === 'zorblax');
  assert.ok(row, 'the summary lost a settlement');
  assert.equal(row.via, 'default');
  assert.ok(row.placed > 0, 'the summary reports a fallback settlement as empty');
  assert.ok(perSettlement.every((r) => Number.isFinite(r.quota) && Number.isFinite(r.placed)));
});

test('every trade in the table names real Marketplace categories', () => {
  const REAL = new Set(['cosmetic', 'weapons', 'tools', 'health', 'spells', 'mounts']);
  for (const [id, def] of Object.entries(TRADE)) {
    assert.ok(def.categories.length, `${id} sells nothing`);
    for (const c of def.categories) {
      assert.ok(REAL.has(c), `trade "${id}" names category "${c}", which the Marketplace does not have`);
    }
    assert.ok(def.title && def.sign && def.sells && def.gripe, `trade "${id}" is missing its dressing`);
  }
});
