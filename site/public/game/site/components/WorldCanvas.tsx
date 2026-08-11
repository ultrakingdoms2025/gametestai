'use client';

import { useEffect, useRef } from 'react';
import { fit, grade, mulberry32, painters } from '@/lib/painters';

/** One world plate. Drawn once — these are illustrations, not simulations. */
export default function WorldCanvas({ scene, seed, label }: { scene: string; seed: number; label: string }) {
  const ref = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const cv = ref.current;
    if (!cv) return;

    const draw = () => {
      const size = fit(cv);
      const paint = painters[scene];
      if (!size || !paint) return;
      size.ctx.save();
      paint(size.ctx, size.w, size.h, mulberry32(seed));
      size.ctx.restore();
      grade(size.ctx, size.w, size.h);
    };

    draw();

    let timer: ReturnType<typeof setTimeout>;
    const onResize = () => {
      clearTimeout(timer);
      timer = setTimeout(draw, 160);
    };
    window.addEventListener('resize', onResize);
    return () => {
      clearTimeout(timer);
      window.removeEventListener('resize', onResize);
    };
  }, [scene, seed]);

  return <canvas ref={ref} role="img" aria-label={label} />;
}
