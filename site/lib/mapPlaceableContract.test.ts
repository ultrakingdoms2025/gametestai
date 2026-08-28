import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CONSUMABLE_SOURCE_KEYS, NEVER_PLACEABLE_ITEM_IDS, placeableReason } from './mapPlaceable';

/**
 * THE PLACEABLE RULE, PINNED ACROSS THE GAME/SITE BOUNDARY.
 *
 * `grantForPlacement` in `src/systems/MapOverlay.js` (the game) decides what a placed item becomes, and
 * `lib/mapPlaceable.ts` (the site) decides what the Place list offers. Nothing imports across that boundary,
 * so nothing but a test can notice when the game maps a new consumable key, drops one, renames the config
 * field it reads, or adds an item id to `NEVER_PLACEABLE` — and each of those is a row the editor then offers
 * that the game refuses, or hides that the game would take. This reads the game files TEXTUALLY, as
 * `mapReasonsContract.test.ts` reads the applier's reasons, and holds the site's tables equal to the game's.
 *
 * Three shapes are read: the keys of the `MARKETPLACE_CONSUMABLE_ITEMS = { key: 'item', … }` literal in
 * `Marketplace.js`; the `NEVER_PLACEABLE = new Set([...])` literal in `MapOverlay.js`; and the two
 * `config.effect === 'x' && typeof config.y === 'string'` guards in `grantForPlacement`. A shape this cannot
 * read is read as NOTHING and fails loud (each set is asserted non-empty), so a rewrite of either table into
 * a form this does not parse is a red test, not a silent drift. An absent game file SKIPS with a message
 * that says so, never passes.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const MARKETPLACE = resolve(HERE, '..', '..', 'src', 'systems', 'Marketplace.js');
const APPLIER = resolve(HERE, '..', '..', 'src', 'systems', 'MapOverlay.js');
const NOT_MERGED = 'game branch not merged here; the pin is inert until both branches are in one tree';

/** The keys of the `MARKETPLACE_CONSUMABLE_ITEMS` object literal: one `key: 'value',` line each. */
function consumableKeys(src: string): string[] {
  const block = /MARKETPLACE_CONSUMABLE_ITEMS = \{([^}]*)\}/.exec(src);
  if (!block) return [];
  return [...block[1].matchAll(/^\s*([A-Za-z0-9_]+):\s*['"]/gm)].map((m) => m[1]).sort();
}

/** The string literals of `NEVER_PLACEABLE = new Set([...])`. */
function neverPlaceable(src: string): string[] {
  const block = /NEVER_PLACEABLE = new Set\(\[([^\]]*)\]\)/.exec(src);
  if (!block) return [];
  return [...block[1].matchAll(/['"]([A-Za-z0-9_]+)['"]/g)].map((m) => m[1]).sort();
}

/** The `effect → field` pairs `grantForPlacement` reads off the config: `config.effect === 'e' && typeof config.f === 'string'`. */
function configRoutes(src: string): Array<[effect: string, field: string]> {
  const fn = /export function grantForPlacement\([\s\S]*?\n\}/.exec(src);
  if (!fn) return [];
  return [...fn[0].matchAll(/config\.effect === ['"]([a-z_]+)['"] && typeof config\.([a-z_]+) === ['"]string['"]/g)].map((m) => [m[1], m[2]]);
}

describe('the placeable contract between the game and mapPlaceable.ts', () => {
  it("the consumable keys the game resolves a placement's source_key through are exactly CONSUMABLE_SOURCE_KEYS", (ctx) => {
    if (!existsSync(MARKETPLACE)) return ctx.skip(NOT_MERGED);
    const game = consumableKeys(readFileSync(MARKETPLACE, 'utf8'));
    expect(game, 'Marketplace.js holds no MARKETPLACE_CONSUMABLE_ITEMS literal to pin').not.toHaveLength(0);
    expect(game).toEqual([...CONSUMABLE_SOURCE_KEYS].sort());
  });

  it('the item ids the applier never places are exactly NEVER_PLACEABLE_ITEM_IDS', (ctx) => {
    if (!existsSync(APPLIER)) return ctx.skip(NOT_MERGED);
    const game = neverPlaceable(readFileSync(APPLIER, 'utf8'));
    expect(game, 'MapOverlay.js holds no NEVER_PLACEABLE literal to pin').not.toHaveLength(0);
    expect(game).toEqual([...NEVER_PLACEABLE_ITEM_IDS].sort());
  });

  it('the config routes grantForPlacement reads are grant_ammo/ammo_item and grant_item/item_id, and the site rule takes each', (ctx) => {
    if (!existsSync(APPLIER)) return ctx.skip(NOT_MERGED);
    const routes = configRoutes(readFileSync(APPLIER, 'utf8'));
    expect(routes, 'MapOverlay.js holds no config route to pin').not.toHaveLength(0);
    expect(routes).toEqual([['grant_ammo', 'ammo_item'], ['grant_item', 'item_id']]);
    for (const [effect, field] of routes) {
      expect(placeableReason({ source_key: 'unmapped', config: { effect, [field]: 'some_item' } }), `${effect}/${field}`).toBeNull();
      expect(placeableReason({ source_key: 'unmapped', config: { effect } }), `${effect} without ${field}`).not.toBeNull();
    }
  });

  it('the mount route: grantForPlacement resolves a mount upgrade through the parser a purchase uses, and that parser reads grant_mount_power', (ctx) => {
    if (!existsSync(APPLIER) || !existsSync(MARKETPLACE)) return ctx.skip(NOT_MERGED);
    const applier = /export function grantForPlacement\([\s\S]*?\n\}/.exec(readFileSync(APPLIER, 'utf8'))?.[0] ?? '';
    expect(applier, 'MapOverlay.js holds no grantForPlacement to read').not.toBe('');
    // ONE parser for a purchase and a placement, so the two cannot disagree about what a row grants.
    expect(applier).toMatch(/mountPowerGrantFor\(/);
    const parser = /export function mountPowerGrantFor\([\s\S]*?\n\}/.exec(readFileSync(MARKETPLACE, 'utf8'))?.[0] ?? '';
    expect(parser, 'Marketplace.js exports no mountPowerGrantFor to read').not.toBe('');
    expect(parser).toMatch(/effect !== ['"]grant_mount_power['"]/);
    expect(placeableReason({ source_key: 'unmapped', config: { effect: 'grant_mount_power', mount: 'bicycle', power: 'power', tier: 3 } })).toBeNull();
  });

  it('reads the three shapes from a fixture, so a game-side rewrite into a shape this cannot read fails loud rather than passing empty', () => {
    const marketplace = [
      'const MARKETPLACE_CONSUMABLE_ITEMS = {',
      "  spell_a: 'item_a',",
      '  shield_b: "item_b",',
      '};',
      "const OTHER = { not_a_key: 'x' };",
    ].join('\n');
    expect(consumableKeys(marketplace)).toEqual(['shield_b', 'spell_a']);
    const applier = [
      "const NEVER_PLACEABLE = new Set(['credits', \"souls\"]);",
      'export function grantForPlacement(item) {',
      "  if (config.effect === 'grant_ammo' && typeof config.ammo_item === 'string') {",
      '  }',
      '  if (config.effect === "grant_item" && typeof config.item_id === "string") {',
      '  }',
      '}',
      "// after the function: config.effect === 'grant_gold' && typeof config.gold === 'string' is not read",
    ].join('\n');
    expect(neverPlaceable(applier)).toEqual(['credits', 'souls']);
    expect(configRoutes(applier)).toEqual([['grant_ammo', 'ammo_item'], ['grant_item', 'item_id']]);
    expect(consumableKeys('nothing here')).toEqual([]);
    expect(neverPlaceable('nothing here')).toEqual([]);
    expect(configRoutes('nothing here')).toEqual([]);
  });
});
