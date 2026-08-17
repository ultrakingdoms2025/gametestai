import { describe, expect, it } from 'vitest';
import { BASE_ITEMS, MARKETPLACE_ACTIONS, buildMarketplaceSeedItems } from './marketplaceCatalog';

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
    expect(buildMarketplaceSeedItems().length).toBeGreaterThan(170);
  });
});
