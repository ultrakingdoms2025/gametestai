import { describe, expect, it } from 'vitest';
import {
  FADE_DURATION,
  fadeDone,
  fadeOpacity,
  fadePeak,
  fadeRetargetTime,
  fadeShowsIncoming,
} from './fade';

const D = FADE_DURATION;

describe('fadePeak', () => {
  it('dips fully opaque on low tier, 0.8 otherwise', () => {
    expect(fadePeak('low')).toBe(1);
    expect(fadePeak('medium')).toBe(0.8);
    expect(fadePeak('high')).toBe(0.8);
  });
});

describe('fadeOpacity', () => {
  it('is a triangle: 0 at the edges, peak at the midpoint', () => {
    expect(fadeOpacity(0, D, 0.8)).toBe(0);
    expect(fadeOpacity(D / 2, D, 0.8)).toBeCloseTo(0.8, 10);
    expect(fadeOpacity(D, D, 0.8)).toBeCloseTo(0, 10);
  });

  it('is symmetric around the midpoint', () => {
    expect(fadeOpacity(D * 0.25, D, 1)).toBeCloseTo(fadeOpacity(D * 0.75, D, 1), 10);
  });

  it('clamps t outside the window', () => {
    expect(fadeOpacity(-1, D, 0.8)).toBe(0);
    expect(fadeOpacity(D + 5, D, 0.8)).toBeCloseTo(0, 10);
  });

  it('guards non-positive durations (no division blow-up, overlay clear)', () => {
    expect(fadeOpacity(0.1, 0, 0.8)).toBe(0);
    expect(fadeOpacity(0.1, -1, 0.8)).toBe(0);
    expect(fadeOpacity(0.1, NaN, 0.8)).toBe(0);
  });
});

describe('fadeShowsIncoming', () => {
  it('switches to the incoming scene exactly at the midpoint', () => {
    expect(fadeShowsIncoming(0, D)).toBe(false);
    expect(fadeShowsIncoming(D / 2 - 1e-6, D)).toBe(false);
    expect(fadeShowsIncoming(D / 2, D)).toBe(true);
    expect(fadeShowsIncoming(D, D)).toBe(true);
  });

  it('degenerate window shows incoming immediately', () => {
    expect(fadeShowsIncoming(0, 0)).toBe(true);
  });
});

describe('fadeDone', () => {
  it('completes only after the full window', () => {
    expect(fadeDone(0, D)).toBe(false);
    expect(fadeDone(D - 1e-6, D)).toBe(false);
    expect(fadeDone(D, D)).toBe(true);
  });

  it('degenerate window is immediately done', () => {
    expect(fadeDone(0, 0)).toBe(true);
  });
});

describe('fadeRetargetTime', () => {
  it('restarting at the returned time keeps overlay opacity continuous', () => {
    for (const t of [0, D * 0.2, D * 0.5, D * 0.7, D * 0.95]) {
      const current = fadeOpacity(t, D, 0.8);
      const restarted = fadeRetargetTime(current, D, 0.8);
      expect(fadeOpacity(restarted, D, 0.8)).toBeCloseTo(current, 10);
      // Always on the rising edge, so the restarted window still runs to
      // completion — the overlay can never be left stuck dark.
      expect(restarted).toBeLessThanOrEqual(D / 2);
      expect(restarted).toBeGreaterThanOrEqual(0);
    }
  });

  it('clamps out-of-range opacity and guards degenerate inputs', () => {
    expect(fadeRetargetTime(2, D, 0.8)).toBeCloseTo(D / 2, 10);
    expect(fadeRetargetTime(-1, D, 0.8)).toBe(0);
    expect(fadeRetargetTime(0.5, 0, 0.8)).toBe(0);
    expect(fadeRetargetTime(0.5, D, 0)).toBe(0);
  });
});
