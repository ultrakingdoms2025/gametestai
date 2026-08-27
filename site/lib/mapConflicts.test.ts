import { describe, it, expect } from 'vitest';
import type { MoveEntry, PlaceEntry } from './mapOverlaySchema';
import { NO_SAMPLE, decodeGround, encodeHeights, type DecodedGround, type WorldLayout } from './mapLayout';
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

describe('occupancy', () => {
  // The game's `_applyMove` clears `visible` on a hidden move and then relocates the object's colliders only
  // when the entry carries a position. A hidden object is therefore an invisible wall: at the new spot when the
  // move has one, at the reported spot when it does not. The rules compose occupancy that way on purpose, and
  // these two fixtures pin it. Until the overlap rule exists nothing reads the occupants, so both pin today's
  // output; Task 4 makes the first fixture report `overlap` with `other: 'm1'` on the place, and the second
  // `overlap` with `other: 'crate'`.

  it('lets a hidden move that still carries a position stand at that spot: its colliders go there', () => {
    const spot = { x: 50, y: 0, z: 50 };
    const beside = place({ position: spot });
    const stranger = move({ hidden: true, position: spot });
    const known = move({ hidden: true, position: spot, target: { name: 'crate' } });
    const world = () => ctx({ layout: layout(), objects: [crate] });
    expect(conflictsForDocument([stranger, beside], world()).map(codes)).toEqual([['stale-name'], []]);
    expect(conflictsForDocument([known, beside], world()).map(codes)).toEqual([[], []]);
  });

  it('leaves the reported object standing where it was when a hidden move has no position', () => {
    const gone = move({ hidden: true, position: null, target: { name: 'crate' } });
    const onCrate = place({ position: crate.position });
    const all = conflictsForDocument([gone, onCrate], ctx({ layout: layout(), objects: [crate] }));
    expect(all.map(codes)).toEqual([[], []]);
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

describe('the ground rules, through a real Int16 grid', () => {
  /** Four samples 4 m apart with origin (0,0): one cell covering x,z ∈ [0, 4], one layer. */
  function flatGround(heightCm: number): DecodedGround {
    const heightsCm = encodeHeights(Int16Array.from([heightCm, heightCm, heightCm, heightCm]));
    return decodeGround({ originX: 0, originZ: 0, step: 4, nx: 2, nz: 2, layers: 1, heightsCm });
  }
  const twoMetres = () => ctx({ layout: layout(), ground: flatGround(200) });
  /** A move whose bottom is at `y`, in the middle of the cell. */
  const at = (y: number) => move({ position: { x: 2, y, z: 2 } });

  it('accepts a bottom within the tolerances around the ground', () => {
    for (const y of [2, 1.8, 3.4]) {
      const m = move({ position: { x: 2, y, z: 2 } });
      expect(conflictsFor(m, 0, [m], twoMetres()), `y=${y}`).toEqual([]);
    }
  });

  it('warns underground when the bottom is more than 0.25 m below the ground, for moves and places', () => {
    const m = move({ position: { x: 2, y: 1.7, z: 2 } });
    const p = place({ position: { x: 2, y: 1.7, z: 2 } });
    expect(codes(conflictsFor(m, 0, [m], twoMetres()))).toEqual(['underground']);
    expect(codes(conflictsFor(p, 0, [p], twoMetres()))).toEqual(['underground']);
    expect(conflictsFor(m, 0, [m], twoMetres())[0].level).toBe('warn');
  });

  it('warns floating when the bottom is more than 1.5 m above the ground', () => {
    const m = move({ position: { x: 2, y: 3.6, z: 2 } });
    expect(codes(conflictsFor(m, 0, [m], twoMetres()))).toEqual(['floating']);
  });

  it('draws both lines to the centimetre: exactly on a tolerance is on the ground, one more is not', () => {
    // Over 2 m ground, 1.75 and 3.50 are still "resting on it"; 1.74 and 3.51 are not. A rule with `<=`, or
    // one comparing a rounded y, passes 1.7 / 3.6 above and is still wrong here.
    for (const y of [1.75, 3.5]) expect(conflictsFor(at(y), 0, [at(y)], twoMetres()), `y=${y}`).toEqual([]);
    expect(codes(conflictsFor(at(1.74), 0, [at(1.74)], twoMetres()))).toEqual(['underground']);
    expect(codes(conflictsFor(at(3.51), 0, [at(3.51)], twoMetres()))).toEqual(['floating']);
  });

  it('warns no-ground where the grid has no surface at all', () => {
    const m = move({ position: { x: 2, y: 2, z: 2 } });
    const c = ctx({ layout: layout(), ground: flatGround(NO_SAMPLE) });
    expect(codes(conflictsFor(m, 0, [m], c))).toEqual(['no-ground']);
  });

  it('warns no-ground inside the bounds but off the sampled grid', () => {
    // The one cell covers [0, 4]; x = 50 is well inside the ±100 bounds and has no sample under it.
    const m = move({ position: { x: 50, y: 2, z: 2 } });
    expect(codes(conflictsFor(m, 0, [m], twoMetres()))).toEqual(['no-ground']);
  });

  it('under a dome, measures against the deck an object would stand on, not the roof over it', () => {
    // Two layers per corner: layer 0 the roof at 5 m, layer 1 the deck at 2 m. `groundAt` takes, per corner,
    // the nearest layer at or below the entry's own y, and the lowest when nothing is below it.
    const heightsCm = encodeHeights(Int16Array.from([500, 200, 500, 200, 500, 200, 500, 200]));
    const dome = decodeGround({ originX: 0, originZ: 0, step: 4, nx: 2, nz: 2, layers: 2, heightsCm });
    const c = () => ctx({ layout: layout(), ground: dome });
    expect(conflictsFor(at(2.1), 0, [at(2.1)], c()), 'on the deck').toEqual([]);
    expect(conflictsFor(at(5.2), 0, [at(5.2)], c()), 'on the roof').toEqual([]);
    // Just under the roof is hovering over the deck, not "under" the roof.
    expect(codes(conflictsFor(at(4.9), 0, [at(4.9)], c()))).toEqual(['floating']);
    // Below every layer: under the deck.
    expect(codes(conflictsFor(at(1.5), 0, [at(1.5)], c()))).toEqual(['underground']);
  });

  it('checks a hidden move that carries a position: its colliders go there', () => {
    const m = move({ hidden: true, position: { x: 2, y: 1.7, z: 2 } });
    expect(codes(conflictsFor(m, 0, [m], twoMetres()))).toEqual(['underground']);
  });

  it('says nothing about the ground when the layout has no grid yet', () => {
    const m = move({ position: { x: 2, y: -50, z: 2 } });
    expect(conflictsFor(m, 0, [m], ctx({ layout: layout(), ground: null }))).toEqual([]);
  });

  it('says nothing about the ground without a layout, whatever grid is handed over', () => {
    // A grid without the layout it came from is not a context the callers build; the rule does not guess.
    const m = move({ position: { x: 2, y: -50, z: 2 } });
    expect(conflictsFor(m, 0, [m], ctx({ layout: null, ground: flatGround(200) }))).toEqual([]);
  });

  it('stops at out-of-bounds: a refused position does not also read as no-ground', () => {
    const m = move({ position: { x: 300, y: 2, z: 2 } });
    expect(codes(conflictsFor(m, 0, [m], twoMetres()))).toEqual(['out-of-bounds']);
  });

  it('are all warnings, so hasErrors stays false and the route still saves', () => {
    const elsewhere = move({ id: 'm2', target: { name: 'well' }, position: { x: 50, y: 2, z: 2 } });
    const all = conflictsForDocument([at(1.7), place({ position: { x: 2, y: 3.6, z: 2 } }), elsewhere], twoMetres());
    expect(all.map(codes)).toEqual([['underground'], ['floating'], ['no-ground']]);
    expect(all.flat().every((c) => c.level === 'warn')).toBe(true);
    expect(hasErrors(all)).toBe(false);
  });

  it('says in the detail how far under or over, to the millimetre', () => {
    // 2 − 1.7 is 0.30000000000000004 in a double; the row must not say so.
    expect(conflictsFor(at(1.7), 0, [at(1.7)], twoMetres())[0].detail).toMatch(/^bottom at y = 1\.7 is 0\.3 m under the ground at 2$/);
    expect(conflictsFor(at(3.6), 0, [at(3.6)], twoMetres())[0].detail).toMatch(/^bottom at y = 3\.6 is 1\.6 m above the ground at 2$/);
  });
});
