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

  it('does not let a hidden move that still carries a position occupy that spot: a hidden object stands nowhere', () => {
    // The game moves the object and then hides it, so the position is real data — but nothing can collide with
    // a hidden object. Pinned now, before the overlap rule exists, so that rule inherits the guard rather than
    // discovering it: without it the place at the same spot would report `overlap` with `other: 'm1'`.
    const spot = { x: 50, y: 0, z: 50 };
    const beside = place({ position: spot });
    const stranger = move({ hidden: true, position: spot });
    const known = move({ hidden: true, position: spot, target: { name: 'crate' } });
    const world = () => ctx({ layout: layout(), objects: [crate] });
    expect(conflictsForDocument([stranger, beside], world()).map(codes)).toEqual([['stale-name'], []]);
    expect(conflictsForDocument([known, beside], world()).map(codes)).toEqual([[], []]);
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

describe('out-of-bounds, the only error', () => {
  const bounded = () => ctx({ layout: layout() });

  it('accepts a position inside the bounds and within the 5 m margin', () => {
    for (const [x, z] of [[0, 0], [100, 0], [104, 0], [-104, 0], [0, 104], [0, -104]]) {
      const m = move({ position: { x, y: 2, z } });
      expect(conflictsFor(m, 0, [m], bounded()), `x=${x} z=${z}`).toEqual([]);
    }
  });

  it("ignores y: the bounds are a floor plan, and height is the floating rule's business", () => {
    const high = move({ position: { x: 0, y: 500, z: 0 } });
    expect(conflictsFor(high, 0, [high], bounded())).toEqual([]);
  });

  it('refuses, as an error, a position past the margin on either axis, for moves and places', () => {
    const error = [expect.objectContaining({ level: 'error', code: 'out-of-bounds' })];
    for (const [x, z] of [[106, 0], [-106, 0], [0, 106], [0, -106]]) {
      const m = move({ position: { x, y: 2, z } });
      const p = place({ position: { x, y: 2, z } });
      expect(conflictsFor(m, 0, [m], bounded()), `move ${x},${z}`).toEqual(error);
      expect(conflictsFor(p, 0, [p], bounded()), `place ${x},${z}`).toEqual(error);
    }
  });

  it('is an error the route can see through hasErrors, on a layout that has bounds but no ground yet', () => {
    // `layout()` carries `ground: null`: the immediate report, before sampling. The bounds alone must refuse.
    expect(layout().ground).toBeNull();
    const doc = [move(), place({ position: { x: 0, y: 2, z: -300 } })];
    const all = conflictsForDocument(doc, bounded());
    expect(all.map(codes)).toEqual([[], ['out-of-bounds']]);
    expect(hasErrors(all)).toBe(true);
  });

  it('names the axis in the detail, so the row says which number to fix', () => {
    const m = move({ position: { x: 2, y: 2, z: 300 } });
    expect(conflictsFor(m, 0, [m], bounded())[0].detail).toMatch(/^z = 300 /);
  });
});
