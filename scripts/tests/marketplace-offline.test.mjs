import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import { OFFLINE_BASE_ITEMS, offlineCatalog } from '../../src/systems/MarketplaceOffline.js';
import { WORLD_MARKETS } from '../../src/systems/ItemDefs.js';

/**
 * THE SHOP WORKS WITH THE SERVER DOWN, AND IT QUOTES THE SERVER'S PRICES.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 *  THE DEFECT
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `Marketplace._loadCatalog` had no local fallback. Its catch set
 * `_catalogError` and returned, and `MarketplaceUI._renderBuy` returned on any
 * error - so a 404 from `/api/marketplace/items` drew one neutral line and the
 * vendor sold nothing. Driven cold on a `vite`-only build, which is how this
 * game is developed: `B` at Suri Vane opened the FITTING SHOP and said NOT
 * FOUND, and every credit the campaign pays out - 3,250 from the kill ladder,
 * 5,500 from ore, 2,525 from survey, 1,500 of assay bonuses - had nowhere to
 * go. `ShipMenuLogic` was simultaneously telling the player "upgrade at the
 * Fitting Shop".
 *
 * ═══════════════════════════════════════════════════════════════════════════
 *  WHAT THIS FILE IS ACTUALLY FOR
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Not "does the fallback exist" - that is one line. The fallback is a COPY of
 * `BASE_ITEMS` in `site/lib/marketplaceCatalog.ts`, and two descriptions of
 * one catalogue drifting apart is this project's most-repeated failure. So the
 * test PARSES THE TYPESCRIPT and compares the two, field by field.
 *
 * A price edited on the server and not in the bundle is a red test here. A row
 * added to the server and not bundled is a red test here. The comparison is
 * against the file the seeder actually reads, not against a fixture.
 *
 * MUTATION RECORD is in the block above the last case.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '../..');
const TS = path.join(ROOT, 'site/lib/marketplaceCatalog.ts');

/* ================================================================== */
/* Read the server's own table                                         */
/* ================================================================== */

/**
 * Every hand-authored `BASE_ITEMS` row out of the TypeScript.
 *
 * The two spread arrays at the end of that literal - `...MOUNT_SKIN_ROWS` and
 * `...MOUNT_UPGRADE_ROWS` - are GENERATED from three tables and are not parsed
 * or bundled; see the header of `MarketplaceOffline.js` for why copying a
 * product is worse than not having it offline.
 */
function serverRows() {
  const src = readFileSync(TS, 'utf8');
  const start = src.indexOf('export const BASE_ITEMS');
  assert.ok(start > 0, 'BASE_ITEMS has been renamed or moved out of marketplaceCatalog.ts');
  const end = src.indexOf('] as const;\n\nexport function buildMarketplaceSeedItems', start);
  assert.ok(end > start, 'the end of the BASE_ITEMS literal could not be found');
  const body = src.slice(start, end);

  const out = [];
  const re = /source_key: '([^']+)',([\s\S]*?)(?=\n {4}source_key: '|$)/g;
  let m;
  while ((m = re.exec(body))) {
    const [, key, block] = m;
    const one = (p) => {
      const g = new RegExp(p).exec(block);
      return g ? g[1] : null;
    };
    const worlds = one(String.raw`worlds: \[([^\]]*)\]`);
    out.push({
      source_key: key,
      name: one(String.raw`name: '((?:[^'\\]|\\.)*)'`),
      category: one(String.raw`category: '([^']+)'`),
      game_action: one(String.raw`game_action: '([^']+)'`),
      pricing_kind: one(String.raw`pricing_kind: '([^']+)'`),
      cost_buy: Number(one(String.raw`cost_buy: (\d+)`)),
      cost_sell: Number(one(String.raw`cost_sell: (\d+)`)),
      sort_order: Number(one(String.raw`sort_order: (\d+)`)),
      quantity: one(String.raw`quantity: (null|\d+)`),
      worlds: worlds === null ? null : worlds.split(',').map((w) => w.trim().replace(/'/g, '')),
      // Normalised to a single line so whitespace in either file is not a diff.
      action_config: (one(String.raw`action_config: (\{[\s\S]*?\}),\s*\n`) ?? '')
        .replace(/\s+/g, ' ').trim(),
    });
  }
  return out;
}

/** The same normalisation, applied to a bundled row. */
function configText(cfg) {
  const parts = Object.entries(cfg).map(([k, v]) => `${k}: ${typeof v === 'string' ? `'${v}'` : v}`);
  return `{ ${parts.join(', ')} }`;
}

/* ================================================================== */
/* 1. The bundle is the server's table                                 */
/* ================================================================== */

test('every hand-authored server row is bundled, with the same numbers', () => {
  const server = serverRows();
  assert.ok(server.length >= 40,
    `only ${server.length} rows parsed out of marketplaceCatalog.ts - the parser has ` +
    'lost its grip on the file, which would make every comparison below vacuous');

  const bundled = new Map(OFFLINE_BASE_ITEMS.map((r) => [r.source_key, r]));
  assert.equal(bundled.size, OFFLINE_BASE_ITEMS.length, 'a source_key is bundled twice');

  const missing = server.filter((r) => !bundled.has(r.source_key)).map((r) => r.source_key);
  assert.deepEqual(missing, [],
    `the server stocks rows the offline shop has never heard of: ${missing.join(', ')}. ` +
    'A player on a build with the API down cannot buy these at all.');

  const extra = OFFLINE_BASE_ITEMS.filter((r) => !server.some((s) => s.source_key === r.source_key));
  assert.deepEqual(extra.map((r) => r.source_key), [],
    'the offline shop stocks rows the server does not - those are items nobody can ' +
    'buy once the API is up, which is the same defect facing the other way');

  for (const s of server) {
    const b = bundled.get(s.source_key);
    const at = `row "${s.source_key}"`;
    assert.equal(b.name, s.name, `${at}: name`);
    assert.equal(b.category, s.category, `${at}: category`);
    assert.equal(b.game_action, s.game_action, `${at}: game_action`);
    assert.equal(b.pricing_kind, s.pricing_kind, `${at}: pricing_kind`);
    assert.equal(b.cost_buy, s.cost_buy,
      `${at}: the offline shop charges ${b.cost_buy} and the server charges ${s.cost_buy}`);
    assert.equal(b.cost_sell, s.cost_sell, `${at}: cost_sell`);
    assert.equal(b.sort_order, s.sort_order, `${at}: sort_order`);
    assert.deepEqual(b.worlds, s.worlds, `${at}: world allowlist`);
    assert.equal(configText(b.action_config), s.action_config,
      `${at}: action_config - this is the field the grant is read out of, so a ` +
      'mismatch is a purchase that takes credits and hands over nothing');
  }
});

/* ================================================================== */
/* 2. The yard has a shop, and it is the yard's shop                   */
/* ================================================================== */

test('the Fitting Shop stocks the five yard rows and prices them for the yard', () => {
  const dock = offlineCatalog('dock');
  assert.ok(dock.length > 0, 'the yard has no offline stock at all');

  /* The five rows `BASE_ITEMS` restricts to `worlds: ['dock']` (plus the chart,
   * which the citadel shares). Named, because these are the rows the whole
   * ship-fitting economy is made of - `space-objectives` pays three of them out
   * as ladder prizes and `ShipMenuLogic` sends the player here for them. */
  for (const key of ['pack_laser_cell', 'part_hull_plate', 'part_thruster_coil',
    'pack_nav_chart', 'ore_lodestone']) {
    assert.ok(dock.some((r) => r.source_key === key),
      `the yard's offline shop does not stock ${key}`);
  }

  // And nowhere else does, because that is what the allowlist means.
  const station = offlineCatalog('station');
  for (const key of ['pack_laser_cell', 'part_hull_plate', 'part_thruster_coil', 'ore_lodestone']) {
    assert.ok(!station.some((r) => r.source_key === key),
      `${key} is stocked on the station, which is not a shipyard`);
  }

  /* Prices come off `WORLD_MARKETS`, which the TypeScript requires to match
   * `WORLD_PRICE_MULTIPLIERS` exactly. Re-derived here rather than asserted as
   * a literal - a hard-coded 135 would go stale the day the yard's ammo rate
   * moves and would then be pinning the wrong number. */
  const mkt = WORLD_MARKETS.dock;
  const cells = dock.find((r) => r.source_key === 'pack_laser_cell');
  const base = OFFLINE_BASE_ITEMS.find((r) => r.source_key === 'pack_laser_cell');
  assert.equal(cells.cost_buy, Math.max(1, Math.round(base.cost_buy * mkt.buy.ammo)),
    'the laser rack is not priced at the yard rate');
  assert.notEqual(mkt.buy.ammo, 1,
    'the yard ammo multiplier is 1, so the case above cannot tell regional pricing ' +
    'from no pricing - pick a world whose rate is not 1');

  // The id is the seeder's id, so an offline purchase and an online one agree.
  assert.equal(cells.id, 'pack_laser_cell:dock');
  assert.equal(cells.offline, true);
});

/* ================================================================== */
/* 3. It degrades where it should, and no further                      */
/* ================================================================== */

/**
 * MUTATION RECORD for this file: 10 of 10 red.
 *
 * Seven assertion reversals, plus three edits to the thing under test, each
 * re-run against the case it should redden:
 *   1. `cost_buy: 160` -> `165` on `pack_laser_cell` in MarketplaceOffline.js
 *      (a price drifting off the server)              -> case 1 red
 *   2. `worlds: ['dock']` -> `null` on `part_hull_plate`
 *      (an allowlist drifting)                        -> case 1 red
 *   3. `action_config` dropped from every built row
 *      (a shop that takes credits and grants nothing) -> case 3 red
 */
test('a world with no market table gets no offline shop, and every row is complete', () => {
  assert.deepEqual(offlineCatalog('maze'), [],
    'the maze has no market table and `WorldRules` turns merchants off there - an ' +
    'offline shop appearing in it is stock in a world that has no vendors');
  assert.deepEqual(offlineCatalog(null), []);
  assert.deepEqual(offlineCatalog('nowhere'), []);

  /* Every field the buy path touches, on every row of every world that has a
   * shop. `Marketplace.buy` looks a row up by `id`, `preview` reads
   * `cost_buy`/`quantity`, `_purchaseGrant` reads `source_key` and
   * `action_config`, and the UI reads `name`/`category`. A row missing any of
   * them is a row that takes credits and does nothing. */
  let checked = 0;
  for (const world of Object.keys(WORLD_MARKETS)) {
    for (const row of offlineCatalog(world)) {
      const at = `${world}/${row.source_key}`;
      assert.equal(typeof row.id, 'string', `${at}: id`);
      assert.ok(row.id.endsWith(`:${world}`), `${at}: id is not keyed to its world`);
      assert.ok(row.name && typeof row.name === 'string', `${at}: name`);
      assert.ok(row.category && typeof row.category === 'string', `${at}: category`);
      assert.ok(Number.isFinite(row.cost_buy) && row.cost_buy >= 1, `${at}: cost_buy`);
      assert.ok(Number.isFinite(row.cost_sell) && row.cost_sell >= 1, `${at}: cost_sell`);
      assert.ok(row.action_config && typeof row.action_config === 'object', `${at}: action_config`);
      checked++;
    }
  }
  assert.ok(checked >= 150,
    `only ${checked} offline rows across ${Object.keys(WORLD_MARKETS).length} worlds - ` +
    'the loop is not reaching the catalogue');
});
