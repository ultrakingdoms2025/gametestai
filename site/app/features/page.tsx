import Link from 'next/link';
import FeatureSections from '@/components/FeatureSections';
import { FEATURE_SECTIONS, featureTotal } from '@/lib/features';
import { statBar, WORLDS, MOUNTS, WEAPONS } from '@/lib/worlds';
import {
  LANDABLE_PLANETS, TOTAL_DESTINATIONS, numberWord,
} from '@/components/gameScale';
import { siteUrl } from '@/components/siteUrl';
import { ENTRY_CENTS, formatCents } from '@/lib/pricing';

/* Reads no cookie and shows the same thing to everyone, so — unlike the home
 * page — this one is prerendered at build time. */
export const metadata = {
  alternates: { canonical: '/features' },
  title: 'Features — AETHER NEXUS',
  /* Derived, not typed. This line said "seven worlds" while the home page said
   * six and the game registers eighteen — three numbers, one array. */
  description:
    `Everything in Aether Nexus: ${numberWord(TOTAL_DESTINATIONS)} worlds including `
    + `${numberWord(LANDABLE_PLANETS)} landable planets, ${numberWord(MOUNTS)} mounts, `
    + `${numberWord(WEAPONS)} weapons, custom servers, quests and a marketplace — all in `
    + 'a browser tab, with nothing to download.',
};

/* "Gateways", not "Worlds". `statBar()` counts `WORLDS.length`, which is the
   number of doors in the station — the game registers eighteen worlds once
   space and the ten planets are counted, and the prose on this page now says
   so. A tile reading "7 Worlds" beside it would be the same contradiction this
   pass exists to remove, one tile further down. */
const STAT_LABELS = ['Gateways', 'Mounts', 'Weapons', 'Install'];

export default function Features() {
  const total = featureTotal();
  const base = siteUrl();
  const jsonLd = {
    '@context': 'https://schema.org',
    '@type': 'VideoGame',
    name: 'Aether Nexus',
    url: base,
    description:
      'A first-person action-adventure that runs in a browser tab and generates every '
      + 'world, character and texture in code as you play.',
    genre: ['Action-adventure', 'Open world', 'Racing'],
    gamePlatform: ['Web browser', 'WebGL'],
    playMode: 'SinglePlayer',
    applicationCategory: 'Game',
    operatingSystem: 'Any (modern browser with WebGL 2)',
    inLanguage: 'en',
    image: `${base}/opengraph-image`,
    numberOfPlayers: { '@type': 'QuantitativeValue', minValue: 1, maxValue: 1 },
    gameItem: [
      { '@type': 'Thing', name: `${TOTAL_DESTINATIONS} worlds` },
      { '@type': 'Thing', name: `${MOUNTS} mounts` },
      { '@type': 'Thing', name: `${WEAPONS} weapons` },
      { '@type': 'Thing', name: `${LANDABLE_PLANETS} landable planets` },
    ],
    offers: {
      '@type': 'Offer',
      url: `${base}/checkout?intent=entry`,
      price: (ENTRY_CENTS / 100).toFixed(2),
      priceCurrency: 'USD',
      category: '30-day access',
      availability: 'https://schema.org/InStock',
      description: `${formatCents(ENTRY_CENTS)} for a 30-day play window, before card processing.`,
    },
  };
  return (
    <main id="main" tabIndex={-1}>
      {/* VideoGame structured data. This is the one page that describes the
          product rather than selling it, so it is where the machine-readable
          version belongs. Every number in it is derived from the same modules
          the visible copy uses — a JSON-LD block that has to be kept in step by
          hand is a second set of facts, and the second set is always the stale
          one. `dangerouslySetInnerHTML` is how Next emits a JSON-LD script; the
          payload is built here from typed constants, never from user input. */}
      <script
        type="application/ld+json"
        // eslint-disable-next-line react/no-danger
        dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd) }}
      />
      <section style={{ paddingTop: 56 }}>
        <div className="wrap">
          <div className="head">
            <div className="eyebrow">
              <Link href="/" style={{ textDecoration: 'none' }}>
                ← Aether Nexus
              </Link>
            </div>
            <h1>Features</h1>
            <p>
              The whole of it, section by section — <span className="num">{total}</span>{' '}
              things the game does, from the worlds you walk through to the keys you can rebind.
              Open a section, or open them all.
            </p>
            <p>
              {numberWord(TOTAL_DESTINATIONS)} worlds are registered in all: the{' '}
              {numberWord(WORLDS.length)} behind the station gateways, the open space
              between them, and {numberWord(LANDABLE_PLANETS)} planets you fly a ship to
              and land on.
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
