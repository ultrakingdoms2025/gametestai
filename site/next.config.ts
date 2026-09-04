import type { NextConfig } from 'next';

/**
 * The public origin's security headers.
 *
 * ── Why this file needed them at all ──────────────────────────────────────
 *
 * `admin/proxy.ts` sets the full set on every admin response — CSP, HSTS,
 * X-Frame-Options, X-Content-Type-Options, Referrer-Policy, Permissions-Policy
 * — and the public site, which is the origin that actually faces the internet
 * and holds the sessions, sent none of them. The admin app is the one behind a
 * login and the one that was hardened.
 *
 * They are set here rather than in `site/proxy.ts` deliberately. That file is
 * `auth()`-wrapped and its matcher excludes `/api`, `_next/static` and the game
 * asset prefixes — precisely the responses that most want a CSP and a nosniff —
 * and Next 16 renamed it from `middleware.ts` partly because a proxy is one
 * request header away from not running (CVE-2025-29927). `headers()` is applied
 * by the framework to every matching response and cannot be skipped that way.
 *
 * ── Framing: SAMEORIGIN, not DENY, and that is not a compromise ───────────
 *
 * `admin/proxy.ts` sends `X-Frame-Options: DENY` and `frame-ancestors 'none'`.
 * Copying that here would break the product: `components/PlayShell.tsx` renders
 * the game in an `<iframe src="/play/launch">`, which redirects to
 * `/game/index.html` on this same origin, so the site frames itself on the one
 * page people pay for.
 *
 * A path-scoped exception was the obvious shape and is the wrong one. Two
 * `Content-Security-Policy` headers on one response are INTERSECTED by the
 * browser, not overridden, so a global `frame-ancestors 'none'` plus a
 * `/game/*` block saying `'self'` yields `'none'` — a black iframe, and a
 * black iframe that no local build reproduces if the two rules ever stop
 * matching the same way. One header, one policy, no ordering question.
 *
 * What is given up is same-origin clickjacking protection on this origin.
 * Cross-origin framing — every clickjacking attack that involves an attacker's
 * page — is still refused.
 *
 * ── Every allowance below is here because something loads ─────────────────
 *
 *   `script-src 'unsafe-inline'`  Next.js inlines its hydration payload and
 *                                 bootstrap in `<script>` tags with no nonce.
 *                                 `admin/proxy.ts` allows the same for the same
 *                                 reason. A nonce needs the framework's own
 *                                 support and is the right follow-up.
 *   `'wasm-unsafe-eval'`          Rapier (`@dimforge/rapier3d-compat`) and the
 *                                 KTX2/Basis transcoder both instantiate
 *                                 WebAssembly. Without it the physics engine
 *                                 does not start.
 *   `script-src blob:` +          `KTX2Loader` fetches the transcoder, wraps it
 *   `worker-src 'self' blob:`     in a Blob and does `new Worker(objectURL)`;
 *                                 `src/workers/GenPool.js` starts a module
 *                                 worker from `new URL('./GenWorker.js', …)`.
 *                                 `worker-src` is the correct directive; `blob:`
 *                                 is repeated in `script-src` because older
 *                                 Safari checks that one for workers.
 *   `style-src` + `font-src`      `public/game/index.html` links a stylesheet
 *   with the Google font hosts    from fonts.googleapis.com, which pulls faces
 *                                 from fonts.gstatic.com. (The SITE self-hosts
 *                                 its two faces through `next/font`, so this is
 *                                 the bundled game's requirement only — but the
 *                                 game is served from this origin, so it is
 *                                 this origin's policy.)
 *   `img-src data: blob: https:`  The game's inline SVG favicon is a `data:`
 *                                 URI, and canvas-generated textures are read
 *                                 back as blobs.
 *
 *                                 `https:` is for MARKETPLACE ITEM ART, which
 *                                 is the one thing this origin serves that is
 *                                 NOT same-origin. `item.image` is stored by
 *                                 the admin API as a free-form string
 *                                 (`String(body.image ?? '')`) and rendered
 *                                 straight into an `<img src>` by
 *                                 `MarketplaceUI._renderMktArt`, so the host
 *                                 is whatever an operator typed and cannot be
 *                                 allow-listed ahead of time. Reported as
 *                                 "when opening a merchant items for sale the
 *                                 images do not load": every one of them was
 *                                 refused, and the panel fell back to its
 *                                 category emoji, which is exactly what that
 *                                 fallback looks like when it fires for the
 *                                 whole catalogue.
 *
 *                                 The "everything the game fetches is
 *                                 same-origin" premise below was true when
 *                                 this policy was written; the marketplace
 *                                 arrived after it and nothing re-read this
 *                                 list. Scheme-limited on purpose: `https:`
 *                                 alone still refuses `http:`, so no item URL
 *                                 can downgrade the page to mixed content.
 *
 *                                 What it costs: anyone who can write an
 *                                 item's `image` field can make a viewer's
 *                                 browser fetch an arbitrary HTTPS host, which
 *                                 is a weak exfiltration channel (the URL, and
 *                                 the fact that it loaded). Images execute
 *                                 nothing, so that is the whole of it. The
 *                                 tighter alternative - proxying art through
 *                                 this origin and keeping `'self'` - trades
 *                                 that for an SSRF surface to get right, and
 *                                 is the correct move if item art ever becomes
 *                                 player-supplied rather than operator-
 *                                 supplied.
 *   `connect-src`                 Everything the game fetches is same-origin:
 *                                 its own assets, `/api/*`, telemetry. `blob:`
 *                                 and `data:` cover loaders reading back what
 *                                 they just created.
 *   `object-src 'none'`,          Nothing embeds plugins or rewrites the base
 *   `base-uri 'self'`,            URL, and `form-action` keeps a submission on
 *   `form-action 'self'`          this origin.
 *
 * Deliberately NOT restricted in `Permissions-Policy`: fullscreen, gamepad,
 * autoplay and clipboard-write. The `<iframe allow="…">` in `PlayShell` can
 * only ever grant a subset of what the top-level document holds, so listing any
 * of them would disable it in the game. Only the three the admin app blocks —
 * camera, microphone, geolocation — are named, and naming a feature is the only
 * way this header restricts one.
 */

/* `next dev` serves modules through an HMR pipeline that evaluates code and
 * talks over a websocket, so a production-shaped policy makes local
 * development a wall of console errors — and a developer who turns the header
 * off to get work done is how it ends up shipped off. Relaxed in development
 * only, and the two extra tokens are exactly the two dev needs. */
const isDev = process.env.NODE_ENV !== 'production';

const csp = [
  "default-src 'self'",
  "base-uri 'self'",
  "object-src 'none'",
  `script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval' blob:${isDev ? " 'unsafe-eval'" : ''}`,
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "font-src 'self' data: https://fonts.gstatic.com",
  "img-src 'self' data: blob: https:",
  "media-src 'self' data: blob:",
  `connect-src 'self' blob: data:${isDev ? ' ws: wss:' : ''}`,
  "worker-src 'self' blob:",
  "frame-src 'self'",
  // 'self', not 'none' — see the docblock. The site frames its own game.
  "frame-ancestors 'self'",
  "form-action 'self'",
].join('; ');

const securityHeaders = [
  { key: 'Content-Security-Policy', value: csp },
  // SAMEORIGIN, not DENY, for the same reason frame-ancestors is 'self'.
  { key: 'X-Frame-Options', value: 'SAMEORIGIN' },
  { key: 'X-Content-Type-Options', value: 'nosniff' },
  { key: 'Referrer-Policy', value: 'same-origin' },
  { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=()' },
  {
    key: 'Strict-Transport-Security',
    value: 'max-age=63072000; includeSubDomains; preload',
  },
];

const nextConfig: NextConfig = {
  reactStrictMode: true,

  /* The game is copied into `public/game` by `npm run bundle-game`, and is
   * served from this origin on purpose: the access gate is only meaningful if
   * the thing being gated is not also sitting on a public URL of its own.
   *
   * It ships its own hashed filenames, so it can be cached hard. `index.html`
   * must not be, or a returning player is pinned to whatever build they first
   * loaded. */
  async headers() {
    return [
      {
        /* One entry, every path, one CSP. The cache rules below name disjoint
         * header keys, so nothing here collides with them. */
        source: '/:path*',
        headers: securityHeaders,
      },
      {
        source: '/game/assets/:path*',
        headers: [
          { key: 'Cache-Control', value: 'public, max-age=31536000, immutable' },
        ],
      },
      {
        source: '/game/index.html',
        headers: [{ key: 'Cache-Control', value: 'no-cache' }],
      },
    ];
  },
};

export default nextConfig;
