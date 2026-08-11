import type { QualityTier } from './types';

/**
 * Pure math for the DioramaCanvas cross-fade ("dip to dark").
 *
 * The fade is a wall-clock window of FADE_DURATION seconds. A full-viewport
 * overlay (page background #04070d) ramps from 0 opacity to `peak` at the
 * midpoint and back to 0 — a triangle wave. The visible scene switches from
 * outgoing to incoming exactly at the midpoint, while the overlay is darkest.
 *
 * Kept as pure functions (no DOM, no three.js) so the exact timing/opacity
 * contract is unit-testable without a renderer.
 */

/** Total fade window in seconds (dt-driven wall-clock). */
export const FADE_DURATION = 0.45;

/**
 * Peak overlay opacity at the fade midpoint. On 'low' tier the dip is fully
 * opaque so only ONE scene ever needs to update+render per frame — the switch
 * happens behind a solid cover instead of a translucent one.
 */
export function fadePeak(tier: QualityTier): number {
  return tier === 'low' ? 1 : 0.8;
}

/**
 * Overlay opacity at elapsed time `t` seconds into a fade of `duration`
 * seconds peaking at `peak`: 0 → peak (midpoint) → 0. Clamped and
 * division-guarded — a non-positive duration reports the fade as over (0).
 */
export function fadeOpacity(t: number, duration: number, peak: number): number {
  if (!(duration > 0)) return 0;
  const p = Math.min(Math.max(t / duration, 0), 1);
  return peak * (1 - Math.abs(2 * p - 1));
}

/**
 * Whether the incoming scene is the visible one at elapsed time `t`.
 * The switch happens at the midpoint (under the darkest overlay).
 * A non-positive duration means there is no window: show incoming.
 */
export function fadeShowsIncoming(t: number, duration: number): boolean {
  if (!(duration > 0)) return true;
  return t >= duration / 2;
}

/** True once the fade window has fully elapsed. */
export function fadeDone(t: number, duration: number): boolean {
  return !(duration > 0) || t >= duration;
}

/**
 * Elapsed-time to restart a fade at so the overlay opacity is CONTINUOUS when
 * a new setActive lands mid-fade (rapid flips): place the clock on the rising
 * edge at the time whose opacity equals the current one. The overlay then
 * ramps from where it is instead of snapping to 0 — and, because the restarted
 * window always runs to completion, it can never be left stuck dark.
 */
export function fadeRetargetTime(currentOpacity: number, duration: number, peak: number): number {
  if (!(duration > 0) || !(peak > 0)) return 0;
  const frac = Math.min(Math.max(currentOpacity / peak, 0), 1);
  return frac * (duration / 2);
}
