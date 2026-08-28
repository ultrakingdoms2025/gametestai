'use client';

import { useCallback, useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import { fit } from '@/lib/painters';
import { NO_SAMPLE, type DecodedGround, type WorldLayout } from '@/lib/mapLayout';
import type { CatalogueObject } from '@/lib/mapOverlay';
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
import {
  fmt,
  hitCandidates,
  hoverInfoFor,
  selectedPosition,
  selectionFromKey,
  selectionKey,
  type Draft,
  type HoverInfo,
  type MapMark,
  type Selected,
} from '@/lib/mapEditorState';
import { moveColour, okColour, placeColour, removeColour } from './mapEditorStyles';

export type { HoverInfo } from '@/lib/mapEditorState';

/**
 * The top-down map. Draws, and forwards pointer events. Decides nothing.
 *
 * ── What it draws, and from where ──────────────────────────────────────────
 *
 * The floorplan is the world's `minimapShapes` as the game reported them,
 * projected through `mapProjection.ts` with the minimap's own rect-corner
 * formula, so this map and the in-game minimap agree on every wall. The
 * marks — which objects and entries are drawn where, and which a click can
 * reach — are `hitCandidates` from `mapEditorState.ts`, one list for both
 * drawing and hit-testing, so what is painted and what is selectable cannot
 * drift apart. The ground grid is drawn lightly under the marks so a dome, a
 * deck and a hole read as different tones; it is skipped above
 * `GROUND_CELL_CAP` cells because a 160 000-rect frame stuttered under drag,
 * and the grid still drives snapping whether or not it is drawn.
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
 * coordinates and never see the device pixel ratio. It runs only when the
 * CSS box or the DPR has changed since the last draw: setting `canvas.width`
 * discards the backing store and its context state, and doing that on every
 * hover and drag frame was the cost of the whole draw again.
 */

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
  removed: removeColour,
  selected: '#ffffff',
  text: '#cfe6f2',
};

/* Ground tones from lowest to highest sample, precomputed once: a template
 * string per cell was a 70 000-string allocation per frame. */
const GROUND_STEPS = 32;
const GROUND_PALETTE = Array.from({ length: GROUND_STEPS }, (_, k) => `rgba(120, 170, 200, ${(0.05 + (0.25 * k) / (GROUND_STEPS - 1)).toFixed(3)})`);

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

function drawMark(ctx: CanvasRenderingContext2D, view: MapView, m: MapMark, isSel: boolean) {
  const p = toScreen(view, m.x, m.z);
  switch (m.mark) {
    case 'origin':
      dot(ctx, p.sx, p.sy, 2.5, C.objectFaint);
      return;
    case 'moved': {
      if (m.from) {
        const o = toScreen(view, m.from.x, m.from.z);
        ctx.strokeStyle = C.pending;
        ctx.lineWidth = 1;
        ctx.setLineDash([4, 3]);
        ctx.beginPath();
        ctx.moveTo(o.sx, o.sy);
        ctx.lineTo(p.sx, p.sy);
        ctx.stroke();
        ctx.setLineDash([]);
      }
      ring(ctx, p.sx, p.sy, isSel ? 7 : 5, C.pending);
      if (isSel) ring(ctx, p.sx, p.sy, 10, C.selected);
      return;
    }
    case 'removed': {
      /* Where the game reported it, faint, struck through: the object is
       * still in the report and still selectable, but it is not in the world. */
      dot(ctx, p.sx, p.sy, isSel ? 4.5 : 3, C.objectFaint);
      ctx.strokeStyle = C.removed;
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(p.sx - 6, p.sy + 6);
      ctx.lineTo(p.sx + 6, p.sy - 6);
      ctx.stroke();
      if (isSel) ring(ctx, p.sx, p.sy, 9, C.selected);
      return;
    }
    case 'object':
      dot(ctx, p.sx, p.sy, isSel ? 4.5 : 3, C.object);
      if (isSel) ring(ctx, p.sx, p.sy, 9, C.selected);
      return;
    case 'place':
      diamond(ctx, p.sx, p.sy, isSel ? 7 : 5, C.place);
      if (isSel) ring(ctx, p.sx, p.sy, 11, C.selected);
      return;
    case 'free':
      ring(ctx, p.sx, p.sy, isSel ? 7 : 5, C.pending);
      if (isSel) ring(ctx, p.sx, p.sy, 10, C.selected);
      return;
  }
}

type Gesture =
  | { mode: 'pan'; lastX: number; lastY: number }
  | { mode: 'drag'; target: NonNullable<Selected>; startX: number; startY: number; lastX: number; lastY: number; moved: boolean }
  | { mode: 'click'; hit: HitCandidate | null; startX: number; startY: number; lastX: number; lastY: number; moved: boolean };

/** The CSS box and DPR the canvas bitmap was last fitted to. */
type Fitted = { w: number; h: number; dpr: number };

/** Space arms a pan only when the key would otherwise reach the page itself, never a control. */
function spaceIsOurs(cv: HTMLCanvasElement): boolean {
  const a = document.activeElement;
  return a === null || a === document.body || a === cv;
}

export default function MapCanvas(props: MapCanvasProps) {
  const { layout, ground, objects, entries, selected, placeMode, onSelect, onDrag, onPlaceAt, onHover } = props;
  const ref = useRef<HTMLCanvasElement>(null);
  const viewRef = useRef<MapView | null>(null);
  const fittedRef = useRef<Fitted | null>(null);
  const gestureRef = useRef<Gesture | null>(null);
  const spaceRef = useRef(false);
  /* Whether the pointer is over the canvas: Space is only swallowed then. */
  const hoveredRef = useRef(false);
  const [tick, setTick] = useState(0);
  const [hover, setHover] = useState<{ sx: number; sy: number; info: HoverInfo } | null>(null);
  /* Only the cursor reads this; the gesture itself lives in the ref. */
  const [panning, setPanning] = useState(false);
  const redraw = useCallback(() => setTick((t) => t + 1), []);

  const marks = useMemo(() => hitCandidates(objects, entries), [objects, entries]);

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

  /* A new layout is a new world or fresh bounds: refit. Nulling the ref is
   * enough — the draw effect below runs later in the same commit. */
  useEffect(() => {
    viewRef.current = null;
  }, [layout]);

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
   * is a native listener. Space is tracked for space-drag panning: it is
   * armed and swallowed only when nothing but the page (or this canvas)
   * has focus — a focused Save button keeps its Space activation and a
   * space typed into a field stays typed — and only while the pointer is
   * over the canvas does the page stop scrolling. A blur disarms it, because
   * the keyup after an alt-tab never arrives. */
  useEffect(() => {
    const cv = ref.current;
    if (!cv) return;
    const onWheel = (e: WheelEvent) => {
      const v = viewRef.current;
      if (!v) return;
      e.preventDefault();
      if (e.deltaY === 0) return;
      const r = cv.getBoundingClientRect();
      viewRef.current = zoomAt(v, e.clientX - r.left, e.clientY - r.top, e.deltaY < 0 ? 1.15 : 1 / 1.15);
      redraw();
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.code !== 'Space' || !spaceIsOurs(cv)) return;
      spaceRef.current = true;
      if (hoveredRef.current) e.preventDefault();
    };
    const onKeyUp = (e: KeyboardEvent) => {
      if (e.code === 'Space') spaceRef.current = false;
    };
    const onBlur = () => {
      spaceRef.current = false;
    };
    let timer: ReturnType<typeof setTimeout>;
    const onResize = () => {
      clearTimeout(timer);
      timer = setTimeout(redraw, 160);
    };
    cv.addEventListener('wheel', onWheel, { passive: false });
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    window.addEventListener('blur', onBlur);
    window.addEventListener('resize', onResize);
    return () => {
      clearTimeout(timer);
      cv.removeEventListener('wheel', onWheel);
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
      window.removeEventListener('blur', onBlur);
      window.removeEventListener('resize', onResize);
    };
  }, [redraw]);

  /* The draw. */
  useEffect(() => {
    const cv = ref.current;
    if (!cv) return;
    const rect = cv.getBoundingClientRect();
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const fitted = fittedRef.current;
    let ctx: CanvasRenderingContext2D | null;
    let w: number;
    let h: number;
    if (!fitted || fitted.w !== rect.width || fitted.h !== rect.height || fitted.dpr !== dpr) {
      const size = fit(cv);
      if (!size) return;
      ({ ctx, w, h } = size);
      fittedRef.current = { w, h, dpr };
    } else {
      ctx = cv.getContext('2d');
      if (!ctx) return;
      ({ w, h } = fitted);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, w, h);
    }
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
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
     * by the grid, and the bounds dashes must stay visible over both. Each
     * cell is centred on its sample, which is where `groundAt` reads it. */
    if (ground && groundRange) {
      const { originX, originZ, step, nx, nz, layers, heights } = ground;
      const cell = step * view.scale + 0.5;
      const half = cell / 2;
      const span = groundRange.max - groundRange.min;
      for (let j = 0; j < nz; j++) {
        for (let i = 0; i < nx; i++) {
          const hcm = heights[(j * nx + i) * layers];
          if (hcm === NO_SAMPLE) continue;
          const s = toScreen(view, originX + i * step, originZ + j * step);
          const x0 = s.sx - half;
          const y0 = s.sy - half;
          if (x0 > w || y0 > h || x0 + cell < 0 || y0 + cell < 0) continue;
          const t = (hcm - groundRange.min) / span;
          ctx.fillStyle = GROUND_PALETTE[Math.round(t * (GROUND_STEPS - 1))];
          ctx.fillRect(x0, y0, cell, cell);
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
    for (const m of marks) drawMark(ctx, view, m, sKey === m.key);

    ctx.fillStyle = C.text;
    ctx.font = '11px system-ui, sans-serif';
    ctx.fillText('N ↑ (−Z)', 8, 14);
    ctx.fillText(`${view.scale >= 1 ? fmt(view.scale) + ' px/m' : fmt(1 / view.scale) + ' m/px'}`, 8, h - 8);
    if (placeMode) ctx.fillText('click empty ground to place', 8, 30);
    if (ground && !groundRange && ground.nx * ground.nz > GROUND_CELL_CAP) {
      const notice = `ground ${ground.nx}×${ground.nz} not painted`;
      ctx.fillText(notice, w - ctx.measureText(notice).width - 8, h - 8);
    }

    if (hover) {
      const text = `${hover.info.label}  (${fmt(hover.info.x)}, ${fmt(hover.info.y)}, ${fmt(hover.info.z)})`;
      const tw = ctx.measureText(text).width + 10;
      const tx = Math.min(hover.sx + 12, w - tw - 4);
      const ty = Math.max(hover.sy - 22, 4);
      ctx.fillStyle = 'rgba(4, 10, 15, 0.9)';
      ctx.fillRect(tx, ty, tw, 18);
      ctx.fillStyle = C.text;
      ctx.fillText(text, tx + 5, ty + 13);
    }
  }, [layout, ground, groundRange, marks, selected, placeMode, hover, tick]);

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
      setPanning(true);
      return;
    }
    const hit = hitTest(view, marks, sx, sy, HIT_TOL_PX);
    /* A press on the selected mark starts a drag — unless the mark says it
     * never drags (`MapMark.draggable`, the removed object's strike-through):
     * that press is a click, so a 3 px slip cannot turn a remove into a move. */
    if (hit && hit.key === selectionKey(selected) && (hit as MapMark).draggable !== false) {
      gestureRef.current = { mode: 'drag', target: selectionFromKey(hit.key), startX: sx, startY: sy, lastX: sx, lastY: sy, moved: false };
      return;
    }
    gestureRef.current = { mode: 'click', hit, startX: sx, startY: sy, lastX: sx, lastY: sy, moved: false };
    /* A press on empty ground pans if it moves; show that from the press. */
    if (!hit) setPanning(true);
  }

  function onPointerMove(e: ReactPointerEvent<HTMLCanvasElement>) {
    const view = viewRef.current;
    if (!view) return;
    const { sx, sy } = local(e);
    const g = gestureRef.current;
    if (!g) {
      const hit = hitTest(view, marks, sx, sy, HIT_TOL_PX);
      const info = hit ? hoverInfoFor(objects, entries, hit.key) : null;
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
      g.lastX = sx;
      g.lastY = sy;
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
    setPanning(false);
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

  /* The browser took the pointer away (a touch became a scroll, a window
   * lost focus mid-press). That is not a click: nothing is selected, nothing
   * is placed. A drag in progress is ended where it was LAST REPORTED, so
   * the parent's drag bookkeeping is released at the point it already
   * applied: a cancel event's own coordinates are not a place the admin
   * chose — a touch that turned into a scroll carries wherever the scroll
   * reached. */
  function onPointerCancel() {
    const view = viewRef.current;
    const g = gestureRef.current;
    gestureRef.current = null;
    setPanning(false);
    if (!view || !g) return;
    if (g.mode === 'drag' && g.moved) {
      const p = toWorld(view, g.lastX, g.lastY);
      onDrag(g.target, p.x, p.z, 'end');
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

  const cursor = panning ? 'grabbing' : hover ? 'pointer' : placeMode ? 'crosshair' : 'grab';

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
        cursor,
      }}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerCancel}
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
