/**
 * THE CLAIM: the editor's Place list offers exactly what the game's applier can turn into a pickup, and says
 * why the rest is missing.
 *
 * The rule under test is `placeableReason`, a mirror of `grantForPlacement` in `src/systems/MapOverlay.js`
 * (the game; its literals are pinned against this module's by `mapPlaceableContract.test.ts`). The verdicts
 * are asserted on the REAL seed rows, not on hand-built configs alone: the nine rows an admin placed on
 * station — Bicycle Speed I–III, Bicycle Acceleration I–III, Hoverboard Speed I–III — are `grant_mount_power`
 * rows from `buildMarketplaceSeedItems`. The game once refused all nine with `reason: 'item'`, and for one
 * release the list hid them; now the game lays a mount upgrade down as a pickup that grants the tier once
 * per account, and the nine are offered again. What the site still cannot see is whether the MOUNT SELLS
 * the power (Fire on a horse): that refusal is the game's, with the same `item` reason, and lands on the row.
 * The consumables are asserted placeable THROUGH their world-stamped key (`spell_velocity_25:station`), the
 * shape the API hands the editor, because the game resolves those by key and not by effect; a rule that
 * read only the effect would hide fifteen items the game can place.
 */
import { describe, expect, it } from 'vitest';
import { buildMarketplaceSeedItems } from './marketplaceCatalog';
import {
  CONSUMABLE_SOURCE_KEYS,
  MOUNT_POWER_TEXT,
  NOT_A_PICKUP_TEXT,
  hiddenItemsText,
  partitionPlaceable,
  placeableReason,
} from './mapPlaceable';

const seed = buildMarketplaceSeedItems();
const row = (key: string) => {
  const r = seed.find((s) => s.source_key === key);
  if (!r) throw new Error(`no seed row ${key}`);
  return { source_key: r.source_key, config: r.action_config };
};

describe('placeableReason', () => {
  it('an ammo pack (grant_ammo with a string ammo_item) is placeable', () => {
    expect(placeableReason({ source_key: 'pack_bullets:station', config: { effect: 'grant_ammo', ammo_item: 'bullet', amount: 60 } })).toBeNull();
    expect(placeableReason(row('pack_laser_cell:dock'))).toBeNull();
  });

  it('an inventory item (grant_item with a string item_id) is placeable — a ship part, a car skin, a mount skin', () => {
    expect(placeableReason(row('part_hull_plate:dock'))).toBeNull();
    expect(placeableReason(row('cosmetic_car_neon:race'))).toBeNull();
    expect(placeableReason({ source_key: 'x', config: { effect: 'grant_item', item_id: 'nav_chart' } })).toBeNull();
  });

  it('grant_ammo without a string ammo_item, and grant_item without a string item_id, are not pickups — the game reads the field, not the effect', () => {
    expect(placeableReason({ source_key: 'x', config: { effect: 'grant_ammo' } })).toBe(NOT_A_PICKUP_TEXT);
    expect(placeableReason({ source_key: 'x', config: { effect: 'grant_ammo', ammo_item: 7 } })).toBe(NOT_A_PICKUP_TEXT);
    expect(placeableReason({ source_key: 'x', config: { effect: 'grant_item', item_id: null } })).toBe(NOT_A_PICKUP_TEXT);
  });

  it('a mount upgrade is placeable: the nine rows the admin placed on station are offered again, as pickups the game grants once', () => {
    const nine = seed.filter((s) => s.world_name === 'station' && /^(Bicycle (Speed|Acceleration)|Hoverboard Speed) (I|II|III)$/.test(s.name));
    expect(nine.map((s) => s.name).sort()).toEqual([
      'Bicycle Acceleration I', 'Bicycle Acceleration II', 'Bicycle Acceleration III',
      'Bicycle Speed I', 'Bicycle Speed II', 'Bicycle Speed III',
      'Hoverboard Speed I', 'Hoverboard Speed II', 'Hoverboard Speed III',
    ]);
    for (const s of nine) {
      expect(s.action_config.effect, s.name).toBe('grant_mount_power');
      expect(placeableReason({ source_key: s.source_key, config: s.action_config }), s.name).toBeNull();
    }
    // Every mount upgrade the catalogue seeds, the car's nine included.
    for (const s of seed.filter((r) => r.action_config.effect === 'grant_mount_power')) {
      expect(placeableReason({ source_key: s.source_key, config: s.action_config }), s.source_key).toBeNull();
    }
  });

  it('a mount upgrade must name a mount and a power as strings and a tier of 1 to 3; the site cannot tell whether the mount SELLS the power', () => {
    const ok = { effect: 'grant_mount_power', mount: 'bicycle', power: 'power', tier: 3 };
    expect(placeableReason({ source_key: 'x', config: ok })).toBeNull();
    // Fire on a horse is a row the game refuses (`item`) and the site offers: MountManager's stat table is
    // game source the site does not see, so the game's word lands on the row after the apply.
    expect(placeableReason({ source_key: 'x', config: { ...ok, mount: 'horse', power: 'fire' } })).toBeNull();
    for (const bad of [
      { ...ok, mount: undefined }, { ...ok, mount: 7 }, { ...ok, power: undefined }, { ...ok, power: '' },
      { ...ok, tier: 0 }, { ...ok, tier: 4 }, { ...ok, tier: 1.5 }, { ...ok, tier: '2' }, { ...ok, tier: undefined },
    ]) {
      expect(placeableReason({ source_key: 'x', config: bad as Record<string, unknown> }), JSON.stringify(bad)).toBe(MOUNT_POWER_TEXT);
    }
    expect(MOUNT_POWER_TEXT).toBe('a mount upgrade must name its mount, its power and a tier of 1 to 3');
  });

  it('a cosmetic unlocks in the wardrobe', () => {
    expect(placeableReason(row('cosmetic_headgear_aurora:station'))).toBe('cosmetics unlock in the wardrobe; they cannot lie on the ground');
  });

  it('a heal is not a pickup: restore_health has no pickup form, and the medkit key is not one the game maps', () => {
    expect(placeableReason(row('pack_medkit:station'))).toBe(NOT_A_PICKUP_TEXT);
    expect(placeableReason({ source_key: 'x', config: { effect: 'restore_health_full' } })).toBe(NOT_A_PICKUP_TEXT);
  });

  it('credits are a balance, never a pickup — the one item id the game refuses by name', () => {
    expect(placeableReason({ source_key: 'x', config: { effect: 'grant_item', item_id: 'credits' } })).toBe('credits are a balance, not a pickup');
  });

  it('a config-less item, an empty config, and a null source key are not pickups', () => {
    expect(placeableReason({ source_key: 'x', config: {} })).toBe(NOT_A_PICKUP_TEXT);
    expect(placeableReason({ source_key: 'x' })).toBe(NOT_A_PICKUP_TEXT);
    expect(placeableReason({ source_key: null, config: null })).toBe(NOT_A_PICKUP_TEXT);
    expect(placeableReason({})).toBe(NOT_A_PICKUP_TEXT);
  });

  it('a consumable is placeable by its KEY, world stamp and all: every spell, the shield and the firepower boosts', () => {
    const consumables = seed.filter((s) => CONSUMABLE_SOURCE_KEYS.has(s.source_key.slice(0, s.source_key.lastIndexOf(':'))));
    expect(new Set(consumables.map((s) => s.source_key.slice(0, s.source_key.lastIndexOf(':')))).size).toBe(15);
    for (const s of consumables) {
      expect(placeableReason({ source_key: s.source_key, config: s.action_config }), s.source_key).toBeNull();
    }
    // The bare key too, and a key whose real name contains a colon is probed exactly first.
    expect(placeableReason({ source_key: 'shield_5s', config: { effect: 'shield', seconds: 5 } })).toBeNull();
    expect(placeableReason({ source_key: 'spell_velocity_25:station', config: {} })).toBeNull();
  });

  it('a consumable EFFECT under a key the game does not map is not a pickup: the game resolves the key, not the effect', () => {
    expect(placeableReason({ source_key: 'my_speed_boost:station', config: { effect: 'modify_speed', percent: 25, seconds: 30 } })).toBe(NOT_A_PICKUP_TEXT);
    expect(placeableReason({ source_key: 'constructor', config: { effect: 'shield' } })).toBe(NOT_A_PICKUP_TEXT);
  });
});

describe('partitionPlaceable and hiddenItemsText', () => {
  const items = [
    { id: '1', name: 'Rifle rounds', source_key: 'pack_bullets:station', action_config: { effect: 'grant_ammo', ammo_item: 'bullet' } },
    { id: '2', name: 'Bicycle Speed I', source_key: 'mount_bicycle_speed_1:station', action_config: { effect: 'grant_mount_power', mount: 'bicycle', power: 'speed', tier: 1 } },
    { id: '3', name: 'Aurora', source_key: 'cosmetic_char_aurora:station', action_config: { effect: 'unlock_cosmetic', kind: 'character', cosmetic_id: 'char_aurora' } },
    { id: '4', name: 'Aegis Shard', source_key: 'shield_5s:station', action_config: { effect: 'shield', seconds: 5 } },
    { id: '5', name: 'Medkit', source_key: 'pack_medkit:station', action_config: { effect: 'restore_health', amount: 50 } },
    { id: '6', name: 'Hoverboard Speed II', source_key: 'mount_hoverboard_speed_2:station', action_config: { effect: 'grant_mount_power', mount: 'hoverboard', power: 'speed', tier: 2 } },
  ];

  it('keeps the placeable rows in their order, by identity, and the hidden ones with their reasons', () => {
    const { placeable, hidden } = partitionPlaceable(items);
    expect(placeable).toEqual([items[0], items[1], items[3], items[5]]);
    expect(placeable[1]).toBe(items[1]);
    expect(hidden).toEqual([
      { item: items[2], reason: 'cosmetics unlock in the wardrobe; they cannot lie on the ground' },
      { item: items[4], reason: NOT_A_PICKUP_TEXT },
    ]);
  });

  it('the line under the list counts the hidden rows and names their kinds, in a fixed order', () => {
    const { hidden } = partitionPlaceable(items);
    expect(hiddenItemsText(hidden)).toBe('2 items cannot be placed in a world (cosmetics, heals) — they are granted by purchase');
    expect(hiddenItemsText(hidden.slice(0, 1))).toBe('1 item cannot be placed in a world (cosmetics) — it is granted by purchase');
    // A malformed mount row (no tier) is hidden as "other items": the kinds line names what has NO pickup form, and a mount upgrade has one.
    const malformed = { id: '8', name: 'Bicycle Speed ?', source_key: 'mount_bicycle_power_9:station', action_config: { effect: 'grant_mount_power', mount: 'bicycle', power: 'power' } };
    expect(hiddenItemsText(partitionPlaceable([items[4], { ...items[4], id: '7', action_config: {} }, malformed]).hidden))
      .toBe('3 items cannot be placed in a world (heals, other items) — they are granted by purchase');
    expect(hiddenItemsText([])).toBe('');
  });

  it('on the real seed, every cosmetic and heal is hidden and every ammo pack, part, skin, spell and mount upgrade is offered', () => {
    const { placeable, hidden } = partitionPlaceable(seed.map((s) => ({ ...s, id: s.source_key })));
    const effectsOf = (rows: Array<{ action_config: Record<string, unknown> }>) => new Set(rows.map((r) => String(r.action_config.effect)));
    expect(effectsOf(hidden.map((h) => h.item))).toEqual(new Set(['unlock_cosmetic', 'restore_health']));
    expect([...effectsOf(placeable)].sort()).toEqual(['grant_ammo', 'grant_item', 'grant_mount_power', 'loot_magnet', 'modify_firepower', 'modify_speed', 'pause_npcs', 'portal_ping', 'shield']);
    expect(placeable.length + hidden.length).toBe(seed.length);
  });
});
