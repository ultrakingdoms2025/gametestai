'use client';

import { useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from 'react';
import { OVERLAY_WORLDS, round, type GrantConfig, type OverlayEntry, type OverlayWorld, type Vec3 } from '@/lib/mapOverlaySchema';
import type { MarketplaceItemRecord } from '@/lib/marketplaceCatalog';
import type { CatalogueObject, OverlayVersionRow, WorldReport } from '@/lib/mapOverlay';
import type { WorldLayout } from '@/lib/mapLayout';
import { conflictContextFor, conflictsForDocument, hasErrors, type Conflict } from '@/lib/mapConflicts';
import {
  canonicalSelection,
  layoutAgeText,
  moveEntryFor,
  pendingRows,
  placeAt,
  placementY,
  selectedEntry,
  selectedPosition,
  snappedY,
  upsertMoveFor,
  type Draft,
  type Selected,
} from '@/lib/mapEditorState';
import MapCanvas from './MapCanvas';
import MapPendingList from './MapPendingList';
import MapSelectionPanel from './MapSelectionPanel';
import { card, coord, dim, input, label, statusColour, subtle, warnColour } from './mapEditorStyles';

/**
 * The map editor.
 *
 * ── What it edits, and what it deliberately is not ─────────────────────────
 *
 * A map over a placement overlay — a versioned document of moved and placed
 * instances the game applies AFTER a world has finished building. The map is
 * a top-down drawing of what the admin's own game reported (bounds, floorplan
 * shapes, a physics-sampled ground grid), not a second copy of the world: a
 * 3D viewport here would need the whole procedural world built again in a
 * second engine, which is exactly the "two places world geometry lives"
 * problem the overlay exists to avoid.
 *
 * ── Where the names and the ground come from ───────────────────────────────
 *
 * From the running game. Nothing on the server knows what `MedievalWorld.js`
 * built; an admin's client posts the world's named objects and its layout
 * back after it applies the overlay. Until a world has been visited by an
 * admin the map is an empty ±100 m square, the picker is empty, and a move
 * can still be typed by name — honest about what is known.
 *
 * ── Decisions live elsewhere ───────────────────────────────────────────────
 *
 * This component owns state and fetches. What a drag does to Y, what a row
 * says, which selection a move is, what conflicts an entry has —
 * `mapEditorState.ts`, `mapConflicts.ts` — are pure and tested. The save
 * route runs the same `conflictsForDocument`; a client that skipped it could
 * not save an invalid document.
 *
 * ── Conflicts follow a deferred document, and Save knows it ────────────────
 *
 * The conflict check is O(entries × objects) — up to 500 × 2 000 distance
 * tests — and a drag edits the document every pointer frame. The check runs
 * on `useDeferredValue(entries)`, so a frame paints first and the check runs
 * when React has a moment. Two consequences are handled explicitly: the
 * results are keyed by `_key`, never by index, so a row removed by undo
 * cannot lend its neighbour its old conflicts for a frame; and Save is
 * disabled, labelled `Checking…`, for exactly the window in which the
 * deferred document is behind the live one — `dirty` flips in the urgent
 * render, and Save must never be judged on stale conflicts.
 *
 * ── The layout keeps its identity across fetches ───────────────────────────
 *
 * `MapCanvas` refits — throwing away the admin's pan and zoom — whenever the
 * `layout` REFERENCE changes, and every GET parses a fresh object. A
 * response for the same world with the same `reportedAt` is the same stored
 * report, so `adoptLayout` keeps the reference it already holds; only a new
 * world or a newer report swaps it. A save, a revert and the refresh after a
 * rejected save all re-GET, and none of them moves the map.
 *
 * ── A rejected save is not an error message ────────────────────────────────
 *
 * The route answers `400 { error: 'conflicts', rejected }` only for an
 * error-level conflict, and the client ran the same check and passed, so it
 * can only mean this page's layout is older than the server's. The rejected
 * rows are outlined, the layout, report and versions are re-fetched, and the
 * entries are left alone — the unsaved edits are the point. Against the
 * fresh layout the rows then show their real ⛔ and Save disables itself.
 */

function newKey(): string {
  return `k${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
}

function withKeys(entries: OverlayEntry[]): Draft[] {
  return entries.map((e) => ({ ...e, _key: newKey() }) as Draft);
}

function stripKeys(entries: Draft[]): OverlayEntry[] {
  return entries.map(({ _key: _unused, ...rest }) => rest as OverlayEntry);
}

function num(value: string): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

/** What `GET /api/admin/map/{world}` answers (chunk 2); `error` when it is not 2xx. */
interface WorldResponse {
  overlay: { version?: number; entries?: OverlayEntry[] };
  versions?: OverlayVersionRow[];
  report?: WorldReport | null;
  layout?: WorldLayout | null;
  reportedAt?: string | null;
  error?: string;
}

interface SaveRejection {
  index: number;
  id: string | null;
  reason: string;
}

const NO_KEYS: ReadonlySet<string> = new Set();
const NO_CONFLICTS: Conflict[] = [];

export function MapEditorPanel() {
  const [world, setWorld] = useState<OverlayWorld>('station');
  const [entries, setEntries] = useState<Draft[]>([]);
  const [savedVersion, setSavedVersion] = useState(0);
  const [versions, setVersions] = useState<OverlayVersionRow[]>([]);
  const [report, setReport] = useState<WorldReport | null>(null);
  const [layout, setLayout] = useState<WorldLayout | null>(null);
  const [reportedAt, setReportedAt] = useState<string | null>(null);
  const [catalogue, setCatalogue] = useState<MarketplaceItemRecord[]>([]);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [dirty, setDirty] = useState(false);
  const [selected, setSelectedRaw] = useState<Selected>(null);
  const [placeItem, setPlaceItem] = useState<MarketplaceItemRecord | null>(null);
  const [rejectedKeys, setRejectedKeys] = useState<ReadonlySet<string>>(NO_KEYS);
  /* Set after mount so the server render and the first client render agree
   * (a clock read during render is a hydration mismatch waiting to happen). */
  const [now, setNow] = useState<Date | null>(null);

  useEffect(() => {
    setNow(new Date());
    const t = setInterval(() => setNow(new Date()), 30_000);
    return () => clearInterval(t);
  }, []);

  /* Escape disarms a placement. The hint's Cancel button is the pointer's
   * way out of place mode; the keyboard needs one too. */
  useEffect(() => {
    if (!placeItem) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setPlaceItem(null);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [placeItem]);

  /* Which world and report the held `layout` came from (see the header). */
  const heldLayout = useRef<{ world: OverlayWorld; reportedAt: string | null } | null>(null);
  const adoptLayout = useCallback((which: OverlayWorld, data: WorldResponse) => {
    const at = typeof data.reportedAt === 'string' ? data.reportedAt : null;
    const held = heldLayout.current;
    if (held && held.world === which && held.reportedAt === at) return;
    heldLayout.current = { world: which, reportedAt: at };
    setLayout(data.layout ?? null);
    setReportedAt(at);
  }, []);

  /* `keepMessage`: a save or a revert sets its message and then reloads.
   * `load` runs synchronously to its first await, so its own
   * `setMessage('')` lands in the SAME React batch as the caller's, and the
   * batch's last write — the blank — is what renders. A caller with
   * something to say asks the reload not to clear it. */
  /* Loads can overlap — a world switch while the first load is in flight, a
   * save's reload against a switch — and whichever response arrived LAST
   * would win, for whichever world it was. Each load takes a sequence
   * number; a response that is no longer the latest touches nothing, not
   * even `busy`, which the latest one still owns. */
  const loadSeq = useRef(0);
  const load = useCallback(
    async (which: OverlayWorld, opts: { keepMessage?: boolean } = {}) => {
      const seq = ++loadSeq.current;
      setBusy(true);
      if (!opts.keepMessage) setMessage('');
      try {
        const res = await fetch(`/api/admin/map/${which}`, { cache: 'no-store' });
        const data = (await res.json()) as WorldResponse;
        if (seq !== loadSeq.current) return;
        if (!res.ok) throw new Error(data?.error || 'Could not load the overlay.');
        setEntries(withKeys(data.overlay.entries ?? []));
        setSavedVersion(data.overlay.version ?? 0);
        setVersions(data.versions ?? []);
        setReport(data.report ?? null);
        adoptLayout(which, data);
        setDirty(false);
        setNote('');
        setSelectedRaw(null);
        setPlaceItem(null);
        setRejectedKeys(NO_KEYS);
      } catch (error) {
        if (seq !== loadSeq.current) return;
        setMessage(error instanceof Error ? error.message : 'Could not load the overlay.');
        /* Nothing of the world that was showing may stay on the page under
         * the name of the one that failed to load: a dirty document from
         * world A would otherwise POST to /api/admin/map/B. */
        heldLayout.current = null;
        setLayout(null);
        setReportedAt(null);
        setEntries([]);
        setVersions([]);
        setReport(null);
        setSavedVersion(0);
        setDirty(false);
        setNote('');
        setSelectedRaw(null);
        setPlaceItem(null);
        setRejectedKeys(NO_KEYS);
      } finally {
        if (seq === loadSeq.current) setBusy(false);
      }
    },
    [adoptLayout]
  );

  const loadCatalogue = useCallback(async (which: OverlayWorld) => {
    try {
      // The catalogue is per-world for the six worlds that have shops. Every
      // other world gets the whole list: an admin placing a crate on a planet
      // is not restricted to what a vendor there would sell.
      const res = await fetch(`/api/admin/marketplace/items?activeOnly=1&search=`, { cache: 'no-store' });
      if (!res.ok) return;
      const data = await res.json();
      const items: MarketplaceItemRecord[] = data.items ?? [];
      const forWorld = items.filter((i) => i.world_name === which);
      setCatalogue(forWorld.length ? forWorld : items);
    } catch {
      setCatalogue([]);
    }
  }, []);

  useEffect(() => {
    void load(world);
    void loadCatalogue(world);
  }, [world, load, loadCatalogue]);

  const objects = useMemo<CatalogueObject[]>(() => report?.objects ?? [], [report]);

  /* Built once per layout or report, not per document change: it decodes
   * the ground grid, and the same decoded grid drives snapping and the
   * canvas. */
  const ctx = useMemo(() => conflictContextFor(layout, objects), [layout, objects]);
  const ground = ctx.ground;

  const deferredEntries = useDeferredValue(entries);
  const conflicts = useMemo(() => conflictsForDocument(stripKeys(deferredEntries), ctx), [deferredEntries, ctx]);
  const conflictByKey = useMemo(
    () => new Map(deferredEntries.map((e, i) => [e._key, conflicts[i] ?? NO_CONFLICTS])),
    [deferredEntries, conflicts]
  );
  /* Rebuilt in LIVE order: `pendingRows` aligns by index, and the live
   * document may have lost or gained a row since the deferred one. */
  const rows = useMemo(
    () => pendingRows(entries, entries.map((e) => conflictByKey.get(e._key) ?? NO_CONFLICTS)),
    [entries, conflictByKey]
  );
  const blocked = hasErrors(conflicts);
  const checking = deferredEntries !== entries;

  const selEntry = selectedEntry(entries, selected);
  const selConflicts = selEntry ? (conflictByKey.get(selEntry._key) ?? NO_CONFLICTS) : NO_CONFLICTS;

  /* Every route into a selection — the canvas, the picker, a typed name, a
   * pending row — passes through here, so a move is selected in its one
   * canonical form (see `canonicalSelection`). */
  const setSelected = useCallback(
    (sel: Selected) => setSelectedRaw(canonicalSelection(objects, entries, sel)),
    [objects, entries]
  );

  /* Every edit goes through here: the document changes, the version is dirty,
   * and the server's last rejection no longer applies to these rows. A drag's
   * intermediate frames pass `commit = false` so dirtiness lands once, on release. */
  const edit = useCallback((fn: (list: Draft[]) => Draft[], commit = true) => {
    setEntries(fn);
    if (commit) {
      setDirty(true);
      setRejectedKeys(NO_KEYS);
    }
  }, []);

  /* Where the current drag started. Captured on the FIRST 'move' frame —
   * the entry's or object's position before any drag edit — and used as
   * `from` for every frame including 'end' (which a cancelled pointer also
   * sends), then cleared. Snapping from the previous frame's output instead
   * re-derives the lift each frame: at a dome edge a lift larger than the
   * gap re-anchors to the layer above and climbs, and a NO_SAMPLE cell
   * crossed and left loses the lift entirely. */
  const dragFromRef = useRef<Vec3 | null>(null);

  function moveSelection(target: NonNullable<Selected>, x: number, z: number, phase: 'move' | 'end') {
    if (!dragFromRef.current) {
      dragFromRef.current = selectedPosition(objects, entries, target) ?? { x, y: 0, z };
    }
    const from = dragFromRef.current;
    /* Stored at the three places the schema keeps, so the conflicts this
     * page computes are computed on the document the server will see. */
    const position: Vec3 = { x: round(x, 3), y: round(snappedY(ground, from, x, z) ?? from.y, 3), z: round(z, 3) };
    edit((list) => {
      if (target.kind === 'object') {
        return upsertMoveFor(list, target.name, position, moveEntryFor(list, target.name)?.rotationY, newKey);
      }
      return list.map((e) => (e._key === target.key && e.position ? ({ ...e, position } as Draft) : e));
    }, phase === 'end');
    if (phase === 'end') dragFromRef.current = null;
  }

  function commitTransform(sel: NonNullable<Selected>, position: Vec3, rotationY: number | undefined) {
    if (sel.kind === 'object') {
      /* The key is minted here, not inside the updater: a name the game has
       * not reported is selected as its entry the moment it has a move
       * (`canonicalSelection`), and that entry's key is this one. */
      const key = moveEntryFor(entries, sel.name)?._key ?? newKey();
      edit((list) => upsertMoveFor(list, sel.name, position, rotationY, () => key));
      if (!objects.some((o) => o.name === sel.name)) setSelectedRaw({ kind: 'entry', key });
      return;
    }
    edit((list) =>
      list.map((e) => {
        if (e._key !== sel.key) return e;
        const next = { ...e, position } as Draft;
        if (rotationY === undefined) delete (next as { rotationY?: number }).rotationY;
        else next.rotationY = rotationY;
        return next;
      })
    );
  }

  function removeEntry(key: string) {
    edit((list) => list.filter((e) => e._key !== key));
    if (selected?.kind === 'entry' && selected.key === key) setSelectedRaw(null);
  }

  function resetSelection(sel: NonNullable<Selected>) {
    if (sel.kind !== 'object') return;
    const mv = moveEntryFor(entries, sel.name);
    if (mv) removeEntry(mv._key);
  }

  function placeHere(x: number, z: number) {
    if (!placeItem) return;
    // Y from the LOWEST layer under the click (spec §8, `placementY`); the
    // layer picker in the selection panel is how a rooftop is chosen deliberately.
    const y = placementY(ground, x, z);
    const draft = placeAt(
      {
        source_key: placeItem.source_key ?? placeItem.id,
        name: placeItem.name,
        // Copied, not referenced: what this crate contains is a decision taken
        // now, and re-authoring the catalogue row later must not change it.
        config: (placeItem.action_config ?? {}) as GrantConfig,
      },
      round(x, 3),
      y,
      round(z, 3),
      newKey
    );
    edit((list) => [...list, draft]);
    setSelectedRaw({ kind: 'entry', key: draft._key });
    setPlaceItem(null);
  }

  function setHidden(key: string, hidden: boolean) {
    edit((list) =>
      list.map((e) => {
        if (e._key !== key || e.kind !== 'move') return e;
        const next = { ...e } as Draft & { hidden?: true };
        if (hidden) next.hidden = true;
        else delete next.hidden;
        return next;
      })
    );
  }

  function setQuantity(key: string, value: string) {
    const quantity = Math.max(1, Math.min(99, Math.floor(num(value)) || 1));
    edit((list) => list.map((e) => (e._key === key && e.kind === 'place' ? ({ ...e, quantity } as Draft) : e)));
  }

  async function save() {
    setBusy(true);
    setMessage('');
    /* The snapshot that is sent: a rejection's `index` points into it. */
    const sent = entries;
    try {
      const res = await fetch(`/api/admin/map/${world}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ entries: stripKeys(sent), note: note || null }),
      });
      const data = await res.json();
      if (res.status === 400 && data?.error === 'conflicts' && Array.isArray(data.rejected)) {
        const rejected = data.rejected as SaveRejection[];
        const keys = new Set<string>();
        for (const r of rejected) {
          const e = sent[r.index];
          if (e) keys.add(e._key);
        }
        setRejectedKeys(keys);
        /* Refresh what the server sees — layout, report, versions — but NOT
         * the entries (see the header). Not under `loadSeq`: `busy` disables
         * the world select for the whole of save(), so no load can overlap
         * this re-GET, and it reads the closure's `world`, the one the save
         * was for. */
        let refreshed = false;
        try {
          const fresh = await fetch(`/api/admin/map/${world}`, { cache: 'no-store' });
          if (fresh.ok) {
            const cur = (await fresh.json()) as WorldResponse;
            adoptLayout(world, cur);
            setReport(cur.report ?? null);
            setVersions(cur.versions ?? []);
            refreshed = true;
          }
        } catch {
          /* reported in the message below */
        }
        const reasons = [...new Set(rejected.map((r) => r.reason))].join(', ');
        const found = `Not saved: the server found ${rejected.length} error${rejected.length === 1 ? '' : 's'} (${reasons})`;
        setMessage(
          refreshed
            ? `${found} against a newer layout — layout refreshed, fix the outlined rows.`
            : `${found} — could not refresh the layout; reload the world.`
        );
        return;
      }
      if (!res.ok) throw new Error(data?.error || 'Save failed.');
      const rejected = data.overlay?.rejected ?? [];
      setMessage(
        rejected.length
          ? `Saved version ${data.overlay.version}. ${rejected.length} entr${rejected.length === 1 ? 'y was' : 'ies were'} rejected: ${rejected.map((r: { reason: string }) => r.reason).join(', ')}.`
          : `Saved version ${data.overlay.version}. Reload the world in game to see it.`
      );
      await load(world, { keepMessage: true });
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Save failed.');
    } finally {
      setBusy(false);
    }
  }

  async function revert(version: number) {
    if (!confirm(`Revert ${world} to version ${version}? This writes a new version holding those entries; nothing is deleted.`)) return;
    setBusy(true);
    setMessage('');
    try {
      const res = await fetch(`/api/admin/map/${world}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ revertTo: version }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error || 'Revert failed.');
      setMessage(`Reverted to version ${version}, saved as version ${data.overlay.version}.`);
      await load(world, { keepMessage: true });
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Revert failed.');
    } finally {
      setBusy(false);
    }
  }

  const groundSummary = ground
    ? `${ground.nx}×${ground.nz} ground samples, ${ground.layers} layer${ground.layers === 1 ? '' : 's'}`
    : 'no ground grid yet';

  return (
    <div style={{ display: 'grid', gap: 16 }}>
      <div className="banner" role="status" data-e2e="layout-banner" style={{ marginBottom: 0, alignItems: 'center' }}>
        <b>Layout</b>
        <span data-e2e="layout-age">{now ? layoutAgeText(reportedAt, now) : '…'}</span>
        {layout ? (
          <span style={{ color: dim }}>
            · {layout.shapes.length} shape{layout.shapes.length === 1 ? '' : 's'} · {groundSummary}
          </span>
        ) : null}
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1.35fr 1fr', gap: 20, alignItems: 'start' }}>
        <section style={card}>
          <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'end', marginBottom: 14 }}>
            <label style={label}>
              World
              <select
                style={input}
                data-e2e="world-select"
                value={world}
                onChange={(e) => setWorld(e.target.value as OverlayWorld)}
                disabled={busy}
              >
                {OVERLAY_WORLDS.map((w) => (
                  <option key={w} value={w}>{w}</option>
                ))}
              </select>
            </label>
            <button
              className="btn btn-primary"
              type="button"
              data-e2e="save"
              onClick={() => void save()}
              disabled={busy || !dirty || blocked || checking}
              title={blocked ? 'An error-level conflict must be fixed before this version can be saved.' : undefined}
            >
              {busy ? 'Working…' : !dirty ? `Saved (v${savedVersion})` : checking ? 'Checking…' : blocked ? 'Fix errors to save' : 'Save new version'}
            </button>
          </div>

          {/* A busy page (a save, a load) must not take a drag it cannot
            * apply; the canvas has no `disabled`, so the pointer is fenced. */}
          <div style={{ pointerEvents: busy ? 'none' : 'auto' }}>
            <MapCanvas
              layout={layout}
              ground={ground}
              objects={objects}
              entries={entries}
              selected={selected}
              placeMode={placeItem !== null}
              onSelect={setSelected}
              onDrag={moveSelection}
              onPlaceAt={placeHere}
            />
          </div>
          <p style={{ margin: '8px 0 14px', fontSize: 11, color: subtle }}>
            Click a mark to select it; drag a selected mark to move it; wheel to zoom about the cursor; drag empty
            ground, the middle button or hold Space to pan. North is up (−Z).
            {placeItem ? (
              <>
                {' '}<b style={{ color: warnColour }}>Placing {placeItem.name}</b> — click empty ground.{' '}
                <button type="button" className="btn btn-ghost btn-sm" data-e2e="cancel-place" onClick={() => setPlaceItem(null)}>Cancel</button>
              </>
            ) : null}
          </p>

          <h2 style={{ margin: '0 0 8px', fontSize: 15 }}>Pending changes (this version)</h2>
          <MapPendingList
            rows={rows}
            selectedKey={selEntry?._key ?? null}
            rejectedKeys={rejectedKeys}
            disabled={busy}
            onSelect={(key) => setSelected({ kind: 'entry', key })}
            onUndo={removeEntry}
          />

          <label style={{ ...label, margin: '14px 0 0' }}>
            Note (optional — shown in the version history and the audit log)
            <input style={input} data-e2e="note" value={note} onChange={(e) => setNote(e.target.value)} placeholder="what changed and why" />
          </label>

          {/* Always mounted: a live region announces a change to a node
            * that already exists, not one that appears with its text. */}
          <p data-e2e="message" style={{ margin: message ? '14px 0 0' : 0, color: statusColour, fontSize: 13 }} role="status">{message}</p>
        </section>

        <div style={{ display: 'grid', gap: 20 }}>
          <section style={card}>
            <h2 style={{ margin: '0 0 10px', fontSize: 15 }}>Selection</h2>
            <MapSelectionPanel
              objects={objects}
              entries={entries}
              selected={selected}
              ground={ground}
              conflicts={selConflicts}
              disabled={busy}
              onSelect={setSelected}
              onCommit={commitTransform}
              onReset={resetSelection}
              onRemoveEntry={removeEntry}
            />
            {selEntry?.kind === 'move' ? (
              <label style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 12, color: '#cfe6f2', marginTop: 10 }}>
                <input
                  type="checkbox"
                  data-e2e="hidden"
                  checked={Boolean(selEntry.hidden)}
                  disabled={busy}
                  onChange={(e) => setHidden(selEntry._key, e.target.checked)}
                />
                Hide this object instead of only moving it
              </label>
            ) : null}
            {selEntry?.kind === 'place' ? (
              <label style={{ ...label, maxWidth: 160, marginTop: 10 }}>
                Quantity
                <input
                  style={coord}
                  data-e2e="quantity"
                  type="number"
                  min={1}
                  max={99}
                  value={selEntry.quantity}
                  disabled={busy}
                  onChange={(e) => setQuantity(selEntry._key, e.target.value)}
                />
              </label>
            ) : null}
          </section>

          <section style={card}>
            <h2 style={{ margin: '0 0 10px', fontSize: 15 }}>Place a marketplace item</h2>
            <p style={{ margin: '0 0 10px', color: dim, fontSize: 12 }}>
              Choose an item, then click empty ground on the map. Y is the lowest surface under the click; pick
              another layer in the selection panel for a rooftop.
            </p>
            <div style={{ display: 'grid', gap: 8, maxHeight: 320, overflowY: 'auto' }}>
              {catalogue.length === 0 ? (
                <p style={{ margin: 0, color: dim, fontSize: 13 }}>No catalogue items loaded.</p>
              ) : null}
              {catalogue.slice(0, 200).map((item) => (
                <button
                  key={item.id}
                  className={`btn ${placeItem?.id === item.id ? 'btn-primary' : 'btn-ghost'}`}
                  type="button"
                  data-e2e="catalogue-item"
                  aria-pressed={placeItem?.id === item.id}
                  style={{ justifyContent: 'flex-start', textAlign: 'left' }}
                  disabled={busy}
                  onClick={() => setPlaceItem((cur) => (cur?.id === item.id ? null : item))}
                >
                  {item.name} <span style={{ color: subtle }}>· {item.category}</span>
                </button>
              ))}
            </div>
          </section>

          <section style={card}>
            <h2 style={{ margin: '0 0 10px', fontSize: 15 }}>What the game reports</h2>
            {report ? (
              <div style={{ display: 'grid', gap: 6, fontSize: 13, color: '#cfe6f2' }}>
                <div>Applied version <b>{report.appliedVersion}</b> {report.appliedVersion === savedVersion ? '(current)' : '(behind — reload the world in game)'}</div>
                <div>{report.objects.length} named objects seen in this world</div>
                <div>{report.applied.length} entries applied, {report.unresolved.length} unresolved</div>
                {report.reportedAt ? (
                  <div style={{ color: dim }}>reported {new Date(report.reportedAt).toLocaleString()}</div>
                ) : null}
                {report.unresolved.length ? (
                  <ul style={{ margin: '6px 0 0', paddingLeft: 18, color: '#ffb08a' }}>
                    {report.unresolved.map((u) => (
                      <li key={u.id}>{u.id} — {u.reason}</li>
                    ))}
                  </ul>
                ) : null}
              </div>
            ) : (
              <p style={{ margin: 0, color: dim, fontSize: 13 }}>
                No report yet. Enter <b>{world}</b> in game while signed in as an administrator and the
                object list, floorplan and ground grid will fill in here.
              </p>
            )}
          </section>

          <section style={card}>
            <h2 style={{ margin: '0 0 10px', fontSize: 15 }}>Version history</h2>
            <p style={{ margin: '0 0 10px', color: dim, fontSize: 12 }}>
              Append-only. Reverting writes a new version holding the old entries; nothing is deleted,
              and every save is in the admin audit log.
            </p>
            <div style={{ display: 'grid', gap: 8 }} data-e2e="versions">
              {versions.map((v) => (
                <div
                  key={v.version}
                  data-e2e="version-row"
                  style={{ display: 'flex', gap: 10, alignItems: 'center', justifyContent: 'space-between', fontSize: 12 }}
                >
                  <span>
                    <b>v{v.version}</b> · {v.entryCount} entries · {v.author}
                    {v.note ? ` · ${v.note}` : ''}
                  </span>
                  <button
                    className="btn btn-ghost"
                    type="button"
                    disabled={busy || v.version === savedVersion}
                    onClick={() => void revert(v.version)}
                  >
                    Revert to this
                  </button>
                </div>
              ))}
              {versions.length === 0 ? (
                <p style={{ margin: 0, color: dim, fontSize: 13 }}>Nothing saved for this world yet.</p>
              ) : null}
            </div>
          </section>
        </div>
      </div>
    </div>
  );
}
