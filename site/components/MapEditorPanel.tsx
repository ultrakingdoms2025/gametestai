'use client';

import { useCallback, useEffect, useMemo, useState, type CSSProperties } from 'react';
import {
  OVERLAY_WORLDS,
  type OverlayEntry,
  type OverlayWorld,
} from '@/lib/mapOverlaySchema';
import type { MarketplaceItemRecord } from '@/lib/marketplaceCatalog';

/**
 * The map editor.
 *
 * ── What it edits, and what it deliberately is not ─────────────────────────
 *
 * A form over a placement overlay — a versioned document of moved and placed
 * instances the game applies AFTER a world has finished building. It is not a
 * 3D viewport, and that is a decision rather than a shortfall: a gizmo here
 * would need the whole procedural world built a second time, in a second
 * engine, which is exactly the "two places world geometry lives" problem the
 * overlay exists to avoid.
 *
 * ── Where the object names come from ───────────────────────────────────────
 *
 * From the running game. Nothing on the server knows what `MedievalWorld.js`
 * built; an admin's own client posts the world's named objects back after it
 * applies the overlay, and the picker below is that list. Until a world has
 * been visited by an admin the picker is empty and the field is free text —
 * which is honest about what is known, rather than offering a guess.
 *
 * ── The report is the acceptance criterion ─────────────────────────────────
 *
 * "Saves, reloads and sees it in game" is not something a human should have to
 * swear to. The right-hand column shows which version the game last applied,
 * how many colliders came with each move, and every entry it could NOT resolve.
 * A move whose object was renamed by an art pass appears there by name.
 */

interface OverlayVersionRow {
  version: number;
  author: string;
  note: string | null;
  entryCount: number;
  createdAt: string;
}

interface WorldReport {
  appliedVersion: number;
  objects: Array<{ name: string; position: { x: number; y: number; z: number } }>;
  applied: Array<{ id: string; ok: boolean; colliders?: number }>;
  unresolved: Array<{ id: string; reason: string }>;
  reportedAt?: string;
}

type Draft = OverlayEntry & { _key: string };

function newKey(): string {
  return `k${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
}

function withKeys(entries: OverlayEntry[]): Draft[] {
  return entries.map((e) => ({ ...e, _key: newKey() } as Draft));
}

function stripKeys(entries: Draft[]): OverlayEntry[] {
  return entries.map(({ _key, ...rest }) => rest as OverlayEntry);
}

function num(value: string): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

const card: CSSProperties = {
  border: '1px solid rgba(82, 233, 255, 0.2)',
  borderRadius: '16px',
  background: 'rgba(7, 16, 24, 0.72)',
  padding: '16px',
  boxShadow: '0 18px 50px rgba(0,0,0,0.28)',
};

const input: CSSProperties = {
  width: '100%',
  borderRadius: '10px',
  border: '1px solid rgba(140, 176, 200, 0.25)',
  background: 'rgba(4, 10, 15, 0.88)',
  color: 'inherit',
  padding: '8px 10px',
  font: 'inherit',
};

const label: CSSProperties = { display: 'grid', gap: '5px', fontSize: '12px', color: '#cfe6f2' };

const coord: CSSProperties = { ...input, padding: '6px 8px' };

export function MapEditorPanel() {
  const [world, setWorld] = useState<OverlayWorld>('station');
  const [entries, setEntries] = useState<Draft[]>([]);
  const [savedVersion, setSavedVersion] = useState(0);
  const [versions, setVersions] = useState<OverlayVersionRow[]>([]);
  const [report, setReport] = useState<WorldReport | null>(null);
  const [catalogue, setCatalogue] = useState<MarketplaceItemRecord[]>([]);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [dirty, setDirty] = useState(false);

  const load = useCallback(async (which: OverlayWorld) => {
    setBusy(true);
    setMessage('');
    try {
      const res = await fetch(`/api/admin/map/${which}`, { cache: 'no-store' });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error || 'Could not load the overlay.');
      setEntries(withKeys(data.overlay.entries ?? []));
      setSavedVersion(data.overlay.version ?? 0);
      setVersions(data.versions ?? []);
      setReport(data.report ?? null);
      setDirty(false);
      setNote('');
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Could not load the overlay.');
    } finally {
      setBusy(false);
    }
  }, []);

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

  const knownNames = useMemo(
    () => (report?.objects ?? []).map((o) => o.name),
    [report]
  );

  const unresolvedById = useMemo(() => {
    const map = new Map<string, string>();
    for (const u of report?.unresolved ?? []) map.set(u.id, u.reason);
    return map;
  }, [report]);

  const appliedById = useMemo(() => {
    const map = new Map<string, { ok: boolean; colliders?: number }>();
    for (const a of report?.applied ?? []) map.set(a.id, a);
    return map;
  }, [report]);

  function mutate(key: string, patch: Partial<OverlayEntry>) {
    setEntries((list) => list.map((e) => (e._key === key ? ({ ...e, ...patch } as Draft) : e)));
    setDirty(true);
  }

  function movePosition(key: string, axis: 'x' | 'y' | 'z', value: string) {
    setEntries((list) =>
      list.map((e) => {
        if (e._key !== key) return e;
        const base = e.position ?? { x: 0, y: 0, z: 0 };
        return { ...e, position: { ...base, [axis]: num(value) } } as Draft;
      })
    );
    setDirty(true);
  }

  function addMove() {
    setEntries((list) => [
      ...list,
      {
        _key: newKey(),
        kind: 'move',
        id: newKey(),
        target: { name: knownNames[0] ?? '' },
        position: { x: 0, y: 0, z: 0 },
      } as Draft,
    ]);
    setDirty(true);
  }

  function addPlace(item: MarketplaceItemRecord) {
    setEntries((list) => [
      ...list,
      {
        _key: newKey(),
        kind: 'place',
        id: newKey(),
        item: {
          source_key: item.source_key ?? item.id,
          name: item.name,
          // Copied, not referenced: what this crate contains is a decision taken
          // now, and re-authoring the catalogue row later must not change it.
          config: (item.action_config ?? {}) as Record<string, string | number | boolean>,
        },
        position: { x: 0, y: 0, z: 0 },
        quantity: 1,
      } as Draft,
    ]);
    setDirty(true);
  }

  function removeEntry(key: string) {
    setEntries((list) => list.filter((e) => e._key !== key));
    setDirty(true);
  }

  async function save() {
    setBusy(true);
    setMessage('');
    try {
      const res = await fetch(`/api/admin/map/${world}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ entries: stripKeys(entries), note: note || null }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error || 'Save failed.');
      const rejected = data.overlay?.rejected ?? [];
      setMessage(
        rejected.length
          ? `Saved version ${data.overlay.version}. ${rejected.length} entr${rejected.length === 1 ? 'y was' : 'ies were'} rejected: ${rejected.map((r: { reason: string }) => r.reason).join(', ')}.`
          : `Saved version ${data.overlay.version}. Reload the world in game to see it.`
      );
      await load(world);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Save failed.');
    } finally {
      setBusy(false);
    }
  }

  async function revert(version: number) {
    if (!confirm(`Revert ${world} to version ${version}? This writes a new version holding those entries; nothing is deleted.`)) return;
    setBusy(true);
    try {
      const res = await fetch(`/api/admin/map/${world}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ revertTo: version }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error || 'Revert failed.');
      setMessage(`Reverted to version ${version}, saved as version ${data.overlay.version}.`);
      await load(world);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Revert failed.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div style={{ display: 'grid', gridTemplateColumns: '1.35fr 1fr', gap: 20, alignItems: 'start' }}>
      <section style={card}>
        <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'end', marginBottom: 14 }}>
          <label style={label}>
            World
            <select
              style={input}
              value={world}
              onChange={(e) => setWorld(e.target.value as OverlayWorld)}
              disabled={busy}
            >
              {OVERLAY_WORLDS.map((w) => (
                <option key={w} value={w}>{w}</option>
              ))}
            </select>
          </label>
          <button className="btn btn-ghost" type="button" onClick={addMove} disabled={busy}>
            Move an object
          </button>
          <button className="btn btn-primary" type="button" onClick={() => void save()} disabled={busy || !dirty}>
            {busy ? 'Working…' : dirty ? 'Save new version' : `Saved (v${savedVersion})`}
          </button>
        </div>

        <label style={{ ...label, marginBottom: 14 }}>
          Note (optional — shown in the version history and the audit log)
          <input style={input} value={note} onChange={(e) => setNote(e.target.value)} placeholder="what changed and why" />
        </label>

        {message ? (
          <p style={{ margin: '0 0 14px', color: '#9bd6ea', fontSize: 13 }} role="status">{message}</p>
        ) : null}

        <div style={{ display: 'grid', gap: 12 }}>
          {entries.length === 0 ? (
            <p style={{ color: '#8ea6b8', margin: 0 }}>
              No overlay entries for <b>{world}</b>. The world is exactly as its code builds it.
            </p>
          ) : null}

          {entries.map((entry) => {
            const unresolved = unresolvedById.get(entry.id);
            const applied = appliedById.get(entry.id);
            return (
              <article
                key={entry._key}
                style={{
                  border: unresolved ? '1px solid rgba(255,140,90,0.5)' : '1px solid rgba(255,255,255,0.08)',
                  borderRadius: 14,
                  padding: 12,
                  background: 'rgba(0,0,0,0.16)',
                  display: 'grid',
                  gap: 10,
                }}
              >
                <div style={{ display: 'flex', justifyContent: 'space-between', gap: 10, alignItems: 'center' }}>
                  <strong style={{ color: entry.kind === 'move' ? '#52e9ff' : '#ffb44a', fontSize: 12, letterSpacing: '0.12em' }}>
                    {entry.kind.toUpperCase()}
                  </strong>
                  <span style={{ fontSize: 11, color: '#8ea6b8' }}>
                    {unresolved
                      ? `game could not apply this — ${unresolved}`
                      : applied
                        ? `applied in game${applied.colliders ? `, ${applied.colliders} collider${applied.colliders === 1 ? '' : 's'} moved` : ', no colliders moved'}`
                        : 'not yet seen in game'}
                  </span>
                  <button className="btn btn-ghost" type="button" onClick={() => removeEntry(entry._key)}>Remove</button>
                </div>

                {entry.kind === 'move' ? (
                  <label style={label}>
                    Object name
                    <input
                      style={input}
                      list="map-editor-objects"
                      value={entry.target.name}
                      onChange={(e) => mutate(entry._key, { target: { name: e.target.value } } as Partial<OverlayEntry>)}
                      placeholder="e.g. barn.main"
                    />
                  </label>
                ) : (
                  <div style={{ fontSize: 13, color: '#cfe6f2' }}>
                    {entry.item.name} <span style={{ color: '#7f97a8' }}>({entry.item.source_key})</span>
                  </div>
                )}

                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 8 }}>
                  {(['x', 'y', 'z'] as const).map((axis) => (
                    <label key={axis} style={label}>
                      {axis.toUpperCase()}
                      <input
                        style={coord}
                        type="number"
                        step="0.1"
                        value={entry.position ? entry.position[axis] : ''}
                        onChange={(e) => movePosition(entry._key, axis, e.target.value)}
                      />
                    </label>
                  ))}
                  <label style={label}>
                    Yaw (rad)
                    <input
                      style={coord}
                      type="number"
                      step="0.05"
                      value={entry.rotationY ?? ''}
                      onChange={(e) =>
                        mutate(entry._key, {
                          rotationY: e.target.value === '' ? undefined : num(e.target.value),
                        } as Partial<OverlayEntry>)
                      }
                    />
                  </label>
                </div>

                {entry.kind === 'move' ? (
                  <label style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 12, color: '#cfe6f2' }}>
                    <input
                      type="checkbox"
                      checked={Boolean(entry.hidden)}
                      onChange={(e) =>
                        mutate(entry._key, { hidden: e.target.checked ? true : undefined } as Partial<OverlayEntry>)
                      }
                    />
                    Hide this object instead of only moving it
                  </label>
                ) : (
                  <label style={{ ...label, maxWidth: 160 }}>
                    Quantity
                    <input
                      style={coord}
                      type="number"
                      min={1}
                      max={99}
                      value={entry.quantity}
                      onChange={(e) => mutate(entry._key, { quantity: Math.max(1, Math.floor(num(e.target.value))) } as Partial<OverlayEntry>)}
                    />
                  </label>
                )}
              </article>
            );
          })}
        </div>

        <datalist id="map-editor-objects">
          {knownNames.map((name) => (
            <option key={name} value={name} />
          ))}
        </datalist>
      </section>

      <div style={{ display: 'grid', gap: 20 }}>
        <section style={card}>
          <h2 style={{ margin: '0 0 10px', fontSize: 15 }}>What the game reports</h2>
          {report ? (
            <div style={{ display: 'grid', gap: 6, fontSize: 13, color: '#cfe6f2' }}>
              <div>Applied version <b>{report.appliedVersion}</b> {report.appliedVersion === savedVersion ? '(current)' : '(behind — reload the world in game)'}</div>
              <div>{report.objects.length} named objects seen in this world</div>
              <div>{report.applied.length} entries applied, {report.unresolved.length} unresolved</div>
              {report.reportedAt ? (
                <div style={{ color: '#8ea6b8' }}>reported {new Date(report.reportedAt).toLocaleString()}</div>
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
            <p style={{ margin: 0, color: '#8ea6b8', fontSize: 13 }}>
              No report yet. Enter <b>{world}</b> in game while signed in as an administrator and the
              object list will fill in here.
            </p>
          )}
        </section>

        <section style={card}>
          <h2 style={{ margin: '0 0 10px', fontSize: 15 }}>Place a marketplace item</h2>
          <div style={{ display: 'grid', gap: 8, maxHeight: 320, overflowY: 'auto' }}>
            {catalogue.length === 0 ? (
              <p style={{ margin: 0, color: '#8ea6b8', fontSize: 13 }}>No catalogue items loaded.</p>
            ) : null}
            {catalogue.slice(0, 200).map((item) => (
              <button
                key={item.id}
                className="btn btn-ghost"
                type="button"
                style={{ justifyContent: 'flex-start', textAlign: 'left' }}
                onClick={() => addPlace(item)}
              >
                {item.name} <span style={{ color: '#7f97a8' }}>· {item.category}</span>
              </button>
            ))}
          </div>
        </section>

        <section style={card}>
          <h2 style={{ margin: '0 0 10px', fontSize: 15 }}>Version history</h2>
          <p style={{ margin: '0 0 10px', color: '#8ea6b8', fontSize: 12 }}>
            Append-only. Reverting writes a new version holding the old entries; nothing is deleted,
            and every save is in the admin audit log.
          </p>
          <div style={{ display: 'grid', gap: 8 }}>
            {versions.map((v) => (
              <div
                key={v.version}
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
              <p style={{ margin: 0, color: '#8ea6b8', fontSize: 13 }}>Nothing saved for this world yet.</p>
            ) : null}
          </div>
        </section>
      </div>
    </div>
  );
}
