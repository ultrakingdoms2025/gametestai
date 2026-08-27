import { round, type OverlayEntry, type PlaceEntry, type Vec3 } from './mapOverlaySchema';
import { groundAt, type DecodedGround, type WorldLayout } from './mapLayout';
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
 * A named object stands where the game reported it UNLESS this document moves
 * it (then it stands at the new position only) or hides it (then its colliders
 * stay where they are). That last is the game's own apply path: `_applyMove`
 * in `src/systems/MapOverlay.js` clears `visible` and then relocates the
 * object's colliders only when the entry carries a position — so a hidden
 * object is an invisible wall, at the new spot when the move has one and at
 * the reported spot when it does not. These rules are deliberately NOT blind
 * to parked colliders: a barrel placed on a hidden crate is a barrel nobody
 * can walk up to. So a moved crate is tested where it now stands and can never
 * "overlap" its own old position. Every entry with a position stands at it.
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

interface Rect { minX: number; maxX: number; minZ: number; maxZ: number }
/** Something standing in the world: a reported object (point) or an entry (point or rect). */
interface Occupant { key: string; label: string; x: number; z: number; rect: Rect | null }
interface Prepared { names: Set<string>; occupants: Occupant[] }

const warn = (code: ConflictCode, detail: string, other?: string): Conflict =>
  ({ level: 'warn', code, detail, ...(other !== undefined ? { other } : {}) });

const entryKey = (index: number): string => `entry:${index}`;

/** Detail numbers to the millimetre, the schema's own rounding: on the editor path a drag hands over raw floats. */
const fmt = (n: number): string => String(round(n, 3));

/**
 * Metres to whole millimetres, the unit the data has: the schema keeps three places and the grid is in
 * centimetres. Every comparison against a tolerance goes through this, because `g - 0.25` over a ground of
 * 0.08 m is −0.17000000000000004 in a double and a bottom at exactly −0.17 would read as underground. A sweep
 * of integer-centimetre grounds across ±50 m found 77 such false undergrounds and 316 false floatings; only
 * the round grounds the first tests used were exact.
 */
const mm = (metres: number): number => Math.round(metres * 1000);

function footprintRect(entry: PlaceEntry, ctx: ConflictContext): Rect {
  const size = ctx.placeFootprint?.(entry) ?? DEFAULT_FOOTPRINT;
  const { x, z } = entry.position;
  return { minX: x - size.w / 2, maxX: x + size.w / 2, minZ: z - size.d / 2, maxZ: z + size.d / 2 };
}

/** The reported names, and the occupancy of layout ∘ document (see the header). */
function prepare(document: OverlayEntry[], ctx: ConflictContext): Prepared {
  const names = new Set(ctx.objects.map((o) => o.name));
  // Only a move WITH a position relocates the object and its colliders. A hidden move without one leaves the
  // reported object exactly where the game put it, so the reported object stays the occupant of that spot.
  const touched = new Set<string>();
  for (const entry of document) if (entry.kind === 'move' && entry.position) touched.add(entry.target.name);

  const occupants: Occupant[] = [];
  for (const obj of ctx.objects) {
    if (touched.has(obj.name)) continue;
    occupants.push({ key: `object:${obj.name}`, label: obj.name, x: obj.position.x, z: obj.position.z, rect: null });
  }
  document.forEach((entry, index) => {
    // A hidden move that carries a position still sends the object's colliders there (see the header), so it
    // occupies the new spot like any other move. Only an entry with no position stands nowhere new.
    if (!entry.position) return;
    const rect = entry.kind === 'place' ? footprintRect(entry, ctx) : null;
    occupants.push({ key: entryKey(index), label: entry.id, x: entry.position.x, z: entry.position.z, rect });
  });
  return { names, occupants };
}

function nameRules(entry: OverlayEntry, index: number, document: OverlayEntry[], prepared: Prepared, out: Conflict[]): void {
  if (entry.kind !== 'move') return;
  const name = entry.target.name;
  // `names` holds what `recordWorldReport` stored, which clamps each name to 200 chars; the normaliser clamps
  // a move's target to 200 too (`readName(…, 200)`). Both sides clamp to 200, so the comparison is consistent
  // and a long target still matches its long reported name.
  if (prepared.names.size > 0 && !prepared.names.has(name)) {
    out.push(warn('stale-name', `"${name}" is not among the ${prepared.names.size} known names this world last reported`));
  }
  document.forEach((other, j) => {
    if (j !== index && other.kind === 'move' && other.target.name === name) {
      out.push(warn('duplicate-target', `"${other.id}" also moves "${name}"; the last one wins`, other.id));
    }
  });
}

/** True when the position is refused. The caller stops there: a point outside the world has no ground to be under or over. */
function boundsRule(pos: Vec3, layout: WorldLayout, out: Conflict[]): boolean {
  const { min, max } = layout.bounds;
  for (const [axis, value, lo, hi] of [['x', pos.x, min.x, max.x], ['z', pos.z, min.z, max.z]] as const) {
    if (value < lo - BOUNDS_MARGIN || value > hi + BOUNDS_MARGIN) {
      const detail = `${axis} = ${fmt(value)} is outside the world's bounds (${lo} to ${hi}, ±${BOUNDS_MARGIN} m)`;
      out.push({ level: 'error', code: 'out-of-bounds', detail });
      // First offending axis wins; one Conflict per entry.
      return true;
    }
  }
  return false;
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
  } else if (mm(g - pos.y) > mm(UNDERGROUND_TOLERANCE)) {
    out.push(warn('underground', `bottom at y = ${fmt(pos.y)} is ${fmt(g - pos.y)} m under the ground at ${fmt(g)}`));
  } else if (mm(pos.y - g) > mm(FLOATING_TOLERANCE)) {
    out.push(warn('floating', `bottom at y = ${fmt(pos.y)} is ${fmt(pos.y - g)} m above the ground at ${fmt(g)}`));
  }
}

function conflictsWith(entry: OverlayEntry, index: number, document: OverlayEntry[], ctx: ConflictContext, prepared: Prepared): Conflict[] {
  const out: Conflict[] = [];
  nameRules(entry, index, document, prepared, out);
  const pos = entry.position;
  if (!pos || !ctx.layout) return out;
  if (boundsRule(pos, ctx.layout, out)) return out;
  if (ctx.ground) groundRule(pos, ctx.ground, out);
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
