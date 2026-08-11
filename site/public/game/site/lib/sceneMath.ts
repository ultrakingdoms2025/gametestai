/**
 * Shared math helpers for the diorama scenes (and the 2D canvas painters).
 *
 * No `three` dependency here — scene files rely on that to stay free of a
 * static `three` import (three is loaded dynamically by DioramaCanvas), so
 * keep this module dependency-free too.
 */

export const TAU = Math.PI * 2;

/** Deterministic PRNG, so a reload/build draws the same picture. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Classic cubic smoothstep, ease in/out between 0 and 1. */
export function smoothstep(t: number): number {
  return t * t * (3 - 2 * t);
}

/** Linear interpolation between `a` and `b` at `t`. */
export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}
