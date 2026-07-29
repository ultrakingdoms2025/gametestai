/**
 * Money.
 *
 * ## Everything is integer cents
 *
 * There is not a single float in this file. `0.1 + 0.2` is famously not `0.3`,
 * and a rounding error in a price is a rounding error in someone's bank
 * account. Amounts cross the wire to Stripe as integer cents anyway, so cents
 * is also the format that needs no conversion at the boundary.
 *
 * ## Passing on the processing fee
 *
 * The brief is that listed prices are before processing fees, and the fee is
 * added to what the customer pays. Adding the fee to the price does *not*
 * achieve that, because the processor then charges its percentage on the larger
 * amount too - bill $1.34 for a $1.00 item and you net $1.00 only by accident.
 *
 * The amount to bill is the solution to
 *
 *     total - (rate x total + fixed) = net
 *
 * which rearranges to
 *
 *     total = (net + fixed) / (1 - rate)
 *
 * and that is what `grossUp` computes. Rounded *up* to the cent, so the shortfall
 * from rounding is never the merchant's.
 */

/** Price of one credit, in cents. */
export const CREDIT_PRICE_CENTS = 10;
/** Smallest credit purchase. Below this the fixed fee dwarfs the order. */
export const MIN_CREDITS = 10;
/** Largest credit purchase. */
export const MAX_CREDITS = 10000;
/** One-off charge for access to the game. */
export const ENTRY_CENTS = 100;

/**
 * Processing fee, as basis points of the total plus a fixed amount.
 *
 * Defaults are Stripe's standard domestic card rate (2.9% + 30c). Both are
 * overridable, because the real rate depends on the account, the card, and the
 * country the customer is in - and hardcoding a number that will drift is how a
 * merchant quietly starts losing a few cents on every sale.
 */
export const FEE_BPS = numFromEnv(process.env.STRIPE_FEE_BPS, 290);
export const FEE_FIXED_CENTS = numFromEnv(process.env.STRIPE_FEE_FIXED_CENTS, 30);

function numFromEnv(raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? Math.round(n) : fallback;
}

export type Line = {
  label: string;
  detail?: string;
  cents: number;
};

export type Quote = {
  /** What the goods are worth — what the merchant intends to receive. */
  netCents: number;
  /** The processing fee added on top. */
  feeCents: number;
  /** What the customer is charged. */
  totalCents: number;
  lines: Line[];
};

/**
 * The amount to bill so that `netCents` survives the processing fee.
 *
 * @param netCents what the merchant should be left with
 * @returns the total to charge, in cents, rounded up
 */
export function grossUp(netCents: number): number {
  if (!Number.isFinite(netCents) || netCents <= 0) return 0;
  const denominator = 10_000 - FEE_BPS;
  // A fee rate at or above 100% has no solution: there is no amount you can
  // charge that survives it. Guard rather than divide by zero or go negative.
  if (denominator <= 0) return Math.ceil(netCents);
  return Math.ceil(((netCents + FEE_FIXED_CENTS) * 10_000) / denominator);
}

/** Clamp a requested credit quantity to what is actually purchasable. */
export function clampCredits(raw: unknown): number {
  const n = Math.floor(Number(raw));
  if (!Number.isFinite(n)) return MIN_CREDITS;
  return Math.min(MAX_CREDITS, Math.max(MIN_CREDITS, n));
}

/** Quote a credit purchase. */
export function quoteCredits(credits: number): Quote {
  const qty = clampCredits(credits);
  const netCents = qty * CREDIT_PRICE_CENTS;
  const totalCents = grossUp(netCents);
  return {
    netCents,
    feeCents: totalCents - netCents,
    totalCents,
    lines: [
      {
        label: `${qty.toLocaleString('en-US')} credits`,
        detail: `${formatCents(CREDIT_PRICE_CENTS)} each`,
        cents: netCents,
      },
    ],
  };
}

/** Quote the one-off entry charge. */
export function quoteEntry(): Quote {
  const netCents = ENTRY_CENTS;
  const totalCents = grossUp(netCents);
  return {
    netCents,
    feeCents: totalCents - netCents,
    totalCents,
    lines: [{ label: 'Game access', detail: 'One-off, permanent', cents: netCents }],
  };
}

/** Quote entry and credits together, so a first-time buyer pays one fee. */
export function quoteEntryWithCredits(credits: number): Quote {
  const qty = clampCredits(credits);
  const creditNet = qty * CREDIT_PRICE_CENTS;
  const netCents = ENTRY_CENTS + creditNet;
  const totalCents = grossUp(netCents);
  return {
    netCents,
    feeCents: totalCents - netCents,
    totalCents,
    lines: [
      { label: 'Game access', detail: 'One-off, permanent', cents: ENTRY_CENTS },
      {
        label: `${qty.toLocaleString('en-US')} credits`,
        detail: `${formatCents(CREDIT_PRICE_CENTS)} each`,
        cents: creditNet,
      },
    ],
  };
}

/** `1234` -> `$12.34`. */
export function formatCents(cents: number): string {
  const sign = cents < 0 ? '-' : '';
  const abs = Math.abs(Math.round(cents));
  return `${sign}$${(abs / 100).toFixed(2)}`;
}

/** Human description of the fee line, for the receipt. */
export function feeLabel(): string {
  return `Processing (${(FEE_BPS / 100).toFixed(1)}% + ${formatCents(FEE_FIXED_CENTS)})`;
}
