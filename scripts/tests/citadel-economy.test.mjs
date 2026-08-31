import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import * as THREE from 'three';

import { Loot, DROP_TABLES } from '../../src/systems/Loot.js';
import { ITEMS, WORLD_MARKETS, KIND_ACCENT, itemDef } from '../../src/systems/ItemDefs.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const read = (p) => readFileSync(path.join(root, p), 'utf8');

/**
 * THE CITADEL'S CORPSE ECONOMY.
 *
 * `Loot._dropFor` reads `DROP_TABLES[this._worldId] ?? DROP_TABLES.station`.
 * The citadel had no row, so every guard killed on the mesa dropped 6 mm
 * caseless rifle rounds and ember cores for a gauntlet, in a fortress whose
 * caches pay in crown coins and broadhead arrows and whose market charges
 * 1.55x for ammunition because none is made within a hundred miles.
 *
 * The row this file pins is NOT a set of taste calls. Every quantity in it is
 * derived from something already in the repo, and each derivation is one of the
 * assertions below:
 *
 *   - the ammunition is the ammunition `CACHE_TABLES.citadel` already pays in;
 *   - the currency is the one `WORLD_MARKETS.citadel` discounts (`relic_coin`
 *     at 0.50, the lowest of the five regions, i.e. the mesa is glutted);
 *   - how MUCH ammunition and medicine a body carries falls as the region's
 *     `buy` multiplier for that kind rises, because that multiplier is the
 *     game's own statement of what the place is short of.
 *
 * The last one is a law across all four worlds, not a citadel special case, so
 * it cannot be satisfied by picking a number that merely looks plausible.
 */

/* ---------------------------------------------------------------------- */
/* Helpers                                                                 */
/* ---------------------------------------------------------------------- */

/**
 * `CACHE_TABLES` is module-private to Caches.js. Scraped rather than exported
 * because this file only needs the item ids, and widening another module's API
 * for one assertion is a worse trade than eight lines of regex - the same call
 * `scripts/quest-vocab.mjs readIdTable` already makes.
 */
function cacheTable(world) {
  const src = read('src/systems/Caches.js');
  const at = src.indexOf('const CACHE_TABLES = {');
  assert.ok(at >= 0, 'CACHE_TABLES declaration moved - this scrape is stale');
  const m = new RegExp(`${world}:\\s*\\[([\\s\\S]*?)\\]`).exec(src.slice(at));
  assert.ok(m, `CACHE_TABLES has no ${world} row`);
  return [...m[1].matchAll(/id:\s*'([a-z0-9_]+)'/g)].map((x) => x[1]);
}

const kindOf = (id) => ITEMS[id]?.kind ?? null;

/**
 * Expected units of `kind` in one drop for `world`, ignoring the three-type cap
 * in `_dropFor`. The cap applies identically to every world, so it cancels out
 * of a comparison between worlds and only makes each figure a slight
 * over-estimate of itself.
 *
 * AN ITEM WITH ITS OWN `itemBuy` MULTIPLIER IN THAT WORLD IS NOT COUNTED, and
 * that is the same carve-out the law below already makes for trinkets, applied
 * by rule instead of by hand. `buyMultiplier` returns `itemBuy[id]` when there
 * is one and only falls through to `buy[kind]` when there is not - so for an
 * item the world prices per unit, the kind multiplier is not what the region
 * is saying about it, and counting its drop against that multiplier ranks the
 * world on a number nothing reads.
 *
 * It became load-bearing rather than tidy when `laser_cell` stopped being
 * `ammo`: the yard drops 19.84 cells a body, which as a `consumable` would
 * have swamped a bucket whose other member is a 0.18-medkit chance and made
 * the yard look a hundred times better stocked with medicine than a first-aid
 * post. `WORLD_MARKETS.dock.itemBuy.laser_cell` is what says the yard prices
 * cells as cells, and this is what reads it.
 */
function expectedPerDrop(world, kind) {
  const perItem = WORLD_MARKETS[world]?.itemBuy ?? {};
  let sum = 0;
  for (const e of DROP_TABLES[world]) {
    if (kindOf(e.id) !== kind) continue;
    if (perItem[e.id] !== undefined) continue;
    sum += e.chance * ((e.min + e.max) / 2);
  }
  return sum;
}

/** Deterministic replacement for Math.random, so a chance table is testable. */
function mulberry(seed) {
  let s = seed >>> 0 || 1;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Roll `n` corpse drops for a world through the real `_dropFor`. */
function rollDrops(worldId, n, seed = 1) {
  const out = [];
  const ctx = {
    _world: null,
    _worldId: worldId,
    spawn(_pos, contents) { out.push(contents); },
  };
  const npc = { position: new THREE.Vector3(1, 2, 3) };
  const real = Math.random;
  Math.random = mulberry(seed);
  try {
    for (let i = 0; i < n; i++) Loot.prototype._dropFor.call(ctx, npc);
  } finally {
    Math.random = real;
  }
  return out;
}

/* ---------------------------------------------------------------------- */
/* The row exists at all                                                   */
/* ---------------------------------------------------------------------- */

test('DROP_TABLES has a citadel row, so the citadel stops borrowing the station\'s', () => {
  assert.ok(DROP_TABLES.citadel, 'no DROP_TABLES.citadel - Loot.js:309 falls back to the station table');
  assert.ok(Array.isArray(DROP_TABLES.citadel) && DROP_TABLES.citadel.length > 0,
    'DROP_TABLES.citadel is empty, which pays exactly as well as having no row');
  // The fallback that made this necessary is still the fallback. If someone
  // makes it throw or default differently, the reasoning above needs revisiting.
  assert.match(read('src/systems/Loot.js'), /DROP_TABLES\[this\._worldId\]\s*\?\?\s*DROP_TABLES\.station/,
    'the DROP_TABLES fallback changed shape - re-read this file');
});

test('every citadel drop entry is a real, drawable, sanely-quantified item', () => {
  for (const e of DROP_TABLES.citadel) {
    assert.equal(itemDef(e.id).id, e.id, `${e.id} is not an item in ITEMS`);
    assert.ok(e.chance > 0 && e.chance <= 1, `${e.id} has chance ${e.chance}`);
    assert.ok(Number.isInteger(e.min) && Number.isInteger(e.max), `${e.id} has non-integer quantities`);
    assert.ok(e.min >= 1 && e.min <= e.max, `${e.id} has min ${e.min} max ${e.max}`);
    // `Loot._applyAccent` colours the pickup by item kind. A kind with no
    // accent falls through to a hard-coded cyan, which is the station's colour.
    assert.ok(KIND_ACCENT[kindOf(e.id)], `${e.id} is kind "${kindOf(e.id)}", which has no accent colour`);
  }
});

/* ---------------------------------------------------------------------- */
/* Consistency with the rest of the citadel                                */
/* ---------------------------------------------------------------------- */

test('a citadel body carries the same ammunition its caches pay in, and no other', () => {
  /* This is the whole defect in one line. The station table's `bullet` and
   * `fireball_charge` are the two items that gave it away in play: neither is
   * manufactured anywhere the mesa trades with, and `CACHE_TABLES.citadel`
   * already settled the question by paying in arrows. */
  const dropAmmo = new Set(DROP_TABLES.citadel.filter((e) => kindOf(e.id) === 'ammo').map((e) => e.id));
  const cacheAmmo = new Set(cacheTable('citadel').filter((id) => kindOf(id) === 'ammo'));
  assert.deepEqual([...dropAmmo].sort(), [...cacheAmmo].sort(),
    'the citadel drop table and the citadel cache table disagree about what ammunition exists here');
  assert.equal(dropAmmo.has('bullet'), false, 'rifle rounds in a world with no rifles');
  assert.equal(dropAmmo.has('fireball_charge'), false, 'ember cores in a world with no foundry');
});

test('the citadel is the relic world, and its drop table says so louder than the vale does', () => {
  /* `WORLD_MARKETS` prices a relic coin at 0.50 in the citadel and 0.55 in the
   * vale - the two lowest figures anywhere, and the citadel's is the lower.
   * A vendor paying less for a thing is the game saying the place is full of
   * it, so the citadel must not shed coins more grudgingly than the vale. */
  const chance = (world, id) => DROP_TABLES[world].find((e) => e.id === id)?.chance ?? 0;
  const price = (world, id) => WORLD_MARKETS[world].itemBuy?.[id];
  assert.ok(price('citadel', 'relic_coin') < price('medieval', 'relic_coin'),
    'WORLD_MARKETS no longer makes the citadel the cheapest place to sell a crown coin');
  assert.ok(chance('citadel', 'relic_coin') > chance('medieval', 'relic_coin'),
    `citadel drops relic coins at ${chance('citadel', 'relic_coin')} against the vale's `
    + `${chance('medieval', 'relic_coin')}, while pricing them lower - the economy points both ways at once`);
});

test('what a corpse carries falls as the region\'s price for that kind rises', () => {
  /* `WORLD_MARKETS[w].buy[kind]` is what a vendor PAYS the player, so a high
   * figure means the region is short of that kind. The drop tables were written
   * one world at a time and happen to obey that already for ammunition and
   * medicine; making the citadel row obey it too is what stops "consistent with
   * the regional price table" being a matter of opinion.
   *
   * Deliberately NOT applied to trinkets. `buy.trinket` is overridden per item
   * by `itemBuy` for exactly the three trinkets that drop (`relic_coin`,
   * `alloy_scrap`, `nexus_shard`), so the kind-level multiplier is not the
   * signal there - it is checked against `itemBuy` in the test above instead.
   * `expectedPerDrop` now applies that same carve-out per item rather than per
   * kind; see its note.
   *
   * AND A WORLD THAT DROPS NONE OF A KIND IS NOT ON THE LADDER AT ALL.
   *
   * The law reads "carries LESS as the price RISES", which is a statement
   * about relative abundance between worlds that have some. Zero is not the
   * bottom of that ordering, it is off it: the yard has priced ammunition at
   * 0.9 since it opened - it sells rifle packs to people who carried a rifle
   * through the gateway - while no yard worker has ever dropped a round in
   * their life, and there is nothing inconsistent about either fact. Forcing
   * that row into the ranking made the law demand that every world dearer than
   * 0.9 carry less than nothing, which is not a claim about the economy, it is
   * an artefact of listing a world with no entry in the bucket.
   *
   * The `>= 4` floor below is what stops this becoming a way to make the law
   * pass by emptying tables: drop the kind out of one more world and there are
   * too few rows left to rank and the case fails outright.
   */
  for (const kind of ['ammo', 'consumable']) {
    const rows = Object.keys(DROP_TABLES)
      .filter((w) => WORLD_MARKETS[w]?.buy?.[kind] !== undefined)
      .map((w) => ({ w, price: WORLD_MARKETS[w].buy[kind], qty: expectedPerDrop(w, kind) }))
      .filter((r) => r.qty > 0)
      .sort((a, b) => a.price - b.price);
    assert.ok(rows.length >= 4, `only ${rows.length} worlds price ${kind} - the law has stopped being a law`);
    for (let i = 1; i < rows.length; i++) {
      const lo = rows[i - 1];
      const hi = rows[i];
      assert.ok(hi.qty < lo.qty,
        `${hi.w} pays ${hi.price} for ${kind} (scarcer than ${lo.w} at ${lo.price}) yet a body there carries `
        + `${hi.qty.toFixed(2)} of it against ${lo.w}'s ${lo.qty.toFixed(2)}`);
    }
  }
});

/* ---------------------------------------------------------------------- */
/* Driven through the real roller                                          */
/* ---------------------------------------------------------------------- */

test('a thousand citadel kills yield crown coins and arrows and not one rifle round', () => {
  /* The table read straight is one thing; what `_dropFor` actually puts on the
   * ground is another - it caps at three item types after a guaranteed credits
   * entry, so an entry authored fourth can be squeezed out of most drops. */
  const drops = rollDrops('citadel', 1000, 20250818);
  assert.equal(drops.length, 1000);

  const seen = new Map();
  for (const contents of drops) {
    assert.equal(contents[0].itemId, 'credits', 'credits stopped being the guaranteed first entry');
    for (const c of contents) {
      assert.ok(c.qty > 0, `${c.itemId} dropped with qty ${c.qty}`);
      seen.set(c.itemId, (seen.get(c.itemId) ?? 0) + 1);
    }
  }
  for (const banned of ['bullet', 'fireball_charge']) {
    assert.equal(seen.get(banned) ?? 0, 0,
      `${seen.get(banned)} of 1000 citadel corpses dropped ${banned}`);
  }
  for (const wanted of ['relic_coin', 'arrow']) {
    assert.ok((seen.get(wanted) ?? 0) > 50,
      `only ${seen.get(wanted) ?? 0} of 1000 citadel corpses dropped ${wanted}`);
  }

  // The same roller on the station must be unchanged: this row is an addition,
  // not a re-tune of anybody else's world.
  const station = rollDrops('station', 400, 20250818);
  const stationSeen = new Set(station.flat().map((c) => c.itemId));
  assert.ok(stationSeen.has('bullet'), 'the station stopped dropping rifle rounds');
});
