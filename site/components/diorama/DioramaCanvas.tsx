'use client';

import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef } from 'react';
import type { RefObject } from 'react';
import type * as ThreeNS from 'three';
import type { DioramaHandle, DioramaScene, QualityTier } from './types';
import { dprCap, pickQuality } from './quality';
import { FADE_DURATION, fadeDone, fadeOpacity, fadePeak, fadeRetargetTime, fadeShowsIncoming } from './fade';

export interface DioramaSceneEntry {
  id: string;
  accent: string; // hex color for the world's accent, e.g. '#7c5cff'
  factory: () => DioramaScene;
}

export interface DioramaCanvasProps {
  scenes: DioramaSceneEntry[];
  /** Forwarded to the <canvas>; the parent styles it fixed full-viewport. */
  className?: string;
  /** Called once if the WebGL context cannot be created; parent shows a fallback. */
  onError?: () => void;
  /**
   * Element whose viewport intersection gates the renderer (the `.gateway`
   * container — the canvas itself is fixed-position so it always "intersects").
   * Near it (200px): three.js loads and the renderer boots. Fully offscreen:
   * the rAF loop pauses; back to >=1% visible: it resumes. Omitted: no gating.
   */
  watchRef?: RefObject<HTMLElement | null>;
}

interface BuiltScene {
  module: DioramaScene;
  scene: ThreeNS.Scene; // one real Scene per world — free isolation, exact SceneCtx type
}

interface Engine {
  THREE: typeof ThreeNS;
  renderer: ThreeNS.WebGLRenderer;
  camera: ThreeNS.PerspectiveCamera;
  quality: QualityTier;
  // Keyed by entry.id (not array index): the `scenes` prop is expected to be a stable
  // registry — same order and length across renders — but id is the durable identity.
  built: Map<string, BuiltScene>;
}

/** In-flight cross-fade ("dip to dark"): timing math lives in ./fade.ts. */
interface FadeState {
  /** Outgoing entry id (null if the previous world was never resolvable). */
  fromId: string | null;
  /** Outgoing world's scroll progress, frozen at fade start (deterministic). */
  fromProgress: number;
  /** Elapsed seconds within the fade window (dt-driven). */
  t: number;
}

/** Frames per rolling window and the threshold for stepping quality down. */
const PERF_WINDOW_FRAMES = 60;
const PERF_SLOW_AVG_MS = 28;
const PERF_SLOW_WINDOWS = 3;
/** Keep the active world and its immediate neighbours built; dispose the rest. */
const MAX_BUILT = 3;

/**
 * Single shared WebGL renderer for all diorama worlds.
 *
 * - `three` is dynamically imported on mount (never in the module graph of the
 *   page), and — when `watchRef` is provided — only once the gateway container
 *   comes within 200px of the viewport.
 * - Each world gets its own THREE.Scene, built lazily on first activation; only the
 *   active world's scene is updated and rendered each frame (during a cross-fade
 *   window both outgoing and incoming update; see `frame`).
 * - Driven imperatively via the DioramaHandle ref (`setActive(index, progress)`) —
 *   no React state, so the scroll orchestrator can call it every frame.
 * - World switches dip a fixed overlay div to dark over ~450ms; after each fade,
 *   built scenes outside [active-1, active+1] are disposed (rebuilt on return).
 * - A rolling frame-time average steps the quality tier down (never up) under
 *   sustained load, re-tiering every built scene via its setQuality contract.
 */
const DioramaCanvas = forwardRef<DioramaHandle, DioramaCanvasProps>(
  function DioramaCanvas({ scenes, className, onError, watchRef }, ref) {
    const canvasRef = useRef<HTMLCanvasElement | null>(null);
    const overlayRef = useRef<HTMLDivElement | null>(null);
    const engineRef = useRef<Engine | null>(null);
    // null until the orchestrator activates a world for the first time.
    const activeRef = useRef<{ index: number; progress: number } | null>(null);
    // null when no world switch is in flight.
    const fadeRef = useRef<FadeState | null>(null);

    // Keep latest props reachable from the once-only mount effect without re-running it.
    const scenesRef = useRef(scenes);
    scenesRef.current = scenes;
    const onErrorRef = useRef(onError);
    onErrorRef.current = onError;
    const watchRefRef = useRef(watchRef);
    watchRefRef.current = watchRef;

    // Only touches refs (never props/state directly), so an empty dep array is correct —
    // satisfies react-hooks/exhaustive-deps for the [] hooks below that call it.
    const ensureBuilt = useCallback((index: number) => {
      const engine = engineRef.current;
      if (!engine) return;
      const entry = scenesRef.current[index];
      if (!entry) return;
      if (engine.built.has(entry.id)) return;
      const { THREE, renderer, camera, quality } = engine;
      const scene = new THREE.Scene();
      const module = entry.factory();
      if (process.env.NODE_ENV !== 'production' && module.id !== entry.id) {
        // Dev-only invariant: factory output must self-identify with the registry id it
        // was built from. Log and continue — production should degrade, not crash.
        console.error(
          `DioramaCanvas: scene entry "${entry.id}" factory produced a module with id "${module.id}"; they must match.`,
        );
      }
      module.build({
        THREE,
        scene,
        renderer,
        camera,
        accent: new THREE.Color(entry.accent),
        quality,
      });
      engine.built.set(entry.id, { module, scene });
    }, []);

    useImperativeHandle(
      ref,
      () => ({
        setActive(index: number, progress: number) {
          const count = scenesRef.current.length;
          if (count === 0) return;
          const clamped = Math.min(Math.max(Math.trunc(index), 0), count - 1);
          const prev = activeRef.current;
          if (prev && prev.index !== clamped) {
            // World switch: start (or retarget) a dip-to-dark fade toward the new
            // incoming world. Mid-fade flips restart the window from whichever
            // scene is CURRENTLY visible, with the clock placed so the overlay
            // opacity is continuous — no snap, and (because every window runs to
            // completion) the overlay can never be left stuck dark.
            const prevEntry = scenesRef.current[prev.index];
            const fade = fadeRef.current;
            let fromId: string | null = prevEntry ? prevEntry.id : null;
            let fromProgress = prev.progress;
            let t = 0;
            if (fade) {
              if (!fadeShowsIncoming(fade.t, FADE_DURATION)) {
                fromId = fade.fromId;
                fromProgress = fade.fromProgress;
              }
              const peak = fadePeak(engineRef.current?.quality ?? 'medium');
              t = fadeRetargetTime(fadeOpacity(fade.t, FADE_DURATION, peak), FADE_DURATION, peak);
            }
            fadeRef.current = { fromId, fromProgress, t };
          }
          activeRef.current = { index: clamped, progress };
          ensureBuilt(clamped); // no-op until three has loaded; init catches up
        },
      }),
      [],
    );

    useEffect(() => {
      const canvas = canvasRef.current;
      if (!canvas) return;

      let disposed = false;
      let rafId = 0;
      let running = false;
      let last = 0;
      let engine: Engine | null = null;
      // True until an IntersectionObserver on the watch element says otherwise.
      let inView = true;
      let nearIO: IntersectionObserver | null = null;
      let viewIO: IntersectionObserver | null = null;
      let resolveNear: (() => void) | null = null;

      // Rolling frame-time window for downward-only dynamic quality.
      let frameCount = 0;
      let frameAccumMs = 0;
      let slowWindows = 0;

      const trackFrameTime = (ms: number) => {
        // Ignore non-frames (tab switches, long stalls) — they'd poison the average.
        if (!engine || ms <= 0 || ms > 250) return;
        frameAccumMs += ms;
        frameCount += 1;
        if (frameCount < PERF_WINDOW_FRAMES) return;
        const avg = frameAccumMs / frameCount;
        frameCount = 0;
        frameAccumMs = 0;
        if (avg > PERF_SLOW_AVG_MS) slowWindows += 1;
        else slowWindows = 0;
        if (slowWindows >= PERF_SLOW_WINDOWS && engine.quality !== 'low') {
          const next: QualityTier = engine.quality === 'high' ? 'medium' : 'low';
          engine.quality = next; // new builds and fades pick this up too
          for (const { module } of engine.built.values()) module.setQuality(next);
          engine.renderer.setPixelRatio(Math.min(window.devicePixelRatio, dprCap(next)));
          slowWindows = 0;
          if (process.env.NODE_ENV !== 'production') {
            console.debug(
              `DioramaCanvas: sustained avg frame > ${PERF_SLOW_AVG_MS}ms — quality stepped down to '${next}'.`,
            );
          }
        }
      };

      /** Post-fade memory policy: keep at most the active world ± 1 built. */
      const pruneBuilt = (eng: Engine, activeIndex: number) => {
        if (eng.built.size <= MAX_BUILT) return;
        const keep = new Set<string>();
        for (let i = activeIndex - 1; i <= activeIndex + 1; i += 1) {
          const entry = scenesRef.current[i];
          if (entry) keep.add(entry.id);
        }
        for (const [id, built] of eng.built) {
          if (keep.has(id)) continue;
          built.module.dispose();
          eng.built.delete(id);
          if (process.env.NODE_ENV !== 'production') {
            console.debug(`DioramaCanvas: disposed non-adjacent scene '${id}'.`);
          }
        }
      };

      const frame = (now: number) => {
        rafId = requestAnimationFrame(frame);
        const rawMs = now - last;
        const dt = Math.min(rawMs / 1000, 0.1);
        last = now;
        if (document.hidden || !engine) return;
        const active = activeRef.current;
        if (!active) return;
        const entry = scenesRef.current[active.index];
        if (!entry) return;
        const inBuilt = engine.built.get(entry.id);

        const fade = fadeRef.current;
        if (fade) {
          fade.t += dt;
          if (fadeDone(fade.t, FADE_DURATION)) {
            // Window over: clear the overlay, then apply the memory policy —
            // never mid-fade, so the outgoing scene is safe while visible.
            fadeRef.current = null;
            if (overlayRef.current) overlayRef.current.style.opacity = '0';
            pruneBuilt(engine, active.index);
            // Fall through to the normal single-scene path this same frame.
          } else {
            const peak = fadePeak(engine.quality);
            if (overlayRef.current) {
              overlayRef.current.style.opacity = String(fadeOpacity(fade.t, FADE_DURATION, peak));
            }
            const outBuilt = fade.fromId ? engine.built.get(fade.fromId) : undefined;
            // Visible scene this half of the window (incoming if outgoing is gone).
            const visible = fadeShowsIncoming(fade.t, FADE_DURATION) ? inBuilt : (outBuilt ?? inBuilt);
            if (engine.quality !== 'low') {
              // Warm the hidden party too (the 'low' dip is fully opaque instead,
              // so low tier never pays for two scene updates in one frame).
              if (outBuilt && outBuilt !== visible) outBuilt.module.update(dt, fade.fromProgress, true);
              if (inBuilt && inBuilt !== visible) inBuilt.module.update(dt, active.progress, true);
            }
            if (visible) {
              visible.module.update(dt, visible === inBuilt ? active.progress : fade.fromProgress, true);
              engine.renderer.render(visible.scene, engine.camera);
            }
            trackFrameTime(rawMs);
            return;
          }
        }

        if (!inBuilt) return;
        inBuilt.module.update(dt, active.progress, true);
        engine.renderer.render(inBuilt.scene, engine.camera);
        trackFrameTime(rawMs);
      };

      const start = () => {
        if (running || disposed || document.hidden || !inView) return;
        running = true;
        last = performance.now();
        rafId = requestAnimationFrame(frame);
      };
      const stop = () => {
        if (!running) return;
        running = false;
        cancelAnimationFrame(rafId);
      };

      const onVisibility = () => {
        if (document.hidden) stop();
        else start();
      };

      const onResize = () => {
        if (!engine) return;
        const w = canvas.clientWidth;
        const h = canvas.clientHeight;
        if (w === 0 || h === 0) return;
        engine.renderer.setSize(w, h, false);
        engine.camera.aspect = w / h;
        engine.camera.updateProjectionMatrix();
      };

      const init = async () => {
        // Lazy-boot gate: don't pay for three.js/WebGL while the visitor sits at
        // the hero — wait (one-shot) until the gateway is within 200px of view.
        const watchEl = watchRefRef.current?.current ?? null;
        if (watchEl && typeof IntersectionObserver !== 'undefined') {
          await new Promise<void>((resolve) => {
            resolveNear = resolve;
            nearIO = new IntersectionObserver(
              (entries) => {
                if (entries.some((e) => e.isIntersecting)) {
                  nearIO?.disconnect();
                  nearIO = null;
                  resolve();
                }
              },
              { rootMargin: '200px' },
            );
            nearIO.observe(watchEl);
          });
          resolveNear = null;
          if (disposed) return;
        }

        const THREE = await import('three');
        if (disposed) return;

        // Initial tier from device heuristics; may only step DOWN afterwards
        // (see trackFrameTime) — no upward re-tiering.
        const quality = pickQuality();
        let renderer: ThreeNS.WebGLRenderer;
        try {
          renderer = new THREE.WebGLRenderer({
            canvas,
            powerPreference: 'high-performance',
            antialias: quality !== 'low',
            alpha: true,
          });
        } catch {
          onErrorRef.current?.();
          return;
        }
        renderer.setPixelRatio(Math.min(window.devicePixelRatio, dprCap(quality)));

        const w = canvas.clientWidth || window.innerWidth;
        const h = canvas.clientHeight || window.innerHeight;
        renderer.setSize(w, h, false);

        const camera = new THREE.PerspectiveCamera(50, w / h, 0.1, 200);

        engine = { THREE, renderer, camera, quality, built: new Map() };
        engineRef.current = engine;

        // setActive may have been called while three was loading.
        if (activeRef.current) ensureBuilt(activeRef.current.index);

        // Offscreen gate: the canvas is fixed-position (always "visible"), so
        // observe the gateway container instead — pause when it's fully out of
        // view (reader is in the hero or past the gateway), resume at >=1%.
        if (watchEl && typeof IntersectionObserver !== 'undefined') {
          viewIO = new IntersectionObserver(
            (entries) => {
              const latest = entries[entries.length - 1];
              if (!latest) return;
              inView = latest.isIntersecting;
              if (inView) start();
              else stop();
            },
            { threshold: [0, 0.01] },
          );
          viewIO.observe(watchEl);
        }

        window.addEventListener('resize', onResize);
        document.addEventListener('visibilitychange', onVisibility);
        start();
      };

      void init();

      return () => {
        disposed = true;
        stop();
        nearIO?.disconnect();
        nearIO = null;
        viewIO?.disconnect();
        viewIO = null;
        resolveNear?.(); // settle the pending near-gate so init's frame is released
        window.removeEventListener('resize', onResize);
        document.removeEventListener('visibilitychange', onVisibility);
        const e = engineRef.current;
        engineRef.current = null;
        if (e) {
          for (const { module } of e.built.values()) module.dispose();
          e.built.clear();
          e.renderer.dispose();
          e.renderer.forceContextLoss?.();
        }
        // The <canvas> element itself is React's to remove.
      };
    }, []);

    return (
      <>
        <canvas ref={canvasRef} className={className} aria-hidden="true" />
        {/* Cross-fade dip: opacity driven imperatively from the rAF loop. */}
        <div ref={overlayRef} className="gw-fade" aria-hidden="true" />
      </>
    );
  },
);

export default DioramaCanvas;
