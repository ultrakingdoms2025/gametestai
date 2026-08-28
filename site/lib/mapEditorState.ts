import { groundAt, layersAt, type DecodedGround } from './mapLayout';
import { groundVerdict, type Conflict, type GroundVerdict } from './mapConflicts';
import type { HitCandidate } from './mapProjection';
import type { AppliedOutcome } from './mapOverlay';
import { targetLabel, targetName, type GrantConfig, type MoveEntry, type OverlayEntry, type PlaceEntry, type RemoveEntry, type Vec3 } from './mapOverlaySchema';

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
 * half-buried instead of popping up and then tripping `underground`. The
 * lift term is `authoredLift`, on its own so the layer picker adds the SAME
 * number to a chosen surface that a drag adds to the snapped one — the
 * panel's first version re-derived it and fell back to the bare surface
 * where the current position had no sample.
 *
 * ── One selection per move ─────────────────────────────────────────────────
 *
 * A move of a REPORTED target is selected as the object (`o:<name>`): the
 * map draws it as the object's `moved` ring and the picker lists it under
 * its family. A move of a name the game has not reported is selected as its
 * entry (`e:<key>`): the picker lists it under "moves by name". Both routes
 * into a selection — the canvas, the picker, the pending list, a typed name
 * — pass through `canonicalSelection`, so a row click and a mark click on
 * the same move cannot land on two different selections.
 *
 * ── The last action wins ───────────────────────────────────────────────────
 *
 * A saved document can carry two entries acting on one name (the normaliser
 * de-duplicates ids, not targets). The game applies a document in order, so
 * the LAST move-or-remove of a name is what the world shows, and
 * `mapConflicts.prepare` already composes it that way. Everything here that
 * resolves a name - `actionEntryFor`, and through it the selection, the
 * panel's fields, a drag's upsert, `removeFor` and the marks - reads the last
 * one too, so the map never draws a state the panel would not edit. A removed
 * object is drawn struck through where the game REPORTED it (a `{name}` has
 * no authored position) and cannot be dragged; Move here puts it back as a
 * move under the same key and id.
 *
 * ── The ground readout is the route's verdict ──────────────────────────────
 *
 * `groundStatus` is `mapConflicts.groundVerdict` with `null` for "nothing
 * wrong", so what the panel says about a typed Y before Move here is what the
 * save route will say after it — the same millimetre comparison, not a float
 * re-derivation that disagreed with it at the boundary.
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

/**
 * How far above (or, negative, below) its ground a prop was authored:
 * `y − ground(x, z, y)`. Null when there is no sample under it — the lift
 * is then unknown, not zero, and a caller must not pretend otherwise.
 */
export function authoredLift(ground: DecodedGround | null, from: Vec3): number | null {
  const here = groundAt(ground, from.x, from.z, from.y);
  return here === null ? null : from.y - here;
}

export function snappedY(ground: DecodedGround | null, from: Vec3, toX: number, toZ: number): number | null {
  if (!ground) return null;
  const there = groundAt(ground, toX, toZ, from.y);
  const lift = authoredLift(ground, from);
  if (there === null || lift === null) return null;
  return there + lift;
}

export type GroundStatus = GroundVerdict | 'ok';

/**
 * What the save route's ground rule would say about a bottom at `y` over
 * (x, z) — for the panel's readout of a TYPED position before it is
 * committed. Null with no grid: there is nothing to say.
 */
export function groundStatus(ground: DecodedGround | null, x: number, z: number, y: number): GroundStatus | null {
  if (!ground) return null;
  return groundVerdict({ x, y, z }, ground) ?? 'ok';
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
  kind: 'move' | 'remove' | 'place';
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
      return { key: e._key, kind: 'move', label: targetLabel(e.target), summary: `→ ${vecText(e.position)}${yaw}`, level: rowLevel(own), conflicts: own };
    }
    if (e.kind === 'remove') {
      return { key: e._key, kind: 'remove', label: targetLabel(e.target), summary: 'removed', level: rowLevel(own), conflicts: own };
    }
    return { key: e._key, kind: 'place', label: `${e.item.name} ×${e.quantity}`, summary: `→ ${vecText(e.position)}`, level: rowLevel(own), conflicts: own };
  });
}

/** The action that WINS for a name: the last move-or-remove of a `{name}` target in the document (see the header). */
export function actionEntryFor(entries: Draft[], name: string): (Draft & (MoveEntry | RemoveEntry)) | undefined {
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i];
    if (e.kind !== 'place' && targetName(e.target) === name) return e;
  }
  return undefined;
}

/** The move that wins for a name - only when the winning action IS a move. */
export function moveEntryFor(entries: Draft[], name: string): (Draft & MoveEntry) | undefined {
  const e = actionEntryFor(entries, name);
  return e?.kind === 'move' ? e : undefined;
}

/**
 * One move entry per target name. Editing an existing one — the last for
 * that name, the one that wins — updates it in place (same `_key`, same
 * `id`, same position in the document); a new one is appended. `mint`
 * supplies the key/id so the function stays pure.
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
  const existing = actionEntryFor(entries, name);
  if (existing) {
    // The winning entry becomes (or stays) the move, under its own key and id: Move here on a removed object puts it back.
    return entries.map((e) => {
      if (e !== existing) return e;
      const next: Draft & MoveEntry = { _key: existing._key, kind: 'move', id: existing.id, target: { name }, position: { ...position } };
      if (rotationY !== undefined) next.rotationY = rotationY;
      return next;
    });
  }
  const key = mint();
  const entry: Draft & MoveEntry = { _key: key, kind: 'move', id: key, target: { name }, position: { ...position } };
  if (rotationY !== undefined) entry.rotationY = rotationY;
  return [...entries, entry];
}

/**
 * One remove for a name, whatever the document said about it before: the
 * winning action becomes the remove under its own key and id, and any earlier
 * action on the name is dropped so the document carries one word about it.
 * A fixed point on a name already removed. `mint` supplies the key for a name
 * nothing acted on.
 */
export function removeFor(entries: Draft[], name: string, mint: () => string): Draft[] {
  const existing = actionEntryFor(entries, name);
  const remove = (key: string, id: string): Draft & RemoveEntry => ({ _key: key, kind: 'remove', id, target: { name } });
  if (!existing) {
    const key = mint();
    return [...entries, remove(key, key)];
  }
  return entries
    .filter((e) => e === existing || e.kind === 'place' || targetName(e.target) !== name)
    .map((e) => (e === existing ? remove(existing._key, existing.id) : e));
}

/** What the report card says beside an unresolved id. The reasons are the game's (`src/systems/MapOverlay.js`); an unknown one is printed as it came. */
export function unresolvedText(reason: string): string {
  switch (reason) {
    case 'pending-rebuild': return 'applies on next world load';
    case 'span': return 'refused — would drop more than 200 colliders; nothing hidden';
    case 'id': return 'build-time target — nothing resolves ids until stage 3';
    case 'name': return 'no object of that name in the world';
    case 'superseded': return 'superseded by a later action on the same object';
    default: return reason;
  }
}

/**
 * How many colliders one prop plausibly owns. Above it a remove has almost
 * certainly swept OTHER objects' colliders: a large named container — a
 * 100 m terrain tile is a catalogue name — drops every collider fully inside
 * its box while staying under the applier's 200 cap, and the buildings stay
 * visible in their batches with nothing solid left in them (decision B, as
 * written; the applier does not refuse it, so the editor says so).
 */
export const WIDE_REMOVE_COLLIDERS = 8;

export interface RemoveWarning {
  id: string;
  text: string;
}

/**
 * What the report card warns beside a remove the game APPLIED, matched by id
 * against the document on this page (what the game applied was a saved
 * version, and the id is what both share). Two states, from the applier's own
 * `colliders` count: 0 on a `{name}` remove means "hidden, but nothing dropped
 * — it may still block", the defect this stage exists to end; more than
 * `WIDE_REMOVE_COLLIDERS` means the box took other objects' colliders with it.
 * A report without the count reads as 0, as the store clamps it.
 */
export function removeWarnings(applied: ReadonlyArray<AppliedOutcome>, entries: Draft[]): RemoveWarning[] {
  const out: RemoveWarning[] = [];
  for (const a of applied) {
    const e = entries.find((d) => d.id === a.id);
    if (!e || e.kind !== 'remove') continue;
    const n = a.colliders ?? 0;
    if (n > WIDE_REMOVE_COLLIDERS) out.push({ id: a.id, text: `removed ${n} colliders — more than one object has; check the map` });
    else if (n === 0 && targetName(e.target) !== null) out.push({ id: a.id, text: 'removed, but nothing dropped: this object may still block' });
  }
  return out;
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

/**
 * Y for a placement clicked at (x, z): the LOWEST surface under the click
 * (spec §8 — under the station dome that is the deck, not the roof; the
 * layer picker is how a rooftop is chosen deliberately). 0 with no grid, and
 * 0 where the grid has no sample: the placement then sits on the origin
 * plane and the conflict pass says `no-ground`, which is the honest verdict.
 */
export function placementY(ground: DecodedGround | null, x: number, z: number): number {
  return layersAt(ground, x, z).at(-1) ?? 0;
}

/** The document entry a selection edits: an object's pending move, or the entry itself. */
export function selectedEntry(entries: Draft[], selected: Selected): Draft | undefined {
  if (!selected) return undefined;
  if (selected.kind === 'object') return actionEntryFor(entries, selected.name);
  return entries.find((e) => e._key === selected.key);
}

/** Where the selection currently is: its pending position if moved, else what the game reported. */
export function selectedPosition(
  objects: Array<{ name: string; position: Vec3 }>,
  entries: Draft[],
  selected: Selected
): Vec3 | null {
  if (!selected) return null;
  if (selected.kind === 'entry') {
    const e = entries.find((d) => d._key === selected.key);
    return e && e.kind !== 'remove' ? e.position : null;
  }
  const act = actionEntryFor(entries, selected.name);
  if (act?.kind === 'move') return act.position;
  // Unmoved, or removed: where the game reported it.
  return objects.find((o) => o.name === selected.name)?.position ?? null;
}

/**
 * The one form a selection of a move takes (see the header): an entry that
 * is a move of a REPORTED target becomes the object; an object the game did
 * not report becomes its move entry once it has one. Anything else — a
 * reported object, a placement, an unreported name with no move yet, an
 * unknown key, nothing — is returned as it was, by identity.
 */
export function canonicalSelection(objects: Array<{ name: string }>, entries: Draft[], sel: Selected): Selected {
  if (!sel) return null;
  if (sel.kind === 'entry') {
    const e = entries.find((d) => d._key === sel.key);
    if (e && e.kind !== 'place') {
      const name = targetName(e.target);
      if (name !== null && objects.some((o) => o.name === name)) return { kind: 'object', name };
    }
    return sel;
  }
  if (objects.some((o) => o.name === sel.name)) return sel;
  const act = actionEntryFor(entries, sel.name);
  return act ? { kind: 'entry', key: act._key } : sel;
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
  /** A reported object where the game reported it (no pending action). */
  | 'object'
  /** The faint dot at a moved object's reported position. */
  | 'origin'
  /** The ring at a moved object's pending position; `from` is its origin, for the dashed link. */
  | 'moved'
  /** A placement. */
  | 'place'
  /** A move whose target the game did not report — a free-text move. */
  | 'free'
  /** A removed object, struck through where the game reported it. */
  | 'removed';

/**
 * One mark on the map: a `HitCandidate` (so `hitTest` reads it as-is) plus
 * what to draw there. `r` is 0 on every mark because marks are drawn at a
 * fixed PIXEL radius, so their hit reach must not grow with zoom (`hitTest`
 * adds `r·scale`; at the maximum scale a 0.5 m radius would reach 200 px).
 */
export interface MapMark extends HitCandidate {
  r: 0;
  mark: MarkKind;
  from?: { x: number; z: number };
  /**
   * `false` on a mark that selects but never drags; absent means draggable.
   * A removed object has no pending position for a drag to edit, and a 3 px
   * drag on its mark would turn the remove into a move through the drag's
   * upsert — Save would write it. The canvas starts a `click` gesture, never
   * a `drag`, on a mark that says so.
   */
  draggable?: boolean;
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
  const out: MapMark[] = [];
  for (const o of objects) {
    const key = `o:${o.name}`;
    const act = actionEntryFor(entries, o.name);
    if (act?.kind === 'move') {
      out.push({ key, x: o.position.x, z: o.position.z, r: 0, mark: 'origin' });
      out.push({ key, x: act.position.x, z: act.position.z, r: 0, mark: 'moved', from: { x: o.position.x, z: o.position.z } });
    } else if (act?.kind === 'remove') {
      out.push({ key, x: o.position.x, z: o.position.z, r: 0, mark: 'removed', draggable: false });
    } else {
      out.push({ key, x: o.position.x, z: o.position.z, r: 0, mark: 'object' });
    }
  }
  const reported = new Set(objects.map((o) => o.name));
  for (const e of entries) {
    if (e.kind === 'place') out.push({ key: `e:${e._key}`, x: e.position.x, z: e.position.z, r: 0, mark: 'place' });
    else if (e.kind === 'move') {
      const name = targetName(e.target);
      if (name === null || !reported.has(name)) out.push({ key: `e:${e._key}`, x: e.position.x, z: e.position.z, r: 0, mark: 'free' });
    }
    // A remove of an unreported name has no position and no mark; the pending list and the picker reach it.
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
  if (sel.kind === 'object') {
    const act = actionEntryFor(entries, sel.name);
    return { label: act?.kind === 'remove' ? `${sel.name} — removed` : sel.name, x: p.x, y: p.y, z: p.z };
  }
  const e = entries.find((d) => d._key === sel.key);
  if (!e) return null;
  const label = e.kind === 'place' ? `${e.item.name} ×${e.quantity}` : targetLabel(e.target);
  return { label, x: p.x, y: p.y, z: p.z };
}
