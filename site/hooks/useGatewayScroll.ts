'use client';

import { useEffect, useRef, useState } from 'react';
import gsap from 'gsap';
import { ScrollTrigger } from 'gsap/ScrollTrigger';

const PANEL_SELECTOR = '[data-gw-panel]';

let scrollTriggerRegistered = false;

/** Registers the ScrollTrigger plugin exactly once, client-side only. Safe to call from
 * an effect body on every mount; SSR never reaches this (effects don't run on the server). */
function ensureScrollTriggerRegistered() {
  if (scrollTriggerRegistered) return;
  gsap.registerPlugin(ScrollTrigger);
  scrollTriggerRegistered = true;
}

export interface GatewayScrollOptions {
  /** Number of world panels. */
  count: number;
  /** Container ref holding the panel stack (each panel is a full-viewport section). */
  containerRef: React.RefObject<HTMLElement | null>;
  /** Called imperatively ~every scroll frame with the active panel index and 0..1 progress within it. */
  onScrub: (index: number, progress: number) => void;
  /** When true (prefers-reduced-motion or fallback mode), the hook creates NO triggers. */
  disabled?: boolean;
}

/**
 * GSAP ScrollTrigger orchestrator for the gateway-descent panel stack.
 *
 * Trigger geometry (chosen deliberately over the "closest to 0.5" alternative): one
 * ScrollTrigger per panel, `start: 'top center'` / `end: 'bottom center'`. Panels are
 * full-viewport sections stacked with no gaps, so each panel's [start, end] window spans
 * exactly one viewport-height of scroll, and — because panel i+1's top sits exactly one
 * viewport height below panel i's top — panel i+1's `start` lands exactly on panel i's
 * `end`. The windows are therefore contiguous and non-overlapping: at any scroll offset
 * (barring the instantaneous boundary) exactly one trigger's window contains the scroll
 * position, so `self.isActive` alone identifies the active panel with no extra "nearest
 * to midpoint" comparison needed.
 */
export function useGatewayScroll(opts: GatewayScrollOptions): { activeIndex: number } {
  const { count, containerRef, disabled } = opts;

  // Mirror the latest onScrub into a ref so the ScrollTrigger onUpdate closures (created
  // once per effect run) always call the current callback without needing it in the
  // effect's dependency array. Putting a fresh-identity callback in deps would tear down
  // and recreate every trigger on each parent render — exactly what this ref avoids.
  const onScrubRef = useRef(opts.onScrub);
  onScrubRef.current = opts.onScrub;

  const [activeIndex, setActiveIndex] = useState(0);
  // Mirrors `activeIndex` for synchronous reads inside onUpdate closures, so we only
  // call setState when the active panel actually changes (never per-frame).
  const activeIndexRef = useRef(0);

  useEffect(() => {
    if (disabled) return;
    const container = containerRef.current;
    if (!container) return;

    ensureScrollTriggerRegistered();

    const panels = Array.from(container.querySelectorAll<HTMLElement>(PANEL_SELECTOR));
    if (process.env.NODE_ENV !== 'production' && panels.length !== count) {
      console.warn(
        `useGatewayScroll: expected ${count} panel(s) matching "${PANEL_SELECTOR}", found ${panels.length}.`,
      );
    }
    if (panels.length === 0) return;

    const triggers = panels.map((panel, index) =>
      ScrollTrigger.create({
        trigger: panel,
        start: 'top center',
        end: 'bottom center',
        onUpdate: (self) => {
          if (!self.isActive) return;
          if (activeIndexRef.current !== index) {
            activeIndexRef.current = index;
            setActiveIndex(index);
          }
          onScrubRef.current(index, self.progress);
        },
      }),
    );

    // ScrollTrigger auto-refreshes on window "resize" (and load/visibilitychange) by
    // default (see ScrollTrigger.config's autoRefreshEvents, verified against the
    // installed gsap@3.15 source) — no manual resize/refresh listener needed here.
    return () => {
      for (const trigger of triggers) trigger.kill();
    };
  }, [count, disabled, containerRef]);

  return { activeIndex };
}
