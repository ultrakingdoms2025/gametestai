import type { LayoutBounds } from './mapLayout';

/**
 * World ↔ screen for the map editor's canvas. Pure: no DOM, no canvas.
 *
 * ── The convention, stated once ────────────────────────────────────────────
 *
 *     sx = ox + x · scale
 *     sy = oy + z · scale
 *
 * Screen y grows as world z grows, so −Z is the TOP of the map: north = −Z
 * = up. That is the orientation `Minimap.js` gives a player facing north
 * ("forward maps to screen-up"), with no mirrored axis, so a floorplan here
 * looks like the in-game minimap and a rect's corners can be projected with
 * the minimap's own formula (`rectCorners`).
 *
 * All screen coordinates are CSS px; `fit()` applies the DPR transform, so
 * this module never sees it.
 *
 * ── Why a view is a value ──────────────────────────────────────────────────
 *
 * `zoomAt`, `pan` and `resizeView` return a new view instead of mutating
 * one. The canvas keeps the current view in a ref and replaces it; the tests
 * compare two views without a fixture; and nothing can be half-updated when
 * a pointer event arrives mid-draw.
 */

export interface MapView {
  /** Screen px per metre. */
  scale: number;
  /** Screen x of world x = 0. */
  ox: number;
  /** Screen y of world z = 0. */
  oy: number;
  /** Canvas CSS size the view was built for. */
  w: number;
  h: number;
}

export const MIN_SCALE = 0.02;
export const MAX_SCALE = 400;
/** Half-extent, metres, used until a world has reported its bounds. */
const FALLBACK_EXTENT = 100;

function clampScale(s: number): number {
  if (!Number.isFinite(s) || s <= 0) return 1;
  return Math.min(MAX_SCALE, Math.max(MIN_SCALE, s));
}

/** Fit `bounds` (or a ±100 m square) into w×h with `padPx` clear on every side, aspect preserved, centred. */
export function createView(bounds: LayoutBounds | null, w: number, h: number, padPx = 24): MapView {
  const minX = bounds ? bounds.min.x : -FALLBACK_EXTENT;
  const maxX = bounds ? bounds.max.x : FALLBACK_EXTENT;
  const minZ = bounds ? bounds.min.z : -FALLBACK_EXTENT;
  const maxZ = bounds ? bounds.max.z : FALLBACK_EXTENT;
  const ex = Math.max(1e-6, maxX - minX);
  const ez = Math.max(1e-6, maxZ - minZ);
  const iw = Math.max(1, w - padPx * 2);
  const ih = Math.max(1, h - padPx * 2);
  const scale = clampScale(Math.min(iw / ex, ih / ez));
  const cx = (minX + maxX) / 2;
  const cz = (minZ + maxZ) / 2;
  return { scale, ox: w / 2 - cx * scale, oy: h / 2 - cz * scale, w, h };
}

export function toScreen(view: MapView, x: number, z: number): { sx: number; sy: number } {
  return { sx: view.ox + x * view.scale, sy: view.oy + z * view.scale };
}

export function toWorld(view: MapView, sx: number, sy: number): { x: number; z: number } {
  return { x: (sx - view.ox) / view.scale, z: (sy - view.oy) / view.scale };
}

/** Zoom by `factor` about screen point (sx, sy); the world point under it does not move. */
export function zoomAt(view: MapView, sx: number, sy: number, factor: number): MapView {
  const scale = clampScale(view.scale * factor);
  const k = scale / view.scale;
  return { ...view, scale, ox: sx - (sx - view.ox) * k, oy: sy - (sy - view.oy) * k };
}

export function pan(view: MapView, dx: number, dy: number): MapView {
  return { ...view, ox: view.ox + dx, oy: view.oy + dy };
}

/** The canvas changed size: keep the same scale and the same world point at the centre. */
export function resizeView(view: MapView, w: number, h: number): MapView {
  const c = toWorld(view, view.w / 2, view.h / 2);
  return { ...view, w, h, ox: w / 2 - c.x * view.scale, oy: h / 2 - c.z * view.scale };
}

export interface HitCandidate {
  key: string;
  x: number;
  z: number;
  /** Optional radius in METRES, added to the pixel tolerance after scaling. */
  r?: number;
}

/** Nearest candidate whose screen distance is within `tolPx` (+ its scaled radius), or null. */
export function hitTest(
  view: MapView,
  candidates: HitCandidate[],
  sx: number,
  sy: number,
  tolPx: number
): HitCandidate | null {
  let best: HitCandidate | null = null;
  let bestD = Infinity;
  for (const c of candidates) {
    const p = toScreen(view, c.x, c.z);
    const d = Math.hypot(p.sx - sx, p.sy - sy);
    const reach = tolPx + (c.r ?? 0) * view.scale;
    if (d <= reach && d < bestD) {
      best = c;
      bestD = d;
    }
  }
  return best;
}

/** The four world-space corners of a (possibly rotated) rect, in `Minimap.js` order and formula. */
export function rectCorners(
  s: { x: number; z: number; w: number; d: number; rotation?: number }
): [[number, number], [number, number], [number, number], [number, number]] {
  const hw = s.w * 0.5;
  const hd = s.d * 0.5;
  const rot = s.rotation ?? 0;
  const cs = Math.cos(rot);
  const sn = Math.sin(rot);
  const corner = (lx: number, lz: number): [number, number] => [s.x + lx * cs - lz * sn, s.z + lx * sn + lz * cs];
  return [corner(-hw, -hd), corner(hw, -hd), corner(hw, hd), corner(-hw, hd)];
}

/** A layout colour (Three numeric or CSS string) as a canvas fill/stroke string. */
export function cssColour(c: number | string | undefined, fallback: string): string {
  if (typeof c === 'number' && Number.isFinite(c)) return `#${(c & 0xffffff).toString(16).padStart(6, '0')}`;
  if (typeof c === 'string' && c) return c;
  return fallback;
}
