import * as THREE from 'three';
import type { SceneCtx, QualityTier } from './types';

/**
 * Headless SceneCtx for vitest (node environment).
 *
 * Real THREE object creation (geometries, materials, groups, cameras) works
 * without a GL context; only rendering needs one, so the renderer is a minimal
 * stub — scenes must never call renderer methods during build/update, only add
 * to `scene` and move `camera`.
 *
 * Test-only file: the static `three` import is fine here because this module is
 * imported exclusively by *.test.ts files, which vitest runs in node and Next
 * never pulls into the app bundle (nothing under app/ or components/ imports it).
 */
export function makeTestCtx(quality: QualityTier = 'high'): SceneCtx {
  return {
    THREE,
    scene: new THREE.Scene(),
    camera: new THREE.PerspectiveCamera(50, 1.6, 0.1, 200),
    renderer: {} as THREE.WebGLRenderer,
    accent: new THREE.Color('#52e9ff'),
    quality,
  };
}
