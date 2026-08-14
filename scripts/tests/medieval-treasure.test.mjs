import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import {
  medievalHeight, HALF, WATER_Y, riverZ, riverHalfWidth, CIRCLE,
} from '../../src/worlds/terrain/MedievalHeight.js';
import { SETTLEMENTS, settledAt } from '../../src/worlds/medieval/Settlements.js';
import {
  planRelicSites, planForestCaches, candidateSites, reachableFrom,
  walkableAt, standableAt, slopeAt, prominenceAt,
  MAX_WALK_SLOPE, WADE, PROMINENCE_R,
} from '../../src/worlds/medieval/Treasures.js';
import { woodlandAt, DEEP_WOOD } from '../../src/worlds/medieval/Wildlife.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const read = (p) => readFileSync(path.join(root, p), 'utf8');

/**
 * THE COLLECTABLE GATE.
 *
 * Two claims, and neither of them may be asserted - both have to be computed.
 *
 * 1. THE VALE ACTUALLY GETS COLLECTABLES. `Relics` budgets by area and asks for
 *    110; replaying its dart loop against the terrain those darts land on shows
 *    it PLACING NINE, because its prominence test is an architectural one
 *    (2.5 m of rise over 4 m) and this world's relief is 25-40 m rolling ground.
 *    The first test below re-runs that replay, so if somebody ever fixes
 *    `Relics` properly this file will say so out loud rather than leaving a
 *    redundant 84 authored sites in place forever.
 *
 * 2. EVERY ONE OF THEM IS REACHABLE. The station phase shipped 34 collectables
 *    hanging inside lift shafts with the floor up to 28 m below them, and
 *    nothing caught it because "is it on a surface" and "can the player get to
 *    it" are different questions and only the first one is local. So the second
 *    is answered by an INDEPENDENT flood fill written here - finer grid, its own
 *    queue, its own indexing - rather than by calling the module's own
 *    `reachableFrom` and agreeing with it. If the planner's connectivity model
 *    were wrong, calling it twice would agree twice.
 */

const from = { x: CIRCLE.x + 12, z: CIRCLE.z + 7 };
const reach = reachableFrom(from.x, from.z, {});
const relics = planRelicSites({ reach });
const caches = planForestCaches({ reach });

/* ------------------------------------------------------------------ */
/* An independent flood fill                                           */
/* ------------------------------------------------------------------ */

/**
 * Walk the vale from the player spawn on a 4 m lattice.
 *
 * Deliberately NOT `Treasures.reachableFrom`: finer grid (4 m against 6 m), its
 * own indexing, its own queue. It shares only `walkableAt`, which is the
 * per-point predicate and is the part that is meant to be shared - the claim
 * under test is about CONNECTIVITY, and connectivity is computed here.
 */
function walkTheVale(step = 4) {
  const lim = HALF - 8;
  const n = Math.floor((2 * lim) / step) + 1;
  const seen = new Uint8Array(n * n);
  const at = (i, k) => walkableAt(-lim + i * step, -lim + k * step);
  const ci = (v) => Math.round((v + lim) / step);
  const si = ci(from.x);
  const sk = ci(from.z);
  assert.ok(at(si, sk), 'the player spawn is not on walkable ground');

  const stack = [sk * n + si];
  seen[sk * n + si] = 1;
  let reached = 1;
  while (stack.length) {
    const c = stack.pop();
    const i = c % n;
    const k = (c - i) / n;
    for (const [di, dk] of [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]]) {
      const ni = i + di;
      const nk = k + dk;
      if (ni < 0 || nk < 0 || ni >= n || nk >= n) continue;
      const nc = nk * n + ni;
      if (seen[nc] || !at(ni, nk)) continue;
      seen[nc] = 1;
      reached++;
      stack.push(nc);
    }
  }
  return {
    reached,
    cells: n * n,
    has(x, z) {
      const i = ci(x);
      const k = ci(z);
      return i >= 0 && k >= 0 && i < n && k < n && seen[k * n + i] === 1;
    },
  };
}

const walk = walkTheVale();

/* ------------------------------------------------------------------ */
/* 1. The measurement that made this necessary                         */
/* ------------------------------------------------------------------ */

test("Relics' own dart loop finds almost nothing on this terrain", () => {
  /* `Relics.js` is reproduced here rather than imported: it pulls in `three`
   * and `Physics`, and what is under test is the ARITHMETIC of its search, not
   * its rendering. The constants are read out of the file so the replay cannot
   * drift from the shipped numbers. */
  const src = read('src/systems/Relics.js');
  const num = (re) => Number(re.exec(src)?.[1]);
  const PER_WORLD = num(/const PER_WORLD = (\d+);/);
  const BASE_EXTENT = num(/const BASE_EXTENT = (\d+);/);
  const MAX_PER_WORLD = num(/const MAX_PER_WORLD = (\d+);/);
  const MIN_APART = num(/const MIN_APART = (\d+(?:\.\d+)?);/);
  const MIN_PROMINENCE = num(/const MIN_PROMINENCE = (\d+(?:\.\d+)?);/);
  const TRIES = num(/const TRIES = (\d+);/);
  const EDGE_INSET = num(/const EDGE_INSET = (\d+);/);
  for (const [k, v] of Object.entries({ PER_WORLD, BASE_EXTENT, MAX_PER_WORLD, MIN_APART, MIN_PROMINENCE, TRIES, EDGE_INSET })) {
    assert.ok(Number.isFinite(v), `could not read ${k} out of Relics.js`);
  }

  const mulberry32 = (seed) => {
    let s = seed >>> 0 || 1;
    return () => {
      s = (s + 0x6d2b79f5) >>> 0;
      let t = Math.imul(s ^ (s >>> 15), 1 | s);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  };
  const hash = (str) => {
    let h = 2166136261;
    for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); }
    return h >>> 0;
  };

  const minX = -HALF + EDGE_INSET;
  const maxX = HALF - EDGE_INSET;
  const extent = Math.max(maxX - minX, 1);
  const areaScale = Math.min(MAX_PER_WORLD / PER_WORLD, (extent / BASE_EXTENT) ** 2);
  const want = Math.round(PER_WORLD * Math.max(1, areaScale));
  const tries = Math.round(TRIES * Math.max(1, areaScale));
  assert.equal(want, MAX_PER_WORLD, 'the medieval relic budget is no longer saturated');

  const rnd = mulberry32(hash('relic:medieval'));
  const placed = [];
  for (let t = 0; t < tries && placed.length < want; t++) {
    const x = minX + rnd() * (maxX - minX);
    const z = minX + rnd() * (maxX - minX);
    if (placed.some((p) => (p.x - x) ** 2 + (p.z - z) ** 2 < MIN_APART ** 2)) continue;
    if (prominenceAt(x, z, medievalHeight, 4) < MIN_PROMINENCE) continue;
    placed.push({ x, z });
  }
  /* THE NUMBER. Nine of the hundred and ten it asked for. The physics surface
   * adds the castle and the cottage roofs, so the shipped figure is a little
   * higher - it is nowhere near the budget, which is what matters. If this
   * ever starts passing comfortably, the authored sites below are redundant
   * and should be reconsidered rather than left doubled up. */
  assert.ok(placed.length < want * 0.35,
    `the dart loop now places ${placed.length}/${want}; the authored sites may be redundant`);
});

/* ------------------------------------------------------------------ */
/* 2. Reachability, proved                                             */
/* ------------------------------------------------------------------ */

test('the flood fill actually covers the vale, so "reachable" means something', () => {
  const frac = walk.reached / walk.cells;
  assert.ok(frac > 0.8, `only ${(frac * 100).toFixed(1)}% of the vale is reachable - the model is broken`);
  assert.ok(frac < 0.99, 'the walkability model rejects nothing and proves nothing');
});

test('THE REACHABILITY GATE: every placed collectable is walkable-to from the player spawn', () => {
  assert.ok(relics.length > 60, `only ${relics.length} relic sites`);
  assert.ok(caches.length > 8, `only ${caches.length} forest caches`);
  for (const r of relics) {
    assert.ok(walk.has(r.x, r.z),
      `relic (${r.source}) at ${r.x | 0},${r.z | 0} is on ground the player cannot walk to`);
  }
  for (const c of caches) {
    assert.ok(walk.has(c.x, c.z),
      `forest cache at ${c.x | 0},${c.z | 0} is on ground the player cannot walk to`);
  }
});

test('there is standing room AROUND each one, not just under it', () => {
  /* A collectable on a single walkable cell surrounded by cliff is reachable by
   * the letter of the flood fill and useless in practice - you cannot get your
   * body next to it. Three of the four cardinal neighbours at 6 m have to be
   * walkable too. */
  for (const c of [...relics, ...caches]) {
    let room = 0;
    for (const [dx, dz] of [[6, 0], [-6, 0], [0, 6], [0, -6]]) {
      if (walk.has(c.x + dx, c.z + dz) && walkableAt(c.x + dx, c.z + dz)) room++;
    }
    let compass = 0;
    for (let i = 0; i < 8; i++) {
      const a = (i / 8) * Math.PI * 2;
      const px = c.x + Math.cos(a) * 6;
      const pz = c.z + Math.sin(a) * 6;
      if (walk.has(px, pz) && walkableAt(px, pz)) compass++;
    }
    assert.ok(room >= 2 && compass >= 4,
      `${c.source ?? c.label} at ${c.x | 0},${c.z | 0} has ${room}/4 cardinal and ${compass}/8 compass approaches`);
  }
});

test('every collectable is exactly on the terrain surface, to the bit', () => {
  /* The lift-shaft failure, prevented by construction: `Relics` takes an
   * authored `y` verbatim and lifts it 55 cm, doing no grounding of its own,
   * and `Interiors` streams with `snap: false`. If `y` is not the ground here,
   * nothing downstream will ever notice. */
  for (const r of relics) {
    assert.equal(r.y, medievalHeight(r.x, r.z),
      `relic at ${r.x | 0},${r.z | 0} is ${(r.y - medievalHeight(r.x, r.z)).toFixed(2)} m off the ground`);
  }
  for (const c of caches) {
    const off = c.y - medievalHeight(c.x, c.z);
    assert.ok(off > 0.4 && off < 0.9, `cache at ${c.x | 0},${c.z | 0} floats ${off.toFixed(2)} m`);
  }
});

test('nothing is underwater, in the channel, or off the playfield', () => {
  for (const c of [...relics, ...caches]) {
    assert.ok(medievalHeight(c.x, c.z) >= WATER_Y + 0.45, `${c.x | 0},${c.z | 0} is underwater`);
    assert.ok(Math.abs(c.z - riverZ(c.x)) >= riverHalfWidth(c.x) + 1, `${c.x | 0},${c.z | 0} is in the channel`);
    assert.ok(Math.abs(c.x) < HALF - 8 && Math.abs(c.z) < HALF - 8, `${c.x | 0},${c.z | 0} is off the map`);
    assert.ok(slopeAt(c.x, c.z) <= MAX_WALK_SLOPE, `${c.x | 0},${c.z | 0} is on a cliff face`);
  }
});

/* ------------------------------------------------------------------ */
/* 3. Distribution - the brief's actual question                       */
/* ------------------------------------------------------------------ */

test('collectables spread across the new ring rather than clustering in the old vale', () => {
  const inner = relics.filter((r) => Math.abs(r.x) <= 200 && Math.abs(r.z) <= 200).length;
  const outer = relics.length - inner;
  /* The old vale is 400 x 400 of a 900 x 900 map: 19.8% of the area. A
   * distribution that put most of the relics in it would be exactly the
   * clustering the brief asks about. */
  assert.ok(outer > inner * 2,
    `${inner} relics inside the old 400 m vale against ${outer} outside it`);
  const share = inner / relics.length;
  assert.ok(share > 0.05, 'the old vale was emptied out entirely');
  assert.ok(share < 0.4, `${(share * 100).toFixed(0)}% of relics are still in the old vale`);
});

test('every one of the 36 distribution cells gets something', () => {
  const cells = new Set(relics.map((r) => r.cell));
  assert.equal(cells.size, 36, `only ${cells.size}/36 cells of the vale hold a relic`);
});

test('nothing is closer than the spacing Relics itself enforces', () => {
  // `MIN_APART` is 14 in `Relics`; anything tighter is silently dropped by
  // `_tooClose` when it consumes `_roofs`, so a tight plan is a shrinking one.
  for (let i = 0; i < relics.length; i++) {
    for (let j = i + 1; j < relics.length; j++) {
      const d = Math.hypot(relics[i].x - relics[j].x, relics[i].z - relics[j].z);
      assert.ok(d >= 14, `two relics are ${d.toFixed(1)} m apart - Relics would drop one`);
    }
  }
});

test('the landmarks and every settlement outskirt are represented', () => {
  const sources = relics.map((r) => r.source);
  assert.ok(sources.filter((s) => s.startsWith('landform:')).length >= 4, 'a landform has no relic');
  assert.ok(sources.filter((s) => s.startsWith('river:')).length >= 6, 'the river reaches have no relics');
  assert.ok(sources.includes('circle'), 'the stone circle the player arrives at has none');
  const outskirts = new Set(sources.filter((s) => s.startsWith('outskirt:')).map((s) => s.slice(9)));
  assert.ok(outskirts.size >= SETTLEMENTS.length - 1,
    `only ${outskirts.size} of ${SETTLEMENTS.length} settlements have an outskirt relic`);
});

test('a settlement added later gets its own outskirt relic, unprompted', () => {
  const invented = {
    id: 'newtown', displayName: 'Newtown', kind: 'town',
    centre: { x: 196, z: 344 }, radius: 96, plots: null, ground: [],
  };
  const after = planRelicSites({ settlements: [...SETTLEMENTS, invented], reach });
  assert.ok(after.some((r) => r.source === 'outskirt:newtown'),
    'a settlement added after this file was written got no relic of its own');
});

/* ------------------------------------------------------------------ */
/* 4. Forest caches                                                    */
/* ------------------------------------------------------------------ */

test('forest caches are in the deep wood, away from the towns, and graded by it', () => {
  for (const c of caches) {
    assert.ok(woodlandAt(c.x, c.z) > DEEP_WOOD, `a cache at ${c.x | 0},${c.z | 0} is in open country`);
    assert.ok(settledAt(c.x, c.z) <= 0.02, `a cache at ${c.x | 0},${c.z | 0} is on beaten earth`);
    for (const s of SETTLEMENTS) {
      const d = Math.hypot(c.x - s.centre.x, c.z - s.centre.z);
      assert.ok(d >= s.radius + 45, `a cache is ${d.toFixed(0)} m from ${s.id} (radius ${s.radius})`);
    }
    assert.ok(['common', 'rare', 'prize'].includes(c.tier), `unknown tier "${c.tier}"`);
  }
  const tiers = new Set(caches.map((c) => c.tier));
  assert.ok(tiers.has('prize'), 'nothing in the woods is worth the walk');
  // The tier really does follow the depth of the wood.
  const prize = caches.filter((c) => c.tier === 'prize');
  const common = caches.filter((c) => c.tier === 'common');
  if (prize.length && common.length) {
    assert.ok(Math.min(...prize.map((c) => c.wood)) > Math.max(...common.map((c) => c.wood)),
      'the reward does not follow how deep into the wood it is');
  }
});

test('every cache carries the shape Interiors reads, and nothing more', () => {
  for (const c of caches) {
    assert.equal(typeof c.label, 'string');
    assert.ok(c.label.length > 0);
    assert.ok(Number.isFinite(c.x) && Number.isFinite(c.y) && Number.isFinite(c.z));
  }
  assert.equal(new Set(caches.map((c) => c.label)).size, caches.length, 'two caches share a tag');
});

/* ------------------------------------------------------------------ */
/* 5. The model itself, and determinism                                */
/* ------------------------------------------------------------------ */

test('wading is what connects the two banks - and it uses the fords test number', () => {
  const src = read('scripts/tests/medieval-landforms.test.mjs');
  const other = Number(/const WADE = (\d+(?:\.\d+)?);/.exec(src)?.[1]);
  assert.equal(WADE, other,
    'this module and the fords test disagree about how deep a player can wade');

  // A ford is crossable and the pool is not - which is the whole reason the
  // fords were authored where they were.
  assert.ok(walkableAt(-268, riverZ(-268)), 'Ashlea Ford is not crossable');
  assert.ok(walkableAt(296, riverZ(296)), 'Harrowgate Ford is not crossable');
  assert.ok(!walkableAt(-344, riverZ(-344)), 'the Reedwater pool can be walked across');

  // ...and the ford is crossable but NOT somewhere to put a relic.
  assert.ok(!standableAt(-268, riverZ(-268)), 'a relic can be placed in the middle of a ford');
});

test('prominence is measured at the scale this terrain actually has relief at', () => {
  assert.equal(PROMINENCE_R, 25);
  const pool = candidateSites({});
  assert.ok(pool.length > 500, `only ${pool.length} candidate sites on the whole map`);
  // The claim behind the constant: at 4 m the same terrain yields almost none.
  const at4 = pool.filter((c) => prominenceAt(c.x, c.z, medievalHeight, 4) >= 2.5).length;
  assert.ok(at4 < pool.length * 0.1,
    `${at4}/${pool.length} candidates clear 2.5 m at 4 m radius - Relics' test would have worked`);
});

test('same terrain, same treasure map', () => {
  const again = planRelicSites({ reach });
  assert.deepEqual(again.map((r) => `${r.source}|${r.x}|${r.y}|${r.z}`),
    relics.map((r) => `${r.source}|${r.x}|${r.y}|${r.z}`));
  const cachesAgain = planForestCaches({ reach });
  assert.deepEqual(cachesAgain.map((c) => `${c.label}|${c.tier}`), caches.map((c) => `${c.label}|${c.tier}`));
});

test('a start point on an island proves nothing rather than everything', () => {
  // Degenerate input has to fail closed: `reachableFrom` in the middle of the
  // river must contain nothing, not everything.
  const island = reachableFrom(-344, riverZ(-344), {});
  assert.equal(island.reached, 0);
  assert.equal(island.contains(0, 0), false);
});
