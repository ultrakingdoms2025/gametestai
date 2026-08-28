import { describe, it, expect } from 'vitest';
import {
  MAP_OVERLAY_SCHEMA,
  MAX_OVERLAY_ENTRIES,
  WORLD_COORD_LIMIT,
  cutCodePoints,
  isKnownOverlayWorld,
  normaliseOverlayEntries,
  targetLabel,
  targetName,
  type MoveEntry,
  type OverlayEntry,
  type RemoveEntry,
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
    expect(e.target).toEqual({ name: 'barn.roof' });
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

    // The name cut is a fixed point too. Cut BEFORE the trim, a 200-char name
    // ending in a space re-normalised to 199 chars; cut by UTF-16 unit, one
    // ending in an emoji kept a lone high surrogate, which JSON.stringify
    // writes as `\ud83d` and Postgres refuses (the save 500s). The cut is
    // by code point and the result is trimmed again: a code point at the
    // boundary is kept whole or dropped whole, never split.
    const lone = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/;
    const nameOf = (raw: string) => {
      const out = normaliseOverlayEntries([move({ target: { name: raw } })]);
      expect(out.rejected).toEqual([]);
      const name = (out.entries[0] as MoveEntry).target as { name: string };
      expect(normaliseOverlayEntries(out.entries).entries).toEqual(out.entries);
      return name.name;
    };
    expect(nameOf(`${'a'.repeat(199)} b`)).toBe('a'.repeat(199));
    const emojiAtTheCut = nameOf(`${'a'.repeat(199)}😀tail`);
    expect(emojiAtTheCut).toBe(`${'a'.repeat(199)}😀`);
    expect(emojiAtTheCut).not.toMatch(lone);
    expect(nameOf(`${'a'.repeat(200)}😀`)).toBe('a'.repeat(200));
  });

  it('rounds coordinates to millimetres so a drifting float cannot grow the document', () => {
    const { entries } = normaliseOverlayEntries([
      move({ position: { x: 1.23456789, y: 0, z: 0 } }),
    ]);
    const moved = entries[0] as Extract<OverlayEntry, { kind: 'move' }>;
    expect(moved.position.x).toBe(1.235);
  });

  it('wraps rotationY into a single turn', () => {
    const { entries } = normaliseOverlayEntries([move({ rotationY: Math.PI * 2 + 0.5 })]);
    expect((entries[0] as MoveEntry).rotationY).toBeCloseTo(0.5, 6);
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

  it('cuts a config string by code point, so an emoji at the 200 boundary is kept whole or dropped whole', () => {
    // The same defect `readName` had: a copied config string is cut at 200
    // and stored as JSON, and a UTF-16 cut through an astral character left
    // `\ud83d` for Postgres to refuse.
    const lone = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/;
    const configOf = (effect: string) => {
      const { entries, rejected } = normaliseOverlayEntries([place({ item: { source_key: 'k', name: 'n', config: { effect } } })]);
      expect(rejected).toEqual([]);
      return (entries[0] as Extract<OverlayEntry, { kind: 'place' }>).item.config.effect as string;
    };
    const kept = configOf(`${'a'.repeat(199)}😀tail`);
    expect(kept).toBe(`${'a'.repeat(199)}😀`);
    expect(JSON.stringify(kept)).not.toMatch(lone);
    expect(configOf(`${'a'.repeat(200)}😀`)).toBe('a'.repeat(200));
  });
});

/**
 * The one cut every site uses. Six places cut a string before it becomes
 * JSON in Postgres — a target name, a config string, an author, a note, and
 * the report reader's names, ids and reasons — and `String.prototype.slice`
 * counts UTF-16 units, so any of them could split an astral character and
 * hand Postgres a lone surrogate. They all go through this.
 */
describe('cutCodePoints', () => {
  const lone = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/;
  const plain = (s: string, max: number) => Array.from(s).slice(0, max).join('');

  it('is the first `max` code points, whatever mix of BMP and astral characters precedes the boundary', () => {
    const astral = '😀'.repeat(300);
    for (const s of [astral, `a${astral}`, `${'a'.repeat(199)}${astral}`, `${'a'.repeat(200)}${astral}`, 'a'.repeat(50)]) {
      // The pre-cut to `max * 2` units is an optimisation the result cannot see:
      // this is the plain, un-pre-cut form, and the two agree byte for byte.
      expect(cutCodePoints(s, 200)).toBe(plain(s, 200));
      expect(JSON.stringify(cutCodePoints(s, 200))).not.toMatch(lone);
    }
    expect(cutCodePoints(`a${astral}`, 200)).toBe(`a${'😀'.repeat(199)}`);
    expect(cutCodePoints('', 200)).toBe('');
    expect(cutCodePoints('abc', 0)).toBe('');
  });

  it('may split a ZWJ sequence between code points: the glyph changes, the UTF-16 stays valid', () => {
    const family = '👨‍👩‍👧'; // five code points, eight UTF-16 units
    expect(Array.from(family)).toHaveLength(5);
    const cut = cutCodePoints(family, 3);
    expect(cut).toBe('👨‍👩');
    expect(JSON.stringify(cut)).not.toMatch(lone);
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
    expect(MAP_OVERLAY_SCHEMA).toBe(2);
  });
});

describe('schema v2: targets, remove, and what became of hidden', () => {
  const asMove = (e: OverlayEntry) => e as MoveEntry;
  const asRemove = (e: OverlayEntry) => e as RemoveEntry;

  it('migrates a v1 hidden move with no position to a remove of the same id and target', () => {
    const { entries, rejected } = normaliseOverlayEntries([move({ id: 'h1', position: undefined, hidden: true })]);
    expect(rejected).toEqual([]);
    expect(entries).toEqual([{ kind: 'remove', id: 'h1', target: { name: 'barn.roof' } }]);
  });

  it('migrates a v1 hidden move WITH a position to a remove, discarding the position and yaw (decision A), one raw entry to one entry', () => {
    const raw = [move({ id: 'h2', position: { x: 4, y: 0, z: 4 }, rotationY: 1, hidden: true }), move({ id: 'm2', target: { name: 'well' } })];
    const { entries, rejected } = normaliseOverlayEntries(raw);
    expect(rejected).toEqual([]);
    expect(entries).toHaveLength(2);
    expect(entries[0]).toEqual({ kind: 'remove', id: 'h2', target: { name: 'barn.roof' } });
    expect(entries[1].id).toBe('m2');
    // the old coercion read any truthy flag as hidden; a stored 'yes' must migrate the same way
    expect(normaliseOverlayEntries([move({ hidden: 'yes' })]).entries[0].kind).toBe('remove');
  });

  it('rejects a move with a null position: hiding is a remove, and a move must say where', () => {
    const { entries, rejected } = normaliseOverlayEntries([move({ position: null })]);
    expect(entries).toEqual([]);
    expect(rejected).toEqual([{ index: 0, id: 'e1', reason: 'position' }]);
  });

  it('accepts a remove of a named target, and re-normalises it to itself', () => {
    const first = normaliseOverlayEntries([{ kind: 'remove', id: 'r1', target: { name: 'barn.roof' } }]);
    expect(first.rejected).toEqual([]);
    expect(first.entries).toEqual([{ kind: 'remove', id: 'r1', target: { name: 'barn.roof' } }]);
    expect(normaliseOverlayEntries(first.entries)).toEqual(first);
  });

  it('rejects a remove with no usable target', () => {
    for (const bad of [undefined, {}, { name: '' }, { name: 42 }, { name: 'x', id: 'a@1,2' }]) {
      const { entries, rejected } = normaliseOverlayEntries([{ kind: 'remove', id: 'r', target: bad }]);
      expect(entries, JSON.stringify(bad)).toEqual([]);
      expect(rejected[0].reason).toBe('target');
    }
  });

  it('accepts an {id} target in family@x,z[#n] form, namespaced or not, on a move and a remove', () => {
    const ids = ['medieval:house@12.3,-40.1', 'rock@5,-7#2', 'planet:prop:tree@0.0,0.0', 'crate_a-1.b@-100,100#12'];
    for (const id of ids) {
      const { entries, rejected } = normaliseOverlayEntries([move({ target: { id } }), { kind: 'remove', id: 'r', target: { id } }]);
      expect(rejected, id).toEqual([]);
      expect(asMove(entries[0]).target).toEqual({ id });
      expect(asRemove(entries[1]).target).toEqual({ id });
    }
  });

  it('rejects an {id} that is not in that form, over 128 chars, or beside a name', () => {
    // `${'a'.repeat(130)}@1,2#1` is 136 chars: past TARGET_ID_MAX however well-formed. (120 a's would be 126 and ACCEPTED.)
    const bad = ['house', 'house@x,z', 'house@1,2,3', 'house@1.25,2', `${'a'.repeat(130)}@1,2#1`, 7];
    for (const id of bad) {
      const { entries, rejected } = normaliseOverlayEntries([move({ target: { id } })]);
      expect(entries, String(id)).toEqual([]);
      expect(rejected[0].reason).toBe('target');
    }
    // The boundary itself: `@1,2#1` is 6 chars, so 122 a's make exactly 128 (accepted) and 123 make 129 (refused, not cut).
    const ofLength = (n: number) => `${'a'.repeat(n - 6)}@1,2#1`;
    expect(ofLength(128)).toHaveLength(128);
    expect(normaliseOverlayEntries([move({ target: { id: ofLength(128) } })]).rejected).toEqual([]);
    expect(normaliseOverlayEntries([move({ target: { id: ofLength(129) } })]).rejected[0].reason).toBe('target');
    expect(normaliseOverlayEntries([move({ target: { name: 'a', id: 'a@1,2' } })]).rejected[0].reason).toBe('target');
    expect(normaliseOverlayEntries([move({ target: {} })]).rejected[0].reason).toBe('target');
  });

  it('keeps a mixed document of name and id targets in order, 1:1 with what was sent', () => {
    const raw = [move({ id: 'a' }), move({ id: 'b', target: { id: 'rock@5,-7' } }), { kind: 'remove', id: 'c', target: { id: 'rock@5,-8' } }, place()];
    const { entries, rejected } = normaliseOverlayEntries(raw);
    expect(rejected).toEqual([]);
    expect(entries.map((e) => e.id)).toEqual(['a', 'b', 'c', 'e2']);
  });

  it('targetName and targetLabel read both target shapes', () => {
    expect(targetName({ name: 'barn' })).toBe('barn');
    expect(targetName({ id: 'rock@5,-7' })).toBeNull();
    expect(targetLabel({ name: 'barn' })).toBe('barn');
    expect(targetLabel({ id: 'rock@5,-7' })).toBe('rock@5,-7');
  });
});
