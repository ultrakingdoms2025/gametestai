import type { Metadata, Viewport } from 'next';
import { Chakra_Petch, Rajdhani } from 'next/font/google';
import './globals.css';
import Providers from '@/components/Providers';
import SiteHeader from '@/components/SiteHeader';

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

export const metadata: Metadata = {
  title: 'AETHER NEXUS — six worlds, one gateway',
  description:
    'A first-person action-adventure that runs in a browser tab and generates every '
    + 'world, character and texture in code as you play. No install, no downloads.',
  openGraph: {
    title: 'AETHER NEXUS',
    description: 'Six worlds. One gateway. Nothing downloaded.',
    type: 'website',
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
        <Providers>
          <SiteHeader />
          {children}
        </Providers>
      </body>
    </html>
  );
}
