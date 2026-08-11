import type * as THREE from 'three';

export type QualityTier = 'low' | 'medium' | 'high';

export interface SceneCtx {
  THREE: typeof import('three'); // the dynamically-imported module, passed in by DioramaCanvas
  scene: THREE.Scene;
  renderer: THREE.WebGLRenderer;
  camera: THREE.PerspectiveCamera;
  accent: THREE.Color;
  quality: QualityTier;
}

export interface DioramaScene {
  id: string;                              // MUST equal the world's `scene` id (e.g. 'maze')
  build(ctx: SceneCtx): void;              // lazy, once — use ctx.THREE, never a static `import 'three'`
  update(dt: number, progress: number, active: boolean): void; // progress 0..1
  setQuality(tier: QualityTier): void;
  dispose(): void;                         // free geometry/materials it created
}

/** Imperative handle DioramaCanvas exposes; GatewayDescent owns the ref and drives it from the scroll hook. */
export interface DioramaHandle {
  setActive(index: number, progress: number): void;
}
