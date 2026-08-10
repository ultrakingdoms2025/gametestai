'use client';

import { forwardRef, useEffect, useImperativeHandle, useRef } from 'react';
import type * as ThreeNS from 'three';
import type { DioramaHandle, DioramaScene, QualityTier } from './types';
import { dprCap, pickQuality } from './quality';

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
  built: Map<number, BuiltScene>;
}

/**
 * Single shared WebGL renderer for all diorama worlds.
 *
 * - `three` is dynamically imported on mount (never in the module graph of the page).
 * - Each world gets its own THREE.Scene, built lazily on first activation; only the
 *   active world's scene is updated and rendered each frame.
 * - Driven imperatively via the DioramaHandle ref (`setActive(index, progress)`) —
 *   no React state, so the scroll orchestrator can call it every frame.
 * - Cross-fade and memory-pressure disposal are intentionally not implemented here.
 */
const DioramaCanvas = forwardRef<DioramaHandle, DioramaCanvasProps>(
  function DioramaCanvas({ scenes, className, onError }, ref) {
    const canvasRef = useRef<HTMLCanvasElement | null>(null);
    const engineRef = useRef<Engine | null>(null);
    // null until the orchestrator activates a world for the first time.
    const activeRef = useRef<{ index: number; progress: number } | null>(null);

    // Keep latest props reachable from the once-only mount effect without re-running it.
    const scenesRef = useRef(scenes);
    scenesRef.current = scenes;
    const onErrorRef = useRef(onError);
    onErrorRef.current = onError;

    const ensureBuilt = (index: number) => {
      const engine = engineRef.current;
      if (!engine || engine.built.has(index)) return;
      const entry = scenesRef.current[index];
      if (!entry) return;
      const { THREE, renderer, camera, quality } = engine;
      const scene = new THREE.Scene();
      const module = entry.factory();
      module.build({
        THREE,
        scene,
        renderer,
        camera,
        accent: new THREE.Color(entry.accent),
        quality,
      });
      engine.built.set(index, { module, scene });
    };

    useImperativeHandle(
      ref,
      () => ({
        setActive(index: number, progress: number) {
          const count = scenesRef.current.length;
          if (count === 0) return;
          const clamped = Math.min(Math.max(Math.trunc(index), 0), count - 1);
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

      const frame = (now: number) => {
        rafId = requestAnimationFrame(frame);
        const dt = Math.min((now - last) / 1000, 0.1);
        last = now;
        if (document.hidden || !engine) return;
        const active = activeRef.current;
        if (!active) return;
        const built = engine.built.get(active.index);
        if (!built) return;
        built.module.update(dt, active.progress, true);
        engine.renderer.render(built.scene, engine.camera);
      };

      const start = () => {
        if (running || disposed) return;
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
        const THREE = await import('three');
        if (disposed) return;

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

        window.addEventListener('resize', onResize);
        document.addEventListener('visibilitychange', onVisibility);
        if (!document.hidden) start();
      };

      void init();

      return () => {
        disposed = true;
        stop();
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

    return <canvas ref={canvasRef} className={className} aria-hidden="true" />;
  },
);

export default DioramaCanvas;
