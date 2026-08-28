'use client';

import type { PendingRow } from '@/lib/mapEditorState';
import { dim, errorColour, moveColour, okColour, placeColour, warnColour } from './mapEditorStyles';

/**
 * The pending list: what this version will say, one row per entry.
 *
 * Rows are the document in order, not only "changes made this session":
 * an overlay saved last week is still a set of moves the game applies on
 * every load, and hiding it would make the map lie about why a crate is
 * where it is. Each row is the entry's text from `pendingRows`, its worst
 * conflict level, and an undo that removes it from the document.
 */

export interface MapPendingListProps {
  rows: PendingRow[];
  selectedKey: string | null;
  /** Keys the save route rejected (`400 { error: 'conflicts', rejected }`), outlined until the next edit. */
  rejectedKeys: ReadonlySet<string>;
  disabled: boolean;
  onSelect: (key: string) => void;
  onUndo: (key: string) => void;
}

const LEVEL = {
  ok: { icon: '✓', colour: okColour },
  warn: { icon: '⚠', colour: warnColour },
  error: { icon: '⛔', colour: errorColour },
} as const;

export default function MapPendingList({ rows, selectedKey, rejectedKeys, disabled, onSelect, onUndo }: MapPendingListProps) {
  if (!rows.length) {
    return (
      <p data-e2e="pending-empty" style={{ margin: 0, color: dim, fontSize: 13 }}>
        No entries. The world is exactly as its code builds it.
      </p>
    );
  }
  return (
    <ul data-e2e="pending-list" style={{ listStyle: 'none', margin: 0, padding: 0, display: 'grid', gap: 6 }}>
      {rows.map((r) => {
        const lv = LEVEL[r.level];
        const isSel = r.key === selectedKey;
        const rejected = rejectedKeys.has(r.key);
        return (
          <li
            key={r.key}
            data-e2e="pending-row"
            data-level={r.level}
            data-rejected={rejected ? 'true' : undefined}
            style={{
              display: 'grid',
              gridTemplateColumns: '58px minmax(0, 1fr) auto auto',
              gap: 10,
              alignItems: 'center',
              padding: '8px 10px',
              borderRadius: 10,
              fontSize: 12,
              background: isSel ? 'rgba(82, 233, 255, 0.08)' : 'rgba(0,0,0,0.16)',
              border: rejected ? `1px solid ${errorColour}` : isSel ? '1px solid rgba(82, 233, 255, 0.4)' : '1px solid rgba(255,255,255,0.06)',
            }}
          >
            <b style={{ color: r.kind === 'move' ? moveColour : placeColour, letterSpacing: '0.12em', fontSize: 11 }}>
              {r.kind.toUpperCase()}
            </b>
            {/* The button's chrome is removed property by property, not with
              * `all: 'unset'`: that also unset the outline, and the focus ring
              * is how the keyboard route — the spec's accessibility path — sees
              * which row it is on. */}
            <button
              type="button"
              data-e2e="pending-select"
              onClick={() => onSelect(r.key)}
              style={{
                background: 'none',
                border: 0,
                padding: 0,
                font: 'inherit',
                textAlign: 'left',
                cursor: 'pointer',
                color: '#cfe6f2',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
              }}
              title={`${r.label} ${r.summary}`}
            >
              <span data-e2e="pending-label">{r.label}</span>
              <span style={{ color: dim }}> {r.summary}</span>
            </button>
            <span
              data-e2e="pending-status"
              style={{ color: lv.colour, whiteSpace: 'nowrap' }}
              title={r.conflicts.map((c) => c.detail).join('\n')}
              aria-label={r.conflicts.length ? r.conflicts.map((c) => c.code).join(', ') : 'no conflicts'}
            >
              {lv.icon}{r.conflicts.length ? ` ${r.conflicts.map((c) => c.code).join(', ')}` : ''}
              {rejected ? ' · rejected by save' : ''}
            </span>
            <button
              className="btn btn-ghost btn-sm"
              type="button"
              data-e2e="pending-undo"
              aria-label={`undo ${r.label}`}
              disabled={disabled}
              onClick={() => onUndo(r.key)}
            >
              undo
            </button>
          </li>
        );
      })}
    </ul>
  );
}
