import { describe, expect, it } from 'vitest';
import { BASE_ITEMS, MARKETPLACE_ACTIONS, MARKETPLACE_WORLDS, buildMarketplaceSeedItems } from './marketplaceCatalog';

describe('mount customizer catalog rows', () => {
  it('sells Speed/Acceleration/Armour I-III for the five non-car mounts and Fire I-III for the dragon', () => {
    const rows = BASE_ITEMS.filter((r) => r.action_config.effect === 'grant_mount_power');
    for (const mount of ['dragon', 'eagle', 'horse', 'hoverboard', 'bicycle']) {
      for (const power of ['power', 'strength', 'shield']) {
        for (const tier of [1, 2, 3]) {
          expect(rows.some((r) => r.action_config.mount === mount && r.action_config.power === power && r.action_config.tier === tier), `${mount} ${power} ${tier}`).toBe(true);
        }
      }
    }
    for (const tier of [1, 2, 3]) expect(rows.some((r) => r.action_config.mount === 'dragon' && r.action_config.power === 'fire' && r.action_config.tier === tier)).toBe(true);
    expect(rows.filter((r) => r.action_config.mount !== 'car').length).toBe(48);
  });

  it('every game_action id resolves in MARKETPLACE_ACTIONS (the seed normaliser rejects unknown ids)', () => {
    const ids = new Set<string>(MARKETPLACE_ACTIONS.map((a) => a.id));
    for (const r of BASE_ITEMS) expect(ids.has(r.game_action), r.source_key).toBe(true);
  });

  it('skins are grant_item rows: 5 car liveries converted, 15 new, all category mounts, no worlds limit', () => {
    const skins = BASE_ITEMS.filter((r) => r.action_config.effect === 'grant_item' && String(r.action_config.item_id).startsWith('skin_'));
    expect(skins.length).toBe(20);
    for (const key of ['cosmetic_car_neon', 'cosmetic_car_inferno', 'cosmetic_car_phantom', 'cosmetic_car_toxic', 'cosmetic_car_azure']) {
      const r = skins.find((s) => s.source_key === key);
      expect(r, key).toBeTruthy();
      expect(r!.action_config.item_id).toBe(`skin_${key.replace('cosmetic_', '')}`);
    }
    for (const s of skins) {
      expect(s.category).toBe('mounts');
      expect(s.worlds).toBeUndefined();
    }
    expect(BASE_ITEMS.some((r) => r.action_config.effect === 'unlock_cosmetic' && r.action_config.kind === 'vehicle')).toBe(false);
  });

  it('source keys are unique and none of the pre-existing keys disappeared', () => {
    const keys = BASE_ITEMS.map((r) => r.source_key);
    expect(new Set(keys).size).toBe(keys.length);
    for (const k of ['mount_strength_1', 'mount_shield_3', 'mount_power_2', 'cosmetic_car_neon', 'pack_medkit']) expect(keys).toContain(k);
    // Seeded per world, MINUS the rows a `worlds` allowlist withholds. Written
    // as the sum rather than the product because the yard's four rows are the
    // first ever to carry one; a flat product would go green again the day
    // somebody deleted an allowlist and seeded a `ships` row into a world with
    // no counter that stocks it.
    const seeded = MARKETPLACE_WORLDS.reduce((n, w) => n
      + BASE_ITEMS.filter((r) => !r.worlds || (r.worlds as readonly string[]).includes(w)).length, 0);
    expect(buildMarketplaceSeedItems().length).toBe(seeded);
    expect(seeded).toBeLessThan(BASE_ITEMS.length * MARKETPLACE_WORLDS.length);
  });

  /**
   * The yard's four rows, and the reach rule behind the allowlist on each.
   *
   * `Marketplace.refreshCatalog` filters the open window by the standing
   * vendor's `vendorCategories` and `_findVendor` only sees NPCs within
   * `VENDOR_RANGE = 7` m, so a row seeded into a world where no counter
   * carries its category is a catalogue entry nobody in that world can be
   * shown. The in-game half of this - that the yard's own counters do stock
   * every one of these - is asserted against `DockWorld` itself in
   * scripts/tests/dock-economy.test.mjs, which is the suite that actually runs
   * in CI.
   */
  it('the Lodestar Yard rows exist, grant real items and are stocked only where a counter carries them', () => {
    const yard = Object.fromEntries(BASE_ITEMS
      .filter((r) => ['pack_laser_cell', 'part_hull_plate', 'part_thruster_coil', 'pack_nav_chart'].includes(r.source_key))
      .map((r) => [r.source_key, r]));
    expect(Object.keys(yard).sort()).toEqual(['pack_laser_cell', 'pack_nav_chart', 'part_hull_plate', 'part_thruster_coil']);

    expect(yard.pack_laser_cell.category).toBe('weapons');
    expect(yard.pack_laser_cell.action_config).toEqual({ effect: 'grant_ammo', ammo_item: 'laser_cell', amount: 40 });
    expect(yard.part_hull_plate.category).toBe('ships');
    expect(yard.part_thruster_coil.category).toBe('ships');
    expect(yard.pack_nav_chart.category).toBe('tools');

    // `ships` exists nowhere but the yard, so its rows go nowhere but the yard.
    for (const r of BASE_ITEMS) {
      if (r.category !== 'ships') continue;
      expect(r.worlds, `${r.source_key} is a ships row with no world allowlist`).toEqual(['dock']);
    }
    // The chart's effect is a viewpoint, and exactly two worlds publish any.
    expect(yard.pack_nav_chart.worlds).toEqual(['citadel', 'dock']);
    expect(yard.pack_laser_cell.worlds).toEqual(['dock']);

    // Buy over sell on every one: buy -> sell -> buy must never print credits.
    for (const r of Object.values(yard)) expect(r.cost_buy).toBeGreaterThan(r.cost_sell);
  });
});
