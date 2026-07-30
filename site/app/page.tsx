import Link from 'next/link';
import HeroCanvas from '@/components/HeroCanvas';
import HomeWorldShowcase from '@/components/HomeWorldShowcase';
import AccountDashboard from '@/components/AccountDashboard';
import SignOutButton from '@/components/SignOutButton';
import { getAccessStateForSession } from '@/lib/access';
import { auth } from '@/lib/auth';
import { ENTRY_CENTS, CREDIT_PRICE_CENTS, MIN_CREDITS, formatCents, grossUp } from '@/lib/pricing';
import { stripeConfigured } from '@/lib/stripe';

/* Reads a cookie, so it cannot be prerendered — and should not be, since the
 * page's primary call to action changes depending on whether you have paid. */
export const dynamic = 'force-dynamic';

const WORLDS = [
  {
    scene: 'station',
    seed: 0x2101,
    id: 'world-station',
    kicker: 'Orbital',
    name: 'Aether Station',
    copy: 'A working habitat hanging in front of a planet — plaza, market, hydroponics and hangar bays.',
    pulse: 'Trade lanes and hangar lines under cold starlight.',
    role: 'Hub world',
    traversal: 'Hoverboard, car',
  },
  {
    scene: 'valley',
    seed: 0x2207,
    id: 'world-valley',
    kicker: 'Open country',
    name: 'Medieval Valley',
    copy: 'A walled town, castle, forests and lakes. The water is swimmable and has real depth.',
    pulse: 'Stone, timber and water routes built for climbing and duels.',
    role: 'Exploration world',
    traversal: 'Horse, eagle',
  },
  {
    scene: 'sports',
    seed: 0x2309,
    id: 'world-sports',
    kicker: 'Floodlit',
    name: 'Meridian Athletic Grounds',
    copy: 'Pool, courts, skatepark, running track and a ski piste, under lights, with a seated crowd.',
    pulse: 'Speed, trick lines, and challenge runs under stadium lamps.',
    role: 'Skill world',
    traversal: 'Hoverboard, on-foot',
  },
  {
    scene: 'citadel',
    seed: 0x2417,
    id: 'world-citadel',
    kicker: 'Desert mesa',
    name: 'Sunspire Citadel',
    copy: 'A town built to be climbed: souk rooftops, rope bridges, minarets and a 46 m great tower.',
    pulse: 'Vertical routes and rooftop combat through sunburnt geometry.',
    role: 'Vertical world',
    traversal: 'Climb, dragon',
  },
  {
    scene: 'circuit',
    seed: 0x2523,
    id: 'world-circuit',
    kicker: 'Racing',
    name: 'Vellum Ridge Circuit',
    copy: 'A 1,599 m lap over rough terrain and through city streets, with a real F1 start procedure.',
    pulse: 'Contact racing and late braking across mixed terrain sectors.',
    role: 'Competition world',
    traversal: 'Car',
  },
];

const FEATURES = [
  {
    t: 'Climb anything',
    c: 'Grip any near-vertical surface and go up it. Stamina is a budget for movement, not a countdown — hang still and you recover.',
  },
  {
    t: 'Five mounts',
    c: 'Hoverboard, dragon, ground car, horse and eagle. None is a reskin: the horse has a real gait model, the eagle is a glider trading height for speed.',
    amber: true,
  },
  {
    t: 'Contact racing',
    c: 'Ten cars, AI at varying performance levels, difficulty that rebuilds the track, and rivals you can shunt off line.',
  },
  {
    t: 'Four weapons',
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

export default async function Home() {
  const session = await auth();
  const { hasAccess } = await getAccessStateForSession(session);
  const entryTotal = grossUp(ENTRY_CENTS);

  return (
    <>
      {/* ── Fixed navigation ── */}
      <nav className="site-nav" aria-label="Main navigation">
        <div className="nav-inner">
          <div className="nav-logo" aria-hidden="true">AETHER<span>NEXUS</span></div>
          <div className="nav-links" aria-hidden="true">
            <a href="#worlds-belt">Worlds</a>
            <a href="#features-anchor">Features</a>
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

      {/* ── Hero ── */}
      <header className="hero">
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
            {['Five worlds','Five mounts','Four weapons','Zero downloads','100% generated','Runs in a tab','No install'].flatMap((s, i) => [
              <span key={`a${i}`}>{s}</span>,
              <span key={`as${i}`} className="htick-dot" />,
            ])}
            {['Five worlds','Five mounts','Four weapons','Zero downloads','100% generated','Runs in a tab','No install'].flatMap((s, i) => [
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
      <HomeWorldShowcase worlds={WORLDS} />

      {/* ── Features ── */}
      <section className="feat-section" id="features-anchor">
        <div className="wrap">
          <div className="feat-head">
            <div className="eyebrow">What is in it</div>
            <h2 className="feat-h2">Everything generated in code</h2>
            <p className="feat-sub">
              Terrain, buildings, crowds, faces, fabric, fur, feathers and stone —
              all generated at load time. The whole game is a few hundred kilobytes
              of logic rather than gigabytes of art.
            </p>
          </div>

          <div className="feat-stats-bar" aria-label="game at a glance">
            {(['5','5','4','0 GB'] as string[]).map((v, i) => {
              const labels = ['Worlds','Mounts','Weapons','Install'];
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
      <section className="cta-band">
        <div className="wrap">
          <div className="cta-band-kicker">Get in</div>
          <h2 className="cta-band-h2">One charge.<br />Five worlds.</h2>
          <p className="cta-band-sub">
            Access is {formatCents(ENTRY_CENTS)} for a 30-day play window on your
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
