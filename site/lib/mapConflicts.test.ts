import { describe, it, expect } from 'vitest';
import type { MoveEntry, PlaceEntry } from './mapOverlaySchema';
import type { WorldLayout } from './mapLayout';
import { conflictsFor, conflictsForDocument, hasErrors, type Conflict, type ConflictContext } from './mapConflicts';

/**
 * What the map editor says is wrong with an entry — and what the save route
 * refuses.
 *
 * The page runs these rules live so the admin sees "underground" beside a row
 * before clicking Save; the route runs the SAME function and refuses on any
 * error. One module, two callers. So these cases are not about a UI: each is a
 * document the server will either write into a live world or send back, and
 * every assertion is on the exact code list, because "some warning fired" is
 * how a wrong rule hides behind a right one.
 *
 * Nothing here is stubbed. The ground cases build a real Int16 grid through
 * `encodeHeights` + `decodeGround` and go through the real `groundAt`, so a
 * regression in the grid arithmetic shows up here as well as in mapLayout's
 * own tests.
 */

function move(over: Partial<MoveEntry> = {}): MoveEntry {
  return { kind: 'move', id: 'm1', target: { name: 'barn.roof' }, position: { x: 2, y: 2, z: 2 }, ...over };
}

function place(over: Partial<PlaceEntry> = {}): PlaceEntry {
  const item = { source_key: 'pack_ammo:station', name: 'Ammo pack', config: {} };
  return { kind: 'place', id: 'p1', item, position: { x: 2, y: 2, z: 2 }, quantity: 1, ...over };
}

function layout(over: Partial<WorldLayout> = {}): WorldLayout {
  const bounds = { min: { x: -100, y: 0, z: -100 }, max: { x: 100, y: 50, z: 100 } };
  return { schema: 1, bounds, shapes: [], ground: null, ...over };
}

function ctx(over: Partial<ConflictContext> = {}): ConflictContext {
  return { layout: null, ground: null, objects: [], ...over };
}

const codes = (cs: Conflict[]) => cs.map((c) => c.code);
const crate = { name: 'crate', position: { x: 0, y: 0, z: 0 } };

describe('the name rules, which need no layout', () => {
  it('finds nothing wrong with a lone move in a world that has reported nothing', () => {
    expect(conflictsFor(move(), 0, [move()], ctx())).toEqual([]);
  });

  it('warns both entries when two moves aim at the same object, naming each other', () => {
    const doc = [move({ id: 'a' }), move({ id: 'b', position: { x: 50, y: 2, z: 50 } })];
    const all = conflictsForDocument(doc, ctx());
    expect(all).toHaveLength(2);
    expect(all[0]).toEqual([expect.objectContaining({ level: 'warn', code: 'duplicate-target', other: 'b' })]);
    expect(all[1]).toEqual([expect.objectContaining({ level: 'warn', code: 'duplicate-target', other: 'a' })]);
  });

  it('does not call a move and a place duplicates: a placement has no target', () => {
    expect(conflictsForDocument([move(), place()], ctx())).toEqual([[], []]);
  });

  it('warns about a target the world did not report, but only once the world has reported something', () => {
    expect(codes(conflictsFor(move(), 0, [move()], ctx({ objects: [] })))).toEqual([]);
    expect(codes(conflictsFor(move(), 0, [move()], ctx({ objects: [crate] })))).toEqual(['stale-name']);
    const known = move({ target: { name: 'crate' } });
    expect(codes(conflictsFor(known, 0, [known], ctx({ objects: [crate] })))).toEqual([]);
  });

  it('gives a hidden move, which has no position, the name rules and nothing else', () => {
    const hidden = move({ position: null, hidden: true });
    const found = conflictsFor(hidden, 0, [hidden], ctx({ layout: layout(), objects: [crate] }));
    expect(codes(found)).toEqual(['stale-name']);
  });

  it('lets a move a kilometre out through when there is no layout to measure against', () => {
    const far = move({ position: { x: 1000, y: 0, z: 1000 } });
    expect(conflictsFor(far, 0, [far], ctx())).toEqual([]);
  });
});

describe('hasErrors', () => {
  it('is true only when some entry carries an error', () => {
    const warn: Conflict = { level: 'warn', code: 'stale-name', detail: '' };
    const error: Conflict = { level: 'error', code: 'out-of-bounds', detail: '' };
    expect(hasErrors([])).toBe(false);
    expect(hasErrors([[warn], []])).toBe(false);
    expect(hasErrors([[], [warn, error]])).toBe(true);
  });
});
