import { ImageResponse } from 'next/og';
import { LANDABLE_PLANETS, TOTAL_DESTINATIONS, numberWord } from '@/components/gameScale';
import { WORLDS, MOUNTS, WEAPONS } from '@/lib/worlds';

/**
 * The card every link to this site unfurls into.
 *
 * `openGraph` declared a title, a description and a type and no image at all,
 * so a link to the game shared anywhere rendered as a grey text stub. This is
 * the file convention: Next picks it up for every route under the root layout
 * and emits `og:image` and `twitter:image` itself.
 *
 * ── Drawn, not fetched ────────────────────────────────────────────────────
 *
 * Every colour below is read off `app/globals.css` — `--ink-0`, `--cy`,
 * `--amber`, `--txt`, `--txt-2`, `--rule` — so the card is the same object as
 * the page it links to. Nothing is loaded from a remote host: an OG image that
 * depends on a network fetch fails at build time in exactly the environments
 * where nobody is watching the log.
 *
 * The counts come from the same modules the page's copy does, so the card
 * cannot drift from the site the way "Six worlds" drifted from seven.
 */

export const size = { width: 1200, height: 630 };
export const contentType = 'image/png';
export const alt = 'Aether Nexus — a browser-native action adventure';

/* globals.css tokens, verbatim. */
const INK = '#04070d';
const CY = '#52e9ff';
const AMBER = '#ffb44a';
const TXT = '#cfe6f2';
const TXT2 = '#9fbccd';
const RULE = 'rgba(82, 233, 255, 0.24)';

export default function OpengraphImage() {
  const chips = [
    `${TOTAL_DESTINATIONS} worlds`,
    `${MOUNTS} mounts`,
    `${WEAPONS} weapons`,
    '0 GB install',
  ];

  return new ImageResponse(
    (
      <div
        style={{
          width: '100%',
          height: '100%',
          display: 'flex',
          flexDirection: 'column',
          justifyContent: 'space-between',
          padding: '72px 80px',
          backgroundColor: INK,
          /* The page's own two aura washes, in the same corners. */
          backgroundImage:
            'radial-gradient(circle at 8% 16%, rgba(35,105,135,0.55), transparent 42%),'
            + 'radial-gradient(circle at 92% 84%, rgba(255,180,74,0.28), transparent 38%)',
        }}
      >
        <div style={{ display: 'flex', flexDirection: 'column' }}>
          <div
            style={{
              display: 'flex',
              fontSize: 24,
              letterSpacing: 14,
              color: CY,
              textTransform: 'uppercase',
            }}
          >
            Browser-native
          </div>
          <div
            style={{
              display: 'flex',
              marginTop: 28,
              fontSize: 132,
              fontWeight: 700,
              letterSpacing: 10,
              lineHeight: 1,
              color: TXT,
            }}
          >
            AETHER
          </div>
          <div
            style={{
              display: 'flex',
              fontSize: 132,
              fontWeight: 700,
              letterSpacing: 10,
              lineHeight: 1.05,
              color: CY,
            }}
          >
            NEXUS
          </div>
        </div>

        <div style={{ display: 'flex', flexDirection: 'column' }}>
          <div style={{ display: 'flex', width: '100%', height: 1, backgroundColor: RULE }} />
          <div
            style={{
              display: 'flex',
              marginTop: 26,
              fontSize: 30,
              lineHeight: 1.4,
              color: TXT2,
              maxWidth: 900,
            }}
          >
            {`${numberWord(WORLDS.length)} worlds through the gateways, open space, and `
              + `${numberWord(LANDABLE_PLANETS)} landable planets — all generated in code, `
              + 'in a browser tab.'}
          </div>
          <div style={{ display: 'flex', gap: 16, marginTop: 34 }}>
            {chips.map((c, i) => (
              <div
                key={c}
                style={{
                  display: 'flex',
                  padding: '10px 22px',
                  border: `1px solid ${i === 0 ? AMBER : RULE}`,
                  color: i === 0 ? AMBER : TXT,
                  fontSize: 26,
                  letterSpacing: 2,
                }}
              >
                {c}
              </div>
            ))}
          </div>
        </div>
      </div>
    ),
    size
  );
}
