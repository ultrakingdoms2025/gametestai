'use client';

import { useEffect, useRef } from 'react';
import { fit, paintHero } from '@/lib/painters';

/**
 * The title backdrop.
 *
 * Animates only the star twinkle and the ring's glow — the ridges are static,
 * because a moving horizon behind a title is motion for its own sake and
 * fights the type. Honours `prefers-reduced-motion` by drawing one frame.
 */
export default function HeroCanvas() {
  const ref = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const cv = ref.current;
    if (!cv) return;

    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    let raf = 0;
    let size = fit(cv);

    const frame = (t: number) => {
      if (size) paintHero(size.ctx, size.w, size.h, t, !reduced);
      if (!reduced) raf = requestAnimationFrame(frame);
    };

    frame(0);

    let timer: ReturnType<typeof setTimeout>;
    const onResize = () => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        size = fit(cv);
        if (reduced && size) paintHero(size.ctx, size.w, size.h, 0, false);
      }, 160);
    };
    window.addEventListener('resize', onResize);

    return () => {
      cancelAnimationFrame(raf);
      clearTimeout(timer);
      window.removeEventListener('resize', onResize);
    };
  }, []);

  return <canvas ref={ref} aria-hidden="true" />;
}
