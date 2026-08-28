import { round, targetName, type OverlayEntry, type PlaceEntry, type Vec3 } from './mapOverlaySchema';
import { decodeGround, groundAt, type DecodedGround, type WorldLayout } from './mapLayout';
import type { CatalogueObject } from './mapOverlay';

/**
 * What is wrong with a map entry, before it is saved.
 *
 * ── Why the page checks and the route checks again ─────────────────────────
 *
 * The editor runs these rules on every drag so the admin sees "underground"
 * beside the row before clicking Save. That is a courtesy — it makes the
 * editor pleasant — and nothing about a live world may rest on a courtesy.
 * The save route runs the SAME function over the SAME inputs and refuses on
 * any error-level result, so a client that skipped the check, a stale tab or
 * a replayed request cannot write what the page would have refused. One
 * module, two callers: the route is the boundary, the page is the preview.
 *
 * ── Why only `out-of-bounds` refuses ───────────────────────────────────────
 *
 * The rest are sometimes right on purpose — a lantern hangs in the air, a
 * cellar door sits under the ground, two crates touch — and the admin can see
 * the map where this module cannot. A position outside the world's own bounds
 * is never right on purpose, and saving it produces an object nobody can find.
 *
 * ── Occupancy is the layout composed with the document ─────────────────────
 *
 * A named object stands where the game reported it UNLESS this document acts
 * on it. The LAST action on a name wins, because the game applies a document
 * in order: a move puts the object, and its colliders, at the new spot only
 * (it can never "overlap" its own old position); a remove takes the object
 * out of the world AND drops the colliders inside its box (`_applyRemove` in
 * `src/systems/MapOverlay.js`, by containment), so a removed object occupies
 * NOTHING - the reverse of stage 1's `hidden`, whose colliders stayed. An
 * action superseded by a later one stands nowhere: not an occupant, no
 * ground or overlap rule (it already carries `duplicate-target`), but still
 * the bounds rule, so an out-of-bounds coordinate cannot slip through behind
 * a later entry. An `{id}` target names a build-time prop this stage has no
 * layout entry for: it is judged for bounds only and composes nothing until
 * stage 3 brings `props[]`. On the route path the normaliser keeps duplicate
 * targets exactly as sent (it de-duplicates ids, not targets); only
 * `lastAction` in `prepare` composes.
 *
 * ── The grid answers in bounded time for any input ─────────────────────────
 *
 * The editor path hands over raw floats. A footprint's cost is its area in
 * cells, so a side is capped at `FOOTPRINT_MAX` (a placed item is never a
 * hundred metres wide) and anything else falls back to the default. A
 * coordinate the grid cannot place — one whose millimetre value is not a safe
 * integer — stands nowhere: `mm(1e308)` is Infinity and a cell loop from
 * −Infinity never ends, and `mm(1e20)` is a finite 1e23 past which `cx++` no
 * longer changes `cx`, which never ends either. Such a position is not an
 * occupant and is not tested for overlap; the bounds rule reads the position
 * itself and still refuses it.
 *
 * ── Why `{name}` targets are points ─────────────────────────────────────────
 *
 * The reported catalogue carries a name and a position; a world AABB for two
 * thousand arbitrary groups on every report is not free. So a named object is
 * a point for the ground rules (bottom = `position.y`) and a 1 m disc for
 * overlap. A placement has a footprint from `placeFootprint`, 1 × 1 × 1 m by
 * default — symmetric, so `rotationY` cannot change it in stage 1; the rect is
 * rotated once a real per-item size table exists (stage 2+). The bounds rule
 * tests a placement's anchor, not its footprint: the 5 m margin covers half a
 * rect many times over.
 *
 * ── Whole millimetres, on a 4 m bucket grid ────────────────────────────────
 *
 * Positions carry three places (the schema rounds them) and the ground grid is
 * in centimetres, so nothing here has more than millimetres in it — yet in
 * doubles "exactly a metre apart" reads as closer than a metre for about half
 * of all centimetre positions (see `mm`). Occupants are therefore stored as
 * millimetre integers and every geometric test is integer arithmetic.
 *
 * Chunks 4–6 run `conflictsForDocument` on every drag frame, at up to 2 000
 * reported objects and 500 entries; a pairwise scan is 1.25 M distance tests
 * a frame. `prepare` buckets every occupant into the 4 m cells its reach
 * touches (its rect or point, grown by half the clearance) and the rule reads
 * only the cells its own reach touches. Insert and query grow by the same
 * amount, so two things that can meet always share a cell; the cell is a
 * candidate filter and `occupantsMeet` still decides. Measured at the caps
 * on a desktop (2 000 objects, 500 entries, scattered over 200 m, medians):
 * the whole document 1.4 ms with the grid against 5.8 ms pairwise; at 4 000
 * objects 1.9 ms against 10.5 ms; crammed into 40 m, where a cell holds
 * dozens, 5.4 ms against 6.7 ms. A modest win, and the headroom is the point:
 * the pairwise cost grows with objects × entries, the grid's with density.
 *
 * Imports are pure code plus erased types, so this runs in the browser and
 * in a unit test without `pg`. Nothing throws: a rule that cannot decide says
 * nothing.
 */

export type ConflictLevel = 'error' | 'warn';
export type ConflictCode =
  | 'out-of-bounds'
  | 'stale-name'
  | 'duplicate-target'
  | 'underground'
  | 'floating'
  | 'no-ground'
  | 'overlap';

export interface Conflict {
  level: ConflictLevel;
  code: ConflictCode;
  detail: string;
  /** The offending object name or entry id, for `duplicate-target` and `overlap`. */
  other?: string;
}

export interface ConflictContext {
  layout: WorldLayout | null;
  /** `decodeGround(layout.ground)`, done once by the caller. */
  ground: DecodedGround | null;
  /** `report.objects` — what the game last said stands in this world. */
  objects: CatalogueObject[];
  /** Footprint of a placed item in metres. Default 1 × 1 × 1. */
  placeFootprint?: (entry: PlaceEntry) => { w: number; d: number; h: number };
}

/** Metres past the reported bounds before a position is refused: props already lean over the edge. */
export const BOUNDS_MARGIN = 5;
/** A bottom this far under the ground is still "resting on it" — sunk props are authored that way. */
export const UNDERGROUND_TOLERANCE = 0.25;
/** A bottom this far above the ground is still "on it" — steps, plinths, a lifted pivot. */
export const FLOATING_TOLERANCE = 1.5;
/** XZ distance under which two points are the same spot. */
export const POINT_CLEARANCE = 1;
/** How far a footprint rect grows when tested against a point. */
const POINT_HALF = POINT_CLEARANCE / 2;
const DEFAULT_FOOTPRINT = { w: 1, d: 1, h: 1 };
/** The widest side a placed item can claim, in metres: its cost to the grid is its area in cells. */
const FOOTPRINT_MAX = 100;
/** Width of an occupancy bucket, in millimetres: a few metres, so a cell holds a handful of neighbours. */
const CELL_MM = 4000;

/**
 * Metres to whole millimetres, the unit the data has: the schema keeps three places and the grid is in
 * centimetres. Every comparison goes through this, because `g - 0.25` over a ground of 0.08 m is
 * −0.17000000000000004 in a double and a bottom at exactly −0.17 would read as underground; a sweep of
 * integer-centimetre grounds across ±50 m found 77 such false undergrounds and 316 false floatings, and the
 * same sweep over the overlap clearance found "exactly a metre apart" reading as closer for 280 of 10 001
 * positions along an axis and 2 434 of 5 001 on a 3-4-5 diagonal. Only the round numbers the first tests used
 * were exact.
 */
const mm = (metres: number): number => Math.round(metres * 1000);
const POINT_HALF_MM = mm(POINT_HALF);
const CLEARANCE_SQ_MM = mm(POINT_CLEARANCE) ** 2;
const UNDERGROUND_MM = mm(UNDERGROUND_TOLERANCE);
const FLOATING_MM = mm(FLOATING_TOLERANCE);

/** An axis-aligned footprint, in whole millimetres. */
interface Rect { minX: number; maxX: number; minZ: number; maxZ: number }
/**
 * Something standing in the world, in whole millimetres: a reported object (point) or an entry (point or
 * rect). `order` is insertion order — reported objects first, then entries in document order — so a list of
 * neighbours gathered from several cells can be put back into a stable order.
 */
interface Occupant { key: string; label: string; order: number; x: number; z: number; rect: Rect | null }
/** Every occupant by key, and the cells each one's reach touches. */
interface Occupancy { byKey: Map<string, Occupant>; cells: Map<number, Occupant[]> }
/** The reported names, the occupancy, and for each name the document acts on the index of the action that wins. */
interface Prepared { names: Set<string>; occupancy: Occupancy; lastAction: Map<string, number> }

/**
 * A cell's Map key as one integer rather than a string: `prepare` runs every drag frame and a string per cell
 * per occupant was a measurable share of its cost. Cell indices fit ±32 767 with room to spare on the route
 * path — the normaliser caps a position at ±20 000 m, which is ±5 000 cells. Reported-object positions are
 * only finiteness-checked by the store and the editor's floats are raw, so a key CAN collide beyond that; it
 * does not matter. A point spans at most two cells an axis whatever its magnitude (`placeable` keeps the
 * indices where `cx++` still counts), and a collision only adds candidates that `occupantsMeet` rejects.
 */
const cellKey = (cx: number, cz: number): number => (cx + 0x8000) * 0x10000 + (cz + 0x8000);

const warn = (code: ConflictCode, detail: string, other?: string): Conflict =>
  ({ level: 'warn', code, detail, ...(other !== undefined ? { other } : {}) });

const entryKey = (index: number): string => `entry:${index}`;

/** Detail numbers to the millimetre, the schema's own rounding: on the editor path a drag hands over raw floats. */
const fmt = (n: number): string => String(round(n, 3));

/**
 * A footprint side the callback can hand over raw: not finite, not positive or wider than `FOOTPRINT_MAX`
 * falls back. Zero is not a very small item but a degenerate rect that meets nothing, not even a twin on the
 * same point (`rectsMeet` is strict), so two zero-footprint placements would never overlap each other.
 */
const side = (n: number, fallback: number): number => (Number.isFinite(n) && n > 0 && n <= FOOTPRINT_MAX ? n : fallback);

function footprintRect(entry: PlaceEntry, ctx: ConflictContext): Rect {
  const size = ctx.placeFootprint?.(entry) ?? DEFAULT_FOOTPRINT;
  const w = side(size.w, DEFAULT_FOOTPRINT.w);
  const d = side(size.d, DEFAULT_FOOTPRINT.d);
  const { x, z } = entry.position;
  return { minX: mm(x - w / 2), maxX: mm(x + w / 2), minZ: mm(z - d / 2), maxZ: mm(z + d / 2) };
}

/**
 * A position in whole millimetres, or null when the grid cannot place it (see the header). A safe integer
 * is exactly the condition under which the cell loops terminate: `mm(1e308)` is Infinity, and `mm(1e20)` is
 * finite but past 2^53, where `cx++` stops counting.
 */
function placeable(x: number, z: number): { x: number; z: number } | null {
  const mx = mm(x);
  const mz = mm(z);
  return Number.isSafeInteger(mx) && Number.isSafeInteger(mz) ? { x: mx, z: mz } : null;
}

/**
 * The cells an occupant's reach touches, as inclusive cell-index ranges: its rect or its point, grown by half
 * the clearance. Inserting and querying by the same reach is what makes the grid sound — two points closer
 * than the clearance have reaches that overlap, a point inside a grown rect has a reach that overlaps the
 * rect's, and two rects that intersect still intersect grown — so anything that can meet shares a cell.
 */
function reach(o: Occupant): [number, number, number, number] {
  const minX = (o.rect ? o.rect.minX : o.x) - POINT_HALF_MM;
  const maxX = (o.rect ? o.rect.maxX : o.x) + POINT_HALF_MM;
  const minZ = (o.rect ? o.rect.minZ : o.z) - POINT_HALF_MM;
  const maxZ = (o.rect ? o.rect.maxZ : o.z) + POINT_HALF_MM;
  return [Math.floor(minX / CELL_MM), Math.floor(maxX / CELL_MM), Math.floor(minZ / CELL_MM), Math.floor(maxZ / CELL_MM)];
}

function addOccupant(occupancy: Occupancy, o: Occupant): void {
  occupancy.byKey.set(o.key, o);
  const [x0, x1, z0, z1] = reach(o);
  for (let cx = x0; cx <= x1; cx++) {
    for (let cz = z0; cz <= z1; cz++) {
      const key = cellKey(cx, cz);
      const cell = occupancy.cells.get(key);
      if (cell) cell.push(o);
      else occupancy.cells.set(key, [o]);
    }
  }
}

/** The reported names, and the occupancy of layout ∘ document (see the header). */
function prepare(document: OverlayEntry[], ctx: ConflictContext): Prepared {
  const names = new Set(ctx.objects.map((o) => o.name));
  const lastAction = new Map<string, number>();
  document.forEach((entry, index) => {
    if (entry.kind === 'place') return;
    const name = targetName(entry.target);
    if (name !== null) lastAction.set(name, index);
  });

  const occupancy: Occupancy = { byKey: new Map(), cells: new Map() };
  let order = 0;
  for (const obj of ctx.objects) {
    if (lastAction.has(obj.name)) continue;
    // A position the grid cannot place stands nowhere (see the header).
    const at = placeable(obj.position.x, obj.position.z);
    if (!at) continue;
    addOccupant(occupancy, { key: `object:${obj.name}`, label: obj.name, order: order++, x: at.x, z: at.z, rect: null });
  }
  document.forEach((entry, index) => {
    if (entry.kind === 'remove') return;
    if (entry.kind === 'move') {
      const name = targetName(entry.target);
      if (name === null || lastAction.get(name) !== index) return;
    }
    // A position the grid cannot place stands nowhere; the bounds rule still refuses it.
    const at = placeable(entry.position.x, entry.position.z);
    if (!at) return;
    const rect = entry.kind === 'place' ? footprintRect(entry, ctx) : null;
    addOccupant(occupancy, { key: entryKey(index), label: entry.id, order: order++, x: at.x, z: at.z, rect });
  });
  return { names, occupancy, lastAction };
}

function nameRules(entry: OverlayEntry, index: number, document: OverlayEntry[], prepared: Prepared, out: Conflict[]): void {
  if (entry.kind === 'place') return;
  const name = targetName(entry.target);
  if (name === null) return;
  // Both sides clamp a name to 200 chars (`recordWorldReport`, `readName(…, 200)`), so the comparison is consistent.
  if (prepared.names.size > 0 && !prepared.names.has(name)) {
    out.push(warn('stale-name', `"${name}" is not among the ${prepared.names.size} known names this world last reported`));
  }
  document.forEach((other, j) => {
    if (j === index || other.kind === 'place' || targetName(other.target) !== name) return;
    const verb = other.kind === 'remove' ? 'removes' : 'moves';
    out.push(warn('duplicate-target', `"${other.id}" also ${verb} "${name}"; the last one wins`, other.id));
  });
}

/**
 * True when the position is refused. The caller stops there: a point outside the world has no ground to be
 * under or over. A coordinate that is not a number is refused too — `NaN < lo` and `NaN > hi` are both false,
 * so the range test alone would let it through, and `placeable` has already dropped it from the occupancy,
 * so nothing else would speak: it would save with no conflict at all, as an object nobody can find.
 */
function boundsRule(pos: Vec3, layout: WorldLayout, out: Conflict[]): boolean {
  const { min, max } = layout.bounds;
  for (const [axis, value, lo, hi] of [['x', pos.x, min.x, max.x], ['z', pos.z, min.z, max.z]] as const) {
    if (!Number.isFinite(value) || value < lo - BOUNDS_MARGIN || value > hi + BOUNDS_MARGIN) {
      const detail = `${axis} = ${fmt(value)} is outside the world's bounds (${lo} to ${hi}, ±${BOUNDS_MARGIN} m)`;
      out.push({ level: 'error', code: 'out-of-bounds', detail });
      // First offending axis wins; one Conflict per entry.
      return true;
    }
  }
  return false;
}

/** The three things the ground rule can say about a position. */
export type GroundVerdict = Extract<ConflictCode, 'underground' | 'floating' | 'no-ground'>;

/** The one comparison of a bottom against a ground, in whole millimetres (see `mm`); null when it rests on it. */
function groundCompare(g: number, y: number): Exclude<GroundVerdict, 'no-ground'> | null {
  if (mm(g - y) > UNDERGROUND_MM) return 'underground';
  if (mm(y - g) > FLOATING_MM) return 'floating';
  return null;
}

/**
 * The ground rule's verdict for a position, or null when nothing is wrong — exported so the editor's panel
 * can say what the save route WOULD say about a typed Y before it is committed. It is the same
 * `groundCompare` the rule itself makes, not a second copy: the panel's first version re-derived the rule
 * as `y < g − 0.25` in floats, and over a ground of 0.08 m that is −0.17000000000000004, so a typed −0.17
 * read as underground in the panel while the route saved it with no conflict at all.
 */
export function groundVerdict(pos: Vec3, ground: DecodedGround): GroundVerdict | null {
  const g = groundAt(ground, pos.x, pos.z, pos.y);
  return g === null ? 'no-ground' : groundCompare(g, pos.y);
}

/**
 * The bottom of a point entry is its `position.y`, for a move and a place alike (stage 1 has no per-item
 * height). `groundAt` picks the layer at or below that y per corner, so under a dome this measures against
 * the deck, not the roof; below every layer it measures against the lowest, so "underground" always has a
 * surface to be under.
 */
function groundRule(pos: Vec3, ground: DecodedGround, out: Conflict[]): void {
  const g = groundAt(ground, pos.x, pos.z, pos.y);
  if (g === null) {
    out.push(warn('no-ground', `no surface under (${fmt(pos.x)}, ${fmt(pos.z)}) — water, a hole, or off the sampled grid`));
    return;
  }
  const verdict = groundCompare(g, pos.y);
  if (verdict === 'underground') {
    out.push(warn('underground', `bottom at y = ${fmt(pos.y)} is ${fmt(g - pos.y)} m under the ground at ${fmt(g)}`));
  } else if (verdict === 'floating') {
    out.push(warn('floating', `bottom at y = ${fmt(pos.y)} is ${fmt(pos.y - g)} m above the ground at ${fmt(g)}`));
  }
}

function rectsMeet(a: Rect, b: Rect): boolean {
  return a.minX < b.maxX && a.maxX > b.minX && a.minZ < b.maxZ && a.maxZ > b.minZ;
}

function pointInRect(x: number, z: number, r: Rect, grow: number): boolean {
  return x > r.minX - grow && x < r.maxX + grow && z > r.minZ - grow && z < r.maxZ + grow;
}

/** Whole-millimetre integers throughout (see `mm`), so exactly a metre apart is exactly not an overlap. */
function occupantsMeet(a: Occupant, b: Occupant): boolean {
  if (a.rect && b.rect) return rectsMeet(a.rect, b.rect);
  if (a.rect) return pointInRect(b.x, b.z, a.rect, POINT_HALF_MM);
  if (b.rect) return pointInRect(a.x, a.z, b.rect, POINT_HALF_MM);
  const dx = a.x - b.x;
  const dz = a.z - b.z;
  return dx * dx + dz * dz < CLEARANCE_SQ_MM;
}

/**
 * An entry never meets itself: it is skipped by key. A moved object's old position is not in the occupancy at
 * all, and neither is a move superseded by a later move of the same object — that entry stands nowhere, so
 * there is nothing to test it with. Neighbours are gathered from every cell the entry's reach touches, once
 * each (a wide footprint sits in several cells), and reported in insertion order.
 */
function overlapRule(index: number, occupancy: Occupancy, out: Conflict[]): void {
  const self = occupancy.byKey.get(entryKey(index));
  if (!self) return;
  const [x0, x1, z0, z1] = reach(self);
  const seen = new Set<string>([self.key]);
  const hits: Occupant[] = [];
  for (let cx = x0; cx <= x1; cx++) {
    for (let cz = z0; cz <= z1; cz++) {
      for (const other of occupancy.cells.get(cellKey(cx, cz)) ?? []) {
        if (seen.has(other.key)) continue;
        seen.add(other.key);
        if (occupantsMeet(self, other)) hits.push(other);
      }
    }
  }
  hits.sort((a, b) => a.order - b.order);
  for (const other of hits) {
    const how = self.rect || other.rect ? 'footprint meets' : `within ${POINT_CLEARANCE} m of`;
    out.push(warn('overlap', `${how} "${other.label}"`, other.label));
  }
}

function conflictsWith(entry: OverlayEntry, index: number, document: OverlayEntry[], ctx: ConflictContext, prepared: Prepared): Conflict[] {
  const out: Conflict[] = [];
  nameRules(entry, index, document, prepared, out);
  if (entry.kind === 'remove' || !ctx.layout) return out;
  const pos = entry.position;
  if (boundsRule(pos, ctx.layout, out)) return out;
  if (entry.kind === 'move') {
    const name = targetName(entry.target);
    // An {id} move is judged for bounds only; a superseded move stands nowhere (see the header).
    if (name === null || prepared.lastAction.get(name) !== index) return out;
  }
  if (ctx.ground) groundRule(pos, ctx.ground, out);
  overlapRule(index, prepared.occupancy, out);
  return out;
}

/**
 * Conflicts for one entry of `document` (which must contain it at `index`).
 * Re-prepares per call; for a whole document use `conflictsForDocument`, which prepares once.
 */
export function conflictsFor(entry: OverlayEntry, index: number, document: OverlayEntry[], ctx: ConflictContext): Conflict[] {
  return conflictsWith(entry, index, document, ctx, prepare(document, ctx));
}

/** One conflict list per entry, in document order. */
export function conflictsForDocument(document: OverlayEntry[], ctx: ConflictContext): Conflict[][] {
  const prepared = prepare(document, ctx);
  return document.map((entry, index) => conflictsWith(entry, index, document, ctx, prepared));
}

export function hasErrors(all: Conflict[][]): boolean {
  return all.some((conflicts) => conflicts.some((c) => c.level === 'error'));
}

/**
 * The one way a `ConflictContext` is built, so the save route and the editor's panel can never disagree
 * about a grid. The ground is decoded ONCE here. A grid that will not decode is a warning in the log and
 * `ground: null`, never a throw: the ground rules are warnings, and a warning that cannot be computed is
 * simply not shown, while the bounds rule — the one that refuses — needs no grid and keeps the layout. (From
 * the store this cannot fire today: `validateGround` decodes on the way in and `readWorldReport` validates
 * again on the way out. The helper does not know its caller.)
 */
export function conflictContextFor(
  layout: WorldLayout | null,
  objects: CatalogueObject[],
  placeFootprint?: ConflictContext['placeFootprint']
): ConflictContext {
  let ground: DecodedGround | null = null;
  if (layout?.ground) {
    try {
      ground = decodeGround(layout.ground);
    } catch (err) {
      const { nx, nz, layers } = layout.ground;
      console.warn(`[map-conflicts] stored ground did not decode for a ${nx}×${nz}×${layers} grid; treating as no grid:`, err);
    }
  }
  return { layout, ground, objects, ...(placeFootprint ? { placeFootprint } : {}) };
}
