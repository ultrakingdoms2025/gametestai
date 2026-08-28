/**
 * THE CLAIM: the editor's snapping, row text, selection mapping and move
 * upsert are exactly what spec §8 says, computed against real `groundAt`.
 *
 * Not a stub because the ground is a real `DecodedGround` (a 3×3 grid whose
 * top surface is a plane rising 1 m per 4 m in x) and `snappedY` is checked
 * against the closed-form answer on that plane, sink included: a prop
 * authored 0.5 m ABOVE its ground stays 0.5 m above the ground it is dragged
 * to. Null handling is asserted on a NO_SAMPLE grid, not on a mocked
 * `groundAt`. Row text is asserted character-for-character because the e2e
 * harness in chunk 7 greps for it. The canvas's marks (`hitCandidates`) and
 * hover text (`hoverInfoFor`) are asserted as whole values, so which marks a
 * click can reach is pinned here and not in an untestable component. The
 * panel's ground readout (`groundStatus`) is pinned at the millimetre on the
 * 0.08 m ground that exposed a float comparison, and the last-move rule is
 * asserted across `moveEntryFor`, `selectedEntry`, `selectedPosition`,
 * `hitCandidates` and `upsertMoveFor` together, so the map, the panel and a
 * drag cannot disagree about which of two moves for one name is the one.
 * `authoredLift` is asserted as the term BOTH a drag (`snappedY`) and the
 * layer picker (`h + lift`) add, on the same slope, so the two cannot
 * disagree either; and `canonicalSelection` is pinned in both directions,
 * so a row click and a mark click on one move land on one selection.
 * `placementY` is pinned on two two-layer cells holding the same surfaces in
 * opposite byte orders, so "the lowest surface" is asserted independently of
 * how `layersAt` happens to order them. What the untestable components read
 * off this module for a remove is pinned as data: the removed mark is the
 * only non-draggable one (`hitCandidates`), a REMOVE row's colour is its own
 * (`KIND_COLOUR`), and the report card's two remove warnings — nothing
 * dropped, too much dropped — are `removeWarnings` on the applier's own
 * `colliders` count.
 */
import { describe, expect, it } from 'vitest';
import { NO_SAMPLE, decodeGround, encodeHeights, groundAt, layersAt, type DecodedGround } from './mapLayout';
import type { Conflict } from './mapConflicts';
import { targetLabel, type MoveEntry } from './mapOverlaySchema';
import { KIND_COLOUR, moveColour, placeColour, removeColour } from '@/components/mapEditorStyles';
import {
  NO_LAYOUT_TEXT,
  WIDE_REMOVE_COLLIDERS,
  actionEntryFor,
  authoredLift,
  canonicalSelection,
  degToRad,
  fmt,
  groundStatus,
  hitCandidates,
  hoverInfoFor,
  layoutAgeText,
  moveEntryFor,
  pendingRows,
  placeAt,
  placementY,
  radToDeg,
  removeFor,
  removeWarnings,
  rowLevel,
  selectedEntry,
  selectedPosition,
  selectionFromKey,
  selectionKey,
  snappedY,
  unresolvedText,
  upsertMoveFor,
  type Draft,
  type Selected,
} from './mapEditorState';

/**
 * 3×3 samples, step 4, one layer, heights in cm = 100·i (a plane rising east),
 * pushed through chunk 2's encode → decode so the bytes the game would send
 * are what `snappedY` reads, not a hand-built typed array.
 */
function slope(): DecodedGround {
  const nx = 3, nz = 3, layers = 1;
  const heights = new Int16Array(nx * nz * layers);
  for (let j = 0; j < nz; j++) for (let i = 0; i < nx; i++) heights[(j * nx + i) * layers] = 100 * i;
  return decodeGround({ originX: 0, originZ: 0, step: 4, nx, nz, layers, heightsCm: encodeHeights(heights) });
}

let n = 0;
const mint = () => `k${++n}`;

describe('degrees and radians', () => {
  it('90° is π/2 and the pair round-trips', () => {
    expect(degToRad(90)).toBeCloseTo(Math.PI / 2, 12);
    expect(radToDeg(Math.PI / 2)).toBeCloseTo(90, 12);
    expect(radToDeg(degToRad(37.5))).toBeCloseTo(37.5, 12);
  });
});

describe('snappedY', () => {
  it('is the ground at the destination plus the authored sink or lift', () => {
    const g = slope();
    // at x=0 the ground is 0 m; the prop sits at y=0.5 → lift 0.5
    expect(snappedY(g, { x: 0, y: 0.5, z: 0 }, 4, 0)).toBeCloseTo(1.5, 9); // ground at x=4 is 1 m
    // a half-buried rock stays half-buried
    expect(snappedY(g, { x: 4, y: 0.6, z: 4 }, 8, 4)).toBeCloseTo(1.6, 9);
  });
  it('is bilinear between samples', () => {
    expect(snappedY(slope(), { x: 0, y: 0, z: 0 }, 2, 2)).toBeCloseTo(0.5, 9);
  });
  it('is null without ground, and null when either end has no sample', () => {
    expect(snappedY(null, { x: 0, y: 0, z: 0 }, 1, 1)).toBeNull();
    const g = slope();
    g.heights.fill(NO_SAMPLE);
    expect(snappedY(g, { x: 0, y: 0, z: 0 }, 4, 0)).toBeNull();
    // Only the east column (i = 2) is unsampled: the rest of the grid still answers …
    const holed = slope();
    for (let j = 0; j < 3; j++) holed.heights[j * 3 + 2] = NO_SAMPLE;
    expect(snappedY(holed, { x: 0, y: 0, z: 0 }, 2, 0)).toBeCloseTo(0.5, 9);
    // … but a destination on the hole is null, and so is a source on it.
    expect(snappedY(holed, { x: 0, y: 0, z: 0 }, 8, 0)).toBeNull();
    expect(snappedY(holed, { x: 8, y: 0, z: 0 }, 0, 0)).toBeNull();
  });
});

describe('authoredLift', () => {
  it('is the one term both callers add: a drag through snappedY, the layer picker through h + lift', () => {
    const g = slope();
    const from = { x: 0, y: 0.5, z: 0 };
    expect(authoredLift(g, from)).toBeCloseTo(0.5, 9);
    // a half-buried rock has a negative lift
    expect(authoredLift(g, { x: 4, y: 0.6, z: 4 })).toBeCloseTo(-0.4, 9);
    const lift = authoredLift(g, from)!;
    // the drag: the destination's surface plus the lift …
    const dragged = snappedY(g, from, 4, 0)!;
    expect(dragged).toBeCloseTo(groundAt(g, 4, 0, from.y)! + lift, 12);
    // … and the picker, choosing the top surface at that destination, adds the same lift and lands on the same Y
    const [top] = layersAt(g, 4, 0);
    expect(top + lift).toBeCloseTo(dragged, 12);
    expect(dragged).toBeCloseTo(1.5, 9);
  });
  it('is null, not zero, where the current position has no sample — and so is a snap from there', () => {
    const holed = slope();
    for (let j = 0; j < 3; j++) holed.heights[j * 3 + 2] = NO_SAMPLE;
    expect(authoredLift(holed, { x: 8, y: 0, z: 0 })).toBeNull();
    expect(snappedY(holed, { x: 8, y: 0, z: 0 }, 0, 0)).toBeNull();
    expect(authoredLift(null, { x: 0, y: 0, z: 0 })).toBeNull();
  });
});

describe('layoutAgeText', () => {
  const now = new Date('2026-08-27T12:00:00Z');
  it('reads as the spec banner', () => {
    expect(layoutAgeText(null, now)).toBe(NO_LAYOUT_TEXT);
    expect(NO_LAYOUT_TEXT).toBe('No layout yet — enter this world in game as admin');
    expect(layoutAgeText('2026-08-27T11:59:30Z', now)).toBe('reported just now');
    expect(layoutAgeText('2026-08-27T11:57:00Z', now)).toBe('reported 3 min ago');
    expect(layoutAgeText('2026-08-27T10:00:00Z', now)).toBe('reported 2 h ago');
    expect(layoutAgeText('2026-08-24T12:00:00Z', now)).toBe('reported 3 d ago');
  });
  it('treats an unparsable stamp as no layout', () => {
    expect(layoutAgeText('yesterday', now)).toBe(NO_LAYOUT_TEXT);
  });
  it('is pinned at every threshold, and a future stamp reads as just now', () => {
    expect(layoutAgeText('2026-08-27T11:59:00.100Z', now)).toBe('reported just now'); // 59.9 s
    expect(layoutAgeText('2026-08-27T11:59:00Z', now)).toBe('reported 1 min ago'); // 60 s
    expect(layoutAgeText('2026-08-27T11:00:01Z', now)).toBe('reported 59 min ago'); // 3599 s
    expect(layoutAgeText('2026-08-27T11:00:00Z', now)).toBe('reported 1 h ago'); // 3600 s
    expect(layoutAgeText('2026-08-26T12:00:01Z', now)).toBe('reported 23 h ago'); // 86399 s
    expect(layoutAgeText('2026-08-26T11:00:00Z', now)).toBe('reported 1 d ago'); // 90 000 s
    // A clock ahead of the server's must not print a negative age.
    expect(layoutAgeText('2026-08-27T13:00:00Z', now)).toBe('reported just now');
  });
});

describe('fmt', () => {
  it('prints one decimal, the way the mock does', () => {
    expect(fmt(12.3)).toBe('12.3');
    expect(fmt(-40.1)).toBe('-40.1');
    expect(fmt(3)).toBe('3.0');
    expect(fmt(3.25)).toBe('3.3');
  });
});

describe('rowLevel and pendingRows', () => {
  const warn: Conflict = { level: 'warn', code: 'underground', detail: 'bottom 1.2 m below ground' };
  const err: Conflict = { level: 'error', code: 'out-of-bounds', detail: 'x 900 outside bounds' };
  const entries: Draft[] = [
    { _key: 'a', kind: 'move', id: 'a', target: { name: 'medieval:house' }, position: { x: 12.3, y: 3.2, z: -40.1 }, rotationY: Math.PI / 2 },
    { _key: 'b', kind: 'remove', id: 'b', target: { name: 'station:crate' } },
    { _key: 'c', kind: 'place', id: 'c', item: { source_key: 'loot', name: 'Loot Crate', config: {} }, position: { x: 1, y: 2, z: 3 }, quantity: 2 },
  ];
  it('the worst conflict sets the level', () => {
    expect(rowLevel([])).toBe('ok');
    expect(rowLevel([warn])).toBe('warn');
    expect(rowLevel([warn, err])).toBe('error');
  });
  it('rows carry the exact text the list and the e2e harness read', () => {
    const rows = pendingRows(entries, [[warn], [], [err, warn]]);
    expect(rows).toHaveLength(3);
    expect(rows[0]).toMatchObject({ key: 'a', kind: 'move', label: 'medieval:house', summary: '→ (12.3, 3.2, -40.1) yaw 90°', level: 'warn' });
    expect(rows[1]).toMatchObject({ key: 'b', kind: 'remove', label: 'station:crate', summary: 'removed', level: 'ok' });
    expect(rows[2]).toMatchObject({ key: 'c', kind: 'place', label: 'Loot Crate ×2', summary: '→ (1.0, 2.0, 3.0)', level: 'error' });
    expect(rows[2].conflicts).toEqual([err, warn]);
  });
  it('tolerates a conflicts array shorter than the document', () => {
    expect(pendingRows(entries, [])[2].level).toBe('ok');
  });
  it('a remove of an {id} target is labelled by the id', () => {
    const only: Draft[] = [{ _key: 'd', kind: 'remove', id: 'd', target: { id: 'medieval:house@1.0,2.0' } }];
    expect(pendingRows(only, [])[0]).toMatchObject({ kind: 'remove', label: 'medieval:house@1.0,2.0', summary: 'removed' });
  });
  it('every row kind has its own colour, and a REMOVE row is not painted as a placement', () => {
    // The list's first version read `kind === 'move' ? move : place`, so a REMOVE row wore the placement colour.
    expect(Object.keys(KIND_COLOUR).sort()).toEqual(['move', 'place', 'remove']);
    expect(KIND_COLOUR).toEqual({ move: moveColour, remove: removeColour, place: placeColour });
    expect(new Set(Object.values(KIND_COLOUR)).size).toBe(3);
    for (const r of pendingRows(entries, [])) expect(KIND_COLOUR[r.kind]).toBeTypeOf('string');
  });
});

describe('upsertMoveFor', () => {
  it('adds one move entry for a name, then updates that same entry', () => {
    const one = upsertMoveFor([], 'a:b', { x: 1, y: 2, z: 3 }, undefined, mint);
    expect(one).toHaveLength(1);
    expect(one[0]).toMatchObject({ kind: 'move', target: { name: 'a:b' }, position: { x: 1, y: 2, z: 3 } });
    expect((one[0] as Draft & MoveEntry).rotationY).toBeUndefined();
    const two = upsertMoveFor(one, 'a:b', { x: 9, y: 8, z: 7 }, 1.5, mint);
    expect(two).toHaveLength(1);
    expect(two[0]._key).toBe(one[0]._key);
    expect(two[0].id).toBe(one[0].id);
    expect(two[0]).toMatchObject({ position: { x: 9, y: 8, z: 7 }, rotationY: 1.5 });
  });
  it('leaves other entries and their order alone', () => {
    const base = upsertMoveFor(upsertMoveFor([], 'x', { x: 0, y: 0, z: 0 }, undefined, mint), 'y', { x: 1, y: 1, z: 1 }, undefined, mint);
    const out = upsertMoveFor(base, 'x', { x: 5, y: 5, z: 5 }, undefined, mint);
    expect(out.map((e) => (e.kind === 'move' ? targetLabel(e.target) : ''))).toEqual(['x', 'y']);
    expect(out[1]).toBe(base[1]);
  });
  it('Move here on a removed name replaces the remove with a move, under its key and id', () => {
    const gone: Draft[] = [{ _key: 'h', kind: 'remove', id: 'h', target: { name: 'q' } }];
    expect(upsertMoveFor(gone, 'q', { x: 1, y: 1, z: 1 }, undefined, mint)).toEqual([
      { _key: 'h', kind: 'move', id: 'h', target: { name: 'q' }, position: { x: 1, y: 1, z: 1 } },
    ]);
  });
  it("rotationY undefined CLEARS an existing rotation; a caller passes the entry's own to keep it", () => {
    const turned = upsertMoveFor([], 'r', { x: 0, y: 0, z: 0 }, 1.5, mint);
    const yawOf = (list: Draft[]) => (list[0] as Draft & MoveEntry).rotationY;
    expect(yawOf(upsertMoveFor(turned, 'r', { x: 1, y: 0, z: 0 }, undefined, mint))).toBeUndefined();
    expect(yawOf(upsertMoveFor(turned, 'r', { x: 1, y: 0, z: 0 }, yawOf(turned), mint))).toBe(1.5);
  });
  it('stores a copy of the position, as placeAt copies its config', () => {
    const position = { x: 1, y: 2, z: 3 };
    const added = upsertMoveFor([], 'c', position, undefined, mint);
    const positionOf = (list: Draft[]) => (list[0] as Draft & MoveEntry).position;
    expect(positionOf(added)).toEqual(position);
    expect(positionOf(added)).not.toBe(position);
    const updated = upsertMoveFor(added, 'c', position, undefined, mint);
    expect(positionOf(updated)).not.toBe(position);
  });
});

describe('removeFor and actionEntryFor', () => {
  const mv = (key: string, name: string): Draft => ({ _key: key, kind: 'move', id: key, target: { name }, position: { x: 1, y: 2, z: 3 } });
  const rm = (key: string, name: string): Draft => ({ _key: key, kind: 'remove', id: key, target: { name } });
  const pl: Draft = { _key: 'p', kind: 'place', id: 'p', item: { source_key: 's', name: 'S', config: {} }, position: { x: 4, y: 5, z: 6 }, quantity: 1 };

  it('appends one remove for a name nothing acts on, keyed as its id', () => {
    const out = removeFor([pl], 'x', mint);
    expect(out).toHaveLength(2);
    expect(out[1]).toMatchObject({ kind: 'remove', target: { name: 'x' } });
    expect(out[1]._key).toBe(out[1].id);
  });
  it('replaces the move of a name with a remove under the same key and id, leaving the rest alone', () => {
    expect(removeFor([mv('a', 'x'), pl, mv('b', 'y')], 'x', mint)).toEqual([rm('a', 'x'), pl, mv('b', 'y')]);
  });
  it('is a fixed point on a name already removed, and drops an earlier duplicate action on the name', () => {
    expect(removeFor([rm('a', 'x')], 'x', mint)).toEqual([rm('a', 'x')]);
    expect(removeFor([mv('a', 'x'), pl, mv('b', 'x')], 'x', mint)).toEqual([pl, rm('b', 'x')]);
  });
  it('actionEntryFor is the LAST move-or-remove of a name; moveEntryFor answers only when that action is a move', () => {
    const doc = [mv('a', 'x'), rm('b', 'x'), mv('c', 'y')];
    expect(actionEntryFor(doc, 'x')?._key).toBe('b');
    expect(moveEntryFor(doc, 'x')).toBeUndefined();
    expect(moveEntryFor(doc, 'y')?._key).toBe('c');
    expect(actionEntryFor(doc, 'z')).toBeUndefined();
  });
});

describe('unresolvedText', () => {
  it('names the version-lag and span states in words, and passes anything else through', () => {
    expect(unresolvedText('pending-rebuild')).toBe('applies on next world load');
    expect(unresolvedText('span')).toBe('refused — would drop more than 200 colliders; nothing hidden');
    expect(unresolvedText('id')).toBe('build-time target — nothing resolves ids until stage 3');
    expect(unresolvedText('name')).toBe('no object of that name in the world');
    expect(unresolvedText('superseded')).toBe('superseded by a later action on the same object');
    expect(unresolvedText('error')).toBe('error');
  });
});

describe('removeWarnings', () => {
  const rmName: Draft = { _key: 'r', kind: 'remove', id: 'r', target: { name: 'barn' } };
  const rmId: Draft = { _key: 'q', kind: 'remove', id: 'q', target: { id: 'rock@5,-7' } };
  const mv: Draft = { _key: 'm', kind: 'move', id: 'm', target: { name: 'well' }, position: { x: 1, y: 2, z: 3 } };
  const doc = [rmName, rmId, mv];

  it('a {name} remove the game applied with no colliders dropped is hidden but may still block (decision B)', () => {
    expect(removeWarnings([{ id: 'r', ok: true, colliders: 0 }], doc)).toEqual([
      { id: 'r', text: 'removed, but nothing dropped: this object may still block' },
    ]);
    // the applier's report has always carried `colliders`; a report without it reads as 0, as the store clamps it
    expect(removeWarnings([{ id: 'r', ok: true }], doc)).toEqual([
      { id: 'r', text: 'removed, but nothing dropped: this object may still block' },
    ]);
  });
  it('a remove that dropped more colliders than one prop owns has swept other objects: a large named container under the cap', () => {
    expect(WIDE_REMOVE_COLLIDERS).toBe(8);
    expect(removeWarnings([{ id: 'r', ok: true, colliders: 9 }], doc)).toEqual([
      { id: 'r', text: 'removed 9 colliders — more than one object has; check the map' },
    ]);
    expect(removeWarnings([{ id: 'q', ok: true, colliders: 47 }], doc)).toEqual([
      { id: 'q', text: 'removed 47 colliders — more than one object has; check the map' },
    ]);
    expect(removeWarnings([{ id: 'r', ok: true, colliders: 8 }], doc)).toEqual([]);
  });
  it('is matched by id against the document on this page: a move, an {id} remove with no drops, and an id not in the document say nothing', () => {
    expect(removeWarnings([{ id: 'm', ok: true, colliders: 0 }], doc)).toEqual([]);
    expect(removeWarnings([{ id: 'q', ok: true, colliders: 0 }], doc)).toEqual([]);
    expect(removeWarnings([{ id: 'gone', ok: true, colliders: 0 }], doc)).toEqual([]);
    expect(removeWarnings([{ id: 'r', ok: true, colliders: 1 }], doc)).toEqual([]);
    expect(removeWarnings([], doc)).toEqual([]);
  });
  it('a remove the game did NOT apply warns nothing: its zero is not "hidden but still blocking", it is "not hidden"', () => {
    expect(removeWarnings([{ id: 'r', ok: false, colliders: 0 }], doc)).toEqual([]);
    expect(removeWarnings([{ id: 'r', ok: false, colliders: 12 }], doc)).toEqual([]);
  });
  it('one line per applied entry, in the report order', () => {
    const out = removeWarnings([{ id: 'q', ok: true, colliders: 12 }, { id: 'm', ok: true, colliders: 1 }, { id: 'r', ok: true, colliders: 0 }], doc);
    expect(out.map((w) => w.id)).toEqual(['q', 'r']);
  });
});

describe('placeAt', () => {
  it('builds a place draft with a copied config and quantity 1', () => {
    const config = { effect: 'heal', amount: 5 };
    const d = placeAt({ source_key: 'loot', name: 'Loot Crate', config }, 1, 2, 3, mint);
    expect(d).toMatchObject({ kind: 'place', item: { source_key: 'loot', name: 'Loot Crate' }, position: { x: 1, y: 2, z: 3 }, quantity: 1 });
    expect(d.item.config).toEqual(config);
    expect(d.item.config).not.toBe(config);
    expect(d._key).toBe(d.id);
  });
});

describe('placementY', () => {
  /** 2×2 samples, two layers. Cell (0,0): a roof at 6 m over a deck at 1 m, deck FIRST in the bytes; cell (0,1): the same two surfaces, roof first; cell (1,0): one surface at 2 m; cell (1,1): unsampled. */
  function domed(): DecodedGround {
    const nx = 2, nz = 2, layers = 2;
    const heights = new Int16Array(nx * nz * layers).fill(NO_SAMPLE);
    heights[0] = 100; // (0,0) deck then roof: not top-down
    heights[1] = 600;
    heights[2] = 200; // (1,0)
    heights[4] = 600; // (0,1) roof then deck: the mirror of (0,0)
    heights[5] = 100;
    return decodeGround({ originX: 0, originZ: 0, step: 4, nx, nz, layers, heightsCm: encodeHeights(heights) });
  }
  it('is the LOWEST surface under the click: under the dome a placement lands on the deck, not the roof', () => {
    const g = domed();
    expect(layersAt(g, 0, 0)).toEqual([6, 1]);
    expect(placementY(g, 0, 0)).toBe(1);
    expect(placementY(g, 4, 0)).toBe(2);
    // a single-layer grid: that layer (the slope is 1 m at x = 4)
    expect(placementY(slope(), 4, 0)).toBe(1);
  });
  it('"lowest" is not "last": the mirrored cell, roof first in the bytes, lands on the same deck', () => {
    const g = domed();
    expect(placementY(g, 0, 4)).toBe(1);
    expect(placementY(g, 0, 4)).toBe(placementY(g, 0, 0));
  });
  it('is 0 with no grid, off the grid, and where the grid has no sample', () => {
    expect(placementY(null, 0, 0)).toBe(0);
    expect(placementY(domed(), 4, 4)).toBe(0); // cell (1,1): NO_SAMPLE in both layers
    expect(placementY(domed(), 50, 50)).toBe(0); // off the grid
  });
});

describe('selection helpers', () => {
  const objects = [{ name: 'o1', position: { x: 1, y: 2, z: 3 } }];
  const entries: Draft[] = [
    { _key: 'm', kind: 'move', id: 'm', target: { name: 'o1' }, position: { x: 10, y: 2, z: 30 } },
    { _key: 'p', kind: 'place', id: 'p', item: { source_key: 's', name: 'S', config: {} }, position: { x: 4, y: 5, z: 6 }, quantity: 1 },
  ];
  it('moveEntryFor finds the move by target name', () => {
    expect(moveEntryFor(entries, 'o1')?._key).toBe('m');
    expect(moveEntryFor(entries, 'nope')).toBeUndefined();
  });
  it('selectedEntry maps an object to its pending move and an entry to itself', () => {
    expect(selectedEntry(entries, { kind: 'object', name: 'o1' })?._key).toBe('m');
    expect(selectedEntry(entries, { kind: 'entry', key: 'p' })?._key).toBe('p');
    expect(selectedEntry(entries, null)).toBeUndefined();
  });
  it('selectedPosition is the pending position when moved, else the reported one', () => {
    expect(selectedPosition(objects, entries, { kind: 'object', name: 'o1' })).toEqual({ x: 10, y: 2, z: 30 });
    expect(selectedPosition(objects, [], { kind: 'object', name: 'o1' })).toEqual({ x: 1, y: 2, z: 3 });
    expect(selectedPosition(objects, entries, { kind: 'entry', key: 'p' })).toEqual({ x: 4, y: 5, z: 6 });
    expect(selectedPosition(objects, entries, { kind: 'object', name: 'unknown' })).toBeNull();
  });
  it('two moves for one name: the LAST is the one, everywhere — the game applies a document in order', () => {
    // A saved document can carry two moves of one object (the normaliser de-duplicates ids, not targets).
    // `mapConflicts.prepare` already treats the last as the occupant; the editor must agree, or the map
    // would draw one position, the panel edit another, and a drag move a third.
    const twice: Draft[] = [
      { _key: 'first', kind: 'move', id: 'first', target: { name: 'o1' }, position: { x: 10, y: 2, z: 30 } },
      entries[1],
      { _key: 'last', kind: 'move', id: 'last', target: { name: 'o1' }, position: { x: 50, y: 2, z: 60 } },
    ];
    expect(moveEntryFor(twice, 'o1')?._key).toBe('last');
    expect(selectedEntry(twice, { kind: 'object', name: 'o1' })?._key).toBe('last');
    const at = selectedPosition(objects, twice, { kind: 'object', name: 'o1' });
    expect(at).toEqual({ x: 50, y: 2, z: 60 });
    const moved = hitCandidates(objects, twice).find((m) => m.mark === 'moved');
    expect(moved).toMatchObject({ key: 'o:o1', x: at!.x, z: at!.z });
    // and editing the object edits the move that wins, leaving the superseded one exactly as it was
    const out = upsertMoveFor(twice, 'o1', { x: 1, y: 1, z: 1 }, undefined, mint);
    expect(out).toHaveLength(3);
    expect(out[2]).toMatchObject({ _key: 'last', position: { x: 1, y: 1, z: 1 } });
    expect(out[0]).toBe(twice[0]);
  });
  it('a removed object selects as the remove, and is where the game reported it', () => {
    const gone: Draft[] = [entries[0], { _key: 'r', kind: 'remove', id: 'r', target: { name: 'o1' } }];
    expect(selectedEntry(gone, { kind: 'object', name: 'o1' })?._key).toBe('r');
    expect(selectedPosition(objects, gone, { kind: 'object', name: 'o1' })).toEqual({ x: 1, y: 2, z: 3 });
    expect(selectedPosition(objects, gone, { kind: 'entry', key: 'r' })).toBeNull();
  });
});

describe('canonicalSelection', () => {
  const objects = [{ name: 'o1' }];
  const entries: Draft[] = [
    { _key: 'm', kind: 'move', id: 'm', target: { name: 'o1' }, position: { x: 10, y: 2, z: 30 } },
    { _key: 'f', kind: 'move', id: 'f', target: { name: 'ghost' }, position: { x: 20, y: 1, z: 21 } },
    { _key: 'p', kind: 'place', id: 'p', item: { source_key: 's', name: 'S', config: {} }, position: { x: 4, y: 5, z: 6 }, quantity: 1 },
    { _key: 'r', kind: 'remove', id: 'r', target: { name: 'o1' } },
  ];
  it('a move of a reported target is the object; an unreported object with a move is its entry', () => {
    expect(canonicalSelection(objects, entries, { kind: 'entry', key: 'm' })).toEqual({ kind: 'object', name: 'o1' });
    expect(canonicalSelection(objects, entries, { kind: 'object', name: 'ghost' })).toEqual({ kind: 'entry', key: 'f' });
  });
  it('a remove of a reported target is the object; a typed unreported name with only a remove is its entry', () => {
    expect(canonicalSelection(objects, entries, { kind: 'entry', key: 'r' })).toEqual({ kind: 'object', name: 'o1' });
    const typed: Draft[] = [{ _key: 'g', kind: 'remove', id: 'g', target: { name: 'ghost' } }];
    expect(canonicalSelection(objects, typed, { kind: 'object', name: 'ghost' })).toEqual({ kind: 'entry', key: 'g' });
  });
  it('everything else comes back as it was, by identity', () => {
    const unchanged: NonNullable<Selected>[] = [
      { kind: 'object', name: 'o1' },
      { kind: 'entry', key: 'f' },
      { kind: 'entry', key: 'p' },
      { kind: 'object', name: 'nobody' }, // unreported, no move yet: still the typed name
      { kind: 'entry', key: 'zzz' },
    ];
    for (const sel of unchanged) expect(canonicalSelection(objects, entries, sel)).toBe(sel);
    expect(canonicalSelection(objects, entries, null)).toBeNull();
  });
  it('two moves of one unreported name select the LAST, as everything else reads it', () => {
    const twice: Draft[] = [entries[1], { _key: 'f2', kind: 'move', id: 'f2', target: { name: 'ghost' }, position: { x: 0, y: 0, z: 0 } }];
    expect(canonicalSelection(objects, twice, { kind: 'object', name: 'ghost' })).toEqual({ kind: 'entry', key: 'f2' });
  });
});

describe('groundStatus', () => {
  /** One flat cell over [0, 4]² at 0.08 m — the ground whose `g − 0.25` is −0.17000000000000004 in a double. */
  function eightCm(): DecodedGround {
    return decodeGround({ originX: 0, originZ: 0, step: 4, nx: 2, nz: 2, layers: 1, heightsCm: encodeHeights(Int16Array.from([8, 8, 8, 8])) });
  }
  it('draws both lines where the save route draws them, to the millimetre', () => {
    const g = eightCm();
    expect(groundStatus(g, 2, 2, 0.08)).toBe('ok');
    // g − 0.25: the panel's first version compared floats and called this underground while the route said nothing
    expect(groundStatus(g, 2, 2, -0.17)).toBe('ok');
    expect(groundStatus(g, 2, 2, -0.171)).toBe('underground');
    // g + 1.5
    expect(groundStatus(g, 2, 2, 1.58)).toBe('ok');
    expect(groundStatus(g, 2, 2, 1.581)).toBe('floating');
  });
  it('is no-ground off the sampled grid, and null with no grid at all — there is nothing to say', () => {
    expect(groundStatus(eightCm(), 50, 2, 0)).toBe('no-ground');
    expect(groundStatus(null, 2, 2, 0)).toBeNull();
  });
});

describe('hitCandidates and hoverInfoFor', () => {
  const objects = [
    { name: 'o1', position: { x: 1, y: 2, z: 3 } },
    { name: 'o2', position: { x: 7, y: 0, z: 8 } },
    { name: 'o3', position: { x: 9, y: 0, z: 9 } },
  ];
  const entries: Draft[] = [
    { _key: 'm', kind: 'move', id: 'm', target: { name: 'o1' }, position: { x: 10, y: 2, z: 30 } },
    { _key: 'p', kind: 'place', id: 'p', item: { source_key: 's', name: 'S', config: {} }, position: { x: 4, y: 5, z: 6 }, quantity: 1 },
    { _key: 'f', kind: 'move', id: 'f', target: { name: 'ghost' }, position: { x: 20, y: 1, z: 21 } },
    { _key: 'h', kind: 'remove', id: 'h', target: { name: 'o3' } },
    { _key: 'n', kind: 'remove', id: 'n', target: { name: 'nowhere' } },
  ];
  const marks = hitCandidates(objects, entries);

  it('a moved object is under ONE key at its reported and its pending position', () => {
    const o1 = marks.filter((m) => m.key === 'o:o1');
    expect(o1).toEqual([
      { key: 'o:o1', x: 1, z: 3, r: 0, mark: 'origin' },
      { key: 'o:o1', x: 10, z: 30, r: 0, mark: 'moved', from: { x: 1, z: 3 } },
    ]);
    // the reported target's move does NOT also appear as an entry mark
    expect(marks.find((m) => m.key === 'e:m')).toBeUndefined();
  });
  it('an unmoved object is one mark; a removed object is one struck-through mark at its reported position', () => {
    expect(marks.filter((m) => m.key === 'o:o2')).toEqual([{ key: 'o:o2', x: 7, z: 8, r: 0, mark: 'object' }]);
    expect(marks.filter((m) => m.key === 'o:o3')).toEqual([{ key: 'o:o3', x: 9, z: 9, r: 0, mark: 'removed', draggable: false }]);
  });
  it('the removed mark is the ONLY one that selects but never drags', () => {
    // A 3 px drag on it would turn the remove into a move through the drag's upsert, and Save would write it.
    // The canvas reads this flag; the rule is pinned here so that component decides nothing.
    expect(marks.filter((m) => m.draggable === false).map((m) => m.mark)).toEqual(['removed']);
    expect(marks.filter((m) => m.mark !== 'removed').every((m) => m.draggable === undefined)).toBe(true);
  });
  it('a placement and a free-text move are entry marks; a remove is never one', () => {
    expect(marks.find((m) => m.key === 'e:p')).toEqual({ key: 'e:p', x: 4, z: 6, r: 0, mark: 'place' });
    expect(marks.find((m) => m.key === 'e:f')).toEqual({ key: 'e:f', x: 20, z: 21, r: 0, mark: 'free' });
    expect(marks.find((m) => m.key === 'e:n')).toBeUndefined();
    expect(marks.find((m) => m.key === 'e:h')).toBeUndefined();
  });
  it('every mark has r: 0 so the hit reach never grows with zoom', () => {
    expect(marks.length).toBe(6);
    expect(marks.every((m) => m.r === 0)).toBe(true);
  });
  it('hoverInfoFor an object reads its name and where it currently is', () => {
    expect(hoverInfoFor(objects, entries, 'o:o1')).toEqual({ label: 'o1', x: 10, y: 2, z: 30 });
    expect(hoverInfoFor(objects, entries, 'o:o2')).toEqual({ label: 'o2', x: 7, y: 0, z: 8 });
    expect(hoverInfoFor(objects, entries, 'o:o3')).toEqual({ label: 'o3 — removed', x: 9, y: 0, z: 9 });
  });
  it('hoverInfoFor an entry reads item ×qty or the target name, and null for an unknown key', () => {
    expect(hoverInfoFor(objects, entries, 'e:p')).toEqual({ label: 'S ×1', x: 4, y: 5, z: 6 });
    expect(hoverInfoFor(objects, entries, 'e:f')).toEqual({ label: 'ghost', x: 20, y: 1, z: 21 });
    expect(hoverInfoFor(objects, entries, 'e:zzz')).toBeNull();
    expect(hoverInfoFor(objects, entries, 'o:unknown')).toBeNull();
  });
});

describe('selectionKey / selectionFromKey', () => {
  it('round-trips both kinds — the one string the canvas, the picker and the pending list share', () => {
    const o = { kind: 'object', name: 'medieval:house' } as const;
    const e = { kind: 'entry', key: 'k7' } as const;
    expect(selectionKey(o)).toBe('o:medieval:house');
    expect(selectionKey(e)).toBe('e:k7');
    expect(selectionFromKey('o:medieval:house')).toEqual(o);
    expect(selectionFromKey('e:k7')).toEqual(e);
  });
  it('nothing selected has no key, and a name with colons in it survives', () => {
    expect(selectionKey(null)).toBeNull();
    expect(selectionFromKey('o:a:b:c')).toEqual({ kind: 'object', name: 'a:b:c' });
  });
});
