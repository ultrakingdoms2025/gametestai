'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { WorldDef, WorldId } from '@/lib/worlds';
import type { ResolvedLore } from '@/lib/lore';
import type { DioramaHandle, DioramaScene } from '@/components/diorama/types';
import DioramaCanvas, { type DioramaSceneEntry } from '@/components/diorama/DioramaCanvas';
import WorldPanel from '@/components/WorldPanel';
import WorldCanvas from '@/components/WorldCanvas';
import { useGatewayScroll } from '@/hooks/useGatewayScroll';

export interface GatewayDescentProps {
  worlds: readonly WorldDef[];
  lore: Record<WorldId, ResolvedLore>;
}

/**
 * Diorama scene registry. Empty today — world scene factories are registered here
 * one per task as they are authored (station first). A world with no entry simply
 * has no 3D backdrop yet; the panel text still reads over the page ground.
 */
const SCENE_FACTORIES: Partial<Record<WorldId, () => DioramaScene>> = {};

/**
 * Stand-in for a world whose diorama isn't built yet.
 *
 * DioramaCanvas addresses scenes by array index, and the scroll hook's indices are
 * panel indices — so the `scenes` prop must contain ALL worlds in world order, or
 * the two drift apart. Rather than filtering (which would misalign indices), every
 * world missing from SCENE_FACTORIES gets this trivial scene: build/update/dispose
 * do nothing, render shows an empty (transparent) scene. Index alignment stays
 * correct by construction, and scenes can land incrementally with zero wiring.
 */
function makeNoopScene(id: string): DioramaScene {
  return { id, build() {}, update() {}, setQuality() {}, dispose() {} };
}

/**
 * The descent itself: six WorldPanels stacked full-viewport, composed over either
 * a single fixed WebGL canvas (enhanced) or per-panel static painter plates
 * (fallback). SSR and the first client paint always render the fallback path, so
 * the page is complete without JS/WebGL; a mount effect upgrades to the diorama
 * only when motion is allowed and a WebGL context is actually creatable.
 */
export default function GatewayDescent({ worlds, lore }: GatewayDescentProps) {
  const [enhanced, setEnhanced] = useState(false);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const handleRef = useRef<DioramaHandle | null>(null);

  useEffect(() => {
    const mq = window.matchMedia('(prefers-reduced-motion: reduce)');
    if (!mq.matches) {
      // Probe for a real context — Three.js would fail identically, but probing on
      // a throwaway canvas means the failure path never mounts the diorama at all.
      let gl: unknown = null;
      try {
        const probe = document.createElement('canvas');
        gl = probe.getContext('webgl2') || probe.getContext('webgl');
      } catch {
        gl = null;
      }
      if (gl) setEnhanced(true);
    }
    // If reduced-motion turns ON mid-session, drop to the static fallback. (Turning
    // it back off does not re-upgrade — a mid-scroll renderer boot isn't worth it.)
    const onChange = () => {
      if (mq.matches) setEnhanced(false);
    };
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, []);

  // All worlds, in world order, no-op factories filling the gaps (see makeNoopScene).
  const scenes = useMemo<DioramaSceneEntry[]>(
    () =>
      worlds.map((w) => ({
        id: w.id,
        accent: w.accent,
        factory: SCENE_FACTORIES[w.id] ?? (() => makeNoopScene(w.id)),
      })),
    [worlds],
  );

  const onScrub = useCallback((index: number, progress: number) => {
    handleRef.current?.setActive(index, progress);
  }, []);

  const { activeIndex } = useGatewayScroll({
    count: worlds.length,
    containerRef,
    onScrub,
    disabled: !enhanced,
  });

  return (
    <>
      {enhanced && (
        <DioramaCanvas
          ref={handleRef}
          className="gw-canvas"
          scenes={scenes}
          onError={() => setEnhanced(false)}
        />
      )}
      <div ref={containerRef} className="gateway">
        {worlds.map((w, i) => (
          // Wrapper stays in both paths so the panel remains a descendant of the
          // container (useGatewayScroll queries [data-gw-panel] inside it).
          <div key={w.id} className={`gw-slab${enhanced && i === activeIndex ? ' gw-lit' : ''}`}>
            {!enhanced && (
              <div className="gw-static" aria-hidden="true">
                {/* painterKey, NOT id: canonical ids and painter keys differ
                    (medieval→valley, race→circuit) — this is the never-blank map. */}
                <WorldCanvas scene={w.painterKey} seed={0x2100 + w.index} label={w.name} />
              </div>
            )}
            <WorldPanel world={w} lore={lore[w.id]} />
          </div>
        ))}
      </div>
    </>
  );
}
