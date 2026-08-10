import type { QualityTier } from './types';

export function pickQuality(): QualityTier {
  if (typeof navigator === 'undefined') return 'medium';
  const mem = (navigator as any).deviceMemory ?? 4;
  const cores = navigator.hardwareConcurrency ?? 4;
  if (mem <= 3 || cores <= 4) return 'low';
  if (mem >= 8 && cores >= 8) return 'high';
  return 'medium';
}

export const dprCap = (t: QualityTier) => (t === 'high' ? 1.75 : t === 'medium' ? 1.5 : 1.0);
