# Aether Nexus — site

The front cover, paywall and credit store. A separate Vercel project from the
game, deployed from the `site/` directory of this repository.

---

## What it does

| Route | |
|---|---|
| `/` | Front cover — hero, the five worlds, features, and the two calls to action |
| `/store` | Credit picker with a live receipt |
| `/checkout` | Order confirmation and the pay button |
| `/play` | The game, gated on a paid pass |
| `/api/checkout` | Quotes the order and starts a checkout (real or simulated) |
| `/api/confirm` | Grants the entitlement after payment |

---

## Pricing

Set in [`lib/pricing.ts`](lib/pricing.ts). Everything is integer cents; there is
not one float in the money path.

- **Game access** — $1.00, one-off.
- **Credits** — $0.10 each, minimum 10, maximum 10,000.
- **Processing fee** — added on top, so the listed prices are what reaches you.

### The fee is grossed up, not just added

Listed prices are before processing. Simply *adding* the fee does not achieve
that, because the processor charges its percentage on the larger amount as well:
bill $1.34 for a $1.00 item and you net $1.00 only by coincidence.

The amount billed solves

```
total − (rate × total + fixed) = net
total = (net + fixed) ÷ (1 − rate)
```

rounded **up** to the cent, so rounding is never at your expense.

| Order | List | Charged | Fee | You net |
|---|---|---|---|---|
| Game access | $1.00 | **$1.34** | $0.34 | $1.00 |
| 10 credits (min) | $1.00 | **$1.34** | $0.34 | $1.00 |
| 100 credits | $10.00 | **$10.61** | $0.61 | $10.00 |
| 1,000 credits | $100.00 | **$103.30** | $3.30 | $100.00 |
| 10,000 credits (max) | $1,000.00 | **$1,030.18** | $30.18 | $1,000.00 |

Verified across all 9,991 purchasable quantities:

```bash
npm run test:pricing
```

The rate defaults to Stripe's standard 2.9% + 30¢ and is configurable with
`STRIPE_FEE_BPS` and `STRIPE_FEE_FIXED_CENTS` — your account's real rate depends
on the card and the country, and a hardcoded number would quietly drift.

Buying access and credits together is charged as one order, so the fixed 30¢ is
paid once rather than twice.

---

## Payments

**No Stripe keys → checkout is simulated.** The customer walks the same screens
and sees the same totals, but no card is taken and nothing reaches Stripe. The
quote is computed by the same functions either way, so the number on the
simulated receipt is the number Stripe will be handed on the day you set a key.

**Setting `STRIPE_SECRET_KEY` switches to live payments *and* disables the
simulated bypass in the same action.** That matters: in simulated mode
`/api/confirm?simulated=1&credits=10000` grants credits on the strength of a
query string, which is fine while there is no money involved and must not
survive the arrival of keys. It is refused outright once a key is present rather
than merely deprioritised.

Verified:

| With a key set | Result |
|---|---|
| `/api/confirm?simulated=1&credits=10000` | 303 → `/?error=simulated-disabled`, nothing granted |
| `/api/confirm?session_id=<made up>` | 303 → `/?error=verify-failed`, nothing granted |
| Home page | Test-mode banner gone |

### Before taking real money

Two things are deliberately not done yet, and both are real:

1. **Add a webhook.** Entitlement is currently granted on the success redirect.
   A customer who closes the tab during that redirect has paid and not been
   granted. Only `checkout.session.completed` on a webhook catches that.
   `STRIPE_WEBHOOK_SECRET` is already in `.env.example` for it.
2. **Move entitlement off the cookie.** See below.

---

## Entitlement

A cookie signed with HMAC-SHA256 over `APP_SECRET`. The payload is readable but
not editable — rewriting the credit count in devtools invalidates the signature
and the pass is rejected (tested).

It is **not** a user account. There is no database here and no login, so a pass
is bound to a browser: clearing cookies loses it, and a second device does not
have it. That is the honest limit of a cookie-based entitlement, and the right
trade for a one-dollar unlock — but it is a limit. Real money and real support
tickets want a row in a table keyed on an account.

`APP_SECRET` **must** be set in production. Without it the signing key is a
public constant and anyone can mint a paid pass. Generate one with:

```bash
node -e "console.log(require('node:crypto').randomBytes(32).toString('base64url'))"
```

---

## Serving the game

`/play` renders the game in an iframe with `allow="pointer-lock"` — the game
takes pointer lock to look around and an iframe cannot without being permitted.

Bundle the game into this deployment:

```bash
npm run bundle-game
```

That builds the Vite project in the repository root with `--base=/game/` and
copies `dist/` into `public/game/`. It is gitignored; a checked-in copy goes
stale the moment the game changes.

Alternatively set `NEXT_PUBLIC_GAME_URL` to wherever it is hosted.

**This is a soft gate.** `/game/index.html` is a public path on this origin, so
someone who guesses it gets in without paying. Closing that properly means
serving the bundle through an authenticated route handler instead of from
`public/`. Worth doing before the price is more than a dollar.

---

## Local development

```bash
cd site
npm install
cp .env.example .env.local     # optional; it runs fine with no env at all
npm run dev
```

Then walk the flow at <http://localhost:3000> — with no keys set it completes
end to end without touching Stripe.

---

## Deploying

The Vercel CLI is not installed in this workspace, so this has not been
deployed. To do it:

1. **New Vercel project**, pointed at this repository.
2. **Root Directory: `site`** — this is the important one. Without it Vercel
   builds the game at the repository root instead of the site.
3. Framework preset: Next.js (detected).
4. Environment variables — at minimum `APP_SECRET`. Add `STRIPE_SECRET_KEY`
   when you are ready to take real payments; until then checkout stays
   simulated and the site is fully walkable.
5. If you want the game served from this deployment, run `npm run bundle-game`
   before pushing, or add it to the build command:
   `npm run bundle-game && next build`.

Or with the CLI, once installed (`npm i -g vercel`):

```bash
cd site
vercel link
vercel env add APP_SECRET production
vercel deploy --prod
```

---

## Notes

- **No image files.** Every graphic — the hero horizon, the five world plates —
  is drawn in code on a canvas, because the product's whole claim is that it
  generates its own art. A storefront illustrated with exported screenshots
  would be arguing against the thing it is selling.
- **Fonts are self-hosted** via `next/font/google`, so there is no runtime
  request to a font CDN and no flash of a fallback face.
- `npm audit` reports advisories in `postcss` and `sharp`. Both are transitive
  dependencies of Next.js itself and are not fixable from here without
  downgrading Next; they resolve when Next updates them.
