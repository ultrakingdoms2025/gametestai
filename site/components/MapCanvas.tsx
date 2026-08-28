'use client';

import { useCallback, useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import { fit } from '@/lib/painters';
import { NO_SAMPLE, type DecodedGround, type WorldLayout } from '@/lib/mapLayout';
import type { CatalogueObject } from '@/lib/mapOverlay';
import type { MoveEntry } from '@/lib/mapOverlaySchema';
import {
  createView,
  cssColour,
  hitTest,
  pan,
  rectCorners,
  resizeView,
  toScreen,
  toWorld,
  zoomAt,
  type HitCandidate,
  type MapView,
} from '@/lib/mapProjection';
import { fmt, selectedPosition, selectionFromKey, selectionKey, type Draft, type Selected } from '@/lib/mapEditorState';
import { moveColour, okColour, placeColour } from './mapEditorStyles';

/**
 * The top-down map. Draws, and forwards pointer events. Decides nothing.
 *
 * ── What it draws, and from where ──────────────────────────────────────────
 *
 * The floorplan is the world's `minimapShapes` as the game reported them,
 * projected through `mapProjection.ts` with the minimap's own rect-corner
 * formula, so this map and the in-game minimap agree on every wall. The
 * ground grid is drawn lightly under the marks so a dome, a deck and a hole
 * read as different tones; it is skipped above `GROUND_CELL_CAP` cells
 * because a 160 000-rect frame stuttered under drag, and the grid still
 * drives snapping whether or not it is drawn.
 *
 * ── Why the view lives in a ref ────────────────────────────────────────────
 *
 * Pan and zoom happen on every pointer move. Putting the view in React state
 * would re-render the whole editor per pixel of drag; a ref plus a redraw
 * tick redraws only this canvas. The view is a value (`mapProjection.ts`),
 * so the ref is replaced, never mutated.
 *
 * ── The parent must keep `layout` referentially stable ─────────────────────
 *
 * The refit effect keys on the `layout` object's IDENTITY, not its content:
 * a new reference means a new world or fresh bounds, so the view is thrown
 * away and fitted again. The panel polls the report route; if it handed this
 * component a freshly parsed layout on every poll, the admin's pan and zoom
 * would reset every few seconds. `MapEditorPanel` therefore memoises the
 * layout across polls and replaces the reference only when the world or the
 * reported layout actually changes.
 *
 * ── Everything happens in CSS pixels ───────────────────────────────────────
 *
 * `fit()` sets the bitmap to the CSS box × DPR and applies the DPR as the
 * transform, so drawing and hit-testing both use `getBoundingClientRect`
 * coordinates and never see the device pixel ratio.
 */

export interface HoverInfo {
  label: string;
  x: number;
  y: number | null;
  z: number;
}

export interface MapCanvasProps {
  layout: WorldLayout | null;
  ground: DecodedGround | null;
  objects: CatalogueObject[];
  entries: Draft[];
  selected: Selected;
  /** A marketplace item is armed: a click on empty ground places it. */
  placeMode: boolean;
  onSelect: (sel: Selected) => void;
  onDrag: (target: NonNullable<Selected>, x: number, z: number, phase: 'move' | 'end') => void;
  onPlaceAt: (x: number, z: number) => void;
  onHover?: (info: HoverInfo | null) => void;
}

const HIT_TOL_PX = 8;
const DRAG_THRESHOLD_PX = 3;
const HEIGHT_PX = 520;
/** Above this many samples the ground layer is not painted (see the header). */
export const GROUND_CELL_CAP = 70_000;

const C = {
  bg: '#050b12',
  bounds: 'rgba(82, 233, 255, 0.35)',
  shape: 'rgba(96, 150, 180, 0.35)',
  object: moveColour,
  objectFaint: 'rgba(82, 233, 255, 0.35)',
  place: placeColour,
  pending: okColour,
  selected: '#ffffff',
  text: '#cfe6f2',
};

const EDITABLE = 'input, textarea, select, [contenteditable="true"]';

function dot(ctx: CanvasRenderingContext2D, x: number, y: number, r: number, colour: string) {
  ctx.fillStyle = colour;
  ctx.beginPath();
  ctx.arc(x, y, r, 0, Math.PI * 2);
  ctx.fill();
}

function ring(ctx: CanvasRenderingContext2D, x: number, y: number, r: number, colour: string) {
  ctx.strokeStyle = colour;
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.arc(x, y, r, 0, Math.PI * 2);
  ctx.stroke();
}

function diamond(ctx: CanvasRenderingContext2D, x: number, y: number, r: number, colour: string) {
  ctx.fillStyle = colour;
  ctx.beginPath();
  ctx.moveTo(x, y - r);
  ctx.lineTo(x + r, y);
  ctx.lineTo(x, y + r);
  ctx.lineTo(x - r, y);
  ctx.closePath();
  ctx.fill();
}

type Gesture =
  | { mode: 'pan'; lastX: number; lastY: number }
  | { mode: 'drag'; target: NonNullable<Selected>; startX: number; startY: number; moved: boolean }
  | { mode: 'click'; hit: HitCandidate | null; startX: number; startY: number; lastX: number; lastY: number; moved: boolean };

export default function MapCanvas(props: MapCanvasProps) {
  const { layout, ground, objects, entries, selected, placeMode, onSelect, onDrag, onPlaceAt, onHover } = props;
  const ref = useRef<HTMLCanvasElement>(null);
  const viewRef = useRef<MapView | null>(null);
  const gestureRef = useRef<Gesture | null>(null);
  const spaceRef = useRef(false);
  /* Whether the pointer is over the canvas: Space is only swallowed then. */
  const hoveredRef = useRef(false);
  const [tick, setTick] = useState(0);
  const [hover, setHover] = useState<{ sx: number; sy: number; info: HoverInfo } | null>(null);
  const redraw = useCallback(() => setTick((t) => t + 1), []);

  const objectByName = useMemo(() => new Map(objects.map((o) => [o.name, o])), [objects]);

  /* One name → pending-move lookup per `entries` change, shared by the hit
   * candidates and the draw. A per-object `find` over the document, twice a
   * frame, is a million steps per drag frame at 2 000 objects × 500 entries. */
  const moveByName = useMemo(() => {
    const m = new Map<string, Draft & MoveEntry>();
    for (const e of entries) if (e.kind === 'move') m.set(e.target.name, e);
    return m;
  }, [entries]);

  /* Hit candidates: every reported object (at its reported AND pending
   * position, both selecting the object), every placement, and every move
   * whose target the game did not report (a free-text move). */
  const candidates = useMemo<HitCandidate[]>(() => {
    const out: HitCandidate[] = [];
    for (const o of objects) {
      // r: 0 — these marks are drawn at a fixed PIXEL radius, so their hit reach must not grow with zoom
      // (hitTest adds r·scale; at MAX_SCALE a 0.5 m radius would reach 200 px). Reserve r for footprint rects.
      out.push({ key: `o:${o.name}`, x: o.position.x, z: o.position.z, r: 0 });
      const mv = moveByName.get(o.name);
      if (mv?.position) out.push({ key: `o:${o.name}`, x: mv.position.x, z: mv.position.z, r: 0 });
    }
    for (const e of entries) {
      if (e.kind === 'place') out.push({ key: `e:${e._key}`, x: e.position.x, z: e.position.z, r: 0 });
      else if (e.position && !objectByName.has(e.target.name)) {
        out.push({ key: `e:${e._key}`, x: e.position.x, z: e.position.z, r: 0 });
      }
    }
    return out;
  }, [objects, entries, objectByName, moveByName]);

  const groundRange = useMemo(() => {
    if (!ground || ground.nx * ground.nz > GROUND_CELL_CAP) return null;
    let min = Infinity;
    let max = -Infinity;
    for (let i = 0; i < ground.heights.length; i += ground.layers) {
      const h = ground.heights[i];
      if (h === NO_SAMPLE) continue;
      if (h < min) min = h;
      if (h > max) max = h;
    }
    return min === Infinity ? null : { min, max: Math.max(max, min + 1) };
  }, [ground]);

  const describe = useCallback(
    (hit: HitCandidate): HoverInfo => {
      if (hit.key.startsWith('o:')) {
        const name = hit.key.slice(2);
        const p = selectedPosition(objects, entries, { kind: 'object', name });
        return { label: name, x: hit.x, y: p?.y ?? null, z: hit.z };
      }
      const e = entries.find((d) => d._key === hit.key.slice(2));
      const labelText = e ? (e.kind === 'place' ? `${e.item.name} ×${e.quantity}` : e.target.name) : 'entry';
      return { label: labelText, x: hit.x, y: e?.position?.y ?? null, z: hit.z };
    },
    [objects, entries]
  );

  /* A new layout is a new world or fresh bounds: refit. */
  useEffect(() => {
    viewRef.current = null;
    redraw();
  }, [layout, redraw]);

  /* The map pans to a selection that is off-canvas — once per selection
   * change, never per drag frame (a drag keeps the selection). */
  const selectedKey = selectionKey(selected);
  useEffect(() => {
    const v = viewRef.current;
    const p = selectedPosition(objects, entries, selected);
    if (!v || !p) return;
    const s = toScreen(v, p.x, p.z);
    const inset = 20;
    if (s.sx < inset || s.sy < inset || s.sx > v.w - inset || s.sy > v.h - inset) {
      viewRef.current = pan(v, v.w / 2 - s.sx, v.h / 2 - s.sy);
      redraw();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedKey]);

  /* Wheel must preventDefault, and React registers `onWheel` passive, so it
   * is a native listener. Space is tracked for space-drag panning and is
   * swallowed only while the pointer is over the canvas and the key did not
   * land in a text field, so the page neither scrolls nor loses a typed space. */
  useEffect(() => {
    const cv = ref.current;
    if (!cv) return;
    const onWheel = (e: WheelEvent) => {
      const v = viewRef.current;
      if (!v) return;
      e.preventDefault();
      const r = cv.getBoundingClientRect();
      viewRef.current = zoomAt(v, e.clientX - r.left, e.clientY - r.top, e.deltaY < 0 ? 1.15 : 1 / 1.15);
      redraw();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.code !== 'Space') return;
      spaceRef.current = e.type === 'keydown';
      const target = e.target as HTMLElement | null;
      if (hoveredRef.current && !target?.closest(EDITABLE)) e.preventDefault();
    };
    let timer: ReturnType<typeof setTimeout>;
    const onResize = () => {
      clearTimeout(timer);
      timer = setTimeout(redraw, 160);
    };
    cv.addEventListener('wheel', onWheel, { passive: false });
    window.addEventListener('keydown', onKey);
    window.addEventListener('keyup', onKey);
    window.addEventListener('resize', onResize);
    return () => {
      clearTimeout(timer);
      cv.removeEventListener('wheel', onWheel);
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('keyup', onKey);
      window.removeEventListener('resize', onResize);
    };
  }, [redraw]);

  /* The draw. */
  useEffect(() => {
    const cv = ref.current;
    if (!cv) return;
    const size = fit(cv);
    if (!size) return;
    const { ctx, w, h } = size;
    let view = viewRef.current;
    if (!view) view = createView(layout?.bounds ?? null, w, h);
    else if (view.w !== w || view.h !== h) view = resizeView(view, w, h);
    viewRef.current = view;
    if (process.env.NODE_ENV !== 'production') {
      (window as unknown as { __mapView?: MapView }).__mapView = view;
    }

    ctx.fillStyle = C.bg;
    ctx.fillRect(0, 0, w, h);

    /* Ground first, under the floorplan: a filled shape must not be tinted
     * by the grid, and the bounds dashes must stay visible over both. */
    if (ground && groundRange) {
      const { originX, originZ, step, nx, nz, layers, heights } = ground;
      const cell = step * view.scale + 0.5;
      const span = groundRange.max - groundRange.min;
      for (let j = 0; j < nz; j++) {
        for (let i = 0; i < nx; i++) {
          const hcm = heights[(j * nx + i) * layers];
          if (hcm === NO_SAMPLE) continue;
          const s = toScreen(view, originX + i * step, originZ + j * step);
          if (s.sx > w || s.sy > h || s.sx + cell < 0 || s.sy + cell < 0) continue;
          const t = (hcm - groundRange.min) / span;
          ctx.fillStyle = `rgba(120, 170, 200, ${(0.05 + 0.25 * t).toFixed(3)})`;
          ctx.fillRect(s.sx, s.sy, cell, cell);
        }
      }
    }

    if (layout) {
      for (const s of layout.shapes) {
        ctx.beginPath();
        if (s.kind === 'rect') {
          const corners = rectCorners(s);
          for (let k = 0; k < 4; k++) {
            const p = toScreen(view, corners[k][0], corners[k][1]);
            if (k === 0) ctx.moveTo(p.sx, p.sy);
            else ctx.lineTo(p.sx, p.sy);
          }
          ctx.closePath();
        } else if (s.kind === 'circle') {
          const p = toScreen(view, s.x, s.z);
          ctx.arc(p.sx, p.sy, Math.max(0.2, s.r) * view.scale, 0, Math.PI * 2);
        } else {
          if (s.points.length < 2) continue;
          for (let k = 0; k < s.points.length; k++) {
            const p = toScreen(view, s.points[k][0], s.points[k][1]);
            if (k === 0) ctx.moveTo(p.sx, p.sy);
            else ctx.lineTo(p.sx, p.sy);
          }
          if (s.closed) ctx.closePath();
        }
        const fill = s.kind === 'path' ? '' : cssColour(s.fill, '');
        const stroke = cssColour(s.stroke, '');
        if (fill) {
          ctx.fillStyle = fill;
          ctx.fill();
        }
        if (stroke) {
          ctx.strokeStyle = stroke;
          ctx.lineWidth = Math.max(0.5, (s.width ?? 0.65) * view.scale);
          ctx.stroke();
        }
        if (!fill && !stroke) {
          ctx.fillStyle = C.shape;
          ctx.fill();
        }
      }
      const a = toScreen(view, layout.bounds.min.x, layout.bounds.min.z);
      const b = toScreen(view, layout.bounds.max.x, layout.bounds.max.z);
      ctx.strokeStyle = C.bounds;
      ctx.lineWidth = 1;
      ctx.setLineDash([6, 4]);
      ctx.strokeRect(a.sx, a.sy, b.sx - a.sx, b.sy - a.sy);
      ctx.setLineDash([]);
    }

    const sKey = selectionKey(selected);
    for (const o of objects) {
      const mv = moveByName.get(o.name);
      const isSel = sKey === `o:${o.name}`;
      const p = toScreen(view, o.position.x, o.position.z);
      if (mv?.position) {
        const q = toScreen(view, mv.position.x, mv.position.z);
        ctx.strokeStyle = C.pending;
        ctx.lineWidth = 1;
        ctx.setLineDash([4, 3]);
        ctx.beginPath();
        ctx.moveTo(p.sx, p.sy);
        ctx.lineTo(q.sx, q.sy);
        ctx.stroke();
        ctx.setLineDash([]);
        dot(ctx, p.sx, p.sy, 2.5, C.objectFaint);
        ring(ctx, q.sx, q.sy, isSel ? 7 : 5, C.pending);
        if (isSel) ring(ctx, q.sx, q.sy, 10, C.selected);
      } else {
        dot(ctx, p.sx, p.sy, isSel ? 4.5 : 3, mv?.hidden ? C.objectFaint : C.object);
        if (isSel) ring(ctx, p.sx, p.sy, 9, C.selected);
      }
    }
    for (const e of entries) {
      const isSel = sKey === `e:${e._key}`;
      if (e.kind === 'place') {
        const p = toScreen(view, e.position.x, e.position.z);
        diamond(ctx, p.sx, p.sy, isSel ? 7 : 5, C.place);
        if (isSel) ring(ctx, p.sx, p.sy, 11, C.selected);
      } else if (e.position && !objectByName.has(e.target.name)) {
        const p = toScreen(view, e.position.x, e.position.z);
        ring(ctx, p.sx, p.sy, isSel ? 7 : 5, C.pending);
        if (isSel) ring(ctx, p.sx, p.sy, 10, C.selected);
      }
    }

    ctx.fillStyle = C.text;
    ctx.font = '11px system-ui, sans-serif';
    ctx.fillText('N ↑ (−Z)', 8, 14);
    ctx.fillText(`${view.scale >= 1 ? fmt(view.scale) + ' px/m' : fmt(1 / view.scale) + ' m/px'}`, 8, h - 8);
    if (placeMode) ctx.fillText('click empty ground to place', 8, 30);

    if (hover) {
      const text = `${hover.info.label}  (${fmt(hover.info.x)}, ${hover.info.y === null ? '?' : fmt(hover.info.y)}, ${fmt(hover.info.z)})`;
      const tw = ctx.measureText(text).width + 10;
      const tx = Math.min(hover.sx + 12, w - tw - 4);
      const ty = Math.max(hover.sy - 22, 4);
      ctx.fillStyle = 'rgba(4, 10, 15, 0.9)';
      ctx.fillRect(tx, ty, tw, 18);
      ctx.fillStyle = C.text;
      ctx.fillText(text, tx + 5, ty + 13);
    }
  }, [layout, ground, groundRange, objects, entries, selected, placeMode, hover, tick, objectByName, moveByName]);

  const local = (e: ReactPointerEvent<HTMLCanvasElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    return { sx: e.clientX - r.left, sy: e.clientY - r.top };
  };

  function onPointerDown(e: ReactPointerEvent<HTMLCanvasElement>) {
    const view = viewRef.current;
    if (!view) return;
    /* Only the primary and middle buttons start a gesture; a right-click
     * must not capture the pointer. Any gesture clears the hover label so it
     * is not left painted at a stale spot while the map moves under it. */
    if (e.button !== 0 && e.button !== 1) return;
    const { sx, sy } = local(e);
    e.currentTarget.setPointerCapture(e.pointerId);
    setHover(null);
    onHover?.(null);
    if (e.button === 1 || spaceRef.current) {
      gestureRef.current = { mode: 'pan', lastX: sx, lastY: sy };
      return;
    }
    const hit = hitTest(view, candidates, sx, sy, HIT_TOL_PX);
    if (hit && hit.key === selectionKey(selected)) {
      gestureRef.current = { mode: 'drag', target: selectionFromKey(hit.key), startX: sx, startY: sy, moved: false };
      return;
    }
    gestureRef.current = { mode: 'click', hit, startX: sx, startY: sy, lastX: sx, lastY: sy, moved: false };
  }

  function onPointerMove(e: ReactPointerEvent<HTMLCanvasElement>) {
    const view = viewRef.current;
    if (!view) return;
    const { sx, sy } = local(e);
    const g = gestureRef.current;
    if (!g) {
      const hit = hitTest(view, candidates, sx, sy, HIT_TOL_PX);
      const info = hit ? describe(hit) : null;
      setHover(info ? { sx, sy, info } : null);
      onHover?.(info);
      return;
    }
    if (g.mode === 'pan') {
      viewRef.current = pan(view, sx - g.lastX, sy - g.lastY);
      g.lastX = sx;
      g.lastY = sy;
      redraw();
      return;
    }
    if (g.mode === 'drag') {
      if (!g.moved && Math.hypot(sx - g.startX, sy - g.startY) < DRAG_THRESHOLD_PX) return;
      g.moved = true;
      const p = toWorld(view, sx, sy);
      onDrag(g.target, p.x, p.z, 'move');
      return;
    }
    if (!g.moved && Math.hypot(sx - g.startX, sy - g.startY) < DRAG_THRESHOLD_PX) return;
    g.moved = true;
    if (!g.hit) {
      viewRef.current = pan(view, sx - g.lastX, sy - g.lastY);
      redraw();
    }
    g.lastX = sx;
    g.lastY = sy;
  }

  function onPointerUp(e: ReactPointerEvent<HTMLCanvasElement>) {
    const view = viewRef.current;
    const g = gestureRef.current;
    gestureRef.current = null;
    if (!view || !g) return;
    const { sx, sy } = local(e);
    if (g.mode === 'drag') {
      if (g.moved) {
        const p = toWorld(view, sx, sy);
        onDrag(g.target, p.x, p.z, 'end');
      }
      return;
    }
    if (g.mode === 'click' && !g.moved) {
      if (g.hit) onSelect(selectionFromKey(g.hit.key));
      else if (placeMode) {
        const p = toWorld(view, sx, sy);
        onPlaceAt(p.x, p.z);
      } else onSelect(null);
    }
  }

  function onPointerEnter() {
    hoveredRef.current = true;
  }

  function onPointerLeave() {
    hoveredRef.current = false;
    setHover(null);
    onHover?.(null);
  }

  return (
    <canvas
      ref={ref}
      data-e2e="map-canvas"
      role="img"
      aria-label={`Top-down map: ${objects.length} named objects, ${entries.length} overlay entries. Use the object picker to select by keyboard.`}
      style={{
        width: '100%',
        height: HEIGHT_PX,
        display: 'block',
        borderRadius: 12,
        background: C.bg,
        touchAction: 'none',
        cursor: placeMode ? 'crosshair' : 'grab',
      }}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      onPointerEnter={onPointerEnter}
      onPointerLeave={onPointerLeave}
      /* Windows Chrome/Edge start autoscroll on a middle MOUSE down unless
       * that event (not the pointer event) is default-prevented. */
      onMouseDown={(e) => {
        if (e.button === 1) e.preventDefault();
      }}
      onAuxClick={(e) => e.preventDefault()}
    />
  );
}
