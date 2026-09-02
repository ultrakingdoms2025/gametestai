import type { Metadata, Viewport } from 'next';
import { Chakra_Petch, Rajdhani } from 'next/font/google';
import './globals.css';
import Providers from '@/components/Providers';
import SiteHeader from '@/components/SiteHeader';
import {
  LANDABLE_PLANETS, TOTAL_DESTINATIONS, numberWord, NumberWord,
} from '@/components/gameScale';
import { WORLDS } from '@/lib/worlds';

/* The game's own two faces. `next/font` downloads and self-hosts them at build
 * time, so there is no request to a font CDN at runtime and no flash of a
 * fallback — which matters here more than usual, because the fallback for a
 * squared-off technical face is a humanist sans and the page would briefly look
 * like a different product. */
const display = Chakra_Petch({
  subsets: ['latin'],
  weight: ['500', '600', '700'],
  variable: '--font-display',
  display: 'swap',
});

const body = Rajdhani({
  subsets: ['latin'],
  weight: ['500', '600', '700'],
  variable: '--font-body',
  display: 'swap',
});

/**
 * The absolute origin every relative metadata URL is resolved against.
 *
 * Without a `metadataBase`, Next resolves `openGraph.images` and
 * `alternates.canonical` against `localhost` in development and warns in the
 * build — and a canonical or an OG image pointing at localhost is worse than
 * none. Same precedence as `siteOrigin()` in `lib/stripe.ts`: an explicit
 * setting, then whatever Vercel says the deployment is, then the production
 * domain, so a preview advertises itself and not production.
 */
const ORIGIN =
  process.env.NEXT_PUBLIC_SITE_URL?.replace(/\/+$/, '')
  || (process.env.VERCEL_PROJECT_PRODUCTION_URL
    ? `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}`
    : null)
  || 'https://aethernexus.games';

const WORLD_COUNT = numberWord(WORLDS.length);
const TOTAL = numberWord(TOTAL_DESTINATIONS);
/* Same number, capitalised, for the two places it opens a sentence. */
const TOTAL_CAP = NumberWord(TOTAL_DESTINATIONS);

const DESCRIPTION =
  'A first-person action-adventure that runs in a browser tab and generates every '
  + `world, character and texture in code as you play. ${TOTAL_CAP} places to stand: `
  + `${WORLD_COUNT} worlds through the gateways, open space, and ${numberWord(LANDABLE_PLANETS)} `
  + 'landable planets. No install, no downloads.';

export const metadata: Metadata = {
  metadataBase: new URL(ORIGIN),
  title: `AETHER NEXUS — ${TOTAL} worlds, one gateway`,
  description: DESCRIPTION,
  applicationName: 'Aether Nexus',
  /* No `alternates` here on purpose. Metadata is inherited field by field, so
   * a canonical set on the root layout would be inherited by every page that
   * does not set one — pointing the whole site at `/`. Each public page
   * declares its own; private ones (account, admin, play, order) declare none
   * and are kept out of the index by `robots.ts` instead. */
  openGraph: {
    title: 'AETHER NEXUS',
    description: `${TOTAL_CAP} worlds. One gateway. Nothing downloaded.`,
    type: 'website',
    siteName: 'Aether Nexus',
    locale: 'en_GB',
    /* No `images` entry: `app/opengraph-image.tsx` is a file convention and
     * Next injects it into every route's metadata itself. Listing it here as
     * well would emit the tag twice. */
  },
  twitter: {
    card: 'summary_large_image',
    title: 'AETHER NEXUS',
    description: `${TOTAL_CAP} worlds. One gateway. Nothing downloaded.`,
  },
};

export const viewport: Viewport = {
  themeColor: '#04070d',
  colorScheme: 'dark',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${display.variable} ${body.variable}`} suppressHydrationWarning>
      <body suppressHydrationWarning>
        {/* WCAG 2.4.1. First focusable element in the document, off screen
            until it takes focus, and it has to be OUTSIDE `Providers` so that
            nothing rendered by a provider can get in front of it in tab order.
            Every page's `<main>` carries `id="main"` as the target. */}
        <a className="skip-link" href="#main">Skip to content</a>
        <Providers>
          <SiteHeader />
          {children}
        </Providers>
      </body>
    </html>
  );
}
