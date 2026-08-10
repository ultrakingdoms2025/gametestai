import type { CSSProperties } from 'react';
import type { WorldDef } from '@/lib/worlds';
import { worldSeq } from '@/lib/worlds';
import type { ResolvedLore } from '@/lib/lore';

export interface WorldPanelProps {
  world: WorldDef;
  lore: ResolvedLore;
}

/**
 * Pure content for one world's stop in the gateway descent — sequence, kicker, name,
 * role, lore prose, sign-off and the marketing fact chip. No canvas, no state, no
 * effects: this is plain server-renderable DOM so the descent is fully readable
 * without WebGL or JS. GatewayDescent stacks six of these over a fixed canvas and
 * composes the backdrop (WebGL diorama or static painter) around this component;
 * it never reaches inside it.
 *
 * `data-gw-panel` is load-bearing — useGatewayScroll (hooks/useGatewayScroll.ts)
 * queries `[data-gw-panel]` to build its ScrollTrigger stack. Do not rename/remove it.
 */
export default function WorldPanel({ world, lore }: WorldPanelProps) {
  const titleId = `world-${world.id}-title`;
  const alt = world.index % 2 === 0;

  return (
    <section
      data-gw-panel
      id={`world-${world.id}`}
      className="gw-panel"
      aria-labelledby={titleId}
      style={{ ['--gw-accent' as string]: world.accent } as CSSProperties}
    >
      <div className={`gw-panel-in${alt ? ' gw-alt' : ''}`}>
        <div className="gw-seq">
          <span className="gw-seq-num">{worldSeq(world.index)}</span>
          <span className="gw-kicker">{world.kicker}</span>
        </div>
        <h2 id={titleId} className="gw-name">{world.name}</h2>
        <p className="gw-role">{world.role}</p>
        <p className="gw-lore">{lore.body}</p>
        <span className="gw-sign">— {lore.sign_label}</span>
        <span className="gw-fact">{world.fact}</span>
      </div>
    </section>
  );
}
