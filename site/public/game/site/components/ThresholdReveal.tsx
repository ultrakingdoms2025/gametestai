'use client';

import { useEffect, useRef, type ReactNode } from 'react';

/**
 * Wraps its children in a div that watches itself with an IntersectionObserver
 * and adds `.thr-on` the first time it enters the viewport — a one-shot
 * trigger the CSS in globals.css uses to reveal the closing CTA band as you
 * reach it, rather than having it visible (or animating) from page load.
 *
 * `.thr-ready` is added on mount, before anything is observed. The reveal
 * CSS only hides content once `.thr-ready` is present, so a page that never
 * hydrates (JS disabled, hydration error) simply shows the band at rest —
 * this is progressive enhancement, not a requirement for the CTA to render.
 *
 * Reduced motion is handled entirely in CSS (the hide/reveal rules only
 * apply under `prefers-reduced-motion: no-preference`), so this component
 * does not need to branch on it.
 */
export default function ThresholdReveal({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;

    el.classList.add('thr-ready');

    if (typeof IntersectionObserver === 'undefined') {
      el.classList.add('thr-on');
      return;
    }

    const io = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            el.classList.add('thr-on');
            io.disconnect();
            break;
          }
        }
      },
      { threshold: 0.2 }
    );

    io.observe(el);
    return () => io.disconnect();
  }, []);

  return (
    <div ref={ref} className={className}>
      {children}
    </div>
  );
}
