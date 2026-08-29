import { groundAt, layersAt, type DecodedGround } from './mapLayout';
import { groundVerdict, type Conflict, type GroundVerdict } from './mapConflicts';
import type { HitCandidate } from './mapProjection';
import type { AppliedOutcome, UnresolvedOutcome } from './mapOverlay';
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
  /** The entry's document id — what the game's report names an entry by. */
  id: string;
  kind: 'move' | 'remove' | 'place';
  label: string;
  summary: string;
  level: RowLevel;
  conflicts: Conflict[];
  /**
   * What the game said of this entry the last time it applied the document, when it refused it:
   * `⛔ not applied — <reason>`. Null from `pendingRows`; `rowsWithVerdicts` fills it from the report.
   */
  verdict: string | null;
}

function vecText(p: Vec3): string {
  return `(${fmt(p.x)}, ${fmt(p.y)}, ${fmt(p.z)})`;
}

/**
 * A placed mount upgrade. A tier is not a stack - the applier holds one grant whatever `quantity` says -
 * so the editor shows no `×N` for it and offers no Quantity input.
 */
export function isMountPowerEntry(e: OverlayEntry): boolean {
  return e.kind === 'place' && e.item.config?.effect === 'grant_mount_power';
}

/** A placement's name for a row or a hover: `Loot Crate ×2`, or the bare name for a mount upgrade. */
function placeLabel(e: PlaceEntry): string {
  return isMountPowerEntry(e) ? e.item.name : `${e.item.name} ×${e.quantity}`;
}

/** Display rows for the pending list; `conflicts[i]` belongs to `entries[i]`. */
export function pendingRows(entries: Draft[], conflicts: Conflict[][]): PendingRow[] {
  return entries.map((e, i) => {
    const own = conflicts[i] ?? [];
    if (e.kind === 'move') {
      const yaw = e.rotationY !== undefined ? ` yaw ${Math.round(radToDeg(e.rotationY))}°` : '';
      return { key: e._key, id: e.id, kind: 'move', label: targetLabel(e.target), summary: `→ ${vecText(e.position)}${yaw}`, level: rowLevel(own), conflicts: own, verdict: null };
    }
    if (e.kind === 'remove') {
      return { key: e._key, id: e.id, kind: 'remove', label: targetLabel(e.target), summary: 'removed', level: rowLevel(own), conflicts: own, verdict: null };
    }
    return { key: e._key, id: e.id, kind: 'place', label: placeLabel(e), summary: `→ ${vecText(e.position)}`, level: rowLevel(own), conflicts: own, verdict: null };
  });
}

/**
 * The applier's verdict on each row, from the latest report's `unresolved` list, matched by id. An
 * admin placed nine mount upgrades on station; the game refused all nine with `item`; the card listed
 * nine ids with no names, and the admin read a Y problem into it. The refusal belongs on the ROW, beside
 * the item name that is already there. Matched by id because that is what the game names an entry by
 * and what survives an edit: a saved entry moved again keeps its id, and the game's last word on that id
 * stands until it is re-saved and re-applied; an entry minted since the report has an id the report
 * cannot hold and gets no verdict. The first listing of an id wins, as the applier pushes one per entry.
 * Rows come back by identity when there is nothing to say.
 *
 * A report judges ONE version - `appliedVersion` - and the page may since have saved another. A verdict
 * from an older report than the saved document names the version it judged (`not applied in v3`), so a
 * row the admin has already fixed is not read as still refused before the game has seen the fix. Both
 * versions omitted, or equal, is the plain verdict.
 */
export function rowsWithVerdicts(
  rows: PendingRow[],
  unresolved: ReadonlyArray<UnresolvedOutcome> | undefined,
  appliedVersion?: number,
  savedVersion?: number
): PendingRow[] {
  if (!unresolved?.length) return rows;
  const byId = new Map<string, string>();
  for (const u of unresolved) if (!byId.has(u.id)) byId.set(u.id, u.reason);
  const judged = appliedVersion !== savedVersion ? ` in v${appliedVersion}` : '';
  return rows.map((r) => {
    const reason = byId.get(r.id);
    return reason === undefined ? r : { ...r, verdict: `⛔ not applied${judged} — ${unresolvedText(reason)}` };
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

/**
 * What the report card says beside an unresolved id, keyed by the game's
 * reason. The keys ARE the applier's reasons — the `reason:` sites in
 * `src/systems/MapOverlay.js`, listed under "Applier reasons" in
 * `CONTRACTS.md` — and `mapReasonsContract.test.ts` reads that file and holds
 * this key set equal to it, so a reason the game grows or drops fails a test
 * here rather than printing raw on the card. `pending-rebuild` is hedged for
 * stage 2: the build saw an older document than the entry's, but nothing
 * resolves an `{id}` until stage 3, so a reload gets the build current without
 * making the entry apply. `no-loot` is the game's, not the world's: `Loot` is
 * injected once per session, so no world has it while another does.
 */
export const APPLIER_REASON_TEXT: ReadonlyMap<string, string> = new Map([
  ['pending-rebuild', "newer than the world's build — reload; ids resolve from stage 3"],
  ['span', 'refused — would drop more than 200 colliders; nothing hidden'],
  ['id', 'build-time target — nothing resolves ids until stage 3'],
  ['name', 'no object of that name in the world'],
  ['superseded', 'superseded by a later action on the same object'],
  ['error', 'the entry threw while being applied — see the game console'],
  ['item', 'the game cannot spawn this item as a pickup — only ammo packs, inventory items and mount upgrades the mount sells can be placed'],
  ['no-loot', 'the game has no loot system to spawn a placement in'],
  ['position', "the placement's position is not a finite point"],
  ['pool', "no pickup free to spawn it — the world's loot pool is full"],
]);

/** The words for a reason; an unknown one is printed as it came, so a reason the game grows first is still visible. */
export function unresolvedText(reason: string): string {
  return APPLIER_REASON_TEXT.get(reason) ?? reason;
}

export interface UnresolvedLine {
  id: string;
  /** The entry's item name or target, from the document on this page; null when the document no longer holds the id. */
  label: string | null;
  text: string;
}

/** What an entry is called wherever the editor names one: a placement by its item, an action by its target. */
function entryLabel(e: OverlayEntry): string {
  return e.kind === 'place' ? e.item.name : targetLabel(e.target);
}

/**
 * The report card's unresolved list, one line per entry the game refused, in the report's order: the
 * entry's label beside its id, and the applier's reason in words. The label comes from the document on
 * this page, matched by id (first wins, as `removeWarnings` matches); an id the document has lost since
 * the report — undone, or saved over — is listed by id alone, still visible.
 */
export function unresolvedLines(unresolved: ReadonlyArray<UnresolvedOutcome>, entries: Draft[]): UnresolvedLine[] {
  const byId = new Map<string, Draft>();
  for (const d of entries) if (!byId.has(d.id)) byId.set(d.id, d);
  return unresolved.map((u) => {
    const e = byId.get(u.id);
    return { id: u.id, label: e ? entryLabel(e) : null, text: unresolvedText(u.reason) };
  });
}

/**
 * The report card's two version lines. `applied` lags when the world was entered before the save (enter it again);
 * `built` lags when the world was BUILT before it - a cached world, which only a reload rebuilds (spec §7). A build
 * at 0 beside an applied version is a third thing, not "behind": no overlay reached that build. The game reads 0 on
 * five paths - no session (the provider is gated on the signed-in signal), the build's fuse fired first, the
 * background breaker was open, the read answered non-OK or threw, or the lookup landed a document with nothing saved
 * yet (ordinary first use) - and the card cannot tell them apart, so the line says only that, with the version a
 * reload would build against.
 */
export function versionStatus(applied: number, built: number, saved: number): { applied: string; built: string } {
  const word = (n: number, behind: string) => (n === saved ? '(current)' : n < saved ? behind : '(ahead of this page — reload the editor)');
  const builtWord = built === 0 && applied > 0 && saved > 0
    ? `(built with no overlay — reload to build against v${saved})`
    : word(built, '(behind — reload the world in game)');
  return { applied: word(applied, '(behind — enter the world in game)'), built: builtWord };
}

/**
 * How many colliders one prop plausibly owns. Above it a remove has almost
 * certainly swept OTHER objects' colliders: a large named container — a
 * 100 m terrain tile is a catalogue name — drops every collider fully inside
 * its box while staying under the applier's 200 cap, and the buildings stay
 * visible in their batches with nothing solid left in them (decision B, as
 * written; the applier does not refuse it, so the editor says so).
 *
 * Provenance: guessed. No per-prop collider maximum has been measured across
 * the worlds; raise it when a real remove of one prop trips it.
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
 * A report without the count reads as 0, as the store clamps it. An entry the
 * game did NOT apply (`ok: false`) warns nothing: its zero means "not hidden",
 * and the unresolved list already says why.
 *
 * Indexed once per call: the panel runs this on the deferred document, but a
 * report can list thousands of entries against a document of hundreds.
 */
export function removeWarnings(applied: ReadonlyArray<AppliedOutcome>, entries: Draft[]): RemoveWarning[] {
  const out: RemoveWarning[] = [];
  const byId = new Map<string, Draft>();
  for (const d of entries) if (!byId.has(d.id)) byId.set(d.id, d);   // first wins, as `find` did
  for (const a of applied) {
    if (!a.ok) continue;
    const e = byId.get(a.id);
    if (!e || e.kind !== 'remove') continue;
    const n = a.colliders ?? 0;
    if (n > WIDE_REMOVE_COLLIDERS) out.push({ id: a.id, text: `removed ${n} colliders — more than one object has; check the map` });
    else if (n === 0 && targetName(e.target) !== null) out.push({ id: a.id, text: 'removed, but nothing dropped: this object may still block' });
  }
  return out;
}

/**
 * The same two questions asked of an applied MOVE, which nothing asked before.
 *
 * A remove that dropped nothing has always warned, because hiding a mesh and
 * leaving its wall is the defect the applier exists to prevent. A move has
 * exactly the same failure and it was silent: the mesh goes to the new place,
 * the collision stays at the old one, and the row reads `ok: true`.
 *
 * The upper warning changed meaning with collider ownership and says so. When
 * the world knows whose a collider is, a large count is the ANSWER — a hab
 * stack owns hundreds — so it is not a problem to report; it is only worth
 * mentioning because an admin who expected to nudge a bench should notice.
 * When nothing owns the name the applier now REFUSES past 200 with `span`,
 * which arrives in the unresolved list rather than here.
 */
export function moveWarnings(applied: ReadonlyArray<AppliedOutcome>, entries: Draft[]): RemoveWarning[] {
  const out: RemoveWarning[] = [];
  const byId = new Map<string, Draft>();
  for (const d of entries) if (!byId.has(d.id)) byId.set(d.id, d);
  for (const a of applied) {
    if (!a.ok) continue;
    const e = byId.get(a.id);
    if (!e || e.kind !== 'move') continue;
    const n = a.colliders ?? 0;
    if (n > WIDE_REMOVE_COLLIDERS) out.push({ id: a.id, text: `moved ${n} colliders with it — check nothing else came along` });
    else if (n === 0 && targetName(e.target) !== null) out.push({ id: a.id, text: 'moved, but no collision came with it: there may be an invisible wall where it was' });
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
  const label = e.kind === 'place' ? placeLabel(e) : targetLabel(e.target);
  return { label, x: p.x, y: p.y, z: p.z };
}
