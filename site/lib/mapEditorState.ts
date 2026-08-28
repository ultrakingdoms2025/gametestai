import { groundAt, type DecodedGround } from './mapLayout';
import type { Conflict } from './mapConflicts';
import type { HitCandidate } from './mapProjection';
import type { GrantConfig, MoveEntry, OverlayEntry, PlaceEntry, Vec3 } from './mapOverlaySchema';

/**
 * Every decision the map editor's DOM takes, as pure functions.
 *
 * ── Why the components decide nothing ──────────────────────────────────────
 *
 * The site's vitest runs with `environment: 'node'` and no DOM library, so a
 * component cannot be unit-tested here. Rather than add a DOM to the test
 * run, the canvas and panels are kept to drawing and forwarding events, and
 * everything they would have decided — what Y a dragged prop gets, what a
 * pending row says, which entry a selection maps to — lives here and is
 * tested against the real `groundAt`.
 *
 * ── The snap rule (spec §8) ────────────────────────────────────────────────
 *
 *     snappedY = ground(toX, toZ, y) + (y − ground(fromX, fromZ, y))
 *
 * The nearest surface at or below the prop's CURRENT y, plus its authored
 * sink or lift. A crate dragged across the station hub stays on the deck
 * rather than jumping onto the dome, and a rock authored half-buried stays
 * half-buried instead of popping up and then tripping `underground`.
 */

export type Selected = { kind: 'object'; name: string } | { kind: 'entry'; key: string } | null;

/** An overlay entry in the editor: the document's entry plus a stable React key that is never sent. */
export type Draft = OverlayEntry & { _key: string };

export const degToRad = (d: number): number => (d * Math.PI) / 180;
export const radToDeg = (r: number): number => (r * 180) / Math.PI;

export const NO_LAYOUT_TEXT = 'No layout yet — enter this world in game as admin';

/** One decimal, as the spec's mock prints coordinates. */
export function fmt(n: number): string {
  return (Math.round(n * 10) / 10).toFixed(1);
}

export function snappedY(ground: DecodedGround | null, from: Vec3, toX: number, toZ: number): number | null {
  if (!ground) return null;
  const there = groundAt(ground, toX, toZ, from.y);
  const here = groundAt(ground, from.x, from.z, from.y);
  if (there === null || here === null) return null;
  return there + (from.y - here);
}

export function layoutAgeText(reportedAt: string | null, now: Date): string {
  if (!reportedAt) return NO_LAYOUT_TEXT;
  const t = Date.parse(reportedAt);
  if (!Number.isFinite(t)) return NO_LAYOUT_TEXT;
  const s = Math.max(0, Math.floor((now.getTime() - t) / 1000));
  if (s < 60) return 'reported just now';
  if (s < 3600) return `reported ${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `reported ${Math.floor(s / 3600)} h ago`;
  return `reported ${Math.floor(s / 86400)} d ago`;
}

export type RowLevel = 'ok' | 'warn' | 'error';

export function rowLevel(conflicts: Conflict[]): RowLevel {
  let level: RowLevel = 'ok';
  for (const c of conflicts) {
    if (c.level === 'error') return 'error';
    level = 'warn';
  }
  return level;
}

export interface PendingRow {
  key: string;
  kind: 'move' | 'place';
  label: string;
  summary: string;
  level: RowLevel;
  conflicts: Conflict[];
}

function vecText(p: Vec3): string {
  return `(${fmt(p.x)}, ${fmt(p.y)}, ${fmt(p.z)})`;
}

/** Display rows for the pending list; `conflicts[i]` belongs to `entries[i]`. */
export function pendingRows(entries: Draft[], conflicts: Conflict[][]): PendingRow[] {
  return entries.map((e, i) => {
    const own = conflicts[i] ?? [];
    if (e.kind === 'move') {
      const yaw = e.rotationY !== undefined ? ` yaw ${Math.round(radToDeg(e.rotationY))}°` : '';
      const summary = e.position ? `→ ${vecText(e.position)}${yaw}${e.hidden ? ' (hidden)' : ''}` : 'hidden';
      return { key: e._key, kind: 'move', label: e.target.name, summary, level: rowLevel(own), conflicts: own };
    }
    return {
      key: e._key,
      kind: 'place',
      label: `${e.item.name} ×${e.quantity}`,
      summary: `→ ${vecText(e.position)}`,
      level: rowLevel(own),
      conflicts: own,
    };
  });
}

export function moveEntryFor(entries: Draft[], name: string): (Draft & MoveEntry) | undefined {
  return entries.find((e): e is Draft & MoveEntry => e.kind === 'move' && e.target.name === name);
}

/**
 * One move entry per target name. Editing an existing one updates it in
 * place (same `_key`, same `id`, same position in the document); a new one
 * is appended. `mint` supplies the key/id so the function stays pure.
 *
 * `rotationY: undefined` CLEARS an existing rotation — the argument is the
 * whole new transform, not a patch. A caller that means "keep it" passes
 * the entry's own value (the panel's drag passes `mv?.rotationY`).
 *
 * The position is COPIED, as `placeAt` copies its config: a caller that
 * keeps mutating its own Vec3 (a drag's scratch point) must not reach into
 * the document through it.
 */
export function upsertMoveFor(
  entries: Draft[],
  name: string,
  position: Vec3,
  rotationY: number | undefined,
  mint: () => string
): Draft[] {
  const existing = moveEntryFor(entries, name);
  if (existing) {
    return entries.map((e) => {
      if (e !== existing) return e;
      const next: Draft & MoveEntry = { ...existing, position: { ...position } };
      if (rotationY === undefined) delete next.rotationY;
      else next.rotationY = rotationY;
      return next;
    });
  }
  const key = mint();
  const entry: Draft & MoveEntry = { _key: key, kind: 'move', id: key, target: { name }, position: { ...position } };
  if (rotationY !== undefined) entry.rotationY = rotationY;
  return [...entries, entry];
}

/** A place draft for a catalogue item at a point. The config is COPIED (see `mapOverlaySchema.ts`). */
export function placeAt(
  item: { source_key: string; name: string; config: GrantConfig },
  x: number,
  y: number,
  z: number,
  mint: () => string
): Draft & PlaceEntry {
  const key = mint();
  return {
    _key: key,
    kind: 'place',
    id: key,
    item: { source_key: item.source_key, name: item.name, config: { ...item.config } },
    position: { x, y, z },
    quantity: 1,
  };
}

/** The document entry a selection edits: an object's pending move, or the entry itself. */
export function selectedEntry(entries: Draft[], selected: Selected): Draft | undefined {
  if (!selected) return undefined;
  if (selected.kind === 'object') return moveEntryFor(entries, selected.name);
  return entries.find((e) => e._key === selected.key);
}

/** Where the selection currently is: its pending position if moved, else what the game reported. */
export function selectedPosition(
  objects: Array<{ name: string; position: Vec3 }>,
  entries: Draft[],
  selected: Selected
): Vec3 | null {
  if (!selected) return null;
  if (selected.kind === 'entry') return entries.find((e) => e._key === selected.key)?.position ?? null;
  const mv = moveEntryFor(entries, selected.name);
  if (mv?.position) return mv.position;
  return objects.find((o) => o.name === selected.name)?.position ?? null;
}

/** The one string the canvas, the picker and the pending list use to name a selection: `o:<name>` or `e:<key>`. */
export function selectionKey(sel: Selected): string | null {
  if (!sel) return null;
  return sel.kind === 'object' ? `o:${sel.name}` : `e:${sel.key}`;
}

/** Inverse of `selectionKey` for a non-empty key; a caller maps `''` to `null` itself. */
export function selectionFromKey(key: string): NonNullable<Selected> {
  return key.startsWith('o:') ? { kind: 'object', name: key.slice(2) } : { kind: 'entry', key: key.slice(2) };
}

/* ── What the canvas draws and hit-tests ──────────────────────────────────── */

export type MarkKind =
  /** A reported object where the game reported it (no pending move, or a hide-only move). */
  | 'object'
  /** The faint dot at a moved object's reported position. */
  | 'origin'
  /** The ring at a moved object's pending position; `from` is its origin, for the dashed link. */
  | 'moved'
  /** A placement. */
  | 'place'
  /** A move whose target the game did not report — a free-text move. */
  | 'free';

/**
 * One mark on the map: a `HitCandidate` (so `hitTest` reads it as-is) plus
 * what to draw there. `r` is 0 on every mark because marks are drawn at a
 * fixed PIXEL radius, so their hit reach must not grow with zoom (`hitTest`
 * adds `r·scale`; at the maximum scale a 0.5 m radius would reach 200 px).
 */
export interface MapMark extends HitCandidate {
  r: 0;
  mark: MarkKind;
  hidden?: boolean;
  from?: { x: number; z: number };
}

/** What the hover label says for a mark. */
export interface HoverInfo {
  label: string;
  x: number;
  y: number;
  z: number;
}

/**
 * Every selectable mark and where it is. A reported object appears under ONE
 * key at its reported AND its pending position, both selecting the object; a
 * placement at its position; a move only when its target is unreported (a
 * reported target's move is already the object's `moved` mark).
 */
export function hitCandidates(objects: Array<{ name: string; position: Vec3 }>, entries: Draft[]): MapMark[] {
  const moveByName = new Map<string, Draft & MoveEntry>();
  for (const e of entries) if (e.kind === 'move') moveByName.set(e.target.name, e);
  const out: MapMark[] = [];
  for (const o of objects) {
    const key = `o:${o.name}`;
    const mv = moveByName.get(o.name);
    if (mv?.position) {
      out.push({ key, x: o.position.x, z: o.position.z, r: 0, mark: 'origin' });
      out.push({ key, x: mv.position.x, z: mv.position.z, r: 0, mark: 'moved', from: { x: o.position.x, z: o.position.z } });
    } else {
      out.push({ key, x: o.position.x, z: o.position.z, r: 0, mark: 'object', hidden: mv?.hidden === true });
    }
  }
  const reported = new Set(objects.map((o) => o.name));
  for (const e of entries) {
    if (e.kind === 'place') out.push({ key: `e:${e._key}`, x: e.position.x, z: e.position.z, r: 0, mark: 'place' });
    else if (e.position && !reported.has(e.target.name)) {
      out.push({ key: `e:${e._key}`, x: e.position.x, z: e.position.z, r: 0, mark: 'free' });
    }
  }
  return out;
}

/**
 * The hover label for a mark's key: an object's name, `item ×qty` for a
 * placement, the target name for a free move. The position is where the
 * selection currently IS (`selectedPosition`), so hovering a moved object's
 * origin dot reads its pending coordinates — the same numbers the panel shows.
 */
export function hoverInfoFor(objects: Array<{ name: string; position: Vec3 }>, entries: Draft[], key: string): HoverInfo | null {
  const sel = selectionFromKey(key);
  const p = selectedPosition(objects, entries, sel);
  if (!p) return null;
  if (sel.kind === 'object') return { label: sel.name, x: p.x, y: p.y, z: p.z };
  const e = entries.find((d) => d._key === sel.key);
  if (!e) return null;
  const label = e.kind === 'place' ? `${e.item.name} ×${e.quantity}` : e.target.name;
  return { label, x: p.x, y: p.y, z: p.z };
}
