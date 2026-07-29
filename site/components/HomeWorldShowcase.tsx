'use client';

import Link from 'next/link';
import WorldCanvas from '@/components/WorldCanvas';

type WorldItem = {
  scene: string;
  seed: number;
  id: string;
  kicker: string;
  name: string;
  copy: string;
  pulse: string;
  role: string;
  traversal: string;
};

export default function HomeWorldShowcase({ worlds }: { worlds: WorldItem[] }) {
  return (
    <div className="worlds-belt" id="worlds-belt">
      <div className="worlds-belt-head wrap">
        <div className="eyebrow">The worlds</div>
        <h2 className="belt-h2">Step through a ring.<br />Everything changes.</h2>
        <p className="belt-sub">
          Every world is a portal away, destinations keep building in the background —
          so travel is seamless. Five completely distinct environments, each with its
          own rules, traversal and feel.
        </p>
      </div>
      {worlds.map((w, i) => (
        <div key={w.id} id={w.id} className={`wp${i % 2 === 1 ? ' wp-flip' : ''}`}>
          <div className="wp-visual">
            <WorldCanvas scene={w.scene} seed={w.seed} label={`${w.name}: ${w.copy}`} />
          </div>
          <div className="wp-body">
            <div className="wp-seq">0{i + 1}&thinsp;/&thinsp;05</div>
            <div className="wp-kicker">{w.kicker}</div>
            <h3 className="wp-name">{w.name}</h3>
            <div className="wp-rule" />
            <p className="wp-copy">{w.copy}</p>
            <p className="wp-pulse">{w.pulse}</p>
            <div className="wp-chips">
              <span>{w.role}</span>
              <span>{w.traversal}</span>
            </div>
            <div className="wp-enter">
              <Link className="btn btn-ghost" href="/play">Enter via portal</Link>
            </div>
          </div>
          <div className="wp-watermark" aria-hidden="true">
            {String(i + 1).padStart(2, '0')}
          </div>
        </div>
      ))}
    </div>
  );
}

