'use client';
import { useCallback, useEffect, useState } from 'react';
import { worldFeatures, type FeatureSection } from '@/lib/features';
import { worldSeq } from '@/lib/worlds';

/**
 * The expandable sections of /features.
 *
 * Each section is a real `<details>` element, so keyboard handling, the
 * disclosure semantics a screen reader announces, and Chromium's find-in-page
 * auto-expand all come from the browser rather than from this file. React
 * only holds the set of open ids, for the two things the browser cannot do on
 * its own: an "Expand all / Collapse all" control, and opening the section a
 * `#hash` deep link names.
 *
 * `open` is driven from state and `onToggle` mirrors the browser's own
 * toggles back into it, so a click on a summary and a click on "Expand all"
 * end up in the same place. The initial state is empty on both server and
 * client — the hash is only read after mount — so there is nothing to
 * mismatch at hydration.
 */
export default function FeatureSections({ sections }: { sections: readonly FeatureSection[] }) {
  const [open, setOpen] = useState<ReadonlySet<string>>(() => new Set());

  useEffect(() => {
    const applyHash = () => {
      const id = decodeURIComponent(window.location.hash.slice(1));
      if (!id || !sections.some((s) => s.id === id)) return;
      setOpen((prev) => (prev.has(id) ? prev : new Set(prev).add(id)));
      // Scroll once the open section has laid out, not before.
      requestAnimationFrame(() => {
        document.getElementById(id)?.scrollIntoView({ block: 'start' });
      });
    };
    applyHash();
    window.addEventListener('hashchange', applyHash);
    return () => window.removeEventListener('hashchange', applyHash);
  }, [sections]);

  const onToggle = useCallback((id: string, isOpen: boolean) => {
    setOpen((prev) => {
      if (prev.has(id) === isOpen) return prev;
      const next = new Set(prev);
      if (isOpen) next.add(id); else next.delete(id);
      return next;
    });
  }, []);

  const allOpen = sections.every((s) => open.has(s.id));
  const toggleAll = () => setOpen(allOpen ? new Set() : new Set(sections.map((s) => s.id)));

  return (
    <div className="fx">
      <div className="fx-toolbar">
        <span className="fx-toolbar-note" aria-live="polite">
          {open.size === 0
            ? 'Select a section to expand it'
            : `${open.size} of ${sections.length} open`}
        </span>
        <button type="button" className="btn btn-ghost btn-sm" onClick={toggleAll}>
          {allOpen ? 'Collapse all' : 'Expand all'}
        </button>
      </div>

      <div className="fx-list">
        {sections.map((s) => (
          <details
            key={s.id}
            id={s.id}
            className="fx-sec"
            open={open.has(s.id)}
            onToggle={(e) => onToggle(s.id, e.currentTarget.open)}
          >
            <summary className="fx-sum">
              <span className="fx-title">{s.title}</span>
              <span className="fx-count num" aria-label={`${s.items.length} items`}>{s.items.length}</span>
              <span className="fx-chev" aria-hidden="true" />
            </summary>
            <div className="fx-body">
              <p className="fx-blurb">{s.blurb}</p>
              {s.kind === 'worlds' ? (
                <ol className="fx-worlds">
                  {worldFeatures(s).map((w) => (
                    <li
                      className="fx-world"
                      key={w.world}
                      style={{ ['--accent' as string]: w.def.accent }}
                    >
                      <span className="fx-world-seq">{worldSeq(w.def.index)}</span>
                      <h3 className="fx-world-label">{w.label}</h3>
                      <span className="fx-world-name">{w.def.name}</span>
                      <p>{w.detail}</p>
                    </li>
                  ))}
                </ol>
              ) : (
                <ul className="fx-items">
                  {s.items.map((item) => (
                    <li className="fx-item" key={item.name}>
                      <b>{item.name}</b>
                      {item.detail ? <span>{item.detail}</span> : null}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </details>
        ))}
      </div>
    </div>
  );
}
