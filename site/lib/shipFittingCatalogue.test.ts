import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { BASE_ITEMS, MARKETPLACE_ACTIONS, buildMarketplaceSeedItems } from './marketplaceCatalog';
// The GAME's own shelf, imported directly. Not a fixture, not a transcription:
// the array `Marketplace._loadCatalog` falls back to when the API is down.
import { OFFLINE_UPGRADE_ROWS, offlineCatalog } from '../../src/systems/MarketplaceOffline.js';

/**
 * TWO SHELVES, ONE CATALOGUE: THE SHIP FITTINGS AND THE WEAPON TIERS.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 *  THE DEFECT
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `src/systems/MarketplaceOffline.js` generated forty-eight rows — thirty-six
 * ship fittings (three hulls x four stats x three tiers, because
 * `ShipRegistry._powers` is keyed by HULL and a tier bought for a Kestrel is
 * not on the Dray) and twelve weapon tiers — and `Marketplace._loadCatalog`
 * reads that bundle ONLY when `/api/marketplace/items` FAILS.
 *
 * So every one of the forty-eight was on the shelf in a `vite`-only build, and
 * absent from the live site, which is the normal case. `site/lib/
 * marketplaceCatalog.ts` — the catalogue the seeder actually writes to the
 * database — had no such row. A player on the real site could open Esc →
 * Customise ship, see all twelve fittings for their hull with prices beside
 * them (that panel reads `ShipRegistry` and needs no catalogue), walk to the
 * Fitting Shop, and find nothing to buy.
 *
 * Built, visible and unreachable. `MarketplaceOffline.js` wrote the gap down
 * as an honest limitation rather than leaving it to be found — "Closing that
 * gap is forty-eight rows in `site/lib/marketplaceCatalog.ts`, generated the
 * same way from the same numbers" — and this file is the gate on that closure.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 *  WHY A COMPARISON AND NOT A LIST OF EXPECTED ROWS
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * The defect class here is not "the rows are wrong". It is DRIFT: two
 * descriptions of one catalogue, edited apart, quoting different prices at two
 * counters for the same fitting. A fixture of forty-eight expected rows would
 * be a THIRD description and would rot the same way — this repository has paid
 * for that shape more than once, and `marketplace-offline.test.mjs` is the
 * standing answer to it for the hand-authored rows.
 *
 * So nothing below is pinned to a number this file invented. Every assertion
 * compares the live catalogue against the game's own bundle, in both
 * directions, and the two are generated from tables in two languages that
 * cannot import each other. The only literals here are the eight base prices
 * and the tier ladder, which are asserted BECAUSE they are the thing a tuning
 * pass would silently change on one side.
 */

const here = dirname(fileURLToPath(import.meta.url));

/** The shape a bundled row has. The JS module carries no types of its own. */
type OfflineRow = {
  source_key: string;
  name: string;
  description: string;
  category: string;
  game_action: string;
  action_config: Record<string, unknown>;
  quantity: number | null;
  cost_buy: number;
  cost_sell: number;
  pricing_kind: string;
  sort_order: number;
  worlds: readonly string[] | null;
};

const offline = OFFLINE_UPGRADE_ROWS as unknown as readonly OfflineRow[];

/** The live rows this work added, picked out by the id scheme they share. */
const live = BASE_ITEMS.filter((r) => /^(ship|weapon)_/.test(r.source_key));

const shipRows = live.filter((r) => r.action_config.effect === 'grant_ship_power');
const weaponRows = live.filter((r) => r.action_config.effect === 'grant_weapon_power');

/** `worlds` is `['dock']` on a ship row and ABSENT on a weapon one; `null` in the bundle. */
const worldsOf = (r: { worlds?: readonly string[] }) => (r.worlds ? [...r.worlds] : null);

/* ---------------------------------------------------------------------- */
/* 1. The two shelves stock the same rows                                  */
/* ---------------------------------------------------------------------- */

describe('the live catalogue and the game bundle stock one catalogue', () => {
  it('holds the forty-eight rows the two tills sell, and the Bastion sells nothing', () => {
    /* Not a magic number: three hulls with a four-stat ladder over three tiers,
     * and four weapons over three. The Bastion is a hulk — `SHIP_STATS.bastion`
     * is an empty array and `sellsPower` refuses every stat on it — so it must
     * generate nothing, and that is asserted as an ABSENCE of ids rather than
     * as a count, because a count would also pass if the Bastion's twelve rows
     * appeared and three of somebody else's vanished. */
    expect(shipRows.length).toBe(36);
    expect(weaponRows.length).toBe(12);
    expect(live.filter((r) => r.source_key.startsWith('ship_bastion_'))).toEqual([]);
    expect(offline.filter((r) => r.source_key.startsWith('ship_bastion_'))).toEqual([]);
  });

  it('names the same rows in both directions — neither shelf has one the other lacks', () => {
    const liveKeys = live.map((r) => r.source_key).sort();
    const bundleKeys = offline.map((r) => r.source_key).sort();
    /* Both directions, because the two failures are different and both are
     * live. A row here and not in the bundle cannot be bought on a build with
     * the API down; a row in the bundle and not here cannot be bought once the
     * API comes back, which is the same defect facing the other way and is the
     * one this work exists to fix. */
    expect(liveKeys).toEqual(bundleKeys);
  });

  it('agrees field for field: names, descriptions, prices, effects, worlds and order', () => {
    const bundled = new Map(offline.map((r) => [r.source_key, r]));
    for (const r of live) {
      const b = bundled.get(r.source_key);
      expect(b, `${r.source_key} is in no bundled row`).toBeTruthy();
      expect({
        name: r.name,
        description: r.description,
        category: r.category,
        game_action: r.game_action,
        action_config: r.action_config,
        quantity: r.quantity,
        cost_buy: r.cost_buy,
        cost_sell: r.cost_sell,
        pricing_kind: r.pricing_kind,
        sort_order: r.sort_order,
        worlds: worldsOf(r),
      }, r.source_key).toEqual({
        name: b!.name,
        description: b!.description,
        category: b!.category,
        game_action: b!.game_action,
        action_config: b!.action_config,
        quantity: b!.quantity,
        cost_buy: b!.cost_buy,
        cost_sell: b!.cost_sell,
        pricing_kind: b!.pricing_kind,
        sort_order: b!.sort_order,
        worlds: b!.worlds ? [...b!.worlds] : null,
      });
    }
  });

  it('quotes ONE price at the yard counter, whether the API answered or not', () => {
    /* The comparison above is between two tables. This one is between the two
     * SHELVES a player actually sees: the seeder's output for `dock` and the
     * offline builder's, both of which apply their own world multipliers to
     * their own copy of the row. The ladders price `fixed`, so both multipliers
     * are 1 — and that is exactly the kind of "obviously equal" step that stops
     * being equal the day somebody reclassifies a fitting as a consumable.
     *
     * The id is compared too, and it is not decoration: `Marketplace.buy()`
     * looks a row up by `id`, and `source_key:<world>` is what both sides
     * build, so an offline purchase and an online one name the same row. That
     * matters the moment the API comes back mid-session. */
    const seeded = new Map(
      buildMarketplaceSeedItems()
        .filter((s) => s.world_name === 'dock')
        .map((s) => [s.source_key, s])
    );
    const shelf = offlineCatalog('dock') as Array<{ id: string; cost_buy: number; cost_sell: number; name: string }>;
    const ours = shelf.filter((s) => /^(ship|weapon)_/.test(s.id));
    expect(ours.length).toBe(48);
    for (const row of ours) {
      const s = seeded.get(row.id);
      expect(s, `${row.id} is not seeded into the yard at all`).toBeTruthy();
      expect([s!.name, s!.cost_buy, s!.cost_sell], row.id).toEqual([row.name, row.cost_buy, row.cost_sell]);
    }
  });
});

/* ---------------------------------------------------------------------- */
/* 2. The rows are well formed for the seeder, the till and the reader     */
/* ---------------------------------------------------------------------- */

describe('the rows the seeder writes', () => {
  it('every game_action resolves in MARKETPLACE_ACTIONS', () => {
    /* `normalizeAction` in marketplaceDb.ts THROWS on an id it does not know
     * and `parseMarketplaceRows` drops the row — so an id registered on the row
     * and not in the action list is a fitting that vanishes from the listing
     * with one console line. `catalogueIntegrity.test.ts` drives every entry in
     * that list through the owner-authoring path, so these forty-eight are also
     * proven writable, not merely present. */
    const ids = new Set<string>(MARKETPLACE_ACTIONS.map((a) => a.id));
    for (const r of live) expect(ids.has(r.game_action), r.source_key).toBe(true);
  });

  it('the id scheme is the one the game grants against', () => {
    for (const r of shipRows) {
      const { ship, power, tier } = r.action_config as { ship: string; power: string; tier: number };
      expect(r.source_key).toBe(`ship_${ship}_${power}_${tier}`);
      expect(r.game_action).toBe(r.source_key);
      expect(r.category).toBe('ships');
    }
    for (const r of weaponRows) {
      const { weapon, tier } = r.action_config as { weapon: string; tier: number };
      expect(r.source_key).toBe(`weapon_${weapon}_damage_${tier}`);
      expect(r.game_action).toBe(r.source_key);
      expect(r.category).toBe('weapons');
    }
  });

  it('a fitting is stocked only where a counter carries it; a weapon tier everywhere', () => {
    /* A ship fitting is fitted to a hull in a yard and `ships` is carried by
     * exactly one counter in the Nexus, so a row seeded anywhere else is an
     * entry no vendor in that world can show. A weapon tier is carried on the
     * player, so it needs no allowlist at all — the same reason an ammunition
     * pack has none. */
    for (const r of shipRows) expect(worldsOf(r), r.source_key).toEqual(['dock']);
    for (const r of weaponRows) expect(r.worlds, r.source_key).toBeUndefined();
  });

  it('none of them can be bought and sold back for a profit', () => {
    for (const r of live) {
      expect(r.cost_buy, `${r.source_key}: buy ${r.cost_buy} <= sell ${r.cost_sell}`).toBeGreaterThan(r.cost_sell);
      expect(r.cost_sell).toBe(Math.round(r.cost_buy * 0.4));
    }
  });

  it('every rung costs more than the one below it', () => {
    /* A ladder whose third rung is not dearer than its second is a ladder where
     * the cheapest thing on it is the best, and `grantPower` keeps
     * `max(owned, tier)` — so selling III first makes I and II permanently
     * unbuyable, which is the worse half of the same failure. */
    const ladders = new Map<string, number[]>();
    for (const r of live) {
      const key = r.source_key.replace(/_[123]$/, '');
      ladders.set(key, [...(ladders.get(key) ?? []), r.cost_buy]);
    }
    expect(ladders.size).toBe(16);
    for (const [key, prices] of ladders) {
      expect(prices.length, key).toBe(3);
      expect(prices[1], key).toBeGreaterThan(prices[0]);
      expect(prices[2], key).toBeGreaterThan(prices[1]);
    }
  });
});

/* ---------------------------------------------------------------------- */
/* 3. The prices are the game's, and the ladder is the server's            */
/* ---------------------------------------------------------------------- */

describe('the price table', () => {
  /* The eight tier-I bases, spelled out. This is the ONE place this file pins
   * a literal, and it is deliberate: everything above compares two generated
   * tables against each other, and two tables edited together in one careless
   * pass would agree with each other while quoting a number nobody chose. The
   * bases are published with their reasoning in `ShipStats.js` and
   * `WeaponStats.js`; changing one is a decision, and a decision should cost a
   * red test. */
  const BASES: Record<string, number> = {
    ship_kestrel_power: 420, ship_kestrel_shield: 380, ship_kestrel_fire: 520, ship_kestrel_hold: 460,
    ship_dray_power: 420, ship_dray_shield: 380, ship_dray_fire: 520, ship_dray_hold: 460,
    ship_pike_power: 420, ship_pike_shield: 380, ship_pike_fire: 520, ship_pike_hold: 460,
    weapon_machinegun_damage: 240, weapon_bow_damage: 260,
    weapon_fireball_damage: 300, weapon_sword_damage: 340,
  };

  /** `TIER_MUL` in this file, `SHIP_TIER_MUL` in the game, `WEAPON_TIER_MUL` beside it. */
  const TIER_MUL = [1, 2, 3.15];

  it('is base x the tier ladder, on every one of the forty-eight rows', () => {
    for (const r of live) {
      const tier = Number(r.source_key.slice(-1));
      const base = BASES[r.source_key.replace(/_[123]$/, '')];
      expect(base, `${r.source_key} names no base price`).toBeTruthy();
      expect(r.cost_buy, r.source_key).toBe(Math.round(base * TIER_MUL[tier - 1]));
    }
  });

  it('climbs at 3.15 on the top rung and not 3 — the mount ladder is the same', () => {
    /* A third tier that cost exactly three firsts would make the ladder linear
     * and the last rung the cheapest thing on it per point of effect. The mount
     * rows in this file already climb at 3.15; a hull that climbed differently
     * would be a difference no player could ever discover. */
    const kestrelFire = [1, 2, 3].map(
      (t) => live.find((r) => r.source_key === `ship_kestrel_fire_${t}`)!.cost_buy
    );
    expect(kestrelFire).toEqual([520, 1040, 1638]);
    const mount = [1, 2, 3].map(
      (t) => BASE_ITEMS.find((r) => r.source_key === `mount_dragon_fire_${t}`)!.cost_buy
    );
    expect(mount.map((c) => c / mount[0])).toEqual(kestrelFire.map((c) => c / kestrelFire[0]));
  });
});

/* ---------------------------------------------------------------------- */
/* 4. The rows stay GENERATED                                              */
/* ---------------------------------------------------------------------- */

describe('the shape of the addition, not only its content', () => {
  it('writes no literal rows, because a scrape in the game suite depends on it', () => {
    /* `scripts/tests/marketplace-offline.test.mjs` reads `BASE_ITEMS` for
     * `source_key: '...'` LITERALS and demands a bundled twin for each, in both
     * directions. The mount wall is invisible to it because a product of three
     * tables carries no such literal, and these must stay invisible for the
     * same reason: spelled out long-hand, all forty-eight would need a
     * hand-copied twin in `OFFLINE_BASE_ITEMS` to keep that gate green — which
     * is the copy-of-a-product both files argue against.
     *
     * So this asserts the property that scrape relies on, rather than trusting
     * it to survive the next person who finds a generated array hard to read. */
    const src = readFileSync(join(here, 'marketplaceCatalog.ts'), 'utf8').split('\r\n').join('\n');
    const start = src.indexOf('export const BASE_ITEMS');
    const end = src.indexOf('] as const;\n\nexport function buildMarketplaceSeedItems', start);
    expect(start, 'BASE_ITEMS has moved — the game-side scrape reads these same two anchors').toBeGreaterThan(0);
    expect(end).toBeGreaterThan(start);
    const body = src.slice(start, end);
    const literals = body.match(/source_key: '(?:ship|weapon)_[^']*'/g) ?? [];
    expect(literals).toEqual([]);
    // ..and the spreads that carry them are inside that literal, or the rows
    // exist and nothing seeds them.
    expect(body).toContain('...SHIP_UPGRADE_ROWS,');
    expect(body).toContain('...WEAPON_UPGRADE_ROWS,');
  });
});
