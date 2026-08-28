'use client';

import { useEffect, useId, useMemo, useState, type KeyboardEvent } from 'react';
import { groundAt, layersAt, type DecodedGround } from '@/lib/mapLayout';
import type { Conflict } from '@/lib/mapConflicts';
import type { CatalogueObject } from '@/lib/mapOverlay';
import { round, type PlaceEntry, type Vec3 } from '@/lib/mapOverlaySchema';
import {
  authoredLift,
  degToRad,
  fmt,
  groundStatus,
  radToDeg,
  selectedEntry,
  selectedPosition,
  selectionFromKey,
  selectionKey,
  snappedY,
  type Draft,
  type Selected,
} from '@/lib/mapEditorState';
import { coord, dim, errorColour, input, label, okColour, subtle, warnColour } from './mapEditorStyles';

/**
 * The selection panel: the keyboard path into the map, and the typed path
 * for a move. It renders; it decides nothing.
 *
 * ── Why a `<select>` and not only the canvas ───────────────────────────────
 *
 * A prop can be two pixels wide at a zoom that shows the whole world, and a
 * screen reader cannot click a canvas at all. The dropdown reaches every
 * object the game reported, grouped by family so a world with 1 800 names
 * is a list of twenty groups. Both routes set the same `selected`.
 *
 * ── Why the fields re-sync from props ──────────────────────────────────────
 *
 * A drag on the map changes the entry underneath this panel; the fields
 * follow it so what is typed and what is drawn never disagree. The sync key
 * includes the position so a drag updates the boxes, and the selection so
 * picking another object clears them. The numbers are rounded to the three
 * places the schema keeps on save, so a drag's raw float never shows digits
 * that will not be written — and Move here commits them at those same
 * places (six for the yaw, as `readAngle` keeps), so the document equals
 * what is displayed rather than a longer float the save would trim.
 *
 * ── Which selection a move is ──────────────────────────────────────────────
 *
 * Not decided here. A typed name the game has not reported is its move
 * entry once it has one, and a row for a reported target's move is the
 * object; both are `canonicalSelection` in `mapEditorState.ts`, applied by
 * the parent every time a selection is set, so this panel only renders
 * whatever `selected` it is handed.
 *
 * ── The ground readout is the route's verdict ──────────────────────────────
 *
 * `✓ on surface` / `⚠ underground|floating|no-ground` comes from
 * `groundStatus`, which is `mapConflicts`' own millimetre comparison. This
 * panel's first version re-derived the rule in floats and disagreed with the
 * save route at the boundary. A blank or non-numeric coordinate has no
 * verdict (`—`) and cannot be committed: `Number('')` is 0, and a blank Y
 * used to move an object to the origin plane.
 */

export interface MapSelectionPanelProps {
  objects: CatalogueObject[];
  entries: Draft[];
  selected: Selected;
  ground: DecodedGround | null;
  /** Conflicts for the entry the selection maps to (empty when there is no entry yet). */
  conflicts: Conflict[];
  disabled: boolean;
  onSelect: (sel: Selected) => void;
  onCommit: (sel: NonNullable<Selected>, position: Vec3, rotationY: number | undefined) => void;
  onReset: (sel: NonNullable<Selected>) => void;
  onRemoveEntry: (key: string) => void;
}

type Form = { x: string; y: string; z: string; yaw: string };

function num(v: string): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

function groupOf(name: string): string {
  const i = name.indexOf(':');
  return i > 0 ? name.slice(0, i) : 'other';
}

/** A coordinate field that can be committed: not blank (`Number('')` is 0) and a finite number. */
function isCoord(v: string): boolean {
  return v.trim() !== '' && Number.isFinite(Number(v));
}

export default function MapSelectionPanel(props: MapSelectionPanelProps) {
  const { objects, entries, selected, ground, conflicts, disabled, onSelect, onCommit, onReset, onRemoveEntry } = props;
  const listId = useId();

  const objectNames = useMemo(() => new Set(objects.map((o) => o.name)), [objects]);
  const groups = useMemo(() => {
    const m = new Map<string, string[]>();
    for (const o of objects) {
      const g = groupOf(o.name);
      const list = m.get(g);
      if (list) list.push(o.name);
      else m.set(g, [o.name]);
    }
    return [...m.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([g, names]) => [g, names.sort((a, b) => a.localeCompare(b))] as const);
  }, [objects]);
  const places = useMemo(() => entries.filter((e): e is Draft & PlaceEntry => e.kind === 'place'), [entries]);
  const freeMoves = useMemo(
    () => entries.filter((e) => e.kind === 'move' && !objectNames.has(e.target.name)),
    [entries, objectNames]
  );

  const entry = selectedEntry(entries, selected);
  const current = selectedPosition(objects, entries, selected);
  const rotation = entry?.rotationY;

  const [form, setForm] = useState<Form>({ x: '0', y: '0', z: '0', yaw: '' });
  const [snap, setSnap] = useState(true);
  const [typed, setTyped] = useState('');

  const syncKey = `${selectionKey(selected) ?? ''}|${current?.x}|${current?.y}|${current?.z}|${rotation}`;
  useEffect(() => {
    setForm({
      x: current ? String(round(current.x, 3)) : '0',
      y: current ? String(round(current.y, 3)) : '0',
      z: current ? String(round(current.z, 3)) : '0',
      yaw: rotation !== undefined ? String(Math.round(radToDeg(rotation) * 10) / 10) : '',
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [syncKey]);

  function setAxis(axis: 'x' | 'z', value: string) {
    setForm((f) => {
      const next = { ...f, [axis]: value };
      if (snap && current && isCoord(next.x) && isCoord(next.z)) {
        const y = snappedY(ground, current, num(next.x), num(next.z));
        if (y !== null) next.y = String(round(y, 3));
      }
      return next;
    });
  }

  /* An object keeps its authored sink or lift on the chosen surface — the
   * same `authoredLift` a drag adds through `snappedY`; a placement or a
   * free move sits on it. With no sample under the object the lift is
   * unknown, and the pick does nothing rather than guess, as the snap does. */
  function pickLayer(h: number) {
    const lift = selected?.kind === 'object' && current ? authoredLift(ground, current) : 0;
    if (lift === null) return;
    setForm((f) => ({ ...f, y: String(round(h + lift, 3)) }));
  }

  const valid = [form.x, form.y, form.z].every(isCoord);
  const fx = num(form.x);
  const fy = num(form.y);
  const fz = num(form.z);
  const groundHere = selected && valid ? groundAt(ground, fx, fz, fy) : null;
  const layers = selected && valid ? layersAt(ground, fx, fz) : [];
  /* From the TYPED Y, not the committed entry, so the warning shows before
   * Move here; `groundStatus` is the save route's own verdict (see the header). */
  const typedStatus = selected && valid ? groundStatus(ground, fx, fz, fy) : null;

  function commit() {
    if (!selected || !valid) return;
    const yaw = form.yaw.trim() === '' ? undefined : round(degToRad(num(form.yaw)), 6);
    onCommit(selected, { x: round(fx, 3), y: round(fy, 3), z: round(fz, 3) }, yaw);
  }

  function onTypedKey(e: KeyboardEvent<HTMLInputElement>) {
    if (e.key !== 'Enter') return;
    e.preventDefault();
    const name = typed.trim();
    if (name) onSelect({ kind: 'object', name });
  }

  const title = !selected ? 'Nothing selected' : selected.kind === 'object' ? selected.name : entry?.kind === 'place' ? `${entry.item.name} ×${entry.quantity}` : entry?.kind === 'move' ? entry.target.name : 'entry';

  return (
    <div style={{ display: 'grid', gap: 10 }}>
      <label style={label}>
        Object
        <select
          style={input}
          data-e2e="object-select"
          value={selectionKey(selected) ?? ''}
          disabled={disabled}
          onChange={(e) => onSelect(e.target.value ? selectionFromKey(e.target.value) : null)}
        >
          <option value="">— pick an object —</option>
          {groups.map(([g, names]) => (
            <optgroup key={g} label={g}>
              {names.map((n) => (
                <option key={n} value={`o:${n}`}>{n}</option>
              ))}
            </optgroup>
          ))}
          {places.length ? (
            <optgroup label="placements">
              {places.map((p) => (
                <option key={p._key} value={`e:${p._key}`}>{p.item.name} ×{p.quantity}</option>
              ))}
            </optgroup>
          ) : null}
          {freeMoves.length ? (
            <optgroup label="moves by name (not in the report)">
              {freeMoves.map((m) => (
                <option key={m._key} value={`e:${m._key}`}>{m.kind === 'move' ? m.target.name : ''}</option>
              ))}
            </optgroup>
          ) : null}
        </select>
      </label>
      <label style={label}>
        Or type a name and press Enter
        <input
          style={input}
          data-e2e="object-typed"
          list={listId}
          value={typed}
          disabled={disabled}
          placeholder="e.g. barn.main"
          onChange={(e) => setTyped(e.target.value)}
          onKeyDown={onTypedKey}
        />
      </label>
      <datalist id={listId}>
        {objects.map((o) => (
          <option key={o.name} value={o.name} />
        ))}
      </datalist>

      <div data-e2e="sel-name" style={{ fontSize: 13, color: '#cfe6f2', wordBreak: 'break-all' }}>
        <b>{title}</b>
        {selected?.kind === 'object' && !objectNames.has(selected.name) ? (
          <span style={{ color: warnColour }}> — not in the game's report</span>
        ) : null}
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 8 }}>
        <label style={label}>
          X
          <input style={coord} data-e2e="sel-x" type="number" step="0.1" value={form.x} disabled={!selected || disabled} onChange={(e) => setAxis('x', e.target.value)} />
        </label>
        <label style={label}>
          Y
          <input style={coord} data-e2e="sel-y" type="number" step="0.1" value={form.y} disabled={!selected || disabled} onChange={(e) => setForm((f) => ({ ...f, y: e.target.value }))} />
        </label>
        <label style={label}>
          Z
          <input style={coord} data-e2e="sel-z" type="number" step="0.1" value={form.z} disabled={!selected || disabled} onChange={(e) => setAxis('z', e.target.value)} />
        </label>
        <label style={label}>
          Yaw °
          <input style={coord} data-e2e="sel-yaw" type="number" step="1" value={form.yaw} disabled={!selected || disabled} placeholder="—" onChange={(e) => setForm((f) => ({ ...f, yaw: e.target.value }))} />
        </label>
      </div>

      <label style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 12, color: '#cfe6f2' }}>
        <input type="checkbox" data-e2e="snap" checked={snap} disabled={disabled} onChange={(e) => setSnap(e.target.checked)} />
        snap Y to ground (keeps the object's authored sink or lift)
      </label>

      {layers.length > 1 ? (
        <label style={label}>
          Layer at this X/Z
          <select
            style={input}
            data-e2e="layer-select"
            value=""
            disabled={disabled}
            onChange={(e) => {
              const h = Number(e.target.value);
              if (Number.isFinite(h)) pickLayer(h);
            }}
          >
            <option value="">— choose a surface for Y —</option>
            {layers.map((h, i) => (
              <option key={`${i}-${h}`} value={String(h)}>{i === 0 ? 'Top' : `Layer ${i}`} {fmt(h)} m</option>
            ))}
          </select>
        </label>
      ) : null}

      <div data-e2e="sel-ground" style={{ fontSize: 12, color: dim }}>
        {!selected
          ? 'Pick an object on the map or in the list.'
          : !ground
            ? 'No ground grid for this world yet.'
            : !valid
              ? 'Ground here:'
              : groundHere === null
                ? 'No ground sample here.'
                : `Ground here: ${fmt(groundHere)} m`}
        {selected && ground && !valid ? (
          <span data-e2e="sel-ground-status">  —</span>
        ) : typedStatus ? (
          <span data-e2e="sel-ground-status" style={{ color: typedStatus === 'ok' ? okColour : warnColour }}>
            {typedStatus === 'ok' ? '  ✓ on surface' : `  ⚠ ${typedStatus}`}
          </span>
        ) : null}
      </div>

      {conflicts.length ? (
        <div style={{ display: 'grid', gap: 4 }}>
          <span style={{ fontSize: 11, color: subtle }}>Pending entry:</span>
          <ul data-e2e="sel-conflicts" style={{ margin: 0, paddingLeft: 18, fontSize: 12, display: 'grid', gap: 3 }}>
            {conflicts.map((c, i) => (
              <li key={`${c.code}-${i}`} style={{ color: c.level === 'error' ? errorColour : warnColour }}>
                {c.level === 'error' ? '⛔' : '⚠'} {c.code} — {c.detail}{c.other ? ` (${c.other})` : ''}
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        <button className="btn btn-primary btn-sm" type="button" data-e2e="move-here" disabled={!selected || disabled || !valid} onClick={commit}>
          Move here
        </button>
        {selected?.kind === 'object' && entry ? (
          <button className="btn btn-ghost btn-sm" type="button" data-e2e="reset" disabled={disabled} onClick={() => onReset(selected)}>
            Reset
          </button>
        ) : null}
        {selected?.kind === 'entry' ? (
          <button className="btn btn-ghost btn-sm" type="button" data-e2e="remove-entry" disabled={disabled} onClick={() => onRemoveEntry(selected.key)}>
            Remove entry
          </button>
        ) : null}
      </div>
      <p style={{ margin: 0, fontSize: 11, color: subtle }}>
        Yaw is stored in radians; this field is degrees. Drag the mark on the map to move without typing.
      </p>
    </div>
  );
}
