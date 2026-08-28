import type { CSSProperties } from 'react';
import type { PendingRow } from '@/lib/mapEditorState';

/**
 * Inline styles shared by the map editor's components.
 *
 * The site has no `.card` or `.input` class; panels are styled inline, and
 * these are the constants `MapEditorPanel.tsx` carried before the map-first
 * rewrite, lifted so the canvas, selection panel and pending list agree.
 *
 * `clipPath: 'none'` on `coord` is load-bearing. `globals.css` gives every
 * `input[type='number']` `clip-path: var(--clip-sm)` and a 1.25 rem display
 * font for the store's quantity fields; a coordinate box with notched corners
 * next to plain text boxes looks like a different control, and the old panel
 * overrode font and padding but not the clip.
 */

export const card: CSSProperties = {
  border: '1px solid rgba(82, 233, 255, 0.2)',
  borderRadius: '16px',
  background: 'rgba(7, 16, 24, 0.72)',
  padding: '16px',
  boxShadow: '0 18px 50px rgba(0,0,0,0.28)',
};

export const input: CSSProperties = {
  width: '100%',
  borderRadius: '10px',
  border: '1px solid rgba(140, 176, 200, 0.25)',
  background: 'rgba(4, 10, 15, 0.88)',
  color: 'inherit',
  padding: '8px 10px',
  font: 'inherit',
};

export const label: CSSProperties = { display: 'grid', gap: '5px', fontSize: '12px', color: '#cfe6f2' };

export const coord: CSSProperties = { ...input, padding: '6px 8px', fontSize: '13px', clipPath: 'none' };

export const dim = '#8ea6b8';
export const subtle = '#7f97a8';
export const statusColour = '#9bd6ea';
export const okColour = '#b6ff5a';
export const warnColour = '#ffb44a';
export const errorColour = '#ff5566';
export const moveColour = '#52e9ff';
export const placeColour = '#ffb44a';
export const removeColour = '#ff7a90';

/**
 * The colour of a pending row's kind. A table, not a ternary: the list's
 * first version read `kind === 'move' ? move : place`, and a REMOVE row wore
 * the placement colour. `satisfies` makes a fourth kind a compile error here
 * rather than a wrong colour there.
 */
export const KIND_COLOUR = {
  move: moveColour,
  remove: removeColour,
  place: placeColour,
} as const satisfies Record<PendingRow['kind'], string>;
