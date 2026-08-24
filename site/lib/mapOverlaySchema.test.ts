import { describe, it, expect } from 'vitest';
import {
  MAP_OVERLAY_SCHEMA,
  MAX_OVERLAY_ENTRIES,
  WORLD_COORD_LIMIT,
  isKnownOverlayWorld,
  normaliseOverlayEntries,
  type OverlayEntry,
} from './mapOverlaySchema';

/**
 * The overlay document, before it ever reaches a database.
 *
 * This module is the only thing standing between an admin form (or a replayed
 * request, or a mistake) and a document the GAME will apply to a live world.
 * Everything it lets through gets executed against `world.group` and the physics
 * world on the next world load, so "reject it here" is much cheaper than "cope
 * with it there".
 *
 * Two of these cases are the ones that would actually bite:
 *
 *   1. A `move` whose position is a DELTA rather than an absolute point. The
 *      overlay is applied once per world load, so a delta compounds: the crate
 *      walks a little further off every time the player returns. Absolute
 *      positions are idempotent by construction and this module is where that
 *      is enforced — a move without a position is not a move.
 *
 *   2. A coordinate of NaN, Infinity, or 1e30. Three will happily set it, the
 *      matrix goes non-finite, and the object (plus anything that shares its
 *      bounding computation) disappears with no error anywhere.
 */

function move(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    kind: 'move',
    id: 'e1',
    target: { name: 'barn.roof' },
    position: { x: 1, y: 2, z: 3 },
    ...over,
  };
}

function place(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    kind: 'place',
    id: 'e2',
    item: { source_key: 'pack_ammo:station', name: 'Ammo pack' },
    position: { x: 4, y: 5, z: 6 },
    ...over,
  };
}

describe('normaliseOverlayEntries', () => {
  it('accepts a move and keeps its absolute position', () => {
    const { entries, rejected } = normaliseOverlayEntries([move()]);
    expect(rejected).toEqual([]);
    expect(entries).toHaveLength(1);
    const e = entries[0] as Extract<OverlayEntry, { kind: 'move' }>;
    expect(e.kind).toBe('move');
    expect(e.target.name).toBe('barn.roof');
    expect(e.position).toEqual({ x: 1, y: 2, z: 3 });
  });

  it('accepts a placement and keeps its source key', () => {
    const { entries, rejected } = normaliseOverlayEntries([place()]);
    expect(rejected).toEqual([]);
    const e = entries[0] as Extract<OverlayEntry, { kind: 'place' }>;
    expect(e.kind).toBe('place');
    expect(e.item.source_key).toBe('pack_ammo:station');
    expect(e.quantity).toBe(1);
  });

  it('rejects an unknown kind rather than storing it', () => {
    const { entries, rejected } = normaliseOverlayEntries([{ kind: 'delete', id: 'x' }]);
    expect(entries).toEqual([]);
    expect(rejected).toHaveLength(1);
    expect(rejected[0].reason).toBe('kind');
  });

  it('rejects a move with no position, because a move must be absolute', () => {
    const { entries, rejected } = normaliseOverlayEntries([move({ position: undefined })]);
    expect(entries).toEqual([]);
    expect(rejected[0].reason).toBe('position');
  });

  it('rejects non-finite coordinates', () => {
    for (const bad of [NaN, Infinity, -Infinity, 'ten', null]) {
      const { entries, rejected } = normaliseOverlayEntries([
        move({ position: { x: bad, y: 0, z: 0 } }),
      ]);
      expect(entries, String(bad)).toEqual([]);
      expect(rejected[0].reason).toBe('position');
    }
  });

  it('rejects coordinates beyond the range worlds actually occupy', () => {
    const { entries, rejected } = normaliseOverlayEntries([
      move({ position: { x: WORLD_COORD_LIMIT + 1, y: 0, z: 0 } }),
    ]);
    expect(entries).toEqual([]);
    expect(rejected[0].reason).toBe('position');
  });

  it('rejects a move with no target name', () => {
    for (const bad of [undefined, {}, { name: '' }, { name: '   ' }, { name: 42 }]) {
      const { entries, rejected } = normaliseOverlayEntries([move({ target: bad })]);
      expect(entries, JSON.stringify(bad)).toEqual([]);
      expect(rejected[0].reason).toBe('target');
    }
  });

  it('rejects a placement with no source key', () => {
    for (const bad of [undefined, {}, { source_key: '' }, { source_key: 7 }]) {
      const { entries, rejected } = normaliseOverlayEntries([place({ item: bad })]);
      expect(entries, JSON.stringify(bad)).toEqual([]);
      expect(rejected[0].reason).toBe('item');
    }
  });

  it('rejects a duplicate id, so editing one entry cannot silently edit two', () => {
    const { entries, rejected } = normaliseOverlayEntries([move(), move()]);
    expect(entries).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(rejected[0].reason).toBe('duplicate');
  });

  it('mints an id when one is missing rather than rejecting the entry', () => {
    const { entries, rejected } = normaliseOverlayEntries([move({ id: undefined })]);
    expect(rejected).toEqual([]);
    expect(entries[0].id).toMatch(/^[a-z0-9]/i);
    expect(entries[0].id.length).toBeGreaterThan(3);
  });

  it('caps the document length', () => {
    const many = Array.from({ length: MAX_OVERLAY_ENTRIES + 5 }, (_, i) => move({ id: `e${i}` }));
    const { entries, rejected } = normaliseOverlayEntries(many);
    expect(entries).toHaveLength(MAX_OVERLAY_ENTRIES);
    expect(rejected).toHaveLength(5);
    expect(rejected[0].reason).toBe('overflow');
  });

  it('is idempotent: normalising its own output changes nothing', () => {
    const first = normaliseOverlayEntries([
      move({ position: { x: 1.00048, y: -2.9999, z: 3 }, rotationY: Math.PI * 3 }),
      place({ quantity: 4.7 }),
    ]);
    expect(first.rejected).toEqual([]);
    const second = normaliseOverlayEntries(first.entries);
    expect(second.rejected).toEqual([]);
    expect(second.entries).toEqual(first.entries);
  });

  it('rounds coordinates to millimetres so a drifting float cannot grow the document', () => {
    const { entries } = normaliseOverlayEntries([
      move({ position: { x: 1.23456789, y: 0, z: 0 } }),
    ]);
    expect((entries[0] as Extract<OverlayEntry, { kind: 'move' }>).position.x).toBe(1.235);
  });

  it('wraps rotationY into a single turn', () => {
    const { entries } = normaliseOverlayEntries([move({ rotationY: Math.PI * 2 + 0.5 })]);
    expect(entries[0].rotationY).toBeCloseTo(0.5, 6);
  });

  it('carries hidden through as a boolean and defaults it off', () => {
    expect(normaliseOverlayEntries([move()]).entries[0]).not.toHaveProperty('hidden');
    const { entries } = normaliseOverlayEntries([move({ hidden: 'yes' })]);
    expect((entries[0] as Extract<OverlayEntry, { kind: 'move' }>).hidden).toBe(true);
  });

  it('accepts a hidden-only move with no position, because hiding needs no destination', () => {
    const { entries, rejected } = normaliseOverlayEntries([
      move({ position: undefined, hidden: true }),
    ]);
    expect(rejected).toEqual([]);
    expect((entries[0] as Extract<OverlayEntry, { kind: 'move' }>).position).toBeNull();
  });

  it('survives rubbish input without throwing', () => {
    for (const bad of [null, undefined, 42, 'entries', {}, [null], [undefined], [[]]]) {
      expect(() => normaliseOverlayEntries(bad as never)).not.toThrow();
    }
    expect(normaliseOverlayEntries(null as never).entries).toEqual([]);
  });

  it('does not let a prototype-polluting key through as a target name', () => {
    const { entries } = normaliseOverlayEntries([move({ target: { name: '__proto__' } })]);
    expect(entries).toEqual([]);
  });
});

/**
 * The grant descriptor a placement carries.
 *
 * A placed marketplace item has to become a real inventory item when the player
 * walks into it, and the thing that decides which one is the catalogue row's
 * `action_config` — `{ effect: 'grant_ammo', ammo_item: 'bullet', amount: 60 }`
 * and friends. The server cannot work that out from a `source_key` (the mapping
 * lives in the game's `Marketplace._purchaseGrant`), so the editor copies the
 * row's config onto the entry when the admin picks the item.
 *
 * It is copied, not referenced, on purpose: a placement is a decision an admin
 * made at a moment in time, and re-pricing or re-describing the catalogue row
 * afterwards should not silently change what a crate on a hillside contains.
 */
describe('placement grant config', () => {
  it('carries a plain config through untouched', () => {
    const { entries } = normaliseOverlayEntries([
      place({ item: { source_key: 'pack_bullets', name: 'Rifle Round Pack', config: { effect: 'grant_ammo', ammo_item: 'bullet', amount: 60 } } }),
    ]);
    const e = entries[0] as Extract<OverlayEntry, { kind: 'place' }>;
    expect(e.item.config).toEqual({ effect: 'grant_ammo', ammo_item: 'bullet', amount: 60 });
  });

  it('defaults to an empty config when none is given', () => {
    const { entries } = normaliseOverlayEntries([place()]);
    expect((entries[0] as Extract<OverlayEntry, { kind: 'place' }>).item.config).toEqual({});
  });

  it('keeps only scalar values, so nothing nested can arrive as a config', () => {
    const { entries } = normaliseOverlayEntries([
      place({
        item: {
          source_key: 'k',
          name: 'n',
          config: { effect: 'grant_item', nested: { a: 1 }, list: [1, 2], fn: 'ok', amount: 3, on: true },
        },
      }),
    ]);
    const config = (entries[0] as Extract<OverlayEntry, { kind: 'place' }>).item.config;
    expect(config).toEqual({ effect: 'grant_item', fn: 'ok', amount: 3, on: true });
  });

  it('drops a prototype-polluting key out of a config', () => {
    const raw = JSON.parse('{"effect":"grant_item","__proto__":{"polluted":true}}');
    const { entries } = normaliseOverlayEntries([
      place({ item: { source_key: 'k', name: 'n', config: raw } }),
    ]);
    const config = (entries[0] as Extract<OverlayEntry, { kind: 'place' }>).item.config;
    expect(Object.keys(config)).toEqual(['effect']);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it('is idempotent over a config', () => {
    const first = normaliseOverlayEntries([
      place({ item: { source_key: 'k', name: 'n', config: { effect: 'grant_item', item_id: 'medkit', amount: 2 } } }),
    ]);
    expect(normaliseOverlayEntries(first.entries).entries).toEqual(first.entries);
  });
});

describe('isKnownOverlayWorld', () => {
  it('accepts the worlds the game ships', () => {
    expect(isKnownOverlayWorld('station')).toBe(true);
    expect(isKnownOverlayWorld('medieval')).toBe(true);
  });

  it('refuses an unknown or malformed world id', () => {
    expect(isKnownOverlayWorld('')).toBe(false);
    expect(isKnownOverlayWorld('../etc')).toBe(false);
    expect(isKnownOverlayWorld('not-a-world')).toBe(false);
    expect(isKnownOverlayWorld(null)).toBe(false);
  });
});

describe('MAP_OVERLAY_SCHEMA', () => {
  it('is a version number the game can refuse to read', () => {
    expect(Number.isInteger(MAP_OVERLAY_SCHEMA)).toBe(true);
    expect(MAP_OVERLAY_SCHEMA).toBeGreaterThan(0);
  });
});
