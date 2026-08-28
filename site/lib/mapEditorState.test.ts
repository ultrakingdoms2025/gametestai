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
 * harness in chunk 7 greps for it.
 */
import { describe, expect, it } from 'vitest';
import { NO_SAMPLE, decodeGround, encodeHeights, type DecodedGround } from './mapLayout';
import type { Conflict } from './mapConflicts';
import {
  NO_LAYOUT_TEXT,
  degToRad,
  fmt,
  layoutAgeText,
  moveEntryFor,
  pendingRows,
  placeAt,
  radToDeg,
  rowLevel,
  selectedEntry,
  selectedPosition,
  selectionFromKey,
  selectionKey,
  snappedY,
  upsertMoveFor,
  type Draft,
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
    { _key: 'b', kind: 'move', id: 'b', target: { name: 'station:crate' }, position: null, hidden: true },
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
    expect(rows[1]).toMatchObject({ key: 'b', kind: 'move', label: 'station:crate', summary: 'hidden', level: 'ok' });
    expect(rows[2]).toMatchObject({ key: 'c', kind: 'place', label: 'Loot Crate ×2', summary: '→ (1.0, 2.0, 3.0)', level: 'error' });
    expect(rows[2].conflicts).toEqual([err, warn]);
  });
  it('tolerates a conflicts array shorter than the document', () => {
    expect(pendingRows(entries, [])[2].level).toBe('ok');
  });
  it('a hidden move that also has a position says both', () => {
    const only: Draft[] = [{ _key: 'd', kind: 'move', id: 'd', target: { name: 'x' }, position: { x: 1, y: 2, z: 3 }, hidden: true }];
    expect(pendingRows(only, [])[0].summary).toBe('→ (1.0, 2.0, 3.0) (hidden)');
  });
});

describe('upsertMoveFor', () => {
  it('adds one move entry for a name, then updates that same entry', () => {
    const one = upsertMoveFor([], 'a:b', { x: 1, y: 2, z: 3 }, undefined, mint);
    expect(one).toHaveLength(1);
    expect(one[0]).toMatchObject({ kind: 'move', target: { name: 'a:b' }, position: { x: 1, y: 2, z: 3 } });
    expect(one[0].rotationY).toBeUndefined();
    const two = upsertMoveFor(one, 'a:b', { x: 9, y: 8, z: 7 }, 1.5, mint);
    expect(two).toHaveLength(1);
    expect(two[0]._key).toBe(one[0]._key);
    expect(two[0].id).toBe(one[0].id);
    expect(two[0]).toMatchObject({ position: { x: 9, y: 8, z: 7 }, rotationY: 1.5 });
  });
  it('leaves other entries and their order alone', () => {
    const base = upsertMoveFor(upsertMoveFor([], 'x', { x: 0, y: 0, z: 0 }, undefined, mint), 'y', { x: 1, y: 1, z: 1 }, undefined, mint);
    const out = upsertMoveFor(base, 'x', { x: 5, y: 5, z: 5 }, undefined, mint);
    expect(out.map((e) => (e.kind === 'move' ? e.target.name : ''))).toEqual(['x', 'y']);
    expect(out[1]).toBe(base[1]);
  });
  it('a hidden move keeps its hidden flag when it is given a position', () => {
    const hidden: Draft[] = [{ _key: 'h', kind: 'move', id: 'h', target: { name: 'q' }, position: null, hidden: true }];
    const out = upsertMoveFor(hidden, 'q', { x: 1, y: 1, z: 1 }, undefined, mint);
    expect(out[0]).toMatchObject({ hidden: true, position: { x: 1, y: 1, z: 1 } });
  });
  it("rotationY undefined CLEARS an existing rotation; a caller passes the entry's own to keep it", () => {
    const turned = upsertMoveFor([], 'r', { x: 0, y: 0, z: 0 }, 1.5, mint);
    expect(upsertMoveFor(turned, 'r', { x: 1, y: 0, z: 0 }, undefined, mint)[0].rotationY).toBeUndefined();
    expect(upsertMoveFor(turned, 'r', { x: 1, y: 0, z: 0 }, turned[0].rotationY, mint)[0].rotationY).toBe(1.5);
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
