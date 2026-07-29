import Link from 'next/link';
import HeroCanvas from '@/components/HeroCanvas';
import WorldCanvas from '@/components/WorldCanvas';
import { readPass } from '@/lib/entitlement';
import { ENTRY_CENTS, CREDIT_PRICE_CENTS, MIN_CREDITS, formatCents, grossUp } from '@/lib/pricing';
import { stripeConfigured } from '@/lib/stripe';

/* Reads a cookie, so it cannot be prerendered — and should not be, since the
 * page's primary call to action changes depending on whether you have paid. */
export const dynamic = 'force-dynamic';

const WORLDS = [
  {
    scene: 'station',
    seed: 0x2101,
    kicker: 'Orbital',
    name: 'Aether Station',
    copy: 'A working habitat hanging in front of a planet — plaza, market, hydroponics and hangar bays.',
  },
  {
    scene: 'valley',
    seed: 0x2207,
    kicker: 'Open country',
    name: 'Medieval Valley',
    copy: 'A walled town, castle, forests and lakes. The water is swimmable and has real depth.',
  },
  {
    scene: 'sports',
    seed: 0x2309,
    kicker: 'Floodlit',
    name: 'Meridian Athletic Grounds',
    copy: 'Pool, courts, skatepark, running track and a ski piste, under lights, with a seated crowd.',
  },
  {
    scene: 'citadel',
    seed: 0x2417,
    kicker: 'Desert mesa',
    name: 'Sunspire Citadel',
    copy: 'A town built to be climbed: souk rooftops, rope bridges, minarets and a 46 m great tower.',
  },
  {
    scene: 'circuit',
    seed: 0x2523,
    kicker: 'Racing',
    name: 'Vellum Ridge Circuit',
    copy: 'A 1,599 m lap over rough terrain and through city streets, with a real F1 start procedure.',
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
  const pass = await readPass();
  const paid = !!pass?.paid;
  const entryTotal = grossUp(ENTRY_CENTS);

  return (
    <>
      <header className="hero">
        <HeroCanvas />
        <div className="hero-in wrap">
          <div className="eyebrow">Browser-native · no install</div>
          <h1 className="lockup">
            AETHER<span>NEXUS</span>
          </h1>
          <div className="tagline">Five worlds · one gateway · nothing downloaded</div>
          <p className="claim">
            A first-person action-adventure that runs in a browser tab — and generates
            every world, every character and every texture in code as you play.
          </p>

          <div className="actions">
            {paid ? (
              <Link className="btn btn-primary" href="/play">
                Enter game
              </Link>
            ) : (
              <Link className="btn btn-primary" href="/checkout?intent=entry">
                Enter game — {formatCents(entryTotal)}
              </Link>
            )}
            <Link className="btn btn-ghost" href="/store">
              Buy credits
            </Link>
            <span className="btn-note">
              {paid
                ? 'Access unlocked on this browser'
                : `One-off charge. ${formatCents(ENTRY_CENTS)} plus processing.`}
            </span>
          </div>
        </div>
      </header>

      {!stripeConfigured() ? (
        <div className="wrap" style={{ paddingTop: 26 }}>
          <div className="banner" role="status">
            <b>Test mode</b>
            <span>
              No Stripe keys are configured, so checkout is simulated: you will walk the
              real screens and see the real totals, but no card is taken and nothing is
              sent to Stripe. Adding <code>STRIPE_SECRET_KEY</code> switches the same flow
              to live payments.
            </span>
          </div>
        </div>
      ) : null}

      <section>
        <div className="wrap">
          <div className="head">
            <div className="eyebrow">The worlds</div>
            <h2>Step through a ring, the world changes completely</h2>
            <p>
              Every world is a portal away, and destinations keep building in the
              background while the transition holds — so travel is seamless.
            </p>
          </div>
          <div className="worlds">
            {WORLDS.map((w) => (
              <article className="world" key={w.scene}>
                <WorldCanvas scene={w.scene} seed={w.seed} label={`${w.name}: ${w.copy}`} />
                <div className="world-b">
                  <div className="world-k">{w.kicker}</div>
                  <h3>{w.name}</h3>
                  <p>{w.copy}</p>
                </div>
              </article>
            ))}
          </div>
        </div>
      </section>

      <section>
        <div className="wrap">
          <div className="head">
            <div className="eyebrow">What is in it</div>
            <h2>Everything here was made by code</h2>
            <p>
              Terrain, buildings, crowds, faces, fabric, fur, feathers and stone are all
              generated at load time. The whole game is a few hundred kilobytes of logic
              rather than gigabytes of art.
            </p>
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

      <section>
        <div className="wrap">
          <div className="head">
            <div className="eyebrow">Get in</div>
            <h2>One charge for the game, credits when you want them</h2>
            <p>
              Access is a single {formatCents(ENTRY_CENTS)} charge, once, and it is yours.
              Credits are separate and optional — {formatCents(CREDIT_PRICE_CENTS)} each,
              from {MIN_CREDITS} up to 10,000. Listed prices are before card processing,
              which is added at checkout and shown as its own line.
            </p>
          </div>
          <div className="actions">
            {paid ? (
              <Link className="btn btn-primary" href="/play">
                Enter game
              </Link>
            ) : (
              <Link className="btn btn-primary" href="/checkout?intent=entry">
                Unlock for {formatCents(entryTotal)}
              </Link>
            )}
            <Link className="btn btn-amber" href="/store">
              Buy credits
            </Link>
          </div>
        </div>
      </section>

      <footer>
        <div className="wrap">
          <span>
            Aether Nexus · built in the browser, from code ·{' '}
            <Link href="/restore">Restore a purchase</Link>
          </span>
          <span>
            {paid ? 'Access unlocked' : `Access ${formatCents(entryTotal)} · credits from ${formatCents(grossUp(MIN_CREDITS * CREDIT_PRICE_CENTS))}`}
          </span>
        </div>
      </footer>
    </>
  );
}
