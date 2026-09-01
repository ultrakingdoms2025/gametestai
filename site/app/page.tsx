import Link from 'next/link';
import HeroCanvas from '@/components/HeroCanvas';
import GatewayDescent from '@/components/GatewayDescent';
import AccountDashboard from '@/components/AccountDashboard';
import SignOutButton from '@/components/SignOutButton';
import ThresholdReveal from '@/components/ThresholdReveal';
import PurchaseErrorBanner from '@/components/PurchaseErrorBanner';
import {
  TOTAL_DESTINATIONS, LANDABLE_PLANETS, numberWord, NumberWord,
} from '@/components/gameScale';
import { getAccessStateForSession } from '@/lib/access';
import { auth } from '@/lib/auth';
import { ENTRY_CENTS, CREDIT_PRICE_CENTS, MIN_CREDITS, formatCents, grossUp } from '@/lib/pricing';
import { stripeConfigured } from '@/lib/stripe';
import { WORLDS, MOUNTS, WEAPONS, heroTicker, statBar } from '@/lib/worlds';
import { getLore } from '@/lib/lore';

/* Reads a cookie, so it cannot be prerendered — and should not be, since the
 * page's primary call to action changes depending on whether you have paid. */
export const dynamic = 'force-dynamic';

/* Only `alternates`: every other field merges down from the root layout. A
 * canonical declared per page rather than inherited — see the note there. */
export const metadata = { alternates: { canonical: '/' } };

const FEATURES = [
  {
    t: 'Climb anything',
    c: 'Grip any near-vertical surface and go up it. Stamina is a budget for movement, not a countdown — hang still and you recover.',
  },
  {
    t: `${NumberWord(MOUNTS)} mounts`,
    c: 'Hoverboard, dragon, ground car, horse, eagle and bicycle. None is a reskin: the horse has a real gait model, the eagle is a glider trading height for speed.',
    amber: true,
  },
  {
    /* Space, the ships and the planets had no marketing surface anywhere on
     * this site, and they are ELEVEN of the eighteen registered worlds. */
    t: 'Space and the planets',
    c: `Take a ship off the yard, fly the transit drive, and land on any of ${numberWord(LANDABLE_PLANETS)} planets — each walkable ground with its own weather, liquid and light, rings overhead included.`,
  },
  {
    t: 'Contact racing',
    c: 'Ten cars, AI at varying performance levels, difficulty that rebuilds the track, and rivals you can shunt off line.',
  },
  {
    t: `${NumberWord(WEAPONS)} weapons`,
    c: 'A machine gun, a charge-and-release ember caster, a recurve bow with arrow drop, and a sabre. Ammunition comes out of your bag.',
  },
  {
    t: 'Build your character',
    c: 'Body, build, height, face, skin, hair, headgear — and shirt and trousers chosen independently, with separate colours.',
    amber: true,
  },
  {
    t: 'NPCs that navigate',
    c: 'Hostiles path around obstacles, take cover and refuse to walk into deep water. Friendlies hold a conversation. Merchants keep a shop.',
  },
  {
    t: 'Generated audio',
    c: 'Every sound is synthesised at runtime, including a score per world. There is not one audio file in the project.',
  },
  {
    t: 'Diagnostics',
    c: 'A live overlay with frame timing, draw calls and collider display, over the running game.',
  },
];

/**
 * `searchParams` is read here for ONE reason: `/api/confirm` sends every one of
 * its five refusals back to this page as `/?error=<code>`, and until now this
 * component took no parameters at all, so a customer who had just failed to buy
 * the game was shown the marketing page and nothing else. See
 * `PurchaseErrorBanner`. `?ref=` carries the Stripe session id when the
 * redirect has one, so support has something to look the payment up by.
 */
export default async function Home(props: {
  searchParams: Promise<{ [k: string]: string | string[] | undefined }>;
}) {
  const [session, sp] = await Promise.all([auth(), props.searchParams]);
  const [{ hasAccess }, lore] = await Promise.all([
    getAccessStateForSession(session),
    getLore(),
  ]);
  const entryTotal = grossUp(ENTRY_CENTS);
  const errorCode = typeof sp.error === 'string' ? sp.error : null;
  const errorRef = typeof sp.ref === 'string' ? sp.ref : null;

  return (
    <>
      {/* ── Fixed navigation ── */}
      <nav className="site-nav" aria-label="Main navigation">
        <div className="nav-inner">
          <div className="nav-logo" aria-hidden="true">AETHER<span>NEXUS</span></div>
          <div className="nav-links">
            <a href="#worlds-belt">Worlds</a>
            <a href="/features">Features</a>
            <a href="/store">Credits</a>
          </div>
          <div className="nav-cta">
            {session ? (
              <>
                {hasAccess ? (
                  <Link className="btn btn-primary btn-sm" href="/play">Enter game</Link>
                ) : (
                  <Link className="btn btn-primary btn-sm" href="/checkout?intent=entry">
                    Get access
                  </Link>
                )}
                <Link className="btn btn-ghost btn-sm" href="/account">Account</Link>
                <SignOutButton className="btn btn-ghost btn-sm" />
              </>
            ) : (
              <>
                <Link className="btn btn-ghost btn-sm" href="/login">Sign in</Link>
                <Link className="btn btn-primary btn-sm" href="/register">Join</Link>
              </>
            )}
          </div>
        </div>
      </nav>

      {/* ── Account dashboard (logged-in users) ── */}
      {session && <AccountDashboard />}

      <main id="main" tabIndex={-1}>

      {/* ── A failed purchase, said out loud ──
          Above the hero on purpose: this is the only screen a customer who has
          just been refused at checkout is shown, and a notice below the fold is
          a notice nobody reads. */}
      {errorCode ? (
        <div className="wrap" style={{ paddingTop: 28 }}>
          <PurchaseErrorBanner code={errorCode} reference={errorRef} />
        </div>
      ) : null}

      {/* ── Hero ── */}
      <header className="hero hero-ignite">
        <HeroCanvas />
        <div className="hero-aura" aria-hidden="true" />
        <div className="hero-in wrap">
          <div className="hero-eyebrow">Browser-native &middot; no install</div>
          <h1 className="lockup" aria-label="Aether Nexus">
            <span className="lockup-l1">AETHER</span>
            <span className="lockup-l2">NEXUS</span>
          </h1>
          <p className="hero-deck">
            A first-person action-adventure that runs in a browser tab —
            generating every world, character and texture in code as you play.
          </p>
          <div className="hero-actions">
            {hasAccess ? (
              <Link className="btn btn-primary" href="/play">Enter game</Link>
            ) : (
              <Link className="btn btn-primary" href="/checkout?intent=entry">
                Enter game &mdash; {formatCents(entryTotal)}
              </Link>
            )}
            <Link className="btn btn-ghost" href="/store">Buy credits</Link>
            <span className="btn-note">
              {hasAccess
                ? '30-day access active on this account'
                : `One-off · ${formatCents(ENTRY_CENTS)} plus processing`}
            </span>
          </div>
        </div>

        <div className="hero-ticker" aria-hidden="true">
          <div className="htick-inner">
            {heroTicker().flatMap((s, i) => [
              <span key={`a${i}`}>{s}</span>,
              <span key={`as${i}`} className="htick-dot" />,
            ])}
            {heroTicker().flatMap((s, i) => [
              <span key={`b${i}`} aria-hidden="true">{s}</span>,
              <span key={`bs${i}`} className="htick-dot" aria-hidden="true" />,
            ])}
          </div>
        </div>

        <div className="hero-scroll-cue" aria-hidden="true">
          <span>Scroll</span>
          <div className="scroll-track"><div className="scroll-dot" /></div>
        </div>
      </header>

      {!stripeConfigured() ? (
        <div className="wrap" style={{ paddingTop: 28 }}>
          <div className="banner" role="status">
            <b>Test mode</b>
            <span>
              No Stripe keys configured — checkout is simulated. You&rsquo;ll walk the
              real screens with real totals, but no card is charged. Add{' '}
              <code>STRIPE_SECRET_KEY</code> to switch to live payments.
            </span>
          </div>
        </div>
      ) : null}

      {/* ── World cinematic panels ── */}
      <GatewayDescent worlds={WORLDS} lore={lore} />

      {/* ── Features ── */}
      <section className="feat-section" id="features-anchor" aria-labelledby="feat-h2">
        <div className="wrap">
          <div className="feat-head">
            <div className="eyebrow">What is in it</div>
            <h2 className="feat-h2" id="feat-h2">Everything generated in code</h2>
            <p className="feat-sub">
              Terrain, buildings, crowds, faces, fabric, fur, feathers and stone —
              all generated at load time. The whole game is a few hundred kilobytes
              of logic rather than gigabytes of art. {NumberWord(TOTAL_DESTINATIONS)}{' '}
              places to stand in all: the {numberWord(WORLDS.length)} gateway worlds
              below, open space between them, and {numberWord(LANDABLE_PLANETS)}{' '}
              landable planets you fly a ship to.
            </p>
          </div>

          <div className="feat-stats-bar" aria-label="game at a glance">
            {statBar().map((v, i) => {
              // 'Gateways': see the note in app/features/page.tsx.
              const labels = ['Gateways','Mounts','Weapons','Install'];
              return (
                <div className="fstat" key={labels[i]}>
                  <span className="fstat-val">{v}</span>
                  <span className="fstat-key">{labels[i]}</span>
                </div>
              );
            })}
          </div>

          <div className="features">
            {FEATURES.map((f) => (
              <div className={f.amber ? 'feat amber' : 'feat'} key={f.t}>
                <h3>{f.t}</h3>
                <p>{f.c}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ── CTA band ── */}
      <ThresholdReveal>
        <section className="cta-band" aria-labelledby="cta-band-h2">
          <div className="cta-band-ring" aria-hidden="true" />
          <div className="wrap">
            <div className="cta-band-kicker">Get in</div>
            <h2 className="cta-band-h2" id="cta-band-h2">
              One charge.<br />{NumberWord(TOTAL_DESTINATIONS)} worlds.
            </h2>
            <p className="cta-band-sub">
              {NumberWord(WORLDS.length)} through the gateways, open space, and{' '}
              {numberWord(LANDABLE_PLANETS)} planets you land a ship on. Access is{' '}
              {formatCents(ENTRY_CENTS)} for a 30-day play window on your
              account. Credits are separate and optional —{' '}
              {formatCents(CREDIT_PRICE_CENTS)} each, from {MIN_CREDITS} to 10,000.
              Prices shown before card processing, which appears as its own line at checkout.
            </p>
            <div className="cta-band-actions">
              {hasAccess ? (
                <Link className="btn btn-primary" href="/play">Enter game</Link>
              ) : (
                <Link className="btn btn-primary" href="/checkout?intent=entry">
                  Unlock for {formatCents(entryTotal)}
                </Link>
              )}
              <Link className="btn btn-amber" href="/store">Buy credits</Link>
            </div>
          </div>
        </section>
      </ThresholdReveal>

      </main>

      <footer>
        <div className="wrap">
          <span>
            Aether Nexus &middot; built in the browser, from code &middot;{' '}
            <Link href="/restore">Restore a purchase</Link>
          </span>
          <span>
            {hasAccess
              ? 'Access active'
              : `Access ${formatCents(entryTotal)} · credits from ${formatCents(grossUp(MIN_CREDITS * CREDIT_PRICE_CENTS))}`}
          </span>
        </div>
      </footer>
    </>
  );
}
