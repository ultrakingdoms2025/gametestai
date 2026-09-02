'use client';

import { useEffect, useRef } from 'react';
import { fit, grade, mulberry32, painters } from '@/lib/painters';

/**
 * One world plate. Drawn once — these are illustrations, not simulations.
 *
 * ── Why the paint waits for the viewport ──────────────────────────────────
 *
 * `GatewayDescent` renders one of these per world on its FALLBACK path, which
 * is precisely the reduced-motion / no-WebGL case: the machine least able to
 * afford work is the one that got all seven plates painted synchronously on
 * mount, and all seven repainted 160 ms after any resize — including the
 * address-bar resize a phone fires while scrolling. The enhanced path already
 * boots its renderer from an observer on the container; this is the same
 * discipline for the path that needed it more.
 *
 * The observer, not a scroll listener: the paint is one-shot per size, so there
 * is nothing to drive per frame, and `IntersectionObserver` costs nothing while
 * the plate is off screen. Where it does not exist the plate paints
 * immediately, because a missing optimisation must never become a blank image.
 */
export default function WorldCanvas({ scene, seed, label }: { scene: string; seed: number; label: string }) {
  const ref = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const cv = ref.current;
    if (!cv) return;

    /* `visible` and `dirty` are refs-by-closure rather than state on purpose:
     * nothing here should re-render the component, and a resize while off
     * screen has to be REMEMBERED rather than dropped — otherwise a plate
     * scrolled past during a rotation stays at the old size for ever. */
    let visible = false;
    let dirty = true;

    const draw = () => {
      const size = fit(cv);
      const paint = painters[scene];
      if (!size || !paint) return;
      size.ctx.save();
      paint(size.ctx, size.w, size.h, mulberry32(seed));
      size.ctx.restore();
      grade(size.ctx, size.w, size.h);
      dirty = false;
    };

    let observer: IntersectionObserver | null = null;
    if (typeof IntersectionObserver === 'function') {
      observer = new IntersectionObserver(
        (entries) => {
          for (const entry of entries) {
            visible = entry.isIntersecting;
            if (visible && dirty) draw();
          }
        },
        /* A screen of lead-in, so the plate is finished by the time it is
         * actually looked at rather than painting under the reader's eye. */
        { rootMargin: '200% 0px' }
      );
      observer.observe(cv);
    } else {
      visible = true;
      draw();
    }

    let timer: ReturnType<typeof setTimeout>;
    const onResize = () => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        dirty = true;
        if (visible) draw();
      }, 160);
    };
    window.addEventListener('resize', onResize);
    return () => {
      clearTimeout(timer);
      window.removeEventListener('resize', onResize);
      observer?.disconnect();
    };
  }, [scene, seed]);

  return <canvas ref={ref} role="img" aria-label={label} />;
}
