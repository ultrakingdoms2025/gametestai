import Link from 'next/link';
import FeatureSections from '@/components/FeatureSections';
import { FEATURE_SECTIONS, featureTotal } from '@/lib/features';
import { statBar } from '@/lib/worlds';

/* Reads no cookie and shows the same thing to everyone, so — unlike the home
 * page — this one is prerendered at build time. */
export const metadata = {
  title: 'Features — AETHER NEXUS',
  description:
    'Everything in Aether Nexus: seven worlds, six mounts, four weapons, custom servers, '
    + 'quests, a marketplace — all in a browser tab, with nothing to download.',
};

const STAT_LABELS = ['Worlds', 'Mounts', 'Weapons', 'Install'];

export default function Features() {
  const total = featureTotal();
  return (
    <main>
      <section style={{ paddingTop: 56 }}>
        <div className="wrap">
          <div className="head">
            <div className="eyebrow">
              <Link href="/" style={{ textDecoration: 'none' }}>
                ← Aether Nexus
              </Link>
            </div>
            <h2>Features</h2>
            <p>
              The whole of it, section by section — <span className="num">{total}</span>{' '}
              things the game does, from the worlds you walk through to the keys you can rebind.
              Open a section, or open them all.
            </p>
          </div>

          <div className="feat-stats-bar fx-stats" aria-label="game at a glance">
            {statBar().map((v, i) => (
              <div className="fstat" key={STAT_LABELS[i]}>
                <span className="fstat-val">{v}</span>
                <span className="fstat-key">{STAT_LABELS[i]}</span>
              </div>
            ))}
          </div>

          <FeatureSections sections={FEATURE_SECTIONS} />

          <div className="fx-cta">
            <span className="fx-cta-kicker">All of it, in a tab</span>
            <div className="fx-cta-actions">
              <Link className="btn btn-primary" href="/play">Enter game</Link>
              <Link className="btn btn-ghost" href="/store">Buy credits</Link>
            </div>
          </div>
        </div>
      </section>

      <footer>
        <div className="wrap">
          <span>
            Aether Nexus &middot; built in the browser, from code &middot;{' '}
            <Link href="/restore">Restore a purchase</Link>
          </span>
        </div>
      </footer>
    </main>
  );
}
