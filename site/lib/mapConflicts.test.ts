import { describe, it, expect, vi } from 'vitest';
import type { MoveEntry, OverlayEntry, PlaceEntry } from './mapOverlaySchema';
import { NO_SAMPLE, decodeGround, encodeHeights, type DecodedGround, type WorldLayout } from './mapLayout';
import { conflictContextFor, conflictsFor, conflictsForDocument, hasErrors, type Conflict, type ConflictContext } from './mapConflicts';

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
  // these two fixtures pin it through the overlap rule, the only reader of the occupants.

  it('lets a hidden move that still carries a position stand at that spot: its colliders go there', () => {
    const spot = { x: 50, y: 0, z: 50 };
    const beside = place({ position: spot });
    const stranger = move({ hidden: true, position: spot });
    const known = move({ hidden: true, position: spot, target: { name: 'crate' } });
    const world = () => ctx({ layout: layout(), objects: [crate] });
    const all = conflictsForDocument([stranger, beside], world());
    expect(all.map(codes)).toEqual([['stale-name', 'overlap'], ['overlap']]);
    expect(all[1][0].other).toBe('m1');
    expect(conflictsForDocument([known, beside], world()).map(codes)).toEqual([['overlap'], ['overlap']]);
  });

  it('leaves the reported object standing where it was when a hidden move has no position', () => {
    const gone = move({ hidden: true, position: null, target: { name: 'crate' } });
    const onCrate = place({ position: crate.position });
    const all = conflictsForDocument([gone, onCrate], ctx({ layout: layout(), objects: [crate] }));
    expect(all.map(codes)).toEqual([[], ['overlap']]);
    expect(all[1][0].other).toBe('crate');
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

  it('holds those lines over a ground that is not a round number', () => {
    // The 2 m ground above is exact in a double; most are not. Over 0.08 m, `g − 0.25` is −0.17000000000000004,
    // so a bottom at exactly −0.17 read as underground; over 0.36 m, `g + 1.5` is 1.8599999999999999, so 1.86
    // read as floating. A sweep of every integer-centimetre ground in ±50 m found 77 such undergrounds and 316
    // such floatings. The data is in millimetres (the schema rounds to three places), so the rule compares in
    // millimetres, and these two grounds are the ones that exposed it.
    const eightCm = () => ctx({ layout: layout(), ground: flatGround(8) });
    expect(conflictsFor(at(-0.17), 0, [at(-0.17)], eightCm())).toEqual([]);
    expect(codes(conflictsFor(at(-0.171), 0, [at(-0.171)], eightCm()))).toEqual(['underground']);
    const thirtySixCm = () => ctx({ layout: layout(), ground: flatGround(36) });
    expect(conflictsFor(at(1.86), 0, [at(1.86)], thirtySixCm())).toEqual([]);
    expect(codes(conflictsFor(at(1.861), 0, [at(1.861)], thirtySixCm()))).toEqual(['floating']);
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
    // The place stands in the same ground cell as the move but clear of it, so only the ground rules speak.
    const all = conflictsForDocument([at(1.7), place({ position: { x: 3.5, y: 3.6, z: 3.5 } }), elsewhere], twoMetres());
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

describe('overlap, against the layout composed with the document', () => {
  const withLayout = (objects: ConflictContext['objects'] = []) => ctx({ layout: layout(), objects });
  const at = (x: number, z: number) => ({ x, y: 2, z });
  // A second move needs its own target, or duplicate-target fires as well and
  // the exact-list assertions below would be testing two rules at once.
  const silo = { name: 'silo' };
  const overlapWith = (other: string) => expect.objectContaining({ level: 'warn', code: 'overlap', other });

  it('warns two points closer than a metre, naming each other, and not at exactly a metre', () => {
    const near = [move({ id: 'a', position: at(0, 0) }), move({ id: 'b', target: silo, position: at(0.5, 0) })];
    expect(conflictsForDocument(near, withLayout())).toEqual([[overlapWith('b')], [overlapWith('a')]]);
    const apart = [move({ id: 'a', position: at(0, 0) }), move({ id: 'b', target: silo, position: at(1, 0) })];
    expect(conflictsForDocument(apart, withLayout())).toEqual([[], []]);
  });

  it('does not look for overlaps when there is no layout', () => {
    const near = [move({ id: 'a', position: at(0, 0) }), move({ id: 'b', target: silo, position: at(0.5, 0) })];
    expect(conflictsForDocument(near, ctx())).toEqual([[], []]);
  });

  it('warns a move that lands on a reported object, naming the object', () => {
    const farCrate = { name: 'crate', position: { x: 10, y: 0, z: 10 } };
    const roof = { name: 'barn.roof', position: { x: 0, y: 0, z: 0 } };
    const m = move({ position: at(10.4, 10) });
    expect(conflictsFor(m, 0, [m], withLayout([farCrate, roof]))).toEqual([overlapWith('crate')]);
  });

  it('does not overlap a moved object with its own old position', () => {
    const roof = { name: 'barn.roof', position: { x: 2, y: 2, z: 2 } };
    const m = move({ position: at(2.3, 2) });
    expect(conflictsFor(m, 0, [m], withLayout([roof]))).toEqual([]);
  });

  it('keeps an object the document hides in place as an occupant: its colliders stay where the game put them', () => {
    // The task text had this hide "occupying nothing"; the game's `_applyMove` disagrees (see the header and the
    // `occupancy` cases), and a barrel placed on an invisible crate is a barrel nobody can walk up to.
    const farCrate = { name: 'crate', position: { x: 10, y: 0, z: 10 } };
    const hide = move({ id: 'h', target: { name: 'crate' }, position: null, hidden: true });
    expect(conflictsForDocument([hide, place({ position: at(10, 10) })], withLayout([farCrate]))).toEqual([[], [overlapWith('crate')]]);
  });

  it('tests a placement as a footprint: a point within half a metre of its rect overlaps', () => {
    const p = place({ position: at(2, 2) });
    const inside = move({ id: 'in', position: at(2.9, 2) });
    // 4 is past the grown rect (x < 3) and 1.1 m from `inside`, so the two points do not meet either.
    const outside = move({ id: 'out', target: silo, position: at(4, 2) });
    expect(conflictsForDocument([p, inside, outside], withLayout())).toEqual([[overlapWith('in')], [overlapWith('p1')], []]);
  });

  it('consults placeFootprint for the size', () => {
    const p = place({ position: at(2, 2) });
    const m = move({ position: at(4.4, 2) });
    expect(conflictsForDocument([p, m], withLayout())).toEqual([[], []]);
    const wide = { ...withLayout(), placeFootprint: () => ({ w: 4, d: 4, h: 1 }) };
    expect(codes(conflictsForDocument([p, m], wide)[1])).toEqual(['overlap']);
  });

  it('intersects two placement rects, and never conflicts an entry with itself', () => {
    const a = place({ id: 'a', position: at(2, 2) });
    expect(conflictsForDocument([a], withLayout())).toEqual([[]]);
    const touching = place({ id: 'b', position: at(2.8, 2) });
    expect(codes(conflictsForDocument([a, touching], withLayout())[0])).toEqual(['overlap']);
    const clear = place({ id: 'b', position: at(3.2, 2) });
    expect(conflictsForDocument([a, clear], withLayout())).toEqual([[], []]);
  });
});

describe('overlap: the last move wins, whole millimetres, and the bucket grid', () => {
  const withLayout = (objects: ConflictContext['objects'] = []) => ctx({ layout: layout(), objects });
  const at = (x: number, z: number) => ({ x, y: 2, z });
  const silo = { name: 'silo' };
  const overlapWith = (other: string) => expect.objectContaining({ level: 'warn', code: 'overlap', other });

  it('lets only the last move of an object occupy: the game applies a document in order', () => {
    const first = move({ id: 'first', target: { name: 'crate' }, position: at(0, 0) });
    const last = move({ id: 'last', target: { name: 'crate' }, position: at(20, 20) });
    const byFirst = place({ id: 'byFirst', position: at(0.3, 0) });
    const byLast = place({ id: 'byLast', position: at(20.3, 20) });
    const all = conflictsForDocument([first, last, byFirst, byLast], withLayout([crate]));
    // `first` is superseded: it is not an occupant and stands nowhere, so it is not tested for overlap either.
    expect(all.map(codes)).toEqual([['duplicate-target'], ['duplicate-target', 'overlap'], [], ['overlap']]);
    expect(all[1][1].other).toBe('byLast');
    expect(all[3][0].other).toBe('last');
  });

  it('measures in whole millimetres, so exactly a metre apart is not an overlap at any position', () => {
    // In doubles 1.13 - 0.13 is 0.9999999999999999, and so is hypot(0.62 - 0.02, 0.82 - 0.02); a sweep of
    // centimetre positions found 280 of 10 001 such false hits along an axis and 2 434 of 5 001 on a 3-4-5
    // diagonal. The data never had more than millimetres in it.
    const a = move({ id: 'a', position: at(0.13, 0) });
    const b = move({ id: 'b', target: silo, position: at(1.13, 0) });
    expect(conflictsForDocument([a, b], withLayout())).toEqual([[], []]);
    const c = move({ id: 'c', position: at(0.02, 0.02) });
    const d = move({ id: 'd', target: silo, position: at(0.62, 0.82) });
    expect(conflictsForDocument([c, d], withLayout())).toEqual([[], []]);
    // One millimetre closer on the diagonal and they meet.
    const e = move({ id: 'e', target: silo, position: at(0.62, 0.819) });
    expect(conflictsForDocument([c, e], withLayout()).map(codes)).toEqual([['overlap'], ['overlap']]);
    // A footprint's grown edge exactly a metre from a point (0.14 + 0.5 + 0.5 is 1.1400000000000001 in a double)...
    const p = place({ position: at(0.14, 0) });
    const q = move({ id: 'q', position: at(1.14, 0) });
    expect(conflictsForDocument([p, q], withLayout())).toEqual([[], []]);
    // ...and two footprints whose edges exactly touch.
    const r = place({ id: 'r', position: at(0.13, 0) });
    const s = place({ id: 's', position: at(1.13, 0) });
    expect(conflictsForDocument([r, s], withLayout())).toEqual([[], []]);
  });

  it('finds a neighbour across a cell boundary, and a footprint from any cell it covers', () => {
    // Cells are 4 m wide: 3.9 and 4.1 sit in different cells, 0.2 m apart.
    const a = move({ id: 'a', position: at(3.9, 0) });
    const b = move({ id: 'b', target: silo, position: at(4.1, 0) });
    expect(conflictsForDocument([a, b], withLayout())).toEqual([[overlapWith('b')], [overlapWith('a')]]);
    // A footprint straddling the boundary (3.5 to 4.5) is met from either side of it.
    const p = place({ position: at(4, 0) });
    const left = move({ id: 'left', position: at(3.2, 0) });
    const right = move({ id: 'right', target: silo, position: at(4.8, 0) });
    expect(conflictsForDocument([p, left, right], withLayout())).toEqual([
      [overlapWith('left'), overlapWith('right')], [overlapWith('p1')], [overlapWith('p1')],
    ]);
    // A 12 m footprint covers four cells; a point over its far edge, a cell away from its anchor, still meets it.
    const wide = { ...withLayout(), placeFootprint: () => ({ w: 12, d: 12, h: 1 }) };
    const big = place({ position: at(0, 0) });
    const edge = move({ id: 'edge', position: at(6.4, 0) });
    expect(conflictsForDocument([big, edge], wide)).toEqual([[overlapWith('edge')], [overlapWith('p1')]]);
    // And a pair in cells that do not touch does not meet.
    const far = move({ id: 'far', target: silo, position: at(40, 40) });
    expect(conflictsForDocument([a, far], withLayout())).toEqual([[], []]);
  });

  it('is a warning, so hasErrors stays false and the route still saves', () => {
    const roof = { name: 'barn.roof', position: { x: 50, y: 0, z: 50 } };
    const all = conflictsForDocument([move({ position: at(0.2, 0) })], withLayout([crate, roof]));
    expect(all.map(codes)).toEqual([['overlap']]);
    expect(all[0][0].level).toBe('warn');
    expect(hasErrors(all)).toBe(false);
  });

  it('gives a superseded move the bounds rule but not the ground or overlap rules: it stands nowhere', () => {
    // Four samples 4 m apart from (0,0), one cell over [0, 4] at 2 m: `first` is 0.3 m under it, and would
    // read as underground if it were tested. It is not — the later move is where the crate ends up — but a
    // coordinate outside the world is refused whether or not the entry is inert, or an out-of-bounds move
    // would save the moment a second move of the same object followed it.
    const heightsCm = encodeHeights(Int16Array.from([200, 200, 200, 200]));
    const ground = decodeGround({ originX: 0, originZ: 0, step: 4, nx: 2, nz: 2, layers: 1, heightsCm });
    const c = () => ({ ...withLayout([crate]), ground });
    const first = move({ id: 'first', target: { name: 'crate' }, position: { x: 2, y: 1.7, z: 2 } });
    const last = move({ id: 'last', target: { name: 'crate' }, position: { x: 50, y: 2, z: 50 } });
    // `beside` stands 0.3 m from where `first` would be: no overlap, because `first` is not an occupant, and the
    // crate itself is gone from (0, 0) because `last` moved it.
    const beside = place({ id: 'beside', position: { x: 2.3, y: 2, z: 2 } });
    expect(conflictsForDocument([first, last, beside], c()).map(codes)).toEqual([
      ['duplicate-target'], ['duplicate-target', 'no-ground'], [],
    ]);
    const far = move({ id: 'first', target: { name: 'crate' }, position: { x: 300, y: 1.7, z: 2 } });
    expect(conflictsForDocument([far, last], c()).map(codes)).toEqual([['duplicate-target', 'out-of-bounds'], ['duplicate-target', 'no-ground']]);
  });

  it('cannot be made to hang: an absurd footprint falls back to the default and an unplaceable coordinate stands nowhere', () => {
    // The editor path hands over raw floats, and a footprint's cost is its area in cells; the grid must answer
    // in bounded time for ANY input. `mm(1e308)` is Infinity and a cell loop from −Infinity never ends;
    // `mm(1e20)` is a finite 1e23, but past 2^53 `cx++` no longer changes `cx` and the loop never ends either.
    const p = place({ position: at(2, 2) });
    const inside = move({ id: 'in', position: at(2.9, 2) });
    const outside = move({ id: 'out', target: silo, position: at(4, 2) });
    const absurd = { ...withLayout(), placeFootprint: () => ({ w: Infinity, d: NaN, h: 1 }) };
    expect(conflictsForDocument([p, inside, outside], absurd)).toEqual([[overlapWith('in')], [overlapWith('p1')], []]);
    const negative = { ...withLayout(), placeFootprint: () => ({ w: -5, d: 500, h: 1 }) };
    expect(conflictsForDocument([p, inside, outside], negative)).toEqual([[overlapWith('in')], [overlapWith('p1')], []]);
    // A hundred metres is the widest a placed item can claim; exactly that is still honoured.
    const wide = { ...withLayout(), placeFootprint: () => ({ w: 100, d: 100, h: 1 }) };
    expect(codes(conflictsForDocument([p, outside], wide)[1])).toEqual(['overlap']);

    for (const huge of [1e308, 1e20, -1e20]) {
      const m = move({ id: 'huge', position: at(huge, 0) });
      const q = place({ id: 'q', position: at(huge, 0) });
      // Bounds still refuse it — that rule reads the position, not the grid — and nothing else is said.
      expect(conflictsForDocument([m, q], withLayout()).map(codes), `entries at ${huge}`).toEqual([['out-of-bounds'], ['out-of-bounds']]);
      // A reported object the grid cannot place is skipped too; the roof is here so `near` has a real target.
      const reported = { name: 'far', position: { x: huge, y: 0, z: 0 } };
      const roof = { name: 'barn.roof', position: { x: 50, y: 0, z: 50 } };
      const near = move({ id: 'near', position: at(0, 0) });
      expect(conflictsForDocument([near], withLayout([reported, roof])), `object at ${huge}`).toEqual([[]]);
    }
  });

  it('agrees with a pairwise scan at the caps chunks 4-6 drag at, 2 000 objects and 500 entries, in a frame', () => {
    // A deterministic scatter (mulberry32) over the whole world, positions to the millimetre like the schema's.
    let seed = 0x9e3779b9;
    const rand = () => {
      seed = (seed + 0x6d2b79f5) | 0;
      let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    const coord = () => Math.round((rand() * 200 - 100) * 1000) / 1000;
    const objects = Array.from({ length: 2000 }, (_, i) => ({ name: `o${i}`, position: { x: coord(), y: 0, z: coord() } }));
    const entries: OverlayEntry[] = Array.from({ length: 500 }, (_, i) =>
      i % 2 === 0
        ? move({ id: `e${i}`, target: { name: `o${i}` }, position: { x: coord(), y: 2, z: coord() } })
        : place({ id: `e${i}`, position: { x: coord(), y: 2, z: coord() } }));
    const sizes = [1, 2, 3, 5, 9];
    const footprint = (e: PlaceEntry) => { const s = sizes[Number(e.id.slice(1)) % sizes.length]; return { w: s, d: s, h: 1 }; };
    // A real flat deck at 2 m over the whole ±100 m bounds, 51 samples an axis 4 m apart, so the timed run
    // below measures what the editor does on a drag: the grid AND a ground lookup for every entry.
    const deck = { originX: -100, originZ: -100, step: 4, nx: 51, nz: 51, layers: 1, heightsCm: encodeHeights(new Int16Array(51 * 51).fill(200)) };
    const c = conflictContextFor(layout({ ground: deck }), objects, footprint);
    expect(c.ground).not.toBeNull();

    const all = conflictsForDocument(entries, c);
    // Every entry is in bounds, on the deck, and moves a name that was reported: only overlaps can speak.
    expect(all.flat().every((x) => x.code === 'overlap')).toBe(true);

    // The reference: the same composition and the same millimetre geometry, every entry against every occupant.
    // It deliberately omits last-move-wins — no two entries here move the same name — which is pinned separately above.
    type Occ = { label: string; x: number; z: number; rect: { minX: number; maxX: number; minZ: number; maxZ: number } | null };
    const mm = (m: number) => Math.round(m * 1000);
    const moved = new Set(entries.flatMap((e) => (e.kind === 'move' && e.position ? [e.target.name] : [])));
    const occ: Occ[] = objects.filter((o) => !moved.has(o.name)).map((o) => ({ label: o.name, x: mm(o.position.x), z: mm(o.position.z), rect: null }));
    const byEntry = new Map<number, Occ>();
    entries.forEach((e, i) => {
      if (!e.position) return;
      const { x, z } = e.position;
      let rect: Occ['rect'] = null;
      if (e.kind === 'place') {
        const { w, d } = footprint(e);
        rect = { minX: mm(x - w / 2), maxX: mm(x + w / 2), minZ: mm(z - d / 2), maxZ: mm(z + d / 2) };
      }
      const o: Occ = { label: e.id, x: mm(x), z: mm(z), rect };
      occ.push(o);
      byEntry.set(i, o);
    });
    const inRect = (x: number, z: number, r: NonNullable<Occ['rect']>) => x > r.minX - 500 && x < r.maxX + 500 && z > r.minZ - 500 && z < r.maxZ + 500;
    const meet = (a: Occ, b: Occ) => {
      if (a.rect && b.rect) return a.rect.minX < b.rect.maxX && a.rect.maxX > b.rect.minX && a.rect.minZ < b.rect.maxZ && a.rect.maxZ > b.rect.minZ;
      if (a.rect) return inRect(b.x, b.z, a.rect);
      if (b.rect) return inRect(a.x, a.z, b.rect);
      return (a.x - b.x) ** 2 + (a.z - b.z) ** 2 < 1_000_000;
    };
    const expected = entries.map((_, i) => { const self = byEntry.get(i)!; return occ.filter((o) => o !== self && meet(self, o)).map((o) => o.label); });
    expect(all.map((cs) => cs.map((x) => x.other))).toEqual(expected);
    // Not vacuous: the scatter is dense enough that hundreds of pairs meet.
    expect(expected.flat().length).toBeGreaterThan(200);

    // A catastrophe bound — an O(n²) allocation blow-up; NOT a degenerate-grid detector (a single-cell grid
    // measured ~15 ms here, well under it); the pairwise oracle above is the correctness gate. A median of
    // about 1.5 ms on the machine that wrote this.
    const times: number[] = [];
    for (let i = 0; i < 10; i++) { const t0 = performance.now(); conflictsForDocument(entries, c); times.push(performance.now() - t0); }
    times.sort((x, y) => x - y);
    expect(times[5], `median ms over 10 runs: ${times[5].toFixed(2)}`).toBeLessThan(100);
  });
});

describe('conflictContextFor, the one way a context is built', () => {
  // The route and the editor panel build their context through this so the two can never disagree about a
  // grid: decoded once, and a grid that will not decode is a warning in the log and `ground: null`, never a
  // throw — the bounds rule, the one that refuses, needs no grid.
  const deck = { originX: -10, originZ: -10, step: 4, nx: 6, nz: 6, layers: 1, heightsCm: encodeHeights(new Int16Array(36)) };

  it('decodes a valid ground once and keeps the layout, the objects and the footprint callback', () => {
    const l = layout({ ground: deck });
    const footprint = () => ({ w: 2, d: 2, h: 1 });
    const c = conflictContextFor(l, [crate], footprint);
    expect(c.layout).toBe(l);
    expect(c.objects).toEqual([crate]);
    expect(c.placeFootprint).toBe(footprint);
    expect(c.ground).toEqual(decodeGround(deck));
    expect(conflictContextFor(l, [])).not.toHaveProperty('placeFootprint');
  });

  it('degrades a ground that will not decode to no grid, keeps the bounds, and warns once', () => {
    // `validateGround` decodes on the way in and `readWorldReport` validates again on the way out, so a row
    // from the store cannot reach here undecodable today; the helper does not know its caller.
    const corrupt = { ...deck, heightsCm: encodeHeights(new Int16Array(3)) };
    const warned = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const c = conflictContextFor(layout({ ground: corrupt }), []);
      expect(c.ground).toBeNull();
      expect(c.layout?.bounds).toEqual(layout().bounds);
      expect(warned).toHaveBeenCalledTimes(1);
      expect(String(warned.mock.calls[0][0])).toMatch(/^\[map-conflicts\] stored ground did not decode/);
      // Bounds-only still refuses, and says nothing about the ground it cannot see.
      const under = move({ position: { x: 2, y: -50, z: 2 } });
      const out = move({ id: 'o', target: { name: 'silo' }, position: { x: 300, y: 2, z: 2 } });
      expect(conflictsForDocument([under, out], c).map(codes)).toEqual([[], ['out-of-bounds']]);
    } finally {
      warned.mockRestore();
    }
  });

  it('builds an empty context for a world with no layout yet', () => {
    expect(conflictContextFor(null, [])).toEqual({ layout: null, ground: null, objects: [] });
    expect(conflictContextFor(layout(), [crate])).toEqual({ layout: layout(), ground: null, objects: [crate] });
  });
});
